// Pure CodeMirror 6 keymap, shortcut validation, and live Vim modal mode helper.
// Uses ../vendor/codemirror.js exclusively to guarantee singleton @codemirror/state.

import {
  Prec,
  StateEffect,
  StateField,
  ViewPlugin,
  getCM,
  keymap,
  vim,
} from '../vendor/codemirror.js'

export const DEFAULT_EDITOR_KEYMAP_SETTINGS = Object.freeze({
  editorKeymap: 'default',
  shortcutRunStatement: 'Mod-Enter',
  shortcutRunAll: 'Mod-Shift-Enter',
  shortcutFormatSql: 'Shift-Alt-f',
})

const VALID_NAMED_KEYS = new Map([
  ['enter', 'Enter'],
  ['return', 'Enter'],
  ['tab', 'Tab'],
  ['escape', 'Escape'],
  ['esc', 'Escape'],
  ['backspace', 'Backspace'],
  ['delete', 'Delete'],
  ['del', 'Delete'],
  ['space', 'Space'],
  ['arrowup', 'ArrowUp'],
  ['up', 'ArrowUp'],
  ['arrowdown', 'ArrowDown'],
  ['down', 'ArrowDown'],
  ['arrowleft', 'ArrowLeft'],
  ['left', 'ArrowLeft'],
  ['arrowright', 'ArrowRight'],
  ['right', 'ArrowRight'],
  ['home', 'Home'],
  ['end', 'End'],
  ['pageup', 'PageUp'],
  ['pagedown', 'PageDown'],
  ['insert', 'Insert'],
  ['f1', 'F1'],
  ['f2', 'F2'],
  ['f3', 'F3'],
  ['f4', 'F4'],
  ['f5', 'F5'],
  ['f6', 'F6'],
  ['f7', 'F7'],
  ['f8', 'F8'],
  ['f9', 'F9'],
  ['f10', 'F10'],
  ['f11', 'F11'],
  ['f12', 'F12'],
])

const MODIFIER_ALIASES = new Map([
  ['mod', 'Mod'],
  ['ctrl', 'Ctrl'],
  ['control', 'Ctrl'],
  ['alt', 'Alt'],
  ['option', 'Alt'],
  ['shift', 'Shift'],
  ['cmd', 'Meta'],
  ['command', 'Meta'],
  ['meta', 'Meta'],
  ['win', 'Meta'],
  ['super', 'Meta'],
])

const MOD_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta']

const RESERVED_SHORTCUTS = new Set([
  // Clipboard & basic editing
  'Mod-c',
  'Mod-x',
  'Mod-v',
  'Mod-Shift-v',
  'Ctrl-c',
  'Ctrl-x',
  'Ctrl-v',
  'Ctrl-Shift-v',
  'Meta-c',
  'Meta-x',
  'Meta-v',
  'Ctrl-Insert',
  'Shift-Insert',
  'Shift-Delete',
  'Mod-a',
  'Ctrl-a',
  'Meta-a',
  'Mod-z',
  'Mod-y',
  'Mod-Shift-z',
  'Ctrl-z',
  'Ctrl-y',
  'Ctrl-Shift-z',
  'Meta-z',
  'Meta-Shift-z',
  // System / window / browser / DevTools
  'Mod-w',
  'Ctrl-w',
  'Meta-w',
  'Mod-q',
  'Ctrl-q',
  'Meta-q',
  'Mod-n',
  'Ctrl-n',
  'Meta-n',
  'Mod-t',
  'Ctrl-t',
  'Meta-t',
  'Mod-r',
  'Ctrl-r',
  'Meta-r',
  'Mod-s',
  'Ctrl-s',
  'Meta-s',
  'Mod-p',
  'Ctrl-p',
  'Meta-p',
  'Mod-o',
  'Ctrl-o',
  'Meta-o',
  'Mod-f',
  'Ctrl-f',
  'Meta-f',
  'Mod-h',
  'Ctrl-h',
  'Meta-h',
  'Mod-l',
  'Ctrl-l',
  'Meta-l',
  'Mod-Shift-i',
  'Mod-Shift-j',
  'Mod-Shift-c',
  'Ctrl-Shift-i',
  'Ctrl-Shift-j',
  'Ctrl-Shift-c',
  'Ctrl-Tab',
  'Ctrl-Shift-Tab',
  'Alt-Tab',
  'Alt-Shift-Tab',
  'Alt-F4',
  'Meta-F4',
  'Mod-=',
  'Mod--',
  'Mod-0',
  'Ctrl-=',
  'Ctrl--',
  'Ctrl-0',
  'F11',
  'F12',
  // Bare editor navigation / focus / typing keys
  'Escape',
  'Tab',
  'Shift-Tab',
  'Enter',
  'Shift-Enter',
  'Backspace',
  'Delete',
  'Space',
])

