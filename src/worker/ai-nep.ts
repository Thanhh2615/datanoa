import type { AiInlineEdit } from '../protocol'
import {
  isPostgresEscapeStringStart,
  isolateActiveSqlStatement,
  matchDollarQuoteTag,
  scanBlockCommentEnd,
  scanLineCommentEnd,
  scanOracleQuoteEnd,
  scanQuotedSegmentEnd,
  supportsDollarQuoting,
  supportsNestedBlockComments,
  usesBackslashAndHash,
} from '../shared-sql-core.js'
import { analyzeSqlDiagnostics, type SqlDiagnostic } from '../shared-sql-diagnostics.js'
import {
  VALID_SQL_WORDS,
  damerauLevenshtein,
  formatCorrectedKeyword,
  isProseExplanation,
  looksInjected,
  resolveTrailingTypoToken,
  stripSpecialCompletionTokens,
  type AiDialect,
} from './ai-client'
import {
  extractReferencedTables,
  extractTrailingPartialTableName,
  isPrefixInComment,
  type WorkerSchemaSnapshot,
} from './ai-sql-context'
import { checkSqlGrammar, hasNonCursorGrammarError } from './sql-grammar'

export const NEP_MAX_STATEMENT_LINES = 40
export const NEP_MAX_STATEMENT_CHARS = 2400
export const NEP_MANUAL_MAX_STATEMENT_LINES = 80
export const NEP_MANUAL_MAX_STATEMENT_CHARS = 4000
export const NEP_MAX_EDIT_DISTANCE = 200
export const NEP_MAX_HUNKS = 6

export interface ActiveStatementWindow {
  text: string
  spanStart: number
  spanEnd: number
  relCursor: number
  cursorOffsetInSpan: number
  lineCount: number
  hasPrecedingStatements: boolean
  terminatedBySemicolon: boolean
  semiEnd: number
  cursorAfterSemicolon: boolean
  isFreshStatementAfterSemicolon: boolean
}

export type SqlDiffTokenKind =
  | 'nl'
  | 'ws'
  | 'comment'
  | 'string'
  | 'quoted_ident'
  | 'word'
  | 'number'
  | 'op'

export interface SqlDiffToken {
  kind: SqlDiffTokenKind
  text: string
  start: number
  end: number
  closed?: boolean
}

export interface RawTokenHunk {
  origTokens: SqlDiffToken[]
  newTokens: SqlDiffToken[]
  from: number
  to: number
  insert: string
}

export interface ShadowHealResult {
  diagnostics: SqlDiagnostic[]
  shadowSql: string
  cteNames: Set<string>
  healedTables: string[]
  knownRealTables: Set<string>
  userAliases: Set<string>
  activeColumns: Set<string>
  hasEarlierSyntaxError: boolean
  hasEarlierSchemaTypo: boolean
  hasEarlierFuncTypo: boolean
  hasEarlierMissingComma: boolean
  hasAfterCursorError: boolean
  hasUnderCursorError: boolean
  hasGrammarSyntaxError?: boolean
  suspectedTypoIdentifiers: Set<string>
}

interface RealTableEntry {
  qualified: string
  schema: string
  bare: string
  bareLower: string
  cols: string[]
}

const FUSED_TABLE_CLAUSE_SUFFIXES = [
  'WHERE',
  'ORDER',
  'GROUP',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'JOIN',
  'SET',
] as const

const UNDER_CURSOR_CLAUSE_KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'ORDER',
  'GROUP',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'JOIN',
  'INTO',
  'VALUES',
  'UPDATE',
  'DELETE',
  'RETURNING',
] as const

type TokenCursorZone = 'before' | 'under' | 'after' | 'ignored'
type HealErrorKind = 'syntax' | 'schema' | 'func' | 'comma'

interface HealErrorFlags {
  hasEarlierSyntaxError: boolean
  hasEarlierSchemaTypo: boolean
  hasEarlierFuncTypo: boolean
  hasEarlierMissingComma: boolean
  hasAfterCursorError: boolean
  hasUnderCursorError: boolean
}

function classifySpanCursorZone(
  start: number,
  end: number,
  activeTokStart: number,
  activeTokEnd: number,
  allowUnderCursor: boolean
): TokenCursorZone {
  if (end <= activeTokStart) return 'before'
  if (start >= activeTokEnd) return 'after'
  return allowUnderCursor ? 'under' : 'ignored'
}

function recordZoneError(zone: TokenCursorZone, kind: HealErrorKind, flags: HealErrorFlags): boolean {
  if (zone === 'ignored') return false
  if (zone === 'under') {
    flags.hasUnderCursorError = true
    return true
  }
  if (zone === 'after') {
    flags.hasAfterCursorError = true
    return true
  }
  if (kind === 'syntax') flags.hasEarlierSyntaxError = true
  else if (kind === 'schema') flags.hasEarlierSchemaTypo = true
  else if (kind === 'func') flags.hasEarlierFuncTypo = true
  else flags.hasEarlierMissingComma = true
  return true
}

const STRUCTURAL_KEYWORDS: ReadonlySet<string> = new Set(['BY', 'INTO', 'ON', 'FROM', 'AS'])
const CLOSING_DELIMITERS: ReadonlySet<string> = new Set([')', ']', "'", '"', '`'])
const MULTI_CHAR_OPS = ['->>', '->','!=', '<>', '<=', '>=', '::', '||'] as const
const CLAUSE_BARRIER_WORDS: ReadonlySet<string> = new Set([
  'FROM',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'CROSS',
  'FULL',
  'WHERE',
  'ORDER',
  'GROUP',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'INTO',
  'SET',
  'VALUES',
  'RETURNING',
])

function isLikelyTypoWord(aLower: string, bLower: string, maxRatio = 0.4): boolean {
  const minLen = Math.min(aLower.length, bLower.length)
  const maxLen = Math.max(aLower.length, bLower.length)
  if (minLen < 3 || maxLen === 0) return false
  const maxDist = maxLen <= 4 ? 1 : 2
  if (Math.abs(aLower.length - bLower.length) > maxDist) return false
  const dist = damerauLevenshtein(aLower, bLower)
  return dist >= 1 && dist <= maxDist && dist / maxLen <= maxRatio
}

function isShortOrTypoIdentMatch(candidateLower: string, targetLower: string, maxRatio = 0.35): boolean {
  if (!candidateLower || !targetLower) return false
  if (candidateLower === targetLower) return true
  if (isLikelyTypoWord(candidateLower, targetLower, maxRatio)) return true
  return (
    candidateLower.length === 2 &&
    targetLower.length >= 3 &&
    targetLower.length <= 4 &&
    damerauLevenshtein(candidateLower, targetLower) === 1
  )
}

function isStrictPrefixOfKnown(
  lower: string,
  upper: string,
  realTables: readonly RealTableEntry[],
  activeColumns: ReadonlySet<string>,
  cteNames: ReadonlySet<string>
): boolean {
  if (!lower) return false
  for (const w of VALID_SQL_WORDS) {
    if (w.length > upper.length && w.startsWith(upper)) return true
  }
  for (const rt of realTables) {
    if (rt.bareLower.length > lower.length && rt.bareLower.startsWith(lower)) return true
  }
  for (const col of activeColumns) {
    if (col.length > lower.length && col.startsWith(lower)) return true
  }
  for (const cte of cteNames) {
    if (cte.length > lower.length && cte.startsWith(lower)) return true
  }
  return false
}

function unquoteSqlIdent(raw: string): string {
  if (raw.length >= 2) {
    if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).replace(/""/g, '"')
    if (raw.startsWith('`') && raw.endsWith('`')) return raw.slice(1, -1).replace(/``/g, '`')
    if (raw.startsWith('[') && raw.endsWith(']')) return raw.slice(1, -1).replace(/\]\]/g, ']')
  }
  return raw
}

function advancePastLeadingCommentsAndWs(
  text: string,
  start: number,
  maxPos: number,
  dialect?: AiDialect
): number {
  let i = start
  const allowHash = usesBackslashAndHash(dialect)
  const nested = supportsNestedBlockComments(dialect)
  while (i < maxPos) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1
      continue
    }
    const next = text[i + 1]
    if ((ch === '-' && next === '-') || (allowHash && ch === '#')) {
      const endLine = scanLineCommentEnd(text, ch === '-' ? i : i - 1)
      if (endLine > maxPos) break
      i = endLine
      continue
    }
    if (ch === '/' && next === '*') {
      const endBlock = scanBlockCommentEnd(text, i, nested)
      if (endBlock > maxPos) break
      i = endBlock
      continue
    }
    break
  }
  return i
}

/** Extracts the active SQL statement around the cursor, excluding leading comment headers and handling `;` boundaries. */
export function extractActiveStatementWindow(
  boundedPrefix: string,
  boundedSuffix: string,
  dialect?: AiDialect,
  options?: { allowPrecedingOnFreshLine?: boolean }
): ActiveStatementWindow | null {
  if (dialect === 'mongodb' || dialect === 'redis') return null
  const iso = isolateActiveSqlStatement(boundedPrefix, boundedSuffix, dialect)

  if (iso.isFreshStatementAfterSemicolon) {
    if (!options?.allowPrecedingOnFreshLine || !iso.precedingErroredSlice) {
      return null
    }
    const prev = iso.precedingErroredSlice
    const cleanOffset = advancePastLeadingCommentsAndWs(prev.text, 0, prev.text.length, dialect)
    const text = prev.text.slice(cleanOffset)
    if (!text.trim()) return null
    const spanStart = prev.spanStart + cleanOffset
    const spanEnd = prev.spanEnd
    const relCursor = text.length
    const cursorOffsetInSpan = boundedPrefix.length - spanStart
    const semiEnd = prev.semiEnd >= 0 ? Math.max(0, prev.semiEnd - cleanOffset) : text.length
    return {
      text,
      spanStart,
      spanEnd,
      relCursor,
      cursorOffsetInSpan,
      lineCount: text.split(/\r?\n/).length,
      hasPrecedingStatements: spanStart > 0 && boundedPrefix.slice(0, spanStart).includes(';'),
      terminatedBySemicolon: true,
      semiEnd,
      cursorAfterSemicolon: true,
      isFreshStatementAfterSemicolon: true,
    }
  }

  if (!iso.text.trim()) return null
  const cleanOffset = advancePastLeadingCommentsAndWs(
    iso.text,
    0,
    Math.min(iso.relCursor, iso.text.length),
    dialect
  )
  const text = iso.text.slice(cleanOffset)
  if (!text.replace(/;/g, '').trim()) return null
  const spanStart = iso.spanStart + cleanOffset
  const spanEnd = iso.spanEnd
  const relCursor = iso.relCursor - cleanOffset
  const cursorOffsetInSpan = iso.cursorOffsetInSpan - cleanOffset
  const semiEnd = iso.semiEnd >= 0 ? Math.max(0, iso.semiEnd - cleanOffset) : -1
  return {
    text,
    spanStart,
    spanEnd,
    relCursor,
    cursorOffsetInSpan,
    lineCount: text.split(/\r?\n/).length,
    hasPrecedingStatements:
      iso.hasPrecedingStatements || (spanStart > 0 && boundedPrefix.slice(0, spanStart).includes(';')),
    terminatedBySemicolon: iso.terminatedBySemicolon,
    semiEnd,
    cursorAfterSemicolon: iso.cursorAfterSemicolon,
    isFreshStatementAfterSemicolon: false,
  }
}

