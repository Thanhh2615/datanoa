/**
 * src/panel/panel-core.js
 *
 * Pure, stateless Side Panel helpers shared by src/panel/panel.html and unit/E2E tests:
 * - Engine metadata & dialect capability sets
 * - Dialect-aware SQL lexing, statement splitting, formatting & data export
 * - Visual Table Structure Designer validators & migration SQL generator
 * - Privacy-safe Feedback / Bug Report Markdown & GitHub Issue URL builders
 */

import {
  parseDelimitedClipboard as sharedParseDelimitedClipboard,
  planGridPaste as sharedPlanGridPaste,
  sanitizeDiagnosticErrorText as sharedSanitizeDiagnosticErrorText,
} from '../shared-grid-paste.js'
import {
  FORBIDDEN_SUBQUERY_VERBS,
  KNOWN_SQL_DEFAULT_KEYWORDS,
  containsDdlStatement as sharedContainsDdlStatement,
  findStatementAtOffset as sharedFindStatementAtOffset,
  findTopLevelPostgresCastIndex as sharedFindTopLevelPostgresCastIndex,
  formatSql as sharedFormatSql,
  formatSqlLiteral as sharedFormatSqlLiteral,
  hasBalancedParens as sharedHasBalancedParens,
  isIdentContChar as sharedIsIdentContChar,
  isIdentStartChar as sharedIsIdentStartChar,
  isNumericOrBooleanTypeName as sharedIsNumericOrBooleanTypeName,
  matchDollarQuoteTag as sharedMatchDollarQuoteTag,
  normalizeSqlDefaultExpression as sharedNormalizeSqlDefaultExpression,
  quoteIdentForDialect as sharedQuoteIdentForDialect,
  scanQuotedSegmentEnd as sharedScanQuotedSegmentEnd,
  splitSqlStatements as sharedSplitSqlStatements,
  stripLeadingSqlComments as sharedStripLeadingSqlComments,
  validateColumnTypeSpec as sharedValidateColumnTypeSpec,
} from '../shared-sql-core.js'

export const DATANOA_VERSION = '1.1.2'
export const DATANOA_GITHUB_ISSUES_URL = 'https://github.com/Thanhh2615/datanoa/issues/new'

export const ENGINES = [
  { id: 'sqlite', label: 'SQLite', defaultPort: 0, supportsSsl: false, defaultDb: 'main.db', defaultUser: '' },
  { id: 'postgres', label: 'Postgres', defaultPort: 5432, supportsSsl: true, defaultDb: 'postgres', defaultUser: 'postgres' },
  { id: 'mysql', label: 'MySQL', defaultPort: 3306, supportsSsl: true, defaultDb: 'mysql', defaultUser: 'root' },
  { id: 'mariadb', label: 'MariaDB', defaultPort: 3306, supportsSsl: true, defaultDb: 'mysql', defaultUser: 'root' },
  { id: 'cockroachdb', label: 'Cockroach', defaultPort: 26257, supportsSsl: true, defaultDb: 'defaultdb', defaultUser: 'root' },
  { id: 'clickhouse', label: 'ClickHouse', defaultPort: 8123, supportsSsl: true, defaultDb: 'default', defaultUser: 'default' },
  { id: 'redis', label: 'Redis', defaultPort: 6379, supportsSsl: true, defaultDb: '0', defaultUser: '' },
  { id: 'libsql', label: 'LibSQL', defaultPort: 443, supportsSsl: true, defaultDb: 'turso', defaultUser: '' },
  { id: 'mssql', label: 'SQL Server', defaultPort: 1433, supportsSsl: true, defaultDb: 'master', defaultUser: 'sa' },
  { id: 'oracle', label: 'Oracle', defaultPort: 1521, supportsSsl: true, defaultDb: 'FREEPDB1', defaultUser: 'system' },
  { id: 'mongodb', label: 'MongoDB', defaultPort: 27017, supportsSsl: true, defaultDb: 'admin', defaultUser: 'admin' },
  { id: 'custom', label: 'Custom BYOD', defaultPort: 5432, supportsSsl: true, defaultDb: 'default', defaultUser: 'admin' },
]

export const ENGINE_BY_ID = Object.fromEntries(ENGINES.map((e) => [e.id, e]))

export const BACKTICK_DRIVERS = new Set(['mysql', 'mariadb', 'clickhouse'])
export const MYSQL_EXEC_DRIVERS = new Set(['mysql', 'mariadb'])
export const BACKSLASH_ESCAPE_DRIVERS = new Set(['mysql', 'mariadb', 'clickhouse'])
export const HASH_COMMENT_DRIVERS = new Set(['mysql', 'mariadb', 'clickhouse'])
export const PANEL_DDL_VERBS = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'ATTACH', 'DETACH'])

export const PANEL_REFERENTIAL_ACTIONS = [
  'NO ACTION',
  'CASCADE',
  'SET NULL',
  'RESTRICT',
  'SET DEFAULT',
]
export const PANEL_REF_ACTIONS = new Set(PANEL_REFERENTIAL_ACTIONS)

export const PANEL_COL_TYPES = [
  'VARCHAR(255)',
  'VARCHAR',
  'TEXT',
  'INTEGER',
  'INT4',
  'BIGINT',
  'INT8',
  'NUMERIC(10,2)',
  'NUMERIC',
  'REAL',
  'BOOLEAN',
  'BOOL',
  'TIMESTAMPTZ',
  'TIMESTAMP',
  'DATETIME',
  'DATE',
  'JSONB',
  'JSON',
  'UUID',
  'BYTEA',
  'BLOB',
]

export const PANEL_TYPE_SUGGESTIONS_BY_DRIVER = {
  sqlite: [
    'INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC', 'BOOLEAN', 'DATETIME', 'DATE', 'JSON', 'VARCHAR(255)',
  ],
  libsql: [
    'INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC', 'BOOLEAN', 'DATETIME', 'DATE', 'JSON', 'VARCHAR(255)',
  ],
  postgres: [
    'BIGINT', 'INTEGER', 'INT4', 'INT8', 'TEXT', 'VARCHAR(255)', 'BOOLEAN', 'NUMERIC(10,2)',
    'DOUBLE PRECISION', 'TIMESTAMPTZ', 'TIMESTAMP', 'DATE', 'UUID', 'JSONB', 'JSON', 'BYTEA',
  ],
  cockroachdb: [
    'INT8', 'INT4', 'STRING', 'TEXT', 'VARCHAR(255)', 'BOOL', 'DECIMAL(10,2)',
    'FLOAT8', 'TIMESTAMPTZ', 'TIMESTAMP', 'DATE', 'UUID', 'JSONB', 'BYTES',
  ],
  mysql: [
    'BIGINT', 'INT', 'VARCHAR(255)', 'TEXT', 'TINYINT(1)', 'BOOLEAN', 'DECIMAL(10,2)',
    'DOUBLE', 'DATETIME', 'TIMESTAMP', 'DATE', 'JSON', 'CHAR(36)', 'BLOB',
  ],
  mariadb: [
    'BIGINT', 'INT', 'VARCHAR(255)', 'TEXT', 'TINYINT(1)', 'BOOLEAN', 'DECIMAL(10,2)',
    'DOUBLE', 'DATETIME', 'TIMESTAMP', 'DATE', 'JSON', 'UUID', 'BLOB',
  ],
  clickhouse: [
    'UInt64', 'Int64', 'Int32', 'String', 'LowCardinality(String)', 'Float64',
    'Decimal(10, 2)', 'Bool', 'DateTime', 'DateTime64(3)', 'Date', 'UUID', 'Nullable(String)',
  ],
  redis: ['STRING', 'HASH', 'LIST', 'SET', 'ZSET', 'STREAM', 'JSON'],
}

