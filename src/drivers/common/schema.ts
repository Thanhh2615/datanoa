import type {
  DatabaseDriverType,
  SchemaObject,
  SchemaObjectKind,
  TableDetails,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
} from '../../protocol'
import {
  isIdentContChar,
  isIdentStartChar,
  isPostgresEscapeStringStart,
  matchDollarQuoteTag,
  quoteIdentForDialect,
  rewriteCockroachViewBodyDatabaseQualifier,
  scanBlockCommentEnd,
  scanLineCommentEnd,
  scanQuotedSegmentEnd,
  usesBackslashAndHash,
} from './sql-lexer.js'

export type QueryExecutor = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

export const DEFAULT_METADATA_CACHE_TTL_MS = 15_000
const MAX_TABLE_DETAILS_CACHE_ENTRIES = 512

function cloneTableDetails(details: TableDetails): TableDetails {
  return {
    ...details,
    columns: details.columns.map((c) => ({ ...c })),
    primaryKey: [...details.primaryKey],
    indexes: details.indexes.map((idx) => ({ ...idx, columns: [...idx.columns] })),
    foreignKeys: details.foreignKeys.map((fk) => ({ ...fk })),
  }
}

/**
 * Short-lived TTL cache for TableDetails metadata to skip redundant
 * multi-PRAGMA and catalog round-trips during pagination, sorting, and filtering.
 */
export class TableDetailsCache {
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly entries = new Map<string, { details: TableDetails; expiresAt: number }>()

  constructor(ttlMs = DEFAULT_METADATA_CACHE_TTL_MS, maxEntries = MAX_TABLE_DETAILS_CACHE_ENTRIES) {
    this.ttlMs = ttlMs
    this.maxEntries = Math.max(1, maxEntries)
  }

  private makeKey(schema: string | undefined, defaultSchema: string, table: string): string {
    const resolvedSchema = schema && schema.trim().length > 0 ? schema.trim() : defaultSchema
    return `${resolvedSchema}:${table}`
  }

  get(schema: string | undefined, defaultSchema: string, table: string): TableDetails | undefined {
    const key = this.makeKey(schema, defaultSchema, table)
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key)
      return undefined
    }
    return cloneTableDetails(entry.details)
  }

  set(
    schema: string | undefined,
    defaultSchema: string,
    table: string,
    details: TableDetails
  ): void {
    const key = this.makeKey(schema, defaultSchema, table)
    if (this.entries.has(key)) {
      this.entries.delete(key)
    } else if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey)
      }
    }
    this.entries.set(key, {
      details: cloneTableDetails(details),
      expiresAt: Date.now() + this.ttlMs,
    })
  }

  invalidateTable(schema: string | undefined, defaultSchema: string, table: string): void {
    const key = this.makeKey(schema, defaultSchema, table)
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  resolveColumnTypes(
    schema: string | undefined,
    defaultSchema: string,
    table: string,
    explicit?: Record<string, string>
  ): Record<string, string> | undefined {
    const cached = this.get(schema, defaultSchema, table)
    if (!cached && !explicit) return undefined
    const merged: Record<string, string> = {}
    if (cached) {
      for (const col of cached.columns) {
        const t = col.nativeType || col.type
        if (t) merged[col.name] = t
      }
    }
    if (explicit) {
      Object.assign(merged, explicit)
    }
    return merged
  }

  findColumnType(
    schema: string | undefined,
    defaultSchema: string,
    table: string,
    column: string,
    explicit?: string
  ): string | undefined {
    if (explicit) return explicit
    const cached = this.get(schema, defaultSchema, table)
    const col = cached?.columns.find((c) => c.name === column)
    return col?.nativeType || col?.type
  }
}

/**
 * Safely coerces SQL driver boolean/bit/numeric flag values (`boolean`, `0|1`, `'0'|'1'`, `'true'|'false'`, `Uint8Array`)
 * without treating `'0'` or `Uint8Array([0])` as truthy.
 */
const SCHEMA_OBJECT_KINDS: readonly SchemaObjectKind[] = [
  'table',
  'view',
  'materialized_view',
  'function',
  'procedure',
  'trigger',
  'sequence',
  'type',
]

function toSchemaObjectKind(value: unknown): SchemaObjectKind {
  return typeof value === 'string' && (SCHEMA_OBJECT_KINDS as readonly string[]).includes(value)
    ? (value as SchemaObjectKind)
    : 'table'
}

export interface SchemaDependencyEndpoint {
  kind: SchemaObjectKind
  name: string
}

export interface SchemaDependencyEdge {
  consumer: SchemaDependencyEndpoint
  prerequisite: SchemaDependencyEndpoint
}

function schemaDependencyKey(kind: SchemaObjectKind, name: string): string {
  return `${kind}\u0000${name}`
}

function toSchemaDependencyEndpoint(
  kindValue: unknown,
  nameValue: unknown
): SchemaDependencyEndpoint | null {
  if (typeof kindValue !== 'string' || typeof nameValue !== 'string' || nameValue.length === 0) {
    return null
  }
  if (!(SCHEMA_OBJECT_KINDS as readonly string[]).includes(kindValue)) return null
  return { kind: kindValue as SchemaObjectKind, name: nameValue }
}

function pushSchemaObject(
  row: Record<string, unknown>,
  sink: SchemaObject[],
  seen: Set<string>,
  fallbackSchema: string
): void {
  const name = typeof row.name === 'string' ? row.name : ''
  if (!name) return
  const kind = toSchemaObjectKind(row.kind)
  const schema =
    typeof row.schema === 'string' && row.schema.length > 0 ? row.schema : fallbackSchema
  const detail =
    typeof row.detail === 'string' && row.detail.length > 0 ? row.detail : undefined
  const key = `${kind}:${schema}:${name}${kind === 'trigger' && detail ? `:${detail}` : ''}`
  if (seen.has(key)) return
  seen.add(key)
  sink.push({ name, schema, kind, ...(detail ? { detail } : {}) })
}

async function collectSchemaObjects(
  query: QueryExecutor,
  sql: string,
  params: unknown[],
  pushRow: (row: Record<string, unknown>) => void
): Promise<void> {
  try {
    const rows = await query(sql, params)
    for (const row of rows) pushRow(row)
  } catch {
    // Restricted permissions, missing catalog support, or older/limited server versions
  }
}

function normalizeDdlSuffix(ddl: string): string {
  const trimmed = ddl.trim()
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`
}

/** Sanitizes a schema/database label into a safe `.sql` export file basename. */
export function sanitizeSchemaFileName(label: string): string {
  const baseName = label.split(/[/\\]/).pop() || ''
  return (
    baseName
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'schema'
  )
}

export function toSqlBool(val: unknown): boolean {
  return (
    val === true ||
    val === 1 ||
    val === 1n ||
    val === '1' ||
    (typeof val === 'string' && val.toLowerCase() === 'true') ||
    (typeof Uint8Array !== 'undefined' && val instanceof Uint8Array && val[0] === 1)
  )
}

// ============================================================================
// 1. SQLite Schema Introspection & Query Templates
// ============================================================================

function sqliteSchemaPrefix(schema?: string): string {
  const trimmed = (schema || 'main').trim()
  if (!trimmed || trimmed.toLowerCase() === 'main') return ''
  return `"${trimmed.replace(/"/g, '""')}".`
}

export const SQLITE_SCHEMA_QUERIES = {
  listObjects: `
    SELECT name, type AS kind, tbl_name
    FROM sqlite_master
    WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC;
  `,
  listObjectsForSchema: (schema = 'main') => `
    SELECT name, type AS kind, tbl_name
    FROM ${sqliteSchemaPrefix(schema)}sqlite_master
    WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC;
  `,
  tableInfo: (table: string, schema = 'main') =>
    `PRAGMA ${sqliteSchemaPrefix(schema)}table_xinfo("${table.replace(/"/g, '""')}");`,
  tableXInfo: (table: string, schema = 'main') =>
    `PRAGMA ${sqliteSchemaPrefix(schema)}table_xinfo("${table.replace(/"/g, '""')}");`,
  foreignKeyList: (table: string, schema = 'main') =>
    `PRAGMA ${sqliteSchemaPrefix(schema)}foreign_key_list("${table.replace(/"/g, '""')}");`,
  indexList: (table: string, schema = 'main') =>
    `PRAGMA ${sqliteSchemaPrefix(schema)}index_list("${table.replace(/"/g, '""')}");`,
  indexInfo: (index: string, schema = 'main') =>
    `PRAGMA ${sqliteSchemaPrefix(schema)}index_info("${index.replace(/"/g, '""')}");`,
  indexXInfo: (index: string, schema = 'main') =>
    `PRAGMA ${sqliteSchemaPrefix(schema)}index_xinfo("${index.replace(/"/g, '""')}");`,
}

const SQLITE_CONFLICT_ACTIONS: ReadonlySet<string> = new Set([
  'ROLLBACK',
  'ABORT',
  'FAIL',
  'IGNORE',
  'REPLACE',
])

const SQLITE_TABLE_CONSTRAINT_STARTS: ReadonlySet<string> = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'UNIQUE',
  'CHECK',
  'FOREIGN',
])

type SqliteDdlClauseToken =
  | { kind: 'ident'; value: string; upper: string; quoted: boolean }
  | { kind: 'parens'; text: string }
  | { kind: 'other' }

function extractSqliteCreateTableBody(tableSql: string): { body: string; tail: string } {
  const len = tableSql.length
  let i = 0
  let openIdx = -1
  let depth = 0

  while (i < len) {
    const ch = tableSql[i]
    if (ch === '-' && i + 1 < len && tableSql[i + 1] === '-') {
      i = scanLineCommentEnd(tableSql, i)
      continue
    }
    if (ch === '/' && i + 1 < len && tableSql[i + 1] === '*') {
      i = scanBlockCommentEnd(tableSql, i, false)
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = scanQuotedSegmentEnd(tableSql, i, ch, false).end
      continue
    }
    if (ch === '[') {
      const closeBracket = tableSql.indexOf(']', i + 1)
      i = closeBracket < 0 ? len : closeBracket + 1
      continue
    }
    if (ch === '(') {
      if (depth === 0) openIdx = i
      depth++
    } else if (ch === ')') {
      depth--
      if (depth === 0 && openIdx >= 0) {
        return {
          body: tableSql.slice(openIdx + 1, i),
          tail: tableSql.slice(i + 1),
        }
      }
    }
    i++
  }
  return { body: '', tail: '' }
}

function stripSqliteComments(sql: string): string {
  const len = sql.length
  let out = ''
  let i = 0
  while (i < len) {
    const ch = sql[i]
    if (ch === '-' && i + 1 < len && sql[i + 1] === '-') {
      i = scanLineCommentEnd(sql, i)
      out += ' '
      continue
    }
    if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
      i = scanBlockCommentEnd(sql, i, false)
      out += ' '
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = scanQuotedSegmentEnd(sql, i, ch, false).end
      out += sql.slice(i, end)
      i = end
      continue
    }
    out += ch
    i++
  }
  return out
}

function extractSqliteIndexWhereClause(indexSql: string): string | undefined {
  const len = indexSql.length
  let i = 0
  let openIdx = -1
  let closeIdx = -1
  let depth = 0

  while (i < len) {
    const ch = indexSql[i]
    if (ch === '-' && i + 1 < len && indexSql[i + 1] === '-') {
      i = scanLineCommentEnd(indexSql, i)
      continue
    }
    if (ch === '/' && i + 1 < len && indexSql[i + 1] === '*') {
      i = scanBlockCommentEnd(indexSql, i, false)
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = scanQuotedSegmentEnd(indexSql, i, ch, false).end
      continue
    }
    if (ch === '[') {
      const cb = indexSql.indexOf(']', i + 1)
      i = cb < 0 ? len : cb + 1
      continue
    }
    if (ch === '(') {
      if (depth === 0) openIdx = i
      depth++
    } else if (ch === ')') {
      depth--
      if (depth === 0 && openIdx >= 0) {
        closeIdx = i
        break
      }
    }
    i++
  }

  if (closeIdx < 0) return undefined
  let pos = closeIdx + 1
  while (pos < len) {
    if (/\s/.test(indexSql[pos])) {
      pos++
      continue
    }
    if (indexSql[pos] === '-' && pos + 1 < len && indexSql[pos + 1] === '-') {
      pos = scanLineCommentEnd(indexSql, pos)
      continue
    }
    if (indexSql[pos] === '/' && pos + 1 < len && indexSql[pos + 1] === '*') {
      pos = scanBlockCommentEnd(indexSql, pos, false)
      continue
    }
    break
  }
  const rest = indexSql.slice(pos)
  const whereMatch = /^WHERE\b\s*([\s\S]+)$/i.exec(rest)
  if (!whereMatch) return undefined
  const predicate = whereMatch[1].replace(/;\s*$/, '').trim()
  return predicate.length > 0 ? predicate : undefined
}

function splitTopLevelSqliteCommas(text: string): string[] {
  const parts: string[] = []
  const len = text.length
  let start = 0
  let depth = 0
  let i = 0

  while (i < len) {
    const ch = text[i]
    if (ch === '-' && i + 1 < len && text[i + 1] === '-') {
      i = scanLineCommentEnd(text, i)
      continue
    }
    if (ch === '/' && i + 1 < len && text[i + 1] === '*') {
      i = scanBlockCommentEnd(text, i, false)
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = scanQuotedSegmentEnd(text, i, ch, false).end
      continue
    }
    if (ch === '[') {
      const closeBracket = text.indexOf(']', i + 1)
      i = closeBracket < 0 ? len : closeBracket + 1
      continue
    }
    if (ch === '(') {
      depth++
    } else if (ch === ')') {
      if (depth > 0) depth--
    } else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
    i++
  }
  if (start < len) {
    parts.push(text.slice(start))
  }
  return parts
}

function tokenizeSqliteDdlClause(clause: string): SqliteDdlClauseToken[] {
  const tokens: SqliteDdlClauseToken[] = []
  const len = clause.length
  let i = 0

  while (i < len) {
    const ch = clause[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '-' && i + 1 < len && clause[i + 1] === '-') {
      i = scanLineCommentEnd(clause, i)
      continue
    }
    if (ch === '/' && i + 1 < len && clause[i + 1] === '*') {
      i = scanBlockCommentEnd(clause, i, false)
      continue
    }
    if (ch === "'") {
      i = scanQuotedSegmentEnd(clause, i, "'", false).end
      tokens.push({ kind: 'other' })
      continue
    }
    if (ch === '"' || ch === '`') {
      const seg = scanQuotedSegmentEnd(clause, i, ch, false)
      const inner = clause.slice(i + 1, seg.closed ? seg.end - 1 : seg.end)
      const value = ch === '"' ? inner.replace(/""/g, '"') : inner.replace(/``/g, '`')
      tokens.push({ kind: 'ident', value, upper: value.toUpperCase(), quoted: true })
      i = seg.end
      continue
    }
    if (ch === '[') {
      const closeBracket = clause.indexOf(']', i + 1)
      const end = closeBracket < 0 ? len : closeBracket + 1
      const value = clause.slice(i + 1, closeBracket < 0 ? len : closeBracket)
      tokens.push({ kind: 'ident', value, upper: value.toUpperCase(), quoted: true })
      i = end
      continue
    }
    if (ch === '(') {
      let depth = 1
      const startInner = i + 1
      let j = i + 1
      while (j < len && depth > 0) {
        const c = clause[j]
        if (c === '-' && j + 1 < len && clause[j + 1] === '-') {
          j = scanLineCommentEnd(clause, j)
          continue
        }
        if (c === '/' && j + 1 < len && clause[j + 1] === '*') {
          j = scanBlockCommentEnd(clause, j, false)
          continue
        }
        if (c === "'" || c === '"' || c === '`') {
          j = scanQuotedSegmentEnd(clause, j, c, false).end
          continue
        }
        if (c === '[') {
          const cb = clause.indexOf(']', j + 1)
          j = cb < 0 ? len : cb + 1
          continue
        }
        if (c === '(') depth++
        else if (c === ')') depth--
        j++
      }
      tokens.push({ kind: 'parens', text: clause.slice(startInner, depth === 0 ? j - 1 : j) })
      i = j
      continue
    }
    if (isIdentStartChar(clause.charCodeAt(i))) {
      let end = i + 1
      while (end < len && isIdentContChar(clause.charCodeAt(end))) end++
      const value = clause.slice(i, end)
      tokens.push({ kind: 'ident', value, upper: value.toUpperCase(), quoted: false })
      i = end
      continue
    }
    tokens.push({ kind: 'other' })
    i++
  }
  return tokens
}

function extractConflictActionAt(tokens: SqliteDdlClauseToken[], startIdx: number): string | undefined {
  const t0 = tokens[startIdx]
  const t1 = tokens[startIdx + 1]
  const t2 = tokens[startIdx + 2]
  if (
    t0?.kind === 'ident' &&
    !t0.quoted &&
    t0.upper === 'ON' &&
    t1?.kind === 'ident' &&
    !t1.quoted &&
    t1.upper === 'CONFLICT' &&
    t2?.kind === 'ident' &&
    !t2.quoted &&
    SQLITE_CONFLICT_ACTIONS.has(t2.upper)
  ) {
    return t2.upper
  }
  return undefined
}

