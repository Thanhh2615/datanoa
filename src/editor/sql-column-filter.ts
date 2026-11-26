// src/editor/sql-column-filter.ts
// Pure, lexer-aware SQL column filter injector for arbitrary SELECT queries.
// Skips string literals, quoted identifiers, comments, dollar-quotes, and nested parentheses.

import type { DatabaseDriverType } from '../protocol.js'
import {
  formatSqlLiteral,
  getDialectLexerRules,
  isPostgresEscapeStringStart,
  matchDollarQuoteTag,
  quoteIdentForDialect,
  scanBlockCommentEnd,
  scanBracketIdentEnd,
  scanLineCommentEnd,
  scanOracleQuoteEnd,
  scanQuotedSegmentEnd,
  splitSqlStatements,
  stripCommentsAndLiterals,
} from '../drivers/common/sql-tools.js'

export type ColumnHeaderFilterOp = 'contains' | 'eq' | 'neq' | 'is-null' | 'is-not-null'

export type SqlColumnFilterResult =
  | { ok: true; sql: string; predicate: string }
  | { ok: false; reason: string }

interface TopLevelToken {
  kind: 'word' | 'quoted' | 'punct'
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
])
const SET_OP_KEYWORDS = new Set(['UNION', 'INTERSECT', 'EXCEPT', 'MINUS'])
const TABLE_PREFIX_MODIFIERS = new Set(['ONLY', 'LATERAL'])

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch)
}

function escapeSqlLikePattern(raw: string, dialect?: DatabaseDriverType): string {
  let escaped = raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
  if (dialect === 'mssql') {
    escaped = escaped.replace(/\[/g, '\\[')
  }
  return escaped
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
    const escaped = `%${escapeSqlLikePattern(value, dialect)}%`
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
    if (dialect === 'mssql') {
      return `CAST(${colIdent} AS NVARCHAR(MAX)) LIKE ${literal} ESCAPE '\\'`
    }
    if (dialect === 'oracle') {
      return `LOWER(TO_CHAR(${colIdent})) LIKE LOWER(${literal}) ESCAPE '\\'`
    }
    // SQLite / LibSQL / D1
    return `${colIdent} LIKE ${literal} ESCAPE '\\'`
  }

  const literal = formatSqlLiteral(value, dialect)
  return op === 'neq' ? `${colIdent} <> ${literal}` : `${colIdent} = ${literal}`
}

function endsWithActiveLineComment(text: string, dialect: DatabaseDriverType): boolean {
  const rules = getDialectLexerRules(dialect)
  const len = text.length
  let i = 0
  let endedInLineComment = false

  while (i < len) {
    const ch = text[i]
    const next = i + 1 < len ? text[i + 1] : ''
    if (rules.lineCommentDash && ch === '-' && next === '-') {
      const end = scanLineCommentEnd(text, i)
      endedInLineComment = end === len && !text.slice(i, end).includes('\n')
      i = end
      continue
    }
    if (rules.lineCommentSlash && ch === '/' && next === '/') {
      const end = scanLineCommentEnd(text, i)
      endedInLineComment = end === len && !text.slice(i, end).includes('\n')
      i = end
      continue
    }
    if (rules.lineCommentHash && ch === '#') {
      const end = scanLineCommentEnd(text, i - 1)
      endedInLineComment = end === len && !text.slice(i, end).includes('\n')
      i = end
      continue
    }
    if (ch === '/' && next === '*') {
      endedInLineComment = false
      i = scanBlockCommentEnd(text, i, rules.nestedBlockComments)
      continue
    }
    if (isPostgresEscapeStringStart(text, i, dialect)) {
      endedInLineComment = false
      i = scanQuotedSegmentEnd(text, i + 1, "'", true).end
      continue
    }
    const oracleQuote = scanOracleQuoteEnd(text, i, dialect)
    if (oracleQuote) {
      endedInLineComment = false
      i = oracleQuote.end
      continue
    }
    if (ch === "'" || ch === '"' || (ch === '`' && rules.backtickIdentifiers)) {
      endedInLineComment = false
      const allowBs =
        (ch === "'" && rules.backslashEscapesSingleQuote) ||
        (ch === '"' && rules.backslashEscapesDoubleQuote)
      i = scanQuotedSegmentEnd(text, i, ch, allowBs).end
      continue
    }
    if (ch === '[' && rules.bracketIdentifiers !== 'none') {
      endedInLineComment = false
      i = scanBracketIdentEnd(text, i, rules.bracketIdentifiers === 'doubling').end
      continue
    }
    if (rules.dollarQuoting && ch === '$') {
      const tag = matchDollarQuoteTag(text, i)
      if (tag !== null) {
        endedInLineComment = false
        const closeIdx = text.indexOf(tag, i + tag.length)
        i = closeIdx >= 0 ? closeIdx + tag.length : len
        continue
      }
    }
    if (!/\s/.test(ch)) {
      endedInLineComment = false
    } else if (ch === '\n') {
      endedInLineComment = false
    }
    i++
  }

  return endedInLineComment
}

