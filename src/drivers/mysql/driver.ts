import type { ConnectionOptions, PoolOptions } from '../../../vendor/mysql2.js'
import { isCloudDatabaseHost } from '../common/connection-uri'
import type {
  ApplyChangesParams,
  ApplyChangesResult,
  ConnectionProfile,
  ExplainResult,
  FetchPageParams,
  IDatabaseDriver,
  IDatabaseSession,
  PreviewChangesResult,
  QueryResult,
  QueryResultSet,
  SchemaErGraph,
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
  buildSchemaErGraphFromCatalogRows,
  type RawErColumnRow,
  type RawErForeignKeyRow,
  type RawErTableRow,
  type RawErUniqueSetRow,
} from '../common/schema-er-graph'
import { parseExplainPlan } from '../../shared-explain-plan.js'
import * as net from 'node:net'
import * as tls from 'node:tls'
import type { DriverTlsOptions } from '../common/tls-and-tunnel'
import { buildDefaultTlsOptions, resolveEffectiveTlsOptions } from '../common/tls-and-tunnel'
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
  introspectMysqlObjectDdl,
  introspectMysqlObjects,
  introspectMysqlSchemas,
  introspectMysqlTableDetails,
} from '../common/schema'
import {
  containsDdlStatement,
  hasExplainAnalyzeOption,
  isExplainTargetMutating,
  isMutatingStatement,
  reconstructTableDdl,
  splitSqlStatements,
} from '../common/sql-tools'
import { toSqlBool } from '../common/schema'
import {
  SQL_STANDALONE_ROLLBACK_RE,
  compactSql,
  isMysqlImplicitCommitStatement,
  stripLeadingSqlComments,
} from '../common/sql-lexer'

type MysqlVendorModule = typeof import('../../../vendor/mysql2.js')
let mysqlVendorPromise: Promise<MysqlVendorModule> | null = null
let cachedMysqlTypes: Record<number, string> | null = null

const MYSQL_FALLBACK_TYPE_NAMES: Readonly<Record<number, string>> = {
  0: 'decimal',
  1: 'tiny',
  2: 'short',
  3: 'long',
  4: 'float',
  5: 'double',
  6: 'null',
  7: 'timestamp',
  8: 'longlong',
  9: 'int24',
  10: 'date',
  11: 'time',
  12: 'datetime',
  13: 'year',
  14: 'newdate',
  15: 'varchar',
  16: 'bit',
  17: 'timestamp2',
  18: 'datetime2',
  19: 'time2',
  245: 'json',
  246: 'newdecimal',
  247: 'enum',
  248: 'set',
  249: 'tiny_blob',
  250: 'medium_blob',
  251: 'long_blob',
  252: 'blob',
  253: 'var_string',
  254: 'string',
  255: 'geometry',
}

async function loadMysqlVendor(): Promise<MysqlVendorModule> {
  if (!mysqlVendorPromise) {
    mysqlVendorPromise = import('../../../vendor/mysql2.js')
      .then((mod) => {
        const typesObj =
          (mod as unknown as { Types?: Record<number, string> }).Types ??
          (mod.default as unknown as { Types?: Record<number, string> } | undefined)?.Types
        if (typesObj && typeof typesObj === 'object') {
          cachedMysqlTypes = typesObj
        }
        return mod
      })
      .catch((err: unknown) => {
        mysqlVendorPromise = null
        throw err
      })
  }
  return mysqlVendorPromise
}

const MYSQL_SERVER_STATUS_IN_TRANS = 0x0001
const MYSQL_SERVER_STATUS_AUTOCOMMIT = 0x0002
const MYSQL_TYPE_BIT = 16

interface MysqlResultHeaderLike {
  affectedRows?: number
  insertId?: number
  serverStatus?: number
}

function extractServerStatus(res: unknown): number | undefined {
  if (res && typeof res === 'object' && 'serverStatus' in res) {
    const val = (res as MysqlResultHeaderLike).serverStatus
    if (typeof val === 'number' && Number.isFinite(val)) return val
  }
  return undefined
}

interface MysqlQueryObject {
  sql: string
  rowsAsArray?: boolean
}

interface MysqlTlsStreamLike {
  getPeerCertificate?: () => tls.PeerCertificate
}

interface MysqlInternalConnectionLike {
  stream?: MysqlTlsStreamLike
}

export interface MysqlConnectionLike {
  threadId?: number
  stream?: MysqlTlsStreamLike
  connection?: MysqlInternalConnectionLike
  query(sql: string | MysqlQueryObject, params?: unknown[]): Promise<[unknown, unknown]>
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  release(): void
  destroy?: () => void
  end?: () => Promise<void>
}

export interface MysqlPoolLike {
  getConnection(): Promise<MysqlConnectionLike>
  query(sql: string | MysqlQueryObject, params?: unknown[]): Promise<[unknown, unknown]>
  end(): Promise<void>
}

interface ActiveMysqlQuery {
  conn: MysqlConnectionLike
  threadId: number
  startTime: number
  cancelled: boolean
  released: boolean
}

interface MysqlFieldPacketLike {
  name: string
  columnType?: number
  columnLength?: number
}

function decodeMysqlBitValue(val: unknown, columnLength?: number): unknown {
  if (val === null || val === undefined || !(val instanceof Uint8Array)) {
    return val
  }
  if (val.length === 0) return '0'
  let bits = ''
  for (let i = 0; i < val.length; i++) {
    bits += val[i].toString(2).padStart(8, '0')
  }
  const bitWidth =
    typeof columnLength === 'number' && Number.isInteger(columnLength) && columnLength > 0
      ? Math.min(bits.length, columnLength)
      : bits.length
  const trimmed = bits.slice(-bitWidth)
  if (bitWidth === 1) {
    return trimmed
  }
  return `b'${trimmed}'`
}

function decodeMysqlRecordRows(
  rows: Record<string, unknown>[],
  fields: unknown
): Record<string, unknown>[] {
  if (!Array.isArray(fields) || fields.length === 0 || rows.length === 0) {
    return rows
  }
  const bitFields = (fields as MysqlFieldPacketLike[]).filter((f) => f.columnType === MYSQL_TYPE_BIT)
  if (bitFields.length === 0) return rows
  return rows.map((row) => {
    const out = { ...row }
    for (const bf of bitFields) {
      if (Object.prototype.hasOwnProperty.call(out, bf.name)) {
        out[bf.name] = decodeMysqlBitValue(out[bf.name], bf.columnLength)
      }
    }
    return out
  })
}

function extractMysqlErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err) return err
  if (err && typeof err === 'object' && 'message' in err) {
    const val = Reflect.get(err, 'message')
    if (typeof val === 'string' && val) return val
  }
  return fallback
}

function extractMysqlErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const val = Reflect.get(err, 'code')
    return typeof val === 'string' ? val : String(val ?? '')
  }
  return ''
}

const FATAL_MYSQL_ERROR_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'ENOTCONN',
  'ER_SERVER_SHUTDOWN',
  'CR_SERVER_GONE_ERROR',
  'CR_SERVER_LOST',
  'ER_CLIENT_INTERACTION_TIMEOUT',
])

const FATAL_MYSQL_ERRNOS = new Set([1053, 2006, 2013, 4031])

