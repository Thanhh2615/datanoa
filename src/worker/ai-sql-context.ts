import type {
  AiExplainAnalysisResult,
  AiExplainBottleneck,
  AiExplainIndexSuggestion,
  AiExplainLanguage,
  AiFixQueryResult,
  ParsedExplainPlan,
  QueryHistoryEntry,
  SchemaObject,
  TableDetails,
} from '../protocol'
import { hasExplainAnalyzeOption } from '../drivers/common/sql-tools'
import {
  getDialectLexerRules,
  isPostgresEscapeStringStart,
  isolateActiveSqlStatement,
  matchDollarQuoteTag,
  scanBlockCommentEnd,
  scanBracketIdentEnd,
  scanLineCommentEnd,
  scanOracleQuoteEnd,
  scanQuotedSegmentEnd,
  splitSqlStatements,
} from '../shared-sql-core.js'
import { scrubSensitiveText } from '../shared-sql-safety.js'
import { AI_PREFIX_CHARS, hasSensitiveContent, looksInjected, type AiDialect } from './ai-client'

/**
 * Wraps arbitrary untrusted text (SQL, plans, errors) in a backtick fence strictly longer
 * than any backtick sequence present inside `content`, preventing markdown fence breakout.
 */
export function fencePromptBlock(content: string, lang = ''): string {
  const safeContent = typeof content === 'string' ? content : ''
  const runs = safeContent.match(/`+/g)
  const maxRun = runs ? Math.max(...runs.map((r) => r.length)) : 0
  const fence = '`'.repeat(Math.max(3, maxRun + 1))
  return `${fence}${lang}\n${safeContent}\n${fence}`
}

/**
 * Sanitizes database catalog identifiers (schema, table, column, index names) before prompt interpolation,
 * removing newlines, tabs, backticks, and C0/DEL control characters that could inject prompt instructions.
 */
export function sanitizeCatalogName(name: string): string {
  if (typeof name !== 'string') return ''
  return name.replace(/[\r\n\t\x00-\x1f\x7f`]+/g, ' ').replace(/ {2,}/g, ' ').trim()
}

const CURSOR = '<CURSOR>'
const MAX_SCHEMA_CHARS = 6000
const MAX_PRIOR_TAB_SQL_CHARS = 400
const TIER3_COMPACT_TABLE_THRESHOLD = 40
const MAX_HISTORY_CHARS = 360
const MAX_HISTORY_ITEMS = 2
const COMPLETION_HISTORY_CHARS = 800
const COMPLETION_HISTORY_ITEMS = 4
const INLINE_PREFIX_CHARS = 1600
const INLINE_SUFFIX_CHARS = 700
const MAX_PLAN_CHARS = 5000
const MAX_EXPLAIN_SCHEMA_CHARS = 3500
const MAX_FIX_QUERY_SQL_CHARS = 4000
const MAX_FIX_QUERY_ERROR_CHARS = 1500
export const MAX_FIX_QUERY_SCHEMA_CHARS = 3500
const LONG_LITERAL_MIN = 16

export interface WorkerSchemaSnapshot {
  objects: SchemaObject[]
  details: ReadonlyMap<string, TableDetails>
}

interface ConnectionSchemaEntry {
  objects: SchemaObject[]
  details: Map<string, TableDetails>
}

function detailKeysFor(table: string, schema?: string): string[] {
  const bare = table.toLowerCase()
  const sch = (schema || '').trim().toLowerCase()
  return sch ? [`${sch}.${bare}`, bare] : [bare]
}

const MAX_CACHED_CONNECTIONS = 16
const MAX_DETAILS_PER_CONNECTION = 120
const MAX_OBJECTS_PER_CONNECTION = 2000

export class WorkerSchemaMetadataCache {
  protected readonly store = new Map<string, ConnectionSchemaEntry>()
  protected readonly connectionRevisions = new Map<string, number>()
  protected revisionCounter = 0

  protected bumpConnectionRevision(connectionId: string): void {
    this.revisionCounter += 1
    this.connectionRevisions.delete(connectionId)
    this.connectionRevisions.set(connectionId, this.revisionCounter)
    while (this.connectionRevisions.size > MAX_CACHED_CONNECTIONS * 4) {
      const oldest = this.connectionRevisions.keys().next().value
      if (oldest === undefined) break
      this.connectionRevisions.delete(oldest)
    }
  }

  getConnectionRevision(connectionId: string): number {
    return connectionId ? (this.connectionRevisions.get(connectionId) ?? 0) : 0
  }

  protected touchConnection(connectionId: string, entry: ConnectionSchemaEntry): void {
    this.store.delete(connectionId)
    this.store.set(connectionId, entry)
    while (this.store.size > MAX_CACHED_CONNECTIONS) {
      const oldest = this.store.keys().next().value
      if (oldest === undefined) break
      this.store.delete(oldest)
    }
  }

  setObjects(connectionId: string, objects: SchemaObject[], schema?: string): void {
    if (!connectionId) return
    this.bumpConnectionRevision(connectionId)
    const trimmedSchema = typeof schema === 'string' ? schema.trim() : ''
    const normSchema = trimmedSchema.toLowerCase()
    const existing = this.store.get(connectionId)
    if (!normSchema) {
      const nextObjects = objects.slice(0, MAX_OBJECTS_PER_CONNECTION)
      if (existing) {
        existing.objects = nextObjects
        this.touchConnection(connectionId, existing)
      } else {
        this.touchConnection(connectionId, { objects: nextObjects, details: new Map() })
      }
      return
    }
    const normalizedIncoming = objects
      .map((obj) => (obj.schema ? obj : { ...obj, schema: trimmedSchema }))
      .slice(0, MAX_OBJECTS_PER_CONNECTION)
    const kept = (existing?.objects ?? []).filter(
      (obj) => (obj.schema || '').trim().toLowerCase() !== normSchema
    )
    const keepLimit = Math.max(0, MAX_OBJECTS_PER_CONNECTION - normalizedIncoming.length)
    const merged =
      kept.length > keepLimit
        ? [...kept.slice(kept.length - keepLimit), ...normalizedIncoming]
        : [...kept, ...normalizedIncoming]
    if (existing) {
      existing.objects = merged
      this.touchConnection(connectionId, existing)
    } else {
      this.touchConnection(connectionId, { objects: merged, details: new Map() })
    }
  }

  setTableDetails(connectionId: string, details: TableDetails): void {
    if (!connectionId || !details?.name) return
    const entry = this.store.get(connectionId) ?? { objects: [], details: new Map() }
    this.touchConnection(connectionId, entry)
    const incomingCompleteness = details.completeness === 'lite' ? 'lite' : 'full'
    const normalizedDetails: TableDetails =
      details.completeness === incomingCompleteness
        ? details
        : { ...details, completeness: incomingCompleteness }
    const keys = detailKeysFor(details.name, details.schema)
    for (const k of keys) {
      const prev = entry.details.get(k)
      if (prev && prev.completeness !== 'lite' && incomingCompleteness === 'lite') {
        continue
      }
      entry.details.delete(k)
      entry.details.set(k, normalizedDetails)
      while (entry.details.size > MAX_DETAILS_PER_CONNECTION) {
        const oldestKey = entry.details.keys().next().value
        if (oldestKey === undefined) break
        entry.details.delete(oldestKey)
      }
    }
  }

  invalidateConnection(connectionId: string): void {
    if (!connectionId) return
    this.bumpConnectionRevision(connectionId)
    this.store.delete(connectionId)
  }

  invalidateSchemaDetails(connectionId: string, schema?: string): void {
    if (!connectionId) return
    this.bumpConnectionRevision(connectionId)
    const entry = this.store.get(connectionId)
    if (!entry) return
    const normSchema = typeof schema === 'string' ? schema.trim().toLowerCase() : ''
    if (!normSchema) {
      entry.details.clear()
      return
    }
    const prefix = `${normSchema}.`
    for (const [k, det] of Array.from(entry.details.entries())) {
      const detSchema = (det.schema || '').trim().toLowerCase()
      if (k.startsWith(prefix) || detSchema === normSchema) {
        entry.details.delete(k)
      }
    }
  }

  getSnapshot(connectionId: string): WorkerSchemaSnapshot | null {
    if (!connectionId) return null
    const entry = this.store.get(connectionId)
    if (!entry) return null
    return { objects: entry.objects, details: entry.details }
  }

  /**
   * Returns both the schema snapshot and its monotonically increasing connection revision atomically.
   */
  getAiSnapshot(connectionId: string): { snapshot: WorkerSchemaSnapshot | null; revision: number } {
    if (!connectionId) {
      return { snapshot: null, revision: 0 }
    }
    const revision = this.connectionRevisions.get(connectionId) ?? 0
    const entry = this.store.get(connectionId)
    if (!entry) {
      return { snapshot: null, revision }
    }
    return {
      snapshot: { objects: entry.objects, details: entry.details },
      revision,
    }
  }
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch)
}

function scanQuotedString(
  text: string,
  start: number,
  quote: "'" | '"' | '`',
  opts: { backslashEscape: boolean; doubledEscape: boolean }
): { end: number; closed: boolean } {
  let j = start + 1
  while (j < text.length) {
    if (opts.backslashEscape && text[j] === '\\') {
      j += 2
      continue
    }
    if (text[j] === quote) {
      if (opts.doubledEscape && text[j + 1] === quote) {
        j += 2
        continue
      }
      return { end: j + 1, closed: true }
    }
    j += 1
  }
  return { end: text.length, closed: false }
}

function scanBracketIdent(text: string, start: number): { end: number; closed: boolean } {
  let j = start + 1
  while (j < text.length) {
    if (text[j] === ']') {
      if (text[j + 1] === ']') {
        j += 2
        continue
      }
      return { end: j + 1, closed: true }
    }
    j += 1
  }
  return { end: text.length, closed: false }
}

const ORACLE_Q_CLOSE_DELIM = new Map<string, string>([
  ['[', ']'],
  ['(', ')'],
  ['{', '}'],
  ['<', '>'],
])

/** Matches Oracle alternative quoting `q'<delim>...<close>'` or `nq'<delim>...<close>'` when starting a token. */
function scanOracleQQuote(text: string, index: number): { end: number; closed: boolean } | null {
  const first = text[index]
  let qIdx = index
  if ((first === 'n' || first === 'N') && (text[index + 1] === 'q' || text[index + 1] === 'Q')) {
    qIdx = index + 1
  } else if (first !== 'q' && first !== 'Q') {
    return null
  }
  if (qIdx + 2 >= text.length || text[qIdx + 1] !== "'") return null
  if (index > 0 && isIdentChar(text[index - 1])) return null
  const delim = text[qIdx + 2]
  if (!delim || /\s/.test(delim)) return null
  const closeDelim = ORACLE_Q_CLOSE_DELIM.get(delim) ?? delim
  const closeIdx = text.indexOf(`${closeDelim}'`, qIdx + 3)
  if (closeIdx >= 0) {
    return { end: closeIdx + 2, closed: true }
  }
  return { end: text.length, closed: false }
}

function scanDollarQuote(text: string, dollarIndex: number): { end: number; closed: boolean } | null {
  const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(dollarIndex))
  if (!tagMatch) return null
  const tag = tagMatch[0]
  const closeAt = text.indexOf(tag, dollarIndex + tag.length)
  if (closeAt === -1) return { end: text.length, closed: false }
  return { end: closeAt + tag.length, closed: true }
}

/** Strips SQL comments and string literals while keeping quoted/bracketed identifiers intact. */
function maskSqlCommentsAndStringsForTableScan(sqlText: string, dialect?: AiDialect): string {
  const rules = getDialectLexerRules(dialect)
  const parts: string[] = []
  let i = 0
  while (i < sqlText.length) {
    const ch = sqlText[i]
    const next = sqlText[i + 1]
    if (rules.lineCommentDash && ch === '-' && next === '-') {
      const end = scanLineCommentEnd(sqlText, i)
      parts.push(' ')
      if (end > i && (sqlText[end - 1] === '\n' || sqlText[end - 1] === '\r')) {
        parts.push('\n')
      }
      i = end
      continue
    }
    if (
      ch === '#' &&
      (rules.lineCommentHash || (dialect === undefined && (!next || !/[A-Za-z0-9_#>]/.test(next))))
    ) {
      const end = scanLineCommentEnd(sqlText, i - 1)
      parts.push(' ')
      if (end > i && (sqlText[end - 1] === '\n' || sqlText[end - 1] === '\r')) {
        parts.push('\n')
      }
      i = end
      continue
    }
    if (rules.lineCommentSlash && ch === '/' && next === '/') {
      const end = scanLineCommentEnd(sqlText, i)
      parts.push(' ')
      if (end > i && (sqlText[end - 1] === '\n' || sqlText[end - 1] === '\r')) {
        parts.push('\n')
      }
      i = end
      continue
    }
    if (ch === '/' && next === '*') {
      const end = scanBlockCommentEnd(sqlText, i, rules.nestedBlockComments)
      parts.push(' ')
      i = end
      continue
    }
    if (rules.oracleQQuote || dialect === undefined) {
      const qMatch = dialect === undefined ? scanOracleQQuote(sqlText, i) : scanOracleQuoteEnd(sqlText, i, dialect)
      if (qMatch) {
        parts.push(' ')
        i = qMatch.end
        continue
      }
    }
    if ((rules.dollarQuoting || dialect === undefined) && ch === '$') {
      const tag = matchDollarQuoteTag(sqlText, i)
      if (tag) {
        const closeAt = sqlText.indexOf(tag, i + tag.length)
        parts.push(' ')
        i = closeAt === -1 ? sqlText.length : closeAt + tag.length
        continue
      }
    }
    if (
      rules.postgresEscapeString &&
      (ch === 'E' || ch === 'e') &&
      next === "'" &&
      isPostgresEscapeStringStart(sqlText, i, dialect)
    ) {
      const str = scanQuotedSegmentEnd(sqlText, i + 1, "'", true)
      parts.push(' ')
      i = str.end
      continue
    }
    if (ch === "'") {
      const str = scanQuotedSegmentEnd(
        sqlText,
        i,
        "'",
        dialect === undefined ? true : rules.backslashEscapesSingleQuote
      )
      parts.push(' ')
      i = str.end
      continue
    }
    if (ch === '[' && (rules.bracketIdentifiers !== 'none' || dialect === undefined)) {
      const br = scanBracketIdentEnd(sqlText, i, rules.bracketIdentifiers !== 'no-doubling')
      parts.push(sqlText.slice(i, br.end))
      i = br.end
      continue
    }
    if (ch === '"' && rules.doubleQuoteIdentifiers) {
      const q = scanQuotedSegmentEnd(sqlText, i, '"', rules.backslashEscapesDoubleQuote)
      parts.push(sqlText.slice(i, q.end))
      i = q.end
      continue
    }
    if (ch === '`' && rules.backtickIdentifiers) {
      const q = scanQuotedSegmentEnd(sqlText, i, '`', false)
      parts.push(sqlText.slice(i, q.end))
      i = q.end
      continue
    }
    parts.push(ch)
    i += 1
  }
  return parts.join('')
}

function unquoteIdent(raw: string): string {
  const s = raw.trim()
  if (s.startsWith('[') && s.endsWith(']')) {
    return s.slice(1, -1).replace(/\]\]/g, ']')
  }
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/""/g, '"')
  }
  if (s.startsWith('`') && s.endsWith('`')) {
    return s.slice(1, -1).replace(/``/g, '`')
  }
  return s
}

const SQL_IDENT_ATOM =
  '(?:\\[(?:[^\\]\\r\\n]|\\]\\])+\\]|"(?:[^"\\r\\n]|"")+"|`(?:[^`\\r\\n]|``)+`|[A-Za-z0-9_$]+)'
const SQL_REFERENCED_TABLE_PATTERN =
  `\\b(?:FROM(?:\\s+ONLY)?|JOIN|UPDATE(?:\\s+ONLY)?|INTO|TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?|DESCRIBE)\\s+(?:(${SQL_IDENT_ATOM})\\s*\\.\\s*)?(?:(${SQL_IDENT_ATOM})\\s*\\.\\s*)?(${SQL_IDENT_ATOM})`
const SQL_TRAILING_PARTIAL_TABLE_RE = new RegExp(
  `(?:^|[\\s(,;])(?:FROM(?:\\s+ONLY)?|JOIN|UPDATE(?:\\s+ONLY)?|INTO|TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?|DESCRIBE)\\s+(?:(${SQL_IDENT_ATOM})\\s*\\.\\s*)?(?:(${SQL_IDENT_ATOM})\\s*\\.\\s*)?(["\`[]?)([A-Za-z0-9_$]{1,64})$`,
  'i'
)

export interface PartialTableReference {
  schema?: string
  partial: string
}

/** Extracts an unfinished table/object name at the end of `prefix` (including unclosed quotes like `"ac`). */
export function extractTrailingPartialTableName(
  prefix: string,
  dialect?: AiDialect
): PartialTableReference | null {
  if (!prefix || dialect === 'redis' || dialect === 'mongodb') return null
  const masked = maskSqlCommentsAndStringsForTableScan(prefix.slice(-INLINE_PREFIX_CHARS), dialect)
  const match = SQL_TRAILING_PARTIAL_TABLE_RE.exec(masked)
  if (!match) return null
  const schema = match[2] ? unquoteIdent(match[2]) : match[1] ? unquoteIdent(match[1]) : undefined
  const partial = match[4]
  if (!partial) return null
  return schema ? { schema, partial } : { partial }
}

export function extractReferencedTables(sqlText: string, dialect?: AiDialect): string[] {
  const masked = maskSqlCommentsAndStringsForTableScan(sqlText, dialect)
  const found: string[] = []
  const seen = new Set<string>()
  const re = new RegExp(SQL_REFERENCED_TABLE_PATTERN, 'gi')
  let match: RegExpExecArray | null
  while ((match = re.exec(masked)) !== null) {
    const p1 = match[1] ? unquoteIdent(match[1]) : ''
    const p2 = match[2] ? unquoteIdent(match[2]) : ''
    const p3 = match[3] ? unquoteIdent(match[3]) : ''
    const schemaPart = p2 ? p2 : p1
    const tablePart = p3
    if (!tablePart) continue
    const qualified = schemaPart ? `${schemaPart}.${tablePart}` : tablePart
    const key = qualified.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      found.push(qualified)
    }
  }
  return found
}

function lookupDetails(
  snapshot: WorkerSchemaSnapshot | null,
  rawName: string,
  activeSchema?: string
): TableDetails | undefined {
  if (!snapshot) return undefined
  const lower = rawName.toLowerCase()
  if (lower.includes('.')) {
    return snapshot.details.get(lower)
  }
  if (activeSchema) {
    const qualified = snapshot.details.get(`${activeSchema.toLowerCase()}.${lower}`)
    if (qualified) return qualified
  }
  return snapshot.details.get(lower)
}

function extractReferencedColumnTokens(sqlText: string, dialect?: AiDialect): Set<string> {
  const out = new Set<string>()
  if (!sqlText || dialect === 'redis') return out
  const masked = maskSqlCommentsAndStringsForTableScan(sqlText, dialect)
  const matches = masked.match(/[A-Za-z_][A-Za-z0-9_$]*/g)
  if (!matches) return out
  for (const tok of matches) {
    out.add(tok.toLowerCase())
  }
  return out
}

function prioritizeColumns<T>(
  items: readonly T[],
  limit: number,
  isPriority: (item: T) => boolean
): readonly T[] {
  if (items.length <= limit) return items
  const priority: T[] = []
  const rest: T[] = []
  for (const item of items) {
    if (isPriority(item)) priority.push(item)
    else rest.push(item)
  }
  return [...priority, ...rest].slice(0, limit)
}

function buildCompactTableParts(
  details: TableDetails,
  referencedCols?: ReadonlySet<string>
): {
  title: string
  cols: string[]
  idxNote: string
} {
  const fkByCol = new Map<string, string>()
  for (const fk of details.foreignKeys || []) {
    const refTable = sanitizeCatalogName(fk.referencedTable)
    const refCol = sanitizeCatalogName(fk.referencedColumn)
    fkByCol.set(fk.column.toLowerCase(), `${refTable}.${refCol}`)
  }
  const selectedColumns = prioritizeColumns(
    details.columns || [],
    32,
    (c) => {
      const lower = c.name.toLowerCase()
      return Boolean(c.isPrimaryKey || fkByCol.has(lower) || referencedCols?.has(lower))
    }
  )
  const cols = selectedColumns.map((c) => {
    const tags: string[] = []
    if (c.isPrimaryKey) tags.push('PK')
    const fk = fkByCol.get(c.name.toLowerCase())
    if (fk) tags.push(`FK->${fk}`)
    const suffix = tags.length > 0 ? ` ${tags.join(' ')}` : ''
    const colName = sanitizeCatalogName(c.name)
    const colType = sanitizeCatalogName(c.type || 'any') || 'any'
    return `${colName} ${colType}${suffix}`
  })
  const idxList = (details.indexes || [])
    .filter((i) => !i.isPrimary && Array.isArray(i.columns) && i.columns.length > 0)
    .slice(0, 6)
    .map(
      (i) =>
        `${i.isUnique ? 'uniq:' : ''}${sanitizeCatalogName(i.name)}(${i.columns.map(sanitizeCatalogName).join(', ')})`
    )
  const idxNote = idxList.length > 0 ? ` [idx: ${idxList.join('; ')}]` : ''
  const cleanSchema = sanitizeCatalogName(details.schema || '')
  const cleanName = sanitizeCatalogName(details.name)
  const title = cleanSchema ? `${cleanSchema}.${cleanName}` : cleanName
  return { title, cols, idxNote }
}

function formatCompactTableDdl(details: TableDetails): string {
  const { title, cols, idxNote } = buildCompactTableParts(details)
  return `${title} (${cols.join(', ')})${idxNote}`
}

function fitColumnListToBudget(
  title: string,
  cols: readonly string[],
  idxNote: string,
  budget: number
): string {
  if (budget <= 0) return ''
  const full = `${title} (${cols.join(', ')})${idxNote}`
  if (full.length <= budget) return full
  const withoutIdx = `${title} (${cols.join(', ')})`
  if (withoutIdx.length <= budget) return withoutIdx
  const prefix = `${title} (`
  const ellipsisSuffix = ', ...)'
  const kept: string[] = []
  let len = prefix.length + ellipsisSuffix.length
  for (const col of cols) {
    const add = (kept.length > 0 ? 2 : 0) + col.length
    if (len + add > budget) break
    kept.push(col)
    len += add
  }
  if (kept.length > 0) {
    const out = `${prefix}${kept.join(', ')}${ellipsisSuffix}`
    if (out.length <= budget) return out
  }
  if (cols.length > 0) {
    const maxCol = budget - prefix.length - 3 - ellipsisSuffix.length
    if (maxCol >= 4) {
      const out = `${prefix}${cols[0].slice(0, maxCol)}...${ellipsisSuffix}`
      if (out.length <= budget) return out
    }
  }
  return budget >= `${title} (...)`.length ? `${title} (...)` : ''
}

export function collectPartialTableMatches(
  snapshot: WorkerSchemaSnapshot | null,
  schemaMap: Record<string, string[]> | undefined,
  partialTable: PartialTableReference,
  activeSchema?: string
): string[] {
  const partialLower = partialTable.partial.toLowerCase()
  const targetSchemaLower = (partialTable.schema || '').trim().toLowerCase()
  const activeSchemaLower = (activeSchema || '').trim().toLowerCase()
  const candidates = new Map<string, { qualified: string; name: string; schemaMatch: number }>()

  const consider = (rawName: string, rawSchema?: string) => {
    const bare = rawName.includes('.') ? rawName.split('.').pop() || rawName : rawName
    const bareLower = bare.toLowerCase()
    if (!bareLower.startsWith(partialLower)) return
    const sch = (rawSchema || (rawName.includes('.') ? rawName.split('.')[0] : '') || '').trim()
    const schLower = sch.toLowerCase()
    if (targetSchemaLower && schLower && schLower !== targetSchemaLower) return
    const qualified = sch ? `${sch}.${bare}` : bare
    const key = qualified.toLowerCase()
    const schemaMatch =
      targetSchemaLower && schLower === targetSchemaLower
        ? 0
        : activeSchemaLower && schLower === activeSchemaLower
          ? 1
          : 2
    const existing = candidates.get(key)
    if (!existing || schemaMatch < existing.schemaMatch) {
      candidates.set(key, { qualified, name: bare, schemaMatch })
    }
  }

  if (snapshot) {
    for (const obj of snapshot.objects) {
      if (obj.kind && obj.kind !== 'table' && obj.kind !== 'view' && obj.kind !== 'materialized_view') {
        continue
      }
      consider(obj.name, obj.schema)
    }
    for (const det of snapshot.details.values()) {
      consider(det.name, det.schema)
    }
  }
  if (schemaMap) {
    for (const tbl of Object.keys(schemaMap)) {
      consider(tbl)
    }
  }

  return Array.from(candidates.values())
    .sort((a, b) => {
      if (a.schemaMatch !== b.schemaMatch) return a.schemaMatch - b.schemaMatch
      if (a.name.length !== b.name.length) return a.name.length - b.name.length
      return a.qualified.localeCompare(b.qualified)
    })
    .slice(0, 6)
    .map((c) => c.qualified)
}

function lookupSchemaMapCols(
  schemaMap: Record<string, string[]> | undefined,
  ...keys: Array<string | undefined>
): string[] | undefined {
  if (!schemaMap) return undefined
  for (const key of keys) {
    if (!key || !Object.hasOwn(schemaMap, key)) continue
    const cols = schemaMap[key]
    if (Array.isArray(cols) && cols.length > 0) return cols
  }
  return undefined
}

export interface SchemaContextBudget {
  maxChars?: number
  compactTier3WhenReferenced?: boolean
  maxTier3Chars?: number
}

type Tier3SchemaOptions = Omit<SchemaContextBudget, 'maxChars'>

function resolveNonNegativeIntBudget(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback
}

function resolveTier3Policy(
  chars: number,
  maxChars: number,
  tier1Count: number,
  remainingCount: number,
  fullSummaryChars: number,
  mediumSummaryChars: number,
  options?: Tier3SchemaOptions
): { tier3Limit: number; tier3Mode: 'full' | 'medium' | 'compact' } {
  const maxTier3Chars = options?.maxTier3Chars
  const hasMaxTier3 =
    typeof maxTier3Chars === 'number' && Number.isFinite(maxTier3Chars) && maxTier3Chars >= 0
  const tier3Limit = hasMaxTier3
    ? Math.min(maxChars, chars + Math.floor(maxTier3Chars))
    : maxChars
  if (options?.compactTier3WhenReferenced === true && tier1Count > 0) {
    return { tier3Limit, tier3Mode: 'compact' }
  }
  const tier3Mode: 'full' | 'medium' | 'compact' =
    chars + fullSummaryChars <= tier3Limit
      ? 'full'
      : (remainingCount > TIER3_COMPACT_TABLE_THRESHOLD || hasMaxTier3) &&
          chars + mediumSummaryChars > tier3Limit
        ? 'compact'
        : 'medium'
  return { tier3Limit, tier3Mode }
}

export function buildPrunedSchemaBlock(
  snapshot: WorkerSchemaSnapshot | null,
  schemaMap: Record<string, string[]> | undefined,
  referencedTables: string[],
  activeSchema?: string,
  activeTable?: string,
  maxChars = MAX_SCHEMA_CHARS,
  partialTable?: PartialTableReference | null,
  fuzzyTables?: string[],
  referencedCols?: ReadonlySet<string>,
  precomputedPartialMatches?: readonly string[],
  options?: Tier3SchemaOptions
): string {
  const lines: string[] = []
  const usedKeys = new Set<string>()
  const usedBareKeys = new Set<string>()
  let chars = 0

  const markUsed = (k: string, bareLower: string) => {
    usedKeys.add(k)
    usedBareKeys.add(bareLower)
  }

  const pushLine = (line: string): boolean => {
    if (!line) return false
    const sep = lines.length > 0 ? 1 : 0
    if (chars + sep + line.length > maxChars) return false
    lines.push(line)
    chars += sep + line.length
    return true
  }

  const partialMatches =
    precomputedPartialMatches !== undefined
      ? [...precomputedPartialMatches]
      : partialTable
        ? collectPartialTableMatches(snapshot, schemaMap, partialTable, activeSchema)
        : []
  const tier1Names: string[] = []
  const seenTier1 = new Set<string>()
  for (const name of [...partialMatches, ...(fuzzyTables ?? []), ...referencedTables]) {
    const key = name.toLowerCase()
    if (!seenTier1.has(key)) {
      seenTier1.add(key)
      tier1Names.push(name)
    }
  }
  if (tier1Names.length === 0 && activeTable) {
    tier1Names.push(activeSchema ? `${activeSchema}.${activeTable}` : activeTable)
  }

  type Tier1Item =
    | { kind: 'details'; details: TableDetails }
    | { kind: 'map'; title: string; cols: string[] }
  const tier1Items: Tier1Item[] = []
  const tier1Details: TableDetails[] = []

  for (const name of tier1Names) {
    const det = lookupDetails(snapshot, name, activeSchema)
    if (det) {
      const k = `${(det.schema || '').toLowerCase()}.${det.name.toLowerCase()}`
      if (!usedKeys.has(k)) {
        markUsed(k, det.name.toLowerCase())
        tier1Details.push(det)
        tier1Items.push({ kind: 'details', details: det })
      }
    } else if (schemaMap) {
      const bare = name.includes('.') ? name.split('.').pop() || name : name
      const cols = name.includes('.')
        ? lookupSchemaMapCols(schemaMap, name)
        : lookupSchemaMapCols(schemaMap, activeSchema ? `${activeSchema}.${bare}` : undefined, name, bare)
      if (cols) {
        const bareKey = `.${bare.toLowerCase()}`
        if (!usedKeys.has(bareKey)) {
          markUsed(bareKey, bare.toLowerCase())
          const selected = prioritizeColumns(cols, 24, (c) => Boolean(referencedCols?.has(c.toLowerCase())))
          tier1Items.push({
            kind: 'map',
            title: sanitizeCatalogName(bare),
            cols: selected.map(sanitizeCatalogName),
          })
        }
      }
    }
  }

  for (let i = 0; i < tier1Items.length; i++) {
    const remainingBudget = maxChars - chars - (lines.length > 0 ? 1 : 0)
    if (remainingBudget <= 0) break
    const remainingCount = tier1Items.length - 1 - i
    const reservedForRest =
      remainingCount > 0 ? Math.min(remainingCount * 160, Math.floor(remainingBudget / 2)) : 0
    const tableBudget = Math.max(120, remainingBudget - reservedForRest)
    const item = tier1Items[i]
    if (item.kind === 'details') {
      const { title, cols, idxNote } = buildCompactTableParts(item.details, referencedCols)
      pushLine(fitColumnListToBudget(title, cols, idxNote, Math.min(tableBudget, remainingBudget)))
    } else {
      pushLine(fitColumnListToBudget(item.title, item.cols, '', Math.min(tableBudget, remainingBudget)))
    }
  }

  // Tier 2: 1-hop FK neighbors (outgoing from Tier 1 and incoming pointing to Tier 1)
  if (snapshot) {
    const tier1Bare = new Set(tier1Details.map((d) => d.name.toLowerCase()))
    const neighborTargets: Array<{ table: string; schema?: string }> = []
    for (const d of tier1Details) {
      for (const fk of d.foreignKeys || []) {
        neighborTargets.push({ table: fk.referencedTable, schema: fk.referencedSchema })
      }
    }
    for (const det of snapshot.details.values()) {
      if ((det.foreignKeys || []).some((fk) => tier1Bare.has(fk.referencedTable.toLowerCase()))) {
        neighborTargets.push({ table: det.name, schema: det.schema })
      }
    }
    for (const target of neighborTargets) {
      const det = lookupDetails(snapshot, target.table, target.schema || activeSchema)
      if (!det) continue
      const k = `${(det.schema || '').toLowerCase()}.${det.name.toLowerCase()}`
      if (usedKeys.has(k)) continue
      markUsed(k, det.name.toLowerCase())
      if (!pushLine(formatCompactTableDdl(det))) break
    }
  }

  // Tier 3: Remaining objects summary (gracefully degrades full -> key cols -> compact names to keep columns for 20-50+ tables)
  const remaining = new Map<string, { full: string; medium: string; compact: string }>()
  const remainingBareKeys = new Set<string>()
  if (snapshot) {
    for (const obj of snapshot.objects) {
      if (obj.kind && obj.kind !== 'table' && obj.kind !== 'view' && obj.kind !== 'materialized_view') {
        continue
      }
      const k = `${(obj.schema || '').toLowerCase()}.${obj.name.toLowerCase()}`
      const bareKey = `.${obj.name.toLowerCase()}`
      if (usedKeys.has(k) || usedKeys.has(bareKey)) continue
      const det = lookupDetails(snapshot, obj.name, obj.schema)
      let cols: string[]
      if (det) {
        const fkCols = new Set((det.foreignKeys || []).map((fk) => fk.column.toLowerCase()))
        cols = prioritizeColumns(det.columns || [], 8, (c) =>
          Boolean(c.isPrimaryKey || fkCols.has(c.name.toLowerCase()))
        ).map((c) => sanitizeCatalogName(c.name))
      } else {
        cols = (lookupSchemaMapCols(schemaMap, obj.name)?.slice(0, 8) ?? []).map(sanitizeCatalogName)
      }
      const cleanSchema = sanitizeCatalogName(obj.schema || '')
      const cleanName = sanitizeCatalogName(obj.name)
      const label = cleanSchema ? `${cleanSchema}.${cleanName}` : cleanName
      const keyCols = cols.slice(0, 4)
      remainingBareKeys.add(obj.name.toLowerCase())
      remaining.set(k, {
        full: cols.length > 0 ? `${label}(${cols.join(', ')})` : label,
        medium: keyCols.length > 0 ? `${label}(${keyCols.join(', ')})` : label,
        compact: label,
      })
    }
  }
  if (schemaMap) {
    for (const [tbl, rawCols] of Object.entries(schemaMap)) {
      if (!Array.isArray(rawCols)) continue
      const bare = tbl.includes('.') ? tbl.split('.').pop() || tbl : tbl
      const bareLower = bare.toLowerCase()
      if (usedBareKeys.has(bareLower) || remainingBareKeys.has(bareLower)) {
        continue
      }
      const cols = rawCols.map(sanitizeCatalogName)
      const cleanTbl = sanitizeCatalogName(tbl)
      const top8 = cols.slice(0, 8)
      const top4 = cols.slice(0, 4)
      remainingBareKeys.add(bareLower)
      remaining.set(`.${bareLower}`, {
        full: top8.length > 0 ? `${cleanTbl}(${top8.join(', ')})` : cleanTbl,
        medium: top4.length > 0 ? `${cleanTbl}(${top4.join(', ')})` : cleanTbl,
        compact: cleanTbl,
      })
    }
  }

  const remainingEntries = Array.from(remaining.values())
  const fullSummaryChars = remainingEntries.reduce((sum, entry) => sum + entry.full.length + 1, 0)
  const mediumSummaryChars = remainingEntries.reduce((sum, entry) => sum + entry.medium.length + 1, 0)
  const { tier3Limit, tier3Mode } = resolveTier3Policy(
    chars,
    maxChars,
    tier1Items.length,
    remainingEntries.length,
    fullSummaryChars,
    mediumSummaryChars,
    options
  )
  for (const entry of remainingEntries) {
    const line =
      tier3Mode === 'full' ? entry.full : tier3Mode === 'medium' ? entry.medium : entry.compact
    if (!line || chars + line.length + 1 > tier3Limit) break
    if (!pushLine(line)) break
  }

  return lines.join('\n')
}

function buildDdlColumnDefs(
  details: TableDetails,
  limit: number,
  includeTypes: boolean,
  referencedCols?: ReadonlySet<string>
): { title: string; cols: string[] } {
  const fkByCol = new Map<string, string>()
  for (const fk of details.foreignKeys || []) {
    fkByCol.set(
      fk.column.toLowerCase(),
      `${sanitizeCatalogName(fk.referencedTable)}(${sanitizeCatalogName(fk.referencedColumn)})`
    )
  }
  const selectedColumns = prioritizeColumns(details.columns || [], limit, (c) => {
    const lower = c.name.toLowerCase()
    return Boolean(c.isPrimaryKey || fkByCol.has(lower) || referencedCols?.has(lower))
  })
  const cols = selectedColumns.map((c) => {
    const parts: string[] = [sanitizeCatalogName(c.name)]
    if (includeTypes) {
      parts.push(sanitizeCatalogName(c.type || 'TEXT') || 'TEXT')
    }
    if (c.isPrimaryKey) parts.push('PRIMARY KEY')
    const fk = fkByCol.get(c.name.toLowerCase())
    if (fk) parts.push(`REFERENCES ${fk}`)
    return parts.join(' ')
  })
  const cleanSchema = sanitizeCatalogName(details.schema || '')
  const cleanName = sanitizeCatalogName(details.name)
  const title = cleanSchema ? `${cleanSchema}.${cleanName}` : cleanName
  return { title, cols }
}

function fitDdlToBudget(title: string, cols: readonly string[], budget: number): string {
  if (cols.length === 0) {
    const fallback = `-- table ${title}`
    return fallback.length <= budget ? fallback : ''
  }
  const full = `CREATE TABLE ${title} (${cols.join(', ')});`
  if (full.length <= budget) return full
  const prefix = `CREATE TABLE ${title} (`
  const suffix = ');'
  const kept: string[] = []
  let len = prefix.length + suffix.length
  for (const col of cols) {
    const add = (kept.length > 0 ? 2 : 0) + col.length
    if (len + add > budget) break
    kept.push(col)
    len += add
  }
  if (kept.length > 0) {
    return `${prefix}${kept.join(', ')}${suffix}`
  }
  const fallback = `-- table ${title}`
  return fallback.length <= budget ? fallback : ''
}

/** Emits compact valid SQL `CREATE TABLE ...;` DDL statements for FIM multifile schema context. */
export function buildCompactSqlDdlSchemaBlock(
  snapshot: WorkerSchemaSnapshot | null,
  schemaMap: Record<string, string[]> | undefined,
  referencedTables: string[],
  activeSchema?: string,
  activeTable?: string,
  maxChars = MAX_SCHEMA_CHARS,
  partialTable?: PartialTableReference | null,
  fuzzyTables?: string[],
  referencedCols?: ReadonlySet<string>,
  precomputedPartialMatches?: readonly string[],
  options?: Tier3SchemaOptions
): string {
  const lines: string[] = []
  const usedKeys = new Set<string>()
  const usedBareKeys = new Set<string>()
  let chars = 0

  const markUsed = (k: string, bareLower: string) => {
    usedKeys.add(k)
    usedBareKeys.add(bareLower)
  }

  const pushLine = (line: string): boolean => {
    if (!line) return false
    const sep = lines.length > 0 ? 1 : 0
    if (chars + sep + line.length > maxChars) return false
    lines.push(line)
    chars += sep + line.length
    return true
  }

  const partialMatches =
    precomputedPartialMatches !== undefined
      ? [...precomputedPartialMatches]
      : partialTable
        ? collectPartialTableMatches(snapshot, schemaMap, partialTable, activeSchema)
        : []
  const tier1Names: string[] = []
  const seenTier1 = new Set<string>()
  for (const name of [...partialMatches, ...(fuzzyTables ?? []), ...referencedTables]) {
    const key = name.toLowerCase()
    if (!seenTier1.has(key)) {
      seenTier1.add(key)
      tier1Names.push(name)
    }
  }
  if (tier1Names.length === 0 && activeTable) {
    tier1Names.push(activeSchema ? `${activeSchema}.${activeTable}` : activeTable)
  }

  type Tier1DdlItem =
    | { kind: 'details'; details: TableDetails }
    | { kind: 'map'; title: string; cols: string[] }
  const tier1Items: Tier1DdlItem[] = []
  const tier1Details: TableDetails[] = []

  for (const name of tier1Names) {
    const det = lookupDetails(snapshot, name, activeSchema)
    if (det) {
      const k = `${(det.schema || '').toLowerCase()}.${det.name.toLowerCase()}`
      if (!usedKeys.has(k)) {
        usedKeys.add(k)
        tier1Details.push(det)
        tier1Items.push({ kind: 'details', details: det })
      }
    } else if (schemaMap) {
      const bare = name.includes('.') ? name.split('.').pop() || name : name
      const cols = lookupSchemaMapCols(schemaMap, name, bare)
      if (cols) {
        const bareKey = `.${bare.toLowerCase()}`
        if (!usedKeys.has(bareKey)) {
          usedKeys.add(bareKey)
          const selected = prioritizeColumns(cols, 24, (c) => Boolean(referencedCols?.has(c.toLowerCase())))
          tier1Items.push({
            kind: 'map',
            title: sanitizeCatalogName(bare),
            cols: selected.map(sanitizeCatalogName),
          })
        }
      }
    }
  }

  for (let i = 0; i < tier1Items.length; i++) {
    const remainingBudget = maxChars - chars - 1
    if (remainingBudget <= 0) break
    const remainingCount = tier1Items.length - 1 - i
    const reservedForRest =
      remainingCount > 0 ? Math.min(remainingCount * 180, Math.floor(remainingBudget / 2)) : 0
    const tableBudget = Math.max(140, remainingBudget - reservedForRest)
    const item = tier1Items[i]
    if (item.kind === 'details') {
      const { title, cols } = buildDdlColumnDefs(item.details, 32, true, referencedCols)
      pushLine(fitDdlToBudget(title, cols, Math.min(tableBudget, remainingBudget)))
    } else {
      pushLine(fitDdlToBudget(item.title, item.cols, Math.min(tableBudget, remainingBudget)))
    }
  }

  // Tier 2: 1-hop FK neighbors
  if (snapshot) {
    const tier1Bare = new Set(tier1Details.map((d) => d.name.toLowerCase()))
    const neighborTargets: Array<{ table: string; schema?: string }> = []
    for (const d of tier1Details) {
      for (const fk of d.foreignKeys || []) {
        neighborTargets.push({ table: fk.referencedTable, schema: fk.referencedSchema })
      }
    }
    for (const det of snapshot.details.values()) {
      if ((det.foreignKeys || []).some((fk) => tier1Bare.has(fk.referencedTable.toLowerCase()))) {
        neighborTargets.push({ table: det.name, schema: det.schema })
      }
    }
    for (const target of neighborTargets) {
      const det = lookupDetails(snapshot, target.table, target.schema || activeSchema)
      if (!det) continue
      const k = `${(det.schema || '').toLowerCase()}.${det.name.toLowerCase()}`
      if (usedKeys.has(k)) continue
      usedKeys.add(k)
      const { title, cols } = buildDdlColumnDefs(det, 24, true, referencedCols)
      const remainingBudget = maxChars - chars - 1
      if (remainingBudget <= 0) break
      if (!pushLine(fitDdlToBudget(title, cols, remainingBudget))) break
    }
  }

  // Tier 3: Remaining objects as compact CREATE TABLE statements
  const remaining = new Map<string, { full: string; medium: string; compact: string }>()
  if (snapshot) {
    for (const obj of snapshot.objects) {
      if (obj.kind && obj.kind !== 'table' && obj.kind !== 'view' && obj.kind !== 'materialized_view') {
        continue
      }
      const k = `${(obj.schema || '').toLowerCase()}.${obj.name.toLowerCase()}`
      const bareKey = `.${obj.name.toLowerCase()}`
      if (usedKeys.has(k) || usedKeys.has(bareKey)) continue
      const cleanSchema = sanitizeCatalogName(obj.schema || '')
      const cleanName = sanitizeCatalogName(obj.name)
      const label = cleanSchema ? `${cleanSchema}.${cleanName}` : cleanName
      const det = lookupDetails(snapshot, obj.name, obj.schema)
      if (det && det.columns.length > 0) {
        const fullDefs = buildDdlColumnDefs(det, 8, true).cols
        const medDefs = buildDdlColumnDefs(det, 4, false).cols
        remaining.set(k, {
          full: `CREATE TABLE ${label} (${fullDefs.join(', ')});`,
          medium: `CREATE TABLE ${label} (${medDefs.join(', ')});`,
          compact: `-- table ${label}`,
        })
      } else {
        const cols = (lookupSchemaMapCols(schemaMap, obj.name) ?? []).map(sanitizeCatalogName)
        const top8 = cols.slice(0, 8)
        const top4 = cols.slice(0, 4)
        remaining.set(k, {
          full: top8.length > 0 ? `CREATE TABLE ${label} (${top8.join(', ')});` : `-- table ${label}`,
          medium: top4.length > 0 ? `CREATE TABLE ${label} (${top4.join(', ')});` : `-- table ${label}`,
          compact: `-- table ${label}`,
        })
      }
    }
  }
  if (schemaMap) {
    const usedBareDdl = new Set<string>(
      Array.from(usedKeys).map((k) => (k.includes('.') ? k.split('.').pop() || k : k))
    )
    const remainingBareDdl = new Set<string>(
      Array.from(remaining.keys()).map((k) => (k.includes('.') ? k.split('.').pop() || k : k))
    )
    for (const [tbl, rawCols] of Object.entries(schemaMap)) {
      if (!Array.isArray(rawCols)) continue
      const bare = tbl.includes('.') ? tbl.split('.').pop() || tbl : tbl
      const bareLower = bare.toLowerCase()
      if (usedBareDdl.has(bareLower) || remainingBareDdl.has(bareLower)) {
        continue
      }
      const cols = rawCols.map(sanitizeCatalogName)
      const cleanTbl = sanitizeCatalogName(tbl)
      const top8 = cols.slice(0, 8)
      const top4 = cols.slice(0, 4)
      remainingBareDdl.add(bareLower)
      remaining.set(`.${bareLower}`, {
        full: top8.length > 0 ? `CREATE TABLE ${cleanTbl} (${top8.join(', ')});` : `-- table ${cleanTbl}`,
        medium: top4.length > 0 ? `CREATE TABLE ${cleanTbl} (${top4.join(', ')});` : `-- table ${cleanTbl}`,
        compact: `-- table ${cleanTbl}`,
      })
    }
  }

  const remainingEntries = Array.from(remaining.values())
  const fullSummaryChars = remainingEntries.reduce((sum, entry) => sum + entry.full.length + 1, 0)
  const mediumSummaryChars = remainingEntries.reduce((sum, entry) => sum + entry.medium.length + 1, 0)
  const { tier3Limit, tier3Mode } = resolveTier3Policy(
    chars,
    maxChars,
    tier1Items.length,
    remainingEntries.length,
    fullSummaryChars,
    mediumSummaryChars,
    options
  )
  for (const entry of remainingEntries) {
    const line =
      tier3Mode === 'full' ? entry.full : tier3Mode === 'medium' ? entry.medium : entry.compact
    if (!line || chars + line.length + 1 > tier3Limit) break
    if (!pushLine(line)) break
  }

  return lines.join('\n')
}

export function maskLongStringLiterals(sql: string, dialect?: AiDialect): string {
  const rules = getDialectLexerRules(dialect)
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const isPgEscape =
      rules.postgresEscapeString &&
      (ch === 'E' || ch === 'e') &&
      sql[i + 1] === "'" &&
      isPostgresEscapeStringStart(sql, i, dialect)
    if (ch === "'" || isPgEscape) {
      const quoteStart = isPgEscape ? i + 1 : i
      const seg = scanQuotedSegmentEnd(
        sql,
        quoteStart,
        "'",
        (dialect === undefined ? true : rules.backslashEscapesSingleQuote) || isPgEscape
      )
      if (seg.closed) {
        const innerLen = seg.end - quoteStart - 2
        out += innerLen >= LONG_LITERAL_MIN ? (isPgEscape ? "E'...'" : "'...'") : sql.slice(i, seg.end)
        i = seg.end
        continue
      }
    }
    out += ch
    i += 1
  }
  return out
}

