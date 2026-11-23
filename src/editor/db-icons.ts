// src/editor/db-icons.ts
// 9-Engine official brand vector SVG icon generators, engine metadata catalog, and pure Studio DOM/text helpers

import type { ConnectionColorTag, DatabaseDriverType } from '../protocol.js'
import {
  BYOD_LOGO_PATHS,
  CLICKHOUSE_LOGO_RECTS,
  DB_LOGO_COLORS,
  DB_LOGO_PATHS,
  FOLDER_CLOSED_PATH,
  FOLDER_OPEN_PATH,
  WORKSPACE_ICON_SHAPES,
} from '../shared-db-icons.js'
import { createCollapsibleSelectController } from '../shared-collapsible-select.js'
import { copyTextToClipboard } from './grid-formatters.js'

export { DB_LOGO_COLORS }

export interface StudioEngineMeta {
  id: DatabaseDriverType
  label: string
  defaultPort: number
  defaultDb: string
  defaultUser: string
  defaultSsl: boolean
}

export type ConnectionEngineMeta = StudioEngineMeta

export const STUDIO_ENGINES: ReadonlyArray<StudioEngineMeta> = [
  { id: 'sqlite', label: 'SQLite', defaultPort: 0, defaultDb: 'main.db', defaultUser: '', defaultSsl: false },
  { id: 'postgres', label: 'PostgreSQL', defaultPort: 5432, defaultDb: 'postgres', defaultUser: 'postgres', defaultSsl: false },
  { id: 'mysql', label: 'MySQL', defaultPort: 3306, defaultDb: 'mysql', defaultUser: 'root', defaultSsl: false },
  { id: 'mariadb', label: 'MariaDB', defaultPort: 3306, defaultDb: 'mysql', defaultUser: 'root', defaultSsl: false },
  { id: 'cockroachdb', label: 'CockroachDB', defaultPort: 26257, defaultDb: 'defaultdb', defaultUser: 'root', defaultSsl: true },
  { id: 'clickhouse', label: 'ClickHouse', defaultPort: 8123, defaultDb: 'default', defaultUser: 'default', defaultSsl: false },
  { id: 'redis', label: 'Redis', defaultPort: 6379, defaultDb: '0', defaultUser: '', defaultSsl: false },
  { id: 'libsql', label: 'LibSQL / Turso', defaultPort: 443, defaultDb: 'turso', defaultUser: '', defaultSsl: true },
  { id: 'd1', label: 'Cloudflare D1', defaultPort: 443, defaultDb: 'd1', defaultUser: '', defaultSsl: true },
]

export const BYOD_ENGINES: ReadonlyArray<StudioEngineMeta> = [
  { id: 'mssql' as DatabaseDriverType, label: 'SQL Server', defaultPort: 1433, defaultDb: 'master', defaultUser: 'sa', defaultSsl: false },
  { id: 'oracle' as DatabaseDriverType, label: 'Oracle', defaultPort: 1521, defaultDb: 'FREEPDB1', defaultUser: 'system', defaultSsl: false },
  { id: 'mongodb' as DatabaseDriverType, label: 'MongoDB', defaultPort: 27017, defaultDb: 'admin', defaultUser: 'admin', defaultSsl: false },
  { id: 'custom' as DatabaseDriverType, label: 'Custom BYOD', defaultPort: 5432, defaultDb: 'default', defaultUser: 'admin', defaultSsl: false },
]

export const CONNECTION_ENGINES = STUDIO_ENGINES

export const CONNECTION_ENV_TAGS: ReadonlyArray<{ id: ConnectionColorTag; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'dev', label: 'Dev' },
  { id: 'staging', label: 'Staging' },
  { id: 'prod', label: 'Prod' },
]

export function getStudioEngineMeta(driver: DatabaseDriverType): StudioEngineMeta {
  return (
    STUDIO_ENGINES.find((e) => e.id === driver) ??
    BYOD_ENGINES.find((e) => e.id === driver) ??
    STUDIO_ENGINES[0]
  )
}

