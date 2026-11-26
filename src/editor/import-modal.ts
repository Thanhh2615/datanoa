// src/editor/import-modal.ts
// CSV / TSV / JSON / NDJSON File Import, Column Mapping & Chunked Resumable Commit Modal

import type { ColumnInfo, ConnectionProfile, DatabaseDriverType } from '../protocol.js'
import { DEFAULT_IMPORT_CHUNK_SIZE, DEFAULT_RPC_TIMEOUT_MS } from '../shared-constants.js'
import { bindCtrlWheelHorizontalScroll } from '../shared-wheel-scroll.js'
import { setButtonLoading } from './db-icons.js'
import {
  autoMapImportColumns,
  buildImportPreviewSql,
  buildMappedImportRecords,
  parseImportBytes,
  validateImportMapping,
  type BuildImportRowsResult,
  type ColumnMappingEntry,
  type ImportDelimiterOption,
  type ImportEncodingOption,
  type ImportFileFormat,
  type ImportNullHandling,
  type ParsedImportDataset,
} from './data-import.js'
import { formatCellValue } from './grid-formatters.js'
import type { StudioTimedRpcModalContext } from './studio-modals.js'

const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024
const MAX_STAGE_IN_GRID_ROWS = 500
const AUTO_STAGE_IN_GRID_THRESHOLD = 200

export interface StudioImportDataModalContext extends StudioTimedRpcModalContext {
  activeConnection?: ConnectionProfile
  activeConnectionId: string | null
  targetTable: string
  targetSchema?: string
  targetColumns: ColumnInfo[]
  canStageInGrid: boolean
  showQueryBanner: (
    kind: 'success' | 'error',
    title: string,
    detail?: string,
    opts?: { onRetry?: () => void; showBackToTable?: boolean }
  ) => void
  onStageRows: (records: Record<string, unknown>[]) => number
  onDirectImportComplete: (
    connId: string,
    table: string,
    schema: string | undefined,
    insertedCount: number,
    options?: { partial?: boolean }
  ) => Promise<void>
}

function formatFileByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

async function readFileAsUint8Array(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    const buffer = await file.arrayBuffer()
    return new Uint8Array(buffer)
  }
  if (typeof FileReader !== 'undefined') {
    return await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(new Uint8Array(reader.result))
        } else if (typeof reader.result === 'string') {
          resolve(new TextEncoder().encode(reader.result))
        } else {
          reject(new Error('Could not read file contents'))
        }
      }
      reader.onerror = () => {
        reject(reader.error || new Error('File read failed'))
      }
      reader.readAsArrayBuffer(file)
    })
  }
  throw new Error('File reading API is unavailable in this environment')
}

function buildColumnOptionLabel(col: ColumnInfo): string {
  const flags: string[] = []
  if (col.isPrimaryKey) flags.push('PK')
  if (col.isAutoIncrement) flags.push('AI')
  if (!col.nullable) flags.push('NOT NULL')
  if (col.defaultValue !== null && col.defaultValue !== undefined && col.defaultValue !== '') {
    flags.push('DEFAULT')
  }
  const typeLabel = col.type || col.nativeType || ''
  const suffix = flags.length > 0 ? ` [${flags.join(', ')}]` : ''
  return typeLabel ? `${col.name} (${typeLabel})${suffix}` : `${col.name}${suffix}`
}

function formatSampleValues(rows: unknown[][], sourceIndex: number): string {
  const samples: string[] = []
  for (let r = 0; r < rows.length && samples.length < 3; r++) {
    const raw = sourceIndex < rows[r].length ? rows[r][sourceIndex] : undefined
    if (raw === undefined || raw === null || raw === '') continue
    const str =
      typeof raw === 'object'
        ? (() => {
            try {
              return JSON.stringify(raw)
            } catch {
              return String(raw)
            }
          })()
        : String(raw)
    const compact = str.replace(/\s+/g, ' ').trim()
    if (!compact) continue
    samples.push(compact.length > 26 ? `${compact.slice(0, 26)}...` : compact)
  }
  return samples.length > 0 ? samples.join(', ') : '(empty)'
}

const DEFAULT_IMPORT_DROP_SUB = 'Supports UTF-8, UTF-16, Windows-1252, Shift_JIS · up to 25 MB'

function parseImportFileFormatOption(value: string): ImportFileFormat {
  if (value === 'csv' || value === 'tsv' || value === 'json' || value === 'ndjson') {
    return value
  }
  return 'auto'
}

function parseImportDelimiterOption(value: string): ImportDelimiterOption {
  if (value === ',' || value === '\t' || value === ';' || value === '|') {
    return value
  }
  return 'auto'
}

function parseImportEncodingOption(value: string): ImportEncodingOption {
  if (
    value === 'utf-8' ||
    value === 'utf-16le' ||
    value === 'utf-16be' ||
    value === 'windows-1252' ||
    value === 'iso-8859-1' ||
    value === 'shift_jis'
  ) {
    return value
  }
  return 'auto'
}

function parseImportNullHandlingOption(value: string): ImportNullHandling {
  if (value === 'empty-only' || value === 'null-literal-only' || value === 'none') {
    return value
  }
  return 'empty-and-null'
}

function buildInferredMongoColumns(headers: readonly string[]): ColumnInfo[] {
  return headers.map((name) => ({
    name,
    type: 'JSON',
    nativeType: 'JSON',
    nullable: true,
    defaultValue: null,
    isPrimaryKey: false,
    isAutoIncrement: false,
  }))
}

