// src/panel/panel-explorer.js
// Side Panel Schema Explorer tree, SQL snippet generator, row counter, and unified context menu

import {
  ENGINE_BY_ID,
  quoteIdent,
  quoteTableRef,
  formatSqlLiteral,
  formatDdlForDisplay,
  formatConnectionScopedMessage,
} from './panel-core.js'
import {
  $,
  setDbLogoElement,
  rpc,
  makeTableKey,
  createEnvBadge,
  getFolderSvgMarkup,
} from './panel-utils.js'
import {
  UNGROUPED_FOLDER_ORDER_KEY,
  normalizeConnectionFolderKey,
  getConnectionReorderBounds,
  computeReorderedFolderIds,
  computeMovedFolderIds,
  getConnectionFolderOrderKeys,
  sortFoldersByOrder,
  getFolderReorderBounds,
  computeReorderedFolders,
  computeMovedFolders,
} from '../shared-connection-order.js'

export function getExplorerObjectGroupLabel(driver) {
  if (driver === 'redis') return 'Keyspaces'
  if (driver === 'mongodb') return 'Collections'
  return 'Tables'
}

export function buildCountQueryForObject(conn, obj) {
  const driver = conn?.driver || 'sqlite'
  if (driver === 'mongodb') {
    return `db.getCollection(${JSON.stringify(obj.name)}).countDocuments({});`
  }
  const qTable = quoteTableRef(obj.name, obj.schema, driver)
  return `SELECT COUNT(*) AS row_count FROM ${qTable};`
}

function buildSelectPreviewQuery(conn, obj) {
  const driver = conn?.driver || 'sqlite'
  if (driver === 'mongodb') {
    return `db.getCollection(${JSON.stringify(obj.name)}).find({}).limit(100);`
  }
  const qTable = quoteTableRef(obj.name, obj.schema, driver)
  if (driver === 'mssql') {
    return `SELECT TOP 100 * FROM ${qTable};`
  }
  if (driver === 'oracle') {
    return `SELECT * FROM ${qTable} FETCH FIRST 100 ROWS ONLY;`
  }
  return `SELECT * FROM ${qTable} LIMIT 100;`
}

function buildMongoSampleFieldValue(type) {
  if (/INT|NUMBER|DECIMAL|NUMERIC|DOUBLE|FLOAT|LONG/i.test(String(type || ''))) return 0
  if (/BOOL/i.test(String(type || ''))) return false
  return ''
}

export function generateSqlForTable(kind, conn, obj, details) {
  const driver = conn?.driver || 'sqlite'
  if (driver === 'redis') {
    if (kind === 'select') {
      return obj.name === '(root)'
        ? 'SCAN 0 MATCH * COUNT 50'
        : `SCAN 0 MATCH ${obj.name} COUNT 50`
    }
    if (kind === 'insert') return 'SET key_name "value"'
    if (kind === 'update') return 'SET key_name "updated_value" KEEPTTL'
    return 'INFO keyspace'
  }
  if (driver === 'mongodb') {
    const colCall = `db.getCollection(${JSON.stringify(obj.name)})`
    if (kind === 'select') {
      return `${colCall}.find({}).limit(100);`
    }
    const cols = (details?.columns || []).filter((c) => c.name !== '_id' && !c.isAutoIncrement)
    const sampleDoc = {}
    for (const c of cols.length > 0 ? cols : [{ name: 'name', type: 'String' }]) {
      sampleDoc[c.name] = buildMongoSampleFieldValue(c.type)
    }
    if (kind === 'insert') {
      return `${colCall}.insertOne(${JSON.stringify(sampleDoc, null, 2)});`
    }
    if (kind === 'update') {
      return `${colCall}.updateOne({ _id: "" }, { $set: ${JSON.stringify(sampleDoc, null, 2)} });`
    }
    return `${colCall}.find({}).limit(100);`
  }
  const qTable = quoteTableRef(obj.name, obj.schema, driver)
  const cols = details?.columns || []
  if (kind === 'select') {
    const colList = cols.length > 0 ? cols.map((c) => quoteIdent(c.name, driver)).join(', ') : '*'
    if (driver === 'mssql') {
      return `SELECT TOP 100 ${colList}\nFROM ${qTable};`
    }
    if (driver === 'oracle') {
      return `SELECT ${colList}\nFROM ${qTable}\nFETCH FIRST 100 ROWS ONLY;`
    }
    return `SELECT ${colList}\nFROM ${qTable}\nLIMIT 100;`
  }
  if (kind === 'insert') {
    const insertCols = cols.filter((c) => !c.isAutoIncrement)
    const targetCols = insertCols.length > 0 ? insertCols : cols
    if (targetCols.length === 0) return `INSERT INTO ${qTable} () VALUES ();`
    const colNames = targetCols.map((c) => quoteIdent(c.name, driver)).join(', ')
    const placeholders = targetCols.map((c) => `:${c.name}`).join(', ')
    return `INSERT INTO ${qTable} (${colNames})\nVALUES (${placeholders});`
  }
  if (kind === 'update') {
    const pks = cols.filter((c) => c.isPrimaryKey)
    const nonPks = cols.filter((c) => !c.isPrimaryKey)
    const setPart = (nonPks.length > 0 ? nonPks : cols)
      .map((c) => `${quoteIdent(c.name, driver)} = :${c.name}`)
      .join(', ')
    const wherePart = (pks.length > 0 ? pks : cols.slice(0, 1))
      .map((c) => `${quoteIdent(c.name, driver)} = :${c.name}`)
      .join(' AND ')
    return `UPDATE ${qTable}\nSET ${setPart || 'col = :val'}\nWHERE ${wherePart || '1 = 0'};`
  }
  return buildSelectPreviewQuery(conn, obj)
}

export function closeContextMenu() {
  const menu = $('contextMenu')
  if (!menu) return
  menu.hidden = true
  menu.textContent = ''
}

