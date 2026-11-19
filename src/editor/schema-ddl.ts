// src/editor/schema-ddl.ts
// Pure DDL display formatting, SQL token highlighting, and dialect column-type/referential catalogs

import type {
  ColumnInfo,
  DatabaseDriverType,
  ForeignKeyInfo,
  IndexInfo,
  TableDetails,
} from '../protocol.js'
import { splitSqlStatements, type ReferentialAction } from '../drivers/common/sql-tools.js'

export function escapeHtml(val: unknown): string {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export const DDL_KEYWORDS = new Set([
  'CREATE',
  'TABLE',
  'VIEW',
  'UNIQUE',
  'INDEX',
  'ON',
  'PRIMARY',
  'KEY',
  'AUTOINCREMENT',
  'AUTO_INCREMENT',
  'GENERATED',
  'BY',
  'DEFAULT',
  'AS',
  'IDENTITY',
  'NOT',
  'NULL',
  'CONSTRAINT',
  'FOREIGN',
  'REFERENCES',
  'IF',
  'EXISTS',
  'CHECK',
  'ENGINE',
  'ORDER',
  'PARTITION',
  'COLLATE',
])

export const DDL_TYPES = new Set([
  'INTEGER',
  'INT',
  'INT2',
  'INT4',
  'INT8',
  'BIGINT',
  'SMALLINT',
  'TINYINT',
  'TEXT',
  'VARCHAR',
  'CHAR',
  'NVARCHAR',
  'BOOLEAN',
  'BOOL',
  'REAL',
  'FLOAT',
  'FLOAT4',
  'FLOAT8',
  'DOUBLE',
  'NUMERIC',
  'DECIMAL',
  'DATE',
  'TIME',
  'DATETIME',
  'TIMESTAMP',
  'TIMESTAMPTZ',
  'JSON',
  'JSONB',
  'BLOB',
  'BYTEA',
  'UUID',
])

export const DDL_TOKEN_REGEX =
  /(--[^\r\n]*|'(?:''|\\.|[^'])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g

export function appendFormattedDdl(codeEl: HTMLElement, ddlText: string): void {
  let cursor = 0
  DDL_TOKEN_REGEX.lastIndex = 0
  let match: RegExpExecArray | null = DDL_TOKEN_REGEX.exec(ddlText)

  while (match !== null) {
    if (match.index > cursor) {
      const plain = document.createElement('span')
      plain.textContent = ddlText.slice(cursor, match.index)
      codeEl.appendChild(plain)
    }

    const token = match[0]
    const span = document.createElement('span')
    span.textContent = token

    if (token.startsWith('--')) {
      span.className = 'datanoa-ddl-cmt'
    } else if (token.startsWith("'")) {
      span.className = 'datanoa-ddl-str'
    } else if (/^\d/.test(token)) {
      span.className = 'datanoa-ddl-num'
    } else {
      const upper = token.toUpperCase()
      if (DDL_KEYWORDS.has(upper)) {
        span.className = 'datanoa-ddl-kw'
      } else if (DDL_TYPES.has(upper)) {
        span.className = 'datanoa-ddl-type'
      }
    }

    codeEl.appendChild(span)
    cursor = match.index + token.length
    match = DDL_TOKEN_REGEX.exec(ddlText)
  }

  if (cursor < ddlText.length) {
    const tail = document.createElement('span')
    tail.textContent = ddlText.slice(cursor)
    codeEl.appendChild(tail)
  }
}