/** Lossless SQL tokenizer splitting text into SQL diff tokens and tracking closed/unclosed string & comment state. */
export function tokenizeSqlForDiff(text: string, dialect?: AiDialect): SqlDiffToken[] {
  const tokens: SqlDiffToken[] = []
  const len = text.length
  const allowBackslash = usesBackslashAndHash(dialect)
  const allowHash = usesBackslashAndHash(dialect)
  const nested = supportsNestedBlockComments(dialect)
  const allowDollar = supportsDollarQuoting(dialect)
  let i = 0

  while (i < len) {
    const ch = text[i]
    const next = text[i + 1]

    if (ch === '\r' || ch === '\n') {
      const start = i
      if (ch === '\r' && next === '\n') i += 2
      else i += 1
      tokens.push({ kind: 'nl', text: text.slice(start, i), start, end: i })
      continue
    }

    if (ch === ' ' || ch === '\t' || ch === '\f' || ch === '\v') {
      const start = i
      while (i < len) {
        const c = text[i]
        if (c === ' ' || c === '\t' || c === '\f' || c === '\v') i += 1
        else break
      }
      tokens.push({ kind: 'ws', text: text.slice(start, i), start, end: i })
      continue
    }

    if ((ch === '-' && next === '-') || (allowHash && ch === '#')) {
      const start = i
      let end = scanLineCommentEnd(text, ch === '-' ? i : i - 1)
      if (end > start && text[end - 1] === '\n') {
        end -= text[end - 2] === '\r' ? 2 : 1
      }
      i = Math.max(start + 1, end)
      tokens.push({ kind: 'comment', text: text.slice(start, i), start, end: i, closed: true })
      continue
    }

    if (ch === '/' && next === '*') {
      const start = i
      let depth = 1
      let p = i + 2
      let closed = false
      while (p < len) {
        if (nested && text[p] === '/' && text[p + 1] === '*') {
          depth += 1
          p += 2
          continue
        }
        if (text[p] === '*' && text[p + 1] === '/') {
          depth -= 1
          p += 2
          if (depth === 0) {
            closed = true
            break
          }
          continue
        }
        p += 1
      }
      i = p
      tokens.push({ kind: 'comment', text: text.slice(start, i), start, end: i, closed })
      continue
    }

    if (dialect === 'oracle') {
      const oq = scanOracleQuoteEnd(text, i, dialect)
      if (oq) {
        tokens.push({
          kind: 'string',
          text: text.slice(i, oq.end),
          start: i,
          end: oq.end,
          closed: oq.closed,
        })
        i = oq.end
        continue
      }
    }

    if (allowDollar && ch === '$') {
      const tag = matchDollarQuoteTag(text, i)
      if (tag) {
        const closeAt = text.indexOf(tag, i + tag.length)
        const end = closeAt === -1 ? len : closeAt + tag.length
        tokens.push({
          kind: 'string',
          text: text.slice(i, end),
          start: i,
          end,
          closed: closeAt !== -1,
        })
        i = end
        continue
      }
    }

    if ((ch === 'E' || ch === 'e') && next === "'" && isPostgresEscapeStringStart(text, i, dialect)) {
      const seg = scanQuotedSegmentEnd(text, i + 1, "'", true)
      tokens.push({
        kind: 'string',
        text: text.slice(i, seg.end),
        start: i,
        end: seg.end,
        closed: seg.closed,
      })
      i = seg.end
      continue
    }

    if (ch === "'") {
      const seg = scanQuotedSegmentEnd(text, i, "'", allowBackslash)
      tokens.push({
        kind: 'string',
        text: text.slice(i, seg.end),
        start: i,
        end: seg.end,
        closed: seg.closed,
      })
      i = seg.end
      continue
    }

    if (ch === '"' || ch === '`') {
      const seg = scanQuotedSegmentEnd(text, i, ch, ch === '"' && allowBackslash)
      tokens.push({
        kind: 'quoted_ident',
        text: text.slice(i, seg.end),
        start: i,
        end: seg.end,
        closed: seg.closed,
      })
      i = seg.end
      continue
    }

    if (dialect === 'mssql' && ch === '[') {
      const start = i
      let p = i + 1
      let closed = false
      while (p < len) {
        if (text[p] === ']') {
          if (text[p + 1] === ']') {
            p += 2
            continue
          }
          p += 1
          closed = true
          break
        }
        p += 1
      }
      i = p
      tokens.push({ kind: 'quoted_ident', text: text.slice(start, i), start, end: i, closed })
      continue
    }

    if (/[A-Za-z_]/.test(ch)) {
      const start = i
      i += 1
      while (i < len && /[A-Za-z0-9_$]/.test(text[i])) i += 1
      tokens.push({ kind: 'word', text: text.slice(start, i), start, end: i })
      continue
    }

    if (/[0-9]/.test(ch)) {
      const start = i
      i += 1
      while (i < len && /[0-9.]/.test(text[i])) i += 1
      tokens.push({ kind: 'number', text: text.slice(start, i), start, end: i })
      continue
    }

    let matchedOp = ''
    for (const op of MULTI_CHAR_OPS) {
      if (text.startsWith(op, i)) {
        matchedOp = op
        break
      }
    }
    const end = i + (matchedOp ? matchedOp.length : 1)
    tokens.push({ kind: 'op', text: text.slice(i, end), start: i, end })
    i = end
  }

  return tokens
}

function canonicalTokenKey(token: SqlDiffToken): string {
  if (token.kind === 'ws' || token.kind === 'nl') return 'WS'
  if (token.kind === 'word') return `W:${token.text.toLowerCase()}`
  return `T:${token.kind}:${token.text}`
}

type DiffOp =
  | { kind: 'equal'; orig: SqlDiffToken; next: SqlDiffToken }
  | { kind: 'delete'; orig: SqlDiffToken }
  | { kind: 'insert'; next: SqlDiffToken }

/** Canonical-key Myers diff O((N+M)*D) splitting equal-key raw mismatches cleanly from adjacent edits. */
export function diffSqlTokens(
  origTokens: readonly SqlDiffToken[],
  newTokens: readonly SqlDiffToken[]
): RawTokenHunk[] | null {
  const n = origTokens.length
  const m = newTokens.length
  if (n === 0 && m === 0) return []

  const origKeys = origTokens.map(canonicalTokenKey)
  const newKeys = newTokens.map(canonicalTokenKey)
  const maxD = Math.min(NEP_MAX_EDIT_DISTANCE, n + m)
  const offset = maxD
  const v = new Int32Array(2 * maxD + 1)
  const trace: Int32Array[] = []
  let reachedD = -1

  for (let d = 0; d <= maxD; d += 1) {
    trace.push(new Int32Array(v))
    for (let k = -d; k <= d; k += 2) {
      const kIdx = k + offset
      let x =
        k === -d || (k !== d && (v[kIdx - 1] ?? 0) < (v[kIdx + 1] ?? 0))
          ? v[kIdx + 1] ?? 0
          : (v[kIdx - 1] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && origKeys[x] === newKeys[y]) {
        x += 1
        y += 1
      }
      v[kIdx] = x
      if (x >= n && y >= m) {
        reachedD = d
        break
      }
    }
    if (reachedD >= 0) break
  }

  if (reachedD < 0) return null

  const ops: DiffOp[] = []
  let x = n
  let y = m
  for (let d = reachedD; d > 0; d -= 1) {
    const prevV = trace[d] ?? v
    const k = x - y
    const kIdx = k + offset
    const goDown = k === -d || (k !== d && (prevV[kIdx - 1] ?? 0) < (prevV[kIdx + 1] ?? 0))
    const prevK = goDown ? k + 1 : k - 1
    const prevX = prevV[prevK + offset] ?? 0
    const prevY = prevX - prevK

    while (x > prevX && y > prevY) {
      const origTok = origTokens[x - 1]
      const newTok = newTokens[y - 1]
      if (origTok && newTok) {
        ops.push({ kind: 'equal', orig: origTok, next: newTok })
      }
      x -= 1
      y -= 1
    }

    if (goDown && y > prevY) {
      const newTok = newTokens[prevY]
      if (newTok) ops.push({ kind: 'insert', next: newTok })
    } else if (x > prevX) {
      const origTok = origTokens[prevX]
      if (origTok) ops.push({ kind: 'delete', orig: origTok })
    }
    x = prevX
    y = prevY
  }

  while (x > 0 && y > 0) {
    const origTok = origTokens[x - 1]
    const newTok = newTokens[y - 1]
    if (origTok && newTok) {
      ops.push({ kind: 'equal', orig: origTok, next: newTok })
    }
    x -= 1
    y -= 1
  }
  while (x > 0) {
    const origTok = origTokens[x - 1]
    if (origTok) ops.push({ kind: 'delete', orig: origTok })
    x -= 1
  }
  while (y > 0) {
    const newTok = newTokens[y - 1]
    if (newTok) ops.push({ kind: 'insert', next: newTok })
    y -= 1
  }

  ops.reverse()

  const hunks: RawTokenHunk[] = []
  let curOrig: SqlDiffToken[] = []
  let curNew: SqlDiffToken[] = []
  let anchorPos = 0

  const flush = () => {
    if (curOrig.length === 0 && curNew.length === 0) return
    const firstOrig = curOrig[0]
    const lastOrig = curOrig[curOrig.length - 1]
    const from = firstOrig ? firstOrig.start : anchorPos
    const to = lastOrig ? lastOrig.end : anchorPos
    const insert = curNew.map((t) => t.text).join('')
    hunks.push({ origTokens: curOrig, newTokens: curNew, from, to, insert })
    curOrig = []
    curNew = []
  }

  for (const op of ops) {
    if (op.kind === 'equal') {
      flush()
      if (op.orig.text !== op.next.text) {
        hunks.push({
          origTokens: [op.orig],
          newTokens: [op.next],
          from: op.orig.start,
          to: op.orig.end,
          insert: op.next.text,
        })
      }
      anchorPos = op.orig.end
    } else if (op.kind === 'delete') {
      curOrig.push(op.orig)
      anchorPos = op.orig.end
    } else {
      curNew.push(op.next)
    }
  }
  flush()
  return hunks
}

function lookupSchemaMapCols(
  schemaMap: Record<string, string[]> | undefined,
  key: string
): string[] | undefined {
  if (!schemaMap || !key || !Object.hasOwn(schemaMap, key)) return undefined
  const cols = schemaMap[key]
  return Array.isArray(cols) ? cols : undefined
}

function collectRealTables(
  snapshot: WorkerSchemaSnapshot | null,
  schemaMap?: Record<string, string[]>
): RealTableEntry[] {
  const byKey = new Map<string, RealTableEntry>()
  const register = (rawName: string, schema: string, cols: string[]) => {
    const cleanName = unquoteSqlIdent(rawName.trim())
    if (!cleanName) return
    const dot = cleanName.lastIndexOf('.')
    const finalSchema = dot >= 0 ? cleanName.slice(0, dot) : schema
    const bare = dot >= 0 ? cleanName.slice(dot + 1) : cleanName
    if (!bare) return
    const qualified = finalSchema ? `${finalSchema}.${bare}` : bare
    const key = qualified.toLowerCase()
    const existing = byKey.get(key)
    if (existing) {
      if (cols.length > existing.cols.length) existing.cols = cols
      return
    }
    byKey.set(key, {
      qualified,
      schema: finalSchema,
      bare,
      bareLower: bare.toLowerCase(),
      cols,
    })
  }

  if (snapshot) {
    for (const obj of snapshot.objects) {
      if (obj.kind && obj.kind !== 'table' && obj.kind !== 'view' && obj.kind !== 'materialized_view') {
        continue
      }
      const sch = obj.schema || ''
      const detKey = `${sch.toLowerCase()}.${obj.name.toLowerCase()}`
      const det = snapshot.details.get(detKey) ?? snapshot.details.get(obj.name.toLowerCase())
      const cols = det
        ? det.columns.map((c) => c.name)
        : lookupSchemaMapCols(schemaMap, obj.name) ??
          (sch ? lookupSchemaMapCols(schemaMap, `${sch}.${obj.name}`) : undefined) ??
          []
      register(obj.name, sch, cols)
    }
    for (const det of snapshot.details.values()) {
      register(det.name, det.schema || '', det.columns.map((c) => c.name))
    }
  }

  if (schemaMap) {
    for (const [k, cols] of Object.entries(schemaMap)) {
      if (!Array.isArray(cols)) continue
      const lowerBare = (k.includes('.') ? k.split('.').pop() || k : k).toLowerCase()
      const alreadyHasCols = Array.from(byKey.values()).some(
        (e) => e.bareLower === lowerBare && e.cols.length > 0
      )
      if (!alreadyHasCols) register(k, '', cols)
    }
  }

  return Array.from(byKey.values())
}

function extractCteNames(sql: string): Set<string> {
  const ctes = new Set<string>()
  const withHeadRe = /\bWITH\s+(?:RECURSIVE\s+)?([A-Za-z_][A-Za-z0-9_$]*)\s*(?:\([^)]*\)\s*)?\bAS\s*\(/gi
  let m: RegExpExecArray | null
  while ((m = withHeadRe.exec(sql)) !== null) {
    if (m[1]) ctes.add(m[1].toLowerCase())
  }
  const nextCteRe = /\)\s*,\s*([A-Za-z_][A-Za-z0-9_$]*)\s*(?:\([^)]*\)\s*)?\bAS\s*\(/gi
  while ((m = nextCteRe.exec(sql)) !== null) {
    if (m[1]) ctes.add(m[1].toLowerCase())
  }
  return ctes
}

