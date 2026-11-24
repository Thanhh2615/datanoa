import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installDomHarness, type DomHarness } from './helpers/dom-harness.js'
import { flushMicro, flushTick } from './helpers/live-studio-sqlite.js'

import { getEffectiveResultSets } from '../src/panel/panel-result-sets.js'
import { executeStudioExportAction } from '../src/editor/studio-export.js'
import { GridSelectionModel } from '../src/editor/grid-selection.js'
import { ConsoleTabsManager } from '../src/editor/console-tabs.js'
import { createSidebarContextMenu } from '../src/editor/studio-sidebar.js'
import { clampFixedPopup } from '../src/editor/grid-icons.js'
import { mountStudioColumnsPopover } from '../src/editor/studio-columns-popover.js'
import { openStudioDangerSqlModal } from '../src/editor/danger-sql-modal.js'
import {
  getEffectiveResultSets as getStudioEffectiveResultSets,
  buildInitialResultTabStates,
  buildCombinedExplainResult,
} from '../src/editor/result-set-controller.js'
import { createPanelFeedbackAndPaletteController } from '../src/panel/panel-feedback-palette.js'
import {
  buildGridCellContextMenu,
  buildGridHeaderContextMenu,
  buildGridBulkFillPopover,
  buildGridColumnFilterPopover,
} from '../src/editor/grid-menus.js'
import { buildStudioDiagnosticSummary, openStudioFeedbackModal } from '../src/editor/feedback-modal.js'
import { openStudioBindParamsModal } from '../src/editor/bind-params-modal.js'
import { TransactionToolbarController } from '../src/editor/transaction-toolbar.js'
import { ValueInspectorController } from '../src/editor/value-inspector.js'
import {
  openStudioCreateTableModal,
  openStudioDangerTableModal,
  openStudioCommandPalette,
} from '../src/editor/studio-modals.js'
import { openStudioSavedQueriesModal } from '../src/editor/saved-queries-modal.js'
import { extractPanelCaretStatementSql, createPanelCodeMirrorEditor } from '../src/panel/panel-cm.js'
import { openStudioDriverManagerModal } from '../src/editor/driver-manager-modal.js'
import { compactPickerRootLabel } from '../src/shared-file-picker.js'
import { openStudioFilePickerModal } from '../src/editor/file-picker-modal.js'

function withTempGlobal<T>(key: string, value: unknown, fn: () => T): T {
  const hadOwn = Object.prototype.hasOwnProperty.call(globalThis, key)
  const desc = Object.getOwnPropertyDescriptor(globalThis, key)
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  try {
    return fn()
  } finally {
    if (hadOwn && desc) {
      Object.defineProperty(globalThis, key, desc)
    } else {
      delete (globalThis as Record<string, unknown>)[key]
    }
  }
}

