// src/editor/studio-modals.ts
// Fullscreen Studio Modals: Create Table, Danger Truncate/Drop, Command Palette, Keyboard Shortcuts,
// and Privacy-Safe In-App Feedback / Bug Report Modal

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
} from '../protocol.js'
import { copyTextFallback, fuzzyMatchScore, setButtonLoading } from './db-icons.js'

const DEFAULT_RPC_TIMEOUT_MS = 115_000
const GITHUB_NEW_ISSUE_BASE_URL = 'https://github.com/Thanhh2615/datanoa/issues/new'

export interface StudioModalMountContext {
  mountModal: (modalEl: HTMLElement, canClose?: () => boolean) => HTMLDivElement | null
  closeModal: () => void
}

export interface StudioCreateTableModalContext extends StudioModalMountContext {
  activeConnection?: ConnectionProfile
  activeConnectionId: string | null
  activeSchema?: string
  updateStatus: (stateText: string, metricsText?: string) => void
  createElapsedTimer: (onTick: (elapsedText: string, elapsedMs: number) => void) => () => void
  requestPlugin: <T = unknown>(
    method: string,
    payload?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ) => Promise<T>
  onTableCreated: (connId: string, tableName: string, schema: string | undefined, sql: string) => Promise<void>
}

export interface StudioDangerTableModalContext extends StudioModalMountContext {
  activeConnection?: ConnectionProfile
  activeConnectionId: string | null
  updateStatus: (stateText: string, metricsText?: string) => void
  showQueryBanner: (
    kind: 'success' | 'error',
    title: string,
    detail?: string,
    opts?: { onRetry?: () => void; showBackToTable?: boolean }
  ) => void
  createElapsedTimer: (onTick: (elapsedText: string, elapsedMs: number) => void) => () => void
  requestPlugin: <T = unknown>(
    method: string,
    payload?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ) => Promise<T>
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
  setSidebarCollapsed: (collapsed: boolean, persist?: boolean) => void
  switchMode: (mode: 'split' | 'grid' | 'sql' | 'inspector') => void
  toggleQueryHistory: () => Promise<void>
  handleRefreshAction: () => Promise<void>
  openShortcutsModal: () => void
  openFeedbackModal: (initialKind?: 'bug' | 'feature') => void
}

export interface StudioFeedbackModalContext extends StudioModalMountContext {
  activeDriver: DatabaseDriverType | null
  activeViewMode: 'split' | 'grid' | 'sql' | 'inspector'
  isReadOnly: boolean
  lastQueryErrorText: string
  updateStatus: (stateText: string, metricsText?: string) => void
}

/**
 * Strips any URI credentials, hostnames, file paths, or bearer/password tokens
 * from an error string before including it in the diagnostic block.
 */
