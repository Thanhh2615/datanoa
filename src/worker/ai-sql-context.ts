import type {
  AiExplainAnalysisResult,
  AiExplainBottleneck,
  AiExplainIndexSuggestion,
  AiExplainLanguage,
  AiFixQueryResult,
  QueryHistoryEntry,
  SchemaObject,
  TableDetails,
} from '../protocol'
import { hasExplainAnalyzeOption } from '../drivers/common/sql-tools'
import { isolateActiveSqlStatement, splitSqlStatements } from '../shared-sql-core.js'
import { AI_PREFIX_CHARS, hasSensitiveContent, looksInjected, type AiDialect } from './ai-client'

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
  private readonly store = new Map<string, ConnectionSchemaEntry>()
  private readonly connectionRevisions = new Map<string, number>()
  private revisionCounter = 0

  private bumpConnectionRevision(connectionId: string): void {
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

  private touchConnection(connectionId: string, entry: ConnectionSchemaEntry): void {
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
    const keys = detailKeysFor(details.name, details.schema)
    for (const k of keys) {
      entry.details.delete(k)
      entry.details.set(k, details)
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

  getSnapshot(connectionId: string): WorkerSchemaSnapshot | null {
    if (!connectionId) return null
    const entry = this.store.get(connectionId)
    if (!entry) return null
    return { objects: entry.objects, details: entry.details }
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
  const parts: string[] = []
  let i = 0
  while (i < sqlText.length) {
    const ch = sqlText[i]
    const next = sqlText[i + 1]
    if (ch === '-' && next === '-') {
      const nl = sqlText.indexOf('\n', i + 2)
      parts.push(' ')
      if (nl === -1) break
      parts.push('\n')
      i = nl + 1
      continue
    }
    if (ch === '#' && dialect !== 'mssql' && dialect !== 'oracle') {
      const nl = sqlText.indexOf('\n', i + 1)
      parts.push(' ')
      if (nl === -1) break
      parts.push('\n')
      i = nl + 1
      continue
    }
    if (ch === '/' && next === '*') {
      const close = sqlText.indexOf('*/', i + 2)
      parts.push(' ')
      if (close === -1) break
      i = close + 2
      continue
    }
    if (dialect === 'oracle' || dialect === undefined) {
      const qMatch = scanOracleQQuote(sqlText, i)
      if (qMatch) {
        parts.push(' ')
        i = qMatch.end
        continue
      }
    }
    if ((dialect === 'postgres' || dialect === undefined) && ch === '$') {
      const dq = scanDollarQuote(sqlText, i)
      if (dq) {
        parts.push(' ')
        i = dq.end
        continue
      }
    }
    if (ch === "'") {
      const allowBackslash = dialect !== 'mssql' && dialect !== 'oracle'
      const str = scanQuotedString(sqlText, i, "'", {
        backslashEscape: allowBackslash,
        doubledEscape: true,
      })
      parts.push(' ')
      i = str.end
      continue
    }
    if (ch === '[' && (dialect === 'mssql' || dialect === undefined)) {
      const br = scanBracketIdent(sqlText, i)
      parts.push(sqlText.slice(i, br.end))
      i = br.end
      continue
    }
    if (ch === '"' || ch === '`') {
      const q = scanQuotedString(sqlText, i, ch, { backslashEscape: false, doubledEscape: true })
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
  `\\b(?:FROM|JOIN|UPDATE|INTO|TABLE|DESCRIBE)\\s+(?:(${SQL_IDENT_ATOM})\\s*\\.\\s*)?(${SQL_IDENT_ATOM})`
const SQL_TRAILING_PARTIAL_TABLE_RE = new RegExp(
  `(?:^|[\\s(,;])(?:FROM|JOIN|UPDATE|INTO|TABLE|DESCRIBE)\\s+(?:(${SQL_IDENT_ATOM})\\s*\\.\\s*)?(["\`[]?)([A-Za-z0-9_$]{1,64})$`,
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
  const schema = match[1] ? unquoteIdent(match[1]) : undefined
  const partial = match[3]
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
    const schemaPart = match[1] ? unquoteIdent(match[1]) : ''
    const tablePart = match[2] ? unquoteIdent(match[2]) : ''
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
  const direct = snapshot.details.get(lower)
  if (direct) return direct
  if (lower.includes('.')) {
    const bare = lower.split('.').pop() || ''
    return snapshot.details.get(bare)
  }
  if (activeSchema) {
    const qualified = snapshot.details.get(`${activeSchema.toLowerCase()}.${lower}`)
    if (qualified) return qualified
  }
  return undefined
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
    fkByCol.set(fk.column.toLowerCase(), `${fk.referencedTable}.${fk.referencedColumn}`)
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
    return `${c.name} ${c.type || 'any'}${suffix}`
  })
  const idxList = (details.indexes || [])
    .filter((i) => !i.isPrimary && i.columns.length > 0)
    .slice(0, 6)
    .map((i) => `${i.isUnique ? 'uniq:' : ''}${i.name}(${i.columns.join(', ')})`)
  const idxNote = idxList.length > 0 ? ` [idx: ${idxList.join('; ')}]` : ''
  const title = details.schema ? `${details.schema}.${details.name}` : details.name
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
    return `${prefix}${kept.join(', ')}${ellipsisSuffix}`
  }
  if (cols.length > 0 && budget >= prefix.length + 9) {
    const maxCol = budget - prefix.length - 6
    if (maxCol >= 4) {
      return `${prefix}${cols[0].slice(0, maxCol)}...${ellipsisSuffix}`
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
  let chars = 0

  const pushLine = (line: string): boolean => {
    if (!line || chars + line.length + 1 > maxChars) return false
    lines.push(line)
    chars += line.length + 1
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
          tier1Items.push({ kind: 'map', title: bare, cols: [...selected] })
        }
      }
    }
  }

  for (let i = 0; i < tier1Items.length; i++) {
    const remainingBudget = maxChars - chars - 1
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
      usedKeys.add(k)
      if (!pushLine(formatCompactTableDdl(det))) break
    }
  }

  // Tier 3: Remaining objects summary (gracefully degrades full -> key cols -> compact names to keep columns for 20-50+ tables)
  const remaining = new Map<string, { full: string; medium: string; compact: string }>()
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
        ).map((c) => c.name)
      } else {
        cols = lookupSchemaMapCols(schemaMap, obj.name)?.slice(0, 8) ?? []
      }
      const label = obj.schema ? `${obj.schema}.${obj.name}` : obj.name
      const keyCols = cols.slice(0, 4)
      remaining.set(k, {
        full: cols.length > 0 ? `${label}(${cols.join(', ')})` : label,
        medium: keyCols.length > 0 ? `${label}(${keyCols.join(', ')})` : label,
        compact: label,
      })
    }
  }
  if (schemaMap) {
    for (const [tbl, cols] of Object.entries(schemaMap)) {
      const bare = tbl.includes('.') ? tbl.split('.').pop() || tbl : tbl
      const bareLower = bare.toLowerCase()
      if (
        Array.from(usedKeys).some((k) => k === bareLower || k.endsWith(`.${bareLower}`)) ||
        Array.from(remaining.keys()).some((k) => k.endsWith(`.${bareLower}`))
      ) {
        continue
      }
      const top8 = cols.slice(0, 8)
      const top4 = cols.slice(0, 4)
      remaining.set(`.${bareLower}`, {
        full: top8.length > 0 ? `${tbl}(${top8.join(', ')})` : tbl,
        medium: top4.length > 0 ? `${tbl}(${top4.join(', ')})` : tbl,
        compact: tbl,
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
    fkByCol.set(fk.column.toLowerCase(), `${fk.referencedTable}(${fk.referencedColumn})`)
  }
  const selectedColumns = prioritizeColumns(details.columns || [], limit, (c) => {
    const lower = c.name.toLowerCase()
    return Boolean(c.isPrimaryKey || fkByCol.has(lower) || referencedCols?.has(lower))
  })
  const cols = selectedColumns.map((c) => {
    const parts: string[] = [c.name]
    if (includeTypes) {
      parts.push(c.type || 'TEXT')
    }
    if (c.isPrimaryKey) parts.push('PRIMARY KEY')
    const fk = fkByCol.get(c.name.toLowerCase())
    if (fk) parts.push(`REFERENCES ${fk}`)
    return parts.join(' ')
  })
  const title = details.schema ? `${details.schema}.${details.name}` : details.name
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
  let chars = 0

  const pushLine = (line: string): boolean => {
    if (!line || chars + line.length + 1 > maxChars) return false
    lines.push(line)
    chars += line.length + 1
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
          tier1Items.push({ kind: 'map', title: bare, cols: [...selected] })
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
      const label = obj.schema ? `${obj.schema}.${obj.name}` : obj.name
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
        const cols = lookupSchemaMapCols(schemaMap, obj.name) ?? []
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
    for (const [tbl, cols] of Object.entries(schemaMap)) {
      const bare = tbl.includes('.') ? tbl.split('.').pop() || tbl : tbl
      const bareLower = bare.toLowerCase()
      if (
        Array.from(usedKeys).some((k) => k === bareLower || k.endsWith(`.${bareLower}`)) ||
        Array.from(remaining.keys()).some((k) => k.endsWith(`.${bareLower}`))
      ) {
        continue
      }
      const top8 = cols.slice(0, 8)
      const top4 = cols.slice(0, 4)
      remaining.set(`.${bareLower}`, {
        full: top8.length > 0 ? `CREATE TABLE ${tbl} (${top8.join(', ')});` : `-- table ${tbl}`,
        medium: top4.length > 0 ? `CREATE TABLE ${tbl} (${top4.join(', ')});` : `-- table ${tbl}`,
        compact: `-- table ${tbl}`,
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

export function maskLongStringLiterals(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    if (sql[i] === "'") {
      let end = i + 1
      while (end < sql.length) {
        if (sql[end] === '\\' && end + 1 < sql.length) {
          end += 2
          continue
        }
        if (sql[end] === "'") {
          if (sql[end + 1] === "'") {
            end += 2
            continue
          }
          break
        }
        end++
      }
      if (end < sql.length && sql[end] === "'") {
        const innerLen = end - i - 1
        out += innerLen >= LONG_LITERAL_MIN ? "'...'" : sql.slice(i, end + 1)
        i = end + 1
        continue
      }
    }
    out += sql[i]
    i++
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
  let i = 0
  while (i < prefix.length) {
    const ch = prefix[i]
    const next = prefix[i + 1]
    if (ch === '-' && next === '-') {
      const nl = prefix.indexOf('\n', i + 2)
      if (nl === -1) return true
      i = nl + 1
      continue
    }
    if (ch === '#' && dialect !== 'mssql' && dialect !== 'oracle') {
      const nl = prefix.indexOf('\n', i + 1)
      if (nl === -1) return true
      i = nl + 1
      continue
    }
    if (ch === '/' && next === '*') {
      const close = prefix.indexOf('*/', i + 2)
      if (close === -1) return true
      i = close + 2
      continue
    }
    if (dialect === 'mssql' && ch === '[') {
      i = scanBracketIdent(prefix, i).end
      continue
    }
    if (dialect === 'oracle') {
      const qMatch = scanOracleQQuote(prefix, i)
      if (qMatch) {
        i = qMatch.end
        continue
      }
    }
    if ((dialect === 'postgres' || dialect === undefined) && ch === '$') {
      const dq = scanDollarQuote(prefix, i)
      if (dq) {
        i = dq.end
        continue
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const allowBackslash = ch !== '`' && dialect !== 'mssql' && dialect !== 'oracle'
      i = scanQuotedString(prefix, i, ch, {
        backslashEscape: allowBackslash,
        doubledEscape: true,
      }).end
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
  const stmts = splitSqlStatements(precedingRaw, dialect === 'mongodb' ? 'sqlite' : dialect)
  const candidates: string[] =
    stmts.length > 0 ? stmts.map((slice) => slice.text) : [precedingRaw]
  const kept: string[] = []
  let chars = 0
  for (let i = candidates.length - 1; i >= 0; i--) {
    const rawStmt = candidates[i]?.trim() ?? ''
    if (!rawStmt || hasSensitiveContent(rawStmt, '', '', dialect)) continue
    const masked = maskLongStringLiterals(rawStmt.replace(/\s+/g, ' ').trim())
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

  const parts: string[] = [`Dialect: ${engineName}`]
  if (schemaBlock) {
    parts.push(`Schema:\n${schemaBlock}`)
  }
  if (recent.length > 0) {
    parts.push(`Recent:\n${recent.map((q) => `- ${q}`).join('\n')}`)
  }
  if (priorSql) {
    parts.push(`Prior SQL in tab:\n${priorSql}`)
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
    ...(schemaBlock ? [`Schema:\n${schemaBlock}`] : []),
    ...(recent.length > 0 ? [`Recent:\n${recent.map((q) => `- ${q}`).join('\n')}`] : []),
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

function serializePlanTable(columns: { name: string; type: string }[], rows: unknown[][]): string {
  if (!columns.length && !rows.length) return '(no plan rows returned)'
  const header = columns.map((c) => c.name || 'col').join(' | ')
  const lines: string[] = [header]
  let chars = header.length + 1
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const cells = row.map((cell) => {
      if (cell === null || cell === undefined) return 'NULL'
      const txt = typeof cell === 'object' ? JSON.stringify(cell) : String(cell)
      return txt.replace(/\r?\n/g, ' ')
    })
    const line = cells.join(' | ')
    if (chars + line.length + 1 > MAX_PLAN_CHARS) {
      lines.push('... (plan output truncated)')
      break
    }
    lines.push(line)
    chars += line.length + 1
  }
  return lines.join('\n')
}

export interface BuildExplainAnalysisPromptInput {
  dialect: AiDialect
  sql: string
  planColumns: { name: string; type: string }[]
  planRows: unknown[][]
  snapshot: WorkerSchemaSnapshot | null
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
  const planText = serializePlanTable(input.planColumns, input.planRows)
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
          undefined,
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

  const userParts: string[] = [
    `Engine: ${engineName}`,
    `Original query:\n${input.sql.trim().slice(0, 4000)}`,
    `Execution plan:\n${planText}`,
  ]
  if (schemaBlock) {
    userParts.push(`Relevant tables, columns, FKs & existing indexes:\n${schemaBlock}`)
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

function extractJsonObject(raw: string): { value: unknown; truncated: boolean } | null {
  const start = raw.indexOf('{')
  if (start === -1) return null
  const end = raw.lastIndexOf('}')
  if (end > start) {
    const parsed = parseJsonWithLooseFallback(raw.slice(start, end + 1))
    if (parsed !== null) {
      return { value: parsed, truncated: false }
    }
  }
  const repaired = repairTruncatedJson(raw.slice(start))
  return repaired !== null ? { value: repaired, truncated: true } : null
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
  const extracted = extractJsonObject(withoutThink)
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
        const ddl = clampStr(rec.ddl, 500)
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
  const cappedSql = input.sql.trim().slice(0, MAX_FIX_QUERY_SQL_CHARS)
  const cappedError = input.errorMessage.trim().slice(0, MAX_FIX_QUERY_ERROR_CHARS)
  const cappedSchema =
    typeof input.schemaBlock === 'string'
      ? input.schemaBlock.trim().slice(0, MAX_FIX_QUERY_SCHEMA_CHARS)
      : ''
  const statementCount =
    typeof input.statementCount === 'number' &&
    Number.isInteger(input.statementCount) &&
    input.statementCount >= 1
      ? input.statementCount
      : countFixQueryStatements(input.sql, input.dialect)
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

  const userParts: string[] = [
    `Engine: ${engineName}`,
    `${sqlHeader}\n${cappedSql}`,
    `Database error:\n${cappedError}`,
  ]
  if (cappedSchema) {
    userParts.push(`Relevant schema (tables, columns, FKs & indexes):\n${cappedSchema}`)
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
  const extracted = extractJsonObject(unfenced)
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
