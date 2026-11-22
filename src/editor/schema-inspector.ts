// src/editor/schema-inspector.ts
// Feature F18: Schema Inspector Tab with Live CREATE TABLE DDL Card & Metadata Matrix

import type {
  ColumnInfo,
  DatabaseDriverType,
  ForeignKeyInfo,
  IndexInfo,
  SchemaObject,
  SchemaObjectKind,
  TableDetails,
} from '../protocol.js'
import {
  type DraftColumnItem,
  type DraftForeignKeyItem,
  type DraftIndexItem,
  type ReferentialAction,
  type TableMigrationPlan,
  type TableStructureDraft,
  countTableStructureChanges,
  createInitialTableDraft,
  isDraftColumnDirty,
  reconstructTableDdl,
  validateTableStructureDraft,
} from '../drivers/common/sql-tools.js'

import {
  escapeHtml,
  DDL_KEYWORDS,
  DDL_TYPES,
  DDL_TOKEN_REGEX,
  appendFormattedDdl,
  formatDdlForDisplay,
  COMMON_COLUMN_TYPES,
  REFERENTIAL_ACTIONS,
  normalizeTableDetailsForDraft,
} from './schema-ddl.js'

export {
  escapeHtml,
  DDL_KEYWORDS,
  DDL_TYPES,
  DDL_TOKEN_REGEX,
  appendFormattedDdl,
  formatDdlForDisplay,
  COMMON_COLUMN_TYPES,
  REFERENTIAL_ACTIONS,
  normalizeTableDetailsForDraft,
}

export interface SchemaInspectorOptions {
  dialect?: DatabaseDriverType
  readOnly?: boolean
  referenceTables?: string[]
  onInsertDdl?: (ddl: string) => void
  onCopyDdl?: (ddl: string) => void
  onOpenDdlInConsole?: (ddl: string) => void
  onApplyMigration?: (
    statements: string[],
    draft: TableStructureDraft
  ) => void | Promise<void>
  onDropTable?: () => void
  onTruncateTable?: () => void
}

export class SchemaInspectorView {
  private container: HTMLElement
  private currentDetails: TableDetails | null = null
  private readOnlyObject: SchemaObject | null = null
  private readOnlyObjectDdl = ''
  private currentDialect: DatabaseDriverType = 'sqlite'
  private readOnly = false
  private referenceTables: string[] = []
  private draft: TableStructureDraft | null = null
  private showMigrationPreview = false
  private isLoading = false
  private loadingTableName = ''
  private errorMessage: string | null = null
  private onRetryLoad?: () => void
  private isMigrating = false
  private migrationTimerId: ReturnType<typeof setInterval> | null = null
  private confirmModalBackdrop: HTMLElement | null = null
  private confirmModalKeyCleanup: (() => void) | null = null
  private confirmModalRefs: {
    confirmBtn: HTMLButtonElement
    cancelBtn: HTMLButtonElement
    copyBtn: HTMLButtonElement
    errorBox: HTMLDivElement
    origConfirmLabel: string
  } | null = null
  private activeComboPopover: HTMLElement | null = null
  private comboOutsideCleanup: (() => void) | null = null
  private seqCounter = 1
  private onInsertDdl?: (ddl: string) => void
  private onCopyDdl?: (ddl: string) => void
  private onOpenDdlInConsole?: (ddl: string) => void
  private onApplyMigration?: (
    statements: string[],
    draft: TableStructureDraft
  ) => void | Promise<void>
  private onDropTable?: () => void
  private onTruncateTable?: () => void
  private wheelCleanups: Array<() => void> = []
  private scrollBodyEl: HTMLElement | null = null
  private indexColRefsById = new Map<string, Array<{ colId?: string; fallbackName: string }>>()
  private fkColIdById = new Map<string, string>()
  private stageUiRefs: {
    titleInput?: HTMLInputElement
    applyBtn?: HTMLButtonElement
    revertBtn?: HTMLButtonElement
    previewBtn?: HTMLButtonElement
    previewApplyBtn?: HTMLButtonElement
    previewDrawer?: HTMLElement
    previewPre?: HTMLElement
    validationBar?: HTMLElement
    validationTitle?: HTMLElement
    validationList?: HTMLElement
  } = {}

  constructor(container: HTMLElement, options: SchemaInspectorOptions = {}) {
    this.container = container
    if (options.dialect) this.currentDialect = options.dialect
    this.readOnly = Boolean(options.readOnly)
    if (options.referenceTables) this.referenceTables = [...options.referenceTables]
    this.onInsertDdl = options.onInsertDdl
    this.onCopyDdl = options.onCopyDdl
    this.onOpenDdlInConsole = options.onOpenDdlInConsole
    this.onApplyMigration = options.onApplyMigration
    this.onDropTable = options.onDropTable
    this.onTruncateTable = options.onTruncateTable
  }

  private stopMigrationTimer(): void {
    if (this.migrationTimerId !== null) {
      clearInterval(this.migrationTimerId)
      this.migrationTimerId = null
    }
  }

  private clearWheelListeners(): void {
    for (const cleanup of this.wheelCleanups) {
      cleanup()
    }
    this.wheelCleanups.length = 0
  }

  private closeConfirmModal(force = false): void {
    if (this.isMigrating && !force) return
    this.stopMigrationTimer()
    if (this.confirmModalKeyCleanup) {
      this.confirmModalKeyCleanup()
      this.confirmModalKeyCleanup = null
    }
    if (this.confirmModalBackdrop) {
      this.confirmModalBackdrop.remove()
      this.confirmModalBackdrop = null
    }
    this.confirmModalRefs = null
  }

  private closeComboPopover(): void {
    if (this.comboOutsideCleanup) {
      this.comboOutsideCleanup()
      this.comboOutsideCleanup = null
    }
    if (this.activeComboPopover) {
      this.activeComboPopover.remove()
      this.activeComboPopover = null
    }
  }

  private createComboCellInput(options: {
    value: string
    items: readonly string[]
    placeholder: string
    className: string
    disabled?: boolean
    onChange: (nextVal: string) => void
  }): { wrap: HTMLElement; input: HTMLInputElement } {
    const wrap = document.createElement('div')
    wrap.className = 'datanoa-combo-wrap'

    const input = document.createElement('input')
    input.type = 'text'
    input.className = options.className
    input.value = options.value
    input.disabled = Boolean(options.disabled)
    input.placeholder = options.placeholder
    input.addEventListener('input', () => {
      options.onChange(input.value)
    })

    const toggleBtn = document.createElement('button')
    toggleBtn.type = 'button'
    toggleBtn.className = 'datanoa-combo-toggle'
    toggleBtn.tabIndex = -1
    toggleBtn.disabled = Boolean(options.disabled)
    toggleBtn.title = 'Choose from list'
    toggleBtn.textContent = '▾'

    let comboItemBtns: HTMLButtonElement[] = []
    let comboItemValues: string[] = []
    let highlightedIdx = -1

    const isOwnPopoverOpen = (): boolean => {
      return Boolean(
        this.activeComboPopover &&
          input.dataset?.comboId &&
          this.activeComboPopover.dataset?.ownerId === input.dataset.comboId
      )
    }

    const applyHighlight = (nextIdx: number): void => {
      if (comboItemBtns.length === 0) {
        highlightedIdx = -1
        return
      }
      const wrapped = ((nextIdx % comboItemBtns.length) + comboItemBtns.length) % comboItemBtns.length
      highlightedIdx = wrapped
      comboItemBtns.forEach((btn, idx) => {
        const isHighlighted = idx === highlightedIdx
        btn.classList?.toggle?.('active', isHighlighted)
        btn.classList?.toggle?.('highlighted', isHighlighted)
        btn.setAttribute?.('aria-selected', isHighlighted ? 'true' : 'false')
      })
      comboItemBtns[highlightedIdx]?.scrollIntoView?.({ block: 'nearest' })
    }

    const commitItem = (itemText: string): void => {
      input.value = itemText
      options.onChange(itemText)
      comboItemBtns = []
      comboItemValues = []
      highlightedIdx = -1
      this.closeComboPopover()
    }

    const openMenu = (toggleIfOpen = true) => {
      if (input.disabled) return
      if (this.activeComboPopover) {
        const prevOwner = this.activeComboPopover.dataset?.ownerId
        this.closeComboPopover()
        comboItemBtns = []
        comboItemValues = []
        highlightedIdx = -1
        if (toggleIfOpen && prevOwner === input.dataset?.comboId) return
      }
      if (typeof document === 'undefined' || !document.body) return
      const comboId = `combo_${this.seqCounter++}`
      if (input.dataset) input.dataset.comboId = comboId

      const pop = document.createElement('div')
      pop.className = 'datanoa-combo-popover'
      pop.setAttribute('role', 'listbox')
      if (pop.dataset) pop.dataset.ownerId = comboId

      const currentUpper = input.value.trim().toUpperCase()
      const listItems = options.items.length > 0 ? options.items : ['id']
      comboItemBtns = []
      comboItemValues = [...listItems]
      highlightedIdx = -1

      listItems.forEach((itemText, idx) => {
        const btn = document.createElement('button')
        btn.type = 'button'
        const isCurrent = itemText.trim().toUpperCase() === currentUpper
        if (isCurrent && highlightedIdx === -1) {
          highlightedIdx = idx
        }
        btn.className = `datanoa-combo-item${isCurrent ? ' active' : ''}`
        btn.setAttribute('role', 'option')
        btn.setAttribute('aria-selected', isCurrent ? 'true' : 'false')
        btn.textContent = itemText
        btn.addEventListener('mousedown', (e: MouseEvent) => {
          e.preventDefault()
          e.stopPropagation()
          commitItem(itemText)
        })
        btn.addEventListener('mouseenter', () => {
          applyHighlight(idx)
        })
        comboItemBtns.push(btn)
        pop.appendChild(btn)
      })

      if (highlightedIdx === -1 && comboItemBtns.length > 0) {
        applyHighlight(0)
      }

      document.body.appendChild(pop)
      this.activeComboPopover = pop

      if (typeof wrap.getBoundingClientRect === 'function') {
        const rect = wrap.getBoundingClientRect()
        const vh = typeof window !== 'undefined' ? window.innerHeight || 768 : 768
        const vw = typeof window !== 'undefined' ? window.innerWidth || 1024 : 1024
        const popHeight = Math.min(224, listItems.length * 26 + 8)
        const popWidth = Math.max(156, Math.round(rect.width))
        const top =
          rect.bottom + popHeight + 8 > vh && rect.top > popHeight
            ? Math.max(6, Math.round(rect.top - popHeight - 2))
            : Math.round(rect.bottom + 2)
        const left = Math.max(6, Math.min(Math.round(rect.left), vw - popWidth - 8))
        pop.style.top = `${top}px`
        pop.style.left = `${left}px`
        pop.style.minWidth = `${popWidth}px`
      }

      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        const onDocMouseDown = (ev: MouseEvent) => {
          const target = ev.target instanceof Node ? ev.target : null
          if (target && (wrap.contains?.(target) || pop.contains?.(target))) return
          this.closeComboPopover()
        }
        window.addEventListener('mousedown', onDocMouseDown, true)
        this.comboOutsideCleanup = () => {
          window.removeEventListener('mousedown', onDocMouseDown, true)
        }
      }
    }