export const KNOWN_SQL_DEFAULTS_RE = KNOWN_SQL_DEFAULT_KEYWORDS
export const FORBIDDEN_DEFAULT_TOKENS_RE = /[;\r\n\0#]|--|\/\*|\*\//
export const FORBIDDEN_SUBQUERY_RE = FORBIDDEN_SUBQUERY_VERBS

// ============================================================================
// Pure Serialization, Color & Formatting Utilities
// ============================================================================

export function sanitizeJson(val, seen = new WeakSet()) {
  if (val === undefined || val === null) return null
  if (typeof val === 'boolean' || typeof val === 'string') return val
  if (typeof val === 'number') return Number.isFinite(val) ? val : null
  if (typeof val === 'bigint') return String(val)
  if (val instanceof Date) return Number.isNaN(val.getTime()) ? null : val.toISOString()
  if (typeof val === 'function' || typeof val === 'symbol') return null
  if (typeof val === 'object') {
    if (seen.has(val)) return null
    seen.add(val)
    if (Array.isArray(val)) {
      return val.map((item) => sanitizeJson(item, seen))
    }
    const out = {}
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined && typeof v !== 'function' && typeof v !== 'symbol') {
        out[k] = sanitizeJson(v, seen)
      }
    }
    return out
  }
  return null
}

export function srgbLin(c) {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

export function formatAggNum(n) {
  const num = Number(n)
  if (!Number.isFinite(num)) return '0'
  return Number.isInteger(num) ? String(num) : Number(num.toFixed(4)).toString()
}

export function formatRelativeTime(ts, nowMs = Date.now()) {
  const num = Number(ts)
  if (!Number.isFinite(num) || num <= 0) return ''
  const diffSec = Math.max(0, Math.floor((nowMs - num) / 1000))
  if (diffSec < 15) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  return `${Math.floor(diffHr / 24)}d ago`
}

export function compactPathLabel(fullPath) {
  const parts = String(fullPath || '').split(/[\\/]/).filter(Boolean)
  if (parts.length <= 4) return String(fullPath || '').replace(/\\/g, '/')
  return `.../${parts.slice(-4).join('/')}`
}

export function maskConnectionUriSecret(rawUri) {
  return String(rawUri || '').replace(
    /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:/?#\s@]*:)([^@]+)(@)/,
    '$1***$3'
  )
}

// ============================================================================
// Pure Dialect SQL Lexer, Quoting, Formatter & Data Exporters
// ============================================================================

export function quoteIdent(ident, driver) {
  return sharedQuoteIdentForDialect(String(ident), driver || 'postgres')
}

export function quoteTableRef(tableName, schemaName, driver) {
  const s = String(schemaName || '').trim()
  const omit =
    !s ||
    ((driver === 'sqlite' || driver === 'libsql' || driver === 'd1') && s.toLowerCase() === 'main')
  return omit ? quoteIdent(tableName, driver) : `${quoteIdent(s, driver)}.${quoteIdent(tableName, driver)}`
}

export const isIdentStart = sharedIsIdentStartChar
export const isIdentCont = sharedIsIdentContChar
export const matchDollarTag = sharedMatchDollarQuoteTag

export function scanQuotedEnd(sql, start, qChar, allowBackslash) {
  return sharedScanQuotedSegmentEnd(sql, start, qChar, allowBackslash).end
}

export function splitSqlStatements(script, driver) {
  return sharedSplitSqlStatements(String(script ?? ''), driver || 'postgres')
}

export function stripLeadingSqlComments(stmt, driver) {
  return sharedStripLeadingSqlComments(String(stmt ?? ''), driver)
}

export function panelContainsDdlStatement(sql, driver) {
  if (!sql || driver === 'redis') return false
  return sharedContainsDdlStatement(sql, driver)
}

export function findStatementAtCaret(script, offset, driver) {
  return sharedFindStatementAtOffset(script, offset, driver || 'postgres') || String(script || '').trim()
}

export const findStatementAtOffset = findStatementAtCaret

export function formatSqlLiteral(val, driver) {
  return sharedFormatSqlLiteral(val, driver || 'postgres')
}

export function buildPanelExportData({ columns, rows, format, tableName, schema, driver, primaryKeys }) {
  const colNames = columns.map((c) => (typeof c === 'string' ? c : c.name))
  if (colNames.length === 0) return ''
  const qTable = quoteTableRef(tableName || 'table_name', schema, driver || 'postgres')
  const readCell = (row, colIdx) => (Array.isArray(row) ? row[colIdx] : row[colNames[colIdx]])

  if (format === 'sql-insert') {
    const qCols = colNames.map((c) => quoteIdent(c, driver)).join(', ')
    return rows
      .map(
        (row) =>
          `INSERT INTO ${qTable} (${qCols}) VALUES (${colNames
            .map((_, ci) => formatSqlLiteral(readCell(row, ci), driver))
            .join(', ')});`
      )
      .join('\n')
  }
  if (format === 'sql-update') {
    const pkCols = primaryKeys && primaryKeys.length > 0 ? primaryKeys : [colNames[0]]
    const pkSet = new Set(pkCols)
    const nonPkIndices = colNames.map((c, ci) => (!pkSet.has(c) ? ci : -1)).filter((ci) => ci >= 0)
    const setIndices = nonPkIndices.length > 0 ? nonPkIndices : colNames.map((_, ci) => ci)
    return rows
      .map((row) => {
        const sets = setIndices
          .map((ci) => `${quoteIdent(colNames[ci], driver)} = ${formatSqlLiteral(readCell(row, ci), driver)}`)
          .join(', ')
        const wheres = pkCols
          .map((pk) => {
            const pkIdx = colNames.indexOf(pk)
            const v = pkIdx >= 0 ? readCell(row, pkIdx) : Array.isArray(row) ? null : row[pk]
            return v == null
              ? `${quoteIdent(pk, driver)} IS NULL`
              : `${quoteIdent(pk, driver)} = ${formatSqlLiteral(v, driver)}`
          })
          .join(' AND ')
        return `UPDATE ${qTable} SET ${sets} WHERE ${wheres};`
      })
      .join('\n')
  }
  const uniqueKeys = []
  const keyCounts = new Map()
  for (const name of colNames) {
    const count = (keyCounts.get(name) || 0) + 1
    keyCounts.set(name, count)
    uniqueKeys.push(count === 1 ? name : `${name}_${count}`)
  }
  const projectRow = (row) => {
    const out = {}
    for (let ci = 0; ci < colNames.length; ci++) {
      const v = readCell(row, ci)
      out[uniqueKeys[ci]] = v === undefined ? null : v
    }
    return out
  }
  if (format === 'json') return JSON.stringify(rows.map(projectRow), null, 2)
  if (format === 'ndjson') return rows.map((r) => JSON.stringify(projectRow(r))).join('\n')
  if (format === 'csv' || format === 'tsv') {
    const delim = format === 'csv' ? ',' : '\t'
    const esc = (text) =>
      text.includes(delim) || text.includes('"') || text.includes('\n') || text.includes('\r')
        ? `"${text.replace(/"/g, '""')}"`
        : text
    const head = colNames.map(esc).join(delim)
    const body = rows.map((row) =>
      colNames
        .map((_, ci) => {
          const v = readCell(row, ci)
          return esc(v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
        })
        .join(delim)
    )
    return [head, ...body].join('\n')
  }
  if (format === 'markdown') {
    const escMd = (text) => text.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>')
    const head = `| ${colNames.map(escMd).join(' | ')} |`
    const sep = `| ${colNames.map(() => '---').join(' | ')} |`
    const body = rows.map(
      (row) =>
        `| ${colNames
          .map((_, ci) => {
            const v = readCell(row, ci)
            return escMd(v == null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v))
          })
          .join(' | ')} |`
    )
    return [head, sep, ...body].join('\n')
  }
  return ''
}

export const formatExportData = buildPanelExportData

export function formatSelectionAsOutput(
  columns,
  rows,
  coords,
  format,
  includeHeaders,
  tableName,
  schema,
  driver,
  primaryKeys
) {
  if (!coords.length) return ''
  const rowSet = Array.from(new Set(coords.map((p) => p.r))).sort((a, b) => a - b)
  const colSet = Array.from(new Set(coords.map((p) => p.c))).sort((a, b) => a - b)
  const coordKeySet = new Set(coords.map((p) => `${p.r}:${p.c}`))
  const selCols = colSet.map((ci) => columns[ci]).filter(Boolean)
  const colNames = selCols.map((c) => (typeof c === 'string' ? c : c.name))
  const readVal = (r, c) => {
    const row = rows[r]
    if (!row) return null
    if (Array.isArray(row)) return row[c]
    const col = columns[c]
    const colName = typeof col === 'string' ? col : col?.name
    return colName ? row[colName] : null
  }
  if (format === 'sql-in') {
    const vals = []
    const seen = new Set()
    let hasNull = false
    for (const p of coords) {
      if (!columns[p.c]) continue
      const v = readVal(p.r, p.c)
      if (v === null || v === undefined) {
        hasNull = true
        continue
      }
      const lit = formatSqlLiteral(v, driver)
      if (!seen.has(lit)) {
        seen.add(lit)
        vals.push(lit)
      }
    }
    const firstCol = colNames[0] ? quoteIdent(colNames[0], driver) : ''
    if (colNames.length === 1 && firstCol) {
      if (vals.length > 0 && hasNull) return `(${firstCol} IN (${vals.join(', ')}) OR ${firstCol} IS NULL)`
      if (vals.length > 0) return `${firstCol} IN (${vals.join(', ')})`
      return hasNull ? `${firstCol} IS NULL` : ''
    }
    if (vals.length > 0) return `(${vals.join(', ')})`
    return hasNull ? '(NULL)' : ''
  }
  if (format === 'tsv') {
    const escTsv = (text) =>
      text.includes('\t') || text.includes('"') || text.includes('\n') || text.includes('\r')
        ? `"${text.replace(/"/g, '""')}"`
        : text
    const isSinglePlainCell = !includeHeaders && rowSet.length === 1 && colSet.length === 1
    const lines = []
    if (includeHeaders) lines.push(colNames.map(escTsv).join('\t'))
    for (const r of rowSet) {
      const cells = colSet.map((c) => {
        if (!coordKeySet.has(`${r}:${c}`)) return ''
        const v = readVal(r, c)
        if (v === null || v === undefined) return ''
        const str = typeof v === 'object' ? JSON.stringify(v) : String(v)
        return isSinglePlainCell ? str : escTsv(str)
      })
      lines.push(cells.join('\t'))
    }
    return lines.join('\n')
  }
  const projectedRows = rowSet.map((r) =>
    colSet.map((c) => (coordKeySet.has(`${r}:${c}`) ? readVal(r, c) : null))
  )
  return buildPanelExportData({
    columns: selCols,
    rows: projectedRows,
    format,
    tableName: tableName || 'table_name',
    schema,
    driver,
    primaryKeys,
  })
}

export function formatPanelSql(sql, driver) {
  return sharedFormatSql(String(sql || ''), driver || 'postgres')
}

export const parsePanelDelimitedText = sharedParseDelimitedClipboard
export const parseDelimitedClipboard = parsePanelDelimitedText
export const planPanelGridPaste = sharedPlanGridPaste

export function normalizeCellRange(r1, c1, r2, c2) {
  return {
    r1: Math.min(r1, r2),
    c1: Math.min(c1, c2),
    r2: Math.max(r1, r2),
    c2: Math.max(c1, c2),
  }
}

export function subtractCellFromRange(range, r, c) {
  if (r < range.r1 || r > range.r2 || c < range.c1 || c > range.c2) return [range]
  const out = []
  if (range.r1 <= r - 1) out.push({ r1: range.r1, c1: range.c1, r2: r - 1, c2: range.c2 })
  if (r + 1 <= range.r2) out.push({ r1: r + 1, c1: range.c1, r2: range.r2, c2: range.c2 })
  if (range.c1 <= c - 1) out.push({ r1: r, c1: range.c1, r2: r, c2: c - 1 })
  if (c + 1 <= range.c2) out.push({ r1: r, c1: c + 1, r2: r, c2: range.c2 })
  return out
}

export function subtractRowFromRange(range, r) {
  if (r < range.r1 || r > range.r2) return [range]
  const out = []
  if (range.r1 <= r - 1) out.push({ r1: range.r1, c1: range.c1, r2: r - 1, c2: range.c2 })
  if (r + 1 <= range.r2) out.push({ r1: r + 1, c1: range.c1, r2: range.r2, c2: range.c2 })
  return out
}

export function subtractColFromRange(range, c) {
  if (c < range.c1 || c > range.c2) return [range]
  const out = []
  if (range.c1 <= c - 1) out.push({ r1: range.r1, c1: range.c1, r2: range.r2, c2: c - 1 })
  if (c + 1 <= range.c2) out.push({ r1: range.r1, c1: c + 1, r2: range.r2, c2: range.c2 })
  return out
}

export function isNumericSqlType(colType) {
  return /\b(?:INT|INTEGER|BIGINT|SMALLINT|TINYINT|MEDIUMINT|INT2|INT4|INT8|UINT8|UINT16|UINT32|UINT64|FLOAT4|FLOAT8|REAL|FLOAT|DOUBLE|DECIMAL|NUMERIC|NUMBER|SERIAL|BIGSERIAL|SMALLSERIAL)\b/i.test(
    String(colType || '')
  )
}

export function isBooleanSqlType(colType) {
  return /\b(?:BOOL|BOOLEAN)\b/i.test(String(colType || ''))
}

export function isEmptyAsNullNonTextSqlType(colType) {
  return /\b(?:DATE|TIME|TIMESTAMP|TIMESTAMPTZ|DATETIME|YEAR|UUID|GUID|JSON|JSONB|INET|CIDR|MACADDR|BYTEA|BLOB|BINARY|VARBINARY|INTERVAL)\b/i.test(
    String(colType || '')
  )
}

export function coerceTypedCellInput(typed, originalValue, colType, nullable = true, options = {}) {
  const rawStr = String(typed ?? '')
  const trimmed = rawStr.trim()
  const isNumericCol = typeof originalValue === 'number' || isNumericSqlType(colType)
  const isBoolCol = typeof originalValue === 'boolean' || isBooleanSqlType(colType)
  const isOtherNonTextCol = isEmptyAsNullNonTextSqlType(colType)

  if (trimmed === '' && (isNumericCol || isBoolCol || isOtherNonTextCol)) {
    return null
  }
  if (trimmed.toUpperCase() === 'NULL' && nullable !== false) {
    if (options.allowNullKeyword || isNumericCol || isBoolCol || isOtherNonTextCol) {
      return null
    }
  }
  if (isBoolCol) {
    if (/^true$/i.test(trimmed)) return true
    if (/^false$/i.test(trimmed)) return false
  }
  if (isNumericCol) {
    if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed)
      if (trimmed.includes('.')) {
        const decDigits = trimmed.replace(/^[+-]?0+(?=\d)/, '').replace('.', '')
        if (decDigits.length > 15) return trimmed
        if (Number.isFinite(num)) return num
      } else if (Number.isSafeInteger(num)) {
        return num
      } else {
        return trimmed
      }
    }
  }
  return rawStr
}

