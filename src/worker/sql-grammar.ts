import {
  PostgresParser,
  SqliteParser,
  type SqlParserInstance,
} from '../../vendor/sql-parser-pg-sqlite.js'
import { MssqlParser, MysqlParser } from '../../vendor/sql-parser-mysql-mssql.js'

const MAX_GRAMMAR_SQL_CHARS = 4000
const MAX_GRAMMAR_CACHE_ENTRIES = 128
const MAX_GRAMMAR_PROBE_BUDGET_MS = 120
const MAX_PG_PAREN_DEPTH = 6
const MAX_PG_UNCLOSED_PARENS = 6
const MAX_OTHER_PAREN_DEPTH = 48

type GrammarDialectKey = 'postgres' | 'mysql' | 'sqlite' | 'mssql'

const CORE_DML_STARTERS: ReadonlySet<string> = new Set([
  'SELECT',
  'WITH',
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
])

const CURSOR_COMPLETION_PROBES: readonly string[] = [
  '__p__',
  ' __p__ ',
  ' __p__ = 1 ',
  ' 1 ',
  ')',
  ' __p__ ON 1 = 1 ',
  ' BY __p__ ',
  ' 1 )',
  ' __p__ )',
  ' VALUES (1) ',
  ' AND 2 ',
  ' THEN 1 END ',
  ' __p__ = 1 THEN 1 END ',
  ' 1 END ',
  "x'",
  'x"',
  'x`',
]

const CURSOR_KEYWORD_PREFIX_TARGETS: readonly string[] = [
  'FROM',
  'WHERE',
  'JOIN',
  'ON',
  'USING',
  'AND',
  'OR',
  'ORDER',
  'GROUP',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'BY',
  'SELECT',
  'INTO',
  'VALUES',
  'SET',
  'UNION',
  'AS',
  'IN',
  'IS',
  'LIKE',
  'BETWEEN',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
]

const DIALECT_EXPRESSION_OP_CHARS = new Set(['|', '~', '@', '?', '#'])

const parserCache = new Map<GrammarDialectKey, SqlParserInstance>()
const grammarCheckCache = new Map<string, SqlGrammarCheck>()

export interface SqlGrammarCheck {
  readonly supported: boolean
  readonly valid: boolean
  readonly errorOffset: number | null
  readonly errorMessage: string | null
}

const UNSUPPORTED_CHECK: SqlGrammarCheck = Object.freeze({
  supported: false,
  valid: true,
  errorOffset: null,
  errorMessage: null,
})

const VALID_CHECK: SqlGrammarCheck = Object.freeze({
  supported: true,
  valid: true,
  errorOffset: null,
  errorMessage: null,
})

function resolveGrammarDialect(dialect?: string): GrammarDialectKey | null {
  const normalized = (dialect ?? '').trim().toLowerCase()
  if (normalized === 'postgres' || normalized === 'postgresql' || normalized === 'cockroachdb') {
    return 'postgres'
  }
  if (normalized === 'mysql' || normalized === 'mariadb') {
    return 'mysql'
  }
  if (normalized === 'sqlite' || normalized === 'libsql' || normalized === 'd1') {
    return 'sqlite'
  }
  if (normalized === 'mssql') {
    return 'mssql'
  }
  return null
}

function getParserForDialect(key: GrammarDialectKey): SqlParserInstance {
  const cached = parserCache.get(key)
  if (cached) return cached
  const instance: SqlParserInstance =
    key === 'postgres'
      ? new PostgresParser()
      : key === 'mysql'
        ? new MysqlParser()
        : key === 'sqlite'
          ? new SqliteParser()
          : new MssqlParser()
  parserCache.set(key, instance)
  return instance
}

