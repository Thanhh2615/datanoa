import type { EditorView, Extension, StateEffect, StateField } from '../vendor/codemirror.js'

export type EditorKeymapPreset = 'default' | 'vim'

export type VimModeKind =
  | 'default'
  | 'normal'
  | 'insert'
  | 'visual'
  | 'visual-line'
  | 'visual-block'
  | 'replace'

export interface VimModeSnapshot {
  preset: EditorKeymapPreset
  mode: VimModeKind
  badge: string
  isInsert: boolean
  isVisual: boolean
  isModalNonInsert: boolean
}

export interface EditorKeymapSettings {
  editorKeymap: EditorKeymapPreset
  shortcutRunStatement: string
  shortcutRunAll: string
  shortcutFormatSql: string
}

export interface ShortcutParseResult {
  ok: boolean
  canonical?: string
  key?: string
  mods?: string[]
  reason?: string
}

export interface CmKeymapExtraBinding {
  key: string
  run: (view: EditorView) => boolean
}

export interface CmKeymapExtensionOptions {
  keymapPreset?: EditorKeymapPreset
  editorKeymap?: EditorKeymapPreset
  shortcutRunStatement?: string
  shortcutRunAll?: string
  shortcutFormatSql?: string
  onRunStatement?: (view: EditorView) => boolean | void
  onRunAll?: (view: EditorView) => boolean | void
  onFormatSql?: (view: EditorView) => boolean | void
  onVimModeChange?: (snapshot: VimModeSnapshot) => void
  showVimPanel?: boolean
  extraBindings?: readonly CmKeymapExtraBinding[]
}

export const DEFAULT_EDITOR_KEYMAP_SETTINGS: Readonly<EditorKeymapSettings>

export declare function parseShortcutBinding(raw: string): ShortcutParseResult
export declare function validateShortcutBinding(raw: string): ShortcutParseResult
export declare function normalizeShortcutSettings(
  raw?: Partial<EditorKeymapSettings> | null,
  options?: { platform?: string }
): EditorKeymapSettings

export const setVimModeEffect: {
  of(value: VimModeSnapshot): StateEffect<VimModeSnapshot>
}

export const vimModeStateField: StateField<VimModeSnapshot>
export const cmModalKeymapField: StateField<(view: EditorView) => boolean>
export const cmModalKeymapFacet: {
  of(predicate: (view: EditorView) => boolean): Extension
}

export declare function getVimModeSnapshot(view: EditorView | null | undefined): VimModeSnapshot
export declare function isModalNonInsertMode(view: EditorView | null | undefined): boolean
export declare function isModalKeymapActive(view: EditorView | null | undefined): boolean
export declare function createCmKeymapExtension(options?: CmKeymapExtensionOptions): Extension