function applyDiagnosticsToShadowSql(sql: string, diags: readonly SqlDiagnostic[]): string {
  const sorted = [...diags]
    .filter(
      (d) =>
        Boolean(d.suggestion) &&
        (d.code === 'unknown-keyword' ||
          d.code === 'misspelled-clause' ||
          d.code === 'unexpected-statement-start')
    )
    .sort((a, b) => b.from - a.from)
  let out = sql
  let prevFrom = Infinity
  for (const d of sorted) {
    if (!d.suggestion || d.to > prevFrom || d.from < 0 || d.to > out.length) continue
    out = `${out.slice(0, d.from)}${d.suggestion}${out.slice(d.to)}`
    prevFrom = d.from
  }
  return out
}

function findFuzzyTableMatch(
  rawRef: string,
  realTables: readonly RealTableEntry[],
  activeSchema?: string
): RealTableEntry[] {
  const dot = rawRef.lastIndexOf('.')
  const refSchema = dot >= 0 ? rawRef.slice(0, dot).toLowerCase() : ''
  const bareLower = (dot >= 0 ? rawRef.slice(dot + 1) : rawRef).toLowerCase()
  if (bareLower.length < 3) return []

  const scored: Array<{ entry: RealTableEntry; dist: number; schemaBonus: number }> = []
  for (const entry of realTables) {
    if (entry.bareLower === bareLower) return []
    if (!isLikelyTypoWord(bareLower, entry.bareLower, 0.35)) continue
    const dist = damerauLevenshtein(bareLower, entry.bareLower)
    const entrySch = entry.schema.toLowerCase()
    const targetSch = refSchema || (activeSchema || '').toLowerCase()
    const schemaBonus = targetSch && entrySch === targetSch ? 0 : 1
    scored.push({ entry, dist, schemaBonus })
  }
  scored.sort(
    (a, b) =>
      a.dist - b.dist ||
      a.schemaBonus - b.schemaBonus ||
      a.entry.bareLower.length - b.entry.bareLower.length
  )
  return scored.slice(0, 2).map((s) => s.entry)
}

function findActiveTokenSpan(
  stmt: ActiveStatementWindow,
  tokens: readonly SqlDiffToken[]
): { start: number; end: number } {
  if (stmt.cursorAfterSemicolon) {
    return { start: stmt.relCursor, end: stmt.relCursor }
  }
  const overlapping = tokens.find(
    (t) =>
      (t.kind === 'word' || (t.kind === 'quoted_ident' && t.closed !== false)) &&
      t.start <= stmt.relCursor &&
      stmt.relCursor <= t.end
  )
  if (overlapping) {
    return { start: overlapping.start, end: overlapping.end }
  }
  const trailingMatch = /("[^"\n]+"|`[^`\n]+`|\[[^\]\n]+\]|[A-Za-z0-9_]+)[ \t]*$/.exec(
    stmt.text.slice(0, stmt.relCursor)
  )
  if (!trailingMatch) {
    return { start: stmt.relCursor, end: stmt.relCursor }
  }
  const start = stmt.relCursor - trailingMatch[0].length
  return { start, end: start + trailingMatch[1].length }
}

function promoteSplitRealTables(
  stmtText: string,
  relCursor: number,
  nonWsTokens: readonly SqlDiffToken[],
  realBareMap: ReadonlyMap<string, RealTableEntry[]>,
  cteNames: ReadonlySet<string>,
  activeTokStart: number,
  activeTokEnd: number,
  suspectedTypoIdentifiers: Set<string>,
  registerTable: (entry: RealTableEntry) => void,
  flags: HealErrorFlags
): void {
  for (let i = 0; i < nonWsTokens.length - 1; i += 1) {
    const left = nonWsTokens[i]
    const right = nonWsTokens[i + 1]
    if (!left || !right || left.kind !== 'word' || right.kind !== 'word') continue
    if (!/^[ \t]+$/.test(stmtText.slice(left.end, right.start))) continue

    const leftLower = left.text.toLowerCase()
    const rightLower = right.text.toLowerCase()
    const leftValid = VALID_SQL_WORDS.has(left.text.toUpperCase()) || realBareMap.has(leftLower) || cteNames.has(leftLower)
    const rightValid =
      VALID_SQL_WORDS.has(right.text.toUpperCase()) || realBareMap.has(rightLower) || cteNames.has(rightLower)
    if (leftValid && rightValid) continue

    const matches = realBareMap.get(`${leftLower}${rightLower}`)
    if (!matches || matches.length === 0) continue

    for (const tm of matches) registerTable(tm)
    suspectedTypoIdentifiers.add(leftLower)
    suspectedTypoIdentifiers.add(rightLower)
    const zone: TokenCursorZone =
      left.start <= relCursor && relCursor <= right.end
        ? 'under'
        : classifySpanCursorZone(left.start, right.end, activeTokStart, activeTokEnd, false)
    recordZoneError(zone, 'schema', flags)
  }
}

function isUnderCursorClauseTypo(
  lower: string,
  upper: string,
  prevUpper: string,
  next: SqlDiffToken | undefined,
  realTables: readonly RealTableEntry[],
  realBareMap: ReadonlyMap<string, RealTableEntry[]>,
  activeColumns: ReadonlySet<string>,
  cteNames: ReadonlySet<string>,
  userAliases: ReadonlySet<string>
): boolean {
  if (prevUpper === 'AS' || next?.text === '(') return false
  if (
    VALID_SQL_WORDS.has(upper) ||
    cteNames.has(lower) ||
    userAliases.has(lower) ||
    realBareMap.has(lower) ||
    activeColumns.has(lower)
  ) {
    return false
  }
  if (isStrictPrefixOfKnown(lower, upper, realTables, activeColumns, cteNames)) return false
  for (const kw of UNDER_CURSOR_CLAUSE_KEYWORDS) {
    const kwLower = kw.toLowerCase()
    if (lower !== `${kwLower}s` && isLikelyTypoWord(lower, kwLower, 0.35)) {
      return true
    }
  }
  return false
}

function populateSchemaColsFromTables(
  knownSchemaCols: Set<string>,
  realTables: readonly RealTableEntry[],
  knownReferencedCols: ReadonlySet<string>
): void {
  for (const rt of realTables) {
    if (realTables.length > 5 && !rt.cols.some((c) => knownReferencedCols.has(c.toLowerCase()))) {
      continue
    }
    for (const c of rt.cols) knownSchemaCols.add(c.toLowerCase())
  }
}

function buildQuotedSchemaColumnPool(
  nonWsTokens: readonly SqlDiffToken[],
  activeColumns: ReadonlySet<string>,
  realTables: readonly RealTableEntry[]
): { knownSchemaCols: Set<string>; quotedColPool: Set<string> } {
  const siblingQuotedIdents = new Set<string>()
  const knownReferencedCols = new Set<string>()
  for (let i = 0; i < nonWsTokens.length; i += 1) {
    const tok = nonWsTokens[i]
    if (!tok) continue
    const prevTok = i > 0 ? nonWsTokens[i - 1] : undefined
    const precededByAs = prevTok?.kind === 'word' && prevTok.text.toUpperCase() === 'AS'
    if (tok.kind === 'quoted_ident' && tok.closed !== false) {
      if (precededByAs) continue
      const inner = unquoteSqlIdent(tok.text)
      if (inner && !/[ \t\r\n]/.test(inner)) {
        siblingQuotedIdents.add(inner.toLowerCase())
        knownReferencedCols.add(inner.toLowerCase())
      }
    } else if (tok.kind === 'word') {
      knownReferencedCols.add(tok.text.toLowerCase())
    }
  }
  const knownSchemaCols = new Set<string>(activeColumns)
  if (activeColumns.size === 0) {
    populateSchemaColsFromTables(knownSchemaCols, realTables, knownReferencedCols)
  }
  const quotedColPool = new Set<string>(knownSchemaCols)
  for (const sib of siblingQuotedIdents) quotedColPool.add(sib)
  return { knownSchemaCols, quotedColPool }
}

function isValidUnclosedQuotedPrefix(
  rawInner: string,
  knownSchemaCols: ReadonlySet<string>,
  realTables: readonly RealTableEntry[]
): boolean {
  if (!rawInner || /^[ \t]|[ \t]{2,}/.test(rawInner)) return false
  const lower = rawInner.toLowerCase()
  for (const col of knownSchemaCols) {
    if (col.startsWith(lower)) return true
  }
  for (const rt of realTables) {
    if (rt.bareLower.startsWith(lower)) return true
  }
  return false
}

function isBrokenClosedQuotedIdent(
  tok: SqlDiffToken,
  prevTok: SqlDiffToken | undefined,
  isUnderTok: boolean,
  relCursor: number,
  realTables: readonly RealTableEntry[],
  realBareMap: ReadonlyMap<string, RealTableEntry[]>,
  cteNames: ReadonlySet<string>,
  knownSchemaCols: ReadonlySet<string>,
  quotedColPool: ReadonlySet<string>,
  activeSchema?: string
): { broken: boolean; innerLower: string } {
  const inner = unquoteSqlIdent(tok.text)
  const innerLower = inner.toLowerCase()
  const prevUpper = prevTok?.kind === 'word' ? prevTok.text.toUpperCase() : ''
  if (!inner || knownSchemaCols.has(innerLower) || realBareMap.has(innerLower) || cteNames.has(innerLower)) {
    return { broken: false, innerLower }
  }
  if (prevUpper === 'AS' && !/^[ \t]|[ \t]$|[ \t]{2,}/.test(inner)) {
    return { broken: false, innerLower }
  }
  if (/^[ \t]|[ \t]$|[ \t]{2,}/.test(inner)) {
    return { broken: true, innerLower }
  }
  if (/[ \t]/.test(inner)) {
    const collapsed = innerLower.replace(/[ \t]+/g, '')
    if (collapsed.length < 2) return { broken: false, innerLower }
    const broken =
      quotedColPool.has(collapsed) ||
      realBareMap.has(collapsed) ||
      cteNames.has(collapsed) ||
      findFuzzyTableMatch(collapsed, realTables, activeSchema).length > 0 ||
      Array.from(quotedColPool).some((c) => isShortOrTypoIdentMatch(collapsed, c, 0.35))
    return { broken, innerLower }
  }
  if (innerLower.length < 2) return { broken: false, innerLower }

  const atCloseEdge = relCursor === tok.end - 1 || relCursor === tok.end
  const isPrefixTypingAtClose =
    isUnderTok &&
    atCloseEdge &&
    (Array.from(quotedColPool).some((c) => c.length > innerLower.length && c.startsWith(innerLower)) ||
      realTables.some((r) => r.bareLower.length > innerLower.length && r.bareLower.startsWith(innerLower)))
  if (isPrefixTypingAtClose) return { broken: false, innerLower }

  const isTablePos = prevUpper === 'FROM' || prevUpper === 'JOIN'
  if (isTablePos && findFuzzyTableMatch(innerLower, realTables, activeSchema).length > 0) {
    return { broken: true, innerLower }
  }
  const matchesFuzzyCol =
    knownSchemaCols.size > 0 &&
    !VALID_SQL_WORDS.has(inner.toUpperCase()) &&
    Array.from(knownSchemaCols).some((c) => c !== innerLower && isShortOrTypoIdentMatch(innerLower, c, 0.35))
  return { broken: matchesFuzzyCol, innerLower }
}

function scanQuotedIdentifierErrors(
  stmt: ActiveStatementWindow,
  nonWsTokens: readonly SqlDiffToken[],
  realTables: readonly RealTableEntry[],
  realBareMap: ReadonlyMap<string, RealTableEntry[]>,
  cteNames: ReadonlySet<string>,
  knownSchemaCols: ReadonlySet<string>,
  quotedColPool: ReadonlySet<string>,
  activeTokStart: number,
  activeTokEnd: number,
  allowsUnderCursorCheck: (start: number, end: number) => boolean,
  suspectedTypoIdentifiers: Set<string>,
  flags: HealErrorFlags,
  activeSchema?: string
): void {
  for (let i = 0; i < nonWsTokens.length; i += 1) {
    const tok = nonWsTokens[i]
    if (!tok || tok.kind !== 'quoted_ident') continue
    const isUnderTok = tok.start <= stmt.relCursor && stmt.relCursor <= tok.end
    if (tok.closed === false) {
      const innerUnclosed = tok.text.slice(1)
      if (
        /\S[ \t]+$/.test(innerUnclosed) &&
        isUnderTok &&
        !isValidUnclosedQuotedPrefix(innerUnclosed, knownSchemaCols, realTables)
      ) {
        flags.hasUnderCursorError = true
      }
      continue
    }
    const { broken, innerLower } = isBrokenClosedQuotedIdent(
      tok,
      i > 0 ? nonWsTokens[i - 1] : undefined,
      isUnderTok,
      stmt.relCursor,
      realTables,
      realBareMap,
      cteNames,
      knownSchemaCols,
      quotedColPool,
      activeSchema
    )
    if (!broken) continue
    const zone = classifySpanCursorZone(
      tok.start,
      tok.end,
      activeTokStart,
      activeTokEnd,
      isUnderTok && allowsUnderCursorCheck(tok.start, tok.end)
    )
    if (recordZoneError(zone, 'schema', flags)) {
      suspectedTypoIdentifiers.add(innerLower)
    }
  }
}

