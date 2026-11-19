// D:\orca-custom-extensions\datanoa\src\protocol.ts
// Type-safe IPC request-response and event protocol for Datanoa DB Studio

export type DatabaseDriverType = 'sqlite' | 'postgres' | 'mysql' | 'mariadb' | 'cockroachdb' | 'clickhouse' | 'redis' | 'libsql'

export type ConnectionColorTag = 'none' | 'dev' | 'staging' | 'prod'

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
  colorTag?: ConnectionColorTag
  options?: string
}

export interface SchemaObject {
  name: string
  schema: string
  kind: 'table' | 'view'
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

export interface QueryResult {
  columns: { name: string; type: string }[]
  rows: unknown[][]
  rowCount: number
  affectedRows?: number
  executionTimeMs: number
  truncated: boolean
  isSelect: boolean
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

/** Storage key for persisting saved connections */
export const SAVED_CONNECTIONS_STORAGE_KEY = 'datanoa.savedConnections'

/** Storage key for active connection */
export const ACTIVE_CONNECTION_STORAGE_KEY = 'datanoa.activeConnectionId'

export interface PluginRequests {
  'connections.list': {
    input?: Record<string, never>
    output: ConnectionProfile[]
    params: Record<string, never>
    response: ConnectionProfile[]
  }
  'connection.save': {
    input: {
      profile: ConnectionProfile
      password?: string
      authToken?: string
      sourceConnectionId?: string
    }
    output: { ok: boolean; id: string }
    params: {
      profile: ConnectionProfile
      password?: string
      authToken?: string
      sourceConnectionId?: string
    }
    response: { ok: boolean; id: string }
  }
  'connection.delete': {
    input: { id: string }
    output: { ok: boolean }
    params: { id: string }
    response: { ok: boolean }
  }
  'connection.test': {
    input: {
      profile: ConnectionProfile
      password?: string
      authToken?: string
      sourceConnectionId?: string
    }
    output: { ok: boolean; message?: string }
    params: {
      profile: ConnectionProfile
      password?: string
      authToken?: string
      sourceConnectionId?: string
    }
    response: { ok: boolean; message?: string }
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
    params: { uri: string }
    response: {
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
    params: { connectionId: string; schema?: string }
    response: SchemaObject[]
  }
  'schema.tableDetails': {
    input: { connectionId: string; table: string; schema?: string }
    output: TableDetails
    params: { connectionId: string; table: string; schema?: string }
    response: TableDetails
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
    params: {
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
    response: TableBrowseResult
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
    params: {
      connectionId: string
      table: string
      schema?: string
      primaryKeys: Record<string, unknown>
      column: string
      newValue: unknown
      originalValue?: unknown
    }
    response: { ok: boolean; affectedRows: number; updatedRecord?: Record<string, unknown> }
  }
  'query.run': {
    input: {
      connectionId: string
      queryId: string
      sql: string
      maxRows?: number
    }
    output: QueryResult
    params: {
      connectionId: string
      queryId: string
      sql: string
      maxRows?: number
    }
    response: QueryResult
  }
  'query.cancel': {
    input: { queryId: string }
    output: { ok: boolean }
    params: { queryId: string }
    response: { ok: boolean }
  }
  'sqlite.scanFolder': {
    input: { folderPath?: string }
    output: { files: { name: string; filePath: string; sizeBytes: number; sizeLabel: string }[] }
    params: { folderPath?: string }
    response: { files: { name: string; filePath: string; sizeBytes: number; sizeLabel: string }[] }
  }
  'studio.open': {
    input: { connectionId?: string; table?: string; schema?: string; sql?: string }
    output: { ok: boolean; path?: string; message?: string }
    params: { connectionId?: string; table?: string; schema?: string; sql?: string }
    response: { ok: boolean; path?: string; message?: string }
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
    params: { folderPath?: string }
    response: {
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
    params: DataChangesInput
    response: {
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
    params: DataChangesInput
    response: { statements: string[] }
  }
  'schema.generateDdl': {
    input: { connectionId: string; table: string; schema?: string }
    output: { ddl: string }
    params: { connectionId: string; table: string; schema?: string }
    response: { ddl: string }
  }
  'query.explain': {
    input: { connectionId: string; sql: string; queryId?: string }
    output: QueryResult
    params: { connectionId: string; sql: string; queryId?: string }
    response: QueryResult
  }
  'query.history.list': {
    input: { limit?: number } | undefined
    output: { entries: QueryHistoryEntry[] }
    params: { limit?: number } | undefined
    response: { entries: QueryHistoryEntry[] }
  }
  'query.history.clear': {
    input?: Record<string, never>
    output: { ok: boolean }
    params: Record<string, never>
    response: { ok: boolean }
  }
}

export interface PluginPanelEvents {
  'connections.changed': { count: number }
  'data.cellUpdated': {
    connectionId?: string
    schema?: string
    table: string
    primaryKeys: Record<string, unknown>
    column: string
  }
}

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
  interface PluginRequests {
    'connections.list': {
      input?: Record<string, never>
      output: ConnectionProfile[]
    }
    'connection.save': {
      input: {
        profile: ConnectionProfile
        password?: string
        authToken?: string
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
  }

  interface PluginPanelEvents {
    'connections.changed': { count: number }
    'data.cellUpdated': {
      connectionId?: string
      schema?: string
      table: string
      primaryKeys: Record<string, unknown>
      column: string
    }
  }
}
