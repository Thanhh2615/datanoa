import type {
  ApplyChangesParams,
  ApplyChangesUpdate,
  DriverType,
  TableBrowseResult,
  TableDetails,
} from './driver'
import { SUPPORTED_DRIVERS } from './connection-uri'
import { formatSqlBinaryLiteral } from './sql-lexer'
import { quoteIdentForDialect, sanitizeFilterClause } from './sql-tools'
import { normalizeJsonValue } from '../../shared-sql-core.js'

const SUPPORTED_DRIVER_SET: ReadonlySet<string> = new Set(SUPPORTED_DRIVERS)
const BACKTICK_DIALECTS: ReadonlySet<DriverType> = new Set(['mysql', 'mariadb', 'clickhouse'])
const DOLLAR_PLACEHOLDER_DIALECTS: ReadonlySet<DriverType> = new Set(['postgres', 'cockroachdb'])

function isDriverType(value: string): value is DriverType {
  return SUPPORTED_DRIVER_SET.has(value)
}

/**
 * Quotes a table name with an optional schema qualifier according to dialect semantics.
 */
export function quoteQualifiedTable(
  table: string,
  schema: string | undefined,
  dialect: DriverType
): string {
  const trimmedSchema = schema?.trim()
  const omitSchema =
    !trimmedSchema ||
    ((dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1') && trimmedSchema.toLowerCase() === 'main')

  if (omitSchema) {
    return quoteIdentForDialect(table, dialect)
  }
  return `${quoteIdentForDialect(trimmedSchema, dialect)}.${quoteIdentForDialect(table, dialect)}`
}

/**
 * Quotes a SQL identifier (or qualified schema.identifier) for the given database dialect.
 * Preserves the legacy `(driver, identifier, schema?)` signature while also supporting `(identifier, dialect)`.
 */
export function quoteIdentifier(
  driver: DriverType,
  identifier: string,
  schema?: string
): string
export function quoteIdentifier(identifier: string, dialect: DriverType): string
export function quoteIdentifier(first: string, second: string, schema?: string): string {
  if (schema === undefined && isDriverType(second)) {
    return quoteIdentForDialect(first, second)
  }

  const dialect: DriverType = isDriverType(first) ? first : 'postgres'
  if (schema) {
    return quoteQualifiedTable(second, schema, dialect)
  }
  return quoteIdentForDialect(second, dialect)
}

export function makePlaceholder(driver: DriverType, index: number): string {
  if (DOLLAR_PLACEHOLDER_DIALECTS.has(driver)) {
    return `$${index}`
  }
  if (driver === 'mssql') {
    return `@p${index}`
  }
  if (driver === 'oracle') {
    return `:p${index}`
  }
  return '?'
}

/**
 * Formats a JavaScript value into a safely escaped SQL literal for preview rendering.
 */
export function formatSqlValue(value: unknown, dialect: DriverType): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') {
    return dialect === 'mssql' || dialect === 'oracle'
      ? value
        ? '1'
        : '0'
      : value
        ? 'TRUE'
        : 'FALSE'
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'bigint') return value.toString()

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return 'NULL'
    return formatSqlStringLiteral(value.toISOString(), dialect)
  }

  if (value instanceof ArrayBuffer) {
    const hex = Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, '0')).join('')
    return formatSqlBinaryLiteral(hex, dialect)
  }

  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    const hex = Array.from(view, (b) => b.toString(16).padStart(2, '0')).join('')
    return formatSqlBinaryLiteral(hex, dialect)
  }

  if (typeof value === 'object') {
    return formatSqlStringLiteral(JSON.stringify(normalizeJsonValue(value)), dialect)
  }

  return formatSqlStringLiteral(String(value), dialect)
}

