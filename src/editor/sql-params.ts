// src/editor/sql-params.ts
// Pure TypeScript SQL parameter extractor, coercer, and safe literal binder
// Zero-DOM, zero-dependency, dialect-aware lexer scan

import type { DatabaseDriverType } from '../protocol.js'
import { formatSqlValue } from '../drivers/common/update-builder.js'
import {
  isIdentContChar,
  isIdentStartChar,
  isPostgresEscapeStringStart,
  matchDollarQuoteTag,
  scanBlockCommentEnd,
  scanLineCommentEnd,
  scanQuotedSegmentEnd,
  supportsDollarQuoting,
  supportsNestedBlockComments,
  usesBackslashAndHash,
} from '../drivers/common/sql-lexer.js'

export type SqlParamStyle = 'named-colon' | 'named-at' | 'positional-dollar'

export interface DetectedSqlParam {
  key: string
  raw: string
  style: SqlParamStyle
  occurrences: number
}

export type BindParamValueType = 'auto' | 'text' | 'number' | 'boolean' | 'null'

export interface BindParamInput {
  value: string
  type: BindParamValueType
}

interface ScannedSqlToken {
  start: number
  end: number
  key: string
  raw: string
  style: SqlParamStyle
}

/**
 * Performs a lexer-aware scan of the SQL string, skipping comments, string literals,
 * quoted identifiers, bracket identifiers, dollar-quoted blocks, type casts, and system variables.
 * Returns non-overlapping placeholder token spans in ascending start-index order.
 */
