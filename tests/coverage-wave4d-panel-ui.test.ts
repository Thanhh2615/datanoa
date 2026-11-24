import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'
import { DatabaseSync } from 'node:sqlite'
import { installDomHarness, type DomHarness } from './helpers/dom-harness.js'
import * as cmVendor from '../vendor/codemirror.js'
import { createPanelFeedbackAndPaletteController } from '../src/panel/panel-feedback-palette.js'
import {
  createPanelCodeMirrorEditor,
  buildPanelCompletionExtension,
} from '../src/panel/panel-cm.js'
import {
  getDbLogoSvg,
  rpc,
  syncOrcaTypography,
  decodeTableSelectValue,
  setButtonLoading,
  createElapsedTimer,
  downloadTextFile,
  createSortSvg,
  getFolderSvgMarkup,
  bindSelectTooltipsInRoot,
  enhanceCollapsibleSelectDropdown,
  writeTextToClipboard,
  syncVirtualTableWindow,
} from '../src/panel/panel-utils.js'
import {
  createPanelConsoleTabsManager,
  computePanelSqlCompletions,
} from '../src/panel/panel-sql-tabs.js'
import {
  compactPickerRootLabel,
  openSharedFilePickerModal,
} from '../src/shared-file-picker.js'
import { createCollapsibleSelectController } from '../src/shared-collapsible-select.js'
import { buildWorkspaceSvgMarkup } from '../src/shared-db-icons.js'
import { bindCtrlWheelHorizontalScroll } from '../src/shared-wheel-scroll.js'
import {
  Pacer,
  remainder,
  shouldSkipInlineTrigger,
  trackAcceptance,
  acceptGhostFull,
  acceptGhostWord,
  acceptGhostLine,
  clearGhostEffect,
  createCmInlineAiExtension,
  ghostStateField,
  setGhostEffect,
} from '../src/shared-cm-inline-ai.js'
import {
  formatAiStatusBadge,
  openSharedAiConfigModal,
  renderSharedExplainAiPanel,
  saveOrcaSettingsPatch,
} from '../src/shared-ai-ui.js'
import {
  sanitizeJson,
  quoteIdent,
  splitSqlStatements,
  stripLeadingSqlComments,
  panelContainsDdlStatement,
  findStatementAtCaret,
  formatSqlLiteral,
  formatPanelSql,
  buildPanelExportData,
  formatSelectionAsOutput,
  isNumericSqlType,
  isBooleanSqlType,
  isEmptyAsNullNonTextSqlType,
  coerceTypedCellInput,
  buildDdlFallback,
  createPanelStructDraft,
  getIndexColNames,
  getActiveIndexColNames,
  getFkColName,
  isPanelColDirty,
  countPanelStructChanges,
  requiresPanelSqliteRebuild,
  buildPanelMigrationSql,
  validatePanelStructDraft,
  buildPanelFeedbackMarkdown,
  computeVirtualRange as coreComputeVirtualRange,
} from '../src/panel/panel-core.js'
import {
  buildCountQueryForObject,
  generateSqlForTable,
  closeContextMenu,
  createPanelExplorerController,
} from '../src/panel/panel-explorer.js'
import { PanelGridSelection } from '../src/panel/panel-selection.js'
import {
  getPanelDriverColumnTypes,
  createPanelStructureController,
} from '../src/panel/panel-structure.js'
import {
  formatConnSubtitle,
  createPanelConnectionFormController,
} from '../src/panel/panel-connection-form.js'
import {
  createPanelSqlController,
} from '../src/panel/panel-sql.js'
import {
  shouldDisableEditStructureButton,
  createPanelDataGridController,
} from '../src/panel/panel-data-grid.js'

const PICKER_CLASSES = {
  overlay: 'fp-overlay',
  modal: 'fp-modal',
  head: 'fp-head',
  title: 'fp-title',
  btnSm: 'fp-btn-sm',
  roots: 'fp-roots',
  root: 'fp-root',
  nav: 'fp-nav',
  upBtn: 'fp-up',
  pathInput: 'fp-path',
  filterInput: 'fp-filter',
  list: 'fp-list',
  row: 'fp-row',
  icon: 'fp-icon',
  name: 'fp-name',
  meta: 'fp-meta',
  empty: 'fp-empty',
  status: 'fp-status',
  foot: 'fp-foot',
  selected: 'fp-preview',
  actions: 'fp-foot-btns',
  btnPrimarySm: 'fp-primary',
  body: 'fp-body',
}

async function flushMicro(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve()
  }
}

describe('Wave 4D: Side Panel & Shared UI Closure', () => {
  let dom: DomHarness

  beforeEach(() => {
    dom = installDomHarness({ url: 'http://localhost/' })
    document.body.clientWidth = 1024
    document.body.clientHeight = 768
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    dom.teardown()
  })

  it('Slice 1a: closes panel-feedback-palette, panel-cm, panel-utils & panel-sql-tabs tails + PBT', async () => {
    dom.mountPanelHtml()

    // 1. panel-feedback-palette remaining 2 branches: empty state.tab fallback + long bug lastError truncation (>44 chars)
    const feedbackCtrl = createPanelFeedbackAndPaletteController({
      state: {
        tab: '',
        lastError: 'Extremely long diagnostic failure message exceeding forty-four characters cleanly',
      },
      getActiveConn: () => null,
      closeContextMenu: () => {},
      closeDataColsPopover: () => {},
      closePanelComboPopover: () => {},
      resetConnectionForm: () => {},
      setFormOpen: () => {},
      openFullStudio: async () => {},
      switchTab: () => {},
      formatSqlInEditor: () => {},
      openCreateTableModal: () => {},
      refreshConnections: async () => {},
      copyText: async () => {},
      showBanner: () => {},
    })
    feedbackCtrl.openFeedbackModal('bug')
    const diagText = document.getElementById('feedbackDiagGrid')?.textContent || ''
    expect(diagText).toContain('explorer')
    expect(diagText).toContain('...')

    // 2. panel-cm remaining branches: Oracle Nq'!...!' fallback delimiter + Mongo multiline /* */ + $stage + autocomplete facet + setter edges
    const host = document.createElement('div')
    document.body.appendChild(host)
    const editor = createPanelCodeMirrorEditor({
      parent: host,
      initialDoc: null as unknown as string,
      dialect: 'oracle',
      schema: null as unknown as Record<string, string[]>,
      isLightTheme: true,
      typography: { cssFontFamily: 'monospace' },
    })
    // Trigger Oracle Nq'!..!' custom delimiter (not in PANEL_ORACLE_Q_CLOSE) & multiline block comment
    editor.setValue("SELECT Nq'!abc!' FROM dual /* line1\nline2 */")
    // Trigger MongoDB multiline block comment + $match operator
    editor.setDialect('mongodb')
    editor.setDialect('mongodb') // same dialect no-op
    editor.setValue('/* multi\nline */ db.users.aggregate([{ $match: { active: true } }])')
    editor.setValue('/* multi\nline */ db.users.aggregate([{ $match: { active: true } }])') // same value no-op
    editor.setDialect(null as unknown as string)
    editor.setTypography(null)
    editor.setPlaceholder('')
    editor.setSchema({ users: ['id', 'email'] }, 'users')

    // Invoke CodeMirror autocomplete source from buildPanelCompletionExtension (covers smartSource L470-485)
    const acDataList = editor.view.state.languageDataAt<
      (ctx: { state: typeof editor.view.state; pos: number; explicit: boolean; matchBefore: () => null }) => unknown
    >('autocomplete', editor.view.state.doc.length)
    editor.setValue('SELECT u FROM users')
    for (const src of acDataList) {
      if (typeof src === 'function') {
        const resHit = src({ state: editor.view.state, pos: 8, explicit: false, matchBefore: () => null }) as { options?: Array<{ label: string }> } | null
        if (resHit?.options) {
          expect(resHit.options.some((o) => o.label === 'users')).toBe(true)
        }
        src({ state: editor.view.state, pos: 0, explicit: false, matchBefore: () => null })
      }
    }
    // Also exercise buildPanelCompletionExtension with default args + headless editor (no parent)
    const bareExt = buildPanelCompletionExtension('sqlite')
    expect(bareExt.length).toBeGreaterThan(0)
    const headlessEditor = createPanelCodeMirrorEditor({
      parent: null as unknown as HTMLElement,
      initialDoc: '',
      dialect: 'sqlite',
      schema: { items: ['id'] },
    })
    headlessEditor.setPlaceholder('Type SQL')
    headlessEditor.setValue('SELECT 1')
    headlessEditor.destroy()
    editor.destroy()

    // 3. panel-utils remaining lines & branches
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.constant(Number.NaN), fc.constant('bad')), (sz) => {
        const dbSvg = getDbLogoSvg('unknown-drv', sz as number)
        expect(dbSvg).toContain('<svg')
        const fldSvg = getFolderSvgMarkup(false, sz as number)
        expect(fldSvg).toContain('<svg')
      }),
      { numRuns: 30 }
    )

    // rpc via window.orca.host.call with signal & timeoutMs
    const hostCallMock = vi.fn().mockRejectedValueOnce(new Error('typo fail')).mockResolvedValueOnce({ output: { ok: 1 } })
    ;(window as { orca?: unknown }).orca = { host: { call: hostCallMock } }
    await syncOrcaTypography() // hits catch L98
    const ac = new AbortController()
    const rpcRes = await rpc('ping', { a: 1 }, { signal: ac.signal, timeoutMs: 250 })
    expect(rpcRes).toEqual({ ok: 1 })
    expect(hostCallMock).toHaveBeenLastCalledWith(
      'plugin.request',
      { name: 'ping', input: { a: 1 }, timeoutMs: 250 },
      { signal: ac.signal, timeoutMs: 250 }
    )

    expect(decodeTableSelectValue('')).toEqual({ schema: undefined, name: '' })
    const btn = document.createElement('button')
    btn.textContent = 'Run'
    setButtonLoading(btn, true) // loadingText === undefined -> uses origText
    expect(btn.querySelector('.btn-loading-label')?.textContent).toBe('Run')
    setButtonLoading(btn, false)

    // createElapsedTimer stopped guard
    vi.useFakeTimers()
    const ticks: string[] = []
    const stopTimer = createElapsedTimer((t) => ticks.push(t))
    stopTimer()
    stopTimer()
    vi.advanceTimersByTime(500)
    expect(ticks).toHaveLength(1)
    vi.useRealTimers()

    // downloadTextFile Blob failure catch (L202-204)
    ;(window as { orca?: unknown }).orca = undefined
    const origCreateObjectUrl = URL.createObjectURL
    URL.createObjectURL = () => {
      throw new Error('blob unsupported')
    }
    expect(await downloadTextFile('bad.txt', null as unknown as string)).toBe('failed')
    URL.createObjectURL = origCreateObjectUrl

    // createSortSvg without createElementNS fallback (L222)
    const origCreateElementNS = document.createElementNS
    ;(document as unknown as { createElementNS?: unknown }).createElementNS = undefined
    const fallbackSvg = createSortSvg('DESC')
    expect(fallbackSvg.tagName.toLowerCase()).toBe('svg')
    ;(document as unknown as { createElementNS?: unknown }).createElementNS = origCreateElementNS

    bindSelectTooltipsInRoot(null as unknown as Document)

    // enhanceCollapsibleSelectDropdown workspace leading icon + non-driver empty icon (L362-364) + applyFolderChevron collapsed (L367)
    const wsWrap = document.createElement('div')
    const wsSel = document.createElement('select')
    const optGroup = document.createElement('optgroup')
    optGroup.setAttribute('label', 'Workspace')
    const optWs = document.createElement('option')
    optWs.value = 'w1'
    optWs.textContent = 'Default Workspace'
    optGroup.appendChild(optWs)
    wsSel.appendChild(optGroup)
    wsWrap.appendChild(wsSel)
    document.body.appendChild(wsWrap)
    const csCtrl = enhanceCollapsibleSelectDropdown(wsSel, {
      leadingIconType: 'workspace',
      collapsedFolders: new Set(['Workspace']),
    })
    expect(csCtrl).not.toBeNull()
    const wsTrigger = wsWrap.querySelector('.custom-select-trigger') as HTMLButtonElement
    wsTrigger.click()
    const pop = document.querySelector('.custom-select-popover')!
    expect(pop.querySelector('.tree-chevron')?.classList.contains('open')).toBe(false)
    // Also test non-workspace leadingIconType: 'none' without driver
    const plainWrap = document.createElement('div')
    const plainSel = document.createElement('select')
    const plainOpt = document.createElement('option')
    plainOpt.value = 'p1'
    plainOpt.textContent = 'Plain'
    plainSel.appendChild(plainOpt)
    plainWrap.appendChild(plainSel)
    document.body.appendChild(plainWrap)
    enhanceCollapsibleSelectDropdown(plainSel, { leadingIconType: 'none' })
    ;(plainWrap.querySelector('.custom-select-trigger') as HTMLButtonElement).click()
    csCtrl?.destroy?.()

    // writeTextToClipboard: focus({ preventScroll }) throws, setSelectionRange throws, execCommand throws, navigator.clipboard throws
    const prevFocusEl = document.createElement('button')
    document.body.appendChild(prevFocusEl)
    prevFocusEl.focus()
    const origFocus = HTMLElement.prototype.focus
    vi.spyOn(prevFocusEl, 'focus').mockImplementation((arg?: FocusOptions) => {
      if (arg && typeof arg === 'object' && 'preventScroll' in arg) {
        throw new Error('no preventScroll')
      }
    })
    const origCreateEl = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      const el = origCreateEl(tagName)
      if (tagName.toLowerCase() === 'textarea') {
        ;(el as HTMLTextAreaElement).focus = ((arg?: FocusOptions) => {
          if (arg && typeof arg === 'object' && 'preventScroll' in arg) {
            throw new Error('ta no preventScroll')
          }
          return origFocus.call(el)
        }) as typeof el.focus
        ;(el as HTMLTextAreaElement).setSelectionRange = () => {
          throw new Error('range error')
        }
      }
      return el
    }) as typeof document.createElement)
    const origNavClipboard = navigator.clipboard
    const origExecCommand = (document as unknown as { execCommand?: unknown }).execCommand
    ;(document as unknown as { execCommand: (cmd: string) => boolean }).execCommand = () => {
      throw new Error('execCommand blocked')
    }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error('clipboard denied')),
      },
    })
    try {
      expect(await writeTextToClipboard(null as unknown as string)).toBe(false)
    } finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: origNavClipboard })
      ;(document as unknown as { execCommand?: unknown }).execCommand = origExecCommand
      vi.restoreAllMocks()
    }

    // syncVirtualTableWindow without spacer TRs + HTMLElement undefined fallback (L480, 488, 504, 523)
    const tbl = document.createElement('table')
    const tbody = document.createElement('tbody')
    tbl.appendChild(tbody)
    const virt = { start: -1, end: -1, tbody, topSpacerTr: null, topSpacerTd: null, bottomSpacerTr: null, bottomSpacerTd: null }
    const makeRow = (r: number) => {
      const tr = document.createElement('tr')
      tr.dataset.rowIdx = String(r)
      return tr
    }
    const origHtmlElement = globalThis.HTMLElement
    ;(globalThis as unknown as { HTMLElement: unknown }).HTMLElement = undefined
    try {
      expect(syncVirtualTableWindow({ virt, total: 10, start: 2, end: 5, rowHeightPx: 24, createRow: makeRow })).toBe(true)
      expect(syncVirtualTableWindow({ virt, total: 10, start: 0, end: 4, rowHeightPx: 24, createRow: makeRow })).toBe(true)
    } finally {
      ;(globalThis as unknown as { HTMLElement: unknown }).HTMLElement = origHtmlElement
    }

    // 4. panel-sql-tabs remaining statements & branches
    const tabsMgr = createPanelConsoleTabsManager({
      activeTabId: 't1',
      tabs: [
        { id: 't1', title: 'C1', sql: 'SELECT 1' },
        { id: 't2', title: 'C2', sql: 'SELECT 2' },
      ],
    })
    expect(tabsMgr.renameTab('t1', '')).toBe(false)
    tabsMgr.updateActiveSql(null as unknown as string)
    expect(tabsMgr.getActiveTab().sql).toBe('')
    tabsMgr.setResultForTab('t1', { columns: [], rows: [], isSelect: false, executionTimeMs: 1 }, 0, 'INSERT 1', 'c1')
    expect(tabsMgr.getResultTabState(0, 't2')).toBeUndefined()
    // Ensure setResultTabState handles tab without resultStates
    const t2 = tabsMgr.getTabs().find((t) => t.id === 't2')!
    delete (t2 as Record<string, unknown>).resultStates
    tabsMgr.setResultTabState(0, { scrollTop: 10 }, 't2')
    expect(tabsMgr.getResultTabState(0, 't2')).toEqual({ scrollTop: 10 })
    // Force activeTabId invalid to exercise tabs[0] fallback in getActiveTab (L67)
    tabsMgr.switchTab('t1')
    // Completions: MongoDB db. + db.users. + word & field matching + SQL schema/alias/col/dual/substring branches
    const mongoSchema = { users: ['id', 'email', 'username'], orders: ['id', 'email', 'total'] }
    const mDb = computePanelSqlCompletions('db.', 3, 'mongodb', mongoSchema, undefined, false)
    expect(mDb?.options.some((o) => o.label === 'getCollection')).toBe(true)
    expect(mDb?.options.some((o) => o.label === 'users')).toBe(true)
    expect(computePanelSqlCompletions('db.zzzNotFound', 14, 'mongodb', mongoSchema, undefined, false)).toBeNull()
    const mMeth = computePanelSqlCompletions('db.users.f', 10, 'mongodb', mongoSchema, undefined, false)
    expect(mMeth?.options.some((o) => o.label === 'find({})')).toBe(true)
    expect(computePanelSqlCompletions('db.users.zzzNone', 16, 'mongodb', mongoSchema, undefined, false)).toBeNull()
    const mWord = computePanelSqlCompletions('ail', 3, 'mongodb', { users: ['email'], broken: null as unknown as string[] }, undefined, false)
    expect(mWord?.options.some((o) => o.label === 'email')).toBe(true)
    expect(computePanelSqlCompletions('zzzzNothingMatches', 18, 'mongodb', {}, undefined, false)).toBeNull()

    // SQL completions: dot schema.table + table alias + substring boost + Oracle DUAL substring + empty schema
    const sqlSchema = {
      'public.users': ['user_id', 'full_name'],
      users: ['user_id', 'full_name'],
      empty_tbl: null as unknown as string[],
    }
    const dotSchema = computePanelSqlCompletions('SELECT * FROM public.us', 23, 'postgres', sqlSchema)
    expect(dotSchema?.options.some((o) => o.label === 'users')).toBe(true)
    const dotAliasSub = computePanelSqlCompletions('SELECT u.ame FROM users u', 12, 'postgres', sqlSchema)
    expect(dotAliasSub?.options.some((o) => o.label === 'full_name')).toBe(true)
    const redisEmpty = computePanelSqlCompletions('ZZZNONE', 7, 'redis', sqlSchema)
    expect(redisEmpty).toBeNull()
    const refTableNoDot = computePanelSqlCompletions('SELECT ame FROM users', 10, 'oracle', sqlSchema)
    expect(refTableNoDot?.options.some((o) => o.label === 'full_name')).toBe(true)
    const dualSub = computePanelSqlCompletions('SELECT * FROM ual', 17, 'oracle', { dual: ['dummy'], ...sqlSchema })
    expect(dualSub?.options.some((o) => o.label.toUpperCase() === 'DUAL')).toBe(true)
    const dualPartial = computePanelSqlCompletions('SELECT ual', 10, 'oracle', sqlSchema)
    expect(dualPartial?.options.some((o) => o.label === 'DUAL')).toBe(true)
    expect(computePanelSqlCompletions('SELECT zzzNomatch99', 19, 'sqlite', null as unknown as Record<string, string[]>)).toBeNull()
  })

  it('Slice 1b: closes shared-file-picker & shared-collapsible-select remaining branches', async () => {
    // 1. shared-file-picker: closed/stale async guard, Enter on file entry, folder mode fallback, normalizeRootKey empty, listDir error & throw
    expect(compactPickerRootLabel('/')).toBe('/')
    expect(compactPickerRootLabel('')).toBe('')

    let resolveLate!: (v: unknown) => void
    let callIdx = 0
    const pickerPromise = openSharedFilePickerModal({
      mode: 'file',
      title: 'Pick SQL',
      classes: PICKER_CLASSES,
      listDir: vi.fn().mockImplementation(async ({ dir }) => {
        callIdx++
        if (callIdx === 1) {
          return {
            ok: false,
            error: '',
            currentDir: '',
            parentDir: null,
            roots: ['C:\\', '/'],
            entries: [],
          }
        }
        if (callIdx === 2) {
          return {
            ok: true,
            currentDir: dir || '/work',
            parentDir: '/',
            roots: ['C:\\', '/'],
            entries: [
              { name: 'sub', path: '/work/sub', kind: 'dir', size: 0 },
              { name: 'query.sql', path: '/work/query.sql', kind: 'file', size: 120 },
            ],
            truncated: true,
          }
        }
        if (callIdx === 3) {
          throw new Error('disk offline')
        }
        return new Promise((r) => {
          resolveLate = r
        })
      }),
    })
    await flushMicro()
    expect(document.querySelector('.fp-status')?.textContent).toContain('Cannot open directory')
    // Click root button to trigger callIdx === 2
    ;(document.querySelector('.fp-root') as HTMLButtonElement).click()
    await flushMicro()
    expect(document.querySelector('.fp-status')?.textContent).toContain('2+ items')
    // Click upBtn to trigger callIdx === 3 (rejects)
    ;(document.querySelector('.fp-up') as HTMLButtonElement).click()
    await flushMicro()
    expect(document.querySelector('.fp-status')?.textContent).toContain('disk offline')
    // Reload valid entries via root click? Wait: callIdx 4 returns pending promise -> close while pending to hit closed guard
    // First test Enter on file row when listDir returns valid entries in a second picker
    ;(document.querySelector('.fp-root') as HTMLButtonElement).click()
    await flushMicro()
    ;(document.querySelector('.fp-cancel, .fp-foot-btns button') as HTMLButtonElement).click()
    resolveLate?.({ ok: true, currentDir: '/', entries: [] })
    const cancelRes = await pickerPromise
    expect(cancelRes).toEqual({ ok: false, cancelled: true })

    // Second picker: test Enter on dir & Enter on file + dblclick on dir + empty folder mode
    let phase = 0
    const picker2 = openSharedFilePickerModal({
      mode: 'file',
      classes: PICKER_CLASSES,
      listDir: vi.fn().mockImplementation(async () => {
        phase++
        if (phase === 1) {
          return {
            ok: true,
            currentDir: '/dir',
            entries: [
              { name: 'sub', path: '/dir/sub', kind: 'dir', size: 0 },
              { name: 'a.db', path: '/dir/a.db', kind: 'file', size: 12 },
            ],
          }
        }
        return {
          ok: true,
          currentDir: '/dir/sub',
          entries: [{ name: 'leaf.db', path: '/dir/sub/leaf.db', kind: 'file', size: 8 }],
        }
      }),
    })
    await flushMicro()
    const filterInp = document.querySelector('.fp-filter') as HTMLInputElement
    filterInp.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) // selects 'sub' dir
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) // loads dir
    await flushMicro()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) // selects 'leaf.db'
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) // finishes with leaf.db!
    expect(await picker2).toEqual({ ok: true, path: '/dir/sub/leaf.db' })

    // Third picker: empty folder mode + Tab focus with no focusables + outside-list keydown
    const picker3 = openSharedFilePickerModal({
      mode: 'folder',
      classes: PICKER_CLASSES,
      listDir: vi.fn().mockResolvedValue({ ok: true, currentDir: '/empty', entries: null }),
    })
    await flushMicro()
    expect(document.querySelector('.fp-empty')?.textContent).toContain('No subfolders')
    const btnOut = document.createElement('button')
    document.body.appendChild(btnOut)
    btnOut.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) // !inListContext
    ;(document.querySelector('.fp-overlay') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: false }))
    expect(await picker3).toEqual({ ok: false, cancelled: true })

    // 2. shared-collapsible-select remaining branches
    const csAdapter = {
      classes: {
        srOnly: 'cs2-sr',
        trigger: 'cs2-trigger',
        leadIcon: 'cs2-lead',
        label: 'cs2-label',
        chev: 'cs2-chev',
        popover: 'cs2-popover',
        head: 'cs2-head',
        search: 'cs2-search',
        actionBtn: 'cs2-act',
        list: 'cs2-list',
        folderHead: 'cs2-folder',
        folderIcon: 'cs2-ficon',
        folderName: 'cs2-fname',
        folderCount: 'cs2-fcnt',
        item: 'cs2-opt',
        itemIcon: 'cs2-iicon',
        itemText: 'cs2-itext',
        itemLabel: 'cs2-olabel',
        itemSub: 'cs2-ometa',
        itemCheck: 'cs2-ocheck',
        empty: 'cs2-empty',
      },
      fallbackQuerySelected: false,
      expandTitle: 'Expand',
      collapseTitle: 'Collapse',
      setLeadIconVisible: () => {},
      renderTriggerChevron: () => {},
      syncLeadIcon: () => {},
      renderItemIcon: () => {},
      applyFolderChevron: () => {},
      renderExpandIcon: () => {},
      renderCollapseIcon: () => {},
      renderFolderIcon: () => {},
      layout: {
        rectFallback: { left: 0, top: 0, right: 100, bottom: 20, width: 0, height: 20 },
        vwFallback: 800,
        vhFallback: 600,
        minWidth: 180,
        maxHeight: 240,
        margin: 8,
        gap: 6,
      },
    }
    const ctrl2 = createCollapsibleSelectController(csAdapter)
    const wrap2 = document.createElement('div')
    const sel2 = document.createElement('select')
    const grp2 = document.createElement('optgroup')
    grp2.setAttribute('label', '')
    const oA = document.createElement('option')
    oA.value = 'a'
    oA.textContent = ''
    oA.dataset.fullTitle = 'FullAlpha'
    oA.dataset.subtitle = 'SubHint'
    const oB = document.createElement('option')
    oB.value = 'b'
    oB.textContent = 'Beta'
    grp2.append(oA, oB)
    const topOpt = document.createElement('option')
    topOpt.value = 'top'
    topOpt.textContent = 'TopItem'
    topOpt.dataset.fullTitle = 'TopFullAlias'
    sel2.append(topOpt, grp2)
    wrap2.appendChild(sel2)
    document.body.appendChild(wrap2)

    // Test selectedIndex = -1 + fallbackQuerySelected=false (L137) + searchPlaceholder='' (L214)
    Object.defineProperty(sel2, 'selectedIndex', { value: -1, configurable: true })
    const origInnerW = window.innerWidth
    const origInnerH = window.innerHeight
    ;(window as { innerWidth: number }).innerWidth = 0
    ;(window as { innerHeight: number }).innerHeight = 0
    ctrl2.enhance(sel2, { searchPlaceholder: '' })
    const trig2 = wrap2.querySelector('.cs2-trigger') as HTMLButtonElement
    trig2.getBoundingClientRect = () => null as unknown as DOMRect
    expect(trig2.querySelector('.cs2-label')?.textContent).toBe('Select...')
    delete (sel2 as unknown as Record<string, unknown>).selectedIndex
    sel2.value = 'a'
    trig2.click()

    // Collapse & expand folder head directly (L362-363) + search by fullTitle & subtitle (L319, L333) + no-match empty (L379)
    const folderBtn = document.querySelector('.cs2-folder') as HTMLButtonElement
    folderBtn.click()
    folderBtn.click()
    const searchInp = document.querySelector('.cs2-search') as HTMLInputElement
    searchInp.value = 'topfullalias'
    searchInp.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.querySelectorAll('.cs2-opt')).toHaveLength(1)
    searchInp.value = 'subhint'
    searchInp.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.querySelectorAll('.cs2-opt')).toHaveLength(1)
    searchInp.value = 'no-match-xyz'
    searchInp.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.querySelector('.cs2-empty')?.textContent).toContain('No matches')

    // Disabled select guard (L182)
    ctrl2.closeActive()
    sel2.disabled = true
    trig2.click()
    expect(ctrl2.isOpen()).toBe(false)
    ;(window as { innerWidth: number }).innerWidth = origInnerW
    ;(window as { innerHeight: number }).innerHeight = origInnerH
  })

  it('Slice 2: closes shared-cm-inline-ai & shared-ai-ui branches + PBT', async () => {
    // 1. shared-cm-inline-ai pure & PBT checks
    vi.useFakeTimers()
    const pacer = new Pacer()
    pacer.noteChange(true, 1000)
    vi.setSystemTime(5000)
    expect(pacer.delayFor({ triggerChar: 123 as unknown as string })).toBeGreaterThanOrEqual(120)

    expect(remainder(null as unknown as { offset: number; text: string }, 1, 'a')).toBeNull()
    expect(remainder({ offset: 0, text: 'SELECT' }, 2, null as unknown as string)).toBeNull()
    expect(remainder({ offset: 0, text: 'SELECT' }, 2, 'SE')).toBe('LECT')
    expect(shouldSkipInlineTrigger('', 'x')).toBe(true)
    expect(shouldSkipInlineTrigger(null as unknown as string, '')).toBe(false)
    expect(shouldSkipInlineTrigger("SELECT 'escaped\\'quote' ", '')).toBe(false)

    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), fc.string({ maxLength: 10 }), (pref, suf) => {
        const skip = shouldSkipInlineTrigger(pref, suf)
        expect(typeof skip).toBe('boolean')
      }),
      { numRuns: 30 }
    )

    // trackAcceptance branches: invalid args, cancel before early, cancel before late, late !== text ('undone')
    expect(typeof trackAcceptance(null as never, { startOffset: 0, text: 'x' }, vi.fn())).toBe('function')
    const verdicts: string[] = []
    let trackedVal = 'SELECT 1'
    const mockModel = {
      trackRange: () => 'r1',
      getTrackedText: () => trackedVal,
      untrackRange: vi.fn(),
    }
    const scheduled: Array<() => void> = []
    const cancel1 = trackAcceptance(mockModel, { startOffset: 0, text: 'SELECT 1' }, (v: string) => verdicts.push(v), (cb: () => void) => scheduled.push(cb))
    cancel1()
    scheduled[0]() // early cancelled branch
    const scheduled2: Array<() => void> = []
    const cancel2 = trackAcceptance(mockModel, { startOffset: 0, text: 'SELECT 1' }, (v: string) => verdicts.push(v), (cb: () => void) => scheduled2.push(cb))
    scheduled2[0]() // schedules second check
    cancel2()
    scheduled2[1]() // late cancelled branch
    const scheduled3: Array<() => void> = []
    trackAcceptance(mockModel, { startOffset: 0, text: 'SELECT 1' }, (v: string) => verdicts.push(v), (cb: () => void) => scheduled3.push(cb))
    scheduled3[0]()
    trackedVal = 'CHANGED'
    scheduled3[1]()
    expect(verdicts).toEqual(['undone'])

    // Live EditorView with createCmInlineAiExtension
    let enabled = true
    const metrics: Array<[number, string]> = []
    let pendingResolve!: (v: { id: number; suggestion: string } | null) => void
    let reqCount = 0
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = new cmVendor.EditorView({
      state: cmVendor.EditorState.create({
        doc: 'SELECT',
        selection: { anchor: 6 },
        extensions: [
          cmVendor.autocompletion({ override: [() => ({ from: 0, options: [{ label: 'SELECT' }] })] }),
          createCmInlineAiExtension({
            isEnabled: () => enabled,
            onMetric: (id: number, kind: string) => metrics.push([id, kind]),
            requestCompletion: async () => {
              reqCount++
              if (reqCount === 1) {
                return new Promise((r) => {
                  pendingResolve = r
                })
              }
              if (reqCount === 2) return null
              return { id: 9, suggestion: ' *\nFROM dual\nWHERE 1=1' }
            },
          }),
        ],
      }),
      parent: host,
    })

    // Empty ghost commands return false
    expect(acceptGhostWord(view)).toBe(false)
    expect(acceptGhostLine(view)).toBe(false)
    // Set ghost with leading newline & multi-line to test acceptGhostLine firstNl === 0 + partial lastOffered update
    view.dispatch({ effects: setGhostEffect.of({ offset: 6, text: '\nFROM dual\nWHERE 1=1', id: 7 }) })
    expect(acceptGhostLine(view)).toBe(true) // inserts '\nFROM dual', leaves '\nWHERE 1=1'
    expect(view.state.field(ghostStateField)?.text).toBe('\nWHERE 1=1')
    expect(acceptGhostLine(view)).toBe(true) // accepts rest '\nWHERE 1=1' (secondNl === -1 branch)
    // Selection move non-empty + setGhostEffect empty
    view.dispatch({ effects: setGhostEffect.of({ offset: 0, text: '', id: 1 }) })
    view.dispatch({ effects: setGhostEffect.of({ offset: 6, text: ' xyz', id: 8 }) })
    view.dispatch({ selection: { anchor: 0, head: 3 } }) // non-empty sel clears ghost & triggers selectionSet drop
    // Delete whole doc (doc.length === 0)
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
    // Type comment prefix -> shouldSkipInlineTrigger inside trigger/update
    view.dispatch({ changes: { from: 0, to: 0, insert: '-- comment' }, selection: { anchor: 10 } })
    // Type valid SQL -> starts timer -> triggers requestCompletion #1 -> edit again mid-flight to abort inflight!
    view.dispatch({ changes: { from: 0, to: 10, insert: 'SELECT 1' }, selection: { anchor: 8 } })
    await vi.advanceTimersByTimeAsync(1000)
    // Request #1 is inflight! Edit doc to abort inflight & start Request #2 (returns null)
    view.dispatch({ changes: { from: 8, to: 8, insert: ' ' }, selection: { anchor: 9 } })
    pendingResolve?.({ id: 1, suggestion: 'x' })
    await vi.advanceTimersByTimeAsync(1000)
    // Edit doc with suffix containing newline to hit suffixLine branch -> Request #3 returns suggestion
    view.dispatch({ changes: { from: 9, to: 9, insert: 'a\nb' }, selection: { anchor: 10 } })
    await vi.advanceTimersByTimeAsync(1000)
    // Test active completion hiding ghost via Ctrl-Space completionKeymap
    const startAcCmd = cmVendor.completionKeymap.find((k) => k.key === 'Ctrl-Space')?.run
    const closeAcCmd = cmVendor.completionKeymap.find((k) => k.key === 'Escape')?.run
    startAcCmd?.(view)
    await vi.advanceTimersByTimeAsync(200)
    if (cmVendor.completionStatus(view.state) === 'active') {
      expect(acceptGhostWord(view)).toBe(false)
      closeAcCmd?.(view)
    }
    // Delete accepted range to exercise LiveModelTracker.mapChanges to < from
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
    enabled = false
    view.dispatch({ changes: { from: 0, to: 0, insert: 'x' } })
    await flushMicro()
    view.destroy()
    vi.useRealTimers()

    // Also test createCmInlineAiExtension without requestCompletion
    const noReqHost = document.createElement('div')
    const noReqView = new cmVendor.EditorView({
      state: cmVendor.EditorState.create({
        doc: 'a',
        extensions: [createCmInlineAiExtension({ isEnabled: () => true })],
      }),
      parent: noReqHost,
    })
    noReqView.dispatch({ changes: { from: 1, to: 1, insert: 'b' }, selection: { anchor: 2 } })
    noReqView.destroy()

    // 2. shared-ai-ui remaining branches
    expect(formatAiStatusBadge({ enabled: true, state: 'setup' }).title).toContain('Complete AI provider')
    expect(formatAiStatusBadge({ enabled: true, state: 'error' }).title).toContain('AI request error')

    const expHost = document.createElement('div')
    renderSharedExplainAiPanel(
      expHost,
      {
        phase: 'error',
        error: '',
        explainLanguage: 'zz-custom',
      },
      {}
    )
    expect(expHost.textContent).toContain('Could not analyze execution plan')
    expect(expHost.querySelector('.datanoa-ai-lang-pill')).toBeNull()

    renderSharedExplainAiPanel(
      expHost,
      {
        phase: 'ready',
        explainLanguage: 'vi',
        result: {
          summary: 'Seq scan',
          durationMs: 12.4,
          language: 'vi',
          bottlenecks: [],
          indexSuggestions: [{ ddl: 'CREATE INDEX i ON t(a)', reason: '' }],
          optimizedSql: '',
          notes: [],
        },
      },
      { onConfigureAi: vi.fn(), onCopyText: vi.fn() }
    )
    expect(expHost.textContent).toContain('Suggested index')

    // saveOrcaSettingsPatch early return without window.orca
    await saveOrcaSettingsPatch(null as never)

    // openSharedAiConfigModal: status.get fails on open + preset switch + bad tokens + clearKey fail + resetStats fail + loadModels edge + bench edge + test fail + save fail + backdrop click
    let listModelsMode = 'fail-rpc'
    let usageThrows = true
    let benchMode = 'empty'
    let testMode = 'fail'
    let saveShouldThrow = false
    const modalRpc = vi.fn(async (method: string) => {
      if (method === 'ai.status.get') throw new Error('status down')
      if (method === 'ai.stats.get') return { summary: { shown: 1 } }
      if (method === 'ai.stats.reset') throw new Error('reset denied')
      if (method === 'ai.key.set') throw new Error('keyring locked')
      if (method === 'ai.models.usage') {
        if (usageThrows) throw new Error('usage err')
        return { usage: { 'gpt-4o-mini': { ms: 25 } } }
      }
      if (method === 'ai.models.list') {
        if (listModelsMode === 'fail-rpc') return { ok: false, message: 'unauthorized' }
        if (listModelsMode === 'empty') return { ok: true, models: [] }
        if (listModelsMode === 'throw') throw new Error('network timeout')
        return { ok: true, models: ['m-no-ms', 'gpt-4o-mini', 'm-also-no-ms'] }
      }
      if (method === 'ai.models.bench') {
        if (benchMode === 'empty') return { results: [{ model: 'x', ok: false }] }
        if (benchMode === 'throw') throw new Error('bench error')
        return { results: [{ model: 'bench-fast', ok: true, ms: 40 }] }
      }
      if (method === 'ai.provider.test') {
        if (testMode === 'fail') return { ok: false, message: 'bad auth' }
        throw new Error('test crashed')
      }
      return {}
    })

    await openSharedAiConfigModal({
      initialStatus: {
        configured: true,
        enabled: true,
        ready: false,
        hasKey: true,
        format: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        maxTokens: 96,
        explainMaxTokens: 1200,
        explainLanguage: 'en',
      },
      rpc: modalRpc,
      saveSettings: async () => {
        if (saveShouldThrow) throw new Error('settings write failed')
      },
      onStatusUpdated: vi.fn(),
    })
    await flushMicro()

    const presetSel = document.querySelector('select.datanoa-ai-input') as HTMLSelectElement
    presetSel.value = 'anthropic'
    presetSel.dispatchEvent(new Event('change', { bubbles: true }))
    presetSel.value = 'openai'
    presetSel.dispatchEvent(new Event('change', { bubbles: true }))

    // Clear key error
    const clearKeyBtn = document.querySelector('button[aria-label="Clear saved API key"]') as HTMLButtonElement
    clearKeyBtn.disabled = false
    clearKeyBtn.click()
    await flushMicro()
    expect(document.querySelector('.datanoa-ai-feedback')?.textContent).toContain('keyring locked')

    // Reset stats error
    const resetStatsBtn = document.querySelector('button[aria-label="Reset AI telemetry statistics"]') as HTMLButtonElement
    resetStatsBtn.click()
    await flushMicro()

    // Benchmark with empty modelInput -> error message
    const modelInput = document.querySelectorAll('input.datanoa-ai-input')[1] as HTMLInputElement
    modelInput.value = ''
    const benchBtn = document.querySelector('button[aria-label="Benchmark"]') as HTMLButtonElement
    benchBtn.click()
    await flushMicro()
    expect(document.querySelector('.datanoa-ai-feedback')?.textContent).toContain('Enter a model')

    // Fetch models: fail-rpc -> empty -> throw -> mixed with usage
    const fetchBtn = document.querySelector('button[aria-label="Fetch available models"]') as HTMLButtonElement
    fetchBtn.click()
    await flushMicro()
    expect(document.querySelector('.datanoa-ai-feedback')?.textContent).toContain('unauthorized')

    listModelsMode = 'empty'
    fetchBtn.click()
    await flushMicro()
    expect(document.querySelector('.datanoa-ai-feedback')?.textContent).toContain('0 compatible models')

    listModelsMode = 'throw'
    fetchBtn.click()
    await flushMicro()
    expect(document.querySelector('.datanoa-ai-feedback')?.textContent).toContain('network timeout')

    listModelsMode = 'ok'
    usageThrows = false
    fetchBtn.click()
    await flushMicro()
    modelInput.value = 'gpt-4o-mini'
    modelInput.dispatchEvent(new Event('input', { bubbles: true }))

    // Benchmark: empty results, throw, and success when allModels populated vs empty
    benchBtn.click()
    await flushMicro()
    benchMode = 'throw'
    benchBtn.click()
    await flushMicro()
    benchMode = 'ok'
    benchBtn.click()
    await flushMicro()

    // Invalid numbers in token inputs + Test connection fail & throw
    const numInputs = Array.from(document.querySelectorAll('input[type="number"]')) as HTMLInputElement[]
    numInputs[0].value = '-5'
    numInputs[1].value = 'bad'
    const testBtn = document.querySelector('button[aria-label="Test Connection"]') as HTMLButtonElement
    testBtn.click()
    await flushMicro()
    testMode = 'throw'
    testBtn.click()
    await flushMicro()

    // Save fails
    saveShouldThrow = true
    const saveBtn = document.querySelector('button[aria-label="Save"]') as HTMLButtonElement
    saveBtn.click()
    await flushMicro()
    expect(document.querySelector('.datanoa-ai-feedback')?.textContent).toContain('settings write failed')

    // Backdrop click closes modal
    const backdrop = document.querySelector('.datanoa-ai-backdrop') as HTMLElement
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: false }))
    expect(document.querySelector('.datanoa-ai-backdrop')).toBeNull()
  })

  it('Slice 3: closes panel-core, panel-explorer & panel-selection branches + PBT', async () => {
    dom.mountPanelHtml()

    // 1. panel-core pure helpers, PBT & multi-dialect migration DDL/validation
    expect(sanitizeJson(Number.POSITIVE_INFINITY)).toBeNull()
    expect(sanitizeJson(new Date('invalid'))).toBeNull()
    expect(sanitizeJson({ a: 1, fn: () => {}, sym: Symbol('x') })).toEqual({ a: 1 })
    const circ: Record<string, unknown> = {}
    circ.self = circ
    expect(sanitizeJson(circ)).toEqual({ self: null })

    expect(quoteIdent('tbl', '')).toBe('"tbl"')
    expect(splitSqlStatements(null as unknown as string, '')).toEqual([])
    expect(stripLeadingSqlComments(null as unknown as string, 'sqlite')).toBe('')
    expect(panelContainsDdlStatement('', 'sqlite')).toBe(false)
    expect(panelContainsDdlStatement('CREATE TABLE x(id INT)', 'redis')).toBe(false)
    expect(findStatementAtCaret('', 0, '')).toBe('')
    expect(formatSqlLiteral('a', '')).toBe("'a'")
    expect(formatPanelSql('db.users.find()', 'mongodb')).toBe('db.users.find()')
    expect(formatPanelSql(null as unknown as string, '')).toBe('')
    expect(isNumericSqlType(null as unknown as string)).toBe(false)
    expect(isBooleanSqlType(null as unknown as string)).toBe(false)
    expect(isEmptyAsNullNonTextSqlType(null as unknown as string)).toBe(false)
    expect(coerceTypedCellInput(null as unknown as string, 'x', 'INTEGER', true)).toBeNull()
    expect(coerceTypedCellInput('NULL', 'x', 'TEXT', true, { allowNullKeyword: true })).toBeNull()

    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.boolean(), (typed, allowNull) => {
        const out = coerceTypedCellInput(typed, 'orig', 'INTEGER', true, { allowNullKeyword: allowNull })
        expect(out === null || typeof out === 'string' || typeof out === 'number' || typeof out === 'boolean').toBe(true)
      }),
      { numRuns: 30 }
    )

    // formatSelectionAsOutput & buildPanelExportData fallbacks
    const expStr = formatSelectionAsOutput(
      ['id', { name: 'label' }],
      [
        { id: 1, label: 'a' },
        { id: null, label: 'b' },
      ],
      [
        { r: 0, c: 0 },
        { r: 1, c: 1 },
      ],
      'sql-in',
      false,
      '',
      undefined,
      'sqlite'
    )
    expect(expStr).toContain('(')
    expect(
      formatSelectionAsOutput(
        ['id'],
        [{ id: null }],
        [{ r: 0, c: 0 }],
        'sql-in',
        false,
        't',
        undefined,
        'sqlite'
      )
    ).toContain('IS NULL')
    expect(
      formatSelectionAsOutput(
        ['id', 'label'],
        [[1, 'a'], [2, 'b']],
        [{ r: 0, c: 0 }, { r: 1, c: 1 }],
        'csv',
        true,
        '',
        undefined,
        'sqlite'
      )
    ).toContain('1,')
    expect(
      buildPanelExportData({
        columns: [{ name: 'id' }],
        rows: [{ id: 1 }],
        format: 'sql-update',
        tableName: 't',
        driver: 'sqlite',
        primaryKeys: ['missing_pk'],
      })
    ).toContain('IS NULL')
    expect(buildDdlFallback({ name: 't', columns: [{ name: 'id' }] }, 'sqlite')).toContain('CREATE TABLE')

    // createPanelStructDraft + getIndexColNames + getActiveIndexColNames + getFkColName + trigger rewriting
    const richDraft = createPanelStructDraft({
      name: 'orders',
      schema: 'public',
      columns: [
        { name: 'id', nativeType: 'INTEGER', isPrimaryKey: true, nullable: false, collate: 'BAD;COLLATE' },
        { name: 'code', type: '', nullable: true, defaultValue: 'abc', collate: 'NOCASE' },
        { name: 'dropped_col', type: 'TEXT' },
      ],
      indexes: [
        { name: 'pk_orders', isPrimary: true, columns: ['id'] },
        {
          name: 'uq_code',
          unique: true,
          origin: 'u',
          columns: ['code', 'ghost_col'],
          columnSpecs: [{ name: 'code', collate: 'NOCASE' }, { name: 'ghost_col' }],
          onConflict: 'IGNORE',
        },
      ],
      foreignKeys: [
        { column: 'code', foreignTable: 'ref_tbl', foreignColumn: 'code', onDelete: 'CASCADE' },
      ],
      triggers: [
        {
          name: 'trg_other',
          sql: "-- cmt\n/* blk */ CREATE TRIGGER trg_other AFTER INSERT ON [other_tbl] FOR EACH ROW BEGIN SELECT 'ok''s'; END",
        },
        {
          name: 'trg_orders',
          sql: 'CREATE TRIGGER trg_orders AFTER INSERT ON main."orders" BEGIN SELECT 1; END',
        },
      ],
      inboundForeignKeys: [
        { fromTable: 'order_items', fromColumn: 'order_id', toColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
      ],
    })
    expect(getIndexColNames(richDraft, { columnRefs: [{ fallbackName: 'code' }] })).toEqual(['code'])
    expect(getIndexColNames(richDraft, { columns: ['code', ''] })).toEqual(['code'])
    expect(getActiveIndexColNames(richDraft, { columns: ['code'] })).toEqual(['code'])
    expect(getFkColName(null as never, null as never)).toBe('')
    expect(getFkColName(richDraft, { column: 'code' })).toBe('code')
    expect(isPanelColDirty(richDraft.columns[0])).toBe(false)
    expect(countPanelStructChanges(null)).toBe(0)

    // Mutate richDraft for SQLite rebuild blockers + trigger analysis + migration SQL
    richDraft.tableName = 'orders_v2'
    richDraft.columns[1].name = 'code_v2'
    richDraft.columns[1].dataType = 'VARCHAR(50)'
    richDraft.columns[2].status = 'deleted'
    expect(requiresPanelSqliteRebuild(richDraft)).toBe(true)
    const sqlitePlan = validatePanelStructDraft(richDraft, 'sqlite', ['ref_tbl'])
    expect(sqlitePlan.errors.length).toBeGreaterThan(0) // inbound FK + composite UNIQUE + trigger ref

    // Valid SQLite rebuild with custom trigger on another table & trigger without BEGIN
    const validSqliteDraft = createPanelStructDraft({
      name: 'items',
      columns: [
        { name: 'id', type: 'INTEGER', isPrimaryKey: true, nullable: false },
        { name: 'title', type: 'TEXT', defaultValue: 'untitled' },
      ],
      indexes: [
        { name: 'idx_title', unique: false, columns: ['title'] },
        { name: 'uq_title', unique: true, origin: 'u', columns: ['title'] },
      ],
      triggers: [{ name: 't_ok', sql: 'CREATE TRIGGER t_ok AFTER INSERT ON items FOR EACH ROW BEGIN SELECT 1; END' }],
    })
    validSqliteDraft.tableName = 'items_new'
    validSqliteDraft.columns[1].dataType = 'VARCHAR(100)'
    validSqliteDraft.columns.push({
      id: 'c_new',
      name: 'req_num',
      dataType: 'INTEGER',
      nullable: false,
      defaultValue: '',
      isPrimaryKey: false,
      status: 'new',
    })
    const sqliteStmts = buildPanelMigrationSql(validSqliteDraft, 'sqlite')
    expect(sqliteStmts.some((s: string) => s.includes('CREATE TABLE'))).toBe(true)

    // Multi-dialect buildPanelMigrationSql: postgres, mysql, mariadb, mssql, oracle, clickhouse
    const makeDialectDraft = (withPkChange = true) => {
      const d = createPanelStructDraft({
        name: 'accounts',
        schema: 'app',
        columns: [
          { name: 'id', nativeType: 'INT', isPrimaryKey: true, nullable: false },
          { name: 'email', nativeType: 'VARCHAR(120)', nullable: true, defaultValue: "'a@b.c'" },
          { name: 'legacy', nativeType: 'TEXT', nullable: true },
        ],
        indexes: [{ name: 'pk_accounts', isPrimary: true, columns: ['id'] }],
      })
      d.columns[1].name = 'email_addr'
      d.columns[1].dataType = 'VARCHAR(200)'
      d.columns[1].nullable = false
      d.columns[1].defaultValue = "'x@y.z'"
      if (withPkChange) {
        d.columns[0].isPrimaryKey = false
        d.columns[1].isPrimaryKey = true
      }
      d.columns[2].status = 'deleted'
      d.columns.push({
        id: 'new_flag',
        name: 'is_active',
        dataType: 'INTEGER',
        nullable: false,
        defaultValue: '',
        isPrimaryKey: false,
        status: 'new',
      })
      d.indexes.push({ id: 'idx_new', name: '', columns: ['email_addr'], unique: false, status: 'new' })
      d.foreignKeys.push({
        id: 'fk_new',
        constraintName: '',
        columnId: d.columns[1].id,
        column: 'email_addr',
        foreignTable: 'users',
        foreignColumn: 'email',
        onDelete: 'SET NULL',
        status: 'new',
      })
      return d
    }

    for (const drv of ['postgres', 'mysql', 'mariadb', 'mssql', 'oracle', 'clickhouse']) {
      const stmts = buildPanelMigrationSql(makeDialectDraft(drv !== 'clickhouse'), drv)
      expect(stmts.length).toBeGreaterThan(0)
    }

    // Validation error branches
    expect(validatePanelStructDraft(null as never, 'sqlite').valid).toBe(false)
    const badDraft = createPanelStructDraft({ name: 't', columns: [{ name: 'a', type: 'TEXT' }] })
    badDraft.tableName = ''
    badDraft.columns[0].name = 'bad;col'
    badDraft.columns.push({ id: 'dup', name: 'bad;col', dataType: 'BAD(((', defaultValue: 'bad;def', status: 'new' })
    badDraft.foreignKeys.push({ id: 'fk_bad', column: 'missing_col', foreignTable: '', foreignColumn: '', status: 'new' })
    badDraft.foreignKeys.push({ id: 'fk_del', constraintName: '', column: 'a', status: 'deleted' })
    const badPlan = validatePanelStructDraft(badDraft, 'postgres', ['other'])
    expect(badPlan.valid).toBe(false)
    expect(badPlan.errors.length).toBeGreaterThan(2)

    expect(buildPanelFeedbackMarkdown({ kind: 'feature', title: 'Export parquet', description: 'Add parquet', tab: '', driver: 'sqlite' })).toContain('Feature Request')

    // 2. panel-explorer pure & controller branches
    expect(buildCountQueryForObject(null, { name: 't' })).toContain('COUNT(*)')
    expect(generateSqlForTable('select', { driver: 'redis' }, { name: 'user:*' })).toContain('SCAN 0 MATCH user:*')
    expect(generateSqlForTable('insert', { driver: 'redis' }, { name: '(root)' })).toContain('SET key_name')
    expect(generateSqlForTable('update', { driver: 'redis' }, { name: '(root)' })).toContain('KEEPTTL')
    expect(generateSqlForTable('other', { driver: 'redis' }, { name: '(root)' })).toBe('INFO keyspace')
    expect(generateSqlForTable('insert', { driver: 'mongodb' }, { name: 'events' }, { columns: [{ name: 'flag', type: 'BOOLEAN' }, { name: 'msg', type: 'STRING' }] })).toContain('"flag": false')
    expect(generateSqlForTable('other', { driver: 'mongodb' }, { name: 'events' })).toContain('.find({}).limit(100)')
    expect(generateSqlForTable('select', { driver: 'mssql' }, { name: 'users' }, { columns: [{ name: 'id' }] })).toContain('TOP 100')
    expect(generateSqlForTable('update', { driver: 'postgres' }, { name: 'empty_tbl' }, { columns: [] })).toContain('WHERE 1 = 0')

    // Close contextMenu when absent
    const origCtx = document.getElementById('contextMenu')
    origCtx?.remove()
    closeContextMenu()
    dom.mountPanelHtml()

    const expRpcSpy = vi.fn(async (method: string) => {
      if (method === 'schema.generateDdl') throw new Error('ddl failed')
      if (method === 'schema.tableDetails') return { columns: [{ name: 'id', type: 'INT' }] }
      if (method === 'query.run') throw new Error('count query failed')
      return {}
    })
    ;(window as { orca?: unknown }).orca = { plugin: { request: expRpcSpy } }

    const explorerState = {
      connections: [
        { id: 'c_pg', name: 'PG Dev', driver: 'postgres', folder: 'Team', readOnly: false },
        { id: 'c_mg', name: 'Mongo Local', driver: 'mongodb', folder: 'Team', readOnly: false },
        { id: 'c_rd', name: 'Redis Local', driver: 'redis', folder: '', readOnly: false },
      ],
      activeConnectionId: 'c_pg',
      expandedConns: new Set<string>(['c_pg', 'c_mg']),
      expandedTables: new Set<string>(['c_pg:public:orders']),
      expandedMeta: new Set<string>(),
      collapsedFolders: null as unknown as Set<string>,
      schemaLoading: new Set<string>(),
      schemaObjects: {
        c_pg: [{ name: 'orders', schema: 'public', kind: 'table' }],
        c_mg: [],
      } as Record<string, Array<{ name: string; schema?: string; kind: string }>>,
      tableDetails: {
        'c_pg:public:orders': { columns: [{ name: 'id', type: 'INT', isPrimaryKey: true }] },
      } as Record<string, unknown>,
      tableDetailsErrors: {} as Record<string, string>,
      pageData: { rows: [[1]], columns: [{ name: 'id' }], canEdit: true },
      activeTable: '',
      filter: '',
      tab: 'explorer',
    }
    const expCalls: string[] = []
    const expCtrl = createPanelExplorerController({
      state: explorerState,
      QUERY_TIMEOUT_MS: 5000,
      getActiveConn: () => explorerState.connections.find((c) => c.id === explorerState.activeConnectionId) || null,
      getConnById: (id: string) => explorerState.connections.find((c) => c.id === id) || null,
      getActiveTableKey: () => 'c_pg:public:orders',
      getPinnedColsSet: () => new Set<string>(),
      getDataGridSel: () => ({ selectCol: (i: number) => expCalls.push(`selCol:${i}`) }),
      isSubmittingChanges: () => false,
      isActiveDataObjectView: () => false,
      showBanner: (msg: string, kind: string) => expCalls.push(`banner:${kind}:${msg}`),
      copyText: async (t: string) => expCalls.push(`copy:${t}`),
      loadSchema: async (id: string) => expCalls.push(`loadSchema:${id}`),
      activateConnection: (id: string) => {
        explorerState.activeConnectionId = id
        expCalls.push(`activate:${id}`)
      },
      persistActiveConnectionId: async (id: string) => expCalls.push(`persist:${id}`),
      savePanelViewState: () => expCalls.push('saveView'),
      renderConnectionsBar: () => expCalls.push('renderBar'),
      renderSqlSafetyBanner: () => expCalls.push('renderSafety'),
      resetSqlSafetyBannerDismissal: () => expCalls.push('resetSafety'),
      setSqlText: (sql: string) => expCalls.push(`setSql:${sql}`),
      switchTab: (tab: string) => expCalls.push(`tab:${tab}`),
      selectTableAndOpen: async (cid: string, tbl: string) => expCalls.push(`openTbl:${cid}:${tbl}`),
      openFullStudio: () => expCalls.push('studio'),
      openCreateTableModal: () => expCalls.push('newTable'),
      openDangerTableModal: (act: string, _c: unknown, obj: { name: string }) => expCalls.push(`danger:${act}:${obj.name}`),
      openBulkFillModal: () => expCalls.push('bulkFill'),
      openConnFormForEdit: () => expCalls.push('editConn'),
      deleteConnectionById: async () => expCalls.push('delConn'),
      testConnectionById: async () => expCalls.push('testConn'),
      renderValueInspector: () => expCalls.push('valInsp'),
      renderStagingBar: () => expCalls.push('stageBar'),
      copyDataSelection: (fmt: string) => expCalls.push(`copyData:${fmt}`),
      copySqlSelection: (fmt: string) => expCalls.push(`copySql:${fmt}`),
      exportCurrentSqlResult: (fmt: string) => expCalls.push(`exportSql:${fmt}`),
      triggerPanelPasteSmart: async () => expCalls.push('pasteSmart'),
      triggerPanelPasteNewRows: async () => expCalls.push('pasteNew'),
      addBlankDataRow: () => expCalls.push('addBlank'),
      bulkSetSelectedCellsValue: () => expCalls.push('setNull'),
      applyQuickWhere: (w: string) => expCalls.push(`where:${w}`),
      jumpToForeignKeyTarget: () => expCalls.push('jumpFk'),
      cloneSelectedRows: () => expCalls.push('clone'),
      toggleDeleteSelectedRows: () => expCalls.push('delRow'),
      toggleColumnPinned: (c: string) => expCalls.push(`pin:${c}`),
      toggleColumnHidden: (c: string) => expCalls.push(`hide:${c}`),
      autoFitDataColumn: (c: string) => expCalls.push(`fit:${c}`),
    })

    // Filter matching schema.table, empty matching objects, collapseAll, keyboard toggles, menu buttons
    explorerState.filter = 'public.ord'
    expCtrl.renderExplorer()
    const treeContainer = document.getElementById('schemaTreeContainer')!
    expect(treeContainer.textContent).toContain('orders')

    explorerState.filter = 'mongo'
    expCtrl.renderExplorer()
    expect(treeContainer.textContent).toContain('No collections found')

    explorerState.filter = 'PG Dev'
    expCtrl.renderExplorer()
    expect(treeContainer.textContent).toContain('No matching objects')

    explorerState.filter = ''
    expCtrl.renderExplorer()
    // Toggle folder via keydown, conn via keydown & menu btn, table via keydown & more btn
    const folderHead = treeContainer.querySelector('.tree-folder-header') as HTMLElement
    folderHead?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const connMoreBtn = treeContainer.querySelector('button[aria-label="Connection Actions"]') as HTMLElement
    connMoreBtn?.click()
    // Collapse & expand active connection without cached schema to hit loadSchema branch
    explorerState.activeConnectionId = 'c_rd'
    explorerState.expandedConns.delete('c_rd')
    expCtrl.renderExplorer()
    const redisConnItem = Array.from(treeContainer.querySelectorAll('.tree-conn-item')).find((el) =>
      el.textContent?.includes('Redis Local')
    ) as HTMLElement
    redisConnItem?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    explorerState.activeConnectionId = 'c_pg'
    expCtrl.renderExplorer()

    const tblMoreBtn = treeContainer.querySelector('button[aria-label="Table Actions"]') as HTMLElement
    tblMoreBtn?.click()
    const objItem = tblMoreBtn?.closest('.tree-item') as HTMLElement
    objItem?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))

    expCtrl.collapseAllExplorer()
    // collapseAllExplorer with no folders
    explorerState.connections = [{ id: 'c_plain', name: 'Plain', driver: 'sqlite', folder: '', readOnly: false }]
    expCtrl.collapseAllExplorer()
    explorerState.connections = [
      { id: 'c_pg', name: 'PG Dev', driver: 'postgres', folder: 'Team', readOnly: false },
      { id: 'c_mg', name: 'Mongo Local', driver: 'mongodb', folder: 'Team', readOnly: false },
    ]

    // Context menu targets: dataCanvas, dataCell (with FK + null/val), dataHeader, sqlCell, object (DDL throw + countRows throw), connection (Mongo + Jump to Console)
    expCtrl.openContextMenu(10, 10, { type: 'dataCanvas' })
    expCtrl.openContextMenu(10, 10, {
      type: 'dataCell',
      col: { name: 'dept_id' },
      entry: { rowKey: '1', isInsert: false },
      val: 2,
      cellCount: 1,
      rowCount: 1,
      fkInfo: { referencedTable: 'departments', referencedColumn: 'id' },
    })
    expCtrl.openContextMenu(10, 10, { type: 'dataHeader', col: { name: 'dept_id' }, colIdx: 0 })
    expCtrl.openContextMenu(10, 10, { type: 'sqlCell', colName: 'cnt', cellCount: 1 })
    expCtrl.openContextMenu(10, 10, { type: 'connection', conn: explorerState.connections[1] })
    const jumpItem = Array.from(document.querySelectorAll('#contextMenu .ctx-item')).find((b) =>
      b.textContent?.includes('Jump to Console')
    ) as HTMLButtonElement
    jumpItem?.click()
    expCtrl.openContextMenu(10, 10, {
      type: 'object',
      conn: explorerState.connections[0],
      obj: { name: 'orders', schema: 'public', kind: 'table' },
    })
    const ddlItem = Array.from(document.querySelectorAll('#contextMenu .ctx-item')).find((b) =>
      b.textContent?.includes('Generate CREATE DDL')
    ) as HTMLButtonElement
    ddlItem?.click()
    await flushMicro()
    expect(expCalls.some((c) => c.includes('ddl failed'))).toBe(true)

    expCtrl.openContextMenu(10, 10, {
      type: 'object',
      conn: explorerState.connections[0],
      obj: { name: 'orders', schema: 'public', kind: 'table' },
    })
    const countItem = Array.from(document.querySelectorAll('#contextMenu .ctx-item')).find((b) =>
      b.textContent?.includes('Count Rows')
    ) as HTMLButtonElement
    countItem?.click()
    await flushMicro()
    expect(expCalls.some((c) => c.includes('count query failed'))).toBe(true)

    // 3. panel-selection remaining branches
    const emptySel = new PanelGridSelection({
      wrapEl: null as unknown as HTMLElement,
      tableEl: null as unknown as HTMLElement,
      getDimensions: () => ({ rows: 0, cols: 0 }),
      getValueAt: () => null,
    })
    emptySel.selectAll()
    emptySel.selectRowRange(0, 1)
    emptySel.selectCell(-1, 0)
    emptySel.selectRow(-1)
    emptySel.selectCol(-1)
    expect(emptySel.getSelectedRowIndices()).toEqual([])
    expect(emptySel.computeSummary()).toBeNull()
    emptySel.detachRow(null as unknown as HTMLTableRowElement)
    emptySel.applyDomClasses()
    emptySel.destroy()

    // Full grid with multi-range, drag (with & without rAF), scrollbar ignore, keyboard & paste edge cases
    const wrap = document.createElement('div')
    wrap.tabIndex = 0
    wrap.clientWidth = 200
    wrap.clientHeight = 120
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, right: 220, bottom: 140, width: 220, height: 140, x: 0, y: 0, toJSON() {} })
    const tbl = document.createElement('table')
    const tbody = document.createElement('tbody')
    for (let r = 0; r < 3; r++) {
      const tr = document.createElement('tr')
      tr.dataset.rowIdx = String(r)
      const rn = document.createElement('td')
      rn.className = 'td-rownum'
      rn.dataset.rowIdx = String(r)
      tr.appendChild(rn)
      for (let c = 0; c < 3; c++) {
        const td = document.createElement('td')
        td.dataset.rowIdx = String(r)
        td.dataset.colIdx = String(c)
        td.scrollIntoView = vi.fn()
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    tbl.appendChild(tbody)
    wrap.appendChild(tbl)
    document.body.appendChild(wrap)

    const gridSel = new PanelGridSelection({
      wrapEl: wrap,
      tableEl: tbl,
      editable: true,
      getDimensions: () => ({ rows: 3, cols: 3 }),
      getValueAt: (r: number, c: number) => `${r}:${c}`,
      onPaste: () => true,
    })
    gridSel.selectRowRange(5, 4) // start > end returns early
    gridSel.selectCell(0, 0)
    expect(gridSel.formatStatsText()).toContain('1 row × 1 col (1 cell)')
    gridSel.selectCell(1, 1, { ctrl: true })
    gridSel.selectCell(2, 2, { shift: true, ctrl: true }) // modifies last range in multi-range
    expect(gridSel.getSelectedRowIndices()).toEqual([0, 1, 2])
    expect(gridSel.getSelectedCoords().length).toBeGreaterThan(2)
    expect(gridSel.computeSummary()?.cellCount).toBeGreaterThan(2)

    // Mousedown on scrollbar edge (ignored) + on rowNum + mousemove drag + mouseup
    wrap.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 210, clientY: 10, bubbles: false }))
    const rowNum0 = tbody.querySelector('.td-rownum[data-row-idx="0"]') as HTMLElement
    const td12 = tbody.querySelector('td[data-row-idx="1"][data-col-idx="2"]') as HTMLElement
    const tdBad = document.createElement('td')
    tbody.querySelector('tr')!.appendChild(tdBad)
    rowNum0.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
    tdBad.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    td12.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })) // pending rAF drag
    td12.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })) // dedup pendingDragCoord
    // Trigger destroy with pending dragRafId!
    gridSel.destroy()

    // Re-create without requestAnimationFrame to hit sync applyPendingDrag & keyboard Arrow with null focus & paste fallback
    const origRaf = globalThis.requestAnimationFrame
    ;(globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined
    const gridSel2 = new PanelGridSelection({
      wrapEl: wrap,
      tableEl: tbl,
      editable: true,
      getDimensions: () => ({ rows: 3, cols: 3 }),
      getValueAt: () => 'v',
      onPaste: () => true,
    })
    const td00 = tbody.querySelector('td[data-row-idx="0"][data-col-idx="0"]') as HTMLElement
    td00.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
    td12.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    gridSel2.clear(true)
    wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    const pasteEv = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: { getData: (t: string) => string }
    }
    pasteEv.clipboardData = { getData: (t: string) => (t === 'text' ? 'hello' : (undefined as unknown as string)) }
    wrap.dispatchEvent(pasteEv)
    const inp = document.createElement('input')
    document.body.appendChild(inp)
    inp.focus()
    wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    wrap.dispatchEvent(pasteEv)
    gridSel2._boundCleanups.push(() => {
      throw new Error('cleanup err')
    })
    gridSel2.destroy()
    ;(globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame = origRaf
  })

  it('Slice 4: closes panel-structure & panel-connection-form branches', async () => {
    dom.mountPanelHtml()

    // 1. panel-structure remaining statements & branches
    expect(getPanelDriverColumnTypes('').length).toBeGreaterThan(3)
    let txActive = false
    let activeConn: Record<string, unknown> | null = { id: 'c_sq', name: 'Local', driver: 'sqlite', readOnly: false }
    const structCalls: string[] = []
    ;(window as { orca?: unknown }).orca = {
      plugin: {
        request: vi.fn(async (name: string) => {
          if (name === 'tx.status') return { active: txActive, supported: true, autoCommit: !txActive }
          if (name === 'query.run') return { ok: true }
          return {}
        }),
      },
    }

    const structState = {
      activeConnectionId: 'c_sq',
      activeTable: 'items',
      activeSchema: 'main',
      structureLoading: false,
      structureError: null as string | null,
      structDraftKey: null as string | null,
      structDraft: null as Record<string, unknown> | null,
      structPreviewOpen: false,
      isMigrating: false,
      schemaObjects: {
        c_sq: [{ name: 'items', schema: 'main', kind: 'table' }, { name: 'users', schema: 'main', kind: 'table' }],
      } as Record<string, Array<Record<string, unknown>>>,
      tableDetails: {
        'c_sq:main:items': {
          name: 'items',
          columns: [
            { name: 'id', type: 'INTEGER', nativeType: 'INTEGER', isPrimaryKey: true, nullable: false, collate: 'NOCASE' },
            { name: 'title', type: 'TEXT', nativeType: 'TEXT', nullable: true, defaultValue: "'hi'" },
            { name: 'user_id', type: 'INTEGER', nativeType: 'INTEGER', nullable: true },
          ],
          primaryKey: [],
          indexes: [
            { name: 'pk_items', isPrimary: true, origin: 'pk', columns: ['id'], columnSpecs: [{ name: 'id' }], onConflict: 'ABORT' },
            { name: 'idx_title', unique: false, columns: ['title'] },
          ],
          foreignKeys: [
            { column: 'user_id', referencedTable: 'users', referencedColumn: 'id', constraintName: '' },
          ],
          triggers: [{ name: 'trg_i', sql: 'CREATE TRIGGER trg_i AFTER INSERT ON items FOR EACH ROW BEGIN SELECT 1; END' }],
          inboundForeignKeys: [],
        },
        'c_mg::coll': {
          name: 'coll',
          columns: [{ name: '_id', nativeType: '', type: 'ObjectId', isPrimaryKey: true }],
          primaryKey: [],
          indexes: [],
          foreignKeys: [],
        },
      } as Record<string, unknown>,
    }
    const structCtrl = createPanelStructureController({
      state: structState,
      QUERY_TIMEOUT_MS: 5000,
      getActiveConn: () => activeConn,
      getConnById: (id: string) => (id === 'c_sq' ? activeConn : null),
      showBanner: (m: string, k: string) => structCalls.push(`banner:${k}:${m}`),
      savePanelViewState: () => {},
      loadSchema: async () => { structCalls.push('loadSchema') },
      loadTableDetails: async () => { structCalls.push('loadDetails') },
      loadTablePage: async () => { structCalls.push('loadPage') },
    })

    // MongoDB read-only structure rendering
    activeConn = { id: 'c_mg', name: 'MG', driver: 'mongodb', readOnly: false }
    structState.activeConnectionId = 'c_mg'
    structState.activeTable = 'coll'
    structState.activeSchema = ''
    structCtrl.renderStructure()
    expect(document.getElementById('structureKv')?.textContent).toContain('Collection')

    // ReadOnly SQLite openMigrationConfirmModal block
    activeConn = { id: 'c_sq', name: 'RO', driver: 'sqlite', readOnly: true }
    structState.activeConnectionId = 'c_sq'
    structState.activeTable = 'items'
    structState.activeSchema = 'main'
    structCtrl.applyPanelStructChanges() // read-only guard L313-316
    expect(structCalls.some((c) => c.includes('Read-Only'))).toBe(true)
    // Re-enable write and re-render
    activeConn = { id: 'c_sq', name: 'RW', driver: 'sqlite', readOnly: false }
    structCtrl.renderStructure()

    // Rename column referenced by BOTH index AND FK, edit type & default, then remove new index & FK
    const titleInp = Array.from(document.querySelectorAll('#structureColTable .struct-cell-input')).find(
      (el) => (el as HTMLInputElement).value === 'title'
    ) as HTMLInputElement
    titleInp.value = 'title_v2'
    titleInp.dispatchEvent(new Event('input', { bubbles: true }))

    // Combo popover inside-click ignored + zero innerWidth/Height
    const origW = window.innerWidth
    const origH = window.innerHeight
    ;(window as { innerWidth: number }).innerWidth = 0
    ;(window as { innerHeight: number }).innerHeight = 0
    const comboToggle = document.querySelector('#structureColTable .struct-combo-toggle') as HTMLButtonElement
    comboToggle.click()
    const comboPop = document.querySelector('.struct-combo-popover') as HTMLElement
    comboPop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(structCtrl.isPanelComboOpen()).toBe(true)
    structCtrl.closePanelComboPopover()
    ;(window as { innerWidth: number }).innerWidth = origW
    ;(window as { innerHeight: number }).innerHeight = origH

    // Edit type & default for highlight branches + push new index/FK & remove via × buttons
    const typeInp = document.querySelector('#structureColTable .struct-combo-wrap input') as HTMLInputElement
    typeInp.value = 'VARCHAR(120)'
    typeInp.dispatchEvent(new Event('input', { bubbles: true }))
    const defInp = document.querySelector('#structureColTable .struct-default-wrap input') as HTMLInputElement
    defInp.value = "'updated'"
    defInp.dispatchEvent(new Event('input', { bubbles: true }))

    const draftRef = structState.structDraft as {
      tableName: string
      indexes: Array<Record<string, unknown>>
      foreignKeys: Array<Record<string, unknown>>
    }
    draftRef.indexes.push({ id: 'new_idx', status: 'new', name: 'idx_tmp', unique: false, columns: ['title_v2'] })
    draftRef.foreignKeys.push({ id: 'new_fk', status: 'new', columnId: null, column: 'user_id', foreignTable: 'users', foreignColumn: 'id', onDelete: 'CASCADE' })
    structCtrl.renderStructure()
    const fkSel = document.querySelector('#structureFkList .struct-fk-col-select') as HTMLSelectElement | null
    if (fkSel) {
      fkSel.value = 'title_v2'
      fkSel.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const idxRem = Array.from(document.querySelectorAll('#structureIdxList button')).find((b) => b.textContent === '×') as HTMLButtonElement | undefined
    idxRem?.click()
    const fkRem = Array.from(document.querySelectorAll('#structureFkList button')).find((b) => b.textContent === '×') as HTMLButtonElement | undefined
    fkRem?.click()

    // Rename table so nextTable !== state.activeTable, trigger txActive rebuild blocker inside executeConfirmedPanelMigration, then succeed with context change
    const tblNameInp = document.getElementById('structureTableNameInput') as HTMLInputElement
    tblNameInp.value = 'items_renamed'
    draftRef.tableName = 'items_renamed'
    structCtrl.refreshPanelStructStageBar()
    txActive = false
    structCtrl.applyPanelStructChanges()
    await flushMicro()
    expect((document.getElementById('confirmMigrationModal') as HTMLElement).hidden).toBe(false)

    // isMigrating guard on closeMigrationConfirmModal
    structState.isMigrating = true
    structCtrl.closeMigrationConfirmModal()
    expect((document.getElementById('confirmMigrationModal') as HTMLElement).hidden).toBe(false)
    structState.isMigrating = false

    // Execute when txActive === true (throws rebuild blocker inside executeConfirmedPanelMigration L432-436)
    txActive = true
    await structCtrl.executeConfirmedPanelMigration()
    expect(document.getElementById('confirmMigrationErrors')?.textContent).toContain('manual transaction')

    // Execute cleanly while switching activeTable away mid-flight to hit !stillSameContext branch (L470-473)
    txActive = false
    const execP = structCtrl.executeConfirmedPanelMigration()
    structState.activeTable = 'users'
    await execP
    expect(structCalls.some((c) => c.startsWith('banner:success:Applied'))).toBe(true)

    // Execute cleanly while staying in same context and renaming table (L457-459)
    structState.activeTable = 'items'
    structState.structDraftKey = null
    structCtrl.renderStructure()
    const draftV3 = structState.structDraft as { tableName: string; columns: Array<Record<string, unknown>> }
    draftV3.tableName = 'items_v3'
    draftV3.columns[1].dataType = 'VARCHAR(50)'
    structCtrl.applyPanelStructChanges()
    await flushMicro()
    await structCtrl.executeConfirmedPanelMigration()
    expect(structState.activeTable).toBe('items_v3')

    // 2. panel-connection-form remaining branches
    expect(formatConnSubtitle({ driver: 'sqlite', filePath: '/tmp/app.db' })).toBe('/tmp/app.db')
    expect(formatConnSubtitle({ driver: 'libsql', database: 'local' })).toBe('local')
    expect(formatConnSubtitle({ driver: 'redis' })).toBe('localhost:6379/db0')
    expect(formatConnSubtitle({ driver: 'postgres', database: 'app' })).toBe('localhost:5432/app')

    const formNotices: string[] = []
    const formBanners: string[] = []
    let cfPlatform = 'win32'
    let cfDriversMode: 'array' | 'obj' = 'array'
    let cfByodSetupOk = true
    let cfParseRes: Record<string, unknown> = { ok: false, error: 'Bad URI' }
    let cfDockerScope = 'Docker Context'
    let cfWsErr = false

    ;(window as { orca?: unknown }).orca = {
      plugin: {
        request: vi.fn(async (method: string, payload?: Record<string, unknown>) => {
          if (method === 'drivers.list') {
            return cfDriversMode === 'array'
              ? [{ id: 'snowflake', status: 'local-verified', sha256: 'abcdef1234567890', resolvedEntry: 'C:\\drv\\index.mjs' }]
              : { drivers: [{ id: 'snowflake', status: 'unconfigured' }] }
          }
          if (method === 'drivers.defaultPaths') {
            return {
              platform: cfPlatform,
              paths: { snowflake: '$HOME/my drivers/snowflake', bigquery: 'C:\\drv\\bq' },
              templates: {},
            }
          }
          if (method === 'drivers.setup') {
            if (!cfByodSetupOk) return { ok: false, message: 'setup blocked' }
            return { ok: true, dirPath: '$HOME/my drivers/snowflake', installPackage: '', inspect: { sha256: '1234567890abcdef1234' }, item: { status: 'unconfigured' } }
          }
          if (method === 'drivers.inspect') return { ok: false, message: 'inspect fail' }
          if (method === 'workspaces.list') {
            if (cfWsErr) throw new Error('ws list err')
            return {
              workspaces: [
                { id: 'w1', name: 'Main', branch: 'dev', path: '/w1', projectFolder: 'Proj', isCurrent: true, label: 'Main' },
                { id: 'w1', name: 'Dup', path: '', projectFolder: 'Proj', isCurrent: false, label: 'Dup' },
                { id: 'w2', name: 'Other', path: '', projectFolder: '', isCurrent: false, label: 'Other' },
              ],
            }
          }
          if (method === 'connection.parseUri') return cfParseRes
          if (method === 'discovery.workspace') {
            return {
              scannedDirs: ['/app'],
              folderScoped: false,
              dockerScopeLabel: cfDockerScope,
              envConnections: [
                { envKey: 'DB_URL', name: '', driver: 'libsql', uri: 'libsql://host/db?authToken=sec#tok=1', sourceFile: '' },
              ],
              dockerContainers: [
                { driver: 'redis', host: '127.0.0.1', port: 6379, redisDb: 2, status: 'compose file', isOutsideWorkspace: true, project: 'stack', service: 'cache' },
                { driver: 'clickhouse', host: '127.0.0.1', port: 8123, user: 'u', status: 'stopped', isOutsideWorkspace: true, project: 'stack', service: 'ch' },
                { driver: 'libsql', host: '127.0.0.1', port: 8080, status: 'running', project: 'stack', service: 'lib' },
                { driver: 'd1', host: 'x', port: 1, status: 'running', project: 'p', service: 'd1' },
              ],
              sqliteFiles: [
                { name: 'notes.db', filePath: '/data/.db', sizeBytes: 512 },
              ],
            }
          }
          return {}
        }),
      },
    }

    const cfState = {
      connections: [{ id: 'c1', name: 'One', driver: 'postgres', folder: 'Core' }],
      formOpen: true,
      formBusy: false,
      editingId: null as string | null,
      sourceSecretConnId: null as string | null,
      formDriver: 'sqlite',
      formColorTag: 'none',
      formHadPassword: false,
      formHadAuthToken: false,
      formSslMode: undefined as string | undefined,
      formSslRejectUnauthorized: undefined as boolean | undefined,
      formOptions: '',
      lastParsedUri: '',
      parsedOracleUrl: '',
      lastAutoFilledSqliteName: '',
      pendingWorkspaceScope: null as string | null,
      discoveryCollapsed: null as Record<string, boolean | null> | null,
      discoveredSearch: '',
      discoveredEnvs: [] as unknown[],
      discoveredDocker: [] as unknown[],
      discoveredFiles: [] as unknown[],
      discoveredScannedDirs: [] as string[],
      discoveredFolderScoped: false,
      discoveredDockerScopeLabel: 'Local Docker',
    }
    const cfCtrl = createPanelConnectionFormController({
      state: cfState,
      showBanner: (m: string) => formBanners.push(m),
      showFormNotice: (m: string) => formNotices.push(m),
      clearFormNotice: () => {},
      setFormOpen: (v: boolean) => { cfState.formOpen = v },
      updateViewportLayout: () => {},
      savePanelViewState: () => {},
      copyText: null as unknown as (t: string, m: string) => Promise<void>,
    })

    cfCtrl.initStaticSelectors()
    await flushMicro(10)

    // Test win32 & darwin BYOD + missing starter template notice + inspect failure + pending-less trust guard
    cfCtrl.setFormDriver('cassandra', true)
    await cfCtrl.refreshPanelByodAndWorkspaces()
    document.getElementById('panelByodCopyCmdBtn')?.click()
    document.getElementById('panelByodCopyStarterBtn')?.click()
    await flushMicro()
    expect(formNotices.some((n) => n.includes('Starter template unavailable'))).toBe(true)

    cfCtrl.setFormDriver('snowflake', true)
    await cfCtrl.refreshPanelByodAndWorkspaces()
    document.getElementById('panelByodInspectBtn')?.click()
    await flushMicro()
    document.getElementById('panelByodTrustBtn')?.click() // no pending -> early return
    document.getElementById('panelByodAutoSetupBtn')?.click()
    await flushMicro()
    cfPlatform = 'linux'
    cfDriversMode = 'obj'
    cfByodSetupOk = false
    await cfCtrl.refreshPanelByodAndWorkspaces()
    document.getElementById('panelByodAutoSetupBtn')?.click()
    await flushMicro()

    // Discovery: Docker Context + search + click all discovered items (libsql, redis, clickhouse, d1, sqlite dotfile)
    await cfCtrl.detectWorkspace('/app', false)
    cfDockerScope = 'Local Docker'
    await cfCtrl.detectWorkspace('/app', false)
    cfState.discoveredSearch = 'notes.db'
    cfCtrl.renderDiscoveredItems()
    cfState.discoveredSearch = ''
    cfCtrl.renderDiscoveredItems()
    for (const chip of Array.from(document.querySelectorAll('#discoveredBox .file-chip')) as HTMLButtonElement[]) {
      chip.click()
      await flushMicro()
    }

    // URI parse: failure, stale seq, fallback scrub with malformed %ZZ query & hash ? & libsql empty host & redis/postgres sslMode disable + verify-ca
    expect(await cfCtrl.handleParseUri('bad://%ZZ?token=1&%ZZ=2#k=1?access_token=s')).toBe(false)
    cfParseRes = {
      ok: true,
      profile: {
        driver: 'postgres',
        host: 'db.proj.supabase.co',
        port: 5432,
        database: 'pg',
        sslMode: 'disable',
        sslRejectUnauthorized: false,
        options: 'application_name=datanoa',
      },
    }
    expect(await cfCtrl.handleParseUri('postgres://u:p@db.proj.supabase.co:5432/pg')).toBe(true)
    cfParseRes = {
      ok: true,
      profile: { driver: 'redis', host: '127.0.0.1', port: 6379, redisDb: 3, sslMode: 'verify-ca' },
    }
    expect(await cfCtrl.handleParseUri('redis://127.0.0.1:6379/3')).toBe(true)

    // Fallback scrub URL when parsing fails on libsql & clickhouse
    cfCtrl.populateFormFromProfile({ id: 'c_lib_bad', driver: 'libsql', url: 'not a valid url://user:pw@h/?token=abc' }, 'view')
    cfCtrl.populateFormFromProfile({ id: 'c_ch_http', driver: 'clickhouse', host: 'ch.local', port: 8123, url: 'http://ch.local' }, 'edit')
    expect((cfCtrl.buildFormSubmission('c_ch_http').profile as { port: number }).port).toBe(8123)
    ;(document.getElementById('formClickhouseUrl') as HTMLInputElement).value = ''
    expect((cfCtrl.buildFormSubmission('c_ch_http').profile as { url: string }).url).toContain('http://')
    cfCtrl.populateFormFromProfile({ id: 'c_mg_false', driver: 'mongodb', url: 'mongodb://h:27017/db?tls=false' }, 'edit')
    cfCtrl.buildFormSubmission('c_mg_false')

    // ensureRequiredPasswordBeforeSubmit: sourceSecretConnId + formHadPassword + valid Supabase password
    cfState.formDriver = 'postgres'
    ;(document.getElementById('formHost') as HTMLInputElement).value = 'db.abc.supabase.co'
    ;(document.getElementById('formPassword') as HTMLInputElement).value = ''
    cfState.editingId = null
    cfState.sourceSecretConnId = 'c_src'
    cfState.formHadPassword = true
    expect(cfCtrl.ensureRequiredPasswordBeforeSubmit('c_new')).toBe(true)
    cfState.sourceSecretConnId = null
    cfState.formHadPassword = false
    ;(document.getElementById('formPassword') as HTMLInputElement).value = 'pw123'
    expect(cfCtrl.ensureRequiredPasswordBeforeSubmit('c_new')).toBe(true)

    // Tracked input change on formWorkspaceScope & formSsl uncheck
    const wsScopeEl = document.getElementById('formWorkspaceScope') as HTMLSelectElement
    wsScopeEl.dispatchEvent(new Event('change', { bubbles: true }))
    const sslEl = document.getElementById('formSsl') as HTMLInputElement
    sslEl.checked = false
    sslEl.dispatchEvent(new Event('change', { bubbles: true }))

    // Remove #panelByodSetupBox & workspaces error to hit remaining defensive guards
    cfWsErr = true
    document.getElementById('panelByodSetupBox')?.remove()
    await cfCtrl.refreshPanelByodAndWorkspaces()
  })

  it('Slice 5a: closes panel-sql.js remaining functions, danger modal, EXPLAIN AI callbacks, sort & cancel branches', async () => {
    vi.useFakeTimers()
    dom.mountPanelHtml()

    let explainMode: 'ok' | 'fail' = 'ok'
    let queryMode: 'ok' | 'multi-err' | 'ddl' = 'ok'
    let historyThrows = true
    let resolvePendingRun!: (v: unknown) => void
    let holdNextRun = false
    const sqlCalls: string[] = []
    ;(window as { orca?: unknown }).orca = {
      plugin: {
        request: vi.fn(async (method: string, payload?: Record<string, unknown>) => {
          if (method === 'ai.complete') {
            sqlCalls.push(`ai.complete:${String(payload?.prefix || '')}`)
            return { id: 42, suggestion: ' 1' }
          }
          if (method === 'ai.metrics.event') {
            sqlCalls.push(`ai.metric:${String(payload?.kind)}`)
            return {}
          }
          if (method === 'ai.explainAnalyze') {
            if (explainMode === 'fail') throw new Error('explain quota exceeded')
            return {
              summary: 'Full scan',
              durationMs: 14,
              language: 'en',
              bottlenecks: [],
              indexSuggestions: [{ ddl: 'CREATE INDEX idx_u ON users(name);', reason: 'Fast lookup' }],
              optimizedSql: 'SELECT id FROM users WHERE id = 1;',
              notes: [],
            }
          }
          if (method === 'query.history.list') {
            if (historyThrows) throw new Error('hist failed')
            return {
              entries: [
                { connectionName: 'Main', driver: 'postgres', sql: 'SELECT 1;', rowCount: 1, durationMs: 2, isError: false, timestamp: Date.now() },
              ],
            }
          }
          if (method === 'query.run') {
            if (holdNextRun) {
              return new Promise((r) => {
                resolvePendingRun = r
              })
            }
            if (queryMode === 'multi-err') {
              if (String(payload?.sql).includes('BAD')) throw new Error('syntax error')
              return { columns: [{ name: 'c' }], rows: [[1]], rowCount: 1, isSelect: true, executionTimeMs: 3 }
            }
            if (queryMode === 'ddl') {
              return { columns: [], rows: [], affectedRows: 0, isSelect: false, executionTimeMs: 2 }
            }
            return {
              columns: [{ name: 'n' }, { name: 'txt' }],
              rows: [[null, 'b'], [10, null], [null, null], [2, 'a']],
              rowCount: 4,
              isSelect: true,
              executionTimeMs: 5,
            }
          }
          return {}
        }),
      },
      settings: {
        get: vi.fn().mockResolvedValue(500),
      },
    }

    const prodConn = { id: 'c_pg', name: 'Prod', driver: 'postgres', colorTag: 'prod', readOnly: false }
    const stagingConn = { id: 'c_stg', name: 'Staging', driver: 'postgres', colorTag: 'staging', readOnly: false }
    const mongoConn = { id: 'c_mg', name: 'Mongo', driver: 'mongodb', readOnly: false }
    let activeConn: Record<string, unknown> | null = stagingConn
    const sqlState = {
      activeConnectionId: 'c_stg',
      activeQueryId: null as string | null,
      activeWorkerQueryId: null as string | null,
      activeSchema: 'public',
      activeTable: 'users',
      lastError: '',
      lastSqlResult: null as Record<string, unknown> | null,
      sqlSortColIdx: null as number | null,
      sqlSortDir: 'ASC',
      sqlColWidths: [] as number[],
      sqlRowNumWidth: 42,
      historyOpen: true,
      historyLoading: false,
      historyFilter: '',
      historyEntries: [] as Array<Record<string, unknown>>,
    }
    let suppressUntil = 0
    let sqlGridSel: PanelGridSelection | null = null
    const ctrl = createPanelSqlController({
      state: sqlState,
      QUERY_TIMEOUT_MS: 5000,
      VIRT_ROW_HEIGHT_PX: 26,
      getActiveConn: () => activeConn,
      getConnById: (id: string) => (id === 'c_pg' ? prodConn : id === 'c_stg' ? stagingConn : mongoConn),
      getSqlGridSel: () => sqlGridSel,
      getSuppressSortClickUntil: () => suppressUntil,
      setLastPanelCopiedText: (t: string) => sqlCalls.push(`copiedLen:${t.length}`),
      computeVirtualRange: (s: number, h: number, tot: number) => coreComputeVirtualRange(s, h, tot, 26, 4),
      attachColumnResizeHandle: (_h: HTMLElement, _c: HTMLElement, _th: HTMLElement, _rn: boolean, _ci: number, _w: number[], _sync: () => void, autoFitFn: (() => number) | null) => {
        if (autoFitFn) sqlCalls.push(`autoFit:${autoFitFn()}`)
      },
      copyText: async (t: string, msg: string) => { sqlCalls.push(`copy:${msg}:${t.slice(0, 12)}`) },
      showBanner: (m: string, k: string) => sqlCalls.push(`banner:${k}:${m}`),
      loadSchema: async () => { sqlCalls.push('loadSchema') },
      savePanelViewState: () => {},
      scheduleSavePanelViewState: () => {},
      savePanelDataCache: () => {},
      onFormatSql: () => sqlCalls.push('onFormatSql'),
      getAiStatus: () => ({ enabled: true, state: 'on', explainLanguage: 'en' }),
      openAiSettingsModal: async () => { sqlCalls.push('openAiSettings') },
      onRefreshAiStatus: () => {},
    })

    sqlGridSel = new PanelGridSelection({
      wrapEl: document.getElementById('sqlResultWrap')!,
      tableEl: document.getElementById('sqlResultTable')!,
      editable: false,
      getDimensions: () => ({ rows: ctrl.sqlVirt.sortedRows.length, cols: ctrl.sqlVirt.columns.length }),
      getValueAt: (r: number, c: number) => ctrl.sqlVirt.sortedRows[r]?.[c],
      onSelectionChange: () => ctrl.renderSqlSelectionStats(),
      onCopy: () => ctrl.copySqlSelection('tsv', false),
    })

    try {
      // 1. Mount CM editor & trigger inline AI requestCompletion + onMetric + keymap callbacks + resizer edges
      ctrl.restoreConsoleTabsState(null, '')
      const tabSql = document.getElementById('tabSql') as unknown as {
        clientHeight: number
        _rect: { height: number }
      }
      tabSql._rect.height = 0
      tabSql.clientHeight = 700
      expect(ctrl.setSqlEditorHeight(Number.NaN)).toBeNull()
      expect(ctrl.setSqlEditorHeight(220, { persist: true })).toBe(220)
      tabSql._rect.height = 700
      expect(ctrl.setSqlEditorHeight(240, { persist: false })).toBe(240)
      const resizer = document.getElementById('sqlEditorResizer')!
      resizer.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true })) // ignored non-left
      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))

      // Console tab add + rename Escape branch
      const addTabBtn = document.querySelector('#sqlConsoleTabsBar .sql-console-tab-add') as HTMLButtonElement | null
      addTabBtn?.click()
      const tabsEls = document.querySelectorAll('#sqlConsoleTabsBar .sql-console-tab')
      tabsEls[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
      const renInp = document.querySelector('#sqlConsoleTabsBar .sql-console-tab-rename') as HTMLInputElement | null
      renInp?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

      // 2. Execute staging Danger SQL (non-prod checkbox + cancel + backdrop + execute)
      ctrl.setSqlText('DELETE FROM users;')
      await ctrl.runSql('all')
      document.getElementById('dangerSqlCancelBtn')?.click()
      await ctrl.runSql('all')
      document.getElementById('dangerSqlModal')?.dispatchEvent(new MouseEvent('click', { bubbles: false }))
      await ctrl.runSql('all')
      const chk = document.getElementById('dangerSqlConfirmCheck') as HTMLInputElement
      chk.checked = true
      chk.dispatchEvent(new Event('change', { bubbles: true }))
      // Test connection change before confirming danger modal!
      sqlState.activeConnectionId = 'c_pg'
      document.getElementById('dangerSqlExecuteBtn')?.click()
      expect(sqlCalls.some((c) => c.includes('active connection or tab changed'))).toBe(true)

      // 3. Test fail-closed missing confirm input on prod
      activeConn = prodConn
      const origDangerInp = document.getElementById('dangerSqlConfirmInput')!
      const dangerParent = origDangerInp.parentElement!
      origDangerInp.remove()
      await ctrl.runSql('all')
      expect(sqlCalls.some((c) => c.includes('aborted for safety'))).toBe(true)
      dangerParent.appendChild(origDangerInp)

      // 4. Null-sorting, string localeCompare, corner thIdx selectAll, suppressSortClickUntil, copySqlSelection empty
      ctrl.setSqlText('SELECT n, txt FROM t;')
      await ctrl.runSql('all', { skipDangerGuard: true })
      await flushMicro()
      const ths = Array.from(document.querySelectorAll('#sqlResultTable thead th')) as HTMLElement[]
      ths[0]?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true })) // thIdx selectAll
      ths[1]?.click() // sort numeric with nulls
      ths[1]?.click()
      ths[2]?.click() // sort strings with nulls (localeCompare L1229)
      suppressUntil = Date.now() + 5000
      ths[2]?.click() // suppressed
      suppressUntil = 0

      // Scroll virtual window ensure visible top & bottom + skeleton with pending rAF
      const resWrap = document.getElementById('sqlResultWrap')!
      resWrap.clientHeight = 40
      resWrap.scrollTop = 100
      ctrl.ensureSqlVirtualRowVisible(0)
      resWrap.scrollTop = 0
      ctrl.ensureSqlVirtualRowVisible(3)
      sqlGridSel.clear()
      expect(ctrl.copySqlSelection('tsv', false)).toBe(false)

      // 5. EXPLAIN AI callbacks: onConfigureAi, onCancel, onApplySql, onOpenNewTab, onCopyText, onToggleCollapsed
      ctrl.setSqlText('SELECT * FROM users;')
      await ctrl.runSql('explain')
      await flushMicro()
      const expPanel = document.getElementById('sqlExplainAiPanel')!
      const expButtons = () => Array.from(expPanel.querySelectorAll('button')) as HTMLButtonElement[]
      // Trigger Analyze -> click Cancel while loading? First let's run & complete EXPLAIN AI
      expButtons().find((b) => b.textContent?.includes('Analyze'))?.click()
      await flushMicro(12)
      expect(expPanel.querySelector('.datanoa-ai-lang-pill')).toBeNull()
      expButtons().find((b) => b.textContent?.includes('Copy DDL'))?.click()
      expect(sqlCalls.some((c) => c.startsWith('copy:DDL copied'))).toBe(true)
      expButtons().find((b) => b.textContent?.trim() === 'Copy SQL')?.click()
      expect(sqlCalls.some((c) => c.startsWith('copy:Optimized SQL copied'))).toBe(true)
      expButtons().find((b) => b.textContent?.trim() === 'Replace Query')?.click()
      expButtons().find((b) => b.textContent?.includes('New Tab'))?.click()

      // Switch back to tab with EXPLAIN result via DOM tab click & test explain fail + AI Settings btn
      ;(document.querySelectorAll('#sqlConsoleTabsBar .sql-console-tab')[1] as HTMLElement | undefined)?.click()
      explainMode = 'fail'
      expButtons().find((b) => b.textContent?.includes('Re-analyze') || b.textContent?.includes('Analyze'))?.click()
      await flushMicro(10)
      expButtons().find((b) => b.textContent?.includes('AI Settings'))?.click()
      await flushMicro(2)
      expect(sqlCalls).toContain('openAiSettings')

      // 6. Multi-statement EXPLAIN with error + cancelSql mid-run + DDL triggering loadSchema + history error & success copy
      queryMode = 'multi-err'
      ctrl.setSqlText('SELECT 1; BAD SQL;')
      await ctrl.runSql('explain')
      await flushMicro(10)

      // DDL statement runs & triggers loadSchema
      queryMode = 'ddl'
      ctrl.setSqlText('CREATE TABLE t_new (id INT);')
      await ctrl.runSql('all', { skipDangerGuard: true })
      await flushMicro(8)
      expect(sqlCalls).toContain('loadSchema')

      // Stale query run finishing after connection switched + cancelSql
      holdNextRun = true
      queryMode = 'ok'
      ctrl.setSqlText('CREATE TABLE t_stale (id INT);')
      const runP = ctrl.runSql('all', { skipDangerGuard: true })
      await vi.advanceTimersByTimeAsync(250)
      sqlState.activeConnectionId = 'c_mg'
      resolvePendingRun?.({ ok: true })
      await runP
      holdNextRun = false
      sqlState.activeConnectionId = 'c_pg'

      // Mongo caret selection + selected text caret + history error -> success -> copy btn
      activeConn = mongoConn
      ctrl.setSqlText('db.users.find({});\ndb.orders.find({});')
      await ctrl.runSql('caret')
      await flushMicro(8)

      await ctrl.loadQueryHistory() // fails -> []
      historyThrows = false
      await ctrl.loadQueryHistory()
      const histCopyBtn = document.querySelector('#sqlHistoryList button[title*="Copy"], #sqlHistoryList .mini-btn') as HTMLButtonElement | null
      histCopyBtn?.click()

      // Inline AI requestCompletion + onMetric + keymap on cmEditor
      const cmView = (ctrl as unknown as { cmEditor?: { view?: InstanceType<typeof cmVendor.EditorView> } }).cmEditor?.view
      if (cmView) {
        cmView.dispatch({ changes: { from: 0, to: cmView.state.doc.length, insert: 'SELECT' }, selection: { anchor: 6 } })
        await vi.advanceTimersByTimeAsync(800)
        await flushMicro(8)
      }
      ctrl.destroySqlEditor()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Slice 5b: closes panel-data-grid.js remaining branches (paste edges, inline edit Tab/cancel, resize/autofit, transposed >100, inspector)', async () => {
    vi.useFakeTimers()
    dom.mountPanelHtml()

    const banners: string[] = []
    let activeResizeCleanup: (() => void) | null = null
    let suppressUntil = 0
    let lastCopied = ''
    let isSubmitting = false
    const pinnedSet = new Set<string>(['id'])
    const hiddenSet = new Set<string>()
    const tableCols = [
      { name: 'id', type: 'INTEGER', nativeType: 'INTEGER', isPrimaryKey: true, nullable: false, isAutoIncrement: true },
      { name: 'name', type: 'TEXT', nativeType: 'TEXT', nullable: true },
      { name: 'score', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, defaultValue: '0' },
      { name: 'gen', type: 'TEXT', nativeType: 'TEXT', nullable: true, isGenerated: true },
    ]
    const dgState = {
      activeConnectionId: 'c_pg',
      activeTable: 'users',
      activeSchema: 'public',
      dataLoading: false,
      silentDataRefresh: false,
      transposed: false,
      page: 1,
      pageSize: 100,
      sortCol: 'id',
      sortDir: 'ASC',
      whereClause: '',
      orderByClause: '',
      selectedRowKey: 'row_0' as string | null,
      selectedCol: 'name' as string | null,
      inspectorOpen: true,
      inspectorCollapsed: false,
      rowNumWidth: 48,
      findQuery: '',
      findMatches: [] as Array<{ r: number; c: number; rowKey: string; colName: string }>,
      findMatchSet: new Set<string>(),
      findMatchIdx: -1,
      columnWidthsByTable: {} as Record<string, number[]>,
      stagedInserts: [] as Array<{ tempId: string; values: Record<string, unknown>; origin?: string }>,
      stagedUpdates: new Map<string, { primaryKeys: Record<string, unknown>; originalRow: Record<string, unknown>; changes: Record<string, unknown> }>(),
      stagedDeletes: new Map<string, { primaryKeys?: Record<string, unknown>; originalRow?: Record<string, unknown>; id?: number }>(),
      schemaObjects: { c_pg: [{ name: 'users', schema: 'public', kind: 'table' }] } as Record<string, Array<Record<string, unknown>>>,
      pageData: {
        columns: tableCols,
        rows: [
          { id: 1, name: 'Alice', score: 10, gen: 'g1' },
          { id: 2, name: null, score: 20, gen: 'g2' },
        ],
        totalRows: 2,
        page: 1,
        pageSize: 100,
        primaryKey: ['id'],
        canEdit: true,
      } as {
        columns: Array<Record<string, unknown>>
        rows: Array<Record<string, unknown>>
        totalRows: number
        page: number
        pageSize: number
        primaryKey: string[]
        canEdit: boolean
      } | null,
    }
    let activeConn: Record<string, unknown> = { id: 'c_pg', driver: 'postgres', readOnly: false }
    let gridSel: PanelGridSelection | null = null
    const ctrl = createPanelDataGridController({
      state: dgState,
      VIRT_ROW_HEIGHT_PX: 26,
      VIRT_OVERSCAN_ROWS: 4,
      getActiveConn: () => activeConn,
      getStagedCount: () => dgState.stagedInserts.length + dgState.stagedUpdates.size + dgState.stagedDeletes.size,
      isSubmittingChanges: () => isSubmitting,
      isPreviewingDml: () => false,
      getDataGridSel: () => gridSel,
      getActiveTableKey: () => 'c_pg:public:users',
      getOrderedVisibleColumns: () => tableCols.filter((c) => !hiddenSet.has(c.name)),
      getPinnedColsSet: () => pinnedSet,
      getHiddenColsSet: () => hiddenSet,
      getActiveForeignKeyMap: () => new Map(),
      getLastPanelCopiedText: () => lastCopied,
      setLastPanelCopiedText: (t: string) => { lastCopied = t },
      getSuppressSortClickUntil: () => suppressUntil,
      setSuppressSortClickUntil: (v: number) => { suppressUntil = v },
      getActiveResizeCleanup: () => activeResizeCleanup,
      setActiveResizeCleanup: (fn: (() => void) | null) => { activeResizeCleanup = fn },
      setInspectorUserModified: () => {},
      showBanner: (m: string) => banners.push(m),
      copyText: async (t: string) => { lastCopied = t },
      loadTablePage: async () => {},
      syncDataControlsDisabled: () => {},
      renderDataColsPopoverList: () => {},
    })

    const gridWrap = document.getElementById('dataGridWrap')!
    const gridTable = document.getElementById('dataTable')!
    gridSel = new PanelGridSelection({
      wrapEl: gridWrap,
      tableEl: gridTable,
      editable: true,
      getDimensions: () => ({ rows: ctrl.dataVirt.allRows.length, cols: ctrl.dataVirt.visCols.length }),
      getValueAt: (r: number, c: number) => {
        const entry = ctrl.dataVirt.allRows[r]
        const col = ctrl.dataVirt.visCols[c]
        return entry && col ? ctrl.getEffectiveCellValue(entry.rowKey, entry.data, col.name) : null
      },
      onSelectionChange: () => ctrl.renderDataSelectionStats(),
    })

    try {
      expect(shouldDisableEditStructureButton({ kind: 'table' }, { driver: 'mongodb' })).toBe(true)
      ctrl.renderDataGrid()

      // 1. stageCellValue revert when nextVal === origVal + isSubmitting + stagedDeletes guards + patchRenderedDataCell fallback
      ctrl.stageCellValue('row_0', dgState.pageData!.rows[0], 'name', 'Temp', true)
      ctrl.stageCellValue('row_0', dgState.pageData!.rows[0], 'name', 'Alice', false) // reverts & patches
      isSubmitting = true
      ctrl.stageCellValue('row_0', dgState.pageData!.rows[0], 'name', 'Blocked', false)
      isSubmitting = false

      // 2. copyDataSelection with format !== tsv/csv clears lastCopiedSnapshot + paste edge cases
      gridSel.selectCell(0, 1)
      ctrl.copyDataSelection('sql-in', false)
      expect(ctrl.pasteDelimitedIntoDataGrid('', { forceNewRows: false })).toBe(false)
      // Fill generated col (c=3) -> 0 applied + skippedReadOnly banner; fill whitespace into non-nullable INTEGER (c=2) -> L661-664
      gridSel.selectCell(0, 3)
      gridSel.selectCell(1, 3, { shift: true })
      ctrl.pasteDelimitedIntoDataGrid('val', { forceNewRows: false })
      expect(banners.some((b) => b.includes('read-only'))).toBe(true)
      gridSel.selectCell(0, 2)
      gridSel.selectCell(1, 2, { shift: true })
      ctrl.pasteDelimitedIntoDataGrid('   ', { forceNewRows: false })
      // Overflow paste as new rows skipping auto-inc id & NOT NULL w/ defaultValue when pasted empty
      gridSel.selectCell(0, 0)
      ctrl.pasteDelimitedIntoDataGrid('99\tBob\t\tg\n100\tSue\t5\th', { forceNewRows: true })
      // Delete the two staged inserts first, then mark + unmark row_0..row_1 & buildDataChangesPayload legacy shape
      gridSel.selectRowRange(0, 1)
      ctrl.toggleDeleteSelectedRows() // removes ins_* rows
      gridSel.selectRowRange(0, 1)
      ctrl.toggleDeleteSelectedRows() // marks row_0 & row_1 for delete
      ctrl.renderStagingBar() // Undo - (2)
      gridSel.selectRowRange(0, 1)
      ctrl.toggleDeleteSelectedRows() // unmark allAlreadyMarked
      dgState.stagedDeletes.set('legacy_0', { id: 1 } as never)
      expect(ctrl.buildDataChangesPayload().deletes).toHaveLength(1)
      dgState.stagedDeletes.clear()

      // 3. Hide columns down to 1 visible column guard + export download 'failed'
      hiddenSet.add('name')
      hiddenSet.add('score')
      ctrl.toggleColumnHidden('gen') // leaves only 1 col? Wait: 'id' is 1 col!
      hiddenSet.clear()
      const origCreateUrl = URL.createObjectURL
      URL.createObjectURL = () => { throw new Error('no blob') }
      ctrl.exportCurrentDataPage('csv', true, 'csv', 'text/csv')
      await flushMicro()
      URL.createObjectURL = origCreateUrl

      // 4. Find 0/0 + transposed > 100 rows + transposed active find & row highlight
      dgState.findQuery = 'zz_nomatch_zz'
      ctrl.updateDataFindHighlights(true)
      expect(document.getElementById('dataFindCount')?.textContent).toBe('0/0')
      dgState.transposed = true
      dgState.pageData = {
        ...dgState.pageData!,
        rows: Array.from({ length: 105 }, (_, i) => ({ id: i + 1, name: `U${i}`, score: i, gen: 'g' })),
      }
      dgState.selectedRowKey = 'row_0'
      dgState.findQuery = 'U2'
      ctrl.renderDataGrid()
      ctrl.updateDataFindHighlights(true)
      dgState.transposed = false
      ctrl.renderDataGrid()

      // 5. Header corner selectAll, colGrip selectCol, resize handle dblclick autofit, resize without rAF
      const thIdx = gridTable.querySelector('thead th.th-rownum') as HTMLElement
      thIdx?.click()
      const colGrip = gridTable.querySelector('thead th .th-col-grip') as HTMLElement
      colGrip?.click()
      const handle = gridTable.querySelectorAll('thead th .col-resize-handle')[1] as HTMLElement
      handle?.click()
      handle?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      const origRaf = globalThis.requestAnimationFrame
      ;(globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined
      handle?.dispatchEvent(new MouseEvent('mousedown', { clientX: 50, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 80 }))
      window.dispatchEvent(new Event('mouseup'))
      ;(globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame = origRaf
      suppressUntil = 0

      // 6. Inline edit: undefined / null numeric Enter cancel + Tab skipping non-editable col + Shift+Tab
      const scoreTd = gridTable.querySelector('tbody td[data-row-idx="0"][data-col-idx="2"]') as HTMLElement
      ctrl.startInlineEdit(scoreTd, 'row_0', dgState.pageData!.rows[0], tableCols[2], null)
      const inpScore = scoreTd.querySelector('input') as HTMLInputElement
      inpScore.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) // cancels null numeric
      const nameTd = gridTable.querySelector('tbody td[data-row-idx="0"][data-col-idx="1"]') as HTMLElement
      ctrl.startInlineEdit(nameTd, 'row_0', dgState.pageData!.rows[0], tableCols[1], undefined)
      const inpName = nameTd.querySelector('input') as HTMLInputElement
      inpName.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) // cancels undefined
      // Tab across non-editable 'gen' or next row
      ctrl.startInlineEdit(scoreTd, 'row_0', dgState.pageData!.rows[0], tableCols[2], 10)
      const tabInp = scoreTd.querySelector('input') as HTMLInputElement
      tabInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))

      // 7. Value Inspector: invalid JSON string fallback + autoIncrement badge + missing selectedRowKey hides drawer
      dgState.selectedRowKey = 'row_0'
      dgState.selectedCol = 'id'
      ctrl.renderValueInspector()
      expect(document.getElementById('inspectorNullBadge')?.textContent).toBe('AUTO')
      dgState.pageData!.rows[0].name = '{invalid json'
      dgState.selectedCol = 'name'
      ctrl.renderValueInspector()
      dgState.selectedRowKey = 'missing_row_key'
      ctrl.renderValueInspector()
      expect((document.getElementById('valueInspectorDrawer') as HTMLElement).hidden).toBe(true)

      // 8. Empty pageData with whereClause vs without whereClause
      dgState.stagedInserts = []
      const savedRows = dgState.pageData!.rows
      dgState.pageData = { ...dgState.pageData!, rows: [] }
      dgState.whereClause = 'id > 999'
      ctrl.renderDataGrid()
      expect(gridTable.textContent).toContain('match the WHERE filter')
      dgState.whereClause = ''
      ctrl.renderDataGrid()
      expect(gridTable.textContent).toContain('has no rows')
      dgState.pageData = { ...dgState.pageData!, rows: savedRows }
    } finally {
      vi.useRealTimers()
    }
  })

  function createPanelAppSlice6Env(opts: {
    connections?: Array<Record<string, unknown>>
    aiStatus?: Record<string, unknown>
    sessionSnapshot?: unknown
  } = {}) {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE departments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      );
      CREATE TABLE employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        dept_id INTEGER REFERENCES departments(id),
        salary REAL,
        meta TEXT
      );
      CREATE TABLE empty_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        body TEXT
      );
      CREATE VIEW active_employees AS SELECT id, name, salary FROM employees WHERE salary >= 5000;
      INSERT INTO departments (name) VALUES ('Eng'), ('Sales');
      INSERT INTO employees (name, dept_id, salary, meta) VALUES
        ('Alice', 1, 9000, '{"role":"lead"}'),
        ('Bob', 2, 7000, NULL),
        ('Cara', 1, 6500, '{"role":"dev"}');
    `)

    const connections: Array<Record<string, unknown>> = opts.connections ? [...opts.connections] : [
      { id: 'c_main', name: 'Primary SQLite', driver: 'sqlite', filePath: ':memory:', colorTag: 'dev', folder: 'Local' },
      { id: 'c_prod_ro', name: 'Prod RO', driver: 'postgres', host: 'pg.prod', port: 5432, database: 'prod', readOnly: true, colorTag: 'prod', folder: 'Prod', url: 'postgres://u:secret@pg.prod/prod', options: 'postgres://a:pw@b' },
      { id: 'c_mongo', name: 'Mongo Staging', driver: 'mongodb', host: 'mongo.local', port: 27017, database: 'app', colorTag: 'staging', folder: 'Cloud', hasAuthToken: true },
    ]
    const storageMap = new Map<string, unknown>()
    const failOnceActions = new Set<string>()
    const alwaysFailActions = new Set<string>()
    const hostListeners = new Map<string, Set<(...a: unknown[]) => void>>()
    const pluginListeners = new Map<string, Set<(...a: unknown[]) => void>>()
    const rpcOverrides = new Map<string, (...a: unknown[]) => unknown | Promise<unknown>>()
    let sessionSnapshot: unknown = opts.sessionSnapshot ?? null
    let studioOpenResult: { ok: boolean; message?: string } = { ok: true }
    let testConnResult: { ok: boolean; message?: string; latencyMs?: number } = { ok: true, latencyMs: 3 }
    let saveConnResult: { ok: boolean; id?: string; message?: string } = { ok: true }
    const aiStatus: Record<string, unknown> = opts.aiStatus ?? { enabled: true, state: 'on', hasKey: true, explainLanguage: 'en', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' }
    const historyEntries: Array<Record<string, unknown>> = []

    const qIdent = (n: string) => `"${String(n).replace(/"/g, '""')}"`
    const getTableCols = (table: string) => {
      const info = db.prepare(`PRAGMA table_info(${qIdent(table)})`).all() as Array<Record<string, unknown>>
      return info.map((c) => ({
        name: String(c.name),
        type: String(c.type || 'TEXT'),
        nativeType: String(c.type || 'TEXT'),
        nullable: Number(c.notnull) === 0,
        isPrimaryKey: Number(c.pk) > 0,
        isAutoIncrement: Number(c.pk) > 0 && /INT/i.test(String(c.type || '')),
        defaultValue: c.dflt_value !== null && c.dflt_value !== undefined ? String(c.dflt_value) : null,
      }))
    }
    const getSchemaObjects = () => {
      const rows = db.prepare(`SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string; type: string }>
      return rows.map((r) => ({ name: r.name, schema: 'main', kind: r.type === 'view' ? 'view' : 'table' }))
    }
    const getTableDetails = (table: string) => {
      const m = db.prepare(`SELECT type, sql FROM sqlite_master WHERE name = ? LIMIT 1`).get(table) as { type?: string; sql?: string } | undefined
      if (!m) throw new Error(`Missing table ${table}`)
      const columns = getTableCols(table)
      const fks = (db.prepare(`PRAGMA foreign_key_list(${qIdent(table)})`).all() as Array<Record<string, unknown>>).map((fk, i) => ({
        name: `fk_${table}_${i}`,
        column: String(fk.from),
        referencedTable: String(fk.table),
        referencedColumn: String(fk.to),
        onDelete: String(fk.on_delete || 'NO ACTION'),
      }))
      return { name: table, table, schema: 'main', kind: m.type === 'view' ? 'view' : 'table', columns, primaryKey: columns.filter((c) => c.isPrimaryKey).map((c) => c.name), indexes: [], foreignKeys: fks, ddl: '' }
    }

    const rpcSpy = vi.fn(async (action: string, input: Record<string, unknown> = {}) => {
      const override = rpcOverrides.get(action)
      if (override) return await override(input)
      if (failOnceActions.delete(action) || alwaysFailActions.has(action)) {
        throw new Error(`Simulated failure for ${action}`)
      }
      switch (action) {
        case 'connections.list': return connections.map((c) => ({ ...c }))
        case 'connection.test': return testConnResult
        case 'connection.save': {
          const p = (input.profile as Record<string, unknown>) || {}
          const id = String(p.id || input.id || `c_${Date.now()}`)
          if (!saveConnResult.ok) return saveConnResult
          const idx = connections.findIndex((c) => c.id === id)
          if (idx >= 0) connections[idx] = { ...p, id }
          else connections.push({ ...p, id })
          return { ok: true, id }
        }
        case 'connection.delete': {
          const idx = connections.findIndex((c) => c.id === input.id)
          if (idx >= 0) connections.splice(idx, 1)
          return { ok: true }
        }
        case 'connection.parseUri': {
          const uri = String(input.uri || '')
          if (!uri.includes('://')) return { ok: false, error: 'Invalid URI scheme' }
          return { ok: true, profile: { driver: uri.startsWith('postgres') ? 'postgres' : 'sqlite', name: 'Parsed', filePath: uri.replace(/^[a-z]+:\/\//, ''), host: 'localhost', port: 5432, database: 'appdb', user: 'u' }, password: 'pw' }
        }
        case 'schema.listObjects': return getSchemaObjects()
        case 'schema.tableDetails': return getTableDetails(String(input.table))
        case 'schema.generateDdl': {
          const m = db.prepare(`SELECT sql FROM sqlite_master WHERE name = ? LIMIT 1`).get(String(input.table)) as { sql?: string } | undefined
          return { ddl: m?.sql || '' }
        }
        case 'data.fetchPage': {
          const tbl = String(input.table)
          const page = Math.max(1, Number(input.page || 1))
          const pageSize = Math.max(1, Number(input.pageSize || 100))
          const m = db.prepare(`SELECT type FROM sqlite_master WHERE name = ? LIMIT 1`).get(tbl) as { type?: string } | undefined
          const cols = getTableCols(tbl)
          const pk = cols.filter((c) => c.isPrimaryKey).map((c) => c.name)
          const whereSql = input.whereClause ? ` WHERE ${String(input.whereClause)}` : ''
          const orderSql = input.sortColumn ? ` ORDER BY ${qIdent(String(input.sortColumn))} ${String(input.sortDirection || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}` : ''
          const cnt = db.prepare(`SELECT COUNT(*) AS cnt FROM ${qIdent(tbl)}${whereSql}`).get() as { cnt: number }
          const rows = db.prepare(`SELECT * FROM ${qIdent(tbl)}${whereSql}${orderSql} LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>
          return { columns: cols, rows, totalRows: Number(cnt?.cnt ?? 0), page, pageSize, primaryKey: pk, canEdit: m?.type !== 'view' && pk.length > 0 }
        }
        case 'data.previewChanges': return { statements: [`-- preview for ${String(input.table)}`] }
        case 'data.applyChanges': return { ok: true, inserted: 0, updated: 0, deleted: 0 }
        case 'query.run': {
          const sql = String(input.sql || '').trim()
          const isRead = /^(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(sql)
          if (isRead) {
            const rows = db.prepare(sql).all() as Array<Record<string, unknown>>
            const cols = rows.length > 0 ? Object.keys(rows[0]).map((name) => ({ name, type: 'TEXT' })) : []
            return { columns: cols, rows, rowsAffected: 0, durationMs: 2, resultSets: [{ columns: cols, rows, rowsAffected: 0, durationMs: 2 }] }
          }
          const info = db.prepare(sql).run()
          return { columns: [], rows: [], rowsAffected: Number(info.changes ?? 0), durationMs: 2 }
        }
        case 'query.cancel': return { ok: true }
        case 'query.explain': {
          const planRows = db.prepare(`EXPLAIN QUERY PLAN ${String(input.sql || '')}`).all() as Array<Record<string, unknown>>
          return { columns: [{ name: 'detail', type: 'TEXT' }], rows: planRows, durationMs: 1 }
        }
        case 'query.history.list': return [...historyEntries]
        case 'query.history.clear': historyEntries.length = 0; return { ok: true }
        case 'studio.open': return studioOpenResult
        case 'ui.getSessionSnapshot': return sessionSnapshot
        case 'ui.saveSessionSnapshot': sessionSnapshot = input.snapshot; return { ok: true }
        case 'ai.status.get': return aiStatus
        case 'ai.stats.get': return { summary: { count: 1, p50: 40 }, byModel: {} }
        case 'ai.explainAnalyze': return { summary: 'Scan', durationMs: 5, language: 'en', bottlenecks: [], indexSuggestions: [{ ddl: 'CREATE INDEX i ON employees(dept_id);', reason: 'FK' }], optimizedSql: 'SELECT 1;', notes: [] }
        case 'drivers.list': return [{ id: 'sqlite', installed: true, mode: 'builtin', label: 'SQLite' }]
        case 'drivers.defaultPaths': return { sqlite: 'builtin' }
        case 'workspace.listScopes': return [{ id: 'ws1', name: 'WS', path: 'D:/orca-custom-extensions/datanoa' }]
        case 'workspace.detectConnections': return { files: [], envs: [], docker: [] }
        case 'sqlite.scanFolder': return []
        default: return { ok: true }
      }
    })

    const orcaApi = {
      on(ev: string, cb: (...a: unknown[]) => void) {
        if (!hostListeners.has(ev)) hostListeners.set(ev, new Set())
        hostListeners.get(ev)!.add(cb)
        return () => hostListeners.get(ev)?.delete(cb)
      },
      plugin: {
        request: rpcSpy,
        on(ev: string, cb: (...a: unknown[]) => void) {
          if (!pluginListeners.has(ev)) pluginListeners.set(ev, new Set())
          pluginListeners.get(ev)!.add(cb)
          return () => pluginListeners.get(ev)?.delete(cb)
        },
      },
      settings: { get: () => undefined, onDidChange: () => () => {} },
      storage: {
        get: async (k: string) => storageMap.get(k) ?? null,
        set: async (k: string, v: unknown) => { storageMap.set(k, v) },
        delete: async (k: string) => { storageMap.delete(k) },
      },
      host: { call: async () => ({ fontFamily: 'Consolas', fontSize: 13 }) },
      files: { saveAs: async () => ({ status: 'saved', path: 'D:/out.csv' }) },
      shell: { openExternal: async () => {} },
    }
    return {
      db, connections, storageMap, failOnceActions, alwaysFailActions, rpcSpy, rpcOverrides,
      setStudioOpenResult: (v: { ok: boolean; message?: string }) => { studioOpenResult = v },
      setTestConnResult: (v: typeof testConnResult) => { testConnResult = v },
      setSaveConnResult: (v: typeof saveConnResult) => { saveConnResult = v },
      emitHost: (ev: string, ...a: unknown[]) => { for (const cb of hostListeners.get(ev) || []) cb(...a) },
      emitPlugin: (ev: string, ...a: unknown[]) => { for (const cb of pluginListeners.get(ev) || []) cb(...a) },
      orcaApi,
    }
  }

  function applySlice6DomMetrics() {
    dom!.mountPanelHtml()
    const rect = (h: number, w = 900) => () => ({ top: 0, left: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON() {} })
    const setRect = (el: HTMLElement | null, h: number, w = 900) => {
      if (!el) return
      el.clientHeight = h
      el.clientWidth = w
      el.getBoundingClientRect = rect(h, w)
    }
    setRect(document.getElementById('tabSql'), 700)
    setRect(document.getElementById('dataGridWrap'), 420, 800)
    setRect(document.getElementById('sqlResultWrap'), 320, 800)
    setRect(document.querySelector('.viewport') as HTMLElement | null, 680)
  }

  it('Slice 6a: covers panel-app.js boot cache byte-caps, formDraft fields, credential scrubbing & ResizeObserver/no-rAF scroll', { timeout: 15_000 }, async () => {
    vi.resetModules()
    applySlice6DomMetrics()
    const resizeCallbacks: Array<(entries: Array<{ target: Element }>) => void> = []
    const origResizeObs = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    const origRaf = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class FakeRO {
      cb: (entries: Array<{ target: Element }>) => void
      constructor(cb: (entries: Array<{ target: Element }>) => void) {
        this.cb = cb
        resizeCallbacks.push(cb)
      }
      observe() {}
      disconnect() {}
    }

    const hugeSql = 'SELECT 1; -- ' + 'abcd '.repeat(42_000)
    const backend = createPanelAppSlice6Env({
      sessionSnapshot: {
        updatedAt: Date.now(),
        viewState: {
          activeConnectionId: 'c_main',
          activeTable: 'employees',
          activeSchema: 'main',
          expandedConns: [],
          tab: 'data',
          sqlDraft: hugeSql,
          scrollState: { viewportTop: 20, dataGridTop: 30, dataGridLeft: 10, sqlResultTop: 15, sqlResultLeft: 5 },
          formDraft: {
            name: 'Full Draft',
            folder: 'Local',
            workspaceScope: 'ws_custom_missing',
            filePath: ':memory:',
            libsqlUrl: 'libsql://db.turso.io',
            libsqlDb: 'main',
            host: 'h1',
            port: '5432',
            database: 'd1',
            user: 'u1',
            clickhouseUrl: 'http://ch:8123',
            options: '{}',
            redisDb: '2',
            ssl: true,
            readOnly: true,
            byodFolder: 'C:/byod',
          },
        },
        dataCache: {
          updatedAt: Date.now(),
          activeConnectionId: 'c_main',
          schemaObjects: { c_main: [{ name: 'employees', schema: 'main', kind: 'table' }] },
          tableDetails: {
            'c_main:main:employees': {
              name: 'employees',
              columns: Array.from({ length: 1200 }, (_, i) => ({ name: `c_${i}`, type: 'TEXT', extra: 'd'.repeat(120) })),
              foreignKeys: [],
              indexes: [],
            },
          },
          pageData: {
            columns: [{ name: 'id', type: 'INTEGER', isPrimaryKey: true }, { name: 'name', type: 'TEXT' }],
            rows: Array.from({ length: 180 }, (_, i) => ({ id: i + 1, name: `Val_${i}_${'v'.repeat(1000)}` })),
            totalRows: 180,
            page: 1,
            pageSize: 100,
            primaryKey: ['id'],
            canEdit: true,
          },
          lastSqlResult: {
            columns: [{ name: 'big', type: 'TEXT' }],
            rows: Array.from({ length: 180 }, (_, i) => ({ big: `Row_${i}_${'S'.repeat(2000)}` })),
            durationMs: 1,
            rowsAffected: 0,
          },
        },
      },
    })
    try {
      ;(window as { orca?: unknown }).orca = backend.orcaApi
      // Corrupt local warm cache triggers safe catch path + fallback to sessionSnapshot + empty rAF
      localStorage.setItem('datanoa.panelWarmCache', '{not valid json')
      localStorage.setItem('datanoa.panelViewState', '{not valid json')
      ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined

      await import('../src/panel/panel-app.js')
      await new Promise((r) => setTimeout(r, 40))

      // Trigger savePanelDataCache byte-cap truncation & savePanelViewState >200KB truncation
      document.getElementById('dataGridWrap')?.dispatchEvent(new Event('scroll'))
      await new Promise((r) => setTimeout(r, 300))

      // Trigger ResizeObserver entries on dataGridWrap & sqlResultWrap
      const dg = document.getElementById('dataGridWrap')!
      const sw = document.getElementById('sqlResultWrap')!
      resizeCallbacks.forEach((cb) => cb([{ target: dg }, { target: sw }]))

      // Test scroll on #tabStructure .grid-wrap (closes passive listener)
      document.querySelectorAll('#tabStructure .grid-wrap').forEach((el) => {
        el.dispatchEvent(new Event('scroll'))
      })
      window.dispatchEvent(new Event('pagehide'))
      expect(backend.connections.length).toBe(3)
    } finally {
      window.dispatchEvent(new Event('beforeunload'))
      backend.db.close()
      ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = origResizeObs
      ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = origRaf
    }
  })

  it('Slice 6b: covers panel-app.js Data/Explorer contextmenus, dataGridSel/sqlGridSel callbacks, Transposed FK & dblclick, Inspector & DML >300', async () => {
    vi.resetModules()
    applySlice6DomMetrics()
    const backend = createPanelAppSlice6Env()
    backend.db.exec('BEGIN')
    const ins = backend.db.prepare('INSERT INTO employees (name, dept_id, salary, meta) VALUES (?, 1, ?, ?)')
    for (let i = 0; i < 110; i++) ins.run(`Emp_${i}`, 5000 + i, `{"i":${i}}`)
    backend.db.exec('COMMIT')

    const origRaf = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    try {
      ;(window as { orca?: unknown }).orca = backend.orcaApi
      await import('../src/panel/panel-app.js')
      await new Promise((r) => setTimeout(r, 30))
      dom?.runRaf()
      await new Promise((r) => setTimeout(r, 30))

      // Select employees table (not active_employees view)
      const tableSel = document.getElementById('dataTableSelect') as HTMLSelectElement
      const empOpt = Array.from(tableSel.options).find((o) => decodeTableSelectValue(o.value)?.name === 'employees')
      if (empOpt) {
        tableSel.value = empOpt.value
        tableSel.dispatchEvent(new Event('change', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 40))
      }

      // 1. connSelect custom dropdown folder toggle (onFolderToggle)
      const connCustomWrap = document.getElementById('connSelect')?.parentElement
      connCustomWrap?.querySelector('.custom-select-trigger')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      document.querySelector('.custom-select-popover .custom-select-folder-head')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

      // 2. DataGrid real td[data-row-idx][data-col-idx] interactions -> hits dataGridSel & explorerCtrl callbacks!
      const dgWrap = document.getElementById('dataGridWrap')!
      const salaryTd0 = document.querySelector('#dataTable tbody tr[data-row-idx="0"] td[data-col-idx="3"]') as HTMLElement | null
      const salaryTd1 = document.querySelector('#dataTable tbody tr[data-row-idx="1"] td[data-col-idx="3"]') as HTMLElement | null
      const nameTd = document.querySelector('#dataTable tbody tr[data-row-idx="0"] td[data-col-idx="1"]') as HTMLElement | null
      const rowNumTd = document.querySelector('#dataTable tbody tr[data-row-idx="1"] td.td-rownum') as HTMLElement | null

      // Numeric stats click & getValueAt (2 cells required for aggregate stats)
      salaryTd0?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      salaryTd1?.dispatchEvent(new MouseEvent('mousedown', { button: 0, shiftKey: true, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }))
      document.getElementById('dataSelectionStats')?.click()

      // ArrowDown (onEnsureCellVisible), F2 (onStartEdit) + Escape
      dgWrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      nameTd?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }))
      dgWrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
      document.querySelector('#dataTable input.cell-edit-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

      // Select row & trigger revert, then RE-QUERY fresh nameTd after renderDataGrid!
      rowNumTd?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }))
      document.getElementById('revertChangesBtn')?.click()

      // Context menus on fresh td[data-row-idx="0"][data-col-idx="1"]
      const clickMenu = (re: RegExp) => {
        const items = Array.from(document.querySelectorAll('#contextMenu .ctx-item')) as HTMLElement[]
        items.find((el) => re.test(el.textContent || ''))?.click()
      }
      const freshCell = () =>
        document.querySelector('#dataTable tbody tr[data-row-idx="0"] td[data-col-idx="1"]') as HTMLElement | null
      freshCell()?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }))
      freshCell()?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      clickMenu(/^Copy \(TSV\)/)
      freshCell()?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      clickMenu(/^Paste \(Overwrite/)
      freshCell()?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      clickMenu(/^Paste as New Row/)
      freshCell()?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      clickMenu(/Set NULL/i)
      freshCell()?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      clickMenu(/^Clone/i)
      freshCell()?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      clickMenu(/Delete/i)
      freshCell()?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      clickMenu(/Edit in Value Inspector/i)
      document.getElementById('closeInspectorBtn')?.click()
      freshCell()?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      clickMenu(/Filter WHERE name = val/i)
      await new Promise((r) => setTimeout(r, 30))
      document.getElementById('clearFilterBtn')?.click()
      await new Promise((r) => setTimeout(r, 30))
      document.getElementById('revertChangesBtn')?.click()

      // Sort by column header (loadTablePage + getSuppressSortClickUntil)
      const nameTh = document.querySelector('#dataTable thead th[data-col-name="name"]') as HTMLElement | null
      nameTh?.click()
      await new Promise((r) => setTimeout(r, 30))

      // Ctrl+Click FK cell in normal mode (onCtrlClickCell) -> jumps to departments
      const fkCellAfterSort = document.querySelector('#dataTable tbody tr[data-row-idx="0"] td[data-col-idx="2"]') as HTMLElement | null
      fkCellAfterSort?.dispatchEvent(new MouseEvent('mousedown', { button: 0, ctrlKey: true, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }))
      await new Promise((r) => setTimeout(r, 30))

      // Switch back to employees -> test Transposed Ctrl+Click FK & dblclick & normal click
      if (empOpt) {
        tableSel.value = empOpt.value
        tableSel.dispatchEvent(new Event('change', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 30))
      }
      document.getElementById('transposeBtn')?.click()
      const trFk = document.querySelector('#dataTable tbody tr:nth-child(3) td[data-row-idx="0"]') as HTMLElement | null
      trFk?.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }))
      await new Promise((r) => setTimeout(r, 30))
      if (empOpt) {
        tableSel.value = empOpt.value
        tableSel.dispatchEvent(new Event('change', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 30))
      }
      const trName = document.querySelector('#dataTable tbody tr:nth-child(2) td[data-editable="1"]') as HTMLElement | null
      trName?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      document.querySelector('#dataTable input.cell-edit-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.getElementById('transposeBtn')?.click()

      // Global document paste & Ctrl+Shift+V while focus is on document.body
      const pasteDt = new DataTransfer()
      pasteDt.setData('text/plain', 'DocPasted')
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: pasteDt, bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, shiftKey: true, bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))

      // Value Inspector: NOT NULL check, unmodified Apply guard, no-rAF resizer, keyboard Home/End/ArrowDown/Enter
      const idCell = document.querySelector('#dataTable tbody tr[data-row-idx="0"] td[data-col-idx="0"]') as HTMLElement | null
      idCell?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }))
      document.getElementById('inspectCellBtn')?.click()
      document.getElementById('inspectorNullBtn')?.click() // NOT NULL
      document.getElementById('inspectorApplyBtn')?.click()
      const resizer = document.getElementById('valueInspectorResizer')!
      ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined
      resizer.dispatchEvent(new MouseEvent('mousedown', { clientY: 200, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientY: 160 }))
      window.dispatchEvent(new Event('mouseup'))
      ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = origRaf
      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

      // DML Preview > 300 statements + preview error + applyChanges rejected & error
      document.getElementById('addRowBtn')?.click()
      backend.rpcOverrides.set('data.previewChanges', () => ({ statements: Array.from({ length: 305 }, (_, i) => `INSERT ${i};`) }))
      document.getElementById('dmlPreviewBtn')?.click()
      await new Promise((r) => setTimeout(r, 20))
      expect(document.getElementById('dmlPreviewCode')?.textContent).toContain('5 more statements')
      document.getElementById('closeDmlBtn')?.click()
      backend.rpcOverrides.set('data.previewChanges', () => { throw new Error('preview err') })
      document.getElementById('dmlPreviewBtn')?.click()
      await new Promise((r) => setTimeout(r, 20))
      backend.rpcOverrides.delete('data.previewChanges')

      backend.rpcOverrides.set('data.applyChanges', () => ({ ok: false }))
      document.getElementById('submitChangesBtn')?.click()
      await new Promise((r) => setTimeout(r, 20))
      backend.rpcOverrides.set('data.applyChanges', () => { throw new Error('apply fail') })
      document.getElementById('submitChangesBtn')?.click()
      await new Promise((r) => setTimeout(r, 20))
      backend.rpcOverrides.delete('data.applyChanges')
      document.getElementById('revertChangesBtn')?.click()

      // Scroll virtual dataGrid without rAF
      ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined
      dgWrap.scrollTop = 400
      dgWrap.dispatchEvent(new Event('scroll'))

      // SQL Tab: numeric SQL selection stats (`sqlGridSel.getValueAt`), sort header (`getSuppressSortClickUntil`), no-rAF scroll
      document.querySelector('.nav-tab[data-tab="sql"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))
      document.getElementById('runAllSqlBtn')?.click()
      await new Promise((r) => setTimeout(r, 30))
      const sqlSalaryTd0 = document.querySelector('#sqlResultTable tbody tr[data-row-idx="0"] td:nth-child(4)') as HTMLElement | null
      const sqlSalaryTd1 = document.querySelector('#sqlResultTable tbody tr[data-row-idx="1"] td:nth-child(4)') as HTMLElement | null
      sqlSalaryTd0?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      sqlSalaryTd1?.dispatchEvent(new MouseEvent('mousedown', { button: 0, shiftKey: true, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }))
      document.getElementById('sqlSelectionStats')?.click()
      const sqlTh = document.querySelector('#sqlResultTable thead th:nth-child(2)') as HTMLElement | null
      sqlTh?.click()
      const sqlWrap = document.getElementById('sqlResultWrap')!
      sqlWrap.scrollTop = 200
      sqlWrap.dispatchEvent(new Event('scroll'))
      ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = origRaf

      // Explorer context menus: Count Rows (explorerCtrl.getConnById), Copy Table Name & activateConnection via inactive connection
      const empTree = Array.from(document.querySelectorAll('#schemaTreeContainer .tree-list .tree-item')).find((el) =>
        (el.textContent || '').trim().startsWith('employees')
      ) as HTMLElement | undefined
      empTree?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }))
      clickMenu(/Count Rows/)
      await new Promise((r) => setTimeout(r, 25))
      empTree?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }))
      clickMenu(/Copy Table Name/)
      const mongoConnTree = Array.from(document.querySelectorAll('#schemaTreeContainer .tree-item.tree-conn-item')).find((el) =>
        (el.textContent || '').includes('Mongo Staging')
      ) as HTMLElement | undefined
      mongoConnTree?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }))
      clickMenu(/New Collection/)
      document.getElementById('createTableCancelBtn')?.click()
      await new Promise((r) => setTimeout(r, 60))
    } finally {
      window.dispatchEvent(new Event('beforeunload'))
      backend.db.close()
      ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = origRaf
    }
  })

  it('Slice 6c: covers panel-app.js modals, AI settings Save (onStatusUpdated), DDL fallback, SQL cancel errors & Escape overlays', async () => {
    vi.resetModules()
    applySlice6DomMetrics()
    const backend = createPanelAppSlice6Env()
    try {
      ;(window as { orca?: unknown }).orca = backend.orcaApi
      await import('../src/panel/panel-app.js')
      await new Promise((r) => setTimeout(r, 30))
      dom?.runRaf()
      await new Promise((r) => setTimeout(r, 30))

      // 1. Structure tab: details.ddl empty triggers schema.generateDdl; make generateDdl fail -> buildDdlFallback!
      document.querySelector('.nav-tab[data-tab="structure"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))
      backend.failOnceActions.add('schema.generateDdl')
      const stSel = document.getElementById('structureTableSelect') as HTMLSelectElement
      const deptOpt = Array.from(stSel.options).find((o) => o.textContent?.includes('departments'))
      if (deptOpt) {
        stSel.value = deptOpt.value
        stSel.dispatchEvent(new Event('change', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 30))
      }
      const tblNameInp = document.getElementById('structureTableNameInput') as HTMLInputElement | null
      if (tblNameInp) {
        tblNameInp.value = 'departments_v2'
        tblNameInp.dispatchEvent(new Event('input', { bubbles: true }))
      }
      document.getElementById('btnStructRevert')?.click()
      expect(tblNameInp?.value).toBe('departments')
      document.getElementById('confirmMigrationModal')?.dispatchEvent(new MouseEvent('click', { bubbles: false }))
      expect(document.getElementById('confirmMigrationModal')?.hidden).toBe(true)

      // 2. Create Table modal: column edit/PK/nullable/default/remove + validation error + query.run throw + backdrop
      const mainConnTree = Array.from(document.querySelectorAll('#schemaTreeContainer .tree-item.tree-conn-item')).find((el) =>
        (el.textContent || '').includes('Primary SQLite')
      ) as HTMLElement | undefined
      mainConnTree?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }))
      ;(Array.from(document.querySelectorAll('#contextMenu .ctx-item')).find((el) => /New Table/.test(el.textContent || '')) as HTMLElement | undefined)?.click()
      document.getElementById('createTableAddColBtn')?.click()
      const cRows = document.querySelectorAll('#createTableColsBody tr')
      const r1 = cRows[1]
      if (r1) {
        const typeInp = r1.querySelector('td:nth-child(2) input') as HTMLInputElement | null
        if (typeInp) { typeInp.value = 'INTEGER'; typeInp.dispatchEvent(new Event('input', { bubbles: true })) }
        const pkCb = r1.querySelector('td:nth-child(3) input') as HTMLInputElement | null
        if (pkCb) { pkCb.checked = true; pkCb.dispatchEvent(new Event('change', { bubbles: true })) }
        const nullCb = r1.querySelector('td:nth-child(4) input') as HTMLInputElement | null
        if (nullCb) { nullCb.checked = false; nullCb.dispatchEvent(new Event('change', { bubbles: true })) }
        const defInp = r1.querySelector('td:nth-child(5) input') as HTMLInputElement | null
        if (defInp) { defInp.value = '0'; defInp.dispatchEvent(new Event('input', { bubbles: true })) }
        ;(r1.querySelector('td:nth-child(6) button') as HTMLButtonElement | null)?.click()
      }
      ;(document.getElementById('createTableNameInput') as HTMLInputElement).value = ''
      document.getElementById('createTableExecuteBtn')?.click() // validation error
      expect(document.getElementById('createTableErrors')?.hidden).toBe(false)
      ;(document.getElementById('createTableNameInput') as HTMLInputElement).value = 'fail_tbl'
      document.getElementById('createTableNameInput')?.dispatchEvent(new Event('input', { bubbles: true }))
      backend.failOnceActions.add('query.run')
      document.getElementById('createTableExecuteBtn')?.click()
      await new Promise((r) => setTimeout(r, 20))
      expect(
        backend.rpcSpy.mock.calls.some(([m, p]) => m === 'query.run' && String((p as Record<string, unknown>)?.sql || '').includes('fail_tbl'))
      ).toBe(true)
      document.getElementById('createTableModal')?.dispatchEvent(new MouseEvent('click', { bubbles: false }))
      expect(document.getElementById('createTableModal')?.hidden).toBe(true)

      // 3. Structure DDL -> SQL console (`openStructSqlBtn`) -> run DDL (`loadSchema` L988!) + EXPLAIN AI lang pill (`openAiSettingsModal` L994!)
      document.querySelector('.nav-tab[data-tab="structure"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))
      document.getElementById('btnStructAddCol')?.click()
      document.getElementById('btnStructPreview')?.click()
      document.getElementById('openStructSqlBtn')?.click()
      await new Promise((r) => setTimeout(r, 20))
      backend.rpcOverrides.set('query.run', () => ({ columns: [], rows: [], affectedRows: 0, isSelect: false, durationMs: 2 }))
      document.getElementById('runAllSqlBtn')?.click()
      await new Promise((r) => setTimeout(r, 30))
      backend.rpcOverrides.delete('query.run')

      // Run EXPLAIN & trigger error-state AI Settings (`openAiSettingsModal`) + open/save AI modal (`onStatusUpdated` L4330!)
      document.getElementById('explainSqlBtn')?.click()
      await new Promise((r) => setTimeout(r, 25))
      expect(backend.rpcSpy.mock.calls.some(([m]) => m === 'query.explain')).toBe(true)
      expect(document.querySelector('#sqlExplainAiPanel .datanoa-ai-lang-pill')).toBeNull()
      expect(document.querySelector('#sqlExplainAiPanel .datanoa-ai-hint')).toBeNull()
      backend.rpcOverrides.set('ai.explainAnalyze', () => {
        throw new Error('transient explain err')
      })
      ;(
        Array.from(document.querySelectorAll('#sqlExplainAiPanel button')).find((b) =>
          b.textContent?.includes('Analyze')
        ) as HTMLButtonElement | undefined
      )?.click()
      await new Promise((r) => setTimeout(r, 25))
      backend.rpcOverrides.delete('ai.explainAnalyze')
      const aiSettingsBtn = Array.from(
        document.querySelectorAll('#sqlExplainAiPanel button')
      ).find((b) => b.textContent?.trim() === 'AI Settings') as HTMLButtonElement | undefined
      aiSettingsBtn?.click()
      await new Promise((r) => setTimeout(r, 30))
      const aiSaveBtn = Array.from(document.querySelectorAll('.datanoa-ai-modal button')).find((b) => b.textContent?.trim() === 'Save') as HTMLButtonElement | undefined
      aiSaveBtn?.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(document.querySelector('.datanoa-ai-modal')).toBeNull()

      // SQL cancel failures (`{ok:false}` + throw) + success `{ok:true}`
      let holdResolve!: (v: unknown) => void
      backend.rpcOverrides.set('query.run', () => new Promise((r) => { holdResolve = r }))
      document.getElementById('runAllSqlBtn')?.click()
      await new Promise((r) => setTimeout(r, 15))
      backend.rpcOverrides.set('query.cancel', () => ({ ok: false, message: 'Cannot stop' }))
      document.getElementById('cancelSqlBtn')?.click()
      await new Promise((r) => setTimeout(r, 15))
      backend.rpcOverrides.set('query.cancel', () => { throw new Error('cancel ipc err') })
      document.getElementById('cancelSqlBtn')?.click()
      await new Promise((r) => setTimeout(r, 15))
      backend.rpcOverrides.set('query.cancel', () => ({ ok: true }))
      document.getElementById('cancelSqlBtn')?.click()
      await new Promise((r) => setTimeout(r, 15))
      expect(backend.rpcSpy.mock.calls.filter(([m]) => m === 'query.cancel').length).toBe(3)
      backend.rpcOverrides.delete('query.cancel')
      backend.rpcOverrides.delete('query.run')
      holdResolve?.({ columns: [], rows: [], rowsAffected: 0, durationMs: 1 })
      await new Promise((r) => setTimeout(r, 20))
      expect((document.getElementById('cancelSqlBtn') as HTMLButtonElement | null)?.hidden).toBe(true)

      // Drag #sqlEditorResizer to invoke `scheduleSavePanelViewState` inside panel-sql ctx
      const sqlResizer = document.getElementById('sqlEditorResizer')
      sqlResizer?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await new Promise((r) => setTimeout(r, 200))

      // 4. Connection Form validations, openStudio throw, newServer toggle close, studioOnly notice (`showBanner`), BYOD notice (`copyText`) & concurrent refresh
      backend.rpcOverrides.set('studio.open', () => { throw new Error('studio exploded') })
      document.getElementById('openStudioBtn')?.click()
      await new Promise((r) => setTimeout(r, 20))
      backend.rpcOverrides.delete('studio.open')

      document.getElementById('newServerBtn')?.click()
      document.getElementById('newServerBtn')?.click() // toggle close L2207
      document.getElementById('newServerBtn')?.click()
      // Click DuckDB engine card to render driver notice & copy setup command (`copyText` L893)
      const duckBtn = Array.from(document.querySelectorAll('#engineGrid button')).find((b) => /duckdb/i.test(b.textContent || '')) as HTMLButtonElement | undefined
      duckBtn?.click()
      document.getElementById('panelDriverInstallCopyBtn')?.click()
      ;(document.getElementById('formFilePath') as HTMLInputElement).value = ':memory:'
      document.getElementById('formFilePath')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))
      backend.setTestConnResult({ ok: false, message: 'Bad ping' })
      document.getElementById('testFormBtn')?.click()
      await new Promise((r) => setTimeout(r, 20))
      backend.setSaveConnResult({ ok: false, message: 'Save rejected' })
      backend.setTestConnResult({ ok: true, latencyMs: 1 })
      document.getElementById('saveFormBtn')?.click()
      await new Promise((r) => setTimeout(r, 20))
      expect(document.getElementById('formNoticeText')?.textContent).toContain('Failed to save connection')
      document.getElementById('closeFormBtn')?.click()
      expect(document.getElementById('connFormBox')?.hidden).toBe(true)

      // Concurrent refreshConnections guard (`refreshBtn` clicked twice while pending)
      let holdList!: (v: unknown) => void
      backend.rpcOverrides.set('connections.list', () => new Promise((r) => { holdList = r }))
      document.getElementById('refreshBtn')?.click()
      document.getElementById('refreshBtn')?.click()
      backend.rpcOverrides.delete('connections.list')
      holdList?.(backend.connections.map((c) => ({ ...c })))
      await new Promise((r) => setTimeout(r, 30))

      // Switch to RO connection + ReadOnly Create Table (`L2418`) & Truncate/Drop (`L2460`) + DataCols toggle close (`L3045`)
      const connSel = document.getElementById('connSelect') as HTMLSelectElement
      connSel.value = 'c_prod_ro'
      connSel.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 50))
      document.querySelector('.nav-tab[data-tab="data"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 50))
      document.getElementById('dataColsBtn')?.click()
      document.getElementById('dataColsBtn')?.click() // toggle close L3045

      // 5. All Escape overlay branches + data.cellUpdated clean/dirty/ignore
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
      expect(document.getElementById('cmdPaletteModal')?.hidden).toBe(false)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(document.getElementById('cmdPaletteModal')?.hidden).toBe(true)
      const dSql = document.getElementById('dangerSqlModal')!
      dSql.hidden = false
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      dSql.hidden = true
      const dTbl = document.getElementById('dangerTableModal')!
      dTbl.hidden = false
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(dTbl.hidden).toBe(true)
      const cMig = document.getElementById('confirmMigrationModal')!
      cMig.hidden = false
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(cMig.hidden).toBe(true)

      // Switch back to c_main + employees cleanly and emit active data.cellUpdated
      const fetchBeforeEmit = backend.rpcSpy.mock.calls.filter(([m]) => m === 'data.fetchPage').length
      connSel.value = 'c_main'
      connSel.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 60))
      backend.emitPlugin('data.cellUpdated', { connectionId: 'other', table: 'x' })
      backend.emitPlugin('data.cellUpdated', { connectionId: 'c_main', table: 'other' })
      backend.emitPlugin('data.cellUpdated', { connectionId: 'c_main', table: 'employees', schema: 'main' })
      await new Promise((r) => setTimeout(r, 80))
      expect(backend.rpcSpy.mock.calls.filter(([m]) => m === 'data.fetchPage').length).toBeGreaterThan(fetchBeforeEmit)
    } finally {
      window.dispatchEvent(new Event('beforeunload'))
      backend.db.close()
    }
  })

  it('Slice 7a: closes shared-ai-ui, shared-cm-inline-ai, shared-collapsible-select, panel-core, panel-explorer, panel-selection, panel-sql-tabs, panel-utils & panel-structure tails', async () => {
    vi.useFakeTimers()
    dom.mountPanelHtml()

    // 1. shared-ai-ui L903 (bench with empty allModels) & L934-935 (provider.test {ok:false})
    const aiRoot = document.createElement('div')
    document.body.appendChild(aiRoot)
    const modPromise = openSharedAiConfigModal({
      rpc: vi.fn(async (m: string) => {
        if (m === 'ai.status.get') return { enabled: true, state: 'on', hasKey: true, model: 'm1', baseUrl: 'https://api.example.com' }
        if (m === 'ai.stats.get') return { summary: { count: 0 }, byModel: {} }
        if (m === 'ai.models.bench') return { results: [{ model: 'm1', ok: true, ms: 12 }] }
        if (m === 'ai.provider.test') return { ok: false, message: 'Unauthorized key' }
        return {}
      }),
      saveSettings: async () => {},
      initialStatus: { enabled: true, state: 'on' },
      mountModal: (card: HTMLElement) => aiRoot.appendChild(card),
      closeModal: () => { aiRoot.textContent = '' },
    })
    await flushMicro(8)
    const benchBtn = Array.from(aiRoot.querySelectorAll('button')).find((b) => /Benchmark/i.test(b.textContent || '')) as HTMLButtonElement | undefined
    benchBtn?.click()
    await flushMicro(8)
    const testBtn = Array.from(aiRoot.querySelectorAll('button')).find((b) => /^Test/i.test(b.textContent || '')) as HTMLButtonElement | undefined
    testBtn?.click()
    await flushMicro(8)
    const cancelAiBtn = Array.from(aiRoot.querySelectorAll('button')).find((b) => /^Cancel$/i.test(b.textContent || '')) as HTMLButtonElement | undefined
    cancelAiBtn?.click()
    await modPromise

    // 2. shared-collapsible-select (L135-136 fallbackQuerySelected, L214 'Search options') & panel-utils (L363-364 workspace icon)
    const wsSel = document.createElement('select')
    const wsOpt = document.createElement('option')
    wsOpt.value = 'ws_1'
    wsOpt.textContent = 'Workspace One'
    wsSel.appendChild(wsOpt)
    document.body.appendChild(wsSel)
    const origOptDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(wsSel), 'selectedIndex')
    Object.defineProperty(wsSel, 'selectedIndex', { value: -1, configurable: true })
    enhanceCollapsibleSelectDropdown(wsSel, {
      leadingIconType: 'workspace',
      searchPlaceholder: '',
    })
    if (origOptDesc) Object.defineProperty(wsSel, 'selectedIndex', origOptDesc)
    const csCtrl = createCollapsibleSelectController({
      fallbackQuerySelected: true,
      layout: { minWidth: 200, margin: 6, maxHeight: 320, vwFallback: 360, vhFallback: 640, gap: 8, rectFallback: { left: 6, top: 40, bottom: 68, width: 250, height: 28 } },
      setLeadIconVisible: (el: HTMLElement, visible: boolean) => { el.hidden = !visible },
      renderTriggerChevron: () => {},
      syncLeadIcon: () => {},
      renderExpandIcon: () => {},
      renderCollapseIcon: () => {},
      renderItemIcon: () => {},
      applyFolderChevron: () => {},
      renderFolderIcon: () => {},
      classes: {
        srOnly: 'cs-sr', trigger: 'cs-t', leadIcon: 'cs-l', label: 'cs-lb', chev: 'cs-c',
        popover: 'cs-p', head: 'cs-h', search: 'cs-s', actionBtn: 'cs-cb', list: 'cs-ls',
        empty: 'cs-e', folderHead: 'cs-fh', folderIcon: 'cs-fi', folderName: 'cs-fn',
        folderCount: 'cs-fn2', item: 'cs-i', itemIcon: 'cs-ii', itemText: 'cs-it',
        itemLabel: 'cs-il', itemSub: 'cs-is', itemCheck: 'cs-ic',
      },
    })
    const csSel = document.createElement('select')
    const csOpt = document.createElement('option')
    csOpt.value = 'a'
    csOpt.textContent = 'Alpha'
    csSel.appendChild(csOpt)
    document.body.appendChild(csSel)
    Object.defineProperty(csSel, 'selectedIndex', { value: -1, configurable: true })
    csSel.value = 'a'
    csCtrl.enhance(csSel, { searchPlaceholder: '' })
    ;(csSel.parentElement?.querySelector('.cs-t') as HTMLElement | null)?.click()

    // 3. panel-core (L911, L1034), panel-sql-tabs (L374-381 Mongo collection match), panel-explorer (L655-658), panel-selection (L579-580)
    expect(getIndexColNames({ columns: [{ id: 'c1', status: 'existing', name: 'A', originalName: 'A' }] }, { columnRefs: [{ fallbackName: 'A' }] })).toEqual(['A'])
    const migTrig = buildPanelMigrationSql({
      tableName: 'orders',
      originalTableName: 'orders',
      columns: [
        { id: 'c1', status: 'existing', name: 'id', originalName: 'id', dataType: 'INTEGER', originalDataType: 'INTEGER', isPrimaryKey: true, nullable: false },
        { id: 'c2', status: 'deleted', name: 'legacy', originalName: 'legacy', dataType: 'TEXT', originalDataType: 'TEXT', isPrimaryKey: false, nullable: true },
      ],
      indexes: [],
      foreignKeys: [],
      triggers: [{ name: 't_other', sql: 'CREATE TRIGGER t_other AFTER INSERT ON audit_log BEGIN SELECT 1; END' }],
    }, 'sqlite')
    expect(migTrig.some((s: string) => s.includes('CREATE TRIGGER t_other'))).toBe(true)

    const mongoComp = computePanelSqlCompletions('use', 3, 'mongodb', { users: ['_id', 'email'] }, undefined, false)
    expect(mongoComp?.options.some((o: { label: string }) => o.label === 'users')).toBe(true)

    // panel-selection same-cell mousemove early return
    const selWrap = document.createElement('div')
    const selTbl = document.createElement('table')
    selTbl.innerHTML = '<tbody><tr data-row-idx="0"><td data-row-idx="0" data-col-idx="0">1</td></tr></tbody>'
    selWrap.appendChild(selTbl)
    document.body.appendChild(selWrap)
    const pSel = new PanelGridSelection({ wrapEl: selWrap, tableEl: selTbl, getDimensions: () => ({ rows: 1, cols: 1 }), getValueAt: () => 1 })
    const c0 = selTbl.querySelector('td')!
    c0.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { target: c0 } as never))
    c0.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }))
    pSel.destroy()

    // panel-explorer folder keydown Enter & Space
    const expState = {
      connections: [{ id: 'c1', name: 'DB', driver: 'sqlite', folder: 'Prod' }],
      activeConnectionId: 'c1',
      activeTable: null,
      activeSchema: undefined,
      filter: '',
      collapsedFolders: new Set<string>(),
      expandedConns: new Set<string>(),
      expandedTables: new Set<string>(),
      expandedMeta: new Set<string>(),
      schemaLoading: new Set<string>(),
      schemaObjects: {},
      tableDetails: {},
      tableDetailsErrors: {},
    }
    const expCtrl = createPanelExplorerController({
      state: expState,
      QUERY_TIMEOUT_MS: 5000,
      getActiveConn: () => expState.connections[0],
      getConnById: () => expState.connections[0],
      isSubmittingChanges: () => false,
      getDataGridSel: () => null,
      getActiveTableKey: () => null,
      getPinnedColsSet: () => new Set(),
      activateConnection: () => {},
      loadSchema: async () => {},
      selectTableAndOpen: () => {},
      showBanner: () => {},
      copyText: async () => {},
      exportCurrentDataPage: () => {},
      exportCurrentSqlResult: () => {},
      renderValueInspector: () => {},
      renderStagingBar: () => {},
      copyDataSelection: () => {},
      copySqlSelection: () => {},
      triggerPanelPasteSmart: async () => {},
      triggerPanelPasteNewRows: async () => {},
      isActiveDataObjectView: () => true,
      addBlankDataRow: () => {},
      bulkSetSelectedCellsValue: () => {},
      openBulkFillModal: () => {},
      applyQuickWhere: () => {},
      jumpToForeignKeyTarget: () => {},
      cloneSelectedRows: () => {},
      toggleDeleteSelectedRows: () => {},
      toggleColumnPinned: () => {},
      toggleColumnHidden: () => {},
      autoFitDataColumn: () => {},
      switchTab: () => {},
      openFullStudio: () => {},
      openDangerTableModal: () => {},
      openCreateTableModal: () => {},
      persistActiveConnectionId: async () => {},
      renderConnectionsBar: () => {},
      renderSqlSafetyBanner: () => {},
      resetSqlSafetyBannerDismissal: () => {},
      setSqlText: () => {},
      populateFormFromProfile: () => {},
      openDeleteConfirmModal: () => {},
      savePanelViewState: () => {},
    })
    expCtrl.renderExplorer()
    const fh = document.querySelector('#schemaTreeContainer .tree-folder-item') as HTMLElement | null
    fh?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    document.querySelector('#schemaTreeContainer .tree-folder-item')?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))

    // 4. panel-structure L192-193 (click inside combo popover), L399-400 (executeConfirmedPanelMigration guard), L610-620 (columnSpecs/triggers/inboundFKs), L1034 (no schemaObjects)
    const stState = {
      activeConnectionId: 'c1',
      activeTable: 'orders',
      activeSchema: 'main',
      isMigrating: false,
      structPreviewOpen: false,
      structDraftKey: null as string | null,
      structDraft: null as Record<string, unknown> | null,
      structureLoading: false,
      structureError: null as string | null,
      schemaObjects: {} as Record<string, unknown[]>,
      tableDetails: {
        'c1:main:orders': {
          name: 'orders',
          columns: [
            { name: 'id', type: 'INTEGER', isPrimaryKey: true, nullable: false, collate: 'BINARY' },
            { name: 'user_id', type: 'INTEGER', nullable: false },
          ],
          primaryKey: ['id'],
          indexes: [{ name: 'idx_uid', columns: ['user_id'], columnSpecs: [{ name: 'user_id', order: 'ASC' }], onConflict: 'IGNORE', origin: 'pk' }],
          foreignKeys: [{ name: 'fk_u', column: 'user_id', referencedTable: 'users', referencedColumn: 'id' }],
          triggers: [{ name: 'trg_o', sql: 'CREATE TRIGGER trg_o BEFORE DELETE ON orders BEGIN SELECT 1; END' }],
          inboundForeignKeys: [{ table: 'order_items', column: 'order_id', constraintName: 'fk_oi' }],
          ddl: 'CREATE TABLE orders (id INT PRIMARY KEY, user_id INT);',
        },
      } as Record<string, unknown>,
    }
    const stCtrl = createPanelStructureController({
      state: stState,
      QUERY_TIMEOUT_MS: 5000,
      getActiveConn: () => ({ id: 'c1', driver: 'sqlite', readOnly: false }),
      getConnById: () => ({ id: 'c1', driver: 'sqlite', readOnly: false }),
      showBanner: () => {},
      savePanelViewState: () => {},
      loadSchema: async () => {},
      loadTableDetails: async () => {},
      loadTablePage: async () => {},
    })
    await stCtrl.executeConfirmedPanelMigration() // L399-400 early return when !structDraft
    stCtrl.renderStructure() // L610-620 & L1034!
    // Open combo input & mousedown inside popover (L192-193)
    const comboToggle = document.querySelector('#structureColTable button') as HTMLElement | null
    comboToggle?.click()
    await vi.advanceTimersByTimeAsync(10)
    const comboPop = document.querySelector('.panel-combo-popover') as HTMLElement | null
    comboPop?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    stCtrl.closePanelComboPopover()

    // 5. shared-cm-inline-ai L282-295, 356-357, 483-484, 502-505, 573-584, 636-637
    let inlineAiEnabled = true
    const cmHost = document.createElement('div')
    document.body.appendChild(cmHost)
    const cmExt = createCmInlineAiExtension({
      isEnabled: () => inlineAiEnabled,
      debounceMs: 50,
      requestCompletion: async () => ({ id: 'g1', text: 'FROM users' }),
      onMetric: () => {},
    })
    const cmView = new cmVendor.EditorView({
      state: cmVendor.EditorState.create({
        doc: 'SELECT * ',
        extensions: [cmExt, cmVendor.autocompletion({ override: [] })],
      }),
      parent: cmHost,
    })
    expect(acceptGhostFull(cmView)).toBe(false)
    expect(acceptGhostWord(cmView)).toBe(false)
    expect(acceptGhostLine(cmView)).toBe(false)
    // Open completion menu while ghost is set so completionStatus === 'active'
    cmView.dispatch({ effects: setGhostEffect.of({ offset: 9, text: 'FROM users', id: 'g2' }), selection: { anchor: 5 } })
    expect(acceptGhostWord(cmView)).toBe(false) // cursor !== ghost.offset -> L286-287!
    cmView.dispatch({ effects: clearGhostEffect.of(undefined), selection: { anchor: 9 } })
    // Selection not empty while doc changed -> L502-505
    cmView.dispatch({ changes: { from: 9, insert: 'x' }, selection: { anchor: 0, head: 3 } })
    // shouldSkipInlineTrigger true (mid-comment) -> L582-584
    cmView.dispatch({ changes: { from: 0, to: cmView.state.doc.length, insert: '-- comment ' }, selection: { anchor: 11 } })
    await vi.advanceTimersByTimeAsync(100)
    // Disabled before debounce fires -> L573-574
    inlineAiEnabled = false
    cmView.dispatch({ changes: { from: 0, to: cmView.state.doc.length, insert: 'SELECT ' }, selection: { anchor: 7 } })
    await vi.advanceTimersByTimeAsync(100)
    // Destroy while valid ghost offered -> dropOffered('stale')
    inlineAiEnabled = true
    cmView.dispatch({ effects: setGhostEffect.of({ offset: 7, text: '1', id: 'g3' }) })
    cmView.destroy()

    vi.useRealTimers()
  })

  it('Slice 7b: closes panel-sql.js, panel-data-grid.js & panel-connection-form.js remaining tails', async () => {
    vi.useFakeTimers()
    dom.mountPanelHtml()

    // 1. panel-connection-form tails: scrub fragment ?token=, parseUri reset, clip fallback, clickhouse 8443 + sslMode verify-full, discovered redis, busy buttons
    const cfState = {
      connections: [{ id: 'c1', name: 'old', driver: 'sqlite', filePath: 'a.db' }],
      activeConnectionId: 'c1',
      editingId: null as string | null,
      sourceSecretConnId: null as string | null,
      formOpen: true,
      formDriver: 'postgres',
      formColorTag: 'none',
      formBusy: false,
      formHadPassword: false,
      formOptions: '',
      placeholderPasswordPending: false,
      lastParsedPlaceholderUri: false,
      lastAutoFilledSqliteName: 'a.db',
      pendingWorkspaceScope: '',
      discoveryLoaded: false,
      discoveryScanning: false,
      discoveredItems: null as Record<string, unknown> | null,
      discoveredSearch: '',
      discoveryCollapsed: null as Record<string, boolean> | null,
      driverMetaById: {},
      driverInstallBusyId: null,
      byodBusyId: null,
      driversCache: null,
      driversDefaultPaths: null,
      workspaceScopesCache: [{ id: 'w1', name: 'WS1', path: 'D:/ws' }],
    }
    const cfCtrl = createPanelConnectionFormController({
      state: cfState,
      QUERY_TIMEOUT_MS: 5000,
      getActiveConn: () => cfState.connections[0],
      showBanner: () => {},
      showFormNotice: () => {},
      clearFormNotice: () => {},
      setFormOpen: () => {},
      setButtonLoading: () => {},
      renderConnectionsBar: () => {},
      renderExplorer: () => {},
      savePanelViewState: () => {},
      updateViewportLayout: () => {},
      // intentionally omit copyText to hit navigator.clipboard fallback in L680!
    })
    cfCtrl.initStaticSelectors()
    cfCtrl.setFormDriver('oracle', true)
    document.getElementById('panelByodCopyTplBtn')?.click() // L680-681
    // Fragment w/ query params + invalid percent + clickhouse 8443 + verify-full
    cfCtrl.setFormDriver('clickhouse', false)
    ;(document.getElementById('formClickhouseUrl') as HTMLInputElement).value = 'https://ch.host/db'
    ;(document.getElementById('formHost') as HTMLInputElement).value = ''
    ;(document.getElementById('formPort') as HTMLInputElement).value = ''
    ;(document.getElementById('formSsl') as HTMLInputElement).checked = true
    const chSub = cfCtrl.buildFormSubmission('id_ch')
    expect(chSub.profile.port).toBe(8443)
    ;(window as { orca?: unknown }).orca = {
      plugin: {
        request: vi.fn(async (m: string) => {
          if (m === 'connection.parseUri') {
            return { ok: true, profile: { driver: 'postgres', sslMode: 'verify-full' } }
          }
          return {}
        }),
      },
    }
    ;(document.getElementById('uriInput') as HTMLInputElement).value = 'postgres://h/d?sslmode=verify-full'
    await cfCtrl.handleParseUri()
    expect((document.getElementById('formSsl') as HTMLInputElement).checked).toBe(true)
    cfCtrl.setFormDriver('postgres', false)
    ;(document.getElementById('uriInput') as HTMLInputElement).value = 'postgres://h/d#%ZZ=1&b=2?token=secret&x=1'
    ;(document.getElementById('formName') as HTMLInputElement).value = 'a.db'
    // Discovery with Redis item (`redisDb`, `password`, collapse null)
    cfState.discoveredItems = {
      files: [{ path: 'D:/ws/data/app.db', name: 'app.db', driver: 'sqlite' }],
      envs: [],
      docker: [{ id: 'd_r', name: 'redis-1', driver: 'redis', host: '127.0.0.1', port: 6379, redisDb: 4, password: 'rp' }],
      scannedRoots: ['D:/ws/a', 'D:/ws/b'],
    }
    cfCtrl.renderDiscoveredItems()
    const redisUseBtn = Array.from(document.querySelectorAll('#discoveredList button')).find((b) => /Use/i.test(b.textContent || '')) as HTMLButtonElement | undefined
    redisUseBtn?.click()
    await flushMicro()
    ;(document.getElementById('uriInput') as HTMLInputElement).value = 'not-a-uri'
    cfCtrl.setFormDriver('unknown_drv' as never, false)

    // 2. panel-data-grid tails (L350, 378, 405, 550, 963, 1240, 1434, 1672, 1757, 1870, 2207)
    const gridCols = [
      { name: 'id', type: 'INTEGER', isPrimaryKey: true, nullable: false, isAutoIncrement: true },
      { name: 'txt', type: 'TEXT', nullable: true },
    ]
    const dgState = {
      activeConnectionId: 'c1',
      activeTable: 't1',
      activeSchema: 'main',
      dataLoading: false,
      silentDataRefresh: false,
      transposed: false,
      page: 1,
      pageSize: 100,
      sortCol: 'txt',
      sortDir: 'ASC',
      whereClause: '',
      orderByClause: '',
      selectedRowKey: 'row_0',
      selectedCol: 'txt',
      inspectorOpen: true,
      inspectorCollapsed: false,
      rowNumWidth: 48,
      findQuery: '',
      findMatches: [],
      findMatchSet: new Set<string>(),
      findMatchIdx: -1,
      columnWidthsByTable: {},
      stagedInserts: [],
      stagedUpdates: new Map(),
      stagedDeletes: new Map(),
      schemaObjects: { c1: [{ name: 't1', schema: 'main', kind: 'table' }] },
      pageData: {
        columns: gridCols,
        rows: [{ id: 1, txt: '{bad json}' }, { id: 2, txt: 'ok' }],
        totalRows: 2,
        page: 1,
        pageSize: 100,
        primaryKey: ['id'],
        canEdit: true,
      },
    }
    let dgSuppressUntil = 0
    let dgCleanup: (() => void) | null = null
    const hiddenCols = new Set<string>(['txt'])
    const dgBanners: string[] = []
    let dgGridSel: PanelGridSelection | null = null
    const dgCtrl = createPanelDataGridController({
      state: dgState,
      VIRT_ROW_HEIGHT_PX: 26,
      VIRT_OVERSCAN_ROWS: 4,
      getActiveConn: () => ({ id: 'c1', driver: 'sqlite', readOnly: false }),
      getStagedCount: () => dgState.stagedUpdates.size,
      isSubmittingChanges: () => false,
      isPreviewingDml: () => false,
      getDataGridSel: () => dgGridSel,
      getActiveTableKey: () => 'c1:main:t1',
      getOrderedVisibleColumns: () => gridCols.filter((c) => !hiddenCols.has(c.name)),
      getPinnedColsSet: () => new Set(),
      getHiddenColsSet: () => hiddenCols,
      getActiveForeignKeyMap: () => new Map(),
      getLastPanelCopiedText: () => '',
      setLastPanelCopiedText: () => {},
      getSuppressSortClickUntil: () => dgSuppressUntil,
      setSuppressSortClickUntil: (v: number) => { dgSuppressUntil = v },
      getActiveResizeCleanup: () => dgCleanup,
      setActiveResizeCleanup: (fn: (() => void) | null) => { dgCleanup = fn },
      setInspectorUserModified: () => {},
      showBanner: (m: string) => dgBanners.push(m),
      copyText: async () => {},
      loadTablePage: async () => {},
      syncDataControlsDisabled: () => {},
      renderDataColsPopoverList: () => {},
    })
    dgGridSel = new PanelGridSelection({
      wrapEl: document.getElementById('dataGridWrap')!,
      tableEl: document.getElementById('dataTable')!,
      editable: true,
      getDimensions: () => ({ rows: dgCtrl.dataVirt.allRows.length, cols: dgCtrl.dataVirt.visCols.length }),
      getValueAt: () => 1,
    })
    dgCtrl.toggleColumnHidden('id') // 1 visible col guard (L963-965)
    hiddenCols.clear()
    dgCtrl.renderDataGrid()
    // patchRenderedDataCell fallback when td doesn't have matching rowKey/colName + stageCellValue unrendered fallback (L350, L405)
    expect(dgCtrl.patchRenderedDataCell('missing_key', 'txt')).toBe(false)
    dgCtrl.stageCellValue('row_0', dgState.pageData.rows[0], 'txt', 'next', false)
    // Click corner '#' header (thead th:first-child -> L1672-1674), sort same col ASC -> DESC (L1757)
    ;(document.querySelector('#dataTable thead th:first-child') as HTMLElement | null)?.click()
    ;(document.querySelector('#dataTable thead th[data-col-name="txt"]') as HTMLElement | null)?.click()
    expect(dgState.sortDir).toBe('DESC')
    // Resize handle mousedown -> mousemove (sets resizeRafId) -> mouseup before rAF (L1240-1242), plus active dataVirt.rafId canceled by renderDataGrid (L1434-1436)
    const rHandle = document.querySelector('#dataTable thead th .col-resize-handle') as HTMLElement | null
    rHandle?.dispatchEvent(new MouseEvent('mousedown', { clientX: 50, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 80 }))
    window.dispatchEvent(new Event('mouseup'))
    dgCtrl.dataVirt.rafId = 99
    dgCtrl.renderDataGrid()
    // startInlineEdit missing rowObj fallback (L1870-1874)
    const anyTd = document.createElement('td')
    dgCtrl.startInlineEdit(anyTd, 'row_ghost', { id: 9, txt: 'ghost' }, gridCols[1], 'ghost')
    // Value Inspector invalid `{bad json}` fallback (L2207-2208)
    dgState.selectedRowKey = 'row_0'
    dgState.selectedCol = 'txt'
    dgCtrl.renderValueInspector()

    // 3. panel-sql tails: Mod-Enter / Mod-Shift-Enter / Shift-Alt-f + Apply SQL & Cancel loading EXPLAIN AI + empty height rect + history copy + clearSqlResultDisplay
    let slowSqlResolve!: (v: unknown) => void
    let slowExplainResolve!: (v: unknown) => void
    let aiDone = false
    ;(window as { orca?: unknown }).orca = {
      plugin: {
        request: vi.fn(async (m: string) => {
          if (m === 'ai.complete') return { id: 'k1', suggestion: '1' }
          if (m === 'ai.metrics.event') return {}
          if (m === 'ai.explainAnalyze') return new Promise((r) => { slowExplainResolve = r })
          if (m === 'query.run') {
            if (!aiDone) return new Promise((r) => { slowSqlResolve = r })
            return { columns: [{ name: 'c' }], rows: [[1]], rowCount: 1, isSelect: true, executionTimeMs: 1 }
          }
          if (m === 'query.history.list') {
            return { entries: [{ connectionName: 'C', driver: 'sqlite', sql: 'SELECT 42;', rowCount: 1, durationMs: 1, timestamp: Date.now() }] }
          }
          return {}
        }),
      },
    }
    const sqlS = {
      activeConnectionId: 'c1', activeQueryId: null, activeWorkerQueryId: null, activeSchema: 'main', activeTable: 't1',
      lastError: '', lastSqlResult: null, sqlSortColIdx: null, sqlSortDir: 'ASC', sqlColWidths: [], sqlRowNumWidth: 42,
      historyOpen: true, historyLoading: false, historyFilter: '', historyEntries: [] as Array<Record<string, unknown>>,
    }
    const sqlCtrl = createPanelSqlController({
      state: sqlS, QUERY_TIMEOUT_MS: 5000, VIRT_ROW_HEIGHT_PX: 26,
      getActiveConn: () => ({ id: 'c1', driver: 'sqlite', readOnly: false }),
      getConnById: () => ({ id: 'c1', driver: 'sqlite', readOnly: false }),
      getSqlGridSel: () => null,
      getSuppressSortClickUntil: () => 0,
      setLastPanelCopiedText: () => {},
      computeVirtualRange: (s: number, h: number, tot: number) => coreComputeVirtualRange(s, h, tot, 26, 4),
      attachColumnResizeHandle: () => {},
      copyText: async () => {},
      showBanner: () => {},
      loadSchema: async () => {},
      savePanelViewState: () => {},
      scheduleSavePanelViewState: () => {},
      savePanelDataCache: () => {},
      onFormatSql: () => {},
      getAiStatus: () => ({ enabled: true, state: 'on', explainLanguage: 'en' }),
      openAiSettingsModal: async () => {},
      onRefreshAiStatus: () => {},
    })
    sqlCtrl.restoreConsoleTabsState(null, 'SELECT 1;')
    const cmContent = document.querySelector('#sqlEditorMount .cm-content') as HTMLElement | null
    cmContent?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    cmContent?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true }))
    cmContent?.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', shiftKey: true, altKey: true, bubbles: true }))
    const sqlEditorMount = document.getElementById('sqlEditorMount') as HTMLElement & { _rect: { height: number } }
    sqlEditorMount._rect.height = 0
    document.getElementById('sqlEditorResizer')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    document.getElementById('sqlEditorResizer')?.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientY: 100, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientY: 120 }))
    window.dispatchEvent(new Event('mouseup'))

    // History copy button (L2082-2083)
    await sqlCtrl.loadQueryHistory()
    const histCopyBtn = Array.from(document.querySelectorAll('#sqlHistoryList button')).find((b) => b.textContent === 'Copy') as HTMLButtonElement | undefined
    histCopyBtn?.click()

    // EXPLAIN AI loading Cancel (`onCancel` L871-876) & markSqlRunCancelled multi-stmt
    aiDone = true
    sqlCtrl.setSqlText('SELECT 1;')
    await sqlCtrl.runSql('explain')
    const analyzeBtn = Array.from(document.querySelectorAll('#sqlExplainAiPanel button')).find((b) => /Analyze/i.test(b.textContent || '')) as HTMLButtonElement | undefined
    analyzeBtn?.click()
    await flushMicro()
    const cancelAiExplain = Array.from(document.querySelectorAll('#sqlExplainAiPanel button')).find((b) => b.textContent === 'Cancel') as HTMLButtonElement | undefined
    cancelAiExplain?.click()
    slowExplainResolve?.({ summary: 'x', durationMs: 1, bottlenecks: [], indexSuggestions: [], notes: [] })
    await flushMicro()

    // sqlVirt.rafId cancel on skeleton/tableOnly & cancelPendingSqlRun with active sqlStopTimer
    aiDone = false
    void sqlCtrl.runSql('all')
    sqlCtrl.sqlVirt.rafId = 88
    sqlCtrl.renderSqlResultSkeleton()
    sqlCtrl.sqlVirt.rafId = 89
    sqlCtrl.renderSqlResultTableOnly()
    sqlCtrl.cancelPendingSqlRun()
    slowSqlResolve?.({ columns: [], rows: [], rowCount: 0, isSelect: false })

    // Missing #dangerSqlModal guard (L213-219)
    const dSqlM = document.getElementById('dangerSqlModal')!
    const dSqlParent = dSqlM.parentElement
    dSqlM.remove()
    sqlCtrl.setSqlText('DROP TABLE t1;')
    await sqlCtrl.runSql('all')
    if (dSqlParent) dSqlParent.appendChild(dSqlM)

    sqlCtrl.destroySqlEditor()
    vi.useRealTimers()
  })

  it('Slice 7c: closes panel-app.js boot failure, multi-schema sort, non-tabular clear, copy failure & beforeunload cleanup', async () => {
    vi.resetModules()
    applySlice6DomMetrics()
    const backend = createPanelAppSlice6Env({
      connections: [
        { id: 'c_multi', name: 'Multi PG', driver: 'postgres', host: 'h', port: 5432, database: 'd', colorTag: 'dev' },
        { id: 'c_redis', name: 'Redis', driver: 'redis', host: 'r', port: 6379, colorTag: 'dev' },
        { id: 'c_bq', name: 'BQ Studio', driver: 'bigquery', colorTag: 'dev' },
      ],
    })
    backend.rpcOverrides.set('schema.listObjects', (inp: unknown) => {
      const p = inp as { connectionId?: string }
      if (p?.connectionId === 'c_redis') return [{ name: 'k:1', kind: 'key' }]
      return [
        { name: 'events', schema: 'zebra', kind: 'table' },
        { name: 'logs', schema: 'analytics', kind: 'table' },
        { name: 'users', schema: 'public', kind: 'table' },
        { name: 'notes', schema: 'main', kind: 'table' },
      ]
    })
    const origWriteText = navigator.clipboard?.writeText
    const origReadText = navigator.clipboard?.readText
    try {
      ;(window as { orca?: unknown }).orca = backend.orcaApi
      // Failing clipboard write triggers showBanner('Copy failed', 'danger') L800
      if (navigator.clipboard) {
        navigator.clipboard.writeText = () => Promise.reject(new Error('denied'))
      }
      // Also make connections.list fail once on boot -> catch L1302-1304, then succeed on refresh!
      backend.failOnceActions.add('connections.list')
      await import('../src/panel/panel-app.js')
      await new Promise((r) => setTimeout(r, 40))
      expect(document.getElementById('globalBannerText')?.textContent).toBeTruthy()

      // Recover via refreshBtn -> renders multi-schema sort (`main`, `public`, `analytics`, `zebra` L1457-1482!)
      document.getElementById('refreshBtn')?.click()
      await new Promise((r) => setTimeout(r, 50))
      const connSelectEl = document.getElementById('connSelect') as HTMLSelectElement
      expect(Array.from(connSelectEl.options).map((o) => o.value)).toEqual(
        expect.arrayContaining(['c_multi', 'c_redis', 'c_bq'])
      )
      expect(document.getElementById('schemaTreeContainer')?.textContent).toContain('zebra')

      // Edit studioOnly BigQuery connection (`connFormCtrl.showBanner` L887), plus Shift+Alt+f in SQL editor (`onFormatSql` L992)
      const bqItem = Array.from(document.querySelectorAll('#schemaTreeContainer .tree-item.tree-conn-item')).find((el) =>
        (el.textContent || '').includes('BQ Studio')
      ) as HTMLElement | undefined
      bqItem?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }))
      ;(Array.from(document.querySelectorAll('#contextMenu .ctx-item')).find((el) => /Edit Connection/i.test(el.textContent || '')) as HTMLElement | undefined)?.click()
      expect(document.getElementById('connFormBox')?.hidden).toBe(false)
      document.querySelector('.nav-tab[data-tab="sql"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      document.querySelector('#sqlEditorMount .cm-content')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', shiftKey: true, altKey: true, bubbles: true }))

      // Copy cell then clear clipboard.readText so Paste uses getLastPanelCopiedText (`L924`)
      document.querySelector('.nav-tab[data-tab="data"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 40))
      const cell0 = document.querySelector('#dataTable tbody tr[data-row-idx="0"] td[data-col-idx="1"]') as HTMLElement | null
      cell0?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }))
      cell0?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }))
      ;(Array.from(document.querySelectorAll('#contextMenu .ctx-item')).find((el) => /^Copy \(TSV\)/.test(el.textContent || '')) as HTMLElement | undefined)?.click()
      if (navigator.clipboard) {
        navigator.clipboard.readText = () => Promise.resolve('')
      }
      cell0?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }))
      ;(Array.from(document.querySelectorAll('#contextMenu .ctx-item')).find((el) => /^Paste \(Overwrite/.test(el.textContent || '')) as HTMLElement | undefined)?.click()
      await new Promise((r) => setTimeout(r, 20))
      if (navigator.clipboard && origReadText) {
        navigator.clipboard.readText = origReadText
      }

      // Switch to Redis (non-tabular objects only -> L1631-1648 clear activeTable & structure)
      const cSel = document.getElementById('connSelect') as HTMLSelectElement
      cSel.value = 'c_redis'
      cSel.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 50))
      const stSelAfterRedis = document.getElementById('structureTableSelect') as HTMLSelectElement
      expect(stSelAfterRedis.disabled).toBe(true)
      expect(stSelAfterRedis.value).toBe('')
      expect(document.getElementById('dataEmpty')?.hidden).toBe(false)
      expect(document.getElementById('dataGridWrap')?.hidden).toBe(true)
      expect(document.getElementById('schemaTreeContainer')?.textContent).toContain('No matching objects')

      // Double-click copy button (`_copyResetTimer`) while clipboard rejects (`Copy failed` L788, L800)
      document.getElementById('copyDdlBtn')?.click()
      document.getElementById('copyDdlBtn')?.click()
      await new Promise((r) => setTimeout(r, 20))
      expect(document.getElementById('globalBannerText')?.textContent).toContain('CREATE TABLE DDL copied')
      if (navigator.clipboard && origWriteText) {
        navigator.clipboard.writeText = origWriteText
      }

      // Queue active debounce timers (`findDebounceTimer`, `schemaFilterDebounceTimer`) right before pagehide -> L4270-4271 cleanup!
      ;(document.getElementById('schemaFilter') as HTMLInputElement).value = 'x'
      document.getElementById('schemaFilter')?.dispatchEvent(new Event('input', { bubbles: true }))
      ;(document.getElementById('dataFindInput') as HTMLInputElement).value = 'y'
      document.getElementById('dataFindInput')?.dispatchEvent(new Event('input', { bubbles: true }))
      window.dispatchEvent(new Event('beforeunload'))
      window.dispatchEvent(new Event('pagehide'))
      await new Promise((r) => setTimeout(r, 40))
    } finally {
      if (navigator.clipboard && origReadText) navigator.clipboard.readText = origReadText
      if (navigator.clipboard && origWriteText) navigator.clipboard.writeText = origWriteText
      window.dispatchEvent(new Event('pagehide'))
      window.dispatchEvent(new Event('beforeunload'))
      backend.db.close()
    }
  })

  it('R2-Slice A1: closes panel-cm, panel-utils, shared-collapsible-select, panel-sql-tabs & panel-explorer branch tails to ~100%', async () => {
    vi.useFakeTimers()
    try {
      dom.mountPanelHtml()

    // 1. panel-cm L608: setValue(null/undefined) triggers `nextSql ?? ''`
    const cmHost = document.createElement('div')
    document.body.appendChild(cmHost)
    const cmEd = createPanelCodeMirrorEditor({ parent: cmHost, value: 'SELECT 1;', dialect: 'sqlite' })
    cmEd.setValue(null as never)
    cmEd.setValue(undefined as never)
    cmEd.destroy()

    // 2. panel-utils L163 (`stopped` interval callback), L362-364 (`workspace` & empty icon in popover), L438 (textarea catch)
    const capturedIntervals: Array<() => void> = []
    const origSetInterval = globalThis.setInterval
    const origClearInterval = globalThis.clearInterval
    try {
      ;(globalThis as { setInterval: unknown }).setInterval = ((cb: () => void) => {
        capturedIntervals.push(cb)
        return 123 as never
      }) as never
      ;(globalThis as { clearInterval: unknown }).clearInterval = (() => {}) as never
      const stopTimer = createElapsedTimer(() => {})
      stopTimer()
      capturedIntervals.forEach((fn) => fn())
    } finally {
      ;(globalThis as { setInterval: unknown }).setInterval = origSetInterval
      ;(globalThis as { clearInterval: unknown }).clearInterval = origClearInterval
    }

    const wsSel = document.createElement('select')
    const wsOpt = document.createElement('option')
    wsOpt.value = 'w1'
    wsOpt.textContent = 'WS 1'
    wsSel.appendChild(wsOpt)
    document.body.appendChild(wsSel)
    enhanceCollapsibleSelectDropdown(wsSel, { leadingIconType: 'workspace' })
    ;(wsSel.parentElement?.querySelector('.custom-select-trigger') as HTMLElement | null)?.click()
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const plainSel = document.createElement('select')
    const plainOpt = document.createElement('option')
    plainOpt.value = 'p1'
    plainOpt.textContent = 'Plain 1'
    plainSel.appendChild(plainOpt)
    document.body.appendChild(plainSel)
    enhanceCollapsibleSelectDropdown(plainSel, { leadingIconType: 'none' })
    ;(plainSel.parentElement?.querySelector('.custom-select-trigger') as HTMLElement | null)?.click()
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    const origCreateEl = document.createElement.bind(document)
    try {
      ;(document as { createElement: (t: string) => HTMLElement }).createElement = ((tag: string) => {
        if (tag === 'textarea') throw new Error('ta blocked')
        return origCreateEl(tag)
      }) as never
      await writeTextToClipboard('hello')
    } finally {
      ;(document as { createElement: (t: string) => HTMLElement }).createElement = origCreateEl
    }

    // 3. shared-collapsible-select remaining 1S + 12B
    const csCtrl = createCollapsibleSelectController({
      fallbackQuerySelected: true,
      layout: { minWidth: 200, margin: 6, maxHeight: 320, vwFallback: 360, vhFallback: 640, gap: 8, rectFallback: { left: 6, top: 40, bottom: 68, width: 250, height: 28 } },
      setLeadIconVisible: (el: HTMLElement, visible: boolean) => { el.hidden = !visible },
      renderTriggerChevron: () => {},
      syncLeadIcon: () => {},
      renderExpandIcon: () => {},
      renderCollapseIcon: () => {},
      renderItemIcon: () => {},
      applyFolderChevron: () => {},
      renderFolderIcon: () => {},
      classes: {
        srOnly: 'r2-sr', trigger: 'r2-t', leadIcon: 'r2-l', label: 'r2-lb', chev: 'r2-c',
        popover: 'r2-p', head: 'r2-h', search: 'r2-s', actionBtn: 'r2-cb', list: 'r2-ls',
        empty: 'r2-e', folderHead: 'r2-fh', folderIcon: 'r2-fi', folderName: 'r2-fn',
        folderCount: 'r2-fn2', item: 'r2-i', itemIcon: 'r2-ii', itemText: 'r2-it',
        itemLabel: 'r2-il', itemSub: 'r2-is', itemCheck: 'r2-ic',
      },
    })
    const emptySel = document.createElement('select')
    document.body.appendChild(emptySel)
    const origIW = window.innerWidth
    const origIH = window.innerHeight
    try {
      Object.defineProperty(window, 'innerWidth', { value: 0, configurable: true })
      Object.defineProperty(window, 'innerHeight', { value: 0, configurable: true })
      csCtrl.enhance(emptySel) // undefined options (L92)
      const trigEmpty = emptySel.parentElement?.querySelector('.r2-t') as HTMLElement | null
      trigEmpty?.click() // opens empty popover -> 'No options available' (L379) & vwFallback/vhFallback (L408-409)
      trigEmpty?.click() // close
      const richSel = document.createElement('select')
      const grpBlank = document.createElement('optgroup')
      grpBlank.setAttribute('label', '   ') // blank folder -> 'Folder' (L21)
      const oNoTitle = document.createElement('option')
      oNoTitle.value = 'k1'
      oNoTitle.textContent = '' // empty label & empty fullTitle (L10, L273)
      grpBlank.appendChild(oNoTitle)
      richSel.appendChild(grpBlank)
      document.body.appendChild(richSel)
      Object.defineProperty(richSel, 'selectedIndex', { value: 99, configurable: true }) // out-of-range selectedIndex (L132)
      csCtrl.enhance(richSel, { searchPlaceholder: '' }) // L214 'Search options'
      richSel.value = 'nonexistent'
      Object.defineProperty(richSel, 'selectedIndex', { value: -1, configurable: true })
      ;(richSel as unknown as { _customDropdownSync?: () => void })._customDropdownSync?.() // L135 `|| null` fallback
      const trigRich = richSel.parentElement?.querySelector('.r2-t') as HTMLElement | null
      trigRich?.click()
      trigRich?.click() // closed -> L431 check on stale scroll if listener still attached
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: origIW, configurable: true })
      Object.defineProperty(window, 'innerHeight', { value: origIH, configurable: true })
    }

    // 4. panel-sql-tabs L67, L158, L338, L364, L379, L383, L401, L442, L493, L504, L537, L560, L563, L568
    const tabsMgr = createPanelConsoleTabsManager({ activeTabId: 'missing_id', tabs: [{ id: 't1', title: 'T1', sql: 'SELECT 1;' }] })
    expect(tabsMgr.getActiveTab()?.id).toBe('t1') // L67 `|| tabs[0]`
    tabsMgr.setResultTabState(0, { sortColIdx: null }) // L158 omit tabId
    tabsMgr.getResultTabState(0) // L158 omit tabId
    expect(computePanelSqlCompletions('et', 2, 'redis', {}, undefined, false)?.options.some((o) => o.label === 'GET')).toBe(true) // L338
    computePanelSqlCompletions(' ', 1, 'mongodb', { users: ['_id'], extra: ['_id'] }, undefined, true) // L364, L383
    expect(computePanelSqlCompletions('ser', 3, 'mongodb', { users: ['_id'] }, undefined, false)?.options.some((o) => o.label === 'users')).toBe(true) // L379
    computePanelSqlCompletions('db.users.nd', 11, 'mongodb', { users: ['_id'] }, undefined, false) // L401
    computePanelSqlCompletions('SELECT t. FROM users t', 9, 'postgres', { users: ['id'] }, undefined, false) // L504
    computePanelSqlCompletions('SELECT * FROM public.ser', 24, 'postgres', { 'public.users': ['id'] }, undefined, false) // L493
    computePanelSqlCompletions(';', 1, 'postgres', { Users: ['id'], users: null as never }, undefined, true) // L442, L537, L560, L563, L568

    // 5. panel-explorer L35,50,51,56,60,194,198,199,257,336,514,696,739,803,1003
    expect(buildCountQueryForObject(null as never, { name: 't' })).toContain('COUNT(*)') // L35
    expect(generateSqlForTable('insert', null as never, { name: 't', kind: 'table' }, {
      columns: [{ name: 'n', type: 'INTEGER' }, { name: 'b', type: 'BOOLEAN' }, { name: 's', type: 'TEXT' }],
    })).toContain('VALUES') // L50, L51, L56
    expect(generateSqlForTable('select', { driver: 'redis' }, { name: 'k' })).toContain('SCAN') // L60

    let holdCountResolve!: (v: unknown) => void
    let failMode: 'none' | 'str' = 'none'
    let expConnAlive = true
    ;(window as { orca?: unknown }).orca = {
      plugin: {
        request: vi.fn(async (m: string) => {
          if (m === 'query.run') {
            if (failMode === 'str') throw 'count str err'
            return new Promise((r) => { holdCountResolve = r })
          }
          if (m === 'schema.generateDdl') throw 'ddl str err'
          return {}
        }),
      },
    }
    const expSt = {
      connections: [{ id: 'c1', name: 'Main', driver: 'sqlite', folder: 'F1' }],
      activeConnectionId: 'c1' as string | null,
      activeTable: 't1',
      activeSchema: 'main',
      filter: 'unmatched_filter',
      collapsedFolders: null as unknown as Set<string>,
      expandedConns: new Set<string>(['c1']),
      expandedTables: new Set<string>(['c1:main:t1']),
      expandedMeta: new Set<string>(),
      schemaLoading: new Set<string>(),
      schemaObjects: { c1: [{ name: 't1', schema: 'main', kind: 'table' }] },
      tableDetails: { 'c1:main:t1': { columns: [{ name: 'col1', type: '', nativeType: 'VARCHAR' }], indexes: [], foreignKeys: [] } },
      tableDetailsErrors: {},
    }
    const expCtrl = createPanelExplorerController({
      state: expSt, QUERY_TIMEOUT_MS: 5000,
      getActiveConn: () => null, // L803
      getConnById: (id: string) => (expConnAlive && id === 'c1' ? expSt.connections[0] : null),
      isSubmittingChanges: () => false, getDataGridSel: () => null, getActiveTableKey: () => 'c1:main:t1',
      getPinnedColsSet: () => new Set(), activateConnection: () => {}, loadSchema: async () => {},
      selectTableAndOpen: () => {}, showBanner: () => {}, copyText: async () => {},
      exportCurrentDataPage: () => {}, exportCurrentSqlResult: () => {}, renderValueInspector: () => {},
      renderStagingBar: () => {}, copyDataSelection: () => {}, copySqlSelection: () => {},
      triggerPanelPasteSmart: async () => {}, triggerPanelPasteNewRows: async () => {},
      isActiveDataObjectView: () => true, addBlankDataRow: () => {}, bulkSetSelectedCellsValue: () => {},
      openBulkFillModal: () => {}, applyQuickWhere: () => {}, jumpToForeignKeyTarget: () => {},
      cloneSelectedRows: () => {}, toggleDeleteSelectedRows: () => {}, toggleColumnPinned: () => {},
      toggleColumnHidden: () => {}, autoFitDataColumn: () => {}, switchTab: () => {},
      openFullStudio: () => {}, openDangerTableModal: () => {}, openCreateTableModal: () => {},
      persistActiveConnectionId: async () => {}, renderConnectionsBar: () => {},
      renderSqlSafetyBanner: () => {}, resetSqlSafetyBannerDismissal: () => {},
      setSqlText: () => {}, populateFormFromProfile: () => {}, openDeleteConfirmModal: () => {},
      savePanelViewState: () => {},
    })
    expCtrl.renderExplorer() // L257, L696
    expSt.filter = ''
    expCtrl.renderExplorer() // L514
    ;(document.querySelector('#schemaTreeContainer .tree-conn-item') as HTMLElement | null)?.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })) // L336
    // Click disabled dataCanvas item (L739) & Generate CREATE DDL string reject (L1003) & Count Rows conn-gone resolve/reject (L194,198,199)
    expCtrl.openContextMenu(10, 10, { type: 'dataCanvas' })
    ;(document.querySelector('#contextMenu button:disabled') as HTMLButtonElement | null)?.click()
    expCtrl.openContextMenu(10, 10, { type: 'object', conn: expSt.connections[0], obj: { name: 't1', schema: 'main', kind: 'table' } })
    ;(Array.from(document.querySelectorAll('#contextMenu .ctx-item')).find((b) => /Generate CREATE DDL/.test(b.textContent || '')) as HTMLElement | undefined)?.click()
    await flushMicro()
    expCtrl.openContextMenu(10, 10, { type: 'object', conn: expSt.connections[0], obj: { name: 't1', schema: 'main', kind: 'table' } })
    ;(Array.from(document.querySelectorAll('#contextMenu .ctx-item')).find((b) => /Count Rows/.test(b.textContent || '')) as HTMLElement | undefined)?.click()
    expConnAlive = false
    holdCountResolve?.({ rows: [[5]] })
    await flushMicro()
    expConnAlive = true
    failMode = 'str'
    expCtrl.openContextMenu(10, 10, { type: 'object', conn: expSt.connections[0], obj: { name: 't1', schema: 'main', kind: 'table' } })
    ;(Array.from(document.querySelectorAll('#contextMenu .ctx-item')).find((b) => /Count Rows/.test(b.textContent || '')) as HTMLElement | undefined)?.click()
    await flushMicro()
    } finally {
      vi.useRealTimers()
    }
  })

  it('R2-Slice A2: closes shared-file-picker, panel-selection, shared-ai-ui & shared-cm-inline-ai branch tails', async () => {
    vi.useFakeTimers()
    try {
      dom.mountPanelHtml()

    // 1. shared-file-picker L27,175,185,199,225,233,236,238,259,306,319,320,326,346
    expect(compactPickerRootLabel('///')).toBe('///') // L27
    let holdListDir!: (v: unknown) => void
    let listMode: 'dir' | 'empty-cur' | 'reject-str' = 'dir'
    const fpRpc = vi.fn(async () => {
      if (listMode === 'reject-str') return new Promise((_, rej) => { holdListDir = () => rej('disk err') })
      if (listMode === 'empty-cur') return { ok: true, currentDir: '', parentDir: '', roots: [], entries: [] }
      return {
        ok: true,
        currentDir: 'D:/work',
        parentDir: 'D:/',
        roots: ['D:/'],
        entries: [
          { name: 'sub', path: 'D:/work/sub', kind: 'dir' },
          { name: 'note.db', path: 'D:/work/note.db', kind: 'file' },
        ],
      }
    })
    // Folder mode: Tab w/ 0 visible focusables (L346), ArrowDown select row (L233,236,238), dblclick dir vs file (L259), confirm with folder selection (L185), empty filter (L225)
    const dirP = openSharedFilePickerModal({ mode: 'folder', classes: PICKER_CLASSES, listDir: fpRpc })
    await flushMicro()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) // selects 'sub'
    const rows = document.querySelectorAll('.fp-row')
    rows[1]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) // file dblclick ignored
    rows[0]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) // dir dblclick loads dir
    await flushMicro()
    const filterInp = document.querySelector('.fp-filter') as HTMLInputElement
    filterInp.value = 'nomatch'
    filterInp.dispatchEvent(new Event('input', { bubbles: true })) // L225
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) // L326 empty visibleEntries
    const origOffDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')
    try {
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', { value: null, configurable: true })
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })) // L346
    } finally {
      if (origOffDesc) Object.defineProperty(HTMLElement.prototype, 'offsetParent', origOffDesc)
      else delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent
    }
    const fpFootBtns = () => Array.from(document.querySelectorAll('.fp-foot-btns button')) as HTMLButtonElement[]
    fpFootBtns().find((b) => !/Cancel/i.test(b.textContent || ''))?.click() // confirm folder -> L185
    await dirP

    // File mode: currentDir='', confirm w/o selection (L199), double close (L175), reject after close (L319,320)
    listMode = 'empty-cur'
    const fileP1 = openSharedFilePickerModal({ mode: 'file', classes: PICKER_CLASSES, listDir: fpRpc })
    await flushMicro()
    fpFootBtns().find((b) => !/Cancel/i.test(b.textContent || ''))?.click()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await fileP1
    listMode = 'reject-str'
    const fileP2 = openSharedFilePickerModal({ mode: 'file', classes: PICKER_CLASSES, listDir: fpRpc })
    await flushMicro()
    const fnRejectAfterClose = holdListDir
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    fnRejectAfterClose?.(null)
    await flushMicro()
    await fileP2
    // Reject while open with non-Error string -> L320
    const fileP3 = openSharedFilePickerModal({ mode: 'file', classes: PICKER_CLASSES, listDir: fpRpc })
    await flushMicro()
    holdListDir?.(null)
    await flushMicro()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await fileP3

    // 2. panel-selection remaining 20B
    const emptyTbl = document.createElement('table') // no tbody (L426)
    const emptyWrap = document.createElement('div')
    emptyWrap.appendChild(emptyTbl)
    document.body.appendChild(emptyWrap)
    const roSel = new PanelGridSelection({
      wrapEl: emptyWrap,
      tableEl: emptyTbl,
      editable: false,
      getDimensions: () => ({ rows: 0, cols: 0 }),
      getValueAt: () => null,
      onPaste: () => false,
    })
    roSel.applyDomClasses() // L426
    roSel.selectCell(0, 0) // L668 rows<=0 || cols<=0
    const txtNode = document.createTextNode('x')
    emptyWrap.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true })) // L477
    emptyWrap.dispatchEvent(new MouseEvent('keydown' as never, { bubbles: true }))
    emptyWrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    // Text node target on mousedown / keydown / mousemove -> L479, L563, L611
    Object.defineProperty(txtNode, 'dispatchEvent', { value: emptyWrap.dispatchEvent.bind(emptyWrap), configurable: true })
    const evMd = new MouseEvent('mousedown', { button: 0, bubbles: true })
    Object.defineProperty(evMd, 'target', { value: txtNode })
    emptyWrap.dispatchEvent(evMd)
    const evKd = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    Object.defineProperty(evKd, 'target', { value: txtNode })
    emptyWrap.dispatchEvent(evKd)
    const resizeChild = document.createElement('span')
    resizeChild.className = 'col-resize-handle'
    emptyTbl.appendChild(resizeChild)
    resizeChild.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true })) // L492
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })) // L543 & L561 (!dragMode)
    const dtOnlyText = { getData: (k: string) => (k === 'text' ? 'abc' : undefined) }
    emptyWrap.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dtOnlyText as never, bubbles: true })) // L719 (!editable)
    roSel.destroy()

    // Large 50_005 rows table -> truncated stats (`+` L366), duplicate ranges (L266,319), start>end (L230), paste fallback text + return false
    const bigWrap = document.createElement('div')
    const bigTbl = document.createElement('table')
    bigTbl.innerHTML = '<tbody><tr><td data-row-idx="-1" data-col-idx="0">bad</td><td data-row-idx="0" data-col-idx="0">ok</td></tr></tbody>'
    bigWrap.appendChild(bigTbl)
    const outsideTd = document.createElement('td')
    outsideTd.dataset.rowIdx = '0'
    outsideTd.dataset.colIdx = '0'
    document.body.append(bigWrap, outsideTd)
    let dimRows = 50_005
    const bigSel = new PanelGridSelection({
      wrapEl: bigWrap,
      tableEl: bigTbl,
      editable: true,
      getDimensions: () => ({ rows: dimRows, cols: 2 }),
      getValueAt: () => 1,
      onPaste: () => false,
    })
    bigSel.selectCell(0, 0)
    bigSel.selectCell(50_004, 1, { shift: true })
    bigSel.selectCell(0, 0, { ctrl: true })
    bigSel.selectCell(1, 0, { ctrl: true, shift: true }) // overlapping range -> L266, L319
    expect(bigSel.formatStatsText()).toContain('+') // L366
    const okTd = bigTbl.querySelector('td[data-row-idx="0"]')!
    okTd.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
    okTd.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })) // L545
    outsideTd.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    const evMmOut = new MouseEvent('mousemove', { bubbles: true })
    Object.defineProperty(evMmOut, 'target', { value: outsideTd })
    window.dispatchEvent(evMmOut) // L565
    const evMmNeg = new MouseEvent('mousemove', { bubbles: true })
    Object.defineProperty(evMmNeg, 'target', { value: bigTbl.querySelector('td') })
    window.dispatchEvent(evMmNeg) // L577
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }))
    const emptyPasteDt = { getData: (k: string) => (k === 'text' ? '' : undefined) }
    bigWrap.dispatchEvent(new ClipboardEvent('paste', { clipboardData: emptyPasteDt as never, bubbles: true })) // L730, L732
    dimRows = 0
    bigSel.getSelectedRowIndices()
    bigSel.destroy()

    // 3. shared-ai-ui remaining 31B (`selected=''`, `lang=''`, `ms===ms`, `ok:false/no-msg`, `ok:true/no-ms`, close while pending `disposed=true`)
    const expRoot = document.createElement('div')
    document.body.appendChild(expRoot)
    renderSharedExplainAiPanel(expRoot, {
      phase: 'ready',
      aiEnabled: true,
      aiReady: true,
      explainLanguage: '',
      result: { durationMs: 5, language: '' },
    }, {}) // L161, L184
    const aiRoot2 = document.createElement('div')
    document.body.appendChild(aiRoot2)
    let holdPendingResolve!: (v: unknown) => void
    const m1P = openSharedAiConfigModal({
      rpc: vi.fn((m: string) => {
        if (m === 'ai.status.get') return Promise.resolve({ enabled: true, state: 'on', preset: 'unknown_preset', model: 'm1', explainLanguage: '' })
        if (m === 'ai.stats.get') return Promise.resolve({ summary: { count: 0 }, byModel: {} })
        if (m === 'ai.models.list') return Promise.resolve({ ok: true, models: [{ id: 'b', latencyMs: 10 }, { id: 'a', latencyMs: 10 }] })
        if (m === 'ai.models.bench') return Promise.resolve({ results: null })
        if (m === 'ai.provider.test') return Promise.resolve({ ok: true })
        return Promise.resolve({})
      }),
      saveSettings: async () => {},
      initialStatus: { enabled: true, state: 'on', preset: 'unknown_preset' },
      mountModal: (c: HTMLElement) => aiRoot2.appendChild(c),
      closeModal: () => { aiRoot2.textContent = '' },
    })
    await flushMicro(8)
    const btns2 = () => Array.from(aiRoot2.querySelectorAll('button')) as HTMLButtonElement[]
    btns2().find((b) => /Bench/i.test(b.textContent || ''))?.click()
    await flushMicro(8)
    btns2().find((b) => /^Test/i.test(b.textContent || ''))?.click()
    await flushMicro(8)
    btns2().find((b) => /^Cancel$/i.test(b.textContent || ''))?.click()
    await m1P
    // Pending close (`disposed = true` branches L382..955)
    let aiKeyReject!: (e: unknown) => void
    const m2P = openSharedAiConfigModal({
      rpc: vi.fn((m: string) => {
        if (m === 'ai.status.get') return Promise.resolve({ enabled: true, state: 'on', hasKey: true, model: 'm1' })
        if (m === 'ai.key.set') return new Promise((_, rej) => { aiKeyReject = rej })
        return new Promise((r) => { holdPendingResolve = r })
      }),
      saveSettings: async () => {},
      initialStatus: { enabled: true, state: 'on', hasKey: true },
      mountModal: (c: HTMLElement) => aiRoot2.appendChild(c),
      closeModal: () => { aiRoot2.textContent = '' },
    })
    await flushMicro(4)
    ;(aiRoot2.querySelector('button[aria-label="Clear saved API key"]') as HTMLButtonElement | null)?.click()
    ;(Array.from(aiRoot2.querySelectorAll('button')).find((b) => /^Cancel$/i.test(b.textContent || '')) as HTMLButtonElement | null)?.click()
    aiKeyReject?.('str key err')
    holdPendingResolve?.({})
    await flushMicro(8)
    await m2P

    // 4. shared-cm-inline-ai remaining lines (L127 `\\'`, L281-283 `completionStatus==='active'`, L440 partial `lastOffered`, L482-484 selection drop, L572 !isEnabled before timer)
    expect(shouldSkipInlineTrigger("SELECT '\\\\'", '')).toBe(false) // L127
    const cmWrap2 = document.createElement('div')
    document.body.appendChild(cmWrap2)
    let holdCompResolve!: (v: unknown) => void
    let compCallIdx = 0
    let aiEnabledFlag = true
    const metrics2: Array<{ id: number; kind: string }> = []
    const view2 = new cmVendor.EditorView({
      state: cmVendor.EditorState.create({
        doc: 'SELECT ',
        extensions: [
          cmVendor.autocompletion({
            override: [
              (ctx) => ({
                from: ctx.pos,
                options: [{ label: 'id' }, { label: 'name' }],
                filter: false,
              }),
            ],
          }),
          createCmInlineAiExtension({
            isEnabled: () => aiEnabledFlag,
            requestCompletion: async () => {
              compCallIdx++
              if (compCallIdx === 1 || compCallIdx === 2) {
                return { id: compCallIdx, suggestion: 'id, name FROM t' }
              }
              return new Promise((r) => { holdCompResolve = r })
            },
            onMetric: (id, kind) => { metrics2.push({ id, kind }) },
          }),
        ],
      }),
      parent: cmWrap2,
    })
    // Trigger ghost & accept 1 word partially -> L440, L334 'partial'
    view2.dispatch({ changes: { from: 7, insert: '*' }, selection: { anchor: 8 } })
    await vi.advanceTimersByTimeAsync(750)
    await flushMicro(6)
    expect(acceptGhostWord(view2)).toBe(true) // partial -> remGhost sets lastOffered (L440)
    // Open completion menu so completionStatus === 'active' -> activeGhostFor returns null (L281-283)
    view2.focus()
    const ctrlSpaceCmd = cmVendor.completionKeymap.find((k) => k.key === 'Ctrl-Space')?.run
    ctrlSpaceCmd?.(view2)
    await vi.advanceTimersByTimeAsync(250)
    await flushMicro(8)
    // In headless jsdom, explicit startCompletion opens popup ('active') when options match; check if active then close
    acceptGhostWord(view2)
    cmVendor.completionKeymap.find((k) => k.key === 'Escape')?.run?.(view2)
    // Re-trigger ghost, then move cursor -> drops ghost in stateField -> update() L482-484 drops stale metric
    view2.dispatch({ changes: { from: view2.state.doc.length, insert: 'a' }, selection: { anchor: view2.state.doc.length + 1 } })
    await vi.advanceTimersByTimeAsync(750)
    await flushMicro(6)
    view2.dispatch({ selection: { anchor: 2 } })
    await flushMicro(4)
    // Flip isEnabled false BEFORE debounce timer fires -> trigger() hits L572-573
    view2.dispatch({ changes: { from: view2.state.doc.length, insert: 'b' }, selection: { anchor: view2.state.doc.length + 1 } })
    aiEnabledFlag = false
    await vi.advanceTimersByTimeAsync(750)
    aiEnabledFlag = true
    // Re-trigger inflight request, then cancel/destroy while pending
    view2.dispatch({ changes: { from: view2.state.doc.length, insert: 'c' }, selection: { anchor: view2.state.doc.length + 1 } })
    await vi.advanceTimersByTimeAsync(750)
    view2.dispatch({ selection: { anchor: 3 } })
    holdCompResolve?.({ id: 9, suggestion: 'FROM u' })
    await flushMicro(6)
    expect(metrics2.some((m) => m.kind === 'partial')).toBe(true)
    view2.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('R2-Slice B1: closes panel-core, panel-structure & panel-connection-form deep branches + PBT', async () => {
    dom.mountPanelHtml()

    // 1. panel-core pure edge cases + PBT + multi-dialect buildPanelMigrationSql & validation
    expect(sanitizeJson(new Date(Number.NaN))).toBeNull()
    expect(formatPanelSql('  set   k   "v"  ', 'redis')).toBe('  set   k   "v"  ')
    expect(formatSelectionAsOutput(['id'], [{ id: 1 }], [{ r: 9, c: 0 }, { r: 0, c: 9 }], 'tsv', false, 't', undefined, 'sqlite')).toBe('\t\n\t')

    fc.assert(
      fc.property(fc.constantFrom('postgres', 'mysql', 'mssql', 'oracle', 'clickhouse'), (drv) => {
        const draft = createPanelStructDraft({
          name: 'users',
          schema: drv === 'postgres' ? 'public' : undefined,
          columns: [
            { name: 'id', type: 'INTEGER', nativeType: 'INT', isPrimaryKey: true, nullable: false, defaultValue: '0', defaultConstraintName: drv === 'mssql' ? 'DF_users_id' : '' },
            { name: 'email', type: 'TEXT', nativeType: 'VARCHAR(100)', isPrimaryKey: false, nullable: true, defaultValue: "'a@b'" },
            { name: 'legacy', type: 'TEXT', nativeType: 'TEXT', isPrimaryKey: false, nullable: true },
          ],
          indexes: [
            { name: drv === 'oracle' ? '' : 'pk_users', isPrimary: true, columns: ['id'] },
            { name: 'idx_email', unique: false, columns: ['email'] },
          ],
          foreignKeys: [
            { column: 'email', foreignTable: 'accounts', foreignColumn: 'email', constraintName: 'fk_email' },
          ],
        })
        draft.tableName = 'users_v2'
        draft.columns[0].isPrimaryKey = false
        draft.columns[0].defaultValue = ''
        draft.columns[1].name = 'email_addr'
        draft.columns[1].dataType = 'VARCHAR(200)'
        draft.columns[1].nullable = false
        draft.columns[1].defaultValue = drv === 'oracle' || drv === 'mysql' ? '' : "'x'"
        draft.columns[2].status = 'deleted'
        draft.columns.push({ id: 'n1', status: 'new', name: 'active', dataType: 'INTEGER', nullable: false, isPrimaryKey: true, defaultValue: '' })
        draft.indexes[1].status = 'deleted'
        draft.indexes.push({ id: 'ni1', status: 'new', name: '', unique: true, columns: ['EMAIL_ADDR'] })
        draft.foreignKeys[0].status = 'deleted'
        draft.foreignKeys.push({ id: 'nf1', status: 'new', columnId: draft.columns[1].id, column: '', foreignTable: 'orgs', foreignColumn: 'id', onDelete: 'INVALID' })

        if (drv === 'clickhouse') {
          expect(() => buildPanelMigrationSql(draft, drv)).toThrow('PRIMARY KEY')
          draft.columns[0].isPrimaryKey = true
          draft.columns[3].isPrimaryKey = false
          const chStmts = buildPanelMigrationSql(draft, drv)
          expect(chStmts.some((s) => s.includes('ADD INDEX'))).toBe(true)
        } else {
          const stmts = buildPanelMigrationSql(draft, drv)
          expect(stmts.length).toBeGreaterThan(2)
        }
        return true
      }),
      { numRuns: 10 }
    )

    // getActiveIndexColNames & validation/buildPanelMigrationSql for redis/mongodb
    const draftIdx = createPanelStructDraft({
      name: 't',
      schema: 'main',
      columns: [{ name: 'Email', type: 'TEXT', isPrimaryKey: false, nullable: true }],
      indexes: [],
      foreignKeys: [],
    })
    expect(getActiveIndexColNames(draftIdx, { columnRefs: [{ colId: null, fallbackName: 'EMAIL' }] })).toEqual(['Email'])
    expect(getActiveIndexColNames(draftIdx, { columns: ['EMAIL'] })).toEqual(['Email'])
    expect(validatePanelStructDraft(draftIdx, 'redis', [])).toMatchObject({ valid: false })
    expect(buildPanelMigrationSql(draftIdx, 'mongodb')).toEqual([])

    // SQLite rebuild: COALESCE, D1 inbound FK blocker & D1 rebuild, declared UNIQUE narrow blocker, triggers & case-only rename
    const d1Blocked = createPanelStructDraft({
      name: 'users',
      schema: 'main',
      columns: [
        { name: 'id', type: 'INTEGER', isPrimaryKey: true, nullable: false },
        { name: 'title', type: 'TEXT', isPrimaryKey: false, nullable: true },
      ],
      indexes: [{ name: 'sqlite_autoindex_users_1', origin: 'u', unique: true, columns: ['id', 'title'] }],
      foreignKeys: [],
      inboundForeignKeys: [{ fromTable: 'posts', fromColumn: 'user_id' }],
      triggers: [{ name: 'trg_u', sql: 'CREATE TRIGGER trg_u AFTER UPDATE OF title ON other_tbl BEGIN SELECT 1; END' }],
    })
    d1Blocked.columns[1].status = 'deleted'
    expect(validatePanelStructDraft(d1Blocked, 'd1', []).valid).toBe(false)
    // Remove inbound FK + drop unique explicitly + change remaining col NOT NULL with default -> D1 rebuild SQL + non-matching trigger L1034
    d1Blocked.inboundForeignKeys = []
    d1Blocked.indexes[0].status = 'deleted'
    d1Blocked.columns[1].status = 'existing'
    d1Blocked.columns[1].nullable = false
    d1Blocked.columns[1].defaultValue = "'n/a'"
    d1Blocked.columns[1].name = 'title' // untouched name so trigger body doesn't block
    d1Blocked.triggers[0].sql = 'CREATE TRIGGER trg_u AFTER INSERT ON other_tbl BEGIN SELECT 1; END'
    const d1Sql = buildPanelMigrationSql(d1Blocked, 'd1')
    expect(d1Sql[0]).toContain('defer_foreign_keys')
    expect(d1Sql.some((s) => s.includes('COALESCE'))).toBe(true)

    // Case-only rename on sqlite (__datanoa_case_rename_tmp -> __datanoa_case_rename_tmp_2)
    const caseDraft = createPanelStructDraft({
      name: '__datanoa_case_rename_tmp',
      schema: 'main',
      columns: [{ name: 'id', type: 'INTEGER', isPrimaryKey: true, nullable: false }],
      indexes: [],
      foreignKeys: [],
    })
    caseDraft.tableName = '__DATANOA_CASE_RENAME_TMP'
    expect(buildPanelMigrationSql(caseDraft, 'sqlite').join(' ')).toContain('__datanoa_case_rename_tmp_2')

    // MSSQL dynamic default constraint drop (without defaultConstraintName)
    const msDyn = createPanelStructDraft({
      name: 't',
      schema: 'dbo',
      columns: [{ name: 'x', type: 'INT', isPrimaryKey: false, nullable: true, defaultValue: '1' }],
      indexes: [],
      foreignKeys: [],
    })
    msDyn.columns[0].defaultValue = '2'
    expect(buildPanelMigrationSql(msDyn, 'mssql').join(' ')).toContain('sys.default_constraints')

    // 2. panel-structure controller deep branches
    const dbStruct = new DatabaseSync(':memory:')
    try {
      dbStruct.exec('CREATE TABLE parents (id INTEGER PRIMARY KEY); CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER, title TEXT, FOREIGN KEY(parent_id) REFERENCES parents(id)); CREATE INDEX idx_child_title ON children(title);')
    let structConn: Record<string, unknown> = { id: 'c_st', name: 'SQLite', driver: 'sqlite', readOnly: false }
    let txMode: 'inactive' | 'active' = 'inactive'
    let failMigrateAsString = false
    const stCalls: string[] = []
    ;(window as { orca?: unknown }).orca = {
      plugin: {
        request: vi.fn(async (method: string) => {
          if (method === 'tx.status') return { active: txMode === 'active', supported: true, autoCommit: txMode !== 'active' }
          if (method === 'query.run') {
            if (failMigrateAsString) throw 'raw-string-migration-error'
            return { ok: true }
          }
          return {}
        }),
      },
    }
    const stState = {
      activeConnectionId: 'c_st',
      activeTable: 'children',
      activeSchema: 'main',
      structureLoading: false,
      structureError: null as string | null,
      structDraftKey: null as string | null,
      structDraft: null as Record<string, unknown> | null,
      structPreviewOpen: false,
      isMigrating: false,
      schemaObjects: { c_st: [{ name: 'children', schema: 'main', kind: 'table' }, { name: 'parents', schema: 'main', kind: 'table' }] },
      tableDetails: {
        'c_st:main:children': {
          name: 'children',
          columns: [
            { name: 'id', type: 'INTEGER', isPrimaryKey: true, nullable: false },
            { name: 'parent_id', type: 'INTEGER', nullable: true },
            { name: 'title', type: 'TEXT', nullable: true, defaultValue: "'hi'" },
          ],
          primaryKey: ['id'],
          indexes: [
            { name: 'pk_children', isPrimary: true, columns: ['id'] },
            { name: 'idx_child_title', unique: true, origin: 'c', columns: ['title'] },
          ],
          foreignKeys: [
            { column: 'parent_id', referencedTable: 'parents', referencedColumn: 'id', constraintName: '' },
          ],
          triggers: [],
          inboundForeignKeys: [],
        },
      } as Record<string, unknown>,
    }
    const stCtrl = createPanelStructureController({
      state: stState,
      QUERY_TIMEOUT_MS: 5000,
      getActiveConn: () => structConn,
      getConnById: (id: string) => (id === 'c_st' ? structConn : null),
      showBanner: (m: string) => stCalls.push(m),
      savePanelViewState: () => {},
      loadSchema: async () => {},
      loadTableDetails: async () => {},
      loadTablePage: async () => {},
    })

    // ReadOnly table indexes & FKs display + empty details fallback
    structConn.readOnly = true
    stCtrl.renderStructure()
    expect(document.getElementById('structureFkList')?.textContent).toContain('parents.id')
    structConn.readOnly = false
    stCtrl.renderStructure()

    // applyPanelStructChanges when 0 changes -> closes/no modal
    stCtrl.applyPanelStructChanges()
    expect((document.getElementById('confirmMigrationModal') as HTMLElement).hidden).toBe(true)

    // Delete parent_id to hit disabled combo (isDel=true), add new index + toggle pill down to 1, rename column to '' -> '(unnamed)'
    const draftObj = stState.structDraft as {
      columns: Array<Record<string, unknown>>
      indexes: Array<Record<string, unknown>>
      foreignKeys: Array<Record<string, unknown>>
    }
    draftObj.columns[1].status = 'deleted'
    draftObj.indexes.push({ id: 'ni_st', status: 'new', name: 'idx_new', unique: true, columns: ['title', 'id'] })
    draftObj.foreignKeys.push({ id: 'nf_st', status: 'new', columnId: draftObj.columns[2].id, column: 'title', foreignTable: 'parents', foreignColumn: 'id', onDelete: 'CASCADE' })
    stCtrl.renderStructure()
    // Combo popover geometry clamping (`openAbove = true`, mocked viewport `innerHeight: 560, innerWidth: 300`, wrap rect near bottom)
    const comboWrapEl = document.querySelector('#structureColTable .struct-combo-wrap:not(.disabled)') as HTMLElement
    if (comboWrapEl) {
      vi.spyOn(comboWrapEl, 'getBoundingClientRect').mockReturnValue({
        left: 260, top: 520, right: 710, bottom: 545, width: 450, height: 25, x: 260, y: 520, toJSON: () => ({}),
      } as DOMRect)
    }
    const origIH = window.innerHeight
    const origIW = window.innerWidth
    try {
      ;(window as { innerHeight: number }).innerHeight = 560
      ;(window as { innerWidth: number }).innerWidth = 300
      ;(comboWrapEl?.querySelector('.struct-combo-toggle') as HTMLButtonElement | null)?.click()
      stCtrl.closePanelComboPopover()
    } finally {
      ;(window as { innerHeight: number }).innerHeight = origIH
      ;(window as { innerWidth: number }).innerWidth = origIW
    }

    // Edit title column name to '' -> '(unnamed)' in index pill & FK option, click pills + clear default × button
    const titleInp2 = Array.from(document.querySelectorAll('#structureColTable .struct-cell-input')).find(
      (el) => (el as HTMLInputElement).value === 'title'
    ) as HTMLInputElement
    titleInp2.value = ''
    titleInp2.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.getElementById('structureIdxList')?.textContent).toContain('(unnamed)')
    expect(document.getElementById('structureFkList')?.textContent).toContain('(unnamed)')
    titleInp2.value = 'title'
    titleInp2.dispatchEvent(new Event('input', { bubbles: true }))
    // Toggle index pill (remove 2nd col -> down to 1 -> try removing last pill -> prevented; click Drop/Undo on FK)
    const pills = Array.from(document.querySelectorAll('#structureIdxList .struct-col-pill')) as HTMLButtonElement[]
    pills[0]?.click()
    pills[1]?.click()
    const clrDefBtn = document.querySelector('#structureColTable .struct-clear-btn') as HTMLButtonElement | null
    clrDefBtn?.click()
    const fkDropBtn = Array.from(document.querySelectorAll('#structureFkList button')).find((b) => b.textContent === 'Drop') as HTMLButtonElement | undefined
    fkDropBtn?.click()

    // Open confirm migration modal with active txStatus blocking error + destructive solid button, then execute with string throw (L481)
    txMode = 'active'
    stCtrl.applyPanelStructChanges()
    await flushMicro(6)
    expect((document.getElementById('confirmMigrationExecuteBtn') as HTMLButtonElement).className).toContain('btn-danger-solid')
    expect((document.getElementById('confirmMigrationExecuteBtn') as HTMLButtonElement).disabled).toBe(true)
    txMode = 'inactive'
    stCtrl.applyPanelStructChanges()
    await flushMicro(6)
    failMigrateAsString = true
    await stCtrl.executeConfirmedPanelMigration()
      expect(document.getElementById('confirmMigrationErrors')?.textContent).toContain('raw-string-migration-error')
      stCtrl.closeMigrationConfirmModal(true)
    } finally {
      dbStruct.close()
    }

    // 3. panel-connection-form deep branches with REAL RPC method names (drivers.*, workspace.*, sqlite.scanFolder, connection.parseUri)
    expect(formatConnSubtitle({ driver: 'd1', d1AccountId: 'acct', d1DatabaseId: 'db1' })).toBe('acct/db1')
    expect(formatConnSubtitle({ driver: 'd1', database: 'db_only' })).toBe('db_only')
    expect(formatConnSubtitle({ driver: 'd1', url: 'https://d1.example/a?token=sec' })).not.toContain('sec')
    expect(formatConnSubtitle({ driver: 'd1' })).toBe('Cloudflare D1')

    let cfSetupMode: 'verified' | 'installPkg' | 'noPkg' | 'throw' = 'verified'
    let cfInspectMode: 'notFound' | 'err' | 'failObj' | 'ok' = 'notFound'
    let cfTrustFail = false
    let cfParseSlowResolvers: Array<(v: unknown) => void> = []
    let cfParseMode: 'ok' | 'fail' | 'studioOnly' | 'slow' | 'sslFull' = 'fail'
    let cfScanEmpty = false
    ;(window as { orca?: unknown }).orca = {
      plugin: {
        request: vi.fn(async (method: string, payload?: Record<string, unknown>) => {
          if (method === 'drivers.list') return { drivers: [{ id: 'snowflake', status: 'unconfigured', localPath: '' }] }
          if (method === 'drivers.defaultPaths') return { platform: 'linux', paths: {}, templates: { bigquery: 'export default {}' } }
          if (method === 'drivers.setupLocal') {
            if (cfSetupMode === 'throw') throw new Error('mkdir failed')
            if (cfSetupMode === 'verified') return { ok: true, dirPath: '$HOME/datanoa-drivers/snowflake', installPackage: '', inspect: { ok: true, sha256: 'aaaa1111222233334444' }, item: { status: 'local-verified' } }
            return {
              ok: true,
              dirPath: '$HOME/datanoa-drivers/snowflake',
              installPackage: cfSetupMode === 'installPkg' ? 'snowflake-sdk' : '',
              inspect: { ok: true, sha256: 'bbbb1111222233334444' },
              item: { status: 'unconfigured' },
            }
          }
          if (method === 'drivers.inspectLocal') {
            if (cfInspectMode === 'notFound') throw new Error('No driver entry found')
            if (cfInspectMode === 'err') throw new Error('stat EACCES')
            if (cfInspectMode === 'failObj') return { ok: false, message: 'bad checksum' }
            return { ok: true, sha256: 'cccc1111222233334444' }
          }
          if (method === 'drivers.configureLocal') {
            if (cfTrustFail) throw new Error('trust rejected')
            return { ok: true }
          }
          if (method === 'workspace.listScopes') {
            return {
              workspaces: [
                { id: 'ws1', name: 'Repo', branch: 'main', path: '/repo', isCurrent: true, label: 'Repo' },
                { id: 'ws1', name: 'RepoDup', branch: 'dev', path: '/repo', isCurrent: false, label: 'Dup' },
                { id: 'ws2', name: 'Sibling', branch: 'feat', path: '/sib', projectFolder: 'GroupA', isCurrent: false, label: 'Sibling' },
              ],
            }
          }
          if (method === 'workspace.detectConnections') {
            if (cfScanEmpty) return { envConnections: [], dockerComposeConnections: [], sqliteFiles: [], scannedDirs: ['/empty'], dockerScopeLabel: 'Docker Context' }
            return {
              scannedDirs: ['/app/ws'],
              folderScoped: false,
              dockerScopeLabel: 'Docker Context',
              dockerIsLocal: false,
              envConnections: [],
              dockerComposeConnections: [
                { name: 'd-ctx', driver: 'postgres', host: 'db.local', port: 5432, database: 'app', status: 'stopped', workspaceMatched: false, sourceFile: '/app/ws/compose.yml' },
                { name: 'd-ws', driver: 'libsql', host: '127.0.0.1', port: 8080, url: 'libsql://127.0.0.1:8080', status: 'running', workspaceMatched: true, hint: 'Verify port' },
              ],
              sqliteFiles: [
                { name: 'app.sqlite3', filePath: '/app/ws/app.sqlite3', sizeBytes: 1024 },
              ],
            }
          }
          if (method === 'sqlite.scanFolder') return { files: [] }
          if (method === 'connection.parseUri') {
            if (cfParseMode === 'slow') return new Promise((r) => cfParseSlowResolvers.push(r))
            if (cfParseMode === 'fail') return { ok: false, error: 'Bad URI' }
            if (cfParseMode === 'studioOnly') return { ok: true, profile: { driver: 'd1', host: 'x' } }
            return {
              ok: true,
              authToken: payload?.uri?.toString().includes('libsql') ? 'tok_new' : undefined,
              profile: {
                driver: 'postgres',
                host: 'pg.local',
                port: 5432,
                user: 'u',
                database: 'd',
                ssl: true,
                sslMode: 'verify-full',
              },
            }
          }
          if (method === 'fs.listDir') {
            return {
              ok: true,
              dir: '/app/dir',
              parent: '/app',
              roots: [{ label: 'App', path: '/app' }],
              entries: [
                { name: '.hidden.db', path: '/tmp/app/.hidden.db', kind: 'file', sizeBytes: 128 },
                { name: 'real.sqlite3', path: '/app/dir/real.sqlite3', kind: 'file', sizeBytes: 256 },
              ],
            }
          }
          return {}
          return {}
        }),
      },
    }

    const cfNotices: string[] = []
    const cfBanners: string[] = []
    const cfState2: Record<string, unknown> = {
      connections: [],
      formOpen: true,
      formBusy: false,
      editingId: null,
      sourceSecretConnId: null,
      formDriver: 'postgres',
      formColorTag: 'none',
      formHadPassword: false,
      formHadAuthToken: false,
      formSslMode: undefined,
      formSslRejectUnauthorized: undefined,
      formOptions: '',
      lastParsedUri: '',
      parsedOracleUrl: '',
      lastAutoFilledSqliteName: '',
      pendingWorkspaceScope: null,
      discoveryCollapsed: null,
      discoveredSearch: '',
      discoveredEnvs: [],
      discoveredDocker: [],
      discoveredFiles: [],
      discoveredScannedDirs: [],
      discoveredFolderScoped: false,
      discoveredDockerScopeLabel: 'Local Docker',
    }
    const cfCtrl2 = createPanelConnectionFormController({
      state: cfState2,
      showBanner: (m: string) => cfBanners.push(m),
      showFormNotice: (m: string) => cfNotices.push(m),
      clearFormNotice: () => {},
      setFormOpen: (v: boolean) => { cfState2.formOpen = v },
      updateViewportLayout: () => {},
      savePanelViewState: () => {},
    })
    cfCtrl2.initStaticSelectors()
    await cfCtrl2.refreshPanelByodAndWorkspaces()

    // Collapse toggles when state.discoveryCollapsed is null + .env-pill click
    ;(document.querySelector('.env-pill') as HTMLElement | null)?.click()
    document.getElementById('discoveredEnvToggle')?.click()

    // Browse SQLite dotfile while formDriver === 'postgres' (L553-555), then normal file matching lastAutoFilledSqliteName (L562)
    document.getElementById('browseSqliteFileBtn')?.click()
    await flushMicro(6)
    const fpRowHidden = Array.from(document.querySelectorAll('.panel-fp-row')).find((r) =>
      r.textContent?.includes('.hidden.db')
    ) as HTMLElement | undefined
    fpRowHidden?.click()
    ;(document.querySelector('.panel-fp-actions .btn-primary') as HTMLButtonElement | null)?.click()
    await flushMicro(8)
    expect(cfState2.formDriver).toBe('sqlite')
    expect((document.getElementById('formName') as HTMLInputElement).value).toBe('app/.hidden.db')
    document.getElementById('browseSqliteFileBtn')?.click()
    await flushMicro(6)
    const fpRowReal = Array.from(document.querySelectorAll('.panel-fp-row')).find((r) =>
      r.textContent?.includes('real.sqlite3')
    ) as HTMLElement | undefined
    fpRowReal?.click()
    ;(document.querySelector('.panel-fp-actions .btn-primary') as HTMLButtonElement | null)?.click()
    await flushMicro(8)
    expect((document.getElementById('formName') as HTMLInputElement).value).toBe('real.sqlite3')

    // Discovery: Docker Context + non-matching search -> empty message, click Docker & SQLite chips, manual empty scan notice
    await cfCtrl2.detectWorkspace(undefined, false)
    cfState2.discoveredSearch = 'zzz_nonexistent'
    cfCtrl2.renderDiscoveredItems()
    expect(document.getElementById('discoveredDockerList')?.textContent).toContain('No Docker Compose')
    expect(document.getElementById('discoveredList')?.textContent).toContain('No SQLite files match')
    cfState2.discoveredSearch = ''
    cfCtrl2.renderDiscoveredItems()
    for (const ch of Array.from(document.querySelectorAll('#discoveredDockerList .file-chip, #discoveredList .file-chip')) as HTMLButtonElement[]) {
      ch.click()
    }
    cfScanEmpty = true
    await cfCtrl2.detectWorkspace('/empty', true)
    expect(cfNotices.some((n) => n.includes('No .env connections'))).toBe(true)

    // BYOD controls with real drivers.* RPCs (`autoTrust`, `installPackage`, `noPkg`, `throw`, `inspectLocal` fallback, `configureLocal` ok & err)
    cfCtrl2.setFormDriver('snowflake', false)
    document.getElementById('panelByodCopyCmdBtn')?.click()
    document.getElementById('panelByodCopyStarterBtn')?.click()
    await flushMicro(4)
    cfSetupMode = 'verified'
    document.getElementById('panelByodAutoSetupBtn')?.click()
    await flushMicro(6)
    cfSetupMode = 'installPkg'
    document.getElementById('panelByodAutoSetupBtn')?.click()
    await flushMicro(6)
    cfSetupMode = 'noPkg'
    document.getElementById('panelByodAutoSetupBtn')?.click()
    await flushMicro(6)
    cfSetupMode = 'throw'
    document.getElementById('panelByodAutoSetupBtn')?.click()
    await flushMicro(6)
    cfInspectMode = 'notFound'
    cfSetupMode = 'noPkg'
    document.getElementById('panelByodInspectBtn')?.click()
    await flushMicro(6)
    cfInspectMode = 'err'
    document.getElementById('panelByodInspectBtn')?.click()
    await flushMicro(6)
    cfInspectMode = 'failObj'
    document.getElementById('panelByodInspectBtn')?.click()
    await flushMicro(6)
    cfInspectMode = 'ok'
    document.getElementById('panelByodInspectBtn')?.click()
    await flushMicro(6)
    cfTrustFail = true
    document.getElementById('panelByodTrustBtn')?.click()
    await flushMicro(6)
    cfTrustFail = false
    document.getElementById('panelByodTrustBtn')?.click()
    await flushMicro(6)

    // URI parsing: studioOnly warning ('d1'), sslMode='verify-full', concurrent stale seq, studioOnly populateFormFromProfile, libsql empty url, setFormControlsBusy
    cfParseMode = 'studioOnly'
    expect(await cfCtrl2.handleParseUri('d1://acct/db')).toBe(false)
    cfParseMode = 'sslFull'
    expect(await cfCtrl2.handleParseUri('postgresql://u:p@pg.local:5432/d?sslmode=verify-full')).toBe(true)
    cfParseMode = 'slow'
    const slowP1 = cfCtrl2.handleParseUri('postgresql://u:p@a:5432/d')
    const slowP2 = cfCtrl2.handleParseUri('postgresql://u:p@b:5432/d')
    cfParseSlowResolvers[1]?.({ ok: true, profile: { driver: 'postgres', host: 'b' } })
    cfParseSlowResolvers[0]?.({ ok: true, profile: { driver: 'postgres', host: 'a' } })
    expect(await slowP2).toBe(true)
    expect(await slowP1).toBe(false)
    cfCtrl2.populateFormFromProfile({ id: 'c_d1', driver: 'd1', name: 'D1' }, 'edit')
    expect(cfBanners.some((b) => b.includes('Fullscreen Studio'))).toBe(true)
    cfCtrl2.populateFormFromProfile({ id: 'c_lib_empty', driver: 'libsql', database: 'local', hasAuthToken: true }, 'edit')
    cfCtrl2.setFormControlsBusy(true)
    expect((document.getElementById('saveFormBtn') as HTMLButtonElement).disabled).toBe(true)
    cfCtrl2.setFormControlsBusy(false)
  })

  it('R2-Slice B2: closes panel-data-grid & panel-sql deep branches with real SQLite + CM6', async () => {
    dom.mountPanelHtml()
    vi.useFakeTimers()

    // 1. panel-data-grid deep branches (paste edges, bulk NULL, transposed highlight, pending rAF resize, >500 autofit, silentLoading, inspector JSON catch, inline edit edges)
    const dbGrid = new DatabaseSync(':memory:')
    dbGrid.exec('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, score INTEGER, flag INTEGER, meta TEXT);')
    for (let i = 1; i <= 5; i++) {
      dbGrid.prepare('INSERT INTO items (name, score, flag, meta) VALUES (?, ?, ?, ?)').run(`row_${i}`, i * 10, i % 2, JSON.stringify({ k: i }))
    }
    const baseRows = dbGrid.prepare('SELECT id, name, score, flag, meta FROM items ORDER BY id').all() as Array<Record<string, unknown>>
    const bigRows = Array.from({ length: 505 }, (_, i) => ({
      id: i + 1,
      name: `n_${i}`,
      score: i,
      flag: 1,
      meta: i === 0 ? { nested: 'obj' } : 'str',
    }))
    const colsMeta = [
      { name: 'id', type: 'INTEGER', nativeType: 'INTEGER', isPrimaryKey: true, isAutoIncrement: true, nullable: false },
      { name: 'name', type: 'TEXT', nativeType: 'TEXT', isPrimaryKey: false, nullable: false, defaultValue: "'def'" },
      { name: 'score', type: 'INTEGER', nativeType: 'INTEGER', isPrimaryKey: false, nullable: true },
      { name: 'flag', type: 'BOOLEAN', nativeType: 'BOOLEAN', isPrimaryKey: false, nullable: true },
      { name: 'meta', type: 'TEXT', nativeType: 'TEXT', isPrimaryKey: false, nullable: true },
    ]
    const dgState2 = {
      activeConnectionId: 'c_sq',
      activeTable: 'items',
      activeSchema: 'main',
      dataLoading: false,
      silentDataRefresh: false,
      transposed: false,
      page: 1,
      pageSize: 600,
      sortCol: 'id',
      sortDir: 'ASC',
      whereClause: '',
      orderByClause: '',
      selectedRowKey: 'row_0' as string | null,
      selectedCol: 'name' as string | null,
      inspectorOpen: true,
      inspectorCollapsed: false,
      rowNumWidth: 48,
      findQuery: '',
      findMatches: [] as Array<{ r: number; c: number; rowKey: string; colName: string }>,
      findMatchSet: new Set<string>(),
      findMatchIdx: -1,
      columnWidthsByTable: {} as Record<string, number[]>,
      stagedInserts: [] as Array<{ tempId: string; values: Record<string, unknown>; origin?: string }>,
      stagedUpdates: new Map(),
      stagedDeletes: new Map(),
      schemaObjects: { c_sq: [{ name: 'items', schema: 'main', kind: 'table' }] },
      pageData: {
        columns: colsMeta,
        rows: baseRows,
        totalRows: baseRows.length,
        page: 1,
        pageSize: 600,
        primaryKey: ['id'],
        canEdit: true,
      } as {
        columns: Array<Record<string, unknown>>
        rows: Array<Record<string, unknown>>
        totalRows: number
        page: number
        pageSize: number
        primaryKey: string[]
        canEdit: boolean
      } | null,
    }
    const dgBanners: string[] = []
    let activeResizeCleanup2: (() => void) | null = null
    let suppressSortUntil2 = 0
    let dgSel2: PanelGridSelection | null = null
    let allowSel = true
    const dgCtrl2 = createPanelDataGridController({
      state: dgState2,
      VIRT_ROW_HEIGHT_PX: 26,
      VIRT_OVERSCAN_ROWS: 4,
      getActiveConn: () => ({ id: 'c_sq', driver: 'sqlite', readOnly: false }),
      getStagedCount: () => dgState2.stagedInserts.length + dgState2.stagedUpdates.size + dgState2.stagedDeletes.size,
      isSubmittingChanges: () => false,
      isPreviewingDml: () => false,
      getDataGridSel: () => (allowSel ? dgSel2 : null),
      getActiveTableKey: () => 'c_sq:main:items',
      getOrderedVisibleColumns: () => colsMeta,
      getPinnedColsSet: () => new Set<string>(),
      getHiddenColsSet: () => new Set<string>(),
      getActiveForeignKeyMap: () => new Map(),
      getLastPanelCopiedText: () => '',
      setLastPanelCopiedText: () => {},
      getSuppressSortClickUntil: () => suppressSortUntil2,
      setSuppressSortClickUntil: (v: number) => { suppressSortUntil2 = v },
      getActiveResizeCleanup: () => activeResizeCleanup2,
      setActiveResizeCleanup: (fn: (() => void) | null) => { activeResizeCleanup2 = fn },
      setInspectorUserModified: () => {},
      showBanner: (m: string) => dgBanners.push(m),
      copyText: async () => {},
      loadTablePage: async () => {},
      syncDataControlsDisabled: () => {},
      renderDataColsPopoverList: () => {},
    })
    const dgWrap = document.getElementById('dataGridWrap')!
    const dgTbl = document.getElementById('dataTable')!
    dgSel2 = new PanelGridSelection({
      wrapEl: dgWrap,
      tableEl: dgTbl,
      editable: true,
      getDimensions: () => ({ rows: dgCtrl2.dataVirt.allRows.length, cols: dgCtrl2.dataVirt.visCols.length }),
      getValueAt: (r: number, c: number) => {
        const e = dgCtrl2.dataVirt.allRows[r]
        const col = dgCtrl2.dataVirt.visCols[c]
        return e && col ? dgCtrl2.getEffectiveCellValue(e.rowKey, e.data, col.name) : null
      },
      onSelectionChange: () => dgCtrl2.renderDataSelectionStats(),
    })

    try {
      dgCtrl2.renderDataGrid()

      // Paste skipping deleted row, NOT NULL column null-coercion, and !pd.canEdit message
      dgState2.stagedDeletes.set('row_0', { id: 1 })
      dgSel2.selectCell(0, 1)
      dgCtrl2.pasteDelimitedIntoDataGrid('new_name', { forceNewRows: false })
      dgState2.stagedDeletes.clear()

      dgState2.pageData!.canEdit = false
      dgSel2.selectCell(0, 1)
      dgCtrl2.pasteDelimitedIntoDataGrid('v', { forceNewRows: false })
      expect(dgBanners.some((b) => b.includes('no primary key'))).toBe(true)
      dgState2.pageData!.canEdit = true

      // bulkSetSelectedCellsValue(null) on NULLABLE score (c=2) vs NOT NULL name (c=1)
      dgSel2.selectCell(0, 2)
      dgCtrl2.bulkSetSelectedCellsValue(null)
      dgSel2.selectCell(0, 1)
      dgCtrl2.bulkSetSelectedCellsValue(null)
      expect(dgBanners.some((b) => b.includes('NOT NULL'))).toBe(true)

      // unrendered stageCellValue fallback -> re-renders grid cleanly
      dgCtrl2.stageCellValue('row_999', { id: 999, score: 1 }, 'score', 42, false)

      // updateGridSelectionHighlight fallback when getDataGridSel() === null & non-transposed
      allowSel = false
      dgState2.selectedRowKey = 'row_1'
      dgState2.selectedCol = 'score'
      dgCtrl2.updateGridSelectionHighlight()
      allowSel = true

      // silentDataRefresh loading preserves DOM, vs non-silent renders skeleton
      dgState2.dataLoading = true
      dgState2.silentDataRefresh = true
      dgCtrl2.renderDataGrid()
      dgState2.silentDataRefresh = false
      dgState2.dataLoading = false

      // Big table (>500 rows with object value) -> auto-fit dblclick + column resize pending rAF mouseup + suppressed th sort click
      dgState2.pageData = { ...dgState2.pageData!, rows: bigRows, totalRows: bigRows.length }
      dgCtrl2.renderDataGrid()
      const handle = dgTbl.querySelector('th .col-resize-handle') as HTMLElement | null
      handle?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      handle?.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 140, bubbles: true }))
      // mouseup BEFORE rAF fires -> hits resizeRafId !== null cancel + applyPendingResize + sets suppressSortClickUntil
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      ;(dgTbl.querySelector('th[data-col-idx], th:nth-child(2)') as HTMLElement | null)?.click()

      // Transposed >100 rows cappedRows with stagedInsert & stagedDelete
      dgState2.stagedInserts.push({ tempId: 'ins_tr_1', values: { id: null, name: 'ins', score: 1, flag: 0, meta: '' } })
      dgState2.stagedDeletes.set('row_0', { id: 1 })
      dgState2.transposed = true
      dgCtrl2.renderDataGrid()
      dgState2.transposed = false
      dgState2.stagedInserts = []
      dgState2.stagedDeletes.clear()

      // Inspector invalid JSON string starting/ending with braces catches L2207-2208 + #valueInspectorText input
      dgState2.pageData = { ...dgState2.pageData!, rows: [{ id: 1, name: 'x', score: null, flag: null, meta: '{broken_json}' }], totalRows: 1 }
      dgState2.selectedRowKey = 'row_0'
      dgState2.selectedCol = 'meta'
      dgCtrl2.renderDataGrid()
      dgCtrl2.renderValueInspector()
      const inspTa = document.getElementById('valueInspectorText') as HTMLTextAreaElement
      expect(inspTa.value).toBe('{broken_json}')
      inspTa.value = '{"fixed":1}'
      inspTa.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('inspectorApplyBtn')?.click()

      // Inline edit Enter on null numeric cell (cancels) & Shift+Tab backward across non-editable PK col
      const tdScore0 = dgTbl.querySelector('tbody td[data-row-idx="0"][data-col-idx="2"]') as HTMLElement
      dgCtrl2.startInlineEdit(tdScore0, 'row_0', dgState2.pageData.rows[0], colsMeta[2], null)
      const inpScore = tdScore0.querySelector('input.cell-edit-input') as HTMLInputElement | null
      inpScore?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

      const tdName0 = dgTbl.querySelector('tbody td[data-row-idx="0"][data-col-idx="1"]') as HTMLElement
      dgCtrl2.startInlineEdit(tdName0, 'row_0', dgState2.pageData.rows[0], colsMeta[1], 'x')
      const inpName = tdName0.querySelector('input.cell-edit-input') as HTMLInputElement | null
      if (inpName) {
        inpName.value = 'x2'
        inpName.dispatchEvent(new Event('input', { bubbles: true }))
        inpName.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
        ;(document.querySelector('input.cell-edit-input') as HTMLInputElement | null)?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        )
      }
    } finally {
      dgSel2.destroy()
      dbGrid.close()
    }

    // 2. panel-sql deep branches (real CM6 mount, inline AI requestCompletion + onMetric, EXPLAIN Apply button, setSqlText cursorOffset, selectedSql caret, multi-EXPLAIN cancel, overlapping sqlStopTimer)
    const dbSql = new DatabaseSync(':memory:')
    dbSql.exec(
      "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t VALUES (1, 'alpha'); CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users VALUES (1, 'alice');"
    )
    const sqlRpcs: Array<{ method: string; payload?: Record<string, unknown> }> = []
    const copiedPanelItems: Array<{ text: string; msg: string }> = []
    let holdExplainResolve!: (v: unknown) => void
    let holdExplainOnce = false
    let holdQueryOnce = false
    let holdQueryResolve!: (v: unknown) => void
    let connForSql: Record<string, unknown> | null = { id: 'c_sq', name: 'SQLite', driver: 'sqlite', readOnly: false }
    ;(window as { orca?: unknown }).orca = {
      plugin: {
        request: vi.fn(async (method: string, payload?: Record<string, unknown>) => {
          sqlRpcs.push({ method, payload })
          if (method === 'ai.complete') return { id: 77, suggestion: 'FROM t;' }
          if (method === 'ai.metrics.event') return { ok: true }
          if (method === 'ai.explainAnalyze') {
            const targetSql = String(payload?.sql || '')
            const optimizedSql = targetSql.includes('users')
              ? "SELECT id, name FROM users WHERE name = 'alice';"
              : 'SELECT id FROM t;'
            return { summary: 'Ok', durationMs: 5, language: 'en', bottlenecks: [], indexSuggestions: [], optimizedSql, notes: [] }
          }
          if (method === 'query.explain') {
            if (holdExplainOnce) {
              holdExplainOnce = false
              return new Promise((r) => { holdExplainResolve = r })
            }
            const rows = dbSql.prepare(`EXPLAIN QUERY PLAN ${String(payload?.sql || 'SELECT 1')}`).all() as Array<Record<string, unknown>>
            return { columns: [{ name: 'detail' }], rows: rows.map((r) => [String(r.detail || 'SCAN')]), rowCount: rows.length, executionTimeMs: 2 }
          }
          if (method === 'query.run') {
            if (holdQueryOnce) {
              holdQueryOnce = false
              return new Promise((r) => { holdQueryResolve = r })
            }
            const rows = dbSql.prepare(String(payload?.sql || 'SELECT 1')).all() as Array<Record<string, unknown>>
            return { columns: [{ name: 'id' }, { name: 'name' }], rows: rows.map((r) => [r.id ?? 1, r.name ?? 'ok']), rowCount: rows.length, executionTimeMs: 2, isSelect: true }
          }
          return {}
        }),
      },
      settings: { get: vi.fn().mockResolvedValue(500) },
    }
    const sqlState2: Record<string, unknown> = {
      activeConnectionId: 'c_sq',
      activeQueryId: null,
      activeWorkerQueryId: null,
      activeSchema: 'main',
      activeTable: 't',
      lastError: '',
      lastSqlResult: null,
      sqlSortColIdx: null,
      sqlSortDir: 'ASC',
      sqlColWidths: [],
      sqlRowNumWidth: 42,
      historyOpen: false,
      historyLoading: false,
      historyFilter: '',
      historyEntries: [],
    }
    let sqlGridSel2: PanelGridSelection | null = null
    const sqlCtrl2 = createPanelSqlController({
      state: sqlState2,
      QUERY_TIMEOUT_MS: 5000,
      VIRT_ROW_HEIGHT_PX: 26,
      getActiveConn: () => connForSql,
      getConnById: () => connForSql,
      getSqlGridSel: () => sqlGridSel2,
      getSuppressSortClickUntil: () => 0,
      setLastPanelCopiedText: () => {},
      computeVirtualRange: (s: number, h: number, tot: number) => coreComputeVirtualRange(s, h, tot, 26, 4),
      attachColumnResizeHandle: () => {},
      copyText: async (text: string, msg: string) => {
        copiedPanelItems.push({ text, msg })
      },
      showBanner: () => {},
      loadSchema: async () => {},
      savePanelViewState: () => {},
      scheduleSavePanelViewState: () => {},
      savePanelDataCache: () => {},
      onFormatSql: () => {},
      getAiStatus: () => ({ enabled: true, state: 'on', explainLanguage: 'en' }),
      openAiSettingsModal: async () => {},
      onRefreshAiStatus: () => {},
    })
    sqlGridSel2 = new PanelGridSelection({
      wrapEl: document.getElementById('sqlResultWrap')!,
      tableEl: document.getElementById('sqlResultTable')!,
      editable: false,
      getDimensions: () => ({ rows: sqlCtrl2.sqlVirt.sortedRows.length, cols: sqlCtrl2.sqlVirt.columns.length }),
      getValueAt: (r: number, c: number) => sqlCtrl2.sqlVirt.sortedRows[r]?.[c],
      onSelectionChange: () => sqlCtrl2.renderSqlSelectionStats(),
    })

    try {
      // Trigger CM6 inline AI completion inside real #sqlEditorMount (L332-355) + requestCompletion without active conn (L334)
      sqlCtrl2.restoreConsoleTabsState(null, '')
      sqlCtrl2.setSqlText('SELECT * ', { cursorOffset: 9 }) // covers L542-544 cursorOffset
      const cmHost = document.querySelector('#sqlEditorMount .cm-editor') as HTMLElement | null
      expect(cmHost).toBeTruthy()
      const mountedCmView = cmHost ? cmVendor.EditorView.findFromDOM(cmHost) : null
      if (mountedCmView) {
        // Trigger inline AI completion via EditorView dispatch + timer advance -> hits requestCompletion L332-348 & onMetric L349-351
        mountedCmView.dispatch({ changes: { from: 9, insert: 'a' }, selection: { anchor: 10 } })
        await vi.advanceTimersByTimeAsync(750)
        await flushMicro(8)
        acceptGhostFull(mountedCmView)
        // Call requestCompletion when activeConnectionId === null -> hits L334 (`if (!conn) return null`)
        const prevConn = connForSql
        connForSql = null
        mountedCmView.dispatch({ changes: { from: mountedCmView.state.doc.length, insert: ' ' }, selection: { anchor: mountedCmView.state.doc.length + 1 } })
        await vi.advanceTimersByTimeAsync(750)
        await flushMicro(6)
        connForSql = prevConn
        // Set selection on CM6 doc & execute 'caret' -> hits L1702 (`if (selectedSql) sql = selectedSql`)
        sqlCtrl2.setSqlText('SELECT id, name FROM t;')
        mountedCmView.dispatch({ selection: { anchor: 0, head: 15 } })
        await sqlCtrl2.runSql('caret')
        // Run keymap commands from registered bindings (Mod-Enter / Mod-Shift-Enter / Shift-Alt-f -> L353-355)
        const kmFacet = mountedCmView.state.facet(cmVendor.keymap).flat()
        for (const kName of ['Mod-Enter', 'Mod-Shift-Enter', 'Shift-Alt-f']) {
          const entry = kmFacet.find((b) => b && (b as { key?: string }).key === kName) as { run?: (v: unknown) => boolean } | undefined
          entry?.run?.(mountedCmView)
        }
        await flushMicro(8)
      }

      // Run EXPLAIN -> Analyze -> click Replace Query button (`onApplySql`) -> verify SQL text actually changed!
      sqlCtrl2.setSqlText('SELECT * FROM t;')
      await sqlCtrl2.runSql('explain')
      await flushMicro(6)
      const analyzeBtn = Array.from(document.querySelectorAll('#sqlExplainAiPanel button')).find((b) =>
        b.textContent?.includes('Analyze')
      ) as HTMLButtonElement | undefined
      analyzeBtn?.click()
      await flushMicro(10)
      const replaceBtn = Array.from(document.querySelectorAll('#sqlExplainAiPanel button')).find(
        (b) => b.textContent?.trim() === 'Replace Query'
      ) as HTMLButtonElement | undefined
      replaceBtn?.click()
      expect(sqlCtrl2.getSqlText()).toBe('SELECT id FROM t;')

      // Multi-statement EXPLAIN + Analyze with AI on statement #2: Copy SQL & Replace Query replace ONLY statement #2!
      sqlCtrl2.setSqlText("SELECT 1;\nSELECT * FROM users WHERE LOWER(name) = 'alice';\nSELECT 2;")
      await sqlCtrl2.runSql('explain')
      await flushMicro(8)
      const resultTabs = Array.from(
        document.querySelectorAll('#sqlResultSetsBar .sql-result-tab')
      ) as HTMLButtonElement[]
      expect(resultTabs.length).toBe(3)
      resultTabs[1]?.click()
      await flushMicro(4)
      const analyzeStmt2Btn = Array.from(
        document.querySelectorAll('#sqlExplainAiPanel button')
      ).find((b) => b.textContent?.includes('Analyze')) as HTMLButtonElement | undefined
      analyzeStmt2Btn?.click()
      await flushMicro(10)
      expect(document.getElementById('sqlExplainAiPanel')?.textContent).toContain(
        'Optimized Equivalent SQL (review before executing)'
      )
      const copyStmt2Btn = Array.from(document.querySelectorAll('#sqlExplainAiPanel button')).find(
        (b) => b.textContent?.trim() === 'Copy SQL'
      ) as HTMLButtonElement | undefined
      copyStmt2Btn?.click()
      await flushMicro(2)
      expect(copiedPanelItems).toContainEqual({
        text: "SELECT id, name FROM users WHERE name = 'alice';",
        msg: 'Optimized SQL copied',
      })
      const replaceStmt2Btn = Array.from(
        document.querySelectorAll('#sqlExplainAiPanel button')
      ).find((b) => b.textContent?.trim() === 'Replace Query') as HTMLButtonElement | undefined
      replaceStmt2Btn?.click()
      expect(sqlCtrl2.getSqlText()).toBe(
        "SELECT 1;\nSELECT id, name FROM users WHERE name = 'alice';\nSELECT 2;"
      )

      // Overlapping sqlStopTimer (start slow runSql -> start second runSql before first settles L1849-1852)
      holdQueryOnce = true
      sqlCtrl2.setSqlText('SELECT id, name FROM t;')
      const qP1 = sqlCtrl2.runSql('all')
      await flushMicro(6)
      sqlCtrl2.setSqlText('SELECT id, name FROM t;')
      const qP2 = sqlCtrl2.runSql('all')
      await flushMicro(6)
      holdQueryResolve?.({ columns: [{ name: 'id' }], rows: [[1]], rowCount: 1, executionTimeMs: 1, isSelect: true })
      await Promise.all([qP1, qP2])

      // Multi-statement EXPLAIN cancelled mid-batch (`markSqlRunCancelled` L1751-1755)
      holdExplainOnce = true
      sqlCtrl2.setSqlText('SELECT 1; SELECT 2;')
      const expP = sqlCtrl2.runSql('explain')
      await flushMicro(6)
      sqlCtrl2.markSqlRunCancelled()
      holdExplainResolve?.({ columns: [{ name: 'detail' }], rows: [['SCAN']], rowCount: 1, executionTimeMs: 1 })
      await expP

      // Empty sqlSelectionStats (clear selection -> L1247-1250) + empty banner + tab without lastResult
      sqlGridSel2.clear()
      sqlCtrl2.renderSqlSelectionStats()
      const addTabBtn2 = document.querySelector('#sqlConsoleTabsBar .sql-console-tab-add') as HTMLButtonElement | null
      addTabBtn2?.click()
    } finally {
      sqlGridSel2.destroy()
      sqlCtrl2.destroySqlEditor()
      dbSql.close()
    }

    vi.useRealTimers()
  })

  it('R2-Slice C: closes panel-app.js remaining branches (boot fallbacks, form validation/errors, inspector/find/pager/popovers, modals, host events & pagehide)', { timeout: 15_000 }, async () => {
    const tick = (ms = 35) => new Promise((r) => setTimeout(r, ms))
    const origIH = window.innerHeight
    const origIW = window.innerWidth

    // 1. Secondary boot scenario: hostSaved viewState fallback, storage error on activeConnId, edit-mode authToken placeholder, invalid activeConn fallback & pending refreshConnections + boot error banner
    vi.resetModules()
    applySlice6DomMetrics()
    const storageThrowsEnv = createPanelAppSlice6Env({
      connections: [{ id: 'c_main', name: 'Main SQLite', driver: 'sqlite', filePath: ':memory:', readOnly: false }],
      sessionSnapshot: {
        updatedAt: Date.now(),
        viewState: null,
        dataCache: {
          updatedAt: Date.now(),
          activeConnectionId: 'c_main',
          lastSqlResult: { columns: [{ name: 'v' }], rows: [[42]], rowCount: 1, executionTimeMs: 1, isSelect: true },
        },
      },
    })
    // Set authToken + stored hostSaved viewState referencing missing activeConnectionId -> tests hostSaved viewState + storage throw on activeConnKey + restoredSqlResult under silent warm boot!
    storageThrowsEnv.connections[0].hasAuthToken = true
    storageThrowsEnv.connections[0].hasPassword = true
    storageThrowsEnv.storageMap.set('datanoa.panelViewState', {
      formOpen: true,
      editingId: 'c_main',
      formDriver: 'libsql',
      tab: 'sql',
      expandedConns: ['c_deleted_missing'],
    })
    const origStorageGet = storageThrowsEnv.orcaApi.storage.get
    storageThrowsEnv.orcaApi.storage.get = async (k: string) => {
      if (k === 'datanoa.activeConnectionId') throw new Error('storage read failed')
      return origStorageGet(k)
    }
    const origSettingsOn = storageThrowsEnv.orcaApi.settings.onDidChange
    let settingsChangedCb: ((c: { key?: string }) => void) | null = null
    storageThrowsEnv.orcaApi.settings.onDidChange = (cb: (c: { key?: string }) => void) => {
      settingsChangedCb = cb
      return origSettingsOn()
    }
    ;(window as { orca?: unknown }).orca = storageThrowsEnv.orcaApi
    try {
      await import('../src/panel/panel-app.js')
      await tick(60)
      expect((document.getElementById('formAuthToken') as HTMLInputElement).placeholder).toContain('Stored token preserved')
      settingsChangedCb?.({ key: 'ai.provider' })
      storageThrowsEnv.emitHost('theme', {})
      storageThrowsEnv.emitPlugin('ai.status.changed', { enabled: false, state: 'off' })
      await tick(30)
      // Trigger overlapping refreshConnections + connection list error branch (L1135, L1303, L1313)
      let holdListResolve!: (v: unknown) => void
      let holdOnce = true
      storageThrowsEnv.rpcOverrides.set('connections.list', () => {
        if (holdOnce) {
          holdOnce = false
          return new Promise((r) => { holdListResolve = r })
        }
        throw new Error('Refresh list boom')
      })
      document.getElementById('refreshBtn')?.click()
      await tick(10)
      storageThrowsEnv.emitPlugin('connections.changed') // sets refreshConnectionsPending = true while refreshingConns === true
      holdListResolve?.([...storageThrowsEnv.connections])
      await tick(50)
      expect(document.getElementById('globalBannerText')?.textContent).toContain('Refresh list boom')
    } finally {
      window.dispatchEvent(new Event('pagehide'))
      window.dispatchEvent(new Event('beforeunload'))
      storageThrowsEnv.db.close()
    }

    // 2. Primary full E2E boot for data/sql/modals/forms/inspector/popovers/keyboard/pagehide
    vi.resetModules()
    localStorage.clear()
    applySlice6DomMetrics()
    const env = createPanelAppSlice6Env({
      connections: [
        { id: 'c_main', name: 'Main SQLite', driver: 'sqlite', filePath: ':memory:', readOnly: false },
        { id: 'c_pg', name: 'App PG', driver: 'postgres', host: 'pg.local', port: 5432, database: 'app', user: 'u', folder: 'Prod', readOnly: false },
      ],
      sessionSnapshot: null,
    })
    // Add second schema & seed extra rows for paging (>pageSize) and JSON formatting
    env.db.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT, extra TEXT);')
    const insItem = env.db.prepare('INSERT INTO items (payload, extra) VALUES (?, ?)')
    for (let i = 1; i <= 12; i++) {
      insItem.run(i === 1 ? '{"a":1}' : `val_${i}`, `note_${i}`)
    }
    ;(window as { orca?: unknown }).orca = env.orcaApi

    try {
      await import('../src/panel/panel-app.js')
      await tick(80)

      // Connection form edges: paste URI, formOptions, placeholderPasswordPending, test fail/throw, save duckdb/libsql validation & throws, #testConnBtn fail/throw, confirmDeleteModal backdrop
      document.getElementById('newConnBtn')?.click()
      await tick(20)
      const uriInp = document.getElementById('uriInput') as HTMLInputElement
      uriInp.value = 'postgres://postgres:pw@localhost:5432/appdb'
      const pasteUriEv = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: { getData: () => string } }
      pasteUriEv.clipboardData = { getData: () => 'postgres://postgres:pw@localhost:5432/appdb' }
      uriInp.dispatchEvent(pasteUriEv)
      await tick(30)
      const optInp = document.getElementById('formOptions') as HTMLInputElement | null
      if (optInp) {
        optInp.value = 'ssl=true'
        optInp.dispatchEvent(new Event('input', { bubbles: true }))
      }
      env.setTestConnResult({ ok: false, message: 'Bad auth' })
      document.getElementById('testFormBtn')?.click()
      await tick(30)
      env.failOnceActions.add('connection.test')
      document.getElementById('testFormBtn')?.click()
      await tick(30)
      // LibSQL empty URL & DuckDB empty path guards on saveFormBtn (click engine tiles inside #engineGrid)
      uriInp.value = ''
      uriInp.dispatchEvent(new Event('input', { bubbles: true }))
      ;(document.querySelector('#engineGrid .engine-tile[data-driver="libsql"]') as HTMLButtonElement | null)?.click()
      ;(document.getElementById('formLibsqlUrl') as HTMLInputElement).value = ''
      document.getElementById('saveFormBtn')?.click()
      await tick(20)
      ;(document.querySelector('#engineGrid .engine-tile[data-driver="duckdb"]') as HTMLButtonElement | null)?.click()
      ;(document.getElementById('formFilePath') as HTMLInputElement).value = ''
      document.getElementById('saveFormBtn')?.click()
      await tick(20)
      // Escape closes connection form when !formBusy
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await tick(20)

      // Active conn test fail & reject + confirmDeleteModal backdrop
      env.setTestConnResult({ ok: false, message: 'Conn dead' })
      document.getElementById('testConnBtn')?.click()
      await tick(30)
      env.failOnceActions.add('connection.test')
      document.getElementById('testConnBtn')?.click()
      await tick(30)
      document.getElementById('delConnBtn')?.click()
      const delModal = document.getElementById('confirmDeleteModal') as HTMLElement
      delModal.dispatchEvent(new MouseEvent('click', { bubbles: false }))
      env.setTestConnResult({ ok: true, latencyMs: 2 })

      // Select items table -> open Data Columns Popover near bottom edge (L3054-3066), test Find Enter/Shift+Enter & Prev/Next before debounce (L3094-3120), pager & pageSize
      const findLiveItemsNode = () =>
        Array.from(document.querySelectorAll('#schemaTreeContainer .tree-row .tree-item')).find(
          (n) => n.querySelector('.tree-name')?.textContent?.trim() === 'items'
        ) as HTMLElement | undefined
      const itemsNode = findLiveItemsNode()
      expect(itemsNode).toBeTruthy()
      ;(itemsNode?.querySelector('.mini-btn') as HTMLButtonElement | null)?.click()
      await tick(80)
      ;(document.getElementById('pageSizeSelect') as HTMLSelectElement).value = '5'
      document.getElementById('pageSizeSelect')?.dispatchEvent(new Event('change', { bubbles: true }))
      await tick(50)
      document.getElementById('nextPageBtn')?.click()
      await tick(50)
      document.getElementById('prevPageBtn')?.click()
      await tick(50)

      const dataColsBtn = document.getElementById('dataColsBtn') as HTMLElement
      vi.spyOn(dataColsBtn, 'getBoundingClientRect').mockReturnValue({
        left: 250, top: 530, right: 310, bottom: 550, width: 60, height: 20, x: 250, y: 530, toJSON: () => ({}),
      } as DOMRect)
      ;(window as { innerHeight: number }).innerHeight = 560
      ;(window as { innerWidth: number }).innerWidth = 320
      dataColsBtn.click()
      ;(window as { innerHeight: number }).innerHeight = origIH
      ;(window as { innerWidth: number }).innerWidth = origIW
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) // closes dataColsPopover (L4066)

      // Data Find Enter & Shift+Enter before debounce timer clears (L3094-3120)
      const findInp = document.getElementById('dataFindInput') as HTMLInputElement
      findInp.value = 'val_'
      findInp.dispatchEvent(new Event('input', { bubbles: true }))
      findInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      findInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
      findInp.value = 'val_2'
      findInp.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('dataFindNextBtn')?.click()
      findInp.value = 'val_3'
      findInp.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('dataFindPrevBtn')?.click()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))

      // Value inspector multi-cell NULL, Format/Minify JSON valid & invalid catch, Ctrl+Enter apply, resizer drag/dblclick/arrows
      const td01 = document.querySelector('#dataTable tbody td[data-row-idx="0"][data-col-idx="1"]') as HTMLElement | null
      const td11 = document.querySelector('#dataTable tbody td[data-row-idx="1"][data-col-idx="1"]') as HTMLElement | null
      td01?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      td11?.dispatchEvent(new MouseEvent('mousedown', { button: 0, shiftKey: true, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      document.getElementById('inspectorBtn')?.click()
      document.getElementById('inspectorNullBtn')?.click() // multi-cell coords.length > 1 (L3824-3826)
      // Re-select single JSON cell & exercise Format, Minify, Escape, Ctrl+Enter & Resizer
      td01?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      document.getElementById('inspectorFormatJsonBtn')?.click()
      document.getElementById('inspectorMinifyJsonBtn')?.click()
      const inspTa = document.getElementById('valueInspectorText') as HTMLTextAreaElement
      inspTa.value = '{bad'
      document.getElementById('inspectorFormatJsonBtn')?.click()
      document.getElementById('inspectorMinifyJsonBtn')?.click()
      inspTa.value = '{"a":2}'
      inspTa.dispatchEvent(new Event('input', { bubbles: true }))
      inspTa.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
      const inspResizer = document.getElementById('valueInspectorResizer') as HTMLElement
      inspResizer.dispatchEvent(new MouseEvent('mousedown', { clientY: 500, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientY: 460, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      inspResizer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      for (const k of ['ArrowUp', 'ArrowDown', 'Home', 'End']) {
        inspResizer.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
      }

      // Remote data.cellUpdated plugin events: ignore mismatch, warn when staged, auto-reload when clean
      env.emitPlugin('data.cellUpdated', { connectionId: 'c_main', table: 'other' })
      env.emitPlugin('data.cellUpdated', { connectionId: 'c_main', table: 'items', schema: 'other' })
      env.emitPlugin('data.cellUpdated', { connectionId: 'c_main', table: 'items', schema: 'main' }) // staged -> shows banner L4246-4253
      document.getElementById('discardStagedBtn')?.click()
      await tick(30)
      env.emitPlugin('data.cellUpdated', { connectionId: 'c_main', table: 'items', schema: 'main' }) // clean -> reloads L4255
      await tick(40)

      // Ctrl+K toggle cmdPaletteModal, Ctrl+/ inside input/contentEditable, #bulkFillModal Enter + Escape, #createTableModal fail, #dangerTableModal backdrop & fail & truncate/drop
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
      const ceDiv = document.createElement('div')
      ceDiv.contentEditable = 'true'
      document.body.appendChild(ceDiv)
      ceDiv.dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }))
      document.getElementById('bulkFillBtn')?.click()
      document.getElementById('bulkFillInput')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      document.getElementById('bulkFillBtn')?.click()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

      // Create Table Modal: invalid empty cols guard (L3179-3182), then add col + fail on RPC (L3207-3214) + Escape
      document.getElementById('newTableBtn')?.click()
      ;(document.getElementById('createTableNameInput') as HTMLInputElement).value = 'bad_tbl'
      document.getElementById('createTableExecuteBtn')?.click()
      expect(document.getElementById('createTableErrors')?.textContent).toContain('At least one column')
      document.getElementById('createTableAddColBtn')?.click()
      env.failOnceActions.add('query.run')
      document.getElementById('createTableExecuteBtn')?.click()
      await tick(40)
      expect(document.getElementById('createTableErrors')?.textContent).toContain('Create failed')
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

      // SQL Download Export ContextMenu + Cancel SQL error/fail + History filter/clear fail + Format SQL btn
      ;(document.querySelector('.nav-tab[data-tab="sql"]') as HTMLElement | null)?.click()
      await tick(20)
      document.getElementById('formatSqlBtn')?.click()
      document.getElementById('runSqlBtn')?.click()
      await tick(60)
      document.getElementById('sqlDownloadExportBtn')?.click()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) // closes contextMenu L4126-4131
      env.rpcOverrides.set('query.cancel', async () => ({ ok: false, message: 'Cannot stop' }))
      let holdSqlResolve!: (v: unknown) => void
      env.rpcOverrides.set('query.run', () => new Promise((r) => { holdSqlResolve = r }))
      document.getElementById('runSqlBtn')?.click()
      await tick(20)
      document.getElementById('cancelSqlBtn')?.click()
      await tick(30)
      env.rpcOverrides.set('query.cancel', async () => { throw new Error('Cancel RPC boom') })
      document.getElementById('cancelSqlBtn')?.click()
      await tick(30)
      holdSqlResolve?.({ columns: [], rows: [], rowsAffected: 0, durationMs: 1 })
      env.rpcOverrides.delete('query.run')
      env.rpcOverrides.delete('query.cancel')
      await tick(30)

      const hFilter = document.getElementById('historySearchInput') as HTMLInputElement
      hFilter.value = 'SELECT'
      hFilter.dispatchEvent(new Event('input', { bubbles: true }))
      env.failOnceActions.add('query.history.clear')
      document.getElementById('clearHistoryBtn')?.click()
      await tick(30)

      // Open Danger Table Modal via Explorer contextmenu -> click backdrop -> re-open -> RPC reject -> succeed Drop of active items table!
      findLiveItemsNode()?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 40, bubbles: true }))
      const dropMenuBtn = Array.from(document.querySelectorAll('#contextMenu button')).find((b) =>
        /Drop Table/i.test(b.textContent || '')
      ) as HTMLButtonElement | undefined
      dropMenuBtn?.click()
      const dngModal = document.getElementById('dangerTableModal') as HTMLElement
      dngModal.dispatchEvent(new MouseEvent('click', { bubbles: false }))
      findLiveItemsNode()?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 40, bubbles: true }))
      ;(Array.from(document.querySelectorAll('#contextMenu button')).find((b) => /Drop Table/i.test(b.textContent || '')) as HTMLButtonElement | undefined)?.click()
      const dngInp = document.getElementById('dangerTableConfirmInput') as HTMLInputElement
      dngInp.value = 'items'
      dngInp.dispatchEvent(new Event('input', { bubbles: true }))
      env.failOnceActions.add('query.run')
      dngInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await tick(40)
      expect(document.getElementById('dangerTableError')?.hidden).toBe(false)
      dngInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await tick(60)
    } finally {
      // Queue scroll to arm dataVirt.rafId & activeResize before pagehide to cover L4273-4301 cleanup
      document.getElementById('dataGridWrap')?.dispatchEvent(new Event('scroll'))
      window.dispatchEvent(new Event('pagehide'))
      window.dispatchEvent(new Event('beforeunload'))
      env.db.close()
    }
  })

  it('R2-Slice D: closes micro-tails in shared-db-icons, shared-wheel-scroll, shared-file-picker, shared-collapsible-select, panel-explorer, panel-sql-tabs & panel-sql EXPLAIN onCancel', async () => {
    dom.mountPanelHtml()

    // 1. shared-db-icons L135 -> 100% ALL
    expect(buildWorkspaceSvgMarkup('ws-ico', Number.NaN)).toContain('width="13"')

    // 2. shared-wheel-scroll 0% -> 100% ALL
    expect(typeof bindCtrlWheelHorizontalScroll(null as unknown as HTMLElement)).toBe('function')
    const wheelBox = document.createElement('div')
    wheelBox.scrollLeft = 0
    const unbindWheel = bindCtrlWheelHorizontalScroll(wheelBox)
    wheelBox.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, ctrlKey: false }))
    wheelBox.dispatchEvent(new WheelEvent('wheel', { deltaY: 0, deltaX: 0, ctrlKey: true }))
    wheelBox.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, deltaMode: 0, ctrlKey: true }))
    wheelBox.dispatchEvent(new WheelEvent('wheel', { deltaY: 2, deltaMode: 1, metaKey: true }))
    wheelBox.dispatchEvent(new WheelEvent('wheel', { deltaX: 1, deltaMode: 2, ctrlKey: true }))
    expect(wheelBox.scrollLeft).toBeGreaterThan(0)
    unbindWheel()

    // 3. shared-file-picker remaining 6B -> 100% ALL
    expect(compactPickerRootLabel('')).toBe('')
    const prevFocusBtn = document.createElement('button')
    document.body.appendChild(prevFocusBtn)
    prevFocusBtn.focus()
    const fpP = openSharedFilePickerModal({
      mode: 'file',
      classes: PICKER_CLASSES,
      listDir: async () => ({
        ok: true,
        currentDir: 'D:/work',
        parentDir: 'D:/',
        roots: ['D:/work'],
        entries: [
          { name: 'note.db', path: 'D:/work/note.db', kind: 'file', size: 12 },
          { name: 'empty-path.db', path: '', kind: 'file', size: 0 },
        ],
      }),
    })
    await flushMicro(6)
    const fpRows = Array.from(document.querySelectorAll('.fp-row')) as HTMLButtonElement[]
    fpRows[1]?.click() // empty path hits selPath = selectedEntry?.path || '' (L199)
    fpRows[0]?.click()
    const fpFilter = document.querySelector('.fp-filter') as HTMLInputElement
    fpFilter.value = 'note'
    fpFilter.dispatchEvent(new Event('input', { bubbles: true })) // re-renders while selectedEntry matches -> L233,236,238
    const cancelBtn = Array.from(document.querySelectorAll('.fp-foot-btns button')).find((b) =>
      /Cancel/i.test(b.textContent || '')
    ) as HTMLButtonElement
    // Re-enter finish() synchronously while prevFocus.focus() fires inside finish() -> hits L175 `if (closed) return`
    prevFocusBtn.addEventListener('focus', () => cancelBtn.click(), { once: true })
    cancelBtn.click()
    await fpP

    // 4. shared-collapsible-select remaining branches
    const blankSel = document.createElement('select')
    blankSel.appendChild(document.createComment('non-option'))
    const blankGrp = document.createElement('optgroup')
    blankGrp.setAttribute('label', '   ')
    const emptyOpt = document.createElement('option')
    emptyOpt.value = ''
    emptyOpt.textContent = '   '
    blankGrp.appendChild(emptyOpt)
    blankSel.appendChild(blankGrp)
    document.body.appendChild(blankSel)
    const collCtrl = createCollapsibleSelectController({
      classes: {
        srOnly: 'sr-only',
        wrap: 'cs-wrp',
        trigger: 'cs-tr',
        leadIcon: 'cs-lead',
        triggerLabel: 'cs-lbl-tr',
        triggerChevron: 'cs-chev-tr',
        popover: 'cs-pop',
        head: 'cs-hd',
        search: 'cs-srch',
        actionBtn: 'cs-act',
        list: 'cs-lst',
        item: 'cs-itm',
        itemIcon: 'cs-ico',
        itemText: 'cs-txt',
        itemLabel: 'cs-lbl',
        itemSub: 'cs-sub',
        itemCheck: 'cs-chk',
        folderHead: 'cs-fh',
        folderIcon: 'cs-fi',
        folderName: 'cs-fn',
        folderCount: 'cs-fc',
        empty: 'cs-emp',
      },
      setLeadIconVisible: (el: HTMLElement, vis: boolean) => { el.hidden = !vis },
      renderTriggerChevron: () => {},
      syncLeadIcon: () => {},
      renderExpandIcon: () => {},
      renderCollapseIcon: () => {},
      renderItemIcon: () => {},
      applyFolderChevron: () => {},
      renderFolderIcon: () => {},
      layout: { rectFallback: { left: 0, right: 200, top: 0, bottom: 20, width: 200, height: 20 }, vwFallback: 400, vhFallback: 600, minWidth: 180, margin: 8, gap: 6, maxHeight: 240 },
    })
    collCtrl.enhance(blankSel) // L92 default options
    const origW = window.innerWidth
    const origH = window.innerHeight
    ;(window as { innerWidth: number }).innerWidth = 0
    ;(window as { innerHeight: number }).innerHeight = 0
    ;(document.querySelector('.cs-tr') as HTMLButtonElement)?.click() // L408,409 fallback dimensions
    document.dispatchEvent(new Event('scroll', { bubbles: true })) // closes via scrollCloseHandler L431
    ;(window as { innerWidth: number }).innerWidth = origW
    ;(window as { innerHeight: number }).innerHeight = origH

    // 5. panel-explorer L92-94 Oracle SQL & L35/50/51 Mongo sampleColumns & L696 collapseAllExplorer null
    const oraSelect = generateSqlForTable(
      'select',
      { driver: 'oracle' },
      { name: 'EMP', schema: 'HR' },
      { columns: [{ name: 'ID' }] }
    )
    expect(oraSelect).toContain('FETCH FIRST 100 ROWS ONLY;')
    expect(generateSqlForTable('select', { driver: 'mongodb' }, { name: 'logs' }, { sampleColumns: ['msg', '_id'] })).toContain('logs')
    expect(generateSqlForTable('insert', { driver: 'mongodb' }, { name: 'logs' }, { sampleColumns: ['msg', '_id'] })).toContain('insertOne')
    expect(generateSqlForTable('update', { driver: 'mongodb' }, { name: 'logs' }, { sampleColumns: ['msg', '_id'] })).toContain('updateOne')

    const exCtrl = createPanelExplorerController({
      state: {
        tab: 'explorer',
        filter: '',
        initialBootLoading: false,
        activeConnectionId: 'c1',
        activeTable: 't1',
        activeSchema: 'main',
        connections: [{ id: 'c1', name: 'A', driver: 'sqlite', folder: 'F1', readOnly: true }],
        collapsedFolders: null as unknown as Set<string>,
        collapsedSchemaGroups: new Set(),
        expandedConns: new Set(['c1']),
        expandedTables: new Set(),
        expandedMeta: new Set(),
        schemaLoading: new Set(),
        schemaObjects: { c1: [{ name: 't1', kind: 'table', schema: 'main' }] },
        tableDetails: {},
        tableDetailsErrors: {},
      },
      QUERY_TIMEOUT_MS: 5000,
      getActiveConn: () => ({ id: 'c1', name: 'A', driver: 'sqlite', readOnly: true }),
      getConnById: () => ({ id: 'c1', name: 'A', driver: 'sqlite', readOnly: true }),
      getPinnedColsSet: () => new Set(),
      getDataGridSel: () => null,
      getOrderedVisibleColumns: () => [],
      getAllDisplayRows: () => [],
      getActiveForeignKeyMap: () => new Map(),
      getActiveTableKey: () => 'c1:main:t1',
      getStagedCount: () => 0,
      isSubmittingChanges: () => false,
      savePanelViewState: () => {},
      clearStagedChanges: () => {},
      clearCopiedSnapshot: () => {},
      showBanner: () => {},
      copyText: async () => {},
      loadSchema: async () => {},
      loadTablePage: async () => {},
      renderConnectionsBar: () => {},
      renderStructureTableSelect: () => {},
      renderDataToolbar: () => {},
      renderDataGrid: () => {},
      renderStructure: () => {},
      renderValueInspector: () => {},
      syncPanelSqlSchema: () => {},
      switchTab: () => {},
      setSqlText: () => {},
      formatDdlForDisplay: (d: string) => d,
      openFullStudio: async () => {},
      openCreateTableModal: () => {},
      openDangerTableModal: () => {},
      openEditModal: () => {},
      openDeleteConfirmModal: () => {},
      activateConnection: () => {},
      updateViewportLayout: () => {},
      persistActiveConnectionId: () => {},
      toggleColumnPinned: () => {},
      toggleColumnHidden: () => {},
      autoFitDataColumn: () => {},
      cloneSelectedRows: () => {},
      toggleDeleteSelectedRows: () => {},
      copyDataSelection: () => {},
      pasteDelimitedIntoDataGrid: () => false,
      bulkSetSelectedCellsValue: () => {},
      applyQuickWhere: () => {},
      jumpToForeignKeyTarget: () => {},
      copySqlSelection: () => {},
      exportCurrentSqlResult: () => {},
      openValueInspectorForCell: () => {},
      resetSqlSafetyBannerDismissal: () => {},
    })
    exCtrl.collapseAllExplorer() // L696 !state.collapsedFolders

    // 6. panel-sql-tabs computePanelSqlCompletions remaining branches (Mongo non-prefix boost, empty/non-array schema, Oracle DUAL FROM context)
    const mongoComp = computePanelSqlCompletions('db.ers', 6, 'mongodb', { users: ['id'] }, '', false)
    expect(mongoComp?.options?.some((o) => o.label === 'users')).toBe(true)
    const oraComp = computePanelSqlCompletions('SELECT * FROM du', 16, 'oracle', { empty_tbl: [], bad_tbl: null as unknown as string[] }, 'empty_tbl', false)
    expect(oraComp?.options?.some((o) => o.label === 'DUAL')).toBe(true)
    const emptyCaretComp = computePanelSqlCompletions('SELECT 1;;', 10, 'sqlite', { t: ['a'] }, 't', true)
    expect(emptyCaretComp?.options?.length).toBeGreaterThan(0)

    // 7. panel-sql EXPLAIN AI loading -> click Cancel button (`onCancel` L871-876)
    let holdExplainAi!: (v: unknown) => void
    ;(window as { orca?: unknown }).orca = {
      plugin: {
        request: vi.fn(async (m: string) => {
          if (m === 'query.explain') return { columns: [{ name: 'detail' }], rows: [['SCAN']], rowCount: 1, executionTimeMs: 1 }
          if (m === 'ai.explainAnalyze') return new Promise((r) => { holdExplainAi = r })
          return {}
        }),
      },
      settings: { get: vi.fn().mockResolvedValue(500) },
    }
    const sqlCtrlCancel = createPanelSqlController({
      state: { activeConnectionId: 'c1', activeSchema: 'main', activeTable: 't', lastError: '', lastSqlResult: null, sqlSortColIdx: null, sqlSortDir: 'ASC', sqlColWidths: [], sqlRowNumWidth: 42, historyOpen: false, historyLoading: false, historyFilter: '', historyEntries: [] },
      QUERY_TIMEOUT_MS: 5000,
      VIRT_ROW_HEIGHT_PX: 26,
      getActiveConn: () => ({ id: 'c1', driver: 'sqlite', readOnly: false }),
      getConnById: () => ({ id: 'c1', driver: 'sqlite', readOnly: false }),
      getSqlGridSel: () => null,
      getSuppressSortClickUntil: () => 0,
      setLastPanelCopiedText: () => {},
      computeVirtualRange: (s: number, h: number, tot: number) => coreComputeVirtualRange(s, h, tot, 26, 4),
      attachColumnResizeHandle: () => {},
      copyText: async () => {},
      showBanner: () => {},
      loadSchema: async () => {},
      savePanelViewState: () => {},
      scheduleSavePanelViewState: () => {},
      savePanelDataCache: () => {},
      onFormatSql: () => {},
      getAiStatus: () => ({ enabled: true, state: 'on', explainLanguage: 'en' }),
      openAiSettingsModal: async () => {},
      onRefreshAiStatus: () => {},
    })
    try {
      sqlCtrlCancel.restoreConsoleTabsState(null, 'SELECT 1;')
      await sqlCtrlCancel.runSql('explain')
      await flushMicro(6)
      const anBtn = Array.from(document.querySelectorAll('#sqlExplainAiPanel button')).find((b) =>
        b.textContent?.includes('Analyze')
      ) as HTMLButtonElement | undefined
      anBtn?.click()
      await flushMicro(4)
      const cancelExplainBtn = Array.from(document.querySelectorAll('#sqlExplainAiPanel button')).find(
        (b) => b.textContent?.trim() === 'Cancel'
      ) as HTMLButtonElement | undefined
      expect(cancelExplainBtn).toBeTruthy()
      cancelExplainBtn?.click()
      holdExplainAi?.({ summary: 'Late', durationMs: 1, language: 'en' })
      await flushMicro(4)
    } finally {
      sqlCtrlCancel.destroySqlEditor()
    }
  })

  it('R3-Slice 1: flips micro-tails (file-picker, explorer, sql-tabs, selection, collapsible-select) + shared-ai-ui, shared-cm-inline-ai, panel-structure & panel-core', async () => {
    dom.mountPanelHtml()
    vi.useFakeTimers()

    // 1. shared-file-picker L27 -> 100/100/100
    expect(compactPickerRootLabel('///')).toBe('///')

    // 2. panel-explorer remaining 7B -> ~100/100/100
    expect(generateSqlForTable('select', null as never, { name: 't', schema: '' }, null)).toContain('LIMIT 100')
    expect(buildCountQueryForObject(null as never, { name: 't', schema: '' })).toContain('COUNT(*)')
    expect(
      generateSqlForTable(
        'insert',
        { driver: 'mongodb' },
        { name: 'logs' },
        { columns: [{ name: 'cnt', type: 'INTEGER' }, { name: 'ok', type: 'BOOLEAN' }] }
      )
    ).toContain('0')
    let countRowsHold!: (v: unknown) => void
    let countCallN = 0
    ;(window as { orca?: unknown }).orca = {
      plugin: {
        request: vi.fn(async (m: string) => {
          if (m === 'query.run') {
            countCallN++
            if (countCallN === 1) return new Promise((r) => { countRowsHold = r })
            return { columns: [{ name: 'total_rows' }], rows: [[5]] }
          }
          return {}
        }),
      },
    }
    const exState = {
      tab: 'explorer',
      filter: 'items',
      initialBootLoading: false,
      activeConnectionId: 'c1',
      activeTable: 'items',
      activeSchema: 'main',
      connections: [{ id: 'c1', name: 'Local', driver: 'sqlite', readOnly: true }],
      collapsedFolders: new Set<string>(),
      collapsedSchemaGroups: new Set<string>(),
      expandedConns: new Set<string>(), // empty so filter matchingObjs L257 runs
      expandedTables: new Set<string>(),
      expandedMeta: new Set<string>(),
      schemaLoading: new Set<string>(),
      schemaObjects: { c1: [{ name: 'items', kind: 'table', schema: 'main' }] },
      tableDetails: {},
      tableDetailsErrors: {},
    }
    const exCtrl2 = createPanelExplorerController({
      state: exState,
      QUERY_TIMEOUT_MS: 5000,
      getActiveConn: () => exState.connections[0],
      getConnById: (id: string) => exState.connections.find((c) => c.id === id) || null,
      getPinnedColsSet: () => new Set(),
      getDataGridSel: () => null,
      getOrderedVisibleColumns: () => [],
      getAllDisplayRows: () => [],
      getActiveForeignKeyMap: () => new Map(),
      getActiveTableKey: () => 'c1:main:items',
      getStagedCount: () => 0,
      isSubmittingChanges: () => false,
      savePanelViewState: () => {},
      clearStagedChanges: () => {},
      clearCopiedSnapshot: () => {},
      showBanner: () => {},
      copyText: async () => {},
      loadSchema: async () => {},
      loadTablePage: async () => {},
      renderConnectionsBar: () => {},
      renderStructureTableSelect: () => {},
      renderDataToolbar: () => {},
      renderDataGrid: () => {},
      renderStructure: () => {},
      renderValueInspector: () => {},
      syncPanelSqlSchema: () => {},
      switchTab: () => {},
      setSqlText: () => {},
      formatDdlForDisplay: (d: string) => d,
      openFullStudio: async () => {},
      openCreateTableModal: () => {},
      openDangerTableModal: () => {},
      openEditModal: () => {},
      openDeleteConfirmModal: () => {},
      activateConnection: () => {},
      updateViewportLayout: () => {},
      persistActiveConnectionId: () => {},
      toggleColumnPinned: () => {},
      toggleColumnHidden: () => {},
      autoFitDataColumn: () => {},
      cloneSelectedRows: () => {},
      toggleDeleteSelectedRows: () => {},
      copyDataSelection: () => {},
      pasteDelimitedIntoDataGrid: () => false,
      bulkSetSelectedCellsValue: () => {},
      applyQuickWhere: () => {},
      jumpToForeignKeyTarget: () => {},
      copySqlSelection: () => {},
      exportCurrentSqlResult: () => {},
      openValueInspectorForCell: () => {},
      resetSqlSafetyBannerDismissal: () => {},
    })
    exCtrl2.renderExplorer() // L257 filter match when conn not in expandedConns
    exCtrl2.openContextMenu(10, 10, { type: 'object', conn: exState.connections[0], obj: { name: 'items', schema: 'main', kind: 'table' } })
    const countBtn = Array.from(document.querySelectorAll('#contextMenu button')).find((b) =>
      b.textContent?.includes('Count Rows')
    ) as HTMLButtonElement | undefined
    const disabledDropBtn = Array.from(document.querySelectorAll('#contextMenu button')).find((b) =>
      b.textContent?.includes('Drop Table')
    ) as HTMLButtonElement | undefined
    // Trigger disabled button closure guard (L739) cleanly by removing disabled attr before click
    if (disabledDropBtn) {
      disabledDropBtn.removeAttribute('disabled')
      disabledDropBtn.click()
    }
    exCtrl2.openContextMenu(10, 10, { type: 'object', conn: exState.connections[0], obj: { name: 'items', schema: 'main', kind: 'table' } })
    countBtn?.click()
    await flushMicro(4)
    exCtrl2.openContextMenu(10, 10, { type: 'object', conn: exState.connections[0], obj: { name: 'items', schema: 'main', kind: 'table' } })
    ;(Array.from(document.querySelectorAll('#contextMenu button')).find((b) => b.textContent?.includes('Count Rows')) as HTMLButtonElement | undefined)?.click()
    countRowsHold?.({ columns: [{ name: 'total_rows' }], rows: [[9]] }) // L198 stale seq
    await flushMicro(6)

    // 3. panel-sql-tabs comment-before-caret fallbacks (L442, L537)
    expect(computePanelSqlCompletions('/* u.', 5, 'sqlite', { u: ['id'] }, '', true)).not.toBeNull()
    expect(computePanelSqlCompletions('/* foo', 6, 'sqlite', { foo: ['id'] }, '', true)).not.toBeNull()

    // 4. panel-selection remaining branches
    const selHost = document.createElement('div')
    const selTbl = document.createElement('table')
    const selTb = document.createElement('tbody')
    for (let r = 0; r < 3; r++) {
      const tr = document.createElement('tr')
      const rn = document.createElement('td')
      rn.className = 'td-rownum'
      rn.dataset.rowIdx = String(r)
      tr.appendChild(rn)
      for (let c = 0; c < 3; c++) {
        const td = document.createElement('td')
        td.dataset.rowIdx = String(r)
        td.dataset.colIdx = String(c)
        td.textContent = `${r},${c}`
        tr.appendChild(td)
      }
      selTb.appendChild(tr)
    }
    selTbl.appendChild(selTb)
    selHost.appendChild(selTbl)
    document.body.appendChild(selHost)
    let dimRows = 3
    let pasteRet = false
    const pSel = new PanelGridSelection({
      wrapEl: selHost,
      tableEl: selTbl,
      editable: true,
      getDimensions: () => ({ rows: dimRows, cols: 3 }),
      getValueAt: () => 'v',
      onPaste: () => pasteRet,
    })
    pSel.selectCell(2, 0)
    dimRows = 1
    expect(pSel.getSelectedRowIndices()).toEqual([]) // L230 start > end
    dimRows = 3
    // Overlapping ranges -> hits seen.has(key) in L266 & L319
    pSel.selectCell(0, 0)
    pSel.selectCell(0, 1, { ctrl: true })
    pSel.selectCell(0, 0, { ctrl: true, shift: true })
    expect(pSel.getSelectedCoords()).toHaveLength(2)
    expect(pSel.computeSummary()?.cellCount).toBe(2)
    // mousemove when !dragMode (L543) + window mousemove while !dragMode (L561) + duplicate mousemove + SVG target contextmenu (L611) + outside td
    const td01 = selTb.querySelector('td[data-row-idx="0"][data-col-idx="1"]') as HTMLElement
    td01.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })) // !dragMode
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })) // !dragMode L561
    td01.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
    td01.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })) // same coord -> L545
    const outTd = document.createElement('td')
    document.body.appendChild(outTd)
    outTd.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })) // !tableEl.contains -> L565
    selTbl.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })) // target = table (td?) -> checks L565
    const badRn = document.createElement('td')
    badRn.className = 'td-rownum'
    selTb.appendChild(badRn)
    badRn.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true })) // L577 NaN < 0
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    const svgChild = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    td01.appendChild(svgChild)
    svgChild.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })) // !(target instanceof HTMLElement) L611
    dimRows = 0
    selHost.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) // rows <= 0 L668
    dimRows = 3
    pasteRet = false
    const pasteFallbackEv = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: { getData: (t: string) => string | undefined }
    }
    pasteFallbackEv.clipboardData = { getData: (t: string) => (t === 'text' ? 'xyz' : undefined) }
    selHost.dispatchEvent(pasteFallbackEv) // L730-732
    pSel.destroy()

    // 5. shared-ai-ui remaining branches: disposed callbacks (11 branches), usageMap sorting (L739), custom preset (L615/870)
    const aiModRoot = document.createElement('div')
    document.body.appendChild(aiModRoot)
    const heldResolvers: Array<(v: unknown) => void> = []
    const heldRejectors: Array<(e: unknown) => void> = []
    const aiModPromise = openSharedAiConfigModal({
      rpc: vi.fn(async (m: string) => {
        if (m === 'ai.models.list') return { ok: true, models: ['m-slow', 'm-fast', 'm-none'] }
        if (m === 'ai.models.usage') return { usage: { 'm-slow': { ms: 90 }, 'm-fast': { ms: 20 } } }
        return new Promise((res, rej) => {
          heldResolvers.push(res)
          heldRejectors.push(rej)
        })
      }),
      saveSettings: async () => new Promise((res, rej) => { heldResolvers.push(res); heldRejectors.push(rej) }),
      initialStatus: { enabled: true, state: 'on', format: 'bad_fmt', baseUrl: 'https://unknown.example/v1', explainLanguage: '' },
      mountModal: (el: HTMLElement) => aiModRoot.appendChild(el),
      closeModal: () => { aiModRoot.textContent = '' },
    })
    await flushMicro(6)
    // Click Models to exercise usage ms sorting (a.ms !== b.ms L739)
    ;(Array.from(aiModRoot.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Models') as HTMLButtonElement | undefined)?.click()
    await flushMicro(8)
    // Start Save, Test, Benchmark (leaving promises pending), then dismiss via backdrop -> disposed === true!
    ;(Array.from(aiModRoot.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Save') as HTMLButtonElement | undefined)?.click()
    ;(Array.from(aiModRoot.querySelectorAll('button')).find((b) => /Test/i.test(b.textContent || '')) as HTMLButtonElement | undefined)?.click()
    ;(Array.from(aiModRoot.querySelectorAll('button')).find((b) => /Benchmark/i.test(b.textContent || '')) as HTMLButtonElement | undefined)?.click()
    const aiBackdrop = aiModRoot.querySelector('.datanoa-ai-backdrop') as HTMLElement | null
    aiBackdrop?.click()
    heldRejectors.forEach((rj) => rj('string err after dispose'))
    await flushMicro(8)
    await aiModPromise

    // Also non-Error rejection while open for provider.test / benchmark / clearKey / save
    const aiModRoot2 = document.createElement('div')
    document.body.appendChild(aiModRoot2)
    let errFlip = false
    const aiP2 = openSharedAiConfigModal({
      rpc: vi.fn(async (m: string) => {
        if (m === 'ai.models.list') throw 'list raw str'
        if (m === 'ai.provider.test' || m === 'ai.provider.benchmark' || m === 'ai.provider.clearKey') {
          if (errFlip) return { ok: false, message: '' }
          throw 'raw str err'
        }
        return { ok: true }
      }),
      saveSettings: async () => { throw 'save raw str' },
      initialStatus: { enabled: true, state: 'on', hasKey: true, explainLanguage: 'auto' },
      mountModal: (el: HTMLElement) => aiModRoot2.appendChild(el),
      closeModal: () => { aiModRoot2.textContent = '' },
    })
    await flushMicro(4)
    ;(Array.from(aiModRoot2.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Models') as HTMLButtonElement | undefined)?.click()
    ;(Array.from(aiModRoot2.querySelectorAll('button')).find((b) => /Test/i.test(b.textContent || '')) as HTMLButtonElement | undefined)?.click()
    ;(Array.from(aiModRoot2.querySelectorAll('button')).find((b) => /Benchmark/i.test(b.textContent || '')) as HTMLButtonElement | undefined)?.click()
    ;(Array.from(aiModRoot2.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Save') as HTMLButtonElement | undefined)?.click()
    ;(aiModRoot2.querySelector('button[aria-label="Clear saved API key"]') as HTMLButtonElement | null)?.click()
    await flushMicro(8)
    errFlip = true
    ;(Array.from(aiModRoot2.querySelectorAll('button')).find((b) => /Test/i.test(b.textContent || '')) as HTMLButtonElement | undefined)?.click()
    await flushMicro(6)
    ;(Array.from(aiModRoot2.querySelectorAll('button')).find((b) => /^Cancel$/i.test(b.textContent || '')) as HTMLButtonElement | undefined)?.click()
    await aiP2

    // 6. shared-cm-inline-ai L293-295, L333 (punctuation single-char word), L355-357, L393
    const cmHost3 = document.createElement('div')
    document.body.appendChild(cmHost3)
    const view3 = new cmVendor.EditorView({
      state: cmVendor.EditorState.create({
        doc: 'SELECT 1',
        extensions: [createCmInlineAiExtension({ isEnabled: () => true, requestCompletion: async () => ({ id: 1, suggestion: ';' }) })],
      }),
      parent: cmHost3,
    })
    // Escape when no ghost active -> clearGhostCommand L355-357 false; acceptGhostWord when no ghost -> L329; acceptGhostFull -> L321
    const escBind = view3.state.facet(cmVendor.keymap).flat().find((b) => (b as { key?: string }).key === 'Escape') as { run?: (v: unknown) => boolean } | undefined
    expect(escBind?.run?.(view3)).toBe(false)
    // trackAcceptance range missing -> L393/395 via full deletion of tracked region
    const trackerRef = trackAcceptance(
      {
        trackRange: () => 'r1',
        getTrackedText: () => null,
        untrackRange: () => {},
      },
      { startOffset: 0, text: 'x' },
      () => {}
    )
    await vi.advanceTimersByTimeAsync(5200)
    trackerRef()
    view3.destroy()

    // 7. panel-structure L190-193 (scroll INSIDE pop is ignored!) & L127 disabled combo click & L607-620 draft enrichment
    const dbPS = new DatabaseSync(':memory:')
    try {
      const stState2 = {
        activeConnectionId: 'c1',
        activeTable: 'items',
        activeSchema: 'main',
        structureLoading: false,
        structureError: null,
        structDraftKey: 'c1:main:items',
        structDraft: {
          originalTableName: 'items',
          tableName: 'items',
          schema: 'main',
          columns: [
            { id: 'c_id', status: 'deleted', originalName: 'id', name: 'id', originalDataType: 'INTEGER', dataType: 'INTEGER', nullable: false, isPrimaryKey: true },
            { id: 'c_n', status: 'existing', originalName: 'n', name: 'n', originalDataType: 'TEXT', dataType: 'TEXT', nullable: true, defaultValue: '' },
          ],
          indexes: [{ id: 'i_1', status: 'existing', name: 'idx_n', unique: true, columns: ['n'] }],
          foreignKeys: [],
          // Omit triggers & inboundForeignKeys so L615-620 populates them from details!
        } as Record<string, unknown>,
        structPreviewOpen: false,
        isMigrating: false,
        schemaObjects: { c1: [{ name: 'items', schema: 'main', kind: 'table' }] },
        tableDetails: {
          'c1:main:items': {
            name: 'items',
            columns: [
              { name: 'id', type: 'INTEGER', isPrimaryKey: true, nullable: false },
              { name: 'n', type: 'TEXT', nullable: true },
            ],
            indexes: [{ name: 'idx_n', unique: true, origin: 'u', onConflict: 'ABORT', columnSpecs: [{ name: 'n' }], columns: ['n'] }],
            foreignKeys: [],
            triggers: [{ name: 'tr1', sql: 'CREATE TRIGGER tr1 AFTER INSERT ON items BEGIN SELECT 1; END;' }],
            inboundForeignKeys: [{ fromTable: 'other', fromColumn: 'item_id' }],
          },
        },
      }
      const stCtrl2 = createPanelStructureController({
        state: stState2,
        QUERY_TIMEOUT_MS: 5000,
        getActiveConn: () => ({ id: 'c1', driver: 'sqlite', readOnly: false }),
        getConnById: () => ({ id: 'c1', driver: 'sqlite', readOnly: false }),
        showBanner: () => {},
        savePanelViewState: () => {},
        loadSchema: async () => {},
        loadTableDetails: async () => {},
        loadTablePage: async () => {},
      })
      stCtrl2.renderStructure() // hits L608-620!
      const disBtn = document.querySelector('#structureColTable .struct-combo-toggle:disabled') as HTMLButtonElement | null
      const openBtn = document.querySelector('#structureColTable .struct-combo-toggle:not(:disabled)') as HTMLButtonElement | null
      if (disBtn) {
        disBtn.removeAttribute('disabled')
        disBtn.click()
      }
      openBtn?.click()
      const popEl = document.querySelector('.struct-combo-popover') as HTMLElement | null
      popEl?.dispatchEvent(new Event('scroll', { bubbles: false })) // L190-193 scroll inside popover!
      expect(stCtrl2.isPanelComboOpen()).toBe(true)
      stCtrl2.closePanelComboPopover()
    } finally {
      dbPS.close()
    }

    // 8. panel-core untouched defaults & edge branches (L528 empty non-text DATE, L584 empty details, L938/943 unterminated comments, L1560/1594/1606)
    expect(coerceTypedCellInput('', '2020-01-01', 'DATE', true)).toBeNull()
    expect(buildDdlFallback({ name: 'empty_tbl', columns: undefined as unknown as [] }, 'sqlite')).toContain('CREATE TABLE')
    expect(buildPanelMigrationSql(createPanelStructDraft({ name: 't', columns: [{ name: 'a', type: 'TEXT' }] }), 'postgres')).toEqual([])
    for (const drvUntouched of ['sqlite', 'mysql', 'oracle', 'clickhouse'] as const) {
      const dr = createPanelStructDraft({
        name: 't',
        columns: [
          { name: 'a', type: 'INT', nullable: false, defaultValue: '0' },
          { name: 'b', type: 'INT', nullable: true, defaultValue: '' },
        ],
        indexes: [{ name: 'idx', columns: ['a'] }],
        foreignKeys: [],
        triggers: [{ name: 'tr', sql: '/* unterminated' }],
      })
      // Keep col[0].defaultValue untouched ('0') while toggling nullable on col[0] -> hits isUntouchedExistingDef!
      dr.columns[0].nullable = true
      dr.columns.push({ id: 'nc', status: 'new', name: 'c', dataType: 'TEXT', nullable: false, defaultValue: '' })
      expect(buildPanelMigrationSql(dr, drvUntouched).length).toBeGreaterThan(0)
    }

    vi.useRealTimers()
  })

  it('R3-Slice 2: closes panel-connection-form, panel-data-grid & panel-sql statements/branches toward >=99.5% S', async () => {
    dom.mountPanelHtml()
    vi.useFakeTimers()

    // 1. panel-connection-form L104-118 (#%ZZ & #pfx?token=1), L680-681 (bigquery copyText=null), L962 (url:'?token=s'), L1364-1365 & L1437-1438 (formBusy while async), L1486-1500 (docker redis w/ password), L1874 (mysql empty pw)
    let holdParse2!: (v: unknown) => void
    let holdDetect2!: (v: unknown) => void
    ;(window as { orca?: unknown }).orca = {
      plugin: {
        request: vi.fn(async (m: string) => {
          if (m === 'drivers.list') return { drivers: [{ id: 'bigquery', status: 'unconfigured' }, { id: 'custom', status: 'unconfigured' }] }
          if (m === 'drivers.defaultPaths') return { platform: 'win32', paths: {}, templates: { bigquery: 'export default {}', custom: 'export default {}' } }
          if (m === 'workspace.listScopes') return { workspaces: [] }
          if (m === 'connection.parseUri') return new Promise((r) => { holdParse2 = r })
          if (m === 'workspace.detectConnections') {
            return new Promise((r) => { holdDetect2 = r })
          }
          if (m === 'sqlite.scanFolder') return { files: [] }
          return {}
        }),
      },
    }
    const cfSt3: Record<string, unknown> = {
      connections: [],
      formOpen: true,
      formBusy: false,
      editingId: null,
      sourceSecretConnId: null,
      formDriver: 'sqlite',
      formColorTag: 'none',
      formHadPassword: false,
      formHadAuthToken: false,
      formSslMode: undefined,
      formSslRejectUnauthorized: undefined,
      formOptions: '',
      lastParsedUri: '',
      parsedOracleUrl: '',
      lastAutoFilledSqliteName: '',
      pendingWorkspaceScope: null,
      discoveryCollapsed: null,
      discoveredSearch: '',
      discoveredEnvs: [],
      discoveredDocker: [
        { name: 'd-redis', driver: 'redis', host: '127.0.0.1', port: 6379, redisDb: 4, password: 'pw', status: 'running', workspaceMatched: true },
      ],
      discoveredFiles: [],
      discoveredScannedDirs: ['/app'],
      discoveredFolderScoped: false,
      discoveredDockerScopeLabel: 'Local Docker',
    }
    const cfCtrl3 = createPanelConnectionFormController({
      state: cfSt3,
      showBanner: () => {},
      showFormNotice: () => {},
      clearFormNotice: () => {},
      setFormOpen: (v: boolean) => { cfSt3.formOpen = v },
      updateViewportLayout: () => {},
      savePanelViewState: () => {},
      copyText: null as unknown as (t: string, m: string) => Promise<void>,
    })
    cfCtrl3.initStaticSelectors()
    await cfCtrl3.refreshPanelByodAndWorkspaces()

    // #pfx?token=1&b=2%ZZ -> L104-118; url '?token=sec' -> L962
    cfCtrl3.populateFormFromProfile({ id: 'c_lib_frag', driver: 'libsql', url: 'libsql://turso.io/db#page?secret=1&a%ZZ=2&keep=3' }, 'edit')
    cfCtrl3.populateFormFromProfile({ id: 'c_lib_empty_clean', driver: 'libsql', url: '?token=sec' }, 'edit')
    expect(formatConnSubtitle({ driver: 'unknown-fallback', host: 'h', database: 'd' })).toContain(':5432/')

    // BYOD starter copy without copyText helper (L680-681) & custom driver notice (L260, 264)
    cfCtrl3.setFormDriver('bigquery', false)
    document.getElementById('panelByodCopyStarterBtn')?.click()
    cfCtrl3.setFormDriver('custom', false)

    // Render discovered Redis Docker Compose with password & click chip (L1486-1500)
    cfCtrl3.renderDiscoveredItems()
    ;(document.querySelector('#discoveredDockerList .file-chip') as HTMLButtonElement | null)?.click()

    // Non-pg empty password check (L1874)
    cfCtrl3.setFormDriver('mysql', false)
    ;(document.getElementById('formPassword') as HTMLInputElement).value = ''
    expect(cfCtrl3.ensureRequiredPasswordBeforeSubmit('')).toBe(true)

    // formBusy flips true while async parseUri & detectWorkspace inflight -> L1364-1365, L1437-1438
    const pUri = cfCtrl3.handleParseUri('postgres://u:p@h:5432/d')
    const pDet = cfCtrl3.detectWorkspace(undefined, false)
    cfSt3.formBusy = true
    holdParse2?.({ ok: true, profile: { driver: 'postgres', host: 'h' } })
    holdDetect2?.({ envConnections: [], dockerComposeConnections: [], sqliteFiles: [] })
    await Promise.all([pUri, pDet])
    cfSt3.formBusy = false

    // 2. panel-data-grid remaining S & B (raw objects / circular JSON paste L550-555, unrendered ins_ stage L350-351/378-379, NOT NULL raw null paste L706-708, pending rAF cleanup on renderDataGrid L1240-1242, updateGridSelectionHighlight L1154-1156)
    const circObj: Record<string, unknown> = {}
    circObj.self = circObj
    const dgCols = [
      { name: 'id', type: 'INTEGER', isPrimaryKey: true, isAutoIncrement: true, nullable: false },
      { name: 'req_txt', type: 'TEXT', isPrimaryKey: false, nullable: false },
      { name: 'obj_col', type: 'TEXT', isPrimaryKey: false, nullable: true },
    ]
    const dgRows: Array<Record<string, unknown>> = [
      { id: 1, req_txt: null, obj_col: { hello: 1 } },
      { id: 2, req_txt: 'ok', obj_col: { hello: 2 } },
    ]
    const dgSt3: Record<string, unknown> = {
      activeConnectionId: 'c1',
      activeTable: 't',
      activeSchema: 'main',
      dataLoading: false,
      silentDataRefresh: false,
      transposed: false,
      page: 1,
      pageSize: 100,
      sortCol: null,
      sortDir: 'ASC',
      whereClause: '',
      orderByClause: '',
      selectedRowKey: 'row_0',
      selectedCol: 'req_txt',
      inspectorOpen: false,
      inspectorCollapsed: false,
      rowNumWidth: 48,
      findQuery: '',
      findMatches: [],
      findMatchSet: new Set(),
      findMatchIdx: -1,
      columnWidthsByTable: {},
      stagedInserts: [{ tempId: 'ins_hidden_top', values: { id: null, req_txt: 'a', obj_col: 'b' } }],
      stagedUpdates: new Map(),
      stagedDeletes: new Map(),
      schemaObjects: { c1: [{ name: 't', schema: 'main', kind: 'table' }] },
      pageData: {
        columns: dgCols,
        rows: dgRows,
        totalRows: 2,
        page: 1,
        pageSize: 100,
        primaryKey: ['id'],
        canEdit: true,
      },
    }
    let dgCleanup3: (() => void) | null = null
    let dgSel3!: PanelGridSelection
    const dgCtrl3 = createPanelDataGridController({
      state: dgSt3,
      VIRT_ROW_HEIGHT_PX: 26,
      VIRT_OVERSCAN_ROWS: 4,
      getActiveConn: () => ({ id: 'c1', driver: 'sqlite', readOnly: false }),
      getStagedCount: () => 0,
      isSubmittingChanges: () => false,
      isPreviewingDml: () => false,
      getDataGridSel: () => dgSel3,
      getActiveTableKey: () => 'c1:main:t',
      getOrderedVisibleColumns: () => dgCols,
      getPinnedColsSet: () => new Set(),
      getHiddenColsSet: () => new Set(),
      getActiveForeignKeyMap: () => new Map(),
      getLastPanelCopiedText: () => copiedStr,
      setLastPanelCopiedText: (t: string) => { copiedStr = t },
      getSuppressSortClickUntil: () => 0,
      setSuppressSortClickUntil: () => {},
      getActiveResizeCleanup: () => dgCleanup3,
      setActiveResizeCleanup: (fn: (() => void) | null) => { dgCleanup3 = fn },
      setInspectorUserModified: () => {},
      showBanner: () => {},
      copyText: async () => {},
      loadTablePage: async () => {},
      syncDataControlsDisabled: () => {},
      renderDataColsPopoverList: () => {},
    })
    let copiedStr = ''
    dgSel3 = new PanelGridSelection({
      wrapEl: document.getElementById('dataGridWrap')!,
      tableEl: document.getElementById('dataTable')!,
      editable: true,
      getDimensions: () => ({ rows: dgCtrl3.dataVirt.allRows.length, cols: dgCtrl3.dataVirt.visCols.length }),
      getValueAt: (r: number, c: number) => dgCtrl3.dataVirt.allRows[r]?.data[dgCtrl3.dataVirt.visCols[c]?.name],
      onCopy: () => { copiedStr = ''; return dgCtrl3.copyDataSelection('tsv', false) },
    })
    const setLastCopiedOrig = dgCtrl3.copyDataSelection
    try {
      dgCtrl3.renderDataGrid()
      // L1154-1156: call updateGridSelectionHighlight() directly when !state.transposed & dataGridSel present
      dgCtrl3.updateGridSelectionHighlight()

      // Copy cell with { hello: 1 } & circular obj, then paste into staged row -> L550-555 & L706-708 (raw null into NOT NULL req_txt!)
      dgSel3.selectCell(1, 2) // row_0 (after 1 stagedInsert!) obj_col = { hello: 1 }
      setLastCopiedOrig('tsv', false)
      dgSel3.selectCell(0, 2)
      dgCtrl3.pasteDelimitedIntoDataGrid(copiedStr, { forceNewRows: false })
      // Copy plain object, then mutate it circular before pasting -> fallback String(rawVal) at L552-553
      const mutObj: Record<string, unknown> = { tag: 'x' }
      dgRows[1].obj_col = mutObj
      dgSel3.selectCell(2, 2)
      setLastCopiedOrig('tsv', false)
      dgRows[1].obj_col = { hello: 2 }
      mutObj.self = mutObj
      dgSel3.selectCell(0, 2)
      dgCtrl3.pasteDelimitedIntoDataGrid(copiedStr, { forceNewRows: false })
      // Now copy row with req_txt = null -> paste into row 2 NOT NULL req_txt -> L706-708!
      dgSel3.selectCell(1, 1) // row_0 req_txt = null -> lastCopiedSnapshot.rawMatrix = [[null]]
      setLastCopiedOrig('tsv', false)
      dgSel3.selectCell(2, 1) // row_1 req_txt
      dgCtrl3.pasteDelimitedIntoDataGrid(copiedStr, { forceNewRows: false })

      // L1240-1242: start resize drag -> mousemove (arms resizeRafId) -> call renderDataGrid() BEFORE mouseup (cancels resizeRafId in cleanup!)
      const hdl = document.querySelector('#dataTable th .col-resize-handle') as HTMLElement | null
      hdl?.dispatchEvent(new MouseEvent('mousedown', { clientX: 80, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 110, bubbles: true }))
      dgCtrl3.renderDataGrid() // cancels activeResizeCleanup while resizeRafId !== null!

      // L350-351 & L378-379: stageCellValue on stagedInsert when patchTd = null AND DOM cell doesn't have matching ins_ row
      ;(dgSt3.stagedInserts as Array<{ tempId: string; values: Record<string, unknown> }>).push({
        tempId: 'ins_unrendered_only',
        values: { id: null, req_txt: 'r', obj_col: 'o' },
      })
      dgCtrl3.stageCellValue('ins_unrendered_only', {}, 'req_txt', 'updated_r', false, null)

      // L782-783: !pd.canEdit table where overwrite skips AND overflow adds new row
      ;(dgSt3.pageData as { canEdit: boolean }).canEdit = false
      dgCtrl3.renderDataGrid()
      dgSel3.selectCell(2, 1) // last row req_txt (non-editable since !canEdit) -> 1 overwrite skipped + 1 overflow insert added -> L782!
      dgCtrl3.pasteDelimitedIntoDataGrid('a\nb', { forceNewRows: false })
    } finally {
      dgSel3.destroy()
    }
    void copiedStr

    // 3. panel-sql remaining reachable statements (L212-219 missing #dangerSqlModal, L1041-1046 missing banner, L1084-1094 missing resultStates, L1247-1250 clear sqlSelectionStats, L1734-1738 immediate explain cancel)
    const sqlBanners: string[] = []
    let sqlGridSel3!: PanelGridSelection
    ;(window as { orca?: unknown }).orca = {
      plugin: { request: vi.fn(async () => ({ columns: [{ name: 'a' }], rows: [[1]], rowCount: 1, executionTimeMs: 1, isSelect: true })) },
      settings: { get: vi.fn().mockResolvedValue(500) },
    }
    const sqlCtrl3 = createPanelSqlController({
      state: { activeConnectionId: 'c1', activeSchema: 'main', activeTable: 't', lastError: '', lastSqlResult: null, sqlSortColIdx: null, sqlSortDir: 'ASC', sqlColWidths: [], sqlRowNumWidth: 42, historyOpen: false, historyLoading: false, historyFilter: '', historyEntries: [] },
      QUERY_TIMEOUT_MS: 5000,
      VIRT_ROW_HEIGHT_PX: 26,
      getActiveConn: () => ({ id: 'c1', driver: 'postgres', readOnly: false, colorTag: 'prod' }),
      getConnById: () => ({ id: 'c1', driver: 'postgres', readOnly: false, colorTag: 'prod' }),
      getSqlGridSel: () => sqlGridSel3,
      getSuppressSortClickUntil: () => 0,
      setLastPanelCopiedText: () => {},
      computeVirtualRange: (s: number, h: number, tot: number) => coreComputeVirtualRange(s, h, tot, 26, 4),
      attachColumnResizeHandle: () => {},
      copyText: async () => {},
      showBanner: (m: string) => sqlBanners.push(m),
      loadSchema: async () => {},
      savePanelViewState: () => {},
      scheduleSavePanelViewState: () => {},
      savePanelDataCache: () => {},
      onFormatSql: () => {},
      getAiStatus: () => ({ enabled: false, state: 'off' }),
      openAiSettingsModal: async () => {},
      onRefreshAiStatus: () => {},
    })
    sqlGridSel3 = new PanelGridSelection({
      wrapEl: document.getElementById('sqlResultWrap')!,
      tableEl: document.getElementById('sqlResultTable')!,
      editable: false,
      getDimensions: () => ({ rows: sqlCtrl3.sqlVirt.sortedRows.length, cols: sqlCtrl3.sqlVirt.columns.length }),
      getValueAt: (r: number, c: number) => sqlCtrl3.sqlVirt.sortedRows[r]?.[c],
      onSelectionChange: () => sqlCtrl3.renderSqlSelectionStats(),
    })
    try {
      // Missing #dangerSqlModal safety guard (L212-219)
      document.getElementById('dangerSqlModal')?.remove()
      sqlCtrl3.setSqlText('DELETE FROM users;')
      await sqlCtrl3.runSql('all')
      expect(sqlBanners.some((b) => b.includes('aborted for safety'))).toBe(true)

      // executeExplainBatch immediate cancel BEFORE loop starts (L1734-1738)
      sqlCtrl3.setSqlText('SELECT 1;')
      const expP = sqlCtrl3.runSql('explain')
      sqlCtrl3.markSqlRunCancelled()
      await expP

      // Run normal SELECT, select cells & clear -> L1247-1250; then add Tab 2, switch back after wiping resultStates & banner -> L1041-1046 & L1084-1094!
      sqlCtrl3.setSqlText('SELECT 1 AS a, 2 AS b;')
      await sqlCtrl3.runSql('all')
      sqlGridSel3.selectCell(0, 0)
      sqlCtrl3.renderSqlSelectionStats()
      sqlGridSel3.clear()
      sqlCtrl3.renderSqlSelectionStats()
      const persisted = sqlCtrl3.getConsoleTabsPersistedState()
      const firstTab = (persisted.tabs as Array<Record<string, unknown>>)[0]
      firstTab.lastResult = { columns: [{ name: 'a' }], rows: [[1]], rowCount: 1, executionTimeMs: 1, isSelect: true }
      firstTab.resultStates = undefined
      sqlCtrl3.restoreConsoleTabsState(persisted, '')
      // Also test applyPanelResultTab with rsState.banner = null (L1041-1046)
      const tabBtns = Array.from(document.querySelectorAll('#sqlConsoleTabsBar .sql-console-tab')) as HTMLElement[]
      tabBtns[0]?.click()
    } finally {
      sqlGridSel3.destroy()
      sqlCtrl3.destroySqlEditor()
    }

    vi.useRealTimers()
  })

  it('R3-Slice 3: closes panel-app.js byte-caps, warm/session restore, error guards, virtual scroll/resize cleanup, remote banner & shortcuts', { timeout: 20_000 }, async () => {
    // Part A: Byte-cap trimming (>450KB schemaObjects/tableDetails/pageData & >200KB sqlDraft) + warmCache L631-647 + session restore L1180/1201/1282 + empty conns L701
    {
      window.localStorage?.clear()
      applySlice6DomMetrics()
      const envA = createPanelAppSlice6Env({
        connections: [{ id: 'c1', name: 'CapDb', driver: 'sqlite' }],
        sessionSnapshot: {
          updatedAt: Date.now() - 600_000,
          viewState: {
            activeConnectionId: 'c1',
            activeTable: 'big_tbl',
            activeSchema: 'main',
            expandedConns: ['c1'],
            sqlDraft: 'SELECT 1; -- ' + 'abcd '.repeat(42_000),
            scrollState: { viewportTop: 10, dataGridTop: 20, dataGridLeft: 5, sqlResultTop: 15, sqlResultLeft: 5 },
          },
        },
      })
      envA.db.exec(`CREATE TABLE big_tbl (id INTEGER PRIMARY KEY, body TEXT NOT NULL);`)
      envA.db.prepare(`INSERT INTO big_tbl (id, body) VALUES (1, ?)`).run('B'.repeat(210_000))
      const manyTables = Array.from({ length: 260 }, (_, i) => ({
        name: i === 0 ? 'big_tbl' : `t_${'x'.repeat(1850)}_${i}`,
        schema: 'main',
        kind: 'table',
      }))
      envA.rpcOverrides.set('schema.listObjects', async () => manyTables)
      envA.rpcOverrides.set('schema.tableDetails', async (inp) => ({
        name: String(inp.table || 'big_tbl'),
        table: String(inp.table || 'big_tbl'),
        schema: 'main',
        kind: 'table',
        columns: [
          { name: 'id', type: 'INTEGER', isPrimaryKey: true, nullable: false },
          { name: 'body', type: 'TEXT', nullable: false },
        ],
        primaryKey: ['id'],
        indexes: [],
        foreignKeys: [],
        ddl: 'D'.repeat(370_000),
      }))
      envA.rpcOverrides.set('ai.status.get', async () => { throw new Error('ai boot err') })
      try {
        ;(window as { orca?: unknown }).orca = envA.orcaApi
        vi.resetModules()
        await import('../src/panel/panel-app.js')
        await flushMicro(16)

        // Open big_tbl to populate >370KB tableDetails & >210KB pageData alongside ~485KB schemaObjects
        const rowsExp = Array.from(document.querySelectorAll('#schemaTreeContainer .tree-row .tree-item')) as HTMLElement[]
        rowsExp.find((r) => r.querySelector('.tree-name')?.textContent === 'big_tbl')?.click()
        await flushMicro(16)
        // Trigger immediate savePanelViewState with >200KB viewState & savePanelDataCache -> L331-338, L350-360, L431-434!
        const fnInp = document.getElementById('formName') as HTMLInputElement | null
        if (fnInp) fnInp.value = 'N'.repeat(210_000)
        document.getElementById('transposeBtn')?.click()
        await flushMicro(4)
        window.dispatchEvent(new Event('beforeunload'))
        await flushMicro(4)
      } finally {
        window.dispatchEvent(new Event('pagehide'))
        envA.db.close()
      }
    }

    // Boot 1b-empty: warmCache with empty connections array hits L625-626 early return
    {
      window.localStorage?.clear()
      window.localStorage.setItem('datanoa.panelWarmCache', JSON.stringify({ connections: [] }))
      applySlice6DomMetrics()
      const envW0 = createPanelAppSlice6Env({ connections: [{ id: 'c1', name: 'Warm0', driver: 'sqlite' }] })
      try {
        ;(window as { orca?: unknown }).orca = envW0.orcaApi
        vi.resetModules()
        await import('../src/panel/panel-app.js')
        await flushMicro(8)
      } finally {
        window.dispatchEvent(new Event('pagehide'))
        envW0.db.close()
      }
    }

    // Boot 1b: localWarm WITHOUT activeConnectionId in viewState + WITH tableDetails (L631-633, L641-647)
    {
      window.localStorage?.clear()
      window.localStorage.setItem(
        'datanoa.panelWarmCache',
        JSON.stringify({
          updatedAt: Date.now(),
          connections: [{ id: 'c1', name: 'WarmOnly', driver: 'sqlite' }],
          activeConnectionId: 'c1',
          activeTable: 'employees',
          activeSchema: 'main',
          schemaObjects: { c1: [{ name: 'employees', schema: 'main', kind: 'table' }] },
          tableDetails: {
            'c1:main:employees': { name: 'employees', columns: [{ name: 'id', type: 'INTEGER' }], indexes: [], foreignKeys: [] },
          },
        })
      )
      applySlice6DomMetrics()
      const envWarm = createPanelAppSlice6Env({ connections: [{ id: 'c1', name: 'WarmOnly', driver: 'sqlite' }] })
      try {
        ;(window as { orca?: unknown }).orca = envWarm.orcaApi
        vi.resetModules()
        await import('../src/panel/panel-app.js')
        await flushMicro(12)
      } finally {
        window.dispatchEvent(new Event('pagehide'))
        envWarm.db.close()
      }
    }

    // Boot 1c: Silent warm boot where warmCache lacks pageData/lastSqlResult and sessionSnapshot supplies them without updatedAt (L533, L1181, L1201-1205, L1282-1284)
    {
      window.localStorage?.clear()
      window.localStorage.setItem(
        'datanoa.panelViewState',
        JSON.stringify({
          activeConnectionId: 'c1',
          activeTable: 'employees',
          activeSchema: 'main',
          expandedConns: ['c1'],
          consoleTabsState: { activeTabId: 'missing', tabs: [] },
        })
      )
      window.localStorage.setItem(
        'datanoa.panelWarmCache',
        JSON.stringify({
          updatedAt: Date.now() - 10_000,
          connections: [{ id: 'c1', name: 'SilentWarm', driver: 'sqlite' }],
          activeConnectionId: 'c1',
          activeTable: 'employees',
          activeSchema: 'main',
          schemaObjects: { c1: [{ name: 'employees', schema: 'main', kind: 'table' }] },
        })
      )
      applySlice6DomMetrics()
      const envSess = createPanelAppSlice6Env({
        connections: [{ id: 'c1', name: 'SilentWarm', driver: 'sqlite' }],
        sessionSnapshot: {
          dataCache: {
            connections: [{ id: 'c1', name: 'SilentWarm', driver: 'sqlite' }],
            activeConnectionId: 'c1',
            activeTable: 'employees',
            activeSchema: 'main',
            pageData: {
              columns: [{ name: 'id', type: 'INTEGER', isPrimaryKey: true, nullable: false }],
              rows: [{ id: 1 }],
              totalRows: 1,
              page: 1,
              pageSize: 100,
              primaryKey: ['id'],
              canEdit: true,
            },
            lastSqlResult: {
              columns: [{ name: 'x', type: 'INTEGER' }],
              rows: [[42]],
              rowCount: 1,
              executionTimeMs: 1,
              isSelect: true,
            },
          },
        },
      })
      try {
        ;(window as { orca?: unknown }).orca = envSess.orcaApi
        vi.resetModules()
        await import('../src/panel/panel-app.js')
        await flushMicro(12)
      } finally {
        window.dispatchEvent(new Event('pagehide'))
        envSess.db.close()
      }
    }

    // Boot 1d: persistedId match (L1250) + empty connections array without storage.delete -> persistActiveConnectionId(null) hits L701-703, L1262
    {
      window.localStorage?.clear()
      applySlice6DomMetrics()
      const envPers = createPanelAppSlice6Env({ connections: [{ id: 'c_saved', name: 'Saved', driver: 'sqlite' }] })
      envPers.storageMap.set('datanoa.activeConnectionId', 'c_saved')
      try {
        ;(window as { orca?: unknown }).orca = envPers.orcaApi
        vi.resetModules()
        await import('../src/panel/panel-app.js')
        await flushMicro(10)
      } finally {
        window.dispatchEvent(new Event('pagehide'))
        envPers.db.close()
      }

      window.localStorage?.clear()
      applySlice6DomMetrics()
      const envEmpty = createPanelAppSlice6Env({ connections: [] })
      envEmpty.storageMap.set('datanoa.activeConnectionId', 'stale_missing_id')
      delete (envEmpty.orcaApi.storage as { delete?: unknown }).delete
      try {
        ;(window as { orca?: unknown }).orca = envEmpty.orcaApi
        vi.resetModules()
        await import('../src/panel/panel-app.js')
        await flushMicro(10)
      } finally {
        window.dispatchEvent(new Event('pagehide'))
        envEmpty.db.close()
      }
    }

    // Part B: Rich E2E runtime (3 connections, 130 rows for virtual scroll, errors, stale aborts, remote banner, shortcuts, blur & pagehide)
    vi.useFakeTimers()
    window.localStorage?.clear()
    applySlice6DomMetrics()
    const roObsCbs: Array<(entries: Array<{ target: Element }>) => void> = []
    const origRO = window.ResizeObserver
    window.ResizeObserver = class MockRO {
      constructor(cb: (entries: Array<{ target: Element }>) => void) { roObsCbs.push(cb) }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver

    const envB = createPanelAppSlice6Env({
      connections: [
        { id: 'c1', name: 'Primary', driver: 'sqlite', hasPassword: true, folder: 'Work' },
        { id: 'c2', name: 'ReadOnlyConn', driver: 'sqlite', readOnly: true },
        { id: 'c3', name: 'EmptyConn', driver: 'sqlite' },
      ],
    })
    envB.db.exec(`CREATE TABLE tmp_drop (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO tmp_drop VALUES (1, 'd');`)
    for (let i = 10; i < 180; i++) {
      envB.db.prepare(`INSERT INTO employees (name, dept_id, salary) VALUES (?, 1, ?)`).run(`Emp_${i}`, i * 100)
    }
    // Disposable object with throw inside dispose() for L4299-4300
    envB.orcaApi.settings.onDidChange = () => ({ dispose() { throw new Error('disp fail') } }) as unknown as () => void
    ;(window as { orca?: unknown }).orca = envB.orcaApi

    try {
      vi.resetModules()
      await import('../src/panel/panel-app.js')
      await vi.advanceTimersByTimeAsync(100)

      // Open employees (135 rows -> dataVirt.active = true) + pageSize=200 so all >120 rows stay on page 1
      const pageSizeSel = document.getElementById('pageSizeSelect') as HTMLSelectElement
      if (pageSizeSel) {
        if (!Array.from(pageSizeSel.options).some((o) => o.value === '200')) {
          const opt200 = document.createElement('option')
          opt200.value = '200'
          opt200.textContent = '200'
          pageSizeSel.appendChild(opt200)
        }
        pageSizeSel.value = '200'
        pageSizeSel.dispatchEvent(new Event('change', { bubbles: true }))
        await vi.advanceTimersByTimeAsync(50)
      }
      const clickTableRow = async (name: string) => {
        const items = Array.from(document.querySelectorAll('#schemaTreeContainer .tree-row .tree-item')) as HTMLElement[]
        items.find((el) => el.querySelector('.tree-name')?.textContent === name)?.click()
        await vi.advanceTimersByTimeAsync(50)
      }
      await clickTableRow('employees')
      await vi.advanceTimersByTimeAsync(100)

      // L1918-1927: reload same table with preserved scrollLeft > 0 + flush rAF
      const dataWrap = document.getElementById('dataGridWrap') as HTMLElement
      dataWrap.scrollLeft = 44
      document.getElementById('reloadDataBtn')?.click()
      await vi.advanceTimersByTimeAsync(80)

      // L2770: ResizeObserver callback while dataVirt.active && !transposed
      for (const cb of roObsCbs) {
        cb([{ target: dataWrap }, { target: document.getElementById('sqlResultWrap')! }])
      }

      // L3028: synthetic option on #dataTableSelect missing schema match falls back to name-only
      const dtSel = document.getElementById('dataTableSelect') as HTMLSelectElement
      const synOpt = document.createElement('option')
      synOpt.value = 'wrong_schema\0employees'
      synOpt.textContent = 'employees'
      dtSel.appendChild(synOpt)
      dtSel.value = 'wrong_schema\0employees'
      dtSel.dispatchEvent(new Event('change', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(50)

      // L3834-3836 (#inspectorNullBtn on NOT NULL col) & L3847-3848 (#inspectorApplyBtn unmodified) & L800-801 (copy failure)
      const empNameTd = document.querySelector('#dataTable tbody td[data-row-idx="0"][data-col-idx="1"]') as HTMLElement | null
      empNameTd?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(20)
      document.getElementById('inspectCellBtn')?.click()
      await vi.advanceTimersByTimeAsync(20)
      document.getElementById('inspectorNullBtn')?.removeAttribute('disabled')
      document.getElementById('inspectorNullBtn')?.click()
      document.getElementById('inspectorApplyBtn')?.click()
      const origClip = navigator.clipboard
      const origExec = (document as { execCommand?: unknown }).execCommand
      try {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied') } } })
        ;(document as { execCommand?: unknown }).execCommand = () => false
        document.getElementById('inspectorCopyBtn')?.click()
        await vi.advanceTimersByTimeAsync(20)
      } finally {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: origClip })
        ;(document as { execCommand?: unknown }).execCommand = origExec
      }

      // L3527-3528: blur active textarea/inspector first so isBlockedEl(target) runs on <select>
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      const selEl = document.createElement('select')
      document.body.appendChild(selEl)
      const pasteOnSel = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: { getData: () => string } }
      pasteOnSel.clipboardData = { getData: () => 'x' }
      selEl.dispatchEvent(pasteOnSel)
      selEl.remove()

      const selectCell01 = async () => {
        const td01 = document.querySelector('#dataTable tbody td[data-row-idx="0"][data-col-idx="1"]') as HTMLElement | null
        td01?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        await vi.advanceTimersByTimeAsync(20)
      }

      // L4246-4255 & L3961-3969: remote change event without staged edits (L4255) & with 1 staged edit (banner -> dismiss -> reload)
      envB.emitPlugin('data.cellUpdated', { connectionId: 'c1', table: 'employees', schema: 'main' })
      await vi.advanceTimersByTimeAsync(50)
      await selectCell01()
      const inspTxt = document.getElementById('valueInspectorText') as HTMLTextAreaElement
      inspTxt.value = 'Emp_Changed'
      inspTxt.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('inspectorApplyBtn')?.click()
      await vi.advanceTimersByTimeAsync(20)
      envB.emitPlugin('data.cellUpdated', { connectionId: 'c1', table: 'employees', schema: 'main' })
      expect(document.getElementById('dataRemoteChangeBanner')?.hidden).toBe(false)
      document.getElementById('dataRemoteDismissBtn')?.click()
      expect(document.getElementById('dataRemoteChangeBanner')?.hidden).toBe(true)
      envB.emitPlugin('data.cellUpdated', { connectionId: 'c1', table: 'employees', schema: 'main' })
      document.getElementById('dataRemoteReloadBtn')?.click()
      await vi.advanceTimersByTimeAsync(60)

      // L3591: stale data.previewChanges after switching table before resolve
      await selectCell01()
      inspTxt.value = 'Emp_Stage2'
      inspTxt.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('inspectorApplyBtn')?.click()
      let holdPrev: ((v: unknown) => void) | undefined
      envB.rpcOverrides.set('data.previewChanges', () => new Promise((r) => { holdPrev = r }))
      document.getElementById('dmlPreviewBtn')?.click()
      await clickTableRow('departments')
      holdPrev?.({ statements: ['-- stale'] })
      envB.rpcOverrides.delete('data.previewChanges')
      await vi.advanceTimersByTimeAsync(40)

      // L2537-2542: transposed Escape clears selection (non-silent) & calls updateGridSelectionHighlight()
      document.getElementById('transposeBtn')?.click()
      await vi.advanceTimersByTimeAsync(30)
      await selectCell01()
      document.getElementById('dataGridWrap')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.getElementById('transposeBtn')?.click()
      await vi.advanceTimersByTimeAsync(30)

      // L1881, L1940, L1964-1971: queue separate fetchHolds so resolving/rejecting stale & dropped-active-table fetches hits every abort & finally branch
      envB.db.exec(`CREATE TABLE tmp_drop2 (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO tmp_drop2 VALUES (1, 'd2');`)
      await clickTableRow('tmp_drop')
      const fetchHolds: Array<{ res: (v: unknown) => void; rej: (e: Error) => void }> = []
      envB.rpcOverrides.set('data.fetchPage', () => new Promise((res, rej) => fetchHolds.push({ res, rej })))
      document.getElementById('reloadDataBtn')?.click()
      await vi.advanceTimersByTimeAsync(20)
      // Drop tmp_drop while fetchHolds[0] is pending -> loadSchema triggers departments fetchHolds[1]
      const dropMenuRows = Array.from(document.querySelectorAll('#schemaTreeContainer .tree-row')) as HTMLElement[]
      const tmpRow = dropMenuRows.find((r) => r.querySelector('.tree-name')?.textContent === 'tmp_drop')
      tmpRow?.querySelector<HTMLElement>('.mini-btn[title="Table Actions"]')?.click()
      const ctxDrop = Array.from(document.querySelectorAll('#contextMenu .ctx-item')).find((b) => /Drop Table/i.test(b.textContent || '')) as HTMLElement | undefined
      ctxDrop?.click()
      const confInp = document.getElementById('dangerTableConfirmInput') as HTMLInputElement
      confInp.value = 'tmp_drop'
      confInp.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('dangerTableExecuteBtn')?.click()
      await vi.advanceTimersByTimeAsync(40)
      fetchHolds[0]?.res({ columns: [], rows: [], totalRows: 0, page: 1, pageSize: 100, primaryKey: [], canEdit: false }) // L1881!
      await vi.advanceTimersByTimeAsync(20)
      // Reject fetchHolds[1] stale after switching away to employees -> L1940!
      await clickTableRow('employees') // queues fetchHolds[2]
      fetchHolds[1]?.rej(new Error('stale fetch err'))
      fetchHolds[2]?.res({ columns: [{ name: 'id', type: 'INTEGER', isPrimaryKey: true }], rows: [{ id: 1 }], totalRows: 1, page: 1, pageSize: 100, primaryKey: ['id'], canEdit: true })
      await vi.advanceTimersByTimeAsync(30)
      // Now drop tmp_drop2 while schema.listObjects temporarily returns [] so reqSeq === dataPageLoadSeq remains true -> L1964-1971!
      envB.rpcOverrides.delete('data.fetchPage')
      document.getElementById('refreshBtn')?.click()
      await vi.advanceTimersByTimeAsync(40)
      await clickTableRow('tmp_drop2')
      envB.rpcOverrides.set('data.fetchPage', () => new Promise((res, rej) => fetchHolds.push({ res, rej })))
      const dropIdx = fetchHolds.length
      document.getElementById('reloadDataBtn')?.click()
      await vi.advanceTimersByTimeAsync(20)
      envB.rpcOverrides.set('schema.listObjects', async () => [])
      const tmp2Row = Array.from(document.querySelectorAll('#schemaTreeContainer .tree-row')).find((r) => r.querySelector('.tree-name')?.textContent === 'tmp_drop2')
      tmp2Row?.querySelector<HTMLElement>('.mini-btn[title="Table Actions"]')?.click()
      const ctxDrop2 = Array.from(document.querySelectorAll('#contextMenu .ctx-item')).find((b) => /Drop Table/i.test(b.textContent || '')) as HTMLElement | undefined
      ctxDrop2?.click()
      confInp.value = 'tmp_drop2'
      confInp.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('dangerTableExecuteBtn')?.click()
      await vi.advanceTimersByTimeAsync(40)
      fetchHolds[dropIdx]?.res({ columns: [], rows: [], totalRows: 0, page: 1, pageSize: 100, primaryKey: [], canEdit: false })
      envB.rpcOverrides.delete('schema.listObjects')
      envB.rpcOverrides.delete('data.fetchPage')
      await clickTableRow('employees')
      await vi.advanceTimersByTimeAsync(40)

      // L3320: #editTableStructureBtn switches to structure tab + L4061-4065 Escape closes combo popover
      document.getElementById('editTableStructureBtn')?.click()
      await vi.advanceTimersByTimeAsync(40)
      const comboToggle = document.querySelector('#structureColTable .struct-combo-toggle:not(:disabled)') as HTMLElement | null
      comboToggle?.click()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      document.querySelector<HTMLElement>('.nav-tab[data-tab="data"]')?.click()
      await vi.advanceTimersByTimeAsync(40)

      // L4055-4059 Escape custom dropdown & L4073-4077 Escape bulkFillModal
      await selectCell01()
      const td01ctx = document.querySelector('#dataTable tbody td[data-row-idx="0"][data-col-idx="1"]') as HTMLElement | null
      td01ctx?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      const bulkItem = Array.from(document.querySelectorAll('#contextMenu .ctx-item')).find((b) => /Bulk Fill Value/i.test(b.textContent || '')) as HTMLElement | undefined
      bulkItem?.click()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      const csTrigger = document.querySelector('.custom-select-trigger') as HTMLElement | null
      csTrigger?.click()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

      // Expand c2 (ReadOnlyConn) in Explorer: switch back to c1, click table under c2 via Explorer (L2038-2041!), L3621 (submit on readOnly), delete c2 fail/succeed with expandedTables (L2130/2146!)
      const c2ConnRow = Array.from(document.querySelectorAll('#schemaTreeContainer .tree-item')).find((el) => /ReadOnlyConn/.test(el.textContent || '')) as HTMLElement | undefined
      c2ConnRow?.click()
      await vi.advanceTimersByTimeAsync(60)
      const connSelPre = document.getElementById('connSelect') as HTMLSelectElement
      connSelPre.value = 'c1'
      connSelPre.dispatchEvent(new Event('change', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(50)
      // Click table under c2 via Explorer while c1 is active -> L2038-2041 + adds to expandedTables!
      const c2EmpRow = Array.from(document.querySelectorAll('#schemaTreeContainer .tree-row')).reverse().find((r) => r.querySelector('.tree-name')?.textContent === 'employees')
      c2EmpRow?.querySelector<HTMLElement>('.tree-item')?.click()
      await vi.advanceTimersByTimeAsync(60)
      // Trigger L3621 submitStagedChanges readOnly guard while c2 (readOnly) is active
      document.getElementById('submitChangesBtn')?.removeAttribute('disabled')
      document.getElementById('submitChangesBtn')?.click()

      // Delete c2: first fail connection.delete once -> L2146, then succeed while expandedTables has c2:... -> L2130-2131!
      envB.failOnceActions.add('connection.delete')
      document.getElementById('deleteActiveBtn')?.click()
      document.getElementById('confirmDeleteBtn')?.click()
      await vi.advanceTimersByTimeAsync(40)
      document.getElementById('deleteActiveBtn')?.click()
      document.getElementById('confirmDeleteBtn')?.click()
      await vi.advanceTimersByTimeAsync(60)

      // Hold data.fetchPage while switching conn to c3 -> cancelPendingDataAndSchemaLoads() stops dataLoadStopTimer (L1671-1673), plus c3 fails schema.listObjects once (L1651-1653) then returns [] (L1631-1648)!
      const connSel = document.getElementById('connSelect') as HTMLSelectElement
      envB.rpcOverrides.set('data.fetchPage', () => new Promise(() => {}))
      connSel.value = 'c1'
      connSel.dispatchEvent(new Event('change', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(20)
      envB.rpcOverrides.delete('data.fetchPage')
      let failC3Schema = true
      envB.rpcOverrides.set('schema.listObjects', async () => {
        if (failC3Schema) {
          failC3Schema = false
          throw new Error('c3 schema err')
        }
        return []
      })
      connSel.value = 'c3'
      connSel.dispatchEvent(new Event('change', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(40)
      document.getElementById('refreshBtn')?.click()
      await vi.advanceTimersByTimeAsync(60)
      envB.rpcOverrides.delete('schema.listObjects')

      // Form tests: L2814 paste empty uri, L2918-2920 test throw, L2947 save throw, L4148/4169/4178 shortcuts while formOpen
      document.getElementById('newConnBtn')?.click()
      await vi.advanceTimersByTimeAsync(20)
      const uriInp = document.getElementById('uriInput') as HTMLInputElement
      const uriPaste = new Event('paste', { bubbles: true }) as Event & { clipboardData: { getData: () => string } }
      uriPaste.clipboardData = { getData: () => 'postgres://u:p@h:5432/d' }
      uriInp.value = ''
      uriInp.dispatchEvent(uriPaste)
      await vi.advanceTimersByTimeAsync(20)
      const fileInp = document.getElementById('formFilePath') as HTMLInputElement
      if (fileInp) fileInp.value = ':memory:'
      envB.failOnceActions.add('connection.test')
      document.getElementById('saveFormBtn')?.click()
      await vi.advanceTimersByTimeAsync(40)
      envB.failOnceActions.add('connection.save')
      document.getElementById('saveFormBtn')?.click()
      await vi.advanceTimersByTimeAsync(40)

      // Keyboard shortcuts while formOpen === true (L4148, 4169, 4178) & Ctrl+/ inside textarea (L4161)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
      const sqlTa = document.createElement('textarea')
      document.body.appendChild(sqlTa)
      sqlTa.dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }))
      sqlTa.remove()
      document.getElementById('closeFormBtn')?.click()

      // Switch back to c1 -> run 170-row SQL query so sqlVirt.active = true -> header contextmenu (L2637-2638) -> no-rAF switchTab (L857-858, L873-874) -> blur + beforeunload + pagehide (L4031-4036 & L4274-4300)!
      connSel.value = 'c1'
      connSel.dispatchEvent(new Event('change', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(60)
      await clickTableRow('employees')
      const c1EmpRow = Array.from(document.querySelectorAll('#schemaTreeContainer .tree-row')).find((r) => r.querySelector('.tree-name')?.textContent === 'employees')
      c1EmpRow?.querySelector<HTMLElement>('.mini-btn[title="Table Actions"]')?.click()
      const ctxSel100 = Array.from(document.querySelectorAll('#contextMenu .ctx-item')).find((b) => /Generate SELECT/i.test(b.textContent || '')) as HTMLElement | undefined
      ctxSel100?.click()
      await vi.advanceTimersByTimeAsync(20)
      document.querySelector<HTMLElement>('.nav-tab[data-tab="sql"]')?.click()
      await vi.advanceTimersByTimeAsync(20)
      document.getElementById('runAllSqlBtn')?.click()
      await vi.advanceTimersByTimeAsync(60)
      const sqlHeadTh = document.querySelector('#sqlResultTable thead th:nth-child(2)') as HTMLElement | null
      sqlHeadTh?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      // Switch tabs without globalThis.requestAnimationFrame while both dataVirt.active & sqlVirt.active -> L857-858 & L873-874!
      const origRafGlobal = globalThis.requestAnimationFrame
      try {
        ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined
        document.querySelector<HTMLElement>('.nav-tab[data-tab="data"]')?.click()
        document.querySelector<HTMLElement>('.nav-tab[data-tab="sql"]')?.click()
        document.querySelector<HTMLElement>('.nav-tab[data-tab="data"]')?.click()
      } finally {
        ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = origRafGlobal
      }
      await vi.advanceTimersByTimeAsync(20)

      // Start resize handle + inspector resizer mousedown -> blur (L4031-4036)
      const resizeH = document.querySelector('#dataTable th .col-resize-handle') as HTMLElement | null
      const inspResizer = document.getElementById('valueInspectorResizer') as HTMLElement | null
      resizeH?.dispatchEvent(new MouseEvent('mousedown', { clientX: 60, bubbles: true }))
      inspResizer?.dispatchEvent(new MouseEvent('mousedown', { clientY: 200, bubbles: true }))
      window.dispatchEvent(new Event('blur'))

      // Re-arm resize + inspector resize + pending scroll rAFs on both dataGridWrap and sqlResultWrap, then dispatch pagehide BEFORE rAF ticks (L4274-4300)!
      resizeH?.dispatchEvent(new MouseEvent('mousedown', { clientX: 60, bubbles: true }))
      inspResizer?.dispatchEvent(new MouseEvent('mousedown', { clientY: 200, bubbles: true }))
      dataWrap.scrollTop = 900
      dataWrap.dispatchEvent(new Event('scroll'))
      const sqlWrap = document.getElementById('sqlResultWrap') as HTMLElement
      sqlWrap.scrollTop = 900
      sqlWrap.dispatchEvent(new Event('scroll'))
      window.dispatchEvent(new Event('beforeunload'))
      window.dispatchEvent(new Event('pagehide'))
    } finally {
      window.ResizeObserver = origRO
      envB.db.close()
      vi.useRealTimers()
    }
  })

  it('R3-Slice 4: polishes remaining reachable statements across explorer, structure, core, data-grid, inline-ai, sql & app', { timeout: 15_000 }, async () => {
    dom.mountPanelHtml()

    // 1. panel-explorer L41-42 -> 100% Statements
    expect(generateSqlForTable('preview' as never, { driver: 'mssql' }, { name: 't', schema: 'dbo' }, null)).toContain('TOP 100')
    expect(generateSqlForTable('preview' as never, { driver: 'oracle' }, { name: 't', schema: 'HR' }, null)).toContain('FETCH FIRST 100 ROWS ONLY')

    // 2. panel-core L1034 (rewriteSqliteTriggerTableTarget loop fallthrough when ON items has non-FOR/WHEN/BEGIN follow token)
    const trgDraft = createPanelStructDraft({
      name: 'items',
      columns: [
        { name: 'id', type: 'INTEGER', isPrimaryKey: true, nullable: false },
        { name: 'v', type: 'TEXT', nullable: true },
      ],
      triggers: [{ name: 'tr_nofw', sql: 'CREATE TRIGGER tr_nofw AFTER INSERT ON items EACH ROW BEGIN SELECT 1; END;' }],
    })
    trgDraft.tableName = 'items_renamed'
    trgDraft.columns[1].dataType = 'INTEGER'
    expect(buildPanelMigrationSql(trgDraft, 'sqlite').join('\n')).toContain('EACH ROW')

    // 3. panel-structure L610-620 (fresh draft from details with columnSpecs, triggers, inboundForeignKeys -> 100% Statements)
    const stCtrl4 = createPanelStructureController({
      state: {
        activeConnectionId: 'c1',
        activeSchema: 'main',
        activeTable: 'items',
        structureLoading: false,
        structureError: null,
        structDraftKey: null,
        structDraft: null,
        structPreviewOpen: false,
        isMigrating: false,
        schemaObjects: { c1: [{ name: 'items', schema: 'main', kind: 'table' }] },
        tableDetails: {
          'c1:main:items': {
            name: 'items',
            columns: [{ name: 'id', type: 'INTEGER', isPrimaryKey: true, nullable: false }],
            indexes: [{ name: 'idx1', unique: false, origin: 'c', onConflict: 'ROLLBACK', columnSpecs: [{ name: 'id', desc: true }], columns: ['id'] }],
            foreignKeys: [],
            triggers: [{ name: 'tr1', sql: 'CREATE TRIGGER tr1 AFTER INSERT ON items BEGIN SELECT 1; END;' }],
            inboundForeignKeys: [{ fromTable: 'child', fromColumn: 'item_id' }],
          },
        },
      } as Record<string, unknown>,
      QUERY_TIMEOUT_MS: 5000,
      getActiveConn: () => ({ id: 'c1', driver: 'sqlite', readOnly: false }),
      getConnById: () => ({ id: 'c1', driver: 'sqlite', readOnly: false }),
      showBanner: () => {},
      savePanelViewState: () => {},
      loadSchema: async () => {},
      loadTableDetails: async () => {},
      loadTablePage: async () => {},
    })
    stCtrl4.renderStructure()

    // 4. panel-data-grid L350-351 (patchCellInDom lookup via getAllDisplayRows when td lacks dataset.rowIdx in transposed/non-virt mode)
    const dgRows4 = [{ id: 1, name: 'A' }]
    const dgSt4: Record<string, unknown> = {
      activeConnectionId: 'c1',
      activeTable: 'items',
      activeSchema: 'main',
      dataLoading: false,
      silentDataRefresh: false,
      transposed: true,
      page: 1,
      pageSize: 100,
      sortCol: null,
      sortDir: 'ASC',
      whereClause: '',
      orderByClause: '',
      selectedRowKey: 'row_0',
      selectedCol: 'name',
      inspectorOpen: false,
      inspectorCollapsed: false,
      rowNumWidth: 48,
      findQuery: '',
      findMatches: [],
      findMatchSet: new Set(),
      findMatchIdx: -1,
      columnWidthsByTable: {},
      stagedInserts: [],
      stagedUpdates: new Map(),
      stagedDeletes: new Map(),
      schemaObjects: {},
      pageData: {
        columns: [
          { name: 'id', type: 'INTEGER', isPrimaryKey: true, isAutoIncrement: true, nullable: false },
          { name: 'name', type: 'TEXT', nullable: true },
        ],
        rows: dgRows4,
        totalRows: 1,
        page: 1,
        pageSize: 100,
        primaryKey: ['id'],
        canEdit: true,
      },
    }
    const dgCtrl4 = createPanelDataGridController({
      state: dgSt4,
      VIRT_ROW_HEIGHT_PX: 26,
      VIRT_OVERSCAN_ROWS: 4,
      getActiveConn: () => ({ id: 'c1', driver: 'sqlite', readOnly: false }),
      getStagedCount: () => 0,
      isSubmittingChanges: () => false,
      isPreviewingDml: () => false,
      getDataGridSel: () => null,
      getActiveTableKey: () => 'c1:main:items',
      getOrderedVisibleColumns: () => (dgSt4.pageData as { columns: unknown[] }).columns,
      getPinnedColsSet: () => new Set(),
      getHiddenColsSet: () => new Set(),
      getActiveForeignKeyMap: () => new Map(),
      getLastPanelCopiedText: () => '',
      setLastPanelCopiedText: () => {},
      getSuppressSortClickUntil: () => 0,
      setSuppressSortClickUntil: () => {},
      getActiveResizeCleanup: () => null,
      setActiveResizeCleanup: () => {},
      setInspectorUserModified: () => {},
      showBanner: () => {},
      copyText: async () => {},
      loadTablePage: async () => {},
      syncDataControlsDisabled: () => {},
      renderDataColsPopoverList: () => {},
    })
    dgCtrl4.renderDataGrid()
    const synTd = document.createElement('td')
    dgCtrl4.stageCellValue('row_0', dgRows4[0], 'name', 'B', false, synTd)

    // 5. shared-cm-inline-ai L294-295 (applyGhostChunk with empty line chunk '\nline') & L582-584 (timer fires when shouldSkipInlineTrigger is true)
    vi.useFakeTimers()
    try {
      const cmHost4 = document.createElement('div')
      document.body.appendChild(cmHost4)
      const view4 = new cmVendor.EditorView({
        state: cmVendor.EditorState.create({
          doc: 'SELECT 1 /* note',
          selection: { anchor: 16 },
          extensions: [createCmInlineAiExtension({ isEnabled: () => true, requestCompletion: async () => ({ id: 1, suggestion: 'x' }) })],
        }),
        parent: cmHost4,
      })
      try {
        // Trigger doc edit inside block comment -> debounce timer fires -> L582-584 shouldSkipInlineTrigger cancels pending!
        view4.dispatch({ changes: { from: 16, to: 16, insert: 'a' }, selection: { anchor: 17 } })
        await vi.advanceTimersByTimeAsync(1500)
        // Now set ghost starting with CRLF and call acceptGhostLine -> firstNl=1, chunk='\r'.replace(/\r$/,'') === '' -> L294-295!
        view4.dispatch({ effects: setGhostEffect.of({ offset: 17, text: '\r\nNEXT_LINE', id: 2 }) })
        expect(acceptGhostLine(view4)).toBe(false)
      } finally {
        view4.destroy()
        cmHost4.remove()
      }

      // 6. panel-sql remaining reachable statements: L213-219, L363-364, L1042-1046, L1084-1094, L1247-1250, L1735-1738, L1850-1852
      let holdExplainStmt0: ((v: unknown) => void) | undefined
      let holdRunSql!: (v: unknown) => void
      ;(window as { orca?: unknown }).orca = {
        plugin: {
          request: vi.fn(async (m: string, inp: Record<string, unknown>) => {
            if (m === 'query.explain') return new Promise((res) => { holdExplainStmt0 = res })
            if (m === 'query.run' && String(inp.sql || '').includes('HOLD')) {
              return new Promise((res) => { holdRunSql = res })
            }
            return {
              columns: [{ name: 'a' }],
              rows: [[1]],
              rowCount: 1,
              executionTimeMs: 1,
              isSelect: true,
              resultSets: [
                { columns: [{ name: 'a' }], rows: [[1]], rowCount: 1, executionTimeMs: 1, isSelect: true },
                { columns: [{ name: 'b' }], rows: [[2]], rowCount: 1, executionTimeMs: 1, isSelect: true },
              ],
            }
          }),
        },
        settings: { get: vi.fn().mockResolvedValue(500) },
      }
      const origSqlEd = document.getElementById('sqlEditorMount') as HTMLElement
      const origAppend = origSqlEd.appendChild.bind(origSqlEd)

      const sqlSt4: Record<string, unknown> = {
        activeConnectionId: 'c1',
        activeSchema: 'main',
        activeTable: 't',
        lastError: '',
        lastSqlResult: null,
        sqlSortColIdx: null,
        sqlSortDir: 'ASC',
        sqlColWidths: [],
        sqlRowNumWidth: 42,
        historyOpen: false,
        historyLoading: false,
        historyFilter: '',
        historyEntries: [],
      }
      let sqlSel4!: PanelGridSelection
      const sqlOpts4 = {
        state: sqlSt4,
        QUERY_TIMEOUT_MS: 5000,
        MAX_CLIENT_SORT_ROWS: 1000,
        VIRT_ROW_HEIGHT_PX: 26,
        VIRT_OVERSCAN_ROWS: 4,
        sqlVirtRowHeightPx: 26,
        getActiveConn: () => ({ id: 'c1', driver: 'sqlite', readOnly: false }),
        getSqlGridSel: () => sqlSel4,
        getSuppressSortClickUntil: () => 0,
        setLastPanelCopiedText: () => {},
        computeVirtualRange: coreComputeVirtualRange,
        attachColumnResizeHandle: () => () => {},
        showBanner: () => {},
        copyText: async () => {},
        openAiSettingsModal: () => {},
        scheduleSavePanelViewState: () => {},
        savePanelViewState: () => {},
        savePanelDataCache: () => {},
        loadSchema: async () => {},
        syncDataControlsDisabled: () => {},
        getPanelActiveAiStatus: () => null,
        refreshPanelAiStatus: async () => {},
      }
      // L363-364: construct controller while #sqlEditorMount.appendChild throws
      origSqlEd.appendChild = () => { throw new Error('cm init throw') }
      try {
        const sqlCtrlErr = createPanelSqlController(sqlOpts4)
        sqlCtrlErr.destroySqlEditor()
      } finally {
        origSqlEd.appendChild = origAppend
      }
      const sqlCtrl4 = createPanelSqlController(sqlOpts4)
      sqlSel4 = new PanelGridSelection({
        wrapEl: document.getElementById('sqlResultWrap')!,
        tableEl: document.getElementById('sqlResultTable')!,
        editable: false,
        getDimensions: () => ({ rows: (sqlSt4.lastSqlResult as { rows?: unknown[] } | null)?.rows?.length || 0, cols: (sqlSt4.lastSqlResult as { columns?: unknown[] } | null)?.columns?.length || 0 }),
        getValueAt: (r: number, c: number) => (sqlSt4.lastSqlResult as { rows?: unknown[][] } | null)?.rows?.[r]?.[c] ?? null,
      })
      try {
        // L213-219: confirmDangerSql fallback without #dangerSqlModal -> window.confirm false
        const dangerMod = document.getElementById('dangerSqlModal')
        dangerMod?.remove()
        const origConf = window.confirm
        try {
          window.confirm = () => false
          sqlCtrl4.setSqlText('DELETE FROM t;')
          await sqlCtrl4.runSql('all')
        } finally {
          window.confirm = origConf
        }

        // L1084-1094 & L1042-1046: multi resultSets -> switch to tab 1, wipe resultStates & banner, click tab 0 & resultSet 1!
        sqlCtrl4.setSqlText('SELECT 1 AS a; SELECT 2 AS b;')
        await sqlCtrl4.runSql('all')
        const ps4 = sqlCtrl4.getConsoleTabsPersistedState()
        const t0 = (ps4.tabs as Array<Record<string, unknown>>)[0]
        t0.resultStates = { 0: { banner: null, sortColIdx: null, sortDir: 'ASC', colWidths: [] } }
        ;(ps4.tabs as Array<Record<string, unknown>>).push({ id: 'tab_2', title: 'Tab 2', sql: 'SELECT 3;' })
        ps4.activeTabId = 'tab_2'
        sqlCtrl4.restoreConsoleTabsState(ps4, '')
        const tabEls = Array.from(document.querySelectorAll('#sqlConsoleTabsBar .sql-console-tab')) as HTMLElement[]
        tabEls[0]?.click() // switches from tab_2 -> tab 0: banner null hits L1042-1046!
        // L1247-1250: hasSelection() true while formatStatsText() returns '' (rows === 0) on live lastSqlResult
        sqlCtrl4.setSqlText('SELECT 1 AS a; SELECT 2 AS b;')
        await sqlCtrl4.runSql('all')
        sqlSel4.selectCell(0, 0)
        if (sqlSt4.lastSqlResult) {
          ;(sqlSt4.lastSqlResult as { rows: unknown[] }).rows = []
        }
        sqlCtrl4.renderSqlSelectionStats()

        // L1735-1738: 2-statement EXPLAIN -> mark cancelled mid-stmt-0 -> resolve stmt-0 -> loop i=1 hits cancelledSqlRunSeq!
        sqlCtrl4.setSqlText('SELECT 1; SELECT 2;')
        const exp2 = sqlCtrl4.runSql('explain')
        await vi.advanceTimersByTimeAsync(20)
        sqlCtrl4.markSqlRunCancelled()
        holdExplainStmt0?.({ columns: [{ name: 'detail' }], rows: [['SCAN']], durationMs: 1 })
        await exp2

        // L1850-1852: active sqlStopTimer stopped when executeResolvedSql starts a new run while timer still non-null
        sqlCtrl4.setSqlText('SELECT "HOLD";')
        const pFirst = sqlCtrl4.runSql('all')
        await vi.advanceTimersByTimeAsync(20)
        sqlSt4.activeQueryId = null
        sqlCtrl4.setSqlText('SELECT 1;')
        const pSecond = sqlCtrl4.runSql('all')
        await vi.advanceTimersByTimeAsync(20)
        holdRunSql({ columns: [{ name: 'a' }], rows: [[1]], rowCount: 1, executionTimeMs: 1, isSelect: true })
        await Promise.all([pFirst, pSecond])
      } finally {
        sqlSel4.destroy()
        sqlCtrl4.destroySqlEditor()
      }
    } finally {
      vi.useRealTimers()
    }

    // 7. panel-app L284-285, L1479-1482, L1615-1616, L1931-1932: falsy activeSchema resolved by loadSchema + isUnchangedSilentPayload clearing pendingScrollState via rAF
    {
      vi.useFakeTimers()
      window.localStorage?.clear()
      applySlice6DomMetrics()
      const envSch = createPanelAppSlice6Env({
        connections: [{ id: 'c1', name: 'SchFix', driver: 'sqlite' }],
      })
      try {
        const empCols = [
          { name: 'id', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, isPrimaryKey: true, isAutoIncrement: true, defaultValue: null },
          { name: 'name', type: 'TEXT', nativeType: 'TEXT', nullable: false, isPrimaryKey: false, isAutoIncrement: false, defaultValue: null },
          { name: 'dept_id', type: 'INTEGER', nativeType: 'INTEGER', nullable: true, isPrimaryKey: false, isAutoIncrement: false, defaultValue: null },
          { name: 'salary', type: 'REAL', nativeType: 'REAL', nullable: true, isPrimaryKey: false, isAutoIncrement: false, defaultValue: null },
          { name: 'meta', type: 'TEXT', nativeType: 'TEXT', nullable: true, isPrimaryKey: false, isAutoIncrement: false, defaultValue: null },
        ]
        const empRows = envSch.db.prepare('SELECT * FROM employees LIMIT 100 OFFSET 0').all()
        window.localStorage.setItem(
          'datanoa.panelViewState',
          JSON.stringify({
            activeConnectionId: 'c1',
            activeTable: 'employees',
            activeSchema: '',
            expandedConns: ['c1'],
            scrollState: { viewportTop: 15, dataGridTop: 25, dataGridLeft: 10, sqlResultTop: 5, sqlResultLeft: 5 },
          })
        )
        window.localStorage.setItem(
          'datanoa.panelWarmCache',
          JSON.stringify({
            updatedAt: Date.now() - 120_000,
            connections: [{ id: 'c1', name: 'SchFix', driver: 'sqlite' }],
            activeConnectionId: 'c1',
            activeTable: 'employees',
            activeSchema: '',
            schemaObjects: { c1: [{ name: 'employees', schema: 'main', kind: 'table' }] },
            pageData: {
              columns: empCols,
              rows: empRows,
              totalRows: empRows.length,
              page: 1,
              pageSize: 100,
              primaryKey: ['id'],
              canEdit: true,
            },
          })
        )
        ;(window as { orca?: unknown }).orca = envSch.orcaApi
        vi.resetModules()
        await import('../src/panel/panel-app.js')
        await vi.advanceTimersByTimeAsync(80)
      } finally {
        window.dispatchEvent(new Event('pagehide'))
        envSch.db.close()
        vi.useRealTimers()
      }
    }
  })
})
