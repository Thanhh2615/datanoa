// src/drivers/d1/driver.ts
// Cloudflare D1 pure-TS HTTP driver (native fetch, zero vendor bytes).
// Reuses the SQLite schema/SQL helpers because D1 is SQLite-compatible.

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
  buildCombinedAbortSignal,
  createUnsupportedTransactionError,
  createUnsupportedTransactionState,
  runDriverConnectionTest,
} from '../common/driver'
import { validateD1EndpointUrl } from '../common/connection-uri'
import {
  assembleTableBrowseResult,
  buildBatchStatements,
  buildSelectByPrimaryKeySql,
  buildSelectPageSql,
  buildUpdateSql,
  quoteQualifiedTable,
} from '../common/update-builder'
import {
  TableDetailsCache,
  collectAndAssembleSchemaDdl,
  introspectSqliteObjectDdl,
  introspectSqliteObjects,
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

const D1_HTTP_TIMEOUT_MS = 30_000
const D1_UNSUPPORTED_TX_REASON =
  'Cloudflare D1 HTTP API executes stateless requests without interactive multi-statement transactions'
const D1_DEFAULT_API_ORIGIN = 'https://api.cloudflare.com/client/v4'
const D1_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/
const D1_MAX_PARAMS_PER_STATEMENT = 100
const D1_MAX_SQL_BYTES = 100 * 1024
const D1_SAFE_SQL_BYTES = 90_000
const D1_SAFE_BATCH_PAYLOAD_BYTES = 512 * 1024
const D1_GUARD_SENTINEL = 'datanoa_optimistic_conflict'
const D1_GUARD_SQL = `SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('{}','${D1_GUARD_SENTINEL}') END AS guard_ok`

interface D1QueryResultPayload {
  success?: boolean
  results?: Record<string, unknown>[]
  meta?: { changes?: number }
}

interface ActiveD1Query {
  controller: AbortController
  cancelled: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function protocolError(message: string): DatabaseDriverError {
  return new DatabaseDriverError(message, 'D1_ERROR', 'd1')
}

function errorMessages(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw protocolError('Cloudflare D1 returned a malformed errors payload')
  }
  const messages: string[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    if (typeof item.message === 'string' && item.message.length > 0) messages.push(item.message)
  }
  return messages
}

function parseD1Envelope(rawText: string): {
  success?: boolean
  errors: string[]
  result?: unknown
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    throw protocolError('Cloudflare D1 returned an unreadable JSON payload')
  }
  if (!isRecord(parsed)) {
    throw protocolError('Cloudflare D1 returned a non-object JSON payload')
  }
  if (parsed.success !== undefined && typeof parsed.success !== 'boolean') {
    throw protocolError('Cloudflare D1 returned a non-boolean success flag')
  }
  return { success: parsed.success, errors: errorMessages(parsed.errors), result: parsed.result }
}

function validateMutationResultPayload(value: unknown): D1QueryResultPayload {
  if (!isRecord(value)) {
    throw protocolError('Cloudflare D1 returned a malformed mutation result')
  }
  if (value.success !== undefined) {
    if (typeof value.success !== 'boolean') {
      throw protocolError('Cloudflare D1 returned a non-boolean statement success flag')
    }
    if (value.success === false) {
      throw protocolError('Cloudflare D1 reported a failed statement inside the batch')
    }
  }
  if (value.meta !== undefined) {
    if (!isRecord(value.meta)) {
      throw protocolError('Cloudflare D1 returned a malformed statement metadata payload')
    }
    if ('changes' in value.meta) {
      const changes = value.meta.changes
      if (
        typeof changes !== 'number' ||
        !Number.isFinite(changes) ||
        !Number.isInteger(changes) ||
        changes < 0
      ) {
        throw protocolError('Cloudflare D1 returned an invalid statement change count')
      }
    }
  }
  if (value.results !== undefined && !Array.isArray(value.results)) {
    throw protocolError('Cloudflare D1 returned a malformed statement results payload')
  }
  return value as D1QueryResultPayload
}

function isGuardConflictDetail(detail: string, sentinel: string): boolean {
  if (!detail.includes(`'${sentinel}'`)) return false
  return /bad\s+json\s+path|json\s+path\s+error/i.test(detail)
}

