import {
  Decoration,
  EditorView,
  Prec,
  StateEffect,
  StateField,
  ViewPlugin,
  WidgetType,
  acceptCompletion,
  closeCompletion,
  completionStatus,
  getCM,
  keymap,
} from '../vendor/codemirror.js'
import {
  isModalKeymapActive as isSharedModalKeymapActive,
  isModalNonInsertMode as isSharedModalNonInsertMode,
} from './shared-cm-keymap.js'
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
  stripSqlCommentsOnly,
} from './shared-sql-core.js'
import { analyzeSqlDiagnostics } from './shared-sql-diagnostics.js'
import { containsSensitiveSqlText } from './shared-sql-safety.js'

const NORMAL_PAUSE_MS = 300
const FAST_PAUSE_MS = 120
const SLOW_PAUSE_MS = 600
const SELECTION_PAUSE_MS = 350
const FAST_WINDOW_MS = 5000
const DELETE_WINDOW_MS = 1500
const DELETE_BURST_COUNT = 3
const UNDONE_CHECK_MS = 5000
const KEPT_CHECK_MS = 30000
const MAX_PAUSE_MS = 700
export const AI_MAX_IPC_PREFIX_CHARS = 8000
export const AI_MAX_IPC_SUFFIX_CHARS = 4000

const HIGH_CONTEXT_CHARS = new Set([' ', '.', ',', '(', '=', '\n'])
const IDENTIFIER_CHAR_RE = /[A-Za-z0-9_]/

function clamp(min, max, value) {
  return Math.max(min, Math.min(max, value))
}

export class Pacer {
  constructor() {
    this.baseMs = NORMAL_PAUSE_MS
    this._lastAcceptAt = -Infinity
    this._lastKeyAt = -Infinity
    this._deletes = []
  }

  noteAccepted(now = Date.now()) {
    this._lastAcceptAt = now
    this._deletes = []
  }

  noteKey(now = Date.now()) {
    this._lastKeyAt = now
  }

  noteChange(deleted, now = Date.now()) {
    if (!deleted) {
      this._deletes = []
      return
    }
    this._deletes.push(now)
    this._pruneDeletes(now)
  }

  pause(now = Date.now()) {
    this._pruneDeletes(now)
    if (this._deletes.length >= DELETE_BURST_COUNT) {
      return SLOW_PAUSE_MS
    }
    if (now - this._lastAcceptAt < FAST_WINDOW_MS) {
      return FAST_PAUSE_MS
    }
    return NORMAL_PAUSE_MS
  }

  delayFor(context) {
    if (!context) {
      return clamp(FAST_PAUSE_MS, MAX_PAUSE_MS, this.pause())
    }
    const now = Date.now()
    this._pruneDeletes(now)
    const triggerChar = typeof context.triggerChar === 'string' ? context.triggerChar : ''
    let delay = this.baseMs
    if (context.isLineEnd === true || HIGH_CONTEXT_CHARS.has(triggerChar)) {
      delay = FAST_PAUSE_MS
    } else if (triggerChar && IDENTIFIER_CHAR_RE.test(triggerChar)) {
      delay = NORMAL_PAUSE_MS
    }
    if (typeof context.estimatedLatencyMs === 'number' && context.estimatedLatencyMs > 0) {
      delay -= context.estimatedLatencyMs
    }
    if (this._deletes.length >= DELETE_BURST_COUNT) {
      delay = SLOW_PAUSE_MS
    } else if (now - this._lastAcceptAt < FAST_WINDOW_MS) {
      delay = Math.min(delay, FAST_PAUSE_MS)
    }
    return clamp(FAST_PAUSE_MS, MAX_PAUSE_MS, delay)
  }

  delayMs(context) {
    return this.delayFor(context)
  }

  _pruneDeletes(now) {
    const cutoff = now - DELETE_WINDOW_MS
    while (this._deletes.length > 0 && this._deletes[0] < cutoff) {
      this._deletes.shift()
    }
  }
}

export function remainder(offered, cursorOffset, typed) {
  if (!offered || typeof offered.text !== 'string' || !offered.text) {
    return null
  }
  if (typeof offered.replaceChars === 'number' && offered.replaceChars > 0) {
    return null
  }
  if (Array.isArray(offered.edits) && offered.edits.length > 0) {
    return null
  }
  const delta = cursorOffset - offered.offset
  if (delta <= 0 || delta >= offered.text.length) {
    return null
  }
  if (typeof typed !== 'string' || typed.length !== delta) {
    return null
  }
  if (!offered.text.startsWith(typed)) {
    return null
  }
  return offered.text.slice(delta)
}

