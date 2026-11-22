// src/panel/panel-data-grid.js
// Side Panel Data Grid: toolbar, staging bar, virtualized row window, inline editor,
// column resize/auto-fit/pin/hide, find highlights, export, and value inspector.

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

  let displayRowsCache = {
    pageData: null,
    stagedInsertsLen: -1,
    firstInsertRef: null,
    lastInsertRef: null,
    rows: [],
  }

  const dataVirt = {
    active: false,
    allRows: [],
    visCols: [],
    pinnedCount: 0,
    stickyLefts: [],
    fkMap: new Map(),
    pageOffset: 0,
    stagedInsertCount: 0,
    isConnRo: false,
    canEditTable: false,
    tbody: null,
    topSpacerTr: null,
    topSpacerTd: null,
    bottomSpacerTr: null,
    bottomSpacerTd: null,
    start: -1,
    end: -1,
    rafId: null,
  }

  function computeVirtualRange(scrollTop, viewportH, totalRows) {
    return coreComputeVirtualRange(
      scrollTop,
      viewportH,
      totalRows,
      VIRT_ROW_HEIGHT_PX,
      VIRT_OVERSCAN_ROWS
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
    if (!state.transposed && dataGridSel && dataGridSel.hasSelection()) {
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
    if (!dataGridSel || !dataGridSel.hasSelection() || state.dataLoading || state.transposed) {
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
      editStructBtn.disabled = busy || isView || !state.activeTable || conn?.driver === 'redis'
      editStructBtn.title = isView
        ? 'Views are read-only — inspect DDL in Structure tab'
        : 'Edit Table Structure (ALTER TABLE)'
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
    if (state.findQuery && state.findQuery.trim()) {
      updateDataFindHighlights(false)
    }
    return true
  }

  function stageCellValue(rowKey, rowObj, colName, nextVal, deferRender = false, patchTd = null) {
    if (isSubmittingChanges()) return
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
    if (nextVal === origVal) {
      delete entry.changes[colName]
      if (Object.keys(entry.changes).length === 0) state.stagedUpdates.delete(rowKey)
    } else {
      entry.changes[colName] = nextVal
    }
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
      for (const col of visCols) {
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
    if (isSubmittingChanges() || getActiveConn()?.readOnly) return
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
    if (isSubmittingChanges() || getActiveConn()?.readOnly) return
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
    if (isSubmittingChanges() || getActiveConn()?.readOnly) return
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
        state.stagedDeletes.set(rk, pks)
        state.stagedUpdates.delete(rk)
      }
    }
    if (removedInsSet.size > 0) {
      state.stagedInserts = state.stagedInserts.filter((r) => !removedInsSet.has(r.tempId))
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

  function toggleColumnPinned(colName) {
    const set = getPinnedColsSet()
    if (set.has(colName)) set.delete(colName)
    else set.add(colName)
    getDataGridSel()?.clear(true)
    renderDataGrid()
    if (!$('dataColsPopover').hidden) renderDataColsPopoverList()
  }

  function toggleColumnHidden(colName) {
    const pd = state.pageData
    if (!pd) return
    const set = getHiddenColsSet()
    if (set.has(colName)) {
      set.delete(colName)
    } else {
      if (pd.columns.length - set.size <= 1) {
        showBanner('At least one column must remain visible.', 'neutral')
        return
      }
      set.add(colName)
      getPinnedColsSet().delete(colName)
    }
    getDataGridSel()?.clear(true)
    renderDataGrid()
    if (!$('dataColsPopover').hidden) renderDataColsPopoverList()
  }

  function autoFitDataColumn(colName) {
    const pd = state.pageData
    if (!pd) return
    const tblKey = getActiveTableKey()
    const colWidths = state.columnWidthsByTable[tblKey]
    const origIdx = pd.columns.findIndex((c) => c.name === colName)
    if (!colWidths || origIdx < 0) return
    const colDef = pd.columns[origIdx]
    const allRows = getAllDisplayRows()
    let maxLen = colDef.name.length + (colDef.isPrimaryKey ? 5 : 0) + 2
    for (const entry of allRows) {
      const val = getEffectiveCellValue(entry.rowKey, entry.data, colDef.name)
      const textLen =
        val == null ? 4 : (typeof val === 'object' ? JSON.stringify(val) : String(val)).length
      if (textLen > maxLen) maxLen = textLen
    }
    colWidths[origIdx] = Math.max(64, Math.min(440, Math.round(maxLen * 7.5 + 26)))
    renderDataGrid()
  }

  function exportCurrentDataPage(format, asDownload, ext, mime) {
    const pd = state.pageData
    if (!pd || !pd.columns?.length) return
    const visCols = getOrderedVisibleColumns()
    const rows = getAllDisplayRows().map((entry) => {
      const out = {}
      for (const col of visCols) {
        out[col.name] = getEffectiveCellValue(entry.rowKey, entry.data, col.name)
      }
      return out
    })
    const text = formatExportData({
      columns: visCols,
      rows,
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
    const allRows = dataVirt.active ? dataVirt.allRows : getAllDisplayRows()
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
        if (state.transposed) {
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
        } else if (td.dataset.rowIdx !== undefined && td.dataset.colIdx !== undefined) {
          const key = `${td.dataset.rowIdx}:${td.dataset.colIdx}`
          isMatch = state.findMatchSet.has(key)
          isActive = Boolean(
            activeMatch &&
              String(activeMatch.r) === td.dataset.rowIdx &&
              String(activeMatch.c) === td.dataset.colIdx
          )
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
      if (dataVirt.active && !state.transposed) {
        ensureDataVirtualRowVisible(activeMatch.r)
      }
      applyFindClassesToRenderedDataRows()
      const tbl = $('dataTable')
      const activeTd = state.transposed
        ? Array.from(tbl?.querySelectorAll('tbody td[data-col-name]') || []).find(
            (el) =>
              el.dataset.rowKey === activeMatch.rowKey && el.dataset.colName === activeMatch.colName
          )
        : tbl?.querySelector(
            `tbody td[data-row-idx="${activeMatch.r}"][data-col-idx="${activeMatch.c}"]`
          )
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
    if (dataGridSel && !state.transposed) {
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
    colIdx,
    colWidths,
    syncTableWidth,
    getAutoFitWidth,
    rowNumStateKey = 'rowNumWidth'
  ) {
    handle.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const prevCleanup = getActiveResizeCleanup()
      if (prevCleanup) prevCleanup()
      const startX = e.clientX
      const startWidth = isRowNum ? state[rowNumStateKey] : colWidths[colIdx]
      let didMove = false
      handle.classList.add('resizing')
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      let pendingW = startWidth
      let resizeRafId = null
      const applyPendingResize = () => {
        resizeRafId = null
        colEl.style.width = `${pendingW}px`
        thEl.style.width = `${pendingW}px`
        syncTableWidth()
      }

      const onMove = (moveEvent) => {
        const delta = moveEvent.clientX - startX
        if (Math.abs(delta) >= 2) didMove = true
        const minW = isRowNum ? 48 : 50
        const nextW = Math.max(minW, Math.round(startWidth + delta))
        pendingW = nextW
        if (isRowNum) {
          state[rowNumStateKey] = nextW
        } else {
          colWidths[colIdx] = nextW
        }
        if (typeof requestAnimationFrame === 'function') {
          if (resizeRafId === null) {
            resizeRafId = requestAnimationFrame(applyPendingResize)
          }
        } else {
          applyPendingResize()
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
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      const onUp = () => {
        if (resizeRafId !== null) {
          if (typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(resizeRafId)
          }
          applyPendingResize()
        } else if (didMove) {
          syncTableWidth()
        }
        cleanup()
        if (didMove) {
          setSuppressSortClickUntil(Date.now() + 250)
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
      let nextW = 56
      if (!isRowNum && typeof getAutoFitWidth === 'function') {
        nextW = getAutoFitWidth()
        colWidths[colIdx] = nextW
      } else {
        state[rowNumStateKey] = nextW
      }
      colEl.style.width = `${nextW}px`
      thEl.style.width = `${nextW}px`
      syncTableWidth()
    })
  }

  function renderDataCellContent(td, entry, col, val, fkInfo) {
    const pd = state.pageData
    const isConnRo = Boolean(getActiveConn()?.readOnly)
    const canEditCell = isDataCellEditable(entry, col, pd, isConnRo)
    td.dataset.rowKey = entry.rowKey
    td.dataset.colName = col.name
    td.dataset.editable = canEditCell ? '1' : '0'

    td.classList.remove('cell-null', 'cell-num', 'cell-edited')
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
      const td = document.createElement('td')
      td.dataset.rowIdx = String(rowIdx)
      td.dataset.colIdx = String(colIdx)
      if (colIdx < dataVirt.pinnedCount) {
        td.classList.add('col-pinned')
        td.style.left = `${dataVirt.stickyLefts[colIdx]}px`
        if (colIdx === dataVirt.pinnedCount - 1) td.classList.add('col-pinned-last')
      }
      const val = getEffectiveCellValue(entry.rowKey, entry.data, col.name)
      const fkInfo = dataVirt.fkMap.get(col.name) || null
      renderDataCellContent(td, entry, col, val, fkInfo)
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

  function renderDataVirtualWindow(force = false) {
    if (!dataVirt.active || !dataVirt.tbody) return
    const wrap = $('dataGridWrap')
    const total = dataVirt.allRows.length
    if (total === 0) return
    const scrollTop = wrap ? wrap.scrollTop : 0
    const viewportH = wrap ? wrap.clientHeight : 420
    const { start, end } = computeVirtualRange(scrollTop, viewportH, total)
    syncVirtualTableWindow({
      virt: dataVirt,
      total,
      start,
      end,
      rowHeightPx: VIRT_ROW_HEIGHT_PX,
      createRow: createDataVirtualRow,
      selectionController: getDataGridSel(),
      onBeforeDetachRow: (node) => {
        const activeInp = node.querySelector('input.cell-edit-input')
        if (activeInp instanceof HTMLInputElement) activeInp.blur()
      },
      force,
    })
  }

  function ensureDataVirtualRowVisible(rowIdx) {
    if (!dataVirt.active) return
    const wrap = $('dataGridWrap')
    if (!wrap) return
    const rowTop = rowIdx * VIRT_ROW_HEIGHT_PX
    const rowBottom = rowTop + VIRT_ROW_HEIGHT_PX
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
    renderDataVirtualWindow(false)
  }

  function renderDataGrid() {
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
    tbl.textContent = ''
    tbl.classList.toggle('transposed', state.transposed)

    if (state.transposed) {
      dataVirt.active = false
      dataVirt.allRows = allRows
      dataVirt.visCols = visCols
      dataVirt.fkMap = fkMap
      dataVirt.start = -1
      dataVirt.end = -1
      tbl.style.width = ''
      const thead = document.createElement('thead')
      const hr = document.createElement('tr')
      const firstTh = document.createElement('th')
      firstTh.className = 'transpose-col-head'
      firstTh.textContent = 'Column'
      hr.appendChild(firstTh)
      const stagedInsLen = state.stagedInserts.length
      const cappedRows = allRows.slice(0, 100)
      cappedRows.forEach((entry, idx) => {
        const th = document.createElement('th')
        th.textContent = entry.isInsert ? `+ New ${idx + 1}` : `Row ${idx - stagedInsLen + 1}`
        hr.appendChild(th)
      })
      if (allRows.length > 100) {
        const moreTh = document.createElement('th')
        moreTh.textContent = `+${allRows.length - 100} more rows`
        hr.appendChild(moreTh)
      }
      thead.appendChild(hr)
      tbl.appendChild(thead)

      const tbody = document.createElement('tbody')
      for (let cIdx = 0; cIdx < visCols.length; cIdx++) {
        const col = visCols[cIdx]
        const tr = document.createElement('tr')
        const colHead = document.createElement('th')
        colHead.className = 'transpose-col-head'
        colHead.textContent = `${col.name}${col.isPrimaryKey ? ' [PK]' : ''}`
        tr.appendChild(colHead)
        const fkInfo = fkMap.get(col.name) || null
        for (let rIdx = 0; rIdx < cappedRows.length; rIdx++) {
          const entry = cappedRows[rIdx]
          const td = document.createElement('td')
          td.dataset.rowIdx = String(rIdx)
          td.dataset.colIdx = String(cIdx)
          if (entry.isInsert) td.style.background = 'color-mix(in srgb, var(--ok) 12%, var(--bg))'
          if (state.stagedDeletes.has(entry.rowKey)) td.style.textDecoration = 'line-through'
          const val = getEffectiveCellValue(entry.rowKey, entry.data, col.name)
          renderDataCellContent(td, entry, col, val, fkInfo)
          tr.appendChild(td)
        }
        if (allRows.length > 100) {
          const moreTd = document.createElement('td')
          moreTd.className = 'cell-null'
          moreTd.textContent = `... (${allRows.length - 100} more)`
          tr.appendChild(moreTd)
        }
        tbody.appendChild(tr)
      }
      tbl.appendChild(tbody)
    } else {
      if (
        !Array.isArray(state.columnWidthsByTable[tblKey]) ||
        state.columnWidthsByTable[tblKey].length !== pd.columns.length
      ) {
        state.columnWidthsByTable[tblKey] = computeInitialColumnWidths(pd.columns, allRows)
      }
      const allColWidths = state.columnWidthsByTable[tblKey]
      const origIdxByName = new Map(pd.columns.map((c, idx) => [c.name, idx]))
      const visColWidths = visCols.map((c) => allColWidths[origIdxByName.get(c.name) ?? 0] || 120)

      const pinnedCount = visCols.filter((c) => pinnedSet.has(c.name)).length
      const stickyLefts = []
      let accLeft = state.rowNumWidth
      for (let i = 0; i < visCols.length; i++) {
        stickyLefts.push(accLeft)
        if (i < pinnedCount) accLeft += visColWidths[i]
      }

      const colgroup = document.createElement('colgroup')
      const rowNumColEl = document.createElement('col')
      rowNumColEl.style.width = `${state.rowNumWidth}px`
      colgroup.appendChild(rowNumColEl)
      const dataColEls = visColWidths.map((w) => {
        const c = document.createElement('col')
        c.style.width = `${w}px`
        colgroup.appendChild(c)
        return c
      })
      tbl.appendChild(colgroup)

      const syncTableWidth = () => {
        let total = state.rowNumWidth
        visCols.forEach((c, ci) => {
          const oi = origIdxByName.get(c.name) ?? 0
          allColWidths[oi] = visColWidths[ci]
          total += visColWidths[ci]
        })
        tbl.style.width = `${total}px`
        if (pinnedCount > 0) {
          let leftPx = state.rowNumWidth
          const headerCells = tbl.querySelectorAll('thead th[data-col-idx]')
          const tbodyEl = tbl.tBodies?.[0] || tbl.querySelector('tbody')
          const bodyRows = tbodyEl ? tbodyEl.children : []
          for (let pi = 0; pi < pinnedCount; pi++) {
            stickyLefts[pi] = leftPx
            if (dataVirt.active && dataVirt.stickyLefts) {
              dataVirt.stickyLefts[pi] = leftPx
            }
            const thEl = headerCells[pi]
            if (thEl instanceof HTMLElement) thEl.style.left = `${leftPx}px`
            for (let r = 0; r < bodyRows.length; r++) {
              const tr = bodyRows[r]
              if (!(tr instanceof HTMLElement) || tr.dataset.rowIdx === undefined) continue
              const tdEl = tr.children[pi + 1]
              if (tdEl instanceof HTMLElement) tdEl.style.left = `${leftPx}px`
            }
            leftPx += visColWidths[pi]
          }
        }
      }
      syncTableWidth()

      const thead = document.createElement('thead')
      const hRow = document.createElement('tr')

      const thIdx = document.createElement('th')
      thIdx.style.width = `${state.rowNumWidth}px`
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
      attachColumnResizeHandle(
        idxResize,
        rowNumColEl,
        thIdx,
        true,
        -1,
        visColWidths,
        syncTableWidth,
        null,
        'rowNumWidth'
      )
      thIdx.append(idxInner, idxResize)
      thIdx.addEventListener('click', (e) => {
        if (Date.now() < getSuppressSortClickUntil()) return
        e.stopPropagation()
        dataGridSel?.selectAll()
      })
      hRow.appendChild(thIdx)

      visCols.forEach((col, colIdx) => {
        const th = document.createElement('th')
        th.style.width = `${visColWidths[colIdx]}px`
        th.dataset.colIdx = String(colIdx)
        th.dataset.colName = col.name
        const isSorted = state.sortCol === col.name
        if (isSorted) th.classList.add('sorted')
        const isPinned = colIdx < pinnedCount
        if (isPinned) {
          th.classList.add('col-pinned')
          th.style.left = `${stickyLefts[colIdx]}px`
          if (colIdx === pinnedCount - 1) th.classList.add('col-pinned-last')
        }

        const inner = document.createElement('div')
        inner.className = 'th-inner'
        const label = document.createElement('span')
        label.className = 'th-label'
        label.textContent = `${isPinned ? '• ' : ''}${col.name}${col.isPrimaryKey ? ' [PK]' : ''}`
        inner.appendChild(label)

        if (isSorted) {
          const sortIcon = document.createElement('span')
          sortIcon.className = 'th-sort-icon'
          sortIcon.appendChild(createSortSvg(state.sortDir))
          inner.appendChild(sortIcon)
        }

        const colGrip = document.createElement('button')
        colGrip.type = 'button'
        colGrip.className = 'th-col-grip'
        colGrip.title = `Select column "${col.name}"`
        colGrip.setAttribute('aria-label', `Select column ${col.name}`)
        colGrip.textContent = '▾'
        colGrip.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          dataGridSel?.selectCol(colIdx, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
          $('dataGridWrap')?.focus({ preventScroll: true })
        })
        inner.appendChild(colGrip)

        const resizeHandle = document.createElement('div')
        resizeHandle.className = 'col-resize-handle'
        attachColumnResizeHandle(
          resizeHandle,
          dataColEls[colIdx],
          th,
          false,
          colIdx,
          visColWidths,
          syncTableWidth,
          () => {
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
          },
          'rowNumWidth'
        )

        th.append(inner, resizeHandle)
        th.addEventListener('click', (e) => {
          if (Date.now() < getSuppressSortClickUntil()) return
          if (e.shiftKey || e.ctrlKey || e.metaKey) {
            e.preventDefault()
            dataGridSel?.selectCol(colIdx, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
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
        hRow.appendChild(th)
      })
      thead.appendChild(hRow)
      tbl.appendChild(thead)

      const pageOffset = ((pd.page || 1) - 1) * (pd.pageSize || state.pageSize || 100)
      const tbody = document.createElement('tbody')
      if (allRows.length === 0) {
        dataVirt.active = false
        dataVirt.allRows = []
        dataVirt.visCols = visCols
        dataVirt.start = -1
        dataVirt.end = -1
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
      } else {
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
        dataVirt.allRows = allRows
        dataVirt.visCols = visCols
        dataVirt.pinnedCount = pinnedCount
        dataVirt.stickyLefts = stickyLefts
        dataVirt.fkMap = fkMap
        dataVirt.pageOffset = pageOffset
        dataVirt.stagedInsertCount = state.stagedInserts.length
        dataVirt.isConnRo = isConnRo
        dataVirt.canEditTable = Boolean(pd.canEdit)
        dataVirt.tbody = tbody
        dataVirt.topSpacerTr = topSpacerTr
        dataVirt.topSpacerTd = topSpacerTd
        dataVirt.bottomSpacerTr = bottomSpacerTr
        dataVirt.bottomSpacerTd = bottomSpacerTd
        dataVirt.start = -1
        dataVirt.end = -1

        computeDataFindMatches()
        renderDataVirtualWindow(true)
      }
    }

    const totalPages = Math.max(
      1,
      Math.ceil(pd.totalRows / (pd.pageSize || state.pageSize || 100))
    )
    $('dataPagerInfo').textContent = `${pd.totalRows} rows · Page ${pd.page} / ${totalPages}`
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
    const column = col.name
    if (td.querySelector('input')) return
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
        const isTextLike =
          !isNumericSqlType(col.nativeType || col.type) &&
          !isBooleanSqlType(col.nativeType || col.type)
        if (currentVal === undefined && input.value === '' && !userTyped) {
          cancel()
        } else if (currentVal === null && input.value === '' && !isTextLike) {
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
        const isTextLike =
          !isNumericSqlType(col.nativeType || col.type) &&
          !isBooleanSqlType(col.nativeType || col.type)
        if (input.value !== initialEditText || (userTyped && currentVal === null && isTextLike)) {
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
          !state.transposed &&
          dataVirt.active &&
          td.dataset.rowIdx !== undefined &&
          td.dataset.colIdx !== undefined
        ) {
          const curR = Number(td.dataset.rowIdx)
          const curC = Number(td.dataset.colIdx)
          const totalR = dataVirt.allRows.length
          const totalC = dataVirt.visCols.length
          const step = e.shiftKey ? -1 : 1
          let linear = curR * totalC + curC + step
          let targetR = -1
          let targetC = -1
          const maxSteps = totalR * totalC
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
          if (targetR >= 0 && targetC >= 0) {
            ensureDataVirtualRowVisible(targetR)
            dataGridSel?.selectCell(targetR, targetC)
            const freshTd = $('dataTable')?.querySelector(
              `tbody td[data-row-idx="${targetR}"][data-col-idx="${targetC}"]`
            )
            const freshEntry = dataVirt.allRows[targetR]
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
            state.selectedRowKey = freshTd.dataset.rowKey
            state.selectedCol = freshTd.dataset.colName
            updateGridSelectionHighlight()
            renderStagingBar()
            renderValueInspector()
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
      const isTextLike =
        !isNumericSqlType(col.nativeType || col.type) &&
        !isBooleanSqlType(col.nativeType || col.type)
      if (input.value !== initialEditText || (userTyped && currentVal === null && isTextLike)) {
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
    const deletes = Array.from(state.stagedDeletes.values())
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
      ...(deletes.length > 0 ? { deletes } : {}),
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
            displayStr = JSON.stringify(JSON.parse(trimmed), null, 2)
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

  return {
    dataVirt,
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