const MONGO_DB_BUILTIN_METHODS = new Set([
  'getcollection',
  'runcommand',
  'admincommand',
  'stats',
  'serverstatus',
  'getsiblingdb',
  'createcollection',
  'dropdatabase',
  'listcollections',
])

interface MongoToken {
  kind: 'ident' | 'num' | 'string' | 'punct' | 'regex' | 'template'
  value: string
}

const MONGO_REGEX_PREFIX_KEYWORDS = new Set([
  'return',
  'typeof',
  'void',
  'delete',
  'throw',
  'case',
  'in',
  'instanceof',
  'new',
  'else',
  'do',
  'yield',
  'await',
])

const MONGO_COMMAND_KEYS = new Set(['find', 'aggregate', 'count', 'distinct'])

function scanJsRegexLiteral(text: string, slashIndex: number): { end: number; closed: boolean } {
  let j = slashIndex + 1
  let inCharClass = false
  while (j < text.length) {
    const ch = text[j]
    if (ch === '\\') {
      if (j + 1 < text.length && text[j + 1] !== '\n' && text[j + 1] !== '\r') {
        j += 2
        continue
      }
      return { end: j + 1, closed: false }
    }
    if (ch === '\n' || ch === '\r') {
      return { end: j, closed: false }
    }
    if (ch === '[') {
      inCharClass = true
      j += 1
      continue
    }
    if (ch === ']' && inCharClass) {
      inCharClass = false
      j += 1
      continue
    }
    if (ch === '/' && !inCharClass) {
      let k = j + 1
      while (k < text.length && /[A-Za-z]/.test(text[k])) k += 1
      return { end: k, closed: true }
    }
    j += 1
  }
  return { end: text.length, closed: false }
}

