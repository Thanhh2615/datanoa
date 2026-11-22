// src/editor/grid-data-ops.ts
// Pure, testable data-grid computations: column sizing, client filtering, find matching,
// in-memory sorting, selection matrix export, row cloning, and staged change payload assembly.

import type { DatabaseDriverType } from '../protocol.js'
import {
  formatCellMatrixExport,
  formatDataExport,
  formatSqlInList,
} from '../drivers/common/sql-tools.js'
import type { CellCoord, GridSelectionModel } from './grid-selection.js'
import type { ColumnHeaderFilterOp } from './sql-column-filter.js'
import {
  formatCellValue,
  getCellValue,
  rowToPlainRecord,
  stringifyFilterValue,
  type GridModel,
} from './grid-formatters.js'

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

export interface InternalRowState {
  kind: 'existing' | 'inserted'
  origin?: 'blank' | 'clone' | 'paste' | 'import'
  deleted: boolean
  original: Record<string, unknown> | unknown[]
  dirtyCols: Map<string, unknown>
}

export interface ClientColumnFilter {
  column: string
  value: unknown
  op: ColumnHeaderFilterOp
}

export interface ClipboardCopySnapshot {
  text: string
  format: SelectionExportFormat
  headers: string[]
  rawMatrix: unknown[][]
  hasHeaders: boolean
  isFullRowSelection: boolean
}

export interface PasteColumnSpec {
  name: string
  isAutoIncrement?: boolean
  isPrimaryKey?: boolean
  isGenerated?: boolean
}

export interface PastePlanInput {
  matrix: readonly (readonly unknown[])[]
  hasSelection: boolean
  selectionBBox: {
    startRow: number
    endRow: number
    startCol: number
    endCol: number
  } | null
  selectedCellCount: number
  existingRowCount: number
  visibleColIndices: readonly number[]
  allColumns: readonly PasteColumnSpec[]
  forceNewRows: boolean
  explicitHasHeaders?: boolean
  sourceHeaders?: readonly string[]
}

export interface PastePlanCell {
  modelColIdx: number
  visColIdx: number
  rawValue: unknown
}

export interface PastePlanOverwriteRow {
  targetVisRow: number
  cells: PastePlanCell[]
}

export interface PastePlanInsertRow {
  cells: PastePlanCell[]
}

export interface PastePlanResult {
  mode: 'empty' | 'fill' | 'overwrite' | 'insert' | 'overwrite-and-insert'
  hadHeaders: boolean
  fillValue?: unknown
  overwrites: PastePlanOverwriteRow[]
  inserts: PastePlanInsertRow[]
  startVisRow: number
  startVisCol: number
}

function isAutoOrGeneratedColumn(col: PasteColumnSpec | undefined): boolean {
  return Boolean(col && (col.isAutoIncrement === true || col.isGenerated === true))
}

function detectHeaderColumnMapping(
  firstRow: readonly unknown[],
  allColumns: readonly PasteColumnSpec[],
  rowCount: number,
  explicitHasHeaders: boolean
): number[] | null {
  if (rowCount < 2 || firstRow.length === 0) return null
  const lookup = new Map<string, number>()
  allColumns.forEach((col, idx) => lookup.set(col.name.trim().toLowerCase(), idx))

  const mapped: number[] = []
  for (const cell of firstRow) {
    if (typeof cell !== 'string') return null
    const key = cell.trim().toLowerCase()
    if (!key) return null
    const idx = lookup.get(key)
    if (idx === undefined) return null
    mapped.push(idx)
  }

  if (mapped.length === 1 && !explicitHasHeaders) {
    return null
  }
  return mapped
}

function resolveSourceHeaderMapping(
  sourceHeaders: readonly string[] | undefined,
  clipWidth: number,
  allColumns: readonly PasteColumnSpec[]
): number[] | null {
  if (!sourceHeaders || sourceHeaders.length === 0 || sourceHeaders.length < clipWidth) {
    return null
  }
  const lookup = new Map<string, number>()
  allColumns.forEach((col, idx) => lookup.set(col.name.trim().toLowerCase(), idx))

  const mapped: number[] = []
  for (let i = 0; i < sourceHeaders.length; i++) {
    const idx = lookup.get(sourceHeaders[i].trim().toLowerCase())
    if (idx === undefined) return null
    mapped.push(idx)
  }
  if (!mapped.some((idx) => !isAutoOrGeneratedColumn(allColumns[idx]))) {
    return null
  }
  return mapped
}