function normalizeD1Param(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') {
    const num = Number(value)
    return Number.isSafeInteger(num) ? num : value.toString()
  }
  if (typeof value === 'string') return value
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString('base64')
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, (_key, nested) =>
      typeof nested === 'bigint' ? nested.toString() : nested
    )
  }
  return String(value)
}

function columnTypeFor(value: unknown): string {
  if (value === null || value === undefined) return 'TEXT'
  if (typeof value === 'number') return Number.isInteger(value) ? 'INTEGER' : 'REAL'
  if (typeof value === 'boolean') return 'INTEGER'
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return 'BLOB'
  return 'TEXT'
}

/** Builds stable column metadata from D1's object-shaped result rows. */
function columnsFromRows(rows: Record<string, unknown>[]): { name: string; type: string }[] {
  const first = rows[0]
  if (!first) return []
  return Object.keys(first).map((name) => ({ name, type: columnTypeFor(first[name]) }))
}

function resolveD1Endpoint(profile: ConnectionProfile, authToken?: string): string {
  const custom = (profile.url || '').trim()
  if (custom) {
    const validated = validateD1EndpointUrl(custom, {
      hasAuthToken: Boolean(authToken && authToken.trim().length > 0),
    })
    if (!validated.ok) {
      throw new DatabaseDriverError(validated.error, 'INVALID_ENDPOINT', 'd1')
    }
    return validated.url
  }
  const accountId = (profile.d1AccountId || '').trim()
  const databaseId = (profile.d1DatabaseId || '').trim()
  if (!accountId || !databaseId) {
    throw new DatabaseDriverError(
      'Cloudflare D1 requires an Account ID and Database ID',
      'invalid_params',
      'd1'
    )
  }
  if (!D1_ID_RE.test(accountId) || !D1_ID_RE.test(databaseId)) {
    throw new DatabaseDriverError(
      'Cloudflare D1 Account ID and Database ID may only contain letters, digits, "-" and "_"',
      'invalid_params',
      'd1'
    )
  }
  return `${D1_DEFAULT_API_ORIGIN}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`
}

export class D1Session implements IDatabaseSession {
  readonly driverType = 'd1' as const
  readonly profile: ConnectionProfile
  readonly endpoint: string
  private readonly authToken?: string
  private readonly activeQueries = new Map<string, ActiveD1Query>()
  private readonly tableDetailsCache = new TableDetailsCache()
  private isClosed = false

  constructor(profile: ConnectionProfile, authToken?: string) {
    this.profile = profile
    this.authToken = authToken
    this.endpoint = resolveD1Endpoint(profile, authToken)
  }