function scanQuoteCommentState(prefix, dialect) {
  const rules = getDialectLexerRules(dialect)
  let i = 0
  const len = prefix.length
  while (i < len) {
    const ch = prefix[i]
    const next = prefix[i + 1]
    if (rules.lineCommentDash && ch === '-' && next === '-') {
      const end = scanLineCommentEnd(prefix, i)
      if (end >= len && prefix[len - 1] !== '\n' && prefix[len - 1] !== '\r') {
        return 'line_comment'
      }
      i = end
      continue
    }
    if (rules.lineCommentSlash && ch === '/' && next === '/') {
      const end = scanLineCommentEnd(prefix, i)
      if (end >= len && prefix[len - 1] !== '\n' && prefix[len - 1] !== '\r') {
        return 'line_comment'
      }
      i = end
      continue
    }
    if (rules.lineCommentHash && ch === '#') {
      const end = scanLineCommentEnd(prefix, i - 1)
      if (end >= len && prefix[len - 1] !== '\n' && prefix[len - 1] !== '\r') {
        return 'line_comment'
      }
      i = end
      continue
    }
    if (ch === '/' && next === '*') {
      const end = scanBlockCommentEnd(prefix, i, rules.nestedBlockComments)
      if (end >= len && !prefix.slice(i + 2).endsWith('*/')) {
        return 'block_comment'
      }
      i = end
      continue
    }
    if (rules.oracleQQuote) {
      const oq = scanOracleQuoteEnd(prefix, i, dialect)
      if (oq) {
        if (!oq.closed) return 'single'
        i = oq.end
        continue
      }
    }
    if (rules.dollarQuoting && ch === '$') {
      const tag = matchDollarQuoteTag(prefix, i)
      if (tag) {
        const closeAt = prefix.indexOf(tag, i + tag.length)
        if (closeAt === -1) return 'single'
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
      const seg = scanQuotedSegmentEnd(prefix, i + 1, "'", true)
      if (!seg.closed) return 'single'
      i = seg.end
      continue
    }
    if (ch === "'") {
      const seg = scanQuotedSegmentEnd(prefix, i, "'", rules.backslashEscapesSingleQuote)
      if (!seg.closed) return 'single'
      i = seg.end
      continue
    }
    if (ch === '"' && rules.doubleQuoteIdentifiers) {
      const seg = scanQuotedSegmentEnd(prefix, i, '"', rules.backslashEscapesDoubleQuote)
      if (!seg.closed) return 'double'
      i = seg.end
      continue
    }
    if (ch === '`' && rules.backtickIdentifiers) {
      const seg = scanQuotedSegmentEnd(prefix, i, '`', false)
      if (!seg.closed) return 'backtick'
      i = seg.end
      continue
    }
    if (ch === '[' && rules.bracketIdentifiers !== 'none') {
      const seg = scanBracketIdentEnd(prefix, i, rules.bracketIdentifiers === 'doubling')
      if (!seg.closed) return 'bracket'
      i = seg.end
      continue
    }
    i += 1
  }
  return 'normal'
}

export function shouldSkipInlineTrigger(prefix, suffix, dialect) {
  const safePrefix = typeof prefix === 'string' ? prefix : ''
  const safeSuffix = typeof suffix === 'string' ? suffix : ''
  const isolated = isolateActiveSqlStatement(safePrefix, safeSuffix, dialect)
  const state = safePrefix ? scanQuoteCommentState(isolated.stmtPrefix, dialect) : 'normal'
  if (state === 'line_comment' || state === 'block_comment') {
    return true
  }
  // Unclosed dollar-quote or Oracle q-quote string literal
  if (
    state === 'single' &&
    ((getDialectLexerRules(dialect).dollarQuoting && /\$[A-Za-z_]?[A-Za-z0-9_]*\$[^$]*$/.test(isolated.stmtPrefix)) ||
      (getDialectLexerRules(dialect).oracleQQuote && /\bn?q'[^\s]/i.test(isolated.stmtPrefix)))
  ) {
    return true
  }

  const prevChar = safePrefix.length > 0 ? safePrefix.charAt(safePrefix.length - 1) : ''
  const nextChar = safeSuffix.length > 0 ? safeSuffix.charAt(0) : ''
  const isMidWord = (!prevChar || IDENTIFIER_CHAR_RE.test(prevChar)) && IDENTIFIER_CHAR_RE.test(nextChar)
  if (!isMidWord) {
    return false
  }
  if (state === 'double' || state === 'backtick' || (dialect === 'mssql' && state === 'bracket')) {
    return false
  }
  if (dialect === 'redis' || dialect === 'mongodb') {
    return true
  }

  const relCursor = isolated.stmtPrefix.length
  const diags = analyzeSqlDiagnostics(`${isolated.stmtPrefix}${isolated.stmtSuffix}`, { dialect })
  const hasOverlappingError = diags.some(
    (d) => d.severity === 'error' && d.code !== 'incomplete-clause' && d.from <= relCursor && relCursor <= d.to
  )
  return !hasOverlappingError
}

export function trackAcceptance(
  model,
  accepted,
  report,
  schedule = defaultSchedule,
  unschedule = schedule === defaultSchedule ? defaultUnschedule : undefined
) {
  if (!model || !accepted) {
    return () => {}
  }
  const rawRanges = Array.isArray(accepted.ranges)
    ? accepted.ranges.filter((r) => r && typeof r.startOffset === 'number' && typeof r.text === 'string' && r.text.length > 0)
    : accepted.text
      ? [{ startOffset: accepted.startOffset, text: accepted.text }]
      : []
  if (rawRanges.length === 0) {
    return () => {}
  }
  const tracked = rawRanges.map((r) => ({
    id: model.trackRange(r.startOffset, r.startOffset + r.text.length),
    text: r.text,
  }))
  let cancelled = false
  let earlyTimerId = null
  let lateTimerId = null

  const clearTimer = (id) => {
    if (id !== null && id !== undefined && typeof unschedule === 'function') {
      unschedule(id)
    }
  }

  const untrackAll = () => {
    for (const item of tracked) {
      model.untrackRange(item.id)
    }
  }

  const allIntact = () => tracked.every((item) => model.getTrackedText(item.id) === item.text)

  earlyTimerId = schedule(() => {
    earlyTimerId = null
    if (cancelled) return
    if (!allIntact()) {
      cancelled = true
      untrackAll()
      report('undone')
      return
    }
    lateTimerId = schedule(() => {
      lateTimerId = null
      if (cancelled) return
      cancelled = true
      const kept = allIntact()
      untrackAll()
      report(kept ? 'kept' : 'undone')
    }, KEPT_CHECK_MS - UNDONE_CHECK_MS)
  }, UNDONE_CHECK_MS)

  return () => {
    if (cancelled) return
    cancelled = true
    const earlyId = earlyTimerId
    const lateId = lateTimerId
    earlyTimerId = null
    lateTimerId = null
    clearTimer(earlyId)
    clearTimer(lateId)
    untrackAll()
  }
}

function defaultSchedule(cb, ms) {
  return setTimeout(cb, ms)
}

function defaultUnschedule(id) {
  clearTimeout(id)
}

export const setGhostEffect = StateEffect.define()
export const clearGhostEffect = StateEffect.define()
export const notifyAiAvailabilityEffect = StateEffect.define()
const ghostAcceptedEffect = StateEffect.define()

export function notifyAiAvailabilityChanged(view) {
  if (view && typeof view.dispatch === 'function') {
    view.dispatch({ effects: notifyAiAvailabilityEffect.of(undefined) })
  }
}

export function isActiveSqlStatementSensitive(prefix, suffix, dialect, mode = 'auto') {
  const safePrefix = typeof prefix === 'string' ? prefix : ''
  const safeSuffix = typeof suffix === 'string' ? suffix : ''
  const combined = `${safePrefix}${safeSuffix}`
  if (!combined) return false
  if (dialect !== 'redis' && dialect !== 'mongodb') {
    const codeOnly = stripSqlCommentsOnly(combined, dialect)
    if (codeOnly.trim().length > 0) {
      return containsSensitiveSqlText(codeOnly)
    }
  } else if (dialect === 'redis') {
    const nonCommentLines = combined
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trimStart()
        return trimmed.length > 0 && !trimmed.startsWith('#') && !trimmed.startsWith('--')
      })
      .join('\n')
    if (nonCommentLines.trim().length > 0) {
      return containsSensitiveSqlText(nonCommentLines)
    }
  }
  const isolated = isolateActiveSqlStatement(safePrefix, safeSuffix, dialect)
  if (isolated.isFreshStatementAfterSemicolon) {
    if (mode === 'edit' && isolated.precedingErroredSlice?.text) {
      if (containsSensitiveSqlText(isolated.precedingErroredSlice.text)) {
        return true
      }
    }
    return containsSensitiveSqlText(`${isolated.stmtPrefix}${isolated.stmtSuffix}`)
  }
  return containsSensitiveSqlText(combined)
}

function normalizeReplaceChars(value, offset) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0
  }
  const maxChars = typeof offset === 'number' && Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0
  return Math.min(Math.trunc(value), maxChars)
}

