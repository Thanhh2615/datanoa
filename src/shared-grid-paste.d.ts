export interface PasteColumnSpec {
  name: string
  isAutoIncrement?: boolean
  isPrimaryKey?: boolean
  isGenerated?: boolean
}

export interface PastePlanInput {
  matrix: readonly (readonly unknown[])[]
  hasSelection: boolean
  selectionBBox: {
    startRow: number
    endRow: number
    startCol: number
    endCol: number
  } | null
  selectedCellCount: number
  existingRowCount: number
  visibleColIndices: readonly number[]
  allColumns: readonly PasteColumnSpec[]
  forceNewRows: boolean
  explicitHasHeaders?: boolean
  sourceHeaders?: readonly string[]
}

export interface PastePlanCell {
  modelColIdx: number
  visColIdx: number
  rawValue: unknown
}

export interface PastePlanOverwriteRow {
  targetVisRow: number
  cells: PastePlanCell[]
}

export interface PastePlanInsertRow {
  cells: PastePlanCell[]
}

export interface PastePlanResult {
  mode: 'empty' | 'fill' | 'overwrite' | 'insert' | 'overwrite-and-insert'
  hadHeaders: boolean
  fillValue?: unknown
  overwrites: PastePlanOverwriteRow[]
  inserts: PastePlanInsertRow[]
  startVisRow: number
  startVisCol: number
}

export interface SanitizeDiagnosticErrorOptions {
  stripControlChars?: boolean
  ellipsis?: boolean
}

export declare function parseDelimitedClipboard(
  text: string,
  options?: { delimiter?: '\t' | ',' }
): string[][]

export declare function planGridPaste(input: PastePlanInput): PastePlanResult

export declare function sanitizeDiagnosticErrorText(
  rawError: string,
  options?: SanitizeDiagnosticErrorOptions
): string
