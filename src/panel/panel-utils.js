// src/panel/panel-utils.js
// Pure stateless DOM, IPC, SVG, theme, typography & file-export utilities for Datanoa Side Panel.

import { GEIST_FONT_DATA_URI } from '../assets/geist-font.js'
import {
  FOLDER_CLOSED_PATH,
  FOLDER_OPEN_PATH,
  buildPanelDbSvgMarkupMap,
  buildWorkspaceSvgMarkup,
} from '../shared-db-icons.js'
import { createCollapsibleSelectController } from '../shared-collapsible-select.js'
import { openSharedFilePickerModal } from '../shared-file-picker.js'
import { sanitizeJson, srgbLin } from './panel-core.js'

if (
  typeof document !== 'undefined' &&
  document.head &&
  !document.getElementById('datanoa-geist-font')
) {
  const fontStyle = document.createElement('style')
  fontStyle.id = 'datanoa-geist-font'
  fontStyle.textContent = `@font-face { font-family: 'Geist'; src: url('${GEIST_FONT_DATA_URI}') format('woff2'); font-weight: 100 900; font-style: normal; font-display: block; }`
  document.head.prepend(fontStyle)
}

export const DB_SVG_MARKUP = buildPanelDbSvgMarkupMap()

export function getDbLogoSvg(driver, size = 14) {
  const safe = Object.prototype.hasOwnProperty.call(DB_SVG_MARKUP, driver) ? driver : 'sqlite'
  const safeSize = Number.isFinite(Number(size)) ? Math.max(8, Math.min(64, Math.round(Number(size)))) : 14
  return DB_SVG_MARKUP[safe].replace(/width="14" height="14"/, `width="${safeSize}" height="${safeSize}"`)
}

export function setDbLogoElement(container, driver, size = 14) {
  container.innerHTML = getDbLogoSvg(driver, size)
}

export async function rpc(name, input, options) {
  const payload = input === undefined ? undefined : sanitizeJson(input)
  if (window.orca?.plugin?.request) {
    if (options) {
      return await window.orca.plugin.request(name, payload === undefined ? {} : payload, options)
    }
    return payload === undefined
      ? await window.orca.plugin.request(name)
      : await window.orca.plugin.request(name, payload)
  }
  if (window.orca?.host?.call) {
    const params = { name }
    if (payload !== undefined) params.input = payload
    if (options?.timeoutMs) params.timeoutMs = options.timeoutMs
    const callOpts = {}
    if (options?.signal !== undefined) callOpts.signal = options.signal
    if (options?.timeoutMs !== undefined) callOpts.timeoutMs = options.timeoutMs
    const res =
      Object.keys(callOpts).length > 0
        ? await window.orca.host.call('plugin.request', params, callOpts)
        : await window.orca.host.call('plugin.request', params)
    return res?.output
  }
  throw new Error('Orca IPC bridge is unavailable')
}

const SIDEBAR_NEAR_BLACK_MAX_CHANNEL = 24
const SIDEBAR_LUM_EPSILON = 1e-4
const OPAQUE_ALPHA_THRESHOLD = 0.99
const NUMERIC_TOKEN_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/

function parseNumericChannels(inner) {
  const parts = inner
    .replace(/\//g, ' ')
    .replace(/,/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (parts.length < 3 || parts.length > 4) return null
  const values = []
  for (const part of parts) {
    if (!NUMERIC_TOKEN_RE.test(part)) return null
    const n = Number(part)
    if (!Number.isFinite(n)) return null
    values.push(n)
  }
  if (values.length === 4 && values[3] < OPAQUE_ALPHA_THRESHOLD) return null
  return values
}

export function parseComputedRgb(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim().toLowerCase()
  if (!text || text === 'transparent') return null

  const srgbMatch = text.match(/^color\(\s*srgb\s+([^)]+)\)$/)
  if (srgbMatch) {
    const nums = parseNumericChannels(srgbMatch[1])
    if (!nums) return null
    return [
      Math.max(0, Math.min(255, Math.round(nums[0] * 255))),
      Math.max(0, Math.min(255, Math.round(nums[1] * 255))),
      Math.max(0, Math.min(255, Math.round(nums[2] * 255))),
    ]
  }

  const rgbMatch = text.match(/^rgba?\(([^)]+)\)$/)
  if (!rgbMatch) return null
  const nums = parseNumericChannels(rgbMatch[1])
  if (!nums) return null
  return [
    Math.max(0, Math.min(255, nums[0])),
    Math.max(0, Math.min(255, nums[1])),
    Math.max(0, Math.min(255, nums[2])),
  ]
}

