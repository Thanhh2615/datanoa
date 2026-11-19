import type {
  ColumnInfo,
  DatabaseDriverType,
  ForeignKeyInfo,
  IndexInfo,
  TableDetails,
} from '../../protocol'

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

const BACKTICK_DIALECTS: ReadonlySet<DatabaseDriverType> = new Set([
  'mysql',
  'mariadb',
  'clickhouse',
])

const MYSQL_FAMILY_DIALECTS: ReadonlySet<DatabaseDriverType> = new Set([
  'mysql',
  'mariadb',
])

const POSTGRES_FAMILY_DIALECTS: ReadonlySet<DatabaseDriverType> = new Set([
  'postgres',
  'cockroachdb',
])

function usesBackslashAndHash(dialect?: DatabaseDriverType): boolean {
  return dialect !== undefined && BACKTICK_DIALECTS.has(dialect)
}

function usesMysqlExecutableComments(dialect?: DatabaseDriverType): boolean {
  return dialect !== undefined && MYSQL_FAMILY_DIALECTS.has(dialect)
}

function isPostgresEscapeStringStart(
  sql: string,
  index: number,
  dialect?: DatabaseDriverType
): boolean {
  if (dialect === undefined || !POSTGRES_FAMILY_DIALECTS.has(dialect)) return false
  const ch = sql[index]
  if (ch !== 'E' && ch !== 'e') return false
  if (index + 1 >= sql.length || sql[index + 1] !== "'") return false
  return index === 0 || !isIdentContChar(sql.charCodeAt(index - 1))
}

/**
 * Quotes a single SQL identifier according to the target database dialect,
 * preserving dots inside single-identifier names rather than splitting them.
 */
export function quoteIdentForDialect(ident: string, dialect: DatabaseDriverType): string {
  if (BACKTICK_DIALECTS.has(dialect)) {
    return `\`${ident.replace(/`/g, '``')}\``
  }
  return `"${ident.replace(/"/g, '""')}"`
}

function tryParseQuotedTableParts(trimmed: string): string[] | null {
  const quoteChar = trimmed[0]
  if (quoteChar !== '"' && quoteChar !== '`') return null
  const parts: string[] = []
  let pos = 0
  const len = trimmed.length

  while (pos < len) {
    if (trimmed[pos] !== quoteChar) return null
    const seg = scanQuotedSegmentEnd(trimmed, pos, quoteChar, false)
    if (!seg.closed) return null
    const rawInner = trimmed.slice(pos + 1, seg.end - 1)
    const unescaped =
      quoteChar === '`' ? rawInner.replace(/``/g, '`') : rawInner.replace(/""/g, '"')
    if (!unescaped) return null
    parts.push(unescaped)
    pos = seg.end
    if (pos < len) {
      if (trimmed[pos] !== '.') return null
      pos++
      if (pos >= len) return null
    }
  }

  return parts.length > 0 ? parts : null
}

export function quoteTableReference(tableName: string, dialect: DatabaseDriverType): string {
  const trimmed = tableName.trim()
  if (!trimmed) {
    return quoteIdentForDialect('table_name', dialect)
  }
  const parsedQuotedParts = tryParseQuotedTableParts(trimmed)
  if (parsedQuotedParts) {
    return parsedQuotedParts.map((part) => quoteIdentForDialect(part, dialect)).join('.')
  }
  if (!trimmed.includes('"') && !trimmed.includes('`') && trimmed.includes('.')) {
    return trimmed
      .split('.')
      .filter((part) => part.length > 0)
      .map((part) => quoteIdentForDialect(part, dialect))
      .join('.')
  }
  return quoteIdentForDialect(trimmed, dialect)
}

function normalizeJsonValue(value: unknown): unknown {
  if (value === undefined) return null
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') {
    const num = Number(value)
    return Number.isSafeInteger(num) ? num : value.toString()
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (value instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, '0')).join('')
  }
  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    return Array.from(view, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item))
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined && typeof v !== 'function' && typeof v !== 'symbol') {
        out[k] = normalizeJsonValue(v)
      }
    }
    return out
  }
  return null
}

function formatSqlStringLiteral(raw: string, dialect: DatabaseDriverType): string {
  let escaped = raw
  if (BACKTICK_DIALECTS.has(dialect)) {
    escaped = escaped.replace(/\\/g, '\\\\').replace(/\0/g, '\\0')
  }
  escaped = escaped.replace(/'/g, "''")
  return `'${escaped}'`
}

export function formatSqlLiteral(value: unknown, dialect: DatabaseDriverType): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'NULL' : formatSqlStringLiteral(value.toISOString(), dialect)
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const hex = String(normalizeJsonValue(value))
    return `X'${hex}'`
  }
  if (typeof value === 'object') {
    return formatSqlStringLiteral(JSON.stringify(normalizeJsonValue(value)), dialect)
  }
  return formatSqlStringLiteral(String(value), dialect)
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