    toggleBtn.addEventListener?.('click', (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      openMenu(true)
    })

    input.addEventListener?.('keydown', (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (!isOwnPopoverOpen()) {
          openMenu(false)
        } else {
          applyHighlight(highlightedIdx + 1)
        }
      } else if (e.key === 'ArrowUp') {
        if (isOwnPopoverOpen()) {
          e.preventDefault()
          applyHighlight(highlightedIdx - 1)
        }
      } else if (e.key === 'Enter') {
        if (isOwnPopoverOpen() && highlightedIdx >= 0 && highlightedIdx < comboItemValues.length) {
          e.preventDefault()
          commitItem(comboItemValues[highlightedIdx])
        }
      } else if (e.key === 'Escape') {
        if (isOwnPopoverOpen()) {
          e.preventDefault()
          e.stopPropagation()
          this.closeComboPopover()
        }
      }
    })

    wrap.appendChild(input)
    wrap.appendChild(toggleBtn)
    return { wrap, input }
  }

  private bindHorizontalWheel(el: HTMLElement): void {
    if (typeof el.addEventListener !== 'function') return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
      if (!raw) return
      const step =
        e.deltaMode === 1 ? raw * 28 : e.deltaMode === 2 ? raw * 320 : raw * 1.25
      el.scrollLeft += step
      e.preventDefault()
      e.stopPropagation()
    }
    const onHorizScroll = () => {
      this.closeComboPopover()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('scroll', onHorizScroll, { passive: true })
    this.wheelCleanups.push(() => {
      el.removeEventListener?.('wheel', onWheel)
      el.removeEventListener?.('scroll', onHorizScroll)
    })
  }

  public setDialect(dialect: DatabaseDriverType): void {
    this.currentDialect = dialect
    this.refreshStageControls()
  }

  public setReadOnly(readOnly: boolean): void {
    this.readOnly = Boolean(readOnly)
    if (this.currentDetails) {
      this.render()
    }
  }

  public setReferenceTables(tables: string[]): void {
    this.referenceTables = [...tables]
  }

  public isMigrationInFlight(): boolean {
    return this.isMigrating
  }

  public isConfirmModalOpen(): boolean {
    return this.confirmModalBackdrop !== null
  }

  public closeConfirmModalIfIdle(): boolean {
    if (this.isMigrating) return false
    this.closeConfirmModal(false)
    return true
  }

  public setLoading(loading: boolean, tableName?: string): void {
    this.isLoading = Boolean(loading)
    this.loadingTableName = tableName || ''
    if (this.isLoading) {
      this.errorMessage = null
      this.onRetryLoad = undefined
      this.closeConfirmModal(true)
      this.closeComboPopover()
      this.scrollBodyEl = null
      this.currentDetails = null
      this.readOnlyObject = null
      this.readOnlyObjectDdl = ''
      this.draft = null
    }
    this.render()
  }

  public setError(message: string, onRetry?: () => void): void {
    this.isLoading = false
    this.loadingTableName = ''
    this.errorMessage = message || 'Failed to load table schema.'
    this.onRetryLoad = onRetry
    this.closeConfirmModal(true)
    this.closeComboPopover()
    this.scrollBodyEl = null
    this.readOnlyObject = null
    this.readOnlyObjectDdl = ''
    this.render()
  }

  public setDetails(details: TableDetails, dialect?: DatabaseDriverType): void {
    if (dialect) this.currentDialect = dialect
    this.isLoading = false
    this.loadingTableName = ''
    this.errorMessage = null
    this.onRetryLoad = undefined
    this.readOnlyObject = null
    this.readOnlyObjectDdl = ''
    this.currentDetails = details
    this.draft = createInitialTableDraft(normalizeTableDetailsForDraft(details))
    this.initDraftColumnRefs(this.draft)
    this.showMigrationPreview = false
    this.closeConfirmModal(true)
    this.closeComboPopover()
    this.scrollBodyEl = null
    this.render()
  }

  public setReadOnlyObjectDdl(
    obj: SchemaObject,
    ddl: string,
    dialect: DatabaseDriverType
  ): void {
    this.currentDialect = dialect
    this.readOnlyObject = { ...obj }
    this.readOnlyObjectDdl = ddl || ''
    this.isLoading = false
    this.loadingTableName = ''
    this.errorMessage = null
    this.onRetryLoad = undefined
    this.currentDetails = null
    this.draft = null
    this.indexColRefsById.clear()
    this.fkColIdById.clear()
    this.showMigrationPreview = false
    this.closeConfirmModal(true)
    this.closeComboPopover()
    this.scrollBodyEl = null
    this.render()
  }

  public getStagedChangeCount(): number {
    if (!this.draft) return 0
    return countTableStructureChanges(this.draft)
  }

  public async applyStagedChanges(): Promise<void> {
    if (!this.draft || this.isMigrating) return
    this.openMigrationConfirmModal()
  }

  private setModalConfirmBusy(busy: boolean, elapsedLabel?: string): void {
    const refs = this.confirmModalRefs
    if (!refs) return
    if (busy) {
      refs.confirmBtn.disabled = true
      refs.cancelBtn.disabled = true
      refs.copyBtn.disabled = true
      refs.confirmBtn.classList?.add?.('is-loading')
      const text = elapsedLabel || 'Executing migration... 0.0s'
      let timerSpan = refs.confirmBtn.querySelector?.('.datanoa-live-timer')
      if (!timerSpan) {
        refs.confirmBtn.innerHTML = ''
        const spinner = document.createElement('span')
        spinner.className = 'datanoa-spinner'
        spinner.setAttribute('aria-hidden', 'true')
        timerSpan = document.createElement('span')
        timerSpan.className = 'datanoa-live-timer'
        refs.confirmBtn.appendChild(spinner)
        refs.confirmBtn.appendChild(timerSpan)
      }
      timerSpan.textContent = text
    } else {
      refs.confirmBtn.classList?.remove?.('is-loading')
      refs.confirmBtn.textContent = refs.origConfirmLabel
      refs.confirmBtn.disabled = false
      refs.cancelBtn.disabled = false
      refs.copyBtn.disabled = false
    }
  }

  private async executeValidatedMigration(plan: TableMigrationPlan): Promise<void> {
    if (this.isMigrating || !this.draft || !plan.valid || plan.statements.length === 0) return

    this.isMigrating = true
    if (this.confirmModalRefs) {
      this.confirmModalRefs.errorBox.style.display = 'none'
      this.confirmModalRefs.errorBox.textContent = ''
    }
    this.setModalConfirmBusy(true, 'Executing migration... 0.0s')
    if (this.stageUiRefs.applyBtn) this.stageUiRefs.applyBtn.disabled = true
    if (this.stageUiRefs.revertBtn) this.stageUiRefs.revertBtn.disabled = true
    if (this.stageUiRefs.previewApplyBtn) this.stageUiRefs.previewApplyBtn.disabled = true

    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
    this.stopMigrationTimer()
    this.migrationTimerId = setInterval(() => {
      if (!this.isMigrating) return
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const elapsedSec = ((now - startedAt) / 1000).toFixed(1)
      this.setModalConfirmBusy(true, `Executing migration... ${elapsedSec}s`)
    }, 100)

    try {
      if (this.onApplyMigration) {
        await this.onApplyMigration(plan.statements, this.draft)
      }
      this.stopMigrationTimer()
      this.isMigrating = false
      this.closeConfirmModal(true)
      this.refreshStageControls()
    } catch (err: unknown) {
      this.stopMigrationTimer()
      this.isMigrating = false
      this.setModalConfirmBusy(false)
      this.refreshStageControls()
      const msg = err instanceof Error ? err.message : String(err)
      if (this.confirmModalRefs) {
        this.confirmModalRefs.errorBox.innerHTML = ''
        const errTitle = document.createElement('strong')
        errTitle.style.color = 'var(--danger)'
        errTitle.textContent = 'Migration Execution Failed:'
        const errText = document.createElement('div')
        errText.style.marginTop = '4px'
        errText.style.fontFamily = 'var(--mono-font)'
        errText.style.whiteSpace = 'pre-wrap'
        errText.style.wordBreak = 'break-word'
        errText.textContent = msg
        this.confirmModalRefs.errorBox.appendChild(errTitle)
        this.confirmModalRefs.errorBox.appendChild(errText)
        this.confirmModalRefs.errorBox.style.display = 'block'
      }
    }
  }

  private openMigrationConfirmModal(): void {
    if (!this.draft || this.isMigrating) return
    const count = countTableStructureChanges(this.draft)
    if (count === 0) return

    this.closeConfirmModal()
    const plan = validateTableStructureDraft(
      this.draft,
      this.currentDialect,
      this.referenceTables
    )

    const backdrop = document.createElement('div')
    backdrop.className = 'datanoa-modal-backdrop'
    backdrop.setAttribute('role', 'alertdialog')
    backdrop.setAttribute('aria-modal', 'true')

    const modal = document.createElement('div')
    modal.className = 'datanoa-struct-confirm-modal'

    const head = document.createElement('div')
    head.className = 'datanoa-modal-head'
    const headTitle = document.createElement('span')
    headTitle.textContent = plan.valid
      ? `Confirm Schema Migration — ${this.draft.originalTableName}`
      : `Invalid Schema Changes — ${this.draft.originalTableName}`
    const dialectBadge = document.createElement('span')
    dialectBadge.className = 'datanoa-badge datanoa-badge-pk'
    dialectBadge.textContent = `${this.currentDialect.toUpperCase()} · ${count} change(s)`
    head.appendChild(headTitle)
    head.appendChild(dialectBadge)

    const body = document.createElement('div')
    body.className = 'datanoa-modal-body'

    // 0. Runtime Execution Error Box (shown if onApplyMigration throws)
    const execErrorBox = document.createElement('div')
    execErrorBox.className = 'datanoa-modal-box error datanoa-struct-exec-error'
    execErrorBox.setAttribute('role', 'alert')
    execErrorBox.style.display = 'none'
    body.appendChild(execErrorBox)

    // 1. Validation Errors (Blocking)
    if (plan.errors.length > 0) {
      const errBox = document.createElement('div')
      errBox.className = 'datanoa-modal-box error'
      const errTitle = document.createElement('strong')
      errTitle.style.color = 'var(--danger)'
      errTitle.textContent = `Blocking Validation Errors (${plan.errors.length}) — Fix before applying:`
      const errList = document.createElement('ul')
      errList.className = 'datanoa-modal-list'
      for (const errMsg of plan.errors) {
        const li = document.createElement('li')
        li.textContent = errMsg
        errList.appendChild(li)
      }
      errBox.appendChild(errTitle)
      errBox.appendChild(errList)
      body.appendChild(errBox)
    }

    // 2. Risk Warnings
    if (plan.warnings.length > 0) {
      const warnBox = document.createElement('div')
      warnBox.className = 'datanoa-modal-box warn'
      const warnTitle = document.createElement('strong')
      warnTitle.style.color = 'var(--warn)'
      warnTitle.textContent = `Impact & Safety Warnings (${plan.warnings.length}):`
      const warnList = document.createElement('ul')
      warnList.className = 'datanoa-modal-list'
      for (const w of plan.warnings) {
        const li = document.createElement('li')
        li.textContent = w
        warnList.appendChild(li)
      }
      warnBox.appendChild(warnTitle)
      warnBox.appendChild(warnList)
      body.appendChild(warnBox)
    }

    // 3. Readable Change Diff Summary
    if (plan.changeSummaries.length > 0) {
      const diffBox = document.createElement('div')
      diffBox.className = 'datanoa-modal-box'
      const diffTitle = document.createElement('strong')
      diffTitle.textContent = `Summary of Changes (${plan.changeSummaries.length}):`
      const diffList = document.createElement('ul')
      diffList.className = 'datanoa-modal-list'
      for (const item of plan.changeSummaries) {
        const li = document.createElement('li')
        li.style.fontFamily = 'var(--mono-font)'
        li.textContent = item
        diffList.appendChild(li)
      }
      diffBox.appendChild(diffTitle)
      diffBox.appendChild(diffList)
      body.appendChild(diffBox)
    }

    // 4. Exact SQL Script Preview
    const sqlLabel = document.createElement('div')
    sqlLabel.style.fontWeight = '600'
    sqlLabel.textContent = 'Generated Migration SQL:'
    const sqlPre = document.createElement('pre')
    sqlPre.className = 'datanoa-modal-sql'
    sqlPre.textContent =
      plan.statements.length > 0
        ? plan.statements.join('\n\n')
        : '-- Fix validation errors above to generate valid migration SQL.'
    body.appendChild(sqlLabel)
    body.appendChild(sqlPre)

    // 5. Actions Footer
    const actions = document.createElement('div')
    actions.className = 'datanoa-modal-actions'

    const copyBtn = document.createElement('button')
    copyBtn.type = 'button'
    copyBtn.className = 'datanoa-btn datanoa-btn-sm'
    copyBtn.textContent = 'Copy SQL'
    copyBtn.disabled = plan.statements.length === 0
    copyBtn.addEventListener?.('click', () => {
      if (this.isMigrating) return
      this.copyTextToClipboard(plan.statements.join('\n\n'))
      copyBtn.textContent = 'Copied!'
      setTimeout(() => {
        if (!this.isMigrating) {
          copyBtn.textContent = 'Copy SQL'
        }
      }, 1200)
    })

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-struct-confirm-cancel-btn'
    cancelBtn.textContent = 'Back to Edit'
    cancelBtn.addEventListener?.('click', () => {
      if (this.isMigrating) return
      this.closeConfirmModal()
    })

    const hasDestructiveDrop =
      this.draft.columns.some((c) => c.status === 'deleted') ||
      this.draft.foreignKeys.some((fk) => fk.status === 'deleted')

    const confirmLabel = plan.valid ? 'Confirm & Execute' : 'Fix Errors to Apply'
    const confirmBtn = document.createElement('button')
    confirmBtn.type = 'button'
    confirmBtn.className = `datanoa-btn datanoa-btn-sm datanoa-struct-confirm-execute-btn ${
      hasDestructiveDrop ? 'datanoa-btn-danger-solid' : 'datanoa-btn-primary'
    }`
    confirmBtn.textContent = confirmLabel
    confirmBtn.disabled = !plan.valid || plan.statements.length === 0
    confirmBtn.addEventListener?.('click', () => {
      void this.executeValidatedMigration(plan)
    })

    actions.appendChild(copyBtn)
    actions.appendChild(cancelBtn)
    actions.appendChild(confirmBtn)

    modal.appendChild(head)
    modal.appendChild(body)
    modal.appendChild(actions)
    backdrop.appendChild(modal)

    backdrop.addEventListener?.('click', (e: MouseEvent) => {
      if (e.target === backdrop && !this.isMigrating) {
        this.closeConfirmModal()
      }
    })

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onModalKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') {
          ev.preventDefault()
          ev.stopPropagation()
          if (!this.isMigrating) {
            this.closeConfirmModal()
          }
        }
      }
      window.addEventListener('keydown', onModalKeyDown, true)
      this.confirmModalKeyCleanup = () => {
        window.removeEventListener('keydown', onModalKeyDown, true)
      }
    }

    this.confirmModalRefs = {
      confirmBtn,
      cancelBtn,
      copyBtn,
      errorBox: execErrorBox,
      origConfirmLabel: confirmLabel,
    }
    this.confirmModalBackdrop = backdrop
    this.container.appendChild(backdrop)
  }

  public revertStagedChanges(): void {
    if (!this.currentDetails || this.isMigrating) return
    this.closeConfirmModal()
    this.draft = createInitialTableDraft(normalizeTableDetailsForDraft(this.currentDetails))
    this.initDraftColumnRefs(this.draft)
    this.showMigrationPreview = false
    this.render()
  }

  private copyTextToClipboard(text: string): void {
    if (typeof document !== 'undefined' && document.body) {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.top = '-9999px'
      ta.style.left = '-9999px'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      try {
        if (typeof ta.setSelectionRange === 'function') {
          ta.setSelectionRange(0, text.length)
        }
        document.execCommand?.('copy')
      } catch {
        // Ignore fallback failure
      }
      ta.remove()
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void Promise.resolve(navigator.clipboard.writeText(text)).catch(() => {})
    }
    this.onCopyDdl?.(text)
  }

  public clear(): void {
    this.clearWheelListeners()
    this.stopMigrationTimer()
    this.isMigrating = false
    this.closeConfirmModal(true)
    this.closeComboPopover()
    this.isLoading = false
    this.loadingTableName = ''
    this.errorMessage = null
    this.onRetryLoad = undefined
    this.scrollBodyEl = null
    this.currentDetails = null
    this.readOnlyObject = null
    this.readOnlyObjectDdl = ''
    this.draft = null
    this.indexColRefsById.clear()
    this.fkColIdById.clear()
    this.stageUiRefs = {}
    this.render()
  }

  private initDraftColumnRefs(draft: TableStructureDraft): void {
    this.indexColRefsById.clear()
    this.fkColIdById.clear()
    const findColByName = (rawName: string): DraftColumnItem | undefined => {
      const target = rawName.trim()
      if (!target) return undefined
      return (
        draft.columns.find((c) => c.name.trim() === target) ||
        draft.columns.find((c) => c.name.trim().toLowerCase() === target.toLowerCase())
      )
    }

    for (const idx of draft.indexes) {
      const refs = (idx.columns || []).map((colName) => {
        const matched = findColByName(colName)
        return matched
          ? { colId: matched.id, fallbackName: colName.trim() }
          : { fallbackName: colName.trim() }
      })
      this.indexColRefsById.set(idx.id, refs)
    }

    for (const fk of draft.foreignKeys) {
      const matched = findColByName(fk.column || '')
      if (matched) {
        this.fkColIdById.set(fk.id, matched.id)
      }
    }
  }

  private resolveIndexColumnNames(draft: TableStructureDraft, idx: DraftIndexItem): string[] {
    const refs = this.indexColRefsById.get(idx.id)
    if (!refs) return idx.columns
    const colById = new Map<string, DraftColumnItem>()
    for (const col of draft.columns) {
      colById.set(col.id, col)
    }
    const resolved: string[] = []
    for (const ref of refs) {
      if (ref.colId) {
        const col = colById.get(ref.colId)
        const name = col ? col.name.trim() : ref.fallbackName
        if (name) resolved.push(name)
      } else if (ref.fallbackName) {
        resolved.push(ref.fallbackName)
      }
    }
    return resolved
  }

  private syncColumnRenameInDraft(colId: string, nextColName: string): void {
    if (!this.draft || !colId) return
    const next = nextColName.trim()
    const displayLabel = next || '(unnamed)'

    for (const idx of this.draft.indexes) {
      if (this.indexColRefsById.has(idx.id)) {
        idx.columns = this.resolveIndexColumnNames(this.draft, idx)
      }
    }
    for (const fk of this.draft.foreignKeys) {
      if (this.fkColIdById.get(fk.id) === colId) {
        fk.column = next
      }
    }

    // Update visible pill, FK option & existing constraint labels in place by stable col.id
    const pillButtons = Array.from(this.container.querySelectorAll?.('.datanoa-col-pill') || [])
    for (const pill of pillButtons) {
      if (pill instanceof HTMLElement && pill.dataset.colId === colId) {
        pill.textContent = displayLabel
      }
    }
    const fkOptions = Array.from(
      this.container.querySelectorAll?.('.datanoa-fk-col-select option') || []
    )
    for (const opt of fkOptions) {
      if (opt instanceof HTMLOptionElement && opt.dataset.colId === colId) {
        opt.value = next
        opt.textContent = displayLabel
      }
    }
    const idxCells = Array.from(
      this.container.querySelectorAll?.('[data-struct-idx-cols]') || []
    )
    for (const cell of idxCells) {
      if (cell instanceof HTMLElement) {
        const idxId = cell.dataset.structIdxCols
        const idx = this.draft.indexes.find((item) => item.id === idxId)
        if (idx) {
          cell.textContent = (idx.columns || []).join(', ')
        }
      }
    }
    const fkCells = Array.from(
      this.container.querySelectorAll?.('[data-struct-fk-col]') || []
    )
    for (const cell of fkCells) {
      if (cell instanceof HTMLElement) {
        const fkId = cell.dataset.structFkCol
        const fk = this.draft.foreignKeys.find((item) => item.id === fkId)
        if (fk) {
          cell.textContent = fk.column || '(unnamed)'
        }
      }
    }
  }

  private refreshStageControls(): void {
    if (!this.draft) return
    const count = countTableStructureChanges(this.draft)
    const plan = validateTableStructureDraft(
      this.draft,
      this.currentDialect,
      this.referenceTables
    )
    const {
      titleInput,
      applyBtn,
      revertBtn,
      previewBtn,
      previewApplyBtn,
      previewDrawer,
      previewPre,
      validationBar,
      validationTitle,
      validationList,
    } = this.stageUiRefs

    if (titleInput) {
      const isTitleDirty =
        titleInput.value.trim().length > 0 &&
        titleInput.value.trim() !== this.draft.originalTableName.trim()
      titleInput.classList?.toggle?.('dirty', isTitleDirty)
    }

    if (applyBtn) {
      applyBtn.textContent =
        plan.errors.length > 0 && count > 0
          ? `Fix Errors (${plan.errors.length}) [${count}]`
          : `Review & Apply [${count}]`
      applyBtn.disabled = count === 0 || this.isMigrating
      applyBtn.classList?.toggle?.('datanoa-btn-primary', count > 0 && plan.errors.length === 0)
      applyBtn.classList?.toggle?.('datanoa-btn-danger', count > 0 && plan.errors.length > 0)
    }

    if (previewApplyBtn) {
      previewApplyBtn.disabled = count === 0 || this.isMigrating
      previewApplyBtn.textContent =
        plan.errors.length > 0 ? `Fix Errors (${plan.errors.length})` : `Review & Apply [${count}]`
    }

    if (revertBtn) {
      revertBtn.disabled = count === 0 || this.isMigrating
    }

    if (previewBtn) {
      previewBtn.classList?.toggle?.('active', this.showMigrationPreview)
    }

    if (validationBar && validationTitle && validationList) {
      validationBar.style.display = count > 0 && plan.errors.length > 0 ? 'flex' : 'none'
      validationTitle.textContent = `Validation Notice (${plan.errors.length} issue${plan.errors.length === 1 ? '' : 's'} must be resolved before applying):`
      validationList.innerHTML = ''
      for (const errText of plan.errors) {
        const li = document.createElement('li')
        li.textContent = errText
        validationList.appendChild(li)
      }
    }

    if (previewDrawer && previewPre) {
      previewDrawer.style.display = this.showMigrationPreview ? 'block' : 'none'
      if (this.showMigrationPreview) {
        if (plan.errors.length > 0) {
          previewPre.textContent = plan.errors.map((e) => `-- Validation Error: ${e}`).join('\n')
        } else {
          previewPre.textContent =
            plan.statements.length > 0
              ? plan.statements.join('\n\n')
              : '-- No staged structure changes yet. Edit columns, defaults, indexes, or foreign keys below.'
        }
      }
    }
  }

  public render(): void {
    const prevScrollTop = this.scrollBodyEl ? this.scrollBodyEl.scrollTop : 0
    this.clearWheelListeners()
    this.closeComboPopover()
    this.scrollBodyEl = null
    this.container.innerHTML = ''
    this.stageUiRefs = {}
    if (this.isLoading) {
      const topZone = document.createElement('div')
      topZone.className = 'datanoa-inspector-top-zone'
      const headerEl = document.createElement('div')
      headerEl.className = 'datanoa-inspector-header'
      const titleEl = document.createElement('div')
      titleEl.className = 'datanoa-inspector-title'
      titleEl.textContent = this.loadingTableName
        ? `Loading schema for "${this.loadingTableName}"...`
        : 'Loading table schema...'
      headerEl.appendChild(titleEl)
      topZone.appendChild(headerEl)
      this.container.appendChild(topZone)

      const skelWrap = document.createElement('div')
      skelWrap.className = 'datanoa-inspector-skeleton'
      for (const rowsCount of [6, 2]) {
        const card = document.createElement('div')
        card.className = 'datanoa-inspector-skeleton-card'
        for (let r = 0; r < rowsCount; r++) {
          const bar = document.createElement('div')
          bar.className = 'datanoa-skeleton-bar'
          bar.style.width = `${65 + ((r * 13) % 30)}%`
          card.appendChild(bar)
        }
        skelWrap.appendChild(card)
      }
      this.container.appendChild(skelWrap)
      return
    }
    if (this.errorMessage) {
      const topZone = document.createElement('div')
      topZone.className = 'datanoa-inspector-top-zone'
      const headerEl = document.createElement('div')
      headerEl.className = 'datanoa-inspector-header'
      const titleEl = document.createElement('div')
      titleEl.className = 'datanoa-inspector-title'
      titleEl.textContent = 'Schema Inspector'
      headerEl.appendChild(titleEl)
      topZone.appendChild(headerEl)
      this.container.appendChild(topZone)

      const scrollBody = document.createElement('div')
      scrollBody.className = 'datanoa-inspector-scroll-body'

      const errCard = document.createElement('div')
      errCard.className = 'datanoa-modal-box error datanoa-inspector-error-card'
      errCard.setAttribute('role', 'alert')
      const errTitle = document.createElement('strong')
      errTitle.style.color = 'var(--danger)'
      errTitle.textContent = 'Failed to Load Table Schema'
      const errDetail = document.createElement('div')
      errDetail.style.marginTop = '6px'
      errDetail.style.fontFamily = 'var(--mono-font)'
      errDetail.style.whiteSpace = 'pre-wrap'
      errDetail.style.wordBreak = 'break-word'
      errDetail.textContent = this.errorMessage
      errCard.appendChild(errTitle)
      errCard.appendChild(errDetail)

      if (this.onRetryLoad) {
        const retryRow = document.createElement('div')
        retryRow.style.marginTop = '10px'
        const retryBtn = document.createElement('button')
        retryBtn.type = 'button'
        retryBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-error-retry-btn'
        retryBtn.textContent = 'Retry'
        const retryHandler = this.onRetryLoad
        retryBtn.addEventListener?.('click', () => {
          retryHandler()
        })
        retryRow.appendChild(retryBtn)
        errCard.appendChild(retryRow)
      }

      scrollBody.appendChild(errCard)
      this.container.appendChild(scrollBody)
      return
    }
    if (this.readOnlyObject) {
      this.renderReadOnlyObjectDdl()
      return
    }
    if (!this.currentDetails) {
      const empty = document.createElement('div')
      empty.className = 'datanoa-cell-null'
      empty.style.padding = '20px'
      empty.textContent = 'No table selected for schema inspection.'
      this.container.appendChild(empty)
      return
    }

    const { name, schema, kind, columns, primaryKey = [], indexes = [], foreignKeys = [] } =
      this.currentDetails

    if (!this.draft) {
      this.draft = createInitialTableDraft(normalizeTableDetailsForDraft(this.currentDetails))
      this.initDraftColumnRefs(this.draft)
    }

    const canEditStructure =
      !this.readOnly &&
      kind === 'table' &&
      this.currentDialect !== 'redis' &&
      Boolean(this.onApplyMigration) &&
      typeof this.container.addEventListener === 'function'

    const topZone = document.createElement('div')
    topZone.className = 'datanoa-inspector-top-zone'

    const scrollBody = document.createElement('div')
    scrollBody.className = 'datanoa-inspector-scroll-body'
    this.scrollBodyEl = scrollBody
    scrollBody.addEventListener?.('scroll', () => {
      this.closeComboPopover()
    })

    // 1. Header with Inline Table Name & Staged Structure Action Bar
    const headerEl = document.createElement('div')
    headerEl.className = 'datanoa-inspector-header'

    const titleEl = document.createElement('div')
    titleEl.className = 'datanoa-inspector-title-group'

    if (canEditStructure && this.draft) {
      if (schema) {
        const schemaSpan = document.createElement('span')
        schemaSpan.style.color = 'var(--muted)'
        schemaSpan.style.fontFamily = 'var(--mono-font)'
        schemaSpan.style.fontSize = '13px'
        schemaSpan.textContent = `${schema}.`
        titleEl.appendChild(schemaSpan)
      }
      const nameInput = document.createElement('input')
      nameInput.type = 'text'
      nameInput.className = 'datanoa-struct-title-input datanoa-edit-table-name-input'
      nameInput.value = this.draft.tableName
      nameInput.title = 'Table Name — edit inline and click Apply [N] (or Ctrl+S) to rename'
      nameInput.placeholder = 'Table name...'
      if (typeof nameInput.addEventListener === 'function') {
        nameInput.addEventListener('input', () => {
          if (!this.draft) return
          this.draft.tableName = nameInput.value
          this.refreshStageControls()
        })
      }
      this.stageUiRefs.titleInput = nameInput
      titleEl.appendChild(nameInput)
    } else {
      const nameSpan = document.createElement('span')
      nameSpan.className = 'datanoa-inspector-title'
      nameSpan.textContent = `${schema ? `${schema}.` : ''}${name}`
      titleEl.appendChild(nameSpan)
    }

    const kindBadge = document.createElement('span')
    kindBadge.className = 'datanoa-badge'
    kindBadge.style.background = 'var(--card)'
    kindBadge.style.border = '1px solid var(--border)'
    kindBadge.style.color = 'var(--text)'
    kindBadge.textContent = (kind || 'table').toUpperCase()
    titleEl.appendChild(kindBadge)

    if (primaryKey && primaryKey.length > 0) {
      const pkBadge = document.createElement('span')
      pkBadge.className = 'datanoa-badge datanoa-badge-pk'
      pkBadge.textContent =
        primaryKey.length > 1 ? `Composite PK (${primaryKey.join(', ')})` : `PK: ${primaryKey[0]}`
      titleEl.appendChild(pkBadge)
    }

    const metaSummary = document.createElement('span')
    metaSummary.style.fontSize = '12px'
    metaSummary.style.color = 'var(--muted)'
    metaSummary.textContent = `${columns.length} cols · ${indexes.length} idx · ${foreignKeys.length} fk`
    titleEl.appendChild(metaSummary)

    const headerRight = document.createElement('div')
    headerRight.className = 'datanoa-struct-toolbar'

    if (canEditStructure && this.draft) {
      const addColBtn = document.createElement('button')
      addColBtn.type = 'button'
      addColBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-add-col-btn'
      addColBtn.textContent = '+ Column'
      addColBtn.addEventListener?.('click', () => {
        if (!this.draft) return
        const nextNum = this.draft.columns.length + 1
        this.draft.columns.push({
          id: `new_col_${this.seqCounter++}`,
          name: `col_${nextNum}`,
          dataType: 'TEXT',
          nullable: true,
          defaultValue: '',
          isPrimaryKey: false,
          status: 'new',
        })
        this.render()
      })

      const addIdxBtn = document.createElement('button')
      addIdxBtn.type = 'button'
      addIdxBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-add-idx-btn'
      addIdxBtn.textContent = '+ Index / Key'
      addIdxBtn.addEventListener?.('click', () => {
        if (!this.draft) return
        const activeCols = this.draft.columns.filter((c) => c.status !== 'deleted')
        const firstColItem = activeCols[0]
        const firstCol = firstColItem?.name || 'id'
        const tbl = (this.draft.tableName || this.draft.originalTableName).trim()
        const newIdxId = `new_idx_${this.seqCounter++}`
        this.draft.indexes.push({
          id: newIdxId,
          name: `idx_${tbl}_${firstCol}`.replace(/[^A-Za-z0-9_]/g, '_'),
          columns: [firstCol],
          unique: false,
          isPrimary: false,
          status: 'new',
        })
        this.indexColRefsById.set(
          newIdxId,
          firstColItem ? [{ colId: firstColItem.id, fallbackName: firstCol }] : [{ fallbackName: firstCol }]
        )
        this.render()
      })

      const addFkBtn = document.createElement('button')
      addFkBtn.type = 'button'
      addFkBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-add-fk-btn'
      addFkBtn.textContent = '+ Foreign Key'
      addFkBtn.addEventListener?.('click', () => {
        if (!this.draft) return
        const activeCols = this.draft.columns.filter((c) => c.status !== 'deleted')
        const firstColItem = activeCols[0]
        const firstCol = firstColItem?.name || 'id'
        const tbl = (this.draft.tableName || this.draft.originalTableName).trim()
        const refTbl =
          this.referenceTables.find((t) => t !== tbl) || this.referenceTables[0] || ''
        const newFkId = `new_fk_${this.seqCounter++}`
        this.draft.foreignKeys.push({
          id: newFkId,
          constraintName: `fk_${tbl}_${firstCol}`.replace(/[^A-Za-z0-9_]/g, '_'),
          column: firstCol,
          foreignTable: refTbl,
          foreignColumn: 'id',
          onDelete: 'NO ACTION',
          onUpdate: 'NO ACTION',
          status: 'new',
        })
        if (firstColItem) {
          this.fkColIdById.set(newFkId, firstColItem.id)
        }
        this.render()
      })

      const previewBtn = document.createElement('button')
      previewBtn.type = 'button'
      previewBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-struct-preview-btn'
      previewBtn.textContent = 'DDL Preview'
      previewBtn.addEventListener?.('click', () => {
        this.showMigrationPreview = !this.showMigrationPreview
        this.refreshStageControls()
      })
      this.stageUiRefs.previewBtn = previewBtn

      const applyBtn = document.createElement('button')
      applyBtn.type = 'button'
      applyBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-struct-apply-btn'
      applyBtn.textContent = 'Review & Apply [0]'
      applyBtn.title = 'Validate and confirm staged schema changes (Ctrl/Cmd + S)'
      applyBtn.addEventListener?.('click', () => {
        void this.applyStagedChanges()
      })
      this.stageUiRefs.applyBtn = applyBtn

      const revertBtn = document.createElement('button')
      revertBtn.type = 'button'
      revertBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-struct-revert-btn'
      revertBtn.textContent = 'Revert'
      revertBtn.addEventListener?.('click', () => {
        this.revertStagedChanges()
      })
      this.stageUiRefs.revertBtn = revertBtn

      headerRight.appendChild(addColBtn)
      headerRight.appendChild(addIdxBtn)
      headerRight.appendChild(addFkBtn)
      headerRight.appendChild(previewBtn)
      headerRight.appendChild(revertBtn)
      headerRight.appendChild(applyBtn)

      if (this.onTruncateTable) {
        const truncateBtn = document.createElement('button')
        truncateBtn.type = 'button'
        truncateBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-danger datanoa-struct-truncate-btn'
        truncateBtn.textContent = 'Truncate'
        truncateBtn.title = 'Truncate all rows in this table'
        truncateBtn.addEventListener?.('click', () => {
          if (this.isMigrating) return
          this.onTruncateTable?.()
        })
        headerRight.appendChild(truncateBtn)
      }
      if (this.onDropTable) {
        const dropBtn = document.createElement('button')
        dropBtn.type = 'button'
        dropBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-danger datanoa-struct-drop-btn'
        dropBtn.textContent = 'Drop'
        dropBtn.title = 'Drop this table'
        dropBtn.addEventListener?.('click', () => {
          if (this.isMigrating) return
          this.onDropTable?.()
        })
        headerRight.appendChild(dropBtn)
      }
    } else {
      const panHint = document.createElement('span')
      panHint.className = 'datanoa-shortcut-hint'
      panHint.textContent = 'Ctrl + Scroll ↔ Pan wide tables & DDL'
      headerRight.appendChild(panHint)
      if (!this.readOnly && this.currentDialect !== 'redis' && this.onDropTable) {
        const dropBtn = document.createElement('button')
        dropBtn.type = 'button'
        dropBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-btn-danger datanoa-struct-drop-btn'
        dropBtn.textContent = kind === 'view' ? 'Drop View' : 'Drop'
        dropBtn.addEventListener?.('click', () => {
          if (this.isMigrating) return
          this.onDropTable?.()
        })
        headerRight.appendChild(dropBtn)
      }
    }

    headerEl.appendChild(titleEl)
    headerEl.appendChild(headerRight)
    topZone.appendChild(headerEl)

    // Live Validation Bar & Staged Migration SQL Preview Drawer (inside pinned topZone)
    if (canEditStructure && this.draft) {
      const valBar = document.createElement('div')
      valBar.className = 'datanoa-struct-validation-bar'
      valBar.style.display = 'none'
      valBar.setAttribute('role', 'alert')
      const valTitle = document.createElement('div')
      valTitle.className = 'datanoa-struct-validation-title'
      const valList = document.createElement('ul')
      valList.className = 'datanoa-struct-validation-list'
      valBar.appendChild(valTitle)
      valBar.appendChild(valList)
      this.stageUiRefs.validationBar = valBar
      this.stageUiRefs.validationTitle = valTitle
      this.stageUiRefs.validationList = valList
      topZone.appendChild(valBar)

      const previewDrawer = document.createElement('div')
      previewDrawer.className = 'datanoa-ddl-card datanoa-dml-preview datanoa-struct-preview-drawer'
      previewDrawer.style.display = this.showMigrationPreview ? 'block' : 'none'

      const drawerHead = document.createElement('div')
      drawerHead.className = 'datanoa-ddl-header datanoa-drawer-head'
      const drawerTitle = document.createElement('span')
      drawerTitle.textContent = `Staged Schema Migration SQL (${this.currentDialect.toUpperCase()})`

      const drawerActions = document.createElement('div')
      drawerActions.className = 'datanoa-ddl-actions'

      const copyMigrationBtn = document.createElement('button')
      copyMigrationBtn.type = 'button'
      copyMigrationBtn.className = 'datanoa-btn datanoa-btn-sm'
      copyMigrationBtn.textContent = 'Copy SQL'
      copyMigrationBtn.addEventListener?.('click', () => {
        const sql = this.stageUiRefs.previewPre?.textContent || ''
        this.copyTextToClipboard(sql)
        copyMigrationBtn.textContent = 'Copied!'
        setTimeout(() => {
          copyMigrationBtn.textContent = 'Copy SQL'
        }, 1200)
      })

      const openInConsoleBtn = document.createElement('button')
      openInConsoleBtn.type = 'button'
      openInConsoleBtn.className = 'datanoa-btn datanoa-btn-sm'
      openInConsoleBtn.textContent = 'Open in Console'
      openInConsoleBtn.addEventListener?.('click', () => {
        const sql = this.stageUiRefs.previewPre?.textContent || ''
        if (sql && !sql.startsWith('--')) {
          this.onInsertDdl?.(sql)
        }
      })

      const previewApplyBtn = document.createElement('button')
      previewApplyBtn.type = 'button'
      previewApplyBtn.className = 'datanoa-btn datanoa-btn-primary datanoa-btn-sm datanoa-struct-preview-apply-btn'
      previewApplyBtn.textContent = 'Review & Apply'
      previewApplyBtn.addEventListener?.('click', () => {
        void this.applyStagedChanges()
      })
      this.stageUiRefs.previewApplyBtn = previewApplyBtn

      const closePreviewBtn = document.createElement('button')
      closePreviewBtn.type = 'button'
      closePreviewBtn.className = 'datanoa-btn datanoa-btn-sm'
      closePreviewBtn.textContent = 'Close'
      closePreviewBtn.addEventListener?.('click', () => {
        this.showMigrationPreview = false
        this.refreshStageControls()
      })

      drawerActions.appendChild(copyMigrationBtn)
      drawerActions.appendChild(openInConsoleBtn)
      drawerActions.appendChild(previewApplyBtn)
      drawerActions.appendChild(closePreviewBtn)
      drawerHead.appendChild(drawerTitle)
      drawerHead.appendChild(drawerActions)

      const previewPre = document.createElement('pre')
      previewPre.className = 'datanoa-dml-pre datanoa-dml-drawer-pre'
      this.stageUiRefs.previewDrawer = previewDrawer
      this.stageUiRefs.previewPre = previewPre

      previewDrawer.appendChild(drawerHead)
      previewDrawer.appendChild(previewPre)
      topZone.appendChild(previewDrawer)
    }

    this.container.appendChild(topZone)
    this.container.appendChild(scrollBody)

    // Helper for CREATE TABLE DDL Card (placed below designer in Edit mode, or top in Read-Only mode)
    const buildDdlCard = () => {
      const rawDdl =
        (this.currentDetails?.ddl && this.currentDetails.ddl.trim()) ||
        (this.currentDetails ? reconstructTableDdl(this.currentDetails, this.currentDialect) : '')
      const ddlText = formatDdlForDisplay(rawDdl, this.currentDialect)

      const ddlCard = document.createElement('div')
      ddlCard.className = 'datanoa-ddl-card'

      const ddlHeader = document.createElement('div')
      ddlHeader.className = 'datanoa-ddl-header'

      const ddlTitle = document.createElement('span')
      ddlTitle.textContent = 'DDL Definition'

      const ddlActions = document.createElement('div')
      ddlActions.className = 'datanoa-ddl-actions'

      const copyBtn = document.createElement('button')
      copyBtn.className = 'datanoa-btn datanoa-btn-sm'
      copyBtn.textContent = 'Copy DDL'
      if (typeof copyBtn.addEventListener === 'function') {
        copyBtn.addEventListener('click', () => {
          this.copyTextToClipboard(ddlText)
          copyBtn.textContent = 'Copied!'
          setTimeout(() => {
            copyBtn.textContent = 'Copy DDL'
          }, 1400)
        })
      }

      const insertBtn = document.createElement('button')
      insertBtn.className = 'datanoa-btn datanoa-btn-sm'
      insertBtn.textContent = 'Insert DDL in Console'
      if (typeof insertBtn.addEventListener === 'function') {
        insertBtn.addEventListener('click', () => {
          this.onInsertDdl?.(ddlText)
        })
      }

      ddlActions.appendChild(copyBtn)
      ddlActions.appendChild(insertBtn)
      ddlHeader.appendChild(ddlTitle)
      ddlHeader.appendChild(ddlActions)

      const ddlPre = document.createElement('pre')
      ddlPre.className = 'datanoa-ddl-pre'
      const ddlCode = document.createElement('code')
      appendFormattedDdl(ddlCode, ddlText)
      ddlPre.appendChild(ddlCode)
      this.bindHorizontalWheel(ddlPre)

      ddlCard.appendChild(ddlHeader)
      ddlCard.appendChild(ddlPre)
      return ddlCard
    }

    if (canEditStructure && this.draft) {
      this.renderEditableColumnsSection(this.draft, scrollBody)
      this.renderEditableForeignKeysSection(this.draft, scrollBody)
      this.renderEditableIndexesSection(this.draft, scrollBody)
      scrollBody.appendChild(buildDdlCard())
      this.refreshStageControls()
      if (prevScrollTop > 0) {
        scrollBody.scrollTop = prevScrollTop
      }
      return
    }

    scrollBody.appendChild(buildDdlCard())

    // Read-Only / Mock DOM Fallback (Preserves exact structure for read-only views & unit tests)
    const columnsTitle = document.createElement('div')
    columnsTitle.className = 'datanoa-section-title'
    columnsTitle.textContent = 'Columns & Attributes'
    scrollBody.appendChild(columnsTitle)

    const colScrollWrap = document.createElement('div')
    colScrollWrap.className = 'datanoa-matrix-scroll'
    this.bindHorizontalWheel(colScrollWrap)

    const tableEl = document.createElement('table')
    tableEl.className = 'datanoa-matrix-table'

    const thead = document.createElement('thead')
    thead.innerHTML = `
      <tr>
        <th style="width: 40px;">#</th>
        <th>Column Name</th>
        <th>Type</th>
        <th>Native Type</th>
        <th>Nullable</th>
        <th>Default Value</th>
        <th>Key</th>
        <th>Extra</th>
      </tr>
    `
    tableEl.appendChild(thead)

    const tbody = document.createElement('tbody')
    columns.forEach((col: ColumnInfo & { nativeType?: string }, idx: number) => {
      const tr = document.createElement('tr')
      const isPk = col.isPrimaryKey || primaryKey.includes(col.name)
      const pkBadge = isPk ? `<span class="datanoa-badge datanoa-badge-pk">PK</span>` : ''
      const displayType = col.type || 'TEXT'

      tr.innerHTML = `
        <td style="color: var(--muted);">${idx + 1}</td>
        <td style="font-weight: 600;">${escapeHtml(col.name)} ${pkBadge}</td>
        <td><code>${escapeHtml(displayType)}</code></td>
        <td style="color: var(--muted);">${escapeHtml(col.nativeType || displayType || '-')}</td>
        <td>${col.nullable !== false ? 'YES' : '<strong>NO</strong>'}</td>
        <td style="color: ${col.defaultValue === null || col.defaultValue === undefined ? 'var(--muted)' : 'var(--text)'};">
          ${col.defaultValue === null || col.defaultValue === undefined ? '<em>NULL</em>' : `<code>${escapeHtml(col.defaultValue)}</code>`}
        </td>
        <td>${isPk ? 'PRI' : ''}</td>
        <td style="color: var(--muted);">${col.isAutoIncrement ? 'auto_increment' : ''}</td>
      `
      tbody.appendChild(tr)
    })
    tableEl.appendChild(tbody)
    colScrollWrap.appendChild(tableEl)
    scrollBody.appendChild(colScrollWrap)

    if (foreignKeys.length > 0) {
      const fkTitle = document.createElement('div')
      fkTitle.className = 'datanoa-section-title'
      fkTitle.textContent = `Foreign Keys (${foreignKeys.length})`
      scrollBody.appendChild(fkTitle)

      const fkScrollWrap = document.createElement('div')
      fkScrollWrap.className = 'datanoa-matrix-scroll'
      this.bindHorizontalWheel(fkScrollWrap)

      const fkTable = document.createElement('table')
      fkTable.className = 'datanoa-matrix-table'
      fkTable.innerHTML = `
        <thead>
          <tr>
            <th>Constraint Name</th>
            <th>Column</th>
            <th>Referenced Table</th>
            <th>Referenced Column</th>
          </tr>
        </thead>
        <tbody>
          ${foreignKeys
            .map(
              (fk: ForeignKeyInfo) => `
            <tr>
              <td><code>${escapeHtml(fk.constraintName || '-')}</code></td>
              <td><strong>${escapeHtml(fk.column)}</strong></td>
              <td><span class="datanoa-badge datanoa-badge-fk">${escapeHtml(fk.referencedTable)}</span></td>
              <td><code>${escapeHtml(fk.referencedColumn)}</code></td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      `
      fkScrollWrap.appendChild(fkTable)
      scrollBody.appendChild(fkScrollWrap)
    }

    if (indexes.length > 0) {
      const idxTitle = document.createElement('div')
      idxTitle.className = 'datanoa-section-title'
      idxTitle.textContent = `Indexes (${indexes.length})`
      scrollBody.appendChild(idxTitle)

      const idxScrollWrap = document.createElement('div')
      idxScrollWrap.className = 'datanoa-matrix-scroll'
      this.bindHorizontalWheel(idxScrollWrap)

      const idxTable = document.createElement('table')
      idxTable.className = 'datanoa-matrix-table'
      idxTable.innerHTML = `
        <thead>
          <tr>
            <th>Index Name</th>
            <th>Columns</th>
            <th>Unique</th>
            <th>Primary</th>
          </tr>
        </thead>
        <tbody>
          ${indexes
            .map(
              (idx: IndexInfo) => `
            <tr>
              <td><code>${escapeHtml(idx.name)}</code></td>
              <td><strong>${(idx.columns || []).map((c: string) => escapeHtml(c)).join(', ')}</strong></td>
              <td>${idx.isUnique ? '<span class="datanoa-badge datanoa-badge-unique">UNIQUE</span>' : 'NO'}</td>
              <td>${idx.isPrimary ? '<span class="datanoa-badge datanoa-badge-pk">PRIMARY</span>' : 'NO'}</td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      `
      idxScrollWrap.appendChild(idxTable)
      scrollBody.appendChild(idxScrollWrap)
    }
    if (prevScrollTop > 0) {
      scrollBody.scrollTop = prevScrollTop
    }
  }

  private renderEditableColumnsSection(draft: TableStructureDraft, parentEl: HTMLElement): void {
    const section = document.createElement('div')
    section.className = 'datanoa-struct-section'

    const head = document.createElement('div')
    head.className = 'datanoa-struct-section-head'

    const title = document.createElement('div')
    title.className = 'datanoa-section-title'
    title.style.marginBottom = '0'
    title.textContent = `Columns (${draft.columns.filter((c) => c.status !== 'deleted').length})`
    head.appendChild(title)
    section.appendChild(head)

    const scrollWrap = document.createElement('div')
    scrollWrap.className = 'datanoa-matrix-scroll'
    this.bindHorizontalWheel(scrollWrap)

    const table = document.createElement('table')
    table.className = 'datanoa-matrix-table datanoa-struct-grid datanoa-struct-columns-table'

    const thead = document.createElement('thead')
    thead.innerHTML = `
      <tr>
        <th style="width: 36px;">#</th>
        <th style="min-width: 160px;">Column Name</th>
        <th style="min-width: 140px;">Data Type</th>
        <th style="width: 70px; text-align: center;">PK</th>
        <th style="width: 84px; text-align: center;">Nullable</th>
        <th style="min-width: 190px;">Default Value</th>
        <th style="width: 110px;">State</th>
        <th style="width: 96px; text-align: right;">Action</th>
      </tr>
    `
    table.appendChild(thead)

    const tbody = document.createElement('tbody')

    draft.columns.forEach((col: DraftColumnItem, idx: number) => {
      const tr = document.createElement('tr')
      tr.classList.toggle('datanoa-struct-row-inserted', col.status === 'new')
      tr.classList.toggle('datanoa-struct-row-deleted', col.status === 'deleted')

      const isDeleted = col.status === 'deleted'

      // #
      const numTd = document.createElement('td')
      numTd.className = 'datanoa-struct-td-pad'
      numTd.style.color = 'var(--muted)'
      numTd.textContent = String(idx + 1)
      tr.appendChild(numTd)

      // State badge element created early so input listeners can update it in place
      const stateBadge = document.createElement('span')
      stateBadge.className = 'datanoa-badge'
      stateBadge.textContent = this.getColumnStateLabel(col)

      // Column Name (bound to stable col.id so renaming through another column's name never corrupts indexes/FKs)
      const nameTd = document.createElement('td')
      const nameInput = document.createElement('input')
      nameInput.type = 'text'
      nameInput.className = 'datanoa-struct-cell-input datanoa-col-name-input'
      nameInput.value = col.name
      nameInput.disabled = isDeleted
      nameInput.placeholder = 'column_name'
      nameInput.addEventListener('input', () => {
        col.name = nameInput.value
        this.syncColumnRenameInDraft(col.id, col.name)
        nameTd.classList.toggle(
          'datanoa-struct-cell-dirty',
          col.status === 'existing' && col.name.trim() !== (col.originalName ?? '').trim()
        )
        stateBadge.textContent = this.getColumnStateLabel(col)
        this.refreshStageControls()
      })
      nameTd.classList.toggle(
        'datanoa-struct-cell-dirty',
        col.status === 'existing' && col.name.trim() !== (col.originalName ?? '').trim()
      )
      nameTd.appendChild(nameInput)
      tr.appendChild(nameTd)

      // Data Type (in-DOM aligned combobox replacing broken iframe <datalist>)
      const typeTd = document.createElement('td')
      const { wrap: typeWrap } = this.createComboCellInput({
        value: col.dataType,
        items: COMMON_COLUMN_TYPES,
        placeholder: 'TEXT, INTEGER...',
        className: 'datanoa-struct-cell-input datanoa-col-type-input',
        disabled: isDeleted,
        onChange: (nextVal) => {
          col.dataType = nextVal
          typeTd.classList.toggle(
            'datanoa-struct-cell-dirty',
            col.status === 'existing' &&
              col.dataType.trim().toUpperCase() !== (col.originalDataType ?? 'TEXT').trim().toUpperCase()
          )
          stateBadge.textContent = this.getColumnStateLabel(col)
          this.refreshStageControls()
        },
      })
      typeTd.classList.toggle(
        'datanoa-struct-cell-dirty',
        col.status === 'existing' &&
          col.dataType.trim().toUpperCase() !== (col.originalDataType ?? 'TEXT').trim().toUpperCase()
      )
      typeTd.appendChild(typeWrap)
      tr.appendChild(typeTd)

      // Primary Key checkbox
      const pkTd = document.createElement('td')
      pkTd.style.textAlign = 'center'
      const pkCb = document.createElement('input')
      pkCb.type = 'checkbox'
      pkCb.className = 'datanoa-struct-checkbox datanoa-col-pk-checkbox'
      pkCb.checked = col.isPrimaryKey
      pkCb.disabled = isDeleted

      // Nullable checkbox (declared before pkCb listener so toggling PK can update nullCb)
      const nullTd = document.createElement('td')
      nullTd.style.textAlign = 'center'
      const nullCb = document.createElement('input')
      nullCb.type = 'checkbox'
      nullCb.className = 'datanoa-struct-checkbox datanoa-col-nullable-checkbox'
      nullCb.checked = col.nullable
      nullCb.disabled = isDeleted || col.isPrimaryKey

      pkCb.addEventListener('change', () => {
        col.isPrimaryKey = Boolean(pkCb.checked)
        if (col.isPrimaryKey) {
          col.nullable = false
          nullCb.checked = false
        }
        nullCb.disabled = isDeleted || col.isPrimaryKey
        pkTd.classList.toggle(
          'datanoa-struct-cell-dirty',
          col.status === 'existing' && col.isPrimaryKey !== Boolean(col.originalIsPrimaryKey)
        )
        nullTd.classList.toggle(
          'datanoa-struct-cell-dirty',
          col.status === 'existing' && col.nullable !== Boolean(col.originalNullable)
        )
        stateBadge.textContent = this.getColumnStateLabel(col)
        this.refreshStageControls()
      })
      pkTd.classList.toggle(
        'datanoa-struct-cell-dirty',
        col.status === 'existing' && col.isPrimaryKey !== Boolean(col.originalIsPrimaryKey)
      )
      pkTd.appendChild(pkCb)
      tr.appendChild(pkTd)

      nullCb.addEventListener('change', () => {
        col.nullable = Boolean(nullCb.checked)
        nullTd.classList.toggle(
          'datanoa-struct-cell-dirty',
          col.status === 'existing' && col.nullable !== Boolean(col.originalNullable)
        )
        stateBadge.textContent = this.getColumnStateLabel(col)
        this.refreshStageControls()
      })
      nullTd.classList.toggle(
        'datanoa-struct-cell-dirty',
        col.status === 'existing' && col.nullable !== Boolean(col.originalNullable)
      )
      nullTd.appendChild(nullCb)
      tr.appendChild(nullTd)

      // Default Value input + 1-click clear button
      const defTd = document.createElement('td')
      const defWrap = document.createElement('div')
      defWrap.className = 'datanoa-struct-default-wrap'

      const defInput = document.createElement('input')
      defInput.type = 'text'
      defInput.className = 'datanoa-struct-cell-input datanoa-col-default-input'
      defInput.value = col.defaultValue
      defInput.disabled = isDeleted
      defInput.placeholder = col.nullable ? 'NULL (none)' : 'No default'

      const clearDefBtn = document.createElement('button')
      clearDefBtn.type = 'button'
      clearDefBtn.className = 'datanoa-clear-default-btn'
      clearDefBtn.textContent = '×'
      clearDefBtn.title = 'Clear default value (DROP DEFAULT)'
      clearDefBtn.style.display = col.defaultValue.length > 0 && !isDeleted ? 'inline-flex' : 'none'

      const syncDefaultDirty = () => {
        clearDefBtn.style.display =
          col.defaultValue.length > 0 && !isDeleted ? 'inline-flex' : 'none'
        defTd.classList.toggle(
          'datanoa-struct-cell-dirty',
          col.status === 'existing' &&
            col.defaultValue.trim() !== (col.originalDefaultValue ?? '').trim()
        )
        stateBadge.textContent = this.getColumnStateLabel(col)
        this.refreshStageControls()
      }

      defInput.addEventListener('input', () => {
        col.defaultValue = defInput.value
        syncDefaultDirty()
      })

      clearDefBtn.addEventListener('click', () => {
        col.defaultValue = ''
        defInput.value = ''
        syncDefaultDirty()
      })

      defWrap.appendChild(defInput)
      defWrap.appendChild(clearDefBtn)
      defTd.classList.toggle(
        'datanoa-struct-cell-dirty',
        col.status === 'existing' &&
          col.defaultValue.trim() !== (col.originalDefaultValue ?? '').trim()
      )
      defTd.appendChild(defWrap)
      tr.appendChild(defTd)

      // State badge cell
      const stateTd = document.createElement('td')
      stateTd.className = 'datanoa-struct-td-pad'
      stateTd.appendChild(stateBadge)
      tr.appendChild(stateTd)

      // Action (Drop / Undo / Remove new)
      const actionTd = document.createElement('td')
      actionTd.className = 'datanoa-struct-td-pad'
      actionTd.style.textAlign = 'right'
      const actionBtn = document.createElement('button')
      actionBtn.type = 'button'
      actionBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-col-drop-btn'
      if (col.status === 'new') {
        actionBtn.textContent = 'Remove'
        actionBtn.addEventListener('click', () => {
          const pos = draft.columns.indexOf(col)
          if (pos !== -1) draft.columns.splice(pos, 1)
          this.render()
        })
      } else if (col.status === 'deleted') {
        actionBtn.textContent = 'Undo'
        actionBtn.addEventListener('click', () => {
          col.status = 'existing'
          this.render()
        })
      } else {
        actionBtn.textContent = 'Drop'
        actionBtn.addEventListener('click', () => {
          col.status = 'deleted'
          this.render()
        })
      }
      actionTd.appendChild(actionBtn)
      tr.appendChild(actionTd)

      tbody.appendChild(tr)
    })

    table.appendChild(tbody)
    scrollWrap.appendChild(table)
    section.appendChild(scrollWrap)
    parentEl.appendChild(section)
  }

  private getColumnStateLabel(col: DraftColumnItem): string {
    if (col.status === 'new') return 'NEW'
    if (col.status === 'deleted') return 'DROP'
    if (isDraftColumnDirty(col)) return 'MODIFIED'
    return col.isPrimaryKey ? 'PK' : 'OK'
  }

  private renderEditableForeignKeysSection(draft: TableStructureDraft, parentEl: HTMLElement): void {
    const section = document.createElement('div')
    section.className = 'datanoa-struct-section'

    const head = document.createElement('div')
    head.className = 'datanoa-struct-section-head'

    const title = document.createElement('div')
    title.className = 'datanoa-section-title'
    title.style.marginBottom = '0'
    title.textContent = `Foreign Keys (${draft.foreignKeys.filter((fk) => fk.status !== 'deleted').length})`
    head.appendChild(title)
    section.appendChild(head)

    const scrollWrap = document.createElement('div')
    scrollWrap.className = 'datanoa-matrix-scroll'
    this.bindHorizontalWheel(scrollWrap)

    const table = document.createElement('table')
    table.className = 'datanoa-matrix-table datanoa-struct-grid datanoa-struct-fks-table'
    table.innerHTML = `
      <thead>
        <tr>
          <th style="min-width: 150px;">Constraint Name</th>
          <th style="min-width: 140px;">Local Column</th>
          <th style="min-width: 150px;">Target Table</th>
          <th style="min-width: 130px;">Target Column</th>
          <th style="min-width: 130px;">On Delete</th>
          <th style="width: 96px; text-align: right;">Action</th>
        </tr>
      </thead>
    `

    const tbody = document.createElement('tbody')
    if (draft.foreignKeys.length === 0) {
      const emptyTr = document.createElement('tr')
      emptyTr.innerHTML = `<td colspan="6" style="color: var(--muted); padding: 10px;">No foreign keys defined. Click <strong>+ Foreign Key</strong> in the toolbar to add a relationship.</td>`
      tbody.appendChild(emptyTr)
    } else {
      const activeCols = draft.columns.filter((c) => c.status !== 'deleted')

      draft.foreignKeys.forEach((fk: DraftForeignKeyItem) => {
        const tr = document.createElement('tr')
        tr.classList.toggle('datanoa-struct-row-inserted', fk.status === 'new')
        tr.classList.toggle('datanoa-struct-row-deleted', fk.status === 'deleted')

        if (fk.status === 'new') {
          const nameTd = document.createElement('td')
          const nameInput = document.createElement('input')
          nameInput.type = 'text'
          nameInput.className = 'datanoa-struct-cell-input datanoa-fk-name-input'
          nameInput.value = fk.constraintName || ''
          nameInput.placeholder = 'fk_name'
          nameInput.addEventListener('input', () => {
            fk.constraintName = nameInput.value
            this.refreshStageControls()
          })
          nameTd.appendChild(nameInput)
          tr.appendChild(nameTd)

          const colTd = document.createElement('td')
          const colSelect = document.createElement('select')
          colSelect.className = 'datanoa-struct-cell-select datanoa-fk-col-select'
          const boundFkColId = this.fkColIdById.get(fk.id)
          for (const c of activeCols) {
            const opt = document.createElement('option')
            opt.value = c.name
            opt.textContent = c.name.trim() || '(unnamed)'
            opt.dataset.colId = c.id
            if (boundFkColId ? c.id === boundFkColId : c.name === fk.column) {
              opt.selected = true
            }
            colSelect.appendChild(opt)
          }
          colSelect.addEventListener('change', () => {
            const opts = Array.from(colSelect.querySelectorAll('option')).filter(
              (o): o is HTMLOptionElement => o instanceof HTMLOptionElement
            )
            const idxOpt =
              typeof colSelect.selectedIndex === 'number' && colSelect.selectedIndex >= 0
                ? opts[colSelect.selectedIndex]
                : undefined
            const matchedOpt =
              (idxOpt && idxOpt.value === colSelect.value ? idxOpt : undefined) ||
              opts.find((o) => o.value === colSelect.value)
            const nextColId =
              matchedOpt?.dataset.colId ||
              activeCols.find((c) => c.name === colSelect.value)?.id
            if (nextColId) {
              this.fkColIdById.set(fk.id, nextColId)
            } else {
              this.fkColIdById.delete(fk.id)
            }
            fk.column = colSelect.value
            this.refreshStageControls()
          })
          colTd.appendChild(colSelect)
          tr.appendChild(colTd)

          const refTableTd = document.createElement('td')
          const { wrap: refTableWrap } = this.createComboCellInput({
            value: fk.foreignTable,
            items: this.referenceTables,
            placeholder: 'Referenced table...',
            className: 'datanoa-struct-cell-input datanoa-fk-target-table-input',
            onChange: (nextVal) => {
              fk.foreignTable = nextVal
              this.refreshStageControls()
            },
          })
          refTableTd.appendChild(refTableWrap)
          tr.appendChild(refTableTd)

          const refColTd = document.createElement('td')
          const refColInput = document.createElement('input')
          refColInput.type = 'text'
          refColInput.className = 'datanoa-struct-cell-input datanoa-fk-target-col-input'
          refColInput.value = fk.foreignColumn
          refColInput.placeholder = 'id'
          refColInput.addEventListener('input', () => {
            fk.foreignColumn = refColInput.value
            this.refreshStageControls()
          })
          refColTd.appendChild(refColInput)
          tr.appendChild(refColTd)

          const onDelTd = document.createElement('td')
          const onDelSelect = document.createElement('select')
          onDelSelect.className = 'datanoa-struct-cell-select datanoa-fk-ondelete-select'
          for (const act of REFERENTIAL_ACTIONS) {
            const opt = document.createElement('option')
            opt.value = act
            opt.textContent = act
            if (act === fk.onDelete) opt.selected = true
            onDelSelect.appendChild(opt)
          }
          onDelSelect.addEventListener('change', () => {
            fk.onDelete = onDelSelect.value as ReferentialAction
            this.refreshStageControls()
          })
          onDelTd.appendChild(onDelSelect)
          tr.appendChild(onDelTd)

          const actionTd = document.createElement('td')
          actionTd.className = 'datanoa-struct-td-pad'
          actionTd.style.textAlign = 'right'
          const removeBtn = document.createElement('button')
          removeBtn.type = 'button'
          removeBtn.className = 'datanoa-btn datanoa-btn-sm'
          removeBtn.textContent = 'Remove'
          removeBtn.addEventListener('click', () => {
            const pos = draft.foreignKeys.indexOf(fk)
            if (pos !== -1) draft.foreignKeys.splice(pos, 1)
            this.fkColIdById.delete(fk.id)
            this.render()
          })
          actionTd.appendChild(removeBtn)
          tr.appendChild(actionTd)
        } else {
          tr.innerHTML = `
            <td class="datanoa-struct-td-pad"><code>${escapeHtml(fk.constraintName || '-')}</code></td>
            <td class="datanoa-struct-td-pad"><strong data-struct-fk-col="${escapeHtml(fk.id)}">${escapeHtml(fk.column)}</strong></td>
            <td class="datanoa-struct-td-pad"><span class="datanoa-badge datanoa-badge-fk">${escapeHtml(fk.foreignTable)}</span></td>
            <td class="datanoa-struct-td-pad"><code>${escapeHtml(fk.foreignColumn)}</code></td>
            <td class="datanoa-struct-td-pad"><code>${escapeHtml(fk.onDelete || 'NO ACTION')}</code></td>
          `
          const actionTd = document.createElement('td')
          actionTd.className = 'datanoa-struct-td-pad'
          actionTd.style.textAlign = 'right'
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'datanoa-btn datanoa-btn-sm datanoa-fk-drop-btn'
          btn.textContent = fk.status === 'deleted' ? 'Undo' : 'Drop'
          btn.addEventListener('click', () => {
            fk.status = fk.status === 'deleted' ? 'existing' : 'deleted'
            this.render()
          })
          actionTd.appendChild(btn)
          tr.appendChild(actionTd)
        }

        tbody.appendChild(tr)
      })
    }

    table.appendChild(tbody)
    scrollWrap.appendChild(table)
    section.appendChild(scrollWrap)
    parentEl.appendChild(section)
  }

  private renderEditableIndexesSection(draft: TableStructureDraft, parentEl: HTMLElement): void {
    const section = document.createElement('div')
    section.className = 'datanoa-struct-section'

    const head = document.createElement('div')
    head.className = 'datanoa-struct-section-head'

    const title = document.createElement('div')
    title.className = 'datanoa-section-title'
    title.style.marginBottom = '0'
    title.textContent = `Indexes & Keys (${draft.indexes.filter((idx) => idx.status !== 'deleted').length})`
    head.appendChild(title)
    section.appendChild(head)

    const scrollWrap = document.createElement('div')
    scrollWrap.className = 'datanoa-matrix-scroll'
    this.bindHorizontalWheel(scrollWrap)

    const table = document.createElement('table')
    table.className = 'datanoa-matrix-table datanoa-struct-grid datanoa-struct-indexes-table'
    table.innerHTML = `
      <thead>
        <tr>
          <th style="min-width: 180px;">Index Name</th>
          <th style="min-width: 240px;">Indexed Columns</th>
          <th style="width: 130px;">Kind</th>
          <th style="width: 96px; text-align: right;">Action</th>
        </tr>
      </thead>
    `

    const tbody = document.createElement('tbody')
    if (draft.indexes.length === 0) {
      const emptyTr = document.createElement('tr')
      emptyTr.innerHTML = `<td colspan="4" style="color: var(--muted); padding: 10px;">No secondary indexes defined. Click <strong>+ Index / Key</strong> in the toolbar to create a regular or UNIQUE index.</td>`
      tbody.appendChild(emptyTr)
    } else {
      const activeCols = draft.columns.filter((c) => c.status !== 'deleted')

      draft.indexes.forEach((idx: DraftIndexItem) => {
        const tr = document.createElement('tr')
        tr.classList.toggle('datanoa-struct-row-inserted', idx.status === 'new')
        tr.classList.toggle('datanoa-struct-row-deleted', idx.status === 'deleted')

        if (idx.status === 'new') {
          const nameTd = document.createElement('td')
          const nameInput = document.createElement('input')
          nameInput.type = 'text'
          nameInput.className = 'datanoa-struct-cell-input datanoa-idx-name-input'
          nameInput.value = idx.name
          nameInput.placeholder = 'idx_table_col'
          nameInput.addEventListener('input', () => {
            idx.name = nameInput.value
            this.refreshStageControls()
          })
          nameTd.appendChild(nameInput)
          tr.appendChild(nameTd)

          const colsTd = document.createElement('td')
          const pillsWrap = document.createElement('div')
          pillsWrap.className = 'datanoa-col-pills-wrap'
          let refs = this.indexColRefsById.get(idx.id)
          if (!refs) {
            refs = (idx.columns || []).map((colName) => {
              const matched = activeCols.find((c) => c.name === colName)
              return matched
                ? { colId: matched.id, fallbackName: colName }
                : { fallbackName: colName }
            })
            this.indexColRefsById.set(idx.id, refs)
          }
          const idxRefs = refs
          for (const col of activeCols) {
            const pill = document.createElement('button')
            pill.type = 'button'
            const isSelected = idxRefs.some((r) => r.colId === col.id)
            pill.className = `datanoa-col-pill${isSelected ? ' active' : ''}`
            pill.dataset.colId = col.id
            pill.textContent = col.name.trim() || '(unnamed)'
            pill.addEventListener('click', () => {
              const pos = idxRefs.findIndex((r) => r.colId === col.id)
              if (pos !== -1) {
                if (idxRefs.length > 1) idxRefs.splice(pos, 1)
              } else {
                idxRefs.push({ colId: col.id, fallbackName: col.name })
              }
              idx.columns = this.resolveIndexColumnNames(draft, idx)
              pill.classList.toggle('active', idxRefs.some((r) => r.colId === col.id))
              this.refreshStageControls()
            })
            pillsWrap.appendChild(pill)
          }
          colsTd.appendChild(pillsWrap)
          tr.appendChild(colsTd)

          const kindTd = document.createElement('td')
          const kindSelect = document.createElement('select')
          kindSelect.className = 'datanoa-struct-cell-select datanoa-idx-unique-select'
          const optIdx = document.createElement('option')
          optIdx.value = 'index'
          optIdx.textContent = 'INDEX'
          optIdx.selected = !idx.unique
          const optUniq = document.createElement('option')
          optUniq.value = 'unique'
          optUniq.textContent = 'UNIQUE KEY'
          optUniq.selected = idx.unique
          kindSelect.appendChild(optIdx)
          kindSelect.appendChild(optUniq)
          kindSelect.addEventListener('change', () => {
            idx.unique = kindSelect.value === 'unique'
            this.refreshStageControls()
          })
          kindTd.appendChild(kindSelect)
          tr.appendChild(kindTd)

          const actionTd = document.createElement('td')
          actionTd.className = 'datanoa-struct-td-pad'
          actionTd.style.textAlign = 'right'
          const removeBtn = document.createElement('button')
          removeBtn.type = 'button'
          removeBtn.className = 'datanoa-btn datanoa-btn-sm'
          removeBtn.textContent = 'Remove'
          removeBtn.addEventListener('click', () => {
            const pos = draft.indexes.indexOf(idx)
            if (pos !== -1) draft.indexes.splice(pos, 1)
            this.indexColRefsById.delete(idx.id)
            this.render()
          })
          actionTd.appendChild(removeBtn)
          tr.appendChild(actionTd)
        } else {
          const kindHtml = idx.isPrimary
            ? '<span class="datanoa-badge datanoa-badge-pk">PRIMARY</span>'
            : idx.unique
              ? '<span class="datanoa-badge datanoa-badge-unique">UNIQUE</span>'
              : '<span class="datanoa-badge">INDEX</span>'
          tr.innerHTML = `
            <td class="datanoa-struct-td-pad"><code>${escapeHtml(idx.name)}</code></td>
            <td class="datanoa-struct-td-pad"><strong data-struct-idx-cols="${escapeHtml(idx.id)}">${(idx.columns || []).map((c) => escapeHtml(c)).join(', ')}</strong></td>
            <td class="datanoa-struct-td-pad">${kindHtml}</td>
          `
          const actionTd = document.createElement('td')
          actionTd.className = 'datanoa-struct-td-pad'
          actionTd.style.textAlign = 'right'
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'datanoa-btn datanoa-btn-sm datanoa-idx-drop-btn'
          if (idx.isPrimary || /^sqlite_autoindex_/i.test(idx.name)) {
            btn.textContent = 'Locked'
            btn.disabled = true
            btn.title = 'Primary/auto index is managed via column PK checkboxes'
          } else {
            btn.textContent = idx.status === 'deleted' ? 'Undo' : 'Drop'
            btn.addEventListener('click', () => {
              idx.status = idx.status === 'deleted' ? 'existing' : 'deleted'
              this.render()
            })
          }
          actionTd.appendChild(btn)
          tr.appendChild(actionTd)
        }

        tbody.appendChild(tr)
      })
    }

    table.appendChild(tbody)
    scrollWrap.appendChild(table)
    section.appendChild(scrollWrap)
    parentEl.appendChild(section)
  }

  private readOnlyKindLabel(kind: SchemaObjectKind): string {
    const labels: Record<SchemaObjectKind, string> = {
      table: 'TABLE',
      view: 'VIEW',
      materialized_view: 'MAT VIEW',
      function: 'FUNCTION',
      procedure: 'PROCEDURE',
      trigger: 'TRIGGER',
      sequence: 'SEQUENCE',
      type: 'TYPE',
    }
    return labels[kind] || kind.toUpperCase()
  }

  private renderReadOnlyObjectDdl(): void {
    const obj = this.readOnlyObject
    if (!obj) return
    const ddlText = this.readOnlyObjectDdl

    const topZone = document.createElement('div')
    topZone.className = 'datanoa-inspector-top-zone'

    const headerEl = document.createElement('div')
    headerEl.className = 'datanoa-inspector-header'

    const titleEl = document.createElement('div')
    titleEl.className = 'datanoa-inspector-title-group'

    if (obj.schema) {
      const schemaSpan = document.createElement('span')
      schemaSpan.className = 'datanoa-badge datanoa-object-schema-badge'
      schemaSpan.textContent = obj.schema
      titleEl.appendChild(schemaSpan)
    }

    const nameSpan = document.createElement('span')
    nameSpan.className = 'datanoa-inspector-title'
    nameSpan.textContent = obj.name
    titleEl.appendChild(nameSpan)

    const kindBadge = document.createElement('span')
    kindBadge.className = `datanoa-badge datanoa-object-kind-badge datanoa-kind-${obj.kind}`
    kindBadge.textContent = this.readOnlyKindLabel(obj.kind)
    titleEl.appendChild(kindBadge)

    if (obj.detail) {
      const detailPill = document.createElement('span')
      detailPill.className = 'datanoa-badge datanoa-object-detail-pill'
      detailPill.title = obj.detail
      detailPill.textContent = obj.detail
      titleEl.appendChild(detailPill)
    }

    const headerRight = document.createElement('div')
    headerRight.className = 'datanoa-ddl-actions'

    const copyBtn = document.createElement('button')
    copyBtn.type = 'button'
    copyBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-copy-ddl-btn'
    copyBtn.textContent = 'Copy DDL'
    copyBtn.addEventListener?.('click', () => {
      this.copyTextToClipboard(ddlText)
      copyBtn.textContent = 'Copied!'
      setTimeout(() => {
        copyBtn.textContent = 'Copy DDL'
      }, 1400)
    })
    headerRight.appendChild(copyBtn)

    if (this.onOpenDdlInConsole) {
      const openBtn = document.createElement('button')
      openBtn.type = 'button'
      openBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-open-ddl-console-btn'
      openBtn.textContent = 'Open in SQL Console'
      openBtn.addEventListener?.('click', () => {
        this.onOpenDdlInConsole?.(ddlText)
      })
      headerRight.appendChild(openBtn)
    }

    headerEl.appendChild(titleEl)
    headerEl.appendChild(headerRight)
    topZone.appendChild(headerEl)
    this.container.appendChild(topZone)

    const scrollBody = document.createElement('div')
    scrollBody.className = 'datanoa-inspector-scroll-body'
    this.scrollBodyEl = scrollBody
    scrollBody.addEventListener?.('scroll', () => {
      this.closeComboPopover()
    })

    const ddlCard = document.createElement('div')
    ddlCard.className = 'datanoa-ddl-card datanoa-readonly-object-ddl-card'

    const ddlHeader = document.createElement('div')
    ddlHeader.className = 'datanoa-ddl-header'
    const ddlTitle = document.createElement('span')
    ddlTitle.textContent = 'DDL Definition'
    ddlHeader.appendChild(ddlTitle)

    const ddlPre = document.createElement('pre')
    ddlPre.className = 'datanoa-ddl-pre'
    const ddlCode = document.createElement('code')
    appendFormattedDdl(ddlCode, ddlText)
    ddlPre.appendChild(ddlCode)
    this.bindHorizontalWheel(ddlPre)

    ddlCard.appendChild(ddlHeader)
    ddlCard.appendChild(ddlPre)
    scrollBody.appendChild(ddlCard)
    this.container.appendChild(scrollBody)
  }

  public destroy(): void {
    this.clearWheelListeners()
    this.stopMigrationTimer()
    this.isMigrating = false
    this.closeConfirmModal(true)
    this.closeComboPopover()
    this.scrollBodyEl = null
    this.container.innerHTML = ''
    this.currentDetails = null
    this.readOnlyObject = null
    this.readOnlyObjectDdl = ''
    this.draft = null
    this.indexColRefsById.clear()
    this.fkColIdById.clear()
    this.errorMessage = null
    this.onRetryLoad = undefined
    this.stageUiRefs = {}
  }
}