export function buildImportCommandPreview(
  rows: Record<string, unknown>[],
  opts: {
    driver: DatabaseDriverType
    table: string
    schema?: string
    maxStatements?: number
  }
): string {
  if (opts.driver === 'mongodb') {
    const limit = Math.max(1, opts.maxStatements ?? 3)
    const colCall = `db.getCollection(${JSON.stringify(opts.table)})`
    return rows
      .slice(0, limit)
      .map((row) => `${colCall}.insertOne(${JSON.stringify(row)});`)
      .join('\n')
  }
  return buildImportPreviewSql(rows, opts)
}

export function openStudioImportModal(ctx: StudioImportDataModalContext): void {
  if (typeof document === 'undefined') return
  const conn = ctx.activeConnection
  if (!conn || conn.readOnly || conn.driver === 'redis') {
    ctx.updateStatus('Cannot import data on a Read-Only or Redis connection')
    return
  }
  const isMongo = conn.driver === 'mongodb'
  if (
    !ctx.targetTable ||
    !Array.isArray(ctx.targetColumns) ||
    (ctx.targetColumns.length === 0 && !isMongo)
  ) {
    ctx.updateStatus('Select a table with columns before importing data')
    return
  }

  const driver = conn.driver
  let mappableTargetColumns = ctx.targetColumns.filter((col) => col.isGenerated !== true)
  const targetLabel = ctx.targetSchema ? `${ctx.targetSchema}.${ctx.targetTable}` : ctx.targetTable

  let isImporting = false
  let isClosed = false
  let fileLoadSeq = 0
  let rawBytes: Uint8Array | null = null
  let selectedFileName = ''
  let selectedFileSize = 0
  let parseError = ''
  let dataset: ParsedImportDataset | null = null
  let mapping: ColumnMappingEntry[] = []
  let mappingSelectEls: HTMLSelectElement[] = []
  let builtResult: BuildImportRowsResult = { rows: [], skippedEmptyRows: 0 }
  let deliveryMode: 'stage' | 'direct' = ctx.canStageInGrid ? 'stage' : 'direct'
  let userPickedMode = false

  const closeModalSafe = (): void => {
    isClosed = true
    ctx.closeModal()
  }

  let formatOpt: ImportFileFormat = 'auto'
  let delimiterOpt: ImportDelimiterOption = 'auto'
  let encodingOpt: ImportEncodingOption = 'auto'
  let nullHandlingOpt: ImportNullHandling = 'empty-and-null'
  let hasHeaderRow = true
  let trimValues = false
  let skipEmptyRows = true

  const modal = document.createElement('div')
  modal.className = 'datanoa-import-modal'

  const head = document.createElement('div')
  head.className = 'datanoa-modal-head'
  const headTitle = document.createElement('span')
  headTitle.id = 'datanoa-import-modal-title'
  headTitle.textContent = `Import File into "${targetLabel}"`
  modal.setAttribute('aria-labelledby', headTitle.id)
  const badge = document.createElement('span')
  badge.className = 'datanoa-badge datanoa-badge-pk'
  badge.textContent = driver.toUpperCase()
  head.appendChild(headTitle)
  head.appendChild(badge)

  const body = document.createElement('div')
  body.className = 'datanoa-modal-body'

  // 1. File Picker & Drag-and-Drop Dropzone
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.id = 'datanoa-import-file-input'
  fileInput.className = 'datanoa-import-file-input'
  fileInput.accept = '.csv,.tsv,.tab,.txt,.json,.ndjson,.jsonl,text/csv,text/tab-separated-values,application/json'
  fileInput.setAttribute('aria-label', 'Choose CSV, TSV, JSON, or NDJSON file to import')
  fileInput.style.display = 'none'

  const dropzone = document.createElement('div')
  dropzone.className = 'datanoa-import-dropzone'

  const dropInfo = document.createElement('div')
  dropInfo.className = 'datanoa-import-dropzone-info'
  const dropTitle = document.createElement('div')
  dropTitle.className = 'datanoa-import-dropzone-title'
  dropTitle.textContent = 'Drop a CSV, TSV, JSON, or NDJSON file here'
  const dropSub = document.createElement('div')
  dropSub.className = 'datanoa-import-dropzone-sub'
  dropSub.textContent = DEFAULT_IMPORT_DROP_SUB
  dropInfo.appendChild(dropTitle)
  dropInfo.appendChild(dropSub)

  const browseBtn = document.createElement('button')
  browseBtn.type = 'button'
  browseBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-import-browse-btn'
  browseBtn.textContent = 'Choose File...'
  browseBtn.addEventListener('click', () => {
    if (!isImporting) fileInput.click()
  })

  dropzone.appendChild(dropInfo)
  dropzone.appendChild(browseBtn)
  dropzone.appendChild(fileInput)
  body.appendChild(dropzone)

  // 2. Parse & Coercion Options
  const optionsGrid = document.createElement('div')
  optionsGrid.className = 'datanoa-import-options-grid'

  const createSelectField = (
    labelText: string,
    className: string,
    opts: ReadonlyArray<{ value: string; label: string }>,
    initialValue: string
  ): HTMLSelectElement => {
    const field = document.createElement('div')
    field.className = 'datanoa-conn-field'
    const selectId = `${className}-field`
    const lbl = document.createElement('label')
    lbl.htmlFor = selectId
    lbl.textContent = labelText
    const sel = document.createElement('select')
    sel.id = selectId
    sel.className = `datanoa-conn-select ${className}`
    sel.setAttribute('aria-label', labelText)
    for (const o of opts) {
      const el = document.createElement('option')
      el.value = o.value
      el.textContent = o.label
      if (o.value === initialValue) el.selected = true
      sel.appendChild(el)
    }
    sel.value = initialValue
    field.appendChild(lbl)
    field.appendChild(sel)
    optionsGrid.appendChild(field)
    return sel
  }

  const formatSelect = createSelectField(
    'Format',
    'datanoa-import-format-select',
    [
      { value: 'auto', label: 'Auto-detect' },
      { value: 'csv', label: 'CSV' },
      { value: 'tsv', label: 'TSV' },
      { value: 'json', label: 'JSON' },
      { value: 'ndjson', label: 'NDJSON / JSONL' },
    ],
    formatOpt
  )

  const delimiterSelect = createSelectField(
    'Delimiter',
    'datanoa-import-delimiter-select',
    [
      { value: 'auto', label: 'Auto-detect' },
      { value: ',', label: 'Comma (,)' },
      { value: '\t', label: 'Tab (\\t)' },
      { value: ';', label: 'Semicolon (;)' },
      { value: '|', label: 'Pipe (|)' },
    ],
    delimiterOpt
  )

  const encodingSelect = createSelectField(
    'Encoding',
    'datanoa-import-encoding-select',
    [
      { value: 'auto', label: 'Auto (BOM / UTF-8)' },
      { value: 'utf-8', label: 'UTF-8' },
      { value: 'utf-16le', label: 'UTF-16 LE' },
      { value: 'utf-16be', label: 'UTF-16 BE' },
      { value: 'windows-1252', label: 'Windows-1252' },
      { value: 'iso-8859-1', label: 'ISO-8859-1 (Latin-1)' },
      { value: 'shift_jis', label: 'Shift_JIS' },
    ],
    encodingOpt
  )

  const nullSelect = createSelectField(
    'NULL Handling',
    'datanoa-import-null-select',
    [
      { value: 'empty-and-null', label: 'Empty & NULL / \\N' },
      { value: 'empty-only', label: 'Empty string only' },
      { value: 'null-literal-only', label: 'NULL / \\N only' },
      { value: 'none', label: 'Keep literals (None)' },
    ],
    nullHandlingOpt
  )

  const flagsRow = document.createElement('div')
  flagsRow.className = 'datanoa-import-flags-row'

  const createFlagCheckbox = (
    labelText: string,
    className: string,
    checked: boolean
  ): HTMLInputElement => {
    const lbl = document.createElement('label')
    lbl.className = 'datanoa-conn-check'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.className = `datanoa-struct-checkbox ${className}`
    cb.checked = checked
    const span = document.createElement('span')
    span.textContent = labelText
    lbl.appendChild(cb)
    lbl.appendChild(span)
    flagsRow.appendChild(lbl)
    return cb
  }

  const headerCb = createFlagCheckbox('First row is header', 'datanoa-import-header-cb', hasHeaderRow)
  const trimCb = createFlagCheckbox('Trim whitespace', 'datanoa-import-trim-cb', trimValues)
  const skipEmptyCb = createFlagCheckbox(
    'Skip empty rows',
    'datanoa-import-skip-empty-cb',
    skipEmptyRows
  )

  optionsGrid.appendChild(flagsRow)
  body.appendChild(optionsGrid)

  // 3. Feedback Boxes (Errors & Warnings)
  const errorBox = document.createElement('div')
  errorBox.className = 'datanoa-modal-box error datanoa-import-error-box is-pinned'
  errorBox.style.display = 'none'

  const warnBox = document.createElement('div')
  warnBox.className = 'datanoa-modal-box warn datanoa-import-warn-box'
  warnBox.style.display = 'none'
  body.appendChild(warnBox)

  // 4. Column Mapping Table
  const mappingBar = document.createElement('div')
  mappingBar.className = 'datanoa-import-section-bar'
  const mappingTitle = document.createElement('strong')
  mappingTitle.textContent = 'Column Mapping'
  const mappingBtns = document.createElement('div')
  mappingBtns.className = 'datanoa-ddl-actions'

  const autoMapBtn = document.createElement('button')
  autoMapBtn.type = 'button'
  autoMapBtn.className = 'datanoa-btn datanoa-btn-sm'
  autoMapBtn.textContent = 'Auto-Map'
  autoMapBtn.disabled = true

  const skipAllBtn = document.createElement('button')
  skipAllBtn.type = 'button'
  skipAllBtn.className = 'datanoa-btn datanoa-btn-sm'
  skipAllBtn.textContent = 'Skip All'
  skipAllBtn.disabled = true

  mappingBtns.appendChild(autoMapBtn)
  mappingBtns.appendChild(skipAllBtn)
  mappingBar.appendChild(mappingTitle)
  mappingBar.appendChild(mappingBtns)
  body.appendChild(mappingBar)

  const mappingWrap = document.createElement('div')
  mappingWrap.className = 'datanoa-matrix-scroll datanoa-import-mapping-wrap'
  const mappingTable = document.createElement('table')
  mappingTable.className = 'datanoa-matrix-table datanoa-struct-grid'
  const mappingThead = document.createElement('thead')
  const mappingHeadTr = document.createElement('tr')
  for (const colHead of ['Source Column', 'Sample Values', 'Target Table Column']) {
    const th = document.createElement('th')
    th.textContent = colHead
    mappingHeadTr.appendChild(th)
  }
  mappingThead.appendChild(mappingHeadTr)
  const mappingTbody = document.createElement('tbody')
  mappingTable.appendChild(mappingThead)
  mappingTable.appendChild(mappingTbody)
  mappingWrap.appendChild(mappingTable)
  body.appendChild(mappingWrap)
  bindCtrlWheelHorizontalScroll(mappingWrap)

  // 5. Data Preview & Live SQL Preview
  const previewTitle = document.createElement('strong')
  previewTitle.textContent = 'Mapped Data Preview (first 8 rows)'
  body.appendChild(previewTitle)

  const previewWrap = document.createElement('div')
  previewWrap.className = 'datanoa-matrix-scroll datanoa-import-preview-wrap'
  const previewTable = document.createElement('table')
  previewTable.className = 'datanoa-matrix-table'
  const previewThead = document.createElement('thead')
  const previewTbody = document.createElement('tbody')
  previewTable.appendChild(previewThead)
  previewTable.appendChild(previewTbody)
  previewWrap.appendChild(previewTable)
  body.appendChild(previewWrap)
  bindCtrlWheelHorizontalScroll(previewWrap)

  const sqlLabel = document.createElement('strong')
  sqlLabel.textContent = 'Live INSERT Preview'
  const sqlPre = document.createElement('pre')
  sqlPre.className = 'datanoa-modal-sql datanoa-import-sql-preview'
  sqlPre.textContent = '-- Choose a CSV, TSV, JSON, or NDJSON file to preview INSERT statements.'
  body.appendChild(sqlLabel)
  body.appendChild(sqlPre)

  // 6. Delivery Mode Selector
  const modeGroup = document.createElement('div')
  modeGroup.className = 'datanoa-import-mode-group'

  const modeGroupLabel = document.createElement('strong')
  modeGroupLabel.textContent = 'Import Mode:'
  modeGroup.appendChild(modeGroupLabel)

  const modeRadioName = `datanoa_import_mode_${Date.now()}`

  const stageLabel = document.createElement('label')
  stageLabel.className = 'datanoa-import-mode-option'
  const stageRadio = document.createElement('input')
  stageRadio.type = 'radio'
  stageRadio.name = modeRadioName
  stageRadio.value = 'stage'
  stageRadio.className = 'datanoa-import-mode-stage'
  const stageSpan = document.createElement('span')
  stageSpan.textContent = 'Stage in Grid (Review & Submit)'
  stageLabel.appendChild(stageRadio)
  stageLabel.appendChild(stageSpan)

  const directLabel = document.createElement('label')
  directLabel.className = 'datanoa-import-mode-option'
  const directRadio = document.createElement('input')
  directRadio.type = 'radio'
  directRadio.name = modeRadioName
  directRadio.value = 'direct'
  directRadio.className = 'datanoa-import-mode-direct'
  const directSpan = document.createElement('span')
  directSpan.textContent = `Insert Directly (${DEFAULT_IMPORT_CHUNK_SIZE} rows/batch)`
  directLabel.appendChild(directRadio)
  directLabel.appendChild(directSpan)

  modeGroup.appendChild(stageLabel)
  modeGroup.appendChild(directLabel)
  body.appendChild(modeGroup)

  // 7. Footer Actions
  const actions = document.createElement('div')
  actions.className = 'datanoa-modal-actions datanoa-import-actions'

  const summaryEl = document.createElement('span')
  summaryEl.className = 'datanoa-import-summary'
  summaryEl.textContent = 'No file selected'

  const actionBtns = document.createElement('div')
  actionBtns.className = 'datanoa-ddl-actions'

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'datanoa-btn datanoa-btn-sm'
  cancelBtn.textContent = 'Cancel'

  const importBtn = document.createElement('button')
  importBtn.type = 'button'
  importBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-primary datanoa-import-submit-btn'
  importBtn.textContent = 'Import Rows'
  importBtn.disabled = true

  actionBtns.appendChild(cancelBtn)
  actionBtns.appendChild(importBtn)
  actions.appendChild(summaryEl)
  actions.appendChild(actionBtns)

  const setControlsDisabled = (disabled: boolean): void => {
    browseBtn.disabled = disabled
    formatSelect.disabled = disabled
    delimiterSelect.disabled =
      disabled || (dataset !== null && (dataset.resolvedFormat === 'json' || dataset.resolvedFormat === 'ndjson'))
    encodingSelect.disabled = disabled
    nullSelect.disabled = disabled
    headerCb.disabled = disabled
    trimCb.disabled = disabled
    skipEmptyCb.disabled = disabled
    autoMapBtn.disabled = disabled || !dataset || dataset.headers.length === 0
    skipAllBtn.disabled = disabled || !dataset || dataset.headers.length === 0
    cancelBtn.disabled = disabled
    stageRadio.disabled =
      disabled || !ctx.canStageInGrid || totalReadyRowCount > MAX_STAGE_IN_GRID_ROWS
    directRadio.disabled = disabled
    for (const sel of mappingSelectEls) {
      sel.disabled = disabled
    }
  }

  const syncModeSelection = (): void => {
    const canStage = ctx.canStageInGrid && totalReadyRowCount <= MAX_STAGE_IN_GRID_ROWS
    if (!canStage) {
      deliveryMode = 'direct'
    } else if (!userPickedMode) {
      deliveryMode =
        totalReadyRowCount <= AUTO_STAGE_IN_GRID_THRESHOLD ? 'stage' : 'direct'
    }
    stageRadio.checked = deliveryMode === 'stage'
    directRadio.checked = deliveryMode === 'direct'
    stageRadio.disabled = isImporting || !canStage
    stageLabel.classList.toggle('disabled', !canStage)
    stageLabel.title = !ctx.canStageInGrid
      ? 'Grid staging requires an editable active table with a Primary Key'
      : totalReadyRowCount > MAX_STAGE_IN_GRID_ROWS
        ? `Datasets over ${MAX_STAGE_IN_GRID_ROWS} rows use Direct Batch Insert for performance`
        : 'Stage imported rows in the grid so you can inspect, edit, preview DML, or revert before Submit'
  }

  let committedRowCount = 0

  const renderMappingTable = (): void => {
    mappingTbody.innerHTML = ''
    mappingSelectEls = []
    if (!dataset || dataset.headers.length === 0) {
      const tr = document.createElement('tr')
      const td = document.createElement('td')
      td.colSpan = 3
      td.className = 'datanoa-cell-null datanoa-struct-td-pad'
      td.textContent = selectedFileName
        ? 'No source columns detected in file.'
        : 'Select a file to map source columns to table columns.'
      tr.appendChild(td)
      mappingTbody.appendChild(tr)
      return
    }

    for (const entry of mapping) {
      const tr = document.createElement('tr')

      const tdSource = document.createElement('td')
      tdSource.className = 'datanoa-struct-td-pad'
      tdSource.style.fontFamily = 'var(--mono-font)'
      tdSource.textContent = entry.sourceName

      const tdSample = document.createElement('td')
      tdSample.className = 'datanoa-struct-td-pad datanoa-import-sample-cell'
      const sampleText = formatSampleValues(dataset.rows, entry.sourceIndex)
      tdSample.textContent = sampleText
      tdSample.title = sampleText

      const tdTarget = document.createElement('td')
      const targetSel = document.createElement('select')
      targetSel.id = `datanoa-import-target-col-${entry.sourceIndex}`
      targetSel.className = 'datanoa-struct-cell-select datanoa-import-target-select'
      targetSel.dataset.sourceIndex = String(entry.sourceIndex)
      targetSel.setAttribute('aria-label', `Target table column for "${entry.sourceName}"`)

      const skipOpt = document.createElement('option')
      skipOpt.value = ''
      skipOpt.textContent = '(Skip)'
      targetSel.appendChild(skipOpt)

      for (const col of mappableTargetColumns) {
        const opt = document.createElement('option')
        opt.value = col.name
        opt.textContent = buildColumnOptionLabel(col)
        if (entry.targetColumn === col.name) {
          opt.selected = true
        }
        targetSel.appendChild(opt)
      }
      targetSel.value = entry.targetColumn || ''
      targetSel.disabled = isImporting
      targetSel.addEventListener('change', () => {
        if (isImporting) return
        entry.targetColumn = targetSel.value || null
        committedRowCount = 0
        rebuildPreviewAndValidation()
      })
      mappingSelectEls.push(targetSel)
      tdTarget.appendChild(targetSel)

      tr.appendChild(tdSource)
      tr.appendChild(tdSample)
      tr.appendChild(tdTarget)
      mappingTbody.appendChild(tr)
    }
  }

  const renderDataPreview = (mappedHeaders: string[]): void => {
    previewThead.innerHTML = ''
    previewTbody.innerHTML = ''

    if (mappedHeaders.length === 0 || builtResult.rows.length === 0) {
      const tr = document.createElement('tr')
      const td = document.createElement('td')
      td.className = 'datanoa-cell-null'
      td.textContent = 'No mapped rows to preview.'
      tr.appendChild(td)
      previewTbody.appendChild(tr)
      return
    }

    const headTr = document.createElement('tr')
    const numTh = document.createElement('th')
    numTh.textContent = '#'
    headTr.appendChild(numTh)
    for (const colName of mappedHeaders) {
      const th = document.createElement('th')
      th.textContent = colName
      headTr.appendChild(th)
    }
    previewThead.appendChild(headTr)

    const colTypeByName = new Map<string, string>()
    for (const col of ctx.targetColumns) {
      colTypeByName.set(col.name, col.type || col.nativeType || '')
    }

    const previewRows = builtResult.rows.slice(0, 8)
    previewRows.forEach((rec, idx) => {
      const tr = document.createElement('tr')
      const idxTd = document.createElement('td')
      idxTd.className = 'datanoa-cell-numeric'
      idxTd.textContent = String(idx + 1)
      tr.appendChild(idxTd)

      for (const colName of mappedHeaders) {
        const td = document.createElement('td')
        const formatted = formatCellValue(rec[colName], colTypeByName.get(colName))
        td.className = formatted.className
        td.textContent =
          formatted.text.length > 60 ? `${formatted.text.slice(0, 60)}...` : formatted.text
        td.title = formatted.text
        tr.appendChild(td)
      }
      previewTbody.appendChild(tr)
    })
  }

  const MAX_IMPORT_PREVIEW_ROWS = 50
  const countImportableSourceRows = (
    srcDataset: ParsedImportDataset,
    skipEmpty: boolean
  ): { totalReady: number; skippedEmptyRows: number } => {
    if (!skipEmpty) {
      return { totalReady: srcDataset.rows.length, skippedEmptyRows: 0 }
    }
    let totalReady = 0
    let skippedEmptyRows = 0
    for (const row of srcDataset.rows) {
      let blank = true
      for (const cell of row) {
        if (cell === null || cell === undefined) continue
        if (typeof cell === 'string' && cell.trim() === '') continue
        blank = false
        break
      }
      if (blank) skippedEmptyRows++
      else totalReady++
    }
    return { totalReady, skippedEmptyRows }
  }

  let totalReadyRowCount = 0

  const rebuildPreviewAndValidation = (): void => {
    if (parseError) {
      errorBox.textContent = parseError
      errorBox.style.display = 'block'
      warnBox.style.display = 'none'
      builtResult = { rows: [], skippedEmptyRows: 0 }
      totalReadyRowCount = 0
      renderDataPreview([])
      sqlPre.textContent = `-- ${parseError}`
      summaryEl.textContent = 'Parse error'
      importBtn.disabled = true
      syncModeSelection()
      setControlsDisabled(isImporting)
      return
    }

    if (!dataset) {
      errorBox.style.display = 'none'
      warnBox.style.display = 'none'
      builtResult = { rows: [], skippedEmptyRows: 0 }
      totalReadyRowCount = 0
      renderDataPreview([])
      sqlPre.textContent = isMongo
        ? '-- Choose a CSV, TSV, JSON, or NDJSON file to preview insertOne() commands.'
        : '-- Choose a CSV, TSV, JSON, or NDJSON file to preview INSERT statements.'
      summaryEl.textContent = 'No file selected'
      importBtn.textContent = 'Import Rows'
      importBtn.disabled = true
      syncModeSelection()
      setControlsDisabled(isImporting)
      return
    }

    const effectiveCols: ColumnInfo[] =
      isMongo && ctx.targetColumns.length === 0
        ? buildInferredMongoColumns(dataset.headers)
        : ctx.targetColumns
    const validation = validateImportMapping(mapping, effectiveCols)
    const rowStats = countImportableSourceRows(dataset, skipEmptyRows)
    totalReadyRowCount = validation.valid ? rowStats.totalReady : 0
    builtResult = validation.valid
      ? buildMappedImportRecords(dataset, mapping, effectiveCols, {
          nullHandling: nullHandlingOpt,
          trimValues,
          skipEmptyRows,
          sourceFormat: dataset.resolvedFormat,
          maxRows: MAX_IMPORT_PREVIEW_ROWS,
        })
      : { rows: [], skippedEmptyRows: 0 }

    const mappedHeaders = mapping
      .map((m) => m.targetColumn)
      .filter((col): col is string => typeof col === 'string' && col.length > 0)

    const allErrors = [...validation.errors]
    if (validation.valid && totalReadyRowCount === 0) {
      allErrors.push('No non-empty data rows found to import.')
    }

    if (allErrors.length > 0) {
      errorBox.textContent = allErrors.join(' ')
      errorBox.style.display = 'block'
    } else {
      errorBox.style.display = 'none'
    }

    const allWarnings = [...dataset.warnings, ...validation.warnings]
    if (rowStats.skippedEmptyRows > 0) {
      allWarnings.push(`Skipped ${rowStats.skippedEmptyRows} empty row(s).`)
    }
    if (allWarnings.length > 0) {
      warnBox.textContent = allWarnings.join(' ')
      warnBox.style.display = 'block'
    } else {
      warnBox.style.display = 'none'
    }

    mappingTitle.textContent = `Column Mapping (${validation.mappedCount} / ${dataset.headers.length} mapped)`
    renderDataPreview(mappedHeaders)
    sqlPre.textContent =
      validation.valid && builtResult.rows.length > 0
        ? buildImportCommandPreview(builtResult.rows, {
            driver,
            table: ctx.targetTable,
            schema: ctx.targetSchema,
            maxStatements: 3,
          })
        : isMongo
          ? '-- Fix mapping errors above to preview insertOne() commands.'
          : '-- Fix mapping errors above to preview INSERT statements.'

    syncModeSelection()

    const count = totalReadyRowCount
    const delimLabel =
      dataset.resolvedDelimiter === '\t'
        ? 'TAB'
        : dataset.resolvedDelimiter
          ? `"${dataset.resolvedDelimiter}"`
          : 'JSON'
    dropSub.textContent = `${formatFileByteSize(selectedFileSize)} · ${dataset.resolvedFormat.toUpperCase()} (${delimLabel}) · ${dataset.resolvedEncoding.toUpperCase()} · ${dataset.totalRows} row(s)`
    summaryEl.textContent = `${count} row(s) ready · ${validation.mappedCount} col(s) mapped`
    if (!isImporting) {
      if (deliveryMode === 'direct' && committedRowCount > 0 && committedRowCount < count) {
        const remaining = count - committedRowCount
        importBtn.textContent = `Resume Import (${remaining} remaining)`
      } else {
        importBtn.textContent =
          deliveryMode === 'stage'
            ? `Stage ${count} Row${count === 1 ? '' : 's'} in Grid`
            : `Import ${count} Row${count === 1 ? '' : 's'}`
      }
    }
    importBtn.disabled = isImporting || allErrors.length > 0 || count === 0
    setControlsDisabled(isImporting)
  }

  const reparseLoadedFile = (resetMapping = true): void => {
    committedRowCount = 0
    if (!rawBytes) {
      dataset = null
      mapping = []
      parseError = ''
      renderMappingTable()
      rebuildPreviewAndValidation()
      return
    }
    try {
      parseError = ''
      dataset = parseImportBytes(rawBytes, {
        format: formatOpt,
        delimiter: delimiterOpt,
        encoding: encodingOpt,
        hasHeaderRow,
        trimValues,
        fileName: selectedFileName,
      })
      if (isMongo && ctx.targetColumns.length === 0) {
        mappableTargetColumns = buildInferredMongoColumns(dataset.headers)
      }
      const colsForMapping =
        isMongo && ctx.targetColumns.length === 0 ? mappableTargetColumns : ctx.targetColumns
      if (resetMapping || mapping.length !== dataset.headers.length) {
        mapping = autoMapImportColumns(dataset.headers, colsForMapping, dataset.hasNamedHeaders)
      }
    } catch (err: unknown) {
      dataset = null
      mapping = []
      parseError = err instanceof Error ? err.message : String(err)
    }
    renderMappingTable()
    rebuildPreviewAndValidation()
  }

  const loadSelectedFile = async (file: File): Promise<void> => {
    if (isImporting || isClosed) return
    const loadSeq = ++fileLoadSeq
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      rawBytes = null
      dataset = null
      mapping = []
      selectedFileName = file.name
      selectedFileSize = file.size
      dropTitle.textContent = file.name
      dropSub.textContent = `${formatFileByteSize(file.size)} · Exceeds 25 MB limit`
      parseError = `File "${file.name}" (${formatFileByteSize(file.size)}) exceeds the 25 MB browser import limit.`
      renderMappingTable()
      rebuildPreviewAndValidation()
      return
    }
    try {
      const bytes = await readFileAsUint8Array(file)
      if (loadSeq !== fileLoadSeq || isImporting || isClosed) return
      rawBytes = bytes
      selectedFileName = file.name
      selectedFileSize = file.size || bytes.byteLength
      dropTitle.textContent = file.name
      userPickedMode = false
      reparseLoadedFile(true)
    } catch (err: unknown) {
      if (loadSeq !== fileLoadSeq || isImporting || isClosed) return
      rawBytes = null
      dataset = null
      mapping = []
      selectedFileName = file.name
      selectedFileSize = file.size
      dropTitle.textContent = file.name
      dropSub.textContent = DEFAULT_IMPORT_DROP_SUB
      parseError = `Failed to read "${file.name}": ${err instanceof Error ? err.message : String(err)}`
      renderMappingTable()
      rebuildPreviewAndValidation()
    }
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    if (file) {
      void loadSelectedFile(file)
    }
    fileInput.value = ''
  })

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault()
    if (!isImporting) dropzone.classList.add('dragover')
  })
  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover')
  })
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault()
    dropzone.classList.remove('dragover')
    if (isImporting) return
    const file = e.dataTransfer?.files?.[0]
    if (file) {
      void loadSelectedFile(file)
    }
  })

  formatSelect.addEventListener('change', () => {
    formatOpt = parseImportFileFormatOption(formatSelect.value)
    reparseLoadedFile(true)
  })
  delimiterSelect.addEventListener('change', () => {
    delimiterOpt = parseImportDelimiterOption(delimiterSelect.value)
    reparseLoadedFile(true)
  })
  encodingSelect.addEventListener('change', () => {
    encodingOpt = parseImportEncodingOption(encodingSelect.value)
    reparseLoadedFile(true)
  })
  nullSelect.addEventListener('change', () => {
    nullHandlingOpt = parseImportNullHandlingOption(nullSelect.value)
    committedRowCount = 0
    rebuildPreviewAndValidation()
  })
  headerCb.addEventListener('change', () => {
    hasHeaderRow = headerCb.checked
    reparseLoadedFile(true)
  })
  trimCb.addEventListener('change', () => {
    trimValues = trimCb.checked
    reparseLoadedFile(false)
  })
  skipEmptyCb.addEventListener('change', () => {
    skipEmptyRows = skipEmptyCb.checked
    committedRowCount = 0
    rebuildPreviewAndValidation()
  })

  autoMapBtn.addEventListener('click', () => {
    if (!dataset || isImporting) return
    const colsForMapping =
      isMongo && ctx.targetColumns.length === 0 ? mappableTargetColumns : ctx.targetColumns
    mapping = autoMapImportColumns(dataset.headers, colsForMapping, dataset.hasNamedHeaders)
    committedRowCount = 0
    renderMappingTable()
    rebuildPreviewAndValidation()
  })

  skipAllBtn.addEventListener('click', () => {
    if (!dataset || isImporting) return
    mapping = mapping.map((entry) => ({ ...entry, targetColumn: null }))
    committedRowCount = 0
    renderMappingTable()
    rebuildPreviewAndValidation()
  })

  stageRadio.addEventListener('change', () => {
    if (stageRadio.checked) {
      deliveryMode = 'stage'
      userPickedMode = true
      committedRowCount = 0
      rebuildPreviewAndValidation()
    }
  })
  directRadio.addEventListener('change', () => {
    if (directRadio.checked) {
      deliveryMode = 'direct'
      userPickedMode = true
      committedRowCount = 0
      rebuildPreviewAndValidation()
    }
  })

  cancelBtn.addEventListener('click', () => {
    if (!isImporting) closeModalSafe()
  })

  importBtn.addEventListener('click', () => {
    if (isImporting || !dataset || totalReadyRowCount === 0 || !ctx.activeConnectionId) return
    const effectiveCols: ColumnInfo[] =
      isMongo && ctx.targetColumns.length === 0
        ? buildInferredMongoColumns(dataset.headers)
        : ctx.targetColumns
    const fullBuilt = buildMappedImportRecords(dataset, mapping, effectiveCols, {
      nullHandling: nullHandlingOpt,
      trimValues,
      skipEmptyRows,
      sourceFormat: dataset.resolvedFormat,
    })
    const recordsToImport = fullBuilt.rows
    if (recordsToImport.length === 0) return

    if (deliveryMode === 'stage') {
      const stagedCount = ctx.onStageRows(recordsToImport)
      if (stagedCount > 0) {
        closeModalSafe()
        ctx.updateStatus(
          `Staged ${stagedCount} imported row${stagedCount === 1 ? '' : 's'} — review & click Submit`
        )
      } else {
        errorBox.textContent = 'Could not stage rows in grid. Try Insert Directly mode instead.'
        errorBox.style.display = 'block'
      }
      return
    }

    const connId = ctx.activeConnectionId
    const totalRows = recordsToImport.length
    const startOffset = committedRowCount >= totalRows ? 0 : committedRowCount
    if (startOffset === 0) committedRowCount = 0
    isImporting = true
    errorBox.style.display = 'none'
    setControlsDisabled(true)

    let insertedTotal = startOffset
    let latestElapsed = '0.0s'
    setButtonLoading(importBtn, true, `Importing ${insertedTotal}/${totalRows}... 0.0s`)
    const stopTimer = ctx.createElapsedTimer((elapsedText) => {
      latestElapsed = elapsedText
      setButtonLoading(importBtn, true, `Importing ${insertedTotal}/${totalRows}... ${elapsedText}`)
    })

    void (async () => {
      let currentBatch = Math.floor(startOffset / DEFAULT_IMPORT_CHUNK_SIZE)
      let batchSucceeded = false
      let abortedByClose = false
      try {
        for (let offset = startOffset; offset < totalRows; offset += DEFAULT_IMPORT_CHUNK_SIZE) {
          if (isClosed || !modal.isConnected) {
            abortedByClose = true
            break
          }
          currentBatch++
          const chunk = recordsToImport.slice(offset, offset + DEFAULT_IMPORT_CHUNK_SIZE)
          const res = await ctx.requestPlugin<{
            ok: boolean
            inserted: number
            updated: number
            deleted: number
            statements: string[]
          }>(
            'data.applyChanges',
            {
              connectionId: connId,
              table: ctx.targetTable,
              ...(ctx.targetSchema ? { schema: ctx.targetSchema } : {}),
              inserts: chunk,
              updates: [],
              deletes: [],
            },
            { timeoutMs: DEFAULT_RPC_TIMEOUT_MS }
          )
          if (!res?.ok) {
            throw new Error('The database rejected this import batch.')
          }
          committedRowCount = Math.min(totalRows, offset + chunk.length)
          insertedTotal += res.inserted ?? chunk.length
          setButtonLoading(
            importBtn,
            true,
            `Importing ${insertedTotal}/${totalRows}... ${latestElapsed}`
          )
        }
        batchSucceeded = !abortedByClose
      } catch (err: unknown) {
        isImporting = false
        setButtonLoading(importBtn, false)
        setControlsDisabled(false)
        rebuildPreviewAndValidation()
        const msg = err instanceof Error ? err.message : String(err)
        const remaining = Math.max(0, totalRows - committedRowCount)
        const progressNote =
          committedRowCount > 0
            ? ` (${committedRowCount} of ${totalRows} rows already committed — click Resume to import the remaining ${remaining} row${remaining === 1 ? '' : 's'})`
            : ''
        errorBox.textContent = `Import failed on batch #${currentBatch}${progressNote}: ${msg}`
        errorBox.style.display = 'block'
        if (committedRowCount > 0) {
          try {
            await ctx.onDirectImportComplete(
              connId,
              ctx.targetTable,
              ctx.targetSchema,
              committedRowCount,
              { partial: true }
            )
          } catch {
            // Non-blocking refresh after partial batch commit
          }
        }
        return
      } finally {
        stopTimer()
        if (abortedByClose) {
          isImporting = false
        }
      }

      if (batchSucceeded) {
        committedRowCount = 0
        isImporting = false
        closeModalSafe()
        try {
          await ctx.onDirectImportComplete(connId, ctx.targetTable, ctx.targetSchema, insertedTotal)
        } catch {
          // Non-blocking post-import refresh
        }
      }
    })()
  })

  renderMappingTable()
  rebuildPreviewAndValidation()

  modal.appendChild(head)
  modal.appendChild(errorBox)
  modal.appendChild(body)
  modal.appendChild(actions)
  ctx.mountModal(modal, () => !isImporting)
  browseBtn.focus?.()
}

export const openImportDataModal = openStudioImportModal
