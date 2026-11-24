// src/panel/panel-explorer.js
// Side Panel Schema Explorer tree, SQL snippet generator, row counter, and unified context menu

import {
  quoteIdent,
  quoteTableRef,
  formatSqlLiteral,
  formatDdlForDisplay,
} from './panel-core.js'
import {
  $,
  setDbLogoElement,
  rpc,
  makeTableKey,
  createEnvBadge,
  getFolderSvgMarkup,
} from './panel-utils.js'

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
  } = ctx

  let countRowsSeq = 0

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
      showBanner(`Count failed for ${obj.name}: ${err?.message || err}`, 'danger')
    }
  }

  function renderExplorer() {
    const empty = $('explorerEmpty')
    const filterWrap = $('schemaFilterWrap')
    const container = $('schemaTreeContainer')
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
      const connRow = document.createElement('div')
      connRow.className = 'tree-row'

      const connItem = document.createElement('div')
      connItem.className = `tree-item tree-conn-item${state.activeConnectionId === conn.id ? ' active' : ''}`
      connItem.setAttribute('role', 'button')
      connItem.tabIndex = 0
      connItem.title = `${conn.name} (${conn.driver})${conn.folder ? ` — Folder: ${conn.folder}` : ''}`

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
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          toggleConn()
        }
      })
      connItem.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        openContextMenu(e.clientX, e.clientY, { type: 'connection', conn })
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

          if (tables.length === 0 && views.length === 0) {
            const none = document.createElement('div')
            none.className = 'col-leaf'
            none.textContent =
              objects.length === 0
                ? conn.driver === 'mongodb'
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

    const hasAnyFolder = state.connections.some((c) => Boolean((c.folder || '').trim()))
    if (!hasAnyFolder) {
      for (const conn of state.connections) {
        const node = buildConnectionRow(conn)
        if (node) container.appendChild(node)
      }
      return
    }

    const byFolder = new Map()
    const ungrouped = []
    for (const conn of state.connections) {
      const f = (conn.folder || '').trim()
      if (f) {
        if (!byFolder.has(f)) byFolder.set(f, [])
        byFolder.get(f).push(conn)
      } else {
        ungrouped.push(conn)
      }
    }

    const renderFolderSection = (folderLabel, connList) => {
      const nodes = []
      for (const conn of connList) {
        const node = buildConnectionRow(conn)
        if (node) nodes.push(node)
      }
      if (nodes.length === 0) return

      const isCollapsed = !q && state.collapsedFolders.has(folderLabel)
      const folderGroup = document.createElement('div')
      folderGroup.className = 'tree-folder-group'

      const folderHead = document.createElement('div')
      folderHead.className = 'tree-item tree-folder-item'
      folderHead.setAttribute('role', 'button')
      folderHead.tabIndex = 0
      folderHead.title = `Folder "${folderLabel}" (${nodes.length} connection(s)) — Click to ${isCollapsed ? 'expand' : 'collapse'}`

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

      const toggleFolder = () => {
        if (state.collapsedFolders.has(folderLabel)) {
          state.collapsedFolders.delete(folderLabel)
        } else {
          state.collapsedFolders.add(folderLabel)
        }
        savePanelViewState?.()
        renderExplorer()
      }

      folderHead.addEventListener('click', toggleFolder)
      folderHead.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          toggleFolder()
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

    const sortedFolders = Array.from(byFolder.keys()).sort((a, b) => a.localeCompare(b))
    for (const folder of sortedFolders) {
      renderFolderSection(folder, byFolder.get(folder))
    }
    if (ungrouped.length > 0) {
      renderFolderSection('General (Ungrouped)', ungrouped)
    }
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
    const hasAnyFolder = state.connections.some((c) => Boolean((c.folder || '').trim()))
    if (hasAnyFolder) {
      for (const conn of state.connections) {
        const f = (conn.folder || '').trim()
        state.collapsedFolders.add(f || 'General (Ungrouped)')
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
    const addItem = (label, onClick, danger = false, disabled = false) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `ctx-item${danger ? ' danger' : ''}`
      btn.setAttribute('role', 'menuitem')
      btn.disabled = Boolean(disabled)
      if (disabled) {
        btn.style.opacity = '0.45'
        btn.style.cursor = 'not-allowed'
      }
      btn.textContent = label
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
      addItem(isMongo ? 'Generate Find' : 'Generate SELECT', async () => {
        await selectTableAndOpen(conn.id, obj.name, obj.schema, false)
        let details = state.tableDetails[makeTableKey(conn.id, obj.name, obj.schema)]
        if (!details) {
          details = await rpc('schema.tableDetails', {
            connectionId: conn.id,
            table: obj.name,
            ...(obj.schema ? { schema: obj.schema } : {}),
          }).catch(() => null)
        }
        setSqlText(generateSqlForTable('select', conn, obj, details))
        switchTab('sql')
      })
      addItem(isMongo ? 'Generate Insert' : 'Generate INSERT', async () => {
        await selectTableAndOpen(conn.id, obj.name, obj.schema, false)
        let details = state.tableDetails[makeTableKey(conn.id, obj.name, obj.schema)]
        if (!details) {
          details = await rpc('schema.tableDetails', {
            connectionId: conn.id,
            table: obj.name,
            ...(obj.schema ? { schema: obj.schema } : {}),
          }).catch(() => null)
        }
        setSqlText(generateSqlForTable('insert', conn, obj, details))
        switchTab('sql')
      })
      addItem(isMongo ? 'Generate Update' : 'Generate UPDATE', async () => {
        await selectTableAndOpen(conn.id, obj.name, obj.schema, false)
        let details = state.tableDetails[makeTableKey(conn.id, obj.name, obj.schema)]
        if (!details) {
          details = await rpc('schema.tableDetails', {
            connectionId: conn.id,
            table: obj.name,
            ...(obj.schema ? { schema: obj.schema } : {}),
          }).catch(() => null)
        }
        setSqlText(generateSqlForTable('update', conn, obj, details))
        switchTab('sql')
      })
      addItem(isMongo ? 'Inspect Schema & Indexes' : 'Generate CREATE DDL', async () => {
        await selectTableAndOpen(conn.id, obj.name, obj.schema, false)
        if (isMongo) {
          switchTab('structure')
          return
        }
        try {
          const ddlRes = await rpc(
            'schema.generateDdl',
            {
              connectionId: conn.id,
              table: obj.name,
              ...(obj.schema ? { schema: obj.schema } : {}),
            },
            { timeoutMs: QUERY_TIMEOUT_MS }
          )
          if (ddlRes?.ddl) {
            setSqlText(formatDdlForDisplay(ddlRes.ddl))
            switchTab('sql')
          }
        } catch (err) {
          showBanner(err?.message || 'Failed to generate DDL', 'danger')
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
      if (!isRedis && !conn.readOnly) {
        addItem(isMongo ? '+ New Collection...' : '+ New Table...', () => {
          if (state.activeConnectionId !== conn.id) activateConnection(conn.id)
          openCreateTableModal()
        })
      }
      addItem('Jump to Console', () => {
        resetSqlSafetyBannerDismissal?.()
        if (state.activeConnectionId !== conn.id) {
          state.activeConnectionId = conn.id
          void persistActiveConnectionId(conn.id)
        }
        renderConnectionsBar()
        renderSqlSafetyBanner()
        switchTab('sql')
      })
      addSep()
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
