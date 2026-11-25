import * as net from 'node:net'
import { validateLibsqlEndpointUrl } from '../common/connection-uri'
import { scrubDriverErrorText } from '../common/sql-credentials'
import type {
  ApplyChangesParams,
  ApplyChangesResult,
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
  attachFailedStatementMeta,
  buildCombinedAbortSignal,
  createUnsupportedTransactionError,
  createUnsupportedTransactionState,
  runDriverConnectionTest,
} from '../common/driver'
import {
  assembleTableBrowseResult,
  buildBatchStatements,
  buildSelectByPrimaryKeySql,
  buildSelectPageSql,
  buildUpdateSql,
} from '../common/update-builder'
import {
  TableDetailsCache,
  collectAndAssembleSchemaDdl,
  introspectSqliteObjectDdl,
  introspectSqliteObjects,
  introspectSqliteSchemas,
  introspectSqliteTableDetails,
} from '../common/schema'
import {
  compactSql,
  containsDdlStatement,
  isMutatingStatement,
  quoteIdentForDialect,
  reconstructTableDdl,
  splitSqlStatements,
} from '../common/sql-tools'
import { stripLeadingSqlComments } from '../common/sql-lexer'

const LIBSQL_HTTP_TIMEOUT_MS = 30_000
const MAX_LIBSQL_RESPONSE_BYTES = 32 * 1024 * 1024

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const clHeader = response.headers?.get?.('content-length')
  if (clHeader) {
    const declared = Number(clHeader)
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel?.().catch(() => {})
      throw new DatabaseDriverError(
        `LibSQL HTTP response (${declared} bytes) exceeded the ${maxBytes}-byte safety limit.`,
        'RESPONSE_TOO_LARGE',
        'libsql'
      )
    }
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          totalBytes += value.byteLength
          if (totalBytes > maxBytes) {
            await reader.cancel().catch(() => {})
            throw new DatabaseDriverError(
              `LibSQL HTTP response exceeded the ${maxBytes}-byte safety limit.`,
              'RESPONSE_TOO_LARGE',
              'libsql'
            )
          }
          chunks.push(value)
        }
      }
    } finally {
      reader.releaseLock()
    }
    const decoder = new TextDecoder('utf-8')
    let text = ''
    for (const chunk of chunks) {
      text += decoder.decode(chunk, { stream: true })
    }
    text += decoder.decode()
    return text
  }

  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new DatabaseDriverError(
      `LibSQL HTTP response exceeded the ${maxBytes}-byte safety limit.`,
      'RESPONSE_TOO_LARGE',
      'libsql'
    )
  }
  return text
}
const LIBSQL_UNSUPPORTED_TX_REASON =
  'LibSQL does not support interactive multi-statement transactions'

type HranaValue =
  | { type: 'null' }
  | { type: 'integer'; value: string }
  | { type: 'float'; value: number }
  | { type: 'text'; value: string }
  | { type: 'blob'; base64: string }

interface HranaExecuteStmt {
  sql: string
  args?: HranaValue[]
}

type HranaBatchCondition =
  | { type: 'ok'; step: number }
  | { type: 'error'; step: number }
  | { type: 'not'; cond: HranaBatchCondition }
  | { type: 'and'; conds: HranaBatchCondition[] }
  | { type: 'or'; conds: HranaBatchCondition[] }

interface HranaBatchStep {
  condition?: HranaBatchCondition
  stmt: HranaExecuteStmt
}

type HranaRequestItem =
  | { type: 'execute'; stmt: HranaExecuteStmt }
  | { type: 'batch'; batch: { steps: HranaBatchStep[] } }
  | { type: 'close' }

interface HranaExecuteResult {
  cols?: Array<{ name: string; decltype?: string | null }>
  rows?: HranaValue[][]
  affected_row_count?: number
  last_insert_rowid?: string | null
}

interface HranaErrorObj {
  message?: string
  code?: string
}

interface HranaBatchResult {
  step_results?: Array<HranaExecuteResult | null>
  step_errors?: Array<HranaErrorObj | null>
}

interface HranaPipelineResponseItem {
  type: 'ok' | 'error'
  response?: {
    type?: string
    result?: HranaExecuteResult & HranaBatchResult
  }
  error?: HranaErrorObj
}

interface HranaPipelineRawResponse {
  baton?: string | null
  base_url?: string | null
  results?: HranaPipelineResponseItem[]
}

const HRANA_CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/

function isIpLiteralHostname(hostname: string): boolean {
  const clean = hostname.trim().replace(/^\[|\]$/g, '')
  if (!clean) return false
  if (net.isIP(clean) !== 0) return true
  return /^\d+(?:\.\d+){3}$/.test(clean)
}

