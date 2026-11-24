// src/editor/value-inspector.ts
// Collapsible Cell Value / JSON Inspector Drawer controller for Datanoa Studio.

import { formatJsonPreservingNumbers } from '../shared-grid-paste.js'
import { copyTextFallback, setButtonLoading } from './db-icons.js'
import {
  coerceCellInputValue,
  type SelectedCellInfo,
  type VirtualDataGrid,
} from './grid.js'

export interface ValueInspectorHost {
  getInspectButton: () => HTMLButtonElement | null
  getDataGrid: () => VirtualDataGrid | null
  getActiveTarget: () => {
    connectionId: string | null
    table: string | null
    schema?: string
    page: number
    viewSeq: number
    isShowingSqlResult?: boolean
  }
  updateCell: (params: {
    primaryKeys: Record<string, unknown>
    column: string
    newValue: unknown
    originalValue: unknown
    rowIndex: number
  }) => Promise<{ ok: boolean }>
  reloadTableData: (connId: string, table: string, page: number) => Promise<void>
  updateStatus: (stateText: string) => void
}

const VALUE_INSPECTOR_STORAGE_KEY = 'datanoa.studioValueInspectorPx'
const DEFAULT_INSPECTOR_HEIGHT_PX = 220
const MIN_INSPECTOR_HEIGHT_PX = 140
const MAX_INSPECTOR_HEIGHT_RATIO = 0.75
const FALLBACK_MAX_INSPECTOR_HEIGHT_PX = 560
const INSPECTOR_KEY_STEP_PX = 24

export class ValueInspectorController {
  private readonly host: ValueInspectorHost
  private rootEl: HTMLDivElement | null = null
  private resizerEl: HTMLDivElement | null = null
  private titleEl: HTMLSpanElement | null = null
  private nullBadgeEl: HTMLSpanElement | null = null
  private statusEl: HTMLDivElement | null = null
  private textEl: HTMLTextAreaElement | null = null
  private applyBtn: HTMLButtonElement | null = null
  private nullBtn: HTMLButtonElement | null = null
  private selectedCell: SelectedCellInfo | null = null
  private openState = false
  private savingCell = false
  private userModified = false
  private initialDisplayText = ''
  private heightPx = DEFAULT_INSPECTOR_HEIGHT_PX
  private resizeRafId: number | null = null
  private resizeDragCleanup: (() => void) | null = null
  private boundCleanups: Array<() => void> = []

  constructor(host: ValueInspectorHost) {
    this.host = host
    this.heightPx = this.readPersistedHeight()
  }