function parseSqliteCreateTableMeta(tableSql: string): {
  columnCollates: Map<string, string>
  uniqueOnConflicts: Array<{ cols: string[]; onConflict: string }>
  autoIncrementColumns: Set<string>
  generatedColumns: Map<string, { expr: string; storage?: 'STORED' | 'VIRTUAL' }>
  checkConstraints: string[]
  withoutRowid: boolean
  strict: boolean
} {
  const columnCollates = new Map<string, string>()
  const uniqueOnConflicts: Array<{ cols: string[]; onConflict: string }> = []
  const autoIncrementColumns = new Set<string>()
  const generatedColumns = new Map<string, { expr: string; storage?: 'STORED' | 'VIRTUAL' }>()
  const checkConstraints: string[] = []
  const { body, tail } = extractSqliteCreateTableBody(tableSql)
  const cleanTail = stripSqliteComments(tail)
  const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(cleanTail)
  const strict = /\bSTRICT\b/i.test(cleanTail)
  if (!body) {
    return {
      columnCollates,
      uniqueOnConflicts,
      autoIncrementColumns,
      generatedColumns,
      checkConstraints,
      withoutRowid,
      strict,
    }
  }

  const quoteConstraintName = (raw: string): string => `"${raw.replace(/"/g, '""')}"`

  for (const rawClause of splitTopLevelSqliteCommas(body)) {
    const tokens = tokenizeSqliteDdlClause(rawClause)
    if (tokens.length === 0) continue

    const first = tokens[0]
    if (first.kind === 'ident' && !first.quoted && SQLITE_TABLE_CONSTRAINT_STARTS.has(first.upper)) {
      let pos = 0
      let constraintName: string | undefined
      if (first.upper === 'CONSTRAINT') {
        if (tokens[1]?.kind === 'ident' && tokens[1].value.trim()) {
          constraintName = tokens[1].value.trim()
        }
        pos = 2
      }
      const kw = tokens[pos]
      const next = tokens[pos + 1]
      if (kw?.kind === 'ident' && !kw.quoted && kw.upper === 'UNIQUE' && next?.kind === 'parens') {
        const cols: string[] = []
        for (const colExpr of splitTopLevelSqliteCommas(next.text)) {
          const exprTokens = tokenizeSqliteDdlClause(colExpr)
          if (exprTokens[0]?.kind === 'ident' && exprTokens[0].value.trim()) {
            cols.push(exprTokens[0].value.trim())
          }
        }
        const action = extractConflictActionAt(tokens, pos + 2)
        if (cols.length > 0 && action) {
          uniqueOnConflicts.push({ cols, onConflict: action })
        }
      } else if (
        kw?.kind === 'ident' &&
        !kw.quoted &&
        kw.upper === 'CHECK' &&
        next?.kind === 'parens'
      ) {
        const expr = next.text.trim()
        if (expr) {
          checkConstraints.push(
            constraintName
              ? `CONSTRAINT ${quoteConstraintName(constraintName)} CHECK (${expr})`
              : `CHECK (${expr})`
          )
        }
      }
      continue
    }

    if (first.kind !== 'ident' || !first.value.trim()) continue
    const colName = first.value.trim()
    for (let j = 1; j < tokens.length; j++) {
      const tok = tokens[j]
      if (tok.kind !== 'ident' || tok.quoted) continue
      if (tok.upper === 'AUTOINCREMENT') {
        autoIncrementColumns.add(colName.toLowerCase())
      } else if (tok.upper === 'AS' && tokens[j + 1]?.kind === 'parens') {
        const exprTok = tokens[j + 1]
        if (exprTok.kind === 'parens') {
          const expr = exprTok.text.trim()
          const storageTok = tokens[j + 2]
          let storage: 'STORED' | 'VIRTUAL' | undefined
          if (
            storageTok?.kind === 'ident' &&
            !storageTok.quoted &&
            (storageTok.upper === 'STORED' || storageTok.upper === 'VIRTUAL')
          ) {
            storage = storageTok.upper
            j += 2
          } else {
            j += 1
          }
          if (expr) {
            generatedColumns.set(colName.toLowerCase(), {
              expr,
              ...(storage ? { storage } : {}),
            })
          }
        }
      } else if (tok.upper === 'CHECK' && tokens[j + 1]?.kind === 'parens') {
        const exprTok = tokens[j + 1]
        if (exprTok.kind === 'parens') {
          const expr = exprTok.text.trim()
          if (expr) {
            const prev2 = tokens[j - 2]
            const prev1 = tokens[j - 1]
            const colConstraintName =
              prev2?.kind === 'ident' &&
              !prev2.quoted &&
              prev2.upper === 'CONSTRAINT' &&
              prev1?.kind === 'ident' &&
              prev1.value.trim()
                ? prev1.value.trim()
                : undefined
            checkConstraints.push(
              colConstraintName
                ? `CONSTRAINT ${quoteConstraintName(colConstraintName)} CHECK (${expr})`
                : `CHECK (${expr})`
            )
          }
          j += 1
        }
      } else if (tok.upper === 'COLLATE') {
        const collTok = tokens[j + 1]
        if (collTok?.kind === 'ident') {
          const coll = collTok.value.trim()
          if (coll && coll.toUpperCase() !== 'BINARY') {
            columnCollates.set(colName.toLowerCase(), coll)
          }
          j += 1
        }
      } else if (tok.upper === 'UNIQUE') {
        const action = extractConflictActionAt(tokens, j + 1)
        if (action) {
          uniqueOnConflicts.push({ cols: [colName], onConflict: action })
          j += 3
        }
      }
    }
  }

  return {
    columnCollates,
    uniqueOnConflicts,
    autoIncrementColumns,
    generatedColumns,
    checkConstraints,
    withoutRowid,
    strict,
  }
}

export async function introspectSqliteObjects(
  query: QueryExecutor,
  schema: string = 'main'
): Promise<SchemaObject[]> {
  const targetSchema = (schema || 'main').trim() || 'main'
  const rows = await query(SQLITE_SCHEMA_QUERIES.listObjectsForSchema(targetSchema))
  return rows.map((r) => {
    const kind = toSchemaObjectKind(r.kind)
    const detail =
      kind === 'trigger' && typeof r.tbl_name === 'string' && r.tbl_name.length > 0
        ? r.tbl_name
        : undefined
    return {
      name: String(r.name),
      schema: targetSchema,
      kind,
      ...(detail ? { detail } : {}),
    }
  })
}

export async function introspectSqliteSchemas(
  query: QueryExecutor
): Promise<{ schemas: string[]; defaultSchema: string }> {
  const rows = await query('PRAGMA database_list;')
  const names = rows.map((r) => String(r.name ?? '')).filter((name) => name.length > 0)
  const ordered = names.includes('main')
    ? ['main', ...names.filter((name) => name !== 'main')]
    : names
  return {
    schemas: ordered.length > 0 ? ordered : ['main'],
    defaultSchema: ordered[0] || 'main',
  }
}

export async function introspectSqliteObjectDdl(
  query: QueryExecutor,
  name: string,
  kind: SchemaObjectKind,
  schema: string = 'main'
): Promise<string> {
  const targetSchema = (schema || 'main').trim() || 'main'
  const masterType = kind === 'trigger' ? 'trigger' : kind === 'view' ? 'view' : 'table'
  const rows = await query(
    `SELECT sql FROM ${sqliteSchemaPrefix(targetSchema)}sqlite_master WHERE type = ? AND name = ?;`,
    [masterType, name]
  )
  const sql = rows[0]?.sql
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new Error(`DDL not found for ${masterType} "${name}" in schema "${targetSchema}".`)
  }
  return normalizeDdlSuffix(sql)
}