function formatSqlStringLiteral(raw: string, dialect: DriverType): string {
  if (
    raw.includes('\0') &&
    (dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1')
  ) {
    const parts = raw.split('\0').map((seg) => `'${seg.replace(/'/g, "''")}'`)
    return parts.join(' || char(0) || ')
  }
  let escaped = raw
  if (BACKTICK_DIALECTS.has(dialect)) {
    escaped = escaped.replace(/\\/g, '\\\\').replace(/\0/g, '\\0')
  }
  escaped = escaped.replace(/'/g, "''")
  return `'${escaped}'`
}

export interface BuildUpdateOptions {
  driver: DriverType
  table: string
  schema?: string
  column: string
  newValue: unknown
  primaryKeys: Record<string, unknown>
  originalValue?: unknown
  originalColumnType?: string
}

export interface BuildUpdateResult {
  sql: string
  params: unknown[]
}

const APPROXIMATE_FLOAT_TYPE_REGEX =
  /\b(?:float|float4|float8|float32|float64|real|double(?:\s+precision)?|binary_float|binary_double)\b/i
const NON_EQUALITY_TYPE_SET: ReadonlySet<string> = new Set([
  'json',
  'jsonb',
  'xml',
  'xmltype',
  'geography',
  'geometry',
  'point',
  'polygon',
  'path',
  'box',
  'circle',
  'line',
  'lseg',
  'ntext',
  'image',
  'clob',
  'nclob',
  'blob',
  'tinyblob',
  'mediumblob',
  'longblob',
  'long',
  'long raw',
  'bfile',
  'bytea',
  'varbinary',
  'binary',
  'raw',
])
const BLOB_PLACEHOLDER_REGEX = /^\[BLOB\s+\d+\s*B\]$/i

function normalizeBaseColumnType(rawType: string): string {
  const withoutParens = rawType.trim().replace(/\([^)]*\)/g, '').trim()
  const dotIdx = withoutParens.lastIndexOf('.')
  const bare = dotIdx >= 0 ? withoutParens.slice(dotIdx + 1) : withoutParens
  return bare.replace(/^["`\[]|["`\]]$/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function canBindOptimisticLockValue(
  val: unknown,
  columnType?: string,
  driver?: DriverType
): boolean {
  if (val === undefined) return false
  if (typeof columnType === 'string' && columnType.trim().length > 0) {
    const normalizedType = columnType.trim()
    const baseType = normalizeBaseColumnType(normalizedType)
    if (
      APPROXIMATE_FLOAT_TYPE_REGEX.test(normalizedType) ||
      NON_EQUALITY_TYPE_SET.has(baseType) ||
      (driver === 'mssql' && baseType === 'text')
    ) {
      return false
    }
  }
  if (val === null) return true
  if (typeof val === 'object') return false
  if (typeof val === 'string' && BLOB_PLACEHOLDER_REGEX.test(val.trim())) return false
  return true
}

export function buildUpdateSql(options: BuildUpdateOptions): BuildUpdateResult {
  const {
    driver,
    table,
    schema,
    column,
    newValue,
    primaryKeys,
    originalValue,
    originalColumnType,
  } = options

  if (!table || typeof table !== 'string') {
    throw new Error('Table name is required for buildUpdateSql')
  }
  if (!column || typeof column !== 'string') {
    throw new Error('Column name is required for buildUpdateSql')
  }
  const pkEntries = Object.entries(primaryKeys || {})
  if (pkEntries.length === 0) {
    throw new Error(
      'Cannot generate UPDATE statement without primary key conditions (safety guard)'
    )
  }
  for (const [pkCol, pkVal] of pkEntries) {
    if (pkVal === undefined) {
      throw new Error(
        `Cannot generate UPDATE statement with undefined primary key value for "${pkCol}" (safety guard)`
      )
    }
  }

  const params: unknown[] = []
  let paramIdx = 1

  const quotedTable = quoteQualifiedTable(table, schema, driver)
  const quotedCol = quoteIdentForDialect(column, driver)

  params.push(newValue)
  const setClause = `${quotedCol} = ${makePlaceholder(driver, paramIdx++)}`

  const whereClauses: string[] = []
  for (const [pkCol, pkVal] of pkEntries) {
    const quotedPk = quoteIdentForDialect(pkCol, driver)
    if (pkVal === null) {
      whereClauses.push(`${quotedPk} IS NULL`)
    } else {
      whereClauses.push(`${quotedPk} = ${makePlaceholder(driver, paramIdx++)}`)
      params.push(pkVal)
    }
  }

  if (canBindOptimisticLockValue(originalValue, originalColumnType, driver)) {
    if (originalValue === null) {
      whereClauses.push(`${quotedCol} IS NULL`)
    } else {
      whereClauses.push(`${quotedCol} = ${makePlaceholder(driver, paramIdx++)}`)
      params.push(originalValue)
    }
  }

  const sql = `UPDATE ${quotedTable} SET ${setClause} WHERE ${whereClauses.join(' AND ')}`
  return { sql, params }
}

export interface BuildSelectByPrimaryKeyOptions {
  driver: DriverType
  table: string
  schema?: string
  primaryKeys: Record<string, unknown>
  editedColumn?: string
  newValue?: unknown
}

export function buildSelectByPrimaryKeySql(
  options: BuildSelectByPrimaryKeyOptions
): { sql: string; params: unknown[] } | null {
  const { driver, table, schema, primaryKeys, editedColumn, newValue } = options
  const entries = Object.entries(primaryKeys || {})
  if (entries.length === 0) return null

  const whereParts: string[] = []
  const params: unknown[] = []
  let paramIdx = 1

  for (const [pkCol, rawPkVal] of entries) {
    const effectivePkVal =
      editedColumn !== undefined && pkCol === editedColumn ? newValue : rawPkVal
    if (effectivePkVal === undefined) {
      return null
    }
    const quotedPk = quoteIdentForDialect(pkCol, driver)
    if (effectivePkVal === null) {
      whereParts.push(`${quotedPk} IS NULL`)
    } else {
      whereParts.push(`${quotedPk} = ${makePlaceholder(driver, paramIdx++)}`)
      params.push(effectivePkVal)
    }
  }

  const quotedTable = quoteQualifiedTable(table, schema, driver)
  return {
    sql: `SELECT * FROM ${quotedTable} WHERE ${whereParts.join(' AND ')}`,
    params,
  }
}

export interface ParameterizedStatement {
  sql: string
  params: unknown[]
  previewSql: string
}

export interface BuildInsertOptions {
  driver: DriverType
  table: string
  schema?: string
  row: Record<string, unknown>
}

/**
 * Builds a parameterized INSERT statement and its rendered preview SQL.
 */
export function buildInsertStatement(options: BuildInsertOptions): ParameterizedStatement {
  const { driver, table, schema, row } = options
  if (!table || typeof table !== 'string') {
    throw new Error('Table name is required for buildInsertStatement')
  }

  const quotedTable = quoteQualifiedTable(table, schema, driver)
  const entries = Object.entries(row || {}).filter(([, val]) => val !== undefined)

  if (entries.length === 0) {
    if (driver === 'oracle') {
      throw new Error(
        'Oracle does not support empty INSERT statements without columns; provide at least one column value.'
      )
    }
    const emptySql =
      driver === 'clickhouse'
        ? `INSERT INTO ${quotedTable} VALUES ()`
        : BACKTICK_DIALECTS.has(driver)
          ? `INSERT INTO ${quotedTable} () VALUES ()`
          : `INSERT INTO ${quotedTable} DEFAULT VALUES`
    return {
      sql: emptySql,
      params: [],
      previewSql: `${emptySql};`,
    }
  }

  const colsSql = entries.map(([col]) => quoteIdentForDialect(col, driver)).join(', ')
  const placeholders = entries.map((_, i) => makePlaceholder(driver, i + 1)).join(', ')
  const params = entries.map(([, val]) => val)
  const previewValues = entries.map(([, val]) => formatSqlValue(val, driver)).join(', ')

  return {
    sql: `INSERT INTO ${quotedTable} (${colsSql}) VALUES (${placeholders})`,
    params,
    previewSql: `INSERT INTO ${quotedTable} (${colsSql}) VALUES (${previewValues});`,
  }
}

export interface BuildDeleteOptions {
  driver: DriverType
  table: string
  schema?: string
  primaryKeys: Record<string, unknown>
}

/**
 * Builds a parameterized DELETE statement guarded by primary key conditions.
 */
export function buildDeleteStatement(options: BuildDeleteOptions): ParameterizedStatement {
  const { driver, table, schema, primaryKeys } = options
  if (!table || typeof table !== 'string') {
    throw new Error('Table name is required for buildDeleteStatement')
  }
  const rawPkEntries = Object.entries(primaryKeys || {})
  if (rawPkEntries.length === 0) {
    throw new Error(
      'Cannot generate DELETE statement without primary key conditions (safety guard)'
    )
  }
  for (const [pkCol, pkVal] of rawPkEntries) {
    if (pkVal === undefined) {
      throw new Error(
        `Cannot generate DELETE statement with undefined primary key value for "${pkCol}" (safety guard)`
      )
    }
  }
  const pkEntries = rawPkEntries

  const quotedTable = quoteQualifiedTable(table, schema, driver)
  const params: unknown[] = []
  const whereClauses: string[] = []
  const previewClauses: string[] = []
  let paramIdx = 1

  for (const [pkCol, pkVal] of pkEntries) {
    const quotedPk = quoteIdentForDialect(pkCol, driver)
    if (pkVal === null) {
      whereClauses.push(`${quotedPk} IS NULL`)
      previewClauses.push(`${quotedPk} IS NULL`)
    } else {
      whereClauses.push(`${quotedPk} = ${makePlaceholder(driver, paramIdx++)}`)
      params.push(pkVal)
      previewClauses.push(`${quotedPk} = ${formatSqlValue(pkVal, driver)}`)
    }
  }

  return {
    sql: `DELETE FROM ${quotedTable} WHERE ${whereClauses.join(' AND ')}`,
    params,
    previewSql: `DELETE FROM ${quotedTable} WHERE ${previewClauses.join(' AND ')};`,
  }
}

/**
 * Projects full row objects down to primary key predicates (or primitive scalar columns
 * when the table has no primary key) so `deleteRows` payloads do not include `[BLOB]` or
 * nested object markers in `DELETE ... WHERE` clauses.
 */
export function projectDeleteRowsToPrimaryKeys(
  deleteRows: Record<string, unknown>[],
  primaryKey: string[]
): Record<string, unknown>[] {
  return deleteRows.map((row) => {
    if (primaryKey.length > 0) {
      const pkObj: Record<string, unknown> = {}
      for (const pk of primaryKey) {
        if (Object.prototype.hasOwnProperty.call(row, pk)) {
          pkObj[pk] = row[pk]
        }
      }
      if (Object.keys(pkObj).length === primaryKey.length) {
        return pkObj
      }
    }
    const fallbackObj: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) {
      if (
        v !== undefined &&
        (v === null || typeof v !== 'object') &&
        !(typeof v === 'string' && BLOB_PLACEHOLDER_REGEX.test(v.trim()))
      ) {
        fallbackObj[k] = v
      }
    }
    return fallbackObj
  })
}

/**
 * Builds a multi-column parameterized UPDATE statement with optional optimistic row locking.
 */
export function buildRowUpdateStatement(options: {
  driver: DriverType
  table: string
  schema?: string
  update: ApplyChangesUpdate
  columnTypes?: Record<string, string>
}): ParameterizedStatement | null {
  const { driver, table, schema, update, columnTypes } = options
  if (!table || typeof table !== 'string') {
    throw new Error('Table name is required for buildRowUpdateStatement')
  }
  const rawPkEntries = Object.entries(update.primaryKeys || {})
  if (rawPkEntries.length === 0) {
    throw new Error(
      'Cannot generate UPDATE statement without primary key conditions (safety guard)'
    )
  }
  for (const [pkCol, pkVal] of rawPkEntries) {
    if (pkVal === undefined) {
      throw new Error(
        `Cannot generate UPDATE statement with undefined primary key value for "${pkCol}" (safety guard)`
      )
    }
  }
  const pkEntries = rawPkEntries

  const changeEntries = Object.entries(update.changes || {}).filter(([, val]) => val !== undefined)
  if (changeEntries.length === 0) {
    return null
  }

  const quotedTable = quoteQualifiedTable(table, schema, driver)
  const params: unknown[] = []
  let paramIdx = 1

  const setClauses: string[] = []
  const previewSetClauses: string[] = []
  for (const [col, newVal] of changeEntries) {
    const quotedCol = quoteIdentForDialect(col, driver)
    setClauses.push(`${quotedCol} = ${makePlaceholder(driver, paramIdx++)}`)
    params.push(newVal)
    previewSetClauses.push(`${quotedCol} = ${formatSqlValue(newVal, driver)}`)
  }

  const whereClauses: string[] = []
  const previewWhereClauses: string[] = []

  for (const [pkCol, pkVal] of pkEntries) {
    const quotedPk = quoteIdentForDialect(pkCol, driver)
    if (pkVal === null) {
      whereClauses.push(`${quotedPk} IS NULL`)
      previewWhereClauses.push(`${quotedPk} IS NULL`)
    } else {
      whereClauses.push(`${quotedPk} = ${makePlaceholder(driver, paramIdx++)}`)
      params.push(pkVal)
      previewWhereClauses.push(`${quotedPk} = ${formatSqlValue(pkVal, driver)}`)
    }
  }

  if (update.originalRow) {
    for (const [col] of changeEntries) {
      if (!Object.prototype.hasOwnProperty.call(update.originalRow, col)) continue
      const origVal = update.originalRow[col]
      if (!canBindOptimisticLockValue(origVal, columnTypes?.[col], driver)) continue
      const quotedCol = quoteIdentForDialect(col, driver)
      if (origVal === null) {
        whereClauses.push(`${quotedCol} IS NULL`)
        previewWhereClauses.push(`${quotedCol} IS NULL`)
      } else {
        whereClauses.push(`${quotedCol} = ${makePlaceholder(driver, paramIdx++)}`)
        params.push(origVal)
        previewWhereClauses.push(`${quotedCol} = ${formatSqlValue(origVal, driver)}`)
      }
    }
  }

  return {
    sql: `UPDATE ${quotedTable} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`,
    params,
    previewSql: `UPDATE ${quotedTable} SET ${previewSetClauses.join(', ')} WHERE ${previewWhereClauses.join(' AND ')};`,
  }
}

export interface ChunkedInsertStatement {
  sql: string
  params: unknown[]
  rowCount: number
}

export interface BatchStatementsResult {
  deletes: ParameterizedStatement[]
  updates: ParameterizedStatement[]
  inserts: ParameterizedStatement[]
  chunkedInserts: ChunkedInsertStatement[]
  all: ParameterizedStatement[]
  previewStatements: string[]
}

const MAX_CHUNKED_INSERT_ROWS = 250
const MAX_CHUNKED_INSERT_PARAMS = 4000
const D1_MAX_CHUNKED_INSERT_PARAMS = 100
const SQLITE_MAX_CHUNKED_INSERT_PARAMS = 999
const MSSQL_MAX_CHUNKED_INSERT_PARAMS = 2000

function getMaxChunkInsertParams(driver: DriverType): number {
  if (driver === 'd1') return D1_MAX_CHUNKED_INSERT_PARAMS
  if (driver === 'sqlite' || driver === 'libsql') return SQLITE_MAX_CHUNKED_INSERT_PARAMS
  if (driver === 'mssql') return MSSQL_MAX_CHUNKED_INSERT_PARAMS
  return MAX_CHUNKED_INSERT_PARAMS
}

export function buildChunkedInsertStatements(options: {
  driver: DriverType
  table: string
  schema?: string
  inserts: Record<string, unknown>[]
}): ChunkedInsertStatement[] {
  const { driver, table, schema, inserts } = options
  if (!table || typeof table !== 'string') {
    throw new Error('Table name is required for buildChunkedInsertStatements')
  }
  if (inserts.length === 0) return []
  const quotedTable = quoteQualifiedTable(table, schema, driver)
  const out: ChunkedInsertStatement[] = []
  let idx = 0

  while (idx < inserts.length) {
    const firstRow = inserts[idx]
    const firstEntries = Object.entries(firstRow || {}).filter(([, val]) => val !== undefined)
    if (firstEntries.length === 0) {
      const single = buildInsertStatement({ driver, table, schema, row: firstRow })
      out.push({ sql: single.sql, params: single.params, rowCount: 1 })
      idx += 1
      continue
    }

    const cols = firstEntries.map(([col]) => col)
    const colsSql = cols.map((col) => quoteIdentForDialect(col, driver)).join(', ')
    const maxChunkParams = getMaxChunkInsertParams(driver)
    const maxRows =
      driver === 'oracle'
        ? 1
        : Math.max(1, Math.min(MAX_CHUNKED_INSERT_ROWS, Math.floor(maxChunkParams / cols.length)))

    const params: unknown[] = []
    const tuplePlaceholders: string[] = []
    let paramIdx = 1
    let rowCount = 0

    while (idx < inserts.length && rowCount < maxRows) {
      const candidate = inserts[idx]
      const candEntries = Object.entries(candidate || {}).filter(([, val]) => val !== undefined)
      if (candEntries.length !== cols.length) break
      const candMap = new Map<string, unknown>(candEntries)
      if (candMap.size !== cols.length || !cols.every((col) => candMap.has(col))) break

      const rowPh: string[] = []
      for (const col of cols) {
        rowPh.push(makePlaceholder(driver, paramIdx++))
        params.push(candMap.get(col))
      }
      tuplePlaceholders.push(`(${rowPh.join(', ')})`)
      rowCount += 1
      idx += 1
    }

    out.push({
      sql: `INSERT INTO ${quotedTable} (${colsSql}) VALUES ${tuplePlaceholders.join(', ')}`,
      params,
      rowCount,
    })
  }

  return out
}

/**
 * Builds ordered parameterized statements (DELETE -> UPDATE -> INSERT) for transactional staging.
 */
export function buildBatchStatements(
  options: { driver: DriverType } & ApplyChangesParams
): BatchStatementsResult {
  const { driver, table, schema, inserts = [], updates = [], deletes = [], columnTypes } = options

  const deleteStmts = deletes.map((primaryKeys) =>
    buildDeleteStatement({ driver, table, schema, primaryKeys })
  )
  const updateStmts: ParameterizedStatement[] = []
  for (const update of updates) {
    const built = buildRowUpdateStatement({ driver, table, schema, update, columnTypes })
    if (built) {
      updateStmts.push(built)
    }
  }
  const insertStmts = inserts.map((row) =>
    buildInsertStatement({ driver, table, schema, row })
  )
  const chunkedInserts = buildChunkedInsertStatements({ driver, table, schema, inserts })

  const all = [...deleteStmts, ...updateStmts, ...insertStmts]
  const previewStatements = all.map((s) => s.previewSql)

  return {
    deletes: deleteStmts,
    updates: updateStmts,
    inserts: insertStmts,
    chunkedInserts,
    all,
    previewStatements,
  }
}

export interface BuildSelectPageOptions {
  driver: DriverType
  table: string
  schema?: string
  page: number
  pageSize: number
  sortColumn?: string
  sortDirection?: 'ASC' | 'DESC'
  primaryKey?: string[]
  whereClause?: string
  orderByClause?: string
}

export interface SelectPageQueries {
  sql: string
  dataSql: string
  countSql: string
  params: unknown[]
  limit: number
  offset: number
}

export function buildSelectPageSql(options: BuildSelectPageOptions): SelectPageQueries {
  const {
    driver,
    table,
    schema,
    page: rawPage,
    pageSize: rawPageSize,
    sortColumn,
    sortDirection,
    primaryKey,
    whereClause,
    orderByClause,
  } = options

  const safePage = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1
  const safePageSize = Number.isFinite(rawPageSize) && rawPageSize > 0 ? rawPageSize : 50
  const page = Math.max(1, Math.floor(safePage))
  const pageSize = Math.max(1, Math.min(10000, Math.floor(safePageSize)))
  const rawOffset = (page - 1) * pageSize
  const offset =
    Number.isFinite(rawOffset) && rawOffset >= 0
      ? Math.min(Number.MAX_SAFE_INTEGER, rawOffset)
      : Number.MAX_SAFE_INTEGER

  const sanitizedWhere = sanitizeFilterClause(whereClause, driver)
  const sanitizedOrderBy = sanitizeFilterClause(orderByClause, driver)

  const quotedTable = quoteQualifiedTable(table, schema, driver)
  const whereSql = sanitizedWhere ? ` WHERE ${sanitizedWhere}` : ''
  const countAlias = driver === 'oracle' ? '"total"' : 'total'
  const countSql = `SELECT COUNT(*) AS ${countAlias} FROM ${quotedTable}${whereSql};`

  let orderClause = ''
  if (sanitizedOrderBy) {
    orderClause = ` ORDER BY ${sanitizedOrderBy}`
  } else if (sortColumn) {
    const dir = sortDirection && sortDirection.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
    orderClause = ` ORDER BY ${quoteIdentForDialect(sortColumn, driver)} ${dir}`
  } else if (primaryKey && primaryKey.length > 0) {
    const pkQuoted = primaryKey.map((k) => quoteIdentForDialect(k, driver)).join(', ')
    orderClause = ` ORDER BY ${pkQuoted} ASC`
  } else if (driver === 'mssql') {
    orderClause = ' ORDER BY (SELECT NULL)'
  }

  const firstPh = makePlaceholder(driver, 1)
  const secondPh = makePlaceholder(driver, 2)
  const usesOffsetFetch = driver === 'mssql' || driver === 'oracle'
  const sql = usesOffsetFetch
    ? `SELECT * FROM ${quotedTable}${whereSql}${orderClause} OFFSET ${firstPh} ROWS FETCH NEXT ${secondPh} ROWS ONLY;`
    : `SELECT * FROM ${quotedTable}${whereSql}${orderClause} LIMIT ${firstPh} OFFSET ${secondPh};`
  const params: unknown[] = usesOffsetFetch ? [offset, pageSize] : [pageSize, offset]

  return { sql, dataSql: sql, countSql, params, limit: pageSize, offset }
}

// Alias for explorer_m2_3 test compatibility
export const buildFetchPageQueries = buildSelectPageSql

export function assembleTableBrowseResult(options: {
  tableDetails: TableDetails
  rows: Record<string, unknown>[]
  countRow: Record<string, unknown>
  page: number
  pageSize: number
}): TableBrowseResult {
  const { tableDetails, rows, countRow, page, pageSize } = options
  let rawTotal: unknown =
    countRow?.total ??
    countRow?.TOTAL ??
    countRow?.['COUNT(*)'] ??
    countRow?.['count'] ??
    countRow?.['COUNT']
  if (rawTotal === undefined && countRow && typeof countRow === 'object') {
    for (const [k, v] of Object.entries(countRow)) {
      if (k.toLowerCase() === 'total' || k.toLowerCase() === 'count(*)') {
        rawTotal = v
        break
      }
    }
  }
  const parsedTotal = Number(rawTotal ?? 0)
  const totalRows = Number.isFinite(parsedTotal) && parsedTotal >= 0 ? parsedTotal : 0

  const canEdit = tableDetails.kind === 'table' && tableDetails.primaryKey.length > 0

  return {
    columns: tableDetails.columns,
    rows,
    totalRows,
    page,
    pageSize,
    primaryKey: tableDetails.primaryKey,
    canEdit,
  }
}
