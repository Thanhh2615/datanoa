// src/panel/panel-app.js
// Docked Side Panel runtime controller (extracted from panel.html)

import {
  ENGINE_BY_ID,
  PANEL_COL_TYPES,
  PANEL_TYPE_SUGGESTIONS_BY_DRIVER,
  quoteIdent,
  quoteTableRef,
  formatSqlLiteral,
  formatPanelSql,
  buildDdlFallback,
  coerceTypedCellInput,
  buildCreateObjectCommand,
  buildCreateTableSql,
  buildInitialCreateTableDraftColumns,
  buildSelectPreviewQuery,
  buildTruncateOrDropSql,
  createPanelStructDraft,
  countPanelStructChanges,
  getPanelCreateTableRowAriaLabels,
  resolvePanelFormDriver,
  isActionableTlsErrorMessage,
  formatConnectionScopedMessage,
  summarizeSchemaErrors,
  scrubClientUrlCredentials,
} from './panel-core.js'
import {
  $,
  setDbLogoElement,
  rpc,
  syncThemeFromTokens,
  syncSidebarBackgroundFromTokens,
  applyTypographySnapshot,
  syncOrcaTypography,
  makeTableKey,
  makeLegacyTableKey,
  canUseLegacyTableKeyFallback,
  normalizeTableKey,
  tableKeyMatchesConnection,
  encodeTableSelectValue,
  decodeTableSelectValue,
  setButtonLoading,
  updateButtonLoadingLabel,
  createElapsedTimer,
  bindCtrlWheelHorizontalScroll,
  enhanceCollapsibleSelectDropdown,
  bindSelectTooltipsInRoot,
  syncSelectTooltip,
  isCustomDropdownOpen,
  closeActiveCustomDropdown,
  openPanelFilePickerModal,
  writeTextToClipboard,
} from './panel-utils.js'
import { PanelGridSelection } from './panel-selection.js'
import {
  formatConnSubtitle,
  createPanelConnectionFormController,
} from './panel-connection-form.js'
import {
  closeContextMenu,
  createPanelExplorerController,
} from './panel-explorer.js'
import { createPanelSqlController } from './panel-sql.js'
import {
  openSharedAiConfigModal,
  saveOrcaSettingsPatch,
} from '../shared-ai-ui.js'
import {
  openSharedSshHostKeyModal,
  closeByChallengeId,
  closeAllSshHostKeyModals,
  renderSharedTlsFailureRemedy,
  runWithSshHostKeyRetry,
} from '../shared-ssh-hostkey-modal.js'
import {
  HIGHLIGHT_TONES,
  HIGHLIGHT_CSS_CLASSES,
  CONDITIONAL_HIGHLIGHT_OPERATORS,
  areHighlightRulesEqual,
  areTableDisplayStateEntriesEquivalent,
  buildColumnKeyResolver,
  parseOccurrenceColumnKey,
  resolveEffectiveColumnLayout,
  reorderColumnInEntry,
  setUserColumnWidthInEntry,
  normalizeTableDisplayStateEntry,
  rebaseTableDisplayStateEntry,
  scrubSensitiveTableFilterText,
} from '../shared-table-display.js'
import {
  clampWrapMaxLines,
  DEFAULT_WRAP_MAX_LINES,
} from '../shared-row-height-index.js'
import { formatJsonPreservingNumbers } from '../shared-grid-paste.js'
import {
  containsSensitiveSqlText,
  sanitizeSqlResultForStorage,
  scrubConnectionNameForStorage,
} from '../shared-sql-safety.js'
import {
  UNGROUPED_FOLDER_ORDER_KEY,
  normalizeConnectionFolderKey,
  normalizeFolderOrder,
  sortFoldersByOrder,
  getConnectionFolderOrderKeys,
  reconcileFolderOrder,
  reorderConnectionsWithinFolder,
} from '../shared-connection-order.js'
import { createPanelStructureController } from './panel-structure.js'
import { createPanelFeedbackAndPaletteController } from './panel-feedback-palette.js'
import { createPanelDataGridController } from './panel-data-grid.js'

const QUERY_TIMEOUT_MS = 115000
const MULTI_SCHEMA_DRIVERS = new Set([
  'postgres',
  'cockroachdb',
  'mssql',
  'oracle',
  'mysql',
  'mariadb',
  'clickhouse',
  'snowflake',
  'bigquery',
  'duckdb',
  'mongodb',
])

// Application state
const state = {
  tab: 'explorer',
  connections: [],
  folderOrder: [],
  activeConnectionId: null,
  schemaObjects: {},
  schemaObjectsByConnSchema: {},
  schemaStaleByConn: {},
  schemaLoading: new Set(),
  schemaErrors: {},
  availableSchemasByConn: {},
  defaultSchemaByConn: {},
  selectedSchemaByConn: {},
  selectedSchemaUpdatedAtByConn: {},
  tableDetails: {},
  tableDetailsErrors: {},
  structDraftKey: null,
  structDraft: null,
  structPreviewOpen: false,
  structSeq: 1,
  collapsedFolders: new Set(),
  collapsedSchemaGroups: new Set(),
  expandedConns: new Set(),
  expandedTables: new Set(),
  expandedMeta: new Set(),
  activeTable: null,
  activeSchema: undefined,
  pageData: null,
  page: 1,
  pageSize: 100,
  sortCol: null,
  sortDir: 'ASC',
  whereClause: '',
  orderByClause: '',
  transposed: false,
  selectedRowKey: null,
  selectedCol: null,
  inspectorOpen: false,
  inspectorCollapsed: false,
  rowNumWidth: 56,
  transposeFieldWidth: 180,
  columnWidthsByTable: {},
  userResizedColKeysByTable: {},
  transposeWidthsByTable: {},
  hiddenColsByTable: {},
  pinnedColsByTable: {},
  tableDisplayByTable: {},
  tableDisplayRevisionByTable: {},
  findQuery: '',
  findMatches: [],
  findMatchSet: new Set(),
  findMatchIdx: -1,
  stagedInserts: [],
  stagedUpdates: new Map(),
  stagedDeletes: new Map(),
  filter: '',
  formOpen: false,
  editingId: null,
  formDriver: 'sqlite',
  formColorTag: 'none',
  formBusy: false,
  formHadPassword: false,
  formHadAuthToken: false,
  placeholderPasswordPending: false,
  lastParsedPlaceholderUri: false,
  sourceSecretConnId: null,
  lastParsedUri: '',
  formOptions: '',
  formSslMode: undefined,
  formSslRejectUnauthorized: undefined,
  formSslTouched: false,
  formTlsServernameTouched: false,
  formSslCaPathTouched: false,
  sshExplicitlyDisabled: false,
  lastAutoFilledSqliteName: '',
  discoveredFiles: [],
  discoveredEnvs: [],
  discoveredDocker: [],
  aiStatus: null,
  discoveredSearch: '',
  discoveryCollapsed: { env: null, docker: null, sqlite: null },
  initialBootLoading: true,
  refreshingConns: false,
  testingActiveConn: false,
  deletingConn: false,
  isMigrating: false,
  creatingTable: false,
  runningDangerTableOp: false,
  dataLoading: false,
  structureLoading: false,
  structureError: null,
  activeQueryId: null,
  activeWorkerQueryId: null,
  lastSqlResult: null,
  sqlSortColIdx: null,
  sqlSortDir: 'ASC',
  sqlColWidths: [],
  sqlRowNumWidth: 56,
  historyOpen: false,
  historyLoading: false,
  historyFilter: '',
  historyEntries: [],
  restoringViewState: false,
  hasRestoredViewState: false,
  hasRestoredExpandedConns: false,
  restoredViewStateUpdatedAt: 0,
  hasUserInteraction: false,
  silentDataRefresh: false,
  restoredPage: 1,
  restoredSqlDraft: '',
  pendingWorkspaceScope: null,
  pendingScrollState: null,
  warmBootHydrated: false,
  warmBootUpdatedAt: 0,
}

const ACTIVE_CONNECTION_STORAGE_KEY = 'datanoa.activeConnectionId'
const PANEL_VIEW_STATE_STORAGE_KEY = 'datanoa.panelViewState'
const PANEL_WARM_CACHE_STORAGE_KEY = 'datanoa.panelWarmCache'
const PANEL_WARM_CACHE_FRESH_MS = 60_000
const VIRT_ROW_HEIGHT_PX = 26
const VIRT_OVERSCAN_ROWS = 10
const ownDocument = typeof document !== 'undefined' ? document : null
let panelDisposed = false
function isPanelActive() {
  return !panelDisposed && typeof document !== 'undefined' && document === ownDocument
}
let dataPageLoadSeq = 0
let dmlPreviewSeq = 0
let lastLoadedPanelTableKey = null
let refreshConnectionsPending = false
const schemaRefreshPending = new Set()
const schemaLoadSeqByConn = new Map()
const tableDetailsSeqByKey = new Map()
const orcaDisposables = []
let pendingDeleteConnId = null
let suppressSortClickUntil = 0
let activeResizeCleanup = null
let bannerDismissTimer = null
let bannerActionContext = null
let dataLoadStopTimer = null
let saveViewStateTimer = null
let findDebounceTimer = null
let schemaFilterDebounceTimer = null
let previewingDml = false
let submittingChanges = false
let inspectorUserModified = false
let reorderQueueChain = Promise.resolve()
let reorderSeq = 0
let connReorderSeq = 0
let folderReorderSeq = 0
let pendingReorderCount = 0
let expectedSelfChangedEvents = 0
let consumedSelfChangedEvents = 0
let refreshConnectionsAfterReorder = false

function isAnyModalOpen() {
  if (document.querySelector('.datanoa-ai-backdrop')) return true
  const modalIds = [
    'confirmDeleteModal',
    'confirmMigrationModal',
    'bulkFillModal',
    'createTableModal',
    'dangerTableModal',
    'dangerSqlModal',
    'feedbackModal',
    'cmdPaletteModal',
    'shortcutsModal',
  ]
  return modalIds.some((id) => {
    const el = $(id)
    return Boolean(el && !el.hidden)
  })
}

const MAX_PANEL_DATA_CACHE_BYTES = 450_000
const MAX_PANEL_LOCAL_WARM_BYTES = 350_000
const MAX_PANEL_VIEW_STATE_BYTES = 200_000

function sanitizeWarmPanelConnections(list) {
  if (!Array.isArray(list)) return []
  return list.slice(0, 120).map((c) => {
    const copy = { ...c }
    delete copy.password
    delete copy.authToken
    delete copy.sshPassword
    delete copy.sshPassphrase
    delete copy.sslKeyPassphrase
    delete copy.sshJumpHopSecrets
    if (Array.isArray(copy.sshJumpHosts)) {
      copy.sshJumpHosts = copy.sshJumpHosts.map((hop) => {
        if (!hop || typeof hop !== 'object') return hop
        const cleanHop = { ...hop }
        delete cleanHop.sshPassword
        delete cleanHop.sshPassphrase
        delete cleanHop.password
        delete cleanHop.passphrase
        delete cleanHop.authToken
        delete cleanHop.secret
        return cleanHop
      })
    }
    if (typeof copy.name === 'string') {
      copy.name = scrubConnectionNameForStorage(copy.name)
    }
    if (typeof copy.url === 'string') {
      copy.url = scrubDraftUrlForLocalStorage(copy.url)
    }
    if (typeof copy.options === 'string') {
      copy.options = scrubDraftUrlForLocalStorage(copy.options)
    }
    return copy
  })
}
const utf8Encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null

function measureUtf8Bytes(str) {
  if (!str) return 0
  return utf8Encoder ? utf8Encoder.encode(str).length : str.length * 3
}

function scrubDraftUrlForLocalStorage(raw) {
  return scrubClientUrlCredentials(raw)
}

function sqlDraftLooksSensitive(sql) {
  return containsSensitiveSqlText(sql)
}

function readPanelScrollState() {
  const viewport = document.querySelector('.viewport')
  const dataWrap = $('dataGridWrap')
  const sqlWrap = $('sqlResultWrap')
  return {
    viewportTop: viewport ? Math.round(viewport.scrollTop) : 0,
    dataGridTop: dataWrap ? Math.round(dataWrap.scrollTop) : 0,
    dataGridLeft: dataWrap ? Math.round(dataWrap.scrollLeft) : 0,
    sqlResultTop: sqlWrap ? Math.round(sqlWrap.scrollTop) : 0,
    sqlResultLeft: sqlWrap ? Math.round(sqlWrap.scrollLeft) : 0,
  }
}

function restorePendingScrollPositions(clearAfter = false) {
  const sc = state.pendingScrollState
  if (!sc || typeof sc !== 'object') return
  const apply = () => {
    if (!isPanelActive()) return
    const viewport = document.querySelector('.viewport')
    const dataWrap = $('dataGridWrap')
    const sqlWrap = $('sqlResultWrap')
    if (viewport && Number.isFinite(sc.viewportTop) && sc.viewportTop > 0) {
      viewport.scrollTop = sc.viewportTop
    }
    if (dataWrap) {
      if (Number.isFinite(sc.dataGridTop) && sc.dataGridTop > 0) dataWrap.scrollTop = sc.dataGridTop
      if (Number.isFinite(sc.dataGridLeft) && sc.dataGridLeft > 0) dataWrap.scrollLeft = sc.dataGridLeft
      if (dataVirt?.active) renderDataVirtualWindow(false)
    }
    if (sqlWrap) {
      if (Number.isFinite(sc.sqlResultTop) && sc.sqlResultTop > 0) sqlWrap.scrollTop = sc.sqlResultTop
      if (Number.isFinite(sc.sqlResultLeft) && sc.sqlResultLeft > 0) sqlWrap.scrollLeft = sc.sqlResultLeft
      if (sqlVirt?.active) renderSqlVirtualWindow(false)
    }
    if (clearAfter) {
      state.pendingScrollState = null
    }
  }
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(apply)
  } else {
    apply()
  }
}

function sanitizeStringRecord(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === 'string' && k.length > 0 && typeof v === 'string' && v.trim().length > 0) {
      out[k] = v.trim()
    }
  }
  return out
}

function sanitizeStringArrayRecord(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === 'string' && k.length > 0 && Array.isArray(v)) {
      const cleaned = Array.from(
        new Set(v.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean))
      )
      out[k] = cleaned
    }
  }
  return out
}

function makeConnSchemaKey(connectionId, schema) {
  return `${encodeURIComponent(String(connectionId || '').trim())}:${encodeURIComponent(String(schema || '').trim())}`
}

function sanitizeNumberRecord(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw)) {
    if (
      typeof k === 'string' &&
      k.length > 0 &&
      typeof v === 'number' &&
      Number.isFinite(v) &&
      v >= 0
    ) {
      out[k] = v
    }
  }
  return out
}

function recordSelectedSchema(connectionId, schema, explicit) {
  const cleanConn = typeof connectionId === 'string' ? connectionId.trim() : ''
  const cleanSchema = typeof schema === 'string' ? schema.trim() : ''
  if (!cleanConn || !cleanSchema) return
  state.selectedSchemaByConn[cleanConn] = cleanSchema
  if (explicit) {
    state.selectedSchemaUpdatedAtByConn[cleanConn] = Math.max(
      Date.now(),
      (state.selectedSchemaUpdatedAtByConn[cleanConn] || 0) + 1
    )
  } else if (!Object.prototype.hasOwnProperty.call(state.selectedSchemaUpdatedAtByConn, cleanConn)) {
    state.selectedSchemaUpdatedAtByConn[cleanConn] = 0
  }
}

function clearConnectionSchemaCache(connectionId) {
  if (!connectionId) return
  delete state.schemaObjects[connectionId]
  delete state.schemaErrors[connectionId]
  delete state.availableSchemasByConn[connectionId]
  delete state.defaultSchemaByConn[connectionId]
  delete state.selectedSchemaByConn[connectionId]
  delete state.selectedSchemaUpdatedAtByConn[connectionId]
  const prefix = `${encodeURIComponent(String(connectionId).trim())}:`
  for (const key of Object.keys(state.schemaObjectsByConnSchema)) {
    if (key.startsWith(prefix)) {
      delete state.schemaObjectsByConnSchema[key]
    }
  }
}

function sanitizeSchemaObjectList(raw) {
  if (!Array.isArray(raw)) return []
  return raw.filter((o) => o && typeof o === 'object' && typeof o.name === 'string')
}

