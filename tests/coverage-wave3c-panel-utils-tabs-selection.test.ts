import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'
import { installDomHarness, type DomHarness } from './helpers/dom-harness.js'
import {
  compactSqlPreview,
  getEffectiveResultSets,
  getDefaultResultSetIndex,
  buildSingleSetQueryResult,
  buildInitialPanelResultStates,
  buildCombinedExplainResult,
  buildErrorQueryResult,
} from '../src/panel/panel-result-sets.js'
import {
  createPanelConsoleTabsManager,
  computePanelSqlCompletions,
  encodePanelTableSelectValue,
  decodePanelTableSelectValue,
  PANEL_SQL_EDITOR_MIN_HEIGHT,
  PANEL_SQL_EDITOR_DEFAULT_HEIGHT,
  PANEL_SQL_EDITOR_HARD_MAX_HEIGHT,
  computePanelSqlEditorBounds,
  clampPanelSqlEditorHeight,
} from '../src/panel/panel-sql-tabs.js'
import { PanelGridSelection } from '../src/panel/panel-selection.js'
import * as cmVendor from '../vendor/codemirror.js'

let dom: DomHarness

beforeEach(() => {
  dom = installDomHarness()
})

afterEach(() => {
  vi.useRealTimers()
  dom.teardown()
})