function scanSqlParameterTokens(
  sql: string,
  dialect: DatabaseDriverType
): ScannedSqlToken[] {
  if (!sql || typeof sql !== 'string' || dialect === 'redis') {
    return []
  }

  const tokens: ScannedSqlToken[] = []
  const assignedMysqlUserVars = new Set<string>()
  const len = sql.length
  const backslashAndHash = usesBackslashAndHash(dialect)
  const dollarQuotes = supportsDollarQuoting(dialect)
  const nestedComments = supportsNestedBlockComments(dialect)
  let i = 0

  while (i < len) {
    const ch = sql[i]

    // 1. Line comments: -- ...
    if (ch === '-' && i + 1 < len && sql[i + 1] === '-') {
      i = scanLineCommentEnd(sql, i)
      continue
    }

    // 2. MySQL / MariaDB / ClickHouse line comments: # ...
    if (ch === '#' && backslashAndHash) {
      let j = i + 1
      while (j < len && sql[j] !== '\n') {
        j++
      }
      i = j < len ? j + 1 : len
      continue
    }

    // 3. Block comments: /* ... */ (nested only for PG / CockroachDB)
    if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
      i = scanBlockCommentEnd(sql, i, nestedComments)
      continue
    }

    // 4. PostgreSQL escape string literal: E'...' or e'...'
    if (isPostgresEscapeStringStart(sql, i, dialect)) {
      i = scanQuotedSegmentEnd(sql, i + 1, "'", true).end
      continue
    }

    // 5. Quoted literals & identifiers: '...', "...", `...`
    if (ch === "'" || ch === '"' || ch === '`') {
      const allowBackslash = ch === "'" && backslashAndHash
      i = scanQuotedSegmentEnd(sql, i, ch, allowBackslash).end
      continue
    }

    // 6. Bracket identifiers: [...] (SQLite / LibSQL only)
    if (ch === '[' && (dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1')) {
      let j = i + 1
      while (j < len) {
        if (sql[j] === ']') {
          if (j + 1 < len && sql[j + 1] === ']') {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      i = j
      continue
    }

    // 7. PostgreSQL / CockroachDB dollar-quoted blocks: $$...$$ and $tag$...$tag$
    // CRITICAL: Never mistake $tag$ for positional $1!
    if (dollarQuotes && ch === '$') {
      const tag = matchDollarQuoteTag(sql, i)
      if (tag !== null) {
        const closeIdx = sql.indexOf(tag, i + tag.length)
        i = closeIdx >= 0 ? closeIdx + tag.length : len
        continue
      }
    }

    // 8. PostgreSQL type casts: ::type
    // CRITICAL: Never mistake ::text or foo::int for :text!
    if (ch === ':' && i + 1 < len && sql[i + 1] === ':') {
      while (i < len && sql[i] === ':') {
        i++
      }
      continue
    }

    // 9. MySQL system variables: @@version or @@global.var
    // CRITICAL: Never mistake @@var for @var!
    if (ch === '@' && i + 1 < len && sql[i + 1] === '@') {
      while (i < len && sql[i] === '@') {
        i++
      }
      while (i < len && (isIdentContChar(sql.charCodeAt(i)) || sql[i] === '.')) {
        i++
      }
      continue
    }

    // 10. Named colon parameter: :name ([A-Za-z_][A-Za-z0-9_]*)
    if (ch === ':') {
      const prevIsIdent = i > 0 && isIdentContChar(sql.charCodeAt(i - 1))
      if (!prevIsIdent && i + 1 < len && isIdentStartChar(sql.charCodeAt(i + 1))) {
        let j = i + 2
        while (j < len && isIdentContChar(sql.charCodeAt(j))) {
          j++
        }
        const raw = sql.slice(i, j)
        tokens.push({
          start: i,
          end: j,
          key: raw,
          raw,
          style: 'named-colon',
        })
        i = j
        continue
      }
    }

    // 11. Named at parameter: @name ([A-Za-z_][A-Za-z0-9_]*)
    if (ch === '@') {
      const prevIsIdent = i > 0 && isIdentContChar(sql.charCodeAt(i - 1))
      if (!prevIsIdent && i + 1 < len && isIdentStartChar(sql.charCodeAt(i + 1))) {
        let j = i + 2
        while (j < len && isIdentContChar(sql.charCodeAt(j))) {
          j++
        }
        // MySQL / MariaDB user variable assignment target or previously assigned @var
        if (dialect === 'mysql' || dialect === 'mariadb') {
          let k = j
          while (k < len && /\s/.test(sql[k])) {
            k++
          }
          const rawVar = sql.slice(i, j)
          if (k + 1 < len && sql[k] === ':' && sql[k + 1] === '=') {
            assignedMysqlUserVars.add(rawVar.toLowerCase())
            i = k
            continue
          }
          if (assignedMysqlUserVars.has(rawVar.toLowerCase())) {
            i = j
            continue
          }
        }
        const raw = sql.slice(i, j)
        tokens.push({
          start: i,
          end: j,
          key: raw,
          raw,
          style: 'named-at',
        })
        i = j
        continue
      }
    }

    // 12. Positional dollar parameter: $1..$999 (positive integer)
    if (ch === '$') {
      const prevIsIdent = i > 0 && isIdentContChar(sql.charCodeAt(i - 1))
      if (
        !prevIsIdent &&
        i + 1 < len &&
        sql.charCodeAt(i + 1) >= 49 &&
        sql.charCodeAt(i + 1) <= 57
      ) {
        let j = i + 2
        while (j < len && sql.charCodeAt(j) >= 48 && sql.charCodeAt(j) <= 57) {
          j++
        }
        // Ensure not immediately followed by an identifier character (e.g. $1a is not a parameter)
        if (j >= len || !isIdentContChar(sql.charCodeAt(j))) {
          const num = Number(sql.slice(i + 1, j))
          if (num >= 1 && num <= 999) {
            const raw = sql.slice(i, j)
            tokens.push({
              start: i,
              end: j,
              key: raw,
              raw,
              style: 'positional-dollar',
            })
            i = j
            continue
          }
        }
      }
    }

    i++
  }

  return tokens
}

/**
 * Extracts bind parameters from a SQL script according to dialect rules.
 * Preserves first-seen order, deduplicates by key (`:user_id`, `@email`, `$1`), and counts occurrences.
 * Returns [] for redis dialect.
 */
export function extractSqlParameters(
  sql: string,
  dialect: DatabaseDriverType
): DetectedSqlParam[] {
  if (!sql || typeof sql !== 'string' || dialect === 'redis') {
    return []
  }

  const tokens = scanSqlParameterTokens(sql, dialect)
  const paramMap = new Map<string, DetectedSqlParam>()

  for (const token of tokens) {
    const existing = paramMap.get(token.key)
    if (existing) {
      existing.occurrences++
    } else {
      paramMap.set(token.key, {
        key: token.key,
        raw: token.raw,
        style: token.style,
        occurrences: 1,
      })
    }
  }

  return Array.from(paramMap.values())
}

/**
 * Coerces user parameter input into a typed JavaScript value.
 * - 'null' -> null
 * - 'text' -> input.value
 * - 'number' -> finite Number(trimmed) (throws descriptive error if non-numeric; preserves unsafe bigints as numeric string)
 * - 'boolean' -> true / false
 * - 'auto' -> '' stays '', 'NULL' (case-insensitive) -> null, 'true'/'false' -> boolean,
 *             strict finite numeric string -> number (preserving unsafe integer strings), otherwise string.
 */
export function coerceBindParamValue(input: BindParamInput): unknown {
  const { type, value } = input

  switch (type) {
    case 'null':
      return null

    case 'text':
      return value

    case 'number': {
      const trimmed = value.trim()
      if (trimmed === '') {
        throw new Error('Invalid numeric parameter value: empty string')
      }
      if (/^[+-]?\d+$/.test(trimmed)) {
        const num = Number(trimmed)
        if (!Number.isSafeInteger(num)) {
          return BigInt(trimmed.replace(/^\+/, ''))
        }
        return num
      }
      const num = Number(trimmed)
      if (!Number.isFinite(num)) {
        throw new Error(
          `Invalid numeric parameter value: "${value}" is not a finite number`
        )
      }
      return num
    }

    case 'boolean': {
      const trimmedLower = value.trim().toLowerCase()
      if (
        trimmedLower === 'true' ||
        trimmedLower === 't' ||
        trimmedLower === '1' ||
        trimmedLower === 'yes' ||
        trimmedLower === 'y'
      ) {
        return true
      }
      if (
        trimmedLower === 'false' ||
        trimmedLower === 'f' ||
        trimmedLower === '0' ||
        trimmedLower === 'no' ||
        trimmedLower === 'n'
      ) {
        return false
      }
      throw new Error(
        `Invalid boolean parameter value: "${value}" is not true/false, 1/0, yes/no, or y/n`
      )
    }

    case 'auto': {
      if (value === '') {
        return ''
      }
      const trimmed = value.trim()
      const lower = trimmed.toLowerCase()
      if (lower === 'null') {
        return null
      }
      if (lower === 'true') {
        return true
      }
      if (lower === 'false') {
        return false
      }
      // Preserve leading-zero codes (e.g. '00123', ZIP/SKU/phone strings) as text
      if (/^[+-]?0\d+$/.test(trimmed)) {
        return value
      }
      if (/^[+-]?\d+$/.test(trimmed)) {
        const num = Number(trimmed)
        if (Number.isSafeInteger(num)) {
          return num
        }
        return BigInt(trimmed.replace(/^\+/, ''))
      }
      if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
        const sigDigits = trimmed.replace(/^[+-]?0+(?=\d)/, '').replace('.', '').replace(/[^0-9]/g, '').length
        if (sigDigits > 15) {
          return trimmed
        }
        const num = Number(trimmed)
        if (Number.isFinite(num)) {
          return num
        }
      }
      return value
    }
  }
}

function getOwnParamValue(
  values: Record<string, BindParamInput>,
  key: string
): BindParamInput | undefined {
  return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined
}

/**
 * Replaces real parameter placeholders with safely formatted SQL literals using `formatSqlValue`.
 * Preserves all comments, string literals, dollar quotes, and casts.
 * Returns sql unchanged for redis dialect.
 */
export function bindSqlParameters(
  sql: string,
  values: Record<string, BindParamInput>,
  dialect: DatabaseDriverType
): string {
  if (!sql || typeof sql !== 'string' || dialect === 'redis') {
    return sql ?? ''
  }

  const tokens = scanSqlParameterTokens(sql, dialect)
  if (tokens.length === 0) {
    return sql
  }

  let result = ''
  let lastIndex = 0

  for (const token of tokens) {
    result += sql.slice(lastIndex, token.start)

    // Lookup by prefixed key (':id', '@user', '$1') or bare name ('id', 'user', '1')
    const input =
      getOwnParamValue(values, token.key) ?? getOwnParamValue(values, token.key.slice(1))
    if (input !== undefined) {
      if (typeof input.value === 'string' && input.value.includes('\0')) {
        throw new Error('Parameter value cannot contain NUL (\\0) bytes')
      }
      const coerced = coerceBindParamValue(input)
      result += formatSqlValue(coerced, dialect)
    } else {
      result += sql.slice(token.start, token.end)
    }

    lastIndex = token.end
  }

  result += sql.slice(lastIndex)
  return result
}
