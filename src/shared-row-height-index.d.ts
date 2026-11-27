export const CHUNK_ROWS: 256
export const MIN_WRAP_MAX_LINES: 1
export const MAX_WRAP_MAX_LINES: 10
export const DEFAULT_WRAP_MAX_LINES: 4
export const DEFAULT_BASE_ROW_HEIGHT_PX: 22
export const DEFAULT_LINE_HEIGHT_PX: 16

export interface RowHeightIndexOptions {
  rowCount?: number
  baseRowHeightPx?: number
  lineHeightPx?: number
  maxLines?: number
  wrapEnabled?: boolean
}

export interface RowBounds {
  top: number
  height: number
  bottom: number
  lines: number
}

export interface VisibleRowRange {
  start: number
  end: number
  topSpacerPx: number
  bottomSpacerPx: number
  totalHeightPx: number
}

export interface RowMeasurementRead {
  row: number
  lines?: number
  heightPx?: number
}

export interface MeasureBatchResult {
  scrollTopDeltaPx: number
  updatedCount: number
  changedCount: number
}

export function clampWrapMaxLines(value: number | null | undefined): number

export function normalizeWrapCellText(raw: unknown): string

export function countNormalizedLines(raw: unknown, maxLines?: number): number

export function isWrappableCellValue(value: unknown, colType?: string): boolean

export class RowHeightIndex {
  readonly _lines: Uint8Array
  readonly _extra: Int32Array
  readonly _before: Float64Array

  constructor(options?: RowHeightIndexOptions)

  get rowCount(): number
  get chunkCount(): number
  get measuredCount(): number
  get maxLines(): number
  get wrapEnabled(): boolean
  get baseRowHeightPx(): number
  get lineHeightPx(): number
  get settledWatermark(): number

  reset(rowCount?: number): void
  setWrapEnabled(enabled: boolean): boolean
  setMaxLines(maxLines: number): boolean
  getRowLines(row: number): number
  setRowLines(row: number, lines: number): boolean
  getRowHeight(row: number): number
  getTotalHeight(): number
  getRowOffset(row: number): number
  getRowBounds(row: number): RowBounds
  findRowAtOffset(yOffset: number): number
  getVisibleRange(scrollTop: number, viewportHeight: number, overscanRows?: number): VisibleRowRange
  measureBatch(reads: readonly RowMeasurementRead[], anchorRowIndex?: number | null): MeasureBatchResult
}
