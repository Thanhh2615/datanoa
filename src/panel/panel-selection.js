// src/panel/panel-selection.js
// Spreadsheet-style rectangular cell/row/column selection controller for Datanoa Side Panel grids.

import {
  addExactDecimal,
  compareExactDecimal,
  formatAggNum,
  formatExactAverage,
  formatExactDecimal,
  normalizeCellRange,
  parseExactDecimal,
  subtractCellFromRange,
  subtractRowFromRange,
  subtractColFromRange,
} from './panel-core.js'

export class PanelGridSelection {
  constructor(opts) {
    this.wrapEl = opts.wrapEl
    this.tableEl = opts.tableEl
    this.editable = Boolean(opts.editable)
    this.getDimensions = opts.getDimensions
    this.getValueAt = opts.getValueAt
    this.getSnapshot = opts.getSnapshot || null
    this.isTransposed = typeof opts.isTransposed === 'function' ? opts.isTransposed : () => false
    this.onSelectionChange = opts.onSelectionChange || (() => {})
    this.onCopy = opts.onCopy || (() => {})
    this.onPaste = opts.onPaste || (() => {})
    this.onPasteNewRows = opts.onPasteNewRows || (() => {})
    this.onBulkDeleteRows = opts.onBulkDeleteRows || (() => {})
    this.onBulkSetNull = opts.onBulkSetNull || (() => {})
    this.onStartEdit = opts.onStartEdit || (() => {})
    this.onContextMenu = opts.onContextMenu || (() => {})
    this.onCtrlClickCell = opts.onCtrlClickCell || null
    this.onEnsureCellVisible = opts.onEnsureCellVisible || null
    this.ranges = []
    this.anchor = null
    this.focus = null
    this.mode = 'cell'
    this.dragMode = null
    this.dragShiftBase = null
    this.dragRafId = null
    this.pendingDragCoord = null
    this.highlightedTrs = new Set()
    this.highlightedTds = new Set()
    this._boundCleanups = []
    this.bindEvents()
  }

  clear(silent = false) {
    this.ranges = []
    this.anchor = null
    this.focus = null
    this.mode = 'cell'
    this.applyDomClasses()
    if (!silent) this.onSelectionChange(this)
  }

  hasSelection() {
    return this.ranges.length > 0
  }

  hasRowSelected(r) {
    for (let i = 0; i < this.ranges.length; i++) {
      const rg = this.ranges[i]
      if (r >= rg.r1 && r <= rg.r2) return true
    }
    return false
  }

  hasColSelected(c) {
    for (let i = 0; i < this.ranges.length; i++) {
      const rg = this.ranges[i]
      if (c >= rg.c1 && c <= rg.c2) return true
    }
    return false
  }

  contains(r, c) {
    for (let i = 0; i < this.ranges.length; i++) {
      const rg = this.ranges[i]
      if (r >= rg.r1 && r <= rg.r2 && c >= rg.c1 && c <= rg.c2) return true
    }
    return false
  }

  selectAll() {
    const { rows, cols } = this.getDimensions()
    if (rows <= 0 || cols <= 0) return
    this.ranges = [{ r1: 0, c1: 0, r2: rows - 1, c2: cols - 1 }]
    this.anchor = { r: 0, c: 0 }
    this.focus = { r: 0, c: 0 }
    this.mode = 'all'
    this.applyDomClasses()
    this.onSelectionChange(this)
  }

  selectRowRange(r1, r2, silent = false) {
    const { rows, cols } = this.getDimensions()
    if (rows <= 0 || cols <= 0) return
    const start = Math.max(0, Math.min(r1, r2))
    const end = Math.min(rows - 1, Math.max(r1, r2))
    if (start > end) return
    this.ranges = [{ r1: start, c1: 0, r2: end, c2: cols - 1 }]
    this.anchor = { r: start, c: 0 }
    this.focus = { r: start, c: 0 }
    this.mode = 'row'
    this.applyDomClasses()
    if (!silent) this.onSelectionChange(this)
  }