export async function introspectSqliteTableDetails(
  query: QueryExecutor,
  table: string,
  schema: string = 'main'
): Promise<TableDetails> {
  const targetSchema = (schema || 'main').trim() || 'main'
  const prefix = sqliteSchemaPrefix(targetSchema)

  // 1. Get Kind & Table DDL (filtered strictly to table/view so index/trigger names cannot collide)
  const masterRows = await query(
    `SELECT type, sql FROM ${prefix}sqlite_master WHERE type IN ('table', 'view') AND name = ?;`,
    [table]
  )
  const master = masterRows[0] || {}
  const kind: 'table' | 'view' = master.type === 'view' ? 'view' : 'table'
  const tableSql = typeof master.sql === 'string' ? master.sql : ''
  const parsedTableMeta = parseSqliteCreateTableMeta(tableSql)
  const isWithoutRowid = parsedTableMeta.withoutRowid
  const isStrict = parsedTableMeta.strict

  // 2. Columns & Primary Keys via PRAGMA table_xinfo (includes generated virtual/stored columns)
  const rawColRows = await query(SQLITE_SCHEMA_QUERIES.tableXInfo(table, targetSchema))
  const colRows = rawColRows.filter((c) => Number(c.hidden ?? 0) !== 1)
  const pkEntries = colRows
    .filter((c) => Number(c.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
  const primaryKey = pkEntries.map((c) => String(c.name))

  const columns: ColumnInfo[] = colRows.map((c) => {
    const colName = String(c.name)
    const isPk = Number(c.pk) > 0
    const hiddenVal = Number(c.hidden ?? 0)
    const isGenerated = hiddenVal === 2 || hiddenVal === 3
    const declaredType = String(c.type || 'TEXT')
      .trim()
      .toUpperCase()
    const isStrictInteger = declaredType === 'INTEGER'
    const isAutoIncrement =
      !isWithoutRowid &&
      !isGenerated &&
      isPk &&
      isStrictInteger &&
      parsedTableMeta.autoIncrementColumns.has(colName.toLowerCase())
    const collate = parsedTableMeta.columnCollates.get(colName.toLowerCase())
    const genMeta = isGenerated ? parsedTableMeta.generatedColumns.get(colName.toLowerCase()) : undefined
    const generatedExpression = genMeta?.expr
    const generatedStorage: 'STORED' | 'VIRTUAL' | undefined = isGenerated
      ? (genMeta?.storage ?? (hiddenVal === 3 ? 'STORED' : 'VIRTUAL'))
      : undefined

    return {
      name: colName,
      type: String(c.type || 'TEXT'),
      nativeType: String(c.type || 'TEXT'),
      nullable: isPk ? false : Number(c.notnull) === 0,
      defaultValue: c.dflt_value !== null && c.dflt_value !== undefined ? String(c.dflt_value) : null,
      isPrimaryKey: isPk,
      isAutoIncrement,
      ...(isGenerated ? { isGenerated: true } : {}),
      ...(generatedExpression ? { generatedExpression } : {}),
      ...(generatedStorage ? { generatedStorage } : {}),
      ...(collate ? { collate } : {}),
    }
  })

  // 3. Foreign Keys via PRAGMA foreign_key_list (resolve omitted fk.to via parent table PK)
  const fkRows = await query(SQLITE_SCHEMA_QUERIES.foreignKeyList(table, targetSchema))
  const parentPkCache = new Map<string, string[]>()
  const resolveParentPrimaryKeys = async (refTable: string): Promise<string[]> => {
    const cached = parentPkCache.get(refTable)
    if (cached) return cached
    try {
      const refCols = await query(SQLITE_SCHEMA_QUERIES.tableXInfo(refTable, targetSchema))
      const pks = refCols
        .filter((c) => Number(c.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((c) => String(c.name))
      parentPkCache.set(refTable, pks)
      return pks
    } catch {
      parentPkCache.set(refTable, [])
      return []
    }
  }

  const fkIdCounts = new Map<number, number>()
  for (const fk of fkRows) {
    const fkId = Number(fk.id ?? 0)
    fkIdCounts.set(fkId, (fkIdCounts.get(fkId) ?? 0) + 1)
  }

  const foreignKeys: ForeignKeyInfo[] = []
  for (const fk of fkRows) {
    const refTable = String(fk.table)
    const fkId = Number(fk.id ?? 0)
    let referencedColumn =
      fk.to !== null && fk.to !== undefined && String(fk.to).trim().length > 0
        ? String(fk.to)
        : ''
    if (!referencedColumn) {
      const parentPks = await resolveParentPrimaryKeys(refTable)
      const seqIdx = Number(fk.seq ?? 0)
      referencedColumn =
        (Number.isInteger(seqIdx) && seqIdx >= 0 ? parentPks[seqIdx] : undefined) ??
        parentPks[0] ??
        ''
    }
    const isComposite = (fkIdCounts.get(fkId) ?? 0) > 1
    const onDelete =
      fk.on_delete !== null && fk.on_delete !== undefined && String(fk.on_delete).trim().length > 0
        ? String(fk.on_delete).trim().toUpperCase()
        : undefined
    const onUpdate =
      fk.on_update !== null && fk.on_update !== undefined && String(fk.on_update).trim().length > 0
        ? String(fk.on_update).trim().toUpperCase()
        : undefined
    foreignKeys.push({
      constraintName: isComposite
        ? `fk_${table}_${fkId}_${refTable}`
        : `fk_${table}_${String(fk.from)}_${refTable}`,
      column: String(fk.from),
      referencedTable: refTable,
      referencedColumn,
      ...(onDelete ? { onDelete } : {}),
      ...(onUpdate ? { onUpdate } : {}),
    })
  }

  // 4. Indexes via PRAGMA index_list & PRAGMA index_xinfo (with fallback to index_info)
  const idxRows = await query(SQLITE_SCHEMA_QUERIES.indexList(table, targetSchema))
  const indexSqlByName = new Map<string, string>()
  try {
    const idxMasterRows = await query(
      `SELECT name, sql FROM ${prefix}sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`,
      [table]
    )
    for (const r of idxMasterRows) {
      if (typeof r.name === 'string' && typeof r.sql === 'string') {
        indexSqlByName.set(r.name, r.sql)
      }
    }
  } catch {
    // Ignore sqlite_master index sql query error on minimal mocks
  }
  const indexes: IndexInfo[] = []
  const remainingUniqueOnConflicts = [...parsedTableMeta.uniqueOnConflicts]

  for (const idx of idxRows) {
    const idxName = String(idx.name)
    let infoRows: Record<string, unknown>[] = []
    let usedXInfo = false
    try {
      infoRows = await query(SQLITE_SCHEMA_QUERIES.indexXInfo(idxName, targetSchema))
      usedXInfo = infoRows.length > 0
    } catch {
      usedXInfo = false
    }
    if (!usedXInfo) {
      infoRows = await query(SQLITE_SCHEMA_QUERIES.indexInfo(idxName, targetSchema))
    }

    const isExpression = infoRows.some(
      (r) => Number(r.cid) === -2 && (!usedXInfo || r.key === undefined || toSqlBool(r.key))
    )
    const partial = toSqlBool(idx.partial)
    const rawIdxSql = indexSqlByName.get(idxName)
    const whereClause = rawIdxSql ? extractSqliteIndexWhereClause(rawIdxSql) : undefined

    const keyRows = infoRows
      .sort((a, b) => Number(a.seqno) - Number(b.seqno))
      .filter((r) => {
        if (usedXInfo && r.key !== undefined && !toSqlBool(r.key)) return false
        return r.name !== null && r.name !== undefined && String(r.name).trim().length > 0
      })

    const colNames = keyRows.map((r) => String(r.name))
    const columnSpecs: Array<{ name: string; collate?: string; desc?: boolean }> = keyRows.map(
      (r) => {
        const rawColl = typeof r.coll === 'string' ? r.coll.trim() : ''
        const collate = rawColl && rawColl.toUpperCase() !== 'BINARY' ? rawColl : undefined
        const desc = toSqlBool(r.desc)
        return {
          name: String(r.name),
          ...(collate ? { collate } : {}),
          ...(desc ? { desc: true } : {}),
        }
      }
    )

    const rawOrigin = typeof idx.origin === 'string' ? idx.origin.trim().toLowerCase() : ''
    const origin: IndexInfo['origin'] =
      rawOrigin === 'pk' || rawOrigin === 'u' || rawOrigin === 'c' ? rawOrigin : undefined

    let onConflict: string | undefined
    if (origin === 'u' && colNames.length > 0) {
      const targetSig = colNames.map((c) => c.toLowerCase()).join('\0')
      const matchIdx = remainingUniqueOnConflicts.findIndex(
        (entry) => entry.cols.map((c) => c.toLowerCase()).join('\0') === targetSig
      )
      if (matchIdx >= 0) {
        onConflict = remainingUniqueOnConflicts[matchIdx].onConflict
        remainingUniqueOnConflicts.splice(matchIdx, 1)
      }
    }

    indexes.push({
      name: idxName,
      isUnique: Number(idx.unique) === 1,
      isPrimary: origin === 'pk' || String(idx.origin) === 'pk',
      columns: colNames,
      ...(origin ? { origin } : {}),
      ...(columnSpecs.length > 0 ? { columnSpecs } : {}),
      ...(onConflict ? { onConflict } : {}),
      ...(partial ? { partial: true } : {}),
      ...(whereClause ? { whereClause } : {}),
      ...(isExpression ? { isExpression: true } : {}),
    })
  }

  // 5. Triggers on this table from sqlite_master
  let triggers: Array<{ name: string; sql: string }> = []
  try {
    const triggerRows = await query(
      `SELECT name, sql FROM ${prefix}sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`,
      [table]
    )
    triggers = triggerRows
      .filter(
        (r) =>
          typeof r.name === 'string' &&
          r.name.trim().length > 0 &&
          typeof r.sql === 'string' &&
          r.sql.trim().length > 0
      )
      .map((r) => ({ name: String(r.name), sql: String(r.sql).trim() }))
  } catch {
    triggers = []
  }

  // 6. Inbound foreign keys referencing this table from other tables in the same schema
  let inboundForeignKeys: Array<{
    fromTable: string
    fromColumn: string
    toColumn: string
    onDelete?: string
  }> = []
  if (kind === 'table') {
    try {
      const refTableRows = await query(
        `SELECT name FROM ${prefix}sqlite_master WHERE type = 'table' AND name != ? AND UPPER(sql) LIKE '%REFERENCES%' ORDER BY name`,
        [table]
      )
      const targetLower = table.toLowerCase()
      for (const row of refTableRows) {
        const otherTable = typeof row.name === 'string' ? row.name : ''
        if (!otherTable) continue
        try {
          const otherFks = await query(SQLITE_SCHEMA_QUERIES.foreignKeyList(otherTable, targetSchema))
          for (const fk of otherFks) {
            if (String(fk.table || '').toLowerCase() !== targetLower) continue
            const fromColumn = String(fk.from || '')
            const seqIdx = Number(fk.seq ?? 0)
            const toColumn =
              fk.to !== null && fk.to !== undefined && String(fk.to).trim().length > 0
                ? String(fk.to)
                : (Number.isInteger(seqIdx) && seqIdx >= 0 ? primaryKey[seqIdx] : undefined) ??
                  primaryKey[0] ??
                  ''
            const onDelete =
              fk.on_delete !== null &&
              fk.on_delete !== undefined &&
              String(fk.on_delete).trim().length > 0
                ? String(fk.on_delete).trim().toUpperCase()
                : undefined
            inboundForeignKeys.push({
              fromTable: otherTable,
              fromColumn,
              toColumn,
              ...(onDelete ? { onDelete } : {}),
            })
          }
        } catch {
          // Ignore per-table pragma failure
        }
      }
    } catch {
      inboundForeignKeys = []
    }
    const targetLower = table.toLowerCase()
    for (const fk of foreignKeys) {
      if (fk.referencedTable.toLowerCase() !== targetLower) continue
      inboundForeignKeys.push({
        fromTable: table,
        fromColumn: fk.column,
        toColumn: fk.referencedColumn,
        ...(fk.onDelete ? { onDelete: fk.onDelete } : {}),
      })
    }
  }

  return {
    name: table,
    schema: targetSchema,
    kind,
    columns,
    primaryKey,
    indexes,
    foreignKeys,
    inboundForeignKeys,
    triggers,
    ...(parsedTableMeta.checkConstraints.length > 0
      ? { checkConstraints: parsedTableMeta.checkConstraints }
      : {}),
    ...(isStrict ? { strict: true } : {}),
    ...(isWithoutRowid ? { withoutRowid: true } : {}),
  }
}

// ============================================================================
// 2. PostgreSQL Schema Introspection & Query Templates
// ============================================================================

export const POSTGRES_SCHEMA_QUERIES = {
  listObjects: (schema = 'public') => `
    SELECT table_name AS name, 
           CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END AS kind,
           table_schema AS schema
    FROM information_schema.tables
    WHERE table_schema = '${schema.replace(/'/g, "''")}'
      AND table_type IN ('BASE TABLE', 'VIEW')
    ORDER BY table_name ASC;
  `,
  columns: (table: string, schema = 'public') => `
    SELECT 
      column_name AS name,
      data_type AS type,
      udt_name AS native_type,
      is_nullable = 'YES' AS nullable,
      column_default AS default_value,
      (is_identity = 'YES' OR column_default LIKE 'nextval(%' OR column_default LIKE '%unique_rowid(%') AS is_auto_increment
    FROM information_schema.columns
    WHERE table_schema = '${schema.replace(/'/g, "''")}' AND table_name = '${table.replace(/'/g, "''")}'
    ORDER BY ordinal_position ASC;
  `,
  primaryKeys: (table: string, schema = 'public') => `
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = '${schema.replace(/'/g, "''")}'
      AND tc.table_name = '${table.replace(/'/g, "''")}'
    ORDER BY kcu.ordinal_position ASC;
  `,
  foreignKeys: (table: string, schema = 'public') => `
    SELECT
      tc.constraint_name,
      kcu.column_name,
      ccu.table_name AS referenced_table,
      ccu.column_name AS referenced_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = '${schema.replace(/'/g, "''")}'
      AND tc.table_name = '${table.replace(/'/g, "''")}';
  `,
  indexes: (table: string, schema = 'public') => `
    SELECT
      indexname AS name,
      indexdef
    FROM pg_indexes
    WHERE schemaname = '${schema.replace(/'/g, "''")}' AND tablename = '${table.replace(/'/g, "''")}';
  `,
}

export async function introspectPostgresObjects(
  query: QueryExecutor,
  schema: string = 'public'
): Promise<SchemaObject[]> {
  const targetSchema = (schema || 'public').trim() || 'public'
  const objects: SchemaObject[] = []
  const seen = new Set<string>()
  const pushRow = (row: Record<string, unknown>) =>
    pushSchemaObject(row, objects, seen, targetSchema)

  const baseRows = await query(
    `
    SELECT 
      table_name AS name,
      table_schema AS schema,
      CASE 
        WHEN table_type = 'VIEW' THEN 'view'
        ELSE 'table'
      END AS kind
    FROM information_schema.tables
    WHERE table_schema = $1
      AND table_type IN ('BASE TABLE', 'VIEW')
    ORDER BY table_name ASC;
  `,
    [targetSchema]
  )
  baseRows.forEach(pushRow)

  const extras = [
    `SELECT matviewname AS name, schemaname AS schema, 'materialized_view' AS kind
       FROM pg_matviews WHERE schemaname = $1 ORDER BY matviewname ASC;`,
    `SELECT DISTINCT t.trigger_name AS name, t.trigger_schema AS schema, 'trigger' AS kind, t.event_object_table AS detail
       FROM information_schema.triggers t WHERE t.trigger_schema = $1
       ORDER BY t.trigger_name ASC, t.event_object_table ASC;`,
    `SELECT t.typname AS name, n.nspname AS schema, 'type' AS kind
       FROM pg_catalog.pg_type t
       JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1 AND t.typtype IN ('e', 'd')
       ORDER BY t.typname ASC;`,
  ]
  for (const sql of extras) {
    await collectSchemaObjects(query, sql, [targetSchema], pushRow)
  }

  let loadedSequences = false
  try {
    const seqRows = await query(
      `SELECT c.relname AS name, n.nspname AS schema, 'sequence' AS kind
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relkind = 'S'
          AND NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_depend d
             WHERE d.classid = 'pg_catalog.pg_class'::regclass
               AND d.objid = c.oid
               AND d.deptype = 'i'
          )
        ORDER BY c.relname ASC;`,
      [targetSchema]
    )
    seqRows.forEach(pushRow)
    loadedSequences = true
  } catch {
    loadedSequences = false
  }
  if (!loadedSequences) {
    await collectSchemaObjects(
      query,
      `SELECT sequence_name AS name, sequence_schema AS schema, 'sequence' AS kind
         FROM information_schema.sequences WHERE sequence_schema = $1 ORDER BY sequence_name ASC;`,
      [targetSchema],
      pushRow
    )
  }

  // Functions & procedures (CockroachDB builds without pg_proc.prokind fall back to proisagg)
  try {
    const rows = await query(
      `SELECT p.proname AS name, n.nspname AS schema,
              CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END AS kind
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
         ORDER BY p.proname ASC;`,
      [targetSchema]
    )
    rows.forEach(pushRow)
  } catch {
    await collectSchemaObjects(
      query,
      `SELECT p.proname AS name, n.nspname AS schema, 'function' AS kind
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND NOT p.proisagg AND NOT p.proiswindow
         ORDER BY p.proname ASC;`,
      [targetSchema],
      pushRow
    )
  }

  return objects.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Reads cross-kind dependency edges for one schema from pg_depend. Read-only and
 * limited to objects that exist in the requested schema; edges with unknown or
 * out-of-schema endpoints are dropped by the caller during assembly.
 */
export async function introspectPostgresSchemaDependencies(
  query: QueryExecutor,
  schema: string = 'public'
): Promise<SchemaDependencyEdge[]> {
  const targetSchema = (schema || 'public').trim() || 'public'
  const rows = await query(
    `
    WITH objects AS (
      SELECT 'pg_catalog.pg_class'::regclass::oid AS class_id, c.oid AS object_id,
             CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view'
               WHEN 'S' THEN 'sequence' ELSE 'table' END AS kind,
             c.relname::text AS name
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('v','m','r','p','S')
      UNION ALL
      SELECT 'pg_catalog.pg_proc'::regclass::oid, p.oid,
             CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END,
             p.proname::text
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.prokind IN ('f','p')
    )
    SELECT DISTINCT consumer.kind AS consumer_kind, consumer.name AS consumer_name,
           prerequisite.kind AS prerequisite_kind, prerequisite.name AS prerequisite_name
      FROM pg_catalog.pg_depend d
      LEFT JOIN pg_catalog.pg_rewrite r
        ON d.classid = 'pg_catalog.pg_rewrite'::regclass AND r.oid = d.objid
      JOIN objects consumer
        ON consumer.class_id = CASE WHEN r.oid IS NULL THEN d.classid
                                    ELSE 'pg_catalog.pg_class'::regclass::oid END
       AND consumer.object_id = COALESCE(r.ev_class, d.objid)
      JOIN objects prerequisite
        ON d.refclassid = prerequisite.class_id AND d.refobjid = prerequisite.object_id
     WHERE d.deptype = 'n'
       AND (consumer.kind, consumer.name) <> (prerequisite.kind, prerequisite.name)
     ORDER BY consumer.kind, consumer.name, prerequisite.kind, prerequisite.name;
  `,
    [targetSchema]
  )

  const edges: SchemaDependencyEdge[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const consumer = toSchemaDependencyEndpoint(row.consumer_kind, row.consumer_name)
    const prerequisite = toSchemaDependencyEndpoint(row.prerequisite_kind, row.prerequisite_name)
    if (!consumer || !prerequisite) continue
    if (consumer.kind === prerequisite.kind && consumer.name === prerequisite.name) continue
    const key = `${schemaDependencyKey(consumer.kind, consumer.name)}\u0001${schemaDependencyKey(
      prerequisite.kind,
      prerequisite.name
    )}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ consumer, prerequisite })
  }
  return edges
}

export async function introspectPostgresSchemas(
  query: QueryExecutor
): Promise<{ schemas: string[]; defaultSchema: string }> {
  const rows = await query(`
    SELECT schema_name AS name
    FROM information_schema.schemata
    WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
      AND schema_name NOT LIKE 'pg_toast%'
      AND schema_name NOT LIKE 'pg_temp%'
    ORDER BY CASE WHEN schema_name = 'public' THEN 0 ELSE 1 END, schema_name ASC;
  `)
  const systemSchemas = new Set(['pg_catalog', 'information_schema'])
  const names = rows
    .map((r) => String(r.name ?? ''))
    .filter(
      (name) =>
        name.length > 0 &&
        !systemSchemas.has(name) &&
        !name.startsWith('pg_toast') &&
        !name.startsWith('pg_temp')
    )
  return {
    schemas: names,
    defaultSchema: names.includes('public') ? 'public' : names[0] || 'public',
  }
}

export async function introspectPostgresObjectDdl(
  query: QueryExecutor,
  name: string,
  kind: SchemaObjectKind,
  schema: string = 'public',
  options?: { sourceDatabase?: string }
): Promise<string> {
  const targetSchema = (schema || 'public').trim() || 'public'
  const qualified = `${quoteIdentForDialect(targetSchema, 'postgres')}.${quoteIdentForDialect(name, 'postgres')}`

  if (kind === 'view' || kind === 'materialized_view') {
    const relkinds = kind === 'view' ? "('v')" : "('m')"
    const rows = await query(
      `SELECT pg_get_viewdef(c.oid, true) AS ddl
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ${relkinds}
         ORDER BY c.oid ASC;`,
      [targetSchema, name]
    )
    const row = rows[0]
    const rawBody = row && typeof row.ddl === 'string' ? row.ddl.trim() : ''
    if (!rawBody) {
      throw new Error(`View definition not found for ${qualified}.`)
    }
    const body =
      options?.sourceDatabase !== undefined
        ? rewriteCockroachViewBodyDatabaseQualifier(rawBody, options.sourceDatabase)
        : rawBody
    const header =
      kind === 'view'
        ? `CREATE VIEW ${qualified} AS`
        : `CREATE MATERIALIZED VIEW ${qualified} AS`
    return normalizeDdlSuffix(`${header}\n${body}`)
  }

  if (kind === 'function' || kind === 'procedure') {
    const prokind = kind === 'function' ? 'f' : 'p'
    const rows = await query(
      `SELECT pg_get_functiondef(p.oid) AS ddl
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = $3
         ORDER BY p.oid ASC;`,
      [targetSchema, name, prokind]
    )
    const ddl = rows
      .map((row) => (typeof row.ddl === 'string' ? row.ddl.trim() : ''))
      .filter((value) => value.length > 0)
      .map((value) => normalizeDdlSuffix(value))
      .join('\n\n')
    if (!ddl) {
      throw new Error(`Function definition not found for ${qualified}.`)
    }
    return ddl
  }

  if (kind === 'trigger') {
    const rows = await query(
      `SELECT pg_get_triggerdef(t.oid) AS ddl
         FROM pg_catalog.pg_trigger t
         JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal
         ORDER BY t.oid ASC;`,
      [targetSchema, name]
    )
    const ddl = rows
      .map((row) => (typeof row.ddl === 'string' ? row.ddl.trim() : ''))
      .filter((value) => value.length > 0)
      .map((value) => normalizeDdlSuffix(value))
      .join('\n\n')
    if (!ddl) {
      throw new Error(`Trigger definition not found for ${qualified}.`)
    }
    return ddl
  }

  if (kind === 'type') {
    const enumRows = await query(
      `SELECT e.enumlabel AS label
         FROM pg_catalog.pg_type t
         JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
         JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = $1 AND t.typname = $2
         ORDER BY e.enumsortorder ASC;`,
      [targetSchema, name]
    )
    if (enumRows.length > 0) {
      const labels = enumRows.map((r) => `'${String(r.label ?? '').replace(/'/g, "''")}'`)
      return `CREATE TYPE ${qualified} AS ENUM (\n  ${labels.join(',\n  ')}\n);`
    }
    const domainRows = await query(
      `SELECT data_type AS data_type, character_maximum_length AS max_length,
              numeric_precision AS precision, numeric_scale AS scale
         FROM information_schema.domains
         WHERE domain_schema = $1 AND domain_name = $2 LIMIT 1;`,
      [targetSchema, name]
    )
    const domain = domainRows[0]
    if (domain && typeof domain.data_type === 'string') {
      let domainType = domain.data_type
      const maxLength = domain.max_length
      if (maxLength !== null && maxLength !== undefined && String(maxLength).length > 0) {
        domainType = `${domainType}(${String(maxLength)})`
      } else if (domain.precision !== null && domain.precision !== undefined) {
        const precision = String(domain.precision)
        const scale = domain.scale !== null && domain.scale !== undefined ? String(domain.scale) : '0'
        domainType = `${domainType}(${precision},${scale})`
      }
      return normalizeDdlSuffix(`CREATE DOMAIN ${qualified} AS ${domainType}`)
    }
    throw new Error(`Type definition not found for ${qualified}.`)
  }

  if (kind === 'sequence') {
    const rows = await query(
      `SELECT sequencename AS name, data_type AS data_type, start_value AS start_value,
              increment_by AS increment_by, min_value AS min_value, max_value AS max_value,
              cycle AS cycle
         FROM pg_catalog.pg_sequences
         WHERE schemaname = $1 AND sequencename = $2 LIMIT 1;`,
      [targetSchema, name]
    )
    const seq = rows[0]
    if (!seq) {
      throw new Error(`Sequence definition not found for ${qualified}.`)
    }
    const parts = [`CREATE SEQUENCE ${qualified}`]
    if (typeof seq.data_type === 'string' && seq.data_type.length > 0) {
      parts.push(`AS ${seq.data_type}`)
    }
    if (seq.start_value !== null && seq.start_value !== undefined) {
      parts.push(`START WITH ${String(seq.start_value)}`)
    }
    if (seq.increment_by !== null && seq.increment_by !== undefined) {
      parts.push(`INCREMENT BY ${String(seq.increment_by)}`)
    }
    if (seq.min_value !== null && seq.min_value !== undefined) {
      parts.push(`MINVALUE ${String(seq.min_value)}`)
    }
    if (seq.max_value !== null && seq.max_value !== undefined) {
      parts.push(`MAXVALUE ${String(seq.max_value)}`)
    }
    if (toSqlBool(seq.cycle)) {
      parts.push('CYCLE')
    }
    return normalizeDdlSuffix(parts.join(' '))
  }

  throw new Error(`Unsupported PostgreSQL object kind: ${kind}.`)
}

export async function introspectPostgresTableDetails(
  query: QueryExecutor,
  table: string,
  schema: string = 'public'
): Promise<TableDetails> {
  const targetSchema = (schema || 'public').trim() || 'public'
  // 1. Object Kind
  const kindSql = `
    SELECT 
      CASE 
        WHEN table_type = 'VIEW' THEN 'view'
        ELSE 'table'
      END AS kind
    FROM information_schema.tables
    WHERE table_schema = $1 AND table_name = $2;
  `
  const kindRows = await query(kindSql, [targetSchema, table])
  let kind: 'table' | 'view' = kindRows[0]?.kind === 'view' ? 'view' : 'table'
  let isMaterializedView = false
  if (kindRows.length === 0) {
    const matviewRows = await query(
      `SELECT c.relkind AS relkind
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'm'
         LIMIT 1;`,
      [targetSchema, table]
    )
    if (matviewRows.length > 0) {
      // Materialized views are read-only for the structure designer
      kind = 'view'
      isMaterializedView = true
    }
  }

  // 2. Primary Keys via information_schema
  const pkSql = `
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = $1
      AND tc.table_name = $2
    ORDER BY kcu.ordinal_position ASC;
  `
  const pkRows = await query(pkSql, [targetSchema, table])
  const primaryKey = pkRows.map((r) => String(r.column_name))

  // 3. Columns via information_schema.columns
  const colSql = `
    SELECT 
      c.column_name AS name,
      CASE 
        WHEN c.character_maximum_length IS NOT NULL 
          THEN c.data_type || '(' || c.character_maximum_length || ')'
        WHEN c.numeric_precision IS NOT NULL AND c.data_type = 'numeric'
          THEN c.data_type || '(' || c.numeric_precision || ',' || coalesce(c.numeric_scale, 0) || ')'
        ELSE c.data_type
      END AS type,
      c.udt_name AS native_type,
      (c.is_nullable = 'YES') AS nullable,
      c.column_default AS default_value,
      (
        c.is_identity = 'YES' 
        OR (
          c.column_default IS NOT NULL
          AND (c.column_default LIKE 'nextval(%' OR c.column_default LIKE '%unique_rowid(%')
        )
      ) AS is_auto_increment
    FROM information_schema.columns c
    WHERE c.table_schema = $1 AND c.table_name = $2
    ORDER BY c.ordinal_position ASC;
  `
  const colRows = isMaterializedView
    ? await query(
        `SELECT a.attname AS name,
                format_type(a.atttypid, a.atttypmod) AS type,
                t.typname AS native_type,
                NOT a.attnotnull AS nullable,
                pg_get_expr(d.adbin, d.adrelid) AS default_value,
                false AS is_auto_increment
           FROM pg_catalog.pg_attribute a
           JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
           LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
           JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
           ORDER BY a.attnum ASC;`,
        [targetSchema, table]
      )
    : await query(colSql, [targetSchema, table])
  const columns: ColumnInfo[] = colRows.map((c) => {
    const colName = String(c.name)
    const defaultValue =
      c.default_value !== null && c.default_value !== undefined ? String(c.default_value) : null
    const isAutoIncrement =
      toSqlBool(c.is_auto_increment) ||
      (defaultValue !== null && /unique_rowid\s*\(/i.test(defaultValue))
    return {
      name: colName,
      type: String(c.type),
      nativeType: String(c.native_type),
      nullable: toSqlBool(c.nullable),
      defaultValue,
      isPrimaryKey: primaryKey.includes(colName),
      isAutoIncrement,
    }
  })

  // 4. Foreign Keys (joined via referential_constraints + position_in_unique_constraint to avoid composite Cartesian product; replaces constraint_column_usage)
  const fkSql = `
    SELECT
      tc.constraint_name,
      kcu.column_name,
      ccu.table_schema AS referenced_schema,
      ccu.table_name AS referenced_table,
      ccu.column_name AS referenced_column,
      rc.delete_rule AS on_delete,
      rc.update_rule AS on_update
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
    JOIN information_schema.referential_constraints AS rc
      ON rc.constraint_name = tc.constraint_name
      AND rc.constraint_schema = tc.table_schema
    JOIN information_schema.key_column_usage AS ccu
      ON ccu.constraint_name = rc.unique_constraint_name
      AND ccu.table_schema = rc.unique_constraint_schema
      AND ccu.ordinal_position = kcu.position_in_unique_constraint
    /* constraint_column_usage */
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = $1
      AND tc.table_name = $2
    ORDER BY tc.constraint_name, kcu.ordinal_position;
  `
  const fkRows = await query(fkSql, [targetSchema, table])
  const foreignKeys: ForeignKeyInfo[] = fkRows.map((fk) => ({
    constraintName: String(fk.constraint_name),
    column: String(fk.column_name),
    referencedTable: String(fk.referenced_table),
    referencedColumn: String(fk.referenced_column),
    ...(fk.referenced_schema ? { referencedSchema: String(fk.referenced_schema) } : {}),
    ...(fk.on_delete ? { onDelete: String(fk.on_delete).toUpperCase() } : {}),
    ...(fk.on_update ? { onUpdate: String(fk.on_update).toUpperCase() } : {}),
  }))

  // 5. Indexes via pg_catalog.pg_index + pg_attribute
  const idxSql = `
    SELECT
      i_cls.relname AS index_name,
      idx.indisunique AS is_unique,
      idx.indisprimary AS is_primary,
      att.attname AS column_name
    FROM pg_catalog.pg_index idx
    JOIN pg_catalog.pg_class t_cls ON t_cls.oid = idx.indrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = t_cls.relnamespace
    JOIN pg_catalog.pg_class i_cls ON i_cls.oid = idx.indexrelid
    JOIN LATERAL unnest(idx.indkey) WITH ORDINALITY AS pos(attnum, ord) ON true
    JOIN pg_catalog.pg_attribute att ON att.attrelid = t_cls.oid AND att.attnum = pos.attnum
    WHERE ns.nspname = $1
      AND t_cls.relname = $2
    ORDER BY i_cls.relname ASC, pos.ord ASC;
  `
  const idxRows = await query(idxSql, [targetSchema, table])
  const indexMap = new Map<string, IndexInfo>()
  for (const r of idxRows) {
    const idxName = String(r.index_name)
    let item = indexMap.get(idxName)
    if (!item) {
      item = {
        name: idxName,
        isUnique: toSqlBool(r.is_unique),
        isPrimary: toSqlBool(r.is_primary),
        columns: [],
      }
      indexMap.set(idxName, item)
    }
    item.columns.push(String(r.column_name))
  }
  const indexes = Array.from(indexMap.values())

  return {
    name: table,
    schema: targetSchema,
    kind,
    columns,
    primaryKey,
    indexes,
    foreignKeys,
  }
}

// ============================================================================
// 3. MySQL Schema Introspection & Query Templates
// ============================================================================

function escapeMysqlSqlLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "''")
}

export const MYSQL_SCHEMA_QUERIES = {
  listObjects: (schema: string) => `
    SELECT TABLE_NAME AS name,
           CASE WHEN TABLE_TYPE = 'VIEW' THEN 'view' ELSE 'table' END AS kind,
           TABLE_SCHEMA AS \`schema\`
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = '${escapeMysqlSqlLiteral(schema)}'
    ORDER BY TABLE_NAME ASC;
  `,
  columns: (table: string, schema: string) => `
    SELECT
      COLUMN_NAME AS name,
      DATA_TYPE AS type,
      COLUMN_TYPE AS native_type,
      IS_NULLABLE = 'YES' AS nullable,
      COLUMN_DEFAULT AS default_value,
      COLUMN_KEY = 'PRI' AS is_primary,
      EXTRA LIKE '%auto_increment%' AS is_auto_increment
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = '${escapeMysqlSqlLiteral(schema)}' AND TABLE_NAME = '${escapeMysqlSqlLiteral(table)}'
    ORDER BY ORDINAL_POSITION ASC;
  `,
  foreignKeys: (table: string, schema: string) => `
    SELECT
      CONSTRAINT_NAME AS constraint_name,
      COLUMN_NAME AS column_name,
      REFERENCED_TABLE_NAME AS referenced_table,
      REFERENCED_COLUMN_NAME AS referenced_column
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = '${escapeMysqlSqlLiteral(schema)}'
      AND TABLE_NAME = '${escapeMysqlSqlLiteral(table)}'
      AND REFERENCED_TABLE_NAME IS NOT NULL;
  `,
  indexes: (table: string, schema: string) => `
    SELECT
      INDEX_NAME AS name,
      NON_UNIQUE = 0 AS is_unique,
      INDEX_NAME = 'PRIMARY' AS is_primary,
      COLUMN_NAME AS column_name,
      SEQ_IN_INDEX AS seq
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = '${escapeMysqlSqlLiteral(schema)}' AND TABLE_NAME = '${escapeMysqlSqlLiteral(table)}'
    ORDER BY INDEX_NAME ASC, SEQ_IN_INDEX ASC;
  `,
}

const MYSQL_SYSTEM_SCHEMAS = ['information_schema', 'performance_schema', 'mysql', 'sys'] as const

function isMysqlSystemSchema(schemaName: string): boolean {
  return (MYSQL_SYSTEM_SCHEMAS as readonly string[]).includes(schemaName.toLowerCase())
}

export async function introspectMysqlObjects(
  query: QueryExecutor,
  schema: string
): Promise<SchemaObject[]> {
  const trimmedSchema = (schema || '').trim()
  const objects: SchemaObject[] = []
  const seen = new Set<string>()
  const pushRow = (row: Record<string, unknown>) =>
    pushSchemaObject(row, objects, seen, trimmedSchema)

  if (!trimmedSchema) {
    const rows = await query(
      `
      SELECT
        table_name AS name,
        table_schema AS \`schema\`,
        CASE
          WHEN table_type = 'VIEW' THEN 'view'
          ELSE 'table'
        END AS kind
      FROM information_schema.tables
      WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
        AND table_type IN ('BASE TABLE', 'VIEW')
      ORDER BY table_schema ASC, table_name ASC;
    `,
      []
    )
    rows.forEach(pushRow)

    await collectSchemaObjects(
      query,
      `SELECT routine_name AS name, routine_schema AS \`schema\`,
              CASE WHEN routine_type = 'PROCEDURE' THEN 'procedure' ELSE 'function' END AS kind
         FROM information_schema.routines
         WHERE routine_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
         ORDER BY routine_schema ASC, routine_name ASC;`,
      [],
      pushRow
    )
    await collectSchemaObjects(
      query,
      `SELECT trigger_name AS name, trigger_schema AS \`schema\`, 'trigger' AS kind,
              event_object_table AS detail
         FROM information_schema.triggers
         WHERE trigger_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
         ORDER BY trigger_schema ASC, trigger_name ASC;`,
      [],
      pushRow
    )
  } else {
    const rows = await query(
      `
      SELECT
        table_name AS name,
        table_schema AS \`schema\`,
        CASE
          WHEN table_type = 'VIEW' THEN 'view'
          ELSE 'table'
        END AS kind
      FROM information_schema.tables
      WHERE table_schema = ?
        AND table_type IN ('BASE TABLE', 'VIEW')
      ORDER BY table_name ASC;
    `,
      [trimmedSchema]
    )
    rows.forEach(pushRow)

    await collectSchemaObjects(
      query,
      `SELECT routine_name AS name, routine_schema AS \`schema\`,
              CASE WHEN routine_type = 'PROCEDURE' THEN 'procedure' ELSE 'function' END AS kind
         FROM information_schema.routines
         WHERE routine_schema = ?
         ORDER BY routine_name ASC;`,
      [trimmedSchema],
      pushRow
    )
    await collectSchemaObjects(
      query,
      `SELECT trigger_name AS name, trigger_schema AS \`schema\`, 'trigger' AS kind,
              event_object_table AS detail
         FROM information_schema.triggers
         WHERE trigger_schema = ?
         ORDER BY trigger_name ASC;`,
      [trimmedSchema],
      pushRow
    )
  }

  return objects.sort((a, b) => a.name.localeCompare(b.name))
}

export async function introspectMysqlSchemas(
  query: QueryExecutor,
  defaultDb: string
): Promise<{ schemas: string[]; defaultSchema: string }> {
  const rows = await query('SHOW DATABASES;', [])
  const current = (defaultDb || '').trim()
  const names: string[] = []
  for (const row of rows) {
    const firstValue = row.Database ?? row.database ?? Object.values(row)[0]
    const name = String(firstValue ?? '').trim()
    if (!name) continue
    if (isMysqlSystemSchema(name) && name !== current) continue
    names.push(name)
  }
  const ordered = current && names.includes(current)
    ? [current, ...names.filter((name) => name !== current)]
    : names
  return {
    schemas: ordered,
    defaultSchema: current || ordered[0] || '',
  }
}

export async function introspectMysqlObjectDdl(
  query: QueryExecutor,
  name: string,
  kind: SchemaObjectKind,
  schema: string
): Promise<string> {
  const targetSchema = (schema || '').trim()
  if (!targetSchema) {
    throw new Error('A database/schema name is required to fetch MySQL object DDL.')
  }
  const qualified = `${quoteIdentForDialect(targetSchema, 'mysql')}.${quoteIdentForDialect(name, 'mysql')}`
  const keyword =
    kind === 'view'
      ? 'VIEW'
      : kind === 'procedure'
        ? 'PROCEDURE'
        : kind === 'function'
          ? 'FUNCTION'
          : kind === 'trigger'
            ? 'TRIGGER'
            : kind === 'table'
              ? 'TABLE'
              : ''
  if (!keyword) {
    throw new Error(`MySQL does not support DDL export for object kind '${kind}'.`)
  }
  const rows = await query(`SHOW CREATE ${keyword} ${qualified};`, [])
  const row = rows[0]
  if (row) {
    const expectedKeys = [`create ${keyword.toLowerCase()}`]
    if (kind === 'trigger') {
      expectedKeys.push('sql original statement')
    }
    for (const [key, value] of Object.entries(row)) {
      if (!expectedKeys.includes(key.toLowerCase())) continue
      if (typeof value === 'string' && value.trim().length > 0) {
        return normalizeDdlSuffix(value)
      }
    }
  }
  throw new Error(`DDL not found for ${keyword} ${qualified}.`)
}

export async function introspectMysqlTableDetails(
  query: QueryExecutor,
  table: string,
  schema: string
): Promise<TableDetails> {
  // 1. Kind
  const kindSql = `
    SELECT 
      CASE 
        WHEN table_type = 'VIEW' THEN 'view'
        ELSE 'table'
      END AS kind
    FROM information_schema.tables
    WHERE table_schema = ? AND table_name = ?;
  `
  const kindRows = await query(kindSql, [schema, table])
  const kind: 'table' | 'view' = kindRows[0]?.kind === 'view' ? 'view' : 'table'

  // 2. Columns (preserve full COLUMN_TYPE including length/enum in both type & nativeType for DDL/drafts)
  const colSql = `
    SELECT 
      column_name AS name,
      column_type AS type,
      column_type AS native_type,
      (is_nullable = 'YES') AS nullable,
      column_default AS default_value,
      (column_key = 'PRI') AS is_primary_key,
      (extra LIKE '%auto_increment%') AS is_auto_increment
    FROM information_schema.columns
    WHERE table_schema = ? AND table_name = ?
    ORDER BY ordinal_position ASC;
  `
  const colRows = await query(colSql, [schema, table])
  const columns: ColumnInfo[] = colRows.map((c) => {
    const colType = String(c.type || '')
    const rawNative = String(c.native_type || '')
    const effectiveNativeType =
      colType.includes('(') && !rawNative.includes('(') ? colType : rawNative || colType
    return {
      name: String(c.name),
      type: colType,
      nativeType: effectiveNativeType,
      nullable: toSqlBool(c.nullable),
      defaultValue: c.default_value !== null && c.default_value !== undefined ? String(c.default_value) : null,
      isPrimaryKey: toSqlBool(c.is_primary_key),
      isAutoIncrement: toSqlBool(c.is_auto_increment),
    }
  })

  // 3. Primary Key
  const pkSql = `
    SELECT column_name AS column_name
    FROM information_schema.key_column_usage
    WHERE table_schema = ? 
      AND table_name = ? 
      AND constraint_name = 'PRIMARY'
    ORDER BY ordinal_position ASC;
  `
  const pkRows = await query(pkSql, [schema, table])
  const primaryKey = pkRows.map((r) => String(r.column_name ?? r.COLUMN_NAME))

  // 4. Foreign Keys (include referential ON DELETE / ON UPDATE actions & cross-schema target)
  const fkSql = `
    SELECT 
      kcu.constraint_name AS constraint_name,
      kcu.column_name AS \`column\`,
      kcu.referenced_table_schema AS referenced_schema,
      kcu.referenced_table_name AS referenced_table,
      kcu.referenced_column_name AS referenced_column,
      rc.delete_rule AS on_delete,
      rc.update_rule AS on_update
    FROM information_schema.key_column_usage kcu
    LEFT JOIN information_schema.referential_constraints rc
      ON rc.constraint_schema = kcu.table_schema
      AND rc.table_name = kcu.table_name
      AND rc.constraint_name = kcu.constraint_name
    WHERE kcu.table_schema = ?
      AND kcu.table_name = ?
      AND kcu.referenced_table_name IS NOT NULL
    ORDER BY kcu.constraint_name ASC, kcu.ordinal_position ASC;
  `
  const fkRows = await query(fkSql, [schema, table])
  const foreignKeys: ForeignKeyInfo[] = fkRows.map((fk) => ({
    constraintName: String(fk.constraint_name),
    column: String(fk.column),
    referencedTable: String(fk.referenced_table),
    referencedColumn: String(fk.referenced_column),
    ...(fk.referenced_schema &&
    String(fk.referenced_schema).toLowerCase() !== schema.toLowerCase()
      ? { referencedSchema: String(fk.referenced_schema) }
      : {}),
    ...(fk.on_delete ? { onDelete: String(fk.on_delete).toUpperCase() } : {}),
    ...(fk.on_update ? { onUpdate: String(fk.on_update).toUpperCase() } : {}),
  }))

  // 5. Indexes
  const idxSql = `
    SELECT 
      index_name AS name,
      (non_unique = 0) AS is_unique,
      (index_name = 'PRIMARY') AS is_primary,
      column_name AS column_name,
      seq_in_index AS seq_in_index
    FROM information_schema.statistics
    WHERE table_schema = ? AND table_name = ?
    ORDER BY index_name ASC, seq_in_index ASC;
  `
  const idxRows = await query(idxSql, [schema, table])
  const indexMap = new Map<string, IndexInfo>()
  for (const r of idxRows) {
    const idxName = String(r.name ?? r.INDEX_NAME)
    let item = indexMap.get(idxName)
    if (!item) {
      item = {
        name: idxName,
        isUnique: toSqlBool(r.is_unique),
        isPrimary: toSqlBool(r.is_primary),
        columns: [],
      }
      indexMap.set(idxName, item)
    }
    item.columns.push(String(r.column_name ?? r.COLUMN_NAME))
  }
  const indexes = Array.from(indexMap.values())

  return {
    name: table,
    schema,
    kind,
    columns,
    primaryKey,
    indexes,
    foreignKeys,
  }
}

// ============================================================================
// 3B. MSSQL (SQL Server) & Oracle Schema Introspection
// ============================================================================

function normalizeMssqlReferentialAction(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const normalized = raw.trim().toUpperCase().replace(/_/g, ' ')
  return normalized.length > 0 ? normalized : undefined
}

function isSingleOuterParenGroup(text: string): boolean {
  if (!text.startsWith('(') || !text.endsWith(')')) return false
  let depth = 0
  let inSingle = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'") {
      if (inSingle && text[i + 1] === "'") {
        i++
        continue
      }
      inSingle = !inSingle
      continue
    }
    if (inSingle) continue
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0 && i < text.length - 1) {
        return false
      }
      if (depth < 0) return false
    }
  }
  return !inSingle && depth === 0
}

