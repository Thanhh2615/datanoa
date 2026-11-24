import type { EditorState, EditorView, Extension, StateEffect, StateField } from '../vendor/codemirror.js'
import type { AiMetricKind } from './protocol.js'

export interface GhostSuggestionState {
  offset: number
  text: string
  id: number
  replaceChars?: number
}

export interface TrackedTextModel {
  getText(): string
  trackRange(start: number, end: number): string
  getTrackedText(id: string): string | null
  untrackRange(id: string): void
}

export interface PacerContext {
  triggerChar?: string
  isLineEnd?: boolean
  estimatedLatencyMs?: number
}

export class Pacer {
  baseMs: number
  noteAccepted(now?: number): void
  noteKey(now?: number): void
  noteChange(deleted: boolean, now?: number): void
  pause(now?: number): number
  delayFor(context?: PacerContext): number
  delayMs(context?: PacerContext): number
}

export function remainder(
  offered: { offset: number; text: string; replaceChars?: number } | null | undefined,
  cursorOffset: number,
  typed: string
): string | null

export function shouldSkipInlineTrigger(prefix: string, suffix: string): boolean

export const AI_MAX_IPC_PREFIX_CHARS: 8000
export const AI_MAX_IPC_SUFFIX_CHARS: 4000

export function trackAcceptance(
  model: TrackedTextModel,
  accepted: { startOffset: number; text: string },
  report: (verdict: 'kept' | 'undone') => void,
  schedule?: (cb: () => void, ms: number) => unknown,
  unschedule?: (handle: unknown) => void
): () => void

export const setGhostEffect: {
  of(value: GhostSuggestionState): StateEffect<GhostSuggestionState>
}

export const clearGhostEffect: {
  of(value?: undefined): StateEffect<undefined>
}

export const ghostStateField: StateField<GhostSuggestionState | null>

export function acceptGhostFull(view: EditorView): boolean
export function acceptGhostWord(view: EditorView): boolean
export function acceptGhostLine(view: EditorView): boolean

export interface CmInlineAiOptions {
  isEnabled: () => boolean
  requestCompletion: (input: {
    prefix: string
    suffix: string
    offset: number
    signal: AbortSignal
    manual?: boolean
  }) => Promise<{ suggestion: string; id: number; replaceChars?: number } | null>
  onMetric?: (id: number, kind: AiMetricKind) => void
}

export function createCmInlineAiExtension(options: CmInlineAiOptions): Extension