  selectCell(r, c, opts = {}) {
    const { rows, cols } = this.getDimensions()
    if (r < 0 || r >= rows || c < 0 || c >= cols) return
    if (opts.shift && this.anchor) {
      const nextRange = normalizeCellRange(this.anchor.r, this.anchor.c, r, c)
      if (opts.ctrl && this.ranges.length > 0) {
        this.ranges = [...this.ranges.slice(0, -1), nextRange]
      } else {
        this.ranges = [nextRange]
      }
      this.focus = { r, c }
      this.mode = 'cell'
    } else if (opts.ctrl) {
      if (this.contains(r, c)) {
        const nextRanges = []
        for (const rg of this.ranges) {
          nextRanges.push(...subtractCellFromRange(rg, r, c))
        }
        this.ranges = nextRanges
        if (this.ranges.length === 0) {
          this.anchor = null
          this.focus = null
          this.mode = 'cell'
          this.applyDomClasses()
          this.onSelectionChange(this)
          return
        }
      } else {
        this.ranges = [...this.ranges, { r1: r, c1: c, r2: r, c2: c }]
      }
      this.anchor = { r, c }
      this.focus = { r, c }
      this.mode = 'cell'
    } else {
      this.ranges = [{ r1: r, c1: c, r2: r, c2: c }]
      this.anchor = { r, c }
      this.focus = { r, c }
      this.mode = 'cell'
    }
    this.applyDomClasses()
    this.onSelectionChange(this)
  }

  selectRow(r, opts = {}) {
    const { rows, cols } = this.getDimensions()
    if (r < 0 || r >= rows || cols <= 0) return
    if (opts.shift && this.anchor) {
      this.ranges = [normalizeCellRange(this.anchor.r, 0, r, cols - 1)]
      this.focus = { r, c: 0 }
    } else if (opts.ctrl) {
      let fullRowSelected = true
      for (let ci = 0; ci < cols; ci++) {
        if (!this.contains(r, ci)) {
          fullRowSelected = false
          break
        }
      }
      if (fullRowSelected) {
        const nextRanges = []
        for (const rg of this.ranges) nextRanges.push(...subtractRowFromRange(rg, r))
        this.ranges = nextRanges
        if (this.ranges.length === 0) {
          this.anchor = null
          this.focus = null
          this.mode = 'cell'
          this.applyDomClasses()
          this.onSelectionChange(this)
          return
        }
      } else {
        this.ranges = [...this.ranges, { r1: r, c1: 0, r2: r, c2: cols - 1 }]
      }
      this.anchor = { r, c: 0 }
      this.focus = { r, c: 0 }
    } else {
      this.ranges = [{ r1: r, c1: 0, r2: r, c2: cols - 1 }]
      this.anchor = { r, c: 0 }
      this.focus = { r, c: 0 }
    }
    this.mode = 'row'
    this.applyDomClasses()
    this.onSelectionChange(this)
  }

  selectCol(c, opts = {}) {
    const { rows, cols } = this.getDimensions()
    if (c < 0 || c >= cols || rows <= 0) return
    if (opts.shift && this.anchor) {
      this.ranges = [normalizeCellRange(0, this.anchor.c, rows - 1, c)]
      this.focus = { r: 0, c }
    } else if (opts.ctrl) {
      let fullColSelected = true
      for (let ri = 0; ri < rows; ri++) {
        if (!this.contains(ri, c)) {
          fullColSelected = false
          break
        }
      }
      if (fullColSelected) {
        const nextRanges = []
        for (const rg of this.ranges) nextRanges.push(...subtractColFromRange(rg, c))
        this.ranges = nextRanges
        if (this.ranges.length === 0) {
          this.anchor = null
          this.focus = null
          this.mode = 'cell'
          this.applyDomClasses()
          this.onSelectionChange(this)
          return
        }
      } else {
        this.ranges = [...this.ranges, { r1: 0, c1: c, r2: rows - 1, c2: c }]
      }
      this.anchor = { r: 0, c }
      this.focus = { r: 0, c }
    } else {
      this.ranges = [{ r1: 0, c1: c, r2: rows - 1, c2: c }]
      this.anchor = { r: 0, c }
      this.focus = { r: 0, c }
    }
    this.mode = 'col'
    this.applyDomClasses()
    this.onSelectionChange(this)
  }