export function unwrapMssqlDefaultExpression(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  let text = String(raw).trim()
  if (!text) return null
  while (text.startsWith('(') && text.endsWith(')') && isSingleOuterParenGroup(text)) {
    const inner = text.slice(1, -1).trim()
    if (!inner) break
    text = inner
  }
  return text || null
}

function formatMssqlColumnType(row: Record<string, unknown>): string {
  const baseRaw = String(row.base_type ?? row.system_type ?? 'sql_variant').trim()
  const baseLower = baseRaw.toLowerCase()
  const maxLength = Number(row.max_length ?? 0)
  const precision = Number(row.precision ?? 0)
  const scale = Number(row.scale ?? 0)

  if (baseLower === 'nvarchar' || baseLower === 'nchar') {
    if (maxLength === -1) return `${baseRaw}(MAX)`
    if (maxLength > 0) return `${baseRaw}(${Math.floor(maxLength / 2)})`
  }
  if (
    baseLower === 'varchar' ||
    baseLower === 'char' ||
    baseLower === 'varbinary' ||
    baseLower === 'binary'
  ) {
    if (maxLength === -1) return `${baseRaw}(MAX)`
    if (maxLength > 0) return `${baseRaw}(${maxLength})`
  }
  if (baseLower === 'decimal' || baseLower === 'numeric') {
    if (precision > 0) return `${baseRaw}(${precision},${scale})`
  }
  if (baseLower === 'datetime2' || baseLower === 'datetimeoffset' || baseLower === 'time') {
    if (Number.isFinite(scale) && scale >= 0) return `${baseRaw}(${scale})`
  }
  if (baseLower === 'float' && precision > 0 && precision !== 53) {
    return `${baseRaw}(${precision})`
  }
  return baseRaw
}

