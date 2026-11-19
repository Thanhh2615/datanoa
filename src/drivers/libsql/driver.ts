import type {
  ApplyChangesParams,
  ApplyChangesResult,
  ConnectionProfile,
  FetchPageParams,
  IDatabaseDriver,
  IDatabaseSession,
  PreviewChangesResult,
  QueryResult,
  SchemaObject,
  TableBrowseResult,
  TableDetails,
  UpdateCellParams,
  UpdateCellResult,
} from '../common/driver'
import { DatabaseDriverError } from '../common/driver'
import {
  assembleTableBrowseResult,
  buildBatchStatements,
  buildSelectPageSql,
  buildUpdateSql,
  quoteQualifiedTable,
} from '../common/update-builder'
import {
  TableDetailsCache,
  introspectSqliteObjects,
  introspectSqliteTableDetails,
} from '../common/schema'
import {
  containsDdlStatement,
  isMutatingStatement,
  quoteIdentForDialect,
  reconstructTableDdl,
  splitSqlStatements,
} from '../common/sql-tools'

const LIBSQL_HTTP_TIMEOUT_MS = 30_000

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

function buildCombinedAbortSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(LIBSQL_HTTP_TIMEOUT_MS)
  if (!signal) {
    return timeoutSignal
  }
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, timeoutSignal])
  }
  return signal
}