function relativeLuminance(rgb) {
  return 0.2126 * srgbLin(rgb[0]) + 0.7152 * srgbLin(rgb[1]) + 0.0722 * srgbLin(rgb[2])
}

/**
 * Orca's 22-token frame allowlist omits `--sidebar` while painting RightSidebar with `bg-sidebar`.
 * Derive the matching sidebar surface from `--orca-background` and `--orca-card` across all Orca theme archetypes:
 * - Light themes: use `--orca-card` when darker than `--background`, or subtle 98% tint on pure `#ffffff` (Orca Default Light `#fafafa`).
 * - Dark themes with `--card < --background` (Tokyo Night, Catppuccin, One Dark Pro, GitHub Dark, VS Code Modern): `--card === --sidebar`.
 * - Dark themes with `--card > --background` on near-black canvas (Orca Default Dark `#0a0a0a`): `--card === --sidebar` (`#171717`).
 * - Dark themes with `--card > --background` on slate/mid-dark canvas (Dracula `#282a36`, Nord, Gruvbox Dark): recess `--background` 82% (`#21222c` on Dracula).
 * - Flat themes (`--card === --background`): keep `--orca-background`.
 */
export function resolveOrcaSidebarBackground(bgRgb, cardRgb) {
  if (!bgRgb || !cardRgb) return null
  const lumBg = relativeLuminance(bgRgb)
  const lumCard = relativeLuminance(cardRgb)
  const isLight = lumBg > 0.45

  if (isLight) {
    if (lumCard < lumBg - SIDEBAR_LUM_EPSILON) return 'var(--orca-card)'
    if (bgRgb[0] >= 252 && bgRgb[1] >= 252 && bgRgb[2] >= 252) {
      return 'color-mix(in srgb, var(--orca-background) 98%, var(--orca-foreground))'
    }
    return null
  }

  if (lumCard < lumBg - SIDEBAR_LUM_EPSILON) return 'var(--orca-card)'
  if (lumCard > lumBg + SIDEBAR_LUM_EPSILON) {
    const maxChannel = Math.max(bgRgb[0], bgRgb[1], bgRgb[2])
    if (maxChannel <= SIDEBAR_NEAR_BLACK_MAX_CHANNEL) return 'var(--orca-card)'
    return 'color-mix(in srgb, var(--orca-background) 82%, #000000)'
  }
  return null
}

function probeComputedBackgroundRgb(cssExpr) {
  if (typeof document === 'undefined' || !document.body) return null
  const getStyle =
    typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle
      : globalThis.getComputedStyle
  if (typeof getStyle !== 'function') return null
  const probe = document.createElement('div')
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.background = cssExpr
  document.body.appendChild(probe)
  try {
    return parseComputedRgb(getStyle(probe)?.backgroundColor)
  } finally {
    probe.remove()
  }
}

function applyResolvedSidebarBackground(bgRgb) {
  if (typeof document === 'undefined' || !document.documentElement) return
  if (!bgRgb) {
    document.documentElement.style.removeProperty('--panel-bg')
    return
  }
  const cardRgb = probeComputedBackgroundRgb('var(--orca-card, rgba(0, 0, 0, 0))')
  const sidebarExpr = resolveOrcaSidebarBackground(bgRgb, cardRgb)
  if (sidebarExpr) {
    document.documentElement.style.setProperty('--panel-bg', sidebarExpr)
  } else {
    document.documentElement.style.removeProperty('--panel-bg')
  }
}

export function syncSidebarBackgroundFromTokens() {
  try {
    const bgRgb = probeComputedBackgroundRgb('var(--orca-background, #000000)')
    applyResolvedSidebarBackground(bgRgb)
  } catch {}
}

