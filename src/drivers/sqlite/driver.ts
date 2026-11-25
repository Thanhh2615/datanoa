import { Worker } from 'node:worker_threads'
import * as fs from 'node:fs'
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
  containsDdlStatement,
  quoteIdentForDialect,
  reconstructTableDdl,
  splitSqlStatements,
} from '../common/sql-tools'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

interface ActiveQueryEntry {
  reqId: string
  reject: (err: DatabaseDriverError) => void
}

interface WorkerResponseMessage {
  id?: string
  ok: boolean
  data?: unknown
  error?: {
    message?: string
    code?: string
    failedStatementIndex?: number
    statementCount?: number
  }
  txState?: TransactionState
}

interface WorkerQueryPayload {
  isSelect: boolean
  columns: { name: string; type: string }[]
  rows: unknown[][]
  rowCount: number
  affectedRows?: number
  truncated: boolean
  resultSets?: QueryResultSet[]
}

function extractSqliteErrMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err) return err
  return fallback
}

export class SqliteSession implements IDatabaseSession {
  readonly driverType = 'sqlite' as const
  readonly profile: ConnectionProfile

  private worker: Worker | null = null
  private reqSeq = 0
  private pendingRequests = new Map<string, PendingRequest>()
  private activeQueries = new Map<string, ActiveQueryEntry>()
  private isClosed = false
  private closingPromise: Promise<void> | null = null
  private cancelPromise: Promise<{ ok: boolean }> | null = null
  private isTerminatingForCancel = false
  private serializedState?: Uint8Array
  private txChain: Promise<void> = Promise.resolve()
  private readonly tableDetailsCache = new TableDetailsCache()
  private txState: TransactionState = {
    active: false,
    autoCommit: true,
    statementCount: 0,
    supported: true,
  }

  constructor(profile: ConnectionProfile) {
    this.profile = profile
    this.spawnWorker()
  }

  isAlive(): boolean {
    return !this.isClosed && !this.closingPromise && (this.worker !== null || this.cancelPromise !== null)
  }

  private resolveWorkerPath(): URL {
    const tsUrl = new URL('./thread.ts', import.meta.url)
    const jsUrl = new URL('./thread.js', import.meta.url)
    return fs.existsSync(tsUrl) ? tsUrl : jsUrl
  }

  private spawnWorker(): Worker {
    const workerUrl = this.resolveWorkerPath()
    const currentWorker = new Worker(workerUrl)
    this.worker = currentWorker

    currentWorker.on('message', (res: WorkerResponseMessage) => {
      if (!res.id) return
      if (res.txState) {
        this.txState = res.txState
      }

      const pending = this.pendingRequests.get(res.id)
      if (pending) {
        this.pendingRequests.delete(res.id)
        if (res.ok) {
          pending.resolve(res.data)
        } else {
          const err = new DatabaseDriverError(
            res.error?.message || 'SQLite worker error',
            res.error?.code || 'SQLITE_ERROR',
            'sqlite'
          )
          if (
            typeof res.error?.failedStatementIndex === 'number' &&
            typeof res.error?.statementCount === 'number'
          ) {
            attachFailedStatementMeta(err, res.error.failedStatementIndex, res.error.statementCount)
          }
          pending.reject(err)
        }
      }
    })

    currentWorker.on('error', (err) => {
      if (this.worker !== currentWorker) return
      for (const req of this.pendingRequests.values()) {
        req.reject(new DatabaseDriverError(err.message, 'WORKER_CRASHED', 'sqlite', err))
      }
      this.pendingRequests.clear()
      this.activeQueries.clear()
    })

    currentWorker.on('exit', (code) => {
      if (this.isClosed || this.isTerminatingForCancel || this.worker !== currentWorker) {
        return
      }
      this.isClosed = true
      this.worker = null
      const err = new DatabaseDriverError(
        `SQLite worker exited unexpectedly with code ${code}`,
        'WORKER_CRASHED',
        'sqlite'
      )
      for (const req of this.pendingRequests.values()) {
        req.reject(err)
      }
      this.pendingRequests.clear()
      this.activeQueries.clear()
    })

    return currentWorker
  }

