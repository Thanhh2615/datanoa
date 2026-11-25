import { appendActionableTlsErrorHint, type DriverTlsOptions } from './tls-and-tunnel'
export { appendActionableTlsErrorHint }
import { splitSqlStatements, stripLeadingSqlComments } from '../../shared-sql-core.js'
import type {
  ConnectionProfile,
  DatabaseDriverType,
  DataChangesInput,
  SchemaObject,
  SchemaObjectKind,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  TableDetails,
  QueryExecutionError,
  QueryResult,
  QueryResultSet,
  TableBrowseResult,
  TransactionState,
} from '../../protocol'

export type {
  ConnectionProfile,
  DataChangesInput,
  SchemaObject,
  SchemaObjectKind,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  TableDetails,
  QueryExecutionError,
  QueryResult,
  QueryResultSet,
  TableBrowseResult,
  TransactionState,
}

export type DriverType = DatabaseDriverType

export interface FetchPageParams {
  table: string
  schema?: string
  page: number
  pageSize: number
  sortColumn?: string
  sortDirection?: 'ASC' | 'DESC'
  whereClause?: string
  orderByClause?: string
  bypassTransaction?: boolean
}

export interface UpdateCellParams {
  table: string
  schema?: string
  primaryKeys: Record<string, unknown>
  column: string
  newValue: unknown
  originalValue?: unknown
  columnType?: string
}

export interface UpdateCellResult {
  ok: boolean
  affectedRows: number
  updatedRecord?: Record<string, unknown>
}

export type ApplyChangesUpdate = NonNullable<DataChangesInput['updates']>[number]

export interface ApplyChangesParams {
  table: string
  schema?: string
  inserts?: Record<string, unknown>[]
  updates?: ApplyChangesUpdate[]
  deletes?: Record<string, unknown>[]
  deleteRows?: Record<string, unknown>[]
  columnTypes?: Record<string, string>
}

export interface ApplyChangesResult {
  ok: boolean
  inserted: number
  updated: number
  deleted: number
  statements: string[]
}

export interface PreviewChangesResult {
  statements: string[]
}

export class DatabaseDriverError extends Error {
  readonly code: string
  readonly driver: DriverType
  readonly cause?: unknown
  failedStatementIndex?: number
  statementCount?: number

  constructor(message: string, code: string, driver: DriverType, cause?: unknown) {
    super(message)
    this.name = 'DatabaseDriverError'
    this.code = code
    this.driver = driver
    this.cause = cause
  }
}

export interface FailedStatementMeta {
  failedStatementIndex: number
  statementCount?: number
}

export function extractFailedStatementMeta(err: unknown): FailedStatementMeta | null {
  if (!err || typeof err !== 'object') return null
  const rec = err as { failedStatementIndex?: unknown; statementCount?: unknown }
  const idx = rec.failedStatementIndex
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
    return null
  }
  const count = rec.statementCount
  if (typeof count === 'number' && Number.isInteger(count) && count > idx) {
    return { failedStatementIndex: idx, statementCount: count }
  }
  return { failedStatementIndex: idx }
}

export function attachFailedStatementMeta(
  err: unknown,
  failedStatementIndex: number,
  statementCount: number
): Error {
  const errorObj =
    err instanceof Error
      ? err
      : new Error(
          err &&
            typeof err === 'object' &&
            'message' in err &&
            typeof (err as { message?: unknown }).message === 'string' &&
            (err as { message: string }).message.length > 0
            ? (err as { message: string }).message
            : typeof err === 'string' && err.length > 0
              ? err
              : String(err)
        )
  if (
    !Number.isInteger(failedStatementIndex) ||
    failedStatementIndex < 0 ||
    !Number.isInteger(statementCount) ||
    statementCount <= failedStatementIndex
  ) {
    return errorObj
  }
  const target = errorObj as Error & {
    failedStatementIndex?: number
    statementCount?: number
  }
  try {
    target.failedStatementIndex = failedStatementIndex
    target.statementCount = statementCount
    return errorObj
  } catch {
    if (errorObj instanceof DatabaseDriverError) {
      const cloned = new DatabaseDriverError(
        errorObj.message,
        errorObj.code,
        errorObj.driver,
        errorObj.cause
      )
      cloned.failedStatementIndex = failedStatementIndex
      cloned.statementCount = statementCount
      return cloned
    }
    const cloned = new Error(errorObj.message) as Error & {
      code?: unknown
      failedStatementIndex?: number
      statementCount?: number
    }
    cloned.name = errorObj.name
    const rawCode = (errorObj as { code?: unknown }).code
    if (rawCode !== undefined) {
      cloned.code = rawCode
    }
    cloned.failedStatementIndex = failedStatementIndex
    cloned.statementCount = statementCount
    return cloned
  }
}

function stripLeadingCommentsForParity(text: string, dialect: DriverType): string {
  if (dialect === 'mongodb') {
    let i = 0
    const len = text.length
    while (i < len) {
      while (i < len && /\s/.test(text[i])) i++
      if (text[i] === '/' && text[i + 1] === '/') {
        const nl = text.indexOf('\n', i + 2)
        i = nl < 0 ? len : nl + 1
        continue
      }
      if (text[i] === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2)
        i = end < 0 ? len : end + 2
        continue
      }
      break
    }
    return text.slice(i)
  }
  return stripLeadingSqlComments(text, dialect)
}

function normalizeChunkForParity(text: string, dialect: DriverType): string {
  const lf = text.replace(/\r\n?/g, '\n')
  return stripLeadingCommentsForParity(lf, dialect).replace(/;+\s*$/, '').trim()
}

