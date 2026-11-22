// src/editor/grid-menus.ts
// Context menus and floating popovers for VirtualDataGrid (cell menu, header menu, bulk fill, column filter)

import type { DatabaseDriverType, ForeignKeyInfo } from '../protocol.js'
import { formatSqlInList, formatSqlLiteral } from '../drivers/common/sql-tools.js'
import type { SelectionSummary } from './grid-selection.js'
import type { ColumnHeaderFilterOp } from './sql-column-filter.js'
import {
  checkCellEditGate,
  copyTextToClipboard,
  getCellValue,
  previewMenuValue,
  stringifyFilterValue,
  type GridModel,
} from './grid-formatters.js'
import { clampFixedPopup } from './grid-icons.js'
import type {
  ClientColumnFilter,
  InternalRowState,
  SelectedCellInfo,
  SelectionExportFormat,
} from './grid-data-ops.js'

export interface GridCellContextMenuOptions {
  clientX: number
  clientY: number
  rowIndex: number
  colIndex: number
  columnName: string
  rawValue: unknown
  td: HTMLTableCellElement
  model: GridModel
  rowState: InternalRowState | undefined
  interactionLocked: boolean
  batchMode: boolean
  stagedCount: number
  dialect: DatabaseDriverType
  summary: SelectionSummary
  fk: ForeignKeyInfo | null
  hasFkHandler: boolean
  isCellEditable: boolean
  isColumnNullable: boolean
  closeMenu: () => void
  copySelection: (format: SelectionExportFormat) => string
  onNotify?: (message: string) => void
  triggerPasteAction: (asNewRows: boolean) => Promise<void>
  buildSelectedCellInfo: () => SelectedCellInfo | null
  onInspectCell?: (info: SelectedCellInfo) => void
  bulkSetCellsValue: (value: unknown) => number
  applyDirectNull: () => void
  openBulkFill: (clientX: number, clientY: number, cellCount: number) => void
  triggerQuickFilter: (
    column: string,
    value: unknown,
    op: 'eq' | 'neq' | 'is-null' | 'is-not-null',
    mode: 'replace' | 'and'
  ) => void
  triggerFkJump: () => void
  bulkCloneSelectedRows: () => number
  cloneSingleRow: () => void
  bulkMarkRowsDeleted: () => void
  markSingleRowDeleted: () => void
}

