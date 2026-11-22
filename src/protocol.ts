// src/protocol.ts
// Type-safe IPC request-response and event protocol for Datanoa DB Studio

export type DatabaseDriverType =
  | 'sqlite'
  | 'postgres'
  | 'mysql'
  | 'mariadb'
  | 'cockroachdb'
  | 'clickhouse'
  | 'redis'
  | 'libsql'
  | 'd1'

export type ConnectionColorTag = 'none' | 'dev' | 'staging' | 'prod'

/** TLS negotiation mode for TCP engines (`auto` keeps legacy profile.ssl / cloud auto-SSL behaviour) */
export type SslMode = 'auto' | 'disable' | 'require' | 'verify-ca' | 'verify-full'

/** SSH bastion authentication method (non-interactive; OS `ssh -N -L`) */
export type SshAuthMethod = 'agent' | 'key' | 'password'

export interface ConnectionProfile {
  id: string
  name: string
  driver: DatabaseDriverType
  database: string
  host?: string
  port?: number
  user?: string
  hasPassword?: boolean
  filePath?: string
  ssl?: boolean
  readOnly?: boolean
  url?: string
  redisDb?: number
  hasAuthToken?: boolean
  /** Cloudflare D1 REST account identifier (never the API token). */
  d1AccountId?: string
  /** Cloudflare D1 database identifier. */
  d1DatabaseId?: string
  colorTag?: ConnectionColorTag
  options?: string
  /** Optional user-defined folder / group label (trimmed, max 64 chars). */
  folder?: string
  /** Optional workspace scope key this connection is pinned to (max 260 chars). */
  workspaceScope?: string
  // --- Custom CA / Client Cert (mTLS) ---
  sslMode?: SslMode
  sslCaPath?: string
  sslCertPath?: string
  sslKeyPath?: string
  hasSslKeyPassphrase?: boolean
  sslRejectUnauthorized?: boolean
  // --- SSH Tunnel (bastion) ---
  sshEnabled?: boolean
  sshHost?: string
  sshPort?: number
  sshUser?: string
  sshAuthMethod?: SshAuthMethod
  sshPrivateKeyPath?: string
  hasSshPassphrase?: boolean
  hasSshPassword?: boolean
}

export type SchemaObjectKind =
  | 'table'
  | 'view'
  | 'materialized_view'
  | 'function'
  | 'procedure'
  | 'trigger'
  | 'sequence'
  | 'type'

export interface SchemaObject {
  name: string
  schema: string
  kind: SchemaObjectKind
  detail?: string
}

export interface ColumnInfo {
  name: string
  type: string
  nativeType: string
  nullable: boolean
  defaultValue: string | null
  isPrimaryKey: boolean
  isAutoIncrement: boolean
  isGenerated?: boolean
}

export interface IndexInfo {
  name: string
  isUnique: boolean
  isPrimary: boolean
  columns: string[]
}

export interface ForeignKeyInfo {
  constraintName: string
  column: string
  referencedTable: string
  referencedColumn: string
  onDelete?: string
  onUpdate?: string
  referencedSchema?: string
}

export interface TableDetails {
  name: string
  schema: string
  kind: 'table' | 'view'
  columns: ColumnInfo[]
  primaryKey: string[]
  indexes: IndexInfo[]
  foreignKeys: ForeignKeyInfo[]
  ddl?: string
}

export interface SavedQueryEntry {
  id: string
  name: string
  sql: string
  description?: string
  dialect?: DatabaseDriverType
  tags?: string[]
  createdAt: number
  updatedAt: number
}

export interface QueryHistoryEntry {
  id: string
  timestamp: number
  connectionId: string
  connectionName: string
  driver: DatabaseDriverType
  sql: string
  durationMs: number
  rowCount: number
  isError: boolean
  errorMessage?: string
}

export interface DataChangesInput {
  connectionId: string
  table: string
  schema?: string
  inserts?: Record<string, unknown>[]
  updates?: {
    primaryKeys: Record<string, unknown>
    changes: Record<string, unknown>
    originalRow?: Record<string, unknown>
  }[]
  deletes?: Record<string, unknown>[]
}

