// src/panel/panel-connection-form.js
// Side Panel Connection Form, Engine Selector, URI Parser & Workspace Auto-Discovery

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

export function formatConnSubtitle(conn) {
  if (!conn) return ''
  if (conn.driver === 'sqlite') return conn.filePath || conn.database
  if (conn.driver === 'libsql') return conn.url || conn.database
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
  let byodActionBusy = false
  const BYOD_IDS = new Set(['mssql', 'oracle', 'mongodb', 'custom'])
  const BYOD_NPM_PKGS = { mssql: 'mssql', oracle: 'oracledb', mongodb: 'mongodb', custom: '' }
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
      const safeWin = cleanDir.replace(/"/g, '').replace(/%/g, '%%')
      return `mkdir "${safeWin}" 2>nul & cd /d "${safeWin}" && npm init -y && npm pkg set type=module main=index.mjs${installStep}`
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

  function setFormColorTag(tag) {
    state.formColorTag = ['dev', 'staging', 'prod'].includes(tag) ? tag : 'none'
    document.querySelectorAll('.env-pill').forEach((p) => {
      p.classList.toggle('active', p.dataset.env === state.formColorTag)
    })
    savePanelViewState?.()
  }

  function setFormDriver(driver, applyDefaults = true) {
    const prevDriver = state.formDriver
    const valid = ENGINE_BY_ID[driver] ? driver : 'sqlite'
    state.formDriver = valid
    document.querySelectorAll('.engine-tile').forEach((tile) => {
      tile.classList.toggle('active', tile.dataset.driver === valid)
    })

    const isSqlite = valid === 'sqlite'
    const isLibsql = valid === 'libsql'
    const isRedis = valid === 'redis'
    const isClickhouse = valid === 'clickhouse'
    const isPgFamily = valid === 'postgres' || valid === 'cockroachdb'

    $('sqliteFields').hidden = !isSqlite
    $('libsqlFields').hidden = !isLibsql
    $('serverFields').hidden = isSqlite || isLibsql
    $('clickhouseUrlRow').hidden = !isClickhouse
    if ($('pgOptionsRow')) $('pgOptionsRow').hidden = !isPgFamily
    $('sqlDbRow').hidden = isRedis
    $('redisDbRow').hidden = !isRedis

    if (!isPgFamily || (applyDefaults && prevDriver !== valid)) {
      state.formOptions = ''
      if ($('formOptions')) $('formOptions').value = ''
    }

    if (applyDefaults && !isSqlite && !isLibsql) {
      const meta = ENGINE_BY_ID[valid]
      $('formPort').value = String(meta.defaultPort)
      $('formDatabase').placeholder = meta.defaultDb
      $('formUser').value = meta.defaultUser
      $('formSsl').checked = valid === 'cockroachdb'
    }
    renderDiscoveredItems()
    syncPanelByodBox()
    clearFormNotice()
    savePanelViewState?.()
  }

  function initStaticSelectors() {
    const grid = $('engineGrid')
    grid.textContent = ''
    for (const eng of ENGINES) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `engine-tile${eng.id === state.formDriver ? ' active' : ''}`
      btn.dataset.driver = eng.id
      btn.title = eng.label
      const ico = document.createElement('span')
      setDbLogoElement(ico, eng.id, 15)
      const lbl = document.createElement('span')
      lbl.className = 'engine-tile-label'
      lbl.textContent = eng.label
      btn.append(ico, lbl)
      btn.addEventListener('click', () => setFormDriver(eng.id, true))
      grid.appendChild(btn)
    }

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
      void openPanelFilePickerModal({
        title: 'Select SQLite database file',
        mode: 'file',
        initialDir: $('formFilePath')?.value.trim() || undefined,
        extensions: ['.db', '.sqlite', '.sqlite3', '.db3'],
      })
        .then((res) => {
          if (!state.formOpen) return
          if (res?.ok && res.path) {
            if (state.formDriver !== 'sqlite') {
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
            showFormNotice(`${driverId} driver verified and ready!`, 'success')
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
      'formReadOnly',
    ]
    for (const id of trackedInputIds) {
      const el = $(id)
      if (!el) continue
      const evName =
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLInputElement && el.type === 'checkbox')
          ? 'change'
          : 'input'
      el.addEventListener(evName, () => {
        if (id === 'formWorkspaceScope') {
          state.pendingWorkspaceScope = null
        }
        if (el instanceof HTMLSelectElement) syncSelectTooltip(el)
        savePanelViewState?.()
      })
    }

    renderPanelFolderChips()
    void refreshPanelByodAndWorkspaces()
  }

  function resetConnectionForm() {
    state.editingId = null
    state.formHadPassword = false
    state.formHadAuthToken = false
    state.placeholderPasswordPending = false
    state.lastParsedPlaceholderUri = false
    state.sourceSecretConnId = null
    state.lastParsedUri = ''
    state.formOptions = ''
    state.lastAutoFilledSqliteName = ''
    state.discoveredFileFilter = ''
    if ($('discoveredFileSearch')) $('discoveredFileSearch').value = ''
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
    $('formReadOnly').checked = false
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

  function populateFormFromProfile(profile, mode = 'edit') {
    if (!profile?.driver || !ENGINE_BY_ID[profile.driver]) {
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

    if (driver === 'sqlite') {
      $('formFilePath').value = profile.filePath || profile.database || ''
    } else if (driver === 'libsql') {
      $('formLibsqlUrl').value = profile.url || ''
      $('formLibsqlDb').value = profile.database || ''
      if (profile.hasAuthToken && (mode === 'edit' || mode === 'duplicate')) {
        $('formAuthToken').placeholder = 'Stored token preserved (type to replace)'
      }
    } else {
      $('formHost').value = profile.host || 'localhost'
      $('formPort').value = String(profile.port || ENGINE_BY_ID[driver].defaultPort)
      $('formUser').value = profile.user || ''
      $('formSsl').checked = Boolean(profile.ssl)
      if (driver === 'redis') {
        $('formRedisDb').value = String(profile.redisDb ?? 0)
      } else {
        $('formDatabase').value = profile.database || ''
      }
      if (driver === 'clickhouse') {
        $('formClickhouseUrl').value = profile.url || ''
      }
      if (driver === 'postgres' || driver === 'cockroachdb') {
        const opts = typeof profile.options === 'string' ? profile.options : ''
        state.formOptions = opts
        if ($('formOptions')) $('formOptions').value = opts
      }
      if (profile.hasPassword && (mode === 'edit' || mode === 'duplicate')) {
        $('formPassword').placeholder = 'Stored password preserved (type to replace)'
      }
    }

    setFormOpen(true)
  }

  function buildFormSubmission(id) {
    const driver = state.formDriver
    const name = $('formName').value.trim()
    const readOnly = Boolean($('formReadOnly').checked)
    const colorTag = state.formColorTag
    const folder = ($('formFolder') ? $('formFolder').value : '').trim().slice(0, 64)
    const workspaceScope = ($('formWorkspaceScope') ? $('formWorkspaceScope').value : '').trim().slice(0, 260)

    if (driver === 'sqlite') {
      const filePath = $('formFilePath').value.trim()
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
          folder,
          workspaceScope,
        },
      }
    }

    if (driver === 'libsql') {
      const url = $('formLibsqlUrl').value.trim()
      const authToken = $('formAuthToken').value
      const database = $('formLibsqlDb').value.trim() || 'turso'
      const keepStoredToken =
        (state.editingId === id || Boolean(state.sourceSecretConnId)) && state.formHadAuthToken
      return {
        profile: {
          id,
          name: name || url || 'LibSQL',
          driver: 'libsql',
          database,
          url,
          ssl: /^(?:https|libsql|wss):\/\//i.test(url) || !/^http:\/\//i.test(url),
          readOnly,
          colorTag,
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
      hasPassword: Boolean(password) || keepStoredPassword,
      folder,
      workspaceScope,
    }

    if (driver === 'redis') {
      const rdb = Number.parseInt($('formRedisDb').value || '0', 10)
      profile.redisDb = Number.isFinite(rdb) && rdb >= 0 && rdb <= 15 ? rdb : 0
    }

    if (driver === 'postgres' || driver === 'cockroachdb') {
      const pgOptions = ($('formOptions') ? $('formOptions').value : state.formOptions || '').trim()
      if (pgOptions) profile.options = pgOptions
    }

    if (driver === 'clickhouse') {
      const chUrl = $('formClickhouseUrl').value.trim()
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
          if (parsedCh.protocol === 'https:') profile.ssl = true
          else if (parsedCh.protocol === 'http:') profile.ssl = false
        } catch {}
      } else {
        profile.url = generatedUrl
      }
    }

    if (state.editingId === id && Array.isArray(state.connections)) {
      const existing = state.connections.find((c) => c && c.id === id)
      if (existing) {
        if (existing.driver === driver) {
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
            if (existing[key] !== undefined && profile[key] === undefined) {
              profile[key] = existing[key]
            }
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

  async function handleParseUri(rawUri, options = {}) {
    const uri = (rawUri ?? $('uriInput').value).trim()
    if (!uri) return false
    const seq = ++parseUriSeq
    const parseBtn = $('parseUriBtn')
    clearFormNotice()
    setButtonLoading(parseBtn, true, 'Parsing...')
    try {
      const res = await rpc('connection.parseUri', { uri })
      if (seq !== parseUriSeq) return false
      if (!res?.ok || !res.profile) {
        showFormNotice(res?.error || 'Could not parse connection URI.', 'danger')
        return false
      }
      state.lastParsedUri = uri
      const p = res.profile
      if (!p.driver || !ENGINE_BY_ID[p.driver]) {
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
      if (p.name) $('formName').value = p.name
      if (p.readOnly !== undefined) $('formReadOnly').checked = Boolean(p.readOnly)
      if (driver === 'sqlite') {
        $('formFilePath').value = p.filePath || ''
      } else if (driver === 'libsql') {
        $('formLibsqlUrl').value = p.url || ''
        $('formLibsqlDb').value = p.database || ''
        $('formAuthToken').value = nextAuthToken
      } else {
        if (p.host) $('formHost').value = p.host
        if (p.port) $('formPort').value = String(p.port)
        if (p.user !== undefined) $('formUser').value = p.user
        if (p.ssl !== undefined) $('formSsl').checked = Boolean(p.ssl)
        if (driver === 'redis') {
          $('formRedisDb').value = String(p.redisDb ?? 0)
        } else if (p.database !== undefined) {
          $('formDatabase').value = p.database
        }
        if (driver === 'clickhouse' && p.url) {
          $('formClickhouseUrl').value = p.url
        }
        if (
          (driver === 'postgres' || driver === 'cockroachdb') &&
          typeof p.options === 'string' &&
          p.options.trim()
        ) {
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
      if (isManual && state.discoveredEnvs.length === 0 && state.discoveredFiles.length === 0) {
        showFormNotice(
          'No .env connections or SQLite database files found in the workspace.',
          'neutral'
        )
      }
    } catch {
      if (seq !== detectSeq) return
      state.discoveredEnvs = []
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

  function renderDiscoveredItems() {
    const box = $('discoveredBox')
    const envGroup = $('discoveredEnvGroup')
    const envList = $('discoveredEnvList')
    const fileGroup = $('discoveredFileGroup')
    const fileList = $('discoveredList')
    envList.textContent = ''
    fileList.textContent = ''

    const hasEnv = state.discoveredEnvs.length > 0
    const hasFiles = state.discoveredFiles.length > 0
    box.hidden = !hasEnv && !hasFiles
    envGroup.hidden = !hasEnv
    fileGroup.hidden = !hasFiles
    updateViewportLayout()

    if (hasEnv) {
      $('discoveredEnvCount').textContent = `${state.discoveredEnvs.length} found`
      for (const item of state.discoveredEnvs) {
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
        badge.textContent = item.sourceFile || '.env'
        top.append(title, badge)

        const sub = document.createElement('div')
        sub.className = 'file-chip-path'
        sub.textContent = maskedUri
        chip.append(top, sub)

        chip.addEventListener('click', () => {
          $('uriInput').value = item.uri
          if (!$('formName').value.trim()) $('formName').value = item.name || item.envKey
          void handleParseUri(item.uri, { clearMissingSecret: true })
        })
        envList.appendChild(chip)
      }
    }

    if (hasFiles) {
      const q = (state.discoveredFileFilter || '').trim().toLowerCase()
      const filteredFiles = q
        ? state.discoveredFiles.filter(
            (f) =>
              String(f.name || '').toLowerCase().includes(q) ||
              String(f.filePath || '').toLowerCase().includes(q)
          )
        : state.discoveredFiles
      $('discoveredCount').textContent = q
        ? `${filteredFiles.length} / ${state.discoveredFiles.length} found`
        : `${state.discoveredFiles.length} found`

      if (filteredFiles.length === 0) {
        const emptyEl = document.createElement('div')
        emptyEl.style.padding = '10px 8px'
        emptyEl.style.color = 'var(--t3)'
        emptyEl.style.fontSize = '12px'
        emptyEl.textContent = `No SQLite files match "${state.discoveredFileFilter}".`
        fileList.appendChild(emptyEl)
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
  }

  function setFormControlsBusy(busy) {
    const ids = ['testFormBtn', 'saveFormBtn', 'uriInput', 'parseUriBtn', 'detectWorkspaceBtn']
    for (const id of ids) {
      const el = $(id)
      if (el) el.disabled = Boolean(busy)
    }
  }

  async function ensureUriParsedBeforeAction() {
    const pendingUri = $('uriInput').value.trim()
    if (pendingUri && pendingUri !== state.lastParsedUri) {
      return await handleParseUri(pendingUri)
    }
    return true
  }

  function ensureRequiredPasswordBeforeSubmit(targetId) {
    if (state.formDriver === 'sqlite' || state.formDriver === 'libsql') return true
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
    resetConnectionForm,
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
