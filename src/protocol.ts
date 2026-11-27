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
  | 'mssql'
  | 'oracle'
  | 'mongodb'

export type ConnectionColorTag = 'none' | 'dev' | 'staging' | 'prod'

/** Per-connection AI policy controlling whether SQL/schema context may be sent to AI providers. */
export type ConnectionAiPolicy = 'allow' | 'ask' | 'never'

/** TLS negotiation mode for TCP engines (`auto` keeps legacy profile.ssl / cloud auto-SSL behaviour) */
export type SslMode = 'auto' | 'disable' | 'require' | 'verify-ca' | 'verify-full' | 'strict'

/** Studio editor pane / visualization mode */
export type StudioViewMode = 'split' | 'grid' | 'sql' | 'inspector' | 'er'

/** SSH bastion authentication method (non-interactive; OS `ssh -N -L` or in-process ssh2) */
export type SshAuthMethod = 'agent' | 'key' | 'password'

/** Intermediate SSH jump-host hop preceding the final SSH bastion */
export interface SshJumpHostProfile {
  hopId: string
  host: string
  port?: number
  user?: string
  authMethod?: SshAuthMethod
  privateKeyPath?: string
  hasPassphrase?: boolean
  hasPassword?: boolean
}

/** Ephemeral per-hop SSH secret payload passed during connection.save / connection.test (never stored on profile) */
export interface SshJumpHopSecret {
  password?: string
  passphrase?: string
}

export type SshHostKeyChallengeReason = 'unknown' | 'mismatch' | 'revoked'
export type SshHostKeyDecision = 'trust-once' | 'save' | 'replace' | 'cancel'

export interface SshHostKeyChallenge {
  challengeId: string
  panelId?: string
  connectionId?: string
  host: string
  port: number
  keyType: string
  keyBlob: string
  fingerprintSha256: string
  reason: SshHostKeyChallengeReason
  knownHostsPath?: string
  knownHostsReadOnly?: boolean
  line?: number
  existingFingerprintSha256?: string
  existingKeyType?: string
  hopIndex?: number
  hopCount?: number
  retryToken?: string
}

export type TlsFailureKind =
  | 'ServerRequiresTls'
  | 'ServerRefusedTls'
  | 'ServerRequiresStrict'
  | 'ServerRefusedStrict'
  | 'UnknownIssuer'
  | 'NameMismatch'
  | 'Expired'
  | 'NotYetValid'
  | 'Revoked'
  | 'HandshakeRejected'
  | 'CaFileInvalid'
  | 'ClientIdentityInvalid'
  | 'Other'

export type TlsRemedyAction = 'ChangeEncryption' | 'ChooseCaCert' | 'SetServerName'

export interface TlsFailure {
  kind: TlsFailureKind
  summary: string
  detail?: string
  canRetryWithFix: boolean
  remedy?: TlsRemedyAction
  suggestedSslMode?: SslMode
  suggestedServerName?: string
  certificateSubject?: string
  certificateIssuer?: string
  certificateSan?: string[]
  validFrom?: string
  validTo?: string
  fingerprintSha256?: string
}

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
  tlsServername?: string
  // --- SSH Tunnel (bastion) ---
  sshEnabled?: boolean
  sshHost?: string
  sshPort?: number
  sshUser?: string
  sshAuthMethod?: SshAuthMethod
  sshPrivateKeyPath?: string
  hasSshPassphrase?: boolean
  hasSshPassword?: boolean
  /** Optional ordered intermediate SSH jump hosts preceding the final bastion */
  sshJumpHosts?: SshJumpHostProfile[]
  /** Optional per-connection AI policy override ('allow' | 'ask' | 'never'). */
  aiPolicy?: ConnectionAiPolicy
}

/** Connection profile payload accepted on save/test where `aiPolicy: null` explicitly clears any stored override. */
export type ConnectionProfileInput = Omit<ConnectionProfile, 'aiPolicy'> & {
  aiPolicy?: ConnectionAiPolicy | null
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
  generatedExpression?: string
  generatedStorage?: 'STORED' | 'VIRTUAL'
  collate?: string
}

