// src/editor/grid.ts
// Virtualized Data Grid: Spreadsheet Multi-Selection, Bulk Ops, Pinned/Hidden Columns,
// Find & Highlight, FK Jump, Staged Batch Edits, Transpose Mode, Context Menus & Extractor

import type {
  TableBrowseResult,
  QueryResult,
  ColumnInfo,
  ForeignKeyInfo,
  DatabaseDriverType,
} from '../protocol.js'
import {
  formatDataExport,
  formatSqlInList,
  formatCellMatrixExport,
  buildQuickFilterPredicate,
  formatSqlLiteral,
  type ExportFormat,
} from '../drivers/common/sql-tools.js'
import {
  GridSelectionModel,
  parseDelimitedClipboard,
  type CellCoord,
  type SelectionSummary,
} from './grid-selection.js'
import {
  ROW_HEIGHT_PX,
  coerceCellInputValue,
  formatGridModel,
  formatCellValue,
  calculateVisibleWindow,
  checkCellEditGate,
  copyTextToClipboard,
  getCellValue,
  setCellValue,
  cloneRowData,
  cloneRowData as cloneRow,
  isNativeDomElement,
  rowToPlainRecord,
  stringifyFilterValue,
  previewMenuValue,
  parseOptionalInt,
  type FormattedCell,
  type CellEditGate,
  type GridModel,
} from './grid-formatters.js'

export {
  ROW_HEIGHT_PX,
  coerceCellInputValue,
  formatGridModel,
  formatCellValue,
  calculateVisibleWindow,
  checkCellEditGate,
  copyTextToClipboard,
  getCellValue,
  setCellValue,
  cloneRowData,
  isNativeDomElement,
  type FormattedCell,
  type CellEditGate,
  type GridModel,
}

export type CellStatus = 'idle' | 'saving' | 'clean' | 'error'

export type SelectionExportFormat =
  | 'tsv'
  | 'tsv-headers'
  | 'csv'
  | 'json'
  | 'sql-in'
  | 'sql-insert'

export interface StagedRowUpdate {
  primaryKeys: Record<string, unknown>
  changes: Record<string, unknown>
  originalRow?: Record<string, unknown>
}

export interface GridChangesPayload {
  inserts: Record<string, unknown>[]
  updates: StagedRowUpdate[]
  deletes: Record<string, unknown>[]
}

export interface SelectedCellInfo {
  rowIndex: number
  colIndex: number
  columnName: string
  value: unknown
  columnType?: string
  isEditable: boolean
  isInserted: boolean
  isDeleted: boolean
  isNullable?: boolean
  isPrimaryKey?: boolean
  isGenerated?: boolean
}

interface InternalRowState {
  kind: 'existing' | 'inserted'
  origin?: 'blank' | 'clone' | 'paste'
  deleted: boolean
  original: Record<string, unknown> | unknown[]
  dirtyCols: Map<string, unknown>
}

interface ClientColumnFilter {
  column: string
  value: unknown
  op: 'eq' | 'neq' | 'is-null' | 'is-not-null'
}

interface DragSelectionState {
  mode: 'cell' | 'row'
  lastClientX: number
  lastClientY: number
  lastRow: number | null
  lastCol: number | null
  autoScrollRafId: number | null
  summaryRafId: number | null
  summaryDirty: boolean
  moveListener: (e: MouseEvent) => void
  upListener: () => void
  blurListener: () => void
}

interface PooledGridRow {
  tr: HTMLTableRowElement
  rowNumTd: HTMLTableCellElement
  dataCells: HTMLTableCellElement[]
}

interface RenderedWindowSnapshot {
  boundedStart: number
  boundedEnd: number
  dataVersion: number
  filterVersion: number
  colLayoutVersion: number
  totalRows: number
  colSpan: number
}

function isEditableInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable === true
}

function findClosestTableCell(target: EventTarget | null): HTMLTableCellElement | null {
  if (!(target instanceof Node)) return null
  let cur: Node | null = target
  while (cur) {
    if (cur instanceof HTMLTableCellElement) {
      return cur
    }
    cur = cur.parentNode
  }
  return null
}

function findClosestFkBadge(target: EventTarget | null): HTMLButtonElement | null {
  if (!(target instanceof Node)) return null
  let cur: Node | null = target
  while (cur) {
    if (cur instanceof HTMLButtonElement && cur.classList.contains('datanoa-fk-badge')) {
      return cur
    }
    cur = cur.parentNode
  }
  return null
}

function createSvgEl(tag: string, attrs: Record<string, string>): Element {
  const el =
    typeof document.createElementNS === 'function'
      ? document.createElementNS('http://www.w3.org/2000/svg', tag)
      : document.createElement(tag)
  for (const [key, val] of Object.entries(attrs)) {
    el.setAttribute(key, val)
  }
  return el
}

