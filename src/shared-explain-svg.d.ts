import type { ExplainPlanNode, ExplainSeverity, ParsedExplainPlan } from './protocol'

export declare const EXPLAIN_SVG_NODE_WIDTH: number
export declare const EXPLAIN_SVG_NODE_HEIGHT: number
export declare const EXPLAIN_SVG_NODE_HEIGHT_WITH_SUB: number
export declare const EXPLAIN_SVG_H_GAP: number
export declare const EXPLAIN_SVG_V_GAP: number
export declare const EXPLAIN_SVG_PADDING: number

export interface ExplainSvgPalette {
  bg: string
  cardBg: string
  cardBorder: string
  textPrimary: string
  textMuted: string
  edgeStroke: string
  critical: string
  high: string
  moderate: string
  low: string
  neutral: string
}

export declare const DEFAULT_EXPLAIN_SVG_PALETTE: Readonly<ExplainSvgPalette>

export interface ExplainSvgLayoutNode {
  id: string
  x: number
  y: number
  width: number
  height: number
  node: ExplainPlanNode
}

export interface ExplainSvgLayoutEdge {
  fromId: string
  toId: string
  x1: number
  y1: number
  x2: number
  y2: number
  pathD: string
}

export interface ExplainSvgLayoutResult {
  width: number
  height: number
  nodes: ExplainSvgLayoutNode[]
  edges: ExplainSvgLayoutEdge[]
}

export interface ExplainSvgLayoutOptions {
  nodeWidth?: number
  nodeHeight?: number
  hGap?: number
  vGap?: number
  padding?: number
  palette?: Partial<ExplainSvgPalette>
}

export interface ExplainNodePopoverData {
  id: string
  title: string
  subtitle: string
  severity: ExplainSeverity
  warnings: string[]
  metrics: {
    exclusiveCost: number | null
    totalCost: number | null
    costFraction: number | null
    exclusiveTimeMs: number | null
    actualTotalTimeMs: number | null
    timeFraction: number | null
    planRows: number | null
    totalActualRows: number | null
    actualLoops: number | null
    processCount: number
  }
  details: Array<{ key: string; value: string }>
}

export interface ExplainViewportState {
  x: number
  y: number
  scale: number
}

export declare function layoutExplainPlanTree(
  root: ExplainPlanNode | null,
  options?: ExplainSvgLayoutOptions
): ExplainSvgLayoutResult

export declare function buildExplainNodePopoverData(node: ExplainPlanNode): ExplainNodePopoverData

export declare function clampExplainViewport(
  viewport: Partial<ExplainViewportState>,
  contentWidth: number,
  contentHeight: number,
  containerSize?: { width: number; height: number }
): ExplainViewportState

export declare function renderExplainPlanSvg(
  plan: ParsedExplainPlan,
  options?: ExplainSvgLayoutOptions
): {
  svg: string
  width: number
  height: number
  summary: {
    format: string
    nodeCount: number
    planningTimeMs: number | null
    executionTimeMs: number | null
    totalCost: number | null
    totalActualTimeMs: number | null
    warningCount: number
  }
  nodes: ExplainSvgLayoutNode[]
  edges: ExplainSvgLayoutEdge[]
}