function hasNestedBlockComment(sql: string): boolean {
  let depth = 0
  let inQuote: string | null = null
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (inQuote) {
      if (ch === '\\' && inQuote !== '`') {
        i += 1
      } else if (ch === inQuote) {
        if (next === inQuote) i += 1
        else inQuote = null
      }
      continue
    }
    if (depth === 0 && (ch === "'" || ch === '"' || ch === '`')) {
      inQuote = ch
      continue
    }
    if (depth === 0 && ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i + 2)
      if (nl === -1) return false
      i = nl
      continue
    }
    if (ch === '/' && next === '*') {
      depth += 1
      if (depth > 1) return true
      i += 1
    } else if (depth > 0 && ch === '*' && next === '/') {
      depth -= 1
      i += 1
    }
  }
  return false
}

function isCoreDmlStatement(sql: string): boolean {
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1
      continue
    }
    if ((ch === '-' && next === '-') || ch === '#') {
      const nl = sql.indexOf('\n', i)
      if (nl === -1) return false
      i = nl + 1
      continue
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) return false
      i = end + 2
      continue
    }
    break
  }
  if (i >= sql.length) return false
  if (sql[i] === '(') return true
  const wordMatch = /^[A-Za-z_]+/.exec(sql.slice(i))
  if (!wordMatch) return false
  return CORE_DML_STARTERS.has(wordMatch[0].toUpperCase())
}

function extractParserErrorOffset(err: unknown, maxLen: number): number | null {
  if (!err || typeof err !== 'object' || !('location' in err)) return null
  const loc = err.location
  if (!loc || typeof loc !== 'object' || !('start' in loc)) return null
  const start = loc.start
  if (!start || typeof start !== 'object' || !('offset' in start)) return null
  const rawOffset = start.offset
  if (typeof rawOffset !== 'number' || !Number.isFinite(rawOffset)) return null
  return Math.max(0, Math.min(maxLen, Math.trunc(rawOffset)))
}

function matchPgDollarTag(sql: string, index: number): string | null {
  if (sql[index] !== '$') return null
  if (sql[index + 1] === '$') return '$$'
  const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$/.exec(sql.slice(index, index + 64))
  return m ? m[0] : null
}

function hasExcessiveParenNesting(sql: string, key: GrammarDialectKey): boolean {
  const maxDepthLimit = key === 'postgres' ? MAX_PG_PAREN_DEPTH : MAX_OTHER_PAREN_DEPTH
  const maxUnclosedLimit = key === 'postgres' ? MAX_PG_UNCLOSED_PARENS : MAX_OTHER_PAREN_DEPTH
  const allowHashComment = key === 'mysql'
  const nestedBlockComments = key === 'postgres'
  const allowBackslashInSingle = key === 'mysql'

  let depth = 0
  let inQuote: string | null = null
  let allowBackslash = false

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (inQuote !== null) {
      if (allowBackslash && ch === '\\') {
        i += 1
        continue
      }
      if (ch === inQuote) {
        if (next === inQuote) {
          i += 1
        } else {
          inQuote = null
          allowBackslash = false
        }
      }
      continue
    }

    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i + 2)
      if (nl === -1) break
      i = nl
      continue
    }
    if (allowHashComment && ch === '#') {
      const nl = sql.indexOf('\n', i + 1)
      if (nl === -1) break
      i = nl
      continue
    }
    if (ch === '/' && next === '*') {
      let commentDepth = 1
      let j = i + 2
      while (j < sql.length && commentDepth > 0) {
        if (nestedBlockComments && sql[j] === '/' && sql[j + 1] === '*') {
          commentDepth += 1
          j += 2
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          commentDepth -= 1
          j += 2
        } else {
          j += 1
        }
      }
      i = j - 1
      continue
    }
    if (key === 'postgres' && (ch === 'E' || ch === 'e') && next === "'") {
      const prev = i > 0 ? sql[i - 1] : ''
      if (!/[A-Za-z0-9_$]/.test(prev)) {
        inQuote = "'"
        allowBackslash = true
        i += 1
        continue
      }
    }
    if (key === 'postgres' && ch === '$') {
      const tag = matchPgDollarTag(sql, i)
      if (tag !== null) {
        const closeIdx = sql.indexOf(tag, i + tag.length)
        if (closeIdx === -1) break
        i = closeIdx + tag.length - 1
        continue
      }
    }
    if (key === 'mssql' && ch === '[') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === ']') {
          if (sql[j + 1] === ']') {
            j += 2
            continue
          }
          break
        }
        j += 1
      }
      i = j
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inQuote = ch
      allowBackslash = ch === "'" && allowBackslashInSingle
      continue
    }

    if (ch === '(') {
      depth += 1
      if (depth > maxDepthLimit) return true
    } else if (ch === ')' && depth > 0) {
      depth -= 1
    }
  }

  return depth > maxUnclosedLimit
}