export function syncThemeFromTokens() {
  try {
    const bgRgb = probeComputedBackgroundRgb('var(--orca-background, #000000)')
    if (!bgRgb) {
      applyResolvedSidebarBackground(null)
      return
    }
    const isLight = relativeLuminance(bgRgb) > 0.45
    document.documentElement.classList.toggle('light', isLight)
    document.documentElement.classList.toggle('dark', !isLight)
    document.body?.classList.toggle('light', isLight)
    document.body?.classList.toggle('dark', !isLight)
    applyResolvedSidebarBackground(bgRgb)
  } catch {}
}

export function applyTypographySnapshot(typo) {
  if (!typo) return
  const root = document.documentElement
  if (typo.cssFontFamily) {
    root.style.setProperty('--mono', typo.cssFontFamily)
  }
}

export async function syncOrcaTypography() {
  try {
    if (
      window.orca?.host?.call &&
      (typeof window.orca.host.has !== 'function' || window.orca.host.has('editor.readTypography'))
    ) {
      const typo = await window.orca.host.call('editor.readTypography')
      applyTypographySnapshot(typo)
    }
  } catch {}
}

const V2_TABLE_KEY_COMPONENT_RE = /[:%|]|^\s|\s$/

export function makeTableKey(connectionId, tableName, schemaName) {
  const rawConn = connectionId == null ? '' : String(connectionId)
  const conn = rawConn.trim().length > 0 ? rawConn : 'none'
  const sch = schemaName == null ? '' : String(schemaName)
  const tbl = tableName == null ? '' : String(tableName)
  if (
    conn === 'v2' ||
    V2_TABLE_KEY_COMPONENT_RE.test(conn) ||
    V2_TABLE_KEY_COMPONENT_RE.test(sch) ||
    V2_TABLE_KEY_COMPONENT_RE.test(tbl)
  ) {
    return `v2:${encodeURIComponent(conn)}:${encodeURIComponent(sch)}:${encodeURIComponent(tbl)}`
  }
  return `${conn}:${sch}:${tbl}`
}

export function makeLegacyTableKey(connectionId, tableName, schemaName) {
  return `${connectionId || 'none'}:${schemaName || ''}:${tableName || ''}`
}

export function canUseLegacyTableKeyFallback(connectionId, tableName, schemaName) {
  const rawConn = connectionId == null ? '' : String(connectionId)
  const conn = rawConn.trim().length > 0 ? rawConn : 'none'
  const sch = schemaName == null ? '' : String(schemaName)
  const tbl = tableName == null ? '' : String(tableName)
  return (
    conn !== 'v2' &&
    !V2_TABLE_KEY_COMPONENT_RE.test(conn) &&
    !V2_TABLE_KEY_COMPONENT_RE.test(sch) &&
    !V2_TABLE_KEY_COMPONENT_RE.test(tbl)
  )
}

export function normalizeTableKey(rawKey) {
  const raw = rawKey == null ? '' : String(rawKey)
  if (!raw.startsWith('v2:')) return raw
  const parts = raw.slice(3).split(':')
  if (parts.length !== 3) return raw
  try {
    return makeTableKey(
      decodeURIComponent(parts[0]),
      decodeURIComponent(parts[2]),
      decodeURIComponent(parts[1])
    )
  } catch {
    return raw
  }
}

export function tableKeyMatchesConnection(key, connectionId) {
  if (typeof key !== 'string' || !key || typeof connectionId !== 'string' || !connectionId) {
    return false
  }
  const conn = connectionId.trim()
  if (!conn) return false
  if (key.startsWith('v2:')) {
    const parts = key.slice(3).split(':')
    if (parts.length !== 3) return false
    try {
      const decodedConn = decodeURIComponent(parts[0])
      return decodedConn === connectionId || decodedConn === conn
    } catch {
      return false
    }
  }
  return key.startsWith(`${connectionId}:`) || key.startsWith(`${conn}:`)
}

export function encodeTableSelectValue(schemaName, tableName) {
  return `${schemaName || ''}\0${tableName || ''}`
}

