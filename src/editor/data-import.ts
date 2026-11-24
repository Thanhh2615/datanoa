// src/editor/data-import.ts
// Pure zero-DOM CSV/TSV/JSON/NDJSON file decoding, parsing, column mapping, coercion, and SQL preview

import type { ColumnInfo, DatabaseDriverType } from '../protocol.js'
import { buildInsertStatement } from '../drivers/common/update-builder.js'
import { parseJsonPreservingBigInts } from '../shared-grid-paste.js'
import { coerceCellInputValue } from './grid-formatters.js'

export { parseJsonPreservingBigInts }

export type ImportFileFormat = 'auto' | 'csv' | 'tsv' | 'json' | 'ndjson'
export type ResolvedImportFormat = 'csv' | 'tsv' | 'json' | 'ndjson'
export type ImportDelimiter = ',' | '\t' | ';' | '|'
export type ImportDelimiterOption = 'auto' | ImportDelimiter
export type ImportEncodingOption =
  | 'auto'
  | 'utf-8'
  | 'utf-16le'
  | 'utf-16be'
  | 'windows-1252'
  | 'iso-8859-1'
  | 'shift_jis'
export type ImportNullHandling = 'empty-and-null' | 'empty-only' | 'null-literal-only' | 'none'

export interface ImportParseOptions {
  format: ImportFileFormat
  delimiter: ImportDelimiterOption
  encoding: ImportEncodingOption
  hasHeaderRow: boolean
  trimValues: boolean
  fileName?: string
}

export interface ParsedImportDataset {
  resolvedFormat: ResolvedImportFormat
  resolvedDelimiter: ImportDelimiter | null
  resolvedEncoding: string
  hasNamedHeaders: boolean
  headers: string[]
  rows: unknown[][]
  totalRows: number
  warnings: string[]
}

const CANDIDATE_DELIMITERS: readonly ImportDelimiter[] = ['\t', ',', ';', '|']

function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Decodes raw file bytes into text using explicit encoding or BOM auto-detection.
 */
export function decodeImportBytes(
  bytes: Uint8Array,
  encoding: ImportEncodingOption = 'auto'
): { text: string; resolvedEncoding: string } {
  let targetEncoding: string = encoding

  if (encoding === 'auto') {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      targetEncoding = 'utf-16le'
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      targetEncoding = 'utf-16be'
    } else {
      targetEncoding = 'utf-8'
    }
  }

  if (targetEncoding === 'utf-8') {
    try {
      const utf8Text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return {
        text: stripLeadingBom(utf8Text),
        resolvedEncoding: 'utf-8',
      }
    } catch {
      if (encoding === 'utf-8') {
        throw new Error(
          'File is not valid UTF-8. Select Windows-1252, ISO-8859-1, or Shift_JIS encoding instead.'
        )
      }
      targetEncoding = 'windows-1252'
    }
  }

  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(targetEncoding)
  } catch {
    targetEncoding = 'utf-8'
    decoder = new TextDecoder('utf-8')
  }

  return {
    text: stripLeadingBom(decoder.decode(bytes)),
    resolvedEncoding: targetEncoding,
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function looksLikeNdjson(trimmed: string): boolean {
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length < 2) return false
  const sampleCount = Math.min(lines.length, 5)
  for (let i = 0; i < sampleCount; i++) {
    const line = lines[i]
    if (!line.startsWith('{') && !line.startsWith('[')) {
      return false
    }
    try {
      JSON.parse(line)
    } catch {
      return false
    }
  }
  return true
}

/**
 * Auto-detects import format using filename extension and content sniffing.
 */