export function computeInitialColumnWidths(columns, rows) {
  const sample = rows.slice(0, 25)
  return columns.map((col) => {
    const headerLen = col.name.length + (col.isPrimaryKey ? 5 : 0) + 2
    let maxLen = headerLen
    for (const entry of sample) {
      const val = entry.data[col.name]
      let textLen = 4
      if (val !== null && val !== undefined) {
        const str = typeof val === 'object' ? JSON.stringify(val) : String(val)
        textLen = str.length
      }
      if (textLen > maxLen) maxLen = textLen
    }
    const px = Math.round(Math.min(40, Math.max(7, maxLen)) * 7.4 + 26)
    return Math.max(84, Math.min(280, px))
  })
}

export function computeVirtualRange(scrollTop, viewportH, totalRows, rowHeightPx = 26, overscanRows = 10) {
  if (totalRows <= 0) return { start: 0, end: 0 }
  const effH = viewportH > 0 ? viewportH : 420
  const firstVisible = Math.max(0, Math.floor(Math.max(0, scrollTop - rowHeightPx) / rowHeightPx))
  const visibleCount = Math.max(1, Math.ceil(effH / rowHeightPx) + 1)
  const start = Math.max(0, firstVisible - overscanRows)
  const end = Math.min(totalRows, firstVisible + visibleCount + overscanRows)
  return { start, end }
}

