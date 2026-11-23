// src/editor/studio-dom.ts
// Typed DOM shell builder for DatanoaStudioEditor (extracts ~1,000 lines of layout construction from index.ts)

import { DATANOA_LOGO_DATA_URI } from '../assets/logo.js'
import { createDbLogoSvg, createSvgElement } from './db-icons.js'

export interface StudioDomRefs {
  rootEl: HTMLDivElement
  sidebarEl: HTMLElement
  sidebarToggleBtn: HTMLButtonElement
  connLogoEl: HTMLSpanElement
  connSelectEl: HTMLSelectElement
  envPillEl: HTMLSpanElement
  roBadgeEl: HTMLSpanElement
  addConnBtn: HTMLButtonElement
  editConnBtn: HTMLButtonElement
  cautionStripEl: HTMLDivElement
  cautionStripTextEl: HTMLSpanElement
  cautionStripCloseBtn: HTMLButtonElement
  runBtn: HTMLButtonElement
  runAllBtn: HTMLButtonElement
  explainBtn: HTMLButtonElement
  formatSqlBtn: HTMLButtonElement
  cancelQueryBtn: HTMLButtonElement
  historyBtn: HTMLButtonElement
  savedQueriesBtn: HTMLButtonElement
  findSqlBtn: HTMLButtonElement
  refreshBtn: HTMLButtonElement
  sqlToolbarEl: HTMLDivElement
  tabButtons: Record<'split' | 'grid' | 'sql' | 'inspector', HTMLButtonElement>
  searchInputEl: HTMLInputElement
  newTableBtn: HTMLButtonElement
  schemaSelectEl: HTMLSelectElement
  exportDdlBtn: HTMLButtonElement
  sidebarListEl: HTMLDivElement
  mainViewEl: HTMLDivElement
  tableTopbarEl: HTMLDivElement
  topbarFilterInputEl: HTMLInputElement
  topbarCountEl: HTMLSpanElement
  topbarPrevBtn: HTMLButtonElement
  topbarTrackEl: HTMLDivElement
  topbarNextBtn: HTMLButtonElement
  topbarAllBtn: HTMLButtonElement
  topbarNewTableBtn: HTMLButtonElement
  sqlAreaEl: HTMLDivElement
  consoleTabsBarEl: HTMLDivElement
  splitResizerEl: HTMLDivElement
  historyDrawerEl: HTMLDivElement
  historySearchEl: HTMLInputElement
  clearHistoryBtn: HTMLButtonElement
  closeHistoryBtn: HTMLButtonElement
  historyListEl: HTMLDivElement
  gridSubbarEl: HTMLDivElement
  gridSubbarTitleEl: HTMLSpanElement
  addRowBtn: HTMLButtonElement
  delRowBtn: HTMLButtonElement
  cloneRowBtn: HTMLButtonElement
  inspectCellBtn: HTMLButtonElement
  dmlPreviewBtn: HTMLButtonElement
  submitBtn: HTMLButtonElement
  revertBtn: HTMLButtonElement
  transposeBtn: HTMLButtonElement
  columnsBtn: HTMLButtonElement
  editTableBtn: HTMLButtonElement
  importDataBtn: HTMLButtonElement
  exportSelectEl: HTMLSelectElement
  batchModeBtn: HTMLButtonElement
  prevBtn: HTMLButtonElement
  gridPageInfoEl: HTMLSpanElement
  nextBtn: HTMLButtonElement
  pageSizeSelectEl: HTMLSelectElement
  gridToolbarEl: HTMLDivElement
  whereInputEl: HTMLInputElement
  orderByInputEl: HTMLInputElement
  filterBtn: HTMLButtonElement
  clearFilterBtn: HTMLButtonElement
  searchModeBtn: HTMLButtonElement
  clientSearchEl: HTMLInputElement
  findCountEl: HTMLSpanElement
  findPrevBtn: HTMLButtonElement
  findNextBtn: HTMLButtonElement
  dmlPreviewEl: HTMLDivElement
  dmlApplyBtn: HTMLButtonElement
  dmlCopyBtn: HTMLButtonElement
  dmlCloseBtn: HTMLButtonElement
  dmlPreviewPreEl: HTMLPreElement
  queryBannerEl: HTMLDivElement
  queryBannerTitleEl: HTMLSpanElement
  queryBannerDetailEl: HTMLDivElement
  queryBannerRetryBtn: HTMLButtonElement
  queryBannerBackBtn: HTMLButtonElement
  queryBannerCopyBtn: HTMLButtonElement
  queryBannerReportBtn: HTMLButtonElement
  queryBannerCloseBtn: HTMLButtonElement
  gridAreaEl: HTMLDivElement
  resultSetsBarEl: HTMLDivElement
  inspectorAreaEl: HTMLDivElement
  statusStateEl: HTMLSpanElement
  statusSelectionEl: HTMLButtonElement
  shortcutHintEl: HTMLSpanElement
  statusMetricsEl: HTMLSpanElement
  shortcutsBtn: HTMLButtonElement
  feedbackBtn: HTMLButtonElement
}

const PAGE_SIZE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '100', label: '100 / page' },
  { value: '500', label: '500 / page' },
  { value: '1000', label: '1,000 / page' },
  { value: '5000', label: '5,000 / page' },
  { value: '10000', label: '10,000 / page' },
]