export function decodeTableSelectValue(encoded) {
  const raw = String(encoded || '')
  const sep = raw.indexOf('\0')
  if (sep < 0) return { schema: undefined, name: raw }
  const sch = raw.slice(0, sep)
  return { schema: sch || undefined, name: raw.slice(sep + 1) }
}

export function setButtonLoading(btn, isLoading, loadingText) {
  if (!btn) return
  if (isLoading) {
    if (btn.dataset.origHtml === undefined) {
      btn.dataset.origHtml = btn.innerHTML
      btn.dataset.origText = btn.textContent || ''
    }
    btn.disabled = true
    btn.setAttribute('aria-busy', 'true')
    btn.classList.add('is-loading')
    btn.textContent = ''
    const sp = document.createElement('span')
    sp.className = 'btn-spinner'
    sp.setAttribute('aria-hidden', 'true')
    btn.appendChild(sp)
    const labelText = loadingText !== undefined ? loadingText : btn.dataset.origText
    if (labelText) {
      const lbl = document.createElement('span')
      lbl.className = 'btn-loading-label'
      lbl.textContent = labelText
      btn.appendChild(lbl)
    }
  } else {
    btn.disabled = false
    btn.removeAttribute('aria-busy')
    btn.classList.remove('is-loading')
    if (btn.dataset.origHtml !== undefined) {
      btn.innerHTML = btn.dataset.origHtml
      delete btn.dataset.origHtml
      delete btn.dataset.origText
    }
  }
}

export function updateButtonLoadingLabel(btn, loadingText) {
  if (!btn) return
  const lbl = btn.querySelector('.btn-loading-label')
  if (lbl) {
    lbl.textContent = loadingText
  }
}

export function createElapsedTimer(onTick) {
  const startedAt = Date.now()
  let stopped = false
  const emit = () => {
    if (stopped) return
    const sec = ((Date.now() - startedAt) / 1000).toFixed(1)
    onTick(`${sec}s`)
  }
  emit()
  const timerId = setInterval(emit, 200)
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timerId)
  }
}

export async function downloadTextFile(filename, content, mimeType = 'text/plain;charset=utf-8') {
  const payload = String(content ?? '')
  if (window.orca && window.orca.files && typeof window.orca.files.saveAs === 'function') {
    try {
      const res = await window.orca.files.saveAs({
        suggestedName: filename,
        mimeType,
        data: payload,
      })
      return res && res.status === 'cancelled' ? 'cancelled' : 'saved'
    } catch {
      // Fall back to Blob download below
    }
  }
  try {
    const blob = new Blob([payload], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return 'saved'
  } catch {
    return 'failed'
  }
}

export { bindCtrlWheelHorizontalScroll } from '../shared-wheel-scroll.js'

export function createEnvBadge(colorTag) {
  if (!colorTag || colorTag === 'none') return null
  const span = document.createElement('span')
  span.className = `badge badge-env-${colorTag}`
  span.textContent = colorTag.toUpperCase()
  return span
}

export function createSortSvg(direction) {
  const ns = 'http://www.w3.org/2000/svg'
  const make = (tag, attrs) => {
    const el = typeof document.createElementNS === 'function'
      ? document.createElementNS(ns, tag)
      : document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v)
    }
    return el
  }
  const svg = make('svg', {
    width: '11',
    height: '11',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2.2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })
  svg.appendChild(make('line', { x1: '12', y1: '5', x2: '12', y2: '19' }))
  svg.appendChild(
    make('polyline', {
      points: direction === 'ASC' ? '6 11 12 5 18 11' : '6 13 12 19 18 13',
    })
  )
  return svg
}

export function getFolderSvgMarkup(isOpen = false, size = 13) {
  const s = Number.isFinite(Number(size)) ? Math.max(10, Math.min(32, Math.round(Number(size)))) : 13
  const d = isOpen ? FOLDER_OPEN_PATH : FOLDER_CLOSED_PATH
  return `<svg class="folder-svg${isOpen ? ' is-open' : ''}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"></path></svg>`
}