function parseWithInstance(parser: SqlParserInstance, sql: string): SqlGrammarCheck {
  try {
    parser.astify(sql)
    return VALID_CHECK
  } catch (err) {
    if (err instanceof RangeError) {
      return UNSUPPORTED_CHECK
    }
    const errorOffset = extractParserErrorOffset(err, sql.length)
    if (errorOffset === null) {
      return UNSUPPORTED_CHECK
    }
    const errorMessage = err instanceof Error ? err.message : String(err)
    return Object.freeze({
      supported: true,
      valid: false,
      errorOffset,
      errorMessage,
    })
  }
}

function matchesAnyCursorProbe(
  parser: SqlParserInstance,
  before: string,
  after: string,
  deadlineMs: number
): boolean {
  for (const probe of CURSOR_COMPLETION_PROBES) {
    if (performance.now() >= deadlineMs) {
      return true
    }
    if (parseWithInstance(parser, `${before}${probe}${after}`).valid) {
      return true
    }
  }
  return false
}

function isActiveTrailingWordAtCursor(
  parser: SqlParserInstance,
  before: string,
  after: string,
  pos: number,
  errorOffset: number | null,
  deadlineMs: number
): boolean {
  const trailingWord = /[A-Za-z_][A-Za-z0-9_]*$/.exec(before)
  if (!trailingWord) return false

  const partialUpper = trailingWord[0].toUpperCase()
  for (const kw of CURSOR_KEYWORD_PREFIX_TARGETS) {
    if (kw.length > partialUpper.length && kw.startsWith(partialUpper)) {
      if (performance.now() >= deadlineMs) {
        return true
      }
      if (parseWithInstance(parser, `${before}${kw.slice(partialUpper.length)}${after}`).valid) {
        return true
      }
    }
  }

  if (after.trim().length !== 0 || errorOffset === null || errorOffset < pos - trailingWord[0].length) {
    return false
  }
  if (performance.now() >= deadlineMs) {
    return true
  }
  const beforeWord = before.slice(0, pos - trailingWord[0].length)
  return (
    parseWithInstance(parser, beforeWord).valid ||
    matchesAnyCursorProbe(parser, beforeWord, '', deadlineMs)
  )
}

function isDialectOperatorGrammarGap(sql: string, errorOffset: number | null): boolean {
  if (errorOffset === null || errorOffset < 0 || errorOffset >= sql.length) return false
  const ch = sql[errorOffset]
  return Boolean(ch && DIALECT_EXPRESSION_OP_CHARS.has(ch))
}

function rememberGrammarCheck(cacheKey: string, result: SqlGrammarCheck): void {
  grammarCheckCache.delete(cacheKey)
  grammarCheckCache.set(cacheKey, result)
  while (grammarCheckCache.size > MAX_GRAMMAR_CACHE_ENTRIES) {
    const oldest = grammarCheckCache.keys().next().value
    if (oldest === undefined) break
    grammarCheckCache.delete(oldest)
  }
}