export interface IndexInfo {
  name: string
  isUnique: boolean
  isPrimary: boolean
  columns: string[]
  origin?: 'c' | 'u' | 'pk'
  columnSpecs?: Array<{ name: string; collate?: string; desc?: boolean }>
  onConflict?: string
  whereClause?: string
  partial?: boolean
  isExpression?: boolean
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
  inboundForeignKeys?: Array<{
    fromTable: string
    fromColumn: string
    toColumn: string
    onDelete?: string
  }>
  triggers?: Array<{ name: string; sql: string }>
  checkConstraints?: string[]
  strict?: boolean
  withoutRowid?: boolean
  ddl?: string
  /** Introspection completeness ('lite' from ER fallback vs 'full' with DDL/triggers/inbound FKs) */
  completeness?: 'lite' | 'full'
}

export interface SchemaCatalogObjectsResult {
  data: SchemaObject[]
  stale: boolean
  staleReason?: string
  cachedAt: number
  revision: number
  generation?: number
  truncated?: boolean
}

export interface SchemaErColumn {
  name: string
  type: string
  nullable: boolean
  isPrimaryKey: boolean
  isForeignKey?: boolean
  isUnique?: boolean
}

export interface SchemaErNode {
  id: string
  schema: string
  name: string
  kind: 'table' | 'view' | 'external_stub'
  columns: SchemaErColumn[]
  primaryKey: string[]
  uniqueColumnSets?: string[][]
}

export interface SchemaErEdgeColumnPair {
  fromColumn: string
  toColumn: string
}

export interface SchemaErEdge {
  id: string
  constraintName?: string
  fromNodeId: string
  toNodeId: string
  fromSchema: string
  fromTable: string
  toSchema: string
  toTable: string
  columnPairs: SchemaErEdgeColumnPair[]
  unique: boolean
  optional: boolean
  crossSchema?: boolean
  onDelete?: string
  onUpdate?: string
}

export interface SchemaErGraph {
  connectionId: string
  schema?: string
  completeness: 'full' | 'lite'
  truncated?: boolean
  totalTableCount?: number
  nodes: SchemaErNode[]
  edges: SchemaErEdge[]
  generatedAt: number
}

export type ConditionalHighlightOperator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'like'
  | 'not_like'
  | 'ilike'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'in'
  | 'not_in'
  | 'is_null'
  | 'is_not_null'
  | 'regex'

export type ConditionalHighlightTone = 'info' | 'ok' | 'warn' | 'danger' | 'accent'

export interface ConditionalHighlightRule {
  id: string
  enabled: boolean
  column: string
  operator: ConditionalHighlightOperator
  value?: string
  valueTo?: string
  values?: string[]
  caseSensitive?: boolean
  target: 'row' | 'cell'
  tone: ConditionalHighlightTone
}

export interface TableDisplayStateEntry {
  columnOrder?: string[]
  hiddenColumns?: string[]
  pinnedColumns?: string[]
  columnWidths?: Record<string, number>
  wrapCells?: boolean
  wrapMaxLines?: number
  highlightRules?: ConditionalHighlightRule[]
  updatedAt: number
  revision: number
}

export interface ErNodePosition {
  x: number
  y: number
}

export interface ErLayoutStateEntry {
  positions: Record<string, ErNodePosition>
  compactMode?: boolean
  hideOrphans?: boolean
  collapseJunctions?: boolean
  updatedAt: number
  revision: number
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
  deleteRows?: Record<string, unknown>[]
}

export interface QueryResultSourceTable {
  table: string
  schema?: string
}

export type ExplainSeverity = 'critical' | 'high' | 'moderate' | 'low' | 'neutral'

export interface ExplainMissingIndex {
  table: string
  equalityColumns?: string[]
  inequalityColumns?: string[]
  includeColumns?: string[]
  impact?: number
  ddl: string
}

export interface ExplainPlanNode {
  id: string
  parentId: string | null
  nodeType: string
  relation?: string
  alias?: string
  indexName?: string
  joinType?: string
  startupCost?: number | null
  totalCost?: number | null
  exclusiveCost?: number | null
  costFraction?: number | null
  planRows?: number | null
  planWidth?: number | null
  actualStartupTimeMs?: number | null
  actualTotalTimeMs?: number | null
  exclusiveTimeMs?: number | null
  timeFraction?: number | null
  actualRows?: number | null
  totalActualRows?: number | null
  actualLoops?: number | null
  workersPlanned?: number | null
  workersLaunched?: number | null
  processCount?: number
  isInitPlan?: boolean
  severity?: ExplainSeverity
  warnings?: string[]
  details?: Record<string, string | number | boolean>
  children: ExplainPlanNode[]
}

