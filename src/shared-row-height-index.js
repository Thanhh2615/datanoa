// src/shared-row-height-index.js
// Pure Chunked Lazy Prefix-Sum RowHeightIndex and multi-line cell wrap helpers
// shared between Fullscreen Studio, Docked Side Panel, and Worker tests.

export const CHUNK_ROWS = 256
export const MIN_WRAP_MAX_LINES = 1
export const MAX_WRAP_MAX_LINES = 10
export const DEFAULT_WRAP_MAX_LINES = 4
export const DEFAULT_BASE_ROW_HEIGHT_PX = 22
export const DEFAULT_LINE_HEIGHT_PX = 16

const UNICODE_NEWLINE_RE = /\r\n|[\r\v\f\u0085\u2028\u2029]/g
const BLOB_SENTINEL_RE = /^\[BLOB\s+\d+\s*B\]$/i
const NUMERIC_COL_TYPE_RE =
  /\b(?:INT|INTEGER|BIGINT|SMALLINT|TINYINT|MEDIUMINT|INT2|INT4|INT8|UINT8|UINT16|UINT32|UINT64|FLOAT4|FLOAT8|REAL|FLOAT|DOUBLE|NUMERIC|DECIMAL|NUMBER|SERIAL|BIGSERIAL|SMALLSERIAL)\b/i
const BLOB_COL_TYPE_RE = /\b(?:BLOB|LONGBLOB|MEDIUMBLOB|TINYBLOB|BYTEA|BINARY|VARBINARY|IMAGE|RAW)\b/i
const NUMERIC_LITERAL_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

/**
 * Clamps wrap max-lines to [1, 10], returning the default (4) for non-finite inputs.
 */
export function clampWrapMaxLines(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_WRAP_MAX_LINES
  }
  const intVal = Math.trunc(value)
  if (intVal < MIN_WRAP_MAX_LINES) return MIN_WRAP_MAX_LINES
  if (intVal > MAX_WRAP_MAX_LINES) return MAX_WRAP_MAX_LINES
  return intVal
}

/**
 * Normalizes all 7 Unicode newline sequences (\r\n, \r, \v, \f, \u0085, \u2028, \u2029)
 * to '\n' and strips at most one trailing newline.
 */
export function normalizeWrapCellText(raw) {
  if (raw === null || raw === undefined) return ''
  const str = typeof raw === 'string' ? raw : String(raw)
  if (!str) return ''
  const normalized = str.replace(UNICODE_NEWLINE_RE, '\n')
  return normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
}

/**
 * Counts explicit lines in text after Unicode newline normalization, clamped to [1, maxLines].
 */
export function countNormalizedLines(raw, maxLines = DEFAULT_WRAP_MAX_LINES) {
  const cap = clampWrapMaxLines(maxLines)
  const normalized = normalizeWrapCellText(raw)
  if (!normalized) return 1
  let lines = 1
  for (let i = 0; i < normalized.length; i++) {
    if (normalized.charCodeAt(i) === 10) {
      lines++
      if (lines >= cap) return cap
    }
  }
  return lines
}

/**
 * Returns whether a cell value is eligible for multi-line wrapping.
 * Numbers, booleans, NULL/undefined, and BLOBs (including serialized [BLOB N B] sentinels) never wrap.
 */
export function isWrappableCellValue(value, colType) {
  if (value === null || value === undefined) return false
  const t = typeof value
  if (t === 'number' || t === 'bigint' || t === 'boolean') return false
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return false
  if (t === 'object') {
    if (
      'type' in value &&
      value.type === 'Buffer' &&
      'data' in value &&
      Array.isArray(value.data)
    ) {
      return false
    }
    if (typeof colType === 'string' && BLOB_COL_TYPE_RE.test(colType)) {
      return false
    }
    return true
  }
  if (t === 'string') {
    const trimmed = value.trim()
    if (BLOB_SENTINEL_RE.test(trimmed)) return false
    if (typeof colType === 'string' && colType) {
      if (BLOB_COL_TYPE_RE.test(colType)) return false
      if (NUMERIC_COL_TYPE_RE.test(colType) && NUMERIC_LITERAL_RE.test(trimmed)) return false
    }
    return true
  }
  return false
}

