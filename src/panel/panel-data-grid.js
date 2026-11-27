// src/panel/panel-data-grid.js
// Side Panel Data Grid: toolbar, staging bar, virtualized row window, inline editor,
// column resize/auto-fit/pin/hide, find highlights, export, and value inspector.

import { formatJsonPreservingNumbers } from '../shared-grid-paste.js'
import {
  RowHeightIndex,
  clampWrapMaxLines,
  countNormalizedLines,
  isWrappableCellValue,
  DEFAULT_WRAP_MAX_LINES,
} from '../shared-row-height-index.js'
import {
  HIGHLIGHT_CSS_CLASSES,
  areHighlightRulesEqual,
  buildColumnKeyResolver,
  parseOccurrenceColumnKey,
  computePinnedColumnsViewportCap,
  computeScrollLeftForFocusedCell,
  createHighlightEvaluator,
  resolveCellDisplayHighlight,
} from '../shared-table-display.js'
import {
  formatExportData,
  formatSelectionAsOutput,
  parseDelimitedClipboard,
  planPanelGridPaste,
  isNumericSqlType,
  isBooleanSqlType,
  coerceTypedCellInput,
  computeInitialColumnWidths,
  computeVirtualRange as coreComputeVirtualRange,
} from './panel-core.js'
import {
  $,
  encodeTableSelectValue,
  downloadTextFile,
  createSortSvg,
  syncSelectTooltip,
  syncVirtualTableWindow,
} from './panel-utils.js'

const ALL_HIGHLIGHT_CLASSES = Object.values(HIGHLIGHT_CSS_CLASSES)

export function shouldDisableEditStructureButton({ busy, isView, activeTable, driver }) {
  return Boolean(
    busy || isView || !activeTable || driver === 'redis' || driver === 'mongodb'
  )
}

