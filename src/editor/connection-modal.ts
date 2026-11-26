// src/editor/connection-modal.ts
// Fullscreen Studio 9-Engine Connection Manager Modal (URI parser, .env & .db workspace scanner, test/save/delete)

import type {
  ConnectionAiPolicy,
  ConnectionColorTag,
  ConnectionProfile,
  DatabaseDriverType,
  DiscoveredDockerComposeConnection,
  DriverInspectResult,
  DriverRegistryItem,
} from '../protocol.js'
import {
  BYOD_ENGINES,
  CONNECTION_ENV_TAGS,
  STUDIO_ENGINES,
  closeActiveStudioCollapsibleDropdown,
  copyTextFallback,
  createDbLogoSvg,
  createFolderIconSvg,
  enhanceStudioCollapsibleSelect,
  getStudioEngineMeta,
  isByodConnectionDriver,
  isKnownConnectionDriver,
  setButtonLoading,
  syncStudioSelectTooltip,
} from './db-icons.js'
import {
  buildByodInstallCommand,
  getByodNpmPackage,
  getByodStarterTemplate,
} from './driver-manager-modal.js'
import { openStudioFilePickerModal } from './file-picker-modal.js'

import { DEFAULT_RPC_TIMEOUT_MS } from '../shared-constants.js'
import {
  findCredentialAuthorityAtIndex,
  isCloudDatabaseHost,
  maskConnectionUriSecret as sharedMaskConnectionUriSecret,
} from '../shared-sql-safety.js'

export function maskUriSecret(rawUri: string): string {
  return sharedMaskConnectionUriSecret(rawUri)
}

export const maskConnectionUriSecret = maskUriSecret

const SENSITIVE_LIBSQL_QUERY_PARAM_RE =
  /^(?:api[-_]?key|apikey|auth[-_]?token|authtoken|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|private[-_]?key|credentials?|authorization|sig(?:nature)?|token|pass(?:word|wd|phrase)?|pwd|secret|key|jwt|bearer)$/i

