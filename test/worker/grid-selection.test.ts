import { describe, expect, it } from 'vitest'
import {
  findGridMatches,
  GridSelectionModel,
  parseDelimitedClipboard,
  type CellCoord,
} from '../../src/editor/grid-selection'

describe('GridSelectionModel', () => {
  it('starts empty and supports selectCell, extendTo, and clear', () => {
    const model = new GridSelectionModel()
    expect(model.isEmpty()).toBe(true)
    expect(model.getBoundingBox()).toBeNull()
    expect(model.getState()).toEqual({
      anchor: null,
      focus: null,
      ranges: [],
      mode: 'cell',
    })

    model.selectCell(2, 3)
    expect(model.isEmpty()).toBe(false)
    expect(model.isSelected(2, 3)).toBe(true)
    expect(model.isSelected(2, 2)).toBe(false)
    expect(model.isRowSelected(2)).toBe(true)
    expect(model.isRowSelected(1)).toBe(false)
    expect(model.isColSelected(3)).toBe(true)
    expect(model.isColSelected(0)).toBe(false)

    // Extend upwards and leftwards -> normalized rectangle
    model.extendTo(0, 1)
    expect(model.getBoundingBox()).toEqual({
      startRow: 0,
      endRow: 2,
      startCol: 1,
      endCol: 3,
    })
    expect(model.getState().anchor).toEqual({ row: 2, col: 3 })
    expect(model.getState().focus).toEqual({ row: 0, col: 1 })
    expect(model.isSelected(1, 2)).toBe(true)
    expect(model.isSelected(0, 0)).toBe(false)

    model.clear()
    expect(model.isEmpty()).toBe(true)
    expect(model.getBoundingBox()).toBeNull()
  })

  it('splits containing rectangles into <=4 disjoint sub-rectangles on toggleCell deselection', () => {
    const model = new GridSelectionModel()
    model.selectCell(0, 0)
    model.extendTo(2, 2) // 3x3 block: 9 cells

    // Punch center hole (1, 1) -> 4 disjoint sub-rectangles, 8 selected cells
    model.toggleCell(1, 1)
    const state = model.getState()
    expect(state.ranges.length).toBeLessThanOrEqual(4)
    expect(model.isSelected(1, 1)).toBe(false)
    expect(model.isSelected(0, 0)).toBe(true)
    expect(model.isSelected(0, 1)).toBe(true)
    expect(model.isSelected(1, 0)).toBe(true)
    expect(model.isSelected(1, 2)).toBe(true)
    expect(model.isSelected(2, 2)).toBe(true)

    const visited: CellCoord[] = []
    model.forEachSelectedCell(5, 5, (row, col) => {
      visited.push({ row, col })
    })
    expect(visited).toHaveLength(8)
    expect(visited.some((c) => c.row === 1 && c.col === 1)).toBe(false)

    // Edges around the punched hole must show inner border edges
    expect(model.getCellSelectionEdges(0, 1)).toEqual({
      top: true,
      right: false,
      bottom: true,
      left: false,
    })
    expect(model.getCellSelectionEdges(1, 0)).toEqual({
      top: false,
      right: true,
      bottom: false,
      left: true,
    })
    expect(model.getCellSelectionEdges(1, 1)).toEqual({
      top: false,
      right: false,
      bottom: false,
      left: false,
    })

    // Toggle (1, 1) back on -> adds 1x1 cell back
    model.toggleCell(1, 1)
    expect(model.isSelected(1, 1)).toBe(true)

    // Toggling off the only remaining 1x1 cell clears selection
    model.selectCell(4, 4)
    model.toggleCell(4, 4)
    expect(model.isEmpty()).toBe(true)
  })

  it('supports selectRow, selectColumn (plain, shift, toggle), selectAll, and moveFocus', () => {
    const model = new GridSelectionModel()
    model.selectRow(1, 4)
    expect(model.getState().mode).toBe('row')
    expect(model.getSelectedRowIndices(5)).toEqual([1])
    expect(model.getSelectedColIndices(4)).toEqual([0, 1, 2, 3])

    // Shift+Row extends rows 1..3
    model.selectRow(3, 4, { shift: true })
    expect(model.getSelectedRowIndices(5)).toEqual([1, 2, 3])

    // Toggle row 2 off and row 4 on
    model.selectRow(2, 4, { toggle: true })
    model.selectRow(4, 4, { toggle: true })
    expect(model.getSelectedRowIndices(5)).toEqual([1, 3, 4])

    // Column selection
    model.selectColumn(2, 5)
    expect(model.getState().mode).toBe('col')
    expect(model.getSelectedColIndices(4)).toEqual([2])
    expect(model.getSelectedRowIndices(5)).toEqual([0, 1, 2, 3, 4])

    model.selectColumn(0, 5, { shift: true })
    expect(model.getSelectedColIndices(4)).toEqual([0, 1, 2])

    model.selectColumn(1, 5, { toggle: true })
    expect(model.getSelectedColIndices(4)).toEqual([0, 2])

    // Select All
    model.selectAll(3, 4)
    expect(model.getState().mode).toBe('all')
    expect(model.getBoundingBox()).toEqual({ startRow: 0, endRow: 2, startCol: 0, endCol: 3 })

    // moveFocus clamps to bounds and supports extend
    model.selectCell(0, 0)
    model.moveFocus(-1, -1, 3, 4, false)
    expect(model.getState().focus).toEqual({ row: 0, col: 0 })

    model.moveFocus(1, 2, 3, 4, true)
    expect(model.getState().focus).toEqual({ row: 1, col: 2 })
    expect(model.getBoundingBox()).toEqual({ startRow: 0, endRow: 1, startCol: 0, endCol: 2 })

    model.moveFocus(10, 10, 3, 4, false)
    expect(model.getState().focus).toEqual({ row: 2, col: 3 })
  })

  it('stops early in forEachSelectedCell when callback returns false', () => {
    const model = new GridSelectionModel()
    model.selectAll(4, 4)
    const seen: CellCoord[] = []
    model.forEachSelectedCell(4, 4, (row, col) => {
      seen.push({ row, col })
      if (seen.length === 5) return false
      return undefined
    })
    expect(seen).toHaveLength(5)
    expect(seen[0]).toEqual({ row: 0, col: 0 })
    expect(seen[4]).toEqual({ row: 1, col: 0 })
  })

  it('computes accurate SelectionSummary with strict numeric coercion and scanCap truncation', () => {
    const data: unknown[][] = [
      [10, '20.5', '  -5.5  ', '1e2'],
      [null, '', true, false],
      [undefined, 'abc', Number.NaN, Number.POSITIVE_INFINITY],
    ]
    const model = new GridSelectionModel()
    model.selectAll(3, 4)

    const summary = model.computeSelectionSummary(3, 4, (r, c) => data[r][c])
    expect(summary.rowCount).toBe(3)
    expect(summary.colCount).toBe(4)
    expect(summary.cellCount).toBe(12)
    expect(summary.nonNullCount).toBe(10) // excludes null and undefined
    // Numeric values: 10, 20.5, -5.5, 100 -> count 4, sum 125, avg 31.25, min -5.5, max 100
    expect(summary.numericCount).toBe(4)
    expect(summary.sum).toBeCloseTo(125, 10)
    expect(summary.avg).toBeCloseTo(31.25, 10)
    expect(summary.min).toBe(-5.5)
    expect(summary.max).toBe(100)
    expect(summary.isTruncatedScan).toBe(false)
    expect(summary.mode).toBe('all')

    // Truncated scan cap
    const capped = model.computeSelectionSummary(3, 4, (r, c) => data[r][c], 4)
    expect(capped.cellCount).toBe(12)
    expect(capped.isTruncatedScan).toBe(true)
    expect(capped.numericCount).toBe(4)
    expect(capped.sum).toBeCloseTo(125, 10)

    // Non-numeric-only selection yields null aggregates
    model.selectCell(1, 0)
    model.extendTo(1, 3)
    const nonNum = model.computeSelectionSummary(3, 4, (r, c) => data[r][c])
    expect(nonNum.numericCount).toBe(0)
    expect(nonNum.sum).toBeNull()
    expect(nonNum.avg).toBeNull()
    expect(nonNum.min).toBeNull()
    expect(nonNum.max).toBeNull()
  })
})