function serializeSchemaObjectsByConnSchema() {
  const entries = Object.entries(state.schemaObjectsByConnSchema || {})
  if (entries.length === 0) return null
  const recent = entries.slice(Math.max(0, entries.length - 16))
  const out = {}
  for (const [k, list] of recent) {
    if (Array.isArray(list)) {
      out[k] = sanitizeSchemaObjectList(list)
        .slice(0, 250)
        .map((o) => ({ ...o }))
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

function reconcilePanelSelectedSchemasFromSnapshot(saved, forceOverwrite) {
  if (!saved || typeof saved !== 'object') return false
  const savedSchemas = sanitizeStringRecord(saved.selectedSchemaByConn)
  const hasTsMap =
    saved.selectedSchemaUpdatedAtByConn !== undefined &&
    saved.selectedSchemaUpdatedAtByConn !== null &&
    typeof saved.selectedSchemaUpdatedAtByConn === 'object' &&
    !Array.isArray(saved.selectedSchemaUpdatedAtByConn)
  const savedTsMap = hasTsMap ? sanitizeNumberRecord(saved.selectedSchemaUpdatedAtByConn) : {}
  const fallbackTs =
    !hasTsMap && typeof saved.updatedAt === 'number' && Number.isFinite(saved.updatedAt) && saved.updatedAt >= 0
      ? saved.updatedAt
      : 0
  let upgradedActiveSchema = false
  for (const [cid, schema] of Object.entries(savedSchemas)) {
    const savedTs = hasTsMap ? (savedTsMap[cid] ?? 0) : fallbackTs
    const currentTs = state.selectedSchemaUpdatedAtByConn[cid] ?? -1
    if (forceOverwrite || !state.selectedSchemaByConn[cid] || savedTs > currentTs) {
      state.selectedSchemaByConn[cid] = schema
      state.selectedSchemaUpdatedAtByConn[cid] = Math.max(0, savedTs)
      if (!state.hasUserInteraction && cid === state.activeConnectionId && state.activeSchema !== schema) {
        const hadDifferentSchema = Boolean(state.activeSchema)
        state.activeSchema = schema
        if (hadDifferentSchema) {
          state.activeTable = null
          state.pageData = null
        }
        const cached = state.schemaObjectsByConnSchema[makeConnSchemaKey(cid, schema)]
        if (Array.isArray(cached)) {
          state.schemaObjects[cid] = cached.slice()
        } else if (hadDifferentSchema) {
          delete state.schemaObjects[cid]
        }
        upgradedActiveSchema = true
      }
    }
  }
  return upgradedActiveSchema
}

function isUnrestoredPanelBootState() {
  return (
    state.initialBootLoading &&
    !state.hasRestoredViewState &&
    !state.hasUserInteraction &&
    !state.activeConnectionId &&
    Object.keys(state.selectedSchemaByConn).length === 0
  )
}

function shouldShowActiveSchemaBar(activeConn, schemas) {
  if (state.formOpen || !activeConn || activeConn.driver === 'redis') return false
  if (!Array.isArray(schemas)) return false
  return schemas.length > 1 || (schemas.length === 1 && MULTI_SCHEMA_DRIVERS.has(activeConn.driver))
}

function savePanelDataCache() {
  if (state.restoringViewState || isUnrestoredPanelBootState()) return
  const activeKey =
    state.activeConnectionId && state.activeTable
      ? makeTableKey(state.activeConnectionId, state.activeTable, state.activeSchema)
      : null
  const activeSchemaObjs = state.activeConnectionId
    ? state.schemaObjects[state.activeConnectionId]
    : null
  const activeDetails = activeKey ? state.tableDetails[activeKey] : null

  const now = Date.now()
  const schemaObjectsByConnSchema = serializeSchemaObjectsByConnSchema()
  const cache = {
    updatedAt: now,
    activeConnectionId: state.activeConnectionId,
    activeTable: state.activeTable,
    activeSchema: state.activeSchema,
    page: state.page,
    pageSize: state.pageSize,
    whereClause: containsSensitiveSqlText(state.whereClause || '') ? '' : state.whereClause || '',
    orderByClause: state.orderByClause || '',
    availableSchemasByConn: sanitizeStringArrayRecord(state.availableSchemasByConn),
    defaultSchemaByConn: sanitizeStringRecord(state.defaultSchemaByConn),
    selectedSchemaByConn: sanitizeStringRecord(state.selectedSchemaByConn),
    schemaObjects: activeSchemaObjs ? { [state.activeConnectionId]: activeSchemaObjs } : null,
    ...(schemaObjectsByConnSchema ? { schemaObjectsByConnSchema } : {}),
    tableDetails: activeDetails && activeKey ? { [activeKey]: activeDetails } : null,
    pageData: state.pageData || null,
    lastSqlResult: state.lastSqlResult ? sanitizeSqlResultForStorage(state.lastSqlResult) : null,
  }

  try {
    const localWarm = {
      ...cache,
      connections: sanitizeWarmPanelConnections(state.connections),
      folderOrder: normalizeFolderOrder(state.folderOrder),
    }
    let localJson = JSON.stringify(localWarm)
    if (measureUtf8Bytes(localJson) > MAX_PANEL_LOCAL_WARM_BYTES && localWarm.lastSqlResult) {
      localWarm.lastSqlResult = null
      localJson = JSON.stringify(localWarm)
    }
    if (measureUtf8Bytes(localJson) > MAX_PANEL_LOCAL_WARM_BYTES && localWarm.pageData) {
      localWarm.pageData = null
      localJson = JSON.stringify(localWarm)
    }
    if (measureUtf8Bytes(localJson) > MAX_PANEL_LOCAL_WARM_BYTES && localWarm.tableDetails) {
      localWarm.tableDetails = null
      localJson = JSON.stringify(localWarm)
    }
    if (
      measureUtf8Bytes(localJson) > MAX_PANEL_LOCAL_WARM_BYTES &&
      localWarm.schemaObjectsByConnSchema
    ) {
      delete localWarm.schemaObjectsByConnSchema
      localJson = JSON.stringify(localWarm)
    }
    if (measureUtf8Bytes(localJson) <= MAX_PANEL_LOCAL_WARM_BYTES) {
      window.localStorage?.setItem(PANEL_WARM_CACHE_STORAGE_KEY, localJson)
    }
  } catch {}

  try {
    let bytes = measureUtf8Bytes(JSON.stringify(cache))
    if (bytes > MAX_PANEL_DATA_CACHE_BYTES && cache.lastSqlResult) {
      cache.lastSqlResult = null
      bytes = measureUtf8Bytes(JSON.stringify(cache))
    }
    if (bytes > MAX_PANEL_DATA_CACHE_BYTES && cache.pageData) {
      cache.pageData = null
      bytes = measureUtf8Bytes(JSON.stringify(cache))
    }
    if (bytes > MAX_PANEL_DATA_CACHE_BYTES && cache.tableDetails) {
      cache.tableDetails = null
      bytes = measureUtf8Bytes(JSON.stringify(cache))
    }
    if (bytes > MAX_PANEL_DATA_CACHE_BYTES && cache.schemaObjectsByConnSchema) {
      delete cache.schemaObjectsByConnSchema
      bytes = measureUtf8Bytes(JSON.stringify(cache))
    }
    if (bytes > MAX_PANEL_DATA_CACHE_BYTES && cache.schemaObjects) {
      cache.schemaObjects = null
    }
    void rpc('ui.saveSessionSnapshot', {
      surface: 'panel',
      dataCache: cache,
    }).catch(() => {})
  } catch {}
}

function savePanelViewState() {
  if (saveViewStateTimer !== null) {
    clearTimeout(saveViewStateTimer)
    saveViewStateTimer = null
  }
  if (state.restoringViewState || isUnrestoredPanelBootState()) return
  const rawSqlDraft = typeof getSqlText === 'function' ? getSqlText() : ''
  const safeSqlDraft = sqlDraftLooksSensitive(rawSqlDraft) ? '' : rawSqlDraft
  const consoleTabsSnapshot =
    typeof getConsoleTabsPersistedState === 'function'
      ? getConsoleTabsPersistedState(sqlDraftLooksSensitive)
      : null
  const snapshot = {
    updatedAt: Date.now(),
    tab: state.tab,
    activeConnectionId: state.activeConnectionId,
    activeTable: state.activeTable,
    activeSchema: state.activeSchema,
    page: state.page,
    pageSize: state.pageSize,
    sortCol: state.sortCol,
    sortDir: state.sortDir,
    whereClause: containsSensitiveSqlText(state.whereClause || '') ? '' : state.whereClause,
    orderByClause: state.orderByClause,
    transposed: state.transposed,
    collapsedFolders: Array.from(state.collapsedFolders || []),
    expandedConns: Array.from(state.expandedConns),
    expandedTables: Array.from(state.expandedTables),
    expandedMeta: Array.from(state.expandedMeta),
    selectedSchemaByConn: sanitizeStringRecord(state.selectedSchemaByConn),
    selectedSchemaUpdatedAtByConn: sanitizeNumberRecord(state.selectedSchemaUpdatedAtByConn),
    filter: state.filter,
    sqlDraft: safeSqlDraft,
    ...(typeof getSqlEditorHeight === 'function' && Number.isFinite(getSqlEditorHeight())
      ? { sqlEditorHeight: getSqlEditorHeight() }
      : {}),
    ...(consoleTabsSnapshot ? { consoleTabsState: consoleTabsSnapshot } : {}),
    scrollState: readPanelScrollState(),
    formOpen: Boolean(state.formOpen),
    editingId: state.editingId || null,
    formDriver: state.formDriver || 'sqlite',
    formColorTag: state.formColorTag || 'none',
    formDraft: {
      name: scrubConnectionNameForStorage($('formName')?.value || ''),
      folder: $('formFolder')?.value || '',
      workspaceScope:
        typeof state.pendingWorkspaceScope === 'string'
          ? state.pendingWorkspaceScope
          : $('formWorkspaceScope')?.value || '',
      filePath: $('formFilePath')?.value || '',
      libsqlUrl: scrubDraftUrlForLocalStorage($('formLibsqlUrl')?.value || ''),
      libsqlDb: $('formLibsqlDb')?.value || '',
      host: $('formHost')?.value || '',
      port: $('formPort')?.value || '',
      database: $('formDatabase')?.value || '',
      user: $('formUser')?.value || '',
      clickhouseUrl: scrubDraftUrlForLocalStorage($('formClickhouseUrl')?.value || ''),
      options: scrubDraftUrlForLocalStorage($('formOptions')?.value || ''),
      redisDb: $('formRedisDb')?.value || '0',
      ssl: Boolean($('formSsl')?.checked),
      ...(typeof state.formSslMode === 'string' ? { sslMode: state.formSslMode } : {}),
      ...(typeof state.formSslRejectUnauthorized === 'boolean'
        ? { sslRejectUnauthorized: state.formSslRejectUnauthorized }
        : {}),
      ...(state.formSslTouched ? { sslTouched: true } : {}),
      readOnly: Boolean($('formReadOnly')?.checked),
      byodFolder: $('panelByodFolderInput')?.value || '',
    },
  }
  try {
    let serialized = JSON.stringify(snapshot)
    if (measureUtf8Bytes(serialized) > MAX_PANEL_VIEW_STATE_BYTES) {
      snapshot.sqlDraft = snapshot.sqlDraft.slice(0, 8000)
      serialized = JSON.stringify(snapshot)
    }
    window.localStorage?.setItem(PANEL_VIEW_STATE_STORAGE_KEY, serialized)
  } catch {}
  try {
    void rpc('ui.saveSessionSnapshot', {
      surface: 'panel',
      viewState: snapshot,
    }).catch(() => {})
  } catch {}
}

function scheduleSavePanelViewState(delayMs = 150) {
  if (state.restoringViewState) return
  if (saveViewStateTimer !== null) {
    clearTimeout(saveViewStateTimer)
  }
  saveViewStateTimer = setTimeout(() => {
    saveViewStateTimer = null
    savePanelViewState()
  }, delayMs)
}

function flushPendingSavePanelViewState() {
  if (saveViewStateTimer !== null) {
    clearTimeout(saveViewStateTimer)
    saveViewStateTimer = null
  }
  savePanelViewState()
}

function applyPanelViewStateSnapshot(saved, options = {}) {
  if (!saved || typeof saved !== 'object') return
  const forceOverwrite = Boolean(options?.forceOverwrite)
  state.hasRestoredViewState = true
  state.restoringViewState = true
  try {
    if (typeof saved.updatedAt === 'number' && Number.isFinite(saved.updatedAt)) {
      state.restoredViewStateUpdatedAt = Math.max(state.restoredViewStateUpdatedAt, saved.updatedAt)
    }
    if (saved.activeConnectionId && typeof saved.activeConnectionId === 'string') {
      state.activeConnectionId = saved.activeConnectionId
    }
    if (saved.activeTable && typeof saved.activeTable === 'string') {
      state.activeTable = saved.activeTable
    } else if (forceOverwrite) {
      state.activeTable = null
    }
    if (saved.activeSchema && typeof saved.activeSchema === 'string') {
      state.activeSchema = saved.activeSchema
    } else if (forceOverwrite) {
      state.activeSchema = undefined
    }
    if (Number.isFinite(saved.page) && saved.page >= 1) {
      state.page = Math.floor(saved.page)
      state.restoredPage = state.page
    }
    if (
      Number.isFinite(saved.pageSize) &&
      [100, 500, 1000, 5000, 10000].includes(Number(saved.pageSize))
    ) {
      state.pageSize = Number(saved.pageSize)
      const ps = $('pageSizeSelect')
      if (ps instanceof HTMLSelectElement) {
        ps.value = String(state.pageSize)
        syncSelectTooltip(ps)
      }
    }
    if (typeof saved.sortCol === 'string' || saved.sortCol === null) {
      state.sortCol = saved.sortCol
    }
    if (saved.sortDir === 'ASC' || saved.sortDir === 'DESC') {
      state.sortDir = saved.sortDir
    }
    if (typeof saved.whereClause === 'string') {
      state.whereClause = saved.whereClause
      if ($('dataWhereInput')) $('dataWhereInput').value = saved.whereClause
    }
    if (typeof saved.orderByClause === 'string') {
      state.orderByClause = saved.orderByClause
      if ($('dataOrderInput')) $('dataOrderInput').value = saved.orderByClause
    }
    if ($('clearFilterBtn')) {
      $('clearFilterBtn').hidden = !state.whereClause && !state.orderByClause
    }
    if (typeof saved.transposed === 'boolean') {
      state.transposed = saved.transposed
    }
    if (Array.isArray(saved.collapsedFolders)) {
      state.collapsedFolders = new Set(
        saved.collapsedFolders
          .filter((x) => typeof x === 'string' && x.length > 0)
          .map((x) => {
            if (x.startsWith('folder:') || x.startsWith('builtin:')) return x
            if (x === UNGROUPED_FOLDER_ORDER_KEY || x === 'General (Ungrouped)') {
              return `builtin:${UNGROUPED_FOLDER_ORDER_KEY}`
            }
            return `folder:${x}`
          })
      )
    }
    if (Array.isArray(saved.expandedConns)) {
      state.hasRestoredExpandedConns = true
      state.expandedConns = new Set(saved.expandedConns.filter((x) => typeof x === 'string'))
    }
    if (Array.isArray(saved.expandedTables)) {
      state.expandedTables = new Set(saved.expandedTables.filter((x) => typeof x === 'string'))
    }
    if (Array.isArray(saved.expandedMeta)) {
      state.expandedMeta = new Set(saved.expandedMeta.filter((x) => typeof x === 'string'))
    }
    if (saved.selectedSchemaByConn && typeof saved.selectedSchemaByConn === 'object') {
      reconcilePanelSelectedSchemasFromSnapshot(saved, forceOverwrite)
    }
    if (state.activeConnectionId && state.selectedSchemaByConn[state.activeConnectionId] && !state.activeSchema) {
      state.activeSchema = state.selectedSchemaByConn[state.activeConnectionId]
    }
    if (typeof saved.filter === 'string') {
      state.filter = saved.filter
      if ($('schemaFilter')) $('schemaFilter').value = saved.filter
    }
    if (saved.consoleTabsState && Array.isArray(saved.consoleTabsState.tabs)) {
      state.restoredSqlDraft =
        saved.consoleTabsState.tabs.find((t) => t?.id === saved.consoleTabsState.activeTabId)?.sql ||
        saved.sqlDraft ||
        ''
      restoreConsoleTabsState?.(saved.consoleTabsState, saved.sqlDraft || '')
    } else if (typeof saved.sqlDraft === 'string' && saved.sqlDraft.trim()) {
      state.restoredSqlDraft = saved.sqlDraft
      restoreConsoleTabsState?.(null, saved.sqlDraft)
    }
    if (Number.isFinite(saved.sqlEditorHeight)) {
      setSqlEditorHeight?.(saved.sqlEditorHeight, { persist: false })
    }
    if (['explorer', 'data', 'sql', 'structure'].includes(saved.tab)) {
      switchTab(saved.tab)
    }
    if (typeof saved.formDriver === 'string' && ENGINE_BY_ID[saved.formDriver] && !ENGINE_BY_ID[saved.formDriver].studioOnly) {
      setFormDriver(resolvePanelFormDriver(saved.formDriver), false)
    }
    if (typeof saved.formColorTag === 'string') {
      connFormCtrl.setFormColorTag(saved.formColorTag)
    }
    if (saved.scrollState && typeof saved.scrollState === 'object') {
      state.pendingScrollState = saved.scrollState
    }
    if (saved.formDraft && typeof saved.formDraft === 'object') {
      const fd = saved.formDraft
      if (typeof fd.name === 'string' && $('formName')) $('formName').value = fd.name
      if (typeof fd.folder === 'string' && $('formFolder')) $('formFolder').value = fd.folder
      if (typeof fd.workspaceScope === 'string') {
        state.pendingWorkspaceScope = fd.workspaceScope
        const wsSel = $('formWorkspaceScope')
        if (wsSel) {
          if (fd.workspaceScope && !Array.from(wsSel.options).some((o) => o.value === fd.workspaceScope)) {
            const opt = document.createElement('option')
            opt.value = fd.workspaceScope
            opt.textContent = `Saved Scope: ${fd.workspaceScope}`
            opt.dataset.fullTitle = `Saved Scope: ${fd.workspaceScope}`
            wsSel.appendChild(opt)
          }
          wsSel.value = fd.workspaceScope
          syncSelectTooltip(wsSel)
          wsSel._customDropdownSync?.()
        }
      }
      if (typeof fd.filePath === 'string' && $('formFilePath')) $('formFilePath').value = fd.filePath
      if (typeof fd.libsqlUrl === 'string' && $('formLibsqlUrl')) $('formLibsqlUrl').value = fd.libsqlUrl
      if (typeof fd.libsqlDb === 'string' && $('formLibsqlDb')) $('formLibsqlDb').value = fd.libsqlDb
      if (typeof fd.host === 'string' && $('formHost')) $('formHost').value = fd.host
      if (typeof fd.port === 'string' && $('formPort')) $('formPort').value = fd.port
      if (typeof fd.database === 'string' && $('formDatabase')) $('formDatabase').value = fd.database
      if (typeof fd.user === 'string' && $('formUser')) $('formUser').value = fd.user
      if (typeof fd.clickhouseUrl === 'string' && $('formClickhouseUrl')) $('formClickhouseUrl').value = fd.clickhouseUrl
      if (typeof fd.options === 'string' && $('formOptions')) $('formOptions').value = fd.options
      if (typeof fd.redisDb === 'string' && $('formRedisDb')) {
        $('formRedisDb').value = fd.redisDb
        syncSelectTooltip($('formRedisDb'))
      }
      if (typeof fd.ssl === 'boolean' && $('formSsl')) $('formSsl').checked = fd.ssl
      if (
        fd.sslMode === 'auto' ||
        fd.sslMode === 'disable' ||
        fd.sslMode === 'require' ||
        fd.sslMode === 'verify-ca' ||
        fd.sslMode === 'verify-full'
      ) {
        state.formSslMode = fd.sslMode
      } else {
        state.formSslMode = undefined
      }
      state.formSslRejectUnauthorized =
        typeof fd.sslRejectUnauthorized === 'boolean' ? fd.sslRejectUnauthorized : undefined
      state.formSslTouched = Boolean(fd.sslTouched)
      connFormCtrl.syncSslVerifyUi?.()
      if (typeof fd.readOnly === 'boolean' && $('formReadOnly')) $('formReadOnly').checked = fd.readOnly
      if (typeof fd.byodFolder === 'string' && fd.byodFolder && $('panelByodFolderInput')) {
        $('panelByodFolderInput').dataset.driver = state.formDriver
        $('panelByodFolderInput').value = fd.byodFolder
      }
      connFormCtrl.syncOrgSafetyState?.()
    }
    if (typeof saved.editingId === 'string' || saved.editingId === null) {
      state.editingId = saved.editingId
    }
    if (typeof saved.formOpen === 'boolean') {
      state.formOpen = saved.formOpen
      updateViewportLayout()
    }
  } finally {
    state.restoringViewState = false
  }
}

function restorePanelViewStateFromLocal() {
  try {
    const raw = window.localStorage?.getItem(PANEL_VIEW_STATE_STORAGE_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      applyPanelViewStateSnapshot(parsed)
      return true
    }
  } catch {}
  return false
}

function restorePanelWarmCacheFromLocal() {
  try {
    const raw = window.localStorage?.getItem(PANEL_WARM_CACHE_STORAGE_KEY)
    if (!raw) return false
    const dc = JSON.parse(raw)
    if (!dc || typeof dc !== 'object' || !Array.isArray(dc.connections) || dc.connections.length === 0) {
      return false
    }
    state.connections = dc.connections
    if (Array.isArray(dc.folderOrder)) {
      state.folderOrder = normalizeFolderOrder(dc.folderOrder)
    }
    state.initialBootLoading = false
    state.warmBootHydrated = true
    state.warmBootUpdatedAt = Number.isFinite(dc.updatedAt) ? dc.updatedAt : 0
    if (!state.activeConnectionId && dc.activeConnectionId) {
      state.activeConnectionId = dc.activeConnectionId
    }
    if (dc.schemaObjects && typeof dc.schemaObjects === 'object') {
      for (const [cid, objs] of Object.entries(dc.schemaObjects)) {
        if (Array.isArray(objs) && !state.schemaObjects[cid]) {
          state.schemaObjects[cid] = sanitizeSchemaObjectList(objs)
        }
      }
    }
    if (dc.availableSchemasByConn && typeof dc.availableSchemasByConn === 'object') {
      for (const [cid, schemas] of Object.entries(sanitizeStringArrayRecord(dc.availableSchemasByConn))) {
        if (!state.availableSchemasByConn[cid]) {
          state.availableSchemasByConn[cid] = schemas
        }
      }
    }
    if (dc.defaultSchemaByConn && typeof dc.defaultSchemaByConn === 'object') {
      for (const [cid, schemaName] of Object.entries(sanitizeStringRecord(dc.defaultSchemaByConn))) {
        if (!state.defaultSchemaByConn[cid]) {
          state.defaultSchemaByConn[cid] = schemaName
        }
      }
    }
    if (dc.selectedSchemaByConn && typeof dc.selectedSchemaByConn === 'object') {
      for (const [cid, schemaName] of Object.entries(sanitizeStringRecord(dc.selectedSchemaByConn))) {
        if (!state.selectedSchemaByConn[cid]) {
          recordSelectedSchema(cid, schemaName, false)
        }
      }
    }
    if (dc.schemaObjectsByConnSchema && typeof dc.schemaObjectsByConnSchema === 'object') {
      for (const [k, objs] of Object.entries(dc.schemaObjectsByConnSchema)) {
        if (Array.isArray(objs) && !state.schemaObjectsByConnSchema[k]) {
          state.schemaObjectsByConnSchema[k] = sanitizeSchemaObjectList(objs)
        }
      }
    }
    if (dc.tableDetails && typeof dc.tableDetails === 'object') {
      for (const [tKey, det] of Object.entries(dc.tableDetails)) {
        if (det && typeof det === 'object' && !state.tableDetails[tKey]) {
          state.tableDetails[tKey] = det
        }
      }
    }
    const filterMatches =
      (dc.whereClause || '') === (state.whereClause || '') &&
      (dc.orderByClause || '') === (state.orderByClause || '') &&
      (!dc.page || dc.page === state.page) &&
      (!dc.pageSize || dc.pageSize === state.pageSize)
    if (
      dc.pageData &&
      filterMatches &&
      dc.activeConnectionId === state.activeConnectionId &&
      dc.activeTable === state.activeTable &&
      (dc.activeSchema || '') === (state.activeSchema || '')
    ) {
      state.pageData = dc.pageData
      lastLoadedPanelTableKey = makeTableKey(
        state.activeConnectionId,
        state.activeTable,
        state.activeSchema
      )
    }
    let restoredSql = false
    if (
      dc.lastSqlResult &&
      !state.lastSqlResult &&
      dc.activeConnectionId === state.activeConnectionId
    ) {
      state.lastSqlResult = dc.lastSqlResult
      restoredSql = true
    }
    renderPanelFolderChips()
    renderConnectionsBar()
    renderStructureTableSelect()
    syncPanelSqlSchema(state.activeConnectionId)
    renderExplorer()
    renderDataToolbar()
    renderDataGrid()
    renderSqlSafetyBanner()
    if (restoredSql && state.lastSqlResult) {
      renderQueryResult(state.lastSqlResult, { preserveScroll: true, skipCache: true })
    }
    renderStructure()
    restorePendingScrollPositions(false)
    return true
  } catch {
    return false
  }
}

async function persistActiveConnectionId(connectionId) {
  try {
    if (connectionId) {
      await window.orca?.storage?.set?.(ACTIVE_CONNECTION_STORAGE_KEY, connectionId)
    } else if (typeof window.orca?.storage?.delete === 'function') {
      await window.orca.storage.delete(ACTIVE_CONNECTION_STORAGE_KEY)
    } else {
      await window.orca?.storage?.set?.(ACTIVE_CONNECTION_STORAGE_KEY, '')
    }
  } catch {}
}

async function readPersistedActiveConnectionId() {
  try {
    const stored = await window.orca?.storage?.get?.(ACTIVE_CONNECTION_STORAGE_KEY)
    return typeof stored === 'string' && stored.trim().length > 0 ? stored : null
  } catch {
    return null
  }
}

function getActiveConn() {
  return state.connections.find((c) => c.id === state.activeConnectionId) || null
}

function getConnById(id) {
  return state.connections.find((c) => c.id === id) || null
}

function getStagedCount() {
  return state.stagedInserts.length + state.stagedUpdates.size + state.stagedDeletes.size
}

function clearStagedChanges() {
  dmlPreviewSeq++
  previewingDml = false
  setButtonLoading($('dmlPreviewBtn'), false)
  state.stagedInserts = []
  state.stagedUpdates.clear()
  state.stagedDeletes.clear()
  bumpAllHighlightRevisions?.()
  $('dmlPreviewDrawer').hidden = true
  if ($('dataRemoteChangeBanner')) $('dataRemoteChangeBanner').hidden = true
  renderStagingBar()
}

function showBanner(text, tone = 'neutral', opts = null) {
  if (tone === 'danger' && text) {
    const rawErr =
      opts && typeof opts === 'object' && typeof opts.rawError === 'string' && opts.rawError.trim()
        ? opts.rawError.trim()
        : String(text)
    state.lastError = rawErr
  }
  if (bannerDismissTimer !== null) {
    clearTimeout(bannerDismissTimer)
    bannerDismissTimer = null
  }
  bannerActionContext = opts && typeof opts === 'object' ? opts : null
  const box = $('globalBanner')
  box.className = `banner ${tone}`
  box.setAttribute('role', tone === 'danger' || tone === 'warn' ? 'alert' : 'status')
  $('globalBannerText').textContent = text
  const actionsEl = $('globalBannerActions')
  const retryBtn = $('globalBannerRetryBtn')
  const editBtn = $('globalBannerEditBtn')
  const hasRetry = typeof bannerActionContext?.onRetry === 'function'
  const hasEdit = typeof bannerActionContext?.onEdit === 'function'
  if (retryBtn) {
    retryBtn.hidden = !hasRetry
    retryBtn.textContent = bannerActionContext?.retryLabel || 'Retry'
  }
  if (editBtn) {
    editBtn.hidden = !hasEdit
    editBtn.textContent = bannerActionContext?.editLabel || 'Edit'
  }
  if (actionsEl) actionsEl.hidden = !hasRetry && !hasEdit
  box.hidden = false
  if (tone === 'success' || tone === 'neutral') {
    bannerDismissTimer = setTimeout(() => {
      bannerDismissTimer = null
      hideBanner()
    }, 3500)
  }
}

function hideBanner() {
  if (bannerDismissTimer !== null) {
    clearTimeout(bannerDismissTimer)
    bannerDismissTimer = null
  }
  bannerActionContext = null
  if ($('globalBannerActions')) $('globalBannerActions').hidden = true
  if ($('globalBannerRetryBtn')) {
    $('globalBannerRetryBtn').hidden = true
    $('globalBannerRetryBtn').textContent = 'Retry'
  }
  if ($('globalBannerEditBtn')) {
    $('globalBannerEditBtn').hidden = true
    $('globalBannerEditBtn').textContent = 'Edit'
  }
  $('globalBanner').hidden = true
}

function canEditConnection(conn) {
  return Boolean(conn && !ENGINE_BY_ID[conn.driver]?.studioOnly)
}

function showConnectionBanner(connectionId, rawMessage, tone = 'danger', opts = {}) {
  if (state.formOpen && opts?.source === 'schema' && !opts?.forceShowOverForm) {
    return
  }
  const conn = getConnById(connectionId)
  const rawError = String(rawMessage || '').trim() || opts.fallback || 'Connection error'
  const text = formatConnectionScopedMessage(conn, rawError, opts.fallback)
  const isErrorTone = tone === 'danger' || tone === 'warn'
  const canEdit = isErrorTone && canEditConnection(conn)
  const isTlsRemedy = isErrorTone && isActionableTlsErrorMessage(rawError)
  showBanner(text, tone, {
    ...opts,
    rawError,
    connectionId,
    editLabel: opts.editLabel || (isTlsRemedy ? 'Change Encryption' : 'Edit'),
    onEdit:
      opts.onEdit ??
      (canEdit
        ? () => {
            const latestConn = getConnById(connectionId)
            if (canEditConnection(latestConn)) {
              populateFormFromProfile(latestConn, 'edit', isTlsRemedy ? { focusSection: 'tls' } : undefined)
            }
          }
        : undefined),
  })
}

function syncSchemaErrorBanner(preferredConnId) {
  const summary = summarizeSchemaErrors(state.connections, state.schemaErrors, preferredConnId)
  if (!summary) {
    if (bannerActionContext?.source === 'schema') {
      hideBanner()
    }
    return
  }
  if (state.formOpen) {
    return
  }
  const targetConn = getConnById(summary.connectionId)
  const canEdit = canEditConnection(targetConn)
  const targetConnId = summary.connectionId
  const focusTls = Boolean(summary.tlsRemedy)
  showBanner(summary.text, 'danger', {
    source: 'schema',
    rawError: summary.rawError,
    connectionId: targetConnId,
    retryLabel: summary.retryLabel,
    editLabel: summary.editLabel,
    onRetry: () => {
      for (const cid of summary.failingIds) {
        if (getConnById(cid)) void loadSchema(cid)
      }
    },
    onEdit: canEdit
      ? () => {
          const latestConn = getConnById(targetConnId)
          if (canEditConnection(latestConn)) {
            populateFormFromProfile(latestConn, 'edit', focusTls ? { focusSection: 'tls' } : undefined)
          }
        }
      : undefined,
  })
}

function showFormNotice(text, tone = 'neutral') {
  hideBanner()
  const box = $('formNotice')
  box.className = `banner form-notice-sticky ${tone}`
  box.setAttribute('role', tone === 'danger' || tone === 'warn' ? 'alert' : 'status')
  $('formNoticeText').textContent = text
  box.hidden = false
}

function clearFormNotice() {
  $('formNotice').hidden = true
  clearPanelTlsRemedy()
}

function getPanelInstanceId() {
  const pid = window.orca?.panel?.id ?? window.orca?.panelId
  return typeof pid === 'string' && pid.trim() ? pid.trim() : undefined
}

let activeHostKeyRetryConnId = null

function clearPanelTlsRemedy() {
  const box = $('formTlsRemedyBox')
  if (!box) return
  box.textContent = ''
  box.classList.remove('is-hard-error')
  box.hidden = true
}

function applyPanelSslMode(mode) {
  state.formSslTouched = true
  state.formSslMode = mode
  if ($('formSsl')) $('formSsl').checked = mode !== 'disable'
  if (mode === 'require') {
    state.formSslRejectUnauthorized = false
  } else if (mode === 'verify-ca' || mode === 'verify-full' || mode === 'strict') {
    state.formSslRejectUnauthorized = true
  } else if (mode === 'disable') {
    state.formSslRejectUnauthorized = undefined
  }
  connFormCtrl.syncSslVerifyUi?.()
}

function promptUnverifiedTlsConfirmation(box, onConfirmRequire, onUseVerified) {
  if (!box) return
  let confirmBox = box.querySelector('[data-tls-unverified-confirm]')
  if (!confirmBox) {
    confirmBox = document.createElement('div')
    confirmBox.dataset.tlsUnverifiedConfirm = 'true'
    confirmBox.className = 'tls-remedy-hint'
    confirmBox.style.marginTop = '6px'
    confirmBox.style.padding = '6px 8px'
    confirmBox.style.border = '1px solid var(--warn, #f59e0b)'
    confirmBox.style.borderRadius = '6px'
    box.appendChild(confirmBox)
  }
  confirmBox.textContent = ''
  const msg = document.createElement('div')
  msg.textContent =
    'Mode "require" encrypts traffic WITHOUT verifying the server certificate (MITM risk). Confirm disabling certificate verification?'
  const acts = document.createElement('div')
  acts.className = 'tls-remedy-actions'
  acts.style.marginTop = '6px'

  const verifiedBtn = document.createElement('button')
  verifiedBtn.type = 'button'
  verifiedBtn.className = 'btn btn-sm btn-primary'
  verifiedBtn.dataset.tlsUseVerified = 'true'
  verifiedBtn.textContent = 'Use Verified TLS (verify-full)'
  verifiedBtn.addEventListener('click', onUseVerified)

  const confirmBtn = document.createElement('button')
  confirmBtn.type = 'button'
  confirmBtn.className = 'btn btn-sm'
  confirmBtn.dataset.tlsConfirmUnverified = 'true'
  confirmBtn.textContent = 'Confirm Unverified TLS & Retest'
  confirmBtn.addEventListener('click', onConfirmRequire)

  acts.append(verifiedBtn, confirmBtn)
  confirmBox.append(msg, acts)
}

function renderPanelTlsFailureRemedy(failure) {
  const box = $('formTlsRemedyBox')
  const triggerRetest = () => {
    clearPanelTlsRemedy()
    void runPanelConnectionTest()
  }
  renderSharedTlsFailureRemedy(box, failure, {
    displayMode: 'hidden',
    hintClass: 'tls-remedy-hint',
    actionsClass: 'tls-remedy-actions',
    buttonClass: 'btn btn-sm',
    allowAutoSuggestedMode: false,
    onInspectCaCert: (kind) => {
      if ($('sslCaPathRow')) $('sslCaPathRow').hidden = false
      void openPanelFilePickerModal({
        title: 'Select CA Certificate',
        mode: 'file',
        initialDir: $('formSslCaPath')?.value.trim() || undefined,
        extensions: ['.pem', '.crt', '.cer', '.ca-bundle'],
      })
        .then((res) => {
          if (!isPanelActive() || !state.formOpen) return
          if (res?.ok && res.path) {
            if ($('formSslCaPath')) $('formSslCaPath').value = res.path
            state.formSslCaPathTouched = true
            if ($('formSsl')) $('formSsl').checked = true
            if (
              state.formSslMode === 'disable' ||
              state.formSslMode === 'require' ||
              !state.formSslMode
            ) {
              applyPanelSslMode('verify-ca')
            } else {
              connFormCtrl.syncSslVerifyUi?.()
            }
            savePanelViewState?.()
            clearPanelTlsRemedy()
            showFormNotice('CA certificate selected. Click Test or Save & Connect to verify.', 'neutral')
            $('formSslCaPath')?.focus?.()
            return
          }
          if (kind === 'CaFileInvalid') {
            showFormNotice('Select a valid CA certificate file or clear the CA path and retry.', 'warn')
          }
          $('formSslCaPath')?.focus?.()
        })
        .catch(() => {
          $('formSslCaPath')?.focus?.()
        })
    },
    onInspectClientCert: () => {
      showFormNotice('Update client certificate & key paths in Full Studio and retry.', 'warn')
      $('formSslVerify')?.focus?.()
    },
    onApplySslMode: (mode, retest) => {
      if (mode === 'require') {
        promptUnverifiedTlsConfirmation(
          box,
          () => {
            applyPanelSslMode('require')
            if (retest) triggerRetest()
          },
          () => {
            applyPanelSslMode('verify-full')
            if (retest) triggerRetest()
          }
        )
        return
      }
      applyPanelSslMode(mode)
      if (retest) triggerRetest()
    },
    onSetServerName: (targetServerName) => {
      if ($('tlsServernameRow')) $('tlsServernameRow').hidden = false
      if ($('formTlsServername')) $('formTlsServername').value = targetServerName
      state.formTlsServernameTouched = true
      if ($('formSsl')) $('formSsl').checked = true
      connFormCtrl.syncSslVerifyUi?.()
      savePanelViewState?.()
      triggerRetest()
    },
    onVerifyCaOnly: () => {
      applyPanelSslMode('verify-ca')
    },
    onInspectTls: () => {
      $('formSslVerify')?.focus?.()
    },
  })
}

async function resolvePanelSshHostKeyDecision(input) {
  const res = await rpc('ssh.hostKey.resolve', input)
  return {
    ok: Boolean(res?.ok),
    decision: res?.decision ?? input.decision,
    savedPath: res?.savedPath,
    ...(typeof res?.retryToken === 'string' && res.retryToken
      ? { retryToken: res.retryToken }
      : {}),
  }
}

async function executeConnectionTestWithHostKeyRetry(sub) {
  const connId = sub?.profile?.id || state.editingId || undefined
  const prevConnId = activeHostKeyRetryConnId
  activeHostKeyRetryConnId = connId || null
  try {
    return await runWithSshHostKeyRetry({
      connectionId: connId,
      panelId: getPanelInstanceId(),
      jumpHosts: sub?.profile?.sshJumpHosts,
      isActive: isPanelActive,
      runAttempt: (retryCtx) =>
        rpc(
          'connection.test',
          retryCtx?.sshRetryToken ? { ...sub, sshRetryToken: retryCtx.sshRetryToken } : sub,
          { timeoutMs: QUERY_TIMEOUT_MS }
        ),
      resolveDecision: resolvePanelSshHostKeyDecision,
    })
  } finally {
    activeHostKeyRetryConnId = prevConnId
  }
}

async function copyText(text, successMsg, triggerBtn) {
  const copied = await writeTextToClipboard(text)

  if (copied && triggerBtn instanceof HTMLButtonElement) {
    const origLabel = triggerBtn.dataset.origLabel || triggerBtn.textContent || 'Copy'
    triggerBtn.dataset.origLabel = origLabel
    if (triggerBtn._copyResetTimer) {
      clearTimeout(triggerBtn._copyResetTimer)
    }
    triggerBtn.textContent = 'Copied'
    triggerBtn._copyResetTimer = setTimeout(() => {
      triggerBtn._copyResetTimer = null
      triggerBtn.textContent = origLabel
    }, 1200)
  }

  if (copied) {
    showBanner(successMsg || 'Copied to clipboard', 'success')
  } else {
    showBanner('Copy failed', 'danger')
  }
}

function updateViewportLayout() {
  const viewport = document.querySelector('.viewport')
  const active = getActiveConn()
  $('connFormBox').hidden = !state.formOpen
  $('activeConnCard').hidden = state.formOpen || !active
  if ($('activeConnCard').hidden) {
    $('connSelect')?._customDropdownApi?.close?.()
  }
  $('connMetaRow').hidden = state.formOpen || !active
  if ($('activeSchemaBar')) {
    const schemas =
      active && Array.isArray(state.availableSchemasByConn[active.id])
        ? state.availableSchemasByConn[active.id]
        : []
    $('activeSchemaBar').hidden = !shouldShowActiveSchemaBar(active, schemas)
    if ($('activeSchemaBar').hidden) {
      $('panelSchemaSelect')?._customDropdownApi?.close?.()
    }
  }
  if ($('structureTableBar')) {
    $('structureTableBar').hidden = state.formOpen || !active || state.tab !== 'structure'
  }
  $('tabExplorer').hidden = state.formOpen || state.tab !== 'explorer'
  $('tabData').hidden = state.formOpen || state.tab !== 'data'
  $('tabSql').hidden = state.formOpen || state.tab !== 'sql'
  $('tabStructure').hidden = state.formOpen || state.tab !== 'structure'
  if (viewport) {
    viewport.classList.toggle(
      'viewport-fill',
      !state.formOpen && (state.tab === 'data' || state.tab === 'sql')
    )
    $('connFormBox').classList.remove('form-fill-height')
  }
  const connectBtn = $('newServerBtn')
  if (connectBtn) {
    connectBtn.classList.toggle('btn-active', state.formOpen)
  }
}

function setFormOpen(open) {
  closeActiveCustomDropdown()
  state.formOpen = Boolean(open)
  if (!state.formOpen) {
    clearUriPasteTimer()
    connFormCtrl.clearFormImportSpotlight?.(true)
  }
  updateViewportLayout()
  if (state.formOpen) {
    const viewport = document.querySelector('.viewport')
    if (viewport) viewport.scrollTop = 0
  }
  savePanelViewState()
}

function switchTab(nextTab) {
  closeActiveCustomDropdown()
  closePanelComboPopover()
  hideBanner()
  if (state.formOpen) {
    clearUriPasteTimer()
    connFormCtrl.clearFormImportSpotlight?.(true)
  }
  if (typeof activeResizeCleanup === 'function') {
    activeResizeCleanup()
    activeResizeCleanup = null
  }
  if (typeof inspectorResizeCleanup === 'function') {
    inspectorResizeCleanup()
  }
  if (typeof cancelSqlEditorDrag === 'function') {
    cancelSqlEditorDrag()
  }
  if (state.formOpen) {
    state.formOpen = false
  }
  state.tab = nextTab
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === nextTab)
  })
  updateViewportLayout()
  if (nextTab === 'data' && dataVirt.active) {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => renderDataVirtualWindow(false))
    } else {
      renderDataVirtualWindow(false)
    }
  }
  if (nextTab === 'sql') {
    renderConsoleTabs()
    renderSqlSafetyBanner()
    syncPanelSqlSchema(state.activeConnectionId)
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => applyClampedSqlEditorHeight?.())
    } else {
      applyClampedSqlEditorHeight?.()
    }
    if (sqlVirt.active) {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => renderSqlVirtualWindow(false))
      } else {
        renderSqlVirtualWindow(false)
      }
    }
  }
  if (nextTab === 'structure') {
    renderStructureTableSelect()
    renderStructure()
  }
  savePanelViewState()
}

// Modular Domain Controllers (Connection Form, Explorer, SQL Runner, Structure Designer, Feedback & Palette)
const connFormCtrl = createPanelConnectionFormController({
  state,
  showBanner: (...a) => showBanner(...a),
  showFormNotice: (...a) => showFormNotice(...a),
  clearFormNotice: () => clearFormNotice(),
  setFormOpen: (...a) => setFormOpen(...a),
  updateViewportLayout: () => updateViewportLayout(),
  savePanelViewState: () => scheduleSavePanelViewState(80),
  copyText: (...a) => copyText(...a),
  clearUriPasteTimer: () => clearUriPasteTimer(),
})
const {
  initStaticSelectors,
  setFormDriver,
  resetConnectionForm,
  populateFormFromProfile,
  buildFormSubmission,
  handleParseUri,
  detectWorkspace,
  renderDiscoveredItems,
  renderPanelFolderChips,
  setFormControlsBusy,
  ensureUriParsedBeforeAction,
  ensureValidFolderBeforeSubmit,
  ensureRequiredPasswordBeforeSubmit,
} = connFormCtrl

const dataGridCtrl = createPanelDataGridController({
  state,
  VIRT_ROW_HEIGHT_PX,
  VIRT_OVERSCAN_ROWS,
  getActiveConn: () => getActiveConn(),
  getStagedCount: () => getStagedCount(),
  isSubmittingChanges: () => submittingChanges,
  isPreviewingDml: () => previewingDml,
  getDataGridSel: () => dataGridSel,
  getActiveTableKey: () => getActiveTableKey(),
  getOrderedVisibleColumns: () => getOrderedVisibleColumns(),
  getPinnedColsSet: (k) => getPinnedColsSet(k),
  getHiddenColsSet: (k) => getHiddenColsSet(k),
  getActiveTableDisplayEntry: (k) => getActiveTableDisplayEntry(k),
  patchTableDisplayState: (patch, opts) => patchTableDisplayState(patch, opts),
  reorderColumnByDrop: (fromCol, toCol, placement) => reorderColumnByDrop(fromCol, toCol, placement),
  getActiveForeignKeyMap: () => getActiveForeignKeyMap(),
  getColKeyResolver: (cols) => getPanelColKeyResolver(cols),
  getLastPanelCopiedText: () => lastPanelCopiedText,
  setLastPanelCopiedText: (v) => { lastPanelCopiedText = v },
  getSuppressSortClickUntil: () => suppressSortClickUntil,
  setSuppressSortClickUntil: (v) => { suppressSortClickUntil = v },
  getActiveResizeCleanup: () => activeResizeCleanup,
  setActiveResizeCleanup: (fn) => { activeResizeCleanup = fn },
  setInspectorUserModified: (v) => { inspectorUserModified = v },
  showBanner: (...a) => showBanner(...a),
  copyText: (...a) => copyText(...a),
  loadTablePage: (...a) => loadTablePage(...a),
  syncDataControlsDisabled: () => syncDataControlsDisabled(),
  renderDataColsPopoverList: () => renderDataColsPopoverList(),
})
const {
  dataVirt,
  bumpAllHighlightRevisions,
  recomputePinnedForViewport,
  computeVirtualRange,
  isActiveDataObjectView,
  renderDataToolbar,
  renderStagingBar,
  getEffectiveCellValue,
  isDataCellEditable,
  stageCellValue,
  applyQuickWhere,
  copyDataSelection,
  clearCopiedSnapshot,
  triggerPanelPasteSmart,
  triggerPanelPasteNewRows,
  pasteDelimitedIntoDataGrid,
  bulkSetSelectedCellsValue,
  cloneSelectedRows,
  toggleDeleteSelectedRows,
  toggleColumnPinned,
  toggleColumnHidden,
  autoFitDataColumn,
  exportCurrentDataPage,
  updateDataFindHighlights,
  getAllDisplayRows,
  updateGridSelectionHighlight,
  attachColumnResizeHandle,
  renderDataVirtualWindow,
  ensureDataVirtualRowVisible,
  renderDataGrid,
  startInlineEdit,
  buildDataChangesPayload,
  updateInspectorMetaAndJson,
  renderValueInspector,
} = dataGridCtrl

const sqlCtrl = createPanelSqlController({
  state,
  QUERY_TIMEOUT_MS,
  VIRT_ROW_HEIGHT_PX,
  getActiveConn: () => getActiveConn(),
  getConnById: (id) => getConnById(id),
  getSqlGridSel: () => sqlGridSel,
  getSuppressSortClickUntil: () => suppressSortClickUntil,
  setLastPanelCopiedText: (txt) => {
    lastPanelCopiedText = txt
    clearCopiedSnapshot()
  },
  computeVirtualRange: (...a) => computeVirtualRange(...a),
  attachColumnResizeHandle: (...a) => attachColumnResizeHandle(...a),
  copyText: (...a) => copyText(...a),
  showBanner: (...a) => showBanner(...a),
  loadSchema: (...a) => loadSchema(...a),
  savePanelViewState: () => savePanelViewState(),
  scheduleSavePanelViewState: (ms) => scheduleSavePanelViewState(ms),
  savePanelDataCache: () => savePanelDataCache(),
  onFormatSql: () => formatSqlInEditor(),
  getAiStatus: () => state.aiStatus,
  openAiSettingsModal: (initialRole) => openAiSettingsModal(initialRole),
  onRefreshAiStatus: () => hydrateAiStatus(),
  setPanelViewportResizing: (active) => setPanelViewportResizing(active),
})
const {
  sqlVirt,
  getSqlText,
  setSqlText,
  focusSqlEditor,
  setSqlDialect,
  setSqlSchema,
  setSqlColorScheme,
  setSqlTypography,
  openSqlFindReplace,
  destroySqlEditor,
  renderConsoleTabs,
  restoreConsoleTabsState,
  getConsoleTabsPersistedState,
  clearSqlResultDisplay,
  renderSqlSafetyBanner,
  resetSqlSafetyBannerDismissal,
  dismissSqlSafetyBanner,
  dismissActiveSqlSuccessBanner,
  dismissActiveSqlErrorBanner,
  getSortedSqlRows,
  renderSqlSelectionStats,
  copySqlSelection,
  exportCurrentSqlResult,
  renderSqlVirtualWindow,
  ensureSqlVirtualRowVisible,
  renderQueryResult,
  runSql,
  loadQueryHistory,
  renderQueryHistory,
  markSqlRunCancelled,
  cancelPendingSqlRun,
  bumpHistorySeq,
  getSqlEditorHeight,
  setSqlEditorHeight,
  applyClampedSqlEditorHeight,
  cancelSqlEditorDrag,
} = sqlCtrl

const structCtrl = createPanelStructureController({
  state,
  QUERY_TIMEOUT_MS,
  getActiveConn: () => getActiveConn(),
  getConnById: (id) => getConnById(id),
  showBanner: (...a) => showBanner(...a),
  showConnectionBanner: (...a) => showConnectionBanner(...a),
  savePanelViewState: () => savePanelViewState(),
  loadSchema: (...a) => loadSchema(...a),
  loadTableDetails: (...a) => loadTableDetails(...a),
  loadTablePage: (...a) => loadTablePage(...a),
})
const {
  isPanelComboOpen,
  closePanelComboPopover,
  createPanelComboInput,
  refreshPanelStructStageBar,
  closeMigrationConfirmModal,
  applyPanelStructChanges,
  executeConfirmedPanelMigration,
  renderStructure,
} = structCtrl

const explorerCtrl = createPanelExplorerController({
  state,
  QUERY_TIMEOUT_MS,
  getActiveConn: () => getActiveConn(),
  getConnById: (id) => getConnById(id),
  isSubmittingChanges: () => submittingChanges,
  getDataGridSel: () => dataGridSel,
  getActiveTableKey: () => getActiveTableKey(),
  getPinnedColsSet: (k) => getPinnedColsSet(k),
  activateConnection: (id) => activateConnection(id),
  loadSchema: (...a) => loadSchema(...a),
  selectTableAndOpen: (...a) => selectTableAndOpen(...a),
  showBanner: (...a) => showBanner(...a),
  showConnectionBanner: (...a) => showConnectionBanner(...a),
  copyText: (...a) => copyText(...a),
  exportCurrentDataPage: (...a) => exportCurrentDataPage(...a),
  exportCurrentSqlResult: (...a) => exportCurrentSqlResult(...a),
  renderValueInspector: () => renderValueInspector(),
  renderStagingBar: () => renderStagingBar(),
  copyDataSelection: (...a) => copyDataSelection(...a),
  copySqlSelection: (...a) => copySqlSelection(...a),
  triggerPanelPasteSmart: () => triggerPanelPasteSmart(),
  triggerPanelPasteNewRows: () => triggerPanelPasteNewRows(),
  isActiveDataObjectView: () => isActiveDataObjectView(),
  addBlankDataRow: () => addBlankDataRow(),
  bulkSetSelectedCellsValue: (...a) => bulkSetSelectedCellsValue(...a),
  openBulkFillModal: () => openBulkFillModal(),
  applyQuickWhere: (...a) => applyQuickWhere(...a),
  jumpToForeignKeyTarget: (...a) => jumpToForeignKeyTarget(...a),
  cloneSelectedRows: () => cloneSelectedRows(),
  toggleDeleteSelectedRows: () => toggleDeleteSelectedRows(),
  toggleColumnPinned: (...a) => toggleColumnPinned(...a),
  toggleColumnHidden: (...a) => toggleColumnHidden(...a),
  autoFitDataColumn: (...a) => autoFitDataColumn(...a),
  switchTab: (...a) => switchTab(...a),
  openFullStudio: (...a) => openFullStudio(...a),
  openDangerTableModal: (...a) => openDangerTableModal(...a),
  openCreateTableModal: () => openCreateTableModal(),
  persistActiveConnectionId: (...a) => persistActiveConnectionId(...a),
  renderConnectionsBar: () => renderConnectionsBar(),
  renderSqlSafetyBanner: () => renderSqlSafetyBanner(),
  resetSqlSafetyBannerDismissal: () => resetSqlSafetyBannerDismissal(),
  setSqlText: (...a) => setSqlText(...a),
  populateFormFromProfile: (...a) => populateFormFromProfile(...a),
  openDeleteConfirmModal: (...a) => openDeleteConfirmModal(...a),
  savePanelViewState: () => savePanelViewState(),
  reorderConnectionsInFolder: (folder, orderedIds) => reorderConnectionsInFolder(folder, orderedIds),
  reorderFolders: (orderedFolders) => reorderFolders(orderedFolders),
})
const {
  renderExplorer,
  expandAllExplorer,
  collapseAllExplorer,
  openContextMenu,
} = explorerCtrl