export async function introspectMssqlSchemas(
  query: QueryExecutor
): Promise<{ schemas: string[]; defaultSchema: string }> {
  const rows = await query(`
    SELECT name AS name, SCHEMA_NAME() AS default_schema
    FROM sys.schemas
    WHERE name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest')
      AND name NOT LIKE 'db[_]%'
    ORDER BY CASE WHEN name = COALESCE(SCHEMA_NAME(), 'dbo') THEN 0 ELSE 1 END, name ASC;
  `)
  let defaultSchema = 'dbo'
  const schemas: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const def = typeof row.default_schema === 'string' && row.default_schema.trim() ? row.default_schema.trim() : ''
    if (def) defaultSchema = def
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    if (!name || seen.has(name)) continue
    seen.add(name)
    schemas.push(name)
  }
  if (!seen.has(defaultSchema)) {
    schemas.unshift(defaultSchema)
  }
  return {
    schemas: schemas.length > 0 ? schemas : ['dbo'],
    defaultSchema,
  }
}

export async function introspectMssqlObjects(
  query: QueryExecutor,
  schema: string = 'dbo'
): Promise<SchemaObject[]> {
  const targetSchema = (schema || 'dbo').trim() || 'dbo'
  const objects: SchemaObject[] = []
  const seen = new Set<string>()
  const pushRow = (row: Record<string, unknown>) =>
    pushSchemaObject(row, objects, seen, targetSchema)

  const rows = await query(
    `
    SELECT
      o.name AS name,
      s.name AS [schema],
      CASE o.type
        WHEN 'U' THEN 'table'
        WHEN 'V' THEN 'view'
        WHEN 'P' THEN 'procedure'
        WHEN 'FN' THEN 'function'
        WHEN 'IF' THEN 'function'
        WHEN 'TF' THEN 'function'
        WHEN 'FS' THEN 'function'
        WHEN 'FT' THEN 'function'
        WHEN 'TR' THEN 'trigger'
        WHEN 'SO' THEN 'sequence'
        ELSE 'table'
      END AS kind,
      CASE WHEN o.type = 'TR' THEN OBJECT_NAME(o.parent_object_id) ELSE NULL END AS detail
    FROM sys.objects o
    JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE o.is_ms_shipped = 0
      AND s.name = @p1
      AND o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF', 'FS', 'FT', 'TR', 'SO')
    ORDER BY o.name ASC;
  `,
    [targetSchema]
  )
  rows.forEach(pushRow)

  await collectSchemaObjects(
    query,
    `
    SELECT
      t.name AS name,
      s.name AS [schema],
      'type' AS kind
    FROM sys.types t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE t.is_user_defined = 1 AND s.name = @p1
    ORDER BY t.name ASC;
  `,
    [targetSchema],
    pushRow
  )

  return objects.sort((a, b) => a.name.localeCompare(b.name))
}

function buildMssqlCreateTableDdl(params: {
  schema: string
  table: string
  columns: ColumnInfo[]
  computedDefs: Map<string, { definition: string; persisted: boolean }>
  primaryKey: string[]
  indexes: IndexInfo[]
  includedColsByIndex: Map<string, string[]>
  filterDefByIndex: Map<string, string>
  foreignKeys: ForeignKeyInfo[]
  triggers: Array<{ name: string; sql: string }>
}): string {
  const qTable = `${quoteIdentForDialect(params.schema, 'mssql')}.${quoteIdentForDialect(params.table, 'mssql')}`
  const bodyLines: string[] = []

  for (const col of params.columns) {
    const qCol = quoteIdentForDialect(col.name, 'mssql')
    const comp = params.computedDefs.get(col.name)
    if (comp) {
      const persisted = comp.persisted ? ' PERSISTED' : ''
      bodyLines.push(`  ${qCol} AS ${comp.definition}${persisted}`)
      continue
    }
    const parts: string[] = [qCol, col.nativeType || col.type]
    if (col.isAutoIncrement) parts.push('IDENTITY(1,1)')
    parts.push(col.nullable ? 'NULL' : 'NOT NULL')
    if (col.defaultValue !== null && col.defaultValue !== undefined && col.defaultValue !== '') {
      parts.push(`DEFAULT ${col.defaultValue}`)
    }
    bodyLines.push(`  ${parts.join(' ')}`)
  }

  if (params.primaryKey.length > 0) {
    const pkCols = params.primaryKey.map((c) => quoteIdentForDialect(c, 'mssql')).join(', ')
    bodyLines.push(`  PRIMARY KEY (${pkCols})`)
  }

  for (const idx of params.indexes) {
    if (idx.isPrimary || idx.origin !== 'u' || idx.columns.length === 0) continue
    const qCols = idx.columns.map((c) => quoteIdentForDialect(c, 'mssql')).join(', ')
    bodyLines.push(`  CONSTRAINT ${quoteIdentForDialect(idx.name, 'mssql')} UNIQUE (${qCols})`)
  }

  const fkGroups = new Map<
    string,
    { name: string; cols: string[]; refSchema?: string; refTable: string; refCols: string[]; onDelete?: string; onUpdate?: string }
  >()
  for (const fk of params.foreignKeys) {
    const key = fk.constraintName || `${fk.column}->${fk.referencedTable}`
    let g = fkGroups.get(key)
    if (!g) {
      g = {
        name: fk.constraintName,
        cols: [],
        refSchema: fk.referencedSchema,
        refTable: fk.referencedTable,
        refCols: [],
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      }
      fkGroups.set(key, g)
    }
    g.cols.push(fk.column)
    g.refCols.push(fk.referencedColumn)
  }
  for (const g of fkGroups.values()) {
    const localCols = g.cols.map((c) => quoteIdentForDialect(c, 'mssql')).join(', ')
    const refCols = g.refCols.map((c) => quoteIdentForDialect(c, 'mssql')).join(', ')
    const refTable = g.refSchema
      ? `${quoteIdentForDialect(g.refSchema, 'mssql')}.${quoteIdentForDialect(g.refTable, 'mssql')}`
      : quoteIdentForDialect(g.refTable, 'mssql')
    const onDel = g.onDelete && g.onDelete !== 'NO ACTION' ? ` ON DELETE ${g.onDelete}` : ''
    const onUpd = g.onUpdate && g.onUpdate !== 'NO ACTION' ? ` ON UPDATE ${g.onUpdate}` : ''
    bodyLines.push(
      `  CONSTRAINT ${quoteIdentForDialect(g.name, 'mssql')} FOREIGN KEY (${localCols}) REFERENCES ${refTable} (${refCols})${onDel}${onUpd}`
    )
  }

  const stmts: string[] = [`CREATE TABLE ${qTable} (\n${bodyLines.join(',\n')}\n);`]

  for (const idx of params.indexes) {
    if (idx.isPrimary || idx.origin === 'u' || idx.columns.length === 0) continue
    const uniqueKw = idx.isUnique ? 'UNIQUE ' : ''
    const specs: Array<{ name: string; desc?: boolean }> =
      Array.isArray(idx.columnSpecs) && idx.columnSpecs.length > 0
        ? idx.columnSpecs
        : idx.columns.map((name): { name: string; desc?: boolean } => ({ name }))
    const keySql = specs
      .map((s) => `${quoteIdentForDialect(s.name, 'mssql')}${s.desc ? ' DESC' : ''}`)
      .join(', ')
    const incCols = params.includedColsByIndex.get(idx.name) || []
    const incSql =
      incCols.length > 0
        ? ` INCLUDE (${incCols.map((c) => quoteIdentForDialect(c, 'mssql')).join(', ')})`
        : ''
    const filterDef = params.filterDefByIndex.get(idx.name)
    const whereSql = filterDef ? ` WHERE ${filterDef}` : ''
    stmts.push(
      `CREATE ${uniqueKw}INDEX ${quoteIdentForDialect(idx.name, 'mssql')} ON ${qTable} (${keySql})${incSql}${whereSql};`
    )
  }

  for (const trg of params.triggers) {
    const trimmed = trg.sql.trim()
    if (trimmed) {
      stmts.push(trimmed.endsWith(';') ? trimmed : `${trimmed};`)
    }
  }

  return stmts.join('\n\n')
}

export async function introspectMssqlTableDetails(
  query: QueryExecutor,
  table: string,
  schema: string = 'dbo'
): Promise<TableDetails> {
  const targetSchema = (schema || 'dbo').trim() || 'dbo'

  const kindRows = await query(
    `
    SELECT o.type AS obj_type, o.object_id AS object_id
    FROM sys.objects o
    JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE s.name = @p1 AND o.name = @p2 AND o.type IN ('U', 'V');
  `,
    [targetSchema, table]
  )
  const rawObjType = String(kindRows[0]?.obj_type ?? '').trim().toUpperCase()
  const kind: 'table' | 'view' = rawObjType === 'V' ? 'view' : 'table'

  const colRows = await query(
    `
    SELECT
      c.name AS name,
      COALESCE(ut.name, st.name, TYPE_NAME(c.user_type_id), TYPE_NAME(c.system_type_id)) AS base_type,
      st.name AS system_type,
      c.max_length AS max_length,
      c.precision AS precision,
      c.scale AS scale,
      c.is_nullable AS is_nullable,
      c.is_identity AS is_identity,
      c.is_computed AS is_computed,
      c.collation_name AS collation_name,
      dc.definition AS default_value,
      cc.definition AS computed_definition,
      cc.is_persisted AS is_persisted
    FROM sys.columns c
    JOIN sys.objects o ON o.object_id = c.object_id
    JOIN sys.schemas s ON s.schema_id = o.schema_id
    LEFT JOIN sys.types ut ON ut.user_type_id = c.user_type_id
    LEFT JOIN sys.types st ON st.user_type_id = c.system_type_id
    LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
    LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
    WHERE s.name = @p1 AND o.name = @p2
    ORDER BY c.column_id ASC;
  `,
    [targetSchema, table]
  )

  const idxRows = await query(
    `
    SELECT
      i.name AS index_name,
      i.is_unique AS is_unique,
      i.is_primary_key AS is_primary_key,
      i.is_unique_constraint AS is_unique_constraint,
      i.type_desc AS index_type,
      i.filter_definition AS filter_definition,
      c.name AS column_name,
      ic.key_ordinal AS key_ordinal,
      ic.is_descending_key AS is_descending_key,
      ic.is_included_column AS is_included_column
    FROM sys.indexes i
    JOIN sys.objects o ON o.object_id = i.object_id
    JOIN sys.schemas s ON s.schema_id = o.schema_id
    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE s.name = @p1 AND o.name = @p2 AND i.index_id > 0 AND i.is_hypothetical = 0
    ORDER BY i.index_id ASC, ic.is_included_column ASC, ic.key_ordinal ASC, ic.index_column_id ASC;
  `,
    [targetSchema, table]
  )

  interface MssqlIndexGroup {
    name: string
    isUnique: boolean
    isPrimary: boolean
    origin: 'pk' | 'u' | 'c'
    filterDefinition?: string
    keySpecs: Array<{ name: string; desc?: boolean }>
    includedCols: string[]
  }
  const idxGroups = new Map<string, MssqlIndexGroup>()
  for (const r of idxRows) {
    const idxName = String(r.index_name ?? '').trim()
    const colName = String(r.column_name ?? '').trim()
    if (!idxName || !colName) continue
    let group = idxGroups.get(idxName)
    if (!group) {
      const isPrimary = toSqlBool(r.is_primary_key)
      const isUniqueConstraint = toSqlBool(r.is_unique_constraint)
      group = {
        name: idxName,
        isUnique: toSqlBool(r.is_unique) || isPrimary || isUniqueConstraint,
        isPrimary,
        origin: isPrimary ? 'pk' : isUniqueConstraint ? 'u' : 'c',
        filterDefinition:
          typeof r.filter_definition === 'string' && r.filter_definition.trim()
            ? r.filter_definition.trim()
            : undefined,
        keySpecs: [],
        includedCols: [],
      }
      idxGroups.set(idxName, group)
    }
    if (toSqlBool(r.is_included_column)) {
      group.includedCols.push(colName)
    } else {
      group.keySpecs.push({
        name: colName,
        ...(toSqlBool(r.is_descending_key) ? { desc: true } : {}),
      })
    }
  }

  let primaryKey: string[] = []
  const indexes: IndexInfo[] = []
  const includedColsByIndex = new Map<string, string[]>()
  const filterDefByIndex = new Map<string, string>()

  for (const g of idxGroups.values()) {
    const cols = g.keySpecs.map((s) => s.name)
    if (g.isPrimary) {
      primaryKey = cols
    }
    if (g.includedCols.length > 0) {
      includedColsByIndex.set(g.name, g.includedCols)
    }
    if (g.filterDefinition) {
      filterDefByIndex.set(g.name, g.filterDefinition)
    }
    indexes.push({
      name: g.name,
      isUnique: g.isUnique,
      isPrimary: g.isPrimary,
      columns: cols,
      origin: g.origin,
      ...(g.keySpecs.length > 0 ? { columnSpecs: g.keySpecs } : {}),
    })
  }

  const pkSet = new Set(primaryKey)
  const computedDefs = new Map<string, { definition: string; persisted: boolean }>()
  const columns: ColumnInfo[] = colRows.map((c) => {
    const colName = String(c.name)
    const formattedType = formatMssqlColumnType(c)
    const compDef =
      typeof c.computed_definition === 'string' && c.computed_definition.trim()
        ? c.computed_definition.trim()
        : undefined
    const isGenerated = Boolean(compDef) || toSqlBool(c.is_computed)
    if (compDef) {
      computedDefs.set(colName, {
        definition: compDef,
        persisted: toSqlBool(c.is_persisted),
      })
    }
    const collate =
      typeof c.collation_name === 'string' && c.collation_name.trim()
        ? c.collation_name.trim()
        : undefined
    return {
      name: colName,
      type: formattedType,
      nativeType: formattedType,
      nullable: toSqlBool(c.is_nullable),
      defaultValue: unwrapMssqlDefaultExpression(c.default_value),
      isPrimaryKey: pkSet.has(colName),
      isAutoIncrement: toSqlBool(c.is_identity),
      ...(isGenerated ? { isGenerated: true } : {}),
      ...(collate ? { collate } : {}),
    }
  })

  const fkRows = await query(
    `
    SELECT
      fk.name AS constraint_name,
      pc.name AS column_name,
      rs.name AS referenced_schema,
      rt.name AS referenced_table,
      rc.name AS referenced_column,
      fk.delete_referential_action_desc AS on_delete,
      fk.update_referential_action_desc AS on_update
    FROM sys.foreign_keys fk
    JOIN sys.objects pt ON pt.object_id = fk.parent_object_id
    JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
    JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
    JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
    JOIN sys.objects rt ON rt.object_id = fk.referenced_object_id
    JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
    JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
    WHERE ps.name = @p1 AND pt.name = @p2
    ORDER BY fk.name ASC, fkc.constraint_column_id ASC;
  `,
    [targetSchema, table]
  )
  const foreignKeys: ForeignKeyInfo[] = fkRows.map((fk) => {
    const refSchema =
      typeof fk.referenced_schema === 'string' && fk.referenced_schema.trim()
        ? fk.referenced_schema.trim()
        : undefined
    const onDelete = normalizeMssqlReferentialAction(fk.on_delete)
    const onUpdate = normalizeMssqlReferentialAction(fk.on_update)
    return {
      constraintName: String(fk.constraint_name),
      column: String(fk.column_name),
      referencedTable: String(fk.referenced_table),
      referencedColumn: String(fk.referenced_column),
      ...(refSchema ? { referencedSchema: refSchema } : {}),
      ...(onDelete ? { onDelete } : {}),
      ...(onUpdate ? { onUpdate } : {}),
    }
  })

  let inboundForeignKeys: TableDetails['inboundForeignKeys'] = []
  if (kind === 'table') {
    try {
      const inboundRows = await query(
        `
        SELECT
          pt.name AS from_table,
          pc.name AS from_column,
          rc.name AS to_column,
          fk.delete_referential_action_desc AS on_delete
        FROM sys.foreign_keys fk
        JOIN sys.objects pt ON pt.object_id = fk.parent_object_id
        JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
        JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
        JOIN sys.objects rt ON rt.object_id = fk.referenced_object_id
        JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
        JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
        WHERE rs.name = @p1 AND rt.name = @p2
        ORDER BY fk.name ASC, fkc.constraint_column_id ASC;
      `,
        [targetSchema, table]
      )
      inboundForeignKeys = inboundRows.map((r) => {
        const onDelete = normalizeMssqlReferentialAction(r.on_delete)
        return {
          fromTable: String(r.from_table),
          fromColumn: String(r.from_column),
          toColumn: String(r.to_column),
          ...(onDelete ? { onDelete } : {}),
        }
      })
    } catch {
      inboundForeignKeys = []
    }
  }

  let triggers: Array<{ name: string; sql: string }> = []
  if (kind === 'table') {
    try {
      const trgRows = await query(
        `
        SELECT t.name AS name, OBJECT_DEFINITION(t.object_id) AS sql
        FROM sys.triggers t
        JOIN sys.objects o ON o.object_id = t.parent_id
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE s.name = @p1 AND o.name = @p2 AND t.is_ms_shipped = 0
        ORDER BY t.name ASC;
      `,
        [targetSchema, table]
      )
      triggers = trgRows
        .filter((r) => typeof r.name === 'string' && typeof r.sql === 'string' && r.sql.trim().length > 0)
        .map((r) => ({ name: String(r.name), sql: String(r.sql).trim() }))
    } catch {
      triggers = []
    }
  }

  const ddl =
    kind === 'table'
      ? buildMssqlCreateTableDdl({
          schema: targetSchema,
          table,
          columns,
          computedDefs,
          primaryKey,
          indexes,
          includedColsByIndex,
          filterDefByIndex,
          foreignKeys,
          triggers,
        })
      : undefined

  return {
    name: table,
    schema: targetSchema,
    kind,
    columns,
    primaryKey,
    indexes,
    foreignKeys,
    ...(inboundForeignKeys.length > 0 ? { inboundForeignKeys } : {}),
    ...(triggers.length > 0 ? { triggers } : {}),
    ...(ddl ? { ddl } : {}),
  }
}

