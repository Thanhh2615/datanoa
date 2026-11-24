import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'
import { installDomHarness, type DomHarness } from './helpers/dom-harness.js'
import { GridSelectionModel, findGridMatches } from '../src/editor/grid-selection.js'
import {
  buildGridCellContextMenu,
  buildGridCanvasContextMenu,
  buildGridHeaderContextMenu,
  buildGridBulkFillPopover,
  buildGridColumnFilterPopover,
} from '../src/editor/grid-menus.js'
import type { GridModel } from '../src/editor/grid-formatters.js'
import type { InternalRowState } from '../src/editor/grid-data-ops.js'

let dom: DomHarness

beforeEach(() => {
  dom = installDomHarness()
})

afterEach(() => {
  vi.useRealTimers()
  dom.teardown()
})

describe('Wave 3B Step 1: grid-selection.ts & grid-menus.ts', () => {
  it('covers src/editor/grid-selection.ts full state machine, multi-range geometry & PBT', () => {
    const sel = new GridSelectionModel()
    expect(sel.isEmpty()).toBe(true)
    expect(sel.getFocus()).toBeNull()
    expect(sel.getSelectionRevision()).toBe(0)
    expect(sel.getBoundingBox()).toBeNull()
    expect(sel.getCellSelectionEdges(0, 0)).toEqual({ top: false, right: false, bottom: false, left: false })
    expect(sel.isRowSelected(-1)).toBe(false)
    expect(sel.isRowSelected(0)).toBe(false)
    expect(sel.isColSelected(-1)).toBe(false)
    expect(sel.isColSelected(0)).toBe(false)
    expect(sel.isSelected(-1, 0)).toBe(false)
    expect(sel.getSelectedRowIndices(0)).toEqual([])
    expect(sel.getSelectedColIndices(0)).toEqual([])

    // Invalid dimension guards
    sel.selectCell(Number.NaN, 0)
    sel.selectCell(-1, 0)
    sel.toggleCell(-1, 0)
    sel.extendTo(Number.NaN, 0)
    sel.selectRow(-1, 5)
    sel.selectRow(0, 0)
    sel.selectColumn(-1, 5)
    sel.selectColumn(0, 0)
    sel.moveFocus(1, 0, 0, 5)
    sel.forEachSelectedCell(0, 5, () => {})
    expect(sel.isEmpty()).toBe(true)

    // extendTo & moveFocus without anchor/focus initialize (0,0)
    sel.moveFocus(1, 1, 5, 5)
    expect(sel.getFocus()).toEqual({ row: 0, col: 0 })
    sel.clear()
    sel.extendTo(2, 2)
    expect(sel.getState().ranges).toEqual([{ startRow: 2, endRow: 2, startCol: 2, endCol: 2 }])

    // Select 3x3 inverted & toggle middle cell (1,1) -> exercises ALL 4 subtractRange splits (top, bottom, left, right)
    sel.selectCell(2, 2)
    sel.extendTo(0, 0, 'cell')
    expect(sel.getState().ranges).toEqual([{ startRow: 0, endRow: 2, startCol: 0, endCol: 2 }])
    sel.toggleCell(1, 1) // splits center out
    expect(sel.isSelected(1, 1)).toBe(false)
    expect(sel.isRowSelected(1)).toBe(true)
    expect(sel.isColSelected(1)).toBe(true)
    expect(sel.isRowSelected(9)).toBe(false)
    expect(sel.isColSelected(9)).toBe(false)

    // Toggle last remaining single cell calls clear()
    const single = new GridSelectionModel()
    single.selectCell(1, 1)
    single.toggleCell(1, 1)
    expect(single.isEmpty()).toBe(true)

    // Edges check
    sel.selectCell(1, 1)
    sel.extendTo(2, 2)
    expect(sel.getCellSelectionEdges(1, 1)).toEqual({ top: true, right: false, bottom: false, left: true })
    expect(sel.getCellSelectionEdges(2, 2)).toEqual({ top: false, right: true, bottom: true, left: false })

    // moveFocus extend vs non-extend
    sel.moveFocus(-10, 10, 4, 4, true)
    expect(sel.getFocus()).toEqual({ row: 0, col: 3 })
    sel.moveFocus(1, -1, 4, 4, false)
    expect(sel.getFocus()).toEqual({ row: 1, col: 2 })

    // selectRow: shift w/ and w/o anchor, plain, toggle partial->full, toggle full->off, toggle last->clear
    sel.clear()
    sel.selectRow(2, 4, { shift: true }) // no anchor yet
    sel.selectRow(0, 4, { shift: true }) // with anchor
    expect(sel.getSelectedRowIndices(4)).toEqual([0, 1, 2])
    sel.selectRow(1, 4)
    expect(sel.getSelectedRowIndices(4)).toEqual([1])
    sel.selectCell(0, 0)
    sel.toggleCell(0, 2) // row 0 partially selected across 2 non-adjacent intervals
    sel.selectRow(0, 4, { toggle: true }) // expands row 0 to full (4 cols) + disjoint cell
    expect(sel.isSelected(0, 3)).toBe(true)
    // Now add two adjacent pieces covering full row 3 and toggle off while other rows keep ranges non-empty
    sel.toggleCell(3, 0)
    sel.toggleCell(3, 1)
    sel.extendTo(3, 3) //Wait: extendTo replaces; build 2 pieces manually on row 2
    sel.selectRow(1, 4)
    sel.toggleCell(2, 0)
    sel.toggleCell(2, 1)
    sel.toggleCell(2, 2)
    sel.toggleCell(2, 3)
    sel.selectRow(2, 4, { toggle: true }) // full row 2 toggled OFF while row 1 remains
    expect(sel.isRowSelected(2)).toBe(false)
    expect(sel.isRowSelected(1)).toBe(true)
    sel.selectRow(1, 4, { toggle: true }) // last row toggled OFF -> clear()
    expect(sel.isEmpty()).toBe(true)

    // selectColumn symmetric paths
    sel.selectColumn(2, 4, { shift: true })
    sel.selectColumn(0, 4, { shift: true })
    expect(sel.getSelectedColIndices(4)).toEqual([0, 1, 2])
    sel.selectColumn(1, 4)
    expect(sel.getSelectedColIndices(4)).toEqual([1])
    sel.toggleCell(0, 2)
    sel.toggleCell(1, 2)
    sel.toggleCell(2, 2)
    sel.selectColumn(2, 4, { toggle: true }) // partial -> full col 2
    expect(sel.isSelected(3, 2)).toBe(true)
    sel.selectColumn(2, 4, { toggle: true }) // full -> off while col 1 remains
    expect(sel.isColSelected(2)).toBe(false)
    sel.selectColumn(1, 4, { toggle: true }) // last col -> clear()
    expect(sel.isEmpty()).toBe(true)

    // selectAll invalid & valid
    sel.selectCell(0, 0)
    sel.selectAll(0, 5)
    expect(sel.isEmpty()).toBe(true)
    sel.selectAll(3, 4)
    expect(sel.getSelectionRevision()).toBeGreaterThan(0)
    expect(sel.getBoundingBox()).toEqual({ startRow: 0, endRow: 2, startCol: 0, endCol: 3 })

    // Multi-range getBoundingBox + forEachSelectedCell early stop + out-of-bounds clamp
    sel.selectCell(2, 2)
    sel.toggleCell(0, 3)
    sel.toggleCell(3, 0)
    sel.toggleCell(10, 10) // out of 4x4 bounds
    expect(sel.getBoundingBox()).toEqual({ startRow: 0, endRow: 10, startCol: 0, endCol: 10 })
    expect(sel.getSelectedRowIndices(4)).toEqual([0, 2, 3])
    expect(sel.getSelectedColIndices(4)).toEqual([0, 2, 3])

    let countMulti = 0
    sel.forEachSelectedCell(4, 4, () => {
      countMulti++
      if (countMulti === 2) return false
    })
    expect(countMulti).toBe(2)

    sel.selectAll(3, 3)
    let countSingle = 0
    sel.forEachSelectedCell(3, 3, () => {
      countSingle++
      return false
    })
    expect(countSingle).toBe(1)

    // computeSelectionSummary: empty, out-of-bounds, numeric parsing, single-range cap, multi-range cap & interval gaps
    const emptySel = new GridSelectionModel()
    expect(emptySel.computeSelectionSummary(3, 3, () => 1).cellCount).toBe(0)
    emptySel.selectCell(10, 10)
    expect(emptySel.computeSelectionSummary(3, 3, () => 1).cellCount).toBe(0)

    const gridVals: unknown[][] = [
      [10, ' 2.5e1 ', 'abc'],
      [null, '1e500', Number.POSITIVE_INFINITY],
      [true, -5, ''],
    ]
    sel.selectAll(3, 3)
    const sumFull = sel.computeSelectionSummary(3, 3, (r, c) => gridVals[r][c], -1)
    expect(sumFull.numericCount).toBe(3) // 10, 25, -5
    expect(sumFull.sum).toBe(30)
    expect(sumFull.min).toBe(-5)
    expect(sumFull.max).toBe(25)

    const sumSingleCap = sel.computeSelectionSummary(3, 3, (r, c) => gridVals[r][c], 2)
    expect(sumSingleCap.isTruncatedScan).toBe(true)

    // Multi-range summary with gap in intervals + cap truncation + merge interval subsumption
    sel.selectCell(0, 0)
    sel.extendTo(0, 1)
    sel.toggleCell(0, 2) // merges adjacent [0,1] and [2,2]
    sel.toggleCell(2, 0)
    sel.toggleCell(2, 2) // non-adjacent row/col gap
    const sumMulti = sel.computeSelectionSummary(3, 3, (r, c) => gridVals[r][c], 3)
    expect(sumMulti.isTruncatedScan).toBe(true)
    const sumMultiFull = sel.computeSelectionSummary(3, 3, (r, c) => gridVals[r][c], 50)
    expect(sumMultiFull.numericCount).toBe(2) // (0,0)=10 and (2,0)=true->null, wait (0,1)=25!

    // findGridMatches
    expect(findGridMatches('', 3, 3, () => 'a')).toEqual([])
    expect(findGridMatches('a', 0, 3, () => 'a')).toEqual([])
    expect(findGridMatches('a', 3, 3, () => 'a', 0)).toEqual([])
    expect(
      findGridMatches(
        'foo',
        2,
        2,
        (r, c) => (r === 0 && c === 0 ? 'FOO_1' : r === 0 ? (123 as unknown as string) : 'bar_Foo_2'),
        1
      )
    ).toEqual([{ row: 0, col: 0 }])
    expect(findGridMatches('foo', 2, 2, (r, c) => (r === 1 && c === 1 ? 'xFOOy' : 'no'))).toEqual([
      { row: 1, col: 1 },
    ])

    // fast-check PBT: random ops preserve invariants between isEmpty, getBoundingBox, isSelected & forEachSelectedCell
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ op: fc.constant('cell' as const), r: fc.nat({ max: 4 }), c: fc.nat({ max: 4 }) }),
            fc.record({ op: fc.constant('ext' as const), r: fc.nat({ max: 4 }), c: fc.nat({ max: 4 }) }),
            fc.record({ op: fc.constant('tog' as const), r: fc.nat({ max: 4 }), c: fc.nat({ max: 4 }) }),
            fc.record({ op: fc.constant('row' as const), r: fc.nat({ max: 4 }), toggle: fc.boolean() }),
            fc.record({ op: fc.constant('col' as const), c: fc.nat({ max: 4 }), toggle: fc.boolean() }),
            fc.record({ op: fc.constant('move' as const), dr: fc.integer({ min: -2, max: 2 }), dc: fc.integer({ min: -2, max: 2 }), ext: fc.boolean() }),
            fc.record({ op: fc.constant('all' as const) }),
            fc.record({ op: fc.constant('clr' as const) })
          ),
          { maxLength: 25 }
        ),
        (ops) => {
          const m = new GridSelectionModel()
          for (const st of ops) {
            if (st.op === 'cell') m.selectCell(st.r, st.c)
            else if (st.op === 'ext') m.extendTo(st.r, st.c)
            else if (st.op === 'tog') m.toggleCell(st.r, st.c)
            else if (st.op === 'row') m.selectRow(st.r, 5, { toggle: st.toggle })
            else if (st.op === 'col') m.selectColumn(st.c, 5, { toggle: st.toggle })
            else if (st.op === 'move') m.moveFocus(st.dr, st.dc, 5, 5, st.ext)
            else if (st.op === 'all') m.selectAll(5, 5)
            else m.clear()

            expect(m.isEmpty()).toBe(m.getBoundingBox() === null)
            const visited = new Set<string>()
            m.forEachSelectedCell(5, 5, (r, c) => {
              visited.add(`${r}:${c}`)
              expect(m.isSelected(r, c)).toBe(true)
            })
            for (let r = 0; r < 5; r++) {
              for (let c = 0; c < 5; c++) {
                expect(visited.has(`${r}:${c}`)).toBe(m.isSelected(r, c))
              }
            }
          }
        }
      ),
      { numRuns: 30 }
    )
  })

  it('covers src/editor/grid-menus.ts cell/canvas/header context menus & bulk-fill / filter popovers', async () => {
    const model: GridModel = {
      headers: ['id', 'name', 'note'],
      columnTypes: ['int', 'text', 'text'],
      rows: [
        [1, 'alice', 'tab\tline\n"q"\r'],
        [2, 'bob', null],
      ],
      primaryKey: ['id'],
      canEdit: true,
    }
    const closeMenu = vi.fn()
    let copyVal = 'copied'
    const copySelection = vi.fn(() => copyVal)
    const onNotify = vi.fn()
    const triggerPasteAction = vi.fn(async () => {})
    let inspectInfo: ReturnType<Parameters<typeof buildGridCellContextMenu>[0]['buildSelectedCellInfo']> = {
      rowIndex: 0,
      colIndex: 1,
      columnName: 'name',
      value: 'alice',
      isEditable: true,
      isInserted: false,
      isDeleted: false,
    }
    const onInspectCell = vi.fn()
    let bulkCount = 2
    const bulkSetCellsValue = vi.fn(() => bulkCount)
    const applyDirectNull = vi.fn()
    const openBulkFill = vi.fn()
    const triggerQuickFilter = vi.fn()
    const triggerFkJump = vi.fn()
    let cloneCount = 2
    const bulkCloneSelectedRows = vi.fn(() => cloneCount)
    const cloneSingleRow = vi.fn()
    const bulkMarkRowsDeleted = vi.fn()
    const markSingleRowDeleted = vi.fn()
    const td = dom.document.createElement('td') as unknown as HTMLTableCellElement

    // Single-cell editable nullable with FK
    const menu1 = buildGridCellContextMenu({
      clientX: 100,
      clientY: 120,
      rowIndex: 0,
      colIndex: 1,
      columnName: 'name',
      rawValue: 'alice',
      td,
      model,
      rowState: undefined,
      interactionLocked: false,
      batchMode: false,
      stagedCount: 0,
      dialect: 'postgres',
      summary: {
        rowCount: 1,
        colCount: 1,
        cellCount: 1,
        nonNullCount: 1,
        numericCount: 0,
        sum: null,
        avg: null,
        min: null,
        max: null,
        mode: 'cell',
        focus: { row: 0, col: 1 },
        isTruncatedScan: false,
      },
      fk: { column: 'name', referencedTable: 'profiles', referencedColumn: 'username' },
      hasFkHandler: true,
      isCellEditable: true,
      isColumnNullable: true,
      closeMenu,
      copySelection,
      onNotify,
      triggerPasteAction,
      buildSelectedCellInfo: () => inspectInfo,
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
    })
    for (const btn of menu1.querySelectorAll('button')) {
      dom.click(btn)
    }
    expect(copySelection).toHaveBeenCalledTimes(6)
    expect(triggerPasteAction).toHaveBeenCalledWith(false)
    expect(triggerPasteAction).toHaveBeenCalledWith(true)
    expect(onInspectCell).toHaveBeenCalled()
    expect(applyDirectNull).toHaveBeenCalledTimes(1)
    expect(openBulkFill).toHaveBeenCalledWith(100, 120, 1)
    expect(triggerQuickFilter).toHaveBeenCalledTimes(4)
    expect(triggerFkJump).toHaveBeenCalledTimes(1)
    expect(cloneSingleRow).toHaveBeenCalledTimes(1)
    expect(markSingleRowDeleted).toHaveBeenCalledTimes(1)
    menu1.remove()

    // Empty sql-in/sql-insert + non-nullable Set NULL direct-dispatch guard + deleted row restore label
    copyVal = ''
    inspectInfo = null
    const deletedState: InternalRowState = { kind: 'existing', deleted: true, original: {}, dirtyCols: new Map() }
    const menu2 = buildGridCellContextMenu({
      clientX: 100,
      clientY: 120,
      rowIndex: 0,
      colIndex: 1,
      columnName: 'id',
      rawValue: 1,
      td,
      model,
      rowState: deletedState,
      interactionLocked: false,
      batchMode: false,
      stagedCount: 0,
      dialect: 'sqlite',
      summary: {
        rowCount: 1,
        colCount: 1,
        cellCount: 1,
        nonNullCount: 1,
        numericCount: 1,
        sum: 1,
        avg: 1,
        min: 1,
        max: 1,
        mode: 'cell',
        focus: { row: 0, col: 0 },
        isTruncatedScan: false,
      },
      fk: null,
      hasFkHandler: false,
      isCellEditable: true,
      isColumnNullable: false,
      closeMenu,
      copySelection,
      onNotify,
      triggerPasteAction,
      buildSelectedCellInfo: () => null,
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
    })
    expect(menu2.textContent).toContain('Restore Row')
    const setNullBtn2 = Array.from(menu2.querySelectorAll('button')).find((b) => b.textContent === 'Set NULL')!
    expect(setNullBtn2.disabled).toBe(true)
    setNullBtn2.dispatchEvent(new MouseEvent('click', { bubbles: true })) // hits !isColumnNullable notify branch
    expect(onNotify).toHaveBeenCalledWith('Column "id" is NOT NULL — cannot set NULL.')
    menu2.remove()

    // Multi-cell / multi-row with NULL rawValue + inserted row + 0/non-zero bulk counts
    const insState: InternalRowState = { kind: 'inserted', deleted: false, original: {}, dirtyCols: new Map() }
    const menu3 = buildGridCellContextMenu({
      clientX: 50,
      clientY: 50,
      rowIndex: 1,
      colIndex: 2,
      columnName: 'note',
      rawValue: null,
      td,
      model: { ...model, primaryKey: [] },
      rowState: insState,
      interactionLocked: false,
      batchMode: true,
      stagedCount: 1,
      dialect: 'mysql',
      summary: {
        rowCount: 2,
        colCount: 2,
        cellCount: 4,
        nonNullCount: 0,
        numericCount: 0,
        sum: null,
        avg: null,
        min: null,
        max: null,
        mode: 'cell',
        focus: { row: 1, col: 2 },
        isTruncatedScan: false,
      },
      fk: null,
      hasFkHandler: false,
      isCellEditable: true,
      isColumnNullable: true,
      closeMenu,
      copySelection,
      onNotify,
      triggerPasteAction,
      buildSelectedCellInfo: () => inspectInfo,
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
    })
    for (const btn of menu3.querySelectorAll('button')) dom.click(btn)
    bulkCount = 0
    cloneCount = 0
    for (const btn of menu3.querySelectorAll('button')) dom.click(btn)
    expect(bulkSetCellsValue).toHaveBeenCalled()
    expect(bulkCloneSelectedRows).toHaveBeenCalled()
    expect(bulkMarkRowsDeleted).toHaveBeenCalled()
    menu3.remove()

    // buildGridCanvasContextMenu
    const onPasteNewRows = vi.fn(async () => {})
    const onAddBlankRow = vi.fn()
    const canvasEnabled = buildGridCanvasContextMenu({
      clientX: 10,
      clientY: 10,
      canInsert: true,
      closeMenu,
      onPasteNewRows,
      onAddBlankRow,
    })
    for (const btn of canvasEnabled.querySelectorAll('button')) dom.click(btn)
    expect(onPasteNewRows).toHaveBeenCalledTimes(1)
    expect(onAddBlankRow).toHaveBeenCalledTimes(1)
    canvasEnabled.remove()

    const canvasDisabled = buildGridCanvasContextMenu({
      clientX: 10,
      clientY: 10,
      canInsert: false,
      closeMenu,
      onPasteNewRows,
      onAddBlankRow,
    })
    expect(canvasDisabled.querySelectorAll('button').every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
    canvasDisabled.remove()

    // buildGridHeaderContextMenu (multi-row w/ special chars + empty rowIndices for empty SQL IN)
    const selectColumn = vi.fn()
    const onSort = vi.fn()
    const togglePin = vi.fn()
    const hideColumn = vi.fn()
    const autoFitColumn = vi.fn()
    const hdr1 = buildGridHeaderContextMenu({
      clientX: 20,
      clientY: 20,
      modelColIdx: 2,
      header: 'note',
      model,
      dialect: 'postgres',
      isPinned: false,
      visibleColsCount: 3,
      rowIndices: [0, 1],
      closeMenu,
      selectColumn,
      onNotify,
      onSort,
      togglePin,
      hideColumn,
      autoFitColumn,
    })
    for (const btn of hdr1.querySelectorAll('button')) dom.click(btn)
    expect(selectColumn).toHaveBeenCalled()
    expect(onSort).toHaveBeenCalledWith('ASC')
    expect(onSort).toHaveBeenCalledWith('DESC')
    expect(togglePin).toHaveBeenCalled()
    expect(hideColumn).toHaveBeenCalled()
    expect(autoFitColumn).toHaveBeenCalled()
    hdr1.remove()

    const hdr2 = buildGridHeaderContextMenu({
      clientX: 20,
      clientY: 20,
      modelColIdx: 0,
      header: 'id',
      model,
      dialect: 'postgres',
      isPinned: true,
      visibleColsCount: 1,
      rowIndices: [],
      closeMenu,
      selectColumn,
      onNotify,
      onSort,
      togglePin,
      hideColumn,
      autoFitColumn,
    })
    expect(hdr2.textContent).toContain('Unpin Column')
    for (const btn of hdr2.querySelectorAll('button')) dom.click(btn)
    hdr2.remove()

    // buildGridBulkFillPopover
    let fillReturn = 3
    const onApplyValue = vi.fn(() => fillReturn)
    const bulkPop = buildGridBulkFillPopover({
      clientX: 30,
      clientY: 30,
      cellCount: 1,
      closePopover: closeMenu,
      onApplyValue,
      onNotify,
    })
    const bulkInput = bulkPop.querySelector('input')!
    const [bNull, bCancel, bApply] = bulkPop.querySelectorAll('button')
    dom.click(bNull)
    dom.setInput(bulkInput, 'filled')
    dom.click(bApply)
    dom.fireKey(bulkInput, 'Enter')
    fillReturn = 0
    dom.click(bNull)
    dom.click(bApply)
    dom.fireKey(bulkInput, 'Escape')
    dom.click(bCancel)
    bulkPop.remove()

    const bulkPopPlural = buildGridBulkFillPopover({
      clientX: 30,
      clientY: 30,
      cellCount: 4,
      closePopover: closeMenu,
      onApplyValue: () => 4,
      onNotify,
    })
    expect(bulkPopPlural.textContent).toContain('Fill 4 Selected Cells')
    bulkPopPlural.remove()

    // buildGridColumnFilterPopover
    const anchorEl = dom.document.createElement('th')
    dom.body.appendChild(anchorEl)
    const onApplyFilter = vi.fn()
    const onClearFilter = vi.fn()
    const fPop1 = buildGridColumnFilterPopover({
      column: 'name',
      anchorEl,
      existingForCol: undefined,
      closePopover: closeMenu,
      onApply: onApplyFilter,
      onClear: onClearFilter,
    })
    const fInp = fPop1.querySelector('input')!
    const [fApplyBtn, fLocalBtn, fClearBtn] = fPop1.querySelectorAll('button')
    dom.click(fApplyBtn) // empty non-null op calls onClear
    expect(onClearFilter).toHaveBeenCalledTimes(1)
    dom.setInput(fInp, 'alice')
    dom.fireKey(fInp, 'Enter')
    dom.click(fLocalBtn)
    expect(onApplyFilter).toHaveBeenCalledWith('alice', 'contains', 'query')
    expect(onApplyFilter).toHaveBeenCalledWith('alice', 'contains', 'client')
    dom.fireKey(fInp, 'Escape')
    dom.click(fClearBtn)
    fPop1.remove()

    const fPop2 = buildGridColumnFilterPopover({
      column: 'note',
      anchorEl,
      existingForCol: { column: 'note', op: 'is-null', value: null },
      closePopover: closeMenu,
      onApply: onApplyFilter,
      onClear: onClearFilter,
    })
    const fSel = fPop2.querySelector('select') as HTMLSelectElement
    const fInp2 = fPop2.querySelector('input') as HTMLInputElement
    expect(fInp2.disabled).toBe(true)
    fSel.value = 'eq'
    fSel.dispatchEvent(new Event('change', { bubbles: true }))
    expect(fInp2.disabled).toBe(false)
    fPop2.remove()
  })
})