export function detectImportFormat(text: string, fileName?: string): ResolvedImportFormat {
  const cleanName = (fileName || '').trim().toLowerCase()
  const lastDot = cleanName.lastIndexOf('.')
  const ext = lastDot > 0 && lastDot < cleanName.length - 1 ? cleanName.slice(lastDot + 1) : ''
  if (ext === 'ndjson' || ext === 'jsonl') return 'ndjson'
  if (ext === 'json') return 'json'
  if (ext === 'tsv' || ext === 'tab') return 'tsv'

  const trimmed = stripLeadingBom(text).trim()
  if (trimmed.startsWith('[')) {
    if (looksLikeNdjson(trimmed)) {
      return 'ndjson'
    }
    return 'json'
  }
  if (trimmed.startsWith('{')) {
    if (looksLikeNdjson(trimmed)) {
      return 'ndjson'
    }
    try {
      JSON.parse(trimmed)
      return 'json'
    } catch {
      return 'ndjson'
    }
  }

  if (ext === 'csv') return 'csv'
  return detectImportDelimiter(text) === '\t' ? 'tsv' : 'csv'
}

/**
 * Quote-aware delimiter auto-detection across `,`, `\t`, `;`, and `|`.
 */
export function detectImportDelimiter(text: string): ImportDelimiter {
  const clean = stripLeadingBom(text)
  if (!clean) return ','

  const countsByDelim: Record<ImportDelimiter, number[]> = {
    '\t': [],
    ',': [],
    ';': [],
    '|': [],
  }

  let inQuotes = false
  let atFieldStart = true
  let lineIdx = 0
  const currentLineCounts: Record<ImportDelimiter, number> = {
    '\t': 0,
    ',': 0,
    ';': 0,
    '|': 0,
  }
  let hasLineContent = false

  const flushLine = (): void => {
    if (!hasLineContent) return
    for (const delim of CANDIDATE_DELIMITERS) {
      countsByDelim[delim].push(currentLineCounts[delim])
      currentLineCounts[delim] = 0
    }
    hasLineContent = false
    lineIdx++
  }

  for (let i = 0; i < clean.length && lineIdx < 12; i++) {
    const ch = clean[i]
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < clean.length && clean[i + 1] === '"') {
          i++
          continue
        }
        inQuotes = false
      }
      continue
    }
    if (atFieldStart && ch === '"') {
      inQuotes = true
      atFieldStart = false
      hasLineContent = true
      continue
    }
    if (ch === '\r' || ch === '\n') {
      flushLine()
      atFieldStart = true
      if (ch === '\r' && i + 1 < clean.length && clean[i + 1] === '\n') {
        i++
      }
      continue
    }
    if (ch !== ' ') {
      hasLineContent = true
    }
    if (ch === '\t' || ch === ',' || ch === ';' || ch === '|') {
      currentLineCounts[ch]++
      atFieldStart = true
      continue
    }
    if (ch !== ' ') {
      atFieldStart = false
    }
  }
  if (lineIdx < 12) {
    flushLine()
  }

  let bestDelim: ImportDelimiter = ','
  let bestScore = -1

  for (const delim of CANDIDATE_DELIMITERS) {
    const counts = countsByDelim[delim]
    const nonZero = counts.filter((c) => c > 0)
    if (nonZero.length === 0) continue

    const firstCount = counts[0]
    const consistentLines = counts.filter((c) => c === firstCount && c > 0).length
    const avgCount = nonZero.reduce((acc, c) => acc + c, 0) / nonZero.length
    const consistencyRatio = consistentLines / counts.length
    const score = consistencyRatio * 1000 + Math.min(avgCount, 50) * 10 + (delim === '\t' ? 2 : 0)

    if (score > bestScore) {
      bestScore = score
      bestDelim = delim
    }
  }

  return bestDelim
}

/**
 * RFC-4180 compliant delimited parser supporting `,`, `\t`, `;`, `|`, escaped `""`,
 * and embedded newlines inside quoted fields.
 */
