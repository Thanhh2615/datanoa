import type { ExplainSeverity, ParsedExplainPlan } from './protocol'
import type { ExplainParserOptions, ExplainParserFn, StrictXmlElement } from './shared-explain-parsers'

export declare const EXPLAIN_IPC_TARGET_BYTES: number
export declare const EXPLAIN_IPC_HARD_CAP_BYTES: number

export declare const EXPLAIN_SIGNIFICANT_ZERO_KEYS: readonly [
  'Workers Launched',
  'Actual Rows',
  'Actual Loops',
  'Heap Fetches',
]

export declare const ExplainPlanParserRegistry: {
  register: (id: string, parserFn: ExplainParserFn) => void
  get: (id: string) => ExplainParserFn | null
  listIds: () => string[]
  parse: (input: unknown, options?: ExplainParserOptions) => ParsedExplainPlan
}

export declare function parseXmlStrict(
  xml: string,
  options?: { maxDepth?: number }
): { root: StrictXmlElement | null }

export declare function utf8ByteLength(str: string): number
export declare function computeExplainPlanMetrics(plan: ParsedExplainPlan): ParsedExplainPlan

export interface ExplainBarMetricItem {
  id: string
  costBarRatio: number
  costBarMinPx: number
  timeBarRatio: number
  timeBarMinPx: number
  rowsBarRatio: number
  rowsBarMinPx: number
  rowsTone: 'neutral'
  severity: ExplainSeverity
}

export declare function computeExplainBarMetrics(plan: ParsedExplainPlan): ExplainBarMetricItem[]

export declare function compactExplainPlanForIpc(
  plan: ParsedExplainPlan,
  options?: { targetBytes?: number; hardCapBytes?: number }
): ParsedExplainPlan

export declare function parseExplainPlan(
  input: unknown,
  options?: ExplainParserOptions
): ParsedExplainPlan