function formatSqlUpdateRows(
  columns: string[],
  rows: Record<string, unknown>[],
  tableName: string,
  dialect: DatabaseDriverType,
  primaryKeys?: string[]
): string {
  if (columns.length === 0 || rows.length === 0) return ''
  const qTable = quoteTableReference(tableName, dialect)
  const pkCols =
    primaryKeys && primaryKeys.length > 0 ? primaryKeys : [columns[0]]
  const pkSet = new Set(pkCols)
  const nonPkCols = columns.filter((c) => !pkSet.has(c))
  const setCols = nonPkCols.length > 0 ? nonPkCols : columns

  return rows
    .map((row) => {
      const setSql = setCols
        .map((c) => `${quoteIdentForDialect(c, dialect)} = ${formatSqlLiteral(row[c], dialect)}`)
        .join(', ')
      const whereSql = pkCols
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
    .join('\n')
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

export interface SqlStatementSlice {
  text: string
  start: number
  end: number
}

function isIdentStartChar(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
}

function isIdentContChar(code: number): boolean {
  return isIdentStartChar(code) || (code >= 48 && code <= 57)
}

function matchDollarQuoteTag(sql: string, index: number): string | null {
  if (sql.charCodeAt(index) !== 36 /* $ */) return null
  const len = sql.length
  if (index + 1 >= len) return null
  if (sql.charCodeAt(index + 1) === 36) return '$$'
  if (!isIdentStartChar(sql.charCodeAt(index + 1))) return null
  let cursor = index + 2
  while (cursor < len && isIdentContChar(sql.charCodeAt(cursor))) {
    cursor++
  }
  if (cursor < len && sql.charCodeAt(cursor) === 36) {
    return sql.slice(index, cursor + 1)
  }
  return null
}

function scanQuotedSegmentEnd(
  sql: string,
  start: number,
  quoteChar: string,
  allowBackslashEscape: boolean
): { end: number; closed: boolean } {
  let i = start + 1
  const len = sql.length
  while (i < len) {
    const ch = sql[i]
    if (allowBackslashEscape && ch === '\\') {
      i += 2
      continue
    }
    if (ch === quoteChar) {
      if (i + 1 < len && sql[i + 1] === quoteChar) {
        i += 2
        continue
      }
      return { end: i + 1, closed: true }
    }
    i++
  }
  return { end: len, closed: false }
}

function scanLineCommentEnd(sql: string, start: number): number {
  let i = start + 2
  const len = sql.length
  while (i < len && sql[i] !== '\n') {
    i++
  }
  return i < len ? i + 1 : len
}

function scanBlockCommentEnd(sql: string, start: number): number {
  let i = start + 2
  let depth = 1
  const len = sql.length
  while (i < len && depth > 0) {
    if (sql[i] === '/' && i + 1 < len && sql[i + 1] === '*') {
      depth++
      i += 2
      continue
    }
    if (sql[i] === '*' && i + 1 < len && sql[i + 1] === '/') {
      depth--
      i += 2
      continue
    }
    i++
  }
  return i
}

function trimSliceBounds(script: string, rawStart: number, rawEnd: number): { start: number; end: number } {
  let start = rawStart
  let end = rawEnd
  while (start < end && /\s/.test(script[start])) start++
  while (end > start && /\s/.test(script[end - 1])) end--
  return { start, end }
}

/**
 * Splits a SQL script into executable statements, preserving source offsets and ignoring
 * semicolons inside single/double/backtick quotes, $$ dollar blocks, and -- or /* *\/ comments.
 * Backslash single-quote escaping and `#` line comments are enabled strictly for MySQL/MariaDB/ClickHouse.
 */
export function splitSqlStatements(
  script: string,
  dialect?: DatabaseDriverType
): SqlStatementSlice[] {
  const results: SqlStatementSlice[] = []
  const len = script.length
  const backslashAndHash = usesBackslashAndHash(dialect)
  const mysqlExecComments = usesMysqlExecutableComments(dialect)
  let segStart = 0
  let hasExecutableToken = false
  let i = 0

  const flushSegment = (rawEnd: number): void => {
    if (hasExecutableToken) {
      const { start, end } = trimSliceBounds(script, segStart, rawEnd)
      if (end > start) {
        results.push({ text: script.slice(start, end), start, end })
      }
    }
    segStart = rawEnd + 1
    hasExecutableToken = false
  }

  while (i < len) {
    const ch = script[i]
    if (ch === '-' && i + 1 < len && script[i + 1] === '-') {
      i = scanLineCommentEnd(script, i)
      continue
    }
    if (ch === '#' && backslashAndHash) {
      i = scanLineCommentEnd(script, i - 1)
      continue
    }
    if (ch === '/' && i + 1 < len && script[i + 1] === '*') {
      if (mysqlExecComments && i + 2 < len && script[i + 2] === '!') {
        hasExecutableToken = true
        const closeIdx = script.indexOf('*/', i + 3)
        i = closeIdx >= 0 ? closeIdx + 2 : len
        continue
      }
      i = scanBlockCommentEnd(script, i)
      continue
    }
    if (isPostgresEscapeStringStart(script, i, dialect)) {
      hasExecutableToken = true
      i = scanQuotedSegmentEnd(script, i + 1, "'", true).end
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      hasExecutableToken = true
      const allowBackslash = ch === "'" && backslashAndHash
      i = scanQuotedSegmentEnd(script, i, ch, allowBackslash).end
      continue
    }
    if (ch === '$') {
      const tag = matchDollarQuoteTag(script, i)
      if (tag !== null) {
        hasExecutableToken = true
        const closeIdx = script.indexOf(tag, i + tag.length)
        i = closeIdx >= 0 ? closeIdx + tag.length : len
        continue
      }
    }
    if (ch === ';') {
      flushSegment(i)
      i++
      continue
    }
    if (!/\s/.test(ch)) {
      hasExecutableToken = true
    }
    i++
  }

  if (segStart < len) {
    flushSegment(len)
  }

  return results
}

/**
 * Finds the SQL statement enclosing or immediately preceding the given zero-based caret offset.
 */
export function findStatementAtOffset(
  script: string,
  offset: number,
  dialect?: DatabaseDriverType
): string {
  const stmts = splitSqlStatements(script, dialect)
  if (stmts.length === 0) return ''

  const pos = Math.max(0, Math.min(script.length, offset))
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i]
    if (pos <= stmt.end) {
      return stmt.text
    }
    const next = stmts[i + 1]
    if (!next) {
      return stmt.text
    }
    if (pos < next.start) {
      const gap = script.slice(stmt.end, next.start)
      const semiRel = gap.indexOf(';')
      const semiBoundary = semiRel >= 0 ? stmt.end + semiRel + 1 : stmt.end
      return pos <= semiBoundary ? stmt.text : next.text
    }
  }

  return stmts[stmts.length - 1].text
}

function buildQualifiedTableForDdl(
  schema: string,
  name: string,
  dialect: DatabaseDriverType
): string {
  const trimmedSchema = schema.trim()
  const omitSchema =
    !trimmedSchema ||
    ((dialect === 'sqlite' || dialect === 'libsql') && trimmedSchema.toLowerCase() === 'main')
  return omitSchema
    ? quoteIdentForDialect(name, dialect)
    : `${quoteIdentForDialect(trimmedSchema, dialect)}.${quoteIdentForDialect(name, dialect)}`
}

function resolveColumnTypeForDisplay(col: ColumnInfo, dialect?: DatabaseDriverType): string {
  const typeTrimmed = (col.type || '').trim()
  const nativeTrimmed = (col.nativeType || '').trim()

  // PostgreSQL/CockroachDB array udt_name (_text -> text[]) and length/precision preservation (character varying(255), numeric(10,2))
  if (dialect === 'postgres' || dialect === 'cockroachdb' || nativeTrimmed.startsWith('_')) {
    if (nativeTrimmed.startsWith('_') && nativeTrimmed.length > 1) {
      if (typeTrimmed && typeTrimmed.toUpperCase() !== 'ARRAY' && typeTrimmed.endsWith('[]')) {
        return typeTrimmed
      }
      return `${nativeTrimmed.slice(1)}[]`
    }
    if (typeTrimmed.includes('(') && !nativeTrimmed.includes('(')) {
      return typeTrimmed
    }
  }

  // MySQL/MariaDB: preserve COLUMN_TYPE with length/enum (e.g. varchar(255), enum('a','b'))
  if (typeTrimmed.includes('(') && !nativeTrimmed.includes('(')) {
    return typeTrimmed
  }

  return nativeTrimmed || typeTrimmed || 'TEXT'
}

/**
 * Reconstructs a dialect-appropriate CREATE TABLE DDL script including PK, FK, and CREATE [UNIQUE] INDEX statements.
 */
export function reconstructTableDdl(details: TableDetails, dialect: DatabaseDriverType): string {
  const qualifiedTable = buildQualifiedTableForDdl(details.schema, details.name, dialect)
  const pkCols =
    details.primaryKey.length > 0
      ? details.primaryKey
      : details.columns.filter((c) => c.isPrimaryKey).map((c) => c.name)

  const isSqliteDialect = dialect === 'sqlite' || dialect === 'libsql'
  const isMysqlDialect = dialect === 'mysql' || dialect === 'mariadb'
  const isPgDialect = dialect === 'postgres' || dialect === 'cockroachdb'

  let inlinePkHandled = false
  const bodyLines: string[] = []

  for (const col of details.columns) {
    const colType = resolveColumnTypeForDisplay(col, dialect)
    const parts: string[] = [quoteIdentForDialect(col.name, dialect), colType]

    const hasSequenceOrRowidDefault =
      typeof col.defaultValue === 'string' &&
      /(?:nextval\s*\(|unique_rowid\s*\()/i.test(col.defaultValue)

    const useInlineSqliteAutoInc =
      isSqliteDialect &&
      col.isAutoIncrement &&
      colType.trim().toUpperCase() === 'INTEGER' &&
      pkCols.length === 1 &&
      pkCols[0] === col.name

    if (useInlineSqliteAutoInc) {
      parts.push('PRIMARY KEY AUTOINCREMENT')
      inlinePkHandled = true
    } else if (
      isPgDialect &&
      col.isAutoIncrement &&
      !/serial/i.test(colType) &&
      !hasSequenceOrRowidDefault
    ) {
      parts.push('GENERATED BY DEFAULT AS IDENTITY')
    }

    if (!col.nullable) {
      parts.push('NOT NULL')
    }

    if (col.defaultValue !== null && col.defaultValue !== undefined && col.defaultValue !== '') {
      let formattedDefault = col.defaultValue
      if (isMysqlDialect) {
        try {
          formattedDefault = normalizeSqlDefaultExpression(col.defaultValue, colType)
        } catch {
          formattedDefault = col.defaultValue
        }
      }
      parts.push(`DEFAULT ${formattedDefault}`)
    }

    if (isMysqlDialect && col.isAutoIncrement) {
      parts.push('AUTO_INCREMENT')
    }

    bodyLines.push(`  ${parts.join(' ')}`)
  }

  if (pkCols.length > 0 && !inlinePkHandled) {
    const quotedPks = pkCols.map((pk) => quoteIdentForDialect(pk, dialect)).join(', ')
    bodyLines.push(`  PRIMARY KEY (${quotedPks})`)
  }

  for (const fk of details.foreignKeys) {
    const refTable = quoteTableReference(fk.referencedTable, dialect)
    const colRef = quoteIdentForDialect(fk.column, dialect)
    const targetRef = quoteIdentForDialect(fk.referencedColumn, dialect)
    const constraintPrefix = fk.constraintName
      ? `CONSTRAINT ${quoteIdentForDialect(fk.constraintName, dialect)} `
      : ''
    bodyLines.push(`  ${constraintPrefix}FOREIGN KEY (${colRef}) REFERENCES ${refTable} (${targetRef})`)
  }

  const createTableStmt =
    bodyLines.length > 0
      ? `CREATE TABLE ${qualifiedTable} (\n${bodyLines.join(',\n')}\n);`
      : `CREATE TABLE ${qualifiedTable} ();`

  const statements: string[] = [createTableStmt]

  for (const idx of details.indexes) {
    if (idx.isPrimary || idx.columns.length === 0) continue
    const uniqueKw = idx.isUnique ? 'UNIQUE ' : ''
    const idxCols = idx.columns.map((c) => quoteIdentForDialect(c, dialect)).join(', ')
    statements.push(
      `CREATE ${uniqueKw}INDEX ${quoteIdentForDialect(idx.name, dialect)} ON ${qualifiedTable} (${idxCols});`
    )
  }

  return statements.join('\n\n')
}

const LEADING_FILTER_KEYWORD_REGEX = /^(?:WHERE|ORDER\s+BY)\b\s*/i

/**
 * Normalizes a table WHERE or ORDER BY filter clause and rejects unquoted SQL statement breakouts
 * (`;`, `--`, `/*`, dialect-specific `#`, or unclosed string/identifier quotes).
 */
export function stripLeadingSqlComments(
  sql: string,
  dialect?: DatabaseDriverType
): string {
  const allowHash = usesBackslashAndHash(dialect)
  const mysqlExecComments = usesMysqlExecutableComments(dialect)
  const len = sql.length
  let i = 0
  while (i < len) {
    while (i < len && /\s/.test(sql[i])) i++
    if (i >= len) break
    if (sql[i] === '-' && i + 1 < len && sql[i + 1] === '-') {
      i = scanLineCommentEnd(sql, i)
      continue
    }
    if (allowHash && sql[i] === '#') {
      i = scanLineCommentEnd(sql, i - 1)
      continue
    }
    if (sql[i] === '/' && i + 1 < len && sql[i + 1] === '*') {
      if (mysqlExecComments && i + 2 < len && sql[i + 2] === '!') {
        break
      }
      i = scanBlockCommentEnd(sql, i)
      continue
    }
    break
  }
  return sql.slice(i)
}

export function sanitizeFilterClause(
  clause?: string,
  dialect?: DatabaseDriverType
): string | undefined {
  if (clause === undefined || clause === null) return undefined
  let trimmed = clause.trim()
  if (!trimmed) return undefined

  trimmed = trimmed.replace(LEADING_FILTER_KEYWORD_REGEX, '').trim()
  if (!trimmed) return undefined

  const backslashAndHash = usesBackslashAndHash(dialect)
  const allowDollarQuotes =
    dialect === undefined || dialect === 'postgres' || dialect === 'cockroachdb'
  let i = 0
  const len = trimmed.length
  while (i < len) {
    const ch = trimmed[i]
    if (isPostgresEscapeStringStart(trimmed, i, dialect)) {
      const seg = scanQuotedSegmentEnd(trimmed, i + 1, "'", true)
      if (!seg.closed) {
        throw new Error("Invalid filter clause: unclosed ' quote literal.")
      }
      i = seg.end
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const allowBackslash = ch === "'" && backslashAndHash
      const seg = scanQuotedSegmentEnd(trimmed, i, ch, allowBackslash)
      if (!seg.closed) {
        throw new Error(`Invalid filter clause: unclosed ${ch} quote literal.`)
      }
      i = seg.end
      continue
    }
    if (ch === '$' && allowDollarQuotes) {
      const tag = matchDollarQuoteTag(trimmed, i)
      if (tag !== null) {
        const closeIdx = trimmed.indexOf(tag, i + tag.length)
        if (closeIdx < 0) {
          throw new Error(`Invalid filter clause: unclosed ${tag} dollar-quoted literal.`)
        }
        i = closeIdx + tag.length
        continue
      }
    }
    if (ch === ';') {
      throw new Error('Invalid filter clause: unquoted semicolon (;) is not allowed.')
    }
    if (ch === '#' && backslashAndHash) {
      throw new Error('Invalid filter clause: unquoted SQL comment (#) is not allowed.')
    }
    if (ch === '-' && i + 1 < len && trimmed[i + 1] === '-') {
      throw new Error('Invalid filter clause: unquoted SQL comment (--) is not allowed.')
    }
    if (ch === '/' && i + 1 < len && trimmed[i + 1] === '*') {
      throw new Error('Invalid filter clause: unquoted SQL block comment (/*) is not allowed.')
    }
    i++
  }

  return trimmed
}

const SQL_MUTATING_VERBS: ReadonlySet<string> = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'UPSERT',
  'MERGE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'ATTACH',
  'DETACH',
  'VACUUM',
  'REINDEX',
  'RENAME',
  'COMMENT',
  'CALL',
  'DO',
  'LOCK',
  'KILL',
  'OPTIMIZE',
  'REPAIR',
  'FLUSH',
  'PURGE',
  'LOAD',
  'IMPORT',
  'COPY',
  'EXEC',
  'EXECUTE',
  'ANALYZE',
  'ANALYSE',
  'SHUTDOWN',
  'RESTART',
  'RESET',
  'SET',
  'SYSTEM',
  'EXCHANGE',
  'REFRESH',
  'CLUSTER',
  'RESTORE',
  'INSTALL',
  'UNINSTALL',
  'REASSIGN',
  'PREPARE',
  'BEGIN',
  'USE',
  'START',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'DEALLOCATE',
  'DISCARD',
  'CHECKPOINT',
])

const SQLITE_READONLY_PARENS_PRAGMAS: ReadonlySet<string> = new Set([
  'TABLE_INFO',
  'TABLE_XINFO',
  'FOREIGN_KEY_LIST',
  'FOREIGN_KEY_CHECK',
  'INDEX_LIST',
  'INDEX_INFO',
  'INDEX_XINFO',
  'TABLE_LIST',
  'INTEGRITY_CHECK',
  'QUICK_CHECK',
  'COLLATE',
])

const SQL_CTE_MUTATING_REGEX =
  /\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|ATTACH|DETACH)\b/i

const REDIS_READONLY_COMMANDS: ReadonlySet<string> = new Set([
  'GET',
  'MGET',
  'GETRANGE',
  'STRLEN',
  'EXISTS',
  'TYPE',
  'TTL',
  'PTTL',
  'SCAN',
  'HSCAN',
  'SSCAN',
  'ZSCAN',
  'KEYS',
  'DBSIZE',
  'PING',
  'ECHO',
  'INFO',
  'TIME',
  'HGET',
  'HMGET',
  'HGETALL',
  'HKEYS',
  'HVALS',
  'HLEN',
  'HEXISTS',
  'LRANGE',
  'LLEN',
  'LINDEX',
  'LPOS',
  'SMEMBERS',
  'SISMEMBER',
  'SMISMEMBER',
  'SCARD',
  'SRANDMEMBER',
  'ZRANGE',
  'ZREVRANGE',
  'ZRANGEBYSCORE',
  'ZSCORE',
  'ZRANK',
  'ZREVRANK',
  'ZCARD',
  'ZCOUNT',
  'XLEN',
  'XRANGE',
  'XREVRANGE',
  'OBJECT',
  'MEMORY',
  'COMMAND',
  'ROLE',
])

