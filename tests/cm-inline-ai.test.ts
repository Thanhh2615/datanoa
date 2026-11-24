import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EditorState,
  EditorView,
  autocompletion,
  completionKeymap,
  completionStatus,
  history,
  historyKeymap,
  keymap,
} from '../vendor/codemirror.js'
import { installDomHarness, type DomHarness } from './helpers/dom-harness'
import {
  Pacer,
  acceptGhostFull,
  acceptGhostWord,
  acceptGhostLine,
  clearGhostEffect,
  createCmInlineAiExtension,
  ghostStateField,
  remainder,
  setGhostEffect,
  shouldSkipInlineTrigger,
  trackAcceptance,
} from '../src/shared-cm-inline-ai.js'
import { formatAiStatusBadge, openSharedAiConfigModal, renderSharedExplainAiPanel } from '../src/shared-ai-ui.js'

describe('shared-cm-inline-ai Pacer, remainder & acceptance tracking', () => {
  it('paces delays cleanly for normal flow, post-accept flow, and delete bursts', () => {
    const pacer = new Pacer()
    expect(pacer.pause(1000)).toBe(300)
    pacer.noteAccepted(1000)
    expect(pacer.pause(2000)).toBe(120)
    expect(pacer.pause(6000)).toBe(300)

    pacer.noteChange(true, 7000)
    pacer.noteChange(true, 7100)
    pacer.noteChange(true, 7200)
    expect(pacer.pause(7300)).toBe(600)
  })

  it('reuses remaining suggestion when typing along and drops when diverging', () => {
    const offered = { offset: 7, text: 'id, name FROM users' }
    expect(remainder(offered, 10, 'id,')).toBe(' name FROM users')
    expect(remainder(offered, 10, 'foo')).toBeNull()
    expect(remainder(offered, 7, '')).toBeNull()
    expect(remainder(offered, 7 + offered.text.length, offered.text)).toBeNull()
  })

  it('reports undone when edited within 5s and kept when intact at 30s', () => {
    let text = 'SELECT id FROM users'
    const tracked = new Map<string, { start: number; end: number }>()
    const timers: Array<() => void> = []
    let nextId = 1
    const model = {
      getText: () => text,
      trackRange: (start: number, end: number) => {
        const id = `r${nextId++}`
        tracked.set(id, { start, end })
        return id
      },
      getTrackedText: (id: string) => {
        const r = tracked.get(id)
        return r ? text.slice(r.start, r.end) : null
      },
      untrackRange: (id: string) => {
        tracked.delete(id)
      },
    }

    const verdicts1: string[] = []
    trackAcceptance(model, { startOffset: 7, text: 'id FROM users' }, (v) => verdicts1.push(v), (cb) => timers.push(cb))
    // Keep intact for 5s and 30s
    timers[0]()
    expect(verdicts1).toEqual([])
    timers[1]()
    expect(verdicts1).toEqual(['kept'])

    const verdicts2: string[] = []
    trackAcceptance(model, { startOffset: 7, text: 'id FROM users' }, (v) => verdicts2.push(v), (cb) => timers.push(cb))
    text = 'SELECT name FROM users'
    timers[2]()
    expect(verdicts2).toEqual(['undone'])
  })
})

describe('shared-cm-inline-ai inline trigger prefilter', () => {
  it('skips comments and mid-word cursors but allows quoted/closed/normal SQL', () => {
    expect(shouldSkipInlineTrigger('-- sql comment', '')).toBe(true)
    expect(shouldSkipInlineTrigger("'-- not comment' ", '')).toBe(false)
    expect(shouldSkipInlineTrigger('/* block ', '')).toBe(true)
    expect(shouldSkipInlineTrigger('/* ok */ SELECT ', '')).toBe(false)
    expect(shouldSkipInlineTrigger('SEL', 'ECT')).toBe(true)
    expect(shouldSkipInlineTrigger('SELECT * FROM ', '')).toBe(false)
  })

  it('handles apostrophes, quotes, and hashes accurately across single-pass comment/quote states', () => {
    expect(shouldSkipInlineTrigger("/* user's comment */ SELECT ", '')).toBe(false)
    expect(shouldSkipInlineTrigger("-- can't stop\nSELECT 1; -- real comment", '')).toBe(true)
    expect(shouldSkipInlineTrigger("# user's note\nSELECT 1 # trailing", '')).toBe(true)
    expect(shouldSkipInlineTrigger("# can't stop\nSELECT 1 ", '')).toBe(false)
    expect(shouldSkipInlineTrigger('`col--not-comment` SELECT ', '')).toBe(false)
    expect(shouldSkipInlineTrigger('"/* also not comment */" SELECT ', '')).toBe(false)
    expect(shouldSkipInlineTrigger('/* unclosed "quote" inside comment ', '')).toBe(true)
    expect(shouldSkipInlineTrigger("SELECT * FROM t WHERE name = 'O''Brien' -- trailing", '')).toBe(true)
    expect(shouldSkipInlineTrigger("SELECT * FROM t WHERE name = 'O''Brien' ", '')).toBe(false)
  })
})

