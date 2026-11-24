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
  keymap,
} from '../vendor/codemirror.js'

const NORMAL_PAUSE_MS = 300
const FAST_PAUSE_MS = 120
const SLOW_PAUSE_MS = 600
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

function scanQuoteCommentState(prefix) {
  let state = 'normal'
  for (let i = 0; i < prefix.length; i += 1) {
    const ch = prefix[i]
    const next = prefix[i + 1]
    if (state === 'single' || state === 'double' || state === 'backtick') {
      const q = state === 'single' ? "'" : state === 'double' ? '"' : '`'
      if (state !== 'backtick' && ch === '\\' && (next === q || next === '\\')) {
        i += 1
        continue
      }
      if (ch === q) {
        if (next === q) {
          i += 1
          continue
        }
        state = 'normal'
      }
      continue
    }
    if (state === 'line_comment') {
      if (ch === '\n') state = 'normal'
      continue
    }
    if (state === 'block_comment') {
      if (ch === '*' && next === '/') {
        state = 'normal'
        i += 1
      }
      continue
    }
    if (ch === '-' && next === '-') {
      state = 'line_comment'
      i += 1
    } else if (ch === '#') {
      state = 'line_comment'
    } else if (ch === '/' && next === '*') {
      state = 'block_comment'
      i += 1
    } else if (ch === "'") {
      state = 'single'
    } else if (ch === '"') {
      state = 'double'
    } else if (ch === '`') {
      state = 'backtick'
    }
  }
  return state
}

export function shouldSkipInlineTrigger(prefix, suffix) {
  if (typeof suffix === 'string' && IDENTIFIER_CHAR_RE.test(suffix.charAt(0))) {
    return true
  }
  if (typeof prefix !== 'string' || !prefix) {
    return false
  }
  const state = scanQuoteCommentState(prefix)
  return state === 'line_comment' || state === 'block_comment'
}

