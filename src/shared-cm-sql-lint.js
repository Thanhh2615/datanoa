// src/shared-cm-sql-lint.js
// Shared CodeMirror 6 SQL syntax diagnostics extension (static lint + live DB syntax error overlay + hoverTooltip)

import {
  Decoration,
  EditorView,
  StateEffect,
  StateField,
  ViewPlugin,
  hoverTooltip,
} from '../vendor/codemirror.js'
import {
  analyzeSqlDiagnostics,
  extractDbSyntaxErrorDiagnostic,
} from './shared-sql-diagnostics.js'

const DEFAULT_DEBOUNCE_MS = 320
const MAX_LINT_DOC_LENGTH = 100_000
const TOKEN_CHAR_RE = /[\p{L}\p{N}_$]/u

export const setSqlDiagnosticsEffect = StateEffect.define()
export const setDbSqlErrorEffect = StateEffect.define()
export const clearDbSqlErrorEffect = StateEffect.define()
export const triggerSqlLintEffect = StateEffect.define()

function normalizeDiag(diag, docLen, isDb) {
  if (!diag || typeof diag !== 'object') return null
  if (typeof diag.from !== 'number' || typeof diag.to !== 'number') return null
  if (!Number.isFinite(diag.from) || !Number.isFinite(diag.to)) return null
  const from = Math.max(0, Math.min(docLen, Math.trunc(diag.from)))
  const to = Math.max(0, Math.min(docLen, Math.trunc(diag.to)))
  if (from >= to) return null
  const message = typeof diag.message === 'string' ? diag.message.trim() : ''
  if (!message) return null
  return {
    from,
    to,
    severity: diag.severity === 'warning' ? 'warning' : 'error',
    code: typeof diag.code === 'string' ? diag.code : isDb ? 'db-syntax-error' : 'sql-syntax',
    message,
    isDb,
  }
}

function diagnosticsEqual(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (
      x.from !== y.from ||
      x.to !== y.to ||
      x.severity !== y.severity ||
      x.code !== y.code ||
      x.message !== y.message
    ) {
      return false
    }
  }
  return true
}

function getCursorTokenBoundaryKey(doc, offset) {
  const len = doc.length
  const pos = Math.max(0, Math.min(len, offset))
  const line = doc.lineAt(pos)
  const rel = pos - line.from
  const text = line.text
  const atDocEnd = pos === len ? '1' : '0'

  let start = rel
  while (start > 0 && TOKEN_CHAR_RE.test(text[start - 1])) {
    start -= 1
  }
  let end = rel
  while (end < text.length && TOKEN_CHAR_RE.test(text[end])) {
    end += 1
  }
  if (start < end) {
    return `tok:${line.from + start}:${line.from + end}:${atDocEnd}`
  }

  let gapStart = rel
  while (gapStart > 0 && !TOKEN_CHAR_RE.test(text[gapStart - 1])) {
    gapStart -= 1
  }
  let gapEnd = rel
  while (gapEnd < text.length && !TOKEN_CHAR_RE.test(text[gapEnd])) {
    gapEnd += 1
  }
  return `gap:${line.from + gapStart}:${line.from + gapEnd}:${atDocEnd}`
}

const sqlLintDialectField = StateField.define({
  create() {
    return () => ''
  },
  update(value) {
    return value
  },
})

