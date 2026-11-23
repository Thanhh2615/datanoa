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
  buildCreateTableSql,
  buildTruncateOrDropSql,
  createPanelStructDraft,
  countPanelStructChanges,
} from './panel-core.js'
import {
  $,
  setDbLogoElement,
  rpc,
  syncThemeFromTokens,
  applyTypographySnapshot,
  syncOrcaTypography,
  makeTableKey,
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
import { createPanelStructureController } from './panel-structure.js'
import { createPanelFeedbackAndPaletteController } from './panel-feedback-palette.js'
import { createPanelDataGridController } from './panel-data-grid.js'

const QUERY_TIMEOUT_MS = 115000

// Application state
const state = {
  tab: 'explorer',
  connections: [],
  activeConnectionId: null,
  schemaObjects: {},
  schemaLoading: new Set(),
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
  columnWidthsByTable: {},
  hiddenColsByTable: {},
  pinnedColsByTable: {},
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
  lastAutoFilledSqliteName: '',
  discoveredFiles: [],
  discoveredEnvs: [],
  discoveredDocker: [],
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
let dataPageLoadSeq = 0
let dmlPreviewSeq = 0
let lastLoadedPanelTableKey = null
let refreshConnectionsPending = false
const schemaRefreshPending = new Set()
const tableDetailsSeqByKey = new Map()
const orcaDisposables = []
let pendingDeleteConnId = null
let suppressSortClickUntil = 0
let activeResizeCleanup = null
let bannerDismissTimer = null
let dataLoadStopTimer = null
let saveViewStateTimer = null
let findDebounceTimer = null
let schemaFilterDebounceTimer = null
let previewingDml = false
let submittingChanges = false
let inspectorUserModified = false

function isAnyModalOpen() {
  const modalIds = [
    'confirmDeleteModal',
    'confirmMigrationModal',
    'bulkFillModal',
    'createTableModal',
    'dangerTableModal',
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
    if (typeof copy.url === 'string') {
      copy.url = scrubDraftUrlForLocalStorage(copy.url)
    }
    if (typeof copy.options === 'string') {
      copy.options = scrubDraftUrlForLocalStorage(copy.options).replace(
        /\b(password|passwd|pwd|secret|token|auth_token)\s*=\s*([^\s;&]+)/gi,
        '$1=[REDACTED]'
      )
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
  const s = String(raw || '').trim()
  if (!s) return ''
  let cleaned = s
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:/\s?#@]*):([^\s/]*)@/g, '$1$2@')
    .replace(/([?&])([^=&\s#]*(?:token|pass|pwd|secret|key|auth)[^=&\s#]*)=([^&\s#]*)/gi, '$1$2=[REDACTED]')
  try {
    const u = new URL(cleaned)
    for (const k of Array.from(u.searchParams.keys())) {
      if (/(?:token|pass|pwd|secret|key|auth)/i.test(k)) u.searchParams.delete(k)
    }
    cleaned = u.toString()
  } catch {}
  return cleaned
}

function sqlDraftLooksSensitive(sql) {
  if (!sql) return false
  return (
    /\b(?:IDENTIFIED\s+BY|PASSWORD\s*=|SECRET\s*=|TOKEN\s*=|ALTER\s+(?:USER|ROLE)\b|CREATE\s+(?:USER|ROLE)\b|AUTH\s+['"]?\S|SET\s+PASSWORD)\b/i.test(
      sql
    ) ||
    /:\/\/[^:/\s?#@]*:[^\s/]+@/i.test(sql) ||
    /[?&][^=&\s#]*(?:token|pass|pwd|secret|key|auth)[^=&\s#]*=/i.test(sql)
  )
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

function savePanelDataCache() {
  if (state.restoringViewState) return
  const activeKey =
    state.activeConnectionId && state.activeTable
      ? makeTableKey(state.activeConnectionId, state.activeTable, state.activeSchema)
      : null
  const activeSchemaObjs = state.activeConnectionId
    ? state.schemaObjects[state.activeConnectionId]
    : null
  const activeDetails = activeKey ? state.tableDetails[activeKey] : null

  const now = Date.now()
  const cache = {
    updatedAt: now,
    activeConnectionId: state.activeConnectionId,
    activeTable: state.activeTable,
    activeSchema: state.activeSchema,
    page: state.page,
    pageSize: state.pageSize,
    whereClause: state.whereClause || '',
    orderByClause: state.orderByClause || '',
    schemaObjects: activeSchemaObjs ? { [state.activeConnectionId]: activeSchemaObjs } : null,
    tableDetails: activeDetails && activeKey ? { [activeKey]: activeDetails } : null,
    pageData: state.pageData || null,
    lastSqlResult: state.lastSqlResult || null,
  }

  try {
    const localWarm = {
      ...cache,
      connections: sanitizeWarmPanelConnections(state.connections),
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
  if (state.restoringViewState) return
  const rawSqlDraft = typeof getSqlText === 'function' ? getSqlText() : ''
  const safeSqlDraft = sqlDraftLooksSensitive(rawSqlDraft) ? '' : rawSqlDraft
  const consoleTabsSnapshot =
    typeof getConsoleTabsPersistedState === 'function'
      ? getConsoleTabsPersistedState(sqlDraftLooksSensitive)
      : null
  const snapshot = {
    tab: state.tab,
    activeConnectionId: state.activeConnectionId,
    activeTable: state.activeTable,
    activeSchema: state.activeSchema,
    page: state.page,
    pageSize: state.pageSize,
    sortCol: state.sortCol,
    sortDir: state.sortDir,
    whereClause: state.whereClause,
    orderByClause: state.orderByClause,
    transposed: state.transposed,
    collapsedFolders: Array.from(state.collapsedFolders || []),
    expandedConns: Array.from(state.expandedConns),
    expandedTables: Array.from(state.expandedTables),
    expandedMeta: Array.from(state.expandedMeta),
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
      name: $('formName')?.value || '',
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
      options: scrubDraftUrlForLocalStorage($('formOptions')?.value || '').replace(
        /\b(password|passwd|pwd|secret|token|auth_token)\s*=\s*([^\s;&]+)/gi,
        '$1=[REDACTED]'
      ),
      redisDb: $('formRedisDb')?.value || '0',
      ssl: Boolean($('formSsl')?.checked),
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

function applyPanelViewStateSnapshot(saved) {
  if (!saved || typeof saved !== 'object') return
  state.hasRestoredViewState = true
  state.restoringViewState = true
  try {
    if (saved.activeConnectionId && typeof saved.activeConnectionId === 'string') {
      state.activeConnectionId = saved.activeConnectionId
    }
    if (saved.activeTable && typeof saved.activeTable === 'string') {
      state.activeTable = saved.activeTable
    }
    if (saved.activeSchema && typeof saved.activeSchema === 'string') {
      state.activeSchema = saved.activeSchema
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
      state.collapsedFolders = new Set(saved.collapsedFolders.filter((x) => typeof x === 'string'))
    }
    if (Array.isArray(saved.expandedConns)) {
      state.expandedConns = new Set(saved.expandedConns.filter((x) => typeof x === 'string'))
    }
    if (Array.isArray(saved.expandedTables)) {
      state.expandedTables = new Set(saved.expandedTables.filter((x) => typeof x === 'string'))
    }
    if (Array.isArray(saved.expandedMeta)) {
      state.expandedMeta = new Set(saved.expandedMeta.filter((x) => typeof x === 'string'))
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
    if (typeof saved.formDriver === 'string' && ENGINE_BY_ID[saved.formDriver]) {
      setFormDriver(saved.formDriver, false)
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
      if (typeof fd.readOnly === 'boolean' && $('formReadOnly')) $('formReadOnly').checked = fd.readOnly
      if (typeof fd.byodFolder === 'string' && fd.byodFolder && $('panelByodFolderInput')) {
        $('panelByodFolderInput').dataset.driver = state.formDriver
        $('panelByodFolderInput').value = fd.byodFolder
      }
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
    state.initialBootLoading = false
    state.warmBootHydrated = true
    state.warmBootUpdatedAt = Number.isFinite(dc.updatedAt) ? dc.updatedAt : 0
    if (!state.activeConnectionId && dc.activeConnectionId) {
      state.activeConnectionId = dc.activeConnectionId
    }
    if (dc.schemaObjects && typeof dc.schemaObjects === 'object') {
      for (const [cid, objs] of Object.entries(dc.schemaObjects)) {
        if (Array.isArray(objs) && !state.schemaObjects[cid]) {
          state.schemaObjects[cid] = objs
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
  $('dmlPreviewDrawer').hidden = true
  if ($('dataRemoteChangeBanner')) $('dataRemoteChangeBanner').hidden = true
  renderStagingBar()
}

function showBanner(text, tone = 'neutral') {
  if (tone === 'danger' && text) {
    state.lastError = String(text)
  }
  if (bannerDismissTimer !== null) {
    clearTimeout(bannerDismissTimer)
    bannerDismissTimer = null
  }
  const box = $('globalBanner')
  box.className = `banner ${tone}`
  $('globalBannerText').textContent = text
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
  $('globalBanner').hidden = true
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
}

async function copyText(text, successMsg, triggerBtn) {
  const copied = await writeTextToClipboard(text)

  if (triggerBtn instanceof HTMLButtonElement) {
    const origLabel = triggerBtn.dataset.origLabel || triggerBtn.textContent || 'Copy'
    triggerBtn.dataset.origLabel = origLabel
    if (triggerBtn._copyResetTimer) {
      clearTimeout(triggerBtn._copyResetTimer)
    }
    triggerBtn.textContent = 'Copied!'
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
  $('connMetaRow').hidden = state.formOpen || !active || state.tab !== 'explorer'
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
  getActiveForeignKeyMap: () => getActiveForeignKeyMap(),
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
} = sqlCtrl

const structCtrl = createPanelStructureController({
  state,
  QUERY_TIMEOUT_MS,
  getActiveConn: () => getActiveConn(),
  getConnById: (id) => getConnById(id),
  showBanner: (...a) => showBanner(...a),
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
  loadSchema: (id) => loadSchema(id),
  selectTableAndOpen: (...a) => selectTableAndOpen(...a),
  showBanner: (...a) => showBanner(...a),
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
})
const {
  closeFeedbackModal,
  openShortcutsModal,
  closeShortcutsModal,
  openCmdPaletteModal,
  closeCmdPaletteModal,
} = feedbackPaletteCtrl

async function refreshConnections(options = {}) {
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
    const [list, sessionSnap] = await Promise.all([
      rpc('connections.list'),
      shouldFetchBootSnap
        ? rpc('ui.getSessionSnapshot', { surface: 'panel' }).catch(() => null)
        : Promise.resolve(null),
    ])
    const prevConnSignature = JSON.stringify(state.connections)
    state.connections = Array.isArray(list) ? list : []
    const connsChanged = prevConnSignature !== JSON.stringify(state.connections)
    state.initialBootLoading = false
    if (!state.hasRestoredViewState && sessionSnap?.viewState && typeof sessionSnap.viewState === 'object') {
      applyPanelViewStateSnapshot(sessionSnap.viewState)
    } else if (!state.activeConnectionId && typeof window.orca?.storage?.get === 'function') {
      try {
        const hostSaved = await window.orca.storage.get(PANEL_VIEW_STATE_STORAGE_KEY)
        if (hostSaved && typeof hostSaved === 'object') {
          applyPanelViewStateSnapshot(hostSaved)
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
      if (dc.schemaObjects && typeof dc.schemaObjects === 'object') {
        for (const [cid, objs] of Object.entries(dc.schemaObjects)) {
          if (Array.isArray(objs) && !state.schemaObjects[cid]) {
            state.schemaObjects[cid] = objs
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
      const hasPersisted = Boolean(
        persistedId && state.connections.some((c) => c.id === persistedId)
      )
      state.activeConnectionId = hasPersisted
        ? persistedId
        : (state.connections.length > 0 ? state.connections[0].id : null)
      state.activeTable = null
      state.activeSchema = undefined
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
    if (state.activeConnectionId && state.expandedConns.size === 0 && !state.hasRestoredViewState) {
      state.expandedConns.add(state.activeConnectionId)
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
    for (const cid of state.expandedConns) {
      if (!state.connections.some((c) => c.id === cid)) continue
      const hasCachedSchema =
        Array.isArray(state.schemaObjects[cid]) && state.schemaObjects[cid].length > 0
      const activeNeedsPage =
        cid === state.activeConnectionId &&
        Boolean(state.activeTable) &&
        !state.pageData
      if (isFreshWarmResume && hasCachedSchema && !activeNeedsPage) {
        continue
      }
      void loadSchema(cid)
    }
    if (connsChanged) {
      savePanelDataCache()
    }
  } catch (err) {
    state.initialBootLoading = false
    showBanner(err?.message || 'Failed to load connections', 'danger')
    renderExplorer()
  } finally {
    state.initialBootLoading = false
    state.refreshingConns = false
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

function renderConnectionsBar() {
  $('connCountBadge').textContent = String(state.connections.length)
  const active = getActiveConn()
  updateViewportLayout()
  if (!active) {
    renderStructureTableSelect()
    return
  }
  setDbLogoElement($('activeConnLogo'), active.driver, 16)

  const envDot = $('envTagDot')
  if (active.colorTag && active.colorTag !== 'none') {
    envDot.className = `env-dot env-${active.colorTag}`
    envDot.title = `Environment: ${active.colorTag.toUpperCase()}`
    envDot.hidden = false
  } else {
    envDot.hidden = true
  }

  $('roBadge').hidden = !active.readOnly
  const badge = $('activeDriverBadge')
  badge.className = 'badge badge-neutral'
  badge.textContent = (ENGINE_BY_ID[active.driver]?.label || active.driver).toUpperCase()

  const sel = $('connSelect')
  sel.textContent = ''
  const buildOpt = (c) => {
    const opt = document.createElement('option')
    opt.value = c.id
    const tagText = c.colorTag && c.colorTag !== 'none' ? ` [${c.colorTag.toUpperCase()}]` : ''
    const roText = c.readOnly ? ' [RO]' : ''
    const sub = formatConnSubtitle(c)
    opt.textContent = `${c.name} (${c.driver})${tagText}${roText}`
    opt.dataset.driver = c.driver
    opt.dataset.fullTitle = `${c.name} (${c.driver})${tagText}${roText}${c.folder ? ` — Folder: ${c.folder}` : ''}${sub ? ` — ${sub}` : ''}`
    if (c.id === active.id) opt.selected = true
    return opt
  }
  const hasGrouping = state.connections.some((c) => Boolean((c.folder || '').trim()))
  if (!hasGrouping) {
    for (const c of state.connections) sel.appendChild(buildOpt(c))
  } else {
    const byFolder = new Map()
    const general = []
    for (const c of state.connections) {
      const f = (c.folder || '').trim()
      if (f) {
        if (!byFolder.has(f)) byFolder.set(f, [])
        byFolder.get(f).push(c)
      } else {
        general.push(c)
      }
    }
    for (const folder of Array.from(byFolder.keys()).sort((a, b) => a.localeCompare(b))) {
      const grp = document.createElement('optgroup')
      grp.label = folder
      for (const c of byFolder.get(folder)) grp.appendChild(buildOpt(c))
      sel.appendChild(grp)
    }
    if (general.length > 0) {
      const grp = document.createElement('optgroup')
      grp.label = 'General (Ungrouped)'
      for (const c of general) grp.appendChild(buildOpt(c))
      sel.appendChild(grp)
    }
  }
  const activeSub = formatConnSubtitle(active)
  $('connSubLabel').textContent = activeSub
  $('connSubLabel').title = activeSub
  enhanceCollapsibleSelectDropdown(sel, {
    tooltipPrefix: 'Active Database Connection',
    searchPlaceholder: 'Search connections or folders...',
    collapsedFolders: state.collapsedFolders,
    onFolderToggle: () => {
      savePanelViewState()
      renderExplorer()
    },
  })
  renderStructureTableSelect()
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
  const missing = objs
    .filter((o) => !state.tableDetails[makeTableKey(connectionId, o.name, o.schema)])
    .slice(0, 30)
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
          state.tableDetails[key] = det
        }
      } catch {}
    }
  })
  await Promise.all(workers)
  if (seq === structureSchemaPrefetchSeq && state.activeConnectionId === connectionId) {
    syncPanelSqlSchema(connectionId)
  }
}

async function loadSchema(connectionId) {
  if (!connectionId) return
  if (state.schemaLoading.has(connectionId)) {
    schemaRefreshPending.add(connectionId)
    return
  }
  state.schemaLoading.add(connectionId)
  renderExplorer()
  try {
    const objects = await rpc('schema.listObjects', { connectionId }, { timeoutMs: QUERY_TIMEOUT_MS })
    if (!getConnById(connectionId)) return
    state.schemaObjects[connectionId] = Array.isArray(objects) ? objects : []
    if (connectionId === state.activeConnectionId) {
      savePanelDataCache()
      const objs = state.schemaObjects[connectionId]
      const tabularObjs = objs.filter(
        (o) => !o.kind || o.kind === 'table' || o.kind === 'view' || o.kind === 'materialized_view'
      )
      const firstObj = tabularObjs.find((o) => o.kind === 'table') || tabularObjs[0] || objs[0]
      const matchedActive = state.activeTable
        ? tabularObjs.find((o) => o.name === state.activeTable && (!state.activeSchema || (o.schema || '') === state.activeSchema)) ||
          tabularObjs.find((o) => o.name === state.activeTable)
        : null
      if ((!state.activeTable || !matchedActive) && firstObj) {
        state.activeTable = firstObj.name
        state.activeSchema = firstObj.schema
        renderStructureTableSelect()
        syncPanelSqlSchema(connectionId)
        void prefetchPanelAutocompleteSchema(connectionId)
        renderDataToolbar()
        renderExplorer()
        await Promise.all([
          loadTablePage(connectionId, firstObj.name, 1, firstObj.schema),
          loadTableDetails(connectionId, firstObj.name, firstObj.schema),
        ])
      } else if (state.activeTable && matchedActive) {
        if (!state.activeSchema && matchedActive.schema) {
          state.activeSchema = matchedActive.schema
        }
        renderStructureTableSelect()
        syncPanelSqlSchema(connectionId)
        void prefetchPanelAutocompleteSchema(connectionId)
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
        state.activeSchema = undefined
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
        renderDataToolbar()
        renderDataGrid()
        renderStructure()
        renderValueInspector()
      }
    }
  } catch (err) {
    if (getConnById(connectionId)) {
      showBanner(err?.message || 'Failed to inspect schema', 'danger')
    }
  } finally {
    state.schemaLoading.delete(connectionId)
    renderExplorer()
    if (schemaRefreshPending.has(connectionId)) {
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
  cancelPendingDataAndSchemaLoads()
  resetSqlSafetyBannerDismissal()
  state.activeConnectionId = connectionId || null
  state.activeTable = null
  state.activeSchema = undefined
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
    if (cached && cached.length > 0) {
      const firstObj = cached.find((o) => o.kind === 'table') || cached[0]
      if (firstObj) {
        selectTableAndOpen(state.activeConnectionId, firstObj.name, firstObj.schema, false)
        return
      }
    }
    void loadSchema(state.activeConnectionId)
  }
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
  if (!isSilent) {
    renderDataGrid()
    syncDataControlsDisabled()
    renderStagingBar()
    const pager = $('dataPager')
    const pagerInfo = $('dataPagerInfo')
    const footer = $('dataFooter')
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
    showBanner(`Error loading ${table}: ${err?.message || err}`, 'danger')
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

function getOrderedVisibleColumns() {
  const pd = state.pageData
  if (!pd || !Array.isArray(pd.columns)) return []
  const tblKey = getActiveTableKey()
  const hiddenSet = getHiddenColsSet(tblKey)
  const pinnedSet = getPinnedColsSet(tblKey)
  const visible = pd.columns.filter((c) => !hiddenSet.has(c.name))
  const pinned = visible.filter((c) => pinnedSet.has(c.name))
  const unpinned = visible.filter((c) => !pinnedSet.has(c.name))
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
  const tableChanged =
    state.activeConnectionId !== connectionId ||
    state.activeTable !== tableName ||
    state.activeSchema !== schemaName
  if (state.activeConnectionId !== connectionId) {
    state.activeConnectionId = connectionId
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
  }
  state.activeTable = tableName
  state.activeSchema = schemaName
  state.sortCol = null
  state.whereClause = typeof options.whereClause === 'string' ? options.whereClause : ''
  state.orderByClause = ''
  $('dataWhereInput').value = state.whereClause
  $('dataOrderInput').value = ''
  $('clearFilterBtn').hidden = !state.whereClause

  if (!options.preserveSqlEditor) {
    const activeConn = getActiveConn()
    if (activeConn?.driver === 'redis') {
      setSqlText(
        tableName === '(root)' ? 'SCAN 0 MATCH * COUNT 50' : `SCAN 0 MATCH ${tableName} COUNT 50`,
        { skipSave: true }
      )
    } else {
      const qTable = quoteTableRef(tableName, schemaName, activeConn?.driver || 'sqlite')
      setSqlText(
        state.whereClause
          ? `SELECT * FROM ${qTable} WHERE ${state.whereClause} LIMIT 100;`
          : `SELECT * FROM ${qTable} LIMIT 100;`,
        { skipSave: true }
      )
    }
  }

  renderExplorer()
  renderStructureTableSelect()
  syncPanelSqlSchema(connectionId)
  renderDataToolbar()
  renderSqlSafetyBanner()
  savePanelViewState()
  if (state.activeConnectionId) {
    void loadTableDetails(state.activeConnectionId, tableName, schemaName)
    void loadTablePage(state.activeConnectionId, tableName, 1, schemaName)
  }
  if (switchToData) switchTab('data')
}

async function deleteConnectionById(id) {
  if (!id) return
  try {
    await rpc('connection.delete', { id })
    const prefix = `${id}:`
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
    state.expandedConns.delete(id)
    schemaRefreshPending.delete(id)
    delete state.schemaObjects[id]
    for (const mapObj of [
      state.tableDetails,
      state.tableDetailsErrors,
      state.columnWidthsByTable,
      state.hiddenColsByTable,
      state.pinnedColsByTable,
    ]) {
      if (!mapObj) continue
      for (const k of Object.keys(mapObj)) {
        if (k.startsWith(prefix)) delete mapObj[k]
      }
    }
    for (const k of Array.from(state.expandedTables)) {
      if (k.startsWith(prefix)) state.expandedTables.delete(k)
    }
    for (const k of Array.from(tableDetailsSeqByKey.keys())) {
      if (k.startsWith(prefix)) tableDetailsSeqByKey.delete(k)
    }
    if (state.structDraftKey && state.structDraftKey.startsWith(prefix)) {
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
    showBanner(err?.message || 'Delete failed', 'danger')
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
    const tbl = override?.table ?? state.activeTable
    const sch = override?.schema ?? state.activeSchema
    const res = await rpc(
      'studio.open',
      {
        ...(cid ? { connectionId: cid } : {}),
        ...(tbl ? { table: tbl } : {}),
        ...(sch ? { schema: sch } : {}),
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
  setFormDriver(
    activeDriver && ENGINE_BY_ID[activeDriver] ? activeDriver : 'sqlite',
    true
  )
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

function renderDataColsPopoverList() {
  const list = $('dataColsList')
  const pd = state.pageData
  if (!list || !pd) return
  list.textContent = ''
  const tblKey = getActiveTableKey()
  const hiddenSet = getHiddenColsSet(tblKey)
  const pinnedSet = getPinnedColsSet(tblKey)
  const q = ($('dataColsSearchInput')?.value || '').trim().toLowerCase()
  const cols = q
    ? pd.columns.filter((c) => c.name.toLowerCase().includes(q))
    : pd.columns
  for (const col of cols) {
    const row = document.createElement('div')
    row.className = 'col-popover-row'
    const lbl = document.createElement('label')
    lbl.className = 'col-popover-name'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = !hiddenSet.has(col.name)
    cb.addEventListener('change', () => toggleColumnHidden(col.name))
    const sp = document.createElement('span')
    sp.textContent = col.name
    lbl.append(cb, sp)

    const pinBtn = document.createElement('button')
    pinBtn.type = 'button'
    const isPinned = pinnedSet.has(col.name)
    pinBtn.className = `mini-btn${isPinned ? ' btn-active' : ''}`
    pinBtn.textContent = isPinned ? 'Unpin' : 'Pin'
    pinBtn.disabled = hiddenSet.has(col.name)
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleColumnPinned(col.name)
    })
    row.append(lbl, pinBtn)
    list.appendChild(row)
  }
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
  const tblName = $('createTableNameInput').value.trim()
  const errBox = $('createTableErrors')
  const previewEl = $('createTableDdlPreview')
  const execBtn = $('createTableExecuteBtn')
  try {
    const ddl = buildCreateTableSql(tblName, createTableDraftCols, driver, state.activeSchema)
    errBox.hidden = true
    errBox.textContent = ''
    previewEl.textContent = ddl
    execBtn.disabled = state.creatingTable
  } catch (err) {
    errBox.hidden = false
    errBox.textContent = err?.message || String(err)
    previewEl.textContent = '-- Fix validation errors above to preview CREATE TABLE SQL.'
    execBtn.disabled = true
  }
}

function renderCreateTableRows() {
  const tbody = $('createTableColsBody')
  if (!tbody) return
  tbody.textContent = ''
  for (const col of createTableDraftCols) {
    const tr = document.createElement('tr')

    const tdName = document.createElement('td')
    tdName.style.padding = '0'
    const nameInp = document.createElement('input')
    nameInp.type = 'text'
    nameInp.className = 'struct-cell-input'
    nameInp.value = col.name
    nameInp.placeholder = 'column_name'
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
    tdType.appendChild(typeWrap)

    const tdPk = document.createElement('td')
    tdPk.style.textAlign = 'center'
    const pkCb = document.createElement('input')
    pkCb.type = 'checkbox'
    pkCb.className = 'struct-checkbox'
    pkCb.checked = Boolean(col.isPrimaryKey)
    tdPk.appendChild(pkCb)

    const tdNull = document.createElement('td')
    tdNull.style.textAlign = 'center'
    const nullCb = document.createElement('input')
    nullCb.type = 'checkbox'
    nullCb.className = 'struct-checkbox'
    nullCb.checked = Boolean(col.nullable)
    nullCb.disabled = Boolean(col.isPrimaryKey)
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
  }
  updateCreateTablePreview()
}

function openCreateTableModal() {
  const conn = getActiveConn()
  if (!conn || conn.driver === 'redis') return
  if (conn.readOnly) {
    showBanner('Read-Only connection — cannot create tables.', 'danger')
    return
  }
  $('createTableDriverBadge').textContent = (ENGINE_BY_ID[conn.driver]?.label || conn.driver).toUpperCase()
  $('createTableNameInput').value = ''
  createTableDraftCols = [
    { id: `ct_${createTableColSeq++}`, name: 'id', dataType: 'INTEGER', isPrimaryKey: true, nullable: false, defaultValue: '' },
    { id: `ct_${createTableColSeq++}`, name: 'name', dataType: 'TEXT', isPrimaryKey: false, nullable: false, defaultValue: '' },
  ]
  setButtonLoading($('createTableExecuteBtn'), false)
  $('createTableCancelBtn').disabled = false
  renderCreateTableRows()
  $('createTableModal').hidden = false
  $('createTableNameInput').focus()
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
    showBanner('Read-Only connection — destructive table operations are disabled.', 'danger')
    return
  }
  pendingDangerTableOp = { action, conn, obj }
  const isDrop = action === 'drop'
  const kindLabel = obj.kind === 'view' ? 'View' : 'Table'
  const actionLabel = isDrop ? `Drop ${kindLabel}` : 'Truncate Table'
  $('dangerTableTitle').textContent = `${actionLabel} — ${obj.name}`
  $('dangerTableBadge').textContent = isDrop ? 'DROP' : 'TRUNCATE'
  $('dangerTableProdWarn').hidden = conn.colorTag !== 'prod'
  $('dangerTableDesc').textContent = isDrop
    ? `This permanently deletes ${kindLabel.toLowerCase()} "${obj.name}" and cannot be undone.`
    : `This permanently deletes all rows from "${obj.name}" while keeping the table schema.`
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
  getDimensions: () => ({
    rows: (dataVirt.active ? dataVirt.allRows : getAllDisplayRows()).length,
    cols: (dataVirt.active ? dataVirt.visCols : getOrderedVisibleColumns()).length,
  }),
  getSnapshot: () => {
    const allRows = dataVirt.active ? dataVirt.allRows : getAllDisplayRows()
    const visCols = dataVirt.active ? dataVirt.visCols : getOrderedVisibleColumns()
    return {
      rows: allRows.length,
      cols: visCols.length,
      getValue: (r, c) => {
        const entry = allRows[r]
        const col = visCols[c]
        if (!entry || !col) return null
        return getEffectiveCellValue(entry.rowKey, entry.data, col.name)
      },
    }
  },
  getValueAt: (r, c) => {
    const allRows = dataVirt.active ? dataVirt.allRows : getAllDisplayRows()
    const visCols = dataVirt.active ? dataVirt.visCols : getOrderedVisibleColumns()
    const entry = allRows[r]
    const col = visCols[c]
    if (!entry || !col) return null
    return getEffectiveCellValue(entry.rowKey, entry.data, col.name)
  },
  onSelectionChange: (sel) => {
    if (sel.focus) {
      const allRows = dataVirt.active ? dataVirt.allRows : getAllDisplayRows()
      const visCols = dataVirt.active ? dataVirt.visCols : getOrderedVisibleColumns()
      const entry = allRows[sel.focus.r]
      const col = visCols[sel.focus.c]
      state.selectedRowKey = entry?.rowKey || null
      state.selectedCol = col?.name || null
    } else {
      state.selectedRowKey = null
      state.selectedCol = null
    }
    if (state.transposed) {
      updateGridSelectionHighlight()
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
  onEnsureCellVisible: (r) => {
    ensureDataVirtualRowVisible(r)
  },
  onStartEdit: (r, c) => {
    ensureDataVirtualRowVisible(r)
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
  state.selectedRowKey = rowKey
  state.selectedCol = colName
  updateGridSelectionHighlight()
  renderStagingBar()
  renderValueInspector()
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
const dataGridWrapEl = $('dataGridWrap')
if (dataGridWrapEl) {
  dataGridWrapEl.addEventListener('scroll', () => {
    if (!dataVirt.active || state.transposed) return
    const total = dataVirt.allRows.length
    if (total === 0) return
    const { start, end } = computeVirtualRange(dataGridWrapEl.scrollTop, dataGridWrapEl.clientHeight, total)
    if (start === dataVirt.start && end === dataVirt.end) return
    if (dataVirt.rafId !== null) return
    const run = () => {
      dataVirt.rafId = null
      renderDataVirtualWindow(false)
    }
    if (typeof requestAnimationFrame === 'function') {
      dataVirt.rafId = requestAnimationFrame(run)
    } else {
      run()
    }
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
    if (sqlVirt.rafId !== null) return
    const run = () => {
      sqlVirt.rafId = null
      renderSqlVirtualWindow(false)
    }
    if (typeof requestAnimationFrame === 'function') {
      sqlVirt.rafId = requestAnimationFrame(run)
    } else {
      run()
    }
  }, { passive: true })
}

let gridResizeObserver = null
if (typeof ResizeObserver !== 'undefined') {
  gridResizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === dataGridWrapEl && dataVirt.active && !state.transposed) {
        renderDataVirtualWindow(false)
      } else if (entry.target === sqlResultWrapEl && sqlVirt.active) {
        renderSqlVirtualWindow(false)
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

$('parseUriBtn').addEventListener('click', () => void handleParseUri())
$('uriInput').addEventListener('paste', (e) => {
  const pasted = e.clipboardData?.getData('text')
  if (pasted) {
    setTimeout(() => void handleParseUri($('uriInput').value || pasted), 0)
  }
})
$('uriInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
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

$('testFormBtn').addEventListener('click', async () => {
  if (state.formBusy) return
  state.formBusy = true
  setFormControlsBusy(true)
  const testBtn = $('testFormBtn')
  setButtonLoading(testBtn, true, 'Testing... 0.0s')
  const stopTimer = createElapsedTimer((elapsed) => {
    updateButtonLoadingLabel(testBtn, `Testing... ${elapsed}`)
  })
  try {
    if (!(await ensureUriParsedBeforeAction())) return
    const targetId = state.editingId || `conn_test_${Date.now()}`
    if (!ensureRequiredPasswordBeforeSubmit(state.editingId || state.sourceSecretConnId || '')) return
    showFormNotice('Testing connection...', 'neutral')
    const sub = buildFormSubmission(targetId)
    const res = await rpc('connection.test', sub, { timeoutMs: QUERY_TIMEOUT_MS })
    showFormNotice(res?.message || (res?.ok ? 'Connection verified successfully!' : 'Connection test failed.'), res?.ok ? 'success' : 'danger')
  } catch (err) {
    showFormNotice(`Error: ${err?.message || err}`, 'danger')
  } finally {
    stopTimer()
    setButtonLoading(testBtn, false)
    state.formBusy = false
    setFormControlsBusy(false)
  }
})

$('saveFormBtn').addEventListener('click', async () => {
  if (state.formBusy) return
  state.formBusy = true
  setFormControlsBusy(true)
  const saveBtn = $('saveFormBtn')
  let savePhase = 'Testing...'
  setButtonLoading(saveBtn, true, 'Testing... 0.0s')
  const stopTimer = createElapsedTimer((elapsed) => {
    updateButtonLoadingLabel(saveBtn, `${savePhase} ${elapsed}`)
  })
  try {
    if (!(await ensureUriParsedBeforeAction())) return
    if (state.formDriver === 'sqlite' && !$('formFilePath').value.trim()) {
      showFormNotice('Please enter a SQLite database file or folder path.', 'danger')
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
      const testRes = await rpc('connection.test', sub, { timeoutMs: QUERY_TIMEOUT_MS })
      if (testRes && testRes.ok === false) {
        showFormNotice(testRes.message || 'Connection test failed.', 'danger')
        return
      }
    } catch (testErr) {
      showFormNotice(`Connection failed: ${testErr?.message || testErr}`, 'danger')
      return
    }
    savePhase = 'Saving...'
    updateButtonLoadingLabel(saveBtn, 'Saving...')
    const res = await rpc('connection.save', sub, { timeoutMs: QUERY_TIMEOUT_MS })
    if (res?.ok) {
      const savedId = res.id || targetId
      cancelPendingDataAndSchemaLoads()
      resetSqlSafetyBannerDismissal()
      setFormOpen(false)
      state.activeConnectionId = savedId
      void persistActiveConnectionId(savedId)
      state.expandedConns.add(savedId)
      delete state.schemaObjects[savedId]
      state.activeTable = null
      state.activeSchema = undefined
      state.pageData = null
      state.page = 1
      state.sortCol = null
      dataVirt.active = false
      clearStagedChanges()
      savePanelViewState()
      await refreshConnections()
      showBanner(`Connected to ${sub.profile.name}`, 'success')
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
    const res = await rpc('connection.test', { profile: active }, { timeoutMs: QUERY_TIMEOUT_MS })
    if (state.activeConnectionId === targetConnId) {
      showBanner(res?.message || (res?.ok ? 'Connected' : 'Failed'), res?.ok ? 'success' : 'danger')
    }
  } catch (err) {
    if (state.activeConnectionId === targetConnId) {
      showBanner(err?.message || 'Test failed', 'danger')
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
  renderDataGrid()
  renderDataColsPopoverList()
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
    ddl = buildCreateTableSql(tblName, createTableDraftCols, conn.driver, state.activeSchema)
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
  try {
    await rpc('query.run', { connectionId: targetConnId, queryId: `panel_create_${Date.now()}`, sql: ddl }, { timeoutMs: QUERY_TIMEOUT_MS })
    stopTimer()
    state.creatingTable = false
    setButtonLoading(execBtn, false)
    if (cancelBtn) cancelBtn.disabled = false
    closeCreateTableModal(true)
    showBanner(`Created table "${tblName}"`, 'success')
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
    showBanner('Read-Only connection — blocked.', 'danger')
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
  savePanelViewState()
  renderDataGrid()
})

$('editTableStructureBtn')?.addEventListener('click', () => {
  switchTab('structure')
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
      showBanner(err?.message || 'Failed to preview DML', 'danger')
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
      showBanner(`Committed: +${res.inserted || 0} / ~${res.updated || 0} / -${res.deleted || 0}`, 'success')
      if (
        state.activeConnectionId === targetConnId &&
        state.activeTable === targetTable &&
        (state.activeSchema || '') === (targetSchema || '')
      ) {
        await loadTablePage(targetConnId, targetTable, targetPage, targetSchema)
      }
    } else {
      showBanner('Batch commit rejected', 'danger')
    }
  } catch (err) {
    showBanner(`Commit failed: ${err?.message || err}`, 'danger')
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
$('closeInspectorBtn').addEventListener('click', () => {
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
    inp.value = JSON.stringify(JSON.parse(inp.value.trim()), null, 2)
    inspectorUserModified = true
    updateInspectorMetaAndJson()
  } catch {}
})
$('inspectorMinifyJsonBtn')?.addEventListener('click', () => {
  const inp = $('valueInspectorText')
  try {
    inp.value = JSON.stringify(JSON.parse(inp.value.trim()))
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
})

// Capture-phase Escape: dismiss overlays/popovers/modals before PanelGridSelection clears cell selection
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (document.querySelector('.panel-fp-backdrop')) return
  const activeEl = document.activeElement
  if (activeEl instanceof HTMLInputElement && activeEl.classList.contains('cell-edit-input')) {
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
      if (payload?.colorScheme) {
        const isLight = payload.colorScheme === 'light'
        const isDark = payload.colorScheme === 'dark'
        document.documentElement.classList.toggle('light', isLight)
        document.documentElement.classList.toggle('dark', isDark)
        document.body?.classList.toggle('light', isLight)
        document.body?.classList.toggle('dark', isDark)
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
    trackOrcaDisposable(window.orca.plugin.on('connections.changed', () => void refreshConnections()))
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
  } catch {}
}

window.addEventListener('beforeunload', () => {
  flushPendingSavePanelViewState()
  savePanelDataCache()
})

window.addEventListener('pagehide', () => {
  closeActiveCustomDropdown()
  flushPendingSavePanelViewState()
  savePanelDataCache()
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
  dataGridSel?.destroy?.()
  sqlGridSel?.destroy?.()
  destroySqlEditor()
  while (orcaDisposables.length > 0) {
    const d = orcaDisposables.pop()
    try {
      if (typeof d === 'function') d()
      else if (d && typeof d.dispose === 'function') d.dispose()
    } catch {}
  }
})

restorePanelViewStateFromLocal()
bindSelectTooltipsInRoot(document)
syncThemeFromTokens()
setSqlColorScheme(document.documentElement.classList.contains('light'))
updateViewportLayout()
restorePanelWarmCacheFromLocal()
void syncOrcaTypography()
void refreshConnections({ isBoot: true })
