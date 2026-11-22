// src/editor/grid-formatters.ts
// Pure Data Grid formatting, coercion, virtual scroll windowing, row cloning, and clipboard helpers

import type { ColumnInfo, QueryResult, TableBrowseResult } from '../protocol.js'

export const ROW_HEIGHT_PX = 22

export interface FormattedCell {
  text: string
  className: string
}

export interface CellEditGate {
  allowed: boolean
  reason?: string
}

export interface GridModel {
  headers: string[]
  columns: (ColumnInfo | { name: string; type?: string })[]
  rows: (Record<string, unknown> | unknown[])[]
  rowCount: number
  canEdit: boolean
  primaryKey: string[]
}

export const NUMERIC_COLUMN_TYPE_REGEX =
  /\b(?:INT|INTEGER|BIGINT|SMALLINT|TINYINT|MEDIUMINT|INT2|INT4|INT8|UINT8|UINT16|UINT32|UINT64|FLOAT4|FLOAT8|REAL|FLOAT|DOUBLE|NUMERIC|DECIMAL|NUMBER|SERIAL|BIGSERIAL|SMALLSERIAL)\b/i
export const BOOLEAN_COLUMN_TYPE_REGEX = /\b(?:BOOL|BOOLEAN)\b/i
export const EMPTY_AS_NULL_NON_TEXT_TYPE_REGEX =
  /\b(?:DATE|TIME|TIMESTAMP|TIMESTAMPTZ|DATETIME|YEAR|UUID|GUID|JSON|JSONB|INET|CIDR|MACADDR|BYTEA|BLOB|BINARY|VARBINARY|INTERVAL)\b/i
export const INTEGER_LITERAL_REGEX = /^[+-]?\d+$/
export const DECIMAL_LITERAL_REGEX = /^[+-]?(?:\d+\.?\d*|\.\d+)$/

export function isNativeDomElement(el: unknown): boolean {
  return (
    typeof el === 'object' &&
    el !== null &&
    Object.prototype.toString.call(el).startsWith('[object HTML')
  )
}

/**
 * Safely coerces user-entered or pasted string values for typed columns while preserving
 * 64-bit BIGINT precision (Number.isSafeInteger) and avoiding invalid empty strings on non-text types.
 */
export function coerceCellInputValue(
  rawNewValue: string,
  originalValue: unknown,
  colType?: string,
  nullable = true
): unknown {
  const trimmed = rawNewValue.trim()
  const isNumericCol =
    typeof originalValue === 'number' ||
    Boolean(colType && NUMERIC_COLUMN_TYPE_REGEX.test(colType))
  const isBoolCol =
    typeof originalValue === 'boolean' ||
    Boolean(colType && BOOLEAN_COLUMN_TYPE_REGEX.test(colType))
  const isOtherNonTextCol = Boolean(colType && EMPTY_AS_NULL_NON_TEXT_TYPE_REGEX.test(colType))

  if (trimmed === '' && (isNumericCol || isBoolCol || isOtherNonTextCol)) {
    return null
  }

  if (
    trimmed.toUpperCase() === 'NULL' &&
    nullable &&
    (isNumericCol || isBoolCol || isOtherNonTextCol)
  ) {
    return null
  }

  if (isBoolCol) {
    if (/^true$/i.test(trimmed)) return true
    if (/^false$/i.test(trimmed)) return false
  }

  if (isNumericCol) {
    if (trimmed !== '') {
      if (INTEGER_LITERAL_REGEX.test(trimmed)) {
        const num = Number(trimmed)
        if (Number.isSafeInteger(num)) {
          return num
        }
        return trimmed
      }
      if (DECIMAL_LITERAL_REGEX.test(trimmed)) {
        const normalizedDigits = trimmed
          .replace(/^[+-]?0+(?=\d)/, '')
          .replace('.', '')
          .replace(/^0+$/, '0')
        if (normalizedDigits.length > 15) {
          return trimmed
        }
      }
      const num = Number(trimmed)
      if (Number.isFinite(num)) {
        return num
      }
    }
  }
  return rawNewValue
}

/**
 * Formats grid header and rows from TableBrowseResult and QueryResult (F16-01).
 */
