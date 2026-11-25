import * as net from 'node:net'
import type { ISqlType, config as MssqlConfig } from '../../../vendor/mssql.js'
import { isCloudDatabaseHost } from '../common/connection-uri'
import { isMssqlReadOnlyBlocked, splitMssqlBatches } from '../common/mssql-sql'
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
  areChunksAlignedWithSqlSlices,
  attachFailedStatementMeta,
  copyFailedStatementMeta,
  runDriverConnectionTest,
} from '../common/driver'
import type { DriverTlsOptions } from '../common/tls-and-tunnel'
import { resolveEffectiveTlsOptions } from '../common/tls-and-tunnel'
import {
  assembleTableBrowseResult,
  buildBatchStatements,
  buildSelectByPrimaryKeySql,
  buildSelectPageSql,
  buildUpdateSql,
  projectDeleteRowsToPrimaryKeys,
} from '../common/update-builder'
import { scrubDriverErrorText } from '../common/sql-credentials'
import {
  TableDetailsCache,
  collectAndAssembleSchemaDdl,
  introspectMssqlObjectDdl,
  introspectMssqlObjects,
  introspectMssqlSchemas,
  introspectMssqlTableDetails,
} from '../common/schema'
import {
  compactSql,
  containsDdlStatement,
  reconstructTableDdl,
  splitSqlStatements,
  stripLeadingSqlComments,
} from '../common/sql-tools'

export { isMssqlReadOnlyBlocked, splitMssqlBatches }

type MssqlVendorModule = typeof import('../../../vendor/mssql.js')
let mssqlVendorPromise: Promise<MssqlVendorModule> | null = null
let cachedMssqlTypes: MssqlVendorModule['TYPES'] | null = null

async function loadMssqlVendor(): Promise<MssqlVendorModule> {
  if (!mssqlVendorPromise) {
    mssqlVendorPromise = import('../../../vendor/mssql.js')
      .then((mod) => {
        cachedMssqlTypes = mod.TYPES
        return mod
      })
      .catch((err: unknown) => {
        mssqlVendorPromise = null
        throw err
      })
  }
  return mssqlVendorPromise
}

export interface MssqlColumnMetaLike {
  index?: number
  name: string
  type?: unknown
}

export interface MssqlRecordsetLike extends Array<unknown> {
  columns?: MssqlColumnMetaLike[] | Record<string, MssqlColumnMetaLike>
}

export interface MssqlQueryResultLike {
  recordset?: MssqlRecordsetLike | unknown[]
  recordsets?: Array<MssqlRecordsetLike | unknown[]>
  rowsAffected?: number[]
}

export interface MssqlRequestLike {
  arrayRowMode?: boolean
  input(name: string, typeOrVal: unknown, maybeVal?: unknown): MssqlRequestLike
  query(command: string): Promise<MssqlQueryResultLike>
  cancel(): void
}

export interface MssqlTransactionLike {
  begin(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  request(): MssqlRequestLike
}

export interface MssqlPoolLike {
  readonly connected?: boolean
  on?(event: string, listener: (err: Error) => void): void
  listenerCount?(event: string): number
  connect(): Promise<unknown>
  close(): Promise<void>
  request(): MssqlRequestLike
  transaction(): MssqlTransactionLike
}

interface ActiveMssqlQuery {
  request: MssqlRequestLike
  cancelled: boolean
}

function extractMssqlErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) {
    return scrubDriverErrorText(err.message) || fallback
  }
  if (typeof err === 'string' && err) {
    return scrubDriverErrorText(err) || fallback
  }
  if (err && typeof err === 'object' && 'message' in err) {
    const val = Reflect.get(err, 'message')
    if (typeof val === 'string' && val) {
      return scrubDriverErrorText(val) || fallback
    }
  }
  return fallback
}

function scrubMssqlError(err: unknown): unknown {
  if (err instanceof Error && err.message) {
    const clean = scrubDriverErrorText(err.message)
    if (clean !== err.message) {
      try {
        err.message = clean
      } catch {
        return copyFailedStatementMeta(
          err,
          new DatabaseDriverError(clean, extractMssqlErrorCode(err) || 'MSSQL_ERROR', 'mssql', err)
        )
      }
    }
  }
  return err
}

function extractMssqlErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const val = Reflect.get(err, 'code')
    return typeof val === 'string' ? val : String(val ?? '')
  }
  return ''
}

function serializeMssqlCell(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'bigint') {
    const asNum = Number(value)
    return Number.isSafeInteger(asNum) ? asNum : value.toString()
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (value instanceof ArrayBuffer) {
    return `[BLOB ${value.byteLength} B]`
  }
  if (ArrayBuffer.isView(value)) {
    return `[BLOB ${value.byteLength} B]`
  }
  return value
}

function serializeMssqlRecord(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    out[k] = serializeMssqlCell(v)
  }
  return out
}

function resolveMssqlColumnTypeLabel(rawType: unknown): string {
  if (!rawType) return 'sql_variant'
  if (typeof rawType === 'string') return rawType.toLowerCase()
  if (typeof rawType === 'function' && 'name' in rawType && typeof rawType.name === 'string') {
    return rawType.name.toLowerCase()
  }
  if (typeof rawType === 'object' && 'name' in rawType) {
    const name = Reflect.get(rawType, 'name')
    if (typeof name === 'string' && name) return name.toLowerCase()
  }
  return 'sql_variant'
}