const ALLOWED_BARE_FUNCTION_KEYS = new Set([
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
])

function splitShortcutTokens(raw) {
  const parts = []
  let i = 0
  while (i < raw.length) {
    const dashIdx = raw.indexOf('-', i)
    if (dashIdx === -1) {
      parts.push(raw.slice(i))
      break
    }
    if (dashIdx === raw.length - 1) {
      // Trailing '-' as the key itself (e.g. 'Mod--')
      if (dashIdx > i) {
        parts.push(raw.slice(i, dashIdx))
      }
      parts.push('-')
      break
    }
    const token = raw.slice(i, dashIdx)
    if (!token) {
      return null
    }
    parts.push(token)
    i = dashIdx + 1
  }
  return parts
}

/**
 * Parses a CodeMirror 6 shortcut string (e.g. 'Mod-Enter', 'Shift-Alt-f', 'F5')
 * into canonical modifier/key form without evaluating code.
 */
export function parseShortcutBinding(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'Shortcut must be a non-empty string' }
  }
  const trimmed = raw.trim()
  if (!trimmed || /\s/.test(trimmed)) {
    return { ok: false, reason: 'Shortcut cannot be empty or contain whitespace' }
  }
  const parts = splitShortcutTokens(trimmed)
  if (!parts || parts.length === 0) {
    return { ok: false, reason: 'Invalid shortcut format' }
  }

  const rawKey = parts[parts.length - 1]
  const modSet = new Set()
  for (let idx = 0; idx < parts.length - 1; idx++) {
    const mod = MODIFIER_ALIASES.get(parts[idx].toLowerCase())
    if (!mod) {
      return { ok: false, reason: `Unknown modifier: ${parts[idx]}` }
    }
    if (modSet.has(mod)) {
      return { ok: false, reason: `Duplicate modifier: ${mod}` }
    }
    modSet.add(mod)
  }

  let key = VALID_NAMED_KEYS.get(rawKey.toLowerCase()) ?? ''
  if (!key) {
    if (rawKey.length === 1 && /^[\x21-\x7e]$/.test(rawKey)) {
      key = /[A-Z]/.test(rawKey) ? rawKey.toLowerCase() : rawKey
    } else {
      return { ok: false, reason: `Invalid key name: ${rawKey}` }
    }
  }

  const mods = MOD_ORDER.filter((m) => modSet.has(m))
  const canonical = mods.length > 0 ? `${mods.join('-')}-${key}` : key
  return { ok: true, canonical, key, mods }
}

/**
 * Validates a shortcut binding against system, clipboard, typing, and Windows AltGr (Ctrl+Alt) guards.
 */