/**
 * Single-pass JS/MQL lexer shared by Mongo collection extraction and prefix comment checks.
 * Tracks `//`, `/* ... *\/`, strings, nested template `${...}`, and `/regex/flags` vs division `/`.
 */
function scanMongoScript(text: string): { tokens: MongoToken[]; unclosedComment: boolean } {
  const tokens: MongoToken[] = []
  const templateBraceStack: number[] = []
  let canStartRegex = true
  let i = 0

  const advanceTemplateBody = (start: number): { next: number; enteredInterp: boolean } => {
    let j = start
    while (j < text.length) {
      if (text[j] === '\\') {
        j += 2
        continue
      }
      if (text[j] === '`') {
        tokens.push({ kind: 'template', value: '' })
        return { next: j + 1, enteredInterp: false }
      }
      if (text[j] === '$' && text[j + 1] === '{') {
        tokens.push({ kind: 'template', value: '' })
        templateBraceStack.push(1)
        return { next: j + 2, enteredInterp: true }
      }
      j += 1
    }
    return { next: text.length, enteredInterp: false }
  }

  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      const nl = text.indexOf('\n', i + 2)
      if (nl === -1) return { tokens, unclosedComment: true }
      i = nl + 1
      continue
    }
    if (ch === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2)
      if (close === -1) return { tokens, unclosedComment: true }
      i = close + 2
      continue
    }
    if (ch === '/') {
      if (canStartRegex) {
        const rx = scanJsRegexLiteral(text, i)
        tokens.push({ kind: 'regex', value: '' })
        canStartRegex = false
        i = rx.end
        continue
      }
      tokens.push({ kind: 'punct', value: '/' })
      canStartRegex = true
      i += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      const str = scanQuotedString(text, i, ch, { backslashEscape: true, doubledEscape: false })
      const rawInner = str.closed ? text.slice(i + 1, str.end - 1) : text.slice(i + 1)
      tokens.push({ kind: 'string', value: rawInner.replace(/\\(['"\\])/g, '$1') })
      canStartRegex = false
      i = str.end
      continue
    }
    if (ch === '`') {
      const tpl = advanceTemplateBody(i + 1)
      canStartRegex = tpl.enteredInterp
      i = tpl.next
      continue
    }
    if (ch === '}' && templateBraceStack.length > 0) {
      const top = templateBraceStack.length - 1
      templateBraceStack[top] -= 1
      if (templateBraceStack[top] === 0) {
        templateBraceStack.pop()
        const tpl = advanceTemplateBody(i + 1)
        canStartRegex = tpl.enteredInterp
        i = tpl.next
        continue
      }
    }
    if (ch === '{' && templateBraceStack.length > 0) {
      templateBraceStack[templateBraceStack.length - 1] += 1
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1
      while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) end += 1
      const ident = text.slice(i, end)
      tokens.push({ kind: 'ident', value: ident })
      canStartRegex = MONGO_REGEX_PREFIX_KEYWORDS.has(ident)
      i = end
      continue
    }
    if (/[0-9]/.test(ch)) {
      let end = i + 1
      while (end < text.length && /[0-9A-Za-z_.]/.test(text[end])) end += 1
      tokens.push({ kind: 'num', value: text.slice(i, end) })
      canStartRegex = false
      i = end
      continue
    }
    tokens.push({ kind: 'punct', value: ch })
    canStartRegex = ch !== ')' && ch !== ']' && ch !== '}'
    i += 1
  }

  return { tokens, unclosedComment: false }
}

function matchMongoCommandCollection(tokens: readonly MongoToken[], openBraceIdx: number): string | null {
  if (tokens[openBraceIdx]?.kind !== 'punct' || tokens[openBraceIdx].value !== '{') return null
  let j = openBraceIdx + 1
  const expTok = tokens[j]
  if (
    expTok &&
    (expTok.kind === 'ident' || expTok.kind === 'string') &&
    expTok.value.toLowerCase() === 'explain' &&
    tokens[j + 1]?.kind === 'punct' &&
    tokens[j + 1].value === ':' &&
    tokens[j + 2]?.kind === 'punct' &&
    tokens[j + 2].value === '{'
  ) {
    j += 3
  }
  const cmdTok = tokens[j]
  const colTok = tokens[j + 2]
  if (
    cmdTok &&
    (cmdTok.kind === 'ident' || cmdTok.kind === 'string') &&
    MONGO_COMMAND_KEYS.has(cmdTok.value.toLowerCase()) &&
    tokens[j + 1]?.kind === 'punct' &&
    tokens[j + 1].value === ':' &&
    colTok?.kind === 'string'
  ) {
    return colTok.value
  }
  return null
}

export function extractReferencedMongoCollections(text: string): string[] {
  const { tokens } = scanMongoScript(text)
  const found: string[] = []
  const seen = new Set<string>()
  const add = (raw: string) => {
    const clean = raw.trim()
    if (!clean) return
    const key = clean.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      found.push(clean)
    }
  }

  let braceDepth = 0
  let parenDepth = 0
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]
    const prev = i > 0 ? tokens[i - 1] : undefined
    const atTopBoundary =
      braceDepth === 0 &&
      parenDepth === 0 &&
      (!prev || (prev.kind === 'punct' && (prev.value === ';' || prev.value === ')' || prev.value === '}')))

    if (atTopBoundary && t.kind === 'punct' && t.value === '{') {
      const col = matchMongoCommandCollection(tokens, i)
      if (col) add(col)
    }

    if (t.kind === 'punct') {
      if (t.value === '{') braceDepth += 1
      else if (t.value === '}' && braceDepth > 0) braceDepth -= 1
      else if (t.value === '(') parenDepth += 1
      else if (t.value === ')' && parenDepth > 0) parenDepth -= 1
      continue
    }

    if (t.kind === 'ident' && t.value === 'db' && !(prev?.kind === 'punct' && prev.value === '.')) {
      const t1 = tokens[i + 1]
      const t2 = tokens[i + 2]
      const t3 = tokens[i + 3]
      const t4 = tokens[i + 4]
      const t5 = tokens[i + 5]
      if (
        t1?.kind === 'punct' &&
        t1.value === '.' &&
        t2?.kind === 'ident' &&
        t2.value === 'getCollection' &&
        t3?.kind === 'punct' &&
        t3.value === '(' &&
        t4?.kind === 'string' &&
        t5?.kind === 'punct' &&
        t5.value === ')'
      ) {
        add(t4.value)
        continue
      }
      if (
        t1?.kind === 'punct' &&
        t1.value === '.' &&
        t2?.kind === 'ident' &&
        t2.value.toLowerCase() === 'runcommand' &&
        t3?.kind === 'punct' &&
        t3.value === '('
      ) {
        const col = matchMongoCommandCollection(tokens, i + 4)
        if (col) add(col)
        continue
      }
      if (t1?.kind === 'punct' && t1.value === '[' && t2?.kind === 'string' && t3?.kind === 'punct' && t3.value === ']') {
        add(t2.value)
        continue
      }
      if (
        t1?.kind === 'punct' &&
        t1.value === '.' &&
        t2?.kind === 'ident' &&
        t3?.kind === 'punct' &&
        t3.value === '.' &&
        !MONGO_DB_BUILTIN_METHODS.has(t2.value.toLowerCase())
      ) {
        add(t2.value)
      }
    }
  }
  return found
}

