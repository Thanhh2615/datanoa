import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView, keymap } from '../vendor/codemirror.js'
import {
  formatAiStatusBadge,
  openSharedAiConfigModal,
  renderSharedExplainAiPanel,
  resolveAiPresetId,
  saveOrcaSettingsPatch,
} from '../src/shared-ai-ui.js'
import {
  Pacer,
  acceptGhostFull,
  acceptGhostLine,
  acceptGhostWord,
  clearGhostEffect,
  createCmInlineAiExtension,
  ghostStateField,
  setGhostEffect,
  trackAcceptance,
} from '../src/shared-cm-inline-ai.js'
import { createCollapsibleSelectController } from '../src/shared-collapsible-select.js'
import {
  compactPickerRootLabel,
  formatPickerBytes,
  openSharedFilePickerModal,
} from '../src/shared-file-picker.js'
import { installDomHarness, type DomHarness } from './helpers/dom-harness'

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

function makeSelectAdapter() {
  return {
    classes: {
      srOnly: 'cs-sr',
      trigger: 'cs-trigger',
      leadIcon: 'cs-lead',
      label: 'cs-label',
      chev: 'cs-chev',
      popover: 'cs-popover',
      head: 'cs-head',
      search: 'cs-search',
      actionBtn: 'cs-act',
      list: 'cs-list',
      folderHead: 'cs-folder',
      folderIcon: 'cs-ficon',
      folderName: 'cs-fname',
      folderCount: 'cs-fcnt',
      item: 'cs-opt',
      itemIcon: 'cs-iicon',
      itemText: 'cs-itext',
      itemLabel: 'cs-olabel',
      itemSub: 'cs-ometa',
      itemCheck: 'cs-ocheck',
      empty: 'cs-empty',
    },
    apiProp: '__csApi',
    mountedProp: '__csMounted',
    syncProp: '__csSync',
    expandTitle: 'Expand all',
    collapseTitle: 'Collapse all',
    setActionAriaLabel: true,
    fallbackQuerySelected: true,
    closeOnRefresh: false,
    setLeadIconVisible: (el: HTMLElement, visible: boolean) => { el.hidden = !visible },
    renderTriggerChevron: (el: HTMLElement) => { el.textContent = 'v' },
    syncLeadIcon: (el: HTMLElement, _type: string, opt: HTMLElement | null) => { el.textContent = opt ? '*' : '' },
    renderItemIcon: (el: HTMLElement, drv?: string) => { el.textContent = drv || 'D' },
    applyFolderChevron: (el: HTMLElement, collapsed: boolean) => { el.textContent = collapsed ? '>' : 'v' },
    renderExpandIcon: (b: HTMLElement) => { b.textContent = '+' },
    renderCollapseIcon: (b: HTMLElement) => { b.textContent = '-' },
    renderFolderIcon: (b: HTMLElement) => { b.textContent = 'F' },
    layout: {
      rectFallback: { left: 10, top: 20, right: 210, bottom: 52, width: 200, height: 32 },
      vwFallback: 1200,
      vhFallback: 800,
      minWidth: 220,
      maxHeight: 320,
      margin: 8,
      gap: 6,
    },
  }
}