const feedbackPaletteCtrl = createPanelFeedbackAndPaletteController({
  state,
  getActiveConn: () => getActiveConn(),
  closeContextMenu: () => closeContextMenu(),
  closeDataColsPopover: () => closeDataColsPopover(),
  closePanelComboPopover: () => closePanelComboPopover(),
  resetConnectionForm: () => resetConnectionForm(),
  setFormOpen: (...a) => setFormOpen(...a),
  openFullStudio: (...a) => openFullStudio(...a),
  switchTab: (...a) => switchTab(...a),
  formatSqlInEditor: () => formatSqlInEditor(),
  openCreateTableModal: () => openCreateTableModal(),
  refreshConnections: () => refreshConnections(),
  copyText: (...a) => copyText(...a),
  showBanner: (...a) => showBanner(...a),
  onThemeToggled: (isLight) => setSqlColorScheme(isLight),
})
const {
  closeFeedbackModal,
  openShortcutsModal,
  closeShortcutsModal,
  openCmdPaletteModal,
  closeCmdPaletteModal,
} = feedbackPaletteCtrl

async function refreshConnections(options = {}) {
  if (!isPanelActive()) return
  const bypassReorderGuard = Boolean(options?.bypassReorderGuard)
  if (!bypassReorderGuard && pendingReorderCount > 0) {
    refreshConnectionsAfterReorder = true
    return
  }
  if (state.refreshingConns) {
    refreshConnectionsPending = true
    return
  }
  const isBoot = Boolean(options?.isBoot)
  const forceLive = Boolean(options?.forceLive)
  const isSilentWarmBoot = isBoot && state.warmBootHydrated && !forceLive
  state.refreshingConns = true
  const refBtn = $('refreshBtn')
  if (refBtn && !isSilentWarmBoot) {
    refBtn.disabled = true
    refBtn.classList.add('is-spinning')
    refBtn.setAttribute('aria-busy', 'true')
  }
  if (state.initialBootLoading && state.connections.length === 0) {
    renderExplorer()
  }
  try {
    const shouldFetchBootSnap = isBoot || state.initialBootLoading
    const [list, folderOrderRes, sessionSnap] = await Promise.all([
      rpc('connections.list'),
      rpc('folders.order.get').catch(() => null),
      shouldFetchBootSnap
        ? rpc('ui.getSessionSnapshot', { surface: 'panel' }).catch(() => null)
        : Promise.resolve(null),
    ])
    if (!isPanelActive()) return
    if (!bypassReorderGuard && pendingReorderCount > 0) {
      refreshConnectionsAfterReorder = true
      return
    }
    const prevConnSignature = JSON.stringify({
      connections: state.connections,
      folderOrder: state.folderOrder,
    })
    state.connections = Array.isArray(list) ? list : []
    if (folderOrderRes && Array.isArray(folderOrderRes.folderOrder)) {
      state.folderOrder = normalizeFolderOrder(folderOrderRes.folderOrder)
    }
    for (const cid of Object.keys(state.schemaErrors)) {
      if (!state.connections.some((c) => c.id === cid)) {
        delete state.schemaErrors[cid]
      }
    }
    if (bannerActionContext?.source === 'schema') {
      syncSchemaErrorBanner()
    }
    const connsChanged =
      prevConnSignature !==
      JSON.stringify({
        connections: state.connections,
        folderOrder: state.folderOrder,
      })
    state.initialBootLoading = false
    const workerView =
      sessionSnap?.viewState && typeof sessionSnap.viewState === 'object'
        ? sessionSnap.viewState
        : null
    const workerViewUpdatedAt = workerView
      ? Number.isFinite(workerView.updatedAt)
        ? workerView.updatedAt
        : Number.isFinite(sessionSnap?.updatedAt)
          ? sessionSnap.updatedAt
          : 0
      : 0
    if (
      workerView &&
      (!state.hasRestoredViewState ||
        (workerViewUpdatedAt > state.restoredViewStateUpdatedAt && !state.hasUserInteraction))
    ) {
      applyPanelViewStateSnapshot(workerView, { forceOverwrite: true })
    } else if (workerView && !state.hasUserInteraction) {
      reconcilePanelSelectedSchemasFromSnapshot(workerView, false)
    } else if (!state.activeConnectionId && typeof window.orca?.storage?.get === 'function') {
      try {
        const hostSaved = await window.orca.storage.get(PANEL_VIEW_STATE_STORAGE_KEY)
        if (hostSaved && typeof hostSaved === 'object') {
          applyPanelViewStateSnapshot(hostSaved, { forceOverwrite: true })
        }
      } catch {}
    }
    let restoredSqlResult = false
    let effectiveWarmAt = state.warmBootUpdatedAt || 0
    if (sessionSnap?.dataCache && typeof sessionSnap.dataCache === 'object') {
      const dc = sessionSnap.dataCache
      const snapUpdatedAt =
        (Number.isFinite(dc.updatedAt) && dc.updatedAt) ||
        (Number.isFinite(sessionSnap.updatedAt) && sessionSnap.updatedAt) ||
        0
      if (snapUpdatedAt > effectiveWarmAt) effectiveWarmAt = snapUpdatedAt
      if (dc.schemaObjectsByConnSchema && typeof dc.schemaObjectsByConnSchema === 'object') {
        for (const [k, objs] of Object.entries(dc.schemaObjectsByConnSchema)) {
          if (Array.isArray(objs) && (!state.schemaObjectsByConnSchema[k] || snapUpdatedAt > (state.warmBootUpdatedAt || 0))) {
            state.schemaObjectsByConnSchema[k] = sanitizeSchemaObjectList(objs)
          }
        }
      }
      if (dc.schemaObjects && typeof dc.schemaObjects === 'object') {
        for (const [cid, objs] of Object.entries(dc.schemaObjects)) {
          if (Array.isArray(objs) && (!state.schemaObjects[cid] || snapUpdatedAt > (state.warmBootUpdatedAt || 0))) {
            state.schemaObjects[cid] = sanitizeSchemaObjectList(objs)
          }
        }
      }
      if (dc.availableSchemasByConn && typeof dc.availableSchemasByConn === 'object') {
        for (const [cid, schemas] of Object.entries(sanitizeStringArrayRecord(dc.availableSchemasByConn))) {
          if (!state.availableSchemasByConn[cid]) {
            state.availableSchemasByConn[cid] = schemas
          }
        }
      }
      if (dc.defaultSchemaByConn && typeof dc.defaultSchemaByConn === 'object') {
        for (const [cid, schemaName] of Object.entries(sanitizeStringRecord(dc.defaultSchemaByConn))) {
          if (!state.defaultSchemaByConn[cid]) {
            state.defaultSchemaByConn[cid] = schemaName
          }
        }
      }
      if (dc.selectedSchemaByConn && typeof dc.selectedSchemaByConn === 'object') {
        for (const [cid, schemaName] of Object.entries(sanitizeStringRecord(dc.selectedSchemaByConn))) {
          if (!state.selectedSchemaByConn[cid]) {
            recordSelectedSchema(cid, schemaName, false)
          }
        }
      }
      if (dc.tableDetails && typeof dc.tableDetails === 'object') {
        for (const [tKey, det] of Object.entries(dc.tableDetails)) {
          if (det && typeof det === 'object' && !state.tableDetails[tKey]) {
            state.tableDetails[tKey] = det
          }
        }
      }
      if (
        dc.pageData &&
        !state.pageData &&
        dc.activeConnectionId === state.activeConnectionId &&
        dc.activeTable === state.activeTable &&
        (dc.activeSchema || '') === (state.activeSchema || '')
      ) {
        state.pageData = dc.pageData
      }
      if (
        dc.lastSqlResult &&
        !state.lastSqlResult &&
        dc.activeConnectionId === state.activeConnectionId
      ) {
        state.lastSqlResult = dc.lastSqlResult
        restoredSqlResult = true
      }
    }
    const liveConnIds = new Set(state.connections.map((c) => c.id))
    for (const mapObj of [
      state.availableSchemasByConn,
      state.defaultSchemaByConn,
      state.selectedSchemaByConn,
      state.selectedSchemaUpdatedAtByConn,
    ]) {
      for (const cid of Object.keys(mapObj)) {
        if (!liveConnIds.has(cid)) {
          delete mapObj[cid]
        }
      }
    }
    for (const key of Object.keys(state.schemaObjectsByConnSchema)) {
      const sepIdx = key.indexOf(':')
      const rawCid = sepIdx >= 0 ? decodeURIComponent(key.slice(0, sepIdx)) : ''
      if (!rawCid || !liveConnIds.has(rawCid)) {
        delete state.schemaObjectsByConnSchema[key]
      }
    }
    const isFreshWarmResume =
      isBoot &&
      !forceLive &&
      effectiveWarmAt > 0 &&
      Date.now() - effectiveWarmAt < PANEL_WARM_CACHE_FRESH_MS
    // Reconcile restored Edit Mode form metadata & stored credential flags
    if (state.formOpen && state.editingId) {
      const editMatch = state.connections.find((c) => c && c.id === state.editingId)
      if (editMatch) {
        state.formHadPassword = Boolean(editMatch.hasPassword)
        state.formHadAuthToken = Boolean(editMatch.hasAuthToken)
        if ($('connFormTitle')) $('connFormTitle').textContent = `Edit Connection — ${editMatch.name}`
        if ($('saveFormBtn')) $('saveFormBtn').textContent = 'Update Connection'
        if (editMatch.hasPassword && $('formPassword')) {
          $('formPassword').placeholder = 'Stored password preserved (type to replace)'
        }
        if (editMatch.hasAuthToken && $('formAuthToken')) {
          $('formAuthToken').placeholder = 'Stored token preserved (type to replace)'
        }
      } else {
        state.editingId = null
      }
    }
    if (state.formOpen && $('panelByodFolderInput') && $('panelByodCmdInput')) {
      $('panelByodFolderInput').dispatchEvent(new Event('input', { bubbles: false }))
    }
    const hasActive = Boolean(
      state.activeConnectionId && state.connections.some((c) => c.id === state.activeConnectionId)
    )
    if (!hasActive) {
      const persistedId = await readPersistedActiveConnectionId()
      if (!isPanelActive()) return
      const hasPersisted = Boolean(
        persistedId && state.connections.some((c) => c.id === persistedId)
      )
      state.activeConnectionId = hasPersisted
        ? persistedId
        : (state.connections.length > 0 ? state.connections[0].id : null)
      state.activeTable = null
      state.activeSchema = state.activeConnectionId
        ? state.selectedSchemaByConn[state.activeConnectionId] ||
          state.defaultSchemaByConn[state.activeConnectionId]
        : undefined
      if (workerView && !state.hasUserInteraction) {
        reconcilePanelSelectedSchemasFromSnapshot(workerView, false)
      }
      state.pageData = null
      state.page = 1
      state.sortCol = null
      clearStagedChanges()
      if (state.activeConnectionId) {
        state.expandedConns.add(state.activeConnectionId)
        void persistActiveConnectionId(state.activeConnectionId)
      } else {
        void persistActiveConnectionId(null)
      }
    }
    if (state.activeConnectionId && state.expandedConns.size === 0 && !state.hasRestoredExpandedConns) {
      state.expandedConns.add(state.activeConnectionId)
    }
    if (state.activeConnectionId) {
      const activeTargetSchema =
        state.selectedSchemaByConn[state.activeConnectionId] ||
        state.activeSchema ||
        state.defaultSchemaByConn[state.activeConnectionId] ||
        ''
      const cachedActiveObjs = activeTargetSchema
        ? state.schemaObjectsByConnSchema[makeConnSchemaKey(state.activeConnectionId, activeTargetSchema)]
        : undefined
      if (Array.isArray(cachedActiveObjs)) {
        state.schemaObjects[state.activeConnectionId] = cachedActiveObjs.slice()
      }
    }
    if (!isSilentWarmBoot || connsChanged || !hasActive) {
      renderPanelFolderChips()
      renderConnectionsBar()
      renderStructureTableSelect()
      syncPanelSqlSchema(state.activeConnectionId)
      renderExplorer()
      renderDataToolbar()
      renderDataGrid()
      renderSqlSafetyBanner()
      if (restoredSqlResult && state.lastSqlResult) {
        renderQueryResult(state.lastSqlResult, { preserveScroll: true, skipCache: true })
      }
      renderStructure()
      restorePendingScrollPositions(false)
    } else if (restoredSqlResult && state.lastSqlResult) {
      renderQueryResult(state.lastSqlResult, { preserveScroll: true, skipCache: true })
    }
    sqlCtrl?.onAiStatusChanged?.()
    const connsToLoad = new Set(state.expandedConns)
    if (state.activeConnectionId) {
      connsToLoad.add(state.activeConnectionId)
    }
    for (const cid of connsToLoad) {
      const conn = state.connections.find((c) => c.id === cid)
      if (!conn) continue
      const targetSchema =
        state.selectedSchemaByConn[cid] ||
        (cid === state.activeConnectionId ? state.activeSchema : undefined) ||
        state.defaultSchemaByConn[cid] ||
        ''
      const cachedForTarget = targetSchema
        ? state.schemaObjectsByConnSchema[makeConnSchemaKey(cid, targetSchema)]
        : undefined
      const activeObjs = state.schemaObjects[cid]
      const hasSchemaMatchedObjs =
        Array.isArray(cachedForTarget) ||
        (Array.isArray(activeObjs) &&
          activeObjs.length > 0 &&
          (!targetSchema || activeObjs.every((o) => !o?.schema || o.schema === targetSchema)))
      const activeNeedsPage =
        cid === state.activeConnectionId &&
        Boolean(state.activeTable) &&
        !state.pageData
      const needsMultiSchemaList =
        MULTI_SCHEMA_DRIVERS.has(conn.driver) && !Array.isArray(state.availableSchemasByConn[cid])
      if (isFreshWarmResume && hasSchemaMatchedObjs && !activeNeedsPage && !needsMultiSchemaList) {
        continue
      }
      void loadSchema(cid, hasSchemaMatchedObjs ? { silent: true } : {})
    }
    if (connsChanged) {
      savePanelDataCache()
    }
  } catch (err) {
    if (!isPanelActive()) return
    state.initialBootLoading = false
    showBanner(err?.message || 'Failed to load connections', 'danger')
    renderExplorer()
  } finally {
    state.initialBootLoading = false
    state.refreshingConns = false
    if (!isPanelActive()) return
    if (refBtn && !isSilentWarmBoot) {
      refBtn.disabled = false
      refBtn.classList.remove('is-spinning')
      refBtn.removeAttribute('aria-busy')
    }
    if (refreshConnectionsPending) {
      refreshConnectionsPending = false
      void refreshConnections({ forceLive: true })
    }
  }
}

function reorderConnectionsInFolder(folder, orderedIds) {
  if (!isPanelActive()) {
    return Promise.resolve({ ok: false, changed: false })
  }
  const plan = reorderConnectionsWithinFolder(state.connections, folder, orderedIds)
  if (!plan.ok || !plan.changed) {
    return Promise.resolve({ ok: plan.ok, changed: false })
  }

  const mySeq = ++reorderSeq
  const myConnSeq = ++connReorderSeq
  pendingReorderCount++
  const orderedSnapshot = Array.isArray(orderedIds) ? orderedIds.slice() : []
  state.connections = plan.connections
  renderConnectionsBar()
  renderExplorer()
  savePanelDataCache()

  const runPersist = async () => {
    if (!isPanelActive()) {
      pendingReorderCount = Math.max(0, pendingReorderCount - 1)
      if (pendingReorderCount === 0) {
        expectedSelfChangedEvents = 0
        consumedSelfChangedEvents = 0
      }
      return { ok: false, changed: false }
    }
    const consumedBefore = consumedSelfChangedEvents
    expectedSelfChangedEvents++
    try {
      const res = await rpc('connections.reorder', {
        folder: plan.folder,
        orderedIds: orderedSnapshot,
      })
      if (!isPanelActive()) return { ok: false, changed: false }
      if (!res?.changed) {
        if (expectedSelfChangedEvents > 0) {
          expectedSelfChangedEvents--
        } else if (consumedSelfChangedEvents > consumedBefore) {
          refreshConnectionsAfterReorder = true
        }
      }
      if (myConnSeq === connReorderSeq && Array.isArray(res?.connections)) {
        const prevSig = JSON.stringify(state.connections)
        state.connections = res.connections
        if (prevSig !== JSON.stringify(state.connections)) {
          renderConnectionsBar()
          renderExplorer()
          savePanelDataCache()
        }
      }
      return { ok: true, changed: Boolean(res?.changed) }
    } catch (err) {
      if (expectedSelfChangedEvents > 0) {
        expectedSelfChangedEvents--
      } else if (consumedSelfChangedEvents > consumedBefore) {
        refreshConnectionsAfterReorder = true
      }
      if (!isPanelActive()) return { ok: false, changed: false }
      showBanner(err?.message || 'Failed to reorder connections', 'danger')
      if (mySeq === reorderSeq) {
        await refreshConnections({ forceLive: true, bypassReorderGuard: true })
      } else {
        refreshConnectionsAfterReorder = true
      }
      return { ok: false, changed: false }
    } finally {
      pendingReorderCount = Math.max(0, pendingReorderCount - 1)
      if (pendingReorderCount === 0) {
        expectedSelfChangedEvents = 0
        consumedSelfChangedEvents = 0
        if (refreshConnectionsAfterReorder && isPanelActive()) {
          refreshConnectionsAfterReorder = false
          void refreshConnections({ forceLive: true })
        }
      }
    }
  }

  const task = reorderQueueChain.then(runPersist)
  reorderQueueChain = task.then(
    () => undefined,
    () => undefined
  )
  return task
}

function reorderFolders(orderedFolders) {
  if (!isPanelActive()) {
    return Promise.resolve({ ok: false, changed: false, folderOrder: state.folderOrder.slice() })
  }
  const currentFolderNames = getConnectionFolderOrderKeys(state.connections)
  const plan = reconcileFolderOrder(state.folderOrder, orderedFolders, currentFolderNames)
  if (!plan.ok || !plan.changed) {
    return Promise.resolve({ ok: plan.ok, changed: false, folderOrder: state.folderOrder.slice() })
  }

  const mySeq = ++reorderSeq
  const myFolderSeq = ++folderReorderSeq
  pendingReorderCount++
  const orderedSnapshot = Array.isArray(orderedFolders) ? orderedFolders.slice() : []
  state.folderOrder = plan.folderOrder
  renderConnectionsBar()
  renderExplorer()
  savePanelDataCache()

  const runPersist = async () => {
    if (!isPanelActive()) {
      pendingReorderCount = Math.max(0, pendingReorderCount - 1)
      if (pendingReorderCount === 0) {
        expectedSelfChangedEvents = 0
        consumedSelfChangedEvents = 0
      }
      return { ok: false, changed: false, folderOrder: state.folderOrder.slice() }
    }
    const consumedBefore = consumedSelfChangedEvents
    expectedSelfChangedEvents++
    try {
      const res = await rpc('folders.reorder', {
        orderedFolders: orderedSnapshot,
      })
      if (!isPanelActive()) {
        return { ok: false, changed: false, folderOrder: state.folderOrder.slice() }
      }
      if (!res?.changed) {
        if (expectedSelfChangedEvents > 0) {
          expectedSelfChangedEvents--
        } else if (consumedSelfChangedEvents > consumedBefore) {
          refreshConnectionsAfterReorder = true
        }
      }
      if (myFolderSeq === folderReorderSeq && Array.isArray(res?.folderOrder)) {
        const nextOrder = normalizeFolderOrder(res.folderOrder)
        if (JSON.stringify(state.folderOrder) !== JSON.stringify(nextOrder)) {
          state.folderOrder = nextOrder
          renderConnectionsBar()
          renderExplorer()
          savePanelDataCache()
        }
      }
      return {
        ok: true,
        changed: Boolean(res?.changed),
        folderOrder: state.folderOrder.slice(),
      }
    } catch (err) {
      if (expectedSelfChangedEvents > 0) {
        expectedSelfChangedEvents--
      } else if (consumedSelfChangedEvents > consumedBefore) {
        refreshConnectionsAfterReorder = true
      }
      if (!isPanelActive()) {
        return { ok: false, changed: false, folderOrder: state.folderOrder.slice() }
      }
      showBanner(err?.message || 'Failed to reorder folders', 'danger')
      if (mySeq === reorderSeq) {
        await refreshConnections({ forceLive: true, bypassReorderGuard: true })
      } else {
        refreshConnectionsAfterReorder = true
      }
      return { ok: false, changed: false, folderOrder: state.folderOrder.slice() }
    } finally {
      pendingReorderCount = Math.max(0, pendingReorderCount - 1)
      if (pendingReorderCount === 0) {
        expectedSelfChangedEvents = 0
        consumedSelfChangedEvents = 0
        if (refreshConnectionsAfterReorder && isPanelActive()) {
          refreshConnectionsAfterReorder = false
          void refreshConnections({ forceLive: true })
        }
      }
    }
  }

  const task = reorderQueueChain.then(runPersist)
  reorderQueueChain = task.then(
    () => undefined,
    () => undefined
  )
  return task
}

function getConnectionTlsBadgeLabel(conn) {
  if (!conn) return ''
  if (conn.sslCertPath || conn.sslKeyPath) return 'mTLS'
  if (
    conn.sslCaPath ||
    (conn.sslMode && conn.sslMode !== 'auto' && conn.sslMode !== 'disable') ||
    (conn.ssl && conn.sslMode !== 'disable')
  ) {
    return 'TLS'
  }
  return ''
}

function buildConnectionSelectorBadges(conn) {
  const badges = []
  const engineLabel = ENGINE_BY_ID[conn.driver]?.label || conn.driver
  if (engineLabel) {
    badges.push({ text: engineLabel, tone: 'neutral' })
  }
  if (conn.colorTag === 'prod' || conn.colorTag === 'staging' || conn.colorTag === 'dev') {
    badges.push({ text: conn.colorTag.toUpperCase(), tone: conn.colorTag })
  }
  if (conn.readOnly) {
    badges.push({ text: 'RO', tone: 'warn' })
  }
  if (conn.sshEnabled) {
    badges.push({ text: 'SSH', tone: 'neutral' })
  }
  const tlsLabel = getConnectionTlsBadgeLabel(conn)
  if (tlsLabel) {
    badges.push({ text: tlsLabel, tone: 'info' })
  }
  return badges
}

function renderConnectionsBar() {
  $('connCountBadge').textContent = String(state.connections.length)
  const envDot = $('envTagDot')
  if (envDot) envDot.hidden = true
  const roBadge = $('roBadge')
  if (roBadge) roBadge.hidden = true
  const activeDriverBadge = $('activeDriverBadge')
  if (activeDriverBadge) activeDriverBadge.hidden = true

  const active = getActiveConn()
  updateViewportLayout()
  if (!active) {
    closeActiveCustomDropdown()
    renderActiveSchemaBar()
    renderStructureTableSelect()
    return
  }
  setDbLogoElement($('activeConnLogo'), active.driver, 16)

  const sel = $('connSelect')
  sel.textContent = ''
  const buildOpt = (c) => {
    const opt = document.createElement('option')
    opt.value = c.id
    const tagText = c.colorTag && c.colorTag !== 'none' ? ` [${c.colorTag.toUpperCase()}]` : ''
    const roText = c.readOnly ? ' [RO]' : ''
    const sshText = c.sshEnabled ? ' [SSH]' : ''
    const tlsLabel = getConnectionTlsBadgeLabel(c)
    const tlsText = tlsLabel ? ` [${tlsLabel}]` : ''
    const sub = formatConnSubtitle(c)
    const engineLabel = ENGINE_BY_ID[c.driver]?.label || c.driver
    const badges = buildConnectionSelectorBadges(c)
    opt.textContent = `${c.name} (${c.driver})${tagText}${roText}${sshText}${tlsText}`
    opt.dataset.driver = c.driver
    opt.dataset.displayName = c.name
    opt.dataset.badges = JSON.stringify(badges)
    opt.dataset.searchText = [
      c.name,
      c.driver,
      engineLabel,
      c.colorTag && c.colorTag !== 'none' ? c.colorTag : '',
      c.readOnly ? 'ro readonly read-only' : '',
      c.sshEnabled ? 'ssh' : '',
      tlsLabel,
      c.folder || '',
      sub,
    ]
      .filter(Boolean)
      .join(' ')
    opt.dataset.fullTitle = `${c.name} (${c.driver})${tagText}${roText}${sshText}${tlsText}${c.folder ? ` — Folder: ${c.folder}` : ''}${sub ? ` — ${sub}` : ''}`
    if (c.id === active.id) opt.selected = true
    return opt
  }
  const hasGrouping = state.connections.some((c) => Boolean(normalizeConnectionFolderKey(c.folder)))
  if (!hasGrouping) {
    for (const c of state.connections) sel.appendChild(buildOpt(c))
  } else {
    const byFolder = new Map()
    const general = []
    for (const c of state.connections) {
      const f = normalizeConnectionFolderKey(c.folder)
      if (f) {
        if (!byFolder.has(f)) byFolder.set(f, [])
        byFolder.get(f).push(c)
      } else {
        general.push(c)
      }
    }
    const sectionKeys = [
      ...byFolder.keys(),
      ...(general.length > 0 ? [UNGROUPED_FOLDER_ORDER_KEY] : []),
    ]
    const sortedSectionKeys = sortFoldersByOrder(sectionKeys, state.folderOrder)
    for (const sectionKey of sortedSectionKeys) {
      const isUngrouped = sectionKey === UNGROUPED_FOLDER_ORDER_KEY
      const label = isUngrouped ? 'General (Ungrouped)' : sectionKey
      const items = isUngrouped ? general : byFolder.get(sectionKey)
      const grp = document.createElement('optgroup')
      grp.label = label
      grp.setAttribute('label', label)
      grp.dataset.folderKey = isUngrouped ? '' : sectionKey
      grp.dataset.folderOrderKey = sectionKey
      grp.dataset.sectionKey = isUngrouped
        ? `builtin:${UNGROUPED_FOLDER_ORDER_KEY}`
        : `folder:${sectionKey}`
      grp.dataset.reorderableFolder = '1'
      grp.dataset.reorderableItems = '1'
      for (const c of items) grp.appendChild(buildOpt(c))
      sel.appendChild(grp)
    }
  }
  const activeSub = formatConnSubtitle(active)
  $('connSubLabel').textContent = activeSub
  $('connSubLabel').title = activeSub
  $('connSubLabel').hidden = true
  enhanceCollapsibleSelectDropdown(sel, {
    tooltipPrefix: 'Active Database Connection',
    searchPlaceholder: 'Search connections or folders...',
    collapsedFolders: state.collapsedFolders,
    onFolderToggle: () => {
      savePanelViewState()
      renderExplorer()
    },
    reorderConnections: true,
    reorderFolders: true,
    onReorderConnections: (folderKey, orderedIds) => reorderConnectionsInFolder(folderKey, orderedIds),
    onReorderFolders: (orderedFolders) => reorderFolders(orderedFolders),
  })
  renderActiveSchemaBar()
  renderStructureTableSelect()
}

function renderActiveSchemaBar() {
  const bar = $('activeSchemaBar')
  const sel = $('panelSchemaSelect')
  const countBadge = $('activeSchemaCount')
  if (!bar || !sel) return

  const activeConn = getActiveConn()
  const cid = activeConn?.id
  const schemas =
    cid && Array.isArray(state.availableSchemasByConn[cid]) ? state.availableSchemasByConn[cid] : []

  if (!shouldShowActiveSchemaBar(activeConn, schemas)) {
    sel._customDropdownApi?.close?.()
    bar.hidden = true
    if (countBadge) {
      countBadge.hidden = true
      countBadge.textContent = ''
    }
    sel.textContent = ''
    sel.disabled = true
    sel._customDropdownSync?.()
    return
  }

  const selected = state.selectedSchemaByConn[cid]
  const fallback = state.defaultSchemaByConn[cid]
  const activeSchemaName =
    (selected && schemas.includes(selected) ? selected : null) ||
    (fallback && schemas.includes(fallback) ? fallback : null) ||
    schemas[0]

  sel.textContent = ''
  for (const schemaName of schemas) {
    const opt = document.createElement('option')
    opt.value = schemaName
    opt.textContent = schemaName
    opt.dataset.displayName = schemaName
    opt.dataset.fullTitle = `Schema: ${schemaName}`
    if (schemaName === activeSchemaName) {
      opt.selected = true
      opt.dataset.isCurrent = '1'
    }
    sel.appendChild(opt)
  }
  sel.value = activeSchemaName
  sel.disabled = false
  bar.hidden = false

  if (countBadge) {
    if (schemas.length > 1) {
      countBadge.textContent = String(schemas.length)
      countBadge.title = `${schemas.length} schemas available`
      countBadge.hidden = false
    } else {
      countBadge.hidden = true
      countBadge.textContent = ''
    }
  }

  enhanceCollapsibleSelectDropdown(sel, {
    tooltipPrefix: 'Active Schema',
    searchPlaceholder: 'Search schemas...',
    popoverMinWidth: 240,
    popoverMaxHeight: 320,
  })
}

let structureSchemaPrefetchSeq = 0

function renderStructureTableSelect() {
  const sel = $('structureTableSelect')
  if (!sel) return
  const activeConn = getActiveConn()
  const cid = activeConn?.id
  const objs = cid ? state.schemaObjects[cid] || [] : []
  const tabular = objs.filter(
    (o) => !o.kind || o.kind === 'table' || o.kind === 'view' || o.kind === 'materialized_view'
  )
  sel.textContent = ''
  if (!activeConn || tabular.length === 0) {
    const emptyOpt = document.createElement('option')
    emptyOpt.value = ''
    emptyOpt.textContent = !activeConn
      ? 'No active connection'
      : state.schemaLoading.has(cid)
        ? 'Loading tables...'
        : 'No tables in connection'
    emptyOpt.disabled = true
    emptyOpt.selected = true
    sel.appendChild(emptyOpt)
    sel.disabled = true
    enhanceCollapsibleSelectDropdown(sel, {
      tooltipPrefix: 'Schema Table',
      searchPlaceholder: 'Search tables or schemas...',
      collapsedFolders: state.collapsedSchemaGroups,
    })
    return
  }

  sel.disabled = false
  const grouped = new Map()
  const defaultSchemaLabel = activeConn.driver === 'sqlite' ? 'main' : 'Default'
  for (const obj of tabular) {
    const groupName = (obj.schema || '').trim() || defaultSchemaLabel
    if (!grouped.has(groupName)) grouped.set(groupName, [])
    grouped.get(groupName).push(obj)
  }

  const activeKey = state.activeTable
    ? encodeTableSelectValue(state.activeSchema || '', state.activeTable)
    : ''
  let matchedSelection = false

  if (!activeKey) {
    const promptOpt = document.createElement('option')
    promptOpt.value = ''
    promptOpt.textContent = 'Select a table...'
    promptOpt.disabled = true
    promptOpt.selected = true
    sel.appendChild(promptOpt)
  }

  const sortedSchemas = Array.from(grouped.keys()).sort((a, b) => {
    if (a === 'public' || a === 'main') return -1
    if (b === 'public' || b === 'main') return 1
    return a.localeCompare(b)
  })

  for (const schemaName of sortedSchemas) {
    const grp = document.createElement('optgroup')
    grp.label = schemaName
    const items = grouped.get(schemaName).slice().sort((a, b) => a.name.localeCompare(b.name))
    for (const obj of items) {
      const opt = document.createElement('option')
      const val = encodeTableSelectValue(obj.schema || '', obj.name)
      opt.value = val
      opt.textContent = obj.name
      const kindLabel = obj.kind && obj.kind !== 'table' ? obj.kind : 'table'
      opt.dataset.subtitle = kindLabel
      opt.dataset.fullTitle = obj.schema ? `${obj.schema}.${obj.name} (${kindLabel})` : `${obj.name} (${kindLabel})`
      if (activeKey && val === activeKey) {
        opt.selected = true
        opt.dataset.isCurrent = '1'
        matchedSelection = true
      } else if (!matchedSelection && state.activeTable && obj.name === state.activeTable) {
        opt.selected = true
        opt.dataset.isCurrent = '1'
        matchedSelection = true
      }
      grp.appendChild(opt)
    }
    sel.appendChild(grp)
  }

  enhanceCollapsibleSelectDropdown(sel, {
    tooltipPrefix: 'Schema Table',
    searchPlaceholder: 'Search tables or schemas...',
    collapsedFolders: state.collapsedSchemaGroups,
  })
}

