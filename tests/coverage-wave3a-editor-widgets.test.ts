import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'
import { installDomHarness, type DomHarness } from './helpers/dom-harness.js'
import type { QueryHistoryEntry, QueryResult, QueryResultSet, TransactionState } from '../src/protocol.js'
import {
  compactSqlPreview,
  getEffectiveResultSets,
  getDefaultResultSetIndex,
  buildResultSetQueryResult,
  buildBannerForResultSet,
  buildInitialResultTabStates,
  buildCombinedExplainResult,
  shouldShowQueryBannerForMode,
} from '../src/editor/result-set-controller.js'
import { mountStudioColumnsPopover } from '../src/editor/studio-columns-popover.js'
import { QueryHistoryDrawerController } from '../src/editor/query-history-drawer.js'
import { ConsoleTabsManager } from '../src/editor/console-tabs.js'
import { TransactionToolbarController } from '../src/editor/transaction-toolbar.js'
import { ValueInspectorController } from '../src/editor/value-inspector.js'
import type { SelectedCellInfo, VirtualDataGrid } from '../src/editor/grid.js'

let dom: DomHarness

beforeEach(() => {
  dom = installDomHarness()
})

afterEach(() => {
  vi.useRealTimers()
  dom.teardown()
})

describe('Wave 3A Step 4B: Studio Controllers & Widgets (6 Modules)', () => {
  it('covers src/editor/result-set-controller.ts + PBT invariants', () => {
    expect(compactSqlPreview('  SELECT  \n  *   FROM   users  ')).toBe('SELECT * FROM users')
    const longSql = `SELECT ${'a'.repeat(120)} FROM tbl`
    expect(compactSqlPreview(longSql).length).toBe(96)
    expect(compactSqlPreview(longSql).endsWith('...')).toBe(true)

    fc.assert(
      fc.property(fc.string({ maxLength: 220 }), (raw) => {
        const preview = compactSqlPreview(raw)
        expect(preview.length).toBeLessThanOrEqual(96)
        expect(preview.includes('\n')).toBe(false)
      }),
      { numRuns: 40 }
    )

    // Legacy single-result normalization (with & without sourceTable / rows)
    const legacyNoRows: QueryResult = {
      columns: [],
      rows: undefined as unknown as unknown[][],
      executionTimeMs: 4,
      affectedRows: 3,
      truncated: false,
      isSelect: false,
    }
    const sets1 = getEffectiveResultSets(legacyNoRows, 'UPDATE t SET x=1;')
    expect(sets1).toHaveLength(1)
    expect(sets1[0].sqlPreview).toBe('UPDATE t SET x=1;')
    expect(sets1[0].rowCount).toBe(0)

    const legacyWithSource: QueryResult = {
      columns: [{ name: 'id', type: 'int', nullable: false }],
      rows: [[1]],
      rowCount: 1,
      executionTimeMs: 9,
      truncated: true,
      isSelect: true,
      sourceTable: 'users',
    }
    const sets2 = getEffectiveResultSets(legacyWithSource)
    expect(sets2[0].sourceTable).toBe('users')
    expect(sets2[0].sqlPreview).toBeUndefined()

    // Multi-result sets & getDefaultResultSetIndex
    const multiSets: QueryResultSet[] = [
      {
        index: 0,
        sqlPreview: 'CREATE TEMP TABLE x',
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: 0,
        truncated: false,
        isSelect: false,
      },
      {
        index: 1,
        sql: 'SELECT * FROM x',
        columns: [{ name: 'id', type: 'int', nullable: false }],
        rows: [[1], [2]],
        rowCount: 2,
        executionTimeMs: 12,
        truncated: true,
        isSelect: true,
        sourceTable: 'x',
      },
      {
        index: 2,
        sqlPreview: 'BAD SQL',
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        isSelect: false,
        isError: true,
      },
    ]
    const multiRes: QueryResult = {
      columns: [],
      rows: [],
      executionTimeMs: 25,
      truncated: false,
      isSelect: false,
      resultSets: multiSets,
    }
    expect(getEffectiveResultSets(multiRes)).toBe(multiSets)
    expect(getDefaultResultSetIndex({ columns: [], rows: [], executionTimeMs: 0, truncated: false, isSelect: false })).toBe(0)
    expect(getDefaultResultSetIndex(multiRes)).toBe(1)

    // buildResultSetQueryResult valid & out-of-bounds
    expect(buildResultSetQueryResult(multiRes, 99)).toBe(multiRes)
    const projected = buildResultSetQueryResult(multiRes, 1)
    expect(projected.executionTimeMs).toBe(12)
    expect(projected.sourceTable).toBe('x')
    const projected0 = buildResultSetQueryResult(multiRes, 0)
    expect(projected0.executionTimeMs).toBe(25)

    // buildBannerForResultSet across error, explain, select, dml, singular/plural
    const errQuery = buildBannerForResultSet(multiSets[2], '', 7, 'query')
    expect(errQuery.title).toBe('SQL Execution Error')
    expect(errQuery.detail).toBe('Query failed')
    const errExplain = buildBannerForResultSet(
      { ...multiSets[2], errorMessage: 'bad explain' },
      '',
      7,
      'explain'
    )
    expect(errExplain.title).toBe('EXPLAIN Error')
    expect(errExplain.detail).toBe('bad explain')

    const expSingle = buildBannerForResultSet(
      { index: 0, columns: [], rows: [['scan']], rowCount: 1, truncated: false, isSelect: true },
      'SELECT 1',
      5,
      'explain'
    )
    expect(expSingle.title).toContain('1 plan step in 5ms')
    const expPlural = buildBannerForResultSet(
      { index: 0, columns: [], rows: [['a'], ['b']], executionTimeMs: 11, truncated: false, isSelect: true },
      '',
      5,
      'explain'
    )
    expect(expPlural.title).toContain('2 plan steps in 11ms')

    const selOne = buildBannerForResultSet(
      { index: 0, columns: [], rows: [[1]], truncated: false, isSelect: true },
      'SELECT 1',
      3,
      'query'
    )
    expect(selOne.title).toContain('1 row returned in 3ms')
    const selTrunc = buildBannerForResultSet(multiSets[1], '', 5, 'query')
    expect(selTrunc.title).toContain('2 rows returned in 12ms (truncated)')

    const dmlOne = buildBannerForResultSet(
      { index: 0, columns: [], rows: [], affectedRows: 1, truncated: false, isSelect: false },
      'DELETE FROM t WHERE id=1',
      2,
      'query'
    )
    expect(dmlOne.title).toContain('1 row affected')
    const dmlZero = buildBannerForResultSet(
      { index: 0, columns: [], rows: [], truncated: false, isSelect: false },
      '',
      2,
      'query'
    )
    expect(dmlZero.title).toContain('0 rows affected')

    // buildInitialResultTabStates for single & multi sets in both modes
    const singleStates = buildInitialResultTabStates(legacyWithSource, [], 'SELECT * FROM users', 4, 'query')
    expect(singleStates[0].gridSubbarTitle).toBe('SQL Result · 1 cols')
    expect(singleStates[0].gridPageInfo).toBe('1 row (truncated)')

    const singleErrRes: QueryResult = {
      columns: [],
      rows: [],
      executionTimeMs: 1,
      truncated: false,
      isSelect: false,
      resultSets: [{ index: 0, columns: [], rows: [], truncated: false, isSelect: false, isError: true }],
    }
    expect(buildInitialResultTabStates(singleErrRes, [], 'BAD', 1, 'explain')[0].gridSubbarTitle).toBe('EXPLAIN Error')
    expect(buildInitialResultTabStates(singleErrRes, [], 'BAD', 1, 'query')[0].gridSubbarTitle).toBe('SQL Error')
    expect(buildInitialResultTabStates(legacyNoRows, [], 'UPDATE t', 2, 'query')[0].gridSubbarTitle).toBe('Executed · 3 affected')
    expect(
      buildInitialResultTabStates(
        { columns: [], rows: [['p']], rowCount: 1, executionTimeMs: 2, truncated: false, isSelect: true },
        [],
        'SELECT 1',
        2,
        'explain'
      )[0].gridSubbarTitle
    ).toBe('Execution Plan · 1 steps')
    expect(
      buildInitialResultTabStates(
        { columns: [{ name: 'a', type: 'text', nullable: true }], rows: [], rowCount: 0, executionTimeMs: 2, truncated: false, isSelect: true },
        [],
        'SELECT a FROM t WHERE 1=0',
        2,
        'query'
      )[0].emptyMessage
    ).toBe('Query returned no rows.')

    const multiStates = buildInitialResultTabStates(multiRes, ['s0', 's1', 's2'], 's0;s1;s2', 10, 'query')
    expect(multiStates[0].statementSql).toBe('s0')
    expect(multiStates[0].gridSubbarTitle).toBe('Result 1 · 0 affected')
    expect(multiStates[1].gridSubbarTitle).toBe('Result 2 · 1 cols')
    expect(multiStates[2].gridSubbarTitle).toBe('Result 3 · Error')
    const multiExpStates = buildInitialResultTabStates(multiRes, ['a', 'b'], 'overall_sql', 10, 'explain')
    expect(multiExpStates[0].statementSql).toBe('CREATE TEMP TABLE x')
    expect(multiExpStates[1].gridSubbarTitle).toContain('Plan (2 steps)')

    // buildCombinedExplainResult & shouldShowQueryBannerForMode
    expect(buildCombinedExplainResult([], null, 8).rowCount).toBe(0)
    const combinedMulti = buildCombinedExplainResult(
      multiSets.slice(0, 2),
      { columns: [{ name: 'PLAN', type: 'text', nullable: false }], rows: [['Seq Scan']], rowCount: 1, executionTimeMs: 5, truncated: false, isSelect: true },
      18
    )
    expect(combinedMulti.resultSets).toHaveLength(2)

    expect(shouldShowQueryBannerForMode('split', true, null)).toBe(false)
    expect(shouldShowQueryBannerForMode('split', true, { kind: 'success', title: 't', detail: '', dismissed: true })).toBe(false)
    expect(shouldShowQueryBannerForMode('inspector', true, expSingle)).toBe(false)
    expect(shouldShowQueryBannerForMode('grid', false, expSingle)).toBe(false)
    expect(shouldShowQueryBannerForMode('grid', true, expSingle)).toBe(true)
    expect(shouldShowQueryBannerForMode('grid', false, errQuery)).toBe(true)
  })

  it('covers src/editor/studio-columns-popover.ts filter, toggle, pin, positioning & outside close', () => {
    let cols = ['id', 'email', 'created_at']
    let hidden = ['email']
    let pinned = ['id']
    const setColumnVisibility = vi.fn((col: string, visible: boolean) => {
      hidden = visible ? hidden.filter((c) => c !== col) : [...new Set([...hidden, col])]
    })
    const togglePinColumn = vi.fn((col: string) => {
      pinned = pinned.includes(col) ? pinned.filter((c) => c !== col) : [...pinned, col]
    })
    const showAllColumns = vi.fn(() => {
      hidden = []
    })
    const fakeGrid = {
      getColumnConfig: () => ({ allColumns: cols, hidden, pinned }),
      setColumnVisibility,
      togglePinColumn,
      showAllColumns,
    } as unknown as VirtualDataGrid

    // Empty columns branch
    cols = []
    const anchor = dom.document.createElement('button') as unknown as HTMLButtonElement
    ;(anchor as unknown as { _rect: Record<string, number> })._rect = {
      left: 50,
      top: 40,
      right: 130,
      bottom: 70,
      width: 80,
      height: 30,
    }
    dom.body.appendChild(anchor as unknown as Node)
    const onClose1 = vi.fn()
    const m1 = mountStudioColumnsPopover(fakeGrid, anchor, onClose1)
    expect(m1.popoverEl.textContent).toContain('No columns loaded')
    dom.click(anchor as unknown as HTMLElement)
    // Inside mousedown on anchor does NOT close
    anchor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(onClose1).not.toHaveBeenCalled()
    // Outside mousedown on body DOES close
    dom.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(onClose1).toHaveBeenCalledTimes(1)
    m1.outsideCleanup?.()
    m1.popoverEl.remove()

    // Populated columns + upward positioning near bottom-right edge
    cols = ['id', 'email', 'created_at']
    ;(anchor as unknown as { _rect: Record<string, number> })._rect = {
      left: 1200,
      top: 740,
      right: 1270,
      bottom: 795,
      width: 70,
      height: 55,
    }
    const onClose2 = vi.fn()
    const m2 = mountStudioColumnsPopover(fakeGrid, anchor, onClose2)
    expect(Number.parseFloat(m2.popoverEl.style.top)).toBeLessThan(740)

    const searchInp = m2.popoverEl.querySelector('input[type="search"]')!
    dom.setInput(searchInp, 'zz-none', 'input')
    expect(m2.popoverEl.textContent).toContain('No matching columns')
    dom.setInput(searchInp, 'em', 'input')
    expect(m2.popoverEl.querySelectorAll('.datanoa-cols-popover-row')).toHaveLength(1)

    dom.setInput(searchInp, '', 'input')
    const cb = m2.popoverEl.querySelectorAll('input[type="checkbox"]')[1]
    dom.click(cb)
    expect(setColumnVisibility).toHaveBeenCalledWith('email', true)

    const firstPinBtn = m2.popoverEl.querySelector('.datanoa-cols-popover-row button')!
    expect(firstPinBtn.textContent).toBe('Unpin')
    dom.click(firstPinBtn)
    expect(togglePinColumn).toHaveBeenCalledWith('id')
    expect(m2.popoverEl.querySelector('.datanoa-cols-popover-row button')?.textContent).toBe('Pin')

    const showAllBtn = m2.popoverEl.querySelector('.datanoa-cols-popover-head button')!
    dom.click(showAllBtn)
    expect(showAllColumns).toHaveBeenCalledTimes(1)

    // Mousedown inside popover keeps open
    m2.popoverEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(onClose2).not.toHaveBeenCalled()
    m2.outsideCleanup?.()
  })

  it('covers src/editor/query-history-drawer.ts async load, stale seq cancel, search & actions', async () => {
    let drawerEl: HTMLDivElement | null = dom.document.createElement('div') as unknown as HTMLDivElement
    let listEl: HTMLDivElement | null = dom.document.createElement('div') as unknown as HTMLDivElement
    const toggleBtn = dom.document.createElement('button') as unknown as HTMLButtonElement
    const setSqlText = vi.fn()
    const insertSqlText = vi.fn()
    const updateStatus = vi.fn()

    let pendingResolve: ((v: { entries: QueryHistoryEntry[] }) => void) | null = null
    let pendingReject: ((err: unknown) => void) | null = null
    let nextMode: 'ok' | 'empty' | 'hang-ok' | 'hang-err' | 'throw-str' = 'ok'

    const entries: QueryHistoryEntry[] = [
      {
        id: 'h1',
        connectionId: 'c1',
        connectionName: 'ProdPG',
        sql: 'SELECT  id,\n name FROM orders;',
        timestamp: Date.now() - 5000,
        durationMs: 14,
        rowCount: 2,
        isError: false,
      },
      {
        id: 'h2',
        connectionId: 'c2',
        connectionName: '',
        sql: 'SELECT bad_col FROM broken;',
        timestamp: 0,
        durationMs: 3,
        rowCount: 0,
        isError: true,
      },
    ]

    const ctrl = new QueryHistoryDrawerController({
      getDrawerEl: () => drawerEl,
      getListEl: () => listEl,
      getToggleBtn: () => toggleBtn,
      setSqlText,
      insertSqlText,
      updateStatus,
      requestPlugin: async () => {
        if (nextMode === 'ok') return { entries } as never
        if (nextMode === 'empty') return undefined as never
        if (nextMode === 'throw-str') throw 'offline'
        if (nextMode === 'hang-ok') {
          return new Promise((res) => {
            pendingResolve = res as (v: { entries: QueryHistoryEntry[] }) => void
          }) as never
        }
        return new Promise((_res, rej) => {
          pendingReject = rej
        }) as never
      },
    })

    expect(ctrl.isOpen()).toBe(false)
    await ctrl.toggle()
    expect(ctrl.isOpen()).toBe(true)
    expect(drawerEl.style.display).toBe('flex')
    expect(listEl.querySelectorAll('.datanoa-history-row')).toHaveLength(2)

    // Filter by SQL, connectionName & no match
    ctrl.setSearchQuery('orders')
    expect(listEl.querySelectorAll('.datanoa-history-row')).toHaveLength(1)
    ctrl.setSearchQuery('prodpg')
    expect(listEl.querySelectorAll('.datanoa-history-row')).toHaveLength(1)
    ctrl.setSearchQuery('zzz-none')
    expect(listEl.textContent).toContain('No query history matches "zzz-none".')
    ctrl.setSearchQuery('')
    expect(listEl.querySelectorAll('.datanoa-history-row')).toHaveLength(2)

    // Row actions: SQL click, Insert, Copy
    dom.click(listEl.querySelector('.datanoa-history-sql')!)
    expect(setSqlText).toHaveBeenCalledWith(entries[0].sql)
    dom.click(listEl.querySelectorAll('.datanoa-history-actions button')[0])
    expect(insertSqlText).toHaveBeenCalledWith(entries[0].sql)
    dom.click(listEl.querySelectorAll('.datanoa-history-actions button')[1])
    expect(dom.clipboardWrites).toContain(entries[0].sql)
    expect(updateStatus).toHaveBeenCalledWith('Copied history SQL to clipboard')

    // Error entry metadata omits timestamp when 0
    expect(listEl.querySelectorAll('.datanoa-history-meta')[1].textContent).toBe(' · ERROR')

    // Toggle closed
    await ctrl.toggle()
    expect(ctrl.isOpen()).toBe(false)
    expect(drawerEl.style.display).toBe('none')

    // Empty entries branch & clearCached
    nextMode = 'empty'
    await ctrl.load()
    expect(listEl.textContent).toContain('No executed queries in history yet.')
    ctrl.clearCached()

    // Error throw-string branch
    nextMode = 'throw-str'
    await ctrl.load()
    expect(listEl.textContent).toContain('Failed to load query history: offline')

    // Error instanceof Error branch
    nextMode = 'hang-err'
    const errPromise = ctrl.load()
    pendingReject!(new Error('timeout'))
    await errPromise
    expect(listEl.textContent).toContain('Failed to load query history: timeout')

    // Stale seq discards resolved and rejected results
    nextMode = 'hang-ok'
    const p1 = ctrl.load()
    ctrl.bumpSeq()
    pendingResolve!({ entries })
    await p1
    nextMode = 'hang-err'
    const p2 = ctrl.load()
    ctrl.bumpSeq()
    pendingReject!(new Error('late error'))
    await p2

    // Null drawerEl / listEl guards + destroy
    ctrl.destroy()
    drawerEl = null
    listEl = null
    ctrl.render()
    await ctrl.load()
    await ctrl.toggle()
    ctrl.close()
  })

  it('covers src/editor/console-tabs.ts lifecycle, persistence & PBT invariants', () => {
    const defMgr = new ConsoleTabsManager()
    expect(defMgr.getTabs()).toHaveLength(1)
    expect(defMgr.getActiveTab().title).toBe('Console 1')

    const strMgr = new ConsoleTabsManager('SELECT 1;')
    expect(strMgr.getActiveTab().sql).toBe('SELECT 1;')
    const freshTabState = buildInitialResultTabStates(
      { columns: [], rows: [], executionTimeMs: 1, truncated: false, isSelect: true },
      ['SELECT 1;'],
      'SELECT 1;',
      1,
      'query'
    )[0]
    strMgr.setResultTabState(0, freshTabState)
    expect(strMgr.getResultTabState(0)).toBe(freshTabState)

    // Persisted empty tabs falls back cleanly; >20 tabs caps at 20 and truncates SQL > 50k
    expect(new ConsoleTabsManager({ activeTabId: 'x', tabs: [] }).getTabs()).toHaveLength(1)
    const bigTabs = Array.from({ length: 24 }, (_, i) => ({
      id: i === 0 ? '' : `t${i}`,
      title: i === 1 ? '   ' : `Tab ${i}`,
      sql: i === 0 ? 'x'.repeat(50_020) : (123 as unknown as string),
    }))
    const capped = new ConsoleTabsManager({ activeTabId: 'missing', tabs: bigTabs })
    expect(capped.getTabs()).toHaveLength(20)
    expect(capped.getTabs()[0].sql).toHaveLength(50_000)
    expect(capped.getTabs()[1].title).toBe('Console 2')
    expect(capped.getActiveTabId()).toBe(capped.getTabs()[0].id)

    // Add, rename, switch, close
    const t2 = defMgr.addTab('SELECT 2;')
    expect(t2.title).toBe('Console 2')
    defMgr.renameTab(t2.id, 'Console 3')
    const t3 = defMgr.addTab('SELECT 3;', '  ')
    expect(t3.title).toBe('Console 2') // reuses gap
    expect(defMgr.switchTab('nope')).toBe(false)
    expect(defMgr.renameTab('nope', 'X')).toBe(false)
    expect(defMgr.renameTab(t3.id, '   ')).toBe(false)

    // Result caching branches
    const resA: QueryResult = { columns: [], rows: [], executionTimeMs: 1, truncated: false, isSelect: true }
    defMgr.updateActiveSql('SELECT 99;', 5)
    expect(defMgr.getActiveTab().cursorOffset).toBe(5)
    defMgr.updateActiveSql('SELECT 100;')
    defMgr.setActiveResult(resA, 0, 'SELECT 100;', 'conn-1', 'query')
    const dummyTabState = buildInitialResultTabStates(resA, ['SELECT 100;'], 'SELECT 100;', 1, 'query')[0]
    defMgr.setResultTabState(0, dummyTabState)
    expect(defMgr.getResultTabState(0)).toBe(dummyTabState)
    // Same result preserves resultStates; different/null clears
    defMgr.setActiveResult(resA, -3)
    expect(defMgr.getActiveTab().activeResultSetIndex).toBe(0)
    expect(defMgr.getResultTabState(0)).toBe(dummyTabState)
    defMgr.setActiveResult(null)
    expect(defMgr.getActiveTab().lastResultMode).toBeUndefined()
    expect(defMgr.getResultTabState(0)).toBeUndefined()

    expect(defMgr.setResultForTab('missing', resA)).toBe(false)
    expect(defMgr.setResultForTab(t2.id, resA, 1, 'SELECT x', 'c2', { 0: dummyTabState }, 'explain')).toBe(true)
    expect(defMgr.setResultForTab(t2.id, null)).toBe(true)
    defMgr.setResultTabState(0, dummyTabState, 'missing')
    defMgr.setResultStatesForTab('missing', { 0: dummyTabState })
    defMgr.setResultStatesForTab(t2.id, { 0: dummyTabState })
    expect(defMgr.getResultTabState(0, t2.id)).toBe(dummyTabState)
    defMgr.setActiveResultSetIndex(4)
    expect(defMgr.getActiveTab().activeResultSetIndex).toBe(4)

    // Closing non-active & active tabs down to last-tab reset
    expect(defMgr.closeTab('missing')).toBe(false)
    expect(defMgr.closeTab(t2.id)).toBe(true)
    const onlyLeft = defMgr.getTabs()[0].id
    expect(defMgr.closeTab(defMgr.getActiveTabId())).toBe(true)
    expect(defMgr.getActiveTabId()).toBe(onlyLeft)
    expect(defMgr.closeTab(onlyLeft)).toBe(true)
    expect(defMgr.getTabs()).toHaveLength(1)
    expect(defMgr.getActiveTab().title).toBe('Console 1')

    // Corrupted activeTabId fallback safety guard + round-trip
    ;(defMgr as unknown as { activeTabId: string }).activeTabId = 'gone'
    expect(defMgr.getActiveTab().id).toBe(onlyLeft)
    const persisted = defMgr.toPersistedState()
    expect(new ConsoleTabsManager(persisted).getTabs()).toHaveLength(1)

    // PBT: any sequence of add/switch/rename/close preserves >=1 tab and valid activeTabId
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ op: fc.constant('add' as const), sql: fc.string({ maxLength: 30 }) }),
            fc.record({ op: fc.constant('switch' as const), idx: fc.nat({ max: 10 }) }),
            fc.record({ op: fc.constant('close' as const), idx: fc.nat({ max: 10 }) }),
            fc.record({ op: fc.constant('rename' as const), idx: fc.nat({ max: 10 }), title: fc.string({ maxLength: 20 }) })
          ),
          { maxLength: 30 }
        ),
        (ops) => {
          const mgr = new ConsoleTabsManager()
          for (const step of ops) {
            const tabs = mgr.getTabs()
            if (step.op === 'add') mgr.addTab(step.sql)
            else if (step.op === 'switch') mgr.switchTab(tabs[step.idx % tabs.length].id)
            else if (step.op === 'close') mgr.closeTab(tabs[step.idx % tabs.length].id)
            else mgr.renameTab(tabs[step.idx % tabs.length].id, step.title)
            const after = mgr.getTabs()
            expect(after.length).toBeGreaterThanOrEqual(1)
            expect(after.some((t) => t.id === mgr.getActiveTab().id)).toBe(true)
          }
          expect(mgr.toPersistedState().tabs.length).toBeLessThanOrEqual(20)
        }
      ),
      { numRuns: 30 }
    )
  })

  it('covers src/editor/transaction-toolbar.ts full lifecycle, races, errors & unload', async () => {
    let connId: string | null = null
    let readOnly = false
    let queryRunning = false
    let showingSql = false
    let activeTable: string | null = 'orders'
    let currentPage = 2
    const reloadTableData = vi.fn()
    const showErrorBanner = vi.fn()
    const updateStatus = vi.fn()

    const rpcHandlers = new Map<string, (p: Record<string, unknown>) => Promise<TransactionState>>()
    const requestPlugin = vi.fn(async (method: string, payload: Record<string, unknown> = {}) => {
      const handler = rpcHandlers.get(method)
      if (!handler) {
        return { active: false, autoCommit: true, statementCount: 0, supported: true } as TransactionState
      }
      return handler(payload)
    })

    const ctrl = new TransactionToolbarController({
      getActiveConnectionId: () => connId,
      getActiveConnection: () => (connId ? ({ id: connId, name: 'DB', driver: 'postgres' } as never) : undefined),
      isReadOnly: () => readOnly,
      isQueryRunning: () => queryRunning,
      isShowingSqlResult: () => showingSql,
      getActiveTable: () => activeTable,
      getCurrentPage: () => currentPage,
      requestPlugin: requestPlugin as never,
      reloadTableData,
      showErrorBanner,
      updateStatus,
    })

    // Unmounted updateToolbar guard + refreshState with no connId
    ctrl.updateToolbar()
    await ctrl.refreshState()

    const bar = dom.document.createElement('div')
    dom.body.appendChild(bar)
    ctrl.mount(bar)

    // Locked reasons: No active conn -> Read-Only -> Unsupported -> Query running
    ctrl.updateToolbar()
    expect(bar.querySelector('.datanoa-tx-toggle-btn')?.getAttribute('title')).toContain('No active connection')

    connId = 'c1'
    readOnly = true
    ctrl.updateToolbar()
    expect(bar.querySelector('.datanoa-tx-toggle-btn')?.getAttribute('title')).toContain('Read-Only connection')

    readOnly = false
    await ctrl.refreshState('other') // mismatched connId ignored
    ctrl.updateToolbar()
    expect(bar.querySelector('.datanoa-tx-toggle-btn')?.getAttribute('title')).toContain('not supported')

    // Fetch status + toggle drawer + active/manual states
    rpcHandlers.set('tx.status', async () => ({
      active: false,
      autoCommit: true,
      statementCount: 0,
      supported: true,
      txToken: 10,
    }))
    await ctrl.refreshState()
    expect(ctrl.getState().supported).toBe(true)
    dom.click(bar.querySelector('.datanoa-tx-toggle-btn')!)
    expect(bar.querySelector('.datanoa-tx-group')?.classList.contains('is-expanded')).toBe(true)

    queryRunning = true
    ctrl.updateToolbar()
    expect(bar.querySelector('.datanoa-tx-toggle-btn')?.getAttribute('title')).toContain('Query running')
    queryRunning = false

    // Status error fallback branch
    rpcHandlers.set('tx.status', async () => {
      throw new Error('tx rpc fail')
    })
    await ctrl.refreshState()
    expect(ctrl.getState().reason).toBe('Transaction status unavailable')

    rpcHandlers.set('tx.status', async () => ({
      active: false,
      autoCommit: true,
      statementCount: 0,
      supported: true,
    }))
    await ctrl.refreshState()

    // toggleAutoCommit success (OFF then ON) + error
    rpcHandlers.set('tx.setAutoCommit', async ({ enabled }) => ({
      active: false,
      autoCommit: Boolean(enabled),
      statementCount: 0,
      supported: true,
    }))
    dom.click(bar.querySelector('.datanoa-tx-autocommit-btn')!)
    await dom.flushMicrotasks()
    expect(updateStatus).toHaveBeenCalledWith('Manual transaction mode enabled')
    expect(ctrl.hasActiveOrManualTx()).toBe(true)

    await ctrl.toggleAutoCommit()
    expect(updateStatus).toHaveBeenCalledWith('Auto-commit enabled')

    rpcHandlers.set('tx.setAutoCommit', async () => {
      throw 'setac-err'
    })
    await ctrl.toggleAutoCommit()
    expect(showErrorBanner).toHaveBeenCalledWith('Transaction Error', 'setac-err')

    // begin -> commit (with reloadTableData & stmt badge) & begin -> rollback
    rpcHandlers.set('tx.begin', async () => ({
      active: true,
      autoCommit: false,
      statementCount: 2,
      supported: true,
      txToken: 44,
    }))
    dom.click(bar.querySelector('.datanoa-tx-begin-btn')!)
    await dom.flushMicrotasks()
    expect(ctrl.getState().active).toBe(true)
    expect(bar.querySelector('.datanoa-tx-badge')?.textContent).toContain('2 stmt(s)')
    expect(ctrl.isBusy()).toBe(false)

    // StatementCount=0 badge check
    rpcHandlers.set('tx.status', async () => ({
      active: true,
      autoCommit: false,
      statementCount: 0,
      supported: true,
      txToken: 45,
    }))
    await ctrl.refreshState()
    expect(bar.querySelector('.datanoa-tx-badge')?.textContent).toBe('TX open')

    rpcHandlers.set('tx.commit', async () => ({
      active: false,
      autoCommit: true,
      statementCount: 0,
      supported: true,
    }))
    currentPage = 0
    dom.click(bar.querySelector('.datanoa-tx-commit-btn')!)
    await dom.flushMicrotasks()
    expect(reloadTableData).toHaveBeenCalledWith('c1', 'orders', 1)

    // begin error + commit/rollback error
    rpcHandlers.set('tx.begin', async () => {
      throw new Error('begin err')
    })
    await ctrl.begin()
    expect(showErrorBanner).toHaveBeenCalledWith('Transaction Error', 'begin err')

    rpcHandlers.set('tx.begin', async () => ({
      active: true,
      autoCommit: false,
      statementCount: 1,
      supported: true,
      txToken: 77,
    }))
    await ctrl.begin()

    rpcHandlers.set('tx.commit', async () => {
      throw new Error('commit fail')
    })
    await ctrl.commit()
    expect(showErrorBanner).toHaveBeenCalledWith('Commit Failed', 'commit fail')

    // Restore active state, test rollback success + error
    await ctrl.begin()
    rpcHandlers.set('tx.rollback', async () => {
      throw 'rb fail'
    })
    await ctrl.rollback()
    expect(showErrorBanner).toHaveBeenCalledWith('Rollback Failed', 'rb fail')

    await ctrl.begin()
    rpcHandlers.set('tx.rollback', async () => ({
      active: false,
      autoCommit: true,
      statementCount: 0,
      supported: true,
    }))
    showingSql = false
    dom.click(bar.querySelector('.datanoa-tx-rollback-btn')!)
    await dom.flushMicrotasks()
    expect(updateStatus).toHaveBeenCalledWith('Transaction rolled back')

    // Connection switch while inFlightBegin is pending -> triggers rollbackOnSettle + pendingConnectionCleanups
    let resolveBegin!: (v: TransactionState) => void
    rpcHandlers.set(
      'tx.begin',
      async () =>
        new Promise((res) => {
          resolveBegin = res
        })
    )
    const switchedBegin = ctrl.begin()
    // Concurrently call refreshState while mutation active (hits activeMutationToken guard) & busy begin guard
    await ctrl.refreshState()
    await ctrl.begin()
    ctrl.resetForConnectionSwitch('c1')
    connId = 'c2'
    resolveBegin({ active: true, autoCommit: false, statementCount: 1, supported: true, txToken: 91 })
    await switchedBegin

    // Switch back to c1 while c1 cleanup is held open by an unresolved tx.rollback -> hits pendingConnectionCleanups paths
    rpcHandlers.set('tx.status', async () => ({
      active: true,
      autoCommit: false,
      statementCount: 1,
      supported: true,
      txToken: 92,
    }))
    await ctrl.refreshState() // c2 is now active TX
    let resolvePendingRb!: (v: TransactionState) => void
    rpcHandlers.set(
      'tx.rollback',
      async () =>
        new Promise((res) => {
          resolvePendingRb = res
        })
    )
    ctrl.resetForConnectionSwitch('c2') // starts unresolved tx.rollback tracked in pendingConnectionCleanups for c2
    connId = 'c2'
    await ctrl.refreshState('c2') // masks active=false while cleanup pending
    const waitToggleP = ctrl.toggleAutoCommit() // enters waitForConnectionCleanup('c2')
    resolvePendingRb({ active: false, autoCommit: true, statementCount: 0, supported: true })
    await waitToggleP

    // Also waitForConnectionCleanup inside begin, commit & rollback + rollbackOnUnload with active TX & pending cleanup
    rpcHandlers.set('tx.status', async () => ({
      active: true,
      autoCommit: false,
      statementCount: 1,
      supported: true,
      txToken: 95,
    }))
    await ctrl.refreshState('c2')
    const rbQueue: Array<(v: TransactionState) => void> = []
    rpcHandlers.set('tx.rollback', async () => new Promise((res) => { rbQueue.push(res) }))
    ctrl.resetForConnectionSwitch('c2')
    connId = 'c3'
    rpcHandlers.set('tx.rollback', async () => ({ active: false, autoCommit: true, statementCount: 0, supported: true }))
    rpcHandlers.set('tx.status', async () => ({
      active: false,
      autoCommit: true,
      statementCount: 0,
      supported: true,
      txToken: 96,
    }))
    await ctrl.refreshState('c3')
    // Active TX + inFlightBegin on c3 while c2 is still in pendingConnectionCleanups -> rollbackOnUnload covers all branches
    let resolveUnloadBegin!: (v: TransactionState) => void
    rpcHandlers.set('tx.begin', async () => new Promise((res) => { resolveUnloadBegin = res }))
    const unloadBeginP = ctrl.begin()
    ctrl.rollbackOnUnload()
    resolveUnloadBegin({ active: true, autoCommit: false, statementCount: 1, supported: true, txToken: 97 })
    while (rbQueue.length) rbQueue.shift()!({ active: false, autoCommit: true, statementCount: 0, supported: true })
    await unloadBeginP

    // Switch back to c2 cleanly & hit guards (commit/rollback when not active)
    connId = 'c2'
    await ctrl.refreshState('c2')
    await ctrl.commit()
    await ctrl.rollback()

    // Wait-for-cleanup inside begin / commit / rollback via unresolved cleanup before begin/commit/rollback
    rpcHandlers.set('tx.status', async () => ({
      active: true,
      autoCommit: false,
      statementCount: 1,
      supported: true,
      txToken: 98,
    }))
    await ctrl.refreshState('c2')
    rpcHandlers.set('tx.rollback', async () => new Promise((res) => { rbQueue.push(res) }))
    ctrl.resetForConnectionSwitch('c2')
    rpcHandlers.set('tx.rollback', async () => ({ active: false, autoCommit: true, statementCount: 0, supported: true }))
    connId = 'c2'
    await ctrl.refreshState('c2')
    rpcHandlers.set('tx.begin', async () => ({ active: true, autoCommit: false, statementCount: 0, supported: true, txToken: 99 }))
    const beginAfterCleanup = ctrl.begin()
    while (rbQueue.length) rbQueue.shift()!({ active: false, autoCommit: true, statementCount: 0, supported: true })
    await beginAfterCleanup

    // Wait-for-cleanup inside commit & rollback
    rpcHandlers.set('tx.rollback', async () => new Promise((res) => { rbQueue.push(res) }))
    ctrl.resetForConnectionSwitch('c2')
    rpcHandlers.set('tx.rollback', async () => ({ active: false, autoCommit: true, statementCount: 0, supported: true }))
    connId = 'c2'
    ctrl.resetLocalStateAndRender()
    // Seed state as active before unresolved cleanup finishes so commit() & rollback() pass state.active guard
    ;(ctrl as unknown as { state: TransactionState }).state = { active: true, autoCommit: false, statementCount: 1, supported: true }
    rpcHandlers.set('tx.commit', async () => ({ active: true, autoCommit: false, statementCount: 0, supported: true }))
    const commitAfterCleanup = ctrl.commit()
    while (rbQueue.length) rbQueue.shift()!({ active: false, autoCommit: true, statementCount: 0, supported: true })
    await commitAfterCleanup

    rpcHandlers.set('tx.rollback', async () => new Promise((res) => { rbQueue.push(res) }))
    ctrl.resetForConnectionSwitch('c2')
    // Switch tx.rollback back to immediate resolution BEFORE ctrl.rollback() executes its own RPC after cleanup!
    rpcHandlers.set('tx.rollback', async () => ({ active: false, autoCommit: true, statementCount: 0, supported: true }))
    connId = 'c2'
    ;(ctrl as unknown as { state: TransactionState }).state = { active: true, autoCommit: false, statementCount: 1, supported: true }
    const rbAfterCleanup = ctrl.rollback()
    while (rbQueue.length) rbQueue.shift()!({ active: false, autoCommit: true, statementCount: 0, supported: true })
    await rbAfterCleanup

    ctrl.destroy()
    await ctrl.refreshState()
  })

  it('covers src/editor/value-inspector.ts inspect, JSON format/minify, batch vs direct apply & guards', async () => {
    const inspectBtn = dom.document.createElement('button') as unknown as HTMLButtonElement
    let batchMode = false
    let stagedCount = 0
    let resizeCalls = 0
    let modelData: { headers: string[]; rows: Array<unknown[] | Record<string, unknown>>; primaryKey: string[] } | null = {
      headers: ['id', 'payload', 'note'],
      rows: [
        [10, '{"k":1}', null],
        { id: 20, payload: { nested: true }, note: 'hi\nthere' },
      ],
      primaryKey: ['id'],
    }
    const target = {
      connectionId: 'c1' as string | null,
      table: 'items' as string | null,
      schema: 'public',
      page: 1,
      viewSeq: 1,
      isShowingSqlResult: false,
    }
    const stageCellEdit = vi.fn()
    let updateCellImpl = async () => ({ ok: true })
    const reloadTableData = vi.fn(async () => {})
    const updateStatus = vi.fn()

    const fakeGrid = {
      handleViewportResize: () => {
        resizeCalls++
      },
      isBatchMode: () => batchMode,
      getStagedCount: () => stagedCount,
      stageCellEdit,
      getModel: () => modelData,
    } as unknown as VirtualDataGrid

    // Persisted valid height check + storage failure tolerance on read/write
    dom.localStorage.setItem('datanoa.studioValueInspectorPx', '260')
    const validHeightCtrl = new ValueInspectorController({
      getInspectButton: () => null,
      getDataGrid: () => null,
      getActiveTarget: () => ({ ...target }),
      updateCell: async () => ({ ok: true }),
      reloadTableData,
      updateStatus,
    })
    validHeightCtrl.open({
      rowIndex: 0,
      colIndex: 0,
      columnName: 'id',
      value: 42,
      isEditable: true,
      isInserted: false,
      isDeleted: false,
    })
    const unparentedRoot = validHeightCtrl.buildElement()
    validHeightCtrl.open({
      rowIndex: 0,
      colIndex: 0,
      columnName: 'id',
      value: 42,
      isEditable: true,
      isInserted: false,
      isDeleted: false,
    })
    expect(unparentedRoot.style.height).toBe('260px')
    // Test persistHeight catch + Home/End keyboard resize + no-RAF drag
    const origSet = dom.localStorage.setItem.bind(dom.localStorage)
    dom.localStorage.setItem = () => {
      throw new Error('quota')
    }
    const origRaf = (globalThis as Record<string, unknown>).requestAnimationFrame
    ;(globalThis as Record<string, unknown>).requestAnimationFrame = undefined
    try {
      const unResizer = unparentedRoot.querySelector('.datanoa-value-inspector-resizer')!
      dom.fireKey(unResizer, 'Home')
      expect(unparentedRoot.style.height).toBe('140px')
      dom.fireKey(unResizer, 'End')
      expect(unparentedRoot.style.height).toBe('560px')
      unResizer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientY: 500 }))
      dom.window.dispatchEvent(new MouseEvent('mousemove', { clientY: 450 }))
      dom.window.dispatchEvent(new MouseEvent('mouseup'))
    } finally {
      ;(globalThis as Record<string, unknown>).requestAnimationFrame = origRaf
      dom.localStorage.setItem = origSet
      validHeightCtrl.destroy()
    }

    const origGet = dom.localStorage.getItem.bind(dom.localStorage)
    dom.localStorage.getItem = () => {
      throw new Error('storage blocked')
    }
    const ctrl = new ValueInspectorController({
      getInspectButton: () => inspectBtn,
      getDataGrid: () => fakeGrid,
      getActiveTarget: () => ({ ...target }),
      updateCell: async (p) => updateCellImpl(p),
      reloadTableData,
      updateStatus,
    })
    dom.localStorage.getItem = origGet

    const root = ctrl.buildElement()
    dom.body.appendChild(root)
    expect(ctrl.getSelectedCell()).toBeNull()
    ctrl.open() // no selection -> no-op
    ctrl.toggle() // still closed, no-op

    const cell0: SelectedCellInfo = {
      rowIndex: 0,
      colIndex: 2,
      columnName: 'note',
      value: null,
      columnType: 'text',
      isEditable: true,
      isInserted: false,
      isDeleted: false,
      isNullable: true,
    }
    // handleSelectionChanged while closed updates disabled state without opening
    ctrl.handleSelectionChanged(cell0)
    expect(inspectBtn.disabled).toBe(false)
    ctrl.toggle() // opens with stored selectedCell
    expect(ctrl.getSelectedCell()).toBe(cell0)
    expect(root.querySelector('.datanoa-null-badge')?.style.display).toBe('inline-flex')

    // Object + circular object + bracketed invalid JSON + plain single-line string + numeric + readOnly
    const circ: Record<string, unknown> = {}
    circ.self = circ
    ctrl.handleSelectionChanged({
      rowIndex: 1,
      colIndex: 1,
      columnName: 'payload',
      value: circ,
      isEditable: false,
      isInserted: false,
      isDeleted: false,
      isNullable: false,
    })
    const ta = root.querySelector('textarea') as HTMLTextAreaElement
    expect(ta.readOnly).toBe(true)

    ctrl.handleSelectionChanged({
      rowIndex: 1,
      colIndex: 1,
      columnName: 'payload',
      value: '[bad json]',
      isEditable: true,
      isInserted: false,
      isDeleted: false,
      isNullable: true,
    })
    expect(ta.value).toBe('[bad json]')

    ctrl.handleSelectionChanged({
      rowIndex: 1,
      colIndex: 2,
      columnName: 'note',
      value: 'plain',
      isEditable: true,
      isInserted: false,
      isDeleted: false,
      isNullable: true,
    })
    expect(root.querySelector('.datanoa-json-status')?.textContent).toBe('5 chars · 1 line')

    // Invalid JSON text -> Format/Minify update status, JSON status shows invalid
    ctrl.handleSelectionChanged({
      rowIndex: 1,
      colIndex: 1,
      columnName: 'payload',
      value: '{bad json',
      columnType: 'jsonb',
      isEditable: true,
      isInserted: false,
      isDeleted: false,
      isNullable: true,
    })
    expect(root.querySelector('.datanoa-json-status')?.textContent).toContain('Invalid JSON')
    const buttons = root.querySelectorAll('.datanoa-btn-group button')
    const [fmtBtn, minBtn, nullBtn, applyBtn, copyBtn, closeBtn] = buttons
    dom.click(fmtBtn)
    dom.click(minBtn)
    expect(updateStatus).toHaveBeenCalledWith('Value is not valid JSON')

    // Valid object formatted & minified
    ctrl.handleSelectionChanged({
      rowIndex: 1,
      colIndex: 1,
      columnName: 'payload',
      value: { a: 1, b: 2 },
      isEditable: true,
      isInserted: false,
      isDeleted: false,
      isNullable: false,
    })
    expect(root.querySelector('.datanoa-json-status')?.textContent).toContain('Valid JSON')
    dom.click(minBtn)
    expect(ta.value).toBe('{"a":1,"b":2}')
    dom.click(fmtBtn)
    expect(ta.value).toContain('\n')

    // Input change & Copy
    dom.setInput(ta, '{"z":9}', 'input')
    dom.click(copyBtn)
    expect(dom.clipboardWrites).toContain('{"z":9}')

    // Direct apply on object-row PK -> calls updateCell + reloadTableData
    const updateCalls: Array<Record<string, unknown>> = []
    updateCellImpl = async (p?: Record<string, unknown>) => {
      if (p) updateCalls.push(p)
      return { ok: true }
    }
    dom.click(applyBtn)
    await dom.flushMicrotasks()
    expect(updateCalls[0]).toMatchObject({ primaryKeys: { id: 20 }, column: 'payload', newValue: '{"z":9}' })
    expect(reloadTableData).toHaveBeenCalledTimes(1)

    // Direct Set NULL on array-row (row 0, nullable) via Ctrl+Enter + Set NULL
    ctrl.handleSelectionChanged({
      rowIndex: 0,
      colIndex: 1,
      columnName: 'payload',
      value: '{"k":1}',
      isEditable: true,
      isInserted: false,
      isDeleted: false,
      isNullable: true,
    })
    dom.click(nullBtn)
    await dom.flushMicrotasks()
    expect(updateCalls[1]).toMatchObject({ primaryKeys: { id: 10 }, column: 'payload', newValue: null })

    // Ctrl+Enter apply when updateCell rejects
    updateCellImpl = async () => {
      throw new Error('constraint violation')
    }
    dom.setInput(ta, '{"k":2}', 'input')
    dom.fireKey(ta, 'Enter', { ctrlKey: true })
    await dom.flushMicrotasks()
    expect(updateStatus).toHaveBeenCalledWith('Failed to update payload: constraint violation')

    // Target changed before completion skips reloadTableData
    updateCellImpl = async () => {
      target.viewSeq = 99
      return { ok: true }
    }
    dom.click(applyBtn)
    await dom.flushMicrotasks()
    expect(reloadTableData).toHaveBeenCalledTimes(2) // unchanged from before

    // Batch mode / inserted row stages edits instead of RPC
    batchMode = true
    dom.click(nullBtn)
    expect(stageCellEdit).toHaveBeenCalledWith(0, 1, null)
    batchMode = false
    stagedCount = 1
    dom.setInput(ta, '{"k":3}', 'input')
    dom.click(applyBtn)
    expect(stageCellEdit).toHaveBeenCalledTimes(2)
    stagedCount = 0

    // Missing model / PK / target guards
    modelData = { headers: ['id'], rows: [[1]], primaryKey: [] }
    dom.setInput(ta, '{"k":4}', 'input')
    dom.click(applyBtn)
    target.connectionId = null
    dom.click(applyBtn)

    // Toggle closes when open, Close button, clearSelection, destroy
    ctrl.toggle() // currently open -> closes!
    expect(root.style.display).toBe('none')
    ctrl.toggle() // re-open via toggle
    dom.click(closeBtn)
    expect(resizeCalls).toBeGreaterThan(0)
    ctrl.toggle() // re-open via toggle
    ctrl.handleSelectionChanged(null)
    ctrl.clearSelection()
    expect(inspectBtn.disabled).toBe(true)
    ctrl.destroy()
  })
})