function classifySplitWordPair(
  left: SqlDiffToken,
  right: SqlDiffToken,
  gapLen: number,
  isUnderPair: boolean,
  realTables: readonly RealTableEntry[],
  realBareMap: ReadonlyMap<string, RealTableEntry[]>,
  activeColumns: ReadonlySet<string>,
  cteNames: ReadonlySet<string>,
  userAliases: ReadonlySet<string>,
  activeSchema?: string
): 'keyword' | 'schema' | null {
  const isStandaloneValid = (t: SqlDiffToken): boolean => {
    const lw = t.text.toLowerCase()
    return (
      VALID_SQL_WORDS.has(t.text.toUpperCase()) ||
      realBareMap.has(lw) ||
      activeColumns.has(lw) ||
      cteNames.has(lw) ||
      userAliases.has(lw)
    )
  }
  const leftStandalone = isStandaloneValid(left)
  const rightStandalone = isStandaloneValid(right)
  if (leftStandalone && rightStandalone) return null

  const joined = `${left.text}${right.text}`.toLowerCase()
  if (joined.length < 3) return null
  if (VALID_SQL_WORDS.has(joined.toUpperCase())) return 'keyword'

  const canCheckRightValidCol = !leftStandalone && (!rightStandalone || gapLen >= 2 || isUnderPair)
  if (canCheckRightValidCol && (realBareMap.has(joined) || activeColumns.has(joined) || cteNames.has(joined))) {
    return 'schema'
  }
  if (joined.length < 4 || leftStandalone || rightStandalone) return null

  for (const kw of VALID_SQL_WORDS) {
    if (kw.length >= 4 && isLikelyTypoWord(joined, kw.toLowerCase(), 0.35)) return 'keyword'
  }
  for (const col of activeColumns) {
    if (isLikelyTypoWord(joined, col, 0.35)) return 'schema'
  }
  if (findFuzzyTableMatch(joined, realTables, activeSchema).length > 0) return 'schema'
  return null
}

function scanWhitespaceSplitWordPairs(
  stmt: ActiveStatementWindow,
  nonWsTokens: readonly SqlDiffToken[],
  realTables: readonly RealTableEntry[],
  realBareMap: ReadonlyMap<string, RealTableEntry[]>,
  activeColumns: ReadonlySet<string>,
  cteNames: ReadonlySet<string>,
  userAliases: ReadonlySet<string>,
  activeTokStart: number,
  activeTokEnd: number,
  suspectedTypoIdentifiers: Set<string>,
  flags: HealErrorFlags,
  activeSchema?: string
): void {
  for (let i = 0; i < nonWsTokens.length - 1; i += 1) {
    const left = nonWsTokens[i]
    const right = nonWsTokens[i + 1]
    if (!left || !right || left.kind !== 'word' || right.kind !== 'word') continue
    const gap = stmt.text.slice(left.end, right.start)
    if (!/^[ \t]+$/.test(gap)) continue

    const isUnderPair = left.start <= stmt.relCursor && stmt.relCursor <= right.end
    const matchKind = classifySplitWordPair(
      left,
      right,
      gap.length,
      isUnderPair,
      realTables,
      realBareMap,
      activeColumns,
      cteNames,
      userAliases,
      activeSchema
    )
    if (!matchKind) continue

    suspectedTypoIdentifiers.add(left.text.toLowerCase())
    suspectedTypoIdentifiers.add(right.text.toLowerCase())
    const zone: TokenCursorZone = isUnderPair
      ? 'under'
      : classifySpanCursorZone(left.start, right.end, activeTokStart, activeTokEnd, false)
    recordZoneError(zone, matchKind === 'keyword' ? 'syntax' : 'schema', flags)
  }
}

function classifyStatementDiagnostics(
  stmt: ActiveStatementWindow,
  diagnostics: readonly SqlDiagnostic[],
  realTables: readonly RealTableEntry[],
  activeColumns: ReadonlySet<string>,
  cteNames: ReadonlySet<string>,
  knownSchemaCols: ReadonlySet<string>,
  activeTokStart: number,
  activeTokEnd: number,
  hasSuffixContent: boolean,
  allowsUnderCursorCheck: (start: number, end: number) => boolean,
  flags: HealErrorFlags
): void {
  let earlierDiagCount = 0
  for (const diag of diagnostics) {
    if (diag.severity !== 'error') continue
    if (diag.code === 'incomplete-clause' && !stmt.terminatedBySemicolon && stmt.relCursor >= diag.from) continue
    if (
      diag.code === 'unexpected-statement-start' &&
      !diag.suggestion &&
      VALID_SQL_WORDS.has(stmt.text.slice(diag.from, diag.to).toUpperCase())
    ) {
      continue
    }
    if (diag.code === 'missing-select-expr') {
      const gap =
        diag.from >= stmt.relCursor ? stmt.text.slice(stmt.relCursor, diag.from) : stmt.text.slice(diag.to, stmt.relCursor)
      if (gap.trim() === '') continue
    }
    const isActiveUnclosedIdentPrefix =
      diag.code === 'unterminated-identifier' &&
      !stmt.cursorAfterSemicolon &&
      !hasSuffixContent &&
      diag.to >= stmt.relCursor &&
      (!/\s/.test(stmt.text.slice(diag.from, stmt.relCursor)) ||
        isValidUnclosedQuotedPrefix(stmt.text.slice(diag.from + 1, stmt.relCursor), knownSchemaCols, realTables))
    if (isActiveUnclosedIdentPrefix) continue

    const isEarlierByRange =
      diag.to <= activeTokStart ||
      (diag.from < activeTokStart && diag.code !== 'unterminated-string' && diag.code !== 'unterminated-identifier')
    const isEarlierDelimited =
      diag.from < activeTokStart &&
      (diag.code === 'unterminated-string' ||
        diag.code === 'unterminated-identifier' ||
        diag.code === 'unmatched-paren' ||
        diag.code === 'unclosed-case')
    if (isEarlierByRange || isEarlierDelimited) {
      flags.hasEarlierSyntaxError = true
    } else if (diag.from >= activeTokEnd || (stmt.cursorAfterSemicolon && diag.to <= stmt.semiEnd)) {
      flags.hasAfterCursorError = true
    } else if (allowsUnderCursorCheck(diag.from, diag.to)) {
      const diagText = stmt.text.slice(diag.from, diag.to)
      if (
        Boolean(diag.suggestion) ||
        !isStrictPrefixOfKnown(diagText.toLowerCase(), diagText.toUpperCase(), realTables, activeColumns, cteNames)
      ) {
        flags.hasUnderCursorError = true
      }
    }
    if (diag.code !== 'incomplete-clause' && diag.to <= stmt.relCursor) {
      earlierDiagCount += 1
    }
  }
  if (earlierDiagCount >= 2) flags.hasEarlierSyntaxError = true
}

function runTwoPassDiagnostics(
  stmtText: string,
  dialect: AiDialect,
  relCursor: number
): { diagnostics: SqlDiagnostic[]; shadowFromDiags: string } {
  const diagnosticsInitial = analyzeSqlDiagnostics(stmtText, { dialect, cursorOffset: relCursor })
  let shadowFromDiags = applyDiagnosticsToShadowSql(stmtText, diagnosticsInitial)
  if (shadowFromDiags === stmtText) {
    return { diagnostics: diagnosticsInitial, shadowFromDiags }
  }
  const secondDiags = analyzeSqlDiagnostics(shadowFromDiags, {
    dialect,
    cursorOffset: Math.min(relCursor, shadowFromDiags.length),
  })
  if (secondDiags.length === 0) {
    return { diagnostics: diagnosticsInitial, shadowFromDiags }
  }
  shadowFromDiags = applyDiagnosticsToShadowSql(shadowFromDiags, secondDiags)
  const merged = [...diagnosticsInitial]
  for (const sd of secondDiags) {
    if (!merged.some((md) => Math.abs(md.from - sd.from) <= 1 && md.code === sd.code)) {
      merged.push(sd)
    }
  }
  return { diagnostics: merged, shadowFromDiags }
}

function promoteReferencedAndFuzzyTables(
  allRefs: readonly string[],
  cteNames: ReadonlySet<string>,
  realBareMap: ReadonlyMap<string, RealTableEntry[]>,
  realTables: readonly RealTableEntry[],
  partialLower: string,
  tokPositionsByBare: ReadonlyMap<string, Array<{ start: number; end: number }>>,
  activeTokStart: number,
  activeTokEnd: number,
  allowsUnderCursorCheck: (start: number, end: number) => boolean,
  matchedTables: RealTableEntry[],
  knownRealTables: Set<string>,
  registerTable: (entry: RealTableEntry) => void,
  suspectedTypoIdentifiers: Set<string>,
  flags: HealErrorFlags,
  activeSchema?: string
): void {
  for (const ref of allRefs) {
    const bare = ref.includes('.') ? ref.split('.').pop() || ref : ref
    const bareLower = bare.toLowerCase()
    if (cteNames.has(bareLower) || realBareMap.has(bareLower)) {
      for (const e of realBareMap.get(bareLower) ?? []) {
        matchedTables.push(e)
        knownRealTables.add(e.bareLower)
      }
      continue
    }
    if (partialLower && bareLower === partialLower && realTables.some((r) => r.bareLower.startsWith(partialLower))) {
      continue
    }
    const matches = findFuzzyTableMatch(ref, realTables, activeSchema)
    if (matches.length === 0) continue
    for (const m of matches) registerTable(m)
    const isPrefixOfRealTable = realTables.some(
      (r) => r.bareLower.length > bareLower.length && r.bareLower.startsWith(bareLower)
    )
    for (const pos of tokPositionsByBare.get(bareLower) ?? []) {
      const zone = classifySpanCursorZone(
        pos.start,
        pos.end,
        activeTokStart,
        activeTokEnd,
        allowsUnderCursorCheck(pos.start, pos.end) && !isPrefixOfRealTable
      )
      if (recordZoneError(zone, 'schema', flags)) {
        suspectedTypoIdentifiers.add(bareLower)
      }
    }
  }
}

function findFusedTableMatches(
  lower: string,
  realBareMap: ReadonlyMap<string, RealTableEntry[]>
): RealTableEntry[] | undefined {
  for (const suffix of FUSED_TABLE_CLAUSE_SUFFIXES) {
    const sufLower = suffix.toLowerCase()
    if (lower.length <= sufLower.length + 1 || !lower.endsWith(sufLower)) continue
    const tableMatches = realBareMap.get(lower.slice(0, lower.length - sufLower.length))
    if (tableMatches && tableMatches.length > 0) return tableMatches
  }
  return undefined
}

function scanFusedTableClauseTokens(
  nonWsTokens: readonly SqlDiffToken[],
  realBareMap: ReadonlyMap<string, RealTableEntry[]>,
  activeTokStart: number,
  activeTokEnd: number,
  allowsUnderCursorCheck: (start: number, end: number) => boolean,
  registerTable: (entry: RealTableEntry) => void,
  suspectedTypoIdentifiers: Set<string>,
  flags: HealErrorFlags
): void {
  for (const tok of nonWsTokens) {
    if (tok.kind !== 'word') continue
    const lower = tok.text.toLowerCase()
    const tableMatches = findFusedTableMatches(lower, realBareMap)
    if (!tableMatches) continue
    for (const tm of tableMatches) registerTable(tm)
    const zone = classifySpanCursorZone(
      tok.start,
      tok.end,
      activeTokStart,
      activeTokEnd,
      allowsUnderCursorCheck(tok.start, tok.end)
    )
    if (recordZoneError(zone, 'schema', flags)) {
      suspectedTypoIdentifiers.add(lower)
    }
  }
}

