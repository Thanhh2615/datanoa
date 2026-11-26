// src/panel/panel-connection-form.js
// Side Panel Connection Form, Engine Selector, URI Parser & Workspace Auto-Discovery

import { findCredentialAuthorityAtIndex, isCloudDatabaseHost } from '../shared-sql-safety.js'
import {
  ENGINES,
  ENGINE_BY_ID,
  compactPathLabel,
  maskConnectionUriSecret,
} from './panel-core.js'
import {
  $,
  setDbLogoElement,
  rpc,
  setButtonLoading,
  getFolderSvgMarkup,
  enhanceCollapsibleSelectDropdown,
  syncSelectTooltip,
  openPanelFilePickerModal,
  writeTextToClipboard,
} from './panel-utils.js'

function deriveSmartSqliteConnName(filePath) {
  const parts = String(filePath || '')
    .split(/[\\/]/)
    .filter(Boolean)
  const base = parts[parts.length - 1] || 'database.db'
  const parent = parts.length > 1 ? parts[parts.length - 2] : ''
  const stem = base.replace(/\.(?:db|sqlite|sqlite3|db3)$/i, '')
  if (!stem || stem === '.' || stem.startsWith('.')) {
    return parent ? `${parent}/${base}` : base
  }
  return base
}

function extractScannedFolderName(rawPath) {
  const trimmed = String(rawPath || '').trim().replace(/[\\/]+$/, '')
  if (!trimmed) return String(rawPath || '').trim()
  const parts = trimmed.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || trimmed
}

export function formatConnSubtitle(conn) {
  if (!conn) return ''
  if (conn.driver === 'sqlite' || conn.driver === 'duckdb') return conn.filePath || conn.database
  if (conn.driver === 'libsql') return conn.url ? maskConnectionUriSecret(conn.url) : conn.database
  if (conn.driver === 'd1') {
    const acct = String(conn.d1AccountId || '').trim()
    const dbId = String(conn.d1DatabaseId || conn.database || '').trim()
    if (acct && dbId) return `${acct}/${dbId}`
    if (dbId) return dbId
    if (conn.url) return maskConnectionUriSecret(conn.url)
    return 'Cloudflare D1'
  }
  if (conn.driver === 'redis') {
    const db = conn.redisDb ?? 0
    return `${conn.host || 'localhost'}:${conn.port || 6379}/db${db}`
  }
  const meta = ENGINE_BY_ID[conn.driver]
  const port = conn.port || meta?.defaultPort || 5432
  return `${conn.user ? `${conn.user}@` : ''}${conn.host || 'localhost'}:${port}/${conn.database}`
}

const SENSITIVE_PANEL_LIBSQL_PARAM_RE =
  /^(?:api[-_]?key|apikey|auth[-_]?token|authtoken|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|private[-_]?key|credentials?|authorization|sig(?:nature)?|token|pass(?:word|wd|phrase)?|pwd|secret|key|jwt|bearer)$/i