function hasActiveGhostPayload(g) {
  return Boolean(g && (g.text || (Array.isArray(g.edits) && g.edits.length > 0)))
}

export function resolveDocEdits(rawEdits, cursorOffset, docLength) {
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    return null
  }
  if (!Number.isFinite(cursorOffset) || !Number.isFinite(docLength) || docLength < 0) {
    return null
  }
  const mapped = []
  for (const item of rawEdits) {
    if (
      !item ||
      typeof item.fromOffset !== 'number' ||
      typeof item.toOffset !== 'number' ||
      typeof item.insert !== 'string' ||
      !Number.isFinite(item.fromOffset) ||
      !Number.isFinite(item.toOffset)
    ) {
      return null
    }
    const from = Math.trunc(cursorOffset + item.fromOffset)
    const to = Math.trunc(cursorOffset + item.toOffset)
    if (from < 0 || to < from || to > docLength) {
      return null
    }
    if (from === to && item.insert.length === 0) {
      return null
    }
    mapped.push({ from, to, insert: item.insert })
  }
  mapped.sort((a, b) => a.from - b.from || a.to - b.to)
  for (let i = 1; i < mapped.length; i += 1) {
    if (mapped[i].from < mapped[i - 1].to) {
      return null
    }
  }
  return mapped
}

export function computePostApplyCursor(edits, originalOffset, newDocLength) {
  if (!Array.isArray(edits) || edits.length === 0) {
    return clamp(0, newDocLength, originalOffset)
  }
  let runningDelta = 0
  let deltaBefore = 0
  let exactInsertPos = null
  let touchedCursorPos = null
  for (const e of edits) {
    if (e.from === originalOffset && e.to === originalOffset) {
      exactInsertPos = e.from + runningDelta + e.insert.length
    } else if (e.from <= originalOffset && originalOffset <= e.to) {
      touchedCursorPos = e.from + runningDelta + e.insert.length
    }
    const hunkDelta = e.insert.length - (e.to - e.from)
    if (e.to <= originalOffset) {
      deltaBefore += hunkDelta
    }
    runningDelta += hunkDelta
  }
  const target =
    exactInsertPos !== null
      ? exactInsertPos
      : touchedCursorPos !== null
        ? touchedCursorPos
        : originalOffset + deltaBefore
  return clamp(0, newDocLength, target)
}

function sanitizeDirectEdits(rawEdits, docLength) {
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) return undefined
  const valid = []
  for (const e of rawEdits) {
    if (
      !e ||
      typeof e.from !== 'number' ||
      typeof e.to !== 'number' ||
      typeof e.insert !== 'string' ||
      !Number.isFinite(e.from) ||
      !Number.isFinite(e.to)
    ) {
      return undefined
    }
    const from = Math.trunc(e.from)
    const to = Math.trunc(e.to)
    if (from < 0 || to < from || to > docLength) return undefined
    if (from === to && e.insert.length === 0) return undefined
    valid.push({ from, to, insert: e.insert })
  }
  valid.sort((a, b) => a.from - b.from || a.to - b.to)
  for (let i = 1; i < valid.length; i += 1) {
    if (valid[i].from < valid[i - 1].to) return undefined
  }
  return valid
}

export const ghostStateField = StateField.define({
  create() {
    return null
  },
  update(value, tr) {
    let next = value
    let effectSet = false
    for (const eff of tr.effects) {
      if (eff.is(clearGhostEffect)) {
        next = null
        effectSet = true
      } else if (eff.is(setGhostEffect)) {
        if (hasActiveGhostPayload(eff.value)) {
          const hasRawEdits = Array.isArray(eff.value.edits) && eff.value.edits.length > 0
          const edits = hasRawEdits
            ? sanitizeDirectEdits(eff.value.edits, tr.state.doc.length)
            : undefined
          if (hasRawEdits && !edits && !eff.value.text) {
            next = null
          } else {
            const mode =
              eff.value.mode === 'edit' || eff.value.mode === 'complete' ? eff.value.mode : undefined
            next = {
              offset: eff.value.offset,
              text: typeof eff.value.text === 'string' ? eff.value.text : '',
              id: eff.value.id,
              replaceChars: normalizeReplaceChars(eff.value.replaceChars, eff.value.offset),
              ...(edits ? { edits } : {}),
              ...(mode ? { mode } : {}),
            }
          }
        } else {
          next = null
        }
        effectSet = true
      }
    }
    if (effectSet) {
      return next
    }
    if (!value) {
      return null
    }
    if (tr.docChanged) {
      return null
    }
    if (tr.selection && (!tr.selection.main.empty || tr.selection.main.head !== value.offset)) {
      return null
    }
    return value
  },
})