describe('parseDelimitedClipboard', () => {
  it('auto-detects TSV vs CSV, preserves quoted newlines & "" escapes, and strips trailing empty newline', () => {
    expect(parseDelimitedClipboard('')).toEqual([])
    expect(parseDelimitedClipboard('\n')).toEqual([])

    // TSV with embedded commas inside unquoted text
    expect(parseDelimitedClipboard('1,000\tAlice\n2,000\tBob\n')).toEqual([
      ['1,000', 'Alice'],
      ['2,000', 'Bob'],
    ])

    // RFC-4180 CSV with quoted commas, escaped quotes, and multiline fields
    const csv = 'id,name,bio\r\n1,"Smith, ""Al""","Line 1\nLine 2"\r\n2,Bob,Simple\r\n'
    expect(parseDelimitedClipboard(csv)).toEqual([
      ['id', 'name', 'bio'],
      ['1', 'Smith, "Al"', 'Line 1\nLine 2'],
      ['2', 'Bob', 'Simple'],
    ])

    // TSV with quoted tab & newline
    const tsv = 'a\t"b\tc"\n"x\ny"\t"z""w"\n'
    expect(parseDelimitedClipboard(tsv)).toEqual([
      ['a', 'b\tc'],
      ['x\ny', 'z"w'],
    ])
  })
})

describe('findGridMatches', () => {
  it('performs case-insensitive substring matching and respects maxMatches', () => {
    const grid = [
      ['Alice', 'Admin', 'alice@example.com'],
      ['Bob', 'User', 'bob@example.com'],
      ['ALICE_2', 'Guest', 'guest@example.com'],
    ]
    const getText = (r: number, c: number): string => grid[r][c]

    expect(findGridMatches('', 3, 3, getText)).toEqual([])
    expect(findGridMatches('alice', 3, 3, getText)).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 2 },
      { row: 2, col: 0 },
    ])
    expect(findGridMatches('example', 3, 3, getText, 2)).toEqual([
      { row: 0, col: 2 },
      { row: 1, col: 2 },
    ])
  })
})
