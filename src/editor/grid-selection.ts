export type SelectionMode = 'cell' | 'row' | 'col' | 'all'

export interface CellCoord {
  row: number
  col: number
}

export interface CellRange {
  startRow: number
  endRow: number
  startCol: number
  endCol: number
}

export interface GridSelectionState {
  anchor: CellCoord | null
  focus: CellCoord | null
  ranges: CellRange[]
  mode: SelectionMode
}

export interface SelectionEdges {
  top: boolean
  right: boolean
  bottom: boolean
  left: boolean
}

export interface SelectionSummary {
  rowCount: number
  colCount: number
  cellCount: number
  nonNullCount: number
  numericCount: number
  sum: number | null
  avg: number | null
  min: number | null
  max: number | null
  sumFormatted?: string | null
  avgFormatted?: string | null
  minFormatted?: string | null
  maxFormatted?: string | null
  mode: SelectionMode
  focus: CellCoord | null
  isTruncatedScan: boolean
}

export interface ExactDecimal {
  mantissa: bigint
  scale: number
}

export const EXACT_DECIMAL_MAX_EXPONENT = 400

interface ClosedInterval {
  start: number
  end: number
}

const EXACT_DECIMAL_REGEX = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/

function normalizeExactDecimal(mantissa: bigint, scale: number): ExactDecimal {
  if (mantissa === 0n) {
    return { mantissa: 0n, scale: 0 }
  }
  let m = mantissa
  let s = scale
  while (s > 0 && m % 10n === 0n) {
    m /= 10n
    s--
  }
  return { mantissa: m, scale: s }
}

/**
 * Pure-JS exact decimal parser (BigInt mantissa + scale)
 * with MaxExponent = 400 DoS guard. Rejects NaN, Infinity, and excessive exponents.
 */
export function parseExactDecimal(value: unknown): ExactDecimal | null {
  if (typeof value === 'bigint') {
    const absStr = value < 0n ? (-value).toString() : value.toString()
    if (absStr.length > EXACT_DECIMAL_MAX_EXPONENT + 1) {
      return null
    }
    return { mantissa: value, scale: 0 }
  }
  let raw: string
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    raw = value === 0 ? '0' : String(value)
  } else if (typeof value === 'string') {
    raw = value.trim()
    if (!raw) return null
  } else {
    return null
  }

  const m = EXACT_DECIMAL_REGEX.exec(raw)
  if (!m) return null
  const sign = m[1] === '-' ? -1n : 1n
  const intPart = m[2] ?? ''
  const fracPart = m[3] ?? m[4] ?? ''
  const expStr = m[5]

  let exp = 0
  if (expStr !== undefined) {
    const parsedExp = Number(expStr)
    if (!Number.isSafeInteger(parsedExp) || Math.abs(parsedExp) > EXACT_DECIMAL_MAX_EXPONENT) {
      return null
    }
    exp = parsedExp
  }

  const combined = `${intPart}${fracPart}`
  const trimmedLeading = combined.replace(/^0+/, '')
  if (!trimmedLeading) {
    return { mantissa: 0n, scale: 0 }
  }

  const rawScale = fracPart.length - exp
  if (rawScale < 0) {
    const zerosToAppend = -rawScale
    if (
      zerosToAppend > EXACT_DECIMAL_MAX_EXPONENT ||
      trimmedLeading.length + zerosToAppend > EXACT_DECIMAL_MAX_EXPONENT * 2
    ) {
      return null
    }
    const mantissa = sign * BigInt(trimmedLeading) * 10n ** BigInt(zerosToAppend)
    return { mantissa, scale: 0 }
  }

  if (rawScale > EXACT_DECIMAL_MAX_EXPONENT * 2) {
    return null
  }
  return normalizeExactDecimal(sign * BigInt(trimmedLeading), rawScale)
}

export function addExactDecimal(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  if (a.scale === b.scale) {
    return normalizeExactDecimal(a.mantissa + b.mantissa, a.scale)
  }
  if (a.scale > b.scale) {
    const diff = a.scale - b.scale
    return normalizeExactDecimal(a.mantissa + b.mantissa * 10n ** BigInt(diff), a.scale)
  }
  const diff = b.scale - a.scale
  return normalizeExactDecimal(a.mantissa * 10n ** BigInt(diff) + b.mantissa, b.scale)
}

