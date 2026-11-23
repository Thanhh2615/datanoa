// src/panel/panel-sql.js
// Side Panel CodeMirror SQL Console, Console Tabs, Multi-Result Tabs, Multi-EXPLAIN,
// virtualized SQL Result Grid, export, and Query History

import {
  splitSqlStatements,
  panelContainsDdlStatement,
  findStatementAtOffset,
  formatExportData,
  formatSelectionAsOutput,
  formatRelativeTime,
} from './panel-core.js'
import {
  PANEL_SQL_EDITOR_MIN_HEIGHT,
  PANEL_SQL_EDITOR_DEFAULT_HEIGHT,
  PANEL_SQL_EDITOR_HARD_MAX_HEIGHT,
  clampPanelSqlEditorHeight,
  computePanelSqlEditorBounds,
  createPanelConsoleTabsManager,
} from './panel-sql-tabs.js'
import { createPanelCodeMirrorEditor } from './panel-cm.js'
import {
  getEffectiveResultSets,
  getDefaultResultSetIndex,
  buildSingleSetQueryResult,
  buildInitialPanelResultStates,
  buildCombinedExplainResult,
  buildErrorQueryResult,
  compactSqlPreview,
} from './panel-result-sets.js'
import {
  $,
  setDbLogoElement,
  rpc,
  setButtonLoading,
  createElapsedTimer,
  downloadTextFile,
  createSortSvg,
  syncVirtualTableWindow,
} from './panel-utils.js'

const DEFAULT_PANEL_SQL = 'SELECT * FROM sqlite_master LIMIT 25;'