export function buildDdlFallback(details, driver) {
  const qTable = quoteTableRef(details.name, details.schema, driver)
  const cols = Array.isArray(details.columns) ? details.columns : []
  const pks =
    details.primaryKey?.length > 0
      ? details.primaryKey
      : cols.filter((c) => c.isPrimaryKey).map((c) => c.name)
  const lines = cols.map((c) => {
    const t = (c.nativeType || c.type || 'TEXT').trim()
    const parts = [quoteIdent(c.name, driver), t]
    if (!c.nullable) parts.push('NOT NULL')
    if (c.defaultValue !== null && c.defaultValue !== undefined && c.defaultValue !== '') {
      parts.push(`DEFAULT ${c.defaultValue}`)
    }
    return `  ${parts.join(' ')}`
  })
  if (pks.length > 0) {
    lines.push(`  PRIMARY KEY (${pks.map((p) => quoteIdent(p, driver)).join(', ')})`)
  }
  for (const fk of details.foreignKeys || []) {
    lines.push(
      `  FOREIGN KEY (${quoteIdent(fk.column, driver)}) REFERENCES ${quoteIdent(fk.referencedTable, driver)} (${quoteIdent(fk.referencedColumn, driver)})`
    )
  }
  return lines.length > 0 ? `CREATE TABLE ${qTable} (\n${lines.join(',\n')}\n);` : `CREATE TABLE ${qTable} ();`
}

export function skipSqlToken(str, i) {
  const ch = str[i]
  const next = str[i + 1]
  if (ch === '-' && next === '-') {
    let j = i + 2
    while (j < str.length && str[j] !== '\n') j++
    return j
  }
  if (ch === '/' && next === '*') {
    const end = str.indexOf('*/', i + 2)
    return end >= 0 ? end + 2 : str.length
  }
  if (ch === "'" || ch === '"' || ch === '`') {
    let j = i + 1
    while (j < str.length) {
      if (ch === "'" && str[j] === '\\') { j += 2; continue }
      if (str[j] === ch) {
        if (str[j + 1] === ch) { j += 2; continue }
        return j + 1
      }
      j++
    }
    return str.length
  }
  return -1
}

export function formatDdlForDisplay(ddl) {
  const raw = String(ddl || '').trim()
  if (!raw || !/^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\b/i.test(raw)) return raw

  let openIdx = -1
  let closeIdx = -1
  let depth = 0
  for (let i = 0; i < raw.length;) {
    const skipped = skipSqlToken(raw, i)
    if (skipped > i) { i = skipped; continue }
    const ch = raw[i]
    if (ch === '(') {
      if (depth === 0 && openIdx < 0) openIdx = i
      depth++
    } else if (ch === ')' && openIdx >= 0) {
      depth--
      if (depth === 0) { closeIdx = i; break }
    }
    i++
  }
  if (openIdx < 0 || closeIdx <= openIdx) return raw

  const inside = raw.slice(openIdx + 1, closeIdx)
  if (inside.includes('\n') && !inside.split('\n').some((l) => l.length > 120)) return raw

  const parts = []
  let segStart = 0
  depth = 0
  for (let i = 0; i < inside.length;) {
    const skipped = skipSqlToken(inside, i)
    if (skipped > i) { i = skipped; continue }
    const ch = inside[i]
    if (ch === '(') depth++
    else if (ch === ')' && depth > 0) depth--
    else if (ch === ',' && depth === 0) {
      const item = inside.slice(segStart, i).trim()
      if (item) parts.push(item)
      segStart = i + 1
    }
    i++
  }
  const tail = inside.slice(segStart).trim()
  if (tail) parts.push(tail)
  if (parts.length === 0) return raw

  const prefix = raw.slice(0, openIdx + 1).trimEnd()
  const suffix = raw.slice(closeIdx).trimStart()
  return `${prefix}\n  ${parts.join(',\n  ')}\n${suffix}`
}

export function buildCreateTableSql(tableName, cols, driver, schema) {
  const cleanName = String(tableName || '').trim()
  if (!cleanName) throw new Error('Table name is required.')
  if (FORBIDDEN_DEFAULT_TOKENS_RE.test(cleanName)) throw new Error('Table name contains invalid characters.')
  if (!Array.isArray(cols) || cols.length === 0) throw new Error('At least one column is required.')
  const seen = new Set()
  const pkCols = []
  const colLines = []
  for (const col of cols) {
    const cn = String(col.name || '').trim()
    if (!cn) throw new Error('Column name cannot be empty.')
    if (FORBIDDEN_DEFAULT_TOKENS_RE.test(cn)) throw new Error(`Column "${cn}" contains invalid characters.`)
    const key = cn.toLowerCase()
    if (seen.has(key)) throw new Error(`Duplicate column name "${cn}".`)
    seen.add(key)
    const ct = validatePanelTypeSpec(col.dataType)
    if (col.isPrimaryKey) pkCols.push(cn)
    let line = `${quoteIdent(cn, driver)} ${ct}`
    if (!col.nullable && !col.isPrimaryKey) line += ' NOT NULL'
    const defVal = String(col.defaultValue || '').trim()
    if (defVal) line += ` DEFAULT ${normalizePanelDefaultExpr(defVal, ct)}`
    colLines.push(line)
  }
  if (driver !== 'clickhouse') {
    if (pkCols.length === 1) {
      const idx = cols.findIndex((c) => c.isPrimaryKey)
      if (idx >= 0) colLines[idx] += ' PRIMARY KEY'
    } else if (pkCols.length > 1) {
      colLines.push(`PRIMARY KEY (${pkCols.map((p) => quoteIdent(p, driver)).join(', ')})`)
    }
  }
  const qTable = quoteTableRef(cleanName, schema, driver)
  if (driver === 'clickhouse') {
    const orderBy = pkCols.length > 0 ? `(${pkCols.map((p) => quoteIdent(p, driver)).join(', ')})` : 'tuple()'
    return `CREATE TABLE ${qTable} (\n  ${colLines.join(',\n  ')}\n) ENGINE = MergeTree()\nORDER BY ${orderBy};`
  }
  return `CREATE TABLE ${qTable} (\n  ${colLines.join(',\n  ')}\n);`
}

export function buildTruncateOrDropSql(action, obj, driver) {
  const qTable = quoteTableRef(obj.name, obj.schema, driver)
  if (action === 'truncate') {
    if (driver === 'sqlite' || driver === 'libsql' || driver === 'd1') {
      return `DELETE FROM ${qTable};`
    }
    return `TRUNCATE TABLE ${qTable};`
  }
  return obj.kind === 'view' ? `DROP VIEW ${qTable};` : `DROP TABLE ${qTable};`
}

// ============================================================================
// Pure Visual Structure Designer Validators & Migration SQL Builders
// ============================================================================

export const findPanelTopLevelCastIdx = sharedFindTopLevelPostgresCastIndex
export const panelHasBalancedParens = sharedHasBalancedParens
export const isPanelNumericOrBoolType = sharedIsNumericOrBooleanTypeName
export const validatePanelTypeSpec = sharedValidateColumnTypeSpec
export const normalizePanelDefaultExpr = sharedNormalizeSqlDefaultExpression

export function createPanelStructDraft(details) {
  const columns = (details.columns || []).map((c, idx) => {
    const defVal = c.defaultValue !== undefined && c.defaultValue !== null ? String(c.defaultValue) : ''
    return {
      id: `pcol_${idx}_${c.name}`,
      originalName: c.name,
      name: c.name,
      dataType: c.nativeType || c.type || 'TEXT',
      nullable: c.nullable !== false,
      defaultValue: defVal,
      isPrimaryKey: Boolean(c.isPrimaryKey),
      isAutoIncrement: Boolean(c.isAutoIncrement),
      status: 'existing',
      originalDataType: c.nativeType || c.type || 'TEXT',
      originalNullable: c.nullable !== false,
      originalDefaultValue: defVal,
      originalIsPrimaryKey: Boolean(c.isPrimaryKey),
    }
  })
  const colIdByName = new Map(columns.map((c) => [c.name, c.id]))
  return {
    originalTableName: details.name,
    tableName: details.name,
    schema: details.schema,
    columns,
    indexes: (details.indexes || []).map((idxInfo, idx) => ({
      id: `pidx_${idx}_${idxInfo.name}`,
      originalName: idxInfo.name,
      name: idxInfo.name,
      columns: [...(idxInfo.columns || [])],
      columnRefs: (idxInfo.columns || []).map((cn) => ({
        colId: colIdByName.get(cn) || null,
        fallbackName: cn,
      })),
      unique: Boolean(idxInfo.isUnique ?? idxInfo.unique),
      isPrimary: Boolean(idxInfo.isPrimary),
      status: 'existing',
    })),
    foreignKeys: (details.foreignKeys || []).map((fk, idx) => ({
      id: `pfk_${idx}_${fk.column}_${fk.referencedTable || fk.foreignTable || ''}`,
      constraintName: fk.constraintName || `fk_${details.name}_${fk.column}`,
      columnId: colIdByName.get(fk.column) || null,
      column: fk.column,
      foreignTable: fk.referencedTable || fk.foreignTable || '',
      foreignColumn: fk.referencedColumn || fk.foreignColumn || 'id',
      onDelete: (fk.onDelete || 'NO ACTION').toUpperCase(),
      onUpdate: (fk.onUpdate || 'NO ACTION').toUpperCase(),
      status: 'existing',
    })),
  }
}

