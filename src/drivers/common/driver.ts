import type {
  ConnectionProfile,
  DatabaseDriverType,
  DataChangesInput,
  SchemaObject,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  TableDetails,
  QueryResult,
  TableBrowseResult,
} from '../../protocol'

export type {
  ConnectionProfile,
  DataChangesInput,
  SchemaObject,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  TableDetails,
  QueryResult,
  TableBrowseResult,
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

  /** Lists tables and views */
  listObjects(schema?: string): Promise<SchemaObject[]>

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
}

export interface IDatabaseDriver {
  readonly type: DriverType
  createSession(profile: ConnectionProfile, secret?: string): Promise<IDatabaseSession>
  testConnection(
    profile: ConnectionProfile,
    secret?: string
  ): Promise<{ ok: boolean; message?: string }>
}