export const getConnectionEngineMeta = getStudioEngineMeta

export function isKnownConnectionDriver(value: unknown): value is DatabaseDriverType {
  return (
    typeof value === 'string' &&
    (STUDIO_ENGINES.some((e) => e.id === value) || BYOD_ENGINES.some((e) => e.id === value))
  )
}

export function isByodConnectionDriver(value: unknown): boolean {
  return typeof value === 'string' && BYOD_ENGINES.some((e) => e.id === value)
}

export function createSvgElement(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v)
  }
  return el
}

export function createDbLogoSvg(driver: DatabaseDriverType): SVGElement {
  const byodKey = String(driver)
  if (Object.prototype.hasOwnProperty.call(BYOD_LOGO_PATHS, byodKey)) {
    return createByodDriverLogoSvg(byodKey)
  }
  const fallbackColor = DB_LOGO_COLORS[driver] || '#e6e6e6'
  const svg = createSvgElement('svg', {
    class: `db-svg db-${driver}`,
    width: '14',
    height: '14',
    viewBox: '0 0 24 24',
    fill: 'currentColor',
    style: `color: var(--db-${driver}, ${fallbackColor})`,
    'aria-hidden': 'true',
  })

  if (driver === 'clickhouse') {
    for (const rect of CLICKHOUSE_LOGO_RECTS) {
      svg.appendChild(createSvgElement('rect', rect))
    }
    return svg
  }

  const d = DB_LOGO_PATHS[driver] ?? DB_LOGO_PATHS.sqlite
  svg.appendChild(createSvgElement('path', { d }))
  return svg
}

export function createByodDriverLogoSvg(slotId: string): SVGElement {
  const entry = BYOD_LOGO_PATHS[slotId] ?? BYOD_LOGO_PATHS.custom
  const svg = createSvgElement('svg', {
    class: `db-svg db-byod-${slotId}`,
    width: '14',
    height: '14',
    viewBox: '0 0 24 24',
    fill: 'currentColor',
    style: `color: ${entry.color}`,
    'aria-hidden': 'true',
  })
  svg.appendChild(createSvgElement('path', { d: entry.d }))
  return svg
}

const BUTTON_ORIG_LABELS = new WeakMap<HTMLButtonElement, string>()

export function setButtonLoading(
  btn: HTMLButtonElement | null,
  busy: boolean,
  loadingLabel?: string
): void {
  if (!btn) return
  if (busy) {
    if (!BUTTON_ORIG_LABELS.has(btn)) {
      BUTTON_ORIG_LABELS.set(btn, btn.textContent || '')
    }
    btn.disabled = true
    btn.classList?.add?.('is-loading')
    const labelText = loadingLabel ?? BUTTON_ORIG_LABELS.get(btn) ?? ''
    let timerEl = btn.querySelector?.('.datanoa-live-timer')
    if (!timerEl) {
      btn.innerHTML = ''
      const spinner = document.createElement('span')
      spinner.className = 'datanoa-spinner'
      spinner.setAttribute('aria-hidden', 'true')
      timerEl = document.createElement('span')
      timerEl.className = 'datanoa-live-timer'
      btn.appendChild(spinner)
      btn.appendChild(timerEl)
    }
    timerEl.textContent = labelText
  } else {
    btn.classList?.remove?.('is-loading')
    if (BUTTON_ORIG_LABELS.has(btn)) {
      btn.textContent = BUTTON_ORIG_LABELS.get(btn) ?? ''
      BUTTON_ORIG_LABELS.delete(btn)
    }
    btn.disabled = false
  }
}

export function formatAggregateNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toFixed(4)))
}