export function compareExactDecimal(a: ExactDecimal, b: ExactDecimal): -1 | 0 | 1 {
  let ma = a.mantissa
  let mb = b.mantissa
  if (a.scale > b.scale) {
    mb *= 10n ** BigInt(a.scale - b.scale)
  } else if (b.scale > a.scale) {
    ma *= 10n ** BigInt(b.scale - a.scale)
  }
  if (ma < mb) return -1
  if (ma > mb) return 1
  return 0
}

export function formatExactDecimal(val: ExactDecimal): string {
  const norm = normalizeExactDecimal(val.mantissa, val.scale)
  if (norm.mantissa === 0n) return '0'
  const neg = norm.mantissa < 0n
  const digits = (neg ? -norm.mantissa : norm.mantissa).toString()
  if (norm.scale === 0) {
    return neg ? `-${digits}` : digits
  }
  if (digits.length <= norm.scale) {
    const padded = '0'.repeat(norm.scale - digits.length) + digits
    return `${neg ? '-' : ''}0.${padded}`
  }
  const splitIdx = digits.length - norm.scale
  return `${neg ? '-' : ''}${digits.slice(0, splitIdx)}.${digits.slice(splitIdx)}`
}

export function formatExactAverage(sum: ExactDecimal, count: number, maxExtraDecimals = 4): string {
  if (!Number.isSafeInteger(count) || count <= 0) return '0'
  if (sum.mantissa === 0n) return '0'
  const divisor = BigInt(count)
  const neg = sum.mantissa < 0n
  const absMantissa = neg ? -sum.mantissa : sum.mantissa

  // Compute exact rounded quotient to targetScale; extend precision if small non-zero would round to 0
  const baseScale = Math.max(sum.scale, maxExtraDecimals)
  const tryFormatAtScale = (targetScale: number): { text: string; isZero: boolean } => {
    const extraScale = targetScale - sum.scale
    const scaledNum = extraScale > 0 ? absMantissa * 10n ** BigInt(extraScale) : absMantissa
    const quotient = scaledNum / divisor
    const remainder = scaledNum % divisor
    const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient
    if (rounded === 0n) {
      return { text: '0', isZero: true }
    }
    return {
      text: formatExactDecimal({ mantissa: neg ? -rounded : rounded, scale: targetScale }),
      isZero: false,
    }
  }

  const first = tryFormatAtScale(baseScale)
  if (!first.isZero) return first.text
  // Non-zero average smaller than 10^(-baseScale): expand up to 12 decimals so we never render "0"
  for (const probeScale of [baseScale + 4, baseScale + 8, Math.min(EXACT_DECIMAL_MAX_EXPONENT, baseScale + 16)]) {
    const attempt = tryFormatAtScale(probeScale)
    if (!attempt.isZero) return attempt.text
  }
  const approx = Number(formatExactDecimal(sum)) / count
  return Number.isFinite(approx) && approx !== 0 ? approx.toPrecision(4) : first.text
}

function exactDecimalToFiniteNumber(val: ExactDecimal): number | null {
  const num = Number(formatExactDecimal(val))
  return Number.isFinite(num) ? num : null
}

function normalizeRange(r1: number, c1: number, r2: number, c2: number): CellRange {
  return {
    startRow: Math.min(r1, r2),
    endRow: Math.max(r1, r2),
    startCol: Math.min(c1, c2),
    endCol: Math.max(c1, c2),
  }
}

function subtractRange(source: CellRange, cut: CellRange): CellRange[] {
  const ixStartRow = Math.max(source.startRow, cut.startRow)
  const ixEndRow = Math.min(source.endRow, cut.endRow)
  const ixStartCol = Math.max(source.startCol, cut.startCol)
  const ixEndCol = Math.min(source.endCol, cut.endCol)

  if (ixStartRow > ixEndRow || ixStartCol > ixEndCol) {
    return [source]
  }

  const pieces: CellRange[] = []
  if (source.startRow < ixStartRow) {
    pieces.push({
      startRow: source.startRow,
      endRow: ixStartRow - 1,
      startCol: source.startCol,
      endCol: source.endCol,
    })
  }
  if (source.endRow > ixEndRow) {
    pieces.push({
      startRow: ixEndRow + 1,
      endRow: source.endRow,
      startCol: source.startCol,
      endCol: source.endCol,
    })
  }
  if (source.startCol < ixStartCol) {
    pieces.push({
      startRow: ixStartRow,
      endRow: ixEndRow,
      startCol: source.startCol,
      endCol: ixStartCol - 1,
    })
  }
  if (source.endCol > ixEndCol) {
    pieces.push({
      startRow: ixStartRow,
      endRow: ixEndRow,
      startCol: ixEndCol + 1,
      endCol: source.endCol,
    })
  }
  return pieces
}