  getSelectedRowIndices() {
    const { rows } = this.getDimensions()
    if (rows <= 0 || this.ranges.length === 0) return []
    if (this.ranges.length === 1) {
      const rg = this.ranges[0]
      const start = Math.max(0, rg.r1)
      const end = Math.min(rows - 1, rg.r2)
      if (start > end) return []
      const out = new Array(end - start + 1)
      for (let i = 0; i < out.length; i++) out[i] = start + i
      return out
    }
    const set = new Set()
    for (const rg of this.ranges) {
      for (let r = Math.max(0, rg.r1); r <= Math.min(rows - 1, rg.r2); r++) set.add(r)
    }
    return Array.from(set).sort((a, b) => a - b)
  }

  getSelectedColIndices() {
    const set = new Set()
    const { cols } = this.getDimensions()
    for (const rg of this.ranges) {
      for (let c = Math.max(0, rg.c1); c <= Math.min(cols - 1, rg.c2); c++) set.add(c)
    }
    return Array.from(set).sort((a, b) => a - b)
  }

  getSelectedCoords(limit = 50000) {
    const coords = []
    const { rows, cols } = this.getDimensions()
    const singleRange = this.ranges.length === 1
    const seen = singleRange ? null : new Set()
    const stride = Math.max(1, cols + 1)
    for (const rg of this.ranges) {
      const rStart = Math.max(0, rg.r1)
      const rEnd = Math.min(rows - 1, rg.r2)
      const cStart = Math.max(0, rg.c1)
      const cEnd = Math.min(cols - 1, rg.c2)
      for (let r = rStart; r <= rEnd; r++) {
        for (let c = cStart; c <= cEnd; c++) {
          if (seen) {
            const key = r * stride + c
            if (seen.has(key)) continue
            seen.add(key)
          }
          coords.push({ r, c })
          if (coords.length >= limit) return coords
        }
      }
    }
    return coords
  }

