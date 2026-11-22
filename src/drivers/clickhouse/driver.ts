import * as https from 'node:https'
import type * as tls from 'node:tls'
import type {
  ApplyChangesParams,
  ApplyChangesResult,
  ColumnInfo,
  ConnectionProfile,
  FetchPageParams,
  IDatabaseDriver,
  IDatabaseSession,
  PreviewChangesResult,
  QueryResult,
  QueryResultSet,
  SchemaObject,
  SchemaObjectKind,
  TableBrowseResult,
  TableDetails,
  TransactionState,
  UpdateCellParams,
  UpdateCellResult,
} from '../common/driver'
import {
  DatabaseDriverError,
  buildCombinedAbortSignal,
  createUnsupportedTransactionError,
  createUnsupportedTransactionState,
  runDriverConnectionTest,
} from '../common/driver'
import type { DriverTlsOptions } from '../common/tls-and-tunnel'
import { resolveEffectiveTlsOptions } from '../common/tls-and-tunnel'
import {
  assembleTableBrowseResult,
  buildSelectPageSql,
  canBindOptimisticLockValue,
  formatSqlValue,
  quoteQualifiedTable,
} from '../common/update-builder'
import { TableDetailsCache, collectAndAssembleSchemaDdl } from '../common/schema'
import { stripCommentsAndLiterals, isMutatingStatement } from '../common/sql-lexer'
import { compactSql, quoteIdentForDialect, reconstructTableDdl, splitSqlStatements } from '../common/sql-tools'

const CLICKHOUSE_HTTP_TIMEOUT_MS = 30_000
const CLICKHOUSE_UNSUPPORTED_TX_REASON =
  'ClickHouse does not support interactive multi-statement transactions'
const CLICKHOUSE_MAX_INSERT_ROWS_PER_STMT = 500
const CLICKHOUSE_MAX_INSERT_SQL_BYTES = 256 * 1024

interface ClickHouseJsonCompactResponse {
  meta?: Array<{ name: string; type: string }>
  data?: unknown[][]
  rows?: number
}