const REDIS_WRITE_COMMANDS: ReadonlySet<string> = new Set([
  'SET',
  'SETEX',
  'PSETEX',
  'SETNX',
  'MSET',
  'MSETNX',
  'GETSET',
  'GETDEL',
  'APPEND',
  'SETRANGE',
  'DEL',
  'UNLINK',
  'HSET',
  'HSETNX',
  'HMSET',
  'HDEL',
  'HINCRBY',
  'HINCRBYFLOAT',
  'LPUSH',
  'RPUSH',
  'LPOP',
  'RPOP',
  'BLPOP',
  'BRPOP',
  'LSET',
  'LINSERT',
  'LREM',
  'LTRIM',
  'SADD',
  'SREM',
  'SPOP',
  'SMOVE',
  'ZADD',
  'ZREM',
  'ZINCRBY',
  'ZPOPMIN',
  'ZPOPMAX',
  'FLUSHDB',
  'FLUSHALL',
  'RENAME',
  'RENAMENX',
  'EXPIRE',
  'EXPIREAT',
  'PEXPIRE',
  'PEXPIREAT',
  'PERSIST',
  'INCR',
  'INCRBY',
  'INCRBYFLOAT',
  'DECR',
  'DECRBY',
  'COPY',
  'MOVE',
  'SWAPDB',
  'MIGRATE',
  'RESTORE',
  'XADD',
  'XDEL',
  'XTRIM',
  'PFADD',
  'PFMERGE',
  'GEOADD',
  'PUBLISH',
  'EVAL',
  'EVALSHA',
  'SAVE',
  'BGSAVE',
  'BGREWRITEAOF',
  'SHUTDOWN',
])

function stripCommentsAndLiterals(
  sql: string,
  dialect?: DatabaseDriverType,
  preserveMysqlExecComments = true
): string {
  const backslashAndHash = usesBackslashAndHash(dialect)
  const unwrapMysqlExec = preserveMysqlExecComments && usesMysqlExecutableComments(dialect)
  let out = ''
  let i = 0
  let execCommentDepth = 0
  const len = sql.length

  while (i < len) {
    const ch = sql[i]
    if (ch === '-' && i + 1 < len && sql[i + 1] === '-') {
      out += ' '
      i = scanLineCommentEnd(sql, i)
      continue
    }
    if (ch === '#' && backslashAndHash) {
      out += ' '
      i = scanLineCommentEnd(sql, i - 1)
      continue
    }
    if (execCommentDepth > 0 && ch === '*' && i + 1 < len && sql[i + 1] === '/') {
      out += ' '
      execCommentDepth--
      i += 2
      continue
    }
    if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
      if (unwrapMysqlExec && i + 2 < len && sql[i + 2] === '!') {
        out += ' '
        execCommentDepth++
        i += 3
        while (i < len && sql[i] >= '0' && sql[i] <= '9') {
          i++
        }
        continue
      }
      out += ' '
      i = scanBlockCommentEnd(sql, i)
      continue
    }
    if (isPostgresEscapeStringStart(sql, i, dialect)) {
      out += ' '
      i = scanQuotedSegmentEnd(sql, i + 1, "'", true).end
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      out += ' '
      const allowBackslash = ch === "'" && backslashAndHash
      i = scanQuotedSegmentEnd(sql, i, ch, allowBackslash).end
      continue
    }
    if (ch === '$') {
      const tag = matchDollarQuoteTag(sql, i)
      if (tag !== null) {
        out += ' '
        const closeIdx = sql.indexOf(tag, i + tag.length)
        i = closeIdx >= 0 ? closeIdx + tag.length : len
        continue
      }
    }
    out += ch
    i++
  }

  return out
}

interface ParsedExplainInfo {
  hasAnalyze: boolean
  hasWriteOption: boolean
  remainder: string
}

function parseExplainOptions(afterExplain: string): ParsedExplainInfo {
  let rest = afterExplain.trimStart()
  let hasAnalyze = false
  let hasWriteOption = false

  while (rest.length > 0) {
    if (rest.startsWith('(')) {
      let depth = 0
      let closeIdx = -1
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '(') depth++
        else if (rest[i] === ')') {
          depth--
          if (depth === 0) {
            closeIdx = i
            break
          }
        }
      }
      if (closeIdx < 0) {
        hasWriteOption = true
        break
      }
      const groupContent = rest.slice(1, closeIdx)
      const analyzeMatch = /\bANALY[ZS]E\b(?:\s+(FALSE|OFF|0)\b)?/i.exec(groupContent)
      if (analyzeMatch && !analyzeMatch[1]) {
        hasAnalyze = true
      }
      if (/\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(groupContent)) {
        hasWriteOption = true
      }
      rest = rest.slice(closeIdx + 1).trimStart()
      continue
    }

    const analyzeOpt = /^ANALY[ZS]E\b/i.exec(rest)
    if (analyzeOpt) {
      hasAnalyze = true
      rest = rest.slice(analyzeOpt[0].length).trimStart()
      continue
    }

    const stdOpt =
      /^(?:VERBOSE|QUERY\s+PLAN|EXTENDED|PARTITIONS|DISTSQL|OPT|TYPES|VEC|AST|SYNTAX|PLAN|PIPELINE|ESTIMATE|TABLE\s+OVERRIDE|CURRENT\s+TRANSACTION|FOR\s+CONNECTION\s+\d+|FORMAT\s*=\s*[A-Za-z0-9_]+|FORMAT\s+[A-Za-z0-9_]+)\b/i.exec(
        rest
      )
    if (stdOpt) {
      rest = rest.slice(stdOpt[0].length).trimStart()
      continue
    }

    // ClickHouse EXPLAIN PLAN settings e.g. `header = 1, actions = 1`
    const chSettingOpt = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*[A-Za-z0-9_]+\s*,?/i.exec(rest)
    if (chSettingOpt) {
      rest = rest.slice(chSettingOpt[0].length).trimStart()
      continue
    }

    break
  }

  if (/\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(rest)) {
    hasWriteOption = true
  }

  return { hasAnalyze, hasWriteOption, remainder: rest }
}

/**
 * Checks whether an EXPLAIN statement enables ANALYZE/ANALYSE execution (US or British spelling,
 * bare or inside PostgreSQL parenthesized option lists).
 */
export function hasExplainAnalyzeOption(sql: string, dialect?: DatabaseDriverType): boolean {
  const clean = stripCommentsAndLiterals(sql, dialect, true).replace(/^[\s(]+/, '').trim()
  const firstMatch = /^EXPLAIN\b/i.exec(clean)
  if (!firstMatch) return false
  return parseExplainOptions(clean.slice(firstMatch[0].length)).hasAnalyze
}

/**
 * Checks whether the statement wrapped inside an EXPLAIN (or the statement itself if not prefixed
 * with EXPLAIN) is mutating, independent of whether ANALYZE was specified.
 */
export function isExplainTargetMutating(sql: string, dialect?: DatabaseDriverType): boolean {
  const clean = stripCommentsAndLiterals(sql, dialect, true).replace(/^[\s(]+/, '').trim()
  if (!clean) return false
  const firstMatch = /^EXPLAIN\b/i.exec(clean)
  if (!firstMatch) {
    return isCleanSingleStatementMutating(clean)
  }
  const parsed = parseExplainOptions(clean.slice(firstMatch[0].length))
  if (parsed.hasWriteOption) return true
  return isCleanSingleStatementMutating(parsed.remainder)
}

function isCleanSingleStatementMutating(rawClean: string): boolean {
  const clean = rawClean.replace(/^[\s(]+/, '').trim()
  if (!clean) return false

  const firstMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(clean)
  if (!firstMatch) return false

  const verb = firstMatch[1].toUpperCase()
  if (verb === 'SHOW' || verb === 'DESCRIBE' || verb === 'DESC') {
    return false
  }
  if (verb === 'SELECT') {
    return /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(clean)
  }
  if (verb === 'PRAGMA') {
    const upper = clean.toUpperCase()
    if (
      /\bWRITABLE_SCHEMA\b/.test(upper) ||
      /\bWAL_CHECKPOINT\b/.test(upper) ||
      /\bOPTIMIZE\b/.test(upper) ||
      clean.includes('=')
    ) {
      return true
    }
    const parenMatch =
      /^PRAGMA\s+(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/i.exec(clean)
    if (parenMatch) {
      return !SQLITE_READONLY_PARENS_PRAGMAS.has(parenMatch[1].toUpperCase())
    }
    return false
  }
  if (verb === 'EXPLAIN') {
    const parsed = parseExplainOptions(clean.slice(firstMatch[0].length))
    if (parsed.hasAnalyze || parsed.hasWriteOption) {
      return true
    }
    return isCleanSingleStatementMutating(parsed.remainder)
  }
  if (verb === 'WITH') {
    return SQL_CTE_MUTATING_REGEX.test(clean) || /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(clean)
  }
  return SQL_MUTATING_VERBS.has(verb)
}

function isSingleSqlStatementMutating(stmtText: string, dialect?: DatabaseDriverType): boolean {
  const stripped = stripCommentsAndLiterals(stmtText, dialect, true)
  const parts = stripped.includes(';') ? stripped.split(';') : [stripped]
  return parts.some((part) => isCleanSingleStatementMutating(part))
}

function isRedisCommandMutating(script: string): boolean {
  const lines = script.split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('--') || line.startsWith('//')) {
      continue
    }
    const tokens = line.split(/\s+/)
    const cmd = tokens[0].replace(/^["']|["']$/g, '').toUpperCase()
    const sub = (tokens[1] ?? '').replace(/^["']|["']$/g, '').toUpperCase()

    if (REDIS_WRITE_COMMANDS.has(cmd)) return true
    if (cmd === 'CONFIG') {
      if (sub !== 'GET') return true
      continue
    }
    if (cmd === 'CLIENT') {
      if (!new Set(['LIST', 'INFO', 'ID', 'GETNAME', 'GETREDIR']).has(sub)) return true
      continue
    }
    if (cmd === 'ACL') {
      if (!new Set(['LIST', 'WHOAMI', 'USERS', 'GETUSER', 'CAT']).has(sub)) return true
      continue
    }
    if (cmd === 'SCRIPT') {
      if (sub !== 'EXISTS') return true
      continue
    }
    if (!REDIS_READONLY_COMMANDS.has(cmd)) {
      return true
    }
  }
  return false
}

/**
 * Checks whether a SQL script or Redis command sequence can mutate state or schema,
 * supporting read-only enforcement on connections flagged `readOnly: true`.
 */
export function isMutatingStatement(sql: string, driver: DatabaseDriverType): boolean {
  if (!sql || !sql.trim()) return false
  if (driver === 'redis') {
    return isRedisCommandMutating(sql)
  }
  const statements = splitSqlStatements(sql, driver)
  if (statements.length === 0) {
    return isSingleSqlStatementMutating(sql, driver)
  }
  return statements.some((stmt) => isSingleSqlStatementMutating(stmt.text, driver))
}

const SQL_DDL_VERBS: ReadonlySet<string> = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'RENAME',
  'TRUNCATE',
  'VACUUM',
  'ATTACH',
  'DETACH',
])

/**
 * Detects whether a SQL script contains any DDL or schema-altering statement
 * (`CREATE`, `ALTER`, `DROP`, `RENAME`, `TRUNCATE`, `VACUUM`, `ATTACH`, `DETACH`),
 * ignoring comments and quoted string/identifier literals.
 */
export function containsDdlStatement(sql: string, dialect?: DatabaseDriverType): boolean {
  if (!sql || !sql.trim()) return false
  const statements = splitSqlStatements(sql, dialect)
  const list = statements.length > 0 ? statements.map((s) => s.text) : [sql]
  return list.some((stmtText) => {
    const stripped = stripCommentsAndLiterals(stmtText, dialect, true)
    const parts = stripped.includes(';') ? stripped.split(';') : [stripped]
    return parts.some((part) => {
      const clean = part.replace(/^[\s(]+/, '').trim()
      if (!clean) return false
      const firstMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(clean)
      if (!firstMatch) return false
      return SQL_DDL_VERBS.has(firstMatch[1].toUpperCase())
    })
  })
}

export type AlterTableAction =
  | {
      kind: 'addColumn'
      table: string
      schema?: string
      columnName: string
      dataType: string
      nullable?: boolean
      defaultValue?: string
    }
  | {
      kind: 'renameColumn'
      table: string
      schema?: string
      oldColumnName?: string
      newColumnName?: string
      oldName?: string
      newName?: string
    }
  | {
      kind: 'dropColumn'
      table: string
      schema?: string
      columnName: string
    }
  | {
      kind: 'renameTable'
      table: string
      schema?: string
      newTableName: string
    }
  | {
      kind: 'alterColumn'
      table: string
      schema?: string
      columnName: string
      dataType?: string
      nullable?: boolean
      defaultValue?: string | null
    }
  | {
      kind: 'addIndex'
      table: string
      schema?: string
      indexName?: string
      columns: string[]
      unique?: boolean
    }
  | {
      kind: 'dropIndex'
      table: string
      schema?: string
      indexName: string
    }
  | {
      kind: 'addForeignKey'
      table: string
      schema?: string
      constraintName?: string
      column: string
      foreignTable: string
      foreignSchema?: string
      foreignColumn: string
      onDelete?: ReferentialAction
      onUpdate?: ReferentialAction
    }
  | {
      kind: 'dropForeignKey'
      table: string
      schema?: string
      constraintName: string
    }

export type ReferentialAction = 'NO ACTION' | 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'SET DEFAULT'

export interface DraftColumnItem {
  id: string
  originalName?: string
  name: string
  dataType: string
  nullable: boolean
  defaultValue: string
  isPrimaryKey: boolean
  isAutoIncrement?: boolean
  isGenerated?: boolean
  status: 'existing' | 'new' | 'deleted'
  originalDataType?: string
  originalNullable?: boolean
  originalDefaultValue?: string
  originalIsPrimaryKey?: boolean
}

export interface DraftIndexItem {
  id: string
  originalName?: string
  name: string
  columns: string[]
  unique: boolean
  isPrimary?: boolean
  status: 'existing' | 'new' | 'deleted'
}

export interface DraftForeignKeyItem {
  id: string
  constraintName?: string
  column: string
  foreignTable: string
  foreignSchema?: string
  foreignColumn: string
  onDelete: ReferentialAction
  onUpdate: ReferentialAction
  status: 'existing' | 'new' | 'deleted'
}

export interface TableStructureDraft {
  originalTableName: string
  tableName: string
  schema?: string
  columns: DraftColumnItem[]
  indexes: DraftIndexItem[]
  foreignKeys: DraftForeignKeyItem[]
}

export interface TableMigrationPlan {
  valid: boolean
  errors: string[]
  warnings: string[]
  changeSummaries: string[]
  statements: string[]
  isRebuild: boolean
}

const VALID_REFERENTIAL_ACTIONS: ReadonlySet<ReferentialAction> = new Set([
  'NO ACTION',
  'CASCADE',
  'SET NULL',
  'RESTRICT',
  'SET DEFAULT',
])

const KNOWN_SQL_DEFAULT_KEYWORDS =
  /^(?:CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|LOCALTIME|LOCALTIMESTAMP|NOW\(\)|UUID\(\)|GEN_RANDOM_UUID\(\)|UUID_GENERATE_V1\(\)|UUID_GENERATE_V4\(\)|NEWID\(\)|UNIXEPOCH\(\)|NEXTVAL\([^;]+\)|CURRVAL\([^;]+\)|ARRAY\[[^;]*\]|DATETIME\([^;]+\)|DATE\([^;]+\)|TIME\([^;]+\)|STRFTIME\([^;]+\)|COALESCE\([^;]+\)|RANDOMBLOB\([^;]+\)|HEX\([^;]+\))$/i

const FORBIDDEN_DEFAULT_TOKENS = /[;\r\n\0]|--|\/\*|\*\//
const FORBIDDEN_SUBQUERY_VERBS =
  /\b(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|UNION|EXEC)\b/i

function findTopLevelPostgresCastIndex(input: string): number {
  let depth = 0
  let inSingle = false
  let inDouble = false
  let lastCastIdx = -1
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === "'" && !inDouble) {
      if (inSingle && input[i + 1] === "'") {
        i++
        continue
      }
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      if (inDouble && input[i + 1] === '"') {
        i++
        continue
      }
      inDouble = !inDouble
      continue
    }
    if (inSingle || inDouble) continue
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') {
      if (depth > 0) depth--
    } else if (depth === 0 && ch === ':' && input[i + 1] === ':') {
      lastCastIdx = i
      i++
    }
  }
  return lastCastIdx
}

function hasBalancedParens(input: string, singleOuterGroupOnly = false): boolean {
  let depth = 0
  let inSingle = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === "'") {
      if (inSingle && input[i + 1] === "'") {
        i++
        continue
      }
      inSingle = !inSingle
      continue
    }
    if (inSingle) continue
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth < 0) return false
      if (singleOuterGroupOnly && depth === 0 && i < input.length - 1) {
        return false
      }
    }
  }
  return !inSingle && depth === 0
}