export function trackAcceptance(
  model,
  accepted,
  report,
  schedule = defaultSchedule,
  unschedule = schedule === defaultSchedule ? defaultUnschedule : undefined
) {
  if (!model || !accepted || !accepted.text) {
    return () => {}
  }
  const rangeId = model.trackRange(accepted.startOffset, accepted.startOffset + accepted.text.length)
  let cancelled = false
  let earlyTimerId = null
  let lateTimerId = null

  const clearTimer = (id) => {
    if (id !== null && id !== undefined && typeof unschedule === 'function') {
      unschedule(id)
    }
  }

  earlyTimerId = schedule(() => {
    earlyTimerId = null
    if (cancelled) return
    const atEarly = model.getTrackedText(rangeId)
    if (atEarly !== accepted.text) {
      cancelled = true
      model.untrackRange(rangeId)
      report('undone')
      return
    }
    lateTimerId = schedule(() => {
      lateTimerId = null
      if (cancelled) return
      cancelled = true
      const atLate = model.getTrackedText(rangeId)
      model.untrackRange(rangeId)
      report(atLate === accepted.text ? 'kept' : 'undone')
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
    model.untrackRange(rangeId)
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
const ghostAcceptedEffect = StateEffect.define()

function normalizeReplaceChars(value, offset) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0
  }
  const maxChars = typeof offset === 'number' && Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0
  return Math.min(Math.trunc(value), maxChars)
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
        next =
          eff.value && eff.value.text
            ? {
                offset: eff.value.offset,
                text: eff.value.text,
                id: eff.value.id,
                replaceChars: normalizeReplaceChars(eff.value.replaceChars, eff.value.offset),
              }
            : null
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

function activeGhostFor(state) {
  const ghost = state.field(ghostStateField, false)
  if (!ghost || !ghost.text) {
    return null
  }
  if (completionStatus(state) === 'active') {
    return null
  }
  const sel = state.selection.main
  if (!sel.empty || sel.head !== ghost.offset) {
    return null
  }
  return ghost
}

function applyGhostChunk(view, chunk, kind) {
  const ghost = activeGhostFor(view.state)
  if (!ghost || !chunk) {
    return false
  }
  const replaceChars = normalizeReplaceChars(ghost.replaceChars, ghost.offset)
  const replaceFrom = replaceChars > 0 ? Math.max(0, ghost.offset - replaceChars) : ghost.offset
  const remaining = ghost.text.slice(chunk.length)
  const newOffset = replaceFrom + chunk.length
  const effects = [
    remaining
      ? setGhostEffect.of({ offset: newOffset, text: remaining, id: ghost.id, replaceChars: 0 })
      : clearGhostEffect.of(undefined),
    ghostAcceptedEffect.of({
      id: ghost.id,
      kind,
      startOffset: replaceFrom,
      text: chunk,
      partial: remaining.length > 0,
    }),
  ]
  view.dispatch({
    changes: { from: replaceFrom, to: ghost.offset, insert: chunk },
    selection: { anchor: newOffset },
    effects,
    userEvent: 'input.complete',
  })
  return true
}

export function acceptGhostFull(view) {
  const ghost = activeGhostFor(view.state)
  if (!ghost) {
    return false
  }
  return applyGhostChunk(view, ghost.text, 'accepted')
}

export function acceptGhostWord(view) {
  const ghost = activeGhostFor(view.state)
  if (!ghost) {
    return false
  }
  const match = /^(?:[ \t]*(?:\r?\n|[\w$]+|[^\s\w$\r\n]+)|[ \t]+)/.exec(ghost.text)
  const chunk = match ? match[0] : ghost.text.slice(0, 1)
  return applyGhostChunk(view, chunk, chunk.length === ghost.text.length ? 'accepted' : 'partial')
}

export function acceptGhostLine(view) {
  const ghost = activeGhostFor(view.state)
  if (!ghost) {
    return false
  }
  const text = ghost.text
  const firstNl = text.indexOf('\n')
  let chunk = text
  if (firstNl > 0) {
    chunk = text.slice(0, firstNl).replace(/\r$/, '')
  } else if (firstNl === 0) {
    const secondNl = text.indexOf('\n', 1)
    chunk = secondNl >= 0 ? text.slice(0, secondNl).replace(/\r$/, '') : text
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

  getText() {
    return this._view.state.doc.toString()
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
  const requestCompletion = options?.requestCompletion
  const onMetric = options?.onMetric

  const ghostDecorations = EditorViewDecorationsFromField()

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
        this.destroyed = false
      }

      update(vu) {
        if (vu.docChanged) {
          this.docVersion += 1
          this.tracker.mapChanges(vu.changes)
        }

        let handledAccept = false
        for (const tr of vu.transactions) {
          for (const eff of tr.effects) {
            if (eff.is(ghostAcceptedEffect)) {
              handledAccept = true
              const info = eff.value
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
              if (info.id > 0) {
                onMetric?.(info.id, info.kind)
                if (info.kind === 'accepted' && !info.partial) {
                  const cancel = trackAcceptance(
                    this.tracker,
                    { startOffset: info.startOffset, text: info.text },
                    (verdict) => {
                      this.cancels.delete(cancel)
                      onMetric?.(info.id, verdict)
                    }
                  )
                  this.cancels.add(cancel)
                }
              }
            } else if (eff.is(clearGhostEffect) && this.lastOffered && !handledAccept) {
              if (this.lastOffered.id > 0) {
                onMetric?.(this.lastOffered.id, 'stale')
              }
              this.lastOffered = null
            }
          }
        }

        if (!isEnabled()) {
          this.cancelPending()
          if (vu.state.field(ghostStateField, false)) {
            queueMicrotask(() => {
              if (!this.destroyed && this.view.state.field(ghostStateField, false)) {
                this.view.dispatch({ effects: clearGhostEffect.of(undefined) })
              }
            })
          }
          return
        }

        if (!vu.docChanged) {
          if (vu.selectionSet) {
            this.cancelPending()
            if (this.lastOffered && !vu.state.field(ghostStateField, false)) {
              this.dropOffered('stale')
            }
          }
          return
        }

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

        if (this.lastOffered) {
          if (!(this.lastOffered.replaceChars > 0)) {
            const typed =
              sel.head > this.lastOffered.offset
                ? vu.state.doc.sliceString(this.lastOffered.offset, sel.head)
                : ''
            const rem = remainder(this.lastOffered, sel.head, typed)
            if (rem) {
              const nextGhost = { offset: sel.head, text: rem, id: this.lastOffered.id, replaceChars: 0 }
              this.lastOffered = nextGhost
              this.cancelPending()
              queueMicrotask(() => {
                if (!this.destroyed && this.view.state.selection.main.head === nextGhost.offset) {
                  this.view.dispatch({ effects: setGhostEffect.of(nextGhost) })
                }
              })
              return
            }
          }
          this.dropOffered('stale')
        }

        this.cancelPending()
        if (typeof requestCompletion !== 'function') {
          return
        }
        const expectedVersion = this.docVersion
        const offset = sel.head
        if (vu.state.doc.length === 0) {
          return
        }
        const prefixStart = Math.max(0, offset - AI_MAX_IPC_PREFIX_CHARS)
        const suffixEnd = Math.min(vu.state.doc.length, offset + AI_MAX_IPC_SUFFIX_CHARS)
        const prefix = vu.state.doc.sliceString(prefixStart, offset)
        const suffix = vu.state.doc.sliceString(offset, suffixEnd)
        if (shouldSkipInlineTrigger(prefix, suffix)) {
          return
        }
        const newlineAt = suffix.indexOf('\n')
        const suffixLine = newlineAt === -1 ? suffix : suffix.slice(0, newlineAt)
        const delay = this.pacer.delayMs({
          triggerChar: prefix.slice(-1),
          isLineEnd: /^\W*$/.test(suffixLine),
        })
        this.timer = setTimeout(() => {
          this.timer = null
          void this.trigger(expectedVersion, offset, false)
        }, delay)
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

      triggerImmediate() {
        if (this.destroyed || !isEnabled() || typeof requestCompletion !== 'function') {
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
          this.inflight.offset === offset
        ) {
          return
        }
        if (this.inflight) {
          this.inflight.controller.abort()
          this.inflight = null
        }
        void this.trigger(expectedVersion, offset, true)
      }

      async trigger(expectedVersion, offset, manual = false) {
        if (this.destroyed || !isEnabled() || typeof requestCompletion !== 'function') {
          return
        }
        const state = this.view.state
        if (this.docVersion !== expectedVersion) return
        if (!state.selection.main.empty || state.selection.main.head !== offset) return

        const prefixStart = Math.max(0, offset - AI_MAX_IPC_PREFIX_CHARS)
        const suffixEnd = Math.min(state.doc.length, offset + AI_MAX_IPC_SUFFIX_CHARS)
        const prefix = state.doc.sliceString(prefixStart, offset)
        const suffix = state.doc.sliceString(offset, suffixEnd)
        if (shouldSkipInlineTrigger(prefix, suffix)) {
          this.cancelPending()
          return
        }

        const ac = new AbortController()
        const flight = { controller: ac, version: expectedVersion, offset }
        this.inflight = flight
        try {
          const res = await requestCompletion({
            prefix,
            suffix,
            offset,
            signal: ac.signal,
            manual: Boolean(manual),
          })
          if (this.inflight === flight) this.inflight = null
          if (this.destroyed || ac.signal.aborted || !isEnabled()) return
          if (this.docVersion !== expectedVersion) return
          if (!this.view.state.selection.main.empty || this.view.state.selection.main.head !== offset) return
          if (!res || !res.suggestion) return

          const replaceChars = normalizeReplaceChars(res.replaceChars, offset)
          const nextGhost = { offset, text: res.suggestion, id: res.id, replaceChars }
          this.lastOffered = nextGhost
          this.view.dispatch({
            effects: setGhostEffect.of(nextGhost),
          })
          if (res.id > 0) {
            onMetric?.(res.id, 'shown')
          }
        } catch {
          if (this.inflight === flight) this.inflight = null
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

  function insertTabSpaces(view, sel) {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: '  ' },
      selection: { anchor: sel.from + 2 },
      userEvent: 'input',
    })
    return true
  }

  function handleTabKey(view) {
    if (acceptGhostFull(view)) {
      return true
    }
    if (view.state.readOnly) {
      return false
    }
    const sel = view.state.selection.main
    const line = view.state.doc.lineAt(sel.head)
    const lineTextBefore = line.text.slice(0, sel.head - line.from)
    const prefixStart = Math.max(0, sel.head - AI_MAX_IPC_PREFIX_CHARS)
    const suffixEnd = Math.min(view.state.doc.length, sel.head + AI_MAX_IPC_SUFFIX_CHARS)
    const prefix = view.state.doc.sliceString(prefixStart, sel.head)
    const suffix = view.state.doc.sliceString(sel.head, suffixEnd)
    const canTriggerAi =
      isEnabled() &&
      typeof requestCompletion === 'function' &&
      sel.empty &&
      lineTextBefore.trim().length > 0 &&
      !shouldSkipInlineTrigger(prefix, suffix)

    if (completionStatus(view.state) === 'active') {
      if (canTriggerAi) {
        closeCompletion(view)
        const existingGhost = view.state.field(ghostStateField, false)
        const hasStoredGhostAtHead = Boolean(
          existingGhost && existingGhost.text && existingGhost.offset === sel.head
        )
        if (!hasStoredGhostAtHead) {
          view.plugin(plugin)?.triggerImmediate()
        }
        return true
      }
      if (acceptCompletion(view)) {
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

  return [
    ghostStateField,
    ghostDecorations,
    plugin,
    Prec.highest(
      keymap.of([
        { key: 'Tab', run: handleTabKey },
        { key: 'Mod-ArrowRight', run: acceptGhostWord },
        { key: 'Mod-Alt-ArrowRight', run: acceptGhostLine },
        { key: 'Escape', run: clearGhostCommand },
      ])
    ),
  ]
}

function EditorViewDecorationsFromField() {
  if (!Decoration || typeof Decoration.widget !== 'function' || !EditorView?.decorations) {
    return []
  }
  return StateField.define({
    create() {
      return Decoration.none
    },
    update(_value, tr) {
      const ghost = tr.state.field(ghostStateField, false)
      if (!ghost || !ghost.text || completionStatus(tr.state) === 'active') {
        return Decoration.none
      }
      const sel = tr.state.selection.main
      if (!sel.empty || sel.head !== ghost.offset || ghost.offset > tr.state.doc.length) {
        return Decoration.none
      }
      const replaceChars = normalizeReplaceChars(ghost.replaceChars, ghost.offset)
      const replaceFrom = ghost.offset - replaceChars
      if (
        replaceChars > 0 &&
        replaceFrom >= 0 &&
        replaceFrom < ghost.offset &&
        typeof Decoration.mark === 'function'
      ) {
        return Decoration.set([
          Decoration.mark({ class: 'cm-ai-replace-strike' }).range(replaceFrom, ghost.offset),
          Decoration.widget({ widget: new GhostTextWidget(ghost.text), side: 1 }).range(ghost.offset),
        ])
      }
      return Decoration.set([
        Decoration.widget({ widget: new GhostTextWidget(ghost.text), side: 1 }).range(ghost.offset),
      ])
    },
    provide: (f) => EditorView.decorations.from(f),
  })
}