class GhostTextWidget extends WidgetType {
  constructor(text) {
    super()
    this.text = text
  }

  eq(other) {
    return other instanceof GhostTextWidget && other.text === this.text
  }

  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-ai-ghost'
    span.setAttribute('aria-hidden', 'true')
    span.textContent = this.text
    return span
  }

  ignoreEvent() {
    return true
  }
}

class DiffInsertWidget extends WidgetType {
  constructor(text) {
    super()
    this.text = text
  }

  eq(other) {
    return other instanceof DiffInsertWidget && other.text === this.text
  }

  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-ai-diff-insert'
    span.setAttribute('aria-hidden', 'true')
    span.textContent = this.text
    return span
  }

  ignoreEvent() {
    return true
  }
}

function activeGhostFor(state) {
  const ghost = state.field(ghostStateField, false)
  if (!hasActiveGhostPayload(ghost)) {
    return null
  }
  const sel = state.selection.main
  if (!sel.empty || sel.head !== ghost.offset) {
    return null
  }
  return ghost
}

function applyGhostChunk(view, chunk, kind) {
  if (view.state.readOnly) {
    return false
  }
  const ghost = activeGhostFor(view.state)
  if (!ghost || !chunk) {
    return false
  }
  const replaceChars = normalizeReplaceChars(ghost.replaceChars, ghost.offset)
  const replaceFrom = replaceChars > 0 ? Math.max(0, ghost.offset - replaceChars) : ghost.offset
  const remaining = ghost.text.slice(chunk.length)
  const insertedText = chunk.replace(/\r\n?/g, '\n')
  const newOffset = replaceFrom + insertedText.length
  const effects = [
    ghostAcceptedEffect.of({
      id: ghost.id,
      kind,
      startOffset: replaceFrom,
      text: insertedText,
      partial: remaining.length > 0,
    }),
    remaining
      ? setGhostEffect.of({ offset: newOffset, text: remaining, id: ghost.id, replaceChars: 0 })
      : clearGhostEffect.of(undefined),
  ]
  view.dispatch({
    changes: { from: replaceFrom, to: ghost.offset, insert: insertedText },
    selection: { anchor: newOffset },
    effects,
    userEvent: 'input.complete',
  })
  if (completionStatus(view.state) === 'active') {
    closeCompletion(view)
  }
  return true
}

export function acceptGhostFull(view) {
  if (view.state.readOnly) {
    return false
  }
  const ghost = activeGhostFor(view.state)
  if (!ghost) {
    return false
  }
  if (Array.isArray(ghost.edits) && ghost.edits.length > 0) {
    const docLen = view.state.doc.length
    let deltaTotal = 0
    let runningDelta = 0
    const ranges = []
    const changes = []
    const normalizedEdits = []
    for (const e of ghost.edits) {
      if (e.from < 0 || e.to < e.from || e.to > docLen) {
        return false
      }
      const normalizedInsert = e.insert.replace(/\r\n?/g, '\n')
      normalizedEdits.push({ from: e.from, to: e.to, insert: normalizedInsert })
      changes.push({ from: e.from, to: e.to, insert: normalizedInsert })
      if (normalizedInsert.length > 0) {
        ranges.push({ startOffset: e.from + runningDelta, text: normalizedInsert })
      }
      const hunkDelta = normalizedInsert.length - (e.to - e.from)
      runningDelta += hunkDelta
      deltaTotal += hunkDelta
    }
    const newDocLen = Math.max(0, docLen + deltaTotal)
    const targetCursor = computePostApplyCursor(normalizedEdits, ghost.offset, newDocLen)
    view.dispatch({
      changes,
      selection: { anchor: targetCursor },
      effects: [
        ghostAcceptedEffect.of({
          id: ghost.id,
          kind: 'accepted',
          ranges,
          partial: false,
        }),
        clearGhostEffect.of(undefined),
      ],
      userEvent: 'input.complete',
    })
    if (completionStatus(view.state) === 'active') {
      closeCompletion(view)
    }
    return true
  }
  return applyGhostChunk(view, ghost.text, 'accepted')
}

export function acceptGhostWord(view) {
  if (view.state.readOnly) {
    return false
  }
  const ghost = activeGhostFor(view.state)
  if (!ghost || (Array.isArray(ghost.edits) && ghost.edits.length > 0)) {
    return false
  }
  const match = /^(?:[ \t]*(?:\r?\n|[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$\r\n]+)|[ \t]+)/u.exec(ghost.text)
  const chunk = match ? match[0] : (Array.from(ghost.text)[0] ?? '')
  return applyGhostChunk(view, chunk, chunk.length === ghost.text.length ? 'accepted' : 'partial')
}

export function acceptGhostLine(view) {
  if (view.state.readOnly) {
    return false
  }
  const ghost = activeGhostFor(view.state)
  if (!ghost || (Array.isArray(ghost.edits) && ghost.edits.length > 0)) {
    return false
  }
  const text = ghost.text
  const leadNlLen = text.startsWith('\r\n') ? 2 : text.startsWith('\n') ? 1 : 0
  const nextNl = text.indexOf('\n', leadNlLen)
  let chunk = text
  if (nextNl >= 0) {
    chunk = text.slice(0, nextNl)
    if (chunk.length > leadNlLen && chunk.endsWith('\r')) {
      chunk = chunk.slice(0, -1)
    }
  }
  return applyGhostChunk(view, chunk, chunk.length === text.length ? 'accepted' : 'partial')
}

function clearGhostCommand(view) {
  if (!activeGhostFor(view.state)) {
    return false
  }
  view.dispatch({ effects: clearGhostEffect.of(undefined) })
  return true
}

class LiveModelTracker {
  constructor(view) {
    this._view = view
    this._nextId = 1
    this._ranges = new Map()
  }

  trackRange(start, end) {
    const id = `cm${this._nextId++}`
    this._ranges.set(id, { from: start, to: end })
    return id
  }