export function getIndexColNames(draft, idx) {
  if (!draft || !idx) return []
  if (Array.isArray(idx.columnRefs)) {
    const colById = new Map(draft.columns.map((c) => [c.id, c]))
    const names = []
    for (const ref of idx.columnRefs) {
      if (ref.colId) {
        const c = colById.get(ref.colId)
        if (c) {
          const nm = String(c.status === 'deleted' ? c.originalName || c.name : c.name || '').trim()
          if (nm) names.push(nm)
        }
      } else if (ref.fallbackName) {
        names.push(ref.fallbackName)
      }
    }
    return names
  }
  return (idx.columns || []).filter(Boolean)
}

export function getActiveIndexColNames(draft, idx) {
  if (!draft || !idx) return []
  if (Array.isArray(idx.columnRefs)) {
    const activeColById = new Map(draft.columns.filter((c) => c.status !== 'deleted').map((c) => [c.id, c]))
    const activeNames = new Set(
      draft.columns.filter((c) => c.status !== 'deleted').map((c) => String(c.name || '').trim().toLowerCase())
    )
    const names = []
    for (const ref of idx.columnRefs) {
      if (ref.colId) {
        const c = activeColById.get(ref.colId)
        const nm = c ? String(c.name || '').trim() : ''
        if (nm) names.push(nm)
      } else if (ref.fallbackName && activeNames.has(String(ref.fallbackName).trim().toLowerCase())) {
        names.push(String(ref.fallbackName).trim())
      }
    }
    return names
  }
  return (idx.columns || []).filter(Boolean)
}

export function getFkColName(draft, fk) {
  if (!draft || !fk) return ''
  if (fk.columnId) {
    const c = draft.columns.find((col) => col.id === fk.columnId)
    if (c) return String(c.status === 'deleted' ? c.originalName || c.name : c.name || '').trim()
  }
  return String(fk.column || '').trim()
}

export function isPanelColDirty(col) {
  if (col.status !== 'existing') return true
  const origType = (col.originalDataType || 'TEXT').trim().toUpperCase()
  const curType = (col.dataType || 'TEXT').trim().toUpperCase()
  const origDef = (col.originalDefaultValue || '').trim()
  const curDef = (col.defaultValue || '').trim()
  let defEq = origDef === curDef
  if (!defEq && curDef) {
    try { defEq = normalizePanelDefaultExpr(curDef, curType) === origDef } catch {}
  }
  return (
    col.name.trim() !== (col.originalName || '').trim() ||
    origType !== curType ||
    Boolean(col.nullable) !== Boolean(col.originalNullable) ||
    Boolean(col.isPrimaryKey) !== Boolean(col.originalIsPrimaryKey) ||
    !defEq
  )
}

export function countPanelStructChanges(draft) {
  if (!draft) return 0
  let count = 0
  if (draft.tableName.trim() && draft.tableName.trim() !== draft.originalTableName.trim()) {
    count++
  }
  for (const c of draft.columns) {
    if (c.status === 'existing') {
      const origDef = String(c.originalDefaultValue || '').trim()
      const curDef = String(c.defaultValue || '').trim()
      const origType = String(c.originalDataType || 'TEXT').trim().toUpperCase()
      const curType = String(c.dataType || 'TEXT').trim().toUpperCase()
      const isUntouchedExistingDef = curDef === origDef && curType === origType
      let defEq = curDef === origDef
      if (!defEq && curDef) {
        try { defEq = normalizePanelDefaultExpr(curDef, curType) === origDef } catch {}
      }
      let isDirty = false
      try {
        const origSpec = validatePanelTypeSpec(c.originalDataType || 'TEXT').toUpperCase()
        const curSpec = validatePanelTypeSpec(c.dataType).toUpperCase()
        isDirty =
          c.name.trim() !== (c.originalName || '').trim() ||
          origSpec !== curSpec ||
          Boolean(c.nullable) !== Boolean(c.originalNullable) ||
          Boolean(c.isPrimaryKey) !== Boolean(c.originalIsPrimaryKey) ||
          (!isUntouchedExistingDef && !defEq)
      } catch {
        isDirty = true
      }
      if (isDirty) count++
    } else if (c.status === 'new' || c.status === 'deleted') {
      count++
    }
  }
  for (const idx of draft.indexes) {
    if (idx.status === 'new' || idx.status === 'deleted') count++
  }
  for (const fk of draft.foreignKeys) {
    if (fk.status === 'new' || fk.status === 'deleted') count++
  }
  return count
}

export function requiresPanelSqliteRebuild(draft) {
  const hasDefChange = draft.columns.some((col) => {
    if (col.status !== 'existing') return false
    const origType = (col.originalDataType || 'TEXT').trim().toUpperCase()
    const curType = (col.dataType || 'TEXT').trim().toUpperCase()
    const origDef = (col.originalDefaultValue || '').trim()
    const curDef = (col.defaultValue || '').trim()
    let defEq = origDef === curDef
    if (!defEq && curDef) {
      try { defEq = normalizePanelDefaultExpr(curDef, curType) === origDef } catch {}
    }
    return (
      origType !== curType ||
      Boolean(col.nullable) !== Boolean(col.originalNullable) ||
      Boolean(col.isPrimaryKey) !== Boolean(col.originalIsPrimaryKey) ||
      !defEq
    )
  })
  const droppedIds = new Set(draft.columns.filter((c) => c.status === 'deleted').map((c) => c.id))
  const droppedSet = new Set(
    draft.columns
      .filter((c) => c.status === 'deleted')
      .map((c) => (c.originalName || c.name).trim())
      .filter(Boolean)
  )
  const hasNewPk = draft.columns.some((c) => c.status === 'new' && c.isPrimaryKey)
  const hasDropPk = draft.columns.some((c) => c.status === 'deleted' && c.originalIsPrimaryKey)
  const hasDropIdxCol = draft.indexes.some((i) => {
    if (i.status === 'deleted') return false
    if (Array.isArray(i.columnRefs)) {
      return i.columnRefs.some((ref) => (ref.colId ? droppedIds.has(ref.colId) : droppedSet.has(ref.fallbackName)))
    }
    return (i.columns || []).some((cn) => droppedSet.has(cn))
  })
  const hasFkChg = draft.foreignKeys.some((fk) => fk.status === 'new' || fk.status === 'deleted')
  return hasDefChange || hasNewPk || hasDropPk || hasDropIdxCol || hasFkChg
}

