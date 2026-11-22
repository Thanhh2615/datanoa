import type { DatabaseDriverType } from '../../protocol'
import {
  formatSqlLiteral,
  isIdentContChar,
  isIdentStartChar,
  isPostgresEscapeStringStart,
  matchDollarQuoteTag,
  normalizeJsonValue,
  quoteIdentForDialect,
  quoteTableReference,
  scanBlockCommentEnd,
  scanLineCommentEnd,
  scanQuotedSegmentEnd,
  usesBackslashAndHash,
} from './sql-lexer.js'

export type ExportFormat =
  | 'sql-insert'
  | 'sql-update'
  | 'json'
  | 'ndjson'
  | 'csv'
  | 'tsv'
  | 'markdown'

export interface FormatDataExportOptions {
  columns: string[]
  rows: Record<string, unknown>[]
  format: ExportFormat
  tableName?: string
  dialect?: DatabaseDriverType
  primaryKeys?: string[]
}

function formatTabularCellText(value: unknown, nullText: string): string {
  if (value === null || value === undefined) return nullText
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? nullText : value.toISOString()
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'object') {
    return JSON.stringify(normalizeJsonValue(value))
  }
  return String(value)
}

function escapeDelimitedField(text: string, delimiter: ',' | '\t'): string {
  if (
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r')
  ) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function escapeMarkdownCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>')
}

function projectRow(columns: string[], row: Record<string, unknown>): Record<string, unknown> {
  if (columns.length === 0) {
    return normalizeJsonValue(row) as Record<string, unknown>
  }
  const out: Record<string, unknown> = {}
  for (const col of columns) {
    out[col] = normalizeJsonValue(row[col])
  }
  return out
}

function formatSqlInsertRows(
  columns: string[],
  rows: Record<string, unknown>[],
  tableName: string,
  dialect: DatabaseDriverType
): string {
  if (columns.length === 0 || rows.length === 0) return ''
  const qTable = quoteTableReference(tableName, dialect)
  const qCols = columns.map((c) => quoteIdentForDialect(c, dialect)).join(', ')
  return rows
    .map((row) => {
      const vals = columns.map((c) => formatSqlLiteral(row[c], dialect)).join(', ')
      return `INSERT INTO ${qTable} (${qCols}) VALUES (${vals});`
    })
    .join('\n')
}

function isBlobLikeExportValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true
  if (typeof value === 'string' && /^\[BLOB\s+\d+\s*B\]$/i.test(value.trim())) return true
  if (typeof value === 'object' && 'type' in value && (value as { type?: unknown }).type === 'Buffer') {
    return true
  }
  return false
}

function formatSqlUpdateRows(
  columns: string[],
  rows: Record<string, unknown>[],
  tableName: string,
  dialect: DatabaseDriverType,
  primaryKeys?: string[]
): string {
  if (columns.length === 0 || rows.length === 0) return ''
  const qTable = quoteTableReference(tableName, dialect)
  const explicitPks = primaryKeys && primaryKeys.length > 0 ? primaryKeys : null
  const hasExplicitPk = explicitPks !== null
  const pkCols = explicitPks ?? columns
  const pkSet = new Set(pkCols)
  const nonPkCols = hasExplicitPk ? columns.filter((c) => !pkSet.has(c)) : columns
  const setCols = nonPkCols.length > 0 ? nonPkCols : columns

  const statements = rows.map((row) => {
    const setSql = setCols
      .map((c) => `${quoteIdentForDialect(c, dialect)} = ${formatSqlLiteral(row[c], dialect)}`)
      .join(', ')
    const effectiveWhereCols = hasExplicitPk
      ? pkCols
      : (() => {
          const nonBlob = pkCols.filter((c) => !isBlobLikeExportValue(row[c]))
          return nonBlob.length > 0 ? nonBlob : pkCols
        })()
    const whereSql = effectiveWhereCols
      .map((pk) => {
        const qPk = quoteIdentForDialect(pk, dialect)
        const pkVal = row[pk]
        if (pkVal === null || pkVal === undefined) {
          return `${qPk} IS NULL`
        }
        return `${qPk} = ${formatSqlLiteral(pkVal, dialect)}`
      })
      .join(' AND ')
    return `UPDATE ${qTable} SET ${setSql} WHERE ${whereSql};`
  })

  if (!hasExplicitPk) {
    return `-- WARNING: Table has no primary key; matching all non-BLOB columns.\n${statements.join('\n')}`
  }
  return statements.join('\n')
}

