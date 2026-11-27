import type { SchemaErColumn, SchemaErEdge, SchemaErGraph, SchemaErNode, TableDetails } from './protocol'

export declare const ER_CARD_MIN_WIDTH: number
export declare const ER_CARD_MAX_WIDTH: number
export declare const ER_CARD_HEADER_HEIGHT: number
export declare const ER_CARD_ROW_HEIGHT: number
export declare const ER_CARD_PADDING_X: number

export interface ErCardDimensions {
  width: number
  height: number
  headerHeight: number
  rowHeight: number
  visibleColumns: SchemaErColumn[]
}

export interface NormalizedErEdge extends SchemaErEdge {
  isManyToMany?: boolean
  junctionTable?: string
}

export interface NormalizedErGraph extends Omit<SchemaErGraph, 'edges'> {
  edges: NormalizedErEdge[]
  collapsedJunctions: string[]
}

export interface NormalizeErGraphOptions {
  compactMode?: boolean
  hideOrphans?: boolean
  collapseJunctions?: boolean
  showExternalStubs?: boolean
}

export declare function estimateErTextWidth(text: string, fontSizePx?: number): number

export declare function computeErCardDimensions(
  node: SchemaErNode,
  options?: { compactMode?: boolean }
): ErCardDimensions

export declare function buildErGraphFromTableDetails(
  connectionId: string,
  tables: readonly TableDetails[],
  options?: { schema?: string }
): SchemaErGraph

export declare function normalizeErGraph(
  graph: SchemaErGraph,
  options?: NormalizeErGraphOptions
): NormalizedErGraph