/**
 * Pure smart paste planner shared by Studio and tested against Side Panel parity:
 * - No selection / empty table / forceNewRows -> inserts all rows as brand-new staged rows
 *   (mapping by headers, internal sourceHeaders, or non-auto-increment columns).
 * - Active selection:
 *   - 1x1 value onto multi-cell selection -> fills selected cells.
 *   - R x C block -> overwrites existing rows starting at anchor, and inserts overflow rows
 *     beyond existingRowCount with identical column alignment (omitting auto-increment/generated).
 *   - Full-row paste (width >= visibleCols.length) aligns at visible col 0 even if focused mid-row.
 */
export function planGridPaste(input: PastePlanInput): PastePlanResult {
  const {
    matrix,
    hasSelection,
    selectionBBox,
    selectedCellCount,
    existingRowCount,
    visibleColIndices,
    allColumns,
    forceNewRows,
    explicitHasHeaders = false,
    sourceHeaders,
  } = input

  if (matrix.length === 0 || visibleColIndices.length === 0 || allColumns.length === 0) {
    return {
      mode: 'empty',
      hadHeaders: false,
      overwrites: [],
      inserts: [],
      startVisRow: 0,
      startVisCol: 0,
    }
  }

  const headerColMapping = detectHeaderColumnMapping(
    matrix[0],
    allColumns,
    matrix.length,
    explicitHasHeaders
  )
  const hadHeaders = headerColMapping !== null
  const dataRows = hadHeaders ? matrix.slice(1) : matrix
  if (dataRows.length === 0) {
    return {
      mode: 'empty',
      hadHeaders,
      overwrites: [],
      inserts: [],
      startVisRow: 0,
      startVisCol: 0,
    }
  }

  const visColPosByModelIdx = new Map<number, number>()
  visibleColIndices.forEach((modelColIdx, visIdx) => visColPosByModelIdx.set(modelColIdx, visIdx))

  let maxClipCols = 0
  for (const row of dataRows) {
    if (row.length > maxClipCols) maxClipCols = row.length
  }

  const isSingleScalar = dataRows.length === 1 && dataRows[0].length === 1
  if (
    !forceNewRows &&
    hasSelection &&
    existingRowCount > 0 &&
    !hadHeaders &&
    isSingleScalar &&
    selectedCellCount > 1
  ) {
    return {
      mode: 'fill',
      hadHeaders: false,
      fillValue: dataRows[0][0],
      overwrites: [],
      inserts: [],
      startVisRow: selectionBBox?.startRow ?? 0,
      startVisCol: selectionBBox?.startCol ?? 0,
    }
  }

  const buildInsertCells = (
    rowCells: readonly unknown[],
    colResolver: (dc: number) => { modelColIdx: number; visColIdx: number } | null
  ): PastePlanCell[] => {
    const cells: PastePlanCell[] = []
    for (let dc = 0; dc < rowCells.length; dc++) {
      const target = colResolver(dc)
      if (!target) continue
      const col = allColumns[target.modelColIdx]
      if (!col || isAutoOrGeneratedColumn(col)) continue
      cells.push({
        modelColIdx: target.modelColIdx,
        visColIdx: target.visColIdx,
        rawValue: rowCells[dc],
      })
    }
    return cells
  }

  // Branch A: Insert all rows as brand-new rows (no selection, empty table, or Ctrl+Shift+V)
  if (!hasSelection || !selectionBBox || forceNewRows || existingRowCount <= 0) {
    let insertColResolver: (dc: number) => { modelColIdx: number; visColIdx: number } | null

    if (headerColMapping) {
      insertColResolver = (dc) => {
        const modelColIdx = headerColMapping[dc]
        if (modelColIdx === undefined || modelColIdx < 0 || modelColIdx >= allColumns.length) {
          return null
        }
        return { modelColIdx, visColIdx: visColPosByModelIdx.get(modelColIdx) ?? -1 }
      }
    } else {
      const anchorCol =
        hasSelection && selectionBBox && maxClipCols < visibleColIndices.length
          ? Math.max(0, selectionBBox.startCol)
          : 0
      const canUseSourceMapping =
        !hasSelection ||
        !selectionBBox ||
        (forceNewRows && anchorCol === 0 && maxClipCols < visibleColIndices.length)
      const sourceMapping = canUseSourceMapping
        ? resolveSourceHeaderMapping(sourceHeaders, maxClipCols, allColumns)
        : null

      if (sourceMapping) {
        insertColResolver = (dc) => {
          const modelColIdx = sourceMapping[dc]
          if (modelColIdx === undefined || modelColIdx < 0 || modelColIdx >= allColumns.length) {
            return null
          }
          return { modelColIdx, visColIdx: visColPosByModelIdx.get(modelColIdx) ?? -1 }
        }
      } else {
        const writableVisibleCols = visibleColIndices.filter(
          (modelColIdx) => !isAutoOrGeneratedColumn(allColumns[modelColIdx])
        )
        const shouldSkipLeadingAuto =
          anchorCol === 0 &&
          maxClipCols < visibleColIndices.length &&
          writableVisibleCols.length > 0 &&
          isAutoOrGeneratedColumn(allColumns[visibleColIndices[0]])
        if (shouldSkipLeadingAuto) {
          insertColResolver = (dc) => {
            const modelColIdx = writableVisibleCols[dc]
            if (modelColIdx === undefined) return null
            return { modelColIdx, visColIdx: visColPosByModelIdx.get(modelColIdx) ?? -1 }
          }
        } else {
          insertColResolver = (dc) => {
            const visColIdx = anchorCol + dc
            const modelColIdx = visibleColIndices[visColIdx]
            if (modelColIdx === undefined) return null
            return { modelColIdx, visColIdx }
          }
        }
      }
    }

    const inserts: PastePlanInsertRow[] = dataRows.map((rowCells) => ({
      cells: buildInsertCells(rowCells, insertColResolver),
    }))

    return {
      mode: 'insert',
      hadHeaders,
      overwrites: [],
      inserts,
      startVisRow: existingRowCount,
      startVisCol: 0,
    }
  }

  // Branch B: Active selection -> overwrite existing rows + insert overflow rows
  const startVisRow = Math.max(0, selectionBBox.startRow)
  const effectiveStartCol = headerColMapping
    ? 0
    : maxClipCols >= visibleColIndices.length
      ? 0
      : Math.max(0, selectionBBox.startCol)

  const resolveColumn = (dc: number): { modelColIdx: number; visColIdx: number } | null => {
    if (headerColMapping) {
      const modelColIdx = headerColMapping[dc]
      if (modelColIdx === undefined || modelColIdx < 0 || modelColIdx >= allColumns.length) {
        return null
      }
      return { modelColIdx, visColIdx: visColPosByModelIdx.get(modelColIdx) ?? -1 }
    }
    const visColIdx = effectiveStartCol + dc
    const modelColIdx = visibleColIndices[visColIdx]
    if (modelColIdx === undefined) return null
    return { modelColIdx, visColIdx }
  }

  const overwrites: PastePlanOverwriteRow[] = []
  const inserts: PastePlanInsertRow[] = []

  for (let dr = 0; dr < dataRows.length; dr++) {
    const targetVisRow = startVisRow + dr
    const rowCells = dataRows[dr]
    if (targetVisRow < existingRowCount) {
      const cells: PastePlanCell[] = []
      for (let dc = 0; dc < rowCells.length; dc++) {
        const target = resolveColumn(dc)
        if (!target) continue
        cells.push({
          modelColIdx: target.modelColIdx,
          visColIdx: target.visColIdx,
          rawValue: rowCells[dc],
        })
      }
      overwrites.push({ targetVisRow, cells })
    } else {
      inserts.push({ cells: buildInsertCells(rowCells, resolveColumn) })
    }
  }

  const mode: PastePlanResult['mode'] =
    overwrites.length > 0 && inserts.length > 0
      ? 'overwrite-and-insert'
      : overwrites.length > 0
        ? 'overwrite'
        : 'insert'

  return {
    mode,
    hadHeaders,
    overwrites,
    inserts,
    startVisRow,
    startVisCol: effectiveStartCol,
  }
}