const CLICKHOUSE_ROW_RETURNING_REGEX =
  /^\s*\(*\s*(?:SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|EXISTS|WITH)\b/i
const CLICKHOUSE_FORMAT_SUFFIX_REGEX = /\bFORMAT\s+([A-Za-z0-9_]+)\s*;?\s*$/i

function finishClickHouseHttp(
  text: string,
  ok: boolean,
  status: number,
  summaryHeader: string | null,
  expectJsonCompact: boolean
): { json?: ClickHouseJsonCompactResponse; summaryAffectedRows?: number; rawText: string } {
  if (!ok) {
    throw new DatabaseDriverError(
      text.trim() || `ClickHouse HTTP error ${status}`,
      'CLICKHOUSE_ERROR',
      'clickhouse'
    )
  }

  let summaryAffectedRows: number | undefined
  if (summaryHeader) {
    try {
      const summary = JSON.parse(summaryHeader) as { written_rows?: string | number }
      if (summary.written_rows !== undefined) {
        const n = Number(summary.written_rows)
        if (Number.isFinite(n)) summaryAffectedRows = n
      }
    } catch {
      // Ignore malformed summary header
    }
  }

  if (expectJsonCompact) {
    if (!text.trim()) {
      return { json: { meta: [], data: [], rows: 0 }, summaryAffectedRows, rawText: text }
    }
    try {
      const parsed = JSON.parse(text) as ClickHouseJsonCompactResponse
      return { json: parsed, summaryAffectedRows, rawText: text }
    } catch (err) {
      throw new DatabaseDriverError(
        `Failed to parse ClickHouse JSONCompact response: ${err instanceof Error ? err.message : String(err)}`,
        'CLICKHOUSE_PARSE_ERROR',
        'clickhouse',
        err
      )
    }
  }

  return { summaryAffectedRows, rawText: text }
}

/** POSTs through node:https so custom CA / mTLS options apply to ClickHouse over HTTPS */
function sendHttpsRequest(
  url: URL,
  headers: Record<string, string>,
  body: string,
  tlsOptions: tls.ConnectionOptions,
  signal: AbortSignal
): Promise<{ text: string; ok: boolean; status: number; summaryHeader: string | null }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: 'POST', headers, ...tlsOptions, agent: false, signal },
      (res) => {
        res.setEncoding('utf8')
        let text = ''
        res.on('data', (chunk: string) => {
          text += chunk
        })
        res.on('error', reject)
        res.on('end', () => {
          const summary = res.headers['x-clickhouse-summary']
          resolve({
            text,
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            summaryHeader: typeof summary === 'string' ? summary : null,
          })
        })
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

export function normalizeClickHouseBaseUrl(
  profile: ConnectionProfile,
  tlsOverride?: false | tls.ConnectionOptions
): string {
  if (tlsOverride === false) {
    // Explicit sslMode: 'disable' — force plain HTTP, never fall back to auto-SSL
    const raw = (profile.url?.trim() || '').replace(/^clickhouses:\/\//i, 'http://')
    if (raw.length > 0) return raw.replace(/^https:\/\//i, 'http://').replace(/\/+$/, '')
    return `http://${profile.host || 'localhost'}:${profile.port || 8123}`
  }
  if (tlsOverride) {
    const host = profile.host || 'localhost'
    const rawUrl = typeof profile.url === 'string' ? profile.url.trim() : ''
    if (rawUrl.length === 0) return `https://${host}:${profile.port || 8443}`
    // Custom CA / mTLS requires HTTPS: upgrade plain http:// URLs so https.request
    // never throws ERR_INVALID_PROTOCOL
    const raw = rawUrl.replace(/\/+$/, '')
    if (/^http:\/\//i.test(raw)) return raw.replace(/^http:\/\//i, 'https://')
    if (/^clickhouses?:\/\//i.test(raw)) return raw.replace(/^clickhouses?:\/\//i, 'https://')
    return raw
  }
  return resolveClickHouseBaseUrl(profile)
}

function resolveClickHouseBaseUrl(profile: ConnectionProfile): string {
  if (profile.url && profile.url.trim().length > 0) {
    let raw = profile.url.trim().replace(/\/+$/, '')
    if (/^clickhouses:\/\//i.test(raw)) {
      raw = raw.replace(/^clickhouses:\/\//i, 'https://')
    } else if (/^clickhouse:\/\//i.test(raw)) {
      raw = raw.replace(/^clickhouse:\/\//i, 'http://')
    }
    return raw
  }

  const ssl = Boolean(profile.ssl)
  const proto = ssl ? 'https' : 'http'
  const host = profile.host || 'localhost'
  const port = profile.port || (ssl ? 8443 : 8123)
  return `${proto}://${host}:${port}`
}

function escapeClickHouseLiteralText(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/'/g, "''")
}

function stripLeadingComments(sql: string): string {
  let s = sql.trimStart()
  while (s.length > 0) {
    if (s.startsWith('--') || s.startsWith('#')) {
      const nl = s.indexOf('\n')
      s = nl >= 0 ? s.slice(nl + 1).trimStart() : ''
      continue
    }
    if (s.startsWith('/*')) {
      const end = s.indexOf('*/', 2)
      s = end >= 0 ? s.slice(end + 2).trimStart() : ''
      continue
    }
    break
  }
  return s
}

function isRowReturningClickHouseQuery(sql: string): boolean {
  const clean = stripLeadingComments(sql)
  if (!CLICKHOUSE_ROW_RETURNING_REGEX.test(clean)) {
    return false
  }
  const stripped = stripCommentsAndLiterals(sql, 'clickhouse').trim()
  if (/^\(*\s*WITH\b/i.test(stripped) && /\b(?:INSERT\s+INTO|ALTER\s+TABLE|UPDATE|DELETE)\b/i.test(stripped)) {
    return false
  }
  return true
}

function extractExplicitClickHouseFormat(sql: string): string | null {
  const stripped = stripCommentsAndLiterals(sql, 'clickhouse').trim().replace(/;+\s*$/, '')
  const match = CLICKHOUSE_FORMAT_SUFFIX_REGEX.exec(stripped)
  return match ? match[1] : null
}

function prepareClickHouseSql(sql: string, forceJsonCompact: boolean): string {
  const stmts = splitSqlStatements(sql, 'clickhouse')
  const core = stmts.length === 1 ? stmts[0].text : sql.trim().replace(/;+\s*$/, '')
  const stripped = core.replace(/;+\s*$/, '')
  if (!forceJsonCompact || extractExplicitClickHouseFormat(stripped) !== null) {
    return stripped
  }
  const hasTrailingLineComment = /(?:--|#)[^\r\n]*$/.test(stripped)
  return hasTrailingLineComment
    ? `${stripped}\nFORMAT JSONCompact`
    : `${stripped} FORMAT JSONCompact`
}

function mapCompactRowsToObjects(
  meta: Array<{ name: string; type: string }>,
  data: unknown[][]
): Record<string, unknown>[] {
  return data.map((rowArr) => {
    const obj: Record<string, unknown> = {}
    for (let i = 0; i < meta.length; i++) {
      obj[meta[i].name] = rowArr[i]
    }
    return obj
  })
}

function buildClickHouseWhereSql(
  conditions: Record<string, unknown>,
  extraRow?: Record<string, unknown>,
  changeKeys?: string[],
  columnTypes?: Record<string, string>
): string {
  const parts: string[] = []
  for (const [col, val] of Object.entries(conditions)) {
    if (val === undefined) continue
    const qCol = quoteIdentForDialect(col, 'clickhouse')
    parts.push(val === null ? `${qCol} IS NULL` : `${qCol} = ${formatSqlValue(val, 'clickhouse')}`)
  }
  if (extraRow && changeKeys) {
    for (const col of changeKeys) {
      if (!Object.prototype.hasOwnProperty.call(extraRow, col)) continue
      const orig = extraRow[col]
      if (!canBindOptimisticLockValue(orig, columnTypes?.[col])) continue
      const qCol = quoteIdentForDialect(col, 'clickhouse')
      parts.push(orig === null ? `${qCol} IS NULL` : `${qCol} = ${formatSqlValue(orig, 'clickhouse')}`)
    }
  }
  return parts.join(' AND ')
}

function parseClickHouseKeyExpression(rawKey: unknown, validColumns: ReadonlySet<string>): string[] {
  if (typeof rawKey !== 'string' || !rawKey.trim()) return []
  const cleaned = rawKey.trim().replace(/^\((.*)\)$/, '$1').trim()
  if (!cleaned) return []
  const tokens = cleaned.split(',').map((part) => part.trim().replace(/^`|`$/g, '').replace(/^"|"$/g, ''))
  const resolved: string[] = []
  for (const tok of tokens) {
    if (!validColumns.has(tok)) {
      return []
    }
    resolved.push(tok)
  }
  return resolved
}

interface ActiveClickHouseQuery {
  controller: AbortController
  cancelled: boolean
  currentServerQueryId: string
}

export class ClickHouseSession implements IDatabaseSession {
  readonly driverType = 'clickhouse' as const
  readonly profile: ConnectionProfile
  private readonly baseUrl: string
  private readonly secret?: string
  private readonly activeQueries = new Map<string, ActiveClickHouseQuery>()
  private readonly tableDetailsCache = new TableDetailsCache()
  private readonly tlsOptions?: tls.ConnectionOptions
  private serverReadOnlySettings = false
  private isClosed = false

  constructor(
    profile: ConnectionProfile,
    secret?: string,
    tlsOverride?: false | tls.ConnectionOptions
  ) {
    this.profile = profile
    this.secret = secret
    this.tlsOptions = tlsOverride === false ? undefined : tlsOverride
    this.baseUrl = normalizeClickHouseBaseUrl(profile, tlsOverride)
  }

  isAlive(): boolean {
    return !this.isClosed
  }

  private getDatabase(): string {
    return this.profile.database || 'default'
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-ClickHouse-User': this.profile.user || 'default',
      'X-ClickHouse-Database': this.getDatabase(),
    }
    if (this.secret !== undefined) {
      headers['X-ClickHouse-Key'] = this.secret
    }
    return headers
  }

  private assertWritable(): void {
    if (this.profile.readOnly) {
      throw new DatabaseDriverError(
        'Connection is read-only. Write operations are disabled.',
        'READ_ONLY',
        'clickhouse'
      )
    }
  }

  private async executeHttp(
    sql: string,
    options?: {
      queryId?: string
      expectJsonCompact?: boolean
      signal?: AbortSignal
      maxResultRows?: number
    },
    retryWithoutSettings = false
  ): Promise<{
    json?: ClickHouseJsonCompactResponse
    summaryAffectedRows?: number
    rawText: string
  }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }

    const qid =
      options?.queryId || `ch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const url = new URL(`${this.baseUrl}/`)
    url.searchParams.set('query_id', qid)
    const allowSettings = !this.serverReadOnlySettings
    let sentSettings = false
    if (this.profile.readOnly && allowSettings) {
      url.searchParams.set('readonly', '1')
      sentSettings = true
    }
    if (options?.expectJsonCompact && !this.profile.readOnly && allowSettings) {
      url.searchParams.set('output_format_json_quote_denormals', '1')
      sentSettings = true
    }
    if (
      !this.profile.readOnly &&
      allowSettings &&
      typeof options?.maxResultRows === 'number' &&
      Number.isFinite(options.maxResultRows) &&
      options.maxResultRows > 0
    ) {
      url.searchParams.set('max_result_rows', String(Math.floor(options.maxResultRows)))
      url.searchParams.set('result_overflow_mode', 'break')
      sentSettings = true
    }

    const bodySql = prepareClickHouseSql(sql, Boolean(options?.expectJsonCompact))

    const combinedSignal = buildCombinedAbortSignal(CLICKHOUSE_HTTP_TIMEOUT_MS, options?.signal)
    const headers = this.buildHeaders()
    try {
      if (this.tlsOptions === undefined) {
        const response = await fetch(url.toString(), {
          method: 'POST',
          headers,
          body: bodySql,
          signal: combinedSignal,
        })
        const text = await response.text()
        return finishClickHouseHttp(
          text,
          response.ok,
          response.status,
          response.headers.get('x-clickhouse-summary'),
          Boolean(options?.expectJsonCompact)
        )
      }
      // Custom CA / client certs (mTLS) need node:https so tls.ConnectionOptions apply
      const result = await sendHttpsRequest(url, headers, bodySql, this.tlsOptions, combinedSignal)
      return finishClickHouseHttp(
        result.text,
        result.ok,
        result.status,
        result.summaryHeader,
        Boolean(options?.expectJsonCompact)
      )
    } catch (err: unknown) {
      if (
        !retryWithoutSettings &&
        sentSettings &&
        err instanceof DatabaseDriverError &&
        err.code === 'CLICKHOUSE_ERROR' &&
        /Cannot modify\s+'[^']+'\s+setting in readonly mode/i.test(err.message)
      ) {
        this.serverReadOnlySettings = true
        return await this.executeHttp(sql, options, true)
      }
      const errName = (err as { name?: string })?.name
      if (options?.signal?.aborted) {
        throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'clickhouse', err)
      }
      if (errName === 'TimeoutError' || errName === 'AbortError') {
        throw new DatabaseDriverError(
          `ClickHouse HTTP request timed out after ${CLICKHOUSE_HTTP_TIMEOUT_MS}ms`,
          'TIMEOUT',
          'clickhouse',
          err
        )
      }
      if (err instanceof DatabaseDriverError) {
        throw err
      }
      throw new DatabaseDriverError(
        err instanceof Error ? err.message : 'ClickHouse HTTP request failed',
        'CONNECTION_FAILED',
        'clickhouse',
        err
      )
    }
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    if (this.isClosed) {
      return { ok: false, message: 'Session is closed' }
    }
    try {
      await this.executeHttp('SELECT 1', { expectJsonCompact: true })
      return { ok: true, message: 'ClickHouse connection valid' }
    } catch (err: unknown) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to connect to ClickHouse',
      }
    }
  }

  async close(): Promise<void> {
    this.tableDetailsCache.clear()
    if (this.isClosed) return
    this.isClosed = true
    for (const active of this.activeQueries.values()) {
      active.cancelled = true
      active.controller.abort()
    }
    this.activeQueries.clear()
  }

  async listObjects(schema?: string): Promise<SchemaObject[]> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    const targetDb = schema || this.getDatabase()
    const sql = `
      SELECT name, database AS schema, engine
      FROM system.tables
      WHERE database = '${escapeClickHouseLiteralText(targetDb)}'
      ORDER BY name ASC
    `
    const { json } = await this.executeHttp(sql, { expectJsonCompact: true })
    const meta = json?.meta || []
    const rows = mapCompactRowsToObjects(meta, json?.data || [])
    return rows.map((r) => {
      const engine = String(r.engine || '')
      const kind: SchemaObjectKind =
        engine === 'MaterializedView'
          ? 'materialized_view'
          : /View$/i.test(engine)
            ? 'view'
            : 'table'
      return {
        name: String(r.name),
        schema: String(r.schema || targetDb),
        kind,
      }
    })
  }

  async listSchemas(): Promise<{ schemas: string[]; defaultSchema: string }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    const { json } = await this.executeHttp('SHOW DATABASES', { expectJsonCompact: true })
    const rows = mapCompactRowsToObjects(json?.meta || [], json?.data || [])
    const names = rows
      .map((r) => String(r.name ?? ''))
      .filter((name) => name.length > 0 && name !== 'system')
    const defaultSchema = this.getDatabase()
    return {
      schemas: names.includes(defaultSchema) ? names : [defaultSchema, ...names],
      defaultSchema,
    }
  }

  async getObjectDdl(name: string, kind: SchemaObjectKind, schema?: string): Promise<string> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    const targetDb = schema || this.getDatabase()
    const qTable = quoteQualifiedTable(name, targetDb, 'clickhouse')
    const commands = kind === 'view' ? ['SHOW CREATE VIEW', 'SHOW CREATE TABLE'] : ['SHOW CREATE TABLE']
    for (const command of commands) {
      try {
        const { json } = await this.executeHttp(`${command} ${qTable}`, {
          expectJsonCompact: true,
        })
        const firstRow = json?.data?.[0]
        if (Array.isArray(firstRow) && typeof firstRow[0] === 'string' && firstRow[0].trim()) {
          const stmt = firstRow[0].trim()
          return stmt.endsWith(';') ? stmt : `${stmt};`
        }
      } catch {
        // Try the next SHOW CREATE variant before falling back to metadata reconstruction
      }
    }
    return this.getDdl(name, targetDb)
  }

  async exportSchemaDdl(schema?: string): Promise<{ ddl: string; objectCount: number }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    const targetDb = schema || this.getDatabase()
    const objects = await this.listObjects(targetDb)
    return collectAndAssembleSchemaDdl({
      dialect: 'clickhouse',
      schemaName: targetDb,
      objects,
      getObjectDdl: (object) => this.getObjectDdl(object.name, object.kind, targetDb),
    })
  }

  async getTableDetails(table: string, schema?: string): Promise<TableDetails> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    const targetDb = schema || this.getDatabase()
    const cached = this.tableDetailsCache.get(targetDb, 'default', table)
    if (cached) {
      return cached
    }
    const escapedDb = escapeClickHouseLiteralText(targetDb)
    const escapedTable = escapeClickHouseLiteralText(table)

    const colSql = `
      SELECT name, type, is_in_primary_key, is_in_sorting_key, default_kind, default_expression
      FROM system.columns
      WHERE database = '${escapedDb}' AND table = '${escapedTable}'
      ORDER BY position ASC
    `
    const tblSql = `
      SELECT engine, primary_key, sorting_key
      FROM system.tables
      WHERE database = '${escapedDb}' AND name = '${escapedTable}'
      LIMIT 1
    `

    const [colRes, tblRes] = await Promise.all([
      this.executeHttp(colSql, { expectJsonCompact: true }),
      this.executeHttp(tblSql, { expectJsonCompact: true }).catch(() => ({ json: undefined })),
    ])

    const colRows = mapCompactRowsToObjects(colRes.json?.meta || [], colRes.json?.data || [])
    const tblRows = mapCompactRowsToObjects(tblRes.json?.meta || [], tblRes.json?.data || [])
    const engine = String(tblRows[0]?.engine || '')
    const kind: 'table' | 'view' = /View$/i.test(engine) ? 'view' : 'table'

    const validColNames = new Set(colRows.map((c) => String(c.name)))
    let primaryKey = parseClickHouseKeyExpression(tblRows[0]?.primary_key, validColNames)
    if (primaryKey.length === 0) {
      primaryKey = parseClickHouseKeyExpression(tblRows[0]?.sorting_key, validColNames)
    }
    if (primaryKey.length === 0) {
      primaryKey = colRows
        .filter((c) => Number(c.is_in_primary_key) === 1)
        .map((c) => String(c.name))
    }
    if (primaryKey.length === 0) {
      primaryKey = colRows
        .filter((c) => Number(c.is_in_sorting_key) === 1)
        .map((c) => String(c.name))
    }

    const pkSet = new Set(primaryKey)
    const columns: ColumnInfo[] = colRows.map((c) => {
      const typeStr = String(c.type || 'String')
      const defaultExpr =
        c.default_expression !== null &&
        c.default_expression !== undefined &&
        String(c.default_expression).length > 0
          ? String(c.default_expression)
          : null

      return {
        name: String(c.name),
        type: typeStr,
        nativeType: typeStr,
        nullable: /^Nullable\(/i.test(typeStr),
        defaultValue: defaultExpr,
        isPrimaryKey: pkSet.has(String(c.name)),
        isAutoIncrement: false,
      }
    })

    const details: TableDetails = {
      name: table,
      schema: targetDb,
      kind,
      columns,
      primaryKey,
      indexes: [],
      foreignKeys: [],
    }
    this.tableDetailsCache.set(targetDb, 'default', table, details)
    return details
  }

  async fetchPage(params: FetchPageParams): Promise<TableBrowseResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    const targetDb = params.schema || this.getDatabase()
    const details = await this.getTableDetails(params.table, targetDb)

    const { sql, countSql, limit, offset } = buildSelectPageSql({
      driver: 'clickhouse',
      table: params.table,
      schema: targetDb,
      page: params.page,
      pageSize: params.pageSize,
      sortColumn: params.sortColumn,
      sortDirection: params.sortDirection,
      primaryKey: details.primaryKey,
      whereClause: params.whereClause,
      orderByClause: params.orderByClause,
    })

    const resolvedDataSql = sql.replace(
      /LIMIT \? OFFSET \?;?$/,
      `LIMIT ${limit} OFFSET ${offset}`
    )

    const [countRes, dataRes] = await Promise.all([
      this.executeHttp(countSql, { expectJsonCompact: true }),
      this.executeHttp(resolvedDataSql, { expectJsonCompact: true }),
    ])

    const countRows = mapCompactRowsToObjects(countRes.json?.meta || [], countRes.json?.data || [])
    const dataRows = mapCompactRowsToObjects(dataRes.json?.meta || [], dataRes.json?.data || [])

    return assembleTableBrowseResult({
      tableDetails: details,
      rows: dataRows,
      countRow: countRows[0] || { total: 0 },
      page: params.page,
      pageSize: params.pageSize,
    })
  }

  async updateCell(params: UpdateCellParams): Promise<UpdateCellResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    this.assertWritable()
    if (!params.primaryKeys || Object.keys(params.primaryKeys).length === 0) {
      throw new DatabaseDriverError(
        'Cannot update ClickHouse record without primary key conditions',
        'invalid_params',
        'clickhouse'
      )
    }

    const targetDb = params.schema || this.getDatabase()
    const originalColumnType = this.tableDetailsCache.findColumnType(
      targetDb,
      'default',
      params.table,
      params.column,
      params.columnType
    )
    const qTable = quoteQualifiedTable(params.table, targetDb, 'clickhouse')
    const qCol = quoteIdentForDialect(params.column, 'clickhouse')
    const valSql = formatSqlValue(params.newValue, 'clickhouse')
    const whereSql = buildClickHouseWhereSql(
      params.primaryKeys,
      params.originalValue !== undefined ? { [params.column]: params.originalValue } : undefined,
      params.originalValue !== undefined ? [params.column] : undefined,
      originalColumnType ? { [params.column]: originalColumnType } : undefined
    )

    const checkRes = await this.executeHttp(
      `SELECT COUNT(*) AS total FROM ${qTable} WHERE ${whereSql}`,
      { expectJsonCompact: true }
    )
    const checkRow = mapCompactRowsToObjects(checkRes.json?.meta || [], checkRes.json?.data || [])[0]
    const matchedRows = Number(checkRow?.total ?? checkRow?.['COUNT(*)'] ?? checkRow?.['count()'] ?? 0)
    if (!Number.isFinite(matchedRows) || matchedRows === 0) {
      throw new DatabaseDriverError(
        'Record was modified or deleted by another session (optimistic lock conflict)',
        'conflict',
        'clickhouse'
      )
    }

    await this.executeHttp(
      `ALTER TABLE ${qTable} UPDATE ${qCol} = ${valSql} WHERE ${whereSql} SETTINGS mutations_sync = 1`
    )

    const effectivePkConditions: Record<string, unknown> = { ...params.primaryKeys }
    if (Object.prototype.hasOwnProperty.call(effectivePkConditions, params.column)) {
      effectivePkConditions[params.column] = params.newValue
    }
    const pkWhere = buildClickHouseWhereSql(effectivePkConditions)
    let updatedRecord: Record<string, unknown> | undefined
    try {
      const sel = await this.executeHttp(
        `SELECT * FROM ${qTable} WHERE ${pkWhere} LIMIT 1`,
        { expectJsonCompact: true }
      )
      updatedRecord = mapCompactRowsToObjects(sel.json?.meta || [], sel.json?.data || [])[0]
    } catch {
      // Optional readback
    }

    return {
      ok: true,
      affectedRows: matchedRows,
      updatedRecord,
    }
  }

  private buildChangeStatements(params: ApplyChangesParams): {
    deletes: { preview: string; exec: string; rowCount: number }[]
    updates: { preview: string; exec: string }[]
    inserts: { preview: string; exec: string; rowCount: number }[]
  } {
    const targetDb = params.schema || this.getDatabase()
    const qTable = quoteQualifiedTable(params.table, targetDb, 'clickhouse')
    const columnTypes = this.tableDetailsCache.resolveColumnTypes(
      targetDb,
      'default',
      params.table,
      params.columnTypes
    )

    const deletes: { preview: string; exec: string; rowCount: number }[] = []
    const rawDeletes = params.deletes ?? []
    let delIdx = 0
    while (delIdx < rawDeletes.length) {
      const pk = rawDeletes[delIdx]
      const pkEntries = Object.entries(pk || {}).filter(([, v]) => v !== undefined)
      if (pkEntries.length === 0) {
        throw new DatabaseDriverError(
          'Cannot generate DELETE statement without primary key conditions (safety guard)',
          'invalid_params',
          'clickhouse'
        )
      }
      if (rawDeletes.length > 1 && pkEntries.length === 1 && pkEntries[0][1] !== null) {
        const [pkCol, firstVal] = pkEntries[0]
        const qCol = quoteIdentForDialect(pkCol, 'clickhouse')
        const inLiterals: string[] = [formatSqlValue(firstVal, 'clickhouse')]
        let nextDelIdx = delIdx + 1
        while (nextDelIdx < rawDeletes.length && inLiterals.length < CLICKHOUSE_MAX_INSERT_ROWS_PER_STMT) {
          const candEntries = Object.entries(rawDeletes[nextDelIdx] || {}).filter(([, v]) => v !== undefined)
          if (candEntries.length !== 1 || candEntries[0][0] !== pkCol || candEntries[0][1] === null) {
            break
          }
          inLiterals.push(formatSqlValue(candEntries[0][1], 'clickhouse'))
          nextDelIdx += 1
        }
        if (inLiterals.length > 1) {
          const whereInSql = `${qCol} IN (${inLiterals.join(', ')})`
          deletes.push({
            preview: `ALTER TABLE ${qTable} DELETE WHERE ${whereInSql};`,
            exec: `ALTER TABLE ${qTable} DELETE WHERE ${whereInSql} SETTINGS mutations_sync = 1`,
            rowCount: inLiterals.length,
          })
          delIdx = nextDelIdx
          continue
        }
      }
      const whereSql = buildClickHouseWhereSql(pk)
      deletes.push({
        preview: `ALTER TABLE ${qTable} DELETE WHERE ${whereSql};`,
        exec: `ALTER TABLE ${qTable} DELETE WHERE ${whereSql} SETTINGS mutations_sync = 1`,
        rowCount: 1,
      })
      delIdx += 1
    }

    const updates: { preview: string; exec: string }[] = []
    for (const upd of params.updates ?? []) {
      const pkEntries = Object.entries(upd.primaryKeys || {}).filter(([, v]) => v !== undefined)
      if (pkEntries.length === 0) {
        throw new DatabaseDriverError(
          'Cannot generate UPDATE statement without primary key conditions (safety guard)',
          'invalid_params',
          'clickhouse'
        )
      }
      const changeEntries = Object.entries(upd.changes || {}).filter(([, v]) => v !== undefined)
      if (changeEntries.length === 0) continue

      const setSql = changeEntries
        .map(
          ([col, val]) =>
            `${quoteIdentForDialect(col, 'clickhouse')} = ${formatSqlValue(val, 'clickhouse')}`
        )
        .join(', ')
      const whereSql = buildClickHouseWhereSql(
        upd.primaryKeys,
        upd.originalRow,
        changeEntries.map(([c]) => c),
        columnTypes
      )
      updates.push({
        preview: `ALTER TABLE ${qTable} UPDATE ${setSql} WHERE ${whereSql};`,
        exec: `ALTER TABLE ${qTable} UPDATE ${setSql} WHERE ${whereSql} SETTINGS mutations_sync = 1`,
      })
    }

    const inserts: { preview: string; exec: string; rowCount: number }[] = []
    const rawInserts = params.inserts ?? []
    let idx = 0
    while (idx < rawInserts.length) {
      const firstRow = rawInserts[idx]
      const entries = Object.entries(firstRow || {}).filter(([, v]) => v !== undefined)
      if (entries.length === 0) {
        throw new DatabaseDriverError(
          'ClickHouse INSERT requires at least one column value',
          'invalid_params',
          'clickhouse'
        )
      }
      const cols = entries.map(([c]) => c)
      const colSig = cols.join('\0')
      const colsSql = cols.map((c) => quoteIdentForDialect(c, 'clickhouse')).join(', ')
      const firstTuple = `(${entries.map(([, v]) => formatSqlValue(v, 'clickhouse')).join(', ')})`
      const prefixSql = `INSERT INTO ${qTable} (${colsSql}) VALUES `
      let runningBytes = Buffer.byteLength(prefixSql + firstTuple + ';', 'utf8')
      const tuples: string[] = [firstTuple]

      let nextIdx = idx + 1
      while (nextIdx < rawInserts.length && tuples.length < CLICKHOUSE_MAX_INSERT_ROWS_PER_STMT) {
        const candidate = rawInserts[nextIdx]
        const candEntries = Object.entries(candidate || {}).filter(([, v]) => v !== undefined)
        if (candEntries.length === 0) break
        const candCols = candEntries.map(([c]) => c)
        if (candCols.join('\0') !== colSig) break
        const candTuple = `(${candEntries.map(([, v]) => formatSqlValue(v, 'clickhouse')).join(', ')})`
        const addedBytes = Buffer.byteLength(', ' + candTuple, 'utf8')
        if (runningBytes + addedBytes > CLICKHOUSE_MAX_INSERT_SQL_BYTES) break
        tuples.push(candTuple)
        runningBytes += addedBytes
        nextIdx += 1
      }

      const sql = `${prefixSql}${tuples.join(', ')};`
      inserts.push({ preview: sql, exec: sql, rowCount: tuples.length })
      idx = nextIdx
    }

    return { deletes, updates, inserts }
  }

  async previewChanges(params: ApplyChangesParams): Promise<PreviewChangesResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    const built = this.buildChangeStatements(params)
    return {
      statements: [
        ...built.deletes.map((d) => d.preview),
        ...built.updates.map((u) => u.preview),
        ...built.inserts.map((i) => i.preview),
      ],
    }
  }

  async applyChanges(params: ApplyChangesParams): Promise<ApplyChangesResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    this.assertWritable()
    const built = this.buildChangeStatements(params)

    let deleted = 0
    for (const d of built.deletes) {
      await this.executeHttp(d.exec)
      deleted += d.rowCount
    }

    let updated = 0
    for (const u of built.updates) {
      await this.executeHttp(u.exec)
      updated += 1
    }

    let inserted = 0
    for (const i of built.inserts) {
      await this.executeHttp(i.exec)
      inserted += i.rowCount
    }

    return {
      ok: true,
      inserted,
      updated,
      deleted,
      statements: [
        ...built.deletes.map((d) => d.preview),
        ...built.updates.map((u) => u.preview),
        ...built.inserts.map((i) => i.preview),
      ],
    }
  }

  async getDdl(table: string, schema?: string): Promise<string> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    const targetDb = schema || this.getDatabase()
    const qTable = quoteQualifiedTable(table, targetDb, 'clickhouse')
    try {
      const { json } = await this.executeHttp(`SHOW CREATE TABLE ${qTable}`, {
        expectJsonCompact: true,
      })
      const firstRow = json?.data?.[0]
      if (Array.isArray(firstRow) && typeof firstRow[0] === 'string' && firstRow[0].trim()) {
        const stmt = firstRow[0].trim()
        return stmt.endsWith(';') ? stmt : `${stmt};`
      }
    } catch {
      // Fallback to metadata-based DDL reconstruction
    }

    const details = await this.getTableDetails(table, targetDb)
    return reconstructTableDdl(details, 'clickhouse')
  }

  async runQuery(queryId: string, sql: string, maxRows = 1000): Promise<QueryResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    const trimmed = sql.trim()
    if (!trimmed) {
      throw new DatabaseDriverError('SQL statement cannot be empty', 'invalid_params', 'clickhouse')
    }

    const controller = new AbortController()
    const active: ActiveClickHouseQuery = {
      controller,
      cancelled: false,
      currentServerQueryId: queryId,
    }
    this.activeQueries.set(queryId, active)

    const start = performance.now()
    const stmts = splitSqlStatements(trimmed, 'clickhouse').map((s) => s.text)
    const statementList = stmts.length > 0 ? stmts : [trimmed]
    if (
      this.profile.readOnly &&
      statementList.some((stmt) => isMutatingStatement(stmt, 'clickhouse'))
    ) {
      throw new DatabaseDriverError(
        'Connection is read-only. Write operations are disabled.',
        'READ_ONLY',
        'clickhouse'
      )
    }

    try {
      let totalAffectedRows = 0
      let lastSelect: Omit<QueryResult, 'executionTimeMs'> | null = null
      const collectedSets: QueryResultSet[] = []

      for (let i = 0; i < statementList.length; i++) {
        const stmtSql = statementList[i]
        const serverQueryId = statementList.length === 1 ? queryId : `${queryId}_${i + 1}`
        active.currentServerQueryId = serverQueryId

        const expectRows = isRowReturningClickHouseQuery(stmtSql)
        const explicitFormat = extractExplicitClickHouseFormat(stmtSql)
        const isCustomNonJsonCompact =
          explicitFormat !== null && explicitFormat.toLowerCase() !== 'jsoncompact'

        const res = await this.executeHttp(stmtSql, {
          queryId: serverQueryId,
          expectJsonCompact: expectRows && !isCustomNonJsonCompact,
          signal: controller.signal,
          maxResultRows: expectRows && !isCustomNonJsonCompact && maxRows > 0 ? maxRows + 1 : undefined,
        })
        if (!expectRows) {
          const affected = res.summaryAffectedRows ?? 0
          totalAffectedRows += affected
          collectedSets.push({
            index: i,
            sqlPreview: compactSql(stmtSql),
            columns: [{ name: 'affected_rows', type: 'INTEGER' }],
            rows: [[affected]],
            rowCount: 1,
            affectedRows: affected,
            truncated: false,
            isSelect: false,
          })
        } else if (isCustomNonJsonCompact) {
          const normalizedText = res.rawText.replace(/\r?\n$/, '')
          const rawLines = normalizedText.length > 0 ? normalizedText.split(/\r?\n/) : []
          const limit = maxRows > 0 ? maxRows : rawLines.length
          const truncated = rawLines.length > limit
          const rows = rawLines.slice(0, limit).map((line) => [line])
          lastSelect = {
            columns: [{ name: `result (${explicitFormat})`, type: 'String' }],
            rows,
            rowCount: rows.length,
            truncated,
            isSelect: true,
          }
          collectedSets.push({
            index: i,
            sqlPreview: compactSql(stmtSql),
            columns: lastSelect.columns,
            rows: lastSelect.rows,
            rowCount: lastSelect.rowCount,
            truncated: lastSelect.truncated,
            isSelect: true,
          })
        } else {
          const columns = (res.json?.meta || []).map((m) => ({
            name: m.name,
            type: m.type || 'String',
          }))
          const allRows = Array.isArray(res.json?.data) ? res.json.data : []
          const limit = maxRows > 0 ? maxRows : allRows.length
          const truncated = allRows.length > limit
          const rows = allRows.slice(0, limit)
          lastSelect = {
            columns,
            rows,
            rowCount: rows.length,
            truncated,
            isSelect: true,
          }
          collectedSets.push({
            index: i,
            sqlPreview: compactSql(stmtSql),
            columns: lastSelect.columns,
            rows: lastSelect.rows,
            rowCount: lastSelect.rowCount,
            truncated: lastSelect.truncated,
            isSelect: true,
          })
        }
      }

      const executionTimeMs = Math.round(performance.now() - start)
      return lastSelect
        ? {
            ...lastSelect,
            affectedRows: totalAffectedRows,
            ...(collectedSets.length > 1 ? { resultSets: collectedSets } : {}),
            executionTimeMs,
          }
        : {
            columns: [],
            rows: [],
            rowCount: 0,
            affectedRows: totalAffectedRows,
            executionTimeMs,
            truncated: false,
            isSelect: false,
            ...(collectedSets.length > 1 ? { resultSets: collectedSets } : {}),
          }
    } catch (err) {
      if (active.cancelled && !(err instanceof DatabaseDriverError && err.code === 'cancelled')) {
        throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'clickhouse', err)
      }
      throw err
    } finally {
      this.activeQueries.delete(queryId)
    }
  }

  async cancelQuery(queryId: string): Promise<{ ok: boolean }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    const active = this.activeQueries.get(queryId)
    if (!active) {
      return { ok: true }
    }

    const targetServerQueryId = active.currentServerQueryId || queryId
    active.cancelled = true
    active.controller.abort()

    try {
      await this.executeHttp(
        `KILL QUERY WHERE query_id = '${escapeClickHouseLiteralText(targetServerQueryId)}' SYNC`
      )
    } catch {
      // Best-effort server-side kill
    }
    return { ok: true }
  }

  getTransactionState(): TransactionState {
    return createUnsupportedTransactionState(CLICKHOUSE_UNSUPPORTED_TX_REASON)
  }

  async beginTransaction(): Promise<TransactionState> {
    throw createUnsupportedTransactionError('clickhouse', CLICKHOUSE_UNSUPPORTED_TX_REASON)
  }

  async commitTransaction(): Promise<TransactionState> {
    throw createUnsupportedTransactionError('clickhouse', CLICKHOUSE_UNSUPPORTED_TX_REASON)
  }

  async rollbackTransaction(): Promise<TransactionState> {
    throw createUnsupportedTransactionError('clickhouse', CLICKHOUSE_UNSUPPORTED_TX_REASON)
  }

  async setAutoCommit(enabled: boolean): Promise<TransactionState> {
    if (!enabled) {
      throw createUnsupportedTransactionError('clickhouse', CLICKHOUSE_UNSUPPORTED_TX_REASON)
    }
    return this.getTransactionState()
  }
}

export class ClickHouseDriver implements IDatabaseDriver {
  readonly type = 'clickhouse' as const

  async createSession(
    profile: ConnectionProfile,
    secret?: string,
    extraSecrets?: DriverTlsOptions
  ): Promise<IDatabaseSession> {
    const tlsOverride = await resolveEffectiveTlsOptions(
      profile,
      extraSecrets,
      extraSecrets?.tlsServername
    )
    return new ClickHouseSession(profile, secret, tlsOverride)
  }

  async testConnection(
    profile: ConnectionProfile,
    secret?: string,
    extraSecrets?: DriverTlsOptions
  ): Promise<{ ok: boolean; message?: string }> {
    return runDriverConnectionTest(
      () => this.createSession(profile, secret, extraSecrets),
      (err) => (err instanceof Error ? err.message : 'ClickHouse connection failed')
    )
  }
}