export function parseDelimitedImportText(text: string, delimiter: ImportDelimiter): string[][] {
  const clean = stripLeadingBom(text)
  if (!clean) return []

  const rows: string[][] = []
  const rowHadQuotes: boolean[] = []
  let currentRow: string[] = []
  let currentRowHadQuotes = false
  let field = ''
  let inQuotes = false
  let atFieldStart = true
  let i = 0
  const len = clean.length

  while (i < len) {
    const ch = clean[i]
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < len && clean[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }

    if (atFieldStart && ch === ' ') {
      let j = i
      while (j < len && clean[j] === ' ') j++
      if (j < len && clean[j] === '"') {
        inQuotes = true
        currentRowHadQuotes = true
        atFieldStart = false
        i = j + 1
        continue
      }
    }

    if (atFieldStart && ch === '"') {
      inQuotes = true
      currentRowHadQuotes = true
      atFieldStart = false
      i++
      continue
    }

    if (ch === delimiter) {
      currentRow.push(field)
      field = ''
      atFieldStart = true
      i++
      continue
    }

    if (ch === '\r' || ch === '\n') {
      currentRow.push(field)
      rows.push(currentRow)
      rowHadQuotes.push(currentRowHadQuotes)
      currentRow = []
      currentRowHadQuotes = false
      field = ''
      atFieldStart = true
      if (ch === '\r' && i + 1 < len && clean[i + 1] === '\n') {
        i += 2
      } else {
        i++
      }
      continue
    }

    field += ch
    atFieldStart = false
    i++
  }

  if (!atFieldStart || currentRow.length > 0) {
    currentRow.push(field)
    rows.push(currentRow)
    rowHadQuotes.push(currentRowHadQuotes)
  }

  while (
    rows.length > 0 &&
    rows[rows.length - 1].length === 1 &&
    rows[rows.length - 1][0] === '' &&
    !rowHadQuotes[rows.length - 1]
  ) {
    rows.pop()
    rowHadQuotes.pop()
  }

  return rows
}

function normalizeSourceHeaders(rawHeaders: string[]): string[] {
  const used = new Map<string, number>()
  return rawHeaders.map((raw, idx) => {
    const base = raw.trim() || `col_${idx + 1}`
    const count = used.get(base) ?? 0
    used.set(base, count + 1)
    return count === 0 ? base : `${base}_${count + 1}`
  })
}

function extractRowsFromRecords(
  records: Record<string, unknown>[]
): { headers: string[]; rows: unknown[][] } {
  const headerSet = new Set<string>()
  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      headerSet.add(key)
    }
  }
  const headers = Array.from(headerSet)
  const rows = records.map((rec) =>
    headers.map((header) =>
      Object.prototype.hasOwnProperty.call(rec, header) ? rec[header] : undefined
    )
  )
  return { headers, rows }
}

function parseJsonValueToDataset(
  parsed: unknown,
  hasHeaderRow: boolean
): { headers: string[]; rows: unknown[][]; warnings: string[]; hasNamedHeaders: boolean } {
  const warnings: string[] = []

  if (isPlainRecord(parsed)) {
    const { headers, rows } = extractRowsFromRecords([parsed])
    return { headers, rows, warnings, hasNamedHeaders: true }
  }

  if (!Array.isArray(parsed)) {
    throw new Error('JSON import expects an array of objects, an array of arrays, or a single JSON object.')
  }

  if (parsed.length === 0) {
    return { headers: [], rows: [], warnings, hasNamedHeaders: true }
  }

  const allArrays = parsed.every((item) => Array.isArray(item))
  if (allArrays) {
    const matrix = parsed as unknown[][]
    const maxWidth = matrix.reduce((max, row) => Math.max(max, row.length), 0)
    if (hasHeaderRow && matrix.length >= 1) {
      const rawHeaders = Array.from({ length: maxWidth }, (_, idx) => {
        const cell = matrix[0][idx]
        return cell === null || cell === undefined ? '' : String(cell)
      })
      const headers = normalizeSourceHeaders(rawHeaders)
      const rows = matrix.slice(1).map((row) =>
        Array.from({ length: maxWidth }, (_, idx) => (idx < row.length ? row[idx] : undefined))
      )
      return { headers, rows, warnings, hasNamedHeaders: true }
    }
    const headers = Array.from({ length: maxWidth }, (_, idx) => `col_${idx + 1}`)
    const rows = matrix.map((row) =>
      Array.from({ length: maxWidth }, (_, idx) => (idx < row.length ? row[idx] : undefined))
    )
    return { headers, rows, warnings, hasNamedHeaders: false }
  }

  const objectRecords: Record<string, unknown>[] = []
  let skippedNonObjects = 0
  for (const item of parsed) {
    if (isPlainRecord(item)) {
      objectRecords.push(item)
    } else {
      skippedNonObjects++
    }
  }
  if (objectRecords.length === 0) {
    throw new Error('JSON array does not contain object or array rows.')
  }
  if (skippedNonObjects > 0) {
    warnings.push(`Skipped ${skippedNonObjects} non-object item(s) in JSON array.`)
  }
  const { headers, rows } = extractRowsFromRecords(objectRecords)
  return { headers, rows, warnings, hasNamedHeaders: true }
}