export function buildGridCellContextMenu(opts: GridCellContextMenuOptions): HTMLDivElement {
  const {
    clientX,
    clientY,
    columnName,
    rawValue,
    model,
    rowState,
    interactionLocked,
    batchMode,
    stagedCount,
    dialect,
    summary,
    fk,
    hasFkHandler,
    isCellEditable,
    isColumnNullable,
    closeMenu,
    copySelection,
    onNotify,
    triggerPasteAction,
    buildSelectedCellInfo,
    onInspectCell,
    bulkSetCellsValue,
    applyDirectNull,
    openBulkFill,
    triggerQuickFilter,
    triggerFkJump,
    bulkCloneSelectedRows,
    cloneSingleRow,
    bulkMarkRowsDeleted,
    markSingleRowDeleted,
  } = opts

  const gate = checkCellEditGate(model.canEdit, model.primaryKey)
  const canEditRow =
    !interactionLocked &&
    (gate.allowed || (model.canEdit && rowState?.kind === 'inserted')) &&
    !rowState?.deleted

  const isMultiCell = summary.cellCount > 1
  const selectedRowCount = Math.max(1, summary.rowCount)

  const menu = document.createElement('div')
  menu.className = 'datanoa-context-menu'

  const addItem = (
    label: string,
    disabled: boolean,
    onClick: () => void,
    danger = false
  ): void => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `datanoa-context-item${danger ? ' danger' : ''}`
    btn.textContent = label
    btn.disabled = disabled
    btn.addEventListener('click', () => {
      closeMenu()
      onClick()
    })
    menu.appendChild(btn)
  }

  const addSep = (): void => {
    const sep = document.createElement('div')
    sep.className = 'datanoa-context-sep'
    menu.appendChild(sep)
  }

  addItem(isMultiCell ? `Copy (${summary.cellCount} cells TSV)` : 'Copy Cell (TSV)', false, () => {
    copySelection('tsv')
    onNotify?.(
      isMultiCell ? `Copied ${summary.cellCount} cells (TSV)` : `Copied ${columnName} to clipboard`
    )
  })

  addItem('Copy with Headers (TSV)', false, () => {
    copySelection('tsv-headers')
    onNotify?.('Copied selection with headers (TSV)')
  })

  addItem('Copy as CSV', false, () => {
    copySelection('csv')
    onNotify?.('Copied selection as CSV')
  })

  addItem('Copy as JSON', false, () => {
    copySelection('json')
    onNotify?.('Copied selection as JSON')
  })

  addItem('Copy as SQL IN (...)', false, () => {
    const sqlIn = copySelection('sql-in')
    if (sqlIn) {
      onNotify?.('Copied selection as SQL IN list')
    }
  })

  addItem('Copy as SQL INSERT', false, () => {
    const sqlIns = copySelection('sql-insert')
    if (sqlIns) {
      onNotify?.('Copied selection as SQL INSERT')
    }
  })

  addItem('Copy SQL Literal', false, () => {
    const literal = formatSqlLiteral(rawValue, dialect)
    copyTextToClipboard(literal)
    onNotify?.(`Copied SQL literal: ${literal}`)
  })

  const canInsertRows = !interactionLocked && model.canEdit

  addItem('Paste (Overwrite & Insert Overflow) (Ctrl+V)', !canEditRow && !canInsertRows, () => {
    void triggerPasteAction(false)
  })

  addItem('Paste as New Row(s) (Ctrl+Shift+V)', !canInsertRows, () => {
    void triggerPasteAction(true)
  })

  addSep()

  addItem('Edit in Value Inspector', false, () => {
    const info = buildSelectedCellInfo()
    if (info) {
      onInspectCell?.(info)
    }
  })

  const canEditTargetCell = isMultiCell ? canEditRow : isCellEditable
  const canSetNullTargetCell = isMultiCell ? canEditRow : canEditTargetCell && isColumnNullable
  addItem(
    isMultiCell ? `Bulk Set NULL (${summary.cellCount} cells)` : 'Set NULL',
    !canSetNullTargetCell,
    () => {
      if (isMultiCell || batchMode || stagedCount > 0 || rowState?.kind === 'inserted') {
        const count = bulkSetCellsValue(null)
        if (count > 0) {
          onNotify?.(`Set ${count} cell${count === 1 ? '' : 's'} to NULL`)
        }
      } else {
        if (!isColumnNullable) {
          onNotify?.(`Column "${columnName}" is NOT NULL — cannot set NULL.`)
          return
        }
        applyDirectNull()
      }
    }
  )

  addItem('Bulk Fill Value...', !canEditTargetCell, () => {
    openBulkFill(clientX, clientY, summary.cellCount || 1)
  })

  addSep()

  const valPreview = previewMenuValue(rawValue)
  const isNullVal = rawValue === null || rawValue === undefined

  addItem(
    isNullVal ? `Filter: ${columnName} IS NULL` : `Filter: ${columnName} = ${valPreview}`,
    false,
    () => {
      triggerQuickFilter(columnName, rawValue, isNullVal ? 'is-null' : 'eq', 'replace')
    }
  )

  addItem(
    isNullVal ? `Filter: ${columnName} IS NOT NULL` : `Filter: ${columnName} != ${valPreview}`,
    false,
    () => {
      triggerQuickFilter(columnName, rawValue, isNullVal ? 'is-not-null' : 'neq', 'replace')
    }
  )

  addItem(
    isNullVal ? `Filter AND: ${columnName} IS NULL` : `Filter AND: ${columnName} = ${valPreview}`,
    false,
    () => {
      triggerQuickFilter(columnName, rawValue, isNullVal ? 'is-null' : 'eq', 'and')
    }
  )

  if (!isNullVal) {
    addItem(`Filter: ${columnName} IS NULL`, false, () => {
      triggerQuickFilter(columnName, null, 'is-null', 'replace')
    })
  }

  if (fk && !isNullVal && hasFkHandler) {
    addSep()
    addItem(`Go to ${fk.referencedTable}.${fk.referencedColumn}`, false, () => {
      triggerFkJump()
    })
  }

  addSep()

  addItem(
    selectedRowCount > 1 ? `Clone ${selectedRowCount} Rows` : 'Clone Row',
    !model.canEdit || interactionLocked,
    () => {
      if (selectedRowCount > 1) {
        const cloned = bulkCloneSelectedRows()
        if (cloned > 0) onNotify?.(`Cloned ${cloned} rows`)
      } else {
        cloneSingleRow()
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
    !model.canEdit || interactionLocked || (!gate.allowed && rowState?.kind !== 'inserted'),
    () => {
      if (selectedRowCount > 1) {
        bulkMarkRowsDeleted()
      } else {
        markSingleRowDeleted()
      }
    },
    selectedRowCount > 1 || !rowState?.deleted
  )

  document.body.appendChild(menu)
  clampFixedPopup(menu, clientX, clientY)
  return menu
}

export interface GridCanvasContextMenuOptions {
  clientX: number
  clientY: number
  canInsert: boolean
  closeMenu: () => void
  onPasteNewRows: () => Promise<void>
  onAddBlankRow: () => void
}

export function buildGridCanvasContextMenu(opts: GridCanvasContextMenuOptions): HTMLDivElement {
  const { clientX, clientY, canInsert, closeMenu, onPasteNewRows, onAddBlankRow } = opts

  const menu = document.createElement('div')
  menu.className = 'datanoa-context-menu'

  const addItem = (label: string, disabled: boolean, onClick: () => void): void => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'datanoa-context-item'
    btn.textContent = label
    btn.disabled = disabled
    btn.addEventListener('click', () => {
      closeMenu()
      onClick()
    })
    menu.appendChild(btn)
  }

  addItem('Paste as New Row(s) (Ctrl+V)', !canInsert, () => {
    void onPasteNewRows()
  })
  addItem('+ Add Blank Row', !canInsert, () => {
    onAddBlankRow()
  })

  document.body.appendChild(menu)
  clampFixedPopup(menu, clientX, clientY)
  return menu
}