function bareLowerTableName(name: string): string {
  const trimmed = name.trim()
  const bare = trimmed.includes('.') ? trimmed.split('.').pop() || trimmed : trimmed
  return bare.toLowerCase()
}

export function compactHistorySql(sql: string, maxLen = 220): string {
  if (sql.length <= maxLen) return sql
  const clauseMatch = /\b(FROM|JOIN)\b/i.exec(sql)
  if (clauseMatch && clauseMatch.index > 140) {
    const selMatch = /^\s*SELECT\s+/i.exec(sql)
    if (selMatch) {
      const compacted = `${selMatch[0]}... ${sql.slice(clauseMatch.index)}`
      return compacted.slice(0, maxLen)
    }
  }
  return sql.slice(0, maxLen)
}

export interface HistoryBudgetOptions {
  maxItems?: number
  maxChars?: number
}

export function selectRelevantHistory(
  historyEntries: readonly QueryHistoryEntry[] | undefined,
  connectionId: string | undefined,
  dialect: AiDialect,
  exactTables: readonly string[],
  expandedTables: readonly string[] = [],
  budget?: HistoryBudgetOptions
): string[] {
  if (!historyEntries || !connectionId || dialect === 'redis') return []
  const exactSet = new Set(exactTables.map(bareLowerTableName).filter(Boolean))
  const expandedSet = new Set(
    expandedTables.map(bareLowerTableName).filter((t) => Boolean(t) && !exactSet.has(t))
  )
  if (exactSet.size === 0 && expandedSet.size === 0) return []

  const seen = new Set<string>()
  const scored: Array<{ sql: string; score: number; idx: number }> = []

  for (let idx = 0; idx < historyEntries.length; idx++) {
    const entry = historyEntries[idx]
    if (!entry || entry.connectionId !== connectionId || entry.isError) continue
    if (hasSensitiveContent(entry.sql, '', '', dialect)) continue
    const masked = maskLongStringLiterals(entry.sql.replace(/\s+/g, ' ').trim())
    if (!masked) continue
    const normKey = masked.toLowerCase()
    if (seen.has(normKey)) continue
    seen.add(normKey)

    const rawEntryTables =
      dialect === 'mongodb'
        ? extractReferencedMongoCollections(masked)
        : extractReferencedTables(masked, dialect)
    const entryTables = new Set(rawEntryTables.map(bareLowerTableName).filter(Boolean))

    let score = 0
    for (const tbl of exactSet) {
      if (entryTables.has(tbl)) score += 2
    }
    for (const tbl of expandedSet) {
      if (entryTables.has(tbl)) score += 1
    }
    if (score === 0) continue

    scored.push({ sql: compactHistorySql(masked, 220), score, idx })
  }

  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.idx - b.idx))

  const maxItems = resolveNonNegativeIntBudget(budget?.maxItems, MAX_HISTORY_ITEMS)
  const maxChars = resolveNonNegativeIntBudget(budget?.maxChars, MAX_HISTORY_CHARS)
  const chosen: string[] = []
  let chars = 0
  for (const item of scored) {
    if (chosen.length >= maxItems) break
    if (chars + item.sql.length + 1 > maxChars) continue
    chosen.push(item.sql)
    chars += item.sql.length + 1
  }
  return chosen
}