  computeSummary() {
    if (this.ranges.length === 0) return null
    const snap = this.getSnapshot
      ? this.getSnapshot()
      : { ...this.getDimensions(), getValue: (r, c) => this.getValueAt(r, c) }
    const rows = snap.rows
    const cols = snap.cols
    if (rows <= 0 || cols <= 0) return null

    const singleRange = this.ranges.length === 1
    let rowCount = 0
    let colCount = 0
    if (singleRange) {
      const rg = this.ranges[0]
      rowCount = Math.max(0, Math.min(rows - 1, rg.r2) - Math.max(0, rg.r1) + 1)
      colCount = Math.max(0, Math.min(cols - 1, rg.c2) - Math.max(0, rg.c1) + 1)
    } else {
      rowCount = this.getSelectedRowIndices().length
      colCount = this.getSelectedColIndices().length
    }

    const MAX_CELLS = 50000
    let cellCount = 0
    let nonNullCount = 0
    let numericCount = 0
    let sumExact = null
    let minExact = null
    let maxExact = null
    let truncated = false
    const seen = singleRange ? null : new Set()
    const stride = Math.max(1, cols + 1)

    outer: for (let ri = 0; ri < this.ranges.length; ri++) {
      const rg = this.ranges[ri]
      const rStart = Math.max(0, rg.r1)
      const rEnd = Math.min(rows - 1, rg.r2)
      const cStart = Math.max(0, rg.c1)
      const cEnd = Math.min(cols - 1, rg.c2)
      for (let r = rStart; r <= rEnd; r++) {
        for (let c = cStart; c <= cEnd; c++) {
          if (seen) {
            const key = r * stride + c
            if (seen.has(key)) continue
            seen.add(key)
          }
          if (cellCount >= MAX_CELLS) {
            truncated = true
            break outer
          }
          cellCount++
          const v = snap.getValue(r, c)
          if (v !== null && v !== undefined) {
            nonNullCount++
            const dec = parseExactDecimal(v)
            if (dec !== null) {
              numericCount++
              sumExact = sumExact === null ? dec : addExactDecimal(sumExact, dec)
              if (minExact === null || compareExactDecimal(dec, minExact) < 0) minExact = dec
              if (maxExact === null || compareExactDecimal(dec, maxExact) > 0) maxExact = dec
            }
          }
        }
      }
    }
    const sumFormatted = numericCount > 0 && sumExact ? formatExactDecimal(sumExact) : null
    const avgFormatted = numericCount > 0 && sumExact ? formatExactAverage(sumExact, numericCount) : null
    const minFormatted = numericCount > 0 && minExact ? formatExactDecimal(minExact) : null
    const maxFormatted = numericCount > 0 && maxExact ? formatExactDecimal(maxExact) : null
    const toNum = (str) => {
      if (str === null) return 0
      const n = Number(str)
      return Number.isFinite(n) ? n : null
    }
    return {
      rowCount,
      colCount,
      cellCount,
      nonNullCount,
      numericCount,
      sum: toNum(sumFormatted),
      avg: toNum(avgFormatted),
      min: toNum(minFormatted),
      max: toNum(maxFormatted),
      sumFormatted,
      avgFormatted,
      minFormatted,
      maxFormatted,
      truncated,
    }
  }

  formatStatsText() {
    const s = this.computeSummary()
    if (!s || s.cellCount === 0) return ''
    const parts = [
      `Selected: ${s.rowCount} row${s.rowCount === 1 ? '' : 's'} × ${s.colCount} col${s.colCount === 1 ? '' : 's'} (${s.cellCount}${s.truncated ? '+' : ''} cell${s.cellCount === 1 ? '' : 's'})`,
      `Non-null: ${s.nonNullCount}`,
    ]
    if (s.numericCount > 0) {
      parts.push(`Sum: ${s.sumFormatted ?? formatAggNum(s.sum)}`)
      parts.push(`Avg: ${s.avgFormatted ?? formatAggNum(s.avg)}`)
      parts.push(`Min: ${s.minFormatted ?? formatAggNum(s.min)}`)
      parts.push(`Max: ${s.maxFormatted ?? formatAggNum(s.max)}`)
    }
    return parts.join(' · ')
  }

  detachCell(td) {
    if (!td) return
    this.highlightedTds.delete(td)
  }

  detachRow(tr) {
    if (!tr) return
    const wasTrackedTr = this.highlightedTrs.delete(tr)
    if (wasTrackedTr || (this.isTransposed() && this.highlightedTds.size > 0)) {
      const cells = tr.children
      for (let i = 0; i < cells.length; i++) {
        this.highlightedTds.delete(cells[i])
      }
    }
  }