export function createPanelSqlController(ctx) {
  const {
    state,
    QUERY_TIMEOUT_MS,
    VIRT_ROW_HEIGHT_PX,
    getActiveConn,
    getConnById,
    getSqlGridSel,
    getSuppressSortClickUntil,
    setLastPanelCopiedText,
    computeVirtualRange,
    attachColumnResizeHandle,
    copyText,
    showBanner,
    loadSchema,
    savePanelViewState,
    scheduleSavePanelViewState,
    savePanelDataCache,
    onFormatSql,
  } = ctx

  let sqlRunSeq = 0
  let cancelledSqlRunSeq = 0
  let historySeq = 0
  let sqlStopTimer = null
  let sortedSqlRowsCache = { res: null, colIdx: null, dir: 'ASC', rows: [] }
  let dismissedSqlBannerKey = null
  let activeSqlBannerKey = null
  let lastSqlBannerConnId = null
  let suppressCmSync = false
  let currentSchemaMap = {}
  let currentSchemaTable = undefined

  let consoleTabs = createPanelConsoleTabsManager(DEFAULT_PANEL_SQL)

  const sqlVirt = {
    active: false,
    columns: [],
    sortedRows: [],
    tbody: null,
    topSpacerTr: null,
    topSpacerTd: null,
    bottomSpacerTr: null,
    bottomSpacerTd: null,
    start: -1,
    end: -1,
    rafId: null,
  }

  const mountEl = $('sqlEditorMount')
  const resizerEl = $('sqlEditorResizer')
  let customSqlEditorHeight = null
  let activeResizerCleanup = null
  let cmEditor = null
  if (mountEl) {
    try {
      cmEditor = createPanelCodeMirrorEditor({
        parent: mountEl,
        initialDoc: DEFAULT_PANEL_SQL,
        dialect: getActiveConn()?.driver || 'sqlite',
        schema: currentSchemaMap,
        isLightTheme: Boolean(
          typeof document !== 'undefined' &&
            (document.documentElement.classList.contains('light') ||
              document.body?.classList.contains('light'))
        ),
        onExecute: () => void runSql('caret'),
        onExecuteAll: () => void runSql('all'),
        onFormatSql: () => onFormatSql?.(),
        onChange: (doc) => {
          if (suppressCmSync) return
          consoleTabs.updateActiveSql(doc, cmEditor?.getCursorOffset?.())
          scheduleSavePanelViewState?.(350)
        },
      })
    } catch {
      cmEditor = null
    }
  }

  function getSqlContainerHeight() {
    const tabSql = $('tabSql')
    if (!tabSql) return 0
    const rectH = tabSql.getBoundingClientRect?.().height
    if (Number.isFinite(rectH) && rectH > 0) return rectH
    return Number(tabSql.clientHeight) || 0
  }

  function applySqlEditorHeight(desiredPx, { persist = false, preservePreferred = false } = {}) {
    if (!mountEl) return PANEL_SQL_EDITOR_DEFAULT_HEIGHT
    const parsed = Number(desiredPx)
    const preferredClamped = Number.isFinite(parsed)
      ? Math.max(
          PANEL_SQL_EDITOR_MIN_HEIGHT,
          Math.min(PANEL_SQL_EDITOR_HARD_MAX_HEIGHT, Math.round(parsed))
        )
      : PANEL_SQL_EDITOR_DEFAULT_HEIGHT
    const containerH = getSqlContainerHeight()
    const bounds = computePanelSqlEditorBounds(containerH)
    const clamped = clampPanelSqlEditorHeight(preferredClamped, containerH)
    if (!preservePreferred) {
      customSqlEditorHeight = containerH > 0 ? clamped : preferredClamped
    }
    mountEl.style.height = `${clamped}px`
    if (resizerEl) {
      resizerEl.setAttribute('aria-valuemin', String(bounds.min))
      resizerEl.setAttribute('aria-valuemax', String(bounds.max))
      resizerEl.setAttribute('aria-valuenow', String(clamped))
    }
    cmEditor?.view?.requestMeasure?.()
    if (persist) {
      scheduleSavePanelViewState?.(150)
    }
    return clamped
  }

  function applyClampedSqlEditorHeight() {
    if (customSqlEditorHeight === null) {
      if (resizerEl) {
        const bounds = computePanelSqlEditorBounds(getSqlContainerHeight())
        resizerEl.setAttribute('aria-valuemin', String(bounds.min))
        resizerEl.setAttribute('aria-valuemax', String(bounds.max))
      }
      return
    }
    applySqlEditorHeight(customSqlEditorHeight, { persist: false, preservePreferred: true })
  }

  function setSqlEditorHeight(heightPx, { persist = false } = {}) {
    if (!Number.isFinite(Number(heightPx))) return null
    return applySqlEditorHeight(Number(heightPx), { persist })
  }

  function getSqlEditorHeight() {
    return customSqlEditorHeight
  }

  if (mountEl && resizerEl && typeof window !== 'undefined') {
    let activeDrag = null
    const stopDrag = (shouldPersist) => {
      if (!activeDrag) return
      const { kind, onMove, onEnd } = activeDrag
      activeDrag = null
      if (kind === 'pointer') {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onEnd)
        window.removeEventListener('pointercancel', onEnd)
      } else {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onEnd)
      }
      window.removeEventListener('blur', onEnd)
      resizerEl.classList.remove('is-resizing')
      if (document.body) {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      if (shouldPersist) {
        scheduleSavePanelViewState?.(150)
      }
    }

    const startDrag = (e) => {
      if (e.button !== undefined && e.button !== 0) return
      if (activeDrag) return
      e.preventDefault()
      const kind = e.type === 'pointerdown' ? 'pointer' : 'mouse'
      const startY = Number(e.clientY) || 0
      const rectH = mountEl.getBoundingClientRect?.().height
      const startH =
        Number.isFinite(rectH) && rectH > 0
          ? rectH
          : clampPanelSqlEditorHeight(
              customSqlEditorHeight ?? PANEL_SQL_EDITOR_DEFAULT_HEIGHT,
              getSqlContainerHeight()
            )

      resizerEl.classList.add('is-resizing')
      if (document.body) {
        document.body.style.cursor = 'row-resize'
        document.body.style.userSelect = 'none'
      }

      const onMove = (moveEv) => {
        const dy = (Number(moveEv.clientY) || 0) - startY
        applySqlEditorHeight(startH + dy, { persist: false })
      }
      const onEnd = () => stopDrag(true)
      activeDrag = { kind, onMove, onEnd }
      if (kind === 'pointer') {
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onEnd)
        window.addEventListener('pointercancel', onEnd)
      } else {
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onEnd)
      }
      window.addEventListener('blur', onEnd)
    }

    const onDblClick = () => {
      applySqlEditorHeight(PANEL_SQL_EDITOR_DEFAULT_HEIGHT, { persist: true })
    }

    const onKeyDown = (e) => {
      const containerH = getSqlContainerHeight()
      const bounds = computePanelSqlEditorBounds(containerH)
      const rectH = mountEl.getBoundingClientRect?.().height
      const currentH =
        Number.isFinite(rectH) && rectH > 0
          ? Math.round(rectH)
          : clampPanelSqlEditorHeight(
              customSqlEditorHeight ?? PANEL_SQL_EDITOR_DEFAULT_HEIGHT,
              containerH
            )
      let targetH = null
      if (e.key === 'ArrowDown') targetH = currentH + 24
      else if (e.key === 'ArrowUp') targetH = currentH - 24
      else if (e.key === 'Home') targetH = bounds.min
      else if (e.key === 'End') targetH = bounds.max
      else if (e.key === 'Enter' || e.key === ' ') targetH = PANEL_SQL_EDITOR_DEFAULT_HEIGHT
      if (targetH === null) return
      e.preventDefault()
      applySqlEditorHeight(targetH, { persist: true })
    }

    const onWindowResize = () => applyClampedSqlEditorHeight()
    resizerEl.addEventListener('pointerdown', startDrag)
    resizerEl.addEventListener('mousedown', startDrag)
    resizerEl.addEventListener('dblclick', onDblClick)
    resizerEl.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onWindowResize)

    activeResizerCleanup = () => {
      stopDrag(false)
      resizerEl.removeEventListener('pointerdown', startDrag)
      resizerEl.removeEventListener('mousedown', startDrag)
      resizerEl.removeEventListener('dblclick', onDblClick)
      resizerEl.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onWindowResize)
    }
  }

  function getSqlText() {
    if (cmEditor) return cmEditor.getValue()
    return consoleTabs.getActiveTab()?.sql ?? ''
  }

  function setSqlText(nextSql, opts = {}) {
    const val = String(nextSql ?? '')
    consoleTabs.updateActiveSql(val)
    if (cmEditor) {
      suppressCmSync = true
      try {
        cmEditor.setValue(val)
        if (typeof opts.cursorOffset === 'number') {
          cmEditor.setCursorOffset(opts.cursorOffset)
        }
      } finally {
        suppressCmSync = false
      }
    }
    if (!opts.skipSave) {
      savePanelViewState?.()
    }
    if (opts.focus) {
      focusSqlEditor()
    }
  }

  function focusSqlEditor() {
    cmEditor?.focus?.()
  }

  function setSqlDialect(driver) {
    cmEditor?.setDialect?.(driver || 'sqlite')
  }

  function setSqlSchema(schemaMap, activeTable) {
    currentSchemaMap = schemaMap && typeof schemaMap === 'object' ? schemaMap : {}
    currentSchemaTable = activeTable || undefined
    cmEditor?.setSchema?.(currentSchemaMap, currentSchemaTable)
  }

  function setSqlColorScheme(isLight) {
    cmEditor?.setColorScheme?.(Boolean(isLight))
  }

  function setSqlTypography(typo) {
    cmEditor?.setTypography?.(typo)
  }

  function openSqlFindReplace() {
    cmEditor?.openFindReplace?.()
  }

  function destroySqlEditor() {
    if (activeResizerCleanup) {
      activeResizerCleanup()
      activeResizerCleanup = null
    }
    cmEditor?.destroy?.()
    cmEditor = null
  }

  function resetSqlSafetyBannerDismissal() {
    dismissedSqlBannerKey = null
  }

  function dismissSqlSafetyBanner() {
    if (activeSqlBannerKey) {
      dismissedSqlBannerKey = activeSqlBannerKey
    }
    const banner = $('sqlProdBanner')
    if (banner) banner.hidden = true
  }

  function renderSqlSafetyBanner() {
    const conn = getActiveConn()
    const banner = $('sqlProdBanner')
    const connId = conn?.id || null
    if (connId !== lastSqlBannerConnId) {
      lastSqlBannerConnId = connId
      dismissedSqlBannerKey = null
    }
    if (!conn) {
      activeSqlBannerKey = null
      if (banner) banner.hidden = true
      return
    }
    let kind = null
    let cls = 'banner warn'
    let msg = ''
    if (conn.readOnly && conn.colorTag === 'prod') {
      kind = 'prod-ro'
      cls = 'banner danger'
      msg = 'PROD + READ-ONLY — Mutating SQL/Redis statements are blocked by worker policy.'
    } else if (conn.colorTag === 'prod') {
      kind = 'prod'
      cls = 'banner danger'
      msg = 'PROD environment — review statements carefully before executing.'
    } else if (conn.readOnly) {
      kind = 'ro'
      cls = 'banner warn'
      msg = 'READ-ONLY connection — INSERT, UPDATE, DELETE, and DDL commands are blocked.'
    }

    const bannerKey = kind ? `${conn.id}:${kind}` : null
    activeSqlBannerKey = bannerKey

    if (banner) {
      if (!bannerKey) {
        banner.hidden = true
      } else {
        banner.className = cls
        const textEl = $('sqlProdBannerText')
        if (textEl) textEl.textContent = msg
        banner.hidden = dismissedSqlBannerKey === bannerKey
      }
    }

    cmEditor?.setPlaceholder?.(
      conn.driver === 'redis'
        ? 'SCAN 0 MATCH * COUNT 50'
        : 'SELECT * FROM table_name LIMIT 25;'
    )
    setSqlDialect(conn.driver || 'sqlite')
  }

  function renderConsoleTabs() {
    const bar = $('sqlConsoleTabsBar')
    if (!bar) return
    const tabs = consoleTabs.getTabs()
    const activeId = consoleTabs.getActiveTabId()
    bar.textContent = ''

    tabs.forEach((tab) => {
      const tabEl = document.createElement('div')
      tabEl.className = `sql-console-tab${tab.id === activeId ? ' active' : ''}`
      tabEl.setAttribute('role', 'tab')
      tabEl.setAttribute('aria-selected', String(tab.id === activeId))
      tabEl.tabIndex = 0

      const titleSpan = document.createElement('span')
      titleSpan.className = 'sql-console-tab-title'
      titleSpan.textContent = tab.title
      titleSpan.title = `${tab.title} (Double-click or press F2 to rename)`

      const startRename = (e) => {
        e.stopPropagation()
        if (tabEl.querySelector('.sql-console-tab-rename')) return
        const input = document.createElement('input')
        input.type = 'text'
        input.className = 'sql-console-tab-rename'
        input.value = tab.title
        input.maxLength = 40
        titleSpan.replaceWith(input)
        let committed = false
        const commit = () => {
          if (committed) return
          committed = true
          if (input.value.trim()) {
            consoleTabs.renameTab(tab.id, input.value)
            savePanelViewState?.()
          }
          renderConsoleTabs()
        }
        input.addEventListener('blur', commit)
        input.addEventListener('keydown', (ke) => {
          if (ke.key === 'Enter') {
            ke.preventDefault()
            commit()
          } else if (ke.key === 'Escape') {
            committed = true
            renderConsoleTabs()
          }
        })
        input.focus()
        input.select()
      }

      tabEl.addEventListener('click', () => switchConsoleTab(tab.id))
      tabEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          switchConsoleTab(tab.id)
        } else if (e.key === 'F2') {
          startRename(e)
        }
      })
      titleSpan.addEventListener('dblclick', startRename)
      tabEl.appendChild(titleSpan)

      if (tabs.length > 1) {
        const closeBtn = document.createElement('button')
        closeBtn.type = 'button'
        closeBtn.className = 'sql-console-tab-close'
        closeBtn.textContent = '×'
        closeBtn.title = `Close ${tab.title}`
        closeBtn.setAttribute('aria-label', `Close ${tab.title}`)
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          closeConsoleTab(tab.id)
        })
        tabEl.appendChild(closeBtn)
      }

      bar.appendChild(tabEl)
    })

    const addBtn = document.createElement('button')
    addBtn.type = 'button'
    addBtn.className = 'sql-console-tab-add'
    addBtn.textContent = '+'
    addBtn.title = 'New SQL Console Tab'
    addBtn.setAttribute('aria-label', 'New SQL Console Tab')
    addBtn.addEventListener('click', () => addConsoleTab())
    bar.appendChild(addBtn)
  }

  function saveActiveConsoleTabState() {
    if (cmEditor) {
      consoleTabs.updateActiveSql(cmEditor.getValue(), cmEditor.getCursorOffset())
    }
    captureActiveResultTabState()
  }

  function captureActiveResultTabState() {
    const activeTab = consoleTabs.getActiveTab()
    if (!activeTab?.lastResult) return
    const idx = activeTab.activeResultSetIndex || 0
    const curState = consoleTabs.getResultTabState(idx, activeTab.id)
    if (!curState) return
    curState.sortColIdx = state.sqlSortColIdx ?? null
    curState.sortDir = state.sqlSortDir || 'ASC'
    curState.colWidths = Array.isArray(state.sqlColWidths) ? [...state.sqlColWidths] : []
    curState.scrollTop = $('sqlResultWrap')?.scrollTop ?? curState.scrollTop ?? 0
    consoleTabs.setResultTabState(idx, curState, activeTab.id)
  }

  function loadActiveConsoleTabEditor() {
    const tab = consoleTabs.getActiveTab()
    suppressCmSync = true
    try {
      if (cmEditor) {
        cmEditor.setValue(tab.sql || '')
        cmEditor.setCursorOffset(tab.cursorOffset ?? 0)
      }
    } finally {
      suppressCmSync = false
    }
    renderConsoleTabs()
  }

  function clearSqlResultDisplay() {
    state.lastSqlResult = null
    state.sqlSortColIdx = null
    state.sqlSortDir = 'ASC'
    state.sqlColWidths = []
    sortedSqlRowsCache = { res: null, colIdx: null, dir: 'ASC', rows: [] }
    sqlVirt.active = false
    getSqlGridSel()?.clear(true)
    const bar = $('sqlResultSetsBar')
    if (bar) {
      bar.hidden = true
      bar.textContent = ''
    }
    if ($('sqlSuccessBanner')) $('sqlSuccessBanner').hidden = true
    if ($('sqlErrorBanner')) $('sqlErrorBanner').hidden = true
    if ($('sqlMetaBadge')) $('sqlMetaBadge').hidden = true
    if ($('sqlResultWrap')) $('sqlResultWrap').hidden = true
    if ($('sqlResultMeta')) $('sqlResultMeta').hidden = true
  }

  function renderResultSetsBar(tab) {
    const bar = $('sqlResultSetsBar')
    if (!bar) return
    const sets = tab?.lastResult?.resultSets
    if (!sets || sets.length <= 1) {
      bar.hidden = true
      bar.textContent = ''
      return
    }
    const activeIdx = tab.activeResultSetIndex || 0
    bar.hidden = false
    bar.textContent = ''
    sets.forEach((rs, idx) => {
      const rsState = tab.resultStates?.[idx]
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `sql-result-tab${idx === activeIdx ? ' active' : ''}${rs.isError ? ' is-error' : ''}`
      btn.setAttribute('role', 'tab')
      btn.setAttribute('aria-selected', String(idx === activeIdx))
      btn.title = rsState?.statementSql || rs.sql || rs.sqlPreview || ''
      if (rs.isError) {
        btn.textContent = `Result ${idx + 1} · Error`
      } else if (rsState?.isExplain) {
        const n = rs.rowCount ?? rs.rows?.length ?? 0
        btn.textContent = `Result ${idx + 1} · ${n} ${n === 1 ? 'step' : 'steps'}`
      } else if (rs.isSelect) {
        const n = rs.rowCount ?? rs.rows?.length ?? 0
        btn.textContent = `Result ${idx + 1} · ${n} ${n === 1 ? 'row' : 'rows'}`
      } else {
        btn.textContent = `Result ${idx + 1} · ${rs.affectedRows ?? 0} affected`
      }
      btn.addEventListener('click', () => selectPanelResultSetIndex(idx))
      bar.appendChild(btn)
    })
  }

  function applyBannerForResultTab(rsState) {
    const meta = $('sqlMetaBadge')
    const okBanner = $('sqlSuccessBanner')
    const okText = $('sqlSuccessText')
    const okDetail = $('sqlSuccessDetail')
    const errBanner = $('sqlErrorBanner')
    const errText = $('sqlErrorText')
    const scopeLbl = $('sqlResultScopeLabel')
    const b = rsState?.banner
    if (!b) {
      if (meta) meta.hidden = true
      if (okBanner) okBanner.hidden = true
      if (errBanner) errBanner.hidden = true
      return
    }
    if (meta) {
      meta.className = b.badgeClass || 'badge badge-ok'
      meta.textContent = b.badgeText || ''
      meta.hidden = !b.dismissed
    }
    if (scopeLbl && b.scopeLabel) {
      scopeLbl.textContent = b.scopeLabel
    }
    if (b.kind === 'error') {
      if (okBanner) okBanner.hidden = true
      if (errText) {
        errText.textContent = b.detail ? `${b.text}\n${b.detail}` : b.text
      }
      if (errBanner) errBanner.hidden = Boolean(b.dismissed)
      state.lastError = b.text
    } else {
      if (errBanner) errBanner.hidden = true
      if (okText) okText.textContent = b.text || ''
      if (okDetail) {
        const detailStr = b.detail || ''
        okDetail.textContent = detailStr
        okDetail.hidden = !detailStr
      }
      if (okBanner) okBanner.hidden = Boolean(b.dismissed)
    }
  }

  function applyPanelResultTab(index, tab, opts = {}) {
    if (!tab?.lastResult) {
      clearSqlResultDisplay()
      return
    }
    const sets = getEffectiveResultSets(tab.lastResult, tab.executedSql || '')
    const clampedIdx = Math.max(0, Math.min(index, Math.max(0, sets.length - 1)))
    tab.activeResultSetIndex = clampedIdx
    const rsState =
      tab.resultStates?.[clampedIdx] ||
      buildInitialPanelResultStates(
        tab.lastResult,
        [],
        tab.executedSql || '',
        tab.lastResult.executionTimeMs || 0,
        tab.lastResultMode || 'query'
      )[clampedIdx]
    if (!tab.resultStates) tab.resultStates = {}
    if (rsState && !tab.resultStates[clampedIdx]) {
      tab.resultStates[clampedIdx] = rsState
    }

    const singleRes = buildSingleSetQueryResult(tab.lastResult, clampedIdx)
    state.lastSqlResult = singleRes?.isError ? null : singleRes
    state.sqlSortColIdx = rsState?.sortColIdx ?? null
    state.sqlSortDir = rsState?.sortDir || 'ASC'
    state.sqlColWidths = Array.isArray(rsState?.colWidths) ? [...rsState.colWidths] : []
    sortedSqlRowsCache = { res: null, colIdx: null, dir: 'ASC', rows: [] }
    getSqlGridSel()?.clear(true)

    renderResultSetsBar(tab)
    applyBannerForResultTab(rsState)
    renderSqlResultTableOnly()

    const wrap = $('sqlResultWrap')
    if (wrap && !opts.preserveScroll) {
      wrap.scrollTop = rsState?.scrollTop ?? 0
    }
  }

  function selectPanelResultSetIndex(index) {
    const tab = consoleTabs.getActiveTab()
    if (!tab?.lastResult) return
    const sets = tab.lastResult.resultSets
    if (!sets || index < 0 || index >= sets.length) return
    if (index === tab.activeResultSetIndex) return
    captureActiveResultTabState()
    applyPanelResultTab(index, tab)
  }

  function restoreActiveConsoleTabResult() {
    const tab = consoleTabs.getActiveTab()
    if (!tab?.lastResult) {
      clearSqlResultDisplay()
      return
    }
    applyPanelResultTab(tab.activeResultSetIndex || 0, tab, { preserveScroll: true })
  }

  function switchConsoleTab(tabId) {
    if (tabId === consoleTabs.getActiveTabId()) return
    saveActiveConsoleTabState()
    if (!consoleTabs.switchTab(tabId)) return
    loadActiveConsoleTabEditor()
    restoreActiveConsoleTabResult()
    savePanelViewState?.()
  }

  function addConsoleTab() {
    saveActiveConsoleTabState()
    consoleTabs.addTab('')
    loadActiveConsoleTabEditor()
    clearSqlResultDisplay()
    savePanelViewState?.()
    focusSqlEditor()
  }

  function closeConsoleTab(tabId) {
    saveActiveConsoleTabState()
    if (!consoleTabs.closeTab(tabId)) return
    loadActiveConsoleTabEditor()
    restoreActiveConsoleTabResult()
    savePanelViewState?.()
  }

  function restoreConsoleTabsState(persistedTabs, fallbackDraft = '') {
    if (persistedTabs && Array.isArray(persistedTabs.tabs) && persistedTabs.tabs.length > 0) {
      consoleTabs = createPanelConsoleTabsManager(persistedTabs)
    } else if (typeof fallbackDraft === 'string' && fallbackDraft.trim()) {
      consoleTabs = createPanelConsoleTabsManager(fallbackDraft)
    } else {
      consoleTabs = createPanelConsoleTabsManager(DEFAULT_PANEL_SQL)
    }
    loadActiveConsoleTabEditor()
    restoreActiveConsoleTabResult()
  }

  function getConsoleTabsPersistedState(isSensitiveFn) {
    if (cmEditor) {
      consoleTabs.updateActiveSql(cmEditor.getValue(), cmEditor.getCursorOffset())
    }
    return consoleTabs.toPersistedState(isSensitiveFn)
  }

  function dismissActiveSqlSuccessBanner() {
    const tab = consoleTabs.getActiveTab()
    const rsState = consoleTabs.getResultTabState(tab?.activeResultSetIndex || 0, tab?.id)
    if (rsState?.banner) rsState.banner.dismissed = true
    if ($('sqlSuccessBanner')) $('sqlSuccessBanner').hidden = true
    if ($('sqlMetaBadge') && rsState?.banner?.badgeText) $('sqlMetaBadge').hidden = false
  }

  function dismissActiveSqlErrorBanner() {
    const tab = consoleTabs.getActiveTab()
    const rsState = consoleTabs.getResultTabState(tab?.activeResultSetIndex || 0, tab?.id)
    if (rsState?.banner) rsState.banner.dismissed = true
    if ($('sqlErrorBanner')) $('sqlErrorBanner').hidden = true
    if ($('sqlMetaBadge') && rsState?.banner?.badgeText) $('sqlMetaBadge').hidden = false
  }

  function getSortedSqlRows() {
    const res = state.lastSqlResult
    if (!res || !Array.isArray(res.rows)) return []
    if (
      sortedSqlRowsCache.res === res &&
      sortedSqlRowsCache.colIdx === state.sqlSortColIdx &&
      sortedSqlRowsCache.dir === state.sqlSortDir
    ) {
      return sortedSqlRowsCache.rows
    }
    const rows = state.sqlSortColIdx === null ? res.rows : [...res.rows]
    if (
      state.sqlSortColIdx !== null &&
      state.sqlSortColIdx >= 0 &&
      state.sqlSortColIdx < (res.columns?.length || 0)
    ) {
      const idx = state.sqlSortColIdx
      const dir = state.sqlSortDir === 'DESC' ? -1 : 1
      rows.sort((a, b) => {
        const va = a[idx]
        const vb = b[idx]
        if (va == null && vb == null) return 0
        if (va == null) return -1 * dir
        if (vb == null) return 1 * dir
        const na = Number(va)
        const nb = Number(vb)
        if (
          typeof va === 'number' &&
          typeof vb === 'number' &&
          Number.isFinite(na) &&
          Number.isFinite(nb)
        ) {
          return (na - nb) * dir
        }
        return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir
      })
    }
    sortedSqlRowsCache = { res, colIdx: state.sqlSortColIdx, dir: state.sqlSortDir, rows }
    return rows
  }

  function renderSqlSelectionStats() {
    const strip = $('sqlSelectionStats')
    if (!strip) return
    const sqlGridSel = getSqlGridSel()
    if (!sqlGridSel || !sqlGridSel.hasSelection()) {
      strip.hidden = true
      strip.textContent = ''
      return
    }
    const txt = sqlGridSel.formatStatsText()
    if (!txt) {
      strip.hidden = true
      strip.textContent = ''
      return
    }
    strip.hidden = false
    strip.textContent = txt
    setLastPanelCopiedText(txt)
  }

  function copySqlSelection(format = 'tsv', includeHeaders = false) {
    const res = state.lastSqlResult
    const sqlGridSel = getSqlGridSel()
    if (!res || !res.columns || !sqlGridSel || !sqlGridSel.hasSelection()) return false
    const sortedRows = getSortedSqlRows()
    const coords = sqlGridSel.getSelectedCoords(50000)
    if (coords.length === 0) return false
    const text = formatSelectionAsOutput(
      res.columns,
      sortedRows,
      coords,
      format,
      includeHeaders,
      'query_result',
      null,
      getActiveConn()?.driver || 'sqlite',
      []
    )
    if (!text) return false
    setLastPanelCopiedText(text)
    const cnt = coords.length
    void copyText(text, `Copied ${cnt} cell${cnt === 1 ? '' : 's'} as ${format.toUpperCase()}`)
    return true
  }

  function exportCurrentSqlResult(format, asDownload, ext, mime) {
    const res = state.lastSqlResult
    if (!res || !Array.isArray(res.columns) || res.columns.length === 0) {
      showBanner('Execute a query returning rows before exporting.', 'warn')
      return
    }
    const conn = getActiveConn()
    const cols = res.columns
    const sortedRows = getSortedSqlRows()
    const sqlGridSel = getSqlGridSel()
    let exportRows = sortedRows
    let selectionPrefix = ''
    if (sqlGridSel && sqlGridSel.hasSelection()) {
      const rowIndices = sqlGridSel.getSelectedRowIndices()
      if (rowIndices.length > 0 && rowIndices.length < sortedRows.length) {
        exportRows = rowIndices.map((i) => sortedRows[i]).filter(Boolean)
        selectionPrefix = 'Selected '
      }
    }
    const content = formatExportData({
      columns: cols,
      rows: exportRows,
      format,
      tableName: 'query_result',
      driver: conn?.driver || 'sqlite',
    })
    if (asDownload) {
      downloadTextFile(`query_result.${ext}`, content, mime)
      showBanner(
        `Downloaded ${selectionPrefix}query_result.${ext} (${exportRows.length} rows)`,
        'success'
      )
    } else {
      void copyText(
        content,
        `Copied ${selectionPrefix}${exportRows.length} SQL result row(s) as ${format.toUpperCase()}`
      )
    }
  }

  function createSqlVirtualRow(rowIdx) {
    const res = state.lastSqlResult
    const sqlGridSel = getSqlGridSel()
    const tr = document.createElement('tr')
    tr.dataset.rowIdx = String(rowIdx)
    if (rowIdx % 2 === 1) tr.classList.add('row-even')
    const row = sqlVirt.sortedRows[rowIdx]

    const tdIdx = document.createElement('td')
    tdIdx.className = 'td-rownum'
    tdIdx.dataset.rowIdx = String(rowIdx)
    tdIdx.textContent = String(rowIdx + 1)
    tdIdx.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !sqlGridSel) return
      e.preventDefault()
      $('sqlResultWrap')?.focus({ preventScroll: true })
      sqlGridSel.selectRow(rowIdx, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
    })
    tr.appendChild(tdIdx)

    for (let colIdx = 0; colIdx < sqlVirt.columns.length; colIdx++) {
      const val = row[colIdx]
      const td = document.createElement('td')
      td.dataset.rowIdx = String(rowIdx)
      td.dataset.colIdx = String(colIdx)
      if (val === null || val === undefined) {
        td.textContent = 'NULL'
        td.className = 'cell-null'
      } else if (typeof val === 'object') {
        const s = JSON.stringify(val)
        td.textContent = s
        td.title = s
      } else {
        td.textContent = String(val)
        td.title = String(val)
      }
      tr.appendChild(td)
    }
    if (sqlGridSel) sqlGridSel.applyClassesToRow(tr, rowIdx)
    return tr
  }

  function renderSqlVirtualWindow(force = false) {
    const wrap = $('sqlResultWrap')
    const res = state.lastSqlResult
    if (!sqlVirt.active || !res || !sqlVirt.tbody || !wrap) return
    const total = sqlVirt.sortedRows.length
    const { start, end } = computeVirtualRange(wrap.scrollTop, wrap.clientHeight, total)
    syncVirtualTableWindow({
      virt: sqlVirt,
      total,
      start,
      end,
      colSpan: sqlVirt.columns.length + 1,
      rowHeightPx: VIRT_ROW_HEIGHT_PX,
      force,
      createRow: createSqlVirtualRow,
      selectionController: getSqlGridSel(),
    })
  }

  function ensureSqlVirtualRowVisible(rowIdx) {
    const wrap = $('sqlResultWrap')
    if (!wrap || !sqlVirt.active) return
    const total = sqlVirt.sortedRows.length
    if (rowIdx < 0 || rowIdx >= total) return
    const topPx = rowIdx * VIRT_ROW_HEIGHT_PX
    const botPx = topPx + VIRT_ROW_HEIGHT_PX
    const hdrH = 26
    if (topPx < wrap.scrollTop) {
      wrap.scrollTop = topPx
    } else if (botPx > wrap.scrollTop + wrap.clientHeight - hdrH) {
      wrap.scrollTop = Math.max(0, botPx - (wrap.clientHeight - hdrH))
    }
    renderSqlVirtualWindow(false)
  }

  function renderSqlResultSkeleton() {
    if (sqlVirt.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(sqlVirt.rafId)
      sqlVirt.rafId = null
    }
    const wrap = $('sqlResultWrap')
    const tbl = $('sqlResultTable')
    const metaBar = $('sqlResultMeta')
    if (!wrap || !tbl) return
    sqlVirt.active = false
    sqlVirt.sortedRows = []
    sqlVirt.columns = []
    sqlVirt.start = -1
    sqlVirt.end = -1
    wrap.hidden = false
    if (metaBar) metaBar.hidden = true
    tbl.textContent = ''
    tbl.style.width = '100%'
    const thead = document.createElement('thead')
    const hr = document.createElement('tr')
    for (const w of ['36px', '30%', '35%', '35%']) {
      const th = document.createElement('th')
      th.style.width = w
      const bar = document.createElement('div')
      bar.className = 'panel-skeleton-bar'
      bar.style.width = w === '36px' ? '16px' : '58%'
      th.appendChild(bar)
      hr.appendChild(th)
    }
    thead.appendChild(hr)
    tbl.appendChild(thead)
    const tbody = document.createElement('tbody')
    for (let r = 0; r < 6; r++) {
      const tr = document.createElement('tr')
      for (let c = 0; c < 4; c++) {
        const td = document.createElement('td')
        const bar = document.createElement('div')
        bar.className = 'panel-skeleton-bar'
        bar.style.width = c === 0 ? '18px' : `${48 + ((r * 19 + c * 13) % 40)}%`
        td.appendChild(bar)
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    tbl.appendChild(tbody)
  }

  function renderSqlResultTableOnly() {
    if (sqlVirt.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(sqlVirt.rafId)
      sqlVirt.rafId = null
    }
    const sqlGridSel = getSqlGridSel()
    const res = state.lastSqlResult
    const wrap = $('sqlResultWrap')
    const tbl = $('sqlResultTable')
    const metaBar = $('sqlResultMeta')
    if (!tbl || !wrap) return
    tbl.textContent = ''
    if (!res || !res.columns || res.columns.length === 0) {
      sqlVirt.active = false
      sqlVirt.sortedRows = []
      sqlVirt.columns = []
      sqlVirt.start = -1
      sqlVirt.end = -1
      wrap.hidden = true
      if (metaBar) metaBar.hidden = true
      return
    }
    wrap.hidden = false
    if (metaBar) metaBar.hidden = false
    const sortedRows = getSortedSqlRows()
    if (!Array.isArray(state.sqlColWidths) || state.sqlColWidths.length !== res.columns.length) {
      state.sqlColWidths = res.columns.map((col, idx) => {
        let maxLen = col.name.length + 2
        const sampleLen = Math.min(25, sortedRows.length)
        for (let r = 0; r < sampleLen; r++) {
          const v = sortedRows[r][idx]
          const len =
            v == null ? 4 : (typeof v === 'object' ? JSON.stringify(v) : String(v)).length
          if (len > maxLen) maxLen = len
        }
        return Math.max(84, Math.min(280, Math.round(Math.min(40, Math.max(7, maxLen)) * 7.4 + 26)))
      })
    }
    const colWidths = state.sqlColWidths
    const colgroup = document.createElement('colgroup')
    const rowNumColEl = document.createElement('col')
    rowNumColEl.style.width = `${state.sqlRowNumWidth}px`
    colgroup.appendChild(rowNumColEl)
    const colEls = colWidths.map((w) => {
      const c = document.createElement('col')
      c.style.width = `${w}px`
      colgroup.appendChild(c)
      return c
    })
    tbl.appendChild(colgroup)

    const syncSqlTableWidth = () => {
      const total = state.sqlRowNumWidth + colWidths.reduce((s, w) => s + w, 0)
      tbl.style.width = `${total}px`
    }
    syncSqlTableWidth()

    const thead = document.createElement('thead')
    const hr = document.createElement('tr')

    const thIdx = document.createElement('th')
    thIdx.style.width = `${state.sqlRowNumWidth}px`
    thIdx.style.left = '0px'
    thIdx.dataset.cornerSelect = '1'
    thIdx.title = 'Click to Select All (Ctrl+A)'
    const idxInner = document.createElement('div')
    idxInner.className = 'th-inner'
    const idxLbl = document.createElement('span')
    idxLbl.className = 'th-label'
    idxLbl.style.textAlign = 'right'
    idxLbl.textContent = '#'
    idxInner.appendChild(idxLbl)
    const idxResize = document.createElement('div')
    idxResize.className = 'col-resize-handle'
    attachColumnResizeHandle(
      idxResize,
      rowNumColEl,
      thIdx,
      true,
      -1,
      colWidths,
      syncSqlTableWidth,
      null,
      'sqlRowNumWidth'
    )
    thIdx.append(idxInner, idxResize)
    thIdx.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || Date.now() < getSuppressSortClickUntil()) return
      if (!sqlGridSel || sortedRows.length === 0 || res.columns.length === 0) return
      e.preventDefault()
      $('sqlResultWrap')?.focus({ preventScroll: true })
      sqlGridSel.selectAll()
    })
    hr.appendChild(thIdx)

    res.columns.forEach((col, colIdx) => {
      const th = document.createElement('th')
      th.style.width = `${colWidths[colIdx]}px`
      const inner = document.createElement('div')
      inner.className = 'th-inner'
      const lbl = document.createElement('span')
      lbl.className = 'th-label'
      lbl.textContent = col.name
      lbl.title = `${col.name}${col.type ? ` (${col.type})` : ''}`
      inner.appendChild(lbl)
      if (state.sqlSortColIdx === colIdx) {
        const ind = document.createElement('span')
        ind.className = 'th-sort'
        ind.appendChild(createSortSvg(state.sqlSortDir))
        inner.appendChild(ind)
      }

      const resizeHandle = document.createElement('div')
      resizeHandle.className = 'col-resize-handle'
      attachColumnResizeHandle(
        resizeHandle,
        colEls[colIdx],
        th,
        false,
        colIdx,
        colWidths,
        syncSqlTableWidth,
        () => {
          const curRows = getSortedSqlRows()
          let maxLen = col.name.length + 2
          const limit = Math.min(curRows.length, 500)
          for (let r = 0; r < limit; r++) {
            const v = curRows[r]?.[colIdx]
            const len =
              v == null ? 4 : (typeof v === 'object' ? JSON.stringify(v) : String(v)).length
            if (len > maxLen) maxLen = len
          }
          return Math.max(64, Math.min(440, Math.round(maxLen * 7.5 + 26)))
        },
        'sqlRowNumWidth'
      )

      th.append(inner, resizeHandle)
      th.addEventListener('click', (e) => {
        if (Date.now() < getSuppressSortClickUntil()) return
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          e.preventDefault()
          sqlGridSel?.selectCol(colIdx, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
          $('sqlResultWrap')?.focus({ preventScroll: true })
          return
        }
        if (state.sqlSortColIdx === colIdx) {
          state.sqlSortDir = state.sqlSortDir === 'ASC' ? 'DESC' : 'ASC'
        } else {
          state.sqlSortColIdx = colIdx
          state.sqlSortDir = 'ASC'
        }
        captureActiveResultTabState()
        sqlGridSel?.clear(true)
        renderSqlResultTableOnly()
      })
      hr.appendChild(th)
    })
    thead.appendChild(hr)
    tbl.appendChild(thead)

    const tbody = document.createElement('tbody')
    if (sortedRows.length === 0) {
      sqlVirt.active = false
      sqlVirt.columns = res.columns
      sqlVirt.sortedRows = []
      sqlVirt.start = -1
      sqlVirt.end = -1
      const emptyTr = document.createElement('tr')
      const emptyTd = document.createElement('td')
      emptyTd.colSpan = res.columns.length + 1
      emptyTd.className = 'cell-null'
      emptyTd.style.textAlign = 'center'
      emptyTd.style.padding = '16px 12px'
      emptyTd.textContent = 'Query returned no rows.'
      emptyTr.appendChild(emptyTd)
      tbody.appendChild(emptyTr)
      tbl.appendChild(tbody)
    } else {
      const topSpacerTr = document.createElement('tr')
      topSpacerTr.className = 'virt-spacer-row'
      topSpacerTr.style.display = 'none'
      const topSpacerTd = document.createElement('td')
      topSpacerTd.colSpan = res.columns.length + 1
      topSpacerTr.appendChild(topSpacerTd)

      const bottomSpacerTr = document.createElement('tr')
      bottomSpacerTr.className = 'virt-spacer-row'
      bottomSpacerTr.style.display = 'none'
      const bottomSpacerTd = document.createElement('td')
      bottomSpacerTd.colSpan = res.columns.length + 1
      bottomSpacerTr.appendChild(bottomSpacerTd)

      tbody.append(topSpacerTr, bottomSpacerTr)
      tbl.appendChild(tbody)

      sqlVirt.active = true
      sqlVirt.columns = res.columns
      sqlVirt.sortedRows = sortedRows
      sqlVirt.tbody = tbody
      sqlVirt.topSpacerTr = topSpacerTr
      sqlVirt.topSpacerTd = topSpacerTd
      sqlVirt.bottomSpacerTr = bottomSpacerTr
      sqlVirt.bottomSpacerTd = bottomSpacerTd
      sqlVirt.start = -1
      sqlVirt.end = -1

      renderSqlVirtualWindow(true)
    }
    renderSqlSelectionStats()
  }

  function renderQueryResult(res, opts = {}) {
    const mode = opts.mode || 'query'
    const targetTabId = opts.originTabId || consoleTabs.getActiveTabId()
    const overallSql = opts.overallSql ?? getSqlText().trim()
    const rawStatements = Array.isArray(opts.rawStatements) ? opts.rawStatements : []
    const fallbackMs = Number.isFinite(Number(res?.executionTimeMs))
      ? Number(res.executionTimeMs)
      : 0
    const defaultIdx =
      typeof opts.defaultIndex === 'number'
        ? opts.defaultIndex
        : getDefaultResultSetIndex(res, mode)
    const resultStates = buildInitialPanelResultStates(
      res,
      rawStatements,
      overallSql,
      fallbackMs,
      mode
    )
    consoleTabs.setResultForTab(
      targetTabId,
      res,
      defaultIdx,
      overallSql,
      opts.connId ?? state.activeConnectionId ?? undefined,
      resultStates,
      mode
    )

    if (targetTabId === consoleTabs.getActiveTabId()) {
      const tab = consoleTabs.getActiveTab()
      applyPanelResultTab(defaultIdx, tab, { preserveScroll: Boolean(opts.preserveScroll) })
    }
    if (!opts.skipCache) {
      savePanelDataCache?.()
    }
  }

  function resolveTargetSql(mode, rawScript, runDriver) {
    const selectedSql = cmEditor ? cmEditor.getSelectedText() : ''
    let sql = rawScript.trim()
    if (mode === 'explain') {
      sql = selectedSql || rawScript.trim()
    } else if (mode === 'caret') {
      if (selectedSql) {
        sql = selectedSql
      } else if (runDriver !== 'redis') {
        sql = cmEditor
          ? cmEditor.getCaretStatementSql(runDriver)
          : findStatementAtOffset(rawScript, rawScript.length, runDriver).trim()
      }
    }
    if (!sql) return null
    const statements =
      runDriver === 'redis'
        ? [sql]
        : splitSqlStatements(sql, runDriver)
            .map((s) => s.text.trim())
            .filter(Boolean)
    return statements.length > 0 ? { sql, statements } : null
  }

  function setSqlRunToolbarBusy(busy, cancelBtn) {
    $('runSqlBtn').disabled = busy
    $('runAllSqlBtn').disabled = busy
    $('explainSqlBtn').disabled = busy
    if ($('formatSqlBtn')) $('formatSqlBtn').disabled = busy
    if (cancelBtn) {
      setButtonLoading(cancelBtn, false)
      cancelBtn.hidden = !busy
    }
  }

  async function executeExplainBatch({ statements, runConnId, queryId, runSeq, onProgress }) {
    const overallStart = performance.now()
    const collectedSets = []
    let firstNonError = null
    for (let i = 0; i < statements.length; i++) {
      if (runSeq !== sqlRunSeq || state.activeConnectionId !== runConnId) return null
      if (cancelledSqlRunSeq === runSeq) {
        const cancelErr = new Error('EXPLAIN execution was cancelled')
        cancelErr.code = 'cancelled'
        throw cancelErr
      }
      const stmtSql = statements[i]
      const workerQid = statements.length === 1 ? queryId : `${queryId}_${i}`
      state.activeWorkerQueryId = workerQid
      onProgress(statements.length > 1 ? `Explaining ${i + 1}/${statements.length}` : 'Explaining')
      const stmtStart = performance.now()
      try {
        const singleRes = await rpc(
          'query.explain',
          { connectionId: runConnId, queryId: workerQid, sql: stmtSql },
          { timeoutMs: QUERY_TIMEOUT_MS }
        )
        if (runSeq !== sqlRunSeq || state.activeConnectionId !== runConnId) return null
        if (cancelledSqlRunSeq === runSeq) {
          const cancelErr = new Error('EXPLAIN execution was cancelled')
          cancelErr.code = 'cancelled'
          throw cancelErr
        }
        const stmtMs = singleRes?.executionTimeMs || Math.round(performance.now() - stmtStart)
        if (!firstNonError) firstNonError = singleRes
        collectedSets.push({
          index: i,
          sqlPreview: compactSqlPreview(stmtSql),
          sql: stmtSql,
          executionTimeMs: stmtMs,
          columns: singleRes?.columns || [],
          rows: singleRes?.rows || [],
          rowCount: singleRes?.rowCount ?? (singleRes?.rows ? singleRes.rows.length : 0),
          truncated: Boolean(singleRes?.truncated),
          isSelect: true,
        })
      } catch (stmtErr) {
        if (runSeq !== sqlRunSeq || state.activeConnectionId !== runConnId) return null
        const isCancelled =
          cancelledSqlRunSeq === runSeq ||
          stmtErr?.code === 'cancelled' ||
          /cancel/i.test(String(stmtErr?.message || ''))
        if (statements.length === 1 || isCancelled) throw stmtErr
        collectedSets.push({
          index: i,
          sqlPreview: compactSqlPreview(stmtSql),
          sql: stmtSql,
          executionTimeMs: Math.round(performance.now() - stmtStart),
          isError: true,
          errorMessage: stmtErr?.message || String(stmtErr),
          columns: [],
          rows: [],
          rowCount: 0,
          truncated: false,
          isSelect: true,
        })
      }
    }
    const totalMs = Math.round(performance.now() - overallStart)
    return buildCombinedExplainResult(collectedSets, firstNonError, totalMs)
  }

  async function executeSingleQueryRun({ sql, runConnId, queryId, runSeq }) {
    let configuredMaxRows
    if (typeof window.orca?.settings?.get === 'function') {
      try {
        const rawMax = Number(await window.orca.settings.get('maxRows'))
        if (Number.isFinite(rawMax) && rawMax > 0) {
          configuredMaxRows = Math.max(1, Math.min(50000, Math.floor(rawMax)))
        }
      } catch {}
      if (runSeq !== sqlRunSeq || state.activeConnectionId !== runConnId) return { stale: true }
    }
    const payload = {
      connectionId: runConnId,
      queryId,
      sql,
      ...(configuredMaxRows ? { maxRows: configuredMaxRows } : {}),
    }
    const res = await rpc('query.run', payload, { timeoutMs: QUERY_TIMEOUT_MS })
    return { stale: false, res }
  }

  async function runSql(mode = 'caret') {
    if (!state.activeConnectionId || state.activeQueryId) return
    const conn = getActiveConn()
    const runConnId = state.activeConnectionId
    const runDriver = conn?.driver || 'sqlite'
    const originTabId = consoleTabs.getActiveTabId()
    const resolved = resolveTargetSql(mode, getSqlText(), runDriver)
    if (!resolved) return
    const { sql, statements } = resolved

    const runSeq = ++sqlRunSeq
    const queryId = `panel_sql_${Date.now()}`
    state.activeQueryId = queryId
    state.activeWorkerQueryId = queryId
    $('sqlSuccessBanner').hidden = true
    $('sqlErrorBanner').hidden = true
    if ($('sqlResultSetsBar')) $('sqlResultSetsBar').hidden = true
    const cancelBtn = $('cancelSqlBtn')
    setSqlRunToolbarBusy(true, cancelBtn)

    const meta = $('sqlMetaBadge')
    meta.hidden = false
    meta.className = 'badge badge-info'
    let explainProgressText = ''
    const phaseWord = mode === 'explain' ? 'Explaining' : 'Running'
    const setRunningBadge = (elapsed) => {
      if (runSeq !== sqlRunSeq || state.activeConnectionId !== runConnId) return
      meta.textContent = ''
      const sp = document.createElement('span')
      sp.className = 'btn-spinner btn-spinner-sm'
      sp.style.marginRight = '5px'
      sp.setAttribute('aria-hidden', 'true')
      const lbl = document.createElement('span')
      lbl.textContent = explainProgressText
        ? `${explainProgressText} ${elapsed}...`
        : `${phaseWord} ${elapsed}...`
      meta.append(sp, lbl)
    }
    if (sqlStopTimer) {
      sqlStopTimer()
      sqlStopTimer = null
    }
    const stopTimer = createElapsedTimer(setRunningBadge)
    sqlStopTimer = stopTimer
    renderSqlResultSkeleton()

    try {
      if (mode === 'explain') {
        const combinedRes = await executeExplainBatch({
          statements,
          runConnId,
          queryId,
          runSeq,
          onProgress: (text) => {
            explainProgressText = text
          },
        })
        stopTimer()
        if (!combinedRes) return
        renderQueryResult(combinedRes, {
          mode: 'explain',
          originTabId,
          connId: runConnId,
          rawStatements: statements,
          overallSql: sql,
          defaultIndex: 0,
        })
        return
      }

      const outcome = await executeSingleQueryRun({ sql, runConnId, queryId, runSeq })
      stopTimer()
      if (outcome.stale || runSeq !== sqlRunSeq || state.activeConnectionId !== runConnId) {
        if (panelContainsDdlStatement(sql, runDriver) && getConnById(runConnId)) {
          void loadSchema(runConnId)
        }
        return
      }
      renderQueryResult(outcome.res, {
        mode: 'query',
        originTabId,
        connId: runConnId,
        rawStatements: statements,
        overallSql: sql,
      })
      if (panelContainsDdlStatement(sql, runDriver)) {
        void loadSchema(runConnId)
      }
      if (state.historyOpen) void loadQueryHistory()
    } catch (err) {
      stopTimer()
      if (runSeq !== sqlRunSeq || state.activeConnectionId !== runConnId) return
      const errMsg = err?.message || String(err)
      renderQueryResult(buildErrorQueryResult(sql, errMsg), {
        mode: mode === 'explain' ? 'explain' : 'query',
        originTabId,
        connId: runConnId,
        rawStatements: statements,
        overallSql: sql,
        defaultIndex: 0,
        skipCache: true,
      })
    } finally {
      stopTimer()
      if (sqlStopTimer === stopTimer) sqlStopTimer = null
      if (runSeq === sqlRunSeq) {
        state.activeQueryId = null
        state.activeWorkerQueryId = null
        setSqlRunToolbarBusy(false, cancelBtn)
      }
    }
  }

  async function loadQueryHistory() {
    const reqSeq = ++historySeq
    const list = $('sqlHistoryList')
    const refBtn = $('refreshHistoryBtn')
    if (list && (!state.historyEntries || state.historyEntries.length === 0)) {
      state.historyLoading = true
      renderQueryHistory()
    }
    setButtonLoading(refBtn, true, 'Loading...')
    try {
      const res = await rpc('query.history.list', { limit: 50 })
      if (reqSeq !== historySeq) return
      state.historyEntries = Array.isArray(res?.entries) ? res.entries : []
    } catch {
      if (reqSeq !== historySeq) return
      state.historyEntries = []
    } finally {
      if (reqSeq === historySeq) {
        state.historyLoading = false
        setButtonLoading(refBtn, false)
        renderQueryHistory()
      }
    }
  }

  function renderQueryHistory() {
    const list = $('sqlHistoryList')
    if (!list) return
    list.textContent = ''
    if (state.historyLoading) {
      for (let i = 0; i < 3; i++) {
        const sk = document.createElement('div')
        sk.className = 'history-card'
        const b1 = document.createElement('div')
        b1.className = 'panel-skeleton-bar'
        b1.style.width = `${45 + i * 12}%`
        const b2 = document.createElement('div')
        b2.className = 'panel-skeleton-bar'
        b2.style.width = '88%'
        sk.append(b1, b2)
        list.appendChild(sk)
      }
      return
    }
    const q = (state.historyFilter || '').trim().toLowerCase()
    const filtered = q
      ? state.historyEntries.filter(
          (e) =>
            String(e.sql || '').toLowerCase().includes(q) ||
            String(e.connectionName || '').toLowerCase().includes(q) ||
            String(e.driver || '').toLowerCase().includes(q)
        )
      : state.historyEntries

    if (filtered.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'col-leaf'
      empty.textContent =
        state.historyEntries.length === 0
          ? 'No executed queries recorded yet.'
          : `No queries match "${state.historyFilter}".`
      list.appendChild(empty)
      return
    }
    for (const entry of filtered) {
      const item = document.createElement('div')
      item.className = 'history-card'
      item.title = entry.sql

      const top = document.createElement('div')
      top.className = 'file-chip-top'
      const title = document.createElement('span')
      title.className = 'file-chip-title'
      const ico = document.createElement('span')
      setDbLogoElement(ico, entry.driver, 13)
      const nm = document.createElement('span')
      nm.className = 'file-chip-name'
      nm.textContent = entry.connectionName || entry.driver
      title.append(ico, nm)

      const status = document.createElement('span')
      status.className = `badge ${entry.isError ? 'badge-danger' : 'badge-ok'}`
      status.textContent = entry.isError
        ? 'ERR'
        : `${entry.rowCount}r · ${Math.round(entry.durationMs)}ms`
      top.append(title, status)

      const sub = document.createElement('div')
      sub.className = 'file-chip-path'
      sub.textContent = entry.sql.replace(/\s+/g, ' ').trim()

      const foot = document.createElement('div')
      foot.className = 'history-card-foot'
      const timeEl = document.createElement('span')
      timeEl.className = 'history-time'
      timeEl.textContent = formatRelativeTime(entry.timestamp)

      const acts = document.createElement('div')
      acts.className = 'input-group'
      acts.style.gap = '4px'
      const insBtn = document.createElement('button')
      insBtn.type = 'button'
      insBtn.className = 'mini-btn'
      insBtn.textContent = 'Insert'
      insBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        setSqlText(entry.sql, { focus: true })
      })
      const cpyBtn = document.createElement('button')
      cpyBtn.type = 'button'
      cpyBtn.className = 'mini-btn'
      cpyBtn.textContent = 'Copy'
      cpyBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        void copyText(entry.sql, 'History SQL copied', cpyBtn)
      })
      acts.append(insBtn, cpyBtn)
      foot.append(timeEl, acts)

      item.append(top, sub, foot)
      list.appendChild(item)
    }
  }

  function markSqlRunCancelled() {
    cancelledSqlRunSeq = sqlRunSeq
  }

  function cancelPendingSqlRun() {
    cancelledSqlRunSeq = sqlRunSeq
    sqlRunSeq++
    if (sqlStopTimer) {
      sqlStopTimer()
      sqlStopTimer = null
    }
  }

  function bumpHistorySeq() {
    historySeq++
  }

  renderConsoleTabs()

  return {
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
    selectPanelResultSetIndex,
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
    renderSqlResultSkeleton,
    renderSqlResultTableOnly,
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
  }
}
