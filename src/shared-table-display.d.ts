import type {
  ConditionalHighlightOperator,
  ConditionalHighlightRule,
  ConditionalHighlightTone,
  TableDisplayStateEntry,
} from './protocol.js'

export const MAX_HIGHLIGHT_RULES_PER_TABLE: 20
export const MAX_REGEX_SUBJECT_CHARS: 10000
export const MAX_REGEX_PATTERN_CHARS: 512
export const PINNED_VIEWPORT_MAX_RATIO: number
export const MIN_COLUMN_WIDTH_PX: 48
export const MAX_COLUMN_WIDTH_PX: 2000
export const DEFAULT_PINNED_COLUMN_WIDTH_PX: 140
export const DEFAULT_ROW_NUM_WIDTH_PX: 44

export const HIGHLIGHT_TONES: readonly ConditionalHighlightTone[]

export const HIGHLIGHT_CSS_CLASSES: Readonly<Record<ConditionalHighlightTone, string>>

export const CONDITIONAL_HIGHLIGHT_OPERATORS: readonly ConditionalHighlightOperator[]

export interface ParsedOccurrenceColumnKey {
  occurrence: number
  name: string
}

export interface ColumnKeyResolver {
  occKeys: string[]
  occKeySet: Set<string>
  indexByKey: Map<string, number>
  canonicalByKey: Map<string, string>
  nameCounts: Map<string, number>
  resolveKey(rawKey: string): string | null
  resolveIndex(rawKey: string): number
}

export interface EffectiveColumnLayout {
  columnKeys: string[]
  orderedKeys: string[]
  visibleKeys: string[]
  pinnedKeys: string[]
  unpinnedKeys: string[]
  displayKeys: string[]
  hiddenSet: Set<string>
  widthsByKey: Record<string, number>
}

export interface SetColumnVisibilityResult {
  entry: TableDisplayStateEntry | null
  changed: boolean
  blockedReason?: 'at_least_one_visible'
}

export interface PinnedColumnsViewportCapInput {
  pinnedKeys: readonly string[]
  widthsByKey?: Readonly<Record<string, number>>
  viewportWidthPx: number
  rowNumWidthPx?: number
  defaultColWidthPx?: number
  maxRatio?: number
}

export interface PinnedColumnsViewportCapResult {
  maxPinnedWidthPx: number
  activePinnedKeys: string[]
  overflowPinnedKeys: string[]
  stickyLeftByKey: Record<string, number>
  totalPinnedWidthPx: number
  capped: boolean
}

export interface FocusedCellScrollInput {
  cellLeftPx: number
  cellWidthPx: number
  scrollLeftPx: number
  viewportWidthPx: number
  totalPinnedWidthPx: number
}

export type CellHighlightValueState = 'Unavailable' | 'Null' | 'NonText' | 'Text'

export interface ClassifiedCellValue {
  state: CellHighlightValueState
  text: string
}

export interface RegexValidationResult {
  valid: boolean
  reason?: string
  regex?: RegExp
}

export interface EvaluatedRowHighlight {
  rowTone: ConditionalHighlightTone | null
  rowClass: string | null
  cellTonesByKey: Record<string, ConditionalHighlightTone>
  cellClassesByKey: Record<string, string>
}

export interface ResolvedCellDisplayHighlight {
  className: string | null
  source: 'selection' | 'cell' | 'row' | 'none'
  tone: ConditionalHighlightTone | null
}

export interface HighlightEvaluatorStats {
  hits: number
  misses: number
  regexCacheSize: number
}

export interface HighlightEvaluator {
  evaluateRow(params: {
    row: Record<string, unknown> | readonly unknown[]
    columns: readonly string[]
    rules: readonly ConditionalHighlightRule[]
    rowKey?: string | number
    rowRevision?: string | number
  }): EvaluatedRowHighlight
  clear(): void
  getStats(): HighlightEvaluatorStats
}