function syncPanelSqlSchema(connectionId) {
  if (!connectionId) {
    setSqlSchema({}, undefined)
    return
  }
  const schemaMap = {}
  const objs = state.schemaObjects[connectionId] || []
  for (const obj of objs) {
    if (!obj?.name) continue
    if (obj.kind && obj.kind !== 'table' && obj.kind !== 'view' && obj.kind !== 'materialized_view') {
      continue
    }
    const det = state.tableDetails[makeTableKey(connectionId, obj.name, obj.schema)]
    const cols = det?.columns ? det.columns.map((c) => c.name).filter(Boolean) : []
    if (!Object.prototype.hasOwnProperty.call(schemaMap, obj.name) || cols.length > schemaMap[obj.name].length) {
      schemaMap[obj.name] = cols
    }
    if (obj.schema) {
      const qName = `${obj.schema}.${obj.name}`
      if (!Object.prototype.hasOwnProperty.call(schemaMap, qName) || cols.length > schemaMap[qName].length) {
        schemaMap[qName] = cols
      }
    }
  }
  if (
    state.activeConnectionId === connectionId &&
    state.activeTable &&
    Array.isArray(state.pageData?.columns) &&
    state.pageData.columns.length > 0
  ) {
    const activeCols = state.pageData.columns.map((c) => c.name).filter(Boolean)
    if (activeCols.length > 0) {
      schemaMap[state.activeTable] = activeCols
      if (state.activeSchema) {
        schemaMap[`${state.activeSchema}.${state.activeTable}`] = activeCols
      }
    }
  }
  setSqlSchema(schemaMap, state.activeConnectionId === connectionId ? state.activeTable || undefined : undefined)
}

async function prefetchPanelAutocompleteSchema(connectionId) {
  if (!connectionId || state.activeConnectionId !== connectionId) return
  const seq = ++structureSchemaPrefetchSeq
  const objs = (state.schemaObjects[connectionId] || []).filter(
    (o) => !o.kind || o.kind === 'table' || o.kind === 'view' || o.kind === 'materialized_view'
  )
  const activeTblKey = state.activeTable ? getActiveTableKey() : ''
  const missing = objs
    .filter((o) => {
      const k = makeTableKey(connectionId, o.name, o.schema)
      return k !== activeTblKey && !state.tableDetails[k]
    })
    .slice(0, 60)
  if (missing.length === 0) return

  let cursor = 0
  const workers = Array.from({ length: Math.min(3, missing.length) }, async () => {
    while (cursor < missing.length) {
      if (seq !== structureSchemaPrefetchSeq || state.activeConnectionId !== connectionId) return
      const target = missing[cursor++]
      if (!target) continue
      const key = makeTableKey(connectionId, target.name, target.schema)
      if (state.tableDetails[key]) continue
      try {
        const det = await rpc(
          'schema.tableDetails',
          {
            connectionId,
            table: target.name,
            ...(target.schema ? { schema: target.schema } : {}),
          },
          { timeoutMs: QUERY_TIMEOUT_MS }
        )
        if (seq !== structureSchemaPrefetchSeq || state.activeConnectionId !== connectionId) return
        if (det) {
          const prevFksJson = JSON.stringify(state.tableDetails[key]?.foreignKeys || [])
          const nextFksJson = JSON.stringify(det.foreignKeys || [])
          state.tableDetails[key] = det
          if (key === getActiveTableKey() && state.pageData && prevFksJson !== nextFksJson) {
            renderDataGrid()
          }
        }
      } catch {}
    }
  })
  await Promise.all(workers)
  if (seq === structureSchemaPrefetchSeq && state.activeConnectionId === connectionId) {
    syncPanelSqlSchema(connectionId)
  }
}

async function fetchCatalogObjects(connectionId, schema, forceRefresh = false) {
  const input = {
    connectionId,
    ...(schema ? { schema } : {}),
    ...(forceRefresh ? { forceRefresh: true } : {}),
  }
  try {
    const res = await rpc('schema.listObjectsCatalog', input, { timeoutMs: QUERY_TIMEOUT_MS })
    if (res && typeof res === 'object' && Array.isArray(res.data)) {
      return {
        objects: res.data,
        stale: Boolean(res.stale),
        staleReason: typeof res.staleReason === 'string' ? res.staleReason : undefined,
        cachedAt: typeof res.cachedAt === 'number' ? res.cachedAt : undefined,
      }
    }
    if (Array.isArray(res)) {
      return { objects: res, stale: false }
    }
  } catch {
    // Fallback to legacy schema.listObjects when catalog endpoint is unsupported
  }
  const fallback = await rpc(
    'schema.listObjects',
    { connectionId, ...(schema ? { schema } : {}) },
    { timeoutMs: QUERY_TIMEOUT_MS }
  )
  return {
    objects: Array.isArray(fallback) ? fallback : [],
    stale: false,
  }
}

async function loadSchema(connectionId, loadOpts = {}) {
  if (!connectionId || !isPanelActive()) return
  if (state.schemaLoading.has(connectionId) && !loadOpts?.force) {
    schemaRefreshPending.add(connectionId)
    return
  }
  const loadSeq = (schemaLoadSeqByConn.get(connectionId) || 0) + 1
  schemaLoadSeqByConn.set(connectionId, loadSeq)
  const isSilentLoad = Boolean(
    loadOpts?.silent &&
      Array.isArray(state.schemaObjects[connectionId]) &&
      state.schemaObjects[connectionId].length > 0
  )
  if (!isSilentLoad) {
    state.schemaLoading.add(connectionId)
    renderExplorer()
  }
  let releasedLoading = false
  const releaseLoadingIfCurrent = () => {
    if (releasedLoading) return
    releasedLoading = true
    if (schemaLoadSeqByConn.get(connectionId) === loadSeq) {
      const hadLoading = state.schemaLoading.delete(connectionId)
      if (hadLoading && isPanelActive()) {
        renderExplorer()
      }
    }
  }
  try {
    const requestedSchema =
      typeof loadOpts?.schema === 'string'
        ? loadOpts.schema
        : state.selectedSchemaByConn[connectionId] ||
          (connectionId === state.activeConnectionId ? state.activeSchema : undefined)
    const forceRefresh = Boolean(loadOpts?.forceRefresh)
    const [schemasResult, objectsOutcome] = await Promise.all([
      rpc('schema.listSchemas', { connectionId }, { timeoutMs: QUERY_TIMEOUT_MS }).catch(() => null),
      fetchCatalogObjects(connectionId, requestedSchema, forceRefresh).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error })
      ),
    ])
    if (!isPanelActive() || schemaLoadSeqByConn.get(connectionId) !== loadSeq || !getConnById(connectionId)) return

    let catalogMeta = objectsOutcome.ok ? objectsOutcome.value : null
    let finalObjects = Array.isArray(catalogMeta?.objects) ? catalogMeta.objects : []
    const listedSchemas =
      schemasResult && Array.isArray(schemasResult.schemas)
        ? Array.from(
            new Set(
              schemasResult.schemas
                .map((s) => (typeof s === 'string' ? s.trim() : ''))
                .filter(Boolean)
            )
          )
        : []
    const derivedSchemas = Array.from(
      new Set(
        finalObjects
          .map((o) => (typeof o?.schema === 'string' ? o.schema.trim() : ''))
          .filter(Boolean)
      )
    )
    const availableSchemas = listedSchemas.length > 0 ? listedSchemas : derivedSchemas
    const defaultSchema =
      (typeof schemasResult?.defaultSchema === 'string' && schemasResult.defaultSchema.trim()) ||
      availableSchemas[0] ||
      undefined

    state.availableSchemasByConn[connectionId] = availableSchemas
    if (defaultSchema) {
      state.defaultSchemaByConn[connectionId] = defaultSchema
    } else {
      delete state.defaultSchemaByConn[connectionId]
    }

    let didResetStaleSchema = false
    let didRecoverFromStaleThrow = false
    const currentSelected = state.selectedSchemaByConn[connectionId]
    if (availableSchemas.length > 0) {
      const candidate = requestedSchema || currentSelected
      if (candidate && !availableSchemas.includes(candidate)) {
        const nextFallback =
          defaultSchema && availableSchemas.includes(defaultSchema)
            ? defaultSchema
            : availableSchemas[0]
        if (nextFallback) {
          recordSelectedSchema(connectionId, nextFallback, true)
          didResetStaleSchema = true
          if (connectionId === state.activeConnectionId) {
            state.activeSchema = nextFallback
          }
          if (
            (!objectsOutcome.ok || finalObjects.length === 0) &&
            nextFallback !== requestedSchema &&
            !loadOpts?._retriedDefault
          ) {
            const fallbackMeta = await fetchCatalogObjects(
              connectionId,
              nextFallback,
              forceRefresh
            )
            if (!isPanelActive() || schemaLoadSeqByConn.get(connectionId) !== loadSeq || !getConnById(connectionId)) {
              return
            }
            catalogMeta = fallbackMeta
            finalObjects = Array.isArray(fallbackMeta?.objects) ? fallbackMeta.objects : []
            if (!objectsOutcome.ok) {
              didRecoverFromStaleThrow = true
            }
          }
        } else {
          delete state.selectedSchemaByConn[connectionId]
          delete state.selectedSchemaUpdatedAtByConn[connectionId]
        }
      } else {
        const resolved = candidate || defaultSchema
        if (resolved) {
          recordSelectedSchema(connectionId, resolved, false)
        }
      }
    } else if (requestedSchema) {
      recordSelectedSchema(connectionId, requestedSchema, false)
    } else if (defaultSchema) {
      recordSelectedSchema(connectionId, defaultSchema, false)
    }

    if (!objectsOutcome.ok && !didRecoverFromStaleThrow) {
      throw objectsOutcome.error
    }

    const resolvedConnSchema = state.selectedSchemaByConn[connectionId] || defaultSchema || undefined
    if (connectionId === state.activeConnectionId) {
      state.activeSchema = resolvedConnSchema
    }

    if (catalogMeta?.stale) {
      state.schemaStaleByConn[connectionId] = {
        stale: true,
        staleReason: catalogMeta.staleReason,
        cachedAt: catalogMeta.cachedAt,
      }
    } else {
      delete state.schemaStaleByConn[connectionId]
    }

    const hadSchemaError = Object.prototype.hasOwnProperty.call(state.schemaErrors, connectionId)
    delete state.schemaErrors[connectionId]
    state.schemaObjects[connectionId] = finalObjects
    state.schemaObjectsByConnSchema[makeConnSchemaKey(connectionId, resolvedConnSchema || '')] =
      finalObjects.slice()
    if (connectionId === state.activeConnectionId) {
      renderActiveSchemaBar()
    }
    releaseLoadingIfCurrent()
    if (hadSchemaError && bannerActionContext?.source === 'schema') {
      syncSchemaErrorBanner()
    }
    if (connectionId === state.activeConnectionId) {
      savePanelDataCache()
      if (didResetStaleSchema) {
        savePanelViewState()
      }
      const objs = state.schemaObjects[connectionId]
      const tabularObjs = objs.filter(
        (o) => !o.kind || o.kind === 'table' || o.kind === 'view' || o.kind === 'materialized_view'
      )
      const firstObj = tabularObjs.find((o) => o.kind === 'table') || tabularObjs[0] || objs[0]
      const matchedActive = state.activeTable
        ? tabularObjs.find(
            (o) =>
              o.name === state.activeTable &&
              (!state.activeSchema || (o.schema || '') === state.activeSchema)
          ) || tabularObjs.find((o) => o.name === state.activeTable)
        : null
      if ((!state.activeTable || !matchedActive) && firstObj) {
        state.activeTable = firstObj.name
        state.activeSchema = firstObj.schema || resolvedConnSchema
        renderStructureTableSelect()
        syncPanelSqlSchema(connectionId)
        void prefetchPanelAutocompleteSchema(connectionId)
        renderDataToolbar()
        renderExplorer()
        savePanelViewState()
        savePanelDataCache()
        await Promise.all([
          loadTablePage(connectionId, firstObj.name, 1, firstObj.schema),
          loadTableDetails(connectionId, firstObj.name, firstObj.schema),
        ])
      } else if (state.activeTable && matchedActive) {
        if (!state.activeSchema) {
          state.activeSchema = matchedActive.schema || resolvedConnSchema
        }
        renderStructureTableSelect()
        syncPanelSqlSchema(connectionId)
        void prefetchPanelAutocompleteSchema(connectionId)
        renderExplorer()
        const targetPage = state.restoredPage || state.page || 1
        state.restoredPage = 1
        const canSilentRefresh = Boolean(state.pageData && state.pageData.columns?.length > 0)
        renderDataToolbar()
        await Promise.all([
          loadTablePage(connectionId, state.activeTable, targetPage, state.activeSchema, {
            silent: canSilentRefresh,
          }),
          loadTableDetails(connectionId, state.activeTable, state.activeSchema),
        ])
      } else {
        state.activeTable = null
        state.activeSchema = resolvedConnSchema
        state.pageData = null
        state.selectedRowKey = null
        state.selectedCol = null
        state.structDraftKey = null
        state.structDraft = null
        state.structureLoading = false
        state.structureError = null
        dataGridSel?.clear(true)
        clearStagedChanges()
        renderStructureTableSelect()
        syncPanelSqlSchema(connectionId)
        renderExplorer()
        renderDataToolbar()
        renderDataGrid()
        renderStructure()
        renderValueInspector()
        savePanelViewState()
        savePanelDataCache()
      }
    }
  } catch (err) {
    if (!isPanelActive() || schemaLoadSeqByConn.get(connectionId) !== loadSeq) return
    const conn = getConnById(connectionId)
    if (conn) {
      const rawMsg = String(err?.message || '').trim() || 'Failed to inspect schema'
      state.schemaErrors[connectionId] = rawMsg
      syncSchemaErrorBanner(connectionId)
    }
  } finally {
    releaseLoadingIfCurrent()
    if (isPanelActive() && schemaLoadSeqByConn.get(connectionId) === loadSeq && schemaRefreshPending.has(connectionId)) {
      schemaRefreshPending.delete(connectionId)
      if (getConnById(connectionId)) {
        void loadSchema(connectionId)
      }
    }
  }
}

function cancelPendingDataAndSchemaLoads() {
  dataPageLoadSeq++
  dmlPreviewSeq++
  cancelPendingSqlRun()
  if (dataLoadStopTimer) {
    dataLoadStopTimer()
    dataLoadStopTimer = null
  }
  state.dataLoading = false
  state.structureLoading = false
  state.activeQueryId = null
  if ($('dataRemoteChangeBanner')) $('dataRemoteChangeBanner').hidden = true
  if ($('runSqlBtn')) $('runSqlBtn').disabled = false
  if ($('runAllSqlBtn')) $('runAllSqlBtn').disabled = false
  if ($('explainSqlBtn')) $('explainSqlBtn').disabled = false
  if ($('formatSqlBtn')) $('formatSqlBtn').disabled = false
  const cancelBtn = $('cancelSqlBtn')
  if (cancelBtn) {
    setButtonLoading(cancelBtn, false)
    cancelBtn.hidden = true
  }
  syncDataControlsDisabled()
  renderStagingBar()
}

function activateConnection(connectionId) {
  state.hasUserInteraction = true
  cancelPendingDataAndSchemaLoads()
  resetSqlSafetyBannerDismissal()
  if (connectionId && state.schemaErrors[connectionId]) {
    syncSchemaErrorBanner(connectionId)
  } else if (
    (bannerActionContext?.connectionId && bannerActionContext.connectionId !== connectionId) ||
    bannerActionContext?.source === 'schema'
  ) {
    hideBanner()
  }
  state.activeConnectionId = connectionId || null
  state.activeTable = null
  state.activeSchema =
    (connectionId &&
      (state.selectedSchemaByConn[connectionId] || state.defaultSchemaByConn[connectionId])) ||
    undefined
  if (connectionId) {
    const cachedBySchema =
      state.schemaObjectsByConnSchema[makeConnSchemaKey(connectionId, state.activeSchema || '')]
    if (Array.isArray(cachedBySchema)) {
      state.schemaObjects[connectionId] = cachedBySchema.slice()
    } else if (
      state.activeSchema &&
      Array.isArray(state.schemaObjects[connectionId]) &&
      state.schemaObjects[connectionId].some((o) => o?.schema && o.schema !== state.activeSchema)
    ) {
      delete state.schemaObjects[connectionId]
    }
  }
  state.pageData = null
  state.page = 1
  state.sortCol = null
  state.selectedRowKey = null
  state.selectedCol = null
  state.inspectorOpen = false
  state.structureError = null
  state.structDraftKey = null
  state.structDraft = null
  state.lastSqlResult = null
  state.sqlSortColIdx = null
  clearSqlResultDisplay()
  dataGridSel?.clear(true)
  sqlGridSel?.clear(true)
  clearStagedChanges()
  void persistActiveConnectionId(state.activeConnectionId)
  if (state.activeConnectionId) {
    state.expandedConns.add(state.activeConnectionId)
  }
  savePanelViewState()
  savePanelDataCache()
  renderConnectionsBar()
  renderStructureTableSelect()
  syncPanelSqlSchema(state.activeConnectionId)
  renderExplorer()
  renderDataToolbar()
  renderDataGrid()
  renderValueInspector()
  renderSqlSafetyBanner()
  renderStructure()
  if (state.activeConnectionId) {
    const cached = state.schemaObjects[state.activeConnectionId]
    const hasSchemas = Array.isArray(state.availableSchemasByConn[state.activeConnectionId])
    if (cached && cached.length > 0) {
      const firstObj = cached.find((o) => o.kind === 'table') || cached[0]
      if (firstObj) {
        selectTableAndOpen(state.activeConnectionId, firstObj.name, firstObj.schema, false)
      }
      if (!hasSchemas) {
        void loadSchema(state.activeConnectionId, { silent: true })
      }
      return
    }
    void loadSchema(state.activeConnectionId)
  }
}

function handlePanelSchemaChange(nextSchema) {
  const cid = state.activeConnectionId
  if (!cid) return
  const trimmed = typeof nextSchema === 'string' ? nextSchema.trim() : ''
  if (!trimmed) return
  state.hasUserInteraction = true
  cancelPendingDataAndSchemaLoads()
  resetSqlSafetyBannerDismissal()
  recordSelectedSchema(cid, trimmed, true)
  state.activeSchema = trimmed
  state.activeTable = null
  state.pageData = null
  state.page = 1
  state.sortCol = null
  state.selectedRowKey = null
  state.selectedCol = null
  state.inspectorOpen = false
  state.structDraftKey = null
  state.structDraft = null
  state.structPreviewOpen = false
  state.structureLoading = false
  state.structureError = null
  const cachedObjs = state.schemaObjectsByConnSchema[makeConnSchemaKey(cid, trimmed)]
  const hasCachedNonEmpty = Array.isArray(cachedObjs) && cachedObjs.length > 0
  state.schemaObjects[cid] = Array.isArray(cachedObjs) ? cachedObjs.slice() : []
  state.expandedConns.add(cid)
  dataVirt.active = false
  dataGridSel?.clear(true)
  clearStagedChanges()
  savePanelViewState()
  savePanelDataCache()
  renderActiveSchemaBar()
  renderExplorer()
  renderDataToolbar()
  renderDataGrid()
  renderStructureTableSelect()
  renderStructure()
  renderValueInspector()
  syncPanelSqlSchema(cid)
  void loadSchema(cid, { force: true, schema: trimmed, silent: hasCachedNonEmpty })
}

async function loadTableDetails(connectionId, table, schema) {
  const detailsKey = makeTableKey(connectionId, table, schema)
  const reqSeq = (tableDetailsSeqByKey.get(detailsKey) || 0) + 1
  tableDetailsSeqByKey.set(detailsKey, reqSeq)
  const normSchema = schema || ''
  const isActiveTarget = () =>
    state.activeConnectionId === connectionId &&
    state.activeTable === table &&
    (state.activeSchema || '') === normSchema

  delete state.tableDetailsErrors[detailsKey]
  if (isActiveTarget()) {
    state.structureError = null
    if (!state.tableDetails[detailsKey]) {
      state.structureLoading = true
      renderStructure()
    }
  }
  try {
    const details = await rpc(
      'schema.tableDetails',
      { connectionId, table, ...(schema ? { schema } : {}) },
      { timeoutMs: QUERY_TIMEOUT_MS }
    )
    if (tableDetailsSeqByKey.get(detailsKey) !== reqSeq || !getConnById(connectionId)) return
    if (details) {
      if (!details.ddl) {
        try {
          const ddlRes = await rpc(
            'schema.generateDdl',
            { connectionId, table, ...(schema ? { schema } : {}) },
            { timeoutMs: QUERY_TIMEOUT_MS }
          )
          if (tableDetailsSeqByKey.get(detailsKey) !== reqSeq || !getConnById(connectionId)) return
          if (ddlRes?.ddl) details.ddl = ddlRes.ddl
        } catch {}
      }
      if (tableDetailsSeqByKey.get(detailsKey) !== reqSeq || !getConnById(connectionId)) return
      if (!details.ddl) {
        const conn = getConnById(connectionId)
        details.ddl = buildDdlFallback(details, conn?.driver || 'sqlite')
      }
      const prevFksJson = JSON.stringify(state.tableDetails[detailsKey]?.foreignKeys || [])
      const nextFksJson = JSON.stringify(details.foreignKeys || [])
      state.tableDetails[detailsKey] = details
      delete state.tableDetailsErrors[detailsKey]
      renderExplorer()
      if (isActiveTarget()) {
        state.structureLoading = false
        state.structureError = null
        savePanelDataCache()
        renderStructure()
        syncPanelSqlSchema(connectionId)
        if (state.pageData && prevFksJson !== nextFksJson) {
          renderDataGrid()
        }
      }
    } else if (isActiveTarget()) {
      state.structureLoading = false
      state.structureError = null
      renderStructure()
    }
  } catch (err) {
    if (tableDetailsSeqByKey.get(detailsKey) === reqSeq) {
      const msg = err?.message || `Failed to load schema for "${table}".`
      state.tableDetailsErrors[detailsKey] = msg
      renderExplorer()
      if (isActiveTarget()) {
        state.structureLoading = false
        state.structureError = msg
        renderStructure()
      }
    }
  }
}

function syncDataControlsDisabled() {
  const busy = Boolean(state.dataLoading || submittingChanges)
  const pd = state.pageData
  const totalPages = pd ? Math.max(1, Math.ceil(pd.totalRows / (pd.pageSize || state.pageSize || 100))) : 1
  const reloadBtn = $('reloadDataBtn')
  if (reloadBtn) {
    reloadBtn.disabled = busy
    reloadBtn.classList.toggle('is-spinning', Boolean(state.dataLoading))
  }
  if ($('prevPageBtn')) $('prevPageBtn').disabled = busy || !pd || pd.page <= 1
  if ($('nextPageBtn')) $('nextPageBtn').disabled = busy || !pd || pd.page >= totalPages
  if ($('pageSizeSelect')) $('pageSizeSelect').disabled = busy
  if ($('dataTableSelect')) $('dataTableSelect').disabled = busy
  if ($('applyFilterBtn')) $('applyFilterBtn').disabled = busy
  if ($('clearFilterBtn')) $('clearFilterBtn').disabled = busy
}

let lastPanelCopiedText = ''

async function loadTablePage(connectionId, table, page = 1, schema = state.activeSchema, opts = {}) {
  const reqSeq = ++dataPageLoadSeq
  const normSchema = schema || ''
  const targetTableKey = makeTableKey(connectionId, table, schema)
  const isSameTable = lastLoadedPanelTableKey === targetTableKey
  const gridWrapBefore = $('dataGridWrap')
  const preservedScrollLeft = isSameTable && gridWrapBefore ? gridWrapBefore.scrollLeft : 0
  if (dataLoadStopTimer) {
    dataLoadStopTimer()
    dataLoadStopTimer = null
  }
  if ($('dataRemoteChangeBanner')) $('dataRemoteChangeBanner').hidden = true
  state.dataLoading = true
  const isSilent = Boolean(opts.silent && state.pageData && state.pageData.columns?.length > 0)
  state.silentDataRefresh = isSilent
  const pager = $('dataPager')
  const pagerInfo = $('dataPagerInfo')
  const footer = $('dataFooter')
  if (!isSilent) {
    renderDataGrid()
    syncDataControlsDisabled()
    renderStagingBar()
    if (pager && pagerInfo) {
      if (footer) footer.hidden = false
      pager.hidden = false
      dataLoadStopTimer = createElapsedTimer((elapsed) => {
        if (reqSeq === dataPageLoadSeq && state.dataLoading) {
          pagerInfo.textContent = `Loading ${table}${page > 1 ? ` (page ${page})` : ''}... ${elapsed}`
        }
      })
    }
  }
  try {
    const payload = {
      connectionId,
      table,
      page,
      pageSize: state.pageSize || 100,
      ...(schema ? { schema } : {}),
      ...(state.whereClause ? { whereClause: state.whereClause } : {}),
      ...(state.orderByClause ? { orderByClause: state.orderByClause } : {}),
      ...(state.sortCol && !state.orderByClause ? { sortColumn: state.sortCol, sortDirection: state.sortDir } : {}),
    }
    const res = await rpc('data.fetchPage', payload, { timeoutMs: QUERY_TIMEOUT_MS })
    if (
      reqSeq !== dataPageLoadSeq ||
      state.activeConnectionId !== connectionId ||
      state.activeTable !== table ||
      (state.activeSchema || '') !== normSchema
    ) {
      return
    }
    if (dataLoadStopTimer) {
      dataLoadStopTimer()
      dataLoadStopTimer = null
    }
    const prevPageData = state.pageData
    const isUnchangedSilentPayload = Boolean(
      isSilent &&
        isSameTable &&
        prevPageData &&
        res &&
        prevPageData.totalRows === res.totalRows &&
        prevPageData.page === res.page &&
        prevPageData.pageSize === res.pageSize &&
        Array.isArray(prevPageData.rows) &&
        Array.isArray(res.rows) &&
        prevPageData.rows.length === res.rows.length &&
        JSON.stringify(prevPageData.columns) === JSON.stringify(res.columns) &&
        JSON.stringify(prevPageData.rows) === JSON.stringify(res.rows)
    )
    state.dataLoading = false
    state.silentDataRefresh = false
    state.pageData = res
    state.page = page
    if (state.tableDisplayByTable[targetTableKey]) {
      syncLegacySetsFromDisplayEntry(targetTableKey, state.tableDisplayByTable[targetTableKey])
    }
    savePanelViewState()
    savePanelDataCache()
    lastLoadedPanelTableKey = targetTableKey
    if (!isUnchangedSilentPayload) {
      state.selectedRowKey = null
      state.selectedCol = null
      if (dataGridSel) dataGridSel.clear(true)
      clearStagedChanges()
      renderDataGrid()
      if (state.pendingScrollState) {
        restorePendingScrollPositions(true)
      } else if (isSameTable && preservedScrollLeft > 0) {
        const gridWrapAfter = $('dataGridWrap')
        if (gridWrapAfter) {
          gridWrapAfter.scrollLeft = preservedScrollLeft
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
              gridWrapAfter.scrollLeft = preservedScrollLeft
            })
          }
        }
      }
      syncDataControlsDisabled()
      renderValueInspector()
    } else if (state.pendingScrollState) {
      restorePendingScrollPositions(true)
    }
  } catch (err) {
    if (
      reqSeq !== dataPageLoadSeq ||
      state.activeConnectionId !== connectionId ||
      state.activeTable !== table ||
      (state.activeSchema || '') !== normSchema
    ) {
      return
    }
    if (dataLoadStopTimer) {
      dataLoadStopTimer()
      dataLoadStopTimer = null
    }
    state.dataLoading = false
    state.silentDataRefresh = false
    renderDataGrid()
    syncDataControlsDisabled()
    if (pager && pagerInfo) {
      const pd = state.pageData
      if (pd && pd.columns && pd.columns.length > 0) {
        const totalPages = Math.max(1, Math.ceil(pd.totalRows / (pd.pageSize || state.pageSize || 100)))
        pagerInfo.textContent = `${pd.totalRows} rows · Page ${pd.page} / ${totalPages}`
      } else {
        pager.hidden = true
        if (footer) footer.hidden = true
      }
    }
    showConnectionBanner(connectionId, `Error loading ${table}: ${err?.message || err}`, 'danger', {
      onRetry: () => {
        if (
          state.activeConnectionId !== connectionId ||
          state.activeTable !== table ||
          (state.activeSchema || '') !== normSchema
        ) {
          return
        }
        void loadTablePage(connectionId, table, page, schema, opts)
      },
    })
  } finally {
    if (reqSeq === dataPageLoadSeq) {
      if (dataLoadStopTimer) {
        dataLoadStopTimer()
        dataLoadStopTimer = null
      }
      if (state.dataLoading) {
        state.dataLoading = false
        syncDataControlsDisabled()
        renderStagingBar()
      }
    }
  }
}

let dataGridSel = null
let sqlGridSel = null

function getActiveTableKey() {
  return makeTableKey(state.activeConnectionId, state.activeTable || 'table', state.activeSchema)
}

function getHiddenColsSet(tblKey = getActiveTableKey()) {
  if (!state.hiddenColsByTable[tblKey]) state.hiddenColsByTable[tblKey] = new Set()
  return state.hiddenColsByTable[tblKey]
}

function getPinnedColsSet(tblKey = getActiveTableKey()) {
  if (!state.pinnedColsByTable[tblKey]) state.pinnedColsByTable[tblKey] = new Set()
  return state.pinnedColsByTable[tblKey]
}

function getActiveTableDisplayEntry(tblKey = getActiveTableKey()) {
  return state.tableDisplayByTable[tblKey] || null
}

function normalizeBareColName(rawKey) {
  const parsed = parseOccurrenceColumnKey(rawKey)
  return parsed ? parsed.name : rawKey
}

let cachedPanelColResolverCols = null
let cachedPanelColResolverLen = -1
let cachedPanelColResolverFirst = undefined
let cachedPanelColResolverLast = undefined
let cachedPanelColResolver = null

function getPanelColKeyResolver(columnsOrHeaders = state.pageData?.columns) {
  if (!Array.isArray(columnsOrHeaders) || columnsOrHeaders.length === 0) return null
  const len = columnsOrHeaders.length
  const first = columnsOrHeaders[0]
  const last = columnsOrHeaders[len - 1]
  if (
    cachedPanelColResolver &&
    cachedPanelColResolverCols === columnsOrHeaders &&
    cachedPanelColResolverLen === len &&
    cachedPanelColResolverFirst === first &&
    cachedPanelColResolverLast === last
  ) {
    return cachedPanelColResolver
  }
  const headers =
    typeof first === 'string' ? columnsOrHeaders : columnsOrHeaders.map((c) => c.name)
  const resolver = buildColumnKeyResolver(headers)
  cachedPanelColResolverCols = columnsOrHeaders
  cachedPanelColResolverLen = len
  cachedPanelColResolverFirst = first
  cachedPanelColResolverLast = last
  cachedPanelColResolver = resolver
  return resolver
}

function buildColumnOccurrenceKeyMap(columns) {
  const map = new Map()
  const resolver = getPanelColKeyResolver(columns)
  if (!resolver || !Array.isArray(columns)) return map
  const occKeys = resolver.occKeys
  for (let i = 0; i < columns.length; i++) {
    map.set(columns[i], occKeys[i])
  }
  return map
}

function resolveDisplayKeySet(rawKeys, headers) {
  const list = Array.isArray(rawKeys) ? rawKeys : Array.from(rawKeys || [])
  if (!Array.isArray(headers) || headers.length === 0) {
    return new Set(list.filter((k) => typeof k === 'string' && k.length > 0))
  }
  const pdCols = state.pageData?.columns
  const resolver =
    Array.isArray(pdCols) && pdCols.length === headers.length
      ? getPanelColKeyResolver(pdCols)
      : getPanelColKeyResolver(headers)
  const out = new Set()
  for (const k of list) {
    if (typeof k !== 'string' || !k) continue
    const resolved = resolver ? resolver.resolveKey(k) : null
    if (resolved) out.add(resolved)
  }
  return out
}

function syncLegacySetsFromDisplayEntry(tblKey, entry) {
  const pd = tblKey === getActiveTableKey() ? state.pageData : null
  const resolver = pd && Array.isArray(pd.columns) ? getPanelColKeyResolver(pd.columns) : null
  const headers = resolver ? pd.columns.map((c) => c.name) : []
  const hidden = resolveDisplayKeySet(entry?.hiddenColumns, headers)
  const pinned = resolveDisplayKeySet(entry?.pinnedColumns, headers)
  if (resolver && resolver.occKeys.length > 0 && hidden.size >= resolver.occKeys.length) {
    const orderedKeys = []
    const seenOrder = new Set()
    for (const rawKey of entry?.columnOrder ?? []) {
      const resolved = resolver.resolveKey(rawKey)
      if (resolved && resolver.occKeySet.has(resolved) && !seenOrder.has(resolved)) {
        seenOrder.add(resolved)
        orderedKeys.push(resolved)
      }
    }
    for (const k of resolver.occKeys) {
      if (!seenOrder.has(k)) {
        seenOrder.add(k)
        orderedKeys.push(k)
      }
    }
    if (orderedKeys.length > 0 && orderedKeys.every((k) => hidden.has(k))) {
      const keepKey = orderedKeys[0]
      hidden.delete(keepKey)
      if (entry && Array.isArray(entry.hiddenColumns)) {
        entry.hiddenColumns = entry.hiddenColumns.filter((raw) => {
          const resolved = resolver.resolveKey(raw)
          return resolved ? resolved !== keepKey : raw !== keepKey
        })
      }
    }
  }
  state.hiddenColsByTable[tblKey] = hidden
  state.pinnedColsByTable[tblKey] = pinned
  if (resolver && entry?.columnWidths) {
    const curWidths = Array.isArray(state.columnWidthsByTable[tblKey])
      ? state.columnWidthsByTable[tblKey]
      : null
    const occKeys = resolver.occKeys
    const resizedSet = new Set()
    for (const [rawKey, w] of Object.entries(entry.columnWidths)) {
      const idx = resolver.resolveIndex(rawKey)
      if (idx >= 0 && typeof w === 'number' && Number.isFinite(w) && w > 0) {
        if (curWidths) curWidths[idx] = w
        resizedSet.add(occKeys[idx])
      }
    }
    state.userResizedColKeysByTable[tblKey] = resizedSet
  }
}

const panelTableDisplayQueues = new Map()

function getPanelTableDisplayQueue(tblKey) {
  let queue = panelTableDisplayQueues.get(tblKey)
  if (!queue) {
    queue = {
      inFlight: false,
      dirty: false,
      overwrittenByRemoteWhileInFlight: false,
      pendingPatch: null,
      inFlightSentSnapshot: null,
      hasPendingRemoteRebase: false,
      pendingRemoteRebaseEntry: null,
      pendingRemoteRebaseRev: 0,
      recentSelfRevisions: new Set(),
    }
    panelTableDisplayQueues.set(tblKey, queue)
  }
  return queue
}

function setPanelPendingRemoteRebase(queue, entry, rev) {
  const cleanRev = typeof rev === 'number' && Number.isFinite(rev) && rev > 0 ? Math.floor(rev) : 0
  if (!queue.hasPendingRemoteRebase || cleanRev >= queue.pendingRemoteRebaseRev) {
    queue.hasPendingRemoteRebase = true
    queue.pendingRemoteRebaseEntry = entry
    queue.pendingRemoteRebaseRev = cleanRev
  }
}