  applyClassesToRow(tr, r) {
    if (!tr || !Number.isFinite(r) || this.ranges.length === 0) return
    const transposed = Boolean(this.isTransposed())
    if (transposed) {
      if (!this.hasColSelected(r)) return
      const cells = tr.children
      for (let i = 0; i < cells.length; i++) {
        const td = cells[i]
        if (!(td instanceof HTMLElement) || td.dataset.rowIdx === undefined || td.dataset.colIdx === undefined) continue
        const rowI = Number(td.dataset.rowIdx)
        const colI = Number(td.dataset.colIdx)
        const inRange = this.contains(rowI, colI)
        const isFocus = Boolean(this.focus && this.focus.r === rowI && this.focus.c === colI)
        if (!inRange && !isFocus) continue
        td.classList.toggle('cell-in-range', inRange)
        td.classList.toggle('range-top', inRange && !this.contains(rowI, colI - 1))
        td.classList.toggle('range-right', inRange && !this.contains(rowI + 1, colI))
        td.classList.toggle('range-bottom', inRange && !this.contains(rowI, colI + 1))
        td.classList.toggle('range-left', inRange && !this.contains(rowI - 1, colI))
        td.classList.toggle('cell-selected', isFocus)
        this.highlightedTds.add(td)
      }
      return
    }
    if (!this.hasRowSelected(r)) return
    tr.classList.add('row-selected')
    this.highlightedTrs.add(tr)
    const cells = tr.children
    for (let i = 0; i < cells.length; i++) {
      const td = cells[i]
      if (!(td instanceof HTMLElement) || td.dataset.colIdx === undefined) continue
      const c = Number(td.dataset.colIdx)
      const inRange = this.contains(r, c)
      const isFocus = Boolean(this.focus && this.focus.r === r && this.focus.c === c)
      if (!inRange && !isFocus) continue
      td.classList.toggle('cell-in-range', inRange)
      td.classList.toggle('range-top', inRange && !this.contains(r - 1, c))
      td.classList.toggle('range-right', inRange && !this.contains(r, c + 1))
      td.classList.toggle('range-bottom', inRange && !this.contains(r + 1, c))
      td.classList.toggle('range-left', inRange && !this.contains(r, c - 1))
      td.classList.toggle('cell-selected', isFocus)
      this.highlightedTds.add(td)
    }
  }

  applyDomClasses() {
    const tbl = this.tableEl
    if (!tbl) return
    if (this.ranges.length === 0) {
      for (const tr of this.highlightedTrs) {
        tr.classList.remove('row-selected')
      }
      for (const td of this.highlightedTds) {
        td.classList.remove('cell-in-range', 'range-top', 'range-right', 'range-bottom', 'range-left', 'cell-selected')
      }
      this.highlightedTrs.clear()
      this.highlightedTds.clear()
      return
    }

    const tbody = tbl.tBodies?.[0] || tbl.querySelector('tbody')
    if (!tbody) return
    const transposed = Boolean(this.isTransposed())
    const nextTrs = new Set()
    const nextTds = new Set()
    const rows = tbody.children
    for (let i = 0; i < rows.length; i++) {
      const tr = rows[i]
      if (!(tr instanceof HTMLElement) || tr.dataset.rowIdx === undefined) continue
      const trIdx = Number(tr.dataset.rowIdx)
      if (transposed) {
        if (!this.hasColSelected(trIdx)) continue
        const cells = tr.children
        for (let j = 0; j < cells.length; j++) {
          const td = cells[j]
          if (!(td instanceof HTMLElement) || td.dataset.rowIdx === undefined || td.dataset.colIdx === undefined) continue
          const r = Number(td.dataset.rowIdx)
          const c = Number(td.dataset.colIdx)
          const inRange = this.contains(r, c)
          const isFocus = Boolean(this.focus && this.focus.r === r && this.focus.c === c)
          if (!inRange && !isFocus) continue
          nextTds.add(td)
          td.classList.toggle('cell-in-range', inRange)
          td.classList.toggle('range-top', inRange && !this.contains(r, c - 1))
          td.classList.toggle('range-right', inRange && !this.contains(r + 1, c))
          td.classList.toggle('range-bottom', inRange && !this.contains(r, c + 1))
          td.classList.toggle('range-left', inRange && !this.contains(r - 1, c))
          td.classList.toggle('cell-selected', isFocus)
        }
        continue
      }
      if (!this.hasRowSelected(trIdx)) continue
      nextTrs.add(tr)
      if (!this.highlightedTrs.has(tr)) tr.classList.add('row-selected')
      const cells = tr.children
      for (let j = 0; j < cells.length; j++) {
        const td = cells[j]
        if (!(td instanceof HTMLElement) || td.dataset.colIdx === undefined) continue
        const c = Number(td.dataset.colIdx)
        const inRange = this.contains(trIdx, c)
        const isFocus = Boolean(this.focus && this.focus.r === trIdx && this.focus.c === c)
        if (!inRange && !isFocus) continue
        nextTds.add(td)
        td.classList.toggle('cell-in-range', inRange)
        td.classList.toggle('range-top', inRange && !this.contains(trIdx - 1, c))
        td.classList.toggle('range-right', inRange && !this.contains(trIdx, c + 1))
        td.classList.toggle('range-bottom', inRange && !this.contains(trIdx + 1, c))
        td.classList.toggle('range-left', inRange && !this.contains(trIdx, c - 1))
        td.classList.toggle('cell-selected', isFocus)
      }
    }
    for (const tr of this.highlightedTrs) {
      if (!nextTrs.has(tr)) tr.classList.remove('row-selected')
    }
    for (const td of this.highlightedTds) {
      if (!nextTds.has(td)) {
        td.classList.remove('cell-in-range', 'range-top', 'range-right', 'range-bottom', 'range-left', 'cell-selected')
      }
    }
    this.highlightedTrs = nextTrs
    this.highlightedTds = nextTds
  }