const FALLBACK_PANEL_SECRET_QUERY_KV_RE =
  /([?&#])(?:[^=&\s#]*(?:api[-_]?key|apikey|auth[-_]?token|authtoken|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|private[-_]?key|token|jwt|secret|pass(?:word|wd|phrase)?|pwd|bearer|credentials?|authorization|key)|sig(?:nature)?)=[^&\s#]*/gi

function stripEmbeddedPanelSchemeCredentials(raw) {
  return raw.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s'"<>(),;]+)/g, (full, scheme, rest) => {
    const delimIdx = rest.search(/[:/?#@]/)
    if (delimIdx < 0 || rest[delimIdx] !== ':') return full
    const atIdx = findCredentialAuthorityAtIndex(scheme, rest, delimIdx)
    return atIdx > 0 ? `${scheme}${rest.slice(atIdx + 1)}` : full
  })
}

function scrubFallbackPanelUrlText(raw) {
  return stripEmbeddedPanelSchemeCredentials(String(raw || ''))
    .replace(FALLBACK_PANEL_SECRET_QUERY_KV_RE, '$1')
    .replace(/\?&+/g, '?')
    .replace(/#&+/g, '#')
    .replace(/[?&]+#/g, '#')
    .replace(/&{2,}/g, '&')
    .replace(/[?&#]+(?=$|\s)/g, '')
}

function scrubParsedPanelUrlSecrets(parsed) {
  parsed.username = ''
  parsed.password = ''
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (SENSITIVE_PANEL_LIBSQL_PARAM_RE.test(key)) {
      parsed.searchParams.delete(key)
    }
  }
  if (parsed.hash.length > 1) {
    const rawFrag = parsed.hash.slice(1)
    const qIdx = rawFrag.indexOf('?')
    const cleanPairs = (seg) =>
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
            SENSITIVE_PANEL_LIBSQL_PARAM_RE.test(rawKey) ||
            SENSITIVE_PANEL_LIBSQL_PARAM_RE.test(decodedKey)
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

function parsePanelNetworkUrlSafely(rawWithScheme) {
  try {
    const direct = new URL(rawWithScheme)
    if (direct.username === '' && direct.password === '' && direct.port !== '') {
      const recovered = stripEmbeddedPanelSchemeCredentials(rawWithScheme)
      if (recovered !== rawWithScheme) {
        return new URL(recovered)
      }
    }
    return direct
  } catch {
    return null
  }
}

function sanitizePanelLibsqlUrlAndName(rawUrl) {
  const trimmed = String(rawUrl || '').trim()
  if (!trimmed) return { cleanUrl: '', defaultName: 'LibSQL' }
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
  const parsed = parsePanelNetworkUrlSafely(withScheme)
  if (!parsed) {
    return { cleanUrl: scrubFallbackPanelUrlText(trimmed), defaultName: 'LibSQL' }
  }
  const hostname = parsed.hostname || 'LibSQL'
  scrubParsedPanelUrlSecrets(parsed)
  const cleanPath =
    parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : ''
  const cleanSearch = parsed.searchParams.toString()
  const cleanUrl = `${parsed.protocol}//${parsed.host}${cleanPath}${cleanSearch ? `?${cleanSearch}` : ''}`
  return { cleanUrl, defaultName: hostname }
}

function scrubPanelNetworkFormUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim()
  if (!trimmed) return ''
  const parsed = parsePanelNetworkUrlSafely(trimmed)
  if (!parsed) {
    return scrubFallbackPanelUrlText(trimmed)
  }
  scrubParsedPanelUrlSecrets(parsed)
  return parsed.toString()
}

function isPanelOptionsDriver(driver) {
  return (
    driver === 'postgres' ||
    driver === 'cockroachdb' ||
    driver === 'snowflake' ||
    driver === 'bigquery' ||
    driver === 'cassandra'
  )
}

export function createPanelConnectionFormController(ctx) {
  const {
    state,
    showBanner,
    showFormNotice,
    clearFormNotice,
    setFormOpen,
    updateViewportLayout,
    savePanelViewState,
    copyText,
  } = ctx

  let detectSeq = 0
  let parseUriSeq = 0
  let refreshByodSeq = 0
  let dockerApplySeq = 0
  let byodActionBusy = false
  let activeAutoCandidateId = null
  let activeAutoRawUri = null
  let activeAutoDisplayUri = null
  let lastParsedDisplayUri = ''
  let lastParsedCandidateId = ''

  function clearActiveAutoUri() {
    activeAutoCandidateId = null
    activeAutoRawUri = null
    activeAutoDisplayUri = null
  }

  function syncSslVerifyUi() {
    const sslOn = Boolean($('formSsl')?.checked)
    const verifyRow = $('sslVerifyRow')
    const verifyEl = $('formSslVerify')
    if (verifyRow) {
      verifyRow.hidden = !sslOn
    }
    if (verifyEl) {
      if (state.formSslMode === 'verify-ca' || state.formSslMode === 'verify-full') {
        verifyEl.checked = true
        verifyEl.disabled = true
      } else if (sslOn) {
        verifyEl.disabled = false
        verifyEl.checked =
          state.formSslRejectUnauthorized !== undefined
            ? state.formSslRejectUnauthorized !== false
            : state.formSslMode !== 'require'
      } else {
        verifyEl.disabled = true
        verifyEl.checked = true
      }
    }
  }
  const BYOD_IDS = new Set([
    'duckdb',
    'snowflake',
    'bigquery',
    'cassandra',
    'elasticsearch',
    'neo4j',
    'custom',
  ])
  const BYOD_NPM_PKGS = {
    duckdb: '@duckdb/node-api',
    snowflake: 'snowflake-sdk',
    bigquery: '@google-cloud/bigquery',
    cassandra: 'cassandra-driver',
    elasticsearch: '@elastic/elasticsearch',
    neo4j: 'neo4j-driver',
    custom: '',
  }
  const byodDefaultDirs = {}
  let byodHostPlatform = 'win32'
  let byodRegistryMap = new Map()
  let byodPendingSha = new Map()
  let byodStarterTemplates = {}

  function buildPanelByodCmd(driverId, folderPath) {
    const rawDir = (folderPath || '').replace(/[\r\n\0]/g, '').trim().replace(/[/\\]index\.m?js$/i, '')
    const fallbackDir =
      byodDefaultDirs[driverId] ||
      (byodHostPlatform === 'win32'
        ? `C:\\datanoa-drivers\\${driverId}`
        : `$HOME/datanoa-drivers/${driverId}`)
    const cleanDir = rawDir || fallbackDir
    const pkg = BYOD_NPM_PKGS[driverId] || ''
    const installStep = pkg ? ` && npm install --ignore-scripts ${pkg}` : ''
    if (byodHostPlatform === 'win32') {
      const psQuoted = `'${cleanDir.replace(/'/g, "''")}'`
      const psInstall = pkg ? `; if ($?) { npm install --ignore-scripts ${pkg} }` : ''
      return (
        `New-Item -ItemType Directory -Force -Path ${psQuoted} | Out-Null; ` +
        `Set-Location -LiteralPath ${psQuoted}; ` +
        `if ($?) { npm init -y }; ` +
        `if ($?) { npm pkg set type=module main=index.mjs }${psInstall}`
      )
    }
    const posixQuoted = cleanDir.startsWith('$HOME/')
      ? `"$HOME/${cleanDir.slice('$HOME/'.length).replace(/(["$`\\])/g, '\\$1')}"`
      : `'${cleanDir.replace(/'/g, `'\\''`)}'`
    return `mkdir -p ${posixQuoted} && cd ${posixQuoted} && npm init -y && npm pkg set type=module main=index.mjs${installStep}`
  }

  function syncPanelByodBox() {
    const box = $('panelByodSetupBox')
    if (!box) return
    const driver = state.formDriver
    if (!BYOD_IDS.has(driver)) {
      box.hidden = true
      return
    }
    box.hidden = false
    const meta = ENGINE_BY_ID[driver]
    const item = byodRegistryMap.get(driver)
    const isVerified = item?.status === 'local-verified'
    $('panelByodTitle').textContent = `${meta?.label || driver} — Local Driver Setup (BYOD)`
    const badge = $('panelByodStatusBadge')
    badge.className = `badge ${isVerified ? 'badge-ok' : 'badge-neutral'}`
    badge.textContent = isVerified
      ? `Verified (${(item?.sha256 || '').slice(0, 8)}…)`
      : 'Not Configured'
    const hasNpmPkg = Boolean(BYOD_NPM_PKGS[driver])
    $('panelByodGuide').textContent = isVerified
      ? `Verified from "${item?.resolvedEntry || item?.localPath}". Ready to connect.`
      : hasNpmPkg
        ? `Choose a folder for the ${meta?.label || driver} driver, click "Create Folder & Copy Cmd", run it in Terminal, then click "Trust & Verify".`
        : `Choose a folder for your custom driver, click "Create Folder & Starter", then click "Inspect SHA-256" and "Trust & Verify".`
    if ($('panelByodAutoSetupBtn')) {
      $('panelByodAutoSetupBtn').textContent = hasNpmPkg
        ? 'Create Folder & Copy Cmd'
        : 'Create Folder & Starter'
    }
    const folderInp = $('panelByodFolderInput')
    const resolvedDefault = item?.localPath || byodDefaultDirs[driver] || ''
    if (
      !folderInp.value.trim() ||
      folderInp.dataset.driver !== driver ||
      (folderInp.dataset.isFallback === '1' && resolvedDefault)
    ) {
      folderInp.dataset.driver = driver
      if (resolvedDefault) {
        folderInp.value = resolvedDefault
        folderInp.dataset.isFallback = '0'
      } else {
        folderInp.value =
          byodHostPlatform === 'win32'
            ? `C:\\datanoa-drivers\\${driver}`
            : `$HOME/datanoa-drivers/${driver}`
        folderInp.dataset.isFallback = '1'
      }
    }
    $('panelByodCmdInput').value = buildPanelByodCmd(driver, folderInp.value)
    $('panelByodTrustBtn').disabled = !byodPendingSha.get(driver)
  }

  async function refreshPanelByodAndWorkspaces() {
    const reqSeq = ++refreshByodSeq
    try {
      const [drvRes, defRes, wsRes] = await Promise.all([
        rpc('drivers.list').catch(() => null),
        rpc('drivers.defaultPaths').catch(() => null),
        rpc('workspace.listScopes').catch(() => null),
      ])
      if (reqSeq !== refreshByodSeq) return
      if (defRes?.platform) {
        byodHostPlatform = defRes.platform
      }
      if (defRes?.paths) {
        Object.assign(byodDefaultDirs, defRes.paths)
      }
      if (defRes?.templates && typeof defRes.templates === 'object') {
        byodStarterTemplates = { ...byodStarterTemplates, ...defRes.templates }
      }
      const list = Array.isArray(drvRes) ? drvRes : Array.isArray(drvRes?.drivers) ? drvRes.drivers : []
      byodRegistryMap = new Map(list.filter((i) => i?.id).map((i) => [i.id, i]))
      syncPanelByodBox()

      const wsSel = $('formWorkspaceScope')
      if (wsSel) {
        const desiredScope =
          typeof state.pendingWorkspaceScope === 'string'
            ? state.pendingWorkspaceScope
            : wsSel.value
        wsSel.textContent = ''
        const gOpt = document.createElement('option')
        gOpt.value = ''
        gOpt.textContent = 'Global — Available in All Workspaces (No Pin)'
        gOpt.dataset.fullTitle = 'Global — Available in All Workspaces (No Pin)'
        wsSel.appendChild(gOpt)

        const rawWs = Array.isArray(wsRes?.workspaces) ? wsRes.workspaces : []
        const seen = new Set()
        const byProject = new Map()
        for (const w of rawWs) {
          if (!w?.id || seen.has(w.id)) continue
          seen.add(w.id)
          if (w.isCurrent) {
            const cOpt = document.createElement('option')
            cOpt.value = w.id
            const shortCur = `${w.name}${w.branch ? ` (${w.branch})` : ''}`
            cOpt.textContent = `Current Workspace: ${shortCur}`
            cOpt.dataset.subtitle = w.path || ''
            cOpt.dataset.fullTitle = `Current Workspace: ${w.label}`
            cOpt.dataset.isCurrent = '1'
            wsSel.appendChild(cOpt)
            continue
          }
          const proj = (w.projectFolder || w.name || 'Workspaces').trim()
          if (!byProject.has(proj)) byProject.set(proj, [])
          byProject.get(proj).push(w)
        }

        const sortedProjects = Array.from(byProject.keys()).sort((a, b) => a.localeCompare(b))
        for (const proj of sortedProjects) {
          const grp = document.createElement('optgroup')
          grp.label = proj
          for (const w of byProject.get(proj)) {
            const opt = document.createElement('option')
            opt.value = w.id
            opt.textContent = `${w.name}${w.branch ? ` (${w.branch})` : ''}`
            opt.dataset.subtitle = w.path || ''
            opt.dataset.fullTitle = `[${proj}] ${w.label}`
            opt.dataset.isCurrent = w.isCurrent ? '1' : '0'
            grp.appendChild(opt)
          }
          wsSel.appendChild(grp)
        }

        if (desiredScope) {
          if (!seen.has(desiredScope)) {
            const savedOpt = document.createElement('option')
            savedOpt.value = desiredScope
            savedOpt.textContent = `Saved Scope: ${desiredScope}`
            savedOpt.dataset.fullTitle = `Saved Scope: ${desiredScope}`
            wsSel.appendChild(savedOpt)
          }
          wsSel.value = desiredScope
        } else {
          wsSel.value = ''
        }
        state.pendingWorkspaceScope = null
        syncSelectTooltip(wsSel)
        enhanceCollapsibleSelectDropdown(wsSel, {
          tooltipPrefix: 'Workspace Scope (Pin Connection)',
          searchPlaceholder: 'Search workspaces by name, branch, or project folder...',
          searchAriaLabel: 'Search workspaces',
          defaultCollapseNonActiveFolders: true,
          leadingIconType: 'workspace',
        })
      }
    } catch {}
  }

  function renderPanelFolderChips() {
    const wrap = $('formFolderChips')
    if (!wrap) return
    wrap.textContent = ''
    const existing = Array.isArray(state.connections)
      ? state.connections.map((c) => (c?.folder || '').trim()).filter(Boolean)
      : []
    const folders = Array.from(new Set(existing)).sort((a, b) => a.localeCompare(b))
    if (folders.length === 0) {
      wrap.hidden = true
      return
    }
    wrap.hidden = false
    for (const fName of folders) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'btn btn-sm'
      btn.title = `Assign to existing folder "${fName}"`
      const ico = document.createElement('span')
      ico.style.display = 'inline-flex'
      ico.style.color = 'var(--info)'
      ico.innerHTML = getFolderSvgMarkup(false, 12)
      const txt = document.createElement('span')
      txt.textContent = fName
      btn.append(ico, txt)
      btn.addEventListener('click', () => {
        if ($('formFolder')) {
          $('formFolder').value = fName
          savePanelViewState?.()
        }
      })
      wrap.appendChild(btn)
    }
  }

  function isProdTagValue(tag) {
    const norm = String(tag || '').trim().toLowerCase()
    return norm === 'prod' || norm === 'production'
  }

  function syncAiPolicyHint() {
    const hintEl = $('formAiPolicyHint')
    if (!hintEl) return
    const isProd = isProdTagValue(state.formColorTag)
    const policy = $('formAiPolicy')?.value || ''
    hintEl.hidden = !isProd
    if (isProd) {
      hintEl.textContent =
        policy === 'allow'
          ? 'Production tag active — AI access is explicitly allowed for this connection.'
          : policy === 'never'
            ? 'Production tag active — AI access is blocked for this connection.'
            : 'Production connections default to ask/fail-closed protection for remote AI unless explicitly overridden.'
    }
  }

  function clearStoredSecretFlags() {
    state.formHadPassword = false
    state.formHadAuthToken = false
    state.sourceSecretConnId = null
    if ($('formPassword') && !$('formPassword').value) {
      $('formPassword').placeholder = 'Optional'
    }
    if ($('formAuthToken') && !$('formAuthToken').value) {
      $('formAuthToken').placeholder = 'Optional Bearer token'
    }
  }

  function setFormColorTag(tag) {
    const norm = String(tag || '').trim().toLowerCase()
    const mapped = norm === 'production' ? 'prod' : norm
    state.formColorTag = ['dev', 'staging', 'prod'].includes(mapped) ? mapped : 'none'
    document.querySelectorAll('.env-pill').forEach((p) => {
      p.classList.toggle('active', p.dataset.env === state.formColorTag)
    })
    syncAiPolicyHint()
    savePanelViewState?.()
  }

  function setFormDriver(driver, applyDefaults = true) {
    const prevDriver = state.formDriver
    const valid = ENGINE_BY_ID[driver] && !ENGINE_BY_ID[driver].studioOnly ? driver : 'sqlite'
    if (applyDefaults && prevDriver && prevDriver !== valid) {
      clearStoredSecretFlags()
    }
    state.formDriver = valid
    document.querySelectorAll('.engine-tile').forEach((tile) => {
      tile.classList.toggle('active', tile.dataset.driver === valid)
    })

    const isSqlite = valid === 'sqlite'
    const isDuckdb = valid === 'duckdb'
    const isFileDb = isSqlite || isDuckdb
    const isLibsql = valid === 'libsql'
    const isRedis = valid === 'redis'
    const isClickhouse = valid === 'clickhouse'
    const isMongo = valid === 'mongodb'
    const hasUrlRow = isClickhouse || isMongo
    const hasOptionsRow = isPanelOptionsDriver(valid)

    $('sqliteFields').hidden = !isFileDb
    $('libsqlFields').hidden = !isLibsql
    $('serverFields').hidden = isFileDb || isLibsql
    $('clickhouseUrlRow').hidden = !hasUrlRow
    const urlLabel = $('clickhouseUrlRow')?.querySelector?.('.field-label')
    if (urlLabel) {
      urlLabel.textContent = isMongo
        ? 'Connection URL (Optional / +srv)'
        : 'HTTP(S) Endpoint URL (Optional)'
    }
    if ($('formClickhouseUrl')) {
      $('formClickhouseUrl').placeholder = isMongo
        ? 'mongodb://localhost:27017 or mongodb+srv://...'
        : 'http://localhost:8123'
    }
    if ($('pgOptionsRow')) $('pgOptionsRow').hidden = !hasOptionsRow
    if ($('formOptions')) {
      $('formOptions').placeholder =
        valid === 'snowflake'
          ? 'e.g. account=...,warehouse=...,role=...'
          : valid === 'bigquery'
            ? 'e.g. projectId=...,location=US'
            : valid === 'cassandra'
              ? 'e.g. localDataCenter=datacenter1,keyspace=...'
              : 'e.g. --cluster=... or endpoint=...'
    }
    if ($('formFilePath')) {
      $('formFilePath').placeholder = isDuckdb
        ? 'D:\\project\\analytics.duckdb or :memory:'
        : 'D:\\project\\data.db or folder path'
    }
    $('sqlDbRow').hidden = isRedis
    $('redisDbRow').hidden = !isRedis

    if (!hasOptionsRow || (applyDefaults && prevDriver !== valid)) {
      state.formOptions = ''
      if ($('formOptions')) $('formOptions').value = ''
    }

    if (applyDefaults && !isFileDb && !isLibsql) {
      const meta = ENGINE_BY_ID[valid]
      const defaultSsl = Boolean(
        meta?.defaultSsl ??
          (valid === 'cockroachdb' || valid === 'snowflake' || valid === 'bigquery')
      )
      $('formPort').value = String(meta.defaultPort)
      $('formDatabase').placeholder = meta.defaultDb
      $('formUser').value = meta.defaultUser
      $('formSsl').checked = defaultSsl
      state.formSslMode = undefined
      state.formSslRejectUnauthorized = defaultSsl ? true : undefined
      state.formSslTouched = false
    }
    syncSslVerifyUi()
    if ($('quickBrowseDbFileBtn')) {
      $('quickBrowseDbFileBtn').hidden = !isFileDb
    }
    renderDiscoveredItems()
    syncPanelByodBox()
    clearFormNotice()
    savePanelViewState?.()
  }

  function initStaticSelectors() {
    const grid = $('engineGrid')
    grid.textContent = ''
    grid.classList.add('engine-groups')

    const builtinEngines = ENGINES.filter((eng) => !eng.studioOnly && !BYOD_IDS.has(eng.id))
    const byodEngines = ENGINES.filter((eng) => !eng.studioOnly && BYOD_IDS.has(eng.id))

    const appendEngineGroup = (groupKey, labelText, engines) => {
      if (engines.length === 0) return
      const groupEl = document.createElement('div')
      groupEl.className = 'engine-group'
      groupEl.dataset.engineGroup = groupKey

      const labelEl = document.createElement('div')
      labelEl.className = 'engine-group-label'
      labelEl.textContent = labelText

      const tilesGrid = document.createElement('div')
      tilesGrid.className = 'engine-group-grid'
      tilesGrid.setAttribute('role', 'group')
      tilesGrid.setAttribute('aria-label', labelText)

      for (const eng of engines) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = `engine-tile${eng.id === state.formDriver ? ' active' : ''}`
        btn.dataset.driver = eng.id
        btn.title = groupKey === 'byod' ? `${eng.label} (Local BYOD Driver)` : eng.label
        const ico = document.createElement('span')
        setDbLogoElement(ico, eng.id, 15)
        const lbl = document.createElement('span')
        lbl.className = 'engine-tile-label'
        lbl.textContent = eng.label
        btn.append(ico, lbl)
        btn.addEventListener('click', () => setFormDriver(eng.id, true))
        tilesGrid.appendChild(btn)
      }

      groupEl.append(labelEl, tilesGrid)
      grid.appendChild(groupEl)
    }

    appendEngineGroup('builtin', 'Built-in Database Engines', builtinEngines)
    appendEngineGroup('byod', 'Local Custom Drivers (BYOD)', byodEngines)

    const redisSel = $('formRedisDb')
    redisSel.textContent = ''
    for (let i = 0; i <= 15; i++) {
      const opt = document.createElement('option')
      opt.value = String(i)
      opt.textContent = `db${i}`
      redisSel.appendChild(opt)
    }

    document.querySelectorAll('.env-pill').forEach((pill) => {
      pill.addEventListener('click', () => setFormColorTag(pill.dataset.env || 'none'))
    })

    const pickAndFillLocalSqliteFile = () => {
      if (state.formBusy || !state.formOpen) return
      const isDuck = state.formDriver === 'duckdb'
      void openPanelFilePickerModal({
        title: isDuck ? 'Select DuckDB database file' : 'Select SQLite database file',
        mode: 'file',
        initialDir: $('formFilePath')?.value.trim() || undefined,
        extensions: isDuck ? ['.duckdb', '.ddb', '.db'] : ['.db', '.sqlite', '.sqlite3', '.db3'],
      })
        .then((res) => {
          if (!state.formOpen) return
          if (res?.ok && res.path) {
            if (state.formDriver !== 'sqlite' && state.formDriver !== 'duckdb') {
              setFormDriver('sqlite', false)
            }
            $('formFilePath').value = res.path
            const smartName = deriveSmartSqliteConnName(res.path)
            const curName = $('formName').value.trim()
            if (
              !curName ||
              curName === 'Local SQLite' ||
              (state.lastAutoFilledSqliteName && curName === state.lastAutoFilledSqliteName)
            ) {
              $('formName').value = smartName
              state.lastAutoFilledSqliteName = smartName
            }
            clearFormNotice()
            savePanelViewState?.()
          }
        })
        .catch(() => {})
    }

    if ($('browseSqliteFileBtn')) {
      $('browseSqliteFileBtn').addEventListener('click', pickAndFillLocalSqliteFile)
    }
    if ($('quickBrowseDbFileBtn')) {
      $('quickBrowseDbFileBtn').addEventListener('click', pickAndFillLocalSqliteFile)
    }
    if ($('quickScanFolderBtn')) {
      $('quickScanFolderBtn').addEventListener('click', () => {
        if (state.formBusy || !state.formOpen) return
        void openPanelFilePickerModal({
          title: 'Select folder to scan',
          mode: 'folder',
          initialDir: $('formFilePath')?.value.trim() || undefined,
        })
          .then((res) => {
            if (!state.formOpen) return
            if (res?.ok && res.path) {
              void detectWorkspace(res.path, true)
            }
          })
          .catch(() => {})
      })
    }

    const toggleBindings = [
      ['env', 'discoveredEnvToggle'],
      ['docker', 'discoveredDockerToggle'],
      ['sqlite', 'discoveredFileToggle'],
    ]
    for (const [groupKey, toggleId] of toggleBindings) {
      const toggleBtn = $(toggleId)
      if (!toggleBtn) continue
      toggleBtn.addEventListener('click', () => {
        const curCollapsed = toggleBtn.dataset.collapsed === '1'
        if (!state.discoveryCollapsed || typeof state.discoveryCollapsed !== 'object') {
          state.discoveryCollapsed = { env: null, docker: null, sqlite: null }
        }
        state.discoveryCollapsed[groupKey] = !curCollapsed
        renderDiscoveredItems()
      })
    }

    if ($('panelByodFolderInput')) {
      $('panelByodFolderInput').addEventListener('input', () => {
        const folderInp = $('panelByodFolderInput')
        folderInp.dataset.isFallback = '0'
        byodPendingSha.delete(state.formDriver)
        if ($('panelByodTrustBtn')) $('panelByodTrustBtn').disabled = true
        $('panelByodCmdInput').value = buildPanelByodCmd(state.formDriver, folderInp.value)
        savePanelViewState?.()
      })
    }
    if ($('panelByodBrowseBtn')) {
      $('panelByodBrowseBtn').addEventListener('click', () => {
        if (state.formBusy || byodActionBusy || !state.formOpen) return
        const targetDriver = state.formDriver
        void openPanelFilePickerModal({
          title: `Select folder for ${targetDriver} driver`,
          mode: 'folder',
          initialDir: $('panelByodFolderInput').value.trim() || undefined,
        })
          .then((res) => {
            if (!state.formOpen || state.formDriver !== targetDriver) return
            if (res?.ok && res.path) {
              const folderInp = $('panelByodFolderInput')
              folderInp.value = res.path
              folderInp.dataset.driver = targetDriver
              folderInp.dataset.isFallback = '0'
              byodPendingSha.delete(targetDriver)
              if ($('panelByodTrustBtn')) $('panelByodTrustBtn').disabled = true
              $('panelByodCmdInput').value = buildPanelByodCmd(targetDriver, res.path)
              savePanelViewState?.()
            }
          })
          .catch(() => {})
      })
    }
    if ($('panelByodCopyCmdBtn')) {
      $('panelByodCopyCmdBtn').addEventListener('click', (e) => {
        const val = $('panelByodCmdInput').value
        if (typeof copyText === 'function') {
          void copyText(val, 'Setup command copied', e.currentTarget)
        } else {
          navigator.clipboard?.writeText(val).catch(() => {})
        }
      })
    }
    if ($('panelByodCopyStarterBtn')) {
      $('panelByodCopyStarterBtn').addEventListener('click', async (e) => {
        const btn = e.currentTarget
        const drv = state.formDriver
        let tpl = byodStarterTemplates[drv]
        if (!tpl) {
          const defRes = await rpc('drivers.defaultPaths').catch(() => null)
          if (defRes?.templates && typeof defRes.templates === 'object') {
            byodStarterTemplates = { ...byodStarterTemplates, ...defRes.templates }
            tpl = byodStarterTemplates[drv]
          }
        }
        if (!tpl) {
          showFormNotice(`Starter template unavailable for "${drv}".`, 'danger')
          return
        }
        if (typeof copyText === 'function') {
          void copyText(tpl, `Starter index.mjs copied for ${drv}`, btn)
        } else {
          navigator.clipboard?.writeText(tpl).catch(() => {})
        }
      })
    }
    if ($('panelByodAutoSetupBtn')) {
      $('panelByodAutoSetupBtn').addEventListener('click', async () => {
        if (byodActionBusy || state.formBusy) return
        byodActionBusy = true
        const driverId = state.formDriver
        const targetDir = $('panelByodFolderInput').value.trim()
        const btn = $('panelByodAutoSetupBtn')
        setButtonLoading(btn, true, 'Creating folder...')
        try {
          const res = await rpc('drivers.setupLocal', {
            driverId,
            localPath: targetDir,
            autoTrust: true,
          })
          if (state.formDriver !== driverId) return
          if (res?.ok && res.inspect?.sha256) {
            const installCmd = buildPanelByodCmd(driverId, res.dirPath || targetDir)
            if ($('panelByodCmdInput')) $('panelByodCmdInput').value = installCmd
            if (res.installPackage && res.item?.status !== 'local-verified') {
              void writeTextToClipboard(installCmd)
            }
            if (res.item?.status === 'local-verified') {
              byodPendingSha.delete(driverId)
              await refreshPanelByodAndWorkspaces()
              if (state.formDriver === driverId) {
                showFormNotice(`${driverId} driver verified.`, 'success')
              }
            } else {
              byodPendingSha.set(driverId, { localPath: res.dirPath || targetDir, sha256: res.inspect.sha256 })
              await refreshPanelByodAndWorkspaces()
              if (state.formDriver === driverId) {
                showFormNotice(
                  res.installPackage
                    ? `Folder created and install command copied. Run it in Terminal, then click Trust & Verify.`
                    : `Folder created (SHA-256: ${res.inspect.sha256.slice(0, 16)}…). Review and click Trust & Verify.`,
                  'warn'
                )
              }
            }
          }
        } catch (err) {
          if (state.formDriver === driverId) {
            showFormNotice(err?.message || String(err), 'danger')
          }
        } finally {
          byodActionBusy = false
          setButtonLoading(btn, false)
        }
      })
    }
    if ($('panelByodInspectBtn')) {
      $('panelByodInspectBtn').addEventListener('click', async () => {
        if (byodActionBusy || state.formBusy) return
        byodActionBusy = true
        const driverId = state.formDriver
        const targetDir = $('panelByodFolderInput').value.trim()
        const btn = $('panelByodInspectBtn')
        setButtonLoading(btn, true, 'Inspecting...')
        try {
          let res
          try {
            res = await rpc('drivers.inspectLocal', { driverId, localPath: targetDir })
          } catch (inspectErr) {
            const msg = inspectErr?.message || String(inspectErr)
            if (msg.includes('No driver entry found') || msg.includes('does not exist')) {
              const scaffolded = await rpc('drivers.setupLocal', {
                driverId,
                localPath: targetDir,
                autoTrust: false,
              })
              res = scaffolded?.inspect
            } else {
              throw inspectErr
            }
          }
          if (state.formDriver !== driverId) return
          if (res?.ok && res.sha256) {
            byodPendingSha.set(driverId, { localPath: targetDir, sha256: res.sha256 })
            syncPanelByodBox()
            showFormNotice(`SHA-256: ${res.sha256.slice(0, 16)}… — Click Trust & Verify.`, 'success')
          } else {
            showFormNotice(res?.message || 'Failed to inspect driver.', 'danger')
          }
        } catch (err) {
          if (state.formDriver === driverId) {
            showFormNotice(err?.message || String(err), 'danger')
          }
        } finally {
          byodActionBusy = false
          setButtonLoading(btn, false)
        }
      })
    }
    if ($('panelByodTrustBtn')) {
      $('panelByodTrustBtn').addEventListener('click', async () => {
        if (byodActionBusy || state.formBusy) return
        const driverId = state.formDriver
        const pending = byodPendingSha.get(driverId)
        if (!pending) return
        byodActionBusy = true
        const btn = $('panelByodTrustBtn')
        setButtonLoading(btn, true, 'Verifying...')
        try {
          await rpc('drivers.configureLocal', {
            driverId,
            localPath: pending.localPath,
            trustedSha256: pending.sha256,
          })
          byodPendingSha.delete(driverId)
          await refreshPanelByodAndWorkspaces()
          if (state.formDriver === driverId) {
            showFormNotice(`${driverId} driver verified and ready`, 'success')
          }
        } catch (err) {
          if (state.formDriver === driverId) {
            showFormNotice(err?.message || String(err), 'danger')
          }
        } finally {
          byodActionBusy = false
          setButtonLoading(btn, false)
        }
      })
    }

    const trackedInputIds = [
      'uriInput',
      'formName',
      'formFolder',
      'formWorkspaceScope',
      'formFilePath',
      'formLibsqlUrl',
      'formLibsqlDb',
      'formHost',
      'formPort',
      'formDatabase',
      'formUser',
      'formClickhouseUrl',
      'formOptions',
      'formRedisDb',
      'formSsl',
      'formSslVerify',
      'formReadOnly',
      'formAiPolicy',
    ]
    const secretTargetInputIds = new Set([
      'formHost',
      'formPort',
      'formUser',
      'formClickhouseUrl',
      'formLibsqlUrl',
    ])
    for (const id of trackedInputIds) {
      const el = $(id)
      if (!el) continue
      const isSelect =
        el.tagName === 'SELECT' ||
        (typeof HTMLSelectElement !== 'undefined' && el instanceof HTMLSelectElement)
      const isCheckbox = el.type === 'checkbox'
      const evName = isSelect || isCheckbox ? 'change' : 'input'
      el.addEventListener(evName, () => {
        if (secretTargetInputIds.has(id)) {
          clearStoredSecretFlags()
        }
        if (id === 'formAiPolicy') {
          syncAiPolicyHint()
        }
        if (id === 'formWorkspaceScope') {
          state.pendingWorkspaceScope = null
        }
        if (id === 'formSsl') {
          state.formSslTouched = true
          if (el.checked) {
            state.formSslMode = 'auto'
            state.formSslRejectUnauthorized = true
          } else {
            state.formSslMode = 'disable'
            state.formSslRejectUnauthorized = undefined
          }
          syncSslVerifyUi()
        }
        if (id === 'formSslVerify') {
          state.formSslTouched = true
          state.formSslRejectUnauthorized = Boolean(el.checked)
          if (!el.checked) {
            if ($('formSsl')) $('formSsl').checked = true
            if (
              state.formSslMode === undefined ||
              state.formSslMode === 'auto' ||
              state.formSslMode === 'verify-ca' ||
              state.formSslMode === 'verify-full'
            ) {
              state.formSslMode = 'require'
            }
          } else if (state.formSslMode === 'require') {
            state.formSslMode = 'auto'
          }
          syncSslVerifyUi()
        }
        if (isSelect) syncSelectTooltip(el)
        savePanelViewState?.()
      })
    }

    renderPanelFolderChips()
    void refreshPanelByodAndWorkspaces()
  }

  function resetConnectionForm() {
    dockerApplySeq++
    clearActiveAutoUri()
    lastParsedDisplayUri = ''
    lastParsedCandidateId = ''
    state.editingId = null
    state.formHadPassword = false
    state.formHadAuthToken = false
    state.placeholderPasswordPending = false
    state.lastParsedPlaceholderUri = false
    state.sourceSecretConnId = null
    state.lastParsedUri = ''
    state.formOptions = ''
    state.formSslMode = undefined
    state.formSslRejectUnauthorized = undefined
    state.formSslTouched = false
    state.parsedOracleUrl = ''
    state.lastAutoFilledSqliteName = ''
    state.discoveredSearch = ''
    if ($('discoveredSearchInput')) $('discoveredSearchInput').value = ''
    $('connFormTitle').textContent = 'New Database Connection'
    $('saveFormBtn').textContent = 'Save & Connect'
    $('uriInput').value = ''
    $('formName').value = ''
    $('formFilePath').value = ''
    $('formLibsqlUrl').value = ''
    $('formAuthToken').value = ''
    $('formAuthToken').placeholder = 'Optional Bearer token'
    $('formLibsqlDb').value = ''
    $('formHost').value = 'localhost'
    $('formDatabase').value = ''
    $('formClickhouseUrl').value = ''
    if ($('formOptions')) $('formOptions').value = ''
    $('formRedisDb').value = '0'
    $('formPassword').value = ''
    $('formPassword').placeholder = 'Optional'
    $('formSsl').checked = false
    syncSslVerifyUi()
    $('formReadOnly').checked = false
    if ($('formAiPolicy')) {
      $('formAiPolicy').value = ''
      syncSelectTooltip($('formAiPolicy'))
    }
    if ($('formFolder')) $('formFolder').value = ''
    state.pendingWorkspaceScope = ''
    if ($('formWorkspaceScope')) {
      $('formWorkspaceScope').value = ''
      syncSelectTooltip($('formWorkspaceScope'))
      $('formWorkspaceScope')._customDropdownSync?.()
    }
    syncSelectTooltip($('formRedisDb'))
    renderPanelFolderChips()
    void refreshPanelByodAndWorkspaces()
    setFormColorTag('none')
    clearFormNotice()
  }

  function clearFormFields() {
    const keepDriver = state.formDriver || 'sqlite'
    resetConnectionForm()
    setFormDriver(keepDriver, true)
    showFormNotice('Form cleared.', 'neutral')
    $('formName')?.focus()
    savePanelViewState?.()
  }

  function populateFormFromProfile(profile, mode = 'edit', opts = {}) {
    if (!profile?.driver || !ENGINE_BY_ID[profile.driver] || ENGINE_BY_ID[profile.driver].studioOnly) {
      showBanner(
        `"${String(profile?.driver || 'This')}" connections are configured in Fullscreen Studio — click Studio to edit or duplicate.`,
        'warn'
      )
      return
    }
    resetConnectionForm()
    const driver = profile.driver
    if (mode === 'edit') {
      state.editingId = profile.id
      state.formHadPassword = Boolean(profile.hasPassword)
      state.formHadAuthToken = Boolean(profile.hasAuthToken)
      $('connFormTitle').textContent = `Edit Connection — ${profile.name}`
      $('saveFormBtn').textContent = 'Update Connection'
      $('formName').value = profile.name || ''
    } else if (mode === 'duplicate') {
      state.sourceSecretConnId = profile.id
      state.formHadPassword = Boolean(profile.hasPassword)
      state.formHadAuthToken = Boolean(profile.hasAuthToken)
      $('connFormTitle').textContent = `Duplicate Connection — ${profile.name}`
      $('saveFormBtn').textContent = 'Save Copy'
      $('formName').value = `${profile.name || driver} (Copy)`
    } else {
      $('formName').value = profile.name || ''
    }

    setFormDriver(driver, false)
    setFormColorTag(profile.colorTag || 'none')
    $('formReadOnly').checked = Boolean(profile.readOnly)
    if ($('formAiPolicy')) {
      const pPolicy =
        profile.aiPolicy === 'allow' || profile.aiPolicy === 'ask' || profile.aiPolicy === 'never'
          ? profile.aiPolicy
          : ''
      $('formAiPolicy').value = pPolicy
      syncSelectTooltip($('formAiPolicy'))
    }
    syncAiPolicyHint()
    if ($('formFolder')) $('formFolder').value = profile.folder || ''
    state.pendingWorkspaceScope = profile.workspaceScope || ''
    if ($('formWorkspaceScope')) {
      const wsSel = $('formWorkspaceScope')
      const desired = profile.workspaceScope || ''
      if (desired && !Array.from(wsSel.options).some((o) => o.value === desired)) {
        const opt = document.createElement('option')
        opt.value = desired
        opt.textContent = `Saved Scope: ${desired}`
        opt.dataset.fullTitle = `Saved Scope: ${desired}`
        wsSel.appendChild(opt)
      }
      wsSel.value = desired
      syncSelectTooltip(wsSel)
      wsSel._customDropdownSync?.()
    }

    state.parsedOracleUrl = driver === 'oracle' && typeof profile.url === 'string' ? profile.url : ''
    if (driver === 'sqlite' || driver === 'duckdb') {
      $('formFilePath').value = profile.filePath || profile.database || ''
    } else if (driver === 'libsql') {
      $('formLibsqlUrl').value = profile.url
        ? sanitizePanelLibsqlUrlAndName(profile.url).cleanUrl ||
          scrubPanelNetworkFormUrl(profile.url)
        : ''
      $('formLibsqlDb').value = profile.database || ''
      if (profile.hasAuthToken && (mode === 'edit' || mode === 'duplicate')) {
        $('formAuthToken').placeholder = 'Stored token preserved (type to replace)'
      }
    } else {
      const hostValue = profile.host || 'localhost'
      $('formHost').value = hostValue
      $('formPort').value = String(profile.port || ENGINE_BY_ID[driver].defaultPort)
      $('formUser').value = profile.user || ''
      const isCloudAutoSsl =
        profile.ssl === undefined &&
        profile.sslMode !== 'disable' &&
        (driver === 'cockroachdb' || isCloudDatabaseHost(hostValue))
      const hasExplicitTlsMode =
        profile.sslMode === 'require' ||
        profile.sslMode === 'verify-ca' ||
        profile.sslMode === 'verify-full' ||
        Boolean(profile.sslCaPath || profile.sslCertPath || profile.sslKeyPath)
      const effectiveSsl =
        profile.sslMode === 'disable'
          ? false
          : profile.ssl !== undefined
            ? Boolean(profile.ssl)
            : isCloudAutoSsl || hasExplicitTlsMode
      $('formSsl').checked = effectiveSsl
      state.formSslMode = profile.sslMode
      state.formSslRejectUnauthorized = profile.sslRejectUnauthorized
      state.formSslTouched = false
      syncSslVerifyUi()
      if (driver === 'redis') {
        $('formRedisDb').value = String(profile.redisDb ?? 0)
      } else {
        $('formDatabase').value = profile.database || ''
      }
      if (driver === 'clickhouse' || driver === 'mongodb') {
        $('formClickhouseUrl').value = profile.url ? scrubPanelNetworkFormUrl(profile.url) : ''
      }
      if (isPanelOptionsDriver(driver)) {
        const optsVal = typeof profile.options === 'string' ? profile.options : ''
        state.formOptions = optsVal
        if ($('formOptions')) $('formOptions').value = optsVal
      }
      if (profile.hasPassword && (mode === 'edit' || mode === 'duplicate')) {
        $('formPassword').placeholder = 'Stored password preserved (type to replace)'
      }
    }

    setFormOpen(true)
    if (opts?.focusSection === 'tls') {
      const targetEl = $('formSslVerify') && !$('sslVerifyRow')?.hidden ? $('formSslVerify') : $('formSsl')
      targetEl?.scrollIntoView?.({ block: 'center' })
      targetEl?.focus?.()
    }
  }

  function buildFormSubmission(id) {
    const driver = state.formDriver
    const name = $('formName').value.trim()
    const readOnly = Boolean($('formReadOnly').checked)
    const colorTag = state.formColorTag
    const rawAiPolicy = $('formAiPolicy')?.value || ''
    const aiPolicy =
      rawAiPolicy === 'allow' || rawAiPolicy === 'ask' || rawAiPolicy === 'never'
        ? rawAiPolicy
        : undefined
    const folder = ($('formFolder') ? $('formFolder').value : '').trim().slice(0, 64)
    const workspaceScope = ($('formWorkspaceScope') ? $('formWorkspaceScope').value : '').trim().slice(0, 260)

    if (driver === 'sqlite' || driver === 'duckdb') {
      const filePath = $('formFilePath').value.trim()
      const defaultFile = driver === 'duckdb' ? 'analytics.duckdb' : 'database.db'
      const baseName = filePath.split(/[\\/]/).filter(Boolean).pop() || defaultFile
      return {
        profile: {
          id,
          name: name || baseName,
          driver,
          database: baseName,
          filePath,
          readOnly,
          colorTag,
          ...(aiPolicy ? { aiPolicy } : {}),
          folder,
          workspaceScope,
        },
      }
    }

    if (driver === 'libsql') {
      const rawUrl = $('formLibsqlUrl').value.trim()
      const { cleanUrl, defaultName } = sanitizePanelLibsqlUrlAndName(rawUrl)
      const url = cleanUrl || rawUrl
      const authToken = $('formAuthToken').value
      const database = $('formLibsqlDb').value.trim() || 'turso'
      const keepStoredToken =
        (state.editingId === id || Boolean(state.sourceSecretConnId)) && state.formHadAuthToken
      return {
        profile: {
          id,
          name: name || defaultName,
          driver: 'libsql',
          database,
          url,
          ssl: /^(?:https|libsql|wss):\/\//i.test(url) || !/^http:\/\//i.test(url),
          readOnly,
          colorTag,
          ...(aiPolicy ? { aiPolicy } : {}),
          hasAuthToken: Boolean(authToken) || keepStoredToken,
          folder,
          workspaceScope,
        },
        ...(authToken ? { authToken } : {}),
        ...(state.sourceSecretConnId ? { sourceConnectionId: state.sourceSecretConnId } : {}),
      }
    }

    const meta = ENGINE_BY_ID[driver]
    const host = $('formHost').value.trim() || 'localhost'
    const parsedPort = Number.parseInt($('formPort').value.trim(), 10)
    const port =
      Number.isFinite(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
        ? parsedPort
        : meta.defaultPort
    const user = $('formUser').value.trim()
    const password = $('formPassword').value
    const ssl = Boolean($('formSsl').checked)
    const keepStoredPassword =
      (state.editingId === id || Boolean(state.sourceSecretConnId)) && state.formHadPassword

    const profile = {
      id,
      name: name || `${driver}@${host}`,
      driver,
      database:
        driver === 'redis'
          ? String(Number.parseInt($('formRedisDb').value || '0', 10) || 0)
          : $('formDatabase').value.trim() || meta.defaultDb,
      host,
      port,
      ...(user ? { user } : {}),
      ssl,
      readOnly,
      colorTag,
      ...(aiPolicy ? { aiPolicy } : {}),
      hasPassword: Boolean(password) || keepStoredPassword,
      folder,
      workspaceScope,
    }

    if (driver === 'redis') {
      const rdb = Number.parseInt($('formRedisDb').value || '0', 10)
      profile.redisDb = Number.isFinite(rdb) && rdb >= 0 && rdb <= 15 ? rdb : 0
    }

    if (isPanelOptionsDriver(driver)) {
      const pgOptions = ($('formOptions') ? $('formOptions').value : state.formOptions || '').trim()
      if (pgOptions) profile.options = pgOptions
    }

    let urlForcedSsl = null
    if (driver === 'mongodb') {
      const mongoUrl = scrubPanelNetworkFormUrl($('formClickhouseUrl')?.value || '')
      if (mongoUrl) {
        profile.url = mongoUrl
        try {
          const parsedMongo = new URL(mongoUrl)
          if (parsedMongo.hostname) profile.host = parsedMongo.hostname
          if (parsedMongo.port) {
            const parsedMongoPort = Number.parseInt(parsedMongo.port, 10)
            if (Number.isFinite(parsedMongoPort) && parsedMongoPort >= 1 && parsedMongoPort <= 65535) {
              profile.port = parsedMongoPort
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
        } catch {}
      }
    }

    if (driver === 'oracle' && state.parsedOracleUrl) {
      profile.url = scrubPanelNetworkFormUrl(state.parsedOracleUrl)
    }

    if (driver === 'clickhouse') {
      const chUrl = scrubPanelNetworkFormUrl($('formClickhouseUrl').value)
      const generatedUrl = `${ssl ? 'https' : 'http'}://${host}:${port}`
      if (chUrl) {
        profile.url = chUrl
        try {
          const parsedCh = new URL(chUrl)
          if (parsedCh.hostname) profile.host = parsedCh.hostname
          if (parsedCh.port) {
            const parsedChPort = Number.parseInt(parsedCh.port, 10)
            if (Number.isFinite(parsedChPort) && parsedChPort >= 1 && parsedChPort <= 65535) {
              profile.port = parsedChPort
            }
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
        } catch {}
      } else {
        profile.url = generatedUrl
      }
    }

    if (
      state.formSslMode === 'auto' ||
      state.formSslMode === 'disable' ||
      state.formSslMode === 'require' ||
      state.formSslMode === 'verify-ca' ||
      state.formSslMode === 'verify-full'
    ) {
      profile.sslMode = state.formSslMode
    }
    if (urlForcedSsl === false) {
      profile.sslMode = 'disable'
    } else if (urlForcedSsl === true && profile.sslMode === 'disable') {
      profile.sslMode = 'auto'
    }
    if (typeof state.formSslRejectUnauthorized === 'boolean') {
      profile.sslRejectUnauthorized = state.formSslRejectUnauthorized
      if (
        profile.ssl &&
        state.formSslRejectUnauthorized === false &&
        (profile.sslMode === undefined || profile.sslMode === 'auto')
      ) {
        profile.sslMode = 'require'
      }
    } else if (profile.ssl && profile.sslMode !== 'require' && profile.sslMode !== 'disable') {
      profile.sslRejectUnauthorized = true
    }

    const preserveSourceId =
      state.editingId === id ? id : state.sourceSecretConnId || null
    if (preserveSourceId && Array.isArray(state.connections)) {
      const existing = state.connections.find((c) => c && c.id === preserveSourceId)
      if (existing && existing.driver === driver) {
        const extendedKeys = [
          'sslMode',
          'sslCaPath',
          'sslCertPath',
          'sslKeyPath',
          'hasSslKeyPassphrase',
          'sslRejectUnauthorized',
          'sshEnabled',
          'sshHost',
          'sshPort',
          'sshUser',
          'sshAuthMethod',
          'sshPrivateKeyPath',
          'hasSshPassphrase',
          'hasSshPassword',
          'd1AccountId',
          'd1DatabaseId',
        ]
        for (const key of extendedKeys) {
          if (state.formSslTouched && (key === 'sslMode' || key === 'sslRejectUnauthorized')) {
            continue
          }
          if (existing[key] !== undefined && profile[key] === undefined) {
            profile[key] = existing[key]
          }
        }
      }
    }

    return {
      profile,
      ...(password ? { password } : {}),
      ...(state.sourceSecretConnId ? { sourceConnectionId: state.sourceSecretConnId } : {}),
    }
  }

  function resolveUriInputForParse(explicitRaw) {
    const uriEl = $('uriInput')
    if (explicitRaw && typeof explicitRaw === 'object') {
      const candidateId =
        typeof explicitRaw.candidateId === 'string' && explicitRaw.candidateId.trim()
          ? explicitRaw.candidateId.trim()
          : undefined
      const uri =
        typeof explicitRaw.uri === 'string' && explicitRaw.uri.trim()
          ? explicitRaw.uri.trim()
          : undefined
      const displayUri = String(explicitRaw.displayUri ?? uriEl?.value ?? uri ?? '').trim()
      return { ...(candidateId ? { candidateId } : {}), ...(uri ? { uri } : {}), displayUri }
    }
    const displayUri = String(explicitRaw ?? uriEl?.value ?? '').trim()
    if (activeAutoDisplayUri !== null && displayUri === activeAutoDisplayUri) {
      if (activeAutoCandidateId) {
        return { candidateId: activeAutoCandidateId, displayUri }
      }
      if (activeAutoRawUri) {
        return { uri: activeAutoRawUri, displayUri }
      }
    } else if (
      explicitRaw === undefined &&
      (activeAutoDisplayUri !== null || activeAutoCandidateId !== null || activeAutoRawUri !== null)
    ) {
      clearActiveAutoUri()
    }
    return { uri: displayUri, displayUri }
  }

  async function handleParseUri(rawUri, options = {}) {
    const target = resolveUriInputForParse(rawUri)
    if (!target.candidateId && !target.uri) return false
    const seq = ++parseUriSeq
    const parseBtn = $('parseUriBtn')
    clearFormNotice()
    setButtonLoading(parseBtn, true, 'Parsing...')
    try {
      const payload = target.candidateId ? { candidateId: target.candidateId } : { uri: target.uri }
      const res = await rpc('connection.parseUri', payload)
      if (seq !== parseUriSeq) return false
      if (!res?.ok || !res.profile) {
        showFormNotice(res?.error || 'Could not parse connection URI.', 'danger')
        return false
      }
      state.lastParsedUri = target.uri || ''
      lastParsedCandidateId = target.candidateId || ''
      lastParsedDisplayUri = target.displayUri || (target.uri ? maskConnectionUriSecret(target.uri) : '')
      const p = res.profile
      if (!p.driver || !ENGINE_BY_ID[p.driver] || ENGINE_BY_ID[p.driver].studioOnly) {
        showFormNotice(
          `"${String(p.driver || 'This')}" connections are configured in Fullscreen Studio — click Studio to add or edit.`,
          'warn'
        )
        return false
      }
      const driver = p.driver
      const prevDriver = state.formDriver
      const prevHost = $('formHost').value.trim().toLowerCase()
      const prevUser = $('formUser').value.trim()
      const prevLibsqlUrl = $('formLibsqlUrl').value.trim().toLowerCase()
      const nextHost = String(p.host || '').trim().toLowerCase()
      const nextUser = String(p.user || '').trim()
      const nextLibsqlUrl = String(p.url || '').trim().toLowerCase()
      const wasDuplicate = Boolean(state.sourceSecretConnId)
      const wasEditing = Boolean(state.editingId)
      const targetChanged =
        driver !== prevDriver ||
        (driver === 'libsql'
          ? nextLibsqlUrl !== prevLibsqlUrl
          : driver !== 'sqlite' && (nextHost !== prevHost || nextUser !== prevUser))

      state.sourceSecretConnId = null
      const dropStoredSecret = Boolean(
        options.clearMissingSecret || wasDuplicate || (wasEditing && targetChanged)
      )
      if (dropStoredSecret || res.password !== undefined || res.placeholderPassword) {
        state.formHadPassword = false
      }
      if (dropStoredSecret || res.authToken !== undefined) {
        state.formHadAuthToken = false
      }
      const nextPassword =
        res.password !== undefined
          ? res.password
          : dropStoredSecret
            ? ''
            : $('formPassword').value
      const nextAuthToken =
        res.authToken !== undefined
          ? res.authToken
          : dropStoredSecret
            ? ''
            : $('formAuthToken').value
      $('formFilePath').value = ''
      $('formLibsqlUrl').value = ''
      $('formAuthToken').value = ''
      $('formAuthToken').placeholder =
        state.formHadAuthToken && state.editingId
          ? 'Stored token preserved (type to replace)'
          : 'Optional Bearer token'
      $('formLibsqlDb').value = ''
      $('formHost').value = 'localhost'
      $('formDatabase').value = ''
      $('formClickhouseUrl').value = ''
      state.formOptions = ''
      if ($('formOptions')) $('formOptions').value = ''
      $('formRedisDb').value = '0'
      $('formPassword').value = ''
      setFormDriver(driver, true)
      state.parsedOracleUrl = driver === 'oracle' && p.url ? scrubPanelNetworkFormUrl(p.url) : ''
      if (p.name) $('formName').value = p.name
      if (p.readOnly !== undefined) $('formReadOnly').checked = Boolean(p.readOnly)
      if (driver === 'sqlite' || driver === 'duckdb') {
        $('formFilePath').value = p.filePath || ''
      } else if (driver === 'libsql') {
        $('formLibsqlUrl').value = p.url
          ? sanitizePanelLibsqlUrlAndName(p.url).cleanUrl || scrubPanelNetworkFormUrl(p.url)
          : ''
        $('formLibsqlDb').value = p.database || ''
        $('formAuthToken').value = nextAuthToken
      } else {
        if (p.host) $('formHost').value = p.host
        if (p.port) $('formPort').value = String(p.port)
        if (p.user !== undefined) $('formUser').value = p.user
        state.formSslTouched = true
        if (p.ssl !== undefined) $('formSsl').checked = Boolean(p.ssl)
        if (
          p.sslMode === 'auto' ||
          p.sslMode === 'disable' ||
          p.sslMode === 'require' ||
          p.sslMode === 'verify-ca' ||
          p.sslMode === 'verify-full'
        ) {
          state.formSslMode = p.sslMode
          if (p.sslMode === 'disable') $('formSsl').checked = false
          else if (
            p.sslMode === 'require' ||
            p.sslMode === 'verify-ca' ||
            p.sslMode === 'verify-full'
          ) {
            $('formSsl').checked = true
          }
        } else if (p.ssl === false) {
          state.formSslMode = 'disable'
        } else if (p.ssl) {
          state.formSslMode = 'auto'
        } else {
          state.formSslMode = undefined
        }
        if (p.sslRejectUnauthorized !== undefined) {
          state.formSslRejectUnauthorized = Boolean(p.sslRejectUnauthorized)
        } else if ($('formSsl').checked) {
          state.formSslRejectUnauthorized = true
        } else {
          state.formSslRejectUnauthorized = undefined
        }
        syncSslVerifyUi()
        if (driver === 'redis') {
          $('formRedisDb').value = String(p.redisDb ?? 0)
        } else if (p.database !== undefined) {
          $('formDatabase').value = p.database
        }
        if ((driver === 'clickhouse' || driver === 'mongodb') && p.url) {
          $('formClickhouseUrl').value = scrubPanelNetworkFormUrl(p.url)
        }
        if (isPanelOptionsDriver(driver) && typeof p.options === 'string' && p.options.trim()) {
          state.formOptions = p.options.trim()
          if ($('formOptions')) $('formOptions').value = state.formOptions
        }
        $('formPassword').value = nextPassword
      }
      state.lastParsedPlaceholderUri = Boolean(res.placeholderPassword)
      const missingPlaceholderPassword =
        state.lastParsedPlaceholderUri && !$('formPassword').value
      state.placeholderPasswordPending = missingPlaceholderPassword
      if (missingPlaceholderPassword) {
        $('formPassword').placeholder = 'Required (replace placeholder password)'
        showFormNotice(
          `Parsed ${ENGINE_BY_ID[driver].label} URI — placeholder password was removed. Enter your actual Database Password below before testing.`,
          'danger'
        )
        $('formPassword').focus()
      } else {
        $('formPassword').placeholder =
          state.formHadPassword && (state.editingId || state.sourceSecretConnId)
            ? 'Stored password preserved (type to replace)'
            : 'Optional'
        showFormNotice(`Parsed ${ENGINE_BY_ID[driver].label} URI`, 'success')
      }
      savePanelViewState?.()
      return true
    } catch (err) {
      if (seq !== parseUriSeq) return false
      showFormNotice(`URI error: ${err?.message || err}`, 'danger')
      return false
    } finally {
      if (seq === parseUriSeq) {
        setButtonLoading(parseBtn, false)
        if (state.formBusy && parseBtn instanceof HTMLButtonElement) {
          parseBtn.disabled = true
        }
      }
    }
  }

  async function detectWorkspace(folderPath, isManual = false) {
    const seq = ++detectSeq
    const detectBtn = $('detectWorkspaceBtn')
    setButtonLoading(detectBtn, true, 'Scanning...')
    try {
      const [wsRes, folderRes] = await Promise.all([
        rpc('workspace.detectConnections', folderPath ? { folderPath: folderPath.trim() } : {}),
        folderPath
          ? rpc('sqlite.scanFolder', { folderPath: folderPath.trim() }).catch(() => null)
          : Promise.resolve(null),
      ])
      if (seq !== detectSeq) return
      state.discoveredEnvs = Array.isArray(wsRes?.envConnections) ? wsRes.envConnections : []
      state.discoveredDocker = Array.isArray(wsRes?.dockerComposeConnections)
        ? wsRes.dockerComposeConnections
        : []
      const scannedDirs = Array.isArray(wsRes?.scannedDirs)
        ? wsRes.scannedDirs.map((d) => String(d || '').trim()).filter(Boolean)
        : []
      state.discoveredScannedDirs = scannedDirs
      state.discoveredFolderScoped = wsRes?.folderScoped ?? Boolean(folderPath && folderPath.trim())
      state.discoveredDockerScopeLabel =
        wsRes?.dockerScopeLabel === 'Docker Context' || wsRes?.dockerIsLocal === false
          ? 'Docker Context'
          : 'Local Docker'
      const scopeHintEl = $('discoveredScopeHint')
      if (scopeHintEl && scannedDirs.length > 0) {
        scopeHintEl.title = scannedDirs.join(', ')
        if (state.discoveredFolderScoped) {
          const shortName = extractScannedFolderName(scannedDirs[0])
          scopeHintEl.textContent = `Scanned folder: ${shortName} (Compose files and matching containers inside this folder only).`
        } else {
          const folderSummary =
            scannedDirs.length === 1
              ? '1 local workspace folder'
              : `${scannedDirs.length} local workspace folders`
          if (state.discoveredDockerScopeLabel === 'Docker Context') {
            scopeHintEl.textContent = `Scanned ${folderSummary} · Plus active Docker Context containers (non-workspace labeled "Other Docker Context").`
          } else {
            scopeHintEl.textContent = `Scanned ${folderSummary} · Plus local Docker containers (non-workspace labeled "Other Local Docker").`
          }
        }
      } else if (scopeHintEl) {
        scopeHintEl.title = ''
      }
      const wsFiles = Array.isArray(wsRes?.sqliteFiles) ? wsRes.sqliteFiles : []
      const extraFiles = Array.isArray(folderRes?.files) ? folderRes.files : []
      const seenPaths = new Set()
      state.discoveredFiles = []
      for (const f of [...extraFiles, ...wsFiles]) {
        if (f?.filePath && !seenPaths.has(f.filePath)) {
          seenPaths.add(f.filePath)
          state.discoveredFiles.push(f)
        }
      }
      state.discoveryCollapsed = { env: null, docker: null, sqlite: null }
      if (
        isManual &&
        state.discoveredEnvs.length === 0 &&
        state.discoveredDocker.length === 0 &&
        state.discoveredFiles.length === 0
      ) {
        showFormNotice(
          'No .env connections, Docker Compose databases, or SQLite files found.',
          'neutral'
        )
      }
    } catch {
      if (seq !== detectSeq) return
      state.discoveredEnvs = []
      state.discoveredDocker = []
      state.discoveredFiles = []
      if (isManual) {
        showFormNotice('Workspace discovery failed.', 'danger')
      }
    } finally {
      if (seq === detectSeq) {
        setButtonLoading(detectBtn, false)
        if (state.formBusy && detectBtn instanceof HTMLButtonElement) {
          detectBtn.disabled = true
        }
      }
    }
    renderDiscoveredItems()
  }

  function applyDiscoveredDockerCompose(item) {
    if (!item?.driver || !ENGINE_BY_ID[item.driver] || ENGINE_BY_ID[item.driver].studioOnly) {
      showFormNotice(
        `"${String(item?.driver || 'This')}" connections must be configured in Fullscreen Studio.`,
        'warn'
      )
      return
    }
    const seq = ++dockerApplySeq
    clearActiveAutoUri()
    lastParsedDisplayUri = ''
    lastParsedCandidateId = ''
    state.sourceSecretConnId = null
    state.formHadPassword = false
    state.formHadAuthToken = false
    state.placeholderPasswordPending = false
    state.lastParsedPlaceholderUri = false
    state.lastParsedUri = ''
    if (item.url) {
      const maskedUrl = maskConnectionUriSecret(item.url)
      $('uriInput').value = maskedUrl
      activeAutoCandidateId = item.candidateId || null
      activeAutoRawUri = item.candidateId ? null : item.url
      activeAutoDisplayUri = maskedUrl
      state.lastParsedUri = item.candidateId ? '' : item.url
      lastParsedCandidateId = item.candidateId || ''
      lastParsedDisplayUri = maskedUrl
    } else {
      $('uriInput').value = ''
    }
    $('formPassword').value = ''
    $('formPassword').placeholder = item.passwordFromFile
      ? `Required (${item.passwordFromFile})`
      : 'Optional'
    $('formAuthToken').value = ''
    $('formAuthToken').placeholder = 'Optional Bearer token'

    if ($('formClickhouseUrl')) $('formClickhouseUrl').value = ''
    setFormDriver(item.driver, true)
    $('formName').value = item.name || `${item.project} · ${item.service}`
    if (item.driver === 'libsql') {
      $('formLibsqlUrl').value = item.url
        ? sanitizePanelLibsqlUrlAndName(item.url).cleanUrl || scrubPanelNetworkFormUrl(item.url)
        : `http://${item.host || '127.0.0.1'}:${item.port || 8080}`
      $('formLibsqlDb').value = item.database || 'main'
    } else {
      $('formHost').value = item.host || '127.0.0.1'
      $('formPort').value = String(item.port || ENGINE_BY_ID[item.driver].defaultPort)
      $('formUser').value = item.user || ''
      $('formSsl').checked = Boolean(item.ssl)
      state.formSslTouched = true
      state.formSslMode = item.ssl ? 'auto' : undefined
      state.formSslRejectUnauthorized = item.ssl ? true : undefined
      syncSslVerifyUi()
      if (item.driver === 'redis') {
        $('formRedisDb').value = String(item.redisDb ?? 0)
        syncSelectTooltip($('formRedisDb'))
      } else {
        $('formDatabase').value = item.database || ENGINE_BY_ID[item.driver].defaultDb || ''
      }
      if (item.driver === 'clickhouse') {
        $('formClickhouseUrl').value = item.url
          ? scrubPanelNetworkFormUrl(item.url)
          : `http://${item.host || '127.0.0.1'}:${item.port || 8123}`
      } else if (item.driver === 'mongodb') {
        $('formClickhouseUrl').value = item.url ? scrubPanelNetworkFormUrl(item.url) : ''
      }
      if (item.password !== undefined) {
        $('formPassword').value = item.password
      }
    }

    if (item.hint) {
      showFormNotice(item.hint, 'warn')
      if (item.passwordFromFile) $('formPassword')?.focus()
    } else {
      showFormNotice(
        `Imported ${ENGINE_BY_ID[item.driver].label} service "${item.name}" from Docker Compose.`,
        'success'
      )
    }
    savePanelViewState?.()

    if (item.candidateId) {
      const candidateId = item.candidateId
      void rpc('workspace.resolveDetectedCandidate', { candidateId })
        .then((resolved) => {
          if (seq !== dockerApplySeq || !resolved?.ok) return
          if (resolved.password !== undefined && item.driver !== 'libsql') {
            $('formPassword').value = resolved.password
          }
          if (resolved.authToken !== undefined && item.driver === 'libsql') {
            $('formAuthToken').value = resolved.authToken
          }
          if (resolved.url) {
            if (item.driver === 'libsql') {
              $('formLibsqlUrl').value =
                sanitizePanelLibsqlUrlAndName(resolved.url).cleanUrl ||
                scrubPanelNetworkFormUrl(resolved.url)
            } else if (item.driver === 'clickhouse' || item.driver === 'mongodb') {
              $('formClickhouseUrl').value = scrubPanelNetworkFormUrl(resolved.url)
            }
          }
          if (item.url && activeAutoCandidateId === candidateId && activeAutoDisplayUri) {
            lastParsedCandidateId = candidateId
            lastParsedDisplayUri = activeAutoDisplayUri
          }
        })
        .catch(() => {
          // Best-effort secret resolution; Save/Parse URI falls back to connection.parseUri({ candidateId })
        })
    }
  }

  function applyGroupCollapseState(groupKey, groupEl, toggleBtn, bodyEl, countEl, totalCount, filteredCount, hasQuery) {
    let collapsed
    if (hasQuery) {
      collapsed = filteredCount === 0
    } else if (
      state.discoveryCollapsed &&
      typeof state.discoveryCollapsed[groupKey] === 'boolean'
    ) {
      collapsed = state.discoveryCollapsed[groupKey]
    } else if (groupKey === 'sqlite' && state.formDriver !== 'sqlite') {
      collapsed = true
    } else {
      collapsed = totalCount > 5
    }
    groupEl.classList.toggle('is-expanded', !collapsed)
    toggleBtn.dataset.collapsed = collapsed ? '1' : '0'
    toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
    bodyEl.hidden = collapsed
    countEl.textContent = hasQuery ? `${filteredCount} / ${totalCount}` : `${totalCount} found`
  }

  function appendDiscoveryEmptyMessage(containerEl, text) {
    const emptyEl = document.createElement('div')
    emptyEl.style.padding = '8px 6px'
    emptyEl.style.color = 'var(--t3)'
    emptyEl.style.fontSize = '11.5px'
    emptyEl.textContent = text
    containerEl.appendChild(emptyEl)
  }

  function renderDiscoveredItems() {
    const box = $('discoveredBox')
    const groupsWrap = $('discoveredGroupsWrap')
    const envGroup = $('discoveredEnvGroup')
    const envList = $('discoveredEnvList')
    const dockerGroup = $('discoveredDockerGroup')
    const dockerList = $('discoveredDockerList')
    const fileGroup = $('discoveredFileGroup')
    const fileList = $('discoveredList')
    if (!box || !envGroup || !envList || !dockerGroup || !dockerList || !fileGroup || !fileList) {
      return
    }
    envList.textContent = ''
    dockerList.textContent = ''
    fileList.textContent = ''

    const envs = Array.isArray(state.discoveredEnvs) ? state.discoveredEnvs : []
    const dockers = Array.isArray(state.discoveredDocker) ? state.discoveredDocker : []
    const files = Array.isArray(state.discoveredFiles) ? state.discoveredFiles : []

    const hasEnv = envs.length > 0
    const hasDocker = dockers.length > 0
    const hasFiles = files.length > 0

    box.hidden = !hasEnv && !hasDocker && !hasFiles
    envGroup.hidden = !hasEnv
    dockerGroup.hidden = !hasDocker
    fileGroup.hidden = !hasFiles

    if (groupsWrap) {
      const order =
        state.formDriver === 'sqlite'
          ? [fileGroup, envGroup, dockerGroup]
          : [envGroup, dockerGroup, fileGroup]
      for (const grp of order) groupsWrap.appendChild(grp)
    }

    const q = String(state.discoveredSearch || '').trim().toLowerCase()
    const hasQuery = q.length > 0

    if (hasEnv) {
      const filteredEnvs = hasQuery
        ? envs.filter((item) => {
            const masked = maskConnectionUriSecret(item.uri)
            return [item.envKey, item.name, item.driver, item.sourceFile, masked]
              .join(' ')
              .toLowerCase()
              .includes(q)
          })
        : envs
      applyGroupCollapseState(
        'env',
        envGroup,
        $('discoveredEnvToggle'),
        $('discoveredEnvBody'),
        $('discoveredEnvCount'),
        envs.length,
        filteredEnvs.length,
        hasQuery
      )
      if (filteredEnvs.length === 0) {
        appendDiscoveryEmptyMessage(envList, `No .env connections match "${state.discoveredSearch}".`)
      }
      for (const item of filteredEnvs) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'file-chip'
        const maskedUri = maskConnectionUriSecret(item.uri)
        chip.title = `${item.sourceFile} (${item.envKey}): ${maskedUri}`

        const top = document.createElement('div')
        top.className = 'file-chip-top'
        const title = document.createElement('span')
        title.className = 'file-chip-title'
        const ico = document.createElement('span')
        setDbLogoElement(ico, item.driver, 14)
        const nm = document.createElement('span')
        nm.className = 'file-chip-name'
        nm.textContent = `${item.envKey} (${item.name || item.driver})`
        title.append(ico, nm)

        const badge = document.createElement('span')
        badge.className = 'badge badge-neutral'
        badge.textContent = compactPathLabel(item.sourceFile || '.env')
        top.append(title, badge)

        const sub = document.createElement('div')
        sub.className = 'file-chip-path'
        sub.textContent = maskedUri
        chip.append(top, sub)

        chip.addEventListener('click', () => {
          dockerApplySeq++
          const uriEl = $('uriInput')
          uriEl.value = maskedUri
          activeAutoCandidateId = item.candidateId || null
          activeAutoRawUri = item.candidateId ? null : item.uri
          activeAutoDisplayUri = maskedUri
          if (!$('formName').value.trim()) $('formName').value = item.name || item.envKey
          void handleParseUri(
            {
              ...(item.candidateId ? { candidateId: item.candidateId } : { uri: item.uri }),
              displayUri: maskedUri,
            },
            { clearMissingSecret: true }
          )
        })
        envList.appendChild(chip)
      }
    }

    if (hasDocker) {
      const filteredDocker = hasQuery
        ? dockers.filter((item) =>
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
        : dockers
      applyGroupCollapseState(
        'docker',
        dockerGroup,
        $('discoveredDockerToggle'),
        $('discoveredDockerBody'),
        $('discoveredDockerCount'),
        dockers.length,
        filteredDocker.length,
        hasQuery
      )
      if (filteredDocker.length === 0) {
        appendDiscoveryEmptyMessage(
          dockerList,
          `No Docker Compose services match "${state.discoveredSearch}".`
        )
      }
      for (const item of filteredDocker) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'file-chip'
        chip.title = `${item.name} (${item.driver}) — ${item.host}:${item.port} [${item.status}]`

        const top = document.createElement('div')
        top.className = 'file-chip-top'
        const title = document.createElement('span')
        title.className = 'file-chip-title'
        const ico = document.createElement('span')
        setDbLogoElement(ico, item.driver, 14)
        const nm = document.createElement('span')
        nm.className = 'file-chip-name'
        nm.textContent = item.name || `${item.project} · ${item.service}`
        title.append(ico, nm)

        const badges = document.createElement('span')
        badges.className = 'discovery-chip-badges'
        if (item.workspaceMatched) {
          const wsBadge = document.createElement('span')
          wsBadge.className = 'badge badge-info'
          wsBadge.textContent = 'Workspace'
          badges.appendChild(wsBadge)
        } else {
          const otherBadge = document.createElement('span')
          otherBadge.className = 'badge badge-neutral'
          const isRemoteContext = state.discoveredDockerScopeLabel === 'Docker Context'
          otherBadge.textContent = isRemoteContext
            ? 'Other Docker Context'
            : 'Other Local Docker'
          otherBadge.title = isRemoteContext
            ? 'Running in the active Docker context outside the scanned workspace folder'
            : 'Running in local Docker outside the active workspace folder'
          badges.appendChild(otherBadge)
        }
        const statusBadge = document.createElement('span')
        statusBadge.className =
          item.status === 'running'
            ? 'badge badge-ok'
            : item.status === 'compose file'
              ? 'badge badge-neutral'
              : 'badge badge-danger'
        statusBadge.textContent = item.status || 'live'
        badges.appendChild(statusBadge)
        top.append(title, badges)

        const sub = document.createElement('div')
        sub.className = 'file-chip-path'
        const targetDb = item.driver === 'redis' ? `db${item.redisDb ?? 0}` : item.database || ''
        const userPrefix = item.user ? `${item.user}@` : ''
        sub.textContent = `${userPrefix}${item.host}:${item.port}${targetDb ? `/${targetDb}` : ''} · ${compactPathLabel(item.sourceFile || '')}`
        chip.append(top, sub)

        chip.addEventListener('click', () => applyDiscoveredDockerCompose(item))
        dockerList.appendChild(chip)
      }
    }

    if (hasFiles) {
      const filteredFiles = hasQuery
        ? files.filter(
            (f) =>
              String(f.name || '').toLowerCase().includes(q) ||
              String(f.filePath || '').toLowerCase().includes(q)
          )
        : files
      applyGroupCollapseState(
        'sqlite',
        fileGroup,
        $('discoveredFileToggle'),
        $('discoveredFileBody'),
        $('discoveredCount'),
        files.length,
        filteredFiles.length,
        hasQuery
      )
      if (filteredFiles.length === 0) {
        appendDiscoveryEmptyMessage(
          fileList,
          `No SQLite files match "${state.discoveredSearch}".`
        )
      }
      for (const file of filteredFiles) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = `file-chip${$('formFilePath').value.trim() === file.filePath ? ' selected' : ''}`
        chip.title = file.filePath

        const top = document.createElement('div')
        top.className = 'file-chip-top'
        const title = document.createElement('span')
        title.className = 'file-chip-title'
        const ico = document.createElement('span')
        setDbLogoElement(ico, 'sqlite', 14)
        const nm = document.createElement('span')
        nm.className = 'file-chip-name'
        nm.textContent = file.name
        title.append(ico, nm)

        const sz = document.createElement('span')
        sz.className = 'badge badge-ok'
        sz.textContent = file.sizeLabel || `${file.sizeBytes} B`
        top.append(title, sz)

        const sub = document.createElement('div')
        sub.className = 'file-chip-path'
        sub.textContent = compactPathLabel(file.filePath)
        sub.title = file.filePath

        chip.append(top, sub)
        chip.addEventListener('click', () => {
          setFormDriver('sqlite', false)
          $('formFilePath').value = file.filePath
          const curName = $('formName').value.trim()
          if (
            !curName ||
            curName === 'Local SQLite' ||
            (state.lastAutoFilledSqliteName && curName === state.lastAutoFilledSqliteName)
          ) {
            $('formName').value = file.name
            state.lastAutoFilledSqliteName = file.name
          }
          renderDiscoveredItems()
          clearFormNotice()
        })
        fileList.appendChild(chip)
      }
    }

    updateViewportLayout()
  }

  function setFormControlsBusy(busy) {
    const ids = ['testFormBtn', 'saveFormBtn', 'clearFormBtn', 'uriInput', 'parseUriBtn', 'detectWorkspaceBtn']
    for (const id of ids) {
      const el = $(id)
      if (el) el.disabled = Boolean(busy)
    }
  }

  async function ensureUriParsedBeforeAction() {
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
      (target.uri === state.lastParsedUri ||
        (state.lastParsedUri &&
          (target.uri === maskConnectionUriSecret(state.lastParsedUri) ||
            target.displayUri === maskConnectionUriSecret(state.lastParsedUri))) ||
        (lastParsedDisplayUri && target.displayUri === lastParsedDisplayUri))
    ) {
      return true
    }
    return await handleParseUri(target)
  }

  function ensureRequiredPasswordBeforeSubmit(targetId) {
    if (
      state.formDriver === 'sqlite' ||
      state.formDriver === 'duckdb' ||
      state.formDriver === 'libsql'
    ) {
      return true
    }
    const typedPassword = $('formPassword').value
    if (state.placeholderPasswordPending && !typedPassword) {
      showFormNotice(
        'Database Password is required — replace placeholder text like [YOUR-PASSWORD] by typing your actual Database Password.',
        'danger'
      )
      $('formPassword').focus()
      return false
    }
    const keepStored =
      Boolean(targetId) &&
      (state.editingId === targetId || Boolean(state.sourceSecretConnId)) &&
      state.formHadPassword
    if (typedPassword || keepStored) return true

    const host = $('formHost').value.trim()
    const isSupabaseHost = /\.supabase\.(?:co|com)$/i.test(host)
    if (
      (state.formDriver === 'postgres' || state.formDriver === 'cockroachdb') &&
      isSupabaseHost
    ) {
      showFormNotice(
        'Database Password is required for Supabase PostgreSQL (set in Project Settings -> Database -> Database password, not your Supabase account login password).',
        'danger'
      )
      $('formPassword').focus()
      return false
    }
    return true
  }

  return {
    initStaticSelectors,
    setFormColorTag,
    setFormDriver,
    syncSslVerifyUi,
    clearActiveAutoUri,
    resetConnectionForm,
    clearFormFields,
    populateFormFromProfile,
    buildFormSubmission,
    handleParseUri,
    detectWorkspace,
    renderDiscoveredItems,
    renderPanelFolderChips,
    refreshPanelByodAndWorkspaces,
    setFormControlsBusy,
    ensureUriParsedBeforeAction,
    ensureRequiredPasswordBeforeSubmit,
  }
}
