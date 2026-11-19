import * as dns from 'node:dns'
import {
  Client,
  Pool,
  type PoolConfig,
  type PoolClient,
  types,
} from '../../../vendor/pg.js'
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
} from '../common/update-builder'
import {
  TableDetailsCache,
  introspectPostgresObjects,
  introspectPostgresTableDetails,
} from '../common/schema'
import {
  containsDdlStatement,
  reconstructTableDdl,
  splitSqlStatements,
} from '../common/sql-tools'

// Preserve DATE as 'YYYY-MM-DD' string without UTC timezone offset corruption
if (types && typeof types.setTypeParser === 'function') {
  types.setTypeParser(1082, (val: string) => val)
}

interface ActivePgQuery {
  client: PoolClient
  pid: number
  startTime: number
  cancelled: boolean
  released: boolean
}

interface PgRawResult {
  fields?: Array<{ name: string; dataTypeID: number }>
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
    type: String(f.dataTypeID),
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
  private readonly tableDetailsCache = new TableDetailsCache()
  private isClosed = false

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
      const client = await this.withPoolFallback((pool) => pool.connect())
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
        if (failed || errorGuard.hasError()) {
          client.release(true)
        } else {
          client.release()
        }
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

    // Cancel active queries and destroy checked-out clients so pool.end() never hangs
    const activeEntries = Array.from(this.activeQueries.values())
    this.activeQueries.clear()
    for (const active of activeEntries) {
      active.cancelled = true
      if (active.pid > 0 && this.activeConfig) {
        void this.sendCancelBackend(active.pid).catch(() => {})
      }
      if (!active.released) {
        active.released = true
        try {
          destroyPgClientStream(active.client)
          active.client.release(true)
        } catch {
          // Ignore errors when destroying already-ended clients
        }
      }
    }

    await this.pool.end().catch(() => {})
  }

  async listObjects(schema?: string): Promise<SchemaObject[]> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    return introspectPostgresObjects(this.queryExecutor, schema || 'public')
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
    const { sql, params: updateParams } = buildUpdateSql({
      driver: this.driverType,
      table: params.table,
      schema,
      column: params.column,
      newValue: params.newValue,
      primaryKeys: params.primaryKeys,
      originalValue: params.originalValue,
    })

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
    })
    return { statements: batch.previewStatements }
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
    })
    if (batch.all.length === 0) {
      return { ok: true, inserted: 0, updated: 0, deleted: 0, statements: [] }
    }

    const client = await this.withPoolFallback((pool) => pool.connect())
    const errorGuard = attachClientErrorGuard(client)
    let shouldDestroyClient = false
    try {
      await client.query('BEGIN')
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
      for (const stmt of batch.inserts) {
        const res = await client.query(stmt.sql, stmt.params)
        inserted += res.rowCount ?? 1
      }

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
      try {
        await client.query('ROLLBACK')
      } catch {
        shouldDestroyClient = true
      }
      throw err
    } finally {
      errorGuard.cleanup()
      if (shouldDestroyClient || errorGuard.hasError()) {
        client.release(true)
      } else {
        client.release()
      }
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
    const client = await this.withPoolFallback((pool) => pool.connect())
    const errorGuard = attachClientErrorGuard(client)
    const startTime = performance.now()

    const activeEntry: ActivePgQuery = {
      client,
      pid: (client as unknown as { processID?: number }).processID ?? 0,
      startTime,
      cancelled: false,
      released: false,
    }
    this.activeQueries.set(queryId, activeEntry)

    let shouldDestroyClient = false
    try {
      const stmts = splitSqlStatements(sql, this.driverType).map((s) => s.text)
      let totalAffectedRows = 0
      let lastSelect: Omit<QueryResult, 'executionTimeMs'> | null = null

      const execList = stmts.length <= 1 ? [sql] : stmts
      for (const stmtSql of execList) {
        if (activeEntry.cancelled || this.isClosed) {
          shouldDestroyClient = true
          throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', this.driverType)
        }
        const res = (await client.query({
          text: stmtSql,
          rowMode: 'array',
        })) as unknown as PgRawResult
        const parsed = parsePgQueryResult(res, maxRows)
        if (parsed.isSelect) {
          lastSelect = parsed.result
        } else if (execList.length === 1) {
          totalAffectedRows = parsed.affectedRows
        } else {
          totalAffectedRows += parsed.affectedRows
        }
      }

      const executionTimeMs = Math.round(performance.now() - startTime)
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
      shouldDestroyClient = true
      throw err
    } finally {
      if (containsDdlStatement(sql, this.driverType)) {
        this.tableDetailsCache.clear()
      }
      this.activeQueries.delete(queryId)

      // Guard against leaking IDLE IN TRANSACTION clients back to the pool
      const txStatus = (client as unknown as { _txStatus?: string | null })._txStatus
      if (
        !shouldDestroyClient &&
        !activeEntry.cancelled &&
        !activeEntry.released &&
        !errorGuard.hasError() &&
        (txStatus === 'T' || txStatus === 'E')
      ) {
        try {
          await client.query('ROLLBACK')
        } catch {
          shouldDestroyClient = true
        }
      }

      errorGuard.cleanup()
      if (!activeEntry.released) {
        activeEntry.released = true
        if (shouldDestroyClient || activeEntry.cancelled || errorGuard.hasError()) {
          client.release(true)
        } else {
          client.release()
        }
      }
    }
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
    const ok = await this.sendCancelBackend(active.pid)
    return { ok }
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

  for (const poolerHost of candidateHosts) {
    const candidateConfig: PoolConfig = {
      ...baseConfig,
      host: poolerHost,
      port: 5432,
      user: poolerUser,
      ssl: { rejectUnauthorized: false },
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
    ssl: { rejectUnauthorized: false },
  }
}

export class PostgresDriver implements IDatabaseDriver {
  readonly type: PostgresEngineType

  constructor(type: PostgresEngineType = 'postgres') {
    this.type = type
  }

  async createSession(profile: ConnectionProfile, password?: string): Promise<IDatabaseSession> {
    const effectiveDriver: PostgresEngineType =
      profile.driver === 'cockroachdb' ? 'cockroachdb' : this.type
    const isCockroach = effectiveDriver === 'cockroachdb'
    const host = (profile.host || 'localhost').trim()
    const useSsl =
      profile.ssl !== undefined
        ? Boolean(profile.ssl)
        : isCockroach || isCloudDatabaseHost(host)

    const baseConfig: PoolConfig = {
      host,
      port: profile.port || (isCockroach ? 26257 : 5432),
      database: profile.database || (isCockroach ? 'defaultdb' : 'postgres'),
      user: profile.user,
      password,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
      ...(typeof profile.options === 'string' && profile.options.trim().length > 0
        ? { options: profile.options.trim() }
        : {}),
    }

    const pool = new Pool(baseConfig)
    attachPoolErrorHandler(pool)
    return new PostgresSession(pool, { ...profile, driver: effectiveDriver }, baseConfig)
  }

  async testConnection(
    profile: ConnectionProfile,
    password?: string
  ): Promise<{ ok: boolean; message?: string }> {
    let session: IDatabaseSession | null = null
    try {
      session = await this.createSession(profile, password)
      return await session.test()
    } catch (err: unknown) {
      return { ok: false, message: formatPostgresError(err, this.type, profile) }
    } finally {
      if (session) {
        await session.close().catch(() => {})
      }
    }
  }
}
