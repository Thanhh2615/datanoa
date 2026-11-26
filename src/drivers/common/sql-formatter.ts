import type { DatabaseDriverType } from '../../protocol'
import { formatSql } from '../../shared-sql-core.js'
import {
  formatSqlLiteral,
  normalizeJsonValue,
  quoteIdentForDialect,
  quoteTableReference,
} from './sql-lexer.js'

export { formatSql }

export type ExportFormat =
  | 'sql-insert'
  | 'sql-update'
  | 'json'
  | 'ndjson'
  | 'csv'
  | 'tsv'
  | 'markdown'

export interface FormatDataExportOptions {
  columns: string[]
  rows: Record<string, unknown>[]
  format: ExportFormat
  tableName?: string
  dialect?: DatabaseDriverType
  primaryKeys?: string[]
}

function formatTabularCellText(value: unknown, nullText: string): string {
  if (value === null || value === undefined) return nullText
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? nullText : value.toISOString()
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'object') {
    return JSON.stringify(normalizeJsonValue(value))
  }
  return String(value)
}

function escapeDelimitedField(text: string, delimiter: ',' | '\t'): string {
  if (
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r')
  ) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function escapeMarkdownCell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>')
}

function assignSafeJsonProp(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  } else {
    target[key] = value
  }
}

function projectRow(columns: string[], row: Record<string, unknown>): Record<string, unknown> {
  if (columns.length === 0) {
    return normalizeJsonValue(row) as Record<string, unknown>
  }
  const out: Record<string, unknown> = {}
  for (const col of columns) {
    assignSafeJsonProp(out, col, normalizeJsonValue(row[col]))
  }
  return out
}

function formatSqlInsertRows(
  columns: string[],
  rows: Record<string, unknown>[],
  tableName: string,
  dialect: DatabaseDriverType
): string {
  if (columns.length === 0 || rows.length === 0) return ''
  const qTable = quoteTableReference(tableName, dialect)
  const qCols = columns.map((c) => quoteIdentForDialect(c, dialect)).join(', ')
  return rows
    .map((row) => {
      const vals = columns.map((c) => formatSqlLiteral(row[c], dialect)).join(', ')
      return `INSERT INTO ${qTable} (${qCols}) VALUES (${vals});`
    })
    .join('\n')
}

function isBlobLikeExportValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true
  if (typeof value === 'string' && /^\[BLOB\s+\d+\s*B\]$/i.test(value.trim())) return true
  if (typeof value === 'object' && 'type' in value && (value as { type?: unknown }).type === 'Buffer') {
    return true
  }
  return false
}

function formatSqlUpdateRows(
  columns: string[],
  rows: Record<string, unknown>[],
  tableName: string,
  dialect: DatabaseDriverType,
  primaryKeys?: string[]
): string {
  if (columns.length === 0 || rows.length === 0) return ''
  const qTable = quoteTableReference(tableName, dialect)
  const explicitPks = primaryKeys && primaryKeys.length > 0 ? primaryKeys : null
  const hasExplicitPk = explicitPks !== null
  const pkCols = explicitPks ?? columns
  const pkSet = new Set(pkCols)
  const nonPkCols = hasExplicitPk ? columns.filter((c) => !pkSet.has(c)) : columns
  const setCols = nonPkCols.length > 0 ? nonPkCols : columns

  const statements = rows.map((row) => {
    const setSql = setCols
      .map((c) => `${quoteIdentForDialect(c, dialect)} = ${formatSqlLiteral(row[c], dialect)}`)
      .join(', ')
    const effectiveWhereCols = hasExplicitPk
      ? pkCols
      : (() => {
          const nonBlob = pkCols.filter((c) => !isBlobLikeExportValue(row[c]))
          return nonBlob.length > 0 ? nonBlob : pkCols
        })()
    const whereSql = effectiveWhereCols
      .map((pk) => {
        const qPk = quoteIdentForDialect(pk, dialect)
        if (hasExplicitPk && !Object.prototype.hasOwnProperty.call(row, pk)) {
          throw new Error(`Missing primary key column "${pk}" in row for SQL UPDATE export.`)
        }
        const pkVal = row[pk]
        if (pkVal === null || pkVal === undefined) {
          return `${qPk} IS NULL`
        }
        return `${qPk} = ${formatSqlLiteral(pkVal, dialect)}`
      })
      .join(' AND ')
    return `UPDATE ${qTable} SET ${setSql} WHERE ${whereSql};`
  })

  if (!hasExplicitPk) {
    return `-- WARNING: Table has no primary key; matching all non-BLOB columns.\n${statements.join('\n')}`
  }
  return statements.join('\n')
}