  bindEvents() {
    const wrap = this.wrapEl
    if (!wrap) return

    const addBoundListener = (target, event, handler) => {
      target.addEventListener(event, handler)
      this._boundCleanups.push(() => target.removeEventListener(event, handler))
    }

    addBoundListener(wrap, 'mousedown', (e) => {
      if (e.button !== 0) return
      const target = e.target
      if (!(target instanceof HTMLElement)) return
      if (target === wrap) {
        const rect = wrap.getBoundingClientRect?.()
        if (
          rect &&
          rect.width > 0 &&
          rect.height > 0 &&
          ((wrap.clientWidth > 0 && e.clientX >= rect.left + wrap.clientWidth) ||
            (wrap.clientHeight > 0 && e.clientY >= rect.top + wrap.clientHeight))
        ) {
          return
        }
      }
      if (target.closest('input, textarea, select, button, .col-resize-handle, .fk-link-badge')) return
      if (target.closest('th')) return

      const td = target.closest('td')
      const isDataOrRowNumCell = Boolean(
        td &&
          this.tableEl.contains(td) &&
          ((td.classList.contains('td-rownum') && td.dataset.rowIdx !== undefined) ||
            (td.dataset.rowIdx !== undefined && td.dataset.colIdx !== undefined))
      )
      if (!isDataOrRowNumCell) {
        if (this.hasSelection()) {
          this.clear()
        }
        wrap.focus({ preventScroll: true })
        return
      }
      const ctrl = e.ctrlKey || e.metaKey
      const shift = e.shiftKey

      if (td.classList.contains('td-rownum') && td.dataset.rowIdx !== undefined) {
        e.preventDefault()
        const r = Number(td.dataset.rowIdx)
        this.selectRow(r, { ctrl, shift })
        if (!ctrl) {
          this.dragMode = 'row'
        }
        wrap.focus({ preventScroll: true })
        return
      }

      if (td.dataset.rowIdx !== undefined && td.dataset.colIdx !== undefined) {
        const r = Number(td.dataset.rowIdx)
        const c = Number(td.dataset.colIdx)
        if (ctrl && !shift && this.onCtrlClickCell && this.onCtrlClickCell(r, c, e)) {
          e.preventDefault()
          return
        }
        e.preventDefault()
        this.selectCell(r, c, { ctrl, shift })
        if (!ctrl) {
          this.dragMode = 'cell'
        }
        wrap.focus({ preventScroll: true })
      }
    })

    const applyPendingDrag = () => {
      this.dragRafId = null
      const coord = this.pendingDragCoord
      this.pendingDragCoord = null
      if (!this.dragMode || !this.anchor || !coord) return
      const { r, c } = coord
      if (this.focus && this.focus.r === r && this.focus.c === c) return
      if (this.dragMode === 'row') {
        const { cols } = this.getDimensions()
        this.ranges = [normalizeCellRange(this.anchor.r, 0, r, Math.max(0, cols - 1))]
        this.focus = { r, c: 0 }
        this.mode = 'row'
      } else {
        this.ranges = [normalizeCellRange(this.anchor.r, this.anchor.c, r, c)]
        this.focus = { r, c }
        this.mode = 'cell'
      }
      this.applyDomClasses()
      this.onSelectionChange(this)
    }

    addBoundListener(wrap, 'mousemove', (e) => {
      if (!this.dragMode || !this.anchor) return
      const target = e.target
      if (!(target instanceof HTMLElement)) return
      const td = target.closest('td')
      if (!td || !this.tableEl.contains(td)) return
      let r = -1
      let c = 0
      if (this.dragMode === 'row' && td.dataset.rowIdx !== undefined) {
        r = Number(td.dataset.rowIdx)
        c = 0
      } else if (this.dragMode === 'cell' && td.dataset.rowIdx !== undefined && td.dataset.colIdx !== undefined) {
        r = Number(td.dataset.rowIdx)
        c = Number(td.dataset.colIdx)
      } else {
        return
      }
      if (!Number.isFinite(r) || r < 0) return
      if (this.focus && this.focus.r === r && this.focus.c === c && !this.pendingDragCoord) {
        return
      }
      if (this.pendingDragCoord && this.pendingDragCoord.r === r && this.pendingDragCoord.c === c) {
        return
      }
      this.pendingDragCoord = { r, c }
      if (typeof requestAnimationFrame === 'function') {
        if (this.dragRafId === null) {
          this.dragRafId = requestAnimationFrame(applyPendingDrag)
        }
      } else {
        applyPendingDrag()
      }
    })

    const endDrag = () => {
      if (this.dragRafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.dragRafId)
        this.dragRafId = null
      }
      if (this.pendingDragCoord && this.dragMode) {
        applyPendingDrag()
      }
      this.pendingDragCoord = null
      this.dragMode = null
    }