function clearPanelPendingRemoteRebase(queue) {
  queue.hasPendingRemoteRebase = false
  queue.pendingRemoteRebaseEntry = null
  queue.pendingRemoteRebaseRev = 0
}

function buildTableDisplayFullSnapshotPatch(entry) {
  return {
    columnOrder: entry?.columnOrder ?? [],
    hiddenColumns: entry?.hiddenColumns ?? [],
    pinnedColumns: entry?.pinnedColumns ?? [],
    columnWidths: entry?.columnWidths ?? {},
    wrapCells: Boolean(entry?.wrapCells),
    wrapMaxLines: entry?.wrapMaxLines ?? DEFAULT_WRAP_MAX_LINES,
    highlightRules: entry?.highlightRules ?? [],
  }
}

function recordPanelSelfTableDisplayRevision(queue, rev) {
  if (!(rev > 0)) return
  queue.recentSelfRevisions.delete(rev)
  queue.recentSelfRevisions.add(rev)
  while (queue.recentSelfRevisions.size > 16) {
    const oldest = queue.recentSelfRevisions.values().next().value
    if (oldest === undefined) break
    queue.recentSelfRevisions.delete(oldest)
  }
}

function resolveIncomingTableDisplayRevision(rawEntry, incomingRevision) {
  if (typeof incomingRevision === 'number' && Number.isFinite(incomingRevision) && incomingRevision > 0) {
    return Math.floor(incomingRevision)
  }
  const entryRev = rawEntry?.revision
  if (typeof entryRev === 'number' && Number.isFinite(entryRev) && entryRev > 0) {
    return Math.floor(entryRev)
  }
  return 0
}

function applyTableDisplayEntryForKey(tblKey, rawEntry, incomingRevision) {
  if (!tblKey) return false
  const nextRev = resolveIncomingTableDisplayRevision(rawEntry, incomingRevision)
  const prevRev = state.tableDisplayRevisionByTable[tblKey] || 0
  if (nextRev > 0 && nextRev <= prevRev) {
    return false
  }
  if (nextRev > 0) {
    state.tableDisplayRevisionByTable[tblKey] = nextRev
  }
  const normalized = normalizeTableDisplayStateEntry(rawEntry ?? null)
  if (normalized) {
    state.tableDisplayByTable[tblKey] = normalized
    const resizedSet = new Set(Object.keys(normalized.columnWidths || {}))
    state.userResizedColKeysByTable[tblKey] = resizedSet
  } else {
    delete state.tableDisplayByTable[tblKey]
    delete state.userResizedColKeysByTable[tblKey]
    delete state.columnWidthsByTable[tblKey]
  }
  return true
}

function syncActiveTableDisplayUi(tblKey) {
  if (tblKey !== getActiveTableKey()) return
  syncLegacySetsFromDisplayEntry(tblKey, state.tableDisplayByTable[tblKey] || null)
  if (state.pageData) renderDataGrid({ layoutOnly: true })
  if ($('dataColsPopover') && !$('dataColsPopover').hidden) renderDataColsPopoverList()
}

async function loadTableDisplayState(connectionId, tableName, schemaName) {
  if (!connectionId || !tableName) return
  const tblKey = makeTableKey(connectionId, tableName, schemaName)
  try {
    let res = await rpc(
      'ui.tableDisplayState.get',
      {
        tableKey: tblKey,
        connectionId,
        ...(schemaName ? { schema: schemaName } : {}),
        table: tableName,
      },
      { timeoutMs: 10000 }
    )
    if (!isPanelActive()) return
    const queue = getPanelTableDisplayQueue(tblKey)
    if (queue.inFlight || queue.dirty || queue.pendingPatch) return
    if (!res?.entry && canUseLegacyTableKeyFallback(connectionId, tableName, schemaName)) {
      const legacyKey = makeLegacyTableKey(connectionId, tableName, schemaName)
      if (legacyKey !== tblKey) {
        const legacyRes = await rpc(
          'ui.tableDisplayState.get',
          {
            tableKey: legacyKey,
            connectionId,
            ...(schemaName ? { schema: schemaName } : {}),
            table: tableName,
          },
          { timeoutMs: 10000 }
        ).catch(() => null)
        if (!isPanelActive()) return
        if (queue.inFlight || queue.dirty || queue.pendingPatch) return
        if (legacyRes?.entry) {
          res = legacyRes
        }
      }
    }
    const applied = applyTableDisplayEntryForKey(tblKey, res?.entry ?? null, res?.revision)
    if (applied) {
      syncActiveTableDisplayUi(tblKey)
    }
  } catch {
    // Graceful fallback when running against mock backends without ui.tableDisplayState
  }
}

async function flushPanelTableDisplayQueue(tblKey, connectionId, tableName, schemaName) {
  const queue = getPanelTableDisplayQueue(tblKey)
  if (queue.inFlight) return
  queue.inFlight = true
  let consecutiveFailures = 0
  try {
    while (isPanelActive() && (queue.pendingPatch || queue.dirty || queue.hasPendingRemoteRebase)) {
      let patchToSend =
        queue.pendingPatch || buildTableDisplayFullSnapshotPatch(state.tableDisplayByTable[tblKey] || null)
      queue.pendingPatch = null
      queue.dirty = false

      if (queue.hasPendingRemoteRebase) {
        const pendingEntry = queue.pendingRemoteRebaseEntry
        clearPanelPendingRemoteRebase(queue)
        const rebased = rebaseTableDisplayStateEntry(
          queue.inFlightSentSnapshot,
          state.tableDisplayByTable[tblKey] || null,
          pendingEntry
        )
        if (rebased) {
          state.tableDisplayByTable[tblKey] = rebased
          patchToSend = buildTableDisplayFullSnapshotPatch(rebased)
          syncActiveTableDisplayUi(tblKey)
        } else {
          delete state.tableDisplayByTable[tblKey]
          delete state.userResizedColKeysByTable[tblKey]
          delete state.columnWidthsByTable[tblKey]
          patchToSend = buildTableDisplayFullSnapshotPatch(null)
          syncActiveTableDisplayUi(tblKey)
        }
      }

      const sentSnapshot = normalizeTableDisplayStateEntry(state.tableDisplayByTable[tblKey] || null)
      queue.inFlightSentSnapshot = sentSnapshot
      queue.overwrittenByRemoteWhileInFlight = false
      const baseRevision =
        state.tableDisplayRevisionByTable[tblKey] ||
        state.tableDisplayByTable[tblKey]?.revision ||
        undefined

      try {
        const res = await rpc(
          'ui.tableDisplayState.patch',
          {
            tableKey: tblKey,
            connectionId,
            ...(schemaName ? { schema: schemaName } : {}),
            table: tableName,
            patch: patchToSend,
            ...(typeof baseRevision === 'number' && baseRevision > 0 ? { baseRevision } : {}),
          },
          { timeoutMs: 10000 }
        )
        if (!isPanelActive()) break
        consecutiveFailures = 0
        if (res && 'entry' in res) {
          const nextRev = resolveIncomingTableDisplayRevision(res.entry, res.revision)
          const prevRev = state.tableDisplayRevisionByTable[tblKey] || 0
          if (nextRev > 0) {
            recordPanelSelfTableDisplayRevision(queue, nextRev)
            if (nextRev > prevRev) {
              state.tableDisplayRevisionByTable[tblKey] = nextRev
            }
          }
          if (!(nextRev > 0 && nextRev < prevRev)) {
            const sameAsSent = areTableDisplayStateEntriesEquivalent(res.entry, sentSnapshot)
            if (!sameAsSent || queue.overwrittenByRemoteWhileInFlight) {
              if (queue.dirty || queue.pendingPatch) {
                if (!sameAsSent) {
                  setPanelPendingRemoteRebase(queue, res.entry, nextRev)
                }
              } else {
                const normalizedRemote = normalizeTableDisplayStateEntry(res.entry ?? null)
                if (normalizedRemote) {
                  state.tableDisplayByTable[tblKey] = normalizedRemote
                  state.userResizedColKeysByTable[tblKey] = new Set(
                    Object.keys(normalizedRemote.columnWidths || {})
                  )
                } else {
                  delete state.tableDisplayByTable[tblKey]
                  delete state.userResizedColKeysByTable[tblKey]
                  delete state.columnWidthsByTable[tblKey]
                }
                syncActiveTableDisplayUi(tblKey)
              }
            } else if (state.tableDisplayByTable[tblKey] && nextRev > 0) {
              state.tableDisplayByTable[tblKey].revision = nextRev
            }
          }
        }
        if (!queue.dirty && !queue.pendingPatch && !queue.hasPendingRemoteRebase) break
      } catch {
        consecutiveFailures += 1
        if (consecutiveFailures >= 2 || (!queue.dirty && !queue.pendingPatch)) {
          queue.dirty = false
          queue.pendingPatch = null
          clearPanelPendingRemoteRebase(queue)
          break
        }
        const fullSnap = buildTableDisplayFullSnapshotPatch(state.tableDisplayByTable[tblKey] || null)
        queue.pendingPatch = queue.pendingPatch ? { ...fullSnap, ...queue.pendingPatch } : fullSnap
      }
    }
  } finally {
    queue.inFlight = false
    queue.overwrittenByRemoteWhileInFlight = false
    queue.inFlightSentSnapshot = null
  }
}

async function patchTableDisplayState(patch, opts = {}) {
  const connectionId = opts.connectionId || state.activeConnectionId
  const tableName = opts.table || state.activeTable
  const schemaName = opts.schema !== undefined ? opts.schema : state.activeSchema
  if (!connectionId || !tableName || !patch) return
  const tblKey = makeTableKey(connectionId, tableName, schemaName)
  const prev = state.tableDisplayByTable[tblKey] || {}
  const optimistic = normalizeTableDisplayStateEntry({ ...prev, ...patch })
  if (optimistic) {
    state.tableDisplayByTable[tblKey] = optimistic
  } else {
    delete state.tableDisplayByTable[tblKey]
  }
  if (tblKey === getActiveTableKey() && opts.rerender) {
    syncLegacySetsFromDisplayEntry(tblKey, optimistic)
    if (state.pageData) renderDataGrid({ layoutOnly: true })
    if ($('dataColsPopover') && !$('dataColsPopover').hidden) renderDataColsPopoverList()
  }
  const queue = getPanelTableDisplayQueue(tblKey)
  queue.pendingPatch = queue.pendingPatch ? { ...queue.pendingPatch, ...patch } : { ...patch }
  if (queue.inFlight) {
    queue.dirty = true
    return
  }
  await flushPanelTableDisplayQueue(tblKey, connectionId, tableName, schemaName)
}

async function resetTableDisplayState() {
  const connectionId = state.activeConnectionId
  const tableName = state.activeTable
  const schemaName = state.activeSchema
  if (!connectionId || !tableName) return
  const tblKey = getActiveTableKey()
  const queue = getPanelTableDisplayQueue(tblKey)
  queue.dirty = false
  queue.overwrittenByRemoteWhileInFlight = false
  queue.pendingPatch = null
  clearPanelPendingRemoteRebase(queue)
  queue.recentSelfRevisions.clear()
  delete state.tableDisplayByTable[tblKey]
  delete state.tableDisplayRevisionByTable[tblKey]
  delete state.hiddenColsByTable[tblKey]
  delete state.pinnedColsByTable[tblKey]
  delete state.columnWidthsByTable[tblKey]
  delete state.userResizedColKeysByTable[tblKey]
  dataGridSel?.clear(true)
  if (state.pageData) renderDataGrid({ layoutOnly: true })
  if ($('dataColsPopover') && !$('dataColsPopover').hidden) renderDataColsPopoverList()
  try {
    await rpc(
      'ui.tableDisplayState.reset',
      {
        tableKey: tblKey,
        connectionId,
        ...(schemaName ? { schema: schemaName } : {}),
        table: tableName,
      },
      { timeoutMs: 10000 }
    )
  } catch {}
}

function getOrderedAllColumns(tblKey = getActiveTableKey()) {
  const pd = state.pageData
  if (!pd || !Array.isArray(pd.columns)) return []
  const entry = getActiveTableDisplayEntry(tblKey)
  if (!entry || !Array.isArray(entry.columnOrder) || entry.columnOrder.length === 0) {
    return pd.columns
  }
  const resolver = getPanelColKeyResolver(pd.columns)
  const headers = pd.columns.map((c) => c.name)
  const occKeys = resolver ? resolver.occKeys : []
  const layout = resolveEffectiveColumnLayout({
    headers,
    entry,
  })
  const byOccKey = new Map()
  pd.columns.forEach((c, idx) => {
    byOccKey.set(occKeys[idx], c)
    if (!byOccKey.has(c.name)) byOccKey.set(c.name, c)
  })
  return layout.orderedKeys.map((k) => byOccKey.get(k) || byOccKey.get(normalizeBareColName(k))).filter(Boolean)
}

function reorderColumnByDrop(fromCol, toCol, placement = 'before') {
  const pd = state.pageData
  if (!pd || !Array.isArray(pd.columns) || !fromCol || !toCol || fromCol === toCol) return
  const tblKey = getActiveTableKey()
  const headers = pd.columns.map((c) => c.name)
  const nextEntry = reorderColumnInEntry(getActiveTableDisplayEntry(tblKey), fromCol, toCol, placement, headers)
  const nextOrder = Array.isArray(nextEntry?.columnOrder) ? nextEntry.columnOrder : []
  void patchTableDisplayState({ columnOrder: nextOrder }, { rerender: true })
}

function getOrderedVisibleColumns() {
  const pd = state.pageData
  if (!pd || !Array.isArray(pd.columns)) return []
  const tblKey = getActiveTableKey()
  const headers = pd.columns.map((c) => c.name)
  const colToOccKey = buildColumnOccurrenceKeyMap(pd.columns)
  const orderedAll = getOrderedAllColumns(tblKey)
  const hiddenSet = resolveDisplayKeySet(getHiddenColsSet(tblKey), headers)
  const pinnedSet = resolveDisplayKeySet(getPinnedColsSet(tblKey), headers)
  const visible = orderedAll.filter((c) => !hiddenSet.has(colToOccKey.get(c) || c.name))
  if (visible.length === 0 && orderedAll.length > 0) {
    visible.push(orderedAll[0])
  }
  const pinned = visible.filter((c) => pinnedSet.has(colToOccKey.get(c) || c.name))
  const unpinned = visible.filter((c) => !pinnedSet.has(colToOccKey.get(c) || c.name))
  return [...pinned, ...unpinned]
}

function getActiveForeignKeyMap() {
  const map = new Map()
  if (!state.activeConnectionId || !state.activeTable) return map
  const details = state.tableDetails[makeTableKey(state.activeConnectionId, state.activeTable, state.activeSchema)]
  for (const fk of details?.foreignKeys || []) {
    if (fk.column && (fk.referencedTable || fk.foreignTable)) {
      map.set(fk.column, {
        referencedTable: fk.referencedTable || fk.foreignTable,
        referencedColumn: fk.referencedColumn || fk.foreignColumn || 'id',
      })
    }
  }
  return map
}

function jumpToForeignKeyTarget(refTable, refCol, rawVal) {
  if (!state.activeConnectionId || !refTable || rawVal === null || rawVal === undefined) return
  const conn = getActiveConn()
  const driver = conn?.driver || 'sqlite'
  const objs = state.schemaObjects[state.activeConnectionId] || []
  const match = objs.find((o) => o.name.toLowerCase() === String(refTable).toLowerCase())
  const targetName = match ? match.name : refTable
  const targetSchema = match ? match.schema : state.activeSchema
  const whereSql = `${quoteIdent(refCol, driver)} = ${formatSqlLiteral(rawVal, driver)}`
  selectTableAndOpen(state.activeConnectionId, targetName, targetSchema, true, { whereClause: whereSql })
}

function selectTableAndOpen(connectionId, tableName, schemaName, switchToData, options = {}) {
  state.hasUserInteraction = true
  const tableChanged =
    state.activeConnectionId !== connectionId ||
    state.activeTable !== tableName ||
    state.activeSchema !== schemaName
  if (state.activeConnectionId !== connectionId) {
    state.activeConnectionId = connectionId
    sqlCtrl.clearAiGhost?.()
    sqlCtrl.clearAiFixPanel?.()
    sqlCtrl.clearDbSyntaxError?.()
    void persistActiveConnectionId(connectionId)
    renderConnectionsBar()
  }
  if (tableChanged) {
    state.pendingScrollState = null
    state.inspectorOpen = false
    state.pageData = null
    state.structureError = null
    state.selectedRowKey = null
    state.selectedCol = null
    state.findQuery = ''
    state.findMatches = []
    state.findMatchSet = new Set()
    state.findMatchIdx = -1
    if ($('dataFindInput')) $('dataFindInput').value = ''
    if ($('dataRemoteChangeBanner')) $('dataRemoteChangeBanner').hidden = true
    if (dataGridSel) dataGridSel.clear(true)
    clearStagedChanges()
  }
  state.activeTable = tableName
  state.activeSchema = schemaName
  if (typeof schemaName === 'string' && schemaName.trim()) {
    const trimmedSchema = schemaName.trim()
    const targetConn = getConnById(connectionId)
    const knownSchemas = state.availableSchemasByConn[connectionId]
    if (
      (targetConn && MULTI_SCHEMA_DRIVERS.has(targetConn.driver)) ||
      (Array.isArray(knownSchemas) && knownSchemas.includes(trimmedSchema))
    ) {
      const prevSelectedSchema = state.selectedSchemaByConn[connectionId]
      recordSelectedSchema(connectionId, trimmedSchema, prevSelectedSchema !== trimmedSchema)
    }
  }
  renderActiveSchemaBar()
  state.sortCol = null
  state.whereClause = typeof options.whereClause === 'string' ? options.whereClause : ''
  state.orderByClause = ''
  $('dataWhereInput').value = state.whereClause
  $('dataOrderInput').value = ''
  $('clearFilterBtn').hidden = !state.whereClause

  if (!options.preserveSqlEditor) {
    sqlCtrl.clearAiGhost?.()
    sqlCtrl.clearAiFixPanel?.()
    sqlCtrl.clearDbSyntaxError?.()
    const activeConn = getActiveConn()
    setSqlText(
      buildSelectPreviewQuery(
        activeConn?.driver || 'sqlite',
        tableName,
        schemaName,
        state.whereClause
      ),
      { skipSave: true }
    )
  }

  renderExplorer()
  renderStructureTableSelect()
  syncPanelSqlSchema(connectionId)
  renderDataToolbar()
  renderSqlSafetyBanner()
  savePanelViewState()
  if (state.activeConnectionId) {
    void loadTableDetails(state.activeConnectionId, tableName, schemaName)
    void loadTableDisplayState(state.activeConnectionId, tableName, schemaName)
    void loadTablePage(state.activeConnectionId, tableName, 1, schemaName)
  }
  if (switchToData) switchTab('data')
}

async function deleteConnectionById(id) {
  if (!id) return
  try {
    await rpc('connection.delete', { id })
    if (state.activeConnectionId === id) {
      cancelPendingDataAndSchemaLoads()
      state.activeConnectionId = null
      state.activeTable = null
      state.activeSchema = undefined
      state.pageData = null
      state.page = 1
      state.sortCol = null
      state.lastSqlResult = null
      clearSqlResultDisplay()
      dataVirt.active = false
      sqlVirt.active = false
      dataGridSel?.clear(true)
      sqlGridSel?.clear(true)
      clearStagedChanges()
      void persistActiveConnectionId(null)
    }
    state.hasUserInteraction = true
    state.expandedConns.delete(id)
    schemaRefreshPending.delete(id)
    clearConnectionSchemaCache(id)
    if (bannerActionContext?.source === 'schema') {
      syncSchemaErrorBanner()
    } else if (bannerActionContext?.connectionId === id) {
      hideBanner()
    }
    for (const mapObj of [
      state.tableDetails,
      state.tableDetailsErrors,
      state.columnWidthsByTable,
      state.userResizedColKeysByTable,
      state.transposeWidthsByTable,
      state.hiddenColsByTable,
      state.pinnedColsByTable,
      state.tableDisplayByTable,
      state.tableDisplayRevisionByTable,
    ]) {
      if (!mapObj) continue
      for (const k of Object.keys(mapObj)) {
        if (tableKeyMatchesConnection(k, id)) delete mapObj[k]
      }
    }
    for (const k of Array.from(state.expandedTables)) {
      if (tableKeyMatchesConnection(k, id)) state.expandedTables.delete(k)
    }
    for (const k of Array.from(tableDetailsSeqByKey.keys())) {
      if (tableKeyMatchesConnection(k, id)) tableDetailsSeqByKey.delete(k)
    }
    if (state.structDraftKey && tableKeyMatchesConnection(state.structDraftKey, id)) {
      state.structDraftKey = null
      state.structDraft = null
      state.structPreviewOpen = false
    }
    renderDataToolbar()
    renderDataGrid()
    renderStructure()
    renderValueInspector()
    await refreshConnections()
  } catch (err) {
    showConnectionBanner(id, err?.message || 'Delete failed', 'danger')
  }
}

function openDeleteConfirmModal(conn) {
  if (!conn || !conn.id) return
  pendingDeleteConnId = conn.id
  $('confirmDeleteDesc').textContent = `Remove connection "${conn.name || conn.id}" from Datanoa? Database files and data on disk will not be modified.`
  const confirmBtn = $('confirmDeleteBtn')
  if (confirmBtn instanceof HTMLButtonElement) confirmBtn.disabled = false
  $('confirmDeleteModal').hidden = false
  const cancelBtn = $('cancelDeleteBtn')
  if (cancelBtn && typeof cancelBtn.focus === 'function') cancelBtn.focus()
}

function closeDeleteConfirmModal(force = false) {
  if (state.deletingConn && !force) return
  pendingDeleteConnId = null
  $('confirmDeleteModal').hidden = true
}

let openingStudio = false
async function openFullStudio(override) {
  if (openingStudio) return
  openingStudio = true
  const openBtn = $('openStudioBtn')
  setButtonLoading(openBtn, true, 'Opening...')

  try {
    const cid = override?.connectionId ?? state.activeConnectionId
    const isSameActiveConn = Boolean(cid && cid === state.activeConnectionId)
    const tbl = override?.table ?? (isSameActiveConn ? state.activeTable : null)
    const knownSchemas = cid ? state.availableSchemasByConn[cid] : undefined
    let sch =
      override?.schema ??
      (cid ? state.selectedSchemaByConn[cid] : undefined) ??
      (isSameActiveConn ? state.activeSchema : undefined)
    if (
      !override?.schema &&
      sch &&
      Array.isArray(knownSchemas) &&
      knownSchemas.length > 0 &&
      !knownSchemas.includes(sch)
    ) {
      sch = (cid && state.defaultSchemaByConn[cid]) || knownSchemas[0]
    }
    const res = await rpc(
      'studio.open',
      {
        ...(cid ? { connectionId: cid } : {}),
        ...(tbl ? { table: tbl } : {}),
        ...(sch ? { schema: sch } : {}),
        ...(override?.viewMode ? { viewMode: override.viewMode } : {}),
        ...(override?.action ? { action: override.action } : {}),
      },
      { timeoutMs: QUERY_TIMEOUT_MS }
    )
    if (!res?.ok) {
      showBanner(res?.message || 'Open a local workspace folder in Orca to launch Full Studio.', 'danger')
    }
  } catch (err) {
    showBanner(err?.message || 'Unable to launch Full Studio tab.', 'danger')
  } finally {
    openingStudio = false
    setButtonLoading(openBtn, false)
  }
}

// Initialize static elements & bind listeners
initStaticSelectors()

document.querySelectorAll('.nav-tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab))
})

$('newServerBtn').addEventListener('click', () => {
  if (state.formOpen) {
    setFormOpen(false)
    return
  }
  resetConnectionForm()
  const activeDriver = getActiveConn()?.driver
  setFormDriver(resolvePanelFormDriver(activeDriver, 'sqlite'), true)
  setFormOpen(true)
})

$('emptyAddConnBtn').addEventListener('click', () => {
  resetConnectionForm()
  setFormDriver('sqlite', true)
  setFormOpen(true)
})

// Columns Visibility & Pin Popover Controller
function closeDataColsPopover() {
  const pop = $('dataColsPopover')
  if (pop) pop.hidden = true
}

function renderDataColsHighlightList() {
  const listEl = $('dataColsHighlightList')
  const pd = state.pageData
  if (!listEl || !pd) return
  listEl.textContent = ''
  const entry = getActiveTableDisplayEntry()
  const rules = Array.isArray(entry?.highlightRules) ? entry.highlightRules : []
  const colNames = (pd.columns || []).map((c) => c.name)
  if (rules.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'meta-muted'
    empty.style.fontSize = '11px'
    empty.textContent = 'No rules yet.'
    listEl.appendChild(empty)
    return
  }
  const commitRules = (nextRules) => {
    void patchTableDisplayState({ highlightRules: nextRules }, { rerender: true })
  }
  rules.forEach((rule, idx) => {
    const card = document.createElement('div')
    card.className = 'col-highlight-row'

    const colSel = document.createElement('select')
    colSel.className = 'input'
    for (const cName of colNames) {
      const opt = document.createElement('option')
      opt.value = cName
      opt.textContent = cName
      colSel.appendChild(opt)
    }
    colSel.value = colNames.includes(rule.column) ? rule.column : (colNames[0] || '')
    colSel.addEventListener('change', () => {
      const next = rules.map((r, i) => (i === idx ? { ...r, column: colSel.value } : r))
      commitRules(next)
    })

    const opSel = document.createElement('select')
    opSel.className = 'input'
    for (const op of CONDITIONAL_HIGHLIGHT_OPERATORS) {
      const opt = document.createElement('option')
      opt.value = op
      opt.textContent = op
      opSel.appendChild(opt)
    }
    opSel.value = rule.operator || 'eq'
    opSel.addEventListener('change', () => {
      const next = rules.map((r, i) => (i === idx ? { ...r, operator: opSel.value } : r))
      commitRules(next)
    })

    const valInp = document.createElement('input')
    valInp.className = 'input'
    valInp.type = 'text'
    valInp.placeholder = 'Value...'
    valInp.value = rule.value || ''
    valInp.addEventListener('change', () => {
      const next = rules.map((r, i) => (i === idx ? { ...r, value: valInp.value } : r))
      commitRules(next)
    })

    const toneSel = document.createElement('select')
    toneSel.className = 'input'
    for (const t of HIGHLIGHT_TONES) {
      const opt = document.createElement('option')
      opt.value = t
      opt.textContent = t
      toneSel.appendChild(opt)
    }
    toneSel.value = rule.tone || 'info'
    toneSel.addEventListener('change', () => {
      const next = rules.map((r, i) => (i === idx ? { ...r, tone: toneSel.value } : r))
      commitRules(next)
    })

    const actRow = document.createElement('div')
    actRow.className = 'col-highlight-row-actions'
    const targetSel = document.createElement('select')
    targetSel.className = 'input'
    for (const tgt of ['cell', 'row']) {
      const opt = document.createElement('option')
      opt.value = tgt
      opt.textContent = tgt === 'row' ? 'Row' : 'Cell'
      targetSel.appendChild(opt)
    }
    targetSel.value = rule.target === 'row' ? 'row' : 'cell'
    targetSel.addEventListener('change', () => {
      const next = rules.map((r, i) => (i === idx ? { ...r, target: targetSel.value } : r))
      commitRules(next)
    })

    const delBtn = document.createElement('button')
    delBtn.type = 'button'
    delBtn.className = 'mini-btn'
    delBtn.textContent = 'Remove'
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      commitRules(rules.filter((_, i) => i !== idx))
    })

    actRow.append(targetSel, delBtn)
    card.append(colSel, opSel, valInp, toneSel, actRow)
    listEl.appendChild(card)
  })
}

const colsPopoverRenderState = {
  tblKey: null,
  renderedKeys: [],
  rowMap: new Map(),
  lastHlRules: [],
}

function syncDataColsPopoverRowsInPlace(targetKeys, hiddenSet, pinnedSet, entry) {
  const list = $('dataColsList')
  if (!list || targetKeys.length === 0) return false
  if (
    colsPopoverRenderState.renderedKeys.length !== targetKeys.length ||
    list.childElementCount !== targetKeys.length
  ) {
    return false
  }
  for (let i = 0; i < targetKeys.length; i++) {
    const k = targetKeys[i]
    if (colsPopoverRenderState.renderedKeys[i] !== k) return false
    const view = colsPopoverRenderState.rowMap.get(k)
    if (!view || view.row.parentElement !== list) return false
  }
  for (let i = 0; i < targetKeys.length; i++) {
    const colKey = targetKeys[i]
    const view = colsPopoverRenderState.rowMap.get(colKey)
    const isHidden = hiddenSet.has(colKey)
    const isPinned = pinnedSet.has(colKey)
    if (view.cb.checked !== !isHidden) {
      view.cb.checked = !isHidden
    }
    view.pinBtn.className = `mini-btn${isPinned ? ' btn-active' : ''}`
    const nextPinText = isPinned ? 'Unpin' : 'Pin'
    if (view.pinBtn.textContent !== nextPinText) {
      view.pinBtn.textContent = nextPinText
    }
    view.pinBtn.disabled = isHidden
  }
  const wrapToggle = $('dataColsWrapToggle')
  if (wrapToggle) wrapToggle.checked = Boolean(entry?.wrapCells)
  const maxLinesInp = $('dataColsWrapMaxLines')
  if (maxLinesInp) {
    maxLinesInp.value = String(clampWrapMaxLines(entry?.wrapMaxLines ?? DEFAULT_WRAP_MAX_LINES))
    maxLinesInp.disabled = !entry?.wrapCells
  }
  const nextRules = Array.isArray(entry?.highlightRules) ? entry.highlightRules : []
  if (!areHighlightRulesEqual(colsPopoverRenderState.lastHlRules, nextRules)) {
    colsPopoverRenderState.lastHlRules = nextRules.map((r) => ({ ...r }))
    renderDataColsHighlightList()
  }
  return true
}

function renderDataColsPopoverList() {
  const list = $('dataColsList')
  const pd = state.pageData
  if (!list || !pd) return
  const tblKey = getActiveTableKey()
  const resolver = getPanelColKeyResolver(pd.columns)
  const headers = pd.columns.map((c) => c.name)
  const colToOccKey = buildColumnOccurrenceKeyMap(pd.columns)
  const hiddenSet = resolveDisplayKeySet(getHiddenColsSet(tblKey), headers)
  const pinnedSet = resolveDisplayKeySet(getPinnedColsSet(tblKey), headers)
  const entry = getActiveTableDisplayEntry(tblKey)
  const orderedCols = getOrderedAllColumns(tblKey)
  const q = ($('dataColsSearchInput')?.value || '').trim().toLowerCase()
  const cols = q
    ? orderedCols.filter((c) => c.name.toLowerCase().includes(q))
    : orderedCols
  const targetKeys = cols.map((c) => colToOccKey.get(c) || c.name)

  if (
    colsPopoverRenderState.tblKey === tblKey &&
    syncDataColsPopoverRowsInPlace(targetKeys, hiddenSet, pinnedSet, entry)
  ) {
    return
  }

  colsPopoverRenderState.tblKey = tblKey
  colsPopoverRenderState.renderedKeys = targetKeys
  colsPopoverRenderState.rowMap.clear()
  list.textContent = ''

  const nameCounts = resolver ? resolver.nameCounts : new Map()

  let draggedPopoverCol = null
  const movePopoverCol = (colKey, delta) => {
    const keys = orderedCols.map((c) => colToOccKey.get(c) || c.name)
    const idx = keys.indexOf(colKey)
    const targetIdx = idx + delta
    if (idx < 0 || targetIdx < 0 || targetIdx >= keys.length) return
    const targetKey = keys[targetIdx]
    reorderColumnByDrop(colKey, targetKey, delta < 0 ? 'before' : 'after')
  }

  for (let ci = 0; ci < cols.length; ci++) {
    const col = cols[ci]
    const colKey = targetKeys[ci]
    const parsedKey = parseOccurrenceColumnKey(colKey)
    const displayLabel =
      (nameCounts.get(col.name) || 0) > 1 && parsedKey
        ? `${col.name} (#${parsedKey.occurrence})`
        : col.name
    const row = document.createElement('div')
    row.className = 'col-popover-row'
    row.draggable = true
    row.tabIndex = 0
    row.dataset.colName = col.name
    row.dataset.colKey = colKey
    const lbl = document.createElement('label')
    lbl.className = 'col-popover-name'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = !hiddenSet.has(colKey)
    cb.addEventListener('change', () => toggleColumnHidden(colKey))
    const sp = document.createElement('span')
    sp.textContent = displayLabel
    lbl.append(cb, sp)

    const actions = document.createElement('div')
    actions.className = 'col-popover-actions'

    // Keep Pin/Unpin as the FIRST <button> inside each .col-popover-row
    const pinBtn = document.createElement('button')
    pinBtn.type = 'button'
    const isPinned = pinnedSet.has(colKey)
    pinBtn.className = `mini-btn${isPinned ? ' btn-active' : ''}`
    pinBtn.textContent = isPinned ? 'Unpin' : 'Pin'
    pinBtn.disabled = hiddenSet.has(colKey)
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleColumnPinned(colKey)
    })

    const upBtn = document.createElement('button')
    upBtn.type = 'button'
    upBtn.className = 'mini-btn'
    upBtn.textContent = '↑'
    upBtn.title = 'Move column up (Alt+ArrowUp)'
    upBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      movePopoverCol(colKey, -1)
    })

    const downBtn = document.createElement('button')
    downBtn.type = 'button'
    downBtn.className = 'mini-btn'
    downBtn.textContent = '↓'
    downBtn.title = 'Move column down (Alt+ArrowDown)'
    downBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      movePopoverCol(colKey, 1)
    })

    row.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 'ArrowUp') {
        e.preventDefault()
        movePopoverCol(colKey, -1)
      } else if (e.altKey && e.key === 'ArrowDown') {
        e.preventDefault()
        movePopoverCol(colKey, 1)
      }
    })
    row.addEventListener('dragstart', (e) => {
      draggedPopoverCol = colKey
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', colKey)
      }
    })
    row.addEventListener('dragover', (e) => {
      const src = draggedPopoverCol || e.dataTransfer?.getData('text/plain')
      if (!src || src === colKey) return
      e.preventDefault()
      row.classList.add('is-drop-target')
    })
    row.addEventListener('dragleave', () => {
      row.classList.remove('is-drop-target')
    })
    row.addEventListener('drop', (e) => {
      e.preventDefault()
      row.classList.remove('is-drop-target')
      const src = draggedPopoverCol || e.dataTransfer?.getData('text/plain')
      draggedPopoverCol = null
      if (src && src !== colKey) {
        reorderColumnByDrop(src, colKey, 'before')
      }
    })
    row.addEventListener('dragend', () => {
      draggedPopoverCol = null
      list.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'))
    })

    actions.append(pinBtn, upBtn, downBtn)
    row.append(lbl, actions)
    list.appendChild(row)
    colsPopoverRenderState.rowMap.set(colKey, { row, cb, pinBtn })
  }

  const wrapToggle = $('dataColsWrapToggle')
  if (wrapToggle) wrapToggle.checked = Boolean(entry?.wrapCells)
  const maxLinesInp = $('dataColsWrapMaxLines')
  if (maxLinesInp) {
    maxLinesInp.value = String(clampWrapMaxLines(entry?.wrapMaxLines ?? DEFAULT_WRAP_MAX_LINES))
    maxLinesInp.disabled = !entry?.wrapCells
  }
  const nextRules = Array.isArray(entry?.highlightRules) ? entry.highlightRules : []
  colsPopoverRenderState.lastHlRules = nextRules.map((r) => ({ ...r }))
  renderDataColsHighlightList()
}