function scanTopLevelTokens(
  sql: string,
  dialect: DatabaseDriverType
): { tokens: TopLevelToken[]; trailingSemicolonPos: number } {
  const tokens: TopLevelToken[] = []
  const rules = getDialectLexerRules(dialect)
  let depth = 0
  let i = 0
  let trailingSemicolonPos = -1

  while (i < sql.length) {
    const ch = sql[i]
    const next = i + 1 < sql.length ? sql[i + 1] : ''

    // Line comments: --, // (ClickHouse), or # (MySQL / MariaDB / ClickHouse)
    if (rules.lineCommentDash && ch === '-' && next === '-') {
      i = scanLineCommentEnd(sql, i)
      continue
    }
    if (rules.lineCommentSlash && ch === '/' && next === '/') {
      i = scanLineCommentEnd(sql, i)
      continue
    }
    if (rules.lineCommentHash && ch === '#') {
      i = scanLineCommentEnd(sql, i - 1)
      continue
    }

    // Block comments: /* ... */
    if (ch === '/' && next === '*') {
      i = scanBlockCommentEnd(sql, i, rules.nestedBlockComments)
      continue
    }

    // PostgreSQL / CockroachDB E'...' escape string
    if (isPostgresEscapeStringStart(sql, i, dialect)) {
      i = scanQuotedSegmentEnd(sql, i + 1, "'", true).end
      continue
    }

    // Oracle q'[...]' / nq'[...]' alternative quote literal
    const oracleQuote = scanOracleQuoteEnd(sql, i, dialect)
    if (oracleQuote) {
      i = oracleQuote.end
      continue
    }

    // Single-quoted string
    if (ch === "'") {
      i = scanQuotedSegmentEnd(sql, i, "'", rules.backslashEscapesSingleQuote).end
      continue
    }

    // Double-quoted or backtick-quoted identifier
    if (ch === '"' || (ch === '`' && rules.backtickIdentifiers)) {
      const start = i
      const allowBs = ch === '"' && rules.backslashEscapesDoubleQuote
      i = scanQuotedSegmentEnd(sql, i, ch, allowBs).end
      if (depth === 0) {
        tokens.push({ kind: 'quoted', upper: '', start, end: i })
      }
      continue
    }

    // Bracket identifier [...] (SQLite / LibSQL / D1 / MSSQL)
    if (rules.bracketIdentifiers !== 'none' && ch === '[') {
      const start = i
      i = scanBracketIdentEnd(sql, i, rules.bracketIdentifiers === 'doubling').end
      if (depth === 0) {
        tokens.push({ kind: 'quoted', upper: '', start, end: i })
      }
      continue
    }

    // PostgreSQL dollar-quoted string
    if (rules.dollarQuoting && ch === '$') {
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
      if (ch === '.' || ch === ',') {
        tokens.push({ kind: 'punct', upper: ch, start: i, end: i + 1 })
        i++
        continue
      }
      if (/[A-Za-z_]/.test(ch)) {
        const start = i
        i++
        while (i < sql.length && isIdentChar(sql[i])) i++
        tokens.push({ kind: 'word', upper: sql.slice(start, i).toUpperCase(), start, end: i })
        continue
      }
    }

    i++
  }

  return { tokens, trailingSemicolonPos }
}