    addBoundListener(window, 'mouseup', endDrag)
    addBoundListener(window, 'blur', endDrag)

    addBoundListener(wrap, 'contextmenu', (e) => {
      const target = e.target
      if (!(target instanceof HTMLElement)) return
      const th = target.closest('th[data-col-idx]')
      if (th && this.tableEl.contains(th)) {
        e.preventDefault()
        const c = Number(th.dataset.colIdx)
        this.onContextMenu(e, { kind: 'header', colIdx: c })
        return
      }
      const td = target.closest('td')
      const isDataOrRowNumCell = Boolean(
        td &&
          this.tableEl.contains(td) &&
          ((td.classList.contains('td-rownum') && td.dataset.rowIdx !== undefined) ||
            (td.dataset.rowIdx !== undefined && td.dataset.colIdx !== undefined))
      )
      if (!isDataOrRowNumCell) {
        if (this.editable) {
          e.preventDefault()
          if (this.hasSelection()) this.clear()
          wrap.focus({ preventScroll: true })
          this.onContextMenu(e, { kind: 'canvas' })
        }
        return
      }
      if (td.classList.contains('td-rownum') && td.dataset.rowIdx !== undefined) {
        e.preventDefault()
        const r = Number(td.dataset.rowIdx)
        if (!this.contains(r, 0)) this.selectRow(r)
        this.onContextMenu(e, { kind: 'cell', rowIdx: r, colIdx: 0 })
        return
      }
      if (td.dataset.rowIdx !== undefined && td.dataset.colIdx !== undefined) {
        e.preventDefault()
        const r = Number(td.dataset.rowIdx)
        const c = Number(td.dataset.colIdx)
        if (!this.contains(r, c)) this.selectCell(r, c)
        this.onContextMenu(e, { kind: 'cell', rowIdx: r, colIdx: c })
      }
    })

