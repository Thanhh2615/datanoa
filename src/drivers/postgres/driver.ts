import * as dns from 'node:dns'
import type { Pool, PoolConfig, PoolClient } from '../../../vendor/pg.js'
import {
  isCloudDatabaseHost,
  isSupabaseDirectHost,
  isSupabaseHost,
} from '../common/connection-uri'
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
import { DatabaseDriverError, runDriverConnectionTest } from '../common/driver'
import type { DriverTlsOptions } from '../common/tls-and-tunnel'
import { buildDefaultTlsOptions, resolveEffectiveTlsOptions } from '../common/tls-and-tunnel'
import {
  assembleTableBrowseResult,
  buildBatchStatements,
  buildSelectPageSql,
  buildUpdateSql,
} from '../common/update-builder'
import {
  TableDetailsCache,
  collectAndAssembleSchemaDdl,
  introspectPostgresObjectDdl,
  introspectPostgresObjects,
  introspectPostgresSchemaDependencies,
  introspectPostgresSchemas,
  introspectPostgresTableDetails,
} from '../common/schema'
import type { SchemaDependencyEdge } from '../common/schema'
import {
  containsDdlStatement,
  reconstructTableDdl,
  splitSqlStatements,
} from '../common/sql-tools'
import {
  SQL_STANDALONE_ROLLBACK_RE,
  compactSql,
  stripLeadingSqlComments,
} from '../common/sql-lexer'

type PgVendorModule = typeof import('../../../vendor/pg.js')
let pgVendorPromise: Promise<PgVendorModule> | null = null
let pgTypeParsersRegistered = false

async function loadPgVendor(): Promise<PgVendorModule> {
  if (!pgVendorPromise) {
    pgVendorPromise = import('../../../vendor/pg.js')
      .then((mod) => {
        // Preserve DATE/TIME/TIMESTAMP/INTERVAL as canonical text without JS Date TZ distortion or microsecond truncation
        if (!pgTypeParsersRegistered && mod.types && typeof mod.types.setTypeParser === 'function') {
          pgTypeParsersRegistered = true
          const preserveText = (val: string): string => val
          for (const oid of [1082, 1083, 1266, 1114, 1184, 1186]) {
            mod.types.setTypeParser(oid, preserveText)
          }
        }
        return mod
      })
      .catch((err: unknown) => {
        pgVendorPromise = null
        throw err
      })
  }
  return pgVendorPromise
}

const PG_OID_TYPE_NAMES: Readonly<Record<number, string>> = {
  16: 'bool',
  17: 'bytea',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  26: 'oid',
  114: 'json',
  142: 'xml',
  700: 'float4',
  701: 'float8',
  790: 'money',
  869: 'inet',
  1000: '_bool',
  1005: '_int2',
  1007: '_int4',
  1009: '_text',
  1016: '_int8',
  1042: 'bpchar',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1266: 'timetz',
  1560: 'bit',
  1562: 'varbit',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
  3904: 'int4range',
  3910: 'tstzrange',
  3912: 'daterange',
}

interface PgLease {
  readonly client: PoolClient
  readonly pid: number
  released: boolean
  release(destroy?: boolean): void
}

interface ActivePgQuery {
  lease: PgLease
  startTime: number
  cancelled: boolean
}

interface ActiveBatch {
  lease: PgLease
  commitSent: boolean
}

interface PgRawResult {
  command?: string
  fields?: Array<{ name: string; dataTypeID: number; tableID?: number }>
  rows?: Array<unknown[] | Record<string, unknown>>
  rowCount?: number | null
}

function attachPoolErrorHandler(pool: Pool): void {
  const emitter = pool as unknown as {
    on?: (event: string, listener: (err: Error) => void) => void
    listenerCount?: (event: string) => number
  }
  if (
    typeof emitter.on === 'function' &&
    (typeof emitter.listenerCount !== 'function' || emitter.listenerCount('error') === 0)
  ) {
    emitter.on('error', () => {
      // Prevent unhandled idle-client pool 'error' events from crashing the worker process
    })
  }
}

function isPgSqlStateError(err: unknown): boolean {
  const code = extractErrorCode(err)
  return /^[0-9A-Z]{5}$/.test(code)
}

function attachClientErrorGuard(client: PoolClient): {
  hasError: () => boolean
  cleanup: () => void
} {
  let errored = false
  const onError = (): void => {
    errored = true
  }
  const emitter = client as unknown as {
    on?: (event: string, listener: (...args: unknown[]) => void) => void
    removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
    off?: (event: string, listener: (...args: unknown[]) => void) => void
  }
  if (typeof emitter.on === 'function') {
    emitter.on('error', onError)
  }
  return {
    hasError: () => errored,
    cleanup: () => {
      if (typeof emitter.removeListener === 'function') {
        emitter.removeListener('error', onError)
      } else if (typeof emitter.off === 'function') {
        emitter.off('error', onError)
      }
    },
  }
}

function destroyPgClientStream(client: PoolClient): void {
  const stream = (
    client as unknown as { connection?: { stream?: { destroyed?: boolean; destroy?: () => void } } }
  )?.connection?.stream
  if (stream && !stream.destroyed && typeof stream.destroy === 'function') {
    stream.destroy()
  }
}

function createPgLease(client: PoolClient): PgLease {
  // Capture the release callback of THIS borrow; pg-pool reassigns client.release on
  // every acquire, so reading the mutable property later could release a later borrow.
  const releaseOnce = client.release.bind(client)
  const pid = (client as unknown as { processID?: number }).processID ?? 0
  const lease: PgLease = {
    client,
    pid,
    released: false,
    release(destroy = false) {
      if (lease.released) return
      lease.released = true
      try {
        if (destroy) {
          destroyPgClientStream(client)
        }
        releaseOnce(destroy)
      } catch {
        // Ignore release failures on already-ended clients
      }
    },
  }
  return lease
}

function parsePgQueryResult(
  res: PgRawResult,
  maxRows: number
):
  | { isSelect: true; result: Omit<QueryResult, 'executionTimeMs'> }
  | { isSelect: false; affectedRows: number } {
  const fields = Array.isArray(res.fields) ? res.fields : []
  if (fields.length === 0) {
    return {
      isSelect: false,
      affectedRows: res.rowCount ?? 0,
    }
  }

  const columns = fields.map((f) => ({
    name: f.name,
    type: PG_OID_TYPE_NAMES[f.dataTypeID] ?? String(f.dataTypeID),
  }))

  const rawRows = res.rows || []
  const limit = maxRows > 0 ? maxRows : rawRows.length
  const truncated = rawRows.length > limit
  const slicedRows = rawRows.slice(0, limit)

  // Positional row array mapping (supports native rowMode: 'array' AND object rows from mocks)
  const rows: unknown[][] = slicedRows.map((r) =>
    Array.isArray(r) ? r : columns.map((c) => r[c.name])
  )

  return {
    isSelect: true,
    result: {
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      isSelect: true,
    },
  }
}