export function createPanelExplorerController(ctx) {
  const {
    state,
    QUERY_TIMEOUT_MS,
    getActiveConn,
    getConnById,
    isSubmittingChanges,
    getDataGridSel,
    getActiveTableKey,
    getPinnedColsSet,
    activateConnection,
    loadSchema,
    selectTableAndOpen,
    showBanner,
    showConnectionBanner,
    copyText,
    exportCurrentDataPage,
    exportCurrentSqlResult,
    renderValueInspector,
    renderStagingBar,
    copyDataSelection,
    copySqlSelection,
    triggerPanelPasteSmart,
    triggerPanelPasteNewRows,
    isActiveDataObjectView,
    addBlankDataRow,
    bulkSetSelectedCellsValue,
    openBulkFillModal,
    applyQuickWhere,
    jumpToForeignKeyTarget,
    cloneSelectedRows,
    toggleDeleteSelectedRows,
    toggleColumnPinned,
    toggleColumnHidden,
    autoFitDataColumn,
    switchTab,
    openFullStudio,
    openDangerTableModal,
    openCreateTableModal,
    persistActiveConnectionId,
    renderConnectionsBar,
    renderSqlSafetyBanner,
    resetSqlSafetyBannerDismissal,
    setSqlText,
    populateFormFromProfile,
    openDeleteConfirmModal,
    savePanelViewState,
    reorderConnectionsInFolder,
    reorderFolders,
  } = ctx

  let countRowsSeq = 0
  let sqlGenSeq = 0
  const announcedSchemaErrors = new Map()
  let activeDrag = null
  let dropIndicator = null
  let pendingFocusTarget = null

  function clearDropIndicator() {
    if (!dropIndicator) return
    dropIndicator.rowEl?.classList?.remove('is-drop-before', 'is-drop-after')
    dropIndicator = null
  }

  function clearActiveDrag() {
    clearDropIndicator()
    if (activeDrag?.rowEl) {
      activeDrag.rowEl.classList.remove('is-dragging')
    }
    activeDrag = null
  }

  function setDropIndicator(rowEl, placement) {
    if (dropIndicator && dropIndicator.rowEl === rowEl && dropIndicator.placement === placement) {
      return
    }
    clearDropIndicator()
    rowEl.classList.add(placement === 'before' ? 'is-drop-before' : 'is-drop-after')
    dropIndicator = { rowEl, placement }
  }

  function resolveDropPlacement(connItem, clientY) {
    const rect =
      typeof connItem.getBoundingClientRect === 'function' ? connItem.getBoundingClientRect() : null
    const midpoint = rect ? rect.top + rect.height / 2 : 0
    return clientY < midpoint ? 'before' : 'after'
  }

  function getFolderCollapseKey(folderOrderKey) {
    return folderOrderKey === UNGROUPED_FOLDER_ORDER_KEY
      ? `builtin:${UNGROUPED_FOLDER_ORDER_KEY}`
      : `folder:${folderOrderKey}`
  }

  function isFolderSectionCollapsed(folderOrderKey) {
    const collapsed = state.collapsedFolders
    if (!collapsed) return false
    const sectionKey = getFolderCollapseKey(folderOrderKey)
    if (collapsed.has(sectionKey)) return true
    if (folderOrderKey !== UNGROUPED_FOLDER_ORDER_KEY && folderOrderKey !== 'General (Ungrouped)') {
      return collapsed.has(folderOrderKey)
    }
    return false
  }

  function toggleFolderSectionCollapsed(folderOrderKey) {
    if (!state.collapsedFolders) state.collapsedFolders = new Set()
    const sectionKey = getFolderCollapseKey(folderOrderKey)
    if (isFolderSectionCollapsed(folderOrderKey)) {
      state.collapsedFolders.delete(sectionKey)
      if (folderOrderKey !== UNGROUPED_FOLDER_ORDER_KEY && folderOrderKey !== 'General (Ungrouped)') {
        state.collapsedFolders.delete(folderOrderKey)
      }
    } else {
      state.collapsedFolders.add(sectionKey)
    }
  }

  function getFolderOrderKeys() {
    return getConnectionFolderOrderKeys(state.connections)
  }

  function moveConnectionDirection(connectionId, direction, focusTarget = 'row') {
    if (state.filter.trim().length > 0) return
    if (typeof reorderConnectionsInFolder !== 'function') return
    const plan = computeMovedFolderIds(state.connections, connectionId, direction)
    if (!plan.ok || !plan.changed) return
    if (focusTarget === 'row' || focusTarget === 'menu') {
      pendingFocusTarget = { kind: 'connection', connectionId, onMenuBtn: focusTarget === 'menu' }
    }
    void reorderConnectionsInFolder(plan.folder, plan.orderedIds)
  }

  function moveFolderDirection(folderOrderKey, direction, focusTarget = 'row') {
    if (state.filter.trim().length > 0) return
    if (typeof reorderFolders !== 'function') return
    const folderKeys = getFolderOrderKeys()
    const plan = computeMovedFolders(folderKeys, folderOrderKey, direction, state.folderOrder)
    if (!plan.ok || !plan.changed) return
    if (focusTarget === 'row' || focusTarget === 'menu') {
      pendingFocusTarget = { kind: 'folder', folderOrderKey, onMenuBtn: focusTarget === 'menu' }
    }
    void reorderFolders(plan.orderedFolders)
  }

  function reportConnectionError(connectionId, connObj, msg) {
    if (typeof showConnectionBanner === 'function') {
      showConnectionBanner(connectionId, msg, 'danger')
    } else {
      showBanner(formatConnectionScopedMessage(connObj, msg), 'danger')
    }
  }

  async function countRowsForTable(conn, obj) {
    if (!conn || !obj || conn.driver === 'redis') return
    const reqSeq = ++countRowsSeq
    const targetConnId = conn.id
    const isMongo = conn.driver === 'mongodb'
    const sql = buildCountQueryForObject(conn, obj)
    showBanner(`Counting ${isMongo ? 'documents' : 'rows'} in ${obj.name}...`, 'neutral')
    try {
      const res = await rpc(
        'query.run',
        {
          connectionId: targetConnId,
          queryId: `panel_count_${Date.now()}`,
          sql,
          maxRows: 1,
        },
        { timeoutMs: QUERY_TIMEOUT_MS }
      )
      if (reqSeq !== countRowsSeq || !getConnById(targetConnId)) return
      const cnt = res?.rows?.[0]?.[0]
      showBanner(`${obj.name}: ${cnt ?? 0} ${isMongo ? 'document(s)' : 'row(s)'}`, 'success')
    } catch (err) {
      if (reqSeq !== countRowsSeq || !getConnById(targetConnId)) return
      const msg = `Count failed for ${obj.name}: ${err?.message || err}`
      reportConnectionError(targetConnId, conn, msg)
    }
  }

  function renderExplorer() {
    const empty = $('explorerEmpty')
    const filterWrap = $('schemaFilterWrap')
    const container = $('schemaTreeContainer')
    clearActiveDrag()

    const activeEl = typeof document !== 'undefined' ? document.activeElement : null
    let restoreFocus = pendingFocusTarget
    if (
      !restoreFocus &&
      activeEl &&
      typeof container.contains === 'function' &&
      container.contains(activeEl)
    ) {
      const focusedConnItem =
        typeof activeEl.closest === 'function' ? activeEl.closest('.tree-conn-item') : null
      const focusedRow =
        focusedConnItem && typeof focusedConnItem.closest === 'function'
          ? focusedConnItem.closest('.tree-row[data-connection-id]')
          : null
      if (focusedRow?.dataset?.connectionId) {
        restoreFocus = {
          kind: 'connection',
          connectionId: focusedRow.dataset.connectionId,
          onMenuBtn: Boolean(
            typeof activeEl.closest === 'function' && activeEl.closest('.tree-actions')
          ),
        }
      } else {
        const focusedFolderItem =
          typeof activeEl.closest === 'function' ? activeEl.closest('.tree-folder-item') : null
        const focusedFolderGroup =
          focusedFolderItem && typeof focusedFolderItem.closest === 'function'
            ? focusedFolderItem.closest('.tree-folder-group[data-folder-order-key]') ||
              focusedFolderItem.closest('.tree-folder-group[data-folder-name]')
            : null
        const focusedFolderKey =
          focusedFolderGroup?.dataset?.folderOrderKey || focusedFolderGroup?.dataset?.folderName
        if (focusedFolderKey) {
          restoreFocus = {
            kind: 'folder',
            folderOrderKey: focusedFolderKey,
            onMenuBtn: Boolean(
              typeof activeEl.closest === 'function' && activeEl.closest('.tree-actions')
            ),
          }
        }
      }
    }
    pendingFocusTarget = null

    const restoreFocusedTarget = () => {
      if (!restoreFocus) return
      if (restoreFocus.kind === 'connection') {
        const rows = container.querySelectorAll('.tree-row[data-connection-id]')
        for (const row of rows) {
          if (row?.dataset?.connectionId !== restoreFocus.connectionId) continue
          const targetEl = restoreFocus.onMenuBtn
            ? row.querySelector('.tree-conn-item .tree-actions .mini-btn') ||
              row.querySelector('.tree-conn-item')
            : row.querySelector('.tree-conn-item')
          targetEl?.focus?.()
          break
        }
        return
      }
      if (restoreFocus.kind === 'folder') {
        const groups = container.querySelectorAll('.tree-folder-group[data-folder-order-key]')
        for (const group of groups) {
          if (group?.dataset?.folderOrderKey !== restoreFocus.folderOrderKey) continue
          const folderHeadEl = group.querySelector('.tree-folder-item')
          const targetEl = restoreFocus.onMenuBtn
            ? folderHeadEl?.querySelector('.tree-actions .mini-btn') || folderHeadEl
            : folderHeadEl
          targetEl?.focus?.()
          break
        }
      }
    }

    container.textContent = ''
    if (!state.collapsedFolders) {
      state.collapsedFolders = new Set()
    }

    if (state.initialBootLoading && state.connections.length === 0) {
      empty.hidden = true
      filterWrap.hidden = true
      for (let i = 0; i < 4; i++) {
        const skRow = document.createElement('div')
        skRow.className = 'tree-item tree-conn-item'
        skRow.style.cursor = 'default'
        const bar = document.createElement('div')
        bar.className = 'panel-skeleton-bar'
        bar.style.width = `${55 + (i % 3) * 14}%`
        skRow.appendChild(bar)
        container.appendChild(skRow)
      }
      return
    }

    if (state.connections.length === 0) {
      empty.hidden = false
      filterWrap.hidden = true
      return
    }
    empty.hidden = true
    filterWrap.hidden = false

    const q = state.filter.trim().toLowerCase()
    const folderCounts = new Map()
    for (const c of state.connections) {
      const fk = normalizeConnectionFolderKey(c?.folder)
      folderCounts.set(fk, (folderCounts.get(fk) || 0) + 1)
    }
    let hasAnyReorderableRow = false
    if (!q) {
      for (const count of folderCounts.values()) {
        if (count > 1) {
          hasAnyReorderableRow = true
          break
        }
      }
    }

    const createConnectionErrorBlock = (conn, schemaErr) => {
      const errBox = document.createElement('div')
      errBox.className = 'tree-conn-error'
      const prevAnnounced = announcedSchemaErrors.get(conn.id)
      if (!q && prevAnnounced !== schemaErr) {
        errBox.setAttribute('role', 'alert')
        announcedSchemaErrors.set(conn.id, schemaErr)
      }

      const errHead = document.createElement('div')
      errHead.className = 'tree-conn-error-head'

      const errIcon = document.createElement('span')
      errIcon.className = 'tree-conn-error-icon'
      errIcon.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>'

      const errMsg = document.createElement('span')
      errMsg.className = 'tree-conn-error-msg'
      errMsg.textContent = schemaErr

      errHead.append(errIcon, errMsg)
      errBox.appendChild(errHead)

      const errActions = document.createElement('div')
      errActions.className = 'tree-conn-error-actions'

      const isReloading = state.schemaLoading.has(conn.id)
      const retryBtn = document.createElement('button')
      retryBtn.type = 'button'
      retryBtn.className = 'mini-btn'
      retryBtn.dataset.action = 'retry-schema'
      retryBtn.textContent = isReloading ? 'Retrying...' : 'Retry'
      retryBtn.disabled = isReloading
      if (isReloading) retryBtn.setAttribute('aria-busy', 'true')
      retryBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        if (state.schemaLoading.has(conn.id)) return
        void loadSchema(conn.id)
      })
      errActions.appendChild(retryBtn)

      const isEditable = !ENGINE_BY_ID[conn.driver]?.studioOnly
      if (isEditable) {
        const editBtn = document.createElement('button')
        editBtn.type = 'button'
        editBtn.className = 'mini-btn'
        editBtn.dataset.action = 'edit-connection'
        editBtn.textContent = 'Edit'
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          const latest = getConnById(conn.id) || conn
          populateFormFromProfile(latest, 'edit')
        })
        errActions.appendChild(editBtn)
      }

      errBox.appendChild(errActions)
      return errBox
    }

    const buildConnectionRow = (conn) => {
      const objects = state.schemaObjects[conn.id] || []
      const connSchemas = new Set(objects.map((o) => o.schema || '').filter(Boolean))
      const hasMultiSchemas = connSchemas.size > 1
      const matchingObjs = objects.filter((o) => {
        if (!q) return true
        if (o.name.toLowerCase().includes(q)) return true
        if (o.schema && `${o.schema}.${o.name}`.toLowerCase().includes(q)) return true
        const d = state.tableDetails[makeTableKey(conn.id, o.name, o.schema)]
        return Boolean(d?.columns?.some((c) => c.name.toLowerCase().includes(q)))
      })
      const folderStr = (conn.folder || '').trim().toLowerCase()
      const connMatches =
        !q ||
        conn.name.toLowerCase().includes(q) ||
        conn.driver.toLowerCase().includes(q) ||
        folderStr.includes(q)
      if (q && !connMatches && matchingObjs.length === 0) return null

      const isConnOpen = state.expandedConns.has(conn.id) || (Boolean(q) && matchingObjs.length > 0)
      const schemaErr =
        typeof state.schemaErrors?.[conn.id] === 'string' ? state.schemaErrors[conn.id] : ''
      const folderKey = normalizeConnectionFolderKey(conn.folder)
      const canReorderRow = !q && (folderCounts.get(folderKey) || 0) > 1
      const connRow = document.createElement('div')
      connRow.className = 'tree-row'
      connRow.dataset.connectionId = conn.id
      connRow.dataset.folderKey = folderKey

      const connItem = document.createElement('div')
      connItem.className = `tree-item tree-conn-item${state.activeConnectionId === conn.id ? ' active' : ''}${schemaErr ? ' has-error' : ''}${canReorderRow ? ' is-reorderable' : ''}`
      connItem.setAttribute('role', 'button')
      connItem.tabIndex = 0
      connItem.title = `${conn.name} (${conn.driver})${conn.folder ? ` — Folder: ${conn.folder}` : ''}${schemaErr ? ` — Error: ${schemaErr}` : ''}`
      if (canReorderRow) {
        connItem.draggable = true
        connItem.setAttribute('draggable', 'true')
        const grip = document.createElement('span')
        grip.className = 'tree-drag-handle'
        grip.setAttribute('aria-hidden', 'true')
        grip.title = 'Drag to reorder within folder'
        grip.innerHTML =
          '<svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor" aria-hidden="true"><circle cx="3" cy="2" r="1"></circle><circle cx="7" cy="2" r="1"></circle><circle cx="3" cy="6" r="1"></circle><circle cx="7" cy="6" r="1"></circle><circle cx="3" cy="10" r="1"></circle><circle cx="7" cy="10" r="1"></circle></svg>'
        connItem.appendChild(grip)
      } else if (hasAnyReorderableRow) {
        const spacer = document.createElement('span')
        spacer.className = 'tree-drag-spacer'
        spacer.setAttribute('aria-hidden', 'true')
        connItem.appendChild(spacer)
      }

      const chev = document.createElement('span')
      chev.className = `tree-chevron${isConnOpen ? ' open' : ''}`
      chev.innerHTML =
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>'

      const logo = document.createElement('span')
      setDbLogoElement(logo, conn.driver, 14)

      const nameEl = document.createElement('span')
      nameEl.className = 'tree-name'
      nameEl.textContent = conn.name

      connItem.append(chev, logo, nameEl)

      if (schemaErr) {
        const errDot = document.createElement('span')
        errDot.className = 'conn-status-dot error'
        errDot.setAttribute('role', 'img')
        errDot.title = schemaErr
        errDot.setAttribute('aria-label', `Connection error: ${schemaErr}`)
        connItem.appendChild(errDot)
      } else {
        announcedSchemaErrors.delete(conn.id)
      }

      if (state.schemaLoading.has(conn.id) && objects.length > 0) {
        const sp = document.createElement('span')
        sp.className = 'btn-spinner btn-spinner-sm'
        sp.title = 'Refreshing schema...'
        sp.setAttribute('aria-hidden', 'true')
        connItem.appendChild(sp)
      }

      const envBadge = createEnvBadge(conn.colorTag)
      if (envBadge) connItem.appendChild(envBadge)

      if (conn.readOnly) {
        const ro = document.createElement('span')
        ro.className = 'badge badge-ro'
        ro.textContent = 'RO'
        connItem.appendChild(ro)
      }

      const cActions = document.createElement('div')
      cActions.className = 'tree-actions'
      const menuBtn = document.createElement('button')
      menuBtn.type = 'button'
      menuBtn.className = 'mini-btn'
      menuBtn.draggable = false
      menuBtn.setAttribute('draggable', 'false')
      menuBtn.title = 'Connection Actions'
      menuBtn.setAttribute('aria-label', 'Connection Actions')
      menuBtn.textContent = '⋮'
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        const r = menuBtn.getBoundingClientRect()
        openContextMenu(r.left, r.bottom + 4, { type: 'connection', conn })
      })
      cActions.appendChild(menuBtn)
      connItem.appendChild(cActions)

      const toggleConn = () => {
        const isSwitching = state.activeConnectionId !== conn.id
        if (isSwitching) {
          state.expandedConns.add(conn.id)
          activateConnection(conn.id)
          return
        }
        if (state.expandedConns.has(conn.id)) {
          state.expandedConns.delete(conn.id)
        } else {
          state.expandedConns.add(conn.id)
          if (!state.schemaObjects[conn.id]) {
            void loadSchema(conn.id)
          }
        }
        savePanelViewState?.()
        renderExplorer()
      }

      connItem.addEventListener('click', toggleConn)
      connItem.addEventListener('keydown', (e) => {
        if (
          e.altKey &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.shiftKey &&
          (e.key === 'ArrowUp' || e.key === 'ArrowDown')
        ) {
          if (state.filter.trim().length > 0) return
          e.preventDefault()
          e.stopPropagation()
          moveConnectionDirection(conn.id, e.key === 'ArrowUp' ? 'up' : 'down', 'row')
          return
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          toggleConn()
        }
      })
      connItem.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        openContextMenu(e.clientX, e.clientY, { type: 'connection', conn })
      })

      if (canReorderRow) {
        let pointerDownInActions = false
        const markPointerDown = (e) => {
          const tgt = e.target
          pointerDownInActions = Boolean(
            tgt && typeof tgt.closest === 'function' && tgt.closest('.tree-actions')
          )
        }
        const clearPointerDown = () => {
          pointerDownInActions = false
        }
        connItem.addEventListener('pointerdown', markPointerDown)
        connItem.addEventListener('mousedown', markPointerDown)
        connItem.addEventListener('pointerup', clearPointerDown)
        connItem.addEventListener('mouseup', clearPointerDown)

        connItem.addEventListener('dragstart', (e) => {
          if (state.filter.trim().length > 0 || pointerDownInActions) {
            pointerDownInActions = false
            e.preventDefault()
            return
          }
          const tgt = e.target
          if (tgt && typeof tgt.closest === 'function' && tgt.closest('.tree-actions')) {
            e.preventDefault()
            return
          }
          closeContextMenu()
          clearActiveDrag()
          activeDrag = { kind: 'connection', connectionId: conn.id, folderKey, rowEl: connRow }
          connRow.classList.add('is-dragging')
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move'
            try {
              e.dataTransfer.setData('application/x-datanoa-connection-id', conn.id)
              e.dataTransfer.setData('text/plain', conn.id)
            } catch {
              // Ignore synthetic/read-only DataTransfer restrictions
            }
          }
        })
        connItem.addEventListener('dragend', () => {
          pointerDownInActions = false
          clearActiveDrag()
        })
      }

      connRow.addEventListener('dragover', (e) => {
        if (!activeDrag || activeDrag.kind !== 'connection' || state.filter.trim().length > 0) return
        if (activeDrag.folderKey !== folderKey) {
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
          clearDropIndicator()
          return
        }
        if (activeDrag.connectionId === conn.id) {
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
          clearDropIndicator()
          return
        }
        const placement = resolveDropPlacement(connItem, e.clientY)
        const plan = computeReorderedFolderIds(
          state.connections,
          activeDrag.connectionId,
          conn.id,
          placement
        )
        if (!plan.ok || !plan.changed) {
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
          clearDropIndicator()
          return
        }
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
        setDropIndicator(connRow, placement)
      })

      connRow.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && typeof connRow.contains === 'function' && connRow.contains(e.relatedTarget)) {
          return
        }
        if (dropIndicator?.rowEl === connRow) {
          clearDropIndicator()
        }
      })

      connRow.addEventListener('drop', (e) => {
        if (!activeDrag || activeDrag.kind !== 'connection' || state.filter.trim().length > 0) return
        if (activeDrag.folderKey !== folderKey) {
          clearDropIndicator()
          return
        }
        e.preventDefault()
        e.stopPropagation()
        const sourceId = activeDrag.connectionId
        const placement = resolveDropPlacement(connItem, e.clientY)
        clearActiveDrag()
        const plan = computeReorderedFolderIds(state.connections, sourceId, conn.id, placement)
        if (plan.ok && plan.changed && typeof reorderConnectionsInFolder === 'function') {
          void reorderConnectionsInFolder(plan.folder, plan.orderedIds)
        }
      })

      connRow.appendChild(connItem)

      if (isConnOpen) {
        const childrenBox = document.createElement('div')
        childrenBox.className = 'tree-children'

        if (state.schemaLoading.has(conn.id) && objects.length === 0) {
          const loadingMsg = document.createElement('div')
          loadingMsg.className = 'col-leaf'
          loadingMsg.style.justifyContent = 'flex-start'
          const sp = document.createElement('span')
          sp.className = 'btn-spinner btn-spinner-sm'
          sp.setAttribute('aria-hidden', 'true')
          const txt = document.createElement('span')
          txt.textContent = 'Loading schema...'
          loadingMsg.append(sp, txt)
          childrenBox.appendChild(loadingMsg)
          for (const w of ['72%', '58%', '64%']) {
            const sk = document.createElement('div')
            sk.className = 'col-leaf'
            const bar = document.createElement('div')
            bar.className = 'panel-skeleton-bar'
            bar.style.width = w
            sk.appendChild(bar)
            childrenBox.appendChild(sk)
          }
        } else {
          if (schemaErr) {
            childrenBox.appendChild(createConnectionErrorBlock(conn, schemaErr))
          }

          const staleInfo = state.schemaStaleByConn?.[conn.id]
          if (staleInfo?.stale) {
            const staleBanner = document.createElement('div')
            staleBanner.className = 'datanoa-sidebar-stale-banner'
            const badge = document.createElement('span')
            badge.className = 'datanoa-stale-badge'
            badge.textContent = 'Cached · Stale'
            if (staleInfo.staleReason) badge.title = staleInfo.staleReason
            const retryBtn = document.createElement('button')
            retryBtn.type = 'button'
            retryBtn.className = 'mini-btn datanoa-stale-retry-btn'
            retryBtn.textContent = 'Retry'
            retryBtn.title = 'Force refresh schema catalog from database'
            retryBtn.addEventListener('click', (e) => {
              e.stopPropagation()
              void loadSchema(conn.id, { force: true, forceRefresh: true })
            })
            staleBanner.append(badge, retryBtn)
            childrenBox.appendChild(staleBanner)
          }

          if (conn.driver !== 'redis') {
            const erRow = document.createElement('div')
            erRow.className = 'datanoa-er-studio-row'
            const erBtn = document.createElement('button')
            erBtn.type = 'button'
            erBtn.className = 'mini-btn datanoa-er-studio-btn'
            erBtn.textContent = 'Open ER Diagram in Studio ↗'
            erBtn.title = 'Open interactive ER Diagram view in Full Studio'
            erBtn.addEventListener('click', (e) => {
              e.stopPropagation()
              const connSchema = state.selectedSchemaByConn?.[conn.id]
              void openFullStudio({
                connectionId: conn.id,
                ...(connSchema ? { schema: connSchema } : {}),
                viewMode: 'er',
              })
            })
            erRow.appendChild(erBtn)
            childrenBox.appendChild(erRow)
          }

          const listToShow = q && !connMatches ? matchingObjs : q ? matchingObjs : objects
          const tables = listToShow.filter((o) => o.kind === 'table')
          const views = listToShow.filter((o) => o.kind === 'view')

          const renderObjGroup = (label, list, isView) => {
            if (list.length === 0) return
            const head = document.createElement('div')
            head.className = 'tree-group-head'
            const sp1 = document.createElement('span')
            sp1.textContent = label
            const sp2 = document.createElement('span')
            sp2.textContent = String(list.length)
            head.append(sp1, sp2)
            childrenBox.appendChild(head)

            const listEl = document.createElement('div')
            listEl.className = 'tree-list'

            for (const obj of list) {
              const tKey = makeTableKey(conn.id, obj.name, obj.schema)
              const isActiveTable =
                state.activeConnectionId === conn.id &&
                state.activeTable === obj.name &&
                (state.activeSchema || '') === (obj.schema || '')
              const isTableOpen = state.expandedTables.has(tKey)

              const objRow = document.createElement('div')
              objRow.className = 'tree-row'

              const itemBtn = document.createElement('div')
              itemBtn.className = `tree-item${isActiveTable ? ' active' : ''}`
              itemBtn.setAttribute('role', 'button')
              itemBtn.tabIndex = 0

              const tChev = document.createElement('span')
              tChev.className = `tree-chevron${isTableOpen ? ' open' : ''}`
              tChev.innerHTML =
                '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>'

              const icon = document.createElement('span')
              icon.style.color = isView ? 'var(--warn)' : 'var(--t2)'
              icon.innerHTML = isView
                ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>'
                : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>'

              const nm = document.createElement('span')
              nm.className = 'tree-name'
              nm.textContent =
                hasMultiSchemas && obj.schema ? `${obj.schema}.${obj.name}` : obj.name

              const actions = document.createElement('div')
              actions.className = 'tree-actions'
              const browseBtn = document.createElement('button')
              browseBtn.type = 'button'
              browseBtn.className = 'mini-btn'
              browseBtn.textContent = 'Data'
              browseBtn.addEventListener('click', (e) => {
                e.stopPropagation()
                selectTableAndOpen(conn.id, obj.name, obj.schema, true)
              })
              const moreBtn = document.createElement('button')
              moreBtn.type = 'button'
              moreBtn.className = 'mini-btn'
              moreBtn.title = conn.driver === 'mongodb' ? 'Collection Actions' : 'Table Actions'
              moreBtn.setAttribute('aria-label', moreBtn.title)
              moreBtn.textContent = '⋮'
              moreBtn.addEventListener('click', (e) => {
                e.stopPropagation()
                const r = moreBtn.getBoundingClientRect()
                openContextMenu(r.left, r.bottom + 4, { type: 'object', conn, obj })
              })
              actions.append(browseBtn, moreBtn)

              itemBtn.append(tChev, icon, nm, actions)

              const activateObj = () => {
                if (state.expandedTables.has(tKey)) {
                  state.expandedTables.delete(tKey)
                } else {
                  state.expandedTables.add(tKey)
                }
                selectTableAndOpen(conn.id, obj.name, obj.schema, false)
              }

              itemBtn.addEventListener('click', activateObj)
              itemBtn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  activateObj()
                }
              })
              itemBtn.addEventListener('contextmenu', (e) => {
                e.preventDefault()
                openContextMenu(e.clientX, e.clientY, { type: 'object', conn, obj })
              })
              objRow.appendChild(itemBtn)

              const details = state.tableDetails[tKey]
              const detailsErr = state.tableDetailsErrors[tKey]
              if (isTableOpen && !details && detailsErr) {
                const errBox = document.createElement('div')
                errBox.className = 'tree-children'
                const errLine = document.createElement('div')
                errLine.className = 'col-leaf'
                errLine.style.color = 'var(--danger)'
                errLine.textContent = detailsErr
                errBox.appendChild(errLine)
                objRow.appendChild(errBox)
              } else if (isTableOpen && !details) {
                const skBox = document.createElement('div')
                skBox.className = 'tree-children'
                for (const w of ['68%', '54%', '76%']) {
                  const skLine = document.createElement('div')
                  skLine.className = 'col-leaf'
                  const bar = document.createElement('div')
                  bar.className = 'panel-skeleton-bar'
                  bar.style.width = w
                  skLine.appendChild(bar)
                  skBox.appendChild(skLine)
                }
                objRow.appendChild(skBox)
              } else if (isTableOpen && details) {
                const metaBox = document.createElement('div')
                metaBox.className = 'tree-children'

                if (details.columns?.length) {
                  for (const col of details.columns) {
                    const leaf = document.createElement('div')
                    leaf.className = 'col-leaf'
                    const cName = document.createElement('span')
                    cName.className = 'col-leaf-name'
                    cName.textContent = col.name
                    const right = document.createElement('div')
                    right.className = 'col-leaf-meta'
                    if (col.isPrimaryKey) {
                      const pk = document.createElement('span')
                      pk.className = 'badge badge-pk'
                      pk.textContent = 'PK'
                      right.appendChild(pk)
                    }
                    const cType = document.createElement('span')
                    cType.className = 'col-leaf-type'
                    cType.textContent = col.type || col.nativeType
                    right.appendChild(cType)
                    leaf.append(cName, right)
                    metaBox.appendChild(leaf)
                  }
                }

                if (details.indexes?.length) {
                  const idxHead = document.createElement('div')
                  idxHead.className = 'tree-group-head'
                  idxHead.textContent = `Indexes (${details.indexes.length})`
                  metaBox.appendChild(idxHead)
                  for (const idx of details.indexes) {
                    const leaf = document.createElement('div')
                    leaf.className = 'col-leaf'
                    const n = document.createElement('span')
                    n.className = 'col-leaf-name'
                    n.textContent = idx.name
                    const t = document.createElement('span')
                    t.className = 'col-leaf-type'
                    t.textContent = idx.columns.join(', ')
                    leaf.append(n, t)
                    metaBox.appendChild(leaf)
                  }
                }

                if (details.foreignKeys?.length) {
                  const fkHead = document.createElement('div')
                  fkHead.className = 'tree-group-head'
                  fkHead.textContent = `Foreign Keys (${details.foreignKeys.length})`
                  metaBox.appendChild(fkHead)
                  for (const fk of details.foreignKeys) {
                    const leaf = document.createElement('div')
                    leaf.className = 'col-leaf'
                    const n = document.createElement('span')
                    n.className = 'col-leaf-name'
                    n.textContent = `${fk.column} → ${fk.referencedTable}.${fk.referencedColumn}`
                    metaBox.appendChild(n)
                  }
                }

                objRow.appendChild(metaBox)
              }

              listEl.appendChild(objRow)
            }
            childrenBox.appendChild(listEl)
          }

          renderObjGroup(getExplorerObjectGroupLabel(conn.driver), tables, false)
          renderObjGroup('Views', views, true)

          if (tables.length === 0 && views.length === 0 && (!schemaErr || objects.length > 0)) {
            const none = document.createElement('div')
            none.className = 'col-leaf'
            const selectedSchema =
              typeof state.selectedSchemaByConn?.[conn.id] === 'string'
                ? state.selectedSchemaByConn[conn.id].trim()
                : ''
            const hasMultiSchemasAvail =
              Array.isArray(state.availableSchemasByConn?.[conn.id]) &&
              state.availableSchemasByConn[conn.id].length > 1
            none.textContent =
              objects.length === 0
                ? !schemaErr && selectedSchema && hasMultiSchemasAvail
                  ? `No tables or views in "${selectedSchema}"`
                  : conn.driver === 'mongodb'
                    ? 'No collections found'
                    : 'No tables found'
                : 'No matching objects'
            childrenBox.appendChild(none)
          }
        }

        connRow.appendChild(childrenBox)
      }

      return connRow
    }

    const hasAnyFolder = state.connections.some((c) => Boolean(normalizeConnectionFolderKey(c.folder)))
    if (!hasAnyFolder) {
      for (const conn of state.connections) {
        const node = buildConnectionRow(conn)
        if (node) container.appendChild(node)
      }
      restoreFocusedTarget()
      return
    }

    const byFolder = new Map()
    const ungrouped = []
    for (const conn of state.connections) {
      const f = normalizeConnectionFolderKey(conn.folder)
      if (f) {
        if (!byFolder.has(f)) byFolder.set(f, [])
        byFolder.get(f).push(conn)
      } else {
        ungrouped.push(conn)
      }
    }

    const sectionKeys = [
      ...byFolder.keys(),
      ...(ungrouped.length > 0 ? [UNGROUPED_FOLDER_ORDER_KEY] : []),
    ]
    const sortedSectionKeys = sortFoldersByOrder(sectionKeys, state.folderOrder)
    const hasMultipleFolders = sortedSectionKeys.length > 1
    const hasReorderableFolders = !q && hasMultipleFolders

    const renderFolderSection = (folderOrderKey, folderLabel, connList) => {
      const nodes = []
      for (const conn of connList) {
        const node = buildConnectionRow(conn)
        if (node) nodes.push(node)
      }
      if (nodes.length === 0) return

      const collapseKey = getFolderCollapseKey(folderOrderKey)
      const isCollapsed = !q && isFolderSectionCollapsed(folderOrderKey)
      const canReorderFolder = hasReorderableFolders
      const folderGroup = document.createElement('div')
      folderGroup.className = 'tree-folder-group'
      folderGroup.dataset.folderName = folderLabel
      folderGroup.dataset.folderOrderKey = folderOrderKey
      folderGroup.dataset.sectionKey = collapseKey
      if (canReorderFolder) {
        folderGroup.dataset.reorderableFolder = '1'
      }

      const folderHead = document.createElement('div')
      folderHead.className = `tree-item tree-folder-item${canReorderFolder ? ' is-reorderable' : ''}`
      folderHead.setAttribute('role', 'button')
      folderHead.tabIndex = 0
      folderHead.title = `Folder "${folderLabel}" (${nodes.length} connection(s)) — Click to ${isCollapsed ? 'expand' : 'collapse'}`

      if (canReorderFolder) {
        folderHead.draggable = true
        folderHead.setAttribute('draggable', 'true')
        const grip = document.createElement('span')
        grip.className = 'tree-drag-handle'
        grip.setAttribute('aria-hidden', 'true')
        grip.title = 'Drag to reorder folder'
        grip.innerHTML =
          '<svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor" aria-hidden="true"><circle cx="3" cy="2" r="1"></circle><circle cx="7" cy="2" r="1"></circle><circle cx="3" cy="6" r="1"></circle><circle cx="7" cy="6" r="1"></circle><circle cx="3" cy="10" r="1"></circle><circle cx="7" cy="10" r="1"></circle></svg>'
        folderHead.appendChild(grip)
      }

      const fChev = document.createElement('span')
      fChev.className = `tree-chevron${isCollapsed ? '' : ' open'}`
      fChev.innerHTML =
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>'

      const fIcon = document.createElement('span')
      fIcon.className = 'tree-folder-icon'
      fIcon.innerHTML = getFolderSvgMarkup(!isCollapsed, 13)

      const fName = document.createElement('span')
      fName.className = 'tree-name'
      fName.textContent = folderLabel

      const fCount = document.createElement('span')
      fCount.className = 'badge badge-neutral'
      fCount.textContent = String(nodes.length)

      folderHead.append(fChev, fIcon, fName, fCount)

      if (hasMultipleFolders) {
        const fActions = document.createElement('div')
        fActions.className = 'tree-actions'
        const fMenuBtn = document.createElement('button')
        fMenuBtn.type = 'button'
        fMenuBtn.className = 'mini-btn'
        fMenuBtn.draggable = false
        fMenuBtn.setAttribute('draggable', 'false')
        fMenuBtn.title = 'Folder Actions'
        fMenuBtn.setAttribute('aria-label', 'Folder Actions')
        fMenuBtn.textContent = '⋮'
        fMenuBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          const r = fMenuBtn.getBoundingClientRect()
          openContextMenu(r.left, r.bottom + 4, {
            type: 'folder',
            folderName: folderLabel,
            folderOrderKey,
          })
        })
        fActions.appendChild(fMenuBtn)
        folderHead.appendChild(fActions)
      }

      const toggleFolder = () => {
        toggleFolderSectionCollapsed(folderOrderKey)
        savePanelViewState?.()
        renderExplorer()
      }

      folderHead.addEventListener('click', toggleFolder)
      folderHead.addEventListener('keydown', (e) => {
        if (
          hasMultipleFolders &&
          e.altKey &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.shiftKey &&
          (e.key === 'ArrowUp' || e.key === 'ArrowDown')
        ) {
          if (state.filter.trim().length > 0) return
          e.preventDefault()
          e.stopPropagation()
          moveFolderDirection(folderOrderKey, e.key === 'ArrowUp' ? 'up' : 'down', 'row')
          return
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          toggleFolder()
        }
      })

      folderHead.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        openContextMenu(e.clientX, e.clientY, {
          type: 'folder',
          folderName: folderLabel,
          folderOrderKey,
        })
      })

      if (canReorderFolder) {
        let pointerDownInActions = false
        const markPointerDown = (e) => {
          const tgt = e.target
          pointerDownInActions = Boolean(
            tgt && typeof tgt.closest === 'function' && tgt.closest('.tree-actions')
          )
        }
        const clearPointerDown = () => {
          pointerDownInActions = false
        }
        folderHead.addEventListener('pointerdown', markPointerDown)
        folderHead.addEventListener('mousedown', markPointerDown)
        folderHead.addEventListener('pointerup', clearPointerDown)
        folderHead.addEventListener('mouseup', clearPointerDown)

        folderHead.addEventListener('dragstart', (e) => {
          if (state.filter.trim().length > 0 || pointerDownInActions) {
            pointerDownInActions = false
            e.preventDefault()
            return
          }
          const tgt = e.target
          if (tgt && typeof tgt.closest === 'function' && tgt.closest('.tree-actions')) {
            e.preventDefault()
            return
          }
          closeContextMenu()
          clearActiveDrag()
          activeDrag = {
            kind: 'folder',
            folderOrderKey,
            folderLabel,
            rowEl: folderGroup,
          }
          folderGroup.classList.add('is-dragging')
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move'
            try {
              e.dataTransfer.setData('application/x-datanoa-folder-name', folderOrderKey)
              e.dataTransfer.setData('text/plain', folderOrderKey)
            } catch {
              // Ignore synthetic/read-only DataTransfer restrictions
            }
          }
        })
        folderHead.addEventListener('dragend', () => {
          pointerDownInActions = false
          clearActiveDrag()
        })
      }

      folderGroup.addEventListener('dragover', (e) => {
        if (!activeDrag || state.filter.trim().length > 0) return
        if (activeDrag.kind !== 'folder') {
          const tgt = e.target
          const insideConnRow =
            tgt &&
            typeof tgt.closest === 'function' &&
            Boolean(tgt.closest('.tree-row[data-connection-id]'))
          if (!insideConnRow) {
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
            clearDropIndicator()
          }
          return
        }
        if (!canReorderFolder || activeDrag.folderOrderKey === folderOrderKey) {
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
          clearDropIndicator()
          return
        }
        const placement = resolveDropPlacement(folderHead, e.clientY)
        const plan = computeReorderedFolders(
          sortedSectionKeys,
          activeDrag.folderOrderKey,
          folderOrderKey,
          placement,
          state.folderOrder
        )
        if (!plan.ok || !plan.changed) {
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
          clearDropIndicator()
          return
        }
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
        setDropIndicator(folderGroup, placement)
      })

      folderGroup.addEventListener('dragleave', (e) => {
        if (
          e.relatedTarget &&
          typeof folderGroup.contains === 'function' &&
          folderGroup.contains(e.relatedTarget)
        ) {
          return
        }
        if (dropIndicator?.rowEl === folderGroup) {
          clearDropIndicator()
        }
      })

      folderGroup.addEventListener('drop', (e) => {
        if (!activeDrag || activeDrag.kind !== 'folder' || state.filter.trim().length > 0) return
        if (!canReorderFolder || activeDrag.folderOrderKey === folderOrderKey) {
          clearDropIndicator()
          return
        }
        e.preventDefault()
        e.stopPropagation()
        const sourceFolderKey = activeDrag.folderOrderKey
        const placement = resolveDropPlacement(folderHead, e.clientY)
        clearActiveDrag()
        const plan = computeReorderedFolders(
          sortedSectionKeys,
          sourceFolderKey,
          folderOrderKey,
          placement,
          state.folderOrder
        )
        if (plan.ok && plan.changed && typeof reorderFolders === 'function') {
          void reorderFolders(plan.orderedFolders)
        }
      })

      folderGroup.appendChild(folderHead)

      if (!isCollapsed) {
        const folderChildren = document.createElement('div')
        folderChildren.className = 'tree-folder-children'
        for (const node of nodes) {
          folderChildren.appendChild(node)
        }
        folderGroup.appendChild(folderChildren)
      }

      container.appendChild(folderGroup)
    }

    for (const sectionKey of sortedSectionKeys) {
      if (sectionKey === UNGROUPED_FOLDER_ORDER_KEY) {
        renderFolderSection(UNGROUPED_FOLDER_ORDER_KEY, 'General (Ungrouped)', ungrouped)
      } else {
        renderFolderSection(sectionKey, sectionKey, byFolder.get(sectionKey))
      }
    }
    restoreFocusedTarget()
  }

  function expandAllExplorer() {
    if (state.collapsedFolders) state.collapsedFolders.clear()
    for (const conn of state.connections) {
      state.expandedConns.add(conn.id)
      if (!state.schemaObjects[conn.id]) {
        void loadSchema(conn.id)
      }
    }
    savePanelViewState?.()
    renderExplorer()
  }

  function collapseAllExplorer() {
    if (!state.collapsedFolders) state.collapsedFolders = new Set()
    const hasAnyFolder = state.connections.some((c) => Boolean(normalizeConnectionFolderKey(c.folder)))
    if (hasAnyFolder) {
      for (const conn of state.connections) {
        const f = normalizeConnectionFolderKey(conn.folder)
        state.collapsedFolders.add(
          getFolderCollapseKey(f || UNGROUPED_FOLDER_ORDER_KEY)
        )
      }
    }
    state.expandedConns.clear()
    state.expandedTables.clear()
    state.expandedMeta.clear()
    savePanelViewState?.()
    renderExplorer()
  }

  function openContextMenu(clientX, clientY, target) {
    const menu = $('contextMenu')
    menu.textContent = ''

    const addHeader = (text) => {
      const h = document.createElement('div')
      h.className = 'ctx-header'
      h.textContent = text
      menu.appendChild(h)
    }
    const addSep = () => {
      const s = document.createElement('div')
      s.className = 'ctx-sep'
      menu.appendChild(s)
    }
    const addItem = (label, onClick, danger = false, disabled = false, opts = null) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `ctx-item${danger ? ' danger' : ''}`
      btn.setAttribute('role', 'menuitem')
      btn.disabled = Boolean(disabled)
      if (opts?.action) btn.dataset.action = opts.action
      if (opts?.title) btn.title = opts.title
      if (disabled) {
        btn.style.opacity = '0.45'
        btn.style.cursor = 'not-allowed'
      }
      if (opts?.shortcut) {
        const lbl = document.createElement('span')
        lbl.className = 'ctx-item-label'
        lbl.textContent = label
        const kbd = document.createElement('kbd')
        kbd.className = 'ctx-kbd'
        kbd.textContent = opts.shortcut
        btn.append(lbl, kbd)
      } else {
        btn.textContent = label
      }
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        if (disabled) return
        closeContextMenu()
        void onClick()
      })
      menu.appendChild(btn)
    }

    const positionMenu = () => {
      menu.hidden = false
      const rect = menu.getBoundingClientRect()
      const maxX = Math.max(8, window.innerWidth - rect.width - 8)
      const maxY = Math.max(8, window.innerHeight - rect.height - 8)
      menu.style.left = `${Math.max(8, Math.min(clientX, maxX))}px`
      menu.style.top = `${Math.max(8, Math.min(clientY, maxY))}px`
    }

    if (target.type === 'dataDownload') {
      addHeader('Download Current Page')
      const formats = [
        { fmt: 'csv', label: 'CSV (.csv)', ext: 'csv', mime: 'text/csv;charset=utf-8' },
        { fmt: 'json', label: 'JSON (.json)', ext: 'json', mime: 'application/json;charset=utf-8' },
        { fmt: 'ndjson', label: 'NDJSON (.ndjson)', ext: 'ndjson', mime: 'application/x-ndjson;charset=utf-8' },
        { fmt: 'sql-insert', label: 'SQL INSERT (.sql)', ext: 'sql', mime: 'text/sql;charset=utf-8' },
        { fmt: 'tsv', label: 'TSV (.tsv)', ext: 'tsv', mime: 'text/tab-separated-values;charset=utf-8' },
        { fmt: 'markdown', label: 'Markdown (.md)', ext: 'md', mime: 'text/markdown;charset=utf-8' },
      ]
      for (const f of formats) {
        addItem(f.label, () => exportCurrentDataPage(f.fmt, true, f.ext, f.mime))
      }
      positionMenu()
      return
    }

    if (target.type === 'sqlDownload') {
      addHeader('Download Query Result')
      const formats = [
        { fmt: 'csv', label: 'CSV (.csv)', ext: 'csv', mime: 'text/csv;charset=utf-8' },
        { fmt: 'json', label: 'JSON (.json)', ext: 'json', mime: 'application/json;charset=utf-8' },
        { fmt: 'sql-insert', label: 'SQL INSERT (.sql)', ext: 'sql', mime: 'text/sql;charset=utf-8' },
        { fmt: 'tsv', label: 'TSV (.tsv)', ext: 'tsv', mime: 'text/tab-separated-values;charset=utf-8' },
        { fmt: 'markdown', label: 'Markdown (.md)', ext: 'md', mime: 'text/markdown;charset=utf-8' },
      ]
      for (const f of formats) {
        addItem(f.label, () => exportCurrentSqlResult(f.fmt, true, f.ext, f.mime))
      }
      positionMenu()
      return
    }

    if (target.type === 'dataCanvas') {
      const conn = getActiveConn()
      const isConnRo = Boolean(conn?.readOnly)
      const pd = state.pageData
      const canMutate = !isConnRo && !isSubmittingChanges() && !isActiveDataObjectView?.() && Boolean(pd)
      addHeader(state.activeTable || 'Data Grid')
      addItem('Paste as New Row(s) (Ctrl+V)', () => void triggerPanelPasteNewRows(), false, !canMutate)
      addItem('+ Add Blank Row', () => addBlankDataRow?.(), false, !canMutate)
      positionMenu()
      return
    }

    if (target.type === 'dataCell') {
      const { col, entry, val, cellCount, rowCount, fkInfo } = target
      const conn = getActiveConn()
      const driver = conn?.driver || 'sqlite'
      const isConnRo = Boolean(conn?.readOnly)
      const pd = state.pageData
      const canMutate = !isConnRo && !isSubmittingChanges() && !isActiveDataObjectView?.() && Boolean(pd)
      addHeader(`${col.name}${cellCount > 1 ? ` · ${cellCount} cells` : ''}`)
      addItem('Edit in Value Inspector', () => {
        state.selectedRowKey = entry.rowKey
        state.selectedCol = col.name
        state.inspectorOpen = true
        state.inspectorCollapsed = false
        renderValueInspector()
        renderStagingBar()
        $('valueInspectorText')?.focus()
      })
      addSep()
      addItem('Copy (TSV)', () => copyDataSelection('tsv', false))
      addItem('Copy with Headers', () => copyDataSelection('tsv', true))
      addItem('Copy CSV', () => copyDataSelection('csv', true))
      addItem('Copy JSON', () => copyDataSelection('json', true))
      addItem('Copy as SQL IN (...)', () => copyDataSelection('sql-in', false))
      addItem('Copy as SQL INSERT', () => copyDataSelection('sql-insert', false))
      addItem('Paste (Overwrite & Insert Overflow) (Ctrl+V)', () => void triggerPanelPasteSmart(), false, !canMutate)
      addItem('Paste as New Row(s) (Ctrl+Shift+V)', () => void triggerPanelPasteNewRows(), false, !canMutate)
      addSep()
      addItem(
        `Bulk Set NULL (${cellCount} cell${cellCount === 1 ? '' : 's'})`,
        () => bulkSetSelectedCellsValue(null),
        false,
        !canMutate
      )
      addItem('Bulk Fill Value...', () => openBulkFillModal(), false, !canMutate)
      addSep()
      const qCol = quoteIdent(col.name, driver)
      if (val === null || val === undefined) {
        addItem(`Filter WHERE ${col.name} IS NULL`, () => applyQuickWhere(`${qCol} IS NULL`))
        addItem(`Filter WHERE ${col.name} IS NOT NULL`, () => applyQuickWhere(`${qCol} IS NOT NULL`))
      } else {
        const lit = formatSqlLiteral(val, driver)
        addItem(`Filter WHERE ${col.name} = val`, () => applyQuickWhere(`${qCol} = ${lit}`))
        addItem(`Filter WHERE ${col.name} != val`, () => applyQuickWhere(`${qCol} != ${lit}`))
        addItem(`Filter WHERE ${col.name} IS NULL`, () => applyQuickWhere(`${qCol} IS NULL`))
      }
      if (fkInfo && val !== null && val !== undefined) {
        addSep()
        addItem(`Go to ${fkInfo.referencedTable}.${fkInfo.referencedColumn}`, () =>
          jumpToForeignKeyTarget(fkInfo.referencedTable, fkInfo.referencedColumn, val)
        )
      }
      addSep()
      addItem(
        rowCount > 1 ? `Clone ${rowCount} Rows` : 'Clone Row',
        () => cloneSelectedRows(),
        false,
        !canMutate
      )
      addItem(
        rowCount > 1 ? `Mark ${rowCount} Rows Deleted / Restore` : 'Mark Row Deleted / Restore',
        () => toggleDeleteSelectedRows(),
        true,
        !canMutate || (!entry.isInsert && !pd?.canEdit)
      )
      positionMenu()
      return
    }

    if (target.type === 'dataHeader') {
      const { col, colIdx } = target
      const tblKey = getActiveTableKey()
      const pinnedSet = getPinnedColsSet(tblKey)
      const isPinned = pinnedSet.has(col.name)
      const dataGridSel = getDataGridSel()
      addHeader(`Column · ${col.name}`)
      addItem('Select Column', () => dataGridSel?.selectCol(colIdx))
      addItem('Copy Column Name', () => copyText(col.name, `Copied "${col.name}"`))
      addItem('Copy as SQL IN (...)', () => {
        dataGridSel?.selectCol(colIdx)
        copyDataSelection('sql-in', false)
      })
      addSep()
      addItem(isPinned ? 'Unpin Column' : 'Pin Column', () => toggleColumnPinned(col.name))
      addItem('Hide Column', () => toggleColumnHidden(col.name))
      addItem('Auto-fit Column', () => autoFitDataColumn(col.name))
      positionMenu()
      return
    }

    if (target.type === 'sqlCell') {
      const { colName, cellCount } = target
      addHeader(`${colName}${cellCount > 1 ? ` · ${cellCount} cells` : ''}`)
      addItem('Copy (TSV)', () => copySqlSelection('tsv', false))
      addItem('Copy with Headers', () => copySqlSelection('tsv', true))
      addItem('Copy CSV', () => copySqlSelection('csv', true))
      addItem('Copy JSON', () => copySqlSelection('json', true))
      addItem('Copy as SQL IN (...)', () => copySqlSelection('sql-in', false))
      addItem('Copy as SQL INSERT', () => copySqlSelection('sql-insert', false))
      addSep()
      addItem('Download CSV', () =>
        exportCurrentSqlResult('csv', true, 'csv', 'text/csv;charset=utf-8')
      )
      addItem('Download JSON', () =>
        exportCurrentSqlResult('json', true, 'json', 'application/json;charset=utf-8')
      )
      positionMenu()
      return
    }

    if (target.type === 'folder') {
      const folderName = String(target.folderName || '').trim()
      const folderOrderKey = String(
        target.folderOrderKey ||
          (folderName === 'General (Ungrouped)' ? UNGROUPED_FOLDER_ORDER_KEY : folderName)
      ).trim()
      if (!folderName || !folderOrderKey) return
      addHeader(folderName)
      const isCollapsed = isFolderSectionCollapsed(folderOrderKey)
      addItem(isCollapsed ? 'Expand Folder' : 'Collapse Folder', () => {
        toggleFolderSectionCollapsed(folderOrderKey)
        savePanelViewState?.()
        renderExplorer()
      })
      const folderKeys = getFolderOrderKeys()
      const folderBounds = getFolderReorderBounds(folderKeys, folderOrderKey, state.folderOrder)
      if (folderBounds.found && folderBounds.total > 1) {
        addSep()
        const filterActive = state.filter.trim().length > 0
        const filterTip = 'Clear filter to reorder folders'
        addItem(
          'Move Folder Up',
          () => moveFolderDirection(folderOrderKey, 'up', 'menu'),
          false,
          filterActive || !folderBounds.canMoveUp,
          {
            action: 'move-folder-up',
            shortcut: 'Alt+↑',
            title: filterActive ? filterTip : 'Move folder up (Alt+↑)',
          }
        )
        addItem(
          'Move Folder Down',
          () => moveFolderDirection(folderOrderKey, 'down', 'menu'),
          false,
          filterActive || !folderBounds.canMoveDown,
          {
            action: 'move-folder-down',
            shortcut: 'Alt+↓',
            title: filterActive ? filterTip : 'Move folder down (Alt+↓)',
          }
        )
      }
      positionMenu()
      return
    }

    const { conn, obj } = target
    const isMongo = conn?.driver === 'mongodb'
    const isRedis = conn?.driver === 'redis'
    if (target.type === 'object' && obj) {
      addHeader(`${conn.name} · ${obj.name}`)
      addItem('Open Data', () => selectTableAndOpen(conn.id, obj.name, obj.schema, true))
      if (obj.kind === 'table' && !isRedis && !isMongo) {
        addItem('Edit Table Structure', async () => {
          await selectTableAndOpen(conn.id, obj.name, obj.schema, false)
          switchTab('structure')
        })
      }
      if (obj.kind === 'table' && !isRedis) {
        addItem(
          'Import Data...',
          () =>
            openFullStudio({
              connectionId: conn.id,
              table: obj.name,
              schema: obj.schema,
              viewMode: 'grid',
              action: 'import',
            }),
          false,
          Boolean(conn.readOnly)
        )
      }
      addItem('Open in Full Studio ↗', () =>
        openFullStudio({ connectionId: conn.id, table: obj.name, schema: obj.schema })
      )
      addItem('Jump to Console', async () => {
        resetSqlSafetyBannerDismissal?.()
        await selectTableAndOpen(conn.id, obj.name, obj.schema, false)
        const details = state.tableDetails[makeTableKey(conn.id, obj.name, obj.schema)]
        setSqlText(generateSqlForTable('select', conn, obj, details))
        renderSqlSafetyBanner()
        switchTab('sql')
      })
      addSep()
      addItem(isMongo ? 'Copy Collection Name' : 'Copy Table Name', () =>
        copyText(obj.name, `Copied "${obj.name}"`)
      )
      if (!isRedis) {
        addItem(isMongo ? 'Copy Find Query' : 'Copy SELECT *', () => {
          void copyText(buildSelectPreviewQuery(conn, obj), `Copied query for ${obj.name}`)
        })
        addItem(isMongo ? 'Count Docs' : 'Count Rows', () => countRowsForTable(conn, obj))
      }
      addSep()
      const runSqlTemplateAction = async (kind) => {
        const reqSeq = ++sqlGenSeq
        const targetConnId = conn.id
        await selectTableAndOpen(targetConnId, obj.name, obj.schema, false)
        if (reqSeq !== sqlGenSeq) return
        const connAfterSelect = state.activeConnectionId
        let details = state.tableDetails[makeTableKey(targetConnId, obj.name, obj.schema)]
        if (!details) {
          details = await rpc('schema.tableDetails', {
            connectionId: targetConnId,
            table: obj.name,
            ...(obj.schema ? { schema: obj.schema } : {}),
          }).catch(() => null)
        }
        if (reqSeq !== sqlGenSeq || state.activeConnectionId !== connAfterSelect) return
        const latestConn = getConnById(targetConnId) || conn
        setSqlText(generateSqlForTable(kind, latestConn, obj, details))
        switchTab('sql')
      }
      addItem(isMongo ? 'Generate Find' : 'Generate SELECT', () => runSqlTemplateAction('select'))
      addItem(isMongo ? 'Generate Insert' : 'Generate INSERT', () => runSqlTemplateAction('insert'))
      addItem(isMongo ? 'Generate Update' : 'Generate UPDATE', () => runSqlTemplateAction('update'))
      addItem(isMongo ? 'Inspect Schema & Indexes' : 'Generate CREATE DDL', async () => {
        const reqSeq = ++sqlGenSeq
        const targetConnId = conn.id
        await selectTableAndOpen(targetConnId, obj.name, obj.schema, false)
        if (reqSeq !== sqlGenSeq) return
        const connAfterSelect = state.activeConnectionId
        if (isMongo) {
          switchTab('structure')
          return
        }
        try {
          const ddlRes = await rpc(
            'schema.generateDdl',
            {
              connectionId: targetConnId,
              table: obj.name,
              ...(obj.schema ? { schema: obj.schema } : {}),
            },
            { timeoutMs: QUERY_TIMEOUT_MS }
          )
          if (reqSeq !== sqlGenSeq || state.activeConnectionId !== connAfterSelect) return
          if (ddlRes?.ddl) {
            setSqlText(formatDdlForDisplay(ddlRes.ddl))
            switchTab('sql')
          }
        } catch (err) {
          if (reqSeq !== sqlGenSeq || state.activeConnectionId !== connAfterSelect) return
          const msg = err?.message || 'Failed to generate DDL'
          reportConnectionError(targetConnId, conn, msg)
        }
      })
      if (!isRedis) {
        addSep()
        if (obj.kind === 'table') {
          addItem(
            isMongo ? 'Truncate Collection...' : 'Truncate Table...',
            () => openDangerTableModal('truncate', conn, obj),
            true,
            Boolean(conn.readOnly)
          )
        }
        addItem(
          isMongo ? 'Drop Collection...' : obj.kind === 'view' ? 'Drop View...' : 'Drop Table...',
          () => openDangerTableModal('drop', conn, obj),
          true,
          Boolean(conn.readOnly)
        )
      }
      addSep()
    } else {
      addHeader(conn.name)
      addItem('Open in Full Studio ↗', () => openFullStudio({ connectionId: conn.id }))
      if (!isRedis) {
        addItem('Open ER Diagram in Studio ↗', () =>
          openFullStudio({
            connectionId: conn.id,
            ...(state.selectedSchemaByConn?.[conn.id]
              ? { schema: state.selectedSchemaByConn[conn.id] }
              : {}),
            viewMode: 'er',
          })
        )
      }
      if (!isRedis && !conn.readOnly) {
        addItem(isMongo ? '+ New Collection...' : '+ New Table...', () => {
          if (state.activeConnectionId !== conn.id) activateConnection(conn.id)
          openCreateTableModal()
        })
      }
      addItem('Jump to Console', () => {
        if (state.activeConnectionId !== conn.id) {
          activateConnection(conn.id)
        } else {
          resetSqlSafetyBannerDismissal?.()
          renderConnectionsBar()
          renderSqlSafetyBanner()
        }
        switchTab('sql')
      })
      addSep()
      const reorderBounds = getConnectionReorderBounds(state.connections, conn.id)
      if (reorderBounds.found && reorderBounds.total > 1) {
        const filterActive = state.filter.trim().length > 0
        const filterTip = 'Clear filter to reorder connections'
        addItem(
          'Move Up',
          () => moveConnectionDirection(conn.id, 'up', 'menu'),
          false,
          filterActive || !reorderBounds.canMoveUp,
          {
            action: 'move-conn-up',
            shortcut: 'Alt+↑',
            title: filterActive ? filterTip : 'Move connection up within folder (Alt+↑)',
          }
        )
        addItem(
          'Move Down',
          () => moveConnectionDirection(conn.id, 'down', 'menu'),
          false,
          filterActive || !reorderBounds.canMoveDown,
          {
            action: 'move-conn-down',
            shortcut: 'Alt+↓',
            title: filterActive ? filterTip : 'Move connection down within folder (Alt+↓)',
          }
        )
        addSep()
      }
    }

    addItem('Edit Connection', () => populateFormFromProfile(conn, 'edit'))
    addItem('Duplicate Connection', () => populateFormFromProfile(conn, 'duplicate'))
    addItem('Refresh Schema', () => loadSchema(conn.id))
    addSep()
    addItem('Delete Connection', () => openDeleteConfirmModal(conn), true)

    positionMenu()
  }

  return {
    renderExplorer,
    expandAllExplorer,
    collapseAllExplorer,
    countRowsForTable,
    openContextMenu,
  }
}
