// src/editor/studio-export.ts
// Export dropdown builder, file metadata resolver, and copy/download dispatch for Datanoa Studio.

import type { ExportFormat } from '../drivers/common/sql-tools.js'
import type { DatabaseDriverType } from '../protocol.js'
import { copyTextFallback, downloadTextFile } from './db-icons.js'
import type { VirtualDataGrid } from './grid.js'
import type { SelectionSummary } from './grid-selection.js'

export interface ExportDropdownOptionsState {
  isShowingSqlResult: boolean
  currentPageRowCount: number
  totalRows: number
  lastSelectionSummary: SelectionSummary | null
}

export interface StudioExportActionContext {
  dataGrid: VirtualDataGrid | null
  driver: DatabaseDriverType
  tableName: string
  updateStatus: (stateText: string) => void
}

export function populateExportDropdownOptions(
  selectEl: HTMLSelectElement | null,
  state: ExportDropdownOptionsState
): void {
  if (!selectEl) return
  selectEl.innerHTML = ''

  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = 'Export...'
  selectEl.appendChild(placeholder)

  const pageScopeLabel = state.isShowingSqlResult
    ? `Copy SQL Result (${state.currentPageRowCount} rows)`
    : `Copy Current Page (${state.currentPageRowCount} / ${state.totalRows} rows)`

  const addGroup = (
    label: string,
    items: ReadonlyArray<{ value: string; label: string }>
  ) => {
    const group = document.createElement('optgroup')
    group.label = label
    for (const optDef of items) {
      const opt = document.createElement('option')
      opt.value = optDef.value
      opt.textContent = optDef.label
      group.appendChild(opt)
    }
    selectEl.appendChild(group)
  }

  addGroup(pageScopeLabel, [
    { value: 'sql-insert', label: 'Copy SQL INSERT' },
    { value: 'sql-update', label: 'Copy SQL UPDATE' },
    { value: 'json', label: 'Copy JSON' },
    { value: 'ndjson', label: 'Copy NDJSON' },
    { value: 'csv', label: 'Copy CSV' },
    { value: 'tsv', label: 'Copy TSV' },
    { value: 'markdown', label: 'Copy Markdown' },
  ])

  addGroup('Download File (Current Page)', [
    { value: 'download:csv', label: 'Download .csv' },
    { value: 'download:json', label: 'Download .json' },
    { value: 'download:sql-insert', label: 'Download .sql (INSERT)' },
    { value: 'download:markdown', label: 'Download .md' },
  ])

  const summary = state.lastSelectionSummary
  if (summary && summary.cellCount > 1) {
    addGroup(
      `Export Selected (${summary.rowCount}×${summary.colCount} · ${summary.cellCount} cells)`,
      [
        { value: 'sel-copy:tsv', label: 'Copy Selected TSV' },
        { value: 'sel-copy:tsv-headers', label: 'Copy Selected TSV + Headers' },
        { value: 'sel-copy:csv', label: 'Copy Selected CSV' },
        { value: 'sel-copy:json', label: 'Copy Selected JSON' },
        { value: 'sel-copy:sql-in', label: 'Copy Selected SQL IN (...)' },
        { value: 'sel-copy:sql-insert', label: 'Copy Selected SQL INSERT' },
        { value: 'sel-download:csv', label: 'Download Selected .csv' },
        { value: 'sel-download:json', label: 'Download Selected .json' },
        { value: 'sel-download:sql-insert', label: 'Download Selected .sql' },
      ]
    )
  }
}

export function getExportFileMeta(
  format: string,
  tableName: string
): { filename: string; mimeType: string } {
  const safeName = tableName.replace(/[^A-Za-z0-9_-]/g, '_') || 'export'
  if (format === 'csv') return { filename: `${safeName}.csv`, mimeType: 'text/csv;charset=utf-8' }
  if (format === 'json')
    return { filename: `${safeName}.json`, mimeType: 'application/json;charset=utf-8' }
  if (format === 'markdown')
    return { filename: `${safeName}.md`, mimeType: 'text/markdown;charset=utf-8' }
  return { filename: `${safeName}.sql`, mimeType: 'text/sql;charset=utf-8' }
}

export function exportStudioFormat(
  ctx: StudioExportActionContext,
  format: ExportFormat
): void {
  if (!ctx.dataGrid) return
  const output = ctx.dataGrid.exportData(format, ctx.tableName, ctx.driver)
  if (!output) {
    ctx.updateStatus('No rows available to export')
    return
  }
  copyTextFallback(output)
  ctx.updateStatus(`Exported as ${format.toUpperCase()} (copied to clipboard)`)
}

export function executeStudioExportAction(
  ctx: StudioExportActionContext,
  actionValue: string
): void {
  if (!ctx.dataGrid || !actionValue) return

  if (actionValue.startsWith('sel-copy:') || actionValue.startsWith('sel-download:')) {
    const isDownload = actionValue.startsWith('sel-download:')
    const rawFmt = actionValue.slice(isDownload ? 'sel-download:'.length : 'sel-copy:'.length)
    if (
      rawFmt !== 'tsv' &&
      rawFmt !== 'tsv-headers' &&
      rawFmt !== 'csv' &&
      rawFmt !== 'json' &&
      rawFmt !== 'sql-in' &&
      rawFmt !== 'sql-insert'
    ) {
      return
    }
    const output = ctx.dataGrid.exportSelection(rawFmt)
    if (!output) {
      ctx.updateStatus('No selected cells to export')
      return
    }
    if (isDownload) {
      const meta = getExportFileMeta(rawFmt, `${ctx.tableName}_selected`)
      void downloadTextFile(output, meta.filename, meta.mimeType).then((status) => {
        if (status === 'cancelled') {
          ctx.updateStatus('Export cancelled')
        } else if (status === 'failed') {
          ctx.updateStatus('Export failed')
        } else {
          ctx.updateStatus(`Saved selected data as ${meta.filename}`)
        }
      })
    } else {
      copyTextFallback(output)
      ctx.updateStatus(`Copied selected cells as ${rawFmt.toUpperCase()}`)
    }
    return
  }

  const isDownload = actionValue.startsWith('download:')
  const rawFmt = actionValue.startsWith('copy:')
    ? actionValue.slice('copy:'.length)
    : isDownload
      ? actionValue.slice('download:'.length)
      : actionValue

  if (
    rawFmt !== 'sql-insert' &&
    rawFmt !== 'sql-update' &&
    rawFmt !== 'json' &&
    rawFmt !== 'ndjson' &&
    rawFmt !== 'csv' &&
    rawFmt !== 'tsv' &&
    rawFmt !== 'markdown'
  ) {
    return
  }

  if (isDownload) {
    const output = ctx.dataGrid.exportData(rawFmt, ctx.tableName, ctx.driver)
    if (!output) {
      ctx.updateStatus('No rows available to download')
      return
    }
    const meta = getExportFileMeta(rawFmt, ctx.tableName)
    void downloadTextFile(output, meta.filename, meta.mimeType).then((status) => {
      if (status === 'cancelled') {
        ctx.updateStatus('Export cancelled')
      } else if (status === 'failed') {
        ctx.updateStatus('Export failed')
      } else {
        ctx.updateStatus(`Saved ${meta.filename}`)
      }
    })
    return
  }

  exportStudioFormat(ctx, rawFmt)
}
