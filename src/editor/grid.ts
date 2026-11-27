// src/editor/grid.ts
// Virtualized Data Grid: Spreadsheet Multi-Selection, Bulk Ops, Pinned/Hidden Columns,
// Find & Highlight, FK Jump, Staged Batch Edits, Transpose Mode, Context Menus & Extractor

import type {
  TableBrowseResult,
  QueryResult,
  ForeignKeyInfo,
  DatabaseDriverType,
  ConditionalHighlightRule,
  TableDisplayStateEntry,
} from '../protocol.js'
import {
  RowHeightIndex,
  clampWrapMaxLines,
  countNormalizedLines,
  isWrappableCellValue,
  DEFAULT_LINE_HEIGHT_PX,
  DEFAULT_WRAP_MAX_LINES,
} from '../shared-row-height-index.js'
import {
  HIGHLIGHT_CSS_CLASSES,
  CONDITIONAL_HIGHLIGHT_OPERATORS,
  HIGHLIGHT_TONES,
  areHighlightRulesEqual,
  buildColumnKeyResolver,
  computePinnedColumnsViewportCap,
  computeScrollLeftForFocusedCell,
  createHighlightEvaluator,
  normalizeTableDisplayStateEntry,
  parseOccurrenceColumnKey,
  type ColumnKeyResolver,
  type EvaluatedRowHighlight,
} from '../shared-table-display.js'

const HIGHLIGHT_TONE_CLASSES = Object.values(HIGHLIGHT_CSS_CLASSES)
import {
  formatDataExport,
  buildQuickFilterPredicate,
  type ExportFormat,
} from '../drivers/common/sql-tools.js'
import {
  GridSelectionModel,
  parseDelimitedClipboard,
  type CellCoord,
  type SelectionSummary,
} from './grid-selection.js'
import type { ColumnHeaderFilterOp } from './sql-column-filter.js'
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
  previewMenuValue,
  parseOptionalInt,
  type FormattedCell,
  type CellEditGate,
  type GridModel,
} from './grid-formatters.js'
import {
  isEditableInputTarget,
  findClosestTableCell,
  findClosestFkBadge,
  createSortArrowSvg,
  createColSelectSvg,
  createPinSvg,
  createFkJumpSvg,
  createColFilterSvg,
} from './grid-icons.js'
import {
  computeInitialColumnWidthsForGrid,
  computeInitialTransposedColumnWidths,
  computeFilteredRowIndices,
  computeGridFindMatches,
  compareGridCellValues,
  buildGridSelectionSnapshot,
  exportGridSelectionMatrix,
  planGridPaste,
  createClonedRowRecord,
  buildGridChangesPayload,
  countGridStagedChanges,
  type CellStatus,
  type SelectionExportFormat,
  type StagedRowUpdate,
  type GridChangesPayload,
  type SelectedCellInfo,
  type InternalRowState,
  type ClientColumnFilter,
  type ClipboardCopySnapshot,
  type PasteColumnSpec,
} from './grid-data-ops.js'
import {
  buildGridCellContextMenu,
  buildGridCanvasContextMenu,
  buildGridHeaderContextMenu,
  buildGridBulkFillPopover,
  buildGridColumnFilterPopover,
} from './grid-menus.js'

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
  type CellStatus,
  type SelectionExportFormat,
  type StagedRowUpdate,
  type GridChangesPayload,
  type SelectedCellInfo,
}

interface DragSelectionState {
  mode: 'cell' | 'row'
  lastClientX: number
  lastClientY: number
  lastRow: number | null
  lastCol: number | null
  cachedContainerRect: DOMRect | null
  cachedHeaderH: number
  moveRafId: number | null
  pendingMove: { target: EventTarget | null; x: number; y: number } | null
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
  cellByModelCol: Map<number, HTMLTableCellElement>
}

interface PooledNormalHeaderCell {
  th: HTMLTableCellElement
  inner: HTMLDivElement
  labelEl: HTMLSpanElement
  filterBtn: HTMLButtonElement
  selectBtn: HTMLButtonElement
  pinIcon: HTMLSpanElement | null
  sortIcon: HTMLSpanElement | null
  sortDir: 'ASC' | 'DESC' | null
}

interface PooledTransposedRow {
  tr: HTMLTableRowElement
  labelTd: HTMLTableCellElement
  fieldNameSpan: HTMLSpanElement
  pkSpan: HTMLSpanElement | null
  typeSpan: HTMLSpanElement | null
  leftSpacerTd: HTMLTableCellElement | null
  dataCells: HTMLTableCellElement[]
  moreTd: HTMLTableCellElement | null
  rightSpacerTd: HTMLTableCellElement | null
}

interface RenderedWindowSnapshot {
  boundedStart: number
  boundedEnd: number
  dataVersion: number
  filterVersion: number
  colLayoutVersion: number
  wrapVersion: number
  totalRows: number
  colSpan: number
}

const DEFAULT_ROWNUM_WIDTH_PX = 44
const DEFAULT_TRANSPOSED_FIELD_WIDTH_PX = 180
const DEFAULT_TRANSPOSED_ROW_WIDTH_PX = 180
const DEFAULT_TRANSPOSED_MORE_WIDTH_PX = 150
const TRANSPOSED_MORE_COL_INDEX = -2