function formatHranaErrorMessage(message: string | undefined, fallback: string): string {
  const msg = scrubLibsqlErrorText((message || '').trim())
  if (msg.includes('__datanoa_fk_violation__')) {
    return 'FOREIGN KEY constraint failed'
  }
  return msg || fallback
}

function scrubLibsqlErrorText(input: string): string {
  return scrubDriverErrorText(input)
}

function resolveLibsqlPipelineUrl(profile: ConnectionProfile, authToken?: string): string {
  let raw = (profile.url || '').trim()
  if (!raw && profile.host) {
    const proto = profile.ssl === false ? 'http' : 'https'
    const isDefaultPort =
      !profile.port ||
      (proto === 'https' && profile.port === 443) ||
      (proto === 'http' && profile.port === 80)
    raw = isDefaultPort
      ? `${proto}://${profile.host}`
      : `${proto}://${profile.host}:${profile.port}`
  }
  if (!raw) {
    throw new DatabaseDriverError('Missing LibSQL URL or host', 'invalid_params', 'libsql')
  }

  const preferredProto = profile.ssl === false ? 'http' : 'https'
  if (/^libsql:\/\//i.test(raw)) {
    raw = raw.replace(/^libsql:\/\//i, `${preferredProto}://`)
  } else if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    raw = `${preferredProto}://${raw}`
  }

  const validated = validateLibsqlEndpointUrl(raw, {
    hasAuthToken: Boolean((authToken && authToken.trim().length > 0) || profile.hasAuthToken),
  })
  if (!validated.ok) {
    throw new DatabaseDriverError(validated.error, 'INVALID_ENDPOINT', 'libsql')
  }

  let parsed: URL
  try {
    parsed = new URL(validated.url)
  } catch (err) {
    throw new DatabaseDriverError(
      'Invalid LibSQL endpoint URL',
      'INVALID_ENDPOINT',
      'libsql',
      err
    )
  }

  const cleanPath = parsed.pathname.replace(/\/+$/, '')
  const pipelinePath = cleanPath.endsWith('/v2/pipeline')
    ? cleanPath
    : `${cleanPath}/v2/pipeline`
  return `${parsed.origin}${pipelinePath}`
}

function encodeHranaValue(val: unknown): HranaValue {
  if (val === null || val === undefined) return { type: 'null' }
  if (typeof val === 'boolean') return { type: 'integer', value: val ? '1' : '0' }
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return { type: 'null' }
    return Number.isInteger(val)
      ? { type: 'integer', value: String(val) }
      : { type: 'float', value: val }
  }
  if (typeof val === 'bigint') return { type: 'integer', value: val.toString() }
  if (val instanceof Date) {
    return Number.isNaN(val.getTime())
      ? { type: 'null' }
      : { type: 'text', value: val.toISOString() }
  }
  if (val instanceof ArrayBuffer) {
    return { type: 'blob', base64: Buffer.from(val).toString('base64') }
  }
  if (ArrayBuffer.isView(val)) {
    return {
      type: 'blob',
      base64: Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString('base64'),
    }
  }
  if (typeof val === 'object') {
    return { type: 'text', value: JSON.stringify(val) }
  }
  return { type: 'text', value: String(val) }
}

function decodeHranaValue(cell: unknown): unknown {
  if (cell === null || cell === undefined) return null
  if (typeof cell !== 'object') return cell
  const typed = cell as { type?: string; value?: unknown; base64?: string }
  switch (typed.type) {
    case 'null':
      return null
    case 'integer': {
      const n = Number(typed.value)
      return Number.isSafeInteger(n) ? n : String(typed.value ?? '0')
    }
    case 'float':
      return Number(typed.value)
    case 'text':
      return String(typed.value ?? '')
    case 'blob':
      return typeof typed.base64 === 'string'
        ? new Uint8Array(Buffer.from(typed.base64, 'base64'))
        : null
    default:
      return typed.value ?? null
  }
}

function hranaRowsToRecords(result: HranaExecuteResult): Record<string, unknown>[] {
  const cols = result.cols || []
  const rows = result.rows || []
  return rows.map((rowArr) => {
    const obj: Record<string, unknown> = {}
    for (let i = 0; i < cols.length; i++) {
      obj[cols[i].name] = decodeHranaValue(rowArr[i])
    }
    return obj
  })
}