export interface QueryResultSourceTable {
  table: string
  schema?: string
}

export interface QueryResultSet {
  index: number
  sqlPreview?: string
  columns: { name: string; type: string }[]
  rows: unknown[][]
  rowCount: number
  affectedRows?: number
  truncated: boolean
  isSelect: boolean
  sourceTable?: QueryResultSourceTable
}

export interface QueryResult {
  columns: { name: string; type: string }[]
  rows: unknown[][]
  rowCount: number
  affectedRows?: number
  executionTimeMs: number
  truncated: boolean
  isSelect: boolean
  sourceTable?: QueryResultSourceTable
  resultSets?: QueryResultSet[]
}

export interface TableBrowseResult {
  columns: TableDetails['columns']
  rows: Record<string, unknown>[]
  totalRows: number
  page: number
  pageSize: number
  primaryKey: string[]
  canEdit: boolean
}

export interface TransactionState {
  active: boolean
  autoCommit: boolean
  statementCount: number
  startedAt?: number
  supported: boolean
  reason?: string
  aborted?: boolean
}

/** Storage key for persisting saved connections */
export const SAVED_CONNECTIONS_STORAGE_KEY = 'datanoa.savedConnections'

/** Storage key for active connection */
export const ACTIVE_CONNECTION_STORAGE_KEY = 'datanoa.activeConnectionId'