/**
 * Formats query or table result rows into one of 7 JetBrains Data Extractor formats.
 */
export function formatDataExport(options: FormatDataExportOptions): string {
  const {
    columns,
    rows,
    format,
    tableName = 'table_name',
    dialect = 'postgres',
    primaryKeys,
  } = options

  switch (format) {
    case 'sql-insert':
      return formatSqlInsertRows(columns, rows, tableName, dialect)
    case 'sql-update':
      return formatSqlUpdateRows(columns, rows, tableName, dialect, primaryKeys)
    case 'json': {
      const projected = rows.map((row) => projectRow(columns, row))
      return JSON.stringify(projected, null, 2)
    }
    case 'ndjson':
      return rows.map((row) => JSON.stringify(projectRow(columns, row))).join('\n')
    case 'csv':
    case 'tsv': {
      if (columns.length === 0) return ''
      const delimiter = format === 'csv' ? ',' : '\t'
      const header = columns.map((c) => escapeDelimitedField(c, delimiter)).join(delimiter)
      const body = rows.map((row) =>
        columns
          .map((c) => escapeDelimitedField(formatTabularCellText(row[c], ''), delimiter))
          .join(delimiter)
      )
      return [header, ...body].join('\n')
    }
    case 'markdown': {
      if (columns.length === 0) return ''
      const header = `| ${columns.map((c) => escapeMarkdownCell(c)).join(' | ')} |`
      const sep = `| ${columns.map(() => '---').join(' | ')} |`
      const body = rows.map(
        (row) =>
          `| ${columns
            .map((c) => escapeMarkdownCell(formatTabularCellText(row[c], 'NULL')))
            .join(' | ')} |`
      )
      return [header, sep, ...body].join('\n')
    }
  }
}

/**
 * Formats an array of values as a SQL `IN (...)` tuple or full predicate when `columnName` is supplied.
 */
export function formatSqlInList(
  values: unknown[],
  dialect: DatabaseDriverType,
  options?: { deduplicate?: boolean; columnName?: string }
): string {
  if (!Array.isArray(values) || values.length === 0) return ''

  const deduplicate = options?.deduplicate !== false
  const colName = (options?.columnName ?? '').trim()
  const nonNullLiterals: string[] = []
  const seen = new Set<string>()
  let hasNull = false

  for (const val of values) {
    if (val === null || val === undefined) {
      hasNull = true
      continue
    }
    const lit = formatSqlLiteral(val, dialect)
    if (deduplicate) {
      if (seen.has(lit)) continue
      seen.add(lit)
    }
    nonNullLiterals.push(lit)
  }

  if (colName) {
    const qCol = quoteIdentForDialect(colName, dialect)
    if (nonNullLiterals.length > 0 && hasNull) {
      return `(${qCol} IN (${nonNullLiterals.join(', ')}) OR ${qCol} IS NULL)`
    }
    if (nonNullLiterals.length > 0) {
      return `${qCol} IN (${nonNullLiterals.join(', ')})`
    }
    if (hasNull) {
      return `${qCol} IS NULL`
    }
    return ''
  }

  if (nonNullLiterals.length > 0) {
    return `(${nonNullLiterals.join(', ')})`
  }
  return hasNull ? '(NULL)' : ''
}

/**
 * Exports a rectangular cell matrix into TSV, TSV with headers, CSV, or pretty JSON.
 */
export function formatCellMatrixExport(
  headers: string[],
  matrix: unknown[][],
  format: 'tsv' | 'tsv-headers' | 'csv' | 'json'
): string {
  if (format === 'json') {
    const records = matrix.map((row) => {
      const obj: Record<string, unknown> = {}
      const colCount = Math.max(headers.length, row.length)
      for (let i = 0; i < colCount; i++) {
        const key = headers[i] && headers[i].length > 0 ? headers[i] : `col_${i + 1}`
        obj[key] = normalizeJsonValue(row[i])
      }
      return obj
    })
    return JSON.stringify(records, null, 2)
  }

  const delimiter: ',' | '\t' = format === 'csv' ? ',' : '\t'
  const lines: string[] = []
  if ((format === 'tsv-headers' || format === 'csv') && headers.length > 0) {
    lines.push(headers.map((h) => escapeDelimitedField(h, delimiter)).join(delimiter))
  }
  const isSingleCellPlainTsv =
    format === 'tsv' && matrix.length === 1 && matrix[0]?.length === 1
  for (const row of matrix) {
    lines.push(
      row
        .map((cell) => {
          const text = formatTabularCellText(cell, '')
          if (isSingleCellPlainTsv) {
            return text
          }
          return escapeDelimitedField(text, delimiter)
        })
        .join(delimiter)
    )
  }
  return lines.join('\n')
}