function extractMssqlColumnsAndRows(
  rawRecordset: MssqlRecordsetLike | unknown[],
  maxRows: number
): {
  columns: { name: string; type: string }[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
} {
  const rs = rawRecordset as MssqlRecordsetLike
  const meta = rs.columns
  let columns: { name: string; type: string }[] = []

  if (Array.isArray(meta)) {
    columns = meta.map((c, idx) => ({
      name: c.name || `col_${idx + 1}`,
      type: resolveMssqlColumnTypeLabel(c.type),
    }))
  } else if (meta && typeof meta === 'object') {
    columns = Object.values(meta)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((c, idx) => ({
        name: c.name || `col_${idx + 1}`,
        type: resolveMssqlColumnTypeLabel(c.type),
      }))
  } else if (rs.length > 0 && rs[0] && typeof rs[0] === 'object' && !Array.isArray(rs[0])) {
    columns = Object.keys(rs[0] as Record<string, unknown>).map((name) => ({
      name,
      type: 'sql_variant',
    }))
  }

  const limit = maxRows > 0 ? maxRows : rs.length
  const truncated = rs.length > limit
  const sliced = rs.slice(0, limit)
  const rows: unknown[][] = sliced.map((row) => {
    if (Array.isArray(row)) {
      return row.map(serializeMssqlCell)
    }
    if (row && typeof row === 'object') {
      const rec = row as Record<string, unknown>
      return columns.map((c) => serializeMssqlCell(rec[c.name]))
    }
    return [serializeMssqlCell(row)]
  })

  return {
    columns,
    rows,
    rowCount: rows.length,
    truncated,
  }
}

async function bindMssqlParams(req: MssqlRequestLike, params?: unknown[]): Promise<void> {
  if (!Array.isArray(params) || params.length === 0) return
  const needsExplicitTypes = params.some(
    (val) =>
      typeof val === 'bigint' ||
      typeof val === 'boolean' ||
      val instanceof Date ||
      val instanceof ArrayBuffer ||
      ArrayBuffer.isView(val)
  )
  const mssqlTypes = needsExplicitTypes
    ? (cachedMssqlTypes ?? (await loadMssqlVendor()).TYPES)
    : null

  for (let i = 0; i < params.length; i++) {
    const paramName = `p${i + 1}`
    const val = params[i]
    if (val === undefined || val === null) {
      req.input(paramName, null)
    } else if (typeof val === 'bigint' && mssqlTypes) {
      req.input(paramName, mssqlTypes.BigInt as unknown as ISqlType, val.toString())
    } else if (typeof val === 'boolean' && mssqlTypes) {
      req.input(paramName, mssqlTypes.Bit as unknown as ISqlType, val ? 1 : 0)
    } else if (val instanceof Date && mssqlTypes) {
      req.input(
        paramName,
        mssqlTypes.DateTime2 as unknown as ISqlType,
        Number.isNaN(val.getTime()) ? null : val
      )
    } else if (val instanceof ArrayBuffer && mssqlTypes) {
      req.input(paramName, mssqlTypes.VarBinary as unknown as ISqlType, Buffer.from(val))
    } else if (ArrayBuffer.isView(val) && mssqlTypes) {
      req.input(
        paramName,
        mssqlTypes.VarBinary as unknown as ISqlType,
        Buffer.from(val.buffer, val.byteOffset, val.byteLength)
      )
    } else {
      req.input(paramName, val)
    }
  }
}

function normalizeMssqlAffectedCount(rowsAffected: number[] | undefined, fallback = 0): number {
  if (!Array.isArray(rowsAffected) || rowsAffected.length === 0) return fallback
  return Number(rowsAffected[0] ?? fallback)
}

function sumMssqlAffectedCount(rowsAffected: number[] | undefined): number {
  if (!Array.isArray(rowsAffected) || rowsAffected.length === 0) return 0
  return rowsAffected.reduce((sum, n) => sum + Number(n || 0), 0)
}

function hasStandaloneBeginTran(sql: string): boolean {
  const stmts = splitSqlStatements(sql, 'mssql')
  const list = stmts.length > 0 ? stmts.map((s) => s.text) : [sql]
  let sawBegin = false
  for (const stmt of list) {
    const norm = stripLeadingSqlComments(stmt.trim(), 'mssql').trim()
    if (/^BEGIN\s+(?:TRAN|TRANSACTION)\b/i.test(norm)) {
      sawBegin = true
    } else if (/^(?:COMMIT|ROLLBACK)\b(?:\s+(?:TRAN|TRANSACTION)\b)?/i.test(norm)) {
      sawBegin = false
    }
  }
  return sawBegin
}

export class MssqlSession implements IDatabaseSession {
  readonly driverType = 'mssql' as const
  readonly profile: ConnectionProfile
  private readonly pool: MssqlPoolLike
  private readonly activeQueries = new Map<string, ActiveMssqlQuery>()
  private readonly tableDetailsCache = new TableDetailsCache()
  private isClosed = false
  private tx: MssqlTransactionLike | null = null
  private txOpChain: Promise<void> = Promise.resolve()
  private autoCommit = true
  private statementCount = 0
  private txStartedAt: number | undefined

  constructor(pool: MssqlPoolLike, profile: ConnectionProfile) {
    this.pool = pool
    this.profile = profile
    if (
      typeof pool.on === 'function' &&
      (typeof pool.listenerCount !== 'function' || pool.listenerCount('error') === 0)
    ) {
      pool.on('error', () => {
        // Prevent unhandled idle pool errors from crashing worker
      })
    }
  }

  isAlive(): boolean {
    return !this.isClosed && this.pool.connected !== false
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

  private createRequest(pinnedTx?: MssqlTransactionLike | null): MssqlRequestLike {
    return pinnedTx ? pinnedTx.request() : this.pool.request()
  }

  private readonly queryExecutor = async (
    sql: string,
    params?: unknown[]
  ): Promise<Record<string, unknown>[]> => {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
    }
    const req = this.createRequest(this.tx)
    await bindMssqlParams(req, params)
    const res = await req.query(sql)
    return Array.isArray(res.recordset) ? (res.recordset as Record<string, unknown>[]) : []
  }

  private async runScrubbed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err: unknown) {
      throw scrubMssqlError(err)
    }
  }

  private assertWritable(): void {
    if (this.profile.readOnly) {
      throw new DatabaseDriverError(
        'Connection is Read-Only. Uncheck Read-Only in connection settings to modify data.',
        'read_only',
        'mssql'
      )
    }
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    if (this.isClosed) {
      return { ok: false, message: 'Session is closed' }
    }
    try {
      const req = this.pool.request()
      await req.query('SELECT 1 AS ok;')
      return { ok: true, message: 'SQL Server connection valid' }
    } catch (err: unknown) {
      return {
        ok: false,
        message: extractMssqlErrorMessage(err, 'Failed to connect to SQL Server'),
      }
    }
  }

  async close(): Promise<void> {
    this.tableDetailsCache.clear()
    if (this.isClosed) return
    this.isClosed = true

    for (const active of this.activeQueries.values()) {
      active.cancelled = true
      try {
        active.request.cancel()
      } catch {
        // Ignore cancel failure on close
      }
    }
    this.activeQueries.clear()

    if (this.tx) {
      const pendingTx = this.tx
      this.tx = null
      this.statementCount = 0
      this.txStartedAt = undefined
      await pendingTx.rollback().catch(() => {})
    }

    await this.pool.close().catch(() => {})
  }

  async listSchemas(): Promise<{ schemas: string[]; defaultSchema: string }> {
    return this.runScrubbed(async () => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
      }
      return introspectMssqlSchemas(this.queryExecutor)
    })
  }

  async listObjects(schema?: string): Promise<SchemaObject[]> {
    return this.runScrubbed(async () => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
      }
      return introspectMssqlObjects(this.queryExecutor, schema || 'dbo')
    })
  }

  async getTableDetails(table: string, schema?: string): Promise<TableDetails> {
    return this.runScrubbed(async () => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
      }
      const targetSchema = schema || 'dbo'
      const cached = this.tableDetailsCache.get(targetSchema, 'dbo', table)
      if (cached) return cached
      const details = await introspectMssqlTableDetails(this.queryExecutor, table, targetSchema)
      this.tableDetailsCache.set(targetSchema, 'dbo', table, details)
      return details
    })
  }

  async getDdl(table: string, schema?: string): Promise<string> {
    return this.runScrubbed(async () => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
      }
      const targetSchema = schema || 'dbo'
      const details = await this.getTableDetails(table, targetSchema)
      if (details.kind === 'view') {
        try {
          return await introspectMssqlObjectDdl(this.queryExecutor, table, 'view', targetSchema)
        } catch {
          // Fallback to reconstructed view DDL
        }
      }
      return details.ddl || reconstructTableDdl(details, 'mssql')
    })
  }

  async getObjectDdl(name: string, kind: SchemaObjectKind, schema?: string): Promise<string> {
    return this.runScrubbed(async () => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
      }
      const targetSchema = schema || 'dbo'
      if (kind === 'table') {
        return this.getDdl(name, targetSchema)
      }
      return introspectMssqlObjectDdl(this.queryExecutor, name, kind, targetSchema)
    })
  }

  async exportSchemaDdl(schema?: string): Promise<{ ddl: string; objectCount: number }> {
    return this.runScrubbed(async () => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
      }
      const targetSchema = schema || 'dbo'
      const objects = await this.listObjects(targetSchema)
      return collectAndAssembleSchemaDdl({
        dialect: 'mssql',
        schemaName: targetSchema,
        objects,
        getObjectDdl: (object) =>
          this.getObjectDdl(object.name, object.kind, object.schema || targetSchema),
      })
    })
  }

  async fetchPage(params: FetchPageParams): Promise<TableBrowseResult> {
    return this.runScrubbed(async () => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
      }
      const targetSchema = params.schema || 'dbo'

      const executeFetch = async (pinnedTx: MssqlTransactionLike | null): Promise<TableBrowseResult> => {
        const exec = async (qSql: string, qParams?: unknown[]) => {
          const req = this.createRequest(pinnedTx)
          await bindMssqlParams(req, qParams)
          const res = await req.query(qSql)
          return Array.isArray(res.recordset) ? (res.recordset as Record<string, unknown>[]) : []
        }

        let details = this.tableDetailsCache.get(targetSchema, 'dbo', params.table)
        if (!details) {
          details = await introspectMssqlTableDetails(exec, params.table, targetSchema)
          this.tableDetailsCache.set(targetSchema, 'dbo', params.table, details)
        }

        const { sql, countSql, params: queryParams } = buildSelectPageSql({
          driver: 'mssql',
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

        const countRows = await exec(countSql)
        const dataRows = (await exec(sql, queryParams)).map(serializeMssqlRecord)

        return assembleTableBrowseResult({
          tableDetails: details,
          rows: dataRows,
          countRow: countRows[0] || { total: 0 },
          page: params.page,
          pageSize: params.pageSize,
        })
      }

      if (!params.bypassTransaction && (!this.autoCommit || this.tx !== null)) {
        return this.runExclusiveTxOp(async () => {
          if (this.isClosed) {
            throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
          }
          if (!this.autoCommit && this.tx === null) {
            await this.beginTransactionLocked()
          }
          return executeFetch(this.tx)
        })
      }

      return executeFetch(null)
    })
  }

  async updateCell(params: UpdateCellParams): Promise<UpdateCellResult> {
    return this.runScrubbed(async () => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
      }
      this.assertWritable()
      const targetSchema = params.schema || 'dbo'
      const originalColumnType = this.tableDetailsCache.findColumnType(
        targetSchema,
        'dbo',
        params.table,
        params.column,
        params.columnType
      )
      const { sql, params: updateParams } = buildUpdateSql({
        driver: 'mssql',
        table: params.table,
        schema: targetSchema,
        column: params.column,
        newValue: params.newValue,
        primaryKeys: params.primaryKeys,
        originalValue: params.originalValue,
        originalColumnType,
      })

      const reloadQuery = buildSelectByPrimaryKeySql({
        driver: 'mssql',
        table: params.table,
        schema: targetSchema,
        primaryKeys: params.primaryKeys,
        editedColumn: params.column,
        newValue: params.newValue,
      })

      const runInTransaction = async (
        tx: MssqlTransactionLike,
        isPinned: boolean
      ): Promise<UpdateCellResult> => {
        if (isPinned) {
          await tx.request().query('SAVE TRANSACTION datanoa_update_cell;')
        }
        try {
          const updateReq = tx.request()
          await bindMssqlParams(updateReq, updateParams)
          const updateRes = await updateReq.query(sql)
          const affectedRows = normalizeMssqlAffectedCount(updateRes.rowsAffected, 0)
          if (affectedRows !== 1) {
            throw new DatabaseDriverError(
              affectedRows === 0
                ? 'Record was modified or deleted by another session (optimistic lock conflict)'
                : `Expected exactly 1 row updated, got ${affectedRows} (optimistic lock conflict)`,
              'conflict',
              'mssql'
            )
          }

          let updatedRecord: Record<string, unknown> | undefined
          if (reloadQuery) {
            const selReq = tx.request()
            await bindMssqlParams(selReq, reloadQuery.params)
            const selRes = await selReq.query(reloadQuery.sql)
            const rawRow = Array.isArray(selRes.recordset) ? selRes.recordset[0] : undefined
            if (rawRow) {
              updatedRecord = serializeMssqlRecord(rawRow)
            }
          }

          if (!isPinned) {
            await tx.commit()
          } else {
            this.statementCount++
          }
          this.tableDetailsCache.clear()
          return {
            ok: true,
            affectedRows,
            updatedRecord,
          }
        } catch (err) {
          if (isPinned) {
            await tx.request().query('ROLLBACK TRANSACTION datanoa_update_cell;').catch(() => {})
          } else {
            await tx.rollback().catch(() => {})
          }
          throw err
        }
      }

      if (!this.autoCommit || this.tx !== null) {
        return this.runExclusiveTxOp(async () => {
          if (this.isClosed) {
            throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
          }
          if (!this.autoCommit && this.tx === null) {
            await this.beginTransactionLocked()
          }
          if (this.tx === null) {
            throw new DatabaseDriverError('Transaction is not active', 'NO_ACTIVE_TX', 'mssql')
          }
          return runInTransaction(this.tx, true)
        })
      }

      const tx = this.pool.transaction()
      await tx.begin()
      return runInTransaction(tx, false)
    })
  }

  private async resolveEffectiveDeletes(params: ApplyChangesParams): Promise<Record<string, unknown>[]> {
    if (Array.isArray(params.deletes) && params.deletes.length > 0) {
      return params.deletes
    }
    if (!Array.isArray(params.deleteRows) || params.deleteRows.length === 0) {
      return []
    }
    let pkCols: string[] = []
    try {
      const details = await this.getTableDetails(params.table, params.schema || 'dbo')
      pkCols = details.primaryKey
    } catch {
      pkCols = []
    }
    return projectDeleteRowsToPrimaryKeys(params.deleteRows, pkCols)
  }

  async previewChanges(params: ApplyChangesParams): Promise<PreviewChangesResult> {
    return this.runScrubbed(async () => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
      }
      const targetSchema = params.schema || 'dbo'
      const deletes = await this.resolveEffectiveDeletes(params)
      const batch = buildBatchStatements({
        driver: 'mssql',
        table: params.table,
        schema: targetSchema,
        inserts: params.inserts,
        updates: params.updates,
        deletes,
        columnTypes: this.tableDetailsCache.resolveColumnTypes(
          targetSchema,
          'dbo',
          params.table,
          params.columnTypes
        ),
      })
      return { statements: batch.previewStatements }
    })
  }

  async applyChanges(params: ApplyChangesParams): Promise<ApplyChangesResult> {
    return this.runScrubbed(async () => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
      }
      this.assertWritable()
      const targetSchema = params.schema || 'dbo'
      const deletes = await this.resolveEffectiveDeletes(params)
    const batch = buildBatchStatements({
      driver: 'mssql',
      table: params.table,
      schema: targetSchema,
      inserts: params.inserts,
      updates: params.updates,
      deletes,
      columnTypes: this.tableDetailsCache.resolveColumnTypes(
        targetSchema,
        'dbo',
        params.table,
        params.columnTypes
      ),
    })
    if (batch.all.length === 0) {
      return { ok: true, inserted: 0, updated: 0, deleted: 0, statements: [] }
    }

    const executeBatch = async (
      tx: MssqlTransactionLike,
      isPinned: boolean
    ): Promise<ApplyChangesResult> => {
      if (isPinned) {
        await tx.request().query('SAVE TRANSACTION datanoa_apply_changes;')
      }
      try {
        let deleted = 0
        for (const stmt of batch.deletes) {
          const req = tx.request()
          await bindMssqlParams(req, stmt.params)
          const res = await req.query(stmt.sql)
          const count = normalizeMssqlAffectedCount(res.rowsAffected, 0)
          if (count === 0) {
            throw new DatabaseDriverError(
              'Record was modified or deleted by another session (optimistic lock conflict)',
              'conflict',
              'mssql'
            )
          }
          deleted += count
        }

        let updated = 0
        for (const stmt of batch.updates) {
          const req = tx.request()
          await bindMssqlParams(req, stmt.params)
          const res = await req.query(stmt.sql)
          const count = normalizeMssqlAffectedCount(res.rowsAffected, 0)
          if (count === 0) {
            throw new DatabaseDriverError(
              'Record was modified or deleted by another session (optimistic lock conflict)',
              'conflict',
              'mssql'
            )
          }
          updated += count
        }

        let inserted = 0
        for (const stmt of batch.chunkedInserts) {
          const req = tx.request()
          await bindMssqlParams(req, stmt.params)
          const res = await req.query(stmt.sql)
          inserted += normalizeMssqlAffectedCount(res.rowsAffected, stmt.rowCount)
        }

        if (!isPinned) {
          await tx.commit()
        } else {
          this.statementCount += batch.deletes.length + batch.updates.length + batch.chunkedInserts.length
        }
        this.tableDetailsCache.clear()
        return {
          ok: true,
          inserted,
          updated,
          deleted,
          statements: batch.previewStatements,
        }
      } catch (err) {
        if (isPinned) {
          await tx.request().query('ROLLBACK TRANSACTION datanoa_apply_changes;').catch(() => {})
        } else {
          await tx.rollback().catch(() => {})
        }
        throw err
      }
    }

    if (!this.autoCommit || this.tx !== null) {
      return this.runExclusiveTxOp(async () => {
        if (this.isClosed) {
          throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
        }
        if (!this.autoCommit && this.tx === null) {
          await this.beginTransactionLocked()
        }
        if (this.tx === null) {
          throw new DatabaseDriverError('Transaction is not active', 'NO_ACTIVE_TX', 'mssql')
        }
        return executeBatch(this.tx, true)
      })
    }

    const tx = this.pool.transaction()
    await tx.begin()
    return executeBatch(tx, false)
    })
  }

  async runQuery(queryId: string, sql: string, maxRows = 1000): Promise<QueryResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
    }
    const batches = splitMssqlBatches(sql)
    const execBatches = batches.length > 0 ? batches : [sql]
    const chunksAligned = areChunksAlignedWithSqlSlices(sql, 'mssql', execBatches)
    if (this.profile.readOnly && execBatches.some((b) => isMssqlReadOnlyBlocked(b))) {
      this.assertWritable()
    }

    const startsTx = execBatches.some((b) => hasStandaloneBeginTran(b))
    const needsTxLock = !this.autoCommit || this.tx !== null || startsTx

    const executeRun = async (): Promise<QueryResult> => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
      }
      if (!this.autoCommit && this.tx === null) {
        await this.beginTransactionLocked()
      }

      const startTime = performance.now()
      let totalAffectedRows = 0
      let lastSelect: Omit<QueryResult, 'executionTimeMs'> | null = null
      const collectedSets: QueryResultSet[] = []

      const activeEntry: ActiveMssqlQuery = {
        request: this.createRequest(this.tx),
        cancelled: false,
      }
      this.activeQueries.set(queryId, activeEntry)

      try {
        for (let batchIndex = 0; batchIndex < execBatches.length; batchIndex++) {
          const batchSql = execBatches[batchIndex]
          if (activeEntry.cancelled || this.isClosed) {
            throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'mssql')
          }

          const batchStmts = splitSqlStatements(batchSql, 'mssql')
          const isSingleStmtBatch = batchStmts.length <= 1
          const norm = stripLeadingSqlComments(batchSql.trim(), 'mssql').trim()
          const isStandaloneBegin =
            isSingleStmtBatch &&
            /^BEGIN\s+(?:TRAN|TRANSACTION)\b(?:\s+[A-Za-z_@#][A-Za-z0-9_@#$]*)?\s*;?$/i.test(norm)
          const isStandaloneCommit =
            isSingleStmtBatch &&
            /^COMMIT\b(?:\s+(?:TRAN|TRANSACTION)\b)?(?:\s+[A-Za-z_@#][A-Za-z0-9_@#$]*)?\s*;?$/i.test(norm)
          const isStandaloneRollback =
            isSingleStmtBatch &&
            /^ROLLBACK(?:\s+(?:TRAN|TRANSACTION|WORK))?\s*;?$/i.test(norm)

          if (isStandaloneBegin && this.tx === null) {
            await this.beginTransactionLocked()
            collectedSets.push({
              index: collectedSets.length,
              sqlPreview: compactSql(batchSql),
              sql: batchSql,
              executionTimeMs: 0,
              columns: [{ name: 'affected_rows', type: 'INTEGER' }],
              rows: [[0]],
              rowCount: 1,
              affectedRows: 0,
              truncated: false,
              isSelect: false,
            })
            continue
          }

          if (isStandaloneCommit && this.tx !== null) {
            const activeTx = this.tx
            await this.finishActiveTransaction(activeTx, 'commit')
            collectedSets.push({
              index: collectedSets.length,
              sqlPreview: compactSql(batchSql),
              sql: batchSql,
              executionTimeMs: 0,
              columns: [{ name: 'affected_rows', type: 'INTEGER' }],
              rows: [[0]],
              rowCount: 1,
              affectedRows: 0,
              truncated: false,
              isSelect: false,
            })
            continue
          }

          if (isStandaloneRollback && this.tx !== null) {
            const activeTx = this.tx
            await this.finishActiveTransaction(activeTx, 'rollback')
            collectedSets.push({
              index: collectedSets.length,
              sqlPreview: compactSql(batchSql),
              sql: batchSql,
              executionTimeMs: 0,
              columns: [{ name: 'affected_rows', type: 'INTEGER' }],
              rows: [[0]],
              rowCount: 1,
              affectedRows: 0,
              truncated: false,
              isSelect: false,
            })
            continue
          }

          const batchStart = performance.now()
          const req = this.createRequest(this.tx)
          req.arrayRowMode = true
          activeEntry.request = req

          let res: MssqlQueryResultLike
          try {
            res = await req.query(batchSql)
          } catch (err) {
            if (activeEntry.cancelled || extractMssqlErrorCode(err) === 'ECANCEL') {
              throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'mssql', err)
            }
            const scrubbed = scrubMssqlError(err)
            if (chunksAligned && (execBatches.length > 1 || scrubbed instanceof Error)) {
              throw attachFailedStatementMeta(scrubbed, batchIndex, execBatches.length)
            }
            throw scrubbed
          }

          if (activeEntry.cancelled || this.isClosed) {
            throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'mssql')
          }

          if (this.tx !== null) {
            this.statementCount++
          }

          const batchDurationMs = Math.round(performance.now() - batchStart)
          const recordsets =
            Array.isArray(res.recordsets) && res.recordsets.length > 0
              ? res.recordsets
              : res.recordset && Array.isArray(res.recordset) && res.recordset.length > 0
                ? [res.recordset]
                : []
          const batchAffected = sumMssqlAffectedCount(res.rowsAffected)
          totalAffectedRows += batchAffected

          if (recordsets.length > 0) {
            for (let rsIdx = 0; rsIdx < recordsets.length; rsIdx++) {
              const parsed = extractMssqlColumnsAndRows(recordsets[rsIdx], maxRows)
              const rsAffected =
                res.rowsAffected && res.rowsAffected[rsIdx] !== undefined
                  ? Number(res.rowsAffected[rsIdx])
                  : undefined
              lastSelect = {
                columns: parsed.columns,
                rows: parsed.rows,
                rowCount: parsed.rowCount,
                truncated: parsed.truncated,
                isSelect: true,
              }
              collectedSets.push({
                index: collectedSets.length,
                sqlPreview: compactSql(batchSql),
                sql: batchSql,
                executionTimeMs: batchDurationMs,
                columns: parsed.columns,
                rows: parsed.rows,
                rowCount: parsed.rowCount,
                ...(rsAffected !== undefined ? { affectedRows: rsAffected } : {}),
                truncated: parsed.truncated,
                isSelect: true,
              })
            }
          } else {
            collectedSets.push({
              index: collectedSets.length,
              sqlPreview: compactSql(batchSql),
              sql: batchSql,
              executionTimeMs: batchDurationMs,
              columns: [{ name: 'affected_rows', type: 'INTEGER' }],
              rows: [[batchAffected]],
              rowCount: 1,
              affectedRows: batchAffected,
              truncated: false,
              isSelect: false,
            })
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
      } finally {
        if (containsDdlStatement(sql, 'mssql')) {
          this.tableDetailsCache.clear()
        }
        this.activeQueries.delete(queryId)
      }
    }

    return this.runScrubbed(() =>
      needsTxLock ? this.runExclusiveTxOp(executeRun) : executeRun()
    )
  }

  async cancelQuery(queryId: string): Promise<{ ok: boolean }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
    }
    const active = this.activeQueries.get(queryId)
    if (!active) {
      return { ok: true }
    }
    active.cancelled = true
    try {
      active.request.cancel()
      return { ok: true }
    } catch {
      return { ok: false }
    }
  }

  getTransactionState(): TransactionState {
    return {
      active: this.tx !== null,
      autoCommit: this.autoCommit,
      statementCount: this.statementCount,
      startedAt: this.txStartedAt,
      supported: true,
    }
  }

  async setAutoCommit(enabled: boolean): Promise<TransactionState> {
    return this.runScrubbed(() =>
      this.runExclusiveTxOp(async () => {
        if (this.isClosed) {
          throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
        }
        if (enabled) {
          if (this.tx !== null) {
            throw new DatabaseDriverError(
              'Commit or rollback the active transaction before switching to Auto-Commit',
              'TX_ACTIVE',
              'mssql'
            )
          }
          this.autoCommit = true
        } else {
          this.autoCommit = false
        }
        return this.getTransactionState()
      })
    )
  }

  private async beginTransactionLocked(): Promise<TransactionState> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
    }
    if (this.tx !== null) {
      throw new DatabaseDriverError('Transaction is already active', 'TX_ALREADY_ACTIVE', 'mssql')
    }
    const tx = this.pool.transaction()
    await tx.begin()
    if (this.isClosed) {
      await tx.rollback().catch(() => {})
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
    }
    this.tx = tx
    this.statementCount = 0
    this.txStartedAt = Date.now()
    return this.getTransactionState()
  }

  async beginTransaction(): Promise<TransactionState> {
    return this.runScrubbed(() => this.runExclusiveTxOp(() => this.beginTransactionLocked()))
  }

  private clearActiveTx(): void {
    this.tx = null
    this.statementCount = 0
    this.txStartedAt = undefined
  }

  private shouldClearTxAfterError(activeTx: MssqlTransactionLike, err: unknown): boolean {
    const code = extractMssqlErrorCode(err)
    if (code === 'EREQINPROG') return false
    if (code === 'EABORT' || code === 'ENOTBEGUN' || code === 'ECONNCLOSED') return true
    if (typeof activeTx === 'object' && activeTx !== null && '_acquiredConnection' in activeTx) {
      return !Reflect.get(activeTx, '_acquiredConnection')
    }
    return false
  }

  private async finishActiveTransaction(
    activeTx: MssqlTransactionLike,
    action: 'commit' | 'rollback'
  ): Promise<void> {
    try {
      if (action === 'commit') {
        await activeTx.commit()
      } else {
        await activeTx.rollback()
      }
      this.clearActiveTx()
    } catch (err: unknown) {
      if (this.shouldClearTxAfterError(activeTx, err)) {
        this.clearActiveTx()
      }
      throw err
    }
  }

  async commitTransaction(): Promise<TransactionState> {
    return this.runScrubbed(() =>
      this.runExclusiveTxOp(async () => {
        if (this.isClosed) {
          throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
        }
        const activeTx = this.tx
        if (activeTx === null) {
          throw new DatabaseDriverError('Cannot commit: no active transaction', 'NO_ACTIVE_TX', 'mssql')
        }
        await this.finishActiveTransaction(activeTx, 'commit')
        return this.getTransactionState()
      })
    )
  }

  async rollbackTransaction(): Promise<TransactionState> {
    return this.runScrubbed(() =>
      this.runExclusiveTxOp(async () => {
        if (this.isClosed) {
          throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mssql')
        }
        const activeTx = this.tx
        if (activeTx === null) {
          throw new DatabaseDriverError('Cannot rollback: no active transaction', 'NO_ACTIVE_TX', 'mssql')
        }
        await this.finishActiveTransaction(activeTx, 'rollback')
        return this.getTransactionState()
      })
    )
  }
}