export function buildPanelMigrationSql(draft, driver) {
  if (!draft || driver === 'redis') return []
  const count = countPanelStructChanges(draft)
  if (count === 0) return []
  const origTable = draft.originalTableName.trim()
  const finalTable = (draft.tableName || origTable).trim()
  if (!origTable || !finalTable) throw new Error('Table name is required.')

  const activeColsCheck = draft.columns.filter((c) => c.status !== 'deleted')
  if (activeColsCheck.length === 0) throw new Error('Table must keep at least one column.')
  const seenActive = new Set()
  for (const c of activeColsCheck) {
    const cn = String(c.name || '').trim()
    if (!cn) throw new Error('Column name cannot be empty.')
    if (seenActive.has(cn.toLowerCase())) throw new Error(`Duplicate column name "${cn}".`)
    seenActive.add(cn.toLowerCase())
  }

  if ((driver === 'sqlite' || driver === 'libsql') && requiresPanelSqliteRebuild(draft)) {
    const activeCols = activeColsCheck
    const pkCols = activeCols.filter((c) => c.isPrimaryKey)
    const singlePk = pkCols.length === 1
    const colDefs = []

    for (const col of activeCols) {
      const cn = col.name.trim()
      const ct = validatePanelTypeSpec(col.dataType)
      let line = `${quoteIdent(cn, driver)} ${ct}`
      if (singlePk && col.isPrimaryKey) {
        line += ' PRIMARY KEY'
        if (col.isAutoIncrement && /INT/i.test(ct)) line += ' AUTOINCREMENT'
      }
      if (!col.nullable && !(singlePk && col.isPrimaryKey)) line += ' NOT NULL'
      const defVal = String(col.defaultValue || '').trim()
      const origDef = String(col.originalDefaultValue || '').trim()
      const isUntouchedExistingDef =
        col.status === 'existing' &&
        defVal === origDef &&
        String(col.dataType || '').trim().toUpperCase() === String(col.originalDataType || '').trim().toUpperCase()
      if (defVal) line += ` DEFAULT ${isUntouchedExistingDef ? defVal : normalizePanelDefaultExpr(defVal, ct)}`
      colDefs.push(line)
    }

    if (pkCols.length > 1) {
      colDefs.push(`PRIMARY KEY (${pkCols.map((c) => quoteIdent(c.name.trim(), driver)).join(', ')})`)
    }

    for (const fk of draft.foreignKeys.filter((f) => f.status !== 'deleted')) {
      const col = getFkColName(draft, fk)
      const refTbl = String(fk.foreignTable || '').trim()
      const refCol = String(fk.foreignColumn || '').trim()
      if (!col || !refTbl || !refCol) throw new Error('Foreign key requires local column, target table, and target column.')
      const fkName =
        String(fk.constraintName || '').trim() || `fk_${finalTable}_${col}_${refTbl}`.replace(/[^A-Za-z0-9_]/g, '_')
      const onDeleteNorm = PANEL_REF_ACTIONS.has(String(fk.onDelete || '').toUpperCase())
        ? String(fk.onDelete).toUpperCase()
        : 'NO ACTION'
      const onDel = onDeleteNorm !== 'NO ACTION' ? ` ON DELETE ${onDeleteNorm}` : ''
      colDefs.push(
        `CONSTRAINT ${quoteIdent(fkName, driver)} FOREIGN KEY (${quoteIdent(col, driver)}) REFERENCES ${quoteIdent(refTbl, driver)} (${quoteIdent(refCol, driver)})${onDel}`
      )
    }

    const tmpName = `__datanoa_new_${origTable.replace(/[^A-Za-z0-9_]/g, '_')}`
    const qOrig = quoteTableRef(origTable, draft.schema, driver)
    const qTmp = quoteTableRef(tmpName, draft.schema, driver)
    const qFinalIdent = quoteIdent(finalTable, driver)
    const qFinalFull = quoteTableRef(finalTable, draft.schema, driver)
    const stmts = [
      'PRAGMA foreign_keys = OFF;',
      'BEGIN IMMEDIATE;',
      `CREATE TABLE ${qTmp} (\n  ${colDefs.join(',\n  ')}\n);`,
    ]

    const surviving = activeCols.filter((c) => c.status === 'existing' && c.originalName)
    if (surviving.length > 0) {
      const targetList = surviving.map((c) => quoteIdent(c.name.trim(), driver)).join(', ')
      const srcList = surviving
        .map((c) => {
          const qOld = quoteIdent(c.originalName.trim(), driver)
          const defVal = String(c.defaultValue || '').trim()
          if (!c.nullable && c.originalNullable && defVal) {
            return `COALESCE(${qOld}, ${normalizePanelDefaultExpr(defVal, c.dataType)})`
          }
          return qOld
        })
        .join(', ')
      stmts.push(`INSERT INTO ${qTmp} (${targetList}) SELECT ${srcList} FROM ${qOrig};`)
    }

    stmts.push(`DROP TABLE ${qOrig};`)
    stmts.push(`ALTER TABLE ${qTmp} RENAME TO ${qFinalIdent};`)

    for (const idx of draft.indexes.filter(
      (i) => i.status !== 'deleted' && !i.isPrimary && !/^sqlite_autoindex_/i.test(i.name)
    )) {
      const cols = getActiveIndexColNames(draft, idx)
      if (cols.length === 0) continue
      const idxName =
        String(idx.name || '').trim() || `idx_${finalTable}_${cols.join('_')}`.replace(/[^A-Za-z0-9_]/g, '_')
      const uniqKw = idx.unique ? 'UNIQUE ' : ''
      stmts.push(
        `CREATE ${uniqKw}INDEX IF NOT EXISTS ${quoteIdent(idxName, driver)} ON ${qFinalFull} (${cols
          .map((c) => quoteIdent(c, driver))
          .join(', ')});`
      )
    }

    stmts.push('COMMIT;')
    stmts.push('PRAGMA foreign_keys = ON;')
    return stmts
  }

  const stmts = []
  const curTbl = origTable
  const qCur = () => quoteTableRef(curTbl, draft.schema, driver)

  for (const fk of draft.foreignKeys) {
    if (fk.status === 'deleted' && fk.constraintName) {
      stmts.push(
        driver === 'mysql' || driver === 'mariadb'
          ? `ALTER TABLE ${qCur()} DROP FOREIGN KEY ${quoteIdent(fk.constraintName, driver)};`
          : `ALTER TABLE ${qCur()} DROP CONSTRAINT ${quoteIdent(fk.constraintName, driver)};`
      )
    }
  }

  for (const idx of draft.indexes) {
    if (idx.status === 'deleted' && (idx.originalName || idx.name)) {
      const qIdx = quoteIdent(idx.originalName || idx.name, driver)
      stmts.push(
        driver === 'mysql' || driver === 'mariadb'
          ? `DROP INDEX ${qIdx} ON ${qCur()};`
          : driver === 'clickhouse'
            ? `ALTER TABLE ${qCur()} DROP INDEX ${qIdx};`
            : `DROP INDEX ${qIdx};`
      )
    }
  }

  for (const col of draft.columns) {
    if (col.status === 'deleted' && (col.originalName || col.name)) {
      stmts.push(`ALTER TABLE ${qCur()} DROP COLUMN ${quoteIdent(col.originalName || col.name, driver)};`)
    }
  }

  let pkMembershipChanged = false
  for (const col of draft.columns) {
    if (col.status === 'new' && col.isPrimaryKey) pkMembershipChanged = true
    if (col.status === 'deleted' && col.originalIsPrimaryKey) pkMembershipChanged = true
    if (col.status === 'existing' && Boolean(col.isPrimaryKey) !== Boolean(col.originalIsPrimaryKey)) pkMembershipChanged = true
    if (col.status !== 'existing') continue
    const oldName = (col.originalName || col.name).trim()
    const newName = col.name.trim()
    if (!newName) throw new Error('Column name cannot be empty.')
    if (oldName !== newName) {
      stmts.push(`ALTER TABLE ${qCur()} RENAME COLUMN ${quoteIdent(oldName, driver)} TO ${quoteIdent(newName, driver)};`)
    }
    const origType = (col.originalDataType || 'TEXT').trim().toUpperCase()
    const curType = validatePanelTypeSpec(col.dataType).toUpperCase()
    const origDef = (col.originalDefaultValue || '').trim()
    const curDef = (col.defaultValue || '').trim()
    let defEq = origDef === curDef
    if (!defEq && curDef) {
      try { defEq = normalizePanelDefaultExpr(curDef, curType) === origDef } catch {}
    }
    if (origType !== curType || Boolean(col.nullable) !== Boolean(col.originalNullable) || !defEq) {
      const qCol = quoteIdent(newName, driver)
      if (driver === 'postgres' || driver === 'cockroachdb') {
        const cls = []
        if (origType !== curType) cls.push(`ALTER COLUMN ${qCol} TYPE ${validatePanelTypeSpec(col.dataType)}`)
        if (Boolean(col.nullable) !== Boolean(col.originalNullable)) {
          cls.push(`ALTER COLUMN ${qCol} ${col.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`)
        }
        if (!defEq) {
          cls.push(
            curDef
              ? `ALTER COLUMN ${qCol} SET DEFAULT ${normalizePanelDefaultExpr(curDef, curType)}`
              : `ALTER COLUMN ${qCol} DROP DEFAULT`
          )
        }
        if (cls.length) stmts.push(`ALTER TABLE ${qCur()} ${cls.join(', ')};`)
      } else if (driver === 'mysql' || driver === 'mariadb') {
        const nullCls = col.nullable === false ? ' NOT NULL' : ' NULL'
        const isUntouchedExistingDef = col.status === 'existing' && curDef === origDef && origType === curType
        const defCls = curDef
          ? ` DEFAULT ${isUntouchedExistingDef ? curDef : normalizePanelDefaultExpr(curDef, curType)}`
          : col.nullable !== false
            ? ' DEFAULT NULL'
            : ''
        stmts.push(`ALTER TABLE ${qCur()} MODIFY COLUMN ${qCol} ${validatePanelTypeSpec(col.dataType)}${nullCls}${defCls};`)
      } else if (driver === 'clickhouse') {
        const isUntouchedExistingDef = col.status === 'existing' && curDef === origDef && origType === curType
        const defCls = curDef
          ? ` DEFAULT ${isUntouchedExistingDef ? curDef : normalizePanelDefaultExpr(curDef, curType)}`
          : ''
        stmts.push(`ALTER TABLE ${qCur()} MODIFY COLUMN ${qCol} ${validatePanelTypeSpec(col.dataType)}${defCls};`)
      }
    }
  }

  for (const col of draft.columns) {
    if (col.status !== 'new') continue
    const cn = col.name.trim()
    const ct = validatePanelTypeSpec(col.dataType)
    const qCol = quoteIdent(cn, driver)
    const defVal = String(col.defaultValue || '').trim()
    let defCls = defVal ? ` DEFAULT ${normalizePanelDefaultExpr(defVal, ct)}` : ''
    if (!defCls && col.nullable === false && (driver === 'sqlite' || driver === 'libsql')) {
      defCls = /INT|REAL|FLOAT|NUMERIC|DECIMAL|BOOL/i.test(ct) ? ' DEFAULT 0' : " DEFAULT ''"
    }
    stmts.push(`ALTER TABLE ${qCur()} ADD COLUMN ${qCol} ${ct}${col.nullable === false ? ' NOT NULL' : ''}${defCls};`)
  }

  if (pkMembershipChanged) {
    if (driver === 'clickhouse') throw new Error('Modifying PRIMARY KEY in place is not supported on ClickHouse.')
    const nextPkCols = activeColsCheck.filter((c) => c.isPrimaryKey).map((c) => quoteIdent(c.name.trim(), driver))
    const hadOrigPk = draft.columns.some((c) => c.status !== 'new' && c.originalIsPrimaryKey)
    if (driver === 'postgres' || driver === 'cockroachdb') {
      if (hadOrigPk) {
        const pkConstraint = draft.indexes.find((i) => i.isPrimary)?.name || `${curTbl}_pkey`
        stmts.push(`ALTER TABLE ${qCur()} DROP CONSTRAINT IF EXISTS ${quoteIdent(pkConstraint, driver)};`)
      }
      if (nextPkCols.length) stmts.push(`ALTER TABLE ${qCur()} ADD PRIMARY KEY (${nextPkCols.join(', ')});`)
    } else if (driver === 'mysql' || driver === 'mariadb') {
      if (hadOrigPk) stmts.push(`ALTER TABLE ${qCur()} DROP PRIMARY KEY;`)
      if (nextPkCols.length) stmts.push(`ALTER TABLE ${qCur()} ADD PRIMARY KEY (${nextPkCols.join(', ')});`)
    }
  }

  for (const idx of draft.indexes) {
    if (idx.status !== 'new') continue
    const cols = getActiveIndexColNames(draft, idx)
    if (!cols.length) throw new Error('Index must select at least one column.')
    const idxName =
      String(idx.name || '').trim() || `idx_${curTbl}_${cols.join('_')}`.replace(/[^A-Za-z0-9_]/g, '_')
    if (driver === 'clickhouse') {
      stmts.push(
        `ALTER TABLE ${qCur()} ADD INDEX ${quoteIdent(idxName, driver)} (${cols
          .map((c) => quoteIdent(c, driver))
          .join(', ')}) TYPE minmax GRANULARITY 1;`
      )
    } else {
      stmts.push(
        `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(idxName, driver)} ON ${qCur()} (${cols
          .map((c) => quoteIdent(c, driver))
          .join(', ')});`
      )
    }
  }

  for (const fk of draft.foreignKeys) {
    if (fk.status !== 'new') continue
    const col = getFkColName(draft, fk)
    const refTbl = String(fk.foreignTable || '').trim()
    const refCol = String(fk.foreignColumn || '').trim()
    if (!col || !refTbl || !refCol) throw new Error('Foreign key requires local column, target table, and target column.')
    const fkName =
      String(fk.constraintName || '').trim() || `fk_${curTbl}_${col}_${refTbl}`.replace(/[^A-Za-z0-9_]/g, '_')
    const onDeleteNorm = PANEL_REF_ACTIONS.has(String(fk.onDelete || '').toUpperCase())
      ? String(fk.onDelete).toUpperCase()
      : 'NO ACTION'
    const onDel = onDeleteNorm !== 'NO ACTION' ? ` ON DELETE ${onDeleteNorm}` : ''
    stmts.push(
      `ALTER TABLE ${qCur()} ADD CONSTRAINT ${quoteIdent(fkName, driver)} FOREIGN KEY (${quoteIdent(col, driver)}) REFERENCES ${quoteTableRef(refTbl, draft.schema, driver)} (${quoteIdent(refCol, driver)})${onDel};`
    )
  }

  if (finalTable !== curTbl) {
    if (driver === 'mysql' || driver === 'mariadb' || driver === 'clickhouse') {
      stmts.push(`RENAME TABLE ${qCur()} TO ${quoteTableRef(finalTable, draft.schema, driver)};`)
    } else {
      stmts.push(`ALTER TABLE ${qCur()} RENAME TO ${quoteIdent(finalTable, driver)};`)
    }
  }

  return stmts
}