  mapChanges(changes) {
    for (const [id, range] of this._ranges.entries()) {
      const from = changes.mapPos(range.from, 1)
      const to = changes.mapPos(range.to, -1)
      if (to < from) {
        this._ranges.delete(id)
      } else {
        this._ranges.set(id, { from, to })
      }
    }
  }

  getTrackedText(id) {
    const range = this._ranges.get(id)
    if (!range) return null
    const docLen = this._view.state.doc.length
    if (range.from < 0 || range.to > docLen || range.from > range.to) return null
    return this._view.state.doc.sliceString(range.from, range.to)
  }

  untrackRange(id) {
    this._ranges.delete(id)
  }
}

export function createCmInlineAiExtension(options) {
  const isEnabled = options?.isEnabled ?? (() => false)
  const getDialect = typeof options?.getDialect === 'function' ? options.getDialect : () => undefined
  const getConnectionId =
    typeof options?.getConnectionId === 'function'
      ? options.getConnectionId
      : () => options?.connectionId
  const requestCompletion = options?.requestCompletion
  const onMetric = options?.onMetric
  const onRequestError =
    typeof options?.onRequestError === 'function' ? options.onRequestError : undefined
  const isModalMode = (view) => {
    if (typeof options?.isModalMode === 'function') {
      return Boolean(options.isModalMode(view))
    }
    return isSharedModalNonInsertMode(view)
  }
  const isModalKeymap = (view) => {
    if (typeof options?.isModalKeymap === 'function') {
      return Boolean(options.isModalKeymap(view))
    }
    if (typeof options?.isModalMode === 'function' && options.isModalMode(view)) {
      return true
    }
    return Boolean(getCM(view)?.state?.vim) || isSharedModalKeymapActive(view)
  }

  const ghostDecorations = EditorViewDecorationsFromField()

  function sliceCursorWindow(state, offset) {
    const prefixStart = Math.max(0, offset - AI_MAX_IPC_PREFIX_CHARS)
    const suffixEnd = Math.min(state.doc.length, offset + AI_MAX_IPC_SUFFIX_CHARS)
    return {
      prefix: state.doc.sliceString(prefixStart, offset),
      suffix: state.doc.sliceString(offset, suffixEnd),
      dialect: getDialect(),
    }
  }

  const plugin = ViewPlugin.fromClass(
    class InlineAiPlugin {
      constructor(view) {
        this.view = view
        this.pacer = new Pacer()
        this.tracker = new LiveModelTracker(view)
        this.cancels = new Set()
        this.timer = null
        this.inflight = null
        this.docVersion = 0
        this.lastOffered = null
        this.pendingAvailabilityTrigger = null
        this.estimatedLatencyMs = 0
        this.destroyed = false
      }

      handleAcceptedEffect(vu, info) {
        this.pacer.noteAccepted()
        if (info.partial) {
          const remGhost = vu.state.field(ghostStateField, false)
          this.lastOffered = remGhost
            ? {
                offset: remGhost.offset,
                text: remGhost.text,
                id: remGhost.id,
                replaceChars: normalizeReplaceChars(remGhost.replaceChars, remGhost.offset),
              }
            : null
        } else {
          this.lastOffered = null
        }
        if (info.id <= 0) {
          return
        }
        onMetric?.(info.id, info.kind)
        if (info.kind !== 'accepted' || info.partial) {
          return
        }
        const acceptedTarget = Array.isArray(info.ranges)
          ? { ranges: info.ranges }
          : { startOffset: info.startOffset, text: info.text }
        const cancel = trackAcceptance(this.tracker, acceptedTarget, (verdict) => {
          this.cancels.delete(cancel)
          onMetric?.(info.id, verdict)
        })
        this.cancels.add(cancel)
      }

      handleTransactionEffects(vu) {
        const allEffects = vu.transactions.flatMap((tr) => tr.effects)
        let handledAccept = false
        for (const eff of allEffects) {
          if (eff.is(ghostAcceptedEffect)) {
            handledAccept = true
            this.handleAcceptedEffect(vu, eff.value)
          }
        }
        if (!handledAccept) {
          for (const eff of allEffects) {
            if (eff.is(clearGhostEffect)) {
              this.cancelPending()
              if (this.lastOffered) {
                this.dropOffered('stale')
              }
            }
          }
        }
        return handledAccept
      }

      tryContinueOfferedGhost(vu, sel) {
        if (!this.lastOffered || isModalMode(vu.view)) {
          return false
        }
        const isPureInsert =
          !(this.lastOffered.replaceChars > 0) &&
          !(Array.isArray(this.lastOffered.edits) && this.lastOffered.edits.length > 0)
        if (!isPureInsert) {
          this.dropOffered('stale')
          return false
        }
        // Verify the transaction was strictly a pure insertion at/after lastOffered.offset (no edits/deletions elsewhere)
        let pureLocalInsert = true
        const offeredOffset = this.lastOffered.offset
        vu.changes.iterChanges((fromA, toA, fromB, toB) => {
          if (fromA !== toA || fromA < offeredOffset || toB > sel.head || fromB < offeredOffset) {
            pureLocalInsert = false
          }
        })
        if (!pureLocalInsert) {
          this.dropOffered('stale')
          return false
        }
        const typed =
          sel.head > this.lastOffered.offset
            ? vu.state.doc.sliceString(this.lastOffered.offset, sel.head)
            : ''
        const rem = remainder(this.lastOffered, sel.head, typed)
        if (!rem) {
          this.dropOffered('stale')
          return false
        }
        const expectedVersion = this.docVersion
        const nextGhost = { offset: sel.head, text: rem, id: this.lastOffered.id, replaceChars: 0 }
        this.lastOffered = nextGhost
        this.cancelPending()
        queueMicrotask(() => {
          const curSel = this.view.state.selection.main
          if (
            !this.destroyed &&
            !this.view.state.readOnly &&
            isEnabled() &&
            this.docVersion === expectedVersion &&
            this.lastOffered === nextGhost &&
            curSel.empty &&
            curSel.head === nextGhost.offset
          ) {
            this.view.dispatch({ effects: setGhostEffect.of(nextGhost) })
          }
        })
        return true
      }

      scheduleDocChangeTrigger(vu, offset, minDelayOverride = null) {
        if (isModalMode(vu.view)) {
          return
        }
        const expectedVersion = this.docVersion
        const { prefix, suffix, dialect } = sliceCursorWindow(vu.state, offset)
        if (shouldSkipInlineTrigger(prefix, suffix, dialect)) {
          return
        }
        const newlineAt = suffix.indexOf('\n')
        const suffixLine = newlineAt === -1 ? suffix : suffix.slice(0, newlineAt)
        const pacedDelay = this.pacer.delayMs({
          triggerChar: prefix.slice(-1),
          isLineEnd: /^\W*$/.test(suffixLine),
          estimatedLatencyMs: this.estimatedLatencyMs,
        })
        const delay =
          typeof minDelayOverride === 'number' && Number.isFinite(minDelayOverride)
            ? Math.max(0, Math.min(pacedDelay, minDelayOverride))
            : pacedDelay
        this.timer = setTimeout(() => {
          this.timer = null
          void this.trigger(expectedVersion, offset, false)
        }, delay)
      }

      update(vu) {
        if (vu.docChanged) {
          this.docVersion += 1
          this.tracker.mapChanges(vu.changes)
        }
        const hasAvailabilityNotify = vu.transactions.some((tr) =>
          tr.effects.some((eff) => eff.is(notifyAiAvailabilityEffect))
        )
        const handledAccept = this.handleTransactionEffects(vu)
        if (!isEnabled() || vu.state.readOnly || isModalMode(vu.view)) {
          if (vu.docChanged && !vu.state.readOnly && !isModalMode(vu.view) && !isEnabled()) {
            const sel = vu.state.selection.main
            const hasInteractiveEdit = vu.transactions.some(
              (tr) =>
                tr.docChanged &&
                !tr.isUserEvent('input.complete') &&
                (tr.isUserEvent('input') || tr.isUserEvent('delete') || vu.view.hasFocus)
            )
            if (hasInteractiveEdit && sel.empty && vu.state.doc.length > 0) {
              this.pacer.noteKey()
              this.pendingAvailabilityTrigger = {
                version: this.docVersion,
                offset: sel.head,
              }
            } else {
              this.pendingAvailabilityTrigger = null
            }
          } else if (vu.docChanged || vu.selectionSet || vu.state.readOnly || isModalMode(vu.view)) {
            this.pendingAvailabilityTrigger = null
          }
          this.cancelPending()
          if (this.lastOffered) {
            this.dropOffered('stale')
          }
          if (vu.state.field(ghostStateField, false)) {
            queueMicrotask(() => {
              if (!this.destroyed && this.view.state.field(ghostStateField, false)) {
                this.view.dispatch({ effects: clearGhostEffect.of(undefined) })
              }
            })
          }
          return
        }
        if (
          hasAvailabilityNotify &&
          !vu.docChanged &&
          !vu.selectionSet &&
          this.pendingAvailabilityTrigger
        ) {
          const pending = this.pendingAvailabilityTrigger
          this.pendingAvailabilityTrigger = null
          const sel = vu.state.selection.main
          if (
            pending.version === this.docVersion &&
            sel.empty &&
            sel.head === pending.offset &&
            vu.view.hasFocus &&
            typeof requestCompletion === 'function' &&
            vu.state.doc.length > 0 &&
            !this.timer &&
            !this.inflight &&
            !vu.state.field(ghostStateField, false)
          ) {
            const elapsed = Math.max(0, Date.now() - this.pacer._lastKeyAt)
            const normalDelay = this.pacer.pause()
            const remaining = Math.max(0, normalDelay - elapsed)
            this.scheduleDocChangeTrigger(vu, sel.head, remaining)
          }
          return
        }
        if (!vu.docChanged) {
          if (!vu.selectionSet) return
          this.pendingAvailabilityTrigger = null
          this.cancelPending()
          if (this.lastOffered && !vu.state.field(ghostStateField, false)) {
            this.dropOffered('stale')
          }
          this.scheduleSelectionTrigger(vu)
          return
        }
        this.pendingAvailabilityTrigger = null
        if (handledAccept) {
          this.cancelPending()
          return
        }
        let hadDelete = false
        vu.changes.iterChanges((fromA, toA, fromB, toB) => {
          if (toA - fromA > toB - fromB) hadDelete = true
        })
        this.pacer.noteChange(hadDelete)
        const sel = vu.state.selection.main
        if (!sel.empty) {
          this.dropOffered('stale')
          this.cancelPending()
          return
        }
        if (this.tryContinueOfferedGhost(vu, sel)) {
          return
        }
        this.cancelPending()
        if (typeof requestCompletion !== 'function' || vu.state.doc.length === 0) {
          return
        }
        this.scheduleDocChangeTrigger(vu, sel.head)
      }

      scheduleSelectionTrigger(vu) {
        if (
          typeof requestCompletion !== 'function' ||
          vu.state.readOnly ||
          vu.state.doc.length === 0 ||
          isModalMode(vu.view)
        ) {
          return
        }
        const sel = vu.state.selection.main
        if (!sel.empty || !vu.transactions.some((tr) => tr.isUserEvent('select'))) {
          return
        }
        const expectedVersion = this.docVersion
        const offset = sel.head
        const line = vu.state.doc.lineAt(offset)
        const { prefix, suffix, dialect } = sliceCursorWindow(vu.state, offset)
        const isolated = isolateActiveSqlStatement(prefix, suffix, dialect)
        const hasLineOrStmtContent = line.text.trim().length > 0 || isolated.stmtPrefix.trim().length > 0
        if (!hasLineOrStmtContent || shouldSkipInlineTrigger(prefix, suffix, dialect)) {
          return
        }
        this.timer = setTimeout(() => {
          this.timer = null
          void this.trigger(expectedVersion, offset, false)
        }, SELECTION_PAUSE_MS)
      }

      dropOffered(metricKind) {
        if (this.lastOffered && this.lastOffered.id > 0 && metricKind) {
          onMetric?.(this.lastOffered.id, metricKind)
        }
        this.lastOffered = null
      }

      cancelPending() {
        if (this.timer !== null) {
          clearTimeout(this.timer)
          this.timer = null
        }
        if (this.inflight) {
          this.inflight.controller.abort()
          this.inflight = null
        }
      }

      triggerImmediate(mode = 'auto') {
        if (
          this.destroyed ||
          this.view.state.readOnly ||
          !isEnabled() ||
          typeof requestCompletion !== 'function' ||
          isModalMode(this.view)
        ) {
          return
        }
        const state = this.view.state
        const sel = state.selection.main
        if (!sel.empty || state.doc.length === 0) {
          return
        }
        const offset = sel.head
        const expectedVersion = this.docVersion
        if (this.timer !== null) {
          clearTimeout(this.timer)
          this.timer = null
        }
        if (
          this.inflight &&
          !this.inflight.controller.signal.aborted &&
          this.inflight.version === expectedVersion &&
          this.inflight.offset === offset &&
          !(mode === 'edit' && this.inflight.mode !== 'edit')
        ) {
          return
        }
        if (this.inflight) {
          this.inflight.controller.abort()
          this.inflight = null
        }
        void this.trigger(expectedVersion, offset, true, mode)
      }

      async trigger(expectedVersion, offset, manual = false, mode = 'auto') {
        if (
          this.destroyed ||
          this.view.state.readOnly ||
          !isEnabled() ||
          typeof requestCompletion !== 'function' ||
          isModalMode(this.view)
        ) {
          return
        }
        const state = this.view.state
        if (this.docVersion !== expectedVersion) return
        if (!state.selection.main.empty || state.selection.main.head !== offset) return

        const { prefix, suffix, dialect } = sliceCursorWindow(state, offset)
        const connectionId = getConnectionId()
        if (mode === 'edit') {
          const isolated = isolateActiveSqlStatement(prefix, suffix, dialect)
          const quoteState = scanQuoteCommentState(isolated.stmtPrefix, dialect)
          if (quoteState === 'line_comment' || quoteState === 'block_comment') {
            this.cancelPending()
            return
          }
        } else if (shouldSkipInlineTrigger(prefix, suffix, dialect)) {
          this.cancelPending()
          return
        }
        // Scan active SQL statement around the bounded IPC window so unrelated prior statements/comments do not block
        const docLen = state.doc.length
        const scanStart = Math.max(0, offset - AI_MAX_IPC_PREFIX_CHARS - 512)
        const scanEnd = Math.min(docLen, offset + AI_MAX_IPC_SUFFIX_CHARS + 512)
        const scanPrefix = state.doc.sliceString(scanStart, offset)
        const scanSuffix = state.doc.sliceString(offset, scanEnd)
        if (isActiveSqlStatementSensitive(scanPrefix, scanSuffix, dialect, mode)) {
          this.cancelPending()
          return
        }

        const ac = new AbortController()
        const flight = { controller: ac, version: expectedVersion, offset, mode }
        this.inflight = flight
        const startedAt = Date.now()
        try {
          const res = await requestCompletion({
            prefix,
            suffix,
            offset,
            signal: ac.signal,
            manual: Boolean(manual),
            ...(mode && mode !== 'auto' ? { mode } : {}),
          })
          if (this.inflight === flight) this.inflight = null
          if (
            this.destroyed ||
            ac.signal.aborted ||
            !isEnabled() ||
            this.view.state.readOnly ||
            getDialect() !== dialect ||
            getConnectionId() !== connectionId
          ) {
            return
          }
          const elapsedMs = Math.max(0, Date.now() - startedAt)
          this.estimatedLatencyMs =
            this.estimatedLatencyMs > 0
              ? Math.min(400, Math.round(this.estimatedLatencyMs * 0.7 + elapsedMs * 0.3))
              : Math.min(400, elapsedMs)
          if (this.docVersion !== expectedVersion) return
          if (!this.view.state.selection.main.empty || this.view.state.selection.main.head !== offset) return
          if (!res) return
          let resolvedEdits = null
          if (Array.isArray(res.edits) && res.edits.length > 0) {
            resolvedEdits = resolveDocEdits(res.edits, offset, this.view.state.doc.length)
            if (!resolvedEdits) return
          }
          const normalizedSuggestion =
            typeof res.suggestion === 'string' ? res.suggestion.replace(/\r\n?/g, '\n') : ''
          if (!normalizedSuggestion && !resolvedEdits) return

          const replaceChars = normalizeReplaceChars(res.replaceChars, offset)
          const nextGhost = {
            offset,
            text: normalizedSuggestion,
            id: res.id,
            replaceChars,
            ...(resolvedEdits ? { edits: resolvedEdits } : {}),
            ...(res.mode === 'edit' || res.mode === 'complete' ? { mode: res.mode } : {}),
          }
          this.lastOffered = nextGhost
          this.view.dispatch({
            effects: setGhostEffect.of(nextGhost),
          })
          if (res.id > 0) {
            onMetric?.(res.id, 'shown')
          }
        } catch (err) {
          if (this.inflight === flight) this.inflight = null
          // Surface explicit manual requests (Tab completion or Alt+\ edit); keep background auto-completions quiet.
          if ((manual === true || mode === 'edit') && !this.destroyed && !ac.signal.aborted) {
            try {
              const errorMode = mode === 'edit' ? 'edit' : 'complete'
              onRequestError?.(err, {
                mode: errorMode,
                manual: Boolean(manual),
                prefix,
                suffix,
                dialect,
                connectionId,
              })
            } catch {
              // Keep editor command resilient if onRequestError throws
            }
          }
        }
      }

      destroy() {
        this.destroyed = true
        this.cancelPending()
        for (const cancel of this.cancels) {
          cancel()
        }
        this.cancels.clear()
      }
    }
  )

  let escapeTabArmed = false

  const resetEscapeTabListener = EditorView.updateListener.of((vu) => {
    if (vu.docChanged || vu.selectionSet) {
      escapeTabArmed = false
    }
  })

  function handleEscapeKey(view) {
    if (clearGhostCommand(view)) {
      escapeTabArmed = false
      return true
    }
    if (completionStatus(view.state) === 'active') {
      escapeTabArmed = false
      return false
    }
    if (isModalKeymap(view)) {
      escapeTabArmed = false
      return false
    }
    // WCAG 2.1.2 keyboard focus escape: pressing Escape in idle editor lets next Tab leave the editor
    escapeTabArmed = true
    return false
  }

  function insertTabSpaces(view, sel) {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: '  ' },
      selection: { anchor: sel.from + 2 },
      userEvent: 'input',
    })
    return true
  }

  function handleTabKey(view) {
    if (escapeTabArmed) {
      escapeTabArmed = false
      return false
    }
    if (view.state.readOnly || isModalMode(view)) {
      return false
    }
    if (acceptGhostFull(view)) {
      return true
    }
    const sel = view.state.selection.main
    const line = view.state.doc.lineAt(sel.head)
    const lineTextBefore = line.text.slice(0, sel.head - line.from)
    const { prefix, suffix, dialect } = sliceCursorWindow(view.state, sel.head)
    const isolatedForTab = isolateActiveSqlStatement(prefix, suffix, dialect)
    const canTriggerTabOnNewline =
      lineTextBefore === '' &&
      !isolatedForTab.isFreshStatementAfterSemicolon &&
      !isolatedForTab.terminatedBySemicolon &&
      isolatedForTab.stmtPrefix.trim().length > 0 &&
      !/\r?\n[ \t]*\r?\n[ \t]*$/.test(prefix)
    const canTriggerAi =
      isEnabled() &&
      typeof requestCompletion === 'function' &&
      sel.empty &&
      (lineTextBefore.trim().length > 0 || canTriggerTabOnNewline) &&
      !shouldSkipInlineTrigger(prefix, suffix, dialect)

    if (completionStatus(view.state) === 'active') {
      // Allow CM6 completion acceptance BEFORE inline AI trigger so Tab never breaks autocomplete
      if (acceptCompletion(view)) {
        return true
      }
      if (canTriggerAi) {
        closeCompletion(view)
        view.plugin(plugin)?.triggerImmediate()
        return true
      }
      return insertTabSpaces(view, sel)
    }

    if (canTriggerAi) {
      view.plugin(plugin)?.triggerImmediate()
      return true
    }
    return insertTabSpaces(view, sel)
  }

  function triggerManualEditCommand(view) {
    escapeTabArmed = false
    if (view.state.readOnly || !isEnabled() || typeof requestCompletion !== 'function') {
      return false
    }
    const sel = view.state.selection.main
    if (!sel.empty || view.state.doc.length === 0) {
      return false
    }
    if (completionStatus(view.state) === 'active') {
      closeCompletion(view)
    }
    view.plugin(plugin)?.triggerImmediate('edit')
    return true
  }

  const modalEscapeGuard = Prec.highest(
    EditorView.domEventHandlers({
      keydown(event, view) {
        if (
          event.key === 'Escape' &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.metaKey &&
          clearGhostCommand(view)
        ) {
          escapeTabArmed = false
          event.preventDefault()
          event.stopPropagation()
          return true
        }
        return false
      },
    })
  )

  return [
    ghostStateField,
    ghostDecorations,
    plugin,
    resetEscapeTabListener,
    modalEscapeGuard,
    Prec.highest(
      keymap.of([
        { key: 'Tab', run: handleTabKey },
        { key: 'Alt-\\', run: triggerManualEditCommand },
        { key: 'Mod-ArrowRight', run: acceptGhostWord },
        { key: 'Mod-Alt-ArrowRight', run: acceptGhostLine },
        { key: 'Escape', run: handleEscapeKey },
      ])
    ),
  ]
}