function mergeClosedIntervals(intervals: ClosedInterval[]): ClosedInterval[] {
  if (intervals.length <= 1) return intervals
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: ClosedInterval[] = []
  let current = { start: sorted[0].start, end: sorted[0].end }
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]
    if (next.start <= current.end + 1) {
      if (next.end > current.end) {
        current.end = next.end
      }
    } else {
      merged.push(current)
      current = { start: next.start, end: next.end }
    }
  }
  merged.push(current)
  return merged
}

function intervalsCoverFullSpan(intervals: ClosedInterval[], start: number, end: number): boolean {
  if (start > end || intervals.length === 0) return false
  const merged = mergeClosedIntervals(intervals)
  return merged.some((iv) => iv.start <= start && iv.end >= end)
}

/**
 * Pure zero-DOM rectangular and multi-range selection model for data grids.
 */
export class GridSelectionModel {
  private anchor: CellCoord | null = null
  private focus: CellCoord | null = null
  private ranges: CellRange[] = []
  private mode: SelectionMode = 'cell'
  private revision = 0

  public getSelectionRevision(): number {
    return this.revision
  }

  public getFocus(): CellCoord | null {
    return this.focus ? { row: this.focus.row, col: this.focus.col } : null
  }

  public getState(): GridSelectionState {
    return {
      anchor: this.anchor ? { row: this.anchor.row, col: this.anchor.col } : null,
      focus: this.focus ? { row: this.focus.row, col: this.focus.col } : null,
      ranges: this.ranges.map((r) => ({
        startRow: r.startRow,
        endRow: r.endRow,
        startCol: r.startCol,
        endCol: r.endCol,
      })),
      mode: this.mode,
    }
  }

  public clear(): void {
    this.anchor = null
    this.focus = null
    this.ranges = []
    this.mode = 'cell'
    this.revision++
  }

  public isEmpty(): boolean {
    return this.ranges.length === 0
  }

  public selectCell(row: number, col: number, mode: SelectionMode = 'cell'): void {
    if (!Number.isFinite(row) || !Number.isFinite(col) || row < 0 || col < 0) return
    const r = Math.floor(row)
    const c = Math.floor(col)
    this.anchor = { row: r, col: c }
    this.focus = { row: r, col: c }
    this.ranges = [{ startRow: r, endRow: r, startCol: c, endCol: c }]
    this.mode = mode
    this.revision++
  }

  public extendTo(row: number, col: number, mode?: SelectionMode): void {
    if (!Number.isFinite(row) || !Number.isFinite(col)) return
    const r = Math.max(0, Math.floor(row))
    const c = Math.max(0, Math.floor(col))
    if (this.anchor === null) {
      this.selectCell(r, c, mode ?? 'cell')
      return
    }
    this.focus = { row: r, col: c }
    this.ranges = [normalizeRange(this.anchor.row, this.anchor.col, r, c)]
    if (mode !== undefined) {
      this.mode = mode
    }
    this.revision++
  }

  public toggleCell(row: number, col: number): void {
    if (!Number.isFinite(row) || !Number.isFinite(col) || row < 0 || col < 0) return
    const r = Math.floor(row)
    const c = Math.floor(col)
    const cellBox: CellRange = { startRow: r, endRow: r, startCol: c, endCol: c }

    if (this.isSelected(r, c)) {
      const nextRanges: CellRange[] = []
      for (const existing of this.ranges) {
        const split = subtractRange(existing, cellBox)
        for (const piece of split) {
          nextRanges.push(piece)
        }
      }
      this.ranges = nextRanges
      if (this.ranges.length === 0) {
        this.clear()
        return
      }
      this.focus = { row: r, col: c }
      this.mode = 'cell'
      this.revision++
      return
    }

    this.ranges.push(cellBox)
    this.anchor = { row: r, col: c }
    this.focus = { row: r, col: c }
    this.mode = 'cell'
    this.revision++
  }