  private readPersistedHeight(): number {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(VALUE_INSPECTOR_STORAGE_KEY) : null
      const parsed = raw ? Number(raw) : Number.NaN
      return Number.isFinite(parsed) && parsed >= MIN_INSPECTOR_HEIGHT_PX
        ? Math.round(parsed)
        : DEFAULT_INSPECTOR_HEIGHT_PX
    } catch {
      return DEFAULT_INSPECTOR_HEIGHT_PX
    }
  }

  private persistHeight(px: number): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(VALUE_INSPECTOR_STORAGE_KEY, String(Math.round(px)))
      }
    } catch {
      // Ignore storage quota errors
    }
  }

  private clampHeight(px: number): number {
    const parentH = this.rootEl?.parentElement?.getBoundingClientRect?.().height
    const maxAllowed =
      parentH && Number.isFinite(parentH) && parentH > 0
        ? Math.max(MIN_INSPECTOR_HEIGHT_PX, Math.floor(parentH * MAX_INSPECTOR_HEIGHT_RATIO))
        : FALLBACK_MAX_INSPECTOR_HEIGHT_PX
    return Math.max(MIN_INSPECTOR_HEIGHT_PX, Math.min(maxAllowed, Math.round(px)))
  }

  private applyHeight(px: number, notifyGrid: boolean): void {
    const clamped = this.clampHeight(px)
    this.heightPx = clamped
    if (this.rootEl) {
      this.rootEl.style.height = `${clamped}px`
    }
    this.resizerEl?.setAttribute('aria-valuenow', String(clamped))
    if (notifyGrid) {
      this.host.getDataGrid()?.handleViewportResize()
    }
  }

  private startResizeDrag(e: MouseEvent): void {
    if (!this.rootEl || typeof window === 'undefined') return
    e.preventDefault()
    this.resizeDragCleanup?.()

    const startY = e.clientY
    const rectH = this.rootEl.getBoundingClientRect?.().height
    const startHeight = this.clampHeight(
      rectH && Number.isFinite(rectH) && rectH > 0 ? rectH : this.heightPx
    )
    this.resizerEl?.classList.add('resizing')
    if (typeof document !== 'undefined' && document.body) {
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    }

    const scheduleApply = (nextPx: number) => {
      if (typeof requestAnimationFrame === 'function') {
        if (this.resizeRafId !== null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(this.resizeRafId)
        }
        this.resizeRafId = requestAnimationFrame(() => {
          this.resizeRafId = null
          this.applyHeight(nextPx, true)
        })
      } else {
        this.applyHeight(nextPx, true)
      }
    }

    const onMove = (moveEv: MouseEvent) => {
      scheduleApply(startHeight + (startY - moveEv.clientY))
    }

    const cleanup = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onEnd)
      window.removeEventListener('blur', onEnd)
      if (this.resizeRafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.resizeRafId)
        this.resizeRafId = null
      }
      this.resizerEl?.classList.remove('resizing')
      if (typeof document !== 'undefined' && document.body) {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      if (this.resizeDragCleanup === cleanup) {
        this.resizeDragCleanup = null
      }
    }

    const onEnd = () => {
      cleanup()
      this.persistHeight(this.heightPx)
      this.host.getDataGrid()?.handleViewportResize()
    }

    this.resizeDragCleanup = cleanup
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onEnd)
    window.addEventListener('blur', onEnd)
  }

  private addListener<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    handler: (ev: HTMLElementEventMap[K]) => void
  ): void {
    el.addEventListener(type, handler)
    this.boundCleanups.push(() => el.removeEventListener(type, handler))
  }

  public buildElement(): HTMLDivElement {
    const root = document.createElement('div')
    root.className = 'datanoa-value-inspector'
    root.style.display = 'none'
    this.rootEl = root

    const resizer = document.createElement('div')
    resizer.className = 'datanoa-value-inspector-resizer'
    resizer.setAttribute('role', 'separator')
    resizer.setAttribute('aria-orientation', 'horizontal')
    resizer.setAttribute('aria-label', 'Resize Value Inspector')
    resizer.tabIndex = 0
    resizer.title = 'Drag up or down to resize · Double-click to reset'
    this.resizerEl = resizer
    this.addListener(resizer, 'mousedown', (e) => this.startResizeDrag(e))
    this.addListener(resizer, 'dblclick', () => {
      this.applyHeight(DEFAULT_INSPECTOR_HEIGHT_PX, true)
      this.persistHeight(this.heightPx)
    })
    this.addListener(resizer, 'keydown', (e) => {
      let next: number | null = null
      if (e.key === 'ArrowUp') next = this.heightPx + INSPECTOR_KEY_STEP_PX
      else if (e.key === 'ArrowDown') next = this.heightPx - INSPECTOR_KEY_STEP_PX
      else if (e.key === 'Home') next = MIN_INSPECTOR_HEIGHT_PX
      else if (e.key === 'End') next = FALLBACK_MAX_INSPECTOR_HEIGHT_PX
      if (next !== null) {
        e.preventDefault()
        this.applyHeight(next, true)
        this.persistHeight(this.heightPx)
      }
    })
    root.appendChild(resizer)

    const valHead = document.createElement('div')
    valHead.className = 'datanoa-drawer-head'
    const valTitleWrap = document.createElement('div')
    valTitleWrap.style.display = 'inline-flex'
    valTitleWrap.style.alignItems = 'center'
    valTitleWrap.style.gap = '6px'

    this.titleEl = document.createElement('span')
    this.titleEl.textContent = 'Value Inspector'
    this.nullBadgeEl = document.createElement('span')
    this.nullBadgeEl.className = 'datanoa-null-badge'
    this.nullBadgeEl.textContent = 'NULL'
    this.nullBadgeEl.style.display = 'none'
    valTitleWrap.appendChild(this.titleEl)
    valTitleWrap.appendChild(this.nullBadgeEl)

    const valActions = document.createElement('div')
    valActions.className = 'datanoa-btn-group'

    const valPrettyBtn = document.createElement('button')
    valPrettyBtn.type = 'button'
    valPrettyBtn.className = 'datanoa-btn datanoa-btn-sm'
    valPrettyBtn.textContent = 'Format JSON'
    this.addListener(valPrettyBtn, 'click', () => {
      if (!this.textEl) return
      try {
        this.textEl.value = formatJsonPreservingNumbers(this.textEl.value, 2)
        this.userModified = this.textEl.value !== this.initialDisplayText
        this.syncActionButtons()
        this.updateMeta(false)
      } catch {
        this.host.updateStatus('Value is not valid JSON')
      }
    })

    const valMinifyBtn = document.createElement('button')
    valMinifyBtn.type = 'button'
    valMinifyBtn.className = 'datanoa-btn datanoa-btn-sm'
    valMinifyBtn.textContent = 'Minify JSON'
    this.addListener(valMinifyBtn, 'click', () => {
      if (!this.textEl) return
      try {
        this.textEl.value = formatJsonPreservingNumbers(this.textEl.value, 0)
        this.userModified = this.textEl.value !== this.initialDisplayText
        this.syncActionButtons()
        this.updateMeta(false)
      } catch {
        this.host.updateStatus('Value is not valid JSON')
      }
    })

    this.nullBtn = document.createElement('button')
    this.nullBtn.type = 'button'
    this.nullBtn.className = 'datanoa-btn datanoa-btn-sm'
    this.nullBtn.textContent = 'Set NULL'
    this.addListener(this.nullBtn, 'click', () => {
      void this.applyValue(true)
    })

    this.applyBtn = document.createElement('button')
    this.applyBtn.type = 'button'
    this.applyBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-primary'
    this.applyBtn.textContent = 'Apply'
    this.applyBtn.title = 'Apply edit (Ctrl+Enter)'
    this.addListener(this.applyBtn, 'click', () => {
      void this.applyValue(false)
    })

    const valCopyBtn = document.createElement('button')
    valCopyBtn.type = 'button'
    valCopyBtn.className = 'datanoa-btn datanoa-btn-sm'
    valCopyBtn.textContent = 'Copy'
    this.addListener(valCopyBtn, 'click', () => {
      if (!this.textEl) return
      copyTextFallback(this.textEl.value, valCopyBtn)
      this.host.updateStatus('Copied cell value to clipboard')
    })

    const valCloseBtn = document.createElement('button')
    valCloseBtn.type = 'button'
    valCloseBtn.className = 'datanoa-btn datanoa-btn-sm'
    valCloseBtn.textContent = 'Close'
    this.addListener(valCloseBtn, 'click', () => {
      this.close()
    })

    valActions.appendChild(valPrettyBtn)
    valActions.appendChild(valMinifyBtn)
    valActions.appendChild(this.nullBtn)
    valActions.appendChild(this.applyBtn)
    valActions.appendChild(valCopyBtn)
    valActions.appendChild(valCloseBtn)
    valHead.appendChild(valTitleWrap)
    valHead.appendChild(valActions)

    const valBody = document.createElement('div')
    valBody.className = 'datanoa-value-inspector-body'
    this.textEl = document.createElement('textarea')
    this.textEl.className = 'datanoa-value-textarea'
    this.textEl.spellcheck = false
    this.addListener(this.textEl, 'input', () => {
      this.userModified = true
      this.syncActionButtons()
      this.updateMeta(false)
    })
    this.addListener(this.textEl, 'keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        void this.applyValue(false)
      }
    })
    this.statusEl = document.createElement('div')
    this.statusEl.className = 'datanoa-json-status'
    valBody.appendChild(this.textEl)
    valBody.appendChild(this.statusEl)

    root.appendChild(valHead)
    root.appendChild(valBody)
    return root
  }

  private canApplyCurrentValue(): boolean {
    if (!this.selectedCell?.isEditable || this.savingCell) return false
    if (this.selectedCell.value === null || this.selectedCell.value === undefined) return true
    return this.userModified
  }

  private syncActionButtons(): void {
    const editable = Boolean(this.selectedCell?.isEditable)
    const canSetNull = editable && this.selectedCell?.isNullable !== false
    if (this.applyBtn) this.applyBtn.disabled = !this.canApplyCurrentValue()
    if (this.nullBtn) this.nullBtn.disabled = !canSetNull || this.savingCell
  }

  public getSelectedCell(): SelectedCellInfo | null {
    return this.selectedCell
  }

  public clearSelection(): void {
    this.selectedCell = null
    this.userModified = false
    this.initialDisplayText = ''
    const btn = this.host.getInspectButton()
    if (btn) btn.disabled = true
    this.close()
  }

  public open(info?: SelectedCellInfo): void {
    const target = info ?? this.selectedCell
    if (!target) return
    this.selectedCell = target
    this.openState = true
    const btn = this.host.getInspectButton()
    if (btn) {
      btn.disabled = false
      btn.classList.add('active')
    }
    this.render(target)
    this.textEl?.focus()
  }

  public close(): void {
    const wasOpen = this.openState
    this.openState = false
    if (this.rootEl) {
      this.rootEl.style.display = 'none'
    }
    this.host.getInspectButton()?.classList.remove('active')
    if (wasOpen) {
      this.host.getDataGrid()?.handleViewportResize()
    }
  }

  public toggle(): void {
    if (this.openState) {
      this.close()
      return
    }
    this.open()
  }

  public handleSelectionChanged(info: SelectedCellInfo | null): void {
    this.selectedCell = info
    const btn = this.host.getInspectButton()
    if (btn) {
      btn.disabled = !info
      btn.classList.toggle('active', Boolean(info && this.openState))
    }
    if (!info) {
      this.close()
      return
    }
    if (!this.openState) return
    this.render(info)
  }

  private updateMeta(isNullValue: boolean): void {
    if (this.nullBadgeEl) {
      this.nullBadgeEl.style.display = isNullValue ? 'inline-flex' : 'none'
    }
    if (!this.statusEl || !this.textEl) return
    const text = this.textEl.value
    const chars = text.length
    const lines = text.length === 0 ? 1 : text.split('\n').length
    const trimmed = text.trim()

    let jsonNote = ''
    let statusClass = 'datanoa-json-status'
    if (isNullValue) {
      jsonNote = 'NULL value (distinct from empty string "")'
    } else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(trimmed)
        jsonNote = 'Valid JSON'
        statusClass = 'datanoa-json-status valid'
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid JSON'
        jsonNote = `Invalid JSON: ${msg}`
        statusClass = 'datanoa-json-status invalid'
      }
    }
    this.statusEl.className = statusClass
    this.statusEl.textContent = jsonNote
      ? `${chars} chars · ${lines} line${lines === 1 ? '' : 's'} · ${jsonNote}`
      : `${chars} chars · ${lines} line${lines === 1 ? '' : 's'}`
  }

  private render(info: SelectedCellInfo): void {
    if (!this.rootEl || !this.titleEl || !this.textEl) return
    this.rootEl.style.display = 'flex'
    this.applyHeight(this.heightPx, false)
    const typeLabel = info.columnType ? ` (${info.columnType})` : ''
    this.titleEl.textContent = `Value Inspector · ${info.columnName}${typeLabel} · Row ${info.rowIndex + 1}`

    const isNullVal = info.value === null || info.value === undefined
    let formattedText = ''
    if (isNullVal) {
      formattedText = ''
    } else if (typeof info.value === 'object') {
      try {
        formattedText = JSON.stringify(info.value, null, 2)
      } catch {
        formattedText = String(info.value)
      }
    } else if (typeof info.value === 'string') {
      const trimmed = info.value.trim()
      if (
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
      ) {
        try {
          formattedText = formatJsonPreservingNumbers(trimmed, 2)
        } catch {
          formattedText = info.value
        }
      } else {
        formattedText = info.value
      }
    } else {
      formattedText = String(info.value)
    }

    this.textEl.value = formattedText
    this.initialDisplayText = formattedText
    this.userModified = false
    this.textEl.placeholder = isNullVal ? 'NULL (type to set text value)' : ''
    this.textEl.readOnly = !info.isEditable
    this.syncActionButtons()
    this.updateMeta(isNullVal)
  }

  private async applyValue(setNull: boolean): Promise<void> {
    const grid = this.host.getDataGrid()
    if (this.savingCell || !this.selectedCell || !grid || !this.textEl) return
    const info = this.selectedCell
    if (!info.isEditable) return
    if (setNull && info.isNullable === false) return
    if (!setNull && !this.canApplyCurrentValue()) return

    const nextValue: unknown = setNull
      ? null
      : coerceCellInputValue(this.textEl.value, info.value, info.columnType)

    if (grid.isBatchMode() || grid.getStagedCount() > 0 || info.isInserted) {
      grid.stageCellEdit(info.rowIndex, info.colIndex, nextValue)
      this.initialDisplayText = setNull ? '' : this.textEl.value
      this.userModified = false
      this.syncActionButtons()
      this.updateMeta(setNull)
      this.host.updateStatus(
        setNull ? `Staged NULL for ${info.columnName}` : `Staged edit for ${info.columnName}`
      )
      return
    }

    const model = grid.getModel()
    const target = this.host.getActiveTarget()
    if (!model || !target.connectionId || !target.table) return

    const row = model.rows[info.rowIndex]
    if (!row || model.primaryKey.length === 0) return
    const primaryKeys: Record<string, unknown> = {}
    const rowRecord = !Array.isArray(row) && typeof row === 'object' ? (row as Record<string, unknown>) : null
    model.primaryKey.forEach((pk) => {
      const pkIdx = model.headers.indexOf(pk)
      primaryKeys[pk] = Array.isArray(row) ? row[pkIdx] : rowRecord ? rowRecord[pk] : undefined
    })

    this.savingCell = true
    const triggerBtn = setNull ? this.nullBtn : this.applyBtn
    if (this.applyBtn) this.applyBtn.disabled = true
    if (this.nullBtn) this.nullBtn.disabled = true
    setButtonLoading(triggerBtn, true, 'Saving...')

    try {
      const res = await this.host.updateCell({
        primaryKeys,
        column: info.columnName,
        newValue: nextValue,
        originalValue: info.value,
        rowIndex: info.rowIndex,
      })
      if (res.ok) {
        this.initialDisplayText = setNull ? '' : this.textEl.value
        this.userModified = false
      }
      const latest = this.host.getActiveTarget()
      if (
        res.ok &&
        !latest.isShowingSqlResult &&
        latest.connectionId === target.connectionId &&
        latest.table === target.table &&
        (latest.schema || '') === (target.schema || '') &&
        latest.viewSeq === target.viewSeq
      ) {
        await this.host.reloadTableData(target.connectionId, target.table, target.page)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.host.updateStatus(`Failed to update ${info.columnName}: ${msg}`)
    } finally {
      this.savingCell = false
      setButtonLoading(triggerBtn, false)
      this.syncActionButtons()
    }
  }

  public destroy(): void {
    this.resizeDragCleanup?.()
    this.resizeDragCleanup = null
    while (this.boundCleanups.length > 0) {
      this.boundCleanups.pop()?.()
    }
    this.rootEl = null
    this.resizerEl = null
    this.titleEl = null
    this.nullBadgeEl = null
    this.statusEl = null
    this.textEl = null
    this.applyBtn = null
    this.nullBtn = null
    this.selectedCell = null
    this.openState = false
    this.userModified = false
    this.initialDisplayText = ''
  }
}