export function getWorkspaceSvgMarkup(size = 13) {
  return buildWorkspaceSvgMarkup('workspace-svg', size)
}

export function syncSelectTooltip(selectEl, customPrefix) {
  if (!selectEl) return
  const prefix =
    customPrefix ||
    selectEl.dataset?.tooltipPrefix ||
    selectEl.getAttribute('aria-label') ||
    'Selected option'
  if (selectEl.dataset && customPrefix) {
    selectEl.dataset.tooltipPrefix = customPrefix
  }
  const selectedOpt =
    selectEl.options && selectEl.selectedIndex >= 0
      ? selectEl.options[selectEl.selectedIndex]
      : null
  const valText = (selectedOpt?.getAttribute('data-full-title') || selectedOpt?.textContent || selectEl.value || '').trim()
  const fullTooltip = valText ? `${prefix}: ${valText}` : prefix
  selectEl.title = fullTooltip
  if (selectEl._customDropdownSync) {
    selectEl._customDropdownSync()
  }
}

export function bindSelectTooltipsInRoot(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') return
  const selects = root.querySelectorAll('select')
  selects.forEach((sel) => {
    syncSelectTooltip(sel)
    if (!sel.dataset?.tooltipBound) {
      if (sel.dataset) sel.dataset.tooltipBound = '1'
      sel.addEventListener('change', () => syncSelectTooltip(sel))
      sel.addEventListener('mouseenter', () => syncSelectTooltip(sel))
    }
  })
}

const panelSelectController = createCollapsibleSelectController({
  classes: {
    srOnly: 'sr-only-select',
    trigger: 'custom-select-trigger',
    leadIcon: 'custom-select-lead-icon',
    label: 'custom-select-label',
    triggerBadges: 'custom-select-trigger-badges',
    chev: 'custom-select-chev',
    popover: 'custom-select-popover',
    head: 'custom-select-head',
    search: 'input custom-select-search',
    actionBtn: 'btn btn-ghost btn-icon btn-sm',
    list: 'custom-select-list',
    item: 'custom-select-item',
    itemIcon: 'custom-select-item-icon',
    itemText: 'custom-select-item-text',
    itemLabel: 'custom-select-item-label',
    itemSub: 'custom-select-item-sub',
    itemBadges: 'custom-select-item-badges',
    badge: 'cs-badge',
    itemCheck: 'custom-select-item-check',
    dragHandle: 'custom-select-drag-handle',
    dragSpacer: 'custom-select-drag-spacer',
    folderHead: 'custom-select-folder-head',
    folderIcon: 'custom-select-folder-icon',
    folderName: 'custom-select-folder-name',
    folderCount: 'custom-select-folder-count',
    empty: 'custom-select-empty',
  },
  layout: {
    minWidth: 320,
    margin: 6,
    maxHeight: 440,
    vwFallback: 360,
    vhFallback: 640,
    gap: 8,
    rectFallback: { left: 6, top: 40, bottom: 68, width: 250, height: 28 },
  },
  syncProp: '_customDropdownSync',
  apiProp: '_customDropdownApi',
  closeOnRefresh: false,
  fallbackQuerySelected: false,
  setActionAriaLabel: true,
  expandTitle: 'Expand all folders in dropdown',
  collapseTitle: 'Collapse all folders in dropdown',
  setLeadIconVisible: (el, visible) => {
    el.hidden = !visible
  },
  renderTriggerChevron: (span) => {
    span.innerHTML =
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>'
  },
  syncLeadIcon: (span, leadingIconType, selectedOpt) => {
    if (leadingIconType === 'workspace') {
      span.hidden = false
      span.innerHTML = getWorkspaceSvgMarkup(12)
    } else if (leadingIconType === 'db' && selectedOpt?.dataset?.driver) {
      span.hidden = false
      span.innerHTML = getDbLogoSvg(selectedOpt.dataset.driver, 13)
    } else {
      span.hidden = true
    }
  },
  renderExpandIcon: (btn) => {
    btn.innerHTML =
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="7 13 12 18 17 13"></polyline><polyline points="7 6 12 11 17 6"></polyline></svg>'
  },
  renderCollapseIcon: (btn) => {
    btn.innerHTML =
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="17 11 12 6 7 11"></polyline><polyline points="17 18 12 13 7 18"></polyline></svg>'
  },
  renderItemIcon: (span, driver, leadingIconType) => {
    span.innerHTML = driver
      ? getDbLogoSvg(driver, 13)
      : leadingIconType === 'workspace'
        ? getWorkspaceSvgMarkup(12)
        : ''
  },
  applyFolderChevron: (span, isCollapsed) => {
    span.className = `tree-chevron${isCollapsed ? '' : ' open'}`
    span.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>'
  },
  renderFolderIcon: (span, isOpen) => {
    span.innerHTML = getFolderSvgMarkup(isOpen, 13)
  },
})