function parseHranaStatementResult(
  res: HranaExecuteResult,
  stmtSql: string,
  maxRows: number
):
  | { isSelect: true; result: Omit<QueryResult, 'executionTimeMs'> }
  | { isSelect: false; affectedRows: number } {
  const cols = (res.cols || []).map((c) => ({
    name: c.name,
    type: c.decltype || 'TEXT',
  }))

  const stripped = stmtSql.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '').trim()
  let isSelect = cols.length > 0
  if (!isSelect) {
    if (/^PRAGMA\b/i.test(stripped)) {
      isSelect = !stripped.includes('=') && !isMutatingStatement(stmtSql, 'libsql')
    } else if (/^WITH\b/i.test(stripped)) {
      isSelect = !isMutatingStatement(stmtSql, 'libsql')
    } else {
      isSelect = /^(?:SELECT|EXPLAIN)\b/i.test(stripped)
    }
  }
  if (!isSelect) {
    return {
      isSelect: false,
      affectedRows: Number(res.affected_row_count ?? 0),
    }
  }

  const rawRows = (res.rows || []).map((rowArr) => rowArr.map(decodeHranaValue))
  const limit = maxRows > 0 ? maxRows : rawRows.length
  const truncated = rawRows.length > limit
  const rows = rawRows.slice(0, limit)

  return {
    isSelect: true,
    result: {
      columns: cols,
      rows,
      rowCount: rows.length,
      truncated,
      isSelect: true,
    },
  }
}

interface ActiveLibsqlQuery {
  controller: AbortController
  cancelled: boolean
}

export class LibsqlSession implements IDatabaseSession {
  readonly driverType = 'libsql' as const
  readonly profile: ConnectionProfile
  readonly pipelineUrl: string
  private readonly authToken?: string
  private readonly activeQueries = new Map<string, ActiveLibsqlQuery>()
  private readonly tableDetailsCache = new TableDetailsCache()
  private isClosed = false

  constructor(profile: ConnectionProfile, authToken?: string) {
    this.profile = profile
    this.authToken = authToken
    this.pipelineUrl = resolveLibsqlPipelineUrl(profile, authToken)
  }