export type PostgresEngineType = 'postgres' | 'cockroachdb'

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && 'message' in err) {
    const val = Reflect.get(err, 'message')
    return typeof val === 'string' ? val : String(val ?? '')
  }
  return ''
}

function extractErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const val = Reflect.get(err, 'code')
    return typeof val === 'string' ? val : String(val ?? '')
  }
  return ''
}

const POSTGRES_CATALOG_FALLBACK_CODES = new Set(['42501', '42P01', '42703'])

function isPostgresCatalogUnavailableError(err: unknown): boolean {
  return POSTGRES_CATALOG_FALLBACK_CODES.has(extractErrorCode(err))
}

/**
 * Formats PostgreSQL / SCRAM driver errors into clear, actionable guidance.
 */
export function formatPostgresError(
  err: unknown,
  driverType: PostgresEngineType,
  profile?: ConnectionProfile
): string {
  const rawMsg = extractErrorMessage(err)

  if (/SASL:\s*SCRAM-SERVER-FIRST-MESSAGE:\s*client password must be a/i.test(rawMsg)) {
    const hostLabel = profile?.host ? ` for ${profile.host}` : ''
    const supabaseHint =
      profile?.host && isSupabaseHost(profile.host)
        ? ' On Supabase, this is your Project Database Password (under Project Settings -> Database), not your Supabase dashboard login password.'
        : ''
    return `Database Password is required for ${driverType === 'cockroachdb' ? 'CockroachDB' : 'PostgreSQL'} SCRAM authentication${hostLabel}. Replace placeholders like [YOUR-PASSWORD] or [YOUR-DATABASE-PASSWORD] and enter your Database Password.${supabaseHint}`
  }

  return (
    rawMsg ||
    `Failed to connect to ${driverType === 'cockroachdb' ? 'CockroachDB' : 'PostgreSQL'}`
  )
}

export class PostgresSession implements IDatabaseSession {
  readonly driverType: PostgresEngineType
  readonly profile: ConnectionProfile
  private pool: Pool
  private readonly baseConfig?: PoolConfig
  private activeConfig?: PoolConfig
  private poolerFallbackAttempted = false
  private poolerFallbackPromise: Promise<Pool> | null = null
  private readonly activeQueries = new Map<string, ActivePgQuery>()
  private readonly activeBatches = new Map<PgLease, ActiveBatch>()
  private readonly tableDetailsCache = new TableDetailsCache()
  private readonly oidTableCache = new Map<number, { schema: string; table: string }>()
  private isClosed = false
  private txLease: PgLease | null = null
  private txClientBroken = false
  private txAborted = false
  private txClientErrorHandler: ((...args: unknown[]) => void) | null = null
  private txOpChain: Promise<void> = Promise.resolve()
  private readonly closeWaiters = new Set<() => void>()
  private autoCommit = true
  private statementCount = 0
  private txStartedAt: number | undefined

  constructor(pool: Pool, profile: ConnectionProfile, baseConfig?: PoolConfig) {
    this.pool = pool
    this.profile = profile
    this.baseConfig = baseConfig
    this.activeConfig = baseConfig
    this.driverType = profile.driver === 'cockroachdb' ? 'cockroachdb' : 'postgres'
    attachPoolErrorHandler(pool)
  }

  isAlive(): boolean {
    return !this.isClosed
  }

  private get txClient(): PoolClient | null {
    return this.txLease ? this.txLease.client : null
  }