// Bulk Fill Value Modal Controller
function openBulkFillModal() {
  if (submittingChanges || getActiveConn()?.readOnly) return
  const coords = dataGridSel?.getSelectedCoords(50000) || []
  if (coords.length === 0) return
  $('bulkFillDesc').textContent = `Set a new value across ${coords.length} selected cell(s) in staged edits.`
  $('bulkFillInput').value = ''
  $('bulkFillModal').hidden = false
  $('bulkFillInput').focus()
}

function closeBulkFillModal() {
  $('bulkFillModal').hidden = true
}

// Create New Table Modal Controller
let createTableDraftCols = []
let createTableColSeq = 1

function updateCreateTablePreview() {
  const conn = getActiveConn()
  const driver = conn?.driver || 'sqlite'
  const isMongo = driver === 'mongodb'
  const tblName = $('createTableNameInput').value.trim()
  const errBox = $('createTableErrors')
  const previewEl = $('createTableDdlPreview')
  const execBtn = $('createTableExecuteBtn')
  try {
    const ddl = buildCreateObjectCommand(tblName, createTableDraftCols, driver, state.activeSchema)
    errBox.hidden = true
    errBox.textContent = ''
    previewEl.textContent = ddl
    execBtn.disabled = state.creatingTable
  } catch (err) {
    errBox.hidden = false
    errBox.textContent = err?.message || String(err)
    previewEl.textContent = isMongo
      ? '-- Enter a valid collection name above to preview db.createCollection(...) command.'
      : '-- Fix validation errors above to preview CREATE TABLE SQL.'
    execBtn.disabled = true
  }
}

function renderCreateTableRows() {
  const tbody = $('createTableColsBody')
  if (!tbody) return
  tbody.textContent = ''
  createTableDraftCols.forEach((col, rowIdx) => {
    const a11y = getPanelCreateTableRowAriaLabels(rowIdx)
    const tr = document.createElement('tr')

    const tdName = document.createElement('td')
    tdName.style.padding = '0'
    const nameInp = document.createElement('input')
    nameInp.type = 'text'
    nameInp.className = 'struct-cell-input'
    nameInp.value = col.name
    nameInp.placeholder = 'column_name'
    nameInp.setAttribute('aria-label', a11y.name)
    nameInp.addEventListener('input', () => {
      col.name = nameInp.value
      updateCreateTablePreview()
    })
    tdName.appendChild(nameInp)

    const tdType = document.createElement('td')
    tdType.style.padding = '0'
    const { wrap: typeWrap } = createPanelComboInput(col.dataType, PANEL_TYPE_SUGGESTIONS_BY_DRIVER[getActiveConn()?.driver || 'sqlite'] || PANEL_COL_TYPES, false, (nextVal) => {
      col.dataType = nextVal
      updateCreateTablePreview()
    })
    const typeInp = typeWrap.querySelector('input')
    if (typeInp) typeInp.setAttribute('aria-label', a11y.type)
    const typeToggleBtn = typeWrap.querySelector('button')
    if (typeToggleBtn) typeToggleBtn.setAttribute('aria-label', a11y.typeToggle)
    tdType.appendChild(typeWrap)

    const tdPk = document.createElement('td')
    tdPk.style.textAlign = 'center'
    const pkCb = document.createElement('input')
    pkCb.type = 'checkbox'
    pkCb.className = 'struct-checkbox'
    pkCb.checked = Boolean(col.isPrimaryKey)
    pkCb.setAttribute('aria-label', a11y.primaryKey)
    tdPk.appendChild(pkCb)

    const tdNull = document.createElement('td')
    tdNull.style.textAlign = 'center'
    const nullCb = document.createElement('input')
    nullCb.type = 'checkbox'
    nullCb.className = 'struct-checkbox'
    nullCb.checked = Boolean(col.nullable)
    nullCb.disabled = Boolean(col.isPrimaryKey)
    nullCb.setAttribute('aria-label', a11y.nullable)
    tdNull.appendChild(nullCb)

    pkCb.addEventListener('change', () => {
      col.isPrimaryKey = Boolean(pkCb.checked)
      if (col.isPrimaryKey) {
        col.nullable = false
        nullCb.checked = false
      }
      nullCb.disabled = Boolean(col.isPrimaryKey)
      updateCreateTablePreview()
    })
    nullCb.addEventListener('change', () => {
      col.nullable = Boolean(nullCb.checked)
      updateCreateTablePreview()
    })

    const tdDef = document.createElement('td')
    tdDef.style.padding = '0'
    const defInp = document.createElement('input')
    defInp.type = 'text'
    defInp.className = 'struct-cell-input'
    defInp.value = col.defaultValue || ''
    defInp.placeholder = col.nullable ? 'NULL' : 'None'
    defInp.setAttribute('aria-label', a11y.defaultValue)
    defInp.addEventListener('input', () => {
      col.defaultValue = defInp.value
      updateCreateTablePreview()
    })
    tdDef.appendChild(defInp)

    const tdAct = document.createElement('td')
    const delBtn = document.createElement('button')
    delBtn.type = 'button'
    delBtn.className = 'btn btn-sm'
    delBtn.textContent = '×'
    delBtn.disabled = createTableDraftCols.length <= 1
    delBtn.setAttribute('aria-label', a11y.remove)
    delBtn.addEventListener('click', () => {
      const idx = createTableDraftCols.indexOf(col)
      if (idx >= 0 && createTableDraftCols.length > 1) {
        createTableDraftCols.splice(idx, 1)
        renderCreateTableRows()
      }
    })
    tdAct.appendChild(delBtn)

    tr.append(tdName, tdType, tdPk, tdNull, tdDef, tdAct)
    tbody.appendChild(tr)
  })
  updateCreateTablePreview()
}

function openCreateTableModal() {
  const conn = getActiveConn()
  if (!conn || conn.driver === 'redis') return
  if (conn.readOnly) {
    showConnectionBanner(conn.id, 'Read-Only connection — cannot create tables or collections.', 'danger')
    return
  }
  const isMongo = conn.driver === 'mongodb'
  if ($('createTableTitle')) {
    $('createTableTitle').textContent = isMongo ? 'Create New Collection' : 'Create New Table'
  }
  $('createTableDriverBadge').textContent = (ENGINE_BY_ID[conn.driver]?.label || conn.driver).toUpperCase()
  const nameInp = $('createTableNameInput')
  nameInp.value = ''
  nameInp.placeholder = isMongo ? 'e.g. events' : 'e.g. audit_logs'
  const nameFieldLabel = nameInp.closest('.field')?.querySelector('.field-label')
  if (nameFieldLabel) nameFieldLabel.textContent = isMongo ? 'Collection Name' : 'Table Name'
  const colsFieldWrap = $('createTableColsBody')?.closest('.field')
  if (colsFieldWrap) colsFieldWrap.hidden = isMongo
  const previewFieldLabel = $('createTableDdlPreview')?.closest('.field')?.querySelector('.field-label')
  if (previewFieldLabel) previewFieldLabel.textContent = isMongo ? 'MongoDB Command Preview' : 'CREATE TABLE DDL Preview'
  const execBtn = $('createTableExecuteBtn')
  execBtn.textContent = isMongo ? 'Create Collection' : 'Create Table'
  createTableDraftCols = buildInitialCreateTableDraftColumns(conn.driver).map((col) => ({
    id: `ct_${createTableColSeq++}`,
    ...col,
  }))
  setButtonLoading(execBtn, false)
  $('createTableCancelBtn').disabled = false
  renderCreateTableRows()
  $('createTableModal').hidden = false
  nameInp.focus()
}

function closeCreateTableModal(force = false) {
  if (state.creatingTable && !force) return
  closePanelComboPopover()
  $('createTableModal').hidden = true
}

// Danger Table Modal (Truncate / Drop Table or View)
let pendingDangerTableOp = null

function openDangerTableModal(action, conn, obj) {
  if (!conn || !obj || conn.driver === 'redis') return
  if (conn.readOnly) {
    showConnectionBanner(conn.id, 'Read-Only connection — destructive table operations are disabled.', 'danger')
    return
  }
  pendingDangerTableOp = { action, conn, obj }
  const isDrop = action === 'drop'
  const isMongo = conn.driver === 'mongodb'
  const kindLabel = isMongo ? 'Collection' : obj.kind === 'view' ? 'View' : 'Table'
  const actionLabel = isDrop ? `Drop ${kindLabel}` : `Truncate ${kindLabel}`
  $('dangerTableTitle').textContent = `${actionLabel} — ${obj.name}`
  $('dangerTableBadge').textContent = isDrop ? 'DROP' : 'TRUNCATE'
  $('dangerTableProdWarn').hidden = conn.colorTag !== 'prod'
  $('dangerTableDesc').textContent = isDrop
    ? `This permanently deletes ${kindLabel.toLowerCase()} "${obj.name}" and cannot be undone.`
    : `This permanently deletes all ${isMongo ? 'documents' : 'rows'} from "${obj.name}" while keeping the ${isMongo ? 'collection' : 'table schema'}.`
  const sql = buildTruncateOrDropSql(action, obj, conn.driver)
  $('dangerTableSqlPreview').textContent = sql
  $('dangerTableConfirmLabel').textContent = `Type "${obj.name}" to confirm`
  const inp = $('dangerTableConfirmInput')
  inp.value = ''
  inp.placeholder = obj.name
  $('dangerTableError').hidden = true
  $('dangerTableError').textContent = ''
  const execBtn = $('dangerTableExecuteBtn')
  setButtonLoading(execBtn, false)
  execBtn.textContent = actionLabel
  execBtn.disabled = true
  $('dangerTableCancelBtn').disabled = false
  $('dangerTableModal').hidden = false
  inp.focus()
}

function closeDangerTableModal(force = false) {
  if (state.runningDangerTableOp && !force) return
  pendingDangerTableOp = null
  $('dangerTableModal').hidden = true
}

// Instantiate PanelGridSelection for #dataTable and #sqlResultTable
dataGridSel = new PanelGridSelection({
  wrapEl: $('dataGridWrap'),
  tableEl: $('dataTable'),
  editable: true,
  isTransposed: () => Boolean(state.transposed),
  getDimensions: () => {
    const allRows = dataVirt.active ? dataVirt.allRows : getAllDisplayRows()
    return {
      rows: state.transposed ? Math.min(allRows.length, 100) : allRows.length,
      cols: (dataVirt.active ? dataVirt.visCols : getOrderedVisibleColumns()).length,
    }
  },
  getSnapshot: () => {
    const allRows = dataVirt.active ? dataVirt.allRows : getAllDisplayRows()
    const visCols = dataVirt.active ? dataVirt.visCols : getOrderedVisibleColumns()
    const rowCount = state.transposed ? Math.min(allRows.length, 100) : allRows.length
    return {
      rows: rowCount,
      cols: visCols.length,
      getValue: (r, c) => {
        if (r < 0 || r >= rowCount) return null
        const entry = allRows[r]
        const col = visCols[c]
        if (!entry || !col) return null
        return getEffectiveCellValue(entry.rowKey, entry.data, col.name)
      },
    }
  },
  getValueAt: (r, c) => {
    const allRows = dataVirt.active ? dataVirt.allRows : getAllDisplayRows()
    const rowCount = state.transposed ? Math.min(allRows.length, 100) : allRows.length
    if (r < 0 || r >= rowCount) return null
    const visCols = dataVirt.active ? dataVirt.visCols : getOrderedVisibleColumns()
    const entry = allRows[r]
    const col = visCols[c]
    if (!entry || !col) return null
    return getEffectiveCellValue(entry.rowKey, entry.data, col.name)
  },
  onSelectionChange: (sel) => {
    if (sel.focus) {
      const allRows = dataVirt.active ? dataVirt.allRows : getAllDisplayRows()
      const rowCount = state.transposed ? Math.min(allRows.length, 100) : allRows.length
      const visCols = dataVirt.active ? dataVirt.visCols : getOrderedVisibleColumns()
      const entry = sel.focus.r >= 0 && sel.focus.r < rowCount ? allRows[sel.focus.r] : null
      const col = visCols[sel.focus.c]
      state.selectedRowKey = entry?.rowKey || null
      state.selectedCol = col?.name || null
      if (!state.transposed) {
        ensureDataVirtualRowVisible(sel.focus.r, sel.focus.c)
      }
    } else {
      state.selectedRowKey = null
      state.selectedCol = null
    }
    renderStagingBar()
    renderValueInspector()
  },
  onCopy: () => copyDataSelection('tsv', false),
  onPaste: (_sel, txt) => pasteDelimitedIntoDataGrid(txt),
  onPasteNewRows: () => void triggerPanelPasteNewRows(),
  onBulkDeleteRows: () => toggleDeleteSelectedRows(),
  onBulkSetNull: () => bulkSetSelectedCellsValue(null),
  onCtrlClickCell: (r, c) => {
    const allRows = dataVirt.active ? dataVirt.allRows : getAllDisplayRows()
    const visCols = dataVirt.active ? dataVirt.visCols : getOrderedVisibleColumns()
    const entry = allRows[r]
    const col = visCols[c]
    if (!entry || !col) return false
    const fkInfo = getActiveForeignKeyMap().get(col.name)
    if (!fkInfo) return false
    const val = getEffectiveCellValue(entry.rowKey, entry.data, col.name)
    if (val === null || val === undefined) return false
    jumpToForeignKeyTarget(fkInfo.referencedTable, fkInfo.referencedColumn, val)
    return true
  },
  onEnsureCellVisible: (r, c) => {
    ensureDataVirtualRowVisible(state.transposed ? c : r, state.transposed ? r : c)
  },
  onStartEdit: (r, c) => {
    ensureDataVirtualRowVisible(state.transposed ? c : r, state.transposed ? r : c)
    const allRows = dataVirt.active ? dataVirt.allRows : getAllDisplayRows()
    const visCols = dataVirt.active ? dataVirt.visCols : getOrderedVisibleColumns()
    const entry = allRows[r]
    const col = visCols[c]
    const td = $('dataTable')?.querySelector(`tbody td[data-row-idx="${r}"][data-col-idx="${c}"]`)
    if (entry && col && td && td.dataset.editable === '1') {
      startInlineEdit(td, entry.rowKey, entry.data, col, getEffectiveCellValue(entry.rowKey, entry.data, col.name))
    }
  },
  onContextMenu: (e, info) => {
    if (info.kind === 'canvas') {
      openContextMenu(e.clientX, e.clientY, { type: 'dataCanvas' })
      return
    }
    const visCols = dataVirt.active ? dataVirt.visCols : getOrderedVisibleColumns()
    if (info.kind === 'header') {
      const col = visCols[info.colIdx]
      if (col) openContextMenu(e.clientX, e.clientY, { type: 'dataHeader', col, colIdx: info.colIdx })
      return
    }
    const allRows = dataVirt.active ? dataVirt.allRows : getAllDisplayRows()
    const entry = allRows[info.rowIdx]
    const col = visCols[info.colIdx]
    if (!entry || !col) return
    const val = getEffectiveCellValue(entry.rowKey, entry.data, col.name)
    const fkInfo = getActiveForeignKeyMap().get(col.name) || null
    openContextMenu(e.clientX, e.clientY, {
      type: 'dataCell',
      entry,
      col,
      val,
      cellCount: dataGridSel.getSelectedCoords(50000).length || 1,
      rowCount: dataGridSel.getSelectedRowIndices().length || 1,
      fkInfo,
    })
  },
})

sqlGridSel = new PanelGridSelection({
  wrapEl: $('sqlResultWrap'),
  tableEl: $('sqlResultTable'),
  editable: false,
  getDimensions: () => ({
    rows: getSortedSqlRows().length,
    cols: state.lastSqlResult?.columns?.length || 0,
  }),
  getSnapshot: () => {
    const sorted = getSortedSqlRows()
    const colsLen = state.lastSqlResult?.columns?.length || 0
    return {
      rows: sorted.length,
      cols: colsLen,
      getValue: (r, c) => (sorted[r] ? sorted[r][c] : null),
    }
  },
  getValueAt: (r, c) => {
    const row = getSortedSqlRows()[r]
    return row ? row[c] : null
  },
  onSelectionChange: () => {
    renderSqlSelectionStats()
  },
  onEnsureCellVisible: (r) => {
    ensureSqlVirtualRowVisible(r)
  },
  onCopy: () => copySqlSelection('tsv', false),
  onContextMenu: (e, info) => {
    if (info.kind === 'header') {
      sqlGridSel.selectCol(info.colIdx)
    }
    const colName = state.lastSqlResult?.columns?.[info.colIdx]?.name || 'Column'
    openContextMenu(e.clientX, e.clientY, {
      type: 'sqlCell',
      colName,
      cellCount: sqlGridSel.getSelectedCoords(50000).length || 1,
    })
  },
})

// Delegated click & dblclick listeners for #dataTable (0 per-cell listeners)
$('dataTable')?.addEventListener('click', (e) => {
  if (!(e.target instanceof Element)) return
  const fkBadge = e.target.closest('.fk-link-badge')
  if (fkBadge) {
    const td = fkBadge.closest('td')
    if (!td) return
    e.stopPropagation()
    const colName = td.dataset.colName
    const rowKey = td.dataset.rowKey
    if (!colName || !rowKey) return
    const fkInfo = getActiveForeignKeyMap().get(colName)
    if (!fkInfo) return
    let entry = null
    if (!state.transposed && td.dataset.rowIdx !== undefined) {
      const allRows = dataVirt.active ? dataVirt.allRows : getAllDisplayRows()
      entry = allRows[Number(td.dataset.rowIdx)] || null
    }
    if (!entry) entry = getAllDisplayRows().find((r) => r.rowKey === rowKey) || null
    if (!entry) return
    const val = getEffectiveCellValue(entry.rowKey, entry.data, colName)
    if (val !== null && val !== undefined) {
      jumpToForeignKeyTarget(fkInfo.referencedTable, fkInfo.referencedColumn, val)
    }
    return
  }
  if (!state.transposed) return
  if (e.target.closest('input.cell-edit-input')) return
  const td = e.target.closest('tbody td[data-col-name]')
  if (!td) return
  const rowKey = td.dataset.rowKey || null
  const colName = td.dataset.colName || null
  if ((e.ctrlKey || e.metaKey) && rowKey && colName) {
    const fkInfo = getActiveForeignKeyMap().get(colName)
    const entry = getAllDisplayRows().find((r) => r.rowKey === rowKey)
    if (fkInfo && entry) {
      const val = getEffectiveCellValue(entry.rowKey, entry.data, colName)
      if (val !== null && val !== undefined) {
        e.preventDefault()
        e.stopPropagation()
        jumpToForeignKeyTarget(fkInfo.referencedTable, fkInfo.referencedColumn, val)
        return
      }
    }
  }
})

$('dataTable')?.addEventListener('dblclick', (e) => {
  if (!(e.target instanceof Element)) return
  if (e.target.closest('.fk-link-badge') || e.target.closest('input.cell-edit-input')) return
  const td = e.target.closest('tbody td[data-editable="1"]')
  if (!td) return
  let entry = null
  let col = null
  if (!state.transposed && td.dataset.rowIdx !== undefined && td.dataset.colIdx !== undefined) {
    const allRows = dataVirt.active ? dataVirt.allRows : getAllDisplayRows()
    const visCols = dataVirt.active ? dataVirt.visCols : getOrderedVisibleColumns()
    entry = allRows[Number(td.dataset.rowIdx)] || null
    col = visCols[Number(td.dataset.colIdx)] || null
  } else {
    entry = getAllDisplayRows().find((r) => r.rowKey === td.dataset.rowKey) || null
    col = state.pageData?.columns?.find((c) => c.name === td.dataset.colName) || null
  }
  if (!entry || !col) return
  if (!isDataCellEditable(entry, col, state.pageData, Boolean(getActiveConn()?.readOnly))) return
  e.stopPropagation()
  startInlineEdit(td, entry.rowKey, entry.data, col, getEffectiveCellValue(entry.rowKey, entry.data, col.name))
})

// Virtualized 60fps scroll & ResizeObserver handlers for #dataGridWrap & #sqlResultWrap
const scheduleDataVirtRender = () => {
  if (!dataVirt.active) return
  if (dataVirt.rafId !== null) return
  const run = () => {
    dataVirt.rafId = null
    renderDataVirtualWindow(false)
  }
  if (typeof requestAnimationFrame === 'function') {
    let ranSync = false
    const id = requestAnimationFrame(() => {
      ranSync = true
      run()
    })
    if (!ranSync) dataVirt.rafId = id
  } else {
    run()
  }
}

const scheduleSqlVirtRender = () => {
  if (!sqlVirt.active) return
  if (sqlVirt.rafId !== null) return
  const run = () => {
    sqlVirt.rafId = null
    renderSqlVirtualWindow(false)
  }
  if (typeof requestAnimationFrame === 'function') {
    let ranSync = false
    const id = requestAnimationFrame(() => {
      ranSync = true
      run()
    })
    if (!ranSync) sqlVirt.rafId = id
  } else {
    run()
  }
}

const dataGridWrapEl = $('dataGridWrap')
let lastDataVirtScrollLeft = -1
if (dataGridWrapEl) {
  dataGridWrapEl.addEventListener('scroll', () => {
    if (!dataVirt.active) return
    const total = dataVirt.transposed ? dataVirt.visCols.length : dataVirt.allRows.length
    if (total === 0) return
    const { start, end } = computeVirtualRange(
      dataGridWrapEl.scrollTop,
      dataGridWrapEl.clientHeight,
      total,
      dataVirt.transposed ? 4 : VIRT_OVERSCAN_ROWS
    )
    const vertChanged = start !== dataVirt.start || end !== dataVirt.end
    const curLeft = dataGridWrapEl.scrollLeft
    const horizChanged = Boolean(dataVirt.transposed && curLeft !== lastDataVirtScrollLeft)
    if (!vertChanged && !horizChanged) return
    lastDataVirtScrollLeft = curLeft
    scheduleDataVirtRender()
  }, { passive: true })
}

const sqlResultWrapEl = $('sqlResultWrap')
if (sqlResultWrapEl) {
  sqlResultWrapEl.addEventListener('scroll', () => {
    if (!sqlVirt.active) return
    const total = sqlVirt.sortedRows.length
    if (total === 0) return
    const { start, end } = computeVirtualRange(sqlResultWrapEl.scrollTop, sqlResultWrapEl.clientHeight, total)
    if (start === sqlVirt.start && end === sqlVirt.end) return
    scheduleSqlVirtRender()
  }, { passive: true })
}

let isPanelViewportResizing = false
let lastObservedDataWrapH = 0
let lastObservedDataWrapW = 0
let lastObservedSqlWrapH = 0

function setPanelViewportResizing(active) {
  const next = Boolean(active)
  if (isPanelViewportResizing === next) return
  isPanelViewportResizing = next
  if (next) {
    if (dataGridWrapEl && dataGridWrapEl.clientHeight > 0) {
      lastObservedDataWrapH = dataGridWrapEl.clientHeight
    }
    if (dataGridWrapEl && dataGridWrapEl.clientWidth > 0) {
      lastObservedDataWrapW = dataGridWrapEl.clientWidth
    }
    if (sqlResultWrapEl && sqlResultWrapEl.clientHeight > 0) {
      lastObservedSqlWrapH = sqlResultWrapEl.clientHeight
    }
  } else {
    if (
      dataGridWrapEl &&
      dataGridWrapEl.clientWidth > 0 &&
      dataGridWrapEl.clientWidth !== lastObservedDataWrapW
    ) {
      lastObservedDataWrapW = dataGridWrapEl.clientWidth
      recomputePinnedForViewport()
    }
    if (dataVirt.active) scheduleDataVirtRender()
    if (sqlVirt.active) scheduleSqlVirtRender()
  }
}

let gridResizeObserver = null
if (typeof ResizeObserver !== 'undefined') {
  gridResizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === dataGridWrapEl) {
        const nextW = entry.contentRect?.width ?? dataGridWrapEl?.clientWidth ?? 0
        if (nextW > 0 && nextW !== lastObservedDataWrapW) {
          lastObservedDataWrapW = nextW
          recomputePinnedForViewport()
        }
        if (!dataVirt.active) continue
        const nextH = entry.contentRect?.height ?? dataGridWrapEl?.clientHeight ?? 0
        if (isPanelViewportResizing) {
          if (nextH <= lastObservedDataWrapH) continue
          const total = dataVirt.transposed ? dataVirt.visCols.length : dataVirt.allRows.length
          const neededEnd = Math.ceil(((dataGridWrapEl?.scrollTop || 0) + nextH) / VIRT_ROW_HEIGHT_PX) + 1
          if (dataVirt.end >= Math.min(total, neededEnd)) {
            lastObservedDataWrapH = nextH
            continue
          }
        }
        if (nextH > 0) lastObservedDataWrapH = nextH
        scheduleDataVirtRender()
      } else if (entry.target === sqlResultWrapEl && sqlVirt.active) {
        const nextH = entry.contentRect?.height ?? sqlResultWrapEl?.clientHeight ?? 0
        if (isPanelViewportResizing) {
          if (nextH <= lastObservedSqlWrapH) continue
          const total = sqlVirt.sortedRows.length
          const neededEnd = Math.ceil(((sqlResultWrapEl?.scrollTop || 0) + nextH) / VIRT_ROW_HEIGHT_PX) + 1
          if (sqlVirt.end >= Math.min(total, neededEnd)) {
            lastObservedSqlWrapH = nextH
            continue
          }
        }
        if (nextH > 0) lastObservedSqlWrapH = nextH
        scheduleSqlVirtRender()
      }
    }
  })
  if (dataGridWrapEl) gridResizeObserver.observe(dataGridWrapEl)
  if (sqlResultWrapEl) gridResizeObserver.observe(sqlResultWrapEl)
}

$('clearFormBtn')?.addEventListener('click', () => {
  if (!state.formBusy) connFormCtrl.clearFormFields()
})
$('closeFormBtn').addEventListener('click', () => {
  if (!state.formBusy) setFormOpen(false)
})
$('globalBannerClose').addEventListener('click', hideBanner)
$('globalBannerRetryBtn')?.addEventListener('click', () => {
  const fn = bannerActionContext?.onRetry
  if (typeof fn === 'function') void fn()
})
$('globalBannerEditBtn')?.addEventListener('click', () => {
  const fn = bannerActionContext?.onEdit
  if (typeof fn === 'function') fn()
})
$('formNoticeClose')?.addEventListener('click', clearFormNotice)
$('sqlProdBannerClose')?.addEventListener('click', dismissSqlSafetyBanner)
$('refreshBtn').addEventListener('click', () => void refreshConnections({ forceLive: true }))
$('expandAllTreeBtn')?.addEventListener('click', () => expandAllExplorer())
$('collapseAllTreeBtn')?.addEventListener('click', () => collapseAllExplorer())
$('formFilePath').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    void detectWorkspace($('formFilePath').value, true)
  }
})
$('detectWorkspaceBtn').addEventListener('click', () => void detectWorkspace($('formFilePath').value, true))
$('discoveredSearchInput')?.addEventListener('input', () => {
  state.discoveredSearch = $('discoveredSearchInput').value
  renderDiscoveredItems()
})

let uriPasteTimer = null
let suppressUriPasteInputCancel = false
function clearUriPasteTimer() {
  suppressUriPasteInputCancel = false
  if (uriPasteTimer !== null) {
    clearTimeout(uriPasteTimer)
    uriPasteTimer = null
  }
}
$('uriInput').addEventListener('input', (e) => {
  const inputType = typeof e?.inputType === 'string' ? e.inputType : ''
  const isPasteOriginated =
    inputType === 'insertFromPaste' || (inputType === '' && suppressUriPasteInputCancel)
  if (isPasteOriginated) {
    suppressUriPasteInputCancel = false
  } else {
    clearUriPasteTimer()
  }
  connFormCtrl.clearActiveAutoUri?.()
})
$('parseUriBtn').addEventListener('click', () => {
  clearUriPasteTimer()
  void handleParseUri()
})
$('uriInput').addEventListener('paste', (e) => {
  clearUriPasteTimer()
  connFormCtrl.clearActiveAutoUri?.()
  const pasted = e.clipboardData?.getData('text')
  if (pasted && pasted.trim()) {
    const seqAtPaste = connFormCtrl.getParseUriSeq?.() ?? 0
    suppressUriPasteInputCancel = true
    uriPasteTimer = setTimeout(() => {
      uriPasteTimer = null
      suppressUriPasteInputCancel = false
      if (!isPanelActive() || !state.formOpen || state.formBusy) return
      if ((connFormCtrl.getParseUriSeq?.() ?? 0) !== seqAtPaste) return
      const nextVal = ($('uriInput')?.value || '').trim() || pasted.trim()
      if (nextVal) void handleParseUri(nextVal)
    }, 0)
  }
})
$('uriInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    clearUriPasteTimer()
    void handleParseUri()
  }
})

$('openStudioBtn').addEventListener('click', () => void openFullStudio())

$('editActiveBtn').addEventListener('click', () => {
  const active = getActiveConn()
  if (active) populateFormFromProfile(active, 'edit')
})

$('dupActiveBtn').addEventListener('click', () => {
  const active = getActiveConn()
  if (active) populateFormFromProfile(active, 'duplicate')
})


$('formName').addEventListener('input', () => {
  state.lastAutoFilledSqliteName = ''
})

$('formOptions')?.addEventListener('input', (e) => {
  state.formOptions = e.target.value || ''
})

$('formPassword').addEventListener('input', () => {
  const hasTyped = Boolean($('formPassword').value)
  state.placeholderPasswordPending = state.lastParsedPlaceholderUri && !hasTyped
  $('formPassword').placeholder = state.placeholderPasswordPending
    ? 'Required (replace placeholder password)'
    : state.formHadPassword && (state.editingId || state.sourceSecretConnId)
      ? 'Stored password preserved (type to replace)'
      : 'Optional'
})

async function runPanelConnectionTest() {
  if (state.formBusy) return
  state.formBusy = true
  setFormControlsBusy(true)
  clearPanelTlsRemedy()
  const testBtn = $('testFormBtn')
  setButtonLoading(testBtn, true, 'Testing... 0.0s')
  const stopTimer = createElapsedTimer((elapsed) => {
    updateButtonLoadingLabel(testBtn, `Testing... ${elapsed}`)
  })
  try {
    if (!(await ensureUriParsedBeforeAction())) return
    if (!ensureValidFolderBeforeSubmit()) return
    const targetId = state.editingId || `conn_test_${Date.now()}`
    if (!ensureRequiredPasswordBeforeSubmit(state.editingId || state.sourceSecretConnId || '')) return
    showFormNotice('Testing connection...', 'neutral')
    const sub = buildFormSubmission(targetId)
    const res = await executeConnectionTestWithHostKeyRetry(sub)
    if (!isPanelActive()) return
    if (res?.tlsFailure) {
      renderPanelTlsFailureRemedy(res.tlsFailure)
    }
    showFormNotice(res?.message || (res?.ok ? 'Connection verified' : 'Connection test failed.'), res?.ok ? 'success' : 'danger')
  } catch (err) {
    if (!isPanelActive()) return
    if (err && typeof err === 'object' && err.tlsFailure) {
      renderPanelTlsFailureRemedy(err.tlsFailure)
    }
    showFormNotice(`Error: ${err?.message || err}`, 'danger')
  } finally {
    stopTimer()
    state.formBusy = false
    if (isPanelActive()) {
      setButtonLoading(testBtn, false)
      setFormControlsBusy(false)
    }
  }
}

$('testFormBtn').addEventListener('click', () => {
  void runPanelConnectionTest()
})