function isFatalMysqlConnectionError(err: unknown): boolean {
  if (FATAL_MYSQL_ERROR_CODES.has(extractMysqlErrorCode(err).toUpperCase())) {
    return true
  }
  if (err && typeof err === 'object' && 'errno' in err) {
    const errno = Number(Reflect.get(err, 'errno'))
    if (Number.isInteger(errno) && FATAL_MYSQL_ERRNOS.has(errno)) {
      return true
    }
  }
  return false
}

function extractAffectedRows(res: unknown, fallback = 0): number {
  if (res && typeof res === 'object' && 'affectedRows' in res) {
    const num = Number((res as MysqlResultHeaderLike).affectedRows)
    return Number.isFinite(num) ? num : fallback
  }
  return fallback
}

function asRecordRows(rows: unknown): Record<string, unknown>[] {
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
}

function pickMysqlField(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in row && row[key] !== undefined) return row[key]
  }
  const lowerMap = new Map<string, unknown>()
  for (const [k, v] of Object.entries(row)) {
    lowerMap.set(k.toLowerCase(), v)
  }
  for (const key of keys) {
    const val = lowerMap.get(key.toLowerCase())
    if (val !== undefined) return val
  }
  return undefined
}

function pickMysqlString(row: Record<string, unknown>, ...keys: string[]): string {
  const val = pickMysqlField(row, ...keys)
  return val === null || val === undefined ? '' : String(val).trim()
}

function resolveMysqlColumnTypeName(columnType: number | undefined): string {
  if (columnType === undefined) return 'unknown'
  const typeMap = cachedMysqlTypes ?? MYSQL_FALLBACK_TYPE_NAMES
  if (typeMap[columnType]) {
    return String(typeMap[columnType]).toLowerCase()
  }
  return 'unknown'
}

function parseMysqlQueryResult(
  rows: unknown,
  fields: unknown,
  maxRows: number
):
  | { isSelect: true; result: Omit<QueryResult, 'executionTimeMs'> }
  | { isSelect: false; affectedRows: number } {
  const isSelect = Array.isArray(fields) && fields.length > 0
  if (!isSelect) {
    return {
      isSelect: false,
      affectedRows: extractAffectedRows(rows, 0),
    }
  }

  const fieldPackets = fields as MysqlFieldPacketLike[]
  const columns = fieldPackets.map((f) => ({
    name: f.name,
    type: resolveMysqlColumnTypeName(f.columnType),
  }))

  const rawRows = Array.isArray(rows) ? (rows as Array<unknown[] | Record<string, unknown>>) : []
  const limit = maxRows > 0 ? maxRows : rawRows.length
  const truncated = rawRows.length > limit
  const slicedRows = rawRows.slice(0, limit)

  // Supports native rowsAsArray: true AND object-row mocks
  const resultRows: unknown[][] = slicedRows.map((r) =>
    columns.map((c, idx) => {
      const rawVal = Array.isArray(r) ? r[idx] : r[c.name]
      return fieldPackets[idx]?.columnType === MYSQL_TYPE_BIT
        ? decodeMysqlBitValue(rawVal, fieldPackets[idx]?.columnLength)
        : rawVal
    })
  )

  return {
    isSelect: true,
    result: {
      columns,
      rows: resultRows,
      rowCount: resultRows.length,
      truncated,
      isSelect: true,
    },
  }
}

export type MysqlEngineType = 'mysql' | 'mariadb'

export class MysqlSession implements IDatabaseSession {
  readonly driverType: MysqlEngineType
  readonly profile: ConnectionProfile
  private readonly pool: MysqlPoolLike
  private readonly cancelConnOptions?: ConnectionOptions
  private readonly verifyIpIdentity?: string
  private readonly verifiedIdentityConns = new WeakSet<MysqlConnectionLike>()
  private readonly readOnlyAppliedConns = new WeakSet<MysqlConnectionLike>()
  private readonly activeQueries = new Map<string, ActiveMysqlQuery>()
  private readonly tableDetailsCache = new TableDetailsCache()
  private isClosed = false
  private txConn: MysqlConnectionLike | null = null
  private txOpChain: Promise<void> = Promise.resolve()
  private readonly releasedConns = new WeakSet<MysqlConnectionLike>()
  private autoCommit = true
  private statementCount = 0
  private txStartedAt: number | undefined

  constructor(
    pool: MysqlPoolLike,
    profile: ConnectionProfile,
    cancelConnOptions?: ConnectionOptions,
    verifyIpIdentity?: string
  ) {
    this.pool = pool
    this.profile = profile
    this.cancelConnOptions = cancelConnOptions
    this.verifyIpIdentity = verifyIpIdentity
    this.driverType = profile.driver === 'mariadb' ? 'mariadb' : 'mysql'
  }

  private verifyConnectionIdentityIfNeeded(conn: MysqlConnectionLike): void {
    if (!this.verifyIpIdentity || this.verifiedIdentityConns.has(conn)) {
      return
    }
    const stream = conn.connection?.stream ?? conn.stream
    if (!stream || typeof stream.getPeerCertificate !== 'function') {
      this.safeReleaseConn(conn, true)
      throw new DatabaseDriverError(
        `TLS verify-full failed for ${this.verifyIpIdentity}: underlying TLS stream is unavailable for peer certificate verification`,
        'TLS_IDENTITY_MISMATCH',
        this.driverType
      )
    }
    const peerCert = stream.getPeerCertificate()
    if (!peerCert || Object.keys(peerCert).length === 0) {
      this.safeReleaseConn(conn, true)
      throw new DatabaseDriverError(
        `TLS verify-full failed for ${this.verifyIpIdentity}: server did not present a peer certificate`,
        'TLS_IDENTITY_MISMATCH',
        this.driverType
      )
    }
    const identityErr = tls.checkServerIdentity(this.verifyIpIdentity, peerCert)
    if (identityErr) {
      this.safeReleaseConn(conn, true)
      throw new DatabaseDriverError(
        `TLS verify-full failed for ${this.verifyIpIdentity}: ${identityErr.message}`,
        'TLS_IDENTITY_MISMATCH',
        this.driverType
      )
    }
    this.verifiedIdentityConns.add(conn)
  }

  private async acquireConnection(): Promise<MysqlConnectionLike> {
    const conn = await this.pool.getConnection()
    this.verifyConnectionIdentityIfNeeded(conn)
    if (this.profile.readOnly && !this.readOnlyAppliedConns.has(conn)) {
      try {
        await conn.query('SET SESSION TRANSACTION READ ONLY')
        this.readOnlyAppliedConns.add(conn)
      } catch (err) {
        this.safeReleaseConn(conn, true)
        throw err
      }
    }
    return conn
  }

  private async poolQuery(sql: string, params?: unknown[]): Promise<[unknown, unknown]> {
    if (this.verifyIpIdentity || this.profile.readOnly) {
      const conn = await this.acquireConnection()
      try {
        return await conn.query(sql, params)
      } finally {
        this.safeReleaseConn(conn, false)
      }
    }
    return await this.pool.query(sql, params)
  }