function sanitizePositivePx(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function sanitizeRowCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.trunc(value)
}

/**
 * Chunked Lazy Prefix-Sum index (256 rows/chunk) for virtualized variable-height grids.
 * Provides O(1) setRowLines/getTotalHeight and O(log(N/256)) findRowAtOffset with an
 * O(1) uniform-height fast-path when wrapping is disabled or no rows have been measured.
 */
export class RowHeightIndex {
  constructor(options = {}) {
    this._baseRowHeightPx = sanitizePositivePx(options.baseRowHeightPx, DEFAULT_BASE_ROW_HEIGHT_PX)
    this._lineHeightPx = sanitizePositivePx(options.lineHeightPx, DEFAULT_LINE_HEIGHT_PX)
    this._maxLines = clampWrapMaxLines(options.maxLines)
    this._wrapEnabled = options.wrapEnabled !== false
    this._rowCount = 0
    this._chunkCount = 0
    this._lines = new Uint8Array(0)
    this._extra = new Int32Array(0)
    this._before = new Float64Array(0)
    this._settled = 0
    this._measuredCount = 0
    this._totalExtraPx = 0
    this.reset(options.rowCount ?? 0)
  }

  get rowCount() {
    return this._rowCount
  }

  get chunkCount() {
    return this._chunkCount
  }

  get measuredCount() {
    return this._measuredCount
  }

  get maxLines() {
    return this._maxLines
  }

  get wrapEnabled() {
    return this._wrapEnabled
  }

  get baseRowHeightPx() {
    return this._baseRowHeightPx
  }

  get lineHeightPx() {
    return this._lineHeightPx
  }

  get settledWatermark() {
    return this._settled
  }

  /**
   * Re-initializes backing typed arrays for the specified row count.
   */
  reset(rowCount = this._rowCount) {
    const count = sanitizeRowCount(rowCount)
    const chunks = count > 0 ? Math.ceil(count / CHUNK_ROWS) : 0
    this._rowCount = count
    this._chunkCount = chunks
    this._lines = new Uint8Array(count)
    this._extra = new Int32Array(chunks)
    this._before = new Float64Array(chunks)
    this._settled = chunks > 0 ? 1 : 0
    this._measuredCount = 0
    this._totalExtraPx = 0
  }

  /**
   * Enables or disables variable row heights without discarding cached measurements.
   */
  setWrapEnabled(enabled) {
    const next = Boolean(enabled)
    if (next === this._wrapEnabled) return false
    this._wrapEnabled = next
    return true
  }

  /**
   * Updates the line clamp [1, 10] and recomputes chunk extra totals cleanly.
   */
  setMaxLines(maxLines) {
    const next = clampWrapMaxLines(maxLines)
    if (next === this._maxLines) return false
    this._maxLines = next
    if (this._measuredCount === 0) return true

    this._extra.fill(0)
    let totalExtra = 0
    for (let r = 0; r < this._rowCount; r++) {
      const raw = this._lines[r]
      if (raw <= 1) continue
      const eff = raw < next ? raw : next
      if (eff <= 1) continue
      const rowExtra = Math.round((eff - 1) * this._lineHeightPx)
      this._extra[r >>> 8] += rowExtra
      totalExtra += rowExtra
    }
    this._totalExtraPx = totalExtra
    this._settled = this._chunkCount > 0 ? 1 : 0
    return true
  }

  _rowExtraPx(rawLines) {
    if (rawLines <= 1) return 0
    const eff = rawLines < this._maxLines ? rawLines : this._maxLines
    return eff > 1 ? Math.round((eff - 1) * this._lineHeightPx) : 0
  }

  _settleTo(targetChunk) {
    if (targetChunk < this._settled || this._chunkCount === 0) return
    const limit = targetChunk < this._chunkCount ? targetChunk : this._chunkCount - 1
    const chunkBasePx = CHUNK_ROWS * this._baseRowHeightPx
    for (let c = this._settled; c <= limit; c++) {
      this._before[c] = this._before[c - 1] + chunkBasePx + this._extra[c - 1]
    }
    this._settled = limit + 1
  }