describe('Wave 4A Step 1: 20 UI / Editor / Panel Micro-Tails Closure', () => {
  let dom: DomHarness | undefined

  beforeEach(() => {
    dom = installDomHarness({ url: 'http://localhost/' })
    document.body.clientWidth = 1024
    document.body.clientHeight = 768
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    dom?.teardown()
    dom = undefined
  })

  it('closes pure & DOM clamp micro-tails: panel-result-sets, studio-export, grid-selection, console-tabs, sidebar/icons/columns clamp, danger-sql, result-set-controller', () => {
    // 1. src/panel/panel-result-sets.js (L27: omitted columns)
    const pSets = getEffectiveResultSets({ rows: [[1]], isSelect: true, executionTimeMs: 4 }, 'SELECT 1')
    expect(pSets[0].columns).toEqual([])
    expect(pSets[0].rowCount).toBe(1)

    // 2. src/editor/studio-export.ts (L122: !ctx.dataGrid || !actionValue)
    executeStudioExportAction('csv', { dataGrid: null, updateStatus: vi.fn() })
    executeStudioExportAction('', { dataGrid: {} as never, updateStatus: vi.fn() })

    // 3. src/editor/grid-selection.ts (L657: defensive summary when empty)
    const selModel = new GridSelectionModel()
    expect(selModel.computeSelectionSummary(0, 0, () => null).focus).toBeNull()

    // 4. src/editor/console-tabs.ts (L289: setResultForTab with resultStates undefined)
    const cTabs = new ConsoleTabsManager()
    const tId = cTabs.getActiveTabId()
    expect(cTabs.setResultForTab(tId, { columns: [], rows: [], rowCount: 0, executionTimeMs: 1, truncated: false, isSelect: true }, 0, 'SELECT 1')).toBe(true)

    // 5. src/editor/studio-sidebar.ts (L241-242), grid-icons.ts (L135-136), studio-columns-popover.ts (L117-121)
    const anchor = document.createElement('button')
    anchor.getBoundingClientRect = () => ({ top: 10, bottom: 30, left: 10, right: 80, width: 70, height: 20, x: 10, y: 10, toJSON() {} })
    document.body.appendChild(anchor)

    const emptyMenu = createSidebarContextMenu({
      item: { name: 't1', kind: 'table' },
      clientX: 50,
      clientY: 50,
      isReadOnly: false,
      onCountRows: vi.fn(),
      onSelectSqlTemplate: vi.fn(),
      onOpenInspector: vi.fn(),
      onCopyObjectDdl: vi.fn(),
      onOpenObjectDdlInConsole: vi.fn(),
      onOpenImportModal: vi.fn(),
      onOpenDangerModal: vi.fn(),
    })
    document.body.appendChild(emptyMenu)

    const fakeColGrid = {
      getColumnConfig: () => ({ allColumns: ['id', 'name'], order: ['id', 'name'], hidden: [], pinned: [] }),
      setColumnVisibility: vi.fn(),
      setColumnPinned: vi.fn(),
      resetColumnVisibility: vi.fn(),
    } as never
    withTempGlobal('window', undefined, () => {
      clampFixedPopup(emptyMenu, 50, 50)
      const mounted = mountStudioColumnsPopover(fakeColGrid, anchor, vi.fn())
      mounted.outsideCleanup?.()
      mounted.popoverEl.remove()
    })
    // Also zero innerWidth/innerHeight + zero popRect fallback
    ;(window as { innerWidth: number }).innerWidth = 0
    ;(window as { innerHeight: number }).innerHeight = 0
    const zeroAnchor = document.createElement('button')
    zeroAnchor.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} })
    const zeroMounted = mountStudioColumnsPopover(fakeColGrid, zeroAnchor, vi.fn())
    zeroMounted.popoverEl.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} })
    window.dispatchEvent(new Event('resize'))
    zeroMounted.outsideCleanup?.()
    zeroMounted.popoverEl.remove()
    emptyMenu.remove()

    // 6. src/editor/danger-sql-modal.ts (L202-203 non-prod vs prod checkbox & CONFIRM)
    let mountedEl: HTMLElement | null = null
    openStudioDangerSqlModal({
      mountModal: (el) => {
        mountedEl = el
        document.body.appendChild(el)
        return document.createElement('div')
      },
      closeModal: vi.fn(),
      connectionName: 'Prod',
      colorTag: 'prod',
      findings: [{ kind: 'delete_without_where', message: 'No WHERE' }],
      sql: 'DELETE FROM t;',
      onConfirm: vi.fn(),
    })
    const cb = mountedEl!.querySelector('.datanoa-danger-confirm-check') as HTMLInputElement
    const txt = mountedEl!.querySelector('.datanoa-danger-confirm-input') as HTMLInputElement
    cb.checked = true
    cb.dispatchEvent(new Event('change'))
    txt.value = 'CONFIRM'
    txt.dispatchEvent(new Event('input'))
    mountedEl!.remove()

    // 7. src/editor/result-set-controller.ts (L31, 160-210)
    const sSets = getStudioEffectiveResultSets({ rows: [[1]], isSelect: true, executionTimeMs: 3 } as never, 'SELECT 1')
    expect(sSets[0].columns).toEqual([])
    buildInitialResultTabStates(
      { columns: [], rows: [], rowCount: 0, executionTimeMs: 1, truncated: false, isSelect: false, affectedRows: undefined } as never,
      ['DELETE FROM t'],
      'DELETE FROM t',
      1,
      'query'
    )
    buildInitialResultTabStates(
      {
        columns: [],
        rows: [],
        rowCount: 0,
        executionTimeMs: 1,
        truncated: false,
        isSelect: false,
        resultSets: [
          { index: 0, sqlPreview: 'D1', sql: 'DELETE FROM a', executionTimeMs: 1, columns: [], rows: [], rowCount: 0, truncated: false, isSelect: false },
          { index: 1, sqlPreview: 'S2', sql: 'SELECT 1', executionTimeMs: 1, columns: undefined as never, rows: [], rowCount: 0, truncated: false, isSelect: true },
        ],
      },
      ['DELETE FROM a', 'SELECT 1'],
      'DELETE FROM a; SELECT 1;',
      2,
      'query'
    )
    const emptyCombined = buildCombinedExplainResult([], null, 0)
    expect(emptyCombined.rows).toEqual([])
  })

  it('closes panel-feedback-palette, grid-menus & feedback-modal branches', async () => {
    // 8. src/panel/panel-feedback-palette.js: first without DOM nodes -> hits !grid, !modal, !listEl guards
    const copyText = vi.fn(async () => {})
    const showBanner = vi.fn()
    const ctrlNoDom = createPanelFeedbackAndPaletteController({
      state: { tab: '', lastQueryError: 'x'.repeat(60) },
      getActiveConn: () => null,
      closeContextMenu: vi.fn(),
      closeDataColsPopover: vi.fn(),
      closePanelComboPopover: vi.fn(),
      resetConnectionForm: vi.fn(),
      setFormOpen: vi.fn(),
      openFullStudio: vi.fn(),
      switchTab: vi.fn(),
      formatSqlInEditor: vi.fn(),
      openCreateTableModal: vi.fn(),
      refreshConnections: vi.fn(),
      copyText,
      showBanner,
    })
    ctrlNoDom.openFeedbackModal('bug')
    ctrlNoDom.openCmdPaletteModal()
    const partialPaletteModal = document.createElement('div')
    partialPaletteModal.id = 'cmdPaletteModal'
    document.body.appendChild(partialPaletteModal)
    ctrlNoDom.openCmdPaletteModal()
    partialPaletteModal.remove()

    // Now with full Panel Feedback + Command Palette DOM nodes, navigator undefined & userAgentData
    const makeEl = (tag: string, id: string) => {
      const el = document.createElement(tag)
      el.id = id
      document.body.appendChild(el)
      return el
    }
    const fbModal = makeEl('div', 'feedbackModal')
    makeEl('button', 'feedbackBtn')
    makeEl('button', 'feedbackKindBugBtn')
    makeEl('button', 'feedbackKindFeatureBtn')
    makeEl('span', 'feedbackDescLabel')
    const fbTitle = makeEl('input', 'feedbackTitleInput') as HTMLInputElement
    makeEl('textarea', 'feedbackDescInput')
    makeEl('div', 'feedbackDiagGrid')
    makeEl('button', 'feedbackCopyBtn')
    const fbOpen = makeEl('button', 'feedbackOpenGithubBtn')
    makeEl('button', 'feedbackCancelBtn')
    const cmdModal = makeEl('div', 'cmdPaletteModal')
    makeEl('input', 'cmdPaletteInput')
    makeEl('div', 'cmdPaletteList')

    const ctrl = createPanelFeedbackAndPaletteController({
      state: { tab: 'sql', lastQueryError: 'Short error' },
      getActiveConn: () => ({ id: 'c1', driver: 'sqlite', readOnly: false }),
      closeContextMenu: vi.fn(),
      closeDataColsPopover: vi.fn(),
      closePanelComboPopover: vi.fn(),
      resetConnectionForm: vi.fn(),
      setFormOpen: vi.fn(),
      openFullStudio: vi.fn(),
      switchTab: vi.fn(),
      formatSqlInEditor: vi.fn(),
      openCreateTableModal: vi.fn(),
      refreshConnections: vi.fn(),
      copyText,
      showBanner,
    })
    ctrl.bindEvents()
    withTempGlobal('navigator', { userAgentData: { platform: 'Linux armv8' }, platform: '' }, () => ctrl.openFeedbackModal('bug'))
    withTempGlobal('navigator', undefined, () => ctrl.openFeedbackModal('bug'))
    fbTitle.value = 'Issue'
    ;(window as { open?: unknown }).open = () => ({})
    fbOpen.click()
    await flushMicro(4)
    ;(window as { open?: unknown }).open = undefined
    fbOpen.click()
    await flushMicro(4)
    ctrl.openCmdPaletteModal()
    cmdModal.hidden = true
    fbModal.hidden = true

    // 9. src/editor/grid-menus.ts (singular/plural onNotify, zero cellCount, TSV quotes, existingForCol null vs string)
    const notify = vi.fn()
    const gridModel = {
      headers: ['name'],
      columns: [{ name: 'name', type: 'TEXT', nullable: true, isPrimaryKey: true }],
      rows: [['plain'], ['has\ttab'], ['has"quote'], ['has\nnewline'], ['has\rcr']],
      totalRows: 5,
      page: 1,
      pageSize: 100,
      primaryKey: ['name'],
      canEdit: true,
    }
    const baseSummary = { cellCount: 2, rowCount: 2, colCount: 1, nonNullCount: 2, numericCount: 0, sum: null, avg: null, min: null, max: null, mode: 'cell' as const, focus: null, isTruncatedScan: false }
    const cellMenu1 = buildGridCellContextMenu({
      clientX: 10,
      clientY: 10,
      rowIndex: 0,
      colIndex: 0,
      columnName: 'name',
      rawValue: 'a\tb"c\nd\re',
      td: document.createElement('td') as HTMLTableCellElement,
      model: gridModel,
      rowState: undefined,
      interactionLocked: false,
      batchMode: true,
      stagedCount: 0,
      dialect: 'sqlite',
      summary: baseSummary,
      fk: null,
      hasFkHandler: false,
      isCellEditable: true,
      isColumnNullable: true,
      closeMenu: vi.fn(),
      copySelection: () => '',
      onNotify: notify,
      triggerPasteAction: async () => {},
      buildSelectedCellInfo: () => null,
      onInspectCell: vi.fn(),
      bulkSetCellsValue: () => 1,
      applyDirectNull: vi.fn(),
      openBulkFill: vi.fn(),
      triggerQuickFilter: vi.fn(),
      triggerFkJump: vi.fn(),
      bulkCloneSelectedRows: () => 0,
      cloneSingleRow: vi.fn(),
      bulkMarkRowsDeleted: vi.fn(),
      markSingleRowDeleted: vi.fn(),
    })
    Array.from(cellMenu1.querySelectorAll('.datanoa-context-item')).find((b) => /Set.*NULL/i.test(b.textContent || ''))?.dispatchEvent(new MouseEvent('click'))
    expect(notify).toHaveBeenCalledWith('Set 1 cell to NULL')
    const cellMenuZero = buildGridCellContextMenu({
      clientX: 10,
      clientY: 10,
      rowIndex: 0,
      colIndex: 0,
      columnName: 'name',
      rawValue: 'a',
      td: document.createElement('td') as HTMLTableCellElement,
      model: gridModel,
      rowState: undefined,
      interactionLocked: false,
      batchMode: true,
      stagedCount: 0,
      dialect: 'sqlite',
      summary: { ...baseSummary, cellCount: 0 },
      fk: null,
      hasFkHandler: false,
      isCellEditable: true,
      isColumnNullable: true,
      closeMenu: vi.fn(),
      copySelection: () => '',
      onNotify: notify,
      triggerPasteAction: async () => {},
      buildSelectedCellInfo: () => null,
      onInspectCell: vi.fn(),
      bulkSetCellsValue: () => 1,
      applyDirectNull: vi.fn(),
      openBulkFill: vi.fn(),
      triggerQuickFilter: vi.fn(),
      triggerFkJump: vi.fn(),
      bulkCloneSelectedRows: () => 0,
      cloneSingleRow: vi.fn(),
      bulkMarkRowsDeleted: vi.fn(),
      markSingleRowDeleted: vi.fn(),
    })
    Array.from(cellMenuZero.querySelectorAll('.datanoa-context-item')).find((b) => /Bulk Fill/i.test(b.textContent || ''))?.dispatchEvent(new MouseEvent('click'))

    const hdrMenu = buildGridHeaderContextMenu({
      clientX: 10,
      clientY: 10,
      modelColIdx: 0,
      header: 'name',
      model: gridModel,
      dialect: 'sqlite',
      isPinned: false,
      visibleColsCount: 2,
      rowIndices: [0, 1, 2, 3, 4],
      closeMenu: vi.fn(),
      selectColumn: vi.fn(),
      onNotify: notify,
      onSort: vi.fn(),
      togglePin: vi.fn(),
      hideColumn: vi.fn(),
      autoFitColumn: vi.fn(),
    })
    Array.from(hdrMenu.querySelectorAll('.datanoa-context-item')).find((b) => /Copy Column Values/i.test(b.textContent || ''))?.dispatchEvent(new MouseEvent('click'))

    const bulkPop = buildGridBulkFillPopover({
      clientX: 10,
      clientY: 10,
      cellCount: 1,
      closePopover: vi.fn(),
      onApplyValue: () => 1,
      onNotify: notify,
    })
    ;(bulkPop.querySelector('input') as HTMLInputElement).value = 'val'
    Array.from(bulkPop.querySelectorAll('button')).find((b) => b.textContent === 'Apply')?.dispatchEvent(new MouseEvent('click'))
    expect(notify).toHaveBeenCalledWith('Filled 1 cell')

    const filterAnchor = document.createElement('button')
    filterAnchor.getBoundingClientRect = () => ({ top: 10, bottom: 30, left: 10, right: 80, width: 70, height: 20, x: 10, y: 10, toJSON() {} })
    document.body.appendChild(filterAnchor)
    buildGridColumnFilterPopover({
      column: 'notes',
      anchorEl: filterAnchor,
      existingForCol: { column: 'notes', value: null, op: 'is-null' },
      closePopover: vi.fn(),
      onApply: vi.fn(),
      onClear: vi.fn(),
    })
    buildGridColumnFilterPopover({
      column: 'notes',
      anchorEl: filterAnchor,
      existingForCol: { column: 'notes', value: 42, op: 'eq' },
      closePopover: vi.fn(),
      onApply: vi.fn(),
      onClear: vi.fn(),
    })

    // 10. src/editor/feedback-modal.ts (window undefined, document undefined, navigator/process fallback, shell undefined)
    withTempGlobal('window', undefined, () => {
      withTempGlobal('navigator', { userAgentData: { platform: 'Win11' } }, () => {
        expect(buildStudioDiagnosticSummary({ activeDriver: 'sqlite', activeViewMode: 'split', isReadOnly: false })).toContain('Platform: Win11')
      })
      withTempGlobal('navigator', { platform: '' }, () => {
        expect(buildStudioDiagnosticSummary({ activeDriver: 'sqlite', activeViewMode: 'split', isReadOnly: false }).length).toBeGreaterThan(0)
      })
      withTempGlobal('navigator', undefined, () => {
        withTempGlobal('process', undefined, () => {
          expect(buildStudioDiagnosticSummary({ activeDriver: 'sqlite', activeViewMode: 'split', isReadOnly: false })).toContain('Platform: unknown')
        })
      })
    })
    withTempGlobal('document', undefined, () => {
      openStudioFeedbackModal({ mountModal: vi.fn(() => null), closeModal: vi.fn(), activeDriver: null, activeViewMode: 'split', isReadOnly: false, lastQueryErrorText: '', updateStatus: vi.fn() })
    })
    let fbEl: HTMLElement | null = null
    ;(window as { orca?: unknown; open?: unknown }).orca = {}
    ;(window as { open?: unknown }).open = () => null
    openStudioFeedbackModal({
      mountModal: (el) => { fbEl = el; document.body.appendChild(el); return document.createElement('div') },
      closeModal: vi.fn(),
      activeDriver: 'sqlite',
      activeViewMode: 'grid',
      isReadOnly: true,
      lastQueryErrorText: 'err',
      updateStatus: vi.fn(),
    })
    const diagPre = fbEl!.querySelector('.datanoa-feedback-diag') as HTMLElement
    diagPre.textContent = ''
    Array.from(fbEl!.querySelectorAll('button')).find((b) => /Open GitHub/i.test(b.textContent || ''))?.click()
    await flushMicro(4)
  })

  it('closes bind-params-modal, transaction-toolbar & value-inspector tails', async () => {
    // 11. src/editor/bind-params-modal.ts (non-Error / invalid number, Enter disabled vs valid, double-submit, disabled focus)
    vi.useFakeTimers()
    let bpEl: HTMLElement | null = null
    const onConfirmBp = vi.fn()
    openStudioBindParamsModal({
      mountModal: (el) => { bpEl = el; document.body.appendChild(el); return document.createElement('div') },
      closeModal: vi.fn(),
      sql: 'SELECT * FROM t WHERE id = :id AND name = :name',
      dialect: 'sqlite',
      params: [{ key: 'id', placeholder: ':id', label: 'id' }, { key: 'name', placeholder: ':name', label: 'name' }],
      rememberedValues: {},
      onConfirm: onConfirmBp,
    })
    const bpSel = bpEl!.querySelectorAll('select')[0] as HTMLSelectElement
    const bpInp0 = bpEl!.querySelectorAll('input[type="text"]')[0] as HTMLInputElement
    bpSel.value = 'null'
    bpSel.dispatchEvent(new Event('change'))
    vi.advanceTimersByTime(60)
    bpSel.value = 'number'
    bpSel.dispatchEvent(new Event('change'))
    bpInp0.value = 'not_a_number'
    bpInp0.dispatchEvent(new Event('input'))
    // Enter while disabled -> blocked
    bpEl!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onConfirmBp).not.toHaveBeenCalled()
    bpInp0.value = '12'
    bpInp0.dispatchEvent(new Event('input'))
    const runBpBtn = Array.from(bpEl!.querySelectorAll('button')).find((b) => b.textContent === 'Run Query') as HTMLButtonElement
    runBpBtn.click()
    runBpBtn.click() // double submit guard
    expect(onConfirmBp).toHaveBeenCalledTimes(1)
    vi.useRealTimers()

    // 12. src/editor/transaction-toolbar.ts (unmounted guard, RO/unsupported, cleanup-wait + stale gen on toggle/begin/commit/rollback)
    let activeConn: string | null = 'c1'
    let ro = false
    let deferCleanup!: () => void
    let cleanupCount = 0
    const reqPlugin = vi.fn(async (m: string) => {
      if (m === 'tx.rollback' && cleanupCount++ === 0) {
        await new Promise<void>((r) => { deferCleanup = r })
      }
      if (m === 'tx.begin') return { supported: true, autoCommit: false, active: true, txToken: 77 }
      if (m === 'tx.status') return { supported: true, autoCommit: false, active: true, txToken: 77 }
      return { supported: true, autoCommit: true, active: false }
    })
    const tx = new TransactionToolbarController({
      getActiveConnectionId: () => activeConn,
      getActiveConnection: () => (activeConn ? { id: activeConn, name: 'SQLite', driver: 'sqlite', readOnly: ro } : undefined),
      isReadOnly: () => ro,
      isQueryRunning: () => false,
      isShowingSqlResult: () => false,
      getActiveTable: () => 't',
      getCurrentPage: () => 1,
      requestPlugin: reqPlugin as never,
      reloadTableData: vi.fn(),
      showErrorBanner: vi.fn(),
      updateStatus: vi.fn(),
    })
    // Before mount:
    tx.resetLocalStateAndRender()
    const tb = document.createElement('div')
    tx.mount(tb)
    await tx.refreshState('c1')
    // Switch to c2 triggers deferred rollback cleanup tracking on c1
    tx.resetForConnectionSwitch('c1')
    // Switch back to c1 while c1 cleanup pending -> toggleAutoCommit awaits cleanup -> then switch away to invalidate gen!
    const pToggle = tx.toggleAutoCommit()
    tx.resetForConnectionSwitch('c1')
    deferCleanup()
    await pToggle
    ro = true
    await tx.toggleAutoCommit()
    await tx.begin()
    ro = false

    // Now test waitForConnectionCleanup returning false on begin, commit, rollback
    for (const op of ['begin', 'commit', 'rollback'] as const) {
      cleanupCount = 0
      await tx.refreshState('c1')
      tx.resetForConnectionSwitch('c1')
      const p = tx[op]()
      tx.resetForConnectionSwitch('c1')
      deferCleanup()
      await p
    }
    tx.destroy()

    // 13. src/editor/value-inspector.ts (localStorage/window undefined, zero rectH, JSON invalid/pretty/minify/copy, Ctrl+Enter, array row PK, error throw)
    withTempGlobal('localStorage', undefined, () => {
      const viCtrlNoLs = new ValueInspectorController({
        getInspectButton: () => null,
        getDataGrid: () => null,
        getActiveTarget: () => ({ connectionId: null, table: null, page: 1, isShowingSqlResult: false, viewSeq: 1 }),
        updateStatus: vi.fn(),
        updateCell: vi.fn(),
        reloadTableData: vi.fn(),
      })
      const el = viCtrlNoLs.buildElement()
      el.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} })
      const resizer = el.querySelector('.datanoa-value-inspector-resizer') as HTMLElement
      // Twice to trigger prior cleanup
      resizer.dispatchEvent(new MouseEvent('mousedown', { clientY: 100, bubbles: true }))
      resizer.dispatchEvent(new MouseEvent('mousedown', { clientY: 100, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup', { clientY: 80, bubbles: true }))
      withTempGlobal('window', undefined, () => {
        resizer.dispatchEvent(new MouseEvent('mousedown', { clientY: 100, bubbles: true }))
      })
      viCtrlNoLs.destroy()
    })

    const fakeGrid = {
      isBatchMode: () => false,
      getStagedCount: () => 0,
      stageCellEdit: vi.fn(),
      getModel: () => ({ headers: ['id', 'meta'], rows: [[1, 'not_json']], primaryKey: ['id'] }),
    }
    const updateCellErr = vi.fn(async () => { throw 'string update fail' })
    const viCtrl = new ValueInspectorController({
      getInspectButton: () => null,
      getDataGrid: () => fakeGrid as never,
      getActiveTarget: () => ({ connectionId: 'c1', table: 't', page: 1, isShowingSqlResult: false, viewSeq: 1 }),
      updateStatus: vi.fn(),
      updateCell: updateCellErr,
      reloadTableData: vi.fn(),
    })
    const viEl = viCtrl.buildElement()
    viCtrl.open({ rowIndex: 0, colIndex: 1, columnName: 'meta', columnType: 'TEXT', value: 'bad{json', isNullable: false, isEditable: true, isInserted: false })
    const viTa = viEl.querySelector('textarea') as HTMLTextAreaElement
    Array.from(viEl.querySelectorAll('button')).find((b) => b.textContent === 'Format JSON')?.click()
    Array.from(viEl.querySelectorAll('button')).find((b) => b.textContent === 'Minify JSON')?.click()
    Array.from(viEl.querySelectorAll('button')).find((b) => b.textContent === 'Copy')?.click()
    viTa.value = '{"ok":1}'
    viTa.dispatchEvent(new Event('input'))
    Array.from(viEl.querySelectorAll('button')).find((b) => b.textContent === 'Format JSON')?.click()
    Array.from(viEl.querySelectorAll('button')).find((b) => b.textContent === 'Minify JSON')?.click()
    viTa.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    await flushMicro(4)
    // Non-nullable SET NULL guard & non-editable guard
    viCtrl.open({ rowIndex: 0, colIndex: 1, columnName: 'meta', columnType: 'TEXT', value: 'x', isNullable: false, isEditable: false, isInserted: false })
    viTa.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
    viCtrl.destroy()
  })

  it('closes studio-modals, saved-queries-modal, panel-cm, driver-manager-modal & shared-file-picker tails', async () => {
    vi.useFakeTimers()

    // 14. src/editor/studio-modals.ts (Create Table errors/PK/nullable, Mongo danger table, Command Palette unknown obj.kind)
    let modEl: HTMLElement | null = null
    openStudioCreateTableModal({
      mountModal: (el) => { modEl = el; document.body.appendChild(el); return document.createElement('div') },
      closeModal: vi.fn(),
      activeConnection: { id: 'cpg', name: 'PG', driver: 'postgres', readOnly: false },
      activeConnectionId: 'cpg',
      activeSchema: 'public',
      updateStatus: vi.fn(),
      createElapsedTimer: () => () => {},
      requestPlugin: vi.fn(async () => { throw 'string create err' }) as never,
      onTableCreated: vi.fn(),
    })
    const pkCb = modEl!.querySelectorAll('.datanoa-struct-grid input[type="checkbox"]')[0] as HTMLInputElement
    pkCb.checked = true
    pkCb.dispatchEvent(new Event('change'))
    const rmBtn = Array.from(modEl!.querySelectorAll('.datanoa-struct-grid button')).find((b) => b.textContent === '×') as HTMLButtonElement
    rmBtn.dispatchEvent(new MouseEvent('click')) // disabled <= 1 row
    ;(modEl!.querySelector('.datanoa-filter-input') as HTMLInputElement).value = 't_new'
    ;(modEl!.querySelector('.datanoa-filter-input') as HTMLInputElement).dispatchEvent(new Event('input'))
    Array.from(modEl!.querySelectorAll('button')).find((b) => b.textContent === 'Create Table')?.click()
    await flushMicro(4)
    modEl!.remove()

    openStudioDangerTableModal({
      mountModal: (el) => { modEl = el; document.body.appendChild(el); return document.createElement('div') },
      closeModal: vi.fn(),
      activeConnection: { id: 'cm', name: 'M', driver: 'mongodb', readOnly: false },
      activeConnectionId: 'cm',
      updateStatus: vi.fn(),
      showQueryBanner: vi.fn(),
      createElapsedTimer: () => () => {},
      requestPlugin: vi.fn(async () => { throw 'danger fail' }) as never,
      onDangerActionSucceeded: vi.fn(),
    }, 'truncate', { name: 'users', kind: 'collection' as never })
    const dtInp = modEl!.querySelector('#datanoa-danger-table-confirm-input') as HTMLInputElement
    dtInp.value = 'users'
    dtInp.dispatchEvent(new Event('input'))
    Array.from(modEl!.querySelectorAll('button')).find((b) => /Truncate Collection/i.test(b.textContent || ''))?.click()
    await flushMicro(4)
    modEl!.remove()

    openStudioCommandPalette({
      mountModal: (el) => { modEl = el; document.body.appendChild(el); return document.createElement('div') },
      closeModal: vi.fn(),
      schemaObjects: [{ name: 'x', kind: 'other' as never }],
      connections: [],
      activeConnection: undefined,
      sidebarCollapsed: false,
      selectSidebarObject: vi.fn(),
      openExportSchemaDdl: vi.fn(),
      selectConnection: vi.fn(),
      openConnectionModal: vi.fn(),
      formatSqlInConsole: vi.fn(),
      openCreateTableModal: vi.fn(),
      openImportDataModal: vi.fn(),
      setSidebarCollapsed: vi.fn(),
      switchMode: vi.fn(),
      toggleQueryHistory: vi.fn(),
      openSavedQueriesModal: vi.fn(),
      handleRefreshAction: vi.fn(),
      openShortcutsModal: vi.fn(),
      openFeedbackModal: vi.fn(),
    })
    modEl!.remove()

    // 15. src/editor/saved-queries-modal.ts (non-array entries, undefined tags, busy/closed mid-flight, blur/timer cancel)
    let resolveLoad!: (v: unknown) => void
    let rejectSave!: (e: unknown) => void
    const sqReq = vi.fn((m: string) => {
      if (m === 'queries.saved.list') return new Promise((r) => { resolveLoad = r })
      if (m === 'queries.saved.save') return new Promise((_, j) => { rejectSave = j })
      return Promise.reject('delete string error')
    })
    let sqCloseCb!: () => void
    openStudioSavedQueriesModal({
      mountModal: (el) => { modEl = el; document.body.appendChild(el); return document.createElement('div') },
      closeModal: () => { sqCloseCb?.(); modEl?.remove() },
      currentSql: 'SELECT 1',
      activeDialect: 'sqlite',
      requestPlugin: sqReq as never,
      updateStatus: vi.fn(),
      onInsertSql: vi.fn(),
    })
    // Click Reset/Close while isLoading === true
    Array.from(modEl!.querySelectorAll('button')).find((b) => b.textContent === 'Reset')?.click()
    Array.from(modEl!.querySelectorAll('button')).find((b) => b.textContent === 'Close')?.click()
    resolveLoad({ entries: [{ id: 'sq1', name: 'Q1', sql: 'SELECT 1;', dialect: 'sqlite', updatedAt: Date.now() }] })
    await flushMicro(4)
    const sqInp = modEl!.querySelector('#datanoa-saved-query-name') as HTMLInputElement
    Array.from(modEl!.querySelectorAll('button')).find((b) => b.textContent === 'Edit')?.click()
    const delBtn = Array.from(modEl!.querySelectorAll('button')).find((b) => /Delete/i.test(b.textContent || '')) as HTMLButtonElement
    delBtn.click()
    delBtn.dispatchEvent(new Event('blur'))
    delBtn.click()
    vi.advanceTimersByTime(4100)
    delBtn.click()
    delBtn.click()
    await flushMicro(4)
    sqInp.value = 'X'
    ;(modEl!.querySelector('#datanoa-saved-query-sql') as HTMLTextAreaElement).value = 'SELECT 2;'
    ;(modEl!.querySelector('.datanoa-saved-form-actions .datanoa-btn-primary') as HTMLButtonElement).click()
    // Simulate closing mid-save
    Array.from(modEl!.querySelectorAll('button')).find((b) => b.textContent === '×' || b.textContent === 'Close')?.click()
    rejectSave?.('save err')
    await flushMicro(4)

    // 16. src/editor/driver-manager-modal.ts (builtin status, document undefined, errors, empty localPath)
    withTempGlobal('document', undefined, () => {
      openStudioDriverManagerModal({ mountModal: vi.fn(() => null), closeModal: vi.fn(), requestPlugin: vi.fn() as never })
    })
    let dmEl: HTMLElement | null = null
    let dmMode = 'ok'
    openStudioDriverManagerModal({
      mountModal: (el) => { dmEl = el; document.body.appendChild(el); return document.createElement('div') },
      closeModal: () => dmEl?.remove(),
      requestPlugin: vi.fn(async (m: string) => {
        if (dmMode === 'listErr') throw 'list boom'
        if (m === 'drivers.list') {
          return {
            drivers: [
              { id: 'sqlite', label: 'SQLite', mode: 'builtin', status: 'builtin', installed: true },
              { id: 'postgres', label: 'Postgres', mode: 'byod', status: 'local-verified', installed: true, entryPath: '/x', sha256: 'abc' },
            ],
          }
        }
        throw new Error(`${m} failed`)
      }) as never,
    })
    await flushMicro(6)
    const dmInp = dmEl!.querySelector('input') as HTMLInputElement | null
    if (dmInp) {
      dmInp.value = '   '
      Array.from(dmEl!.querySelectorAll('button')).find((b) => /Inspect|Browse|Verify|Save|Remove/i.test(b.textContent || ''))?.click()
    }
    dmEl?.remove()

    // 17. src/panel/panel-cm.js (head fallback, MSSQL/Oracle/PG multi-line quotes & block comments, omitted schema)
    expect(extractPanelCaretStatementSql({ doc: { toString: () => 'SELECT 1; SELECT 2;' }, selection: { main: { empty: true, from: 12 } } } as never, 'sqlite')).toBe('SELECT 2')
    expect(extractPanelCaretStatementSql({ doc: { toString: () => 'SELECT 1;' }, selection: { main: { empty: true } } } as never, 'sqlite')).toBe('SELECT 1')
    const cmHost = document.createElement('div')
    document.body.appendChild(cmHost)
    for (const [dialect, doc] of [
      ['mssql', 'SELECT TOP 1 VARCHAR(10), [col] FROM tbl /* multi\ncomment */'],
      ['oracle', "SELECT q'[hello\nworld]' FROM dual /* block\nend */ -- line"],
      ['postgres', 'SELECT $1, $param /* multi\ncomment */ // line'],
    ] as const) {
      const ed = createPanelCodeMirrorEditor({ parent: cmHost, initialDoc: doc, dialect })
      ed.setSchema(null as never, undefined)
      ed.setDialect('postgres')
      ed.setValue('SELECT $abc;')
      ed.setTypography({ fontFamily: 'monospace', fontSize: 12 })
      ed.setPlaceholder('SQL...')
      ed.destroy()
    }
    cmHost.remove()

    // 18. src/shared-file-picker.js (root label, trailing slash, filter clears selected, keyboard nav, listDir error, folder mode & closed guard)
    expect(compactPickerRootLabel('/')).toBe('/')
    vi.useRealTimers()
    let pickerRes: unknown = null
    let fpListCount = 0
    const fpCtx = {
      mountModal: vi.fn(),
      closeModal: vi.fn(),
      requestPlugin: vi.fn(async (_m: string, input?: { dir?: string }) => {
        fpListCount++
        if (fpListCount === 1) {
          return {
            ok: true,
            currentDir: 'D:/work///',
            parentDir: 'D:/',
            roots: ['D:/', 'D:/work///'],
            entries: [
              { name: 'sub', path: 'D:/work/sub', kind: 'dir' },
              { name: 'data.db', path: 'D:/work/data.db', kind: 'file', size: 1024 },
            ],
          }
        }
        return { ok: false, error: 'Denied', currentDir: input?.dir || '' }
      }) as never,
    }
    const fpPromise = openStudioFilePickerModal(fpCtx, {
      title: 'Pick File',
      mode: 'file',
    }).then((r) => { pickerRes = r })
    await flushTick()
    const fpOverlay = document.querySelector('.datanoa-fp-overlay') as HTMLElement
    const fpFilter = fpOverlay.querySelector('.datanoa-fp-filter') as HTMLInputElement
    const rows = Array.from(fpOverlay.querySelectorAll('[role="option"]')) as HTMLElement[]
    rows[1]?.click() // select data.db
    fpFilter.value = 'sub'
    fpFilter.dispatchEvent(new Event('input')) // hides data.db -> selectedEntry cleared
    fpFilter.value = 'zzz_missing'
    fpFilter.dispatchEvent(new Event('input')) // empty state
    fpFilter.value = ''
    fpFilter.dispatchEvent(new Event('input'))
    fpFilter.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushTick()
    ;(fpOverlay.querySelectorAll('[role="option"]')[1] as HTMLElement | undefined)?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    if (pickerRes === null) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    }
    await fpPromise

    // Folder mode empty directory branch
    const fpFolderCtx = {
      mountModal: vi.fn(),
      closeModal: vi.fn(),
      requestPlugin: vi.fn(async () => ({
        ok: true,
        currentDir: 'D:/empty',
        parentDir: 'D:/',
        roots: ['D:/empty'],
        entries: [],
      })) as never,
    }
    const fpFolderPromise = openStudioFilePickerModal(fpFolderCtx, {
      title: 'Pick Folder',
      mode: 'folder',
    })
    await flushTick()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await fpFolderPromise
  })
})