  public selectRow(
    row: number,
    colCount: number,
    opts?: { shift?: boolean; toggle?: boolean }
  ): void {
    if (!Number.isFinite(row) || !Number.isFinite(colCount) || row < 0 || colCount <= 0) return
    const r = Math.floor(row)
    const lastCol = Math.floor(colCount) - 1

    if (opts?.shift && this.anchor !== null) {
      this.ranges = [normalizeRange(this.anchor.row, 0, r, lastCol)]
      this.focus = { row: r, col: 0 }
      this.mode = 'row'
      this.revision++
      return
    }

    const rowBox: CellRange = { startRow: r, endRow: r, startCol: 0, endCol: lastCol }
    if (opts?.toggle) {
      const colIntervals: ClosedInterval[] = []
      for (const rg of this.ranges) {
        if (r >= rg.startRow && r <= rg.endRow) {
          const s = Math.max(0, rg.startCol)
          const e = Math.min(lastCol, rg.endCol)
          if (s <= e) colIntervals.push({ start: s, end: e })
        }
      }
      const alreadyFullRow = intervalsCoverFullSpan(colIntervals, 0, lastCol)
      this.subtractBoxFromRanges(rowBox)
      if (alreadyFullRow) {
        if (this.ranges.length === 0) {
          this.clear()
          return
        }
        this.focus = { row: r, col: 0 }
        this.mode = 'row'
        this.revision++
        return
      }
      this.ranges.push(rowBox)
      this.anchor = { row: r, col: 0 }
      this.focus = { row: r, col: 0 }
      this.mode = 'row'
      this.revision++
      return
    }

    this.anchor = { row: r, col: 0 }
    this.focus = { row: r, col: 0 }
    this.ranges = [rowBox]
    this.mode = 'row'
    this.revision++
  }

  public selectColumn(
    col: number,
    rowCount: number,
    opts?: { shift?: boolean; toggle?: boolean }
  ): void {
    if (!Number.isFinite(col) || !Number.isFinite(rowCount) || col < 0 || rowCount <= 0) return
    const c = Math.floor(col)
    const lastRow = Math.floor(rowCount) - 1

    if (opts?.shift && this.anchor !== null) {
      this.ranges = [normalizeRange(0, this.anchor.col, lastRow, c)]
      this.focus = { row: 0, col: c }
      this.mode = 'col'
      this.revision++
      return
    }

    const colBox: CellRange = { startRow: 0, endRow: lastRow, startCol: c, endCol: c }
    if (opts?.toggle) {
      const rowIntervals: ClosedInterval[] = []
      for (const rg of this.ranges) {
        if (c >= rg.startCol && c <= rg.endCol) {
          const s = Math.max(0, rg.startRow)
          const e = Math.min(lastRow, rg.endRow)
          if (s <= e) rowIntervals.push({ start: s, end: e })
        }
      }
      const alreadyFullCol = intervalsCoverFullSpan(rowIntervals, 0, lastRow)
      this.subtractBoxFromRanges(colBox)
      if (alreadyFullCol) {
        if (this.ranges.length === 0) {
          this.clear()
          return
        }
        this.focus = { row: 0, col: c }
        this.mode = 'col'
        this.revision++
        return
      }
      this.ranges.push(colBox)
      this.anchor = { row: 0, col: c }
      this.focus = { row: 0, col: c }
      this.mode = 'col'
      this.revision++
      return
    }

    this.anchor = { row: 0, col: c }
    this.focus = { row: 0, col: c }
    this.ranges = [colBox]
    this.mode = 'col'
    this.revision++
  }

  public selectAll(rowCount: number, colCount: number): void {
    if (!Number.isFinite(rowCount) || !Number.isFinite(colCount) || rowCount <= 0 || colCount <= 0) {
      this.clear()
      return
    }
    const lastRow = Math.floor(rowCount) - 1
    const lastCol = Math.floor(colCount) - 1
    this.anchor = { row: 0, col: 0 }
    this.focus = { row: 0, col: 0 }
    this.ranges = [{ startRow: 0, endRow: lastRow, startCol: 0, endCol: lastCol }]
    this.mode = 'all'
    this.revision++
  }