function isPureSqlStringLiteral(val: string): boolean {
  return /^'(?:[^']|'')*'$/.test(val)
}

function isNumericOrBooleanTypeName(dataType: string): boolean {
  return /^(?:INT|BIGINT|SMALLINT|TINYINT|MEDIUMINT|SERIAL|BIGSERIAL|REAL|FLOAT|DOUBLE|DEC|NUMERIC|BOOL|BIT)/i.test(
    (dataType || '').trim()
  )
}

export function normalizeSqlDefaultExpression(rawDefault: string, dataType = 'TEXT'): string {
  const trimmed = (rawDefault ?? '').trim()
  if (!trimmed) return ''

  if (FORBIDDEN_DEFAULT_TOKENS.test(trimmed)) {
    throw new Error('Default value contains invalid SQL tokens (semicolons or comments).')
  }

  // Exact single SQL string literal ('...') without concatenated subqueries
  if (isPureSqlStringLiteral(trimmed)) {
    if (isNumericOrBooleanTypeName(dataType)) {
      const inner = trimmed.slice(1, -1).replace(/''/g, "'").trim()
      if (
        !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(inner) &&
        !/^(?:TRUE|FALSE)$/i.test(inner)
      ) {
        throw new Error(`Invalid default ${trimmed} for numeric/boolean type "${dataType}".`)
      }
    }
    return trimmed
  }

  // Single outer parenthesized default expression e.g. (datetime('now')) or (0), rejecting (1) OR (1=1)
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    if (!hasBalancedParens(trimmed, true)) {
      throw new Error(`Invalid parenthesized default expression: ${trimmed}`)
    }
    if (FORBIDDEN_SUBQUERY_VERBS.test(trimmed)) {
      throw new Error(`Default expression cannot contain SQL queries or DDL/DML statements.`)
    }
    return trimmed
  }

  // Hex literal X'deadbeef'
  if (/^X'[0-9A-Fa-f]*'$/i.test(trimmed)) {
    return trimmed
  }

  // Top-level PostgreSQL cast literal e.g. '{}'::jsonb or ('now'::text)::timestamp with time zone
  const castIdx = findTopLevelPostgresCastIndex(trimmed)
  if (castIdx > 0) {
    const lhs = trimmed.slice(0, castIdx).trim()
    const rhs = trimmed.slice(castIdx + 2).trim()
    const cleanRhs = validateColumnTypeSpec(rhs)
    const safeLhs = normalizeSqlDefaultExpression(lhs, cleanRhs)
    return `${safeLhs}::${cleanRhs}`
  }

  // NULL, booleans, numeric literals, and safe SQL sequence/timestamp/UUID functions (checked before quote rules)
  if (
    /^NULL$/i.test(trimmed) ||
    /^(?:TRUE|FALSE)$/i.test(trimmed) ||
    /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)
  ) {
    return trimmed
  }

  if (KNOWN_SQL_DEFAULT_KEYWORDS.test(trimmed)) {
    if (!hasBalancedParens(trimmed) || FORBIDDEN_SUBQUERY_VERBS.test(trimmed)) {
      throw new Error(`Invalid SQL default function expression: ${trimmed}`)
    }
    return trimmed
  }

  // Double-quoted literal -> single-quoted SQL string literal (reject on strict numeric types)
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    if (isNumericOrBooleanTypeName(dataType)) {
      throw new Error(`Numeric/boolean column cannot use string default ${trimmed}.`)
    }
    const inner = trimmed.slice(1, -1).replace(/'/g, "''")
    return `'${inner}'`
  }

  // Unquoted SQL comments via '#' or multi-token SQL injection (e.g. 'a' OR '1'='1')
  if (trimmed.includes('#') || trimmed.includes("'")) {
    if (/^'(?:[^']|'')*'$/.test(`'${trimmed.replace(/'/g, "''")}'`) && !trimmed.startsWith("'") && !isNumericOrBooleanTypeName(dataType) && !/\b(?:OR|AND|SELECT|UNION)\b/i.test(trimmed)) {
      return `'${trimmed.replace(/'/g, "''")}'`
    }
    throw new Error(`Invalid SQL default expression: ${trimmed}`)
  }

  // Numeric & boolean columns must NOT silently accept arbitrary non-numeric strings as quoted text
  if (isNumericOrBooleanTypeName(dataType)) {
    throw new Error(`Invalid default "${trimmed}" for numeric/boolean type "${dataType}".`)
  }

  if (FORBIDDEN_SUBQUERY_VERBS.test(trimmed)) {
    throw new Error(`Invalid SQL keyword in default expression: ${trimmed}`)
  }

  return `'${trimmed.replace(/'/g, "''")}'`
}

function validateColumnTypeSpec(rawType: string): string {
  const cleaned = (rawType || '').trim()
  if (!cleaned) {
    throw new Error('Column data type is required.')
  }
  const isMysqlEnumOrSet =
    /^(?:ENUM|SET)\s*\(\s*'(?:[^']|'')*'(?:\s*,\s*'(?:[^']|'')*')*\s*\)$/i.test(cleaned)
  if (isMysqlEnumOrSet) {
    if (FORBIDDEN_DEFAULT_TOKENS.test(cleaned)) {
      throw new Error(`Invalid SQL column type: ${rawType}`)
    }
    return cleaned
  }
  if (!/^[A-Za-z][A-Za-z0-9_(),\s[\]]*$/.test(cleaned) || !hasBalancedParens(cleaned)) {
    throw new Error(`Invalid SQL column type: ${rawType}`)
  }
  if (FORBIDDEN_SUBQUERY_VERBS.test(cleaned)) {
    throw new Error(`Invalid SQL keyword in column type: ${rawType}`)
  }
  return cleaned
}

function sanitizeReferentialAction(action?: string): ReferentialAction {
  const upper = (action || 'NO ACTION').trim().toUpperCase() as ReferentialAction
  if (VALID_REFERENTIAL_ACTIONS.has(upper)) {
    return upper
  }
  return 'NO ACTION'
}

function qualifyAlterTarget(
  table: string,
  schema: string | undefined,
  dialect: DatabaseDriverType
): string {
  const quotedTable = quoteIdentForDialect(table.trim(), dialect)
  if (
    schema &&
    schema.trim().length > 0 &&
    !((dialect === 'sqlite' || dialect === 'libsql') && schema === 'main') &&
    schema !== 'public' &&
    dialect !== 'redis'
  ) {
    return `${quoteIdentForDialect(schema.trim(), dialect)}.${quotedTable}`
  }
  return quotedTable
}