export interface ParsedExplainPlan {
  format: string
  dialect?: DatabaseDriverType
  planningTimeMs?: number | null
  executionTimeMs?: number | null
  totalCost?: number | null
  totalExclusiveCost?: number | null
  totalActualTimeMs?: number | null
  nodeCount: number
  truncated?: boolean
  warnings?: string[]
  missingIndexes?: ExplainMissingIndex[]
  root: ExplainPlanNode | null
  rawText?: string
}

export interface QueryResultSet {
  index: number
  sqlPreview?: string
  sql?: string
  executionTimeMs?: number
  isError?: boolean
  errorMessage?: string
  columns: { name: string; type: string }[]
  rows: unknown[][]
  rowCount: number
  affectedRows?: number
  truncated: boolean
  isSelect: boolean
  sourceTable?: QueryResultSourceTable
  explainPlan?: ParsedExplainPlan
}

export interface QueryExecutionError {
  message: string
  code?: string
  failedStatementIndex?: number
  statementCount?: number
  tlsFailure?: TlsFailure
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
  executionError?: QueryExecutionError
  explainPlan?: ParsedExplainPlan
}

export interface TableBrowseResult {
  columns: TableDetails['columns']
  rows: Record<string, unknown>[]
  totalRows: number
  page: number
  pageSize: number
  primaryKey: string[]
  canEdit: boolean
  /** True when response compaction truncated rows or cell payloads to fit IPC limits. */
  truncated?: boolean
}

export interface TransactionState {
  active: boolean
  autoCommit: boolean
  statementCount: number
  startedAt?: number
  supported: boolean
  reason?: string
  aborted?: boolean
  txToken?: number
}

export type DockerComposeDriverType =
  | Exclude<DatabaseDriverType, 'sqlite' | 'd1'>
  | 'mssql'
  | 'oracle'
  | 'mongodb'

export interface DiscoveredDockerComposeConnection {
  id: string
  candidateId?: string
  project: string
  service: string
  driver: DockerComposeDriverType
  name: string
  host: string
  port: number
  database: string
  user?: string
  password?: string
  hasPassword?: boolean
  url?: string
  redisDb?: number
  ssl?: boolean
  sourceKind: 'live' | 'file'
  sourceFile: string
  status: string
  workspaceMatched: boolean
  hint?: string
  unpublishedPort?: boolean
  passwordFromFile?: string
}

export interface ParsedConnectionUriResult {
  ok: boolean
  profile?: Partial<ConnectionProfile>
  password?: string
  authToken?: string
  placeholderPassword?: boolean
  error?: string
}

/** Storage key for persisting saved connections */
export const SAVED_CONNECTIONS_STORAGE_KEY = 'datanoa.savedConnections'

/** Storage key for persisting custom connection folder order */
export const SAVED_FOLDER_ORDER_STORAGE_KEY = 'datanoa.folderOrder'

/** Storage key for active connection */
export const ACTIVE_CONNECTION_STORAGE_KEY = 'datanoa.activeConnectionId'

export interface AiInlineEdit {
  fromOffset: number
  toOffset: number
  insert: string
}