export function validateShortcutBinding(raw) {
  const parsed = parseShortcutBinding(raw)
  if (!parsed.ok) {
    return parsed
  }

  const { canonical, key, mods } = parsed
  const hasMod = mods.includes('Mod')
  const hasCtrl = mods.includes('Ctrl')
  const hasAlt = mods.includes('Alt')
  const hasShift = mods.includes('Shift')
  const hasMeta = mods.includes('Meta')

  // Windows AltGr guard: Ctrl+Alt (and Mod+Alt on Windows/Linux where Mod === Ctrl) hijacks AltGr typing
  if (hasAlt && (hasCtrl || hasMod)) {
    return {
      ok: false,
      reason: 'Ctrl+Alt / Mod+Alt combinations are reserved for Windows AltGr input',
    }
  }

  if (RESERVED_SHORTCUTS.has(canonical)) {
    return { ok: false, reason: `Reserved system or clipboard shortcut: ${canonical}` }
  }

  // Require at least one non-Shift modifier unless it is an allowed bare function key (F1..F10)
  if (mods.length === 0) {
    if (!ALLOWED_BARE_FUNCTION_KEYS.has(key)) {
      return { ok: false, reason: `Unmodified key "${key}" cannot be used as a command shortcut` }
    }
    return { ok: true, canonical, key, mods }
  }

  if (hasShift && !hasMod && !hasCtrl && !hasAlt && !hasMeta) {
    if (!ALLOWED_BARE_FUNCTION_KEYS.has(key)) {
      return { ok: false, reason: `Shift-only shortcut "${canonical}" conflicts with typing/navigation` }
    }
  }

  return { ok: true, canonical, key, mods }
}

function detectIsMacPlatform(options) {
  const explicit = options?.platform
  if (typeof explicit === 'string' && explicit.length > 0) {
    return /Mac|Darwin|iPhone|iPad|iPod/i.test(explicit)
  }
  if (typeof navigator !== 'undefined' && typeof navigator.platform === 'string' && navigator.platform) {
    return /Mac|iPhone|iPad|iPod/i.test(navigator.platform)
  }
  if (typeof globalThis !== 'undefined' && globalThis.process?.platform) {
    return globalThis.process.platform === 'darwin'
  }
  return false
}

function toPlatformConflictKey(shortcut, isMac) {
  const parsed = parseShortcutBinding(shortcut)
  if (!parsed.ok) return String(shortcut || '')
  const modSet = new Set(
    parsed.mods.map((m) => (m === 'Mod' ? (isMac ? 'Meta' : 'Ctrl') : m))
  )
  const mods = MOD_ORDER.filter((m) => modSet.has(m))
  return mods.length > 0 ? `${mods.join('-')}-${parsed.key}` : parsed.key
}

/**
 * Normalizes editorKeymap and SQL command shortcut settings with safe default fallbacks.
 */
export function normalizeShortcutSettings(raw = {}, options = {}) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const editorKeymap = source.editorKeymap === 'vim' ? 'vim' : 'default'
  const isMac = detectIsMacPlatform(options)
  const usedConflictKeys = new Set()

  const pickNonConflicting = (candidate, fallbackCandidates) => {
    const res = validateShortcutBinding(candidate)
    if (res.ok) {
      const conflictKey = toPlatformConflictKey(res.canonical, isMac)
      if (!usedConflictKeys.has(conflictKey)) {
        usedConflictKeys.add(conflictKey)
        return res.canonical
      }
    }
    for (const fb of fallbackCandidates) {
      const fbKey = toPlatformConflictKey(fb, isMac)
      if (!usedConflictKeys.has(fbKey)) {
        usedConflictKeys.add(fbKey)
        return fb
      }
    }
    return fallbackCandidates[0]
  }

  const shortcutRunStatement = pickNonConflicting(source.shortcutRunStatement, [
    DEFAULT_EDITOR_KEYMAP_SETTINGS.shortcutRunStatement,
    'F5',
    'F7',
    'F8',
  ])
  const shortcutRunAll = pickNonConflicting(source.shortcutRunAll, [
    DEFAULT_EDITOR_KEYMAP_SETTINGS.shortcutRunAll,
    'F6',
    'F7',
    'F8',
  ])
  const shortcutFormatSql = pickNonConflicting(source.shortcutFormatSql, [
    DEFAULT_EDITOR_KEYMAP_SETTINGS.shortcutFormatSql,
    'F7',
    'F8',
    'F9',
  ])

  return {
    editorKeymap,
    shortcutRunStatement,
    shortcutRunAll,
    shortcutFormatSql,
  }
}

const DEFAULT_VIM_MODE_SNAPSHOT = Object.freeze({
  preset: 'default',
  mode: 'default',
  badge: '',
  isInsert: true,
  isVisual: false,
  isModalNonInsert: false,
})