    addBoundListener(wrap, 'keydown', (e) => {
      const active = document.activeElement
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
        return
      }
      const ctrl = e.ctrlKey || e.metaKey
      const key = e.key
      if (ctrl && e.shiftKey && key.toLowerCase() === 'v' && this.editable) {
        e.preventDefault()
        this.onPasteNewRows(this)
        return
      }
      if (ctrl && key.toLowerCase() === 'v' && this.editable) {
        // Allow native paste event to fire onto wrap so clipboardData works in webviews without clipboard-read permissions
        return
      }
      const { rows, cols } = this.getDimensions()
      if (rows <= 0 || cols <= 0) return

      if (ctrl && key.toLowerCase() === 'a') {
        e.preventDefault()
        this.selectAll()
        return
      }
      if (ctrl && key.toLowerCase() === 'c') {
        if (this.hasSelection()) {
          e.preventDefault()
          this.onCopy(this)
        }
        return
      }
      if (key === 'Escape') {
        if (this.hasSelection()) {
          e.preventDefault()
          this.clear()
        }
        return
      }
      if ((key === 'Delete' || key === 'Backspace') && this.editable && this.hasSelection()) {
        e.preventDefault()
        this.onBulkSetNull(this)
        return
      }
      if ((key === 'Enter' || key === 'F2') && this.editable && this.focus) {
        e.preventDefault()
        if (this.onEnsureCellVisible) this.onEnsureCellVisible(this.focus.r, this.focus.c)
        this.onStartEdit(this.focus.r, this.focus.c)
        return
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
        e.preventDefault()
        const cur = this.focus || { r: 0, c: 0 }
        let nr = cur.r
        let nc = cur.c
        const transposed = Boolean(this.isTransposed())
        if (transposed) {
          if (key === 'ArrowUp') nc = Math.max(0, cur.c - 1)
          if (key === 'ArrowDown') nc = Math.min(cols - 1, cur.c + 1)
          if (key === 'ArrowLeft') nr = Math.max(0, cur.r - 1)
          if (key === 'ArrowRight') nr = Math.min(rows - 1, cur.r + 1)
        } else {
          if (key === 'ArrowUp') nr = Math.max(0, cur.r - 1)
          if (key === 'ArrowDown') nr = Math.min(rows - 1, cur.r + 1)
          if (key === 'ArrowLeft') nc = Math.max(0, cur.c - 1)
          if (key === 'ArrowRight') nc = Math.min(cols - 1, cur.c + 1)
        }
        if (this.onEnsureCellVisible) this.onEnsureCellVisible(nr, nc)
        this.selectCell(nr, nc, { shift: e.shiftKey })
        const targetTd = this.tableEl.querySelector(`tbody td[data-row-idx="${nr}"][data-col-idx="${nc}"]`)
        if (targetTd && typeof targetTd.scrollIntoView === 'function') {
          targetTd.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
      }
    })

    addBoundListener(wrap, 'paste', (e) => {
      if (!this.editable) return
      const active = document.activeElement
      if (
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.tagName === 'SELECT' ||
          active.isContentEditable)
      ) {
        return
      }
      const txt = e.clipboardData?.getData('text/plain') ?? e.clipboardData?.getData('text') ?? ''
      const handled = this.onPaste(this, txt)
      if (handled !== false && (txt.length > 0 || handled === true)) {
        e.preventDefault()
      }
    })
  }

  destroy() {
    if (this.dragRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.dragRafId)
      this.dragRafId = null
    }
    this.pendingDragCoord = null
    this.dragMode = null
    while (this._boundCleanups.length > 0) {
      const cleanup = this._boundCleanups.pop()
      try {
        cleanup()
      } catch {}
    }
    this.highlightedTrs.clear()
    this.highlightedTds.clear()
    this.ranges = []
    this.anchor = null
    this.focus = null
  }
}