export function isCustomDropdownOpen() {
  return panelSelectController.isOpen()
}

export function closeActiveCustomDropdown() {
  panelSelectController.closeActive()
}

/**
 * Enhances a native <select> with a rich custom dropdown trigger & floating popover
 * supporting collapsible folders, instant search, expand/collapse all, and full hover tooltips,
 * while keeping the underlying <select> 100% synchronized.
 */
export function enhanceCollapsibleSelectDropdown(selectEl, options = {}) {
  return panelSelectController.enhance(selectEl, options)
}

export function $(id) {
  return document.getElementById(id)
}

function execCommandCopyFallback(val) {
  let copied = false
  if (typeof document === 'undefined' || !document.body) return false
  try {
    const prevActive =
      typeof HTMLElement !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    const ta = document.createElement('textarea')
    ta.value = val
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.left = '-9999px'
    ta.style.width = '1px'
    ta.style.height = '1px'
    ta.style.opacity = '0'
    ta.style.pointerEvents = 'none'
    document.body.appendChild(ta)
    try {
      ta.focus({ preventScroll: true })
    } catch {
      ta.focus()
    }
    ta.select()
    try {
      if (typeof ta.setSelectionRange === 'function') {
        ta.setSelectionRange(0, val.length)
      }
    } catch {}
    try {
      if (typeof document.execCommand === 'function') {
        copied = Boolean(document.execCommand('copy'))
      }
    } catch {}
    ta.remove()
    if (prevActive && typeof prevActive.focus === 'function') {
      try {
        prevActive.focus({ preventScroll: true })
      } catch {
        prevActive.focus()
      }
    }
  } catch {}
  return copied
}

export async function writeTextToClipboard(text) {
  const val = String(text ?? '')
  const syncCopied = execCommandCopyFallback(val)
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(val)
      return true
    } catch {
      // Preserve synchronous activation copy success when async Clipboard API rejects
    }
  }
  return syncCopied
}