type SqlFormatTokenKind =
  | 'word'
  | 'quoted'
  | 'line_comment'
  | 'block_comment'
  | 'paren_open'
  | 'paren_close'
  | 'comma'
  | 'semicolon'
  | 'dot'
  | 'cast'
  | 'other'

interface SqlFormatToken {
  kind: SqlFormatTokenKind
  text: string
  upper: string
}

const SQL_FORMAT_KEYWORDS: ReadonlySet<string> = new Set([
  'SELECT',
  'DISTINCT',
  'ALL',
  'FROM',
  'AS',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'OUTER',
  'CROSS',
  'NATURAL',
  'ON',
  'USING',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'IN',
  'IS',
  'NULL',
  'LIKE',
  'ILIKE',
  'BETWEEN',
  'EXISTS',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'GROUP',
  'BY',
  'HAVING',
  'ORDER',
  'ASC',
  'DESC',
  'NULLS',
  'FIRST',
  'LAST',
  'LIMIT',
  'OFFSET',
  'FETCH',
  'NEXT',
  'ROWS',
  'ONLY',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'INSERT',
  'INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',
  'RETURNING',
  'WITH',
  'RECURSIVE',
  'CREATE',
  'TABLE',
  'VIEW',
  'INDEX',
  'UNIQUE',
  'PRIMARY',
  'KEY',
  'FOREIGN',
  'REFERENCES',
  'CONSTRAINT',
  'DEFAULT',
  'ALTER',
  'ADD',
  'DROP',
  'COLUMN',
  'RENAME',
  'TO',
  'TRUNCATE',
  'IF',
  'EXPLAIN',
  'ANALYZE',
  'QUERY',
  'PLAN',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'PRAGMA',
  'TRUE',
  'FALSE',
  'OVER',
  'PARTITION',
  'WINDOW',
  'CONFLICT',
  'DO',
  'NOTHING',
  'CAST',
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'COALESCE',
])

const TOP_LEVEL_SINGLE_CLAUSES: ReadonlySet<string> = new Set([
  'SELECT',
  'FROM',
  'JOIN',
  'WHERE',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'VALUES',
  'UPDATE',
  'SET',
  'RETURNING',
  'WITH',
])

const KEYWORDS_WITH_SPACE_BEFORE_PAREN: ReadonlySet<string> = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'IN',
  'ON',
  'USING',
  'VALUES',
  'SET',
  'INTO',
  'AS',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'HAVING',
  'BY',
  'JOIN',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'EXISTS',
  'OVER',
  'TABLE',
  'RETURNING',
])

