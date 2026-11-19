import type {
  ApplyChangesParams,
  ApplyChangesUpdate,
  DriverType,
  TableBrowseResult,
  TableDetails,
} from './driver'
import { SUPPORTED_DRIVERS } from './connection-uri'
import { quoteIdentForDialect, sanitizeFilterClause } from './sql-tools'

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
    ((dialect === 'sqlite' || dialect === 'libsql') && trimmedSchema.toLowerCase() === 'main')

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
  if (schema === undefined && !isDriverType(first) && isDriverType(second)) {
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
  return '?'
}

/**
 * Formats a JavaScript value into a safely escaped SQL literal for preview rendering.
 */
export function formatSqlValue(value: unknown, dialect: DriverType): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'bigint') return value.toString()

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return 'NULL'
    return formatSqlStringLiteral(value.toISOString(), dialect)
  }

  if (value instanceof ArrayBuffer) {
    const hex = Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, '0')).join('')
    return `X'${hex}'`
  }

  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    const hex = Array.from(view, (b) => b.toString(16).padStart(2, '0')).join('')
    return `X'${hex}'`
  }

  if (typeof value === 'object') {
    return formatSqlStringLiteral(JSON.stringify(value), dialect)
  }

  return formatSqlStringLiteral(String(value), dialect)
}

function formatSqlStringLiteral(raw: string, dialect: DriverType): string {
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
}

export interface BuildUpdateResult {
  sql: string
  params: unknown[]
}

export function canBindOptimisticLockValue(val: unknown): boolean {
  if (val === undefined) return false
  if (val === null) return true
  if (typeof val === 'object') return false
  if (typeof val === 'string' && /^\[BLOB\s+\d+\s*B\]$/i.test(val.trim())) return false
  return true
}

export function buildUpdateSql(options: BuildUpdateOptions): BuildUpdateResult {
  const { driver, table, schema, column, newValue, primaryKeys, originalValue } = options

  if (!table || typeof table !== 'string') {
    throw new Error('Table name is required for buildUpdateSql')
  }
  if (!column || typeof column !== 'string') {
    throw new Error('Column name is required for buildUpdateSql')
  }
  if (!primaryKeys || Object.keys(primaryKeys).length === 0) {
    throw new Error(
      'Cannot generate UPDATE statement without primary key conditions (safety guard)'
    )
  }

  const params: unknown[] = []
  let paramIdx = 1

  const quotedTable = quoteQualifiedTable(table, schema, driver)
  const quotedCol = quoteIdentForDialect(column, driver)

  params.push(newValue)
  const setClause = `${quotedCol} = ${makePlaceholder(driver, paramIdx++)}`

  const whereClauses: string[] = []
  for (const [pkCol, pkVal] of Object.entries(primaryKeys)) {
    const quotedPk = quoteIdentForDialect(pkCol, driver)
    if (pkVal === null || pkVal === undefined) {
      whereClauses.push(`${quotedPk} IS NULL`)
    } else {
      whereClauses.push(`${quotedPk} = ${makePlaceholder(driver, paramIdx++)}`)
      params.push(pkVal)
    }
  }

  if (canBindOptimisticLockValue(originalValue)) {
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
    const emptySql = BACKTICK_DIALECTS.has(driver)
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
  const pkEntries = Object.entries(primaryKeys || {}).filter(([, val]) => val !== undefined)
  if (pkEntries.length === 0) {
    throw new Error(
      'Cannot generate DELETE statement without primary key conditions (safety guard)'
    )
  }

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
 * Builds a multi-column parameterized UPDATE statement with optional optimistic row locking.
 */
export function buildRowUpdateStatement(options: {
  driver: DriverType
  table: string
  schema?: string
  update: ApplyChangesUpdate
}): ParameterizedStatement | null {
  const { driver, table, schema, update } = options
  if (!table || typeof table !== 'string') {
    throw new Error('Table name is required for buildRowUpdateStatement')
  }
  const pkEntries = Object.entries(update.primaryKeys || {}).filter(([, val]) => val !== undefined)
  if (pkEntries.length === 0) {
    throw new Error(
      'Cannot generate UPDATE statement without primary key conditions (safety guard)'
    )
  }

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
      if (!canBindOptimisticLockValue(origVal)) continue
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

export interface BatchStatementsResult {
  deletes: ParameterizedStatement[]
  updates: ParameterizedStatement[]
  inserts: ParameterizedStatement[]
  all: ParameterizedStatement[]
  previewStatements: string[]
}

/**
 * Builds ordered parameterized statements (DELETE -> UPDATE -> INSERT) for transactional staging.
 */
export function buildBatchStatements(
  options: { driver: DriverType } & ApplyChangesParams
): BatchStatementsResult {
  const { driver, table, schema, inserts = [], updates = [], deletes = [] } = options

  const deleteStmts = deletes.map((primaryKeys) =>
    buildDeleteStatement({ driver, table, schema, primaryKeys })
  )
  const updateStmts: ParameterizedStatement[] = []
  for (const update of updates) {
    const built = buildRowUpdateStatement({ driver, table, schema, update })
    if (built) {
      updateStmts.push(built)
    }
  }
  const insertStmts = inserts.map((row) =>
    buildInsertStatement({ driver, table, schema, row })
  )

  const all = [...deleteStmts, ...updateStmts, ...insertStmts]
  const previewStatements = all.map((s) => s.previewSql)

  return {
    deletes: deleteStmts,
    updates: updateStmts,
    inserts: insertStmts,
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
  const offset = Math.max(0, (page - 1) * pageSize)

  const sanitizedWhere = sanitizeFilterClause(whereClause, driver)
  const sanitizedOrderBy = sanitizeFilterClause(orderByClause, driver)

  const quotedTable = quoteQualifiedTable(table, schema, driver)
  const whereSql = sanitizedWhere ? ` WHERE ${sanitizedWhere}` : ''
  const countSql = `SELECT COUNT(*) AS total FROM ${quotedTable}${whereSql};`

  let orderClause = ''
  if (sanitizedOrderBy) {
    orderClause = ` ORDER BY ${sanitizedOrderBy}`
  } else if (sortColumn) {
    const dir = sortDirection && sortDirection.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
    orderClause = ` ORDER BY ${quoteIdentForDialect(sortColumn, driver)} ${dir}`
  } else if (primaryKey && primaryKey.length > 0) {
    const pkQuoted = primaryKey.map((k) => quoteIdentForDialect(k, driver)).join(', ')
    orderClause = ` ORDER BY ${pkQuoted} ASC`
  }

  const limitPh = makePlaceholder(driver, 1)
  const offsetPh = makePlaceholder(driver, 2)
  const sql = `SELECT * FROM ${quotedTable}${whereSql}${orderClause} LIMIT ${limitPh} OFFSET ${offsetPh};`
  const params: unknown[] = [pageSize, offset]

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
  const rawTotal = countRow?.total ?? countRow?.['COUNT(*)'] ?? countRow?.['count'] ?? 0
  const parsedTotal = Number(rawTotal)
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