function findOuterCreateTableParens(stmt: string): { openIdx: number; closeIdx: number } | null {
  const len = stmt.length
  let i = 0
  let openIdx = -1
  let depth = 0

  while (i < len) {
    const ch = stmt[i]
    if (ch === '-' && i + 1 < len && stmt[i + 1] === '-') {
      const nl = stmt.indexOf('\n', i + 2)
      i = nl >= 0 ? nl + 1 : len
      continue
    }
    if (ch === '/' && i + 1 < len && stmt[i + 1] === '*') {
      const end = stmt.indexOf('*/', i + 2)
      i = end >= 0 ? end + 2 : len
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i++
      while (i < len) {
        if (stmt[i] === '\\' && ch === "'") {
          i += 2
          continue
        }
        if (stmt[i] === ch) {
          if (i + 1 < len && stmt[i + 1] === ch) {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '[' && openIdx < 0) {
      const end = stmt.indexOf(']', i + 1)
      i = end >= 0 ? end + 1 : len
      continue
    }
    if (ch === '(') {
      if (depth === 0) {
        openIdx = i
      }
      depth++
    } else if (ch === ')') {
      if (depth > 0) {
        depth--
        if (depth === 0 && openIdx >= 0) {
          return { openIdx, closeIdx: i }
        }
      }
    }
    i++
  }

  return null
}

function splitTopLevelCommas(inner: string): string[] {
  const parts: string[] = []
  const len = inner.length
  let partStart = 0
  let depth = 0
  let i = 0

  while (i < len) {
    const ch = inner[i]
    if (ch === '-' && i + 1 < len && inner[i + 1] === '-') {
      const nl = inner.indexOf('\n', i + 2)
      i = nl >= 0 ? nl + 1 : len
      continue
    }
    if (ch === '/' && i + 1 < len && inner[i + 1] === '*') {
      const end = inner.indexOf('*/', i + 2)
      i = end >= 0 ? end + 2 : len
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i++
      while (i < len) {
        if (inner[i] === '\\' && ch === "'") {
          i += 2
          continue
        }
        if (inner[i] === ch) {
          if (i + 1 < len && inner[i + 1] === ch) {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '(') {
      depth++
    } else if (ch === ')') {
      if (depth > 0) depth--
    } else if (ch === ',' && depth === 0) {
      const item = inner.slice(partStart, i).trim()
      if (item) parts.push(item)
      partStart = i + 1
    }
    i++
  }

  const tail = inner.slice(partStart).trim()
  if (tail) parts.push(tail)
  return parts
}

function formatSingleCreateTableDdl(stmt: string): string {
  const trimmed = stmt.trim()
  if (!/^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\b/i.test(trimmed)) {
    return trimmed
  }
  const parens = findOuterCreateTableParens(trimmed)
  if (!parens) return trimmed

  const inner = trimmed.slice(parens.openIdx + 1, parens.closeIdx)
  const lineCount = inner.split('\n').length
  if (inner.includes('\n') && (inner.length <= 120 || lineCount > 3)) {
    return trimmed
  }

  const items = splitTopLevelCommas(inner)
  if (items.length === 0) return trimmed
  if (!inner.includes('\n') && items.length === 1 && inner.length <= 120) {
    return trimmed
  }

  const head = trimmed.slice(0, parens.openIdx + 1).trimEnd()
  const tail = trimmed.slice(parens.closeIdx).trimStart()
  return `${head}\n  ${items.join(',\n  ')}\n${tail}`
}

/**
 * Formats single-line or dense CREATE TABLE DDL strings onto clean indented multi-line clauses.
 */
export function formatDdlForDisplay(ddl: string, dialect?: DatabaseDriverType): string {
  const trimmed = (ddl || '').trim()
  if (!trimmed) return ''

  const statements = splitSqlStatements(trimmed, dialect)
  if (statements.length <= 1) {
    const formatted = formatSingleCreateTableDdl(trimmed)
    return formatted
  }

  return statements
    .map((slice) => `${formatSingleCreateTableDdl(slice.text)};`)
    .join('\n\n')
}

export const COMMON_COLUMN_TYPES: string[] = [
  'VARCHAR(255)',
  'VARCHAR',
  'TEXT',
  'INTEGER',
  'INT4',
  'BIGINT',
  'INT8',
  'NUMERIC(10,2)',
  'NUMERIC',
  'REAL',
  'BOOLEAN',
  'BOOL',
  'TIMESTAMPTZ',
  'TIMESTAMP',
  'DATETIME',
  'DATE',
  'JSONB',
  'JSON',
  'UUID',
  'BYTEA',
  'BLOB',
]

export const REFERENTIAL_ACTIONS: ReferentialAction[] = [
  'NO ACTION',
  'CASCADE',
  'SET NULL',
  'RESTRICT',
  'SET DEFAULT',
]

export function normalizeTableDetailsForDraft(details: TableDetails): TableDetails {
  const pkSet = new Set(details.primaryKey || [])
  const normalizedCols: ColumnInfo[] = (details.columns || []).map((col) => {
    const typeVal = col.nativeType || col.type || 'TEXT'
    return {
      name: col.name,
      type: col.type || typeVal,
      nativeType: col.nativeType || typeVal,
      nullable: col.nullable !== false,
      defaultValue:
        col.defaultValue !== undefined && col.defaultValue !== null
          ? String(col.defaultValue)
          : null,
      isPrimaryKey: Boolean(col.isPrimaryKey || pkSet.has(col.name)),
      isAutoIncrement: Boolean(col.isAutoIncrement),
      isGenerated: Boolean(col.isGenerated),
    }
  })

  const normalizedIndexes: IndexInfo[] = (details.indexes || []).map((idx) => ({
    name: idx.name,
    columns: Array.isArray(idx.columns) ? [...idx.columns] : [],
    isUnique: Boolean(idx.isUnique),
    isPrimary: Boolean(idx.isPrimary),
  }))

  const normalizedFks: ForeignKeyInfo[] = (details.foreignKeys || []).map((fk) => ({
    constraintName: fk.constraintName || '',
    column: fk.column,
    referencedTable: fk.referencedTable || '',
    referencedColumn: fk.referencedColumn || 'id',
  }))

  return {
    ...details,
    columns: normalizedCols,
    indexes: normalizedIndexes,
    foreignKeys: normalizedFks,
  }
}