const DIALECT_LABELS: Record<string, string> = {
  postgres: 'PostgreSQL',
  cockroachdb: 'CockroachDB (PostgreSQL-compatible)',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  clickhouse: 'ClickHouse',
  sqlite: 'SQLite',
  libsql: 'LibSQL / SQLite',
  d1: 'Cloudflare D1 (SQLite)',
  redis: 'Redis RESP2',
  mssql: 'T-SQL (SQL Server)',
  oracle: 'Oracle SQL / PL/SQL',
  mongodb: 'MongoDB Shell / MQL',
}

function dialectLabel(dialect: AiDialect): string {
  const key = String(dialect)
  return Object.hasOwn(DIALECT_LABELS, key) ? DIALECT_LABELS[key] : key
}

/** Dialect-aware comment check so Mongo regexes/comments, MSSQL `[...]`, and Oracle `q'...'` do not misclassify cursor state. */
export function isPrefixInComment(prefix: string, dialect?: AiDialect): boolean {
  if (dialect === 'mongodb') {
    return scanMongoScript(prefix).unclosedComment
  }
  const rules = getDialectLexerRules(dialect)
  let i = 0
  const len = prefix.length
  while (i < len) {
    const ch = prefix[i]
    const next = prefix[i + 1]
    if (rules.lineCommentDash && ch === '-' && next === '-') {
      const end = scanLineCommentEnd(prefix, i)
      if (end >= len && prefix[len - 1] !== '\n' && prefix[len - 1] !== '\r') return true
      i = end
      continue
    }
    if (rules.lineCommentHash && ch === '#') {
      const end = scanLineCommentEnd(prefix, i - 1)
      if (end >= len && prefix[len - 1] !== '\n' && prefix[len - 1] !== '\r') return true
      i = end
      continue
    }
    if (rules.lineCommentSlash && ch === '/' && next === '/') {
      const end = scanLineCommentEnd(prefix, i)
      if (end >= len && prefix[len - 1] !== '\n' && prefix[len - 1] !== '\r') return true
      i = end
      continue
    }
    if (ch === '/' && next === '*') {
      const end = scanBlockCommentEnd(prefix, i, rules.nestedBlockComments)
      if (end >= len && !prefix.slice(i + 2).endsWith('*/')) return true
      i = end
      continue
    }
    if (rules.bracketIdentifiers !== 'none' && ch === '[') {
      i = scanBracketIdentEnd(prefix, i, rules.bracketIdentifiers === 'doubling').end
      continue
    }
    if (rules.oracleQQuote) {
      const qMatch = scanOracleQuoteEnd(prefix, i, dialect)
      if (qMatch) {
        i = qMatch.end
        continue
      }
    }
    if ((rules.dollarQuoting || dialect === undefined) && ch === '$') {
      const tag = matchDollarQuoteTag(prefix, i)
      if (tag) {
        const closeAt = prefix.indexOf(tag, i + tag.length)
        if (closeAt === -1) return false
        i = closeAt + tag.length
        continue
      }
    }
    if (
      rules.postgresEscapeString &&
      (ch === 'E' || ch === 'e') &&
      next === "'" &&
      isPostgresEscapeStringStart(prefix, i, dialect)
    ) {
      i = scanQuotedSegmentEnd(prefix, i + 1, "'", true).end
      continue
    }
    if (ch === "'") {
      i = scanQuotedSegmentEnd(prefix, i, "'", rules.backslashEscapesSingleQuote).end
      continue
    }
    if (ch === '"' && rules.doubleQuoteIdentifiers) {
      i = scanQuotedSegmentEnd(prefix, i, '"', rules.backslashEscapesDoubleQuote).end
      continue
    }
    if (ch === '`' && rules.backtickIdentifiers) {
      i = scanQuotedSegmentEnd(prefix, i, '`', false).end
      continue
    }
    i += 1
  }
  return false
}

export interface BuildSqlCompletionContextInput {
  connectionId?: string
  dialect: AiDialect
  prefix: string
  suffix: string
  fullPrefix?: string
  activeSchema?: string
  activeTable?: string
  snapshot: WorkerSchemaSnapshot | null
  schemaMap?: Record<string, string[]>
  historyEntries?: readonly QueryHistoryEntry[]
  fuzzyTables?: string[]
  schemaBudget?: SchemaContextBudget
  historyBudget?: HistoryBudgetOptions
  skipFimDdl?: boolean
}

export interface BuildSqlStatementEditContextInput {
  connectionId?: string
  dialect: AiDialect
  statementBeforeCursor: string
  statementAfterCursor: string
  activeSchema?: string
  activeTable?: string
  snapshot: WorkerSchemaSnapshot | null
  schemaMap?: Record<string, string[]>
  historyEntries?: readonly QueryHistoryEntry[]
  fuzzyTables?: string[]
  cursorAfterSemicolon?: boolean
  schemaBudget?: SchemaContextBudget
  historyBudget?: HistoryBudgetOptions
}

export interface BuiltSqlStatementEditContext {
  system: string
  user: string
  referencedTables: string[]
}

export interface BuiltSqlCompletionContext {
  system: string
  user: string
  fimPrefix: string
  fimSuffix: string
  fimSchemaDdl: string
  fimHistorySql: string
  priorTabSql: string
  referencedTables: string[]
  multiline: boolean
  inComment: boolean
}

function splitHistoryTargetTables(
  referencedTables: string[],
  partialTable: PartialTableReference | null,
  partialMatches: string[],
  snapshot: WorkerSchemaSnapshot | null,
  activeSchema: string | undefined,
  fuzzyTables: readonly string[] | undefined
): { exactTables: string[]; expandedTables: string[] } {
  const partialLower = partialTable ? partialTable.partial.toLowerCase() : ''
  const isExactPartial =
    partialTable !== null &&
    partialLower.length > 0 &&
    (partialMatches.some((m) => bareLowerTableName(m) === partialLower) ||
      lookupDetails(snapshot, partialTable.partial, activeSchema) !== undefined)
  const exactTables =
    partialMatches.length > 0 && !isExactPartial
      ? referencedTables.filter((t) => bareLowerTableName(t) !== partialLower)
      : referencedTables
  const expandedTables = [...partialMatches, ...(fuzzyTables ?? [])]
  return { exactTables, expandedTables }
}

interface PreparedContextSchemaAndHistory {
  referencedTables: string[]
  schemaBlock: string
  fimSchemaDdl: string
  recent: string[]
}

function prepareContextSchemaAndHistory(opts: {
  statementText: string
  partialSearchPrefix: string
  skipReferences?: boolean
  connectionId?: string
  dialect: AiDialect
  activeSchema?: string
  activeTable?: string
  snapshot: WorkerSchemaSnapshot | null
  schemaMap?: Record<string, string[]>
  historyEntries?: readonly QueryHistoryEntry[]
  fuzzyTables?: string[]
  schemaBudget?: SchemaContextBudget
  historyBudget?: HistoryBudgetOptions
  skipFimDdl?: boolean
}): PreparedContextSchemaAndHistory {
  const referencedTables =
    opts.dialect === 'redis' || opts.skipReferences
      ? []
      : opts.dialect === 'mongodb'
        ? extractReferencedMongoCollections(opts.statementText)
        : extractReferencedTables(opts.statementText, opts.dialect)
  const partialTable = opts.skipReferences
    ? null
    : extractTrailingPartialTableName(opts.partialSearchPrefix, opts.dialect)
  const partialMatches =
    opts.dialect !== 'redis' && partialTable
      ? collectPartialTableMatches(opts.snapshot, opts.schemaMap, partialTable, opts.activeSchema)
      : []
  const referencedCols = opts.skipReferences
    ? undefined
    : extractReferencedColumnTokens(opts.statementText, opts.dialect)

  const maxSchemaChars =
    typeof opts.schemaBudget?.maxChars === 'number' &&
    Number.isFinite(opts.schemaBudget.maxChars) &&
    opts.schemaBudget.maxChars > 0
      ? Math.floor(opts.schemaBudget.maxChars)
      : MAX_SCHEMA_CHARS
  const tier3Options: Tier3SchemaOptions | undefined =
    opts.schemaBudget &&
    (opts.schemaBudget.compactTier3WhenReferenced !== undefined ||
      opts.schemaBudget.maxTier3Chars !== undefined)
      ? {
          compactTier3WhenReferenced: opts.schemaBudget.compactTier3WhenReferenced,
          maxTier3Chars: opts.schemaBudget.maxTier3Chars,
        }
      : undefined

  const schemaBlock =
    opts.dialect === 'redis'
      ? ''
      : buildPrunedSchemaBlock(
          opts.snapshot,
          opts.schemaMap,
          referencedTables,
          opts.activeSchema,
          opts.activeTable,
          maxSchemaChars,
          partialTable,
          opts.fuzzyTables,
          referencedCols,
          partialMatches,
          tier3Options
        )

  const fimSchemaDdl =
    opts.skipFimDdl || opts.dialect === 'redis' || opts.dialect === 'mongodb'
      ? ''
      : buildCompactSqlDdlSchemaBlock(
          opts.snapshot,
          opts.schemaMap,
          referencedTables,
          opts.activeSchema,
          opts.activeTable,
          maxSchemaChars,
          partialTable,
          opts.fuzzyTables,
          referencedCols,
          partialMatches,
          tier3Options
        )

  const { exactTables, expandedTables } = splitHistoryTargetTables(
    referencedTables,
    partialTable,
    partialMatches,
    opts.snapshot,
    opts.activeSchema,
    opts.fuzzyTables
  )
  const recent = selectRelevantHistory(
    opts.historyEntries,
    opts.connectionId,
    opts.dialect,
    exactTables,
    expandedTables,
    {
      maxItems: resolveNonNegativeIntBudget(opts.historyBudget?.maxItems, COMPLETION_HISTORY_ITEMS),
      maxChars: resolveNonNegativeIntBudget(opts.historyBudget?.maxChars, COMPLETION_HISTORY_CHARS),
    }
  )
  return { referencedTables, schemaBlock, fimSchemaDdl, recent }
}

function formatFimHistorySql(recent: readonly string[], dialect: AiDialect): string {
  if (dialect === 'redis' || dialect === 'mongodb' || recent.length === 0) return ''
  return recent
    .map((q) => q.trim())
    .filter(Boolean)
    .map((q) => (q.endsWith(';') ? q : `${q};`))
    .join('\n')
}

function extractSafePriorTabSql(
  rawFullPrefix: string,
  activeStmtPrefix: string,
  dialect: AiDialect
): string {
  if (!rawFullPrefix || rawFullPrefix.length <= activeStmtPrefix.length) return ''
  const precedingRaw = rawFullPrefix.slice(0, rawFullPrefix.length - activeStmtPrefix.length).trim()
  if (!precedingRaw) return ''
  if (dialect === 'redis') {
    const safeLines: string[] = []
    let chars = 0
    for (const line of precedingRaw.split(/\r?\n/).reverse()) {
      const clean = line.trim()
      if (!clean || hasSensitiveContent(clean, '', '', dialect)) continue
      if (chars + clean.length + 1 > MAX_PRIOR_TAB_SQL_CHARS) break
      safeLines.unshift(clean)
      chars += clean.length + 1
    }
    const joined = safeLines.join('\n')
    return joined && !hasSensitiveContent(joined, '', '', dialect) ? joined : ''
  }
  const stmts = splitSqlStatements(precedingRaw, dialect)
  const candidates: string[] =
    stmts.length > 0 ? stmts.map((slice) => slice.text) : [precedingRaw]
  const kept: string[] = []
  let chars = 0
  for (let i = candidates.length - 1; i >= 0; i--) {
    const rawStmt = candidates[i]?.trim() ?? ''
    if (!rawStmt || hasSensitiveContent(rawStmt, '', '', dialect)) continue
    const masked = maskLongStringLiterals(rawStmt.replace(/\s+/g, ' ').trim(), dialect)
    if (!masked || hasSensitiveContent(masked, '', '', dialect)) continue
    const formatted = masked.endsWith(';') ? masked : `${masked};`
    if (chars + formatted.length + 1 > MAX_PRIOR_TAB_SQL_CHARS) {
      if (kept.length === 0) {
        const tail = formatted.slice(-MAX_PRIOR_TAB_SQL_CHARS).trim()
        if (tail && !hasSensitiveContent(tail, '', '', dialect)) {
          kept.unshift(tail)
        }
      }
      break
    }
    kept.unshift(formatted)
    chars += formatted.length + 1
  }
  const out = kept.join('\n')
  return out && !hasSensitiveContent(out, '', '', dialect) ? out : ''
}