$('saveFormBtn').addEventListener('click', async () => {
  if (state.formBusy) return
  state.formBusy = true
  setFormControlsBusy(true)
  clearPanelTlsRemedy()
  const saveBtn = $('saveFormBtn')
  let savePhase = 'Testing...'
  setButtonLoading(saveBtn, true, 'Testing... 0.0s')
  const stopTimer = createElapsedTimer((elapsed) => {
    updateButtonLoadingLabel(saveBtn, `${savePhase} ${elapsed}`)
  })
  try {
    if (!(await ensureUriParsedBeforeAction())) return
    if (!ensureValidFolderBeforeSubmit()) return
    if ((state.formDriver === 'sqlite' || state.formDriver === 'duckdb') && !$('formFilePath').value.trim()) {
      showFormNotice(
        state.formDriver === 'duckdb'
          ? 'Please enter a DuckDB database file path (or :memory:).'
          : 'Please enter a SQLite database file or folder path.',
        'danger'
      )
      return
    }
    if (state.formDriver === 'libsql' && !$('formLibsqlUrl').value.trim()) {
      showFormNotice('Please enter a LibSQL / Turso URL.', 'danger')
      return
    }
    const targetId = state.editingId || `conn_${state.formDriver}_${Date.now()}`
    if (!ensureRequiredPasswordBeforeSubmit(targetId)) return
    showFormNotice('Verifying & saving connection...', 'neutral')
    const sub = buildFormSubmission(targetId)
    try {
      const testRes = await executeConnectionTestWithHostKeyRetry(sub)
      if (testRes && testRes.ok === false) {
        if (testRes.tlsFailure) {
          renderPanelTlsFailureRemedy(testRes.tlsFailure)
        }
        showFormNotice(testRes.message || 'Connection test failed.', 'danger')
        return
      }
    } catch (testErr) {
      if (testErr && typeof testErr === 'object' && testErr.tlsFailure) {
        renderPanelTlsFailureRemedy(testErr.tlsFailure)
      }
      showFormNotice(`Connection failed: ${testErr?.message || testErr}`, 'danger')
      return
    }
    savePhase = 'Saving...'
    updateButtonLoadingLabel(saveBtn, 'Saving...')
    const res = await rpc('connection.save', sub, { timeoutMs: QUERY_TIMEOUT_MS })
    if (res?.ok) {
      state.hasUserInteraction = true
      const savedId = res.id || targetId
      cancelPendingDataAndSchemaLoads()
      resetSqlSafetyBannerDismissal()
      setFormOpen(false)
      state.activeConnectionId = savedId
      void persistActiveConnectionId(savedId)
      state.expandedConns.add(savedId)
      schemaLoadSeqByConn.set(savedId, (schemaLoadSeqByConn.get(savedId) || 0) + 1)
      state.schemaLoading.delete(savedId)
      schemaRefreshPending.delete(savedId)
      clearConnectionSchemaCache(savedId)
      state.activeTable = null
      state.activeSchema = undefined
      state.pageData = null
      state.page = 1
      state.sortCol = null
      dataVirt.active = false
      clearStagedChanges()
      savePanelViewState()
      await refreshConnections()
      if (!state.schemaErrors[savedId] && bannerActionContext?.source !== 'schema') {
        showBanner(`Connected to ${sub.profile.name}`, 'success')
      }
    } else {
      showFormNotice('Failed to save connection.', 'danger')
    }
  } catch (err) {
    showFormNotice(`Error: ${err?.message || err}`, 'danger')
  } finally {
    stopTimer()
    setButtonLoading(saveBtn, false)
    state.formBusy = false
    setFormControlsBusy(false)
  }
})

$('connSelect').addEventListener('change', (e) => {
  activateConnection(e.target.value || null)
})

$('panelSchemaSelect')?.addEventListener('change', (e) => {
  handlePanelSchemaChange(e.target.value)
})

$('testActiveBtn').addEventListener('click', async () => {
  const active = getActiveConn()
  if (!active || state.testingActiveConn) return
  const targetConnId = active.id
  const testBtn = $('testActiveBtn')
  state.testingActiveConn = true
  setButtonLoading(testBtn, true, 'Testing... 0.0s')
  showBanner(`Testing connection "${active.name}"...`, 'neutral')
  const stopTimer = createElapsedTimer((elapsed) => {
    updateButtonLoadingLabel(testBtn, `Testing... ${elapsed}`)
  })
  try {
    const res = await executeConnectionTestWithHostKeyRetry({ profile: active })
    if (state.activeConnectionId === targetConnId) {
      showConnectionBanner(
        targetConnId,
        res?.message || (res?.ok ? 'Connected' : 'Failed'),
        res?.ok ? 'success' : 'danger'
      )
    }
  } catch (err) {
    if (state.activeConnectionId === targetConnId) {
      showConnectionBanner(targetConnId, err?.message || 'Test failed', 'danger')
    }
  } finally {
    stopTimer()
    setButtonLoading(testBtn, false)
    state.testingActiveConn = false
  }
})

$('deleteActiveBtn').addEventListener('click', () => {
  const active = getActiveConn()
  if (active) openDeleteConfirmModal(active)
})

$('cancelDeleteBtn').addEventListener('click', () => closeDeleteConfirmModal(false))
$('confirmDeleteModal').addEventListener('click', (e) => {
  if (e.target === $('confirmDeleteModal')) closeDeleteConfirmModal(false)
})
$('confirmDeleteBtn').addEventListener('click', async () => {
  const targetId = pendingDeleteConnId
  if (!targetId || state.deletingConn) return
  state.deletingConn = true
  const btn = $('confirmDeleteBtn')
  const cancelBtn = $('cancelDeleteBtn')
  setButtonLoading(btn, true, 'Deleting...')
  if (cancelBtn) cancelBtn.disabled = true
  try {
    await deleteConnectionById(targetId)
  } finally {
    state.deletingConn = false
    setButtonLoading(btn, false)
    if (cancelBtn) cancelBtn.disabled = false
    closeDeleteConfirmModal(true)
  }
})

$('schemaFilter').addEventListener('input', (e) => {
  state.filter = e.target.value || ''
  if (schemaFilterDebounceTimer !== null) clearTimeout(schemaFilterDebounceTimer)
  schemaFilterDebounceTimer = setTimeout(() => {
    schemaFilterDebounceTimer = null
    renderExplorer()
  }, 100)
})

$('dataTableSelect').addEventListener('change', (e) => {
  const { schema, name } = decodeTableSelectValue(e.target.value)
  const objs = (state.activeConnectionId && state.schemaObjects[state.activeConnectionId]) || []
  const match =
    objs.find((o) => o.name === name && (o.schema || '') === (schema || '')) ||
    objs.find((o) => o.name === name)
  if (name && state.activeConnectionId) {
    selectTableAndOpen(state.activeConnectionId, name, match?.schema ?? schema, false)
  }
})

$('reloadDataBtn').addEventListener('click', () => {
  if (state.activeConnectionId && state.activeTable && !state.dataLoading) {
    void loadTablePage(state.activeConnectionId, state.activeTable, state.page, state.activeSchema)
  }
})

$('dataColsBtn')?.addEventListener('click', (e) => {
  e.stopPropagation()
  const pop = $('dataColsPopover')
  if (!pop || !state.pageData) return
  if (!pop.hidden) {
    closeDataColsPopover()
    return
  }
  if ($('dataColsSearchInput')) $('dataColsSearchInput').value = ''
  renderDataColsPopoverList()
  pop.style.visibility = 'hidden'
  pop.style.maxHeight = ''
  pop.hidden = false
  const r = e.currentTarget.getBoundingClientRect()
  const vw = window.innerWidth || 400
  const vh = window.innerHeight || 600
  const popRect = pop.getBoundingClientRect()
  const popW = Math.min(Math.max(200, Math.ceil(popRect.width || 240)), Math.max(160, vw - 16))
  const popH = Math.ceil(popRect.height || 260)
  const spaceBelow = Math.max(0, Math.floor(vh - r.bottom - 12))
  const spaceAbove = Math.max(0, Math.floor(r.top - 12))
  const openAbove = spaceBelow < popH && spaceAbove > spaceBelow
  const availH = Math.max(96, openAbove ? spaceAbove : spaceBelow)
  const usedH = Math.min(popH, availH)
  const top = openAbove
    ? Math.max(8, Math.round(r.top - usedH - 4))
    : Math.max(8, Math.min(Math.round(r.bottom + 4), Math.max(8, vh - usedH - 8)))
  const left = Math.max(8, Math.min(Math.round(r.left), Math.max(8, vw - popW - 8)))
  pop.style.maxHeight = `${availH}px`
  pop.style.top = `${top}px`
  pop.style.left = `${left}px`
  pop.style.visibility = ''
  $('dataColsSearchInput')?.focus()
})
$('dataColsPopover')?.addEventListener('click', (e) => e.stopPropagation())
$('dataColsSearchInput')?.addEventListener('input', renderDataColsPopoverList)
$('dataColsShowAllBtn')?.addEventListener('click', () => {
  getHiddenColsSet().clear()
  dataGridSel?.clear(true)
  renderDataGrid({ layoutOnly: true })
  renderDataColsPopoverList()
  void patchTableDisplayState({ hiddenColumns: [] })
})
$('dataColsWrapToggle')?.addEventListener('change', (e) => {
  const checked = Boolean(e.target?.checked)
  const maxLines = clampWrapMaxLines(Number($('dataColsWrapMaxLines')?.value || DEFAULT_WRAP_MAX_LINES))
  void patchTableDisplayState({ wrapCells: checked, wrapMaxLines: maxLines }, { rerender: true })
})
$('dataColsWrapMaxLines')?.addEventListener('change', (e) => {
  const maxLines = clampWrapMaxLines(Number(e.target?.value || DEFAULT_WRAP_MAX_LINES))
  if ($('dataColsWrapMaxLines')) $('dataColsWrapMaxLines').value = String(maxLines)
  void patchTableDisplayState({ wrapMaxLines: maxLines }, { rerender: true })
})
$('dataColsResetDisplayBtn')?.addEventListener('click', () => {
  void resetTableDisplayState()
})
$('dataColsAddHighlightBtn')?.addEventListener('click', () => {
  const pd = state.pageData
  const firstCol = pd?.columns?.[0]?.name
  if (!firstCol) return
  const entry = getActiveTableDisplayEntry()
  const prevRules = Array.isArray(entry?.highlightRules) ? entry.highlightRules : []
  const newRule = {
    id: `hl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    enabled: true,
    column: firstCol,
    operator: 'eq',
    value: '',
    target: 'cell',
    tone: 'info',
  }
  void patchTableDisplayState({ highlightRules: [...prevRules, newRule] }, { rerender: true })
})

$('dataFindInput')?.addEventListener('input', (e) => {
  state.findQuery = e.target.value || ''
  state.findMatchIdx = 0
  if (findDebounceTimer !== null) clearTimeout(findDebounceTimer)
  findDebounceTimer = setTimeout(() => {
    findDebounceTimer = null
    updateDataFindHighlights(true)
  }, 120)
})
$('dataFindInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (findDebounceTimer !== null) {
      clearTimeout(findDebounceTimer)
      findDebounceTimer = null
      updateDataFindHighlights(false)
    }
    if (state.findMatches.length > 0) {
      e.preventDefault()
      state.findMatchIdx = (state.findMatchIdx + (e.shiftKey ? -1 : 1) + state.findMatches.length) % state.findMatches.length
      updateDataFindHighlights(true)
    }
  }
})
$('dataFindPrevBtn')?.addEventListener('click', () => {
  if (findDebounceTimer !== null) {
    clearTimeout(findDebounceTimer)
    findDebounceTimer = null
    updateDataFindHighlights(false)
  }
  if (state.findMatches.length === 0) return
  state.findMatchIdx = (state.findMatchIdx - 1 + state.findMatches.length) % state.findMatches.length
  updateDataFindHighlights(true)
})
$('dataFindNextBtn')?.addEventListener('click', () => {
  if (findDebounceTimer !== null) {
    clearTimeout(findDebounceTimer)
    findDebounceTimer = null
    updateDataFindHighlights(false)
  }
  if (state.findMatches.length === 0) return
  state.findMatchIdx = (state.findMatchIdx + 1) % state.findMatches.length
  updateDataFindHighlights(true)
})

$('dataSelectionStats')?.addEventListener('click', () => {
  const txt = $('dataSelectionStats')?.textContent || ''
  if (txt) void copyText(txt, 'Selection stats copied')
})
$('sqlSelectionStats')?.addEventListener('click', () => {
  const txt = $('sqlSelectionStats')?.textContent || ''
  if (txt) void copyText(txt, 'Selection stats copied')
})

$('bulkFillCancelBtn')?.addEventListener('click', closeBulkFillModal)
$('bulkFillModal')?.addEventListener('click', (e) => {
  if (e.target === $('bulkFillModal')) closeBulkFillModal()
})
$('bulkFillApplyBtn')?.addEventListener('click', () => {
  const val = $('bulkFillInput').value
  closeBulkFillModal()
  bulkSetSelectedCellsValue(val, { allowNullKeyword: true })
})
$('bulkFillInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    const val = $('bulkFillInput').value
    closeBulkFillModal()
    bulkSetSelectedCellsValue(val, { allowNullKeyword: true })
  }
})

// Create Table Modal Events
$('createTableNameInput')?.addEventListener('input', updateCreateTablePreview)
$('createTableAddColBtn')?.addEventListener('click', () => {
  createTableDraftCols.push({
    id: `ct_${createTableColSeq++}`,
    name: `col_${createTableDraftCols.length + 1}`,
    dataType: 'TEXT',
    isPrimaryKey: false,
    nullable: true,
    defaultValue: '',
  })
  renderCreateTableRows()
})
$('createTableCancelBtn')?.addEventListener('click', () => closeCreateTableModal(false))
$('createTableModal')?.addEventListener('click', (e) => {
  if (e.target === $('createTableModal')) closeCreateTableModal(false)
})
$('createTableExecuteBtn')?.addEventListener('click', async () => {
  if (state.creatingTable || !state.activeConnectionId) return
  const conn = getActiveConn()
  if (!conn || conn.readOnly) return
  let ddl = ''
  const tblName = $('createTableNameInput').value.trim()
  try {
    ddl = buildCreateObjectCommand(tblName, createTableDraftCols, conn.driver, state.activeSchema)
  } catch (err) {
    $('createTableErrors').hidden = false
    $('createTableErrors').textContent = err?.message || String(err)
    return
  }
  state.creatingTable = true
  const execBtn = $('createTableExecuteBtn')
  const cancelBtn = $('createTableCancelBtn')
  setButtonLoading(execBtn, true, 'Creating... 0.0s')
  if (cancelBtn) cancelBtn.disabled = true
  const stopTimer = createElapsedTimer((elapsed) => {
    updateButtonLoadingLabel(execBtn, `Creating... ${elapsed}`)
  })
  const targetConnId = conn.id
  const targetSchema = state.activeSchema
  const objNoun = conn.driver === 'mongodb' ? 'collection' : 'table'
  try {
    await rpc('query.run', { connectionId: targetConnId, queryId: `panel_create_${Date.now()}`, sql: ddl }, { timeoutMs: QUERY_TIMEOUT_MS })
    stopTimer()
    state.creatingTable = false
    setButtonLoading(execBtn, false)
    if (cancelBtn) cancelBtn.disabled = false
    closeCreateTableModal(true)
    showBanner(`Created ${objNoun} "${tblName}"`, 'success')
    await loadSchema(targetConnId)
    if (state.activeConnectionId === targetConnId) {
      selectTableAndOpen(targetConnId, tblName, targetSchema, true)
    }
  } catch (err) {
    stopTimer()
    state.creatingTable = false
    setButtonLoading(execBtn, false)
    if (cancelBtn) cancelBtn.disabled = false
    $('createTableErrors').hidden = false
    $('createTableErrors').textContent = `Create failed: ${err?.message || err}`
  }
})

// Danger Table Modal Events
$('dangerTableConfirmInput')?.addEventListener('input', () => {
  if (!pendingDangerTableOp || state.runningDangerTableOp) return
  const typed = $('dangerTableConfirmInput').value.trim()
  $('dangerTableExecuteBtn').disabled = typed !== pendingDangerTableOp.obj.name
})
$('dangerTableConfirmInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const execBtn = $('dangerTableExecuteBtn')
    if (execBtn && !execBtn.disabled) {
      e.preventDefault()
      execBtn.click()
    }
  }
})
$('dangerTableCancelBtn')?.addEventListener('click', () => closeDangerTableModal(false))
$('dangerTableModal')?.addEventListener('click', (e) => {
  if (e.target === $('dangerTableModal')) closeDangerTableModal(false)
})
$('dangerTableExecuteBtn')?.addEventListener('click', async () => {
  const op = pendingDangerTableOp
  if (!op || state.runningDangerTableOp) return
  if (op.conn.readOnly) {
    showConnectionBanner(op.conn.id, 'Read-Only connection — blocked.', 'danger')
    return
  }
  if ($('dangerTableConfirmInput').value.trim() !== op.obj.name) return
  state.runningDangerTableOp = true
  const execBtn = $('dangerTableExecuteBtn')
  const cancelBtn = $('dangerTableCancelBtn')
  const errBox = $('dangerTableError')
  errBox.hidden = true
  setButtonLoading(execBtn, true, op.action === 'drop' ? 'Dropping... 0.0s' : 'Truncating... 0.0s')
  if (cancelBtn) cancelBtn.disabled = true
  const stopTimer = createElapsedTimer((elapsed) => {
    updateButtonLoadingLabel(execBtn, `${op.action === 'drop' ? 'Dropping' : 'Truncating'}... ${elapsed}`)
  })
  const sql = buildTruncateOrDropSql(op.action, op.obj, op.conn.driver)
  try {
    await rpc('query.run', { connectionId: op.conn.id, queryId: `panel_danger_${Date.now()}`, sql }, { timeoutMs: QUERY_TIMEOUT_MS })
    stopTimer()
    state.runningDangerTableOp = false
    setButtonLoading(execBtn, false)
    if (cancelBtn) cancelBtn.disabled = false
    closeDangerTableModal(true)
    const droppedKey = makeTableKey(op.conn.id, op.obj.name, op.obj.schema)
    const isSameActiveObj =
      state.activeConnectionId === op.conn.id &&
      state.activeTable === op.obj.name &&
      (state.activeSchema || '') === (op.obj.schema || '')
    if (op.action === 'drop') {
      delete state.tableDetails[droppedKey]
      delete state.tableDetailsErrors[droppedKey]
      state.expandedTables.delete(droppedKey)
      if (state.structDraftKey === droppedKey) {
        state.structDraftKey = null
        state.structDraft = null
        state.structPreviewOpen = false
      }
      if (isSameActiveObj) {
        state.activeTable = null
        state.activeSchema = undefined
        state.pageData = null
        dataVirt.active = false
        dataGridSel?.clear(true)
        clearStagedChanges()
        renderDataToolbar()
        renderDataGrid()
        renderStructure()
        renderValueInspector()
      }
    }
    showBanner(
      op.action === 'drop' ? `Dropped "${op.obj.name}"` : `Truncated "${op.obj.name}"`,
      'success'
    )
    await loadSchema(op.conn.id)
    if (
      op.action === 'truncate' &&
      state.activeConnectionId === op.conn.id &&
      state.activeTable === op.obj.name &&
      (state.activeSchema || '') === (op.obj.schema || '')
    ) {
      await loadTablePage(op.conn.id, op.obj.name, 1, op.obj.schema)
    }
  } catch (err) {
    stopTimer()
    state.runningDangerTableOp = false
    setButtonLoading(execBtn, false)
    if (cancelBtn) cancelBtn.disabled = false
    errBox.hidden = false
    errBox.textContent = err?.message || String(err)
  }
})

$('transposeBtn').addEventListener('click', () => {
  state.transposed = !state.transposed
  dataGridSel?.clear(true)
  const wrap = $('dataGridWrap')
  if (wrap) {
    wrap.scrollTop = 0
    wrap.scrollLeft = 0
  }
  savePanelViewState()
  renderDataGrid()
})

$('editTableStructureBtn')?.addEventListener('click', () => {
  switchTab('structure')
})

$('importDataBtn')?.addEventListener('click', () => {
  const conn = getActiveConn()
  if (!state.activeConnectionId || !state.activeTable || conn?.readOnly || conn?.driver === 'redis') {
    return
  }
  void openFullStudio({
    connectionId: state.activeConnectionId,
    table: state.activeTable,
    schema: state.activeSchema,
    viewMode: 'grid',
    action: 'import',
  })
})

$('structureTableNameInput')?.addEventListener('input', (e) => {
  if (!state.structDraft) return
  state.structDraft.tableName = e.target.value
  refreshPanelStructStageBar()
})

$('btnStructAddCol')?.addEventListener('click', () => {
  if (!state.structDraft) return
  const nextNum = state.structDraft.columns.length + 1
  state.structDraft.columns.push({
    id: `pnew_col_${state.structSeq++}`,
    name: `col_${nextNum}`,
    dataType: 'TEXT',
    nullable: true,
    defaultValue: '',
    isPrimaryKey: false,
    status: 'new',
  })
  renderStructure()
})

$('btnStructAddIdx')?.addEventListener('click', () => {
  if (!state.structDraft) return
  const activeCols = state.structDraft.columns.filter((c) => c.status !== 'deleted')
  const firstColObj = activeCols[0] || null
  const firstCol = firstColObj?.name || 'id'
  const tbl = (state.structDraft.tableName || state.structDraft.originalTableName).trim()
  state.structDraft.indexes.push({
    id: `pnew_idx_${state.structSeq++}`,
    name: `idx_${tbl}_${firstCol}`.replace(/[^A-Za-z0-9_]/g, '_'),
    columns: [firstCol],
    columnRefs: firstColObj ? [{ colId: firstColObj.id, fallbackName: firstColObj.name }] : [],
    unique: false,
    isPrimary: false,
    status: 'new',
  })
  renderStructure()
})

$('btnStructAddFk')?.addEventListener('click', () => {
  if (!state.structDraft) return
  const activeCols = state.structDraft.columns.filter((c) => c.status !== 'deleted')
  const firstColObj = activeCols[0] || null
  const firstCol = firstColObj?.name || 'id'
  const tbl = (state.structDraft.tableName || state.structDraft.originalTableName).trim()
  const connTables = ((state.activeConnectionId && state.schemaObjects[state.activeConnectionId]) || [])
    .filter((o) => o.kind === 'table')
    .map((o) => o.name)
  const refTbl = connTables.find((t) => t !== tbl) || connTables[0] || ''
  state.structDraft.foreignKeys.push({
    id: `pnew_fk_${state.structSeq++}`,
    constraintName: `fk_${tbl}_${firstCol}`.replace(/[^A-Za-z0-9_]/g, '_'),
    columnId: firstColObj?.id || null,
    column: firstCol,
    foreignTable: refTbl,
    foreignColumn: 'id',
    onDelete: 'NO ACTION',
    onUpdate: 'NO ACTION',
    status: 'new',
  })
  renderStructure()
})

$('btnStructPreview')?.addEventListener('click', () => {
  state.structPreviewOpen = !state.structPreviewOpen
  refreshPanelStructStageBar()
})

$('btnStructApply')?.addEventListener('click', () => {
  applyPanelStructChanges()
})

$('btnStructRevert')?.addEventListener('click', () => {
  if (state.isMigrating) return
  const detailsKey = state.activeConnectionId && state.activeTable
    ? makeTableKey(state.activeConnectionId, state.activeTable, state.activeSchema)
    : null
  const details = detailsKey ? state.tableDetails[detailsKey] : null
  if (!details) return
  state.structDraft = createPanelStructDraft(details)
  state.structPreviewOpen = false
  renderStructure()
})

$('copyStructSqlBtn')?.addEventListener('click', (e) => {
  const sql = $('structPreviewCode')?.textContent || ''
  void copyText(sql, 'Migration SQL copied', e.currentTarget)
})

$('openStructSqlBtn')?.addEventListener('click', () => {
  const sql = $('structPreviewCode')?.textContent || ''
  if (sql && !sql.startsWith('--')) {
    setSqlText(sql, { focus: true })
    switchTab('sql')
  }
})

$('applyStructSqlBtn')?.addEventListener('click', () => {
  applyPanelStructChanges()
})

$('closeStructSqlBtn')?.addEventListener('click', () => {
  state.structPreviewOpen = false
  refreshPanelStructStageBar()
})

$('copyMigrationSqlModalBtn')?.addEventListener('click', (e) => {
  const sql = $('confirmMigrationSql')?.textContent || ''
  void copyText(sql, 'Migration SQL copied', e.currentTarget)
})

$('cancelMigrationBtn')?.addEventListener('click', () => closeMigrationConfirmModal(false))

$('confirmMigrationExecuteBtn')?.addEventListener('click', () => {
  void executeConfirmedPanelMigration()
})

$('confirmMigrationModal')?.addEventListener('click', (e) => {
  if (e.target === $('confirmMigrationModal')) closeMigrationConfirmModal(false)
})

const applyServerFilter = () => {
  if (state.dataLoading) return
  state.whereClause = $('dataWhereInput').value.trim()
  state.orderByClause = $('dataOrderInput').value.trim()
  if (state.orderByClause) state.sortCol = null
  $('clearFilterBtn').hidden = !state.whereClause && !state.orderByClause
  if (state.activeConnectionId && state.activeTable) {
    void loadTablePage(state.activeConnectionId, state.activeTable, 1, state.activeSchema)
  }
}

$('applyFilterBtn').addEventListener('click', applyServerFilter)
$('dataWhereInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    applyServerFilter()
  }
})
$('dataOrderInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    applyServerFilter()
  }
})
$('clearFilterBtn').addEventListener('click', () => {
  if (state.dataLoading) return
  $('dataWhereInput').value = ''
  $('dataOrderInput').value = ''
  state.whereClause = ''
  state.orderByClause = ''
  $('clearFilterBtn').hidden = true
  if (state.activeConnectionId && state.activeTable) {
    void loadTablePage(state.activeConnectionId, state.activeTable, 1, state.activeSchema)
  }
})

function addBlankDataRow() {
  const pd = state.pageData
  if (!pd || submittingChanges || state.dataLoading || getActiveConn()?.readOnly || isActiveDataObjectView()) return
  const values = {}
  for (const col of pd.columns) {
    if (
      col.isAutoIncrement ||
      col.isGenerated ||
      (col.defaultValue !== null && col.defaultValue !== undefined)
    ) {
      values[col.name] = undefined
    } else {
      values[col.name] = null
    }
  }
  const tempId = `ins_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const wrap = $('dataGridWrap')
  if (wrap) wrap.scrollTop = 0
  state.stagedInserts.unshift({ tempId, values, origin: 'blank' })
  const visCols = getOrderedVisibleColumns()
  state.selectedRowKey = tempId
  state.selectedCol = visCols[0]?.name || pd.columns[0]?.name || null
  renderDataGrid()
  if (!state.transposed) {
    dataGridSel?.selectRowRange(0, 0, true)
  }
  renderStagingBar()
  renderValueInspector()
}

$('addRowBtn').addEventListener('click', addBlankDataRow)

function canHandlePanelGlobalDataGridPaste(target) {
  if (state.formOpen || state.tab !== 'data' || state.dataLoading || !state.pageData) return false
  if (document.querySelector('.modal-backdrop:not([hidden])')) return false
  const ctxMenu = $('contextMenu')
  if (ctxMenu && !ctxMenu.hidden) return false
  const colsPop = $('dataColsPopover')
  if (colsPop && !colsPop.hidden) return false
  const isBlockedEl = (el) => {
    if (!(el instanceof HTMLElement)) return false
    if (
      el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      el.isContentEditable
    ) {
      return true
    }
    return Boolean(el.closest('#valueInspectorDrawer, #dmlPreviewDrawer, #explorerTree'))
  }
  if (isBlockedEl(document.activeElement) || isBlockedEl(target)) return false
  return true
}

// Allow Ctrl+V when Data tab is active even if focus is outside #dataGridWrap (e.g. empty area / freshly opened table)
const handlePanelDocumentPaste = (e) => {
  if (e.defaultPrevented) return
  if (!canHandlePanelGlobalDataGridPaste(e.target)) return
  const txt = e.clipboardData?.getData('text/plain') ?? e.clipboardData?.getData('text') ?? ''
  const handled = pasteDelimitedIntoDataGrid(txt, { forceNewRows: false })
  if (handled) {
    e.preventDefault()
  }
}
const handlePanelDocumentPasteNewRowsKey = (e) => {
  if (e.defaultPrevented) return
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.key.toLowerCase() !== 'v') return
  if (!canHandlePanelGlobalDataGridPaste(e.target)) return
  e.preventDefault()
  void triggerPanelPasteNewRows()
}
document.addEventListener('paste', handlePanelDocumentPaste)
document.addEventListener('keydown', handlePanelDocumentPasteNewRowsKey)
orcaDisposables.push(() => document.removeEventListener('paste', handlePanelDocumentPaste))
orcaDisposables.push(() => document.removeEventListener('keydown', handlePanelDocumentPasteNewRowsKey))

$('cloneRowBtn').addEventListener('click', () => cloneSelectedRows())
$('delRowBtn').addEventListener('click', () => toggleDeleteSelectedRows())

$('inspectCellBtn').addEventListener('click', () => {
  if (!state.selectedRowKey || !state.selectedCol) return
  state.inspectorOpen = !state.inspectorOpen
  if (state.inspectorOpen) state.inspectorCollapsed = false
  renderValueInspector()
  renderStagingBar()
  if (state.inspectorOpen && !$('valueInspectorDrawer').hidden) {
    $('valueInspectorText').focus()
  }
})

let lastPanelDmlPreviewText = ''

$('dmlPreviewBtn').addEventListener('click', async () => {
  if (previewingDml || submittingChanges || getStagedCount() === 0 || !state.activeConnectionId || !state.activeTable) return
  const reqSeq = ++dmlPreviewSeq
  const targetConnId = state.activeConnectionId
  const targetTable = state.activeTable
  const targetSchema = state.activeSchema || ''
  previewingDml = true
  const btn = $('dmlPreviewBtn')
  setButtonLoading(btn, true, 'Previewing...')
  try {
    const res = await rpc('data.previewChanges', buildDataChangesPayload(), { timeoutMs: QUERY_TIMEOUT_MS })
    if (
      reqSeq !== dmlPreviewSeq ||
      getStagedCount() === 0 ||
      state.activeConnectionId !== targetConnId ||
      state.activeTable !== targetTable ||
      (state.activeSchema || '') !== targetSchema
    ) {
      return
    }
    const stmts = Array.isArray(res?.statements) ? res.statements : []
    lastPanelDmlPreviewText = stmts.join('\n')
    const previewDisplay =
      stmts.length > 300
        ? `${stmts.slice(0, 300).join('\n')}\n-- ... and ${stmts.length - 300} more statements (click Copy SQL for full script)`
        : lastPanelDmlPreviewText
    $('dmlPreviewCode').textContent = stmts.length > 0 ? previewDisplay : '-- No SQL statements generated.'
    $('dmlPreviewDrawer').hidden = false
  } catch (err) {
    if (reqSeq === dmlPreviewSeq) {
      showConnectionBanner(targetConnId, err?.message || 'Failed to preview DML', 'danger')
    }
  } finally {
    if (reqSeq === dmlPreviewSeq) {
      previewingDml = false
      setButtonLoading(btn, false)
      renderStagingBar()
    }
  }
})

$('copyDmlBtn').addEventListener('click', (e) =>
  void copyText(lastPanelDmlPreviewText || $('dmlPreviewCode').textContent, 'DML SQL copied', e.currentTarget)
)
$('closeDmlBtn').addEventListener('click', () => { $('dmlPreviewDrawer').hidden = true })

async function submitStagedChanges() {
  if (submittingChanges || state.dataLoading || getStagedCount() === 0 || !state.activeConnectionId || !state.activeTable || getActiveConn()?.readOnly) {
    return
  }
  const targetConnId = state.activeConnectionId
  const targetTable = state.activeTable
  const targetSchema = state.activeSchema
  const targetPage = state.page
  submittingChanges = true
  const submitBtn = $('submitChangesBtn')
  setButtonLoading(submitBtn, true, 'Submitting...')
  syncDataControlsDisabled()
  renderStagingBar()
  renderValueInspector()
  try {
    const res = await rpc('data.applyChanges', buildDataChangesPayload(), { timeoutMs: QUERY_TIMEOUT_MS })
    if (res?.ok) {
      // Clear staged edits IMMEDIATELY after DB commit succeeds so a failed post-commit reload
      // can never trigger a duplicate INSERT/UPDATE/DELETE on retry.
      clearStagedChanges()
      showBanner(`Committed: +${res.inserted || 0} / ~${res.updated || 0} / -${res.deleted || 0}`, 'success')
      if (
        state.activeConnectionId === targetConnId &&
        state.activeTable === targetTable &&
        (state.activeSchema || '') === (targetSchema || '')
      ) {
        await loadTablePage(targetConnId, targetTable, targetPage, targetSchema)
      }
    } else {
      showConnectionBanner(targetConnId, 'Batch commit rejected', 'danger')
    }
  } catch (err) {
    showConnectionBanner(targetConnId, `Commit failed: ${err?.message || err}`, 'danger')
  } finally {
    submittingChanges = false
    setButtonLoading(submitBtn, false)
    syncDataControlsDisabled()
    renderStagingBar()
    renderValueInspector()
  }
}

$('submitChangesBtn').addEventListener('click', () => void submitStagedChanges())

$('revertChangesBtn').addEventListener('click', () => {
  if (submittingChanges) return
  clearStagedChanges()
  renderDataGrid()
  renderValueInspector()
})

$('exportFormatSelect').addEventListener('change', (e) => {
  const sel = e.currentTarget
  if (!(sel instanceof HTMLSelectElement)) return
  const format = sel.value
  if (!format) return
  sel.value = ''
  exportCurrentDataPage(format, false)
})

$('downloadDataBtn')?.addEventListener('click', (e) => {
  e.stopPropagation()
  if (!state.pageData?.columns?.length) return
  const r = e.currentTarget.getBoundingClientRect()
  openContextMenu(r.left, r.bottom + 4, { type: 'dataDownload' })
})

$('sqlCopyExportBtn')?.addEventListener('click', () => {
  const fmt = $('sqlExportFormatSelect')?.value || 'csv'
  exportCurrentSqlResult(fmt, false)
})
$('sqlDownloadExportBtn')?.addEventListener('click', (e) => {
  e.stopPropagation()
  if (!state.lastSqlResult?.columns?.length) return
  const r = e.currentTarget.getBoundingClientRect()
  openContextMenu(r.left, r.bottom + 4, { type: 'sqlDownload' })
})

$('toggleInspectorBodyBtn').addEventListener('click', () => {
  state.inspectorCollapsed = !state.inspectorCollapsed
  renderValueInspector()
})
let inspectorResizeCleanup = null
;(() => {
  const resizer = $('valueInspectorResizer')
  const drawer = $('valueInspectorDrawer')
  if (!resizer || !drawer) return
  const STORAGE_KEY = 'datanoa.panelValueInspectorPx'
  const DEFAULT_PX = 220
  const MIN_PX = 148
  const STEP_PX = 24
  let rafId = null

  const getMaxPx = () => {
    const parentH = drawer.parentElement?.getBoundingClientRect?.().height
    return parentH && Number.isFinite(parentH) && parentH > 0
      ? Math.max(MIN_PX, Math.floor(parentH * 0.76))
      : 560
  }
  const clampPx = (px, cachedMaxPx = null) => {
    const maxPx = cachedMaxPx !== null ? cachedMaxPx : getMaxPx()
    return Math.max(MIN_PX, Math.min(maxPx, Math.round(px)))
  }
  const applyPx = (px, persist, cachedMaxPx = null, notifyVirt = true) => {
    const clamped = clampPx(px, cachedMaxPx)
    drawer.style.height = `${clamped}px`
    resizer.setAttribute('aria-valuenow', String(clamped))
    if (persist) {
      try { window.localStorage?.setItem(STORAGE_KEY, String(clamped)) } catch {}
    }
    if (notifyVirt && dataVirt?.active) {
      scheduleDataVirtRender()
    }
    return clamped
  }

  resizer.addEventListener('mousedown', (e) => {
    if (state.inspectorCollapsed) return
    if (e.button !== undefined && e.button !== 0) return
    e.preventDefault()
    inspectorResizeCleanup?.()
    const startY = e.clientY
    const parentEl = drawer.parentElement
    const cachedMaxPx = getMaxPx()
    const startH = clampPx(drawer.getBoundingClientRect?.().height || DEFAULT_PX, cachedMaxPx)
    let currentH = startH
    let lastAppliedH = -1
    let dragRafPending = false
    resizer.classList.add('is-resizing')
    parentEl?.classList?.add('is-split-resizing')
    setPanelViewportResizing(true)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'

    const flushDragHeight = () => {
      dragRafPending = false
      rafId = null
      if (currentH === lastAppliedH) return
      lastAppliedH = currentH
      applyPx(currentH, false, cachedMaxPx, typeof ResizeObserver === 'undefined')
    }

    const onMove = (ev) => {
      if (ev.isTrusted && ev.buttons === 0) {
        onEnd()
        return
      }
      const nextH = clampPx(startH + (startY - ev.clientY), cachedMaxPx)
      if (nextH === currentH) return
      currentH = nextH
      if (typeof requestAnimationFrame === 'function') {
        if (!dragRafPending) {
          dragRafPending = true
          const id = requestAnimationFrame(flushDragHeight)
          rafId = dragRafPending ? id : null
        }
      } else {
        flushDragHeight()
      }
    }
    const onKeyDown = (keyEv) => {
      if (keyEv.key === 'Escape') {
        keyEv.preventDefault()
        cleanup()
      }
    }
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onEnd)
      window.removeEventListener('blur', onEnd)
      window.removeEventListener('keydown', onKeyDown)
      dragRafPending = false
      if (rafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      resizer.classList.remove('is-resizing')
      parentEl?.classList?.remove('is-split-resizing')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setPanelViewportResizing(false)
      if (inspectorResizeCleanup === cleanup) inspectorResizeCleanup = null
    }
    const onEnd = () => {
      cleanup()
      applyPx(currentH, true, cachedMaxPx, true)
    }
    inspectorResizeCleanup = cleanup
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onEnd)
    window.addEventListener('blur', onEnd)
    window.addEventListener('keydown', onKeyDown)
  })

  resizer.addEventListener('dblclick', () => applyPx(DEFAULT_PX, true))
  resizer.addEventListener('keydown', (e) => {
    if (state.inspectorCollapsed) return
    const cur = clampPx(drawer.getBoundingClientRect?.().height || DEFAULT_PX)
    let next = null
    if (e.key === 'ArrowUp') next = cur + STEP_PX
    else if (e.key === 'ArrowDown') next = cur - STEP_PX
    else if (e.key === 'Home') next = MIN_PX
    else if (e.key === 'End') next = clampPx(9999)
    if (next !== null) {
      e.preventDefault()
      applyPx(next, true)
    }
  })
})()
$('closeInspectorBtn').addEventListener('click', () => {
  inspectorResizeCleanup?.()
  state.inspectorOpen = false
  renderValueInspector()
  renderStagingBar()
})
$('inspectorCopyBtn').addEventListener('click', (e) => {
  void copyText($('valueInspectorText').value, 'Cell value copied', e.currentTarget)
})
$('valueInspectorText')?.addEventListener('input', () => {
  inspectorUserModified = true
  const nullBadge = $('inspectorNullBadge')
  if (nullBadge && $('valueInspectorText').value.length > 0) nullBadge.hidden = true
  updateInspectorMetaAndJson()
})
$('valueInspectorText')?.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault()
    $('inspectorApplyBtn')?.click()
  }
})
$('inspectorFormatJsonBtn')?.addEventListener('click', () => {
  const inp = $('valueInspectorText')
  try {
    inp.value = formatJsonPreservingNumbers(inp.value.trim(), 2)
    inspectorUserModified = true
    updateInspectorMetaAndJson()
  } catch {}
})
$('inspectorMinifyJsonBtn')?.addEventListener('click', () => {
  const inp = $('valueInspectorText')
  try {
    inp.value = formatJsonPreservingNumbers(inp.value.trim(), 0)
    inspectorUserModified = true
    updateInspectorMetaAndJson()
  } catch {}
})
$('inspectorNullBtn').addEventListener('click', () => {
  if (submittingChanges || getActiveConn()?.readOnly) return
  const coords = dataGridSel?.getSelectedCoords(50000) || []
  if (coords.length > 1) {
    bulkSetSelectedCellsValue(null)
    return
  }
  if (!state.selectedRowKey || !state.selectedCol) return
  const entry = getAllDisplayRows().find((r) => r.rowKey === state.selectedRowKey)
  const col = state.pageData?.columns?.find((c) => c.name === state.selectedCol)
  if (!entry || !col) return
  if (!isDataCellEditable(entry, col, state.pageData, Boolean(getActiveConn()?.readOnly))) return
  if (col.nullable === false) {
    showBanner(`Column "${col.name}" is NOT NULL.`, 'warn')
    return
  }
  stageCellValue(entry.rowKey, entry.data, state.selectedCol, null)
})
$('inspectorApplyBtn').addEventListener('click', () => {
  if (submittingChanges || !state.selectedRowKey || !state.selectedCol) return
  const entry = getAllDisplayRows().find((r) => r.rowKey === state.selectedRowKey)
  const col = state.pageData?.columns?.find((c) => c.name === state.selectedCol)
  if (!entry || !col) return
  if (!isDataCellEditable(entry, col, state.pageData, Boolean(getActiveConn()?.readOnly))) return
  const curVal = getEffectiveCellValue(entry.rowKey, entry.data, state.selectedCol)
  if (!inspectorUserModified && curVal !== null && curVal !== undefined) {
    return
  }
  const nextVal = coerceTypedCellInput(
    $('valueInspectorText').value,
    entry.data[state.selectedCol],
    col.nativeType || col.type,
    col.nullable !== false
  )
  stageCellValue(entry.rowKey, entry.data, state.selectedCol, nextVal)
})