export async function introspectMssqlObjectDdl(
  query: QueryExecutor,
  name: string,
  kind: SchemaObjectKind,
  schema: string = 'dbo'
): Promise<string> {
  const targetSchema = (schema || 'dbo').trim() || 'dbo'
  const qualified = `${quoteIdentForDialect(targetSchema, 'mssql')}.${quoteIdentForDialect(name, 'mssql')}`

  if (kind === 'view' || kind === 'procedure' || kind === 'function' || kind === 'trigger') {
    const rows = await query(
      `SELECT OBJECT_DEFINITION(OBJECT_ID(@p1)) AS definition;`,
      [qualified]
    )
    const def = rows[0]?.definition
    if (typeof def === 'string' && def.trim().length > 0) {
      return normalizeDdlSuffix(def)
    }
    const modRows = await query(
      `
      SELECT m.definition AS definition
      FROM sys.sql_modules m
      JOIN sys.objects o ON o.object_id = m.object_id
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = @p1 AND o.name = @p2;
    `,
      [targetSchema, name]
    )
    const modDef = modRows[0]?.definition
    if (typeof modDef === 'string' && modDef.trim().length > 0) {
      return normalizeDdlSuffix(modDef)
    }
    throw new Error(`DDL not found for ${kind} ${qualified}.`)
  }

  if (kind === 'sequence') {
    const rows = await query(
      `
      SELECT
        TYPE_NAME(sq.user_type_id) AS data_type,
        sq.start_value AS start_value,
        sq.increment AS increment_by,
        sq.minimum_value AS min_value,
        sq.maximum_value AS max_value,
        sq.is_cycling AS is_cycling
      FROM sys.sequences sq
      JOIN sys.schemas s ON s.schema_id = sq.schema_id
      WHERE s.name = @p1 AND sq.name = @p2;
    `,
      [targetSchema, name]
    )
    const seq = rows[0]
    if (!seq) {
      throw new Error(`Sequence definition not found for ${qualified}.`)
    }
    const parts = [`CREATE SEQUENCE ${qualified}`]
    if (typeof seq.data_type === 'string' && seq.data_type.trim()) {
      parts.push(`AS ${seq.data_type.trim()}`)
    }
    if (seq.start_value !== null && seq.start_value !== undefined) {
      parts.push(`START WITH ${String(seq.start_value)}`)
    }
    if (seq.increment_by !== null && seq.increment_by !== undefined) {
      parts.push(`INCREMENT BY ${String(seq.increment_by)}`)
    }
    if (seq.min_value !== null && seq.min_value !== undefined) {
      parts.push(`MINVALUE ${String(seq.min_value)}`)
    }
    if (seq.max_value !== null && seq.max_value !== undefined) {
      parts.push(`MAXVALUE ${String(seq.max_value)}`)
    }
    parts.push(toSqlBool(seq.is_cycling) ? 'CYCLE' : 'NO CYCLE')
    return normalizeDdlSuffix(parts.join(' '))
  }

  if (kind === 'type') {
    const rows = await query(
      `
      SELECT
        t.is_table_type AS is_table_type,
        TYPE_NAME(t.system_type_id) AS base_type,
        t.max_length AS max_length,
        t.precision AS precision,
        t.scale AS scale,
        t.is_nullable AS is_nullable
      FROM sys.types t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE t.is_user_defined = 1 AND s.name = @p1 AND t.name = @p2;
    `,
      [targetSchema, name]
    )
    const typ = rows[0]
    if (!typ) {
      throw new Error(`Type definition not found for ${qualified}.`)
    }
    if (toSqlBool(typ.is_table_type)) {
      const colRows = await query(
        `
        SELECT
          c.name AS name,
          TYPE_NAME(c.system_type_id) AS base_type,
          c.max_length AS max_length,
          c.precision AS precision,
          c.scale AS scale,
          c.is_nullable AS is_nullable
        FROM sys.table_types tt
        JOIN sys.schemas s ON s.schema_id = tt.schema_id
        JOIN sys.columns c ON c.object_id = tt.type_table_object_id
        WHERE s.name = @p1 AND tt.name = @p2
        ORDER BY c.column_id ASC;
      `,
        [targetSchema, name]
      )
      const colDefs = colRows.map((c) => {
        const dt = formatMssqlColumnType(c)
        return `  ${quoteIdentForDialect(String(c.name), 'mssql')} ${dt} ${toSqlBool(c.is_nullable) ? 'NULL' : 'NOT NULL'}`
      })
      return `CREATE TYPE ${qualified} AS TABLE (\n${colDefs.join(',\n')}\n);`
    }
    const baseType = formatMssqlColumnType(typ)
    const nullStr = toSqlBool(typ.is_nullable) ? 'NULL' : 'NOT NULL'
    return `CREATE TYPE ${qualified} FROM ${baseType} ${nullStr};`
  }

  throw new Error(`Unsupported SQL Server object kind: ${kind}.`)
}

// ============================================================================
// 3B. Oracle Schema Introspection
// ============================================================================

function getOracleRowValue(row: Record<string, unknown>, key: string): unknown {
  if (key in row) return row[key]
  const upper = key.toUpperCase()
  if (upper in row) return row[upper]
  const lower = key.toLowerCase()
  if (lower in row) return row[lower]
  return undefined
}

function getOracleRowString(row: Record<string, unknown>, key: string): string {
  const val = getOracleRowValue(row, key)
  return val === null || val === undefined ? '' : String(val).trim()
}

function formatOracleColumnType(row: Record<string, unknown>): string {
  const baseRaw = getOracleRowString(row, 'data_type') || 'VARCHAR2'
  const baseUpper = baseRaw.toUpperCase()
  const dataLength = Number(getOracleRowValue(row, 'data_length') ?? 0)
  const charLength = Number(getOracleRowValue(row, 'char_length') ?? 0)
  const charUsed = getOracleRowString(row, 'char_used').toUpperCase()
  const rawPrecision = getOracleRowValue(row, 'data_precision')
  const rawScale = getOracleRowValue(row, 'data_scale')
  const hasPrecision = rawPrecision !== null && rawPrecision !== undefined && rawPrecision !== ''
  const hasScale = rawScale !== null && rawScale !== undefined && rawScale !== ''
  const precision = hasPrecision ? Number(rawPrecision) : NaN
  const scale = hasScale ? Number(rawScale) : NaN

  if (baseUpper === 'NUMBER') {
    if (Number.isFinite(precision) && precision > 0) {
      if (Number.isFinite(scale) && scale !== 0) {
        return `NUMBER(${precision},${scale})`
      }
      return `NUMBER(${precision})`
    }
    return 'NUMBER'
  }
  if (
    baseUpper === 'VARCHAR2' ||
    baseUpper === 'NVARCHAR2' ||
    baseUpper === 'CHAR' ||
    baseUpper === 'NCHAR'
  ) {
    const len = Number.isFinite(charLength) && charLength > 0 ? charLength : dataLength
    if (Number.isFinite(len) && len > 0) {
      const unitSuffix = charUsed === 'C' && (baseUpper === 'VARCHAR2' || baseUpper === 'CHAR') ? ' CHAR' : ''
      return `${baseRaw}(${len}${unitSuffix})`
    }
    return baseRaw
  }
  if (baseUpper === 'RAW' && Number.isFinite(dataLength) && dataLength > 0) {
    return `RAW(${dataLength})`
  }
  if (baseUpper === 'FLOAT' && Number.isFinite(precision) && precision > 0 && precision !== 126) {
    return `FLOAT(${precision})`
  }
  return baseRaw
}

function normalizeOracleSchemaName(schema: string | undefined, fallback: string = 'SYSTEM'): string {
  const raw = (schema || '').trim()
  if (!raw) return fallback.toUpperCase()
  return raw === raw.toLowerCase() ? raw.toUpperCase() : raw
}

function mapOracleObjectType(rawType: string): SchemaObjectKind | null {
  const upper = rawType.trim().toUpperCase()
  if (upper === 'TABLE') return 'table'
  if (upper === 'VIEW') return 'view'
  if (upper === 'MATERIALIZED VIEW') return 'materialized_view'
  if (upper === 'PROCEDURE') return 'procedure'
  if (upper === 'FUNCTION') return 'function'
  if (upper === 'TRIGGER') return 'trigger'
  if (upper === 'SEQUENCE') return 'sequence'
  if (upper === 'TYPE') return 'type'
  return null
}

const ORACLE_METADATA_KIND_MAP: Readonly<Record<SchemaObjectKind, string>> = {
  table: 'TABLE',
  view: 'VIEW',
  materialized_view: 'MATERIALIZED_VIEW',
  procedure: 'PROCEDURE',
  function: 'FUNCTION',
  trigger: 'TRIGGER',
  sequence: 'SEQUENCE',
  type: 'TYPE',
}

function mapKindToDbmsMetadataType(kind: SchemaObjectKind): string {
  return ORACLE_METADATA_KIND_MAP[kind]
}

export async function introspectOracleSchemas(
  query: QueryExecutor,
  defaultSchemaOverride?: string
): Promise<{ schemas: string[]; defaultSchema: string }> {
  let currentUser = ''
  try {
    const userRows = await query('SELECT USER AS "current_user" FROM DUAL')
    if (userRows[0]) {
      currentUser = getOracleRowString(userRows[0], 'current_user')
    }
  } catch {
    // Ignore current-user query failure and rely on default override
  }

  const defaultSchema = normalizeOracleSchemaName(defaultSchemaOverride || currentUser, 'SYSTEM')
  const rows = await query('SELECT username AS "name" FROM all_users ORDER BY username ASC')
  const schemas: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const name = getOracleRowString(row, 'name') || getOracleRowString(row, 'username')
    if (!name || seen.has(name)) continue
    seen.add(name)
    schemas.push(name)
  }
  if (defaultSchema && !seen.has(defaultSchema)) {
    schemas.unshift(defaultSchema)
  }
  return {
    schemas: schemas.length > 0 ? schemas : [defaultSchema],
    defaultSchema,
  }
}

export async function introspectOracleObjects(
  query: QueryExecutor,
  schema: string = 'SYSTEM'
): Promise<SchemaObject[]> {
  const targetOwner = normalizeOracleSchemaName(schema)
  const rows = await query(
    `
    SELECT
      object_name AS "name",
      owner AS "schema",
      object_type AS "object_type"
    FROM all_objects
    WHERE owner = :p1
      AND object_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'SEQUENCE', 'TYPE')
      AND object_name NOT LIKE 'BIN$%'
    ORDER BY object_name ASC
  `,
    [targetOwner]
  )

  const objects: SchemaObject[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const name = getOracleRowString(row, 'name') || getOracleRowString(row, 'object_name')
    if (!name) continue
    const rawKind = getOracleRowString(row, 'object_type') || getOracleRowString(row, 'kind')
    const kind = mapOracleObjectType(rawKind)
    if (!kind) continue
    const ownerName = getOracleRowString(row, 'schema') || getOracleRowString(row, 'owner') || targetOwner
    const key = `${kind}:${ownerName}:${name}`
    if (seen.has(key)) continue
    seen.add(key)
    objects.push({ name, schema: ownerName, kind })
  }
  return objects.sort((a, b) => a.name.localeCompare(b.name))
}

function buildOracleCreateTableDdl(params: {
  schema: string
  table: string
  columns: ColumnInfo[]
  primaryKey: string[]
  indexes: IndexInfo[]
  foreignKeys: ForeignKeyInfo[]
  triggers: Array<{ name: string; sql: string }>
}): string {
  const qTable = `${quoteIdentForDialect(params.schema, 'oracle')}.${quoteIdentForDialect(params.table, 'oracle')}`
  const bodyLines: string[] = []

  for (const col of params.columns) {
    const qCol = quoteIdentForDialect(col.name, 'oracle')
    const parts: string[] = [qCol, col.nativeType || col.type]
    if (col.isAutoIncrement) parts.push('GENERATED BY DEFAULT AS IDENTITY')
    if (
      !col.isAutoIncrement &&
      col.defaultValue !== null &&
      col.defaultValue !== undefined &&
      col.defaultValue !== ''
    ) {
      parts.push(`DEFAULT ${col.defaultValue}`)
    }
    if (!col.nullable) parts.push('NOT NULL')
    bodyLines.push(`  ${parts.join(' ')}`)
  }

  if (params.primaryKey.length > 0) {
    const pkCols = params.primaryKey.map((c) => quoteIdentForDialect(c, 'oracle')).join(', ')
    bodyLines.push(`  PRIMARY KEY (${pkCols})`)
  }

  for (const idx of params.indexes) {
    if (idx.isPrimary || idx.origin !== 'u' || idx.columns.length === 0) continue
    const qCols = idx.columns.map((c) => quoteIdentForDialect(c, 'oracle')).join(', ')
    bodyLines.push(`  CONSTRAINT ${quoteIdentForDialect(idx.name, 'oracle')} UNIQUE (${qCols})`)
  }

  const fkGroups = new Map<
    string,
    { name: string; cols: string[]; refSchema?: string; refTable: string; refCols: string[]; onDelete?: string }
  >()
  for (const fk of params.foreignKeys) {
    const key = fk.constraintName || `${fk.column}->${fk.referencedTable}`
    let g = fkGroups.get(key)
    if (!g) {
      g = {
        name: fk.constraintName,
        cols: [],
        refSchema: fk.referencedSchema,
        refTable: fk.referencedTable,
        refCols: [],
        onDelete: fk.onDelete,
      }
      fkGroups.set(key, g)
    }
    g.cols.push(fk.column)
    g.refCols.push(fk.referencedColumn)
  }
  for (const g of fkGroups.values()) {
    const qCols = g.cols.map((c) => quoteIdentForDialect(c, 'oracle')).join(', ')
    const qRefTable = g.refSchema
      ? `${quoteIdentForDialect(g.refSchema, 'oracle')}.${quoteIdentForDialect(g.refTable, 'oracle')}`
      : quoteIdentForDialect(g.refTable, 'oracle')
    const qRefCols = g.refCols.map((c) => quoteIdentForDialect(c, 'oracle')).join(', ')
    let clause = `  CONSTRAINT ${quoteIdentForDialect(g.name || 'fk_ref', 'oracle')} FOREIGN KEY (${qCols}) REFERENCES ${qRefTable} (${qRefCols})`
    if (g.onDelete && g.onDelete !== 'NO ACTION') {
      clause += ` ON DELETE ${g.onDelete}`
    }
    bodyLines.push(clause)
  }

  const stmts: string[] = [`CREATE TABLE ${qTable} (\n${bodyLines.join(',\n')}\n);`]
  for (const idx of params.indexes) {
    if (idx.isPrimary || idx.origin === 'u' || idx.columns.length === 0) continue
    const uniqueKw = idx.isUnique ? 'UNIQUE ' : ''
    const specs: Array<{ name: string; desc?: boolean }> = idx.columnSpecs?.length
      ? idx.columnSpecs
      : idx.columns.map((c): { name: string; desc?: boolean } => ({ name: c }))
    const qCols = specs
      .map((s) => `${quoteIdentForDialect(s.name, 'oracle')}${s.desc ? ' DESC' : ''}`)
      .join(', ')
    stmts.push(
      `CREATE ${uniqueKw}INDEX ${quoteIdentForDialect(params.schema, 'oracle')}.${quoteIdentForDialect(idx.name, 'oracle')} ON ${qTable} (${qCols});`
    )
  }
  for (const trg of params.triggers) {
    const trimmed = trg.sql.trim()
    if (trimmed) {
      stmts.push(trimmed)
    }
  }
  return stmts.join('\n\n')
}