function snapshotsEqual(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.preset === b.preset &&
    a.mode === b.mode &&
    a.badge === b.badge &&
    a.isInsert === b.isInsert &&
    a.isVisual === b.isVisual &&
    a.isModalNonInsert === b.isModalNonInsert
  )
}

export const setVimModeEffect = StateEffect.define()

export const vimModeStateField = StateField.define({
  create() {
    return DEFAULT_VIM_MODE_SNAPSHOT
  },
  update(value, tr) {
    let next = value
    for (const eff of tr.effects) {
      if (eff.is(setVimModeEffect) && eff.value) {
        next = eff.value
      }
    }
    return next
  },
})

function computeLiveVimSnapshot(view) {
  if (!view) return null
  const cm = getCM(view)
  const v = cm?.state?.vim
  if (!v) return null

  if (v.insertMode) {
    if (cm.state.overwrite) {
      return {
        preset: 'vim',
        mode: 'replace',
        badge: 'REPLACE',
        isInsert: false,
        isVisual: false,
        isModalNonInsert: true,
      }
    }
    return {
      preset: 'vim',
      mode: 'insert',
      badge: 'INSERT',
      isInsert: true,
      isVisual: false,
      isModalNonInsert: false,
    }
  }
  if (v.visualBlock) {
    return {
      preset: 'vim',
      mode: 'visual-block',
      badge: 'VISUAL BLOCK',
      isInsert: false,
      isVisual: true,
      isModalNonInsert: true,
    }
  }
  if (v.visualLine) {
    return {
      preset: 'vim',
      mode: 'visual-line',
      badge: 'VISUAL LINE',
      isInsert: false,
      isVisual: true,
      isModalNonInsert: true,
    }
  }
  if (v.visualMode) {
    return {
      preset: 'vim',
      mode: 'visual',
      badge: 'VISUAL',
      isInsert: false,
      isVisual: true,
      isModalNonInsert: true,
    }
  }
  return {
    preset: 'vim',
    mode: 'normal',
    badge: 'NORMAL',
    isInsert: false,
    isVisual: false,
    isModalNonInsert: true,
  }
}

/**
 * Returns the live Vim mode snapshot for an EditorView (never stale: reads getCM(view).state.vim first,
 * falling back to vimModeStateField when CM5 adapter is absent).
 */
export function getVimModeSnapshot(view) {
  const live = computeLiveVimSnapshot(view)
  if (live) return live
  const stored = view?.state?.field?.(vimModeStateField, false)
  return stored ?? DEFAULT_VIM_MODE_SNAPSHOT
}

const activeModalNonInsertChecks = new WeakSet()

/**
 * Live modal predicate: returns true when Vim (or a registered modal predicate) is active
 * and currently in a non-insert mode (Normal, Visual, Visual-Line, Visual-Block, or Replace).
 */
export function isModalNonInsertMode(view) {
  if (!view) return false
  const live = computeLiveVimSnapshot(view)
  if (live) return live.isModalNonInsert
  const stored = view.state?.field?.(vimModeStateField, false)
  if (activeModalNonInsertChecks.has(view)) {
    return Boolean(stored?.isModalNonInsert)
  }
  const customPred = view.state?.field?.(cmModalKeymapField, false)
  if (typeof customPred === 'function' && customPred !== isModalNonInsertMode) {
    activeModalNonInsertChecks.add(view)
    try {
      return Boolean(customPred(view))
    } finally {
      activeModalNonInsertChecks.delete(view)
    }
  }
  return Boolean(stored?.isModalNonInsert)
}

/**
 * Returns true if the view currently uses a modal keymap preset (even while in Insert mode).
 */
export function isModalKeymapActive(view) {
  if (!view) return false
  if (getCM(view)?.state?.vim) return true
  const stored = view.state?.field?.(vimModeStateField, false)
  return stored?.preset === 'vim'
}

export const cmModalKeymapField = StateField.define({
  create() {
    return isModalNonInsertMode
  },
  update(value) {
    return value
  },
})

// Facet-like extension provider backed by StateField (vendor/codemirror.js does not re-export Facet)
export const cmModalKeymapFacet = Object.freeze({
  of(predicate) {
    return cmModalKeymapField.init(() => predicate)
  },
})

