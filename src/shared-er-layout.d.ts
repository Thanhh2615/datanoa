import type { ErNodePosition, SchemaErColumn, SchemaErNode } from './protocol'
import type { NormalizedErEdge, NormalizedErGraph } from './shared-er-diagram'

export interface ErLayoutNode {
  id: string
  x: number
  y: number
  width: number
  height: number
  headerHeight: number
  rowHeight: number
  visibleColumns: SchemaErColumn[]
  node: SchemaErNode
}

export type ErEdgeFace = 'top' | 'bottom' | 'left' | 'right'

export interface ErLayoutEdge {
  id: string
  edge: NormalizedErEdge
  isSelfLoop: boolean
  fromFace: ErEdgeFace
  toFace: ErEdgeFace
  x1: number
  y1: number
  x2: number
  y2: number
  pathD: string
  optionalMarker: { x: number; y: number; r: number } | null
}

export interface ErLayoutBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface ErLayoutResult {
  width: number
  height: number
  nodes: ErLayoutNode[]
  edges: ErLayoutEdge[]
  bounds: ErLayoutBounds
}

export interface ComputeErLayoutOptions {
  compactMode?: boolean
  manualPositions?: Record<string, ErNodePosition>
}

export declare function computeErLayout(
  graph: NormalizedErGraph,
  options?: ComputeErLayoutOptions
): ErLayoutResult