$('pageSizeSelect').addEventListener('change', (e) => {
  if (state.dataLoading) return
  const sel = e.currentTarget
  if (!(sel instanceof HTMLSelectElement)) return
  const nextSize = Number(sel.value)
  if (!Number.isFinite(nextSize) || nextSize < 1) return
  state.pageSize = nextSize
  if (state.activeConnectionId && state.activeTable) {
    void loadTablePage(state.activeConnectionId, state.activeTable, 1, state.activeSchema)
  }
})
$('prevPageBtn').addEventListener('click', () => {
  if (!state.dataLoading && state.activeConnectionId && state.activeTable && state.page > 1) {
    void loadTablePage(state.activeConnectionId, state.activeTable, state.page - 1, state.activeSchema)
  }
})
$('nextPageBtn').addEventListener('click', () => {
  if (state.dataLoading || !state.activeConnectionId || !state.activeTable || !state.pageData) return
  const totalPages = Math.max(1, Math.ceil(state.pageData.totalRows / (state.pageData.pageSize || state.pageSize || 100)))
  if (state.page < totalPages) {
    void loadTablePage(state.activeConnectionId, state.activeTable, state.page + 1, state.activeSchema)
  }
})

const formatSqlInEditor = () => {
  const current = getSqlText()
  const formatted = formatPanelSql(current, getActiveConn()?.driver || 'sqlite')
  if (formatted && formatted !== current) {
    setSqlText(formatted, { focus: true })
    showBanner('SQL formatted', 'success')
  }
}

$('structureTableSelect')?.addEventListener('change', (e) => {
  const decoded = decodeTableSelectValue(e.target.value)
  if (!decoded?.name || !state.activeConnectionId) return
  selectTableAndOpen(state.activeConnectionId, decoded.name, decoded.schema, false, {
    preserveSqlEditor: true,
  })
  renderStructure()
})

$('sqlSuccessCloseBtn')?.addEventListener('click', () => dismissActiveSqlSuccessBanner())
$('sqlErrorCloseBtn')?.addEventListener('click', () => dismissActiveSqlErrorBanner())

$('runSqlBtn').addEventListener('click', () => void runSql('caret'))
$('runAllSqlBtn').addEventListener('click', () => void runSql('all'))
$('explainSqlBtn').addEventListener('click', () => void runSql('explain'))
$('formatSqlBtn')?.addEventListener('click', formatSqlInEditor)

$('cancelSqlBtn').addEventListener('click', async () => {
  const targetQueryId = state.activeWorkerQueryId || state.activeQueryId
  if (!targetQueryId) return
  markSqlRunCancelled()
  const cancelBtn = $('cancelSqlBtn')
  setButtonLoading(cancelBtn, true, 'Cancelling...')
  try {
    const res = await rpc('query.cancel', { queryId: targetQueryId })
    if (res && res.ok === false) {
      showBanner(res.message || 'Unable to cancel active query', 'warn')
      if (state.activeQueryId) setButtonLoading(cancelBtn, false)
    } else {
      showBanner('Query cancel requested', 'neutral')
    }
  } catch (err) {
    showBanner(err?.message || 'Cancel failed', 'danger')
    if (state.activeQueryId) setButtonLoading(cancelBtn, false)
  }
})

$('sqlAiBtn')?.addEventListener('click', () => {
  void openAiSettingsModal()
})
$('toggleHistoryBtn').addEventListener('click', () => {
  state.historyOpen = !state.historyOpen
  $('sqlHistoryDrawer').hidden = !state.historyOpen
  if (state.historyOpen) void loadQueryHistory()
})
$('historySearchInput')?.addEventListener('input', (e) => {
  state.historyFilter = e.target.value || ''
  renderQueryHistory()
})
$('refreshHistoryBtn').addEventListener('click', () => void loadQueryHistory())
$('closeHistoryBtn').addEventListener('click', () => {
  state.historyOpen = false
  $('sqlHistoryDrawer').hidden = true
})
$('clearHistoryBtn').addEventListener('click', async () => {
  const btn = $('clearHistoryBtn')
  setButtonLoading(btn, true, 'Clearing...')
  bumpHistorySeq()
  try {
    await rpc('query.history.clear')
    state.historyEntries = []
    renderQueryHistory()
    showBanner('Query history cleared', 'success')
  } catch (err) {
    showBanner(err?.message || 'Failed to clear history', 'danger')
  } finally {
    setButtonLoading(btn, false)
  }
})

$('dataRemoteReloadBtn')?.addEventListener('click', () => {
  if ($('dataRemoteChangeBanner')) $('dataRemoteChangeBanner').hidden = true
  if (state.activeConnectionId && state.activeTable && !state.dataLoading) {
    void loadTablePage(state.activeConnectionId, state.activeTable, state.page, state.activeSchema)
  }
})
$('dataRemoteDismissBtn')?.addEventListener('click', () => {
  if ($('dataRemoteChangeBanner')) $('dataRemoteChangeBanner').hidden = true
})

$('copyDdlBtn').addEventListener('click', (e) => {
  void copyText($('structureDdlCode').textContent, 'CREATE TABLE DDL copied', e.currentTarget)
})
$('openDdlConsoleBtn').addEventListener('click', () => {
  setSqlText($('structureDdlCode').textContent, { focus: true })
  switchTab('sql')
})

bindCtrlWheelHorizontalScroll($('dataGridWrap'))
bindCtrlWheelHorizontalScroll($('sqlResultWrap'))
document.querySelectorAll('#tabStructure .grid-wrap').forEach((el) => {
  bindCtrlWheelHorizontalScroll(el)
  el.addEventListener('scroll', () => closePanelComboPopover(), { passive: true })
})

document.querySelectorAll('.modal-backdrop .grid-wrap').forEach((el) => {
  bindCtrlWheelHorizontalScroll(el)
})
bindCtrlWheelHorizontalScroll($('sqlConsoleTabsBar'))
bindCtrlWheelHorizontalScroll($('sqlResultSetsBar'))
const panelViewportEl = document.querySelector('.viewport')
if (panelViewportEl) {
  panelViewportEl.addEventListener(
    'scroll',
    () => {
      closePanelComboPopover()
      scheduleSavePanelViewState(250)
    },
    { passive: true }
  )
}
$('dataGridWrap')?.addEventListener(
  'scroll',
  () => {
    scheduleSavePanelViewState(250)
  },
  { passive: true }
)
$('sqlResultWrap')?.addEventListener(
  'scroll',
  () => {
    scheduleSavePanelViewState(250)
  },
  { passive: true }
)

// Global context menu dismissal & shortcuts
document.addEventListener('click', () => {
  closeContextMenu()
  closeDataColsPopover()
})
window.addEventListener('resize', () => {
  closeActiveCustomDropdown()
})
window.addEventListener('blur', () => {
  closeActiveCustomDropdown()
  closeContextMenu()
  closePanelComboPopover()
  closeDataColsPopover()
  if (typeof activeResizeCleanup === 'function') {
    activeResizeCleanup()
    activeResizeCleanup = null
  }
  if (typeof inspectorResizeCleanup === 'function') {
    inspectorResizeCleanup()
  }
})

const PANEL_MODAL_FOCUS_TRAP_IDS = [
  'bulkFillModal',
  'createTableModal',
  'feedbackModal',
  'cmdPaletteModal',
  'shortcutsModal',
  'dangerSqlModal',
  'dangerTableModal',
  'confirmMigrationModal',
  'confirmDeleteModal',
]
const MODAL_FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

function isElementVisibleForFocusTrap(el, boundaryEl) {
  const isHtmlEl =
    typeof HTMLElement === 'function'
      ? el instanceof HTMLElement
      : Boolean(el && typeof el === 'object' && typeof el.focus === 'function')
  if (!isHtmlEl || el.hidden) return false
  let node = el
  while (node && node !== boundaryEl) {
    if (node.hidden) return false
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      const style = window.getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden') return false
    } else if (node.style?.display === 'none' || node.style?.visibility === 'hidden') {
      return false
    }
    node = node.parentElement
  }
  return true
}

function getActivePanelModalEl() {
  for (const id of PANEL_MODAL_FOCUS_TRAP_IDS) {
    const el = $(id)
    if (el && !el.hidden) return el
  }
  return null
}

// Capture-phase Tab trap & Escape dismissal for overlays/popovers/modals
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    if (document.querySelector('.datanoa-ai-backdrop') || document.querySelector('.panel-fp-backdrop')) {
      return
    }
    const activeModal = getActivePanelModalEl()
    if (!activeModal) return
    const focusables = Array.from(activeModal.querySelectorAll(MODAL_FOCUSABLE_SELECTOR)).filter((el) =>
      isElementVisibleForFocusTrap(el, activeModal)
    )
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement
    if (e.shiftKey) {
      if (active === first || !activeModal.contains(active)) {
        e.preventDefault()
        last.focus()
      }
    } else if (active === last || !activeModal.contains(active)) {
      e.preventDefault()
      first.focus()
    }
    return
  }
  if (e.key !== 'Escape') return
  const aiBackdrop = document.querySelector('.datanoa-ai-backdrop')
  if (aiBackdrop) {
    e.preventDefault()
    e.stopPropagation()
    if (typeof aiBackdrop._closeAiModal === 'function') {
      aiBackdrop._closeAiModal()
    } else {
      const closeBtn =
        aiBackdrop.querySelector('[aria-label="Close AI SQL Assistant settings"]') ||
        aiBackdrop.querySelector('.datanoa-ai-modal-head button')
      closeBtn?.click()
    }
    return
  }
  if (
    document.querySelector('.panel-fp-backdrop') ||
    document.querySelector('.datanoa-bind-params-modal') ||
    document.querySelector('.datanoa-ssh-trust-modal')
  ) {
    return
  }
  const activeEl = document.activeElement
  if (activeEl instanceof HTMLInputElement && activeEl.classList.contains('cell-edit-input')) {
    return
  }
  if (
    !getActivePanelModalEl() &&
    (sqlCtrl?.isSqlVimEscapeTarget?.(e.target) || sqlCtrl?.isSqlVimEscapeTarget?.(activeEl))
  ) {
    return
  }
  if (isCustomDropdownOpen()) {
    e.preventDefault()
    e.stopPropagation()
    closeActiveCustomDropdown()
    return
  }
  if (isPanelComboOpen()) {
    e.preventDefault()
    e.stopPropagation()
    closePanelComboPopover()
    return
  }
  if ($('dataColsPopover') && !$('dataColsPopover').hidden) {
    e.preventDefault()
    e.stopPropagation()
    closeDataColsPopover()
    return
  }
  if ($('bulkFillModal') && !$('bulkFillModal').hidden) {
    e.preventDefault()
    e.stopPropagation()
    closeBulkFillModal()
    return
  }
  if ($('createTableModal') && !$('createTableModal').hidden) {
    e.preventDefault()
    e.stopPropagation()
    closeCreateTableModal(false)
    return
  }
  if ($('feedbackModal') && !$('feedbackModal').hidden) {
    e.preventDefault()
    e.stopPropagation()
    closeFeedbackModal()
    return
  }
  if ($('cmdPaletteModal') && !$('cmdPaletteModal').hidden) {
    e.preventDefault()
    e.stopPropagation()
    closeCmdPaletteModal()
    return
  }
  if ($('shortcutsModal') && !$('shortcutsModal').hidden) {
    e.preventDefault()
    e.stopPropagation()
    closeShortcutsModal()
    return
  }
  if ($('dangerSqlModal') && !$('dangerSqlModal').hidden) {
    e.preventDefault()
    e.stopPropagation()
    $('dangerSqlCancelBtn')?.click()
    return
  }
  if ($('dangerTableModal') && !$('dangerTableModal').hidden) {
    e.preventDefault()
    e.stopPropagation()
    closeDangerTableModal(false)
    return
  }
  if (!$('confirmMigrationModal').hidden) {
    e.preventDefault()
    e.stopPropagation()
    closeMigrationConfirmModal(false)
    return
  }
  if (!$('confirmDeleteModal').hidden) {
    e.preventDefault()
    e.stopPropagation()
    closeDeleteConfirmModal(false)
    return
  }
  if (!$('contextMenu').hidden) {
    e.preventDefault()
    e.stopPropagation()
    closeContextMenu()
    return
  }
  if (state.formOpen && !state.formBusy) {
    e.preventDefault()
    e.stopPropagation()
    setFormOpen(false)
  }
}, true)

feedbackPaletteCtrl.bindEvents()

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
    if ($('cmdPaletteModal') && !$('cmdPaletteModal').hidden) {
      e.preventDefault()
      closeCmdPaletteModal()
      return
    }
    if (state.formOpen || isAnyModalOpen()) return
    e.preventDefault()
    openCmdPaletteModal()
    return
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === '/') {
    const tgt = e.target
    if (
      tgt instanceof HTMLInputElement ||
      tgt instanceof HTMLTextAreaElement ||
      tgt instanceof HTMLSelectElement ||
      (tgt instanceof HTMLElement && tgt.isContentEditable)
    ) {
      return
    }
    if (state.formOpen || isAnyModalOpen()) return
    e.preventDefault()
    openShortcutsModal()
    return
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
    if (state.formOpen || isAnyModalOpen()) return
    if (state.tab === 'data' && $('dataFindInput')) {
      e.preventDefault()
      $('dataFindInput').focus()
      $('dataFindInput').select()
    }
    return
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
    if (state.formOpen || isAnyModalOpen()) return
    if (state.tab === 'structure') {
      if (!state.isMigrating && countPanelStructChanges(state.structDraft) > 0 && !getActiveConn()?.readOnly) {
        e.preventDefault()
        applyPanelStructChanges()
      }
      return
    }
    if (state.tab === 'data') {
      const activeEl = document.activeElement
      if (activeEl instanceof HTMLInputElement && activeEl.classList.contains('cell-edit-input')) {
        e.preventDefault()
        activeEl.blur()
      }
      if (getStagedCount() > 0 && !getActiveConn()?.readOnly) {
        e.preventDefault()
        void submitStagedChanges()
      }
    }
  }
})

// Host listeners
function trackOrcaDisposable(d) {
  if (typeof d === 'function' || (d && typeof d.dispose === 'function')) {
    orcaDisposables.push(d)
  }
}

if (window.orca?.on) {
  try {
    trackOrcaDisposable(window.orca.on('theme', (payload) => {
      document.documentElement.removeAttribute('data-theme-override')
      if (payload?.colorScheme === 'light' || payload?.colorScheme === 'dark') {
        const isLight = payload.colorScheme === 'light'
        const isDark = payload.colorScheme === 'dark'
        document.documentElement.classList.toggle('light', isLight)
        document.documentElement.classList.toggle('dark', isDark)
        document.body?.classList.toggle('light', isLight)
        document.body?.classList.toggle('dark', isDark)
        syncSidebarBackgroundFromTokens()
        setSqlColorScheme(isLight)
      } else {
        syncThemeFromTokens()
        setSqlColorScheme(document.documentElement.classList.contains('light'))
      }
    }))
    trackOrcaDisposable(window.orca.on('editor.typography.changed', (typo) => {
      applyTypographySnapshot(typo)
      setSqlTypography(typo)
    }))
  } catch {}
}
if (window.orca?.plugin?.on) {
  try {
    trackOrcaDisposable(
      window.orca.plugin.on('connections.changed', () => {
        if (pendingReorderCount > 0) {
          if (expectedSelfChangedEvents > 0) {
            expectedSelfChangedEvents--
            consumedSelfChangedEvents++
            return
          }
          refreshConnectionsAfterReorder = true
          return
        }
        void refreshConnections()
      })
    )
    trackOrcaDisposable(window.orca.plugin.on('ai.status.changed', (snapshot) => applyAiStatus(snapshot)))
    if (typeof window.orca.settings?.onDidChange === 'function') {
      trackOrcaDisposable(window.orca.settings.onDidChange((change) => {
        if (typeof change?.key === 'string' && change.key.startsWith('ai')) {
          void hydrateAiStatus()
        }
        const k = change?.key
        if (
          !k ||
          k === 'all' ||
          k === 'editorKeymap' ||
          k === 'shortcutRunStatement' ||
          k === 'shortcutRunAll' ||
          k === 'shortcutFormatSql' ||
          k.startsWith('datanoa.editorKeymap') ||
          k.startsWith('datanoa.shortcut')
        ) {
          void hydratePanelKeymapSettings()
        }
      }))
    }
    trackOrcaDisposable(window.orca.plugin.on('data.cellUpdated', (payload) => {
      if (!state.activeConnectionId || !state.activeTable) return
      if (payload?.connectionId && payload.connectionId !== state.activeConnectionId) return
      if (payload?.table && payload.table !== state.activeTable) return
      if (payload?.schema !== undefined && (payload.schema || '') !== (state.activeSchema || '')) return
      if (submittingChanges) return
      if (getStagedCount() > 0) {
        const banner = $('dataRemoteChangeBanner')
        const txt = $('dataRemoteChangeText')
        if (banner && txt) {
          txt.textContent = `Remote update detected for "${state.activeTable}". Reload to sync (discards staged edits) or dismiss.`
          banner.hidden = false
        }
        return
      }
      void loadTablePage(state.activeConnectionId, state.activeTable, state.page, state.activeSchema)
    }))
    trackOrcaDisposable(window.orca.plugin.on('ui.tableDisplayState.changed', (payload) => {
      if (!payload || typeof payload !== 'object') return
      const activeKey = getActiveTableKey()
      if (payload.bulkReset === true) {
        let activeUpdated = false
        if (Array.isArray(payload.tableKeys) && payload.tableKeys.length > 0) {
          for (const rawKey of payload.tableKeys) {
            if (typeof rawKey !== 'string' || !rawKey) continue
            const k = normalizeTableKey(rawKey)
            const rev =
              typeof payload.revisions?.[rawKey] === 'number'
                ? payload.revisions[rawKey]
                : typeof payload.revisions?.[k] === 'number'
                  ? payload.revisions[k]
                  : payload.revision
            const cleanRev = resolveIncomingTableDisplayRevision(null, rev)
            const prevRev = state.tableDisplayRevisionByTable[k] || 0
            if (cleanRev > 0 && cleanRev <= prevRev) continue
            const q = getPanelTableDisplayQueue(k)
            q.dirty = false
            q.overwrittenByRemoteWhileInFlight = false
            q.pendingPatch = null
            clearPanelPendingRemoteRebase(q)
            q.recentSelfRevisions.clear()
            const applied = applyTableDisplayEntryForKey(k, null, rev)
            if (applied && k === activeKey) activeUpdated = true
          }
        } else {
          const targetConnId =
            typeof payload.connectionId === 'string' && payload.connectionId
              ? payload.connectionId
              : null
          const matchesBulkTarget = (k) =>
            payload.all === true ||
            (targetConnId !== null && tableKeyMatchesConnection(k, targetConnId))
          const candidateKeys = new Set([
            ...Object.keys(state.tableDisplayByTable || {}),
            ...Array.from(panelTableDisplayQueues.keys()),
            ...(activeKey ? [activeKey] : []),
          ])
          const cleanRev = resolveIncomingTableDisplayRevision(null, payload.revision)
          for (const k of candidateKeys) {
            if (!matchesBulkTarget(k)) continue
            const prevRev = state.tableDisplayRevisionByTable[k] || 0
            if (cleanRev > 0 && cleanRev <= prevRev) continue
            const q = getPanelTableDisplayQueue(k)
            q.dirty = false
            q.overwrittenByRemoteWhileInFlight = false
            q.pendingPatch = null
            clearPanelPendingRemoteRebase(q)
            q.recentSelfRevisions.clear()
            const applied = applyTableDisplayEntryForKey(k, null, payload.revision)
            if (applied && k === activeKey) activeUpdated = true
          }
        }
        if (activeUpdated) {
          syncActiveTableDisplayUi(activeKey)
        }
        return
      }
      const rawTblKey =
        typeof payload.tableKey === 'string' && payload.tableKey.trim().length > 0
          ? payload.tableKey
          : payload.connectionId && payload.table
            ? makeTableKey(payload.connectionId, payload.table, payload.schema)
            : ''
      const tblKey = normalizeTableKey(rawTblKey)
      if (!tblKey) return
      const nextRev = resolveIncomingTableDisplayRevision(payload.entry ?? null, payload.revision)
      const prevRev = state.tableDisplayRevisionByTable[tblKey] || 0
      if (nextRev > 0 && nextRev <= prevRev) return
      const queue = getPanelTableDisplayQueue(tblKey)
      if (nextRev > 0 && queue.recentSelfRevisions.has(nextRev)) {
        state.tableDisplayRevisionByTable[tblKey] = Math.max(prevRev, nextRev)
        return
      }
      if (queue.inFlight) {
        if (areTableDisplayStateEntriesEquivalent(payload.entry ?? null, queue.inFlightSentSnapshot)) {
          if (nextRev > 0) {
            recordPanelSelfTableDisplayRevision(queue, nextRev)
            state.tableDisplayRevisionByTable[tblKey] = Math.max(prevRev, nextRev)
          }
          return
        }
        if (queue.dirty || queue.pendingPatch) {
          if (nextRev > 0) {
            state.tableDisplayRevisionByTable[tblKey] = Math.max(prevRev, nextRev)
          }
          setPanelPendingRemoteRebase(queue, payload.entry ?? null, nextRev)
          return
        }
      }
      const applied = applyTableDisplayEntryForKey(tblKey, payload.entry ?? null, payload.revision)
      if (applied) {
        if (queue.inFlight) {
          queue.overwrittenByRemoteWhileInFlight = true
        }
        syncActiveTableDisplayUi(tblKey)
      }
    }))
    trackOrcaDisposable(window.orca.plugin.on('ssh.hostKeyChallenge', (challenge) => {
      if (!isPanelActive() || !challenge || typeof challenge !== 'object') return
      void openSharedSshHostKeyModal({
        challenge,
        panelId: getPanelInstanceId(),
        connectionId:
          activeHostKeyRetryConnId ||
          (state.formOpen && state.editingId ? state.editingId : undefined) ||
          state.activeConnectionId ||
          undefined,
        resolveDecision: resolvePanelSshHostKeyDecision,
      })
    }))
    trackOrcaDisposable(window.orca.plugin.on('ssh.hostKeyResolved', (ev) => {
      if (!ev || typeof ev !== 'object' || typeof ev.challengeId !== 'string') return
      closeByChallengeId(ev.challengeId, ev.decision)
    }))
  } catch {}
}

const onPanelVisibilityChange = () => {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    flushPendingSavePanelViewState()
    savePanelDataCache()
  }
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', onPanelVisibilityChange)
  trackOrcaDisposable(() => {
    document.removeEventListener('visibilitychange', onPanelVisibilityChange)
  })
}

window.addEventListener('beforeunload', () => {
  flushPendingSavePanelViewState()
  savePanelDataCache()
})

window.addEventListener('pagehide', () => {
  closeActiveCustomDropdown()
  flushPendingSavePanelViewState()
  savePanelDataCache()
  panelDisposed = true
  clearUriPasteTimer()
  connFormCtrl.clearFormImportSpotlight?.(true)
  refreshConnectionsPending = false
  refreshConnectionsAfterReorder = false
  expectedSelfChangedEvents = 0
  consumedSelfChangedEvents = 0
  reorderSeq++
  connReorderSeq++
  folderReorderSeq++
  schemaRefreshPending.clear()
  for (const [cid, seq] of schemaLoadSeqByConn.entries()) {
    schemaLoadSeqByConn.set(cid, seq + 1)
  }
  cancelPendingDataAndSchemaLoads()
  if (findDebounceTimer !== null) { clearTimeout(findDebounceTimer); findDebounceTimer = null }
  if (schemaFilterDebounceTimer !== null) { clearTimeout(schemaFilterDebounceTimer); schemaFilterDebounceTimer = null }
  if (bannerDismissTimer !== null) { clearTimeout(bannerDismissTimer); bannerDismissTimer = null }
  if (dataVirt.rafId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(dataVirt.rafId)
    dataVirt.rafId = null
  }
  if (sqlVirt.rafId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(sqlVirt.rafId)
    sqlVirt.rafId = null
  }
  if (gridResizeObserver) {
    try { gridResizeObserver.disconnect() } catch {}
    gridResizeObserver = null
  }
  if (typeof activeResizeCleanup === 'function') {
    activeResizeCleanup()
    activeResizeCleanup = null
  }
  if (typeof inspectorResizeCleanup === 'function') {
    inspectorResizeCleanup()
  }
  dataGridSel?.destroy?.()
  sqlGridSel?.destroy?.()
  aiSettingsModalOpenSeq += 1
  closeExistingAiSettingsBackdrops()
  closeAllSshHostKeyModals()
  destroySqlEditor()
  while (orcaDisposables.length > 0) {
    const d = orcaDisposables.pop()
    try {
      if (typeof d === 'function') d()
      else if (d && typeof d.dispose === 'function') d.dispose()
    } catch {}
  }
})

function applyAiStatus(snapshot) {
  state.aiStatus = snapshot || null
  sqlCtrl?.onAiStatusChanged?.()
}

async function hydrateAiStatus() {
  try {
    const snapshot = await rpc('ai.status.get')
    if (!isPanelActive()) return
    applyAiStatus(snapshot)
  } catch {
    // Non-blocking when worker is booting or under minimal mock
  }
}

async function hydratePanelKeymapSettings() {
  try {
    const getter = window.orca?.settings?.get
    if (typeof getter !== 'function') return
    const [editorKeymap, shortcutRunStatement, shortcutRunAll, shortcutFormatSql] = await Promise.all([
      Promise.resolve(getter('editorKeymap')),
      Promise.resolve(getter('shortcutRunStatement')),
      Promise.resolve(getter('shortcutRunAll')),
      Promise.resolve(getter('shortcutFormatSql')),
    ])
    if (!isPanelActive()) return
    const next = {}
    if (typeof editorKeymap === 'string') next.editorKeymap = editorKeymap
    if (typeof shortcutRunStatement === 'string') next.shortcutRunStatement = shortcutRunStatement
    if (typeof shortcutRunAll === 'string') next.shortcutRunAll = shortcutRunAll
    if (typeof shortcutFormatSql === 'string') next.shortcutFormatSql = shortcutFormatSql
    sqlCtrl?.applySqlKeymapSettings?.(next)
  } catch {
    // Non-blocking when settings API is absent
  }
}

let aiSettingsModalOpenSeq = 0

function closeExistingAiSettingsBackdrops() {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
    return
  }
  for (const existing of document.querySelectorAll('.datanoa-ai-backdrop')) {
    if (typeof existing._closeAiModal === 'function') {
      try {
        existing._closeAiModal()
      } catch {
        // Ignore modal teardown errors
      }
    }
    if (existing.parentNode) {
      existing.parentNode.removeChild(existing)
    }
  }
}

async function openAiSettingsModal(initialRole) {
  const openSeq = ++aiSettingsModalOpenSeq
  closeExistingAiSettingsBackdrops()
  await openSharedAiConfigModal({
    rpc,
    saveSettings: saveOrcaSettingsPatch,
    initialStatus: state.aiStatus,
    ...(initialRole ? { initialRole } : {}),
    onStatusUpdated: (snapshot) => applyAiStatus(snapshot),
    mountModal: (card, _canClose, onDismiss) => {
      if (openSeq !== aiSettingsModalOpenSeq) {
        onDismiss?.()
        return null
      }
      closeExistingAiSettingsBackdrops()
      const backdrop = document.createElement('div')
      backdrop.className = 'modal-backdrop datanoa-ai-backdrop'
      const closeBackdrop = () => {
        onDismiss?.()
        if (backdrop.parentNode) {
          backdrop.parentNode.removeChild(backdrop)
        }
      }
      backdrop._closeAiModal = closeBackdrop
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeBackdrop()
      })
      backdrop.appendChild(card)
      document.body.appendChild(backdrop)
      card.focus()
      return backdrop
    },
    closeModal: () => {
      closeExistingAiSettingsBackdrops()
    },
  })
}

restorePanelViewStateFromLocal()
void hydrateAiStatus()
void hydratePanelKeymapSettings()
bindSelectTooltipsInRoot(document)
syncThemeFromTokens()
setSqlColorScheme(document.documentElement.classList.contains('light'))
updateViewportLayout()
restorePanelWarmCacheFromLocal()
void syncOrcaTypography()
void refreshConnections({ isBoot: true })