function resolveFromJoinAliases(
  shadowNonWs: readonly SqlDiffToken[],
  tableColsByBare: ReadonlyMap<string, Set<string>>
): { userAliases: Set<string>; aliasToCols: Map<string, Set<string>> } {
  const userAliases = new Set<string>()
  const aliasToCols = new Map<string, Set<string>>()
  for (let i = 0; i < shadowNonWs.length; i += 1) {
    const cur = shadowNonWs[i]
    if (!cur || cur.kind !== 'word') continue
    const kwUpper = cur.text.toUpperCase()
    if (kwUpper !== 'FROM' && kwUpper !== 'JOIN') continue
    let idx = i + 1
    const firstIdent = shadowNonWs[idx]
    if (!firstIdent || (firstIdent.kind !== 'word' && firstIdent.kind !== 'quoted_ident')) continue
    let tableBare = unquoteSqlIdent(firstIdent.text).toLowerCase()
    idx += 1
    if (shadowNonWs[idx]?.text === '.' && shadowNonWs[idx + 1]) {
      tableBare = unquoteSqlIdent(shadowNonWs[idx + 1]?.text ?? '').toLowerCase()
      idx += 2
    }
    if (shadowNonWs[idx]?.kind === 'word' && shadowNonWs[idx]?.text.toUpperCase() === 'AS') idx += 1
    const aliasTok = shadowNonWs[idx]
    if (aliasTok?.kind !== 'word') continue
    const aliasUpper = aliasTok.text.toUpperCase()
    if (VALID_SQL_WORDS.has(aliasUpper) || CLAUSE_BARRIER_WORDS.has(aliasUpper)) continue
    const aliasLower = aliasTok.text.toLowerCase()
    userAliases.add(aliasLower)
    const mappedCols = tableColsByBare.get(tableBare)
    if (mappedCols) aliasToCols.set(aliasLower, mappedCols)
  }
  return { userAliases, aliasToCols }
}

function hasTypoCandidateMatch(
  lower: string,
  candidates: Iterable<string>,
  minCandidateLen = 1
): boolean {
  for (const cand of candidates) {
    const candLower = cand.toLowerCase()
    if (candLower.length >= minCandidateLen && isLikelyTypoWord(lower, candLower, 0.35)) {
      return true
    }
  }
  return false
}

function scanWordTokenErrors(
  nonWsTokens: readonly SqlDiffToken[],
  activeTokStart: number,
  activeTokEnd: number,
  allowsUnderCursorCheck: (start: number, end: number) => boolean,
  realTables: readonly RealTableEntry[],
  realBareMap: ReadonlyMap<string, RealTableEntry[]>,
  cteNames: ReadonlySet<string>,
  userAliases: ReadonlySet<string>,
  activeColumns: ReadonlySet<string>,
  aliasToCols: ReadonlyMap<string, Set<string>>,
  suspectedTypoIdentifiers: Set<string>,
  flags: HealErrorFlags
): void {
  let inSelectProjection = false
  let currentClause = ''
  for (let i = 0; i < nonWsTokens.length; i += 1) {
    const tok = nonWsTokens[i]
    if (!tok || tok.kind !== 'word') continue
    const upper = tok.text.toUpperCase()
    if (upper === 'SELECT') {
      inSelectProjection = true
      currentClause = 'SELECT'
      continue
    }
    if (CLAUSE_BARRIER_WORDS.has(upper)) {
      inSelectProjection = false
      currentClause = upper
      continue
    }
    const zone = classifySpanCursorZone(
      tok.start,
      tok.end,
      activeTokStart,
      activeTokEnd,
      allowsUnderCursorCheck(tok.start, tok.end)
    )
    if (zone === 'ignored') continue
    const isUnderCursor = zone === 'under'
    const lower = tok.text.toLowerCase()
    const prev = i > 0 ? nonWsTokens[i - 1] : undefined
    const prevPrev = i > 1 ? nonWsTokens[i - 2] : undefined
    const next = i + 1 < nonWsTokens.length ? nonWsTokens[i + 1] : undefined

    if (
      next?.text === '(' &&
      !VALID_SQL_WORDS.has(upper) &&
      !cteNames.has(lower) &&
      !realBareMap.has(lower) &&
      lower.length >= 4 &&
      hasTypoCandidateMatch(lower, VALID_SQL_WORDS, 4)
    ) {
      recordZoneError(zone, 'func', flags)
      suspectedTypoIdentifiers.add(lower)
    }

    if (prev?.text === '.' && prevPrev?.kind === 'word') {
      const aliasCols = aliasToCols.get(prevPrev.text.toLowerCase()) ?? activeColumns
      const shouldCheckQualified =
        aliasCols.size > 0 &&
        !aliasCols.has(lower) &&
        !VALID_SQL_WORDS.has(upper) &&
        !(isUnderCursor && isStrictPrefixOfKnown(lower, upper, realTables, aliasCols, cteNames))
      if (shouldCheckQualified && hasTypoCandidateMatch(lower, aliasCols)) {
        recordZoneError(zone, 'schema', flags)
        suspectedTypoIdentifiers.add(lower)
      }
      continue
    }

    const prevUpper = prev?.kind === 'word' ? prev.text.toUpperCase() : ''
    if (
      isUnderCursor &&
      isUnderCursorClauseTypo(lower, upper, prevUpper, next, realTables, realBareMap, activeColumns, cteNames, userAliases)
    ) {
      flags.hasUnderCursorError = true
      suspectedTypoIdentifiers.add(lower)
      continue
    }

    const isTableOrAliasPos = prevUpper === 'FROM' || prevUpper === 'JOIN' || prevUpper === 'AS'
    const isColumnClause =
      currentClause === 'SELECT' ||
      currentClause === 'WHERE' ||
      currentClause === 'ORDER' ||
      currentClause === 'GROUP' ||
      currentClause === 'HAVING'
    const shouldCheckColumn =
      !isTableOrAliasPos &&
      isColumnClause &&
      activeColumns.size > 0 &&
      !VALID_SQL_WORDS.has(upper) &&
      !cteNames.has(lower) &&
      !userAliases.has(lower) &&
      !realBareMap.has(lower) &&
      !activeColumns.has(lower) &&
      next?.text !== '(' &&
      !(isUnderCursor && isStrictPrefixOfKnown(lower, upper, realTables, activeColumns, cteNames))
    if (shouldCheckColumn && hasTypoCandidateMatch(lower, activeColumns)) {
      recordZoneError(zone, 'schema', flags)
      suspectedTypoIdentifiers.add(lower)
    }

    if (
      inSelectProjection &&
      prev?.kind === 'word' &&
      activeColumns.has(lower) &&
      activeColumns.has(prev.text.toLowerCase()) &&
      !VALID_SQL_WORDS.has(prev.text.toUpperCase()) &&
      !VALID_SQL_WORDS.has(upper) &&
      next?.text !== '('
    ) {
      recordZoneError(zone, 'comma', flags)
    }
  }
}

/** Runs static SQL diagnostics and schema-aware Shadow-Heal without modifying editor text. */
export function shadowHealStatementForSchema(
  stmt: ActiveStatementWindow,
  dialect: AiDialect,
  snapshot: WorkerSchemaSnapshot | null,
  schemaMap?: Record<string, string[]>,
  activeSchema?: string
): ShadowHealResult {
  const { diagnostics, shadowFromDiags } = runTwoPassDiagnostics(stmt.text, dialect, stmt.relCursor)
  const prefixBeforeCursor = shadowFromDiags.slice(0, Math.min(stmt.relCursor, shadowFromDiags.length))
  const trailingTypo = resolveTrailingTypoToken(prefixBeforeCursor, dialect)
  const shadowSql = trailingTypo
    ? `${trailingTypo.healedPrefix}${shadowFromDiags.slice(prefixBeforeCursor.length)}`
    : shadowFromDiags

  const cteNames = extractCteNames(shadowSql)
  const realTables = collectRealTables(snapshot, schemaMap)
  const realBareMap = new Map<string, RealTableEntry[]>()
  for (const entry of realTables) {
    const arr = realBareMap.get(entry.bareLower) ?? []
    arr.push(entry)
    realBareMap.set(entry.bareLower, arr)
  }

  const tokens = tokenizeSqlForDiff(stmt.text, dialect)
  const nonWsTokens = tokens.filter((t) => t.kind !== 'ws' && t.kind !== 'nl' && t.kind !== 'comment')
  const { start: activeTokStart, end: activeTokEnd } = findActiveTokenSpan(stmt, tokens)

  const tokPositionsByBare = new Map<string, Array<{ start: number; end: number }>>()
  for (const tok of nonWsTokens) {
    if (tok.kind !== 'word' && tok.kind !== 'quoted_ident') continue
    const clean = unquoteSqlIdent(tok.text)
    const bare = (clean.includes('.') ? clean.split('.').pop() || clean : clean).toLowerCase()
    if (!bare) continue
    const arr = tokPositionsByBare.get(bare) ?? []
    arr.push({ start: tok.start, end: tok.end })
    tokPositionsByBare.set(bare, arr)
  }

  const partialAtCursor = extractTrailingPartialTableName(stmt.text.slice(0, stmt.relCursor), dialect)
  const partialLower = partialAtCursor?.partial.toLowerCase() ?? ''
  const allRefs = Array.from(
    new Set([...extractReferencedTables(stmt.text, dialect), ...extractReferencedTables(shadowSql, dialect)])
  )

  const healedTables: string[] = []
  const healedSet = new Set<string>()
  const matchedTables: RealTableEntry[] = []
  const knownRealTables = new Set<string>()
  const registerTable = (entry: RealTableEntry) => {
    const k = entry.qualified.toLowerCase()
    if (!healedSet.has(k)) {
      healedSet.add(k)
      healedTables.push(entry.qualified)
    }
    matchedTables.push(entry)
    knownRealTables.add(entry.bareLower)
  }

  const suspectedTypoIdentifiers = new Set<string>()
  const flags: HealErrorFlags = {
    hasEarlierSyntaxError: false,
    hasEarlierSchemaTypo: false,
    hasEarlierFuncTypo: false,
    hasEarlierMissingComma: false,
    hasAfterCursorError: false,
    hasUnderCursorError: false,
  }
  const hasSuffixContent = stmt.text.slice(stmt.relCursor).trim().length > 0
  const allowsUnderCursorCheck = (start: number, end: number): boolean =>
    !stmt.cursorAfterSemicolon && (hasSuffixContent || (start < stmt.relCursor && stmt.relCursor < end))

  promoteReferencedAndFuzzyTables(
    allRefs,
    cteNames,
    realBareMap,
    realTables,
    partialLower,
    tokPositionsByBare,
    activeTokStart,
    activeTokEnd,
    allowsUnderCursorCheck,
    matchedTables,
    knownRealTables,
    registerTable,
    suspectedTypoIdentifiers,
    flags,
    activeSchema
  )
  promoteSplitRealTables(
    stmt.text,
    stmt.relCursor,
    nonWsTokens,
    realBareMap,
    cteNames,
    activeTokStart,
    activeTokEnd,
    suspectedTypoIdentifiers,
    registerTable,
    flags
  )
  scanFusedTableClauseTokens(
    nonWsTokens,
    realBareMap,
    activeTokStart,
    activeTokEnd,
    allowsUnderCursorCheck,
    registerTable,
    suspectedTypoIdentifiers,
    flags
  )

  const activeColumns = new Set<string>()
  const tableColsByBare = new Map<string, Set<string>>()
  for (const tbl of matchedTables) {
    const colSet = tableColsByBare.get(tbl.bareLower) ?? new Set<string>()
    for (const c of tbl.cols) {
      const cl = c.toLowerCase()
      activeColumns.add(cl)
      colSet.add(cl)
    }
    tableColsByBare.set(tbl.bareLower, colSet)
  }

  const shadowNonWs = tokenizeSqlForDiff(shadowSql, dialect).filter(
    (t) => t.kind !== 'ws' && t.kind !== 'nl' && t.kind !== 'comment'
  )
  const { userAliases, aliasToCols } = resolveFromJoinAliases(shadowNonWs, tableColsByBare)
  scanWordTokenErrors(
    nonWsTokens,
    activeTokStart,
    activeTokEnd,
    allowsUnderCursorCheck,
    realTables,
    realBareMap,
    cteNames,
    userAliases,
    activeColumns,
    aliasToCols,
    suspectedTypoIdentifiers,
    flags
  )

  const { knownSchemaCols, quotedColPool } = buildQuotedSchemaColumnPool(nonWsTokens, activeColumns, realTables)
  scanQuotedIdentifierErrors(
    stmt,
    nonWsTokens,
    realTables,
    realBareMap,
    cteNames,
    knownSchemaCols,
    quotedColPool,
    activeTokStart,
    activeTokEnd,
    allowsUnderCursorCheck,
    suspectedTypoIdentifiers,
    flags,
    activeSchema
  )
  scanWhitespaceSplitWordPairs(
    stmt,
    nonWsTokens,
    realTables,
    realBareMap,
    activeColumns,
    cteNames,
    userAliases,
    activeTokStart,
    activeTokEnd,
    suspectedTypoIdentifiers,
    flags,
    activeSchema
  )
  classifyStatementDiagnostics(
    stmt,
    diagnostics,
    realTables,
    activeColumns,
    cteNames,
    knownSchemaCols,
    activeTokStart,
    activeTokEnd,
    hasSuffixContent,
    allowsUnderCursorCheck,
    flags
  )

  const grammarTargetSql =
    !hasSuffixContent && trailingTypo
      ? `${trailingTypo.healedPrefix}${stmt.text.slice(stmt.relCursor)}`
      : stmt.text
  const grammarTargetCursor =
    !hasSuffixContent && trailingTypo ? trailingTypo.healedPrefix.length : stmt.relCursor
  const hasGrammarSyntaxError = hasNonCursorGrammarError(grammarTargetSql, grammarTargetCursor, dialect)

  return {
    diagnostics,
    shadowSql,
    cteNames,
    healedTables,
    knownRealTables,
    userAliases,
    activeColumns,
    ...flags,
    hasGrammarSyntaxError,
    suspectedTypoIdentifiers,
  }
}