describe('shared-cm-inline-ai context-aware Pacer delays', () => {
  it('triggers faster after punctuation/line-end than mid-word, within clamp', () => {
    const pacer = new Pacer()
    expect(pacer.delayMs()).toBe(300)

    const punctuation = pacer.delayFor({ triggerChar: '.', isLineEnd: false })
    const midWord = pacer.delayFor({ triggerChar: 'T', isLineEnd: false })
    const lineEnd = pacer.delayFor({ triggerChar: ' ', isLineEnd: true })

    expect(punctuation).toBe(120)
    expect(lineEnd).toBe(120)
    expect(midWord).toBeGreaterThanOrEqual(260)
    expect(midWord).toBeLessThanOrEqual(350)
    expect(punctuation).toBeLessThan(midWord)
    expect(pacer.delayMs({ triggerChar: '(', isLineEnd: false })).toBe(120)
  })

  it('still returns 600ms for rapid delete bursts with context', () => {
    const pacer = new Pacer()
    const now = Date.now()
    pacer.noteChange(true, now - 200)
    pacer.noteChange(true, now - 100)
    pacer.noteChange(true, now)
    expect(pacer.delayFor({ triggerChar: 'x', isLineEnd: false })).toBe(600)
  })
})

describe('shared-cm-inline-ai CodeMirror state & commands', () => {
  it('stores ghost state and supports full, word, line accept and clear', () => {
    let state = EditorState.create({
      doc: 'SELECT ',
      selection: { anchor: 7 },
      extensions: [
        createCmInlineAiExtension({
          isEnabled: () => true,
          requestCompletion: async () => ({ suggestion: '', id: 0 }),
        }),
      ],
    })
    state = state.update({ effects: setGhostEffect.of({ offset: 7, text: 'id, name\nFROM users', id: 42 }) }).state
    expect(state.field(ghostStateField)).toEqual({
      offset: 7,
      text: 'id, name\nFROM users',
      id: 42,
      replaceChars: 0,
    })

    // Word accept
    let applied = false
    const fakeView = {
      get state() {
        return state
      },
      dispatch(spec: Parameters<EditorState['update']>[0]) {
        state = state.update(spec).state
        applied = true
      },
    }
    expect(acceptGhostWord(fakeView as never)).toBe(true)
    expect(applied).toBe(true)
    expect(state.doc.toString()).toBe('SELECT id')
    expect(state.field(ghostStateField)?.text).toBe(', name\nFROM users')

    // Line accept
    expect(acceptGhostLine(fakeView as never)).toBe(true)
    expect(state.doc.toString()).toBe('SELECT id, name')
    expect(state.field(ghostStateField)?.text).toBe('\nFROM users')

    // Full accept of remainder
    expect(acceptGhostFull(fakeView as never)).toBe(true)
    expect(state.doc.toString()).toBe('SELECT id, name\nFROM users')
    expect(state.field(ghostStateField)).toBeNull()

    // Clear effect
    state = state.update({ effects: setGhostEffect.of({ offset: 26, text: ' LIMIT 10', id: 43 }) }).state
    state = state.update({ effects: clearGhostEffect.of(undefined) }).state
    expect(state.field(ghostStateField)).toBeNull()
  })

  describe('Tab key handling inside CodeMirror SQL editor', () => {
    let dom: DomHarness | null = null

    afterEach(() => {
      vi.useRealTimers()
      dom?.teardown()
      dom = null
    })

    function findTabCommand(view: EditorView): (v: EditorView) => boolean {
      const bindings = view.state.facet(keymap).flat()
      const tabBinding = bindings.find((b) => b && (b as { key?: string }).key === 'Tab') as
        | { run?: (v: EditorView) => boolean }
        | undefined
      if (!tabBinding?.run) {
        throw new Error('Expected Tab keybinding to be registered in keymap')
      }
      return tabBinding.run
    }

    function dispatchTabKeydown(view: EditorView): KeyboardEvent {
      const ev = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', cancelable: true, bubbles: true })
      view.contentDOM.dispatchEvent(ev)
      return ev
    }

    it('never lets Tab escape focus via real DOM keydown across active completion dropdown (AI on & AI off), active ghost, immediate AI trigger, and 2-space indent fallback', async () => {
      vi.useFakeTimers()
      dom = installDomHarness()

      let aiEnabled = true
      let pendingResolve: ((v: { id: number; suggestion: string; replaceChars?: number } | null) => void) | null = null
      const seenSignals: AbortSignal[] = []
      const requestCompletion = vi.fn(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise<{ id: number; suggestion: string; replaceChars?: number } | null>((resolve) => {
            seenSignals.push(signal)
            pendingResolve = resolve
          })
      )

      const view = new EditorView({
        doc: 'SELECT * FROM "banners"',
        selection: { anchor: 23 },
        extensions: [
          history(),
          autocompletion({
            override: [
              (ctx) => ({
                from: ctx.pos,
                options: [{ label: 'WHERE' }, { label: 'LIMIT' }],
              }),
            ],
          }),
          keymap.of([...completionKeymap, ...historyKeymap]),
          createCmInlineAiExtension({
            isEnabled: () => aiEnabled,
            requestCompletion,
          }),
        ],
        parent: dom.body,
      })

      try {
        const runTab = findTabCommand(view)
        const startAc = completionKeymap.find((b) => b.key === 'Ctrl-Space')?.run
        expect(startAc).toBeDefined()

        // Exported acceptGhostFull stays false when no ghost is active
        expect(acceptGhostFull(view)).toBe(false)

        // Branch 1: Active ghost -> real DOM Tab accepts ghost and prevents default
        view.dispatch({ effects: setGhostEffect.of({ offset: 23, text: ' LIMIT 100', id: 1 }) })
        const evGhost = dispatchTabKeydown(view)
        expect(evGhost.defaultPrevented).toBe(true)
        expect(view.state.doc.toString()).toBe('SELECT * FROM "banners" LIMIT 100')
        expect(view.state.field(ghostStateField)).toBeNull()

        // Branch 2a: Active CM6 dropdown + AI ON + no stored ghost -> closes dropdown, triggers AI immediately, defaultPrevented === true
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: 'SELECT * FROM "banners" ' },
          selection: { anchor: 24 },
        })
        startAc?.(view)
        await vi.advanceTimersByTimeAsync(50)
        expect(completionStatus(view.state)).toBe('active')
        expect(requestCompletion).toHaveBeenCalledTimes(0)
        const evAcAiOn = dispatchTabKeydown(view)
        expect(evAcAiOn.defaultPrevented).toBe(true)
        expect(completionStatus(view.state)).toBeNull()
        expect(requestCompletion).toHaveBeenCalledTimes(1)
        expect(seenSignals[0].aborted).toBe(false)
        expect(view.state.doc.toString()).toBe('SELECT * FROM "banners" ')

        // Pressing Tab again while identical (docVersion, head) request is still in-flight must NOT abort or restart it
        const evDedupe = dispatchTabKeydown(view)
        expect(evDedupe.defaultPrevented).toBe(true)
        expect(requestCompletion).toHaveBeenCalledTimes(1)
        expect(seenSignals[0].aborted).toBe(false)

        // Advancing timers past debounce window must NOT trigger a duplicate request
        await vi.advanceTimersByTimeAsync(1000)
        expect(requestCompletion).toHaveBeenCalledTimes(1)

        // Branch 2b: Active CM6 dropdown + AI ON + ghost ALREADY stored (hidden while dropdown open)
        // -> First Tab closes dropdown & reveals ghost WITHOUT blindly accepting it or firing a duplicate request!
        startAc?.(view)
        await vi.advanceTimersByTimeAsync(200)
        expect(completionStatus(view.state)).toBe('active')
        pendingResolve?.({ id: 2, suggestion: 'WHERE active = true' })
        await Promise.resolve()
        await Promise.resolve()
        expect(view.state.field(ghostStateField)?.text).toBe('WHERE active = true')
        const evReveal = dispatchTabKeydown(view)
        expect(evReveal.defaultPrevented).toBe(true)
        expect(completionStatus(view.state)).toBeNull()
        expect(view.state.doc.toString()).toBe('SELECT * FROM "banners" ')
        expect(view.state.field(ghostStateField)?.text).toBe('WHERE active = true')
        expect(requestCompletion).toHaveBeenCalledTimes(1)

        // Second Tab now accepts the visible ghost
        const evAccept = dispatchTabKeydown(view)
        expect(evAccept.defaultPrevented).toBe(true)
        expect(view.state.doc.toString()).toBe('SELECT * FROM "banners" WHERE active = true')
        expect(view.state.field(ghostStateField)).toBeNull()

        // Branch 3: Pressing Tab with no dropdown & no pending debounce triggers immediately at 0ms
        const evImmediate = dispatchTabKeydown(view)
        expect(evImmediate.defaultPrevented).toBe(true)
        expect(requestCompletion).toHaveBeenCalledTimes(2)
        pendingResolve?.(null)
        await Promise.resolve()
        await Promise.resolve()

        // Branch 2c: Active CM6 dropdown + AI OFF -> accepts highlighted CM6 completion & prevents default
        aiEnabled = false
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: 'SELECT * FROM "banners" ' },
          selection: { anchor: 24 },
        })
        startAc?.(view)
        await vi.advanceTimersByTimeAsync(200)
        expect(completionStatus(view.state)).toBe('active')
        const evAcAiOff = dispatchTabKeydown(view)
        expect(evAcAiOff.defaultPrevented).toBe(true)
        expect(completionStatus(view.state)).toBeNull()
        expect(view.state.doc.toString()).toBe('SELECT * FROM "banners" LIMIT')
        expect(requestCompletion).toHaveBeenCalledTimes(2)

        // Branch 2d: Active CM6 dropdown + AI ON at line start (canTriggerAi === false) -> accepts completion & prevents default
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: '  ' },
          selection: { anchor: 2 },
        })
        aiEnabled = true
        startAc?.(view)
        await vi.advanceTimersByTimeAsync(200)
        expect(completionStatus(view.state)).toBe('active')
        const evAcLineStart = dispatchTabKeydown(view)
        expect(evAcLineStart.defaultPrevented).toBe(true)
        expect(completionStatus(view.state)).toBeNull()
        expect(view.state.doc.toString()).toBe('  LIMIT')
        expect(requestCompletion).toHaveBeenCalledTimes(2)

        // Branch 2e: Active CM6 dropdown + AI OFF within interactionDelay (acceptCompletion returns false) -> fallback 2-space indent & defaultPrevented === true
        aiEnabled = false
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: '  ' },
          selection: { anchor: 2 },
        })
        startAc?.(view)
        await vi.advanceTimersByTimeAsync(50)
        expect(completionStatus(view.state)).toBe('active')
        const evAcFallback = dispatchTabKeydown(view)
        expect(evAcFallback.defaultPrevented).toBe(true)
        expect(view.state.doc.toString()).toBe('    ')
        expect(requestCompletion).toHaveBeenCalledTimes(2)
        aiEnabled = true

        // Branch 4a: Cursor in leading line indentation (even with AI enabled) -> inserts 2 spaces and prevents default
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: 'SELECT *\n  ' },
          selection: { anchor: 11 },
        })
        const evIndent = dispatchTabKeydown(view)
        expect(evIndent.defaultPrevented).toBe(true)
        expect(view.state.doc.toString()).toBe('SELECT *\n    ')
        expect(view.state.selection.main.head).toBe(13)
        expect(requestCompletion).toHaveBeenCalledTimes(2)

        // Branch 4b: Non-empty selection (even with AI enabled) -> replaces with 2 spaces and returns true
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: 'SELECT foo' },
          selection: { anchor: 7, head: 10 },
        })
        expect(runTab(view)).toBe(true)
        expect(view.state.doc.toString()).toBe('SELECT   ')
        expect(view.state.selection.main.head).toBe(9)
        expect(requestCompletion).toHaveBeenCalledTimes(2)

        // Branch 4c: AI disabled -> inserts 2 spaces after SQL text and prevents default
        aiEnabled = false
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: 'SELECT * FROM users' },
          selection: { anchor: 19 },
        })
        const evAiOffIndent = dispatchTabKeydown(view)
        expect(evAiOffIndent.defaultPrevented).toBe(true)
        expect(view.state.doc.toString()).toBe('SELECT * FROM users  ')
        expect(view.state.selection.main.head).toBe(21)
        expect(requestCompletion).toHaveBeenCalledTimes(2)

        // Branch 4d: AI enabled inside comment -> skips AI trigger, inserts 2 spaces and prevents default
        aiEnabled = true
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: '-- comment' },
          selection: { anchor: 10 },
        })
        const evComment = dispatchTabKeydown(view)
        expect(evComment.defaultPrevented).toBe(true)
        expect(view.state.doc.toString()).toBe('-- comment  ')
        expect(requestCompletion).toHaveBeenCalledTimes(2)
      } finally {
        view.destroy()
      }

      // Read-only editor allows Tab to leave focus (defaultPrevented === false)
      const roView = new EditorView({
        doc: 'SELECT 1',
        selection: { anchor: 8 },
        extensions: [
          EditorState.readOnly.of(true),
          createCmInlineAiExtension({
            isEnabled: () => true,
            requestCompletion,
          }),
        ],
        parent: dom.body,
      })
      try {
        const evRo = dispatchTabKeydown(roView)
        expect(evRo.defaultPrevented).toBe(false)
      } finally {
        roView.destroy()
      }
    })

    it('renders strikethrough preview for replaceChars > 0, replaces mistyped token atomically on Tab (undoable), handles partial word accept, and drops stale on edit', async () => {
      vi.useFakeTimers()
      dom = installDomHarness()

      const metrics: Array<{ id: number; kind: string }> = []
      let nextResponse: { id: number; suggestion: string; replaceChars?: number } | null = {
        id: 11,
        suggestion: 'SELECT * FROM banners',
        replaceChars: 5,
      }
      const requestCompletion = vi.fn(async () => nextResponse)

      const view = new EditorView({
        doc: 'SELCT',
        selection: { anchor: 5 },
        extensions: [
          history(),
          keymap.of([...historyKeymap]),
          createCmInlineAiExtension({
            isEnabled: () => true,
            requestCompletion,
            onMetric: (id, kind) => metrics.push({ id, kind }),
          }),
        ],
        parent: dom.body,
      })

      try {
        // Trigger inline AI immediately on 'SELCT'
        const evTrigger = dispatchTabKeydown(view)
        expect(evTrigger.defaultPrevented).toBe(true)
        await Promise.resolve()
        await Promise.resolve()

        expect(view.state.field(ghostStateField)).toEqual({
          offset: 5,
          text: 'SELECT * FROM banners',
          id: 11,
          replaceChars: 5,
        })

        // Verify DOM renders strikethrough mark over 'SELCT' AND ghost widget 'SELECT * FROM banners'
        const strikeEl = view.dom.querySelector('.cm-ai-replace-strike')
        const ghostEl = view.dom.querySelector('.cm-ai-ghost')
        expect(strikeEl?.textContent).toBe('SELCT')
        expect(ghostEl?.textContent).toBe('SELECT * FROM banners')

        // Tab accepts replacement in a single undoable transaction
        const evAccept = dispatchTabKeydown(view)
        expect(evAccept.defaultPrevented).toBe(true)
        expect(view.state.doc.toString()).toBe('SELECT * FROM banners')
        expect(view.state.selection.main.head).toBe(21)
        expect(view.state.field(ghostStateField)).toBeNull()
        expect(view.dom.querySelector('.cm-ai-replace-strike')).toBeNull()
        expect(metrics).toContainEqual({ id: 11, kind: 'shown' })
        expect(metrics).toContainEqual({ id: 11, kind: 'accepted' })

        // Single Ctrl+Z undo restores original mistyped token 'SELCT'
        const undoCmd = historyKeymap.find((b) => b.key === 'Mod-z')?.run
        expect(undoCmd).toBeDefined()
        expect(undoCmd?.(view)).toBe(true)
        expect(view.state.doc.toString()).toBe('SELCT')

        // Partial word accept replaces mistyped token with first word and clears replaceChars to 0 for remainder
        view.dispatch({
          effects: setGhostEffect.of({
            offset: 5,
            text: 'SELECT * FROM banners',
            id: 12,
            replaceChars: 5,
          }),
        })
        expect(acceptGhostWord(view)).toBe(true)
        expect(view.state.doc.toString()).toBe('SELECT')
        expect(view.state.selection.main.head).toBe(6)
        expect(view.state.field(ghostStateField)).toEqual({
          offset: 6,
          text: ' * FROM banners',
          id: 12,
          replaceChars: 0,
        })
        expect(view.dom.querySelector('.cm-ai-replace-strike')).toBeNull()
        expect(acceptGhostFull(view)).toBe(true)
        expect(view.state.doc.toString()).toBe('SELECT * FROM banners')

        // Typing while a replaceChars > 0 ghost is offered skips remainder() and reports stale
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: 'SELCT' },
          selection: { anchor: 5 },
        })
        nextResponse = { id: 13, suggestion: 'SELECT * FROM users', replaceChars: 5 }
        dispatchTabKeydown(view)
        await Promise.resolve()
        await Promise.resolve()
        expect(view.state.field(ghostStateField)?.replaceChars).toBe(5)
        expect(remainder({ offset: 5, text: 'SELECT', replaceChars: 5 } as never, 6, 'S')).toBeNull()

        // User types 'S' -> must drop offered as stale instead of keeping remainder
        view.dispatch({
          changes: { from: 5, to: 5, insert: 'S' },
          selection: { anchor: 6 },
        })
        await Promise.resolve()
        expect(view.state.field(ghostStateField)).toBeNull()
        expect(metrics).toContainEqual({ id: 13, kind: 'stale' })

        // Normal append (replaceChars === 0) never emits .cm-ai-replace-strike
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: 'SELECT * FROM banners LIM' },
          selection: { anchor: 25 },
        })
        view.dispatch({
          effects: setGhostEffect.of({ offset: 25, text: 'IT 100', id: 14, replaceChars: 0 }),
        })
        expect(view.dom.querySelector('.cm-ai-replace-strike')).toBeNull()
        expect(view.dom.querySelector('.cm-ai-ghost')?.textContent).toBe('IT 100')
      } finally {
        view.destroy()
      }
    })

    it('passes manual: false on debounced typing triggers and manual: true on immediate Tab triggers', async () => {
      vi.useFakeTimers()
      dom = installDomHarness()

      const calls: Array<{ prefix: string; manual?: boolean }> = []
      const requestCompletion = vi.fn(
        async ({ prefix, manual }: { prefix: string; manual?: boolean }) => {
          calls.push({ prefix, manual })
          return { id: calls.length, suggestion: ' LIMIT 10' }
        }
      )

      const view = new EditorView({
        doc: 'SELECT * FROM banners',
        selection: { anchor: 21 },
        extensions: [
          createCmInlineAiExtension({
            isEnabled: () => true,
            requestCompletion,
          }),
        ],
        parent: dom.body,
      })

      try {
        // 1. Debounced typing trigger passes manual: false
        view.dispatch({
          changes: { from: 21, to: 21, insert: ' ' },
          selection: { anchor: 22 },
        })
        await vi.advanceTimersByTimeAsync(500)
        expect(calls).toHaveLength(1)
        expect(calls[0]).toEqual({ prefix: 'SELECT * FROM banners ', manual: false })

        // Clear ghost so Tab triggers immediate completion instead of accepting
        view.dispatch({ effects: clearGhostEffect.of(undefined) })

        // 2. Immediate Tab trigger passes manual: true
        const ev = dispatchTabKeydown(view)
        expect(ev.defaultPrevented).toBe(true)
        await Promise.resolve()
        await Promise.resolve()
        expect(calls).toHaveLength(2)
        expect(calls[1]).toEqual({ prefix: 'SELECT * FROM banners ', manual: true })
      } finally {
        view.destroy()
      }
    })
  })
})