export function checkSqlGrammar(sql: string, dialect?: string): SqlGrammarCheck {
  if (!sql || sql.length > MAX_GRAMMAR_SQL_CHARS) return UNSUPPORTED_CHECK
  const key = resolveGrammarDialect(dialect)
  if (!key) return UNSUPPORTED_CHECK
  const cacheKey = `${key}\0${sql}`
  const cached = grammarCheckCache.get(cacheKey)
  if (cached !== undefined) {
    rememberGrammarCheck(cacheKey, cached)
    return cached
  }
  if (!isCoreDmlStatement(sql) || hasNestedBlockComment(sql) || hasExcessiveParenNesting(sql, key)) {
    return UNSUPPORTED_CHECK
  }
  const result = parseWithInstance(getParserForDialect(key), sql)
  rememberGrammarCheck(cacheKey, result)
  return result
}

export function hasNonCursorGrammarError(
  sql: string,
  cursorOffset: number,
  dialect?: string
): boolean {
  if (!Number.isFinite(cursorOffset)) return false
  const base = checkSqlGrammar(sql, dialect)
  if (!base.supported || base.valid) return false

  const key = resolveGrammarDialect(dialect)
  if (!key) return false
  const deadlineMs = performance.now() + MAX_GRAMMAR_PROBE_BUDGET_MS
  const parser = getParserForDialect(key)
  const pos = Math.max(0, Math.min(sql.length, Math.trunc(cursorOffset)))
  const before = sql.slice(0, pos)
  const after = sql.slice(pos)

  if (isActiveTrailingWordAtCursor(parser, before, after, pos, base.errorOffset, deadlineMs)) {
    return false
  }
  return !matchesAnyCursorProbe(parser, before, after, deadlineMs)
}

function checkCandidateGrammarRegression(
  before: SqlGrammarCheck,
  prefix: string,
  suggestion: string,
  suffix: string,
  afterSql: string,
  insertedDelta: number,
  dialect?: string
): boolean {
  const after = checkSqlGrammar(afterSql, dialect)
  if (!after.supported || after.valid) return false

  const endOfInsertion = prefix.length + suggestion.length
  const eofAppend = suffix.trim().length === 0
  if (eofAppend && !hasNonCursorGrammarError(afterSql, endOfInsertion, dialect)) {
    return false
  }

  if (before.supported && before.valid) {
    return true
  }

  if (eofAppend) {
    if (!before.supported) return false
    if (isDialectOperatorGrammarGap(afterSql, after.errorOffset)) return false
    const beforeHadNonCursorErr = hasNonCursorGrammarError(`${prefix}${suffix}`, prefix.length, dialect)
    return !beforeHadNonCursorErr
  }

  const errPos = after.errorOffset
  if (errPos === null) return false
  if (errPos >= prefix.length && errPos < endOfInsertion) {
    return true
  }
  return Boolean(
    before.supported &&
      !before.valid &&
      before.errorOffset !== null &&
      before.errorOffset >= prefix.length &&
      errPos >= prefix.length &&
      errPos < before.errorOffset + insertedDelta
  )
}

export function doesInsertionIntroduceGrammarError(
  prefix: string,
  suggestion: string,
  suffix: string,
  dialect?: string
): boolean {
  if (!suggestion) return false
  const before = checkSqlGrammar(`${prefix}${suffix}`, dialect)
  const literalAfterSql = `${prefix}${suggestion}${suffix}`
  if (checkCandidateGrammarRegression(before, prefix, suggestion, suffix, literalAfterSql, suggestion.length, dialect)) {
    return true
  }
  const isGluedMultiTokenBoundary =
    /[A-Za-z0-9_]$/.test(suggestion) && /^[A-Za-z0-9_]/.test(suffix) && /\s/.test(suggestion)
  if (!isGluedMultiTokenBoundary) return false
  const spacedAfterSql = `${prefix}${suggestion} ${suffix}`
  return checkCandidateGrammarRegression(before, prefix, suggestion, suffix, spacedAfterSql, suggestion.length + 1, dialect)
}