export function buildOccurrenceColumnKeys(headers: readonly string[]): string[]

export function buildColumnKeyResolver(headers: readonly string[]): ColumnKeyResolver

export function parseOccurrenceColumnKey(key: string): ParsedOccurrenceColumnKey | null

export function resolveColumnKey(headers: readonly string[], rawKey: string): string | null

export function resolveColumnIndexByKey(headers: readonly string[], rawKey: string): number

export function isSensitiveHighlightColumnName(columnKey: string): boolean

export function scrubSensitiveTableFilterText(raw: string): string

export function sanitizeHighlightRule(raw: unknown): ConditionalHighlightRule | null

export function sanitizeColumnWidths(rawWidths: unknown): Record<string, number>

export function scrubSensitiveTableDisplayEntry(raw: unknown): TableDisplayStateEntry | null

export function normalizeTableDisplayStateEntry(raw: unknown): TableDisplayStateEntry | null

export function isEmptyDefaultTableDisplayEntry(entry: unknown): boolean

export function areHighlightRulesEqual(
  a: readonly ConditionalHighlightRule[] | null | undefined,
  b: readonly ConditionalHighlightRule[] | null | undefined
): boolean

export function areTableDisplayStateEntriesEquivalent(
  a: TableDisplayStateEntry | null | undefined,
  b: TableDisplayStateEntry | null | undefined
): boolean

export function rebaseTableDisplayStateEntry(
  baseEntry: TableDisplayStateEntry | null | undefined,
  localEntry: TableDisplayStateEntry | null | undefined,
  remoteEntry: TableDisplayStateEntry | null | undefined
): TableDisplayStateEntry | null

export function resolveEffectiveColumnLayout(params: {
  headers: readonly string[]
  entry?: TableDisplayStateEntry | null
  defaultWidthsByKey?: Readonly<Record<string, number>>
}): EffectiveColumnLayout

export function setColumnVisibilityInEntry(
  entry: TableDisplayStateEntry | null | undefined,
  columnKey: string,
  visible: boolean,
  headers: readonly string[]
): SetColumnVisibilityResult

export function reorderColumnInEntry(
  entry: TableDisplayStateEntry | null | undefined,
  fromKey: string,
  toKey: string,
  placement: 'before' | 'after',
  headers: readonly string[]
): TableDisplayStateEntry | null

export function setUserColumnWidthInEntry(
  entry: TableDisplayStateEntry | null | undefined,
  columnKey: string,
  widthPx: number | null | undefined
): TableDisplayStateEntry | null

export function computePinnedColumnsViewportCap(
  input: PinnedColumnsViewportCapInput
): PinnedColumnsViewportCapResult

export function computeScrollLeftForFocusedCell(input: FocusedCellScrollInput): number

export function classifyCellValue(raw: unknown): ClassifiedCellValue

export function compareExactDecimal(a: unknown, b: unknown): -1 | 0 | 1 | null

export function matchSqlLike(subject: string, pattern: string, caseSensitive?: boolean): boolean

export function validateHighlightRegex(pattern: string, flags?: string): RegexValidationResult

export function getHighlightClassName(tone: ConditionalHighlightTone): string | null

export function evaluateHighlightRule(rule: ConditionalHighlightRule, rawValue: unknown): boolean

export function evaluateRowHighlights(params: {
  row: Record<string, unknown> | readonly unknown[]
  columns: readonly string[]
  rules: readonly ConditionalHighlightRule[]
}): EvaluatedRowHighlight

export function resolveCellDisplayHighlight(params: {
  isSelected: boolean
  rowTone: ConditionalHighlightTone | null | undefined
  cellTone: ConditionalHighlightTone | null | undefined
  isZebra?: boolean
}): ResolvedCellDisplayHighlight

export function createHighlightEvaluator(maxCachedRowsPerRuleset?: number): HighlightEvaluator