export function sanitizeDiagnosticErrorText(rawError: string): string {
  const raw = String(rawError || '').trim()
  if (!raw) return ''
  return raw
    .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"<>]+/g, '<redacted-uri>')
    .replace(/\b(?:password|passwd|pwd|user|username|token|secret|authToken|api_key|apikey)\s*[:=]\s*[^\s,;'"<>]+/gi, '<redacted-secret>')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted-token>')
    .replace(/[A-Za-z]:\\[^\s'"<>]+/g, '<redacted-path>')
    .replace(/\/(?:Users|home|var|tmp|etc|opt|private|mnt|srv)\/[^\s'"<>]+/g, '<redacted-path>')
    .replace(/[^\s@'"<>]+@[^\s@'"<>]+\.[^\s@'"<>]+/g, '<redacted-endpoint>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<redacted-ip>')
    .replace(/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\.(?:co|com|io|net|org|dev|tech|cloud|app|local|internal|lan)(?::\d+)?\b/gi, '<redacted-host>')
    .replace(/\s+/g, ' ')
    .slice(0, 280)
}

function detectOrcaApiVersion(): string {
  if (typeof window === 'undefined') return 'v1'
  const api = (window as unknown as { orca?: { api?: { major?: number; minor?: number } } }).orca?.api
  if (api && typeof api.major === 'number') {
    return typeof api.minor === 'number' ? `v${api.major}.${api.minor}` : `v${api.major}`
  }
  return 'v1'
}

function detectRuntimePlatform(): string {
  if (typeof navigator !== 'undefined') {
    const navPlatform = (navigator as unknown as { userAgentData?: { platform?: string }; platform?: string })
    const label = navPlatform.userAgentData?.platform || navPlatform.platform || ''
    if (label.trim()) return label.trim()
  }
  if (typeof process !== 'undefined' && typeof process.platform === 'string') {
    return process.platform
  }
  return 'unknown'
}

export function buildStudioDiagnosticSummary(ctx: {
  activeDriver: DatabaseDriverType | null
  activeViewMode: 'split' | 'grid' | 'sql' | 'inspector'
  isReadOnly: boolean
  lastQueryErrorText?: string
}): string {
  const lines: string[] = [
    'Datanoa v1.0.1',
    `Orca API: ${detectOrcaApiVersion()}`,
    'Surface: Fullscreen Studio',
    `Active Engine: ${ctx.activeDriver ?? 'none'}`,
    `View Mode: ${ctx.activeViewMode}`,
    `Read-Only: ${Boolean(ctx.isReadOnly)}`,
    `Platform: ${detectRuntimePlatform()}`,
  ]
  const sanitizedErr = sanitizeDiagnosticErrorText(ctx.lastQueryErrorText || '')
  if (sanitizedErr) {
    lines.push(`Last Error: ${sanitizedErr}`)
  }
  return lines.join('\n')
}

export function openStudioCreateTableModal(ctx: StudioCreateTableModalContext): void {
  const conn = ctx.activeConnection
  if (!conn || conn.readOnly || conn.driver === 'redis') {
    ctx.updateStatus('Cannot create tables on this connection')
    return
  }
  const driver = conn.driver
  let isCreating = false

  const columns: CreateTableColumnDraft[] = [
    {
      name: 'id',
      dataType: 'INTEGER',
      nullable: false,
      defaultValue: '',
      isPrimaryKey: true,
      isAutoIncrement: true,
    },
    {
      name: 'name',
      dataType: 'TEXT',
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
  headTitle.textContent = 'Create New Table'
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
  tableNameInput.className = 'datanoa-filter-input'
  tableNameInput.placeholder = 'Table name (e.g. users)'
  tableNameInput.value = 'new_table'
  tableNameInput.style.flex = '2'

  const schemaInput = document.createElement('input')
  schemaInput.type = 'text'
  schemaInput.className = 'datanoa-filter-input'
  schemaInput.placeholder = 'Schema (optional)'
  schemaInput.value =
    driver !== 'sqlite' && driver !== 'libsql' ? ctx.activeSchema || '' : ''
  schemaInput.style.flex = '1'
  if (driver === 'sqlite' || driver === 'libsql') {
    schemaInput.style.display = 'none'
  }

  topFields.appendChild(tableNameInput)
  topFields.appendChild(schemaInput)
  body.appendChild(topFields)

  const colsHeader = document.createElement('div')
  colsHeader.style.display = 'flex'
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
  const colTable = document.createElement('table')
  colTable.className = 'datanoa-matrix-table datanoa-struct-grid'
  colTable.innerHTML =
    '<thead><tr><th>Name</th><th>Type</th><th>PK</th><th>AI</th><th>Null</th><th>Default</th><th></th></tr></thead>'
  const colTbody = document.createElement('tbody')
  colTable.appendChild(colTbody)
  colTableWrap.appendChild(colTable)
  body.appendChild(colTableWrap)

  const ddlLabel = document.createElement('div')
  ddlLabel.style.fontWeight = '600'
  ddlLabel.textContent = 'Live CREATE TABLE Preview:'
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
  createBtn.textContent = 'Create Table'
  actions.appendChild(cancelBtn)
  actions.appendChild(createBtn)

  let currentSql = ''
  const updatePreview = () => {
    try {
      currentSql = buildCreateTableSql(
        {
          tableName: tableNameInput.value,
          schema: schemaInput.value.trim() || undefined,
          columns,
        },
        driver
      )
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
      typeInp.addEventListener('input', () => {
        col.dataType = typeInp.value
        updatePreview()
      })
      tdType.appendChild(typeInp)

      const tdPk = document.createElement('td')
      const pkCb = document.createElement('input')
      pkCb.type = 'checkbox'
      pkCb.checked = Boolean(col.isPrimaryKey)
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
        stopTimer()
        isCreating = false
        ctx.closeModal()
        await ctx.onTableCreated(connId, targetName, targetSchema, currentSql)
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
  let sql = ''
  try {
    sql =
      action === 'truncate'
        ? buildTruncateTableSql(item.name, driver, item.schema)
        : buildDropTableSql(item.name, item.kind, driver, item.schema)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.showQueryBanner('error', 'Operation Unavailable', msg)
    return
  }

  let isExecuting = false
  const actionTitle =
    action === 'truncate'
      ? `Truncate Table "${item.name}"`
      : item.kind === 'view'
        ? `Drop View "${item.name}"`
        : `Drop Table "${item.name}"`

  const modal = document.createElement('div')
  modal.className = 'datanoa-danger-modal'

  const head = document.createElement('div')
  head.className = 'datanoa-modal-head'
  const titleEl = document.createElement('span')
  titleEl.textContent = actionTitle
  const badge = document.createElement('span')
  badge.className = 'datanoa-badge'
  badge.style.color = 'var(--danger)'
  badge.textContent = action === 'truncate' ? 'DELETE ALL ROWS' : 'PERMANENT DROP'
  head.appendChild(titleEl)
  head.appendChild(badge)

  const body = document.createElement('div')
  body.className = 'datanoa-modal-body'

  if (conn.colorTag === 'prod') {
    const prodWarn = document.createElement('div')
    prodWarn.className = 'datanoa-modal-box error'
    prodWarn.textContent =
      'PRODUCTION CONNECTION WARNING: This action is irreversible and will immediately affect production data!'
    body.appendChild(prodWarn)
  }

  const desc = document.createElement('div')
  desc.textContent =
    action === 'truncate'
      ? `This will permanently remove all rows from "${item.name}". Type the exact table name below to confirm.`
      : `This will permanently drop ${item.kind} "${item.name}" and its data. Type the exact name below to confirm.`
  body.appendChild(desc)

  const sqlPre = document.createElement('pre')
  sqlPre.className = 'datanoa-modal-sql'
  sqlPre.textContent = sql
  body.appendChild(sqlPre)

  const confirmInput = document.createElement('input')
  confirmInput.type = 'text'
  confirmInput.className = 'datanoa-filter-input'
  confirmInput.placeholder = `Type "${item.name}" to enable confirmation`
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
    action === 'truncate' ? 'Truncate Table' : `Drop ${item.kind === 'view' ? 'View' : 'Table'}`
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
        stopTimer()
        isExecuting = false
        ctx.closeModal()
        await ctx.onDangerActionSucceeded(connId, action, item, actionTitle, sql)
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

  const entries: PaletteEntry[] = []
  for (const obj of ctx.schemaObjects) {
    entries.push({
      label: obj.schema ? `${obj.schema}.${obj.name}` : obj.name,
      category: obj.kind === 'view' ? 'View' : 'Table',
      searchText: `${obj.name} ${obj.schema || ''} ${obj.kind}`,
      run: () => {
        ctx.selectSidebarObject(obj)
      },
    })
  }
  for (const conn of ctx.connections) {
    entries.push({
      label: `${conn.name} (${conn.driver})`,
      category: 'Connection',
      searchText: `${conn.name} ${conn.driver} connection`,
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
      label: 'Toggle Query History',
      category: 'Command',
      searchText: 'query history drawer',
      run: () => {
        void ctx.toggleQueryHistory()
      },
    },
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

  const searchInp = document.createElement('input')
  searchInp.type = 'search'
  searchInp.className = 'datanoa-cmd-palette-input datanoa-filter-input'
  searchInp.placeholder = 'Jump to table, connection, or command...'

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
  titleEl.textContent = 'Keyboard Shortcuts'
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
        ['Shift+Alt+F', 'Format SQL in console'],
      ],
    },
    {
      title: 'Data Grid & Selection',
      items: [
        ['Arrow / Shift+Arrow', 'Navigate cells & extend rectangular selection'],
        ['Ctrl+A', 'Select all visible cells'],
        ['Ctrl+C / Ctrl+V', 'Copy selection as TSV / Paste TSV or CSV'],
        ['Enter / F2', 'Edit focused cell inline'],
        ['Delete / Backspace', 'Set selected cells to NULL'],
        ['Ctrl+F', 'Find & highlight cells in grid'],
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

export function openStudioFeedbackModal(
  ctx: StudioFeedbackModalContext,
  initialKind: 'bug' | 'feature' = 'bug'
): void {
  if (typeof document === 'undefined') return
  let kind: 'bug' | 'feature' = initialKind

  const modal = document.createElement('div')
  modal.className = 'datanoa-feedback-modal'

  const head = document.createElement('div')
  head.className = 'datanoa-modal-head'
  const titleEl = document.createElement('span')
  titleEl.textContent = 'Report Issue / Request Feature'
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'datanoa-btn datanoa-btn-sm'
  closeBtn.textContent = 'Close'
  closeBtn.addEventListener('click', () => ctx.closeModal())
  head.appendChild(titleEl)
  head.appendChild(closeBtn)

  const body = document.createElement('div')
  body.className = 'datanoa-modal-body'

  const noticeBox = document.createElement('div')
  noticeBox.className = 'datanoa-modal-box datanoa-feedback-notice'
  noticeBox.style.display = 'none'
  noticeBox.setAttribute('role', 'status')
  const showNotice = (status: 'success' | 'neutral', text: string): void => {
    noticeBox.className = `datanoa-modal-box datanoa-feedback-notice${status === 'success' ? ' success' : ''}`
    noticeBox.textContent = text
    noticeBox.style.display = 'block'
  }
  body.appendChild(noticeBox)

  // Kind Toggle: Bug Report vs Feature Request / UI Improvement
  const kindRow = document.createElement('div')
  kindRow.className = 'datanoa-feedback-kind-group'
  const bugBtn = document.createElement('button')
  bugBtn.type = 'button'
  bugBtn.dataset.kind = 'bug'
  bugBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-feedback-kind-btn'
  bugBtn.textContent = 'Bug Report'

  const featureBtn = document.createElement('button')
  featureBtn.type = 'button'
  featureBtn.dataset.kind = 'feature'
  featureBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-feedback-kind-btn'
  featureBtn.textContent = 'Feature Request / UI Improvement'

  kindRow.appendChild(bugBtn)
  kindRow.appendChild(featureBtn)
  body.appendChild(kindRow)

  // Summary / Title
  const titleField = document.createElement('div')
  titleField.className = 'datanoa-conn-field is-full'
  const titleLabel = document.createElement('label')
  titleLabel.textContent = 'Summary / Title'
  const titleInput = document.createElement('input')
  titleInput.type = 'text'
  titleInput.className = 'datanoa-feedback-title-input datanoa-filter-input'
  titleInput.placeholder = 'Brief summary of the bug or feature request...'
  titleField.appendChild(titleLabel)
  titleField.appendChild(titleInput)
  body.appendChild(titleField)

  // Details / Steps to Reproduce
  const bodyField = document.createElement('div')
  bodyField.className = 'datanoa-conn-field is-full'
  const bodyLabel = document.createElement('label')
  bodyLabel.textContent = 'Details / Steps to Reproduce'
  const bodyTextarea = document.createElement('textarea')
  bodyTextarea.className = 'datanoa-feedback-body-input datanoa-value-textarea'
  bodyTextarea.rows = 5
  bodyTextarea.placeholder = 'Steps to reproduce, expected behavior, and actual behavior...'
  bodyField.appendChild(bodyLabel)
  bodyField.appendChild(bodyTextarea)
  body.appendChild(bodyField)

  // Privacy-Safe Diagnostic Summary
  const diagField = document.createElement('div')
  diagField.className = 'datanoa-conn-field is-full'
  const diagLabel = document.createElement('label')
  diagLabel.textContent = 'Privacy-Safe Diagnostic Summary (no hosts, credentials, or paths)'
  const diagPre = document.createElement('pre')
  diagPre.className = 'datanoa-feedback-diag datanoa-modal-sql'
  diagPre.setAttribute('contenteditable', 'true')
  diagPre.spellcheck = false
  diagPre.textContent = buildStudioDiagnosticSummary({
    activeDriver: ctx.activeDriver,
    activeViewMode: ctx.activeViewMode,
    isReadOnly: ctx.isReadOnly,
    lastQueryErrorText: ctx.lastQueryErrorText,
  })
  diagField.appendChild(diagLabel)
  diagField.appendChild(diagPre)
  body.appendChild(diagField)

  const syncKindPresentation = (): void => {
    const isBug = kind === 'bug'
    bugBtn.classList.toggle('active', isBug)
    bugBtn.classList.toggle('datanoa-btn-primary', isBug)
    featureBtn.classList.toggle('active', !isBug)
    featureBtn.classList.toggle('datanoa-btn-primary', !isBug)
    bodyLabel.textContent = isBug
      ? 'Details / Steps to Reproduce'
      : 'Feature Description / Use Case'
    bodyTextarea.placeholder = isBug
      ? 'Steps to reproduce, expected behavior, and actual behavior...'
      : 'Describe the feature or UI improvement and how it helps your workflow...'
  }

  bugBtn.addEventListener('click', () => {
    kind = 'bug'
    syncKindPresentation()
  })
  featureBtn.addEventListener('click', () => {
    kind = 'feature'
    syncKindPresentation()
  })
  syncKindPresentation()

  const buildReportPayload = (): { title: string; markdownBody: string; githubUrl: string } => {
    const rawTitle = titleInput.value.trim()
    const prefix = kind === 'bug' ? '[Bug]' : '[Feature]'
    const defaultTitle =
      kind === 'bug' ? 'Fullscreen Studio issue report' : 'Studio feature request'
    const baseTitle = rawTitle || defaultTitle
    const title = baseTitle.startsWith('[') ? baseTitle : `${prefix} ${baseTitle}`
    const details =
      bodyTextarea.value.trim() ||
      (kind === 'bug'
        ? '_Describe the steps to reproduce and what happened._'
        : '_Describe the proposed feature or UI improvement._')
    const diagText = (diagPre.textContent || '').trim()
    const sectionHeader =
      kind === 'bug' ? '### Steps to Reproduce / Details' : '### Feature Request / Details'
    const markdownBody = `${sectionHeader}\n${details}\n\n### Environment Diagnostics\n\`\`\`text\n${diagText}\n\`\`\``
    const templateParam = kind === 'bug' ? 'bug_report.yml' : 'feature_request.yml'
    const labelParam = kind === 'bug' ? 'bug' : 'enhancement'
    const githubUrl = `${GITHUB_NEW_ISSUE_BASE_URL}?template=${templateParam}&labels=${labelParam}&title=${encodeURIComponent(title)}&body=${encodeURIComponent(markdownBody)}`
    return { title, markdownBody, githubUrl }
  }

  const actions = document.createElement('div')
  actions.className = 'datanoa-modal-actions'

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'datanoa-btn datanoa-btn-sm'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.addEventListener('click', () => ctx.closeModal())

  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-feedback-copy-btn'
  copyBtn.textContent = 'Copy Report'
  copyBtn.addEventListener('click', () => {
    const { title, markdownBody } = buildReportPayload()
    const fullMarkdown = `## ${title}\n\n${markdownBody}`
    copyTextFallback(fullMarkdown, copyBtn)
    showNotice('success', 'Copied full Markdown report to clipboard.')
    ctx.updateStatus('Copied feedback report to clipboard')
  })

  const githubBtn = document.createElement('button')
  githubBtn.type = 'button'
  githubBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-primary datanoa-feedback-github-btn'
  githubBtn.textContent = 'Open on GitHub Issues ↗'
  githubBtn.addEventListener('click', () => {
    const { title, markdownBody, githubUrl } = buildReportPayload()
    const fullMarkdown = `## ${title}\n\n${markdownBody}`
    copyTextFallback(fullMarkdown)
    const openExternalFn =
      typeof window !== 'undefined'
        ? (
            window as unknown as {
              orca?: { shell?: { openExternal?: (url: string) => unknown } }
            }
          ).orca?.shell?.openExternal
        : undefined
    if (typeof openExternalFn === 'function') {
      try {
        void Promise.resolve(openExternalFn(githubUrl)).catch(() => {})
      } catch {
        // Fallback already copied to clipboard
      }
    }
    showNotice(
      'success',
      'Report copied to clipboard and prepared for GitHub Issues (github.com/Thanhh2615/datanoa/issues).'
    )
    ctx.updateStatus('Opened GitHub Issues & copied report to clipboard')
  })

  actions.appendChild(cancelBtn)
  actions.appendChild(copyBtn)
  actions.appendChild(githubBtn)

  modal.appendChild(head)
  modal.appendChild(body)
  modal.appendChild(actions)
  ctx.mountModal(modal)
  titleInput.focus?.()
}

export const openFeedbackModal = openStudioFeedbackModal