function EditorViewDecorationsFromField() {
  return StateField.define({
    create() {
      return Decoration.none
    },
    update(_value, tr) {
      const ghost = tr.state.field(ghostStateField, false)
      if (!hasActiveGhostPayload(ghost)) {
        return Decoration.none
      }
      const sel = tr.state.selection.main
      const docLen = tr.state.doc.length
      if (!sel.empty || sel.head !== ghost.offset || ghost.offset > docLen) {
        return Decoration.none
      }
      if (Array.isArray(ghost.edits) && ghost.edits.length > 0) {
        const decos = []
        for (const h of ghost.edits) {
          if (h.from < 0 || h.to < h.from || h.to > docLen) {
            return Decoration.none
          }
          if (h.from === h.to && h.from === ghost.offset && h.insert.length > 0) {
            decos.push(Decoration.widget({ widget: new GhostTextWidget(h.insert), side: 2 }).range(h.from))
          } else if (h.from < h.to && h.insert.length > 0) {
            decos.push(Decoration.mark({ class: 'cm-ai-replace-strike' }).range(h.from, h.to))
            decos.push(Decoration.widget({ widget: new DiffInsertWidget(h.insert), side: 1 }).range(h.to))
          } else if (h.from < h.to && h.insert.length === 0) {
            decos.push(Decoration.mark({ class: 'cm-ai-replace-strike' }).range(h.from, h.to))
          } else if (h.from === h.to && h.from !== ghost.offset && h.insert.length > 0) {
            decos.push(Decoration.widget({ widget: new DiffInsertWidget(h.insert), side: 1 }).range(h.from))
          }
        }
        return Decoration.set(decos, true)
      }
      const replaceChars = normalizeReplaceChars(ghost.replaceChars, ghost.offset)
      const replaceFrom = ghost.offset - replaceChars
      if (replaceChars > 0 && replaceFrom >= 0 && replaceFrom < ghost.offset) {
        return Decoration.set([
          Decoration.mark({ class: 'cm-ai-replace-strike' }).range(replaceFrom, ghost.offset),
          Decoration.widget({ widget: new GhostTextWidget(ghost.text), side: 2 }).range(ghost.offset),
        ])
      }
      return Decoration.set([
        Decoration.widget({ widget: new GhostTextWidget(ghost.text), side: 2 }).range(ghost.offset),
      ])
    },
    provide: (f) => EditorView.decorations.from(f),
  })
}
