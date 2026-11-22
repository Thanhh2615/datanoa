// src/panel/panel-sql.js
// Side Panel SQL Console Runner, virtualized SQL Result Grid, export, and Query History

import {
  panelContainsDdlStatement,
  findStatementAtOffset,
  formatExportData,
  formatSelectionAsOutput,
  formatRelativeTime,
} from './panel-core.js'
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
    savePanelDataCache,
  } = ctx

  let sqlRunSeq = 0
  let historySeq = 0
  let sqlStopTimer = null
  let sortedSqlRowsCache = { res: null, colIdx: null, dir: 'ASC', rows: [] }

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

  function renderSqlSafetyBanner() {
    const conn = getActiveConn()
    const banner = $('sqlProdBanner')
    if (!conn) {
      banner.hidden = true
      return
    }
    if (conn.readOnly && conn.colorTag === 'prod') {
      banner.className = 'banner danger'
      $('sqlProdBannerText').textContent =
        'PROD + READ-ONLY — Mutating SQL/Redis statements are blocked by worker policy.'
      banner.hidden = false
    } else if (conn.colorTag === 'prod') {
      banner.className = 'banner warn'
      $('sqlProdBannerText').textContent =
        'PROD environment — review statements carefully before executing.'
      banner.hidden = false
    } else if (conn.readOnly) {
      banner.className = 'banner warn'
      $('sqlProdBannerText').textContent =
        'READ-ONLY connection — INSERT, UPDATE, DELETE, and DDL commands are blocked.'
      banner.hidden = false
    } else {
      banner.hidden = true
    }

    $('sqlEditor').placeholder =
      conn.driver === 'redis'
        ? 'SCAN 0 MATCH * COUNT 50'
        : 'SELECT * FROM table_name LIMIT 25;'
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
    strip.textContent = txt
    strip.hidden = !txt
  }

  function copySqlSelection(format = 'tsv', includeHeaders = false) {
    const res = state.lastSqlResult
    const sqlGridSel = getSqlGridSel()
    if (!res || !sqlGridSel) return
    const coords = sqlGridSel.getSelectedCoords(50000)
    if (coords.length === 0) return
    const sortedRows = getSortedSqlRows()
    const text = formatSelectionAsOutput(
      res.columns,
      sortedRows,
      coords,
      format,
      includeHeaders,
      'query_result',
      undefined,
      getActiveConn()?.driver || 'sqlite',
      []
    )
    if (format === 'tsv' || format === 'csv') {
      setLastPanelCopiedText(text)
    }
    void copyText(text, `Copied ${coords.length} cell(s) (${format.toUpperCase()})`)
  }

  function exportCurrentSqlResult(format, asDownload, ext, mime) {
    const res = state.lastSqlResult
    if (!res || !res.columns?.length) return
    const sortedRows = getSortedSqlRows()
    const text = formatExportData({
      columns: res.columns,
      rows: sortedRows,
      format,
      tableName: 'query_result',
      schema: undefined,
      driver: getActiveConn()?.driver || 'sqlite',
      primaryKeys: [],
    })
    if (asDownload) {
      const extMap = { csv: 'csv', json: 'json', 'sql-insert': 'sql', markdown: 'md', tsv: 'tsv' }
      const mimeMap = {
        csv: 'text/csv;charset=utf-8',
        json: 'application/json;charset=utf-8',
        'sql-insert': 'text/sql;charset=utf-8',
        markdown: 'text/markdown;charset=utf-8',
        tsv: 'text/tab-separated-values;charset=utf-8',
      }
      void downloadTextFile(
        `query_result.${ext || extMap[format] || 'txt'}`,
        text,
        mime || mimeMap[format] || 'text/plain;charset=utf-8'
      ).then((status) => {
        if (status === 'cancelled') return
        showBanner(
          status === 'saved'
            ? `Saved ${sortedRows.length} row(s) (${format.toUpperCase()})`
            : 'Download failed',
          status === 'saved' ? 'success' : 'danger'
        )
      })
    } else {
      void copyText(text, `Copied ${sortedRows.length} row(s) (${format.toUpperCase()})`)
    }
  }

  function createSqlVirtualRow(rowIdx) {
    const sqlGridSel = getSqlGridSel()
    const r = sqlVirt.sortedRows[rowIdx]
    const tr = document.createElement('tr')
    tr.dataset.rowIdx = String(rowIdx)
    if (rowIdx % 2 === 1) tr.classList.add('row-even')
    const tdNum = document.createElement('td')
    tdNum.className = 'td-rownum'
    tdNum.dataset.rowIdx = String(rowIdx)
    tdNum.textContent = String(rowIdx + 1)
    tr.appendChild(tdNum)
    const cols = sqlVirt.columns
    for (let colIdx = 0; colIdx < cols.length; colIdx++) {
      const col = cols[colIdx]
      const td = document.createElement('td')
      td.dataset.rowIdx = String(rowIdx)
      td.dataset.colIdx = String(colIdx)
      td.dataset.colName = col.name
      const v = r[colIdx]
      if (v === null || v === undefined) {
        td.className = 'cell-null'
        td.textContent = 'NULL'
      } else {
        if (typeof v === 'number') td.className = 'cell-num'
        td.textContent = typeof v === 'object' ? JSON.stringify(v) : String(v)
      }
      tr.appendChild(td)
    }
    sqlGridSel?.applyClassesToRow(tr, rowIdx)
    return tr
  }

  function renderSqlVirtualWindow(force = false) {
    if (!sqlVirt.active || !sqlVirt.tbody) return
    const wrap = $('sqlResultWrap')
    const total = sqlVirt.sortedRows.length
    if (total === 0) return
    const scrollTop = wrap ? wrap.scrollTop : 0
    const viewportH = wrap ? wrap.clientHeight : 420
    const { start, end } = computeVirtualRange(scrollTop, viewportH, total)
    syncVirtualTableWindow({
      virt: sqlVirt,
      total,
      start,
      end,
      rowHeightPx: VIRT_ROW_HEIGHT_PX,
      createRow: createSqlVirtualRow,
      selectionController: getSqlGridSel(),
      force,
    })
  }

  function ensureSqlVirtualRowVisible(rowIdx) {
    if (!sqlVirt.active) return
    const wrap = $('sqlResultWrap')
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
    renderSqlVirtualWindow(false)
  }

  function renderSqlResultSkeleton() {
    sqlVirt.active = false
    sqlVirt.start = -1
    sqlVirt.end = -1
    const wrap = $('sqlResultWrap')
    const tbl = $('sqlResultTable')
    const metaBar = $('sqlResultMeta')
    if (metaBar) metaBar.hidden = true
    if (!wrap || !tbl) return
    wrap.hidden = false
    tbl.textContent = ''
    tbl.style.width = '100%'
    const thead = document.createElement('thead')
    const hr = document.createElement('tr')
    const th0 = document.createElement('th')
    th0.style.width = '40px'
    th0.textContent = '#'
    hr.appendChild(th0)
    for (let c = 0; c < 3; c++) {
      const th = document.createElement('th')
      const bar = document.createElement('div')
      bar.className = 'panel-skeleton-bar'
      bar.style.width = `${60 + c * 18}px`
      th.appendChild(bar)
      hr.appendChild(th)
    }
    thead.appendChild(hr)
    tbl.appendChild(thead)
    const tbody = document.createElement('tbody')
    for (let r = 0; r < 5; r++) {
      const tr = document.createElement('tr')
      const td0 = document.createElement('td')
      td0.className = 'td-rownum'
      td0.textContent = String(r + 1)
      tr.appendChild(td0)
      for (let c = 0; c < 3; c++) {
        const td = document.createElement('td')
        const bar = document.createElement('div')
        bar.className = 'panel-skeleton-bar'
        bar.style.width = `${50 + ((r * 17 + c * 29) % 40)}%`
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
    thIdx.addEventListener('click', (e) => {
      if (Date.now() < getSuppressSortClickUntil()) return
      e.stopPropagation()
      sqlGridSel?.selectAll()
    })
    hr.appendChild(thIdx)

    res.columns.forEach((col, colIdx) => {
      const th = document.createElement('th')
      th.style.width = `${colWidths[colIdx]}px`
      th.dataset.colIdx = String(colIdx)
      th.dataset.colName = col.name
      const isSorted = state.sqlSortColIdx === colIdx
      if (isSorted) th.classList.add('sorted')

      const inner = document.createElement('div')
      inner.className = 'th-inner'
      const lbl = document.createElement('span')
      lbl.className = 'th-label'
      lbl.textContent = col.name
      inner.appendChild(lbl)
      if (isSorted) {
        const sortIcon = document.createElement('span')
        sortIcon.className = 'th-sort-icon'
        sortIcon.appendChild(createSortSvg(state.sqlSortDir))
        inner.appendChild(sortIcon)
      }
      const colGrip = document.createElement('button')
      colGrip.type = 'button'
      colGrip.className = 'th-col-grip'
      colGrip.title = `Select column "${col.name}"`
      colGrip.textContent = '▾'
      colGrip.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        sqlGridSel?.selectCol(colIdx, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
        $('sqlResultWrap')?.focus({ preventScroll: true })
      })
      inner.appendChild(colGrip)

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
    state.lastSqlResult = res
    state.sqlSortColIdx = null
    state.sqlSortDir = 'ASC'
    state.sqlColWidths = []
    sortedSqlRowsCache = { res: null, colIdx: null, dir: 'ASC', rows: [] }
    getSqlGridSel()?.clear(true)

    const meta = $('sqlMetaBadge')
    meta.hidden = false
    meta.className = 'badge badge-ok'
    const truncSuffix = res.truncated ? ' · (truncated)' : ''
    const execMs = Number.isFinite(Number(res.executionTimeMs)) ? Number(res.executionTimeMs) : 0
    const summaryText = res.isSelect
      ? `${res.rowCount} rows · ${execMs.toFixed(1)} ms${truncSuffix}`
      : `${res.affectedRows ?? 0} affected · ${execMs.toFixed(1)} ms`
    meta.textContent = summaryText

    $('sqlErrorBanner').hidden = true
    $('sqlSuccessText').textContent = res.isSelect
      ? `Query executed successfully · ${summaryText}`
      : `Statement executed successfully · ${summaryText}`
    $('sqlSuccessBanner').hidden = false

    const scopeLbl = $('sqlResultScopeLabel')
    if (scopeLbl) {
      scopeLbl.textContent = `Query Result (${res.rows?.length || 0} row${(res.rows?.length || 0) === 1 ? '' : 's'})`
    }
    const wrap = $('sqlResultWrap')
    if (wrap && !opts.preserveScroll) wrap.scrollTop = 0
    renderSqlResultTableOnly()
    if (!opts.skipCache) {
      savePanelDataCache?.()
    }
  }

  async function runSql(mode = 'caret') {
    if (!state.activeConnectionId || state.activeQueryId) return
    const editor = $('sqlEditor')
    const rawScript = editor.value
    const conn = getActiveConn()
    const runConnId = state.activeConnectionId
    const runDriver = conn?.driver || 'sqlite'
    let sql = rawScript.trim()
    const selStart = editor.selectionStart ?? 0
    const selEnd = editor.selectionEnd ?? 0
    const isSingleStatementMode = mode === 'caret' || mode === 'explain'
    if (isSingleStatementMode && selEnd > selStart) {
      sql = rawScript.slice(selStart, selEnd).trim()
    } else if (isSingleStatementMode && runDriver !== 'redis') {
      const caret = editor.selectionStart ?? rawScript.length
      sql = findStatementAtOffset(rawScript, caret, runDriver).trim()
    }
    if (!sql) return

    const runSeq = ++sqlRunSeq
    const queryId = `panel_sql_${Date.now()}`
    state.activeQueryId = queryId
    $('sqlSuccessBanner').hidden = true
    $('sqlErrorBanner').hidden = true
    $('runSqlBtn').disabled = true
    $('runAllSqlBtn').disabled = true
    $('explainSqlBtn').disabled = true
    if ($('formatSqlBtn')) $('formatSqlBtn').disabled = true
    const cancelBtn = $('cancelSqlBtn')
    setButtonLoading(cancelBtn, false)
    cancelBtn.hidden = false

    const meta = $('sqlMetaBadge')
    meta.hidden = false
    meta.className = 'badge badge-info'
    const phaseWord = mode === 'explain' ? 'Explaining' : 'Running'
    const setRunningBadge = (elapsed) => {
      if (runSeq !== sqlRunSeq || state.activeConnectionId !== runConnId) return
      meta.textContent = ''
      const sp = document.createElement('span')
      sp.className = 'btn-spinner btn-spinner-sm'
      sp.style.marginRight = '5px'
      sp.setAttribute('aria-hidden', 'true')
      const lbl = document.createElement('span')
      lbl.textContent = `${phaseWord} ${elapsed}...`
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
      let configuredMaxRows
      if (mode !== 'explain' && typeof window.orca?.settings?.get === 'function') {
        try {
          const rawMax = Number(await window.orca.settings.get('maxRows'))
          if (Number.isFinite(rawMax) && rawMax > 0) {
            configuredMaxRows = Math.max(1, Math.min(50000, Math.floor(rawMax)))
          }
        } catch {}
        if (runSeq !== sqlRunSeq || state.activeConnectionId !== runConnId) return
      }
      const rpcName = mode === 'explain' ? 'query.explain' : 'query.run'
      const payload =
        mode === 'explain'
          ? { connectionId: runConnId, queryId, sql }
          : {
              connectionId: runConnId,
              queryId,
              sql,
              ...(configuredMaxRows ? { maxRows: configuredMaxRows } : {}),
            }
      const res = await rpc(rpcName, payload, { timeoutMs: QUERY_TIMEOUT_MS })
      stopTimer()
      if (runSeq !== sqlRunSeq || state.activeConnectionId !== runConnId) {
        if (
          mode !== 'explain' &&
          panelContainsDdlStatement(sql, runDriver) &&
          getConnById(runConnId)
        ) {
          void loadSchema(runConnId)
        }
        return
      }
      renderQueryResult(res)
      if (mode !== 'explain' && panelContainsDdlStatement(sql, runDriver)) {
        void loadSchema(runConnId)
      }
      if (state.historyOpen) void loadQueryHistory()
    } catch (err) {
      stopTimer()
      if (runSeq !== sqlRunSeq || state.activeConnectionId !== runConnId) return
      state.lastSqlResult = null
      sqlVirt.active = false
      $('sqlSuccessBanner').hidden = true
      $('sqlResultWrap').hidden = true
      if ($('sqlResultMeta')) $('sqlResultMeta').hidden = true
      meta.hidden = false
      meta.className = 'badge badge-danger'
      meta.textContent = 'Query Failed'
      state.lastError = err?.message || String(err)
      $('sqlErrorText').textContent = `SQL Execution Error: ${state.lastError}`
      $('sqlErrorBanner').hidden = false
    } finally {
      stopTimer()
      if (sqlStopTimer === stopTimer) sqlStopTimer = null
      if (runSeq === sqlRunSeq) {
        state.activeQueryId = null
        $('runSqlBtn').disabled = false
        $('runAllSqlBtn').disabled = false
        $('explainSqlBtn').disabled = false
        if ($('formatSqlBtn')) $('formatSqlBtn').disabled = false
        setButtonLoading(cancelBtn, false)
        cancelBtn.hidden = true
      }
    }
  }

  async function loadQueryHistory() {
    const reqSeq = ++historySeq
    state.historyLoading = true
    const refBtn = $('refreshHistoryBtn')
    setButtonLoading(refBtn, true, 'Loading...')
    renderQueryHistory()
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
        $('sqlEditor').value = entry.sql
        $('sqlEditor').focus()
        savePanelViewState()
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

  function cancelPendingSqlRun() {
    sqlRunSeq++
    if (sqlStopTimer) {
      sqlStopTimer()
      sqlStopTimer = null
    }
  }

  function bumpHistorySeq() {
    historySeq++
  }

  return {
    sqlVirt,
    renderSqlSafetyBanner,
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
    cancelPendingSqlRun,
    bumpHistorySeq,
  }
}