export interface DecideCompletionTierParams {
  dialect: AiDialect
  prefix: string
  stmt: ActiveStatementWindow | null
  heal: ShadowHealResult | null
  requestedMode?: 'auto' | 'complete' | 'edit'
  manual?: boolean
}

/** Routes between fast Tier 1 (`complete`) and Statement-Edit Tier 2 (`edit`) before flight reuse. */
export function decideCompletionTier(params: DecideCompletionTierParams): 'complete' | 'edit' {
  const { dialect, prefix, stmt, heal, requestedMode = 'auto', manual = false } = params
  if (requestedMode === 'complete') return 'complete'
  if (dialect === 'redis' || dialect === 'mongodb') return 'complete'
  if (isPrefixInComment(prefix, dialect)) return 'complete'
  if (!stmt) return 'complete'
  const maxLines = requestedMode === 'edit' || manual ? NEP_MANUAL_MAX_STATEMENT_LINES : NEP_MAX_STATEMENT_LINES
  const maxChars = requestedMode === 'edit' || manual ? NEP_MANUAL_MAX_STATEMENT_CHARS : NEP_MAX_STATEMENT_CHARS
  if (stmt.lineCount > maxLines || stmt.text.length > maxChars) {
    return 'complete'
  }
  if (requestedMode === 'edit') return 'edit'

  const nonWsCount = tokenizeSqlForDiff(stmt.text, dialect).filter(
    (t) => t.kind !== 'ws' && t.kind !== 'nl' && t.kind !== 'comment'
  ).length
  if (nonWsCount < 2) return 'complete'
  if (!heal) return 'complete'

  const hasAnyError =
    heal.hasEarlierSyntaxError ||
    heal.hasEarlierSchemaTypo ||
    heal.hasEarlierFuncTypo ||
    heal.hasEarlierMissingComma ||
    heal.hasAfterCursorError ||
    heal.hasUnderCursorError ||
    Boolean(heal.hasGrammarSyntaxError)

  return hasAnyError ? 'edit' : 'complete'
}

export interface ComputeFilteredStatementEditsParams {
  stmt: ActiveStatementWindow
  rewrittenSql: string
  dialect?: AiDialect
  heal: ShadowHealResult
  prefixLength?: number
  suffixLength?: number
}

function isSimpleAliasRename(
  origNonWs: readonly SqlDiffToken[],
  newNonWs: readonly SqlDiffToken[],
  userAliases: ReadonlySet<string>
): boolean {
  if (origNonWs.length !== 1 || newNonWs.length !== 1) return false
  const a = origNonWs[0]
  const b = newNonWs[0]
  if (!a || !b || a.kind !== 'word' || b.kind !== 'word') return false
  const aLower = a.text.toLowerCase()
  const bLower = b.text.toLowerCase()
  return userAliases.has(aLower) && aLower !== bLower && !VALID_SQL_WORDS.has(b.text.toUpperCase())
}

function isGratuitousQuoteToggle(
  origNonWs: readonly SqlDiffToken[],
  newNonWs: readonly SqlDiffToken[]
): boolean {
  if (origNonWs.length !== 1 || newNonWs.length !== 1) return false
  const a = origNonWs[0]
  const b = newNonWs[0]
  if (!a || !b) return false
  if (a.closed === false || b.closed === false) return false
  const aIsIdent = a.kind === 'word' || a.kind === 'quoted_ident'
  const bIsIdent = b.kind === 'word' || b.kind === 'quoted_ident'
  if (!aIsIdent || !bIsIdent || a.kind === b.kind) return false
  return unquoteSqlIdent(a.text).toLowerCase() === unquoteSqlIdent(b.text).toLowerCase()
}

function preserveLowercaseTypoCase(
  origTokens: readonly SqlDiffToken[],
  newTokens: readonly SqlDiffToken[],
  insert: string
): string {
  if (newTokens.length !== 1) return insert
  const newTok = newTokens[0]
  if (!newTok || newTok.kind !== 'word') return insert
  const upper = newTok.text.toUpperCase()
  if (!VALID_SQL_WORDS.has(upper)) return insert
  const leadWs = /^[ \t]*/.exec(insert)?.[0] ?? ''
  const trailWs = /[ \t]*$/.exec(insert)?.[0] ?? ''
  if (origTokens.length === 1 && origTokens[0]?.kind === 'word') {
    if (/^[a-z_][a-z0-9_]*$/.test(origTokens[0].text)) {
      return `${leadWs}${formatCorrectedKeyword(upper, origTokens[0].text)}${trailWs}`
    }
    return insert
  }
  if (
    origTokens.length === 2 &&
    origTokens[0]?.kind === 'word' &&
    origTokens[1]?.kind === 'word' &&
    /^[a-z_][a-z0-9_]*$/.test(origTokens[0].text) &&
    /^[a-z0-9_]+$/.test(origTokens[1].text)
  ) {
    return `${leadWs}${formatCorrectedKeyword(upper, origTokens[0].text)}${trailWs}`
  }
  return insert
}

function findLastWordBefore(tokens: readonly SqlDiffToken[], beforeOffset: number): SqlDiffToken | undefined {
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const tok = tokens[i]
    if (tok && tok.end <= beforeOffset && tok.kind === 'word') return tok
  }
  return undefined
}

function tryCoalesceFusedWordSplit(
  h1: RawTokenHunk,
  h2: RawTokenHunk,
  stmtText: string,
  origTokens: readonly SqlDiffToken[]
): RawTokenHunk | null {
  if (h1.to >= h2.from) return null
  const h1OrigNonWs = h1.origTokens.filter((t) => t.kind !== 'ws' && t.kind !== 'nl')
  const h1NewNonWs = h1.newTokens.filter((t) => t.kind !== 'ws' && t.kind !== 'nl')
  const h2OrigNonWs = h2.origTokens.filter((t) => t.kind !== 'ws' && t.kind !== 'nl')
  const h2NewNonWs = h2.newTokens.filter((t) => t.kind !== 'ws' && t.kind !== 'nl')
  if (h1NewNonWs.length !== 1 || h2NewNonWs.length !== 1) return null

  const joinedNew = `${h1NewNonWs[0]?.text ?? ''}${h2NewNonWs[0]?.text ?? ''}`.toLowerCase()
  const wsBetween = origTokens.filter((t) => t.start >= h1.to && t.end <= h2.from)
  const insert = `${h1.insert}${stmtText.slice(h1.to, h2.from)}${h2.insert}`
  const combinedNewTokens = [...h1.newTokens, ...wsBetween, ...h2.newTokens]

  if (h1.from < h1.to && h2.from === h2.to && h1OrigNonWs.length === 1 && h1OrigNonWs[0]?.kind === 'word') {
    if (h1OrigNonWs[0].text.toLowerCase() === joinedNew) {
      return { origTokens: h1.origTokens, newTokens: combinedNewTokens, from: h1.from, to: h1.to, insert }
    }
  }
  if (h1.from === h1.to && h2.from < h2.to && h2OrigNonWs.length === 1 && h2OrigNonWs[0]?.kind === 'word') {
    if (h2OrigNonWs[0].text.toLowerCase() === joinedNew) {
      return { origTokens: h2.origTokens, newTokens: combinedNewTokens, from: h2.from, to: h2.to, insert }
    }
  }
  return null
}

function tryCoalesceSplitWordJoin(
  h1: RawTokenHunk,
  h2: RawTokenHunk,
  stmtText: string,
  origTokens: readonly SqlDiffToken[],
  newTokens: readonly SqlDiffToken[]
): RawTokenHunk | null {
  const h1OrigNonWs = h1.origTokens.filter((t) => t.kind !== 'ws' && t.kind !== 'nl')
  const h1NewNonWs = h1.newTokens.filter((t) => t.kind !== 'ws' && t.kind !== 'nl')
  const h2OrigNonWs = h2.origTokens.filter((t) => t.kind !== 'ws' && t.kind !== 'nl')
  const h2NewNonWs = h2.newTokens.filter((t) => t.kind !== 'ws' && t.kind !== 'nl')
  if (h1OrigNonWs.length !== 1 || h1OrigNonWs[0]?.kind !== 'word') return null
  if (h2OrigNonWs.length !== 1 || h2OrigNonWs[0]?.kind !== 'word') return null
  const oneJoined =
    (h1NewNonWs.length === 1 && h2NewNonWs.length === 0) || (h1NewNonWs.length === 0 && h2NewNonWs.length === 1)
  if (!oneJoined) return null

  const w1 = h1OrigNonWs[0]
  const w2 = h2OrigNonWs[0]
  const wJoined = h1NewNonWs[0] ?? h2NewNonWs[0]
  if (!wJoined || wJoined.kind !== 'word') return null
  if (!/^[ \t]+$/.test(stmtText.slice(w1.end, w2.start))) return null

  const joinedLower = `${w1.text}${w2.text}`.toLowerCase()
  const targetLower = wJoined.text.toLowerCase()
  if (joinedLower !== targetLower && !isLikelyTypoWord(joinedLower, targetLower, 0.4)) return null

  const origW1Idx = origTokens.indexOf(w1)
  const newJoinedIdx = newTokens.indexOf(wJoined)
  const prevOrig = origW1Idx > 0 ? origTokens[origW1Idx - 1] : undefined
  const prevNew = newJoinedIdx > 0 ? newTokens[newJoinedIdx - 1] : undefined
  const needsLeadingSpace =
    Boolean(prevOrig) &&
    prevOrig?.kind !== 'ws' &&
    prevOrig?.kind !== 'nl' &&
    prevOrig?.text !== '(' &&
    prevOrig?.text !== '[' &&
    prevOrig?.text !== '.' &&
    prevNew?.kind === 'ws'
  const wsBetweenWords = origTokens.filter((t) => t.start >= w1.end && t.end <= w2.start)
  return {
    origTokens: [w1, ...wsBetweenWords, w2],
    newTokens: [wJoined],
    from: w1.start,
    to: w2.end,
    insert: needsLeadingSpace ? ` ${wJoined.text}` : wJoined.text,
  }
}

function coalesceAdjacentTokenHunks(
  rawHunksRaw: readonly RawTokenHunk[],
  stmtText: string,
  origTokens: readonly SqlDiffToken[],
  newTokens: readonly SqlDiffToken[]
): RawTokenHunk[] {
  const coalesceHunks: RawTokenHunk[] = []
  for (let hi = 0; hi < rawHunksRaw.length; hi += 1) {
    const h1 = rawHunksRaw[hi]
    if (!h1) continue
    const hNext = rawHunksRaw[hi + 1]
    const hNextIsPureWs =
      Boolean(hNext) && hNext.origTokens.every((t) => t.kind === 'ws') && hNext.newTokens.every((t) => t.kind === 'ws')
    const h2 = hNextIsPureWs ? rawHunksRaw[hi + 2] : hNext
    if (!h2 || h1.to > h2.from || !/^[ \t]*$/.test(stmtText.slice(h1.to, h2.from))) {
      coalesceHunks.push(h1)
      continue
    }
    const fused = !hNextIsPureWs ? tryCoalesceFusedWordSplit(h1, h2, stmtText, origTokens) : null
    if (fused) {
      coalesceHunks.push(fused)
      hi += 1
      continue
    }
    const joined = tryCoalesceSplitWordJoin(h1, h2, stmtText, origTokens, newTokens)
    if (joined) {
      coalesceHunks.push(joined)
      hi += hNextIsPureWs ? 2 : 1
      continue
    }
    coalesceHunks.push(h1)
  }
  return coalesceHunks
}