export interface GridHeaderContextMenuOptions {
  clientX: number
  clientY: number
  modelColIdx: number
  header: string
  model: GridModel
  dialect: DatabaseDriverType
  isPinned: boolean
  visibleColsCount: number
  rowIndices: readonly number[]
  closeMenu: () => void
  selectColumn: () => void
  onNotify?: (message: string) => void
  onSort: (direction: 'ASC' | 'DESC') => void
  togglePin: () => void
  hideColumn: () => void
  autoFitColumn: () => void
}

export function buildGridHeaderContextMenu(opts: GridHeaderContextMenuOptions): HTMLDivElement {
  const {
    clientX,
    clientY,
    modelColIdx,
    header,
    model,
    dialect,
    isPinned,
    visibleColsCount,
    rowIndices,
    closeMenu,
    selectColumn,
    onNotify,
    onSort,
    togglePin,
    hideColumn,
    autoFitColumn,
  } = opts

  const menu = document.createElement('div')
  menu.className = 'datanoa-context-menu'

  const addItem = (label: string, disabled: boolean, onClick: () => void): void => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'datanoa-context-item'
    btn.textContent = label
    btn.disabled = disabled
    btn.addEventListener('click', () => {
      closeMenu()
      onClick()
    })
    menu.appendChild(btn)
  }

  const addSep = (): void => {
    const sep = document.createElement('div')
    sep.className = 'datanoa-context-sep'
    menu.appendChild(sep)
  }

  addItem('Select Column', false, selectColumn)

  addItem('Copy Column Values', false, () => {
    const lines = rowIndices.map((rIdx) => {
      const val = getCellValue(model.rows[rIdx], modelColIdx, header)
      if (val === null || val === undefined) return ''
      const str = stringifyFilterValue(val)
      if (
        rowIndices.length > 1 &&
        (str.includes('\t') || str.includes('"') || str.includes('\n') || str.includes('\r'))
      ) {
        return `"${str.replace(/"/g, '""')}"`
      }
      return str
    })
    copyTextToClipboard(lines.join('\n'))
    onNotify?.(`Copied ${lines.length} values from "${header}"`)
  })

  addItem('Copy as SQL IN (...)', false, () => {
    const vals = rowIndices.map((rIdx) => getCellValue(model.rows[rIdx], modelColIdx, header))
    const sqlIn = formatSqlInList(vals, dialect, { deduplicate: true, columnName: header })
    if (sqlIn) {
      copyTextToClipboard(sqlIn)
      onNotify?.(`Copied "${header}" as SQL IN list`)
    }
  })

  addItem('Copy Column Name', false, () => {
    copyTextToClipboard(header)
    onNotify?.(`Copied column name "${header}"`)
  })

  addSep()

  addItem('Sort Ascending (ASC)', false, () => onSort('ASC'))
  addItem('Sort Descending (DESC)', false, () => onSort('DESC'))

  addSep()

  addItem(isPinned ? 'Unpin Column' : 'Pin Column', false, togglePin)
  addItem('Hide Column', visibleColsCount <= 1, hideColumn)
  addItem('Auto-fit Column', false, autoFitColumn)

  document.body.appendChild(menu)
  clampFixedPopup(menu, clientX, clientY)
  return menu
}

