import type {
  AiExplainAnalysisResult,
  AiExplainLanguage,
  AiFixQueryResult,
  AiPresetId,
  AiProviderFormat,
  AiRole,
  AiRoleStatus,
  AiStatusSnapshot,
  AiStatusState,
} from './protocol.js'

export type AiStatusBadgeTone = 'neutral' | 'success' | 'warn' | 'danger'

export interface AiExplainLanguageOption {
  value: AiExplainLanguage
  label: string
}

export interface AiPresetOption {
  id: AiPresetId
  label: string
  format: AiProviderFormat
  baseUrl: string
  model: string
  keyKind: 'required' | 'optional' | 'none'
  keyPlaceholder: string
  editableUrl: boolean
}

export const AI_EXPLAIN_LANGUAGE_OPTIONS: readonly AiExplainLanguageOption[]
export const AI_PRESET_OPTIONS: readonly AiPresetOption[]

export function resolveAiPresetId(format: AiProviderFormat, baseUrl: string): AiPresetId
export function isLoopbackHostname(rawHost: string): boolean
export function isLikelyFimOnlyModel(format: AiProviderFormat, model: string): boolean

export interface AiStatusBadge {
  tone: AiStatusBadgeTone
  label: string
  title: string
  autocompleteTone: AiStatusBadgeTone
  explainTone: AiStatusBadgeTone
  autocompleteState: AiStatusState
  explainState: AiStatusState
}

export type AiRoleStatusSnapshot = AiRoleStatus

export function formatAiStatusBadge(snapshot: AiStatusSnapshot | null | undefined): AiStatusBadge

export function renderAiStatusButtonContent(
  buttonEl: HTMLElement | null | undefined,
  snapshot: AiStatusSnapshot | null | undefined
): AiStatusBadge

export type AiPanelResizeEdge = 'top' | 'bottom'
export type ExplainAiVisiblePhase = 'loading' | 'error' | 'ready' | 'idle'

export function resolveExplainAiPhase(
  isLoading: boolean,
  error: string | null | undefined,
  analysis: AiExplainAnalysisResult | null | undefined
): ExplainAiVisiblePhase

export function getAiPanelMaxHeight(
  container?: HTMLElement | null,
  edge?: AiPanelResizeEdge
): number

export interface ExplainAiPanelState {
  phase: 'hidden' | 'idle' | 'loading' | 'ready' | 'error'
  aiEnabled: boolean
  aiReady: boolean
  explainLanguage: AiExplainLanguage
  dialect?: string
  destination?: 'none' | 'local' | 'remote'
  host?: string
  result?: AiExplainAnalysisResult | null
  error?: string | null
  collapsed?: boolean
}

export interface ExplainAiPanelCallbacks {
  onAnalyze: () => void
  onChangeExplainLanguage?: (lang: AiExplainLanguage) => void
  onConfigureAi: () => void
  onCancel: () => void
  onApplySql: (sql: string) => void
  onOpenNewTab: (sql: string) => void
  onCopyText: (text: string, label?: string) => void
  onToggleCollapsed: () => void
  resizeEdge?: AiPanelResizeEdge
  onResize?: () => void
}

export function renderSharedExplainAiPanel(
  container: HTMLElement | null,
  state: ExplainAiPanelState,
  callbacks: ExplainAiPanelCallbacks
): void

export interface AiFixPanelState {
  phase: 'hidden' | 'loading' | 'ready' | 'error'
  aiEnabled: boolean
  aiReady: boolean
  dialect?: string
  destination?: 'none' | 'local' | 'remote'
  host?: string
  result?: AiFixQueryResult | null
  error?: string | null
}

export interface AiFixPanelCallbacks {
  onReplaceQuery: (sql: string) => void
  onCopySql: (sql: string) => void
  onRetry: () => void
  onCancel: () => void
  onDismiss: () => void
  onConfigureAi: () => void
  resizeEdge?: AiPanelResizeEdge
  onResize?: () => void
}

export function renderSharedAiFixPanel(
  container: HTMLElement | null,
  state: AiFixPanelState,
  callbacks: AiFixPanelCallbacks
): void

export interface SaveOrcaSettingsPatchOptions {
  forceKeys?: Iterable<string>
}

export interface OpenSharedAiConfigModalOptions {
  rpc: <T = unknown>(name: string, input?: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<T>
  saveSettings: (patch: Record<string, unknown>, options?: SaveOrcaSettingsPatchOptions) => Promise<void>
  initialStatus?: AiStatusSnapshot | null
  initialRole?: AiRole
  onStatusUpdated?: (snapshot: AiStatusSnapshot) => void
  mountModal?: (modalEl: HTMLElement, canClose?: () => boolean, onDismiss?: () => void) => HTMLElement | null
  closeModal?: () => void
}

export function openSharedAiConfigModal(options: OpenSharedAiConfigModalOptions): Promise<void>
export function saveOrcaSettingsPatch(
  patch: Record<string, unknown>,
  options?: SaveOrcaSettingsPatchOptions
): Promise<void>