export function buildAlterTableSql(
  action: AlterTableAction,
  dialect: DatabaseDriverType = 'sqlite'
): string {
  if (dialect === 'redis') {
    throw new Error('ALTER TABLE is not supported on Redis keyspaces.')
  }
  const tableName = (action.table || '').trim()
  if (!tableName) {
    throw new Error('Table name is required for ALTER TABLE.')
  }
  const qualifiedTable = qualifyAlterTarget(tableName, action.schema, dialect)

  switch (action.kind) {
    case 'addColumn': {
      const colName = (action.columnName || '').trim()
      if (!colName) {
        throw new Error('Column name is required to add a column.')
      }
      const rawType = validateColumnTypeSpec(action.dataType || 'TEXT')
      const quotedCol = quoteIdentForDialect(colName, dialect)
      const isNullable = action.nullable !== false
      const rawDef = (action.defaultValue ?? '').trim()
      let defaultClause = ''
      if (rawDef.length > 0) {
        const normalizedDef = normalizeSqlDefaultExpression(rawDef, rawType)
        defaultClause = ` DEFAULT ${normalizedDef}`
      } else if (!isNullable && (dialect === 'sqlite' || dialect === 'libsql')) {
        // SQLite requires a DEFAULT value when adding a NOT NULL column to an existing table
        defaultClause = /INT|REAL|FLOAT|NUMERIC|DECIMAL|BOOL/i.test(rawType)
          ? ' DEFAULT 0'
          : " DEFAULT ''"
      }
      const nullClause = isNullable ? '' : ' NOT NULL'
      return `ALTER TABLE ${qualifiedTable} ADD COLUMN ${quotedCol} ${rawType}${nullClause}${defaultClause};`
    }
    case 'renameColumn': {
      const oldCol = (action.oldColumnName || action.oldName || '').trim()
      const newCol = (action.newColumnName || action.newName || '').trim()
      if (!oldCol || !newCol) {
        throw new Error('Both current and new column names are required.')
      }
      if (oldCol === newCol) {
        throw new Error('New column name must be different from the current column name.')
      }
      return `ALTER TABLE ${qualifiedTable} RENAME COLUMN ${quoteIdentForDialect(oldCol, dialect)} TO ${quoteIdentForDialect(newCol, dialect)};`
    }
    case 'dropColumn': {
      const colName = (action.columnName || '').trim()
      if (!colName) {
        throw new Error('Column name is required to drop a column.')
      }
      return `ALTER TABLE ${qualifiedTable} DROP COLUMN ${quoteIdentForDialect(colName, dialect)};`
    }
    case 'renameTable': {
      const newTbl = (action.newTableName || '').trim()
      if (!newTbl) {
        throw new Error('New table name is required.')
      }
      if (newTbl === tableName) {
        throw new Error('New table name must be different from the current table name.')
      }
      if (dialect === 'mysql' || dialect === 'mariadb' || dialect === 'clickhouse') {
        const qualifiedNew = qualifyAlterTarget(newTbl, action.schema, dialect)
        return `RENAME TABLE ${qualifiedTable} TO ${qualifiedNew};`
      }
      return `ALTER TABLE ${qualifiedTable} RENAME TO ${quoteIdentForDialect(newTbl, dialect)};`
    }
    case 'alterColumn': {
      const colName = (action.columnName || '').trim()
      if (!colName) {
        throw new Error('Column name is required to alter a column.')
      }
      const quotedCol = quoteIdentForDialect(colName, dialect)
      const rawType = action.dataType ? validateColumnTypeSpec(action.dataType) : undefined
      const hasDefaultChange = action.defaultValue !== undefined
      const rawDef = (action.defaultValue ?? '').trim()

      if (dialect === 'postgres' || dialect === 'cockroachdb') {
        const clauses: string[] = []
        if (rawType) {
          clauses.push(`ALTER COLUMN ${quotedCol} TYPE ${rawType}`)
        }
        if (action.nullable !== undefined) {
          clauses.push(`ALTER COLUMN ${quotedCol} ${action.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`)
        }
        if (hasDefaultChange) {
          if (rawDef.length > 0) {
            clauses.push(
              `ALTER COLUMN ${quotedCol} SET DEFAULT ${normalizeSqlDefaultExpression(rawDef, rawType || 'TEXT')}`
            )
          } else {
            clauses.push(`ALTER COLUMN ${quotedCol} DROP DEFAULT`)
          }
        }
        if (clauses.length === 0) {
          throw new Error('No column modifications specified.')
        }
        return `ALTER TABLE ${qualifiedTable} ${clauses.join(', ')};`
      }

      if (dialect === 'mysql' || dialect === 'mariadb') {
        const effectiveType = rawType || 'VARCHAR(255)'
        const nullClause = action.nullable === false ? ' NOT NULL' : ' NULL'
        const defClause =
          rawDef.length > 0
            ? ` DEFAULT ${normalizeSqlDefaultExpression(rawDef, effectiveType)}`
            : action.nullable !== false
              ? ' DEFAULT NULL'
              : ''
        return `ALTER TABLE ${qualifiedTable} MODIFY COLUMN ${quotedCol} ${effectiveType}${nullClause}${defClause};`
      }

      if (dialect === 'clickhouse') {
        const effectiveType = rawType || 'String'
        const defClause =
          rawDef.length > 0 ? ` DEFAULT ${normalizeSqlDefaultExpression(rawDef, effectiveType)}` : ''
        return `ALTER TABLE ${qualifiedTable} MODIFY COLUMN ${quotedCol} ${effectiveType}${defClause};`
      }

      throw new Error(
        'Direct ALTER COLUMN is not supported by SQLite syntax; use buildTableMigrationSql for atomic table rebuild.'
      )
    }
    case 'addIndex': {
      const cols = (action.columns || []).map((c) => c.trim()).filter(Boolean)
      if (cols.length === 0) {
        throw new Error('At least one column is required to create an index.')
      }
      const rawIndexName =
        (action.indexName || '').trim() ||
        `idx_${tableName}_${cols.join('_')}`.replace(/[^A-Za-z0-9_]/g, '_')
      const quotedIdx = quoteIdentForDialect(rawIndexName, dialect)
      const quotedCols = cols.map((c) => quoteIdentForDialect(c, dialect)).join(', ')
      const uniqueKw = action.unique ? 'UNIQUE ' : ''
      if (dialect === 'clickhouse') {
        return `ALTER TABLE ${qualifiedTable} ADD INDEX ${quotedIdx} (${quotedCols}) TYPE minmax GRANULARITY 1;`
      }
      return `CREATE ${uniqueKw}INDEX ${quotedIdx} ON ${qualifiedTable} (${quotedCols});`
    }
    case 'dropIndex': {
      const idxName = (action.indexName || '').trim()
      if (!idxName) {
        throw new Error('Index name is required to drop an index.')
      }
      const quotedIdx = quoteIdentForDialect(idxName, dialect)
      if (dialect === 'mysql' || dialect === 'mariadb') {
        return `DROP INDEX ${quotedIdx} ON ${qualifiedTable};`
      }
      if (dialect === 'clickhouse') {
        return `ALTER TABLE ${qualifiedTable} DROP INDEX ${quotedIdx};`
      }
      if (
        dialect === 'postgres' ||
        dialect === 'cockroachdb' ||
        dialect === 'sqlite' ||
        dialect === 'libsql'
      ) {
        const qualifiedIdx = qualifyAlterTarget(idxName, action.schema, dialect)
        return `DROP INDEX ${qualifiedIdx};`
      }
      return `DROP INDEX ${quotedIdx};`
    }
    case 'addForeignKey': {
      const col = (action.column || '').trim()
      const refTable = (action.foreignTable || '').trim()
      const refCol = (action.foreignColumn || '').trim()
      if (!col || !refTable || !refCol) {
        throw new Error('Local column, target table, and target column are required for a foreign key.')
      }
      const fkName =
        (action.constraintName || '').trim() ||
        `fk_${tableName}_${col}_${refTable}`.replace(/[^A-Za-z0-9_]/g, '_')
      const onDelete = sanitizeReferentialAction(action.onDelete)
      const onUpdate = sanitizeReferentialAction(action.onUpdate)
      const qualifiedRef = qualifyAlterTarget(refTable, action.foreignSchema || action.schema, dialect)
      const onDeleteClause = onDelete !== 'NO ACTION' ? ` ON DELETE ${onDelete}` : ''
      const onUpdateClause = onUpdate !== 'NO ACTION' ? ` ON UPDATE ${onUpdate}` : ''
      return `ALTER TABLE ${qualifiedTable} ADD CONSTRAINT ${quoteIdentForDialect(fkName, dialect)} FOREIGN KEY (${quoteIdentForDialect(col, dialect)}) REFERENCES ${qualifiedRef} (${quoteIdentForDialect(refCol, dialect)})${onDeleteClause}${onUpdateClause};`
    }
    case 'dropForeignKey': {
      const fkName = (action.constraintName || '').trim()
      if (!fkName) {
        throw new Error('Constraint name is required to drop a foreign key.')
      }
      const quotedFk = quoteIdentForDialect(fkName, dialect)
      if (dialect === 'mysql' || dialect === 'mariadb') {
        return `ALTER TABLE ${qualifiedTable} DROP FOREIGN KEY ${quotedFk};`
      }
      return `ALTER TABLE ${qualifiedTable} DROP CONSTRAINT ${quotedFk};`
    }
  }
}

export function createInitialTableDraft(details: TableDetails): TableStructureDraft {
  const pkSet = new Set(details.primaryKey || [])
  const columns: DraftColumnItem[] = (details.columns || []).map((col: ColumnInfo, idx: number) => {
    const defVal = col.defaultValue !== undefined && col.defaultValue !== null ? String(col.defaultValue) : ''
    const resolvedType = resolveColumnTypeForDisplay(col)
    const isPk = Boolean(col.isPrimaryKey || pkSet.has(col.name))
    return {
      id: `col_${idx}_${col.name}`,
      originalName: col.name,
      name: col.name,
      dataType: resolvedType,
      nullable: col.nullable !== false,
      defaultValue: defVal,
      isPrimaryKey: isPk,
      isAutoIncrement: Boolean(col.isAutoIncrement),
      ...(col.isGenerated ? { isGenerated: true } : {}),
      status: 'existing',
      originalDataType: resolvedType,
      originalNullable: col.nullable !== false,
      originalDefaultValue: defVal,
      originalIsPrimaryKey: isPk,
    }
  })

  const indexes: DraftIndexItem[] = (details.indexes || []).map((idxInfo: IndexInfo, idx: number) => ({
    id: `idx_${idx}_${idxInfo.name}`,
    originalName: idxInfo.name,
    name: idxInfo.name,
    columns: [...(idxInfo.columns || [])],
    unique: Boolean(idxInfo.isUnique),
    isPrimary: Boolean(idxInfo.isPrimary),
    status: 'existing',
  }))

  const foreignKeys: DraftForeignKeyItem[] = (details.foreignKeys || []).map(
    (fk: ForeignKeyInfo, idx: number) => {
      const refTable = fk.referencedTable || ''
      const refCol = fk.referencedColumn || 'id'
      return {
        id: `fk_${idx}_${fk.column}_${refTable}`,
        constraintName: fk.constraintName || `fk_${details.name}_${fk.column}`,
        column: fk.column,
        foreignTable: refTable,
        foreignColumn: refCol,
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
        status: 'existing',
      }
    }
  )

  return {
    originalTableName: details.name,
    tableName: details.name,
    schema: details.schema,
    columns,
    indexes,
    foreignKeys,
  }
}

