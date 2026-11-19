// src/editor/connection-modal.ts
// Fullscreen Studio 8-Engine Connection Manager Modal (URI parser, .env & .db workspace scanner, test/save/delete)

import type {
  ConnectionColorTag,
  ConnectionProfile,
  DatabaseDriverType,
} from '../protocol.js'
import {
  CONNECTION_ENV_TAGS,
  STUDIO_ENGINES,
  createDbLogoSvg,
  getStudioEngineMeta,
  isKnownConnectionDriver,
  setButtonLoading,
} from './db-icons.js'

const DEFAULT_RPC_TIMEOUT_MS = 115_000

export function maskUriSecret(rawUri: string): string {
  return String(rawUri || '').replace(
    /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:/?#\s@]*:)([^@]+)(@)/,
    '$1***$3'
  )
}

export const maskConnectionUriSecret = maskUriSecret

export function compactFilePath(filePath: string, maxLen = 48): string {
  const raw = String(filePath || '').trim()
  if (raw.length <= maxLen) return raw
  const parts = raw.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) {
    return `...${raw.slice(-(maxLen - 3))}`
  }
  const tail = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
  if (tail.length + 4 >= maxLen) {
    return `.../${parts[parts.length - 1]}`
  }
  return `${parts[0]}/.../${tail}`
}

export type ConnectionSubmission = {
  profile: ConnectionProfile
  password?: string
  authToken?: string
}

export interface ParseUriResponse {
  ok: boolean
  profile?: Partial<ConnectionProfile>
  password?: string
  authToken?: string
  placeholderPassword?: boolean
  error?: string
}

export interface DiscoveredSqliteFile {
  name: string
  filePath: string
  sizeBytes: number
  sizeLabel: string
}

export interface DiscoveredEnvConnection {
  envKey: string
  sourceFile: string
  driver: DatabaseDriverType
  name: string
  uri: string
}

export interface WorkspaceDetectResponse {
  sqliteFiles?: DiscoveredSqliteFile[]
  envConnections?: DiscoveredEnvConnection[]
}

export interface StudioConnectionModalContext {
  isBackdropActive: (backdrop: HTMLDivElement | null) => boolean
  mountModal: (modalEl: HTMLElement, canClose?: () => boolean) => HTMLDivElement | null
  closeModal: () => void
  requestPlugin: <T = unknown>(
    method: string,
    payload?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ) => Promise<T>
  createElapsedTimer: (onTick: (elapsedText: string, elapsedMs: number) => void) => () => void
  updateStatus: (stateText: string, metricsText?: string) => void
  activateSavedConnection: (savedId: string) => Promise<void>
  onConnectionDeleted: (deletedId: string) => Promise<void>
}