  public moveFocus(
    dRow: number,
    dCol: number,
    rowCount: number,
    colCount: number,
    extend = false
  ): void {
    if (!Number.isFinite(rowCount) || !Number.isFinite(colCount) || rowCount <= 0 || colCount <= 0) {
      return
    }
    const maxRow = Math.floor(rowCount) - 1
    const maxCol = Math.floor(colCount) - 1
    if (this.focus === null) {
      this.selectCell(0, 0, 'cell')
      return
    }
    const nextRow = Math.max(0, Math.min(maxRow, this.focus.row + dRow))
    const nextCol = Math.max(0, Math.min(maxCol, this.focus.col + dCol))
    if (extend) {
      this.extendTo(nextRow, nextCol, 'cell')
    } else {
      this.selectCell(nextRow, nextCol, 'cell')
    }
  }

  public isSelected(row: number, col: number): boolean {
    if (row < 0 || col < 0) return false
    for (const rg of this.ranges) {
      if (row >= rg.startRow && row <= rg.endRow && col >= rg.startCol && col <= rg.endCol) {
        return true
      }
    }
    return false
  }

  public isRowSelected(row: number): boolean {
    if (row < 0) return false
    for (const rg of this.ranges) {
      if (row >= rg.startRow && row <= rg.endRow) {
        return true
      }
    }
    return false
  }

  public isColSelected(col: number): boolean {
    if (col < 0) return false
    for (const rg of this.ranges) {
      if (col >= rg.startCol && col <= rg.endCol) {
        return true
      }
    }
    return false
  }

  public getCellSelectionEdges(row: number, col: number): SelectionEdges {
    if (!this.isSelected(row, col)) {
      return { top: false, right: false, bottom: false, left: false }
    }
    return {
      top: !this.isSelected(row - 1, col),
      right: !this.isSelected(row, col + 1),
      bottom: !this.isSelected(row + 1, col),
      left: !this.isSelected(row, col - 1),
    }
  }

  public getSelectedRowIndices(rowCount: number): number[] {
    if (!Number.isFinite(rowCount) || rowCount <= 0 || this.ranges.length === 0) return []
    const maxRow = Math.floor(rowCount) - 1
    const intervals: ClosedInterval[] = []
    for (const rg of this.ranges) {
      const start = Math.max(0, rg.startRow)
      const end = Math.min(maxRow, rg.endRow)
      if (start <= end) {
        intervals.push({ start, end })
      }
    }
    return this.expandIntervals(mergeClosedIntervals(intervals))
  }

  public getSelectedColIndices(colCount: number): number[] {
    if (!Number.isFinite(colCount) || colCount <= 0 || this.ranges.length === 0) return []
    const maxCol = Math.floor(colCount) - 1
    const intervals: ClosedInterval[] = []
    for (const rg of this.ranges) {
      const start = Math.max(0, rg.startCol)
      const end = Math.min(maxCol, rg.endCol)
      if (start <= end) {
        intervals.push({ start, end })
      }
    }
    return this.expandIntervals(mergeClosedIntervals(intervals))
  }

  public getBoundingBox(): CellRange | null {
    if (this.ranges.length === 0) return null
    let startRow = this.ranges[0].startRow
    let endRow = this.ranges[0].endRow
    let startCol = this.ranges[0].startCol
    let endCol = this.ranges[0].endCol
    for (let i = 1; i < this.ranges.length; i++) {
      const rg = this.ranges[i]
      if (rg.startRow < startRow) startRow = rg.startRow
      if (rg.endRow > endRow) endRow = rg.endRow
      if (rg.startCol < startCol) startCol = rg.startCol
      if (rg.endCol > endCol) endCol = rg.endCol
    }
    return { startRow, endRow, startCol, endCol }
  }