export function computeInitialColumnWidthsForGrid(
  model: GridModel,
  rowNumWidth: number
): number[] {
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
    // Account for header filter/select/sort action icons so column titles never ellipsize by default
    const headerMinPx = Math.max(112, Math.round(header.length * 8.2 + 64))
    const px = Math.max(headerMinPx, Math.round(maxChars * 7.5 + 28))
    return Math.max(112, Math.min(300, px))
  })
  if (model.rows.length === 0 && widths.length > 0) {
    const minTableWidth = 340
    const currentTotal = rowNumWidth + widths.reduce((sum, w) => sum + w, 0)
    if (currentTotal < minTableWidth) {
      const extraPerCol = Math.ceil((minTableWidth - currentTotal) / widths.length)
      for (let i = 0; i < widths.length; i++) {
        widths[i] += extraPerCol
      }
    }
  }
  return widths
}

export function matchesClientColumnFilters(
  row: Record<string, unknown> | unknown[],
  headers: string[],
  filters: readonly ClientColumnFilter[]
): boolean {
  if (filters.length === 0) return true
  for (const flt of filters) {
    const colIdx = headers.indexOf(flt.column)
    if (colIdx < 0) continue
    const cellVal = getCellValue(row, colIdx, flt.column)
    const isNull = cellVal === null || cellVal === undefined
    if (flt.op === 'is-null') {
      if (!isNull) return false
    } else if (flt.op === 'is-not-null') {
      if (isNull) return false
    } else if (flt.op === 'contains') {
      const needle = stringifyFilterValue(flt.value).toLowerCase()
      if (
        needle.length > 0 &&
        (isNull || !stringifyFilterValue(cellVal).toLowerCase().includes(needle))
      ) {
        return false
      }
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

export function computeFilteredRowIndices(
  model: GridModel,
  rowStates: readonly InternalRowState[],
  clientFilter: string,
  clientColumnFilters: readonly ClientColumnFilter[]
): number[] {
  const total = model.rows.length
  const hasSearch = clientFilter.length > 0
  const hasColFilters = clientColumnFilters.length > 0
  if (!hasSearch && !hasColFilters) {
    const all = new Array<number>(total)
    for (let i = 0; i < total; i++) {
      all[i] = i
    }
    return all
  }

  const query = clientFilter
  const queryMatchesNull = 'null'.includes(query)
  const headers = model.headers
  const colCount = headers.length
  const rows = model.rows
  const matched: number[] = []
  for (let i = 0; i < total; i++) {
    if (rowStates[i]?.kind === 'inserted') {
      matched.push(i)
      continue
    }
    const row = rows[i]
    if (hasColFilters && !matchesClientColumnFilters(row, headers, clientColumnFilters)) {
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
  return matched
}

export function computeGridFindMatches(
  model: GridModel,
  visibleRows: readonly number[],
  visibleCols: readonly number[],
  needle: string,
  maxMatches = 10000
): { matches: CellCoord[]; matchKeys: Set<string> } {
  const matches: CellCoord[] = []
  const matchKeys = new Set<string>()
  const rowCount = visibleRows.length
  const colCount = visibleCols.length
  if (!needle || rowCount === 0 || colCount === 0) {
    return { matches, matchKeys }
  }

  const needleLower = needle.toLowerCase()
  const needleMatchesNull = 'null'.includes(needleLower)
  const headers = model.headers
  const rows = model.rows
  const visHeaders = new Array<string>(colCount)
  for (let vc = 0; vc < colCount; vc++) {
    visHeaders[vc] = headers[visibleCols[vc]]
  }

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
        matchKeys.add(`${vr}:${vc}`)
        if (matches.length >= maxMatches) {
          break outer
        }
      }
    }
  }

  return { matches, matchKeys }
}

export function compareGridCellValues(va: unknown, vb: unknown, factor: 1 | -1): number {
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
    String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * factor
  )
}

export function buildGridSelectionSnapshot(opts: {
  model: GridModel
  selection: GridSelectionModel
  visibleRows: readonly number[]
  visibleCols: readonly number[]
  format: SelectionExportFormat
  tableName: string
  dialect: DatabaseDriverType
}): ClipboardCopySnapshot | null {
  const { model, selection, visibleRows, visibleCols, format, tableName, dialect } = opts
  const selVisRows = selection.getSelectedRowIndices(visibleRows.length)
  const selVisCols = selection.getSelectedColIndices(visibleCols.length)
  if (selVisRows.length === 0 || selVisCols.length === 0) return null

  const selHeaders = selVisCols.map((vc) => model.headers[visibleCols[vc]])
  const isFullRowSelection = selVisCols.length === visibleCols.length && visibleCols.length > 0

  if (format === 'sql-in') {
    const values: unknown[] = []
    selection.forEachSelectedCell(visibleRows.length, visibleCols.length, (vr, vc) => {
      const rIdx = visibleRows[vr]
      const cIdx = visibleCols[vc]
      if (rIdx !== undefined && cIdx !== undefined) {
        values.push(getCellValue(model.rows[rIdx], cIdx, model.headers[cIdx]))
      }
    })
    const text = formatSqlInList(values, dialect, {
      deduplicate: true,
      columnName: selHeaders.length === 1 ? selHeaders[0] : undefined,
    })
    return {
      text,
      format,
      headers: selHeaders,
      rawMatrix: [],
      hasHeaders: false,
      isFullRowSelection,
    }
  }

  if (format === 'sql-insert') {
    const records: Record<string, unknown>[] = selVisRows.map((vr) => {
      const rIdx = visibleRows[vr]
      const rowObj: Record<string, unknown> = {}
      for (const vc of selVisCols) {
        const cIdx = visibleCols[vc]
        const header = model.headers[cIdx]
        if (selection.isSelected(vr, vc)) {
          const val = getCellValue(model.rows[rIdx], cIdx, header)
          rowObj[header] = val === undefined ? null : val
        } else {
          rowObj[header] = null
        }
      }
      return rowObj
    })
    const text = formatDataExport({
      columns: selHeaders,
      rows: records,
      format: 'sql-insert',
      tableName,
      dialect,
    })
    return {
      text,
      format,
      headers: selHeaders,
      rawMatrix: [],
      hasHeaders: false,
      isFullRowSelection,
    }
  }

  const rawDataMatrix: unknown[][] = selVisRows.map((vr) => {
    const rIdx = visibleRows[vr]
    return selVisCols.map((vc) => {
      if (!selection.isSelected(vr, vc)) {
        return format === 'json' ? null : ''
      }
      const cIdx = visibleCols[vc]
      const val = getCellValue(model.rows[rIdx], cIdx, model.headers[cIdx])
      return val === undefined ? null : val
    })
  })

  const text = formatCellMatrixExport(selHeaders, rawDataMatrix, format)
  const hasHeaders = format === 'tsv-headers' || format === 'csv'
  const rawMatrix = hasHeaders ? [selHeaders, ...rawDataMatrix] : rawDataMatrix

  return {
    text,
    format,
    headers: selHeaders,
    rawMatrix,
    hasHeaders,
    isFullRowSelection,
  }
}

export function exportGridSelectionMatrix(opts: {
  model: GridModel
  selection: GridSelectionModel
  visibleRows: readonly number[]
  visibleCols: readonly number[]
  format: SelectionExportFormat
  tableName: string
  dialect: DatabaseDriverType
}): string {
  return buildGridSelectionSnapshot(opts)?.text ?? ''
}

export function createClonedRowRecord(
  model: GridModel,
  sourceIdx: number
): Record<string, unknown> {
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

export function buildGridChangesPayload(
  model: GridModel | null,
  rowStates: readonly InternalRowState[]
): GridChangesPayload {
  const inserts: Record<string, unknown>[] = []
  const updates: StagedRowUpdate[] = []
  const deletes: Record<string, unknown>[] = []

  if (!model) {
    return { inserts, updates, deletes }
  }

  const headers = model.headers
  const pkCols = model.primaryKey
  const pkIndices = pkCols.map((pk) => headers.indexOf(pk))

  rowStates.forEach((state, rowIndex) => {
    if (state.kind === 'inserted') {
      if (!state.deleted) {
        inserts.push(rowToPlainRecord(headers, model.rows[rowIndex], true))
      }
      return
    }

    if (!state.deleted && state.dirtyCols.size === 0) {
      return
    }

    const primaryKeys: Record<string, unknown> = {}
    for (let i = 0; i < pkCols.length; i++) {
      const pk = pkCols[i]
      primaryKeys[pk] = getCellValue(state.original, pkIndices[i], pk)
    }

    if (state.deleted) {
      deletes.push(primaryKeys)
      return
    }

    const changes: Record<string, unknown> = {}
    for (const [k, v] of state.dirtyCols.entries()) {
      changes[k] = v
    }
    updates.push({
      primaryKeys,
      changes,
      originalRow: rowToPlainRecord(headers, state.original, false),
    })
  })

  return { inserts, updates, deletes }
}

export function countGridStagedChanges(rowStates: readonly InternalRowState[]): number {
  let count = 0
  for (let i = 0; i < rowStates.length; i++) {
    const state = rowStates[i]
    if (!state) continue
    if (state.kind === 'inserted') {
      if (!state.deleted) count++
    } else if (state.deleted || state.dirtyCols.size > 0) {
      count++
    }
  }
  return count
}
