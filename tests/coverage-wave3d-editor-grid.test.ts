import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'
import { installDomHarness, type DomHarness } from './helpers/dom-harness.js'
import { VirtualDataGrid } from '../src/editor/grid.js'
import type { TableBrowseResult, ColumnInfo, ForeignKeyInfo } from '../src/protocol.js'

async function flushMicro(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
  }
}

function makeRichBrowseData(rowCount = 150, canEdit = true): TableBrowseResult {
  const columns: ColumnInfo[] = [
    { name: 'id', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, isPrimaryKey: true, isAutoIncrement: true },
    { name: 'name', type: 'TEXT', nativeType: 'TEXT', nullable: true },
    { name: 'dept_id', type: 'INTEGER', nativeType: 'INTEGER', nullable: true },
    { name: 'active', type: 'BOOLEAN', nativeType: 'BOOLEAN', nullable: false, defaultValue: 'true' },
    { name: 'score', type: 'REAL', nativeType: 'REAL', nullable: false, defaultValue: '0' },
    { name: 'meta', type: 'JSON', nativeType: 'JSON', nullable: true },
  ]
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < rowCount; i++) {
    rows.push({
      id: i + 1,
      name: i % 5 === 0 ? null : `User_${i}`,
      dept_id: (i % 3) + 1,
      active: i % 2 === 0,
      score: (i * 1.5) % 97,
      meta: i % 4 === 0 ? null : i % 2 === 0 ? { tier: i } : `["tag_${i}"]`,
    })
  }
  return {
    columns,
    rows,
    totalRows: rowCount,
    page: 1,
    pageSize: rowCount,
    primaryKey: ['id'],
    canEdit,
  }
}

function attachSizedContainer(): HTMLDivElement {
  const box = document.createElement('div') as unknown as HTMLDivElement
  box.style.width = '800px'
  box.style.height = '420px'
  box.clientWidth = 800
  box.clientHeight = 420
  box.getBoundingClientRect = () => ({
    top: 0,
    left: 0,
    right: 800,
    bottom: 420,
    width: 800,
    height: 420,
    x: 0,
    y: 0,
    toJSON() {},
  })
  document.body.appendChild(box)
  return box
}

function patchGridScrollGeometry(container: HTMLElement): HTMLElement {
  const scroller = container.querySelector('.datanoa-grid-container') as HTMLElement
  scroller.clientWidth = 800
  scroller.clientHeight = 420
  scroller.scrollWidth = 1400
  scroller.scrollHeight = 4200
  scroller.getBoundingClientRect = () => ({
    top: 0,
    left: 0,
    right: 800,
    bottom: 420,
    width: 800,
    height: 420,
    x: 0,
    y: 0,
    toJSON() {},
  })
  return scroller
}