export interface GridBulkFillPopoverOptions {
  clientX: number
  clientY: number
  cellCount: number
  closePopover: () => void
  onApplyValue: (val: unknown) => number
  onNotify?: (message: string) => void
}

export function buildGridBulkFillPopover(opts: GridBulkFillPopoverOptions): HTMLDivElement {
  const { clientX, clientY, cellCount, closePopover, onApplyValue, onNotify } = opts

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
    closePopover()
    const updated = onApplyValue(null)
    if (updated > 0) onNotify?.(`Set ${updated} cells to NULL`)
  })

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'datanoa-btn datanoa-btn-sm'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.addEventListener('click', closePopover)

  const applyBtn = document.createElement('button')
  applyBtn.type = 'button'
  applyBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-primary'
  applyBtn.textContent = 'Apply'
  const doApply = (): void => {
    const val = input.value
    closePopover()
    const updated = onApplyValue(val)
    if (updated > 0) {
      onNotify?.(`Filled ${updated} cell${updated === 1 ? '' : 's'}`)
    }
  }
  applyBtn.addEventListener('click', doApply)

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault()
      doApply()
    } else if (ev.key === 'Escape') {
      ev.preventDefault()
      closePopover()
    }
  })

  actions.appendChild(nullBtn)
  actions.appendChild(cancelBtn)
  actions.appendChild(applyBtn)
  pop.appendChild(actions)

  document.body.appendChild(pop)
  clampFixedPopup(pop, clientX, clientY)
  input.focus()
  return pop
}

export interface GridColumnFilterPopoverOptions {
  column: string
  anchorEl: HTMLElement
  existingForCol: ClientColumnFilter | undefined
  closePopover: () => void
  onApply: (rawVal: string, op: ColumnHeaderFilterOp, mode: 'query' | 'client') => void
  onClear: (op: ColumnHeaderFilterOp) => void
}

