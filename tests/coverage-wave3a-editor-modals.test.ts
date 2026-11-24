import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openStudioBindParamsModal } from '../src/editor/bind-params-modal'
import { openStudioDangerSqlModal } from '../src/editor/danger-sql-modal'
import {
  bindStudioSelectTooltipsInRoot,
  BYOD_ENGINES,
  closeActiveStudioCollapsibleDropdown,
  copyTextFallback,
  createByodDriverLogoSvg,
  createDbLogoSvg,
  createFolderIconSvg,
  createWorkspaceIconSvg,
  downloadTextFile,
  enhanceStudioCollapsibleSelect,
  extractPredicateColumnName,
  extractQueriedTableName,
  formatAggregateNumber,
  formatRelativeTimestamp,
  fuzzyMatchScore,
  getStudioEngineMeta,
  groupConnectionsForSelector,
  isByodConnectionDriver,
  isEditableShortcutTarget,
  isKnownConnectionDriver,
  isStudioCollapsibleDropdownOpen,
  parseClientQuickFilterPredicate,
  setButtonLoading,
  STUDIO_ENGINES,
  syncStudioSelectTooltip,
} from '../src/editor/db-icons'
import { buildStudioDiagnosticSummary, openStudioFeedbackModal } from '../src/editor/feedback-modal'
import { openStudioFilePickerModal } from '../src/editor/file-picker-modal'
import {
  clampFixedPopup,
  createColFilterSvg,
  createColSelectSvg,
  createFkJumpSvg,
  createPinSvg,
  createSortArrowSvg,
  createSvgEl,
  findClosestFkBadge,
  findClosestTableCell,
  isEditableInputTarget,
} from '../src/editor/grid-icons'
import {
  executeStudioExportAction,
  exportStudioFormat,
  getExportFileMeta,
  populateExportDropdownOptions,
} from '../src/editor/studio-export'
import type { VirtualDataGrid } from '../src/editor/grid'
import { installDomHarness, type DomHarness } from './helpers/dom-harness'