export async function introspectOracleTableDetails(
  query: QueryExecutor,
  table: string,
  schema: string = 'SYSTEM'
): Promise<TableDetails> {
  const targetOwner = normalizeOracleSchemaName(schema)
  const targetTable = table.trim()

  const kindRows = await query(
    `
    SELECT object_type AS "object_type"
    FROM all_objects
    WHERE owner = :p1 AND object_name = :p2 AND object_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW')
  `,
    [targetOwner, targetTable]
  )
  const rawType = kindRows[0] ? getOracleRowString(kindRows[0], 'object_type').toUpperCase() : 'TABLE'
  const detailObjectKind: SchemaObjectKind =
    rawType === 'VIEW'
      ? 'view'
      : rawType === 'MATERIALIZED VIEW'
        ? 'materialized_view'
        : 'table'
  const kind: 'table' | 'view' =
    detailObjectKind === 'view' || detailObjectKind === 'materialized_view' ? 'view' : 'table'

  const colRows = await query(
    `
    SELECT
      column_name AS "column_name",
      data_type AS "data_type",
      data_length AS "data_length",
      char_length AS "char_length",
      char_used AS "char_used",
      data_precision AS "data_precision",
      data_scale AS "data_scale",
      nullable AS "nullable",
      data_default AS "data_default",
      identity_column AS "identity_column"
    FROM all_tab_columns
    WHERE owner = :p1 AND table_name = :p2
    ORDER BY column_id ASC
  `,
    [targetOwner, targetTable]
  )

  const virtualCols = new Set<string>()
  try {
    const vRows = await query(
      `
      SELECT column_name AS "column_name", virtual_column AS "virtual_column"
      FROM all_tab_cols
      WHERE owner = :p1 AND table_name = :p2 AND hidden_column = 'NO' AND virtual_column = 'YES'
    `,
      [targetOwner, targetTable]
    )
    for (const vr of vRows) {
      if (getOracleRowString(vr, 'virtual_column').toUpperCase() === 'YES') {
        const cname = getOracleRowString(vr, 'column_name')
        if (cname) virtualCols.add(cname)
      }
    }
  } catch {
    // Ignore privilege/mock fallback on ALL_TAB_COLS
  }

  const pkRows = await query(
    `
    SELECT acc.column_name AS "column_name", ac.constraint_name AS "constraint_name"
    FROM all_constraints ac
    JOIN all_cons_columns acc
      ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name AND acc.table_name = ac.table_name
    WHERE ac.owner = :p1 AND ac.table_name = :p2 AND ac.constraint_type = 'P'
    ORDER BY acc.position ASC
  `,
    [targetOwner, targetTable]
  )
  const primaryKey: string[] = []
  let pkConstraintName = ''
  for (const r of pkRows) {
    const col = getOracleRowString(r, 'column_name')
    const cname = getOracleRowString(r, 'constraint_name')
    if (cname && !pkConstraintName) pkConstraintName = cname
    if (col && !primaryKey.includes(col)) primaryKey.push(col)
  }
  const pkSet = new Set<string>(primaryKey)

  const columns: ColumnInfo[] = colRows.map((r) => {
    const name = getOracleRowString(r, 'column_name')
    const dataType = formatOracleColumnType(r)
    const nullableStr = getOracleRowString(r, 'nullable').toUpperCase()
    const rawDefault = getOracleRowValue(r, 'data_default')
    const rawDefaultStr =
      rawDefault !== null && rawDefault !== undefined ? String(rawDefault).trim() : ''
    const isIdentity = getOracleRowString(r, 'identity_column').toUpperCase() === 'YES'
    const isSystemIdentityDefault =
      isIdentity && /\.?"?ISEQ\$\$_\d+"?\.nextval$/i.test(rawDefaultStr)
    const defaultValue = !isSystemIdentityDefault && rawDefaultStr ? rawDefaultStr : null
    const isVirtual =
      virtualCols.has(name) || getOracleRowString(r, 'virtual_column').toUpperCase() === 'YES'
    return {
      name,
      type: dataType,
      nativeType: dataType,
      nullable: nullableStr !== 'N',
      defaultValue,
      isPrimaryKey: pkSet.has(name),
      isAutoIncrement: isIdentity,
      ...(isVirtual ? { isGenerated: true } : {}),
    }
  })

  const uniqueConstraintNames = new Set<string>()
  try {
    const uqRows = await query(
      `
      SELECT constraint_name AS "constraint_name"
      FROM all_constraints
      WHERE owner = :p1 AND table_name = :p2 AND constraint_type = 'U'
    `,
      [targetOwner, targetTable]
    )
    for (const ur of uqRows) {
      const uname = getOracleRowString(ur, 'constraint_name')
      if (uname) uniqueConstraintNames.add(uname)
    }
  } catch {
    // Ignore optional unique-constraint lookup error
  }

  const idxRows = await query(
    `
    SELECT
      i.index_name AS "index_name",
      i.uniqueness AS "uniqueness",
      i.index_type AS "index_type",
      ic.column_name AS "column_name",
      ic.descend AS "descend",
      ic.column_position AS "column_position"
    FROM all_indexes i
    JOIN all_ind_columns ic
      ON ic.index_owner = i.owner AND ic.index_name = i.index_name
    WHERE i.table_owner = :p1 AND i.table_name = :p2
    ORDER BY i.index_name ASC, ic.column_position ASC
  `,
    [targetOwner, targetTable]
  )

  const idxGroups = new Map<
    string,
    { name: string; unique: boolean; isPrimary: boolean; origin: 'pk' | 'u' | 'c'; specs: Array<{ name: string; desc?: boolean }> }
  >()
  for (const r of idxRows) {
    const idxName = getOracleRowString(r, 'index_name')
    const colName = getOracleRowString(r, 'column_name')
    if (!idxName || !colName) continue
    let group = idxGroups.get(idxName)
    if (!group) {
      const isPrimary = Boolean(pkConstraintName && idxName === pkConstraintName)
      const isUniqueConstraint = uniqueConstraintNames.has(idxName)
      const isUnique = getOracleRowString(r, 'uniqueness').toUpperCase() === 'UNIQUE'
      group = {
        name: idxName,
        unique: isUnique,
        isPrimary,
        origin: isPrimary ? 'pk' : isUniqueConstraint ? 'u' : 'c',
        specs: [],
      }
      idxGroups.set(idxName, group)
    }
    const isDesc = getOracleRowString(r, 'descend').toUpperCase() === 'DESC'
    group.specs.push({ name: colName, ...(isDesc ? { desc: true } : {}) })
  }

  const indexes: IndexInfo[] = []
  for (const g of idxGroups.values()) {
    indexes.push({
      name: g.name,
      isUnique: g.unique,
      isPrimary: g.isPrimary,
      origin: g.origin,
      columns: g.specs.map((s) => s.name),
      ...(g.specs.some((s) => s.desc) ? { columnSpecs: g.specs } : {}),
    })
  }

  const fkRows = await query(
    `
    SELECT
      ac.constraint_name AS "constraint_name",
      acc.column_name AS "column_name",
      ac.r_owner AS "referenced_schema",
      rc.table_name AS "referenced_table",
      rcc.column_name AS "referenced_column",
      ac.delete_rule AS "on_delete"
    FROM all_constraints ac
    JOIN all_cons_columns acc
      ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name AND acc.table_name = ac.table_name
    JOIN all_constraints rc
      ON rc.owner = ac.r_owner AND rc.constraint_name = ac.r_constraint_name
    JOIN all_cons_columns rcc
      ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = acc.position
    WHERE ac.owner = :p1 AND ac.table_name = :p2 AND ac.constraint_type = 'R'
    ORDER BY ac.constraint_name ASC, acc.position ASC
  `,
    [targetOwner, targetTable]
  )
  const foreignKeys: ForeignKeyInfo[] = fkRows.map((r) => ({
    constraintName: getOracleRowString(r, 'constraint_name') || 'fk_ref',
    column: getOracleRowString(r, 'column_name'),
    referencedSchema: getOracleRowString(r, 'referenced_schema') || undefined,
    referencedTable: getOracleRowString(r, 'referenced_table'),
    referencedColumn: getOracleRowString(r, 'referenced_column'),
    onDelete: getOracleRowString(r, 'on_delete') || undefined,
  }))

  let inboundForeignKeys: TableDetails['inboundForeignKeys']
  try {
    const inRows = await query(
      `
      SELECT
        ac.owner AS "from_schema",
        ac.table_name AS "from_table",
        acc.column_name AS "from_column",
        rcc.column_name AS "to_column",
        ac.delete_rule AS "on_delete"
      FROM all_constraints ac
      JOIN all_cons_columns acc
        ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name AND acc.table_name = ac.table_name
      JOIN all_constraints rc
        ON rc.owner = ac.r_owner AND rc.constraint_name = ac.r_constraint_name
      JOIN all_cons_columns rcc
        ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = acc.position
      WHERE rc.owner = :p1 AND rc.table_name = :p2 AND ac.constraint_type = 'R'
      ORDER BY ac.table_name ASC, acc.position ASC
    `,
      [targetOwner, targetTable]
    )
    if (inRows.length > 0) {
      inboundForeignKeys = inRows.map((r) => ({
        fromTable: getOracleRowString(r, 'from_table'),
        fromColumn: getOracleRowString(r, 'from_column'),
        toColumn: getOracleRowString(r, 'to_column'),
        onDelete: getOracleRowString(r, 'on_delete') || undefined,
      }))
    }
  } catch {
    // Optional inbound FK query
  }

  let triggers: Array<{ name: string; sql: string }> = []
  if (kind === 'table') {
    try {
      const trgRows = await query(
        `
        SELECT
          owner AS "trigger_owner",
          trigger_name AS "trigger_name",
          description AS "description",
          when_clause AS "when_clause",
          trigger_body AS "trigger_body"
        FROM all_triggers
        WHERE table_owner = :p1 AND table_name = :p2
        ORDER BY trigger_name ASC
      `,
        [targetOwner, targetTable]
      )
      triggers = trgRows
        .map((r) => {
          const name = getOracleRowString(r, 'trigger_name')
          const desc = getOracleRowString(r, 'description')
          const whenClause = getOracleRowString(r, 'when_clause')
          const body = getOracleRowString(r, 'trigger_body')
          if (!name || !body) return null
          const header = desc || `${quoteIdentForDialect(targetOwner, 'oracle')}.${quoteIdentForDialect(name, 'oracle')} ON ${quoteIdentForDialect(targetOwner, 'oracle')}.${quoteIdentForDialect(targetTable, 'oracle')}`
          const whenPart = whenClause ? `\nWHEN (${whenClause})` : ''
          return {
            name,
            sql: `CREATE OR REPLACE TRIGGER ${header}${whenPart}\n${body}`,
          }
        })
        .filter((x): x is { name: string; sql: string } => x !== null)
    } catch {
      // Optional trigger lookup
    }
  }

  const ddl =
    detailObjectKind === 'table'
      ? buildOracleCreateTableDdl({
          schema: targetOwner,
          table: targetTable,
          columns,
          primaryKey,
          indexes,
          foreignKeys,
          triggers,
        })
      : await introspectOracleObjectDdl(query, targetTable, detailObjectKind, targetOwner).catch(() => '')

  return {
    name: targetTable,
    schema: targetOwner,
    kind,
    columns,
    primaryKey,
    indexes,
    foreignKeys,
    ...(inboundForeignKeys ? { inboundForeignKeys } : {}),
    ...(triggers.length > 0 ? { triggers } : {}),
    ddl,
  }
}

export async function introspectOracleObjectDdl(
  query: QueryExecutor,
  name: string,
  kind: SchemaObjectKind,
  schema: string = 'SYSTEM'
): Promise<string> {
  const targetOwner = normalizeOracleSchemaName(schema)
  const targetName = name.trim()
  const qualified = `${quoteIdentForDialect(targetOwner, 'oracle')}.${quoteIdentForDialect(targetName, 'oracle')}`

  try {
    const metadataType = mapKindToDbmsMetadataType(kind)
    const rows = await query(
      `SELECT DBMS_METADATA.GET_DDL(:p1, :p2, :p3) AS "ddl" FROM DUAL`,
      [metadataType, targetName, targetOwner]
    )
    const rawDdl = rows[0] ? getOracleRowString(rows[0], 'ddl') : ''
    if (rawDdl) {
      return normalizeDdlSuffix(rawDdl)
    }
  } catch {
    // Fall back to catalog dictionary reconstruction when DBMS_METADATA is unavailable/restricted
  }

  if (kind === 'table') {
    const details = await introspectOracleTableDetails(query, targetName, targetOwner)
    return details.ddl || ''
  }

  if (kind === 'view') {
    const rows = await query(
      'SELECT text AS "text" FROM all_views WHERE owner = :p1 AND view_name = :p2',
      [targetOwner, targetName]
    )
    const viewSql = rows[0] ? getOracleRowString(rows[0], 'text') : ''
    if (!viewSql) throw new Error(`View definition not found for ${qualified}.`)
    return normalizeDdlSuffix(`CREATE OR REPLACE VIEW ${qualified} AS\n${viewSql}`)
  }

  if (kind === 'materialized_view') {
    const rows = await query(
      'SELECT query AS "query" FROM all_mviews WHERE owner = :p1 AND mview_name = :p2',
      [targetOwner, targetName]
    )
    const mviewSql = rows[0] ? getOracleRowString(rows[0], 'query') : ''
    if (!mviewSql) throw new Error(`Materialized view definition not found for ${qualified}.`)
    return normalizeDdlSuffix(`CREATE MATERIALIZED VIEW ${qualified} AS\n${mviewSql}`)
  }

  if (kind === 'procedure' || kind === 'function' || kind === 'type') {
    const oraType = kind.toUpperCase()
    const rows = await query(
      `
      SELECT text AS "text"
      FROM all_source
      WHERE owner = :p1 AND name = :p2 AND type = :p3
      ORDER BY line ASC
    `,
      [targetOwner, targetName, oraType]
    )
    const body = rows.map((r) => String(getOracleRowValue(r, 'text') ?? '')).join('').trim()
    if (!body) throw new Error(`${oraType} definition not found for ${qualified}.`)
    const withPrefix = /^\s*CREATE\b/i.test(body) ? body : `CREATE OR REPLACE ${body}`
    return normalizeDdlSuffix(withPrefix)
  }

  if (kind === 'trigger') {
    const rows = await query(
      `
      SELECT description AS "description", when_clause AS "when_clause", trigger_body AS "trigger_body"
      FROM all_triggers
      WHERE owner = :p1 AND trigger_name = :p2
    `,
      [targetOwner, targetName]
    )
    const r = rows[0]
    if (!r) throw new Error(`Trigger definition not found for ${qualified}.`)
    const desc = getOracleRowString(r, 'description') || qualified
    const whenClause = getOracleRowString(r, 'when_clause')
    const body = getOracleRowString(r, 'trigger_body')
    return normalizeDdlSuffix(
      `CREATE OR REPLACE TRIGGER ${desc}${whenClause ? `\nWHEN (${whenClause})` : ''}\n${body}`
    )
  }

  if (kind === 'sequence') {
    const rows = await query(
      `
      SELECT min_value AS "min_value", max_value AS "max_value", increment_by AS "increment_by", cycle_flag AS "cycle_flag", cache_size AS "cache_size"
      FROM all_sequences
      WHERE sequence_owner = :p1 AND sequence_name = :p2
    `,
      [targetOwner, targetName]
    )
    const seq = rows[0]
    if (!seq) throw new Error(`Sequence definition not found for ${qualified}.`)
    const parts = [`CREATE SEQUENCE ${qualified}`]
    const inc = getOracleRowValue(seq, 'increment_by')
    const minVal = getOracleRowValue(seq, 'min_value')
    const maxVal = getOracleRowValue(seq, 'max_value')
    const cacheSize = getOracleRowValue(seq, 'cache_size')
    if (inc !== null && inc !== undefined) parts.push(`INCREMENT BY ${String(inc)}`)
    if (minVal !== null && minVal !== undefined) parts.push(`MINVALUE ${String(minVal)}`)
    if (maxVal !== null && maxVal !== undefined) parts.push(`MAXVALUE ${String(maxVal)}`)
    parts.push(getOracleRowString(seq, 'cycle_flag').toUpperCase() === 'Y' ? 'CYCLE' : 'NOCYCLE')
    if (cacheSize !== null && cacheSize !== undefined && Number(cacheSize) > 0) {
      parts.push(`CACHE ${String(cacheSize)}`)
    } else {
      parts.push('NOCACHE')
    }
    return normalizeDdlSuffix(parts.join(' '))
  }

  throw new Error(`Unsupported Oracle object kind: ${kind}.`)
}

// ============================================================================
// 4. Full Schema DDL Export Assembly
// ============================================================================

const SCHEMA_DDL_KIND_ORDER: readonly SchemaObjectKind[] = [
  'type',
  'sequence',
  'table',
  'view',
  'materialized_view',
  'function',
  'procedure',
  'trigger',
]

interface SchemaDdlSection {
  kind: SchemaObjectKind
  name: string
  ddl: string
  failed?: boolean
  dependsOn?: string[]
}

interface DdlToken {
  text: string
  kind: 'word' | 'ident' | 'punct'
}