function tokenizeSqlForFormat(sql: string, dialect: DatabaseDriverType): SqlFormatToken[] {
  const tokens: SqlFormatToken[] = []
  const len = sql.length
  let i = 0

  while (i < len) {
    const ch = sql[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '-' && i + 1 < len && sql[i + 1] === '-') {
      const end = scanLineCommentEnd(sql, i)
      const text = sql.slice(i, end).replace(/[\r\n]+$/, '')
      tokens.push({ kind: 'line_comment', text, upper: '' })
      i = end
      continue
    }
    if (ch === '#' && usesBackslashAndHash(dialect)) {
      const end = scanLineCommentEnd(sql, i - 1)
      const text = sql.slice(i, end).replace(/[\r\n]+$/, '')
      tokens.push({ kind: 'line_comment', text, upper: '' })
      i = end
      continue
    }
    if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
      const end = scanBlockCommentEnd(sql, i)
      tokens.push({ kind: 'block_comment', text: sql.slice(i, end), upper: '' })
      i = end
      continue
    }
    if (isPostgresEscapeStringStart(sql, i, dialect)) {
      const end = scanQuotedSegmentEnd(sql, i + 1, "'", true).end
      tokens.push({ kind: 'quoted', text: sql.slice(i, end), upper: '' })
      i = end
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const allowBackslash = ch === "'" && usesBackslashAndHash(dialect)
      const end = scanQuotedSegmentEnd(sql, i, ch, allowBackslash).end
      tokens.push({ kind: 'quoted', text: sql.slice(i, end), upper: '' })
      i = end
      continue
    }
    if (ch === '$') {
      const tag = matchDollarQuoteTag(sql, i)
      if (tag !== null) {
        const closeIdx = sql.indexOf(tag, i + tag.length)
        const end = closeIdx >= 0 ? closeIdx + tag.length : len
        tokens.push({ kind: 'quoted', text: sql.slice(i, end), upper: '' })
        i = end
        continue
      }
    }
    if (ch === ':' && i + 1 < len && sql[i + 1] === ':') {
      tokens.push({ kind: 'cast', text: '::', upper: '::' })
      i += 2
      continue
    }
    if (ch === '(') {
      tokens.push({ kind: 'paren_open', text: '(', upper: '(' })
      i++
      continue
    }
    if (ch === ')') {
      tokens.push({ kind: 'paren_close', text: ')', upper: ')' })
      i++
      continue
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma', text: ',', upper: ',' })
      i++
      continue
    }
    if (ch === ';') {
      tokens.push({ kind: 'semicolon', text: ';', upper: ';' })
      i++
      continue
    }
    if (ch === '.') {
      tokens.push({ kind: 'dot', text: '.', upper: '.' })
      i++
      continue
    }
    if (isIdentStartChar(sql.charCodeAt(i))) {
      let end = i + 1
      while (end < len && isIdentContChar(sql.charCodeAt(end))) {
        end++
      }
      const text = sql.slice(i, end)
      tokens.push({ kind: 'word', text, upper: text.toUpperCase() })
      i = end
      continue
    }
    if (/[0-9]/.test(ch)) {
      let end = i + 1
      while (end < len && /[0-9._eE+-]/.test(sql[end])) {
        if ((sql[end] === '+' || sql[end] === '-') && !/[eE]/.test(sql[end - 1])) break
        end++
      }
      const text = sql.slice(i, end)
      tokens.push({ kind: 'other', text, upper: text })
      i = end
      continue
    }
    const two = i + 1 < len ? sql.slice(i, i + 2) : ''
    if (
      two === '<=' ||
      two === '>=' ||
      two === '<>' ||
      two === '!=' ||
      two === '||' ||
      two === '->'
    ) {
      if (two === '->' && i + 2 < len && sql[i + 2] === '>') {
        tokens.push({ kind: 'other', text: '->>', upper: '->>' })
        i += 3
        continue
      }
      tokens.push({ kind: 'other', text: two, upper: two })
      i += 2
      continue
    }
    if (
      (ch === '-' || ch === '+') &&
      i + 1 < len &&
      (/[0-9]/.test(sql[i + 1]) ||
        (sql[i + 1] === '.' && i + 2 < len && /[0-9]/.test(sql[i + 2]))) &&
      isUnarySignContext(tokens)
    ) {
      let end = i + 1
      if (sql[end] === '.') end++
      while (end < len && /[0-9._eE+-]/.test(sql[end])) {
        if ((sql[end] === '+' || sql[end] === '-') && !/[eE]/.test(sql[end - 1])) break
        end++
      }
      const text = sql.slice(i, end)
      tokens.push({ kind: 'other', text, upper: text })
      i = end
      continue
    }
    tokens.push({ kind: 'other', text: ch, upper: ch })
    i++
  }

  return tokens
}

const UNARY_PRECEDING_KEYWORDS: ReadonlySet<string> = new Set([
  'SELECT',
  'DISTINCT',
  'ALL',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'BETWEEN',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'BY',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'SET',
  'VALUES',
  'RETURN',
  'RETURNING',
  'IN',
  'LIKE',
  'ILIKE',
  'SIMILAR',
  'IS',
  'AS',
  'ON',
  'DEFAULT',
  'ANY',
  'SOME',
  'OVER',
])

const UNARY_PRECEDING_OPERATORS: ReadonlySet<string> = new Set([
  '=',
  '!=',
  '<>',
  '<',
  '<=',
  '>',
  '>=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '||',
  '->',
  '->>',
  '~',
  '!~',
  '&',
  '|',
  '^',
  ':',
])