export function formatGridModel(data: TableBrowseResult | QueryResult): GridModel {
  const isBrowse = 'totalRows' in data
  const headers = data.columns.map((col) => (typeof col === 'string' ? col : col.name))
  const rowCount = isBrowse ? data.totalRows : data.rowCount
  const canEdit = isBrowse ? Boolean(data.canEdit) : false
  const primaryKey = isBrowse ? data.primaryKey || [] : []

  const columns: (ColumnInfo | { name: string; type?: string })[] = data.columns.map((col) => {
    if (typeof col === 'string') return { name: col }
    return col
  })

  return {
    headers,
    rows: data.rows,
    rowCount,
    columns,
    canEdit,
    primaryKey,
  }
}

/**
 * Formats NULL values as italic muted and numbers with tabular-nums (F16-02).
 */
export function formatCellValue(value: unknown, type?: string): FormattedCell {
  if (value === null || value === undefined) {
    return { text: 'NULL', className: 'datanoa-cell-null' }
  }
  if (typeof value === 'number' || (type && NUMERIC_COLUMN_TYPE_REGEX.test(type))) {
    return { text: String(value), className: 'datanoa-cell-numeric' }
  }
  if (typeof value === 'object') {
    try {
      return { text: JSON.stringify(value), className: 'datanoa-cell-json' }
    } catch {
      return { text: String(value), className: 'datanoa-cell-text' }
    }
  }
  return { text: String(value), className: 'datanoa-cell-text' }
}

/**
 * Calculates visible window indices for virtual scrolling (F16-03).
 */
export function calculateVisibleWindow(scrollTop: number, viewportHeightPx = 440) {
  const startIndex = Math.floor(scrollTop / ROW_HEIGHT_PX)
  const visibleCount = Math.ceil(viewportHeightPx / ROW_HEIGHT_PX)
  const endIndex = startIndex + visibleCount
  return { startIndex, endIndex, visibleCount }
}

/**
 * Checks whether inline editing is permitted for a table (F17-01).
 */
export function checkCellEditGate(canEdit: boolean, primaryKeys: string[]): CellEditGate {
  if (!canEdit) {
    return { allowed: false, reason: 'read_only_table' }
  }
  if (!primaryKeys || primaryKeys.length === 0) {
    return { allowed: false, reason: 'missing_primary_key' }
  }
  return { allowed: true }
}

export function getCellValue(
  row: Record<string, unknown> | unknown[],
  colIndex: number,
  colName: string
): unknown {
  if (Array.isArray(row)) {
    return row[colIndex]
  }
  return row[colName]
}

export function setCellValue(
  row: Record<string, unknown> | unknown[],
  colIndex: number,
  colName: string,
  value: unknown
): void {
  if (Array.isArray(row)) {
    row[colIndex] = value
  } else {
    row[colName] = value
  }
}

export function cloneRowData(
  row: Record<string, unknown> | unknown[]
): Record<string, unknown> | unknown[] {
  if (Array.isArray(row)) {
    return [...row]
  }
  return { ...row }
}

export function rowToPlainRecord(
  headers: string[],
  row: Record<string, unknown> | unknown[],
  omitUndefined = false
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  headers.forEach((header, idx) => {
    const val = getCellValue(row, idx, header)
    if (omitUndefined && val === undefined) return
    out[header] = val === undefined ? null : val
  })
  return out
}

export function stringifyFilterValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

export function previewMenuValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  const raw = stringifyFilterValue(value).replace(/\s+/g, ' ').trim()
  return raw.length > 22 ? `${raw.slice(0, 22)}...` : raw
}

export function parseOptionalInt(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null
  const num = Number.parseInt(raw, 10)
  return Number.isFinite(num) ? num : null
}

export function copyTextToClipboard(text: string): boolean {
  let copied = false
  if (typeof document !== 'undefined' && document.body) {
    const prevActive =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.left = '-9999px'
    ta.style.width = '1px'
    ta.style.height = '1px'
    ta.style.opacity = '0'
    ta.style.pointerEvents = 'none'
    document.body.appendChild(ta)
    try {
      ta.focus({ preventScroll: true })
    } catch {
      ta.focus()
    }
    ta.select()
    try {
      if (typeof ta.setSelectionRange === 'function') {
        ta.setSelectionRange(0, text.length)
      }
    } catch {
      // Ignore in minimal test DOM
    }
    try {
      if (typeof document.execCommand === 'function') {
        copied = Boolean(document.execCommand('copy'))
      }
    } catch {
      // Ignore fallback failure
    }
    ta.remove()
    if (prevActive && typeof prevActive.focus === 'function') {
      try {
        prevActive.focus({ preventScroll: true })
      } catch {
        prevActive.focus()
      }
    }
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void Promise.resolve(navigator.clipboard.writeText(text)).catch(() => {})
    copied = true
  }
  return copied
}
