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
    const res = await window.orca.host.call('plugin.request', params)
    return res?.output
  }
  throw new Error('Orca IPC bridge is unavailable')
}

export function syncThemeFromTokens() {
  try {
    const probe = document.createElement('div')
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    probe.style.background = 'var(--orca-background, #000000)'
    document.body.appendChild(probe)
    const bg = getComputedStyle(probe).backgroundColor
    probe.remove()
    const m = bg.match(/[\d.]+/g)
    if (!m || (m.length > 3 && Number(m[3]) === 0)) return
    const lum = 0.2126 * srgbLin(Number(m[0])) + 0.7152 * srgbLin(Number(m[1])) + 0.0722 * srgbLin(Number(m[2]))
    const isLight = lum > 0.45
    document.documentElement.classList.toggle('light', isLight)
    document.documentElement.classList.toggle('dark', !isLight)
    document.body?.classList.toggle('light', isLight)
    document.body?.classList.toggle('dark', !isLight)
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
    if (window.orca?.host?.call) {
      const typo = await window.orca.host.call('editor.readTypography')
      applyTypographySnapshot(typo)
    }
  } catch {}
}

export function makeTableKey(connectionId, tableName, schemaName) {
  return `${connectionId || 'none'}:${schemaName || ''}:${tableName || ''}`
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

export function bindCtrlWheelHorizontalScroll(el) {
  if (!el) return
  el.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return
      const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
      if (!raw) return
      e.preventDefault()
      const step = e.deltaMode === 1 ? raw * 28 : e.deltaMode === 2 ? raw * 320 : raw * 1.25
      el.scrollLeft += step
    },
    { passive: false }
  )
}

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
    itemCheck: 'custom-select-item-check',
    folderHead: 'custom-select-folder-head',
    folderIcon: 'custom-select-folder-icon',
    folderName: 'custom-select-folder-name',
    folderCount: 'custom-select-folder-count',
    empty: 'custom-select-empty',
  },
  layout: {
    minWidth: 250,
    margin: 6,
    maxHeight: 320,
    vwFallback: 360,
    vhFallback: 640,
    gap: 8,
    rectFallback: { left: 6, top: 40, bottom: 68, width: 250, height: 28 },
  },
  syncProp: '_customDropdownSync',
  apiProp: '_customDropdownApi',
  closeOnRefresh: true,
  fallbackQuerySelected: false,
  setActionAriaLabel: false,
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

export async function writeTextToClipboard(text) {
  const val = String(text ?? '')
  let copied = false
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
      copied = Boolean(document.execCommand('copy'))
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

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(val)
      copied = true
    } catch {}
  }

  return copied
}

export function syncVirtualTableWindow({
  virt,
  total,
  start,
  end,
  rowHeightPx,
  createRow,
  selectionController,
  onBeforeDetachRow,
  force = false,
}) {
  if (!force && start === virt.start && end === virt.end) {
    return false
  }

  const { tbody, topSpacerTr, topSpacerTd, bottomSpacerTr, bottomSpacerTd } = virt
  const topPx = start * rowHeightPx
  const bottomPx = Math.max(0, (total - end) * rowHeightPx)
  if (topSpacerTr && topSpacerTd) {
    topSpacerTr.style.display = topPx > 0 ? '' : 'none'
    topSpacerTd.style.height = `${topPx}px`
  }
  if (bottomSpacerTr && bottomSpacerTd) {
    bottomSpacerTr.style.display = bottomPx > 0 ? '' : 'none'
    bottomSpacerTd.style.height = `${bottomPx}px`
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