  public forEachSelectedCell(
    rowCount: number,
    colCount: number,
    cb: (row: number, col: number) => boolean | void
  ): void {
    if (!Number.isFinite(rowCount) || !Number.isFinite(colCount) || rowCount <= 0 || colCount <= 0) {
      return
    }
    const maxRow = Math.floor(rowCount) - 1
    const maxCol = Math.floor(colCount) - 1
    if (this.ranges.length === 1) {
      const rg = this.ranges[0]
      const rStart = Math.max(0, rg.startRow)
      const rEnd = Math.min(maxRow, rg.endRow)
      const cStart = Math.max(0, rg.startCol)
      const cEnd = Math.min(maxCol, rg.endCol)
      for (let row = rStart; row <= rEnd; row++) {
        for (let col = cStart; col <= cEnd; col++) {
          if (cb(row, col) === false) {
            return
          }
        }
      }
      return
    }
    const rows = this.getSelectedRowIndices(rowCount)
    for (const row of rows) {
      const colIntervals = this.getMergedColIntervalsForRow(row, maxCol)
      for (const iv of colIntervals) {
        for (let col = iv.start; col <= iv.end; col++) {
          if (cb(row, col) === false) {
            return
          }
        }
      }
    }
  }

  public computeSelectionSummary(
    rowCount: number,
    colCount: number,
    getValue: (row: number, col: number) => unknown,
    scanCap = 50000
  ): SelectionSummary {
    const emptySummary: SelectionSummary = {
      rowCount: 0,
      colCount: 0,
      cellCount: 0,
      nonNullCount: 0,
      numericCount: 0,
      sum: null,
      avg: null,
      min: null,
      max: null,
      mode: this.mode,
      focus: this.focus ? { row: this.focus.row, col: this.focus.col } : null,
      isTruncatedScan: false,
    }

    if (
      this.ranges.length === 0 ||
      !Number.isFinite(rowCount) ||
      !Number.isFinite(colCount) ||
      rowCount <= 0 ||
      colCount <= 0
    ) {
      return emptySummary
    }

    const maxRow = Math.floor(rowCount) - 1
    const maxCol = Math.floor(colCount) - 1
    const effectiveCap =
      Number.isFinite(scanCap) && scanCap >= 0 ? Math.floor(scanCap) : 50000

    const clampedRanges = this.ranges
      .map((rg) => ({
        startRow: Math.max(0, rg.startRow),
        endRow: Math.min(maxRow, rg.endRow),
        startCol: Math.max(0, rg.startCol),
        endCol: Math.min(maxCol, rg.endCol),
      }))
      .filter((rg) => rg.startRow <= rg.endRow && rg.startCol <= rg.endCol)

    if (clampedRanges.length === 0) {
      return emptySummary
    }

    const rowIntervals = mergeClosedIntervals(
      clampedRanges.map((rg) => ({ start: rg.startRow, end: rg.endRow }))
    )
    const colIntervals = mergeClosedIntervals(
      clampedRanges.map((rg) => ({ start: rg.startCol, end: rg.endCol }))
    )
    const distinctRowCount = rowIntervals.reduce((acc, iv) => acc + (iv.end - iv.start + 1), 0)
    const distinctColCount = colIntervals.reduce((acc, iv) => acc + (iv.end - iv.start + 1), 0)

    let cellCount = 0
    let scannedCount = 0
    let nonNullCount = 0
    let numericCount = 0
    let sumExact: ExactDecimal | null = null
    let minExact: ExactDecimal | null = null
    let maxExact: ExactDecimal | null = null
    let isTruncatedScan = false

    const accumulateValue = (value: unknown): void => {
      if (value === null || value === undefined) return
      nonNullCount++
      const dec = parseExactDecimal(value)
      if (dec === null) return
      numericCount++
      sumExact = sumExact === null ? dec : addExactDecimal(sumExact, dec)
      if (minExact === null || compareExactDecimal(dec, minExact) < 0) {
        minExact = dec
      }
      if (maxExact === null || compareExactDecimal(dec, maxExact) > 0) {
        maxExact = dec
      }
    }

    if (clampedRanges.length === 1) {
      const rg = clampedRanges[0]
      cellCount = distinctRowCount * distinctColCount
      outerSingle: for (let r = rg.startRow; r <= rg.endRow; r++) {
        for (let c = rg.startCol; c <= rg.endCol; c++) {
          if (scannedCount >= effectiveCap) {
            isTruncatedScan = true
            break outerSingle
          }
          scannedCount++
          accumulateValue(getValue(r, c))
        }
      }
    } else {
      for (const rowIv of rowIntervals) {
        for (let r = rowIv.start; r <= rowIv.end; r++) {
          const rowCols: ClosedInterval[] = []
          for (const rg of clampedRanges) {
            if (r >= rg.startRow && r <= rg.endRow) {
              rowCols.push({ start: rg.startCol, end: rg.endCol })
            }
          }
          const mergedCols = mergeClosedIntervals(rowCols)
          for (const colIv of mergedCols) {
            cellCount += colIv.end - colIv.start + 1
            for (let c = colIv.start; c <= colIv.end; c++) {
              if (scannedCount >= effectiveCap) {
                isTruncatedScan = true
                break
              }
              scannedCount++
              accumulateValue(getValue(r, c))
            }
          }
        }
      }
    }

    const sumFormatted = numericCount > 0 && sumExact ? formatExactDecimal(sumExact) : null
    const avgFormatted = numericCount > 0 && sumExact ? formatExactAverage(sumExact, numericCount) : null
    const minFormatted = numericCount > 0 && minExact ? formatExactDecimal(minExact) : null
    const maxFormatted = numericCount > 0 && maxExact ? formatExactDecimal(maxExact) : null
    const avgNumeric = avgFormatted !== null ? Number(avgFormatted) : null

    return {
      rowCount: distinctRowCount,
      colCount: distinctColCount,
      cellCount,
      nonNullCount,
      numericCount,
      sum: sumExact ? exactDecimalToFiniteNumber(sumExact) : null,
      avg: avgNumeric !== null && Number.isFinite(avgNumeric) ? avgNumeric : null,
      min: minExact ? exactDecimalToFiniteNumber(minExact) : null,
      max: maxExact ? exactDecimalToFiniteNumber(maxExact) : null,
      sumFormatted,
      avgFormatted,
      minFormatted,
      maxFormatted,
      mode: this.mode,
      focus: this.focus ? { row: this.focus.row, col: this.focus.col } : null,
      isTruncatedScan,
    }
  }