function resolveLibsqlPipelineUrl(profile: ConnectionProfile): string {
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
  } else if (!/^https?:\/\//i.test(raw)) {
    raw = `${preferredProto}://${raw}`
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch (err) {
    throw new DatabaseDriverError(
      `Invalid LibSQL URL: ${raw}`,
      'invalid_params',
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
    this.pipelineUrl = resolveLibsqlPipelineUrl(profile)
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

  private resolveTargetUrl(baseUrl?: string | null): string {
    if (!baseUrl) return this.pipelineUrl
    const cleaned = baseUrl.trim().replace(/\/+$/, '')
    if (!cleaned) return this.pipelineUrl
    return cleaned.endsWith('/v2/pipeline') ? cleaned : `${cleaned}/v2/pipeline`
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

    const payload: Record<string, unknown> = { requests }
    if (options?.baton) {
      payload.baton = options.baton
    }

    const combinedSignal = buildCombinedAbortSignal(options?.signal)
    let response: Response
    try {
      response = await fetch(this.resolveTargetUrl(options?.baseUrl), {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
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
        err instanceof Error ? err.message : 'LibSQL HTTP request failed',
        'CONNECTION_FAILED',
        'libsql',
        err
      )
    }

    const rawText = await response.text()
    if (!response.ok) {
      throw new DatabaseDriverError(
        rawText.trim() || `LibSQL HTTP error ${response.status}`,
        'LIBSQL_ERROR',
        'libsql'
      )
    }

    let parsed: HranaPipelineRawResponse
    try {
      parsed = JSON.parse(rawText) as HranaPipelineRawResponse
    } catch (err) {
      throw new DatabaseDriverError(
        `Invalid LibSQL Hrana response: ${err instanceof Error ? err.message : String(err)}`,
        'LIBSQL_PARSE_ERROR',
        'libsql',
        err
      )
    }

    return {
      baton: typeof parsed.baton === 'string' && parsed.baton.length > 0 ? parsed.baton : null,
      baseUrl:
        typeof parsed.base_url === 'string' && parsed.base_url.length > 0
          ? parsed.base_url
          : options?.baseUrl ?? null,
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
          item.error?.message || 'LibSQL statement execution failed',
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
    const { sql, params: updateParams } = buildUpdateSql({
      driver: 'libsql',
      table: params.table,
      schema: params.schema,
      column: params.column,
      newValue: params.newValue,
      primaryKeys: params.primaryKeys,
      originalValue: params.originalValue,
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

    const whereParts: string[] = []
    const pkValues: unknown[] = []
    for (const [pkCol, rawPkVal] of Object.entries(params.primaryKeys)) {
      const effectivePkVal = pkCol === params.column ? params.newValue : rawPkVal
      if (effectivePkVal === null || effectivePkVal === undefined) {
        whereParts.push(`${quoteIdentForDialect(pkCol, 'libsql')} IS NULL`)
      } else {
        whereParts.push(`${quoteIdentForDialect(pkCol, 'libsql')} = ?`)
        pkValues.push(effectivePkVal)
      }
    }

    let updatedRecord: Record<string, unknown> | undefined
    if (whereParts.length > 0) {
      const qTable = quoteQualifiedTable(params.table, params.schema, 'libsql')
      const sel = await this.executeSingle(
        `SELECT * FROM ${qTable} WHERE ${whereParts.join(' AND ')}`,
        pkValues
      )
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
    })
    return { statements: batch.previewStatements }
  }

  async applyChanges(params: ApplyChangesParams): Promise<ApplyChangesResult> {
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
        beginItem?.error?.message || 'Failed to begin LibSQL transaction',
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
          item.error?.message || 'LibSQL statement execution failed',
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
        commitItem?.error?.message || 'Failed to commit LibSQL transaction',
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
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'libsql')
    }
    const targetSchema = schema?.trim()
    const masterTable =
      targetSchema && targetSchema.toLowerCase() !== 'main'
        ? `${quoteIdentForDialect(targetSchema, 'libsql')}.sqlite_master`
        : 'sqlite_master'

    const rows = await this.queryExecutor(
      `
        SELECT type, sql
        FROM ${masterTable}
        WHERE ((type IN ('table', 'view') AND name = ?) OR (type = 'index' AND tbl_name = ?))
          AND sql IS NOT NULL
        ORDER BY CASE WHEN type IN ('table', 'view') THEN 0 ELSE 1 END, name ASC;
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
      let totalAffectedRows = 0
      let lastSelect: Omit<QueryResult, 'executionTimeMs'> | null = null

      if (stmts.length <= 1) {
        const res = await this.executeSingle(trimmed, [], controller.signal)
        const parsed = parseHranaStatementResult(res, trimmed, maxRows)
        if (parsed.isSelect) {
          lastSelect = parsed.result
        } else {
          totalAffectedRows = parsed.affectedRows
        }
      } else {
        // Use Hrana v2 conditional batch so any mid-script failure halts subsequent steps
        // (preventing failed 12-step table rebuilds from executing DROP TABLE)
        const steps: HranaBatchStep[] = stmts.map((stmtSql, idx) => ({
          ...(idx > 0 ? { condition: { type: 'ok' as const, step: idx - 1 } } : {}),
          stmt: { sql: stmtSql, args: [] },
        }))
        const beginIdx = stmts.findIndex((s) => /^\s*BEGIN\b/i.test(s))
        if (beginIdx >= 0) {
          let commitIdx = -1
          for (let i = stmts.length - 1; i > beginIdx; i--) {
            if (/^\s*(?:COMMIT|END)\b/i.test(stmts[i])) {
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
            batchItem.error?.message || 'LibSQL batch execution failed',
            batchItem.error?.code || 'LIBSQL_ERROR',
            'libsql'
          )
        }
        const batchResult = batchItem.response?.result
        const stepErrors = batchResult?.step_errors || []
        for (let i = 0; i < stmts.length; i++) {
          const stepErr = stepErrors[i]
          if (stepErr) {
            throw new DatabaseDriverError(
              stepErr.message || 'LibSQL statement execution failed',
              stepErr.code || 'LIBSQL_ERROR',
              'libsql'
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
          } else {
            totalAffectedRows += parsed.affectedRows
          }
        }
      }

      const executionTimeMs = Math.round(performance.now() - start)
      return lastSelect
        ? { ...lastSelect, executionTimeMs }
        : {
            columns: [],
            rows: [],
            rowCount: 0,
            affectedRows: totalAffectedRows,
            executionTimeMs,
            truncated: false,
            isSelect: false,
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
    let session: IDatabaseSession | null = null
    try {
      session = await this.createSession(profile, authToken)
      return await session.test()
    } catch (err: unknown) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'LibSQL connection failed',
      }
    } finally {
      if (session) {
        await session.close().catch(() => {})
      }
    }
  }
}
