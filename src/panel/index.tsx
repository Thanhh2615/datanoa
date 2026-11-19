import * as orca from 'orca'
import {
  Badge,
  Button,
  Card,
  Heading,
  type BoxProps,
  type CalloutProps,
  type CodeViewProps,
  type EmptyStateProps,
  type IconButtonProps,
  type InputProps,
  type KeyValueProps,
  type ListItemProps,
  type ListProps,
  type OrcaComponent,
  type PanelContext,
  type PluginRequestInput,
  type PluginRequestOutput,
  plugin,
  Row,
  type SelectProps,
  type SeparatorProps,
  Stack,
  type SwitchProps,
  type TableColumn,
  type TableProps,
  type TableRow,
  type TabProps,
  type TabsProps,
  Text,
  type TextareaProps,
  Tree,
  type TreeItem,
} from 'orca'
import {
  sanitizeJsonPayload,
  type ConnectionProfile,
  type PluginRequests,
  type QueryResult,
  type SchemaObject,
  type TableBrowseResult,
  type TableDetails,
} from '../protocol'

// Safely resolve optional Orca Catalog 1-4 components & atom utilities from module namespace.
// Vitest unit tests mock a subset of `orca` exports, while the real Orca runtime provides all.
function getOrcaExport<T>(name: string): T | undefined {
  try {
    return (orca as Record<string, unknown>)[name] as T
  } catch {
    return undefined
  }
}

function fallbackComponent<P>(tagName: string): OrcaComponent<P> {
  return (((props: P) => ({ type: tagName, props })) as unknown) as OrcaComponent<P>
}

const SafeInput = getOrcaExport<OrcaComponent<InputProps>>('Input') || fallbackComponent<InputProps>('Input')
const SafeSelect = getOrcaExport<OrcaComponent<SelectProps>>('Select') || fallbackComponent<SelectProps>('Select')
const SafeSwitch = getOrcaExport<OrcaComponent<SwitchProps>>('Switch') || fallbackComponent<SwitchProps>('Switch')
const SafeEmptyState =
  getOrcaExport<OrcaComponent<EmptyStateProps>>('EmptyState') ||
  fallbackComponent<EmptyStateProps>('EmptyState')
const SafeSeparator =
  getOrcaExport<OrcaComponent<SeparatorProps>>('Separator') ||
  fallbackComponent<SeparatorProps>('Separator')
const SafeBox = getOrcaExport<OrcaComponent<BoxProps>>('Box') || fallbackComponent<BoxProps>('Box')
const SafeCallout =
  getOrcaExport<OrcaComponent<CalloutProps>>('Callout') || fallbackComponent<CalloutProps>('Callout')
const SafeTabs = getOrcaExport<OrcaComponent<TabsProps>>('Tabs') || fallbackComponent<TabsProps>('Tabs')
const SafeTab = getOrcaExport<OrcaComponent<TabProps>>('Tab') || fallbackComponent<TabProps>('Tab')
const SafeTable = getOrcaExport<OrcaComponent<TableProps>>('Table') || fallbackComponent<TableProps>('Table')
const SafeTextarea =
  getOrcaExport<OrcaComponent<TextareaProps>>('Textarea') ||
  fallbackComponent<TextareaProps>('Textarea')
const SafeCodeView =
  getOrcaExport<OrcaComponent<CodeViewProps>>('CodeView') ||
  fallbackComponent<CodeViewProps>('CodeView')
const SafeKeyValue =
  getOrcaExport<OrcaComponent<KeyValueProps>>('KeyValue') ||
  fallbackComponent<KeyValueProps>('KeyValue')
const SafeList = getOrcaExport<OrcaComponent<ListProps>>('List') || fallbackComponent<ListProps>('List')
const SafeListItem =
  getOrcaExport<OrcaComponent<ListItemProps>>('ListItem') ||
  fallbackComponent<ListItemProps>('ListItem')
const SafeIconButton =
  getOrcaExport<OrcaComponent<IconButtonProps>>('IconButton') ||
  fallbackComponent<IconButtonProps>('IconButton')

const orcaAtom = getOrcaExport<(initial: unknown) => unknown>('atom')
const orcaRead = getOrcaExport<(atom: unknown) => unknown>('read')
const orcaSet = getOrcaExport<(atom: unknown, val: unknown) => void>('set')

function createSafeAtom<T>(initial: T) {
  if (typeof orcaAtom === 'function') {
    return orcaAtom(initial)
  }
  return {
    __orcaAtom: initial,
    __orcaWritable: true as const,
    __val: initial,
  }
}

function safeRead<T>(target: unknown): T {
  if (typeof orcaRead === 'function') {
    try {
      return orcaRead(target) as T
    } catch {
      return ((target as { __val?: T }).__val ??
        (target as { __orcaAtom?: T }).__orcaAtom) as T
    }
  }
  return ((target as { __val?: T }).__val ??
    (target as { __orcaAtom?: T }).__orcaAtom) as T
}

function safeSet<T>(target: unknown, value: T): void {
  if (typeof orcaSet === 'function') {
    try {
      orcaSet(target, value)
      return
    } catch {
      // Fallback outside reactive context
    }
  }
  if (target && typeof target === 'object') {
    ;(target as { __val: T }).__val = value
  }
}

/**
 * Wrapper around `plugin.request` that strips all `undefined` properties before
 * crossing Orca's strict JsonValue IPC bridge.
 */
export async function requestWorker<K extends keyof PluginRequests>(
  name: K,
  input?: PluginRequestInput<K>
): Promise<PluginRequestOutput<K>> {
  if (input === undefined) {
    return await (plugin.request as (n: K) => Promise<PluginRequestOutput<K>>)(name)
  }
  const cleanInput = sanitizeJsonPayload(input)
  return await (plugin.request as (n: K, i: unknown) => Promise<PluginRequestOutput<K>>)(
    name,
    cleanInput
  )
}

export interface DiscoveredFileEntry {
  name: string
  filePath: string
  sizeBytes: number
  sizeLabel: string
}

