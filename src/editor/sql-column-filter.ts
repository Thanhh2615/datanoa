// src/editor/sql-column-filter.ts
// Pure, lexer-aware SQL column filter injector for arbitrary SELECT queries.
// Skips string literals, quoted identifiers, comments, dollar-quotes, and nested parentheses.

import type { DatabaseDriverType } from '../protocol.js'
import {
  formatSqlLiteral,
  isPostgresEscapeStringStart,
  matchDollarQuoteTag,
  quoteIdentForDialect,
  scanBlockCommentEnd,
  scanLineCommentEnd,
  scanQuotedSegmentEnd,
  splitSqlStatements,
  supportsDollarQuoting,
  supportsNestedBlockComments,
  usesBackslashAndHash,
} from '../drivers/common/sql-tools.js'

export type ColumnHeaderFilterOp = 'contains' | 'eq' | 'neq' | 'is-null' | 'is-not-null'

export type SqlColumnFilterResult =
  | { ok: true; sql: string; predicate: string }
  | { ok: false; reason: string }

interface TopLevelWord {
  upper: string
  start: number
  end: number
}

const TRAILING_SINGLE_KEYWORDS = new Set([
  'HAVING',
  'WINDOW',
  'QUALIFY',
  'LIMIT',
  'OFFSET',
  'FETCH',
  'SETTINGS',
  'FORMAT',
])
const SET_OP_KEYWORDS = new Set(['UNION', 'INTERSECT', 'EXCEPT'])

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch)
}