export function buildGridColumnFilterPopover(opts: GridColumnFilterPopoverOptions): HTMLDivElement {
  const { column, anchorEl, existingForCol, closePopover, onApply, onClear } = opts

  const pop = document.createElement('div')
  pop.className = 'datanoa-col-filter-popover'
  pop.setAttribute('role', 'dialog')
  pop.setAttribute('aria-label', `Filter column ${column}`)

  const title = document.createElement('div')
  title.className = 'datanoa-col-filter-title'
  title.textContent = `Filter: ${column}`
  pop.appendChild(title)

  const opSel = document.createElement('select')
  opSel.className = 'datanoa-select datanoa-col-filter-select'
  const ops: Array<[ColumnHeaderFilterOp, string]> = [
    ['contains', 'Contains (LIKE)'],
    ['eq', 'Equals (=)'],
    ['neq', 'Not equals (<>)'],
    ['is-null', 'IS NULL'],
    ['is-not-null', 'IS NOT NULL'],
  ]
  for (const [val, label] of ops) {
    const opt = document.createElement('option')
    opt.value = val
    opt.textContent = label
    opSel.appendChild(opt)
  }
  opSel.value = existingForCol?.op ?? 'contains'
  pop.appendChild(opSel)

  const valInp = document.createElement('input')
  valInp.type = 'text'
  valInp.className = 'datanoa-filter-input datanoa-col-filter-input'
  valInp.placeholder = 'Filter value...'
  valInp.value =
    existingForCol && existingForCol.value !== null && existingForCol.value !== undefined
      ? stringifyFilterValue(existingForCol.value)
      : ''
  pop.appendChild(valInp)

  const syncInputDisabled = (): void => {
    const noVal = opSel.value === 'is-null' || opSel.value === 'is-not-null'
    valInp.disabled = noVal
    valInp.placeholder = noVal ? '(no value needed)' : 'Filter value...'
  }
  opSel.addEventListener('change', syncInputDisabled)
  syncInputDisabled()

  const actions = document.createElement('div')
  actions.className = 'datanoa-col-filter-actions'

  const applyMode = (mode: 'query' | 'client'): void => {
    const op = opSel.value as ColumnHeaderFilterOp
    const rawVal = valInp.value
    if (op !== 'is-null' && op !== 'is-not-null' && rawVal.trim().length === 0) {
      closePopover()
      onClear(op)
      return
    }
    closePopover()
    onApply(rawVal, op, mode)
  }

  const applyBtn = document.createElement('button')
  applyBtn.type = 'button'
  applyBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-primary'
  applyBtn.textContent = 'Apply'
  applyBtn.title = 'Apply filter to query / table'
  applyBtn.addEventListener('click', () => applyMode('query'))

  const localBtn = document.createElement('button')
  localBtn.type = 'button'
  localBtn.className = 'datanoa-btn datanoa-btn-sm'
  localBtn.textContent = 'Loaded'
  localBtn.title = 'Filter loaded rows instantly without re-querying'
  localBtn.addEventListener('click', () => applyMode('client'))

  const clearBtn = document.createElement('button')
  clearBtn.type = 'button'
  clearBtn.className = 'datanoa-btn datanoa-btn-sm'
  clearBtn.textContent = 'Clear'
  clearBtn.addEventListener('click', () => {
    closePopover()
    onClear('contains')
  })

  actions.appendChild(applyBtn)
  actions.appendChild(localBtn)
  actions.appendChild(clearBtn)
  pop.appendChild(actions)

  valInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      applyMode('query')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closePopover()
    }
  })

  document.body.appendChild(pop)
  const rect = anchorEl.getBoundingClientRect()
  clampFixedPopup(pop, rect.left, rect.bottom + 4)
  if (!valInp.disabled) {
    valInp.focus()
    valInp.select()
  } else {
    applyBtn.focus()
  }
  return pop
}