  private runExclusiveTxOp<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.txOpChain
    let release: (() => void) | undefined
    this.txOpChain = new Promise<void>((resolve) => {
      release = resolve
    })
    return prev.then(fn).finally(() => {
      if (release) release()
    })
  }

  private acquireLease(): Promise<PgLease> {
    return this.withPoolFallback((pool) => this.connectLease(pool))
  }

  private connectLease(pool: Pool): Promise<PgLease> {
    if (this.isClosed) {
      return Promise.reject(
        new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
      )
    }
    let abandoned = false
    const raw = pool.connect()
    return new Promise<PgLease>((resolve, reject) => {
      const onClose = (): void => {
        abandoned = true
        reject(new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType))
      }
      this.closeWaiters.add(onClose)
      raw.then(
        (client) => {
          this.closeWaiters.delete(onClose)
          const lease = createPgLease(client)
          if (abandoned || this.isClosed) {
            // Client arrived after close: hand it straight back to the ending pool
            lease.release(true)
            return
          }
          resolve(lease)
        },
        (err) => {
          this.closeWaiters.delete(onClose)
          reject(err)
        }
      )
    })
  }

  private detachTxClientErrorHandler(): void {
    const client = this.txClient
    const handler = this.txClientErrorHandler
    this.txClientErrorHandler = null
    if (!client || !handler) return
    const emitter = client as unknown as {
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
      off?: (event: string, listener: (...args: unknown[]) => void) => void
    }
    try {
      if (typeof emitter.removeListener === 'function') {
        emitter.removeListener('error', handler)
      } else if (typeof emitter.off === 'function') {
        emitter.off('error', handler)
      }
    } catch {
      // Ignore listener cleanup failures
    }
  }

  private pinTxClient(lease: PgLease): void {
    this.detachTxClientErrorHandler()
    this.txLease = lease
    this.txClientBroken = false
    this.txAborted = false
    const client = lease.client
    const handler = (..._args: unknown[]): void => {
      this.txClientBroken = true
    }
    const emitter = client as unknown as {
      on?: (event: string, listener: (...args: unknown[]) => void) => void
    }
    if (typeof emitter.on === 'function') {
      emitter.on('error', handler)
      this.txClientErrorHandler = handler
    }
  }

  private clearPinnedTxClient(): void {
    this.detachTxClientErrorHandler()
    this.txLease = null
    this.txClientBroken = false
    this.txAborted = false
    this.statementCount = 0
    this.txStartedAt = undefined
  }

  private discardBrokenPinnedClient(): void {
    const lease = this.txLease
    if (lease === null || !this.txClientBroken) return
    this.clearPinnedTxClient()
    lease.release(true)
  }

  private isSupabaseDirectNetworkFailure(err: unknown): boolean {
    if (this.poolerFallbackAttempted || !this.baseConfig?.host) {
      return false
    }
    if (!isSupabaseDirectHost(this.baseConfig.host)) {
      return false
    }
    const code = extractErrorCode(err)
    const msg = extractErrorMessage(err)
    return (
      /^(?:ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN)$/i.test(code) ||
      /\b(?:getaddrinfo|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|connect ECONNREFUSED)\b/i.test(
        msg
      )
    )
  }

  private async activateSupabasePoolerFallback(): Promise<Pool> {
    if (this.poolerFallbackPromise) {
      return this.poolerFallbackPromise
    }
    this.poolerFallbackAttempted = true
    this.poolerFallbackPromise = (async () => {
      const host = (this.baseConfig?.host || '').trim()
      const poolerConfig = await resolveSupabasePoolerConfig(host, this.baseConfig ?? {})
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
      }
      const { Pool } = await loadPgVendor()
      const nextPool = new Pool(poolerConfig)
      attachPoolErrorHandler(nextPool)
      if (this.isClosed) {
        void nextPool.end().catch(() => {})
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
      }
      const prevPool = this.pool
      this.pool = nextPool
      this.activeConfig = poolerConfig
      void prevPool.end().catch(() => {})
      return nextPool
    })()
    return this.poolerFallbackPromise
  }

  private async withPoolFallback<T>(operation: (pool: Pool) => Promise<T>): Promise<T> {
    try {
      return await operation(this.pool)
    } catch (err) {
      if (!this.isClosed && this.isSupabaseDirectNetworkFailure(err)) {
        const fallbackPool = await this.activateSupabasePoolerFallback()
        return await operation(fallbackPool)
      }
      throw err
    }
  }

  private readonly queryExecutor = async (
    sql: string,
    params?: unknown[]
  ): Promise<Record<string, unknown>[]> => {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const res = await this.withPoolFallback((pool) => pool.query(sql, params))
    return res.rows
  }

  private async sendCancelBackend(pid: number): Promise<boolean> {
    if (!Number.isInteger(pid) || pid <= 0) {
      return false
    }
    if (this.activeConfig) {
      const { Client } = await loadPgVendor()
      const cancelClient = new Client({
        host: this.activeConfig.host,
        port: this.activeConfig.port,
        database: this.activeConfig.database,
        user: this.activeConfig.user,
        password: this.activeConfig.password,
        ssl: this.activeConfig.ssl,
        options: this.activeConfig.options,
        connectionTimeoutMillis: 5000,
      })
      cancelClient.on('error', () => {
        // Ignore transient cancel-client errors
      })
      try {
        await cancelClient.connect()
        await cancelClient.query('SELECT pg_cancel_backend($1);', [pid])
        return true
      } catch {
        return false
      } finally {
        await cancelClient.end().catch(() => {})
      }
    }
    try {
      await this.pool.query('SELECT pg_cancel_backend($1);', [pid])
      return true
    } catch {
      return false
    }
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    if (this.isClosed) {
      return { ok: false, message: 'Session is closed' }
    }
    try {
      const lease = await this.acquireLease()
      if (this.isClosed) {
        lease.release(true)
        return { ok: false, message: 'Session is closed' }
      }
      const client = lease.client
      const errorGuard = attachClientErrorGuard(client)
      let failed = false
      try {
        await client.query('SELECT 1 AS ok;')
        return {
          ok: true,
          message:
            this.driverType === 'cockroachdb'
              ? 'CockroachDB connection valid'
              : 'PostgreSQL connection valid',
        }
      } catch (err) {
        failed = true
        throw err
      } finally {
        errorGuard.cleanup()
        lease.release(failed || errorGuard.hasError())
      }
    } catch (err: unknown) {
      return {
        ok: false,
        message: formatPostgresError(err, this.driverType, this.profile),
      }
    }
  }

  async close(): Promise<void> {
    this.tableDetailsCache.clear()
    if (this.isClosed) return
    this.isClosed = true

    // Wake checkout waiters promptly; pg-pool otherwise holds them until its timeout
    const waiters = Array.from(this.closeWaiters)
    this.closeWaiters.clear()
    for (const reject of waiters) {
      try {
        reject()
      } catch {
        // Ignore waiter rejection failures
      }
    }

    // Cancel/destroy active queries FIRST so pool.end() never hangs behind them
    const activeEntries = Array.from(this.activeQueries.values())
    this.activeQueries.clear()
    const hadActiveQuery = activeEntries.length > 0
    for (const active of activeEntries) {
      active.cancelled = true
      if (active.lease.pid > 0 && this.activeConfig) {
        void this.sendCancelBackend(active.lease.pid).catch(() => {})
      }
      active.lease.release(true)
    }

    // Abort batches still before COMMIT so a lock-blocked statement cannot outlive close.
    // A batch whose COMMIT already reached the provider keeps its real result; close waits.
    for (const batch of this.activeBatches.values()) {
      if (!batch.commitSent) {
        batch.lease.release(true)
      }
    }

    const lease = this.txLease
    if (lease !== null) {
      const txBatch = this.activeBatches.get(lease)
      const shouldDestroy =
        hadActiveQuery || this.txClientBroken || (txBatch !== undefined && !txBatch.commitSent)
      this.clearPinnedTxClient()
      if (!shouldDestroy) {
        try {
          await lease.client.query('ROLLBACK')
        } catch {
          // Ignore rollback error on close
        }
      }
      lease.release(true)
    }

    await this.pool.end().catch(() => {})
  }

  async listObjects(schema?: string): Promise<SchemaObject[]> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    return introspectPostgresObjects(this.queryExecutor, schema || 'public')
  }

  async listSchemas(): Promise<{ schemas: string[]; defaultSchema: string }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    return introspectPostgresSchemas(this.queryExecutor)
  }

  async getObjectDdl(name: string, kind: SchemaObjectKind, schema?: string): Promise<string> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    return this.introspectObjectDdl(name, kind, schema || 'public')
  }

  private async introspectObjectDdl(
    name: string,
    kind: SchemaObjectKind,
    targetSchema: string,
    sourceDatabase?: string
  ): Promise<string> {
    if (kind === 'table') {
      return this.getDdl(name, targetSchema)
    }
    return introspectPostgresObjectDdl(
      this.queryExecutor,
      name,
      kind,
      targetSchema,
      sourceDatabase === undefined ? undefined : { sourceDatabase }
    )
  }

  private async readCurrentDatabaseName(): Promise<string> {
    const rows = await this.queryExecutor('SELECT current_database() AS db;')
    const value = rows[0]?.db
    if (typeof value !== 'string' || value.length === 0) {
      throw new DatabaseDriverError(
        'Could not read current database name for CockroachDB schema export',
        'CATALOG_ERROR',
        this.driverType
      )
    }
    return value
  }

  async exportSchemaDdl(schema?: string): Promise<{ ddl: string; objectCount: number }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const targetSchema = schema || 'public'
    const objects = await this.listObjects(targetSchema)
    const needsPortableViews =
      this.driverType === 'cockroachdb' &&
      objects.some((object) => object.kind === 'view' || object.kind === 'materialized_view')
    const sourceDatabase = needsPortableViews ? await this.readCurrentDatabaseName() : undefined
    let dependencies: SchemaDependencyEdge[] | undefined
    if (this.driverType === 'postgres') {
      // Ordering hint only: a restricted/missing catalog falls back to the
      // previous kind-grouped ordering instead of failing the export.
      try {
        dependencies = await introspectPostgresSchemaDependencies(
          this.queryExecutor,
          targetSchema
        )
      } catch (err: unknown) {
        if (!isPostgresCatalogUnavailableError(err)) throw err
        dependencies = undefined
      }
    }
    return collectAndAssembleSchemaDdl({
      dialect: this.driverType,
      schemaName: targetSchema,
      objects,
      getObjectDdl: (object) =>
        this.introspectObjectDdl(object.name, object.kind, targetSchema, sourceDatabase),
      dependencies,
    })
  }

  async getTableDetails(table: string, schema?: string): Promise<TableDetails> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const targetSchema = schema || 'public'
    const cached = this.tableDetailsCache.get(targetSchema, 'public', table)
    if (cached) {
      return cached
    }
    const details = await introspectPostgresTableDetails(this.queryExecutor, table, targetSchema)
    this.tableDetailsCache.set(targetSchema, 'public', table, details)
    return details
  }

  async fetchPage(params: FetchPageParams): Promise<TableBrowseResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const schema = params.schema || 'public'

    if (!params.bypassTransaction && (!this.autoCommit || this.txLease !== null)) {
      return this.runExclusiveTxOp(async () => {
        if (this.isClosed) {
          throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
        }
        this.discardBrokenPinnedClient()
        if (!this.autoCommit && this.txClient === null) {
          await this.beginTransactionLocked()
        }
        const lease = this.txLease ?? (await this.acquireLease())
        const isPinned = this.txLease === lease
        const client = lease.client
        const errorGuard = isPinned ? null : attachClientErrorGuard(client)
        let failed = false
        try {
          let details = this.tableDetailsCache.get(schema, 'public', params.table)
          if (!details) {
            const txExecutor = async (qSql: string, qParams?: unknown[]) => {
              const res = (await client.query(qSql, qParams)) as unknown as PgRawResult
              return Array.isArray(res?.rows) ? (res.rows as Record<string, unknown>[]) : []
            }
            details = await introspectPostgresTableDetails(txExecutor, params.table, schema)
            this.tableDetailsCache.set(schema, 'public', params.table, details)
          }

          const { sql, countSql, params: queryParams } = buildSelectPageSql({
            driver: this.driverType,
            table: params.table,
            schema,
            page: params.page,
            pageSize: params.pageSize,
            sortColumn: params.sortColumn,
            sortDirection: params.sortDirection,
            primaryKey: details.primaryKey,
            whereClause: params.whereClause,
            orderByClause: params.orderByClause,
          })

          const countQuery: { text: string; values: unknown[]; queryMode: 'extended' } = {
            text: countSql,
            values: [],
            queryMode: 'extended',
          }
          const countRes = await client.query(countQuery)
          const dataRes = await client.query(sql, queryParams)

          return assembleTableBrowseResult({
            tableDetails: details,
            rows: dataRes.rows,
            countRow: countRes.rows[0] || { total: 0 },
            page: params.page,
            pageSize: params.pageSize,
          })
        } catch (err) {
          failed = true
          if (isPinned && errorGuard === null && !this.txClientBroken && isPgSqlStateError(err)) {
            this.txAborted = true
          }
          throw err
        } finally {
          if (errorGuard) {
            errorGuard.cleanup()
            lease.release(failed || errorGuard.hasError())
          }
        }
      })
    }

    const details = await this.getTableDetails(params.table, schema)

    const { sql, countSql, params: queryParams } = buildSelectPageSql({
      driver: this.driverType,
      table: params.table,
      schema,
      page: params.page,
      pageSize: params.pageSize,
      sortColumn: params.sortColumn,
      sortDirection: params.sortDirection,
      primaryKey: details.primaryKey,
      whereClause: params.whereClause,
      orderByClause: params.orderByClause,
    })

    // Force Extended Query Protocol (Parse/Bind/Execute) so countSql cannot execute multi-statement Simple Queries
    const countQuery: { text: string; values: unknown[]; queryMode: 'extended' } = {
      text: countSql,
      values: [],
      queryMode: 'extended',
    }
    const countRes = await this.withPoolFallback((pool) => pool.query(countQuery))
    const dataRes = await this.withPoolFallback((pool) => pool.query(sql, queryParams))

    return assembleTableBrowseResult({
      tableDetails: details,
      rows: dataRes.rows,
      countRow: countRes.rows[0] || { total: 0 },
      page: params.page,
      pageSize: params.pageSize,
    })
  }

  async updateCell(params: UpdateCellParams): Promise<UpdateCellResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const schema = params.schema || 'public'
    const originalColumnType = this.tableDetailsCache.findColumnType(
      schema,
      'public',
      params.table,
      params.column,
      params.columnType
    )
    const { sql, params: updateParams } = buildUpdateSql({
      driver: this.driverType,
      table: params.table,
      schema,
      column: params.column,
      newValue: params.newValue,
      primaryKeys: params.primaryKeys,
      originalValue: params.originalValue,
      originalColumnType,
    })

    const pinnedResult = await this.runExclusiveTxOp(async (): Promise<UpdateCellResult | null> => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
      }
      this.discardBrokenPinnedClient()
      if (!this.autoCommit && this.txClient === null) {
        await this.beginTransactionLocked()
      }
      if (this.txLease === null) {
        return null
      }
      const client = this.txLease.client
      let savepointCreated = false
      let res: { rowCount?: number | null; rows: Record<string, unknown>[] }
      try {
        await client.query('SAVEPOINT datanoa_update_cell;')
        savepointCreated = true
        res = (await client.query(`${sql} RETURNING *;`, updateParams)) as {
          rowCount?: number | null
          rows: Record<string, unknown>[]
        }
        const affectedRows = res.rowCount ?? 0
        if (affectedRows === 0) {
          throw new DatabaseDriverError(
            'Record was modified or deleted by another session (optimistic lock conflict)',
            'conflict',
            this.driverType
          )
        }
        await client.query('RELEASE SAVEPOINT datanoa_update_cell;')
        this.statementCount++
        this.tableDetailsCache.clear()
        return {
          ok: true,
          affectedRows,
          updatedRecord: res.rows[0],
        }
      } catch (err) {
        if (savepointCreated && !this.txClientBroken && this.txLease !== null) {
          try {
            await client.query('ROLLBACK TO SAVEPOINT datanoa_update_cell;')
            await client.query('RELEASE SAVEPOINT datanoa_update_cell;')
          } catch (rbErr) {
            if (!this.txClientBroken && isPgSqlStateError(rbErr)) {
              this.txAborted = true
            }
          }
        } else if (!this.txClientBroken && isPgSqlStateError(err)) {
          this.txAborted = true
        }
        throw err
      }
    })
    if (pinnedResult !== null) {
      return pinnedResult
    }

    const res = await this.withPoolFallback((pool) =>
      pool.query(`${sql} RETURNING *;`, updateParams)
    )
    const affectedRows = res.rowCount ?? 0

    if (affectedRows === 0) {
      throw new DatabaseDriverError(
        'Record was modified or deleted by another session (optimistic lock conflict)',
        'conflict',
        this.driverType
      )
    }

    this.tableDetailsCache.clear()

    return {
      ok: true,
      affectedRows,
      updatedRecord: res.rows[0],
    }
  }

  async previewChanges(params: ApplyChangesParams): Promise<PreviewChangesResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const schema = params.schema || 'public'
    const batch = buildBatchStatements({
      driver: this.driverType,
      table: params.table,
      schema,
      inserts: params.inserts,
      updates: params.updates,
      deletes: params.deletes,
      columnTypes: this.tableDetailsCache.resolveColumnTypes(
        schema,
        'public',
        params.table,
        params.columnTypes
      ),
    })
    return { statements: batch.previewStatements }
  }

  private async resolveSourceTableFromFields(
    client: PoolClient,
    fields: PgRawResult['fields']
  ): Promise<{ schema: string; table: string } | undefined> {
    if (!Array.isArray(fields) || fields.length === 0) return undefined
    const uniqueOids = new Set<number>()
    for (const f of fields) {
      if (typeof f.tableID === 'number' && Number.isInteger(f.tableID) && f.tableID > 0) {
        uniqueOids.add(f.tableID)
      }
    }
    if (uniqueOids.size !== 1) return undefined
    const [oid] = Array.from(uniqueOids)
    const cached = this.oidTableCache.get(oid)
    if (cached) return cached

    const sql =
      'SELECT n.nspname AS schema_name, c.relname AS table_name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = $1'
    try {
      const txStatus = (client as unknown as { _txStatus?: string | null })._txStatus
      if (this.txAborted || txStatus === 'E') {
        // Aborted transaction: skip enrichment rather than borrow a nested connection
        return undefined
      }
      // Resolve on the current client so a busy pool cannot deadlock on enrichment
      const res = (await client.query(sql, [oid])) as unknown as PgRawResult
      const row = Array.isArray(res?.rows) ? res.rows[0] : undefined
      if (row && !Array.isArray(row)) {
        const schema = typeof row.schema_name === 'string' ? row.schema_name : ''
        const table = typeof row.table_name === 'string' ? row.table_name : ''
        if (schema && table) {
          const resolved = { schema, table }
          this.oidTableCache.set(oid, resolved)
          return resolved
        }
      }
    } catch {
      // Non-fatal catalog lookup failure; fall back to conservative read-only handling
    }
    return undefined
  }

  async applyChanges(params: ApplyChangesParams): Promise<ApplyChangesResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const schema = params.schema || 'public'
    const batch = buildBatchStatements({
      driver: this.driverType,
      table: params.table,
      schema,
      inserts: params.inserts,
      updates: params.updates,
      deletes: params.deletes,
      columnTypes: this.tableDetailsCache.resolveColumnTypes(
        schema,
        'public',
        params.table,
        params.columnTypes
      ),
    })
    if (batch.all.length === 0) {
      return { ok: true, inserted: 0, updated: 0, deleted: 0, statements: [] }
    }

    const pinnedResult = await this.runExclusiveTxOp(async (): Promise<ApplyChangesResult | null> => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
      }
      this.discardBrokenPinnedClient()
      if (!this.autoCommit && this.txClient === null) {
        await this.beginTransactionLocked()
      }
      if (this.txClient === null) {
        return null
      }
      const lease = this.txLease
      if (lease === null) {
        return null
      }
      const client = lease.client
      const batchEntry: ActiveBatch = { lease, commitSent: false }
      this.activeBatches.set(lease, batchEntry)
      try {
        await client.query('SAVEPOINT datanoa_apply_changes')
        let deleted = 0
        for (const stmt of batch.deletes) {
          const res = await client.query(stmt.sql, stmt.params)
          const count = res.rowCount ?? 0
          if (count === 0) {
            throw new DatabaseDriverError(
              'Record was modified or deleted by another session (optimistic lock conflict)',
              'conflict',
              this.driverType
            )
          }
          deleted += count
        }

        let updated = 0
        for (const stmt of batch.updates) {
          const res = await client.query(stmt.sql, stmt.params)
          const count = res.rowCount ?? 0
          if (count === 0) {
            throw new DatabaseDriverError(
              'Record was modified or deleted by another session (optimistic lock conflict)',
              'conflict',
              this.driverType
            )
          }
          updated += count
        }

        let inserted = 0
        for (const stmt of batch.chunkedInserts) {
          const res = await client.query(stmt.sql, stmt.params)
          inserted += res.rowCount ?? stmt.rowCount
        }

        await client.query('RELEASE SAVEPOINT datanoa_apply_changes')
        this.statementCount += batch.deletes.length + batch.updates.length + batch.chunkedInserts.length
        this.tableDetailsCache.clear()
        return {
          ok: true,
          inserted,
          updated,
          deleted,
          statements: batch.previewStatements,
        }
      } catch (err) {
        if (!lease.released && !this.isClosed) {
          try {
            await client.query('ROLLBACK TO SAVEPOINT datanoa_apply_changes')
            await client.query('RELEASE SAVEPOINT datanoa_apply_changes')
          } catch (rbErr) {
            if (!this.txClientBroken && isPgSqlStateError(rbErr)) {
              this.txAborted = true
            }
          }
        } else if (!this.txClientBroken && isPgSqlStateError(err)) {
          this.txAborted = true
        }
        throw err
      } finally {
        this.activeBatches.delete(lease)
      }
    })
    if (pinnedResult !== null) {
      return pinnedResult
    }

    const lease = await this.acquireLease()
    if (this.isClosed) {
      lease.release(true)
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const client = lease.client
    const errorGuard = attachClientErrorGuard(client)
    const batchEntry: ActiveBatch = { lease, commitSent: false }
    this.activeBatches.set(lease, batchEntry)
    let shouldDestroyClient = false
    try {
      await client.query('BEGIN')
      let deleted = 0
      for (const stmt of batch.deletes) {
        if (this.isClosed) {
          throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
        }
        const res = await client.query(stmt.sql, stmt.params)
        const count = res.rowCount ?? 0
        if (count === 0) {
          throw new DatabaseDriverError(
            'Record was modified or deleted by another session (optimistic lock conflict)',
            'conflict',
            this.driverType
          )
        }
        deleted += count
      }

      let updated = 0
      for (const stmt of batch.updates) {
        if (this.isClosed) {
          throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
        }
        const res = await client.query(stmt.sql, stmt.params)
        const count = res.rowCount ?? 0
        if (count === 0) {
          throw new DatabaseDriverError(
            'Record was modified or deleted by another session (optimistic lock conflict)',
            'conflict',
            this.driverType
          )
        }
        updated += count
      }

      let inserted = 0
      for (const stmt of batch.chunkedInserts) {
        if (this.isClosed) {
          throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
        }
        const res = await client.query(stmt.sql, stmt.params)
        inserted += res.rowCount ?? stmt.rowCount
      }

      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
      }
      // Mark COMMIT as dispatched in the same synchronous turn as the query so a
      // later close keeps the provider result instead of aborting a committed batch.
      batchEntry.commitSent = true
      await client.query('COMMIT')
      this.tableDetailsCache.clear()
      return {
        ok: true,
        inserted,
        updated,
        deleted,
        statements: batch.previewStatements,
      }
    } catch (err) {
      if (batchEntry.commitSent) {
        // COMMIT already reached the provider: keep its real outcome, never infer rollback
      } else if (lease.released || this.isClosed) {
        shouldDestroyClient = true
      } else {
        try {
          await client.query('ROLLBACK')
        } catch {
          shouldDestroyClient = true
        }
      }
      throw err
    } finally {
      this.activeBatches.delete(lease)
      errorGuard.cleanup()
      lease.release(shouldDestroyClient || errorGuard.hasError())
    }
  }

  async getDdl(table: string, schema?: string): Promise<string> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const targetSchema = schema || 'public'
    const details = await this.getTableDetails(table, targetSchema)
    return reconstructTableDdl(details, this.driverType)
  }

  async runQuery(queryId: string, sql: string, maxRows = 1000): Promise<QueryResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }

    const stmts = splitSqlStatements(sql, this.driverType).map((s) => s.text)
    const execList = stmts.length <= 1 ? [sql] : stmts
    const startsManualTx = execList.some((s) =>
      /^(?:BEGIN|START\s+TRANSACTION)\b/i.test(stripLeadingSqlComments(s.trim(), this.driverType).trim())
    )
    const needsTxLock = !this.autoCommit || this.txClient !== null || startsManualTx

    const executeRun = async (): Promise<QueryResult> => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
      }
      if (this.txClient !== null && this.txClientBroken) {
        this.discardBrokenPinnedClient()
      }
      if (!this.autoCommit && this.txClient === null) {
        await this.beginTransactionLocked()
      }

      const isPinned = this.txLease !== null
      const lease = this.txLease ?? (await this.acquireLease())
      const client = lease.client
      if (this.isClosed) {
        lease.release(true)
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
      }
      const errorGuard = attachClientErrorGuard(client)
      const startTime = performance.now()

      const activeEntry: ActivePgQuery = {
        lease,
        startTime,
        cancelled: false,
      }
      this.activeQueries.set(queryId, activeEntry)

      let shouldDestroyClient = false
      try {
        let totalAffectedRows = 0
        let lastSelect: Omit<QueryResult, 'executionTimeMs'> | null = null
        const collectedSets: QueryResultSet[] = []

        for (let execIndex = 0; execIndex < execList.length; execIndex++) {
          const stmtSql = execList[execIndex]
          if (activeEntry.cancelled || this.isClosed) {
            shouldDestroyClient = true
            throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', this.driverType)
          }
          const trimmedStmt = stmtSql.trim()
          const stmtStart = performance.now()
          const normalizedStmt = stripLeadingSqlComments(trimmedStmt, this.driverType).trim()
          const isStandaloneBegin = /^(?:BEGIN|START\s+TRANSACTION)\b/i.test(normalizedStmt)
          if (isStandaloneBegin && this.txClient === null) {
            this.pinTxClient(lease)
          }

          const res = (await client.query({
            text: stmtSql,
            rowMode: 'array',
          })) as unknown as PgRawResult
          if (this.isClosed && this.txClient !== client) {
            shouldDestroyClient = true
            throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
          }

          const isCommit =
            /^(?:COMMIT|END(?:\s+(?:TRANSACTION|WORK))?)\b/i.test(normalizedStmt) ||
            /^PREPARE\s+TRANSACTION\b/i.test(normalizedStmt)
          const isRollback =
            SQL_STANDALONE_ROLLBACK_RE.test(normalizedStmt) ||
            /^ABORT(?:\s+(?:WORK|TRANSACTION))?\b/i.test(normalizedStmt)
          const isAndChain = /\bAND\s+CHAIN\b/i.test(normalizedStmt)
          const txStatus = (client as unknown as { _txStatus?: string | null })._txStatus
          const commandTag = typeof res?.command === 'string' ? res.command.toUpperCase() : ''

          const parsed = parsePgQueryResult(res, maxRows)
          const stmtDurationMs = Math.round(performance.now() - stmtStart)
          if (parsed.isSelect) {
            const sourceTable = await this.resolveSourceTableFromFields(client, res.fields)
            const enrichedResult: Omit<QueryResult, 'executionTimeMs'> = sourceTable
              ? { ...parsed.result, sourceTable }
              : parsed.result
            lastSelect = enrichedResult
            collectedSets.push({
              index: execIndex,
              sqlPreview: compactSql(trimmedStmt),
              sql: trimmedStmt,
              executionTimeMs: stmtDurationMs,
              columns: enrichedResult.columns,
              rows: enrichedResult.rows,
              rowCount: enrichedResult.rowCount,
              truncated: enrichedResult.truncated,
              isSelect: true,
              ...(sourceTable ? { sourceTable } : {}),
            })
          } else if (execList.length === 1) {
            totalAffectedRows = parsed.affectedRows
            collectedSets.push({
              index: execIndex,
              sqlPreview: compactSql(trimmedStmt),
              sql: trimmedStmt,
              executionTimeMs: stmtDurationMs,
              columns: [{ name: 'affected_rows', type: 'INTEGER' }],
              rows: [[parsed.affectedRows]],
              rowCount: 1,
              affectedRows: parsed.affectedRows,
              truncated: false,
              isSelect: false,
            })
          } else {
            totalAffectedRows += parsed.affectedRows
            collectedSets.push({
              index: execIndex,
              sqlPreview: compactSql(trimmedStmt),
              sql: trimmedStmt,
              executionTimeMs: stmtDurationMs,
              columns: [{ name: 'affected_rows', type: 'INTEGER' }],
              rows: [[parsed.affectedRows]],
              rowCount: 1,
              affectedRows: parsed.affectedRows,
              truncated: false,
              isSelect: false,
            })
          }

          if (this.txClient === client) {
            if (!isStandaloneBegin) {
              this.statementCount++
            }
            if (/^ROLLBACK\s+(?:(?:WORK|TRANSACTION)\s+)?TO\s+(?:SAVEPOINT\s+)?/i.test(normalizedStmt)) {
              this.txAborted = false
            }
            if (isCommit || isRollback || (!isStandaloneBegin && txStatus === 'I')) {
              const staysInTx = isAndChain || txStatus === 'T' || txStatus === 'E'
              if (staysInTx) {
                this.statementCount = 0
                this.txStartedAt = Date.now()
                this.txAborted = txStatus === 'E'
              } else {
                // Defer release until execList completes so trailing statements still run safely
                this.clearPinnedTxClient()
              }
            }
          }

          if (isCommit && !isRollback && commandTag === 'ROLLBACK') {
            throw new DatabaseDriverError(
              'Transaction was in an aborted state due to an earlier error and was rolled back by PostgreSQL instead of committed.',
              'TX_ABORTED_ROLLBACK',
              this.driverType
            )
          }
        }

        const executionTimeMs = Math.round(performance.now() - startTime)
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
        if (this.txClient === client && (errorGuard.hasError() || this.txClientBroken)) {
          shouldDestroyClient = true
          this.clearPinnedTxClient()
        } else if (
          this.txClient === client &&
          !this.txClientBroken &&
          !activeEntry.cancelled &&
          isPgSqlStateError(err)
        ) {
          this.txAborted = true
        } else if (!isPinned) {
          shouldDestroyClient = true
        }
        throw err
      } finally {
        if (containsDdlStatement(sql, this.driverType)) {
          this.tableDetailsCache.clear()
          this.oidTableCache.clear()
        }
        this.activeQueries.delete(queryId)

        const currentlyPinned = this.txClient === client
        if (currentlyPinned) {
          errorGuard.cleanup()
          if (shouldDestroyClient || activeEntry.cancelled || errorGuard.hasError() || this.txClientBroken) {
            this.clearPinnedTxClient()
            lease.release(true)
          }
        } else {
          // Always detach the error listener, even when close already released the lease
          errorGuard.cleanup()
          if (!lease.released) {
            // Guard against leaking IDLE IN TRANSACTION clients back to the pool
            const txStatus = (client as unknown as { _txStatus?: string | null })._txStatus
            if (
              !shouldDestroyClient &&
              !activeEntry.cancelled &&
              !errorGuard.hasError() &&
              (txStatus === 'T' || txStatus === 'E')
            ) {
              try {
                await client.query('ROLLBACK')
              } catch {
                shouldDestroyClient = true
              }
            }

            lease.release(shouldDestroyClient || activeEntry.cancelled || errorGuard.hasError())
          }
        }
      }
    }

    return needsTxLock ? this.runExclusiveTxOp(executeRun) : executeRun()
  }

  async cancelQuery(queryId: string): Promise<{ ok: boolean }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const active = this.activeQueries.get(queryId)
    if (!active) {
      return { ok: true }
    }

    active.cancelled = true
    const ok = await this.sendCancelBackend(active.lease.pid)
    return { ok }
  }

  getTransactionState(): TransactionState {
    const txStatus = (this.txClient as unknown as { _txStatus?: string | null } | null)?._txStatus
    const aborted = this.txClient !== null && (this.txAborted || txStatus === 'E')
    return {
      active: this.txClient !== null,
      autoCommit: this.autoCommit,
      statementCount: this.statementCount,
      startedAt: this.txStartedAt,
      supported: true,
      ...(aborted ? { aborted: true } : {}),
    }
  }

  async setAutoCommit(enabled: boolean): Promise<TransactionState> {
    return this.runExclusiveTxOp(async () => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
      }
      this.discardBrokenPinnedClient()
      if (enabled) {
        if (this.txClient !== null) {
          throw new DatabaseDriverError(
            'Commit or rollback the active transaction before switching to Auto-Commit',
            'TX_ACTIVE',
            this.driverType
          )
        }
        this.autoCommit = true
      } else {
        this.autoCommit = false
      }
      return this.getTransactionState()
    })
  }

  private async beginTransactionLocked(): Promise<TransactionState> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    this.discardBrokenPinnedClient()
    if (this.txClient !== null) {
      throw new DatabaseDriverError('Transaction is already active', 'TX_ALREADY_ACTIVE', this.driverType)
    }
    const lease = await this.acquireLease()
    if (this.isClosed) {
      lease.release(true)
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    try {
      await lease.client.query('BEGIN')
      if (this.isClosed) {
        lease.release(true)
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
      }
      this.pinTxClient(lease)
      this.statementCount = 0
      this.txStartedAt = Date.now()
      return this.getTransactionState()
    } catch (err) {
      lease.release(true)
      throw err
    }
  }

  async beginTransaction(): Promise<TransactionState> {
    return this.runExclusiveTxOp(() => this.beginTransactionLocked())
  }

  async commitTransaction(): Promise<TransactionState> {
    return this.runExclusiveTxOp(async () => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
      }
      const lease = this.txLease
      if (lease === null) {
        throw new DatabaseDriverError('Cannot commit: no active transaction', 'NO_ACTIVE_TX', this.driverType)
      }
      const client = lease.client
      const broken = this.txClientBroken
      this.clearPinnedTxClient()
      try {
        if (broken) {
          lease.release(true)
          throw new DatabaseDriverError(
            'Transaction connection was lost before commit; changes were rolled back.',
            'TX_CONNECTION_LOST',
            this.driverType
          )
        }
        const res = (await client.query('COMMIT')) as unknown as PgRawResult
        lease.release(false)
        if (typeof res?.command === 'string' && res.command.toUpperCase() === 'ROLLBACK') {
          throw new DatabaseDriverError(
            'Transaction was in an aborted state due to an earlier error and was rolled back by PostgreSQL instead of committed.',
            'TX_ABORTED_ROLLBACK',
            this.driverType
          )
        }
        return this.getTransactionState()
      } catch (err) {
        lease.release(true)
        throw err
      }
    })
  }

  async rollbackTransaction(): Promise<TransactionState> {
    return this.runExclusiveTxOp(async () => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
      }
      const lease = this.txLease
      if (lease === null) {
        throw new DatabaseDriverError('Cannot rollback: no active transaction', 'NO_ACTIVE_TX', this.driverType)
      }
      const client = lease.client
      const broken = this.txClientBroken
      this.clearPinnedTxClient()
      try {
        if (!broken) {
          await client.query('ROLLBACK')
        }
        lease.release(broken)
        return this.getTransactionState()
      } catch (err) {
        lease.release(true)
        throw err
      }
    })
  }
}