  private async sendToWorker<T = unknown>(
    type: string,
    payload: Record<string, unknown> = {},
    bypassCancelWait = false
  ): Promise<T> {
    if (!bypassCancelWait && this.cancelPromise && type !== 'close') {
      await this.cancelPromise.catch(() => {})
    }
    if (this.isClosed || (this.closingPromise && type !== 'close') || !this.worker) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'sqlite')
    }

    const activeWorker = this.worker
    const id = `req_${++this.reqSeq}`
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      })
      activeWorker.postMessage({ id, type, ...payload })
    })
  }

  private readonly queryExecutor = async (
    sql: string,
    params?: unknown[]
  ): Promise<Record<string, unknown>[]> => {
    return this.sendToWorker<Record<string, unknown>[]>('all', {
      sql,
      params: params || [],
    })
  }

  async init(bypassCancelWait = false): Promise<void> {
    await this.sendToWorker(
      'init',
      {
        filePath: this.profile.filePath,
        readOnly: this.profile.readOnly,
        serialized: this.serializedState,
      },
      bypassCancelWait
    )
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.sendToWorker('exec', { sql: 'SELECT 1;' })
      return { ok: true, message: 'SQLite connection valid' }
    } catch (err: unknown) {
      return { ok: false, message: extractSqliteErrMessage(err, 'SQLite test failed') }
    }
  }

  async close(): Promise<void> {
    this.tableDetailsCache.clear()
    if (this.isClosed) return
    if (this.closingPromise) return this.closingPromise

    this.closingPromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        if (this.worker) {
          await Promise.race([
            this.sendToWorker('close', {}, true),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 1500)
            }),
          ])
        }
      } catch {
        // Worker may already be exiting or terminated
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer)
        }
      }

      this.isClosed = true
      this.txState = {
        active: false,
        autoCommit: true,
        statementCount: 0,
        supported: true,
      }
      const workerToTerminate = this.worker
      this.worker = null
      if (workerToTerminate) {
        try {
          await workerToTerminate.terminate()
        } catch {
          // Ignore termination failure on already-exited worker
        }
      }

      if (this.pendingRequests.size > 0) {
        const closedErr = new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'sqlite')
        for (const req of this.pendingRequests.values()) {
          req.reject(closedErr)
        }
      }
      this.pendingRequests.clear()
      this.activeQueries.clear()
    })()

    return this.closingPromise
  }

  async listObjects(schema?: string): Promise<SchemaObject[]> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'sqlite')
    }
    return introspectSqliteObjects(this.queryExecutor, schema || 'main')
  }

  async listSchemas(): Promise<{ schemas: string[]; defaultSchema: string }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'sqlite')
    }
    return introspectSqliteSchemas(this.queryExecutor)
  }

  async getObjectDdl(name: string, kind: SchemaObjectKind, schema?: string): Promise<string> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'sqlite')
    }
    if (kind === 'table' || kind === 'view') {
      return this.getDdl(name, schema)
    }
    return introspectSqliteObjectDdl(this.queryExecutor, name, kind, schema || 'main')
  }

  async exportSchemaDdl(schema?: string): Promise<{ ddl: string; objectCount: number }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'sqlite')
    }
    const targetSchema = (schema || 'main').trim() || 'main'
    const objects = await this.listObjects(targetSchema)
    return collectAndAssembleSchemaDdl({
      dialect: 'sqlite',
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
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'sqlite')
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
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'sqlite')
    }
    const details = await this.getTableDetails(params.table, params.schema)

    const { sql, countSql, params: queryParams } = buildSelectPageSql({
      driver: 'sqlite',
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

    const countRow = await this.sendToWorker<Record<string, unknown>>('get', { sql: countSql })
    const rows = await this.sendToWorker<Record<string, unknown>[]>('all', {
      sql,
      params: queryParams,
    })

    return assembleTableBrowseResult({
      tableDetails: details,
      rows,
      countRow: countRow || { total: 0 },
      page: params.page,
      pageSize: params.pageSize,
    })
  }

  async updateCell(params: UpdateCellParams): Promise<UpdateCellResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'sqlite')
    }
    const originalColumnType = this.tableDetailsCache.findColumnType(
      params.schema,
      'main',
      params.table,
      params.column,
      params.columnType
    )
    const { sql, params: updateParams } = buildUpdateSql({
      driver: 'sqlite',
      table: params.table,
      schema: params.schema,
      column: params.column,
      newValue: params.newValue,
      primaryKeys: params.primaryKeys,
      originalValue: params.originalValue,
      originalColumnType,
    })

    const runRes = await this.sendToWorker<{ changes: number; txState?: TransactionState }>('run', {
      sql,
      params: updateParams,
    })

    if (runRes.txState) {
      this.txState = runRes.txState
    }

    if (runRes.changes === 0) {
      throw new DatabaseDriverError(
        'Record was modified or deleted by another session (optimistic lock conflict)',
        'conflict',
        'sqlite'
      )
    }

    // Retrieve updated record safely via primary keys (handling NULL PKs and edited PK columns)
    const reloadQuery = buildSelectByPrimaryKeySql({
      driver: 'sqlite',
      table: params.table,
      schema: params.schema,
      primaryKeys: params.primaryKeys,
      editedColumn: params.column,
      newValue: params.newValue,
    })

    let updatedRecord: Record<string, unknown> | undefined
    if (reloadQuery) {
      updatedRecord =
        (await this.sendToWorker<Record<string, unknown> | undefined>('get', {
          sql: reloadQuery.sql,
          params: reloadQuery.params,
        })) || undefined
    }

    this.tableDetailsCache.clear()

    return {
      ok: true,
      affectedRows: runRes.changes,
      updatedRecord,
    }
  }

  private runExclusiveTx<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.txChain
    let release: (() => void) | undefined
    this.txChain = new Promise<void>((resolve) => {
      release = resolve
    })
    return prev.then(fn).finally(() => {
      if (release) release()
    })
  }

  async previewChanges(params: ApplyChangesParams): Promise<PreviewChangesResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'sqlite')
    }
    const batch = buildBatchStatements({
      driver: 'sqlite',
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
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'sqlite')
    }
    const batch = buildBatchStatements({
      driver: 'sqlite',
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

    // Execute entire transaction atomically inside a single worker message turn
    // so concurrent queries/errors can never interleave or prematurely roll back the transaction
    return this.runExclusiveTx(async () => {
      const result = await this.sendToWorker<{
        inserted: number
        updated: number
        deleted: number
        txState?: TransactionState
      }>('applyBatch', {
        deletes: batch.deletes.map((s) => ({ sql: s.sql, params: s.params })),
        updates: batch.updates.map((s) => ({ sql: s.sql, params: s.params })),
        inserts: batch.inserts.map((s) => ({ sql: s.sql, params: s.params })),
      })

      if (result.txState) {
        this.txState = result.txState
      }
      this.tableDetailsCache.clear()
      return {
        ok: true,
        inserted: result.inserted,
        updated: result.updated,
        deleted: result.deleted,
        statements: batch.previewStatements,
      }
    })
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
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'sqlite')
    }
    const targetSchema = schema?.trim()
    const masterTable =
      targetSchema && targetSchema.toLowerCase() !== 'main'
        ? `${quoteIdentForDialect(targetSchema, 'sqlite')}.sqlite_master`
        : 'sqlite_master'
    const attachedTypes = includeTriggers ? "'index', 'trigger'" : "'index'"

    const rows = await this.sendToWorker<Array<{ type: string; sql: string | null }>>('all', {
      sql: `
        SELECT type, sql
        FROM ${masterTable}
        WHERE ((type IN ('table', 'view') AND name = ?) OR (type IN (${attachedTypes}) AND tbl_name = ?))
          AND sql IS NOT NULL
        ORDER BY CASE WHEN type IN ('table', 'view') THEN 0 WHEN type = 'index' THEN 1 ELSE 2 END, name ASC;
      `,
      params: [table, table],
    })

    const hasMainDef = rows.some(
      (r) => (r.type === 'table' || r.type === 'view') && typeof r.sql === 'string' && r.sql.trim()
    )
    if (hasMainDef) {
      return rows
        .map((r) => (r.sql || '').trim())
        .filter((s) => s.length > 0)
        .map((s) => (s.endsWith(';') ? s : `${s};`))
        .join('\n\n')
    }

    const details = await this.getTableDetails(table, schema)
    return reconstructTableDdl(details, 'sqlite')
  }

  async runQuery(queryId: string, sql: string, maxRows = 1000): Promise<QueryResult> {
    if (this.cancelPromise) {
      await this.cancelPromise.catch(() => {})
    }
    if (this.isClosed || this.closingPromise || !this.worker) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'sqlite')
    }

    const activeWorker = this.worker
    const start = performance.now()
    const reqId = `req_${++this.reqSeq}`
    const statements = splitSqlStatements(sql, 'sqlite').map((s) => s.text)
    const isDdl = containsDdlStatement(sql, 'sqlite')

    const queryPromise = new Promise<QueryResult>((resolve, reject) => {
      this.pendingRequests.set(reqId, {
        resolve: (rawData) => {
          const data = rawData as WorkerQueryPayload & { txState?: TransactionState }
          if (data.txState) {
            this.txState = data.txState
          }
          this.activeQueries.delete(queryId)
          if (isDdl) {
            this.tableDetailsCache.clear()
          }
          const payload: WorkerQueryPayload = {
            isSelect: data.isSelect,
            columns: data.columns,
            rows: data.rows,
            rowCount: data.rowCount,
            affectedRows: data.affectedRows,
            truncated: data.truncated,
            ...(data.resultSets ? { resultSets: data.resultSets } : {}),
          }
          resolve({
            ...payload,
            executionTimeMs: Math.round(performance.now() - start),
          })
        },
        reject: (err) => {
          this.activeQueries.delete(queryId)
          if (isDdl) {
            this.tableDetailsCache.clear()
          }
          reject(err)
        },
      })

      this.activeQueries.set(queryId, { reqId, reject })
      activeWorker.postMessage({ id: reqId, type: 'query', sql, statements, maxRows })
    })

    return queryPromise
  }

  async cancelQuery(queryId: string): Promise<{ ok: boolean }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'sqlite')
    }
    if (this.cancelPromise) {
      await this.cancelPromise.catch(() => {})
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'sqlite')
      }
    }

    const active = this.activeQueries.get(queryId)
    if (!active) {
      return { ok: true } // Idempotent cancellation
    }

    const runCancel = async (): Promise<{ ok: boolean }> => {
      // 1. Reject active query with 'cancelled' code
      this.pendingRequests.delete(active.reqId)
      active.reject(
        new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'sqlite')
      )
      this.activeQueries.delete(queryId)

      // 2. Terminate the blocked worker thread without triggering crash handler
      const oldWorker = this.worker
      this.worker = null
      this.isTerminatingForCancel = true
      try {
        if (oldWorker) {
          await oldWorker.terminate()
        }
      } catch {
        // Ignore already-exited worker
      } finally {
        this.isTerminatingForCancel = false
      }

      // 3. Reject any other pending requests on the terminated worker
      for (const req of this.pendingRequests.values()) {
        req.reject(new DatabaseDriverError('Query cancelled', 'cancelled', 'sqlite'))
      }
      this.pendingRequests.clear()
      this.activeQueries.clear()

      // 4. Respawn and reinitialize fresh worker thread unless closing/closed
      if (this.isClosed || this.closingPromise) {
        return { ok: true }
      }
      this.txState = {
        active: false,
        autoCommit: true,
        statementCount: 0,
        supported: true,
      }
      let spawnedWorker: Worker | null = null
      try {
        spawnedWorker = this.spawnWorker()
        await this.init(true)
      } catch (respawnErr) {
        this.isClosed = true
        this.worker = null
        if (spawnedWorker) {
          await spawnedWorker.terminate().catch(() => {})
        }
        throw respawnErr
      }

      return { ok: true }
    }

    const op = runCancel()
    this.cancelPromise = op
    try {
      return await op
    } finally {
      if (this.cancelPromise === op) {
        this.cancelPromise = null
      }
    }
  }

  getTransactionState(): TransactionState {
    return { ...this.txState }
  }

  async beginTransaction(): Promise<TransactionState> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'sqlite')
    }
    const state = await this.sendToWorker<TransactionState>('txBegin')
    this.txState = state
    return { ...this.txState }
  }

  async commitTransaction(): Promise<TransactionState> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'sqlite')
    }
    const state = await this.sendToWorker<TransactionState>('txCommit')
    this.txState = state
    return { ...this.txState }
  }

  async rollbackTransaction(): Promise<TransactionState> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'sqlite')
    }
    const state = await this.sendToWorker<TransactionState>('txRollback')
    this.txState = state
    return { ...this.txState }
  }

  async setAutoCommit(enabled: boolean): Promise<TransactionState> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'sqlite')
    }
    const state = await this.sendToWorker<TransactionState>('txSetAutoCommit', { enabled })
    this.txState = state
    return { ...this.txState }
  }
}

export class SqliteDriver implements IDatabaseDriver {
  readonly type = 'sqlite' as const

  async createSession(profile: ConnectionProfile, _secret?: string): Promise<IDatabaseSession> {
    const session = new SqliteSession(profile)
    try {
      await session.init()
      return session
    } catch (err) {
      await session.close().catch(() => {})
      throw err
    }
  }

  async testConnection(
    profile: ConnectionProfile,
    _secret?: string
  ): Promise<{ ok: boolean; message?: string }> {
    return runDriverConnectionTest(
      () => this.createSession(profile),
      (err) => extractSqliteErrMessage(err, 'Connection failed')
    )
  }
}
