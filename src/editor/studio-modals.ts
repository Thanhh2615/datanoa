// src/editor/studio-modals.ts
// Fullscreen Studio Modals: Create Table, Danger Truncate/Drop, Command Palette & Keyboard Shortcuts
// (Feedback and File Import modals live in dedicated feedback-modal.ts and import-modal.ts modules)

import {
  buildCreateTableSql,
  buildDropTableSql,
  buildTruncateTableSql,
  type CreateTableColumnDraft,
} from '../drivers/common/sql-tools.js'
import type {
  ConnectionProfile,
  DatabaseDriverType,
  QueryResult,
  SchemaObject,
  SchemaObjectKind,
  StudioViewMode,
} from '../protocol.js'
import { fuzzyMatchScore, setButtonLoading } from './db-icons.js'
import { DEFAULT_RPC_TIMEOUT_MS } from '../shared-constants.js'
import { bindCtrlWheelHorizontalScroll } from '../shared-wheel-scroll.js'

export {
  sanitizeDiagnosticErrorText,
  buildStudioDiagnosticSummary,
  openStudioFeedbackModal,
  openFeedbackModal,
  type StudioFeedbackModalContext,
} from './feedback-modal.js'

export {
  openStudioImportModal,
  openImportDataModal,
  type StudioImportDataModalContext,
} from './import-modal.js'

export interface StudioModalMountContext {
  mountModal: (modalEl: HTMLElement, canClose?: () => boolean) => HTMLDivElement | null
  closeModal: () => void
}

export interface StudioRpcModalContext extends StudioModalMountContext {
  updateStatus: (stateText: string, metricsText?: string) => void
  requestPlugin: <T = unknown>(
    method: string,
    payload?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ) => Promise<T>
}

export interface StudioTimedRpcModalContext extends StudioRpcModalContext {
  createElapsedTimer: (onTick: (elapsedText: string, elapsedMs: number) => void) => () => void
}

export interface StudioCreateTableModalContext extends StudioTimedRpcModalContext {
  activeConnection?: ConnectionProfile
  activeConnectionId: string | null
  activeSchema?: string
  onTableCreated: (connId: string, tableName: string, schema: string | undefined, sql: string) => Promise<void>
}

export interface StudioDangerTableModalContext extends StudioTimedRpcModalContext {
  activeConnection?: ConnectionProfile
  activeConnectionId: string | null
  showQueryBanner: (
    kind: 'success' | 'error',
    title: string,
    detail?: string,
    opts?: { onRetry?: () => void; showBackToTable?: boolean }
  ) => void
  onDangerActionSucceeded: (
    connId: string,
    action: 'truncate' | 'drop',
    item: SchemaObject,
    actionTitle: string,
    sql: string
  ) => Promise<void>
}

export interface StudioCommandPaletteContext extends StudioModalMountContext {
  schemaObjects: SchemaObject[]
  connections: ConnectionProfile[]
  activeConnection?: ConnectionProfile
  sidebarCollapsed: boolean
  selectSidebarObject: (item: SchemaObject) => void
  selectConnection: (connectionId: string) => void
  openConnectionModal: (editProfile?: ConnectionProfile) => void
  formatSqlInConsole: () => void
  openCreateTableModal: () => void
  openImportDataModal?: () => void
  openExportSchemaDdl?: () => void
  openDriverManagerModal?: () => void
  setSidebarCollapsed: (collapsed: boolean, persist?: boolean) => void
  switchMode: (mode: StudioViewMode) => void
  toggleQueryHistory: () => Promise<void>
  handleRefreshAction: () => Promise<void>
  openShortcutsModal: () => void
  openFeedbackModal: (initialKind?: 'bug' | 'feature') => void
  openSavedQueriesModal?: () => void
  onThemeToggled?: (isLight: boolean) => void
}