const AWS_IPV6_PREFIX_TO_REGION: ReadonlyArray<{ prefix: string; region: string }> = [
  { prefix: '2406:da18:', region: 'ap-southeast-1' },
  { prefix: '2406:da1c:', region: 'ap-northeast-1' },
  { prefix: '2406:da14:', region: 'ap-northeast-2' },
  { prefix: '2406:da1a:', region: 'ap-south-1' },
  { prefix: '2406:da12:', region: 'ap-southeast-2' },
  { prefix: '2600:1f18:', region: 'us-east-1' },
  { prefix: '2600:1f16:', region: 'us-east-2' },
  { prefix: '2600:1f14:', region: 'us-west-2' },
  { prefix: '2600:1f1c:', region: 'us-west-1' },
  { prefix: '2600:1f1d:', region: 'ca-central-1' },
  { prefix: '2600:1f1e:', region: 'sa-east-1' },
  { prefix: '2a05:d018:', region: 'eu-west-1' },
  { prefix: '2a05:d014:', region: 'eu-central-1' },
  { prefix: '2a05:d01c:', region: 'eu-west-2' },
  { prefix: '2a05:d012:', region: 'eu-west-3' },
  { prefix: '2a05:d016:', region: 'eu-north-1' },
  { prefix: '2a05:d01a:', region: 'eu-south-1' },
]