// Global panel state atoms
export const connectionsAtom = createSafeAtom<ConnectionProfile[]>([])
export const activeConnectionIdAtom = createSafeAtom<string | null>(null)
export const activeTabAtom = createSafeAtom<'explorer' | 'data' | 'sql' | 'structure'>('explorer')
export const activeTableAtom = createSafeAtom<string | null>(null)
export const schemaObjectsAtom = createSafeAtom<Record<string, SchemaObject[]>>({})
export const tableDetailsAtom = createSafeAtom<Record<string, TableDetails>>({})
export const tablePageDataAtom = createSafeAtom<TableBrowseResult | null>(null)
export const tablePageNumAtom = createSafeAtom<number>(1)
export const tableSortAtom = createSafeAtom<{ column: string; direction: 'asc' | 'desc' } | undefined>(
  undefined
)
export const selectedRowKeyAtom = createSafeAtom<string | null>(null)
export const editColumnAtom = createSafeAtom<string>('')
export const editValueAtom = createSafeAtom<string>('')
export const dataStatusAtom = createSafeAtom<{
  text: string
  tone: 'success' | 'danger' | 'neutral' | 'accent'
} | null>(null)

export const sqlQueryTextAtom = createSafeAtom<string>('SELECT * FROM sqlite_master LIMIT 25;')
export const sqlResultAtom = createSafeAtom<QueryResult | null>(null)
export const sqlErrorAtom = createSafeAtom<string | null>(null)

export const isFormOpenAtom = createSafeAtom<boolean>(false)
export const discoveredFilesAtom = createSafeAtom<DiscoveredFileEntry[]>([])
export const expandedKeysAtom = createSafeAtom<string[]>([])

// Connection Form state atoms
export const formDriverAtom = createSafeAtom<'sqlite' | 'postgres' | 'mysql'>('sqlite')
export const formNameAtom = createSafeAtom<string>('')
export const formFilePathAtom = createSafeAtom<string>('')
export const formHostAtom = createSafeAtom<string>('localhost')
export const formPortAtom = createSafeAtom<string>('5432')
export const formDatabaseAtom = createSafeAtom<string>('')
export const formUserAtom = createSafeAtom<string>('postgres')
export const formPasswordAtom = createSafeAtom<string>('')
export const formSslAtom = createSafeAtom<boolean>(false)
export const formStatusMessageAtom = createSafeAtom<{
  text: string
  tone: 'success' | 'danger' | 'neutral'
} | null>(null)

export async function refreshConnections(): Promise<ConnectionProfile[]> {
  try {
    const list = await requestWorker('connections.list')
    if (Array.isArray(list)) {
      safeSet(connectionsAtom, list)
      const currentActive = safeRead<string | null>(activeConnectionIdAtom)
      if ((!currentActive || !list.some((c) => c.id === currentActive)) && list.length > 0) {
        const firstId = list[0].id
        safeSet(activeConnectionIdAtom, firstId)
        safeSet(expandedKeysAtom, [`conn_${firstId}`, `tables_${firstId}`])
        void loadSchemaForConnection(firstId)
      }
      return list
    }
  } catch {
    // Graceful fallback
  }
  return []
}

export async function scanSqliteFolder(folderPath?: string): Promise<DiscoveredFileEntry[]> {
  try {
    const res = await requestWorker(
      'sqlite.scanFolder',
      folderPath ? { folderPath } : {}
    )
    if (res?.files && Array.isArray(res.files)) {
      safeSet(discoveredFilesAtom, res.files)
      return res.files
    }
  } catch {
    // Graceful fallback
  }
  return []
}

export async function loadSchemaForConnection(connectionId: string): Promise<SchemaObject[]> {
  try {
    const objects = await requestWorker('schema.listObjects', { connectionId })
    if (Array.isArray(objects)) {
      const currentSchemas = { ...safeRead<Record<string, SchemaObject[]>>(schemaObjectsAtom) }
      currentSchemas[connectionId] = objects
      safeSet(schemaObjectsAtom, currentSchemas)

      // Auto-select first table if none selected yet
      const currentTable = safeRead<string | null>(activeTableAtom)
      const firstTable = objects.find((o) => o.kind === 'table')
      if (!currentTable && firstTable) {
        safeSet(activeTableAtom, firstTable.name)
        void loadTableDetails(connectionId, firstTable.name)
        void loadTablePage(connectionId, firstTable.name, 1)
      }
      return objects
    }
  } catch {
    // Graceful fallback
  }
  return []
}

export async function loadTableDetails(
  connectionId: string,
  table: string
): Promise<TableDetails | null> {
  try {
    const details = await requestWorker('schema.tableDetails', { connectionId, table })
    if (details) {
      const currentDetails = { ...safeRead<Record<string, TableDetails>>(tableDetailsAtom) }
      currentDetails[`${connectionId}:${table}`] = details
      safeSet(tableDetailsAtom, currentDetails)
      return details
    }
  } catch {
    // Graceful fallback
  }
  return null
}