export interface GridRuntimeSnapshot {
  model: GridModel | null
  rowStates: InternalRowState[]
  sortColumn?: string
  sortDirection?: 'ASC' | 'DESC'
  clientFilter: string
  clientColumnFilters: ClientColumnFilter[]
  findQuery: string
  findActiveIndex: number
  hiddenColumns: string[]
  pinnedColumns: string[]
  scrollTop: number
  scrollLeft: number
  tableName: string
  connectionId: string
  schemaName: string
  dialect: DatabaseDriverType
  originConnectionId?: string
  originDriver?: DatabaseDriverType
  originSchema?: string
  originTable?: string
  emptyMessage: string
  foreignKeys: ForeignKeyInfo[]
}

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
  onColumnHeaderFilter?: (
    column: string,
    value: string,
    op: ColumnHeaderFilterOp,
    mode: 'query' | 'client' | 'clear'
  ) => void
  onNavigateForeignKey?: (refTable: string, refColumn: string, value: unknown) => void
  onColumnConfigChange?: (config: { hidden: string[]; pinned: string[] }) => void
  onTableDisplayStateChange?: (entry: TableDisplayStateEntry) => void
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
  private colFilterPopoverEl: HTMLDivElement | null = null

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
  private transposedFieldWidth = DEFAULT_TRANSPOSED_FIELD_WIDTH_PX
  private transposedFieldWidthInitialized = false
  private transposedRowWidths = new Map<number, number>()
  private transposedMoreWidth = DEFAULT_TRANSPOSED_MORE_WIDTH_PX
  private transposedWidthsByTable = new Map<
    string,
    { fieldWidth: number; rowWidths: Map<number, number>; moreWidth: number }
  >()
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
  private freeCellPool: HTMLTableCellElement[] = []
  private isPoolMountedInTbody = false
  private cachedHeaderModelRef: GridModel | null = null
  private cachedHeaderTr: HTMLTableRowElement | null = null
  private cachedRowNumTh: HTMLTableCellElement | null = null
  private cachedColPoolByModelIdx = new Map<number, HTMLTableColElement>()
  private cachedThPoolByModelIdx = new Map<number, PooledNormalHeaderCell>()
  private headerHeightMeasuredTransposed: boolean | null = null
  private colKeyResolverHeaders: readonly string[] | null = null
  private colKeyResolverCache: ColumnKeyResolver | null = null
  private cachedVisibleColsLayoutVersion = -1
  private cachedVisibleColsModelRef: GridModel | null = null
  private cachedVisibleColsResult: number[] = []
  private mountedTransposedRowsByFieldIdx = new Map<number, PooledTransposedRow>()
  private freeTransposedRowPool: PooledTransposedRow[] = []
  private isTransposedPoolMounted = false
  private lastTransposedWindow: RenderedWindowSnapshot | null = null
  private lastTransposedHStart = 0
  private lastTransposedHEnd = 0
  private lastScrollLeft = -1
  private topSpacerTr: HTMLTableRowElement | null = null
  private topSpacerTd: HTMLTableCellElement | null = null
  private bottomSpacerTr: HTMLTableRowElement | null = null
  private bottomSpacerTd: HTMLTableCellElement | null = null
  private resizeObserver: ResizeObserver | null = null
  private resizeObserverRafId: number | null = null
  private lastObservedHeight = 0
  private lastObservedWidth = 0
  private isViewportResizing = false
  private cachedHeaderHeightPx = 26

  private readonly selection = new GridSelectionModel()
  private foreignKeyByColumn = new Map<string, ForeignKeyInfo>()
  private hiddenColumns = new Set<string>()
  private pinnedColumns: string[] = []
  private columnOrder: string[] = []
  private wrapCells = false
  private wrapMaxLines: number = DEFAULT_WRAP_MAX_LINES
  private wrapVersion = 0
  private highlightRules: ConditionalHighlightRule[] = []
  private readonly rowHeightIndex = new RowHeightIndex({
    baseRowHeightPx: ROW_HEIGHT_PX,
    lineHeightPx: DEFAULT_LINE_HEIGHT_PX,
    maxLines: DEFAULT_WRAP_MAX_LINES,
    wrapEnabled: false,
  })
  private readonly highlightEvaluator = createHighlightEvaluator()
  private tableDisplayRevision = 0
  private userResizedColumnKeys = new Set<string>()
  private lastUserResizeCacheKey = ''
  private draggedHeaderName: string | null = null
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
  private tableContainerMouseDownListener: ((e: MouseEvent) => void) | null = null
  private tableContainerContextMenuListener: ((e: MouseEvent) => void) | null = null
  private tbodyMouseDownListener: ((e: MouseEvent) => void) | null = null
  private tbodyClickListener: ((e: MouseEvent) => void) | null = null
  private tbodyDblClickListener: ((e: MouseEvent) => void) | null = null
  private tbodyContextMenuListener: ((e: MouseEvent) => void) | null = null
  private windowDocClickListener: ((e: MouseEvent) => void) | null = null
  private windowKeyDownListener: ((e: KeyboardEvent) => void) | null = null
  private windowPasteListener: ((e: ClipboardEvent) => void) | null = null
  private resizeListeners: {
    move: (e: MouseEvent) => void
    up: () => void
    blur: () => void
  } | null = null
  private resizeRafId: number | null = null
  private activeResizeHandle: HTMLDivElement | null = null
  private activeResizeGuideEl: HTMLDivElement | null = null
  private dragState: DragSelectionState | null = null
  private handledMouseDownClick = false
  private suppressSortClickUntil = 0
  private isLoading = false
  private lastCopiedDelimitedText = ''
  private lastCopiedSnapshot: ClipboardCopySnapshot | null = null

  private onSort?: (column: string, direction: 'ASC' | 'DESC') => void
  private onUpdateCell?: VirtualDataGridOptions['onUpdateCell']
  private onSelectCell?: VirtualDataGridOptions['onSelectCell']
  private onInspectCell?: VirtualDataGridOptions['onInspectCell']
  private onStageChange?: VirtualDataGridOptions['onStageChange']
  private onNotify?: VirtualDataGridOptions['onNotify']
  private onSelectionChange?: VirtualDataGridOptions['onSelectionChange']
  private onQuickFilter?: VirtualDataGridOptions['onQuickFilter']
  private onColumnHeaderFilter?: VirtualDataGridOptions['onColumnHeaderFilter']
  private onNavigateForeignKey?: VirtualDataGridOptions['onNavigateForeignKey']
  private onColumnConfigChange?: VirtualDataGridOptions['onColumnConfigChange']
  private onTableDisplayStateChange?: VirtualDataGridOptions['onTableDisplayStateChange']
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
    this.onColumnHeaderFilter = options.onColumnHeaderFilter
    this.onNavigateForeignKey = options.onNavigateForeignKey
    this.onColumnConfigChange = options.onColumnConfigChange
    this.onTableDisplayStateChange = options.onTableDisplayStateChange
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
      if (!this.tableContainerEl) return
      const curTop = this.tableContainerEl.scrollTop
      const curLeft = this.tableContainerEl.scrollLeft
      const activeWin = this.isTransposed ? this.lastTransposedWindow : this.lastRenderedWindow
      const versionsMatch =
        activeWin !== null &&
        activeWin.dataVersion === this.dataVersion &&
        activeWin.filterVersion === this.filterVersion &&
        activeWin.colLayoutVersion === this.colLayoutVersion
      if (curTop === this.lastScrollTop && versionsMatch) {
        if (!this.isTransposed) {
          return
        }
        if (curLeft === this.lastScrollLeft) {
          return
        }
        // In transposed mode, only schedule horizontal window update if [hStart, hEnd) actually shifts
        const indices = this.getFilteredRowIndices()
        const capped = indices.slice(0, 100)
        const hasOverflow = indices.length > 100
        const nextH = this.computeTransposedColRange(capped, hasOverflow)
        if (nextH.hStart === this.lastTransposedHStart && nextH.hEnd === this.lastTransposedHEnd) {
          this.lastScrollLeft = curLeft
          return
        }
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
    this.tableContainerEl.addEventListener('scroll', this.scrollListener, { passive: true })

    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0]
        const nextH = entry?.contentRect?.height ?? this.tableContainerEl?.clientHeight ?? 0
        const nextW = entry?.contentRect?.width ?? this.tableContainerEl?.clientWidth ?? 0
        const heightChanged = nextH > 0 && Math.abs(nextH - this.lastObservedHeight) >= 1
        const widthChanged =
          this.isTransposed && nextW > 0 && Math.abs(nextW - this.lastObservedWidth) >= 4
        if (!heightChanged && !widthChanged) return

        // During an active vertical pane drag, skip shrink-only DOM churn and avoid 1-frame-late
        // ResizeObserver layout ping-pong unless newly exposed rows exceed the mounted buffer.
        if (this.isViewportResizing && !widthChanged) {
          if (nextH <= this.lastObservedHeight) {
            return
          }
          const activeWin = this.isTransposed ? this.lastTransposedWindow : this.lastRenderedWindow
          if (activeWin && this.tableContainerEl) {
            const neededEnd = Math.ceil((this.tableContainerEl.scrollTop + nextH) / ROW_HEIGHT_PX) + 1
            if (activeWin.boundedEnd >= Math.min(activeWin.totalRows, neededEnd)) {
              this.lastObservedHeight = nextH
              return
            }
          }
        }

        if (nextH > 0) this.lastObservedHeight = nextH
        if (nextW > 0) this.lastObservedWidth = nextW
        if (typeof requestAnimationFrame === 'function') {
          if (this.resizeObserverRafId === null) {
            let ranSync = false
            const id = requestAnimationFrame(() => {
              ranSync = true
              this.resizeObserverRafId = null
              this.handleViewportResize()
            })
            if (!ranSync) {
              this.resizeObserverRafId = id
            }
          }
        } else {
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

    this.tableContainerMouseDownListener = (e: MouseEvent) => {
      if (e.button !== 0 || this.isLoading || !this.model) return
      if (isEditableInputTarget(e.target)) return
      const containerEl = this.tableContainerEl
      if (containerEl && e.target === containerEl) {
        const rect = containerEl.getBoundingClientRect?.()
        if (
          rect &&
          rect.width > 0 &&
          rect.height > 0 &&
          ((containerEl.clientWidth > 0 && e.clientX >= rect.left + containerEl.clientWidth) ||
            (containerEl.clientHeight > 0 && e.clientY >= rect.top + containerEl.clientHeight))
        ) {
          return
        }
      }
      if (this.theadEl && e.target instanceof Node && this.theadEl.contains(e.target)) return
      const td = findClosestTableCell(e.target)
      const isDataOrRowNumCell = Boolean(
        td &&
          this.tbodyEl?.contains(td) &&
          (td.classList.contains('datanoa-td-rownum') ||
            (td.dataset.rowIndex !== undefined && td.dataset.colIndex !== undefined))
      )
      if (!isDataOrRowNumCell) {
        this.clearSelection()
        this.focusGridContainer()
      }
    }
    this.tableContainerEl.addEventListener('mousedown', this.tableContainerMouseDownListener)

    this.tableContainerContextMenuListener = (e: MouseEvent) => {
      if (this.isLoading || !this.model) return
      if (this.theadEl && e.target instanceof Node && this.theadEl.contains(e.target)) return
      const td = findClosestTableCell(e.target)
      const isDataOrRowNumCell = Boolean(
        td &&
          this.tbodyEl?.contains(td) &&
          (td.classList.contains('datanoa-td-rownum') ||
            (td.dataset.rowIndex !== undefined && td.dataset.colIndex !== undefined))
      )
      if (isDataOrRowNumCell) return
      e.preventDefault()
      this.clearSelection()
      this.focusGridContainer()
      this.openCanvasContextMenu(e.clientX, e.clientY)
    }
    this.tableContainerEl.addEventListener('contextmenu', this.tableContainerContextMenuListener)

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
        if (
          this.colFilterPopoverEl &&
          e.target instanceof Node &&
          !this.colFilterPopoverEl.contains(e.target)
        ) {
          this.closeColumnFilterPopover()
        }
      }
      this.windowKeyDownListener = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          this.closeContextMenu()
          this.closeBulkFillPopover()
          this.closeColumnFilterPopover()
          return
        }
        if (
          !e.defaultPrevented &&
          (e.ctrlKey || e.metaKey) &&
          e.shiftKey &&
          e.key.toLowerCase() === 'v' &&
          this.isGridVisibleForGlobalEvent(e.target)
        ) {
          e.preventDefault()
          void this.triggerPasteAction(true)
        }
      }
      this.windowPasteListener = (e: ClipboardEvent) => {
        if (e.defaultPrevented) return
        if (!this.isGridVisibleForGlobalEvent(e.target)) return
        this.handleGridPaste(e)
      }
      window.addEventListener('mousedown', this.windowDocClickListener)
      window.addEventListener('keydown', this.windowKeyDownListener)
      window.addEventListener('paste', this.windowPasteListener)
    }
  }

  private invalidateFilterCache(): void {
    this.filterStateStamp++
    this.filterVersion++
    this.syncRowHeightIndex()
  }

  private invalidateDataCache(): void {
    this.dataVersion++
    this.highlightEvaluator.clear()
    this.syncRowHeightIndex()
  }

  private invalidateColLayoutCache(): void {
    this.colLayoutVersion++
    this.cachedVisibleColsLayoutVersion = -1
  }

  private resetHeaderPool(): void {
    this.cachedHeaderModelRef = null
    this.cachedHeaderTr = null
    this.cachedRowNumTh = null
    this.cachedColPoolByModelIdx.clear()
    this.cachedThPoolByModelIdx.clear()
    this.headerHeightMeasuredTransposed = null
  }

  private getColKeyResolver(): ColumnKeyResolver | null {
    const model = this.model
    if (!model || model.headers.length === 0) return null
    if (
      this.colKeyResolverCache &&
      this.colKeyResolverHeaders === model.headers &&
      this.colKeyResolverCache.occKeys.length === model.headers.length
    ) {
      return this.colKeyResolverCache
    }
    this.colKeyResolverHeaders = model.headers
    this.colKeyResolverCache = buildColumnKeyResolver(model.headers)
    return this.colKeyResolverCache
  }

  private measureWrapRowsRange(
    visibleRows: readonly number[],
    startVisRow: number,
    endVisRow: number
  ): void {
    const model = this.model
    if (!model || !this.wrapCells || this.isTransposed || visibleRows.length === 0) return
    const lo = Math.max(0, startVisRow)
    const hi = Math.min(visibleRows.length, endVisRow)
    if (lo >= hi) return

    const visibleCols = this.getVisibleColumnIndices()
    const colMeta = visibleCols.map((colIdx) => {
      const colDef = model.columns[colIdx]
      const colType = colDef && 'type' in colDef ? colDef.type : undefined
      const widthPx = Math.max(48, this.columnWidths[colIdx] ?? 120)
      const charsPerLine = Math.max(8, Math.floor((widthPx - 14) / 7.5))
      return {
        colIdx,
        header: model.headers[colIdx] ?? '',
        colType,
        charsPerLine,
      }
    })
    for (let visRow = lo; visRow < hi; visRow++) {
      const rowData = model.rows[visibleRows[visRow]]
      if (!rowData) continue
      let maxRowLines = 1
      for (const meta of colMeta) {
        const val = getCellValue(rowData, meta.colIdx, meta.header)
        if (!isWrappableCellValue(val, meta.colType)) continue
        let lines = countNormalizedLines(val, this.wrapMaxLines)
        if (typeof val === 'string' && val.length > meta.charsPerLine) {
          const wrappedEstimate = Math.ceil(val.length / meta.charsPerLine)
          if (wrappedEstimate > lines) {
            lines = Math.min(this.wrapMaxLines, wrappedEstimate)
          }
        }
        if (lines > maxRowLines) {
          maxRowLines = lines
          if (maxRowLines >= this.wrapMaxLines) break
        }
      }
      this.rowHeightIndex.setRowLines(visRow, maxRowLines)
    }
  }

  private syncRowHeightIndex(options?: { layoutOnly?: boolean; skipWrapScan?: boolean }): void {
    const activeWrap = this.wrapCells && !this.isTransposed
    this.rowHeightIndex.setWrapEnabled(activeWrap)
    this.rowHeightIndex.setMaxLines(this.wrapMaxLines)
    if (!this.model || this.isTransposed) {
      if (this.rowHeightIndex.rowCount !== 0) {
        this.rowHeightIndex.reset(0)
      }
      return
    }
    const visibleRows = this.getFilteredRowIndices()
    if (options?.layoutOnly && this.rowHeightIndex.rowCount === visibleRows.length) {
      if (!activeWrap || options?.skipWrapScan || visibleRows.length === 0) return
      if (visibleRows.length <= 64) {
        this.measureWrapRowsRange(visibleRows, 0, visibleRows.length)
      } else {
        const clientHeight = this.tableContainerEl?.clientHeight || 440
        const scrollTop = Math.max(0, this.tableContainerEl?.scrollTop ?? 0)
        const range = this.rowHeightIndex.getVisibleRange(scrollTop, clientHeight, 5)
        this.measureWrapRowsRange(visibleRows, range.start, range.end)
      }
      return
    }
    this.rowHeightIndex.reset(visibleRows.length)
    if (!activeWrap || visibleRows.length === 0) return
    if (visibleRows.length <= 64) {
      this.measureWrapRowsRange(visibleRows, 0, visibleRows.length)
    } else {
      const clientHeight = this.tableContainerEl?.clientHeight || 440
      const scrollTop = Math.max(0, this.tableContainerEl?.scrollTop ?? 0)
      const range = this.rowHeightIndex.getVisibleRange(scrollTop, clientHeight, 5)
      this.measureWrapRowsRange(visibleRows, range.start, range.end)
    }
  }

  private evaluateRowHighlightState(
    model: GridModel | null,
    rowIndex: number
  ): EvaluatedRowHighlight | null {
    const rowData = model?.rows[rowIndex]
    if (!model || this.isTransposed || this.highlightRules.length === 0 || !rowData) {
      return null
    }
    return this.highlightEvaluator.evaluateRow({
      row: rowData,
      columns: model.headers,
      rules: this.highlightRules,
      rowKey: rowIndex,
      rowRevision: this.dataVersion,
    })
  }

  private resolveCellHighlightClass(
    evaluatedHighlight: EvaluatedRowHighlight | null,
    occKeys: readonly string[] | null,
    colIdx: number,
    header: string
  ): string | null {
    if (!evaluatedHighlight) return null
    const occKey = occKeys ? occKeys[colIdx] : undefined
    return (
      (occKey ? evaluatedHighlight.cellClassesByKey[occKey] : undefined) ??
      evaluatedHighlight.cellClassesByKey[header] ??
      null
    )
  }

  private resetPooledRowStyles(pooled: PooledGridRow): void {
    pooled.tr.style.height = ''
    pooled.rowNumTd.style.height = ''
    for (const td of pooled.dataCells) {
      td.style.height = ''
    }
  }

  private resetRowPoolMountState(): void {
    for (const pooled of this.mountedRowsByVisRow.values()) {
      this.resetPooledRowStyles(pooled)
      if (this.freeRowPool.length < 120) {
        this.freeRowPool.push(pooled)
      }
    }
    this.mountedRowsByVisRow.clear()
    this.isPoolMountedInTbody = false
    for (const pooled of this.mountedTransposedRowsByFieldIdx.values()) {
      pooled.tr.style.height = ''
      if (this.freeTransposedRowPool.length < 80) {
        this.freeTransposedRowPool.push(pooled)
      }
    }
    this.mountedTransposedRowsByFieldIdx.clear()
    this.isTransposedPoolMounted = false
    this.lastRenderedWindow = null
    this.lastTransposedWindow = null
    this.lastTransposedHStart = 0
    this.lastTransposedHEnd = 0
    this.lastScrollTop = -1
    this.lastScrollLeft = -1
  }

  public setViewportResizing(resizing: boolean): void {
    const next = Boolean(resizing)
    if (this.isViewportResizing === next) return
    this.isViewportResizing = next
    if (next) {
      if (this.resizeObserverRafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.resizeObserverRafId)
        this.resizeObserverRafId = null
      }
      if (this.tableContainerEl) {
        const curH = this.tableContainerEl.clientHeight
        if (curH > 0) this.lastObservedHeight = curH
      }
    } else {
      this.handleViewportResize()
    }
  }

  public handleViewportResize(): void {
    if (this.resizeObserverRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.resizeObserverRafId)
      this.resizeObserverRafId = null
    }
    if (!this.tableContainerEl || this.isLoading || !this.model) return
    const nextH = this.tableContainerEl.clientHeight
    const nextW = this.tableContainerEl.clientWidth
    if (nextH > 0) {
      this.lastObservedHeight = nextH
    }
    if (nextW > 0) {
      this.lastObservedWidth = nextW
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
    const modeChanged = this.isTransposed !== enabled
    if (this.activeEditor) {
      this.flushActiveEditorBeforeRebuild()
    }
    this.isTransposed = enabled
    this.invalidateColLayoutCache()
    this.resetHeaderPool()
    this.resetRowPoolMountState()
    this.syncRowHeightIndex()
    if (modeChanged && this.tableContainerEl) {
      this.tableContainerEl.scrollTop = 0
      this.tableContainerEl.scrollLeft = 0
    }
    this.closeContextMenu()
    this.closeBulkFillPopover()
    this.closeColumnFilterPopover()
    if (this.tableEl) {
      this.tableEl.className = enabled ? 'datanoa-grid-table transposed' : 'datanoa-grid-table'
    }
    this.renderHeader()
    this.renderVisibleRows(true)
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
    op: ColumnHeaderFilterOp
  ): void {
    const col = column.trim()
    if (!col) return
    this.clientColumnFilters = this.clientColumnFilters.filter((f) => f.column !== col)
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
    this.renderHeader()
    this.renderVisibleRows()
    this.notifyAllSelectionListeners()
  }

  public removeClientColumnFilter(column: string): void {
    const col = column.trim()
    if (!col) return
    const next = this.clientColumnFilters.filter((f) => f.column !== col)
    if (next.length === this.clientColumnFilters.length) return
    this.clientColumnFilters = next
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
    this.renderHeader()
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
      this.closeColumnFilterPopover()
      this.model = null
      this.rowStates = []
      this.findMatches = []
      this.findMatchKeys.clear()
      this.findActiveIndex = -1
      this.invalidateDataCache()
      this.invalidateFilterCache()
      this.resetHeaderPool()
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

  private capturePreservedStagedDeltas(nextHeaders: readonly string[], nextPrimaryKey: readonly string[]) {
    const empty = {
      inserts: [] as Array<{
        record: Record<string, unknown>
        origin: InternalRowState['origin']
        dirtyCols: Map<string, unknown>
      }>,
      existingByPk: new Map<string, { deleted: boolean; dirtyCols: Map<string, unknown> }>(),
    }
    const prevModel = this.model
    if (!prevModel || this.getStagedCount() === 0) return empty

    const oldHeaderIdx = new Map<string, number>()
    for (let c = 0; c < prevModel.headers.length; c++) {
      const h = prevModel.headers[c]
      if (!oldHeaderIdx.has(h)) oldHeaderIdx.set(h, c)
    }

    const canMatchPk =
      prevModel.primaryKey.length > 0 &&
      nextPrimaryKey.length === prevModel.primaryKey.length &&
      prevModel.primaryKey.every((pk, i) => nextPrimaryKey[i] === pk) &&
      nextPrimaryKey.every((pk) => nextHeaders.includes(pk))

    for (let r = 0; r < this.rowStates.length; r++) {
      const rs = this.rowStates[r]
      if (!rs) continue
      if (rs.kind === 'inserted') {
        if (rs.deleted) continue
        const liveRow = prevModel.rows[r] ?? rs.original
        empty.inserts.push({
          record: rowToPlainRecord(prevModel.headers, liveRow),
          origin: rs.origin,
          dirtyCols: new Map(rs.dirtyCols),
        })
        continue
      }
      if (!canMatchPk || (!rs.deleted && rs.dirtyCols.size === 0)) continue
      const pkKey = JSON.stringify(
        prevModel.primaryKey.map((pk) => {
          const idx = oldHeaderIdx.get(pk)
          return idx !== undefined ? getCellValue(rs.original, idx, pk) : undefined
        })
      )
      empty.existingByPk.set(pkKey, {
        deleted: rs.deleted,
        dirtyCols: new Map(rs.dirtyCols),
      })
    }
    return empty
  }

  private applyPreservedStagedDeltas(
    preserved: ReturnType<VirtualDataGrid['capturePreservedStagedDeltas']>,
    headers: readonly string[],
    primaryKey: readonly string[]
  ): void {
    const model = this.model
    if (!model || !model.canEdit) return
    const headerIdx = new Map<string, number>()
    for (let c = 0; c < headers.length; c++) {
      const h = headers[c]
      if (!headerIdx.has(h)) headerIdx.set(h, c)
    }

    if (preserved.existingByPk.size > 0 && primaryKey.length > 0) {
      for (let r = 0; r < this.rowStates.length; r++) {
        const rs = this.rowStates[r]
        if (!rs || rs.kind !== 'existing') continue
        const pkKey = JSON.stringify(
          primaryKey.map((pk) => {
            const idx = headerIdx.get(pk)
            return idx !== undefined ? getCellValue(rs.original, idx, pk) : undefined
          })
        )
        const delta = preserved.existingByPk.get(pkKey)
        if (!delta) continue
        rs.deleted = delta.deleted
        const filteredDirty = new Map<string, unknown>()
        for (const [colName, val] of delta.dirtyCols) {
          const colIdx = headerIdx.get(colName)
          if (colIdx === undefined) continue
          filteredDirty.set(colName, val)
          setCellValue(model.rows[r], colIdx, colName, val)
        }
        rs.dirtyCols = filteredDirty
      }
    }

    for (const ins of preserved.inserts) {
      const rowRecord: Record<string, unknown> = {}
      const dirtyCols = new Map<string, unknown>()
      for (const h of headers) {
        if (Object.prototype.hasOwnProperty.call(ins.record, h)) {
          rowRecord[h] = ins.record[h]
        }
        if (ins.dirtyCols.has(h)) {
          dirtyCols.set(h, ins.dirtyCols.get(h))
        }
      }
      model.rows.push(rowRecord)
      this.rowStates.push({
        kind: 'inserted',
        ...(ins.origin ? { origin: ins.origin } : {}),
        deleted: false,
        original: {},
        dirtyCols,
      })
    }
  }

  public setData(
    data: TableBrowseResult | QueryResult,
    options?: { preserveStagedDeltas?: boolean }
  ): void {
    this.isLoading = false
    this.cleanupColumnResize()
    this.cleanupDragSelection()
    const formatted = formatGridModel(data)
    const preserved =
      options?.preserveStagedDeltas && formatted.canEdit
        ? this.capturePreservedStagedDeltas(formatted.headers, formatted.primaryKey)
        : null
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
      original: row,
      dirtyCols: new Map<string, unknown>(),
    }))
    if (preserved) {
      this.applyPreservedStagedDeltas(preserved, formatted.headers, formatted.primaryKey)
    }

    this.clientColumnFilters = []
    this.selection.clear()
    this.selectedRowIndex = null
    this.selectedColIndex = null
    this.activeEditor = null
    this.closeContextMenu()
    this.closeBulkFillPopover()
    this.closeColumnFilterPopover()
    this.invalidateDataCache()
    this.invalidateFilterCache()
    this.invalidateColLayoutCache()
    this.colKeyResolverHeaders = null
    this.colKeyResolverCache = null
    this.resetHeaderPool()
    this.resetRowPoolMountState()

    if (this.model.headers.length === 0) {
      this.rowNumWidth = DEFAULT_ROWNUM_WIDTH_PX
      this.columnWidths = []
      this.userResizedColumnKeys.clear()
      this.lastUserResizeCacheKey = ''
    } else {
      const cacheKey = this.getColumnCacheKey(this.model.headers)
      if (cacheKey !== this.lastUserResizeCacheKey) {
        this.userResizedColumnKeys.clear()
        this.lastUserResizeCacheKey = cacheKey
      }
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
    this.syncTransposedWidthsForModel()
    this.syncRowHeightIndex()

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
    this.onStageChange?.(this.getStagedCount())
    this.notifyAllSelectionListeners()
  }

  private resolveCanonicalColumnKey(rawKey: string): string {
    const trimmed = rawKey.trim()
    if (!trimmed) return ''
    const resolver = this.getColKeyResolver()
    if (!resolver) return trimmed
    return resolver.resolveKey(trimmed) ?? trimmed
  }

  private getHeaderOccurrenceCounts(): Map<string, number> {
    const resolver = this.getColKeyResolver()
    if (resolver) return resolver.nameCounts
    return new Map<string, number>()
  }

  private toDisplayColumnKey(
    occKey: string,
    counts: Map<string, number>,
    resolver?: ColumnKeyResolver | null
  ): string {
    const parsed = parseOccurrenceColumnKey(occKey)
    if (!parsed) return occKey
    if ((counts.get(parsed.name) ?? 0) > 1) return occKey
    const activeResolver = resolver ?? this.getColKeyResolver()
    if (
      activeResolver &&
      activeResolver.occKeySet.has(parsed.name) &&
      activeResolver.resolveKey(parsed.name) !== occKey
    ) {
      return occKey
    }
    return parsed.name
  }

  private getOrderedColumnNames(): string[] {
    const resolver = this.getColKeyResolver()
    if (!resolver) return [...this.columnOrder]
    const occKeys = resolver.occKeys
    const occKeySet = resolver.occKeySet
    const ordered: string[] = []
    const seen = new Set<string>()
    for (const rawKey of this.columnOrder) {
      const resolved = resolver.resolveKey(rawKey)
      if (resolved && occKeySet.has(resolved) && !seen.has(resolved)) {
        seen.add(resolved)
        ordered.push(resolved)
      }
    }
    for (const k of occKeys) {
      if (!seen.has(k)) {
        seen.add(k)
        ordered.push(k)
      }
    }
    return ordered
  }

  private getResolvedHiddenKeySet(): Set<string> {
    const resolver = this.getColKeyResolver()
    if (!resolver) return new Set(this.hiddenColumns)
    const out = new Set<string>()
    for (const rawKey of this.hiddenColumns) {
      const resolved = resolver.resolveKey(rawKey)
      if (resolved) out.add(resolved)
    }
    return out
  }

  private getResolvedPinnedKeys(hiddenSet: Set<string>): string[] {
    const resolver = this.getColKeyResolver()
    if (!resolver) {
      return this.pinnedColumns.filter((k) => !hiddenSet.has(k))
    }
    const out: string[] = []
    const seen = new Set<string>()
    for (const rawKey of this.pinnedColumns) {
      const resolved = resolver.resolveKey(rawKey)
      if (resolved && !hiddenSet.has(resolved) && !seen.has(resolved)) {
        seen.add(resolved)
        out.push(resolved)
      }
    }
    return out
  }

  private notifyTableDisplayStateChanged(): void {
    if (!this.onTableDisplayStateChange) return
    this.onTableDisplayStateChange(this.exportTableDisplayStateEntry())
  }

  public getColumnConfig(): { hidden: string[]; pinned: string[]; allColumns: string[]; order: string[] } {
    const resolver = this.getColKeyResolver()
    const orderedKeys = this.getOrderedColumnNames()
    const counts = this.getHeaderOccurrenceCounts()
    const hiddenSet = this.getResolvedHiddenKeySet()
    const pinnedKeys = this.getResolvedPinnedKeys(hiddenSet)
    if (orderedKeys.length === 0) {
      return {
        hidden: Array.from(hiddenSet),
        pinned: pinnedKeys,
        allColumns: [],
        order: [],
      }
    }
    const allColumns = orderedKeys.map((k) => this.toDisplayColumnKey(k, counts, resolver))
    const hidden = orderedKeys
      .filter((k) => hiddenSet.has(k))
      .map((k) => this.toDisplayColumnKey(k, counts, resolver))
    const pinned = pinnedKeys.map((k) => this.toDisplayColumnKey(k, counts, resolver))
    return { hidden, pinned, allColumns, order: [...allColumns] }
  }

  public setWrapCells(enabled: boolean, maxLines = this.wrapMaxLines): void {
    this.wrapCells = Boolean(enabled)
    this.wrapMaxLines = clampWrapMaxLines(maxLines)
    this.wrapVersion++
    this.syncRowHeightIndex()
    this.renderVisibleRows(true)
    this.notifyTableDisplayStateChanged()
  }

  public getWrapCellsConfig(): { wrapCells: boolean; wrapMaxLines: number } {
    return { wrapCells: this.wrapCells, wrapMaxLines: this.wrapMaxLines }
  }

  public setHighlightRules(rules: readonly ConditionalHighlightRule[]): void {
    this.highlightRules = rules.map((r) => ({ ...r }))
    this.highlightEvaluator.clear()
    this.wrapVersion++
    this.renderVisibleRows(true)
    this.notifyTableDisplayStateChanged()
  }

  public getHighlightRules(): ConditionalHighlightRule[] {
    return this.highlightRules.map((r) => ({ ...r }))
  }

  public reorderColumn(
    fromName: string,
    toName: string,
    placement: 'before' | 'after' = 'before'
  ): void {
    const ordered = this.getOrderedColumnNames()
    const fromKey = this.resolveCanonicalColumnKey(fromName)
    const toKey = this.resolveCanonicalColumnKey(toName)
    const fromIdx = ordered.indexOf(fromKey)
    const toIdx = ordered.indexOf(toKey)
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return
    ordered.splice(fromIdx, 1)
    let insertIdx = ordered.indexOf(toKey)
    if (insertIdx < 0) return
    if (placement === 'after') insertIdx += 1
    ordered.splice(insertIdx, 0, fromKey)
    this.columnOrder = ordered
    this.applyColumnLayoutRefresh(true, { skipWrapScan: true })
    this.notifyTableDisplayStateChanged()
  }

  public moveColumnOrderByOffset(colName: string, delta: -1 | 1): boolean {
    const ordered = this.getOrderedColumnNames()
    const colKey = this.resolveCanonicalColumnKey(colName)
    const idx = ordered.indexOf(colKey)
    const nextIdx = idx + delta
    if (idx < 0 || nextIdx < 0 || nextIdx >= ordered.length) return false
    const copy = [...ordered]
    const [item] = copy.splice(idx, 1)
    copy.splice(nextIdx, 0, item)
    this.columnOrder = copy
    this.applyColumnLayoutRefresh(true, { skipWrapScan: true })
    this.notifyTableDisplayStateChanged()
    return true
  }

  public resizeColumn(colIndex: number, widthPx: number): void {
    if (!this.model || colIndex < 0 || colIndex >= this.model.headers.length) return
    const clamped = Math.max(48, Math.min(2000, Math.round(widthPx)))
    this.columnWidths[colIndex] = clamped
    const occKey = this.getColKeyResolver()?.occKeys[colIndex]
    if (occKey) {
      this.userResizedColumnKeys.add(occKey)
    }
    const colEl = this.dataColElByModelIdx.get(colIndex)
    if (colEl) colEl.style.width = `${clamped}px`
    const thEl = this.headerThByModelIdx.get(colIndex)
    if (thEl) thEl.style.width = `${clamped}px`
    this.invalidateColLayoutCache()
    this.renderHeader()
    this.syncRowHeightIndex()
    this.renderVisibleRows(true)
    this.saveColumnWidthsToCache()
    this.notifyTableDisplayStateChanged()
  }

  public scrollToRow(visRow: number): void {
    if (!this.tableContainerEl || !this.model || this.isTransposed) return
    const visibleRows = this.getFilteredRowIndices()
    if (visibleRows.length === 0) return
    const clampedRow = Math.max(0, Math.min(visibleRows.length - 1, Math.trunc(visRow)))
    const bounds = this.rowHeightIndex.getRowBounds(clampedRow)
    const clientHeight = this.tableContainerEl.clientHeight || 440
    const targetTop = Math.max(0, bounds.top - Math.floor(clientHeight / 3))
    this.tableContainerEl.scrollTop = targetTop
    this.renderVisibleRows(true)
  }

  public getRowHeightIndexSnapshot(): {
    rowCount: number
    wrapEnabled: boolean
    maxLines: number
    getRowHeight: (row: number) => number
    getRowOffset: (row: number) => number
  } {
    return {
      rowCount: this.rowHeightIndex.rowCount,
      wrapEnabled: this.rowHeightIndex.wrapEnabled,
      maxLines: this.rowHeightIndex.maxLines,
      getRowHeight: (r: number) => this.rowHeightIndex.getRowHeight(r),
      getRowOffset: (r: number) => this.rowHeightIndex.getRowOffset(r),
    }
  }

  public exportTableDisplayStateEntry(): TableDisplayStateEntry {
    const columnWidthsByKey: Record<string, number> = {}
    const resolver = this.getColKeyResolver()
    if (resolver) {
      const occKeys = resolver.occKeys
      for (let i = 0; i < occKeys.length; i++) {
        const occKey = occKeys[i]
        if (!this.userResizedColumnKeys.has(occKey)) continue
        const w = this.columnWidths[i]
        if (typeof w === 'number' && Number.isFinite(w)) {
          columnWidthsByKey[occKey] = Math.round(w)
        }
      }
    }
    const hiddenSet = this.getResolvedHiddenKeySet()
    const pinnedKeys = this.getResolvedPinnedKeys(hiddenSet)
    return {
      columnOrder: this.getOrderedColumnNames(),
      hiddenColumns: Array.from(hiddenSet),
      pinnedColumns: pinnedKeys,
      columnWidths: columnWidthsByKey,
      wrapCells: this.wrapCells,
      wrapMaxLines: this.wrapMaxLines,
      highlightRules: this.highlightRules.map((r) => ({ ...r })),
      updatedAt: Date.now(),
      revision: this.tableDisplayRevision,
    }
  }

  public applyTableDisplayState(rawEntry: TableDisplayStateEntry | null): void {
    const prevRules = this.highlightRules
    const prevWrap = this.wrapCells
    const prevMaxLines = this.wrapMaxLines
    const prevWidths = [...this.columnWidths]
    const entry = rawEntry ? normalizeTableDisplayStateEntry(rawEntry) : null
    this.userResizedColumnKeys.clear()
    if (!entry) {
      this.columnOrder = []
      this.hiddenColumns.clear()
      this.pinnedColumns = []
      this.wrapCells = false
      this.wrapMaxLines = DEFAULT_WRAP_MAX_LINES
      this.highlightRules = []
      this.tableDisplayRevision = 0
      if (this.model && this.model.headers.length > 0) {
        this.columnWidths = this.computeInitialColumnWidths(this.model)
      }
    } else {
      const resolver = this.getColKeyResolver()
      const occKeys = resolver ? resolver.occKeys : []
      this.columnOrder = Array.isArray(entry.columnOrder)
        ? entry.columnOrder.map((k) => (resolver ? resolver.resolveKey(k) ?? k : k))
        : []
      this.hiddenColumns = new Set(
        (entry.hiddenColumns ?? []).map((k) => (resolver ? resolver.resolveKey(k) ?? k : k))
      )
      const orderedKeys = this.getOrderedColumnNames()
      if (orderedKeys.length > 0 && orderedKeys.every((k) => this.hiddenColumns.has(k))) {
        this.hiddenColumns.delete(orderedKeys[0])
      }
      this.pinnedColumns = Array.isArray(entry.pinnedColumns)
        ? entry.pinnedColumns.map((k) => (resolver ? resolver.resolveKey(k) ?? k : k))
        : []
      this.wrapCells = Boolean(entry.wrapCells)
      this.wrapMaxLines = clampWrapMaxLines(entry.wrapMaxLines)
      this.highlightRules = Array.isArray(entry.highlightRules)
        ? entry.highlightRules.map((r) => ({ ...r }))
        : []
      this.tableDisplayRevision = typeof entry.revision === 'number' ? entry.revision : 0
      if (resolver && entry.columnWidths) {
        for (const [rawKey, w] of Object.entries(entry.columnWidths)) {
          if (typeof w !== 'number' || !Number.isFinite(w) || w < 48 || w > 2000) continue
          const colIdx = resolver.resolveIndex(rawKey)
          if (colIdx >= 0) {
            this.columnWidths[colIdx] = Math.round(w)
            const occKey = occKeys[colIdx]
            if (occKey) {
              this.userResizedColumnKeys.add(occKey)
            }
          }
        }
      }
    }
    const rulesChanged = !areHighlightRulesEqual(prevRules, this.highlightRules)
    const wrapChanged = prevWrap !== this.wrapCells || prevMaxLines !== this.wrapMaxLines
    const widthsChanged =
      prevWidths.length !== this.columnWidths.length ||
      prevWidths.some((w, i) => w !== this.columnWidths[i])
    if (rulesChanged) {
      this.highlightEvaluator.clear()
    }
    if (rulesChanged || wrapChanged) {
      this.wrapVersion++
    }
    this.applyColumnLayoutRefresh(false, {
      layoutOnly: !wrapChanged && !widthsChanged,
    })
  }

  public setColumnVisibility(colName: string, visible: boolean): void {
    const key = this.resolveCanonicalColumnKey(colName)
    if (!key) return
    if (!visible) {
      const resolver = this.getColKeyResolver()
      if (resolver) {
        const occKeys = resolver.occKeys
        const hiddenSet = this.getResolvedHiddenKeySet()
        const remaining = occKeys.filter((k) => k !== key && !hiddenSet.has(k))
        if (remaining.length === 0) {
          this.onNotify?.('At least one column must remain visible')
          return
        }
      }
      this.hiddenColumns.add(key)
      this.pinnedColumns = this.pinnedColumns.filter(
        (p) => this.resolveCanonicalColumnKey(p) !== key
      )
    } else {
      this.hiddenColumns.delete(key)
      const parsed = parseOccurrenceColumnKey(key)
      if (parsed && parsed.occurrence === 1) {
        this.hiddenColumns.delete(parsed.name)
      }
    }
    this.applyColumnLayoutRefresh(true, { layoutOnly: true })
    this.notifyTableDisplayStateChanged()
  }

  public showAllColumns(): void {
    this.hiddenColumns.clear()
    this.applyColumnLayoutRefresh(true, { layoutOnly: true })
    this.notifyTableDisplayStateChanged()
  }

  public togglePinColumn(colName: string): void {
    const key = this.resolveCanonicalColumnKey(colName)
    if (!key) return
    const existingIdx = this.pinnedColumns.findIndex(
      (p) => this.resolveCanonicalColumnKey(p) === key
    )
    let wasHidden = false
    if (existingIdx >= 0) {
      this.pinnedColumns.splice(existingIdx, 1)
    } else {
      wasHidden = this.getResolvedHiddenKeySet().has(key)
      this.hiddenColumns.delete(key)
      const parsed = parseOccurrenceColumnKey(key)
      if (parsed && parsed.occurrence === 1) {
        this.hiddenColumns.delete(parsed.name)
      }
      this.pinnedColumns.push(key)
    }
    this.applyColumnLayoutRefresh(true, { layoutOnly: true, skipWrapScan: !wasHidden })
    this.notifyTableDisplayStateChanged()
  }

  public setColumnConfig(config: { hidden: string[]; pinned: string[] }): void {
    this.hiddenColumns = new Set(
      config.hidden.map((k) => this.resolveCanonicalColumnKey(k)).filter(Boolean)
    )
    const seen = new Set<string>()
    this.pinnedColumns = []
    for (const rawCol of config.pinned) {
      const col = this.resolveCanonicalColumnKey(rawCol)
      if (col && !seen.has(col) && !this.hiddenColumns.has(col)) {
        seen.add(col)
        this.pinnedColumns.push(col)
      }
    }
    const resolver = this.getColKeyResolver()
    if (resolver) {
      const occKeys = resolver.occKeys
      const anyVisible = occKeys.some((k) => !this.hiddenColumns.has(k))
      if (!anyVisible) {
        this.hiddenColumns.delete(occKeys[0])
      }
    }
    this.applyColumnLayoutRefresh(false, { layoutOnly: true })
  }

  private applyColumnLayoutRefresh(
    notifyCallback: boolean,
    syncOpts?: { layoutOnly?: boolean; skipWrapScan?: boolean }
  ): void {
    this.invalidateColLayoutCache()
    this.selection.clear()
    this.selectedRowIndex = null
    this.selectedColIndex = null
    if (this.findQuery) {
      this.recomputeFindMatches()
      this.onFindStateChange?.({ total: this.findMatches.length, activeIndex: this.findActiveIndex })
    }
    this.syncRowHeightIndex(syncOpts)
    this.renderHeader()
    this.renderVisibleRows(true)
    this.notifyAllSelectionListeners()
    if (notifyCallback) {
      const cfg = this.getColumnConfig()
      this.onColumnConfigChange?.({ hidden: cfg.hidden, pinned: cfg.pinned })
    }
  }

  private getVisibleColumnIndices(): number[] {
    const resolver = this.getColKeyResolver()
    if (!resolver || !this.model) return []
    if (
      this.cachedVisibleColsLayoutVersion === this.colLayoutVersion &&
      this.cachedVisibleColsModelRef === this.model
    ) {
      return this.cachedVisibleColsResult
    }
    const orderedKeys = this.getOrderedColumnNames()
    const hiddenSet = this.getResolvedHiddenKeySet()
    const pinnedKeys = this.getResolvedPinnedKeys(hiddenSet)
    const pinnedIndices: number[] = []
    const pinnedSet = new Set<number>()

    for (const pinnedKey of pinnedKeys) {
      const idx = resolver.resolveIndex(pinnedKey)
      if (idx >= 0 && !pinnedSet.has(idx)) {
        pinnedIndices.push(idx)
        pinnedSet.add(idx)
      }
    }

    const regularIndices: number[] = []
    for (const key of orderedKeys) {
      if (hiddenSet.has(key)) continue
      const i = resolver.resolveIndex(key)
      if (i < 0 || pinnedSet.has(i)) continue
      regularIndices.push(i)
    }

    const combined = [...pinnedIndices, ...regularIndices]
    const result = combined.length === 0 ? [0] : combined
    this.cachedVisibleColsLayoutVersion = this.colLayoutVersion
    this.cachedVisibleColsModelRef = this.model
    this.cachedVisibleColsResult = result
    return result
  }

  private getPinnedVisibleCount(visibleCols: number[]): number {
    const resolver = this.getColKeyResolver()
    if (!resolver || visibleCols.length === 0 || this.pinnedColumns.length === 0) return 0
    const occKeys = resolver.occKeys
    const hiddenSet = this.getResolvedHiddenKeySet()
    const pinnedKeySet = new Set(this.getResolvedPinnedKeys(hiddenSet))
    const candidatePinnedKeys: string[] = []
    const widthsByKey: Record<string, number> = {}
    for (const colIdx of visibleCols) {
      const occKey = occKeys[colIdx]
      if (occKey && pinnedKeySet.has(occKey) && !hiddenSet.has(occKey)) {
        candidatePinnedKeys.push(occKey)
        widthsByKey[occKey] = this.columnWidths[colIdx] ?? 120
      } else {
        break
      }
    }
    if (candidatePinnedKeys.length === 0) return 0
    const viewportWidthPx = this.tableContainerEl?.clientWidth || 1024
    const capResult = computePinnedColumnsViewportCap({
      pinnedKeys: candidatePinnedKeys,
      widthsByKey,
      viewportWidthPx,
      rowNumWidthPx: this.rowNumWidth,
      defaultColWidthPx: 120,
    })
    return capResult.activePinnedKeys.length
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

    return exportGridSelectionMatrix({
      model,
      selection: this.selection,
      visibleRows,
      visibleCols,
      format,
      tableName: this.tableName,
      dialect: this.dialect,
    })
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

    const snapshot = buildGridSelectionSnapshot({
      model,
      selection: this.selection,
      visibleRows,
      visibleCols,
      format,
      tableName: this.tableName,
      dialect: this.dialect,
    })
    if (!snapshot) return ''

    copyTextToClipboard(snapshot.text)
    if (format === 'tsv' || format === 'tsv-headers' || format === 'csv') {
      this.lastCopiedDelimitedText = snapshot.text
      this.lastCopiedSnapshot = snapshot
    } else {
      this.lastCopiedSnapshot = null
    }
    return snapshot.text
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

    const stickyWidth = this.getStickyColumnsWidth()
    const contRect = this.tableContainerEl.getBoundingClientRect?.()
    const tdRect = td.getBoundingClientRect?.()
    if (contRect && tdRect && contRect.width > 0 && tdRect.width > 0) {
      const visibleLeftEdge = contRect.left + stickyWidth
      if (tdRect.left < visibleLeftEdge) {
        const overlap = visibleLeftEdge - tdRect.left
        this.tableContainerEl.scrollLeft = Math.max(0, this.tableContainerEl.scrollLeft - overlap - 8)
      } else if (tdRect.right > contRect.right) {
        const overflow = tdRect.right - contRect.right
        this.tableContainerEl.scrollLeft += overflow + 8
      }
      return
    }

    let cellLeftPx = this.rowNumWidth
    for (let i = 0; i < visCol && i < visibleCols.length; i++) {
      cellLeftPx += this.columnWidths[visibleCols[i]] ?? 120
    }
    const cellWidthPx = this.columnWidths[visibleCols[visCol]] ?? 120
    const nextScrollLeft = computeScrollLeftForFocusedCell({
      cellLeftPx,
      cellWidthPx,
      scrollLeftPx: this.tableContainerEl.scrollLeft,
      viewportWidthPx: this.tableContainerEl.clientWidth || 640,
      totalPinnedWidthPx: stickyWidth,
    })
    if (nextScrollLeft !== this.tableContainerEl.scrollLeft) {
      this.tableContainerEl.scrollLeft = nextScrollLeft
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
    const { matches, matchKeys } = computeGridFindMatches(model, visibleRows, visibleCols, needle)
    this.findMatches = matches
    this.findMatchKeys = matchKeys
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
    if (!targetTd) {
      const clientHeight = this.tableContainerEl.clientHeight || 440
      const targetLineTop = this.isTransposed
        ? match.col * ROW_HEIGHT_PX
        : this.rowHeightIndex.getRowBounds(match.row).top
      this.tableContainerEl.scrollTop = Math.max(
        0,
        targetLineTop - Math.floor(clientHeight / 2)
      )
      if (this.isTransposed) {
        const capped = this.getFilteredRowIndices().slice(0, 100)
        const targetX = this.computeTransposedColLeftOffset(capped, match.row)
        const visibleW = Math.max(160, (this.tableContainerEl.clientWidth || 640) - this.transposedFieldWidth)
        this.tableContainerEl.scrollLeft = Math.max(0, targetX - Math.floor(visibleW / 3))
      }
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

  private getTransposedCacheKey(headers: string[], rowCount: number): string {
    return `${this.getColumnCacheKey(headers)}\u0000${rowCount}`
  }

  private saveColumnWidthsToCache(): void {
    if (!this.model || this.model.headers.length === 0) return
    this.columnWidthsByTable.set(this.getColumnCacheKey(this.model.headers), {
      rowNumWidth: this.rowNumWidth,
      columnWidths: [...this.columnWidths],
    })
    if (this.isTransposed || this.transposedFieldWidthInitialized) {
      this.transposedWidthsByTable.set(
        this.getTransposedCacheKey(this.model.headers, this.model.rows.length),
        {
          fieldWidth: this.transposedFieldWidth,
          rowWidths: new Map(this.transposedRowWidths),
          moreWidth: this.transposedMoreWidth,
        }
      )
    }
  }

  private computeInitialColumnWidths(model: GridModel): number[] {
    return computeInitialColumnWidthsForGrid(model, this.rowNumWidth)
  }

  private syncTransposedWidthsForModel(): void {
    if (!this.model || this.model.headers.length === 0) {
      this.transposedFieldWidth = DEFAULT_TRANSPOSED_FIELD_WIDTH_PX
      this.transposedFieldWidthInitialized = false
      this.transposedRowWidths.clear()
      this.transposedMoreWidth = DEFAULT_TRANSPOSED_MORE_WIDTH_PX
      return
    }
    const tCacheKey = this.getTransposedCacheKey(this.model.headers, this.model.rows.length)
    const cachedTransposed = this.transposedWidthsByTable.get(tCacheKey)
    if (cachedTransposed) {
      this.transposedFieldWidth = cachedTransposed.fieldWidth
      this.transposedRowWidths = new Map(cachedTransposed.rowWidths)
      this.transposedMoreWidth = cachedTransposed.moreWidth
      this.transposedFieldWidthInitialized = true
    } else {
      this.transposedFieldWidth = DEFAULT_TRANSPOSED_FIELD_WIDTH_PX
      this.transposedFieldWidthInitialized = false
      this.transposedRowWidths.clear()
      this.transposedMoreWidth = DEFAULT_TRANSPOSED_MORE_WIDTH_PX
    }
  }

  private shiftTransposedRowWidthsAfterSplice(removedIdx: number): void {
    if (this.transposedRowWidths.size === 0) return
    const next = new Map<number, number>()
    for (const [k, width] of this.transposedRowWidths.entries()) {
      if (k < removedIdx) {
        next.set(k, width)
      } else if (k > removedIdx) {
        next.set(k - 1, width)
      }
    }
    this.transposedRowWidths = next
  }

  private getTransposedRowWidth(rowIdx: number): number {
    return this.transposedRowWidths.get(rowIdx) ?? DEFAULT_TRANSPOSED_ROW_WIDTH_PX
  }

  private ensureTransposedWidths(
    indices: readonly number[],
    visibleCols: readonly number[]
  ): void {
    const model = this.model
    if (!model) return
    const capped = indices.slice(0, 100)
    const missingRow = capped.some((rowIdx) => !this.transposedRowWidths.has(rowIdx))
    if (this.transposedFieldWidthInitialized && !missingRow) return

    const computed = computeInitialTransposedColumnWidths(model, capped, visibleCols)
    if (!this.transposedFieldWidthInitialized) {
      this.transposedFieldWidth = computed.fieldWidth
      this.transposedFieldWidthInitialized = true
    }
    for (let i = 0; i < capped.length; i++) {
      const rowIdx = capped[i]
      if (!this.transposedRowWidths.has(rowIdx)) {
        this.transposedRowWidths.set(
          rowIdx,
          computed.rowWidths[i] ?? DEFAULT_TRANSPOSED_ROW_WIDTH_PX
        )
      }
    }
    this.saveColumnWidthsToCache()
  }

  private getResizeTargetWidth(colIndex: number, thEl: HTMLTableCellElement): number {
    if (this.isTransposed) {
      if (colIndex === -1) return this.transposedFieldWidth
      if (colIndex === TRANSPOSED_MORE_COL_INDEX) return this.transposedMoreWidth
      return this.transposedRowWidths.get(colIndex) || thEl.offsetWidth || DEFAULT_TRANSPOSED_ROW_WIDTH_PX
    }
    if (colIndex === -1) return this.rowNumWidth
    return this.columnWidths[colIndex] || thEl.offsetWidth || 150
  }

  private setResizeTargetWidth(colIndex: number, width: number): void {
    if (this.isTransposed) {
      if (colIndex === -1) {
        this.transposedFieldWidth = width
        this.transposedFieldWidthInitialized = true
      } else if (colIndex === TRANSPOSED_MORE_COL_INDEX) {
        this.transposedMoreWidth = width
      } else {
        this.transposedRowWidths.set(colIndex, width)
      }
      return
    }
    if (colIndex === -1) {
      this.rowNumWidth = width
    } else {
      this.columnWidths[colIndex] = width
    }
  }

  private updateTableWidthOnly(): void {
    if (!this.tableEl) return
    if (this.isTransposed) {
      const indices = this.getFilteredRowIndices()
      if (!this.model || this.model.headers.length === 0 || indices.length === 0) {
        this.tableEl.style.width = '100%'
        return
      }
      const cappedIndices = indices.slice(0, 100)
      let totalWidth =
        this.transposedFieldWidth +
        cappedIndices.reduce((sum, rowIdx) => sum + this.getTransposedRowWidth(rowIdx), 0)
      if (indices.length > 100) {
        totalWidth += this.transposedMoreWidth
      }
      this.tableEl.style.width = `${totalWidth}px`
      return
    }
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
    const matched = computeFilteredRowIndices(
      model,
      this.rowStates,
      this.clientFilter,
      this.clientColumnFilters
    )
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
    const factor: 1 | -1 = direction === 'DESC' ? -1 : 1

    const paired = model.rows.map((row, idx) => ({
      row,
      state: this.rowStates[idx],
      origIdx: idx,
    }))

    paired.sort((a, b) =>
      compareGridCellValues(
        getCellValue(a.row, colIndex, column),
        getCellValue(b.row, colIndex, column),
        factor
      )
    )

    model.rows = paired.map((p) => p.row)
    this.rowStates = paired.map((p) => p.state)
    if (this.transposedRowWidths.size > 0) {
      const remapped = new Map<number, number>()
      paired.forEach((p, newIdx) => {
        const w = this.transposedRowWidths.get(p.origIdx)
        if (w !== undefined) remapped.set(newIdx, w)
      })
      this.transposedRowWidths = remapped
    }
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
      this.tbodyEl.querySelectorAll('td.datanoa-cell-selected').forEach((cell) => {
        if (cell instanceof HTMLElement) {
          cell.classList.remove('datanoa-cell-selected')
        }
      })
      if (this.selectedRowIndex !== null && this.selectedColIndex !== null) {
        const liveTd = this.findLiveCell(this.selectedRowIndex, this.selectedColIndex)
        if (liveTd) {
          liveTd.classList.add('datanoa-cell-selected')
        }
      }
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
    const cachedRect = this.dragState?.cachedContainerRect ?? null
    const rect =
      cachedRect && cachedRect.width > 0 && cachedRect.height > 0
        ? cachedRect
        : container.getBoundingClientRect?.()
    const headerH = this.dragState?.cachedHeaderH || this.cachedHeaderHeightPx || 26
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
    const vr = this.isTransposed
      ? Math.max(
          0,
          Math.min(visibleRows.length - 1, Math.floor((container.scrollTop + relY) / ROW_HEIGHT_PX))
        )
      : Math.max(
          0,
          Math.min(
            visibleRows.length - 1,
            this.rowHeightIndex.findRowAtOffset(container.scrollTop + relY)
          )
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

    const stepAutoScroll = () => {
      if (!this.dragState || !this.tableContainerEl) return
      this.dragState.autoScrollRafId = null
      const cachedRect = this.dragState.cachedContainerRect
      const rect =
        cachedRect && cachedRect.width > 0 && cachedRect.height > 0
          ? cachedRect
          : this.tableContainerEl.getBoundingClientRect()
      const headerH = this.dragState.cachedHeaderH || this.cachedHeaderHeightPx || 26
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
          this.dragState.autoScrollRafId = requestAnimationFrame(stepAutoScroll)
        }
      }
    }

    const scheduleAutoScroll = (): void => {
      if (!this.dragState || !this.tableContainerEl) return
      if (this.dragState.autoScrollRafId !== null || typeof requestAnimationFrame !== 'function') {
        return
      }
      this.dragState.autoScrollRafId = requestAnimationFrame(stepAutoScroll)
    }

    const flushPendingMove = (): void => {
      if (!this.dragState) return
      this.dragState.moveRafId = null
      const pending = this.dragState.pendingMove
      this.dragState.pendingMove = null
      if (!pending) return
      extendFromTargetOrPoint(pending.target, pending.x, pending.y)
      scheduleAutoScroll()
    }

    const moveListener = (moveEvent: MouseEvent) => {
      if (!this.dragState) return
      this.dragState.lastClientX = moveEvent.clientX
      this.dragState.lastClientY = moveEvent.clientY
      this.dragState.pendingMove = {
        target: moveEvent.target,
        x: moveEvent.clientX,
        y: moveEvent.clientY,
      }
      if (typeof requestAnimationFrame === 'function') {
        if (this.dragState.moveRafId === null) {
          let ranSync = false
          const id = requestAnimationFrame(() => {
            ranSync = true
            flushPendingMove()
          })
          if (!ranSync && this.dragState) {
            this.dragState.moveRafId = id
          }
        }
      } else {
        flushPendingMove()
      }
    }

    const upListener = () => {
      if (this.dragState?.pendingMove) {
        if (this.dragState.moveRafId !== null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(this.dragState.moveRafId)
          this.dragState.moveRafId = null
        }
        flushPendingMove()
      }
      this.cleanupDragSelection()
    }

    const blurListener = () => {
      this.cleanupDragSelection()
    }

    const initialRect = this.tableContainerEl?.getBoundingClientRect?.() ?? null
    const initialHeaderH =
      this.theadEl?.getBoundingClientRect?.().height || this.cachedHeaderHeightPx || 26

    this.dragState = {
      mode,
      lastClientX: clientX,
      lastClientY: clientY,
      lastRow: initialFocus ? initialFocus.row : null,
      lastCol: initialFocus ? initialFocus.col : null,
      cachedContainerRect: initialRect && initialRect.width > 0 ? initialRect : null,
      cachedHeaderH: initialHeaderH,
      moveRafId: null,
      pendingMove: null,
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
    if (this.dragState.moveRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.dragState.moveRafId)
    }
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
      if (this.contextMenuEl || this.bulkFillPopoverEl || this.colFilterPopoverEl) {
        this.closeContextMenu()
        this.closeBulkFillPopover()
        this.closeColumnFilterPopover()
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
      const hadSel =
        !this.selection.isEmpty() ||
        (this.selectedRowIndex !== null && this.selectedColIndex !== null)
      const copied = this.copySelection('tsv')
      if (copied.length > 0 || hadSel) {
        const summary = this.getSelectionSummary()
        this.onNotify?.(
          summary.cellCount > 1
            ? `Copied ${summary.cellCount} cells to clipboard`
            : 'Copied selection to clipboard'
        )
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
      const maxVisRows = this.isTransposed ? Math.min(visibleRows.length, 100) : visibleRows.length
      const dRow = this.isTransposed
        ? key === 'ArrowLeft'
          ? -1
          : key === 'ArrowRight'
            ? 1
            : 0
        : key === 'ArrowUp'
          ? -1
          : key === 'ArrowDown'
            ? 1
            : 0
      const dCol = this.isTransposed
        ? key === 'ArrowUp'
          ? -1
          : key === 'ArrowDown'
            ? 1
            : 0
        : key === 'ArrowLeft'
          ? -1
          : key === 'ArrowRight'
            ? 1
            : 0
      this.selection.moveFocus(dRow, dCol, maxVisRows, visibleCols.length, e.shiftKey)
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
      let td = this.tbodyEl?.querySelector(
        `td[data-row-index="${this.selectedRowIndex}"][data-col-index="${this.selectedColIndex}"]`
      )
      if (!(td instanceof HTMLTableCellElement)) {
        this.ensureFocusCellVisible()
        td = this.tbodyEl?.querySelector(
          `td[data-row-index="${this.selectedRowIndex}"][data-col-index="${this.selectedColIndex}"]`
        )
      }
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
    if (!focus || !this.tableContainerEl || !this.tbodyEl) return
    if (this.isTransposed) {
      let td = this.tbodyEl.querySelector(
        `td[data-vis-row="${focus.row}"][data-vis-col="${focus.col}"]`
      )
      if (!td) {
        const clientHeight = this.tableContainerEl.clientHeight || 440
        const targetTop = Math.max(0, focus.col * ROW_HEIGHT_PX - Math.floor(clientHeight / 2))
        this.tableContainerEl.scrollTop = targetTop
        const capped = this.getFilteredRowIndices().slice(0, 100)
        const targetX = this.computeTransposedColLeftOffset(capped, focus.row)
        const visibleW = Math.max(160, (this.tableContainerEl.clientWidth || 640) - this.transposedFieldWidth)
        this.tableContainerEl.scrollLeft = Math.max(0, targetX - Math.floor(visibleW / 3))
        this.renderVisibleRows()
        td = this.tbodyEl.querySelector(
          `td[data-vis-row="${focus.row}"][data-vis-col="${focus.col}"]`
        )
      }
      if (td instanceof HTMLElement) {
        td.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      }
      return
    }
    let td = this.tbodyEl.querySelector(
      `td[data-vis-row="${focus.row}"][data-vis-col="${focus.col}"]`
    )
    if (!td) {
      const clientHeight = this.tableContainerEl.clientHeight || 440
      const targetRowTop = this.rowHeightIndex.getRowBounds(focus.row).top
      const targetTop = Math.max(0, targetRowTop - Math.floor(clientHeight / 2))
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

  private isGridVisibleForGlobalEvent(target: EventTarget | null): boolean {
    if (this.isLoading || this.interactionLocked || !this.model || !this.model.canEdit) {
      return false
    }
    if (
      this.activeEditor !== null ||
      this.contextMenuEl ||
      this.bulkFillPopoverEl ||
      this.colFilterPopoverEl
    ) {
      return false
    }
    if (!this.tableContainerEl || !this.tableContainerEl.isConnected) return false
    if (this.tableContainerEl.offsetParent === null) return false
    if (typeof this.container.closest === 'function' && this.container.closest('[hidden]')) {
      return false
    }
    if (isEditableInputTarget(target)) return false
    const nonGridRegionSelector =
      '.cm-editor, .datanoa-sql-area, .datanoa-sql-toolbar, .datanoa-console-tabs, .datanoa-value-inspector, .datanoa-history-drawer, .datanoa-dml-preview, .datanoa-inspector-view, .datanoa-sidebar, .datanoa-columns-popover'
    if (typeof document !== 'undefined') {
      if (isEditableInputTarget(document.activeElement)) return false
      if (document.querySelector('.datanoa-modal-backdrop')) return false
      const activeEl = document.activeElement
      if (activeEl instanceof Element && activeEl.closest(nonGridRegionSelector)) {
        return false
      }
    }
    if (target instanceof Element && target.closest(nonGridRegionSelector)) {
      return false
    }
    return true
  }

  private notifyPasteOutcome(outcome: {
    updatedCells: number
    insertedRows: number
    skippedReadOnly: number
    mode: string
  }): void {
    const { updatedCells, insertedRows, skippedReadOnly } = outcome
    const skippedNote =
      skippedReadOnly > 0 ? ` (${skippedReadOnly} read-only/PK skipped)` : ''
    if (updatedCells > 0 && insertedRows > 0) {
      this.onNotify?.(
        `Overwrote ${updatedCells} cell${updatedCells === 1 ? '' : 's'} and inserted ${insertedRows} new row${insertedRows === 1 ? '' : 's'} (marked PASTE)${skippedNote} — review & click Submit`
      )
    } else if (insertedRows > 0) {
      this.onNotify?.(
        `Pasted ${insertedRows} new row${insertedRows === 1 ? '' : 's'} (marked PASTE)${skippedNote} — review & click Submit`
      )
    } else if (updatedCells > 0) {
      const submitHint = !this.batchMode ? ' into staged edits — click Submit to save' : ''
      this.onNotify?.(
        `Pasted ${updatedCells} cell${updatedCells === 1 ? '' : 's'}${submitHint}${skippedNote}`
      )
    } else if (skippedReadOnly > 0) {
      this.onNotify?.(
        'Selected cell(s) are read-only, deleted, or primary key — clear selection (Esc) or use Ctrl+Shift+V to paste as new rows'
      )
    }
  }

  private handleGridPaste(e: ClipboardEvent): void {
    if (this.activeEditor !== null || isEditableInputTarget(e.target)) return
    if (this.interactionLocked || !this.model || !this.model.canEdit) return
    const rawText = e.clipboardData?.getData('text/plain') ?? e.clipboardData?.getData('text') ?? ''
    const isCopiedNullCell =
      rawText === '' &&
      this.lastCopiedSnapshot !== null &&
      this.lastCopiedSnapshot.text === '' &&
      this.lastCopiedSnapshot.rawMatrix.length === 1 &&
      this.lastCopiedSnapshot.rawMatrix[0]?.length === 1
    if (!rawText && !isCopiedNullCell) return
    e.preventDefault()
    const outcome = this.pasteDelimitedTextDetailed(rawText, { forceNewRows: false })
    this.notifyPasteOutcome(outcome)
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

  private buildTransposedHeaderCell(
    labelText: string,
    colIndex: number,
    widthPx: number,
    extraClass?: string,
    attachHandle = true
  ): HTMLTableCellElement {
    const th = document.createElement('th')
    th.className = extraClass ? `datanoa-th ${extraClass}` : 'datanoa-th'
    if (attachHandle) {
      th.style.width = `${widthPx}px`
    }
    const inner = document.createElement('div')
    inner.className = 'datanoa-th-inner'
    const label = document.createElement('span')
    label.className = 'datanoa-th-label'
    label.textContent = labelText
    label.title = labelText
    inner.appendChild(label)
    th.appendChild(inner)
    if (attachHandle) {
      th.appendChild(this.createResizeHandle(colIndex, th))
    }
    return th
  }

  private syncOrderedChildren(
    parent: HTMLElement,
    desired: readonly HTMLElement[]
  ): void {
    const desiredSet = new Set<HTMLElement>(desired)
    let child: Element | null = parent.firstElementChild
    while (child) {
      const next = child.nextElementSibling
      if (!desiredSet.has(child as HTMLElement)) {
        child.remove()
      }
      child = next
    }
    for (let i = 0; i < desired.length; i++) {
      const target = desired[i]
      const currentAtIdx = parent.children[i]
      if (currentAtIdx !== target) {
        parent.insertBefore(target, currentAtIdx ?? null)
      }
    }
  }

  private buildNormalHeaderCell(
    modelColIdx: number,
    header: string,
    colOccKey: string
  ): PooledNormalHeaderCell {
    const th = document.createElement('th')
    th.className = 'datanoa-th'
    th.dataset.colIndex = String(modelColIdx)

    const inner = document.createElement('div')
    inner.className = 'datanoa-th-inner'

    const labelEl = document.createElement('span')
    labelEl.className = 'datanoa-th-label'
    labelEl.textContent = header
    labelEl.title = header
    inner.appendChild(labelEl)

    const filterBtn = document.createElement('button')
    filterBtn.type = 'button'
    filterBtn.className = 'datanoa-col-filter-btn'
    filterBtn.setAttribute('aria-label', `Filter column ${header}`)
    filterBtn.appendChild(createColFilterSvg())
    filterBtn.addEventListener('mousedown', (e) => {
      e.stopPropagation()
    })
    filterBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.openColumnFilterPopover(header, filterBtn)
    })
    inner.appendChild(filterBtn)

    const selectBtn = document.createElement('button')
    selectBtn.type = 'button'
    selectBtn.className = 'datanoa-col-select-btn'
    selectBtn.title = `Select column "${header}"`
    selectBtn.setAttribute('aria-label', `Select column ${header}`)
    selectBtn.appendChild(createColSelectSvg())
    selectBtn.addEventListener('mousedown', (e) => {
      e.stopPropagation()
    })
    selectBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.focusGridContainer()
      const visCol = parseOptionalInt(th.dataset.visCol) ?? 0
      const rowCount = this.getFilteredRowIndices().length
      this.selection.selectColumn(visCol, rowCount, {
        shift: e.shiftKey,
        toggle: e.ctrlKey || e.metaKey,
      })
      this.syncSelectionClasses()
      this.notifyAllSelectionListeners()
    })
    inner.appendChild(selectBtn)

    th.appendChild(inner)
    th.appendChild(this.createResizeHandle(modelColIdx, th))

    th.addEventListener('click', (e) => {
      if (Date.now() < this.suppressSortClickUntil) return
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        e.preventDefault()
        this.focusGridContainer()
        const visCol = parseOptionalInt(th.dataset.visCol) ?? 0
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
      const visCol = parseOptionalInt(th.dataset.visCol) ?? 0
      this.openHeaderContextMenu(e.clientX, e.clientY, modelColIdx, visCol, header, th)
    })

    th.draggable = true
    th.addEventListener('dragstart', (e) => {
      this.draggedHeaderName = colOccKey
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', colOccKey)
      }
    })
    th.addEventListener('dragover', (e) => {
      if (this.draggedHeaderName && this.draggedHeaderName !== colOccKey) {
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
        th.classList.add('datanoa-th-drop-target')
      }
    })
    th.addEventListener('dragleave', () => {
      th.classList.remove('datanoa-th-drop-target')
    })
    th.addEventListener('drop', (e) => {
      e.preventDefault()
      th.classList.remove('datanoa-th-drop-target')
      const from = this.draggedHeaderName || e.dataTransfer?.getData('text/plain') || ''
      this.draggedHeaderName = null
      if (from && from !== colOccKey) {
        this.reorderColumn(from, colOccKey, 'before')
      }
    })
    th.addEventListener('dragend', () => {
      this.draggedHeaderName = null
      th.classList.remove('datanoa-th-drop-target')
    })

    return {
      th,
      inner,
      labelEl,
      filterBtn,
      selectBtn,
      pinIcon: null,
      sortIcon: null,
      sortDir: null,
    }
  }

  private renderHeader(): void {
    this.cleanupColumnResize()
    if (!this.theadEl) return

    if (this.isLoading) {
      this.resetHeaderPool()
      this.theadEl.innerHTML = ''
      this.headerThByModelIdx.clear()
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
    if (!model) {
      this.resetHeaderPool()
      this.theadEl.innerHTML = ''
      this.headerThByModelIdx.clear()
      return
    }

    if (this.isTransposed) {
      this.resetHeaderPool()
      this.theadEl.innerHTML = ''
      this.headerThByModelIdx.clear()
      const tr = document.createElement('tr')
      const indices = this.getFilteredRowIndices()
      const visibleCols = this.getVisibleColumnIndices()
      if (model.headers.length === 0 || indices.length === 0) {
        this.clearColgroup()
        const thField = this.buildTransposedHeaderCell(
          'Field',
          -1,
          this.transposedFieldWidth,
          'datanoa-th-row-label',
          false
        )
        tr.appendChild(thField)
        this.theadEl.appendChild(tr)
        this.updateTableWidthOnly()
        return
      }

      this.ensureTransposedWidths(indices, visibleCols)
      const cappedIndices = indices.slice(0, 100)
      const colgroup = this.colgroupEl
      this.dataColElByModelIdx.clear()
      if (colgroup) {
        colgroup.innerHTML = ''
        const fieldCol = document.createElement('col')
        fieldCol.style.width = `${this.transposedFieldWidth}px`
        colgroup.appendChild(fieldCol)
        this.rowNumColEl = fieldCol

        for (const rowIdx of cappedIndices) {
          const rowCol = document.createElement('col')
          rowCol.style.width = `${this.getTransposedRowWidth(rowIdx)}px`
          colgroup.appendChild(rowCol)
          this.dataColElByModelIdx.set(rowIdx, rowCol)
        }
        if (indices.length > 100) {
          const moreCol = document.createElement('col')
          moreCol.style.width = `${this.transposedMoreWidth}px`
          colgroup.appendChild(moreCol)
          this.dataColElByModelIdx.set(TRANSPOSED_MORE_COL_INDEX, moreCol)
        }
      }

      tr.appendChild(
        this.buildTransposedHeaderCell(
          'Field',
          -1,
          this.transposedFieldWidth,
          'datanoa-th-row-label'
        )
      )

      for (const rowIdx of cappedIndices) {
        const state = this.rowStates[rowIdx]
        const suffix =
          state?.kind === 'inserted' ? ' (+)' : state?.deleted ? ' (DEL)' : ''
        tr.appendChild(
          this.buildTransposedHeaderCell(
            `Row ${rowIdx + 1}${suffix}`,
            rowIdx,
            this.getTransposedRowWidth(rowIdx),
            'datanoa-th-transpose-row'
          )
        )
      }
      if (indices.length > 100) {
        tr.appendChild(
          this.buildTransposedHeaderCell(
            `+${indices.length - 100} more rows`,
            TRANSPOSED_MORE_COL_INDEX,
            this.transposedMoreWidth,
            'datanoa-th-transpose-row'
          )
        )
      }
      this.theadEl.appendChild(tr)
      this.updateTableWidthOnly()
      if (this.headerHeightMeasuredTransposed !== true) {
        const measuredH = this.theadEl.offsetHeight || 0
        this.cachedHeaderHeightPx = measuredH > 0 && measuredH <= 80 ? measuredH : 26
        this.headerHeightMeasuredTransposed = true
      }
      return
    }

    if (model.headers.length === 0) {
      this.resetHeaderPool()
      this.theadEl.innerHTML = ''
      this.headerThByModelIdx.clear()
      this.clearColgroup()
      this.theadEl.appendChild(document.createElement('tr'))
      return
    }

    const visibleCols = this.getVisibleColumnIndices()
    const pinnedCount = this.getPinnedVisibleCount(visibleCols)
    const pinnedOffsets = this.computePinnedLeftOffsets(visibleCols, pinnedCount)

    const canReuseHeaderDom =
      this.cachedHeaderModelRef === model &&
      this.cachedHeaderTr !== null &&
      this.cachedHeaderTr.parentNode === this.theadEl &&
      this.cachedRowNumTh !== null &&
      this.rowNumColEl !== null

    if (!canReuseHeaderDom) {
      this.resetHeaderPool()
      this.theadEl.innerHTML = ''
      if (this.colgroupEl) {
        this.colgroupEl.innerHTML = ''
      }
      this.cachedHeaderModelRef = model
      const idxCol = document.createElement('col')
      idxCol.className = 'datanoa-col-rownum'
      this.rowNumColEl = idxCol

      const thIdx = document.createElement('th')
      thIdx.className = 'datanoa-th datanoa-th-rownum'
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
      this.cachedRowNumTh = thIdx

      const tr = document.createElement('tr')
      this.cachedHeaderTr = tr
      this.theadEl.appendChild(tr)
    }

    const rowNumWidthPx = `${this.rowNumWidth}px`
    if (this.rowNumColEl && this.rowNumColEl.style.width !== rowNumWidthPx) {
      this.rowNumColEl.style.width = rowNumWidthPx
    }
    if (this.cachedRowNumTh && this.cachedRowNumTh.style.width !== rowNumWidthPx) {
      this.cachedRowNumTh.style.width = rowNumWidthPx
    }

    const tr = this.cachedHeaderTr
    if (!tr) return
    const colgroup = this.colgroupEl
    this.dataColElByModelIdx.clear()
    this.headerThByModelIdx.clear()

    const desiredCols: HTMLElement[] = this.rowNumColEl ? [this.rowNumColEl] : []
    const desiredThs: HTMLElement[] = this.cachedRowNumTh ? [this.cachedRowNumTh] : []
    const headerOccKeys = this.getColKeyResolver()?.occKeys ?? []
    const activeFilterCols =
      this.clientColumnFilters.length > 0
        ? new Set(this.clientColumnFilters.map((f) => f.column))
        : null

    for (let visCol = 0; visCol < visibleCols.length; visCol++) {
      const modelColIdx = visibleCols[visCol]
      const header = model.headers[modelColIdx]
      const colOccKey = headerOccKeys[modelColIdx] ?? header
      const colWidthPx = `${this.columnWidths[modelColIdx] ?? 120}px`

      let colEl = this.cachedColPoolByModelIdx.get(modelColIdx)
      if (!colEl) {
        colEl = document.createElement('col')
        this.cachedColPoolByModelIdx.set(modelColIdx, colEl)
      }
      if (colEl.style.width !== colWidthPx) {
        colEl.style.width = colWidthPx
      }
      this.dataColElByModelIdx.set(modelColIdx, colEl)
      desiredCols.push(colEl)

      let entry = this.cachedThPoolByModelIdx.get(modelColIdx)
      if (!entry) {
        entry = this.buildNormalHeaderCell(modelColIdx, header, colOccKey)
        this.cachedThPoolByModelIdx.set(modelColIdx, entry)
      }
      const { th, inner, labelEl, filterBtn } = entry
      const isSorted = this.sortColumn === header
      const isPinned = visCol < pinnedCount
      const isLastPinned = isPinned && visCol === pinnedCount - 1
      const isSelectedCol = this.selection.isColSelected(visCol)

      th.classList.toggle('sorted', isSorted)
      th.classList.toggle('datanoa-th-selected', isSelectedCol)
      th.classList.toggle('datanoa-col-pinned', isPinned)
      th.classList.toggle('datanoa-col-pinned-last', isLastPinned)
      const nextLeft = isPinned ? `${pinnedOffsets[visCol]}px` : ''
      if (th.style.left !== nextLeft) th.style.left = nextLeft
      if (th.style.width !== colWidthPx) th.style.width = colWidthPx
      const visColStr = String(visCol)
      if (th.dataset.visCol !== visColStr) th.dataset.visCol = visColStr

      if (isPinned) {
        if (!entry.pinIcon) {
          const pinIcon = document.createElement('span')
          pinIcon.className = 'datanoa-th-pin-icon'
          pinIcon.title = 'Pinned column'
          pinIcon.appendChild(createPinSvg())
          entry.pinIcon = pinIcon
        }
        if (entry.pinIcon.parentNode !== inner) {
          inner.insertBefore(entry.pinIcon, labelEl)
        }
      } else if (entry.pinIcon && entry.pinIcon.parentNode === inner) {
        entry.pinIcon.remove()
      }

      const hasColFilter = activeFilterCols !== null && activeFilterCols.has(header)
      filterBtn.classList.toggle('active', hasColFilter)
      const nextFilterTitle = hasColFilter
        ? `Filter active on "${header}" — click to edit`
        : `Filter column "${header}"`
      if (filterBtn.title !== nextFilterTitle) {
        filterBtn.title = nextFilterTitle
      }

      if (isSorted) {
        const dir: 'ASC' | 'DESC' = this.sortDirection === 'DESC' ? 'DESC' : 'ASC'
        if (!entry.sortIcon) {
          const sortIcon = document.createElement('span')
          sortIcon.className = 'datanoa-th-sort-icon'
          entry.sortIcon = sortIcon
        }
        if (entry.sortDir !== dir || entry.sortIcon.childElementCount === 0) {
          entry.sortIcon.textContent = ''
          entry.sortIcon.appendChild(createSortArrowSvg(dir))
          entry.sortDir = dir
        }
        if (entry.sortIcon.parentNode !== inner) {
          inner.appendChild(entry.sortIcon)
        }
      } else if (entry.sortIcon && entry.sortIcon.parentNode === inner) {
        entry.sortIcon.remove()
      }

      this.headerThByModelIdx.set(modelColIdx, th)
      desiredThs.push(th)
    }

    if (colgroup) {
      this.syncOrderedChildren(colgroup, desiredCols)
    }
    this.syncOrderedChildren(tr, desiredThs)

    this.updateTableWidthOnly()
    if (this.headerHeightMeasuredTransposed !== false) {
      const measuredH = this.theadEl.offsetHeight || 0
      this.cachedHeaderHeightPx = measuredH > 0 && measuredH <= 80 ? measuredH : 26
      this.headerHeightMeasuredTransposed = false
    }
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
    if (this.activeResizeGuideEl) {
      this.activeResizeGuideEl.remove()
      this.activeResizeGuideEl = null
    }
    if (this.tableContainerEl) {
      this.tableContainerEl.classList.remove('datanoa-grid-resizing')
    }
    if (typeof document !== 'undefined' && document.body) {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }

  private computeTransposedAutoFitWidth(model: GridModel, colIndex: number): number {
    const visibleCols = this.getVisibleColumnIndices()
    if (colIndex === -1) {
      let maxChars = 'Field'.length + 1
      for (const modelColIdx of visibleCols) {
        const header = model.headers[modelColIdx] ?? ''
        const isPk = model.primaryKey.includes(header)
        const colDef = model.columns[modelColIdx]
        const colType = colDef && 'type' in colDef && colDef.type ? ` : ${colDef.type}` : ''
        maxChars = Math.max(maxChars, header.length + (isPk ? 5 : 0) + colType.length)
      }
      return Math.max(80, Math.min(480, Math.round(maxChars * 7.5 + 28)))
    }
    if (colIndex === TRANSPOSED_MORE_COL_INDEX) {
      const moreCount = Math.max(1, this.getFilteredRowIndices().length - 100)
      const maxChars = Math.max(
        `+${moreCount} more rows`.length,
        `... (${moreCount} more)`.length
      )
      return Math.max(90, Math.min(360, Math.round(maxChars * 7.5 + 24)))
    }
    const rowIdx = colIndex
    const rowData = model.rows[rowIdx]
    const state = this.rowStates[rowIdx]
    const suffix = state?.kind === 'inserted' ? ' (+)' : state?.deleted ? ' (DEL)' : ''
    let maxChars = `Row ${rowIdx + 1}${suffix}`.length + 2
    for (const modelColIdx of visibleCols) {
      const header = model.headers[modelColIdx] ?? ''
      const colDef = model.columns[modelColIdx]
      const colType = colDef && 'type' in colDef ? colDef.type : undefined
      const raw = rowData ? getCellValue(rowData, modelColIdx, header) : undefined
      const text =
        state?.kind === 'inserted' && raw === undefined && !state.dirtyCols.has(header)
          ? '(default)'
          : formatCellValue(raw, colType).text
      maxChars = Math.max(maxChars, Math.min(text.length, 80))
    }
    return Math.max(80, Math.min(480, Math.round(maxChars * 7.5 + 24)))
  }

  private syncTransposedHorizontalWindowAfterResize(): void {
    if (!this.isTransposed || !this.model || this.isLoading) return
    const indices = this.getFilteredRowIndices()
    if (indices.length === 0) return
    const capped = indices.slice(0, 100)
    const hasOverflow = indices.length > 100
    const nextH = this.computeTransposedColRange(capped, hasOverflow)
    if (nextH.hStart !== this.lastTransposedHStart || nextH.hEnd !== this.lastTransposedHEnd) {
      this.renderVisibleRows()
    }
  }

  private autoFitColumn(colIndex: number, thEl: HTMLTableCellElement): void {
    const model = this.model
    if (!model) return
    const colEl =
      colIndex === -1 ? this.rowNumColEl : (this.dataColElByModelIdx.get(colIndex) ?? null)

    let fittedWidth: number
    if (this.isTransposed) {
      fittedWidth = this.computeTransposedAutoFitWidth(model, colIndex)
      this.setResizeTargetWidth(colIndex, fittedWidth)
    } else if (colIndex === -1) {
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
      const occKey = this.getColKeyResolver()?.occKeys[colIndex]
      if (occKey) {
        this.userResizedColumnKeys.add(occKey)
      }
    }

    if (colEl) colEl.style.width = `${fittedWidth}px`
    thEl.style.width = `${fittedWidth}px`
    this.updateTableWidthOnly()
    if (!this.isTransposed) {
      this.updatePinnedOffsets()
    }
    this.invalidateColLayoutCache()
    if (this.isTransposed) {
      if (this.lastTransposedWindow) {
        this.lastTransposedWindow.colLayoutVersion = this.colLayoutVersion
      }
      this.syncTransposedHorizontalWindowAfterResize()
    }
    this.saveColumnWidthsToCache()
    if (!this.isTransposed && colIndex >= 0) {
      this.notifyTableDisplayStateChanged()
    }
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
    const startWidth = this.getResizeTargetWidth(colIndex, thEl)
    const minWidth = this.isTransposed
      ? colIndex === -1
        ? 80
        : 64
      : colIndex === -1
        ? 36
        : 50
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
    const mountedRowCount = this.tbodyEl?.children.length ?? 0
    const colCount = this.isTransposed
      ? Math.min(this.getFilteredRowIndices().length, 100) + 1
      : visibleCols.length + 1
    const useGuideLine = this.isTransposed || mountedRowCount * Math.max(1, colCount) >= 400

    this.activeResizeHandle = handleEl
    handleEl.classList.add('resizing')
    if (typeof document !== 'undefined' && document.body) {
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    }

    let pendingWidth = startWidth
    let lastAppliedWidth = startWidth
    let guideEl: HTMLDivElement | null = null
    let baseGuideX = startX
    let guideMinX = -Infinity
    let guideMaxX = Infinity

    if (useGuideLine && typeof document !== 'undefined') {
      if (this.tableContainerEl) {
        this.tableContainerEl.classList.add('datanoa-grid-resizing')
      }
      const handleRect = handleEl.getBoundingClientRect?.()
      const containerRect = this.tableContainerEl?.getBoundingClientRect?.()
      if (handleRect && handleRect.width > 0) {
        baseGuideX = handleRect.left + handleRect.width / 2
      }
      if (containerRect && containerRect.width > 0) {
        guideMinX = containerRect.left
        guideMaxX = containerRect.right
      }
      guideEl = document.createElement('div')
      guideEl.className = 'datanoa-resize-guide'
      const guideTop = containerRect && containerRect.height > 0 ? Math.round(containerRect.top) : 0
      const guideHeight =
        containerRect && containerRect.height > 0 ? Math.round(containerRect.height) : 440
      guideEl.style.top = `${guideTop}px`
      guideEl.style.height = `${guideHeight}px`
      const clampedInitX = Math.max(guideMinX, Math.min(guideMaxX, Math.round(baseGuideX)))
      guideEl.style.transform = `translate3d(${clampedInitX}px, 0, 0)`
      const hostParent = document.body || this.container
      hostParent.appendChild(guideEl)
      this.activeResizeGuideEl = guideEl
    }

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

    const applyGuidePosition = () => {
      this.resizeRafId = null
      if (!guideEl) return
      const rawX = Math.round(baseGuideX + (pendingWidth - startWidth))
      const clampedX = Math.max(guideMinX, Math.min(guideMaxX, rawX))
      guideEl.style.transform = `translate3d(${clampedX}px, 0, 0)`
    }

    const applyPendingResizeDom = () => {
      this.resizeRafId = null
      if (pendingWidth === lastAppliedWidth) return
      lastAppliedWidth = pendingWidth
      this.setResizeTargetWidth(colIndex, pendingWidth)
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
      if (!useGuideLine) {
        this.setResizeTargetWidth(colIndex, newWidth)
      }
      const tickFn = useGuideLine ? applyGuidePosition : applyPendingResizeDom
      if (useRafOnly) {
        if (this.resizeRafId === null) {
          this.resizeRafId = requestAnimationFrame(tickFn)
        }
      } else {
        tickFn()
      }
    }

    const finishResize = () => {
      if (this.resizeRafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.resizeRafId)
        this.resizeRafId = null
      }
      const committedChange = pendingWidth !== lastAppliedWidth
      if (committedChange) {
        applyPendingResizeDom()
      }
      this.cleanupColumnResize()
      if (didMove || committedChange) {
        this.invalidateColLayoutCache()
        if (this.isTransposed) {
          if (this.lastTransposedWindow) {
            this.lastTransposedWindow.colLayoutVersion = this.colLayoutVersion
          }
          this.syncTransposedHorizontalWindowAfterResize()
        } else if (this.lastRenderedWindow) {
          this.lastRenderedWindow.colLayoutVersion = this.colLayoutVersion
        }
      }
      if (didMove) {
        this.suppressSortClickUntil = Date.now() + 250
      }
      this.saveColumnWidthsToCache()
      if (!this.isTransposed && colIndex >= 0 && (didMove || committedChange) && this.model) {
        const occKey = this.getColKeyResolver()?.occKeys[colIndex]
        if (occKey) {
          this.userResizedColumnKeys.add(occKey)
        }
        this.notifyTableDisplayStateChanged()
      }
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

  private acquirePooledDataCell(): HTMLTableCellElement {
    const reused = this.freeCellPool.pop()
    if (reused) {
      return reused
    }
    return this.createPooledDataCell()
  }

  private releasePooledDataCell(td: HTMLTableCellElement): void {
    td.remove()
    if (this.freeCellPool.length < 512) {
      td.className = 'datanoa-td'
      if (td.style.left) td.style.left = ''
      this.freeCellPool.push(td)
    }
  }

  private acquirePooledRow(colCount: number): PooledGridRow {
    const existing = this.freeRowPool.pop()
    if (existing) {
      this.resetPooledRowStyles(existing)
      delete existing.tr.dataset.wrapped
      existing.cellByModelCol.clear()
      while (existing.dataCells.length < colCount) {
        const td = this.acquirePooledDataCell()
        existing.dataCells.push(td)
        existing.tr.appendChild(td)
      }
      while (existing.dataCells.length > colCount) {
        const removed = existing.dataCells.pop()
        if (removed) this.releasePooledDataCell(removed)
      }
      return existing
    }

    const tr = document.createElement('tr')
    const rowNumTd = document.createElement('td')
    tr.appendChild(rowNumTd)
    const dataCells = new Array<HTMLTableCellElement>(colCount)
    for (let i = 0; i < colCount; i++) {
      const td = this.acquirePooledDataCell()
      dataCells[i] = td
      tr.appendChild(td)
    }
    return { tr, rowNumTd, dataCells, cellByModelCol: new Map<number, HTMLTableCellElement>() }
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

    // In Staged/Batch mode (or inserted rows), keep the local staged draft in memory.
    // In Auto-Commit mode, NEVER auto-commit live DB writes on virtual scroll rebuild —
    // cancel cleanly so accidental wheel scrolling cannot persist unfinished text.
    if (this.batchMode || this.getStagedCount() > 0 || rowState?.kind === 'inserted') {
      if (this.stageCellValueInMemory(ed.rowIndex, ed.colIndex, newValue)) {
        this.invalidateDataCache()
        this.invalidateFilterCache()
        this.onStageChange?.(this.getStagedCount())
        this.notifyAllSelectionListeners()
      }
      return
    }

    const liveTd = this.findLiveCell(ed.rowIndex, ed.colIndex)
    if (liveTd) {
      this.refreshSingleCellDisplay(liveTd, ed.rowIndex, ed.colIndex, columnName, ed.originalValue)
    }
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
    const isWrapped = this.wrapCells && !this.isTransposed
    if (isWrapped) trClass += ' datanoa-tr-wrap'
    const evaluatedHighlight = this.evaluateRowHighlightState(model, rowIndex)
    if (evaluatedHighlight?.rowClass) {
      trClass += ` ${evaluatedHighlight.rowClass}`
    }

    const { tr, rowNumTd, dataCells } = pooled
    tr.className = trClass
    tr.dataset.rowIndex = String(rowIndex)
    tr.dataset.visRow = String(visRow)
    if (isWrapped) {
      tr.dataset.wrapped = 'true'
      tr.style.height = `${this.rowHeightIndex.getRowHeight(visRow)}px`
    } else {
      delete tr.dataset.wrapped
      if (tr.style.height) tr.style.height = ''
    }

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
            : rowState.origin === 'import'
              ? 'IMPORT'
              : 'NEW'
      rowNumTd.title =
        rowState.origin === 'clone'
          ? `Cloned row #${rowIndex + 1} (staged INSERT — click Submit to save)`
          : rowState.origin === 'paste'
            ? `Pasted new row #${rowIndex + 1} (staged INSERT — click Submit to save)`
            : rowState.origin === 'import'
              ? `Imported row #${rowIndex + 1} (staged INSERT — click Submit to save)`
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
    const occKeys =
      evaluatedHighlight && colCount > 0 ? (this.getColKeyResolver()?.occKeys ?? null) : null
    pooled.cellByModelCol.clear()
    for (let visCol = 0; visCol < colCount; visCol++) {
      const colIdx = visibleCols[visCol]
      const header = model.headers[colIdx]
      const td = dataCells[visCol]
      td.dataset.rowIndex = String(rowIndex)
      td.dataset.colIndex = String(colIdx)
      td.dataset.visRow = String(visRow)
      td.dataset.visCol = String(visCol)
      pooled.cellByModelCol.set(colIdx, td)
      const rawValue = getCellValue(rowData, colIdx, header)
      const cellHl = this.resolveCellHighlightClass(evaluatedHighlight, occKeys, colIdx, header)
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
        visCol < pinnedCount && visCol === pinnedCount - 1,
        cellHl
      )
    }
  }

  private patchMountedRowColumnsInPlace(
    pooled: PooledGridRow,
    visRow: number,
    rowIndex: number,
    model: GridModel,
    visibleCols: number[],
    visibleColSet: ReadonlySet<number>,
    pinnedCount: number,
    pinnedOffsets: number[],
    focus: CellCoord | null,
    activeMatch: CellCoord | null,
    occKeys: readonly string[] | null
  ): void {
    const { tr, rowNumTd } = pooled
    const isWrapped = this.wrapCells && !this.isTransposed
    if (isWrapped) {
      const nextH = `${this.rowHeightIndex.getRowHeight(visRow)}px`
      if (tr.style.height !== nextH) tr.style.height = nextH
    } else if (tr.style.height) {
      tr.style.height = ''
    }

    const isRowSel = this.selection.isRowSelected(visRow)
    tr.classList.toggle('datanoa-row-selected', isRowSel)
    rowNumTd.classList.toggle('row-selected', isRowSel)

    // Remove cells belonging to newly hidden columns
    for (const [colIdx, oldTd] of Array.from(pooled.cellByModelCol.entries())) {
      if (!visibleColSet.has(colIdx)) {
        pooled.cellByModelCol.delete(colIdx)
        this.releasePooledDataCell(oldTd)
      }
    }

    const rowData = model.rows[rowIndex]
    const rowState = this.rowStates[rowIndex]
    const hasSelection = !this.selection.isEmpty() || focus !== null
    const hasFind = this.findMatchKeys.size > 0
    let evaluatedHighlight: EvaluatedRowHighlight | null | undefined
    const nextDataCells = new Array<HTMLTableCellElement>(visibleCols.length)

    for (let visCol = 0; visCol < visibleCols.length; visCol++) {
      const colIdx = visibleCols[visCol]
      let td = pooled.cellByModelCol.get(colIdx)
      const pinnedLeft = visCol < pinnedCount ? pinnedOffsets[visCol] : null
      const isLastPinned = pinnedLeft !== null && visCol === pinnedCount - 1
      const visColStr = String(visCol)

      if (!td) {
        td = this.acquirePooledDataCell()
        td.dataset.rowIndex = String(rowIndex)
        td.dataset.colIndex = String(colIdx)
        td.dataset.visRow = String(visRow)
        td.dataset.visCol = visColStr
        if (evaluatedHighlight === undefined) {
          evaluatedHighlight = this.evaluateRowHighlightState(model, rowIndex)
        }
        const header = model.headers[colIdx]
        const rawValue = getCellValue(rowData, colIdx, header)
        const cellHl = this.resolveCellHighlightClass(evaluatedHighlight, occKeys, colIdx, header)
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
          pinnedLeft,
          isLastPinned,
          cellHl
        )
        pooled.cellByModelCol.set(colIdx, td)
      } else {
        if (td.dataset.visCol !== visColStr) td.dataset.visCol = visColStr
        if (pinnedLeft !== null) {
          const leftPx = `${pinnedLeft}px`
          if (!td.classList.contains('datanoa-col-pinned')) td.classList.add('datanoa-col-pinned')
          td.classList.toggle('datanoa-col-pinned-last', isLastPinned)
          if (td.style.left !== leftPx) td.style.left = leftPx
        } else {
          if (td.classList.contains('datanoa-col-pinned')) td.classList.remove('datanoa-col-pinned')
          if (td.classList.contains('datanoa-col-pinned-last')) {
            td.classList.remove('datanoa-col-pinned-last')
          }
          if (td.style.left) td.style.left = ''
        }
        if (hasSelection) {
          const inRange = this.selection.isSelected(visRow, visCol)
          const isFocus = focus !== null && focus.row === visRow && focus.col === visCol
          td.classList.toggle('datanoa-cell-selected', isFocus)
          td.classList.toggle('datanoa-cell-in-range', inRange)
          if (inRange) {
            const edges = this.selection.getCellSelectionEdges(visRow, visCol)
            td.classList.toggle('datanoa-range-top', edges.top)
            td.classList.toggle('datanoa-range-right', edges.right)
            td.classList.toggle('datanoa-range-bottom', edges.bottom)
            td.classList.toggle('datanoa-range-left', edges.left)
          } else if (
            td.classList.contains('datanoa-range-top') ||
            td.classList.contains('datanoa-range-right') ||
            td.classList.contains('datanoa-range-bottom') ||
            td.classList.contains('datanoa-range-left')
          ) {
            td.classList.remove(
              'datanoa-range-top',
              'datanoa-range-right',
              'datanoa-range-bottom',
              'datanoa-range-left'
            )
          }
        } else if (
          td.classList.contains('datanoa-cell-selected') ||
          td.classList.contains('datanoa-cell-in-range')
        ) {
          td.classList.remove(
            'datanoa-cell-selected',
            'datanoa-cell-in-range',
            'datanoa-range-top',
            'datanoa-range-right',
            'datanoa-range-bottom',
            'datanoa-range-left'
          )
        }
        if (hasFind) {
          const isMatch = this.findMatchKeys.has(`${visRow}:${visCol}`)
          const isActive =
            isMatch && activeMatch !== null && activeMatch.row === visRow && activeMatch.col === visCol
          td.classList.toggle('datanoa-cell-match', isMatch)
          td.classList.toggle('datanoa-cell-match-active', isActive)
        } else if (td.classList.contains('datanoa-cell-match')) {
          td.classList.remove('datanoa-cell-match', 'datanoa-cell-match-active')
        }
      }

      const curChild = tr.children[visCol + 1]
      if (curChild !== td) {
        tr.insertBefore(td, curChild ?? null)
      }
      nextDataCells[visCol] = td
    }
    pooled.dataCells = nextDataCells
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

    let indices = this.getFilteredRowIndices()

    if (this.isTransposed) {
      if (this.isPoolMountedInTbody) {
        this.resetRowPoolMountState()
      }
      if (this.tableEl) {
        this.tableEl.classList.remove('datanoa-grid-empty-table', 'datanoa-grid-empty-no-cols')
      }
      this.renderTransposedBody(indices, force)
      return
    }

    if (!this.isTransposed && this.isTransposedPoolMounted) {
      this.resetRowPoolMountState()
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
    let totalVisibleRows = indices.length
    const headerH = this.cachedHeaderHeightPx || 26
    const bottomCushionPx = 28
    const computeWindowBounds = (rowCount: number) => {
      if (this.rowHeightIndex.rowCount !== rowCount) {
        this.syncRowHeightIndex()
      }
      const totalDataH = this.rowHeightIndex.getTotalHeight()
      const maxTop = Math.max(0, headerH + totalDataH + bottomCushionPx - clientHeight)
      const rawTop = this.tableContainerEl?.scrollTop ?? 0
      const clampedTop = Math.max(0, Math.min(rawTop, maxTop))
      if (this.tableContainerEl) {
        if (maxTop === 0 && rawTop > 0) {
          this.tableContainerEl.scrollTop = 0
        } else if (rawTop > maxTop + ROW_HEIGHT_PX * 3) {
          this.tableContainerEl.scrollTop = maxTop
        }
        this.lastScrollTop = this.tableContainerEl.scrollTop
      }
      const range = this.rowHeightIndex.getVisibleRange(clampedTop, clientHeight, 5)
      return {
        boundedStart: range.start,
        boundedEnd: range.end,
        topSpacerPx: range.topSpacerPx,
        bottomSpacerPx: range.bottomSpacerPx,
      }
    }
    let { boundedStart, boundedEnd, topSpacerPx, bottomSpacerPx } = computeWindowBounds(totalVisibleRows)

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
      prevWin.wrapVersion === this.wrapVersion &&
      prevWin.totalRows === totalVisibleRows &&
      prevWin.colSpan === colSpan
    ) {
      return
    }

    let canSlide =
      !force &&
      this.isPoolMountedInTbody &&
      prevWin !== null &&
      prevWin.dataVersion === this.dataVersion &&
      prevWin.filterVersion === this.filterVersion &&
      prevWin.colLayoutVersion === this.colLayoutVersion &&
      prevWin.wrapVersion === this.wrapVersion &&
      prevWin.totalRows === totalVisibleRows &&
      prevWin.colSpan === colSpan

    // Protect open inline editor: keep intact if its row stays mounted in slide window,
    // otherwise flush/cancel cleanly BEFORE computing final indices/slide window so
    // lastRenderedWindow never stamps new versions onto stale indices.
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
        const preDataVer = this.dataVersion
        const preFilterVer = this.filterVersion
        this.flushActiveEditorBeforeRebuild()
        if (this.dataVersion !== preDataVer || this.filterVersion !== preFilterVer) {
          canSlide = false
          indices = this.getFilteredRowIndices()
          totalVisibleRows = indices.length
          if (totalVisibleRows === 0) {
            this.resetRowPoolMountState()
            this.tbodyEl.innerHTML = ''
            this.renderEmptyStateRow(colSpan)
            return
          }
          const recomputed = computeWindowBounds(totalVisibleRows)
          boundedStart = recomputed.boundedStart
          boundedEnd = recomputed.boundedEnd
          topSpacerPx = recomputed.topSpacerPx
          bottomSpacerPx = recomputed.bottomSpacerPx
        }
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
      bottomTd.style.height = `${bottomSpacerPx + bottomCushionPx}px`
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
          this.resetPooledRowStyles(pooled)
          this.mountedRowsByVisRow.delete(vr)
          if (this.freeRowPool.length < 120) {
            this.freeRowPool.push(pooled)
          }
        }
      }

      if (boundedStart > 0) {
        topTd.colSpan = colSpan
        topTd.style.height = `${topSpacerPx}px`
        if (topTr.parentNode !== this.tbodyEl) {
          this.tbodyEl.insertBefore(topTr, this.tbodyEl.firstChild)
        }
      } else if (topTr.parentNode === this.tbodyEl) {
        topTr.remove()
      }

      if (bottomTr.parentNode !== this.tbodyEl) {
        this.tbodyEl.appendChild(bottomTr)
      }

      if (this.wrapCells && !this.isTransposed && totalVisibleRows > 64) {
        this.measureWrapRowsRange(indices, boundedStart, boundedEnd)
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
    } else if (
      this.isPoolMountedInTbody &&
      prevWin !== null &&
      prevWin.dataVersion === this.dataVersion &&
      prevWin.filterVersion === this.filterVersion &&
      prevWin.totalRows === totalVisibleRows &&
      prevWin.boundedStart === boundedStart &&
      prevWin.boundedEnd === boundedEnd &&
      this.mountedRowsByVisRow.size === boundedEnd - boundedStart
    ) {
      // Incremental in-place update on mounted window (no tbody.innerHTML = '', no tr detach)
      if (boundedStart > 0) {
        topTd.colSpan = colSpan
        topTd.style.height = `${topSpacerPx}px`
        if (topTr.parentNode !== this.tbodyEl) {
          this.tbodyEl.insertBefore(topTr, this.tbodyEl.firstChild)
        }
      } else if (topTr.parentNode === this.tbodyEl) {
        topTr.remove()
      }
      if (bottomTr.parentNode !== this.tbodyEl) {
        this.tbodyEl.appendChild(bottomTr)
      }

      const layoutOnlyDelta = prevWin.wrapVersion === this.wrapVersion
      if (layoutOnlyDelta) {
        const visibleColSet = new Set<number>(visibleCols)
        const occKeys =
          this.highlightRules.length > 0 ? (this.getColKeyResolver()?.occKeys ?? null) : null
        for (let visRow = boundedStart; visRow < boundedEnd; visRow++) {
          const pooled = this.mountedRowsByVisRow.get(visRow)
          if (!pooled) continue
          this.patchMountedRowColumnsInPlace(
            pooled,
            visRow,
            indices[visRow],
            model,
            visibleCols,
            visibleColSet,
            pinnedCount,
            pinnedOffsets,
            focus,
            activeMatch,
            occKeys
          )
        }
      } else {
        for (let visRow = boundedStart; visRow < boundedEnd; visRow++) {
          const pooled = this.mountedRowsByVisRow.get(visRow)
          if (!pooled) continue
          while (pooled.dataCells.length < visibleCols.length) {
            const td = this.acquirePooledDataCell()
            pooled.dataCells.push(td)
            pooled.tr.appendChild(td)
          }
          while (pooled.dataCells.length > visibleCols.length) {
            const removed = pooled.dataCells.pop()
            if (removed) this.releasePooledDataCell(removed)
          }
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
        }
      }
    } else {
      // Full pool mount via a single DocumentFragment
      for (const pooled of this.mountedRowsByVisRow.values()) {
        this.resetPooledRowStyles(pooled)
        if (this.freeRowPool.length < 120) {
          this.freeRowPool.push(pooled)
        }
      }
      this.mountedRowsByVisRow.clear()
      this.tbodyEl.innerHTML = ''

      const frag = document.createDocumentFragment()
      if (boundedStart > 0) {
        topTd.colSpan = colSpan
        topTd.style.height = `${topSpacerPx}px`
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
      wrapVersion: this.wrapVersion,
      totalRows: totalVisibleRows,
      colSpan,
    }
  }

  private computeTransposedColRange(
    activeCapped: readonly number[],
    activeHasOverflow: boolean
  ): { hStart: number; hEnd: number } {
    const totalDataCols = activeCapped.length + (activeHasOverflow ? 1 : 0)
    const clientWidth = this.tableContainerEl?.clientWidth ?? 0
    if (totalDataCols <= 16 || !this.tableContainerEl || clientWidth <= 0) {
      return { hStart: 0, hEnd: totalDataCols }
    }
    const scrollLeft = Math.max(0, this.tableContainerEl.scrollLeft)
    const visibleViewportW = Math.max(160, clientWidth - this.transposedFieldWidth)
    const viewRight = scrollLeft + visibleViewportW

    let x = 0
    let visStart = totalDataCols - 1
    let visEnd = 0
    let foundStart = false
    for (let i = 0; i < totalDataCols; i++) {
      const colW =
        i < activeCapped.length
          ? this.getTransposedRowWidth(activeCapped[i])
          : this.transposedMoreWidth
      const nextX = x + colW
      if (!foundStart && nextX > scrollLeft) {
        visStart = i
        foundStart = true
      }
      if (x < viewRight) {
        visEnd = i + 1
      } else if (foundStart) {
        break
      }
      x = nextX
    }
    if (!foundStart) {
      visStart = Math.max(0, totalDataCols - 1)
      visEnd = totalDataCols
    }
    const hStart = Math.max(0, visStart - 3)
    const hEnd = Math.min(totalDataCols, Math.max(visStart + 1, visEnd) + 4)
    return { hStart, hEnd }
  }

  private computeTransposedColLeftOffset(
    activeCapped: readonly number[],
    targetDataColIdx: number
  ): number {
    let x = 0
    const limit = Math.max(0, Math.min(targetDataColIdx, activeCapped.length))
    for (let i = 0; i < limit; i++) {
      x += this.getTransposedRowWidth(activeCapped[i])
    }
    return x
  }

  private reconcilePooledTransposedRowCells(
    pooled: PooledTransposedRow,
    visibleDataColCount: number,
    showMoreTd: boolean,
    leftSpan: number,
    rightSpan: number
  ): void {
    const { tr, labelTd } = pooled
    if (leftSpan > 0) {
      if (!pooled.leftSpacerTd) {
        const sp = document.createElement('td')
        sp.className = 'datanoa-td datanoa-h-spacer'
        pooled.leftSpacerTd = sp
      }
      pooled.leftSpacerTd.colSpan = leftSpan
      if (pooled.leftSpacerTd.parentNode !== tr || labelTd.nextSibling !== pooled.leftSpacerTd) {
        tr.insertBefore(pooled.leftSpacerTd, labelTd.nextSibling)
      }
    } else if (pooled.leftSpacerTd && pooled.leftSpacerTd.parentNode === tr) {
      pooled.leftSpacerTd.remove()
    }

    if (rightSpan > 0) {
      if (!pooled.rightSpacerTd) {
        const sp = document.createElement('td')
        sp.className = 'datanoa-td datanoa-h-spacer'
        pooled.rightSpacerTd = sp
      }
      pooled.rightSpacerTd.colSpan = rightSpan
      if (pooled.rightSpacerTd.parentNode !== tr || tr.lastChild !== pooled.rightSpacerTd) {
        tr.appendChild(pooled.rightSpacerTd)
      }
    } else if (pooled.rightSpacerTd && pooled.rightSpacerTd.parentNode === tr) {
      pooled.rightSpacerTd.remove()
    }

    const tailRef =
      pooled.rightSpacerTd && pooled.rightSpacerTd.parentNode === tr ? pooled.rightSpacerTd : null

    if (showMoreTd) {
      if (!pooled.moreTd) {
        const moreTd = document.createElement('td')
        moreTd.className = 'datanoa-td datanoa-cell-null'
        pooled.moreTd = moreTd
      }
      if (pooled.moreTd.parentNode !== tr || pooled.moreTd.nextSibling !== tailRef) {
        tr.insertBefore(pooled.moreTd, tailRef)
      }
    } else if (pooled.moreTd && pooled.moreTd.parentNode === tr) {
      pooled.moreTd.remove()
    }

    const dataInsertRef =
      pooled.moreTd && pooled.moreTd.parentNode === tr ? pooled.moreTd : tailRef

    while (pooled.dataCells.length < visibleDataColCount) {
      const td = this.createPooledDataCell()
      pooled.dataCells.push(td)
      tr.insertBefore(td, dataInsertRef)
    }
    while (pooled.dataCells.length > visibleDataColCount) {
      const removed = pooled.dataCells.pop()
      removed?.remove()
    }
  }

  private acquirePooledTransposedRow(
    visibleDataColCount: number,
    showMoreTd: boolean,
    leftSpan: number,
    rightSpan: number
  ): PooledTransposedRow {
    const existing = this.freeTransposedRowPool.pop()
    if (existing) {
      this.reconcilePooledTransposedRowCells(
        existing,
        visibleDataColCount,
        showMoreTd,
        leftSpan,
        rightSpan
      )
      return existing
    }

    const tr = document.createElement('tr')
    const labelTd = document.createElement('td')
    labelTd.className = 'datanoa-td datanoa-th-row-label'
    const fieldNameSpan = document.createElement('span')
    fieldNameSpan.className = 'datanoa-transpose-field-name'
    labelTd.appendChild(fieldNameSpan)
    tr.appendChild(labelTd)

    let leftSpacerTd: HTMLTableCellElement | null = null
    if (leftSpan > 0) {
      leftSpacerTd = document.createElement('td')
      leftSpacerTd.className = 'datanoa-td datanoa-h-spacer'
      leftSpacerTd.colSpan = leftSpan
      tr.appendChild(leftSpacerTd)
    }

    const dataCells = new Array<HTMLTableCellElement>(visibleDataColCount)
    for (let i = 0; i < visibleDataColCount; i++) {
      const td = this.createPooledDataCell()
      dataCells[i] = td
      tr.appendChild(td)
    }

    let moreTd: HTMLTableCellElement | null = null
    if (showMoreTd) {
      moreTd = document.createElement('td')
      moreTd.className = 'datanoa-td datanoa-cell-null'
      tr.appendChild(moreTd)
    }

    let rightSpacerTd: HTMLTableCellElement | null = null
    if (rightSpan > 0) {
      rightSpacerTd = document.createElement('td')
      rightSpacerTd.className = 'datanoa-td datanoa-h-spacer'
      rightSpacerTd.colSpan = rightSpan
      tr.appendChild(rightSpacerTd)
    }

    return {
      tr,
      labelTd,
      fieldNameSpan,
      pkSpan: null,
      typeSpan: null,
      leftSpacerTd,
      dataCells,
      moreTd,
      rightSpacerTd,
    }
  }

  private patchPooledTransposedRow(
    pooled: PooledTransposedRow,
    visCol: number,
    colIdx: number,
    model: GridModel,
    activeCapped: readonly number[],
    hStart: number,
    visibleDataEnd: number,
    totalFilteredRows: number,
    showMoreTd: boolean,
    focus: CellCoord | null,
    activeMatch: CellCoord | null
  ): void {
    const header = model.headers[colIdx]
    const { tr, labelTd, fieldNameSpan, dataCells } = pooled
    tr.className = visCol % 2 === 1 ? 'datanoa-tr datanoa-tr-even' : 'datanoa-tr'
    tr.dataset.visCol = String(visCol)
    tr.dataset.colIndex = String(colIdx)

    const isPk = model.primaryKey.includes(header)
    const colDef = model.columns[colIdx]
    const colType = colDef && 'type' in colDef && colDef.type ? ` : ${colDef.type}` : ''

    fieldNameSpan.textContent = header
    if (isPk) {
      if (!pooled.pkSpan) {
        const pkSpan = document.createElement('span')
        pkSpan.className = 'datanoa-transpose-pk'
        pkSpan.textContent = ' [PK]'
        pooled.pkSpan = pkSpan
      }
      if (pooled.pkSpan.parentNode !== labelTd) {
        if (pooled.typeSpan && pooled.typeSpan.parentNode === labelTd) {
          labelTd.insertBefore(pooled.pkSpan, pooled.typeSpan)
        } else {
          labelTd.appendChild(pooled.pkSpan)
        }
      }
    } else if (pooled.pkSpan && pooled.pkSpan.parentNode === labelTd) {
      pooled.pkSpan.remove()
    }

    if (colType) {
      if (!pooled.typeSpan) {
        const typeSpan = document.createElement('span')
        typeSpan.className = 'datanoa-transpose-type'
        pooled.typeSpan = typeSpan
      }
      pooled.typeSpan.textContent = colType
      if (pooled.typeSpan.parentNode !== labelTd) {
        labelTd.appendChild(pooled.typeSpan)
      }
    } else if (pooled.typeSpan && pooled.typeSpan.parentNode === labelTd) {
      pooled.typeSpan.remove()
    }

    labelTd.title = `${header}${isPk ? ' [PK]' : ''}${colType}`

    const visibleDataCount = Math.max(0, visibleDataEnd - hStart)
    for (let slot = 0; slot < visibleDataCount; slot++) {
      const visRow = hStart + slot
      const rowIndex = activeCapped[visRow]
      const rowData = model.rows[rowIndex]
      const rowState = this.rowStates[rowIndex]
      const td = dataCells[slot]
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
        null,
        false
      )
      if (rowState?.kind === 'inserted') td.classList.add('datanoa-row-inserted')
      if (rowState?.deleted) td.classList.add('datanoa-row-deleted')
    }

    if (showMoreTd && pooled.moreTd) {
      pooled.moreTd.textContent = `... (${totalFilteredRows - 100} more)`
    }
  }

  private renderTransposedBody(indices: number[], force = false): void {
    const tbody = this.tbodyEl
    const model = this.model
    if (!tbody || !model) return

    if (indices.length === 0) {
      if (this.activeEditor) {
        this.flushActiveEditorBeforeRebuild()
      }
      this.resetRowPoolMountState()
      tbody.innerHTML = ''
      if (this.tableEl) {
        this.tableEl.classList.add('datanoa-grid-empty-table')
      }
      this.updateTableWidthOnly()
      this.renderEmptyStateRow(1)
      return
    }
    if (this.tableEl) {
      this.tableEl.classList.remove('datanoa-grid-empty-table')
    }

    const visibleCols = this.getVisibleColumnIndices()
    const totalFields = visibleCols.length
    let activeIndices = indices
    let activeCapped = activeIndices.slice(0, 100)
    let activeHasOverflow = activeIndices.length > 100
    let totalDataCols = activeCapped.length + (activeHasOverflow ? 1 : 0)
    let activeColSpan = 1 + totalDataCols

    const clientHeight = this.tableContainerEl?.clientHeight ?? 0
    const bottomCushionPx = 28
    const computeTransposedRange = (fieldCount: number) => {
      if (fieldCount > 16 && this.tableContainerEl && clientHeight > 0) {
        const headerH = this.cachedHeaderHeightPx || 26
        const maxTop = Math.max(0, headerH + fieldCount * ROW_HEIGHT_PX + bottomCushionPx - clientHeight)
        const rawTop = this.tableContainerEl.scrollTop
        const clampedTop = Math.max(0, Math.min(rawTop, maxTop))
        if (rawTop > maxTop + ROW_HEIGHT_PX * 3) {
          this.tableContainerEl.scrollTop = maxTop
        }
        this.lastScrollTop = this.tableContainerEl.scrollTop
        const { startIndex, endIndex } = calculateVisibleWindow(clampedTop, clientHeight)
        return {
          boundedStart: Math.max(0, startIndex - 5),
          boundedEnd: Math.min(fieldCount, endIndex + 5),
        }
      }
      if (this.tableContainerEl) {
        this.lastScrollTop = this.tableContainerEl.scrollTop
      }
      return { boundedStart: 0, boundedEnd: fieldCount }
    }

    let { boundedStart, boundedEnd } = computeTransposedRange(totalFields)
    let { hStart, hEnd } = this.computeTransposedColRange(activeCapped, activeHasOverflow)
    if (this.tableContainerEl) {
      this.lastScrollLeft = this.tableContainerEl.scrollLeft
    }

    const prevWin = this.lastTransposedWindow
    const hChanged = hStart !== this.lastTransposedHStart || hEnd !== this.lastTransposedHEnd
    if (
      !force &&
      !hChanged &&
      this.isTransposedPoolMounted &&
      prevWin !== null &&
      prevWin.boundedStart === boundedStart &&
      prevWin.boundedEnd === boundedEnd &&
      prevWin.dataVersion === this.dataVersion &&
      prevWin.filterVersion === this.filterVersion &&
      prevWin.colLayoutVersion === this.colLayoutVersion &&
      prevWin.totalRows === totalFields &&
      prevWin.colSpan === activeColSpan
    ) {
      return
    }

    let canSlide =
      !force &&
      this.isTransposedPoolMounted &&
      prevWin !== null &&
      prevWin.dataVersion === this.dataVersion &&
      prevWin.filterVersion === this.filterVersion &&
      prevWin.colLayoutVersion === this.colLayoutVersion &&
      prevWin.totalRows === totalFields &&
      prevWin.colSpan === activeColSpan

    if (this.activeEditor !== null) {
      let keepEditorAlive = false
      if (canSlide && !hChanged) {
        const edVisCol = parseOptionalInt(this.activeEditor.td.dataset.visCol)
        const edVisRow = parseOptionalInt(this.activeEditor.td.dataset.visRow)
        if (
          edVisCol !== null &&
          edVisCol >= boundedStart &&
          edVisCol < boundedEnd &&
          this.mountedTransposedRowsByFieldIdx.has(edVisCol) &&
          (edVisRow === null || (edVisRow >= hStart && edVisRow < Math.min(hEnd, activeCapped.length)))
        ) {
          keepEditorAlive = true
        }
      }
      if (!keepEditorAlive) {
        const preDataVer = this.dataVersion
        const preFilterVer = this.filterVersion
        this.flushActiveEditorBeforeRebuild()
        if (this.dataVersion !== preDataVer || this.filterVersion !== preFilterVer) {
          canSlide = false
          activeIndices = this.getFilteredRowIndices()
          this.renderHeader()
          if (activeIndices.length === 0) {
            this.resetRowPoolMountState()
            tbody.innerHTML = ''
            if (this.tableEl) this.tableEl.classList.add('datanoa-grid-empty-table')
            this.updateTableWidthOnly()
            this.renderEmptyStateRow(1)
            return
          }
          activeCapped = activeIndices.slice(0, 100)
          activeHasOverflow = activeIndices.length > 100
          totalDataCols = activeCapped.length + (activeHasOverflow ? 1 : 0)
          activeColSpan = 1 + totalDataCols
          const recomputed = computeTransposedRange(totalFields)
          boundedStart = recomputed.boundedStart
          boundedEnd = recomputed.boundedEnd
          const recomputedH = this.computeTransposedColRange(activeCapped, activeHasOverflow)
          hStart = recomputedH.hStart
          hEnd = recomputedH.hEnd
        }
      }
    }

    const visibleDataEnd = Math.min(hEnd, activeCapped.length)
    const visibleDataCount = Math.max(0, visibleDataEnd - hStart)
    const showMoreTd = activeHasOverflow && hEnd === totalDataCols
    const leftSpan = hStart
    const rightSpan = Math.max(0, totalDataCols - hEnd)

    const focus = this.selection.getFocus()
    const activeMatch =
      this.findActiveIndex >= 0 ? (this.findMatches[this.findActiveIndex] ?? null) : null
    const { topTr, topTd, bottomTr, bottomTd } = this.ensureSpacerRows()
    const remainingFields = totalFields - boundedEnd

    bottomTd.colSpan = activeColSpan
    if (remainingFields > 0) {
      bottomTr.className = ''
      bottomTd.style.height = `${remainingFields * ROW_HEIGHT_PX + bottomCushionPx}px`
      bottomTd.style.pointerEvents = ''
    } else {
      bottomTr.className = 'datanoa-grid-bottom-cushion'
      bottomTd.style.height = `${bottomCushionPx}px`
      bottomTd.style.pointerEvents = 'none'
    }

    if (canSlide && prevWin) {
      // Incremental sliding-window update: recycle ONLY field rows leaving [boundedStart, boundedEnd)
      for (const [vc, pooled] of Array.from(this.mountedTransposedRowsByFieldIdx.entries())) {
        if (vc < boundedStart || vc >= boundedEnd) {
          pooled.tr.remove()
          this.mountedTransposedRowsByFieldIdx.delete(vc)
          if (this.freeTransposedRowPool.length < 80) {
            this.freeTransposedRowPool.push(pooled)
          }
        }
      }

      // If horizontal window shifted, update surviving mounted rows in-place (preserving <tr> identity)
      if (hChanged) {
        for (const [vc, pooled] of this.mountedTransposedRowsByFieldIdx.entries()) {
          this.reconcilePooledTransposedRowCells(
            pooled,
            visibleDataCount,
            showMoreTd,
            leftSpan,
            rightSpan
          )
          this.patchPooledTransposedRow(
            pooled,
            vc,
            visibleCols[vc],
            model,
            activeCapped,
            hStart,
            visibleDataEnd,
            activeIndices.length,
            showMoreTd,
            focus,
            activeMatch
          )
        }
      }

      if (boundedStart > 0) {
        topTd.colSpan = activeColSpan
        topTd.style.height = `${boundedStart * ROW_HEIGHT_PX}px`
        if (topTr.parentNode !== tbody) {
          tbody.insertBefore(topTr, tbody.firstChild)
        }
      } else if (topTr.parentNode === tbody) {
        topTr.remove()
      }

      if (bottomTr.parentNode !== tbody) {
        tbody.appendChild(bottomTr)
      }

      const overlapStart = Math.max(boundedStart, prevWin.boundedStart)
      const overlapEnd = Math.min(boundedEnd, prevWin.boundedEnd)
      const hasOverlap =
        overlapStart < overlapEnd && this.mountedTransposedRowsByFieldIdx.size > 0

      if (!hasOverlap) {
        const frag = document.createDocumentFragment()
        for (let visCol = boundedStart; visCol < boundedEnd; visCol++) {
          const pooled = this.acquirePooledTransposedRow(
            visibleDataCount,
            showMoreTd,
            leftSpan,
            rightSpan
          )
          this.patchPooledTransposedRow(
            pooled,
            visCol,
            visibleCols[visCol],
            model,
            activeCapped,
            hStart,
            visibleDataEnd,
            activeIndices.length,
            showMoreTd,
            focus,
            activeMatch
          )
          this.mountedTransposedRowsByFieldIdx.set(visCol, pooled)
          frag.appendChild(pooled.tr)
        }
        tbody.insertBefore(frag, bottomTr)
      } else {
        if (boundedStart < overlapStart) {
          const topFrag = document.createDocumentFragment()
          for (let visCol = boundedStart; visCol < overlapStart; visCol++) {
            const pooled = this.acquirePooledTransposedRow(
              visibleDataCount,
              showMoreTd,
              leftSpan,
              rightSpan
            )
            this.patchPooledTransposedRow(
              pooled,
              visCol,
              visibleCols[visCol],
              model,
              activeCapped,
              hStart,
              visibleDataEnd,
              activeIndices.length,
              showMoreTd,
              focus,
              activeMatch
            )
            this.mountedTransposedRowsByFieldIdx.set(visCol, pooled)
            topFrag.appendChild(pooled.tr)
          }
          const refNode = topTr.parentNode === tbody ? topTr.nextSibling : tbody.firstChild
          tbody.insertBefore(topFrag, refNode)
        }

        if (overlapEnd < boundedEnd) {
          const botFrag = document.createDocumentFragment()
          for (let visCol = overlapEnd; visCol < boundedEnd; visCol++) {
            const pooled = this.acquirePooledTransposedRow(
              visibleDataCount,
              showMoreTd,
              leftSpan,
              rightSpan
            )
            this.patchPooledTransposedRow(
              pooled,
              visCol,
              visibleCols[visCol],
              model,
              activeCapped,
              hStart,
              visibleDataEnd,
              activeIndices.length,
              showMoreTd,
              focus,
              activeMatch
            )
            this.mountedTransposedRowsByFieldIdx.set(visCol, pooled)
            botFrag.appendChild(pooled.tr)
          }
          tbody.insertBefore(botFrag, bottomTr)
        }
      }
    } else {
      for (const pooled of this.mountedTransposedRowsByFieldIdx.values()) {
        if (this.freeTransposedRowPool.length < 80) {
          this.freeTransposedRowPool.push(pooled)
        }
      }
      this.mountedTransposedRowsByFieldIdx.clear()
      tbody.innerHTML = ''

      const frag = document.createDocumentFragment()
      if (boundedStart > 0) {
        topTd.colSpan = activeColSpan
        topTd.style.height = `${boundedStart * ROW_HEIGHT_PX}px`
        frag.appendChild(topTr)
      }

      for (let visCol = boundedStart; visCol < boundedEnd; visCol++) {
        const pooled = this.acquirePooledTransposedRow(
          visibleDataCount,
          showMoreTd,
          leftSpan,
          rightSpan
        )
        this.patchPooledTransposedRow(
          pooled,
          visCol,
          visibleCols[visCol],
          model,
          activeCapped,
          hStart,
          visibleDataEnd,
          activeIndices.length,
          showMoreTd,
          focus,
          activeMatch
        )
        this.mountedTransposedRowsByFieldIdx.set(visCol, pooled)
        frag.appendChild(pooled.tr)
      }

      frag.appendChild(bottomTr)
      tbody.appendChild(frag)
      this.isTransposedPoolMounted = true
    }

    this.lastTransposedHStart = hStart
    this.lastTransposedHEnd = hEnd
    this.lastTransposedWindow = {
      boundedStart,
      boundedEnd,
      dataVersion: this.dataVersion,
      filterVersion: this.filterVersion,
      colLayoutVersion: this.colLayoutVersion,
      wrapVersion: this.wrapVersion,
      totalRows: totalFields,
      colSpan: activeColSpan,
    }
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
    isLastPinned: boolean,
    cellHighlightClass: string | null = null
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
    } else if (this.selectedRowIndex === rowIndex && this.selectedColIndex === colIdx) {
      cls += ' datanoa-cell-selected'
    }

    if (this.wrapCells && !this.isTransposed) {
      cls += ' datanoa-cell-wrap'
    }

    if (cellHighlightClass) {
      cls += ` datanoa-hl-cell ${cellHighlightClass}`
    }

    if (this.findMatchKeys.size > 0 && this.findMatchKeys.has(`${visRow}:${visCol}`)) {
      cls += ' datanoa-cell-match'
      if (activeMatch !== null && activeMatch.row === visRow && activeMatch.col === visCol) {
        cls += ' datanoa-cell-match-active'
      }
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

    this.contextMenuEl = buildGridCellContextMenu({
      clientX,
      clientY,
      rowIndex,
      colIndex,
      columnName,
      rawValue,
      td,
      model,
      rowState: this.rowStates[rowIndex],
      interactionLocked: this.interactionLocked,
      batchMode: this.batchMode,
      stagedCount: this.getStagedCount(),
      dialect: this.dialect,
      summary: this.getSelectionSummary(),
      fk: this.getForeignKeyForColumn(columnName),
      hasFkHandler: Boolean(this.onNavigateForeignKey),
      isCellEditable: this.isCellEditable(rowIndex, colIndex),
      isColumnNullable: this.isColumnNullable(colIndex),
      closeMenu: () => this.closeContextMenu(),
      copySelection: (fmt) => this.copySelection(fmt),
      onNotify: this.onNotify,
      triggerPasteAction: (asNewRows) => this.triggerPasteAction(asNewRows),
      buildSelectedCellInfo: () => this.buildSelectedCellInfo(rowIndex, colIndex),
      onInspectCell: this.onInspectCell,
      bulkSetCellsValue: (val) => this.bulkSetCellsValue(val),
      applyDirectNull: () => {
        void this.applyDirectCellValue(
          rowIndex,
          colIndex,
          columnName,
          null,
          rawValue,
          this.findLiveCell(rowIndex, colIndex) ?? td
        )
      },
      openBulkFill: (x, y, count) => this.openBulkFillPopover(x, y, count),
      triggerQuickFilter: (col, val, op, mode) => this.triggerQuickFilter(col, val, op, mode),
      triggerFkJump: () => this.triggerFkJump(rowIndex, colIndex),
      bulkCloneSelectedRows: () => this.bulkCloneSelectedRows(),
      cloneSingleRow: () => {
        this.selectedRowIndex = rowIndex
        this.cloneSelectedRow()
      },
      bulkMarkRowsDeleted: () => {
        this.bulkMarkRowsDeleted()
      },
      markSingleRowDeleted: () => {
        this.markRowDeleted(rowIndex)
      },
    })
  }

  private openCanvasContextMenu(clientX: number, clientY: number): void {
    this.closeContextMenu()
    this.closeBulkFillPopover()
    const model = this.model
    if (typeof document === 'undefined' || !model) return

    this.contextMenuEl = buildGridCanvasContextMenu({
      clientX,
      clientY,
      canInsert: !this.interactionLocked && model.canEdit,
      closeMenu: () => this.closeContextMenu(),
      onPasteNewRows: () => this.triggerPasteAction(true),
      onAddBlankRow: () => {
        this.addBlankRow()
      },
    })
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

    const occKey = this.getColKeyResolver()?.occKeys[modelColIdx] ?? header
    const hiddenSet = this.getResolvedHiddenKeySet()
    const pinnedSet = new Set(this.getResolvedPinnedKeys(hiddenSet))
    this.contextMenuEl = buildGridHeaderContextMenu({
      clientX,
      clientY,
      modelColIdx,
      header,
      model,
      dialect: this.dialect,
      isPinned: pinnedSet.has(occKey),
      visibleColsCount: this.getVisibleColumnIndices().length,
      rowIndices: this.getFilteredRowIndices(),
      closeMenu: () => this.closeContextMenu(),
      selectColumn: () => {
        const rowCount = this.getFilteredRowIndices().length
        this.selection.selectColumn(visCol, rowCount)
        this.syncSelectionClasses()
        this.notifyAllSelectionListeners()
      },
      onNotify: this.onNotify,
      onSort: (dir) => this.handleHeaderClick(header, dir),
      togglePin: () => this.togglePinColumn(occKey),
      hideColumn: () => this.setColumnVisibility(occKey, false),
      autoFitColumn: () => this.autoFitColumn(modelColIdx, thEl),
    })
  }

  private openBulkFillPopover(clientX: number, clientY: number, cellCount: number): void {
    this.closeBulkFillPopover()
    if (typeof document === 'undefined') return
    this.bulkFillPopoverEl = buildGridBulkFillPopover({
      clientX,
      clientY,
      cellCount,
      closePopover: () => this.closeBulkFillPopover(),
      onApplyValue: (val) => this.bulkSetCellsValue(val),
      onNotify: this.onNotify,
    })
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

  private closeColumnFilterPopover(): void {
    if (this.colFilterPopoverEl) {
      this.colFilterPopoverEl.remove()
      this.colFilterPopoverEl = null
    }
  }

  private openColumnFilterPopover(column: string, anchorEl: HTMLElement): void {
    if (typeof document === 'undefined' || !document.body) return
    const existingForCol = this.clientColumnFilters.find((f) => f.column === column)
    this.closeContextMenu()
    this.closeBulkFillPopover()
    this.closeColumnFilterPopover()

    this.colFilterPopoverEl = buildGridColumnFilterPopover({
      column,
      anchorEl,
      existingForCol,
      closePopover: () => this.closeColumnFilterPopover(),
      onApply: (rawVal, op, mode) => {
        if (this.onColumnHeaderFilter) {
          this.onColumnHeaderFilter(column, rawVal, op, mode)
        } else {
          this.addClientColumnFilter(column, rawVal, op)
        }
      },
      onClear: (op) => {
        if (this.onColumnHeaderFilter) {
          this.onColumnHeaderFilter(column, '', op, 'clear')
        } else {
          this.removeClientColumnFilter(column)
        }
      },
    })
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
    const headerH = this.cachedHeaderHeightPx || this.theadEl?.offsetHeight || 28
    const totalDataH =
      this.rowHeightIndex.rowCount === totalVisibleRows
        ? this.rowHeightIndex.getTotalHeight()
        : totalVisibleRows * ROW_HEIGHT_PX
    const targetTop = Math.max(0, headerH + totalDataH + 28 - clientHeight)
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
    if (!clipText && this.lastCopiedDelimitedText) {
      clipText = this.lastCopiedDelimitedText
    }
    const isCopiedNullCell =
      clipText === '' &&
      this.lastCopiedSnapshot !== null &&
      this.lastCopiedSnapshot.text === '' &&
      this.lastCopiedSnapshot.rawMatrix.length === 1 &&
      this.lastCopiedSnapshot.rawMatrix[0]?.length === 1
    if (!clipText && !isCopiedNullCell) {
      this.onNotify?.(
        asNewRows
          ? 'Copy rows first (Ctrl+C), then use Paste as New Row(s) (Ctrl+Shift+V)'
          : 'Use Ctrl+V to paste directly into the grid'
      )
      return
    }
    const outcome = this.pasteDelimitedTextDetailed(clipText, { forceNewRows: asNewRows })
    this.notifyPasteOutcome(outcome)
  }

  public pasteAsNewRows(text: string): number {
    return this.pasteDelimitedTextDetailed(text, { forceNewRows: true }).insertedRows
  }

  /**
   * Stages pre-mapped records (e.g. from CSV/TSV/JSON file import) as batch INSERT rows.
   * Preserves explicit mapped values while blocking generated columns and leaving unmapped
   * columns undefined so database defaults / auto-increment apply on Submit.
   */
  public stageImportedRows(records: Record<string, unknown>[]): number {
    const model = this.model
    if (this.interactionLocked || !model || !model.canEdit || records.length === 0) {
      return 0
    }

    const allowedHeaders = new Set<string>()
    model.headers.forEach((header, idx) => {
      const col = model.columns[idx]
      const isGenerated = Boolean(col && 'isGenerated' in col && col.isGenerated === true)
      if (!isGenerated) {
        allowedHeaders.add(header)
      }
    })

    const visibleCols = this.getVisibleColumnIndices()
    const firstNewIdx = model.rows.length
    let insertedCount = 0

    for (const sourceRecord of records) {
      const rowRecord: Record<string, unknown> = {}
      for (const [colName, val] of Object.entries(sourceRecord)) {
        if (!allowedHeaders.has(colName) || val === undefined) continue
        rowRecord[colName] = val
      }

      model.rows.push(rowRecord)
      this.rowStates.push({
        kind: 'inserted',
        origin: 'import',
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
    return createClonedRowRecord(model, sourceIdx)
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
      this.shiftTransposedRowWidthsAfterSplice(idx)
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
        this.shiftTransposedRowWidthsAfterSplice(idx)
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
    const prevRow = model.rows[rowIndex]
    // Copy-on-write row mutation so cached GridRuntimeSnapshots remain immutable.
    if (rowState.kind === 'existing' && rowState.original === prevRow) {
      rowState.original = prevRow
    }
    const rowData = cloneRow(prevRow)
    model.rows[rowIndex] = rowData
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
        typeof value === 'string'
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

  private resolveClipboardPayloadForPaste(text: string): {
    matrix: readonly (readonly unknown[])[]
    explicitHasHeaders: boolean
    sourceHeaders?: readonly string[]
  } {
    const normalizeEol = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const snap = this.lastCopiedSnapshot
    if (snap && snap.rawMatrix.length > 0 && normalizeEol(text) === normalizeEol(snap.text)) {
      return {
        matrix: snap.rawMatrix,
        explicitHasHeaders: snap.hasHeaders,
        sourceHeaders: snap.headers,
      }
    }
    return {
      matrix: parseDelimitedClipboard(text),
      explicitHasHeaders: false,
      sourceHeaders: undefined,
    }
  }

  private coercePastedValue(rawVal: unknown, originalValue: unknown, colIndex: number): unknown {
    if (rawVal === null || rawVal === undefined) {
      return null
    }
    if (typeof rawVal === 'object') {
      try {
        return JSON.stringify(rawVal)
      } catch {
        return String(rawVal)
      }
    }
    return this.coerceEditedValue(String(rawVal), originalValue, colIndex)
  }

  private buildPasteColumnSpecs(model: GridModel): PasteColumnSpec[] {
    return model.headers.map((header, idx) => {
      const col = model.columns[idx]
      const isAutoIncrement = Boolean(col && 'isAutoIncrement' in col && col.isAutoIncrement)
      const isGenerated = Boolean(col && 'isGenerated' in col && col.isGenerated === true)
      const isPrimaryKey = Boolean(
        (col && 'isPrimaryKey' in col && col.isPrimaryKey) || model.primaryKey.includes(header)
      )
      return { name: header, isAutoIncrement, isPrimaryKey, isGenerated }
    })
  }

  /**
   * Smart RFC-4180 TSV/CSV paste:
   * - Active selection: overwrites existing cells starting at anchor and inserts overflow rows beyond table end
   *   (1x1 scalar into multi-cell selection fills the selected cells).
   * - No selection / empty table / forceNewRows: inserts all pasted rows as brand-new staged INSERT rows.
   */
  public pasteDelimitedTextDetailed(
    text: string,
    options?: { forceNewRows?: boolean }
  ): {
    updatedCells: number
    insertedRows: number
    skippedReadOnly: number
    mode: 'empty' | 'fill' | 'overwrite' | 'insert' | 'overwrite-and-insert'
  } {
    const emptyOutcome = {
      updatedCells: 0,
      insertedRows: 0,
      skippedReadOnly: 0,
      mode: 'empty' as const,
    }
    const model = this.model
    if (this.interactionLocked || !model || !model.canEdit) return emptyOutcome

    const visibleCols = this.getVisibleColumnIndices()
    if (visibleCols.length === 0) return emptyOutcome

    const { matrix, explicitHasHeaders, sourceHeaders } = this.resolveClipboardPayloadForPaste(text)
    if (matrix.length === 0) return emptyOutcome

    const visibleRows = this.getFilteredRowIndices()
    const forceNewRows = Boolean(options?.forceNewRows)

    let bbox = this.selection.getBoundingBox()
    let hasSelection = !this.selection.isEmpty() && bbox !== null
    let selectedCellCount = hasSelection ? this.getSelectionSummary().cellCount : 0
    if (!hasSelection && this.selectedRowIndex !== null && this.selectedColIndex !== null) {
      const vr = visibleRows.indexOf(this.selectedRowIndex)
      const vc = visibleCols.indexOf(this.selectedColIndex)
      if (vr >= 0 && vc >= 0) {
        hasSelection = true
        bbox = { startRow: vr, endRow: vr, startCol: vc, endCol: vc }
        selectedCellCount = 1
      }
    }

    const colSpecs = this.buildPasteColumnSpecs(model)
    const plan = planGridPaste({
      matrix,
      hasSelection,
      selectionBBox: bbox,
      selectedCellCount,
      existingRowCount: visibleRows.length,
      visibleColIndices: visibleCols,
      allColumns: colSpecs,
      forceNewRows,
      explicitHasHeaders,
      sourceHeaders,
    })

    if (plan.mode === 'empty') return emptyOutcome

    if (plan.mode === 'fill') {
      let updatedCells = 0
      let skippedReadOnly = 0
      this.selection.forEachSelectedCell(visibleRows.length, visibleCols.length, (vr, vc) => {
        const rIdx = visibleRows[vr]
        const cIdx = visibleCols[vc]
        if (rIdx === undefined || cIdx === undefined) return
        const header = model.headers[cIdx]
        const currentVal = getCellValue(model.rows[rIdx], cIdx, header)
        const coerced = this.coercePastedValue(plan.fillValue, currentVal, cIdx)
        if (this.stageCellValueInMemory(rIdx, cIdx, coerced)) {
          updatedCells++
        } else {
          skippedReadOnly++
        }
      })
      if (updatedCells > 0) {
        this.invalidateDataCache()
        this.invalidateFilterCache()
        this.renderVisibleRows()
        this.refreshFindMatchesIfActive()
        this.onStageChange?.(this.getStagedCount())
        this.notifyAllSelectionListeners()
      }
      return { updatedCells, insertedRows: 0, skippedReadOnly, mode: 'fill' }
    }

    let updatedCells = 0
    let skippedReadOnly = 0
    let minVisCol = Number.POSITIVE_INFINITY
    let maxVisCol = -1
    let maxOverwrittenVisRow = plan.startVisRow

    for (const owRow of plan.overwrites) {
      const rIdx = visibleRows[owRow.targetVisRow]
      if (rIdx === undefined) continue
      const rowState = this.rowStates[rIdx]
      const isMultiColRow = owRow.cells.length > 1
      for (const cell of owRow.cells) {
        const cIdx = cell.modelColIdx
        const colSpec = colSpecs[cIdx]
        if (rowState?.kind === 'inserted' && isMultiColRow && colSpec?.isAutoIncrement) {
          continue
        }
        const header = model.headers[cIdx]
        const currentVal = getCellValue(model.rows[rIdx], cIdx, header)
        const coerced = this.coercePastedValue(cell.rawValue, currentVal, cIdx)
        if (this.stageCellValueInMemory(rIdx, cIdx, coerced)) {
          updatedCells++
          if (owRow.targetVisRow > maxOverwrittenVisRow) {
            maxOverwrittenVisRow = owRow.targetVisRow
          }
          if (cell.visColIdx >= 0) {
            if (cell.visColIdx < minVisCol) minVisCol = cell.visColIdx
            if (cell.visColIdx > maxVisCol) maxVisCol = cell.visColIdx
          }
        } else {
          skippedReadOnly++
        }
      }
    }

    const firstNewIdx = model.rows.length
    let insertedRows = 0

    for (const insRow of plan.inserts) {
      if (insRow.cells.length === 0) {
        skippedReadOnly++
        continue
      }
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

      for (const cell of insRow.cells) {
        const cIdx = cell.modelColIdx
        const col = model.columns[cIdx]
        if (
          col &&
          (('isAutoIncrement' in col && col.isAutoIncrement) ||
            ('isGenerated' in col && col.isGenerated === true))
        ) {
          continue
        }
        const header = model.headers[cIdx]
        const coerced = this.coercePastedValue(cell.rawValue, null, cIdx)
        if (coerced === null && !this.isColumnNullable(cIdx)) {
          const hasDefault = Boolean(
            col &&
              'defaultValue' in col &&
              col.defaultValue !== null &&
              col.defaultValue !== undefined
          )
          if (hasDefault) continue
        }
        record[header] = coerced
        if (cell.visColIdx >= 0) {
          if (cell.visColIdx < minVisCol) minVisCol = cell.visColIdx
          if (cell.visColIdx > maxVisCol) maxVisCol = cell.visColIdx
        }
      }

      model.rows.push(record)
      this.rowStates.push({
        kind: 'inserted',
        origin: 'paste',
        deleted: false,
        original: {},
        dirtyCols: new Map<string, unknown>(),
      })
      insertedRows++
    }

    if (updatedCells === 0 && insertedRows === 0) {
      return { updatedCells: 0, insertedRows: 0, skippedReadOnly, mode: plan.mode }
    }

    this.invalidateDataCache()
    this.invalidateFilterCache()

    const nextVisibleRows = this.getFilteredRowIndices()
    const maxAllowedVisRow = nextVisibleRows.length - 1
    if (insertedRows > 0 && updatedCells === 0) {
      const firstVis = nextVisibleRows.indexOf(firstNewIdx)
      const lastVis = nextVisibleRows.indexOf(model.rows.length - 1)
      if (firstVis >= 0 && lastVis >= firstVis) {
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
    } else if (insertedRows > 0 && updatedCells > 0) {
      const lastVis = nextVisibleRows.indexOf(model.rows.length - 1)
      if (maxAllowedVisRow >= 0) {
        const clampedStart = Math.min(plan.startVisRow, maxAllowedVisRow)
        const selStartCol = Number.isFinite(minVisCol) ? minVisCol : plan.startVisCol
        const selEndCol = maxVisCol >= selStartCol ? maxVisCol : selStartCol
        const selEndRow = Math.min(
          maxAllowedVisRow,
          Math.max(clampedStart, lastVis >= clampedStart ? lastVis : maxOverwrittenVisRow)
        )
        this.selection.selectCell(clampedStart, selStartCol, 'cell')
        if (selEndRow !== clampedStart || selEndCol !== selStartCol) {
          this.selection.extendTo(selEndRow, selEndCol, 'cell')
        }
      } else {
        this.selection.clear()
      }
      if (this.isTransposed) {
        this.renderHeader()
      }
      this.scrollToBottomForRows(nextVisibleRows.length)
    } else {
      if (maxAllowedVisRow >= 0) {
        const clampedStart = Math.min(plan.startVisRow, maxAllowedVisRow)
        const clampedEnd = Math.min(maxOverwrittenVisRow, maxAllowedVisRow)
        const selStartCol = Number.isFinite(minVisCol) ? minVisCol : plan.startVisCol
        const selEndCol = maxVisCol >= selStartCol ? maxVisCol : selStartCol
        this.selection.selectCell(clampedStart, selStartCol, 'cell')
        if (clampedEnd > clampedStart || selEndCol !== selStartCol) {
          this.selection.extendTo(Math.max(clampedStart, clampedEnd), selEndCol, 'cell')
        }
      } else {
        this.selection.clear()
      }
      this.renderVisibleRows()
    }

    this.refreshFindMatchesIfActive()
    this.onStageChange?.(this.getStagedCount())
    this.notifyAllSelectionListeners()
    return { updatedCells, insertedRows, skippedReadOnly, mode: plan.mode }
  }

  /**
   * Pastes RFC-4180 TSV/CSV text with smart overwrite + overflow insert (or new rows when nothing is selected).
   * Returns total affected items (updatedCells + insertedRows).
   */
  public pasteDelimitedText(text: string): number {
    const res = this.pasteDelimitedTextDetailed(text, { forceNewRows: false })
    return res.updatedCells + res.insertedRows
  }

  /**
   * Reverts all staged inserts, updates, and deletes back to the original page snapshot.
   */
  public revertAllChanges(): void {
    const model = this.model
    if (this.interactionLocked || !model) return

    const keptRows: (Record<string, unknown> | unknown[])[] = []
    const keptStates: InternalRowState[] = []

    this.rowStates.forEach((state, idx) => {
      if (state.kind === 'inserted') return
      const restored = state.original === model.rows[idx] ? state.original : cloneRow(state.original)
      keptRows.push(restored)
      keptStates.push({
        kind: 'existing',
        deleted: false,
        original: restored,
        dirtyCols: new Map<string, unknown>(),
      })
    })

    model.rows = keptRows
    this.rowStates = keptStates
    this.syncTransposedWidthsForModel()
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
    return buildGridChangesPayload(this.model, this.rowStates)
  }

  /**
   * Total number of staged operations (inserts + updates + deletes) in O(N) with zero object allocations.
   */
  public getStagedCount(): number {
    if (!this.model) return 0
    return countGridStagedChanges(this.rowStates)
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

  private isBinaryCellValue(value: unknown): boolean {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) return true
    if (typeof value === 'string' && /^\[(?:BLOB|BINARY)\b[^\]]*\]$/i.test(value.trim())) return true
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).type === 'Buffer' &&
      Array.isArray((value as Record<string, unknown>).data)
    ) {
      return true
    }
    return false
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
    if (this.isBinaryCellValue(originalValue)) {
      this.onNotify?.(`Binary/BLOB cell "${columnName}" cannot be edited inline as text.`)
      return
    }

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
    const colType =
      colDef && 'nativeType' in colDef && typeof colDef.nativeType === 'string' && colDef.nativeType
        ? colDef.nativeType
        : colDef && 'type' in colDef
          ? colDef.type
          : undefined
    return coerceCellInputValue(rawNewValue, originalValue, colType, this.isColumnNullable(colIndex))
  }

  private refreshSingleCellDisplay(
    td: HTMLTableCellElement,
    rowIndex: number,
    colIndex: number,
    columnName: string,
    value: unknown
  ): void {
    const model = this.model
    const rowState = this.rowStates[rowIndex]
    const vr = parseOptionalInt(td.dataset.visRow) ?? 0
    const vc = parseOptionalInt(td.dataset.visCol) ?? 0
    const visibleCols = this.getVisibleColumnIndices()
    const pinnedCount = this.isTransposed ? 0 : this.getPinnedVisibleCount(visibleCols)
    const pinnedOffsets = this.isTransposed ? [] : this.computePinnedLeftOffsets(visibleCols, pinnedCount)
    const activeMatch =
      this.findActiveIndex >= 0 ? (this.findMatches[this.findActiveIndex] ?? null) : null
    const evaluatedHighlight = this.evaluateRowHighlightState(model, rowIndex)
    const occKeys =
      evaluatedHighlight && model ? (this.getColKeyResolver()?.occKeys ?? null) : null
    const cellHl = this.resolveCellHighlightClass(evaluatedHighlight, occKeys, colIndex, columnName)

    if (!this.isTransposed) {
      const tr = td.parentElement
      if (tr) {
        for (const cls of HIGHLIGHT_TONE_CLASSES) {
          tr.classList.remove(cls)
        }
        if (evaluatedHighlight?.rowClass) {
          tr.classList.add(evaluatedHighlight.rowClass)
        }
      }
    }

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
      !this.isTransposed && vc < pinnedCount ? pinnedOffsets[vc] : null,
      !this.isTransposed && vc < pinnedCount && vc === pinnedCount - 1,
      cellHl
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
    const userTyped = this.activeEditor.userTyped
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
    if (originalValue === null && rawNewValue === '' && !userTyped) {
      const liveTd = this.findLiveCell(rowIndex, colIndex) ?? td
      this.refreshSingleCellDisplay(liveTd, rowIndex, colIndex, columnName, null)
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
    const prevRow = targetModel.rows[rowIndex]
    const rowState = this.rowStates[rowIndex]
    if (rowState && rowState.original === prevRow) {
      rowState.original = prevRow
    }
    // Copy-on-write row ref used as stable row identity across sort/delete races.
    const trackedRowRef = cloneRow(prevRow)
    targetModel.rows[rowIndex] = trackedRowRef
    setCellValue(trackedRowRef, colIndex, columnName, newValue)
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
      primaryKeys[pk] = getCellValue(rowState?.original ?? prevRow, pkColIdx, pk)
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

        // Stale model or row-identity guard: resolve current index via stable row ref after sort/delete
        if (this.model !== targetModel) {
          return
        }
        const liveRowIndex = rowState
          ? this.rowStates.indexOf(rowState)
          : targetModel.rows.indexOf(trackedRowRef)
        if (liveRowIndex < 0 || liveRowIndex >= targetModel.rows.length) {
          return
        }

        if (result.ok && (result.affectedRows === undefined || result.affectedRows > 0)) {
          if (result.updatedRecord) {
            const committedRow = cloneRow(result.updatedRecord)
            targetModel.rows[liveRowIndex] = committedRow
            if (rowState) {
              rowState.original = committedRow
            }
          } else if (rowState) {
            const nextOrig = cloneRow(rowState.original)
            setCellValue(nextOrig, colIndex, columnName, newValue)
            rowState.original = nextOrig
          }
          this.invalidateDataCache()
          this.invalidateFilterCache()
          const liveTd = this.findLiveCell(liveRowIndex, colIndex)
          if (liveTd) {
            liveTd.classList.remove('datanoa-cell-saving')
            const updatedVal = getCellValue(targetModel.rows[liveRowIndex], colIndex, columnName)
            this.refreshSingleCellDisplay(liveTd, liveRowIndex, colIndex, columnName, updatedVal)
          }
          this.refreshFindMatchesIfActive()
          this.notifyAllSelectionListeners()
        } else {
          this.rollbackCell(targetModel, rowState ?? trackedRowRef, colIndex, columnName, originalValue)
        }
      } catch {
        this.rollbackCell(targetModel, rowState ?? trackedRowRef, colIndex, columnName, originalValue)
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
   * Resolves the row by stable rowState/row reference so in-memory sort or row deletion never mutates a sibling row.
   */
  private static isInternalRowState(
    value: InternalRowState | Record<string, unknown> | unknown[] | number
  ): value is InternalRowState {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      'dirtyCols' in value &&
      value.dirtyCols instanceof Map
    )
  }

  private rollbackCell(
    targetModel: GridModel,
    rowIdentity: InternalRowState | Record<string, unknown> | unknown[] | number,
    colIndex: number,
    columnName: string,
    originalValue: unknown
  ): void {
    if (this.model !== targetModel) return
    const rowIndex =
      typeof rowIdentity === 'number'
        ? rowIdentity
        : VirtualDataGrid.isInternalRowState(rowIdentity)
          ? this.rowStates.indexOf(rowIdentity)
          : targetModel.rows.indexOf(rowIdentity)
    if (rowIndex < 0 || rowIndex >= targetModel.rows.length) return
    const nextRow = cloneRow(targetModel.rows[rowIndex])
    setCellValue(nextRow, colIndex, columnName, originalValue)
    targetModel.rows[rowIndex] = nextRow
    this.invalidateDataCache()
    this.invalidateFilterCache()

    const liveTd = this.findLiveCell(rowIndex, colIndex)
    if (liveTd) {
      this.refreshSingleCellDisplay(liveTd, rowIndex, colIndex, columnName, originalValue)
      liveTd.classList.add('datanoa-cell-conflict')

      const targetRef = this.rowStates[rowIndex]
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        if (this.model === targetModel && targetRef) {
          const idxNow = this.rowStates.indexOf(targetRef)
          if (idxNow >= 0) {
            const currentTd = this.findLiveCell(idxNow, colIndex)
            currentTd?.classList.remove('datanoa-cell-conflict')
          }
        }
        liveTd.classList.remove('datanoa-cell-conflict')
      }, 1500)
      this.timers.add(timer)
    }

    this.refreshFindMatchesIfActive()
    this.notifyAllSelectionListeners()
  }

  /**
   * Marks all staged changes as committed in-memory without reverting edited cells
   * back to pre-commit values (protects UI consistency when post-commit refresh fails).
   */
  public markStagedChangesCommitted(): void {
    const model = this.model
    if (!model) return
    const nextRows: Array<Record<string, unknown> | unknown[]> = []
    const nextStates: InternalRowState[] = []
    for (let i = 0; i < model.rows.length; i++) {
      const st = this.rowStates[i]
      if (st?.deleted) continue
      const row = model.rows[i]
      nextRows.push(row)
      nextStates.push({
        kind: 'existing',
        deleted: false,
        original: row,
        dirtyCols: new Map(),
      })
    }
    model.rows = nextRows
    model.rowCount = nextRows.length
    this.rowStates = nextStates
    this.invalidateDataCache()
    this.invalidateFilterCache()
    this.renderVisibleRows(true)
    this.onStageChange?.(0)
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

  public exportRuntimeState(): GridRuntimeSnapshot {
    // Copy-on-write snapshot: rows are replaced on mutation, so retaining immutable row refs
    // eliminates 4x O(N*cols) deep clones on every Filter/Find keystroke and tab switch.
    const model = this.model
      ? {
          headers: [...this.model.headers],
          columns: this.model.columns.map((c) => ({ ...c })),
          rows: [...this.model.rows],
          rowCount: this.model.rowCount,
          canEdit: this.model.canEdit,
          primaryKey: [...this.model.primaryKey],
        }
      : null
    const rowStates: InternalRowState[] = this.rowStates.map((st) => ({
      kind: st.kind,
      ...(st.origin ? { origin: st.origin } : {}),
      deleted: st.deleted,
      original: st.original,
      dirtyCols: new Map(st.dirtyCols),
    }))
    const fkSeen = new Set<ForeignKeyInfo>(this.foreignKeyByColumn.values())
    const counts = this.getHeaderOccurrenceCounts()
    const resolvedHiddenSet = this.model ? this.getResolvedHiddenKeySet() : null
    const hiddenColumns = resolvedHiddenSet
      ? Array.from(resolvedHiddenSet).map((k) => this.toDisplayColumnKey(k, counts))
      : Array.from(this.hiddenColumns)
    const pinnedColumns = resolvedHiddenSet
      ? this.getResolvedPinnedKeys(resolvedHiddenSet).map((k) => this.toDisplayColumnKey(k, counts))
      : [...this.pinnedColumns]
    return {
      model,
      rowStates,
      sortColumn: this.sortColumn,
      sortDirection: this.sortDirection,
      clientFilter: this.clientFilter,
      clientColumnFilters: this.clientColumnFilters.map((f) => ({ ...f })),
      findQuery: this.findQuery,
      findActiveIndex: this.findActiveIndex,
      hiddenColumns,
      pinnedColumns,
      scrollTop: this.tableContainerEl?.scrollTop ?? 0,
      scrollLeft: this.tableContainerEl?.scrollLeft ?? 0,
      tableName: this.tableName,
      connectionId: this.connectionId,
      schemaName: this.schemaName,
      dialect: this.dialect,
      originConnectionId: this.connectionId,
      originDriver: this.dialect,
      originSchema: this.schemaName,
      originTable: this.tableName,
      emptyMessage: this.emptyMessage,
      foreignKeys: Array.from(fkSeen),
    }
  }

  public restoreRuntimeState(snap: GridRuntimeSnapshot): void {
    this.isLoading = false
    this.cleanupColumnResize()
    this.cleanupDragSelection()
    this.activeEditor = null
    this.closeContextMenu()
    this.closeBulkFillPopover()
    this.closeColumnFilterPopover()

    this.tableName = snap.tableName || 'table_name'
    this.connectionId = snap.connectionId || ''
    this.schemaName = snap.schemaName || ''
    this.dialect = snap.dialect || 'sqlite'
    this.emptyMessage = snap.emptyMessage || 'No rows to display.'
    this.setForeignKeys(snap.foreignKeys || [])

    this.model = snap.model
      ? {
          headers: [...snap.model.headers],
          columns: snap.model.columns.map((c) => ({ ...c })),
          rows: [...snap.model.rows],
          rowCount: snap.model.rowCount,
          canEdit: snap.model.canEdit,
          primaryKey: [...snap.model.primaryKey],
        }
      : null
    this.rowStates = snap.rowStates.map((st) => ({
      kind: st.kind,
      ...(st.origin ? { origin: st.origin } : {}),
      deleted: st.deleted,
      original: st.original,
      dirtyCols: new Map(st.dirtyCols),
    }))

    this.sortColumn = snap.sortColumn
    this.sortDirection = snap.sortDirection
    this.clientFilter = snap.clientFilter || ''
    this.clientColumnFilters = (snap.clientColumnFilters || []).map((f) => ({ ...f }))
    this.findQuery = snap.findQuery || ''
    this.hiddenColumns = new Set(snap.hiddenColumns || [])
    this.pinnedColumns = [...(snap.pinnedColumns || [])]

    this.selection.clear()
    this.selectedRowIndex = null
    this.selectedColIndex = null
    this.invalidateDataCache()
    this.invalidateFilterCache()
    this.invalidateColLayoutCache()
    this.colKeyResolverHeaders = null
    this.colKeyResolverCache = null
    this.resetHeaderPool()
    this.resetRowPoolMountState()

    if (!this.model || this.model.headers.length === 0) {
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
      }
    }
    this.syncTransposedWidthsForModel()

    if (this.findQuery) {
      this.recomputeFindMatches()
      if (
        snap.findActiveIndex >= 0 &&
        snap.findActiveIndex < this.findMatches.length
      ) {
        this.findActiveIndex = snap.findActiveIndex
      }
      this.onFindStateChange?.({ total: this.findMatches.length, activeIndex: this.findActiveIndex })
    } else {
      this.findMatches = []
      this.findMatchKeys.clear()
      this.findActiveIndex = -1
      this.onFindStateChange?.({ total: 0, activeIndex: -1 })
    }

    this.renderHeader()
    this.renderVisibleRows()
    if (this.tableContainerEl) {
      this.tableContainerEl.scrollTop = snap.scrollTop || 0
      this.tableContainerEl.scrollLeft = snap.scrollLeft || 0
    }
    this.onStageChange?.(this.getStagedCount())
    this.notifyAllSelectionListeners()
  }

  public destroy(): void {
    if (this.rafHandle !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafHandle)
      this.rafHandle = null
    }
    if (this.resizeObserverRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.resizeObserverRafId)
      this.resizeObserverRafId = null
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
      if (this.tableContainerMouseDownListener) {
        this.tableContainerEl.removeEventListener('mousedown', this.tableContainerMouseDownListener)
      }
      if (this.tableContainerContextMenuListener) {
        this.tableContainerEl.removeEventListener(
          'contextmenu',
          this.tableContainerContextMenuListener
        )
      }
    }
    this.scrollListener = null
    this.wheelListener = null
    this.keyDownListener = null
    this.pasteListener = null
    this.tableContainerMouseDownListener = null
    this.tableContainerContextMenuListener = null

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
      if (this.windowPasteListener) {
        window.removeEventListener('paste', this.windowPasteListener)
        this.windowPasteListener = null
      }
    }
    this.cleanupColumnResize()
    this.cleanupDragSelection()

    this.closeContextMenu()
    this.closeBulkFillPopover()
    this.closeColumnFilterPopover()
    this.mountedRowsByVisRow.clear()
    this.freeRowPool.length = 0
    this.freeCellPool.length = 0
    this.isPoolMountedInTbody = false
    this.resetHeaderPool()
    this.colKeyResolverHeaders = null
    this.colKeyResolverCache = null
    this.mountedTransposedRowsByFieldIdx.clear()
    this.freeTransposedRowPool.length = 0
    this.isTransposedPoolMounted = false
    this.lastRenderedWindow = null
    this.lastTransposedWindow = null
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