export function openStudioCreateTableModal(ctx: StudioCreateTableModalContext): void {
  const conn = ctx.activeConnection
  if (!conn || conn.readOnly || conn.driver === 'redis') {
    ctx.updateStatus('Cannot create tables on this connection')
    return
  }
  const driver = conn.driver
  const isMongo = driver === 'mongodb'
  let isCreating = false

  const idType = driver === 'oracle' ? 'NUMBER(10)' : driver === 'mssql' ? 'INT' : 'INTEGER'
  const textType =
    driver === 'oracle' ? 'VARCHAR2(255)' : driver === 'mssql' ? 'NVARCHAR(255)' : 'TEXT'
  const columns: CreateTableColumnDraft[] = [
    {
      name: 'id',
      dataType: idType,
      nullable: false,
      defaultValue: '',
      isPrimaryKey: true,
      isAutoIncrement: true,
    },
    {
      name: 'name',
      dataType: textType,
      nullable: false,
      defaultValue: '',
      isPrimaryKey: false,
      isAutoIncrement: false,
    },
  ]

  const modal = document.createElement('div')
  modal.className = 'datanoa-create-table-modal'

  const head = document.createElement('div')
  head.className = 'datanoa-modal-head'
  const headTitle = document.createElement('span')
  headTitle.id = 'datanoa-create-table-modal-title'
  headTitle.textContent = isMongo ? 'Create New Collection' : 'Create New Table'
  modal.setAttribute('aria-labelledby', headTitle.id)
  const badge = document.createElement('span')
  badge.className = 'datanoa-badge datanoa-badge-pk'
  badge.textContent = driver.toUpperCase()
  head.appendChild(headTitle)
  head.appendChild(badge)

  const body = document.createElement('div')
  body.className = 'datanoa-modal-body'

  const execErrBox = document.createElement('div')
  execErrBox.className = 'datanoa-modal-box error'
  execErrBox.style.display = 'none'
  body.appendChild(execErrBox)

  const topFields = document.createElement('div')
  topFields.style.display = 'flex'
  topFields.style.gap = '8px'

  const tableNameInput = document.createElement('input')
  tableNameInput.type = 'text'
  tableNameInput.id = 'datanoa-create-table-name-input'
  tableNameInput.className = 'datanoa-filter-input'
  tableNameInput.placeholder = isMongo ? 'Collection name (e.g. users)' : 'Table name (e.g. users)'
  tableNameInput.setAttribute('aria-label', isMongo ? 'Collection name' : 'Table name')
  tableNameInput.value = isMongo ? 'new_collection' : 'new_table'
  tableNameInput.style.flex = '2'

  const schemaInput = document.createElement('input')
  schemaInput.type = 'text'
  schemaInput.id = 'datanoa-create-table-schema-input'
  schemaInput.className = 'datanoa-filter-input'
  schemaInput.placeholder = 'Schema (optional)'
  schemaInput.setAttribute('aria-label', 'Schema name')
  schemaInput.value =
    driver !== 'sqlite' && driver !== 'libsql' && driver !== 'd1' && !isMongo
      ? ctx.activeSchema || ''
      : ''
  schemaInput.style.flex = '1'
  if (driver === 'sqlite' || driver === 'libsql' || driver === 'd1' || isMongo) {
    schemaInput.style.display = 'none'
  }

  topFields.appendChild(tableNameInput)
  topFields.appendChild(schemaInput)
  body.appendChild(topFields)

  const colsHeader = document.createElement('div')
  colsHeader.style.display = isMongo ? 'none' : 'flex'
  colsHeader.style.justifyContent = 'space-between'
  colsHeader.style.alignItems = 'center'
  const colsTitle = document.createElement('strong')
  colsTitle.textContent = 'Columns'
  const addColBtn = document.createElement('button')
  addColBtn.type = 'button'
  addColBtn.className = 'datanoa-btn datanoa-btn-sm'
  addColBtn.textContent = '+ Add Column'
  colsHeader.appendChild(colsTitle)
  colsHeader.appendChild(addColBtn)
  body.appendChild(colsHeader)

  const colTableWrap = document.createElement('div')
  colTableWrap.className = 'datanoa-matrix-scroll'
  if (isMongo) {
    colTableWrap.style.display = 'none'
  }
  const colTable = document.createElement('table')
  colTable.className = 'datanoa-matrix-table datanoa-struct-grid'
  colTable.innerHTML =
    '<thead><tr><th>Name</th><th>Type</th><th>PK</th><th>AI</th><th>Null</th><th>Default</th><th></th></tr></thead>'
  const colTbody = document.createElement('tbody')
  colTable.appendChild(colTbody)
  colTableWrap.appendChild(colTable)
  body.appendChild(colTableWrap)
  bindCtrlWheelHorizontalScroll(colTableWrap)

  const ddlLabel = document.createElement('div')
  ddlLabel.style.fontWeight = '600'
  ddlLabel.textContent = isMongo ? 'Command Preview:' : 'Live CREATE TABLE Preview:'
  const ddlPre = document.createElement('pre')
  ddlPre.className = 'datanoa-modal-sql'
  body.appendChild(ddlLabel)
  body.appendChild(ddlPre)

  const actions = document.createElement('div')
  actions.className = 'datanoa-modal-actions'
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'datanoa-btn datanoa-btn-sm'
  cancelBtn.textContent = 'Cancel'
  const createBtn = document.createElement('button')
  createBtn.type = 'button'
  createBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-primary'
  createBtn.textContent = isMongo ? 'Create Collection' : 'Create Table'
  actions.appendChild(cancelBtn)
  actions.appendChild(createBtn)

  let currentSql = ''
  const updatePreview = () => {
    try {
      if (isMongo) {
        const colName = tableNameInput.value.trim()
        if (!colName) {
          throw new Error('Collection name is required.')
        }
        currentSql = `db.createCollection(${JSON.stringify(colName)});`
      } else {
        currentSql = buildCreateTableSql(
          {
            tableName: tableNameInput.value,
            schema: schemaInput.value.trim() || undefined,
            columns,
          },
          driver
        )
      }
      ddlPre.textContent = currentSql
      createBtn.disabled = isCreating || !currentSql
    } catch (err: unknown) {
      currentSql = ''
      const msg = err instanceof Error ? err.message : String(err)
      ddlPre.textContent = `-- ${msg}`
      createBtn.disabled = true
    }
  }

  const renderCols = () => {
    colTbody.innerHTML = ''
    columns.forEach((col, idx) => {
      const tr = document.createElement('tr')

      const tdName = document.createElement('td')
      const nameInp = document.createElement('input')
      nameInp.type = 'text'
      nameInp.className = 'datanoa-struct-cell-input'
      nameInp.value = col.name
      nameInp.placeholder = 'column_name'
      nameInp.setAttribute('aria-label', `Column ${idx + 1} name`)
      nameInp.addEventListener('input', () => {
        col.name = nameInp.value
        updatePreview()
      })
      tdName.appendChild(nameInp)

      const tdType = document.createElement('td')
      const typeInp = document.createElement('input')
      typeInp.type = 'text'
      typeInp.className = 'datanoa-struct-cell-input'
      typeInp.value = col.dataType
      typeInp.placeholder = 'TEXT / INTEGER'
      typeInp.setAttribute('aria-label', `Column ${idx + 1} type`)
      typeInp.addEventListener('input', () => {
        col.dataType = typeInp.value
        updatePreview()
      })
      tdType.appendChild(typeInp)

      const tdPk = document.createElement('td')
      const pkCb = document.createElement('input')
      pkCb.type = 'checkbox'
      pkCb.checked = Boolean(col.isPrimaryKey)
      pkCb.setAttribute('aria-label', `Column ${idx + 1} primary key`)
      pkCb.addEventListener('change', () => {
        col.isPrimaryKey = pkCb.checked
        if (col.isPrimaryKey) col.nullable = false
        renderCols()
        updatePreview()
      })
      tdPk.appendChild(pkCb)

      const tdAi = document.createElement('td')
      const aiCb = document.createElement('input')
      aiCb.type = 'checkbox'
      aiCb.checked = Boolean(col.isAutoIncrement)
      aiCb.setAttribute('aria-label', `Column ${idx + 1} auto increment`)
      aiCb.addEventListener('change', () => {
        col.isAutoIncrement = aiCb.checked
        updatePreview()
      })
      tdAi.appendChild(aiCb)

      const tdNull = document.createElement('td')
      const nullCb = document.createElement('input')
      nullCb.type = 'checkbox'
      nullCb.checked = col.nullable !== false
      nullCb.disabled = Boolean(col.isPrimaryKey)
      nullCb.setAttribute('aria-label', `Column ${idx + 1} nullable`)
      nullCb.addEventListener('change', () => {
        col.nullable = nullCb.checked
        updatePreview()
      })
      tdNull.appendChild(nullCb)

      const tdDef = document.createElement('td')
      const defInp = document.createElement('input')
      defInp.type = 'text'
      defInp.className = 'datanoa-struct-cell-input'
      defInp.value = col.defaultValue || ''
      defInp.placeholder = 'Default...'
      defInp.setAttribute('aria-label', `Column ${idx + 1} default value`)
      defInp.addEventListener('input', () => {
        col.defaultValue = defInp.value
        updatePreview()
      })
      tdDef.appendChild(defInp)

      const tdAct = document.createElement('td')
      const rmBtn = document.createElement('button')
      rmBtn.type = 'button'
      rmBtn.className = 'datanoa-btn datanoa-btn-sm'
      rmBtn.textContent = '×'
      rmBtn.setAttribute('aria-label', `Remove column ${col.name || idx + 1}`)
      rmBtn.disabled = columns.length <= 1
      rmBtn.addEventListener('click', () => {
        if (columns.length <= 1) return
        columns.splice(idx, 1)
        renderCols()
        updatePreview()
      })
      tdAct.appendChild(rmBtn)

      tr.appendChild(tdName)
      tr.appendChild(tdType)
      tr.appendChild(tdPk)
      tr.appendChild(tdAi)
      tr.appendChild(tdNull)
      tr.appendChild(tdDef)
      tr.appendChild(tdAct)
      colTbody.appendChild(tr)
    })
  }

  addColBtn.addEventListener('click', () => {
    columns.push({
      name: `col_${columns.length + 1}`,
      dataType: 'TEXT',
      nullable: true,
      defaultValue: '',
      isPrimaryKey: false,
      isAutoIncrement: false,
    })
    renderCols()
    updatePreview()
  })

  tableNameInput.addEventListener('input', updatePreview)
  schemaInput.addEventListener('input', updatePreview)
  cancelBtn.addEventListener('click', () => {
    if (!isCreating) ctx.closeModal()
  })

  createBtn.addEventListener('click', () => {
    if (isCreating || !currentSql || !ctx.activeConnectionId) return
    const connId = ctx.activeConnectionId
    const targetName = tableNameInput.value.trim()
    const targetSchema = schemaInput.value.trim() || undefined
    isCreating = true
    execErrBox.style.display = 'none'
    cancelBtn.disabled = true
    addColBtn.disabled = true
    setButtonLoading(createBtn, true, 'Creating... 0.0s')
    const stopTimer = ctx.createElapsedTimer((elapsedText) => {
      setButtonLoading(createBtn, true, `Creating... ${elapsedText}`)
    })

    void (async () => {
      let created = false
      try {
        await ctx.requestPlugin<QueryResult>(
          'query.run',
          {
            connectionId: connId,
            queryId: `create_tbl_${Date.now()}`,
            sql: currentSql,
          },
          { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
        )
        created = true
      } catch (err: unknown) {
        stopTimer()
        isCreating = false
        setButtonLoading(createBtn, false)
        cancelBtn.disabled = false
        addColBtn.disabled = false
        updatePreview()
        const msg = err instanceof Error ? err.message : String(err)
        execErrBox.textContent = `Create Table failed: ${msg}`
        execErrBox.style.display = 'block'
        return
      }
      if (created) {
        stopTimer()
        isCreating = false
        ctx.closeModal()
        try {
          await ctx.onTableCreated(connId, targetName, targetSchema, currentSql)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          ctx.updateStatus(`Table created, but refresh failed: ${msg}`)
        }
      }
    })()
  })

  renderCols()
  updatePreview()

  modal.appendChild(head)
  modal.appendChild(body)
  modal.appendChild(actions)
  ctx.mountModal(modal, () => !isCreating)
  tableNameInput.focus?.()
  tableNameInput.select?.()
}

export const openCreateTableModal = openStudioCreateTableModal

export function buildDangerTableCommand(
  action: 'truncate' | 'drop',
  item: SchemaObject,
  driver: DatabaseDriverType
): string {
  if (driver === 'mongodb') {
    const cleanName = String(item.name || '').trim()
    if (!cleanName) {
      throw new Error('Collection name is required.')
    }
    const colCall = `db.getCollection(${JSON.stringify(cleanName)})`
    return action === 'truncate' ? `${colCall}.deleteMany({});` : `${colCall}.drop();`
  }
  return action === 'truncate'
    ? buildTruncateTableSql(item.name, driver, item.schema)
    : buildDropTableSql(item.name, item.kind, driver, item.schema)
}

export function openStudioDangerTableModal(
  ctx: StudioDangerTableModalContext,
  action: 'truncate' | 'drop',
  item: SchemaObject
): void {
  const conn = ctx.activeConnection
  if (!conn || conn.readOnly || conn.driver === 'redis') {
    ctx.updateStatus('Cannot run destructive table operation on a Read-Only or Redis connection')
    return
  }
  const driver = conn.driver
  const isMongo = driver === 'mongodb'
  let sql = ''
  try {
    sql = buildDangerTableCommand(action, item, driver)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.showQueryBanner('error', 'Operation Unavailable', msg)
    return
  }

  let isExecuting = false
  const objectLabel = isMongo ? 'Collection' : item.kind === 'view' ? 'View' : 'Table'
  const actionTitle =
    action === 'truncate'
      ? `Truncate ${objectLabel} "${item.name}"`
      : `Drop ${objectLabel} "${item.name}"`

  const modal = document.createElement('div')
  modal.className = 'datanoa-danger-modal'

  const head = document.createElement('div')
  head.className = 'datanoa-modal-head'
  const titleEl = document.createElement('span')
  titleEl.id = 'datanoa-danger-table-modal-title'
  titleEl.textContent = actionTitle
  modal.setAttribute('aria-labelledby', titleEl.id)
  const badge = document.createElement('span')
  badge.className = 'datanoa-badge'
  badge.style.color = 'var(--danger)'
  badge.textContent =
    action === 'truncate'
      ? isMongo
        ? 'DELETE ALL DOCUMENTS'
        : 'DELETE ALL ROWS'
      : 'PERMANENT DROP'
  head.appendChild(titleEl)
  head.appendChild(badge)

  const body = document.createElement('div')
  body.className = 'datanoa-modal-body'

  const normalizedTag = String(conn.colorTag || '').trim().toLowerCase()
  if (normalizedTag === 'prod' || normalizedTag === 'production') {
    const prodWarn = document.createElement('div')
    prodWarn.className = 'datanoa-modal-box error'
    prodWarn.textContent =
      'PRODUCTION CONNECTION WARNING: This action is irreversible and will immediately affect production data.'
    body.appendChild(prodWarn)
  }

  const desc = document.createElement('div')
  desc.textContent =
    action === 'truncate'
      ? `This will permanently remove all ${isMongo ? 'documents' : 'rows'} from "${item.name}". Type the exact ${objectLabel.toLowerCase()} name below to confirm.`
      : `This will permanently drop ${objectLabel.toLowerCase()} "${item.name}" and its data. Type the exact name below to confirm.`
  body.appendChild(desc)

  const sqlPre = document.createElement('pre')
  sqlPre.className = 'datanoa-modal-sql'
  sqlPre.textContent = sql
  body.appendChild(sqlPre)

  const confirmInput = document.createElement('input')
  confirmInput.type = 'text'
  confirmInput.id = 'datanoa-danger-table-confirm-input'
  confirmInput.className = 'datanoa-filter-input'
  confirmInput.placeholder = `Type "${item.name}" to enable confirmation`
  confirmInput.setAttribute('aria-label', `Confirm ${objectLabel.toLowerCase()} name "${item.name}"`)
  body.appendChild(confirmInput)

  const execErrBox = document.createElement('div')
  execErrBox.className = 'datanoa-modal-box error'
  execErrBox.style.display = 'none'
  body.appendChild(execErrBox)

  const actions = document.createElement('div')
  actions.className = 'datanoa-modal-actions'
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'datanoa-btn datanoa-btn-sm'
  cancelBtn.textContent = 'Cancel'
  const confirmBtn = document.createElement('button')
  confirmBtn.type = 'button'
  confirmBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-danger-solid'
  confirmBtn.textContent =
    action === 'truncate' ? `Truncate ${objectLabel}` : `Drop ${objectLabel}`
  confirmBtn.disabled = true
  actions.appendChild(cancelBtn)
  actions.appendChild(confirmBtn)

  confirmInput.addEventListener('input', () => {
    confirmBtn.disabled = isExecuting || confirmInput.value.trim() !== item.name
  })

  cancelBtn.addEventListener('click', () => {
    if (!isExecuting) ctx.closeModal()
  })

  confirmBtn.addEventListener('click', () => {
    if (isExecuting || confirmInput.value.trim() !== item.name || !ctx.activeConnectionId) return
    const connId = ctx.activeConnectionId
    isExecuting = true
    execErrBox.style.display = 'none'
    cancelBtn.disabled = true
    confirmInput.disabled = true
    setButtonLoading(confirmBtn, true, 'Executing... 0.0s')
    const stopTimer = ctx.createElapsedTimer((elapsedText) => {
      setButtonLoading(confirmBtn, true, `Executing... ${elapsedText}`)
    })

    void (async () => {
      let executed = false
      try {
        await ctx.requestPlugin<QueryResult>(
          'query.run',
          {
            connectionId: connId,
            queryId: `${action}_${Date.now()}`,
            sql,
          },
          { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
        )
        executed = true
      } catch (err: unknown) {
        stopTimer()
        isExecuting = false
        setButtonLoading(confirmBtn, false)
        cancelBtn.disabled = false
        confirmInput.disabled = false
        confirmBtn.disabled = confirmInput.value.trim() !== item.name
        const msg = err instanceof Error ? err.message : String(err)
        execErrBox.textContent = `Execution failed: ${msg}`
        execErrBox.style.display = 'block'
        return
      }
      if (executed) {
        stopTimer()
        isExecuting = false
        ctx.closeModal()
        try {
          await ctx.onDangerActionSucceeded(connId, action, item, actionTitle, sql)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          ctx.updateStatus(`${actionTitle} succeeded, but refresh failed: ${msg}`)
        }
      }
    })()
  })

  modal.appendChild(head)
  modal.appendChild(body)
  modal.appendChild(actions)
  ctx.mountModal(modal, () => !isExecuting)
  confirmInput.focus?.()
}

export const openDangerTableModal = openStudioDangerTableModal

export function openStudioCommandPalette(ctx: StudioCommandPaletteContext): void {
  interface PaletteEntry {
    label: string
    category: string
    searchText: string
    run: () => void
  }

  const kindCategory: Record<SchemaObjectKind, string> = {
    table: 'Table',
    view: 'View',
    materialized_view: 'Mat View',
    function: 'Function',
    procedure: 'Procedure',
    trigger: 'Trigger',
    sequence: 'Sequence',
    type: 'Type',
  }

  const entries: PaletteEntry[] = []
  for (const obj of ctx.schemaObjects) {
    entries.push({
      label: obj.schema ? `${obj.schema}.${obj.name}` : obj.name,
      category: kindCategory[obj.kind] || 'Table',
      searchText: `${obj.name} ${obj.schema || ''} ${obj.kind}`,
      run: () => {
        ctx.selectSidebarObject(obj)
      },
    })
  }
  for (const conn of ctx.connections) {
    const folderBadge = conn.folder ? ` [${conn.folder}]` : ''
    entries.push({
      label: `${conn.name} (${conn.driver})${folderBadge}`,
      category: 'Connection',
      searchText: `${conn.name} ${conn.driver} connection ${conn.folder || ''} ${conn.workspaceScope || ''}`,
      run: () => {
        ctx.selectConnection(conn.id)
      },
    })
  }
  entries.push(
    {
      label: 'New Database Connection...',
      category: 'Command',
      searchText: 'new add connect database connection server uri',
      run: () => ctx.openConnectionModal(),
    },
    {
      label: 'Format SQL (Shift+Alt+F)',
      category: 'Command',
      searchText: 'format sql prettify',
      run: () => ctx.formatSqlInConsole(),
    },
    {
      label: 'New Table...',
      category: 'Command',
      searchText: 'new create table',
      run: () => ctx.openCreateTableModal(),
    },
    ...(ctx.openImportDataModal
      ? [
          {
            label: 'Import CSV / JSON File...',
            category: 'Command',
            searchText: 'import csv tsv json ndjson file upload load rows',
            run: () => ctx.openImportDataModal?.(),
          },
        ]
      : []),
    ...(ctx.openExportSchemaDdl
      ? [
          {
            label: 'Export Full Schema DDL (.sql)...',
            category: 'Command',
            searchText: 'export full schema ddl sql database dump backup',
            run: () => ctx.openExportSchemaDdl?.(),
          },
        ]
      : []),
    ...(ctx.openDriverManagerModal
      ? [
          {
            label: 'Driver Manager (BYOD Drivers)...',
            category: 'Command',
            searchText: 'driver manager byod install oracle mssql mongodb duckdb snowflake bigquery',
            run: () => ctx.openDriverManagerModal?.(),
          },
        ]
      : []),
    {
      label: 'Toggle Sidebar / Horizontal Top Bar',
      category: 'Command',
      searchText: 'toggle sidebar topbar layout',
      run: () => ctx.setSidebarCollapsed(!ctx.sidebarCollapsed, true),
    },
    {
      label: 'Switch View Mode: Split View',
      category: 'Command',
      searchText: 'view mode split',
      run: () => ctx.switchMode('split'),
    },
    {
      label: 'Switch View Mode: Data Grid',
      category: 'Command',
      searchText: 'view mode data grid',
      run: () => ctx.switchMode('grid'),
    },
    {
      label: 'Switch View Mode: SQL Console',
      category: 'Command',
      searchText: 'view mode sql console',
      run: () => ctx.switchMode('sql'),
    },
    {
      label: 'Switch View Mode: Schema Inspector',
      category: 'Command',
      searchText: 'view mode schema inspector structure',
      run: () => ctx.switchMode('inspector'),
    },
    {
      label: 'Switch View Mode: ER Diagram',
      category: 'Command',
      searchText: 'view mode er diagram entity relationship schema graph',
      run: () => ctx.switchMode('er'),
    },
    {
      label: 'Toggle Query History',
      category: 'Command',
      searchText: 'query history drawer',
      run: () => {
        void ctx.toggleQueryHistory()
      },
    },
    ...(ctx.openSavedQueriesModal
      ? [
          {
            label: 'Saved Queries / SQL Snippets...',
            category: 'Command',
            searchText: 'saved queries snippets library sql bookmark insert load',
            run: () => ctx.openSavedQueriesModal?.(),
          },
        ]
      : []),
    {
      label: 'Refresh Schema',
      category: 'Command',
      searchText: 'refresh reload schema',
      run: () => {
        void ctx.handleRefreshAction()
      },
    },
    {
      label: 'Keyboard Shortcuts (?)',
      category: 'Command',
      searchText: 'keyboard shortcuts help cheatsheet',
      run: () => ctx.openShortcutsModal(),
    },
    {
      label: 'Toggle Light / Dark Theme',
      category: 'Command',
      searchText: 'toggle theme light dark appearance mode color scheme',
      run: () => {
        if (typeof document !== 'undefined') {
          const isLight = !document.documentElement.classList.contains('light')
          document.documentElement.classList.toggle('light', isLight)
          document.documentElement.classList.toggle('dark', !isLight)
          document.documentElement.dataset.themeOverride = isLight ? 'light' : 'dark'
          document.body?.classList.toggle('light', isLight)
          document.body?.classList.toggle('dark', !isLight)
          ctx.onThemeToggled?.(isLight)
        }
      },
    },
    {
      label: 'Report Bug / Request Feature...',
      category: 'Command',
      searchText: 'report bug issue feedback feature request github',
      run: () => ctx.openFeedbackModal(),
    }
  )

  const paletteActiveConn = ctx.activeConnection
  if (paletteActiveConn) {
    entries.push({
      label: 'Edit Active Connection...',
      category: 'Command',
      searchText: 'edit configure connection server',
      run: () => ctx.openConnectionModal(paletteActiveConn),
    })
  }

  const modal = document.createElement('div')
  modal.className = 'datanoa-cmd-palette'
  modal.setAttribute('aria-label', 'Command Palette')

  const searchInp = document.createElement('input')
  searchInp.type = 'search'
  searchInp.id = 'datanoa-cmd-palette-search'
  searchInp.className = 'datanoa-cmd-palette-input datanoa-filter-input'
  searchInp.placeholder = 'Jump to table, connection, or command...'
  searchInp.setAttribute('aria-label', 'Search tables, connections, or commands')

  const listEl = document.createElement('div')
  listEl.className = 'datanoa-cmd-palette-list'

  let filtered: PaletteEntry[] = []
  let activeIdx = 0

  const renderMatches = (scrollActiveIntoView = false) => {
    const q = searchInp.value.trim()
    filtered = entries
      .map((e) => ({ entry: e, score: fuzzyMatchScore(q, `${e.label} ${e.searchText}`) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map((x) => x.entry)

    if (activeIdx >= filtered.length) activeIdx = 0
    listEl.innerHTML = ''
    if (filtered.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'datanoa-cell-null'
      empty.style.padding = '10px'
      empty.textContent = 'No matching tables, connections, or commands.'
      listEl.appendChild(empty)
      return
    }

    filtered.forEach((item, idx) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `datanoa-cmd-palette-item${idx === activeIdx ? ' active' : ''}`
      const labelSpan = document.createElement('span')
      labelSpan.textContent = item.label
      const catSpan = document.createElement('span')
      catSpan.className = 'datanoa-badge'
      catSpan.textContent = item.category
      btn.appendChild(labelSpan)
      btn.appendChild(catSpan)
      btn.addEventListener('click', () => {
        ctx.closeModal()
        item.run()
      })
      listEl.appendChild(btn)
      if (scrollActiveIntoView && idx === activeIdx) {
        btn.scrollIntoView?.({ block: 'nearest' })
      }
    })
  }

  searchInp.addEventListener('input', () => {
    activeIdx = 0
    renderMatches(false)
  })

  searchInp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (filtered.length > 0) {
        activeIdx = (activeIdx + 1) % filtered.length
        renderMatches(true)
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (filtered.length > 0) {
        activeIdx = (activeIdx - 1 + filtered.length) % filtered.length
        renderMatches(true)
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = filtered[activeIdx]
      if (target) {
        ctx.closeModal()
        target.run()
      }
    }
  })

  renderMatches(false)
  modal.appendChild(searchInp)
  modal.appendChild(listEl)
  ctx.mountModal(modal)
  searchInp.focus?.()
}

export const openCommandPalette = openStudioCommandPalette

export function openStudioShortcutsModal(ctx: StudioModalMountContext): void {
  const modal = document.createElement('div')
  modal.className = 'datanoa-shortcuts-modal'

  const head = document.createElement('div')
  head.className = 'datanoa-modal-head'
  const titleEl = document.createElement('span')
  titleEl.id = 'datanoa-shortcuts-modal-title'
  titleEl.textContent = 'Keyboard Shortcuts'
  modal.setAttribute('aria-labelledby', titleEl.id)
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'datanoa-btn datanoa-btn-sm'
  closeBtn.textContent = 'Close'
  closeBtn.addEventListener('click', () => ctx.closeModal())
  head.appendChild(titleEl)
  head.appendChild(closeBtn)

  const body = document.createElement('div')
  body.className = 'datanoa-modal-body'

  const groups: ReadonlyArray<{
    title: string
    items: ReadonlyArray<[string, string]>
  }> = [
    {
      title: 'SQL Console',
      items: [
        ['Ctrl+Enter / Cmd+Enter', 'Execute statement at caret (or selection)'],
        ['Ctrl+Shift+Enter', 'Execute all statements in console'],
        ['Ctrl+F / Ctrl+H', 'SQL Console: find & replace'],
        ['Ctrl+Shift+[ / ]', 'Fold / Unfold SQL block'],
        ['Shift+Alt+F', 'Format SQL in console'],
        ['Tab / Ctrl+Right', 'Accept AI inline completion or full statement diff / next word'],
        ['Ctrl+Alt+Right / Cmd+Alt+Right', 'Accept next line of AI inline suggestion'],
        ['Alt+\\', 'Trigger AI Statement Edit (fix typos & complete)'],
      ],
    },
    {
      title: 'Data Grid & Selection',
      items: [
        ['Arrow / Shift+Arrow', 'Navigate cells & extend rectangular selection'],
        ['Ctrl+A', 'Select all visible cells'],
        ['Ctrl+C / Ctrl+V', 'Copy selected cells / Paste into cells or new rows'],
        ['Ctrl+Shift+V', 'Paste clipboard rows as new staged row(s)'],
        ['Enter / F2', 'Edit focused cell inline'],
        ['Delete / Backspace', 'Set selected cells to NULL'],
        ['Ctrl+F', 'Data Grid: find & highlight cells'],
        ['Ctrl+S', 'Submit staged data edits or schema migration'],
        ['Ctrl+Scroll', 'Horizontal pan across wide tables'],
        ['Ctrl+Click (FK cell)', 'Jump to referenced Foreign Key row'],
      ],
    },
    {
      title: 'Studio Navigation',
      items: [
        ['Ctrl+K / Ctrl+P', 'Open Quick Switcher / Command Palette'],
        ['Ctrl+/', 'Open Keyboard Shortcuts cheatsheet'],
        ['Escape', 'Close active menu, popover, or modal'],
      ],
    },
  ]

  for (const grp of groups) {
    const box = document.createElement('div')
    box.className = 'datanoa-modal-box'
    const grpTitle = document.createElement('strong')
    grpTitle.textContent = grp.title
    box.appendChild(grpTitle)

    const list = document.createElement('div')
    list.style.display = 'grid'
    list.style.gridTemplateColumns = '190px 1fr'
    list.style.gap = '4px 12px'
    list.style.marginTop = '6px'

    for (const [keys, desc] of grp.items) {
      const kbd = document.createElement('kbd')
      kbd.textContent = keys
      const descSpan = document.createElement('span')
      descSpan.style.color = 'var(--muted)'
      descSpan.textContent = desc
      list.appendChild(kbd)
      list.appendChild(descSpan)
    }
    box.appendChild(list)
    body.appendChild(box)
  }

  modal.appendChild(head)
  modal.appendChild(body)
  ctx.mountModal(modal)
}

export const openShortcutsModal = openStudioShortcutsModal