const FALLBACK_SECRET_QUERY_KV_RE =
  /([?&#])(?:[^=&\s#]*(?:api[-_]?key|apikey|auth[-_]?token|authtoken|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|private[-_]?key|token|jwt|secret|pass(?:word|wd|phrase)?|pwd|bearer|credentials?|authorization|key)|sig(?:nature)?)=[^&\s#]*/gi

function stripEmbeddedSchemeCredentials(raw: string): string {
  return raw.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s'"<>(),;]+)/g,
    (full, scheme: string, rest: string) => {
      const delimIdx = rest.search(/[:/?#@]/)
      if (delimIdx < 0 || rest[delimIdx] !== ':') return full
      const atIdx = findCredentialAuthorityAtIndex(scheme, rest, delimIdx)
      return atIdx > 0 ? `${scheme}${rest.slice(atIdx + 1)}` : full
    }
  )
}

function scrubFallbackSecretUrlText(raw: string): string {
  return stripEmbeddedSchemeCredentials(raw)
    .replace(FALLBACK_SECRET_QUERY_KV_RE, '$1')
    .replace(/\?&+/g, '?')
    .replace(/#&+/g, '#')
    .replace(/[?&]+#/g, '#')
    .replace(/&{2,}/g, '&')
    .replace(/[?&#]+(?=$|\s)/g, '')
}

function scrubParsedUrlSecrets(parsed: URL): void {
  parsed.username = ''
  parsed.password = ''
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (SENSITIVE_LIBSQL_QUERY_PARAM_RE.test(key)) {
      parsed.searchParams.delete(key)
    }
  }
  if (parsed.hash.length > 1) {
    const rawFrag = parsed.hash.slice(1)
    const qIdx = rawFrag.indexOf('?')
    const cleanPairs = (seg: string): string =>
      seg
        .split('&')
        .filter((pair) => {
          const eqIdx = pair.indexOf('=')
          if (eqIdx <= 0) return true
          const rawKey = pair.slice(0, eqIdx).trim()
          let decodedKey = rawKey
          try {
            decodedKey = decodeURIComponent(rawKey)
          } catch {
            // Keep rawKey when percent-decoding fails
          }
          return !(
            SENSITIVE_LIBSQL_QUERY_PARAM_RE.test(rawKey) ||
            SENSITIVE_LIBSQL_QUERY_PARAM_RE.test(decodedKey)
          )
        })
        .join('&')
    const cleaned =
      qIdx >= 0
        ? (() => {
            const pfx = cleanPairs(rawFrag.slice(0, qIdx))
            const tail = cleanPairs(rawFrag.slice(qIdx + 1))
            return tail ? `${pfx}?${tail}` : pfx
          })()
        : cleanPairs(rawFrag)
    parsed.hash = cleaned ? `#${cleaned}` : ''
  }
}

function parseNetworkUrlSafely(rawWithScheme: string): URL | null {
  try {
    const direct = new URL(rawWithScheme)
    if (direct.username === '' && direct.password === '' && direct.port !== '') {
      const recovered = stripEmbeddedSchemeCredentials(rawWithScheme)
      if (recovered !== rawWithScheme) {
        return new URL(recovered)
      }
    }
    return direct
  } catch {
    return null
  }
}

function sanitizeLibsqlFormUrlAndName(rawUrl: string): { cleanUrl: string; defaultName: string } {
  const trimmed = rawUrl.trim()
  if (!trimmed) return { cleanUrl: '', defaultName: 'LibSQL' }
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
  const parsed = parseNetworkUrlSafely(withScheme)
  if (!parsed) {
    return { cleanUrl: scrubFallbackSecretUrlText(trimmed), defaultName: 'LibSQL' }
  }
  const hostname = parsed.hostname || 'LibSQL'
  scrubParsedUrlSecrets(parsed)
  const cleanPath =
    parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : ''
  const cleanSearch = parsed.searchParams.toString()
  const cleanUrl = `${parsed.protocol}//${parsed.host}${cleanPath}${cleanSearch ? `?${cleanSearch}` : ''}`
  return { cleanUrl, defaultName: hostname }
}

function scrubStudioNetworkFormUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) return ''
  const parsed = parseNetworkUrlSafely(trimmed)
  if (!parsed) {
    return scrubFallbackSecretUrlText(trimmed)
  }
  scrubParsedUrlSecrets(parsed)
  return parsed.toString()
}

const STUDIO_OPTIONS_DRIVERS: ReadonlySet<string> = new Set([
  'postgres',
  'cockroachdb',
  'snowflake',
  'bigquery',
  'cassandra',
])

const STUDIO_FILE_DB_DRIVERS: ReadonlySet<string> = new Set(['sqlite', 'duckdb'])

function isStudioOptionsDriver(d: string): boolean {
  return STUDIO_OPTIONS_DRIVERS.has(d)
}

function isStudioFileDbDriver(d: string): boolean {
  return STUDIO_FILE_DB_DRIVERS.has(d)
}

function extractScannedFolderName(rawPath: string): string {
  const trimmed = String(rawPath || '').trim().replace(/[\\/]+$/, '')
  if (!trimmed) return String(rawPath || '').trim()
  const parts = trimmed.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || trimmed
}

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
  sslKeyPassphrase?: string
  sshPassphrase?: string
  sshPassword?: string
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
  candidateId?: string
  envKey: string
  sourceFile: string
  driver: DatabaseDriverType
  name: string
  uri: string
}

export interface WorkspaceDetectResponse {
  sqliteFiles?: DiscoveredSqliteFile[]
  envConnections?: DiscoveredEnvConnection[]
  dockerComposeConnections?: DiscoveredDockerComposeConnection[]
  scannedDirs?: string[]
  folderScoped?: boolean
  dockerIsLocal?: boolean
  dockerScopeLabel?: string
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
  /** Active Orca workspace / document scope key used by the "Pin to current workspace" toggle. */
  currentWorkspaceScope?: string
}

export interface OpenConnectionModalOptions {
  focusSection?: 'tls' | 'ai'
}

export function openStudioConnectionModal(
  ctx: StudioConnectionModalContext,
  editProfile?: ConnectionProfile,
  options?: OpenConnectionModalOptions
): void {
  if (typeof document === 'undefined') return
  const isEdit = editProfile !== undefined
  const editId = editProfile?.id ?? ''

  let driver: DatabaseDriverType = editProfile ? editProfile.driver : 'sqlite'
  if (!isKnownConnectionDriver(driver)) driver = 'sqlite'
  const rawTag = String(editProfile?.colorTag ?? 'none').trim().toLowerCase()
  let colorTag: ConnectionColorTag =
    rawTag === 'production'
      ? 'prod'
      : rawTag === 'dev' || rawTag === 'staging' || rawTag === 'prod'
        ? rawTag
        : 'none'
  let hadPassword = Boolean(editProfile?.hasPassword)
  let hadAuthToken = Boolean(editProfile?.hasAuthToken)
  let hadSslKeyPassphrase = Boolean(editProfile?.hasSslKeyPassphrase)
  let hadSshPassphrase = Boolean(editProfile?.hasSshPassphrase)
  let hadSshPassword = Boolean(editProfile?.hasSshPassword)
  let lastParsedUri = ''
  let lastParsedDisplayUri = ''
  let lastParsedCandidateId = ''
  let activeAutoCandidateId: string | null = null
  let activeAutoRawUri: string | null = null
  let activeAutoDisplayUri: string | null = null
  let dockerApplySeq = 0
  const clearActiveAutoUri = (): void => {
    activeAutoCandidateId = null
    activeAutoRawUri = null
    activeAutoDisplayUri = null
  }
  let lastOracleParsedUrl =
    editProfile?.driver === 'oracle' && typeof editProfile.url === 'string'
      ? scrubStudioNetworkFormUrl(editProfile.url)
      : ''
  let lastParsedPlaceholder = false
  let placeholderPending = false
  let lastAutoName = ''
  let isBusy = false
  let parseSeq = 0
  let detectSeq = 0
  let discoveredEnvs: DiscoveredEnvConnection[] = []
  let discoveredDocker: DiscoveredDockerComposeConnection[] = []
  let discoveredFiles: DiscoveredSqliteFile[] = []
  let discoveredDockerScopeLabel = 'Local Docker'
  let discoveredSearch = ''
  const discoveryCollapsed: Record<'env' | 'docker' | 'sqlite', boolean | null> = {
    env: null,
    docker: null,
    sqlite: null,
  }
  let deleteArmed = false
  let deleteTimer: ReturnType<typeof setTimeout> | null = null
  const clearDeleteTimer = (): void => {
    if (deleteTimer !== null) {
      clearTimeout(deleteTimer)
      deleteTimer = null
    }
    deleteArmed = false
  }
  let backdropRef: HTMLDivElement | null = null
  const isModalOpen = (): boolean => ctx.isBackdropActive(backdropRef)
  const closeModalClean = (): void => {
    clearDeleteTimer()
    closeActiveStudioCollapsibleDropdown()
    ctx.closeModal()
  }

  const createInput = (placeholder: string, mono = false): HTMLInputElement => {
    const el = document.createElement('input')
    el.type = 'text'
    el.className = `datanoa-conn-input${mono ? ' is-mono' : ''}`
    el.placeholder = placeholder
    el.setAttribute('autocomplete', 'off')
    el.spellcheck = false
    return el
  }

  let fieldSeq = 0
  const createField = (
    labelText: string,
    control: HTMLElement,
    full = false,
    labelTarget?: HTMLElement
  ): HTMLDivElement => {
    const wrap = document.createElement('div')
    wrap.className = `datanoa-conn-field${full ? ' is-full' : ''}`
    const targetEl =
      labelTarget ??
      (control.tagName === 'INPUT' ||
      control.tagName === 'SELECT' ||
      control.tagName === 'TEXTAREA'
        ? control
        : null)
    const isCheckWrapper = control.classList.contains('datanoa-conn-check')
    const useLabel = !isCheckWrapper && targetEl !== null
    const label = document.createElement(useLabel ? 'label' : 'span')
    if (useLabel && targetEl) {
      const id = targetEl.id || `datanoa-conn-field-${++fieldSeq}`
      targetEl.id = id
      label.setAttribute('for', id)
    }
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

  const createSelect = (options: Array<{ value: string; label: string }>): HTMLSelectElement => {
    const sel = document.createElement('select')
    sel.className = 'datanoa-conn-select'
    for (const item of options) {
      const opt = document.createElement('option')
      opt.value = item.value
      opt.textContent = item.label
      sel.appendChild(opt)
    }
    return sel
  }

  let collapsibleSeq = 0
  const createCollapsible = (
    titleText: string
  ): {
    root: HTMLDivElement
    head: HTMLButtonElement
    bodyEl: HTMLDivElement
    setExpanded: (expanded: boolean) => void
    sync: (activeLabel: string | null) => void
  } => {
    const root = document.createElement('div')
    root.className = 'datanoa-conn-collapsible'
    const head = document.createElement('button')
    head.type = 'button'
    head.className = 'datanoa-conn-collapsible-head'
    const chevron = document.createElement('span')
    chevron.className = 'datanoa-conn-chevron'
    chevron.textContent = '\u25b8'
    chevron.setAttribute('aria-hidden', 'true')
    const title = document.createElement('span')
    title.className = 'datanoa-conn-collapsible-title'
    title.textContent = titleText
    const pill = document.createElement('span')
    pill.className = 'datanoa-conn-collapsible-pill'
    const bodyEl = document.createElement('div')
    bodyEl.className = 'datanoa-conn-collapsible-body'
    collapsibleSeq += 1
    bodyEl.id = `datanoa-conn-collapsible-body-${collapsibleSeq}`
    head.setAttribute('aria-controls', bodyEl.id)
    head.appendChild(chevron)
    head.appendChild(title)
    head.appendChild(pill)
    root.appendChild(head)
    root.appendChild(bodyEl)
    let expanded = false
    const setExpanded = (next: boolean): void => {
      expanded = next
      root.classList.toggle('is-expanded', next)
      head.setAttribute('aria-expanded', next ? 'true' : 'false')
      showEl(bodyEl, next)
    }
    const sync = (activeLabel: string | null): void => {
      pill.textContent = activeLabel ?? ''
      showEl(pill, Boolean(activeLabel))
    }
    head.addEventListener('click', () => {
      if (isBusy) return
      setExpanded(!expanded)
    })
    setExpanded(false)
    return { root, head, bodyEl, setExpanded, sync }
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
  noticeBox.className = 'datanoa-modal-box is-pinned'
  noticeBox.style.display = 'none'
  noticeBox.setAttribute('role', 'status')
  const showNotice = (kind: 'error' | 'warn' | 'success' | 'neutral', text: string): void => {
    noticeBox.className = `datanoa-modal-box is-pinned${kind === 'neutral' ? '' : ` ${kind}`}`
    noticeBox.setAttribute('role', kind === 'error' ? 'alert' : 'status')
    noticeBox.textContent = text
    noticeBox.style.display = 'block'
  }

  // ---- Quick URI bar ----
  const uriBar = document.createElement('div')
  uriBar.className = 'datanoa-conn-uri-bar'
  const uriLabel = document.createElement('div')
  uriLabel.className = 'datanoa-conn-section-label'
  uriLabel.textContent = 'Quick Connect (Paste URI)'
  const uriRow = document.createElement('div')
  uriRow.className = 'datanoa-conn-row'
  const uriInp = createInput(
    'Paste connection URI (postgres://, mysql://, mssql://, mongodb://, redis://, libsql://, sqlite://)...',
    true
  )
  uriInp.setAttribute('aria-label', 'Paste connection URI')
  uriInp.classList.add('datanoa-conn-uri-input')
  const parseBtn = createButton('Parse URI')
  uriRow.appendChild(uriInp)
  uriRow.appendChild(parseBtn)
  uriBar.appendChild(uriLabel)
  uriBar.appendChild(uriRow)
  body.appendChild(uriBar)

  // ---- Workspace Auto-Detect controls (appended at bottom of modal body) ----
  const discoverySection = document.createElement('div')
  discoverySection.className = 'datanoa-conn-uri-bar'
  discoverySection.style.marginTop = '8px'
  const discoveryLabel = document.createElement('div')
  discoveryLabel.className = 'datanoa-conn-section-label'
  discoveryLabel.textContent = 'Local Workspace & Docker Auto-Discovery (.env, Docker Compose & .db)'
  const discoveryScopeNote = document.createElement('div')
  discoveryScopeNote.className = 'datanoa-conn-hint'
  discoveryScopeNote.style.marginBottom = '4px'
  discoveryScopeNote.textContent =
    'Scans local workspace folders for .env / .db files · Plus local Docker containers (non-workspace labeled "Other Local Docker").'
  const detectRow = document.createElement('div')
  detectRow.className = 'datanoa-conn-row is-wrap'
  const quickBrowseDbBtn = createButton('Browse DB File...')
  quickBrowseDbBtn.title = 'Browse and pick a local SQLite database file (.db, .sqlite, .sqlite3)'
  const detectBtn = createButton('Auto-Detect (.env, Docker, .db)')
  detectBtn.title =
    'Scan current workspace folder(s) for .env & .db files plus local Docker Compose containers'
  const folderInp = createInput('Optional folder path to scan...', true)
  folderInp.setAttribute('aria-label', 'Folder path to scan')
  folderInp.style.flex = '1 1 160px'
  const browseScanFolderBtn = createButton('Browse Folder...')
  const scanBtn = createButton('Scan Folder')
  browseScanFolderBtn.addEventListener('click', () => {
    if (isBusy) return
    void openStudioFilePickerModal(ctx, {
      title: 'Select folder to scan',
      mode: 'folder',
      initialDir: folderInp.value.trim() || undefined,
    })
      .then((res) => {
        if (!isModalOpen()) return
        if (res?.ok && res.path) {
          folderInp.value = res.path
          void detectWorkspace(res.path, true)
        }
      })
      .catch(() => {})
  })
  detectRow.appendChild(quickBrowseDbBtn)
  detectRow.appendChild(detectBtn)
  detectRow.appendChild(folderInp)
  detectRow.appendChild(browseScanFolderBtn)
  detectRow.appendChild(scanBtn)
  const discoveredBox = document.createElement('div')
  discoveredBox.className = 'datanoa-conn-discovered'
  discoveredBox.style.display = 'none'
  discoverySection.appendChild(discoveryLabel)
  discoverySection.appendChild(discoveryScopeNote)
  discoverySection.appendChild(detectRow)
  discoverySection.appendChild(discoveredBox)

  // ---- Engine grid ----
  const engineLabel = document.createElement('div')
  engineLabel.className = 'datanoa-conn-section-label'
  engineLabel.textContent = 'Built-in Database Engines'
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

  const byodEngineLabel = document.createElement('div')
  byodEngineLabel.className = 'datanoa-conn-section-label'
  byodEngineLabel.textContent = 'Local Custom Drivers (BYOD)'
  const byodEngineGrid = document.createElement('div')
  byodEngineGrid.className = 'datanoa-engine-grid'
  const byodRegistryStatus = new Map<string, DriverRegistryItem>()
  const byodDefaultFolders = new Map<string, string>([
    ['duckdb', 'C:\\datanoa-drivers\\duckdb'],
    ['snowflake', 'C:\\datanoa-drivers\\snowflake'],
    ['bigquery', 'C:\\datanoa-drivers\\bigquery'],
    ['cassandra', 'C:\\datanoa-drivers\\cassandra'],
    ['elasticsearch', 'C:\\datanoa-drivers\\elasticsearch'],
    ['neo4j', 'C:\\datanoa-drivers\\neo4j'],
    ['custom', 'C:\\datanoa-drivers\\custom'],
  ])
  let byodHostPlatform = 'win32'
  const byodCustomFolderInputs = new Map<string, string>()
  const byodPendingInspects = new Map<string, { rawPath: string; result: DriverInspectResult }>()

  // Inline BYOD Driver Setup Card rendered directly inside the selected BYOD SQL page
  const byodStatusBanner = document.createElement('div')
  byodStatusBanner.className = 'datanoa-driver-mgr-byod'
  byodStatusBanner.style.display = 'none'
  byodStatusBanner.style.marginTop = '8px'

  let byodRefreshSeq = 0

  const refreshByodRegistry = async (): Promise<void> => {
    const seq = ++byodRefreshSeq
    try {
      const [listRes, defaultsRes] = await Promise.all([
        ctx.requestPlugin<{ drivers?: DriverRegistryItem[] } | DriverRegistryItem[]>('drivers.list'),
        ctx
          .requestPlugin<{ platform?: string; paths?: Record<string, string> }>('drivers.defaultPaths')
          .catch(() => null),
      ])
      if (!isModalOpen() || seq !== byodRefreshSeq) return
      if (defaultsRes?.platform) byodHostPlatform = defaultsRes.platform
      if (defaultsRes?.paths) {
        for (const [k, v] of Object.entries(defaultsRes.paths)) {
          if (typeof v === 'string' && v.trim()) byodDefaultFolders.set(k, v.trim())
        }
      }
      const list = Array.isArray(listRes)
        ? listRes
        : Array.isArray(listRes?.drivers)
          ? listRes.drivers
          : []
      for (const item of list) {
        if (item && typeof item.id === 'string') {
          byodRegistryStatus.set(item.id, item)
        }
      }
      syncByodBanner()
    } catch {
      if (isModalOpen() && seq === byodRefreshSeq) syncByodBanner()
    }
  }

  const syncByodBanner = (): void => {
    if (!isByodConnectionDriver(driver)) {
      byodStatusBanner.style.display = 'none'
      return
    }
    const driverId = String(driver)
    const meta = getStudioEngineMeta(driver)
    const item = byodRegistryStatus.get(driverId)
    const defaultFolder =
      byodCustomFolderInputs.get(driverId) ??
      item?.localPath ??
      byodDefaultFolders.get(driverId) ??
      `C:\\datanoa-drivers\\${driverId}`
    const pendingInspect = byodPendingInspects.get(driverId)
    const isVerified = item?.status === 'local-verified'
    const npmPkg = getByodNpmPackage(driverId)

    byodStatusBanner.innerHTML = ''
    byodStatusBanner.style.display = 'flex'
    byodStatusBanner.style.flexDirection = 'column'
    byodStatusBanner.style.gap = '8px'

    const topRow = document.createElement('div')
    topRow.className = 'datanoa-driver-mgr-byod-head'
    const titleSpan = document.createElement('span')
    titleSpan.className = 'datanoa-driver-mgr-name'
    titleSpan.style.display = 'inline-flex'
    titleSpan.style.alignItems = 'center'
    titleSpan.style.gap = '7px'
    titleSpan.appendChild(createDbLogoSvg(driver))
    const titleTxt = document.createElement('span')
    titleTxt.textContent = `${meta.label} — Local Driver Configuration (BYOD)`
    titleSpan.appendChild(titleTxt)

    const statusPill = document.createElement('span')
    statusPill.className = `datanoa-driver-mgr-pill ${
      isVerified ? 'is-verified' : item?.status === 'local-error' ? 'is-error' : 'is-unconfigured'
    }`
    statusPill.textContent = isVerified
      ? `Verified (${(item?.sha256 || '').slice(0, 10)}…)`
      : item?.status === 'local-error'
        ? 'Needs Re-Trust'
        : 'Not Configured'
    topRow.appendChild(titleSpan)
    topRow.appendChild(statusPill)
    byodStatusBanner.appendChild(topRow)

    const guideDesc = document.createElement('div')
    guideDesc.className = 'datanoa-driver-mgr-meta'
    guideDesc.textContent = isVerified
      ? `Driver is verified and active from "${item?.resolvedEntry || defaultFolder}". You can enter your ${meta.label} host/credentials below and click Test Connection or Save & Connect.`
      : npmPkg
        ? `Choose a local folder for the ${meta.label} adapter, click "Create Folder & Copy Cmd", run the copied npm install command in Orca Terminal, then click "Inspect SHA-256" and "Trust & Verify".`
        : `Choose a local folder for your custom adapter, click "Create Folder & Starter", edit index.mjs if needed, then click "Inspect SHA-256" and "Trust & Verify".`
    byodStatusBanner.appendChild(guideDesc)

    // Folder input + Browse Folder button
    const folderRow = document.createElement('div')
    folderRow.className = 'datanoa-conn-row'
    const folderPathInp = createInput(defaultFolder, true)
    folderPathInp.setAttribute('aria-label', `${meta.label} local driver folder path`)
    folderPathInp.value = defaultFolder
    folderPathInp.style.flex = '1 1 220px'
    const browseDriverDirBtn = createButton('Browse Folder...')
    folderRow.appendChild(folderPathInp)
    folderRow.appendChild(browseDriverDirBtn)
    byodStatusBanner.appendChild(folderRow)

    // Dynamic command preview that updates live whenever folderPathInp changes
    const cmdWrap = document.createElement('div')
    cmdWrap.style.display = 'flex'
    cmdWrap.style.flexDirection = 'column'
    cmdWrap.style.gap = '4px'
    const cmdLabel = document.createElement('div')
    cmdLabel.className = 'datanoa-driver-mgr-meta'
    cmdLabel.textContent = npmPkg
      ? `Terminal setup command (auto-updates with folder path above — installs "${npmPkg}"):`
      : 'Terminal setup command (auto-updates with folder path above):'
    const cmdRow = document.createElement('div')
    cmdRow.className = 'datanoa-conn-row'
    const cmdInp = createInput('', true)
    cmdInp.setAttribute('aria-label', `${meta.label} terminal setup command`)
    cmdInp.readOnly = true
    cmdInp.style.flex = '1 1 220px'
    cmdInp.value = buildByodInstallCommand(driverId, folderPathInp.value, byodHostPlatform)
    const copyCmdBtn = createButton('Copy Command')
    copyCmdBtn.addEventListener('click', () => {
      copyTextFallback(cmdInp.value, copyCmdBtn)
    })
    cmdRow.appendChild(cmdInp)
    cmdRow.appendChild(copyCmdBtn)
    cmdWrap.appendChild(cmdLabel)
    cmdWrap.appendChild(cmdRow)
    byodStatusBanner.appendChild(cmdWrap)

    folderPathInp.addEventListener('input', () => {
      const nextVal = folderPathInp.value.trim()
      byodCustomFolderInputs.set(driverId, nextVal)
      byodPendingInspects.delete(driverId)
      trustBtn.disabled = true
      cmdInp.value = buildByodInstallCommand(driverId, nextVal, byodHostPlatform)
    })

    browseDriverDirBtn.addEventListener('click', () => {
      if (isBusy) return
      void openStudioFilePickerModal(ctx, {
        title: `Select folder for ${meta.label} driver`,
        mode: 'folder',
        initialDir: folderPathInp.value.trim() || undefined,
      })
        .then((res) => {
          if (!isModalOpen()) return
          if (res?.ok && res.path) {
            folderPathInp.value = res.path
            byodCustomFolderInputs.set(driverId, res.path)
            byodPendingInspects.delete(driverId)
            trustBtn.disabled = true
            cmdInp.value = buildByodInstallCommand(driverId, res.path, byodHostPlatform)
          }
        })
        .catch(() => {})
    })

    if (pendingInspect && pendingInspect.result.ok) {
      const inspectBox = document.createElement('div')
      inspectBox.className = 'datanoa-modal-box'
      inspectBox.style.display = 'block'
      inspectBox.textContent = `Inspected: ${pendingInspect.result.resolvedEntry} | SHA-256: ${pendingInspect.result.sha256} — Click "Trust & Verify" below to activate.`
      byodStatusBanner.appendChild(inspectBox)
    }

    // Action buttons row
    const btnRow = document.createElement('div')
    btnRow.className = 'datanoa-conn-row is-wrap'
    const autoSetupBtn = createButton(
      npmPkg ? `Create Folder & Copy Cmd (${npmPkg})` : 'Create Folder & Starter',
      'datanoa-btn-primary'
    )
    const copyStarterBtn = createButton('Copy Starter index.mjs')
    const inspectBtn = createButton('Inspect SHA-256')
    const trustBtn = createButton('Trust & Verify')
    trustBtn.disabled = !pendingInspect?.result.ok

    autoSetupBtn.addEventListener('click', () => {
      if (isBusy) return
      const targetDir = folderPathInp.value.trim() || defaultFolder
      setBusy(true)
      setButtonLoading(autoSetupBtn, true, 'Creating folder...')
      showNotice('neutral', `Creating ${meta.label} driver folder in "${targetDir}"...`)
      void ctx
        .requestPlugin<{
          ok: boolean
          dirPath: string
          inspect: DriverInspectResult
          item?: DriverRegistryItem
          wroteCanonicalEntry?: boolean
          installPackage?: string
        }>(
          'drivers.setupLocal',
          {
            driverId,
            localPath: targetDir,
            autoTrust: true,
          },
          { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
        )
        .then(async (res) => {
          if (!isModalOpen()) return
          if (!res?.ok || !res.inspect?.ok || !res.inspect.sha256) {
            showNotice('error', 'Failed to set up local driver folder.')
            return
          }
          byodCustomFolderInputs.set(driverId, res.dirPath)
          const installCmd = buildByodInstallCommand(driverId, res.dirPath, byodHostPlatform)
          cmdInp.value = installCmd
          if (res.installPackage && res.item?.status !== 'local-verified') {
            copyTextFallback(installCmd)
          }
          if (res.item?.status === 'local-verified') {
            byodPendingInspects.delete(driverId)
            await refreshByodRegistry()
            if (!isModalOpen()) return
            showNotice(
              'success',
              `${meta.label} driver verified in "${res.dirPath}" (SHA-256: ${res.inspect.sha256.slice(0, 12)}…).`
            )
          } else {
            byodPendingInspects.set(driverId, { rawPath: res.dirPath, result: res.inspect })
            await refreshByodRegistry()
            if (!isModalOpen()) return
            showNotice(
              'neutral',
              res.installPackage
                ? `Folder created and install command copied. Run it in Orca Terminal, then click "Trust & Verify" (SHA-256: ${res.inspect.sha256.slice(0, 12)}…).`
                : `Folder created in "${res.dirPath}" (SHA-256: ${res.inspect.sha256.slice(0, 12)}…). Review and click "Trust & Verify" to activate.`
            )
          }
        })
        .catch((err: unknown) => {
          if (!isModalOpen()) return
          showNotice(
            'error',
            `Setup failed: ${err instanceof Error ? err.message : String(err)}`
          )
        })
        .finally(() => {
          setButtonLoading(autoSetupBtn, false)
          setBusy(false)
        })
    })

    copyStarterBtn.addEventListener('click', () => {
      copyTextFallback(getByodStarterTemplate(driverId), copyStarterBtn)
    })

    inspectBtn.addEventListener('click', () => {
      if (isBusy) return
      const targetDir = folderPathInp.value.trim()
      if (!targetDir) {
        showNotice('error', 'Enter or browse a driver folder path first.')
        return
      }
      setBusy(true)
      setButtonLoading(inspectBtn, true, 'Inspecting...')
      void ctx
        .requestPlugin<DriverInspectResult>('drivers.inspectLocal', {
          driverId,
          localPath: targetDir,
        })
        .catch(async (inspectErr: unknown) => {
          const msg = inspectErr instanceof Error ? inspectErr.message : String(inspectErr)
          if (/not found|does not exist|enoent|no (?:driver )?entry|missing/i.test(msg)) {
            const setupRes = await ctx.requestPlugin<{
              ok: boolean
              dirPath: string
              inspect: DriverInspectResult
            }>('drivers.setupLocal', {
              driverId,
              localPath: targetDir,
              autoTrust: false,
            })
            if (setupRes?.ok && setupRes.inspect?.ok) {
              byodCustomFolderInputs.set(driverId, setupRes.dirPath)
              return setupRes.inspect
            }
          }
          throw inspectErr
        })
        .then((res) => {
          if (!isModalOpen()) return
          if (!res?.ok) {
            showNotice('error', 'Failed to inspect driver path.')
            return
          }
          byodPendingInspects.set(driverId, { rawPath: targetDir, result: res })
          syncByodBanner()
          showNotice(
            'neutral',
            `SHA-256: ${res.sha256}. Click "Trust & Verify" to activate ${meta.label}.`
          )
        })
        .catch((err: unknown) => {
          if (!isModalOpen()) return
          showNotice('error', err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          setButtonLoading(inspectBtn, false)
          setBusy(false)
        })
    })

    trustBtn.addEventListener('click', () => {
      if (isBusy) return
      const pending = byodPendingInspects.get(driverId)
      if (!pending?.result.sha256) return
      setBusy(true)
      setButtonLoading(trustBtn, true, 'Verifying...')
      void ctx
        .requestPlugin('drivers.configureLocal', {
          driverId,
          localPath: pending.rawPath,
          trustedSha256: pending.result.sha256,
        })
        .then(async () => {
          if (!isModalOpen()) return
          byodPendingInspects.delete(driverId)
          await refreshByodRegistry()
          if (!isModalOpen()) return
          showNotice('success', `${meta.label} driver verified and ready for connections.`)
        })
        .catch((err: unknown) => {
          if (!isModalOpen()) return
          showNotice('error', err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          setButtonLoading(trustBtn, false)
          setBusy(false)
        })
    })

    btnRow.appendChild(autoSetupBtn)
    btnRow.appendChild(copyStarterBtn)
    btnRow.appendChild(inspectBtn)
    btnRow.appendChild(trustBtn)

    byodStatusBanner.appendChild(btnRow)
  }

  for (const eng of BYOD_ENGINES) {
    const tile = document.createElement('button')
    tile.type = 'button'
    tile.className = 'datanoa-engine-tile'
    tile.dataset.driver = eng.id
    tile.title = `${eng.label} (Local BYOD Driver)`
    tile.appendChild(createDbLogoSvg(eng.id))
    const tileLabel = document.createElement('span')
    tileLabel.textContent = eng.label
    tile.appendChild(tileLabel)
    tile.addEventListener('click', () => {
      if (isBusy || driver === eng.id) return
      applyDriver(eng.id, true)
    })
    engineTiles.set(eng.id, tile)
    byodEngineGrid.appendChild(tile)
  }
  body.appendChild(byodEngineLabel)
  body.appendChild(byodEngineGrid)
  body.appendChild(byodStatusBanner)
  body.appendChild(discoverySection)
  void refreshByodRegistry()

  // ---- Fields ----
  const nameInp = createInput('Connection name')
  const filePathInp = createInput('C:\\path\\to\\database.db', true)
  const libsqlUrlInp = createInput('libsql://your-db.turso.io', true)
  const authTokenInp = createInput('Optional Bearer token')
  authTokenInp.type = 'password'
  authTokenInp.setAttribute('autocomplete', 'new-password')
  const libsqlDbInp = createInput('Database label (e.g. turso)')
  const d1AccountInp = createInput('Cloudflare Account ID', true)
  const d1DatabaseInp = createInput('D1 Database ID', true)
  const d1EndpointInp = createInput('Optional custom endpoint / proxy URL', true)
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

  const aiPolicySel = createSelect([
    { value: '', label: 'Default (Auto)' },
    { value: 'allow', label: 'Allow' },
    { value: 'ask', label: 'Ask before sending' },
    { value: 'never', label: 'Never' },
  ])
  aiPolicySel.setAttribute('aria-label', 'AI Access Policy')
  if (
    editProfile?.aiPolicy === 'allow' ||
    editProfile?.aiPolicy === 'ask' ||
    editProfile?.aiPolicy === 'never'
  ) {
    aiPolicySel.value = editProfile.aiPolicy
  }
  const aiPolicyHint = document.createElement('div')
  aiPolicyHint.className = 'datanoa-conn-hint'
  aiPolicyHint.style.marginTop = '4px'
  const isProdColorTag = (tag: string): boolean => {
    const norm = String(tag || '').trim().toLowerCase()
    return norm === 'prod' || norm === 'production'
  }
  const syncAiPolicyHint = (): void => {
    const isProd = isProdColorTag(colorTag)
    showEl(aiPolicyHint, isProd)
    if (isProd) {
      aiPolicyHint.textContent =
        aiPolicySel.value === 'allow'
          ? 'Production tag active — AI access is explicitly allowed for this connection.'
          : aiPolicySel.value === 'never'
            ? 'Production tag active — AI access is blocked for this connection.'
            : 'Production connections default to ask/fail-closed protection for remote AI unless explicitly overridden.'
    }
  }
  aiPolicySel.addEventListener('change', () => {
    syncStudioSelectTooltip(aiPolicySel, 'AI Access Policy')
    syncAiPolicyHint()
  })
  const aiPolicyWrap = document.createElement('div')
  aiPolicyWrap.appendChild(aiPolicySel)
  aiPolicyWrap.appendChild(aiPolicyHint)
  const rowAiPolicy = createField('AI Access Policy', aiPolicyWrap, true, aiPolicySel)

  const envPills = document.createElement('div')
  envPills.className = 'datanoa-conn-env-pills'
  const envPillBtns = new Map<ConnectionColorTag, HTMLButtonElement>()
  const syncEnvPills = (): void => {
    envPillBtns.forEach((btn, id) => btn.classList.toggle('active', id === colorTag))
    syncAiPolicyHint()
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

  // ---- Folder / Group & Workspace Scope (Phase 5B) ----
  const folderGroupInp = createInput('Create or enter a folder name (optional)')
  folderGroupInp.maxLength = 64
  if (editProfile?.folder) folderGroupInp.value = editProfile.folder
  const folderPresetsRow = document.createElement('div')
  folderPresetsRow.className = 'datanoa-conn-row is-wrap'
  folderPresetsRow.style.marginTop = '5px'
  folderPresetsRow.style.gap = '5px'
  folderPresetsRow.style.display = 'none'
  const renderFolderChips = (folders: string[]): void => {
    folderPresetsRow.innerHTML = ''
    const unique = Array.from(new Set(folders.map((f) => f.trim()).filter(Boolean))).sort(
      (a, b) => a.localeCompare(b)
    )
    if (unique.length === 0) {
      folderPresetsRow.style.display = 'none'
      return
    }
    folderPresetsRow.style.display = 'flex'
    for (const fName of unique) {
      const chip = createButton('')
      chip.title = `Assign to existing folder "${fName}"`
      const ico = document.createElement('span')
      ico.style.display = 'inline-flex'
      ico.style.color = 'var(--info)'
      ico.appendChild(createFolderIconSvg(false, 12))
      const txt = document.createElement('span')
      txt.textContent = fName
      chip.appendChild(ico)
      chip.appendChild(txt)
      chip.addEventListener('click', () => {
        if (isBusy) return
        folderGroupInp.value = fName
      })
      folderPresetsRow.appendChild(chip)
    }
  }
  renderFolderChips([])
  void ctx
    .requestPlugin<ConnectionProfile[]>('connections.list')
    .then((conns) => {
      if (!isModalOpen() || !Array.isArray(conns)) return
      const existingFolders = conns
        .map((c) => (typeof c?.folder === 'string' ? c.folder.trim() : ''))
        .filter(Boolean)
      renderFolderChips(existingFolders)
    })
    .catch(() => {})
  const folderGroupWrap = document.createElement('div')
  folderGroupWrap.appendChild(folderGroupInp)
  folderGroupWrap.appendChild(folderPresetsRow)
  const rowFolderGroup = createField(
    'Folder / Group (Organize Connections)',
    folderGroupWrap,
    true,
    folderGroupInp
  )
  const currentScope = (ctx.currentWorkspaceScope || '').trim()
  const storedScope = (editProfile?.workspaceScope || '').trim()
  const formatScopeFallbackLabel = (rawId: string): string => {
    if (!rawId) return ''
    if (/^folder:[0-9a-f-]+$/i.test(rawId)) return 'Current Orca Workspace'
    return rawId
  }
  const workspaceScopeSel = createSelect([
    { value: '', label: 'Global — Available in All Workspaces (No Pin)' },
  ])
  let workspaceScopeInitialized = false
  const populateWorkspaceScopeOptions = (
    items: Array<{
      id: string
      name: string
      branch?: string
      path?: string
      projectFolder?: string
      label: string
      isCurrent: boolean
    }>,
    activeScopeId: string,
    activeScopeLabel: string
  ): void => {
    const prevVal = workspaceScopeInitialized ? workspaceScopeSel.value : storedScope
    workspaceScopeInitialized = true
    workspaceScopeSel.innerHTML = ''
    const globalOpt = document.createElement('option')
    globalOpt.value = ''
    globalOpt.textContent = 'Global — Available in All Workspaces (No Pin)'
    if (globalOpt.dataset) {
      globalOpt.dataset.fullTitle = 'Global — Available in All Workspaces (No Pin)'
    }
    workspaceScopeSel.appendChild(globalOpt)

    const seenIds = new Set<string>()
    const byProject = new Map<
      string,
      Array<{
        id: string
        name: string
        branch?: string
        path?: string
        projectFolder?: string
        label: string
        isCurrent: boolean
      }>
    >()

    for (const item of items) {
      if (!item?.id || seenIds.has(item.id)) continue
      seenIds.add(item.id)
      if (item.isCurrent) {
        const opt = document.createElement('option')
        opt.value = item.id
        opt.textContent = `Current Workspace: ${item.name}${item.branch ? ` (${item.branch})` : ''}`
        if (opt.dataset) {
          opt.dataset.subtitle = item.path || ''
          opt.dataset.fullTitle = `Current Workspace: ${item.label}`
          opt.dataset.isCurrent = '1'
        }
        workspaceScopeSel.appendChild(opt)
        continue
      }
      const proj = (item.projectFolder || item.name || 'Workspaces').trim()
      const list = byProject.get(proj)
      if (list) list.push(item)
      else byProject.set(proj, [item])
    }

    const effCurr = activeScopeId || currentScope
    if (effCurr && !seenIds.has(effCurr)) {
      seenIds.add(effCurr)
      const opt = document.createElement('option')
      opt.value = effCurr
      const lbl = activeScopeLabel || formatScopeFallbackLabel(effCurr)
      opt.textContent = `Current Workspace: ${lbl}`
      if (opt.dataset) {
        opt.dataset.fullTitle = `Current Workspace: ${lbl}`
        opt.dataset.isCurrent = '1'
      }
      workspaceScopeSel.appendChild(opt)
    }

    for (const proj of Array.from(byProject.keys()).sort((a, b) => a.localeCompare(b))) {
      const grp = document.createElement('optgroup')
      grp.label = proj
      for (const item of byProject.get(proj) || []) {
        const opt = document.createElement('option')
        opt.value = item.id
        opt.textContent = `${item.name}${item.branch ? ` (${item.branch})` : ''}`
        if (opt.dataset) {
          opt.dataset.subtitle = item.path || ''
          opt.dataset.fullTitle = `[${proj}] ${item.label}`
          opt.dataset.isCurrent = item.isCurrent ? '1' : '0'
        }
        grp.appendChild(opt)
      }
      workspaceScopeSel.appendChild(grp)
    }

    if (storedScope && !seenIds.has(storedScope)) {
      seenIds.add(storedScope)
      const opt = document.createElement('option')
      opt.value = storedScope
      const lbl = formatScopeFallbackLabel(storedScope)
      opt.textContent = `Pinned Workspace: ${lbl}`
      if (opt.dataset) {
        opt.dataset.fullTitle = `Pinned Workspace: ${lbl}`
      }
      workspaceScopeSel.appendChild(opt)
    }

    workspaceScopeSel.value = prevVal && seenIds.has(prevVal) ? prevVal : ''
    workspaceScopeSel.dataset.searchAriaLabel = 'Search workspaces'
    enhanceStudioCollapsibleSelect(workspaceScopeSel, {
      tooltipPrefix: 'Workspace Scope (Pin Connection)',
      searchPlaceholder: 'Search workspaces by name, branch, or project folder...',
      defaultCollapseNonActiveFolders: true,
      leadingIconType: 'workspace',
    })
  }
  const rowWorkspacePin = createField(
    'Workspace Scope (Pin Connection to Workspace)',
    workspaceScopeSel,
    true
  )
  populateWorkspaceScopeOptions([], currentScope, formatScopeFallbackLabel(currentScope))
  if (storedScope) {
    workspaceScopeSel.value = storedScope
    syncStudioSelectTooltip(workspaceScopeSel, 'Workspace Scope (Pin Connection)')
  }
  void ctx
    .requestPlugin<{
      currentScopeId?: string
      currentScopeLabel?: string
      workspaces?: Array<{
        id: string
        name: string
        branch?: string
        path?: string
        projectFolder?: string
        label: string
        isCurrent: boolean
      }>
    }>('workspace.listScopes')
    .then((res) => {
      if (!isModalOpen()) return
      populateWorkspaceScopeOptions(
        Array.isArray(res?.workspaces) ? res.workspaces : [],
        res?.currentScopeId || currentScope,
        res?.currentScopeLabel || ''
      )
    })
    .catch(() => {})

  const deriveStudioSqliteName = (rawPath: string): string => {
    const parts = rawPath.split(/[\\/]/).filter(Boolean)
    const base = parts[parts.length - 1] || 'database.db'
    const parent = parts.length > 1 ? parts[parts.length - 2] : ''
    const stem = base.replace(/\.(?:db|sqlite|sqlite3|db3)$/i, '')
    if (!stem || stem === '.' || stem.startsWith('.')) {
      return parent ? `${parent}/${base}` : base
    }
    return base
  }

  const sqliteFileRowWrap = document.createElement('div')
  sqliteFileRowWrap.className = 'datanoa-conn-row'
  filePathInp.style.flex = '1 1 220px'
  const browseSqliteFileBtn = createButton('Browse File...')
  const handlePickLocalSqliteFile = (): void => {
    if (isBusy) return
    const currentDriver: string = driver
    const isDuck = currentDriver === 'duckdb'
    void openStudioFilePickerModal(ctx, {
      title: isDuck ? 'Select DuckDB database file' : 'Select SQLite database file',
      mode: 'file',
      initialDir: filePathInp.value.trim() || undefined,
      extensions: isDuck ? ['.duckdb', '.ddb', '.db'] : ['.db', '.sqlite', '.sqlite3', '.db3'],
    })
      .then((res) => {
        if (!isModalOpen()) return
        if (res?.ok && res.path) {
          if (!isStudioFileDbDriver(driver)) {
            applyDriver('sqlite', false)
          }
          filePathInp.value = res.path
          const smartName = deriveStudioSqliteName(res.path)
          if (smartName && (!nameInp.value.trim() || nameInp.value === lastAutoName)) {
            nameInp.value = smartName
            lastAutoName = smartName
          }
        }
      })
      .catch(() => {})
  }
  browseSqliteFileBtn.addEventListener('click', handlePickLocalSqliteFile)
  quickBrowseDbBtn.addEventListener('click', handlePickLocalSqliteFile)
  sqliteFileRowWrap.appendChild(filePathInp)
  sqliteFileRowWrap.appendChild(browseSqliteFileBtn)
  const rowFilePath = createField('SQLite File Path', sqliteFileRowWrap, true, filePathInp)
  const filePathLabel = rowFilePath.querySelector('label')
  const rowLibsqlUrl = createField('LibSQL / Turso URL', libsqlUrlInp, true)
  const rowAuthToken = createField('Auth Token', authTokenInp)
  const rowLibsqlDb = createField('Database Label', libsqlDbInp)
  const rowD1Account = createField('D1 Account ID', d1AccountInp)
  const rowD1Database = createField('D1 Database ID', d1DatabaseInp)
  const authTokenLabel = rowAuthToken.querySelector('label')
  const rowD1Endpoint = createField('Custom Endpoint URL', d1EndpointInp, true)
  const rowHost = createField('Host', hostInp)
  const rowPort = createField('Port', portInp)
  const rowUser = createField('User', userInp)
  const rowPassword = createField('Password', passwordInp)
  const rowDatabase = createField('Database', databaseInp)
  const rowRedisDb = createField('Redis DB Index', redisDbSel)
  const rowSsl = createField('Security', sslCheck.wrap)
  const rowChUrl = createField('HTTP(S) Endpoint URL', chUrlInp, true)
  const chUrlLabel = rowChUrl.querySelector('label')
  const rowOptions = createField('Options (Cluster / Endpoint)', optionsInp, true)
  for (const row of [
    rowName,
    rowEnv,
    rowAiPolicy,
    rowFolderGroup,
    rowWorkspacePin,
    rowFilePath,
    rowLibsqlUrl,
    rowLibsqlDb,
    rowD1Account,
    rowD1Database,
    rowAuthToken,
    rowD1Endpoint,
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

  // ---- TLS / Custom Certificates (mTLS) ----
  const tlsSection = createCollapsible('TLS / Custom Certificates (mTLS)')
  const sslModeSel = createSelect([
    { value: 'auto', label: 'Auto / Cloud SSL' },
    { value: 'disable', label: 'Disable' },
    { value: 'require', label: 'Require (No CA Verify)' },
    { value: 'verify-ca', label: 'Verify CA' },
    { value: 'verify-full', label: 'Verify Full Hostname' },
  ])
  const sslCaPathInp = createInput('/path/to/ca.pem', true)
  const sslCertPathInp = createInput('/path/to/client-cert.pem', true)
  const sslKeyPathInp = createInput('/path/to/client-key.pem', true)
  const sslKeyPassphraseInp = createInput('Optional private key passphrase')
  sslKeyPassphraseInp.type = 'password'
  sslKeyPassphraseInp.setAttribute('autocomplete', 'new-password')
  const sslRejectCheck = createCheck('Reject Unauthorized Certs')
  sslRejectCheck.input.checked =
    editProfile?.sslRejectUnauthorized !== undefined
      ? Boolean(editProfile.sslRejectUnauthorized)
      : editProfile?.sslMode !== 'require'
  const tlsGrid = document.createElement('div')
  tlsGrid.className = 'datanoa-conn-fields'
  tlsGrid.appendChild(createField('SSL Mode', sslModeSel))
  tlsGrid.appendChild(createField('Certificate Verification', sslRejectCheck.wrap))
  tlsGrid.appendChild(createField('CA Certificate Path', sslCaPathInp, true))
  tlsGrid.appendChild(createField('Client Certificate Path', sslCertPathInp, true))
  tlsGrid.appendChild(createField('Client Private Key Path', sslKeyPathInp, true))
  tlsGrid.appendChild(createField('Key Passphrase', sslKeyPassphraseInp, true))
  tlsSection.bodyEl.appendChild(tlsGrid)
  body.appendChild(tlsSection.root)

  // ---- SSH Tunnel (Bastion) ----
  const sshSection = createCollapsible('SSH Tunnel (Bastion)')
  const sshCheck = createCheck('Enable SSH Tunnel')
  const sshHostInp = createInput('bastion.example.com', true)
  const sshPortInp = createInput('22', true)
  sshPortInp.inputMode = 'numeric'
  sshPortInp.value = '22'
  const sshUserInp = createInput('ubuntu')
  const sshAuthSel = createSelect([
    { value: 'agent', label: 'SSH Agent (SSH_AUTH_SOCK)' },
    { value: 'key', label: 'Private Key File' },
    { value: 'password', label: 'Password' },
  ])
  const sshKeyPathInp = createInput('~/.ssh/id_ed25519', true)
  const sshPassphraseInp = createInput('Optional SSH key passphrase')
  sshPassphraseInp.type = 'password'
  sshPassphraseInp.setAttribute('autocomplete', 'new-password')
  const sshPasswordInp = createInput('Optional SSH password')
  sshPasswordInp.type = 'password'
  sshPasswordInp.setAttribute('autocomplete', 'new-password')
  const sshPasswordHint = document.createElement('div')
  sshPasswordHint.className = 'datanoa-conn-hint'
  sshPasswordHint.textContent =
    'OS ssh runs non-interactively (-N -L): SSH Agent or a private key file is recommended over a password.'
  const sshGrid = document.createElement('div')
  sshGrid.className = 'datanoa-conn-fields'
  const rowSshEnable = createField('Tunnel', sshCheck.wrap, true)
  const rowSshHost = createField('Bastion Host', sshHostInp)
  const rowSshPort = createField('SSH Port', sshPortInp)
  const rowSshUser = createField('SSH Username', sshUserInp)
  const rowSshAuth = createField('Auth Method', sshAuthSel)
  const rowSshKey = createField('Private Key Path', sshKeyPathInp, true)
  const rowSshPassphrase = createField('Key Passphrase', sshPassphraseInp, true)
  const rowSshPassword = createField('SSH Password', sshPasswordInp, true)
  for (const row of [
    rowSshEnable,
    rowSshHost,
    rowSshPort,
    rowSshUser,
    rowSshAuth,
    rowSshKey,
    rowSshPassphrase,
    rowSshPassword,
    sshPasswordHint,
  ]) {
    sshGrid.appendChild(row)
  }
  sshSection.bodyEl.appendChild(sshGrid)
  body.appendChild(sshSection.root)

  const syncTlsUi = (): void => {
    const mode = sslModeSel.value
    const customMode = mode !== 'auto' && mode !== 'disable'
    const hasCert = Boolean(
      sslCaPathInp.value.trim() || sslCertPathInp.value.trim() || sslKeyPathInp.value.trim()
    )
    const hasPassphrase = Boolean(sslKeyPassphraseInp.value) || hadSslKeyPassphrase
    const rejectDisabled = sslRejectCheck.input.checked === false
    tlsSection.sync(customMode || hasCert || hasPassphrase || rejectDisabled ? 'mTLS' : null)
  }
  const reconcileSslCheckWithMode = (): void => {
    const mode = sslModeSel.value
    if (mode === 'disable') sslCheck.input.checked = false
    else if (mode === 'require' || mode === 'verify-ca' || mode === 'verify-full') {
      sslCheck.input.checked = true
    }
  }
  const syncSshUi = (): void => {
    sshSection.sync(sshCheck.input.checked ? 'SSH' : null)
    const method = sshAuthSel.value
    showEl(rowSshKey, method === 'key')
    showEl(rowSshPassphrase, method === 'key')
    showEl(rowSshPassword, method === 'password')
    showEl(sshPasswordHint, method === 'password')
  }
  sslCheck.input.addEventListener('change', () => {
    sslModeSel.value = sslCheck.input.checked ? 'auto' : 'disable'
    if (sslCheck.input.checked) {
      sslRejectCheck.input.checked = true
    }
    syncStudioSelectTooltip(sslModeSel, 'SSL Mode')
    syncTlsUi()
  })
  sslModeSel.addEventListener('change', () => {
    sslCheck.input.checked = sslModeSel.value !== 'disable'
    if (sslModeSel.value === 'require') {
      sslRejectCheck.input.checked = false
    } else if (sslModeSel.value === 'verify-ca' || sslModeSel.value === 'verify-full') {
      sslRejectCheck.input.checked = true
    }
    syncStudioSelectTooltip(sslModeSel, 'SSL Mode')
    syncTlsUi()
  })
  sslRejectCheck.input.addEventListener('change', () => {
    if (!sslRejectCheck.input.checked) {
      sslCheck.input.checked = true
      if (
        sslModeSel.value === 'auto' ||
        sslModeSel.value === 'disable' ||
        sslModeSel.value === 'verify-ca' ||
        sslModeSel.value === 'verify-full'
      ) {
        sslModeSel.value = 'require'
        syncStudioSelectTooltip(sslModeSel, 'SSL Mode')
      }
    } else if (sslModeSel.value === 'require') {
      sslModeSel.value = 'auto'
      syncStudioSelectTooltip(sslModeSel, 'SSL Mode')
    }
    syncTlsUi()
  })
  redisDbSel.addEventListener('change', () => {
    syncStudioSelectTooltip(redisDbSel, 'Redis DB Index')
  })
  for (const inp of [sslCaPathInp, sslCertPathInp, sslKeyPathInp, sslKeyPassphraseInp]) {
    inp.addEventListener('input', syncTlsUi)
  }
  const invalidateDbStoredSecrets = (): void => {
    hadPassword = false
    hadAuthToken = false
    if (!passwordInp.value && !placeholderPending) {
      passwordInp.placeholder = 'Optional'
    }
    if (!authTokenInp.value) {
      authTokenInp.placeholder =
        driver === 'd1' ? 'Bearer API token with D1 access' : 'Optional Bearer token'
    }
  }
  const invalidateSslStoredSecret = (): void => {
    hadSslKeyPassphrase = false
    if (!sslKeyPassphraseInp.value) {
      sslKeyPassphraseInp.placeholder = 'Optional private key passphrase'
    }
  }
  const invalidateSshStoredSecrets = (): void => {
    hadSshPassphrase = false
    hadSshPassword = false
    if (!sshPassphraseInp.value) {
      sshPassphraseInp.placeholder = 'Optional SSH key passphrase'
    }
    if (!sshPasswordInp.value) {
      sshPasswordInp.placeholder = 'Optional SSH password'
    }
  }
  const markAutoUriConsumedOnManualEdit = (): void => {
    if (activeAutoDisplayUri && uriInp.value.trim() === activeAutoDisplayUri) {
      if (activeAutoCandidateId) {
        lastParsedCandidateId = activeAutoCandidateId
      } else if (activeAutoRawUri) {
        lastParsedUri = activeAutoRawUri
      }
      lastParsedDisplayUri = activeAutoDisplayUri
    }
  }
  for (const inp of [
    hostInp,
    portInp,
    userInp,
    chUrlInp,
    libsqlUrlInp,
    d1AccountInp,
    d1DatabaseInp,
    d1EndpointInp,
  ]) {
    inp.addEventListener('input', () => {
      invalidateDbStoredSecrets()
      markAutoUriConsumedOnManualEdit()
    })
  }
  databaseInp.addEventListener('input', markAutoUriConsumedOnManualEdit)
  passwordInp.addEventListener('input', markAutoUriConsumedOnManualEdit)
  sslKeyPathInp.addEventListener('input', invalidateSslStoredSecret)
  for (const inp of [sshHostInp, sshPortInp, sshUserInp, sshKeyPathInp]) {
    inp.addEventListener('input', invalidateSshStoredSecrets)
  }
  sshCheck.input.addEventListener('change', syncSshUi)
  sshAuthSel.addEventListener('change', () => {
    invalidateSshStoredSecrets()
    syncStudioSelectTooltip(sshAuthSel, 'SSH Auth Method')
    syncSshUi()
  })

  // ---- Footer ----
  const actions = document.createElement('div')
  actions.className = 'datanoa-modal-actions'
  const deleteBtn = createButton('Delete Connection', 'datanoa-btn-danger')
  deleteBtn.style.marginRight = 'auto'
  const testBtn = createButton('Test Connection')
  const clearBtn = createButton('Clear')
  clearBtn.title = 'Clear all form fields to start over'
  const cancelBtn = createButton('Cancel', 'datanoa-btn-cancel')
  const saveBtn = createButton(
    isEdit ? 'Update Connection' : 'Save & Connect',
    'datanoa-btn-primary'
  )
  if (isEdit) actions.appendChild(deleteBtn)
  actions.appendChild(testBtn)
  actions.appendChild(clearBtn)
  actions.appendChild(cancelBtn)
  actions.appendChild(saveBtn)

  const busyControls: Array<HTMLInputElement | HTMLSelectElement | HTMLButtonElement> = [
    uriInp,
    parseBtn,
    quickBrowseDbBtn,
    detectBtn,
    folderInp,
    browseScanFolderBtn,
    scanBtn,
    browseSqliteFileBtn,
    nameInp,
    filePathInp,
    libsqlUrlInp,
    authTokenInp,
    libsqlDbInp,
    d1AccountInp,
    d1DatabaseInp,
    d1EndpointInp,
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
    aiPolicySel,
    folderGroupInp,
    workspaceScopeSel,
    sslModeSel,
    sslCaPathInp,
    sslCertPathInp,
    sslKeyPathInp,
    sslKeyPassphraseInp,
    sslRejectCheck.input,
    sshCheck.input,
    sshHostInp,
    sshPortInp,
    sshUserInp,
    sshAuthSel,
    sshKeyPathInp,
    sshPassphraseInp,
    sshPasswordInp,
    deleteBtn,
    testBtn,
    clearBtn,
    cancelBtn,
    saveBtn,
    tlsSection.head,
    sshSection.head,
    ...Array.from(engineTiles.values()),
  ]
  const setBusy = (busy: boolean): void => {
    isBusy = busy
    for (const ctrl of busyControls) {
      ctrl.disabled = busy
    }
    syncStudioSelectTooltip(workspaceScopeSel, 'Workspace Scope (Pin Connection)')
  }

  // ---- Discovery rendering ----
  const discoverySearchInp = createInput('Search .env, Docker Compose & .db files...')
  discoverySearchInp.type = 'search'
  discoverySearchInp.setAttribute('aria-label', 'Search .env, Docker Compose and SQLite files')
  discoverySearchInp.classList.add('datanoa-discovery-search')
  const discoveryGroupsWrap = document.createElement('div')
  discoveryGroupsWrap.className = 'datanoa-discovery-groups'

  const compactStudioSource = (raw: string): string => {
    const clean = String(raw || '').trim()
    if (clean.length <= 44) return clean
    const parts = clean.split(/[\\/]/).filter(Boolean)
    return parts.length <= 2 ? clean : `.../${parts.slice(-3).join('/')}`
  }

  const resetFormAuthAndTunnels = (): void => {
    hadPassword = false
    hadAuthToken = false
    hadSslKeyPassphrase = false
    hadSshPassphrase = false
    hadSshPassword = false
    lastParsedUri = ''
    lastOracleParsedUrl = ''
    lastParsedPlaceholder = false
    placeholderPending = false
    uriInp.value = ''
    authTokenInp.value = ''
    authTokenInp.placeholder = 'Optional Bearer token'
    passwordInp.value = ''
    passwordInp.placeholder = 'Optional'
    sslModeSel.value = 'auto'
    sslCaPathInp.value = ''
    sslCertPathInp.value = ''
    sslKeyPathInp.value = ''
    sslKeyPassphraseInp.value = ''
    sslKeyPassphraseInp.placeholder = 'Optional private key passphrase'
    sslRejectCheck.input.checked = true
    sshCheck.input.checked = false
    sshHostInp.value = ''
    sshPortInp.value = '22'
    sshUserInp.value = ''
    sshAuthSel.value = 'agent'
    sshKeyPathInp.value = ''
    sshPassphraseInp.value = ''
    sshPassphraseInp.placeholder = 'Optional SSH key passphrase'
    sshPasswordInp.value = ''
    sshPasswordInp.placeholder = 'Optional SSH password'
    tlsSection.setExpanded(false)
    sshSection.setExpanded(false)
    syncStudioSelectTooltip(sslModeSel, 'SSL Mode')
    syncStudioSelectTooltip(sshAuthSel, 'SSH Auth Method')
    syncSshUi()
  }

  const applyDockerComposeItem = (item: DiscoveredDockerComposeConnection): void => {
    if (!isKnownConnectionDriver(item.driver)) {
      showNotice('error', `Unsupported driver "${String(item.driver)}" in Docker Compose.`)
      return
    }
    const seq = ++dockerApplySeq
    resetFormAuthAndTunnels()
    clearActiveAutoUri()
    if (item.url) {
      const maskedUrl = maskUriSecret(item.url)
      uriInp.value = maskedUrl
      activeAutoCandidateId = item.candidateId || null
      activeAutoRawUri = item.candidateId ? null : item.url
      activeAutoDisplayUri = maskedUrl
      const hasUnparsedSecret =
        Boolean(item.candidateId) || (item.password === undefined && maskedUrl !== item.url)
      if (hasUnparsedSecret) {
        lastParsedUri = ''
        lastParsedCandidateId = ''
        lastParsedDisplayUri = ''
      } else {
        lastParsedUri = item.url
        lastParsedCandidateId = ''
        lastParsedDisplayUri = maskedUrl
      }
    } else {
      uriInp.value = ''
    }
    portInp.value = ''
    chUrlInp.value = ''
    applyDriver(item.driver, true)
    nameInp.value = item.name || `${item.project} · ${item.service}`
    lastAutoName = nameInp.value
    if (item.driver === 'libsql') {
      libsqlUrlInp.value = item.url
        ? sanitizeLibsqlFormUrlAndName(item.url).cleanUrl || scrubStudioNetworkFormUrl(item.url)
        : `http://${item.host || '127.0.0.1'}:${item.port || 8080}`
      libsqlDbInp.value = item.database || 'main'
    } else {
      hostInp.value = item.host || '127.0.0.1'
      portInp.value = String(item.port || getStudioEngineMeta(item.driver).defaultPort)
      userInp.value = item.user || ''
      sslCheck.input.checked = Boolean(item.ssl)
      reconcileSslCheckWithMode()
      syncTlsUi()
      if (item.driver === 'redis') {
        redisDbSel.value = String(item.redisDb ?? 0)
        syncStudioSelectTooltip(redisDbSel, 'Redis DB Index')
      } else {
        databaseInp.value = item.database || getStudioEngineMeta(item.driver).defaultDb
      }
      if (item.driver === 'clickhouse') {
        chUrlInp.value = item.url
          ? scrubStudioNetworkFormUrl(item.url)
          : `http://${item.host || '127.0.0.1'}:${item.port || 8123}`
      } else if (item.driver === 'mongodb') {
        chUrlInp.value = item.url ? scrubStudioNetworkFormUrl(item.url) : ''
      }
      if (item.password !== undefined) {
        passwordInp.value = item.password
      }
      if (item.passwordFromFile) {
        passwordInp.placeholder = `Required (${item.passwordFromFile})`
      }
    }
    if (item.hint) {
      showNotice('warn', item.hint)
      if (item.passwordFromFile) passwordInp.focus?.()
    } else {
      showNotice(
        'success',
        `Imported ${getStudioEngineMeta(item.driver).label} service "${item.name}" from Docker Compose.`
      )
    }

    if (item.candidateId) {
      const candidateId = item.candidateId
      void ctx
        .requestPlugin<{
          ok: boolean
          parsed?: ParseUriResponse
          password?: string
          authToken?: string
          url?: string
        }>('workspace.resolveDetectedCandidate', { candidateId })
        .then((resolved) => {
          if (seq !== dockerApplySeq || !isModalOpen() || !resolved?.ok) return
          if (resolved.password !== undefined && item.driver !== 'libsql') {
            passwordInp.value = resolved.password
          }
          if (resolved.authToken !== undefined && item.driver === 'libsql') {
            authTokenInp.value = resolved.authToken
          }
          if (resolved.url) {
            if (item.driver === 'libsql') {
              libsqlUrlInp.value =
                sanitizeLibsqlFormUrlAndName(resolved.url).cleanUrl ||
                scrubStudioNetworkFormUrl(resolved.url)
            } else if (item.driver === 'clickhouse' || item.driver === 'mongodb') {
              chUrlInp.value = scrubStudioNetworkFormUrl(resolved.url)
            }
          }
          if (item.url && activeAutoCandidateId === candidateId && activeAutoDisplayUri) {
            lastParsedCandidateId = candidateId
            lastParsedDisplayUri = activeAutoDisplayUri
          }
        })
        .catch(() => {
          // Best-effort secret resolution; Save/Parse URI still falls back to connection.parseUri({ candidateId })
        })
    }
  }

  const createDiscoveryGroupCard = (
    groupKey: 'env' | 'docker' | 'sqlite',
    pillText: string,
    pillClass: string,
    titleText: string,
    totalCount: number,
    filteredCount: number,
    hasQuery: boolean,
    emptyText: string,
    buildChips: (listEl: HTMLDivElement) => void
  ): HTMLDivElement => {
    let collapsed: boolean
    if (hasQuery) {
      collapsed = filteredCount === 0
    } else if (typeof discoveryCollapsed[groupKey] === 'boolean') {
      collapsed = discoveryCollapsed[groupKey] === true
    } else if (groupKey === 'sqlite' && driver !== 'sqlite') {
      collapsed = true
    } else {
      collapsed = totalCount > 5
    }

    const group = document.createElement('div')
    group.className = `datanoa-discovery-group${collapsed ? '' : ' is-expanded'}`
    group.dataset.group = groupKey

    const headBtn = document.createElement('button')
    headBtn.type = 'button'
    headBtn.className = 'datanoa-discovery-head'
    const bodyEl = document.createElement('div')
    bodyEl.className = 'datanoa-discovery-body'
    bodyEl.id = `datanoa-discovery-body-${groupKey}`
    headBtn.setAttribute('aria-controls', bodyEl.id)
    headBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true')

    const chev = document.createElement('span')
    chev.className = 'datanoa-discovery-chevron'
    chev.textContent = '\u25b8'
    chev.setAttribute('aria-hidden', 'true')

    const pill = document.createElement('span')
    pill.className = `datanoa-discovery-pill ${pillClass}`
    pill.textContent = pillText

    const titleSpan = document.createElement('span')
    titleSpan.className = 'datanoa-discovery-title'
    titleSpan.textContent = titleText

    const countSpan = document.createElement('span')
    countSpan.className = 'datanoa-discovery-count'
    countSpan.textContent = hasQuery ? `${filteredCount} / ${totalCount}` : `${totalCount} found`

    headBtn.appendChild(chev)
    headBtn.appendChild(pill)
    headBtn.appendChild(titleSpan)
    headBtn.appendChild(countSpan)
    headBtn.addEventListener('click', () => {
      if (isBusy) return
      discoveryCollapsed[groupKey] = !collapsed
      renderDiscoveredGroups()
    })

    if (collapsed) {
      showEl(bodyEl, false)
    } else {
      const listEl = document.createElement('div')
      listEl.className = 'datanoa-conn-chip-list'
      if (filteredCount === 0) {
        const empty = document.createElement('div')
        empty.className = 'datanoa-cell-null'
        empty.textContent = emptyText
        listEl.appendChild(empty)
      } else {
        buildChips(listEl)
      }
      bodyEl.appendChild(listEl)
    }

    group.appendChild(headBtn)
    group.appendChild(bodyEl)
    return group
  }

  const renderDiscoveredGroups = (): void => {
    discoveryGroupsWrap.innerHTML = ''
    const hasEnvs = discoveredEnvs.length > 0
    const hasDocker = discoveredDocker.length > 0
    const hasFiles = discoveredFiles.length > 0
    if (!hasEnvs && !hasDocker && !hasFiles) {
      showEl(discoveredBox, false)
      return
    }
    showEl(discoveredBox, true)

    const q = discoveredSearch.trim().toLowerCase()
    const hasQuery = q.length > 0

    const makeEnvGroup = (): HTMLDivElement | null => {
      if (!hasEnvs) return null
      const filtered = hasQuery
        ? discoveredEnvs.filter((item) =>
            [item.envKey, item.name, item.driver, item.sourceFile, maskUriSecret(item.uri)]
              .join(' ')
              .toLowerCase()
              .includes(q)
          )
        : discoveredEnvs
      return createDiscoveryGroupCard(
        'env',
        '.env',
        'is-env',
        '.env Connections',
        discoveredEnvs.length,
        filtered.length,
        hasQuery,
        `No .env connections match "${discoveredSearch}".`,
        (list) => {
          for (const item of filtered) {
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
            badge.className = 'datanoa-badge datanoa-badge-neutral'
            badge.textContent = compactStudioSource(item.sourceFile || '.env')
            chip.appendChild(main)
            chip.appendChild(badge)
            chip.addEventListener('click', () => {
              if (isBusy) return
              dockerApplySeq++
              uriInp.value = masked
              activeAutoCandidateId = item.candidateId || null
              activeAutoRawUri = item.candidateId ? null : item.uri
              activeAutoDisplayUri = masked
              if (!nameInp.value.trim()) {
                nameInp.value = item.name || item.envKey
                lastAutoName = nameInp.value
              }
              void parseUri(
                {
                  ...(item.candidateId ? { candidateId: item.candidateId } : { uri: item.uri }),
                  displayUri: masked,
                },
                true
              )
            })
            list.appendChild(chip)
          }
        }
      )
    }

    const makeDockerGroup = (): HTMLDivElement | null => {
      if (!hasDocker) return null
      const filtered = hasQuery
        ? discoveredDocker.filter((item) =>
            [
              item.project,
              item.service,
              item.name,
              item.driver,
              item.host,
              String(item.port || ''),
              item.database,
              item.user || '',
              item.status,
              item.sourceFile,
            ]
              .join(' ')
              .toLowerCase()
              .includes(q)
          )
        : discoveredDocker
      return createDiscoveryGroupCard(
        'docker',
        'Docker',
        'is-docker',
        'Docker Compose',
        discoveredDocker.length,
        filtered.length,
        hasQuery,
        `No Docker Compose services match "${discoveredSearch}".`,
        (list) => {
          for (const item of filtered) {
            const chip = document.createElement('button')
            chip.type = 'button'
            chip.className = 'datanoa-conn-chip'
            chip.title = `${item.name} (${item.driver}) — ${item.host}:${item.port} [${item.status}]`
            const main = document.createElement('span')
            main.className = 'datanoa-conn-chip-main'
            const title = document.createElement('span')
            title.className = 'datanoa-conn-chip-title'
            if (isKnownConnectionDriver(item.driver)) title.appendChild(createDbLogoSvg(item.driver))
            const titleText = document.createElement('span')
            titleText.textContent = item.name || `${item.project} · ${item.service}`
            title.appendChild(titleText)
            const sub = document.createElement('span')
            sub.className = 'datanoa-conn-chip-sub'
            const targetDb = item.driver === 'redis' ? `db${item.redisDb ?? 0}` : item.database || ''
            const userPrefix = item.user ? `${item.user}@` : ''
            sub.textContent = `${userPrefix}${item.host}:${item.port}${targetDb ? `/${targetDb}` : ''} · ${compactStudioSource(item.sourceFile)}`
            main.appendChild(title)
            main.appendChild(sub)

            const badges = document.createElement('span')
            badges.className = 'datanoa-discovery-badges'
            if (item.workspaceMatched) {
              const wsBadge = document.createElement('span')
              wsBadge.className = 'datanoa-badge datanoa-badge-info'
              wsBadge.textContent = 'Workspace'
              badges.appendChild(wsBadge)
            } else {
              const otherBadge = document.createElement('span')
              otherBadge.className = 'datanoa-badge datanoa-badge-neutral'
              const isRemoteContext = discoveredDockerScopeLabel === 'Docker Context'
              otherBadge.textContent = isRemoteContext
                ? 'Other Docker Context'
                : 'Other Local Docker'
              otherBadge.title = isRemoteContext
                ? 'Running in the active Docker context outside the scanned workspace folder'
                : 'Running in local Docker outside the active workspace folder'
              badges.appendChild(otherBadge)
            }
            const statusBadge = document.createElement('span')
            statusBadge.className = `datanoa-badge ${
              item.status === 'running'
                ? 'datanoa-badge-ok'
                : item.status === 'compose file'
                  ? 'datanoa-badge-neutral'
                  : 'datanoa-badge-danger'
            }`
            statusBadge.textContent = item.status || 'live'
            badges.appendChild(statusBadge)

            chip.appendChild(main)
            chip.appendChild(badges)
            chip.addEventListener('click', () => {
              if (!isBusy) applyDockerComposeItem(item)
            })
            list.appendChild(chip)
          }
        }
      )
    }

    const makeSqliteGroup = (): HTMLDivElement | null => {
      if (!hasFiles) return null
      const filtered = hasQuery
        ? discoveredFiles.filter(
            (f) => f.name.toLowerCase().includes(q) || f.filePath.toLowerCase().includes(q)
          )
        : discoveredFiles
      return createDiscoveryGroupCard(
        'sqlite',
        'SQLite',
        'is-sqlite',
        'SQLite Files (.db)',
        discoveredFiles.length,
        filtered.length,
        hasQuery,
        `No SQLite files match "${discoveredSearch}".`,
        (list) => {
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
              if (driver !== 'sqlite') {
                applyDriver('sqlite', false)
              }
              filePathInp.value = file.filePath
              if (!nameInp.value.trim() || nameInp.value === lastAutoName) {
                nameInp.value = file.name
                lastAutoName = file.name
              }
              renderDiscoveredGroups()
            })
            list.appendChild(chip)
          }
        }
      )
    }

    const ordered =
      driver === 'sqlite'
        ? [makeSqliteGroup(), makeEnvGroup(), makeDockerGroup()]
        : [makeEnvGroup(), makeDockerGroup(), makeSqliteGroup()]
    for (const grp of ordered) {
      if (grp) discoveryGroupsWrap.appendChild(grp)
    }
  }

  discoverySearchInp.addEventListener('input', () => {
    discoveredSearch = discoverySearchInp.value
    renderDiscoveredGroups()
  })

  const renderDiscovered = (): void => {
    if (discoveredBox.childElementCount === 0) {
      discoveredBox.appendChild(discoverySearchInp)
      discoveredBox.appendChild(discoveryGroupsWrap)
    }
    discoverySearchInp.value = discoveredSearch
    renderDiscoveredGroups()
  }

  // ---- Driver switching ----
  const syncAuthTokenPlaceholder = (): void => {
    if (hadAuthToken && isEdit) {
      authTokenInp.placeholder = 'Stored token preserved (type to replace)'
      return
    }
    authTokenInp.placeholder =
      driver === 'd1' ? 'Bearer API token with D1 access' : 'Optional Bearer token'
  }
  const applyDriver = (next: DatabaseDriverType, applyDefaults: boolean): void => {
    const prevDriver = driver
    const prevMeta = getStudioEngineMeta(driver)
    if (applyDefaults && prevDriver !== next) {
      invalidateDbStoredSecrets()
      invalidateSslStoredSecret()
      invalidateSshStoredSecrets()
    }
    driver = next
    const meta = getStudioEngineMeta(next)
    engineTiles.forEach((tile, id) => {
      const isSelected = id === next
      tile.classList.toggle('active', isSelected)
      if (!isSelected && typeof document !== 'undefined' && document.activeElement === tile) {
        tile.blur?.()
      }
    })
    const nextId: string = next
    const isDuckdb = nextId === 'duckdb'
    const isFileDb = isStudioFileDbDriver(nextId)
    const isLibsql = next === 'libsql'
    const isD1 = next === 'd1'
    const isServer = !isFileDb && !isLibsql && !isD1
    const isMongo = next === 'mongodb'
    const hasUrlField = next === 'clickhouse' || isMongo
    const hasOptionsField = isStudioOptionsDriver(nextId)
    showEl(quickBrowseDbBtn, isFileDb)
    showEl(rowFilePath, isFileDb)
    if (filePathLabel) {
      filePathLabel.textContent = isDuckdb ? 'DuckDB File Path' : 'SQLite File Path'
    }
    filePathInp.placeholder = isDuckdb
      ? '/path/to/analytics.duckdb or :memory:'
      : '/path/to/database.db'
    showEl(rowLibsqlUrl, isLibsql)
    showEl(rowAuthToken, isLibsql || isD1)
    rowAuthToken.classList.toggle('is-full', isD1)
    if (authTokenLabel) authTokenLabel.textContent = isD1 ? 'Cloudflare API Token' : 'Auth Token'
    syncAuthTokenPlaceholder()
    showEl(rowLibsqlDb, isLibsql)
    showEl(rowD1Account, isD1)
    showEl(rowD1Database, isD1)
    showEl(rowD1Endpoint, isD1)
    showEl(rowHost, isServer)
    showEl(rowPort, isServer)
    showEl(rowUser, isServer)
    showEl(rowPassword, isServer)
    showEl(rowDatabase, isServer && next !== 'redis')
    showEl(rowRedisDb, next === 'redis')
    showEl(rowSsl, isServer)
    showEl(tlsSection.root, isServer)
    showEl(sshSection.root, isServer)
    showEl(rowChUrl, hasUrlField)
    if (chUrlLabel) {
      chUrlLabel.textContent = isMongo ? 'Connection URL (Optional / +srv)' : 'HTTP(S) Endpoint URL'
    }
    chUrlInp.placeholder = isMongo
      ? 'mongodb://localhost:27017 or mongodb+srv://...'
      : 'http://localhost:8123'
    showEl(rowOptions, hasOptionsField)
    optionsInp.placeholder =
      nextId === 'snowflake'
        ? 'e.g. account=...,warehouse=...,role=...'
        : nextId === 'bigquery'
          ? 'e.g. projectId=...,location=US'
          : nextId === 'cassandra'
            ? 'e.g. localDataCenter=datacenter1,keyspace=...'
            : 'e.g. --cluster=my-cluster or endpoint=ep-xyz'
    databaseInp.placeholder = meta.defaultDb
    userInp.placeholder = meta.defaultUser || 'Optional'
    if (applyDefaults) {
      const curPort = portInp.value.trim()
      if (!curPort || curPort === String(prevMeta.defaultPort)) {
        portInp.value = meta.defaultPort > 0 ? String(meta.defaultPort) : ''
      }
      sslCheck.input.checked = meta.defaultSsl
      sslModeSel.value = 'auto'
      syncStudioSelectTooltip(sslModeSel, 'TLS Verification Mode')
    }
    reconcileSslCheckWithMode()
    syncTlsUi()
    syncByodBanner()
    renderDiscovered()
  }

  const clearModalFields = (): void => {
    if (isBusy) return
    dockerApplySeq++
    resetFormAuthAndTunnels()
    uriInp.value = ''
    clearActiveAutoUri()
    lastParsedUri = ''
    lastParsedDisplayUri = ''
    lastParsedCandidateId = ''
    nameInp.value = ''
    lastAutoName = ''
    folderGroupInp.value = ''
    workspaceScopeSel.value = ''
    syncStudioSelectTooltip(workspaceScopeSel, 'Workspace Scope (Pin Connection)')
    colorTag = 'none'
    aiPolicySel.value = ''
    syncStudioSelectTooltip(aiPolicySel, 'AI Access Policy')
    syncEnvPills()
    roCheck.input.checked = false
    filePathInp.value = ''
    libsqlUrlInp.value = ''
    libsqlDbInp.value = ''
    d1AccountInp.value = ''
    d1DatabaseInp.value = ''
    d1EndpointInp.value = ''
    hostInp.value = 'localhost'
    portInp.value = ''
    userInp.value = ''
    databaseInp.value = ''
    redisDbSel.value = '0'
    syncStudioSelectTooltip(redisDbSel, 'Redis DB Index')
    chUrlInp.value = ''
    optionsInp.value = ''
    discoveredSearch = ''
    discoverySearchInp.value = ''
    applyDriver(driver, true)
    showNotice('neutral', 'Form cleared.')
    nameInp.focus?.()
  }

  // ---- Submission ----
  const buildSubmission = (id: string): ConnectionSubmission => {
    const name = nameInp.value.trim()
    const readOnly = roCheck.input.checked
    const sameDriverAsStored = isEdit && editProfile?.driver === driver
    const folderValue = folderGroupInp.value.trim().slice(0, 64)
    const scopeValue = (workspaceScopeSel.value || '').trim().slice(0, 260)
    const rawAiPolicy = aiPolicySel.value
    const aiPolicy: ConnectionAiPolicy | undefined =
      rawAiPolicy === 'allow' || rawAiPolicy === 'ask' || rawAiPolicy === 'never'
        ? rawAiPolicy
        : undefined
    const attachFolderScope = <T extends ConnectionProfile>(profile: T): T => {
      profile.folder = folderValue
      profile.workspaceScope = scopeValue
      if (aiPolicy) {
        profile.aiPolicy = aiPolicy
      } else {
        delete profile.aiPolicy
      }
      return profile
    }

    if (isStudioFileDbDriver(driver)) {
      const driverId: string = driver
      const filePath = filePathInp.value.trim()
      const defaultFile = driverId === 'duckdb' ? 'analytics.duckdb' : 'database.db'
      const baseName = filePath.split(/[\\/]/).filter(Boolean).pop() || defaultFile
      return {
        profile: attachFolderScope({
          id,
          name: name || baseName,
          driver,
          database: baseName,
          filePath,
          readOnly,
          colorTag,
        }),
      }
    }

    if (driver === 'd1') {
      const authToken = authTokenInp.value
      const keepStoredToken = sameDriverAsStored && hadAuthToken
      const submission: ConnectionSubmission = {
        profile: attachFolderScope({
          id,
          name: name || d1DatabaseInp.value.trim() || 'Cloudflare D1',
          driver: 'd1',
          database: d1DatabaseInp.value.trim() || 'main',
          d1AccountId: d1AccountInp.value.trim(),
          d1DatabaseId: d1DatabaseInp.value.trim(),
          url: scrubStudioNetworkFormUrl(d1EndpointInp.value) || undefined,
          ssl: true,
          readOnly,
          colorTag,
          hasAuthToken: Boolean(authToken) || keepStoredToken,
        }),
      }
      if (authToken) submission.authToken = authToken
      return submission
    }

    if (driver === 'libsql') {
      const rawUrl = libsqlUrlInp.value.trim()
      const { cleanUrl, defaultName } = sanitizeLibsqlFormUrlAndName(rawUrl)
      const url = cleanUrl || rawUrl
      const authToken = authTokenInp.value
      const keepStoredToken = sameDriverAsStored && hadAuthToken
      const submission: ConnectionSubmission = {
        profile: attachFolderScope({
          id,
          name: name || defaultName,
          driver: 'libsql',
          database: libsqlDbInp.value.trim() || 'turso',
          url,
          ssl: /^(?:https|libsql|wss):\/\//i.test(url) || !/^http:\/\//i.test(url),
          readOnly,
          colorTag,
          hasAuthToken: Boolean(authToken) || keepStoredToken,
        }),
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
    if (isStudioOptionsDriver(driver)) {
      const pgOptions = optionsInp.value.trim()
      if (pgOptions) profile.options = pgOptions
    }
    let urlForcedSsl: boolean | null = null
    if (driver === 'mongodb') {
      const mongoUrl = scrubStudioNetworkFormUrl(chUrlInp.value)
      if (mongoUrl) {
        profile.url = mongoUrl
        try {
          const parsedMongo = new URL(mongoUrl)
          if (parsedMongo.hostname) profile.host = parsedMongo.hostname
          if (parsedMongo.port) {
            const mongoPort = Number.parseInt(parsedMongo.port, 10)
            if (Number.isFinite(mongoPort) && mongoPort >= 1 && mongoPort <= 65535) {
              profile.port = mongoPort
            }
          }
          const mongoTls = parsedMongo.searchParams.get('tls') || parsedMongo.searchParams.get('ssl')
          if (mongoTls === 'true') {
            profile.ssl = true
            urlForcedSsl = true
          } else if (mongoTls === 'false') {
            profile.ssl = false
            urlForcedSsl = false
          }
        } catch {
          // Keep the scrubbed URL string as entered when URL parser fails
        }
      }
    }
    if (driver === 'oracle' && lastOracleParsedUrl) {
      profile.url = scrubStudioNetworkFormUrl(lastOracleParsedUrl)
    }
    if (driver === 'clickhouse') {
      const chUrl = scrubStudioNetworkFormUrl(chUrlInp.value)
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
          if (parsedCh.protocol === 'https:') {
            profile.ssl = true
            urlForcedSsl = true
          } else if (parsedCh.protocol === 'http:') {
            profile.ssl = false
            urlForcedSsl = false
          }
        } catch {
          // Keep the typed URL verbatim when it is not a valid absolute URL
        }
      } else {
        profile.url = `${ssl ? 'https' : 'http'}://${host}:${port}`
      }
    }
    const keepStoredSslPassphrase = sameDriverAsStored && hadSslKeyPassphrase
    const sslKeyPassphrase = sslKeyPassphraseInp.value
    const sslMode = sslModeSel.value
    if (sslMode === 'auto' || sslMode === 'disable' || sslMode === 'require' || sslMode === 'verify-ca' || sslMode === 'verify-full') {
      profile.sslMode = sslMode
    }
    if (urlForcedSsl === false) {
      profile.sslMode = 'disable'
    } else if (urlForcedSsl === true && profile.sslMode === 'disable') {
      profile.sslMode = 'auto'
    }
    const sslCaPath = sslCaPathInp.value.trim()
    const sslCertPath = sslCertPathInp.value.trim()
    const sslKeyPath = sslKeyPathInp.value.trim()
    profile.sslCaPath = sslCaPath
    profile.sslCertPath = sslCertPath
    profile.sslKeyPath = sslKeyPath
    profile.hasSslKeyPassphrase = Boolean(sslKeyPassphrase) || keepStoredSslPassphrase
    profile.sslRejectUnauthorized = sslRejectCheck.input.checked
    if (
      profile.ssl &&
      profile.sslRejectUnauthorized === false &&
      (profile.sslMode === undefined || profile.sslMode === 'auto')
    ) {
      profile.sslMode = 'require'
    }

    const sshEnabled = sshCheck.input.checked
    profile.sshEnabled = sshEnabled
    let sshPassphrase = ''
    let sshPassword = ''
    if (sshEnabled) {
      profile.sshHost = sshHostInp.value.trim()
      const sshPortNum = Number.parseInt(sshPortInp.value.trim(), 10)
      profile.sshPort = Number.isFinite(sshPortNum) && sshPortNum >= 1 && sshPortNum <= 65535 ? sshPortNum : 22
      profile.sshUser = sshUserInp.value.trim()
      const sshAuthMethod = sshAuthSel.value
      if (sshAuthMethod === 'agent' || sshAuthMethod === 'key' || sshAuthMethod === 'password') {
        profile.sshAuthMethod = sshAuthMethod
      }
      if (sshAuthMethod === 'key') {
        const sshKeyPath = sshKeyPathInp.value.trim()
        if (sshKeyPath) profile.sshPrivateKeyPath = sshKeyPath
        sshPassphrase = sshPassphraseInp.value
      }
      if (sshAuthMethod === 'password') sshPassword = sshPasswordInp.value
      profile.hasSshPassphrase =
        Boolean(sshPassphrase) || (sshAuthMethod === 'key' && sameDriverAsStored && hadSshPassphrase)
      profile.hasSshPassword =
        Boolean(sshPassword) || (sshAuthMethod === 'password' && sameDriverAsStored && hadSshPassword)
    }

    const submission: ConnectionSubmission = { profile: attachFolderScope(profile) }
    if (password) submission.password = password
    if (sslKeyPassphrase) submission.sslKeyPassphrase = sslKeyPassphrase
    if (sshPassphrase) submission.sshPassphrase = sshPassphrase
    if (sshPassword) submission.sshPassword = sshPassword
    return submission
  }

  interface ResolvedUriParseTarget {
    uri?: string
    candidateId?: string
    displayUri: string
  }

  // ---- URI parsing ----
  const parseUri = async (
    targetInput: string | ResolvedUriParseTarget,
    clearMissingSecret = false
  ): Promise<boolean> => {
    const target: ResolvedUriParseTarget =
      typeof targetInput === 'string'
        ? { uri: targetInput.trim(), displayUri: targetInput.trim() }
        : {
            ...(targetInput.uri ? { uri: targetInput.uri.trim() } : {}),
            ...(targetInput.candidateId ? { candidateId: targetInput.candidateId.trim() } : {}),
            displayUri: targetInput.displayUri.trim(),
          }
    if (!target.candidateId && !target.uri) return false
    const seq = ++parseSeq
    setButtonLoading(parseBtn, true, 'Parsing...')
    try {
      const payload = target.candidateId ? { candidateId: target.candidateId } : { uri: target.uri }
      const res = await ctx.requestPlugin<ParseUriResponse>('connection.parseUri', payload)
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
      const prevD1Account = d1AccountInp.value.trim()
      const prevD1Database = d1DatabaseInp.value.trim()
      const prevD1Url = d1EndpointInp.value.trim().toLowerCase()
      const nextHost = String(p.host ?? '').trim().toLowerCase()
      const nextUser = String(p.user ?? '').trim()
      const nextLibsqlUrl = String(p.url ?? '').trim().toLowerCase()
      const nextD1Account = String(p.d1AccountId ?? '').trim()
      const nextD1Database = String(p.d1DatabaseId ?? '').trim()
      const nextD1Url = String(p.url ?? '').trim().toLowerCase()
      const targetChanged =
        nextDriver !== prevDriver ||
        (nextDriver === 'libsql'
          ? nextLibsqlUrl !== prevLibsqlUrl
          : nextDriver === 'd1'
            ? nextD1Account !== prevD1Account ||
              nextD1Database !== prevD1Database ||
              nextD1Url !== prevD1Url
            : nextDriver !== 'sqlite' && (nextHost !== prevHost || nextUser !== prevUser))

      // A manually parsed URI defines a fresh target: never inherit another target's stored secret
      const dropStored = clearMissingSecret || (isEdit && targetChanged)
      if (dropStored || res.password !== undefined || res.placeholderPassword) hadPassword = false
      if (dropStored || res.authToken !== undefined) hadAuthToken = false
      if (dropStored) {
        invalidateSslStoredSecret()
        invalidateSshStoredSecrets()
      }
      const nextPassword =
        res.password !== undefined ? res.password : dropStored ? '' : passwordInp.value
      const nextAuthToken =
        res.authToken !== undefined ? res.authToken : dropStored ? '' : authTokenInp.value

      filePathInp.value = ''
      libsqlUrlInp.value = ''
      authTokenInp.value = ''
      libsqlDbInp.value = ''
      d1AccountInp.value = ''
      d1DatabaseInp.value = ''
      d1EndpointInp.value = ''
      hostInp.value = 'localhost'
      portInp.value = ''
      userInp.value = ''
      databaseInp.value = ''
      chUrlInp.value = ''
      optionsInp.value = ''
      redisDbSel.value = '0'
      syncStudioSelectTooltip(redisDbSel, 'Redis Database Index')
      passwordInp.value = ''
      applyDriver(nextDriver, true)
      lastOracleParsedUrl =
        nextDriver === 'oracle' && typeof p.url === 'string' && p.url.trim()
          ? scrubStudioNetworkFormUrl(p.url)
          : ''
      if (p.name) nameInp.value = p.name
      if (p.readOnly !== undefined) roCheck.input.checked = Boolean(p.readOnly)
      if (isStudioFileDbDriver(nextDriver)) {
        filePathInp.value = p.filePath || ''
      } else if (nextDriver === 'libsql') {
        libsqlUrlInp.value = p.url
          ? sanitizeLibsqlFormUrlAndName(p.url).cleanUrl || scrubStudioNetworkFormUrl(p.url)
          : ''
        libsqlDbInp.value = p.database || ''
        authTokenInp.value = nextAuthToken
      } else if (nextDriver === 'd1') {
        d1AccountInp.value = p.d1AccountId || ''
        d1DatabaseInp.value = p.d1DatabaseId || ''
        d1EndpointInp.value = p.url ? scrubStudioNetworkFormUrl(p.url) : ''
        authTokenInp.value = nextAuthToken
      } else {
        if (p.host) hostInp.value = p.host
        if (p.port) portInp.value = String(p.port)
        if (p.user !== undefined) userInp.value = p.user
        if (p.ssl !== undefined) {
          sslCheck.input.checked = Boolean(p.ssl)
        }
        if (
          p.sslMode === 'auto' ||
          p.sslMode === 'disable' ||
          p.sslMode === 'require' ||
          p.sslMode === 'verify-ca' ||
          p.sslMode === 'verify-full'
        ) {
          sslModeSel.value = p.sslMode
          syncStudioSelectTooltip(sslModeSel, 'TLS Verification Mode')
        } else if (p.ssl === false) {
          sslModeSel.value = 'disable'
          syncStudioSelectTooltip(sslModeSel, 'TLS Verification Mode')
        } else if (p.ssl && sslModeSel.value === 'disable') {
          sslModeSel.value = 'auto'
          syncStudioSelectTooltip(sslModeSel, 'TLS Verification Mode')
        }
        if (p.sslRejectUnauthorized !== undefined) {
          sslRejectCheck.input.checked = Boolean(p.sslRejectUnauthorized)
        } else if (p.sslMode === 'require') {
          sslRejectCheck.input.checked = false
        } else {
          sslRejectCheck.input.checked = true
        }
        reconcileSslCheckWithMode()
        if (nextDriver === 'redis') {
          redisDbSel.value = String(p.redisDb ?? 0)
          syncStudioSelectTooltip(redisDbSel, 'Redis Database Index')
        } else if (p.database !== undefined) {
          databaseInp.value = p.database
        }
        if ((nextDriver === 'clickhouse' || nextDriver === 'mongodb') && p.url) {
          chUrlInp.value = scrubStudioNetworkFormUrl(p.url)
        }
        if (
          isStudioOptionsDriver(nextDriver) &&
          typeof p.options === 'string' &&
          p.options.trim()
        ) {
          optionsInp.value = p.options.trim()
        }
        passwordInp.value = nextPassword
      }
      authTokenInp.placeholder =
        hadAuthToken && isEdit ? 'Stored token preserved (type to replace)' : 'Optional Bearer token'
      syncAuthTokenPlaceholder()
      lastParsedUri = target.uri || ''
      lastParsedCandidateId = target.candidateId || ''
      lastParsedDisplayUri = target.displayUri || (target.uri ? maskUriSecret(target.uri) : '')
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
      syncTlsUi()
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
    const target = resolveUriInputForParse()
    if (!target.candidateId && !target.uri) {
      return true
    }
    if (
      target.candidateId &&
      lastParsedCandidateId &&
      target.candidateId === lastParsedCandidateId &&
      target.displayUri === lastParsedDisplayUri
    ) {
      return true
    }
    if (
      target.uri &&
      (target.uri === lastParsedUri ||
        (lastParsedUri && target.displayUri === maskUriSecret(lastParsedUri)) ||
        (lastParsedDisplayUri && target.displayUri === lastParsedDisplayUri))
    ) {
      return true
    }
    return await parseUri(target, false)
  }

  const validateRequiredFields = (): boolean => {
    const driverId: string = driver
    if (isStudioFileDbDriver(driverId) && !filePathInp.value.trim()) {
      showNotice(
        'error',
        driverId === 'duckdb'
          ? 'Please enter a DuckDB database file path (or :memory:).'
          : 'Please enter a SQLite database file path.'
      )
      return false
    }
    if (driver === 'libsql' && !libsqlUrlInp.value.trim()) {
      showNotice('error', 'Please enter a LibSQL / Turso URL.')
      return false
    }
    if (driver === 'd1') {
      const account = d1AccountInp.value.trim()
      const database = d1DatabaseInp.value.trim()
      const customUrl = d1EndpointInp.value.trim()
      if (!customUrl && (!account || !database)) {
        showNotice(
          'error',
          'Please enter both a Cloudflare Account ID and D1 Database ID (or a custom endpoint URL).'
        )
        if (!account) d1AccountInp.focus?.()
        else d1DatabaseInp.focus?.()
        return false
      }
    }
    if (
      !isStudioFileDbDriver(driver) &&
      driver !== 'libsql' &&
      driver !== 'd1' &&
      sshCheck.input.checked
    ) {
      const sshHost = sshHostInp.value.trim()
      const sshUser = sshUserInp.value.trim()
      const sshKeyPath = sshKeyPathInp.value.trim()
      const sshPortRaw = sshPortInp.value.trim()
      const sshPortNum = Number.parseInt(sshPortRaw, 10)
      const failSsh = (message: string, focusEl?: HTMLElement): false => {
        sshSection.setExpanded(true)
        showNotice('error', message)
        noticeBox.setAttribute('role', 'alert')
        focusEl?.focus?.()
        return false
      }
      const injected: Array<[string, string, HTMLElement]> = [
        ['Bastion Host', sshHost, sshHostInp],
        ['SSH Username', sshUser, sshUserInp],
      ]
      if (sshAuthSel.value === 'key') {
        injected.push(['Private Key Path', sshKeyPath, sshKeyPathInp])
      }
      const bad = injected.filter(([, value]) => value.startsWith('-'))
      if (bad.length > 0) {
        return failSsh(
          `${bad.map(([label]) => label).join(', ')} must not start with "-" — ssh option injection is blocked.`,
          bad[0]?.[2]
        )
      }
      if (!sshHost) {
        return failSsh('Please enter a Bastion Host for the SSH tunnel.', sshHostInp)
      }
      if (!sshUser) {
        return failSsh('Please enter an SSH Username for the SSH tunnel.', sshUserInp)
      }
      if (!/^\d+$/.test(sshPortRaw) || !Number.isFinite(sshPortNum) || sshPortNum < 1 || sshPortNum > 65535) {
        return failSsh('SSH Port must be a whole number between 1 and 65535.', sshPortInp)
      }
      if (sshAuthSel.value === 'key' && !sshKeyPath) {
        return failSsh(
          'Please enter the SSH Private Key Path for key authentication.',
          sshKeyPathInp
        )
      }
    }
    return true
  }

  const ensurePasswordBeforeSubmit = (): boolean => {
    if (isStudioFileDbDriver(driver) || driver === 'libsql' || driver === 'd1') {
      return true
    }
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
      discoveredDocker = Array.isArray(wsRes?.dockerComposeConnections)
        ? wsRes.dockerComposeConnections
        : []
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
      const wsDirs = Array.isArray(wsRes?.scannedDirs)
        ? wsRes.scannedDirs.map((d) => String(d || '').trim()).filter(Boolean)
        : []
      const folderScoped = wsRes?.folderScoped ?? Boolean(folder)
      discoveredDockerScopeLabel =
        wsRes?.dockerScopeLabel === 'Docker Context' || wsRes?.dockerIsLocal === false
          ? 'Docker Context'
          : 'Local Docker'
      if (wsDirs.length > 0) {
        discoveryScopeNote.title = wsDirs.join(', ')
        if (folderScoped) {
          const shortName = extractScannedFolderName(wsDirs[0])
          discoveryScopeNote.textContent = `Scanned folder: ${shortName} (Compose files and matching containers inside this folder only).`
        } else {
          const folderSummary =
            wsDirs.length === 1
              ? '1 local workspace folder'
              : `${wsDirs.length} local workspace folders`
          if (discoveredDockerScopeLabel === 'Docker Context') {
            discoveryScopeNote.textContent = `Scanned ${folderSummary} · Plus active Docker Context containers (non-workspace labeled "Other Docker Context").`
          } else {
            discoveryScopeNote.textContent = `Scanned ${folderSummary} · Plus local Docker containers (non-workspace labeled "Other Local Docker").`
          }
        }
      } else {
        discoveryScopeNote.title = ''
      }
      discoveryCollapsed.env = null
      discoveryCollapsed.docker = null
      discoveryCollapsed.sqlite = null
      if (
        manual &&
        discoveredEnvs.length === 0 &&
        discoveredDocker.length === 0 &&
        discoveredFiles.length === 0
      ) {
        showNotice('neutral', 'No .env connections, Docker Compose databases, or SQLite files found.')
      }
    } catch (err: unknown) {
      if (seq !== detectSeq || !isModalOpen()) return
      discoveredEnvs = []
      discoveredDocker = []
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
      if (!(await ensureUriParsed()) || !isModalOpen()) return
      if (!validateRequiredFields() || !ensurePasswordBeforeSubmit()) return
      showNotice('neutral', 'Testing connection...')
      const sub = buildSubmission(editId || `conn_test_${Date.now()}`)
      const res = await ctx.requestPlugin<{ ok: boolean; message?: string }>(
        'connection.test',
        sub,
        { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
      )
      if (!isModalOpen()) return
      showNotice(
        res.ok ? 'success' : 'error',
        res.message ||
          (res.ok ? 'Connection verified' : 'Connection test failed.')
      )
    } catch (err: unknown) {
      if (!isModalOpen()) return
      showNotice('error', `Error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      stopTimer()
      if (isModalOpen()) {
        setButtonLoading(testBtn, false)
        setBusy(false)
      }
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
      if (!(await ensureUriParsed()) || !isModalOpen()) return
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
        if (!isModalOpen()) return
        if (!testRes.ok) {
          showNotice('error', testRes.message || 'Connection test failed.')
          return
        }
      } catch (testErr: unknown) {
        if (!isModalOpen()) return
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
      if (!isModalOpen()) return
      if (!res.ok) {
        showNotice('error', 'Failed to save connection.')
        return
      }
      savedId = res.id || targetId
    } catch (err: unknown) {
      if (!isModalOpen()) return
      showNotice('error', `Error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      stopTimer()
      if (isModalOpen()) {
        setButtonLoading(saveBtn, false)
        setBusy(false)
      }
    }
    if (!savedId) return
    if (isModalOpen()) closeModalClean()
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
        if (isModalOpen()) deleteBtn.textContent = 'Delete Connection'
      }, 4000)
      return
    }
    clearDeleteTimer()
    setBusy(true)
    setButtonLoading(deleteBtn, true, 'Deleting...')
    let deleted = false
    try {
      const res = await ctx.requestPlugin<{ ok: boolean }>('connection.delete', { id: editId })
      if (!res.ok) {
        if (isModalOpen()) showNotice('error', 'Failed to delete connection.')
        return
      }
      deleted = true
    } catch (err: unknown) {
      if (isModalOpen()) {
        showNotice('error', `Delete failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      setButtonLoading(deleteBtn, false)
      setBusy(false)
    }
    if (!deleted) return
    if (isModalOpen()) closeModalClean()
    await ctx.onConnectionDeleted(editId)
  }

  const resolveUriInputForParse = (): ResolvedUriParseTarget => {
    const displayUri = uriInp.value.trim()
    if (activeAutoDisplayUri !== null && displayUri === activeAutoDisplayUri) {
      if (activeAutoCandidateId) {
        return { candidateId: activeAutoCandidateId, displayUri }
      }
      if (activeAutoRawUri) {
        return { uri: activeAutoRawUri, displayUri }
      }
    } else if (
      activeAutoDisplayUri !== null ||
      activeAutoCandidateId !== null ||
      activeAutoRawUri !== null
    ) {
      clearActiveAutoUri()
    }
    return { uri: displayUri, displayUri }
  }

  uriInp.addEventListener('input', () => {
    clearActiveAutoUri()
  })
  parseBtn.addEventListener('click', () => {
    if (isBusy) return
    const target = resolveUriInputForParse()
    if (!target.candidateId && !target.uri) {
      showNotice('error', 'Paste a connection URI first.')
      return
    }
    void parseUri(target, false)
  })
  uriInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const target = resolveUriInputForParse()
      if (!isBusy && (target.candidateId || target.uri)) void parseUri(target, false)
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
  clearBtn.addEventListener('click', () => {
    clearModalFields()
  })
  saveBtn.addEventListener('click', () => {
    void runSave()
  })
  deleteBtn.addEventListener('click', () => {
    void runDelete()
  })
  cancelBtn.addEventListener('click', () => {
    if (!isBusy) closeModalClean()
  })

  // ---- Initial population ----
  const hasCustomTls = Boolean(
    editProfile &&
      ((editProfile.sslMode &&
        editProfile.sslMode !== 'auto' &&
        editProfile.sslMode !== 'disable') ||
        editProfile.sslCaPath ||
        editProfile.sslCertPath ||
        editProfile.sslKeyPath ||
        editProfile.hasSslKeyPassphrase ||
        editProfile.sslRejectUnauthorized === false)
  )
  const sshEnabledInitially = Boolean(editProfile?.sshEnabled)
  if (editProfile) {
    nameInp.value = editProfile.name || ''
    const meta = getStudioEngineMeta(driver)
    if (isStudioFileDbDriver(driver)) {
      filePathInp.value = editProfile.filePath || editProfile.database || ''
    } else if (driver === 'libsql') {
      libsqlUrlInp.value = editProfile.url
        ? sanitizeLibsqlFormUrlAndName(editProfile.url).cleanUrl ||
          scrubStudioNetworkFormUrl(editProfile.url)
        : ''
      libsqlDbInp.value = editProfile.database || ''
      if (hadAuthToken) authTokenInp.placeholder = 'Stored token preserved (type to replace)'
    } else if (driver === 'd1') {
      d1AccountInp.value = editProfile.d1AccountId || ''
      d1DatabaseInp.value = editProfile.d1DatabaseId || ''
      d1EndpointInp.value = editProfile.url ? scrubStudioNetworkFormUrl(editProfile.url) : ''
      if (hadAuthToken) authTokenInp.placeholder = 'Stored token preserved (type to replace)'
    } else {
      const editHost = editProfile.host || 'localhost'
      hostInp.value = editHost
      portInp.value = String(editProfile.port || meta.defaultPort)
      userInp.value = editProfile.user || ''
      const isCloudAutoSsl =
        editProfile.ssl === undefined &&
        editProfile.sslMode !== 'disable' &&
        (driver === 'cockroachdb' || isCloudDatabaseHost(editHost))
      sslCheck.input.checked =
        editProfile.sslMode === 'disable'
          ? false
          : editProfile.ssl !== undefined
            ? Boolean(editProfile.ssl)
            : isCloudAutoSsl
      if (driver === 'redis') {
        redisDbSel.value = String(editProfile.redisDb ?? 0)
      } else {
        databaseInp.value = editProfile.database || ''
      }
      if (driver === 'clickhouse' || driver === 'mongodb') {
        chUrlInp.value = editProfile.url ? scrubStudioNetworkFormUrl(editProfile.url) : ''
      }
      if (typeof editProfile.options === 'string') optionsInp.value = editProfile.options
      if (hadPassword) passwordInp.placeholder = 'Stored password preserved (type to replace)'
      sslModeSel.value = editProfile.sslMode || 'auto'
      sslCaPathInp.value = editProfile.sslCaPath || ''
      sslCertPathInp.value = editProfile.sslCertPath || ''
      sslKeyPathInp.value = editProfile.sslKeyPath || ''
      if (editProfile.hasSslKeyPassphrase) {
        sslKeyPassphraseInp.placeholder = '(stored securely — leave blank to keep)'
      }
      sslRejectCheck.input.checked =
        editProfile.sslRejectUnauthorized !== undefined
          ? Boolean(editProfile.sslRejectUnauthorized)
          : editProfile.sslMode !== 'require'
      sshCheck.input.checked = sshEnabledInitially
      sshHostInp.value = editProfile.sshHost || ''
      sshPortInp.value = String(editProfile.sshPort || 22)
      sshUserInp.value = editProfile.sshUser || ''
      sshAuthSel.value = editProfile.sshAuthMethod || 'agent'
      sshKeyPathInp.value = editProfile.sshPrivateKeyPath || ''
      if (editProfile.hasSshPassphrase) {
        sshPassphraseInp.placeholder = '(stored securely — leave blank to keep)'
      }
      if (editProfile.hasSshPassword) {
        sshPasswordInp.placeholder = '(stored securely — leave blank to keep)'
      }
    }
    applyDriver(driver, false)
  } else {
    hostInp.value = 'localhost'
    applyDriver(driver, true)
  }
  tlsSection.setExpanded(hasCustomTls || options?.focusSection === 'tls')
  sshSection.setExpanded(sshEnabledInitially)
  syncTlsUi()
  syncSshUi()
  syncEnvPills()
  syncStudioSelectTooltip(redisDbSel, 'Redis DB Index')
  syncStudioSelectTooltip(sslModeSel, 'SSL Mode')
  syncStudioSelectTooltip(sshAuthSel, 'SSH Auth Method')
  syncStudioSelectTooltip(aiPolicySel, 'AI Access Policy')

  modal.appendChild(head)
  modal.appendChild(noticeBox)
  modal.appendChild(body)
  modal.appendChild(actions)
  backdropRef = ctx.mountModal(modal, () => {
    if (isBusy) return false
    closeActiveStudioCollapsibleDropdown()
    return true
  })
  if (!backdropRef) return
  if (options?.focusSection === 'tls') {
    tlsSection.root.scrollIntoView?.({ block: 'center' })
    sslModeSel.focus?.()
  } else if (options?.focusSection === 'ai') {
    rowAiPolicy.scrollIntoView?.({ block: 'center' })
    aiPolicySel.focus?.()
  } else if (isEdit) {
    nameInp.focus?.()
    nameInp.select?.()
  } else {
    uriInp.focus?.()
  }
}