export function createStudioDomTree(
  initialPageSize: number,
  mountTransactionToolbar: (parent: HTMLElement) => void,
  valueInspectorEl: HTMLElement
): StudioDomRefs {
  const rootEl = document.createElement('div')
  rootEl.className = 'datanoa-editor-root'

  // 1. Top Studio Header Toolbar
  const toolbar = document.createElement('div')
  toolbar.className = 'datanoa-toolbar'

  const sidebarToggleBtn = document.createElement('button')
  sidebarToggleBtn.type = 'button'
  sidebarToggleBtn.className = 'datanoa-btn datanoa-sidebar-toggle'
  sidebarToggleBtn.title = 'Switch Table Explorer Mode (Left Sidebar ↔ Top Horizontal Bar)'
  sidebarToggleBtn.setAttribute('aria-label', 'Switch Table Explorer Mode')
  const menuSvg = createSvgElement('svg', {
    width: '14',
    height: '14',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'aria-hidden': 'true',
  })
  menuSvg.appendChild(createSvgElement('line', { x1: '3', y1: '6', x2: '21', y2: '6' }))
  menuSvg.appendChild(createSvgElement('line', { x1: '3', y1: '12', x2: '21', y2: '12' }))
  menuSvg.appendChild(createSvgElement('line', { x1: '3', y1: '18', x2: '21', y2: '18' }))
  sidebarToggleBtn.appendChild(menuSvg)

  const brandPill = document.createElement('div')
  brandPill.className = 'datanoa-brand-pill'
  const brandLogo = document.createElement('img')
  brandLogo.className = 'datanoa-brand-logo'
  brandLogo.src = DATANOA_LOGO_DATA_URI
  brandLogo.alt = 'Datanoa'
  const brandText = document.createElement('span')
  brandText.textContent = 'Datanoa Studio'
  brandPill.appendChild(brandLogo)
  brandPill.appendChild(brandText)

  const connCluster = document.createElement('div')
  connCluster.className = 'datanoa-conn-cluster'

  const connLogoEl = document.createElement('span')
  connLogoEl.className = 'datanoa-db-logo'
  connLogoEl.appendChild(createDbLogoSvg('sqlite'))

  const connSelectEl = document.createElement('select')
  connSelectEl.className = 'datanoa-select'
  connSelectEl.setAttribute('aria-label', 'Active Database Connection')
  const defaultOpt = document.createElement('option')
  defaultOpt.value = ''
  defaultOpt.textContent = 'Select Connection...'
  connSelectEl.appendChild(defaultOpt)

  const envPillEl = document.createElement('span')
  envPillEl.className = 'datanoa-env-pill'
  envPillEl.style.display = 'none'

  const roBadgeEl = document.createElement('span')
  roBadgeEl.className = 'datanoa-ro-badge'
  roBadgeEl.textContent = 'RO'
  roBadgeEl.title = 'Read-Only Connection'
  roBadgeEl.style.display = 'none'

  const addConnBtn = document.createElement('button')
  addConnBtn.type = 'button'
  addConnBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-add-conn-btn'
  addConnBtn.textContent = '+ Connect'
  addConnBtn.title = 'Add a new database connection'

  const editConnBtn = document.createElement('button')
  editConnBtn.type = 'button'
  editConnBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-edit-conn-btn'
  editConnBtn.textContent = 'Edit'
  editConnBtn.title = 'Edit active database connection'
  editConnBtn.disabled = true

  connCluster.appendChild(connLogoEl)
  connCluster.appendChild(connSelectEl)
  connCluster.appendChild(envPillEl)
  connCluster.appendChild(roBadgeEl)
  connCluster.appendChild(addConnBtn)
  connCluster.appendChild(editConnBtn)

  const runBtn = document.createElement('button')
  runBtn.type = 'button'
  runBtn.className = 'datanoa-btn datanoa-btn-primary'
  runBtn.textContent = 'Execute (Ctrl+Enter)'

  const runAllBtn = document.createElement('button')
  runAllBtn.type = 'button'
  runAllBtn.className = 'datanoa-btn'
  runAllBtn.textContent = 'Execute All'
  runAllBtn.title = 'Execute all SQL statements in console (Ctrl+Shift+Enter)'

  const explainBtn = document.createElement('button')
  explainBtn.type = 'button'
  explainBtn.className = 'datanoa-btn'
  explainBtn.textContent = 'Explain'

  const formatSqlBtn = document.createElement('button')
  formatSqlBtn.type = 'button'
  formatSqlBtn.className = 'datanoa-btn'
  formatSqlBtn.textContent = 'Format SQL'
  formatSqlBtn.title = 'Format SQL in console (Shift+Alt+F)'

  const cancelQueryBtn = document.createElement('button')
  cancelQueryBtn.type = 'button'
  cancelQueryBtn.className = 'datanoa-btn datanoa-btn-danger'
  cancelQueryBtn.textContent = 'Cancel'
  cancelQueryBtn.style.display = 'none'

  const historyBtn = document.createElement('button')
  historyBtn.type = 'button'
  historyBtn.className = 'datanoa-btn'
  historyBtn.textContent = 'Query History'

  const savedQueriesBtn = document.createElement('button')
  savedQueriesBtn.type = 'button'
  savedQueriesBtn.className = 'datanoa-btn'
  savedQueriesBtn.textContent = 'Saved'
  savedQueriesBtn.title = 'Saved Queries / SQL Snippets'

  const refreshBtn = document.createElement('button')
  refreshBtn.type = 'button'
  refreshBtn.className = 'datanoa-btn'
  refreshBtn.textContent = 'Refresh'

  const sqlToolbarEl = document.createElement('div')
  sqlToolbarEl.className = 'datanoa-sql-toolbar'
  sqlToolbarEl.appendChild(runBtn)
  sqlToolbarEl.appendChild(runAllBtn)
  sqlToolbarEl.appendChild(explainBtn)
  sqlToolbarEl.appendChild(formatSqlBtn)
  sqlToolbarEl.appendChild(cancelQueryBtn)
  sqlToolbarEl.appendChild(historyBtn)
  sqlToolbarEl.appendChild(savedQueriesBtn)
  mountTransactionToolbar(sqlToolbarEl)

  const findSqlBtn = document.createElement('button')
  findSqlBtn.type = 'button'
  findSqlBtn.className = 'datanoa-btn datanoa-btn-sm'
  findSqlBtn.textContent = 'Find'
  findSqlBtn.title = 'Find & Replace in SQL Console (Ctrl+F / Ctrl+H)'
  sqlToolbarEl.appendChild(findSqlBtn)

  const tabsContainer = document.createElement('div')
  tabsContainer.className = 'datanoa-tabs'

  const splitTabBtn = document.createElement('button')
  splitTabBtn.type = 'button'
  splitTabBtn.className = 'datanoa-tab-btn active'
  splitTabBtn.textContent = 'Split View'

  const gridTabBtn = document.createElement('button')
  gridTabBtn.type = 'button'
  gridTabBtn.className = 'datanoa-tab-btn'
  gridTabBtn.textContent = 'Data Grid'

  const sqlTabBtn = document.createElement('button')
  sqlTabBtn.type = 'button'
  sqlTabBtn.className = 'datanoa-tab-btn'
  sqlTabBtn.textContent = 'SQL Console'

  const inspectorTabBtn = document.createElement('button')
  inspectorTabBtn.type = 'button'
  inspectorTabBtn.className = 'datanoa-tab-btn'
  inspectorTabBtn.textContent = 'Schema Inspector'

  const tabButtons: Record<'split' | 'grid' | 'sql' | 'inspector', HTMLButtonElement> = {
    split: splitTabBtn,
    grid: gridTabBtn,
    sql: sqlTabBtn,
    inspector: inspectorTabBtn,
  }

  tabsContainer.appendChild(splitTabBtn)
  tabsContainer.appendChild(gridTabBtn)
  tabsContainer.appendChild(sqlTabBtn)
  tabsContainer.appendChild(inspectorTabBtn)

  toolbar.appendChild(sidebarToggleBtn)
  toolbar.appendChild(brandPill)
  toolbar.appendChild(connCluster)
  toolbar.appendChild(refreshBtn)
  toolbar.appendChild(tabsContainer)

  const cautionStripEl = document.createElement('div')
  cautionStripEl.className = 'datanoa-caution-strip'
  cautionStripEl.style.display = 'none'

  const cautionStripTextEl = document.createElement('span')
  cautionStripTextEl.className = 'datanoa-caution-strip-text'

  const cautionStripCloseBtn = document.createElement('button')
  cautionStripCloseBtn.type = 'button'
  cautionStripCloseBtn.className = 'datanoa-caution-strip-close'
  cautionStripCloseBtn.setAttribute('aria-label', 'Dismiss warning')
  cautionStripCloseBtn.title = 'Dismiss warning'
  cautionStripCloseBtn.textContent = '×'

  cautionStripEl.appendChild(cautionStripTextEl)
  cautionStripEl.appendChild(cautionStripCloseBtn)

  // 2. Three-Pane Studio Body
  const workspaceBody = document.createElement('div')
  workspaceBody.className = 'datanoa-workspace-body'

  const sidebarEl = document.createElement('aside')
  sidebarEl.className = 'datanoa-sidebar'

  const sidebarHeader = document.createElement('div')
  sidebarHeader.className = 'datanoa-sidebar-header'

  const searchInputEl = document.createElement('input')
  searchInputEl.className = 'datanoa-search-input'
  searchInputEl.type = 'search'
  searchInputEl.placeholder = 'Filter objects...'

  const newTableBtn = document.createElement('button')
  newTableBtn.type = 'button'
  newTableBtn.className = 'datanoa-btn datanoa-btn-sm'
  newTableBtn.textContent = '+ New Table'
  newTableBtn.title = 'Create a new table visually'
  newTableBtn.disabled = true

  const sidebarControls = document.createElement('div')
  sidebarControls.className = 'datanoa-sidebar-controls'

  const schemaSelectEl = document.createElement('select')
  schemaSelectEl.className = 'datanoa-schema-select'
  schemaSelectEl.title = 'Switch active database schema'
  schemaSelectEl.setAttribute('aria-label', 'Active schema')
  schemaSelectEl.style.display = 'none'

  const exportDdlBtn = document.createElement('button')
  exportDdlBtn.type = 'button'
  exportDdlBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-export-ddl-btn'
  exportDdlBtn.textContent = 'Export DDL'
  exportDdlBtn.title = 'Export full schema DDL as a .sql file'
  exportDdlBtn.disabled = true

  sidebarControls.appendChild(schemaSelectEl)
  sidebarControls.appendChild(exportDdlBtn)
  sidebarHeader.appendChild(searchInputEl)
  sidebarHeader.appendChild(sidebarControls)
  sidebarHeader.appendChild(newTableBtn)

  const sidebarListEl = document.createElement('div')
  sidebarListEl.className = 'datanoa-sidebar-list'

  sidebarEl.appendChild(sidebarHeader)
  sidebarEl.appendChild(sidebarListEl)

  const mainViewEl = document.createElement('div')
  mainViewEl.className = 'datanoa-main-view'

  const tableTopbarEl = document.createElement('div')
  tableTopbarEl.className = 'datanoa-table-topbar'

  const topbarFilterWrap = document.createElement('div')
  topbarFilterWrap.className = 'datanoa-topbar-filter-wrap'

  const topbarFilterInputEl = document.createElement('input')
  topbarFilterInputEl.className = 'datanoa-topbar-filter'
  topbarFilterInputEl.type = 'search'
  topbarFilterInputEl.placeholder = 'Filter objects...'

  const topbarCountEl = document.createElement('span')
  topbarCountEl.className = 'datanoa-topbar-count'
  topbarCountEl.textContent = '0'

  topbarFilterWrap.appendChild(topbarFilterInputEl)
  topbarFilterWrap.appendChild(topbarCountEl)

  const topbarPrevBtn = document.createElement('button')
  topbarPrevBtn.type = 'button'
  topbarPrevBtn.className = 'datanoa-topbar-nav-btn'
  topbarPrevBtn.title = 'Scroll tables left'
  topbarPrevBtn.textContent = '‹'

  const topbarTrackEl = document.createElement('div')
  topbarTrackEl.className = 'datanoa-table-topbar-track'

  const topbarNextBtn = document.createElement('button')
  topbarNextBtn.type = 'button'
  topbarNextBtn.className = 'datanoa-topbar-nav-btn'
  topbarNextBtn.title = 'Scroll tables right'
  topbarNextBtn.textContent = '›'

  const topbarAllBtn = document.createElement('button')
  topbarAllBtn.type = 'button'
  topbarAllBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-topbar-all-btn'
  topbarAllBtn.textContent = 'All (0) ▾'
  topbarAllBtn.title = 'Browse all objects grouped by type'
  topbarAllBtn.setAttribute('aria-haspopup', 'listbox')
  topbarAllBtn.setAttribute('aria-expanded', 'false')

  const topbarNewTableBtn = document.createElement('button')
  topbarNewTableBtn.type = 'button'
  topbarNewTableBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-topbar-new-table-btn'
  topbarNewTableBtn.textContent = '+ Table'
  topbarNewTableBtn.title = 'Create a new table visually'
  topbarNewTableBtn.disabled = true

  tableTopbarEl.appendChild(topbarFilterWrap)
  tableTopbarEl.appendChild(topbarPrevBtn)
  tableTopbarEl.appendChild(topbarTrackEl)
  tableTopbarEl.appendChild(topbarNextBtn)
  tableTopbarEl.appendChild(topbarAllBtn)
  tableTopbarEl.appendChild(topbarNewTableBtn)

  const sqlAreaEl = document.createElement('div')
  sqlAreaEl.className = 'datanoa-sql-area'

  const consoleTabsBarEl = document.createElement('div')
  consoleTabsBarEl.className = 'datanoa-console-tabs'

  const splitResizerEl = document.createElement('div')
  splitResizerEl.className = 'datanoa-split-resizer'
  splitResizerEl.title = 'Drag to resize SQL Console & Data Grid'

  const historyDrawerEl = document.createElement('div')
  historyDrawerEl.className = 'datanoa-history-drawer'
  historyDrawerEl.style.display = 'none'

  const historyHead = document.createElement('div')
  historyHead.className = 'datanoa-drawer-head'
  const historyTitle = document.createElement('span')
  historyTitle.textContent = 'Query History'

  const historySearchEl = document.createElement('input')
  historySearchEl.type = 'search'
  historySearchEl.className = 'datanoa-history-search'
  historySearchEl.placeholder = 'Filter query history...'

  const historyHeadActions = document.createElement('div')
  historyHeadActions.className = 'datanoa-btn-group'

  const clearHistoryBtn = document.createElement('button')
  clearHistoryBtn.type = 'button'
  clearHistoryBtn.className = 'datanoa-btn datanoa-btn-sm'
  clearHistoryBtn.textContent = 'Clear'

  const closeHistoryBtn = document.createElement('button')
  closeHistoryBtn.type = 'button'
  closeHistoryBtn.className = 'datanoa-btn datanoa-btn-sm'
  closeHistoryBtn.textContent = 'Close'

  historyHeadActions.appendChild(historySearchEl)
  historyHeadActions.appendChild(clearHistoryBtn)
  historyHeadActions.appendChild(closeHistoryBtn)
  historyHead.appendChild(historyTitle)
  historyHead.appendChild(historyHeadActions)

  const historyListEl = document.createElement('div')
  historyListEl.className = 'datanoa-history-list'
  historyDrawerEl.appendChild(historyHead)
  historyDrawerEl.appendChild(historyListEl)

  // Grid Sub-bar
  const gridSubbarEl = document.createElement('div')
  gridSubbarEl.className = 'datanoa-grid-subbar'

  const subLeft = document.createElement('div')
  subLeft.className = 'datanoa-grid-subbar-left'
  const gridSubbarTitleEl = document.createElement('span')
  gridSubbarTitleEl.className = 'datanoa-grid-subbar-title'
  gridSubbarTitleEl.textContent = 'Select a table'
  subLeft.appendChild(gridSubbarTitleEl)

  const gridActions = document.createElement('div')
  gridActions.className = 'datanoa-btn-group'

  const addRowBtn = document.createElement('button')
  addRowBtn.type = 'button'
  addRowBtn.className = 'datanoa-btn datanoa-btn-sm'
  addRowBtn.textContent = '+ Row'
  addRowBtn.disabled = true

  const delRowBtn = document.createElement('button')
  delRowBtn.type = 'button'
  delRowBtn.className = 'datanoa-btn datanoa-btn-sm'
  delRowBtn.textContent = '− Row'
  delRowBtn.disabled = true

  const cloneRowBtn = document.createElement('button')
  cloneRowBtn.type = 'button'
  cloneRowBtn.className = 'datanoa-btn datanoa-btn-sm'
  cloneRowBtn.textContent = 'Clone'
  cloneRowBtn.disabled = true

  const inspectCellBtn = document.createElement('button')
  inspectCellBtn.type = 'button'
  inspectCellBtn.className = 'datanoa-btn datanoa-btn-sm'
  inspectCellBtn.textContent = 'Edit Cell'
  inspectCellBtn.title = 'Open Value / JSON Inspector for the selected cell'
  inspectCellBtn.disabled = true

  const dmlPreviewBtn = document.createElement('button')
  dmlPreviewBtn.type = 'button'
  dmlPreviewBtn.className = 'datanoa-btn datanoa-btn-sm'
  dmlPreviewBtn.textContent = 'DML Preview'
  dmlPreviewBtn.disabled = true

  const submitBtn = document.createElement('button')
  submitBtn.type = 'button'
  submitBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-primary'
  submitBtn.textContent = 'Submit [0]'
  submitBtn.disabled = true

  const revertBtn = document.createElement('button')
  revertBtn.type = 'button'
  revertBtn.className = 'datanoa-btn datanoa-btn-sm'
  revertBtn.textContent = 'Revert'
  revertBtn.disabled = true

  const transposeBtn = document.createElement('button')
  transposeBtn.type = 'button'
  transposeBtn.className = 'datanoa-btn datanoa-btn-sm'
  transposeBtn.textContent = '⇄ Transpose'

  const columnsBtn = document.createElement('button')
  columnsBtn.type = 'button'
  columnsBtn.className = 'datanoa-btn datanoa-btn-sm'
  columnsBtn.textContent = 'Columns'
  columnsBtn.title = 'Toggle column visibility and pin/freeze columns'

  const editTableBtn = document.createElement('button')
  editTableBtn.type = 'button'
  editTableBtn.className = 'datanoa-btn datanoa-btn-sm'
  editTableBtn.textContent = 'Edit Table'
  editTableBtn.title = 'Open Schema Inspector & Edit Table Structure (ALTER TABLE)'

  const importDataBtn = document.createElement('button')
  importDataBtn.type = 'button'
  importDataBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-import-btn'
  importDataBtn.textContent = 'Import'
  importDataBtn.title = 'Import CSV, TSV, JSON, or NDJSON file into this table'
  importDataBtn.disabled = true

  const exportSelectEl = document.createElement('select')
  exportSelectEl.className = 'datanoa-select datanoa-select-sm'
  exportSelectEl.setAttribute('aria-label', 'Export Data Format')

  gridActions.appendChild(addRowBtn)
  gridActions.appendChild(delRowBtn)
  gridActions.appendChild(cloneRowBtn)
  gridActions.appendChild(inspectCellBtn)
  gridActions.appendChild(dmlPreviewBtn)
  gridActions.appendChild(submitBtn)
  gridActions.appendChild(revertBtn)
  gridActions.appendChild(transposeBtn)
  gridActions.appendChild(columnsBtn)
  gridActions.appendChild(editTableBtn)
  gridActions.appendChild(importDataBtn)
  gridActions.appendChild(exportSelectEl)
  subLeft.appendChild(gridActions)

  const subRight = document.createElement('div')
  subRight.className = 'datanoa-grid-subbar-right'

  const batchModeBtn = document.createElement('button')
  batchModeBtn.type = 'button'
  batchModeBtn.className = 'datanoa-btn datanoa-btn-sm active'
  batchModeBtn.textContent = 'Batch: Staged'
  batchModeBtn.title = 'Toggle between Staged Batch edits and immediate Auto-Commit'

  const prevBtn = document.createElement('button')
  prevBtn.type = 'button'
  prevBtn.className = 'datanoa-btn datanoa-btn-sm'
  prevBtn.textContent = 'Prev'
  prevBtn.disabled = true

  const gridPageInfoEl = document.createElement('span')
  gridPageInfoEl.className = 'datanoa-page-info'
  gridPageInfoEl.textContent = 'Page 1'

  const nextBtn = document.createElement('button')
  nextBtn.type = 'button'
  nextBtn.className = 'datanoa-btn datanoa-btn-sm'
  nextBtn.textContent = 'Next'
  nextBtn.disabled = true

  const pageSizeSelectEl = document.createElement('select')
  pageSizeSelectEl.className = 'datanoa-select datanoa-select-sm'
  pageSizeSelectEl.setAttribute('aria-label', 'Rows per page')
  pageSizeSelectEl.title = 'Rows per page'
  for (const optDef of PAGE_SIZE_OPTIONS) {
    const opt = document.createElement('option')
    opt.value = optDef.value
    opt.textContent = optDef.label
    if (optDef.value === String(initialPageSize)) {
      opt.selected = true
    }
    pageSizeSelectEl.appendChild(opt)
  }
  pageSizeSelectEl.value = String(initialPageSize)

  subRight.appendChild(batchModeBtn)
  subRight.appendChild(pageSizeSelectEl)
  subRight.appendChild(prevBtn)
  subRight.appendChild(gridPageInfoEl)
  subRight.appendChild(nextBtn)

  gridSubbarEl.appendChild(subLeft)
  gridSubbarEl.appendChild(subRight)

  // Filter Toolbar
  const gridToolbarEl = document.createElement('div')
  gridToolbarEl.className = 'datanoa-grid-toolbar'

  const whereGroup = document.createElement('div')
  whereGroup.className = 'datanoa-filter-group'
  const whereLbl = document.createElement('span')
  whereLbl.className = 'datanoa-filter-label'
  whereLbl.textContent = 'WHERE'
  const whereInputEl = document.createElement('input')
  whereInputEl.className = 'datanoa-filter-input'
  whereInputEl.type = 'text'
  whereInputEl.placeholder = "status = 'active' (Enter)"
  whereGroup.appendChild(whereLbl)
  whereGroup.appendChild(whereInputEl)

  const orderGroup = document.createElement('div')
  orderGroup.className = 'datanoa-filter-group'
  const orderLbl = document.createElement('span')
  orderLbl.className = 'datanoa-filter-label'
  orderLbl.textContent = 'ORDER BY'
  const orderByInputEl = document.createElement('input')
  orderByInputEl.className = 'datanoa-filter-input'
  orderByInputEl.type = 'text'
  orderByInputEl.placeholder = 'id DESC (Enter)'
  orderGroup.appendChild(orderLbl)
  orderGroup.appendChild(orderByInputEl)

  const filterBtn = document.createElement('button')
  filterBtn.type = 'button'
  filterBtn.className = 'datanoa-btn datanoa-btn-sm'
  filterBtn.textContent = 'Filter'

  const clearFilterBtn = document.createElement('button')
  clearFilterBtn.type = 'button'
  clearFilterBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-filter-clear-btn'
  clearFilterBtn.textContent = '×'
  clearFilterBtn.title = 'Clear WHERE, ORDER BY, and client column filters'
  clearFilterBtn.setAttribute('aria-label', 'Clear Filters')

  const findNavWrap = document.createElement('div')
  findNavWrap.className = 'datanoa-find-nav'

  const searchModeBtn = document.createElement('button')
  searchModeBtn.type = 'button'
  searchModeBtn.className = 'datanoa-btn datanoa-btn-sm'
  searchModeBtn.textContent = 'Mode: Filter'
  searchModeBtn.title = 'Toggle between Client Row Filter and Find & Highlight (Ctrl+F)'

  const clientSearchEl = document.createElement('input')
  clientSearchEl.className = 'datanoa-client-search'
  clientSearchEl.type = 'search'
  clientSearchEl.placeholder = 'Search rows...'

  const findCountEl = document.createElement('span')
  findCountEl.className = 'datanoa-page-info'
  findCountEl.style.display = 'none'
  findCountEl.textContent = '0 / 0'

  const findPrevBtn = document.createElement('button')
  findPrevBtn.type = 'button'
  findPrevBtn.className = 'datanoa-btn datanoa-btn-sm'
  findPrevBtn.textContent = '▲'
  findPrevBtn.title = 'Previous match (Shift+Enter)'
  findPrevBtn.style.display = 'none'

  const findNextBtn = document.createElement('button')
  findNextBtn.type = 'button'
  findNextBtn.className = 'datanoa-btn datanoa-btn-sm'
  findNextBtn.textContent = '▼'
  findNextBtn.title = 'Next match (Enter)'
  findNextBtn.style.display = 'none'

  findNavWrap.appendChild(searchModeBtn)
  findNavWrap.appendChild(clientSearchEl)
  findNavWrap.appendChild(findCountEl)
  findNavWrap.appendChild(findPrevBtn)
  findNavWrap.appendChild(findNextBtn)

  gridToolbarEl.appendChild(whereGroup)
  gridToolbarEl.appendChild(orderGroup)
  gridToolbarEl.appendChild(filterBtn)
  gridToolbarEl.appendChild(clearFilterBtn)
  gridToolbarEl.appendChild(findNavWrap)

  // Inline DML Preview Drawer
  const dmlPreviewEl = document.createElement('div')
  dmlPreviewEl.className = 'datanoa-dml-preview'
  dmlPreviewEl.style.display = 'none'

  const dmlHead = document.createElement('div')
  dmlHead.className = 'datanoa-drawer-head'
  const dmlHeadTitle = document.createElement('span')
  dmlHeadTitle.textContent = 'Pending DML Preview'
  const dmlHeadBtns = document.createElement('div')
  dmlHeadBtns.className = 'datanoa-btn-group'
  const dmlApplyBtn = document.createElement('button')
  dmlApplyBtn.type = 'button'
  dmlApplyBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-primary'
  dmlApplyBtn.textContent = 'Apply'
  const dmlCopyBtn = document.createElement('button')
  dmlCopyBtn.type = 'button'
  dmlCopyBtn.className = 'datanoa-btn datanoa-btn-sm'
  dmlCopyBtn.textContent = 'Copy SQL'
  const dmlCloseBtn = document.createElement('button')
  dmlCloseBtn.type = 'button'
  dmlCloseBtn.className = 'datanoa-btn datanoa-btn-sm'
  dmlCloseBtn.textContent = 'Close'
  dmlHeadBtns.appendChild(dmlApplyBtn)
  dmlHeadBtns.appendChild(dmlCopyBtn)
  dmlHeadBtns.appendChild(dmlCloseBtn)
  dmlHead.appendChild(dmlHeadTitle)
  dmlHead.appendChild(dmlHeadBtns)

  const dmlPreviewPreEl = document.createElement('pre')
  dmlPreviewPreEl.className = 'datanoa-dml-pre'
  dmlPreviewEl.appendChild(dmlHead)
  dmlPreviewEl.appendChild(dmlPreviewPreEl)

  // Query Banner
  const queryBannerEl = document.createElement('div')
  queryBannerEl.className = 'datanoa-query-banner'
  queryBannerEl.style.display = 'none'

  const bannerBody = document.createElement('div')
  bannerBody.className = 'datanoa-query-banner-body'
  const queryBannerTitleEl = document.createElement('span')
  queryBannerTitleEl.className = 'datanoa-query-banner-title'
  const queryBannerDetailEl = document.createElement('div')
  queryBannerDetailEl.className = 'datanoa-query-banner-detail'
  bannerBody.appendChild(queryBannerTitleEl)
  bannerBody.appendChild(queryBannerDetailEl)

  const bannerActions = document.createElement('div')
  bannerActions.className = 'datanoa-query-banner-actions'

  const queryBannerRetryBtn = document.createElement('button')
  queryBannerRetryBtn.type = 'button'
  queryBannerRetryBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-error-retry-btn'
  queryBannerRetryBtn.textContent = 'Retry'
  queryBannerRetryBtn.style.display = 'none'

  const queryBannerBackBtn = document.createElement('button')
  queryBannerBackBtn.type = 'button'
  queryBannerBackBtn.className = 'datanoa-btn datanoa-btn-sm'
  queryBannerBackBtn.textContent = 'Back to Table'
  queryBannerBackBtn.style.display = 'none'

  const queryBannerCopyBtn = document.createElement('button')
  queryBannerCopyBtn.type = 'button'
  queryBannerCopyBtn.className = 'datanoa-btn datanoa-btn-sm'
  queryBannerCopyBtn.textContent = 'Copy Error'
  queryBannerCopyBtn.style.display = 'none'

  const queryBannerReportBtn = document.createElement('button')
  queryBannerReportBtn.type = 'button'
  queryBannerReportBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-report-issue-btn'
  queryBannerReportBtn.textContent = 'Report Issue'
  queryBannerReportBtn.title = 'Report this error on GitHub Issues'
  queryBannerReportBtn.style.display = 'none'

  const queryBannerCloseBtn = document.createElement('button')
  queryBannerCloseBtn.type = 'button'
  queryBannerCloseBtn.className = 'datanoa-btn datanoa-btn-sm'
  queryBannerCloseBtn.textContent = 'Dismiss'

  bannerActions.appendChild(queryBannerRetryBtn)
  bannerActions.appendChild(queryBannerBackBtn)
  bannerActions.appendChild(queryBannerCopyBtn)
  bannerActions.appendChild(queryBannerReportBtn)
  bannerActions.appendChild(queryBannerCloseBtn)
  queryBannerEl.appendChild(bannerBody)
  queryBannerEl.appendChild(bannerActions)

  const gridAreaEl = document.createElement('div')
  gridAreaEl.className = 'datanoa-grid-area'

  const resultSetsBarEl = document.createElement('div')
  resultSetsBarEl.className = 'datanoa-result-sets-bar'
  resultSetsBarEl.style.display = 'none'

  const inspectorAreaEl = document.createElement('div')
  inspectorAreaEl.className = 'datanoa-inspector-view'
  inspectorAreaEl.style.display = 'none'

  mainViewEl.appendChild(tableTopbarEl)
  mainViewEl.appendChild(sqlToolbarEl)
  mainViewEl.appendChild(consoleTabsBarEl)
  mainViewEl.appendChild(sqlAreaEl)
  mainViewEl.appendChild(splitResizerEl)
  mainViewEl.appendChild(historyDrawerEl)
  mainViewEl.appendChild(gridSubbarEl)
  mainViewEl.appendChild(gridToolbarEl)
  mainViewEl.appendChild(dmlPreviewEl)
  mainViewEl.appendChild(queryBannerEl)
  mainViewEl.appendChild(resultSetsBarEl)
  mainViewEl.appendChild(gridAreaEl)
  mainViewEl.appendChild(valueInspectorEl)
  mainViewEl.appendChild(inspectorAreaEl)

  workspaceBody.appendChild(sidebarEl)
  workspaceBody.appendChild(mainViewEl)

  // 3. Status Bar
  const statusBar = document.createElement('div')
  statusBar.className = 'datanoa-status-bar'

  const statusStateEl = document.createElement('span')
  statusStateEl.className = 'datanoa-status-state'
  statusStateEl.textContent = 'Ready'

  const statusSelectionEl = document.createElement('button')
  statusSelectionEl.type = 'button'
  statusSelectionEl.className = 'datanoa-status-selection'
  statusSelectionEl.style.display = 'none'
  statusSelectionEl.title = 'Click to copy selection statistics to clipboard'

  const shortcutHintEl = document.createElement('span')
  shortcutHintEl.className = 'datanoa-shortcut-hint'
  shortcutHintEl.textContent =
    'Ctrl + Scroll ↔ Pan · Ctrl+K Switcher · Ctrl+F Find · Shift+Alt+F Format · Ctrl+S Submit'

  const statusMetricsEl = document.createElement('span')
  statusMetricsEl.className = 'datanoa-status-metrics'
  statusMetricsEl.textContent = '0 rows'

  const shortcutsBtn = document.createElement('button')
  shortcutsBtn.type = 'button'
  shortcutsBtn.className = 'datanoa-btn datanoa-btn-sm'
  shortcutsBtn.textContent = '?'
  shortcutsBtn.title = 'Keyboard Shortcuts (Ctrl+/)'
  shortcutsBtn.setAttribute('aria-label', 'Keyboard Shortcuts')

  const feedbackBtn = document.createElement('button')
  feedbackBtn.type = 'button'
  feedbackBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-feedback-btn'
  feedbackBtn.textContent = 'Feedback'
  feedbackBtn.title = 'Report a Bug or Request a Feature on GitHub'
  feedbackBtn.setAttribute('aria-label', 'Report a Bug or Request a Feature on GitHub')

  statusBar.appendChild(statusStateEl)
  statusBar.appendChild(statusSelectionEl)
  statusBar.appendChild(shortcutHintEl)
  statusBar.appendChild(statusMetricsEl)
  statusBar.appendChild(shortcutsBtn)
  statusBar.appendChild(feedbackBtn)

  rootEl.appendChild(toolbar)
  rootEl.appendChild(cautionStripEl)
  rootEl.appendChild(workspaceBody)
  rootEl.appendChild(statusBar)

  return {
    rootEl,
    sidebarEl,
    sidebarToggleBtn,
    connLogoEl,
    connSelectEl,
    envPillEl,
    roBadgeEl,
    addConnBtn,
    editConnBtn,
    cautionStripEl,
    cautionStripTextEl,
    cautionStripCloseBtn,
    runBtn,
    runAllBtn,
    explainBtn,
    formatSqlBtn,
    cancelQueryBtn,
    historyBtn,
    savedQueriesBtn,
    findSqlBtn,
    refreshBtn,
    sqlToolbarEl,
    tabButtons,
    searchInputEl,
    newTableBtn,
    schemaSelectEl,
    exportDdlBtn,
    sidebarListEl,
    mainViewEl,
    tableTopbarEl,
    topbarFilterInputEl,
    topbarCountEl,
    topbarPrevBtn,
    topbarTrackEl,
    topbarNextBtn,
    topbarAllBtn,
    topbarNewTableBtn,
    sqlAreaEl,
    consoleTabsBarEl,
    splitResizerEl,
    historyDrawerEl,
    historySearchEl,
    clearHistoryBtn,
    closeHistoryBtn,
    historyListEl,
    gridSubbarEl,
    gridSubbarTitleEl,
    addRowBtn,
    delRowBtn,
    cloneRowBtn,
    inspectCellBtn,
    dmlPreviewBtn,
    submitBtn,
    revertBtn,
    transposeBtn,
    columnsBtn,
    editTableBtn,
    importDataBtn,
    exportSelectEl,
    batchModeBtn,
    prevBtn,
    gridPageInfoEl,
    nextBtn,
    pageSizeSelectEl,
    gridToolbarEl,
    whereInputEl,
    orderByInputEl,
    filterBtn,
    clearFilterBtn,
    searchModeBtn,
    clientSearchEl,
    findCountEl,
    findPrevBtn,
    findNextBtn,
    dmlPreviewEl,
    dmlApplyBtn,
    dmlCopyBtn,
    dmlCloseBtn,
    dmlPreviewPreEl,
    queryBannerEl,
    queryBannerTitleEl,
    queryBannerDetailEl,
    queryBannerRetryBtn,
    queryBannerBackBtn,
    queryBannerCopyBtn,
    queryBannerReportBtn,
    queryBannerCloseBtn,
    gridAreaEl,
    resultSetsBarEl,
    inspectorAreaEl,
    statusStateEl,
    statusSelectionEl,
    shortcutHintEl,
    statusMetricsEl,
    shortcutsBtn,
    feedbackBtn,
  }
}