  private subtractBoxFromRanges(box: CellRange): void {
    const nextRanges: CellRange[] = []
    for (const existing of this.ranges) {
      const split = subtractRange(existing, box)
      for (const piece of split) {
        nextRanges.push(piece)
      }
    }
    this.ranges = nextRanges
  }

  private getMergedColIntervalsForRow(row: number, maxCol: number): ClosedInterval[] {
    const colIntervals: ClosedInterval[] = []
    for (const rg of this.ranges) {
      if (row >= rg.startRow && row <= rg.endRow) {
        const start = Math.max(0, rg.startCol)
        const end = Math.min(maxCol, rg.endCol)
        if (start <= end) {
          colIntervals.push({ start, end })
        }
      }
    }
    return mergeClosedIntervals(colIntervals)
  }

  private expandIntervals(intervals: ClosedInterval[]): number[] {
    const out: number[] = []
    for (const iv of intervals) {
      for (let i = iv.start; i <= iv.end; i++) {
        out.push(i)
      }
    }
    return out
  }
}

export { parseDelimitedClipboard } from '../shared-grid-paste.js'

/**
 * Finds all cell coordinates matching `query` via case-insensitive substring match.
 */
export function findGridMatches(
  query: string,
  rowCount: number,
  colCount: number,
  getText: (row: number, col: number) => string,
  maxMatches = 10000
): CellCoord[] {
  if (
    !query ||
    !Number.isFinite(rowCount) ||
    !Number.isFinite(colCount) ||
    rowCount <= 0 ||
    colCount <= 0
  ) {
    return []
  }
  const effectiveMax = Number.isFinite(maxMatches) && maxMatches > 0 ? Math.floor(maxMatches) : 0
  if (effectiveMax === 0) return []

  const needle = query.toLowerCase()
  const rows = Math.floor(rowCount)
  const cols = Math.floor(colCount)
  const matches: CellCoord[] = []

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cellText = getText(row, col)
      if (typeof cellText === 'string' && cellText.toLowerCase().includes(needle)) {
        matches.push({ row, col })
        if (matches.length >= effectiveMax) {
          return matches
        }
      }
    }
  }

  return matches
}
