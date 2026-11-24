import type {
  AiExplainAnalysisResult,
  AiExplainBottleneck,
  AiExplainIndexSuggestion,
  AiExplainLanguage,
  AiFixQueryResult,
  DatabaseDriverType,
  QueryHistoryEntry,
  SchemaObject,
  TableDetails,
} from '../protocol'
import { findStatementAtOffset, hasExplainAnalyzeOption } from '../drivers/common/sql-tools'
import { AI_PREFIX_CHARS, hasSensitiveContent, looksInjected, type AiDialect } from './ai-client'

const CURSOR = '<CURSOR>'
const MAX_SCHEMA_CHARS = 1000
const MAX_HISTORY_CHARS = 280
const MAX_HISTORY_ITEMS = 2
const INLINE_PREFIX_CHARS = 900
const INLINE_SUFFIX_CHARS = 250
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

function buildCompactTableParts(details: TableDetails): {
  title: string
  cols: string[]
  idxNote: string
} {
  const fkByCol = new Map<string, string>()
  for (const fk of details.foreignKeys || []) {
    fkByCol.set(fk.column.toLowerCase(), `${fk.referencedTable}.${fk.referencedColumn}`)
  }
  const cols = (details.columns || []).slice(0, 32).map((c) => {
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

export function buildPrunedSchemaBlock(
  snapshot: WorkerSchemaSnapshot | null,
  schemaMap: Record<string, string[]> | undefined,
  referencedTables: string[],
  activeSchema?: string,
  activeTable?: string,
  maxChars = MAX_SCHEMA_CHARS
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

  const tier1Names = [...referencedTables]
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
      const cols = schemaMap[name] || schemaMap[bare]
      if (Array.isArray(cols) && cols.length > 0) {
        const bareKey = bare.toLowerCase()
        if (!usedKeys.has(bareKey)) {
          usedKeys.add(bareKey)
          tier1Items.push({ kind: 'map', title: bare, cols: cols.slice(0, 24) })
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
      const { title, cols, idxNote } = buildCompactTableParts(item.details)
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

  // Tier 3: Remaining objects summary
  const remaining = new Map<string, string>()
  if (snapshot) {
    for (const obj of snapshot.objects) {
      if (obj.kind && obj.kind !== 'table' && obj.kind !== 'view' && obj.kind !== 'materialized_view') {
        continue
      }
      const k = `${(obj.schema || '').toLowerCase()}.${obj.name.toLowerCase()}`
      const bareKey = `.${obj.name.toLowerCase()}`
      if (usedKeys.has(k) || usedKeys.has(bareKey)) continue
      const det = lookupDetails(snapshot, obj.name, obj.schema)
      const cols = det ? det.columns.slice(0, 8).map((c) => c.name) : schemaMap?.[obj.name]?.slice(0, 8) ?? []
      const label = obj.schema ? `${obj.schema}.${obj.name}` : obj.name
      remaining.set(k, cols.length > 0 ? `${label}(${cols.join(', ')})` : label)
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
      remaining.set(`.${bareLower}`, cols.length > 0 ? `${tbl}(${cols.slice(0, 8).join(', ')})` : tbl)
    }
  }

  for (const summary of remaining.values()) {
    if (!pushLine(summary)) break
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

function selectRelevantHistory(
  historyEntries: readonly QueryHistoryEntry[] | undefined,
  connectionId: string | undefined,
  dialect: AiDialect,
  referencedTables: string[]
): string[] {
  if (!historyEntries || !connectionId) return []
  const refLower = referencedTables.map((t) => (t.includes('.') ? t.split('.').pop() || t : t).toLowerCase())
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

    let score = 0
    for (const tbl of refLower) {
      if (tbl && normKey.includes(tbl)) score += 1
    }
    scored.push({ sql: masked.slice(0, 220), score, idx })
  }

  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.idx - b.idx))

  const chosen: string[] = []
  let chars = 0
  for (const item of scored) {
    if (chosen.length >= MAX_HISTORY_ITEMS) break
    if (chars + item.sql.length + 1 > MAX_HISTORY_CHARS) break
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
function isPrefixInComment(prefix: string, dialect?: AiDialect): boolean {
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
  activeSchema?: string
  activeTable?: string
  snapshot: WorkerSchemaSnapshot | null
  schemaMap?: Record<string, string[]>
  historyEntries?: readonly QueryHistoryEntry[]
}

export interface BuiltSqlCompletionContext {
  system: string
  user: string
  fimPrefix: string
  fimSuffix: string
  referencedTables: string[]
  multiline: boolean
  inComment: boolean
}

export function buildSqlCompletionContext(
  input: BuildSqlCompletionContextInput
): BuiltSqlCompletionContext {
  const prefixWin = input.prefix.slice(-INLINE_PREFIX_CHARS)
  const suffixWin = input.suffix.slice(0, INLINE_SUFFIX_CHARS)
  const combined = `${prefixWin}${suffixWin}`
  const activeStatement =
    input.dialect === 'redis'
      ? combined
      : findStatementAtOffset(combined, prefixWin.length, input.dialect) || combined
  const referencedTables =
    input.dialect === 'redis'
      ? []
      : input.dialect === 'mongodb'
        ? extractReferencedMongoCollections(activeStatement)
        : extractReferencedTables(activeStatement, input.dialect)

  const schemaBlock =
    input.dialect === 'redis'
      ? ''
      : buildPrunedSchemaBlock(
          input.snapshot,
          input.schemaMap,
          referencedTables,
          input.activeSchema,
          input.activeTable
        )

  const recent = selectRelevantHistory(
    input.historyEntries,
    input.connectionId,
    input.dialect,
    referencedTables
  )

  const engineName = dialectLabel(input.dialect)
  const system =
    input.dialect === 'redis'
      ? `${engineName} completion. Reply ONLY text to insert at ${CURSOR}. Brief, no repeats, no markdown, no explanation.`
      : input.dialect === 'mongodb'
        ? `${engineName} completion. Reply ONLY raw MongoDB Shell / MQL to insert at ${CURSOR} using schema. Never output ${CURSOR} or a cursor pipe |. Brief (1-2 lines), no repeats, no markdown, no explanation.`
        : `${engineName} SQL completion. Reply ONLY raw SQL to insert at ${CURSOR} using schema. When ${CURSOR} is mid-word (e.g. LIMI${CURSOR} -> T 100, never " LIMIT 100"), output ONLY the remaining characters with NO leading space, without repeating the prefix or gluing an unrelated clause; include a leading space before a new word/clause only after a complete token. Never output ${CURSOR} or a cursor pipe |. Brief (1-2 lines), no repeats, no markdown, no explanation.`

  const parts: string[] = [`Dialect: ${engineName}`]
  if (schemaBlock) {
    parts.push(`Schema:\n${schemaBlock}`)
  }
  if (recent.length > 0) {
    parts.push(`Recent:\n${recent.map((q) => `- ${q}`).join('\n')}`)
  }
  parts.push(`Query:\n${prefixWin}${CURSOR}${suffixWin}`)
  const user = parts.join('\n\n')

  const commentLines: string[] = [`Dialect: ${engineName}`]
  if (schemaBlock) {
    commentLines.push('Schema:', ...schemaBlock.split('\n'))
  }
  if (recent.length > 0) {
    commentLines.push('Recent:', ...recent)
  }
  const fimHeader =
    input.dialect === 'redis'
      ? commentLines.map((l) => `# ${l}`).join('\n') + '\n'
      : `/*\n${commentLines.join('\n').replace(/\*\//g, '* /')}\n*/\n`

  const suffixNewline = input.suffix.indexOf('\n')
  const currentLineSuffix = input.suffix.slice(0, suffixNewline === -1 ? input.suffix.length : suffixNewline)
  const isLineEnd = /^\s*[);]*\s*$/.test(currentLineSuffix)
  const inComment = isPrefixInComment(input.prefix, input.dialect)
  const multiline = isLineEnd && !inComment

  return {
    system,
    user,
    fimPrefix: `${fimHeader}${prefixWin}`.slice(-AI_PREFIX_CHARS),
    fimSuffix: suffixWin,
    referencedTables,
    multiline,
    inComment,
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
  const extracted = extractJsonObject(raw)
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

  const cleanedPlain = raw.replace(/^\s*```[^\n]*\n?|\n?```\s*$/g, '').trim()
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
}

export interface BuiltFixQueryPrompt {
  system: string
  user: string
  resolvedLanguage: { code: string; label: string }
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

  const system =
    `You are a senior database engineer fixing a broken SQL/NoSQL query for ${engineName}.\n` +
    `Preserve the user's intent, table/column names, and quoting style; NEVER invent columns or tables that are not in the provided schema or original query.\n` +
    `Respond with ONLY a single valid JSON object matching:\n` +
    `{"fixedSql":"string","explanation":"string","changesSummary":"string"}\n` +
    `Do NOT wrap the JSON in markdown fences or include commentary outside the JSON.\n` +
    `- fixedSql must contain the corrected executable query only (no markdown backticks).\n` +
    `- explanation must be 1-3 concise sentences in ${resolvedLanguage.label} explaining what caused the error and why the fix resolves it.\n` +
    `- changesSummary must be 1 short line in ${resolvedLanguage.label} summarizing what changed (e.g., Completed truncated keyword LIM to LIMIT 100).\n` +
    `- Keep SQL/NoSQL keywords, table names, column names, and identifiers in standard ${engineName} syntax.`

  const userParts: string[] = [
    `Engine: ${engineName}`,
    `Broken query:\n${cappedSql}`,
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