export function syncVirtualTableWindow({
  virt,
  total,
  start,
  end,
  rowHeightPx,
  topSpacerPx,
  bottomSpacerPx,
  createRow,
  selectionController,
  onBeforeDetachRow,
  force = false,
}) {
  const { tbody, topSpacerTr, topSpacerTd, bottomSpacerTr, bottomSpacerTd } = virt
  const topPx =
    typeof topSpacerPx === 'number' && Number.isFinite(topSpacerPx)
      ? Math.max(0, Math.round(topSpacerPx))
      : start * rowHeightPx
  const bottomPx =
    typeof bottomSpacerPx === 'number' && Number.isFinite(bottomSpacerPx)
      ? Math.max(0, Math.round(bottomSpacerPx))
      : Math.max(0, (total - end) * rowHeightPx)

  const prevTopStr = topSpacerTd?.style.height || ''
  const prevBottomStr = bottomSpacerTd?.style.height || ''
  const nextTopStr = `${topPx}px`
  const nextBottomStr = `${bottomPx}px`
  const spacersChanged =
    virt.topSpacerPx !== topPx ||
    virt.bottomSpacerPx !== bottomPx ||
    prevTopStr !== nextTopStr ||
    prevBottomStr !== nextBottomStr

  if (!force && start === virt.start && end === virt.end && !spacersChanged) {
    return false
  }

  if (topSpacerTr && topSpacerTd) {
    topSpacerTr.style.display = topPx > 0 ? '' : 'none'
    topSpacerTd.style.height = nextTopStr
  }
  if (bottomSpacerTr && bottomSpacerTd) {
    bottomSpacerTr.style.display = bottomPx > 0 ? '' : 'none'
    bottomSpacerTd.style.height = nextBottomStr
  }
  virt.topSpacerPx = topPx
  virt.bottomSpacerPx = bottomPx

  if (!force && start === virt.start && end === virt.end) {
    return true
  }

  const isDomEl = (node) =>
    typeof HTMLElement !== 'undefined'
      ? node instanceof HTMLElement
      : Boolean(node && node.nodeType === 1)

  const prevStart = virt.start
  const prevEnd = virt.end
  const canReuse =
    !force && prevStart >= 0 && prevEnd > prevStart && start < prevEnd && end > prevStart

  if (!canReuse) {
    let node = topSpacerTr ? topSpacerTr.nextSibling : tbody.firstChild
    while (node && node !== bottomSpacerTr) {
      const next = node.nextSibling
      if (isDomEl(node)) {
        onBeforeDetachRow?.(node)
        selectionController?.detachRow(node)
      }
      node.remove()
      node = next
    }
    const frag = document.createDocumentFragment()
    for (let r = start; r < end; r++) {
      frag.appendChild(createRow(r))
    }
    tbody.insertBefore(frag, bottomSpacerTr)
  } else {
    let node = topSpacerTr ? topSpacerTr.nextSibling : tbody.firstChild
    while (node && node !== bottomSpacerTr) {
      const next = node.nextSibling
      if (isDomEl(node) && node.dataset?.rowIdx !== undefined) {
        const ri = Number(node.dataset.rowIdx)
        if (ri < start || ri >= end) {
          onBeforeDetachRow?.(node)
          selectionController?.detachRow(node)
          node.remove()
        }
      }
      node = next
    }
    if (start < prevStart) {
      const topFrag = document.createDocumentFragment()
      const upper = Math.min(prevStart, end)
      for (let r = start; r < upper; r++) {
        topFrag.appendChild(createRow(r))
      }
      const insertRef = topSpacerTr ? topSpacerTr.nextSibling : tbody.firstChild
      tbody.insertBefore(topFrag, insertRef)
    }
    if (end > prevEnd) {
      const botFrag = document.createDocumentFragment()
      const lower = Math.max(prevEnd, start)
      for (let r = lower; r < end; r++) {
        botFrag.appendChild(createRow(r))
      }
      tbody.insertBefore(botFrag, bottomSpacerTr)
    }
  }

  virt.start = start
  virt.end = end
  if (force) {
    selectionController?.applyDomClasses()
  }
  return true
}

const PANEL_PICKER_CLASSES = {
  overlay: 'modal-backdrop panel-fp-backdrop',
  modal: 'modal-card panel-fp-card',
  head: 'panel-fp-head',
  title: 'panel-fp-title',
  roots: 'panel-fp-roots',
  root: 'panel-fp-root',
  nav: 'panel-fp-nav',
  upBtn: 'btn btn-sm panel-fp-up',
  pathInput: 'input panel-fp-path',
  filterInput: 'input',
  list: 'panel-fp-list',
  row: 'panel-fp-row',
  icon: 'panel-fp-icon',
  name: 'panel-fp-name',
  meta: 'panel-fp-meta',
  empty: 'panel-fp-empty',
  status: 'panel-fp-status',
  foot: 'panel-fp-foot',
  selected: 'panel-fp-selected',
  actions: 'panel-fp-actions',
  btnSm: 'btn btn-sm',
  btnPrimarySm: 'btn btn-primary btn-sm',
}

export function openPanelFilePickerModal(options) {
  return openSharedFilePickerModal({
    title: options?.title,
    mode: options?.mode,
    initialDir: options?.initialDir,
    extensions: options?.extensions,
    maxRoots: 8,
    classes: PANEL_PICKER_CLASSES,
    listDir: (input) => rpc('fs.listDir', input),
  })
}