export const sqlDiagnosticsField = StateField.define({
  create() {
    return { staticDiags: [], dbDiag: null }
  },
  update(value, tr) {
    let staticDiags = value.staticDiags
    let dbDiag = value.dbDiag
    let changed = false

    if (tr.docChanged) {
      if (dbDiag !== null) {
        dbDiag = null
        changed = true
      }
      if (staticDiags.length > 0) {
        const docLen = tr.newDoc.length
        const mapped = []
        for (const d of staticDiags) {
          const from = Math.max(0, Math.min(docLen, tr.changes.mapPos(d.from, 1)))
          const to = Math.max(0, Math.min(docLen, tr.changes.mapPos(d.to, -1)))
          if (from < to) {
            mapped.push({ ...d, from, to })
          }
        }
        staticDiags = mapped
        changed = true
      }
    }

    for (const eff of tr.effects) {
      if (eff.is(setSqlDiagnosticsEffect)) {
        staticDiags = Array.isArray(eff.value) ? eff.value : []
        changed = true
      } else if (eff.is(clearDbSqlErrorEffect)) {
        if (dbDiag !== null) {
          dbDiag = null
          changed = true
        }
      } else if (eff.is(setDbSqlErrorEffect)) {
        const payload = eff.value
        if (!payload || typeof payload.errorMessage !== 'string' || !payload.errorMessage.trim()) {
          dbDiag = null
        } else {
          const dialectGetter = tr.state.field(sqlLintDialectField, false)
          const resolvedDialect =
            typeof payload.dialect === 'string' && payload.dialect.trim()
              ? payload.dialect
              : typeof dialectGetter === 'function'
                ? dialectGetter() || ''
                : ''
          const docLen = tr.newDoc.length
          const rawRange = payload.targetRange ?? null
          if (rawRange && typeof rawRange.from === 'number' && typeof rawRange.to === 'number') {
            const from = Math.max(0, Math.min(docLen, Math.trunc(rawRange.from)))
            const to = Math.max(from, Math.min(docLen, Math.trunc(rawRange.to)))
            if (to - from > MAX_LINT_DOC_LENGTH) {
              dbDiag = null
            } else {
              const sliceDiag = extractDbSyntaxErrorDiagnostic(
                tr.newDoc.sliceString(from, to),
                payload.errorMessage,
                null,
                resolvedDialect
              )
              dbDiag = sliceDiag
                ? { ...sliceDiag, from: from + sliceDiag.from, to: from + sliceDiag.to }
                : null
            }
          } else if (docLen > MAX_LINT_DOC_LENGTH) {
            dbDiag = null
          } else {
            dbDiag = extractDbSyntaxErrorDiagnostic(
              tr.newDoc.toString(),
              payload.errorMessage,
              null,
              resolvedDialect
            )
          }
        }
        changed = true
      }
    }

    return changed ? { staticDiags, dbDiag } : value
  },
})

export function collectActiveDiagnostics(state) {
  const field = state.field(sqlDiagnosticsField, false)
  if (!field) return []
  const docLen = state.doc.length
  if (docLen <= 0) return []

  const dbDiag = normalizeDiag(field.dbDiag, docLen, true)
  const staticCandidates = []
  if (Array.isArray(field.staticDiags)) {
    for (const raw of field.staticDiags) {
      const norm = normalizeDiag(raw, docLen, false)
      if (!norm) continue
      if (dbDiag && !(norm.to <= dbDiag.from || norm.from >= dbDiag.to)) {
        continue
      }
      staticCandidates.push(norm)
    }
  }

  // Prioritize errors over warnings so a wider warning NEVER suppresses an overlapping error
  staticCandidates.sort((a, b) => {
    const sevA = a.severity === 'error' ? 0 : 1
    const sevB = b.severity === 'error' ? 0 : 1
    if (sevA !== sevB) return sevA - sevB
    if (a.from !== b.from) return a.from - b.from
    return a.to - b.to
  })

  const nonOverlapping = []
  for (const diag of staticCandidates) {
    const overlapsExisting = nonOverlapping.some(
      (accepted) => !(diag.to <= accepted.from || diag.from >= accepted.to)
    )
    if (overlapsExisting) continue
    nonOverlapping.push(diag)
  }

  if (dbDiag) {
    nonOverlapping.push(dbDiag)
  }
  nonOverlapping.sort((a, b) => a.from - b.from || a.to - b.to)

  return nonOverlapping
}

function buildDiagnosticDecorations(state) {
  if (!Decoration || typeof Decoration.mark !== 'function') {
    return Decoration ? Decoration.none : []
  }
  const diags = collectActiveDiagnostics(state)
  if (diags.length === 0) {
    return Decoration.none
  }
  const ranges = diags.map((diag) =>
    Decoration.mark({
      class: diag.severity === 'warning' ? 'cm-sql-diag-warn' : 'cm-sql-diag-error',
      attributes: { 'data-sql-diag': diag.message },
    }).range(diag.from, diag.to)
  )
  return Decoration.set(ranges, true)
}

