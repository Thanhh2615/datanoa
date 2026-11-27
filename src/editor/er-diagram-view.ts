// src/editor/er-diagram-view.ts
// Interactive ER Diagram View for Datanoa Studio (5th view mode 'er').
// Uses pure shared engines: shared-er-diagram.js, shared-er-layout.js, shared-er-exporters.js.
// Zero foreignObject SVG elements, zero eval/new Function, zero unsafe casts or non-null assertions.

import type {
  ErLayoutStateEntry,
  ErNodePosition,
  SchemaErEdge,
  SchemaErGraph,
} from '../protocol.js'
import { normalizeErGraph, type NormalizedErGraph } from '../shared-er-diagram.js'
import {
  computeErLayout,
  type ErLayoutEdge,
  type ErLayoutNode,
  type ErLayoutResult,
} from '../shared-er-layout.js'
import {
  DEFAULT_ER_DARK_PALETTE,
  DEFAULT_ER_LIGHT_PALETTE,
  exportErToGraphvizDot,
  exportErToMermaid,
  exportErToSvg,
  rasterizeErSvgToPngArrayBuffer,
  type ErThemePalette,
} from '../shared-er-exporters.js'
import {
  createSvgElement,
  downloadBinaryFile,
  downloadTextFile,
  setButtonLoading,
} from './db-icons.js'
import { copyTextToClipboardAsync } from './grid-formatters.js'

export const ER_ZOOM_LADDER: readonly number[] = [
  0.2, 0.25, 0.3, 0.4, 0.5, 0.65, 0.75, 0.9, 1.0, 1.25, 1.5, 2.0,
]
export const ER_LOD_MINIMAL_ZOOM = 0.4
export const ER_MIN_INITIAL_ZOOM = 0.75
export const ER_MAX_INITIAL_ZOOM = 1.25
export const ER_PNG_CACHE_TTL_MS = 30_000
export const ER_NUDGE_PX = 20

export interface ErDiagramViewOptions {
  container: HTMLElement
  requestPlugin: <T = unknown>(
    method: string,
    payload?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ) => Promise<T>
  onOpenTable: (schema: string, table: string) => void
  onUpdateStatus: (stateText: string, metricsText?: string) => void
}

interface CachedPngPayload {
  key: string
  filename: string
  buffer: ArrayBuffer
  createdAt: number
  renderRevision: number
  layoutRevision: number
  resetSeq: number
  loadSeq: number
}

function clampNum(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val))
}

function resolveErThemePalette(): ErThemePalette {
  const isLight =
    typeof document !== 'undefined' &&
    (document.documentElement.classList.contains('light') ||
      document.body?.classList.contains('light'))
  const base = isLight ? DEFAULT_ER_LIGHT_PALETTE : DEFAULT_ER_DARK_PALETTE
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function' || !document.body) {
    return { ...base }
  }
  try {
    const cs = getComputedStyle(document.body)
    const readVar = (name: string, fallback: string): string => {
      const v = cs.getPropertyValue(name).trim()
      return v || fallback
    }
    return {
      bg: readVar('--bg', base.bg),
      cardBg: readVar('--card', base.cardBg),
      headerBg: readVar('--surface', base.headerBg),
      stubBg: readVar('--raised', base.stubBg),
      border: readVar('--border', base.border),
      textPrimary: readVar('--text', base.textPrimary),
      textMuted: readVar('--muted', base.textMuted),
      pkColor: readVar('--warn', base.pkColor),
      fkColor: readVar('--info', base.fkColor),
      ukColor: readVar('--ok', base.ukColor),
      edgeStroke: readVar('--border-strong', base.edgeStroke),
      crossSchemaStroke: readVar('--cm-keyword', base.crossSchemaStroke),
    }
  } catch {
    return { ...base }
  }
}

export function buildErSchemaKey(connectionId: string, schema?: string): string {
  return `${connectionId}:${schema || ''}`
}

export function rebaseManualPositionsOriginClamp(
  positions: Record<string, ErNodePosition>,
  padding = 20
): { positions: Record<string, ErNodePosition>; deltaX: number; deltaY: number } {
  const entries = Object.entries(positions)
  if (entries.length === 0) {
    return { positions: {}, deltaX: 0, deltaY: 0 }
  }
  let minX = Infinity
  let minY = Infinity
  for (const [, pos] of entries) {
    if (pos.x < minX) minX = pos.x
    if (pos.y < minY) minY = pos.y
  }
  const shiftX = minX < padding ? padding - minX : 0
  const shiftY = minY < padding ? padding - minY : 0
  const next: Record<string, ErNodePosition> = {}
  for (const [id, pos] of entries) {
    next[id] = {
      x: Math.round((pos.x + shiftX) * 100) / 100,
      y: Math.round((pos.y + shiftY) * 100) / 100,
    }
  }
  return { positions: next, deltaX: shiftX, deltaY: shiftY }
}

export function computeSmartInitialZoom(
  contentWidth: number,
  contentHeight: number,
  viewportWidth: number,
  viewportHeight: number
): number {
  const safeCw = Math.max(1, contentWidth)
  const safeCh = Math.max(1, contentHeight)
  const safeVw = Math.max(200, viewportWidth - 48)
  const safeVh = Math.max(160, viewportHeight - 48)
  const fitZoom = Math.min(safeVw / safeCw, safeVh / safeCh)
  return clampNum(Math.max(fitZoom, ER_MIN_INITIAL_ZOOM), ER_MIN_INITIAL_ZOOM, ER_MAX_INITIAL_ZOOM)
}

export function nextZoomStep(currentZoom: number, direction: 1 | -1): number {
  if (direction > 0) {
    for (const step of ER_ZOOM_LADDER) {
      if (step > currentZoom + 0.01) return step
    }
    return ER_ZOOM_LADDER[ER_ZOOM_LADDER.length - 1]
  }
  for (let i = ER_ZOOM_LADDER.length - 1; i >= 0; i--) {
    const step = ER_ZOOM_LADDER[i]
    if (step < currentZoom - 0.01) return step
  }
  return ER_ZOOM_LADDER[0]
}

export class ErDiagramView {
  private readonly container: HTMLElement
  private readonly requestPlugin: ErDiagramViewOptions['requestPlugin']
  private readonly onOpenTable: ErDiagramViewOptions['onOpenTable']
  private readonly onUpdateStatus: ErDiagramViewOptions['onUpdateStatus']

  private toolbarEl: HTMLDivElement | null = null
  private searchInputEl: HTMLInputElement | null = null
  private compactToggleEl: HTMLInputElement | null = null
  private hideOrphansToggleEl: HTMLInputElement | null = null
  private collapseJunctionsToggleEl: HTMLInputElement | null = null
  private showExternalStubsToggleEl: HTMLInputElement | null = null
  private zoomSelectEl: HTMLSelectElement | null = null
  private resetBtnEl: HTMLButtonElement | null = null
  private refreshBtnEl: HTMLButtonElement | null = null
  private exportPngBtnEl: HTMLButtonElement | null = null
  private toastEl: HTMLDivElement | null = null
  private viewportEl: HTMLDivElement | null = null
  private worldEl: HTMLDivElement | null = null
  private edgesSvgEl: SVGElement | null = null
  private cardsLayerEl: HTMLDivElement | null = null
  private emptyOverlayEl: HTMLDivElement | null = null
  private metaBadgeEl: HTMLSpanElement | null = null

  private activeConnectionId: string | null = null
  private activeSchema: string | undefined = undefined
  private loadedGraphConnectionId: string | null = null
  private loadedGraphSchema: string | undefined = undefined
  private rawGraph: SchemaErGraph | null = null
  private normalizedGraph: NormalizedErGraph | null = null
  private layoutResult: ErLayoutResult | null = null
  private manualPositions: Record<string, ErNodePosition> = {}
  private compactMode = false
  private hideOrphans = false
  private collapseJunctions = false
  private showExternalStubs = true
  private searchQuery = ''
  private selectedNodeId: string | null = null
  private pendingFocusTarget: { tableName: string; schema?: string } | null = null
  private isLoadingGraph = false