function escapeSqlLikePattern(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * Builds a dialect-safe SQL predicate for a quick column header filter.
 */
export function buildColumnHeaderPredicate(
  column: string,
  value: string,
  op: ColumnHeaderFilterOp,
  dialect: DatabaseDriverType
): string {
  const colIdent = quoteIdentForDialect(column, dialect)
  if (op === 'is-null') return `${colIdent} IS NULL`
  if (op === 'is-not-null') return `${colIdent} IS NOT NULL`

  if (op === 'contains') {
    const escaped = `%${escapeSqlLikePattern(value)}%`
    const literal = formatSqlLiteral(escaped, dialect)
    if (dialect === 'postgres' || dialect === 'cockroachdb') {
      return `CAST(${colIdent} AS TEXT) ILIKE ${literal} ESCAPE '\\'`
    }
    if (dialect === 'clickhouse') {
      return `positionCaseInsensitive(toString(${colIdent}), ${formatSqlLiteral(value, dialect)}) > 0`
    }
    if (dialect === 'mysql' || dialect === 'mariadb') {
      // MySQL uses '\' as default escape char inside LIKE
      return `${colIdent} LIKE ${literal}`
    }
    // SQLite / LibSQL / D1
    return `${colIdent} LIKE ${literal} ESCAPE '\\'`
  }

  const literal = formatSqlLiteral(value, dialect)
  return op === 'neq' ? `${colIdent} <> ${literal}` : `${colIdent} = ${literal}`
}

function readDollarTag(sql: string, pos: number): string | null {
  if (sql[pos] !== '$') return null
  let i = pos + 1
  if (i < sql.length && sql[i] === '$') return '$$'
  if (i >= sql.length || !/[A-Za-z_]/.test(sql[i])) return null
  while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i++
  if (i < sql.length && sql[i] === '$') {
    return sql.slice(pos, i + 1)
  }
  return null
}

function scanTopLevelWords(
  sql: string,
  dialect: DatabaseDriverType
): { words: TopLevelWord[]; trailingSemicolonPos: number } {
  const words: TopLevelWord[] = []
  const supportsDollarQuotes = supportsDollarQuoting(dialect)
  const backslashAndHash = usesBackslashAndHash(dialect)
  const nestedComments = supportsNestedBlockComments(dialect)
  const bracketIdents = dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1'
  let depth = 0
  let i = 0
  let trailingSemicolonPos = -1

  while (i < sql.length) {
    const ch = sql[i]
    const next = i + 1 < sql.length ? sql[i + 1] : ''

    // Line comments: -- or # (MySQL / MariaDB / ClickHouse)
    if (ch === '-' && next === '-') {
      i = scanLineCommentEnd(sql, i)
      continue
    }
    if (backslashAndHash && ch === '#') {
      i = scanLineCommentEnd(sql, i - 1)
      continue
    }

    // Block comments: /* ... */ (nested only on PG / CockroachDB)
    if (ch === '/' && next === '*') {
      i = scanBlockCommentEnd(sql, i, nestedComments)
      continue
    }

    // PostgreSQL / CockroachDB E'...' escape string
    if (isPostgresEscapeStringStart(sql, i, dialect)) {
      i = scanQuotedSegmentEnd(sql, i + 1, "'", true).end
      continue
    }

    // Single-quoted string
    if (ch === "'") {
      i = scanQuotedSegmentEnd(sql, i, "'", backslashAndHash).end
      continue
    }

    // Double-quoted or backtick-quoted identifier
    if (ch === '"' || ch === '`') {
      i = scanQuotedSegmentEnd(sql, i, ch, false).end
      continue
    }

    // SQLite bracket identifier [...]
    if (bracketIdents && ch === '[') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === ']') {
          if (j + 1 < sql.length && sql[j + 1] === ']') {
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

    // PostgreSQL dollar-quoted string
    if (supportsDollarQuotes && ch === '$') {
      const tag = matchDollarQuoteTag(sql, i)
      if (tag) {
        const closeIdx = sql.indexOf(tag, i + tag.length)
        i = closeIdx >= 0 ? closeIdx + tag.length : sql.length
        continue
      }
    }

    if (ch === '(') {
      depth++
      i++
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      i++
      continue
    }

    if (depth === 0) {
      if (ch === ';') {
        trailingSemicolonPos = i
        i++
        continue
      }
      if (/[A-Za-z_]/.test(ch)) {
        const start = i
        i++
        while (i < sql.length && isIdentChar(sql[i])) i++
        words.push({ upper: sql.slice(start, i).toUpperCase(), start, end: i })
        continue
      }
    }

    i++
  }

  return { words, trailingSemicolonPos }
}

/**
 * Injects a column filter predicate into a single-statement SELECT query (or CTE + SELECT)
 * by either wrapping an existing top-level WHERE clause with AND or inserting a new WHERE
 * right before GROUP BY / HAVING / WINDOW / ORDER BY / LIMIT / OFFSET / FETCH / FOR.
 */
export function injectSqlColumnFilter(
  sql: string,
  column: string,
  value: string,
  op: ColumnHeaderFilterOp,
  dialect: DatabaseDriverType
): SqlColumnFilterResult {
  const trimmed = sql.trim()
  if (!trimmed) {
    return { ok: false, reason: 'empty_sql' }
  }
  if (dialect === 'redis') {
    return { ok: false, reason: 'non_sql_dialect' }
  }

  const statements = splitSqlStatements(trimmed, dialect)
  if (statements.length !== 1) {
    return { ok: false, reason: 'multi_statement' }
  }

  const { words, trailingSemicolonPos } = scanTopLevelWords(sql, dialect)
  if (words.length === 0) {
    return { ok: false, reason: 'no_tokens' }
  }

  const firstWord = words[0].upper
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    return { ok: false, reason: 'not_select' }
  }

  // Ensure a top-level SELECT and FROM exist, and reject set operations (UNION/INTERSECT/EXCEPT)
  let selectIdx = -1
  let fromIdx = -1
  let whereIdx = -1
  let trailingIdx = -1

  for (let idx = 0; idx < words.length; idx++) {
    const w = words[idx]
    if (SET_OP_KEYWORDS.has(w.upper)) {
      return { ok: false, reason: 'set_operation' }
    }
    if (selectIdx < 0 && w.upper === 'SELECT') {
      selectIdx = idx
      continue
    }
    if (selectIdx < 0) continue

    if (fromIdx < 0 && w.upper === 'FROM') {
      fromIdx = idx
      continue
    }
    if (fromIdx < 0) continue

    if (whereIdx < 0 && w.upper === 'WHERE') {
      whereIdx = idx
      continue
    }

    if (trailingIdx < 0) {
      const nextUpper = words[idx + 1]?.upper
      const isGroupBy = w.upper === 'GROUP' && nextUpper === 'BY'
      const isOrderBy = w.upper === 'ORDER' && nextUpper === 'BY'
      const isForLock =
        w.upper === 'FOR' &&
        (nextUpper === 'UPDATE' ||
          nextUpper === 'SHARE' ||
          nextUpper === 'NO' ||
          nextUpper === 'KEY')
      const isLockInShareMode =
        w.upper === 'LOCK' &&
        words[idx + 1]?.upper === 'IN' &&
        words[idx + 2]?.upper === 'SHARE' &&
        words[idx + 3]?.upper === 'MODE'
      if (
        isGroupBy ||
        isOrderBy ||
        isForLock ||
        isLockInShareMode ||
        TRAILING_SINGLE_KEYWORDS.has(w.upper)
      ) {
        trailingIdx = idx
      }
    }
  }

  if (selectIdx < 0 || fromIdx < 0) {
    return { ok: false, reason: 'missing_from' }
  }

  const predicate = buildColumnHeaderPredicate(column, value, op, dialect)
  const insertBoundary =
    trailingIdx >= 0
      ? words[trailingIdx].start
      : trailingSemicolonPos >= 0
        ? trailingSemicolonPos
        : sql.length

  if (whereIdx >= 0 && words[whereIdx].end <= insertBoundary) {
    const whereWord = words[whereIdx]
    const beforeWhere = sql.slice(0, whereWord.end)
    const existingCondition = sql.slice(whereWord.end, insertBoundary).trim()
    const afterClause = sql.slice(insertBoundary)
    const separator = afterClause.length > 0 && !/^[;\s]/.test(afterClause) ? ' ' : ''
    const hasTrailingLineComment = /(?:--|#)[^\r\n]*$/.test(existingCondition)
    const closeParen = hasTrailingLineComment ? '\n)' : ')'
    const nextSql = existingCondition
      ? `${beforeWhere} (${existingCondition}${closeParen} AND ${predicate}${separator}${afterClause}`
      : `${beforeWhere} ${predicate}${separator}${afterClause}`
    return { ok: true, sql: nextSql, predicate }
  }

  const beforeInsert = sql.slice(0, insertBoundary).trimEnd()
  const afterInsert = sql.slice(insertBoundary)
  const suffixGap = afterInsert.length > 0 && !/^[;\s]/.test(afterInsert) ? ' ' : ''
  const needsNewline = /(?:--|#)[^\r\n]*$/.test(beforeInsert)
  const leadingGap = needsNewline ? '\n' : ' '
  const nextSql = `${beforeInsert}${leadingGap}WHERE ${predicate}${suffixGap}${afterInsert}`
  return { ok: true, sql: nextSql, predicate }
}