export function isDraftColumnDirty(col: DraftColumnItem): boolean {
  if (col.status !== 'existing') return true
  const origName = (col.originalName ?? '').trim()
  const curName = (col.name ?? '').trim()
  const origType = (col.originalDataType ?? 'TEXT').trim().toUpperCase()
  const curType = (col.dataType ?? 'TEXT').trim().toUpperCase()
  const origDef = (col.originalDefaultValue ?? '').trim()
  const curDef = (col.defaultValue ?? '').trim()
  let isDefEqual = origDef === curDef
  if (!isDefEqual && curDef.length > 0) {
    try {
      isDefEqual = normalizeSqlDefaultExpression(curDef, curType) === origDef
    } catch {
      isDefEqual = false
    }
  }
  return (
    origName !== curName ||
    origType !== curType ||
    Boolean(col.originalNullable) !== Boolean(col.nullable) ||
    Boolean(col.originalIsPrimaryKey) !== Boolean(col.isPrimaryKey) ||
    !isDefEqual
  )
}

export function requiresSqliteTableRebuild(draft: TableStructureDraft): boolean {
  const hasColumnDefinitionChange = draft.columns.some((col) => {
    if (col.status !== 'existing') return false
    const origType = (col.originalDataType ?? 'TEXT').trim().toUpperCase()
    const curType = (col.dataType ?? 'TEXT').trim().toUpperCase()
    const origDef = (col.originalDefaultValue ?? '').trim()
    const curDef = (col.defaultValue ?? '').trim()
    let isDefEqual = origDef === curDef
    if (!isDefEqual && curDef.length > 0) {
      try {
        isDefEqual = normalizeSqlDefaultExpression(curDef, curType) === origDef
      } catch {
        isDefEqual = false
      }
    }
    return (
      origType !== curType ||
      Boolean(col.originalNullable) !== Boolean(col.nullable) ||
      Boolean(col.originalIsPrimaryKey) !== Boolean(col.isPrimaryKey) ||
      !isDefEqual
    )
  })
  const hasNewPkColumn = draft.columns.some((col) => col.status === 'new' && col.isPrimaryKey)
  const droppedColNames = new Set(
    draft.columns
      .filter((col) => col.status === 'deleted')
      .map((col) => (col.originalName || col.name).trim())
      .filter(Boolean)
  )
  const hasDroppedPkColumn = draft.columns.some(
    (col) => col.status === 'deleted' && col.originalIsPrimaryKey
  )
  const hasDroppedColInSurvivingIndex = draft.indexes.some(
    (idx) => idx.status !== 'deleted' && (idx.columns || []).some((c) => droppedColNames.has(c))
  )
  const hasFkChanges = draft.foreignKeys.some((fk) => fk.status === 'new' || fk.status === 'deleted')
  return (
    hasColumnDefinitionChange ||
    hasNewPkColumn ||
    hasDroppedPkColumn ||
    hasDroppedColInSurvivingIndex ||
    hasFkChanges
  )
}

export function countTableStructureChanges(draft: TableStructureDraft): number {
  let count = 0
  if (draft.tableName.trim() && draft.tableName.trim() !== draft.originalTableName.trim()) {
    count += 1
  }
  for (const col of draft.columns) {
    if (col.status === 'new' || col.status === 'deleted' || isDraftColumnDirty(col)) {
      count += 1
    }
  }
  for (const idx of draft.indexes) {
    if (idx.status === 'new' || idx.status === 'deleted') {
      count += 1
    }
  }
  for (const fk of draft.foreignKeys) {
    if (fk.status === 'new' || fk.status === 'deleted') {
      count += 1
    }
  }
  return count
}

function buildSqliteTableRebuildStatements(
  draft: TableStructureDraft,
  dialect: 'sqlite' | 'libsql'
): string[] {
  const origTable = draft.originalTableName.trim()
  const finalTable = (draft.tableName || origTable).trim()
  if (!origTable || !finalTable) {
    throw new Error('Table name is required for table migration.')
  }

  const activeCols = draft.columns.filter((c) => c.status !== 'deleted')
  if (activeCols.length === 0) {
    throw new Error('Table must have at least one active column.')
  }

  const seenNames = new Set<string>()
  for (const col of activeCols) {
    const cleanName = col.name.trim()
    if (!cleanName) {
      throw new Error('Every column must have a valid non-empty name.')
    }
    const lower = cleanName.toLowerCase()
    if (seenNames.has(lower)) {
      throw new Error(`Duplicate column name "${cleanName}".`)
    }
    seenNames.add(lower)
  }

  const pkCols = activeCols.filter((c) => c.isPrimaryKey)
  const singleInlinePk = pkCols.length === 1
  const colDefs: string[] = []

  for (const col of activeCols) {
    const quotedCol = quoteIdentForDialect(col.name.trim(), dialect)
    const cleanType = validateColumnTypeSpec(col.dataType || 'TEXT')
    let def = `${quotedCol} ${cleanType}`
    if (singleInlinePk && col.isPrimaryKey) {
      def += ' PRIMARY KEY'
      if (col.isAutoIncrement && /INT/i.test(cleanType)) {
        def += ' AUTOINCREMENT'
      }
    }
    if (!col.nullable && !(singleInlinePk && col.isPrimaryKey)) {
      def += ' NOT NULL'
    }
    const rawDef = (col.defaultValue ?? '').trim()
    if (rawDef.length > 0) {
      def += ` DEFAULT ${normalizeSqlDefaultExpression(rawDef, cleanType)}`
    }
    colDefs.push(def)
  }

  if (pkCols.length > 1) {
    const pkList = pkCols.map((c) => quoteIdentForDialect(c.name.trim(), dialect)).join(', ')
    colDefs.push(`PRIMARY KEY (${pkList})`)
  }

  const activeFks = draft.foreignKeys.filter((fk) => fk.status !== 'deleted')
  for (const fk of activeFks) {
    const col = fk.column.trim()
    const refTable = fk.foreignTable.trim()
    const refCol = fk.foreignColumn.trim()
    if (!col || !refTable || !refCol) {
      throw new Error('Foreign key requires local column, target table, and target column.')
    }
    const fkName =
      (fk.constraintName || '').trim() ||
      `fk_${finalTable}_${col}_${refTable}`.replace(/[^A-Za-z0-9_]/g, '_')
    const onDelete = sanitizeReferentialAction(fk.onDelete)
    const onUpdate = sanitizeReferentialAction(fk.onUpdate)
    const onDeleteClause = onDelete !== 'NO ACTION' ? ` ON DELETE ${onDelete}` : ''
    const onUpdateClause = onUpdate !== 'NO ACTION' ? ` ON UPDATE ${onUpdate}` : ''
    colDefs.push(
      `CONSTRAINT ${quoteIdentForDialect(fkName, dialect)} FOREIGN KEY (${quoteIdentForDialect(col, dialect)}) REFERENCES ${quoteIdentForDialect(refTable, dialect)} (${quoteIdentForDialect(refCol, dialect)})${onDeleteClause}${onUpdateClause}`
    )
  }

  const tempTableName = `__datanoa_new_${origTable.replace(/[^A-Za-z0-9_]/g, '_')}`
  const qualifiedOrig = qualifyAlterTarget(origTable, draft.schema, dialect)
  const qualifiedTemp = qualifyAlterTarget(tempTableName, draft.schema, dialect)
  const quotedFinal = quoteIdentForDialect(finalTable, dialect)

  const stmts: string[] = [
    'PRAGMA foreign_keys = OFF;',
    'BEGIN IMMEDIATE;',
    `CREATE TABLE ${qualifiedTemp} (\n  ${colDefs.join(',\n  ')}\n);`,
  ]

  // Map surviving existing non-generated columns from old table to new table
  const survivingCols = activeCols.filter(
    (c) => c.status === 'existing' && Boolean(c.originalName) && !c.isGenerated
  )
  if (survivingCols.length > 0) {
    const targetColList = survivingCols
      .map((c) => quoteIdentForDialect(c.name.trim(), dialect))
      .join(', ')
    const sourceExprList = survivingCols
      .map((c) => {
        const prevColName = (c.originalName ?? c.name).trim()
        const quotedOld = quoteIdentForDialect(prevColName, dialect)
        const rawDef = (c.defaultValue ?? '').trim()
        // If column became NOT NULL and has a default value, coalesce existing NULLs
        if (!c.nullable && c.originalNullable && rawDef.length > 0) {
          const normDef = normalizeSqlDefaultExpression(rawDef, c.dataType || 'TEXT')
          return `COALESCE(${quotedOld}, ${normDef}) AS ${quoteIdentForDialect(c.name.trim(), dialect)}`
        }
        return quotedOld
      })
      .join(', ')
    stmts.push(
      `INSERT INTO ${qualifiedTemp} (${targetColList}) SELECT ${sourceExprList} FROM ${qualifiedOrig};`
    )
  }

  stmts.push(`DROP TABLE ${qualifiedOrig};`)
  stmts.push(`ALTER TABLE ${qualifiedTemp} RENAME TO ${quotedFinal};`)

  // Recreate surviving & new user indexes on the rebuilt table
  const colRenameMap = new Map<string, string>()
  for (const col of activeCols) {
    if (col.originalName) {
      colRenameMap.set(col.originalName, col.name.trim())
    }
    colRenameMap.set(col.name.trim(), col.name.trim())
  }

  const qualifiedFinal = qualifyAlterTarget(finalTable, draft.schema, dialect)
  const activeIndexes = draft.indexes.filter(
    (idx) =>
      idx.status !== 'deleted' &&
      !idx.isPrimary &&
      !/^sqlite_autoindex_/i.test(idx.name)
  )

  for (const idx of activeIndexes) {
    const mappedCols = (idx.columns || [])
      .map((c) => colRenameMap.get(c) || (seenNames.has(c.toLowerCase()) ? c : ''))
      .filter(Boolean)
    if (mappedCols.length === 0) continue
    const idxName =
      (idx.name || '').trim() ||
      `idx_${finalTable}_${mappedCols.join('_')}`.replace(/[^A-Za-z0-9_]/g, '_')
    const uniqueKw = idx.unique ? 'UNIQUE ' : ''
    const quotedCols = mappedCols.map((c) => quoteIdentForDialect(c, dialect)).join(', ')
    stmts.push(
      `CREATE ${uniqueKw}INDEX IF NOT EXISTS ${quoteIdentForDialect(idxName, dialect)} ON ${qualifiedFinal} (${quotedCols});`
    )
  }

  stmts.push('COMMIT;')
  stmts.push('PRAGMA foreign_keys = ON;')
  return stmts
}