interface DatanoaPluginRequests {
  'connections.list': {
    input?: Record<string, never>
    output: ConnectionProfile[]
  }
  'connection.save': {
    input: {
      profile: ConnectionProfile
      password?: string
      authToken?: string
      sslKeyPassphrase?: string
      sshPassphrase?: string
      sshPassword?: string
      sourceConnectionId?: string
    }
    output: { ok: boolean; id: string }
  }
  'connection.delete': {
    input: { id: string }
    output: { ok: boolean }
  }
  'connection.test': {
    input: {
      profile: ConnectionProfile
      password?: string
      authToken?: string
      sslKeyPassphrase?: string
      sshPassphrase?: string
      sshPassword?: string
      sourceConnectionId?: string
    }
    output: { ok: boolean; message?: string }
  }
  'connection.parseUri': {
    input: { uri: string }
    output: {
      ok: boolean
      profile?: Partial<ConnectionProfile>
      password?: string
      authToken?: string
      placeholderPassword?: boolean
      error?: string
    }
  }
  'schema.listObjects': {
    input: { connectionId: string; schema?: string }
    output: SchemaObject[]
  }
  'schema.tableDetails': {
    input: { connectionId: string; table: string; schema?: string }
    output: TableDetails
  }
  'schema.listSchemas': {
    input: { connectionId: string }
    output: { schemas: string[]; defaultSchema: string }
  }
  'schema.getObjectDdl': {
    input: { connectionId: string; name: string; kind: SchemaObjectKind; schema?: string }
    output: { ddl: string }
  }
  'schema.exportSchemaDdl': {
    input: { connectionId: string; schema?: string }
    output: { ddl: string; objectCount: number; fileName: string }
  }
  'data.fetchPage': {
    input: {
      connectionId: string
      table: string
      schema?: string
      page: number
      pageSize: number
      sortColumn?: string
      sortDirection?: 'ASC' | 'DESC'
      whereClause?: string
      orderByClause?: string
    }
    output: TableBrowseResult
  }
  'data.updateCell': {
    input: {
      connectionId: string
      table: string
      schema?: string
      primaryKeys: Record<string, unknown>
      column: string
      newValue: unknown
      originalValue?: unknown
    }
    output: { ok: boolean; affectedRows: number; updatedRecord?: Record<string, unknown> }
  }
  'query.run': {
    input: {
      connectionId: string
      queryId: string
      sql: string
      maxRows?: number
    }
    output: QueryResult
  }
  'query.cancel': {
    input: { queryId: string }
    output: { ok: boolean }
  }
  'sqlite.scanFolder': {
    input: { folderPath?: string }
    output: { files: { name: string; filePath: string; sizeBytes: number; sizeLabel: string }[] }
  }
  'studio.open': {
    input: { connectionId?: string; table?: string; schema?: string; sql?: string }
    output: { ok: boolean; path?: string; message?: string }
  }
  'workspace.detectConnections': {
    input: { folderPath?: string }
    output: {
      sqliteFiles: { name: string; filePath: string; sizeBytes: number; sizeLabel: string }[]
      envConnections: {
        envKey: string
        sourceFile: string
        driver: DatabaseDriverType
        name: string
        uri: string
      }[]
    }
  }
  'data.applyChanges': {
    input: DataChangesInput
    output: {
      ok: boolean
      inserted: number
      updated: number
      deleted: number
      statements: string[]
    }
  }
  'data.previewChanges': {
    input: DataChangesInput
    output: { statements: string[] }
  }
  'schema.generateDdl': {
    input: { connectionId: string; table: string; schema?: string }
    output: { ddl: string }
  }
  'query.explain': {
    input: { connectionId: string; sql: string; queryId?: string }
    output: QueryResult
  }
  'query.history.list': {
    input: { limit?: number } | undefined
    output: { entries: QueryHistoryEntry[] }
  }
  'query.history.clear': {
    input?: Record<string, never>
    output: { ok: boolean }
  }
  'queries.saved.list': {
    input?: Record<string, never>
    output: { entries: SavedQueryEntry[] }
  }
  'queries.saved.save': {
    input: {
      id?: string
      name: string
      sql: string
      description?: string
      dialect?: DatabaseDriverType
      tags?: string[]
    }
    output: { ok: boolean; entry: SavedQueryEntry }
  }
  'queries.saved.delete': {
    input: { id: string }
    output: { ok: boolean }
  }
  'tx.status': {
    input: { connectionId: string }
    output: TransactionState
  }
  'tx.begin': {
    input: { connectionId: string }
    output: TransactionState
  }
  'tx.commit': {
    input: { connectionId: string }
    output: TransactionState
  }
  'tx.rollback': {
    input: { connectionId: string }
    output: TransactionState
  }
  'tx.setAutoCommit': {
    input: { connectionId: string; enabled: boolean }
    output: TransactionState
  }
  'drivers.list': {
    input?: Record<string, never>
    output: { drivers: DriverRegistryItem[] }
  }
  'drivers.inspectLocal': {
    input: { driverId: string; localPath: string }
    output: DriverInspectResult
  }
  'drivers.configureLocal': {
    input: { driverId: string; localPath: string; name?: string; trustedSha256: string }
    output: { ok: boolean; item: DriverRegistryItem }
  }
  'drivers.verify': {
    input: { driverId: string; trustedSha256?: string }
    output: DriverVerifyResult
  }
  'drivers.removeLocal': {
    input: { driverId: string }
    output: { ok: boolean }
  }
  'drivers.defaultPaths': {
    input?: Record<string, never>
    output: {
      baseDir: string
      platform: string
      paths: Record<string, string>
      templates?: Record<string, string>
    }
  }
  'drivers.setupLocal': {
    input: {
      driverId: string
      localPath: string
      autoTrust?: boolean
    }
    output: {
      ok: boolean
      dirPath: string
      entryPath: string
      wroteCanonicalEntry?: boolean
      installPackage?: string
      inspect: DriverInspectResult
      item?: DriverRegistryItem
    }
  }
  'fs.listDir': {
    input?: { dir?: string; mode?: 'file' | 'folder'; extensions?: string[]; strictDir?: boolean }
    output: {
      ok: boolean
      currentDir: string
      parentDir: string | null
      roots: string[]
      entries: Array<{
        name: string
        path: string
        kind: 'dir' | 'file'
        size?: number
      }>
      truncated?: boolean
      error?: string
    }
  }
  'workspace.listScopes': {
    input?: Record<string, never>
    output: {
      currentScopeId: string
      currentScopeLabel: string
      workspaces: Array<{
        id: string
        name: string
        branch?: string
        path?: string
        projectFolder: string
        label: string
        isCurrent: boolean
      }>
    }
  }
  'ui.getSessionSnapshot': {
    input: { surface?: 'panel' | 'studio' }
    output: {
      viewState: Record<string, unknown> | null
      dataCache: Record<string, unknown> | null
      updatedAt: number
    }
  }
  'ui.saveSessionSnapshot': {
    input: {
      surface?: 'panel' | 'studio'
      viewState?: Record<string, unknown> | null
      dataCache?: Record<string, unknown> | null
    }
    output: { ok: true; updatedAt: number }
  }
}