export function validatePanelStructDraft(draft, driver, knownTableNames = []) {
  const errors = []
  const warnings = []
  const diffs = []
  if (!draft) return { valid: false, errors: [], warnings: [], diffs: [], statements: [] }

  const origTbl = String(draft.originalTableName || '').trim()
  const nextTbl = String(draft.tableName || '').trim()
  if (!nextTbl) errors.push('Table name cannot be empty.')
  else if (FORBIDDEN_DEFAULT_TOKENS_RE.test(nextTbl) || nextTbl.includes('\0')) {
    errors.push('Table name contains invalid characters.')
  } else if (nextTbl !== origTbl) {
    diffs.push(`Rename table: "${origTbl}" -> "${nextTbl}"`)
    warnings.push(`Renaming "${origTbl}" to "${nextTbl}" may break queries referencing the old name.`)
  }

  const activeCols = draft.columns.filter((c) => c.status !== 'deleted')
  if (activeCols.length === 0) errors.push('Table must keep at least one active column.')

  const seenCols = new Map()
  for (const col of draft.columns) {
    const cn = String(col.name || '').trim()
    if (col.status === 'deleted') {
      const tgt = (col.originalName || cn).trim()
      diffs.push(`- Drop column "${tgt}"`)
      warnings.push(`Dropping column "${tgt}" permanently deletes all stored values in that column.`)
      continue
    }
    if (!cn) errors.push('Column name cannot be empty.')
    else if (FORBIDDEN_DEFAULT_TOKENS_RE.test(cn)) errors.push(`Column "${cn}" contains invalid SQL characters.`)
    else {
      const key = cn.toLowerCase()
      const cCount = (seenCols.get(key) || 0) + 1
      seenCols.set(key, cCount)
      if (cCount === 2) errors.push(`Duplicate column name "${cn}".`)
    }
    try { validatePanelTypeSpec(col.dataType) } catch (err) { errors.push(err?.message || 'Invalid column type.') }
    const rawDef = String(col.defaultValue || '').trim()
    const origDef = String(col.originalDefaultValue || '').trim()
    const isUntouchedExistingDef =
      col.status === 'existing' &&
      rawDef === origDef &&
      String(col.dataType || '').trim().toUpperCase() === String(col.originalDataType || '').trim().toUpperCase()
    if (rawDef && !isUntouchedExistingDef) {
      try { normalizePanelDefaultExpr(rawDef, col.dataType) } catch (err) { errors.push(err?.message || 'Invalid default value.') }
    }
    if (col.status === 'new') {
      diffs.push(`+ Add column "${cn || '(unnamed)'}" ${col.dataType}${col.nullable ? '' : ' NOT NULL'}${rawDef ? ` DEFAULT ${rawDef}` : ''}`)
    } else if (isPanelColDirty(col)) {
      diffs.push(`~ Modify column "${cn || col.originalName}"`)
    }
  }

  const activeSet = new Set(activeCols.map((c) => c.name.trim()).filter(Boolean))
  const activeColById = new Map(activeCols.map((c) => [c.id, c]))
  const seenIdx = new Map()
  for (const idx of draft.indexes) {
    const idxName = String(idx.name || '').trim()
    if (idx.status === 'deleted') {
      diffs.push(`- Drop index "${idx.originalName || idx.name}"`)
      warnings.push(`Dropping index "${idx.originalName || idx.name}" removes index optimization.`)
      continue
    }
    const iCount = (seenIdx.get(idxName.toLowerCase()) || 0) + 1
    seenIdx.set(idxName.toLowerCase(), iCount)
    if (idx.status === 'new') {
      if (!idxName) errors.push('New index name cannot be empty.')
      else if (iCount === 2) errors.push(`Duplicate index name "${idxName}".`)
      const idxCols = getIndexColNames(draft, idx)
      if (idxCols.length === 0) {
        errors.push('New index requires at least one column.')
      } else {
        const missingCols = []
        if (Array.isArray(idx.columnRefs)) {
          for (const ref of idx.columnRefs) {
            if (ref.colId) {
              const activeC = activeColById.get(ref.colId)
              if (!activeC || !String(activeC.name || '').trim()) {
                const origC = draft.columns.find((c) => c.id === ref.colId)
                missingCols.push(String(origC?.originalName || origC?.name || ref.fallbackName || '(unnamed)').trim())
              }
            } else if (!activeSet.has(ref.fallbackName)) {
              missingCols.push(ref.fallbackName)
            }
          }
        } else {
          for (const c of idxCols) {
            if (!activeSet.has(c)) missingCols.push(c)
          }
        }
        if (missingCols.length) {
          errors.push(`Index "${idxName}" references missing/dropped column(s): ${missingCols.join(', ')}.`)
        }
      }
      diffs.push(`+ Create ${idx.unique ? 'UNIQUE ' : ''}index "${idx.name}" (${idxCols.join(', ')})`)
    }
  }

  const connTables = new Set((Array.isArray(knownTableNames) ? knownTableNames : []).map((n) => String(n).toLowerCase()))
  for (const fk of draft.foreignKeys) {
    const col = getFkColName(draft, fk)
    if (fk.status === 'deleted') {
      diffs.push(`- Drop FK "${fk.constraintName || col}"`)
      warnings.push(`Dropping FK "${fk.constraintName || col}" disables referential checking.`)
    } else if (fk.status === 'new') {
      const refTbl = String(fk.foreignTable || '').trim()
      const refCol = String(fk.foreignColumn || '').trim()
      const fkColActive = fk.columnId ? activeColById.get(fk.columnId) : null
      const colValid = fk.columnId
        ? Boolean(fkColActive && String(fkColActive.name || '').trim())
        : Boolean(col && activeSet.has(col))
      if (!col || !colValid) errors.push(`FK local column "${col || '(none)'}" missing.`)
      if (!refTbl) errors.push('FK target table is required.')
      else if (connTables.size > 0 && !connTables.has(refTbl.toLowerCase())) {
        errors.push(`FK target table "${refTbl}" not found.`)
      }
      if (!refCol) errors.push('FK target column is required.')
      if (driver === 'clickhouse') errors.push('ClickHouse does not support FOREIGN KEY constraints.')
      diffs.push(`+ Add FK "${col}" -> "${refTbl}"("${refCol}")`)
    }
  }

  if ((driver === 'sqlite' || driver === 'libsql') && countPanelStructChanges(draft) > 0 && requiresPanelSqliteRebuild(draft)) {
    warnings.push('SQLite 12-Step Table Rebuild will recreate the table and copy surviving rows transactionally.')
  }

  let statements = []
  if (errors.length === 0 && diffs.length > 0) {
    try { statements = buildPanelMigrationSql(draft, driver) } catch (err) { errors.push(err?.message || String(err)) }
  }
  return { valid: errors.length === 0 && diffs.length > 0, errors, warnings, diffs, statements }
}