function parseMssqlUrlEncryptParam(rawVal: string | null): boolean | 'strict' | undefined {
  if (rawVal === null) return undefined
  const lower = rawVal.trim().toLowerCase()
  if (lower === 'strict') return 'strict'
  if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'mandatory') return true
  if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'optional') return false
  return undefined
}

function parseMssqlUrlBoolParam(rawVal: string | null): boolean | undefined {
  if (rawVal === null) return undefined
  const lower = rawVal.trim().toLowerCase()
  if (lower === 'true' || lower === '1' || lower === 'yes') return true
  if (lower === 'false' || lower === '0' || lower === 'no') return false
  return undefined
}

export async function buildMssqlPoolConfig(
  profile: ConnectionProfile,
  password?: string,
  extraSecrets?: DriverTlsOptions
): Promise<MssqlConfig> {
  let host = (profile.host || '').trim()
  let port = profile.port
  let user = profile.user
  let resolvedPassword = password
  let database = (profile.database || '').trim()
  let urlEncrypt: boolean | 'strict' | undefined
  let urlTrustServerCertificate: boolean | undefined

  const rawUrl = (profile.url || '').trim()
  if (rawUrl) {
    if (/^(?:mssql|sqlserver):\/\//i.test(rawUrl)) {
      try {
        const parsed = new URL(rawUrl)
        if (!host && parsed.hostname) host = parsed.hostname
        if (!port && parsed.port) {
          const parsedPort = Number(parsed.port)
          if (Number.isInteger(parsedPort) && parsedPort > 0) port = parsedPort
        }
        if (!user && parsed.username) user = decodeURIComponent(parsed.username)
        if (!resolvedPassword && parsed.password) resolvedPassword = decodeURIComponent(parsed.password)
        if (!database && parsed.pathname) {
          const dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
          if (dbName) database = dbName
        }
        for (const [k, v] of parsed.searchParams.entries()) {
          const lk = k.toLowerCase()
          if (lk === 'encrypt' && urlEncrypt === undefined) {
            urlEncrypt = parseMssqlUrlEncryptParam(v)
          } else if (lk === 'trustservercertificate' && urlTrustServerCertificate === undefined) {
            urlTrustServerCertificate = parseMssqlUrlBoolParam(v)
          }
        }
      } catch {
        // Fall back to ConnectionPool.parseConnectionString when URL is non-standard
      }
    } else if (/Server\s*=|Data Source\s*=/i.test(rawUrl)) {
      const { ConnectionPool } = await loadMssqlVendor()
      const parsed = ConnectionPool.parseConnectionString(rawUrl)
      if (!host && parsed.server) host = parsed.server
      if (!port && parsed.port) port = parsed.port
      if (!user && parsed.user) user = parsed.user
      if (!resolvedPassword && parsed.password) resolvedPassword = parsed.password
      if (!database && parsed.database) database = parsed.database
      const parsedEncrypt = parsed.options?.encrypt
      if (typeof parsedEncrypt === 'boolean') {
        urlEncrypt = parsedEncrypt
      } else if (typeof parsedEncrypt === 'string' && parsedEncrypt.toLowerCase() === 'strict') {
        urlEncrypt = 'strict'
      }
      if (typeof parsed.options?.trustServerCertificate === 'boolean') {
        urlTrustServerCertificate = parsed.options.trustServerCertificate
      }
    }
  }

  host = host || 'localhost'
  database = database || 'master'

  const slashIdx = host.indexOf('\\')
  const serverHost = slashIdx >= 0 ? host.slice(0, slashIdx) : host
  const instanceName = slashIdx >= 0 ? host.slice(slashIdx + 1).trim() : ''

  const tlsOverride = await resolveEffectiveTlsOptions(
    profile,
    extraSecrets,
    extraSecrets?.tlsServername
  )

  const rawTlsServername =
    typeof extraSecrets?.tlsServername === 'string' ? extraSecrets.tlsServername.trim() : ''
  const unwrappedServername =
    rawTlsServername.startsWith('[') &&
    rawTlsServername.endsWith(']') &&
    net.isIP(rawTlsServername.slice(1, -1)) === 6
      ? rawTlsServername.slice(1, -1)
      : rawTlsServername
  const cleanTlsServername =
    unwrappedServername.length > 0 && net.isIP(unwrappedServername) === 0
      ? unwrappedServername
      : undefined

  let encrypt: boolean | 'strict'
  let trustServerCertificate: boolean
  let cryptoCredentialsDetails: MssqlConfig['options'] extends infer O
    ? O extends { cryptoCredentialsDetails?: infer C }
      ? C
      : undefined
    : undefined

  if (tlsOverride === false) {
    encrypt = false
    trustServerCertificate = false
  } else if (tlsOverride) {
    encrypt = urlEncrypt === 'strict' ? 'strict' : true
    trustServerCertificate = tlsOverride.rejectUnauthorized === false
    const cryptoDetails: Record<string, unknown> = {}
    if (tlsOverride.ca !== undefined) cryptoDetails.ca = tlsOverride.ca
    if (tlsOverride.cert !== undefined) cryptoDetails.cert = tlsOverride.cert
    if (tlsOverride.key !== undefined) cryptoDetails.key = tlsOverride.key
    if (tlsOverride.passphrase !== undefined) cryptoDetails.passphrase = tlsOverride.passphrase
    if (tlsOverride.servername !== undefined) cryptoDetails.servername = tlsOverride.servername
    if (tlsOverride.checkServerIdentity !== undefined) {
      cryptoDetails.checkServerIdentity = tlsOverride.checkServerIdentity
    }
    if (Object.keys(cryptoDetails).length > 0) {
      cryptoCredentialsDetails = cryptoDetails as typeof cryptoCredentialsDetails
    }
  } else {
    encrypt =
      profile.ssl !== undefined
        ? Boolean(profile.ssl)
        : urlEncrypt !== undefined
          ? urlEncrypt
          : isCloudDatabaseHost(serverHost)
    trustServerCertificate =
      profile.sslRejectUnauthorized !== undefined
        ? profile.sslRejectUnauthorized === false
        : urlTrustServerCertificate !== undefined
          ? urlTrustServerCertificate
          : encrypt
            ? false
            : true
  }

  const effectiveServerName =
    Boolean(encrypt) && !trustServerCertificate && cleanTlsServername
      ? cleanTlsServername
      : undefined

  return {
    server: serverHost,
    ...(instanceName ? {} : { port: port || 1433 }),
    user,
    password: resolvedPassword,
    database,
    connectionTimeout: 10_000,
    requestTimeout: 60_000,
    pool: {
      min: 0,
      max: 5,
    },
    options: {
      encrypt,
      trustServerCertificate,
      enableArithAbort: true,
      ...(instanceName ? { instanceName } : {}),
      ...(effectiveServerName ? { serverName: effectiveServerName } : {}),
      ...(cryptoCredentialsDetails ? { cryptoCredentialsDetails } : {}),
    },
  }
}

export class MssqlDriver implements IDatabaseDriver {
  readonly type = 'mssql' as const

  async createSession(
    profile: ConnectionProfile,
    password?: string,
    extraSecrets?: DriverTlsOptions
  ): Promise<IDatabaseSession> {
    try {
      const [{ ConnectionPool }, config] = await Promise.all([
        loadMssqlVendor(),
        buildMssqlPoolConfig(profile, password, extraSecrets),
      ])
      const pool = new ConnectionPool(config)
      const session = new MssqlSession(pool as unknown as MssqlPoolLike, profile)
      await pool.connect()
      return session
    } catch (err: unknown) {
      throw scrubMssqlError(err)
    }
  }

  async testConnection(
    profile: ConnectionProfile,
    password?: string,
    extraSecrets?: DriverTlsOptions
  ): Promise<{ ok: boolean; message?: string }> {
    return runDriverConnectionTest(
      () => this.createSession(profile, password, extraSecrets),
      (err) => extractMssqlErrorMessage(err, 'SQL Server connection failed')
    )
  }
}