export async function loadTablePage(
  connectionId: string,
  table: string,
  page = 1,
  sort?: { column: string; direction: 'asc' | 'desc' }
): Promise<TableBrowseResult | null> {
  try {
    const res = await requestWorker('data.fetchPage', {
      connectionId,
      table,
      page,
      pageSize: 50,
      sortColumn: sort?.column,
      sortDirection: sort ? (sort.direction.toUpperCase() as 'ASC' | 'DESC') : undefined,
    })
    if (res) {
      safeSet(tablePageDataAtom, res)
      safeSet(tablePageNumAtom, page)
      return res
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    safeSet(dataStatusAtom, { text: `Error loading table: ${msg}`, tone: 'danger' })
  }
  return null
}

/**
 * Builds an Orca-compliant TreeItem hierarchy.
 * Strictly avoids custom unknown keys (such as `data`) or `children: undefined`
 * so Orca's runtime schema validator renders all nodes without warnings.
 */
export function buildConnectionTree(
  connections: ConnectionProfile[],
  schemaObjects: Record<string, SchemaObject[]>,
  tableDetails: Record<string, TableDetails> = {}
): TreeItem[] {
  return connections.map((conn) => {
    const objects = schemaObjects[conn.id] || []
    const tables = objects.filter((o) => o.kind === 'table')
    const views = objects.filter((o) => o.kind === 'view')

    const tableChildren: TreeItem[] = tables.map((t) => {
      const detailKey = `${conn.id}:${t.name}`
      const details = tableDetails[detailKey]
      const colChildren: TreeItem[] =
        details?.columns?.map((col) => ({
          key: `col_${conn.id}_${t.name}_${col.name}`,
          label: `${col.name} (${col.type})${col.isPrimaryKey ? ' [PK]' : ''}`,
          icon: 'code' as const,
        })) || []

      const item: TreeItem = {
        key: `table_${conn.id}__${t.name}`,
        label: t.name,
        icon: 'file-text' as const,
        ...(colChildren.length > 0 ? { children: colChildren } : {}),
      }
      return item
    })

    const viewChildren: TreeItem[] = views.map((v) => ({
      key: `view_${conn.id}__${v.name}`,
      label: v.name,
      description: 'view',
      icon: 'file-text' as const,
    }))

    const tablesFolder: TreeItem = {
      key: `tables_${conn.id}`,
      label: `Tables (${tables.length})`,
      icon: 'folder' as const,
      ...(tableChildren.length > 0 ? { children: tableChildren } : {}),
    }

    const viewsFolder: TreeItem = {
      key: `views_${conn.id}`,
      label: `Views (${views.length})`,
      icon: 'layers' as const,
      ...(viewChildren.length > 0 ? { children: viewChildren } : {}),
    }

    return {
      key: `conn_${conn.id}`,
      label: `${conn.name} (${conn.driver})`,
      description:
        conn.driver === 'sqlite'
          ? conn.database
          : `${conn.host || 'localhost'}:${conn.port || 5432}`,
      icon: 'database' as const,
      children: [tablesFolder, viewsFolder],
    }
  })
}

export function handleSelectNode(node: {
  key: string
  data?: { type: string; id?: string; table?: string; connectionId?: string }
}): void {
  if (node.data?.type === 'connection' && node.data.id) {
    safeSet(activeConnectionIdAtom, node.data.id)
    void loadSchemaForConnection(node.data.id)
    return
  }
  if (node.data?.type === 'table' && node.data.connectionId && node.data.table) {
    safeSet(activeConnectionIdAtom, node.data.connectionId)
    safeSet(activeTableAtom, node.data.table)
    void loadTableDetails(node.data.connectionId, node.data.table)
    void loadTablePage(node.data.connectionId, node.data.table, 1)
    return
  }

  if (node.key.startsWith('conn_')) {
    const connId = node.key.slice('conn_'.length)
    safeSet(activeConnectionIdAtom, connId)
    void loadSchemaForConnection(connId)
  } else if (node.key.startsWith('table_')) {
    const rest = node.key.slice('table_'.length)
    const sepIdx = rest.indexOf('__')
    if (sepIdx > 0) {
      const connId = rest.slice(0, sepIdx)
      const tableName = rest.slice(sepIdx + 2)
      safeSet(activeConnectionIdAtom, connId)
      safeSet(activeTableAtom, tableName)
      safeSet(sqlQueryTextAtom, `SELECT * FROM "${tableName}" LIMIT 100;`)
      void loadTableDetails(connId, tableName)
      void loadTablePage(connId, tableName, 1)
    }
  } else if (node.key.startsWith('view_')) {
    const rest = node.key.slice('view_'.length)
    const sepIdx = rest.indexOf('__')
    if (sepIdx > 0) {
      const connId = rest.slice(0, sepIdx)
      const viewName = rest.slice(sepIdx + 2)
      safeSet(activeConnectionIdAtom, connId)
      safeSet(activeTableAtom, viewName)
      safeSet(sqlQueryTextAtom, `SELECT * FROM "${viewName}" LIMIT 100;`)
      void loadTableDetails(connId, viewName)
      void loadTablePage(connId, viewName, 1)
    }
  }
}

export function setup(ctx: PanelContext): void {
  void refreshConnections()

  ctx.subscriptions.push(
    plugin.on('connections.changed', () => {
      void refreshConnections()
    }),
    plugin.on('data.cellUpdated', () => {
      const activeId = safeRead<string | null>(activeConnectionIdAtom)
      const activeTable = safeRead<string | null>(activeTableAtom)
      if (activeId) {
        void loadSchemaForConnection(activeId)
        if (activeTable) {
          const page = safeRead<number>(tablePageNumAtom) || 1
          const sort = safeRead<{ column: string; direction: 'asc' | 'desc' } | undefined>(
            tableSortAtom
          )
          void loadTablePage(activeId, activeTable, page, sort)
        }
      }
    })
  )
}

const DRIVER_OPTIONS = [
  { value: 'sqlite', label: 'SQLite (Local File / Folder)' },
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'mysql', label: 'MySQL / MariaDB' },
] as const

function buildCleanProfile(
  id: string,
  name: string,
  driver: 'sqlite' | 'postgres' | 'mysql',
  filePath: string,
  database: string,
  host: string,
  port: string,
  user: string,
  hasPassword: boolean,
  ssl: boolean
): ConnectionProfile {
  if (driver === 'sqlite') {
    const cleanPath = filePath.trim()
    const baseName = cleanPath.split(/[\\/]/).filter(Boolean).pop() || 'database.db'
    return {
      id,
      name: name.trim() || baseName,
      driver: 'sqlite',
      database: baseName,
      filePath: cleanPath,
      readOnly: false,
    }
  }
  const parsedPort = parseInt(port, 10) || (driver === 'postgres' ? 5432 : 3306)
  return {
    id,
    name: name.trim() || `${driver}@${host || 'localhost'}`,
    driver,
    database: database.trim() || (driver === 'postgres' ? 'postgres' : 'mysql'),
    host: host.trim() || 'localhost',
    port: parsedPort,
    user: user.trim() || (driver === 'postgres' ? 'postgres' : 'root'),
    hasPassword,
    ...(driver === 'postgres' ? { ssl: Boolean(ssl) } : {}),
  }
}