export function mapSupabaseIpv6ToRegion(ipv6Address: string): string {
  const lower = (ipv6Address || '').trim().toLowerCase()
  for (const item of AWS_IPV6_PREFIX_TO_REGION) {
    if (lower.startsWith(item.prefix)) {
      return item.region
    }
  }
  return 'ap-southeast-1'
}

export async function resolveSupabasePoolerConfig(
  host: string,
  baseConfig: PoolConfig
): Promise<PoolConfig> {
  const match = /^db\.([a-z0-9-]+)\.supabase\.co$/i.exec(host.trim())
  if (!match || !match[1]) {
    return baseConfig
  }
  const projectRef = match[1].toLowerCase()

  let region = 'ap-southeast-1'
  try {
    const ipv6List = await dns.promises.resolve6(host)
    if (Array.isArray(ipv6List) && ipv6List.length > 0 && ipv6List[0]) {
      region = mapSupabaseIpv6ToRegion(ipv6List[0])
    }
  } catch {
    // Keep default ap-southeast-1 fallback
  }

  const rawUser = baseConfig.user || 'postgres'
  const poolerUser = rawUser.includes('.') ? rawUser : `${rawUser}.${projectRef}`
  const candidateHosts = [
    `aws-0-${region}.pooler.supabase.com`,
    `aws-1-${region}.pooler.supabase.com`,
  ]

  const { Pool } = await loadPgVendor()
  for (const poolerHost of candidateHosts) {
    const candidateConfig: PoolConfig = {
      ...baseConfig,
      host: poolerHost,
      port: 5432,
      user: poolerUser,
      ssl: baseConfig.ssl,
      connectionTimeoutMillis: 6000,
    }
    const probePool = new Pool(candidateConfig)
    attachPoolErrorHandler(probePool)
    try {
      const client = await probePool.connect()
      const errorGuard = attachClientErrorGuard(client)
      errorGuard.cleanup()
      client.release()
      await probePool.end().catch(() => {})
      return {
        ...candidateConfig,
        connectionTimeoutMillis: 10000,
      }
    } catch (err: unknown) {
      await probePool.end().catch(() => {})
      const pgCode = extractErrorCode(err)
      const msg = extractErrorMessage(err)
      // XX000 ("Tenant or user not found") or network/timeout errors mean we should probe the next pooler shard
      const isShardMissOrNetworkError =
        pgCode === 'XX000' ||
        /tenant.*not found/i.test(msg) ||
        /^(?:ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN)$/i.test(pgCode) ||
        /\b(?:timeout|ETIMEDOUT|ENOTFOUND|ECONNREFUSED)\b/i.test(msg)
      if (isShardMissOrNetworkError) {
        continue
      }
      // 28P01 (password auth failed) or 3D000 (database does not exist) means THIS pooler shard owns the project
      return {
        ...candidateConfig,
        connectionTimeoutMillis: 10000,
      }
    }
  }

  return {
    ...baseConfig,
    host: candidateHosts[0],
    port: 5432,
    user: poolerUser,
    ssl: baseConfig.ssl,
  }
}