function isUnarySignContext(tokens: SqlFormatToken[]): boolean {
  let prev: SqlFormatToken | undefined
  for (let idx = tokens.length - 1; idx >= 0; idx--) {
    const candidate = tokens[idx]
    if (candidate.kind === 'line_comment' || candidate.kind === 'block_comment') {
      continue
    }
    prev = candidate
    break
  }
  if (!prev) return true
  if (prev.kind === 'paren_open' || prev.kind === 'comma' || prev.kind === 'semicolon') {
    return true
  }
  if (prev.kind === 'word') {
    return UNARY_PRECEDING_KEYWORDS.has(prev.upper)
  }
  if (prev.kind === 'other') {
    return UNARY_PRECEDING_OPERATORS.has(prev.text)
  }
  return false
}

function matchCompoundClauseLength(tokens: SqlFormatToken[], index: number): { length: number; label: string } | null {
  const t0 = tokens[index]
  const t1 = tokens[index + 1]
  const t2 = tokens[index + 2]
  if (!t0 || t0.kind !== 'word') return null

  if (
    t1 &&
    t1.kind === 'word' &&
    t2 &&
    t2.kind === 'word' &&
    (t0.upper === 'LEFT' || t0.upper === 'RIGHT' || t0.upper === 'FULL') &&
    t1.upper === 'OUTER' &&
    t2.upper === 'JOIN'
  ) {
    return { length: 3, label: `${t0.upper} OUTER JOIN` }
  }

  if (t1 && t1.kind === 'word') {
    const pair = `${t0.upper} ${t1.upper}`
    if (
      pair === 'LEFT JOIN' ||
      pair === 'RIGHT JOIN' ||
      pair === 'INNER JOIN' ||
      pair === 'OUTER JOIN' ||
      pair === 'CROSS JOIN' ||
      pair === 'FULL JOIN' ||
      pair === 'NATURAL JOIN' ||
      pair === 'GROUP BY' ||
      pair === 'ORDER BY' ||
      pair === 'INSERT INTO' ||
      pair === 'DELETE FROM' ||
      pair === 'UNION ALL'
    ) {
      return { length: 2, label: pair }
    }
  }

  return null
}

function selectClauseHasTopLevelComma(tokens: SqlFormatToken[], selectIndex: number): boolean {
  let depth = 0
  let i = selectIndex + 1
  if (i < tokens.length && tokens[i].kind === 'word' && (tokens[i].upper === 'DISTINCT' || tokens[i].upper === 'ALL')) {
    i++
  }
  while (i < tokens.length) {
    const tok = tokens[i]
    if (tok.kind === 'paren_open') {
      depth++
    } else if (tok.kind === 'paren_close') {
      if (depth > 0) depth--
    } else if (depth === 0) {
      if (tok.kind === 'comma') return true
      if (tok.kind === 'semicolon') return false
      if (
        tok.kind === 'word' &&
        (tok.upper === 'FROM' ||
          tok.upper === 'WHERE' ||
          tok.upper === 'UNION' ||
          tok.upper === 'INTERSECT' ||
          tok.upper === 'EXCEPT' ||
          tok.upper === 'GROUP' ||
          tok.upper === 'ORDER' ||
          tok.upper === 'HAVING' ||
          tok.upper === 'LIMIT' ||
          tok.upper === 'OFFSET' ||
          tok.upper === 'INTO')
      ) {
        return false
      }
    }
    i++
  }
  return false
}

/**
 * Lightweight dialect-aware SQL formatter that uppercases major keywords and formats
 * major clauses on clean lines while strictly preserving strings, identifiers, dollar-quotes,
 * comments, and multi-statement boundaries.
 */