function findDiagnosticAtPos(diags, pos, side) {
  let fallback = null
  for (const diag of diags) {
    if (pos < diag.from || pos > diag.to) continue
    const strictMatch = side < 0 ? pos > diag.from : side > 0 ? pos < diag.to : true
    if (strictMatch) return diag
    if (!fallback) fallback = diag
  }
  return fallback
}

function createSqlDiagHoverTooltip() {
  if (typeof hoverTooltip !== 'function') {
    return []
  }
  return hoverTooltip(
    (view, pos, side) => {
      const diags = collectActiveDiagnostics(view.state)
      if (diags.length === 0) return null
      const match = findDiagnosticAtPos(diags, pos, side)
      if (!match) return null
      return {
        pos: match.from,
        end: match.to,
        above: true,
        create() {
          const dom = document.createElement('div')
          dom.className = 'cm-sql-diag-tooltip'
          dom.setAttribute('role', 'tooltip')
          dom.textContent = match.message
          return { dom }
        },
      }
    },
    { hoverTime: 220 }
  )
}

export function createCmSqlLintExtension(options = {}) {
  const getDialect = typeof options?.getDialect === 'function' ? options.getDialect : () => ''
  const debounceMs =
    typeof options?.debounceMs === 'number' &&
    Number.isFinite(options.debounceMs) &&
    options.debounceMs >= 0
      ? options.debounceMs
      : DEFAULT_DEBOUNCE_MS

  const diagnosticDecorations =
    typeof EditorView?.decorations?.compute === 'function'
      ? EditorView.decorations.compute(['doc', sqlDiagnosticsField], (state) =>
          buildDiagnosticDecorations(state)
        )
      : []

  const lintPlugin = ViewPlugin.fromClass(
    class SqlLintPlugin {
      constructor(view) {
        this.view = view
        this.timer = null
        this.destroyed = false
        this.lastCursorKey = getCursorTokenBoundaryKey(
          view.state.doc,
          view.state.selection.main.head
        )
        queueMicrotask(() => {
          if (!this.destroyed) {
            this.runLintNow()
          }
        })
      }

      update(vu) {
        for (const tr of vu.transactions) {
          for (const eff of tr.effects) {
            if (eff.is(triggerSqlLintEffect)) {
              this.cancelTimer()
              this.lastCursorKey = getCursorTokenBoundaryKey(
                vu.state.doc,
                vu.state.selection.main.head
              )
              queueMicrotask(() => {
                if (!this.destroyed) {
                  this.runLintNow()
                }
              })
              return
            }
          }
        }

        if (vu.docChanged) {
          this.lastCursorKey = getCursorTokenBoundaryKey(
            vu.state.doc,
            vu.state.selection.main.head
          )
          this.scheduleLint()
          return
        }

        if (vu.selectionSet) {
          const nextKey = getCursorTokenBoundaryKey(
            vu.state.doc,
            vu.state.selection.main.head
          )
          if (nextKey !== this.lastCursorKey) {
            this.lastCursorKey = nextKey
            this.scheduleLint()
          }
        }
      }

      scheduleLint() {
        this.cancelTimer()
        this.timer = setTimeout(() => {
          this.timer = null
          if (!this.destroyed) {
            this.runLintNow()
          }
        }, debounceMs)
      }

      cancelTimer() {
        if (this.timer !== null) {
          clearTimeout(this.timer)
          this.timer = null
        }
      }

      runLintNow() {
        if (this.destroyed) return
        const state = this.view.state
        const dialect = getDialect() || ''
        const nextDiags =
          state.doc.length > MAX_LINT_DOC_LENGTH
            ? []
            : analyzeSqlDiagnostics(state.doc.toString(), {
                dialect,
                cursorOffset: state.selection.main.head,
              })
        const prevField = state.field(sqlDiagnosticsField, false)
        if (prevField && diagnosticsEqual(prevField.staticDiags, nextDiags)) {
          return
        }
        this.view.dispatch({
          effects: setSqlDiagnosticsEffect.of(nextDiags),
        })
      }

      destroy() {
        this.destroyed = true
        this.cancelTimer()
      }
    }
  )

  return [
    sqlLintDialectField.init(() => getDialect),
    sqlDiagnosticsField,
    diagnosticDecorations,
    lintPlugin,
    createSqlDiagHoverTooltip(),
  ]
}