type WithLegacyRequestAliases<T extends { output: unknown }> = T &
  (T extends { input: infer I }
    ? { params: I }
    : T extends { input?: infer I }
      ? { params?: Exclude<I, undefined> }
      : { params?: never }) & {
    response: T['output']
  }

export type PluginRequests = {
  [K in keyof DatanoaPluginRequests]: WithLegacyRequestAliases<DatanoaPluginRequests[K]>
}

export type DriverRegistryCategory = 'builtin' | 'local-byod'
export type DriverRegistryStatus = 'builtin' | 'local-verified' | 'local-error' | 'not-configured'

export interface DriverInspectResult {
  ok: boolean
  driverId: string
  localPath: string
  resolvedEntry: string
  sha256: string
  byteLength: number
  scopeNote: string
}

export interface DriverRegistryItem {
  id: string
  name: string
  description: string
  category: DriverRegistryCategory
  transport: string
  packaging: string
  status: DriverRegistryStatus
  localPath?: string
  resolvedEntry?: string
  sha256?: string
  verifiedAt?: number
  error?: string
}

export interface PersistedLocalDriverConfig {
  id: string
  name?: string
  localPath: string
  resolvedEntry: string
  sha256: string
  verifiedAt: number
}

export interface DriverVerifyResult {
  ok: boolean
  sha256Changed: boolean
  requiresTrust?: boolean
  pendingSha256?: string
  item: DriverRegistryItem
  message: string
}

interface DatanoaPluginPanelEvents {
  'connections.changed': { count: number }
  'data.cellUpdated': {
    connectionId?: string
    schema?: string
    table: string
    primaryKeys: Record<string, unknown>
    column: string
  }
}

export type PluginPanelEvents = DatanoaPluginPanelEvents

/**
 * Recursively converts any payload into a strict Orca JsonValue:
 * - Strips keys with `undefined` values from objects (Orca rejects `undefined` as invalid_params)
 * - Normalizes null-prototype objects from `node:sqlite` into standard plain objects
 * - Converts BigInt, Date, Uint8Array/Buffer, and non-finite numbers into safe JSON values
 */
export function sanitizeJsonPayload<T>(value: T): T {
  if (value === undefined || value === null) {
    return value
  }
  if (typeof value === 'boolean' || typeof value === 'string') {
    return value
  }
  if (typeof value === 'number') {
    return (Number.isFinite(value) ? value : null) as unknown as T
  }
  if (typeof value === 'bigint') {
    const asNum = Number(value)
    return (Number.isSafeInteger(asNum) ? asNum : value.toString()) as unknown as T
  }
  if (value instanceof Date) {
    return (Number.isNaN(value.getTime()) ? null : value.toISOString()) as unknown as T
  }
  if (value instanceof ArrayBuffer) {
    return `[BLOB ${value.byteLength} B]` as unknown as T
  }
  if (ArrayBuffer.isView(value)) {
    return `[BLOB ${value.byteLength} B]` as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : sanitizeJsonPayload(item)
    ) as unknown as T
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined && typeof v !== 'function' && typeof v !== 'symbol') {
        out[k] = sanitizeJsonPayload(v)
      }
    }
    return out as unknown as T
  }
  return null as unknown as T
}

declare module 'orca' {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface PluginRequests extends DatanoaPluginRequests {}

  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface PluginPanelEvents extends DatanoaPluginPanelEvents {}
}