export function formatSql(sql: string, dialect: DatabaseDriverType = 'postgres'): string {
  if (!sql || !sql.trim()) return ''
  if (dialect === 'redis') {
    return sql.trim()
  }

  const tokens = tokenizeSqlForFormat(sql, dialect)
  if (tokens.length === 0) return ''

  let out = ''
  let parenDepth = 0
  let inMultiSelectList = false
  let inBetween = false
  let forceNewlineNext = false
  let afterSemicolon = false
  let prevToken: SqlFormatToken | null = null

  const appendBreak = (newlinePrefix: string): void => {
    out = out.replace(/[ \t]+$/, '')
    if (out.length > 0) {
      out += newlinePrefix
    } else if (newlinePrefix.startsWith('\n')) {
      out += newlinePrefix.replace(/^\n+/, '')
    }
  }

  const needsSpaceBefore = (tok: SqlFormatToken): boolean => {
    if (out.length === 0 || out.endsWith('\n') || out.endsWith(' ')) return false
    if (prevToken === null) return false
    if (prevToken.kind === 'paren_open' || prevToken.kind === 'dot' || prevToken.kind === 'cast') {
      return false
    }
    if (
      tok.kind === 'comma' ||
      tok.kind === 'semicolon' ||
      tok.kind === 'paren_close' ||
      tok.kind === 'dot' ||
      tok.kind === 'cast'
    ) {
      return false
    }
    if (tok.kind === 'paren_open' && prevToken.kind === 'word') {
      return KEYWORDS_WITH_SPACE_BEFORE_PAREN.has(prevToken.upper)
    }
    return true
  }

  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]

    if (afterSemicolon) {
      appendBreak('\n\n')
      afterSemicolon = false
      forceNewlineNext = false
      prevToken = null
    } else if (forceNewlineNext) {
      appendBreak('\n')
      forceNewlineNext = false
      prevToken = null
    }

    if (tok.kind === 'line_comment') {
      if (needsSpaceBefore(tok)) out += ' '
      out += tok.text
      forceNewlineNext = true
      prevToken = tok
      i++
      continue
    }

    if (tok.kind === 'block_comment') {
      if (needsSpaceBefore(tok)) out += ' '
      out += tok.text
      prevToken = tok
      i++
      continue
    }

    if (tok.kind === 'semicolon') {
      out = out.replace(/[ \t]+$/, '') + ';'
      parenDepth = 0
      inMultiSelectList = false
      inBetween = false
      afterSemicolon = true
      prevToken = tok
      i++
      continue
    }

    if (tok.kind === 'paren_open') {
      if (needsSpaceBefore(tok)) out += ' '
      out += '('
      parenDepth++
      prevToken = tok
      i++
      continue
    }

    if (tok.kind === 'paren_close') {
      out = out.replace(/[ \t]+$/, '') + ')'
      if (parenDepth > 0) parenDepth--
      prevToken = tok
      i++
      continue
    }

    if (tok.kind === 'comma') {
      if (parenDepth === 0 && inMultiSelectList) {
        out = out.replace(/[ \t]+$/, '') + ',\n  '
      } else {
        out = out.replace(/[ \t]+$/, '') + ','
      }
      prevToken = tok
      i++
      continue
    }

    if (parenDepth === 0 && tok.kind === 'word' && prevToken?.kind !== 'dot') {
      const compound = matchCompoundClauseLength(tokens, i)
      if (compound) {
        inMultiSelectList = false
        inBetween = false
        appendBreak('\n')
        out += compound.label
        prevToken = tokens[i + compound.length - 1]
        i += compound.length
        continue
      }

      if (TOP_LEVEL_SINGLE_CLAUSES.has(tok.upper)) {
        inMultiSelectList = false
        inBetween = false
        appendBreak('\n')
        out += tok.upper
        prevToken = tok
        if (tok.upper === 'SELECT') {
          const hasComma = selectClauseHasTopLevelComma(tokens, i)
          if (
            i + 1 < tokens.length &&
            tokens[i + 1].kind === 'word' &&
            (tokens[i + 1].upper === 'DISTINCT' || tokens[i + 1].upper === 'ALL')
          ) {
            out += ` ${tokens[i + 1].upper}`
            prevToken = tokens[i + 1]
            i++
          }
          if (hasComma) {
            inMultiSelectList = true
            out += '\n  '
            prevToken = null
          }
        }
        i++
        continue
      }

      if (tok.upper === 'BETWEEN') {
        inBetween = true
      } else if ((tok.upper === 'AND' || tok.upper === 'OR') && !(tok.upper === 'AND' && inBetween)) {
        appendBreak('\n  ')
        out += tok.upper
        prevToken = tok
        i++
        continue
      } else if (tok.upper === 'AND' && inBetween) {
        inBetween = false
      }
    }

    const formattedText =
      tok.kind === 'word' && prevToken?.kind !== 'dot' && SQL_FORMAT_KEYWORDS.has(tok.upper)
        ? tok.upper
        : tok.text

    if (needsSpaceBefore(tok)) out += ' '
    out += formattedText
    prevToken = tok
    i++
  }

  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim()
}