export function openStudioConnectionModal(
  ctx: StudioConnectionModalContext,
  editProfile?: ConnectionProfile
): void {
  if (typeof document === 'undefined') return
  const isEdit = editProfile !== undefined
  const editId = editProfile?.id ?? ''

  let driver: DatabaseDriverType = editProfile ? editProfile.driver : 'sqlite'
  if (!isKnownConnectionDriver(driver)) driver = 'sqlite'
  let colorTag: ConnectionColorTag = editProfile?.colorTag ?? 'none'
  let hadPassword = Boolean(editProfile?.hasPassword)
  let hadAuthToken = Boolean(editProfile?.hasAuthToken)
  let lastParsedUri = ''
  let lastParsedPlaceholder = false
  let placeholderPending = false
  let lastAutoName = ''
  let isBusy = false
  let parseSeq = 0
  let detectSeq = 0
  let discoveredEnvs: DiscoveredEnvConnection[] = []
  let discoveredFiles: DiscoveredSqliteFile[] = []
  let discoveredFilter = ''
  let deleteArmed = false
  let deleteTimer: ReturnType<typeof setTimeout> | null = null
  let backdropRef: HTMLDivElement | null = null
  const isModalOpen = (): boolean => ctx.isBackdropActive(backdropRef)

  const createInput = (placeholder: string, mono = false): HTMLInputElement => {
    const el = document.createElement('input')
    el.type = 'text'
    el.className = `datanoa-conn-input${mono ? ' is-mono' : ''}`
    el.placeholder = placeholder
    el.setAttribute('autocomplete', 'off')
    el.spellcheck = false
    return el
  }

  const createField = (labelText: string, control: HTMLElement, full = false): HTMLDivElement => {
    const wrap = document.createElement('div')
    wrap.className = `datanoa-conn-field${full ? ' is-full' : ''}`
    const label = document.createElement('label')
    label.textContent = labelText
    wrap.appendChild(label)
    wrap.appendChild(control)
    return wrap
  }

  const createCheck = (labelText: string): { wrap: HTMLLabelElement; input: HTMLInputElement } => {
    const wrap = document.createElement('label')
    wrap.className = 'datanoa-conn-check'
    const input = document.createElement('input')
    input.type = 'checkbox'
    const text = document.createElement('span')
    text.textContent = labelText
    wrap.appendChild(input)
    wrap.appendChild(text)
    return { wrap, input }
  }

  const createButton = (text: string, extraClass = ''): HTMLButtonElement => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `datanoa-btn datanoa-btn-sm${extraClass ? ` ${extraClass}` : ''}`
    btn.textContent = text
    return btn
  }

  const showEl = (el: HTMLElement, visible: boolean): void => {
    el.style.display = visible ? '' : 'none'
  }

  // ---- Shell ----
  const modal = document.createElement('div')
  modal.className = 'datanoa-conn-modal'

  const head = document.createElement('div')
  head.className = 'datanoa-modal-head'
  const headTitle = document.createElement('span')
  headTitle.textContent = isEdit
    ? `Edit Connection — ${editProfile?.name ?? ''}`
    : 'New Database Connection'
  head.appendChild(headTitle)

  const body = document.createElement('div')
  body.className = 'datanoa-modal-body'

  const noticeBox = document.createElement('div')
  noticeBox.className = 'datanoa-modal-box'
  noticeBox.style.display = 'none'
  noticeBox.setAttribute('role', 'status')
  const showNotice = (kind: 'error' | 'success' | 'neutral', text: string): void => {
    noticeBox.className = `datanoa-modal-box${kind === 'neutral' ? '' : ` ${kind}`}`
    noticeBox.textContent = text
    noticeBox.style.display = 'block'
  }
  body.appendChild(noticeBox)

  // ---- Quick URI bar & workspace auto-detect ----
  const uriBar = document.createElement('div')
  uriBar.className = 'datanoa-conn-uri-bar'
  const uriLabel = document.createElement('div')
  uriLabel.className = 'datanoa-conn-section-label'
  uriLabel.textContent = 'Quick Connect'
  const uriRow = document.createElement('div')
  uriRow.className = 'datanoa-conn-row'
  const uriInp = createInput(
    'Paste connection URI (postgres://, mysql://, redis://, libsql://, clickhouse://, sqlite://)...',
    true
  )
  uriInp.classList.add('datanoa-conn-uri-input')
  const parseBtn = createButton('Parse URI')
  uriRow.appendChild(uriInp)
  uriRow.appendChild(parseBtn)

  const detectRow = document.createElement('div')
  detectRow.className = 'datanoa-conn-row is-wrap'
  const detectBtn = createButton('Auto-Detect (.env & .db)')
  const folderInp = createInput('Optional folder path to scan...', true)
  folderInp.style.flex = '1 1 160px'
  const scanBtn = createButton('Scan Folder')
  detectRow.appendChild(detectBtn)
  detectRow.appendChild(folderInp)
  detectRow.appendChild(scanBtn)

  uriBar.appendChild(uriLabel)
  uriBar.appendChild(uriRow)
  uriBar.appendChild(detectRow)
  body.appendChild(uriBar)

  const discoveredBox = document.createElement('div')
  discoveredBox.className = 'datanoa-conn-discovered'
  discoveredBox.style.display = 'none'
  body.appendChild(discoveredBox)

  // ---- Engine grid ----
  const engineLabel = document.createElement('div')
  engineLabel.className = 'datanoa-conn-section-label'
  engineLabel.textContent = 'Database Engine'
  const engineGrid = document.createElement('div')
  engineGrid.className = 'datanoa-engine-grid'
  const engineTiles = new Map<DatabaseDriverType, HTMLButtonElement>()
  for (const eng of STUDIO_ENGINES) {
    const tile = document.createElement('button')
    tile.type = 'button'
    tile.className = 'datanoa-engine-tile'
    tile.dataset.driver = eng.id
    tile.title = eng.label
    tile.appendChild(createDbLogoSvg(eng.id))
    const tileLabel = document.createElement('span')
    tileLabel.textContent = eng.label
    tile.appendChild(tileLabel)
    tile.addEventListener('click', () => {
      if (isBusy || driver === eng.id) return
      applyDriver(eng.id, true)
    })
    engineTiles.set(eng.id, tile)
    engineGrid.appendChild(tile)
  }
  body.appendChild(engineLabel)
  body.appendChild(engineGrid)

  // ---- Fields ----
  const nameInp = createInput('Connection name')
  const filePathInp = createInput('C:\\path\\to\\database.db', true)
  const libsqlUrlInp = createInput('libsql://your-db.turso.io', true)
  const authTokenInp = createInput('Optional Bearer token')
  authTokenInp.type = 'password'
  const libsqlDbInp = createInput('Database label (e.g. turso)')
  const hostInp = createInput('localhost', true)
  const portInp = createInput('Port', true)
  portInp.inputMode = 'numeric'
  const userInp = createInput('Optional')
  const passwordInp = createInput('Optional')
  passwordInp.type = 'password'
  passwordInp.setAttribute('autocomplete', 'new-password')
  const databaseInp = createInput('Database')
  const redisDbSel = document.createElement('select')
  redisDbSel.className = 'datanoa-conn-select'
  for (let i = 0; i <= 15; i++) {
    const opt = document.createElement('option')
    opt.value = String(i)
    opt.textContent = `db${i}`
    redisDbSel.appendChild(opt)
  }
  const chUrlInp = createInput('http://localhost:8123 (HTTP(S) endpoint)', true)
  const optionsInp = createInput('--cluster=my-cluster or endpoint=ep-abc123', true)
  const sslCheck = createCheck('SSL / TLS')
  const roCheck = createCheck('Read-Only Mode')
  roCheck.input.checked = Boolean(editProfile?.readOnly)

  const envPills = document.createElement('div')
  envPills.className = 'datanoa-conn-env-pills'
  const envPillBtns = new Map<ConnectionColorTag, HTMLButtonElement>()
  const syncEnvPills = (): void => {
    envPillBtns.forEach((btn, id) => btn.classList.toggle('active', id === colorTag))
  }
  for (const tag of CONNECTION_ENV_TAGS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `datanoa-conn-env-pill env-${tag.id}`
    btn.textContent = tag.label
    btn.addEventListener('click', () => {
      if (isBusy) return
      colorTag = tag.id
      syncEnvPills()
    })
    envPillBtns.set(tag.id, btn)
    envPills.appendChild(btn)
  }

  const fieldsGrid = document.createElement('div')
  fieldsGrid.className = 'datanoa-conn-fields'
  const rowName = createField('Connection Name', nameInp, true)
  const envRow = document.createElement('div')
  envRow.className = 'datanoa-conn-row is-wrap'
  envRow.appendChild(envPills)
  envRow.appendChild(roCheck.wrap)
  const rowEnv = createField('Environment Tag', envRow, true)
  const rowFilePath = createField('SQLite File Path', filePathInp, true)
  const rowLibsqlUrl = createField('LibSQL / Turso URL', libsqlUrlInp, true)
  const rowAuthToken = createField('Auth Token', authTokenInp)
  const rowLibsqlDb = createField('Database Label', libsqlDbInp)
  const rowHost = createField('Host', hostInp)
  const rowPort = createField('Port', portInp)
  const rowUser = createField('User', userInp)
  const rowPassword = createField('Password', passwordInp)
  const rowDatabase = createField('Database', databaseInp)
  const rowRedisDb = createField('Redis DB Index', redisDbSel)
  const rowSsl = createField('Security', sslCheck.wrap)
  const rowChUrl = createField('HTTP(S) Endpoint URL', chUrlInp, true)
  const rowOptions = createField('Options (Cluster / Endpoint)', optionsInp, true)
  for (const row of [
    rowName,
    rowEnv,
    rowFilePath,
    rowLibsqlUrl,
    rowAuthToken,
    rowLibsqlDb,
    rowHost,
    rowPort,
    rowUser,
    rowPassword,
    rowDatabase,
    rowRedisDb,
    rowSsl,
    rowChUrl,
    rowOptions,
  ]) {
    fieldsGrid.appendChild(row)
  }
  body.appendChild(fieldsGrid)

  // ---- Footer ----
  const actions = document.createElement('div')
  actions.className = 'datanoa-modal-actions'
  const deleteBtn = createButton('Delete Connection', 'datanoa-btn-danger')
  deleteBtn.style.marginRight = 'auto'
  const testBtn = createButton('Test Connection')
  const cancelBtn = createButton('Cancel')
  const saveBtn = createButton(
    isEdit ? 'Update Connection' : 'Save & Connect',
    'datanoa-btn-primary'
  )
  if (isEdit) actions.appendChild(deleteBtn)
  actions.appendChild(testBtn)
  actions.appendChild(cancelBtn)
  actions.appendChild(saveBtn)

  const busyControls: Array<HTMLInputElement | HTMLSelectElement | HTMLButtonElement> = [
    uriInp,
    parseBtn,
    detectBtn,
    folderInp,
    scanBtn,
    nameInp,
    filePathInp,
    libsqlUrlInp,
    authTokenInp,
    libsqlDbInp,
    hostInp,
    portInp,
    userInp,
    passwordInp,
    databaseInp,
    redisDbSel,
    chUrlInp,
    optionsInp,
    sslCheck.input,
    roCheck.input,
    deleteBtn,
    testBtn,
    cancelBtn,
    saveBtn,
    ...Array.from(engineTiles.values()),
  ]
  const setBusy = (busy: boolean): void => {
    isBusy = busy
    for (const ctrl of busyControls) {
      ctrl.disabled = busy
    }
  }

  // ---- Discovery rendering ----
  const renderDiscovered = (): void => {
    discoveredBox.innerHTML = ''
    const showFiles = driver === 'sqlite' && discoveredFiles.length > 0
    const showEnvs = discoveredEnvs.length > 0
    if (!showFiles && !showEnvs) {
      showEl(discoveredBox, false)
      return
    }
    showEl(discoveredBox, true)

    if (showEnvs) {
      const label = document.createElement('div')
      label.className = 'datanoa-conn-section-label'
      label.textContent = `Detected .env connections (${discoveredEnvs.length})`
      discoveredBox.appendChild(label)
      const list = document.createElement('div')
      list.className = 'datanoa-conn-chip-list'
      for (const item of discoveredEnvs) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'datanoa-conn-chip'
        const masked = maskUriSecret(item.uri)
        chip.title = `${item.sourceFile} (${item.envKey}): ${masked}`
        const main = document.createElement('span')
        main.className = 'datanoa-conn-chip-main'
        const title = document.createElement('span')
        title.className = 'datanoa-conn-chip-title'
        if (isKnownConnectionDriver(item.driver)) title.appendChild(createDbLogoSvg(item.driver))
        const titleText = document.createElement('span')
        titleText.textContent = `${item.envKey} (${item.name || item.driver})`
        title.appendChild(titleText)
        const sub = document.createElement('span')
        sub.className = 'datanoa-conn-chip-sub'
        sub.textContent = masked
        main.appendChild(title)
        main.appendChild(sub)
        const badge = document.createElement('span')
        badge.className = 'datanoa-badge'
        badge.textContent = item.sourceFile || '.env'
        chip.appendChild(main)
        chip.appendChild(badge)
        chip.addEventListener('click', () => {
          if (isBusy) return
          uriInp.value = item.uri
          if (!nameInp.value.trim()) {
            nameInp.value = item.name || item.envKey
            lastAutoName = nameInp.value
          }
          void parseUri(item.uri, true)
        })
        list.appendChild(chip)
      }
      discoveredBox.appendChild(list)
    }

    if (showFiles) {
      const label = document.createElement('div')
      label.className = 'datanoa-conn-section-label'
      label.textContent = `Detected SQLite files (${discoveredFiles.length})`
      discoveredBox.appendChild(label)
      const filterInp = createInput('Filter discovered .db files...')
      filterInp.value = discoveredFilter
      filterInp.addEventListener('input', () => {
        discoveredFilter = filterInp.value
        renderDiscovered()
        const refocus = discoveredBox.querySelector('input')
        if (refocus instanceof HTMLInputElement) {
          refocus.focus()
          refocus.setSelectionRange?.(discoveredFilter.length, discoveredFilter.length)
        }
      })
      discoveredBox.appendChild(filterInp)
      const q = discoveredFilter.trim().toLowerCase()
      const filtered = q
        ? discoveredFiles.filter(
            (f) =>
              f.name.toLowerCase().includes(q) || f.filePath.toLowerCase().includes(q)
          )
        : discoveredFiles
      const list = document.createElement('div')
      list.className = 'datanoa-conn-chip-list'
      if (filtered.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'datanoa-cell-null'
        empty.textContent = `No SQLite files match "${discoveredFilter}".`
        list.appendChild(empty)
      }
      for (const file of filtered) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = `datanoa-conn-chip${filePathInp.value.trim() === file.filePath ? ' selected' : ''}`
        chip.title = file.filePath
        const main = document.createElement('span')
        main.className = 'datanoa-conn-chip-main'
        const title = document.createElement('span')
        title.className = 'datanoa-conn-chip-title'
        title.appendChild(createDbLogoSvg('sqlite'))
        const titleText = document.createElement('span')
        titleText.textContent = file.name
        title.appendChild(titleText)
        const sub = document.createElement('span')
        sub.className = 'datanoa-conn-chip-sub'
        sub.textContent = file.filePath
        main.appendChild(title)
        main.appendChild(sub)
        const size = document.createElement('span')
        size.className = 'datanoa-badge datanoa-badge-unique'
        size.textContent = file.sizeLabel || `${file.sizeBytes} B`
        chip.appendChild(main)
        chip.appendChild(size)
        chip.addEventListener('click', () => {
          if (isBusy) return
          filePathInp.value = file.filePath
          if (!nameInp.value.trim() || nameInp.value === lastAutoName) {
            nameInp.value = file.name
            lastAutoName = file.name
          }
          renderDiscovered()
        })
        list.appendChild(chip)
      }
      discoveredBox.appendChild(list)
    }
  }

  // ---- Driver switching ----
  const applyDriver = (next: DatabaseDriverType, applyDefaults: boolean): void => {
    const prevMeta = getStudioEngineMeta(driver)
    driver = next
    const meta = getStudioEngineMeta(next)
    engineTiles.forEach((tile, id) => tile.classList.toggle('active', id === next))
    const isSqlite = next === 'sqlite'
    const isLibsql = next === 'libsql'
    const isServer = !isSqlite && !isLibsql
    showEl(rowFilePath, isSqlite)
    showEl(rowLibsqlUrl, isLibsql)
    showEl(rowAuthToken, isLibsql)
    showEl(rowLibsqlDb, isLibsql)
    showEl(rowHost, isServer)
    showEl(rowPort, isServer)
    showEl(rowUser, isServer)
    showEl(rowPassword, isServer)
    showEl(rowDatabase, isServer && next !== 'redis')
    showEl(rowRedisDb, next === 'redis')
    showEl(rowSsl, isServer)
    showEl(rowChUrl, next === 'clickhouse')
    showEl(rowOptions, next === 'postgres' || next === 'cockroachdb')
    databaseInp.placeholder = meta.defaultDb
    userInp.placeholder = meta.defaultUser || 'Optional'
    if (applyDefaults) {
      const curPort = portInp.value.trim()
      if (!curPort || curPort === String(prevMeta.defaultPort)) {
        portInp.value = meta.defaultPort > 0 ? String(meta.defaultPort) : ''
      }
      sslCheck.input.checked = meta.defaultSsl
    }
    renderDiscovered()
  }

  // ---- Submission ----
  const buildSubmission = (id: string): ConnectionSubmission => {
    const name = nameInp.value.trim()
    const readOnly = roCheck.input.checked
    const sameDriverAsStored = isEdit && editProfile?.driver === driver

    if (driver === 'sqlite') {
      const filePath = filePathInp.value.trim()
      const baseName = filePath.split(/[\\/]/).filter(Boolean).pop() || 'database.db'
      return {
        profile: {
          id,
          name: name || baseName,
          driver: 'sqlite',
          database: baseName,
          filePath,
          readOnly,
          colorTag,
        },
      }
    }

    if (driver === 'libsql') {
      const url = libsqlUrlInp.value.trim()
      const authToken = authTokenInp.value
      const keepStoredToken = sameDriverAsStored && hadAuthToken
      const submission: ConnectionSubmission = {
        profile: {
          id,
          name: name || url || 'LibSQL',
          driver: 'libsql',
          database: libsqlDbInp.value.trim() || 'turso',
          url,
          ssl: /^(?:https|libsql|wss):\/\//i.test(url) || !/^http:\/\//i.test(url),
          readOnly,
          colorTag,
          hasAuthToken: Boolean(authToken) || keepStoredToken,
        },
      }
      if (authToken) submission.authToken = authToken
      return submission
    }

    const meta = getStudioEngineMeta(driver)
    const host = hostInp.value.trim() || 'localhost'
    const parsedPort = Number.parseInt(portInp.value.trim(), 10)
    const port =
      Number.isFinite(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
        ? parsedPort
        : meta.defaultPort
    const user = userInp.value.trim()
    const password = passwordInp.value
    const ssl = sslCheck.input.checked
    const keepStoredPassword = sameDriverAsStored && hadPassword

    const profile: ConnectionProfile = {
      id,
      name: name || `${driver}@${host}`,
      driver,
      database:
        driver === 'redis'
          ? String(Number.parseInt(redisDbSel.value || '0', 10) || 0)
          : databaseInp.value.trim() || meta.defaultDb,
      host,
      port,
      ssl,
      readOnly,
      colorTag,
      hasPassword: Boolean(password) || keepStoredPassword,
    }
    if (user) profile.user = user
    if (driver === 'redis') {
      const rdb = Number.parseInt(redisDbSel.value || '0', 10)
      profile.redisDb = Number.isFinite(rdb) && rdb >= 0 && rdb <= 15 ? rdb : 0
    }
    if (driver === 'postgres' || driver === 'cockroachdb') {
      const pgOptions = optionsInp.value.trim()
      if (pgOptions) profile.options = pgOptions
    }
    if (driver === 'clickhouse') {
      const chUrl = chUrlInp.value.trim()
      if (chUrl) {
        profile.url = chUrl
        try {
          const parsedCh = new URL(chUrl)
          if (parsedCh.hostname) profile.host = parsedCh.hostname
          if (parsedCh.port) {
            const chPort = Number.parseInt(parsedCh.port, 10)
            if (Number.isFinite(chPort) && chPort >= 1 && chPort <= 65535) profile.port = chPort
          } else if (parsedCh.protocol === 'https:') {
            profile.port = 8443
          } else if (parsedCh.protocol === 'http:') {
            profile.port = 8123
          }
          if (parsedCh.protocol === 'https:') profile.ssl = true
          else if (parsedCh.protocol === 'http:') profile.ssl = false
        } catch {
          // Keep the typed URL verbatim when it is not a valid absolute URL
        }
      } else {
        profile.url = `${ssl ? 'https' : 'http'}://${host}:${port}`
      }
    }
    const submission: ConnectionSubmission = { profile }
    if (password) submission.password = password
    return submission
  }

  // ---- URI parsing ----
  const parseUri = async (rawUri: string, clearMissingSecret = false): Promise<boolean> => {
    const uri = rawUri.trim()
    if (!uri) return false
    const seq = ++parseSeq
    setButtonLoading(parseBtn, true, 'Parsing...')
    try {
      const res = await ctx.requestPlugin<ParseUriResponse>('connection.parseUri', { uri })
      if (seq !== parseSeq || !isModalOpen()) return false
      if (!res.ok || !res.profile) {
        showNotice('error', res.error || 'Could not parse connection URI.')
        return false
      }
      const p = res.profile
      const nextDriver: DatabaseDriverType = isKnownConnectionDriver(p.driver) ? p.driver : 'sqlite'
      const prevDriver = driver
      const prevHost = hostInp.value.trim().toLowerCase()
      const prevUser = userInp.value.trim()
      const prevLibsqlUrl = libsqlUrlInp.value.trim().toLowerCase()
      const nextHost = String(p.host ?? '').trim().toLowerCase()
      const nextUser = String(p.user ?? '').trim()
      const nextLibsqlUrl = String(p.url ?? '').trim().toLowerCase()
      const targetChanged =
        nextDriver !== prevDriver ||
        (nextDriver === 'libsql'
          ? nextLibsqlUrl !== prevLibsqlUrl
          : nextDriver !== 'sqlite' && (nextHost !== prevHost || nextUser !== prevUser))

      // A manually parsed URI defines a fresh target: never inherit another target's stored secret
      const dropStored = clearMissingSecret || (isEdit && targetChanged)
      if (dropStored || res.password !== undefined || res.placeholderPassword) hadPassword = false
      if (dropStored || res.authToken !== undefined) hadAuthToken = false
      const nextPassword =
        res.password !== undefined ? res.password : dropStored ? '' : passwordInp.value
      const nextAuthToken =
        res.authToken !== undefined ? res.authToken : dropStored ? '' : authTokenInp.value

      filePathInp.value = ''
      libsqlUrlInp.value = ''
      authTokenInp.value = ''
      libsqlDbInp.value = ''
      hostInp.value = 'localhost'
      portInp.value = ''
      databaseInp.value = ''
      chUrlInp.value = ''
      optionsInp.value = ''
      redisDbSel.value = '0'
      passwordInp.value = ''
      applyDriver(nextDriver, true)
      if (p.name) nameInp.value = p.name
      if (p.readOnly !== undefined) roCheck.input.checked = Boolean(p.readOnly)
      if (nextDriver === 'sqlite') {
        filePathInp.value = p.filePath || ''
      } else if (nextDriver === 'libsql') {
        libsqlUrlInp.value = p.url || ''
        libsqlDbInp.value = p.database || ''
        authTokenInp.value = nextAuthToken
      } else {
        if (p.host) hostInp.value = p.host
        if (p.port) portInp.value = String(p.port)
        if (p.user !== undefined) userInp.value = p.user
        if (p.ssl !== undefined) sslCheck.input.checked = Boolean(p.ssl)
        if (nextDriver === 'redis') {
          redisDbSel.value = String(p.redisDb ?? 0)
        } else if (p.database !== undefined) {
          databaseInp.value = p.database
        }
        if (nextDriver === 'clickhouse' && p.url) chUrlInp.value = p.url
        if (
          (nextDriver === 'postgres' || nextDriver === 'cockroachdb') &&
          typeof p.options === 'string' &&
          p.options.trim()
        ) {
          optionsInp.value = p.options.trim()
        }
        passwordInp.value = nextPassword
      }
      authTokenInp.placeholder =
        hadAuthToken && isEdit ? 'Stored token preserved (type to replace)' : 'Optional Bearer token'
      lastParsedUri = uri
      lastParsedPlaceholder = Boolean(res.placeholderPassword)
      placeholderPending = lastParsedPlaceholder && !passwordInp.value
      const engineLabelText = getStudioEngineMeta(nextDriver).label
      if (placeholderPending) {
        passwordInp.placeholder = 'Required (replace placeholder password)'
        showNotice(
          'error',
          `Parsed ${engineLabelText} URI — placeholder password was removed. Enter your actual Database Password below before testing.`
        )
        passwordInp.focus?.()
      } else {
        passwordInp.placeholder =
          hadPassword && isEdit ? 'Stored password preserved (type to replace)' : 'Optional'
        showNotice('success', `Parsed ${engineLabelText} URI`)
      }
      return true
    } catch (err: unknown) {
      if (seq !== parseSeq || !isModalOpen()) return false
      showNotice('error', `URI error: ${err instanceof Error ? err.message : String(err)}`)
      return false
    } finally {
      if (seq === parseSeq) {
        setButtonLoading(parseBtn, false)
        if (isBusy) parseBtn.disabled = true
      }
    }
  }

  const ensureUriParsed = async (): Promise<boolean> => {
    const raw = uriInp.value.trim()
    if (!raw || raw === lastParsedUri) return true
    return await parseUri(raw, false)
  }

  const validateRequiredFields = (): boolean => {
    if (driver === 'sqlite' && !filePathInp.value.trim()) {
      showNotice('error', 'Please enter a SQLite database file path.')
      return false
    }
    if (driver === 'libsql' && !libsqlUrlInp.value.trim()) {
      showNotice('error', 'Please enter a LibSQL / Turso URL.')
      return false
    }
    return true
  }

  const ensurePasswordBeforeSubmit = (): boolean => {
    if (driver === 'sqlite' || driver === 'libsql') return true
    const typed = passwordInp.value
    if (placeholderPending && !typed) {
      showNotice(
        'error',
        'Database Password is required — replace placeholder text like [YOUR-PASSWORD] by typing your actual Database Password.'
      )
      passwordInp.focus?.()
      return false
    }
    const keepStored = isEdit && editProfile?.driver === driver && hadPassword
    if (
      !typed &&
      !keepStored &&
      (driver === 'postgres' || driver === 'cockroachdb') &&
      /\.supabase\.(?:co|com)$/i.test(hostInp.value.trim())
    ) {
      showNotice(
        'error',
        'Database Password is required for Supabase PostgreSQL (Project Settings -> Database -> Database password, not your Supabase account login password).'
      )
      passwordInp.focus?.()
      return false
    }
    return true
  }

  // ---- Workspace discovery ----
  const detectWorkspace = async (folderPath: string, manual: boolean): Promise<void> => {
    const seq = ++detectSeq
    const activeBtn = folderPath ? scanBtn : detectBtn
    setButtonLoading(activeBtn, true, 'Scanning...')
    try {
      const folder = folderPath.trim()
      const [wsRes, folderRes] = await Promise.all([
        ctx.requestPlugin<WorkspaceDetectResponse>(
          'workspace.detectConnections',
          folder ? { folderPath: folder } : {}
        ),
        folder
          ? ctx
              .requestPlugin<{ files?: DiscoveredSqliteFile[] }>('sqlite.scanFolder', {
                folderPath: folder,
              })
              .catch(() => null)
          : Promise.resolve(null),
      ])
      if (seq !== detectSeq || !isModalOpen()) return
      discoveredEnvs = Array.isArray(wsRes?.envConnections) ? wsRes.envConnections : []
      const wsFiles = Array.isArray(wsRes?.sqliteFiles) ? wsRes.sqliteFiles : []
      const extraFiles = Array.isArray(folderRes?.files) ? folderRes.files : []
      const seen = new Set<string>()
      discoveredFiles = []
      for (const f of [...extraFiles, ...wsFiles]) {
        if (f?.filePath && !seen.has(f.filePath)) {
          seen.add(f.filePath)
          discoveredFiles.push(f)
        }
      }
      if (manual && discoveredEnvs.length === 0 && discoveredFiles.length === 0) {
        showNotice('neutral', 'No .env connections or SQLite database files found.')
      }
    } catch (err: unknown) {
      if (seq !== detectSeq || !isModalOpen()) return
      discoveredEnvs = []
      discoveredFiles = []
      if (manual) {
        showNotice(
          'error',
          `Workspace discovery failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    } finally {
      if (seq === detectSeq) {
        setButtonLoading(activeBtn, false)
        if (isBusy) activeBtn.disabled = true
      }
    }
    if (isModalOpen()) renderDiscovered()
  }

  // ---- Actions ----
  const runTest = async (): Promise<void> => {
    if (isBusy) return
    setBusy(true)
    setButtonLoading(testBtn, true, 'Testing... 0.0s')
    const stopTimer = ctx.createElapsedTimer((elapsed) => {
      setButtonLoading(testBtn, true, `Testing... ${elapsed}`)
    })
    try {
      if (!(await ensureUriParsed())) return
      if (!validateRequiredFields() || !ensurePasswordBeforeSubmit()) return
      showNotice('neutral', 'Testing connection...')
      const sub = buildSubmission(editId || `conn_test_${Date.now()}`)
      const res = await ctx.requestPlugin<{ ok: boolean; message?: string }>(
        'connection.test',
        sub,
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
      )
      showNotice(
        res.ok ? 'success' : 'error',
        res.message ||
          (res.ok ? 'Connection verified successfully!' : 'Connection test failed.')
      )
    } catch (err: unknown) {
      showNotice('error', `Error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      stopTimer()
      setButtonLoading(testBtn, false)
      setBusy(false)
    }
  }

  const runSave = async (): Promise<void> => {
    if (isBusy) return
    setBusy(true)
    let phase = 'Testing...'
    setButtonLoading(saveBtn, true, 'Testing... 0.0s')
    const stopTimer = ctx.createElapsedTimer((elapsed) => {
      setButtonLoading(saveBtn, true, `${phase} ${elapsed}`)
    })
    let savedId = ''
    try {
      if (!(await ensureUriParsed())) return
      if (!validateRequiredFields()) return
      const targetId = editId || `conn_${driver}_${Date.now()}`
      if (!ensurePasswordBeforeSubmit()) return
      showNotice('neutral', 'Verifying & saving connection...')
      const sub = buildSubmission(targetId)
      try {
        const testRes = await ctx.requestPlugin<{ ok: boolean; message?: string }>(
          'connection.test',
          sub,
          { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
        )
        if (!testRes.ok) {
          showNotice('error', testRes.message || 'Connection test failed.')
          return
        }
      } catch (testErr: unknown) {
        showNotice(
          'error',
          `Connection failed: ${testErr instanceof Error ? testErr.message : String(testErr)}`
        )
        return
      }
      phase = 'Saving...'
      const res = await ctx.requestPlugin<{ ok: boolean; id: string }>(
        'connection.save',
        sub,
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
      )
      if (!res.ok) {
        showNotice('error', 'Failed to save connection.')
        return
      }
      savedId = res.id || targetId
    } catch (err: unknown) {
      showNotice('error', `Error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      stopTimer()
      setButtonLoading(saveBtn, false)
      setBusy(false)
    }
    if (!savedId) return
    if (isModalOpen()) ctx.closeModal()
    ctx.updateStatus(`Connected to ${nameInp.value.trim() || savedId}`)
    await ctx.activateSavedConnection(savedId)
  }

  const runDelete = async (): Promise<void> => {
    if (isBusy || !isEdit) return
    if (!deleteArmed) {
      deleteArmed = true
      deleteBtn.textContent = 'Confirm Delete?'
      if (deleteTimer !== null) clearTimeout(deleteTimer)
      deleteTimer = setTimeout(() => {
        deleteArmed = false
        deleteTimer = null
        deleteBtn.textContent = 'Delete Connection'
      }, 4000)
      return
    }
    if (deleteTimer !== null) {
      clearTimeout(deleteTimer)
      deleteTimer = null
    }
    deleteArmed = false
    setBusy(true)
    setButtonLoading(deleteBtn, true, 'Deleting...')
    let deleted = false
    try {
      const res = await ctx.requestPlugin<{ ok: boolean }>('connection.delete', { id: editId })
      if (!res.ok) {
        showNotice('error', 'Failed to delete connection.')
        return
      }
      deleted = true
    } catch (err: unknown) {
      showNotice('error', `Delete failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setButtonLoading(deleteBtn, false)
      setBusy(false)
    }
    if (!deleted) return
    if (isModalOpen()) ctx.closeModal()
    await ctx.onConnectionDeleted(editId)
  }

  parseBtn.addEventListener('click', () => {
    if (isBusy) return
    if (!uriInp.value.trim()) {
      showNotice('error', 'Paste a connection URI first.')
      return
    }
    void parseUri(uriInp.value, false)
  })
  uriInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!isBusy && uriInp.value.trim()) void parseUri(uriInp.value, false)
    }
  })
  detectBtn.addEventListener('click', () => {
    if (!isBusy) void detectWorkspace('', true)
  })
  scanBtn.addEventListener('click', () => {
    if (isBusy) return
    if (!folderInp.value.trim()) {
      showNotice('error', 'Enter a folder path to scan.')
      return
    }
    void detectWorkspace(folderInp.value, true)
  })
  folderInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      scanBtn.click()
    }
  })
  nameInp.addEventListener('input', () => {
    lastAutoName = ''
  })
  passwordInp.addEventListener('input', () => {
    placeholderPending = lastParsedPlaceholder && !passwordInp.value
    passwordInp.placeholder = placeholderPending
      ? 'Required (replace placeholder password)'
      : hadPassword && isEdit
        ? 'Stored password preserved (type to replace)'
        : 'Optional'
  })
  testBtn.addEventListener('click', () => {
    void runTest()
  })
  saveBtn.addEventListener('click', () => {
    void runSave()
  })
  deleteBtn.addEventListener('click', () => {
    void runDelete()
  })
  cancelBtn.addEventListener('click', () => {
    if (!isBusy) ctx.closeModal()
  })

  // ---- Initial population ----
  if (editProfile) {
    nameInp.value = editProfile.name || ''
    const meta = getStudioEngineMeta(driver)
    if (driver === 'sqlite') {
      filePathInp.value = editProfile.filePath || editProfile.database || ''
    } else if (driver === 'libsql') {
      libsqlUrlInp.value = editProfile.url || ''
      libsqlDbInp.value = editProfile.database || ''
      if (hadAuthToken) authTokenInp.placeholder = 'Stored token preserved (type to replace)'
    } else {
      hostInp.value = editProfile.host || 'localhost'
      portInp.value = String(editProfile.port || meta.defaultPort)
      userInp.value = editProfile.user || ''
      sslCheck.input.checked = Boolean(editProfile.ssl)
      if (driver === 'redis') {
        redisDbSel.value = String(editProfile.redisDb ?? 0)
      } else {
        databaseInp.value = editProfile.database || ''
      }
      if (driver === 'clickhouse') chUrlInp.value = editProfile.url || ''
      if (typeof editProfile.options === 'string') optionsInp.value = editProfile.options
      if (hadPassword) passwordInp.placeholder = 'Stored password preserved (type to replace)'
    }
    applyDriver(driver, false)
  } else {
    hostInp.value = 'localhost'
    applyDriver(driver, true)
  }
  syncEnvPills()

  modal.appendChild(head)
  modal.appendChild(body)
  modal.appendChild(actions)
  backdropRef = ctx.mountModal(modal, () => !isBusy)
  if (!backdropRef) return
  if (isEdit) {
    nameInp.focus?.()
    nameInp.select?.()
  } else {
    uriInp.focus?.()
    void detectWorkspace('', false)
  }
}