/**
 * Formats query or table result rows into one of 7 JetBrains Data Extractor formats.
 */
export function formatDataExport(options: FormatDataExportOptions): string {
  const {
    columns,
    rows,
    format,
    tableName = 'table_name',
    dialect = 'postgres',
    primaryKeys,
  } = options

  switch (format) {
    case 'sql-insert':
      return formatSqlInsertRows(columns, rows, tableName, dialect)
    case 'sql-update':
      return formatSqlUpdateRows(columns, rows, tableName, dialect, primaryKeys)
    case 'json': {
      const projected = rows.map((row) => projectRow(columns, row))
      return JSON.stringify(projected, null, 2)
    }
    case 'ndjson':
      return rows.map((row) => JSON.stringify(projectRow(columns, row))).join('\n')
    case 'csv':
    case 'tsv': {
      if (columns.length === 0) return ''
      const delimiter = format === 'csv' ? ',' : '\t'
      const header = columns.map((c) => escapeDelimitedField(c, delimiter)).join(delimiter)
      const body = rows.map((row) =>
        columns
          .map((c) => escapeDelimitedField(formatTabularCellText(row[c], ''), delimiter))
          .join(delimiter)
      )
      return [header, ...body].join('\n')
    }
    case 'markdown': {
      if (columns.length === 0) return ''
      const header = `| ${columns.map((c) => escapeMarkdownCell(c)).join(' | ')} |`
      const sep = `| ${columns.map(() => '---').join(' | ')} |`
      const body = rows.map(
        (row) =>
          `| ${columns
            .map((c) => escapeMarkdownCell(formatTabularCellText(row[c], 'NULL')))
            .join(' | ')} |`
      )
      return [header, sep, ...body].join('\n')
    }
  }
}

/**
 * Formats an array of values as a SQL `IN (...)` tuple or full predicate when `columnName` is supplied.
 */
export function formatSqlInList(
  values: unknown[],
  dialect: DatabaseDriverType,
  options?: { deduplicate?: boolean; columnName?: string }
): string {
  if (!Array.isArray(values) || values.length === 0) return ''

  const deduplicate = options?.deduplicate !== false
  const colName = (options?.columnName ?? '').trim()
  const nonNullLiterals: string[] = []
  const seen = new Set<string>()
  let hasNull = false

  for (const val of values) {
    if (val === null || val === undefined) {
      hasNull = true
      continue
    }
    const lit = formatSqlLiteral(val, dialect)
    if (deduplicate) {
      if (seen.has(lit)) continue
      seen.add(lit)
    }
    nonNullLiterals.push(lit)
  }

  if (colName) {
    const qCol = quoteIdentForDialect(colName, dialect)
    if (nonNullLiterals.length > 0 && hasNull) {
      return `(${qCol} IN (${nonNullLiterals.join(', ')}) OR ${qCol} IS NULL)`
    }
    if (nonNullLiterals.length > 0) {
      return `${qCol} IN (${nonNullLiterals.join(', ')})`
    }
    return `${qCol} IS NULL`
  }

  if (nonNullLiterals.length > 0) {
    return `(${nonNullLiterals.join(', ')})`
  }
  return '(NULL)'
}

/**
 * Exports a rectangular cell matrix into TSV, TSV with headers, CSV, or pretty JSON.
 */
export function formatCellMatrixExport(
  headers: string[],
  matrix: unknown[][],
  format: 'tsv' | 'tsv-headers' | 'csv' | 'json'
): string {
  if (format === 'json') {
    const records = matrix.map((row) => {
      const obj: Record<string, unknown> = {}
      const colCount = Math.max(headers.length, row.length)
      for (let i = 0; i < colCount; i++) {
        const key = headers[i] && headers[i].length > 0 ? headers[i] : `col_${i + 1}`
        assignSafeJsonProp(obj, key, normalizeJsonValue(row[i]))
      }
      return obj
    })
    return JSON.stringify(records, null, 2)
  }

  const delimiter: ',' | '\t' = format === 'csv' ? ',' : '\t'
  const lines: string[] = []
  if ((format === 'tsv-headers' || format === 'csv') && headers.length > 0) {
    lines.push(headers.map((h) => escapeDelimitedField(h, delimiter)).join(delimiter))
  }
  const isSingleCellPlainTsv =
    format === 'tsv' && matrix.length === 1 && matrix[0]?.length === 1
  for (const row of matrix) {
    lines.push(
      row
        .map((cell) => {
          const text = formatTabularCellText(cell, '')
          if (isSingleCellPlainTsv) {
            return text
          }
          return escapeDelimitedField(text, delimiter)
        })
        .join(delimiter)
    )
  }
  return lines.join('\n')
}
