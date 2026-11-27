import type { EditorState, EditorView, Extension, StateEffect, StateField } from '../vendor/codemirror.js'
import type { AiInlineEdit, AiMetricKind } from './protocol.js'

export interface GhostEditHunk {
  from: number
  to: number
  insert: string
}

export interface GhostSuggestionState {
  offset: number
  text: string
  id: number
  replaceChars?: number
  edits?: GhostEditHunk[]
  mode?: 'complete' | 'edit'
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
  offered: { offset: number; text: string; replaceChars?: number; edits?: GhostEditHunk[] } | null | undefined,
  cursorOffset: number,
  typed: string
): string | null

export function shouldSkipInlineTrigger(prefix: string, suffix: string, dialect?: string): boolean

export function resolveDocEdits(
  rawEdits: readonly AiInlineEdit[] | undefined | null,
  cursorOffset: number,
  docLength: number
): GhostEditHunk[] | null

export function computePostApplyCursor(
  edits: readonly GhostEditHunk[],
  originalOffset: number,
  newDocLength: number
): number

export const AI_MAX_IPC_PREFIX_CHARS: 8000
export const AI_MAX_IPC_SUFFIX_CHARS: 4000

export function trackAcceptance(
  model: TrackedTextModel,
  accepted: { startOffset?: number; text?: string; ranges?: Array<{ startOffset: number; text: string }> },
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

export const notifyAiAvailabilityEffect: {
  of(value?: undefined): StateEffect<undefined>
}

export function notifyAiAvailabilityChanged(view: EditorView | null | undefined): void

export function isActiveSqlStatementSensitive(
  prefix: string,
  suffix: string,
  dialect?: string,
  mode?: 'auto' | 'complete' | 'edit'
): boolean

export const ghostStateField: StateField<GhostSuggestionState | null>

export function acceptGhostFull(view: EditorView): boolean
export function acceptGhostWord(view: EditorView): boolean
export function acceptGhostLine(view: EditorView): boolean

export interface CmInlineAiRequestErrorContext {
  mode: 'complete' | 'edit'
  manual: boolean
  prefix: string
  suffix: string
  dialect: string | undefined
  connectionId: string | null | undefined
}

export interface CmInlineAiOptions {
  isEnabled: () => boolean
  getDialect?: () => string
  getConnectionId?: () => string | null | undefined
  connectionId?: string | null
  isModalMode?: (view: EditorView) => boolean
  isModalKeymap?: (view: EditorView) => boolean
  requestCompletion: (input: {
    prefix: string
    suffix: string
    offset: number
    signal: AbortSignal
    manual?: boolean
    mode?: 'auto' | 'complete' | 'edit'
  }) => Promise<{
    suggestion: string
    id: number
    replaceChars?: number
    edits?: AiInlineEdit[]
    mode?: 'complete' | 'edit'
  } | null>
  onMetric?: (id: number, kind: AiMetricKind) => void
  onRequestError?: (err: unknown, context?: CmInlineAiRequestErrorContext) => void
}

export function createCmInlineAiExtension(options: CmInlineAiOptions): Extension