export function buildTableMigrationSql(
  draft: TableStructureDraft,
  dialect: DatabaseDriverType = 'sqlite'
): string[] {
  if (dialect === 'redis') {
    throw new Error('Table schema migration is not supported on Redis keyspaces.')
  }

  const origTable = (draft.originalTableName || '').trim()
  const finalTable = (draft.tableName || origTable).trim()
  if (!origTable || !finalTable) {
    throw new Error('Table name is required.')
  }

  if (countTableStructureChanges(draft) === 0) {
    return []
  }

  // Enforce unique non-empty column names across ALL active columns in ALL dialects
  const activeCols = draft.columns.filter((c) => c.status !== 'deleted')
  if (activeCols.length === 0) {
    throw new Error('Table must keep at least one active column.')
  }
  const seenColNames = new Set<string>()
  for (const col of activeCols) {
    const cleanName = (col.name || '').trim()
    if (!cleanName) {
      throw new Error('Every column must have a non-empty name.')
    }
    const lower = cleanName.toLowerCase()
    if (seenColNames.has(lower)) {
      throw new Error(`Duplicate column name "${cleanName}".`)
    }
    seenColNames.add(lower)
  }

  // Check if SQLite/LibSQL requires full 12-step atomic rebuild
  if ((dialect === 'sqlite' || dialect === 'libsql') && requiresSqliteTableRebuild(draft)) {
    return buildSqliteTableRebuildStatements(draft, dialect)
  }

  const stmts: string[] = []
  let workingTable = origTable

  // 1. Drop removed Foreign Keys
  for (const fk of draft.foreignKeys) {
    if (fk.status === 'deleted' && fk.constraintName) {
      stmts.push(
        buildAlterTableSql(
          {
            kind: 'dropForeignKey',
            table: workingTable,
            schema: draft.schema,
            constraintName: fk.constraintName,
          },
          dialect
        )
      )
    }
  }

  // 2. Drop removed Indexes
  for (const idx of draft.indexes) {
    if (idx.status === 'deleted' && (idx.originalName || idx.name)) {
      stmts.push(
        buildAlterTableSql(
          {
            kind: 'dropIndex',
            table: workingTable,
            schema: draft.schema,
            indexName: idx.originalName || idx.name,
          },
          dialect
        )
      )
    }
  }

  // 3. Drop removed Columns
  for (const col of draft.columns) {
    if (col.status === 'deleted' && (col.originalName || col.name)) {
      stmts.push(
        buildAlterTableSql(
          {
            kind: 'dropColumn',
            table: workingTable,
            schema: draft.schema,
            columnName: col.originalName || col.name,
          },
          dialect
        )
      )
    }
  }

  // 4. Rename & Alter Existing Columns
  let pkMembershipChanged = false
  for (const col of draft.columns) {
    if (col.status === 'new' && col.isPrimaryKey) pkMembershipChanged = true
    if (col.status === 'deleted' && col.originalIsPrimaryKey) pkMembershipChanged = true
    if (col.status === 'existing' && Boolean(col.isPrimaryKey) !== Boolean(col.originalIsPrimaryKey)) {
      pkMembershipChanged = true
    }
    if (col.status !== 'existing') continue
    const oldName = (col.originalName || col.name).trim()
    const newName = col.name.trim()
    if (!newName) {
      throw new Error('Column name cannot be empty.')
    }
    if (oldName !== newName) {
      stmts.push(
        buildAlterTableSql(
          {
            kind: 'renameColumn',
            table: workingTable,
            schema: draft.schema,
            oldColumnName: oldName,
            newColumnName: newName,
          },
          dialect
        )
      )
    }

    const origType = (col.originalDataType ?? 'TEXT').trim().toUpperCase()
    const curType = validateColumnTypeSpec(col.dataType || 'TEXT').toUpperCase()
    const origDef = (col.originalDefaultValue ?? '').trim()
    const curDef = (col.defaultValue ?? '').trim()
    const isDefEqual =
      origDef === curDef ||
      (curDef.length > 0 && normalizeSqlDefaultExpression(curDef, curType) === origDef)
    const typeChanged = origType !== curType
    const nullChanged = Boolean(col.originalNullable) !== Boolean(col.nullable)
    const defChanged = !isDefEqual

    if (typeChanged || nullChanged || defChanged) {
      const isMysqlFamily = dialect === 'mysql' || dialect === 'mariadb' || dialect === 'clickhouse'
      stmts.push(
        buildAlterTableSql(
          {
            kind: 'alterColumn',
            table: workingTable,
            schema: draft.schema,
            columnName: newName,
            dataType: typeChanged || isMysqlFamily ? col.dataType.trim() : undefined,
            nullable: nullChanged || isMysqlFamily ? col.nullable : undefined,
            defaultValue: defChanged || isMysqlFamily ? curDef : undefined,
          },
          dialect
        )
      )
    }
  }

  // 5. Add New Columns
  for (const col of draft.columns) {
    if (col.status === 'new') {
      stmts.push(
        buildAlterTableSql(
          {
            kind: 'addColumn',
            table: workingTable,
            schema: draft.schema,
            columnName: col.name.trim(),
            dataType: validateColumnTypeSpec(col.dataType || 'TEXT'),
            nullable: col.nullable,
            defaultValue: col.defaultValue,
          },
          dialect
        )
      )
    }
  }

  // 6. Primary Key constraint change for Postgres / CockroachDB / MySQL / MariaDB
  if (pkMembershipChanged && dialect !== 'clickhouse') {
    const nextPkCols = activeCols
      .filter((c) => c.isPrimaryKey)
      .map((c) => quoteIdentForDialect(c.name.trim(), dialect))
    const hadOrigPk = draft.columns.some((c) => c.status !== 'new' && c.originalIsPrimaryKey)
    const qTbl = qualifyAlterTarget(workingTable, draft.schema, dialect)
    if (dialect === 'postgres' || dialect === 'cockroachdb') {
      if (hadOrigPk) {
        const pkIdx = draft.indexes.find((i) => i.isPrimary)
        const pkConstraint = pkIdx?.name || `${workingTable}_pkey`
        stmts.push(
          `ALTER TABLE ${qTbl} DROP CONSTRAINT IF EXISTS ${quoteIdentForDialect(pkConstraint, dialect)};`
        )
      }
      if (nextPkCols.length > 0) {
        stmts.push(`ALTER TABLE ${qTbl} ADD PRIMARY KEY (${nextPkCols.join(', ')});`)
      }
    } else if (dialect === 'mysql' || dialect === 'mariadb') {
      if (hadOrigPk) {
        stmts.push(`ALTER TABLE ${qTbl} DROP PRIMARY KEY;`)
      }
      if (nextPkCols.length > 0) {
        stmts.push(`ALTER TABLE ${qTbl} ADD PRIMARY KEY (${nextPkCols.join(', ')});`)
      }
    }
  } else if (pkMembershipChanged && dialect === 'clickhouse') {
    throw new Error('Modifying PRIMARY KEY columns in place is not supported on ClickHouse.')
  }

  // 7. Add New Indexes
  for (const idx of draft.indexes) {
    if (idx.status === 'new') {
      stmts.push(
        buildAlterTableSql(
          {
            kind: 'addIndex',
            table: workingTable,
            schema: draft.schema,
            indexName: idx.name.trim(),
            columns: idx.columns,
            unique: idx.unique,
          },
          dialect
        )
      )
    }
  }

  // 8. Add New Foreign Keys
  for (const fk of draft.foreignKeys) {
    if (fk.status === 'new') {
      stmts.push(
        buildAlterTableSql(
          {
            kind: 'addForeignKey',
            table: workingTable,
            schema: draft.schema,
            constraintName: fk.constraintName,
            column: fk.column,
            foreignTable: fk.foreignTable,
            foreignSchema: fk.foreignSchema,
            foreignColumn: fk.foreignColumn,
            onDelete: fk.onDelete,
            onUpdate: fk.onUpdate,
          },
          dialect
        )
      )
    }
  }

  // 9. Rename Table last so all column/index/FK operations target the known table name
  if (finalTable !== workingTable) {
    stmts.push(
      buildAlterTableSql(
        {
          kind: 'renameTable',
          table: workingTable,
          schema: draft.schema,
          newTableName: finalTable,
        },
        dialect
      )
    )
    workingTable = finalTable
  }

  return stmts
}