  private zoom = 1
  private panX = 24
  private panY = 24
  private loadSeq = 0
  private patchTimer: ReturnType<typeof setTimeout> | null = null
  private layoutRevision = 0
  private layoutResetSeq = 0
  private renderRevision = 0
  private serverPositions: Record<string, ErNodePosition> = {}
  private dirtyPositionIds = new Set<string>()
  private dirtyToggles = {
    compactMode: false,
    hideOrphans: false,
    collapseJunctions: false,
  }
  private persistChain: Promise<void> = Promise.resolve()
  private persistChainBySchema = new Map<string, Promise<void>>()
  private cachedPng: CachedPngPayload | null = null
  private toastTimer: ReturnType<typeof setTimeout> | null = null
  private isDestroyed = false

  private cardById = new Map<string, HTMLDivElement>()
  private activeDragCleanup: (() => void) | null = null
  private disposables: Array<() => void> = []

  constructor(options: ErDiagramViewOptions) {
    this.container = options.container
    this.requestPlugin = options.requestPlugin
    this.onOpenTable = options.onOpenTable
    this.onUpdateStatus = options.onUpdateStatus
    this.buildDom()
  }

  private buildDom(): void {
    this.container.innerHTML = ''

    const toolbar = document.createElement('div')
    toolbar.className = 'datanoa-er-toolbar'

    const leftGroup = document.createElement('div')
    leftGroup.className = 'datanoa-er-toolbar-group'

    const searchInput = document.createElement('input')
    searchInput.type = 'search'
    searchInput.className = 'datanoa-filter-input datanoa-er-search'
    searchInput.placeholder = 'Jump to table...'
    searchInput.setAttribute('aria-label', 'Jump to table in ER diagram')
    searchInput.dataset.erSearch = 'true'
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value.trim().toLowerCase()
      this.applySearchHighlight(false)
    })
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.applySearchHighlight(true)
      }
    })
    leftGroup.appendChild(searchInput)
    this.searchInputEl = searchInput

    const makeToggle = (
      key: 'compactMode' | 'hideOrphans' | 'collapseJunctions' | 'showExternalStubs',
      label: string,
      title: string
    ): HTMLInputElement => {
      const wrap = document.createElement('label')
      wrap.className = 'datanoa-er-toggle-label'
      wrap.title = title
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.dataset.erToggle = key
      const span = document.createElement('span')
      span.textContent = label
      wrap.appendChild(cb)
      wrap.appendChild(span)
      leftGroup.appendChild(wrap)
      return cb
    }

    this.compactToggleEl = makeToggle(
      'compactMode',
      'Compact (PK/FK)',
      'Show only Primary Key and Foreign Key columns'
    )
    this.compactToggleEl.addEventListener('change', () => {
      this.compactMode = Boolean(this.compactToggleEl?.checked)
      this.dirtyToggles.compactMode = true
      this.recomputeAndRender(false)
      this.schedulePersistLayoutState()
    })

    this.hideOrphansToggleEl = makeToggle(
      'hideOrphans',
      'Hide Orphans',
      'Hide disconnected tables with no foreign keys'
    )
    this.hideOrphansToggleEl.addEventListener('change', () => {
      this.hideOrphans = Boolean(this.hideOrphansToggleEl?.checked)
      this.dirtyToggles.hideOrphans = true
      this.recomputeAndRender(false)
      this.schedulePersistLayoutState()
    })

    this.collapseJunctionsToggleEl = makeToggle(
      'collapseJunctions',
      'Collapse M:N',
      'Collapse pure many-to-many junction tables into direct edges'
    )
    this.collapseJunctionsToggleEl.addEventListener('change', () => {
      this.collapseJunctions = Boolean(this.collapseJunctionsToggleEl?.checked)
      this.dirtyToggles.collapseJunctions = true
      this.recomputeAndRender(false)
      this.schedulePersistLayoutState()
    })

    this.showExternalStubsToggleEl = makeToggle(
      'showExternalStubs',
      'External tables',
      'Show referenced tables outside the active schema'
    )
    this.showExternalStubsToggleEl.checked = this.showExternalStubs
    this.showExternalStubsToggleEl.addEventListener('change', () => {
      this.showExternalStubs = Boolean(this.showExternalStubsToggleEl?.checked)
      this.recomputeAndRender(false)
    })

    const metaBadge = document.createElement('span')
    metaBadge.className = 'datanoa-badge datanoa-er-meta-badge'
    metaBadge.textContent = '0 tables'
    leftGroup.appendChild(metaBadge)
    this.metaBadgeEl = metaBadge

    const rightGroup = document.createElement('div')
    rightGroup.className = 'datanoa-er-toolbar-group'

    const zoomOutBtn = document.createElement('button')
    zoomOutBtn.type = 'button'
    zoomOutBtn.className = 'datanoa-btn datanoa-btn-sm'
    zoomOutBtn.textContent = '−'
    zoomOutBtn.title = 'Zoom Out'
    zoomOutBtn.dataset.erZoom = 'out'
    zoomOutBtn.addEventListener('click', () => {
      this.setZoom(nextZoomStep(this.zoom, -1))
    })

    const zoomSel = document.createElement('select')
    zoomSel.className = 'datanoa-select datanoa-select-sm datanoa-er-zoom-select'
    zoomSel.setAttribute('aria-label', 'ER Diagram Zoom')
    for (const z of ER_ZOOM_LADDER) {
      const opt = document.createElement('option')
      opt.value = String(z)
      opt.textContent = `${Math.round(z * 100)}%`
      zoomSel.appendChild(opt)
    }
    zoomSel.addEventListener('change', () => {
      const next = Number(zoomSel.value)
      if (Number.isFinite(next) && next > 0) {
        this.setZoom(next)
      }
    })
    this.zoomSelectEl = zoomSel

    const zoomInBtn = document.createElement('button')
    zoomInBtn.type = 'button'
    zoomInBtn.className = 'datanoa-btn datanoa-btn-sm'
    zoomInBtn.textContent = '+'
    zoomInBtn.title = 'Zoom In'
    zoomInBtn.dataset.erZoom = 'in'
    zoomInBtn.addEventListener('click', () => {
      this.setZoom(nextZoomStep(this.zoom, 1))
    })

    const fitBtn = document.createElement('button')
    fitBtn.type = 'button'
    fitBtn.className = 'datanoa-btn datanoa-btn-sm'
    fitBtn.textContent = 'Fit'
    fitBtn.title = 'Fit diagram in view'
    fitBtn.dataset.erZoom = 'fit'
    fitBtn.addEventListener('click', () => {
      this.applySmartFitZoom()
    })

    const resetBtn = document.createElement('button')
    resetBtn.type = 'button'
    resetBtn.className = 'datanoa-btn datanoa-btn-sm'
    resetBtn.textContent = 'Reset Layout'
    resetBtn.dataset.erAction = 'reset'
    resetBtn.addEventListener('click', () => {
      void this.resetLayout()
    })
    this.resetBtnEl = resetBtn

    const refreshBtn = document.createElement('button')
    refreshBtn.type = 'button'
    refreshBtn.className = 'datanoa-btn datanoa-btn-sm'
    refreshBtn.textContent = 'Refresh'
    refreshBtn.dataset.erAction = 'refresh'
    refreshBtn.addEventListener('click', () => {
      if (this.activeConnectionId) {
        void this.load({
          connectionId: this.activeConnectionId,
          schema: this.activeSchema,
          forceRefresh: true,
        })
      }
    })
    this.refreshBtnEl = refreshBtn

    const addExportBtn = (
      kind: 'mmd' | 'copy-mmd' | 'gv' | 'svg' | 'png',
      label: string,
      title: string
    ): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'datanoa-btn datanoa-btn-sm'
      btn.textContent = label
      btn.title = title
      btn.dataset.erExport = kind
      btn.addEventListener('click', () => {
        void this.handleExport(kind, btn)
      })
      rightGroup.appendChild(btn)
      return btn
    }

    rightGroup.appendChild(zoomOutBtn)
    rightGroup.appendChild(zoomSel)
    rightGroup.appendChild(zoomInBtn)
    rightGroup.appendChild(fitBtn)
    rightGroup.appendChild(resetBtn)
    rightGroup.appendChild(refreshBtn)
    addExportBtn('mmd', '.mmd', 'Export Mermaid ER diagram (.mmd)')
    addExportBtn('copy-mmd', 'Copy Mermaid', 'Copy Mermaid erDiagram syntax to clipboard')
    addExportBtn('gv', '.gv', 'Export Graphviz DOT (.gv)')
    addExportBtn('svg', '.svg', 'Export standalone SVG (.svg)')
    this.exportPngBtnEl = addExportBtn('png', '.png', 'Export high-DPI PNG (.png)')

    toolbar.appendChild(leftGroup)
    toolbar.appendChild(rightGroup)
    this.toolbarEl = toolbar

    const viewport = document.createElement('div')
    viewport.className = 'datanoa-er-viewport'
    viewport.tabIndex = 0

    const world = document.createElement('div')
    world.className = 'datanoa-er-world'

    const edgesSvg = createSvgElement('svg', {
      class: 'datanoa-er-edges-svg',
      'aria-hidden': 'true',
    })
    const cardsLayer = document.createElement('div')
    cardsLayer.className = 'datanoa-er-cards-layer'

    world.appendChild(edgesSvg)
    world.appendChild(cardsLayer)
    viewport.appendChild(world)

    const emptyOverlay = document.createElement('div')
    emptyOverlay.className = 'datanoa-er-empty'
    emptyOverlay.textContent = 'Select a database connection to view its ER Diagram.'
    viewport.appendChild(emptyOverlay)

    const toast = document.createElement('div')
    toast.className = 'datanoa-er-toast'
    toast.style.display = 'none'
    viewport.appendChild(toast)

    this.viewportEl = viewport
    this.worldEl = world
    this.edgesSvgEl = edgesSvg
    this.cardsLayerEl = cardsLayer
    this.emptyOverlayEl = emptyOverlay
    this.toastEl = toast

    this.container.appendChild(toolbar)
    this.container.appendChild(viewport)

    this.bindViewportInteractions()
  }

  private bindViewportInteractions(): void {
    const viewport = this.viewportEl
    if (!viewport) return

    const onWheel = (e: WheelEvent): void => {
      if (!this.layoutResult) return
      e.preventDefault()
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        const rect = viewport.getBoundingClientRect?.()
        const anchorX = rect ? e.clientX - rect.left : (viewport.clientWidth || 800) / 2
        const anchorY = rect ? e.clientY - rect.top : (viewport.clientHeight || 500) / 2
        const dir: 1 | -1 = e.deltaY < 0 ? 1 : -1
        this.setZoom(nextZoomStep(this.zoom, dir), { x: anchorX, y: anchorY })
      } else {
        this.panX -= e.deltaX
        this.panY -= e.deltaY
        this.applyViewportTransform()
      }
    }

    const onViewportMouseDown = (e: MouseEvent): void => {
      if (e.button !== 0 && e.button !== 1) return
      const tgt = e.target
      if (tgt instanceof Element && tgt.closest('.datanoa-er-card')) return
      e.preventDefault()
      viewport.focus?.()
      const startX = e.clientX
      const startY = e.clientY
      const origPanX = this.panX
      const origPanY = this.panY
      const onMove = (me: MouseEvent): void => {
        this.panX = origPanX + (me.clientX - startX)
        this.panY = origPanY + (me.clientY - startY)
        this.applyViewportTransform()
      }
      const onUp = (): void => {
        this.cleanupActiveDrag()
      }
      this.cleanupActiveDrag()
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      window.addEventListener('blur', onUp)
      this.activeDragCleanup = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        window.removeEventListener('blur', onUp)
      }
    }

    const onViewportKeyDown = (e: KeyboardEvent): void => {
      if (!e.altKey || !this.selectedNodeId) return
      let dx = 0
      let dy = 0
      if (e.key === 'ArrowLeft') dx = -ER_NUDGE_PX
      else if (e.key === 'ArrowRight') dx = ER_NUDGE_PX
      else if (e.key === 'ArrowUp') dy = -ER_NUDGE_PX
      else if (e.key === 'ArrowDown') dy = ER_NUDGE_PX
      if (dx === 0 && dy === 0) return
      e.preventDefault()
      e.stopPropagation()
      this.nudgeSelectedCard(dx, dy)
    }

    viewport.addEventListener('wheel', onWheel, { passive: false })
    viewport.addEventListener('mousedown', onViewportMouseDown)
    viewport.addEventListener('keydown', onViewportKeyDown)
    this.disposables.push(() => {
      viewport.removeEventListener('wheel', onWheel)
      viewport.removeEventListener('mousedown', onViewportMouseDown)
      viewport.removeEventListener('keydown', onViewportKeyDown)
    })
  }

  private cleanupActiveDrag(): void {
    if (this.activeDragCleanup) {
      this.activeDragCleanup()
      this.activeDragCleanup = null
    }
  }

  private isPngPayloadCurrent(
    payload: Pick<CachedPngPayload, 'renderRevision' | 'layoutRevision' | 'resetSeq' | 'loadSeq'>
  ): boolean {
    return (
      !this.isDestroyed &&
      payload.renderRevision === this.renderRevision &&
      payload.layoutRevision === this.layoutRevision &&
      payload.resetSeq === this.layoutResetSeq &&
      payload.loadSeq === this.loadSeq
    )
  }

  private queuePersistForSchema(schemaKey: string, task: () => Promise<void>): Promise<void> {
    const run = this.persistChain.then(async () => {
      try {
        await task()
      } catch {
        // Keep persist chain alive after failed save
      } finally {
        if (this.persistChainBySchema.get(schemaKey) === run) {
          this.persistChainBySchema.delete(schemaKey)
        }
      }
    })
    this.persistChain = run
    this.persistChainBySchema.set(schemaKey, run)
    return run
  }

  public clear(): void {
    this.flushPendingLayoutSave(true)
    this.loadSeq += 1
    this.renderRevision += 1
    this.activeConnectionId = null
    this.activeSchema = undefined
    this.loadedGraphConnectionId = null
    this.loadedGraphSchema = undefined
    this.rawGraph = null
    this.normalizedGraph = null
    this.layoutResult = null
    this.manualPositions = {}
    this.serverPositions = {}
    this.layoutRevision = 0
    this.dirtyPositionIds.clear()
    this.dirtyToggles = { compactMode: false, hideOrphans: false, collapseJunctions: false }
    this.selectedNodeId = null
    this.pendingFocusTarget = null
    this.isLoadingGraph = false
    this.cachedPng = null
    if (this.toastEl) this.toastEl.style.display = 'none'
    this.cardById.clear()
    if (this.cardsLayerEl) this.cardsLayerEl.innerHTML = ''
    if (this.edgesSvgEl) this.edgesSvgEl.innerHTML = ''
    if (this.metaBadgeEl) this.metaBadgeEl.textContent = '0 tables'
    if (this.emptyOverlayEl) {
      this.emptyOverlayEl.style.display = 'flex'
      this.emptyOverlayEl.textContent = 'Select a database connection to view its ER Diagram.'
    }
  }

  public async load(opts: {
    connectionId: string
    schema?: string
    forceRefresh?: boolean
  }): Promise<void> {
    if (this.isDestroyed) return
    this.flushPendingLayoutSave(true)
    const seq = ++this.loadSeq
    this.isLoadingGraph = true
    this.renderRevision += 1
    const schemaChanged =
      this.loadedGraphConnectionId !== opts.connectionId ||
      this.loadedGraphSchema !== opts.schema ||
      this.activeConnectionId !== opts.connectionId ||
      this.activeSchema !== opts.schema
    this.activeConnectionId = opts.connectionId
    this.activeSchema = opts.schema
    this.cachedPng = null
    if (this.toastEl) this.toastEl.style.display = 'none'
    if (schemaChanged) {
      this.loadedGraphConnectionId = null
      this.loadedGraphSchema = undefined
      this.rawGraph = null
      this.normalizedGraph = null
      this.layoutResult = null
      this.selectedNodeId = null
      this.pendingFocusTarget = null
      this.cardById.clear()
      if (this.cardsLayerEl) this.cardsLayerEl.innerHTML = ''
      if (this.edgesSvgEl) this.edgesSvgEl.innerHTML = ''
      if (this.metaBadgeEl) this.metaBadgeEl.textContent = '0 tables'
    }

    if (this.emptyOverlayEl) {
      this.emptyOverlayEl.style.display = 'flex'
      this.emptyOverlayEl.textContent = 'Building ER Diagram...'
    }
    setButtonLoading(this.refreshBtnEl, true, 'Loading...')

    const schemaKey = buildErSchemaKey(opts.connectionId, opts.schema)
    const pendingPersistForSchema = this.persistChainBySchema.get(schemaKey)
    const loadLayoutState = (): Promise<{
      schemaKey: string
      entry: ErLayoutStateEntry | null
      revision: number
    }> => {
      if (this.isDestroyed || seq !== this.loadSeq) {
        return Promise.resolve({ schemaKey, entry: null, revision: 0 })
      }
      return this.requestPlugin<{ schemaKey: string; entry: ErLayoutStateEntry | null; revision: number }>(
        'ui.erLayoutState.get',
        { schemaKey }
      ).catch(() => ({ schemaKey, entry: null, revision: 0 }))
    }
    try {
      const [graph, layoutStateRes] = await Promise.all([
        this.requestPlugin<SchemaErGraph>('schema.erGraph', {
          connectionId: opts.connectionId,
          ...(opts.schema ? { schema: opts.schema } : {}),
          includeViews: true,
          ...(opts.forceRefresh ? { forceRefresh: true } : {}),
        }),
        pendingPersistForSchema ? pendingPersistForSchema.then(loadLayoutState) : loadLayoutState(),
      ])

      if (this.isDestroyed || seq !== this.loadSeq) return

      this.loadedGraphConnectionId = opts.connectionId
      this.loadedGraphSchema = opts.schema
      this.rawGraph = graph
      const savedEntry = layoutStateRes?.entry ?? null
      this.layoutRevision =
        typeof layoutStateRes?.revision === 'number'
          ? layoutStateRes.revision
          : typeof savedEntry?.revision === 'number'
            ? savedEntry.revision
            : 0
      this.serverPositions = savedEntry?.positions ? { ...savedEntry.positions } : {}
      this.manualPositions = savedEntry?.positions ? { ...savedEntry.positions } : {}
      this.dirtyPositionIds.clear()
      this.dirtyToggles = { compactMode: false, hideOrphans: false, collapseJunctions: false }
      this.compactMode = Boolean(savedEntry?.compactMode)
      this.hideOrphans = Boolean(savedEntry?.hideOrphans)
      this.collapseJunctions = Boolean(savedEntry?.collapseJunctions)

      if (this.compactToggleEl) this.compactToggleEl.checked = this.compactMode
      if (this.hideOrphansToggleEl) this.hideOrphansToggleEl.checked = this.hideOrphans
      if (this.collapseJunctionsToggleEl) {
        this.collapseJunctionsToggleEl.checked = this.collapseJunctions
      }

      this.recomputeAndRender(true)
      this.isLoadingGraph = false
      const count = this.normalizedGraph?.nodes.length ?? 0
      const truncSuffix = graph.truncated ? ` (showing ${count}/${graph.totalTableCount ?? count})` : ''
      this.onUpdateStatus(`ER Diagram ready${truncSuffix}`, this.formatGraphMetrics())
      const pendingFocus = this.pendingFocusTarget
      if (pendingFocus) {
        this.pendingFocusTarget = null
        this.focusTable(pendingFocus.tableName, pendingFocus.schema)
      }
    } catch (err: unknown) {
      if (this.isDestroyed || seq !== this.loadSeq) return
      const msg = err instanceof Error ? err.message : String(err)
      this.isLoadingGraph = false
      this.loadedGraphConnectionId = null
      this.loadedGraphSchema = undefined
      this.rawGraph = null
      this.normalizedGraph = null
      this.layoutResult = null
      this.pendingFocusTarget = null
      if (this.cardsLayerEl) this.cardsLayerEl.innerHTML = ''
      if (this.edgesSvgEl) this.edgesSvgEl.innerHTML = ''
      if (this.emptyOverlayEl) {
        this.emptyOverlayEl.style.display = 'flex'
        this.emptyOverlayEl.textContent = `Failed to load ER Diagram: ${msg}`
      }
      this.onUpdateStatus(`ER Diagram error: ${msg}`)
    } finally {
      if (!this.isDestroyed && seq === this.loadSeq) {
        this.isLoadingGraph = false
        setButtonLoading(this.refreshBtnEl, false)
      }
    }
  }

  private recomputeAndRender(resetZoom: boolean): void {
    if (!this.rawGraph) return
    const normalized = normalizeErGraph(this.rawGraph, {
      compactMode: this.compactMode,
      hideOrphans: this.hideOrphans,
      collapseJunctions: this.collapseJunctions,
      showExternalStubs: this.showExternalStubs,
    })
    this.normalizedGraph = normalized

    // Preserve new tables to the right of existing manual positions without destroying user layout
    const layout = computeErLayout(normalized, {
      compactMode: this.compactMode,
      manualPositions: this.manualPositions,
    })
    this.layoutResult = layout
    this.renderRevision += 1
    this.cachedPng = null

    if (this.metaBadgeEl) {
      this.metaBadgeEl.textContent = `${normalized.nodes.length} tables · ${normalized.edges.length} FK`
    }

    this.renderLayoutDom(layout)
    if (resetZoom) {
      this.applySmartFitZoom()
    } else {
      this.applyViewportTransform()
    }
    this.applySearchHighlight(false)
  }

  private renderLayoutDom(layout: ErLayoutResult): void {
    const cardsLayer = this.cardsLayerEl
    const edgesSvg = this.edgesSvgEl
    const worldEl = this.worldEl
    if (!cardsLayer || !edgesSvg || !worldEl) return

    cardsLayer.innerHTML = ''
    edgesSvg.innerHTML = ''
    this.cardById.clear()

    if (layout.nodes.length === 0) {
      if (this.emptyOverlayEl) {
        this.emptyOverlayEl.style.display = 'flex'
        this.emptyOverlayEl.textContent = 'No tables to display in ER Diagram.'
      }
      return
    }
    if (this.emptyOverlayEl) {
      this.emptyOverlayEl.style.display = 'none'
    }

    const worldW = Math.max(400, Math.ceil(layout.width))
    const worldH = Math.max(300, Math.ceil(layout.height))
    worldEl.style.width = `${worldW}px`
    worldEl.style.height = `${worldH}px`
    edgesSvg.setAttribute('width', String(worldW))
    edgesSvg.setAttribute('height', String(worldH))
    edgesSvg.setAttribute('viewBox', `0 0 ${worldW} ${worldH}`)

    this.renderEdgesIntoSvg(edgesSvg, layout.edges)

    const frag = document.createDocumentFragment()
    for (const ln of layout.nodes) {
      const card = this.buildCardElement(ln)
      this.cardById.set(ln.id, card)
      frag.appendChild(card)
    }
    cardsLayer.appendChild(frag)
  }

  private renderEdgesIntoSvg(svg: SVGElement, edges: readonly ErLayoutEdge[]): void {
    svg.innerHTML = ''
    for (const edgeLayout of edges) {
      const g = createSvgElement('g', {
        class: `datanoa-er-edge-group${edgeLayout.edge.crossSchema ? ' is-cross-schema' : ''}${edgeLayout.edge.isManyToMany ? ' is-m2m' : ''}`,
        'data-edge-id': edgeLayout.id,
      })
      const path = createSvgElement('path', {
        class: 'datanoa-er-edge-path',
        d: edgeLayout.pathD,
        fill: 'none',
      })
      g.appendChild(path)

      if (edgeLayout.optionalMarker) {
        const circle = createSvgElement('circle', {
          class: 'datanoa-er-edge-optional',
          cx: String(edgeLayout.optionalMarker.x),
          cy: String(edgeLayout.optionalMarker.y),
          r: String(edgeLayout.optionalMarker.r),
        })
        g.appendChild(circle)
      }
      svg.appendChild(g)
    }
  }

  private buildCardElement(ln: ErLayoutNode): HTMLDivElement {
    const card = document.createElement('div')
    card.className = `datanoa-er-card${ln.node.kind === 'external_stub' ? ' is-stub' : ''}${ln.node.kind === 'view' ? ' is-view' : ''}${this.selectedNodeId === ln.id ? ' is-selected' : ''}`
    card.tabIndex = 0
    card.dataset.nodeId = ln.id
    card.style.left = `${ln.x}px`
    card.style.top = `${ln.y}px`
    card.style.width = `${ln.width}px`
    card.style.height = `${ln.height}px`

    const head = document.createElement('div')
    head.className = 'datanoa-er-card-header'
    head.style.height = `${ln.headerHeight}px`

    const titleSpan = document.createElement('span')
    titleSpan.className = 'datanoa-er-card-title'
    titleSpan.textContent =
      ln.node.schema && ln.node.schema !== 'public' && ln.node.schema !== 'main'
        ? `${ln.node.schema}.${ln.node.name}`
        : ln.node.name
    titleSpan.title = `${ln.node.schema ? `${ln.node.schema}.` : ''}${ln.node.name}`
    head.appendChild(titleSpan)

    if (ln.node.kind === 'view' || ln.node.kind === 'external_stub') {
      const kindBadge = document.createElement('span')
      kindBadge.className = 'datanoa-badge datanoa-er-kind-badge'
      kindBadge.textContent = ln.node.kind === 'view' ? 'VIEW' : 'EXT'
      head.appendChild(kindBadge)
    }

    card.appendChild(head)

    const colsWrap = document.createElement('div')
    colsWrap.className = 'datanoa-er-card-cols'
    for (const col of ln.visibleColumns) {
      const row = document.createElement('div')
      row.className = 'datanoa-er-col-row'
      row.style.height = `${ln.rowHeight}px`

      const left = document.createElement('span')
      left.className = 'datanoa-er-col-name'
      if (col.isPrimaryKey) {
        const b = document.createElement('span')
        b.className = 'datanoa-er-key-tag is-pk'
        b.textContent = 'PK'
        left.appendChild(b)
      } else if (col.isForeignKey) {
        const b = document.createElement('span')
        b.className = 'datanoa-er-key-tag is-fk'
        b.textContent = 'FK'
        left.appendChild(b)
      } else if (col.isUnique) {
        const b = document.createElement('span')
        b.className = 'datanoa-er-key-tag is-uk'
        b.textContent = 'UK'
        left.appendChild(b)
      }
      const colNameSpan = document.createElement('span')
      colNameSpan.textContent = col.name
      left.appendChild(colNameSpan)

      const right = document.createElement('span')
      right.className = 'datanoa-er-col-type'
      right.textContent = col.type || ''

      row.appendChild(left)
      row.appendChild(right)
      colsWrap.appendChild(row)
    }
    card.appendChild(colsWrap)

    card.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      e.stopPropagation()
      this.selectCard(ln.id)
      this.startCardDrag(ln.id, e.clientX, e.clientY)
    })

    card.addEventListener('keydown', (e) => {
      if (!e.altKey) return
      let dx = 0
      let dy = 0
      if (e.key === 'ArrowLeft') dx = -ER_NUDGE_PX
      else if (e.key === 'ArrowRight') dx = ER_NUDGE_PX
      else if (e.key === 'ArrowUp') dy = -ER_NUDGE_PX
      else if (e.key === 'ArrowDown') dy = ER_NUDGE_PX
      if (dx === 0 && dy === 0) return
      e.preventDefault()
      e.stopPropagation()
      this.selectCard(ln.id)
      this.nudgeSelectedCard(dx, dy)
    })

    card.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      if (ln.node.kind === 'external_stub') return
      this.onOpenTable(ln.node.schema, ln.node.name)
    })

    return card
  }

  private selectCard(nodeId: string): void {
    if (this.selectedNodeId && this.selectedNodeId !== nodeId) {
      this.cardById.get(this.selectedNodeId)?.classList.remove('is-selected')
    }
    this.selectedNodeId = nodeId
    const el = this.cardById.get(nodeId)
    if (el) {
      el.classList.add('is-selected')
      el.focus?.({ preventScroll: true })
    }
  }

  private startCardDrag(nodeId: string, startClientX: number, startClientY: number): void {
    const layout = this.layoutResult
    const node = layout?.nodes.find((n) => n.id === nodeId)
    if (!node || !layout) return

    const origX = node.x
    const origY = node.y
    let didMove = false

    const applyMove = (clientX: number, clientY: number): void => {
      const dx = (clientX - startClientX) / this.zoom
      const dy = (clientY - startClientY) / this.zoom
      if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
        didMove = true
      }
      this.moveNodePosition(nodeId, origX + dx, origY + dy)
    }

    const onMove = (me: MouseEvent): void => {
      applyMove(me.clientX, me.clientY)
    }

    const onUp = (): void => {
      this.cleanupActiveDrag()
      if (didMove) {
        this.schedulePersistLayoutState()
      }
    }

    this.cleanupActiveDrag()
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('blur', onUp)
    this.activeDragCleanup = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onUp)
    }
  }

  private nudgeSelectedCard(dx: number, dy: number): void {
    if (!this.selectedNodeId || !this.layoutResult) return
    const node = this.layoutResult.nodes.find((n) => n.id === this.selectedNodeId)
    if (!node) return
    this.moveNodePosition(node.id, node.x + dx, node.y + dy)
    this.schedulePersistLayoutState()
  }

  private moveNodePosition(nodeId: string, nextX: number, nextY: number): void {
    if (!this.layoutResult || !this.normalizedGraph) return
    const prevManual: Record<string, ErNodePosition> = {}
    for (const [id, pos] of Object.entries(this.manualPositions)) {
      prevManual[id] = { x: pos.x, y: pos.y }
    }
    for (const n of this.layoutResult.nodes) {
      if (!this.manualPositions[n.id]) {
        this.manualPositions[n.id] = { x: n.x, y: n.y }
      }
    }
    this.manualPositions[nodeId] = { x: nextX, y: nextY }

    const rebased = rebaseManualPositionsOriginClamp(this.manualPositions, 20)
    this.manualPositions = rebased.positions
    this.dirtyPositionIds.add(nodeId)
    if (rebased.deltaX !== 0 || rebased.deltaY !== 0) {
      for (const [id, pos] of Object.entries(this.manualPositions)) {
        const prev = prevManual[id]
        if (id === nodeId || (prev && (prev.x !== pos.x || prev.y !== pos.y))) {
          this.dirtyPositionIds.add(id)
        }
      }
      this.panX -= rebased.deltaX * this.zoom
      this.panY -= rebased.deltaY * this.zoom
    } else if (this.manualPositions[nodeId]) {
      this.dirtyPositionIds.add(nodeId)
    }

    // Recompute local edge routing cleanly with updated manual positions
    const updatedLayout = computeErLayout(this.normalizedGraph, {
      compactMode: this.compactMode,
      manualPositions: this.manualPositions,
    })
    this.layoutResult = updatedLayout
    this.renderRevision += 1
    this.cachedPng = null

    for (const ln of updatedLayout.nodes) {
      const card = this.cardById.get(ln.id)
      if (card) {
        card.style.left = `${ln.x}px`
        card.style.top = `${ln.y}px`
      }
    }
    if (this.edgesSvgEl) {
      this.edgesSvgEl.setAttribute('width', String(Math.max(400, Math.ceil(updatedLayout.width))))
      this.edgesSvgEl.setAttribute('height', String(Math.max(300, Math.ceil(updatedLayout.height))))
      this.edgesSvgEl.setAttribute(
        'viewBox',
        `0 0 ${Math.max(400, Math.ceil(updatedLayout.width))} ${Math.max(300, Math.ceil(updatedLayout.height))}`
      )
      this.renderEdgesIntoSvg(this.edgesSvgEl, updatedLayout.edges)
    }
    if (this.worldEl) {
      this.worldEl.style.width = `${Math.max(400, Math.ceil(updatedLayout.width))}px`
      this.worldEl.style.height = `${Math.max(300, Math.ceil(updatedLayout.height))}px`
    }
    this.applyViewportTransform()
  }

  private schedulePersistLayoutState(): void {
    if (!this.activeConnectionId || this.isDestroyed) return
    if (this.patchTimer !== null) {
      clearTimeout(this.patchTimer)
    }
    this.patchTimer = setTimeout(() => {
      this.patchTimer = null
      if (this.isDestroyed) return
      this.flushPendingLayoutSave(false)
    }, 120)
  }

  public flushPendingLayoutSave(syncImmediate = false): void {
    if (this.patchTimer !== null) {
      clearTimeout(this.patchTimer)
      this.patchTimer = null
    }
    if (!this.activeConnectionId) return

    const deltaPositions: Record<string, ErNodePosition> = {}
    for (const nodeId of this.dirtyPositionIds) {
      const pos = this.manualPositions[nodeId]
      if (pos) {
        deltaPositions[nodeId] = { x: pos.x, y: pos.y }
      }
    }
    const hasDeltaPositions = Object.keys(deltaPositions).length > 0
    const togglesDirty =
      this.dirtyToggles.compactMode ||
      this.dirtyToggles.hideOrphans ||
      this.dirtyToggles.collapseJunctions
    if (!hasDeltaPositions && !togglesDirty) return

    const schemaKey = buildErSchemaKey(this.activeConnectionId, this.activeSchema)
    const toggleSnap = {
      compactMode: this.compactMode,
      hideOrphans: this.hideOrphans,
      collapseJunctions: this.collapseJunctions,
      compactDirty: this.dirtyToggles.compactMode,
      orphansDirty: this.dirtyToggles.hideOrphans,
      junctionsDirty: this.dirtyToggles.collapseJunctions,
    }
    const baseRevision = this.layoutRevision
    const targetResetSeq = this.layoutResetSeq
    this.dirtyPositionIds.clear()
    this.dirtyToggles = { compactMode: false, hideOrphans: false, collapseJunctions: false }

    const buildPatchPayload = (basePositions: Record<string, ErNodePosition>) => {
      const patch: Partial<Omit<ErLayoutStateEntry, 'updatedAt' | 'revision'>> = {}
      if (hasDeltaPositions) {
        patch.positions = { ...basePositions, ...deltaPositions }
      }
      if (toggleSnap.compactDirty) patch.compactMode = toggleSnap.compactMode
      if (toggleSnap.orphansDirty) patch.hideOrphans = toggleSnap.hideOrphans
      if (toggleSnap.junctionsDirty) patch.collapseJunctions = toggleSnap.collapseJunctions
      return patch
    }

    if (syncImmediate) {
      // Chain syncImmediate into persistChain and send ONLY dirty deltaPositions so in-flight get/patch/reset never races or overwrites
      const immediatePatch = buildPatchPayload({})
      void this.queuePersistForSchema(schemaKey, async () => {
        if (targetResetSeq !== this.layoutResetSeq) return
        const res = await this.requestPlugin<{
          ok: boolean
          schemaKey: string
          entry: ErLayoutStateEntry | null
          revision: number
        }>('ui.erLayoutState.patch', {
          schemaKey,
          patch: immediatePatch,
        }).catch(() => null)
        if (this.isDestroyed || targetResetSeq !== this.layoutResetSeq) return
        if (
          res &&
          this.activeConnectionId &&
          buildErSchemaKey(this.activeConnectionId, this.activeSchema) === schemaKey &&
          typeof res.revision === 'number'
        ) {
          this.layoutRevision = res.revision
          if (res.entry?.positions) {
            this.serverPositions = { ...res.entry.positions }
          }
        }
      })
      return
    }

    void this.queuePersistForSchema(schemaKey, async () => {
      if (this.isDestroyed || targetResetSeq !== this.layoutResetSeq) return
      let mergedBase = { ...this.serverPositions }
      let effectiveBaseRev = baseRevision
      try {
        const latest = await this.requestPlugin<{
          schemaKey: string
          entry: ErLayoutStateEntry | null
          revision: number
        }>('ui.erLayoutState.get', { schemaKey })
        if (this.isDestroyed || targetResetSeq !== this.layoutResetSeq) return
        if (latest && typeof latest.revision === 'number') {
          if (latest.revision > effectiveBaseRev) {
            effectiveBaseRev = latest.revision
            mergedBase = latest.entry?.positions ? { ...latest.entry.positions } : {}
            if (
              !this.isDestroyed &&
              targetResetSeq === this.layoutResetSeq &&
              this.activeConnectionId &&
              buildErSchemaKey(this.activeConnectionId, this.activeSchema) === schemaKey
            ) {
              for (const [remoteId, remotePos] of Object.entries(mergedBase)) {
                if (!(remoteId in deltaPositions) && !this.dirtyPositionIds.has(remoteId)) {
                  this.manualPositions[remoteId] = { x: remotePos.x, y: remotePos.y }
                }
              }
            }
          }
        }
      } catch {
        // Fall back to last known serverPositions if pre-read fails
      }

      if (this.isDestroyed || targetResetSeq !== this.layoutResetSeq) return
      const patchPayload = buildPatchPayload(mergedBase)
      const res = await this.requestPlugin<{
        ok: boolean
        schemaKey: string
        entry: ErLayoutStateEntry | null
        revision: number
      }>('ui.erLayoutState.patch', {
        schemaKey,
        patch: patchPayload,
      }).catch(() => null)

      if (
        !this.isDestroyed &&
        targetResetSeq === this.layoutResetSeq &&
        this.activeConnectionId &&
        buildErSchemaKey(this.activeConnectionId, this.activeSchema) === schemaKey
      ) {
        if (res && typeof res.revision === 'number') {
          this.layoutRevision = res.revision
          this.serverPositions = res.entry?.positions
            ? { ...res.entry.positions }
            : patchPayload.positions
              ? { ...patchPayload.positions }
              : mergedBase
        } else if (patchPayload.positions) {
          this.serverPositions = { ...patchPayload.positions }
        }
      }
    })
  }

  private async resetLayout(): Promise<void> {
    if (this.patchTimer !== null) {
      clearTimeout(this.patchTimer)
      this.patchTimer = null
    }
    const targetResetSeq = ++this.layoutResetSeq
    this.manualPositions = {}
    this.serverPositions = {}
    this.layoutRevision = 0
    this.dirtyPositionIds.clear()
    this.dirtyToggles = { compactMode: false, hideOrphans: false, collapseJunctions: false }
    this.compactMode = false
    this.hideOrphans = false
    this.collapseJunctions = false
    this.showExternalStubs = true
    if (this.compactToggleEl) this.compactToggleEl.checked = false
    if (this.hideOrphansToggleEl) this.hideOrphansToggleEl.checked = false
    if (this.collapseJunctionsToggleEl) this.collapseJunctionsToggleEl.checked = false
    if (this.showExternalStubsToggleEl) this.showExternalStubsToggleEl.checked = true
    this.recomputeAndRender(true)
    this.onUpdateStatus('ER Diagram layout reset')
    if (this.activeConnectionId) {
      const schemaKey = buildErSchemaKey(this.activeConnectionId, this.activeSchema)
      await this.queuePersistForSchema(schemaKey, async () => {
        if (this.isDestroyed || targetResetSeq !== this.layoutResetSeq) return
        await this.requestPlugin('ui.erLayoutState.reset', { schemaKey }).catch(() => {})
      })
    }
  }

  public setZoom(nextZoom: number, anchor?: { x: number; y: number }): void {
    const minZ = ER_ZOOM_LADDER[0]
    const maxZ = ER_ZOOM_LADDER[ER_ZOOM_LADDER.length - 1]
    const clamped = clampNum(Math.round(nextZoom * 100) / 100, minZ, maxZ)
    const prevZoom = this.zoom
    if (anchor && prevZoom > 0) {
      const worldX = (anchor.x - this.panX) / prevZoom
      const worldY = (anchor.y - this.panY) / prevZoom
      this.panX = anchor.x - worldX * clamped
      this.panY = anchor.y - worldY * clamped
    }
    this.zoom = clamped
    this.applyViewportTransform()
  }

  private applySmartFitZoom(): void {
    if (!this.layoutResult || !this.viewportEl) return
    const vw = this.viewportEl.clientWidth || 900
    const vh = this.viewportEl.clientHeight || 560
    const smartZoom = computeSmartInitialZoom(this.layoutResult.width, this.layoutResult.height, vw, vh)
    this.zoom = Math.round(smartZoom * 100) / 100
    this.panX = 24
    this.panY = 24
    this.applyViewportTransform()
  }

  private applyViewportTransform(): void {
    const worldEl = this.worldEl
    const viewportEl = this.viewportEl
    if (worldEl) {
      worldEl.style.transform = `translate3d(${Math.round(this.panX)}px, ${Math.round(this.panY)}px, 0) scale(${this.zoom})`
    }
    const isMinimalLod = this.zoom < ER_LOD_MINIMAL_ZOOM
    viewportEl?.classList.toggle('is-lod-minimal', isMinimalLod)
    worldEl?.classList.toggle('is-lod-minimal', isMinimalLod)
    if (this.zoomSelectEl) {
      let closest = ER_ZOOM_LADDER[0]
      let bestDist = Infinity
      for (const z of ER_ZOOM_LADDER) {
        const d = Math.abs(z - this.zoom)
        if (d < bestDist) {
          bestDist = d
          closest = z
        }
      }
      this.zoomSelectEl.value = String(closest)
    }
  }

  private formatGraphMetrics(): string {
    const count = this.normalizedGraph?.nodes.length ?? 0
    const edgeCount = this.normalizedGraph?.edges.length ?? 0
    return `${count} tables · ${edgeCount} relations`
  }

  private nodeMatchesSchema(node: { schema: string }, targetSchema: string): boolean {
    return !targetSchema || (node.schema || '').toLowerCase() === targetSchema
  }

  private findLayoutNode(tableName: string, schema?: string): ErLayoutNode | null {
    const nodes = this.layoutResult?.nodes
    if (!nodes || nodes.length === 0) return null
    const targetName = tableName.trim()
    if (!targetName) return null
    const targetLower = targetName.toLowerCase()
    const targetSchema = (schema ?? '').trim().toLowerCase()
    const schemaFiltered = nodes.filter(
      (n) => this.cardById.has(n.id) && this.nodeMatchesSchema(n.node, targetSchema)
    )
    const nonStubs = schemaFiltered.filter((n) => n.node.kind !== 'external_stub')

    return (
      nonStubs.find((n) => n.node.name === targetName) ??
      nonStubs.find((n) => n.node.name.toLowerCase() === targetLower) ??
      schemaFiltered.find((n) => n.node.name === targetName) ??
      schemaFiltered.find((n) => n.node.name.toLowerCase() === targetLower) ??
      null
    )
  }

  private centerOnNode(node: ErLayoutNode): boolean {
    this.selectCard(node.id)
    if (!this.viewportEl) return false
    const vw = this.viewportEl.clientWidth || 900
    const vh = this.viewportEl.clientHeight || 560
    this.panX = Math.round(vw / 2 - (node.x + node.width / 2) * this.zoom)
    this.panY = Math.round(vh / 2 - (node.y + node.height / 2) * this.zoom)
    this.applyViewportTransform()
    return true
  }

  /** Selects and centers the matching card in the ER Diagram viewport. */
  public focusTable(tableName: string, schema?: string): boolean {
    if (this.isDestroyed) return false
    const trimmed = tableName.trim()
    if (!trimmed) return false
    this.pendingFocusTarget = this.isLoadingGraph ? { tableName: trimmed, schema } : null
    if (!this.rawGraph || !this.layoutResult) {
      if (this.activeConnectionId !== null) {
        this.pendingFocusTarget = { tableName: trimmed, schema }
      }
      return false
    }
    const node = this.findLayoutNode(trimmed, schema)
    if (!node) {
      const lower = trimmed.toLowerCase()
      const normSchema = (schema ?? '').trim().toLowerCase()
      const hiddenByFilter = this.rawGraph.nodes.some(
        (n) => n.name.toLowerCase() === lower && this.nodeMatchesSchema(n, normSchema)
      )
      this.onUpdateStatus(
        hiddenByFilter
          ? `Table "${trimmed}" is hidden by ER filter`
          : `Table "${trimmed}" not in ER Diagram`
      )
      return false
    }
    const centered = this.centerOnNode(node)
    this.onUpdateStatus(`Focused ${node.node.name}`, this.formatGraphMetrics())
    return centered
  }

  private applySearchHighlight(jumpToMatch: boolean): void {
    const q = this.searchQuery
    let firstMatchNode: ErLayoutNode | null = null
    for (const [id, card] of this.cardById.entries()) {
      const node = this.layoutResult?.nodes.find((n) => n.id === id)
      const label = `${node?.node.schema || ''}.${node?.node.name || ''}`.toLowerCase()
      const matches = Boolean(q && label.includes(q))
      card.classList.toggle('is-search-match', matches)
      card.classList.toggle('is-search-dimmed', Boolean(q) && !matches)
      if (matches && !firstMatchNode && node) {
        firstMatchNode = node
      }
    }
    if (jumpToMatch && firstMatchNode) {
      this.centerOnNode(firstMatchNode)
    }
  }

  private showPngRetryToast(payload: CachedPngPayload): void {
    const toast = this.toastEl
    if (!toast) return
    if (this.toastTimer !== null) {
      clearTimeout(this.toastTimer)
      this.toastTimer = null
    }
    toast.innerHTML = ''
    const msg = document.createElement('span')
    msg.textContent = 'PNG rendered — click Save PNG to download.'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-primary'
    btn.textContent = 'Save PNG'
    btn.dataset.erAction = 'save-cached-png'
    btn.addEventListener('click', () => {
      if (
        Date.now() - payload.createdAt <= ER_PNG_CACHE_TTL_MS &&
        payload.renderRevision === this.renderRevision &&
        payload.layoutRevision === this.layoutRevision &&
        payload.resetSeq === this.layoutResetSeq &&
        payload.loadSeq === this.loadSeq
      ) {
        void downloadBinaryFile(payload.buffer, payload.filename, 'image/png').then((res) => {
          if (!this.isPngPayloadCurrent(payload)) return
          if (res === 'saved') {
            this.onUpdateStatus(`Exported ${payload.filename}`)
            toast.style.display = 'none'
          }
        })
      } else {
        toast.style.display = 'none'
      }
    })
    toast.appendChild(msg)
    toast.appendChild(btn)
    toast.style.display = 'flex'
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null
      if (this.toastEl) this.toastEl.style.display = 'none'
    }, ER_PNG_CACHE_TTL_MS)
  }

  private async handleExport(
    kind: 'mmd' | 'copy-mmd' | 'gv' | 'svg' | 'png',
    triggerBtn: HTMLButtonElement
  ): Promise<void> {
    if (
      !this.normalizedGraph ||
      !this.layoutResult ||
      this.loadedGraphConnectionId !== this.activeConnectionId ||
      this.loadedGraphSchema !== this.activeSchema
    ) {
      this.onUpdateStatus('No ER Diagram loaded to export')
      return
    }
    const baseName = `${(this.loadedGraphSchema || 'schema').replace(/[^A-Za-z0-9_-]/g, '_')}-er-diagram`

    if (kind === 'copy-mmd') {
      const mmd = exportErToMermaid(this.normalizedGraph)
      const copied = await copyTextToClipboardAsync(mmd)
      if (copied) {
        const extBtn = triggerBtn as HTMLButtonElement & {
          _copyResetTimer?: ReturnType<typeof setTimeout>
        }
        if (extBtn._copyResetTimer !== undefined) {
          clearTimeout(extBtn._copyResetTimer)
        }
        const orig = triggerBtn.dataset.origLabel || triggerBtn.textContent || 'Copy'
        triggerBtn.dataset.origLabel = orig
        triggerBtn.textContent = 'Copied'
        extBtn._copyResetTimer = setTimeout(() => {
          extBtn._copyResetTimer = undefined
          if (!this.isDestroyed) {
            triggerBtn.textContent = orig
          }
        }, 1200)
        this.onUpdateStatus('Copied Mermaid ER diagram to clipboard')
      } else {
        this.onUpdateStatus('Failed to copy Mermaid ER diagram to clipboard')
      }
      return
    }
    if (kind === 'mmd') {
      const mmd = exportErToMermaid(this.normalizedGraph)
      const res = await downloadTextFile(mmd, `${baseName}.mmd`, 'text/plain;charset=utf-8')
      if (res === 'saved') this.onUpdateStatus(`Exported ${baseName}.mmd`)
      return
    }
    if (kind === 'gv') {
      const gv = exportErToGraphvizDot(this.normalizedGraph)
      const res = await downloadTextFile(gv, `${baseName}.gv`, 'text/vnd.graphviz;charset=utf-8')
      if (res === 'saved') this.onUpdateStatus(`Exported ${baseName}.gv`)
      return
    }
    const buildExportSvgPayload = (): { svg: string; width: number; height: number } => {
      const graph = this.normalizedGraph as NormalizedErGraph
      const baseLayout = this.layoutResult as ErLayoutResult
      const fullLayout = this.compactMode
        ? computeErLayout(graph, {
            compactMode: false,
            manualPositions: this.manualPositions,
          })
        : baseLayout
      const svg = exportErToSvg(graph, fullLayout, {
        palette: resolveErThemePalette(),
      })
      const vbMatch = /viewBox="[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)"/i.exec(svg)
      const vbWidth = vbMatch ? Number(vbMatch[1]) : fullLayout.width
      const vbHeight = vbMatch ? Number(vbMatch[2]) : fullLayout.height
      return {
        svg,
        width: Number.isFinite(vbWidth) && vbWidth > 0 ? vbWidth : fullLayout.width,
        height: Number.isFinite(vbHeight) && vbHeight > 0 ? vbHeight : fullLayout.height,
      }
    }
    if (kind === 'svg') {
      const { svg } = buildExportSvgPayload()
      const res = await downloadTextFile(svg, `${baseName}.svg`, 'image/svg+xml;charset=utf-8')
      if (res === 'saved') this.onUpdateStatus(`Exported ${baseName}.svg`)
      return
    }

    // PNG export with 30s cached ArrayBuffer gesture-retry toast (M3)
    const cacheKey = `${buildErSchemaKey(this.activeConnectionId || '', this.activeSchema)}:${this.compactMode}:${this.hideOrphans}:${this.collapseJunctions}:${this.showExternalStubs}`
    if (
      this.cachedPng &&
      this.cachedPng.key === cacheKey &&
      this.cachedPng.renderRevision === this.renderRevision &&
      this.cachedPng.layoutRevision === this.layoutRevision &&
      this.cachedPng.resetSeq === this.layoutResetSeq &&
      this.cachedPng.loadSeq === this.loadSeq &&
      Date.now() - this.cachedPng.createdAt <= ER_PNG_CACHE_TTL_MS
    ) {
      const cached = this.cachedPng
      const cachedRes = await downloadBinaryFile(cached.buffer, cached.filename, 'image/png')
      if (!this.isPngPayloadCurrent(cached)) return
      if (cachedRes === 'saved') {
        this.onUpdateStatus(`Exported ${cached.filename}`)
      } else if (cachedRes === 'failed') {
        this.showPngRetryToast(cached)
      }
      return
    }

    const rasterRevision = this.renderRevision
    const rasterLayoutRevision = this.layoutRevision
    const rasterResetSeq = this.layoutResetSeq
    const rasterLoadSeq = this.loadSeq
    const { svg, width: exportWidth, height: exportHeight } = buildExportSvgPayload()
    setButtonLoading(this.exportPngBtnEl, true, 'PNG...')
    try {
      const buffer = await rasterizeErSvgToPngArrayBuffer(
        svg,
        exportWidth,
        exportHeight
      )
      if (
        this.isDestroyed ||
        rasterRevision !== this.renderRevision ||
        rasterLayoutRevision !== this.layoutRevision ||
        rasterResetSeq !== this.layoutResetSeq ||
        rasterLoadSeq !== this.loadSeq
      ) {
        return
      }
      const payload: CachedPngPayload = {
        key: cacheKey,
        filename: `${baseName}.png`,
        buffer,
        createdAt: Date.now(),
        renderRevision: rasterRevision,
        layoutRevision: rasterLayoutRevision,
        resetSeq: rasterResetSeq,
        loadSeq: rasterLoadSeq,
      }
      this.cachedPng = payload
      const res = await downloadBinaryFile(buffer, payload.filename, 'image/png')
      if (!this.isPngPayloadCurrent(payload)) return
      if (res === 'saved') {
        this.onUpdateStatus(`Exported ${payload.filename}`)
      } else if (res === 'failed') {
        this.showPngRetryToast(payload)
      }
    } catch (err: unknown) {
      if (
        this.isDestroyed ||
        rasterRevision !== this.renderRevision ||
        rasterLayoutRevision !== this.layoutRevision ||
        rasterResetSeq !== this.layoutResetSeq ||
        rasterLoadSeq !== this.loadSeq
      ) {
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      this.onUpdateStatus(`PNG export failed: ${msg}`)
    } finally {
      setButtonLoading(this.exportPngBtnEl, false)
    }
  }

  public getZoom(): number {
    return this.zoom
  }

  public destroy(): void {
    this.flushPendingLayoutSave(true)
    this.isDestroyed = true
    this.loadSeq += 1
    this.renderRevision += 1
    this.cleanupActiveDrag()
    if (this.patchTimer !== null) {
      clearTimeout(this.patchTimer)
      this.patchTimer = null
    }
    if (this.toastTimer !== null) {
      clearTimeout(this.toastTimer)
      this.toastTimer = null
    }
    for (const dispose of this.disposables) {
      dispose()
    }
    this.disposables = []
    this.cardById.clear()
    this.pendingFocusTarget = null
    this.isLoadingGraph = false
    this.cachedPng = null
  }
}