function createSortArrowSvg(direction: 'ASC' | 'DESC'): Element {
  const svg = createSvgEl('svg', {
    width: '11',
    height: '11',
    viewBox: '0 0 12 12',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.6',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })
  svg.appendChild(createSvgEl('path', { d: 'M6 9.5V2.5' }))
  svg.appendChild(
    createSvgEl('path', {
      d: direction === 'ASC' ? 'M2.75 5.75L6 2.5L9.25 5.75' : 'M2.75 6.25L6 9.5L9.25 6.25',
    })
  )
  return svg
}

function createColSelectSvg(): Element {
  const svg = createSvgEl('svg', {
    width: '10',
    height: '10',
    viewBox: '0 0 12 12',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.5',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })
  svg.appendChild(createSvgEl('path', { d: 'M3 4.5L6 7.5L9 4.5' }))
  return svg
}

function createPinSvg(): Element {
  const svg = createSvgEl('svg', {
    width: '10',
    height: '10',
    viewBox: '0 0 12 12',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.4',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })
  svg.appendChild(createSvgEl('path', { d: 'M4 2h4l-.5 3.5L9 7H3l1.5-1.5L4 2z' }))
  svg.appendChild(createSvgEl('path', { d: 'M6 7v3.5' }))
  return svg
}

function createFkJumpSvg(): Element {
  const svg = createSvgEl('svg', {
    width: '10',
    height: '10',
    viewBox: '0 0 12 12',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.5',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })
  svg.appendChild(createSvgEl('path', { d: 'M3.5 8.5L8.5 3.5' }))
  svg.appendChild(createSvgEl('path', { d: 'M4.5 3.5h4v4' }))
  return svg
}

const DEFAULT_ROWNUM_WIDTH_PX = 44

export interface VirtualDataGridOptions {
  container: HTMLElement
  data?: TableBrowseResult | QueryResult
  batchMode?: boolean
  tableName?: string
  dialect?: DatabaseDriverType
  onSort?: (column: string, direction: 'ASC' | 'DESC') => void
  onUpdateCell?: (params: {
    primaryKeys: Record<string, unknown>
    column: string
    newValue: unknown
    originalValue: unknown
    rowIndex: number
  }) => Promise<{ ok: boolean; affectedRows?: number; updatedRecord?: Record<string, unknown> }>
  onSelectCell?: (info: SelectedCellInfo | null) => void
  onInspectCell?: (info: SelectedCellInfo) => void
  onStageChange?: (stagedCount: number) => void
  onNotify?: (message: string) => void
  onSelectionChange?: (summary: SelectionSummary) => void
  onQuickFilter?: (predicateSql: string, mode: 'replace' | 'and') => void
  onNavigateForeignKey?: (refTable: string, refColumn: string, value: unknown) => void
  onColumnConfigChange?: (config: { hidden: string[]; pinned: string[] }) => void
  onFindStateChange?: (state: { total: number; activeIndex: number }) => void
}

export class VirtualDataGrid {
  private container: HTMLElement
  private tableContainerEl: HTMLDivElement | null = null
  private tableEl: HTMLTableElement | null = null
  private colgroupEl: HTMLTableColElement | null = null
  private rowNumColEl: HTMLTableColElement | null = null
  private dataColElByModelIdx = new Map<number, HTMLTableColElement>()
  private headerThByModelIdx = new Map<number, HTMLTableCellElement>()
  private theadEl: HTMLTableSectionElement | null = null
  private tbodyEl: HTMLTableSectionElement | null = null
  private contextMenuEl: HTMLDivElement | null = null
  private bulkFillPopoverEl: HTMLDivElement | null = null

  private model: GridModel | null = null
  private rowStates: InternalRowState[] = []
  private rowNumWidth = DEFAULT_ROWNUM_WIDTH_PX
  private columnWidths: number[] = []
  private columnWidthsByTable = new Map<
    string,
    { rowNumWidth: number; columnWidths: number[] }
  >()
  private sortColumn?: string
  private sortDirection?: 'ASC' | 'DESC'
  private batchMode = false
  private isTransposed = false
  private clientFilter = ''
  private clientColumnFilters: ClientColumnFilter[] = []
  private tableName = 'table_name'
  private connectionId = ''
  private schemaName = ''
  private dialect: DatabaseDriverType = 'sqlite'
  private selectedRowIndex: number | null = null
  private selectedColIndex: number | null = null

  private dataVersion = 0
  private filterVersion = 0
  private colLayoutVersion = 0
  private filterStateStamp = 0
  private cachedFilterStamp = -1
  private cachedFilteredRowIndices: number[] = []
  private lastScrollTop = -1
  private lastRenderedWindow: RenderedWindowSnapshot | null = null

  private mountedRowsByVisRow = new Map<number, PooledGridRow>()
  private freeRowPool: PooledGridRow[] = []
  private isPoolMountedInTbody = false
  private topSpacerTr: HTMLTableRowElement | null = null
  private topSpacerTd: HTMLTableCellElement | null = null
  private bottomSpacerTr: HTMLTableRowElement | null = null
  private bottomSpacerTd: HTMLTableCellElement | null = null
  private resizeObserver: ResizeObserver | null = null
  private lastObservedHeight = 0

  private readonly selection = new GridSelectionModel()
  private foreignKeyByColumn = new Map<string, ForeignKeyInfo>()
  private hiddenColumns = new Set<string>()
  private pinnedColumns: string[] = []
  private interactionLocked = false

  private findQuery = ''
  private findMatches: CellCoord[] = []
  private findMatchKeys = new Set<string>()
  private findActiveIndex = -1

  private activeEditor: {
    rowIndex: number
    colIndex: number
    originalValue: unknown
    td: HTMLTableCellElement
    input: HTMLInputElement
    userTyped: boolean
  } | null = null

  private emptyMessage = 'No rows to display.'
  private rafHandle: number | null = null
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private scrollListener: (() => void) | null = null
  private wheelListener: ((e: WheelEvent) => void) | null = null
  private keyDownListener: ((e: KeyboardEvent) => void) | null = null
  private pasteListener: ((e: ClipboardEvent) => void) | null = null
  private tbodyMouseDownListener: ((e: MouseEvent) => void) | null = null
  private tbodyClickListener: ((e: MouseEvent) => void) | null = null
  private tbodyDblClickListener: ((e: MouseEvent) => void) | null = null
  private tbodyContextMenuListener: ((e: MouseEvent) => void) | null = null
  private windowDocClickListener: ((e: MouseEvent) => void) | null = null
  private windowKeyDownListener: ((e: KeyboardEvent) => void) | null = null
  private resizeListeners: {
    move: (e: MouseEvent) => void
    up: () => void
    blur: () => void
  } | null = null
  private resizeRafId: number | null = null
  private activeResizeHandle: HTMLDivElement | null = null
  private dragState: DragSelectionState | null = null
  private handledMouseDownClick = false
  private suppressSortClickUntil = 0
  private isLoading = false
  private lastCopiedDelimitedText = ''

  private onSort?: (column: string, direction: 'ASC' | 'DESC') => void
  private onUpdateCell?: VirtualDataGridOptions['onUpdateCell']
  private onSelectCell?: VirtualDataGridOptions['onSelectCell']
  private onInspectCell?: VirtualDataGridOptions['onInspectCell']
  private onStageChange?: VirtualDataGridOptions['onStageChange']
  private onNotify?: VirtualDataGridOptions['onNotify']
  private onSelectionChange?: VirtualDataGridOptions['onSelectionChange']
  private onQuickFilter?: VirtualDataGridOptions['onQuickFilter']
  private onNavigateForeignKey?: VirtualDataGridOptions['onNavigateForeignKey']
  private onColumnConfigChange?: VirtualDataGridOptions['onColumnConfigChange']
  private onFindStateChange?: VirtualDataGridOptions['onFindStateChange']

  // Shared non-bubbling fallback handlers for synthetic non-bubbling cell events (e.g. Gate C tests)
  private readonly nonBubblingCellClickHandler = (e: MouseEvent): void => {
    if (e.bubbles) return
    this.handleTbodyClick(e)
  }

  private readonly nonBubblingCellDblClickHandler = (e: MouseEvent): void => {
    if (e.bubbles) return
    this.handleTbodyDblClick(e)
  }

  constructor(options: VirtualDataGridOptions) {
    this.container = options.container
    this.batchMode = Boolean(options.batchMode)
    if (options.tableName) this.tableName = options.tableName
    if (options.dialect) this.dialect = options.dialect
    this.onSort = options.onSort
    this.onUpdateCell = options.onUpdateCell
    this.onSelectCell = options.onSelectCell
    this.onInspectCell = options.onInspectCell
    this.onStageChange = options.onStageChange
    this.onNotify = options.onNotify
    this.onSelectionChange = options.onSelectionChange
    this.onQuickFilter = options.onQuickFilter
    this.onNavigateForeignKey = options.onNavigateForeignKey
    this.onColumnConfigChange = options.onColumnConfigChange
    this.onFindStateChange = options.onFindStateChange

    this.initDOM()
    if (options.data) {
      this.setData(options.data)
    }
  }

  private initDOM(): void {
    this.container.innerHTML = ''
    this.tableContainerEl = document.createElement('div')
    this.tableContainerEl.className = 'datanoa-grid-container'
    this.tableContainerEl.tabIndex = 0

    this.tableEl = document.createElement('table')
    this.tableEl.className = 'datanoa-grid-table'

    this.colgroupEl = document.createElement('colgroup')
    this.theadEl = document.createElement('thead')
    this.theadEl.className = 'datanoa-grid-header'

    this.tbodyEl = document.createElement('tbody')

    this.tableEl.appendChild(this.colgroupEl)
    this.tableEl.appendChild(this.theadEl)
    this.tableEl.appendChild(this.tbodyEl)
    this.tableContainerEl.appendChild(this.tableEl)
    this.container.appendChild(this.tableContainerEl)

    this.scrollListener = () => {
      if (this.contextMenuEl) {
        this.closeContextMenu()
      }
      if (this.isTransposed || !this.tableContainerEl) return
      const curTop = this.tableContainerEl.scrollTop
      // Pure horizontal scroll (scrollLeft change) with unchanged data/filter/layout: 0 DOM rebuilds
      if (
        curTop === this.lastScrollTop &&
        this.lastRenderedWindow !== null &&
        this.lastRenderedWindow.dataVersion === this.dataVersion &&
        this.lastRenderedWindow.filterVersion === this.filterVersion &&
        this.lastRenderedWindow.colLayoutVersion === this.colLayoutVersion
      ) {
        return
      }
      if (typeof requestAnimationFrame === 'function') {
        if (this.rafHandle !== null) return
        this.rafHandle = requestAnimationFrame(() => {
          this.rafHandle = null
          this.renderVisibleRows()
        })
      } else {
        this.renderVisibleRows()
      }
    }
    this.tableContainerEl.addEventListener('scroll', this.scrollListener)

    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0]
        const nextH = entry?.contentRect?.height ?? this.tableContainerEl?.clientHeight ?? 0
        if (nextH > 0 && Math.abs(nextH - this.lastObservedHeight) >= 1) {
          this.lastObservedHeight = nextH
          this.handleViewportResize()
        }
      })
      this.resizeObserver.observe(this.tableContainerEl)
    }

    this.wheelListener = (e: WheelEvent) => {
      if (!this.tableContainerEl || (!e.ctrlKey && !e.metaKey)) return
      const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
      if (!raw) return
      const step =
        e.deltaMode === 1 ? raw * 28 : e.deltaMode === 2 ? raw * 320 : raw * 1.25
      this.tableContainerEl.scrollLeft += step
      e.preventDefault()
    }
    this.tableContainerEl.addEventListener('wheel', this.wheelListener, { passive: false })

    this.keyDownListener = (e: KeyboardEvent) => {
      this.handleGridKeyDown(e)
    }
    this.tableContainerEl.addEventListener('keydown', this.keyDownListener)

    this.pasteListener = (e: ClipboardEvent) => {
      this.handleGridPaste(e)
    }
    this.tableContainerEl.addEventListener('paste', this.pasteListener)

    this.tbodyMouseDownListener = (e: MouseEvent) => {
      this.handleTbodyMouseDown(e)
    }
    this.tbodyClickListener = (e: MouseEvent) => {
      this.handleTbodyClick(e)
    }
    this.tbodyDblClickListener = (e: MouseEvent) => {
      this.handleTbodyDblClick(e)
    }
    this.tbodyContextMenuListener = (e: MouseEvent) => {
      this.handleTbodyContextMenu(e)
    }
    this.tbodyEl.addEventListener('mousedown', this.tbodyMouseDownListener)
    this.tbodyEl.addEventListener('click', this.tbodyClickListener)
    this.tbodyEl.addEventListener('dblclick', this.tbodyDblClickListener)
    this.tbodyEl.addEventListener('contextmenu', this.tbodyContextMenuListener)

    if (typeof window !== 'undefined') {
      this.windowDocClickListener = (e: MouseEvent) => {
        if (
          this.contextMenuEl &&
          e.target instanceof Node &&
          !this.contextMenuEl.contains(e.target)
        ) {
          this.closeContextMenu()
        }
        if (
          this.bulkFillPopoverEl &&
          e.target instanceof Node &&
          !this.bulkFillPopoverEl.contains(e.target)
        ) {
          this.closeBulkFillPopover()
        }
      }
      this.windowKeyDownListener = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          this.closeContextMenu()
          this.closeBulkFillPopover()
        }
      }
      window.addEventListener('mousedown', this.windowDocClickListener)
      window.addEventListener('keydown', this.windowKeyDownListener)
    }
  }

  private invalidateFilterCache(): void {
    this.filterStateStamp++
    this.filterVersion++
  }

  private invalidateDataCache(): void {
    this.dataVersion++
  }

  private invalidateColLayoutCache(): void {
    this.colLayoutVersion++
  }

  private resetRowPoolMountState(): void {
    for (const pooled of this.mountedRowsByVisRow.values()) {
      if (this.freeRowPool.length < 120) {
        this.freeRowPool.push(pooled)
      }
    }
    this.mountedRowsByVisRow.clear()
    this.isPoolMountedInTbody = false
    this.lastRenderedWindow = null
    this.lastScrollTop = -1
  }

  public handleViewportResize(): void {
    if (!this.tableContainerEl || this.isTransposed || this.isLoading || !this.model) return
    const nextH = this.tableContainerEl.clientHeight
    if (nextH > 0) {
      this.lastObservedHeight = nextH
    }
    this.renderVisibleRows()
  }

  public setContextMeta(
    tableName: string,
    dialect: DatabaseDriverType,
    connectionId?: string,
    schema?: string
  ): void {
    this.tableName = tableName || 'table_name'
    this.dialect = dialect
    if (connectionId !== undefined) {
      this.connectionId = connectionId
    }
    if (schema !== undefined) {
      this.schemaName = schema
    }
  }

  public setForeignKeys(foreignKeys: ForeignKeyInfo[]): void {
    this.foreignKeyByColumn.clear()
    for (const fk of foreignKeys) {
      if (fk.column) {
        this.foreignKeyByColumn.set(fk.column, fk)
        this.foreignKeyByColumn.set(fk.column.toLowerCase(), fk)
      }
    }
    this.invalidateDataCache()
    if (this.model && !this.isLoading) {
      this.renderVisibleRows()
    }
  }

  public setInteractionLocked(locked: boolean): void {
    this.interactionLocked = Boolean(locked)
    if (this.interactionLocked && this.activeEditor) {
      this.cancelCellEdit()
    }
  }

  public setBatchMode(enabled: boolean): void {
    this.batchMode = enabled
  }

  public isBatchMode(): boolean {
    return this.batchMode
  }

  public setTransposed(enabled: boolean): void {
    this.isTransposed = enabled
    this.invalidateColLayoutCache()
    this.resetRowPoolMountState()
    this.closeContextMenu()
    this.closeBulkFillPopover()
    if (this.tableEl) {
      this.tableEl.className = enabled ? 'datanoa-grid-table transposed' : 'datanoa-grid-table'
    }
    this.renderHeader()
    this.renderVisibleRows()
  }

  public getTransposed(): boolean {
    return this.isTransposed
  }

  public setClientFilter(text: string): void {
    const nextFilter = text.trim().toLowerCase()
    if (nextFilter === this.clientFilter) return
    this.clientFilter = nextFilter
    this.invalidateFilterCache()
    if (this.tableContainerEl) {
      this.tableContainerEl.scrollTop = 0
    }
    this.selection.clear()
    this.selectedRowIndex = null
    this.selectedColIndex = null
    if (this.findQuery) {
      this.recomputeFindMatches()
      this.onFindStateChange?.({ total: this.findMatches.length, activeIndex: this.findActiveIndex })
    }
    if (this.isTransposed) {
      this.renderHeader()
    }
    this.renderVisibleRows()
    this.notifyAllSelectionListeners()
  }

  public addClientColumnFilter(
    column: string,
    value: unknown,
    op: 'eq' | 'neq' | 'is-null' | 'is-not-null'
  ): void {
    const col = column.trim()
    if (!col) return
    this.clientColumnFilters.push({ column: col, value, op })
    this.invalidateFilterCache()
    if (this.tableContainerEl) {
      this.tableContainerEl.scrollTop = 0
    }
    this.selection.clear()
    this.selectedRowIndex = null
    this.selectedColIndex = null
    if (this.findQuery) {
      this.recomputeFindMatches()
      this.onFindStateChange?.({ total: this.findMatches.length, activeIndex: this.findActiveIndex })
    }
    if (this.isTransposed) {
      this.renderHeader()
    }
    this.renderVisibleRows()
    this.notifyAllSelectionListeners()
  }

  public clearClientColumnFilters(): void {
    if (this.clientColumnFilters.length === 0) return
    this.clientColumnFilters = []
    this.invalidateFilterCache()
    if (this.tableContainerEl) {
      this.tableContainerEl.scrollTop = 0
    }
    if (this.findQuery) {
      this.recomputeFindMatches()
      this.onFindStateChange?.({ total: this.findMatches.length, activeIndex: this.findActiveIndex })
    }
    if (this.isTransposed) {
      this.renderHeader()
    }
    this.renderVisibleRows()
  }

  public clearSortIndicator(): void {
    if (!this.sortColumn && !this.sortDirection) return
    this.sortColumn = undefined
    this.sortDirection = undefined
    this.renderHeader()
  }

  public setLoading(loading: boolean, label?: string): void {
    this.isLoading = Boolean(loading)
    if (label) {
      this.emptyMessage = label
    }
    if (this.isLoading) {
      const hadStaged = this.getStagedCount() > 0
      this.cleanupColumnResize()
      this.cleanupDragSelection()
      this.selection.clear()
      this.selectedRowIndex = null
      this.selectedColIndex = null
      this.activeEditor = null
      this.closeContextMenu()
      this.closeBulkFillPopover()
      this.model = null
      this.rowStates = []
      this.findMatches = []
      this.findMatchKeys.clear()
      this.findActiveIndex = -1
      this.invalidateDataCache()
      this.invalidateFilterCache()
      this.resetRowPoolMountState()
      this.renderHeader()
      this.renderVisibleRows()
      if (hadStaged) {
        this.onStageChange?.(0)
      }
      this.notifyAllSelectionListeners()
    }
  }

  public setEmptyMessage(message: string): void {
    this.emptyMessage = message || 'No rows to display.'
    if (!/^Loading\b/i.test(this.emptyMessage)) {
      this.isLoading = false
    }
    this.invalidateDataCache()
    if (!this.tbodyEl) return
    if (!this.model || this.getFilteredRowIndices().length === 0) {
      this.resetRowPoolMountState()
      this.renderHeader()
      this.renderVisibleRows()
    }
  }

  public setData(data: TableBrowseResult | QueryResult): void {
    this.isLoading = false
    this.cleanupColumnResize()
    this.cleanupDragSelection()
    const formatted = formatGridModel(data)
    const clonedRows = formatted.rows.map((r) => cloneRow(r))

    this.model = {
      headers: formatted.headers,
      columns: formatted.columns,
      rows: clonedRows,
      rowCount: formatted.rowCount,
      canEdit: formatted.canEdit,
      primaryKey: formatted.primaryKey,
    }

    this.rowStates = clonedRows.map((row) => ({
      kind: 'existing',
      deleted: false,
      original: cloneRow(row),
      dirtyCols: new Map<string, unknown>(),
    }))

    this.clientColumnFilters = []
    this.selection.clear()
    this.selectedRowIndex = null
    this.selectedColIndex = null
    this.activeEditor = null
    this.closeContextMenu()
    this.closeBulkFillPopover()
    this.invalidateDataCache()
    this.invalidateFilterCache()
    this.invalidateColLayoutCache()
    this.resetRowPoolMountState()

    if (this.model.headers.length === 0) {
      this.rowNumWidth = DEFAULT_ROWNUM_WIDTH_PX
      this.columnWidths = []
    } else {
      const cacheKey = this.getColumnCacheKey(this.model.headers)
      const cached = this.columnWidthsByTable.get(cacheKey)
      if (cached && cached.columnWidths.length === this.model.headers.length) {
        this.rowNumWidth = cached.rowNumWidth
        this.columnWidths = [...cached.columnWidths]
      } else {
        this.rowNumWidth = DEFAULT_ROWNUM_WIDTH_PX
        this.columnWidths = this.computeInitialColumnWidths(this.model)
        if (this.model.rows.length > 0) {
          this.columnWidthsByTable.set(cacheKey, {
            rowNumWidth: this.rowNumWidth,
            columnWidths: [...this.columnWidths],
          })
        }
      }
    }

    if (this.findQuery) {
      this.recomputeFindMatches()
      this.onFindStateChange?.({ total: this.findMatches.length, activeIndex: this.findActiveIndex })
    } else {
      this.findMatches = []
      this.findMatchKeys.clear()
      this.findActiveIndex = -1
    }

    this.renderHeader()
    this.renderVisibleRows()
    this.onStageChange?.(0)
    this.notifyAllSelectionListeners()
  }

  public getColumnConfig(): { hidden: string[]; pinned: string[]; allColumns: string[] } {
    const allColumns = this.model ? [...this.model.headers] : []
    const headerSet = new Set(allColumns)
    const hidden =
      allColumns.length > 0
        ? allColumns.filter((h) => this.hiddenColumns.has(h))
        : Array.from(this.hiddenColumns)
    const pinned =
      allColumns.length > 0
        ? this.pinnedColumns.filter((h) => headerSet.has(h) && !this.hiddenColumns.has(h))
        : [...this.pinnedColumns]
    return { hidden, pinned, allColumns }
  }

  public setColumnVisibility(colName: string, visible: boolean): void {
    const name = colName.trim()
    if (!name) return
    if (!visible) {
      if (this.model && this.model.headers.length > 0) {
        const remaining = this.model.headers.filter(
          (h) => h !== name && !this.hiddenColumns.has(h)
        )
        if (remaining.length === 0) {
          this.onNotify?.('At least one column must remain visible')
          return
        }
      }
      this.hiddenColumns.add(name)
      this.pinnedColumns = this.pinnedColumns.filter((p) => p !== name)
    } else {
      this.hiddenColumns.delete(name)
    }
    this.applyColumnLayoutRefresh(true)
  }

  public showAllColumns(): void {
    this.hiddenColumns.clear()
    this.applyColumnLayoutRefresh(true)
  }

  public togglePinColumn(colName: string): void {
    const name = colName.trim()
    if (!name) return
    const existingIdx = this.pinnedColumns.indexOf(name)
    if (existingIdx >= 0) {
      this.pinnedColumns.splice(existingIdx, 1)
    } else {
      this.hiddenColumns.delete(name)
      this.pinnedColumns.push(name)
    }
    this.applyColumnLayoutRefresh(true)
  }

  public setColumnConfig(config: { hidden: string[]; pinned: string[] }): void {
    this.hiddenColumns = new Set(config.hidden)
    const seen = new Set<string>()
    this.pinnedColumns = []
    for (const col of config.pinned) {
      if (!seen.has(col) && !this.hiddenColumns.has(col)) {
        seen.add(col)
        this.pinnedColumns.push(col)
      }
    }
    if (this.model && this.model.headers.length > 0) {
      const anyVisible = this.model.headers.some((h) => !this.hiddenColumns.has(h))
      if (!anyVisible) {
        this.hiddenColumns.delete(this.model.headers[0])
      }
    }
    this.applyColumnLayoutRefresh(false)
  }

  private applyColumnLayoutRefresh(notifyCallback: boolean): void {
    this.invalidateColLayoutCache()
    this.selection.clear()
    this.selectedRowIndex = null
    this.selectedColIndex = null
    if (this.findQuery) {
      this.recomputeFindMatches()
      this.onFindStateChange?.({ total: this.findMatches.length, activeIndex: this.findActiveIndex })
    }
    this.renderHeader()
    this.renderVisibleRows()
    this.notifyAllSelectionListeners()
    if (notifyCallback) {
      const cfg = this.getColumnConfig()
      this.onColumnConfigChange?.({ hidden: cfg.hidden, pinned: cfg.pinned })
    }
  }

  private getVisibleColumnIndices(): number[] {
    if (!this.model || this.model.headers.length === 0) return []
    const headers = this.model.headers
    const pinnedIndices: number[] = []
    const pinnedSet = new Set<number>()

    for (const pinnedName of this.pinnedColumns) {
      if (this.hiddenColumns.has(pinnedName)) continue
      const idx = headers.indexOf(pinnedName)
      if (idx >= 0 && !pinnedSet.has(idx)) {
        pinnedIndices.push(idx)
        pinnedSet.add(idx)
      }
    }

    const regularIndices: number[] = []
    for (let i = 0; i < headers.length; i++) {
      if (pinnedSet.has(i) || this.hiddenColumns.has(headers[i])) continue
      regularIndices.push(i)
    }

    const combined = [...pinnedIndices, ...regularIndices]
    if (combined.length === 0) {
      return [0]
    }
    return combined
  }

  private getPinnedVisibleCount(visibleCols: number[]): number {
    if (!this.model || visibleCols.length === 0 || this.pinnedColumns.length === 0) return 0
    const pinnedNameSet = new Set(this.pinnedColumns)
    let count = 0
    for (const colIdx of visibleCols) {
      const header = this.model.headers[colIdx]
      if (pinnedNameSet.has(header) && !this.hiddenColumns.has(header)) {
        count++
      } else {
        break
      }
    }
    return count
  }

  private computePinnedLeftOffsets(visibleCols: number[], pinnedCount: number): number[] {
    const offsets: number[] = []
    let acc = this.rowNumWidth
    for (let i = 0; i < pinnedCount; i++) {
      offsets.push(acc)
      const colIdx = visibleCols[i]
      acc += this.columnWidths[colIdx] ?? 120
    }
    return offsets
  }

  private updatePinnedOffsets(): void {
    if (this.isTransposed || !this.model) return
    const visibleCols = this.getVisibleColumnIndices()
    const pinnedCount = this.getPinnedVisibleCount(visibleCols)
    if (pinnedCount === 0) return

    const offsets = this.computePinnedLeftOffsets(visibleCols, pinnedCount)
    for (let visCol = 0; visCol < pinnedCount; visCol++) {
      const modelColIdx = visibleCols[visCol]
      const leftPx = `${offsets[visCol]}px`
      const th = this.headerThByModelIdx.get(modelColIdx)
      if (th) {
        th.style.left = leftPx
      }
    }

    if (!this.tbodyEl) return
    for (let visCol = 0; visCol < pinnedCount; visCol++) {
      const leftPx = `${offsets[visCol]}px`
      const cells = this.tbodyEl.querySelectorAll(`td[data-vis-col="${visCol}"]`)
      cells.forEach((cell) => {
        if (cell instanceof HTMLElement) {
          cell.style.left = leftPx
        }
      })
    }
  }

  private getForeignKeyForColumn(header: string): ForeignKeyInfo | null {
    return (
      this.foreignKeyByColumn.get(header) ??
      this.foreignKeyByColumn.get(header.toLowerCase()) ??
      null
    )
  }

  private canJumpForeignKey(rowIndex: number, colIndex: number): boolean {
    if (!this.model || !this.onNavigateForeignKey) return false
    const header = this.model.headers[colIndex]
    if (!header) return false
    const fk = this.getForeignKeyForColumn(header)
    if (!fk) return false
    const val = getCellValue(this.model.rows[rowIndex], colIndex, header)
    return val !== null && val !== undefined
  }

  private triggerFkJump(rowIndex: number, colIndex: number): void {
    if (!this.model || !this.onNavigateForeignKey) return
    const header = this.model.headers[colIndex]
    if (!header) return
    const fk = this.getForeignKeyForColumn(header)
    if (!fk) return
    const val = getCellValue(this.model.rows[rowIndex], colIndex, header)
    if (val === null || val === undefined) return
    this.onNavigateForeignKey(fk.referencedTable, fk.referencedColumn, val)
  }

  public getSelectionSummary(): SelectionSummary {
    const model = this.model
    if (!model) {
      return this.selection.computeSelectionSummary(0, 0, () => null)
    }
    const visibleRows = this.getFilteredRowIndices()
    const visibleCols = this.getVisibleColumnIndices()
    return this.selection.computeSelectionSummary(
      visibleRows.length,
      visibleCols.length,
      (vr, vc) => {
        const rIdx = visibleRows[vr]
        const cIdx = visibleCols[vc]
        if (rIdx === undefined || cIdx === undefined) return null
        return getCellValue(model.rows[rIdx], cIdx, model.headers[cIdx])
      }
    )
  }

  public selectAll(): void {
    if (!this.model) return
    const visibleRows = this.getFilteredRowIndices()
    const visibleCols = this.getVisibleColumnIndices()
    if (visibleRows.length === 0 || visibleCols.length === 0) {
      this.clearSelection()
      return
    }
    this.selection.selectAll(visibleRows.length, visibleCols.length)
    this.syncSelectionClasses()
    this.notifyAllSelectionListeners()
  }

  public clearSelection(): void {
    this.selection.clear()
    this.selectedRowIndex = null
    this.selectedColIndex = null
    this.syncSelectionClasses()
    this.notifyAllSelectionListeners()
  }

  public exportSelection(format: SelectionExportFormat): string {
    const model = this.model
    if (!model) return ''
    const visibleRows = this.getFilteredRowIndices()
    const visibleCols = this.getVisibleColumnIndices()
    if (visibleRows.length === 0 || visibleCols.length === 0) return ''

    if (this.selection.isEmpty()) {
      if (this.selectedRowIndex !== null && this.selectedColIndex !== null) {
        const vr = visibleRows.indexOf(this.selectedRowIndex)
        const vc = visibleCols.indexOf(this.selectedColIndex)
        if (vr >= 0 && vc >= 0) {
          this.selection.selectCell(vr, vc, 'cell')
        }
      }
      if (this.selection.isEmpty()) return ''
    }

    const selVisRows = this.selection.getSelectedRowIndices(visibleRows.length)
    const selVisCols = this.selection.getSelectedColIndices(visibleCols.length)
    if (selVisRows.length === 0 || selVisCols.length === 0) return ''

    const selHeaders = selVisCols.map((vc) => model.headers[visibleCols[vc]])

    if (format === 'sql-in') {
      const values: unknown[] = []
      this.selection.forEachSelectedCell(visibleRows.length, visibleCols.length, (vr, vc) => {
        const rIdx = visibleRows[vr]
        const cIdx = visibleCols[vc]
        if (rIdx !== undefined && cIdx !== undefined) {
          values.push(getCellValue(model.rows[rIdx], cIdx, model.headers[cIdx]))
        }
      })
      return formatSqlInList(values, this.dialect, {
        deduplicate: true,
        columnName: selHeaders.length === 1 ? selHeaders[0] : undefined,
      })
    }

    if (format === 'sql-insert') {
      const records: Record<string, unknown>[] = selVisRows.map((vr) => {
        const rIdx = visibleRows[vr]
        const rowObj: Record<string, unknown> = {}
        for (const vc of selVisCols) {
          const cIdx = visibleCols[vc]
          const header = model.headers[cIdx]
          if (this.selection.isSelected(vr, vc)) {
            const val = getCellValue(model.rows[rIdx], cIdx, header)
            rowObj[header] = val === undefined ? null : val
          } else {
            rowObj[header] = null
          }
        }
        return rowObj
      })
      return formatDataExport({
        columns: selHeaders,
        rows: records,
        format: 'sql-insert',
        tableName: this.tableName,
        dialect: this.dialect,
      })
    }

    const matrix: unknown[][] = selVisRows.map((vr) => {
      const rIdx = visibleRows[vr]
      return selVisCols.map((vc) => {
        if (!this.selection.isSelected(vr, vc)) {
          return format === 'json' ? null : ''
        }
        const cIdx = visibleCols[vc]
        const val = getCellValue(model.rows[rIdx], cIdx, model.headers[cIdx])
        return val === undefined ? null : val
      })
    })
    return formatCellMatrixExport(selHeaders, matrix, format)
  }

  public getScrollLeft(): number {
    return this.tableContainerEl ? this.tableContainerEl.scrollLeft : 0
  }

  public setScrollLeft(px: number): void {
    if (!this.tableContainerEl) return
    const target = Math.max(0, Math.round(px))
    this.tableContainerEl.scrollLeft = target
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (this.tableContainerEl) {
          this.tableContainerEl.scrollLeft = target
        }
      })
    }
  }

  public copySelection(format: SelectionExportFormat): string {
    const output = this.exportSelection(format)
    if (output.length > 0) {
      copyTextToClipboard(output)
      if (format === 'tsv' || format === 'tsv-headers' || format === 'csv') {
        this.lastCopiedDelimitedText = output
      }
    }
    return output
  }

  public setFindQuery(query: string): { total: number; activeIndex: number } {
    this.findQuery = query
    this.recomputeFindMatches()
    this.syncFindMatchClasses()
    if (this.findActiveIndex >= 0) {
      this.scrollFindMatchIntoView(this.findActiveIndex)
    }
    return { total: this.findMatches.length, activeIndex: this.findActiveIndex }
  }

  public findNext(direction: 1 | -1): { total: number; activeIndex: number } {
    const total = this.findMatches.length
    if (total === 0) {
      this.findActiveIndex = -1
      return { total: 0, activeIndex: -1 }
    }
    if (this.findActiveIndex < 0) {
      this.findActiveIndex = direction > 0 ? 0 : total - 1
    } else {
      this.findActiveIndex = (this.findActiveIndex + direction + total) % total
    }
    this.scrollFindMatchIntoView(this.findActiveIndex)
    this.syncFindMatchClasses()
    return { total, activeIndex: this.findActiveIndex }
  }

  public getFindState(): { query: string; total: number; activeIndex: number } {
    return {
      query: this.findQuery,
      total: this.findMatches.length,
      activeIndex: this.findActiveIndex,
    }
  }

  private getStickyColumnsWidth(): number {
    if (this.isTransposed || !this.model) return 0
    const visibleCols = this.getVisibleColumnIndices()
    const pinnedCount = this.getPinnedVisibleCount(visibleCols)
    let width = this.rowNumWidth
    for (let i = 0; i < pinnedCount; i++) {
      width += this.columnWidths[visibleCols[i]] ?? 120
    }
    return width
  }

  private scrollCellIntoViewAccountingForSticky(td: HTMLElement, visCol: number): void {
    td.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    if (this.isTransposed || !this.tableContainerEl) return
    const visibleCols = this.getVisibleColumnIndices()
    const pinnedCount = this.getPinnedVisibleCount(visibleCols)
    if (visCol < pinnedCount) return

    const contRect = this.tableContainerEl.getBoundingClientRect?.()
    const tdRect = td.getBoundingClientRect?.()
    if (!contRect || !tdRect || contRect.width <= 0 || tdRect.width <= 0) return

    const stickyWidth = this.getStickyColumnsWidth()
    const visibleLeftEdge = contRect.left + stickyWidth
    if (tdRect.left < visibleLeftEdge) {
      const overlap = visibleLeftEdge - tdRect.left
      this.tableContainerEl.scrollLeft = Math.max(0, this.tableContainerEl.scrollLeft - overlap - 8)
    } else if (tdRect.right > contRect.right) {
      const overflow = tdRect.right - contRect.right
      this.tableContainerEl.scrollLeft += overflow + 8
    }
  }

  private refreshFindMatchesIfActive(): void {
    if (!this.findQuery.trim()) return
    this.recomputeFindMatches()
    this.syncFindMatchClasses()
    this.onFindStateChange?.({ total: this.findMatches.length, activeIndex: this.findActiveIndex })
  }

  private recomputeFindMatches(): void {
    this.findMatches = []
    this.findMatchKeys.clear()
    this.findActiveIndex = -1

    const model = this.model
    const needle = this.findQuery.trim()
    if (!model || !needle) return

    const visibleRows = this.getFilteredRowIndices()
    const visibleCols = this.getVisibleColumnIndices()
    const rowCount = visibleRows.length
    const colCount = visibleCols.length
    if (rowCount === 0 || colCount === 0) return

    const needleLower = needle.toLowerCase()
    const needleMatchesNull = 'null'.includes(needleLower)
    const maxMatches = 10000
    const headers = model.headers
    const rows = model.rows
    const visHeaders = new Array<string>(colCount)
    for (let vc = 0; vc < colCount; vc++) {
      visHeaders[vc] = headers[visibleCols[vc]]
    }

    const matches: CellCoord[] = []
    outer: for (let vr = 0; vr < rowCount; vr++) {
      const row = rows[visibleRows[vr]]
      if (row === undefined) continue
      const isArr = Array.isArray(row)
      for (let vc = 0; vc < colCount; vc++) {
        const raw = isArr ? row[visibleCols[vc]] : row[visHeaders[vc]]
        let matched = false
        if (raw === null || raw === undefined) {
          matched = needleMatchesNull
        } else if (typeof raw === 'string') {
          matched = raw.toLowerCase().includes(needleLower)
        } else if (typeof raw === 'number' || typeof raw === 'boolean') {
          matched = String(raw).toLowerCase().includes(needleLower)
        } else if (typeof raw === 'object') {
          try {
            matched = JSON.stringify(raw).toLowerCase().includes(needleLower)
          } catch {
            matched = String(raw).toLowerCase().includes(needleLower)
          }
        } else {
          matched = String(raw).toLowerCase().includes(needleLower)
        }
        if (matched) {
          matches.push({ row: vr, col: vc })
          this.findMatchKeys.add(`${vr}:${vc}`)
          if (matches.length >= maxMatches) {
            break outer
          }
        }
      }
    }

    this.findMatches = matches
    this.findActiveIndex = matches.length > 0 ? 0 : -1
  }

  private syncFindMatchClasses(): void {
    if (!this.tbodyEl) return
    const activeMatch =
      this.findActiveIndex >= 0 ? (this.findMatches[this.findActiveIndex] ?? null) : null
    const cells = this.tbodyEl.querySelectorAll('td[data-vis-row][data-vis-col]')
    cells.forEach((cell) => {
      if (!(cell instanceof HTMLElement)) return
      const vr = parseOptionalInt(cell.dataset.visRow)
      const vc = parseOptionalInt(cell.dataset.visCol)
      if (vr === null || vc === null) return
      const isMatch = this.findMatchKeys.has(`${vr}:${vc}`)
      const isActive = activeMatch !== null && activeMatch.row === vr && activeMatch.col === vc
      cell.classList.toggle('datanoa-cell-match', isMatch)
      cell.classList.toggle('datanoa-cell-match-active', isActive)
    })
  }

  private scrollFindMatchIntoView(matchIdx: number): void {
    const match = this.findMatches[matchIdx]
    if (!match || !this.tableContainerEl || !this.tbodyEl) return
    let targetTd = this.tbodyEl.querySelector(
      `td[data-vis-row="${match.row}"][data-vis-col="${match.col}"]`
    )
    if (!targetTd && !this.isTransposed) {
      const clientHeight = this.tableContainerEl.clientHeight || 440
      this.tableContainerEl.scrollTop = Math.max(
        0,
        match.row * ROW_HEIGHT_PX - Math.floor(clientHeight / 2)
      )
      this.renderVisibleRows()
      targetTd = this.tbodyEl.querySelector(
        `td[data-vis-row="${match.row}"][data-vis-col="${match.col}"]`
      )
    }
    if (targetTd instanceof HTMLElement) {
      this.scrollCellIntoViewAccountingForSticky(targetTd, match.col)
    }
  }

  private getColumnCacheKey(headers: string[]): string {
    return `${this.dialect}\u0000${this.tableName}\u0000${headers.join('\u0001')}`
  }

  private saveColumnWidthsToCache(): void {
    if (!this.model || this.model.headers.length === 0) return
    this.columnWidthsByTable.set(this.getColumnCacheKey(this.model.headers), {
      rowNumWidth: this.rowNumWidth,
      columnWidths: [...this.columnWidths],
    })
  }

  private computeInitialColumnWidths(model: GridModel): number[] {
    const sampleCount = Math.min(25, model.rows.length)
    const widths = model.headers.map((header, colIdx) => {
      const colDef = model.columns[colIdx]
      const colType = colDef && 'type' in colDef ? colDef.type : undefined
      let maxChars = header.length + 2
      for (let r = 0; r < sampleCount; r++) {
        const val = getCellValue(model.rows[r], colIdx, header)
        const formatted = formatCellValue(val, colType).text
        const len = Math.min(formatted.length, 60)
        if (len > maxChars) {
          maxChars = len
        }
      }
      const px = Math.round(maxChars * 7.5 + 24)
      return Math.max(84, Math.min(300, px))
    })
    if (model.rows.length === 0 && widths.length > 0) {
      const minTableWidth = 340
      const currentTotal = this.rowNumWidth + widths.reduce((sum, w) => sum + w, 0)
      if (currentTotal < minTableWidth) {
        const extraPerCol = Math.ceil((minTableWidth - currentTotal) / widths.length)
        for (let i = 0; i < widths.length; i++) {
          widths[i] += extraPerCol
        }
      }
    }
    return widths
  }

  private updateTableWidthOnly(): void {
    if (!this.tableEl || this.isTransposed) return
    if (!this.model || this.model.headers.length === 0) {
      this.tableEl.style.width = '100%'
      return
    }
    const visibleCols = this.getVisibleColumnIndices()
    const totalWidth =
      this.rowNumWidth +
      visibleCols.reduce((sum, colIdx) => sum + (this.columnWidths[colIdx] ?? 120), 0)
    this.tableEl.style.width = `${totalWidth}px`
  }

  private matchesClientColumnFilters(row: Record<string, unknown> | unknown[]): boolean {
    const model = this.model
    if (!model || this.clientColumnFilters.length === 0) return true
    for (const flt of this.clientColumnFilters) {
      const colIdx = model.headers.indexOf(flt.column)
      if (colIdx < 0) continue
      const cellVal = getCellValue(row, colIdx, flt.column)
      const isNull = cellVal === null || cellVal === undefined
      if (flt.op === 'is-null') {
        if (!isNull) return false
      } else if (flt.op === 'is-not-null') {
        if (isNull) return false
      } else if (flt.op === 'eq') {
        if (flt.value === null || flt.value === undefined) {
          if (!isNull) return false
        } else if (isNull || stringifyFilterValue(cellVal) !== stringifyFilterValue(flt.value)) {
          return false
        }
      } else if (flt.op === 'neq') {
        if (flt.value === null || flt.value === undefined) {
          if (isNull) return false
        } else if (!isNull && stringifyFilterValue(cellVal) === stringifyFilterValue(flt.value)) {
          return false
        }
      }
    }
    return true
  }

  private getFilteredRowIndices(): number[] {
    if (this.cachedFilterStamp === this.filterStateStamp) {
      return this.cachedFilteredRowIndices
    }
    const model = this.model
    if (!model) {
      this.cachedFilteredRowIndices = []
      this.cachedFilterStamp = this.filterStateStamp
      return this.cachedFilteredRowIndices
    }
    const total = model.rows.length
    const hasSearch = this.clientFilter.length > 0
    const hasColFilters = this.clientColumnFilters.length > 0
    if (!hasSearch && !hasColFilters) {
      const all = new Array<number>(total)
      for (let i = 0; i < total; i++) {
        all[i] = i
      }
      this.cachedFilteredRowIndices = all
      this.cachedFilterStamp = this.filterStateStamp
      return all
    }

    const query = this.clientFilter
    const queryMatchesNull = 'null'.includes(query)
    const headers = model.headers
    const colCount = headers.length
    const rows = model.rows
    const matched: number[] = []
    for (let i = 0; i < total; i++) {
      if (this.rowStates[i]?.kind === 'inserted') {
        matched.push(i)
        continue
      }
      const row = rows[i]
      if (hasColFilters && !this.matchesClientColumnFilters(row)) {
        continue
      }
      if (hasSearch) {
        const isArr = Array.isArray(row)
        let hit = false
        for (let colIdx = 0; colIdx < colCount; colIdx++) {
          const val = isArr ? row[colIdx] : row[headers[colIdx]]
          if (val === null || val === undefined) {
            if (queryMatchesNull) {
              hit = true
              break
            }
            continue
          }
          if (typeof val === 'string') {
            if (val.toLowerCase().includes(query)) {
              hit = true
              break
            }
          } else if (typeof val === 'object') {
            try {
              if (JSON.stringify(val).toLowerCase().includes(query)) {
                hit = true
                break
              }
            } catch {
              if (String(val).toLowerCase().includes(query)) {
                hit = true
                break
              }
            }
          } else if (String(val).toLowerCase().includes(query)) {
            hit = true
            break
          }
        }
        if (!hit) continue
      }
      matched.push(i)
    }
    this.cachedFilteredRowIndices = matched
    this.cachedFilterStamp = this.filterStateStamp
    return matched
  }

  /**
   * Sorts in-memory rows (used for ad-hoc SQL query results where server pagination is not active).
   */
  public sortInMemoryRows(column: string, direction: 'ASC' | 'DESC'): void {
    const model = this.model
    if (!model) return
    const colIndex = model.headers.indexOf(column)
    if (colIndex < 0) return

    this.sortColumn = column
    this.sortDirection = direction
    const factor = direction === 'DESC' ? -1 : 1

    const paired = model.rows.map((row, idx) => ({
      row,
      state: this.rowStates[idx],
    }))

    paired.sort((a, b) => {
      const va = getCellValue(a.row, colIndex, column)
      const vb = getCellValue(b.row, colIndex, column)
      if (va === vb) return 0
      if (va === null || va === undefined) return 1
      if (vb === null || vb === undefined) return -1
      if (typeof va === 'number' && typeof vb === 'number') {
        return (va - vb) * factor
      }
      const na = Number(va)
      const nb = Number(vb)
      if (
        !Number.isNaN(na) &&
        !Number.isNaN(nb) &&
        String(va).trim() !== '' &&
        String(vb).trim() !== ''
      ) {
        return (na - nb) * factor
      }
      return (
        String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) *
        factor
      )
    })

    model.rows = paired.map((p) => p.row)
    this.rowStates = paired.map((p) => p.state)
    this.invalidateDataCache()
    this.invalidateFilterCache()
    this.selection.clear()
    this.selectedRowIndex = null
    this.selectedColIndex = null
    if (this.findQuery) {
      this.recomputeFindMatches()
      this.onFindStateChange?.({ total: this.findMatches.length, activeIndex: this.findActiveIndex })
    }
    this.renderHeader()
    this.renderVisibleRows()
    this.notifyAllSelectionListeners()
  }

  private isCellEditable(rowIndex: number, colIndex: number): boolean {
    if (this.interactionLocked || !this.model) return false
    if (rowIndex < 0 || rowIndex >= this.model.rows.length) return false
    if (colIndex < 0 || colIndex >= this.model.headers.length) return false
    const rowState = this.rowStates[rowIndex]
    if (!rowState || rowState.deleted) return false

    const colDef = this.model.columns[colIndex]
    if (colDef && 'isGenerated' in colDef && colDef.isGenerated === true) {
      return false
    }

    if (rowState.kind === 'inserted') {
      return this.model.canEdit
    }

    const gate = checkCellEditGate(this.model.canEdit, this.model.primaryKey)
    if (!gate.allowed) return false

    const header = this.model.headers[colIndex]
    const isPk = Boolean(
      (colDef && 'isPrimaryKey' in colDef && colDef.isPrimaryKey) ||
        this.model.primaryKey.includes(header)
    )
    return !isPk
  }

  private isColumnNullable(colIndex: number): boolean {
    const colDef = this.model?.columns[colIndex]
    return colDef && 'nullable' in colDef ? colDef.nullable !== false : true
  }

  private buildSelectedCellInfo(rowIndex: number, colIndex: number): SelectedCellInfo | null {
    const model = this.model
    if (
      !model ||
      rowIndex < 0 ||
      rowIndex >= model.rows.length ||
      colIndex < 0 ||
      colIndex >= model.headers.length
    ) {
      return null
    }
    const header = model.headers[colIndex]
    const colDef = model.columns[colIndex]
    const colType = colDef && 'type' in colDef ? colDef.type : undefined
    const state = this.rowStates[rowIndex]
    const isGenerated = Boolean(colDef && 'isGenerated' in colDef && colDef.isGenerated === true)
    const isPk = Boolean(
      (colDef && 'isPrimaryKey' in colDef && colDef.isPrimaryKey) ||
        model.primaryKey.includes(header)
    )
    const isNullable = colDef && 'nullable' in colDef ? colDef.nullable !== false : true

    return {
      rowIndex,
      colIndex,
      columnName: header,
      value: getCellValue(model.rows[rowIndex], colIndex, header),
      columnType: colType,
      isEditable: this.isCellEditable(rowIndex, colIndex),
      isInserted: state?.kind === 'inserted',
      isDeleted: Boolean(state?.deleted),
      isNullable,
      isPrimaryKey: isPk,
      isGenerated,
    }
  }

  private syncSelectedModelCoordsFromSelection(): void {
    const model = this.model
    const focus = this.selection.getFocus()
    if (!model || !focus) {
      this.selectedRowIndex = null
      this.selectedColIndex = null
      return
    }
    const visibleRows = this.getFilteredRowIndices()
    const visibleCols = this.getVisibleColumnIndices()
    const rIdx = visibleRows[focus.row]
    const cIdx = visibleCols[focus.col]
    this.selectedRowIndex = rIdx !== undefined ? rIdx : null
    this.selectedColIndex = cIdx !== undefined ? cIdx : null
  }

  private notifyAllSelectionListeners(): void {
    this.syncSelectedModelCoordsFromSelection()
    if (this.selectedRowIndex === null || this.selectedColIndex === null) {
      this.onSelectCell?.(null)
    } else {
      this.onSelectCell?.(this.buildSelectedCellInfo(this.selectedRowIndex, this.selectedColIndex))
    }
    this.onSelectionChange?.(this.getSelectionSummary())
  }

  private selectSingleModelCell(rowIndex: number, colIndex: number): void {
    const visibleRows = this.getFilteredRowIndices()
    const visibleCols = this.getVisibleColumnIndices()
    const vr = visibleRows.indexOf(rowIndex)
    const vc = visibleCols.indexOf(colIndex)
    if (vr >= 0 && vc >= 0) {
      this.selection.selectCell(vr, vc, 'cell')
    } else {
      this.selection.clear()
    }
    this.selectedRowIndex = rowIndex
    this.selectedColIndex = colIndex
    this.syncSelectionClasses()
    this.notifyAllSelectionListeners()
  }

  /**
   * Patches selection CSS classes in-place across visible DOM nodes without rebuilding tbody.
   */
  private syncSelectionClasses(): void {
    const state = this.selection.getState()
    const focus = state.focus
    this.syncSelectedModelCoordsFromSelection()

    if (this.theadEl && !this.isTransposed) {
      const ths = this.theadEl.querySelectorAll('th[data-vis-col]')
      ths.forEach((th) => {
        if (!(th instanceof HTMLElement)) return
        const vc = parseOptionalInt(th.dataset.visCol)
        if (vc === null) return
        th.classList.toggle('datanoa-th-selected', this.selection.isColSelected(vc))
      })
    }

    if (!this.tbodyEl) return

    if (this.isTransposed) {
      const cells = this.tbodyEl.querySelectorAll('td[data-row-index][data-col-index]')
      cells.forEach((cell) => {
        if (!(cell instanceof HTMLElement)) return
        const r = parseOptionalInt(cell.dataset.rowIndex)
        const c = parseOptionalInt(cell.dataset.colIndex)
        const isFocus = r === this.selectedRowIndex && c === this.selectedColIndex
        cell.classList.toggle('datanoa-cell-selected', isFocus)
      })
      return
    }

    const rows = this.tbodyEl.querySelectorAll('tr[data-vis-row]')
    rows.forEach((tr) => {
      if (!(tr instanceof HTMLElement)) return
      const vr = parseOptionalInt(tr.dataset.visRow)
      if (vr === null) return
      const rowSelected = this.selection.isRowSelected(vr)
      tr.classList.toggle('datanoa-row-selected', rowSelected)

      const rowNumTd = tr.querySelector('td.datanoa-td-rownum')
      if (rowNumTd instanceof HTMLElement) {
        rowNumTd.classList.toggle('row-selected', rowSelected)
      }

      const cells = tr.querySelectorAll('td[data-vis-col]')
      cells.forEach((td) => {
        if (!(td instanceof HTMLElement)) return
        const vc = parseOptionalInt(td.dataset.visCol)
        if (vc === null) return
        const inRange = this.selection.isSelected(vr, vc)
        const isFocus = focus !== null && focus.row === vr && focus.col === vc

        td.classList.toggle('datanoa-cell-selected', isFocus)
        td.classList.toggle('datanoa-cell-in-range', inRange)

        if (inRange) {
          const edges = this.selection.getCellSelectionEdges(vr, vc)
          td.classList.toggle('datanoa-range-top', edges.top)
          td.classList.toggle('datanoa-range-right', edges.right)
          td.classList.toggle('datanoa-range-bottom', edges.bottom)
          td.classList.toggle('datanoa-range-left', edges.left)
        } else {
          td.classList.remove(
            'datanoa-range-top',
            'datanoa-range-right',
            'datanoa-range-bottom',
            'datanoa-range-left'
          )
        }
      })
    })
  }

  private markHandledMouseDownClick(): void {
    this.handledMouseDownClick = true
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      this.handledMouseDownClick = false
    }, 0)
    this.timers.add(timer)
  }

  private handleTbodyMouseDown(e: MouseEvent): void {
    if (e.button !== 0 || this.isLoading || !this.model) return
    if (isEditableInputTarget(e.target)) return

    const fkBadge = findClosestFkBadge(e.target)
    if (fkBadge) {
      const parentTd = findClosestTableCell(fkBadge)
      const rIdx = parseOptionalInt(parentTd?.dataset.rowIndex)
      const cIdx = parseOptionalInt(parentTd?.dataset.colIndex)
      if (rIdx !== null && cIdx !== null) {
        e.preventDefault()
        e.stopPropagation()
        this.markHandledMouseDownClick()
        this.triggerFkJump(rIdx, cIdx)
      }
      return
    }

    const td = findClosestTableCell(e.target)
    if (!td) return

    const visibleRows = this.getFilteredRowIndices()
    const visibleCols = this.getVisibleColumnIndices()

    if (td.classList.contains('datanoa-td-rownum')) {
      const vr = parseOptionalInt(td.dataset.visRow)
      if (vr === null) return
      e.preventDefault()
      this.focusGridContainer()
      this.selection.selectRow(vr, visibleCols.length, {
        shift: e.shiftKey,
        toggle: e.ctrlKey || e.metaKey,
      })
      this.syncSelectionClasses()
      this.notifyAllSelectionListeners()
      this.markHandledMouseDownClick()
      if (!e.ctrlKey && !e.metaKey) {
        this.startDragSelection('row', e.clientX, e.clientY)
      }
      return
    }

    const rIdx = parseOptionalInt(td.dataset.rowIndex)
    const cIdx = parseOptionalInt(td.dataset.colIndex)
    if (rIdx === null || cIdx === null) return

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && this.canJumpForeignKey(rIdx, cIdx)) {
      e.preventDefault()
      this.markHandledMouseDownClick()
      this.triggerFkJump(rIdx, cIdx)
      return
    }

    this.focusGridContainer()

    if (this.isTransposed) {
      this.selectSingleModelCell(rIdx, cIdx)
      this.markHandledMouseDownClick()
      return
    }

    const vr = parseOptionalInt(td.dataset.visRow) ?? visibleRows.indexOf(rIdx)
    const vc = parseOptionalInt(td.dataset.visCol) ?? visibleCols.indexOf(cIdx)
    if (vr < 0 || vc < 0) return

    if (e.shiftKey) {
      this.selection.extendTo(vr, vc, 'cell')
    } else if (e.ctrlKey || e.metaKey) {
      this.selection.toggleCell(vr, vc)
    } else {
      this.selection.selectCell(vr, vc, 'cell')
    }

    this.syncSelectionClasses()
    this.notifyAllSelectionListeners()
    this.markHandledMouseDownClick()

    if (!e.ctrlKey && !e.metaKey) {
      this.startDragSelection('cell', e.clientX, e.clientY)
    }
  }

  private handleTbodyClick(e: MouseEvent): void {
    if (this.isLoading || !this.model) return
    if (isEditableInputTarget(e.target)) return

    const fkBadge = findClosestFkBadge(e.target)
    if (fkBadge) {
      if (this.handledMouseDownClick) {
        this.handledMouseDownClick = false
        return
      }
      const parentTd = findClosestTableCell(fkBadge)
      const rIdx = parseOptionalInt(parentTd?.dataset.rowIndex)
      const cIdx = parseOptionalInt(parentTd?.dataset.colIndex)
      if (rIdx !== null && cIdx !== null) {
        e.stopPropagation()
        this.triggerFkJump(rIdx, cIdx)
      }
      return
    }

    if (this.handledMouseDownClick) {
      this.handledMouseDownClick = false
      return
    }

    const td = findClosestTableCell(e.target)
    if (!td) return

    const visibleRows = this.getFilteredRowIndices()
    const visibleCols = this.getVisibleColumnIndices()

    if (td.classList.contains('datanoa-td-rownum')) {
      const vr = parseOptionalInt(td.dataset.visRow)
      if (vr === null) return
      this.focusGridContainer()
      this.selection.selectRow(vr, visibleCols.length, {
        shift: e.shiftKey,
        toggle: e.ctrlKey || e.metaKey,
      })
      this.syncSelectionClasses()
      this.notifyAllSelectionListeners()
      return
    }

    const rIdx = parseOptionalInt(td.dataset.rowIndex)
    const cIdx = parseOptionalInt(td.dataset.colIndex)
    if (rIdx === null || cIdx === null) return

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && this.canJumpForeignKey(rIdx, cIdx)) {
      this.triggerFkJump(rIdx, cIdx)
      return
    }

    this.focusGridContainer()

    if (this.isTransposed) {
      this.selectSingleModelCell(rIdx, cIdx)
      return
    }

    const vr = parseOptionalInt(td.dataset.visRow) ?? visibleRows.indexOf(rIdx)
    const vc = parseOptionalInt(td.dataset.visCol) ?? visibleCols.indexOf(cIdx)
    if (vr < 0 || vc < 0) return

    if (e.shiftKey) {
      this.selection.extendTo(vr, vc, 'cell')
    } else if (e.ctrlKey || e.metaKey) {
      this.selection.toggleCell(vr, vc)
    } else {
      this.selection.selectCell(vr, vc, 'cell')
    }

    this.syncSelectionClasses()
    this.notifyAllSelectionListeners()
  }

  private handleTbodyDblClick(e: MouseEvent): void {
    if (this.isLoading || this.interactionLocked || !this.model) return
    if (isEditableInputTarget(e.target) || findClosestFkBadge(e.target)) return

    const td = findClosestTableCell(e.target)
    if (!td || td.classList.contains('datanoa-td-rownum')) return

    const rIdx = parseOptionalInt(td.dataset.rowIndex)
    const cIdx = parseOptionalInt(td.dataset.colIndex)
    if (rIdx === null || cIdx === null) return
    const header = this.model.headers[cIdx]
    const row = this.model.rows[rIdx]
    if (!header || row === undefined) return

    const currentVal = getCellValue(row, cIdx, header)
    this.activateInlineEditor(rIdx, cIdx, header, currentVal, td)
  }

  private handleTbodyContextMenu(e: MouseEvent): void {
    if (this.isLoading || !this.model) return
    const td = findClosestTableCell(e.target)
    if (!td) return

    e.preventDefault()

    const visibleRows = this.getFilteredRowIndices()
    const visibleCols = this.getVisibleColumnIndices()

    if (td.classList.contains('datanoa-td-rownum')) {
      const vr = parseOptionalInt(td.dataset.visRow)
      const rIdx = parseOptionalInt(td.dataset.rowIndex)
      if (vr === null || rIdx === null || visibleCols.length === 0) return
      if (!this.selection.isRowSelected(vr)) {
        this.selection.selectRow(vr, visibleCols.length)
        this.syncSelectionClasses()
        this.notifyAllSelectionListeners()
      }
      const firstColIdx = visibleCols[0]
      const header = this.model.headers[firstColIdx]
      const val = getCellValue(this.model.rows[rIdx], firstColIdx, header)
      this.openContextMenu(e.clientX, e.clientY, rIdx, firstColIdx, header, val, td)
      return
    }

    const rIdx = parseOptionalInt(td.dataset.rowIndex)
    const cIdx = parseOptionalInt(td.dataset.colIndex)
    if (rIdx === null || cIdx === null) return
    const header = this.model.headers[cIdx]
    const row = this.model.rows[rIdx]
    if (!header || row === undefined) return

    if (!this.isTransposed) {
      const vr = parseOptionalInt(td.dataset.visRow) ?? visibleRows.indexOf(rIdx)
      const vc = parseOptionalInt(td.dataset.visCol) ?? visibleCols.indexOf(cIdx)
      // Right-clicking inside existing multi-selection preserves it; outside collapses to that cell
      if (vr >= 0 && vc >= 0 && !this.selection.isSelected(vr, vc)) {
        this.selection.selectCell(vr, vc, 'cell')
        this.syncSelectionClasses()
        this.notifyAllSelectionListeners()
      }
    } else {
      this.selectSingleModelCell(rIdx, cIdx)
    }

    const currentVal = getCellValue(row, cIdx, header)
    this.openContextMenu(e.clientX, e.clientY, rIdx, cIdx, header, currentVal, td)
  }

  private resolvePointToVisibleCoords(
    mode: 'cell' | 'row',
    target: EventTarget | null,
    x: number,
    y: number
  ): { vr: number; vc: number | null } | null {
    const tbody = this.tbodyEl
    const container = this.tableContainerEl
    if (!tbody || !container || !this.model) return null

    // 1. Direct target inside our tbody
    let td = findClosestTableCell(target)
    if (td && !tbody.contains(td)) {
      td = null
    }

    // 2. Clamp pointer strictly inside the scrollable data viewport (excluding header & sticky gutter)
    const rect = container.getBoundingClientRect?.()
    const headerH = this.theadEl?.getBoundingClientRect?.().height || this.theadEl?.offsetHeight || 26
    const stickyW = this.getStickyColumnsWidth()
    let clampedX = x
    let clampedY = y
    if (rect && rect.width > 0 && rect.height > 0) {
      const dataLeft =
        mode === 'row'
          ? rect.left + 2
          : Math.min(rect.right - 2, rect.left + Math.min(stickyW, Math.max(0, rect.width - 16)) + 2)
      const dataRight = Math.max(dataLeft, rect.right - 2)
      const dataTop = Math.min(rect.bottom - 2, rect.top + headerH + 2)
      const dataBottom = Math.max(dataTop, rect.bottom - 2)
      clampedX = Math.max(dataLeft, Math.min(dataRight, x))
      clampedY = Math.max(dataTop, Math.min(dataBottom, y))
    }

    if (!td && typeof document !== 'undefined' && typeof document.elementFromPoint === 'function') {
      const under = document.elementFromPoint(clampedX, clampedY)
      const hitTd = findClosestTableCell(under)
      if (hitTd && tbody.contains(hitTd)) {
        td = hitTd
      }
    }

    const visibleRows = this.getFilteredRowIndices()
    const visibleCols = this.getVisibleColumnIndices()
    if (visibleRows.length === 0 || visibleCols.length === 0) return null

    if (td) {
      const vr = parseOptionalInt(td.dataset.visRow)
      if (vr !== null) {
        if (mode === 'row') {
          return { vr, vc: null }
        }
        const vc = parseOptionalInt(td.dataset.visCol)
        if (vc !== null) {
          return { vr, vc }
        }
      }
    }

    // 3. Mathematical fallback from clamped viewport coordinates + scroll offsets
    if (!rect || rect.width <= 0 || rect.height <= 0) return null
    const relY = Math.max(0, clampedY - (rect.top + headerH))
    const vr = Math.max(
      0,
      Math.min(visibleRows.length - 1, Math.floor((container.scrollTop + relY) / ROW_HEIGHT_PX))
    )
    if (mode === 'row') {
      return { vr, vc: null }
    }

    const pinnedCount = this.getPinnedVisibleCount(visibleCols)
    const relXFromLeft = clampedX - rect.left
    let accPinned = this.rowNumWidth
    for (let i = 0; i < pinnedCount; i++) {
      const w = this.columnWidths[visibleCols[i]] ?? 120
      if (relXFromLeft < accPinned + w) {
        return { vr, vc: i }
      }
      accPinned += w
    }

    const contentX = container.scrollLeft + relXFromLeft - this.rowNumWidth
    let accCol = 0
    for (let i = 0; i < visibleCols.length; i++) {
      const w = this.columnWidths[visibleCols[i]] ?? 120
      if (contentX < accCol + w || i === visibleCols.length - 1) {
        return { vr, vc: i }
      }
      accCol += w
    }
    return { vr, vc: visibleCols.length - 1 }
  }

  private startDragSelection(mode: 'cell' | 'row', clientX: number, clientY: number): void {
    this.cleanupDragSelection()
    if (typeof window === 'undefined') return

    const initialFocus = this.selection.getFocus()

    const scheduleDeferredSummary = (): void => {
      if (!this.dragState) return
      this.dragState.summaryDirty = true
      if (typeof requestAnimationFrame !== 'function') {
        this.dragState.summaryDirty = false
        this.notifyAllSelectionListeners()
        return
      }
      if (this.dragState.summaryRafId !== null) return
      this.dragState.summaryRafId = requestAnimationFrame(() => {
        if (!this.dragState) return
        this.dragState.summaryRafId = null
        if (this.dragState.summaryDirty) {
          this.dragState.summaryDirty = false
          this.notifyAllSelectionListeners()
        }
      })
    }

    const extendFromTargetOrPoint = (target: EventTarget | null, x: number, y: number): void => {
      if (!this.dragState) return
      const resolved = this.resolvePointToVisibleCoords(mode, target, x, y)
      if (!resolved) return

      const { vr, vc } = resolved
      if (mode === 'row') {
        if (vr === this.dragState.lastRow) return
        this.dragState.lastRow = vr
        const visibleCols = this.getVisibleColumnIndices()
        this.selection.selectRow(vr, visibleCols.length, { shift: true })
        this.syncSelectionClasses()
        scheduleDeferredSummary()
        return
      }

      if (vc === null) return
      if (vr === this.dragState.lastRow && vc === this.dragState.lastCol) return
      this.dragState.lastRow = vr
      this.dragState.lastCol = vc
      this.selection.extendTo(vr, vc, 'cell')
      this.syncSelectionClasses()
      scheduleDeferredSummary()
    }

    const scheduleAutoScroll = (): void => {
      if (!this.dragState || !this.tableContainerEl) return
      if (this.dragState.autoScrollRafId !== null || typeof requestAnimationFrame !== 'function') {
        return
      }
      const step = () => {
        if (!this.dragState || !this.tableContainerEl) return
        this.dragState.autoScrollRafId = null
        const rect = this.tableContainerEl.getBoundingClientRect()
        const headerH =
          this.theadEl?.getBoundingClientRect?.().height || this.theadEl?.offsetHeight || 26
        const stickyW = this.getStickyColumnsWidth()
        const topZone = rect.top + headerH + 20
        const bottomZone = rect.bottom - 24
        const leftZone = rect.left + Math.min(stickyW, Math.max(0, rect.width * 0.4)) + 20
        const rightZone = rect.right - 24

        let dy = 0
        let dx = 0
        if (this.dragState.lastClientY < topZone) dy = -16
        else if (this.dragState.lastClientY > bottomZone) dy = 16
        if (this.dragState.lastClientX < leftZone) dx = -24
        else if (this.dragState.lastClientX > rightZone) dx = 24

        if (dx !== 0 || dy !== 0) {
          const prevTop = this.tableContainerEl.scrollTop
          const prevLeft = this.tableContainerEl.scrollLeft
          this.tableContainerEl.scrollTop += dy
          this.tableContainerEl.scrollLeft += dx
          if (
            this.tableContainerEl.scrollTop !== prevTop ||
            this.tableContainerEl.scrollLeft !== prevLeft
          ) {
            if (this.tableContainerEl.scrollTop !== prevTop) {
              this.renderVisibleRows()
            }
            extendFromTargetOrPoint(null, this.dragState.lastClientX, this.dragState.lastClientY)
            this.dragState.autoScrollRafId = requestAnimationFrame(step)
          }
        }
      }
      this.dragState.autoScrollRafId = requestAnimationFrame(step)
    }

    const moveListener = (moveEvent: MouseEvent) => {
      if (!this.dragState) return
      this.dragState.lastClientX = moveEvent.clientX
      this.dragState.lastClientY = moveEvent.clientY
      extendFromTargetOrPoint(moveEvent.target, moveEvent.clientX, moveEvent.clientY)
      scheduleAutoScroll()
    }

    const upListener = () => {
      this.cleanupDragSelection()
    }

    const blurListener = () => {
      this.cleanupDragSelection()
    }

    this.dragState = {
      mode,
      lastClientX: clientX,
      lastClientY: clientY,
      lastRow: initialFocus ? initialFocus.row : null,
      lastCol: initialFocus ? initialFocus.col : null,
      autoScrollRafId: null,
      summaryRafId: null,
      summaryDirty: false,
      moveListener,
      upListener,
      blurListener,
    }
    window.addEventListener('mousemove', moveListener)
    window.addEventListener('mouseup', upListener)
    window.addEventListener('blur', blurListener)
  }

  private cleanupDragSelection(): void {
    if (!this.dragState) return
    const hadDirtySummary = this.dragState.summaryDirty
    if (this.dragState.autoScrollRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.dragState.autoScrollRafId)
    }
    if (this.dragState.summaryRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.dragState.summaryRafId)
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('mousemove', this.dragState.moveListener)
      window.removeEventListener('mouseup', this.dragState.upListener)
      window.removeEventListener('blur', this.dragState.blurListener)
    }
    this.dragState = null
    if (hadDirtySummary) {
      this.notifyAllSelectionListeners()
    }
  }

  private focusGridContainer(): void {
    if (!this.tableContainerEl) return
    try {
      this.tableContainerEl.focus({ preventScroll: true })
    } catch {
      this.tableContainerEl.focus()
    }
  }

  private handleGridKeyDown(e: KeyboardEvent): void {
    // Self-heal if active editor input was somehow detached from the DOM
    if (this.activeEditor !== null && !this.activeEditor.input.isConnected) {
      this.activeEditor = null
    }
    if (this.activeEditor !== null || isEditableInputTarget(e.target)) return
    if (!this.model || this.isLoading) return

    const visibleRows = this.getFilteredRowIndices()
    const visibleCols = this.getVisibleColumnIndices()
    const key = e.key
    const lowerKey = key.toLowerCase()
    const isMod = e.ctrlKey || e.metaKey

    if (key === 'Escape') {
      if (this.contextMenuEl || this.bulkFillPopoverEl) {
        this.closeContextMenu()
        this.closeBulkFillPopover()
      } else {
        this.clearSelection()
      }
      return
    }

    if (isMod && lowerKey === 'a') {
      e.preventDefault()
      this.selectAll()
      return
    }

    if (isMod && lowerKey === 'c') {
      e.preventDefault()
      const copied = this.copySelection('tsv')
      if (copied.length > 0) {
        this.onNotify?.('Copied selection to clipboard')
      }
      return
    }

    if (isMod && lowerKey === 'v') {
      if (e.shiftKey) {
        e.preventDefault()
        void this.triggerPasteAction(true)
        return
      }
      // Allow browser paste event to fire naturally onto tableContainerEl
      return
    }

    if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
      if (visibleRows.length === 0 || visibleCols.length === 0) return
      e.preventDefault()
      const dRow = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0
      const dCol = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0
      this.selection.moveFocus(dRow, dCol, visibleRows.length, visibleCols.length, e.shiftKey)
      this.ensureFocusCellVisible()
      this.syncSelectionClasses()
      this.notifyAllSelectionListeners()
      return
    }

    if (key === 'Delete' || key === 'Backspace') {
      if (this.interactionLocked) return
      e.preventDefault()
      if (!this.batchMode && this.getStagedCount() === 0) {
        const targets: Array<{ rowIndex: number; colIndex: number }> = []
        this.selection.forEachSelectedCell(visibleRows.length, visibleCols.length, (vr, vc) => {
          const rIdx = visibleRows[vr]
          const cIdx = visibleCols[vc]
          if (rIdx !== undefined && cIdx !== undefined) {
            targets.push({ rowIndex: rIdx, colIndex: cIdx })
          }
          if (targets.length > 1) return false
        })
        if (
          targets.length === 0 &&
          this.selectedRowIndex !== null &&
          this.selectedColIndex !== null
        ) {
          targets.push({ rowIndex: this.selectedRowIndex, colIndex: this.selectedColIndex })
        }
        if (targets.length === 1) {
          const { rowIndex, colIndex } = targets[0]
          const rowState = this.rowStates[rowIndex]
          if (rowState?.kind === 'existing' && this.isCellEditable(rowIndex, colIndex)) {
            const header = this.model.headers[colIndex]
            if (!this.isColumnNullable(colIndex)) {
              this.onNotify?.(`Column "${header}" is NOT NULL — cannot set NULL.`)
              return
            }
            const rawValue = getCellValue(this.model.rows[rowIndex], colIndex, header)
            const liveTd = this.findLiveCell(rowIndex, colIndex)
            void this.applyDirectCellValue(rowIndex, colIndex, header, null, rawValue, liveTd)
            return
          }
        }
      }
      const updated = this.bulkSetCellsValue(null)
      if (updated > 0) {
        this.onNotify?.(`Set ${updated} cell${updated === 1 ? '' : 's'} to NULL`)
      }
      return
    }

    if (key === 'Enter' || key === 'F2') {
      if (
        this.interactionLocked ||
        this.selectedRowIndex === null ||
        this.selectedColIndex === null ||
        !this.isCellEditable(this.selectedRowIndex, this.selectedColIndex)
      ) {
        return
      }
      const td = this.tbodyEl?.querySelector(
        `td[data-row-index="${this.selectedRowIndex}"][data-col-index="${this.selectedColIndex}"]`
      )
      if (td instanceof HTMLTableCellElement) {
        e.preventDefault()
        const header = this.model.headers[this.selectedColIndex]
        const raw = getCellValue(this.model.rows[this.selectedRowIndex], this.selectedColIndex, header)
        this.activateInlineEditor(this.selectedRowIndex, this.selectedColIndex, header, raw, td)
      }
    }
  }

  private ensureFocusCellVisible(): void {
    const focus = this.selection.getFocus()
    if (!focus || !this.tableContainerEl || !this.tbodyEl || this.isTransposed) return
    let td = this.tbodyEl.querySelector(
      `td[data-vis-row="${focus.row}"][data-vis-col="${focus.col}"]`
    )
    if (!td) {
      const clientHeight = this.tableContainerEl.clientHeight || 440
      const targetTop = Math.max(0, focus.row * ROW_HEIGHT_PX - Math.floor(clientHeight / 2))
      this.tableContainerEl.scrollTop = targetTop
      this.renderVisibleRows()
      td = this.tbodyEl.querySelector(
        `td[data-vis-row="${focus.row}"][data-vis-col="${focus.col}"]`
      )
    }
    if (td instanceof HTMLElement) {
      this.scrollCellIntoViewAccountingForSticky(td, focus.col)
    }
  }

  private handleGridPaste(e: ClipboardEvent): void {
    if (this.activeEditor !== null || isEditableInputTarget(e.target)) return
    if (this.interactionLocked || !this.model || !this.model.canEdit) return
    const text = e.clipboardData?.getData('text/plain') || e.clipboardData?.getData('text') || ''
    if (!text) return
    e.preventDefault()
    const count = this.pasteDelimitedText(text)
    if (count > 0) {
      this.onNotify?.(`Pasted ${count} cell${count === 1 ? '' : 's'}`)
    }
  }

  private createResizeHandle(colIndex: number, thEl: HTMLTableCellElement): HTMLDivElement {
    const resizeHandle = document.createElement('div')
    resizeHandle.className = 'datanoa-resize-handle'
    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.startColumnResize(e, colIndex, thEl, resizeHandle)
    })
    resizeHandle.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    resizeHandle.addEventListener('dblclick', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.autoFitColumn(colIndex, thEl)
    })
    return resizeHandle
  }

  private clearColgroup(): void {
    if (this.colgroupEl) {
      this.colgroupEl.innerHTML = ''
    }
    this.rowNumColEl = null
    this.dataColElByModelIdx.clear()
    this.headerThByModelIdx.clear()
    if (this.tableEl) {
      this.tableEl.style.width = ''
    }
  }

  private renderHeader(): void {
    this.cleanupColumnResize()
    if (!this.theadEl) return
    this.theadEl.innerHTML = ''
    this.headerThByModelIdx.clear()

    if (this.isLoading) {
      this.clearColgroup()
      const tr = document.createElement('tr')
      const thIdx = document.createElement('th')
      thIdx.className = 'datanoa-th datanoa-th-rownum'
      thIdx.style.width = '44px'
      thIdx.textContent = '#'
      tr.appendChild(thIdx)
      for (let c = 0; c < 4; c++) {
        const th = document.createElement('th')
        th.className = 'datanoa-th'
        const bar = document.createElement('div')
        bar.className = 'datanoa-skeleton-bar'
        bar.style.width = `${72 + c * 18}px`
        th.appendChild(bar)
        tr.appendChild(th)
      }
      this.theadEl.appendChild(tr)
      return
    }

    const model = this.model
    if (!model) return

    const tr = document.createElement('tr')

    if (this.isTransposed) {
      this.clearColgroup()
      const thField = document.createElement('th')
      thField.className = 'datanoa-th datanoa-th-row-label'
      thField.textContent = 'Field'
      tr.appendChild(thField)

      const indices = this.getFilteredRowIndices()
      for (const rowIdx of indices) {
        const state = this.rowStates[rowIdx]
        const th = document.createElement('th')
        th.className = 'datanoa-th'
        th.style.minWidth = '140px'
        const suffix =
          state?.kind === 'inserted' ? ' (+)' : state?.deleted ? ' (DEL)' : ''
        th.textContent = `Row ${rowIdx + 1}${suffix}`
        tr.appendChild(th)
      }
      this.theadEl.appendChild(tr)
      return
    }

    if (model.headers.length === 0) {
      this.clearColgroup()
      this.theadEl.appendChild(tr)
      return
    }

    const visibleCols = this.getVisibleColumnIndices()
    const pinnedCount = this.getPinnedVisibleCount(visibleCols)
    const pinnedOffsets = this.computePinnedLeftOffsets(visibleCols, pinnedCount)

    const colgroup = this.colgroupEl
    this.dataColElByModelIdx.clear()
    if (colgroup) {
      colgroup.innerHTML = ''
      const idxCol = document.createElement('col')
      idxCol.className = 'datanoa-col-rownum'
      idxCol.style.width = `${this.rowNumWidth}px`
      colgroup.appendChild(idxCol)
      this.rowNumColEl = idxCol

      for (const modelColIdx of visibleCols) {
        const col = document.createElement('col')
        col.style.width = `${this.columnWidths[modelColIdx] ?? 120}px`
        colgroup.appendChild(col)
        this.dataColElByModelIdx.set(modelColIdx, col)
      }
    }

    // Standard mode: sticky corner `#` gutter (click selects all)
    const thIdx = document.createElement('th')
    thIdx.className = 'datanoa-th datanoa-th-rownum'
    thIdx.style.width = `${this.rowNumWidth}px`
    thIdx.title = 'Click to select all visible cells (Ctrl+A)'
    const idxInner = document.createElement('div')
    idxInner.className = 'datanoa-th-inner'
    const idxLabel = document.createElement('span')
    idxLabel.className = 'datanoa-th-label'
    idxLabel.textContent = '#'
    idxInner.appendChild(idxLabel)
    thIdx.appendChild(idxInner)
    thIdx.appendChild(this.createResizeHandle(-1, thIdx))
    thIdx.addEventListener('click', () => {
      if (Date.now() < this.suppressSortClickUntil) return
      this.focusGridContainer()
      this.selectAll()
    })
    tr.appendChild(thIdx)

    visibleCols.forEach((modelColIdx, visCol) => {
      const header = model.headers[modelColIdx]
      const th = document.createElement('th')
      const isSorted = this.sortColumn === header
      const isPinned = visCol < pinnedCount
      const isLastPinned = isPinned && visCol === pinnedCount - 1
      const isSelectedCol = this.selection.isColSelected(visCol)

      th.className = 'datanoa-th'
      if (isSorted) th.classList.add('sorted')
      if (isSelectedCol) th.classList.add('datanoa-th-selected')
      if (isPinned) {
        th.classList.add('datanoa-col-pinned')
        th.style.left = `${pinnedOffsets[visCol]}px`
      }
      if (isLastPinned) {
        th.classList.add('datanoa-col-pinned-last')
      }
      th.style.width = `${this.columnWidths[modelColIdx] ?? 120}px`
      th.dataset.visCol = String(visCol)
      th.dataset.colIndex = String(modelColIdx)

      const inner = document.createElement('div')
      inner.className = 'datanoa-th-inner'

      if (isPinned) {
        const pinIcon = document.createElement('span')
        pinIcon.className = 'datanoa-th-pin-icon'
        pinIcon.title = 'Pinned column'
        pinIcon.appendChild(createPinSvg())
        inner.appendChild(pinIcon)
      }

      const label = document.createElement('span')
      label.className = 'datanoa-th-label'
      label.textContent = header
      label.title = header
      inner.appendChild(label)

      const colSelectBtn = document.createElement('button')
      colSelectBtn.type = 'button'
      colSelectBtn.className = 'datanoa-col-select-btn'
      colSelectBtn.title = `Select column "${header}"`
      colSelectBtn.setAttribute('aria-label', `Select column ${header}`)
      colSelectBtn.appendChild(createColSelectSvg())
      colSelectBtn.addEventListener('mousedown', (e) => {
        e.stopPropagation()
      })
      colSelectBtn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.focusGridContainer()
        const rowCount = this.getFilteredRowIndices().length
        this.selection.selectColumn(visCol, rowCount, {
          shift: e.shiftKey,
          toggle: e.ctrlKey || e.metaKey,
        })
        this.syncSelectionClasses()
        this.notifyAllSelectionListeners()
      })
      inner.appendChild(colSelectBtn)

      if (isSorted) {
        const sortIcon = document.createElement('span')
        sortIcon.className = 'datanoa-th-sort-icon'
        sortIcon.appendChild(createSortArrowSvg(this.sortDirection === 'DESC' ? 'DESC' : 'ASC'))
        inner.appendChild(sortIcon)
      }

      th.appendChild(inner)
      th.appendChild(this.createResizeHandle(modelColIdx, th))

      th.addEventListener('click', (e) => {
        if (Date.now() < this.suppressSortClickUntil) return
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          e.preventDefault()
          this.focusGridContainer()
          const rowCount = this.getFilteredRowIndices().length
          this.selection.selectColumn(visCol, rowCount, {
            shift: e.shiftKey,
            toggle: e.ctrlKey || e.metaKey,
          })
          this.syncSelectionClasses()
          this.notifyAllSelectionListeners()
          return
        }
        this.handleHeaderClick(header)
      })

      th.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        this.openHeaderContextMenu(e.clientX, e.clientY, modelColIdx, visCol, header, th)
      })

      this.headerThByModelIdx.set(modelColIdx, th)
      tr.appendChild(th)
    })

    this.theadEl.appendChild(tr)
    this.updateTableWidthOnly()
  }

  private handleHeaderClick(header: string, forcedDirection?: 'ASC' | 'DESC'): void {
    if (forcedDirection) {
      this.sortColumn = header
      this.sortDirection = forcedDirection
    } else if (this.sortColumn === header) {
      this.sortDirection = this.sortDirection === 'ASC' ? 'DESC' : 'ASC'
    } else {
      this.sortColumn = header
      this.sortDirection = 'ASC'
    }

    this.renderHeader()
    if (this.onSort) {
      this.onSort(this.sortColumn, this.sortDirection)
    }
  }

  private cleanupColumnResize(): void {
    if (this.resizeRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.resizeRafId)
      this.resizeRafId = null
    }
    if (this.resizeListeners && typeof window !== 'undefined') {
      window.removeEventListener('mousemove', this.resizeListeners.move)
      window.removeEventListener('mouseup', this.resizeListeners.up)
      window.removeEventListener('blur', this.resizeListeners.blur)
    }
    this.resizeListeners = null
    if (this.activeResizeHandle) {
      this.activeResizeHandle.classList.remove('resizing')
      this.activeResizeHandle = null
    }
    if (typeof document !== 'undefined' && document.body) {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }

  private autoFitColumn(colIndex: number, thEl: HTMLTableCellElement): void {
    const model = this.model
    if (!model) return
    const colEl =
      colIndex === -1 ? this.rowNumColEl : (this.dataColElByModelIdx.get(colIndex) ?? null)

    let fittedWidth: number
    if (colIndex === -1) {
      const maxDigits = Math.max(1, String(model.rows.length).length + 1)
      fittedWidth = Math.max(44, Math.min(480, Math.round(maxDigits * 7.5 + 24)))
      this.rowNumWidth = fittedWidth
    } else {
      const header = model.headers[colIndex]
      const colDef = model.columns[colIndex]
      const colType = colDef && 'type' in colDef ? colDef.type : undefined
      let maxChars = header.length + (this.sortColumn === header ? 3 : 1)

      for (let rowIdx = 0; rowIdx < model.rows.length; rowIdx++) {
        const state = this.rowStates[rowIdx]
        const raw = getCellValue(model.rows[rowIdx], colIndex, header)
        let text: string
        if (state?.kind === 'inserted' && raw === undefined && !state.dirtyCols.has(header)) {
          text = '(default)'
        } else {
          text = formatCellValue(raw, colType).text
        }
        const len = Math.min(text.length, 80)
        if (len > maxChars) {
          maxChars = len
        }
      }
      fittedWidth = Math.max(64, Math.min(480, Math.round(maxChars * 7.5 + 24)))
      this.columnWidths[colIndex] = fittedWidth
    }

    if (colEl) colEl.style.width = `${fittedWidth}px`
    thEl.style.width = `${fittedWidth}px`
    this.updateTableWidthOnly()
    this.updatePinnedOffsets()
    this.invalidateColLayoutCache()
    this.saveColumnWidthsToCache()
    this.suppressSortClickUntil = Date.now() + 250
  }

  private startColumnResize(
    e: MouseEvent,
    colIndex: number,
    thEl: HTMLTableCellElement,
    handleEl: HTMLDivElement
  ): void {
    this.cleanupColumnResize()

    const startX = e.clientX
    const startWidth =
      colIndex === -1
        ? this.rowNumWidth
        : this.columnWidths[colIndex] || thEl.offsetWidth || 150
    const minWidth = colIndex === -1 ? 36 : 50
    const colEl =
      colIndex === -1 ? this.rowNumColEl : (this.dataColElByModelIdx.get(colIndex) ?? null)
    let didMove = false

    // Cache pinned column cells once at drag start so rAF never runs querySelectorAll per frame
    const visibleCols = this.getVisibleColumnIndices()
    const pinnedCount = this.isTransposed ? 0 : this.getPinnedVisibleCount(visibleCols)
    const cachedPinnedThs: Array<HTMLTableCellElement | null> = []
    const cachedPinnedCells: HTMLElement[][] = []
    if (pinnedCount > 0) {
      for (let visCol = 0; visCol < pinnedCount; visCol++) {
        cachedPinnedThs.push(this.headerThByModelIdx.get(visibleCols[visCol]) ?? null)
        const cells: HTMLElement[] = []
        if (this.tbodyEl) {
          this.tbodyEl.querySelectorAll(`td[data-vis-col="${visCol}"]`).forEach((el) => {
            if (el instanceof HTMLElement) cells.push(el)
          })
        }
        cachedPinnedCells.push(cells)
      }
    }

    const useRafOnly =
      typeof requestAnimationFrame === 'function' && isNativeDomElement(thEl)

    this.activeResizeHandle = handleEl
    handleEl.classList.add('resizing')
    if (typeof document !== 'undefined' && document.body) {
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    }

    let pendingWidth = startWidth
    let lastAppliedWidth = startWidth

    const applyCachedPinnedOffsets = () => {
      if (pinnedCount === 0) return
      const offsets = this.computePinnedLeftOffsets(visibleCols, pinnedCount)
      for (let visCol = 0; visCol < pinnedCount; visCol++) {
        const leftPx = `${offsets[visCol]}px`
        const th = cachedPinnedThs[visCol]
        if (th) th.style.left = leftPx
        const cells = cachedPinnedCells[visCol]
        for (let i = 0; i < cells.length; i++) {
          cells[i].style.left = leftPx
        }
      }
    }

    const applyPendingResizeDom = () => {
      this.resizeRafId = null
      if (pendingWidth === lastAppliedWidth) return
      lastAppliedWidth = pendingWidth
      if (colEl) colEl.style.width = `${pendingWidth}px`
      thEl.style.width = `${pendingWidth}px`
      this.updateTableWidthOnly()
      applyCachedPinnedOffsets()
    }

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX
      if (Math.abs(delta) >= 2) {
        didMove = true
      }
      const newWidth = Math.max(minWidth, Math.round(startWidth + delta))
      if (newWidth === pendingWidth) return
      pendingWidth = newWidth
      if (colIndex === -1) {
        this.rowNumWidth = newWidth
      } else {
        this.columnWidths[colIndex] = newWidth
      }
      if (useRafOnly) {
        if (this.resizeRafId === null) {
          this.resizeRafId = requestAnimationFrame(applyPendingResizeDom)
        }
      } else {
        applyPendingResizeDom()
      }
    }

    const finishResize = () => {
      if (this.resizeRafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.resizeRafId)
        this.resizeRafId = null
      }
      if (pendingWidth !== lastAppliedWidth) {
        applyPendingResizeDom()
      }
      this.cleanupColumnResize()
      if (didMove) {
        this.invalidateColLayoutCache()
        this.suppressSortClickUntil = Date.now() + 250
      }
      this.saveColumnWidthsToCache()
    }

    this.resizeListeners = { move: onMouseMove, up: finishResize, blur: finishResize }
    if (typeof window !== 'undefined') {
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', finishResize)
      window.addEventListener('blur', finishResize)
    }
  }

  private renderEmptyStateRow(colSpan: number): void {
    if (!this.tbodyEl) return
    const emptyTr = document.createElement('tr')
    emptyTr.className = 'datanoa-grid-empty-row'
    const emptyTd = document.createElement('td')
    emptyTd.colSpan = Math.max(1, colSpan)
    emptyTd.className = 'datanoa-grid-empty-cell'
    emptyTd.textContent = this.clientFilter
      ? `No rows match "${this.clientFilter}".`
      : this.clientColumnFilters.length > 0
        ? 'No rows match active column filter.'
        : this.emptyMessage
    emptyTr.appendChild(emptyTd)
    this.tbodyEl.appendChild(emptyTr)
  }

  private ensureSpacerRows(): {
    topTr: HTMLTableRowElement
    topTd: HTMLTableCellElement
    bottomTr: HTMLTableRowElement
    bottomTd: HTMLTableCellElement
  } {
    if (!this.topSpacerTr || !this.topSpacerTd) {
      const tr = document.createElement('tr')
      const td = document.createElement('td')
      td.style.padding = '0'
      td.style.border = 'none'
      tr.appendChild(td)
      this.topSpacerTr = tr
      this.topSpacerTd = td
    }
    if (!this.bottomSpacerTr || !this.bottomSpacerTd) {
      const tr = document.createElement('tr')
      const td = document.createElement('td')
      td.style.padding = '0'
      td.style.border = 'none'
      tr.appendChild(td)
      this.bottomSpacerTr = tr
      this.bottomSpacerTd = td
    }
    return {
      topTr: this.topSpacerTr,
      topTd: this.topSpacerTd,
      bottomTr: this.bottomSpacerTr,
      bottomTd: this.bottomSpacerTd,
    }
  }

  private createPooledDataCell(): HTMLTableCellElement {
    const td = document.createElement('td')
    // Non-bubbling fallback ONLY in non-native test DOM (FakeDOM Gate C synthetic events);
    // real browsers run 100% through tbodyEl event delegation with 0 per-<td> listeners.
    if (!isNativeDomElement(td)) {
      td.addEventListener('click', this.nonBubblingCellClickHandler)
      td.addEventListener('dblclick', this.nonBubblingCellDblClickHandler)
    }
    return td
  }

  private acquirePooledRow(colCount: number): PooledGridRow {
    const existing = this.freeRowPool.pop()
    if (existing) {
      while (existing.dataCells.length < colCount) {
        const td = this.createPooledDataCell()
        existing.dataCells.push(td)
        existing.tr.appendChild(td)
      }
      while (existing.dataCells.length > colCount) {
        const removed = existing.dataCells.pop()
        removed?.remove()
      }
      return existing
    }

    const tr = document.createElement('tr')
    const rowNumTd = document.createElement('td')
    tr.appendChild(rowNumTd)
    const dataCells = new Array<HTMLTableCellElement>(colCount)
    for (let i = 0; i < colCount; i++) {
      const td = this.createPooledDataCell()
      dataCells[i] = td
      tr.appendChild(td)
    }
    return { tr, rowNumTd, dataCells }
  }

  private flushActiveEditorBeforeRebuild(): void {
    const ed = this.activeEditor
    if (!ed) return
    this.activeEditor = null
    ed.td.classList.remove('editing')

    const model = this.model
    if (!model || ed.rowIndex < 0 || ed.rowIndex >= model.rows.length) return
    const columnName = model.headers[ed.colIndex]
    if (!columnName) return
    const rowState = this.rowStates[ed.rowIndex]
    const rawNewValue = ed.input.value

    if (
      rowState?.kind === 'inserted' &&
      ed.originalValue === undefined &&
      !rowState.dirtyCols.has(columnName) &&
      rawNewValue === ''
    ) {
      return
    }
    if (ed.originalValue === null && rawNewValue === '' && !ed.userTyped) {
      return
    }

    const newValue = this.coerceEditedValue(rawNewValue, ed.originalValue, ed.colIndex)
    if (Object.is(newValue, ed.originalValue)) return

    if (this.batchMode || this.getStagedCount() > 0 || rowState?.kind === 'inserted') {
      if (this.stageCellValueInMemory(ed.rowIndex, ed.colIndex, newValue)) {
        this.invalidateDataCache()
        this.invalidateFilterCache()
        this.onStageChange?.(this.getStagedCount())
        this.notifyAllSelectionListeners()
      }
      return
    }

    void this.applyDirectCellValue(
      ed.rowIndex,
      ed.colIndex,
      columnName,
      newValue,
      ed.originalValue,
      ed.td
    )
  }

  private patchPooledRow(
    pooled: PooledGridRow,
    visRow: number,
    rowIndex: number,
    model: GridModel,
    visibleCols: number[],
    pinnedCount: number,
    pinnedOffsets: number[],
    focus: CellCoord | null,
    activeMatch: CellCoord | null
  ): void {
    const rowData = model.rows[rowIndex]
    const rowState = this.rowStates[rowIndex]
    const isRowSel = this.selection.isRowSelected(visRow)

    let trClass = visRow % 2 === 1 ? 'datanoa-tr datanoa-tr-even' : 'datanoa-tr'
    if (rowState?.kind === 'inserted') trClass += ' datanoa-row-inserted'
    if (rowState?.deleted) trClass += ' datanoa-row-deleted'
    if (isRowSel) trClass += ' datanoa-row-selected'

    const { tr, rowNumTd, dataCells } = pooled
    tr.className = trClass
    tr.dataset.rowIndex = String(rowIndex)
    tr.dataset.visRow = String(visRow)

    rowNumTd.className = isRowSel
      ? 'datanoa-td datanoa-td-rownum row-selected'
      : 'datanoa-td datanoa-td-rownum'
    rowNumTd.dataset.rowIndex = String(rowIndex)
    rowNumTd.dataset.visRow = String(visRow)
    if (rowState?.kind === 'inserted') {
      const badgeLabel =
        rowState.origin === 'clone'
          ? 'CLONE'
          : rowState.origin === 'paste'
            ? 'PASTE'
            : 'NEW'
      rowNumTd.title =
        rowState.origin === 'clone'
          ? `Cloned row #${rowIndex + 1} (staged INSERT — click Submit to save)`
          : rowState.origin === 'paste'
            ? `Pasted new row #${rowIndex + 1} (staged INSERT — click Submit to save)`
            : `New row #${rowIndex + 1} (staged INSERT — click Submit to save)`
      const existingBadge = rowNumTd.firstElementChild
      if (existingBadge instanceof HTMLElement && existingBadge.classList.contains('datanoa-row-badge')) {
        existingBadge.textContent = badgeLabel
      } else {
        rowNumTd.textContent = ''
        const badge = document.createElement('span')
        badge.className = 'datanoa-row-badge'
        badge.textContent = badgeLabel
        rowNumTd.appendChild(badge)
      }
    } else {
      if (rowNumTd.title) rowNumTd.removeAttribute('title')
      rowNumTd.textContent = rowState?.deleted ? `-${rowIndex + 1}` : String(rowIndex + 1)
    }

    const colCount = visibleCols.length
    for (let visCol = 0; visCol < colCount; visCol++) {
      const colIdx = visibleCols[visCol]
      const header = model.headers[colIdx]
      const td = dataCells[visCol]
      td.dataset.rowIndex = String(rowIndex)
      td.dataset.colIndex = String(colIdx)
      td.dataset.visRow = String(visRow)
      td.dataset.visCol = String(visCol)
      const rawValue = getCellValue(rowData, colIdx, header)
      this.applyCellDisplay(
        td,
        rowIndex,
        colIdx,
        visRow,
        visCol,
        header,
        rawValue,
        rowState,
        focus,
        activeMatch,
        visCol < pinnedCount ? pinnedOffsets[visCol] : null,
        visCol < pinnedCount && visCol === pinnedCount - 1
      )
    }
  }

  private renderVisibleRows(force = false): void {
    if (!this.tbodyEl || !this.tableContainerEl) return
    if (this.isLoading) {
      this.resetRowPoolMountState()
      if (this.tableEl) {
        this.tableEl.classList.remove('datanoa-grid-empty-table', 'datanoa-grid-empty-no-cols')
      }
      this.tbodyEl.innerHTML = ''
      const frag = document.createDocumentFragment()
      for (let r = 0; r < 8; r++) {
        const tr = document.createElement('tr')
        tr.className = r % 2 === 1 ? 'datanoa-tr datanoa-tr-even' : 'datanoa-tr'
        const tdIdx = document.createElement('td')
        tdIdx.className = 'datanoa-td datanoa-td-rownum'
        tdIdx.textContent = String(r + 1)
        tr.appendChild(tdIdx)
        for (let c = 0; c < 4; c++) {
          const td = document.createElement('td')
          td.className = 'datanoa-td datanoa-skeleton-cell'
          const bar = document.createElement('div')
          bar.className = 'datanoa-skeleton-bar'
          bar.style.width = `${55 + ((r * 17 + c * 23) % 38)}%`
          td.appendChild(bar)
          tr.appendChild(td)
        }
        frag.appendChild(tr)
      }
      this.tbodyEl.appendChild(frag)
      return
    }

    const model = this.model
    if (!model) {
      this.resetRowPoolMountState()
      if (this.tableEl) {
        this.tableEl.classList.add('datanoa-grid-empty-table', 'datanoa-grid-empty-no-cols')
        this.tableEl.style.width = '100%'
      }
      this.tbodyEl.innerHTML = ''
      this.renderEmptyStateRow(1)
      return
    }

    const indices = this.getFilteredRowIndices()

    if (this.isTransposed) {
      this.resetRowPoolMountState()
      if (this.tableEl) {
        this.tableEl.classList.remove('datanoa-grid-empty-table', 'datanoa-grid-empty-no-cols')
      }
      this.renderTransposedBody(indices)
      return
    }

    const visibleCols = this.getVisibleColumnIndices()
    const colSpan = Math.max(1, visibleCols.length + 1)

    if (indices.length === 0) {
      if (this.activeEditor) {
        this.flushActiveEditorBeforeRebuild()
      }
      this.resetRowPoolMountState()
      const noCols = model.headers.length === 0
      if (this.tableEl) {
        this.tableEl.classList.add('datanoa-grid-empty-table')
        this.tableEl.classList.toggle('datanoa-grid-empty-no-cols', noCols)
        if (noCols) {
          this.tableEl.style.width = '100%'
        }
      }
      this.tbodyEl.innerHTML = ''
      this.renderEmptyStateRow(colSpan)
      return
    }

    if (this.tableEl) {
      this.tableEl.classList.remove('datanoa-grid-empty-table', 'datanoa-grid-empty-no-cols')
    }

    const clientHeight = this.tableContainerEl.clientHeight || 440
    const totalVisibleRows = indices.length
    const headerH = this.theadEl?.offsetHeight || 28
    const bottomCushionPx = 28
    const maxScrollTop = Math.max(
      0,
      headerH + totalVisibleRows * ROW_HEIGHT_PX + bottomCushionPx - clientHeight
    )
    const rawScrollTop = this.tableContainerEl.scrollTop
    const scrollTop = Math.max(0, Math.min(rawScrollTop, maxScrollTop))
    if (maxScrollTop === 0 && rawScrollTop > 0) {
      this.tableContainerEl.scrollTop = 0
    } else if (rawScrollTop > maxScrollTop + ROW_HEIGHT_PX * 3) {
      this.tableContainerEl.scrollTop = maxScrollTop
    }
    this.lastScrollTop = this.tableContainerEl.scrollTop

    const { startIndex, endIndex } = calculateVisibleWindow(scrollTop, clientHeight)
    const boundedStart = Math.max(0, startIndex - 5)
    const boundedEnd = Math.min(totalVisibleRows, endIndex + 5)

    // Window cache hit: unchanged visible row window & data/filter/layout versions -> 0 DOM mutations
    const prevWin = this.lastRenderedWindow
    if (
      !force &&
      this.isPoolMountedInTbody &&
      prevWin !== null &&
      prevWin.boundedStart === boundedStart &&
      prevWin.boundedEnd === boundedEnd &&
      prevWin.dataVersion === this.dataVersion &&
      prevWin.filterVersion === this.filterVersion &&
      prevWin.colLayoutVersion === this.colLayoutVersion &&
      prevWin.totalRows === totalVisibleRows &&
      prevWin.colSpan === colSpan
    ) {
      return
    }

    const canSlide =
      !force &&
      this.isPoolMountedInTbody &&
      prevWin !== null &&
      prevWin.dataVersion === this.dataVersion &&
      prevWin.filterVersion === this.filterVersion &&
      prevWin.colLayoutVersion === this.colLayoutVersion &&
      prevWin.totalRows === totalVisibleRows &&
      prevWin.colSpan === colSpan

    // Protect open inline editor: keep intact if its row stays mounted in slide window,
    // otherwise commit cleanly before detaching/rebuilding so keyboard navigation never deadlocks.
    if (this.activeEditor !== null) {
      let keepEditorAlive = false
      if (canSlide) {
        const edVisRow = parseOptionalInt(this.activeEditor.td.dataset.visRow)
        if (
          edVisRow !== null &&
          edVisRow >= boundedStart &&
          edVisRow < boundedEnd &&
          this.mountedRowsByVisRow.has(edVisRow)
        ) {
          keepEditorAlive = true
        }
      }
      if (!keepEditorAlive) {
        this.flushActiveEditorBeforeRebuild()
      }
    }

    const pinnedCount = this.getPinnedVisibleCount(visibleCols)
    const pinnedOffsets = this.computePinnedLeftOffsets(visibleCols, pinnedCount)
    const focus = this.selection.getFocus()
    const activeMatch =
      this.findActiveIndex >= 0 ? (this.findMatches[this.findActiveIndex] ?? null) : null
    const { topTr, topTd, bottomTr, bottomTd } = this.ensureSpacerRows()
    const remainingRows = totalVisibleRows - boundedEnd

    bottomTd.colSpan = colSpan
    if (remainingRows > 0) {
      bottomTr.className = ''
      bottomTd.style.height = `${remainingRows * ROW_HEIGHT_PX + bottomCushionPx}px`
      bottomTd.style.pointerEvents = ''
    } else {
      bottomTr.className = 'datanoa-grid-bottom-cushion'
      bottomTd.style.height = `${bottomCushionPx}px`
      bottomTd.style.pointerEvents = 'none'
    }

    if (canSlide && prevWin) {
      // Incremental sliding-window update: recycle ONLY rows leaving [boundedStart, boundedEnd)
      for (const [vr, pooled] of Array.from(this.mountedRowsByVisRow.entries())) {
        if (vr < boundedStart || vr >= boundedEnd) {
          pooled.tr.remove()
          this.mountedRowsByVisRow.delete(vr)
          if (this.freeRowPool.length < 120) {
            this.freeRowPool.push(pooled)
          }
        }
      }

      if (boundedStart > 0) {
        topTd.colSpan = colSpan
        topTd.style.height = `${boundedStart * ROW_HEIGHT_PX}px`
        if (topTr.parentNode !== this.tbodyEl) {
          this.tbodyEl.insertBefore(topTr, this.tbodyEl.firstChild)
        }
      } else if (topTr.parentNode === this.tbodyEl) {
        topTr.remove()
      }

      if (bottomTr.parentNode !== this.tbodyEl) {
        this.tbodyEl.appendChild(bottomTr)
      }

      const overlapStart = Math.max(boundedStart, prevWin.boundedStart)
      const overlapEnd = Math.min(boundedEnd, prevWin.boundedEnd)
      const hasOverlap = overlapStart < overlapEnd && this.mountedRowsByVisRow.size > 0

      if (!hasOverlap) {
        // Fast jump scroll: reuse pooled rows in a single DocumentFragment
        const frag = document.createDocumentFragment()
        for (let visRow = boundedStart; visRow < boundedEnd; visRow++) {
          const pooled = this.acquirePooledRow(visibleCols.length)
          this.patchPooledRow(
            pooled,
            visRow,
            indices[visRow],
            model,
            visibleCols,
            pinnedCount,
            pinnedOffsets,
            focus,
            activeMatch
          )
          this.mountedRowsByVisRow.set(visRow, pooled)
          frag.appendChild(pooled.tr)
        }
        this.tbodyEl.insertBefore(frag, bottomTr)
      } else {
        // Prepend entering top rows in one DocumentFragment
        if (boundedStart < overlapStart) {
          const topFrag = document.createDocumentFragment()
          for (let visRow = boundedStart; visRow < overlapStart; visRow++) {
            const pooled = this.acquirePooledRow(visibleCols.length)
            this.patchPooledRow(
              pooled,
              visRow,
              indices[visRow],
              model,
              visibleCols,
              pinnedCount,
              pinnedOffsets,
              focus,
              activeMatch
            )
            this.mountedRowsByVisRow.set(visRow, pooled)
            topFrag.appendChild(pooled.tr)
          }
          const refNode =
            topTr.parentNode === this.tbodyEl ? topTr.nextSibling : this.tbodyEl.firstChild
          this.tbodyEl.insertBefore(topFrag, refNode)
        }

        // Append entering bottom rows in one DocumentFragment
        if (overlapEnd < boundedEnd) {
          const botFrag = document.createDocumentFragment()
          for (let visRow = overlapEnd; visRow < boundedEnd; visRow++) {
            const pooled = this.acquirePooledRow(visibleCols.length)
            this.patchPooledRow(
              pooled,
              visRow,
              indices[visRow],
              model,
              visibleCols,
              pinnedCount,
              pinnedOffsets,
              focus,
              activeMatch
            )
            this.mountedRowsByVisRow.set(visRow, pooled)
            botFrag.appendChild(pooled.tr)
          }
          this.tbodyEl.insertBefore(botFrag, bottomTr)
        }
      }
    } else {
      // Full pool mount via a single DocumentFragment
      for (const pooled of this.mountedRowsByVisRow.values()) {
        if (this.freeRowPool.length < 120) {
          this.freeRowPool.push(pooled)
        }
      }
      this.mountedRowsByVisRow.clear()
      this.tbodyEl.innerHTML = ''

      const frag = document.createDocumentFragment()
      if (boundedStart > 0) {
        topTd.colSpan = colSpan
        topTd.style.height = `${boundedStart * ROW_HEIGHT_PX}px`
        frag.appendChild(topTr)
      }

      for (let visRow = boundedStart; visRow < boundedEnd; visRow++) {
        const pooled = this.acquirePooledRow(visibleCols.length)
        this.patchPooledRow(
          pooled,
          visRow,
          indices[visRow],
          model,
          visibleCols,
          pinnedCount,
          pinnedOffsets,
          focus,
          activeMatch
        )
        this.mountedRowsByVisRow.set(visRow, pooled)
        frag.appendChild(pooled.tr)
      }

      frag.appendChild(bottomTr)
      this.tbodyEl.appendChild(frag)
      this.isPoolMountedInTbody = true
    }

    this.lastRenderedWindow = {
      boundedStart,
      boundedEnd,
      dataVersion: this.dataVersion,
      filterVersion: this.filterVersion,
      colLayoutVersion: this.colLayoutVersion,
      totalRows: totalVisibleRows,
      colSpan,
    }
  }

  private renderTransposedBody(indices: number[]): void {
    const tbody = this.tbodyEl
    const model = this.model
    if (!tbody || !model) return
    tbody.innerHTML = ''

    if (indices.length === 0) {
      this.renderEmptyStateRow(1)
      return
    }

    const frag = document.createDocumentFragment()
    const visibleCols = this.getVisibleColumnIndices()
    visibleCols.forEach((colIdx, visCol) => {
      const header = model.headers[colIdx]
      const tr = document.createElement('tr')
      tr.className = visCol % 2 === 1 ? 'datanoa-tr datanoa-tr-even' : 'datanoa-tr'

      const isPk = model.primaryKey.includes(header)
      const colDef = model.columns[colIdx]
      const colType = colDef && 'type' in colDef && colDef.type ? ` : ${colDef.type}` : ''

      const labelTd = document.createElement('td')
      labelTd.className = 'datanoa-td datanoa-th-row-label'
      labelTd.textContent = `${header}${isPk ? ' [PK]' : ''}${colType}`
      tr.appendChild(labelTd)

      indices.forEach((rowIndex, visRow) => {
        const rowData = model.rows[rowIndex]
        const rowState = this.rowStates[rowIndex]
        const td = this.createDataCell(
          rowIndex,
          colIdx,
          visRow,
          visCol,
          header,
          rowData,
          rowState,
          null,
          null,
          null,
          false
        )
        if (rowState?.kind === 'inserted') td.classList.add('datanoa-row-inserted')
        if (rowState?.deleted) td.classList.add('datanoa-row-deleted')
        tr.appendChild(td)
      })

      frag.appendChild(tr)
    })
    tbody.appendChild(frag)
  }

  private applyCellDisplay(
    td: HTMLTableCellElement,
    rowIndex: number,
    colIdx: number,
    visRow: number,
    visCol: number,
    header: string,
    rawValue: unknown,
    rowState: InternalRowState | undefined,
    focus: CellCoord | null,
    activeMatch: CellCoord | null,
    pinnedLeftPx: number | null,
    isLastPinned: boolean
  ): void {
    const colDef = this.model?.columns[colIdx]
    const colType = colDef && 'type' in colDef ? colDef.type : undefined
    const isAutoInc = Boolean(colDef && 'isAutoIncrement' in colDef && colDef.isAutoIncrement)
    const isGenerated = Boolean(colDef && 'isGenerated' in colDef && colDef.isGenerated === true)
    const hasDefault = Boolean(
      colDef &&
        'defaultValue' in colDef &&
        colDef.defaultValue !== null &&
        colDef.defaultValue !== undefined
    )

    let cls = 'datanoa-td'
    const isInsertedPlaceholder =
      rowState?.kind === 'inserted' && rawValue === undefined && !rowState.dirtyCols.has(header)

    if (isInsertedPlaceholder) {
      cls += ' datanoa-cell-null'
      td.textContent = isGenerated ? '(generated)' : isAutoInc ? '(auto)' : hasDefault ? '(default)' : '(auto)'
      if (isGenerated) {
        td.title = 'Generated column computed by database'
      } else if (isAutoInc) {
        td.title = 'Auto-increment generated by database'
      } else if (hasDefault && colDef && 'defaultValue' in colDef && colDef.defaultValue !== null) {
        td.title = `Database default: ${colDef.defaultValue}`
      } else if (td.title) {
        td.removeAttribute('title')
      }
    } else {
      const formatted = formatCellValue(rawValue, colType)
      cls += ` ${formatted.className}`
      if (td.title) td.removeAttribute('title')

      const fk = this.getForeignKeyForColumn(header)
      if (fk && rawValue !== null && rawValue !== undefined) {
        td.textContent = ''
        td.appendChild(document.createTextNode(formatted.text))
        cls += ' datanoa-td-has-fk'
        const fkBtn = document.createElement('button')
        fkBtn.type = 'button'
        fkBtn.className = 'datanoa-fk-badge'
        fkBtn.title = `Go to ${fk.referencedTable}.${fk.referencedColumn} = ${previewMenuValue(rawValue)} (Ctrl+Click)`
        fkBtn.setAttribute('aria-label', `Go to ${fk.referencedTable}.${fk.referencedColumn}`)
        fkBtn.appendChild(createFkJumpSvg())
        td.appendChild(fkBtn)
      } else {
        td.textContent = formatted.text
      }
    }

    if (rowState?.dirtyCols.has(header)) {
      cls += ' datanoa-cell-staged'
    }

    if (pinnedLeftPx !== null) {
      cls += isLastPinned ? ' datanoa-col-pinned datanoa-col-pinned-last' : ' datanoa-col-pinned'
      td.style.left = `${pinnedLeftPx}px`
    } else if (td.style.left) {
      td.style.left = ''
    }

    if (!this.isTransposed) {
      const inRange = this.selection.isSelected(visRow, visCol)
      const isFocus = focus !== null && focus.row === visRow && focus.col === visCol
      if (isFocus) cls += ' datanoa-cell-selected'
      if (inRange) {
        cls += ' datanoa-cell-in-range'
        const edges = this.selection.getCellSelectionEdges(visRow, visCol)
        if (edges.top) cls += ' datanoa-range-top'
        if (edges.right) cls += ' datanoa-range-right'
        if (edges.bottom) cls += ' datanoa-range-bottom'
        if (edges.left) cls += ' datanoa-range-left'
      }
      if (this.findMatchKeys.size > 0 && this.findMatchKeys.has(`${visRow}:${visCol}`)) {
        cls += ' datanoa-cell-match'
        if (activeMatch !== null && activeMatch.row === visRow && activeMatch.col === visCol) {
          cls += ' datanoa-cell-match-active'
        }
      }
    } else if (this.selectedRowIndex === rowIndex && this.selectedColIndex === colIdx) {
      cls += ' datanoa-cell-selected'
    }

    td.className = cls
  }

  private createDataCell(
    rowIndex: number,
    colIdx: number,
    visRow: number,
    visCol: number,
    header: string,
    rowData: Record<string, unknown> | unknown[],
    rowState: InternalRowState | undefined,
    focus: CellCoord | null,
    activeMatch: CellCoord | null,
    pinnedLeftPx: number | null,
    isLastPinned: boolean
  ): HTMLTableCellElement {
    const td = this.createPooledDataCell()
    td.dataset.rowIndex = String(rowIndex)
    td.dataset.colIndex = String(colIdx)
    td.dataset.visRow = String(visRow)
    td.dataset.visCol = String(visCol)

    const rawValue = getCellValue(rowData, colIdx, header)
    this.applyCellDisplay(
      td,
      rowIndex,
      colIdx,
      visRow,
      visCol,
      header,
      rawValue,
      rowState,
      focus,
      activeMatch,
      pinnedLeftPx,
      isLastPinned
    )

    return td
  }

  private clampFixedPopup(el: HTMLElement, clientX: number, clientY: number): void {
    const rect = el.getBoundingClientRect()
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
    const vh = typeof window !== 'undefined' ? window.innerHeight : 768
    const left = Math.max(6, Math.min(clientX, vw - rect.width - 8))
    const top = Math.max(6, Math.min(clientY, vh - rect.height - 8))
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }

  private openContextMenu(
    clientX: number,
    clientY: number,
    rowIndex: number,
    colIndex: number,
    columnName: string,
    rawValue: unknown,
    td: HTMLTableCellElement
  ): void {
    this.closeContextMenu()
    this.closeBulkFillPopover()
    const model = this.model
    if (typeof document === 'undefined' || !model) return

    const rowState = this.rowStates[rowIndex]
    const gate = checkCellEditGate(model.canEdit, model.primaryKey)
    const canEditRow =
      !this.interactionLocked &&
      (gate.allowed || (model.canEdit && rowState?.kind === 'inserted')) &&
      !rowState?.deleted

    const summary = this.getSelectionSummary()
    const isMultiCell = summary.cellCount > 1
    const selectedRowCount = Math.max(1, summary.rowCount)

    const menu = document.createElement('div')
    menu.className = 'datanoa-context-menu'

    const addItem = (
      label: string,
      disabled: boolean,
      onClick: () => void,
      danger = false
    ) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `datanoa-context-item${danger ? ' danger' : ''}`
      btn.textContent = label
      btn.disabled = disabled
      btn.addEventListener('click', () => {
        this.closeContextMenu()
        onClick()
      })
      menu.appendChild(btn)
    }

    const addSep = () => {
      const sep = document.createElement('div')
      sep.className = 'datanoa-context-sep'
      menu.appendChild(sep)
    }

    addItem(isMultiCell ? `Copy (${summary.cellCount} cells TSV)` : 'Copy Cell (TSV)', false, () => {
      this.copySelection('tsv')
      this.onNotify?.(isMultiCell ? `Copied ${summary.cellCount} cells (TSV)` : `Copied ${columnName} to clipboard`)
    })

    addItem('Copy with Headers (TSV)', false, () => {
      this.copySelection('tsv-headers')
      this.onNotify?.('Copied selection with headers (TSV)')
    })

    addItem('Copy as CSV', false, () => {
      this.copySelection('csv')
      this.onNotify?.('Copied selection as CSV')
    })

    addItem('Copy as JSON', false, () => {
      this.copySelection('json')
      this.onNotify?.('Copied selection as JSON')
    })

    addItem('Copy as SQL IN (...)', false, () => {
      const sqlIn = this.copySelection('sql-in')
      if (sqlIn) {
        this.onNotify?.('Copied selection as SQL IN list')
      }
    })

    addItem('Copy as SQL INSERT', false, () => {
      const sqlIns = this.copySelection('sql-insert')
      if (sqlIns) {
        this.onNotify?.('Copied selection as SQL INSERT')
      }
    })

    addItem('Copy SQL Literal', false, () => {
      const literal = formatSqlLiteral(rawValue, this.dialect)
      copyTextToClipboard(literal)
      this.onNotify?.(`Copied SQL literal: ${literal}`)
    })

    addItem('Paste (Overwrite Cells)', !canEditRow, () => {
      void this.triggerPasteAction(false)
    })

    addItem('Paste as New Row(s) (Ctrl+Shift+V)', !canEditRow, () => {
      void this.triggerPasteAction(true)
    })

    addSep()

    addItem('Edit in Value Inspector', false, () => {
      const info = this.buildSelectedCellInfo(rowIndex, colIndex)
      if (info) {
        this.onInspectCell?.(info)
      }
    })

    const canEditTargetCell = isMultiCell ? canEditRow : this.isCellEditable(rowIndex, colIndex)
    const canSetNullTargetCell = isMultiCell
      ? canEditRow
      : canEditTargetCell && this.isColumnNullable(colIndex)
    addItem(
      isMultiCell ? `Bulk Set NULL (${summary.cellCount} cells)` : 'Set NULL',
      !canSetNullTargetCell,
      () => {
        if (isMultiCell || this.batchMode || this.getStagedCount() > 0 || rowState?.kind === 'inserted') {
          const count = this.bulkSetCellsValue(null)
          if (count > 0) {
            this.onNotify?.(`Set ${count} cell${count === 1 ? '' : 's'} to NULL`)
          }
        } else {
          if (!this.isColumnNullable(colIndex)) {
            this.onNotify?.(`Column "${columnName}" is NOT NULL — cannot set NULL.`)
            return
          }
          void this.applyDirectCellValue(
            rowIndex,
            colIndex,
            columnName,
            null,
            rawValue,
            this.findLiveCell(rowIndex, colIndex) ?? td
          )
        }
      }
    )

    addItem('Bulk Fill Value...', !canEditTargetCell, () => {
      this.openBulkFillPopover(clientX, clientY, summary.cellCount || 1)
    })

    addSep()

    const valPreview = previewMenuValue(rawValue)
    const isNullVal = rawValue === null || rawValue === undefined

    addItem(
      isNullVal ? `Filter: ${columnName} IS NULL` : `Filter: ${columnName} = ${valPreview}`,
      false,
      () => {
        this.triggerQuickFilter(columnName, rawValue, isNullVal ? 'is-null' : 'eq', 'replace')
      }
    )

    addItem(
      isNullVal ? `Filter: ${columnName} IS NOT NULL` : `Filter: ${columnName} != ${valPreview}`,
      false,
      () => {
        this.triggerQuickFilter(columnName, rawValue, isNullVal ? 'is-not-null' : 'neq', 'replace')
      }
    )

    addItem(
      isNullVal ? `Filter AND: ${columnName} IS NULL` : `Filter AND: ${columnName} = ${valPreview}`,
      false,
      () => {
        this.triggerQuickFilter(columnName, rawValue, isNullVal ? 'is-null' : 'eq', 'and')
      }
    )

    if (!isNullVal) {
      addItem(`Filter: ${columnName} IS NULL`, false, () => {
        this.triggerQuickFilter(columnName, null, 'is-null', 'replace')
      })
    }

    const fk = this.getForeignKeyForColumn(columnName)
    if (fk && !isNullVal && this.onNavigateForeignKey) {
      addSep()
      addItem(`Go to ${fk.referencedTable}.${fk.referencedColumn}`, false, () => {
        this.triggerFkJump(rowIndex, colIndex)
      })
    }

    addSep()

    addItem(
      selectedRowCount > 1 ? `Clone ${selectedRowCount} Rows` : 'Clone Row',
      !model.canEdit || this.interactionLocked,
      () => {
        if (selectedRowCount > 1) {
          const cloned = this.bulkCloneSelectedRows()
          if (cloned > 0) this.onNotify?.(`Cloned ${cloned} rows`)
        } else {
          this.selectedRowIndex = rowIndex
          this.cloneSelectedRow()
        }
      }
    )

    const delLabel =
      selectedRowCount > 1
        ? `Mark ${selectedRowCount} Rows Deleted`
        : rowState?.deleted
          ? 'Restore Row'
          : 'Mark Row Deleted'

    addItem(
      delLabel,
      !model.canEdit || this.interactionLocked || (!gate.allowed && rowState?.kind !== 'inserted'),
      () => {
        if (selectedRowCount > 1) {
          this.bulkMarkRowsDeleted()
        } else {
          this.markRowDeleted(rowIndex)
        }
      },
      selectedRowCount > 1 || !rowState?.deleted
    )

    document.body.appendChild(menu)
    this.contextMenuEl = menu
    this.clampFixedPopup(menu, clientX, clientY)
  }

  private openHeaderContextMenu(
    clientX: number,
    clientY: number,
    modelColIdx: number,
    visCol: number,
    header: string,
    thEl: HTMLTableCellElement
  ): void {
    this.closeContextMenu()
    this.closeBulkFillPopover()
    const model = this.model
    if (typeof document === 'undefined' || !model) return

    const visibleCols = this.getVisibleColumnIndices()
    const isPinned = this.pinnedColumns.includes(header)

    const menu = document.createElement('div')
    menu.className = 'datanoa-context-menu'

    const addItem = (label: string, disabled: boolean, onClick: () => void) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'datanoa-context-item'
      btn.textContent = label
      btn.disabled = disabled
      btn.addEventListener('click', () => {
        this.closeContextMenu()
        onClick()
      })
      menu.appendChild(btn)
    }

    const addSep = () => {
      const sep = document.createElement('div')
      sep.className = 'datanoa-context-sep'
      menu.appendChild(sep)
    }

    addItem('Select Column', false, () => {
      const rowCount = this.getFilteredRowIndices().length
      this.selection.selectColumn(visCol, rowCount)
      this.syncSelectionClasses()
      this.notifyAllSelectionListeners()
    })

    addItem('Copy Column Values', false, () => {
      const rowIndices = this.getFilteredRowIndices()
      const lines = rowIndices.map((rIdx) => {
        const val = getCellValue(model.rows[rIdx], modelColIdx, header)
        return val === null || val === undefined ? '' : stringifyFilterValue(val)
      })
      copyTextToClipboard(lines.join('\n'))
      this.onNotify?.(`Copied ${lines.length} values from "${header}"`)
    })

    addItem('Copy as SQL IN (...)', false, () => {
      const rowIndices = this.getFilteredRowIndices()
      const vals = rowIndices.map((rIdx) => getCellValue(model.rows[rIdx], modelColIdx, header))
      const sqlIn = formatSqlInList(vals, this.dialect, { deduplicate: true, columnName: header })
      if (sqlIn) {
        copyTextToClipboard(sqlIn)
        this.onNotify?.(`Copied "${header}" as SQL IN list`)
      }
    })

    addItem('Copy Column Name', false, () => {
      copyTextToClipboard(header)
      this.onNotify?.(`Copied column name "${header}"`)
    })

    addSep()

    addItem('Sort Ascending (ASC)', false, () => {
      this.handleHeaderClick(header, 'ASC')
    })

    addItem('Sort Descending (DESC)', false, () => {
      this.handleHeaderClick(header, 'DESC')
    })

    addSep()

    addItem(isPinned ? 'Unpin Column' : 'Pin Column', false, () => {
      this.togglePinColumn(header)
    })

    addItem('Hide Column', visibleCols.length <= 1, () => {
      this.setColumnVisibility(header, false)
    })

    addItem('Auto-fit Column', false, () => {
      this.autoFitColumn(modelColIdx, thEl)
    })

    document.body.appendChild(menu)
    this.contextMenuEl = menu
    this.clampFixedPopup(menu, clientX, clientY)
  }

  private openBulkFillPopover(clientX: number, clientY: number, cellCount: number): void {
    this.closeBulkFillPopover()
    if (typeof document === 'undefined') return

    const pop = document.createElement('div')
    pop.className = 'datanoa-bulk-fill-popover'

    const title = document.createElement('div')
    title.className = 'datanoa-bulk-fill-title'
    title.textContent = `Fill ${cellCount} Selected Cell${cellCount === 1 ? '' : 's'}`
    pop.appendChild(title)

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'datanoa-search-input'
    input.placeholder = 'Enter value to fill...'
    pop.appendChild(input)

    const actions = document.createElement('div')
    actions.className = 'datanoa-bulk-fill-actions'

    const nullBtn = document.createElement('button')
    nullBtn.type = 'button'
    nullBtn.className = 'datanoa-btn datanoa-btn-sm'
    nullBtn.textContent = 'Set NULL'
    nullBtn.addEventListener('click', () => {
      this.closeBulkFillPopover()
      const updated = this.bulkSetCellsValue(null)
      if (updated > 0) this.onNotify?.(`Set ${updated} cells to NULL`)
    })

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'datanoa-btn datanoa-btn-sm'
    cancelBtn.textContent = 'Cancel'
    cancelBtn.addEventListener('click', () => {
      this.closeBulkFillPopover()
    })

    const applyBtn = document.createElement('button')
    applyBtn.type = 'button'
    applyBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-primary'
    applyBtn.textContent = 'Apply'
    const doApply = () => {
      const val = input.value
      this.closeBulkFillPopover()
      const updated = this.bulkSetCellsValue(val)
      if (updated > 0) {
        this.onNotify?.(`Filled ${updated} cell${updated === 1 ? '' : 's'}`)
      }
    }
    applyBtn.addEventListener('click', doApply)

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        doApply()
      } else if (ev.key === 'Escape') {
        ev.preventDefault()
        this.closeBulkFillPopover()
      }
    })

    actions.appendChild(nullBtn)
    actions.appendChild(cancelBtn)
    actions.appendChild(applyBtn)
    pop.appendChild(actions)

    document.body.appendChild(pop)
    this.bulkFillPopoverEl = pop
    this.clampFixedPopup(pop, clientX, clientY)
    input.focus()
  }

  private triggerQuickFilter(
    column: string,
    value: unknown,
    op: 'eq' | 'neq' | 'is-null' | 'is-not-null',
    mode: 'replace' | 'and'
  ): void {
    if (this.onQuickFilter) {
      try {
        const predicate = buildQuickFilterPredicate(column, value, op, this.dialect)
        this.onQuickFilter(predicate, mode)
      } catch (err) {
        this.onNotify?.(err instanceof Error ? err.message : 'Failed to build quick filter')
      }
      return
    }
    if (mode === 'replace') {
      this.clientColumnFilters = []
    }
    this.addClientColumnFilter(column, value, op)
  }

  private closeContextMenu(): void {
    if (this.contextMenuEl) {
      this.contextMenuEl.remove()
      this.contextMenuEl = null
    }
  }

  private closeBulkFillPopover(): void {
    if (this.bulkFillPopoverEl) {
      this.bulkFillPopoverEl.remove()
      this.bulkFillPopoverEl = null
    }
  }

  /**
   * Adds a new blank staged row for batch insertion.
   */
  public addBlankRow(): number | null {
    const model = this.model
    if (this.interactionLocked || !model || !model.canEdit) {
      if (!this.interactionLocked) {
        this.onNotify?.('Table is read-only or not editable')
      }
      return null
    }

    const blank: Record<string, unknown> = {}
    model.headers.forEach((header, idx) => {
      const col = model.columns[idx]
      const isAutoInc = Boolean(col && 'isAutoIncrement' in col && col.isAutoIncrement)
      const isGenerated = Boolean(col && 'isGenerated' in col && col.isGenerated === true)
      const hasDefault = Boolean(
        col && 'defaultValue' in col && col.defaultValue !== null && col.defaultValue !== undefined
      )
      if (!isAutoInc && !isGenerated && !hasDefault) {
        blank[header] = null
      }
    })

    model.rows.push(blank)
    this.rowStates.push({
      kind: 'inserted',
      deleted: false,
      original: {},
      dirtyCols: new Map<string, unknown>(),
      origin: 'blank',
    })
    this.invalidateDataCache()
    this.invalidateFilterCache()

    const newIdx = model.rows.length - 1
    const visibleRows = this.getFilteredRowIndices()
    const vr = visibleRows.indexOf(newIdx)
    if (vr >= 0 && this.getVisibleColumnIndices().length > 0) {
      this.selection.selectCell(vr, 0, 'cell')
    }
    this.selectedRowIndex = newIdx
    this.selectedColIndex = this.getVisibleColumnIndices()[0] ?? 0

    if (this.isTransposed) {
      this.renderHeader()
    }
    this.scrollToBottomForRows(visibleRows.length)
    this.refreshFindMatchesIfActive()
    this.onStageChange?.(this.getStagedCount())
    this.notifyAllSelectionListeners()
    return newIdx
  }

  private scrollToBottomForRows(totalVisibleRows: number): void {
    if (!this.tableContainerEl || this.isTransposed) {
      this.renderVisibleRows()
      return
    }
    const clientHeight = this.tableContainerEl.clientHeight || 440
    const headerH = this.theadEl?.offsetHeight || 28
    const targetTop = Math.max(0, headerH + totalVisibleRows * ROW_HEIGHT_PX + 28 - clientHeight)
    this.tableContainerEl.scrollTop = targetTop
    this.renderVisibleRows()
    if (this.tableContainerEl.scrollHeight > clientHeight) {
      this.tableContainerEl.scrollTop = Math.max(
        targetTop,
        this.tableContainerEl.scrollHeight - clientHeight
      )
    }
  }

  private async triggerPasteAction(asNewRows: boolean): Promise<void> {
    let clipText = ''
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      try {
        clipText = await navigator.clipboard.readText()
      } catch {
        clipText = ''
      }
    }
    if (!clipText) {
      clipText = this.lastCopiedDelimitedText
    }
    if (!clipText) {
      this.onNotify?.(
        asNewRows
          ? 'Copy rows first (Ctrl+C), then use Paste as New Row(s) (Ctrl+Shift+V)'
          : 'Use Ctrl+V to paste directly into the focused grid'
      )
      return
    }
    if (asNewRows) {
      const inserted = this.pasteAsNewRows(clipText)
      if (inserted > 0) {
        this.onNotify?.(
          `Pasted ${inserted} new row${inserted === 1 ? '' : 's'} (marked PASTE) — review & click Submit`
        )
      }
    } else {
      const count = this.pasteDelimitedText(clipText)
      if (count > 0) {
        this.onNotify?.(`Pasted ${count} cell${count === 1 ? '' : 's'}`)
      }
    }
  }

  public pasteAsNewRows(text: string): number {
    const model = this.model
    if (this.interactionLocked || !model || !model.canEdit) return 0
    const matrix = parseDelimitedClipboard(text)
    if (matrix.length === 0) return 0

    const visibleCols = this.getVisibleColumnIndices()
    const headerLookup = new Map<string, number>()
    model.headers.forEach((h, idx) => headerLookup.set(h.toLowerCase(), idx))

    // Detect if first row is a header row matching table columns
    let startRowIdx = 0
    let colMapping: number[] | null = null
    if (matrix.length >= 2) {
      const candidate = matrix[0].map((cell) => headerLookup.get(cell.trim().toLowerCase()) ?? -1)
      const matchedCount = candidate.filter((idx) => idx >= 0).length
      if (matchedCount >= Math.min(2, matrix[0].length) && matchedCount === matrix[0].length) {
        colMapping = candidate
        startRowIdx = 1
      }
    }

    const bbox = this.selection.getBoundingBox()
    const startVisCol =
      bbox && matrix[startRowIdx] && matrix[startRowIdx].length < visibleCols.length
        ? bbox.startCol
        : 0

    const firstNewIdx = model.rows.length
    let insertedCount = 0

    for (let r = startRowIdx; r < matrix.length; r++) {
      const rowCells = matrix[r]
      const record: Record<string, unknown> = {}
      model.headers.forEach((header, idx) => {
        const col = model.columns[idx]
        const isAutoInc = Boolean(col && 'isAutoIncrement' in col && col.isAutoIncrement)
        const isGenerated = Boolean(col && 'isGenerated' in col && col.isGenerated === true)
        const hasDefault = Boolean(
          col && 'defaultValue' in col && col.defaultValue !== null && col.defaultValue !== undefined
        )
        if (!isAutoInc && !isGenerated && !hasDefault) {
          record[header] = null
        }
      })

      for (let dc = 0; dc < rowCells.length; dc++) {
        const modelColIdx = colMapping
          ? colMapping[dc]
          : visibleCols[startVisCol + dc]
        if (modelColIdx === undefined || modelColIdx < 0 || modelColIdx >= model.headers.length) {
          continue
        }
        const col = model.columns[modelColIdx]
        if (
          col &&
          (('isAutoIncrement' in col && col.isAutoIncrement) ||
            ('isGenerated' in col && col.isGenerated === true))
        ) {
          continue
        }
        const header = model.headers[modelColIdx]
        record[header] = this.coerceEditedValue(rowCells[dc], null, modelColIdx)
      }

      model.rows.push(record)
      this.rowStates.push({
        kind: 'inserted',
        origin: 'paste',
        deleted: false,
        original: {},
        dirtyCols: new Map<string, unknown>(),
      })
      insertedCount++
    }

    if (insertedCount === 0) return 0
    this.invalidateDataCache()
    this.invalidateFilterCache()

    const nextVisibleRows = this.getFilteredRowIndices()
    const firstVis = nextVisibleRows.indexOf(firstNewIdx)
    const lastVis = nextVisibleRows.indexOf(model.rows.length - 1)
    if (firstVis >= 0 && lastVis >= firstVis && visibleCols.length > 0) {
      this.selection.selectRow(firstVis, visibleCols.length)
      if (lastVis > firstVis) {
        this.selection.selectRow(lastVis, visibleCols.length, { shift: true })
      }
      this.selectedRowIndex = firstNewIdx
      this.selectedColIndex = visibleCols[0] ?? 0
    }

    if (this.isTransposed) {
      this.renderHeader()
    }
    this.scrollToBottomForRows(nextVisibleRows.length)
    this.refreshFindMatchesIfActive()
    this.onStageChange?.(this.getStagedCount())
    this.notifyAllSelectionListeners()
    return insertedCount
  }

  /**
   * Clones the currently selected row (or first row) as a staged INSERT row.
   */
  public cloneSelectedRow(): number | null {
    const model = this.model
    if (this.interactionLocked || !model || !model.canEdit || model.rows.length === 0) {
      return null
    }
    const sourceIdx =
      this.selectedRowIndex !== null &&
      this.selectedRowIndex >= 0 &&
      this.selectedRowIndex < model.rows.length
        ? this.selectedRowIndex
        : 0

    const cloned = this.createClonedRowRecord(model, sourceIdx)
    model.rows.push(cloned)
    this.rowStates.push({
      kind: 'inserted',
      origin: 'clone',
      deleted: false,
      original: {},
      dirtyCols: new Map<string, unknown>(),
    })
    this.invalidateDataCache()
    this.invalidateFilterCache()

    const newIdx = model.rows.length - 1
    const visibleRows = this.getFilteredRowIndices()
    const vr = visibleRows.indexOf(newIdx)
    if (vr >= 0 && this.getVisibleColumnIndices().length > 0) {
      this.selection.selectRow(vr, this.getVisibleColumnIndices().length)
    }
    this.selectedRowIndex = newIdx
    this.selectedColIndex = this.getVisibleColumnIndices()[0] ?? 0

    if (this.isTransposed) {
      this.renderHeader()
    }
    this.scrollToBottomForRows(visibleRows.length)
    this.refreshFindMatchesIfActive()
    this.onStageChange?.(this.getStagedCount())
    this.notifyAllSelectionListeners()
    this.onNotify?.(`Cloned 1 row (marked CLONE) — review & click Submit`)
    return newIdx
  }

  private createClonedRowRecord(model: GridModel, sourceIdx: number): Record<string, unknown> {
    const sourceRow = model.rows[sourceIdx]
    const cloned = rowToPlainRecord(model.headers, sourceRow, true)
    model.headers.forEach((header, idx) => {
      const col = model.columns[idx]
      if (
        col &&
        (('isAutoIncrement' in col && col.isAutoIncrement) ||
          ('isGenerated' in col && col.isGenerated === true))
      ) {
        delete cloned[header]
      }
    })
    return cloned
  }

  /**
   * Clones all selected rows in one batch with a single render and onStageChange notification.
   */
  public bulkCloneSelectedRows(): number {
    const model = this.model
    if (this.interactionLocked || !model || !model.canEdit || model.rows.length === 0) {
      return 0
    }

    const visibleRows = this.getFilteredRowIndices()
    const selVisRows = this.selection.getSelectedRowIndices(visibleRows.length)
    let sourceIndices = selVisRows
      .map((vr) => visibleRows[vr])
      .filter((idx): idx is number => idx !== undefined && idx >= 0 && idx < model.rows.length)

    if (sourceIndices.length === 0) {
      const fallback =
        this.selectedRowIndex !== null &&
        this.selectedRowIndex >= 0 &&
        this.selectedRowIndex < model.rows.length
          ? this.selectedRowIndex
          : 0
      sourceIndices = [fallback]
    }

    const firstNewIdx = model.rows.length
    for (const sourceIdx of sourceIndices) {
      const cloned = this.createClonedRowRecord(model, sourceIdx)
      model.rows.push(cloned)
      this.rowStates.push({
        kind: 'inserted',
        origin: 'clone',
        deleted: false,
        original: {},
        dirtyCols: new Map<string, unknown>(),
      })
    }
    this.invalidateDataCache()
    this.invalidateFilterCache()

    const nextVisibleRows = this.getFilteredRowIndices()
    const visibleCols = this.getVisibleColumnIndices()
    const firstVis = nextVisibleRows.indexOf(firstNewIdx)
    const lastVis = nextVisibleRows.indexOf(model.rows.length - 1)
    if (firstVis >= 0 && lastVis >= firstVis && visibleCols.length > 0) {
      this.selection.selectRow(firstVis, visibleCols.length)
      if (lastVis > firstVis) {
        this.selection.selectRow(lastVis, visibleCols.length, { shift: true })
      }
      this.selectedRowIndex = firstNewIdx
      this.selectedColIndex = visibleCols[0] ?? 0
    }

    if (this.isTransposed) {
      this.renderHeader()
    }
    this.scrollToBottomForRows(nextVisibleRows.length)
    this.refreshFindMatchesIfActive()
    this.onStageChange?.(this.getStagedCount())
    this.notifyAllSelectionListeners()
    this.onNotify?.(
      `Cloned ${sourceIndices.length} row${sourceIndices.length === 1 ? '' : 's'} (marked CLONE) — review & click Submit`
    )
    return sourceIndices.length
  }

  /**
   * Marks/toggles an existing row for deletion, or removes an uncommitted inserted row.
   */
  public markRowDeleted(rowIndex?: number): boolean {
    const model = this.model
    if (this.interactionLocked || !model || !model.canEdit) return false
    const idx = rowIndex ?? this.selectedRowIndex
    if (idx === null || idx < 0 || idx >= model.rows.length) return false

    const state = this.rowStates[idx]
    if (!state) return false

    if (state.kind === 'inserted') {
      model.rows.splice(idx, 1)
      this.rowStates.splice(idx, 1)
      this.selection.clear()
      if (this.selectedRowIndex !== null) {
        this.selectedRowIndex =
          model.rows.length > 0 ? Math.min(idx, model.rows.length - 1) : null
      }
    } else {
      const gate = checkCellEditGate(model.canEdit, model.primaryKey)
      if (!gate.allowed) {
        this.onNotify?.('Primary key required to delete row')
        return false
      }
      state.deleted = !state.deleted
    }

    this.invalidateDataCache()
    this.invalidateFilterCache()
    if (this.isTransposed) {
      this.renderHeader()
    }
    this.renderVisibleRows()
    this.refreshFindMatchesIfActive()
    this.onStageChange?.(this.getStagedCount())
    this.notifyAllSelectionListeners()
    return true
  }

  /**
   * Marks/restores all selected existing rows for deletion and splices inserted rows in descending order.
   */
  public bulkMarkRowsDeleted(): number {
    const model = this.model
    if (this.interactionLocked || !model || !model.canEdit) return 0

    const visibleRows = this.getFilteredRowIndices()
    const selVisRows = this.selection.getSelectedRowIndices(visibleRows.length)
    let targetModelIndices = selVisRows
      .map((vr) => visibleRows[vr])
      .filter((idx): idx is number => idx !== undefined && idx >= 0 && idx < model.rows.length)

    if (
      targetModelIndices.length === 0 &&
      this.selectedRowIndex !== null &&
      this.selectedRowIndex >= 0 &&
      this.selectedRowIndex < model.rows.length
    ) {
      targetModelIndices = [this.selectedRowIndex]
    }

    if (targetModelIndices.length === 0) return 0

    const uniqueIndices = Array.from(new Set(targetModelIndices))
    const insertedIndices: number[] = []
    const existingIndices: number[] = []
    for (const idx of uniqueIndices) {
      const st = this.rowStates[idx]
      if (!st) continue
      if (st.kind === 'inserted') {
        insertedIndices.push(idx)
      } else {
        existingIndices.push(idx)
      }
    }

    const gate = checkCellEditGate(model.canEdit, model.primaryKey)
    if (existingIndices.length > 0 && !gate.allowed && insertedIndices.length === 0) {
      this.onNotify?.('Primary key required to delete row')
      return 0
    }

    let changedCount = 0

    if (existingIndices.length > 0 && gate.allowed) {
      const allAlreadyDeleted = existingIndices.every((idx) => this.rowStates[idx]?.deleted)
      const nextDeleted = !allAlreadyDeleted
      for (const idx of existingIndices) {
        const st = this.rowStates[idx]
        if (st && st.deleted !== nextDeleted) {
          st.deleted = nextDeleted
          changedCount++
        }
      }
    }

    // Splice inserted rows in descending index order to avoid shifting earlier indices
    if (insertedIndices.length > 0) {
      insertedIndices.sort((a, b) => b - a)
      for (const idx of insertedIndices) {
        model.rows.splice(idx, 1)
        this.rowStates.splice(idx, 1)
        changedCount++
      }
      this.selection.clear()
      this.selectedRowIndex = null
      this.selectedColIndex = null
    }

    if (changedCount === 0) return 0

    this.invalidateDataCache()
    this.invalidateFilterCache()
    if (this.isTransposed) {
      this.renderHeader()
    }
    this.renderVisibleRows()
    this.refreshFindMatchesIfActive()
    this.onStageChange?.(this.getStagedCount())
    this.notifyAllSelectionListeners()
    return changedCount
  }

  private stageCellValueInMemory(
    rowIndex: number,
    colIndex: number,
    newValue: unknown
  ): boolean {
    const model = this.model
    if (!model || !this.isCellEditable(rowIndex, colIndex)) return false
    if (newValue === null && !this.isColumnNullable(colIndex)) return false

    const rowState = this.rowStates[rowIndex]
    if (!rowState || rowState.deleted) return false

    const columnName = model.headers[colIndex]
    const rowData = model.rows[rowIndex]
    setCellValue(rowData, colIndex, columnName, newValue)

    if (rowState.kind === 'existing') {
      const origVal = getCellValue(rowState.original, colIndex, columnName)
      if (Object.is(newValue, origVal)) {
        rowState.dirtyCols.delete(columnName)
      } else {
        rowState.dirtyCols.set(columnName, newValue)
      }
    } else {
      rowState.dirtyCols.set(columnName, newValue)
    }
    return true
  }

  /**
   * Stages a cell modification locally without committing immediately.
   */
  public stageCellEdit(
    rowIndex: number,
    colIndexOrName: number | string,
    newValue: unknown
  ): boolean {
    const model = this.model
    if (this.interactionLocked || !model || !model.canEdit) return false
    const colIndex =
      typeof colIndexOrName === 'number'
        ? colIndexOrName
        : model.headers.indexOf(colIndexOrName)

    if (!this.stageCellValueInMemory(rowIndex, colIndex, newValue)) {
      return false
    }

    this.invalidateDataCache()
    this.invalidateFilterCache()
    this.renderVisibleRows()
    this.refreshFindMatchesIfActive()
    this.onStageChange?.(this.getStagedCount())
    this.notifyAllSelectionListeners()
    return true
  }

  /**
   * Sets all selected editable cells to `value` in a single batch render and stage callback.
   */
  public bulkSetCellsValue(value: unknown): number {
    const model = this.model
    if (this.interactionLocked || !model || !model.canEdit) return 0

    const visibleRows = this.getFilteredRowIndices()
    const visibleCols = this.getVisibleColumnIndices()
    const targets: Array<{ rowIndex: number; colIndex: number }> = []

    this.selection.forEachSelectedCell(visibleRows.length, visibleCols.length, (vr, vc) => {
      const rIdx = visibleRows[vr]
      const cIdx = visibleCols[vc]
      if (rIdx !== undefined && cIdx !== undefined) {
        targets.push({ rowIndex: rIdx, colIndex: cIdx })
      }
    })

    if (
      targets.length === 0 &&
      this.selectedRowIndex !== null &&
      this.selectedColIndex !== null
    ) {
      targets.push({ rowIndex: this.selectedRowIndex, colIndex: this.selectedColIndex })
    }

    if (targets.length === 0) return 0

    let updated = 0
    let skippedNotNull = 0
    for (const { rowIndex, colIndex } of targets) {
      const header = model.headers[colIndex]
      const currentVal = getCellValue(model.rows[rowIndex], colIndex, header)
      const nextVal =
        typeof value === 'string' && value !== ''
          ? this.coerceEditedValue(value, currentVal, colIndex)
          : value
      if (nextVal === null && this.isCellEditable(rowIndex, colIndex) && !this.isColumnNullable(colIndex)) {
        skippedNotNull++
        continue
      }
      if (this.stageCellValueInMemory(rowIndex, colIndex, nextVal)) {
        updated++
      }
    }

    if (updated > 0) {
      this.invalidateDataCache()
      this.invalidateFilterCache()
      this.renderVisibleRows()
      this.refreshFindMatchesIfActive()
      this.onStageChange?.(this.getStagedCount())
      this.notifyAllSelectionListeners()
    } else if (skippedNotNull > 0) {
      this.onNotify?.('Selected column(s) are NOT NULL — cannot set NULL.')
    }
    return updated
  }

  /**
   * Pastes RFC-4180 TSV/CSV text starting at the selection anchor (or fills multi-selection for 1x1 text).
   */
  public pasteDelimitedText(text: string): number {
    const model = this.model
    if (this.interactionLocked || !model || !model.canEdit) return 0
    const matrix = parseDelimitedClipboard(text)
    if (matrix.length === 0) return 0

    const visibleRows = this.getFilteredRowIndices()
    const visibleCols = this.getVisibleColumnIndices()
    if (visibleRows.length === 0 || visibleCols.length === 0) return 0

    const summary = this.getSelectionSummary()
    if (matrix.length === 1 && matrix[0].length === 1 && summary.cellCount > 1) {
      const rawVal = matrix[0][0]
      let updated = 0
      this.selection.forEachSelectedCell(visibleRows.length, visibleCols.length, (vr, vc) => {
        const rIdx = visibleRows[vr]
        const cIdx = visibleCols[vc]
        if (rIdx === undefined || cIdx === undefined) return
        const header = model.headers[cIdx]
        const currentVal = getCellValue(model.rows[rIdx], cIdx, header)
        const coerced = this.coerceEditedValue(rawVal, currentVal, cIdx)
        if (this.stageCellValueInMemory(rIdx, cIdx, coerced)) {
          updated++
        }
      })
      if (updated > 0) {
        this.invalidateDataCache()
        this.invalidateFilterCache()
        this.renderVisibleRows()
        this.refreshFindMatchesIfActive()
        this.onStageChange?.(this.getStagedCount())
        this.notifyAllSelectionListeners()
      }
      return updated
    }

    const bbox = this.selection.getBoundingBox()
    const startVisRow = bbox ? bbox.startRow : 0
    const startVisCol = bbox ? bbox.startCol : 0

    let updated = 0
    let maxVisRow = startVisRow
    let maxVisCol = startVisCol

    for (let dr = 0; dr < matrix.length; dr++) {
      const targetVisRow = startVisRow + dr
      if (targetVisRow >= visibleRows.length) break
      const rIdx = visibleRows[targetVisRow]
      const rowCells = matrix[dr]
      for (let dc = 0; dc < rowCells.length; dc++) {
        const targetVisCol = startVisCol + dc
        if (targetVisCol >= visibleCols.length) break
        const cIdx = visibleCols[targetVisCol]
        const header = model.headers[cIdx]
        const currentVal = getCellValue(model.rows[rIdx], cIdx, header)
        const coerced = this.coerceEditedValue(rowCells[dc], currentVal, cIdx)
        if (this.stageCellValueInMemory(rIdx, cIdx, coerced)) {
          updated++
          if (targetVisRow > maxVisRow) maxVisRow = targetVisRow
          if (targetVisCol > maxVisCol) maxVisCol = targetVisCol
        }
      }
    }

    if (updated > 0) {
      this.invalidateDataCache()
      this.invalidateFilterCache()
      this.selection.selectCell(startVisRow, startVisCol, 'cell')
      if (maxVisRow !== startVisRow || maxVisCol !== startVisCol) {
        this.selection.extendTo(maxVisRow, maxVisCol, 'cell')
      }
      this.renderVisibleRows()
      this.refreshFindMatchesIfActive()
      this.onStageChange?.(this.getStagedCount())
      this.notifyAllSelectionListeners()
    }
    return updated
  }

  /**
   * Reverts all staged inserts, updates, and deletes back to the original page snapshot.
   */
  public revertAllChanges(): void {
    const model = this.model
    if (this.interactionLocked || !model) return

    const keptRows: (Record<string, unknown> | unknown[])[] = []
    const keptStates: InternalRowState[] = []

    this.rowStates.forEach((state) => {
      if (state.kind === 'inserted') return
      keptRows.push(cloneRow(state.original))
      keptStates.push({
        kind: 'existing',
        deleted: false,
        original: cloneRow(state.original),
        dirtyCols: new Map<string, unknown>(),
      })
    })

    model.rows = keptRows
    this.rowStates = keptStates
    this.activeEditor = null
    this.selection.clear()
    this.invalidateDataCache()
    this.invalidateFilterCache()
    if (this.selectedRowIndex !== null && this.selectedRowIndex >= keptRows.length) {
      this.selectedRowIndex = keptRows.length > 0 ? keptRows.length - 1 : null
    }

    if (this.isTransposed) {
      this.renderHeader()
    }
    this.renderVisibleRows()
    this.refreshFindMatchesIfActive()
    this.onStageChange?.(0)
    this.notifyAllSelectionListeners()
  }

  /**
   * Returns staged inserts, updates, and deletes formatted for `data.applyChanges` / `data.previewChanges`.
   */
  public getChangesPayload(): GridChangesPayload {
    const inserts: Record<string, unknown>[] = []
    const updates: StagedRowUpdate[] = []
    const deletes: Record<string, unknown>[] = []

    const model = this.model
    if (!model) {
      return { inserts, updates, deletes }
    }

    const headers = model.headers
    const pkCols = model.primaryKey

    this.rowStates.forEach((state, rowIndex) => {
      if (state.kind === 'inserted') {
        if (!state.deleted) {
          inserts.push(rowToPlainRecord(headers, model.rows[rowIndex], true))
        }
        return
      }

      const primaryKeys: Record<string, unknown> = {}
      pkCols.forEach((pk) => {
        const pkIdx = headers.indexOf(pk)
        primaryKeys[pk] = getCellValue(state.original, pkIdx, pk)
      })

      if (state.deleted) {
        deletes.push(primaryKeys)
        return
      }

      if (state.dirtyCols.size > 0) {
        const changes: Record<string, unknown> = {}
        for (const [k, v] of state.dirtyCols.entries()) {
          changes[k] = v
        }
        updates.push({
          primaryKeys,
          changes,
          originalRow: rowToPlainRecord(headers, state.original, false),
        })
      }
    })

    return { inserts, updates, deletes }
  }

  /**
   * Total number of staged operations (inserts + updates + deletes).
   */
  public getStagedCount(): number {
    const payload = this.getChangesPayload()
    return payload.inserts.length + payload.updates.length + payload.deletes.length
  }

  /**
   * Exports current (filtered, non-deleted) grid rows using JetBrains Data Extractor formats.
   */
  public exportData(
    format: ExportFormat,
    tableName?: string,
    dialect?: DatabaseDriverType
  ): string {
    const model = this.model
    if (!model) return ''
    const indices = this.getFilteredRowIndices().filter((idx) => !this.rowStates[idx]?.deleted)
    const rows = indices.map((idx) => rowToPlainRecord(model.headers, model.rows[idx]))
    return formatDataExport({
      columns: model.headers,
      rows,
      format,
      tableName: tableName || this.tableName,
      dialect: dialect || this.dialect,
      primaryKeys: model.primaryKey,
    })
  }

  private isRowEditable(rowIndex: number): boolean {
    if (this.interactionLocked || !this.model) return false
    const rowState = this.rowStates[rowIndex]
    if (!rowState || rowState.deleted) return false
    if (rowState.kind === 'inserted') {
      return this.model.canEdit
    }
    return checkCellEditGate(this.model.canEdit, this.model.primaryKey).allowed
  }

  private findLiveCell(rowIndex: number, colIndex: number): HTMLTableCellElement | null {
    if (!this.tbodyEl) return null
    const cell = this.tbodyEl.querySelector(
      `td[data-row-index="${rowIndex}"][data-col-index="${colIndex}"]`
    )
    return cell instanceof HTMLTableCellElement ? cell : null
  }

  private findNextEditableColIndex(
    rowIndex: number,
    colIndex: number,
    direction: -1 | 1
  ): number | null {
    if (!this.model || !this.isRowEditable(rowIndex)) return null
    const visibleCols = this.getVisibleColumnIndices()
    const currentVisIdx = visibleCols.indexOf(colIndex)
    if (currentVisIdx >= 0) {
      for (
        let nextVisIdx = currentVisIdx + direction;
        nextVisIdx >= 0 && nextVisIdx < visibleCols.length;
        nextVisIdx += direction
      ) {
        const candidate = visibleCols[nextVisIdx]
        if (this.isCellEditable(rowIndex, candidate)) {
          return candidate
        }
      }
      return null
    }
    for (
      let nextCol = colIndex + direction;
      nextCol >= 0 && nextCol < this.model.headers.length;
      nextCol += direction
    ) {
      if (this.isCellEditable(rowIndex, nextCol)) {
        return nextCol
      }
    }
    return null
  }

  /**
   * Activates inline editing for a specific cell (F17-01).
   */
  private activateInlineEditor(
    rowIndex: number,
    colIndex: number,
    columnName: string,
    originalValue: unknown,
    td: HTMLTableCellElement
  ): void {
    if (!this.model || !this.isCellEditable(rowIndex, colIndex)) return

    if (this.activeEditor) {
      this.cancelCellEdit()
    }

    const input = document.createElement('input')
    input.className = 'datanoa-inline-input'
    if (originalValue === null || originalValue === undefined) {
      input.value = ''
    } else if (typeof originalValue === 'object') {
      try {
        input.value = JSON.stringify(originalValue)
      } catch {
        input.value = String(originalValue)
      }
    } else {
      input.value = String(originalValue)
    }

    this.activeEditor = { rowIndex, colIndex, originalValue, td, input, userTyped: false }
    td.classList.add('editing')
    td.innerHTML = ''

    input.addEventListener('input', () => {
      if (this.activeEditor?.input === input) {
        this.activeEditor.userTyped = true
      }
    })

    let isCommitting = false
    const finalizeEdit = async (advanceDir: -1 | 0 | 1, explicitCommit: boolean): Promise<void> => {
      if (isCommitting) return
      isCommitting = true
      const nextColIndex =
        advanceDir !== 0 ? this.findNextEditableColIndex(rowIndex, colIndex, advanceDir) : null

      const typed = this.activeEditor?.input === input ? this.activeEditor.userTyped : false
      if (!explicitCommit && !typed && originalValue === null && input.value === '') {
        this.cancelCellEdit()
      } else {
        await this.commitCellEdit(rowIndex, colIndex, columnName, input.value, originalValue, td)
      }

      if (nextColIndex !== null && this.model && this.tbodyEl && rowIndex < this.model.rows.length) {
        const nextHeader = this.model.headers[nextColIndex]
        const nextRow = this.model.rows[rowIndex]
        const nextTd = this.findLiveCell(rowIndex, nextColIndex)
        if (nextTd && nextRow !== undefined) {
          this.selectSingleModelCell(rowIndex, nextColIndex)
          const nextVisCol = parseOptionalInt(nextTd.dataset.visCol)
          if (nextVisCol !== null) {
            this.scrollCellIntoViewAccountingForSticky(nextTd, nextVisCol)
          } else {
            nextTd.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
          }
          const nextValue = getCellValue(nextRow, nextColIndex, nextHeader)
          this.activateInlineEditor(rowIndex, nextColIndex, nextHeader, nextValue, nextTd)
        }
      }
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        void finalizeEdit(0, true)
      } else if (e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        void finalizeEdit(e.shiftKey ? -1 : 1, false)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        isCommitting = true
        this.cancelCellEdit()
      }
    })

    input.addEventListener('blur', () => {
      if (!isCommitting && this.activeEditor?.input === input) {
        void finalizeEdit(0, false)
      }
    })

    td.appendChild(input)
    input.focus()
    input.select()
  }

  private coerceEditedValue(rawNewValue: string, originalValue: unknown, colIndex: number): unknown {
    const colDef = this.model?.columns[colIndex]
    const colType = colDef && 'type' in colDef ? colDef.type : undefined
    return coerceCellInputValue(rawNewValue, originalValue, colType)
  }

  private refreshSingleCellDisplay(
    td: HTMLTableCellElement,
    rowIndex: number,
    colIndex: number,
    columnName: string,
    value: unknown
  ): void {
    const rowState = this.rowStates[rowIndex]
    const vr = parseOptionalInt(td.dataset.visRow) ?? 0
    const vc = parseOptionalInt(td.dataset.visCol) ?? 0
    const visibleCols = this.getVisibleColumnIndices()
    const pinnedCount = this.getPinnedVisibleCount(visibleCols)
    const pinnedOffsets = this.computePinnedLeftOffsets(visibleCols, pinnedCount)
    const activeMatch =
      this.findActiveIndex >= 0 ? (this.findMatches[this.findActiveIndex] ?? null) : null

    this.applyCellDisplay(
      td,
      rowIndex,
      colIndex,
      vr,
      vc,
      columnName,
      value,
      rowState,
      this.selection.getFocus(),
      activeMatch,
      vc < pinnedCount ? pinnedOffsets[vc] : null,
      vc < pinnedCount && vc === pinnedCount - 1
    )
  }

  /**
   * Commits updated cell value on Enter (F17-02), staging in batch mode or saving immediately otherwise.
   */
  public async commitCellEdit(
    rowIndex: number,
    colIndex: number,
    columnName: string,
    rawNewValue: string,
    originalValue: unknown,
    td: HTMLTableCellElement
  ): Promise<void> {
    if (!this.activeEditor || !this.model) return
    this.activeEditor = null
    td.classList.remove('editing')

    const rowState = this.rowStates[rowIndex]
    if (
      rowState?.kind === 'inserted' &&
      originalValue === undefined &&
      !rowState.dirtyCols.has(columnName) &&
      rawNewValue === ''
    ) {
      const liveTd = this.findLiveCell(rowIndex, colIndex) ?? td
      this.refreshSingleCellDisplay(liveTd, rowIndex, colIndex, columnName, undefined)
      return
    }

    const newValue = this.coerceEditedValue(rawNewValue, originalValue, colIndex)
    if (Object.is(newValue, originalValue)) {
      const liveTd = this.findLiveCell(rowIndex, colIndex) ?? td
      this.refreshSingleCellDisplay(liveTd, rowIndex, colIndex, columnName, originalValue)
      return
    }

    if (this.batchMode || this.getStagedCount() > 0 || rowState?.kind === 'inserted') {
      this.stageCellEdit(rowIndex, colIndex, newValue)
      return
    }

    await this.applyDirectCellValue(rowIndex, colIndex, columnName, newValue, originalValue, td)
  }

  private async applyDirectCellValue(
    rowIndex: number,
    colIndex: number,
    columnName: string,
    newValue: unknown,
    originalValue: unknown,
    td: HTMLTableCellElement | null
  ): Promise<void> {
    const targetModel = this.model
    if (!targetModel || rowIndex < 0 || rowIndex >= targetModel.rows.length) return
    if (newValue === null && !this.isColumnNullable(colIndex)) {
      this.onNotify?.(`Column "${columnName}" is NOT NULL — cannot set NULL.`)
      return
    }
    const rowData = targetModel.rows[rowIndex]
    const rowState = this.rowStates[rowIndex]

    setCellValue(rowData, colIndex, columnName, newValue)
    this.invalidateDataCache()
    this.invalidateFilterCache()

    const initialTd = this.findLiveCell(rowIndex, colIndex) ?? td
    if (initialTd) {
      this.refreshSingleCellDisplay(initialTd, rowIndex, colIndex, columnName, newValue)
      initialTd.classList.add('datanoa-cell-saving')
    }

    const primaryKeys: Record<string, unknown> = {}
    targetModel.primaryKey.forEach((pk) => {
      const pkColIdx = targetModel.headers.indexOf(pk)
      primaryKeys[pk] = getCellValue(rowState?.original ?? rowData, pkColIdx, pk)
    })

    if (this.onUpdateCell) {
      try {
        const result = await this.onUpdateCell({
          primaryKeys,
          column: columnName,
          newValue,
          originalValue,
          rowIndex,
        })

        // Stale model guard: if user switched tables/reloaded while RPC was in flight, abort cleanly
        if (this.model !== targetModel || rowIndex >= targetModel.rows.length) {
          return
        }

        if (result.ok && (result.affectedRows === undefined || result.affectedRows > 0)) {
          if (result.updatedRecord) {
            targetModel.rows[rowIndex] = cloneRow(result.updatedRecord)
            if (rowState) {
              rowState.original = cloneRow(result.updatedRecord)
            }
          } else if (rowState) {
            setCellValue(rowState.original, colIndex, columnName, newValue)
          }
          this.invalidateDataCache()
          this.invalidateFilterCache()
          const liveTd = this.findLiveCell(rowIndex, colIndex)
          if (liveTd) {
            liveTd.classList.remove('datanoa-cell-saving')
            const updatedVal = getCellValue(targetModel.rows[rowIndex], colIndex, columnName)
            this.refreshSingleCellDisplay(liveTd, rowIndex, colIndex, columnName, updatedVal)
          }
          this.refreshFindMatchesIfActive()
          this.notifyAllSelectionListeners()
        } else {
          this.rollbackCell(targetModel, rowIndex, colIndex, columnName, originalValue)
        }
      } catch {
        this.rollbackCell(targetModel, rowIndex, colIndex, columnName, originalValue)
      }
    } else {
      const liveTd = this.findLiveCell(rowIndex, colIndex) ?? initialTd
      if (liveTd) {
        liveTd.classList.remove('datanoa-cell-saving')
      }
      this.refreshFindMatchesIfActive()
    }
  }

  /**
   * Rolls back cell value to original on conflict or error (F17-05).
   * Guards against stale model and re-queries live <td> in tbodyEl instead of mutating detached references.
   */
  private rollbackCell(
    targetModel: GridModel,
    rowIndex: number,
    colIndex: number,
    columnName: string,
    originalValue: unknown
  ): void {
    if (this.model !== targetModel) return
    if (rowIndex < 0 || rowIndex >= targetModel.rows.length) return
    const rowData = targetModel.rows[rowIndex]
    setCellValue(rowData, colIndex, columnName, originalValue)
    this.invalidateDataCache()
    this.invalidateFilterCache()

    const liveTd = this.findLiveCell(rowIndex, colIndex)
    if (liveTd) {
      this.refreshSingleCellDisplay(liveTd, rowIndex, colIndex, columnName, originalValue)
      liveTd.classList.add('datanoa-cell-conflict')

      const timer = setTimeout(() => {
        this.timers.delete(timer)
        if (this.model === targetModel) {
          const currentTd = this.findLiveCell(rowIndex, colIndex)
          currentTd?.classList.remove('datanoa-cell-conflict')
        }
        liveTd.classList.remove('datanoa-cell-conflict')
      }, 1500)
      this.timers.add(timer)
    }

    this.refreshFindMatchesIfActive()
    this.notifyAllSelectionListeners()
  }

  /**
   * Cancels cell edit without dispatching request (F17-03).
   */
  public cancelCellEdit(): { currentValue: unknown; isEditing: boolean } {
    if (!this.activeEditor) {
      return { currentValue: undefined, isEditing: false }
    }

    const { rowIndex, colIndex, originalValue, td } = this.activeEditor
    this.activeEditor = null
    const liveTd = this.findLiveCell(rowIndex, colIndex) ?? td
    liveTd.className = 'datanoa-td'

    const header = this.model?.headers[colIndex] || ''
    this.refreshSingleCellDisplay(liveTd, rowIndex, colIndex, header, originalValue)

    return {
      currentValue: originalValue,
      isEditing: false,
    }
  }

  /**
   * Reconciles data.cellUpdated broadcast event (F17-04).
   * Strictly filters by connectionId + schema + table and non-empty primaryKeys without wiping staged edits.
   */
  public handleCellUpdated(payload: {
    connectionId?: string
    schema?: string
    table: string
    primaryKeys: Record<string, unknown>
    column: string
  }): void {
    const model = this.model
    if (!model) return
    if (payload.connectionId && this.connectionId && payload.connectionId !== this.connectionId) {
      return
    }
    if (
      payload.schema !== undefined &&
      this.schemaName &&
      (payload.schema || '').toLowerCase() !== this.schemaName.toLowerCase()
    ) {
      return
    }
    if (
      payload.table &&
      this.tableName &&
      payload.table.toLowerCase() !== this.tableName.toLowerCase()
    ) {
      return
    }
    const pkEntries = Object.entries(payload.primaryKeys || {})
    if (pkEntries.length === 0) return

    const matchRowIdx = model.rows.findIndex((row) =>
      pkEntries.every(([k, v]) => {
        const pkIdx = model.headers.indexOf(k)
        if (pkIdx < 0) return false
        const val = getCellValue(row, pkIdx, k)
        return String(val) === String(v)
      })
    )

    if (matchRowIdx >= 0) {
      this.invalidateDataCache()
      this.renderVisibleRows()
    }
  }

  public getModel(): GridModel | null {
    return this.model
  }

  public destroy(): void {
    if (this.rafHandle !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafHandle)
      this.rafHandle = null
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }
    for (const timer of this.timers) {
      clearTimeout(timer)
    }
    this.timers.clear()

    if (this.tableContainerEl) {
      if (this.scrollListener) {
        this.tableContainerEl.removeEventListener('scroll', this.scrollListener)
      }
      if (this.wheelListener) {
        this.tableContainerEl.removeEventListener('wheel', this.wheelListener)
      }
      if (this.keyDownListener) {
        this.tableContainerEl.removeEventListener('keydown', this.keyDownListener)
      }
      if (this.pasteListener) {
        this.tableContainerEl.removeEventListener('paste', this.pasteListener)
      }
    }
    this.scrollListener = null
    this.wheelListener = null
    this.keyDownListener = null
    this.pasteListener = null

    if (this.tbodyEl) {
      if (this.tbodyMouseDownListener) {
        this.tbodyEl.removeEventListener('mousedown', this.tbodyMouseDownListener)
      }
      if (this.tbodyClickListener) {
        this.tbodyEl.removeEventListener('click', this.tbodyClickListener)
      }
      if (this.tbodyDblClickListener) {
        this.tbodyEl.removeEventListener('dblclick', this.tbodyDblClickListener)
      }
      if (this.tbodyContextMenuListener) {
        this.tbodyEl.removeEventListener('contextmenu', this.tbodyContextMenuListener)
      }
    }
    this.tbodyMouseDownListener = null
    this.tbodyClickListener = null
    this.tbodyDblClickListener = null
    this.tbodyContextMenuListener = null

    if (typeof window !== 'undefined') {
      if (this.windowDocClickListener) {
        window.removeEventListener('mousedown', this.windowDocClickListener)
        this.windowDocClickListener = null
      }
      if (this.windowKeyDownListener) {
        window.removeEventListener('keydown', this.windowKeyDownListener)
        this.windowKeyDownListener = null
      }
    }
    this.cleanupColumnResize()
    this.cleanupDragSelection()

    this.closeContextMenu()
    this.closeBulkFillPopover()
    this.mountedRowsByVisRow.clear()
    this.freeRowPool.length = 0
    this.isPoolMountedInTbody = false
    this.lastRenderedWindow = null
    this.topSpacerTr = null
    this.topSpacerTd = null
    this.bottomSpacerTr = null
    this.bottomSpacerTd = null
    this.container.innerHTML = ''
    this.tableContainerEl = null
    this.tableEl = null
    this.colgroupEl = null
    this.rowNumColEl = null
    this.dataColElByModelIdx.clear()
    this.headerThByModelIdx.clear()
    this.theadEl = null
    this.tbodyEl = null
    this.model = null
    this.rowStates = []
  }
}