function createVimModeSyncPlugin(onVimModeChange) {
  return ViewPlugin.fromClass(
    class VimModeSyncPlugin {
      constructor(view) {
        this.view = view
        this.destroyed = false
        this.cm = getCM(view)
        this.lastEmitted = null
        this._syncScheduled = false
        this._onModeChange = () => {
          this.syncNow()
        }
        if (this.cm && typeof this.cm.on === 'function') {
          this.cm.on('vim-mode-change', this._onModeChange)
        }
        this.syncNow()
      }

      syncNow() {
        if (this.destroyed) return
        const snap = getVimModeSnapshot(this.view)
        if (!snapshotsEqual(this.lastEmitted, snap)) {
          this.lastEmitted = snap
          onVimModeChange?.(snap)
        }
        const stored = this.view.state.field(vimModeStateField, false)
        if (!snapshotsEqual(stored, snap) && !this._syncScheduled) {
          this._syncScheduled = true
          queueMicrotask(() => {
            this._syncScheduled = false
            if (this.destroyed) return
            const latest = getVimModeSnapshot(this.view)
            const curStored = this.view.state.field(vimModeStateField, false)
            if (!snapshotsEqual(curStored, latest)) {
              this.view.dispatch({ effects: setVimModeEffect.of(latest) })
            }
          })
        }
      }

      update() {
        const currentCm = getCM(this.view)
        if (currentCm !== this.cm) {
          if (this.cm && typeof this.cm.off === 'function') {
            this.cm.off('vim-mode-change', this._onModeChange)
          }
          this.cm = currentCm
          if (this.cm && typeof this.cm.on === 'function') {
            this.cm.on('vim-mode-change', this._onModeChange)
          }
        }
        this.syncNow()
      }

      destroy() {
        this.destroyed = true
        if (this.cm && typeof this.cm.off === 'function') {
          this.cm.off('vim-mode-change', this._onModeChange)
        }
        this.cm = null
      }
    }
  )
}

/**
 * Builds the CodeMirror 6 keymap + optional Vim extension with Prec.highest SQL action bindings
 * and live Vim mode state tracking.
 */
export function createCmKeymapExtension(options = {}) {
  const normalized = normalizeShortcutSettings({
    editorKeymap: options.keymapPreset ?? options.editorKeymap,
    shortcutRunStatement: options.shortcutRunStatement,
    shortcutRunAll: options.shortcutRunAll,
    shortcutFormatSql: options.shortcutFormatSql,
  })

  const bindings = []
  if (typeof options.onRunAll === 'function') {
    bindings.push({
      key: normalized.shortcutRunAll,
      run: (view) => Boolean(options.onRunAll(view)),
    })
  }
  if (typeof options.onRunStatement === 'function') {
    bindings.push({
      key: normalized.shortcutRunStatement,
      run: (view) => Boolean(options.onRunStatement(view)),
    })
  }
  if (typeof options.onFormatSql === 'function') {
    bindings.push({
      key: normalized.shortcutFormatSql,
      run: (view) => Boolean(options.onFormatSql(view)),
    })
  }
  if (Array.isArray(options.extraBindings)) {
    for (const extra of options.extraBindings) {
      if (extra && typeof extra.key === 'string' && typeof extra.run === 'function') {
        bindings.push(extra)
      }
    }
  }

  const isVim = normalized.editorKeymap === 'vim'
  const initialSnap = isVim
    ? {
        preset: 'vim',
        mode: 'normal',
        badge: 'NORMAL',
        isInsert: false,
        isVisual: false,
        isModalNonInsert: true,
      }
    : DEFAULT_VIM_MODE_SNAPSHOT

  const extensions = [
    vimModeStateField.init(() => initialSnap),
    cmModalKeymapFacet.of(isVim ? isModalNonInsertMode : () => false),
  ]

  if (bindings.length > 0) {
    extensions.push(Prec.highest(keymap.of(bindings)))
  }

  if (isVim) {
    extensions.push(
      vim({ status: Boolean(options.showVimPanel) }),
      createVimModeSyncPlugin(options.onVimModeChange)
    )
  }

  return extensions
}