function tokenizeDdlForDeps(ddl: string, dialect: DatabaseDriverType): DdlToken[] {
  const tokens: DdlToken[] = []
  const len = ddl.length
  const backslashAndHash = usesBackslashAndHash(dialect)
  let i = 0
  while (i < len) {
    const ch = ddl[i]
    if (ch === '-' && i + 1 < len && ddl[i + 1] === '-') {
      i = scanLineCommentEnd(ddl, i)
      continue
    }
    if (ch === '#' && backslashAndHash) {
      let j = i + 1
      while (j < len && ddl[j] !== '\n') j++
      i = j < len ? j + 1 : len
      continue
    }
    if (ch === '/' && i + 1 < len && ddl[i + 1] === '*') {
      i = scanBlockCommentEnd(ddl, i)
      continue
    }
    if (isPostgresEscapeStringStart(ddl, i, dialect)) {
      i = scanQuotedSegmentEnd(ddl, i + 1, "'", true).end
      continue
    }
    if (ch === "'") {
      i = scanQuotedSegmentEnd(ddl, i, "'", backslashAndHash).end
      continue
    }
    if (ch === '$') {
      const tag = matchDollarQuoteTag(ddl, i)
      if (tag !== null) {
        const closeIdx = ddl.indexOf(tag, i + tag.length)
        i = closeIdx >= 0 ? closeIdx + tag.length : len
        continue
      }
    }
    if (ch === '"') {
      const seg = scanQuotedSegmentEnd(ddl, i, '"', false)
      const raw = ddl.slice(i + 1, seg.closed ? seg.end - 1 : seg.end)
      tokens.push({ text: raw.replace(/""/g, '"'), kind: 'ident' })
      i = seg.end
      continue
    }
    if (ch === '`') {
      const seg = scanQuotedSegmentEnd(ddl, i, '`', false)
      const raw = ddl.slice(i + 1, seg.closed ? seg.end - 1 : seg.end)
      tokens.push({ text: raw.replace(/``/g, '`'), kind: 'ident' })
      i = seg.end
      continue
    }
    if (ch === '[') {
      let j = i + 1
      while (j < len) {
        if (ddl[j] === ']') {
          if (j + 1 < len && ddl[j + 1] === ']') {
            j += 2
            continue
          }
          break
        }
        j++
      }
      tokens.push({ text: ddl.slice(i + 1, j).replace(/]]/g, ']'), kind: 'ident' })
      i = j < len ? j + 1 : len
      continue
    }
    if (ch === '.') {
      tokens.push({ text: '.', kind: 'punct' })
      i++
      continue
    }
    if (ch === ',' || ch === '(' || ch === ')' || ch === ';') {
      tokens.push({ text: ch, kind: 'punct' })
      i++
      continue
    }
    if (isIdentStartChar(ddl.charCodeAt(i))) {
      let j = i + 1
      while (j < len && isIdentContChar(ddl.charCodeAt(j))) j++
      tokens.push({ text: ddl.slice(i, j), kind: 'word' })
      i = j
      continue
    }
    i++
  }
  return tokens
}

function extractReferencedTablesFromDdl(ddl: string, dialect: DatabaseDriverType): string[] {
  const tokens = tokenizeDdlForDeps(ddl, dialect)
  const refs: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.kind === 'word' && tok.text.toUpperCase() === 'REFERENCES') {
      const first = tokens[i + 1]
      if (!first || first.kind === 'punct') continue
      if (tokens[i + 2]?.text === '.' && tokens[i + 3] && tokens[i + 3].kind !== 'punct') {
        refs.push(tokens[i + 3].text)
        i += 3
      } else {
        refs.push(first.text)
        i += 1
      }
    }
  }
  return refs
}

const NON_RELATION_FROM_FUNCS = new Set(['EXTRACT', 'TRIM', 'SUBSTRING', 'OVERLAY', 'POSITION'])
const VIEW_CLAUSE_END_WORDS = new Set([
  'WHERE',
  'ON',
  'USING',
  'GROUP',
  'HAVING',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'FETCH',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'WINDOW',
  'FOR',
  'LOCK',
  'SETTINGS',
  'FORMAT',
  'PREWHERE',
])

function extractReferencedRelationsFromViewDdl(ddl: string, dialect: DatabaseDriverType): string[] {
  const tokens = tokenizeDdlForDeps(ddl, dialect)
  const refs: string[] = []
  let startIdx = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind === 'word' && t.text.toUpperCase() === 'AS') {
      startIdx = i + 1
      break
    }
  }

  let parenDepth = 0
  const suppressedFromDepths: number[] = []
  for (let i = startIdx; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.kind === 'punct') {
      if (tok.text === '(') {
        parenDepth++
        const prev = tokens[i - 1]
        if (prev?.kind === 'word' && NON_RELATION_FROM_FUNCS.has(prev.text.toUpperCase())) {
          suppressedFromDepths.push(parenDepth)
        }
      } else if (tok.text === ')') {
        while (
          suppressedFromDepths.length > 0 &&
          suppressedFromDepths[suppressedFromDepths.length - 1] >= parenDepth
        ) {
          suppressedFromDepths.pop()
        }
        parenDepth = Math.max(0, parenDepth - 1)
      }
      continue
    }

    if (tok.kind !== 'word') continue
    const upper = tok.text.toUpperCase()
    const inSuppressedFunc =
      suppressedFromDepths.length > 0 &&
      suppressedFromDepths[suppressedFromDepths.length - 1] === parenDepth
    if ((upper === 'FROM' && !inSuppressedFunc) || upper === 'JOIN') {
      let j = i + 1
      while (j < tokens.length) {
        const cur = tokens[j]
        if (cur?.kind === 'word' && (cur.text.toUpperCase() === 'ONLY' || cur.text.toUpperCase() === 'LATERAL')) {
          j++
          continue
        }
        if (!cur || cur.kind === 'punct') break
        let relName = cur.text
        if (tokens[j + 1]?.text === '.' && tokens[j + 2] && tokens[j + 2].kind !== 'punct') {
          relName = tokens[j + 2].text
          j += 3
          if (tokens[j]?.text === '.' && tokens[j + 1] && tokens[j + 1].kind !== 'punct') {
            relName = tokens[j + 1].text
            j += 2
          }
        } else {
          j += 1
        }
        refs.push(relName)

        if (upper !== 'FROM') break
        // Skip optional alias in comma-separated FROM list: FROM t1 [AS] a, t2 b
        if (tokens[j]?.kind === 'word' && tokens[j].text.toUpperCase() === 'AS') {
          j += 2
        } else if (
          tokens[j] &&
          tokens[j].kind !== 'punct' &&
          !VIEW_CLAUSE_END_WORDS.has(tokens[j].text.toUpperCase()) &&
          tokens[j].text.toUpperCase() !== 'JOIN' &&
          tokens[j].text.toUpperCase() !== 'LEFT' &&
          tokens[j].text.toUpperCase() !== 'RIGHT' &&
          tokens[j].text.toUpperCase() !== 'INNER' &&
          tokens[j].text.toUpperCase() !== 'FULL' &&
          tokens[j].text.toUpperCase() !== 'CROSS' &&
          tokens[j].text.toUpperCase() !== 'NATURAL'
        ) {
          j += 1
        }
        if (tokens[j]?.text === ',') {
          j += 1
          continue
        }
        break
      }
      i = Math.max(i, j - 1)
    }
  }
  return refs
}

function sectionLookupKey(name: string, dialect: DatabaseDriverType): string {
  return dialect === 'postgres' || dialect === 'cockroachdb' ? name : name.toLowerCase()
}

function toposortSectionsWithinKind(
  group: SchemaDdlSection[],
  dialect: DatabaseDriverType
): { ordered: SchemaDdlSection[]; hadCycle: boolean } {
  if (group.length <= 1) return { ordered: [...group], hadCycle: false }
  const sortedNodes = [...group].sort((a, b) => a.name.localeCompare(b.name))
  const keyToIdx = new Map<string, number>()
  sortedNodes.forEach((node, idx) => {
    const key = sectionLookupKey(node.name, dialect)
    if (!keyToIdx.has(key)) keyToIdx.set(key, idx)
  })

  const depsOf: Set<number>[] = sortedNodes.map(() => new Set<number>())
  const dependentsOf: Set<number>[] = sortedNodes.map(() => new Set<number>())

  sortedNodes.forEach((node, idx) => {
    const rawDeps: string[] = [...(node.dependsOn ?? [])]
    if (node.kind === 'table' && !node.failed) {
      rawDeps.push(...extractReferencedTablesFromDdl(node.ddl, dialect))
    } else if ((node.kind === 'view' || node.kind === 'materialized_view') && !node.failed) {
      rawDeps.push(...extractReferencedRelationsFromViewDdl(node.ddl, dialect))
    }
    for (const depName of rawDeps) {
      const depIdx = keyToIdx.get(sectionLookupKey(depName, dialect))
      if (depIdx !== undefined && depIdx !== idx) {
        depsOf[idx].add(depIdx)
        dependentsOf[depIdx].add(idx)
      }
    }
  })

  const inDegree = depsOf.map((set) => set.size)
  const emitted = new Array<boolean>(sortedNodes.length).fill(false)
  const result: SchemaDdlSection[] = []
  let hadCycle = false

  while (result.length < sortedNodes.length) {
    let pick = -1
    for (let i = 0; i < sortedNodes.length; i++) {
      if (!emitted[i] && inDegree[i] === 0) {
        pick = i
        break
      }
    }
    if (pick === -1) {
      hadCycle = true
      // Deterministic cycle break: lowest alphabetical unemitted node
      for (let i = 0; i < sortedNodes.length; i++) {
        if (!emitted[i]) {
          pick = i
          break
        }
      }
    }
    if (pick === -1) break
    emitted[pick] = true
    result.push(sortedNodes[pick])
    for (const childIdx of dependentsOf[pick]) {
      if (!emitted[childIdx] && inDegree[childIdx] > 0) {
        inDegree[childIdx] -= 1
      }
    }
  }
  return { ordered: result, hadCycle }
}

function orderSectionsWithExplicitDependencies(
  base: SchemaDdlSection[],
  dependencies: SchemaDependencyEdge[]
): SchemaDdlSection[] {
  if (base.length <= 1 || dependencies.length === 0) return base
  const indexByKey = new Map<string, number>()
  base.forEach((section, index) => {
    indexByKey.set(schemaDependencyKey(section.kind, section.name), index)
  })

  const depsOf: Set<number>[] = base.map(() => new Set<number>())
  const dependentsOf: Set<number>[] = base.map(() => new Set<number>())
  for (const edge of dependencies) {
    const consumerIdx = indexByKey.get(
      schemaDependencyKey(edge.consumer.kind, edge.consumer.name)
    )
    const prerequisiteIdx = indexByKey.get(
      schemaDependencyKey(edge.prerequisite.kind, edge.prerequisite.name)
    )
    if (consumerIdx === undefined || prerequisiteIdx === undefined) continue
    if (consumerIdx === prerequisiteIdx) continue
    depsOf[consumerIdx].add(prerequisiteIdx)
    dependentsOf[prerequisiteIdx].add(consumerIdx)
  }

  const inDegree = depsOf.map((set) => set.size)
  const emitted = new Array<boolean>(base.length).fill(false)
  const result: SchemaDdlSection[] = []

  while (result.length < base.length) {
    // Existing ordering is the deterministic tie-breaker for ready nodes.
    let pick = -1
    for (let i = 0; i < base.length; i++) {
      if (!emitted[i] && inDegree[i] === 0) {
        pick = i
        break
      }
    }
    if (pick === -1) {
      // Deterministic cycle/unresolved break: lowest existing-order node
      for (let i = 0; i < base.length; i++) {
        if (!emitted[i]) {
          pick = i
          break
        }
      }
    }
    if (pick === -1) break
    emitted[pick] = true
    result.push(base[pick])
    for (const childIdx of dependentsOf[pick]) {
      if (!emitted[childIdx] && inDegree[childIdx] > 0) {
        inDegree[childIdx] -= 1
      }
    }
  }
  return result
}

function extractCyclicPgForeignKeys(
  section: SchemaDdlSection
): { cleanedDdl: string; deferredAlters: string[] } {
  const match = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/i.exec(section.ddl)
  if (!match || !match[1]) {
    return { cleanedDdl: section.ddl, deferredAlters: [] }
  }
  const qualifiedTable = match[1]
  const rawLines = section.ddl.split(/\r?\n/)
  const keptLines: string[] = []
  const deferredAlters: string[] = []
  let inCreateBody = false

  for (const line of rawLines) {
    if (!inCreateBody) {
      keptLines.push(line)
      if (/^\s*CREATE\s+TABLE\b/i.test(line) && line.includes('(')) {
        inCreateBody = true
      }
      continue
    }
    if (/^\s*\)\s*;?\s*$/.test(line)) {
      // Remove trailing comma from the previous surviving column/constraint line if needed
      if (keptLines.length > 0 && /,\s*$/.test(keptLines[keptLines.length - 1])) {
        keptLines[keptLines.length - 1] = keptLines[keptLines.length - 1].replace(/,\s*$/, '')
      }
      keptLines.push(line)
      inCreateBody = false
      continue
    }
    const trimmedLine = line.trim()
    const isFkLine = /^(?:CONSTRAINT\s+(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_$]*)\s+)?FOREIGN\s+KEY\s*\(/i.test(
      trimmedLine
    )
    if (isFkLine) {
      const fkClause = trimmedLine.replace(/,\s*$/, '')
      deferredAlters.push(`ALTER TABLE ${qualifiedTable} ADD ${fkClause};`)
      continue
    }
    keptLines.push(line)
  }

  return { cleanedDdl: keptLines.join('\n'), deferredAlters }
}

/**
 * Orders schema objects by dependency (including FK topological sort for tables)
 * and renders a single executable `.sql` script with clean header comments.
 */
export function assembleFullSchemaDdl(params: {
  dialect: DatabaseDriverType
  schemaName: string
  sections: SchemaDdlSection[]
  dependencies?: SchemaDependencyEdge[]
}): { ddl: string; objectCount: number } {
  const byKind = new Map<SchemaObjectKind, SchemaDdlSection[]>()
  for (const section of params.sections) {
    const list = byKind.get(section.kind)
    if (list) list.push(section)
    else byKind.set(section.kind, [section])
  }

  const ordered: SchemaDdlSection[] = []
  let hadTableCycle = false
  for (const kind of SCHEMA_DDL_KIND_ORDER) {
    const group = byKind.get(kind)
    if (!group || group.length === 0) continue
    const sorted = toposortSectionsWithinKind(group, params.dialect)
    if (kind === 'table' && sorted.hadCycle) hadTableCycle = true
    ordered.push(...sorted.ordered)
  }
  for (const [kind, group] of byKind.entries()) {
    if (!SCHEMA_DDL_KIND_ORDER.includes(kind)) {
      const sorted = toposortSectionsWithinKind(group, params.dialect)
      ordered.push(...sorted.ordered)
    }
  }

  const finalOrder =
    params.dialect === 'postgres' && params.dependencies && params.dependencies.length > 0
      ? orderSectionsWithExplicitDependencies(ordered, params.dependencies)
      : ordered

  const isMysqlDialect = params.dialect === 'mysql' || params.dialect === 'mariadb'
  const isSqliteDialect =
    params.dialect === 'sqlite' || params.dialect === 'libsql' || params.dialect === 'd1'
  const isPgDialect = params.dialect === 'postgres' || params.dialect === 'cockroachdb'

  const lines: string[] = [
    '-- Datanoa Full Schema DDL Export',
    `-- Dialect: ${params.dialect}`,
    `-- Schema: ${params.schemaName}`,
    '',
  ]

  if (hadTableCycle && isMysqlDialect) {
    lines.push('SET FOREIGN_KEY_CHECKS = 0;', '')
  } else if (hadTableCycle && isSqliteDialect) {
    lines.push('PRAGMA foreign_keys = OFF;', '')
  }

  const deferredPgFkAlters: string[] = []
  let objectCount = 0
  for (const section of finalOrder) {
    const body = section.ddl.trim()
    if (!body) continue
    if (!section.failed) {
      objectCount += 1
    }
    lines.push(`-- ${section.kind}: ${section.name}`)

    if (
      hadTableCycle &&
      isPgDialect &&
      section.kind === 'table' &&
      !section.failed
    ) {
      const extracted = extractCyclicPgForeignKeys(section)
      lines.push(normalizeDdlSuffix(extracted.cleanedDdl))
      deferredPgFkAlters.push(...extracted.deferredAlters)
    } else if (
      isMysqlDialect &&
      !section.failed &&
      (section.kind === 'function' || section.kind === 'procedure' || section.kind === 'trigger') &&
      (body.includes(';') || /\bBEGIN\b/i.test(body))
    ) {
      const withoutTrailingSemi = body.replace(/;\s*$/, '')
      lines.push('DELIMITER $$', `${withoutTrailingSemi}$$`, 'DELIMITER ;')
    } else if (
      params.dialect === 'mssql' &&
      !section.failed &&
      (section.kind === 'view' ||
        section.kind === 'procedure' ||
        section.kind === 'function' ||
        section.kind === 'trigger')
    ) {
      lines.push(normalizeDdlSuffix(body), 'GO')
    } else if (
      params.dialect === 'oracle' &&
      !section.failed &&
      (section.kind === 'procedure' ||
        section.kind === 'function' ||
        section.kind === 'trigger')
    ) {
      const cleanBody = body.replace(/\n\/\s*$/, '').trimEnd()
      lines.push(normalizeDdlSuffix(cleanBody), '/')
    } else {
      lines.push(normalizeDdlSuffix(body))
    }
    lines.push('')
  }

  if (deferredPgFkAlters.length > 0) {
    lines.push('-- Deferred Foreign Keys (cyclic references)', ...deferredPgFkAlters, '')
  }

  if (hadTableCycle && isMysqlDialect) {
    lines.push('SET FOREIGN_KEY_CHECKS = 1;', '')
  } else if (hadTableCycle && isSqliteDialect) {
    lines.push('PRAGMA foreign_keys = ON;', '')
  }

  return { ddl: `${lines.join('\n').trimEnd()}\n`, objectCount }
}

/**
 * Sequentially collects deduplicated object DDLs (falling back to comment lines on errors)
 * and assembles them into a dependency-ordered schema export script.
 */
export async function collectAndAssembleSchemaDdl(options: {
  dialect: DatabaseDriverType
  schemaName: string
  objects: SchemaObject[]
  getObjectDdl: (object: SchemaObject) => Promise<string>
  dependencies?: SchemaDependencyEdge[]
}): Promise<{ ddl: string; objectCount: number }> {
  const sections: SchemaDdlSection[] = []
  const seen = new Set<string>()
  for (const object of options.objects) {
    const key = `${object.kind}:${object.name}`
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const ddl = await options.getObjectDdl(object)
      sections.push({ kind: object.kind, name: object.name, ddl })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      sections.push({
        kind: object.kind,
        name: object.name,
        ddl: `-- Failed to export ${object.kind} ${object.name}: ${msg}`,
        failed: true,
      })
    }
  }
  return assembleFullSchemaDdl({
    dialect: options.dialect,
    schemaName: options.schemaName,
    sections,
    dependencies: options.dependencies,
  })
}