/**
 * Injects a column filter predicate into a single-statement SELECT query (or CTE + SELECT)
 * by either wrapping an existing top-level WHERE clause with AND or inserting a new WHERE
 * right before GROUP BY / HAVING / WINDOW / ORDER BY / LIMIT / OFFSET / FETCH / FOR / START WITH / CONNECT BY.
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
  if (dialect === 'redis' || dialect === 'mongodb') {
    return { ok: false, reason: 'non_sql_dialect' }
  }

  const statements = splitSqlStatements(trimmed, dialect)
  if (statements.length !== 1) {
    return { ok: false, reason: 'multi_statement' }
  }

  const { tokens, trailingSemicolonPos } = scanTopLevelTokens(sql, dialect)
  const firstWordTok = tokens.find((t) => t.kind === 'word')
  if (!firstWordTok) {
    return { ok: false, reason: 'no_tokens' }
  }

  const firstWord = firstWordTok.upper
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    return { ok: false, reason: 'not_select' }
  }

  // Ensure a top-level SELECT and FROM exist, and reject set operations (UNION/INTERSECT/EXCEPT/MINUS)
  // while never misclassifying table names or aliases after FROM/JOIN/AS/. (e.g., `SELECT * FROM format`)
  let selectIdx = -1
  let fromIdx = -1
  let whereIdx = -1
  let trailingIdx = -1
  let expectTableTarget = false
  let expectAlias = false
  let inFromSource = false

  const nextWordAfter = (idx: number): TopLevelToken | undefined => {
    const next = tokens[idx + 1]
    return next && next.kind === 'word' ? next : undefined
  }

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx]

    if (tok.kind === 'punct') {
      if (tok.upper === '.' && inFromSource) {
        expectTableTarget = true
      } else if (tok.upper === ',' && inFromSource && whereIdx < 0 && trailingIdx < 0) {
        expectTableTarget = true
      }
      continue
    }

    if (expectAlias) {
      expectAlias = false
      continue
    }

    if (expectTableTarget) {
      if (tok.kind === 'word' && TABLE_PREFIX_MODIFIERS.has(tok.upper)) {
        continue
      }
      expectTableTarget = false
      // If followed by `.` (schema.table), the punct branch above re-arms expectTableTarget
      continue
    }

    if (tok.kind !== 'word') {
      continue
    }

    if (SET_OP_KEYWORDS.has(tok.upper)) {
      return { ok: false, reason: 'set_operation' }
    }
    if (selectIdx < 0 && tok.upper === 'SELECT') {
      selectIdx = idx
      continue
    }
    if (selectIdx < 0) continue

    if (fromIdx < 0 && tok.upper === 'FROM') {
      fromIdx = idx
      inFromSource = true
      expectTableTarget = true
      continue
    }
    if (fromIdx < 0) continue

    if (tok.upper === 'JOIN' && whereIdx < 0 && trailingIdx < 0) {
      inFromSource = true
      expectTableTarget = true
      continue
    }
    if (tok.upper === 'AS' && inFromSource && whereIdx < 0 && trailingIdx < 0) {
      expectAlias = true
      continue
    }

    if (whereIdx < 0 && tok.upper === 'WHERE') {
      whereIdx = idx
      inFromSource = false
      continue
    }

    if (trailingIdx < 0) {
      const nextUpper = nextWordAfter(idx)?.upper
      const isGroupBy = tok.upper === 'GROUP' && nextUpper === 'BY'
      const isOrderBy = tok.upper === 'ORDER' && nextUpper === 'BY'
      const isStartWith = tok.upper === 'START' && nextUpper === 'WITH'
      const isConnectBy = tok.upper === 'CONNECT' && nextUpper === 'BY'
      const isForClause =
        tok.upper === 'FOR' &&
        (nextUpper === 'UPDATE' ||
          nextUpper === 'SHARE' ||
          nextUpper === 'NO' ||
          nextUpper === 'KEY' ||
          nextUpper === 'JSON' ||
          nextUpper === 'XML')
      const isLockInShareMode =
        tok.upper === 'LOCK' &&
        nextWordAfter(idx)?.upper === 'IN' &&
        tokens[idx + 2]?.kind === 'word' &&
        tokens[idx + 2].upper === 'SHARE' &&
        tokens[idx + 3]?.kind === 'word' &&
        tokens[idx + 3].upper === 'MODE'
      const isClickHouseFormat =
        dialect === 'clickhouse' && tok.upper === 'FORMAT' && nextWordAfter(idx) !== undefined
      if (
        isGroupBy ||
        isOrderBy ||
        isStartWith ||
        isConnectBy ||
        isForClause ||
        isLockInShareMode ||
        isClickHouseFormat ||
        TRAILING_SINGLE_KEYWORDS.has(tok.upper)
      ) {
        trailingIdx = idx
        inFromSource = false
      }
    }
  }

  if (selectIdx < 0 || fromIdx < 0) {
    return { ok: false, reason: 'missing_from' }
  }

  const predicate = buildColumnHeaderPredicate(column, value, op, dialect)
  const insertBoundary =
    trailingIdx >= 0
      ? tokens[trailingIdx].start
      : trailingSemicolonPos >= 0
        ? trailingSemicolonPos
        : sql.length

  if (whereIdx >= 0 && tokens[whereIdx].end <= insertBoundary) {
    const whereWord = tokens[whereIdx]
    const beforeWhere = sql.slice(0, whereWord.end)
    const existingCondition = sql.slice(whereWord.end, insertBoundary).trim()
    const afterClause = sql.slice(insertBoundary)
    const separator = afterClause.length > 0 && !/^[;\s]/.test(afterClause) ? ' ' : ''
    if (!existingCondition) {
      const nextSql = `${beforeWhere} ${predicate}${separator}${afterClause}`
      return { ok: true, sql: nextSql, predicate }
    }
    const conditionCode = stripCommentsAndLiterals(existingCondition, dialect).trim()
    if (!conditionCode) {
      return { ok: false, reason: 'empty_where_clause' }
    }
    const hasTrailingLineComment = endsWithActiveLineComment(existingCondition, dialect)
    const closeParen = hasTrailingLineComment ? '\n)' : ')'
    const nextSql = `${beforeWhere} (${existingCondition}${closeParen} AND ${predicate}${separator}${afterClause}`
    return { ok: true, sql: nextSql, predicate }
  }

  const beforeInsert = sql.slice(0, insertBoundary).trimEnd()
  const afterInsert = sql.slice(insertBoundary)
  const suffixGap = afterInsert.length > 0 && !/^[;\s]/.test(afterInsert) ? ' ' : ''
  const needsNewline = endsWithActiveLineComment(beforeInsert, dialect)
  const leadingGap = needsNewline ? '\n' : ' '
  const nextSql = `${beforeInsert}${leadingGap}WHERE ${predicate}${suffixGap}${afterInsert}`
  return { ok: true, sql: nextSql, predicate }
}