  isAlive(): boolean {
    return !this.isClosed
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.authToken && this.authToken.trim().length > 0) {
      headers['Authorization'] = `Bearer ${this.authToken.trim()}`
    }
    return headers
  }

  private async execute(
    sql: string,
    params: unknown[] = [],
    signal?: AbortSignal,
    options?: { mutation?: boolean }
  ): Promise<D1QueryResultPayload> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'd1')
    }

    let rawText: string
    let responseOk: boolean
    let responseStatus: number
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ sql, params: params.map(normalizeD1Param) }),
        signal: buildCombinedAbortSignal(D1_HTTP_TIMEOUT_MS, signal),
        redirect: 'error',
      })
      responseOk = response.ok
      responseStatus = response.status
      rawText = await response.text()
    } catch (err: unknown) {
      if (err instanceof DatabaseDriverError) throw err
      const errName = (err as { name?: string })?.name
      if (signal?.aborted) {
        throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'd1', err)
      }
      if (errName === 'TimeoutError' || errName === 'AbortError') {
        throw new DatabaseDriverError(
          `Cloudflare D1 HTTP request timed out after ${D1_HTTP_TIMEOUT_MS}ms`,
          'TIMEOUT',
          'd1',
          err
        )
      }
      throw new DatabaseDriverError(
        err instanceof Error ? err.message : 'Cloudflare D1 HTTP request failed',
        'CONNECTION_FAILED',
        'd1',
        err
      )
    }

    const envelope = parseD1Envelope(rawText)
    const detail = envelope.errors.join('; ')
    if (!responseOk) {
      throw new DatabaseDriverError(
        detail || rawText.trim().slice(0, 400) || `Cloudflare D1 HTTP error ${responseStatus}`,
        'D1_ERROR',
        'd1'
      )
    }
    if (envelope.success === false) {
      throw new DatabaseDriverError(detail || 'Cloudflare D1 query failed', 'D1_ERROR', 'd1')
    }
    if (options?.mutation) {
      if (!Array.isArray(envelope.result)) {
        throw protocolError('Cloudflare D1 returned a malformed mutation result')
      }
      if (envelope.result.length !== 1) {
        throw protocolError('Cloudflare D1 returned an unexpected number of mutation results')
      }
      return validateMutationResultPayload(envelope.result[0])
    }
    const first = Array.isArray(envelope.result) ? envelope.result[0] : undefined
    return isRecord(first) ? (first as D1QueryResultPayload) : {}
  }

  private readonly queryExecutor = async (
    sql: string,
    params?: unknown[]
  ): Promise<Record<string, unknown>[]> => {
    const res = await this.execute(sql, params || [])
    return res.results || []
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    if (this.isClosed) return { ok: false, message: 'Session is closed' }
    try {
      await this.execute('SELECT 1;')
      return { ok: true, message: 'Cloudflare D1 connection valid' }
    } catch (err: unknown) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to connect to Cloudflare D1',
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
    return introspectSqliteObjects(this.queryExecutor, (schema || 'main').trim() || 'main')
  }

  async listSchemas(): Promise<{ schemas: string[]; defaultSchema: string }> {
    return { schemas: ['main'], defaultSchema: 'main' }
  }

  async getObjectDdl(name: string, kind: SchemaObjectKind, schema?: string): Promise<string> {
    if (kind === 'table' || kind === 'view') return this.getDdl(name, schema)
    return introspectSqliteObjectDdl(this.queryExecutor, name, kind, schema || 'main')
  }

  async exportSchemaDdl(schema?: string): Promise<{ ddl: string; objectCount: number }> {
    const targetSchema = (schema || 'main').trim() || 'main'
    const objects = await this.listObjects(targetSchema)
    return collectAndAssembleSchemaDdl({
      dialect: 'd1',
      schemaName: targetSchema,
      objects,
      getObjectDdl: (object) => this.getObjectDdl(object.name, object.kind, targetSchema),
    })
  }

  async getTableDetails(table: string, schema?: string): Promise<TableDetails> {
    const targetSchema = schema || 'main'
    const cached = this.tableDetailsCache.get(targetSchema, 'main', table)
    if (cached) return cached
    const details = await introspectSqliteTableDetails(this.queryExecutor, table, targetSchema)
    this.tableDetailsCache.set(targetSchema, 'main', table, details)
    return details
  }

  async fetchPage(params: FetchPageParams): Promise<TableBrowseResult> {
    const details = await this.getTableDetails(params.table, params.schema)
    const built = buildSelectPageSql({
      driver: 'd1',
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
    const countRows = await this.queryExecutor(built.countSql)
    const dataRows = await this.queryExecutor(built.sql, built.params)
    return assembleTableBrowseResult({
      tableDetails: details,
      rows: dataRows,
      countRow: countRows[0] || { total: 0 },
      page: params.page,
      pageSize: params.pageSize,
    })
  }

  async updateCell(params: UpdateCellParams): Promise<UpdateCellResult> {
    if (this.profile.readOnly) {
      throw new DatabaseDriverError('Connection is configured as read-only', 'READ_ONLY', 'd1')
    }
    const originalColumnType = this.tableDetailsCache.findColumnType(
      params.schema,
      'main',
      params.table,
      params.column,
      params.columnType
    )
    const built = buildUpdateSql({
      driver: 'd1',
      table: params.table,
      schema: params.schema,
      column: params.column,
      newValue: params.newValue,
      primaryKeys: params.primaryKeys,
      originalValue: params.originalValue,
      originalColumnType,
    })
    const res = await this.execute(built.sql, built.params)
    const affectedRows = Number(res.meta?.changes ?? 0)
    if (affectedRows === 0) {
      throw new DatabaseDriverError(
        'Record was modified or deleted by another session (optimistic lock conflict)',
        'conflict',
        'd1'
      )
    }
    this.tableDetailsCache.clear()

    const reloadQuery = buildSelectByPrimaryKeySql({
      driver: 'd1',
      table: params.table,
      schema: params.schema,
      primaryKeys: params.primaryKeys,
      editedColumn: params.column,
      newValue: params.newValue,
    })
    let updatedRecord: Record<string, unknown> | undefined
    if (reloadQuery) {
      const rows = await this.queryExecutor(reloadQuery.sql, reloadQuery.params)
      updatedRecord = rows[0]
    }
    return { ok: true, affectedRows, updatedRecord }
  }

  async previewChanges(params: ApplyChangesParams): Promise<PreviewChangesResult> {
    const batch = buildBatchStatements({
      driver: 'd1',
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

  private async executeBatch(
    queries: Array<{ sql: string; params: unknown[] }>,
    signal?: AbortSignal,
    options?: { conflictSentinel?: string }
  ): Promise<D1QueryResultPayload[]> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'd1')
    }
    if (queries.length === 0) return []
    for (const query of queries) {
      if (query.params.length > D1_MAX_PARAMS_PER_STATEMENT) {
        throw new DatabaseDriverError(
          `Cloudflare D1 allows at most ${D1_MAX_PARAMS_PER_STATEMENT} bound parameters per statement; this statement needs ${query.params.length}`,
          'D1_ERROR',
          'd1'
        )
      }
      if (Buffer.byteLength(query.sql, 'utf8') > D1_MAX_SQL_BYTES) {
        throw new DatabaseDriverError(
          `Cloudflare D1 allows at most ${D1_MAX_SQL_BYTES} bytes per SQL statement`,
          'D1_ERROR',
          'd1'
        )
      }
    }
    if (queries.length === 1) {
      return [await this.execute(queries[0].sql, queries[0].params, signal, { mutation: true })]
    }

    let rawText: string
    let responseOk: boolean
    let responseStatus: number
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          batch: queries.map((q) => ({ sql: q.sql, params: q.params.map(normalizeD1Param) })),
        }),
        signal: buildCombinedAbortSignal(D1_HTTP_TIMEOUT_MS, signal),
        redirect: 'error',
      })
      responseOk = response.ok
      responseStatus = response.status
      rawText = await response.text()
    } catch (err: unknown) {
      if (err instanceof DatabaseDriverError) throw err
      const errName = (err as { name?: string })?.name
      if (signal?.aborted) {
        throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'd1', err)
      }
      if (errName === 'TimeoutError' || errName === 'AbortError') {
        throw new DatabaseDriverError(
          `Cloudflare D1 HTTP request timed out after ${D1_HTTP_TIMEOUT_MS}ms`,
          'TIMEOUT',
          'd1',
          err
        )
      }
      throw new DatabaseDriverError(
        err instanceof Error ? err.message : 'Cloudflare D1 HTTP request failed',
        'CONNECTION_FAILED',
        'd1',
        err
      )
    }

    const envelope = parseD1Envelope(rawText)
    const detail = envelope.errors.join('; ')

    if (!responseOk) {
      throw this.toBatchError(
        detail || rawText.trim().slice(0, 400) || `Cloudflare D1 HTTP error ${responseStatus}`,
        options?.conflictSentinel
      )
    }
    if (envelope.success === false) {
      throw this.toBatchError(
        detail || 'Cloudflare D1 rejected the batch query',
        options?.conflictSentinel
      )
    }
    if (!Array.isArray(envelope.result)) {
      throw protocolError('Cloudflare D1 returned a malformed batch result')
    }
    return envelope.result.map((item) => validateMutationResultPayload(item))
  }

  private toBatchError(detail: string, conflictSentinel?: string): DatabaseDriverError {
    if (conflictSentinel && isGuardConflictDetail(detail, conflictSentinel)) {
      return new DatabaseDriverError(
        'Record was modified or deleted by another session (optimistic lock conflict)',
        'conflict',
        'd1'
      )
    }
    return new DatabaseDriverError(detail, 'D1_ERROR', 'd1')
  }

  async applyChanges(params: ApplyChangesParams): Promise<ApplyChangesResult> {
    if (this.profile.readOnly) {
      throw new DatabaseDriverError('Connection is configured as read-only', 'READ_ONLY', 'd1')
    }
    const batch = buildBatchStatements({
      driver: 'd1',
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

    const qTable = quoteQualifiedTable(params.table, params.schema, 'd1')
    const insertStatements: Array<{ sql: string; params: unknown[]; rowCount: number }> = []
    const rawInserts = params.inserts || []
    let insertCursor = 0
    while (insertCursor < rawInserts.length) {
      const firstRow = rawInserts[insertCursor]
      const cols = Object.entries(firstRow || {})
        .filter(([, val]) => val !== undefined)
        .map(([col]) => col)
      if (cols.length === 0) {
        insertStatements.push({ sql: `INSERT INTO ${qTable} DEFAULT VALUES;`, params: [], rowCount: 1 })
        insertCursor += 1
        continue
      }
      const colSig = cols.join('\0')
      const maxRowsPerStmt = Math.max(1, Math.floor(D1_MAX_PARAMS_PER_STATEMENT / cols.length))
      const quotedCols = cols.map((c) => quoteIdentForDialect(c, 'd1')).join(', ')
      const rowPlaceholder = `(${cols.map(() => '?').join(', ')})`
      const prefixBytes = Buffer.byteLength(`INSERT INTO ${qTable} (${quotedCols}) VALUES ;`, 'utf8')
      const perRowSqlBytes = Buffer.byteLength(rowPlaceholder, 'utf8') + 2
      const estimateRowParamBytes = (row: Record<string, unknown>): number => {
        let total = 0
        for (const col of cols) {
          const serialized = JSON.stringify(normalizeD1Param(row[col]))
          total += serialized ? Buffer.byteLength(serialized, 'utf8') + 1 : 4
        }
        return total
      }

      const chunkRows: Record<string, unknown>[] = [firstRow]
      let runningSqlBytes = prefixBytes + perRowSqlBytes
      let runningPayloadBytes = estimateRowParamBytes(firstRow)
      let nextIdx = insertCursor + 1
      while (nextIdx < rawInserts.length && chunkRows.length < maxRowsPerStmt) {
        const candidate = rawInserts[nextIdx]
        const candidateCols = Object.entries(candidate || {})
          .filter(([, val]) => val !== undefined)
          .map(([col]) => col)
        if (candidateCols.join('\0') !== colSig) break
        const candidateParamBytes = estimateRowParamBytes(candidate)
        if (
          runningSqlBytes + perRowSqlBytes > D1_SAFE_SQL_BYTES ||
          runningPayloadBytes + candidateParamBytes > D1_SAFE_BATCH_PAYLOAD_BYTES
        ) {
          break
        }
        chunkRows.push(candidate)
        runningSqlBytes += perRowSqlBytes
        runningPayloadBytes += candidateParamBytes
        nextIdx += 1
      }
      const valuesSql = chunkRows.map(() => rowPlaceholder).join(', ')
      const boundParams: unknown[] = []
      for (const row of chunkRows) {
        for (const col of cols) boundParams.push(row[col])
      }
      insertStatements.push({
        sql: `INSERT INTO ${qTable} (${quotedCols}) VALUES ${valuesSql};`,
        params: boundParams,
        rowCount: chunkRows.length,
      })
      insertCursor = nextIdx
    }

    const planned: Array<{
      kind: 'delete' | 'update' | 'insert'
      sql: string
      params: unknown[]
      expectedRows: number
    }> = [
      ...batch.deletes.map((s) => ({ kind: 'delete' as const, sql: s.sql, params: s.params, expectedRows: 1 })),
      ...batch.updates.map((s) => ({ kind: 'update' as const, sql: s.sql, params: s.params, expectedRows: 1 })),
      ...insertStatements.map((s) => ({
        kind: 'insert' as const,
        sql: s.sql,
        params: s.params,
        expectedRows: s.rowCount,
      })),
    ]

    const queries: Array<{ sql: string; params: unknown[] }> = []
    const layout: Array<{
      kind: 'delete' | 'update' | 'insert'
      queryIndex: number
      guardIndex?: number
      expectedRows: number
    }> = []
    for (const item of planned) {
      const queryIndex = queries.length
      queries.push({ sql: item.sql, params: item.params })
      let guardIndex: number | undefined
      if (item.kind === 'delete' || item.kind === 'update') {
        guardIndex = queries.length
        queries.push({ sql: D1_GUARD_SQL, params: [] })
      }
      layout.push({ kind: item.kind, queryIndex, guardIndex, expectedRows: item.expectedRows })
    }

    const guarded = layout.some((item) => item.guardIndex !== undefined)
    const payloads = await this.executeBatch(
      queries,
      undefined,
      guarded ? { conflictSentinel: D1_GUARD_SENTINEL } : undefined
    )
    this.tableDetailsCache.clear()

    if (payloads.length !== queries.length) {
      throw new DatabaseDriverError(
        'Cloudflare D1 returned an unexpected number of batch results',
        'D1_ERROR',
        'd1'
      )
    }
    for (const payload of payloads) {
      if (payload && payload.success === false) {
        throw new DatabaseDriverError(
          'Cloudflare D1 reported a failed statement inside the batch',
          'D1_ERROR',
          'd1'
        )
      }
    }

    let deleted = 0
    let updated = 0
    let inserted = 0
    for (const item of layout) {
      if (item.kind === 'insert') {
        const changes = payloads[item.queryIndex]?.meta?.changes
        inserted += typeof changes === 'number' ? changes : item.expectedRows
        continue
      }
      const guardIndex = item.guardIndex
      if (typeof guardIndex !== 'number') {
        throw new DatabaseDriverError(
          'Cloudflare D1 did not confirm the optimistic lock guard for a guarded statement',
          'D1_ERROR',
          'd1'
        )
      }
      const guardRows = payloads[guardIndex]?.results
      const guardRow = Array.isArray(guardRows) && guardRows.length === 1 ? guardRows[0] : undefined
      if (!isRecord(guardRow) || guardRow.guard_ok !== 1) {
        throw new DatabaseDriverError(
          'Cloudflare D1 did not confirm the optimistic lock guard for a guarded statement',
          'D1_ERROR',
          'd1'
        )
      }
      if (item.kind === 'delete') deleted += 1
      else updated += 1
    }

    return { ok: true, inserted, updated, deleted, statements: batch.previewStatements }
  }

  async getDdl(table: string, schema?: string): Promise<string> {
    const targetSchema = schema?.trim()
    const masterTable =
      targetSchema && targetSchema.toLowerCase() !== 'main'
        ? `${quoteIdentForDialect(targetSchema, 'd1')}.sqlite_master`
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
    const defs = rows
      .map((r) => (typeof r.sql === 'string' ? r.sql.trim() : ''))
      .filter((s) => s.length > 0)
    if (defs.length > 0) {
      return defs.map((s) => (s.endsWith(';') ? s : `${s};`)).join('\n\n')
    }
    const details = await this.getTableDetails(table, schema)
    return reconstructTableDdl(details, 'd1')
  }

  async runQuery(queryId: string, sql: string, maxRows = 1000): Promise<QueryResult> {
    const trimmed = sql.trim()
    if (!trimmed) {
      throw new DatabaseDriverError('SQL statement cannot be empty', 'invalid_params', 'd1')
    }
    const controller = new AbortController()
    const active: ActiveD1Query = { controller, cancelled: false }
    this.activeQueries.set(queryId, active)
    const start = performance.now()
    try {
      const statements = splitSqlStatements(trimmed, 'd1').map((s) => s.text)
      if (
        this.profile.readOnly &&
        (isMutatingStatement(trimmed, 'd1') || statements.some((s) => isMutatingStatement(s, 'd1')))
      ) {
        throw new DatabaseDriverError('Connection is configured as read-only', 'READ_ONLY', 'd1')
      }
      const sets: QueryResultSet[] = []
      let lastSelect: Omit<QueryResult, 'executionTimeMs'> | null = null
      let totalAffected = 0

      for (let index = 0; index < statements.length; index++) {
        const statement = statements[index]
        const res = await this.execute(statement, [], controller.signal)
        const rows = res.results || []
        const columns = columnsFromRows(rows)
        const affected = Number(res.meta?.changes ?? 0)
        const stripped = statement.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '').trim()
        const isSelect =
          columns.length > 0 ||
          (/^PRAGMA\b/i.test(stripped) && !stripped.includes('=') && !isMutatingStatement(statement, 'd1')) ||
          ((/^WITH\b/i.test(stripped) || /^(?:SELECT|EXPLAIN)\b/i.test(stripped)) &&
            !isMutatingStatement(statement, 'd1'))

        if (isSelect) {
          const limited = maxRows > 0 ? rows.slice(0, maxRows) : rows
          const result = {
            columns,
            rows: limited.map((row) => columns.map((col) => row[col.name] ?? null)),
            rowCount: limited.length,
            truncated: rows.length > limited.length,
            isSelect: true,
          }
          lastSelect = result
          sets.push({
            index,
            sqlPreview: compactSql(statement),
            columns,
            rows: result.rows,
            rowCount: result.rowCount,
            truncated: result.truncated,
            isSelect: true,
          })
        } else {
          totalAffected += affected
          sets.push({
            index,
            sqlPreview: compactSql(statement),
            columns: [{ name: 'affected_rows', type: 'INTEGER' }],
            rows: [[affected]],
            rowCount: 1,
            affectedRows: affected,
            truncated: false,
            isSelect: false,
          })
        }
      }

      const executionTimeMs = Math.round(performance.now() - start)
      if (lastSelect) {
        return {
          ...lastSelect,
          affectedRows: totalAffected,
          ...(sets.length > 1 ? { resultSets: sets } : {}),
          executionTimeMs,
        }
      }
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: totalAffected,
        executionTimeMs,
        truncated: false,
        isSelect: false,
        ...(sets.length > 1 ? { resultSets: sets } : {}),
      }
    } catch (err) {
      if (active.cancelled && !(err instanceof DatabaseDriverError && err.code === 'cancelled')) {
        throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'd1', err)
      }
      throw err
    } finally {
      if (containsDdlStatement(sql, 'd1')) this.tableDetailsCache.clear()
      if (this.activeQueries.get(queryId) === active) this.activeQueries.delete(queryId)
    }
  }

  async cancelQuery(queryId: string): Promise<{ ok: boolean }> {
    const active = this.activeQueries.get(queryId)
    if (!active) return { ok: true }
    active.cancelled = true
    active.controller.abort()
    return { ok: true }
  }

  getTransactionState(): TransactionState {
    return createUnsupportedTransactionState(D1_UNSUPPORTED_TX_REASON)
  }

  async beginTransaction(): Promise<TransactionState> {
    throw createUnsupportedTransactionError('d1', D1_UNSUPPORTED_TX_REASON)
  }

  async commitTransaction(): Promise<TransactionState> {
    throw createUnsupportedTransactionError('d1', D1_UNSUPPORTED_TX_REASON)
  }

  async rollbackTransaction(): Promise<TransactionState> {
    throw createUnsupportedTransactionError('d1', D1_UNSUPPORTED_TX_REASON)
  }

  async setAutoCommit(enabled: boolean): Promise<TransactionState> {
    if (!enabled) throw createUnsupportedTransactionError('d1', D1_UNSUPPORTED_TX_REASON)
    return this.getTransactionState()
  }
}

export class D1Driver implements IDatabaseDriver {
  readonly type = 'd1' as const

  async createSession(profile: ConnectionProfile, authToken?: string): Promise<IDatabaseSession> {
    return new D1Session(profile, authToken)
  }

  async testConnection(
    profile: ConnectionProfile,
    authToken?: string
  ): Promise<{ ok: boolean; message?: string }> {
    return runDriverConnectionTest(
      () => this.createSession(profile, authToken),
      (err) => (err instanceof Error ? err.message : 'Cloudflare D1 connection failed')
    )
  }
}