export function formatRelativeTimestamp(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 10) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d ago`
}

export type DownloadTextResult = 'saved' | 'cancelled' | 'failed'

interface OrcaSaveAsBridge {
  files?: {
    saveAs?: (options: {
      suggestedName?: string
      mimeType?: string
      data: string | ArrayBuffer
    }) => Promise<{ status: 'saved' | 'cancelled' }>
  }
}

export async function downloadTextFile(
  content: string,
  filename: string,
  mimeType: string
): Promise<DownloadTextResult> {
  if (typeof window !== 'undefined') {
    const saveAs = (window as unknown as { orca?: OrcaSaveAsBridge }).orca?.files?.saveAs
    if (typeof saveAs === 'function') {
      try {
        const res = await saveAs({
          suggestedName: filename,
          mimeType,
          data: content,
        })
        return res?.status === 'cancelled' ? 'cancelled' : 'saved'
      } catch {
        // Fall back to Blob download if native save dialog fails or is unsupported
      }
    }
  }
  if (typeof document === 'undefined' || !document.body || typeof Blob === 'undefined') {
    return 'failed'
  }
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return 'failed'
  }
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => {
    URL.revokeObjectURL?.(url)
  }, 1000)
  return 'saved'
}

export function extractPredicateColumnName(
  rawHead: string
): { column: string; rest: string } | null {
  const s = rawHead.trimStart()
  if (!s) return null
  const q = s[0]
  if (q === '"' || q === '`') {
    let i = 1
    let col = ''
    while (i < s.length) {
      if (s[i] === q) {
        if (s[i + 1] === q) {
          col += q
          i += 2
          continue
        }
        return col ? { column: col, rest: s.slice(i + 1).trimStart() } : null
      }
      col += s[i]
      i++
    }
    return null
  }
  if (q === '[') {
    const closeIdx = s.indexOf(']', 1)
    if (closeIdx <= 1) return null
    return { column: s.slice(1, closeIdx), rest: s.slice(closeIdx + 1).trimStart() }
  }
  const m = /^([^\s=!<>]+)\s*(.*)$/.exec(s)
  if (!m || !m[1]) return null
  return { column: m[1], rest: m[2].trimStart() }
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable === true) return true
  if (typeof target.closest === 'function' && target.closest('.cm-editor, .cm-content')) {
    return true
  }
  return false
}

export function parseClientQuickFilterPredicate(
  predicateSql: string
): { column: string; op: 'eq' | 'neq' | 'is-null' | 'is-not-null'; value: unknown } | null {
  const parsedCol = extractPredicateColumnName(predicateSql.trim())
  if (!parsedCol) return null
  const { column, rest } = parsedCol
  const nullMatch = /^IS\s+(NOT\s+)?NULL$/i.exec(rest)
  if (nullMatch) {
    return {
      column,
      op: nullMatch[1] ? 'is-not-null' : 'is-null',
      value: null,
    }
  }
  const cmpMatch = /^(=|!=|<>)\s*(.+)$/.exec(rest)
  if (cmpMatch && cmpMatch[2]) {
    const op: 'eq' | 'neq' = cmpMatch[1] === '=' ? 'eq' : 'neq'
    const rawVal = cmpMatch[2].trim()
    let parsedVal: unknown = rawVal
    if (rawVal.startsWith("'") && rawVal.endsWith("'") && rawVal.length >= 2) {
      parsedVal = rawVal.slice(1, -1).replace(/''/g, "'")
    } else if (/^true$/i.test(rawVal)) {
      parsedVal = true
    } else if (/^false$/i.test(rawVal)) {
      parsedVal = false
    } else if (/^[+-]?\d+(?:\.\d+)?$/.test(rawVal)) {
      parsedVal = Number(rawVal)
    }
    return { column, op, value: parsedVal }
  }
  return null
}