// ============================================================================
// Pure Privacy-Safe Feedback & GitHub Issue Report Builders
// ============================================================================

export function sanitizeFeedbackError(rawError) {
  return sharedSanitizeDiagnosticErrorText(rawError, { stripControlChars: true, ellipsis: true })
}

export function buildPanelFeedbackMarkdown({
  kind = 'bug',
  title = '',
  description = '',
  driver = '',
  tab = 'explorer',
  readOnly = false,
  orcaApi = '',
  platform = '',
  lastError = '',
  version = DATANOA_VERSION,
} = {}) {
  const normalizedKind = kind === 'feature' ? 'feature' : 'bug'
  const cleanTitle = String(title || '').trim()
  const cleanDesc = String(description || '').trim()
  const engineEntry = driver ? ENGINE_BY_ID[driver] : null
  const engineLabel = engineEntry ? `${engineEntry.label} (${engineEntry.id})` : driver ? String(driver) : 'None'
  const tabLabel = String(tab || 'explorer')
  const roLabel = readOnly ? 'Yes' : 'No'
  const apiLabel = String(orcaApi || 'v1').trim()
  const platformLabel = String(platform || 'unknown').trim()
  const safeErr = sanitizeFeedbackError(lastError)

  const lines = []
  if (cleanTitle) {
    lines.push(`## ${normalizedKind === 'feature' ? 'Feature Request' : 'Bug Report'}: ${cleanTitle}`, '')
  }
  lines.push(normalizedKind === 'feature' ? '### Proposal / Use Case' : '### Summary & Steps to Reproduce')
  lines.push(
    cleanDesc ||
      (normalizedKind === 'feature'
        ? '_Describe the workflow, feature, or UI improvement you would like to see._'
        : '_Describe what happened, what you expected, and how to reproduce the issue._')
  )
  lines.push('')
  lines.push('### Environment (Privacy-Safe)')
  lines.push(`- **Plugin:** Datanoa v${version}`)
  lines.push(`- **Orca API:** ${apiLabel}`)
  lines.push('- **Surface:** Side Panel')
  lines.push(`- **Active Engine:** ${engineLabel}`)
  lines.push(`- **Active Tab:** ${tabLabel}`)
  lines.push(`- **Read-Only:** ${roLabel}`)
  lines.push(`- **Platform:** ${platformLabel}`)

  if (normalizedKind === 'bug' && safeErr) {
    lines.push('')
    lines.push('### Last Sanitized Error')
    lines.push('```text')
    lines.push(safeErr)
    lines.push('```')
  }

  return lines.join('\n')
}

export function buildGithubIssueUrl({ kind = 'bug', title = '', markdownBody = '' } = {}) {
  const normalizedKind = kind === 'feature' ? 'feature' : 'bug'
  const prefix = normalizedKind === 'feature' ? '[Feature]: ' : '[Bug]: '
  const cleanTitle = String(title || '').trim()
  const finalTitle = cleanTitle
    ? /^\[(?:bug|feature)\]:/i.test(cleanTitle)
      ? cleanTitle
      : `${prefix}${cleanTitle}`
    : prefix

  const params = new URLSearchParams()
  params.set('template', normalizedKind === 'feature' ? 'feature_request.yml' : 'bug_report.yml')
  params.set('labels', normalizedKind === 'feature' ? 'enhancement' : 'bug')
  params.set('title', finalTitle)
  const trimmedBody = String(markdownBody || '').trim()
  if (trimmedBody) {
    const safeBody =
      trimmedBody.length > 3500
        ? `${trimmedBody.slice(0, 3450)}\n\n...(truncated — click "Copy Report" in Datanoa for full diagnostics)`
        : trimmedBody
    params.set('body', safeBody)
  }
  return `${DATANOA_GITHUB_ISSUES_URL}?${params.toString()}`
}

export {
  createPanelConsoleTabsManager,
  computePanelSqlCompletions,
  encodePanelTableSelectValue,
  decodePanelTableSelectValue,
} from './panel-sql-tabs.js'