interface DatanoaPluginRequests {
  'connections.list': {
    input?: Record<string, never>
    output: ConnectionProfile[]
  }
  'connection.save': {
    input: {
      profile: ConnectionProfileInput
      password?: string
      authToken?: string
      sslKeyPassphrase?: string
      sshPassphrase?: string
      sshPassword?: string
      sshJumpHopSecrets?: Record<string, SshJumpHopSecret>
      sshExplicitlyDisabled?: boolean
      sourceConnectionId?: string
    }
    output: { ok: boolean; id: string }
  }
  'connection.delete': {
    input: { id: string }
    output: { ok: boolean }
  }
  'connections.reorder': {
    input: {
      folder?: string
      orderedIds: string[]
    }
    output: {
      ok: boolean
      changed: boolean
      connections: ConnectionProfile[]
    }
  }
  'folders.order.get': {
    input?: Record<string, never>
    output: {
      folderOrder: string[]
    }
  }
  'folders.reorder': {
    input: {
      orderedFolders: string[]
    }
    output: {
      ok: boolean
      changed: boolean
      folderOrder: string[]
    }
  }
  'connection.test': {
    input: {
      profile: ConnectionProfileInput
      password?: string
      authToken?: string
      sslKeyPassphrase?: string
      sshPassphrase?: string
      sshPassword?: string
      sshJumpHopSecrets?: Record<string, SshJumpHopSecret>
      sourceConnectionId?: string
      sshRetryToken?: string
    }
    output: {
      ok: boolean
      message?: string
      tlsFailure?: TlsFailure
      sshChallenge?: SshHostKeyChallenge
    }
  }
  'ssh.hostKey.resolve': {
    input: {
      challengeId: string
      decision: SshHostKeyDecision
    }
    output: {
      ok: boolean
      decision: SshHostKeyDecision
      savedPath?: string
      challenge?: SshHostKeyChallenge
      retryToken?: string
    }
  }
  'connection.parseUri': {
    input: { uri?: string; candidateId?: string }
    output: ParsedConnectionUriResult
  }
  'schema.listObjects': {
    input: { connectionId: string; schema?: string }
    output: SchemaObject[]
  }
  'schema.listObjectsCatalog': {
    input: { connectionId: string; schema?: string; forceRefresh?: boolean }
    output: SchemaCatalogObjectsResult
  }
  'schema.erGraph': {
    input: {
      connectionId: string
      schema?: string
      includeViews?: boolean
      forceRefresh?: boolean
    }
    output: SchemaErGraph
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
      templateSql?: string
      historySql?: string
      maxRows?: number
      structuredError?: boolean
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
    input: {
      connectionId?: string
      table?: string
      schema?: string
      sql?: string
      viewMode?: StudioViewMode
      action?: 'import'
    }
    output: { ok: boolean; path?: string; message?: string; navToken?: string }
  }
  'studio.navToken.consume': {
    input: { navToken: string }
    output: { consumed: boolean; alreadyConsumed: boolean }
  }
  'workspace.detectConnections': {
    input: { folderPath?: string }
    output: {
      sqliteFiles: { name: string; filePath: string; sizeBytes: number; sizeLabel: string }[]
      envConnections: {
        candidateId?: string
        envKey: string
        sourceFile: string
        driver: DatabaseDriverType
        name: string
        uri: string
      }[]
      dockerComposeConnections: DiscoveredDockerComposeConnection[]
      scannedDirs?: string[]
    }
  }
  'workspace.resolveDetectedCandidate': {
    input: { candidateId: string }
    output: {
      ok: boolean
      parsed?: ParsedConnectionUriResult
      password?: string
      authToken?: string
      url?: string
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
  'data.copyImport.open': {
    input: {
      connectionId: string
      table: string
      schema?: string
      columns: string[]
    }
    output: {
      ok: boolean
      importId?: string
      fallbackReason?: string
      useLegacyBatch?: boolean
    }
  }
  'data.copyImport.write': {
    input: {
      importId: string
      rows: Array<Record<string, unknown> | unknown[]>
    }
    output: {
      ok: boolean
      bytesWritten: number
      rowCount: number
    }
  }
  'data.copyImport.commit': {
    input: {
      importId: string
    }
    output: {
      ok: boolean
      inserted: number
    }
  }
  'data.copyImport.abort': {
    input: {
      importId: string
      reason?: string
    }
    output: {
      ok: boolean
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
    input: {
      connectionId: string
      sql: string
      templateSql?: string
      historySql?: string
      queryId?: string
    }
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
    input: { connectionId: string; onlyIfOwner?: boolean; txToken?: number }
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
  'ui.tableDisplayState.get': {
    input: { tableKey: string }
    output: {
      tableKey: string
      entry: TableDisplayStateEntry | null
      revision: number
    }
  }
  'ui.tableDisplayState.patch': {
    input: {
      tableKey: string
      patch: Partial<Omit<TableDisplayStateEntry, 'updatedAt' | 'revision'>>
      baseRevision?: number
    }
    output: {
      ok: boolean
      tableKey: string
      entry: TableDisplayStateEntry | null
      revision: number
    }
  }
  'ui.tableDisplayState.reset': {
    input: { tableKey?: string; connectionId?: string }
    output: { ok: boolean; removedCount: number }
  }
  'ui.erLayoutState.get': {
    input: { schemaKey: string }
    output: {
      schemaKey: string
      entry: ErLayoutStateEntry | null
      revision: number
    }
  }
  'ui.erLayoutState.patch': {
    input: {
      schemaKey: string
      patch: Partial<Omit<ErLayoutStateEntry, 'updatedAt' | 'revision'>>
    }
    output: {
      ok: boolean
      schemaKey: string
      entry: ErLayoutStateEntry | null
      revision: number
    }
  }
  'ui.erLayoutState.reset': {
    input: { schemaKey?: string; connectionId?: string }
    output: { ok: boolean; removedCount: number }
  }
  'ai.status.get': {
    input?: Record<string, never>
    output: AiStatusSnapshot
  }
  'ai.key.set': {
    input: { key: string; baseUrl?: string; role?: AiRole; clearSynced?: boolean }
    output: { hasKey: boolean; role?: AiRole }
  }
  'ai.provider.test': {
    input:
      | {
          role?: AiRole
          format?: AiProviderFormat
          baseUrl?: string
          model?: string
          key?: string
        }
      | undefined
    output: { ok: boolean; message: string; ms: number | null; role?: AiRole }
  }
  'ai.models.list': {
    input: { format: AiProviderFormat; baseUrl: string; key: string; role?: AiRole }
    output: { ok: boolean; models: string[]; message: string }
  }
  'ai.models.bench': {
    input: { format: AiProviderFormat; baseUrl: string; key: string; models: string[]; role?: AiRole }
    output: { results: { model: string; ok: boolean; ms: number | null }[]; message: string }
  }
  'ai.models.usage': {
    input: { baseUrl: string }
    output: { usage: Record<string, { ms: number; uses: number }> }
  }
  'ai.stats.get': {
    input?: Record<string, never>
    output: AiStatsSnapshot
  }
  'ai.stats.reset': {
    input?: Record<string, never>
    output: Record<string, never>
  }
  'ai.metrics.event': {
    input: { id: number; kind: AiMetricKind }
    output: Record<string, never>
  }
  'ai.complete': {
    input: {
      connectionId?: string
      fromConnection?: boolean
      dialect: DatabaseDriverType
      prefix: string
      suffix: string
      activeSchema?: string
      activeTable?: string
      schemaMap?: Record<string, string[]>
      manual?: boolean
      mode?: 'auto' | 'complete' | 'edit'
      confirmed?: boolean
    }
    output: {
      suggestion: string
      id: number
      replaceChars?: number
      edits?: AiInlineEdit[]
      mode?: 'complete' | 'edit'
    }
  }
  'ai.explainAnalyze': {
    input: {
      connectionId?: string
      fromConnection?: boolean
      dialect: DatabaseDriverType
      sql: string
      planColumns: { name: string; type: string }[]
      planRows: unknown[][]
      explainPlan?: ParsedExplainPlan
      activeSchema?: string
      language?: AiExplainLanguage
      uiLocale?: string
      confirmed?: boolean
    }
    output: AiExplainAnalysisResult
  }
  'ai.fixQuery': {
    input: {
      connectionId?: string
      fromConnection?: boolean
      dialect: DatabaseDriverType
      sql: string
      errorMessage: string
      activeSchema?: string
      activeTable?: string
      schemaMap?: Record<string, string[]>
      language?: AiExplainLanguage
      uiLocale?: string
      confirmed?: boolean
    }
    output: AiFixQueryResult
  }
}

export type AiProviderFormat = 'openai' | 'anthropic' | 'ollama' | 'mistral-fim'

export type AiPresetId =
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'ollama'
  | 'mistral'
  | 'custom-openai'
  | 'custom-anthropic'

export type AiStatusState = 'on' | 'off' | 'setup' | 'slow' | 'error'

export type AiExplainLanguage =
  | 'auto'
  | 'vi'
  | 'en'
  | 'ja'
  | 'zh'
  | 'ko'
  | 'es'
  | 'fr'
  | 'de'
  | 'pt'

export type AiMetricKind = 'shown' | 'accepted' | 'partial' | 'kept' | 'undone' | 'stale'

export type AiRole = 'autocomplete' | 'explain'

export interface AiRoleStatus {
  enabled: boolean
  state: AiStatusState
  reason: string | null
  format: AiProviderFormat
  baseUrl: string
  host: string
  model: string
  hasKey: boolean
  usingSharedKey?: boolean
  destination: 'none' | 'local' | 'remote'
}

export interface AiStatusSnapshot {
  enabled: boolean
  state: AiStatusState
  lastMs: number | null
  suggested: number
  reason: string | null
  format: AiProviderFormat
  baseUrl: string
  host: string
  model: string
  maxTokens: number
  explainMaxTokens: number
  explainLanguage: AiExplainLanguage
  hasKey: boolean
  destination: 'none' | 'local' | 'remote'
  sync: boolean
  roles: {
    autocomplete: AiRoleStatus
    explain: AiRoleStatus
  }
}

export interface AiStatsSnapshot {
  model: string
  since: number
  summary: {
    shown: number
    accepted: number
    partial: number
    kept: number
    undone: number
    stale: number
    p50: number | null
    p95: number | null
    samples: number
  }
}

export interface AiExplainBottleneck {
  title: string
  detail: string
  severity: 'high' | 'medium' | 'low'
}

export interface AiExplainIndexSuggestion {
  ddl: string
  reason: string
}

export interface AiExplainAnalysisResult {
  summary: string
  bottlenecks: AiExplainBottleneck[]
  optimizedSql: string | null
  indexSuggestions: AiExplainIndexSuggestion[]
  caveats: string[]
  language: string
  durationMs: number
}

export interface AiFixQueryResult {
  fixedSql: string
  explanation: string
  changesSummary: string
  language: string
  model: string
  durationMs: number
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
    truncated?: boolean
  }
  'ai.status.changed': AiStatusSnapshot
  'ssh.hostKeyChallenge': SshHostKeyChallenge
  'ssh.hostKeyResolved': {
    challengeId: string
    decision: SshHostKeyDecision
  }
  'ui.tableDisplayState.changed': {
    tableKey: string
    entry: TableDisplayStateEntry | null
    revision: number
    bulkReset?: boolean
    connectionId?: string
    all?: boolean
    tableKeys?: string[]
    revisions?: Record<string, number>
  }
  'studio.opened': {
    connectionId: string | null
    table: string | null
    schema: string | null
    viewMode?: StudioViewMode | null
    action?: 'import'
    navToken?: string
    workspaceId?: string
    docPath?: string
  }
}

export type PluginPanelEvents = DatanoaPluginPanelEvents

export const MAX_SANITIZE_DEPTH = 64

function sanitizeJsonPayloadInternal(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>
): unknown {
  if (value === undefined || value === null) {
    return value
  }
  if (typeof value === 'boolean' || typeof value === 'string') {
    return value
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
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
  if (typeof value === 'object') {
    if (ancestors.has(value)) {
      return '[Circular]'
    }
    if (depth >= MAX_SANITIZE_DEPTH) {
      return '[MaxDepth]'
    }
    ancestors.add(value)
    try {
      if (Array.isArray(value)) {
        return value.map((item) =>
          item === undefined ? null : sanitizeJsonPayloadInternal(item, depth + 1, ancestors)
        )
      }
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v !== undefined && typeof v !== 'function' && typeof v !== 'symbol') {
          const sanitized = sanitizeJsonPayloadInternal(v, depth + 1, ancestors)
          if (k === '__proto__') {
            Object.defineProperty(out, k, {
              value: sanitized,
              enumerable: true,
              writable: true,
              configurable: true,
            })
          } else {
            out[k] = sanitized
          }
        }
      }
      return out
    } finally {
      ancestors.delete(value)
    }
  }
  return null
}

/**
 * Recursively converts any payload into a strict Orca JsonValue:
 * - Strips keys with `undefined` values from objects (Orca rejects `undefined` as invalid_params)
 * - Normalizes null-prototype objects from `node:sqlite` into standard plain objects
 * - Converts BigInt, Date, Uint8Array/Buffer, and non-finite numbers into safe JSON values
 * - Guards against circular references and excessive nesting depth (`MAX_SANITIZE_DEPTH = 64`)
 */
export function sanitizeJsonPayload<T>(value: T): T {
  return sanitizeJsonPayloadInternal(value, 0, new WeakSet<object>()) as T
}

declare module 'orca' {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface PluginRequests extends DatanoaPluginRequests {}

  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface PluginPanelEvents extends DatanoaPluginPanelEvents {}
}