export function validateTableStructureDraft(
  draft: TableStructureDraft,
  dialect: DatabaseDriverType = 'sqlite',
  availableTables: string[] = []
): TableMigrationPlan {
  const errors: string[] = []
  const warnings: string[] = []
  const changeSummaries: string[] = []

  const origTable = (draft.originalTableName || '').trim()
  const nextTable = (draft.tableName || '').trim()
  if (!nextTable) {
    errors.push('Table name cannot be empty.')
  } else if (FORBIDDEN_DEFAULT_TOKENS.test(nextTable) || nextTable.includes('\0')) {
    errors.push('Table name contains invalid characters.')
  } else if (nextTable !== origTable) {
    changeSummaries.push(`Rename table: "${origTable}" -> "${nextTable}"`)
    warnings.push(`Renaming "${origTable}" to "${nextTable}" may break saved SQL queries referencing the old name.`)
  }

  const activeCols = draft.columns.filter((c) => c.status !== 'deleted')
  if (activeCols.length === 0) {
    errors.push('Table must have at least one remaining column.')
  }

  const seenCols = new Map<string, number>()
  for (const col of draft.columns) {
    const colLabel = (col.name || col.originalName || '(unnamed)').trim()
    if (col.status === 'deleted') {
      const targetName = (col.originalName || col.name).trim()
      changeSummaries.push(`- Drop column "${targetName}"`)
      warnings.push(`Dropping column "${targetName}" permanently destroys all data stored in it.`)
      continue
    }

    const cleanName = (col.name || '').trim()
    if (!cleanName) {
      errors.push('Column name cannot be empty.')
    } else if (FORBIDDEN_DEFAULT_TOKENS.test(cleanName)) {
      errors.push(`Column "${cleanName}" contains invalid SQL characters.`)
    } else {
      const key = cleanName.toLowerCase()
      const count = (seenCols.get(key) ?? 0) + 1
      seenCols.set(key, count)
      if (count === 2) {
        errors.push(`Duplicate column name "${cleanName}". Each column must have a unique name.`)
      }
    }

    try {
      validateColumnTypeSpec(col.dataType || '')
    } catch (err: unknown) {
      errors.push(err instanceof Error ? err.message : `Invalid type on column "${colLabel}".`)
    }

    const rawDef = (col.defaultValue ?? '').trim()
    const origDef = (col.originalDefaultValue ?? '').trim()
    const isUntouchedExistingDefault =
      col.status === 'existing' &&
      rawDef === origDef &&
      (col.dataType ?? '').trim().toUpperCase() === (col.originalDataType ?? '').trim().toUpperCase()
    if (rawDef.length > 0 && !isUntouchedExistingDefault) {
      try {
        normalizeSqlDefaultExpression(rawDef, col.dataType || 'TEXT')
      } catch (err: unknown) {
        errors.push(err instanceof Error ? err.message : `Invalid default on column "${colLabel}".`)
      }
    }

    if (col.status === 'new') {
      const defSummary = rawDef.length > 0 ? ` DEFAULT ${rawDef}` : ''
      changeSummaries.push(
        `+ Add column "${cleanName || '(unnamed)'}" ${col.dataType || 'TEXT'}${col.nullable ? '' : ' NOT NULL'}${defSummary}`
      )
      if (!col.nullable && rawDef.length === 0 && (dialect === 'sqlite' || dialect === 'libsql')) {
        warnings.push(`Adding NOT NULL column "${cleanName}" without default auto-fills '' / 0 on SQLite.`)
      }
    } else if (isDraftColumnDirty(col)) {
      const diffs: string[] = []
      const origName = (col.originalName ?? '').trim()
      if (origName !== cleanName) diffs.push(`name "${origName}" -> "${cleanName}"`)
      if ((col.originalDataType ?? '').trim().toUpperCase() !== (col.dataType ?? '').trim().toUpperCase()) {
        diffs.push(`type ${col.originalDataType ?? 'TEXT'} -> ${col.dataType}`)
      }
      if (Boolean(col.originalIsPrimaryKey) !== Boolean(col.isPrimaryKey)) {
        diffs.push(`PK ${col.originalIsPrimaryKey ? 'YES' : 'NO'} -> ${col.isPrimaryKey ? 'YES' : 'NO'}`)
        warnings.push(`Changing Primary Key on "${cleanName}" alters row identity constraints.`)
      }
      if (Boolean(col.originalNullable) !== Boolean(col.nullable)) {
        diffs.push(`${col.originalNullable ? 'NULL' : 'NOT NULL'} -> ${col.nullable ? 'NULL' : 'NOT NULL'}`)
        if (!col.nullable && col.originalNullable && rawDef.length === 0) {
          warnings.push(`Setting "${cleanName}" to NOT NULL without a default fails if existing rows contain NULL.`)
        }
      }
      const origDef = (col.originalDefaultValue ?? '').trim()
      if (origDef !== rawDef) {
        diffs.push(`default ${origDef || 'NULL'} -> ${rawDef || 'NULL'}`)
      }
      changeSummaries.push(`~ Modify column "${cleanName || origName}": ${diffs.join(', ')}`)
    }
  }

  const activeColSet = new Set(activeCols.map((c) => c.name.trim()).filter(Boolean))
  const seenIdx = new Map<string, number>()
  for (const idx of draft.indexes) {
    const idxName = (idx.name || '').trim()
    if (idx.status === 'deleted') {
      changeSummaries.push(`- Drop index "${idx.originalName || idxName}"`)
      warnings.push(`Dropping index "${idx.originalName || idxName}" removes query index optimization / uniqueness check.`)
      continue
    }
    const count = (seenIdx.get(idxName.toLowerCase()) ?? 0) + 1
    seenIdx.set(idxName.toLowerCase(), count)
    if (idx.status === 'new') {
      if (!idxName) {
        errors.push('New index must have a name.')
      } else if (count === 2) {
        errors.push(`Duplicate index name "${idxName}".`)
      }
      if (!idx.columns || idx.columns.length === 0) {
        errors.push(`Index "${idxName || 'new'}" must include at least one column.`)
      } else {
        const missing = idx.columns.filter((c) => !activeColSet.has(c))
        if (missing.length > 0) {
          errors.push(`Index "${idxName}" references missing/dropped column(s): ${missing.join(', ')}.`)
        }
      }
      changeSummaries.push(
        `+ Create ${idx.unique ? 'UNIQUE ' : ''}index "${idxName}" (${(idx.columns || []).join(', ')})`
      )
    }
  }

  const knownTableSet = new Set(availableTables.map((t) => t.trim().toLowerCase()).filter(Boolean))
  for (const fk of draft.foreignKeys) {
    if (fk.status === 'deleted') {
      changeSummaries.push(`- Drop Foreign Key "${fk.constraintName || fk.column}"`)
      warnings.push(`Dropping Foreign Key "${fk.constraintName || fk.column}" disables referential integrity checking.`)
      continue
    }
    if (fk.status === 'new') {
      const col = (fk.column || '').trim()
      const refTbl = (fk.foreignTable || '').trim()
      const refCol = (fk.foreignColumn || '').trim()
      if (!col || !activeColSet.has(col)) {
        errors.push(`Foreign Key local column "${col || '(none)'}" does not exist among active columns.`)
      }
      if (!refTbl) {
        errors.push('Foreign Key target table is required.')
      } else if (knownTableSet.size > 0 && !knownTableSet.has(refTbl.toLowerCase())) {
        errors.push(`Foreign Key target table "${refTbl}" was not found in this connection.`)
      }
      if (!refCol) {
        errors.push('Foreign Key target column is required.')
      }
      if (dialect === 'clickhouse') {
        errors.push('ClickHouse does not support FOREIGN KEY constraints.')
      }
      changeSummaries.push(
        `+ Add Foreign Key "${col}" -> "${refTbl}"("${refCol}") ON DELETE ${sanitizeReferentialAction(fk.onDelete)}`
      )
    }
  }

  const isRebuild =
    (dialect === 'sqlite' || dialect === 'libsql') &&
    countTableStructureChanges(draft) > 0 &&
    requiresSqliteTableRebuild(draft)

  if (isRebuild) {
    warnings.push('SQLite 12-Step Table Rebuild will recreate the table and migrate existing rows atomically inside a transaction.')
  }

  let statements: string[] = []
  if (errors.length === 0 && changeSummaries.length > 0) {
    try {
      statements = buildTableMigrationSql(draft, dialect)
    } catch (err: unknown) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  return {
    valid: errors.length === 0 && changeSummaries.length > 0,
    errors,
    warnings,
    changeSummaries,
    statements,
    isRebuild,
  }
}

export interface CreateTableColumnDraft {
  name: string
  dataType: string
  nullable?: boolean
  defaultValue?: string
  isPrimaryKey?: boolean
  isAutoIncrement?: boolean
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
  for (const row of matrix) {
    lines.push(
      row
        .map((cell) => escapeDelimitedField(formatTabularCellText(cell, ''), delimiter))
        .join(delimiter)
    )
  }
  return lines.join('\n')
}

/**
 * Builds a single-column quick-filter WHERE predicate verified against `sanitizeFilterClause`.
 */
export function buildQuickFilterPredicate(
  column: string,
  value: unknown,
  mode: 'eq' | 'neq' | 'is-null' | 'is-not-null',
  dialect: DatabaseDriverType
): string {
  const colName = (column ?? '').trim()
  if (!colName) {
    throw new Error('Column name is required for quick filter predicate.')
  }
  const qCol = quoteIdentForDialect(colName, dialect)
  let predicate: string
  switch (mode) {
    case 'is-null':
      predicate = `${qCol} IS NULL`
      break
    case 'is-not-null':
      predicate = `${qCol} IS NOT NULL`
      break
    case 'eq':
      predicate =
        value === null || value === undefined
          ? `${qCol} IS NULL`
          : `${qCol} = ${formatSqlLiteral(value, dialect)}`
      break
    case 'neq':
      predicate =
        value === null || value === undefined
          ? `${qCol} IS NOT NULL`
          : `${qCol} != ${formatSqlLiteral(value, dialect)}`
      break
  }
  const sanitized = sanitizeFilterClause(predicate, dialect)
  if (!sanitized) {
    throw new Error('Failed to build a valid quick filter predicate.')
  }
  return sanitized
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
    if (ch === '#' && BACKTICK_DIALECTS.has(dialect)) {
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

/**
 * Builds a validated, dialect-aware `CREATE TABLE` DDL statement from a visual table draft.
 */
export function buildCreateTableSql(
  draft: { tableName: string; schema?: string; columns: CreateTableColumnDraft[] },
  dialect: DatabaseDriverType
): string {
  if (dialect === 'redis') {
    throw new Error('CREATE TABLE is not supported on Redis keyspaces.')
  }
  const tableName = (draft.tableName ?? '').trim()
  if (!tableName) {
    throw new Error('Table name is required.')
  }
  if (FORBIDDEN_DEFAULT_TOKENS.test(tableName) || tableName.includes('\0')) {
    throw new Error('Table name contains invalid characters.')
  }
  const schemaName = (draft.schema ?? '').trim()
  if (schemaName && (FORBIDDEN_DEFAULT_TOKENS.test(schemaName) || schemaName.includes('\0'))) {
    throw new Error('Schema name contains invalid characters.')
  }
  if (!Array.isArray(draft.columns) || draft.columns.length === 0) {
    throw new Error('Table must have at least one column.')
  }

  const seenNames = new Set<string>()
  const normalizedCols = draft.columns.map((col) => {
    const cleanName = (col.name ?? '').trim()
    if (!cleanName) {
      throw new Error('Every column must have a non-empty name.')
    }
    if (FORBIDDEN_DEFAULT_TOKENS.test(cleanName) || cleanName.includes('\0')) {
      throw new Error(`Column "${cleanName}" contains invalid SQL characters.`)
    }
    const lower = cleanName.toLowerCase()
    if (seenNames.has(lower)) {
      throw new Error(`Duplicate column name "${cleanName}".`)
    }
    seenNames.add(lower)

    const cleanType = validateColumnTypeSpec(col.dataType)
    const rawDef = (col.defaultValue ?? '').trim()
    const normalizedDef = rawDef.length > 0 ? normalizeSqlDefaultExpression(rawDef, cleanType) : ''
    return {
      name: cleanName,
      dataType: cleanType,
      nullable: col.nullable !== false,
      defaultValue: normalizedDef,
      isPrimaryKey: Boolean(col.isPrimaryKey),
      isAutoIncrement: Boolean(col.isAutoIncrement),
    }
  })

  const isSqlite = dialect === 'sqlite' || dialect === 'libsql'
  const isMysql = dialect === 'mysql' || dialect === 'mariadb'
  const isPg = dialect === 'postgres' || dialect === 'cockroachdb'
  const isClickHouse = dialect === 'clickhouse'

  const pkCols = normalizedCols.filter((c) => c.isPrimaryKey)
  let inlinePkHandled = false
  const bodyLines: string[] = []

  for (const col of normalizedCols) {
    const useSqliteAutoInc =
      isSqlite &&
      col.isAutoIncrement &&
      col.isPrimaryKey &&
      pkCols.length === 1 &&
      /INT/i.test(col.dataType)

    const effectiveType = useSqliteAutoInc ? 'INTEGER' : col.dataType
    const parts: string[] = [quoteIdentForDialect(col.name, dialect), effectiveType]

    if (useSqliteAutoInc) {
      parts.push('PRIMARY KEY AUTOINCREMENT')
      inlinePkHandled = true
    } else if (isPg && col.isAutoIncrement && !/serial/i.test(effectiveType)) {
      parts.push('GENERATED BY DEFAULT AS IDENTITY')
    }

    if (!col.nullable && !useSqliteAutoInc) {
      parts.push('NOT NULL')
    }

    if (col.defaultValue.length > 0) {
      parts.push(`DEFAULT ${col.defaultValue}`)
    }

    if (isMysql && col.isAutoIncrement) {
      parts.push('AUTO_INCREMENT')
    }

    bodyLines.push(`  ${parts.join(' ')}`)
  }

  if (pkCols.length > 0 && !inlinePkHandled && !isClickHouse) {
    const quotedPks = pkCols.map((c) => quoteIdentForDialect(c.name, dialect)).join(', ')
    bodyLines.push(`  PRIMARY KEY (${quotedPks})`)
  }

  const qualifiedTable = qualifyAlterTarget(tableName, schemaName || undefined, dialect)
  if (isClickHouse) {
    const orderBy =
      pkCols.length > 0
        ? `(${pkCols.map((c) => quoteIdentForDialect(c.name, dialect)).join(', ')})`
        : 'tuple()'
    return `CREATE TABLE ${qualifiedTable} (\n${bodyLines.join(',\n')}\n) ENGINE = MergeTree() ORDER BY ${orderBy};`
  }

  return `CREATE TABLE ${qualifiedTable} (\n${bodyLines.join(',\n')}\n);`
}

/**
 * Builds a dialect-aware `TRUNCATE TABLE` statement (`DELETE FROM` on SQLite/LibSQL).
 */
export function buildTruncateTableSql(
  table: string,
  dialect: DatabaseDriverType,
  schema?: string
): string {
  if (dialect === 'redis') {
    throw new Error('TRUNCATE TABLE is not supported on Redis keyspaces.')
  }
  const tableName = (table ?? '').trim()
  if (!tableName) {
    throw new Error('Table name is required.')
  }
  if (FORBIDDEN_DEFAULT_TOKENS.test(tableName) || tableName.includes('\0')) {
    throw new Error('Table name contains invalid characters.')
  }
  const schemaName = (schema ?? '').trim()
  if (schemaName && (FORBIDDEN_DEFAULT_TOKENS.test(schemaName) || schemaName.includes('\0'))) {
    throw new Error('Schema name contains invalid characters.')
  }
  const qualified = qualifyAlterTarget(tableName, schemaName || undefined, dialect)
  if (dialect === 'sqlite' || dialect === 'libsql') {
    return `DELETE FROM ${qualified};`
  }
  return `TRUNCATE TABLE ${qualified};`
}

/**
 * Builds a dialect-aware `DROP TABLE` or `DROP VIEW` statement.
 */
export function buildDropTableSql(
  table: string,
  kind: 'table' | 'view',
  dialect: DatabaseDriverType,
  schema?: string,
  ifExists = false
): string {
  if (dialect === 'redis') {
    throw new Error('DROP TABLE/VIEW is not supported on Redis keyspaces.')
  }
  const tableName = (table ?? '').trim()
  if (!tableName) {
    throw new Error('Table or view name is required.')
  }
  if (FORBIDDEN_DEFAULT_TOKENS.test(tableName) || tableName.includes('\0')) {
    throw new Error('Table or view name contains invalid characters.')
  }
  const schemaName = (schema ?? '').trim()
  if (schemaName && (FORBIDDEN_DEFAULT_TOKENS.test(schemaName) || schemaName.includes('\0'))) {
    throw new Error('Schema name contains invalid characters.')
  }
  const targetKind = kind === 'view' ? 'VIEW' : 'TABLE'
  const existsClause = ifExists ? 'IF EXISTS ' : ''
  const qualified = qualifyAlterTarget(tableName, schemaName || undefined, dialect)
  return `DROP ${targetKind} ${existsClause}${qualified};`
}