describe('Wave 3A Step 3: 4 Shared UI Modules (file-picker, collapsible-select, shared-ai-ui, shared-cm-inline-ai)', () => {
  let dom: DomHarness

  beforeEach(() => {
    dom = installDomHarness()
  })

  afterEach(() => {
    vi.useRealTimers()
    dom.teardown()
  })

  it('covers src/shared-file-picker.js helpers, directory browsing, filter, keyboard nav, focus trap, and error states', async () => {
    expect(formatPickerBytes(-1)).toBe('')
    expect(formatPickerBytes('x' as unknown as number)).toBe('')
    expect(formatPickerBytes(512)).toBe('512 B')
    expect(formatPickerBytes(2048)).toBe('2.0 KB')
    expect(formatPickerBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatPickerBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')

    expect(compactPickerRootLabel('')).toBe('')
    expect(compactPickerRootLabel('C:\\')).toBe('C:\\')
    expect(compactPickerRootLabel('/var/lib/data/')).toBe('data')

    const opener = dom.document.createElement('button')
    dom.body.appendChild(opener)
    opener.focus()

    let modeReq = 0
    const listDir = vi.fn(async (req: { dir?: string; strictDir?: boolean }) => {
      modeReq++
      if (req.dir === '/broken-err') {
        return { ok: false, error: 'Access denied', currentDir: '/home', parentDir: '/', roots: ['C:\\', '/home'] }
      }
      if (req.dir === '/throw-err') {
        throw new Error('RPC timeout')
      }
      if (req.dir === '/sub') {
        return {
          ok: true,
          currentDir: '/sub',
          parentDir: '/home',
          roots: ['C:\\', '/home', '/sub'],
          entries: [
            { name: 'db.sqlite', path: '/sub/db.sqlite', kind: 'file', size: 1024 },
          ],
          truncated: true,
        }
      }
      return {
        ok: true,
        currentDir: '/home',
        parentDir: '/',
        roots: ['C:\\', '/home'],
        entries: [
          { name: 'projects', path: '/sub', kind: 'dir' },
          { name: 'notes.sql', path: '/home/notes.sql', kind: 'file', size: 42 },
        ],
      }
    })

    // 1. File mode: navigate, filter (match/empty), keyboard ArrowDown/Up/Tab/Enter, dblclick file
    const fileP = openSharedFilePickerModal({
      mode: 'file',
      title: 'Open DB',
      initialDir: '/home',
      extensions: ['.sqlite', '.sql'],
      maxRoots: 5,
      classes: PICKER_CLASSES,
      listDir,
    })
    await dom.flushMicrotasks()
    expect(dom.body.querySelector('.fp-status')?.textContent).toBe('2 items')

    // Filter down to empty then restore
    const filterInp = dom.body.querySelector('.fp-filter')!
    dom.setInput(filterInp, 'zzz')
    expect(dom.body.querySelector('.fp-empty')?.textContent).toBe('No matching entries')
    dom.setInput(filterInp, '')

    // ArrowUp (wraps to last), ArrowDown, Enter on dir -> loads /sub, truncated banner
    filterInp.focus()
    dom.fireKey(filterInp, 'ArrowUp')
    dom.fireKey(filterInp, 'ArrowDown') // stays clamped on last or selects index 0
    dom.fireKey(filterInp, 'ArrowUp') // index 0 ('projects' dir)
    dom.fireKey(filterInp, 'Enter')
    await dom.flushMicrotasks()
    expect(dom.body.querySelector('.fp-status')?.textContent).toContain('1+ items')

    // Go Up -> /home, then type invalid path -> error, thrown path -> error
    dom.click(dom.body.querySelector('.fp-up')!)
    await dom.flushMicrotasks()
    const pathInp = dom.body.querySelector('.fp-path')!
    dom.setInput(pathInp, '/broken-err')
    dom.fireKey(pathInp, 'Enter')
    await dom.flushMicrotasks()
    expect(dom.body.querySelector('.fp-status')?.className).toContain('is-error')

    dom.setInput(pathInp, '/throw-err')
    dom.click(dom.body.querySelectorAll('.fp-btn-sm')[1]) // Go button
    await dom.flushMicrotasks()
    expect(dom.body.querySelector('.fp-status')?.textContent).toBe('RPC timeout')

    // Root button + Tab / Shift+Tab wrap + single click + Confirm button
    const rootBtns = dom.body.querySelectorAll('.fp-root')
    dom.click(rootBtns[1])
    await dom.flushMicrotasks()
    dom.fireKey(dom.body.querySelector('.fp-modal')!, 'Tab', { shiftKey: true })
    dom.fireKey(dom.body.querySelector('.fp-modal')!, 'Tab', { shiftKey: false })
    const rows = dom.body.querySelectorAll('.fp-row')
    dom.click(rows[1]) // notes.sql
    dom.click(dom.body.querySelector('.fp-primary')!)
    expect(await fileP).toEqual({ ok: true, path: '/home/notes.sql' })
    expect(dom.document.activeElement).toBe(opener)

    // 2. Folder mode + empty directory + dblclick + Escape / Overlay backdrop / Close cancel
    const folderP = openSharedFilePickerModal({
      mode: 'folder',
      classes: PICKER_CLASSES,
      listDir: async (r) => {
        if (r.strictDir) return { ok: false, currentDir: '/first-ok', roots: ['/first-ok'] }
        return { ok: true, currentDir: '/empty-dir', parentDir: null, roots: ['/empty-dir'], entries: [] }
      },
    })
    await dom.flushMicrotasks()
    expect(dom.body.querySelector('.fp-empty')?.textContent).toBe('No subfolders in this directory')
    dom.fireKey(dom.body.querySelector('.fp-overlay')!, 'Escape')
    expect(await folderP).toEqual({ ok: false, cancelled: true })

    // Backdrop overlay click & dblclick file
    const dblP = openSharedFilePickerModal({
      mode: 'file',
      classes: PICKER_CLASSES,
      listDir: async () => ({
        ok: true,
        currentDir: '/home',
        roots: [],
        entries: [{ name: 'a.db', path: '/home/a.db', kind: 'file', size: 10 }],
      }),
    })
    await dom.flushMicrotasks()
    dom.body.querySelector('.fp-row')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(await dblP).toEqual({ ok: true, path: '/home/a.db' })

    const backdropP = openSharedFilePickerModal({
      mode: 'file',
      classes: PICKER_CLASSES,
      listDir: async () => ({ ok: false, error: 'Nope' }),
    })
    await dom.flushMicrotasks()
    const ov = dom.body.querySelector('.fp-overlay')!
    ov.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(await backdropP).toEqual({ ok: false, cancelled: true })
    expect(modeReq).toBeGreaterThan(2)
  })

  it('covers src/shared-collapsible-select.js popover open/close, search, folders, positioning, scroll/outside close & refresh', async () => {
    const adapter = makeSelectAdapter()
    const ctrl = createCollapsibleSelectController(adapter)
    expect(ctrl.isOpen()).toBe(false)
    expect(ctrl.enhance(null as unknown as HTMLSelectElement)).toBeNull()

    const wrap = dom.document.createElement('div')
    const select = dom.document.createElement('select')
    select.innerHTML = `
      <optgroup label="Prod">
        <option value="pg1" data-folder="Prod" selected>Postgres Main</option>
        <option value="pg2" data-folder="Prod">Postgres Replica</option>
      </optgroup>
      <optgroup label="Staging">
        <option value="my1" data-folder="Staging">MySQL Stage</option>
      </optgroup>
    `
    wrap.appendChild(select)
    dom.body.appendChild(wrap)

    const onFolderToggle = vi.fn()
    const onOpen = vi.fn()
    const api = ctrl.enhance(select, {
      defaultCollapseNonActiveFolders: true,
      onFolderToggle,
      onOpen,
      searchPlaceholder: 'Filter DBs',
    })!
    expect(api).not.toBeNull()

    // Calling enhance again reuses apiProp and calls refresh()
    expect(ctrl.enhance(select, { searchPlaceholder: 'Find...' })).toBe(api)

    // Position near bottom so upward placement triggers (spaceBelow < 180 && spaceAbove > spaceBelow)
    ;(api.triggerBtn as unknown as { _rect: Record<string, number> })._rect = {
      left: 20,
      top: 720,
      right: 220,
      bottom: 750,
      width: 200,
      height: 30,
    }
    dom.click(api.triggerBtn)
    expect(ctrl.isOpen()).toBe(true)
    expect(onOpen).toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 25))

    const pop = dom.body.querySelector('.cs-popover')!
    expect(pop.style.bottom).not.toBe('auto')

    // Expand all / Collapse all / Individual folder toggle
    const actionBtns = pop.querySelectorAll('.cs-act')
    dom.click(actionBtns[0]) // expand all
    dom.click(actionBtns[1]) // collapse all
    expect(onFolderToggle).toHaveBeenCalled()
    dom.click(pop.querySelector('.cs-folder')!) // uncollapse Prod

    // Search filter match & no-match empty message
    const search = pop.querySelector('.cs-search')!
    dom.setInput(search, 'Replica')
    expect(pop.querySelectorAll('.cs-opt').length).toBe(1)
    dom.setInput(search, 'does-not-exist')
    expect(pop.querySelector('.cs-empty')?.textContent).toContain('No matches for')
    dom.setInput(search, '')

    // Clicking option selects value, dispatches change, and closes popover
    const opts = pop.querySelectorAll('.cs-opt')
    let changed = false
    select.addEventListener('change', () => { changed = true })
    dom.click(opts[1])
    expect(changed).toBe(true)
    expect(select.value).toBe('pg2')
    expect(ctrl.isOpen()).toBe(false)

    // Re-open -> Escape key closes & refocuses trigger
    ;(api.triggerBtn as unknown as { _rect: Record<string, number> })._rect = {
      left: 20,
      top: 40,
      right: 220,
      bottom: 70,
      width: 200,
      height: 30,
    }
    dom.click(api.triggerBtn)
    expect(ctrl.isOpen()).toBe(true)
    dom.fireKey(dom.body.querySelector('.cs-search')!, 'Escape')
    expect(ctrl.isOpen()).toBe(false)

    // Scroll inside popover ignored, scroll outside closes popover
    dom.click(api.triggerBtn)
    const pop2 = dom.body.querySelector('.cs-popover')!
    pop2.dispatchEvent(new Event('scroll', { bubbles: false }))
    expect(ctrl.isOpen()).toBe(true)
    dom.body.dispatchEvent(new Event('scroll', { bubbles: true }))
    expect(ctrl.isOpen()).toBe(false)

    // Document outside click closes popover; closeOnRefresh true closes on refresh
    dom.click(api.triggerBtn)
    expect(ctrl.isOpen()).toBe(true)
    api.refresh({})
    expect(ctrl.isOpen()).toBe(true)
    dom.click(dom.body)
    expect(ctrl.isOpen()).toBe(false)

    // closeOnRefresh branch + mountedProp branch without apiProp
    adapter.closeOnRefresh = true
    dom.click(api.triggerBtn)
    expect(ctrl.isOpen()).toBe(true)
    api.refresh({})
    expect(ctrl.isOpen()).toBe(false)

    const adapter2 = { ...makeSelectAdapter(), apiProp: undefined }
    const ctrl2 = createCollapsibleSelectController(adapter2)
    const s2 = dom.document.createElement('select')
    s2.innerHTML = '<option value="1">One</option>'
    wrap.appendChild(s2)
    expect(ctrl2.enhance(s2)).not.toBeNull()
    expect(ctrl2.enhance(s2)).toBeNull() // second call uses mountedProp sync
    ctrl.closeActive()
  })

  it('covers src/shared-ai-ui.js explain panel, presets, status badges, AI config modal flows & saveOrcaSettingsPatch', async () => {
    expect(resolveAiPresetId('ollama', 'http://localhost:11434')).toBe('ollama')
    expect(resolveAiPresetId('mistral-fim', '')).toBe('mistral')
    expect(resolveAiPresetId('anthropic', 'https://proxy.custom/v1')).toBe('custom-anthropic')
    expect(resolveAiPresetId('openai', 'https://proxy.custom/v1')).toBe('custom-openai')

    expect(formatAiStatusBadge(null).label).toBe('AI · Off')
    expect(formatAiStatusBadge({ enabled: true, state: 'on' }).label).toBe('AI · On')
    expect(formatAiStatusBadge({ enabled: true, state: 'setup', reason: 'Missing key' }).label).toBe('AI · Setup')
    expect(formatAiStatusBadge({ enabled: true, state: 'error', reason: '401' }).label).toBe('AI · Error')
    expect(formatAiStatusBadge({ enabled: true, state: 'slow', lastMs: 12500 }).label).toBe('AI · 13s')
    expect(formatAiStatusBadge({ enabled: true, state: 'slow' }).label).toBe('AI · Slow')
    expect(formatAiStatusBadge({ enabled: true, state: 'ready', lastMs: 420 }).label).toBe('AI · 0.4s')

    // renderSharedExplainAiPanel states
    const explainBox = dom.document.createElement('div')
    dom.body.appendChild(explainBox)
    renderSharedExplainAiPanel(null, {})
    renderSharedExplainAiPanel(explainBox, { phase: 'hidden' })
    expect(explainBox.hidden).toBe(true)

    const cb = {
      onLanguageChange: vi.fn(),
      onCancel: vi.fn(),
      onConfigureAi: vi.fn(),
      onAnalyze: vi.fn(),
      onToggleCollapsed: vi.fn(),
      onCopyText: vi.fn(),
      onApplySql: vi.fn(),
      onOpenNewTab: vi.fn(),
    }
    renderSharedExplainAiPanel(explainBox, { phase: 'loading', aiEnabled: true, aiReady: true, language: 'vi' }, cb)
    const loadingBtns = explainBox.querySelectorAll('button')
    expect(loadingBtns.length).toBe(1)
    dom.click(loadingBtns[0]) // Cancel -> onCancel
    expect(cb.onCancel).toHaveBeenCalled()

    renderSharedExplainAiPanel(explainBox, { phase: 'idle', aiEnabled: true, aiReady: true }, cb)
    expect(explainBox.querySelector('.datanoa-ai-hint')).toBeNull()
    expect(explainBox.querySelector('.datanoa-ai-lang-pill')).toBeNull()

    renderSharedExplainAiPanel(explainBox, { phase: 'idle', aiEnabled: false, aiReady: false }, cb)
    expect(explainBox.querySelector('.datanoa-ai-hint')).not.toBeNull()
    dom.click(explainBox.querySelector('button')!)
    expect(cb.onConfigureAi).toHaveBeenCalled()

    renderSharedExplainAiPanel(explainBox, { phase: 'error', aiEnabled: true, aiReady: true, error: 'Model failed' }, cb)
    const errBtns = explainBox.querySelectorAll('button')
    dom.click(errBtns[1]) // Retry
    dom.click(errBtns[2]) // AI Settings
    expect(cb.onAnalyze).toHaveBeenCalled()

    renderSharedExplainAiPanel(
      explainBox,
      {
        phase: 'ready',
        aiEnabled: true,
        aiReady: true,
        collapsed: false,
        result: {
          durationMs: 185,
          language: 'en',
          summary: 'Seq scan found',
          bottlenecks: [{ severity: 'high', title: 'Full scan', detail: 'Add idx' }],
          indexSuggestions: [{ reason: 'Speeds WHERE', ddl: 'CREATE INDEX ix ON t(a);' }],
          optimizedSql: 'SELECT a FROM t;',
          caveats: ['Check cardinality'],
        },
      },
      cb
    )
    for (const b of explainBox.querySelectorAll('button')) dom.click(b)
    expect(cb.onToggleCollapsed).toHaveBeenCalled()
    expect(cb.onApplySql).toHaveBeenCalledWith('SELECT a FROM t;')
    expect(cb.onOpenNewTab).toHaveBeenCalledWith('SELECT a FROM t;')
    expect(cb.onCopyText).toHaveBeenCalled()

    // openSharedAiConfigModal standalone backdrop + all RPC actions
    const saveSettings = vi.fn(async () => {})
    const onStatusUpdated = vi.fn()
    let throwTest = false
    const rpc = vi.fn(async (method: string) => {
      if (method === 'ai.status.get') {
        return { enabled: true, state: 'ready', format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hasKey: true, maxTokens: 96, explainMaxTokens: 512, explainLanguage: 'en' }
      }
      if (method === 'ai.stats.get') {
        return { summary: { shown: 10, accepted: 4, kept: 3, p50: 120, p95: 340 } }
      }
      if (method === 'ai.models.list') {
        return {
          ok: true,
          models: ['gpt-4o-mini', 'gpt-4o', 'o3-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-3.5-turbo', 'text-davinci'],
        }
      }
      if (method === 'ai.models.usage') return { usage: { 'gpt-4o': { ms: 95 } } }
      if (method === 'ai.models.bench') return { results: [{ model: 'gpt-4o', ok: true, ms: 85 }] }
      if (method === 'ai.provider.test') {
        if (throwTest) throw new Error('Network unreachable')
        return { ok: true, ms: 55 }
      }
      if (method === 'ai.key.set') return { hasKey: false }
      return {}
    })

    await openSharedAiConfigModal({ rpc, saveSettings, onStatusUpdated })
    await dom.flushMicrotasks()
    const card = dom.body.querySelector('.datanoa-ai-modal')!
    expect(card).not.toBeNull()

    // Show all models toggle, model filter, model select chip
    const chipsBefore = card.querySelectorAll('.datanoa-ai-chip')
    expect(chipsBefore.length).toBeGreaterThan(0)
    dom.click(chipsBefore[0])
    const searchModels = card.querySelector('input[placeholder*="Search"]')
    if (searchModels) {
      dom.setInput(searchModels, 'no-such-model')
      dom.setInput(searchModels, '')
    }

    // Preset switch -> custom-openai clears known url -> invalid URL models error -> valid url models fail -> bench empty -> bench valid
    const providerSel = card.querySelectorAll('select')[0]
    providerSel.value = 'custom-openai'
    providerSel.dispatchEvent(new Event('change', { bubbles: true }))
    const urlInp = card.querySelector('input[type="url"]')!
    const fetchModelsBtn = card.querySelector('button[aria-label="Fetch available models"]')!
    dom.click(fetchModelsBtn) // empty/cleared url -> validation message
    dom.setInput(urlInp, 'https://api.openai.com/v1')
    dom.click(fetchModelsBtn)
    await dom.flushMicrotasks()

    const benchBtn = card.querySelectorAll('button').find((b) => /Benchmark/i.test(b.textContent))!
    dom.click(benchBtn)
    await dom.flushMicrotasks()

    const testBtn = card.querySelectorAll('button').find((b) => /^Test/i.test(b.textContent))!
    dom.click(testBtn)
    await dom.flushMicrotasks()
    throwTest = true
    dom.click(testBtn)
    await dom.flushMicrotasks()

    // Clear key + Reset stats + Save with new draft API key
    const clearKeyBtn = card.querySelector('button[aria-label="Clear saved API key"]')!
    clearKeyBtn.disabled = false
    dom.click(clearKeyBtn)
    await dom.flushMicrotasks()

    const resetStatsBtn = card.querySelectorAll('button').find((b) => /Reset/i.test(b.textContent))!
    dom.click(resetStatsBtn)
    await dom.flushMicrotasks()

    const keyInp = card.querySelector('input[type="password"]')!
    dom.setInput(keyInp, 'sk-test-new-key')
    const saveBtn = card.querySelectorAll('button').find((b) => /Save/i.test(b.textContent))!
    dom.click(saveBtn)
    await dom.flushMicrotasks()
    expect(saveSettings).toHaveBeenCalled()
    expect(dom.body.querySelector('.datanoa-ai-modal')).toBeNull()

    // Re-open and close with Escape & backdrop
    await openSharedAiConfigModal({ rpc, saveSettings })
    dom.fireKey(dom.body.querySelector('.datanoa-ai-modal')!, 'Escape')
    expect(dom.body.querySelector('.datanoa-ai-modal')).toBeNull()

    // saveOrcaSettingsPatch via both settings.set and host.call
    const setSpy = vi.fn(async () => {})
    ;(dom.window as unknown as Record<string, unknown>).orca = { settings: { set: setSpy } }
    await saveOrcaSettingsPatch({ aiModel: 'gpt-4o' })
    expect(setSpy).toHaveBeenCalledWith('aiModel', 'gpt-4o')

    const hostSpy = vi.fn(async () => {})
    ;(dom.window as unknown as Record<string, unknown>).orca = { host: { call: hostSpy } }
    await saveOrcaSettingsPatch({ aiEnabled: true })
    expect(hostSpy).toHaveBeenCalledWith('settings.set', { key: 'aiEnabled', value: true })
  })

  it('covers src/shared-cm-inline-ai.js live CodeMirror EditorView plugin lifecycle, accept, dismiss, debounce trigger & metrics', async () => {
    vi.useFakeTimers()
    let enabled = true
    const metrics: Array<[number, string]> = []
    let resolveNext: ((v: { id: number; suggestion: string } | null) => void) | null = null

    const requestCompletion = vi.fn(
      () =>
        new Promise<{ id: number; suggestion: string } | null>((resolve) => {
          resolveNext = resolve
        })
    )

    const view = new EditorView({
      doc: 'SELECT ',
      extensions: [
        keymap.of([]),
        createCmInlineAiExtension({
          isEnabled: () => enabled,
          requestCompletion,
          onMetric: (id: number, kind: string) => metrics.push([id, kind]),
        }),
      ],
      parent: dom.body,
    })

    try {
      // Type an identifier char so update() schedules trigger() after pause delay
      view.dispatch({ changes: { from: 7, to: 7, insert: 'id' }, selection: { anchor: 9 } })
      await vi.advanceTimersByTimeAsync(700)
      expect(requestCompletion).toHaveBeenCalledTimes(1)

      // Resolve multiline suggestion -> sets ghost widget + reports 'shown'
      resolveNext?.({ id: 101, suggestion: ', name\nFROM users' })
      await Promise.resolve()
      await Promise.resolve()
      expect(view.state.field(ghostStateField)?.text).toBe(', name\nFROM users')
      expect(metrics).toContainEqual([101, 'shown'])

      // Type along matching prefix -> reuses remainder cleanly
      view.dispatch({ changes: { from: 9, to: 9, insert: ', ' }, selection: { anchor: 11 } })
      await Promise.resolve()
      expect(view.state.field(ghostStateField)?.text).toBe('name\nFROM users')

      // Partial word accept + line accept + full accept with post-accept kept tracking
      expect(acceptGhostWord(view)).toBe(true)
      expect(acceptGhostLine(view)).toBe(true)
      expect(acceptGhostFull(view)).toBe(false) // already finished line

      // Inject another ghost & accept full cleanly
      view.dispatch({ effects: setGhostEffect.of({ offset: view.state.doc.length, text: ' WHERE 1=1', id: 102 }) })
      expect(acceptGhostFull(view)).toBe(true)
      expect(metrics).toContainEqual([102, 'accepted'])
      await vi.advanceTimersByTimeAsync(31_000)
      expect(metrics).toContainEqual([102, 'kept'])

      // Second requestCompletion triggers -> resolves 103 -> diverging edit drops 103 as 'stale'
      view.dispatch({ changes: { from: view.state.doc.length, to: view.state.doc.length, insert: ' x' }, selection: { anchor: view.state.doc.length + 2 } })
      await vi.advanceTimersByTimeAsync(700)
      resolveNext?.({ id: 103, suggestion: ' LIMIT 10' })
      await Promise.resolve()
      await Promise.resolve()
      view.dispatch({ changes: { from: view.state.doc.length, to: view.state.doc.length, insert: 'Z' }, selection: { anchor: view.state.doc.length + 1 } })
      expect(metrics).toContainEqual([103, 'stale'])

      // Selection change + disabled clearing
      view.dispatch({ effects: setGhostEffect.of({ offset: view.state.doc.length, text: ' ASC', id: 104 }) })
      enabled = false
      view.dispatch({ selection: { anchor: 0 } })
      await Promise.resolve()
      expect(view.state.field(ghostStateField)).toBeNull()

      // Pacer helpers
      const pacer = new Pacer(200)
      pacer.noteKey(1000)
      expect(pacer.delayMs(undefined)).toBe(300)
      expect(pacer.delayMs({ triggerChar: ' ', isLineEnd: true, estimatedLatencyMs: 50 })).toBe(120)

      // trackAcceptance mapChanges deletion -> undone
      const cancels = trackAcceptance(
        {
          getText: () => 'SELECT x',
          trackRange: () => 'id1',
          getTrackedText: () => null,
          untrackRange: () => {},
        },
        { startOffset: 0, text: 'SELECT x' },
        (v: string) => metrics.push([999, v])
      )
      await vi.advanceTimersByTimeAsync(6000)
      cancels()
      expect(metrics).toContainEqual([999, 'undone'])
      view.dispatch({ effects: clearGhostEffect.of(undefined) })
    } finally {
      view.destroy()
    }
  })

  it('covers remaining edge branches across shared-file-picker, shared-collapsible-select, shared-ai-ui, and shared-cm-inline-ai', async () => {
    // 1. shared-file-picker: no classes.body, partial fail on initial strict=false w/ currentDir+roots, Shift+Tab from outside modal, closeBtn click
    const noBodyCls = { ...PICKER_CLASSES } as Record<string, string | undefined>
    delete noBodyCls.body
    const p1 = openSharedFilePickerModal({
      mode: 'file',
      classes: noBodyCls as typeof PICKER_CLASSES,
      listDir: async () => ({
        ok: false,
        error: 'Bad start',
        currentDir: '/fallback-dir',
        parentDir: null,
        roots: ['/fallback-dir'],
      }),
    })
    await dom.flushMicrotasks()
    dom.document.activeElement = null
    dom.fireKey(dom.body.querySelector('.fp-modal')!, 'Tab', { shiftKey: true })
    dom.fireKey(dom.body.querySelector('.fp-modal')!, 'Tab', { shiftKey: false })
    dom.click(dom.body.querySelector('.fp-btn-sm')!) // Close button
    expect(await p1).toEqual({ ok: false, cancelled: true })

    // 2. shared-collapsible-select: second click closes, click inside popover ignored, subtitle row, remove optgroups + refresh
    const adapter = makeSelectAdapter()
    const ctrl = createCollapsibleSelectController(adapter)
    const wrap = dom.document.createElement('div')
    const sel = dom.document.createElement('select')
    sel.innerHTML = `<optgroup label="G"><option value="a" data-driver="postgres" data-subtitle="Primary 5432" selected>PG</option></optgroup>`
    wrap.appendChild(sel)
    dom.body.appendChild(wrap)
    const api = ctrl.enhance(sel, {})!
    dom.click(api.triggerBtn) // open
    const pop = dom.body.querySelector('.cs-popover')!
    dom.click(pop) // inside popover -> stays open
    expect(ctrl.isOpen()).toBe(true)
    sel.innerHTML = '<option value="flat">Flat</option>'
    api.refresh({}) // shrinks groups -> 0 -> removes expand/collapse buttons
    dom.click(api.triggerBtn) // toggle close
    expect(ctrl.isOpen()).toBe(false)

    // 3. shared-ai-ui: custom mountModal/closeModal, failing rpc branches for stats/clearKey/models/bench/test/save
    let customMounted = false
    let customClosed = false
    const modalContainer = dom.document.createElement('div')
    dom.body.appendChild(modalContainer)
    const failingRpc = vi.fn(async (method: string) => {
      if (method === 'ai.stats.get') throw new Error('stats err')
      if (method === 'ai.models.list') throw new Error('models err')
      if (method === 'ai.models.bench') return { results: [], message: 'bench failed' }
      if (method === 'ai.provider.test') return { ok: false, message: 'Invalid key' }
      if (method === 'ai.key.set') throw new Error('keyring locked')
      return {}
    })
    await openSharedAiConfigModal({
      rpc: failingRpc,
      saveSettings: async () => { throw new Error('save rejected') },
      initialStatus: { enabled: true, format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', hasKey: true },
      mountModal: (card: HTMLElement) => {
        customMounted = true
        modalContainer.appendChild(card)
      },
      closeModal: () => {
        customClosed = true
        modalContainer.innerHTML = ''
      },
    })
    await dom.flushMicrotasks()
    expect(customMounted).toBe(true)
    const card = modalContainer.querySelector('.datanoa-ai-modal')!
    dom.click(card.querySelector('button[aria-label="Fetch available models"]')!)
    await dom.flushMicrotasks()
    dom.click(card.querySelector('button[aria-label="Clear saved API key"]')!)
    await dom.flushMicrotasks()
    dom.click(card.querySelectorAll('button').find((b) => /Benchmark/i.test(b.textContent))!)
    await dom.flushMicrotasks()
    dom.click(card.querySelectorAll('button').find((b) => /^Test/i.test(b.textContent))!)
    await dom.flushMicrotasks()
    dom.click(card.querySelectorAll('button').find((b) => /Save/i.test(b.textContent))!)
    await dom.flushMicrotasks()
    dom.fireKey(card, 'Escape')
    expect(customClosed).toBe(true)

    // 4. shared-cm-inline-ai: Escape clears ghost (clearGhostCommand), doc delete -> empty doc & inside string skip,
    // inflight abort + catch path, active cancels destroyed on unmount, enabled=false w/ setGhost clears via microtask, and getText
    vi.useFakeTimers()
    let aiEnabled = true
    const onMetric = vi.fn()
    let rejectInflight: ((e: Error) => void) | null = null
    const reqComp = vi.fn(
      () =>
        new Promise<{ id: number; suggestion: string }>((_resolve, reject) => {
          rejectInflight = reject
        })
    )
    const view = new EditorView({
      doc: 'SELECT ',
      extensions: [
        keymap.of([]),
        createCmInlineAiExtension({
          isEnabled: () => aiEnabled,
          requestCompletion: reqComp,
          onMetric,
        }),
      ],
      parent: dom.body,
    })
    try {
      // Trigger & reject completion (hits catch block L604-605)
      view.dispatch({ changes: { from: 7, to: 7, insert: 'a' }, selection: { anchor: 8 } })
      await vi.advanceTimersByTimeAsync(700)
      rejectInflight?.(new Error('network abort'))
      await Promise.resolve()

      // Escape key clears active ghost (clearGhostCommand L354-360) + ignoreEvent
      view.dispatch({ effects: setGhostEffect.of({ offset: 8, text: 'b', id: 201 }) })
      const ghostEl = dom.body.querySelector('.cm-ai-ghost')
      ghostEl?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      dom.fireKey(view.contentDOM, 'Escape')
      await Promise.resolve()

      // Non-empty range selection + empty doc + inside string literal skip
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "'in str" },
        selection: { anchor: 7 },
      })
      view.dispatch({ selection: { anchor: 0, head: 3 } })
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' }, selection: { anchor: 0 } })

      // Accept full ghost & immediately edit inside tracked range so LiveModelTracker shrinks/deletes + calls getText
      view.dispatch({ changes: { from: 0, to: 0, insert: 'SELECT id' }, selection: { anchor: 9 } })
      view.dispatch({ effects: setGhostEffect.of({ offset: 9, text: ' FROM users', id: 202 }) })
      expect(acceptGhostFull(view)).toBe(true)
      view.dispatch({ changes: { from: 9, to: 20, insert: '' }, selection: { anchor: 9 } })

      // enabled=false with ghost set -> queueMicrotask clears ghost
      aiEnabled = false
      view.dispatch({ effects: setGhostEffect.of({ offset: 9, text: ' ORDER BY 1', id: 203 }) })
      await Promise.resolve()
      await Promise.resolve()
      expect(view.state.field(ghostStateField)).toBeNull()
    } finally {
      view.destroy()
    }
  })
})