export class PostgresDriver implements IDatabaseDriver {
  readonly type: PostgresEngineType

  constructor(type: PostgresEngineType = 'postgres') {
    this.type = type
  }

  async createSession(
    profile: ConnectionProfile,
    password?: string,
    extraSecrets?: DriverTlsOptions
  ): Promise<IDatabaseSession> {
    const effectiveDriver: PostgresEngineType =
      profile.driver === 'cockroachdb' ? 'cockroachdb' : this.type
    const isCockroach = effectiveDriver === 'cockroachdb'
    const host = (profile.host || 'localhost').trim()
    const tlsOverride = await resolveEffectiveTlsOptions(
      profile,
      extraSecrets,
      extraSecrets?.tlsServername
    )
    let sslConfig: PoolConfig['ssl']
    if (tlsOverride === false) {
      // Explicit sslMode: 'disable' — never fall back to auto-SSL
      sslConfig = undefined
    } else if (tlsOverride) {
      sslConfig = tlsOverride
    } else {
      const useSsl =
        profile.ssl !== undefined
          ? Boolean(profile.ssl)
          : isCockroach || isCloudDatabaseHost(host)
      sslConfig = useSsl ? buildDefaultTlsOptions(extraSecrets?.tlsServername) : undefined
    }

    const rawOptions =
      typeof profile.options === 'string' && profile.options.trim().length > 0
        ? profile.options.trim()
        : undefined
    const effectiveOptions =
      profile.readOnly && (!rawOptions || !/\bdefault_transaction_read_only\s*=/i.test(rawOptions))
        ? `${rawOptions ? `${rawOptions} ` : ''}-c default_transaction_read_only=on`
        : rawOptions

    const baseConfig: PoolConfig = {
      host,
      port: profile.port || (isCockroach ? 26257 : 5432),
      database: profile.database || (isCockroach ? 'defaultdb' : 'postgres'),
      user: profile.user,
      password,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: sslConfig,
      ...(effectiveOptions ? { options: effectiveOptions } : {}),
    }

    const { Pool } = await loadPgVendor()
    const pool = new Pool(baseConfig)
    attachPoolErrorHandler(pool)
    return new PostgresSession(pool, { ...profile, driver: effectiveDriver }, baseConfig)
  }

  async testConnection(
    profile: ConnectionProfile,
    password?: string,
    extraSecrets?: DriverTlsOptions
  ): Promise<{ ok: boolean; message?: string }> {
    return runDriverConnectionTest(
      () => this.createSession(profile, password, extraSecrets),
      (err) => formatPostgresError(err, this.type, profile)
    )
  }
}
