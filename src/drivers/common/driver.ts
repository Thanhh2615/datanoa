import type { DriverTlsOptions } from './tls-and-tunnel'
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

  constructor(message: string, code: string, driver: DriverType, cause?: unknown) {
    super(message)
    this.name = 'DatabaseDriverError'
    this.code = code
    this.driver = driver
    this.cause = cause
  }
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

export async function runDriverConnectionTest(
  createSession: () => Promise<IDatabaseSession>,
  formatError: (err: unknown) => string
): Promise<{ ok: boolean; message?: string }> {
  let session: IDatabaseSession | null = null
  try {
    session = await createSession()
    return await session.test()
  } catch (err: unknown) {
    return { ok: false, message: formatError(err) }
  } finally {
    if (session) {
      await session.close().catch(() => {})
    }
  }
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