export function buildSqlCompletionContext(
  input: BuildSqlCompletionContextInput
): BuiltSqlCompletionContext {
  const isolated = isolateActiveSqlStatement(input.prefix, input.suffix, input.dialect)
  const prefixWin = isolated.stmtPrefix.slice(-INLINE_PREFIX_CHARS)
  const suffixWin = isolated.stmtSuffix.slice(0, INLINE_SUFFIX_CHARS)
  const activeStatement = isolated.isFreshStatementAfterSemicolon ? '' : isolated.text
  const fullIsolated =
    input.fullPrefix !== undefined
      ? isolateActiveSqlStatement(input.fullPrefix, input.suffix, input.dialect)
      : isolated
  const priorSql = extractSafePriorTabSql(
    input.fullPrefix ?? input.prefix,
    fullIsolated.stmtPrefix,
    input.dialect
  )
  const { referencedTables, schemaBlock, fimSchemaDdl, recent } = prepareContextSchemaAndHistory({
    statementText: activeStatement,
    partialSearchPrefix: prefixWin,
    skipReferences: isolated.isFreshStatementAfterSemicolon,
    connectionId: input.connectionId,
    dialect: input.dialect,
    activeSchema: input.activeSchema,
    activeTable: input.activeTable,
    snapshot: input.snapshot,
    schemaMap: input.schemaMap,
    historyEntries: input.historyEntries,
    fuzzyTables: input.fuzzyTables,
    schemaBudget: input.schemaBudget,
    historyBudget: input.historyBudget,
    skipFimDdl: input.skipFimDdl,
  })

  const engineName = dialectLabel(input.dialect)
  const system =
    input.dialect === 'redis'
      ? `You are a ${engineName} HOLE FILLER. Fill the ${CURSOR} hole inside <COMPLETION>...</COMPLETION> with ONLY the exact raw characters to insert at ${CURSOR}. Never wrap in backticks or markdown, never repeat text before or after ${CURSOR}, no explanation.\nExample:\n<QUERY>HGET user:10 <CURSOR></QUERY> -> <COMPLETION>email</COMPLETION>`
      : input.dialect === 'mongodb'
        ? `You are a ${engineName} HOLE FILLER. Fill the ${CURSOR} hole inside <COMPLETION>...</COMPLETION> with ONLY the exact raw MongoDB Shell / MQL to insert at ${CURSOR}, grounded strictly in the provided Schema collections and fields. Never invent collections or fields absent from Schema, never invent arbitrary literal filter values absent from the current query, Recent history, or Prior SQL, never wrap in backticks or markdown, never repeat text before or after ${CURSOR}, no prose.`
        : `You are a ${engineName} SQL HOLE FILLER. Fill the ${CURSOR} hole inside <COMPLETION>...</COMPLETION> with ONLY the exact raw SQL characters to insert at ${CURSOR}, grounded strictly in the provided Schema tables, columns, and foreign keys. Never invent tables or columns absent from Schema, never wrap in backticks or markdown fences, never repeat text already before or after ${CURSOR}, no prose.\nRules:\n1) Complete partial identifiers from Schema without repeating already-typed characters (e.g. <QUERY>SELECT * FROM <tbl_pre><CURSOR></QUERY> -> <COMPLETION><tbl_rest></COMPLETION>).\n2) Keep existing quoting style when inside quotes (e.g. <QUERY>SELECT * FROM "<tbl_pre><CURSOR></QUERY> -> <COMPLETION><tbl_rest>"</COMPLETION>).\n3) Prefer JOIN/ON/ORDER BY/GROUP BY clauses and structural predicates (e.g. IS NULL / IS NOT NULL) using real columns and foreign keys from Schema; stop cleanly at the end of the current clause or statement.\n4) NEVER fabricate or guess arbitrary literal filter values (such as dummy IDs like '1234567890', fake dates, emails, or speculative WHERE filters). Only reuse concrete literal values that already appear in the current query, Recent query history, or Prior SQL in tab; otherwise stop before inventing unrequested WHERE conditions.`

  const sqlLang = input.dialect === 'mongodb' ? 'javascript' : input.dialect === 'redis' ? 'text' : 'sql'
  const parts: string[] = [`Dialect: ${engineName}`]
  if (schemaBlock) {
    parts.push(`Schema:\n${fencePromptBlock(schemaBlock, 'text')}`)
  }
  if (recent.length > 0) {
    parts.push(`Recent:\n${fencePromptBlock(recent.map((q) => `- ${q}`).join('\n'), 'text')}`)
  }
  if (priorSql) {
    parts.push(`Prior SQL in tab:\n${fencePromptBlock(priorSql, sqlLang)}`)
  }
  parts.push(
    `<QUERY>\n${prefixWin}${CURSOR}${suffixWin}\n</QUERY>\nTASK: Fill the ${CURSOR} hole using Schema and Recent history. Never invent dummy literal values; reply ONLY with <COMPLETION>...</COMPLETION>.`
  )
  const user = parts.join('\n\n')

  const commentLines: string[] = [`Dialect: ${engineName}`]
  if (schemaBlock) {
    commentLines.push('Schema:', ...schemaBlock.split('\n'))
  }
  if (recent.length > 0) {
    commentLines.push('Recent:', ...recent)
  }
  if (priorSql) {
    commentLines.push('Prior SQL:', ...priorSql.split('\n'))
  }
  const fimHeader =
    input.dialect === 'redis'
      ? commentLines.map((l) => `# ${l}`).join('\n') + '\n'
      : `/*\n${commentLines.join('\n').replace(/\*\//g, '* /')}\n*/\n`

  const suffixNewline = isolated.stmtSuffix.indexOf('\n')
  const currentLineSuffix = isolated.stmtSuffix.slice(
    0,
    suffixNewline === -1 ? isolated.stmtSuffix.length : suffixNewline
  )
  const isLineEnd = /^\s*[);]*\s*$/.test(currentLineSuffix)
  const inComment = isPrefixInComment(isolated.stmtPrefix, input.dialect)
  const multiline = isLineEnd && !inComment

  return {
    system,
    user,
    fimPrefix: `${fimHeader}${prefixWin}`.slice(-AI_PREFIX_CHARS),
    fimSuffix: suffixWin,
    fimSchemaDdl,
    fimHistorySql: formatFimHistorySql(recent, input.dialect),
    priorTabSql: priorSql,
    referencedTables,
    multiline,
    inComment,
  }
}

/** Builds a few-shot `<STATEMENT>` -> `<REWRITE>` context for Mini-NEP statement editing. */
export function buildSqlStatementEditContext(
  input: BuildSqlStatementEditContextInput
): BuiltSqlStatementEditContext {
  const combined = `${input.statementBeforeCursor}${input.statementAfterCursor}`
  const { referencedTables, schemaBlock, recent } = prepareContextSchemaAndHistory({
    statementText: combined,
    partialSearchPrefix: input.statementBeforeCursor,
    connectionId: input.connectionId,
    dialect: input.dialect,
    activeSchema: input.activeSchema,
    activeTable: input.activeTable,
    snapshot: input.snapshot,
    schemaMap: input.schemaMap,
    historyEntries: input.historyEntries,
    fuzzyTables: input.fuzzyTables ?? [],
    schemaBudget: input.schemaBudget,
    historyBudget: input.historyBudget,
    skipFimDdl: true,
  })

  const engineName = dialectLabel(input.dialect)
  const systemLines = [
    `You are a ${engineName} SQL STATEMENT EDITOR & COMPLETION ENGINE.`,
    `You receive a SQL statement containing ${CURSOR} inside <STATEMENT>...</STATEMENT>.`,
    'Rules:',
    '1) Fix any misspelled SQL keywords, syntax errors, wrong table/column names using Schema, and identifiers/keywords accidentally split by spaces (e.g. FR OM -> FROM, "c  l" -> "col").',
    `2) Fix any error at or near ${CURSOR} in place; replace ${CURSOR} with natural SQL continuation only where incomplete (DO NOT output ${CURSOR} anywhere). If the statement is already terminated by \`;\`, fix any typos/syntax/schema errors in place while keeping the trailing \`;\` and do NOT append a second statement after \`;\`.`,
    "3) Preserve the user's exact keyword casing where already valid, whitespace/newlines, indentation, table aliases, and unrelated literals.",
    '4) Ground every table, column, and join predicate strictly in Schema; never invent tables, columns, speculative WHERE filters, or fabricated literal values (such as dummy IDs, dates, or strings) absent from the statement or Recent history.',
    '5) Reply ONLY with <REWRITE>...</REWRITE> containing raw SQL. No markdown fences, no prose.',
    'Examples:',
    `1) <STATEMENT>SELECT * FORM <tbl_typo> WHERE ${CURSOR}</STATEMENT> -> <REWRITE>SELECT * FROM <tbl_from_schema> WHERE <col_from_schema> = <value>;</REWRITE>`,
    `2) <STATEMENT>select t.id, t.<col_typo>\nfrom <tbl_from_schema> t\nwhere t.${CURSOR}</STATEMENT> -> <REWRITE>select t.id, t.<col_from_schema>\nfrom <tbl_from_schema> t\nwhere t.<col_from_schema> = <value></REWRITE>`,
    `3) <STATEMENT>SLECT id, <col_typo> FROM <tbl_from_schema> ${CURSOR} LIMIT 10;</STATEMENT> -> <REWRITE>SELECT id, <col_from_schema> FROM <tbl_from_schema> WHERE <col_from_schema> IS NOT NULL LIMIT 10;</REWRITE>`,
    `4) <STATEMENT>SELECT "<col_a>", "c  ${CURSOR}b" FROM <tbl_from_schema></STATEMENT> -> <REWRITE>SELECT "<col_a>", "<col_b>" FROM <tbl_from_schema></REWRITE>`,
    `5) <STATEMENT>SLECT * FORM <tbl_typo>;${CURSOR}</STATEMENT> -> <REWRITE>SELECT * FROM <tbl_from_schema>;</REWRITE>`,
  ]
  const system = systemLines.join('\n')

  const taskLine = input.cursorAfterSemicolon
    ? 'TASK: The statement is already terminated by `;`. Fix any typos/syntax/schema errors using Schema while keeping the trailing `;`, and DO NOT append a second statement after `;`. Reply ONLY with <REWRITE>...</REWRITE>.'
    : `TASK: Fix any typos/syntax/schema errors using Schema and replace ${CURSOR} with continuation. Reply ONLY with <REWRITE>...</REWRITE>.`

  const user = [
    `Dialect: ${engineName}`,
    ...(schemaBlock ? [`Schema:\n${fencePromptBlock(schemaBlock, 'text')}`] : []),
    ...(recent.length > 0
      ? [`Recent:\n${fencePromptBlock(recent.map((q) => `- ${q}`).join('\n'), 'text')}`]
      : []),
    `<STATEMENT>\n${input.statementBeforeCursor}${CURSOR}${input.statementAfterCursor}\n</STATEMENT>\n${taskLine}`,
  ].join('\n\n')

  return {
    system,
    user,
    referencedTables,
  }
}

const LANGUAGE_LABELS: Record<Exclude<AiExplainLanguage, 'auto'>, string> = {
  vi: 'Vietnamese (Tiếng Việt)',
  en: 'English',
  ja: 'Japanese (日本語)',
  zh: 'Simplified Chinese (中文)',
  ko: 'Korean (한국어)',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
  de: 'German (Deutsch)',
  pt: 'Portuguese (Português)',
}

export function resolveExplainLanguage(
  code: string | undefined,
  uiLocale?: string
): { code: string; label: string } {
  if (code && code !== 'auto' && Object.hasOwn(LANGUAGE_LABELS, code)) {
    const key = code as Exclude<AiExplainLanguage, 'auto'>
    return { code: key, label: LANGUAGE_LABELS[key] }
  }
  const tag = (
    uiLocale ||
    (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().locale : 'en') ||
    'en'
  )
    .trim()
    .toLowerCase()
  const base = tag.split(/[-_]/)[0]
  if (Object.hasOwn(LANGUAGE_LABELS, base)) {
    const key = base as Exclude<AiExplainLanguage, 'auto'>
    return { code: key, label: LANGUAGE_LABELS[key] }
  }
  return { code: 'en', label: LANGUAGE_LABELS.en }
}

const PLAN_SECRET_ASSIGN_RE =
  /((?:pass(?:word|wd)?|(?<![a-zA-Z])pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key|token)["']?\s*[:=]\s*["'])([^"'\r\n]+)(["'])/gi

function redactSecretLiteralsForPrompt(text: string): string {
  const scrubbed = scrubSensitiveText(text)
  return scrubbed.replace(PLAN_SECRET_ASSIGN_RE, '$1[REDACTED]$3')
}

function tryMinifyPlanJsonText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
    return text
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return JSON.stringify(parsed, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) ?? text
  } catch {
    return text
  }
}

function safeSerializePlanCell(cell: unknown): string {
  if (cell === null || cell === undefined) return 'NULL'
  if (typeof cell === 'bigint') return cell.toString()
  let txt: string
  if (typeof cell === 'object') {
    try {
      txt = JSON.stringify(cell, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) ?? ''
    } catch {
      txt = String(cell)
    }
  } else if (typeof cell === 'string') {
    txt = tryMinifyPlanJsonText(cell)
  } else {
    txt = String(cell)
  }
  return redactSecretLiteralsForPrompt(txt.replace(/\r?\n/g, ' '))
}

function summarizeParsedExplainPlan(plan: ParsedExplainPlan, maxChars = MAX_PLAN_CHARS): string {
  const lines: string[] = []
  const metaParts: string[] = [`format=${plan.format}`]
  if (plan.planningTimeMs !== undefined && plan.planningTimeMs !== null) {
    metaParts.push(`planningMs=${plan.planningTimeMs}`)
  }
  if (plan.executionTimeMs !== undefined && plan.executionTimeMs !== null) {
    metaParts.push(`executionMs=${plan.executionTimeMs}`)
  }
  if (plan.totalCost !== undefined && plan.totalCost !== null) {
    metaParts.push(`totalCost=${plan.totalCost}`)
  }
  lines.push(metaParts.join(' '))
  if (Array.isArray(plan.warnings) && plan.warnings.length > 0) {
    lines.push(`warnings=${plan.warnings.join(', ')}`)
  }
  const visit = (node: NonNullable<ParsedExplainPlan['root']>, depth: number): void => {
    if (lines.join('\n').length >= maxChars) return
    const indent = '  '.repeat(Math.min(depth, 10))
    const parts: string[] = [node.nodeType]
    if (node.relation) parts.push(`on ${sanitizeCatalogName(node.relation)}`)
    if (node.indexName) parts.push(`using ${sanitizeCatalogName(node.indexName)}`)
    if (typeof node.totalCost === 'number') parts.push(`cost=${node.totalCost}`)
    if (typeof node.actualTotalTimeMs === 'number') parts.push(`timeMs=${node.actualTotalTimeMs}`)
    if (typeof node.planRows === 'number') parts.push(`estRows=${node.planRows}`)
    if (typeof node.totalActualRows === 'number') parts.push(`actRows=${node.totalActualRows}`)
    else if (typeof node.actualRows === 'number') parts.push(`actRows=${node.actualRows}`)
    if (node.warnings && node.warnings.length > 0) parts.push(`[${node.warnings.join('; ')}]`)
    lines.push(`${indent}- ${parts.join(' ')}`)
    for (const child of node.children || []) {
      visit(child, depth + 1)
    }
  }
  if (plan.root) {
    visit(plan.root, 0)
  } else if (plan.rawText) {
    lines.push(redactSecretLiteralsForPrompt(tryMinifyPlanJsonText(plan.rawText)))
  }
  const out = lines.join('\n')
  return out.length > maxChars ? `${out.slice(0, maxChars - 24)}\n... (plan truncated)` : out
}

const MAX_PLAN_SERIALIZE_COLUMNS = 128
const MAX_PLAN_SERIALIZE_ROWS = 2_000

function serializePlanTable(
  columns: { name: string; type: string }[],
  rows: unknown[][],
  explainPlan?: ParsedExplainPlan
): string {
  if (!columns.length && !rows.length) {
    if (explainPlan) return summarizeParsedExplainPlan(explainPlan, MAX_PLAN_CHARS)
    return '(no plan rows returned)'
  }
  const boundedCols = columns.slice(0, MAX_PLAN_SERIALIZE_COLUMNS)
  const rawHeader = boundedCols.map((c) => sanitizeCatalogName(c?.name || 'col') || 'col').join(' | ')
  const header = rawHeader.length > MAX_PLAN_CHARS ? rawHeader.slice(0, MAX_PLAN_CHARS) : rawHeader
  const truncationNote = '... (plan output truncated)'
  const lines: string[] = [header]
  let chars = header.length + 1
  let truncated = false
  const maxRows = Math.min(rows.length, MAX_PLAN_SERIALIZE_ROWS)
  for (let rowIdx = 0; rowIdx < maxRows; rowIdx++) {
    const row = rows[rowIdx]
    if (!Array.isArray(row)) continue
    const maxCells = Math.min(row.length, MAX_PLAN_SERIALIZE_COLUMNS)
    const cells: string[] = []
    let rowChars = 0
    for (let colIdx = 0; colIdx < maxCells; colIdx++) {
      const cellStr = safeSerializePlanCell(row[colIdx])
      cells.push(cellStr)
      rowChars += cellStr.length + (colIdx > 0 ? 3 : 0)
      if (chars + rowChars + 1 > MAX_PLAN_CHARS) break
    }
    const line = cells.join(' | ')
    if (chars + line.length + 1 > MAX_PLAN_CHARS) {
      // Preserve as much of row 0 as fits (critical for single-row Postgres EXPLAIN FORMAT JSON)
      if (lines.length === 1) {
        const room = MAX_PLAN_CHARS - chars - truncationNote.length - 2
        if (room > 32) {
          lines.push(line.slice(0, room))
        }
      }
      lines.push(truncationNote)
      truncated = true
      break
    }
    lines.push(line)
    chars += line.length + 1
  }
  const rawSerialized = lines.join('\n')
  if (truncated && explainPlan?.root) {
    return summarizeParsedExplainPlan(explainPlan, MAX_PLAN_CHARS)
  }
  return rawSerialized
}