describe('Wave 3D Step 1: src/editor/grid.ts (VirtualDataGrid)', () => {
  let dom: DomHarness

  beforeEach(() => {
    dom = installDomHarness({ url: 'http://localhost/' })
  })

  afterEach(() => {
    vi.useRealTimers()
    dom.teardown()
  })

  it('covers virtual scroll, pooling, column visibility/pinning/resize, in-memory sorting, client filters & filter popover, find & FK jump', () => {
    const container = attachSizedContainer()
    const sortCalls: Array<[string, string]> = []
    const colHeaderFilters: Array<unknown[]> = []
    const fkJumps: Array<unknown[]> = []
    const notifications: string[] = []
    const colConfigs: Array<{ hidden: string[]; pinned: string[] }> = []
    const findStates: Array<{ total: number; activeIndex: number }> = []

    const fks: ForeignKeyInfo[] = [
      { column: 'dept_id', referencedTable: 'departments', referencedColumn: 'id' },
    ]

    const grid = new VirtualDataGrid({
      container,
      tableName: 'employees',
      dialect: 'postgres',
      batchMode: false,
      onSort: (c, d) => sortCalls.push([c, d]),
      onColumnHeaderFilter: (col, val, op, mode) => colHeaderFilters.push([col, val, op, mode]),
      onNavigateForeignKey: (t, c, v) => fkJumps.push([t, c, v]),
      onNotify: (m) => notifications.push(m),
      onColumnConfigChange: (cfg) => colConfigs.push(cfg),
      onFindStateChange: (st) => findStates.push(st),
    })
    const scroller = patchGridScrollGeometry(container)

    try {
      // Loading & empty states
      grid.setLoading(true, 'Loading rows...')
      grid.setEmptyMessage('Nothing here')
      grid.setData({ columns: [], rows: [], totalRows: 0, page: 1, pageSize: 50, primaryKey: [], canEdit: false })

      // Large dataset (150 rows -> virtual pool + spacers)
      grid.setContextMeta('employees', 'postgres', 'c1', 'public')
      grid.setForeignKeys(fks)
      grid.setData(makeRichBrowseData(150, true))

      // Vertical scroll triggers RAF pool recycle & horizontal scroll exercises wheel + scrollLeft
      scroller.scrollTop = 900
      scroller.dispatchEvent(new Event('scroll'))
      dom.runRaf()
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, ctrlKey: true, bubbles: true }))
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 2, deltaMode: 1, metaKey: true, bubbles: true }))
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, deltaMode: 2, ctrlKey: true, bubbles: true }))
      // Pure horizontal scroll early return
      scroller.scrollLeft = 120
      scroller.dispatchEvent(new Event('scroll'))
      expect(grid.getScrollLeft()).toBe(120)
      grid.setScrollLeft(20)
      expect(grid.getScrollLeft()).toBe(20)
      grid.handleViewportResize()

      // Column visibility, pinning, config & resize handle drag + dblclick autoFitColumn
      grid.togglePinColumn('id')
      grid.togglePinColumn('name')
      expect(grid.getColumnConfig().pinned).toEqual(['id', 'name'])
      expect(grid.getStickyColumnsWidth()).toBeGreaterThan(0)
      grid.setColumnVisibility('meta', false)
      expect(grid.getColumnConfig().hidden).toContain('meta')
      grid.showAllColumns()
      grid.setColumnConfig({ hidden: ['active'], pinned: ['id'] })
      expect(colConfigs.length).toBeGreaterThan(0)

      // Sorting: server callback BEFORE resize drag (since resize drag suppresses immediate click for 250ms)
      let thName = container.querySelector('.datanoa-th[data-col-index="1"]') as HTMLElement
      thName.click()
      thName = container.querySelector('.datanoa-th[data-col-index="1"]') as HTMLElement
      thName.click()
      thName = container.querySelector('.datanoa-th[data-col-index="1"]') as HTMLElement
      thName.dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }))
      expect(sortCalls.length).toBe(2)

      // Column & row-num resize handle drag + dblclick autoFitColumn
      thName = container.querySelector('.datanoa-th[data-col-index="1"]') as HTMLElement
      const resizeHandle = thName.querySelector('.datanoa-resize-handle') as HTMLElement
      resizeHandle.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 170 }))
      window.dispatchEvent(new MouseEvent('mouseup'))
      resizeHandle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))

      const thRowNum = container.querySelector('.datanoa-th-rownum') as HTMLElement
      thRowNum.click()
      const rnResize = thRowNum.querySelector('.datanoa-resize-handle') as HTMLElement
      rnResize.dispatchEvent(new MouseEvent('mousedown', { clientX: 20, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 45 }))
      window.dispatchEvent(new MouseEvent('mouseup'))
      rnResize.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))

      const rowsBeforeSort = grid.getModel()!.rows
      grid.sortInMemoryRows('score', 'ASC')
      grid.sortInMemoryRows('score', 'DESC')
      grid.sortInMemoryRows('name', 'ASC') // nulls + strings
      grid.sortInMemoryRows('active', 'ASC') // booleans
      grid.sortInMemoryRows('meta', 'ASC') // objects + nulls
      expect(rowsBeforeSort.length).toBe(150)
      grid.clearSortIndicator()

      // Header contextmenu & filter popover (`onColumnHeaderFilter` + internal client filter branch)
      thName.dispatchEvent(new MouseEvent('contextmenu', { clientX: 50, clientY: 50, bubbles: true }))
      const hdrSortDesc = Array.from(document.querySelectorAll('.datanoa-context-item')).find((b) =>
        /Sort Descending|Pin/i.test(b.textContent || '')
      ) as HTMLElement | undefined
      hdrSortDesc?.click()

      const filterBtn = thName.querySelector('.datanoa-col-filter-btn') as HTMLButtonElement
      filterBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      filterBtn.click()
      const pop = document.querySelector('.datanoa-col-filter-popover') as HTMLElement | null
      expect(pop).toBeTruthy()
      const popInput = pop!.querySelector('.datanoa-col-filter-input') as HTMLInputElement
      popInput.value = 'User_1'
      ;(pop!.querySelector('.datanoa-btn-primary') as HTMLButtonElement).click()
      expect(colHeaderFilters.length).toBe(1)

      // Internal filter path (no onColumnHeaderFilter) + filter popover Local Apply / Clear + quickFilter without handler
      const gridLocal = new VirtualDataGrid({
        container: attachSizedContainer(),
        data: makeRichBrowseData(30, true),
        onNotify: (m) => notifications.push(m),
      })
      try {
        gridLocal.addClientColumnFilter('name', 'User_2', 'contains')
        gridLocal.addClientColumnFilter('dept_id', '2', 'eq')
        gridLocal.removeClientColumnFilter('dept_id')
        gridLocal.clearClientColumnFilters()
        gridLocal.setClientFilter('User_1')
        gridLocal.setClientFilter('')

        // Filter popover Clear button on grid (with onColumnHeaderFilter)
        const fBtnClear = (container.querySelector('.datanoa-th[data-col-index="1"] .datanoa-col-filter-btn') as HTMLButtonElement | null)
        fBtnClear?.click()
        const pop2 = document.querySelector('.datanoa-col-filter-popover') as HTMLElement | null
        const clrBtn = Array.from(pop2?.querySelectorAll('button') || []).find((b) => /Clear/i.test(b.textContent || '')) as HTMLButtonElement | undefined
        clrBtn?.click()

        // Local header context menu items (Select Column, Pin, Hide, Auto-fit) & cell quick filter without callback
        const locCont = gridLocal.getModel() ? gridLocal : null
        expect(locCont).toBeTruthy()
        const locTh = document.querySelectorAll('.datanoa-grid-container')[1]?.querySelector('.datanoa-th[data-col-index="1"]') as HTMLElement | null
        const clickLastCtx = (re: RegExp) => {
          const btn = Array.from(document.querySelectorAll('.datanoa-context-item')).find((b) => re.test(b.textContent || '')) as HTMLElement | undefined
          btn?.click()
        }
        locTh?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 10, bubbles: true }))
        clickLastCtx(/Select Column/i)
        locTh?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 10, bubbles: true }))
        clickLastCtx(/Pin Column/i)
        const locThPinned = document.querySelectorAll('.datanoa-grid-container')[1]?.querySelector('.datanoa-th[data-col-index="2"]') as HTMLElement | null
        locThPinned?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 10, bubbles: true }))
        clickLastCtx(/Hide Column/i)
        const locThAuto = document.querySelectorAll('.datanoa-grid-container')[1]?.querySelector('.datanoa-th[data-col-index="1"]') as HTMLElement | null
        locThAuto?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 10, bubbles: true }))
        clickLastCtx(/Auto-fit/i)
        const locTd = document.querySelectorAll('.datanoa-grid-container')[1]?.querySelector('td[data-row-index="0"][data-col-index="1"]') as HTMLElement | null
        locTd?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 40, bubbles: true }))
        clickLastCtx(/^Filter:/i)
      } finally {
        gridLocal.destroy()
      }

      // In-grid Find & Navigation + FK badge + Ctrl+Click jump
      scroller.scrollTop = 0
      scroller.dispatchEvent(new Event('scroll'))
      dom.runRaf()
      grid.setFindQuery('User_')
      expect(grid.getFindState().total).toBeGreaterThan(0)
      grid.findNext(1)
      grid.findNext(-1)
      grid.findNext(1)
      expect(grid.getFindState().activeIndex).toBeGreaterThanOrEqual(0)
      grid.setClientFilter('User_1')
      grid.setClientFilter('')
      expect(findStates.length).toBeGreaterThan(0)

      expect(grid.canJumpForeignKey(0, 2)).toBe(true)
      expect(grid.canJumpForeignKey(0, 1)).toBe(false)
      grid.triggerFkJump(0, 2)
      expect(fkJumps.length).toBe(1)
      const fkBadge = container.querySelector('.datanoa-fk-badge') as HTMLElement | null
      fkBadge?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      fkBadge?.click()
      const deptTd = container.querySelector('td[data-row-index="1"][data-col-index="2"]') as HTMLElement | null
      deptTd?.dispatchEvent(new MouseEvent('mousedown', { button: 0, ctrlKey: true, bubbles: true }))
      expect(fkJumps.length).toBeGreaterThanOrEqual(2)
    } finally {
      grid.destroy()
    }
  })

  it('covers selection, drag selection, keyboard nav, context menus, Bulk Fill popover, exports & transposed mode', async () => {
    const container = attachSizedContainer()
    const quickFilters: unknown[] = []
    const inspected: unknown[] = []
    const summaries: Array<{ cellCount: number }> = []
    const fks: ForeignKeyInfo[] = [{ column: 'dept_id', referencedTable: 'departments', referencedColumn: 'id' }]

    const grid = new VirtualDataGrid({
      container,
      data: makeRichBrowseData(40, true),
      batchMode: true,
      tableName: 'employees',
      dialect: 'sqlite',
      onInspectCell: (info) => inspected.push(info),
      onQuickFilter: (sql, mode) => quickFilters.push([sql, mode]),
      onNavigateForeignKey: () => {},
      onSelectionChange: (s) => summaries.push(s),
    })
    grid.setForeignKeys(fks)
    const scroller = patchGridScrollGeometry(container)

    try {
      // Selection APIs & Exports
      grid.selectSingleModelCell(1, 1)
      expect(grid.getSelectionSummary().cellCount).toBe(1)
      grid.selectAll()
      expect(grid.getSelectionSummary().cellCount).toBeGreaterThan(10)
      expect(grid.exportSelection('csv')).toContain('User_')
      expect(grid.exportSelection('json')).toContain('User_')
      expect(grid.exportSelection('sql-in')).toContain('(')
      expect(grid.exportSelection('sql-insert')).toContain('INSERT INTO')
      expect(grid.exportSelection('tsv-headers')).toContain('name')
      expect(grid.copySelection('tsv')).toBeTruthy()
      for (const fmt of ['csv', 'json', 'ndjson', 'sql-insert', 'tsv', 'markdown'] as const) {
        expect(grid.exportData(fmt)).toBeTruthy()
      }
      grid.clearSelection()

      // Tbody mousedown / Shift / Ctrl / Drag selection / Row-num selection / Click
      const td01 = container.querySelector('td[data-row-index="0"][data-col-index="1"]') as HTMLElement
      const td23 = container.querySelector('td[data-row-index="2"][data-col-index="3"]') as HTMLElement
      const tdRN1 = container.querySelector('td.datanoa-td-rownum[data-vis-row="1"]') as HTMLElement

      td01.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 10, clientY: 10, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 25, clientY: 35 }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 25, clientY: 450 })) // trigger drag autoscroll RAF
      dom.runRaf()
      window.dispatchEvent(new Event('blur')) // cancel drag via window blur
      td23.dispatchEvent(new MouseEvent('mousedown', { button: 0, shiftKey: true, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup'))
      td01.dispatchEvent(new MouseEvent('mousedown', { button: 0, ctrlKey: true, bubbles: true }))
      tdRN1.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup'))
      // Direct clicks without mousedown (`handleTbodyClick`)
      td01.click()
      td23.dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }))
      td01.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }))
      tdRN1.click()
      const directFkBadge = container.querySelector('.datanoa-fk-badge') as HTMLElement | null
      directFkBadge?.click()
      const directDeptTd = container.querySelector('td[data-row-index="0"][data-col-index="2"]') as HTMLElement | null
      directDeptTd?.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }))

      // Column select button
      const colSelBtn = container.querySelector('.datanoa-col-select-btn') as HTMLButtonElement
      colSelBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      colSelBtn.click()

      // Keyboard navigation
      for (const evInit of [
        { key: 'ArrowRight' },
        { key: 'ArrowDown' },
        { key: 'ArrowDown', shiftKey: true },
        { key: 'ArrowLeft' },
        { key: 'ArrowUp' },
        { key: 'c', ctrlKey: true },
        { key: 'Enter' },
        { key: 'a', ctrlKey: true },
        { key: 'Escape' },
      ]) {
        scroller.dispatchEvent(new KeyboardEvent('keydown', { ...evInit, bubbles: true }))
      }
      container.querySelector('.datanoa-inline-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

      const clickMenu = (re: RegExp) => {
        const btn = Array.from(document.querySelectorAll('.datanoa-context-item')).find((b) =>
          re.test(b.textContent || '')
        ) as HTMLElement | undefined
        btn?.click()
      }

      // Single-cell & multi-row contextmenu actions: Inspect, Copy, Paste, Set NULL, Filter, FK Jump, Clone, Mark Deleted, Bulk Fill
      td01.click()
      td01.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 40, bubbles: true }))
      expect(document.querySelector('.datanoa-context-menu')).toBeTruthy()
      clickMenu(/Value Inspector/i)
      expect(inspected.length).toBe(1)

      for (const re of [/^Copy Cell/i, /^Set NULL/i, /^Filter:/i, /^Clone/i, /^Mark /i]) {
        td01.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 40, bubbles: true }))
        clickMenu(re)
        await flushMicro()
      }
      // Multi-row contextmenu (`bulkCloneSelectedRows`, `bulkMarkRowsDeleted`)
      td01.click()
      td23.dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }))
      td01.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 40, bubbles: true }))
      clickMenu(/^Clone /i)
      td01.click()
      td23.dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }))
      td01.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 40, bubbles: true }))
      clickMenu(/^Mark /i)

      const fkTdCtx = container.querySelector('td[data-row-index="5"][data-col-index="2"]') as HTMLElement | null
      fkTdCtx?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 40, bubbles: true }))
      clickMenu(/^Go to /i)
      fkTdCtx?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 40, bubbles: true }))
      clickMenu(/^Paste \(Overwrite/i)
      await flushMicro()

      td01.click()
      td01.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 40, bubbles: true }))
      clickMenu(/Bulk Fill/i)
      const bulkPop = document.querySelector('.datanoa-bulk-fill-popover') as HTMLElement | null
      if (bulkPop) {
        const inp = bulkPop.querySelector('input.datanoa-search-input') as HTMLInputElement
        inp.value = 'BulkEdited'
        ;(bulkPop.querySelector('.datanoa-btn-primary') as HTMLButtonElement).click()
      }

      // Canvas context menu (+ Add Blank Row, Paste as New Row) & escape/mousedown dismissal
      scroller.dispatchEvent(new MouseEvent('contextmenu', { clientX: 100, clientY: 100, bubbles: true }))
      clickMenu(/Add Blank/i)
      scroller.dispatchEvent(new MouseEvent('contextmenu', { clientX: 100, clientY: 100, bubbles: true }))
      clickMenu(/Paste as New Row/i)
      await flushMicro()
      scroller.dispatchEvent(new MouseEvent('contextmenu', { clientX: 100, clientY: 100, bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      scroller.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))

      // Row-num contextmenu (Clone / Mark Row Deleted)
      tdRN1.dispatchEvent(new MouseEvent('contextmenu', { clientX: 15, clientY: 30, bubbles: true }))
      clickMenu(/Mark Row Deleted|Clone Row/i)
      window.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))

      // Transposed mode rendering, click, FK, and revert
      grid.setTransposed(true)
      expect(grid.getTransposed()).toBe(true)
      const transTd = container.querySelector('td[data-row-index="0"][data-col-index="1"]') as HTMLElement | null
      transTd?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      transTd?.click()
      transTd?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      container.querySelector('.datanoa-inline-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      grid.setTransposed(false)
    } finally {
      grid.destroy()
    }
  })

  it('covers batch staging, inline/direct cell edit, paste engine, runtime snapshot round-trip & PBT invariants', async () => {
    const container = attachSizedContainer()
    const notifications: string[] = []
    const stagedCounts: number[] = []

    // 1. Direct (immediate) edit mode: success, ok=false rollback, thrown error rollback
    let updateMode: 'ok' | 'reject' | 'throw' = 'ok'
    const directGrid = new VirtualDataGrid({
      container,
      data: makeRichBrowseData(12, true),
      batchMode: false,
      onNotify: (m) => notifications.push(m),
      onStageChange: (n) => stagedCounts.push(n),
      onUpdateCell: async ({ newValue }) => {
        if (updateMode === 'reject') return { ok: false, affectedRows: 0 }
        if (updateMode === 'throw') throw new Error('Network fail')
        return { ok: true, affectedRows: 1, updatedRecord: { id: 2, name: newValue, dept_id: 2, active: true, score: 1.5, meta: '["x"]' } }
      },
    })
    const scroller = patchGridScrollGeometry(container)

    try {
      const tdName = container.querySelector('td[data-row-index="1"][data-col-index="1"]') as HTMLElement
      tdName.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      let inp = tdName.querySelector('.datanoa-inline-input') as HTMLInputElement
      inp.value = 'Direct_Updated'
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushMicro()
      expect(directGrid.getModel()!.rows[1]).toMatchObject({ name: 'Direct_Updated' })

      updateMode = 'reject'
      const tdName2 = container.querySelector('td[data-row-index="2"][data-col-index="1"]') as HTMLElement
      tdName2.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      inp = tdName2.querySelector('.datanoa-inline-input') as HTMLInputElement
      inp.value = 'RollbackReject'
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
      await flushMicro()
      // Escape on tabbed active editor
      container.querySelector('.datanoa-inline-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

      updateMode = 'throw'
      const tdScore = container.querySelector('td[data-row-index="2"][data-col-index="4"]') as HTMLElement
      tdScore.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      inp = tdScore.querySelector('.datanoa-inline-input') as HTMLInputElement
      inp.value = '99.5'
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      inp.dispatchEvent(new Event('blur', { bubbles: true }))
      await flushMicro()

      // Keyboard Delete on NOT NULL column vs nullable column
      directGrid.selectSingleModelCell(1, 4) // score is NOT NULL
      scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
      expect(notifications.some((m) => m.includes('NOT NULL'))).toBe(true)

      directGrid.selectSingleModelCell(1, 1) // name is nullable
      updateMode = 'ok'
      scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
      await flushMicro()

      // Batch staging: addBlankRow, cloneSelectedRow, bulkCloneSelectedRows, markRowDeleted, bulkMarkRowsDeleted, stageImportedRows, paste
      directGrid.setBatchMode(true)
      const insIdx = directGrid.addBlankRow()
      expect(insIdx).not.toBeNull()
      expect(directGrid.cloneSelectedRow(1)).not.toBeNull()
      directGrid.selectSingleModelCell(2, 1)
      directGrid.bulkCloneSelectedRows()
      directGrid.markRowDeleted(3, true)
      directGrid.bulkMarkRowsDeleted()

      expect(directGrid.stageImportedRows([{ name: 'Imp_1', dept_id: 1, active: false, score: 88, meta: null }])).toBe(1)
      expect(directGrid.pasteAsNewRows('PastedName\t2\ttrue\t12\t{}')).toBe(1)

      // ClipboardEvent paste (single fill, multi-row overwrite + overflow, empty clipboard guard)
      directGrid.selectSingleModelCell(1, 1)
      const copiedHdrs = directGrid.copySelection('tsv-headers')
      directGrid.selectSingleModelCell(2, 1)
      expect(directGrid.pasteDelimitedText(copiedHdrs)).toBeGreaterThan(0)
      const dtSingle = new DataTransfer()
      dtSingle.setData('text/plain', 'ClipSingle')
      scroller.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dtSingle, bubbles: true }))
      expect(directGrid.pasteDelimitedText('Clip1\t2\nClip2\t3\nOverflow1\t1\nOverflow2\t2')).toBeGreaterThan(0)

      // Batch-mode inline edit (stageCellEdit) right on non-deleted row 6 + flushActiveEditorBeforeRebuild
      expect(directGrid.isBatchMode()).toBe(true)
      const tdBatch = container.querySelector('td[data-row-index="6"][data-col-index="1"]') as HTMLElement | null
      tdBatch?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      const bInp = tdBatch?.querySelector('.datanoa-inline-input') as HTMLInputElement | null
      if (bInp) {
        bInp.value = 'BatchEdited'
        bInp.dispatchEvent(new Event('input', { bubbles: true }))
        bInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      }
      // Untouched null cell blur
      const tdNull = container.querySelector('td[data-row-index="0"][data-col-index="1"]') as HTMLElement | null
      tdNull?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      const nInp = tdNull?.querySelector('.datanoa-inline-input') as HTMLInputElement | null
      nInp?.dispatchEvent(new Event('blur', { bubbles: true }))

      // Direct cellUpdated reconciliation & immediate Set NULL via cell context menu
      directGrid.handleCellUpdated({ connectionId: 'other', table: 't', primaryKeys: { id: 1 }, column: 'name' })
      directGrid.handleCellUpdated({ table: 'table_name', primaryKeys: { id: 2 }, column: 'name' })

      // Large virtual grid for scroll-out-of-view flushActiveEditorBeforeRebuild + direct Set NULL without onUpdateCell
      const noCbBox = attachSizedContainer()
      const noCbGrid = new VirtualDataGrid({ container: noCbBox, data: makeRichBrowseData(120, true), batchMode: false })
      const noCbScroller = patchGridScrollGeometry(noCbBox)
      try {
        const tdNoCb = noCbBox.querySelector('td[data-row-index="1"][data-col-index="1"]') as HTMLElement | null
        tdNoCb?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        const ncInp = tdNoCb?.querySelector('.datanoa-inline-input') as HTMLInputElement | null
        if (ncInp) {
          ncInp.value = 'LocalDirect'
          ncInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        }
        tdNoCb?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
        const bulkNull = Array.from(document.querySelectorAll('.datanoa-context-item')).find((b) => /^Set NULL/i.test(b.textContent || '')) as HTMLElement | undefined
        bulkNull?.click()
        await flushMicro()

        // Start inline edit at row 2, type, then scroll far down so flushActiveEditorBeforeRebuild commits/flushes before pool recycle!
        const tdFlush = noCbBox.querySelector('td[data-row-index="2"][data-col-index="1"]') as HTMLElement | null
        tdFlush?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        const fInp = tdFlush?.querySelector('.datanoa-inline-input') as HTMLInputElement | null
        if (fInp) {
          fInp.value = 'FlushedByScroll'
          fInp.dispatchEvent(new Event('input', { bubbles: true }))
        }
        noCbScroller.scrollTop = 2400
        noCbScroller.dispatchEvent(new Event('scroll'))
        dom.runRaf()
      } finally {
        noCbGrid.destroy()
      }

      // Ctrl+Shift+V triggerPasteAction fallback & interactionLocked
      const origRead = navigator.clipboard.readText
      try {
        navigator.clipboard.readText = async () => 'NewClipRow\t1'
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, shiftKey: true, bubbles: true }))
        await flushMicro()
        navigator.clipboard.readText = async () => ''
        scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, shiftKey: true, bubbles: true }))
        await flushMicro()
      } finally {
        navigator.clipboard.readText = origRead
      }

      expect(directGrid.getStagedCount()).toBeGreaterThan(0)
      const payload = directGrid.getChangesPayload()
      expect(payload.inserts.length + payload.updates.length + payload.deletes.length).toBeGreaterThan(0)

      // Runtime snapshot round-trip + revertAllChanges + lock
      const snap = directGrid.exportRuntimeState()
      directGrid.revertAllChanges()
      expect(directGrid.getStagedCount()).toBe(0)
      directGrid.restoreRuntimeState(snap)
      expect(directGrid.getStagedCount()).toBeGreaterThan(0)
      directGrid.setInteractionLocked(true)
      expect(directGrid.addBlankRow()).toBeNull()
      directGrid.setInteractionLocked(false)

      // Property-based invariant check on filter / column visibility / transposed / scroll state round-trip
      fc.assert(
        fc.property(
          fc.record({
            filter: fc.constantFrom('', 'User_1', 'Clip', 'zzz_nomatch'),
            hideName: fc.boolean(),
            pinId: fc.boolean(),
            transposed: fc.boolean(),
          }),
          (cfg) => {
            directGrid.setClientFilter(cfg.filter)
            directGrid.setColumnVisibility('name', !cfg.hideName)
            directGrid.setColumnConfig({ hidden: cfg.hideName ? ['name'] : [], pinned: cfg.pinId ? ['id'] : [] })
            directGrid.setTransposed(cfg.transposed)
            const rtSnap = directGrid.exportRuntimeState()
            expect(rtSnap.clientFilter).toBe(cfg.filter.trim().toLowerCase())
            expect(rtSnap.hiddenColumns.includes('name')).toBe(cfg.hideName)
          }
        ),
        { numRuns: 15 }
      )
    } finally {
      directGrid.destroy()
    }
  })
})