describe('Wave 3C Step 1: panel-result-sets, panel-sql-tabs, panel-utils, panel-cm & panel-selection', () => {
  it('covers src/panel/panel-result-sets.js completely + PBT', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 160 }), (rawSql) => {
        const preview = compactSqlPreview(rawSql)
        expect(preview.length).toBeLessThanOrEqual(88)
        expect(preview).not.toMatch(/[\r\n\t]/)
      }),
      { numRuns: 50 }
    )
    expect(compactSqlPreview(null)).toBe('')
    expect(compactSqlPreview('  SELECT   1  ')).toBe('SELECT 1')
    expect(compactSqlPreview('x'.repeat(120)).endsWith('...')).toBe(true)

    expect(getEffectiveResultSets(null)).toEqual([])
    const flatRes = {
      columns: [{ name: 'id' }],
      rows: [[1], [2]],
      executionTimeMs: 4.5,
      truncated: true,
      isSelect: true,
      affectedRows: 0,
    }
    const normSingle = getEffectiveResultSets(flatRes, 'SELECT id FROM t')
    expect(normSingle).toHaveLength(1)
    expect(normSingle[0].rowCount).toBe(2)
    expect(normSingle[0].truncated).toBe(true)

    const normNoRows = getEffectiveResultSets({ columns: [], isSelect: false })
    expect(normNoRows[0].rowCount).toBe(0)
    expect(normNoRows[0].sqlPreview).toBeUndefined()

    const multiRes = {
      executionTimeMs: 12,
      resultSets: [
        { index: 0, isSelect: false, affectedRows: 3, executionTimeMs: 2 },
        { index: 1, isSelect: true, columns: [{ name: 'c' }], rows: [[1]], executionTimeMs: 5, truncated: true },
        { index: 2, isSelect: false, isError: true, errorMessage: 'boom' },
      ],
    }
    expect(getEffectiveResultSets(multiRes)).toHaveLength(3)
    expect(getDefaultResultSetIndex(multiRes, 'explain')).toBe(0)
    expect(getDefaultResultSetIndex(multiRes, 'query')).toBe(1)
    expect(getDefaultResultSetIndex({ resultSets: [] }, 'query')).toBe(0)
    expect(getDefaultResultSetIndex(null, 'query')).toBe(0)

    expect(buildSingleSetQueryResult(multiRes, 99)).toBe(multiRes)
    const proj1 = buildSingleSetQueryResult(multiRes, 1)
    expect(proj1.rowCount).toBe(1)
    expect(proj1.truncated).toBe(true)
    const proj2 = buildSingleSetQueryResult(multiRes, 2)
    expect(proj2.isError).toBe(true)
    expect(proj2.errorMessage).toBe('boom')
    expect(buildSingleSetQueryResult({ resultSets: [{ index: 0 }] }, 0).executionTimeMs).toBe(0)

    const statesQuery = buildInitialPanelResultStates(multiRes, ['INSERT 1', 'SELECT 1', 'BAD'], 'ALL', 9.9, 'query')
    expect(statesQuery[0].banner.text).toContain('3 affected')
    expect(statesQuery[1].banner.text).toContain('1 rows')
    expect(statesQuery[1].banner.badgeText).toContain('(truncated)')
    expect(statesQuery[2].banner.kind).toBe('error')
    expect(statesQuery[2].banner.scopeLabel).toContain('Result 3')

    const statesExplainSingle = buildInitialPanelResultStates(
      { columns: [{ name: 'detail' }], rows: [['SCAN t']], isSelect: true, executionTimeMs: undefined },
      [],
      'EXPLAIN SELECT * FROM t',
      Number.NaN,
      'explain'
    )
    expect(statesExplainSingle[0].banner.text).toContain('1 step · 0.0 ms')
    const statesExplainErr = buildInitialPanelResultStates(
      { resultSets: [{ isError: true }, { columns: [], rows: [{}, {}] }] },
      [],
      'EXPLAIN SELECT 1',
      3.5,
      'explain'
    )
    expect(statesExplainErr[0].banner.text).toContain('EXPLAIN Error: Query failed')
    expect(statesExplainErr[1].banner.scopeLabel).toContain('2 steps')

    const combined1 = buildCombinedExplainResult([{ columns: [{ name: 'p' }], rows: [['x']], rowCount: 1 }], null, 5)
    expect(combined1.resultSets).toBeUndefined()
    const combinedEmpty = buildCombinedExplainResult([], null, 0)
    expect(combinedEmpty.columns).toEqual([])
    const combinedMulti = buildCombinedExplainResult(
      [
        { columns: [{ name: 'a' }], rows: [[1]], truncated: true },
        { columns: [{ name: 'b' }], rows: [[2]] },
      ],
      { columns: [{ name: 'a' }], rows: [[1]], truncated: true },
      11
    )
    expect(combinedMulti.resultSets).toHaveLength(2)
    expect(combinedMulti.truncated).toBe(true)

    const errRes = buildErrorQueryResult('SELECT * FROM missing', 'no such table')
    expect(errRes.resultSets[0].isError).toBe(true)
    expect(errRes.resultSets[0].errorMessage).toBe('no such table')
  })

  it('covers src/panel/panel-sql-tabs.js tabs lifecycle, completions & height PBT', () => {
    // Table select encoding + SQL editor bounds PBT
    fc.assert(
      fc.property(
        fc.string({ maxLength: 30 }),
        fc.string({ minLength: 1, maxLength: 30 }),
        (schema, name) => {
          const encoded = encodePanelTableSelectValue(schema, name)
          const decoded = decodePanelTableSelectValue(encoded)
          expect(decoded).toEqual({
            schema: schema ? schema : undefined,
            name,
          })
        }
      ),
      { numRuns: 50 }
    )
    expect(decodePanelTableSelectValue('')).toBeNull()
    expect(decodePanelTableSelectValue('{bad json')).toBeNull()
    expect(decodePanelTableSelectValue('["pub",""]')).toBeNull()
    expect(encodePanelTableSelectValue(null, '')).toBe('["",""]')

    fc.assert(
      fc.property(
        fc.integer({ min: -100, max: 2000 }),
        fc.integer({ min: -100, max: 2000 }),
        (desired, containerH) => {
          const bounds = computePanelSqlEditorBounds(containerH)
          const clamped = clampPanelSqlEditorHeight(desired, containerH)
          expect(bounds.min).toBe(PANEL_SQL_EDITOR_MIN_HEIGHT)
          expect(bounds.max).toBeGreaterThanOrEqual(PANEL_SQL_EDITOR_MIN_HEIGHT + 40)
          expect(clamped).toBeGreaterThanOrEqual(bounds.min)
          expect(clamped).toBeLessThanOrEqual(bounds.max)
          expect(clamped).toBeLessThanOrEqual(PANEL_SQL_EDITOR_HARD_MAX_HEIGHT)
        }
      ),
      { numRuns: 60 }
    )
    expect(clampPanelSqlEditorHeight('not-a-number', 500)).toBe(PANEL_SQL_EDITOR_DEFAULT_HEIGHT)

    // Console tabs manager init variants + 20-tab cap + methods
    const strMgr = createPanelConsoleTabsManager('SELECT 1;')
    expect(strMgr.getActiveTab().sql).toBe('SELECT 1;')
    expect(strMgr.closeTab(strMgr.getActiveTabId())).toBe(false) // cannot close last tab

    const emptyMgr = createPanelConsoleTabsManager(null)
    expect(emptyMgr.getTabs()).toHaveLength(1)

    const initMgr = createPanelConsoleTabsManager({
      activeTabId: 'missing_id',
      tabs: [
        { id: 't1', title: '  Custom 1 ', sql: 'SELECT 1' },
        { id: '', title: '', sql: null as unknown as string },
      ],
    })
    expect(initMgr.getActiveTabId()).toBe('t1')
    const t2 = initMgr.getTabs()[1]
    expect(t2.title).toBe('Console 2')
    expect(initMgr.switchTab('nonexistent')).toBe(false)
    expect(initMgr.switchTab(t2.id)).toBe(true)

    const t3 = initMgr.addTab('SELECT 2', 'Named')
    expect(t3.title).toBe('Named')
    expect(initMgr.renameTab(t3.id, '   ')).toBe(false)
    expect(initMgr.renameTab('unknown', 'Ok')).toBe(false)
    expect(initMgr.renameTab(t3.id, 'Renamed Very Long Title Over Forty Characters 123456')).toBe(true)
    expect(initMgr.getActiveTab().title.length).toBeLessThanOrEqual(40)

    initMgr.updateActiveSql('SELECT * FROM users;', 6)
    initMgr.updateActiveSql('SELECT * FROM users')
    expect(initMgr.setResultForTab('unknown', null)).toBe(false)
    expect(
      initMgr.setResultForTab(t3.id, { rows: [[1]] }, 0, 'SELECT 1', 'conn1', { 0: { sortDir: 'ASC' } }, 'explain')
    ).toBe(true)
    initMgr.setActiveResultSetIndex(2)
    expect(initMgr.getResultTabState(0, t3.id)).toEqual({ sortDir: 'ASC' })
    initMgr.setResultTabState(1, { sortDir: 'DESC' })
    initMgr.setResultTabState(1, { sortDir: 'ASC' }, 'missing')
    // Clear null result resets states
    expect(initMgr.setResultForTab(t3.id, null, -1, 'SELECT 1')).toBe(true)
    expect(initMgr.getResultTabState(0, t3.id)).toBeUndefined()

    expect(initMgr.closeTab('missing')).toBe(false)
    expect(initMgr.closeTab(t3.id)).toBe(true) // closes active and selects neighbor

    // Fill past MAX_PANEL_CONSOLE_TABS (20)
    for (let i = 0; i < 22; i++) {
      initMgr.addTab(`SELECT ${i};`)
    }
    expect(initMgr.getTabs().length).toBe(20)
    initMgr.updateActiveSql('PASSWORD=secret')
    const persisted = initMgr.toPersistedState((sql) => sql.includes('secret'))
    expect(persisted.tabs.some((t) => t.sql === '')).toBe(true)

    // Completions across dialects
    const schema = {
      users: ['id', 'email', 'created_at'],
      'analytics.orders': ['order_id', 'user_id', 'total'],
    }
    // Dot table qualifier & alias qualifier & schema qualifier
    expect(computePanelSqlCompletions('SELECT users.em', 15, 'postgres', schema)?.options[0].label).toBe('email')
    expect(
      computePanelSqlCompletions('SELECT u.cr FROM users AS u', 11, 'postgres', schema)?.options.some(
        (o) => o.label === 'created_at'
      )
    ).toBe(true)
    expect(
      computePanelSqlCompletions('SELECT * FROM analytics.ord', 27, 'postgres', schema)?.options[0].label
    ).toBe('orders')

    // FROM/JOIN table context + empty cursor + lower keywords
    expect(computePanelSqlCompletions('SELECT ', 7, 'sqlite', schema, undefined, false)).toBeNull()
    expect(computePanelSqlCompletions('SELECT * FROM ', 14, 'sqlite', schema, undefined, false)?.options.length).toBeGreaterThan(0)
    const explicitComp = computePanelSqlCompletions('SELECT ', 7, 'sqlite', schema, 'users', true)
    expect(explicitComp?.options.some((o) => o.label === 'SELECT')).toBe(true)
    const lowerKw = computePanelSqlCompletions('sel', 3, 'sqlite', schema, 'users', false)
    expect(lowerKw?.options.some((o) => o.apply === 'select')).toBe(true)

    // MSSQL & Oracle extras (including DUAL)
    expect(
      computePanelSqlCompletions('SELECT TOP', 10, 'mssql', schema)?.options.some((o) => o.label.includes('TOP'))
    ).toBe(true)
    expect(
      computePanelSqlCompletions('SELECT du', 9, 'oracle', schema)?.options.some((o) => o.label === 'DUAL')
    ).toBe(true)

    // Redis & MongoDB
    expect(computePanelSqlCompletions('', 0, 'redis', {}, undefined, false)).toBeNull()
    expect(computePanelSqlCompletions('hg', 2, 'redis', {}, undefined, false)?.options[0].label).toBe('HGETALL')
    expect(computePanelSqlCompletions('db.us', 5, 'mongodb', { users: ['email'] })?.options.some((o) => o.label === 'users')).toBe(true)
    expect(
      computePanelSqlCompletions("db.getCollection('users').fin", 29, 'mongodb', { users: ['email'] })?.options.some((o) =>
        o.label.includes('find')
      )
    ).toBe(true)
    expect(computePanelSqlCompletions('', 0, 'mongodb', { users: ['email'] }, undefined, false)).toBeNull()
    expect(
      computePanelSqlCompletions('$ma', 3, 'mongodb', { users: ['email'] }, undefined, true)?.options.some(
        (o) => o.label === '$match'
      )
    ).toBe(true)
    expect(
      computePanelSqlCompletions('ema', 3, 'mongodb', { users: ['email'] }, undefined, true)?.options.some(
        (o) => o.label === 'email'
      )
    ).toBe(true)
  })

  it('covers src/panel/panel-utils.js DOM, RPC, theme, dropdown, clipboard, virtual table & file picker', async () => {
    vi.resetModules()
    const panelUtils = await import('../src/panel/panel-utils.js')
    const {
      DB_SVG_MARKUP,
      getDbLogoSvg,
      setDbLogoElement,
      rpc,
      syncThemeFromTokens,
      applyTypographySnapshot,
      syncOrcaTypography,
      makeTableKey,
      encodeTableSelectValue,
      decodeTableSelectValue,
      setButtonLoading,
      updateButtonLoadingLabel,
      createElapsedTimer,
      downloadTextFile,
      createEnvBadge,
      createSortSvg,
      getFolderSvgMarkup,
      getWorkspaceSvgMarkup,
      syncSelectTooltip,
      bindSelectTooltipsInRoot,
      isCustomDropdownOpen,
      closeActiveCustomDropdown,
      enhanceCollapsibleSelectDropdown,
      $,
      writeTextToClipboard,
      syncVirtualTableWindow,
      openPanelFilePickerModal,
    } = panelUtils

    expect(document.getElementById('datanoa-geist-font')).toBeTruthy()
    expect(Object.keys(DB_SVG_MARKUP).length).toBeGreaterThan(5)
    expect(getDbLogoSvg('unknown-driver', 999)).toContain('width="64"')
    const iconBox = document.createElement('div')
    setDbLogoElement(iconBox, 'postgres', 4)
    expect(iconBox.innerHTML).toContain('width="8"')

    // RPC: plugin.request vs host.call fallback vs missing bridge
    delete (window as { orca?: unknown }).orca
    await expect(rpc('ping')).rejects.toThrow('Orca IPC bridge is unavailable')

    const pluginReqSpy = vi.fn(async (m: string, p?: unknown) => ({ via: 'plugin', m, p }))
    ;(window as { orca?: unknown }).orca = {
      plugin: { request: pluginReqSpy },
    }
    expect(await rpc('test.a')).toEqual({ via: 'plugin', m: 'test.a', p: undefined })
    expect(await rpc('test.b', { x: 1 })).toEqual({ via: 'plugin', m: 'test.b', p: { x: 1 } })
    expect(await rpc('test.c', undefined, { timeoutMs: 5000 })).toEqual({ via: 'plugin', m: 'test.c', p: {} })

    const hostCallSpy = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'editor.readTypography') return { cssFontFamily: 'Fira Code' }
      return { output: { via: 'host', params } }
    })
    ;(window as { orca?: unknown }).orca = {
      host: { call: hostCallSpy },
    }
    expect(await rpc('test.host', { y: 2 }, { timeoutMs: 3000, signal: undefined })).toEqual({
      via: 'host',
      params: { name: 'test.host', input: { y: 2 }, timeoutMs: 3000 },
    })
    expect(await rpc('test.hostNoOpts')).toEqual({ via: 'host', params: { name: 'test.hostNoOpts' } })

    // Theme & Typography
    const origWinComputed = window.getComputedStyle
    const origGlobalComputed = globalThis.getComputedStyle
    const setMockComputed = (bg: string) => {
      const fn = (() => ({ backgroundColor: bg })) as unknown as typeof window.getComputedStyle
      window.getComputedStyle = fn
      globalThis.getComputedStyle = fn
    }
    setMockComputed('rgb(255, 255, 255)')
    syncThemeFromTokens()
    expect(document.documentElement.classList.contains('light')).toBe(true)
    setMockComputed('rgba(0, 0, 0, 0)')
    syncThemeFromTokens()
    window.getComputedStyle = origWinComputed
    globalThis.getComputedStyle = origGlobalComputed
    applyTypographySnapshot(null)
    await syncOrcaTypography()
    expect(document.documentElement.style.getPropertyValue('--mono')).toContain('Fira Code')

    // Keys & table encode/decode PBT
    expect(makeTableKey('', '', '')).toBe('none::')
    expect(makeTableKey('c1', 'users', 'public')).toBe('c1:public:users')
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), (s, t) => {
        if (s.includes('\0') || t.includes('\0')) return
        const decoded = decodeTableSelectValue(encodeTableSelectValue(s, t))
        expect(decoded).toEqual({ schema: s || undefined, name: t })
      }),
      { numRuns: 40 }
    )
    expect(decodeTableSelectValue('bare_table')).toEqual({ schema: undefined, name: 'bare_table' })

    // Button loading + elapsed timer
    vi.useFakeTimers()
    setButtonLoading(null, true)
    updateButtonLoadingLabel(null, 'x')
    const btn = document.createElement('button')
    btn.textContent = 'Run'
    setButtonLoading(btn, true, 'Working...')
    expect(btn.disabled).toBe(true)
    updateButtonLoadingLabel(btn, 'Still working...')
    expect(btn.textContent).toContain('Still working...')
    setButtonLoading(btn, false)
    expect(btn.disabled).toBe(false)
    expect(btn.textContent).toBe('Run')

    const ticks: string[] = []
    const stopTimer = createElapsedTimer((t) => ticks.push(t))
    await vi.advanceTimersByTimeAsync(450)
    stopTimer()
    stopTimer() // idempotent stop
    expect(ticks.length).toBeGreaterThanOrEqual(2)

    // downloadTextFile (orca.files.saveAs saved/cancelled + Blob fallback)
    ;(window as { orca?: unknown }).orca = {
      files: {
        saveAs: vi
          .fn()
          .mockResolvedValueOnce({ status: 'saved' })
          .mockResolvedValueOnce({ status: 'cancelled' })
          .mockRejectedValueOnce(new Error('denied')),
      },
    }
    expect(await downloadTextFile('a.csv', '1,2')).toBe('saved')
    expect(await downloadTextFile('a.csv', '1,2')).toBe('cancelled')
    expect(await downloadTextFile('a.csv', '1,2')).toBe('saved') // falls back to Blob + createObjectURL
    await vi.advanceTimersByTimeAsync(1100)
    expect(dom.revokedObjectUrls.length).toBeGreaterThanOrEqual(1)

    // Badges & SVGs
    expect(createEnvBadge('none')).toBeNull()
    expect(createEnvBadge('')).toBeNull()
    expect(createEnvBadge('prod')?.textContent).toBe('PROD')
    expect(createSortSvg('ASC').outerHTML).toContain('6 11 12 5 18 11')
    expect(createSortSvg('DESC').outerHTML).toContain('6 13 12 19 18 13')
    expect(getFolderSvgMarkup(true, 16)).toContain('is-open')
    expect(getWorkspaceSvgMarkup(16)).toContain('workspace-svg')

    // Select tooltip + custom collapsible dropdown
    const sel = document.createElement('select')
    sel.id = 'panelDemoSel'
    const og = document.createElement('optgroup')
    og.label = 'Analytics'
    const o1 = document.createElement('option')
    o1.value = 'c1'
    o1.textContent = 'PG Main'
    o1.dataset.driver = 'postgres'
    og.appendChild(o1)
    const o2 = document.createElement('option')
    o2.value = 'ws1'
    o2.textContent = 'WS Scope'
    sel.append(og, o2)
    document.body.appendChild(sel)
    expect($('panelDemoSel')).toBe(sel)
    bindSelectTooltipsInRoot(document)
    syncSelectTooltip(null)
    syncSelectTooltip(sel, 'Connection')
    sel.dispatchEvent(new Event('change'))
    sel.dispatchEvent(new Event('mouseenter'))

    enhanceCollapsibleSelectDropdown(sel, { leadingIconType: 'db' })
    const trigger = document.querySelector('.custom-select-trigger') as HTMLButtonElement | null
    trigger?.click()
    expect(isCustomDropdownOpen()).toBe(true)
    closeActiveCustomDropdown()
    expect(isCustomDropdownOpen()).toBe(false)
    enhanceCollapsibleSelectDropdown(sel, { leadingIconType: 'workspace' })
    syncSelectTooltip(sel, 'Workspace')

    // writeTextToClipboard
    const copied = await writeTextToClipboard('SELECT 42;')
    expect(copied).toBe(true)
    expect(dom.clipboardWrites).toContain('SELECT 42;')

    // syncVirtualTableWindow (no-op + initial + reuse scroll down/up + jump + force)
    const tbl = document.createElement('table')
    const tbody = document.createElement('tbody')
    const topTr = document.createElement('tr')
    const topTd = document.createElement('td')
    topTr.appendChild(topTd)
    const botTr = document.createElement('tr')
    const botTd = document.createElement('td')
    botTr.appendChild(botTd)
    tbody.append(topTr, botTr)
    tbl.appendChild(tbody)
    document.body.appendChild(tbl)

    const virt = {
      tbody,
      topSpacerTr: topTr,
      topSpacerTd: topTd,
      bottomSpacerTr: botTr,
      bottomSpacerTd: botTd,
      start: -1,
      end: -1,
    }
    const detached: number[] = []
    const selMock = { detachRow: vi.fn(), applyDomClasses: vi.fn() }
    const makeRow = (r: number) => {
      const tr = document.createElement('tr')
      tr.dataset.rowIdx = String(r)
      return tr
    }
    expect(
      syncVirtualTableWindow({
        virt,
        total: 40,
        start: 0,
        end: 10,
        rowHeightPx: 26,
        createRow: makeRow,
        selectionController: selMock,
        onBeforeDetachRow: (tr) => detached.push(Number(tr.dataset.rowIdx)),
      })
    ).toBe(true)
    expect(syncVirtualTableWindow({ virt, total: 40, start: 0, end: 10, rowHeightPx: 26, createRow: makeRow })).toBe(
      false
    )
    // Incremental scroll down + up
    syncVirtualTableWindow({
      virt,
      total: 40,
      start: 4,
      end: 14,
      rowHeightPx: 26,
      createRow: makeRow,
      selectionController: selMock,
      onBeforeDetachRow: (tr) => detached.push(Number(tr.dataset.rowIdx)),
    })
    syncVirtualTableWindow({
      virt,
      total: 40,
      start: 2,
      end: 12,
      rowHeightPx: 26,
      createRow: makeRow,
      selectionController: selMock,
    })
    // Full jump non-overlapping + force: true
    syncVirtualTableWindow({
      virt,
      total: 40,
      start: 25,
      end: 35,
      rowHeightPx: 26,
      createRow: makeRow,
      selectionController: selMock,
      force: true,
    })
    expect(selMock.applyDomClasses).toHaveBeenCalledTimes(1)
    expect(detached.length).toBeGreaterThan(0)

    // openPanelFilePickerModal -> fs.listDir
    ;(window as { orca?: unknown }).orca = {
      plugin: {
        request: vi.fn(async (name: string) => {
          if (name === 'fs.listDir') {
            return {
              ok: true,
              currentDir: '/repo/db',
              parentDir: '/repo',
              roots: ['/repo'],
              entries: [{ name: 'test.sqlite', path: '/repo/db/test.sqlite', kind: 'file', size: 120 }],
            }
          }
          return {}
        }),
      },
    }
    const pickerPromise = openPanelFilePickerModal({ title: 'Pick DB', mode: 'file', initialDir: '/repo/db' })
    await vi.advanceTimersByTimeAsync(10)
    const fpRow = document.querySelector('.panel-fp-row') as HTMLElement | null
    fpRow?.click()
    const fpConfirm = Array.from(document.querySelectorAll('.panel-fp-actions button')).find((b) =>
      (b.textContent ?? '').includes('Select file')
    ) as HTMLButtonElement | undefined
    fpConfirm?.click()
    const picked = await pickerPromise
    expect(picked).toEqual({ ok: true, path: '/repo/db/test.sqlite' })
  })

  it('covers src/panel/panel-cm.js dialects, tokenizers, completion source & CM6 lifecycle + PBT', async () => {
    const {
      extractPanelCaretStatementSql,
      buildPanelLanguageExtension,
      buildPanelCompletionExtension,
      createPanelCodeMirrorEditor,
    } = await import('../src/panel/panel-cm.js')

    // PBT on extractPanelCaretStatementSql
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('SELECT 1', 'SELECT 2 FROM a', "INSERT INTO b VALUES ('x;y')"), {
          minLength: 1,
          maxLength: 3,
        }),
        (stmts) => {
          const doc = stmts.join(';\n')
          const state = cmVendor.EditorState.create({ doc, selection: { anchor: 0 } })
          const extracted = extractPanelCaretStatementSql(state, 'sqlite')
          expect(extracted.length).toBeGreaterThan(0)
        }
      ),
      { numRuns: 30 }
    )
    const selState = cmVendor.EditorState.create({
      doc: 'SELECT 1; SELECT 2;',
      selection: { anchor: 10, head: 18 },
    })
    expect(extractPanelCaretStatementSql(selState, 'sqlite')).toBe('SELECT 2')
    expect(extractPanelCaretStatementSql(selState, 'redis')).toBe('SELECT 2')
    const redisState = cmVendor.EditorState.create({ doc: '  GET k:1  ', selection: { anchor: 2 } })
    expect(extractPanelCaretStatementSql(redisState, 'redis')).toBe('GET k:1')

    // Build all language + completion extensions and parse StreamLanguages thoroughly
    const mssqlSample =
      "-- line comment\n/* multi line\nblock comment */ SELECT TOP 100 N'hi''there', [col], \"quoted\", @v, @@ROWCOUNT, 42.5, a + b FROM [users];"
    const oracleSample =
      "-- ora\n/* block */\nSELECT q'[abc]', nq'(xyz)', 'a''b', \"ID\", :bindVar, 9.5, SYSDATE, NUMBER FROM DUAL WHERE x := 1 => 2;\n/"
    const mongoSample =
      "// mql\n/* c */\ndb.getCollection('users').find({ \"$match\": { v: 'ok\\'y', n: -3.14, b: true, z: null, a: ObjectId() } });"
    const samples: Record<string, string> = {
      mssql: mssqlSample,
      oracle: oracleSample,
      mongodb: mongoSample,
      redis: 'GET my:key',
    }
    for (const d of ['postgres', 'cockroachdb', 'mysql', 'mariadb', 'clickhouse', 'sqlite', 'libsql', 'd1', 'mssql', 'oracle', 'mongodb', 'redis', 'unknown']) {
      const ext = buildPanelLanguageExtension(d)
      if (samples[d]) {
        ext.language.parser.parse(samples[d])
      }
      const compExt = buildPanelCompletionExtension(d, { users: ['id', 'name'] }, 'users')
      expect(Array.isArray(compExt)).toBe(true)
    }

    // Mount real CM6 panel editor with all callbacks & options
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const onExec = vi.fn()
    const onExecAll = vi.fn()
    const onFmt = vi.fn()
    const onChg = vi.fn()
    const editor = createPanelCodeMirrorEditor({
      parent,
      initialDoc: 'SELECT * FROM users;',
      dialect: 'sqlite',
      schema: { users: ['id', 'email'] },
      isLightTheme: false,
      typography: { fontFamily: 'Consolas', fontSize: 13, lineHeight: 1.5, fontLigatures: false },
      onExecute: onExec,
      onExecuteAll: onExecAll,
      onFormatSql: onFmt,
      onChange: onChg,
      aiInline: {
        isAvailable: () => true,
        requestInlineEdit: async () => null,
      },
    })

    try {
      expect(editor.getValue()).toBe('SELECT * FROM users;')
      expect(editor.hasSelection()).toBe(false)
      editor.setValue('SELECT * FROM users;') // no-op identical
      editor.setValue('SELECT id FROM users;\nSELECT em')
      expect(onChg).toHaveBeenCalled()
      editor.setCursorOffset(10)
      expect(editor.getCursorOffset()).toBe(10)
      expect(editor.getCaretStatementSql()).toContain('SELECT id FROM users')

      editor.view.dispatch({ selection: { anchor: 0, head: 9 } })
      expect(editor.getSelectedText()).toBe('SELECT id')
      expect(editor.hasSelection()).toBe(true)

      editor.setDialect('sqlite') // no-op
      editor.setDialect('postgres')
      editor.setDialect('mongodb')
      editor.setSchema({ orders: ['order_id'] }, 'orders')
      editor.setColorScheme(true)
      editor.setTypography({ cssFontFamily: 'monospace' })
      editor.setPlaceholder('Write SQL here...')
      expect(parent.dataset.placeholder).toBe('Write SQL here...')
      editor.focus()
      editor.openFindReplace()
      editor.clearAiGhost()

      // Invoke registered smartSource completion function from CM6 state facet
      const docEnd = editor.getValue().length
      const acSources = editor.view.state.languageDataAt('autocomplete', docEnd)
      for (const src of acSources) {
        if (typeof src === 'function') {
          src({ state: editor.view.state, pos: docEnd, explicit: true })
          src({ state: editor.view.state, pos: 0, explicit: false })
        }
      }
      // Exercise runKeymap Mod-Enter, Mod-Shift-Enter, Shift-Alt-f
      editor.view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
      )
      editor.view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true })
      )
      editor.view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'f', shiftKey: true, altKey: true, bubbles: true })
      )
    } finally {
      editor.destroy()
    }
  })

  it('covers src/panel/panel-selection.js rectangular, row, col, drag, keyboard & clipboard flows', () => {
    const wrap = document.createElement('div')
    wrap.tabIndex = 0
    Object.defineProperty(wrap, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(wrap, 'clientHeight', { configurable: true, value: 300 })
    const tbl = document.createElement('table')
    const thead = document.createElement('thead')
    const hdrTr = document.createElement('tr')
    const cornerTh = document.createElement('th')
    hdrTr.appendChild(cornerTh)
    for (let c = 0; c < 3; c++) {
      const th = document.createElement('th')
      th.dataset.colIdx = String(c)
      th.textContent = `Col${c}`
      hdrTr.appendChild(th)
    }
    thead.appendChild(hdrTr)
    tbl.appendChild(thead)

    const tbody = document.createElement('tbody')
    const gridData: unknown[][] = [
      [10, '20', null],
      [30, 40.5, 'text'],
      [50, 'bad', 60],
    ]
    for (let r = 0; r < 3; r++) {
      const tr = document.createElement('tr')
      tr.dataset.rowIdx = String(r)
      const rnTd = document.createElement('td')
      rnTd.className = 'td-rownum'
      rnTd.dataset.rowIdx = String(r)
      rnTd.textContent = String(r + 1)
      tr.appendChild(rnTd)
      for (let c = 0; c < 3; c++) {
        const td = document.createElement('td')
        td.dataset.rowIdx = String(r)
        td.dataset.colIdx = String(c)
        td.textContent = String(gridData[r][c] ?? '')
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    tbl.appendChild(tbody)
    wrap.appendChild(tbl)
    document.body.appendChild(wrap)

    const events: string[] = []
    let ctrlClickHandle = true
    const sel = new PanelGridSelection({
      wrapEl: wrap,
      tableEl: tbl,
      editable: true,
      getDimensions: () => ({ rows: 3, cols: 3 }),
      getValueAt: (r: number, c: number) => gridData[r][c],
      onSelectionChange: () => events.push('chg'),
      onCopy: () => events.push('copy'),
      onPaste: (_s: unknown, txt: string) => {
        events.push(`paste:${txt}`)
        return true
      },
      onPasteNewRows: () => events.push('pasteNew'),
      onBulkDeleteRows: () => events.push('delRows'),
      onBulkSetNull: () => events.push('setNull'),
      onStartEdit: (r: number, c: number) => events.push(`edit:${r},${c}`),
      onContextMenu: (_e: unknown, info: { kind: string }) => events.push(`ctx:${info.kind}`),
      onCtrlClickCell: (r: number, c: number) => {
        events.push(`ctrl:${r},${c}`)
        return ctrlClickHandle
      },
      onEnsureCellVisible: (r: number, c: number) => events.push(`vis:${r},${c}`),
    })

    try {
      // Programmatic selection API + stats
      expect(sel.formatStatsText()).toBe('')
      sel.selectRowRange(0, 1)
      expect(sel.getSelectedRowIndices()).toEqual([0, 1])
      expect(sel.getSelectedColIndices()).toEqual([0, 1, 2])
      sel.selectCell(0, 0)
      sel.selectCell(1, 2, { shift: true })
      expect(sel.formatStatsText()).toContain('Sum: 100.5')
      expect(sel.getSelectedCoords(3)).toHaveLength(3)

      // Ctrl+cell subtract down to empty vs re-add
      ctrlClickHandle = false
      sel.selectCell(2, 2, { ctrl: true })
      sel.selectCell(2, 2, { ctrl: true }) // subtracts cell
      sel.selectCell(0, 0, { ctrl: true }) // toggle off another cell
      sel.clear(true)
      sel.selectCell(1, 1)
      sel.selectCell(1, 1, { ctrl: true }) // empties selection

      // Row & Column select + shift + ctrl subtract
      sel.selectRow(0)
      sel.selectRow(2, { shift: true })
      sel.selectRow(1, { ctrl: true })
      sel.selectRow(1, { ctrl: true })
      sel.clear()
      sel.selectRow(0)
      sel.selectRow(0, { ctrl: true }) // empties selection

      sel.selectCol(0)
      sel.selectCol(2, { shift: true })
      sel.selectCol(1, { ctrl: true })
      sel.selectCol(1, { ctrl: true })
      sel.clear()
      sel.selectCol(0)
      sel.selectCol(0, { ctrl: true }) // empties selection

      // Virtual row class helpers & detachRow
      sel.selectAll()
      const row1 = tbody.children[1] as HTMLElement
      sel.applyClassesToRow(row1, 1)
      sel.detachRow(row1)

      // Truncated > 50,000 cells branch in computeSummary
      const bigSel = new PanelGridSelection({
        wrapEl: document.createElement('div'),
        tableEl: document.createElement('table'),
        editable: false,
        getDimensions: () => ({ rows: 300, cols: 200 }),
        getValueAt: () => 1,
      })
      bigSel.selectAll()
      expect(bigSel.computeSummary()?.truncated).toBe(true)
      bigSel.destroy()

      // Mouse interaction: cell click, drag selection + RAF, row header drag, scrollbar guard, canvas clear
      const cell00 = tbl.querySelector('td[data-row-idx="0"][data-col-idx="0"]') as HTMLElement
      const cell12 = tbl.querySelector('td[data-row-idx="1"][data-col-idx="2"]') as HTMLElement
      const rn0 = tbl.querySelector('td.td-rownum[data-row-idx="0"]') as HTMLElement
      const rn2 = tbl.querySelector('td.td-rownum[data-row-idx="2"]') as HTMLElement
      const colTh1 = tbl.querySelector('th[data-col-idx="1"]') as HTMLElement

      cell00.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      cell12.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
      dom.runRaf()
      window.dispatchEvent(new Event('mouseup'))

      ctrlClickHandle = true
      cell00.dispatchEvent(new MouseEvent('mousedown', { button: 0, ctrlKey: true, bubbles: true }))

      rn0.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      rn2.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
      window.dispatchEvent(new Event('blur')) // endDrag applies pendingDragCoord synchronously!

      wrap.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true })) // clears on empty canvas

      // Context menus: header, rowNum, data cell, canvas
      colTh1.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
      rn0.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
      cell12.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
      wrap.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
      expect(events).toEqual(expect.arrayContaining(['ctx:header', 'ctx:cell', 'ctx:canvas']))

      // Keyboard navigation + actions + paste
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, shiftKey: true, bubbles: true }))
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }))
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }))
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

      const dt = new DataTransfer()
      dt.setData('text/plain', 'hello\tworld')
      const pasteEv = new ClipboardEvent('paste', {
        bubbles: true,
        clipboardData: dt,
      })
      wrap.dispatchEvent(pasteEv)
      expect(events).toContain('copy')
      expect(events).toContain('pasteNew')
      expect(events).toContain('edit:0,0')
      expect(events).toContain('setNull')
      expect(events).toContain('paste:hello\tworld')
    } finally {
      sel.destroy()
    }
  })
})