/**
 * Parses decoded CSV, TSV, JSON, or NDJSON text into a normalized tabular dataset.
 */
export function parseImportText(
  text: string,
  options: Omit<ImportParseOptions, 'encoding'>
): Omit<ParsedImportDataset, 'resolvedEncoding'> {
  const clean = stripLeadingBom(text)
  if (!clean.trim()) {
    return {
      resolvedFormat: options.format === 'auto' ? 'csv' : options.format,
      resolvedDelimiter: options.format === 'json' || options.format === 'ndjson' ? null : ',',
      hasNamedHeaders: options.hasHeaderRow,
      headers: [],
      rows: [],
      totalRows: 0,
      warnings: [],
    }
  }

  const resolvedFormat: ResolvedImportFormat =
    options.format === 'auto' ? detectImportFormat(clean, options.fileName) : options.format

  if (resolvedFormat === 'json') {
    let parsed: unknown
    try {
      parsed = parseJsonPreservingBigInts(clean)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Invalid JSON syntax: ${msg}`)
    }
    const { headers, rows, warnings, hasNamedHeaders } = parseJsonValueToDataset(
      parsed,
      options.hasHeaderRow
    )
    return {
      resolvedFormat,
      resolvedDelimiter: null,
      hasNamedHeaders,
      headers,
      rows,
      totalRows: rows.length,
      warnings,
    }
  }

  if (resolvedFormat === 'ndjson') {
    const rawLines = clean.split(/\r?\n/)
    const parsedItems: unknown[] = []
    for (let idx = 0; idx < rawLines.length; idx++) {
      const line = rawLines[idx].trim()
      if (!line) continue
      try {
        parsedItems.push(parseJsonPreservingBigInts(line))
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`Invalid NDJSON at line ${idx + 1}: ${msg}`)
      }
    }
    const { headers, rows, warnings, hasNamedHeaders } = parseJsonValueToDataset(parsedItems, false)
    return {
      resolvedFormat,
      resolvedDelimiter: null,
      hasNamedHeaders,
      headers,
      rows,
      totalRows: rows.length,
      warnings,
    }
  }

  const resolvedDelimiter: ImportDelimiter =
    options.delimiter !== 'auto'
      ? options.delimiter
      : resolvedFormat === 'tsv'
        ? '\t'
        : detectImportDelimiter(clean)

  const matrix = parseDelimitedImportText(clean, resolvedDelimiter)
  const maxWidth = matrix.reduce((max, row) => Math.max(max, row.length), 0)
  const warnings: string[] = []
  let headers: string[]
  let dataStartIdx = 0

  if (options.hasHeaderRow) {
    const rawHeaders = Array.from({ length: maxWidth }, (_, idx) => matrix[0][idx] ?? '')
    headers = normalizeSourceHeaders(rawHeaders)
    dataStartIdx = 1
  } else {
    headers = Array.from({ length: maxWidth }, (_, idx) => `col_${idx + 1}`)
  }

  let jaggedCount = 0
  const rows: unknown[][] = []
  for (let r = dataStartIdx; r < matrix.length; r++) {
    const srcRow = matrix[r]
    if (srcRow.length !== maxWidth) {
      jaggedCount++
    }
    const normalizedRow: unknown[] = Array.from({ length: maxWidth }, (_, idx) => {
      if (idx >= srcRow.length) return ''
      return options.trimValues ? srcRow[idx].trim() : srcRow[idx]
    })
    rows.push(normalizedRow)
  }

  if (jaggedCount > 0) {
    warnings.push(`${jaggedCount} row(s) had fewer or more columns than the header and were padded.`)
  }

  return {
    resolvedFormat,
    resolvedDelimiter,
    hasNamedHeaders: options.hasHeaderRow,
    headers,
    rows,
    totalRows: rows.length,
    warnings,
  }
}

/**
 * Decodes raw bytes and parses them according to the given import options.
 */
export function parseImportBytes(
  bytes: Uint8Array,
  options: ImportParseOptions
): ParsedImportDataset {
  const { text, resolvedEncoding } = decodeImportBytes(bytes, options.encoding)
  const parsed = parseImportText(text, {
    format: options.format,
    delimiter: options.delimiter,
    hasHeaderRow: options.hasHeaderRow,
    trimValues: options.trimValues,
    fileName: options.fileName,
  })
  return {
    ...parsed,
    resolvedEncoding,
  }
}

export interface ColumnMappingEntry {
  sourceIndex: number
  sourceName: string
  targetColumn: string | null
}

export interface ImportMappingValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
  mappedCount: number
}

export interface ImportCoercionOptions {
  nullHandling: ImportNullHandling
  trimValues: boolean
  skipEmptyRows?: boolean
}

export interface BuildImportRowsResult {
  rows: Record<string, unknown>[]
  skippedEmptyRows: number
}

const BOOLEAN_COLUMN_TYPE_REGEX =
  /(?:\b(?:BOOL|BOOLEAN)\b|\bTINYINT\s*\(\s*1\s*\)|\bBIT(?:\s*\(\s*1\s*\)|\b(?!\s*\()))/i

function normalizeColumnMatchKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Automatically maps source file columns to target table columns.
 * Priority: exact -> case-insensitive -> normalized alphanumeric -> positional (when !hasHeaderRow).
 * Skips generated columns and prevents duplicate target assignments.
 */
export function autoMapImportColumns(
  sourceHeaders: string[],
  targetColumns: ColumnInfo[],
  hasHeaderRow: boolean
): ColumnMappingEntry[] {
  const mappableCols = targetColumns.filter((col) => col.isGenerated !== true)
  const usedTargets = new Set<string>()

  if (!hasHeaderRow) {
    const positionalTargets = [
      ...mappableCols.filter((col) => !col.isAutoIncrement),
      ...mappableCols.filter((col) => col.isAutoIncrement),
    ]
    return sourceHeaders.map((sourceName, sourceIndex) => {
      const target = positionalTargets[sourceIndex]
      if (!target) {
        return { sourceIndex, sourceName, targetColumn: null }
      }
      usedTargets.add(target.name)
      return { sourceIndex, sourceName, targetColumn: target.name }
    })
  }

  const exactMap = new Map<string, string>()
  const lowerMap = new Map<string, string>()
  const normMap = new Map<string, string>()

  for (const col of mappableCols) {
    exactMap.set(col.name, col.name)
    const lower = col.name.toLowerCase()
    if (!lowerMap.has(lower)) lowerMap.set(lower, col.name)
    const norm = normalizeColumnMatchKey(col.name)
    if (norm && !normMap.has(norm)) normMap.set(norm, col.name)
  }

  const result: ColumnMappingEntry[] = sourceHeaders.map((sourceName, sourceIndex) => ({
    sourceIndex,
    sourceName,
    targetColumn: null,
  }))

  // Pass 1: exact matches
  for (const entry of result) {
    const hit = exactMap.get(entry.sourceName)
    if (hit && !usedTargets.has(hit)) {
      entry.targetColumn = hit
      usedTargets.add(hit)
    }
  }

  // Pass 2: case-insensitive matches
  for (const entry of result) {
    if (entry.targetColumn !== null) continue
    const hit = lowerMap.get(entry.sourceName.trim().toLowerCase())
    if (hit && !usedTargets.has(hit)) {
      entry.targetColumn = hit
      usedTargets.add(hit)
    }
  }

  // Pass 3: normalized alphanumeric matches (e.g. "First Name" -> "first_name")
  for (const entry of result) {
    if (entry.targetColumn !== null) continue
    const norm = normalizeColumnMatchKey(entry.sourceName)
    const hit = norm ? normMap.get(norm) : undefined
    if (hit && !usedTargets.has(hit)) {
      entry.targetColumn = hit
      usedTargets.add(hit)
    }
  }

  return result
}

/**
 * Validates column mappings against the target table schema.
 */
export function validateImportMapping(
  mapping: ColumnMappingEntry[],
  targetColumns: ColumnInfo[]
): ImportMappingValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const colByName = new Map<string, ColumnInfo>()
  for (const col of targetColumns) {
    colByName.set(col.name, col)
  }

  const mappedTargets = new Map<string, number>()
  for (const entry of mapping) {
    if (!entry.targetColumn) continue
    const targetInfo = colByName.get(entry.targetColumn)
    if (!targetInfo) {
      errors.push(`Target column "${entry.targetColumn}" does not exist in table.`)
      continue
    }
    if (targetInfo.isGenerated === true) {
      errors.push(`Cannot import into generated column "${entry.targetColumn}".`)
      continue
    }
    const prevCount = mappedTargets.get(entry.targetColumn) ?? 0
    mappedTargets.set(entry.targetColumn, prevCount + 1)
  }

  for (const [targetName, count] of mappedTargets.entries()) {
    if (count > 1) {
      errors.push(`Duplicate mapping: column "${targetName}" is mapped ${count} times.`)
    }
  }

  const mappedCount = mappedTargets.size
  if (mappedCount === 0) {
    errors.push('Map at least one source column to a target table column.')
  }

  for (const col of targetColumns) {
    const isMapped = mappedTargets.has(col.name)
    if (isMapped && col.isAutoIncrement) {
      warnings.push(
        `Auto-increment column "${col.name}" is mapped — set it to (Skip) if the database should assign IDs.`
      )
    }
    const hasDefault = col.defaultValue !== null && col.defaultValue !== undefined && col.defaultValue !== ''
    if (!isMapped && !col.nullable && !col.isAutoIncrement && !col.isGenerated && !hasDefault) {
      warnings.push(
        `Required NOT NULL column "${col.name}" has no default and is unmapped.`
      )
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    mappedCount,
  }
}

function isNullToken(raw: string, nullHandling: ImportNullHandling): boolean {
  if (nullHandling === 'none') return false
  if (raw === '') {
    return nullHandling === 'empty-and-null' || nullHandling === 'empty-only'
  }
  if (nullHandling === 'empty-and-null' || nullHandling === 'null-literal-only') {
    const upper = raw.trim().toUpperCase()
    return upper === 'NULL' || raw.trim() === '\\N'
  }
  return false
}

/**
 * Coerces a parsed import cell value according to target column type and NULL handling rules.
 */
export function coerceImportCellValue(
  rawValue: unknown,
  targetColumn: ColumnInfo | undefined,
  options: Pick<ImportCoercionOptions, 'nullHandling' | 'trimValues'>
): unknown {
  if (rawValue === null || rawValue === undefined) {
    return null
  }

  if (typeof rawValue === 'object') {
    try {
      return JSON.stringify(rawValue)
    } catch {
      return String(rawValue)
    }
  }

  const colType = targetColumn?.type || targetColumn?.nativeType || ''

  if (typeof rawValue === 'boolean') {
    return rawValue
  }

  if (typeof rawValue === 'number') {
    if (!Number.isFinite(rawValue)) return null
    if (colType && BOOLEAN_COLUMN_TYPE_REGEX.test(colType)) {
      return rawValue !== 0
    }
    return rawValue
  }

  const str = options.trimValues ? String(rawValue).trim() : String(rawValue)
  if (isNullToken(str, options.nullHandling)) {
    return null
  }

  if (colType && BOOLEAN_COLUMN_TYPE_REGEX.test(colType)) {
    const norm = str.trim().toLowerCase()
    if (norm === 'true' || norm === 't' || norm === '1' || norm === 'yes' || norm === 'y') {
      return true
    }
    if (norm === 'false' || norm === 'f' || norm === '0' || norm === 'no' || norm === 'n') {
      return false
    }
  }

  return coerceCellInputValue(str, '', colType || undefined)
}

function isBlankSourceRow(row: unknown[]): boolean {
  for (const cell of row) {
    if (cell === null || cell === undefined) continue
    if (typeof cell === 'string') {
      if (cell.trim() !== '') return false
      continue
    }
    return false
  }
  return true
}

/**
 * Builds plain INSERT records from parsed source rows using the active column mapping.
 */
export function buildMappedImportRecords(
  dataset: Pick<ParsedImportDataset, 'rows'>,
  mapping: ColumnMappingEntry[],
  targetColumns: ColumnInfo[],
  options: ImportCoercionOptions
): BuildImportRowsResult {
  const colByName = new Map<string, ColumnInfo>()
  for (const col of targetColumns) {
    colByName.set(col.name, col)
  }

  const activeMappings = mapping.filter(
    (entry): entry is ColumnMappingEntry & { targetColumn: string } =>
      typeof entry.targetColumn === 'string' && entry.targetColumn.length > 0
  )
  const skipEmptyRows = options.skipEmptyRows !== false
  const rows: Record<string, unknown>[] = []
  let skippedEmptyRows = 0

  for (const srcRow of dataset.rows) {
    if (skipEmptyRows && isBlankSourceRow(srcRow)) {
      skippedEmptyRows++
      continue
    }
    const record: Record<string, unknown> = {}
    for (const entry of activeMappings) {
      const targetCol = colByName.get(entry.targetColumn)
      const rawVal = entry.sourceIndex < srcRow.length ? srcRow[entry.sourceIndex] : undefined
      record[entry.targetColumn] = coerceImportCellValue(rawVal, targetCol, options)
    }
    rows.push(record)
  }

  return { rows, skippedEmptyRows }
}

/**
 * Builds a bounded SQL preview string of INSERT statements using dialect quoting & literals.
 */
export function buildImportPreviewSql(
  records: Record<string, unknown>[],
  options: {
    driver: DatabaseDriverType
    table: string
    schema?: string
    maxStatements?: number
  }
): string {
  if (records.length === 0) {
    return '-- No rows ready to import.'
  }
  const maxStatements = Math.max(1, Math.min(20, options.maxStatements ?? 3))
  const sample = records.slice(0, maxStatements)
  const lines = sample.map(
    (row) =>
      buildInsertStatement({
        driver: options.driver,
        table: options.table,
        schema: options.schema,
        row,
      }).previewSql
  )
  if (records.length > sample.length) {
    lines.push(`-- ... and ${records.length - sample.length} more row(s)`)
  }
  return lines.join('\n')
}
