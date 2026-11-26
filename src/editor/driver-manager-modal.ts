// src/editor/driver-manager-modal.ts
// Dedicated Driver Manager modal: built-in engine catalog + BYOD local driver paths.

import type { DriverInspectResult, DriverRegistryItem, DriverVerifyResult } from '../protocol.js'
import { getCanonicalByodStarterCode } from '../drivers/common/byod-templates.js'
import {
  copyTextFallback,
  createByodDriverLogoSvg,
  createDbLogoSvg,
  isKnownConnectionDriver,
  setButtonLoading,
} from './db-icons.js'

export function getByodStarterTemplate(driverId: string): string {
  return getCanonicalByodStarterCode(driverId)
}

export function getByodNpmPackage(driverId: string): string {
  switch (driverId) {
    case 'duckdb':
      return '@duckdb/node-api'
    case 'snowflake':
      return 'snowflake-sdk'
    case 'bigquery':
      return '@google-cloud/bigquery'
    case 'cassandra':
      return 'cassandra-driver'
    case 'elasticsearch':
      return '@elastic/elasticsearch'
    case 'neo4j':
      return 'neo4j-driver'
    default:
      return ''
  }
}

export function buildByodInstallCommand(
  driverId: string,
  folderPath: string,
  platform = 'win32'
): string {
  const cleanDir =
    (folderPath || '').replace(/[\r\n\0]/g, '').trim().replace(/[/\\]index\.m?js$/i, '') ||
    (platform === 'win32' ? `C:\\datanoa-drivers\\${driverId}` : `$HOME/datanoa-drivers/${driverId}`)
  const pkg = getByodNpmPackage(driverId)
  const installStep = pkg ? ` && npm install --ignore-scripts ${pkg}` : ''
  const isWin = platform === 'win32' || /^[A-Za-z]:[/\\]/.test(cleanDir)
  if (isWin) {
    // PowerShell single-quoted literal strings suppress ALL $(), $var, and backtick expansion.
    const psQuoted = `'${cleanDir.replace(/'/g, "''")}'`
    const psInstall = pkg ? `; if ($?) { npm install --ignore-scripts ${pkg} }` : ''
    return (
      `New-Item -ItemType Directory -Force -Path ${psQuoted} | Out-Null; ` +
      `Set-Location -LiteralPath ${psQuoted}; ` +
      `if ($?) { npm init -y }; ` +
      `if ($?) { npm pkg set type=module main=index.mjs }${psInstall}`
    )
  }
  const posixSafe = cleanDir.startsWith('$HOME/')
    ? `"$HOME/${cleanDir.slice('$HOME/'.length).replace(/(["$`\\])/g, '\\$1')}"`
    : `'${cleanDir.replace(/'/g, `'\\''`)}'`
  return `mkdir -p ${posixSafe} && cd ${posixSafe} && npm init -y && npm pkg set type=module main=index.mjs${installStep}`
}

export interface StudioDriverManagerModalContext {
  mountModal: (modalEl: HTMLElement, canClose?: () => boolean) => HTMLDivElement | null
  closeModal: () => void
  requestPlugin: <T = unknown>(
    method: string,
    payload?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ) => Promise<T>
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  native: 'Native',
  'pure-ts-http': 'Pure-TS HTTP',
  'pure-ts-tcp': 'Pure-TS TCP',
  bundled: 'Bundled',
}

function packagingLabel(item: DriverRegistryItem): string {
  return KIND_LABEL[item.packaging] || item.packaging
}

function statusPill(item: DriverRegistryItem): { text: string; cls: string } {
  switch (item.status) {
    case 'builtin':
      return { text: 'Built-in', cls: 'is-builtin' }
    case 'local-verified':
      return { text: 'Verified', cls: 'is-verified' }
    case 'local-error':
      return { text: 'Error', cls: 'is-error' }
    default:
      return { text: 'Not Configured', cls: 'is-unconfigured' }
  }
}

function shortHash(hash: string | undefined): string {
  if (!hash) return ''
  return hash.length > 20 ? `${hash.slice(0, 12)}…${hash.slice(-6)}` : hash
}

export function openStudioDriverManagerModal(ctx: StudioDriverManagerModalContext): void {
  if (typeof document === 'undefined') return

  let items: DriverRegistryItem[] = []
  let isBusy = false
  let writeInFlight = false
  let loadSeq = 0
  const pendingInspects = new Map<string, { rawPath: string; result: DriverInspectResult }>()
  const pendingRetrusts = new Map<string, string>()
  const draftPaths = new Map<string, string>()

  const modal = document.createElement('div')
  modal.className = 'datanoa-driver-mgr-modal'

  const head = document.createElement('div')
  head.className = 'datanoa-modal-head'
  const title = document.createElement('span')
  title.textContent = 'Database Drivers — Built-in & Local BYOD'
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'datanoa-btn datanoa-btn-sm'
  closeBtn.textContent = 'Close'
  head.appendChild(title)
  head.appendChild(closeBtn)

  const body = document.createElement('div')
  body.className = 'datanoa-modal-body'

  const notice = document.createElement('div')
  notice.className = 'datanoa-modal-box is-pinned'
  notice.setAttribute('role', 'status')
  notice.style.display = 'none'

  const loading = document.createElement('div')
  loading.className = 'datanoa-driver-mgr-meta'
  loading.textContent = 'Loading drivers...'
  loading.style.display = 'none'
  body.appendChild(loading)

  const showNotice = (kind: 'error' | 'success' | 'neutral' | 'warn', text: string): void => {
    notice.className = `datanoa-modal-box is-pinned${kind === 'neutral' ? '' : ` ${kind}`}`
    notice.setAttribute('role', kind === 'error' || kind === 'warn' ? 'alert' : 'status')
    notice.textContent = text
    notice.style.display = 'block'
  }

  const builtinLabel = document.createElement('div')
  builtinLabel.className = 'datanoa-conn-section-label'
  builtinLabel.textContent = 'Built-in Engines'
  const builtinList = document.createElement('div')
  builtinList.className = 'datanoa-driver-mgr-builtin-list'

  const byodLabel = document.createElement('div')
  byodLabel.className = 'datanoa-conn-section-label'
  byodLabel.textContent = 'Local Custom Drivers (BYOD)'

  const byodGuide = document.createElement('details')
  byodGuide.className = 'datanoa-driver-mgr-guide'
  const byodGuideSummary = document.createElement('summary')
  byodGuideSummary.className = 'datanoa-driver-mgr-guide-summary'
  byodGuideSummary.textContent = 'How to install & load a local BYOD driver (DuckDB, Snowflake, BigQuery, Cassandra, Elasticsearch, Neo4j)'
  const byodGuideBody = document.createElement('div')
  byodGuideBody.className = 'datanoa-driver-mgr-guide-body'

  const guideIntro = document.createElement('p')
  guideIntro.className = 'datanoa-driver-mgr-meta'
  guideIntro.textContent =
    'Configure a local driver folder for DuckDB (@duckdb/node-api), Snowflake (snowflake-sdk), BigQuery (@google-cloud/bigquery), Cassandra (cassandra-driver), Elasticsearch (@elastic/elasticsearch), Neo4j (neo4j-driver), or a custom adapter, verify its SHA-256 digest below, then select it in New Database Connection.'

  const guideSteps = document.createElement('ol')
  guideSteps.className = 'datanoa-driver-mgr-guide-steps'
  const stepTexts = [
    'Create a folder and install the official driver: mkdir datanoa-duckdb && cd datanoa-duckdb && npm init -y && npm pkg set type=module main=index.mjs && npm install --ignore-scripts @duckdb/node-api',
    'Save index.mjs exporting default { type: "duckdb", createSession, testConnection } (the starter template below includes the IDatabaseSession method contract).',
    'Paste the folder or index.mjs absolute path into the BYOD slot below, click Inspect SHA-256 to review its digest without executing code, then click Trust & Verify.',
  ]
  for (const text of stepTexts) {
    const li = document.createElement('li')
    li.textContent = text
    guideSteps.appendChild(li)
  }

  const guideActions = document.createElement('div')
  guideActions.className = 'datanoa-driver-mgr-actions'
  const starterDefs: ReadonlyArray<{ label: string; pkg: string; code: string }> = [
    { label: 'Copy DuckDB Starter', pkg: '@duckdb/node-api', code: getByodStarterTemplate('duckdb') },
    { label: 'Copy Snowflake Starter', pkg: 'snowflake-sdk', code: getByodStarterTemplate('snowflake') },
    { label: 'Copy BigQuery Starter', pkg: '@google-cloud/bigquery', code: getByodStarterTemplate('bigquery') },
    { label: 'Copy Cassandra Starter', pkg: 'cassandra-driver', code: getByodStarterTemplate('cassandra') },
    { label: 'Copy Elasticsearch Starter', pkg: '@elastic/elasticsearch', code: getByodStarterTemplate('elasticsearch') },
    { label: 'Copy Neo4j Starter', pkg: 'neo4j-driver', code: getByodStarterTemplate('neo4j') },
  ]
  for (const def of starterDefs) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'datanoa-btn datanoa-btn-sm'
    btn.textContent = def.label
    btn.addEventListener('click', () => {
      copyTextFallback(def.code, btn)
      showNotice(
        'success',
        `Copied ${def.pkg} BYOD starter adapter (index.mjs) to clipboard. Install "${def.pkg}" in that folder, then click Inspect SHA-256 and Trust & Verify.`
      )
    })
    guideActions.appendChild(btn)
  }

  byodGuideBody.appendChild(guideIntro)
  byodGuideBody.appendChild(guideSteps)
  byodGuideBody.appendChild(guideActions)
  byodGuide.appendChild(byodGuideSummary)
  byodGuide.appendChild(byodGuideBody)

  const byodList = document.createElement('div')
  byodList.className = 'datanoa-driver-mgr-byod-list'

  body.appendChild(builtinLabel)
  body.appendChild(builtinList)
  body.appendChild(byodLabel)
  body.appendChild(byodGuide)
  body.appendChild(byodList)
  modal.appendChild(head)
  modal.appendChild(notice)
  modal.appendChild(body)

  const setBusy = (busy: boolean, writeActive = false): void => {
    isBusy = busy
    writeInFlight = busy && writeActive
    modal.querySelectorAll('button, input').forEach((el) => {
      if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) el.disabled = busy
    })
    closeBtn.disabled = busy && writeActive
  }

  const render = (): void => {
    builtinList.innerHTML = ''
    byodList.innerHTML = ''

    const builtins = items.filter((item) => item.category === 'builtin')
    for (const item of builtins) {
      const row = document.createElement('div')
      row.className = 'datanoa-driver-mgr-row'
      const icon = document.createElement('span')
      icon.className = 'datanoa-driver-mgr-icon'
      if (isKnownConnectionDriver(item.id)) icon.appendChild(createDbLogoSvg(item.id))
      const main = document.createElement('div')
      main.className = 'datanoa-driver-mgr-main'
      const name = document.createElement('div')
      name.className = 'datanoa-driver-mgr-name'
      name.textContent = item.name
      const meta = document.createElement('div')
      meta.className = 'datanoa-driver-mgr-meta'
      meta.textContent = `Transport: ${item.transport}`
      const badges = document.createElement('div')
      badges.className = 'datanoa-driver-mgr-badges'
      const packaging = document.createElement('span')
      packaging.className = 'datanoa-badge'
      packaging.textContent = packagingLabel(item)
      badges.appendChild(packaging)
      if (item.packaging === 'pure-ts-http') {
        const zero = document.createElement('span')
        zero.className = 'datanoa-badge datanoa-badge-pk'
        zero.textContent = 'Zero-vendor HTTP'
        badges.appendChild(zero)
      }
      main.appendChild(name)
      main.appendChild(meta)
      main.appendChild(badges)
      row.appendChild(icon)
      row.appendChild(main)
      builtinList.appendChild(row)
    }

    const byod = items.filter((item) => item.category === 'local-byod')
    for (const item of byod) {
      const row = document.createElement('div')
      row.className = 'datanoa-driver-mgr-byod'
      const top = document.createElement('div')
      top.className = 'datanoa-driver-mgr-byod-head'
      const titleGroup = document.createElement('span')
      titleGroup.className = 'datanoa-driver-mgr-name'
      titleGroup.style.display = 'inline-flex'
      titleGroup.style.alignItems = 'center'
      titleGroup.style.gap = '7px'
      const iconWrap = document.createElement('span')
      iconWrap.className = 'datanoa-driver-mgr-icon'
      iconWrap.appendChild(createByodDriverLogoSvg(item.id))
      const name = document.createElement('span')
      name.textContent = item.name
      titleGroup.appendChild(iconWrap)
      titleGroup.appendChild(name)
      const pill = statusPill(item)
      const pillEl = document.createElement('span')
      pillEl.className = `datanoa-driver-mgr-pill ${pill.cls}`
      pillEl.textContent = pill.text
      top.appendChild(titleGroup)
      top.appendChild(pillEl)
      row.appendChild(top)

      const desc = document.createElement('div')
      desc.className = 'datanoa-driver-mgr-meta'
      desc.textContent = item.description
      row.appendChild(desc)

      const pendingInspect = pendingInspects.get(item.id)
      const pendingRetrustSha = pendingRetrusts.get(item.id)

      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'datanoa-conn-input is-mono'
      input.placeholder = '/path/to/driver/index.mjs or driver folder'
      const savedDraft = draftPaths.get(item.id)
      input.value =
        savedDraft !== undefined
          ? savedDraft
          : pendingInspect
            ? pendingInspect.rawPath
            : item.localPath || ''
      input.setAttribute('aria-label', `Local driver path for ${item.name}`)
      row.appendChild(input)

      if (item.sha256) {
        const hash = document.createElement('div')
        hash.className = 'datanoa-driver-mgr-hash'
        hash.textContent = `Trusted SHA-256: ${shortHash(item.sha256)}`
        hash.title = item.sha256
        row.appendChild(hash)
      }
      if (item.resolvedEntry) {
        const entry = document.createElement('div')
        entry.className = 'datanoa-driver-mgr-meta'
        entry.textContent = `Entry: ${item.resolvedEntry}`
        entry.title = item.resolvedEntry
        row.appendChild(entry)
      }
      let inspectBoxEl: HTMLDivElement | null = null
      if (pendingInspect) {
        inspectBoxEl = document.createElement('div')
        inspectBoxEl.className = 'datanoa-modal-box'
        inspectBoxEl.textContent =
          `Pending fingerprint (not executed yet): ${shortHash(pendingInspect.result.sha256)} ` +
          `(${pendingInspect.result.resolvedEntry}). ${pendingInspect.result.scopeNote}`
        inspectBoxEl.title = pendingInspect.result.sha256
        row.appendChild(inspectBoxEl)
      }
      if (pendingRetrustSha) {
        const retrustBox = document.createElement('div')
        retrustBox.className = 'datanoa-modal-box warn'
        retrustBox.setAttribute('role', 'alert')
        retrustBox.textContent =
          `Modified driver detected (not loaded). New SHA-256: ${shortHash(pendingRetrustSha)}. ` +
          'Confirm Trust New SHA-256 only if you expect this change.'
        retrustBox.title = pendingRetrustSha
        row.appendChild(retrustBox)
      }
      if (item.error) {
        const err = document.createElement('div')
        err.className = 'datanoa-modal-box error'
        err.setAttribute('role', 'alert')
        err.textContent = item.error
        row.appendChild(err)
      }

      const actions = document.createElement('div')
      actions.className = 'datanoa-driver-mgr-actions'
      const inspectBtn = document.createElement('button')
      inspectBtn.type = 'button'
      inspectBtn.className = 'datanoa-btn datanoa-btn-sm'
      inspectBtn.textContent = 'Inspect SHA-256'
      inspectBtn.addEventListener('click', () => {
        void inspect(item.id, input.value, inspectBtn)
      })
      actions.appendChild(inspectBtn)

      let trustBtnEl: HTMLButtonElement | null = null
      if (pendingInspect) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-primary'
        btn.textContent = 'Trust & Verify'
        btn.addEventListener('click', () => {
          void configure(item.id, pendingInspect.rawPath, pendingInspect.result.sha256, btn)
        })
        trustBtnEl = btn
        actions.appendChild(btn)
      }
      input.addEventListener('input', () => {
        draftPaths.set(item.id, input.value)
        if (pendingInspects.has(item.id)) {
          pendingInspects.delete(item.id)
          inspectBoxEl?.remove()
          trustBtnEl?.remove()
          inspectBoxEl = null
          trustBtnEl = null
        }
      })

      if (item.status !== 'not-configured') {
        const verifyBtn = document.createElement('button')
        verifyBtn.type = 'button'
        verifyBtn.className = 'datanoa-btn datanoa-btn-sm'
        verifyBtn.textContent = 'Re-Verify SHA-256'
        verifyBtn.addEventListener('click', () => {
          void verify(item.id, verifyBtn)
        })
        actions.appendChild(verifyBtn)

        if (pendingRetrustSha) {
          const retrustBtn = document.createElement('button')
          retrustBtn.type = 'button'
          retrustBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-primary'
          retrustBtn.textContent = 'Trust New SHA-256'
          retrustBtn.addEventListener('click', () => {
            void verify(item.id, retrustBtn, pendingRetrustSha)
          })
          actions.appendChild(retrustBtn)
        }

        const removeBtn = document.createElement('button')
        removeBtn.type = 'button'
        removeBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-danger'
        removeBtn.textContent = 'Remove'
        removeBtn.addEventListener('click', () => {
          void remove(item.id, removeBtn)
        })
        actions.appendChild(removeBtn)
      }
      row.appendChild(actions)
      byodList.appendChild(row)
    }
  }

  const load = async (): Promise<void> => {
    const seq = ++loadSeq
    loading.style.display = ''
    setBusy(true)
    try {
      const res = await ctx.requestPlugin<{ drivers?: DriverRegistryItem[] }>('drivers.list', {})
      if (seq !== loadSeq || !isOpen()) return
      items = Array.isArray(res?.drivers) ? res.drivers : []
      render()
    } catch (err: unknown) {
      if (seq === loadSeq && isOpen()) {
        showNotice('error', `Failed to load drivers: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      if (seq === loadSeq && isOpen()) {
        loading.style.display = 'none'
        setBusy(false)
      }
    }
  }

  const isOpen = (): boolean => Boolean(modal.isConnected)

  const inspect = async (
    driverId: string,
    localPath: string,
    btn: HTMLButtonElement
  ): Promise<void> => {
    if (isBusy) return
    if (!localPath.trim()) {
      showNotice('error', 'Enter a local driver path first.')
      return
    }
    setBusy(true, true)
    setButtonLoading(btn, true, 'Inspecting...')
    try {
      const res = await ctx.requestPlugin<DriverInspectResult>('drivers.inspectLocal', {
        driverId,
        localPath,
      })
      if (!isOpen()) return
      if (!res?.sha256) {
        throw new Error('Invalid driver inspection response from worker.')
      }
      pendingInspects.set(driverId, { rawPath: localPath, result: res })
      showNotice(
        'neutral',
        `Inspected "${driverId}" without executing code (SHA-256 ${shortHash(res.sha256)}). Review and click Trust & Verify to load.`
      )
      render()
    } catch (err: unknown) {
      if (!isOpen()) return
      pendingInspects.delete(driverId)
      showNotice('error', `Inspection failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (isOpen()) {
        setButtonLoading(btn, false)
        setBusy(false)
      }
    }
  }

  const configure = async (
    driverId: string,
    localPath: string,
    trustedSha256: string,
    btn: HTMLButtonElement
  ): Promise<void> => {
    if (isBusy) return
    if (!localPath.trim()) {
      showNotice('error', 'Enter a local driver path first.')
      return
    }
    setBusy(true, true)
    setButtonLoading(btn, true, 'Verifying...')
    try {
      const res = await ctx.requestPlugin<{ ok: boolean; item: DriverRegistryItem }>(
        'drivers.configureLocal',
        { driverId, localPath, trustedSha256 }
      )
      if (!isOpen()) return
      if (!res?.item) {
        throw new Error('Invalid driver registry response from worker.')
      }
      pendingInspects.delete(driverId)
      pendingRetrusts.delete(driverId)
      items = items.map((item) => (item.id === res.item.id ? res.item : item))
      showNotice('success', `Local driver "${driverId}" trusted, verified, and saved.`)
      render()
    } catch (err: unknown) {
      if (!isOpen()) return
      showNotice('error', `Verification failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (isOpen()) {
        setButtonLoading(btn, false)
        setBusy(false)
      }
    }
  }

  const verify = async (
    driverId: string,
    btn: HTMLButtonElement,
    trustedSha256?: string
  ): Promise<void> => {
    if (isBusy) return
    setBusy(true, true)
    setButtonLoading(btn, true, 'Verifying...')
    try {
      const res = await ctx.requestPlugin<DriverVerifyResult>('drivers.verify', {
        driverId,
        ...(trustedSha256 ? { trustedSha256 } : {}),
      })
      if (!isOpen()) return
      if (!res?.item) {
        throw new Error('Invalid driver verification response from worker.')
      }
      if (res.requiresTrust && res.pendingSha256) {
        pendingRetrusts.set(driverId, res.pendingSha256)
      } else {
        pendingRetrusts.delete(driverId)
      }
      items = items.map((item) => (item.id === res.item.id ? res.item : item))
      showNotice(
        res.ok ? (res.sha256Changed ? 'warn' : 'success') : res.requiresTrust ? 'warn' : 'error',
        res.message
      )
      render()
    } catch (err: unknown) {
      if (!isOpen()) return
      showNotice('error', `Verification failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (isOpen()) {
        setButtonLoading(btn, false)
        setBusy(false)
      }
    }
  }

  const remove = async (driverId: string, btn: HTMLButtonElement): Promise<void> => {
    if (isBusy) return
    setBusy(true, true)
    setButtonLoading(btn, true, 'Removing...')
    try {
      await ctx.requestPlugin<{ ok: boolean }>('drivers.removeLocal', { driverId })
      if (!isOpen()) return
      pendingInspects.delete(driverId)
      pendingRetrusts.delete(driverId)
      items = items.map((item) =>
        item.id === driverId
          ? {
              ...item,
              status: 'not-configured',
              localPath: undefined,
              resolvedEntry: undefined,
              sha256: undefined,
              verifiedAt: undefined,
              error: undefined,
            }
          : item
      )
      showNotice('success', `Local driver "${driverId}" removed.`)
      render()
    } catch (err: unknown) {
      if (!isOpen()) return
      showNotice('error', `Remove failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (isOpen()) {
        setButtonLoading(btn, false)
        setBusy(false)
      }
    }
  }

  closeBtn.addEventListener('click', () => {
    if (!writeInFlight) ctx.closeModal()
  })

  ctx.mountModal(modal, () => !writeInFlight)
  render()
  void load()
  closeBtn.focus?.()
}

export const openDriverManagerModal = openStudioDriverManagerModal