  isAlive(): boolean {
    return !this.isClosed
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

  private safeReleaseConn(conn: MysqlConnectionLike, destroy: boolean): void {
    if (this.releasedConns.has(conn)) return
    this.releasedConns.add(conn)
    try {
      if (destroy && typeof conn.destroy === 'function') {
        conn.destroy()
      } else {
        conn.release()
      }
    } catch {
      // Ignore release failures on already-closed connections
    }
  }

  private clearPinnedTxConn(): void {
    this.txConn = null
    this.statementCount = 0
    this.txStartedAt = undefined
  }

  private readonly queryExecutor = async (
    sql: string,
    params?: unknown[]
  ): Promise<Record<string, unknown>[]> => {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const [rows] = await this.poolQuery(sql, params)
    return asRecordRows(rows)
  }

  private async sendKillQuery(threadId: number): Promise<boolean> {
    if (!Number.isInteger(threadId) || threadId <= 0) {
      return false
    }
    if (this.cancelConnOptions) {
      let killConn: MysqlConnectionLike | null = null
      try {
        const { mysqlPromise } = await loadMysqlVendor()
        killConn = (await mysqlPromise.createConnection({
          ...this.cancelConnOptions,
          connectTimeout: 5000,
        })) as unknown as MysqlConnectionLike
        this.verifyConnectionIdentityIfNeeded(killConn)
        await killConn.query(`KILL QUERY ${threadId};`)
        return true
      } catch {
        return false
      } finally {
        if (killConn) {
          if (typeof killConn.end === 'function') {
            await killConn.end().catch(() => {
              killConn?.destroy?.()
            })
          } else {
            killConn.destroy?.()
          }
        }
      }
    }
    try {
      await this.poolQuery(`KILL QUERY ${threadId};`)
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
      const conn = await this.acquireConnection()
      let failed = false
      try {
        await conn.query('SELECT 1 AS ok;')
        return {
          ok: true,
          message:
            this.driverType === 'mariadb'
              ? 'MariaDB connection valid'
              : 'MySQL connection valid',
        }
      } catch (err) {
        failed = true
        throw err
      } finally {
        if (failed && typeof conn.destroy === 'function') {
          conn.destroy()
        } else {
          conn.release()
        }
      }
    } catch (err: unknown) {
      return {
        ok: false,
        message: extractMysqlErrorMessage(
          err,
          `Failed to connect to ${this.driverType === 'mariadb' ? 'MariaDB' : 'MySQL'}`
        ),
      }
    }
  }

  async close(): Promise<void> {
    this.tableDetailsCache.clear()
    if (this.isClosed) return
    this.isClosed = true

    // Cancel/destroy active queries FIRST so pool.end() never hangs behind them
    const activeEntries = Array.from(this.activeQueries.values())
    this.activeQueries.clear()
    const hadActiveQuery = activeEntries.length > 0
    for (const active of activeEntries) {
      active.cancelled = true
      if (Number.isInteger(active.threadId) && active.threadId > 0 && this.cancelConnOptions) {
        void this.sendKillQuery(active.threadId).catch(() => {})
      }
      if (!active.released) {
        active.released = true
        this.safeReleaseConn(active.conn, true)
      }
    }

    const conn = this.txConn
    if (conn !== null) {
      this.clearPinnedTxConn()
      if (!hadActiveQuery) {
        try {
          await conn.rollback()
        } catch {
          // Ignore rollback error on close
        }
      }
      this.safeReleaseConn(conn, true)
    }

    await this.pool.end().catch(() => {})
  }

  async listObjects(schema?: string): Promise<SchemaObject[]> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const targetSchema = schema !== undefined ? schema : this.profile.database || ''
    return introspectMysqlObjects(this.queryExecutor, targetSchema)
  }