describe('Wave 3A Step 4A: Studio Modals, Export & Icon Helpers (7 Modules)', () => {
  let dom: DomHarness

  beforeEach(() => {
    dom = installDomHarness()
  })

  afterEach(() => {
    vi.useRealTimers()
    dom.teardown()
  })

  it('covers src/editor/file-picker-modal.ts & src/editor/danger-sql-modal.ts', async () => {
    // 1. file-picker-modal
    let mountedFp: HTMLElement | null = null
    const origAppend = dom.body.appendChild.bind(dom.body)
    const appendSpy = vi.spyOn(dom.body, 'appendChild').mockImplementation((n) => {
      mountedFp = n as unknown as HTMLElement
      return origAppend(n)
    })

    const requestPlugin = vi.fn(async () => ({
      ok: true,
      currentDir: '/db',
      parentDir: '/',
      roots: ['/db'],
      entries: [{ name: 'app.db', path: '/db/app.db', kind: 'file', size: 128 }],
    }))
    const pickP = openStudioFilePickerModal(
      { mountModal: () => {}, closeModal: () => {}, requestPlugin },
      { title: 'Pick DB', mode: 'file', initialDir: '/db', extensions: ['.db'] }
    )
    await dom.flushMicrotasks()
    expect(requestPlugin).toHaveBeenCalledWith('fs.listDir', expect.objectContaining({ dir: '/db', mode: 'file' }))
    expect(mountedFp).not.toBeNull()
    dom.click(dom.body.querySelector('.datanoa-fp-row')!)
    dom.click(dom.body.querySelector('.datanoa-btn-primary')!)
    expect(await pickP).toEqual({ ok: true, path: '/db/app.db' })
    appendSpy.mockRestore()

    // 2. danger-sql-modal: prod connection gate vs staging/normal connection
    let mountedEl: HTMLElement | null = null
    const closeModal = vi.fn(() => { mountedEl = null })
    const onConfirmProd = vi.fn()

    openStudioDangerSqlModal({
      connectionName: 'Prod Primary',
      colorTag: 'prod',
      findings: [
        { kind: 'delete_without_where', statementIndex: 0, message: 'DELETE missing WHERE', sqlPreview: 'DELETE FROM users' },
        { kind: 'update_without_where', statementIndex: 1, message: 'UPDATE missing WHERE', sqlPreview: 'UPDATE users SET a=1' },
        { kind: 'drop', statementIndex: 2, message: 'DROP TABLE', sqlPreview: 'DROP TABLE logs' },
        { kind: 'truncate', statementIndex: 3, message: 'TRUNCATE TABLE', sqlPreview: 'TRUNCATE TABLE tmp' },
      ],
      sql: 'DELETE FROM users; DROP TABLE logs;',
      mountModal: (el) => { mountedEl = el; dom.body.appendChild(el) },
      closeModal,
      onConfirm: onConfirmProd,
    })

    const execBtn = mountedEl!.querySelector('.datanoa-danger-execute-btn') as HTMLButtonElement
    expect(execBtn.disabled).toBe(true)
    const chk = mountedEl!.querySelector('.datanoa-danger-confirm-check') as HTMLInputElement
    const confInp = mountedEl!.querySelector('.datanoa-danger-confirm-input') as HTMLInputElement
    dom.setInput(chk, true)
    expect(execBtn.disabled).toBe(true)
    dom.setInput(confInp, 'CONFIRM')
    expect(execBtn.disabled).toBe(false)
    dom.click(execBtn)
    expect(onConfirmProd).toHaveBeenCalledTimes(1)

    // Staging -> single warning requires checkbox confirmation -> Cancel
    const onConfirmStg = vi.fn()
    openStudioDangerSqlModal({
      connectionName: 'Staging DB',
      colorTag: 'staging',
      findings: [{ kind: 'drop', statementIndex: 0, message: 'Drop', sqlPreview: 'DROP TABLE t' }],
      sql: 'DROP TABLE t;',
      mountModal: (el) => { mountedEl = el; dom.body.appendChild(el) },
      closeModal,
      onConfirm: onConfirmStg,
    })
    const stgExecBtn = mountedEl!.querySelector('.datanoa-danger-execute-btn') as HTMLButtonElement
    const stgChk = mountedEl!.querySelector('.datanoa-danger-confirm-check') as HTMLInputElement
    expect(stgExecBtn.disabled).toBe(true)
    dom.setInput(stgChk, true)
    expect(stgExecBtn.disabled).toBe(false)
    dom.click(mountedEl!.querySelector('.datanoa-danger-cancel-btn')!)
    expect(onConfirmStg).not.toHaveBeenCalled()
    expect(closeModal).toHaveBeenCalledTimes(2)
  })

  it('covers src/editor/feedback-modal.ts diagnostic builder, bug/feature toggle, copy & GitHub openExternal', () => {
    ;(dom.window as unknown as Record<string, unknown>).orca = {
      api: { major: 2, minor: 3 },
      shell: { openExternal: vi.fn(() => Promise.resolve()) },
    }
    const diag = buildStudioDiagnosticSummary({
      activeDriver: 'postgres',
      activeViewMode: 'split',
      isReadOnly: true,
      lastQueryErrorText: 'postgres://u:secret@h/db failed',
    })
    expect(diag).toContain('Orca API: v2.3')
    expect(diag).not.toContain('secret')

    let mounted: HTMLElement | null = null
    const closeModal = vi.fn(() => { mounted?.remove() })
    const updateStatus = vi.fn()

    openStudioFeedbackModal({
      activeDriver: null,
      activeViewMode: 'sql',
      isReadOnly: false,
      lastQueryErrorText: '',
      mountModal: (el) => { mounted = el; dom.body.appendChild(el) },
      closeModal,
      updateStatus,
    })

    // Toggle feature vs bug & test Copy + Open GitHub Issues + Close
    const featureBtn = mounted!.querySelector('button[data-kind="feature"]')!
    const bugBtn = mounted!.querySelector('button[data-kind="bug"]')!
    dom.click(featureBtn)
    dom.click(mounted!.querySelector('.datanoa-feedback-copy-btn')!)
    expect(updateStatus).toHaveBeenCalledWith(expect.stringContaining('Copied feedback report'))
    expect(dom.clipboardWrites[0]).toContain('[Feature] Studio feature request')

    dom.click(bugBtn)
    dom.click(mounted!.querySelector('.datanoa-feedback-copy-btn')!) // default empty bug title & details
    expect(dom.clipboardWrites[1]).toContain('[Bug] Fullscreen Studio issue report')
    dom.setInput(mounted!.querySelector('#datanoa-feedback-title-input')!, '[Custom] Grid crash')
    dom.setInput(mounted!.querySelector('#datanoa-feedback-body-input')!, 'Steps 1-2')
    dom.click(mounted!.querySelector('.datanoa-feedback-github-btn')!)
    expect(
      ((dom.window as unknown as { orca: { shell: { openExternal: ReturnType<typeof vi.fn> } } }).orca.shell.openExternal)
    ).toHaveBeenCalledWith(expect.stringContaining('github.com/Thanhh2615/datanoa/issues/new'))

    // Fallback when openExternal throws synchronously + Cancel button
    ;(dom.window as unknown as { orca: { shell: { openExternal: () => void } } }).orca.shell.openExternal = () => {
      throw new Error('blocked')
    }
    dom.click(mounted!.querySelector('.datanoa-feedback-github-btn')!)
    dom.click(mounted!.querySelectorAll('.datanoa-modal-actions button')[0])
    dom.click(mounted!.querySelector('.datanoa-modal-head button')!)
    expect(closeModal).toHaveBeenCalledTimes(2)

    // Platform/API fallbacks (major-only api & blank navigator platform -> process.platform)
    ;(dom.window as unknown as Record<string, unknown>).orca = { api: { major: 3 } }
    const origNav = (globalThis as Record<string, unknown>).navigator
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { platform: '   ', clipboard: (origNav as { clipboard?: unknown })?.clipboard } })
    try {
      const fallbackDiag = buildStudioDiagnosticSummary({
        activeDriver: 'sqlite',
        activeViewMode: 'grid',
        isReadOnly: false,
      })
      expect(fallbackDiag).toContain('Orca API: v3')
      expect(fallbackDiag).toContain(`Platform: ${process.platform}`)
    } finally {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: origNav })
    }
  })

  it('covers src/editor/bind-params-modal.ts validation, null toggle, Enter submit & remembered values', async () => {
    vi.useFakeTimers()
    let mounted: HTMLElement | null = null
    const closeModal = vi.fn(() => { mounted?.remove() })
    const onConfirm = vi.fn()

    openStudioBindParamsModal({
      sql: 'SELECT * FROM users WHERE id = :id AND active = :flag AND note = :note;',
      dialect: 'postgres',
      params: [
        { key: ':id', name: 'id', style: 'colon', rawToken: ':id', firstIndex: 30, occurrences: 1 },
        { key: ':flag', name: 'flag', style: 'colon', rawToken: ':flag', firstIndex: 49, occurrences: 1 },
        { key: ':note', name: 'note', style: 'colon', rawToken: ':note', firstIndex: 69, occurrences: 2 },
      ],
      rememberedValues: {
        id: { value: '7', type: 'number' },
        ':note': { value: '', type: 'null' },
      },
      mountModal: (el) => { mounted = el; dom.body.appendChild(el) },
      closeModal,
      onConfirm,
    })

    await vi.advanceTimersByTimeAsync(60)
    const selects = mounted!.querySelectorAll('select')
    const checkboxes = mounted!.querySelectorAll('.datanoa-param-null-checkbox')
    const inputs = mounted!.querySelectorAll('input[type="text"]')
    const runBtn = mounted!.querySelector('.datanoa-btn-primary') as HTMLButtonElement
    expect(inputs[2].disabled).toBe(true) // :note remembered as null

    // Toggle :id null checkbox on & off, then enter invalid number -> disabled Run Query
    dom.click(checkboxes[0])
    expect(inputs[0].disabled).toBe(true)
    dom.click(checkboxes[0])
    expect(inputs[0].disabled).toBe(false)

    dom.setInput(inputs[0], 'not-a-number', 'input')
    expect(runBtn.disabled).toBe(true)
    expect(mounted!.querySelector('[role="alert"]')?.style.display).toBe('block')

    // Fix number, switch :note select from null -> text, enter value & press Enter
    dom.setInput(inputs[0], '42', 'input')
    selects[2].value = 'text'
    selects[2].dispatchEvent(new Event('change', { bubbles: true }))
    dom.setInput(inputs[2], 'hello', 'input')
    selects[0].value = 'null'
    selects[0].dispatchEvent(new Event('change', { bubbles: true }))
    expect(runBtn.disabled).toBe(false)

    // Non-input Enter ignored, input Enter submits once
    dom.fireKey(mounted!, 'Enter')
    expect(onConfirm).not.toHaveBeenCalled()
    dom.fireKey(inputs[2], 'Enter')
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][0]).toContain("note = 'hello'")

    // Repeat Enter/click ignored once submitted + Cancel callback check
    dom.click(mounted!.querySelector('.datanoa-modal-actions button')!)
    expect(closeModal).toHaveBeenCalledTimes(2)

    // Single param ('1 param') + Run Query button click + remembered fallback when first input is null
    let mountedSingle: HTMLElement | null = null
    const onConfirmSingle = vi.fn()
    openStudioBindParamsModal({
      sql: 'SELECT :only;',
      dialect: 'sqlite',
      params: [{ key: ':only', name: 'only', style: 'colon', rawToken: ':only', firstIndex: 7, occurrences: 1 }],
      rememberedValues: { ':only': { value: '', type: 'null' } },
      mountModal: (el) => { mountedSingle = el; dom.body.appendChild(el) },
      closeModal: () => { mountedSingle?.remove() },
      onConfirm: onConfirmSingle,
    })
    await vi.advanceTimersByTimeAsync(60)
    expect(mountedSingle!.textContent).toContain('1 param')
    dom.click(mountedSingle!.querySelector('.datanoa-btn-primary')!)
    expect(onConfirmSingle).toHaveBeenCalledWith('SELECT NULL;', { ':only': { value: '', type: 'null' } })
  })

  it('covers src/editor/studio-export.ts dropdown builder, metadata & copy/download outcomes', async () => {
    populateExportDropdownOptions(null, { isShowingSqlResult: true, currentPageRowCount: 0, totalRows: 0, lastSelectionSummary: null })
    const sel = dom.document.createElement('select') as unknown as HTMLSelectElement
    populateExportDropdownOptions(sel, {
      isShowingSqlResult: false,
      currentPageRowCount: 5,
      totalRows: 20,
      lastSelectionSummary: { rowCount: 2, colCount: 2, cellCount: 4, numericCount: 0, sum: 0, avg: 0, min: 0, max: 0 },
    })
    expect(sel.querySelectorAll('optgroup').length).toBe(3)
    populateExportDropdownOptions(sel, { isShowingSqlResult: true, currentPageRowCount: 2, totalRows: 2, lastSelectionSummary: null })
    expect(sel.querySelectorAll('optgroup').length).toBe(2)

    expect(getExportFileMeta('csv', 'my tbl!')).toEqual({ filename: 'my_tbl_.csv', mimeType: 'text/csv;charset=utf-8' })
    expect(getExportFileMeta('json', '')).toEqual({ filename: 'export.json', mimeType: 'application/json;charset=utf-8' })
    expect(getExportFileMeta('markdown', 'a')).toEqual({ filename: 'a.md', mimeType: 'text/markdown;charset=utf-8' })
    expect(getExportFileMeta('sql-insert', 'a')).toEqual({ filename: 'a.sql', mimeType: 'text/sql;charset=utf-8' })

    const updateStatus = vi.fn()
    let exportOut = 'id,name\n1,a'
    let selOut = '1\ta'
    const fakeGrid = {
      exportData: vi.fn(() => exportOut),
      exportSelection: vi.fn(() => selOut),
    } as unknown as VirtualDataGrid
    const ctx = { dataGrid: fakeGrid, driver: 'postgres' as const, tableName: 'users', updateStatus }

    exportStudioFormat({ ...ctx, dataGrid: null }, 'csv')
    exportStudioFormat(ctx, 'csv')
    expect(updateStatus).toHaveBeenCalledWith('Exported as CSV (copied to clipboard)')
    exportOut = ''
    exportStudioFormat(ctx, 'json')
    expect(updateStatus).toHaveBeenCalledWith('No rows available to export')

    // Selection actions: invalid fmt ignored, empty sel, copy, download cancelled/saved
    executeStudioExportAction(ctx, 'sel-copy:bad')
    selOut = ''
    executeStudioExportAction(ctx, 'sel-copy:tsv')
    expect(updateStatus).toHaveBeenCalledWith('No selected cells to export')
    selOut = 'ok'
    executeStudioExportAction(ctx, 'sel-copy:tsv-headers')
    expect(updateStatus).toHaveBeenCalledWith('Copied selected cells as TSV-HEADERS')

    let saveStatus: 'saved' | 'cancelled' = 'cancelled'
    ;(dom.window as unknown as Record<string, unknown>).orca = { files: { saveAs: async () => ({ status: saveStatus }) } }
    executeStudioExportAction(ctx, 'sel-download:csv')
    await dom.flushMicrotasks()
    expect(updateStatus).toHaveBeenCalledWith('Export cancelled')
    saveStatus = 'saved'
    executeStudioExportAction(ctx, 'sel-download:json')
    await dom.flushMicrotasks()
    expect(updateStatus).toHaveBeenCalledWith('Saved selected data as users_selected.json')

    // Full download empty/cancelled/saved + invalid action + copy:prefix
    executeStudioExportAction(ctx, 'invalid-action')
    executeStudioExportAction(ctx, 'download:csv') // exportOut is still ''
    expect(updateStatus).toHaveBeenCalledWith('No rows available to download')
    exportOut = 'col\nval'
    saveStatus = 'cancelled'
    executeStudioExportAction(ctx, 'download:markdown')
    await dom.flushMicrotasks()
    expect(updateStatus).toHaveBeenCalledWith('Export cancelled')
    saveStatus = 'saved'
    executeStudioExportAction(ctx, 'download:sql-insert')
    await dom.flushMicrotasks()
    expect(updateStatus).toHaveBeenCalledWith('Saved users.sql')
    executeStudioExportAction(ctx, 'copy:ndjson')
    expect(updateStatus).toHaveBeenCalledWith('Exported as NDJSON (copied to clipboard)')

    // Download failure fallback when URL.createObjectURL & saveAs are unavailable
    delete (dom.window as unknown as Record<string, unknown>).orca
    const origObjUrl = URL.createObjectURL
    ;(URL as unknown as Record<string, unknown>).createObjectURL = undefined
    try {
      executeStudioExportAction(ctx, 'sel-download:csv')
      executeStudioExportAction(ctx, 'download:csv')
      await dom.flushMicrotasks()
      expect(updateStatus).toHaveBeenCalledWith('Export failed')
    } finally {
      URL.createObjectURL = origObjUrl
    }
  })

  it('covers src/editor/grid-icons.ts & src/editor/db-icons.ts completely', async () => {
    vi.useFakeTimers()

    // grid-icons
    const inp = dom.document.createElement('input')
    const ta = dom.document.createElement('textarea')
    const sel = dom.document.createElement('select')
    const ce = dom.document.createElement('div') as HTMLElement & { isContentEditable?: boolean }
    ce.isContentEditable = true
    const plain = dom.document.createElement('div')
    expect(isEditableInputTarget(null)).toBe(false)
    expect(isEditableInputTarget(inp as unknown as EventTarget)).toBe(true)
    expect(isEditableInputTarget(ta as unknown as EventTarget)).toBe(true)
    expect(isEditableInputTarget(sel as unknown as EventTarget)).toBe(true)
    expect(isEditableInputTarget(ce as unknown as EventTarget)).toBe(true)
    expect(isEditableInputTarget(plain as unknown as EventTarget)).toBe(false)

    const td = dom.document.createElement('td')
    const spanInTd = dom.document.createElement('span')
    td.appendChild(spanInTd)
    expect(findClosestTableCell(spanInTd as unknown as EventTarget)).toBe(td)
    expect(findClosestTableCell(plain as unknown as EventTarget)).toBeNull()
    expect(findClosestTableCell(null)).toBeNull()

    const fkBtn = dom.document.createElement('button')
    fkBtn.className = 'datanoa-fk-badge'
    const fkInner = dom.document.createElement('span')
    fkBtn.appendChild(fkInner)
    expect(findClosestFkBadge(fkInner as unknown as EventTarget)).toBe(fkBtn)
    expect(findClosestFkBadge(plain as unknown as EventTarget)).toBeNull()
    expect(findClosestFkBadge(null)).toBeNull()

    expect(createSortArrowSvg('ASC').tagName).toBe('SVG')
    expect(createSortArrowSvg('DESC').tagName).toBe('SVG')
    expect(createColSelectSvg().tagName).toBe('SVG')
    expect(createPinSvg().tagName).toBe('SVG')
    expect(createFkJumpSvg().tagName).toBe('SVG')
    expect(createColFilterSvg().tagName).toBe('SVG')

    const origNS = dom.document.createElementNS
    ;(dom.document as unknown as Record<string, unknown>).createElementNS = undefined
    expect(createSvgEl('div', { id: 'x' }).getAttribute('id')).toBe('x')
    dom.document.createElementNS = origNS

    const insp = dom.document.createElement('div')
    insp.className = 'datanoa-value-inspector'
    insp._rect = { left: 0, top: 400, right: 1200, bottom: 760, width: 1200, height: 360 }
    dom.body.appendChild(insp)
    const popup = dom.document.createElement('div')
    popup._rect = { left: 0, top: 0, right: 200, bottom: 300, width: 200, height: 300 }
    clampFixedPopup(popup as unknown as HTMLElement, 1200, 500)
    expect(Number.parseFloat(popup.style.top)).toBeLessThanOrEqual(400)

    // db-icons: engines, SVGs, loading button, timers, downloadTextFile, SQL predicates, fuzzy, tooltips, collapsible select
    expect(STUDIO_ENGINES.length).toBe(12)
    expect(BYOD_ENGINES.length).toBe(7)
    expect(getStudioEngineMeta('snowflake' as never).label).toBe('Snowflake')
    expect(getStudioEngineMeta('unknown' as never).id).toBe('sqlite')
    expect(isKnownConnectionDriver('duckdb')).toBe(true)
    expect(isKnownConnectionDriver(123)).toBe(false)
    expect(isByodConnectionDriver('bigquery')).toBe(true)

    expect(createDbLogoSvg('clickhouse').querySelectorAll('rect').length).toBeGreaterThan(0)
    expect(createDbLogoSvg('duckdb' as never).className).toContain('duckdb')
    expect(createByodDriverLogoSvg('not_real').className).toContain('db-custom')
    expect(createFolderIconSvg(true, 16).className).toContain('is-open')
    expect(createFolderIconSvg(false, 16).className).not.toContain('is-open')
    expect(createWorkspaceIconSvg(16).className).toBe('datanoa-workspace-svg')

    const loadBtn = dom.document.createElement('button') as unknown as HTMLButtonElement
    loadBtn.textContent = 'Run'
    setButtonLoading(null, true)
    setButtonLoading(loadBtn, true, 'Running...')
    setButtonLoading(loadBtn, true, '1.2s')
    expect(loadBtn.disabled).toBe(true)
    setButtonLoading(loadBtn, false)
    expect(loadBtn.textContent).toBe('Run')

    expect(formatAggregateNumber(Number.NaN)).toBe('0')
    expect(formatAggregateNumber(10)).toBe('10')
    expect(formatAggregateNumber(1.25)).toBe('1.25')
    const now = Date.now()
    expect(formatRelativeTimestamp(0)).toBe('')
    expect(formatRelativeTimestamp(now - 2000)).toBe('just now')
    expect(formatRelativeTimestamp(now - 25000)).toBe('25s ago')
    expect(formatRelativeTimestamp(now - 300_000)).toBe('5m ago')
    expect(formatRelativeTimestamp(now - 7_200_000)).toBe('2h ago')
    expect(formatRelativeTimestamp(now - 172_800_000)).toBe('2d ago')

    // downloadTextFile via Blob fallback (when saveAs rejects)
    ;(dom.window as unknown as Record<string, unknown>).orca = { files: { saveAs: async () => { throw new Error('no bridge') } } }
    expect(await downloadTextFile('hello', 'f.txt', 'text/plain')).toBe('saved')
    await vi.advanceTimersByTimeAsync(1100)
    expect(dom.revokedObjectUrls.length).toBeGreaterThan(0)

    const origCreateUrl = URL.createObjectURL
    ;(URL as unknown as Record<string, unknown>).createObjectURL = undefined
    expect(await downloadTextFile('x', 'y.txt', 'text/plain')).toBe('failed')
    URL.createObjectURL = origCreateUrl

    // Predicate & SQL parsers + fuzzyMatch
    expect(extractPredicateColumnName('""')).toBeNull()
    expect(extractPredicateColumnName('[unclosed')).toBeNull()
    expect(extractPredicateColumnName('"id""x" = 5')?.column).toBe('id"x')
    expect(extractPredicateColumnName('`a` = 1')?.column).toBe('a')
    expect(extractPredicateColumnName('[col] IS NOT NULL')?.column).toBe('col')
    expect(parseClientQuickFilterPredicate('[a] IS NULL')?.op).toBe('is-null')
    expect(parseClientQuickFilterPredicate('b != true')).toEqual({ column: 'b', op: 'neq', value: true })
    expect(parseClientQuickFilterPredicate("c <> 'it''s'")).toEqual({ column: 'c', op: 'neq', value: "it's" })
    expect(parseClientQuickFilterPredicate('d = false')?.value).toBe(false)
    expect(parseClientQuickFilterPredicate('d BAD OP')).toBeNull()

    expect(fuzzyMatchScore('', 'abc')).toBe(1)
    expect(fuzzyMatchScore('abc', 'abc')).toBe(100)
    expect(fuzzyMatchScore('ab', 'abcd')).toBe(80)
    expect(fuzzyMatchScore('cd', 'abcd')).toBeLessThan(80)
    expect(fuzzyMatchScore('ac', 'abcd')).toBeGreaterThan(0)
    expect(fuzzyMatchScore('zz', 'abcd')).toBe(0)

    expect(extractQueriedTableName('DELETE FROM t;')).toBeNull()
    expect(extractQueriedTableName('SELECT FROM WHERE')).toBeNull()
    expect(extractQueriedTableName('SELECT EXTRACT(YEAR FROM ts) FROM public.events;')).toBe('events')

    const cmBox = dom.document.createElement('div')
    cmBox.className = 'cm-editor'
    const cmChild = dom.document.createElement('div')
    cmBox.appendChild(cmChild)
    expect(isEditableShortcutTarget(cmChild as unknown as EventTarget)).toBe(true)

    // copyTextFallback w/ button reset timer
    const copyBtnEl = dom.document.createElement('button') as unknown as HTMLButtonElement
    copyBtnEl.textContent = 'Copy'
    copyTextFallback('abc', copyBtnEl)
    copyTextFallback('def', copyBtnEl)
    await vi.advanceTimersByTimeAsync(1300)
    expect(copyBtnEl.textContent).toBe('Copy')

    // Select tooltips + grouping + Studio collapsible select wrapper
    bindStudioSelectTooltipsInRoot({} as unknown as ParentNode).dispose()
    const rootSelWrap = dom.document.createElement('div')
    const selTip = dom.document.createElement('select') as unknown as HTMLSelectElement
    selTip.setAttribute('aria-label', 'Target DB')
    selTip.innerHTML = `
      <optgroup label="Prod"><option value="c1" data-folder="Prod" data-driver="postgres" data-full-title="Prod PG" selected>PG</option></optgroup>
      <option value="ws" data-driver="sqlite">Local</option>
    `
    const selTipNoAria = dom.document.createElement('select') as unknown as HTMLSelectElement
    selTipNoAria.dataset.tooltipPrefix = 'Workspace'
    selTipNoAria.innerHTML = `<option value="ws1" selected>Main Workspace</option><option value="ws2">Other</option>`
    rootSelWrap.appendChild(selTip as unknown as Node)
    rootSelWrap.appendChild(selTipNoAria as unknown as Node)
    dom.body.appendChild(rootSelWrap)
    const tipBind = bindStudioSelectTooltipsInRoot(rootSelWrap as unknown as ParentNode)
    selTip.dispatchEvent(new Event('change', { bubbles: true }))
    selTipNoAria.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
    syncStudioSelectTooltip(selTipNoAria)
    tipBind.dispose()
    syncStudioSelectTooltip(null)

    expect(groupConnectionsForSelector([{ id: '1' }], '')).toEqual({ grouped: false, groups: [] })
    const grpRes = groupConnectionsForSelector(
      [
        { folder: 'B_Folder' },
        { folder: 'A_Folder' },
        { workspaceScope: '/ws/one' },
        { workspaceScope: '/ws/two' },
        {},
      ],
      '/ws/one'
    )
    expect(grpRes.grouped).toBe(true)
    expect(grpRes.groups.map((g) => g.label)).toEqual([
      'Current Workspace',
      'A_Folder',
      'B_Folder',
      'Other Workspaces',
      'General (Ungrouped)',
    ])

    enhanceStudioCollapsibleSelect(selTip, { leadingIconType: 'db' })
    enhanceStudioCollapsibleSelect(selTipNoAria, { leadingIconType: 'workspace' })
    const trig = dom.body.querySelector('.datanoa-custom-select-trigger')!
    dom.click(trig)
    expect(isStudioCollapsibleDropdownOpen()).toBe(true)
    closeActiveStudioCollapsibleDropdown()
    expect(isStudioCollapsibleDropdownOpen()).toBe(false)
  })
})