  isAlive(): boolean {
    return !this.isClosed
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.authToken && this.authToken.trim().length > 0) {
      headers['Authorization'] = `Bearer ${this.authToken.trim()}`
    }
    return headers
  }

  resolveTargetUrl(baseUrl?: string | null): string {
    if (!baseUrl) return this.pipelineUrl
    const raw = baseUrl.trim()
    if (!raw) return this.pipelineUrl
    if (HRANA_CONTROL_CHARS_RE.test(raw)) {
      throw new DatabaseDriverError(
        'LibSQL Hrana base_url must not contain control characters',
        'INVALID_ENDPOINT',
        'libsql'
      )
    }

    let initial: URL
    let next: URL
    try {
      initial = new URL(this.pipelineUrl)
      next = new URL(raw)
    } catch (err) {
      throw new DatabaseDriverError(
        'Invalid LibSQL Hrana base_url',
        'INVALID_ENDPOINT',
        'libsql',
        err
      )
    }

    if (next.protocol !== 'https:' && next.protocol !== 'http:') {
      throw new DatabaseDriverError(
        `Unsupported LibSQL Hrana base_url scheme "${next.protocol}"`,
        'INVALID_ENDPOINT',
        'libsql'
      )
    }
    if (initial.protocol === 'https:' && next.protocol !== 'https:') {
      throw new DatabaseDriverError(
        'LibSQL Hrana base_url cannot downgrade from HTTPS to HTTP',
        'INVALID_ENDPOINT',
        'libsql'
      )
    }
    if (next.username || next.password || next.search || next.hash || raw.includes('?') || raw.includes('#')) {
      throw new DatabaseDriverError(
        'LibSQL Hrana base_url must not include userinfo, query parameters, or hash fragments',
        'INVALID_ENDPOINT',
        'libsql'
      )
    }

    const sameOrigin = next.origin === initial.origin
    if (!sameOrigin) {
      const initialHost = initial.hostname.toLowerCase()
      const nextHost = next.hostname.toLowerCase()
      const isTursoManagedHost =
        initialHost.endsWith('.turso.io') && initialHost.length > '.turso.io'.length
      const suffix = `.${initialHost}`
      const replicaPrefix = nextHost.endsWith(suffix)
        ? nextHost.slice(0, -suffix.length)
        : ''
      const isSingleLabelReplica =
        replicaPrefix.length > 0 &&
        !replicaPrefix.includes('.') &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(replicaPrefix)
      const isTrustedTursoReplica =
        isTursoManagedHost &&
        initial.protocol === 'https:' &&
        next.protocol === 'https:' &&
        initial.port === '' &&
        next.port === '' &&
        !isIpLiteralHostname(initialHost) &&
        !isIpLiteralHostname(nextHost) &&
        isSingleLabelReplica
      if (!isTrustedTursoReplica) {
        throw new DatabaseDriverError(
          'Untrusted LibSQL Hrana base_url origin',
          'INVALID_ENDPOINT',
          'libsql'
        )
      }
    }

    const cleanPath = next.pathname.replace(/\/+$/, '')
    const pipelinePath = cleanPath.endsWith('/v2/pipeline')
      ? cleanPath
      : `${cleanPath}/v2/pipeline`
    return `${next.origin}${pipelinePath}`
  }

  private async sendHranaPipeline(
    requests: HranaRequestItem[],
    options?: {
      baton?: string | null
      baseUrl?: string | null
      signal?: AbortSignal
    }
  ): Promise<{
    baton: string | null
    baseUrl: string | null
    results: HranaPipelineResponseItem[]
  }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'libsql')
    }

    const targetUrl = this.resolveTargetUrl(options?.baseUrl)
    const payload: Record<string, unknown> = { requests }
    if (options?.baton) {
      payload.baton = options.baton
    }

    const combinedSignal = buildCombinedAbortSignal(LIBSQL_HTTP_TIMEOUT_MS, options?.signal)
    let response: Response
    try {
      response = await fetch(targetUrl, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: combinedSignal,
      })
    } catch (err: unknown) {
      const errName = (err as { name?: string })?.name
      if (options?.signal?.aborted) {
        throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'libsql', err)
      }
      if (errName === 'TimeoutError' || errName === 'AbortError') {
        throw new DatabaseDriverError(
          `LibSQL HTTP request timed out after ${LIBSQL_HTTP_TIMEOUT_MS}ms`,
          'TIMEOUT',
          'libsql',
          err
        )
      }
      throw new DatabaseDriverError(
        err instanceof Error
          ? scrubLibsqlErrorText(err.message) || 'LibSQL HTTP request failed'
          : 'LibSQL HTTP request failed',
        'CONNECTION_FAILED',
        'libsql',
        err
      )
    }

    const rawText = await readBoundedResponseText(response, MAX_LIBSQL_RESPONSE_BYTES)
    if (!response.ok) {
      throw new DatabaseDriverError(
        scrubLibsqlErrorText(rawText.trim()) || `LibSQL HTTP error ${response.status}`,
        'LIBSQL_ERROR',
        'libsql'
      )
    }

    let parsed: HranaPipelineRawResponse
    try {
      parsed = JSON.parse(rawText) as HranaPipelineRawResponse
    } catch (err) {
      throw new DatabaseDriverError(
        `Invalid LibSQL Hrana response: ${scrubLibsqlErrorText(err instanceof Error ? err.message : String(err))}`,
        'LIBSQL_PARSE_ERROR',
        'libsql',
        err
      )
    }

    const nextBaseUrl =
      typeof parsed.base_url === 'string' && parsed.base_url.trim().length > 0
        ? parsed.base_url.trim()
        : options?.baseUrl ?? null
    if (nextBaseUrl) {
      this.resolveTargetUrl(nextBaseUrl)
    }

    return {
      baton: typeof parsed.baton === 'string' && parsed.baton.length > 0 ? parsed.baton : null,
      baseUrl: nextBaseUrl,
      results: Array.isArray(parsed.results) ? parsed.results : [],
    }
  }

  private async executePipeline(
    stmts: HranaExecuteStmt[],
    signal?: AbortSignal
  ): Promise<HranaExecuteResult[]> {
    const requests: HranaRequestItem[] = [
      ...stmts.map((stmt) => ({ type: 'execute' as const, stmt })),
      { type: 'close' as const },
    ]
    const { results } = await this.sendHranaPipeline(requests, { signal })

    const out: HranaExecuteResult[] = []
    for (let i = 0; i < stmts.length; i++) {
      const item = results[i]
      if (!item) {
        throw new DatabaseDriverError('Missing Hrana pipeline result', 'LIBSQL_ERROR', 'libsql')
      }
      if (item.type === 'error') {
        throw new DatabaseDriverError(
          formatHranaErrorMessage(item.error?.message, 'LibSQL statement execution failed'),
          item.error?.code || 'LIBSQL_ERROR',
          'libsql'
        )
      }
      out.push(item.response?.result || {})
    }
    return out
  }

  private async executeSingle(
    sql: string,
    params: unknown[] = [],
    signal?: AbortSignal
  ): Promise<HranaExecuteResult> {
    const [result] = await this.executePipeline(
      [{ sql, args: params.map(encodeHranaValue) }],
      signal
    )
    return result
  }

  private readonly queryExecutor = async (
    sql: string,
    params?: unknown[]
  ): Promise<Record<string, unknown>[]> => {
    const res = await this.executeSingle(sql, params || [])
    return hranaRowsToRecords(res)
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    if (this.isClosed) {
      return { ok: false, message: 'Session is closed' }
    }
    try {
      await this.executeSingle('SELECT 1;')
      return { ok: true, message: 'LibSQL connection valid' }
    } catch (err: unknown) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to connect to LibSQL',
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
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'libsql')
    }
    return introspectSqliteObjects(this.queryExecutor, schema || 'main')
  }

  async listSchemas(): Promise<{ schemas: string[]; defaultSchema: string }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'libsql')
    }
    return introspectSqliteSchemas(this.queryExecutor)
  }

  async getObjectDdl(name: string, kind: SchemaObjectKind, schema?: string): Promise<string> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'libsql')
    }
    if (kind === 'table' || kind === 'view') {
      return this.getDdl(name, schema)
    }
    return introspectSqliteObjectDdl(this.queryExecutor, name, kind, schema || 'main')
  }

  async exportSchemaDdl(schema?: string): Promise<{ ddl: string; objectCount: number }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'libsql')
    }
    const targetSchema = (schema || 'main').trim() || 'main'
    const objects = await this.listObjects(targetSchema)
    return collectAndAssembleSchemaDdl({
      dialect: 'libsql',
      schemaName: targetSchema,
      objects,
      getObjectDdl: (object) =>
        object.kind === 'table' || object.kind === 'view'
          ? this.fetchTableOrViewDdl(object.name, targetSchema, false)
          : this.getObjectDdl(object.name, object.kind, targetSchema),
    })
  }

  async getTableDetails(table: string, schema?: string): Promise<TableDetails> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'libsql')
    }
    const targetSchema = schema || 'main'
    const cached = this.tableDetailsCache.get(targetSchema, 'main', table)
    if (cached) {
      return cached
    }
    const details = await introspectSqliteTableDetails(this.queryExecutor, table, targetSchema)
    this.tableDetailsCache.set(targetSchema, 'main', table, details)
    return details
  }

  async fetchPage(params: FetchPageParams): Promise<TableBrowseResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'libsql')
    }
    const details = await this.getTableDetails(params.table, params.schema)
    const { sql, countSql, params: queryParams } = buildSelectPageSql({
      driver: 'libsql',
      table: params.table,
      schema: params.schema,
      page: params.page,
      pageSize: params.pageSize,
      sortColumn: params.sortColumn,
      sortDirection: params.sortDirection,
      primaryKey: details.primaryKey,
      whereClause: params.whereClause,
      orderByClause: params.orderByClause,
    })

    const [countRes, dataRes] = await this.executePipeline([
      { sql: countSql, args: [] },
      { sql, args: queryParams.map(encodeHranaValue) },
    ])

    const countRows = hranaRowsToRecords(countRes)
    const dataRows = hranaRowsToRecords(dataRes)

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
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'libsql')
    }
    if (this.profile.readOnly) {
      throw new DatabaseDriverError('Connection is configured as read-only', 'READ_ONLY', 'libsql')
    }
    const targetSchema = params.schema || 'main'
    const originalColumnType = this.tableDetailsCache.findColumnType(
      targetSchema,
      'main',
      params.table,
      params.column,
      params.columnType
    )
    const { sql, params: updateParams } = buildUpdateSql({
      driver: 'libsql',
      table: params.table,
      schema: params.schema,
      column: params.column,
      newValue: params.newValue,
      primaryKeys: params.primaryKeys,
      originalValue: params.originalValue,
      originalColumnType,
    })

    const res = await this.executeSingle(sql, updateParams)
    const affectedRows = Number(res.affected_row_count ?? 0)
    if (affectedRows === 0) {
      throw new DatabaseDriverError(
        'Record was modified or deleted by another session (optimistic lock conflict)',
        'conflict',
        'libsql'
      )
    }

    this.tableDetailsCache.clear()

    const reloadQuery = buildSelectByPrimaryKeySql({
      driver: 'libsql',
      table: params.table,
      schema: params.schema,
      primaryKeys: params.primaryKeys,
      editedColumn: params.column,
      newValue: params.newValue,
    })

    let updatedRecord: Record<string, unknown> | undefined
    if (reloadQuery) {
      const sel = await this.executeSingle(reloadQuery.sql, reloadQuery.params)
      updatedRecord = hranaRowsToRecords(sel)[0]
    }

    return {
      ok: true,
      affectedRows,
      updatedRecord,
    }
  }

  async previewChanges(params: ApplyChangesParams): Promise<PreviewChangesResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'libsql')
    }
    const batch = buildBatchStatements({
      driver: 'libsql',
      table: params.table,
      schema: params.schema,
      inserts: params.inserts,
      updates: params.updates,
      deletes: params.deletes,
      columnTypes: this.tableDetailsCache.resolveColumnTypes(
        params.schema,
        'main',
        params.table,
        params.columnTypes
      ),
    })
    return { statements: batch.previewStatements }
  }

  async applyChanges(params: ApplyChangesParams): Promise<ApplyChangesResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'libsql')
    }
    if (this.profile.readOnly) {
      throw new DatabaseDriverError('Connection is configured as read-only', 'READ_ONLY', 'libsql')
    }
    const batch = buildBatchStatements({
      driver: 'libsql',
      table: params.table,
      schema: params.schema,
      inserts: params.inserts,
      updates: params.updates,
      deletes: params.deletes,
      columnTypes: this.tableDetailsCache.resolveColumnTypes(
        params.schema,
        'main',
        params.table,
        params.columnTypes
      ),
    })
    if (batch.all.length === 0) {
      return { ok: true, inserted: 0, updated: 0, deleted: 0, statements: [] }
    }

    // Round-trip 1: Open stateful Hrana v2 baton stream with BEGIN IMMEDIATE + DML statements (NO COMMIT yet!)
    const round1Requests: HranaRequestItem[] = [
      { type: 'execute', stmt: { sql: 'BEGIN IMMEDIATE;' } },
      ...batch.all.map((s) => ({
        type: 'execute' as const,
        stmt: {
          sql: s.sql,
          args: s.params.map(encodeHranaValue),
        },
      })),
    ]

    const round1 = await this.sendHranaPipeline(round1Requests)
    const rollbackAndClose = async (): Promise<void> => {
      await this.sendHranaPipeline(
        [
          { type: 'execute', stmt: { sql: 'ROLLBACK;' } },
          { type: 'close' },
        ],
        { baton: round1.baton, baseUrl: round1.baseUrl }
      ).catch(() => {})
    }

    // Verify BEGIN IMMEDIATE succeeded
    const beginItem = round1.results[0]
    if (!beginItem || beginItem.type === 'error') {
      if (round1.baton) {
        await this.sendHranaPipeline([{ type: 'close' }], {
          baton: round1.baton,
          baseUrl: round1.baseUrl,
        }).catch(() => {})
      }
      throw new DatabaseDriverError(
        formatHranaErrorMessage(beginItem?.error?.message, 'Failed to begin LibSQL transaction'),
        beginItem?.error?.code || 'LIBSQL_ERROR',
        'libsql'
      )
    }

    // Verify every DML statement succeeded BEFORE checking counts or committing
    const dmlResults: HranaExecuteResult[] = []
    for (let i = 0; i < batch.all.length; i++) {
      const item = round1.results[i + 1]
      if (!item) {
        await rollbackAndClose()
        throw new DatabaseDriverError('Missing Hrana pipeline DML result', 'LIBSQL_ERROR', 'libsql')
      }
      if (item.type === 'error') {
        await rollbackAndClose()
        throw new DatabaseDriverError(
          formatHranaErrorMessage(item.error?.message, 'LibSQL statement execution failed'),
          item.error?.code || 'LIBSQL_ERROR',
          'libsql'
        )
      }
      dmlResults.push(item.response?.result || {})
    }

    // Verify optimistic concurrency lock (affected_row_count > 0 for every DELETE and UPDATE) BEFORE COMMIT!
    let offset = 0
    let deleted = 0
    for (let i = 0; i < batch.deletes.length; i++) {
      const count = Number(dmlResults[offset++]?.affected_row_count ?? 0)
      if (count === 0) {
        await rollbackAndClose()
        throw new DatabaseDriverError(
          'Record was modified or deleted by another session (optimistic lock conflict)',
          'conflict',
          'libsql'
        )
      }
      deleted += count
    }

    let updated = 0
    for (let i = 0; i < batch.updates.length; i++) {
      const count = Number(dmlResults[offset++]?.affected_row_count ?? 0)
      if (count === 0) {
        await rollbackAndClose()
        throw new DatabaseDriverError(
          'Record was modified or deleted by another session (optimistic lock conflict)',
          'conflict',
          'libsql'
        )
      }
      updated += count
    }

    let inserted = 0
    for (let i = 0; i < batch.inserts.length; i++) {
      inserted += Number(dmlResults[offset++]?.affected_row_count ?? 1)
    }

    // Round-trip 2: All checks passed -> COMMIT and close the Hrana baton stream
    const commitRes = await this.sendHranaPipeline(
      [
        { type: 'execute', stmt: { sql: 'COMMIT;' } },
        { type: 'close' },
      ],
      { baton: round1.baton, baseUrl: round1.baseUrl }
    )
    const commitItem = commitRes.results[0]
    if (!commitItem || commitItem.type === 'error') {
      throw new DatabaseDriverError(
        formatHranaErrorMessage(commitItem?.error?.message, 'Failed to commit LibSQL transaction'),
        commitItem?.error?.code || 'LIBSQL_ERROR',
        'libsql'
      )
    }

    this.tableDetailsCache.clear()

    return {
      ok: true,
      inserted,
      updated,
      deleted,
      statements: batch.previewStatements,
    }
  }

  async getDdl(table: string, schema?: string): Promise<string> {
    return this.fetchTableOrViewDdl(table, schema, true)
  }

  private async fetchTableOrViewDdl(
    table: string,
    schema: string | undefined,
    includeTriggers: boolean
  ): Promise<string> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'libsql')
    }
    const targetSchema = schema?.trim()
    const masterTable =
      targetSchema && targetSchema.toLowerCase() !== 'main'
        ? `${quoteIdentForDialect(targetSchema, 'libsql')}.sqlite_master`
        : 'sqlite_master'
    const attachedTypes = includeTriggers ? "'index', 'trigger'" : "'index'"

    const rows = await this.queryExecutor(
      `
        SELECT type, sql
        FROM ${masterTable}
        WHERE ((type IN ('table', 'view') AND name = ?) OR (type IN (${attachedTypes}) AND tbl_name = ?))
          AND sql IS NOT NULL
        ORDER BY CASE WHEN type IN ('table', 'view') THEN 0 WHEN type = 'index' THEN 1 ELSE 2 END, name ASC;
      `,
      [table, table]
    )

    const hasMainDef = rows.some(
      (r) =>
        (r.type === 'table' || r.type === 'view') &&
        typeof r.sql === 'string' &&
        r.sql.trim().length > 0
    )
    if (hasMainDef) {
      return rows
        .map((r) => String(r.sql || '').trim())
        .filter((s) => s.length > 0)
        .map((s) => (s.endsWith(';') ? s : `${s};`))
        .join('\n\n')
    }

    const details = await this.getTableDetails(table, schema)
    return reconstructTableDdl(details, 'libsql')
  }

  async runQuery(queryId: string, sql: string, maxRows = 1000): Promise<QueryResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'libsql')
    }
    const trimmed = sql.trim()
    if (!trimmed) {
      throw new DatabaseDriverError('SQL statement cannot be empty', 'invalid_params', 'libsql')
    }

    const controller = new AbortController()
    const active: ActiveLibsqlQuery = { controller, cancelled: false }
    this.activeQueries.set(queryId, active)

    const start = performance.now()
    try {
      const stmts = splitSqlStatements(trimmed, 'libsql').map((s) => s.text)
      if (
        this.profile.readOnly &&
        (isMutatingStatement(trimmed, 'libsql') || stmts.some((s) => isMutatingStatement(s, 'libsql')))
      ) {
        throw new DatabaseDriverError('Connection is configured as read-only', 'READ_ONLY', 'libsql')
      }
      let totalAffectedRows = 0
      let lastSelect: Omit<QueryResult, 'executionTimeMs'> | null = null
      const collectedSets: QueryResultSet[] = []
      const pushAffectedSet = (index: number, stmtSql: string, affected: number): void => {
        collectedSets.push({
          index,
          sqlPreview: compactSql(stmtSql),
          columns: [{ name: 'affected_rows', type: 'INTEGER' }],
          rows: [[affected]],
          rowCount: 1,
          affectedRows: affected,
          truncated: false,
          isSelect: false,
        })
      }

      if (stmts.length <= 1) {
        let res: HranaExecuteResult
        try {
          res = await this.executeSingle(trimmed, [], controller.signal)
        } catch (singleErr: unknown) {
          if (
            !active.cancelled &&
            !(
              singleErr instanceof DatabaseDriverError &&
              (singleErr.code === 'cancelled' ||
                singleErr.code === 'SESSION_CLOSED' ||
                singleErr.code === 'TIMEOUT')
            )
          ) {
            throw attachFailedStatementMeta(singleErr, 0, 1)
          }
          throw singleErr
        }
        const parsed = parseHranaStatementResult(res, trimmed, maxRows)
        if (parsed.isSelect) {
          lastSelect = parsed.result
          collectedSets.push({
            index: 0,
            sqlPreview: compactSql(trimmed),
            columns: parsed.result.columns,
            rows: parsed.result.rows,
            rowCount: parsed.result.rowCount,
            truncated: parsed.result.truncated,
            isSelect: true,
          })
        } else {
          totalAffectedRows = parsed.affectedRows
          pushAffectedSet(0, trimmed, parsed.affectedRows)
        }
      } else {
        // Use Hrana v2 conditional batch so any mid-script failure halts subsequent steps
        // (preventing failed 12-step table rebuilds from executing DROP TABLE)
        const steps: HranaBatchStep[] = stmts.map((stmtSql, idx) => ({
          ...(idx > 0 ? { condition: { type: 'ok' as const, step: idx - 1 } } : {}),
          stmt: { sql: stmtSql, args: [] },
        }))
        const beginIdx = stmts.findIndex((s) => /^\s*BEGIN\b/i.test(stripLeadingSqlComments(s, 'libsql')))
        if (beginIdx >= 0) {
          let commitIdx = -1
          for (let i = stmts.length - 1; i > beginIdx; i--) {
            if (/^\s*(?:COMMIT|END)\b/i.test(stripLeadingSqlComments(stmts[i], 'libsql'))) {
              commitIdx = i
              break
            }
          }
          const guardStep = commitIdx > beginIdx ? commitIdx : stmts.length - 1
          steps.push({
            condition: {
              type: 'and',
              conds: [
                { type: 'ok', step: beginIdx },
                { type: 'not', cond: { type: 'ok', step: guardStep } },
              ],
            },
            stmt: { sql: 'ROLLBACK;' },
          })
        }

        const { results } = await this.sendHranaPipeline(
          [
            { type: 'batch', batch: { steps } },
            { type: 'close' },
          ],
          { signal: controller.signal }
        )
        const batchItem = results[0]
        if (!batchItem) {
          throw new DatabaseDriverError('Missing Hrana batch result', 'LIBSQL_ERROR', 'libsql')
        }
        if (batchItem.type === 'error') {
          throw new DatabaseDriverError(
            formatHranaErrorMessage(batchItem.error?.message, 'LibSQL batch execution failed'),
            batchItem.error?.code || 'LIBSQL_ERROR',
            'libsql'
          )
        }
        const batchResult = batchItem.response?.result
        const stepErrors = batchResult?.step_errors || []
        for (let i = 0; i < stmts.length; i++) {
          const stepErr = stepErrors[i]
          if (stepErr) {
            throw attachFailedStatementMeta(
              new DatabaseDriverError(
                formatHranaErrorMessage(stepErr.message, 'LibSQL statement execution failed'),
                stepErr.code || 'LIBSQL_ERROR',
                'libsql'
              ),
              i,
              stmts.length
            )
          }
        }
        const stepResults = batchResult?.step_results || []
        for (let i = 0; i < stmts.length; i++) {
          const stepRes = stepResults[i]
          if (!stepRes) continue
          const parsed = parseHranaStatementResult(stepRes, stmts[i], maxRows)
          if (parsed.isSelect) {
            lastSelect = parsed.result
            collectedSets.push({
              index: i,
              sqlPreview: compactSql(stmts[i]),
              columns: parsed.result.columns,
              rows: parsed.result.rows,
              rowCount: parsed.result.rowCount,
              truncated: parsed.result.truncated,
              isSelect: true,
            })
          } else {
            totalAffectedRows += parsed.affectedRows
            pushAffectedSet(i, stmts[i], parsed.affectedRows)
          }
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
        throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'libsql', err)
      }
      throw err
    } finally {
      if (containsDdlStatement(sql, 'libsql')) {
        this.tableDetailsCache.clear()
      }
      this.activeQueries.delete(queryId)
    }
  }

  async cancelQuery(queryId: string): Promise<{ ok: boolean }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'libsql')
    }
    const active = this.activeQueries.get(queryId)
    if (!active) {
      return { ok: true }
    }
    active.cancelled = true
    active.controller.abort()
    return { ok: true }
  }

  getTransactionState(): TransactionState {
    return createUnsupportedTransactionState(LIBSQL_UNSUPPORTED_TX_REASON)
  }

  async beginTransaction(): Promise<TransactionState> {
    throw createUnsupportedTransactionError('libsql', LIBSQL_UNSUPPORTED_TX_REASON)
  }

  async commitTransaction(): Promise<TransactionState> {
    throw createUnsupportedTransactionError('libsql', LIBSQL_UNSUPPORTED_TX_REASON)
  }

  async rollbackTransaction(): Promise<TransactionState> {
    throw createUnsupportedTransactionError('libsql', LIBSQL_UNSUPPORTED_TX_REASON)
  }

  async setAutoCommit(enabled: boolean): Promise<TransactionState> {
    if (!enabled) {
      throw createUnsupportedTransactionError('libsql', LIBSQL_UNSUPPORTED_TX_REASON)
    }
    return this.getTransactionState()
  }
}

export class LibsqlDriver implements IDatabaseDriver {
  readonly type = 'libsql' as const

  async createSession(profile: ConnectionProfile, authToken?: string): Promise<IDatabaseSession> {
    return new LibsqlSession(profile, authToken)
  }

  async testConnection(
    profile: ConnectionProfile,
    authToken?: string
  ): Promise<{ ok: boolean; message?: string }> {
    return runDriverConnectionTest(
      () => this.createSession(profile, authToken),
      (err) => (err instanceof Error ? err.message : 'LibSQL connection failed')
    )
  }
}