  async listSchemas(): Promise<{ schemas: string[]; defaultSchema: string }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    return introspectMysqlSchemas(this.queryExecutor, this.profile.database || '')
  }

  async getObjectDdl(name: string, kind: SchemaObjectKind, schema?: string): Promise<string> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const targetSchema = schema || this.profile.database || ''
    if (kind === 'table') {
      return this.getDdl(name, targetSchema)
    }
    return introspectMysqlObjectDdl(this.queryExecutor, name, kind, targetSchema)
  }

  async exportSchemaDdl(schema?: string): Promise<{ ddl: string; objectCount: number }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const targetSchema = schema || this.profile.database || ''
    const objects = await this.listObjects(targetSchema)
    return collectAndAssembleSchemaDdl({
      dialect: this.driverType,
      schemaName: targetSchema,
      objects,
      getObjectDdl: (object) =>
        this.getObjectDdl(object.name, object.kind, object.schema || targetSchema),
    })
  }

  clearSchemaCache(): void {
    this.tableDetailsCache.clear()
  }

  async introspectErGraph(schema?: string): Promise<SchemaErGraph> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const targetSchema = (schema !== undefined ? schema : this.profile.database || '').trim()
    const hasFilter = targetSchema.length > 0
    const params = hasFilter ? [targetSchema] : []

    const tableRows = await this.queryExecutor(
      hasFilter
        ? `
          SELECT
            table_schema AS \`schema\`,
            table_name AS \`name\`,
            CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END AS \`kind\`
          FROM information_schema.TABLES
          WHERE table_schema = ?
            AND table_type IN ('BASE TABLE', 'VIEW')
          ORDER BY table_name ASC;
        `
        : `
          SELECT
            table_schema AS \`schema\`,
            table_name AS \`name\`,
            CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END AS \`kind\`
          FROM information_schema.TABLES
          WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
            AND table_type IN ('BASE TABLE', 'VIEW')
          ORDER BY table_schema ASC, table_name ASC;
        `,
      params
    )

    const colRows = await this.queryExecutor(
      hasFilter
        ? `
          SELECT
            table_schema AS \`schema\`,
            table_name AS \`table\`,
            column_name AS \`name\`,
            column_type AS \`type\`,
            (is_nullable = 'YES') AS \`nullable\`,
            (column_key = 'PRI') AS \`is_primary_key\`,
            (column_key = 'UNI') AS \`is_unique\`,
            ordinal_position AS \`ordinal_position\`
          FROM information_schema.COLUMNS
          WHERE table_schema = ?
          ORDER BY table_name ASC, ordinal_position ASC;
        `
        : `
          SELECT
            table_schema AS \`schema\`,
            table_name AS \`table\`,
            column_name AS \`name\`,
            column_type AS \`type\`,
            (is_nullable = 'YES') AS \`nullable\`,
            (column_key = 'PRI') AS \`is_primary_key\`,
            (column_key = 'UNI') AS \`is_unique\`,
            ordinal_position AS \`ordinal_position\`
          FROM information_schema.COLUMNS
          WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
          ORDER BY table_schema ASC, table_name ASC, ordinal_position ASC;
        `,
      params
    )

    const fkRows = await this.queryExecutor(
      hasFilter
        ? `
          SELECT
            kcu.constraint_name AS \`constraint_name\`,
            kcu.table_schema AS \`from_schema\`,
            kcu.table_name AS \`from_table\`,
            kcu.column_name AS \`from_column\`,
            kcu.referenced_table_schema AS \`to_schema\`,
            kcu.referenced_table_name AS \`to_table\`,
            kcu.referenced_column_name AS \`to_column\`,
            kcu.ordinal_position AS \`ordinal_position\`,
            rc.delete_rule AS \`on_delete\`,
            rc.update_rule AS \`on_update\`
          FROM information_schema.KEY_COLUMN_USAGE kcu
          LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
            ON rc.constraint_schema = kcu.table_schema
           AND rc.table_name = kcu.table_name
           AND rc.constraint_name = kcu.constraint_name
          WHERE kcu.table_schema = ?
            AND kcu.referenced_table_name IS NOT NULL
          ORDER BY kcu.constraint_name ASC, kcu.ordinal_position ASC;
        `
        : `
          SELECT
            kcu.constraint_name AS \`constraint_name\`,
            kcu.table_schema AS \`from_schema\`,
            kcu.table_name AS \`from_table\`,
            kcu.column_name AS \`from_column\`,
            kcu.referenced_table_schema AS \`to_schema\`,
            kcu.referenced_table_name AS \`to_table\`,
            kcu.referenced_column_name AS \`to_column\`,
            kcu.ordinal_position AS \`ordinal_position\`,
            rc.delete_rule AS \`on_delete\`,
            rc.update_rule AS \`on_update\`
          FROM information_schema.KEY_COLUMN_USAGE kcu
          LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
            ON rc.constraint_schema = kcu.table_schema
           AND rc.table_name = kcu.table_name
           AND rc.constraint_name = kcu.constraint_name
          WHERE kcu.table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
            AND kcu.referenced_table_name IS NOT NULL
          ORDER BY kcu.table_schema ASC, kcu.constraint_name ASC, kcu.ordinal_position ASC;
        `,
      params
    )

    const statRows = await this.queryExecutor(
      hasFilter
        ? `
          SELECT
            TABLE_SCHEMA AS \`schema\`,
            TABLE_NAME AS \`table\`,
            INDEX_NAME AS \`index_name\`,
            COLUMN_NAME AS \`column_name\`,
            SEQ_IN_INDEX AS \`seq_in_index\`
          FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ?
            AND NON_UNIQUE = 0
            AND INDEX_NAME <> 'PRIMARY'
          ORDER BY TABLE_NAME ASC, INDEX_NAME ASC, SEQ_IN_INDEX ASC;
        `
        : `
          SELECT
            TABLE_SCHEMA AS \`schema\`,
            TABLE_NAME AS \`table\`,
            INDEX_NAME AS \`index_name\`,
            COLUMN_NAME AS \`column_name\`,
            SEQ_IN_INDEX AS \`seq_in_index\`
          FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
            AND NON_UNIQUE = 0
            AND INDEX_NAME <> 'PRIMARY'
          ORDER BY TABLE_SCHEMA ASC, TABLE_NAME ASC, INDEX_NAME ASC, SEQ_IN_INDEX ASC;
        `,
      params
    )

    const uniqueIndexGroups = new Map<
      string,
      { schema: string; table: string; indexName: string; invalid: boolean; cols: Array<{ name: string; seq: number }> }
    >()
    for (const r of statRows) {
      const tblName = pickMysqlString(r, 'table', 'table_name')
      const idxName = pickMysqlString(r, 'index_name')
      if (!tblName || !idxName) continue
      const rowSchema = pickMysqlString(r, 'schema', 'table_schema') || targetSchema || 'default'
      const uKey = `${rowSchema}\u0000${tblName}\u0000${idxName}`
      let grp = uniqueIndexGroups.get(uKey)
      if (!grp) {
        grp = { schema: rowSchema, table: tblName, indexName: idxName, invalid: false, cols: [] }
        uniqueIndexGroups.set(uKey, grp)
      }
      const colName = pickMysqlString(r, 'column_name')
      if (!colName) {
        grp.invalid = true
        continue
      }
      const seqRaw = pickMysqlField(r, 'seq_in_index')
      const seq = typeof seqRaw === 'number' ? seqRaw : Number(seqRaw)
      if (!grp.cols.some((c) => c.name === colName)) {
        grp.cols.push({ name: colName, seq: Number.isFinite(seq) ? seq : grp.cols.length })
      }
    }
    const uniqueSets: RawErUniqueSetRow[] = Array.from(uniqueIndexGroups.values())
      .filter((grp) => !grp.invalid && grp.cols.length > 0)
      .map((grp) => ({
        schema: grp.schema,
        table: grp.table,
        indexName: grp.indexName,
        columns: grp.cols.sort((a, b) => a.seq - b.seq).map((c) => c.name),
      }))

    const tables: RawErTableRow[] = tableRows
      .map((r): RawErTableRow | null => {
        const name = pickMysqlString(r, 'name', 'table_name')
        if (!name) return null
        const rowSchema = pickMysqlString(r, 'schema', 'table_schema') || targetSchema || 'default'
        const rawKind = pickMysqlString(r, 'kind', 'table_type').toLowerCase()
        return {
          schema: rowSchema,
          name,
          kind: rawKind === 'view' ? 'view' : 'table',
        }
      })
      .filter((item): item is RawErTableRow => item !== null)

    const columns: RawErColumnRow[] = colRows
      .map((r): RawErColumnRow | null => {
        const table = pickMysqlString(r, 'table', 'table_name')
        const name = pickMysqlString(r, 'name', 'column_name')
        if (!table || !name) return null
        const rowSchema = pickMysqlString(r, 'schema', 'table_schema') || targetSchema || 'default'
        const ordRaw = pickMysqlField(r, 'ordinal_position')
        const ord = typeof ordRaw === 'number' ? ordRaw : Number(ordRaw)
        return {
          schema: rowSchema,
          table,
          name,
          type: pickMysqlString(r, 'type', 'column_type', 'data_type'),
          nullable: toSqlBool(pickMysqlField(r, 'nullable', 'is_nullable')),
          isPrimaryKey: toSqlBool(pickMysqlField(r, 'is_primary_key', 'column_key')),
          isUnique: toSqlBool(pickMysqlField(r, 'is_unique')),
          ...(Number.isFinite(ord) ? { ordinalPosition: ord } : {}),
        }
      })
      .filter((item): item is RawErColumnRow => item !== null)

    const foreignKeys: RawErForeignKeyRow[] = fkRows
      .map((r): RawErForeignKeyRow | null => {
        const fromTable = pickMysqlString(r, 'from_table', 'table_name')
        const fromColumn = pickMysqlString(r, 'from_column', 'column_name')
        const toTable = pickMysqlString(r, 'to_table', 'referenced_table_name')
        const toColumn = pickMysqlString(r, 'to_column', 'referenced_column_name')
        if (!fromTable || !fromColumn || !toTable || !toColumn) return null
        const fromSchema = pickMysqlString(r, 'from_schema', 'table_schema') || targetSchema || 'default'
        const toSchema = pickMysqlString(r, 'to_schema', 'referenced_table_schema') || fromSchema
        const ordRaw = pickMysqlField(r, 'ordinal_position')
        const ord = typeof ordRaw === 'number' ? ordRaw : Number(ordRaw)
        const onDelete = pickMysqlString(r, 'on_delete', 'delete_rule').toUpperCase()
        const onUpdate = pickMysqlString(r, 'on_update', 'update_rule').toUpperCase()
        const constraintName = pickMysqlString(r, 'constraint_name')
        return {
          ...(constraintName ? { constraintName } : {}),
          fromSchema,
          fromTable,
          fromColumn,
          toSchema,
          toTable,
          toColumn,
          ...(Number.isFinite(ord) ? { ordinalPosition: ord } : {}),
          ...(onDelete ? { onDelete } : {}),
          ...(onUpdate ? { onUpdate } : {}),
        }
      })
      .filter((item): item is RawErForeignKeyRow => item !== null)

    return buildSchemaErGraphFromCatalogRows({
      connectionId: this.profile.id,
      ...(targetSchema ? { schema: targetSchema } : {}),
      completeness: 'full',
      tables,
      columns,
      uniqueSets,
      foreignKeys,
    })
  }

  async runExplain(sql: string, signal?: AbortSignal): Promise<ExplainResult | null> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    if (signal?.aborted) {
      throw new DatabaseDriverError('Explain execution was cancelled', 'cancelled', this.driverType)
    }

    const sqlBody = sql.trim().replace(/;+\s*$/, '').trim()
    if (!sqlBody) {
      throw new DatabaseDriverError('SQL statement cannot be empty', 'invalid_params', this.driverType)
    }

    const leading = stripLeadingSqlComments(sqlBody, this.driverType).trim()
    const isAlreadyExplain = /^EXPLAIN\b/i.test(leading)
    const guardTarget = isAlreadyExplain ? sqlBody : `EXPLAIN ${sqlBody}`

    if (
      hasExplainAnalyzeOption(guardTarget, this.driverType) &&
      isExplainTargetMutating(guardTarget, this.driverType)
    ) {
      throw new DatabaseDriverError(
        'EXPLAIN ANALYZE is not permitted for mutating statements in Explain mode.',
        'not_permitted',
        this.driverType
      )
    }
    if (this.profile.readOnly && isMutatingStatement(guardTarget, this.driverType)) {
      throw new DatabaseDriverError(
        'Connection is Read-Only. Uncheck Read-Only in connection settings to modify data.',
        'read_only',
        this.driverType
      )
    }

    const candidates = isAlreadyExplain
      ? [sqlBody]
      : [`EXPLAIN FORMAT=JSON ${sqlBody}`, `EXPLAIN ${sqlBody}`]

    const runSingleCandidate = async (candidateSql: string): Promise<QueryResult> => {
      const queryId = `explain_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      const onAbort = (): void => {
        void this.cancelQuery(queryId).catch(() => {})
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const res = await this.runQuery(queryId, candidateSql, 1000)
        if (signal?.aborted) {
          throw new DatabaseDriverError('Explain execution was cancelled', 'cancelled', this.driverType)
        }
        return res
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    }

    let result: QueryResult
    try {
      result = await runSingleCandidate(candidates[0])
    } catch (err: unknown) {
      if (
        candidates.length < 2 ||
        this.isClosed ||
        signal?.aborted ||
        isFatalMysqlConnectionError(err) ||
        (err instanceof DatabaseDriverError &&
          (err.code === 'cancelled' || err.code === 'SESSION_CLOSED'))
      ) {
        throw err
      }
      result = await runSingleCandidate(candidates[1])
    }

    const rawText =
      result.columns.length <= 1 && result.rows.length > 0
        ? result.rows.map((r) => (r[0] !== null && r[0] !== undefined ? String(r[0]) : '')).join('\n')
        : undefined
    const explainPlan = parseExplainPlan(
      { columns: result.columns, rows: result.rows },
      { dialect: this.driverType }
    )

    return {
      columns: result.columns,
      rows: result.rows,
      ...(rawText !== undefined ? { rawText } : {}),
      ...(explainPlan.format ? { formatHint: explainPlan.format } : {}),
      executionTimeMs: result.executionTimeMs,
      explainPlan,
    }
  }

  async getTableDetails(table: string, schema?: string): Promise<TableDetails> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const defaultSchema = this.profile.database || ''
    const targetSchema = schema || defaultSchema
    const cached = this.tableDetailsCache.get(targetSchema, defaultSchema, table)
    if (cached) {
      return cached
    }
    const details = await introspectMysqlTableDetails(this.queryExecutor, table, targetSchema)
    this.tableDetailsCache.set(targetSchema, defaultSchema, table, details)
    return details
  }

  async fetchPage(params: FetchPageParams): Promise<TableBrowseResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const defaultSchema = this.profile.database || ''
    const targetSchema = params.schema || this.profile.database

    if (!params.bypassTransaction && (!this.autoCommit || this.txConn !== null)) {
      return this.runExclusiveTxOp(async () => {
        if (this.isClosed) {
          throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
        }
        if (!this.autoCommit && this.txConn === null) {
          await this.beginTransactionLocked()
        }
        const conn = this.txConn ?? (await this.acquireConnection())
        const isPinned = this.txConn === conn
        let failed = false
        try {
          const effectiveSchema = targetSchema || defaultSchema
          let details = this.tableDetailsCache.get(effectiveSchema, defaultSchema, params.table)
          if (!details) {
            const txExecutor = async (qSql: string, qParams?: unknown[]) => {
              const [rows] = await conn.query(qSql, qParams)
              return asRecordRows(rows)
            }
            details = await introspectMysqlTableDetails(txExecutor, params.table, effectiveSchema)
            this.tableDetailsCache.set(effectiveSchema, defaultSchema, params.table, details)
          }

          const { sql, countSql, params: queryParams } = buildSelectPageSql({
            driver: this.driverType,
            table: params.table,
            schema: targetSchema,
            page: params.page,
            pageSize: params.pageSize,
            sortColumn: params.sortColumn,
            sortDirection: params.sortDirection,
            primaryKey: details.primaryKey,
            whereClause: params.whereClause,
            orderByClause: params.orderByClause,
          })

          const [countRows] = await conn.query(countSql)
          const [dataRows, dataFields] = await conn.query(sql, queryParams)

          return assembleTableBrowseResult({
            tableDetails: details,
            rows: decodeMysqlRecordRows(asRecordRows(dataRows), dataFields),
            countRow: asRecordRows(countRows)[0] || { total: 0 },
            page: params.page,
            pageSize: params.pageSize,
          })
        } catch (err) {
          failed = true
          throw err
        } finally {
          if (!isPinned) {
            this.safeReleaseConn(conn, failed)
          }
        }
      })
    }

    const details = await this.getTableDetails(params.table, targetSchema)

    const { sql, countSql, params: queryParams } = buildSelectPageSql({
      driver: this.driverType,
      table: params.table,
      schema: targetSchema,
      page: params.page,
      pageSize: params.pageSize,
      sortColumn: params.sortColumn,
      sortDirection: params.sortDirection,
      primaryKey: details.primaryKey,
      whereClause: params.whereClause,
      orderByClause: params.orderByClause,
    })

    const [countRows] = await this.poolQuery(countSql)
    const [dataRows, dataFields] = await this.poolQuery(sql, queryParams)

    return assembleTableBrowseResult({
      tableDetails: details,
      rows: decodeMysqlRecordRows(asRecordRows(dataRows), dataFields),
      countRow: asRecordRows(countRows)[0] || { total: 0 },
      page: params.page,
      pageSize: params.pageSize,
    })
  }

  async updateCell(params: UpdateCellParams): Promise<UpdateCellResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const defaultSchema = this.profile.database || ''
    const targetSchema = params.schema || this.profile.database
    const originalColumnType = this.tableDetailsCache.findColumnType(
      targetSchema || defaultSchema,
      defaultSchema,
      params.table,
      params.column,
      params.columnType
    )
    const { sql, params: updateParams } = buildUpdateSql({
      driver: this.driverType,
      table: params.table,
      schema: targetSchema,
      column: params.column,
      newValue: params.newValue,
      primaryKeys: params.primaryKeys,
      originalValue: params.originalValue,
      originalColumnType,
    })

    const reloadQuery = buildSelectByPrimaryKeySql({
      driver: this.driverType,
      table: params.table,
      schema: targetSchema,
      primaryKeys: params.primaryKeys,
      editedColumn: params.column,
      newValue: params.newValue,
    })
    const selectSql = reloadQuery ? `${reloadQuery.sql} LIMIT 1;` : null
    const pkValues = reloadQuery?.params ?? []

    const pinnedResult = await this.runExclusiveTxOp(async (): Promise<UpdateCellResult | null> => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
      }
      if (!this.autoCommit && this.txConn === null) {
        await this.beginTransactionLocked()
      }
      if (this.txConn === null) {
        return null
      }
      const conn = this.txConn
      const [res] = await conn.query(sql, updateParams)
      const affectedRows = extractAffectedRows(res, 0)
      if (affectedRows === 0) {
        throw new DatabaseDriverError(
          'Record was modified or deleted by another session (optimistic lock conflict)',
          'conflict',
          this.driverType
        )
      }
      this.statementCount++
      let updatedRecord: Record<string, unknown> | undefined
      if (selectSql) {
        const [selRows, selFields] = await conn.query(selectSql, pkValues)
        updatedRecord = decodeMysqlRecordRows(asRecordRows(selRows), selFields)[0]
      }
      this.tableDetailsCache.clear()
      return {
        ok: true,
        affectedRows,
        updatedRecord,
      }
    })
    if (pinnedResult !== null) {
      return pinnedResult
    }

    const [res] = await this.poolQuery(sql, updateParams)
    const affectedRows = extractAffectedRows(res, 0)

    if (affectedRows === 0) {
      throw new DatabaseDriverError(
        'Record was modified or deleted by another session (optimistic lock conflict)',
        'conflict',
        this.driverType
      )
    }

    let updatedRecord: Record<string, unknown> | undefined
    if (selectSql) {
      const [selRows, selFields] = await this.poolQuery(selectSql, pkValues)
      updatedRecord = decodeMysqlRecordRows(asRecordRows(selRows), selFields)[0]
    }

    this.tableDetailsCache.clear()

    return {
      ok: true,
      affectedRows,
      updatedRecord,
    }
  }

  async previewChanges(params: ApplyChangesParams): Promise<PreviewChangesResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const targetSchema = params.schema || this.profile.database
    const batch = buildBatchStatements({
      driver: this.driverType,
      table: params.table,
      schema: targetSchema,
      inserts: params.inserts,
      updates: params.updates,
      deletes: params.deletes,
      columnTypes: this.tableDetailsCache.resolveColumnTypes(
        targetSchema,
        this.profile.database || '',
        params.table,
        params.columnTypes
      ),
    })
    return { statements: batch.previewStatements }
  }

  async applyChanges(params: ApplyChangesParams): Promise<ApplyChangesResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const targetSchema = params.schema || this.profile.database
    const batch = buildBatchStatements({
      driver: this.driverType,
      table: params.table,
      schema: targetSchema,
      inserts: params.inserts,
      updates: params.updates,
      deletes: params.deletes,
      columnTypes: this.tableDetailsCache.resolveColumnTypes(
        targetSchema,
        this.profile.database || '',
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
      if (!this.autoCommit && this.txConn === null) {
        await this.beginTransactionLocked()
      }
      if (this.txConn === null) {
        return null
      }
      const conn = this.txConn
      await conn.query('SAVEPOINT datanoa_apply_changes;')
      try {
        let deleted = 0
        for (const stmt of batch.deletes) {
          const [res] = await conn.query(stmt.sql, stmt.params)
          const count = extractAffectedRows(res, 0)
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
          const [res] = await conn.query(stmt.sql, stmt.params)
          const count = extractAffectedRows(res, 0)
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
          const [res] = await conn.query(stmt.sql, stmt.params)
          inserted += extractAffectedRows(res, stmt.rowCount)
        }

        await conn.query('RELEASE SAVEPOINT datanoa_apply_changes;')
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
        try {
          await conn.query('ROLLBACK TO SAVEPOINT datanoa_apply_changes;')
        } catch {
          // Ignore savepoint rollback error
        }
        throw err
      }
    })
    if (pinnedResult !== null) {
      return pinnedResult
    }

    const conn = await this.acquireConnection()
    let shouldDestroy = false
    try {
      await conn.beginTransaction()
      let deleted = 0
      for (const stmt of batch.deletes) {
        const [res] = await conn.query(stmt.sql, stmt.params)
        const count = extractAffectedRows(res, 0)
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
        const [res] = await conn.query(stmt.sql, stmt.params)
        const count = extractAffectedRows(res, 0)
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
        const [res] = await conn.query(stmt.sql, stmt.params)
        inserted += extractAffectedRows(res, stmt.rowCount)
      }

      await conn.commit()
      this.tableDetailsCache.clear()
      return {
        ok: true,
        inserted,
        updated,
        deleted,
        statements: batch.previewStatements,
      }
    } catch (err) {
      shouldDestroy = true
      await conn.rollback().catch(() => {})
      throw err
    } finally {
      if (shouldDestroy && typeof conn.destroy === 'function') {
        conn.destroy()
      } else {
        conn.release()
      }
    }
  }

  async getDdl(table: string, schema?: string): Promise<string> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const targetSchema = schema || this.profile.database
    const qTable = quoteQualifiedTable(table, targetSchema, this.driverType)

    try {
      const [rows] = await this.poolQuery(`SHOW CREATE TABLE ${qTable};`)
      const row = asRecordRows(rows)[0]
      if (row) {
        const rawCreate =
          row['Create Table'] ??
          row['Create View'] ??
          row['create table'] ??
          row['create view']
        if (typeof rawCreate === 'string' && rawCreate.trim().length > 0) {
          const trimmed = rawCreate.trim()
          return trimmed.endsWith(';') ? trimmed : `${trimmed};`
        }
      }
    } catch {
      // Fallback to metadata-based DDL reconstruction
    }

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
    const needsTxLock = !this.autoCommit || this.txConn !== null || startsManualTx

    const executeRun = async (): Promise<QueryResult> => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
      }
      if (!this.autoCommit && this.txConn === null) {
        await this.beginTransactionLocked()
      }

      const conn = this.txConn ?? (await this.acquireConnection())
      if (this.isClosed) {
        this.safeReleaseConn(conn, true)
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
      }
      const startTime = performance.now()

      const activeEntry: ActiveMysqlQuery = {
        conn,
        threadId: typeof conn.threadId === 'number' ? conn.threadId : 0,
        startTime,
        cancelled: false,
        released: false,
      }
      this.activeQueries.set(queryId, activeEntry)

      let shouldDestroy = false
      let txEndedInRun = false
      let lastServerStatus: number | undefined
      let currentExecIndex = -1
      try {
        let totalAffectedRows = 0
        let lastSelect: Omit<QueryResult, 'executionTimeMs'> | null = null
        const collectedSets: QueryResultSet[] = []

        for (let execIndex = 0; execIndex < execList.length; execIndex++) {
          const stmtSql = execList[execIndex]
          if (activeEntry.cancelled || this.isClosed) {
            shouldDestroy = true
            throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', this.driverType)
          }
          const trimmedStmt = stmtSql.trim()
          const stmtStart = performance.now()
          const normalizedStmt = stripLeadingSqlComments(trimmedStmt, this.driverType).trim()
          const isStandaloneBegin = /^(?:BEGIN|START\s+TRANSACTION)\b/i.test(normalizedStmt)

          // If an earlier statement in this script ended the TX (e.g. DDL implicit commit) while in Manual TX mode,
          // start a fresh transaction before running subsequent statements so DML never silently auto-commits.
          if (txEndedInRun && !this.autoCommit && this.txConn === null && !isStandaloneBegin) {
            await conn.beginTransaction()
            this.txConn = conn
            this.statementCount = 0
            this.txStartedAt = Date.now()
            txEndedInRun = false
          }

          if (isStandaloneBegin && this.txConn === null) {
            this.txConn = conn
            this.statementCount = 0
            this.txStartedAt = Date.now()
            txEndedInRun = false
          }

          currentExecIndex = execIndex
          const rawUnderlyingConn = (
            conn as unknown as {
              connection?: {
                query?: (
                  opts: { sql: string; rowsAsArray: boolean }
                ) => {
                  on?: (event: string, cb: (...args: unknown[]) => void) => unknown
                  stream?: () => NodeJS.ReadableStream & { destroy?: () => void }
                }
              }
            }
          ).connection
          const canStreamSingleSelect =
            maxRows > 0 &&
            execList.length === 1 &&
            /^(?:SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|TABLE)\b/i.test(normalizedStmt) &&
            typeof rawUnderlyingConn?.query === 'function'

          let rows: unknown
          let fields: unknown
          if (canStreamSingleSelect && rawUnderlyingConn && typeof rawUnderlyingConn.query === 'function') {
            const rawQueryFn = rawUnderlyingConn.query.bind(rawUnderlyingConn)
            const streamed = await new Promise<[unknown[], unknown[]] | null>((resolve, reject) => {
              let queryObj: {
                on?: (event: string, cb: (...args: unknown[]) => void) => unknown
                stream?: () => NodeJS.ReadableStream & { destroy?: () => void }
              }
              try {
                queryObj = rawQueryFn({ sql: stmtSql, rowsAsArray: true })
              } catch {
                resolve(null)
                return
              }
              if (!queryObj || typeof queryObj.on !== 'function' || typeof queryObj.stream !== 'function') {
                resolve(null)
                return
              }
              let capturedFields: unknown[] = []
              const collected: unknown[] = []
              let settled = false
              const finish = (err?: unknown): void => {
                if (settled) return
                settled = true
                if (err) reject(err)
                else resolve([collected, capturedFields])
              }
              queryObj.on('fields', (f: unknown) => {
                if (Array.isArray(f)) capturedFields = f
              })
              const isPinnedTx = this.txConn === conn
              const rowStream = queryObj.stream()
              rowStream.on('data', (row: unknown) => {
                if (collected.length <= maxRows) {
                  collected.push(row)
                }
                if (collected.length > maxRows && !isPinnedTx) {
                  shouldDestroy = true
                  if (typeof rowStream.destroy === 'function') {
                    rowStream.destroy()
                  }
                  finish()
                }
              })
              rowStream.on('error', (err: unknown) => {
                if (collected.length > maxRows && !isPinnedTx) finish()
                else finish(err)
              })
              rowStream.on('end', () => finish())
              rowStream.on('close', () => finish())
            })
            if (streamed !== null) {
              ;[rows, fields] = streamed
            } else {
              ;[rows, fields] = await conn.query({ sql: stmtSql, rowsAsArray: true })
            }
          } else {
            ;[rows, fields] = await conn.query({ sql: stmtSql, rowsAsArray: true })
          }
          const serverStatus = extractServerStatus(rows)
          if (serverStatus !== undefined) {
            lastServerStatus = serverStatus
          }
          if (this.isClosed && this.txConn !== conn) {
            shouldDestroy = true
            throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
          }
          const parsed = parseMysqlQueryResult(rows, fields, maxRows)
          const stmtDurationMs = Math.round(performance.now() - stmtStart)
          if (parsed.isSelect) {
            lastSelect = parsed.result
            collectedSets.push({
              index: execIndex,
              sqlPreview: compactSql(trimmedStmt),
              sql: trimmedStmt,
              executionTimeMs: stmtDurationMs,
              columns: parsed.result.columns,
              rows: parsed.result.rows,
              rowCount: parsed.result.rowCount,
              truncated: parsed.result.truncated,
              isSelect: true,
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

          if (this.txConn === conn) {
            if (!isStandaloneBegin) {
              this.statementCount++
            }
            const isCommit = /^COMMIT\b/i.test(normalizedStmt)
            const isRollback = SQL_STANDALONE_ROLLBACK_RE.test(normalizedStmt)
            const isAndChain = /\bAND\s+CHAIN\b/i.test(normalizedStmt)
            if (isCommit || isRollback) {
              const stillInTx =
                serverStatus !== undefined
                  ? (serverStatus & MYSQL_SERVER_STATUS_IN_TRANS) !== 0
                  : isAndChain
              if (stillInTx) {
                this.statementCount = 0
                this.txStartedAt = Date.now()
              } else {
                // Defer release until execList completes so trailing statements still run safely
                this.clearPinnedTxConn()
                txEndedInRun = true
              }
            } else if (!isStandaloneBegin) {
              const endedImplicitly =
                (serverStatus !== undefined && (serverStatus & MYSQL_SERVER_STATUS_IN_TRANS) === 0) ||
                (serverStatus === undefined && isMysqlImplicitCommitStatement(normalizedStmt))
              if (endedImplicitly) {
                this.clearPinnedTxConn()
                txEndedInRun = true
              }
            }
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
        const fatal = activeEntry.cancelled || isFatalMysqlConnectionError(err)
        if (fatal) {
          shouldDestroy = true
          if (this.txConn === conn) {
            this.clearPinnedTxConn()
          }
        }
        if (
          currentExecIndex >= 0 &&
          !activeEntry.cancelled &&
          !this.isClosed &&
          (err instanceof Error || execList.length > 1) &&
          !(err instanceof DatabaseDriverError && (err.code === 'cancelled' || err.code === 'SESSION_CLOSED'))
        ) {
          throw attachFailedStatementMeta(err, currentExecIndex, execList.length)
        }
        throw err
      } finally {
        if (containsDdlStatement(sql, this.driverType)) {
          this.tableDetailsCache.clear()
        }
        this.activeQueries.delete(queryId)

        const currentlyPinned = this.txConn === conn
        if (currentlyPinned) {
          if (shouldDestroy || activeEntry.cancelled) {
            this.clearPinnedTxConn()
            activeEntry.released = true
            this.safeReleaseConn(conn, true)
          }
        } else if (!activeEntry.released) {
          const dirtyTxState =
            lastServerStatus !== undefined &&
            ((lastServerStatus & MYSQL_SERVER_STATUS_IN_TRANS) !== 0 ||
              (lastServerStatus & MYSQL_SERVER_STATUS_AUTOCOMMIT) === 0)
          activeEntry.released = true
          this.safeReleaseConn(conn, shouldDestroy || activeEntry.cancelled || dirtyTxState)
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
    const ok = await this.sendKillQuery(active.threadId)
    return { ok }
  }

  getTransactionState(): TransactionState {
    return {
      active: this.txConn !== null,
      autoCommit: this.autoCommit,
      statementCount: this.statementCount,
      startedAt: this.txStartedAt,
      supported: true,
    }
  }

  async setAutoCommit(enabled: boolean): Promise<TransactionState> {
    return this.runExclusiveTxOp(async () => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
      }
      if (enabled) {
        if (this.txConn !== null) {
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
    if (this.txConn !== null) {
      throw new DatabaseDriverError('Transaction is already active', 'TX_ALREADY_ACTIVE', this.driverType)
    }
    const conn = await this.acquireConnection()
    if (this.isClosed) {
      this.safeReleaseConn(conn, true)
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    try {
      await conn.beginTransaction()
      if (this.isClosed) {
        this.safeReleaseConn(conn, true)
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
      }
      this.txConn = conn
      this.statementCount = 0
      this.txStartedAt = Date.now()
      return this.getTransactionState()
    } catch (err) {
      this.safeReleaseConn(conn, true)
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
      if (this.txConn === null) {
        throw new DatabaseDriverError('Cannot commit: no active transaction', 'NO_ACTIVE_TX', this.driverType)
      }
      const conn = this.txConn
      this.clearPinnedTxConn()
      try {
        await conn.commit()
        this.safeReleaseConn(conn, false)
        return this.getTransactionState()
      } catch (err) {
        this.safeReleaseConn(conn, true)
        throw err
      }
    })
  }

  async rollbackTransaction(): Promise<TransactionState> {
    return this.runExclusiveTxOp(async () => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
      }
      if (this.txConn === null) {
        throw new DatabaseDriverError('Cannot rollback: no active transaction', 'NO_ACTIVE_TX', this.driverType)
      }
      const conn = this.txConn
      this.clearPinnedTxConn()
      try {
        await conn.rollback()
        this.safeReleaseConn(conn, false)
        return this.getTransactionState()
      } catch (err) {
        this.safeReleaseConn(conn, true)
        throw err
      }
    })
  }
}

/** Narrow node TLS PEM values (always read as strings here) to mysql2's SslOptions shape */
function toMysqlPem(value: unknown): string | string[] | Buffer | Buffer[] | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' || Buffer.isBuffer(value)) return value
  const items = Array.isArray(value) ? value : [value]
  const strings: string[] = []
  const buffers: Buffer[] = []
  for (const item of items) {
    if (typeof item === 'string') strings.push(item)
    else if (Buffer.isBuffer(item)) buffers.push(item)
  }
  if (strings.length === items.length) return strings
  if (buffers.length === items.length) return buffers
  return strings.length > 0 ? strings[0] : buffers[0]
}

export class MysqlDriver implements IDatabaseDriver {
  readonly type: MysqlEngineType

  constructor(type: MysqlEngineType = 'mysql') {
    this.type = type
  }

  async createSession(
    profile: ConnectionProfile,
    password?: string,
    extraSecrets?: DriverTlsOptions
  ): Promise<IDatabaseSession> {
    const effectiveDriver: MysqlEngineType =
      profile.driver === 'mariadb' ? 'mariadb' : this.type
    const tunnelHost = (profile.host || 'localhost').trim()
    const tunnelPort = profile.port || 3306
    const remoteServername =
      typeof extraSecrets?.tlsServername === 'string' ? extraSecrets.tlsServername.trim() : ''
    const useTunnelStream = remoteServername.length > 0 && remoteServername !== tunnelHost
    const effectiveHost = useTunnelStream ? remoteServername : tunnelHost
    const tunnelStreamFactory = useTunnelStream
      ? (): net.Socket => net.connect({ host: tunnelHost, port: tunnelPort })
      : (): net.Socket => {
          const sock = net.connect({
            host: tunnelHost,
            port: tunnelPort,
            autoSelectFamily: true,
            autoSelectFamilyAttemptTimeout: 250,
          })
          sock.setNoDelay(true)
          return sock
        }
    const tlsOverride = await resolveEffectiveTlsOptions(
      profile,
      extraSecrets,
      extraSecrets?.tlsServername
    )
    let sslConfig: ConnectionOptions['ssl']
    let defaultUseSsl = false
    if (tlsOverride === false) {
      // Explicit sslMode: 'disable' — never fall back to auto-SSL
      sslConfig = undefined
    } else if (tlsOverride) {
      // mysql2's SslOptions omits node:tls identity hooks; keep them for verify-full
      const sslOptions: Exclude<ConnectionOptions['ssl'], string> & {
        servername?: string
        checkServerIdentity?: typeof tls.checkServerIdentity
      } = {
        ca: toMysqlPem(tlsOverride.ca),
        cert: toMysqlPem(tlsOverride.cert),
        key: toMysqlPem(tlsOverride.key),
        passphrase: tlsOverride.passphrase,
        rejectUnauthorized: tlsOverride.rejectUnauthorized,
        servername: tlsOverride.servername,
        checkServerIdentity: tlsOverride.checkServerIdentity,
        // mysql2 derives SNI & checkServerIdentity strictly from config.host; keeping config.host
        // as the real remote hostname (with a tunnel stream factory) enforces verify-full over SSH.
        verifyIdentity:
          profile.sslMode === 'verify-full' ||
          (profile.sslMode === 'require' && tlsOverride.rejectUnauthorized === true) ||
          ((profile.sslMode === undefined || profile.sslMode === 'auto') &&
            tlsOverride.rejectUnauthorized !== false),
      }
      sslConfig = sslOptions
    } else {
      defaultUseSsl =
        profile.ssl !== undefined ? Boolean(profile.ssl) : isCloudDatabaseHost(effectiveHost)
      sslConfig = defaultUseSsl
        ? ({
            ...buildDefaultTlsOptions(extraSecrets?.tlsServername),
            verifyIdentity: true,
          } as ConnectionOptions['ssl'])
        : undefined
    }
    const cancelConnOptions = {
      host: effectiveHost,
      port: tunnelPort,
      database: profile.database || undefined,
      user: profile.user,
      password,
      connectTimeout: 5000,
      ssl: sslConfig,
      stream: tunnelStreamFactory,
    } as ConnectionOptions

    const options = {
      host: effectiveHost,
      port: tunnelPort,
      database: profile.database || undefined,
      user: profile.user,
      password,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      connectTimeout: 10000,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      flags: ['+FOUND_ROWS'],
      ssl: sslConfig,
      stream: tunnelStreamFactory,
    } as PoolOptions

    const verifyIpIdentity =
      (profile.sslMode === 'verify-full' ||
        (profile.sslMode === 'require' &&
          tlsOverride !== undefined &&
          tlsOverride !== false &&
          tlsOverride.rejectUnauthorized === true) ||
        ((profile.sslMode === undefined || profile.sslMode === 'auto') &&
          ((tlsOverride !== undefined &&
            tlsOverride !== false &&
            tlsOverride.rejectUnauthorized !== false) ||
            (tlsOverride === undefined && defaultUseSsl)))) &&
      net.isIP(effectiveHost) !== 0
        ? effectiveHost
        : undefined
    const { mysqlPromise } = await loadMysqlVendor()
    const pool = mysqlPromise.createPool(options) as unknown as MysqlPoolLike
    return new MysqlSession(
      pool,
      { ...profile, driver: effectiveDriver },
      cancelConnOptions,
      verifyIpIdentity
    )
  }

  async testConnection(
    profile: ConnectionProfile,
    password?: string,
    extraSecrets?: DriverTlsOptions
  ): Promise<{ ok: boolean; message?: string }> {
    return runDriverConnectionTest(
      () => this.createSession(profile, password, extraSecrets),
      (err) => extractMysqlErrorMessage(err, 'Connection failed')
    )
  }
}