function isValidNonCursorSplitWordJoin(
  origNonWs: readonly SqlDiffToken[],
  newNonWs: readonly SqlDiffToken[],
  heal: ShadowHealResult,
  allRealTableNames: ReadonlySet<string>
): boolean {
  if (origNonWs.length !== 2 || newNonWs.length !== 1) return false
  if (origNonWs[0]?.kind !== 'word' || origNonWs[1]?.kind !== 'word' || newNonWs[0]?.kind !== 'word') return false
  const joinedLower = `${origNonWs[0].text}${origNonWs[1].text}`.toLowerCase()
  const newTok = newNonWs[0]
  const newLower = newTok.text.toLowerCase()
  const newValid =
    VALID_SQL_WORDS.has(newTok.text.toUpperCase()) ||
    allRealTableNames.has(newLower) ||
    heal.activeColumns.has(newLower) ||
    heal.cteNames.has(newLower)
  return newValid && (joinedLower === newLower || isLikelyTypoWord(joinedLower, newLower, 0.4))
}

function isValidNonCursorQuotedIdentFix(
  origNonWs: readonly SqlDiffToken[],
  newNonWs: readonly SqlDiffToken[],
  heal: ShadowHealResult,
  allRealTableNames: ReadonlySet<string>,
  prevWordBeforeOrig?: SqlDiffToken
): boolean {
  if (origNonWs.length !== 1 || newNonWs.length !== 1) return false
  if (origNonWs[0]?.kind !== 'quoted_ident' || newNonWs[0]?.kind !== 'quoted_ident') return false
  const origInner = unquoteSqlIdent(origNonWs[0].text)
  const newInner = unquoteSqlIdent(newNonWs[0].text)
  const origInnerLower = origInner.toLowerCase()
  const newInnerLower = newInner.toLowerCase()
  if (origInnerLower === newInnerLower) return false
  if (prevWordBeforeOrig?.text.toUpperCase() === 'AS' && !/[ \t]/.test(origInner)) return false
  if (!/[ \t]/.test(origInner) && !isShortOrTypoIdentMatch(origInnerLower, newInnerLower, 0.4)) return false
  return (
    heal.activeColumns.has(newInnerLower) ||
    allRealTableNames.has(newInnerLower) ||
    heal.suspectedTypoIdentifiers.has(origInnerLower) ||
    /[ \t]{2,}|^[ \t]|[ \t]$/.test(origInner)
  )
}

function isCommonAntiNoiseHunk(
  origNonWs: readonly SqlDiffToken[],
  newNonWs: readonly SqlDiffToken[],
  userAliases: ReadonlySet<string>
): boolean {
  if (origNonWs.length === 0 && newNonWs.length === 0) return true
  if (
    origNonWs.length > 0 &&
    origNonWs.length === newNonWs.length &&
    origNonWs.every((ot, idx) => {
      const nt = newNonWs[idx]
      return Boolean(nt && ot.kind === 'word' && nt.kind === 'word' && ot.text.toLowerCase() === nt.text.toLowerCase())
    })
  ) {
    return true
  }
  if (isSimpleAliasRename(origNonWs, newNonWs, userAliases)) return true
  return isGratuitousQuoteToggle(origNonWs, newNonWs)
}

function isBlockedByAntiNoise(h: RawTokenHunk, userAliases: ReadonlySet<string>): boolean {
  const origNonWs = h.origTokens.filter((t) => t.kind !== 'ws' && t.kind !== 'nl')
  const newNonWs = h.newTokens.filter((t) => t.kind !== 'ws' && t.kind !== 'nl')
  if (isCommonAntiNoiseHunk(origNonWs, newNonWs, userAliases)) return true
  return origNonWs.some(
    (t) => (t.kind === 'comment' && t.closed !== false) || (t.kind === 'string' && t.closed !== false)
  )
}

function isCursorAdjacentGap(gap: string): boolean {
  let seenNewline = false
  for (let i = 0; i < gap.length; i += 1) {
    const ch = gap[i]
    if (ch === ' ' || ch === '\t') continue
    if (ch === '\r' && gap[i + 1] === '\n' && !seenNewline) {
      seenNewline = true
      i += 1
      continue
    }
    if (ch === '\n' && !seenNewline) {
      seenNewline = true
      continue
    }
    return false
  }
  return true
}

function leftRotateCursorInsertions(
  coalesceHunks: readonly RawTokenHunk[],
  stmtText: string,
  relCursor: number,
  dialect?: AiDialect
): RawTokenHunk[] {
  const leftRotated: RawTokenHunk[] = coalesceHunks.map((h) => ({ ...h }))
  const prevCharAtRelCursor = relCursor > 0 ? stmtText[relCursor - 1] : ''
  for (let i = 0; i < leftRotated.length; i += 1) {
    const h = leftRotated[i]
    if (!h || h.from !== h.to || h.from <= relCursor) continue
    const prevTo = i > 0 ? (leftRotated[i - 1]?.to ?? -1) : -1
    if (prevTo > relCursor) continue
    const bLen = h.from - relCursor
    if (bLen <= 0 || bLen > 40) continue
    const B = stmtText.slice(relCursor, h.from)
    if (/[A-Za-z0-9_]/.test(prevCharAtRelCursor) && /[A-Za-z0-9_]/.test(B[0] ?? '')) continue
    const combined = `${B}${h.insert}`
    if (!combined.endsWith(B)) continue
    const rotatedInsert = combined.slice(0, combined.length - B.length)
    if (rotatedInsert.length === 0 || `${rotatedInsert}${B}` !== combined) continue
    leftRotated[i] = {
      origTokens: [],
      newTokens: tokenizeSqlForDiff(rotatedInsert, dialect),
      from: relCursor,
      to: relCursor,
      insert: rotatedInsert,
    }
  }
  return leftRotated
}

function mergeCursorBridgedHunks(
  leftRotated: readonly RawTokenHunk[],
  stmtText: string,
  relCursor: number,
  origTokens: readonly SqlDiffToken[],
  userAliases: ReadonlySet<string>
): RawTokenHunk[] {
  const rawHunks: RawTokenHunk[] = []
  for (let i = 0; i < leftRotated.length; i += 1) {
    const h1 = leftRotated[i]
    if (!h1) continue
    const h2 = leftRotated[i + 1]
    const safeCursorInsertionMerge =
      Boolean(h2) &&
      ((h1.from === h1.to && h2.from === h2.to) ||
        (h1.from === h1.to && h2.from === relCursor) ||
        (h2.from === h2.to && h1.to === relCursor))
    if (
      !safeCursorInsertionMerge ||
      !h2 ||
      h1.to >= h2.from ||
      h1.to > relCursor ||
      relCursor > h2.from ||
      !/^[ \t]+$/.test(stmtText.slice(h1.to, h2.from)) ||
      isBlockedByAntiNoise(h1, userAliases) ||
      isBlockedByAntiNoise(h2, userAliases)
    ) {
      rawHunks.push(h1)
      continue
    }
    const wsBetween = origTokens.filter((t) => t.start >= h1.to && t.end <= h2.from)
    rawHunks.push({
      origTokens: [...h1.origTokens, ...wsBetween, ...h2.origTokens],
      newTokens: [...h1.newTokens, ...wsBetween, ...h2.newTokens],
      from: h1.from,
      to: h2.to,
      insert: `${h1.insert}${stmtText.slice(h1.to, h2.from)}${h2.insert}`,
    })
    i += 1
  }
  return rawHunks
}

function isValidNonCursorWordFix(
  origWordTok: SqlDiffToken,
  newNonWs: readonly SqlDiffToken[],
  prevWordBeforeOrig: SqlDiffToken | undefined,
  hunk: RawTokenHunk,
  heal: ShadowHealResult,
  allRealTableNames: ReadonlySet<string>,
  diagWithinProximity: (from: number, to: number) => boolean
): boolean {
  const origWord = origWordTok.text
  const origLower = origWord.toLowerCase()
  const origUpper = origWord.toUpperCase()

  if (
    newNonWs.length >= 2 &&
    origLower === newNonWs.map((t) => t.text).join('').toLowerCase() &&
    newNonWs.every(
      (t) =>
        t.kind === 'word' &&
        (VALID_SQL_WORDS.has(t.text.toUpperCase()) ||
          allRealTableNames.has(t.text.toLowerCase()) ||
          heal.activeColumns.has(t.text.toLowerCase()) ||
          heal.cteNames.has(t.text.toLowerCase()))
    )
  ) {
    return true
  }

  if (newNonWs.length !== 1 || newNonWs[0]?.kind !== 'word') return false
  const newWord = newNonWs[0].text
  const newLower = newWord.toLowerCase()
  const newUpper = newWord.toUpperCase()
  const origIsKnownValid =
    VALID_SQL_WORDS.has(origUpper) ||
    heal.cteNames.has(origLower) ||
    heal.userAliases.has(origLower) ||
    allRealTableNames.has(origLower) ||
    heal.activeColumns.has(origLower)
  const nextIsKnownValid =
    VALID_SQL_WORDS.has(newUpper) ||
    allRealTableNames.has(newLower) ||
    heal.activeColumns.has(newLower) ||
    heal.suspectedTypoIdentifiers.has(origLower)
  const afterTableKw = prevWordBeforeOrig && /^(?:FROM|JOIN|INTO|UPDATE)$/i.test(prevWordBeforeOrig.text)
  const blockedKeywordTableFlip =
    VALID_SQL_WORDS.has(newUpper) &&
    (origLower === `${newLower}s` || (Boolean(afterTableKw) && !diagWithinProximity(hunk.from, hunk.to)))
  if (!origIsKnownValid && nextIsKnownValid && !blockedKeywordTableFlip && isLikelyTypoWord(origLower, newLower, 0.4)) {
    return true
  }
  return (
    heal.activeColumns.size > 0 &&
    !VALID_SQL_WORDS.has(origUpper) &&
    !heal.activeColumns.has(origLower) &&
    heal.activeColumns.has(newLower) &&
    isLikelyTypoWord(origLower, newLower, 0.4)
  )
}

function isValidNonCursorPunctuationInsert(
  hunk: RawTokenHunk,
  newNonWs: readonly SqlDiffToken[],
  origTokens: readonly SqlDiffToken[],
  heal: ShadowHealResult,
  diagWithinProximity: (from: number, to: number) => boolean
): boolean {
  if (newNonWs.length !== 1) return false
  const onlyTok = newNonWs[0]
  if (!onlyTok) return false
  if (onlyTok.text === ',') {
    const leftTok = findLastWordBefore(origTokens, hunk.from)
    const rightTok = origTokens.find((t) => t.start >= hunk.to && t.kind === 'word')
    return Boolean(
      leftTok &&
        rightTok &&
        heal.activeColumns.has(leftTok.text.toLowerCase()) &&
        heal.activeColumns.has(rightTok.text.toLowerCase())
    )
  }
  return (
    (CLOSING_DELIMITERS.has(onlyTok.text) || STRUCTURAL_KEYWORDS.has(onlyTok.text.toUpperCase())) &&
    diagWithinProximity(hunk.from, hunk.to)
  )
}

function passesNonCursorGoldenRule(
  hunk: RawTokenHunk,
  origNonWs: readonly SqlDiffToken[],
  newNonWs: readonly SqlDiffToken[],
  origTokens: readonly SqlDiffToken[],
  heal: ShadowHealResult,
  allRealTableNames: ReadonlySet<string>,
  diagWithinProximity: (from: number, to: number) => boolean
): boolean {
  if (diagWithinProximity(hunk.from, hunk.to)) return true
  const prevWordBeforeOrig = findLastWordBefore(origTokens, hunk.from)
  if (
    origNonWs.length === 1 &&
    origNonWs[0]?.kind === 'word' &&
    isValidNonCursorWordFix(origNonWs[0], newNonWs, prevWordBeforeOrig, hunk, heal, allRealTableNames, diagWithinProximity)
  ) {
    return true
  }
  if (origNonWs.some((t) => t.closed === false)) return true
  if (isValidNonCursorSplitWordJoin(origNonWs, newNonWs, heal, allRealTableNames)) return true
  if (isValidNonCursorQuotedIdentFix(origNonWs, newNonWs, heal, allRealTableNames, prevWordBeforeOrig)) return true
  if (origNonWs.length === 0) {
    return isValidNonCursorPunctuationInsert(hunk, newNonWs, origTokens, heal, diagWithinProximity)
  }
  return false
}