export default function Panel() {
  const connections = safeRead<ConnectionProfile[]>(connectionsAtom) || []
  const activeConnectionId = safeRead<string | null>(activeConnectionIdAtom)
  const activeTab = safeRead<'explorer' | 'data' | 'sql' | 'structure'>(activeTabAtom) || 'explorer'
  const activeTable = safeRead<string | null>(activeTableAtom)
  const schemaObjects = safeRead<Record<string, SchemaObject[]>>(schemaObjectsAtom) || {}
  const tableDetailsMap = safeRead<Record<string, TableDetails>>(tableDetailsAtom) || {}
  const pageData = safeRead<TableBrowseResult | null>(tablePageDataAtom)
  const pageNum = safeRead<number>(tablePageNumAtom) || 1
  const tableSort = safeRead<{ column: string; direction: 'asc' | 'desc' } | undefined>(
    tableSortAtom
  )
  const selectedRowKey = safeRead<string | null>(selectedRowKeyAtom)
  const editColumn = safeRead<string>(editColumnAtom)
  const editValue = safeRead<string>(editValueAtom)
  const dataStatus = safeRead<{
    text: string
    tone: 'success' | 'danger' | 'neutral' | 'accent'
  } | null>(dataStatusAtom)

  const sqlQueryText = safeRead<string>(sqlQueryTextAtom)
  const sqlResult = safeRead<QueryResult | null>(sqlResultAtom)
  const sqlError = safeRead<string | null>(sqlErrorAtom)

  const isFormOpen = safeRead<boolean>(isFormOpenAtom)
  const discoveredFiles = safeRead<DiscoveredFileEntry[]>(discoveredFilesAtom) || []
  const expandedKeys = safeRead<string[]>(expandedKeysAtom) || []

  const formDriver = safeRead<'sqlite' | 'postgres' | 'mysql'>(formDriverAtom)
  const formName = safeRead<string>(formNameAtom)
  const formFilePath = safeRead<string>(formFilePathAtom)
  const formHost = safeRead<string>(formHostAtom)
  const formPort = safeRead<string>(formPortAtom)
  const formDatabase = safeRead<string>(formDatabaseAtom)
  const formUser = safeRead<string>(formUserAtom)
  const formPassword = safeRead<string>(formPasswordAtom)
  const formSsl = safeRead<boolean>(formSslAtom)
  const statusMessage = safeRead<{ text: string; tone: 'success' | 'danger' | 'neutral' } | null>(
    formStatusMessageAtom
  )

  const activeConnection = connections.find((c) => c.id === activeConnectionId)
  const treeItems: TreeItem[] = buildConnectionTree(connections, schemaObjects, tableDetailsMap)
  const activeTableDetails =
    activeConnectionId && activeTable
      ? tableDetailsMap[`${activeConnectionId}:${activeTable}`]
      : undefined

  const handleOpenStudioTab = async (opts?: { table?: string; sql?: string }) => {
    try {
      const res = await requestWorker('studio.open', {
        ...(activeConnectionId ? { connectionId: activeConnectionId } : {}),
        ...(opts?.table || activeTable ? { table: opts?.table || activeTable || undefined } : {}),
        ...(opts?.sql ? { sql: opts.sql } : {}),
      })
      if (!res?.ok) {
        safeSet(activeTabAtom, opts?.sql ? 'sql' : 'data')
      }
    } catch {
      safeSet(activeTabAtom, opts?.sql ? 'sql' : 'data')
    }
  }

  const handleOpenNewQuery = () => {
    safeSet(activeTabAtom, 'sql')
    void handleOpenStudioTab({ sql: sqlQueryText })
  }

  const handleOpenSqliteForm = () => {
    safeSet(formDriverAtom, 'sqlite')
    safeSet(formNameAtom, 'Local SQLite')
    safeSet(formFilePathAtom, '')
    safeSet(formStatusMessageAtom, null)
    safeSet(isFormOpenAtom, true)
    void scanSqliteFolder()
  }

  const handleOpenAddForm = () => {
    safeSet(formDriverAtom, 'postgres')
    safeSet(formNameAtom, '')
    safeSet(formHostAtom, 'localhost')
    safeSet(formPortAtom, '5432')
    safeSet(formDatabaseAtom, '')
    safeSet(formUserAtom, 'postgres')
    safeSet(formPasswordAtom, '')
    safeSet(formSslAtom, false)
    safeSet(formStatusMessageAtom, null)
    safeSet(isFormOpenAtom, true)
  }

  const handleTestFormConnection = async () => {
    safeSet(formStatusMessageAtom, { text: 'Testing connection...', tone: 'neutral' })
    const profile = buildCleanProfile(
      `conn_test_${Date.now()}`,
      formName || 'Test Connection',
      formDriver,
      formFilePath,
      formDatabase,
      formHost,
      formPort,
      formUser,
      Boolean(formPassword),
      formSsl
    )

    try {
      const payload: { profile: ConnectionProfile; password?: string } = {
        profile,
        ...(formPassword ? { password: formPassword } : {}),
      }
      const res = await requestWorker('connection.test', payload)
      if (res?.ok) {
        safeSet(formStatusMessageAtom, {
          text: res.message || 'Connection verified successfully!',
          tone: 'success',
        })
      } else {
        safeSet(formStatusMessageAtom, {
          text: res?.message || 'Connection test failed.',
          tone: 'danger',
        })
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      safeSet(formStatusMessageAtom, { text: `Error: ${msg}`, tone: 'danger' })
    }
  }

  const handleSaveFormConnection = async () => {
    if (!formName.trim() && formDriver !== 'sqlite') {
      safeSet(formStatusMessageAtom, { text: 'Connection name is required', tone: 'danger' })
      return
    }
    if (formDriver === 'sqlite' && !formFilePath.trim()) {
      safeSet(formStatusMessageAtom, { text: 'Database file path is required', tone: 'danger' })
      return
    }

    const newId = `conn_${formDriver}_${Date.now()}`
    const profile = buildCleanProfile(
      newId,
      formName || 'SQLite Database',
      formDriver,
      formFilePath,
      formDatabase,
      formHost,
      formPort,
      formUser,
      Boolean(formPassword),
      formSsl
    )

    try {
      const payload: { profile: ConnectionProfile; password?: string } = {
        profile,
        ...(formPassword ? { password: formPassword } : {}),
      }
      const res = await requestWorker('connection.save', payload)
      if (res?.ok) {
        const savedId = res.id || newId
        safeSet(formStatusMessageAtom, { text: 'Saved & connected!', tone: 'success' })
        safeSet(isFormOpenAtom, false)
        await refreshConnections()
        safeSet(activeConnectionIdAtom, savedId)
        safeSet(expandedKeysAtom, [`conn_${savedId}`, `tables_${savedId}`])
        await loadSchemaForConnection(savedId)
      } else {
        safeSet(formStatusMessageAtom, { text: 'Failed to save connection', tone: 'danger' })
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      safeSet(formStatusMessageAtom, { text: `Error saving: ${msg}`, tone: 'danger' })
    }
  }

  const handleTestActiveConnection = async () => {
    if (!activeConnection) return
    try {
      const res = await requestWorker('connection.test', { profile: activeConnection })
      if (res?.ok) {
        safeSet(dataStatusAtom, {
          text: res.message || `${activeConnection.name}: Connected`,
          tone: 'success',
        })
      } else {
        safeSet(dataStatusAtom, {
          text: res?.message || `${activeConnection.name}: Connection failed`,
          tone: 'danger',
        })
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      safeSet(dataStatusAtom, { text: `Error: ${msg}`, tone: 'danger' })
    }
  }

  const handleDeleteActiveConnection = async () => {
    if (!activeConnection) return
    try {
      const res = await requestWorker('connection.delete', { id: activeConnection.id })
      if (res?.ok) {
        safeSet(activeConnectionIdAtom, null)
        safeSet(activeTableAtom, null)
        safeSet(tablePageDataAtom, null)
        await refreshConnections()
      }
    } catch {
      // Graceful fallback
    }
  }

  const handleRunSqlInPanel = async () => {
    if (!activeConnectionId || !sqlQueryText.trim()) return
    safeSet(sqlErrorAtom, null)
    try {
      const res = await requestWorker('query.run', {
        connectionId: activeConnectionId,
        queryId: `panel_q_${Date.now()}`,
        sql: sqlQueryText,
        maxRows: 200,
      })
      safeSet(sqlResultAtom, res)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      safeSet(sqlErrorAtom, msg)
    }
  }

  const handleCommitInlineCellEdit = async () => {
    if (!activeConnectionId || !activeTable || !pageData || !selectedRowKey || !editColumn) return
    const rowIndex = parseInt(selectedRowKey.replace('row_', ''), 10)
    const rowRecord = pageData.rows[rowIndex]
    if (!rowRecord) return

    const pkCols = pageData.primaryKey.length > 0 ? pageData.primaryKey : [pageData.columns[0]?.name].filter(Boolean)
    if (pkCols.length === 0) {
      safeSet(dataStatusAtom, { text: 'Table has no primary key column for inline update', tone: 'danger' })
      return
    }

    const primaryKeys: Record<string, unknown> = {}
    for (const pk of pkCols) {
      primaryKeys[pk] = rowRecord[pk]
    }

    const parsedValue: unknown =
      editValue.trim().toUpperCase() === 'NULL' ? null : editValue

    try {
      const res = await requestWorker('data.updateCell', {
        connectionId: activeConnectionId,
        table: activeTable,
        primaryKeys,
        column: editColumn,
        newValue: parsedValue,
        originalValue: rowRecord[editColumn],
      })
      if (res?.ok) {
        safeSet(dataStatusAtom, {
          text: `Updated ${activeTable}.${editColumn} (${res.affectedRows} row affected)`,
          tone: 'success',
        })
        await loadTablePage(activeConnectionId, activeTable, pageNum, tableSort)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      safeSet(dataStatusAtom, { text: `Update failed: ${msg}`, tone: 'danger' })
    }
  }

  // Prepare Data Grid rows & columns for Orca <Table> (Orca Table catalog maxTableColumns = 32, maxLabelLength = 1024)
  const MAX_ORCA_TABLE_COLS = 32
  const MAX_ORCA_CELL_TEXT = 500
  const visiblePageCols = pageData?.columns?.slice(0, MAX_ORCA_TABLE_COLS) || []

  const dataGridColumns: TableColumn[] = visiblePageCols.map((col) => ({
    key: col.name.slice(0, 64),
    label: `${col.name}${col.isPrimaryKey ? ' [PK]' : ''}`.slice(0, 120),
    sortable: true,
    minWidth: 'xs' as const,
  }))

  const dataGridRows: TableRow[] =
    pageData?.rows?.slice(0, 500).map((r, idx) => {
      const cells: Record<string, string | number | boolean | null> = {}
      for (const col of visiblePageCols) {
        const key = col.name.slice(0, 64)
        const val = r[col.name]
        if (val === null || val === undefined) {
          cells[key] = 'NULL'
        } else if (typeof val === 'object') {
          cells[key] = JSON.stringify(val).slice(0, MAX_ORCA_CELL_TEXT)
        } else if (typeof val === 'string') {
          cells[key] =
            val.length > MAX_ORCA_CELL_TEXT ? `${val.slice(0, MAX_ORCA_CELL_TEXT)}…` : val
        } else {
          cells[key] = val as number | boolean
        }
      }
      return {
        key: `row_${idx}`,
        cells,
      }
    }) || []

  // Prepare SQL Result rows & columns (capped at 32 columns for Orca Table component)
  const visibleSqlCols = sqlResult?.columns?.slice(0, MAX_ORCA_TABLE_COLS) || []
  const sqlColumns: TableColumn[] = visibleSqlCols.map((c, idx) => ({
    key: `col_${idx}_${c.name}`.slice(0, 64),
    label: (c.name || `col_${idx}`).slice(0, 120),
    minWidth: 'xs' as const,
  }))

  const sqlRows: TableRow[] =
    sqlResult?.rows?.slice(0, 500).map((r, rIdx) => {
      const cells: Record<string, string | number | boolean | null> = {}
      visibleSqlCols.forEach((c, cIdx) => {
        const key = `col_${cIdx}_${c.name}`.slice(0, 64)
        const v = r[cIdx]
        if (v === null || v === undefined) {
          cells[key] = 'NULL'
        } else if (typeof v === 'object') {
          cells[key] = JSON.stringify(v).slice(0, MAX_ORCA_CELL_TEXT)
        } else if (typeof v === 'string') {
          cells[key] =
            v.length > MAX_ORCA_CELL_TEXT ? `${v.slice(0, MAX_ORCA_CELL_TEXT)}…` : v
        } else {
          cells[key] = v as number | boolean
        }
      })
      return { key: `sql_row_${rIdx}`, cells }
    }) || []

  // Prepare Structure columns
  const structureColumns: TableColumn[] = [
    { key: 'name', label: 'Column', minWidth: 'xs' },
    { key: 'type', label: 'Type', minWidth: 'xs' },
    { key: 'key', label: 'Key', width: 'xs' },
    { key: 'nullable', label: 'Null', width: 'xs' },
    { key: 'default', label: 'Default', minWidth: 'xs' },
  ]

  const structureRows: TableRow[] =
    activeTableDetails?.columns?.map((c) => ({
      key: `struct_${c.name}`,
      cells: {
        name: c.name,
        type: c.nativeType || c.type,
        key: c.isPrimaryKey ? 'PK' : '',
        nullable: c.nullable ? 'YES' : 'NO',
        default: c.defaultValue ?? 'NULL',
      },
    })) || []

  const activeObjects = (activeConnectionId && schemaObjects[activeConnectionId]) || []
  const activeTablesList = activeObjects.filter((o) => o.kind === 'table')

  return (
    <Stack gap="sm">
      {/* Compact Studio Command Bar */}
      <SafeBox background="card" border={true} padding="sm" radius="md">
        <Stack gap="xs">
          <Row align="center" justify="between">
            <Row align="center" gap="xs">
              <Heading level={3}>Datanoa</Heading>
              <Badge tone={activeConnection ? 'success' : 'neutral'}>
                {activeConnection ? activeConnection.driver.toUpperCase() : 'STUDIO'}
              </Badge>
            </Row>
            <Button
              variant="solid"
              tone="accent"
              size="xs"
              icon="rocket"
              onPress={() => void handleOpenStudioTab()}
            >
              Open Studio
            </Button>
          </Row>

          <Row gap="xs" wrap>
            <Button
              variant="outline"
              size="xs"
              icon="code"
              onPress={handleOpenNewQuery}
            >
              New Query
            </Button>
            <Button
              variant="outline"
              size="xs"
              icon="folder"
              onPress={handleOpenSqliteForm}
            >
              Open SQLite
            </Button>
            <Button
              variant="ghost"
              size="xs"
              icon="add"
              onPress={handleOpenAddForm}
            >
              Add Connection
            </Button>
          </Row>
        </Stack>
      </SafeBox>

      {/* Connection Drawer (SQLite / PostgreSQL / MySQL) */}
      {isFormOpen ? (
        <Card title="New Connection" description="Connect to SQLite, PostgreSQL, or MySQL">
          <Stack gap="sm">
            <SafeSelect
              label="Driver"
              value={formDriver}
              options={DRIVER_OPTIONS}
              onChange={(val: string) => {
                const driver = val as 'sqlite' | 'postgres' | 'mysql'
                safeSet(formDriverAtom, driver)
                safeSet(formStatusMessageAtom, null)
                if (driver === 'postgres') {
                  safeSet(formPortAtom, '5432')
                  safeSet(formUserAtom, 'postgres')
                } else if (driver === 'mysql') {
                  safeSet(formPortAtom, '3306')
                  safeSet(formUserAtom, 'root')
                } else {
                  void scanSqliteFolder(formFilePath)
                }
              }}
            />

            <SafeInput
              label="Connection Name"
              placeholder="e.g. Care Account DB"
              value={formName}
              onChange={(val: string) => safeSet(formNameAtom, val)}
            />

            {formDriver === 'sqlite' ? (
              <Stack gap="xs">
                <SafeInput
                  label="Database File Path"
                  placeholder="D:\project\data\.db or folder path"
                  value={formFilePath}
                  onChange={(val: string) => safeSet(formFilePathAtom, val)}
                />
                <Row gap="xs" justify="between" align="center">
                  <Text muted size="xs">
                    Tip: Paste a file path or folder path and press Scan
                  </Text>
                  <Button
                    variant="ghost"
                    size="xs"
                    icon="search"
                    onPress={() => void scanSqliteFolder(formFilePath)}
                  >
                    Scan Folder
                  </Button>
                </Row>

                {discoveredFiles.length > 0 ? (
                  <SafeBox background="muted" padding="xs" radius="sm" border={true}>
                    <Stack gap="xs">
                      <Text size="xs" weight="medium">
                        Discovered SQLite Databases ({discoveredFiles.length})
                      </Text>
                      <SafeList label="Discovered SQLite files">
                        {discoveredFiles.slice(0, 12).map((file) => (
                          <SafeListItem
                            key={file.filePath}
                            title={`${file.name} (${file.sizeLabel})`}
                            description={file.filePath}
                            icon="database"
                            current={formFilePath === file.filePath}
                            onPress={() => {
                              safeSet(formFilePathAtom, file.filePath)
                              if (!formName || formName === 'Local SQLite') {
                                safeSet(formNameAtom, file.name)
                              }
                            }}
                          />
                        ))}
                      </SafeList>
                    </Stack>
                  </SafeBox>
                ) : null}
              </Stack>
            ) : (
              <>
                <Row gap="sm">
                  <SafeInput
                    label="Host"
                    placeholder="localhost"
                    value={formHost}
                    onChange={(val: string) => safeSet(formHostAtom, val)}
                  />
                  <SafeInput
                    label="Port"
                    placeholder={formDriver === 'postgres' ? '5432' : '3306'}
                    value={formPort}
                    onChange={(val: string) => safeSet(formPortAtom, val)}
                  />
                </Row>
                <SafeInput
                  label="Database Name"
                  placeholder={formDriver === 'postgres' ? 'postgres' : 'mysql'}
                  value={formDatabase}
                  onChange={(val: string) => safeSet(formDatabaseAtom, val)}
                />
                <Row gap="sm">
                  <SafeInput
                    label="User"
                    placeholder={formDriver === 'postgres' ? 'postgres' : 'root'}
                    value={formUser}
                    onChange={(val: string) => safeSet(formUserAtom, val)}
                  />
                  <SafeInput
                    label="Password"
                    type="password"
                    placeholder="••••••••"
                    value={formPassword}
                    onChange={(val: string) => safeSet(formPasswordAtom, val)}
                  />
                </Row>
                {formDriver === 'postgres' ? (
                  <SafeSwitch
                    label="Use SSL"
                    checked={formSsl}
                    onChange={(val: boolean) => safeSet(formSslAtom, val)}
                  />
                ) : null}
              </>
            )}

            {statusMessage ? (
              <SafeCallout
                tone={statusMessage.tone}
                title={statusMessage.tone === 'danger' ? 'Connection Error' : 'Status'}
              >
                <Text tone={statusMessage.tone} size="sm">
                  {statusMessage.text}
                </Text>
              </SafeCallout>
            ) : null}

            <Row gap="xs" justify="end">
              <Button
                variant="ghost"
                size="sm"
                onPress={() => safeSet(isFormOpenAtom, false)}
              >
                Cancel
              </Button>
              <Button
                variant="outline"
                size="sm"
                icon="zap"
                onPress={() => void handleTestFormConnection()}
              >
                Test
              </Button>
              <Button
                variant="solid"
                tone="accent"
                size="sm"
                icon="check"
                onPress={() => void handleSaveFormConnection()}
              >
                Save
              </Button>
            </Row>
          </Stack>
        </Card>
      ) : null}

      {/* Status Toast / Callout */}
      {dataStatus ? (
        <SafeCallout tone={dataStatus.tone} title="Datanoa">
          <Row justify="between" align="center">
            <Text size="xs">{dataStatus.text}</Text>
            <Button
              variant="ghost"
              size="xs"
              onPress={() => safeSet(dataStatusAtom, null)}
            >
              Dismiss
            </Button>
          </Row>
        </SafeCallout>
      ) : null}

      {/* Active Connection Bar */}
      {!isFormOpen && activeConnection ? (
        <SafeBox background="muted" padding="xs" radius="md" border={true}>
          <Stack gap="xs">
            <Row align="center" justify="between">
              <Row align="center" gap="xs">
                <Badge tone="accent">{activeConnection.driver}</Badge>
                <Text weight="semibold" size="sm" truncate>
                  {activeConnection.name}
                </Text>
              </Row>
              <Row gap="xs">
                <SafeIconButton
                  icon="refresh"
                  label="Refresh Schema"
                  size="xs"
                  variant="ghost"
                  onPress={() => void loadSchemaForConnection(activeConnection.id)}
                />
                <Button
                  variant="outline"
                  size="xs"
                  icon="zap"
                  onPress={() => void handleTestActiveConnection()}
                >
                  Test
                </Button>
                <Button
                  variant="ghost"
                  tone="danger"
                  size="xs"
                  icon="delete"
                  onPress={() => void handleDeleteActiveConnection()}
                >
                  Delete
                </Button>
              </Row>
            </Row>
            <Text muted size="xs" truncate>
              {activeConnection.driver === 'sqlite'
                ? activeConnection.filePath || activeConnection.database
                : `${activeConnection.host || 'localhost'}:${activeConnection.port || 5432}/${activeConnection.database}`}
            </Text>
          </Stack>
        </SafeBox>
      ) : null}

      {/* Multi-Surface Workspace Tabs */}
      <SafeTabs
        label="Datanoa Studio Mode"
        value={activeTab}
        onChange={(val: string) =>
          safeSet(activeTabAtom, val as 'explorer' | 'data' | 'sql' | 'structure')
        }
      >
        {/* TAB 1: SCHEMA EXPLORER */}
        <SafeTab value="explorer" label={`Explorer (${connections.length})`} icon="database">
          <Stack gap="sm">
            {treeItems.length === 0 ? (
              <SafeEmptyState
                title="No Connections"
                description="Click 'Open SQLite' to scan your project databases or 'Add Connection' for PostgreSQL / MySQL."
                icon="database"
              >
                <Row gap="xs">
                  <Button variant="solid" tone="accent" size="xs" icon="folder" onPress={handleOpenSqliteForm}>
                    Open SQLite
                  </Button>
                  <Button variant="outline" size="xs" icon="add" onPress={handleOpenAddForm}>
                    Add Server
                  </Button>
                </Row>
              </SafeEmptyState>
            ) : (
              <Stack gap="xs">
                {activeTable ? (
                  <SafeBox background="card" padding="xs" radius="sm" border={true}>
                    <Row align="center" justify="between">
                      <Row align="center" gap="xs">
                        <Badge tone="accent">TABLE</Badge>
                        <Text weight="medium" size="xs">
                          {activeTable}
                        </Text>
                      </Row>
                      <Row gap="xs">
                        <Button
                          variant="solid"
                          tone="accent"
                          size="xs"
                          icon="bar-chart-3"
                          onPress={() => safeSet(activeTabAtom, 'data')}
                        >
                          Browse Data
                        </Button>
                        <Button
                          variant="outline"
                          size="xs"
                          icon="layers"
                          onPress={() => safeSet(activeTabAtom, 'structure')}
                        >
                          Columns
                        </Button>
                      </Row>
                    </Row>
                  </SafeBox>
                ) : null}

                <Tree
                  label="Connections"
                  items={treeItems}
                  expanded={expandedKeys}
                  selected={
                    activeTable && activeConnectionId
                      ? `table_${activeConnectionId}__${activeTable}`
                      : activeConnectionId
                        ? `conn_${activeConnectionId}`
                        : undefined
                  }
                  onToggle={({ key, expanded }) => {
                    const current = new Set(safeRead<string[]>(expandedKeysAtom) || [])
                    if (expanded) current.add(key)
                    else current.delete(key)
                    safeSet(expandedKeysAtom, Array.from(current))
                    handleSelectNode({ key })
                  }}
                  onSelect={handleSelectNode}
                  onAction={({ key }) => {
                    handleSelectNode({ key })
                    if (key.startsWith('table_') || key.startsWith('view_')) {
                      safeSet(activeTabAtom, 'data')
                    }
                  }}
                />
              </Stack>
            )}
          </Stack>
        </SafeTab>

        {/* TAB 2: DATA GRID & INLINE EDITOR */}
        <SafeTab
          value="data"
          label={activeTable ? `Data: ${activeTable}` : 'Data Grid'}
          icon="bar-chart-3"
        >
          <Stack gap="sm">
            {activeTablesList.length > 0 ? (
              <Row align="center" justify="between" gap="xs">
                <SafeSelect
                  label="Table"
                  labelHidden={true}
                  value={activeTable || activeTablesList[0]?.name || ''}
                  options={activeTablesList.map((t) => ({ value: t.name, label: t.name }))}
                  onChange={(tbl: string) => {
                    safeSet(activeTableAtom, tbl)
                    if (activeConnectionId) {
                      void loadTableDetails(activeConnectionId, tbl)
                      void loadTablePage(activeConnectionId, tbl, 1)
                    }
                  }}
                />
                <Row gap="xs">
                  <Button
                    variant="outline"
                    size="xs"
                    icon="refresh"
                    onPress={() => {
                      if (activeConnectionId && activeTable) {
                        void loadTablePage(activeConnectionId, activeTable, pageNum, tableSort)
                      }
                    }}
                  >
                    Refresh
                  </Button>
                  <Button
                    variant="solid"
                    tone="accent"
                    size="xs"
                    icon="open-external"
                    onPress={() => void handleOpenStudioTab({ table: activeTable || undefined })}
                  >
                    Full Tab
                  </Button>
                </Row>
              </Row>
            ) : null}

            {!pageData || dataGridColumns.length === 0 ? (
              <SafeEmptyState
                title="Select a Table"
                description="Choose a table in the Explorer tab to browse and edit rows."
                icon="bar-chart-3"
              />
            ) : (
              <Stack gap="xs">
                <SafeTable
                  label={`Rows of ${activeTable || 'table'}`}
                  columns={dataGridColumns}
                  rows={dataGridRows}
                  sort={tableSort}
                  selectionMode="single"
                  selected={selectedRowKey ? [selectedRowKey] : []}
                  maxHeight="md"
                  emptyText="Table is empty (0 rows)"
                  onSortChange={(nextSort) => {
                    safeSet(tableSortAtom, nextSort)
                    if (activeConnectionId && activeTable) {
                      void loadTablePage(activeConnectionId, activeTable, 1, nextSort)
                    }
                  }}
                  onSelectionChange={({ keys }) => {
                    const key = keys[0] || null
                    safeSet(selectedRowKeyAtom, key)
                    if (key && pageData) {
                      const idx = parseInt(key.replace('row_', ''), 10)
                      const row = pageData.rows[idx]
                      const firstEditableCol =
                        pageData.columns.find((c) => !c.isPrimaryKey)?.name ||
                        pageData.columns[0]?.name ||
                        ''
                      safeSet(editColumnAtom, firstEditableCol)
                      safeSet(
                        editValueAtom,
                        row && firstEditableCol && row[firstEditableCol] !== null && row[firstEditableCol] !== undefined
                          ? String(row[firstEditableCol])
                          : ''
                      )
                    }
                  }}
                />

                {/* Pagination Bar */}
                <Row align="center" justify="between">
                  <Text muted size="xs">
                    {pageData.totalRows} total rows · Page {pageData.page} of{' '}
                    {Math.max(1, Math.ceil(pageData.totalRows / (pageData.pageSize || 50)))}
                  </Text>
                  <Row gap="xs">
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={pageData.page <= 1}
                      onPress={() => {
                        if (activeConnectionId && activeTable && pageData.page > 1) {
                          void loadTablePage(
                            activeConnectionId,
                            activeTable,
                            pageData.page - 1,
                            tableSort
                          )
                        }
                      }}
                    >
                      Prev
                    </Button>
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={pageData.page * pageData.pageSize >= pageData.totalRows}
                      onPress={() => {
                        if (activeConnectionId && activeTable) {
                          void loadTablePage(
                            activeConnectionId,
                            activeTable,
                            pageData.page + 1,
                            tableSort
                          )
                        }
                      }}
                    >
                      Next
                    </Button>
                  </Row>
                </Row>

                {/* Inline Row Cell Editor */}
                {selectedRowKey && pageData.canEdit ? (
                  <SafeBox background="card" padding="sm" radius="md" border="accent">
                    <Stack gap="xs">
                      <Row align="center" justify="between">
                        <Text weight="semibold" size="xs">
                          Inline Edit ({selectedRowKey.replace('row_', 'Row #')})
                        </Text>
                        <Badge tone="accent">PK Locked</Badge>
                      </Row>
                      <SafeSelect
                        label="Column"
                        value={editColumn}
                        options={pageData.columns.map((c) => ({
                          value: c.name,
                          label: `${c.name} (${c.type})`,
                        }))}
                        onChange={(colName: string) => {
                          safeSet(editColumnAtom, colName)
                          const idx = parseInt(selectedRowKey.replace('row_', ''), 10)
                          const row = pageData.rows[idx]
                          safeSet(
                            editValueAtom,
                            row && row[colName] !== null && row[colName] !== undefined
                              ? String(row[colName])
                              : ''
                          )
                        }}
                      />
                      <SafeInput
                        label="New Value (type NULL for null)"
                        value={editValue}
                        onChange={(val: string) => safeSet(editValueAtom, val)}
                      />
                      <Row justify="end" gap="xs">
                        <Button
                          variant="ghost"
                          size="xs"
                          onPress={() => safeSet(selectedRowKeyAtom, null)}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="solid"
                          tone="accent"
                          size="xs"
                          icon="check"
                          onPress={() => void handleCommitInlineCellEdit()}
                        >
                          Save Cell to DB
                        </Button>
                      </Row>
                    </Stack>
                  </SafeBox>
                ) : null}
              </Stack>
            )}
          </Stack>
        </SafeTab>

        {/* TAB 3: SQL CONSOLE */}
        <SafeTab value="sql" label="SQL Console" icon="terminal">
          <Stack gap="sm">
            <SafeTextarea
              label="SQL Query"
              rows={4}
              placeholder="SELECT * FROM account LIMIT 50;"
              value={sqlQueryText}
              onChange={(val: string) => safeSet(sqlQueryTextAtom, val)}
              onSubmit={() => void handleRunSqlInPanel()}
            />
            <Row justify="between" align="center">
              <Button
                variant="solid"
                tone="accent"
                size="xs"
                icon="play"
                onPress={() => void handleRunSqlInPanel()}
              >
                Run Query
              </Button>
              <Button
                variant="outline"
                size="xs"
                icon="open-external"
                onPress={() => void handleOpenStudioTab({ sql: sqlQueryText })}
              >
                Open in Studio Editor
              </Button>
            </Row>

            {sqlError ? (
              <SafeCallout tone="danger" title="Query Error">
                <Text tone="danger" size="xs">
                  {sqlError}
                </Text>
              </SafeCallout>
            ) : null}

            {sqlResult ? (
              <Stack gap="xs">
                <Row justify="between" align="center">
                  <Badge tone="success">
                    {sqlResult.isSelect
                      ? `${sqlResult.rowCount} rows`
                      : `${sqlResult.affectedRows ?? 0} affected`}
                  </Badge>
                  <Text muted size="xs">
                    Executed in {sqlResult.executionTimeMs.toFixed(1)} ms
                  </Text>
                </Row>
                {sqlColumns.length > 0 ? (
                  <SafeTable
                    label="Query Results"
                    columns={sqlColumns}
                    rows={sqlRows}
                    maxHeight="md"
                    emptyText="Query returned 0 rows"
                  />
                ) : null}
              </Stack>
            ) : null}
          </Stack>
        </SafeTab>

        {/* TAB 4: TABLE STRUCTURE INSPECTOR */}
        <SafeTab value="structure" label="Structure" icon="layers">
          <Stack gap="sm">
            {!activeTableDetails ? (
              <SafeEmptyState
                title="No Table Selected"
                description="Select a table in Explorer to inspect columns, primary keys, indexes, and foreign keys."
                icon="layers"
              />
            ) : (
              <Stack gap="sm">
                <SafeKeyValue
                  label="Table Metadata"
                  items={[
                    { label: 'Table', value: activeTableDetails.name, code: true },
                    { label: 'Schema', value: activeTableDetails.schema },
                    {
                      label: 'Primary Key',
                      value: activeTableDetails.primaryKey.join(', ') || 'None',
                      tone: activeTableDetails.primaryKey.length > 0 ? 'accent' : 'neutral',
                    },
                    { label: 'Columns', value: activeTableDetails.columns.length },
                    { label: 'Indexes', value: activeTableDetails.indexes.length },
                    { label: 'Foreign Keys', value: activeTableDetails.foreignKeys.length },
                  ]}
                />
                <SafeSeparator />
                <SafeTable
                  label="Columns"
                  columns={structureColumns}
                  rows={structureRows}
                  maxHeight="md"
                />
                {activeTableDetails.indexes.length > 0 ? (
                  <SafeCodeView
                    label="Indexes"
                    language="sql"
                    code={activeTableDetails.indexes
                      .map(
                        (idx) =>
                          `${idx.isUnique ? 'UNIQUE ' : ''}INDEX ${idx.name} (${idx.columns.join(', ')})`
                      )
                      .join('\n')}
                  />
                ) : null}
              </Stack>
            )}
          </Stack>
        </SafeTab>
      </SafeTabs>
    </Stack>
  )
}