  /**
   * Returns effective line count for a row (1 when unmeasured or wrap is disabled).
   */
  getRowLines(row) {
    if (!Number.isInteger(row) || row < 0 || row >= this._rowCount) return 1
    if (!this._wrapEnabled || this._lines[row] <= 1) return 1
    return this._lines[row] < this._maxLines ? this._lines[row] : this._maxLines
  }

  /**
   * Records measured line count for a row in O(1) time and updates the lazy chunk watermark.
   */
  setRowLines(row, lines) {
    if (!Number.isInteger(row) || row < 0 || row >= this._rowCount) return false
    const raw =
      typeof lines === 'number' && Number.isFinite(lines)
        ? Math.max(MIN_WRAP_MAX_LINES, Math.min(MAX_WRAP_MAX_LINES, Math.trunc(lines)))
        : MIN_WRAP_MAX_LINES

    const prevRaw = this._lines[row]
    if (prevRaw === 0) {
      this._measuredCount++
    }
    if (prevRaw === raw) return prevRaw === 0

    const oldExtra = this._rowExtraPx(prevRaw)
    const newExtra = this._rowExtraPx(raw)
    this._lines[row] = raw

    const delta = newExtra - oldExtra
    if (delta !== 0) {
      const chunk = row >>> 8
      this._extra[chunk] += delta
      this._totalExtraPx += delta
      if (chunk + 1 < this._settled) {
        this._settled = chunk + 1
      }
      return true
    }
    return prevRaw === 0
  }

  /**
   * Returns height in px for a row in O(1) time.
   */
  getRowHeight(row) {
    if (!Number.isInteger(row) || row < 0 || row >= this._rowCount) {
      return this._baseRowHeightPx
    }
    if (!this._wrapEnabled || this._measuredCount === 0 || this._lines[row] <= 1) {
      return this._baseRowHeightPx
    }
    return this._baseRowHeightPx + this._rowExtraPx(this._lines[row])
  }

  /**
   * Returns total height in px across all rows in O(1) time.
   */
  getTotalHeight() {
    if (this._rowCount <= 0) return 0
    if (!this._wrapEnabled || this._measuredCount === 0 || this._totalExtraPx === 0) {
      return this._rowCount * this._baseRowHeightPx
    }
    return this._rowCount * this._baseRowHeightPx + this._totalExtraPx
  }

  /**
   * Returns top Y offset in px for a row index (0..rowCount) in O(CHUNK_ROWS) bounded time.
   */
  getRowOffset(row) {
    if (this._rowCount <= 0 || !Number.isFinite(row) || row <= 0) return 0
    const clamped = Math.trunc(row) >= this._rowCount ? this._rowCount : Math.trunc(row)
    if (!this._wrapEnabled || this._measuredCount === 0 || this._totalExtraPx === 0) {
      return clamped * this._baseRowHeightPx
    }
    if (clamped === this._rowCount) {
      return this.getTotalHeight()
    }
    const chunk = clamped >>> 8
    this._settleTo(chunk)
    let offset = this._before[chunk]
    const chunkStart = chunk << 8
    for (let r = chunkStart; r < clamped; r++) {
      offset += this.getRowHeight(r)
    }
    return offset
  }

  /**
   * Returns full geometry bounds { top, height, bottom, lines } for a row.
   */
  getRowBounds(row) {
    const top = this.getRowOffset(row)
    const height = this.getRowHeight(row)
    const lines = this.getRowLines(row)
    return { top, height, bottom: top + height, lines }
  }

