import type { DatabaseDriverType, ParsedExplainPlan } from './protocol'

export interface ExplainParserOptions {
  dialect?: DatabaseDriverType
  format?: string
}

export interface StrictXmlElement {
  name: string
  attrs: Record<string, string>
  children: StrictXmlElement[]
  text: string
}

export type ExplainParserFn = (
  input: unknown,
  options?: ExplainParserOptions
) => ParsedExplainPlan | null

export declare const EXPLAIN_SIGNIFICANT_ZERO_KEYS: readonly [
  'Workers Launched',
  'Actual Rows',
  'Actual Loops',
  'Heap Fetches',
]

export declare function getReportedNodeTotals(
  node: object
): { totalActualRows?: number; totalActualTimeMs?: number } | null

export declare function parseXmlStrict(
  xml: string,
  options?: { maxDepth?: number }
): { root: StrictXmlElement | null }

export declare const ExplainPlanParserRegistry: {
  register: (id: string, parserFn: ExplainParserFn) => void
  get: (id: string) => ExplainParserFn | null
  listIds: () => string[]
  parse: (input: unknown, options?: ExplainParserOptions) => ParsedExplainPlan
}

export declare function parsePostgresJsonExplain(input: unknown): ParsedExplainPlan | null
export declare function parseMysqlCompositeExplain(
  input: unknown,
  dialect?: DatabaseDriverType
): ParsedExplainPlan | null
export declare function parseSqliteEqpExplain(input: unknown): ParsedExplainPlan | null
export declare function parseCockroachTextExplain(input: unknown): ParsedExplainPlan | null
export declare function parseOraclePlanRowsExplain(input: unknown): ParsedExplainPlan | null
export declare function parseOracleXplanExplain(input: unknown): ParsedExplainPlan | null
export declare function parseMssqlShowplanXmlExplain(input: unknown): ParsedExplainPlan | null
export declare function parseMssqlShowplanAllExplain(input: unknown): ParsedExplainPlan | null
export declare function parseDamengTextExplain(input: unknown): ParsedExplainPlan | null
export declare function parseIndentedTextExplain(
  input: unknown,
  dialect?: DatabaseDriverType
): ParsedExplainPlan | null
export declare function parseMongoExplain(input: unknown): ParsedExplainPlan | null
export declare function parseRawExplainInput(
  input: unknown,
  options?: ExplainParserOptions
): ParsedExplainPlan