export interface BuildExplainAnalysisPromptInput {
  dialect: AiDialect
  sql: string
  planColumns: { name: string; type: string }[]
  planRows: unknown[][]
  explainPlan?: ParsedExplainPlan
  snapshot: WorkerSchemaSnapshot | null
  activeSchema?: string
  language?: AiExplainLanguage
  uiLocale?: string
}

export function buildExplainAnalysisPrompt(input: BuildExplainAnalysisPromptInput): {
  system: string
  user: string
  resolvedLanguage: { code: string; label: string }
  referencedTables: string[]
} {
  const resolvedLanguage = resolveExplainLanguage(input.language, input.uiLocale)
  const engineName = dialectLabel(input.dialect)
  const planText = serializePlanTable(input.planColumns, input.planRows, input.explainPlan)
  const isAnalyze =
    input.dialect === 'mongodb'
      ? /executionStats|nReturned|executionTimeMillis/i.test(planText)
      : input.dialect !== 'redis' &&
        (hasExplainAnalyzeOption(input.sql, input.dialect) ||
          /actual time=|Execution Time:/i.test(planText))

  const referencedTables =
    input.dialect === 'redis'
      ? []
      : input.dialect === 'mongodb'
        ? extractReferencedMongoCollections(input.sql)
        : extractReferencedTables(input.sql, input.dialect)
  const schemaBlock =
    input.dialect === 'redis'
      ? ''
      : buildPrunedSchemaBlock(
          input.snapshot,
          undefined,
          referencedTables,
          input.activeSchema,
          undefined,
          MAX_EXPLAIN_SCHEMA_CHARS
        )

  const engineRule =
    input.dialect === 'redis'
      ? 'This is a Redis command diagnostic. Suggest safer/faster Redis command alternatives (e.g., SCAN instead of KEYS, pipelining) and set indexSuggestions to []. Never suggest SQL CREATE INDEX.'
      : input.dialect === 'mongodb'
        ? 'This is a MongoDB diagnostic. Use MongoDB execution stages (COLLSCAN, IXSCAN, FETCH, SHARD_MERGE) and suggest db.<collection>.createIndex(...) for indexSuggestions[].ddl and MQL for optimizedSql.'
        : isAnalyze
          ? 'The execution plan includes actual runtime metrics from ANALYZE. Cite only numbers explicitly present in the plan.'
          : 'This plan does NOT include runtime ANALYZE measurements; never invent actual execution milliseconds or actual row counts—only discuss planner estimates and structural bottlenecks visible in the plan.'

  const system =
    `You are a senior ${engineName} database performance engineer. Analyze the query, its execution plan, and the existing table schemas/indexes.\n` +
    `${engineRule}\n` +
    `Do NOT suggest creating an index that already exists in the schema block. Provide optimizedSql as a semantically equivalent, faster/sargable query rewrite for ${engineName} whenever the query can be optimized — preserving exact output columns, aliases, filtering, and ordering; set optimizedSql to null only if the query cannot be meaningfully improved, and never wrap optimizedSql in markdown backticks.\n` +
    `Write all human-readable fields (summary, bottlenecks[].title, bottlenecks[].detail, indexSuggestions[].reason, caveats[]) strictly in ${resolvedLanguage.label}. ` +
    `Keep summary to 2-3 sentences and each bottleneck/caveat concise so the complete valid JSON fits cleanly within the output token limit. ` +
    `Keep all SQL identifiers, optimizedSql, indexSuggestions[].ddl, and database operator terms (e.g. Seq Scan, Index Scan, Using filesort) in standard SQL and original engine terminology.\n` +
    `Respond with ONLY one valid JSON object matching:\n` +
    `{"summary":"string","bottlenecks":[{"title":"string","detail":"string","severity":"high|medium|low"}],"optimizedSql":"string or null","indexSuggestions":[{"ddl":"string","reason":"string"}],"caveats":["string"]}`

  const sqlLang =
    input.dialect === 'mongodb' ? 'javascript' : input.dialect === 'redis' ? 'text' : 'sql'
  const userParts: string[] = [
    `Engine: ${engineName}`,
    `Original query:\n${fencePromptBlock(input.sql.trim().slice(0, 4000), sqlLang)}`,
    `Execution plan:\n${fencePromptBlock(planText, 'text')}`,
  ]
  if (schemaBlock) {
    userParts.push(
      `Relevant tables, columns, FKs & existing indexes:\n${fencePromptBlock(schemaBlock, 'text')}`
    )
  }

  return {
    system,
    user: userParts.join('\n\n'),
    resolvedLanguage,
    referencedTables,
  }
}

function scanJsonStructure(frag: string): {
  stack: Array<'{' | '['>
  inString: boolean
  unquotedCommas: number[]
} {
  const stack: Array<'{' | '['> = []
  let inString = false
  let escaped = false
  const unquotedCommas: number[] = []
  for (let i = 0; i < frag.length; i++) {
    const ch = frag[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{' || ch === '[') {
      stack.push(ch)
    } else if (ch === '}' && stack[stack.length - 1] === '{') {
      stack.pop()
    } else if (ch === ']' && stack[stack.length - 1] === '[') {
      stack.pop()
    } else if (ch === ',') {
      unquotedCommas.push(i)
    }
  }
  return { stack, inString, unquotedCommas }
}

function escapeControlCharForJson(ch: string): string {
  if (ch === '\n') return '\\n'
  if (ch === '\r') return '\\r'
  if (ch === '\t') return '\\t'
  const code = ch.charCodeAt(0)
  return `\\u${code.toString(16).padStart(4, '0')}`
}

function sanitizeLooseJsonText(input: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (inString) {
      if (escaped) {
        escaped = false
        if (ch.charCodeAt(0) < 0x20) {
          out += `\\${escapeControlCharForJson(ch)}`
        } else {
          out += ch
        }
        continue
      }
      if (ch === '\\') {
        escaped = true
        out += ch
        continue
      }
      if (ch === '"') {
        inString = false
        out += ch
        continue
      }
      if (ch.charCodeAt(0) < 0x20) {
        out += escapeControlCharForJson(ch)
        continue
      }
      out += ch
      continue
    }

    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ',') {
      let nextIdx = i + 1
      while (
        nextIdx < input.length &&
        (input[nextIdx] === ' ' ||
          input[nextIdx] === '\t' ||
          input[nextIdx] === '\n' ||
          input[nextIdx] === '\r')
      ) {
        nextIdx += 1
      }
      if (nextIdx < input.length && (input[nextIdx] === '}' || input[nextIdx] === ']')) {
        continue
      }
    }
    out += ch
  }
  return out
}

function parseJsonWithLooseFallback(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    const sanitized = sanitizeLooseJsonText(text)
    if (sanitized === text) return null
    try {
      return JSON.parse(sanitized)
    } catch {
      return null
    }
  }
}

function closeFragment(frag: string): unknown | null {
  const trimmed = frag.trimEnd()
  if (!trimmed.startsWith('{')) return null
  const { stack, inString } = scanJsonStructure(trimmed)
  let body = trimmed
  if (inString) {
    body = body.replace(/\\+$/, (m) => (m.length % 2 === 1 ? m.slice(0, -1) : m))
    body += '"'
  } else {
    body = body.replace(/,\s*$/, '')
  }
  if (stack.length === 0) return null
  let closing = ''
  for (let i = stack.length - 1; i >= 0; i--) {
    closing += stack[i] === '{' ? '}' : ']'
  }
  return parseJsonWithLooseFallback(body + closing)
}

function repairTruncatedJson(fragment: string): unknown | null {
  const direct = closeFragment(fragment)
  if (direct !== null) return direct
  const { unquotedCommas } = scanJsonStructure(fragment)
  for (let k = unquotedCommas.length - 1, tries = 0; k >= 0 && tries < 12; k--, tries++) {
    const repaired = closeFragment(fragment.slice(0, unquotedCommas[k]))
    if (repaired !== null) return repaired
  }
  return null
}

function findBalancedJsonObjectEnd(raw: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function hasAnyPreferredKey(
  value: Record<string, unknown>,
  preferredKeys?: readonly string[]
): boolean {
  if (!preferredKeys || preferredKeys.length === 0) return true
  for (const key of preferredKeys) {
    if (Object.hasOwn(value, key)) return true
  }
  return false
}

function extractJsonObject(
  raw: string,
  preferredKeys?: readonly string[]
): { value: unknown; truncated: boolean } | null {
  let searchFrom = 0
  let attempts = 0
  let fallbackComplete: { value: unknown; truncated: boolean } | null = null
  let fallbackTruncated: { value: unknown; truncated: boolean } | null = null

  while (searchFrom < raw.length && attempts < 32) {
    const start = raw.indexOf('{', searchFrom)
    if (start === -1) break
    attempts += 1
    const closeIdx = findBalancedJsonObjectEnd(raw, start)
    if (closeIdx !== -1) {
      const slice = raw.slice(start, closeIdx + 1)
      const parsed = parseJsonWithLooseFallback(slice)
      if (isPlainRecord(parsed)) {
        const candidate = { value: parsed, truncated: false }
        if (hasAnyPreferredKey(parsed, preferredKeys)) {
          return candidate
        }
        if (fallbackComplete === null) fallbackComplete = candidate
        searchFrom = closeIdx + 1
        continue
      }
      const repairedSlice = repairTruncatedJson(slice)
      if (isPlainRecord(repairedSlice)) {
        const candidate = { value: repairedSlice, truncated: true }
        if (hasAnyPreferredKey(repairedSlice, preferredKeys)) {
          return candidate
        }
        if (fallbackTruncated === null) fallbackTruncated = candidate
      }
      searchFrom = start + 1
      continue
    }
    const repaired = repairTruncatedJson(raw.slice(start))
    if (isPlainRecord(repaired)) {
      const candidate = { value: repaired, truncated: true }
      if (hasAnyPreferredKey(repaired, preferredKeys)) {
        return candidate
      }
      if (fallbackTruncated === null) fallbackTruncated = candidate
    }
    searchFrom = start + 1
  }

  return fallbackComplete ?? fallbackTruncated
}

const SAFE_INDEX_DDL_RE =
  /^(?:CREATE\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+|BITMAP\s+|CLUSTERED\s+|NONCLUSTERED\s+)?INDEX\b|ALTER\s+TABLE\s+[\s\S]+?\bADD\s+(?:UNIQUE\s+)?(?:INDEX|KEY)\b|db\.(?:[A-Za-z0-9_$.]+|getCollection\([^)]+\))\.createIndex\s*\()/i

function sanitizeSuggestedIndexDdl(rawDdl: string): string {
  const cleaned = stripSqlCodeFence(rawDdl).trim()
  if (!cleaned || looksInjected(cleaned)) return ''
  // Keep ONLY the first statement if model appended extra statements after `;`
  const stmts = splitSqlStatements(cleaned, 'postgres')
  const firstStmt = (stmts[0]?.text ?? cleaned).trim()
  if (!firstStmt || !SAFE_INDEX_DDL_RE.test(firstStmt)) return ''
  if (/\b(?:DROP|DELETE|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE)\b/i.test(firstStmt)) return ''
  return firstStmt.slice(0, 500)
}

function clampStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

export function parseExplainAnalysis(
  raw: string,
  languageLabel: string,
  durationMs: number
): AiExplainAnalysisResult {
  const withoutThink = stripThinkBlocks(raw)
  const extracted = extractJsonObject(withoutThink, [
    'summary',
    'bottlenecks',
    'optimizedSql',
    'indexSuggestions',
    'caveats',
  ])
  const parsed = extracted?.value ?? null
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>
    const summary = clampStr(obj.summary, 1500)
    const rawBottlenecks = Array.isArray(obj.bottlenecks) ? obj.bottlenecks : []
    const bottlenecks: AiExplainBottleneck[] = rawBottlenecks
      .slice(0, 8)
      .map((item) => {
        if (typeof item !== 'object' || item === null) return null
        const rec = item as Record<string, unknown>
        const title = clampStr(rec.title, 160)
        const detail = clampStr(rec.detail, 600)
        if (!title && !detail) return null
        const sev = rec.severity === 'high' || rec.severity === 'low' ? rec.severity : 'medium'
        return { title: title || 'Bottleneck', detail, severity: sev }
      })
      .filter((x): x is AiExplainBottleneck => x !== null)

    const optUnfenced = typeof obj.optimizedSql === 'string' ? stripSqlCodeFence(obj.optimizedSql) : ''
    const optRaw = optUnfenced && !looksInjected(optUnfenced) ? optUnfenced.slice(0, 8000) : ''
    const optimizedSql = optRaw ? optRaw : null

    const rawIdx = Array.isArray(obj.indexSuggestions) ? obj.indexSuggestions : []
    const indexSuggestions: AiExplainIndexSuggestion[] = rawIdx
      .slice(0, 6)
      .map((item) => {
        if (typeof item !== 'object' || item === null) return null
        const rec = item as Record<string, unknown>
        const ddl = sanitizeSuggestedIndexDdl(clampStr(rec.ddl, 500))
        const reason = clampStr(rec.reason, 400)
        return ddl ? { ddl, reason } : null
      })
      .filter((x): x is AiExplainIndexSuggestion => x !== null)

    const rawCaveats = Array.isArray(obj.caveats) ? obj.caveats : []
    const caveats = rawCaveats
      .slice(0, extracted?.truncated ? 5 : 6)
      .map((c) => clampStr(c, 300))
      .filter(Boolean)
    if (extracted?.truncated) {
      caveats.push(
        'Response was truncated at max tokens; increase EXPLAIN max tokens in AI Settings for complete output.'
      )
    }

    if (summary || bottlenecks.length > 0 || optimizedSql || indexSuggestions.length > 0) {
      return {
        summary: summary || 'Analysis completed.',
        bottlenecks,
        optimizedSql,
        indexSuggestions,
        caveats,
        language: languageLabel,
        durationMs,
      }
    }
  }

  const cleanedPlain = withoutThink.replace(/^\s*```[^\n]*\n?|\n?```\s*$/g, '').trim()
  return {
    summary: cleanedPlain.slice(0, 1500) || 'No analysis returned by model.',
    bottlenecks: [],
    optimizedSql: null,
    indexSuggestions: [],
    caveats: ['Model returned unstructured text; review carefully.'],
    language: languageLabel,
    durationMs,
  }
}

export interface BuildFixQueryPromptInput {
  dialect: AiDialect
  sql: string
  errorMessage: string
  schemaBlock?: string
  language?: AiExplainLanguage
  uiLocale?: string
  statementCount?: number
}

