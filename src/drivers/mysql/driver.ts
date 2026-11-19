import mysql, {
  mysqlPromise,
  type ConnectionOptions,
  type PoolOptions,
} from '../../../vendor/mysql2.js'
import { isCloudDatabaseHost } from '../common/connection-uri'
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
  quoteIdentifier,
  quoteQualifiedTable,
} from '../common/update-builder'
import {
  TableDetailsCache,
  introspectMysqlObjects,
  introspectMysqlTableDetails,
} from '../common/schema'
import {
  containsDdlStatement,
  reconstructTableDdl,
  splitSqlStatements,
} from '../common/sql-tools'

interface MysqlResultHeaderLike {
  affectedRows?: number
  insertId?: number
}

interface MysqlQueryObject {
  sql: string
  rowsAsArray?: boolean
}

export interface MysqlConnectionLike {
  threadId?: number
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

function resolveMysqlColumnTypeName(columnType: number | undefined): string {
  const typeMap = (mysql as unknown as { Types?: Record<number, string> })?.Types
  if (typeMap && columnType !== undefined && typeMap[columnType]) {
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

  const columns = (fields as MysqlFieldPacketLike[]).map((f) => ({
    name: f.name,
    type: resolveMysqlColumnTypeName(f.columnType),
  }))

  const rawRows = Array.isArray(rows) ? (rows as Array<unknown[] | Record<string, unknown>>) : []
  const limit = maxRows > 0 ? maxRows : rawRows.length
  const truncated = rawRows.length > limit
  const slicedRows = rawRows.slice(0, limit)

  // Supports native rowsAsArray: true AND object-row mocks
  const resultRows: unknown[][] = slicedRows.map((r) =>
    Array.isArray(r) ? r : columns.map((c) => r[c.name])
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
  private readonly activeQueries = new Map<string, ActiveMysqlQuery>()
  private readonly tableDetailsCache = new TableDetailsCache()
  private isClosed = false

  constructor(
    pool: MysqlPoolLike,
    profile: ConnectionProfile,
    cancelConnOptions?: ConnectionOptions
  ) {
    this.pool = pool
    this.profile = profile
    this.cancelConnOptions = cancelConnOptions
    this.driverType = profile.driver === 'mariadb' ? 'mariadb' : 'mysql'
  }

  isAlive(): boolean {
    return !this.isClosed
  }

  private readonly queryExecutor = async (
    sql: string,
    params?: unknown[]
  ): Promise<Record<string, unknown>[]> => {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const [rows] = await this.pool.query(sql, params)
    return asRecordRows(rows)
  }

  private async sendKillQuery(threadId: number): Promise<boolean> {
    if (!Number.isInteger(threadId) || threadId <= 0) {
      return false
    }
    if (this.cancelConnOptions) {
      let killConn: MysqlConnectionLike | null = null
      try {
        killConn = (await mysqlPromise.createConnection({
          ...this.cancelConnOptions,
          connectTimeout: 5000,
        })) as unknown as MysqlConnectionLike
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
      await this.pool.query(`KILL QUERY ${threadId};`)
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
      const conn = await this.pool.getConnection()
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

    const activeEntries = Array.from(this.activeQueries.values())
    this.activeQueries.clear()
    for (const active of activeEntries) {
      active.cancelled = true
      if (Number.isInteger(active.threadId) && active.threadId > 0 && this.cancelConnOptions) {
        void this.sendKillQuery(active.threadId).catch(() => {})
      }
      if (!active.released) {
        active.released = true
        try {
          if (typeof active.conn.destroy === 'function') {
            active.conn.destroy()
          } else {
            active.conn.release()
          }
        } catch {
          // Ignore errors on already-closed connections
        }
      }
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
    const targetSchema = params.schema || this.profile.database
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

    const [countRows] = await this.pool.query(countSql)
    const [dataRows] = await this.pool.query(sql, queryParams)

    return assembleTableBrowseResult({
      tableDetails: details,
      rows: asRecordRows(dataRows),
      countRow: asRecordRows(countRows)[0] || { total: 0 },
      page: params.page,
      pageSize: params.pageSize,
    })
  }

  async updateCell(params: UpdateCellParams): Promise<UpdateCellResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', this.driverType)
    }
    const targetSchema = params.schema || this.profile.database
    const { sql, params: updateParams } = buildUpdateSql({
      driver: this.driverType,
      table: params.table,
      schema: targetSchema,
      column: params.column,
      newValue: params.newValue,
      primaryKeys: params.primaryKeys,
      originalValue: params.originalValue,
    })

    const [res] = await this.pool.query(sql, updateParams)
    const affectedRows = extractAffectedRows(res, 0)

    if (affectedRows === 0) {
      throw new DatabaseDriverError(
        'Record was modified or deleted by another session (optimistic lock conflict)',
        'conflict',
        this.driverType
      )
    }

    const whereParts: string[] = []
    const pkValues: unknown[] = []
    for (const [pkCol, rawPkVal] of Object.entries(params.primaryKeys)) {
      const effectivePkVal = pkCol === params.column ? params.newValue : rawPkVal
      if (effectivePkVal === null || effectivePkVal === undefined) {
        whereParts.push(`${quoteIdentifier(this.driverType, pkCol)} IS NULL`)
      } else {
        whereParts.push(`${quoteIdentifier(this.driverType, pkCol)} = ?`)
        pkValues.push(effectivePkVal)
      }
    }

    let updatedRecord: Record<string, unknown> | undefined
    if (whereParts.length > 0) {
      const selectSql = `SELECT * FROM ${quoteQualifiedTable(params.table, targetSchema, this.driverType)} WHERE ${whereParts.join(' AND ')} LIMIT 1;`
      const [selRows] = await this.pool.query(selectSql, pkValues)
      updatedRecord = asRecordRows(selRows)[0]
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
    })
    if (batch.all.length === 0) {
      return { ok: true, inserted: 0, updated: 0, deleted: 0, statements: [] }
    }

    const conn = await this.pool.getConnection()
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
      for (const stmt of batch.inserts) {
        const [res] = await conn.query(stmt.sql, stmt.params)
        inserted += extractAffectedRows(res, 1)
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
      const [rows] = await this.pool.query(`SHOW CREATE TABLE ${qTable};`)
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
    const conn = await this.pool.getConnection()
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
    try {
      const stmts = splitSqlStatements(sql, this.driverType).map((s) => s.text)
      let totalAffectedRows = 0
      let lastSelect: Omit<QueryResult, 'executionTimeMs'> | null = null

      const execList = stmts.length <= 1 ? [sql] : stmts
      for (const stmtSql of execList) {
        if (activeEntry.cancelled || this.isClosed) {
          shouldDestroy = true
          throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', this.driverType)
        }
        const [rows, fields] = await conn.query({ sql: stmtSql, rowsAsArray: true })
        const parsed = parseMysqlQueryResult(rows, fields, maxRows)
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
      shouldDestroy = true
      throw err
    } finally {
      if (containsDdlStatement(sql, this.driverType)) {
        this.tableDetailsCache.clear()
      }
      this.activeQueries.delete(queryId)
      if (!activeEntry.released) {
        activeEntry.released = true
        if ((shouldDestroy || activeEntry.cancelled) && typeof conn.destroy === 'function') {
          conn.destroy()
        } else {
          conn.release()
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
    const ok = await this.sendKillQuery(active.threadId)
    return { ok }
  }
}

export class MysqlDriver implements IDatabaseDriver {
  readonly type: MysqlEngineType

  constructor(type: MysqlEngineType = 'mysql') {
    this.type = type
  }

  async createSession(profile: ConnectionProfile, password?: string): Promise<IDatabaseSession> {
    const effectiveDriver: MysqlEngineType =
      profile.driver === 'mariadb' ? 'mariadb' : this.type
    const host = (profile.host || 'localhost').trim()
    const useSsl =
      profile.ssl !== undefined ? Boolean(profile.ssl) : isCloudDatabaseHost(host)

    const sslConfig = useSsl ? { rejectUnauthorized: false } : undefined
    const cancelConnOptions: ConnectionOptions = {
      host,
      port: profile.port || 3306,
      database: profile.database || undefined,
      user: profile.user,
      password,
      connectTimeout: 5000,
      ssl: sslConfig,
    }

    const options: PoolOptions = {
      host,
      port: profile.port || 3306,
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
    }

    const pool = mysqlPromise.createPool(options) as unknown as MysqlPoolLike
    return new MysqlSession(pool, { ...profile, driver: effectiveDriver }, cancelConnOptions)
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
      return { ok: false, message: extractMysqlErrorMessage(err, 'Connection failed') }
    } finally {
      if (session) {
        await session.close().catch(() => {})
      }
    }
  }
}
