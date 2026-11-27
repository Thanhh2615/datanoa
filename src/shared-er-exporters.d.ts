import type { ErNodePosition } from './protocol'
import type { NormalizedErGraph } from './shared-er-diagram'
import type { ComputeErLayoutOptions, ErLayoutResult } from './shared-er-layout'

export interface ErThemePalette {
  bg: string
  cardBg: string
  headerBg: string
  stubBg: string
  border: string
  textPrimary: string
  textMuted: string
  pkColor: string
  fkColor: string
  ukColor: string
  edgeStroke: string
  crossSchemaStroke: string
}

export declare const DEFAULT_ER_DARK_PALETTE: Readonly<ErThemePalette>
export declare const DEFAULT_ER_LIGHT_PALETTE: Readonly<ErThemePalette>

export interface ErPngRasterEnv {
  createCanvas?: () => HTMLCanvasElement
  createImage?: () => HTMLImageElement
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
}

export interface ExportErToSvgOptions {
  palette?: Partial<ErThemePalette>
  manualPositions?: Record<string, ErNodePosition>
  layoutOptions?: ComputeErLayoutOptions
}

export declare function exportErToMermaid(graph: NormalizedErGraph): string
export declare function exportErToGraphvizDot(graph: NormalizedErGraph): string
export declare function exportErToSvg(
  graph: NormalizedErGraph,
  layout: ErLayoutResult,
  options?: ExportErToSvgOptions
): string

export declare function computeErPngExportScale(
  width: number,
  height: number
): { scale: number; targetWidth: number; targetHeight: number }

export declare function rasterizeErSvgToPngArrayBuffer(
  svgString: string,
  width: number,
  height: number,
  env?: ErPngRasterEnv
): Promise<ArrayBuffer>