describe('shared-ai-ui status badge & explain panel helpers', () => {
  it('formats toolbar status badge across states', () => {
    expect(formatAiStatusBadge(null)).toEqual({ tone: 'neutral', label: 'AI · Off', title: 'Configure AI SQL Assistant' })
    expect(formatAiStatusBadge({
      enabled: true,
      state: 'on',
      lastMs: 420,
      suggested: 3,
      reason: null,
      format: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      host: 'api.openai.com',
      model: 'gpt-4o-mini',
      maxTokens: 96,
      explainLanguage: 'vi',
      hasKey: true,
      destination: 'remote',
    })).toMatchObject({ tone: 'success', label: 'AI · 0.4s' })
  })

  it('wires Analyze button, language pill, and full searchable modal UX via DOM shim', async () => {
    class FakeElement {
      tagName: string
      className = ''
      hidden = false
      disabled = false
      readOnly = false
      checked = false
      selected = false
      type = ''
      value = ''
      min = ''
      max = ''
      placeholder = ''
      title = ''
      autocomplete = ''
      tabIndex = 0
      children: FakeElement[] = []
      parentNode: FakeElement | null = null
      attrs = new Map<string, string>()
      listeners = new Map<string, Array<(e?: unknown) => void>>()
      private _text = ''

      constructor(tagName: string) {
        this.tagName = tagName.toUpperCase()
      }
      get firstChild() {
        return this.children[0] ?? null
      }
      get textContent() {
        return this._text + this.children.map((c) => c.textContent).join('')
      }
      set textContent(v: string) {
        this._text = v
        this.children = []
      }
      appendChild(child: FakeElement) {
        child.parentNode = this
        this.children.push(child)
        return child
      }
      removeChild(child: FakeElement) {
        this.children = this.children.filter((c) => c !== child)
        child.parentNode = null
        return child
      }
      setAttribute(k: string, v: string) {
        this.attrs.set(k, v)
      }
      focus() {}
      addEventListener(type: string, fn: (e?: unknown) => void) {
        const list = this.listeners.get(type) ?? []
        list.push(fn)
        this.listeners.set(type, list)
      }
      dispatchEvent(ev: { type: string }) {
        const event = { preventDefault() {}, stopPropagation() {}, target: this, ...ev }
        for (const fn of this.listeners.get(ev.type) ?? []) {
          fn(event)
        }
        return true
      }
      click() {
        this.dispatchEvent({ type: 'click' })
      }
      querySelectorAll(sel: string): FakeElement[] {
        const wantCls = sel.startsWith('.') ? sel.slice(1) : null
        const upper = sel.toUpperCase()
        const out: FakeElement[] = []
        for (const c of this.children) {
          if (wantCls ? c.className.split(/\s+/).includes(wantCls) : c.tagName === upper) {
            out.push(c)
          }
          out.push(...c.querySelectorAll(sel))
        }
        return out
      }
      querySelector(sel: string) {
        return this.querySelectorAll(sel)[0] ?? null
      }
    }

    const body = new FakeElement('body')
    const prevDoc = (globalThis as { document?: unknown }).document
    ;(globalThis as { document?: unknown }).document = {
      body,
      createElement: (tag: string) => new FakeElement(tag),
    }
    try {
      const host = new FakeElement('div') as unknown as HTMLElement
      let analyzed = 0
      let openedConfig = 0
      renderSharedExplainAiPanel(
        host,
        { phase: 'idle', aiEnabled: true, aiReady: true, explainLanguage: 'vi' },
        {
          onAnalyze: () => {
            analyzed += 1
          },
          onConfigureAi: () => {
            openedConfig += 1
          },
          onCancel: () => {},
          onApplySql: () => {},
          onOpenNewTab: () => {},
          onCopyText: () => {},
          onToggleCollapsed: () => {},
        }
      )
      expect(host.hidden).toBe(false)
      const analyzeBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Analyze with AI')
      )
      expect(analyzeBtn).toBeTruthy()
      analyzeBtn?.click()
      expect(analyzed).toBe(1)

      expect(host.querySelector('select')).toBeNull()
      expect(host.querySelector('.datanoa-ai-lang-pill')).toBeNull()
      expect(host.querySelector('.datanoa-ai-hint')).toBeNull()

      renderSharedExplainAiPanel(
        host,
        { phase: 'idle', aiEnabled: false, aiReady: false, explainLanguage: 'vi' },
        {
          onAnalyze: () => {
            analyzed += 1
          },
          onConfigureAi: () => {
            openedConfig += 1
          },
          onCancel: () => {},
          onApplySql: () => {},
          onOpenNewTab: () => {},
          onCopyText: () => {},
          onToggleCollapsed: () => {},
        }
      )
      expect(host.querySelector('.datanoa-ai-hint')).not.toBeNull()
      const setupBtn = Array.from(host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Configure AI to Analyze')
      ) as unknown as FakeElement | undefined
      setupBtn?.click()
      expect(openedConfig).toBe(1)

      const savedPatches: Array<Record<string, unknown>> = []
      const models60 = Array.from({ length: 60 }, (_, i) => `org/model-${String(i + 1).padStart(2, '0')}`)
      let closed = false
      const snap = {
        enabled: true,
        state: 'on' as const,
        lastMs: 320,
        suggested: 4,
        reason: null,
        format: 'openai' as const,
        baseUrl: 'https://api.openai.com/v1',
        host: 'api.openai.com',
        model: 'org/model-01',
        maxTokens: 96,
        explainMaxTokens: 2048,
        explainLanguage: 'vi' as const,
        hasKey: true,
        destination: 'remote' as const,
      }

      await openSharedAiConfigModal({
        rpc: async <T>(name: string): Promise<T> => {
          if (name === 'ai.status.get') return snap as unknown as T
          if (name === 'ai.stats.get') return { model: 'org/model-01', since: 1, summary: {} } as unknown as T
          if (name === 'ai.models.list') return { ok: true, models: models60, message: '' } as unknown as T
          if (name === 'ai.models.usage') return { usage: {} } as unknown as T
          return {} as T
        },
        saveSettings: async (patch) => {
          savedPatches.push(patch)
        },
        initialStatus: snap,
        closeModal: () => {
          closed = true
        },
      })
      await new Promise((r) => setTimeout(r, 20))

      const modal = body.querySelector('.datanoa-ai-modal') as FakeElement | null
      expect(modal).toBeTruthy()
      const numInputs = (modal?.querySelectorAll('input') ?? []).filter((i) => i.type === 'number')
      expect(numInputs.map((i) => i.value)).toEqual(['96', '2048'])
      expect(modal?.querySelectorAll('select').some((s) => s.value === 'vi')).toBe(true)

      expect(modal?.querySelectorAll('.datanoa-ai-chip')).toHaveLength(12)
      const searchInput = modal?.querySelector('.datanoa-ai-model-search') as FakeElement | null
      const showAllBtn = modal?.querySelectorAll('button').find((b) => /Show all/i.test(b.textContent))
      expect(showAllBtn?.textContent).toContain('60')

      if (searchInput) {
        searchInput.value = 'model-55'
        searchInput.dispatchEvent({ type: 'input' })
      }
      expect(modal?.querySelectorAll('.datanoa-ai-chip').map((c) => c.textContent)).toEqual(['org/model-55'])

      if (searchInput) {
        searchInput.value = ''
        searchInput.dispatchEvent({ type: 'input' })
      }
      modal?.querySelectorAll('button').find((b) => /Show all/i.test(b.textContent))?.click()
      expect(modal?.querySelectorAll('.datanoa-ai-chip')).toHaveLength(60)

      numInputs[1].value = '4096'
      modal?.querySelectorAll('button').find((b) => b.textContent === 'Save')?.click()
      await new Promise((r) => setTimeout(r, 10))
      expect(closed).toBe(true)
      expect(
        savedPatches.some((p) => p.aiMaxTokens === 96 && p.aiExplainMaxTokens === 4096 && p.aiExplainLanguage === 'vi')
      ).toBe(true)
    } finally {
      ;(globalThis as { document?: unknown }).document = prevDoc
    }
  })
})