function trimMatchingEdgeWhitespace(
  insert: string,
  origText: string,
  origNonWs: readonly SqlDiffToken[],
  stmtText: string,
  hunkFrom: number,
  hunkTo: number
): string {
  if (origNonWs.length === 0 || hunkFrom >= hunkTo || origText !== origText.trim() || insert === insert.trim()) {
    return insert
  }
  const lead = insert.length - insert.trimStart().length
  const trail = insert.length - insert.trimEnd().length
  const leftBoundOk = hunkFrom >= lead && stmtText.slice(hunkFrom - lead, hunkFrom) === insert.slice(0, lead)
  const rightBoundOk = trail === 0 || stmtText.slice(hunkTo, hunkTo + trail) === insert.slice(insert.length - trail)
  return leftBoundOk && rightBoundOk ? insert.trim() : insert
}

interface KeptCandidateHunk {
  from: number
  to: number
  insert: string
  needsGrammarProof: boolean
  origNonWsCount: number
  newNonWsCount: number
}

function applyCandidateHunks(baseSql: string, hunks: readonly KeptCandidateHunk[]): string {
  const ordered = [...hunks].sort((a, b) => a.from - b.from || a.to - b.to)
  let out = ''
  let pos = 0
  for (const h of ordered) {
    if (h.from < pos || h.from > h.to || h.to > baseSql.length) return baseSql
    out += baseSql.slice(pos, h.from) + h.insert
    pos = h.to
  }
  return out + baseSql.slice(pos)
}

const NEP_MAX_PROOF_CANDIDATES = 24

function pruneNonLoadBearingGrammarHunks(
  baseSql: string,
  candidates: readonly KeptCandidateHunk[],
  dialect?: AiDialect
): KeptCandidateHunk[] {
  const nonProofCount = candidates.filter((h) => !h.needsGrammarProof).length
  if (candidates.length > NEP_MAX_PROOF_CANDIDATES || nonProofCount > NEP_MAX_HUNKS) {
    return []
  }
  const initialCheck = checkSqlGrammar(applyCandidateHunks(baseSql, candidates), dialect)
  if (initialCheck.supported && !initialCheck.valid) {
    return []
  }
  if (!candidates.some((h) => h.needsGrammarProof)) {
    return [...candidates]
  }
  let working = [...candidates]
  for (let i = working.length - 1; i >= 0; i -= 1) {
    const hunk = working[i]
    if (!hunk || !hunk.needsGrammarProof) continue
    const withoutHunk = working.filter((_, idx) => idx !== i)
    const withoutCheck = checkSqlGrammar(applyCandidateHunks(baseSql, withoutHunk), dialect)
    if (withoutCheck.supported && withoutCheck.valid) {
      working = withoutHunk
    }
  }
  return working
}

/** Filters raw token diffs through 8 anti-noise rules, Golden Rule for earlier edits, and Blast-Radius Guard. */
export function computeFilteredStatementEdits(
  params: ComputeFilteredStatementEditsParams
): AiInlineEdit[] {
  const { stmt, rewrittenSql, dialect, heal } = params
  if (!rewrittenSql.trim()) return []

  const origTokens = tokenizeSqlForDiff(stmt.text, dialect)
  const newTokens = tokenizeSqlForDiff(rewrittenSql, dialect)
  const rawHunksRaw = diffSqlTokens(origTokens, newTokens)
  if (!rawHunksRaw || rawHunksRaw.length === 0) return []

  const coalesceHunks = coalesceAdjacentTokenHunks(rawHunksRaw, stmt.text, origTokens, newTokens)
  const leftRotated = leftRotateCursorInsertions(coalesceHunks, stmt.text, stmt.relCursor, dialect)
  const rawHunks = mergeCursorBridgedHunks(leftRotated, stmt.text, stmt.relCursor, origTokens, heal.userAliases)

  const allRealTableNames = new Set(heal.knownRealTables)
  const trimmedOrigEnd = stmt.text.trimEnd().length
  const totalOrigNonWs = origTokens.filter((t) => t.kind !== 'ws' && t.kind !== 'nl').length
  const origHasGrammarError =
    heal.hasGrammarSyntaxError ?? hasNonCursorGrammarError(stmt.text, stmt.relCursor, dialect)
  const rewrittenGrammar = origHasGrammarError ? checkSqlGrammar(rewrittenSql, dialect) : null
  const isGrammarVerifiedRepair = Boolean(
    origHasGrammarError && rewrittenGrammar?.supported && rewrittenGrammar.valid
  )

  const candidates: KeptCandidateHunk[] = []

  const diagWithinProximity = (from: number, to: number): boolean => {
    for (const d of heal.diagnostics) {
      if (d.from <= to + 2 && d.to + 2 >= from) return true
    }
    return false
  }

  for (const hunk of rawHunks) {
    const origText = stmt.text.slice(hunk.from, hunk.to)
    let insert = hunk.insert
    // Rule 1: No-op
    if (origText === insert) continue

    if (stmt.cursorAfterSemicolon && stmt.semiEnd >= 0) {
      if (hunk.from >= stmt.semiEnd) continue
      if (hunk.from < stmt.semiEnd && hunk.to >= stmt.semiEnd && !insert.includes(';')) continue
    }

    const origNonWs = hunk.origTokens.filter((t) => t.kind !== 'ws' && t.kind !== 'nl')
    const newNonWs = hunk.newTokens.filter((t) => t.kind !== 'ws' && t.kind !== 'nl')
    const strictlyAtCursor = hunk.from <= stmt.relCursor && stmt.relCursor <= hunk.to
    const wsAdjacentPureInsert =
      hunk.from === hunk.to &&
      origNonWs.length === 0 &&
      ((hunk.from > stmt.relCursor && isCursorAdjacentGap(stmt.text.slice(stmt.relCursor, hunk.from))) ||
        (hunk.to < stmt.relCursor && isCursorAdjacentGap(stmt.text.slice(hunk.to, stmt.relCursor))))
    const touchesCursor = strictlyAtCursor || wsAdjacentPureInsert

    // Rules 2-5: whitespace/nl-only, case-only words, alias rename, gratuitous quote toggle
    if (isCommonAntiNoiseHunk(origNonWs, newNonWs, heal.userAliases)) {
      continue
    }

    // Rule 6: Touching closed comments or mutating closed strings outside caret
    if (
      !touchesCursor &&
      origNonWs.some(
        (t) => (t.kind === 'comment' && t.closed !== false) || (t.kind === 'string' && t.closed !== false)
      )
    ) {
      continue
    }

    // Rule 7: Trailing semicolon insertion/deletion when cursor is earlier
    if (
      !touchesCursor &&
      stmt.relCursor < trimmedOrigEnd &&
      ((origNonWs.length === 0 && newNonWs.length === 1 && newNonWs[0]?.text === ';') ||
        (newNonWs.length === 0 && origNonWs.length === 1 && origNonWs[0]?.text === ';')) &&
      hunk.from >= trimmedOrigEnd - 1
    ) {
      continue
    }

    // Rule 8: Golden Rule for earlier/non-cursor edits (or load-bearing grammar proof when repairing invalid SQL)
    let needsGrammarProof = false
    if (
      !touchesCursor &&
      !passesNonCursorGoldenRule(hunk, origNonWs, newNonWs, origTokens, heal, allRealTableNames, diagWithinProximity)
    ) {
      if (!isGrammarVerifiedRepair) {
        continue
      }
      needsGrammarProof = true
    }

    // Preserve lowercase keyword styling (`slect` -> `select`)
    insert = preserveLowercaseTypoCase(origNonWs, newNonWs, insert)
    insert = trimMatchingEdgeWhitespace(insert, origText, origNonWs, stmt.text, hunk.from, hunk.to)

    let hunkFrom = hunk.from
    const hunkTo = hunk.to
    if (hunkFrom < stmt.relCursor && hunkTo === stmt.relCursor) {
      const spanOrig = stmt.text.slice(hunkFrom, hunkTo)
      if (spanOrig && insert.startsWith(spanOrig)) {
        hunkFrom = stmt.relCursor
        insert = insert.slice(spanOrig.length)
      }
    }

    if (hunkFrom === hunkTo && insert.length === 0) continue

    candidates.push({
      from: hunkFrom,
      to: hunkTo,
      insert,
      needsGrammarProof,
      origNonWsCount: origNonWs.length,
      newNonWsCount: newNonWs.length,
    })
  }

  const kept = isGrammarVerifiedRepair
    ? pruneNonLoadBearingGrammarHunks(stmt.text, candidates, dialect)
    : candidates
  let deletedNonWsCount = 0
  for (const h of kept) {
    if (h.origNonWsCount > 1 || h.newNonWsCount === 0) {
      deletedNonWsCount += Math.max(1, h.origNonWsCount - h.newNonWsCount)
    }
  }

  // Blast-Radius Guard
  if (kept.length === 0 || kept.length > NEP_MAX_HUNKS) return []
  if (deletedNonWsCount >= 3 && totalOrigNonWs > 0 && deletedNonWsCount / totalOrigNonWs > 0.4) {
    return []
  }

  const maxBack = params.prefixLength ?? Infinity
  const maxFwd = params.suffixLength ?? Infinity
  const sorted = kept.sort((a, b) => a.from - b.from || a.to - b.to)
  const out: AiInlineEdit[] = []
  let prevTo = -Infinity

  const anchor = stmt.cursorOffsetInSpan ?? stmt.relCursor
  for (const h of sorted) {
    if (h.from < prevTo || h.from > h.to) return []
    const fromOffset = h.from - anchor
    const toOffset = h.to - anchor
    if (fromOffset < -maxBack || toOffset > maxFwd) return []
    if (fromOffset === toOffset && h.insert.length === 0) continue
    out.push({ fromOffset, toOffset, insert: h.insert })
    prevTo = h.to
  }

  return out
}

function stripSqlCommentsForProseCheck(sql: string): string {
  return tokenizeSqlForDiff(sql)
    .filter((t) => t.kind !== 'comment')
    .map((t) => t.text)
    .join('')
}

/** Extracts `<REWRITE>...</REWRITE>` SQL payload cleanly, enforcing truncation and prose guards. */
export function extractRewriteTagContent(
  raw: string,
  origStmt: string,
  finishReason?: string | null
): string {
  if (!raw || looksInjected(raw)) return ''
  let text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')

  const openTag = /<REWRITE>/i.exec(text)
  let hasClosingTag = false
  if (openTag) {
    text = text.slice(openTag.index + openTag[0].length)
    const closeTag = /<\/REWRITE>/i.exec(text)
    if (closeTag) {
      hasClosingTag = true
      text = text.slice(0, closeTag.index)
    }
  } else {
    const closeTag = /<\/REWRITE>/i.exec(text)
    if (closeTag) {
      hasClosingTag = true
      text = text.slice(0, closeTag.index)
    }
  }

  // Strip at most 1 newline right after `<REWRITE>` and 1 newline right before `</REWRITE>`
  text = text.replace(/^\r?\n/, '').replace(/\r?\n$/, '')

  // Unwrap accidental code fences
  const fenced = /^\s*```[^\n]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(text)
  if (fenced) {
    text = fenced[1]
  } else {
    const openFence = /^\s*```[^\n]*\r?\n([\s\S]*)$/.exec(text)
    if (openFence) text = openFence[1]
  }

  text = stripSpecialCompletionTokens(text).replace(/<CURSOR>/gi, '')
  if (!text.trim()) return ''

  // Truncation guard
  const truncatedReason = finishReason === 'length' || finishReason === 'max_tokens'
  if (!hasClosingTag && (truncatedReason || (origStmt.length > 25 && text.length < origStmt.length * 0.55))) {
    return ''
  }

  if (looksInjected(text)) return ''

  const commentStripped = stripSqlCommentsForProseCheck(text)
  const startsWithSql = /^\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|EXPLAIN|SHOW|PRAGMA|DESCRIBE|BEGIN|COMMIT|ROLLBACK|MERGE|VALUES|TABLE)\b/i.test(
    commentStripped
  )
  if (!openTag && !startsWithSql && isProseExplanation(commentStripped)) {
    return ''
  }
  // Even with <REWRITE>, verify only appended/untagged prose explanation if the whole response has clear prose markers outside quotes/comments
  if (!startsWithSql && isProseExplanation(commentStripped)) {
    return ''
  }

  return text
}