export function createPanelDataGridController(ctx) {
  const {
    state,
    VIRT_ROW_HEIGHT_PX,
    VIRT_OVERSCAN_ROWS,
    getActiveConn,
    getStagedCount,
    isSubmittingChanges,
    isPreviewingDml,
    getDataGridSel,
    getActiveTableKey,
    getOrderedVisibleColumns,
    getPinnedColsSet,
    getHiddenColsSet,
    getActiveForeignKeyMap,
    getActiveTableDisplayEntry,
    patchTableDisplayState,
    getColKeyResolver,
    reorderColumnByDrop,
    getLastPanelCopiedText,
    setLastPanelCopiedText,
    getSuppressSortClickUntil,
    setSuppressSortClickUntil,
    getActiveResizeCleanup,
    setActiveResizeCleanup,
    setInspectorUserModified,
    showBanner,
    copyText,
    loadTablePage,
    syncDataControlsDisabled,
    renderDataColsPopoverList,
  } = ctx

  const dataRowHeightIndex = new RowHeightIndex({
    baseRowHeightPx: VIRT_ROW_HEIGHT_PX,
    lineHeightPx: 16,
    maxLines: DEFAULT_WRAP_MAX_LINES,
    wrapEnabled: false,
  })
  const highlightEvaluator = createHighlightEvaluator(4096)

  let localColResolverCols = null
  let localColResolverLen = -1
  let localColResolver = null
  function resolvePanelGridKeyResolver(columnsOrHeaders = state.pageData?.columns) {
    if (typeof getColKeyResolver === 'function') {
      return getColKeyResolver(columnsOrHeaders)
    }
    if (!Array.isArray(columnsOrHeaders) || columnsOrHeaders.length === 0) return null
    if (
      localColResolver &&
      localColResolverCols === columnsOrHeaders &&
      localColResolverLen === columnsOrHeaders.length
    ) {
      return localColResolver
    }
    const headers =
      typeof columnsOrHeaders[0] === 'string'
        ? columnsOrHeaders
        : columnsOrHeaders.map((c) => c.name)
    localColResolver = buildColumnKeyResolver(headers)
    localColResolverCols = columnsOrHeaders
    localColResolverLen = columnsOrHeaders.length
    return localColResolver
  }

  let displayRowsCache = {
    pageData: null,
    stagedInsertsLen: -1,
    firstInsertRef: null,
    lastInsertRef: null,
    rows: [],
  }

  const rowHighlightRevisionByKey = new Map()
  let highlightRevisionEpoch = 0

  function getRowHighlightRevision(rowKey) {
    return `${highlightRevisionEpoch}:${rowHighlightRevisionByKey.get(rowKey) || 0}`
  }

  function bumpRowHighlightRevision(rowKey) {
    if (!rowKey) return
    rowHighlightRevisionByKey.set(rowKey, (rowHighlightRevisionByKey.get(rowKey) || 0) + 1)
  }

  function bumpAllHighlightRevisions() {
    highlightRevisionEpoch += 1
    rowHighlightRevisionByKey.clear()
  }

  function buildEffectiveHighlightRow(entry, staged, allColNames) {
    if (!staged || !staged.changes) return entry.data
    if (!Array.isArray(entry.data)) {
      return { ...entry.data, ...staged.changes }
    }
    const nextArr = entry.data.slice()
    for (let i = 0; i < allColNames.length; i++) {
      const colName = allColNames[i]
      if (Object.prototype.hasOwnProperty.call(staged.changes, colName)) {
        nextArr[i] = staged.changes[colName]
      }
    }
    return nextArr
  }

  function evaluateDataRowHighlight(entry) {
    if (!dataVirt.highlightRules || dataVirt.highlightRules.length === 0) return null
    const staged = state.stagedUpdates.get(entry.rowKey)
    const evalRow = buildEffectiveHighlightRow(entry, staged, dataVirt.allColNames)
    return highlightEvaluator.evaluateRow({
      row: evalRow,
      columns: dataVirt.allColNames,
      rules: dataVirt.highlightRules,
      rowKey: entry.rowKey,
      rowRevision: getRowHighlightRevision(entry.rowKey),
    })
  }

  const dataVirt = {
    active: false,
    transposed: false,
    allRows: [],
    cappedRows: [],
    hasOverflowCol: false,
    rowColWidths: [],
    fieldWidth: 180,
    hStart: 0,
    hEnd: 0,
    visCols: [],
    visColKeys: [],
    visColWidths: [],
    pinnedCandidateKeys: [],
    pinnedCount: 0,
    stickyLefts: [],
    totalPinnedWidthPx: 56,
    wrapCells: false,
    wrapMaxLines: DEFAULT_WRAP_MAX_LINES,
    highlightRules: [],
    allColNames: [],
    fkMap: new Map(),
    pageOffset: 0,
    stagedInsertCount: 0,
    isConnRo: false,
    canEditTable: false,
    tbody: null,
    colgroupEl: null,
    theadEl: null,
    headerRowEl: null,
    rowNumColEl: null,
    rowNumThEl: null,
    headerPageDataRef: null,
    lastRenderedPageDataRef: null,
    lastRenderedStagedCount: -1,
    colPoolByKey: new Map(),
    thPoolByKey: new Map(),
    syncTableWidthFn: null,
    topSpacerTr: null,
    topSpacerTd: null,
    bottomSpacerTr: null,
    bottomSpacerTd: null,
    start: -1,
    end: -1,
    rafId: null,
  }

  function computeTransposedPanelColRange(scrollLeft, clientWidth, fieldWidth, rowColWidths) {
    const totalDataCols = Array.isArray(rowColWidths) ? rowColWidths.length : 0
    if (totalDataCols <= 16 || !clientWidth || clientWidth <= 0) {
      return { hStart: 0, hEnd: totalDataCols }
    }
    const left = Math.max(0, Number(scrollLeft) || 0)
    const visibleViewportW = Math.max(120, clientWidth - (Number(fieldWidth) || 180))
    const viewRight = left + visibleViewportW
    let x = 0
    let visStart = totalDataCols - 1
    let visEnd = 0
    let foundStart = false
    for (let i = 0; i < totalDataCols; i++) {
      const colW = Number(rowColWidths[i]) || 180
      const nextX = x + colW
      if (!foundStart && nextX > left) {
        visStart = i
        foundStart = true
      }
      if (x < viewRight) {
        visEnd = i + 1
      } else if (foundStart) {
        break
      }
      x = nextX
    }
    if (!foundStart) {
      visStart = Math.max(0, totalDataCols - 1)
      visEnd = totalDataCols
    }
    return {
      hStart: Math.max(0, visStart - 2),
      hEnd: Math.min(totalDataCols, Math.max(visStart + 1, visEnd) + 3),
    }
  }

  function computeVirtualRange(scrollTop, viewportH, totalRows, overscan = VIRT_OVERSCAN_ROWS) {
    return coreComputeVirtualRange(
      scrollTop,
      viewportH,
      totalRows,
      VIRT_ROW_HEIGHT_PX,
      overscan
    )
  }

  function isActiveDataObjectView() {
    if (!state.activeConnectionId || !state.activeTable) return false
    const objs = state.schemaObjects[state.activeConnectionId] || []
    const match =
      objs.find(
        (o) =>
          o.name === state.activeTable &&
          (!state.activeSchema || (o.schema || '') === (state.activeSchema || ''))
      ) || objs.find((o) => o.name === state.activeTable)
    return Boolean(match && (match.kind === 'view' || match.kind === 'materialized_view'))
  }

  function renderDataToolbar() {
    const allObjs =
      (state.activeConnectionId && state.schemaObjects[state.activeConnectionId]) || []
    const objs = allObjs.filter(
      (o) => !o.kind || o.kind === 'table' || o.kind === 'view' || o.kind === 'materialized_view'
    )
    const sel = $('dataTableSelect')
    if (objs.length === 0) {
      $('dataToolbar').hidden = true
      return
    }
    $('dataToolbar').hidden = false
    const uniqueSchemas = new Set(objs.map((o) => o.schema || '').filter(Boolean))
    const multiSchema = uniqueSchemas.size > 1
    sel.textContent = ''
    for (const o of objs) {
      const opt = document.createElement('option')
      opt.value = encodeTableSelectValue(o.schema, o.name)
      opt.textContent =
        multiSchema && o.schema ? `${o.schema}.${o.name} (${o.kind})` : `${o.name} (${o.kind})`
      if (o.name === state.activeTable && (o.schema || '') === (state.activeSchema || '')) {
        opt.selected = true
      }
      sel.appendChild(opt)
    }
    syncSelectTooltip(sel)
    renderStagingBar()
  }

  function getAllDisplayRows() {
    const pd = state.pageData
    if (!pd) return []
    const ins = state.stagedInserts
    const firstRef = ins.length > 0 ? ins[0] : null
    const lastRef = ins.length > 0 ? ins[ins.length - 1] : null
    if (
      displayRowsCache.pageData === pd &&
      displayRowsCache.stagedInsertsLen === ins.length &&
      displayRowsCache.firstInsertRef === firstRef &&
      displayRowsCache.lastInsertRef === lastRef
    ) {
      return displayRowsCache.rows
    }
    const existing = pd.rows.map((r, idx) => ({
      rowKey: `row_${idx}`,
      data: r,
      isInsert: false,
      origin: null,
    }))
    const inserted = ins.map((item) => ({
      rowKey: item.tempId,
      data: item.values,
      isInsert: true,
      origin: item.origin || 'blank',
    }))
    const rows = [...inserted, ...existing]
    displayRowsCache = {
      pageData: pd,
      stagedInsertsLen: ins.length,
      firstInsertRef: firstRef,
      lastInsertRef: lastRef,
      rows,
    }
    return rows
  }

  function getSelectedDataRowKeys() {
    const allRows = getAllDisplayRows()
    const dataGridSel = getDataGridSel()
    if (dataGridSel && dataGridSel.hasSelection()) {
      const indices = dataGridSel.getSelectedRowIndices()
      const keys = indices.map((i) => allRows[i]?.rowKey).filter(Boolean)
      if (keys.length > 0) return keys
    }
    return state.selectedRowKey ? [state.selectedRowKey] : []
  }

  function renderDataSelectionStats() {
    const strip = $('dataSelectionStats')
    if (!strip) return
    const dataGridSel = getDataGridSel()
    if (!dataGridSel || !dataGridSel.hasSelection() || state.dataLoading) {
      strip.hidden = true
      strip.textContent = ''
      return
    }
    const txt = dataGridSel.formatStatsText()
    strip.textContent = txt
    strip.hidden = !txt
  }

  function renderStagingBar() {
    const conn = getActiveConn()
    const pd = state.pageData
    const isConnRo = Boolean(conn?.readOnly)
    const isView = isActiveDataObjectView()
    const noPk = Boolean(pd && !pd.canEdit)
    const count = getStagedCount()
    const submitting = isSubmittingChanges()
    const busy = Boolean(state.dataLoading || submitting)
    const selectedRowKeys = getSelectedDataRowKeys()
    const rowCount = selectedRowKeys.length

    $('transposeBtn').classList.toggle('btn-active', state.transposed)

    if (isConnRo) {
      $('dataReadOnlyNotice').hidden = false
      $('dataReadOnlyText').textContent =
        'Read-Only connection — mutations (+ Row, − Row, Clone, Edit) are disabled.'
    } else if (isView) {
      $('dataReadOnlyNotice').hidden = false
      $('dataReadOnlyText').textContent =
        'View is read-only — row modifications (+ Row, − Row, Clone, Edit) are disabled.'
    } else if (noPk) {
      $('dataReadOnlyNotice').hidden = false
      $('dataReadOnlyText').textContent =
        'Table has no primary key — row updates and deletes are disabled.'
    } else {
      $('dataReadOnlyNotice').hidden = true
    }

    const editStructBtn = $('editTableStructureBtn')
    if (editStructBtn) {
      editStructBtn.disabled = shouldDisableEditStructureButton({
        busy,
        isView,
        activeTable: state.activeTable,
        driver: conn?.driver,
      })
      editStructBtn.title = isView
        ? 'Views are read-only — inspect DDL in Structure tab'
        : conn?.driver === 'mongodb'
          ? 'MongoDB collections are schemaless — inspect inferred fields in Structure tab'
          : 'Edit Table Structure (ALTER TABLE)'
    }

    const importBtn = $('importDataBtn')
    if (importBtn) {
      const noActiveTable = !state.activeTable || !state.activeConnectionId
      const isRedis = conn?.driver === 'redis'
      importBtn.disabled = busy || isConnRo || isView || isRedis || noActiveTable
      importBtn.title = isConnRo
        ? 'Cannot import data on a Read-Only connection'
        : isView
          ? 'Cannot import rows into a view — select a table'
          : isRedis
            ? 'Import is not supported on Redis connections'
            : 'Import CSV/JSON/TSV into this table in Full Studio'
    }

    $('addRowBtn').disabled = busy || isConnRo || isView || !pd
    const allMarkedDelete = rowCount > 0 && selectedRowKeys.every((k) => state.stagedDeletes.has(k))
    $('delRowBtn').textContent = allMarkedDelete
      ? rowCount > 1
        ? `Undo − (${rowCount})`
        : 'Undo −'
      : rowCount > 1
        ? `− ${rowCount} Rows`
        : '− Row'
    const anyExistingSelected = selectedRowKeys.some((k) => !k.startsWith('ins_'))
    $('delRowBtn').disabled =
      busy || isConnRo || isView || rowCount === 0 || (anyExistingSelected && noPk)
    $('cloneRowBtn').disabled = busy || isConnRo || isView || rowCount === 0
    $('cloneRowBtn').textContent = rowCount > 1 ? `Clone (${rowCount})` : 'Clone'
    const hasCellSelection = Boolean(pd && state.selectedRowKey && state.selectedCol)
    const inspectBtn = $('inspectCellBtn')
    if (inspectBtn instanceof HTMLButtonElement) {
      inspectBtn.disabled = busy || !hasCellSelection
      inspectBtn.classList.toggle('btn-active', state.inspectorOpen && hasCellSelection)
    }
    if (!isPreviewingDml()) {
      $('dmlPreviewBtn').disabled = busy || count === 0
    }
    if (!submitting) {
      $('submitChangesBtn').disabled = busy || isConnRo || isView || count === 0
      $('submitChangesBtn').textContent = `Submit [${count}]`
    }
    $('revertChangesBtn').disabled = busy || count === 0
    renderDataSelectionStats()
  }

  function getEffectiveCellValue(rowKey, rowObj, colName) {
    if (rowKey.startsWith('ins_')) {
      return rowObj[colName]
    }
    const staged = state.stagedUpdates.get(rowKey)
    if (staged && Object.prototype.hasOwnProperty.call(staged.changes, colName)) {
      return staged.changes[colName]
    }
    return rowObj[colName]
  }

  function isCellStagedEdited(rowKey, colName) {
    if (rowKey.startsWith('ins_')) return false
    const staged = state.stagedUpdates.get(rowKey)
    return Boolean(staged && Object.prototype.hasOwnProperty.call(staged.changes, colName))
  }

  function isDataCellEditable(entry, col, pd, isConnRo) {
    if (
      !entry ||
      !col ||
      !pd ||
      isConnRo ||
      isSubmittingChanges() ||
      isActiveDataObjectView()
    ) {
      return false
    }
    if (state.stagedDeletes.has(entry.rowKey)) return false
    if (col.isGenerated) return false
    if (entry.isInsert) return true
    if (!pd.canEdit) return false
    if (col.isPrimaryKey) return false
    return true
  }

  function patchRenderedDataCell(rowKey, colName, patchTd) {
    const pd = state.pageData
    if (!pd) return false
    const col = pd.columns.find((c) => c.name === colName)
    if (!col) return false
    let td = patchTd && patchTd.isConnected ? patchTd : null
    if (!td) {
      const tbl = $('dataTable')
      const tbody = tbl?.tBodies?.[0] || tbl?.querySelector('tbody')
      if (tbody) {
        const rows = tbody.children
        for (let i = 0; i < rows.length && !td; i++) {
          const tr = rows[i]
          if (!(tr instanceof HTMLElement)) continue
          if (!state.transposed && tr.dataset.rowKey !== rowKey) continue
          const cells = tr.children
          for (let j = 0; j < cells.length; j++) {
            const cell = cells[j]
            if (
              cell instanceof HTMLElement &&
              cell.dataset.rowKey === rowKey &&
              cell.dataset.colName === colName
            ) {
              td = cell
              break
            }
          }
        }
      }
    }
    if (!td) return false
    let entry = null
    if (dataVirt.active && td.dataset.rowIdx !== undefined) {
      entry = dataVirt.allRows[Number(td.dataset.rowIdx)] || null
    }
    if (!entry) {
      entry = getAllDisplayRows().find((r) => r.rowKey === rowKey) || null
    }
    if (!entry) return false
    const val = getEffectiveCellValue(entry.rowKey, entry.data, colName)
    const fkInfo = (dataVirt.active ? dataVirt.fkMap : getActiveForeignKeyMap()).get(colName) || null
    renderDataCellContent(td, entry, col, val, fkInfo)
    if (!state.transposed && dataVirt.highlightRules && dataVirt.highlightRules.length > 0) {
      const rowHl = evaluateDataRowHighlight(entry)
      const tr = td.closest ? td.closest('tr') : td.parentElement
      if (tr) {
        const cells = tr.children
        for (let i = 0; i < cells.length; i++) {
          const cell = cells[i]
          if (!(cell instanceof HTMLElement) || cell.dataset.colName === undefined) continue
          const cellColName = cell.dataset.colName
          const cellColKey = cell.dataset.colKey || dataVirt.colKeyByName?.get(cellColName) || cellColName
          applyCellHighlightClass(
            cell,
            rowHl,
            cellColKey,
            cellColName,
            false
          )
        }
      } else {
        const cellColKey = td.dataset.colKey || dataVirt.colKeyByName?.get(colName) || colName
        applyCellHighlightClass(td, rowHl, cellColKey, colName, false)
      }
    }
    if (state.findQuery && state.findQuery.trim()) {
      updateDataFindHighlights(false)
    }
    return true
  }

  function isPanelCellValueEqual(a, b) {
    if (Object.is(a, b)) return true
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      try {
        return JSON.stringify(a) === JSON.stringify(b)
      } catch {
        return false
      }
    }
    return false
  }

  function isBinaryPanelCellValue(value) {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) return true
    if (typeof value === 'string' && /^\[(?:BLOB|BINARY)\b[^\]]*\]$/i.test(value.trim())) {
      return true
    }
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value.type === 'Buffer' &&
      Array.isArray(value.data)
    ) {
      return true
    }
    return false
  }

  function stageCellValue(rowKey, rowObj, colName, nextVal, deferRender = false, patchTd = null) {
    if (isSubmittingChanges() || state.dataLoading || isActiveDataObjectView()) return
    const conn = getActiveConn()
    if (conn?.readOnly) {
      showBanner('Read-Only connection — cannot stage changes.', 'danger')
      return
    }
    if (state.stagedDeletes.has(rowKey)) return
    const pd = state.pageData
    const col = pd?.columns?.find((c) => c.name === colName)
    if (rowKey.startsWith('ins_')) {
      const ins = state.stagedInserts.find((r) => r.tempId === rowKey)
      if (ins) {
        ins.values[colName] = nextVal
        bumpRowHighlightRevision(rowKey)
        if (!deferRender) {
          if (!patchRenderedDataCell(rowKey, colName, patchTd)) {
            renderDataGrid()
          }
          renderStagingBar()
          renderValueInspector()
        }
      }
      return
    }
    if (!pd?.canEdit || col?.isPrimaryKey || col?.isGenerated) return
    const origVal = rowObj[colName]
    const pkCols = pd.primaryKey?.length > 0 ? pd.primaryKey : [pd.columns[0]?.name].filter(Boolean)
    const primaryKeys = {}
    for (const pk of pkCols) primaryKeys[pk] = rowObj[pk]

    let entry = state.stagedUpdates.get(rowKey)
    if (!entry) {
      entry = { primaryKeys, originalRow: { ...rowObj }, changes: {} }
      state.stagedUpdates.set(rowKey, entry)
    }
    if (isPanelCellValueEqual(nextVal, origVal)) {
      delete entry.changes[colName]
      if (Object.keys(entry.changes).length === 0) state.stagedUpdates.delete(rowKey)
    } else {
      entry.changes[colName] = nextVal
    }
    bumpRowHighlightRevision(rowKey)
    if (!deferRender) {
      if (!patchRenderedDataCell(rowKey, colName, patchTd)) {
        renderDataGrid()
      }
      renderStagingBar()
      renderValueInspector()
    }
  }

  function applyQuickWhere(whereExpr) {
    state.whereClause = whereExpr
    $('dataWhereInput').value = whereExpr
    $('clearFilterBtn').hidden = !state.whereClause && !state.orderByClause
    if (state.activeConnectionId && state.activeTable) {
      void loadTablePage(state.activeConnectionId, state.activeTable, 1, state.activeSchema)
    }
  }

  let lastCopiedSnapshot = null

  function clearCopiedSnapshot() {
    lastCopiedSnapshot = null
  }

  function normalizeClipboardEol(str) {
    return String(str ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  }

  function copyDataSelection(format = 'tsv', includeHeaders = false) {
    const pd = state.pageData
    const dataGridSel = getDataGridSel()
    if (!pd || !dataGridSel) return
    const visCols = getOrderedVisibleColumns()
    const allRows = getAllDisplayRows()
    const coords = dataGridSel.getSelectedCoords(50000)
    if (coords.length === 0) return
    const rowObjs = allRows.map((entry) => {
      const out = {}
      // Include all table columns (including hidden PK columns) so sql-update WHERE clauses
      // never lose non-null primary keys when PK columns are hidden or unselected.
      for (const col of pd.columns) {
        out[col.name] = getEffectiveCellValue(entry.rowKey, entry.data, col.name)
      }
      return out
    })
    const text = formatSelectionAsOutput(
      visCols,
      rowObjs,
      coords,
      format,
      includeHeaders,
      state.activeTable || 'table_name',
      state.activeSchema,
      getActiveConn()?.driver || 'sqlite',
      pd.primaryKey
    )
    if (format === 'tsv' || format === 'csv') {
      const rowSet = Array.from(new Set(coords.map((p) => p.r))).sort((a, b) => a - b)
      const colSet = Array.from(new Set(coords.map((p) => p.c))).sort((a, b) => a - b)
      const coordKeySet = new Set(coords.map((p) => `${p.r}:${p.c}`))
      const selHeaders = colSet.map((ci) => visCols[ci]?.name).filter(Boolean)
      const rawDataMatrix = rowSet.map((r) =>
        colSet.map((c) => {
          if (!coordKeySet.has(`${r}:${c}`)) return ''
          const col = visCols[c]
          if (!col) return null
          const val = rowObjs[r]?.[col.name]
          return val === undefined ? null : val
        })
      )
      const hasHeaders = Boolean(includeHeaders || format === 'csv')
      lastCopiedSnapshot = {
        text,
        format,
        headers: selHeaders,
        rawMatrix: hasHeaders ? [selHeaders, ...rawDataMatrix] : rawDataMatrix,
        hasHeaders,
      }
      setLastPanelCopiedText(text)
    } else {
      lastCopiedSnapshot = null
    }
    void copyText(text, `Copied ${coords.length} cell(s) (${format.toUpperCase()})`)
  }

  async function readPanelClipboardForMenu() {
    let clipText = ''
    if (navigator.clipboard?.readText) {
      try {
        clipText = await navigator.clipboard.readText()
      } catch {
        clipText = ''
      }
    }
    if (!clipText) {
      const fallback = getLastPanelCopiedText()
      if (fallback) clipText = fallback
    }
    const isCopiedNullCell =
      clipText === '' &&
      lastCopiedSnapshot !== null &&
      lastCopiedSnapshot.text === '' &&
      lastCopiedSnapshot.rawMatrix.length === 1 &&
      lastCopiedSnapshot.rawMatrix[0]?.length === 1
    return { clipText, hasPayload: clipText.length > 0 || isCopiedNullCell }
  }

  async function triggerPanelPasteNewRows() {
    const { clipText, hasPayload } = await readPanelClipboardForMenu()
    if (!hasPayload) {
      showBanner('Copy rows first (Ctrl+C), then click Paste as New Row(s)', 'neutral')
      return
    }
    pasteAsNewRowsInDataGrid(clipText)
  }

  async function triggerPanelPasteSmart() {
    const { clipText, hasPayload } = await readPanelClipboardForMenu()
    if (!hasPayload) {
      showBanner('Use Ctrl+V to paste directly into the grid', 'neutral')
      return
    }
    pasteDelimitedIntoDataGrid(clipText, { forceNewRows: false })
  }

  function resolvePanelClipboardPayload(clipboardText) {
    if (
      lastCopiedSnapshot &&
      lastCopiedSnapshot.rawMatrix.length > 0 &&
      normalizeClipboardEol(clipboardText) === normalizeClipboardEol(lastCopiedSnapshot.text)
    ) {
      return {
        matrix: lastCopiedSnapshot.rawMatrix,
        explicitHasHeaders: lastCopiedSnapshot.hasHeaders,
        sourceHeaders: lastCopiedSnapshot.headers,
      }
    }
    return {
      matrix: parseDelimitedClipboard(clipboardText),
      explicitHasHeaders: false,
      sourceHeaders: undefined,
    }
  }

  function coercePanelPastedValue(rawVal, originalValue, col) {
    if (rawVal === null || rawVal === undefined) {
      return null
    }
    if (typeof rawVal === 'object') {
      try {
        return JSON.stringify(rawVal)
      } catch {
        return String(rawVal)
      }
    }
    return coerceTypedCellInput(
      String(rawVal),
      originalValue,
      col.nativeType || col.type,
      col.nullable !== false
    )
  }

  function pasteAsNewRowsInDataGrid(clipboardText) {
    return pasteDelimitedIntoDataGrid(clipboardText, { forceNewRows: true })
  }

  function pasteDelimitedIntoDataGrid(clipboardText, options = {}) {
    if (
      state.dataLoading ||
      isSubmittingChanges() ||
      getActiveConn()?.readOnly ||
      isActiveDataObjectView()
    ) {
      return false
    }
    const pd = state.pageData
    if (!pd || !pd.columns?.length) return false

    const rawText = String(clipboardText ?? '')
    const isCopiedNullCell =
      rawText === '' &&
      lastCopiedSnapshot !== null &&
      lastCopiedSnapshot.text === '' &&
      lastCopiedSnapshot.rawMatrix.length === 1 &&
      lastCopiedSnapshot.rawMatrix[0]?.length === 1
    if (!rawText && !isCopiedNullCell) return false

    const { matrix, explicitHasHeaders, sourceHeaders } = resolvePanelClipboardPayload(rawText)
    if (matrix.length === 0) return false

    const isConnRo = Boolean(getActiveConn()?.readOnly)
    const visCols = getOrderedVisibleColumns()
    if (visCols.length === 0) return false
    const colIndexByName = new Map(pd.columns.map((c, idx) => [c.name, idx]))
    const visibleColIndices = visCols
      .map((c) => colIndexByName.get(c.name))
      .filter((idx) => idx !== undefined && idx >= 0)
    if (visibleColIndices.length === 0) return false

    const allRows = getAllDisplayRows()
    const dataGridSel = getDataGridSel()
    const coords = dataGridSel ? dataGridSel.getSelectedCoords(50000) : []
    let hasSelection = Boolean(dataGridSel?.hasSelection() && coords.length > 0)
    let selectionBBox = null
    if (hasSelection) {
      let startRow = coords[0].r
      let endRow = coords[0].r
      let startCol = coords[0].c
      let endCol = coords[0].c
      for (let i = 1; i < coords.length; i++) {
        if (coords[i].r < startRow) startRow = coords[i].r
        if (coords[i].r > endRow) endRow = coords[i].r
        if (coords[i].c < startCol) startCol = coords[i].c
        if (coords[i].c > endCol) endCol = coords[i].c
      }
      selectionBBox = { startRow, endRow, startCol, endCol }
    } else if (dataGridSel?.focus) {
      hasSelection = true
      selectionBBox = {
        startRow: dataGridSel.focus.r,
        endRow: dataGridSel.focus.r,
        startCol: dataGridSel.focus.c,
        endCol: dataGridSel.focus.c,
      }
    } else if (state.selectedRowKey && state.selectedCol) {
      const rIdx = allRows.findIndex((r) => r.rowKey === state.selectedRowKey)
      const cIdx = visCols.findIndex((c) => c.name === state.selectedCol)
      if (rIdx >= 0 && cIdx >= 0) {
        hasSelection = true
        selectionBBox = { startRow: rIdx, endRow: rIdx, startCol: cIdx, endCol: cIdx }
      }
    }

    const plan = planPanelGridPaste({
      matrix,
      hasSelection,
      selectionBBox,
      selectedCellCount: coords.length || (hasSelection ? 1 : 0),
      existingRowCount: allRows.length,
      visibleColIndices,
      allColumns: pd.columns,
      forceNewRows: Boolean(options.forceNewRows),
      explicitHasHeaders,
      sourceHeaders,
    })

    if (plan.mode === 'empty') return false

    if (plan.mode === 'fill') {
      let applied = 0
      let skippedReadOnly = 0
      for (const { r, c } of coords) {
        const entry = allRows[r]
        const col = visCols[c]
        if (!isDataCellEditable(entry, col, pd, isConnRo)) {
          skippedReadOnly++
          continue
        }
        const nextVal = coercePanelPastedValue(plan.fillValue, entry.data[col.name], col)
        if (nextVal === null && col.nullable === false) {
          skippedReadOnly++
          continue
        }
        stageCellValue(entry.rowKey, entry.data, col.name, nextVal, true)
        applied++
      }
      if (applied > 0) {
        renderDataGrid()
        renderStagingBar()
        renderValueInspector()
        const skippedNote = skippedReadOnly > 0 ? ` (${skippedReadOnly} read-only/PK skipped)` : ''
        showBanner(`Pasted ${applied} cell(s) into staged edits${skippedNote}`, 'success')
      } else if (skippedReadOnly > 0) {
        showBanner(
          'Selected cell(s) are read-only, deleted, or primary key — clear selection (Esc) or use Ctrl+Shift+V to paste as new rows',
          'warn'
        )
      }
      return true
    }

    let applied = 0
    let skippedReadOnly = 0
    let minVisCol = Number.POSITIVE_INFINITY
    let maxVisCol = -1
    let maxOverwrittenVisRow = plan.startVisRow

    for (const owRow of plan.overwrites) {
      const entry = allRows[owRow.targetVisRow]
      if (!entry || state.stagedDeletes.has(entry.rowKey)) {
        skippedReadOnly++
        continue
      }
      const isMultiColRow = owRow.cells.length > 1
      for (const cell of owRow.cells) {
        const col = pd.columns[cell.modelColIdx]
        if (!col) continue
        if (entry.isInsert && isMultiColRow && col.isAutoIncrement) continue
        if (!isDataCellEditable(entry, col, pd, isConnRo)) {
          skippedReadOnly++
          continue
        }
        const nextVal = coercePanelPastedValue(cell.rawValue, entry.data[col.name], col)
        if (nextVal === null && col.nullable === false) {
          skippedReadOnly++
          continue
        }
        stageCellValue(entry.rowKey, entry.data, col.name, nextVal, true)
        applied++
        if (owRow.targetVisRow > maxOverwrittenVisRow) {
          maxOverwrittenVisRow = owRow.targetVisRow
        }
        if (cell.visColIdx >= 0) {
          if (cell.visColIdx < minVisCol) minVisCol = cell.visColIdx
          if (cell.visColIdx > maxVisCol) maxVisCol = cell.visColIdx
        }
      }
    }

    let added = 0
    let firstTempId = null
    for (let i = plan.inserts.length - 1; i >= 0; i--) {
      const insRow = plan.inserts[i]
      if (insRow.cells.length === 0) {
        skippedReadOnly++
        continue
      }
      const values = {}
      for (const col of pd.columns) {
        if (
          !col.isAutoIncrement &&
          !col.isGenerated &&
          (col.defaultValue === null || col.defaultValue === undefined)
        ) {
          values[col.name] = null
        }
      }
      for (const cell of insRow.cells) {
        const targetCol = pd.columns[cell.modelColIdx]
        if (!targetCol || targetCol.isAutoIncrement || targetCol.isGenerated) continue
        const nextVal = coercePanelPastedValue(cell.rawValue, null, targetCol)
        if (
          nextVal === null &&
          targetCol.nullable === false &&
          targetCol.defaultValue !== null &&
          targetCol.defaultValue !== undefined
        ) {
          continue
        }
        values[targetCol.name] = nextVal
      }
      const tempId = `ins_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${i}`
      state.stagedInserts.unshift({ tempId, values, origin: 'paste' })
      firstTempId = tempId
      added++
    }

    if (applied > 0 || added > 0) {
      if (added > 0 && firstTempId) {
        const wrap = $('dataGridWrap')
        if (wrap) wrap.scrollTop = 0
        state.selectedRowKey = firstTempId
        state.selectedCol = visCols[0]?.name || pd.columns[0]?.name || null
      }
      renderDataGrid()
      if (added > 0 && !state.transposed) {
        getDataGridSel()?.selectRowRange(0, added - 1, true)
      } else if (applied > 0 && added === 0 && !state.transposed && dataGridSel) {
        const selStartCol = Number.isFinite(minVisCol) ? minVisCol : plan.startVisCol
        const selEndCol = maxVisCol >= selStartCol ? maxVisCol : selStartCol
        dataGridSel.selectCell(plan.startVisRow, selStartCol)
        if (maxOverwrittenVisRow !== plan.startVisRow || selEndCol !== selStartCol) {
          dataGridSel.selectCell(maxOverwrittenVisRow, selEndCol, { shift: true })
        }
      }
      renderStagingBar()
      renderValueInspector()
      const skippedNote =
        skippedReadOnly > 0
          ? !pd.canEdit
            ? ` (${skippedReadOnly} existing cell(s) skipped — table has no PK)`
            : ` (${skippedReadOnly} read-only/PK/deleted skipped)`
          : ''
      if (applied > 0 && added > 0) {
        showBanner(
          `Overwrote ${applied} cell(s) and inserted ${added} new row(s) (marked PASTE)${skippedNote} — review & click Submit`,
          'success'
        )
      } else if (added > 0) {
        showBanner(
          `Pasted ${added} new row(s) (marked PASTE)${skippedNote} — review & click Submit`,
          'success'
        )
      } else {
        showBanner(`Pasted ${applied} cell(s) into staged edits${skippedNote}`, 'success')
      }
    } else if (skippedReadOnly > 0) {
      showBanner(
        !pd.canEdit
          ? 'Table has no primary key — clear selection (Esc) or use Ctrl+Shift+V to paste as new rows.'
          : 'Selected cell(s) are read-only, deleted, or primary key — clear selection (Esc) or use Ctrl+Shift+V to paste as new rows.',
        'warn'
      )
    }
    return true
  }

  function bulkSetSelectedCellsValue(rawInput, options = {}) {
    if (isSubmittingChanges() || state.dataLoading || isActiveDataObjectView() || getActiveConn()?.readOnly) return
    const pd = state.pageData
    const dataGridSel = getDataGridSel()
    if (!pd || !dataGridSel) return
    const isConnRo = Boolean(getActiveConn()?.readOnly)
    const visCols = getOrderedVisibleColumns()
    const allRows = getAllDisplayRows()
    const coords = dataGridSel.getSelectedCoords(50000)
    if (coords.length === 0) return
    let updated = 0
    let skippedNotNull = 0
    for (const { r, c } of coords) {
      const entry = allRows[r]
      const col = visCols[c]
      if (!isDataCellEditable(entry, col, pd, isConnRo)) continue
      const isExplicitNull =
        rawInput === null ||
        (options.allowNullKeyword && String(rawInput).trim().toUpperCase() === 'NULL')
      if (isExplicitNull) {
        if (col.nullable === false) {
          skippedNotNull++
          continue
        }
        stageCellValue(entry.rowKey, entry.data, col.name, null, true)
        updated++
        continue
      }
      const nextVal = coerceTypedCellInput(
        String(rawInput),
        entry.data[col.name],
        col.nativeType || col.type,
        col.nullable !== false,
        options
      )
      stageCellValue(entry.rowKey, entry.data, col.name, nextVal, true)
      updated++
    }
    if (updated > 0) {
      renderDataGrid()
      renderStagingBar()
      renderValueInspector()
      showBanner(`Updated ${updated} cell(s) in staged edits`, 'success')
    } else if (skippedNotNull > 0) {
      showBanner('Selected column(s) are NOT NULL — cannot set NULL.', 'warn')
    }
  }

  function cloneSelectedRows() {
    if (isSubmittingChanges() || state.dataLoading || isActiveDataObjectView() || getActiveConn()?.readOnly) return
    const pd = state.pageData
    if (!pd) return
    const rowKeys = getSelectedDataRowKeys()
    if (rowKeys.length === 0) return
    const allRows = getAllDisplayRows()
    const rowByKey = new Map(allRows.map((r) => [r.rowKey, r]))
    const visCols = getOrderedVisibleColumns()
    let added = 0
    let firstTempId = null
    for (let i = rowKeys.length - 1; i >= 0; i--) {
      const source = rowByKey.get(rowKeys[i])
      if (!source) continue
      const values = {}
      for (const col of pd.columns) {
        values[col.name] =
          col.isAutoIncrement || col.isGenerated
            ? undefined
            : getEffectiveCellValue(source.rowKey, source.data, col.name)
      }
      const tempId = `ins_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      state.stagedInserts.unshift({ tempId, values, origin: 'clone' })
      firstTempId = tempId
      added++
    }
    if (added > 0 && firstTempId) {
      const wrap = $('dataGridWrap')
      if (wrap) wrap.scrollTop = 0
      state.selectedRowKey = firstTempId
      state.selectedCol = visCols[0]?.name || pd.columns[0]?.name || null
      renderDataGrid()
      if (!state.transposed) {
        getDataGridSel()?.selectRowRange(0, added - 1, true)
      }
      renderStagingBar()
      renderValueInspector()
      showBanner(`Cloned ${added} row(s) (marked CLONE) — review & click Submit`, 'success')
    }
  }

  function toggleDeleteSelectedRows() {
    if (isSubmittingChanges() || state.dataLoading || isActiveDataObjectView() || getActiveConn()?.readOnly) return
    const pd = state.pageData
    if (!pd) return
    const rowKeys = getSelectedDataRowKeys()
    if (rowKeys.length === 0) return
    const allRows = getAllDisplayRows()
    const rowByKey = new Map(allRows.map((r) => [r.rowKey, r]))
    const allAlreadyMarked = rowKeys.every((k) => state.stagedDeletes.has(k))
    const removedInsSet = new Set()
    for (const rk of rowKeys) {
      if (rk.startsWith('ins_')) {
        removedInsSet.add(rk)
        continue
      }
      if (!pd.canEdit) continue
      if (allAlreadyMarked) {
        state.stagedDeletes.delete(rk)
      } else if (!state.stagedDeletes.has(rk)) {
        const entry = rowByKey.get(rk)
        if (!entry) continue
        const pkCols =
          pd.primaryKey?.length > 0 ? pd.primaryKey : [pd.columns[0]?.name].filter(Boolean)
        const pks = {}
        for (const pk of pkCols) pks[pk] = entry.data[pk]
        state.stagedDeletes.set(rk, {
          primaryKeys: pks,
          originalRow: { ...entry.data },
        })
        state.stagedUpdates.delete(rk)
      }
    }
    if (removedInsSet.size > 0) {
      state.stagedInserts = state.stagedInserts.filter((r) => !removedInsSet.has(r.tempId))
      getDataGridSel()?.clear(true)
      state.selectedRowKey = null
      state.selectedCol = null
    }
    if (
      state.selectedRowKey &&
      state.selectedRowKey.startsWith('ins_') &&
      !state.stagedInserts.some((r) => r.tempId === state.selectedRowKey)
    ) {
      state.selectedRowKey = null
      state.selectedCol = null
    }
    renderDataGrid()
    renderStagingBar()
    renderValueInspector()
  }

  function resolveActiveColumnKey(rawKey) {
    const resolver = resolvePanelGridKeyResolver(state.pageData?.columns)
    return (resolver ? resolver.resolveKey(rawKey) : null) || rawKey
  }

  function ensureUserResizedSet(tblKey) {
    if (!state.userResizedColKeysByTable) state.userResizedColKeysByTable = {}
    if (!(state.userResizedColKeysByTable[tblKey] instanceof Set)) {
      state.userResizedColKeysByTable[tblKey] = new Set(
        Array.isArray(state.userResizedColKeysByTable[tblKey])
          ? state.userResizedColKeysByTable[tblKey]
          : []
      )
    }
    return state.userResizedColKeysByTable[tblKey]
  }

  function exportUserResizedColumnWidths(tblKey, allColNames, allOccKeys, allColWidths) {
    const resizedSet = ensureUserResizedSet(tblKey)
    const resolver = resolvePanelGridKeyResolver(state.pageData?.columns || allColNames)
    const out = {}
    for (const rawKey of resizedSet) {
      const oi = resolver ? resolver.resolveIndex(rawKey) : -1
      if (oi >= 0 && Number.isFinite(allColWidths[oi]) && allColWidths[oi] > 0) {
        out[allOccKeys[oi]] = Math.round(allColWidths[oi])
      }
    }
    return out
  }

  function syncColsPatchToDisplayState() {
    if (typeof patchTableDisplayState !== 'function') return
    const resolver = resolvePanelGridKeyResolver(state.pageData?.columns)
    const normalizeList = (set) => {
      const out = []
      const seen = new Set()
      for (const k of set) {
        const resolved = resolver ? resolver.resolveKey(k) : k
        if (resolved && !seen.has(resolved)) {
          seen.add(resolved)
          out.push(resolved)
        }
      }
      return out
    }
    patchTableDisplayState({
      pinnedColumns: normalizeList(getPinnedColsSet()),
      hiddenColumns: normalizeList(getHiddenColsSet()),
    })
  }

  function toggleColumnPinned(colKeyOrName) {
    const colKey = resolveActiveColumnKey(colKeyOrName)
    const set = getPinnedColsSet()
    if (set.has(colKey)) set.delete(colKey)
    else set.add(colKey)
    getDataGridSel()?.clear(true)
    renderDataGrid({ layoutOnly: true })
    if ($('dataColsPopover') && !$('dataColsPopover').hidden) renderDataColsPopoverList()
    syncColsPatchToDisplayState()
  }

  function toggleColumnHidden(colKeyOrName) {
    const pd = state.pageData
    if (!pd) return
    const colKey = resolveActiveColumnKey(colKeyOrName)
    const set = getHiddenColsSet()
    if (set.has(colKey)) {
      set.delete(colKey)
    } else {
      if (pd.columns.length - set.size <= 1) {
        showBanner('At least one column must remain visible.', 'neutral')
        if ($('dataColsPopover') && !$('dataColsPopover').hidden) renderDataColsPopoverList()
        return
      }
      set.add(colKey)
      getPinnedColsSet().delete(colKey)
    }
    getDataGridSel()?.clear(true)
    renderDataGrid({ layoutOnly: true })
    if ($('dataColsPopover') && !$('dataColsPopover').hidden) renderDataColsPopoverList()
    syncColsPatchToDisplayState()
  }

  function autoFitDataColumn(colKeyOrName) {
    const pd = state.pageData
    if (!pd) return
    const tblKey = getActiveTableKey()
    const colWidths = state.columnWidthsByTable[tblKey]
    const resolver = resolvePanelGridKeyResolver(pd.columns)
    if (!colWidths || !resolver) return
    const allColNames = pd.columns.map((c) => c.name)
    const allOccKeys = resolver.occKeys
    const origIdx = resolver.resolveIndex(colKeyOrName)
    if (origIdx < 0) return
    const colKey = allOccKeys[origIdx]
    const colDef = pd.columns[origIdx]
    const allRows = getAllDisplayRows()
    let maxLen = colDef.name.length + (colDef.isPrimaryKey ? 5 : 0) + 2
    for (const entry of allRows) {
      const val = getEffectiveCellValue(entry.rowKey, entry.data, colDef.name)
      const textLen =
        val == null ? 4 : (typeof val === 'object' ? JSON.stringify(val) : String(val)).length
      if (textLen > maxLen) maxLen = textLen
    }
    const nextW = Math.max(64, Math.min(440, Math.round(maxLen * 7.5 + 26)))
    colWidths[origIdx] = nextW
    ensureUserResizedSet(tblKey).add(colKey)
    renderDataGrid()
    if (typeof patchTableDisplayState === 'function') {
      patchTableDisplayState({
        columnWidths: exportUserResizedColumnWidths(tblKey, allColNames, allOccKeys, colWidths),
      })
    }
  }

  function exportCurrentDataPage(format, asDownload, ext, mime) {
    const pd = state.pageData
    if (!pd || !pd.columns?.length) return
    const visCols = getOrderedVisibleColumns()
    const allDisplayRows = getAllDisplayRows()
    const rows = allDisplayRows.map((entry) => {
      const out = {}
      for (const col of visCols) {
        out[col.name] = getEffectiveCellValue(entry.rowKey, entry.data, col.name)
      }
      return out
    })
    const sourceRows = allDisplayRows.map((entry) => {
      const out = {}
      for (const col of pd.columns) {
        out[col.name] = getEffectiveCellValue(entry.rowKey, entry.data, col.name)
      }
      return out
    })
    const text = formatExportData({
      columns: visCols,
      rows,
      sourceRows,
      format,
      tableName: state.activeTable || 'table_name',
      schema: state.activeSchema,
      driver: getActiveConn()?.driver || 'postgres',
      primaryKeys: pd.primaryKey,
    })
    if (asDownload) {
      const safeTbl = (state.activeTable || 'export').replace(/[^A-Za-z0-9_-]/g, '_')
      void downloadTextFile(`${safeTbl}_page${state.page}.${ext || 'txt'}`, text, mime).then(
        (status) => {
          if (status === 'cancelled') return
          showBanner(
            status === 'saved'
              ? `Saved ${rows.length} rows (Current Page · ${format.toUpperCase()})`
              : 'File download failed',
            status === 'saved' ? 'success' : 'danger'
          )
        }
      )
    } else {
      void copyText(text, `Exported ${rows.length} rows (Current Page · ${format.toUpperCase()})`)
    }
  }

  function computeDataFindMatches() {
    const q = (state.findQuery || '').trim().toLowerCase()
    const matches = []
    const matchSet = new Set()
    if (!q || !state.pageData) {
      state.findMatches = matches
      state.findMatchSet = matchSet
      state.findMatchIdx = -1
      return
    }
    const rawRows = dataVirt.active ? dataVirt.allRows : getAllDisplayRows()
    const allRows = state.transposed ? rawRows.slice(0, 100) : rawRows
    const visCols = dataVirt.active ? dataVirt.visCols : getOrderedVisibleColumns()
    for (let r = 0; r < allRows.length; r++) {
      const entry = allRows[r]
      for (let c = 0; c < visCols.length; c++) {
        const col = visCols[c]
        const val = getEffectiveCellValue(entry.rowKey, entry.data, col.name)
        if (val === null || val === undefined) continue
        const strVal = typeof val === 'object' ? JSON.stringify(val) : String(val)
        if (strVal.toLowerCase().includes(q)) {
          matches.push({ r, c, rowKey: entry.rowKey, colName: col.name })
          matchSet.add(`${r}:${c}`)
        }
      }
    }
    state.findMatches = matches
    state.findMatchSet = matchSet
    if (matches.length === 0) {
      state.findMatchIdx = -1
    } else if (state.findMatchIdx < 0 || state.findMatchIdx >= matches.length) {
      state.findMatchIdx = 0
    }
  }

  function applyFindClassesToRenderedDataRows() {
    const tbl = $('dataTable')
    if (!tbl) return
    const activeMatch =
      state.findMatchIdx >= 0 && state.findMatchIdx < state.findMatches.length
        ? state.findMatches[state.findMatchIdx]
        : null
    const tbody = tbl.tBodies?.[0] || tbl.querySelector('tbody')
    if (!tbody) return
    const rows = tbody.children
    for (let i = 0; i < rows.length; i++) {
      const tr = rows[i]
      if (!(tr instanceof HTMLElement)) continue
      const cells = tr.children
      for (let j = 0; j < cells.length; j++) {
        const td = cells[j]
        if (!(td instanceof HTMLElement) || td.dataset.colName === undefined) continue
        let isMatch = false
        let isActive = false
        if (td.dataset.rowIdx !== undefined && td.dataset.colIdx !== undefined) {
          const key = `${td.dataset.rowIdx}:${td.dataset.colIdx}`
          isMatch = state.findMatchSet.has(key)
          isActive = Boolean(
            activeMatch &&
              String(activeMatch.r) === td.dataset.rowIdx &&
              String(activeMatch.c) === td.dataset.colIdx
          )
        } else if (state.transposed) {
          const rk = td.dataset.rowKey
          const cn = td.dataset.colName
          if (state.findMatches.length > 0 && rk && cn) {
            for (let m = 0; m < state.findMatches.length; m++) {
              const fm = state.findMatches[m]
              if (fm.rowKey === rk && fm.colName === cn) {
                isMatch = true
                if (m === state.findMatchIdx) isActive = true
                break
              }
            }
          }
        }
        td.classList.toggle('cell-match', isMatch)
        td.classList.toggle('cell-match-active', isActive)
      }
    }
  }

  function updateDataFindHighlights(jumpToActive = false) {
    const countEl = $('dataFindCount')
    const prevBtn = $('dataFindPrevBtn')
    const nextBtn = $('dataFindNextBtn')
    computeDataFindMatches()
    if (state.findMatches.length === 0) {
      applyFindClassesToRenderedDataRows()
      if (countEl) countEl.textContent = '0/0'
      if (prevBtn) prevBtn.disabled = true
      if (nextBtn) nextBtn.disabled = true
      return
    }
    const activeMatch = state.findMatches[state.findMatchIdx]
    if (jumpToActive && activeMatch) {
      if (dataVirt.active) {
        ensureDataVirtualRowVisible(
          state.transposed ? activeMatch.c : activeMatch.r,
          state.transposed ? activeMatch.r : undefined
        )
      }
      applyFindClassesToRenderedDataRows()
      const tbl = $('dataTable')
      const activeTd =
        tbl?.querySelector(
          `tbody td[data-row-idx="${activeMatch.r}"][data-col-idx="${activeMatch.c}"]`
        ) ||
        (state.transposed
          ? Array.from(tbl?.querySelectorAll('tbody td[data-col-name]') || []).find(
              (el) =>
                el.dataset.rowKey === activeMatch.rowKey && el.dataset.colName === activeMatch.colName
            )
          : null)
      if (activeTd && typeof activeTd.scrollIntoView === 'function') {
        activeTd.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
    } else {
      applyFindClassesToRenderedDataRows()
    }
    if (countEl) countEl.textContent = `${state.findMatchIdx + 1}/${state.findMatches.length}`
    if (prevBtn) prevBtn.disabled = false
    if (nextBtn) nextBtn.disabled = false
  }

  function updateGridSelectionHighlight() {
    const dataGridSel = getDataGridSel()
    if (dataGridSel) {
      dataGridSel.applyDomClasses()
      renderDataSelectionStats()
      return
    }
    const tbl = $('dataTable')
    if (!tbl) return
    tbl.querySelectorAll('tr.row-selected').forEach((tr) => tr.classList.remove('row-selected'))
    tbl.querySelectorAll('td.cell-selected').forEach((td) => td.classList.remove('cell-selected'))
    if (!state.selectedRowKey) return
    if (!state.transposed) {
      tbl.querySelectorAll('tbody tr').forEach((tr) => {
        if (tr.dataset.rowKey === state.selectedRowKey) {
          tr.classList.add('row-selected')
        }
      })
    }
    if (state.selectedCol) {
      if (state.transposed && dataVirt.visCols.length > 0) {
        const cIdx = dataVirt.visCols.findIndex((c) => c.name === state.selectedCol)
        const rIdx = dataVirt.cappedRows.findIndex((r) => r.rowKey === state.selectedRowKey)
        if (cIdx >= 0 && rIdx >= 0) {
          const targetTd = tbl.querySelector(`tbody td[data-row-idx="${rIdx}"][data-col-idx="${cIdx}"]`)
          if (targetTd) {
            targetTd.classList.add('cell-selected')
            return
          }
        }
      }
      tbl.querySelectorAll('tbody td').forEach((td) => {
        if (
          td.dataset.rowKey === state.selectedRowKey &&
          td.dataset.colName === state.selectedCol
        ) {
          td.classList.add('cell-selected')
        }
      })
    }
  }

  function attachColumnResizeHandle(
    handle,
    colEl,
    thEl,
    isRowNum,
    colIdxOrBinding,
    colWidthsArg,
    syncTableWidthArg,
    getAutoFitWidthArg,
    rowNumStateKey = 'rowNumWidth',
    onResizeCommitArg = null
  ) {
    const getBinding = () =>
      colIdxOrBinding && typeof colIdxOrBinding === 'object'
        ? colIdxOrBinding
        : {
            colIdx: colIdxOrBinding,
            colWidths: colWidthsArg,
            syncTableWidth: syncTableWidthArg,
            getAutoFitWidth: getAutoFitWidthArg,
            onResizeCommit: onResizeCommitArg,
          }
    handle.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const prevCleanup = getActiveResizeCleanup()
      if (prevCleanup) prevCleanup()
      const binding = getBinding()
      const colIdx = binding.colIdx
      const colWidths = binding.colWidths
      const syncTableWidth = binding.syncTableWidth
      const onResizeCommit = binding.onResizeCommit
      const startX = e.clientX
      const startWidth = isRowNum ? state[rowNumStateKey] : colWidths[colIdx]
      const ownerTable = thEl.closest ? thEl.closest('table') : null
      const ownerWrap = ownerTable?.parentElement || null
      const mountedRowsCount = ownerTable?.tBodies?.[0]?.children?.length || ownerTable?.rows?.length || 0
      const mountedColsCount = ownerTable?.tHead?.rows?.[0]?.cells?.length || colWidths.length + 1
      const useGuideLine =
        Boolean(ownerTable?.classList?.contains('transposed')) ||
        mountedRowsCount * Math.max(1, mountedColsCount) >= 400
      let didMove = false
      handle.classList.add('resizing')
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      let guideEl = null
      let baseGuideX = startX
      let guideMinX = -Infinity
      let guideMaxX = Infinity
      if (useGuideLine) {
        ownerWrap?.classList?.add('grid-resizing')
        const handleRect = handle.getBoundingClientRect ? handle.getBoundingClientRect() : null
        const wrapRect = ownerWrap?.getBoundingClientRect ? ownerWrap.getBoundingClientRect() : null
        if (handleRect && handleRect.width > 0) {
          baseGuideX = handleRect.left + handleRect.width / 2
        }
        if (wrapRect && wrapRect.width > 0) {
          guideMinX = wrapRect.left
          guideMaxX = wrapRect.right
        }
        guideEl = document.createElement('div')
        guideEl.className = 'col-resize-guide'
        guideEl.style.top = `${wrapRect && wrapRect.height > 0 ? Math.round(wrapRect.top) : 0}px`
        guideEl.style.height = `${wrapRect && wrapRect.height > 0 ? Math.round(wrapRect.height) : 440}px`
        const clampedInitX = Math.max(guideMinX, Math.min(guideMaxX, Math.round(baseGuideX)))
        guideEl.style.transform = `translate3d(${clampedInitX}px, 0, 0)`
        const guideHost = document.body || ownerWrap || ownerTable
        if (guideHost) guideHost.appendChild(guideEl)
      }

      let pendingW = startWidth
      let resizeRafId = null
      const applyGuidePos = () => {
        resizeRafId = null
        if (!guideEl) return
        const rawX = Math.round(baseGuideX + (pendingW - startWidth))
        const clampedX = Math.max(guideMinX, Math.min(guideMaxX, rawX))
        guideEl.style.transform = `translate3d(${clampedX}px, 0, 0)`
      }
      const applyPendingResize = () => {
        resizeRafId = null
        if (isRowNum) {
          state[rowNumStateKey] = pendingW
        } else {
          colWidths[colIdx] = pendingW
        }
        colEl.style.width = `${pendingW}px`
        thEl.style.width = `${pendingW}px`
        syncTableWidth()
      }

      const onMove = (moveEvent) => {
        const delta = moveEvent.clientX - startX
        if (Math.abs(delta) >= 2) didMove = true
        const minW = isRowNum ? (rowNumStateKey === 'transposeFieldWidth' ? 80 : 48) : 50
        const nextW = Math.max(minW, Math.round(startWidth + delta))
        pendingW = nextW
        if (!useGuideLine) {
          if (isRowNum) {
            state[rowNumStateKey] = nextW
          } else {
            colWidths[colIdx] = nextW
          }
        }
        const tickFn = useGuideLine ? applyGuidePos : applyPendingResize
        if (typeof requestAnimationFrame === 'function') {
          if (resizeRafId === null) {
            resizeRafId = requestAnimationFrame(tickFn)
          }
        } else {
          tickFn()
        }
      }

      const cleanup = () => {
        if (resizeRafId !== null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(resizeRafId)
          resizeRafId = null
        }
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        window.removeEventListener('blur', onUp)
        setActiveResizeCleanup(null)
        handle.classList.remove('resizing')
        ownerWrap?.classList?.remove('grid-resizing')
        if (guideEl) {
          guideEl.remove()
          guideEl = null
        }
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      const onUp = () => {
        if (resizeRafId !== null) {
          if (typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(resizeRafId)
            resizeRafId = null
          }
          if (!useGuideLine) {
            applyPendingResize()
          }
        }
        if (useGuideLine && pendingW !== startWidth) {
          applyPendingResize()
        } else if (didMove) {
          syncTableWidth()
        }
        cleanup()
        if (didMove || (useGuideLine && pendingW !== startWidth)) {
          setSuppressSortClickUntil(Date.now() + 250)
          if (!isRowNum && typeof onResizeCommit === 'function') {
            onResizeCommit(colIdx, pendingW)
          }
        }
      }

      setActiveResizeCleanup(cleanup)
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      window.addEventListener('blur', onUp)
    })
    handle.addEventListener('dblclick', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const binding = getBinding()
      const colIdx = binding.colIdx
      const colWidths = binding.colWidths
      const syncTableWidth = binding.syncTableWidth
      const getAutoFitWidth = binding.getAutoFitWidth
      const onResizeCommit = binding.onResizeCommit
      const nextW = typeof getAutoFitWidth === 'function' ? getAutoFitWidth() : 56
      if (isRowNum) {
        state[rowNumStateKey] = nextW
      } else {
        colWidths[colIdx] = nextW
      }
      colEl.style.width = `${nextW}px`
      thEl.style.width = `${nextW}px`
      syncTableWidth()
      if (!isRowNum && typeof onResizeCommit === 'function') {
        onResizeCommit(colIdx, nextW)
      }
    })
  }

  function estimateCellWrappedLines(val, col, colWidthPx, wrapMaxLines) {
    if (!isWrappableCellValue(val, col.type)) return 1
    const explicit = countNormalizedLines(val, wrapMaxLines)
    if (explicit >= wrapMaxLines) return wrapMaxLines
    const text = typeof val === 'object' ? JSON.stringify(val) : String(val)
    const charsPerLine = Math.max(8, Math.floor((Math.max(48, colWidthPx || 120) - 14) / 7))
    if (text.length <= charsPerLine) return explicit
    let totalLines = 0
    const rawLines = text.split('\n')
    for (let i = 0; i < rawLines.length; i++) {
      totalLines += Math.max(1, Math.ceil(rawLines[i].length / charsPerLine))
      if (totalLines >= wrapMaxLines) return wrapMaxLines
    }
    return Math.min(wrapMaxLines, Math.max(explicit, totalLines))
  }

  function computeRowWrapLines(rowIdx, visCols, visColWidths, wrapMaxLines) {
    if (!dataRowHeightIndex.wrapEnabled || state.transposed) return 1
    const entry = dataVirt.allRows[rowIdx]
    if (!entry) return 1
    let maxLines = 1
    for (let c = 0; c < visCols.length; c++) {
      const col = visCols[c]
      const val = getEffectiveCellValue(entry.rowKey, entry.data, col.name)
      const lines = estimateCellWrappedLines(val, col, visColWidths[c], wrapMaxLines)
      if (lines > maxLines) {
        maxLines = lines
        if (maxLines >= wrapMaxLines) break
      }
    }
    return maxLines
  }

  function measureRowWrapLines(rowIdx, visCols, visColWidths, wrapMaxLines) {
    if (!dataRowHeightIndex.wrapEnabled || state.transposed) return 1
    const maxLines = computeRowWrapLines(rowIdx, visCols, visColWidths, wrapMaxLines)
    dataRowHeightIndex.setRowLines(rowIdx, maxLines)
    return maxLines
  }

  function applyCellHighlightClass(td, rowHl, colKey, colName, isSelected = false) {
    for (const cls of ALL_HIGHLIGHT_CLASSES) {
      td.classList.remove(cls)
    }
    td.classList.remove('datanoa-hl-row', 'datanoa-hl-cell')
    if (!rowHl) return
    const resolvedKey = colKey || dataVirt.colKeyByName?.get(colName) || colName
    const parsedKey = parseOccurrenceColumnKey(resolvedKey)
    const bareFallback = parsedKey && parsedKey.occurrence === 1 ? parsedKey.name : null
    const cellTone =
      rowHl.cellTonesByKey?.[resolvedKey] ??
      (bareFallback ? rowHl.cellTonesByKey?.[bareFallback] : null) ??
      null
    const res = resolveCellDisplayHighlight({
      isSelected,
      rowTone: rowHl.rowTone,
      cellTone,
    })
    if (res.className) {
      td.classList.add(res.className)
      if (res.source === 'cell') td.classList.add('datanoa-hl-cell')
      else if (res.source === 'row') td.classList.add('datanoa-hl-row')
    }
  }

  function renderDataCellContent(td, entry, col, val, fkInfo) {
    const pd = state.pageData
    const isConnRo = Boolean(getActiveConn()?.readOnly)
    const canEditCell = isDataCellEditable(entry, col, pd, isConnRo)
    td.dataset.rowKey = entry.rowKey
    td.dataset.colName = col.name
    td.dataset.editable = canEditCell ? '1' : '0'

    td.classList.remove('cell-null', 'cell-num', 'cell-edited', 'cell-wrap')
    td.textContent = ''
    if (entry.isInsert && val === undefined) {
      td.classList.add('cell-null')
      td.textContent = col.isAutoIncrement ? '(auto)' : '(default)'
    } else if (val === null || val === undefined) {
      td.classList.add('cell-null')
      td.textContent = 'NULL'
    } else {
      if (typeof val === 'number') td.classList.add('cell-num')
      td.textContent = typeof val === 'object' ? JSON.stringify(val) : String(val)
      if (!state.transposed && dataVirt.wrapCells && isWrappableCellValue(val, col.type)) {
        td.classList.add('cell-wrap')
      }
      if (fkInfo) {
        const fkBadge = document.createElement('span')
        fkBadge.className = 'fk-link-badge'
        fkBadge.textContent = '↗'
        fkBadge.title = `Go to ${fkInfo.referencedTable}.${fkInfo.referencedColumn}`
        td.appendChild(fkBadge)
      }
    }
    if (isCellStagedEdited(entry.rowKey, col.name)) {
      td.classList.add('cell-edited')
    }
    if (canEditCell) {
      td.title = fkInfo
        ? `Click to select · Double-click to edit · Ctrl+Click to jump to ${fkInfo.referencedTable}`
        : 'Click to select · Double-click to edit'
    } else if (fkInfo) {
      td.title = `Ctrl+Click to jump to ${fkInfo.referencedTable}`
    } else {
      td.title = ''
    }
  }

  function createDataVirtualRow(rowIdx) {
    const dataGridSel = getDataGridSel()
    const entry = dataVirt.allRows[rowIdx]
    const tr = document.createElement('tr')
    tr.dataset.rowKey = entry.rowKey
    tr.dataset.rowIdx = String(rowIdx)
    if (rowIdx % 2 === 1) tr.classList.add('row-even')
    if (entry.isInsert) tr.classList.add('row-inserted')
    const isRowDeleted = state.stagedDeletes.has(entry.rowKey)
    if (isRowDeleted) tr.classList.add('row-deleted')

    if (!state.transposed && dataVirt.wrapCells) {
      measureRowWrapLines(rowIdx, dataVirt.visCols, dataVirt.visColWidths, dataVirt.wrapMaxLines)
    }

    const rowHl = evaluateDataRowHighlight(entry)

    const tdNum = document.createElement('td')
    tdNum.className = 'td-rownum'
    tdNum.dataset.rowIdx = String(rowIdx)
    if (entry.isInsert) {
      const badge = document.createElement('span')
      badge.className = 'panel-row-badge'
      badge.textContent =
        entry.origin === 'clone' ? 'CLONE' : entry.origin === 'paste' ? 'PASTE' : 'NEW'
      tdNum.title = `${badge.textContent} row (staged INSERT — click Submit to save)`
      tdNum.appendChild(badge)
    } else {
      const existingNum = dataVirt.pageOffset + (rowIdx - dataVirt.stagedInsertCount) + 1
      tdNum.textContent = isRowDeleted ? `-${existingNum}` : String(existingNum)
    }
    tr.appendChild(tdNum)

    const activeMatch =
      state.findMatchIdx >= 0 && state.findMatchIdx < state.findMatches.length
        ? state.findMatches[state.findMatchIdx]
        : null

    for (let colIdx = 0; colIdx < dataVirt.visCols.length; colIdx++) {
      const col = dataVirt.visCols[colIdx]
      const colKey = dataVirt.visColKeys?.[colIdx] || col.name
      const td = document.createElement('td')
      td.dataset.rowIdx = String(rowIdx)
      td.dataset.colIdx = String(colIdx)
      td.dataset.colKey = colKey
      if (colIdx < dataVirt.pinnedCount) {
        td.classList.add('col-pinned')
        td.style.left = `${dataVirt.stickyLefts[colIdx]}px`
        if (colIdx === dataVirt.pinnedCount - 1) td.classList.add('col-pinned-last')
      }
      const val = getEffectiveCellValue(entry.rowKey, entry.data, col.name)
      const fkInfo = dataVirt.fkMap.get(col.name) || null
      renderDataCellContent(td, entry, col, val, fkInfo)
      applyCellHighlightClass(td, rowHl, colKey, col.name, false)
      if (state.findMatchSet.size > 0 && state.findMatchSet.has(`${rowIdx}:${colIdx}`)) {
        td.classList.add('cell-match')
        if (activeMatch && activeMatch.r === rowIdx && activeMatch.c === colIdx) {
          td.classList.add('cell-match-active')
        }
      }
      tr.appendChild(td)
    }
    dataGridSel?.applyClassesToRow(tr, rowIdx)
    return tr
  }

  function populateTransposedRowCells(tr, cIdx, hStart, hEnd) {
    const col = dataVirt.visCols[cIdx]
    const cappedRows = dataVirt.cappedRows
    const totalDataCols = cappedRows.length + (dataVirt.hasOverflowCol ? 1 : 0)
    const startCol = Math.max(0, Math.min(hStart, totalDataCols))
    const endCol = Math.max(startCol, Math.min(hEnd, totalDataCols))
    const dataEnd = Math.min(endCol, cappedRows.length)
    const showMore = dataVirt.hasOverflowCol && endCol === totalDataCols
    const rightSpan = Math.max(0, totalDataCols - endCol)

    const dataGridSel = getDataGridSel()

    // Remove everything after the sticky field <th>
    while (tr.children.length > 1) {
      const last = tr.lastElementChild
      if (!last) break
      const activeInp = last.querySelector?.('input.cell-edit-input')
      if (activeInp instanceof HTMLInputElement) {
        activeInp.dataset.scrollDetached = '1'
        activeInp.blur()
      }
      dataGridSel?.detachCell?.(last)
      last.remove()
    }

    if (startCol > 0) {
      const leftSp = document.createElement('td')
      leftSp.className = 'h-spacer-td'
      leftSp.colSpan = startCol
      tr.appendChild(leftSp)
    }

    const fkInfo = dataVirt.fkMap.get(col.name) || null
    const activeMatch =
      state.findMatchIdx >= 0 && state.findMatchIdx < state.findMatches.length
        ? state.findMatches[state.findMatchIdx]
        : null

    for (let rIdx = startCol; rIdx < dataEnd; rIdx++) {
      const entry = cappedRows[rIdx]
      const td = document.createElement('td')
      td.dataset.rowIdx = String(rIdx)
      td.dataset.colIdx = String(cIdx)
      if (entry.isInsert) td.style.background = 'color-mix(in srgb, var(--ok) 12%, var(--bg))'
      if (state.stagedDeletes.has(entry.rowKey)) td.style.textDecoration = 'line-through'
      const val = getEffectiveCellValue(entry.rowKey, entry.data, col.name)
      renderDataCellContent(td, entry, col, val, fkInfo)
      if (state.selectedRowKey === entry.rowKey && state.selectedCol === col.name) {
        td.classList.add('cell-selected')
      }
      if (state.findMatchSet.size > 0 && state.findMatchSet.has(`${rIdx}:${cIdx}`)) {
        td.classList.add('cell-match')
        if (activeMatch && activeMatch.r === rIdx && activeMatch.c === cIdx) {
          td.classList.add('cell-match-active')
        }
      }
      tr.appendChild(td)
    }
    if (showMore) {
      const moreTd = document.createElement('td')
      moreTd.className = 'cell-null'
      moreTd.textContent = `... (${dataVirt.allRows.length - 100} more)`
      tr.appendChild(moreTd)
    }
    if (rightSpan > 0) {
      const rightSp = document.createElement('td')
      rightSp.className = 'h-spacer-td'
      rightSp.colSpan = rightSpan
      tr.appendChild(rightSp)
    }
    dataGridSel?.applyClassesToRow(tr, cIdx)
  }

  function createTransposedVirtualRow(cIdx) {
    const col = dataVirt.visCols[cIdx]
    const totalDataCols = dataVirt.cappedRows.length + (dataVirt.hasOverflowCol ? 1 : 0)
    const hStart = dataVirt.active && dataVirt.transposed ? dataVirt.hStart : 0
    const hEnd = dataVirt.active && dataVirt.transposed ? dataVirt.hEnd : totalDataCols
    const tr = document.createElement('tr')
    tr.dataset.rowIdx = String(cIdx)
    const colHead = document.createElement('th')
    colHead.className = 'transpose-col-head'
    const colLabelSpan = document.createElement('span')
    colLabelSpan.textContent = col.name
    colHead.appendChild(colLabelSpan)
    if (col.isPrimaryKey) {
      const pkSpan = document.createElement('span')
      pkSpan.className = 'transpose-pk'
      pkSpan.textContent = ' [PK]'
      colHead.appendChild(pkSpan)
    }
    colHead.title = `${col.name}${col.isPrimaryKey ? ' [PK]' : ''}`
    tr.appendChild(colHead)
    populateTransposedRowCells(tr, cIdx, hStart, hEnd)
    return tr
  }

  function renderDataVirtualWindow(force = false) {
    if (!dataVirt.active || !dataVirt.tbody) return
    const wrap = $('dataGridWrap')
    const total = dataVirt.transposed ? dataVirt.visCols.length : dataVirt.allRows.length
    if (total === 0) return
    const scrollTop = wrap ? wrap.scrollTop : 0
    const viewportH = wrap ? wrap.clientHeight : 420
    let start = 0
    let end = total
    let topSpacerPx
    let bottomSpacerPx
    if (dataVirt.transposed) {
      const range = coreComputeVirtualRange(scrollTop, viewportH, total, VIRT_ROW_HEIGHT_PX, 4)
      start = range.start
      end = range.end
    } else if (dataRowHeightIndex.wrapEnabled && dataVirt.wrapCells) {
      let effectiveScrollTop = scrollTop
      const anchorRowIndex =
        effectiveScrollTop > 0 ? dataRowHeightIndex.findRowAtOffset(effectiveScrollTop) : 0
      const preRange = dataRowHeightIndex.getVisibleRange(
        effectiveScrollTop,
        viewportH,
        VIRT_OVERSCAN_ROWS
      )
      const reads = []
      for (let r = preRange.start; r < preRange.end; r++) {
        reads.push({
          row: r,
          lines: computeRowWrapLines(
            r,
            dataVirt.visCols,
            dataVirt.visColWidths,
            dataVirt.wrapMaxLines
          ),
        })
      }
      const batchRes = dataRowHeightIndex.measureBatch(reads, anchorRowIndex)
      if (wrap && batchRes.scrollTopDeltaPx !== 0) {
        effectiveScrollTop = Math.max(0, effectiveScrollTop + batchRes.scrollTopDeltaPx)
        wrap.scrollTop = effectiveScrollTop
      }
      const rangeAfter = dataRowHeightIndex.getVisibleRange(
        effectiveScrollTop,
        viewportH,
        VIRT_OVERSCAN_ROWS
      )
      if (rangeAfter.start < preRange.start || rangeAfter.end > preRange.end) {
        const extraReads = []
        for (let r = rangeAfter.start; r < preRange.start; r++) {
          extraReads.push({
            row: r,
            lines: computeRowWrapLines(
              r,
              dataVirt.visCols,
              dataVirt.visColWidths,
              dataVirt.wrapMaxLines
            ),
          })
        }
        for (let r = preRange.end; r < rangeAfter.end; r++) {
          extraReads.push({
            row: r,
            lines: computeRowWrapLines(
              r,
              dataVirt.visCols,
              dataVirt.visColWidths,
              dataVirt.wrapMaxLines
            ),
          })
        }
        if (extraReads.length > 0) {
          const extraRes = dataRowHeightIndex.measureBatch(extraReads, anchorRowIndex)
          if (wrap && extraRes.scrollTopDeltaPx !== 0) {
            effectiveScrollTop = Math.max(0, effectiveScrollTop + extraRes.scrollTopDeltaPx)
            wrap.scrollTop = effectiveScrollTop
          }
        }
      }
      const range = dataRowHeightIndex.getVisibleRange(
        effectiveScrollTop,
        viewportH,
        VIRT_OVERSCAN_ROWS
      )
      start = range.start
      end = range.end
      topSpacerPx = range.topSpacerPx
      bottomSpacerPx = range.bottomSpacerPx
    } else {
      const range = computeVirtualRange(scrollTop, viewportH, total)
      start = range.start
      end = range.end
    }

    let hChanged = false
    if (dataVirt.transposed) {
      const nextH = computeTransposedPanelColRange(
        wrap ? wrap.scrollLeft : 0,
        wrap ? wrap.clientWidth : 0,
        dataVirt.fieldWidth,
        dataVirt.rowColWidths
      )
      hChanged = nextH.hStart !== dataVirt.hStart || nextH.hEnd !== dataVirt.hEnd
      dataVirt.hStart = nextH.hStart
      dataVirt.hEnd = nextH.hEnd
    }

    const prevStart = dataVirt.start
    const prevEnd = dataVirt.end
    const didSyncVert = syncVirtualTableWindow({
      virt: dataVirt,
      total,
      start,
      end,
      rowHeightPx: VIRT_ROW_HEIGHT_PX,
      topSpacerPx,
      bottomSpacerPx,
      createRow: dataVirt.transposed ? createTransposedVirtualRow : createDataVirtualRow,
      selectionController: getDataGridSel(),
      onBeforeDetachRow: (node) => {
        const activeInp = node.querySelector('input.cell-edit-input')
        if (activeInp instanceof HTMLInputElement) {
          activeInp.dataset.scrollDetached = '1'
          activeInp.blur()
        }
      },
      force,
    })

    // If horizontal range changed while vertical window slid (or stayed identical), patch surviving
    // mounted transposed rows in-place so their horizontal cells stay synced with scrollLeft.
    if (dataVirt.transposed && hChanged && !force && prevStart >= 0 && prevEnd > prevStart) {
      const overlapStart = Math.max(start, prevStart)
      const overlapEnd = Math.min(end, prevEnd)
      if (!didSyncVert || overlapStart < overlapEnd) {
        const children = dataVirt.tbody.children
        for (let i = 0; i < children.length; i++) {
          const tr = children[i]
          if (!(tr instanceof HTMLElement) || tr.dataset.rowIdx === undefined) continue
          const cIdx = Number(tr.dataset.rowIdx)
          if (cIdx >= overlapStart && cIdx < overlapEnd) {
            populateTransposedRowCells(tr, cIdx, dataVirt.hStart, dataVirt.hEnd)
          }
        }
      }
    }
  }

  function ensureDataVirtualRowVisible(rowIdx, horizIdx) {
    if (!dataVirt.active) return
    const wrap = $('dataGridWrap')
    if (!wrap) return
    const useWrap = !dataVirt.transposed && dataRowHeightIndex.wrapEnabled && dataVirt.wrapCells
    const rowTop = useWrap ? dataRowHeightIndex.getRowOffset(rowIdx) : rowIdx * VIRT_ROW_HEIGHT_PX
    const rowH = useWrap ? dataRowHeightIndex.getRowHeight(rowIdx) : VIRT_ROW_HEIGHT_PX
    const rowBottom = rowTop + rowH
    const viewTop = wrap.scrollTop
    const effH = wrap.clientHeight > 0 ? wrap.clientHeight : 420
    const viewBottom = viewTop + Math.max(VIRT_ROW_HEIGHT_PX, effH - VIRT_ROW_HEIGHT_PX)
    if (rowTop < viewTop) {
      wrap.scrollTop = rowTop
    } else if (rowBottom > viewBottom) {
      wrap.scrollTop = Math.max(
        0,
        rowBottom - Math.max(VIRT_ROW_HEIGHT_PX, effH - VIRT_ROW_HEIGHT_PX)
      )
    }
    if (
      dataVirt.transposed &&
      typeof horizIdx === 'number' &&
      Number.isFinite(horizIdx) &&
      horizIdx >= 0 &&
      dataVirt.rowColWidths.length > 0
    ) {
      let colLeft = 0
      const limit = Math.min(horizIdx, dataVirt.rowColWidths.length - 1)
      for (let i = 0; i < limit; i++) {
        colLeft += Number(dataVirt.rowColWidths[i]) || 180
      }
      const colW = Number(dataVirt.rowColWidths[limit]) || 180
      const visibleW = Math.max(120, (wrap.clientWidth || 360) - (dataVirt.fieldWidth || 180))
      if (colLeft < wrap.scrollLeft) {
        wrap.scrollLeft = colLeft
      } else if (colLeft + colW > wrap.scrollLeft + visibleW) {
        wrap.scrollLeft = Math.max(0, colLeft - Math.floor(visibleW / 3))
      }
    } else if (
      !dataVirt.transposed &&
      typeof horizIdx === 'number' &&
      Number.isFinite(horizIdx) &&
      horizIdx >= dataVirt.pinnedCount &&
      horizIdx < dataVirt.visCols.length
    ) {
      const tbl = $('dataTable')
      const renderedTd = tbl?.querySelector(
        `tbody td[data-row-idx="${rowIdx}"][data-col-idx="${horizIdx}"]`
      )
      let cellLeftPx = state.rowNumWidth
      for (let i = 0; i < horizIdx; i++) {
        cellLeftPx += Number(dataVirt.visColWidths[i]) || 120
      }
      if (renderedTd instanceof HTMLElement && renderedTd.offsetLeft > 0) {
        cellLeftPx = renderedTd.offsetLeft
      }
      const cellWidthPx =
        renderedTd instanceof HTMLElement && renderedTd.offsetWidth > 0
          ? renderedTd.offsetWidth
          : Number(dataVirt.visColWidths[horizIdx]) || 120
      const nextScrollLeft = computeScrollLeftForFocusedCell({
        cellLeftPx,
        cellWidthPx,
        scrollLeftPx: wrap.scrollLeft || 0,
        viewportWidthPx: wrap.clientWidth || 300,
        totalPinnedWidthPx: dataVirt.totalPinnedWidthPx || state.rowNumWidth,
      })
      if (nextScrollLeft !== wrap.scrollLeft) {
        wrap.scrollLeft = nextScrollLeft
      }
    }
    renderDataVirtualWindow(false)
  }

  function measurePanelCellTextLen(val) {
    if (val == null) return 4
    return (typeof val === 'object' ? JSON.stringify(val) : String(val)).length
  }

  function computeInitialTransposedPanelWidths(visCols, cappedRows, stagedInsLen, hasOverflowCol) {
    let maxFieldChars = 'Column'.length + 2
    for (let i = 0; i < Math.min(visCols.length, 40); i++) {
      const col = visCols[i]
      const len = col.name.length + (col.isPrimaryKey ? 5 : 0)
      if (len > maxFieldChars) maxFieldChars = len
    }
    const fieldWidth = Math.max(140, Math.min(260, Math.round(maxFieldChars * 7.2 + 24)))
    const rowWidths = cappedRows.map((entry, idx) => {
      const labelText = entry.isInsert ? `+ New ${idx + 1}` : `Row ${idx - stagedInsLen + 1}`
      let maxChars = labelText.length + 4
      for (let ci = 0; ci < Math.min(visCols.length, 32); ci++) {
        const col = visCols[ci]
        const val = getEffectiveCellValue(entry.rowKey, entry.data, col.name)
        const cappedLen = Math.min(measurePanelCellTextLen(val), 34)
        if (cappedLen > maxChars) maxChars = cappedLen
      }
      return Math.max(160, Math.min(280, Math.round(maxChars * 7.5 + 24)))
    })
    if (hasOverflowCol) {
      rowWidths.push(150)
    }
    return { fieldWidth, rowWidths }
  }

  function renderTransposedDataGrid(tbl, tblKey, allRows, visCols, fkMap) {
    dataVirt.active = false
    dataVirt.transposed = false
    dataVirt.allRows = allRows
    dataVirt.visCols = visCols
    dataVirt.fkMap = fkMap
    dataVirt.start = -1
    dataVirt.end = -1

    const stagedInsLen = state.stagedInserts.length
    const cappedRows = allRows.slice(0, 100)
    const hasOverflowCol = allRows.length > 100
    const expectedDataColCount = cappedRows.length + (hasOverflowCol ? 1 : 0)

    if (!state.transposeWidthsByTable) state.transposeWidthsByTable = {}
    let tWidths = state.transposeWidthsByTable[tblKey]
    if (
      !tWidths ||
      !Array.isArray(tWidths.rowWidths) ||
      tWidths.rowWidths.length !== expectedDataColCount
    ) {
      const computed = computeInitialTransposedPanelWidths(
        visCols,
        cappedRows,
        stagedInsLen,
        hasOverflowCol
      )
      tWidths = {
        fieldWidth:
          tWidths && typeof tWidths.fieldWidth === 'number'
            ? tWidths.fieldWidth
            : computed.fieldWidth,
        rowWidths: computed.rowWidths,
      }
      state.transposeWidthsByTable[tblKey] = tWidths
    }
    state.transposeFieldWidth = tWidths.fieldWidth
    const rowColWidths = tWidths.rowWidths
    const hasDataCols = rowColWidths.length > 0

    let fieldColEl = null
    let dataColEls = []
    if (hasDataCols) {
      const colgroup = document.createElement('colgroup')
      fieldColEl = document.createElement('col')
      fieldColEl.style.width = `${state.transposeFieldWidth}px`
      colgroup.appendChild(fieldColEl)
      dataColEls = rowColWidths.map((w) => {
        const colEl = document.createElement('col')
        colEl.style.width = `${w}px`
        colgroup.appendChild(colEl)
        return colEl
      })
      tbl.appendChild(colgroup)
    }

    let transposeMounted = false
    const syncTransposeTableWidth = () => {
      tWidths.fieldWidth = state.transposeFieldWidth
      dataVirt.fieldWidth = state.transposeFieldWidth
      if (!hasDataCols) {
        tbl.style.width = '100%'
        return
      }
      let total = state.transposeFieldWidth
      for (let i = 0; i < rowColWidths.length; i++) {
        total += rowColWidths[i]
      }
      tbl.style.width = `${total}px`
      if (transposeMounted && dataVirt.active && dataVirt.transposed) {
        renderDataVirtualWindow(false)
      }
    }
    syncTransposeTableWidth()

    const buildTransposeHeaderCell = (
      labelText,
      thClass,
      colEl,
      widthPx,
      isFieldCol,
      colIdx,
      getAutoFitWidth
    ) => {
      const th = document.createElement('th')
      if (thClass) th.className = thClass
      if (colEl) th.style.width = `${widthPx}px`
      const inner = document.createElement('div')
      inner.className = 'th-inner'
      const label = document.createElement('span')
      label.className = 'th-label'
      label.textContent = labelText
      label.title = labelText
      inner.appendChild(label)
      th.appendChild(inner)
      if (colEl) {
        const handle = document.createElement('div')
        handle.className = 'col-resize-handle'
        attachColumnResizeHandle(
          handle,
          colEl,
          th,
          isFieldCol,
          colIdx,
          rowColWidths,
          syncTransposeTableWidth,
          getAutoFitWidth,
          'transposeFieldWidth'
        )
        th.appendChild(handle)
      }
      return th
    }

    const getFieldAutoFitWidth = () => {
      let maxChars = 'Column'.length + 2
      for (let i = 0; i < visCols.length; i++) {
        const col = visCols[i]
        const len = col.name.length + (col.isPrimaryKey ? 5 : 0)
        if (len > maxChars) maxChars = len
      }
      return Math.max(80, Math.min(440, Math.round(maxChars * 7.5 + 26)))
    }

    const thead = document.createElement('thead')
    const hr = document.createElement('tr')
    hr.appendChild(
      buildTransposeHeaderCell(
        'Column',
        'transpose-col-head',
        fieldColEl,
        state.transposeFieldWidth,
        true,
        -1,
        getFieldAutoFitWidth
      )
    )
    cappedRows.forEach((entry, idx) => {
      const labelText = entry.isInsert ? `+ New ${idx + 1}` : `Row ${idx - stagedInsLen + 1}`
      const getRowAutoFitWidth = () => {
        let maxChars = labelText.length + 2
        for (let ci = 0; ci < visCols.length; ci++) {
          const col = visCols[ci]
          const val = getEffectiveCellValue(entry.rowKey, entry.data, col.name)
          const textLen = measurePanelCellTextLen(val)
          if (textLen > maxChars) maxChars = textLen
        }
        return Math.max(80, Math.min(440, Math.round(maxChars * 7.5 + 26)))
      }
      hr.appendChild(
        buildTransposeHeaderCell(
          labelText,
          'transpose-row-head',
          dataColEls[idx],
          rowColWidths[idx],
          false,
          idx,
          getRowAutoFitWidth
        )
      )
    })
    if (hasOverflowCol) {
      const moreText = `+${allRows.length - 100} more rows`
      const moreIdx = cappedRows.length
      hr.appendChild(
        buildTransposeHeaderCell(
          moreText,
          'transpose-row-head',
          dataColEls[moreIdx],
          rowColWidths[moreIdx],
          false,
          moreIdx,
          () => Math.max(90, Math.min(360, Math.round(moreText.length * 7.5 + 26)))
        )
      )
    }
    thead.appendChild(hr)
    tbl.appendChild(thead)

    const tbody = document.createElement('tbody')
    const dataWrap = $('dataGridWrap')
    const canVirtualizeTransposed = Boolean(
      dataWrap &&
        ((visCols.length > 20 && (dataWrap.clientHeight || 0) > 0) ||
          (expectedDataColCount > 16 && (dataWrap.clientWidth || 0) > 0))
    )
    dataVirt.rowColWidths = rowColWidths
    dataVirt.fieldWidth = state.transposeFieldWidth
    if (canVirtualizeTransposed) {
      const colSpan = 1 + expectedDataColCount
      const topSpacerTr = document.createElement('tr')
      topSpacerTr.className = 'virt-spacer-row'
      topSpacerTr.style.display = 'none'
      const topSpacerTd = document.createElement('td')
      topSpacerTd.colSpan = colSpan
      topSpacerTr.appendChild(topSpacerTd)

      const bottomSpacerTr = document.createElement('tr')
      bottomSpacerTr.className = 'virt-spacer-row'
      bottomSpacerTr.style.display = 'none'
      const bottomSpacerTd = document.createElement('td')
      bottomSpacerTd.colSpan = colSpan
      bottomSpacerTr.appendChild(bottomSpacerTd)

      tbody.append(topSpacerTr, bottomSpacerTr)
      tbl.appendChild(tbody)

      dataVirt.active = true
      dataVirt.transposed = true
      dataVirt.allRows = allRows
      dataVirt.cappedRows = cappedRows
      dataVirt.hasOverflowCol = hasOverflowCol
      dataVirt.visCols = visCols
      dataVirt.fkMap = fkMap
      dataVirt.tbody = tbody
      dataVirt.topSpacerTr = topSpacerTr
      dataVirt.topSpacerTd = topSpacerTd
      dataVirt.bottomSpacerTr = bottomSpacerTr
      dataVirt.bottomSpacerTd = bottomSpacerTd
      dataVirt.start = -1
      dataVirt.end = -1
      dataVirt.hStart = -1
      dataVirt.hEnd = -1
      computeDataFindMatches()
      renderDataVirtualWindow(true)
      transposeMounted = true
    } else {
      dataVirt.active = false
      dataVirt.transposed = false
      dataVirt.cappedRows = cappedRows
      dataVirt.hasOverflowCol = hasOverflowCol
      dataVirt.hStart = 0
      dataVirt.hEnd = expectedDataColCount
      const frag = document.createDocumentFragment()
      for (let cIdx = 0; cIdx < visCols.length; cIdx++) {
        frag.appendChild(createTransposedVirtualRow(cIdx))
      }
      tbody.appendChild(frag)
      tbl.appendChild(tbody)
    }
  }

  function clearPanelDataGridPools() {
    dataVirt.colgroupEl = null
    dataVirt.theadEl = null
    dataVirt.headerRowEl = null
    dataVirt.rowNumColEl = null
    dataVirt.rowNumThEl = null
    dataVirt.headerPageDataRef = null
    dataVirt.lastRenderedPageDataRef = null
    dataVirt.lastRenderedStagedCount = -1
    dataVirt.colKeyByObjRef = null
    dataVirt.colKeyByObj = null
    dataVirt.draggedHeaderCol = null
    dataVirt.syncTableWidthFn = null
    dataVirt.colPoolByKey.clear()
    dataVirt.thPoolByKey.clear()
  }

  function syncOrderedChildren(parent, desiredChildren) {
    const desiredSet = new Set(desiredChildren)
    const existing = parent.children
    for (let i = existing.length - 1; i >= 0; i--) {
      const child = existing[i]
      if (!desiredSet.has(child)) {
        child.remove()
      }
    }
    let nextNode = null
    for (let i = desiredChildren.length - 1; i >= 0; i--) {
      const child = desiredChildren[i]
      if (child.parentNode !== parent || child.nextSibling !== nextNode) {
        parent.insertBefore(child, nextNode)
      }
      nextNode = child
    }
  }

  function syncPanelDataTableWidth(tbl, allColWidths, origIdxByKey) {
    let total = state.rowNumWidth
    const colKeys = dataVirt.visColKeys
    const colWidths = dataVirt.visColWidths
    for (let ci = 0; ci < colKeys.length; ci++) {
      const oi = origIdxByKey.get(colKeys[ci]) ?? 0
      const w = colWidths[ci] || 120
      allColWidths[oi] = w
      total += w
    }
    tbl.style.width = `${total}px`
    if (
      !state.transposed &&
      dataVirt.active &&
      dataVirt.tbody &&
      dataVirt.tbody.parentNode === tbl &&
      dataVirt.visCols.length > 0 &&
      $('dataTable') === tbl
    ) {
      recomputePinnedForViewport()
    }
  }

  function ensurePanelColumnElements({
    col,
    colKey,
    colIdx,
    colWidth,
    isPinned,
    isPinnedLast,
    stickyLeft,
    visColWidths,
    syncTableWidth,
    allRows,
    origIdxByKey,
    allColWidths,
    userResizedSet,
    tblKey,
    allColNames,
    allOccKeys,
    dataGridSel,
  }) {
    let colEl = dataVirt.colPoolByKey.get(colKey)
    if (!colEl) {
      colEl = document.createElement('col')
      dataVirt.colPoolByKey.set(colKey, colEl)
    }
    colEl.style.width = `${colWidth}px`

    const isSorted = state.sortCol === col.name
    let th = dataVirt.thPoolByKey.get(colKey)
    if (!th) {
      th = document.createElement('th')
      th.dataset.colName = col.name
      th.dataset.colKey = colKey
      th.draggable = true

      th.addEventListener('dragstart', (e) => {
        dataVirt.draggedHeaderCol = colKey
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', colKey)
        }
      })
      th.addEventListener('dragover', (e) => {
        const src = dataVirt.draggedHeaderCol || e.dataTransfer?.getData('text/plain')
        if (!src || src === colKey) return
        e.preventDefault()
        th.classList.add('th-drop-target')
      })
      th.addEventListener('dragleave', () => {
        th.classList.remove('th-drop-target')
      })
      th.addEventListener('drop', (e) => {
        e.preventDefault()
        th.classList.remove('th-drop-target')
        const src = dataVirt.draggedHeaderCol || e.dataTransfer?.getData('text/plain')
        dataVirt.draggedHeaderCol = null
        if (src && src !== colKey) {
          reorderColumnByDrop?.(src, colKey, 'before')
        }
      })
      th.addEventListener('dragend', () => {
        dataVirt.draggedHeaderCol = null
        dataVirt.headerRowEl?.querySelectorAll('.th-drop-target').forEach((el) => el.classList.remove('th-drop-target'))
      })

      const inner = document.createElement('div')
      inner.className = 'th-inner'
      const label = document.createElement('span')
      label.className = 'th-label'
      inner.appendChild(label)

      const colGrip = document.createElement('button')
      colGrip.type = 'button'
      colGrip.className = 'th-col-grip'
      colGrip.title = `Select column "${col.name}"`
      colGrip.setAttribute('aria-label', `Select column ${col.name}`)
      colGrip.textContent = '▾'
      colGrip.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const activeColIdx = Number(th.dataset.colIdx)
        if (Number.isFinite(activeColIdx)) {
          dataGridSel?.selectCol(activeColIdx, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
        }
        $('dataGridWrap')?.focus({ preventScroll: true })
      })
      inner.appendChild(colGrip)

      const resizeHandle = document.createElement('div')
      resizeHandle.className = 'col-resize-handle'
      const resizeBinding = {
        colIdx,
        colWidths: visColWidths,
        syncTableWidth,
        getAutoFitWidth: null,
        onResizeCommit: null,
      }
      th._panelResizeBinding = resizeBinding
      th._panelInnerEl = inner
      th._panelLabelEl = label
      th._panelGripEl = colGrip
      th._panelSortIconEl = null
      attachColumnResizeHandle(resizeHandle, colEl, th, false, resizeBinding, null, null, null, 'rowNumWidth')

      th.append(inner, resizeHandle)
      th.addEventListener('click', (e) => {
        if (Date.now() < getSuppressSortClickUntil()) return
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          e.preventDefault()
          const activeColIdx = Number(th.dataset.colIdx)
          if (Number.isFinite(activeColIdx)) {
            dataGridSel?.selectCol(activeColIdx, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
          }
          $('dataGridWrap')?.focus({ preventScroll: true })
          return
        }
        if (state.sortCol === col.name) {
          state.sortDir = state.sortDir === 'ASC' ? 'DESC' : 'ASC'
        } else {
          state.sortCol = col.name
          state.sortDir = 'ASC'
        }
        state.orderByClause = ''
        $('dataOrderInput').value = ''
        if (state.activeConnectionId && state.activeTable) {
          void loadTablePage(state.activeConnectionId, state.activeTable, 1, state.activeSchema)
        }
      })
      dataVirt.thPoolByKey.set(colKey, th)
    }

    th.style.width = `${colWidth}px`
    th.dataset.colIdx = String(colIdx)
    th.classList.toggle('sorted', isSorted)
    th.classList.toggle('col-pinned', isPinned)
    th.classList.toggle('col-pinned-last', isPinnedLast)
    th.style.left = isPinned ? `${stickyLeft}px` : ''
    th._panelLabelEl.textContent = `${isPinned ? '• ' : ''}${col.name}${col.isPrimaryKey ? ' [PK]' : ''}`

    if (isSorted) {
      let sortIcon = th._panelSortIconEl
      if (!sortIcon) {
        sortIcon = document.createElement('span')
        sortIcon.className = 'th-sort-icon'
        th._panelSortIconEl = sortIcon
      }
      if (th.dataset.sortDir !== state.sortDir || sortIcon.children.length === 0) {
        sortIcon.textContent = ''
        sortIcon.appendChild(createSortSvg(state.sortDir))
        th.dataset.sortDir = state.sortDir
      }
      if (sortIcon.parentNode !== th._panelInnerEl || sortIcon.nextSibling !== th._panelGripEl) {
        th._panelInnerEl.insertBefore(sortIcon, th._panelGripEl)
      }
    } else if (th._panelSortIconEl) {
      th._panelSortIconEl.remove()
      th.dataset.sortDir = ''
    }

    const binding = th._panelResizeBinding
    binding.colIdx = colIdx
    binding.colWidths = visColWidths
    binding.syncTableWidth = syncTableWidth
    binding.getAutoFitWidth = () => {
      let maxLen = col.name.length + (col.isPrimaryKey ? 5 : 0) + 2
      const sampleRows = allRows.length > 500 ? allRows.slice(0, 500) : allRows
      for (let r = 0; r < sampleRows.length; r++) {
        const entry = sampleRows[r]
        const val = getEffectiveCellValue(entry.rowKey, entry.data, col.name)
        const textLen =
          val == null
            ? 4
            : (typeof val === 'object' ? JSON.stringify(val) : String(val)).length
        if (textLen > maxLen) maxLen = textLen
      }
      return Math.max(64, Math.min(440, Math.round(maxLen * 7.5 + 26)))
    }
    binding.onResizeCommit = (ci, nextW) => {
      const cKey = dataVirt.visColKeys[ci]
      if (!cKey || typeof patchTableDisplayState !== 'function') return
      const oi = origIdxByKey.get(cKey)
      if (oi !== undefined) allColWidths[oi] = nextW
      userResizedSet.add(cKey)
      patchTableDisplayState({
        columnWidths: exportUserResizedColumnWidths(tblKey, allColNames, allOccKeys, allColWidths),
      })
    }

    return { colEl, th }
  }

  function patchMountedPanelRowColumnsInPlace({ rulesChanged, wrapChanged, dataGridSel }) {
    const tbody = dataVirt.tbody
    if (!tbody) return
    const visCols = dataVirt.visCols
    const visColKeys = dataVirt.visColKeys
    const pinnedCount = dataVirt.pinnedCount
    const stickyLefts = dataVirt.stickyLefts
    const colSpan = visCols.length + 1
    if (dataVirt.topSpacerTd) dataVirt.topSpacerTd.colSpan = colSpan
    if (dataVirt.bottomSpacerTd) dataVirt.bottomSpacerTd.colSpan = colSpan

    const visKeySet = new Set(visColKeys)
    const activeMatch =
      state.findMatchIdx >= 0 && state.findMatchIdx < state.findMatches.length
        ? state.findMatches[state.findMatchIdx]
        : null
    const hasFindMatches = state.findMatchSet.size > 0
    const hasHighlightRules = Array.isArray(dataVirt.highlightRules) && dataVirt.highlightRules.length > 0

    const bodyRows = tbody.children
    for (let r = 0; r < bodyRows.length; r++) {
      const tr = bodyRows[r]
      if (tr === dataVirt.topSpacerTr || tr === dataVirt.bottomSpacerTr) continue
      if (tr.dataset?.rowIdx === undefined) continue
      const rowIdx = Number(tr.dataset.rowIdx)
      const entry = dataVirt.allRows[rowIdx]
      if (!entry) continue

      let tdNum = null
      const tdByKey = new Map()
      const rowChildren = tr.children
      for (let i = rowChildren.length - 1; i >= 0; i--) {
        const node = rowChildren[i]
        if (node.classList?.contains('td-rownum')) {
          tdNum = node
          continue
        }
        const key = node.dataset?.colKey
        if (key && visKeySet.has(key) && !tdByKey.has(key)) {
          tdByKey.set(key, node)
        } else {
          node.remove()
        }
      }

      const needsRowHl = hasHighlightRules && (rulesChanged || tdByKey.size < visCols.length)
      const rowHl = needsRowHl ? evaluateDataRowHighlight(entry) : null
      const desiredCells = []
      if (tdNum) desiredCells.push(tdNum)

      for (let colIdx = 0; colIdx < visCols.length; colIdx++) {
        const col = visCols[colIdx]
        const colKey = visColKeys[colIdx] || col.name
        let td = tdByKey.get(colKey)
        const isNewCell = !td
        if (!td) {
          td = document.createElement('td')
          td.dataset.rowIdx = String(rowIdx)
          td.dataset.colKey = colKey
          const val = getEffectiveCellValue(entry.rowKey, entry.data, col.name)
          const fkInfo = dataVirt.fkMap.get(col.name) || null
          renderDataCellContent(td, entry, col, val, fkInfo)
        } else if (wrapChanged) {
          if (!dataVirt.wrapCells || state.transposed) {
            td.classList.remove('cell-wrap')
          } else {
            const val = getEffectiveCellValue(entry.rowKey, entry.data, col.name)
            td.classList.toggle('cell-wrap', isWrappableCellValue(val, col.type))
          }
        }
        td.dataset.colIdx = String(colIdx)
        const isPinned = colIdx < pinnedCount
        td.classList.toggle('col-pinned', isPinned)
        td.classList.toggle('col-pinned-last', isPinned && colIdx === pinnedCount - 1)
        td.style.left = isPinned ? `${stickyLefts[colIdx]}px` : ''

        if (rulesChanged || (isNewCell && hasHighlightRules)) {
          applyCellHighlightClass(td, rowHl, colKey, col.name, false)
        }
        const isMatch = hasFindMatches && state.findMatchSet.has(`${rowIdx}:${colIdx}`)
        const isActiveMatch = Boolean(
          isMatch && activeMatch && activeMatch.r === rowIdx && activeMatch.c === colIdx
        )
        td.classList.toggle('cell-match', isMatch)
        td.classList.toggle('cell-match-active', isActiveMatch)
        desiredCells.push(td)
      }

      syncOrderedChildren(tr, desiredCells)
      dataGridSel?.applyClassesToRow(tr, rowIdx)
    }
  }

  function renderDataGrid(opts = {}) {
    const prevCleanup = getActiveResizeCleanup()
    if (prevCleanup) prevCleanup()
    if (dataVirt.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(dataVirt.rafId)
      dataVirt.rafId = null
    }
    const dataGridSel = getDataGridSel()
    const pd = state.pageData
    const footer = $('dataFooter')
    const tbl = $('dataTable')
    if (state.dataLoading && (!state.silentDataRefresh || !pd || !pd.columns || pd.columns.length === 0)) {
      dataVirt.active = false
      dataVirt.start = -1
      dataVirt.end = -1
      clearPanelDataGridPools()
      $('dataEmpty').hidden = true
      $('dataGridWrap').hidden = false
      $('dataPager').hidden = false
      if (footer) footer.hidden = false
      renderDataSelectionStats()
      tbl.textContent = ''
      tbl.style.width = '100%'
      const thead = document.createElement('thead')
      const htr = document.createElement('tr')
      const thIdx = document.createElement('th')
      thIdx.style.width = '40px'
      thIdx.textContent = '#'
      htr.appendChild(thIdx)
      for (let c = 0; c < 3; c++) {
        const th = document.createElement('th')
        const bar = document.createElement('div')
        bar.className = 'panel-skeleton-bar'
        bar.style.width = `${65 + c * 15}px`
        th.appendChild(bar)
        htr.appendChild(th)
      }
      thead.appendChild(htr)
      tbl.appendChild(thead)
      const tbody = document.createElement('tbody')
      for (let r = 0; r < 6; r++) {
        const tr = document.createElement('tr')
        const tdIdx = document.createElement('td')
        tdIdx.style.color = 'var(--t3)'
        tdIdx.textContent = String(r + 1)
        tr.appendChild(tdIdx)
        for (let c = 0; c < 3; c++) {
          const td = document.createElement('td')
          const bar = document.createElement('div')
          bar.className = 'panel-skeleton-bar'
          bar.style.width = `${55 + ((r * 19 + c * 23) % 35)}%`
          td.appendChild(bar)
          tr.appendChild(td)
        }
        tbody.appendChild(tr)
      }
      tbl.appendChild(tbody)
      return
    }
    if (!pd || !pd.columns || pd.columns.length === 0) {
      dataVirt.active = false
      dataVirt.allRows = []
      dataVirt.visCols = []
      dataVirt.start = -1
      dataVirt.end = -1
      clearPanelDataGridPools()
      $('dataEmpty').hidden = false
      $('dataGridWrap').hidden = true
      $('dataPager').hidden = true
      if (footer) footer.hidden = true
      renderStagingBar()
      return
    }
    $('dataEmpty').hidden = true
    $('dataGridWrap').hidden = false
    $('dataPager').hidden = false
    if (footer) footer.hidden = false
    const pageSizeSelect = $('pageSizeSelect')
    if (pageSizeSelect instanceof HTMLSelectElement) {
      pageSizeSelect.value = String(state.pageSize || pd.pageSize || 100)
    }

    const conn = getActiveConn()
    const isConnRo = Boolean(conn?.readOnly)
    const allRows = getAllDisplayRows()
    const tblKey = getActiveTableKey()
    const visCols = getOrderedVisibleColumns()
    const pinnedSet = getPinnedColsSet(tblKey)
    const fkMap = getActiveForeignKeyMap()
    tbl.classList.toggle('transposed', state.transposed)

    if (state.transposed) {
      clearPanelDataGridPools()
      tbl.textContent = ''
      dataVirt.wrapCells = false
      dataRowHeightIndex.setWrapEnabled(false)
      renderTransposedDataGrid(tbl, tblKey, allRows, visCols, fkMap)
    } else {
      const displayEntry = getActiveTableDisplayEntry?.(tblKey) || null
      if (
        !Array.isArray(state.columnWidthsByTable[tblKey]) ||
        state.columnWidthsByTable[tblKey].length !== pd.columns.length
      ) {
        state.columnWidthsByTable[tblKey] = computeInitialColumnWidths(pd.columns, allRows)
      }
      const allColWidths = state.columnWidthsByTable[tblKey]
      const colResolver = resolvePanelGridKeyResolver(pd.columns)
      const allOccKeys = colResolver ? colResolver.occKeys : []
      const origIdxByKey = colResolver ? colResolver.indexByKey : new Map()
      const allColNames =
        dataVirt.lastRenderedPageDataRef === pd &&
        Array.isArray(dataVirt.allColNames) &&
        dataVirt.allColNames.length === pd.columns.length
          ? dataVirt.allColNames
          : pd.columns.map((c) => c.name)

      if (dataVirt.colKeyByObjRef !== pd.columns || !dataVirt.colKeyByObj || !dataVirt.colKeyByName) {
        dataVirt.colKeyByObj = new Map(pd.columns.map((c, idx) => [c, allOccKeys[idx]]))
        const byName = new Map()
        for (let idx = 0; idx < allColNames.length; idx++) {
          if (!byName.has(allColNames[idx])) {
            byName.set(allColNames[idx], allOccKeys[idx])
          }
        }
        dataVirt.colKeyByName = byName
        dataVirt.colKeyByObjRef = pd.columns
      }
      const colKeyByObj = dataVirt.colKeyByObj

      const userResizedSet = ensureUserResizedSet(tblKey)
      if (displayEntry?.columnWidths) {
        for (const [rawKey, w] of Object.entries(displayEntry.columnWidths)) {
          const oi = colResolver ? colResolver.resolveIndex(rawKey) : -1
          if (oi >= 0 && typeof w === 'number' && Number.isFinite(w) && w > 0) {
            allColWidths[oi] = w
            userResizedSet.add(allOccKeys[oi])
          }
        }
      }
      const visColKeys = visCols.map((c, ci) => colKeyByObj.get(c) ?? allOccKeys[ci] ?? c.name)
      const visColWidths = visColKeys.map((k) => allColWidths[origIdxByKey.get(k) ?? 0] || 120)

      const wrapEl = $('dataGridWrap')
      const viewportW = wrapEl?.clientWidth || 800
      const widthsByKey = {}
      visColKeys.forEach((colKey, ci) => {
        widthsByKey[colKey] = visColWidths[ci]
      })
      const resolvedPinnedSet = new Set()
      for (const k of pinnedSet) {
        resolvedPinnedSet.add((colResolver ? colResolver.resolveKey(k) : null) || k)
      }
      const pinnedCandidateKeys = visColKeys.filter((k) => resolvedPinnedSet.has(k))
      const pinnedCap = computePinnedColumnsViewportCap({
        pinnedKeys: pinnedCandidateKeys,
        widthsByKey,
        viewportWidthPx: viewportW,
        rowNumWidthPx: state.rowNumWidth,
      })
      const pinnedCount = pinnedCap.activePinnedKeys.length
      const totalPinnedWidthPx = pinnedCap.totalPinnedWidthPx
      const stickyLefts = []
      let accLeft = state.rowNumWidth
      for (let i = 0; i < visColKeys.length; i++) {
        stickyLefts.push(i < pinnedCount ? (pinnedCap.stickyLeftByKey[visColKeys[i]] ?? accLeft) : accLeft)
        if (i < pinnedCount) accLeft += visColWidths[i]
      }

      const wrapCells = Boolean(displayEntry?.wrapCells)
      const wrapMaxLines = clampWrapMaxLines(displayEntry?.wrapMaxLines ?? DEFAULT_WRAP_MAX_LINES)
      const highlightRules = Array.isArray(displayEntry?.highlightRules)
        ? displayEntry.highlightRules
        : []

      const stagedCount = typeof getStagedCount === 'function' ? getStagedCount() : 0
      const rulesChanged = !areHighlightRulesEqual(dataVirt.highlightRules, highlightRules)
      const wrapChanged = dataVirt.wrapCells !== wrapCells || dataVirt.wrapMaxLines !== wrapMaxLines
      const pageDataChanged = dataVirt.lastRenderedPageDataRef !== pd
      const stagedChanged = dataVirt.lastRenderedStagedCount !== stagedCount
      const canPatchMountedGrid =
        opts?.layoutOnly === true &&
        Boolean(dataVirt.active) &&
        !dataVirt.transposed &&
        allRows.length > 0 &&
        Boolean(dataVirt.tbody && dataVirt.tbody.parentNode === tbl) &&
        Boolean(dataVirt.colgroupEl && dataVirt.colgroupEl.parentNode === tbl) &&
        Boolean(dataVirt.theadEl && dataVirt.theadEl.parentNode === tbl) &&
        Boolean(dataVirt.headerRowEl) &&
        !pageDataChanged &&
        dataVirt.allRows.length === allRows.length &&
        !stagedChanged

      if (!canPatchMountedGrid) {
        if (dataVirt.headerPageDataRef !== pd) {
          dataVirt.colPoolByKey.clear()
          dataVirt.thPoolByKey.clear()
          dataVirt.rowNumColEl = null
          dataVirt.rowNumThEl = null
          dataVirt.headerPageDataRef = pd
        }
        dataVirt.colgroupEl = null
        dataVirt.theadEl = null
        dataVirt.headerRowEl = null
        tbl.textContent = ''
      }

      if (!canPatchMountedGrid || dataRowHeightIndex.rowCount !== allRows.length) {
        dataRowHeightIndex.reset(allRows.length)
      }
      dataRowHeightIndex.setWrapEnabled(wrapCells)
      dataRowHeightIndex.setMaxLines(wrapMaxLines)

      if (pageDataChanged || stagedChanged || rulesChanged) {
        bumpAllHighlightRevisions()
      }

      const pageOffset = ((pd.page || 1) - 1) * (pd.pageSize || state.pageSize || 100)
      dataVirt.visCols = visCols
      dataVirt.visColKeys = visColKeys
      dataVirt.visColWidths = visColWidths
      dataVirt.pinnedCandidateKeys = pinnedCandidateKeys
      dataVirt.pinnedCount = pinnedCount
      dataVirt.stickyLefts = stickyLefts
      dataVirt.totalPinnedWidthPx = totalPinnedWidthPx
      dataVirt.wrapCells = wrapCells
      dataVirt.wrapMaxLines = wrapMaxLines
      dataVirt.highlightRules = highlightRules
      dataVirt.allColNames = allColNames
      dataVirt.fkMap = fkMap
      dataVirt.pageOffset = pageOffset
      dataVirt.stagedInsertCount = state.stagedInserts.length
      dataVirt.isConnRo = isConnRo
      dataVirt.canEditTable = Boolean(pd.canEdit)
      dataVirt.draggedHeaderCol = null

      const syncTableWidth = () => syncPanelDataTableWidth(tbl, allColWidths, origIdxByKey)
      dataVirt.syncTableWidthFn = syncTableWidth

      let colgroup = dataVirt.colgroupEl
      let rowNumColEl = dataVirt.rowNumColEl
      if (!colgroup || !rowNumColEl) {
        colgroup = document.createElement('colgroup')
        rowNumColEl = document.createElement('col')
        colgroup.appendChild(rowNumColEl)
        dataVirt.colgroupEl = colgroup
        dataVirt.rowNumColEl = rowNumColEl
      }
      rowNumColEl.style.width = `${state.rowNumWidth}px`

      let thead = dataVirt.theadEl
      let hRow = dataVirt.headerRowEl
      let thIdx = dataVirt.rowNumThEl
      if (!thead || !hRow || !thIdx) {
        thead = document.createElement('thead')
        hRow = document.createElement('tr')
        thIdx = document.createElement('th')
        thIdx.style.cursor = 'pointer'
        thIdx.style.left = '0px'
        thIdx.dataset.cornerSelect = '1'
        thIdx.title = 'Click to Select All (Ctrl+A)'
        const idxInner = document.createElement('div')
        idxInner.className = 'th-inner'
        const idxLabel = document.createElement('span')
        idxLabel.className = 'th-label'
        idxLabel.style.textAlign = 'right'
        idxLabel.textContent = '#'
        idxInner.appendChild(idxLabel)
        const idxResize = document.createElement('div')
        idxResize.className = 'col-resize-handle'
        const rowNumBinding = {
          colIdx: -1,
          colWidths: visColWidths,
          syncTableWidth,
          getAutoFitWidth: null,
          onResizeCommit: null,
        }
        thIdx._rowNumResizeBinding = rowNumBinding
        attachColumnResizeHandle(idxResize, rowNumColEl, thIdx, true, rowNumBinding, null, null, null, 'rowNumWidth')
        thIdx.append(idxInner, idxResize)
        thIdx.addEventListener('click', (e) => {
          if (Date.now() < getSuppressSortClickUntil()) return
          e.stopPropagation()
          dataGridSel?.selectAll()
        })
        thead.appendChild(hRow)
        dataVirt.theadEl = thead
        dataVirt.headerRowEl = hRow
        dataVirt.rowNumThEl = thIdx
      }
      thIdx.style.width = `${state.rowNumWidth}px`
      if (thIdx._rowNumResizeBinding) {
        thIdx._rowNumResizeBinding.colWidths = visColWidths
        thIdx._rowNumResizeBinding.syncTableWidth = syncTableWidth
      }

      const desiredCols = [rowNumColEl]
      const desiredThs = [thIdx]
      for (let colIdx = 0; colIdx < visCols.length; colIdx++) {
        const col = visCols[colIdx]
        const colKey = visColKeys[colIdx]
        const isPinned = colIdx < pinnedCount
        const { colEl, th } = ensurePanelColumnElements({
          col,
          colKey,
          colIdx,
          colWidth: visColWidths[colIdx],
          isPinned,
          isPinnedLast: isPinned && colIdx === pinnedCount - 1,
          stickyLeft: stickyLefts[colIdx],
          visColWidths,
          syncTableWidth,
          allRows,
          origIdxByKey,
          allColWidths,
          userResizedSet,
          tblKey,
          allColNames,
          allOccKeys,
          dataGridSel,
        })
        desiredCols.push(colEl)
        desiredThs.push(th)
      }
      syncOrderedChildren(colgroup, desiredCols)
      syncOrderedChildren(hRow, desiredThs)

      if (!canPatchMountedGrid) {
        tbl.appendChild(colgroup)
        tbl.appendChild(thead)
      }

      let totalWidthPx = state.rowNumWidth
      for (let ci = 0; ci < visColWidths.length; ci++) {
        totalWidthPx += visColWidths[ci] || 120
      }
      tbl.style.width = `${totalWidthPx}px`

      if (allRows.length === 0) {
        dataVirt.active = false
        dataVirt.allRows = []
        dataVirt.start = -1
        dataVirt.end = -1
        dataVirt.tbody = null
        dataVirt.lastRenderedPageDataRef = pd
        dataVirt.lastRenderedStagedCount = stagedCount
        const tbody = document.createElement('tbody')
        const emptyTr = document.createElement('tr')
        const emptyTd = document.createElement('td')
        emptyTd.colSpan = visCols.length + 1
        emptyTd.className = 'cell-null'
        emptyTd.style.textAlign = 'center'
        emptyTd.style.padding = '18px 12px'
        emptyTd.textContent = state.whereClause
          ? `No rows in "${state.activeTable || 'table'}" match the WHERE filter.`
          : `Table "${state.activeTable || 'table'}" has no rows.`
        emptyTr.appendChild(emptyTd)
        tbody.appendChild(emptyTr)
        tbl.appendChild(tbody)
      } else if (canPatchMountedGrid) {
        dataVirt.allRows = allRows
        computeDataFindMatches()
        patchMountedPanelRowColumnsInPlace({ rulesChanged, wrapChanged, dataGridSel })
        renderDataVirtualWindow(false)
        dataVirt.lastRenderedPageDataRef = pd
        dataVirt.lastRenderedStagedCount = stagedCount
      } else {
        const tbody = document.createElement('tbody')
        const topSpacerTr = document.createElement('tr')
        topSpacerTr.className = 'virt-spacer-row'
        topSpacerTr.style.display = 'none'
        const topSpacerTd = document.createElement('td')
        topSpacerTd.colSpan = visCols.length + 1
        topSpacerTr.appendChild(topSpacerTd)

        const bottomSpacerTr = document.createElement('tr')
        bottomSpacerTr.className = 'virt-spacer-row'
        bottomSpacerTr.style.display = 'none'
        const bottomSpacerTd = document.createElement('td')
        bottomSpacerTd.colSpan = visCols.length + 1
        bottomSpacerTr.appendChild(bottomSpacerTd)

        tbody.append(topSpacerTr, bottomSpacerTr)
        tbl.appendChild(tbody)

        dataVirt.active = true
        dataVirt.transposed = false
        dataVirt.allRows = allRows
        dataVirt.tbody = tbody
        dataVirt.topSpacerTr = topSpacerTr
        dataVirt.topSpacerTd = topSpacerTd
        dataVirt.bottomSpacerTr = bottomSpacerTr
        dataVirt.bottomSpacerTd = bottomSpacerTd
        dataVirt.start = -1
        dataVirt.end = -1
        dataVirt.topSpacerPx = -1
        dataVirt.bottomSpacerPx = -1
        dataVirt.lastRenderedPageDataRef = pd
        dataVirt.lastRenderedStagedCount = stagedCount

        if (wrapCells) {
          const preMeasureCount =
            pd.columns.length * allRows.length <= 15000
              ? Math.min(allRows.length, 500)
              : Math.min(allRows.length, 60)
          for (let r = 0; r < preMeasureCount; r++) {
            measureRowWrapLines(r, visCols, visColWidths, wrapMaxLines)
          }
        }

        computeDataFindMatches()
        renderDataVirtualWindow(true)
      }
    }

    const totalPages = Math.max(
      1,
      Math.ceil(pd.totalRows / (pd.pageSize || state.pageSize || 100))
    )
    $('dataPagerInfo').textContent = `${pd.totalRows} rows${pd.truncated ? ' (truncated)' : ''} · Page ${pd.page} / ${totalPages}`
    $('prevPageBtn').disabled = pd.page <= 1
    $('nextPageBtn').disabled = pd.page >= totalPages
    if (state.transposed) {
      updateGridSelectionHighlight()
      updateDataFindHighlights(false)
    } else {
      const countEl = $('dataFindCount')
      const prevBtn = $('dataFindPrevBtn')
      const nextBtn = $('dataFindNextBtn')
      if (state.findMatches.length === 0) {
        if (countEl) countEl.textContent = '0/0'
        if (prevBtn) prevBtn.disabled = true
        if (nextBtn) nextBtn.disabled = true
      } else {
        if (countEl) countEl.textContent = `${state.findMatchIdx + 1}/${state.findMatches.length}`
        if (prevBtn) prevBtn.disabled = false
        if (nextBtn) nextBtn.disabled = false
      }
    }
    syncDataControlsDisabled()
    renderStagingBar()
  }

  function startInlineEdit(td, rowKey, rowObj, col, currentVal) {
    const pd = state.pageData
    const dataGridSel = getDataGridSel()
    const entry =
      (dataVirt.active && td.dataset.rowIdx !== undefined
        ? dataVirt.allRows[Number(td.dataset.rowIdx)]
        : null) ||
      getAllDisplayRows().find((r) => r.rowKey === rowKey) || {
        rowKey,
        data: rowObj,
        isInsert: rowKey.startsWith('ins_'),
        origin: null,
      }
    if (!isDataCellEditable(entry, col, pd, Boolean(getActiveConn()?.readOnly))) return
    if (isBinaryPanelCellValue(currentVal)) {
      showBanner(`Binary/BLOB cell "${col.name}" cannot be edited inline as text.`, 'warn')
      return
    }
    const column = col.name
    if (td.querySelector('input')) return
    const originPageData = state.pageData
    const originTableKey = getActiveTableKey()
    const initialEditText =
      currentVal === null || currentVal === undefined
        ? ''
        : typeof currentVal === 'object'
          ? JSON.stringify(currentVal)
          : String(currentVal)
    const input = document.createElement('input')
    input.className = 'cell-edit-input'
    input.value = initialEditText
    td.textContent = ''
    td.appendChild(input)
    input.focus()
    input.select()

    let done = false
    let userTyped = false
    input.addEventListener('input', () => {
      userTyped = true
    })

    const restoreCell = () => {
      if (state.pageData !== originPageData || getActiveTableKey() !== originTableKey) return
      const fkInfo = (dataVirt.active ? dataVirt.fkMap : getActiveForeignKeyMap()).get(column) || null
      renderDataCellContent(td, entry, col, getEffectiveCellValue(rowKey, rowObj, column), fkInfo)
    }
    const cancel = () => {
      if (done) return
      done = true
      restoreCell()
    }
    const commit = () => {
      if (done) return
      done = true
      if (state.pageData !== originPageData || getActiveTableKey() !== originTableKey) {
        return
      }
      if (!userTyped && input.value === initialEditText) {
        restoreCell()
        return
      }
      const nextVal = coerceTypedCellInput(
        input.value,
        rowObj[column],
        col.nativeType || col.type,
        col.nullable !== false
      )
      stageCellValue(rowKey, rowObj, column, nextVal, false, td)
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        if (!userTyped && input.value === initialEditText) {
          cancel()
        } else {
          commit()
        }
        $('dataGridWrap')?.focus({ preventScroll: true })
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancel()
        $('dataGridWrap')?.focus({ preventScroll: true })
      } else if (e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        if (done) return
        done = true
        if (
          state.pageData === originPageData &&
          getActiveTableKey() === originTableKey &&
          (input.value !== initialEditText || (userTyped && currentVal === null))
        ) {
          const nextVal = coerceTypedCellInput(
            input.value,
            rowObj[column],
            col.nativeType || col.type,
            col.nullable !== false
          )
          stageCellValue(rowKey, rowObj, column, nextVal, false, td)
        } else {
          restoreCell()
        }

        if (
          dataVirt.active &&
          td.dataset.rowIdx !== undefined &&
          td.dataset.colIdx !== undefined
        ) {
          const curR = Number(td.dataset.rowIdx)
          const curC = Number(td.dataset.colIdx)
          const step = e.shiftKey ? -1 : 1
          let targetR = -1
          let targetC = -1
          if (state.transposed) {
            const totalR = dataVirt.cappedRows.length
            const totalC = dataVirt.visCols.length
            const maxSteps = totalR * totalC
            let linear = curC * totalR + curR + step
            for (let checked = 0; checked < maxSteps && linear >= 0 && linear < maxSteps; checked++) {
              const nc = Math.floor(linear / totalR)
              const nr = linear % totalR
              const candEntry = dataVirt.cappedRows[nr]
              const candCol = dataVirt.visCols[nc]
              if (
                isDataCellEditable(candEntry, candCol, state.pageData, Boolean(getActiveConn()?.readOnly))
              ) {
                targetR = nr
                targetC = nc
                break
              }
              linear += step
            }
          } else {
            const totalR = dataVirt.allRows.length
            const totalC = dataVirt.visCols.length
            const maxSteps = totalR * totalC
            let linear = curR * totalC + curC + step
            for (let checked = 0; checked < maxSteps && linear >= 0 && linear < maxSteps; checked++) {
              const nr = Math.floor(linear / totalC)
              const nc = linear % totalC
              const candEntry = dataVirt.allRows[nr]
              const candCol = dataVirt.visCols[nc]
              if (
                isDataCellEditable(candEntry, candCol, state.pageData, Boolean(getActiveConn()?.readOnly))
              ) {
                targetR = nr
                targetC = nc
                break
              }
              linear += step
            }
          }
          if (targetR >= 0 && targetC >= 0) {
            ensureDataVirtualRowVisible(
              state.transposed ? targetC : targetR,
              state.transposed ? targetR : undefined
            )
            dataGridSel?.selectCell(targetR, targetC)
            const freshTd = $('dataTable')?.querySelector(
              `tbody td[data-row-idx="${targetR}"][data-col-idx="${targetC}"]`
            )
            const freshEntry = state.transposed
              ? dataVirt.cappedRows[targetR]
              : dataVirt.allRows[targetR]
            const freshCol = dataVirt.visCols[targetC]
            if (freshTd && freshEntry && freshCol) {
              if (typeof freshTd.scrollIntoView === 'function') {
                freshTd.scrollIntoView({ block: 'nearest', inline: 'nearest' })
              }
              startInlineEdit(
                freshTd,
                freshEntry.rowKey,
                freshEntry.data,
                freshCol,
                getEffectiveCellValue(freshEntry.rowKey, freshEntry.data, freshCol.name)
              )
            }
          }
        } else {
          const tbl = $('dataTable')
          const editableTds = tbl
            ? Array.from(tbl.querySelectorAll('tbody td[data-editable="1"]'))
            : []
          const curIdx = editableTds.indexOf(td)
          const nextIdx = curIdx >= 0 ? curIdx + (e.shiftKey ? -1 : 1) : -1
          const freshTd = nextIdx >= 0 && nextIdx < editableTds.length ? editableTds[nextIdx] : null
          if (freshTd && freshTd.dataset.rowKey && freshTd.dataset.colName) {
            if (
              dataGridSel &&
              freshTd.dataset.rowIdx !== undefined &&
              freshTd.dataset.colIdx !== undefined
            ) {
              dataGridSel.selectCell(Number(freshTd.dataset.rowIdx), Number(freshTd.dataset.colIdx))
            } else {
              state.selectedRowKey = freshTd.dataset.rowKey
              state.selectedCol = freshTd.dataset.colName
              updateGridSelectionHighlight()
              renderStagingBar()
              renderValueInspector()
            }
            const freshEntry = getAllDisplayRows().find((r) => r.rowKey === freshTd.dataset.rowKey)
            const freshCol = state.pageData?.columns?.find(
              (c) => c.name === freshTd.dataset.colName
            )
            if (freshEntry && freshCol) {
              if (typeof freshTd.scrollIntoView === 'function') {
                freshTd.scrollIntoView({ block: 'nearest', inline: 'nearest' })
              }
              startInlineEdit(
                freshTd,
                freshEntry.rowKey,
                freshEntry.data,
                freshCol,
                getEffectiveCellValue(freshEntry.rowKey, freshEntry.data, freshCol.name)
              )
            }
          }
        }
      }
    })
    input.addEventListener('blur', () => {
      if (done) return
      // Never auto-commit or stage stale edits when virtual scrolling or table switch detaches the row.
      if (
        input.dataset.scrollDetached === '1' ||
        state.pageData !== originPageData ||
        getActiveTableKey() !== originTableKey
      ) {
        cancel()
        return
      }
      if (input.value !== initialEditText || (userTyped && currentVal === null)) {
        commit()
      } else {
        cancel()
      }
    })
  }

  function buildDataChangesPayload() {
    const updates = []
    for (const item of state.stagedUpdates.values()) {
      updates.push({
        primaryKeys: item.primaryKeys,
        changes: item.changes,
        originalRow: item.originalRow,
      })
    }
    const deletes = []
    const deleteRows = []
    for (const item of state.stagedDeletes.values()) {
      const hasWrappedShape =
        item &&
        typeof item === 'object' &&
        'primaryKeys' in item &&
        item.primaryKeys &&
        typeof item.primaryKeys === 'object'
      const pks = hasWrappedShape ? item.primaryKeys : item
      deletes.push(pks)
      deleteRows.push(
        hasWrappedShape && item.originalRow && typeof item.originalRow === 'object'
          ? { ...item.originalRow }
          : { ...pks }
      )
    }
    const inserts = state.stagedInserts.map((r) => {
      const clean = {}
      for (const [k, v] of Object.entries(r.values)) {
        if (v !== undefined) {
          clean[k] = v
        }
      }
      return clean
    })
    return {
      connectionId: state.activeConnectionId,
      table: state.activeTable,
      ...(state.activeSchema ? { schema: state.activeSchema } : {}),
      ...(inserts.length > 0 ? { inserts } : {}),
      ...(updates.length > 0 ? { updates } : {}),
      ...(deletes.length > 0 ? { deletes, deleteRows } : {}),
    }
  }

  function updateInspectorMetaAndJson() {
    const inp = $('valueInspectorText')
    const countEl = $('inspectorMetaCount')
    const jsonBadge = $('inspectorJsonBadge')
    const fmtBtn = $('inspectorFormatJsonBtn')
    const minBtn = $('inspectorMinifyJsonBtn')
    if (!inp) return
    const txt = inp.value || ''
    const lineCount = txt.length === 0 ? 1 : txt.split('\n').length
    if (countEl) {
      countEl.textContent = `${txt.length} char${txt.length === 1 ? '' : 's'} · ${lineCount} line${lineCount === 1 ? '' : 's'}`
    }
    const trimmed = txt.trim()
    const looksJson =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      trimmed.startsWith('{') ||
      trimmed.startsWith('[')
    if (!looksJson) {
      if (jsonBadge) jsonBadge.hidden = true
      if (fmtBtn) fmtBtn.disabled = true
      if (minBtn) minBtn.disabled = true
      return
    }
    try {
      JSON.parse(trimmed)
      if (jsonBadge) {
        jsonBadge.hidden = false
        jsonBadge.className = 'badge badge-ok'
        jsonBadge.textContent = 'Valid JSON'
      }
      if (fmtBtn) fmtBtn.disabled = false
      if (minBtn) minBtn.disabled = false
    } catch {
      if (jsonBadge) {
        jsonBadge.hidden = false
        jsonBadge.className = 'badge badge-danger'
        jsonBadge.textContent = 'Invalid JSON'
      }
      if (fmtBtn) fmtBtn.disabled = true
      if (minBtn) minBtn.disabled = true
    }
  }

  function renderValueInspector() {
    const drawer = $('valueInspectorDrawer')
    const pd = state.pageData
    if (!state.inspectorOpen || !pd || !state.selectedRowKey || !state.selectedCol) {
      drawer.hidden = true
      return
    }
    const entry = getAllDisplayRows().find((r) => r.rowKey === state.selectedRowKey)
    if (!entry) {
      drawer.hidden = true
      return
    }
    const col = pd.columns.find((c) => c.name === state.selectedCol)
    const val = getEffectiveCellValue(entry.rowKey, entry.data, state.selectedCol)
    drawer.hidden = false
    drawer.classList.toggle('is-collapsed', Boolean(state.inspectorCollapsed))
    if (state.inspectorCollapsed) {
      drawer.style.height = ''
    } else {
      let savedPx = NaN
      try {
        savedPx = Number(window.localStorage?.getItem('datanoa.panelValueInspectorPx'))
      } catch {}
      const targetPx = Number.isFinite(savedPx) && savedPx >= 148 ? Math.round(savedPx) : 220
      const boxH = drawer.parentElement?.getBoundingClientRect?.().height
      const maxAllowed = boxH && Number.isFinite(boxH) && boxH > 0 ? Math.max(148, Math.floor(boxH * 0.76)) : 560
      drawer.style.height = `${Math.max(148, Math.min(maxAllowed, targetPx))}px`
    }
    $('valueInspectorTitle').textContent =
      `${state.activeTable}.${state.selectedCol} (${col?.type || 'TEXT'})`
    $('valueInspectorBody').hidden = state.inspectorCollapsed
    $('toggleInspectorBodyBtn').textContent = state.inspectorCollapsed ? 'Expand' : 'Collapse'

    const inspectorInput = $('valueInspectorText')
    const nullBadge = $('inspectorNullBadge')
    inspectorInput.placeholder = ''
    let displayStr = ''
    if (entry.isInsert && val === undefined) {
      displayStr = ''
      inspectorInput.placeholder = col?.isAutoIncrement ? '(auto)' : '(default)'
      if (nullBadge) {
        nullBadge.hidden = false
        nullBadge.textContent = col?.isAutoIncrement ? 'AUTO' : 'DEFAULT'
      }
    } else if (val === null || val === undefined) {
      displayStr = ''
      inspectorInput.placeholder = 'NULL (database null — type to set a value)'
      if (nullBadge) {
        nullBadge.hidden = false
        nullBadge.textContent = 'NULL'
      }
    } else {
      if (nullBadge) nullBadge.hidden = true
      if (typeof val === 'object') {
        displayStr = JSON.stringify(val, null, 2)
      } else {
        const s = String(val)
        const trimmed = s.trim()
        if (
          (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
          (trimmed.startsWith('[') && trimmed.endsWith(']'))
        ) {
          try {
            displayStr = formatJsonPreservingNumbers(trimmed, 2)
          } catch {
            displayStr = s
          }
        } else {
          displayStr = s
        }
      }
    }
    inspectorInput.value = displayStr
    inspectorInput.dataset.initialDisplay = displayStr
    setInspectorUserModified(false)
    updateInspectorMetaAndJson()

    const conn = getActiveConn()
    const editable = isDataCellEditable(entry, col, pd, Boolean(conn?.readOnly))
    $('inspectorApplyBtn').disabled = !editable
    $('inspectorNullBtn').disabled = !editable || (col ? !col.nullable : false)
  }

  function recomputePinnedForViewport() {
    if (state.transposed || !state.pageData || dataVirt.visCols.length === 0) return false
    const wrapEl = $('dataGridWrap')
    const tbl = $('dataTable')
    if (!tbl || !wrapEl) return false
    const viewportW = wrapEl.clientWidth || 800
    const widthsByKey = {}
    dataVirt.visColKeys.forEach((colKey, ci) => {
      widthsByKey[colKey] = dataVirt.visColWidths[ci] || 120
    })
    const pinnedCap = computePinnedColumnsViewportCap({
      pinnedKeys: dataVirt.pinnedCandidateKeys || [],
      widthsByKey,
      viewportWidthPx: viewportW,
      rowNumWidthPx: state.rowNumWidth,
    })
    const nextPinnedCount = pinnedCap.activePinnedKeys.length
    const nextTotalPinnedWidthPx = pinnedCap.totalPinnedWidthPx
    const nextStickyLefts = []
    let accLeft = state.rowNumWidth
    for (let i = 0; i < dataVirt.visColKeys.length; i++) {
      nextStickyLefts.push(
        i < nextPinnedCount
          ? (pinnedCap.stickyLeftByKey[dataVirt.visColKeys[i]] ?? accLeft)
          : accLeft
      )
      if (i < nextPinnedCount) accLeft += dataVirt.visColWidths[i] || 120
    }
    const prevPinnedCount = dataVirt.pinnedCount
    dataVirt.pinnedCount = nextPinnedCount
    dataVirt.totalPinnedWidthPx = nextTotalPinnedWidthPx
    dataVirt.stickyLefts = nextStickyLefts

    const headerCells = tbl.querySelectorAll('thead th[data-col-idx]')
    for (let colIdx = 0; colIdx < headerCells.length; colIdx++) {
      const th = headerCells[colIdx]
      if (!(th instanceof HTMLElement)) continue
      const isPinned = colIdx < nextPinnedCount
      th.classList.toggle('col-pinned', isPinned)
      th.classList.toggle('col-pinned-last', isPinned && colIdx === nextPinnedCount - 1)
      th.style.left = isPinned ? `${nextStickyLefts[colIdx]}px` : ''
      const col = dataVirt.visCols[colIdx]
      const labelEl = th.querySelector('.th-label')
      if (col && labelEl) {
        labelEl.textContent = `${isPinned ? '• ' : ''}${col.name}${col.isPrimaryKey ? ' [PK]' : ''}`
      }
    }

    const tbodyEl = tbl.tBodies?.[0] || tbl.querySelector('tbody')
    const bodyRows = tbodyEl ? tbodyEl.children : []
    for (let r = 0; r < bodyRows.length; r++) {
      const tr = bodyRows[r]
      if (!(tr instanceof HTMLElement) || tr.dataset.rowIdx === undefined) continue
      for (let colIdx = 0; colIdx < dataVirt.visCols.length; colIdx++) {
        const td = tr.children[colIdx + 1]
        if (!(td instanceof HTMLElement)) continue
        const isPinned = colIdx < nextPinnedCount
        td.classList.toggle('col-pinned', isPinned)
        td.classList.toggle('col-pinned-last', isPinned && colIdx === nextPinnedCount - 1)
        td.style.left = isPinned ? `${nextStickyLefts[colIdx]}px` : ''
      }
    }

    if (dataVirt.active && state.selectedRowKey && state.selectedCol) {
      const focusRowIdx = dataVirt.allRows.findIndex((r) => r.rowKey === state.selectedRowKey)
      const focusColIdx = dataVirt.visCols.findIndex((c) => c.name === state.selectedCol)
      if (focusRowIdx >= 0 && focusColIdx >= nextPinnedCount) {
        ensureDataVirtualRowVisible(focusRowIdx, focusColIdx)
      }
    }
    return nextPinnedCount !== prevPinnedCount
  }

  return {
    dataVirt,
    bumpAllHighlightRevisions,
    recomputePinnedForViewport,
    computeVirtualRange,
    isActiveDataObjectView,
    renderDataToolbar,
    getSelectedDataRowKeys,
    renderDataSelectionStats,
    renderStagingBar,
    getEffectiveCellValue,
    isCellStagedEdited,
    isDataCellEditable,
    patchRenderedDataCell,
    stageCellValue,
    applyQuickWhere,
    copyDataSelection,
    clearCopiedSnapshot,
    triggerPanelPasteSmart,
    triggerPanelPasteNewRows,
    pasteAsNewRowsInDataGrid,
    pasteDelimitedIntoDataGrid,
    bulkSetSelectedCellsValue,
    cloneSelectedRows,
    toggleDeleteSelectedRows,
    toggleColumnPinned,
    toggleColumnHidden,
    autoFitDataColumn,
    exportCurrentDataPage,
    computeDataFindMatches,
    applyFindClassesToRenderedDataRows,
    updateDataFindHighlights,
    getAllDisplayRows,
    updateGridSelectionHighlight,
    attachColumnResizeHandle,
    renderDataCellContent,
    renderDataVirtualWindow,
    ensureDataVirtualRowVisible,
    renderDataGrid,
    startInlineEdit,
    buildDataChangesPayload,
    updateInspectorMetaAndJson,
    renderValueInspector,
  }
}