  /**
   * Finds the row containing `yOffset` in O(1) fast-path or O(log(N/256)) binary search.
   * Returns -1 when rowCount is 0.
   */
  findRowAtOffset(yOffset) {
    if (this._rowCount <= 0) return -1
    if (typeof yOffset !== 'number' || !Number.isFinite(yOffset) || yOffset <= 0) {
      return 0
    }
    if (!this._wrapEnabled || this._measuredCount === 0 || this._totalExtraPx === 0) {
      const idx = Math.floor(yOffset / this._baseRowHeightPx)
      return idx >= this._rowCount ? this._rowCount - 1 : idx
    }
    const totalH = this.getTotalHeight()
    if (yOffset >= totalH) {
      return this._rowCount - 1
    }

    let lo = 0
    let hi = this._chunkCount - 1
    let chunk = 0
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      this._settleTo(mid)
      if (this._before[mid] <= yOffset) {
        chunk = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }

    let y = this._before[chunk]
    const chunkStart = chunk << 8
    const chunkEnd = Math.min(this._rowCount, chunkStart + CHUNK_ROWS)
    for (let r = chunkStart; r < chunkEnd; r++) {
      const h = this.getRowHeight(r)
      if (yOffset < y + h) return r
      y += h
    }
    return chunkEnd - 1
  }

  /**
   * Computes virtualized visible slice and spacer pixel heights for variable-height rows.
   */
  getVisibleRange(scrollTop, viewportHeight, overscanRows = 10) {
    if (this._rowCount <= 0) {
      return { start: 0, end: 0, topSpacerPx: 0, bottomSpacerPx: 0, totalHeightPx: 0 }
    }
    const safeTop = typeof scrollTop === 'number' && Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0
    const effH =
      typeof viewportHeight === 'number' && Number.isFinite(viewportHeight) && viewportHeight > 0
        ? viewportHeight
        : 420
    const overscan =
      typeof overscanRows === 'number' && Number.isFinite(overscanRows) && overscanRows >= 0
        ? Math.trunc(overscanRows)
        : 10

    const firstVisible = this.findRowAtOffset(safeTop)
    const lastVisible = this.findRowAtOffset(safeTop + effH)
    const start = Math.max(0, firstVisible - overscan)
    const end = Math.min(this._rowCount, lastVisible + 1 + overscan)
    const topSpacerPx = this.getRowOffset(start)
    const totalHeightPx = this.getTotalHeight()
    const endOffset = end < this._rowCount ? this.getRowOffset(end) : totalHeightPx
    const bottomSpacerPx = Math.max(0, totalHeightPx - endOffset)
    return { start, end, topSpacerPx, bottomSpacerPx, totalHeightPx }
  }

  /**
   * Applies a batch of measured row heights/line counts in a single pass and returns
   * the exact scrollTopDeltaPx needed to keep `anchorRowIndex` visually stationary.
   */
  measureBatch(reads, anchorRowIndex) {
    if (!Array.isArray(reads) || reads.length === 0) {
      return { scrollTopDeltaPx: 0, updatedCount: 0, changedCount: 0 }
    }
    const hasAnchor =
      typeof anchorRowIndex === 'number' &&
      Number.isFinite(anchorRowIndex) &&
      Math.trunc(anchorRowIndex) > 0
    const anchor = hasAnchor ? Math.trunc(anchorRowIndex) : -1

    let scrollTopDeltaPx = 0
    let updatedCount = 0
    let changedCount = 0

    for (let i = 0; i < reads.length; i++) {
      const item = reads[i]
      if (!item || !Number.isInteger(item.row) || item.row < 0 || item.row >= this._rowCount) {
        continue
      }
      let resolvedLines = item.lines
      if (
        (typeof resolvedLines !== 'number' || !Number.isFinite(resolvedLines)) &&
        typeof item.heightPx === 'number' &&
        Number.isFinite(item.heightPx)
      ) {
        const extraPx = Math.max(0, item.heightPx - this._baseRowHeightPx)
        resolvedLines = 1 + Math.ceil(extraPx / this._lineHeightPx)
      }
      if (typeof resolvedLines !== 'number' || !Number.isFinite(resolvedLines)) {
        continue
      }

      const prevH = this.getRowHeight(item.row)
      const changed = this.setRowLines(item.row, resolvedLines)
      const nextH = this.getRowHeight(item.row)
      updatedCount++
      if (changed) changedCount++
      if (hasAnchor && item.row < anchor) {
        scrollTopDeltaPx += nextH - prevH
      }
    }

    return { scrollTopDeltaPx, updatedCount, changedCount }
  }
}