export function fuzzyMatchScore(query: string, candidate: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const c = candidate.toLowerCase()
  if (c === q) return 100
  if (c.startsWith(q)) return 80
  const idx = c.indexOf(q)
  if (idx >= 0) return 60 - Math.min(idx, 30)
  let qi = 0
  let consecutive = 0
  let score = 0
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      qi++
      consecutive++
      score += 2 + consecutive
    } else {
      consecutive = 0
    }
  }
  return qi === q.length ? score : 0
}

export function extractQueriedTableName(sqlText: string): string | null {
  const cleaned = sqlText
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\b(?:EXTRACT|TRIM)\s*\([^()]*\bFROM\b[^()]*\)/gi, ' ')
    .trim()
  if (!/^\s*(?:WITH\b[\s\S]+?\bSELECT|SELECT)\b/i.test(cleaned)) {
    return null
  }
  const match = /\bFROM\s+(?:["`[\]]?[A-Za-z0-9_]+["`[\]]?\s*\.\s*)?["`[]?([A-Za-z0-9_]+)["`\]]?/i.exec(
    cleaned
  )
  if (!match || !match[1]) return null
  const candidate = match[1]
  if (/^(?:SELECT|WHERE|VALUES|LATERAL|UNNEST)$/i.test(candidate)) return null
  return candidate
}

export function copyTextFallback(text: string, triggerBtn?: HTMLButtonElement | null): void {
  copyTextToClipboard(text)
  if (triggerBtn) {
    const extBtn = triggerBtn as HTMLButtonElement & {
      _copyResetTimer?: ReturnType<typeof setTimeout>
    }
    if (extBtn._copyResetTimer !== undefined) {
      clearTimeout(extBtn._copyResetTimer)
    }
    const orig = triggerBtn.dataset.origLabel || triggerBtn.textContent || 'Copy'
    triggerBtn.dataset.origLabel = orig
    triggerBtn.textContent = 'Copied!'
    extBtn._copyResetTimer = setTimeout(() => {
      extBtn._copyResetTimer = undefined
      triggerBtn.textContent = orig
    }, 1200)
  }
}

export function bindStudioSelectTooltipsInRoot(root: ParentNode | Document): { dispose(): void } {
  if (typeof root?.addEventListener !== 'function') {
    return { dispose: () => {} }
  }
  const syncFromTarget = (target: EventTarget | null): void => {
    if (!(target instanceof HTMLSelectElement)) return
    const prefix = (
      target.getAttribute('aria-label') ||
      target.dataset?.tooltipPrefix ||
      ''
    ).trim()
    syncStudioSelectTooltip(target, prefix)
  }
  const onEnter = (e: Event): void => {
    syncFromTarget(e.target)
  }
  const onChange = (e: Event): void => {
    syncFromTarget(e.target)
  }
  root.addEventListener('mouseenter', onEnter, true)
  root.addEventListener('change', onChange, true)
  return {
    dispose: () => {
      root.removeEventListener('mouseenter', onEnter, true)
      root.removeEventListener('change', onChange, true)
    },
  }
}

export function createFolderIconSvg(isOpen = false, size = 13): SVGElement {
  const s = String(Math.max(10, Math.min(32, Math.round(size))))
  const svg = createSvgElement('svg', {
    class: `datanoa-folder-svg${isOpen ? ' is-open' : ''}`,
    width: s,
    height: s,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })
  svg.appendChild(
    createSvgElement('path', {
      d: isOpen ? FOLDER_OPEN_PATH : FOLDER_CLOSED_PATH,
    })
  )
  return svg
}

export function createWorkspaceIconSvg(size = 13): SVGElement {
  const s = String(Math.max(10, Math.min(32, Math.round(size))))
  const svg = createSvgElement('svg', {
    class: 'datanoa-workspace-svg',
    width: s,
    height: s,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })
  for (const shape of WORKSPACE_ICON_SHAPES) {
    svg.appendChild(createSvgElement(shape.tag, shape.attrs))
  }
  return svg
}

export function syncStudioSelectTooltip(
  selectEl: HTMLSelectElement | null,
  customPrefix?: string
): void {
  if (!selectEl) return
  const prefix =
    customPrefix ||
    selectEl.dataset?.tooltipPrefix ||
    selectEl.getAttribute?.('aria-label') ||
    'Selected option'
  if (selectEl.dataset && customPrefix) {
    selectEl.dataset.tooltipPrefix = customPrefix
  }
  const opts = selectEl.options
  const selectedOpt =
    opts && typeof selectEl.selectedIndex === 'number' && selectEl.selectedIndex >= 0
      ? opts[selectEl.selectedIndex]
      : null
  const valText = (
    selectedOpt?.dataset?.fullTitle ||
    selectedOpt?.textContent ||
    selectEl.value ||
    ''
  ).trim()
  selectEl.title = valText ? `${prefix}: ${valText}` : prefix
  const syncFn = (selectEl as unknown as { _studioCustomSync?: () => void })._studioCustomSync
  if (typeof syncFn === 'function') {
    syncFn()
  }
}

export interface ConnectionSelectorGroup<T> {
  label: string
  items: T[]
}

/**
 * Partition connections for the Studio selector with explicit user folders taking
 * precedence over workspace pins so a connection assigned to a folder always lands inside it.
 */
export function groupConnectionsForSelector<
  T extends { folder?: string; workspaceScope?: string },
>(
  connections: readonly T[],
  currentWorkspaceScope = ''
): { grouped: boolean; groups: ConnectionSelectorGroup<T>[] } {
  const scope = currentWorkspaceScope.trim()
  const currentWorkspace: T[] = []
  const otherWorkspace: T[] = []
  const general: T[] = []
  const byFolder = new Map<string, T[]>()
  let hasGrouping = false

  for (const conn of connections) {
    const folder = (conn.folder || '').trim()
    const connScope = (conn.workspaceScope || '').trim()
    if (folder || connScope) hasGrouping = true
    if (folder) {
      const list = byFolder.get(folder)
      if (list) list.push(conn)
      else byFolder.set(folder, [conn])
    } else if (connScope && scope && connScope === scope) {
      currentWorkspace.push(conn)
    } else if (connScope) {
      otherWorkspace.push(conn)
    } else {
      general.push(conn)
    }
  }

  if (!hasGrouping) {
    return { grouped: false, groups: [] }
  }

  const groups: ConnectionSelectorGroup<T>[] = []
  if (currentWorkspace.length > 0) {
    groups.push({ label: 'Current Workspace', items: currentWorkspace })
  }
  for (const folder of Array.from(byFolder.keys()).sort((a, b) => a.localeCompare(b))) {
    const list = byFolder.get(folder)
    if (list && list.length > 0) {
      groups.push({ label: folder, items: list })
    }
  }
  if (otherWorkspace.length > 0) {
    groups.push({ label: 'Other Workspaces', items: otherWorkspace })
  }
  if (general.length > 0) {
    groups.push({ label: 'General (Ungrouped)', items: general })
  }
  return { grouped: true, groups }
}

function createChevronLineSvg(width: string, points: string[]): SVGElement {
  const svg = createSvgElement('svg', {
    width: '11',
    height: '11',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': width,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })
  for (const pts of points) {
    svg.appendChild(createSvgElement('polyline', { points: pts }))
  }
  return svg
}

const studioSelectController = createCollapsibleSelectController({
  classes: {
    srOnly: 'datanoa-sr-only-select',
    trigger: 'datanoa-custom-select-trigger',
    leadIcon: 'datanoa-custom-select-lead-icon',
    label: 'datanoa-custom-select-label',
    chev: 'datanoa-custom-select-chev',
    popover: 'datanoa-custom-select-popover',
    head: 'datanoa-custom-select-head',
    search: 'datanoa-custom-select-search',
    actionBtn: 'datanoa-btn datanoa-btn-sm',
    list: 'datanoa-custom-select-list',
    item: 'datanoa-custom-select-item',
    itemIcon: 'datanoa-custom-select-item-icon',
    itemText: 'datanoa-custom-select-item-text',
    itemLabel: 'datanoa-custom-select-item-label',
    itemSub: 'datanoa-custom-select-item-sub',
    itemCheck: 'datanoa-custom-select-item-check',
    folderHead: 'datanoa-custom-select-folder-head',
    folderIcon: 'datanoa-custom-select-folder-icon',
    folderName: 'datanoa-custom-select-folder-name',
    folderCount: 'datanoa-custom-select-folder-count',
    empty: 'datanoa-custom-select-empty',
  },
  layout: {
    minWidth: 280,
    margin: 8,
    maxHeight: 340,
    vwFallback: 1024,
    vhFallback: 768,
    gap: 10,
    rectFallback: { left: 16, top: 40, bottom: 68, width: 240, height: 28 },
  },
  syncProp: '_studioCustomSync',
  mountedProp: '_studioCustomMounted',
  closeOnRefresh: false,
  fallbackQuerySelected: true,
  setActionAriaLabel: true,
  expandTitle: 'Expand all folders',
  collapseTitle: 'Collapse all folders',
  beforeEnhance: (selectEl, options) => {
    if (selectEl) syncStudioSelectTooltip(selectEl, options?.tooltipPrefix)
  },
  setLeadIconVisible: (el, visible) => {
    el.style.display = visible ? 'inline-flex' : 'none'
  },
  renderTriggerChevron: (span) => {
    span.appendChild(createChevronLineSvg('2.4', ['6 9 12 15 18 9']))
  },
  syncLeadIcon: (span, leadingIconType, selectedOpt) => {
    span.innerHTML = ''
    if (leadingIconType === 'workspace') {
      span.style.display = 'inline-flex'
      span.appendChild(createWorkspaceIconSvg(12))
    } else if (leadingIconType === 'db' && selectedOpt?.dataset?.driver) {
      span.style.display = 'inline-flex'
      const drv = selectedOpt.dataset.driver
      span.appendChild(createDbLogoSvg(isKnownConnectionDriver(drv) ? drv : 'sqlite'))
    } else {
      span.style.display = 'none'
    }
  },
  renderExpandIcon: (btn) => {
    btn.appendChild(createChevronLineSvg('2.2', ['7 13 12 18 17 13', '7 6 12 11 17 6']))
  },
  renderCollapseIcon: (btn) => {
    btn.appendChild(createChevronLineSvg('2.2', ['17 11 12 6 7 11', '17 18 12 13 7 18']))
  },
  renderItemIcon: (span, driver, leadingIconType) => {
    if (driver) {
      span.appendChild(createDbLogoSvg(isKnownConnectionDriver(driver) ? driver : 'sqlite'))
    } else if (leadingIconType === 'workspace') {
      span.appendChild(createWorkspaceIconSvg(12))
    }
  },
  applyFolderChevron: (span, isCollapsed) => {
    span.className = 'datanoa-custom-select-folder-chev'
    span.textContent = isCollapsed ? '▸' : '▾'
  },
  renderFolderIcon: (span, isOpen) => {
    span.appendChild(createFolderIconSvg(isOpen, 13))
  },
})

export function isStudioCollapsibleDropdownOpen(): boolean {
  return studioSelectController.isOpen()
}

export function closeActiveStudioCollapsibleDropdown(): void {
  studioSelectController.closeActive()
}

export interface StudioCollapsibleSelectOptions {
  tooltipPrefix?: string
  searchPlaceholder?: string
  collapsedFolders?: Set<string>
  defaultCollapseNonActiveFolders?: boolean
  leadingIconType?: 'none' | 'workspace' | 'db'
}

export function enhanceStudioCollapsibleSelect(
  selectEl: HTMLSelectElement | null,
  options?: StudioCollapsibleSelectOptions
): void {
  studioSelectController.enhance(selectEl, options)
}