export function areChunksAlignedWithSqlSlices(
  sql: string,
  dialect: DriverType,
  driverChunks: readonly string[]
): boolean {
  const frontendSlices = splitSqlStatements(sql, dialect)
  if (frontendSlices.length === 0 || frontendSlices.length !== driverChunks.length) {
    return false
  }
  for (let i = 0; i < frontendSlices.length; i++) {
    const driverText = normalizeChunkForParity(driverChunks[i], dialect)
    const sliceText = normalizeChunkForParity(frontendSlices[i].text, dialect)
    if (!driverText || driverText !== sliceText) {
      return false
    }
  }
  return true
}

export function copyFailedStatementMeta<T extends Error>(source: unknown, target: T): T {
  const meta = extractFailedStatementMeta(source)
  if (!meta) return target
  const out = target as T & {
    failedStatementIndex?: number
    statementCount?: number
  }
  try {
    out.failedStatementIndex = meta.failedStatementIndex
    if (meta.statementCount !== undefined) {
      out.statementCount = meta.statementCount
    }
  } catch {
    // Ignore frozen target
  }
  return target
}

export interface IDatabaseSession {
  readonly driverType: DriverType
  readonly profile: ConnectionProfile

  /** Returns true if the session is still open and its underlying transport/worker is healthy */
  isAlive(): boolean

  /** Verifies connection is active */
  test(): Promise<{ ok: boolean; message?: string }>

  /** Closes session and underlying resources (connections/threads) */
  close(): Promise<void>

  /** Lists database objects (tables, views, and other supported kinds) */
  listObjects(schema?: string): Promise<SchemaObject[]>

  /** Lists available schemas/databases and the default one */
  listSchemas?(): Promise<{ schemas: string[]; defaultSchema: string }>

  /** Returns the DDL for a single database object */
  getObjectDdl?(name: string, kind: SchemaObjectKind, schema?: string): Promise<string>

  /** Exports the full DDL for a schema, ordered by dependency */
  exportSchemaDdl?(schema?: string): Promise<{ ddl: string; objectCount: number }>

  /** Inspects detailed schema of a table or view */
  getTableDetails(table: string, schema?: string): Promise<TableDetails>

  /** Fetches a paginated page of records from a table */
  fetchPage(params: FetchPageParams): Promise<TableBrowseResult>

  /** Safely updates a single cell with optimistic concurrency locking */
  updateCell(params: UpdateCellParams): Promise<UpdateCellResult>

  /** Executes staged batch inserts/updates/deletes atomically when supported */
  applyChanges(params: ApplyChangesParams): Promise<ApplyChangesResult>

  /** Renders preview SQL/command statements for staged changes without mutating data */
  previewChanges(params: ApplyChangesParams): Promise<PreviewChangesResult>

  /** Generates or retrieves CREATE TABLE / keyspace DDL */
  getDdl(table: string, schema?: string): Promise<string>

  /** Runs arbitrary SQL or engine command with execution timing and truncation */
  runQuery(queryId: string, sql: string, maxRows?: number): Promise<QueryResult>

  /** Cancels an actively running query by queryId */
  cancelQuery(queryId: string): Promise<{ ok: boolean }>

  /** Returns current transaction state */
  getTransactionState(): TransactionState

  /** Begins an explicit manual transaction */
  beginTransaction(): Promise<TransactionState>

  /** Commits the current active manual transaction */
  commitTransaction(): Promise<TransactionState>

  /** Rolls back the current active manual transaction */
  rollbackTransaction(): Promise<TransactionState>

  /** Toggles auto-commit mode */
  setAutoCommit(enabled: boolean): Promise<TransactionState>
}

export type { DriverTlsOptions }

export interface IDatabaseDriver {
  readonly type: DriverType
  createSession(
    profile: ConnectionProfile,
    secret?: string,
    extraSecrets?: DriverTlsOptions
  ): Promise<IDatabaseSession>
  testConnection(
    profile: ConnectionProfile,
    secret?: string,
    extraSecrets?: DriverTlsOptions
  ): Promise<{ ok: boolean; message?: string }>
}

export function buildCombinedAbortSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeoutSignal
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, timeoutSignal])
  }
  return signal
}

function extractTlsErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined
  const rec = err as { code?: unknown; cause?: unknown }
  if (typeof rec.code === 'string' && rec.code.trim().length > 0) {
    return rec.code.trim()
  }
  if (rec.cause && typeof rec.cause === 'object' && 'code' in rec.cause) {
    const causeCode = (rec.cause as { code?: unknown }).code
    if (typeof causeCode === 'string' && causeCode.trim().length > 0) {
      return causeCode.trim()
    }
  }
  return undefined
}

export async function runDriverConnectionTest(
  createSession: () => Promise<IDatabaseSession>,
  formatError: (err: unknown) => string
): Promise<{ ok: boolean; message?: string }> {
  let session: IDatabaseSession | null = null
  let result: { ok: boolean; message?: string }
  try {
    session = await createSession()
    result = await session.test()
    if (!result.ok && typeof result.message === 'string') {
      result = {
        ...result,
        message: appendActionableTlsErrorHint(result.message),
      }
    }
  } catch (err: unknown) {
    result = {
      ok: false,
      message: appendActionableTlsErrorHint(formatError(err), extractTlsErrorCode(err)),
    }
  } finally {
    if (session) {
      await session.close().catch(() => {})
    }
  }
  return result
}

export function createUnsupportedTransactionState(reason: string): TransactionState {
  return {
    active: false,
    autoCommit: true,
    statementCount: 0,
    supported: false,
    reason,
  }
}

export function createUnsupportedTransactionError(
  driver: DriverType,
  reason: string
): DatabaseDriverError {
  return new DatabaseDriverError(reason, 'UNSUPPORTED_TRANSACTION', driver)
}