export interface BuiltFixQueryPrompt {
  system: string
  user: string
  resolvedLanguage: { code: string; label: string }
}

export function countFixQueryStatements(sql: string, dialect: AiDialect): number {
  const trimmed = sql.trim()
  if (!trimmed || dialect === 'redis') return 1
  const stmts = splitSqlStatements(trimmed, dialect)
  return Math.max(1, stmts.length)
}

export function buildFixQueryPrompt(input: BuildFixQueryPromptInput): BuiltFixQueryPrompt {
  const resolvedLanguage = resolveExplainLanguage(input.language, input.uiLocale)
  const engineName = dialectLabel(input.dialect)
  const trimmedSql = input.sql.trim()
  const cappedSql = trimmedSql.slice(0, MAX_FIX_QUERY_SQL_CHARS)
  const cappedError = redactSecretLiteralsForPrompt(input.errorMessage.trim()).slice(
    0,
    MAX_FIX_QUERY_ERROR_CHARS
  )
  const cappedSchema =
    typeof input.schemaBlock === 'string'
      ? input.schemaBlock.trim().slice(0, MAX_FIX_QUERY_SCHEMA_CHARS)
      : ''
  const sqlWasTruncated = cappedSql.length < trimmedSql.length
  const statementCount =
    !sqlWasTruncated &&
    typeof input.statementCount === 'number' &&
    Number.isInteger(input.statementCount) &&
    input.statementCount >= 1
      ? input.statementCount
      : countFixQueryStatements(cappedSql, input.dialect)
  const isMultiStatement = statementCount > 1

  const introLine = isMultiStatement
    ? `You are a senior database engineer fixing a failing statement inside a ${statementCount}-statement ${engineName} script.\n`
    : `You are a senior database engineer fixing a broken SQL/NoSQL query for ${engineName}.\n`

  const fixedSqlRule = isMultiStatement
    ? `- The input contains ${statementCount} statements. fixedSql MUST return the COMPLETE ${statementCount}-statement script in its original order, preserving ALL other statements verbatim (including their separators) and modifying ONLY the failing statement (no markdown backticks).\n` +
      `- NEVER omit, drop, reorder, or rewrite unrelated statements.\n`
    : `- fixedSql must contain ONLY this single corrected executable statement (no markdown backticks, no extra statements).\n`

  const system =
    introLine +
    `Preserve the user's intent, table/column names, and quoting style; NEVER invent columns or tables that are not in the provided schema or original query.\n` +
    `Respond with ONLY a single valid JSON object matching:\n` +
    `{"fixedSql":"string","explanation":"string","changesSummary":"string"}\n` +
    `Do NOT wrap the JSON in markdown fences or include commentary outside the JSON.\n` +
    fixedSqlRule +
    `- explanation must be 1-3 concise sentences in ${resolvedLanguage.label} explaining what caused the error and why the fix resolves it.\n` +
    `- changesSummary must be 1 short line in ${resolvedLanguage.label} summarizing what changed (e.g., Completed truncated keyword LIM to LIMIT 100).\n` +
    `- Keep SQL/NoSQL keywords, table names, column names, and identifiers in standard ${engineName} syntax.`

  const sqlHeader = isMultiStatement
    ? `Broken script (${statementCount} statements):`
    : 'Broken query:'

  const sqlLang =
    input.dialect === 'mongodb' ? 'javascript' : input.dialect === 'redis' ? 'text' : 'sql'
  const userParts: string[] = [
    `Engine: ${engineName}`,
    `${sqlHeader}\n${fencePromptBlock(cappedSql, sqlLang)}`,
    `Database error:\n${fencePromptBlock(cappedError, 'text')}`,
  ]
  if (cappedSchema) {
    userParts.push(
      `Relevant schema (tables, columns, FKs & indexes):\n${fencePromptBlock(cappedSchema, 'text')}`
    )
  }

  return {
    system,
    user: userParts.join('\n\n'),
    resolvedLanguage,
  }
}

const MAX_FIXED_SQL_CHARS = 12000
const DEFAULT_FIX_EXPLANATION =
  'Fixed SQL syntax or schema mismatch based on the database error.'
const FIX_SQL_REFUSAL_RE =
  /^(?:i['’]m sorry|sorry\b|i cannot\b|i can['’]t\b|i am (?:sorry|unable)\b|as an ai\b|cannot fix\b|unable to fix\b|apologies\b|unfortunately[,\s])/i

function stripThinkBlocks(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .trim()
}

function stripOuterJsonFence(raw: string): string {
  const withoutThink = stripThinkBlocks(raw)
  if (!withoutThink.startsWith('```')) return withoutThink
  return withoutThink
    .replace(/^```[^\r\n]*\r?\n?/, '')
    .replace(/\r?\n?```\s*$/, '')
    .trim()
}

function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

function unescapeLooseJsonString(raw: string): string {
  let out = ''
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1]
      if (next === 'n') {
        out += '\n'
        i += 2
        continue
      }
      if (next === 'r') {
        out += '\r'
        i += 2
        continue
      }
      if (next === 't') {
        out += '\t'
        i += 2
        continue
      }
      if (next === 'b') {
        out += '\b'
        i += 2
        continue
      }
      if (next === 'f') {
        out += '\f'
        i += 2
        continue
      }
      if (next === '"' || next === '\\' || next === '/') {
        out += next
        i += 2
        continue
      }
      if (next === 'u') {
        const hex = raw.slice(i + 2, i + 6)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16))
          i += 6
          continue
        }
      }
      out += ch + next
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

const MALFORMED_FIXED_SQL_NEXT_KEY_RE = /"\s*,\s*"(?:explanation|changesSummary)"\s*:/g
const MALFORMED_ANY_FIX_NEXT_KEY_RE = /"\s*,\s*"(?:fixedSql|explanation|changesSummary)"\s*:/g

function findUnescapedQuoteBeforeSiblingKey(
  source: string,
  fromIndex: number,
  siblingKeyPattern: RegExp
): number {
  const re = new RegExp(siblingKeyPattern.source, 'g')
  re.lastIndex = fromIndex
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    if (!isEscapedAt(source, match.index)) {
      return match.index
    }
    re.lastIndex = match.index + 1
  }
  return -1
}

function findClosingQuoteBeforeBrace(source: string, fromIndex: number): number {
  const lastBrace = source.lastIndexOf('}')
  if (lastBrace <= fromIndex) return -1
  let pos = lastBrace - 1
  while (pos >= fromIndex && /\s/.test(source[pos])) pos -= 1
  if (pos >= fromIndex && source[pos] === ',') {
    pos -= 1
    while (pos >= fromIndex && /\s/.test(source[pos])) pos -= 1
  }
  if (pos >= fromIndex && source[pos] === '"' && !isEscapedAt(source, pos)) {
    return pos
  }
  return -1
}

function extractLooseOptionalField(
  segment: string,
  key: 'explanation' | 'changesSummary',
  isPrefix: boolean
): string {
  const keyMatch = new RegExp(`"${key}"\\s*:\\s*"`).exec(segment)
  if (!keyMatch) return ''
  const valStart = keyMatch.index + keyMatch[0].length
  let valEnd = findUnescapedQuoteBeforeSiblingKey(segment, valStart, MALFORMED_ANY_FIX_NEXT_KEY_RE)
  if (valEnd === -1 && isPrefix) {
    let pos = segment.length - 1
    while (pos >= valStart && /\s/.test(segment[pos])) pos -= 1
    if (pos >= valStart && segment[pos] === ',') {
      pos -= 1
      while (pos >= valStart && /\s/.test(segment[pos])) pos -= 1
    }
    if (pos >= valStart && segment[pos] === '"' && !isEscapedAt(segment, pos)) {
      valEnd = pos
    }
  }
  if (valEnd === -1 && !isPrefix) {
    valEnd = findClosingQuoteBeforeBrace(segment, valStart)
  }
  if (valEnd === -1 && !isPrefix) {
    const trimmed = segment
      .slice(valStart)
      .replace(/\\+$/, (m) => (m.length % 2 === 1 ? m.slice(0, -1) : m))
    const cleaned =
      trimmed.endsWith('"') && !isEscapedAt(trimmed, trimmed.length - 1)
        ? trimmed.slice(0, -1)
        : trimmed
    return unescapeLooseJsonString(cleaned)
  }
  if (valEnd < valStart) return ''
  return unescapeLooseJsonString(segment.slice(valStart, valEnd))
}

function recoverMalformedFixJson(unfenced: string): Record<string, unknown> | null {
  const objStart = unfenced.indexOf('{')
  if (objStart === -1) return null
  const slice = unfenced.slice(objStart)
  const fixedKeyMatch = /"fixedSql"\s*:\s*"/.exec(slice)
  if (!fixedKeyMatch) return null

  const fixedValStart = fixedKeyMatch.index + fixedKeyMatch[0].length
  let fixedValEnd = findUnescapedQuoteBeforeSiblingKey(
    slice,
    fixedValStart,
    MALFORMED_FIXED_SQL_NEXT_KEY_RE
  )
  if (fixedValEnd === -1) {
    fixedValEnd = findClosingQuoteBeforeBrace(slice, fixedValStart)
  }
  if (fixedValEnd === -1) return null

  const fixedSql = unescapeLooseJsonString(slice.slice(fixedValStart, fixedValEnd))
  const prefix = slice.slice(0, fixedKeyMatch.index)
  const suffix = slice.slice(fixedValEnd + 1)

  const explanation =
    extractLooseOptionalField(suffix, 'explanation', false) ||
    extractLooseOptionalField(prefix, 'explanation', true)
  const changesSummary =
    extractLooseOptionalField(suffix, 'changesSummary', false) ||
    extractLooseOptionalField(prefix, 'changesSummary', true)

  return { fixedSql, explanation, changesSummary }
}

const FENCED_SQL_LANG_RE =
  /^(?:sql|postgresql|postgres|mysql|mariadb|sqlite|tsql|plsql|clickhouse|duckdb|snowflake|bigquery|cql|cypher|mongodb|mql|redis)$/i

const UNLABELED_FENCE_VERB_RE =
  /^(?:SELECT|WITH|INSERT|UPDATE|DELETE|MERGE|VALUES|TABLE|EXPLAIN|SHOW|DESCRIBE|DESC|PRAGMA|USE|SET|CREATE|ALTER|DROP|TRUNCATE|BEGIN|COMMIT|ROLLBACK|CALL|EXEC|EXECUTE)\b|^db\./i

const CODE_FENCE_BLOCK_RE = /```([A-Za-z0-9_-]*)[ \t]*(?:\r?\n([\s\S]*?)|[ \t]+([^\r\n]+?))```/g

function stripLeadingSqlComments(sql: string): string {
  let text = sql.trimStart()
  while (text.length > 0) {
    if (text.startsWith('--')) {
      const nl = text.indexOf('\n')
      if (nl === -1) return ''
      text = text.slice(nl + 1).trimStart()
      continue
    }
    if (text.startsWith('/*')) {
      const close = text.indexOf('*/', 2)
      if (close === -1) return ''
      text = text.slice(close + 2).trimStart()
      continue
    }
    break
  }
  return text
}

function recoverFencedSqlFix(unfenced: string): Record<string, unknown> | null {
  const re = new RegExp(CODE_FENCE_BLOCK_RE.source, 'g')
  let chosenSql = ''
  let match: RegExpExecArray | null
  while ((match = re.exec(unfenced)) !== null) {
    const lang = (match[1] ?? '').trim().toLowerCase()
    const body = (match[2] ?? match[3] ?? '').trim()
    if (!body) continue
    if (lang) {
      if (!FENCED_SQL_LANG_RE.test(lang)) continue
      if (body.startsWith('[')) continue
      if (lang !== 'mongodb' && lang !== 'mql' && body.startsWith('{')) continue
      chosenSql = body
      break
    }
    const probe = stripLeadingSqlComments(body)
    if (!probe || probe.startsWith('{') || probe.startsWith('[')) continue
    if (!UNLABELED_FENCE_VERB_RE.test(probe)) continue
    chosenSql = body
    break
  }
  if (!chosenSql) return null

  const prose = unfenced
    .replace(new RegExp(CODE_FENCE_BLOCK_RE.source, 'g'), '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return {
    fixedSql: chosenSql,
    explanation: prose,
    changesSummary: '',
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripSqlCodeFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed || /^```[A-Za-z0-9_-]*```$/.test(trimmed)) return ''
  const closed = /^```[^\r\n]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed)
  if (closed) return closed[1].trim()
  const singleLine =
    /^```(?:sql|postgresql|postgres|mysql|mariadb|sqlite|tsql|plsql|mongodb|mql|redis|json)?\s+([\s\S]*?)```$/i.exec(
      trimmed
    )
  if (singleLine) return singleLine[1].trim()
  const unclosed = /^```[^\r\n]*\r?\n([\s\S]*)$/.exec(trimmed)
  if (unclosed) return unclosed[1].trim()
  return trimmed
}

export interface ParseFixQueryMeta {
  model: string
  durationMs: number
  language: string
}

export function parseFixQueryResult(raw: string, meta: ParseFixQueryMeta): AiFixQueryResult {
  if (looksInjected(raw)) {
    throw new Error('AI returned an unsafe or injected fixed query payload.')
  }
  const withoutThink = stripThinkBlocks(raw)
  const unfenced = stripOuterJsonFence(withoutThink)
  const extracted = extractJsonObject(unfenced, ['fixedSql', 'explanation', 'changesSummary'])
  let obj: Record<string, unknown> | null = isPlainRecord(extracted?.value) ? extracted.value : null

  const needsRecovery =
    obj === null ||
    !Object.hasOwn(obj, 'fixedSql') ||
    (extracted?.truncated === true && !obj.explanation && unfenced.trimEnd().endsWith('}'))

  if (needsRecovery) {
    const recovered = recoverMalformedFixJson(unfenced) ?? recoverFencedSqlFix(withoutThink)
    if (recovered !== null) {
      obj = recovered
    }
  }

  if (obj === null) {
    throw new Error('AI response did not contain a valid JSON query fix.')
  }
  const rawFixed = typeof obj.fixedSql === 'string' ? stripSqlCodeFence(obj.fixedSql) : ''
  if (!rawFixed) {
    throw new Error('AI response did not include a valid fixed SQL query.')
  }
  if (rawFixed.length > MAX_FIXED_SQL_CHARS) {
    throw new Error(
      `AI returned an unexpectedly large fixed query (> ${MAX_FIXED_SQL_CHARS} characters).`
    )
  }
  if (looksInjected(rawFixed)) {
    throw new Error('AI returned an unsafe or injected fixed query payload.')
  }
  if (FIX_SQL_REFUSAL_RE.test(rawFixed)) {
    throw new Error('AI refused to produce an executable query fix.')
  }

  const explanation = clampStr(obj.explanation, 1500) || DEFAULT_FIX_EXPLANATION
  const changesSummary = clampStr(obj.changesSummary, 300)

  return {
    fixedSql: rawFixed,
    explanation,
    changesSummary,
    language: meta.language,
    model: meta.model,
    durationMs: meta.durationMs,
  }
}
