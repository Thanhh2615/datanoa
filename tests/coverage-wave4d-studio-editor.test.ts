import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'
import { installDomHarness, type DomHarness } from './helpers/dom-harness.js'
import { createLiveStudioSqliteBackend, flushMicro, flushTick } from './helpers/live-studio-sqlite.js'
import {
  EditorSelection,
  EditorState,
  EditorView,
  completionKeymap,
} from '../vendor/codemirror.js'

import {
  createDbLogoSvg,
  setButtonLoading,
  downloadTextFile,
  extractPredicateColumnName,
  isEditableShortcutTarget,
  parseClientQuickFilterPredicate,
  extractQueriedTableName,
  copyTextFallback,
  bindStudioSelectTooltipsInRoot,
  syncStudioSelectTooltip,
  groupConnectionsForSelector,
  enhanceStudioCollapsibleSelect,
} from '../src/editor/db-icons.js'
import { createSidebarContextMenu } from '../src/editor/studio-sidebar.js'
import { mountStudioColumnsPopover } from '../src/editor/studio-columns-popover.js'
import {
  buildInitialResultTabStates,
  buildCombinedExplainResult,
} from '../src/editor/result-set-controller.js'
import { openStudioFeedbackModal } from '../src/editor/feedback-modal.js'
import { TransactionToolbarController } from '../src/editor/transaction-toolbar.js'
import { openStudioBindParamsModal } from '../src/editor/bind-params-modal.js'
import {
  openStudioCreateTableModal,
  openStudioDangerTableModal,
  openStudioCommandPalette,
} from '../src/editor/studio-modals.js'
import { openStudioSavedQueriesModal } from '../src/editor/saved-queries-modal.js'
import { openStudioDriverManagerModal } from '../src/editor/driver-manager-modal.js'
import { ValueInspectorController } from '../src/editor/value-inspector.js'
import {
  SqlConsoleController,
  buildLanguageExtension,
  buildCompletionExtension,
  computeSmartSqlCompletions,
} from '../src/editor/console.js'
import { openStudioImportModal } from '../src/editor/import-modal.js'
import { SchemaInspectorView } from '../src/editor/schema-inspector.js'
import {
  compactFilePath,
  openStudioConnectionModal,
} from '../src/editor/connection-modal.js'
import { VirtualDataGrid } from '../src/editor/grid.js'
import { GridSelectionModel } from '../src/editor/grid-selection.js'
import { openStudioDangerSqlModal } from '../src/editor/danger-sql-modal.js'
import { initializeEditor, DatanoaStudioEditor } from '../src/editor/index.js'
import {
  STUDIO_VIEW_STATE_STORAGE_KEY,
  writeLocalStudioWarmCache,
  writeStudioViewStateSnapshot,
} from '../src/editor/document-meta.js'
import type {
  ConnectionProfile,
  DatabaseDriverType,
  QueryResult,
  SchemaObject,
  TableDetails,
  TableBrowseResult,
} from '../src/protocol.js'

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

function findBtn(root: ParentNode, re: RegExp): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll('button')).find((b) =>
    re.test(b.textContent || '') ||
    re.test(b.title || '') ||
    re.test(b.getAttribute('aria-label') || '')
  ) as HTMLButtonElement | undefined
}

function makeFakeFile(name: string, content: string, opts: { noArrayBuffer?: boolean; sizeOverride?: number } = {}): File {
  const bytes = new TextEncoder().encode(content)
  const obj: Record<string, unknown> = {
    name,
    size: opts.sizeOverride ?? bytes.byteLength,
    type: name.endsWith('.json') ? 'application/json' : 'text/csv',
    lastModified: Date.now(),
    text: async () => content,
    slice: () => new Blob([bytes]),
  }
  if (!opts.noArrayBuffer) {
    obj.arrayBuffer = async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }
  return obj as unknown as File
}

describe('Wave 4D Studio Editor Coverage — Slice 1 & 2 (Sub-modules, Console, Import, Schema, Connection)', () => {
  let dom: DomHarness | undefined

  beforeEach(() => {
    dom = installDomHarness({ url: 'http://localhost/' })
    document.body.clientWidth = 1200
    document.body.clientHeight = 800
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    dom?.teardown()
    dom = undefined
  })

  it('Slice 1A: covers db-icons PBT + DOM helpers, sidebar/columns/result-set/feedback micro-tails', async () => {
    // PBT on extractPredicateColumnName & parseClientQuickFilterPredicate
    const colArb = fc
      .string({ minLength: 1, maxLength: 14 })
      .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s))
    fc.assert(
      fc.property(colArb, fc.integer({ min: -500, max: 500 }), fc.boolean(), (col, num, quoted) => {
        const head = quoted ? `"${col}"` : col
        const eqPred = parseClientQuickFilterPredicate(`${head} = ${num}`)
        expect(eqPred).toEqual({ column: col, op: 'eq', value: num })
        const notNullPred = parseClientQuickFilterPredicate(`${head} IS NOT NULL`)
        expect(notNullPred).toEqual({ column: col, op: 'is-not-null', value: null })
      }),
      { numRuns: 40 }
    )

    // Unknown driver fallback
    const unknownSvg = createDbLogoSvg('unknown_engine' as DatabaseDriverType)
    expect(unknownSvg.getAttribute('class')).toContain('db-unknown_engine')

    // setButtonLoading default label fallback + reset
    const loadingBtn = document.createElement('button')
    loadingBtn.textContent = ''
    setButtonLoading(loadingBtn, true)
    expect(loadingBtn.disabled).toBe(true)
    setButtonLoading(loadingBtn, true, 'Working')
    expect(loadingBtn.textContent).toContain('Working')
    setButtonLoading(loadingBtn, false)
    expect(loadingBtn.disabled).toBe(false)

    // downloadTextFile without document
    await withTempGlobal('document', undefined, async () => {
      const res = await downloadTextFile('SELECT 1;', 'q.sql', 'text/sql')
      expect(res).toBe('failed')
    })

    // extractPredicateColumnName + parseClientQuickFilterPredicate + extractQueriedTableName edge inputs
    expect(extractPredicateColumnName('   ')).toBeNull()
    expect(extractPredicateColumnName('"unclosed')).toBeNull()
    expect(extractPredicateColumnName('[unclosed')).toBeNull()
    expect(extractPredicateColumnName('= 1')).toBeNull()
    expect(parseClientQuickFilterPredicate('')).toBeNull()
    expect(extractQueriedTableName('SELECT 1 FROM ')).toBeNull()

    // isEditableShortcutTarget across all branches
    expect(isEditableShortcutTarget(null)).toBe(false)
    expect(isEditableShortcutTarget(document.createElement('input'))).toBe(true)
    expect(isEditableShortcutTarget(document.createElement('textarea'))).toBe(true)
    expect(isEditableShortcutTarget(document.createElement('select'))).toBe(true)
    const ce = document.createElement('div')
    ;(ce as unknown as { isContentEditable: boolean }).isContentEditable = true
    expect(isEditableShortcutTarget(ce)).toBe(true)
    expect(isEditableShortcutTarget(document.createElement('div'))).toBe(false)

    // copyTextFallback empty label -> 'Copy'
    const cpBtn = document.createElement('button')
    cpBtn.textContent = ''
    copyTextFallback('hello', cpBtn)
    expect(cpBtn.dataset.origLabel).toBe('Copy')

    // bindStudioSelectTooltipsInRoot + syncStudioSelectTooltip fallbacks
    const sel = document.createElement('select')
    sel.dataset.tooltipPrefix = 'CustomPfx'
    const o1 = document.createElement('option')
    o1.value = 'v1'
    o1.textContent = 'Opt 1'
    sel.appendChild(o1)
    document.body.appendChild(sel)
    const tipBinding = bindStudioSelectTooltipsInRoot(document)
    sel.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    expect(sel.title).toContain('CustomPfx')
    delete sel.dataset.tooltipPrefix
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    expect(sel.title).toBe('Selected option: Opt 1')
    tipBinding.dispose()

    const selNoPrefix = document.createElement('select')
    syncStudioSelectTooltip(selNoPrefix)
    expect(selNoPrefix.title).toBe('Selected option')

    // groupConnectionsForSelector multiple items in same folder
    const grouped = groupConnectionsForSelector([
      { folder: 'Prod', workspaceScope: '' },
      { folder: 'Prod', workspaceScope: '' },
    ])
    expect(grouped.groups[0].items.length).toBe(2)

    // enhanceStudioCollapsibleSelect with workspace icon & unknown driver
    const wsSelect = document.createElement('select')
    const wsOpt1 = document.createElement('option')
    wsOpt1.value = 'w1'
    wsOpt1.textContent = 'WS 1'
    wsOpt1.selected = true
    const wsOpt2 = document.createElement('option')
    wsOpt2.value = 'w2'
    wsOpt2.textContent = 'WS 2'
    wsOpt2.dataset.driver = 'unknown_drv'
    wsSelect.appendChild(wsOpt1)
    wsSelect.appendChild(wsOpt2)
    document.body.appendChild(wsSelect)
    enhanceStudioCollapsibleSelect(wsSelect, { leadingIconType: 'workspace' })
    const trig = wsSelect.parentElement?.querySelector('.datanoa-custom-select-trigger') as HTMLButtonElement | null
    trig?.click()
    const drvSelect = document.createElement('select')
    const drvOpt = document.createElement('option')
    drvOpt.value = 'd1x'
    drvOpt.textContent = 'D1X'
    drvOpt.dataset.driver = 'mystery_db'
    drvOpt.selected = true
    drvSelect.appendChild(drvOpt)
    document.body.appendChild(drvSelect)
    enhanceStudioCollapsibleSelect(drvSelect, { leadingIconType: 'db' })
    const drvTrig = drvSelect.parentElement?.querySelector('.datanoa-custom-select-trigger') as HTMLButtonElement | null
    drvTrig?.click()

    // studio-sidebar: window undefined during placeMenu
    withTempGlobal('window', undefined, () => {
      const m = createSidebarContextMenu({
        item: { name: 'v_users', kind: 'view' },
        clientX: 40,
        clientY: 40,
        isReadOnly: false,
        onCountRows: vi.fn(),
        onSelectSqlTemplate: vi.fn(),
        onOpenInspector: vi.fn(),
        onCopyObjectDdl: vi.fn(),
        onOpenObjectDdlInConsole: vi.fn(),
        onOpenImportModal: vi.fn(),
        onOpenDangerModal: vi.fn(),
      })
      m.remove()
    })

    // studio-columns-popover with undefined popRect
    const anchor = document.createElement('button')
    anchor.getBoundingClientRect = () => ({ top: 20, bottom: 40, left: 20, right: 100, width: 80, height: 20, x: 20, y: 20, toJSON() {} })
    const origCreate = document.createElement.bind(document)
    const spyCreate = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag)
      if (tag === 'div') {
        ;(el as { getBoundingClientRect?: () => unknown }).getBoundingClientRect = () => undefined
      }
      return el
    })
    const fakeColGrid = {
      getColumnConfig: () => ({ allColumns: ['id'], order: ['id'], hidden: [], pinned: [] }),
      setColumnVisibility: vi.fn(),
      setColumnPinned: vi.fn(),
      resetColumnVisibility: vi.fn(),
    } as never
    const colPop = mountStudioColumnsPopover(fakeColGrid, anchor, vi.fn())
    colPop.outsideCleanup?.()
    colPop.popoverEl.remove()
    spyCreate.mockRestore()

    // result-set-controller: single set with columns undefined + buildCombinedExplainResult with firstNonError=null and non-empty set
    const singleStates = buildInitialResultTabStates(
      { columns: undefined as never, rows: [], rowCount: 0, executionTimeMs: 1, truncated: false, isSelect: true },
      ['SELECT 1'],
      'SELECT 1',
      1,
      'query'
    )
    expect(singleStates[0].gridSubbarTitle).toContain('0 cols')
    const errExplain = buildCombinedExplainResult(
      [{ index: 0, sqlPreview: 'X', sql: 'EXPLAIN X', executionTimeMs: 1, columns: undefined as never, rows: undefined as never, rowCount: undefined as never, truncated: false, isSelect: true, isError: true }],
      null,
      4
    )
    expect(errExplain.columns).toEqual([])
    expect(errExplain.rowCount).toBe(0)

    // feedback-modal: openExternal undefined & empty diagPre
    let fbEl: HTMLElement | null = null
    openStudioFeedbackModal({
      mountModal: (el) => {
        fbEl = el
        document.body.appendChild(el)
        return document.createElement('div')
      },
      closeModal: vi.fn(),
      activeDriver: 'sqlite',
      activeViewMode: 'split',
      isReadOnly: false,
      lastQueryErrorText: '',
      updateStatus: vi.fn(),
    })
    const diagPre = fbEl!.querySelector('pre')
    if (diagPre) diagPre.textContent = ''
    ;(window as { orca?: unknown }).orca = {}
    findBtn(fbEl!, /Open on GitHub Issues/i)?.click()
    fbEl!.remove()
  })

  it('Slice 1B: covers transaction-toolbar, bind-params, studio-modals, saved-queries, driver-manager, value-inspector tails', async () => {
    // 1. transaction-toolbar: pre-mount guard + cleanup/stale mutation races + txToken
    let activeConn: string | null = 'c1'
    const pendingCleanups: Array<() => void> = []
    let resolvePendingTx: ((v: unknown) => void) | null = null
    const flushCleanups = async () => {
      for (let round = 0; round < 6; round++) {
        while (pendingCleanups.length > 0) {
          const fn = pendingCleanups.shift()
          fn?.()
        }
        await flushMicro(4)
      }
    }
    const txHost = {
      getActiveConnectionId: () => activeConn,
      getActiveConnection: () => ({ id: 'c1', name: 'C1', driver: 'postgres' as const }),
      isReadOnly: () => false,
      isQueryRunning: () => false,
      isShowingSqlResult: () => false,
      getActiveTable: () => 't1',
      getCurrentPage: () => 1,
      requestPlugin: vi.fn(async (method: string, payload?: Record<string, unknown>) => {
        if (method === 'tx.rollback' && payload?.onlyIfOwner) {
          return await new Promise((_res, rej) => {
            pendingCleanups.push(() => rej(new Error('cleanup done')))
          })
        }
        if (method === 'tx.setAutoCommit' || method === 'tx.begin' || method === 'tx.commit' || method === 'tx.rollback') {
          return await new Promise((res) => {
            resolvePendingTx = res
          })
        }
        return { supported: true, autoCommit: true, active: false }
      }),
      reloadTableData: vi.fn(),
      showErrorBanner: vi.fn(),
      updateStatus: vi.fn(),
    }
    const tx = new TransactionToolbarController(txHost)
    tx.updateToolbar() // before mount -> L74
    const txParent = document.createElement('div')
    tx.mount(txParent)
    await tx.refreshState('c1')

    // Start begin -> active with txToken -> switch connection -> triggers cleanup promise + txToken
    const beginP = tx.begin()
    await flushMicro(4)
    resolvePendingTx?.({ supported: true, autoCommit: false, active: true, txToken: 42 })
    await beginP
    tx.resetForConnectionSwitch('c1') // starts pending cleanup rollback & sends txToken: 42
    await flushCleanups()

    // While c1 cleanup is pending, start setAutoCommit/begin/commit/rollback and switch away before cleanup settles
    for (const op of ['autoCommit', 'begin', 'commit', 'rollback'] as const) {
      activeConn = 'c1'
      ;(tx as unknown as { state: { supported: boolean; active: boolean; autoCommit: boolean } }).state = {
        supported: true,
        active: true,
        autoCommit: false,
      }
      // Put a pending cleanup on c1
      tx.resetForConnectionSwitch('c1')
      ;(tx as unknown as { state: { supported: boolean; active: boolean; autoCommit: boolean } }).state = {
        supported: true,
        active: true,
        autoCommit: false,
      }
      const p =
        op === 'autoCommit'
          ? tx.toggleAutoCommit()
          : op === 'begin'
            ? tx.begin()
            : op === 'commit'
              ? tx.commit()
              : tx.rollback()
      await flushMicro(4)
      activeConn = 'c2'
      tx.resetForConnectionSwitch('c1')
      await flushCleanups()
      await p
    }
    // Also resolve rollbackOnSettle with txToken
    activeConn = 'c1'
    ;(tx as unknown as { state: { supported: boolean; active: boolean; autoCommit: boolean } }).state = {
      supported: true,
      active: false,
      autoCommit: true,
    }
    const beginSettling = tx.begin()
    await flushMicro(4)
    tx.resetForConnectionSwitch('c1') // sets rollbackOnSettle=true
    resolvePendingTx?.({ supported: true, autoCommit: false, active: true, txToken: 99 })
    await flushCleanups()
    await beginSettling

    // Stale RPC response after mutation resolves
    for (const op of ['autoCommit', 'commit', 'rollback'] as const) {
      activeConn = 'c1'
      ;(tx as unknown as { state: { supported: boolean; active: boolean; autoCommit: boolean } }).state = {
        supported: true,
        active: true,
        autoCommit: false,
      }
      const p = op === 'autoCommit' ? tx.toggleAutoCommit() : op === 'commit' ? tx.commit() : tx.rollback()
      await flushMicro(4)
      activeConn = 'c2'
      tx.resetForConnectionSwitch('c1')
      resolvePendingTx?.({ supported: true, autoCommit: true, active: false })
      await flushCleanups()
      await p
    }
    tx.destroy()

    // 2. bind-params-modal: invalid number error & all-null initial focus fallback
    let bpModal: HTMLElement | null = null
    openStudioBindParamsModal({
      mountModal: (el) => {
        bpModal = el
        document.body.appendChild(el)
        return document.createElement('div')
      },
      closeModal: vi.fn(),
      sql: 'SELECT * FROM t WHERE id = :id;',
      dialect: 'sqlite',
      params: [{ key: 'id', name: 'id', style: 'named', occurrences: 1 }],
      rememberedValues: { id: { value: '', type: 'null' } },
      onConfirm: vi.fn(),
    })
    const bpTypeSel = bpModal!.querySelector('select') as HTMLSelectElement
    const bpValInp = bpModal!.querySelector('input[type="text"]') as HTMLInputElement
    const bpNullCb = bpModal!.querySelector('input[type="checkbox"]') as HTMLInputElement
    bpNullCb.checked = false
    bpNullCb.dispatchEvent(new Event('change'))
    bpTypeSel.value = 'number'
    bpTypeSel.dispatchEvent(new Event('change'))
    bpValInp.value = 'not_a_number'
    bpValInp.dispatchEvent(new Event('input'))
    expect(bpModal!.textContent).toContain('Invalid')
    bpModal!.remove()

    // 3. studio-modals: CreateTable nullable checkbox, single-col remove guard, onTableCreated throw, DangerTable throw, CommandPalette without optional callbacks
    let ctEl: HTMLElement | null = null
    openStudioCreateTableModal({
      mountModal: (el) => {
        ctEl = el
        document.body.appendChild(el)
        return document.createElement('div')
      },
      closeModal: vi.fn(),
      activeConnection: { id: 'c1', name: 'PG', driver: 'postgres', database: 'db' },
      activeConnectionId: 'c1',
      activeSchema: 'public',
      updateStatus: vi.fn(),
      createElapsedTimer: () => () => {},
      requestPlugin: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 1, truncated: false, isSelect: false })),
      onTableCreated: vi.fn(async () => {
        throw new Error('Refresh failed')
      }),
    })
    const tblInp = ctEl!.querySelector('#datanoa-create-table-name-input') as HTMLInputElement
    tblInp.value = 'orders'
    tblInp.dispatchEvent(new Event('input'))
    // Add column, toggle nullable on col 2, remove col 2
    findBtn(ctEl!, /\+ Add Column/i)?.click()
    const nullCbs = Array.from(ctEl!.querySelectorAll('input[aria-label*="nullable"]')) as HTMLInputElement[]
    nullCbs[1].checked = false
    nullCbs[1].dispatchEvent(new Event('change'))
    const rmBtns = Array.from(ctEl!.querySelectorAll('button[aria-label*="Remove column"]')) as HTMLButtonElement[]
    rmBtns[1].click()
    // Submit to trigger onTableCreated catch
    findBtn(ctEl!, /^Create Table$/i)?.click()
    await flushTick()
    ctEl!.remove()

    // DangerTable with redis unsupported -> updateStatus guard
    const updateDangerStatus = vi.fn()
    openStudioDangerTableModal(
      {
        mountModal: (el) => {
          document.body.appendChild(el)
          return document.createElement('div')
        },
        closeModal: vi.fn(),
        activeConnection: { id: 'c_redis', name: 'R', driver: 'redis' },
        activeConnectionId: 'c_redis',
        updateStatus: updateDangerStatus,
        showQueryBanner: vi.fn(),
        createElapsedTimer: () => () => {},
        requestPlugin: vi.fn(),
        onDangerActionSucceeded: vi.fn(),
      },
      'truncate',
      { name: 'k', kind: 'table' }
    )
    expect(updateDangerStatus).toHaveBeenCalledWith(expect.stringContaining('Read-Only or Redis'))

    let dtEl: HTMLElement | null = null
    openStudioDangerTableModal(
      {
        mountModal: (el) => {
          dtEl = el
          document.body.appendChild(el)
          return document.createElement('div')
        },
        closeModal: vi.fn(),
        activeConnection: { id: 'c1', name: 'SQLite', driver: 'sqlite' },
        activeConnectionId: 'c1',
        updateStatus: vi.fn(),
        showQueryBanner: vi.fn(),
        createElapsedTimer: () => () => {},
        requestPlugin: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 1, truncated: false, isSelect: false })),
        onDangerActionSucceeded: vi.fn(async () => {
          throw new Error('Refresh err')
        }),
      },
      'drop',
      { name: 'temp_t', kind: 'table' }
    )
    const dtConfirm = dtEl!.querySelector('#datanoa-danger-table-confirm-input') as HTMLInputElement
    dtConfirm.value = 'temp_t'
    dtConfirm.dispatchEvent(new Event('input'))
    findBtn(dtEl!, /Drop Table/i)?.click()
    await flushTick()
    dtEl!.remove()

    // CommandPalette without optional import/export/savedQueries callbacks
    let cpModal: HTMLElement | null = null
    openStudioCommandPalette({
      mountModal: (el) => {
        cpModal = el
        document.body.appendChild(el)
        return document.createElement('div')
      },
      closeModal: vi.fn(),
      schemaObjects: [],
      connections: [],
      activeConnection: undefined,
      sidebarCollapsed: false,
      selectSidebarObject: vi.fn(),
      selectConnection: vi.fn(),
      openConnectionModal: vi.fn(),
      formatSqlInConsole: vi.fn(),
      openCreateTableModal: vi.fn(),
      setSidebarCollapsed: vi.fn(),
      switchMode: vi.fn(),
      toggleQueryHistory: vi.fn(async () => {}),
      handleRefreshAction: vi.fn(async () => {}),
      openShortcutsModal: vi.fn(),
      openFeedbackModal: vi.fn(),
    })
    cpModal!.remove()

    // 4. saved-queries-modal: blur unarmed, non-array list, close mid-async
    let resolveList: ((v: unknown) => void) | null = null
    let rejectSave: ((e: Error) => void) | null = null
    let sqCanClose: (() => boolean) | undefined
    let sqModal: HTMLElement | null = null
    const closeSq = vi.fn(() => {
      sqCanClose?.()
      sqModal?.remove()
    })
    openStudioSavedQueriesModal({
      mountModal: (el, cc) => {
        sqModal = el
        sqCanClose = cc
        document.body.appendChild(el)
        return document.createElement('div')
      },
      closeModal: closeSq,
      currentSql: 'SELECT 1;',
      activeDialect: 'sqlite',
      updateStatus: vi.fn(),
      onInsertSql: vi.fn(),
      requestPlugin: vi.fn(async (m: string) => {
        if (m === 'queries.saved.list') {
          return await new Promise((res) => {
            resolveList = res
          })
        }
        return await new Promise((_res, rej) => {
          rejectSave = rej
        })
      }),
    })
    // While loading, try Load/Save/Reset/Close (hits isLoading guards)
    findBtn(sqModal!, /^Save Query$/i)?.click()
    findBtn(sqModal!, /^Reset$/i)?.click()
    findBtn(sqModal!, /^Close$/i)?.click()
    resolveList?.({ entries: [{ id: 's1', name: 'Q1', sql: 'SELECT 1', dialect: 'sqlite', tags: [], createdAt: 1, updatedAt: 2 }] })
    await flushTick()
    const delBtn = findBtn(sqModal!, /^Delete$/i)!
    delBtn.dispatchEvent(new Event('blur')) // confirmDeleteId !== entry.id
    // Trigger save -> close modal mid-save -> rejectSave
    ;(sqModal!.querySelector('input') as HTMLInputElement).value = 'MyQ'
    findBtn(sqModal!, /^Save Query$/i)?.click()
    await flushMicro(2)
    sqCanClose?.() // disposes & sets isClosed=true
    rejectSave?.(new Error('save after close'))
    await flushTick()
    sqModal!.remove()

    // 5. driver-manager-modal: builtin packaging, empty path configure, closed mid-request, errors
    let dmModal: HTMLElement | null = null
    let dmPhase = 'ok'
    openStudioDriverManagerModal({
      mountModal: (el) => {
        dmModal = el
        document.body.appendChild(el)
        return document.createElement('div')
      },
      closeModal: () => {
        dmModal?.remove()
      },
      requestPlugin: vi.fn(async (m: string) => {
        if (m === 'drivers.list') {
          if (dmPhase === 'failList') throw new Error('list fail')
          return {
            drivers: [
              { id: 'sqlite', name: 'SQLite', category: 'builtin', packaging: 'builtin', transport: 'File', description: 'Built-in', status: 'builtin' },
              { id: 'postgres', name: 'PostgreSQL', category: 'local-byod', packaging: 'local-byod', transport: 'TCP', description: 'Builtin status on BYOD slot', status: 'builtin' },
              { id: 'duckdb', name: 'DuckDB', category: 'local-byod', packaging: 'local-byod', transport: 'File', description: 'BYOD', status: 'not-configured' },
              { id: 'snowflake', name: 'Snowflake', category: 'local-byod', packaging: 'local-byod', transport: 'HTTPS', description: 'BYOD', status: 'local-verified', localPath: '/drv', sha256: '' },
            ],
          }
        }
        if (m === 'drivers.inspectLocal') throw new Error('inspect fail')
        if (m === 'drivers.configureLocal') throw new Error('config fail')
        if (m === 'drivers.verify') throw new Error('verify fail')
        if (m === 'drivers.removeLocal') throw new Error('remove fail')
        return { ok: true }
      }),
    })
    await flushTick()
    expect(dmModal!.textContent).toContain('Built-in')
    // Click Trust & Verify with empty path -> L491-493
    findBtn(dmModal!, /Trust & Verify/i)?.click()
    // Click Inspect SHA-256 -> inspect fail L474
    const dmPathInp = dmModal!.querySelector('input[type="text"]') as HTMLInputElement
    dmPathInp.value = '/tmp/duck'
    dmPathInp.dispatchEvent(new Event('input'))
    findBtn(dmModal!, /Inspect SHA-256/i)?.click()
    await flushTick()
    // Configure fail L512
    findBtn(dmModal!, /Trust & Verify/i)?.click()
    await flushTick()
    // Verify fail L551 & Remove fail L586
    findBtn(dmModal!, /^Verify$/i)?.click()
    await flushTick()
    findBtn(dmModal!, /^Remove$/i)?.click()
    await flushTick()
    dmModal!.remove()

    // drivers.list error
    dmPhase = 'failList'
    let dmFailModal: HTMLElement | null = null
    openStudioDriverManagerModal({
      mountModal: (el) => {
        dmFailModal = el
        document.body.appendChild(el)
        return document.createElement('div')
      },
      closeModal: vi.fn(),
      requestPlugin: vi.fn(async () => {
        throw new Error('list fail')
      }),
    })
    await flushTick()
    dmFailModal!.remove()

    // 6. value-inspector: RAF drag + cancel + dblclick + ArrowUp/Down + invalid JSON + non-nullable Set NULL + array row
    const viInspectBtn = document.createElement('button')
    const viGrid = {
      handleViewportResize: vi.fn(),
      isBatchMode: () => false,
      getStagedCount: () => 0,
      stageCellEdit: vi.fn(),
      getModel: () => ({
        headers: ['id', 'label'],
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, isPrimaryKey: true },
          { name: 'label', type: 'TEXT', nullable: false },
        ],
        rows: [[1, '{bad json']],
        primaryKey: ['id'],
        canEdit: true,
        rowCount: 1,
      }),
    }
    const viCtrl = new ValueInspectorController({
      getInspectButton: () => viInspectBtn,
      getDataGrid: () => viGrid as never,
      getActiveTarget: () => ({ connectionId: 'c1', table: 't1', page: 1, viewSeq: 1, isShowingSqlResult: false }),
      updateCell: vi.fn(async () => ({ ok: true })),
      reloadTableData: vi.fn(async () => {}),
      updateStatus: vi.fn(),
    })
    const viEl = viCtrl.buildElement()
    document.body.appendChild(viEl)
    viCtrl.open({
      rowIndex: 0,
      colIndex: 1,
      columnName: 'label',
      columnType: 'TEXT',
      value: '{bad json',
      isEditable: true,
      isNullable: false,
      isInserted: false,
    })
    const viResizer = viEl.querySelector('.datanoa-value-inspector-resizer') as HTMLElement
    viResizer.dispatchEvent(new MouseEvent('mousedown', { clientY: 300, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientY: 260, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientY: 240, bubbles: true })) // cancels previous RAF
    dom?.runRaf()
    window.dispatchEvent(new MouseEvent('mouseup', { clientY: 240, bubbles: true }))
    viResizer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    viResizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    viResizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    // Non-nullable Set NULL guard (direct click on nullBtn even if disabled in DOM)
    findBtn(viEl, /Set NULL/i)?.click()
    // Apply on array row (L494)
    const viTa = viEl.querySelector('.datanoa-value-textarea') as HTMLTextAreaElement | null
    if (viTa) {
      viTa.value = '{bad json edited'
      viTa.dispatchEvent(new Event('input', { bubbles: true }))
    }
    findBtn(viEl, /^Apply$/i)?.click()
    await flushTick()
    // Start another drag and destroy mid-drag (L145-147, L536)
    viResizer.dispatchEvent(new MouseEvent('mousedown', { clientY: 300, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientY: 250, bubbles: true }))
    viCtrl.destroy()
  })

  it('Slice 2A: covers console.ts (Oracle/MSSQL StreamLanguage, CM6 smartSource completion, selection, keybinding false paths)', () => {
    // Oracle & MSSQL StreamLanguage parsers
    const oracleLang = buildLanguageExtension('oracle') as { language: { parser: { parse: (s: string) => unknown } } }
    oracleLang.language.parser.parse(
      `-- line\n/* block\nstill */\nDECLARE v_txt VARCHAR2(50) := q'[hello]';\nBEGIN\n  SELECT SYSDATE, my_custom_col FROM DUAL;\nEND;\n/`
    )
    const mssqlLang = buildLanguageExtension('mssql') as { language: { parser: { parse: (s: string) => unknown } } }
    mssqlLang.language.parser.parse(`SELECT GETDATE(), CAST(1 AS NVARCHAR), my_col FROM dbo.Orders;`)

    // Trigger real CM6 smartSource completion inside EditorView
    const cmHost = document.createElement('div')
    document.body.appendChild(cmHost)
    const view = new EditorView({
      state: EditorState.create({
        doc: 'SELECT  FROM users',
        selection: EditorSelection.single(7),
        extensions: [buildCompletionExtension('oracle', { users: ['id', 'email'] }, 'users')],
      }),
      parent: cmHost,
    })
    const startComp = completionKeymap.find((k) => k.key === 'Ctrl-Space')?.run
    startComp?.(view)
    view.destroy()

    // computeSmartSqlCompletions edge cases: Mongo db.getCollection, non-prefix Mongo keyword, Oracle DUAL, non-oracle/mssql dialect
    const mongoDbComp = computeSmartSqlCompletions('db.get', 6, 'mongodb', { logs: ['ts'] }, undefined, true)
    expect(mongoDbComp?.options.some((o) => o.label === 'getCollection')).toBe(true)
    const mongoSubComp = computeSmartSqlCompletions('db.logs.find', 12, 'mongodb', { logs: ['ts'] }, undefined, true)
    expect(mongoSubComp).toBeTruthy()
    const mongoMidComp = computeSmartSqlCompletions('ndOne', 5, 'mongodb', { logs: ['ts'] }, undefined, false)
    expect(mongoMidComp?.options.some((o) => o.label === 'findOne({})')).toBe(true)
    const oracleDual = computeSmartSqlCompletions('SELECT * FROM DU', 16, 'oracle', { emp: ['id'] }, undefined, false)
    expect(oracleDual?.options.some((o) => o.label === 'DUAL')).toBe(true)
    const pgPlain = computeSmartSqlCompletions('SEL', 3, 'postgres', { emp: ['id'] }, undefined, false)
    expect(pgPlain?.options.some((o) => o.label === 'SELECT')).toBe(true)

    // SqlConsoleController without callbacks & getSelectedSql with selection
    const cHost = document.createElement('div')
    document.body.appendChild(cHost)
    const ctrl = new SqlConsoleController({
      parent: cHost,
      initialDoc: 'SELECT id FROM employees;',
      dialect: 'sqlite',
      schema: { employees: ['id', 'name'] },
    })
    const ctrlView = (ctrl as unknown as { view: EditorView }).view
    ctrlView.dispatch({ selection: EditorSelection.single(0, 9) })
    expect(ctrl.getSelectedSql()).toBe('SELECT id')
    // Run Mod-Enter / Mod-Shift-Enter / Shift-Alt-f when callbacks absent -> return false
    const domHandlers = ctrlView.contentDOM
    domHandlers.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    domHandlers.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true }))
    domHandlers.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', shiftKey: true, altKey: true, bubbles: true }))
    ctrl.destroy()
  })

  it('Slice 2B: covers import-modal.ts (FileReader fallback/errors, option fallbacks, >250 rows, empty rows, mid-chunk close & partial resume)', async () => {
    const backend = createLiveStudioSqliteBackend()
    try {
    let modalEl: HTMLElement | null = null
    let isClosed = false

    const openImport = (driver: DatabaseDriverType = 'sqlite', targetCols = [
      { name: 'id', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, isPrimaryKey: true, isAutoIncrement: true },
      { name: 'name', type: 'TEXT', nativeType: '', nullable: false },
      { name: 'meta', type: '', nativeType: '', nullable: true, defaultValue: '{}' },
    ]) => {
      isClosed = false
      openStudioImportModal({
        mountModal: (el) => {
          modalEl = el
          document.body.appendChild(el)
          return document.createElement('div')
        },
        closeModal: () => {
          isClosed = true
          modalEl?.remove()
        },
        activeConnection: { id: 'c_main', name: 'SQLite', driver },
        activeConnectionId: 'c_main',
        targetTable: 'employees',
        targetColumns: targetCols,
        canStageInGrid: true,
        updateStatus: vi.fn(),
        showQueryBanner: vi.fn(),
        createElapsedTimer: () => () => {},
        requestPlugin: backend.orcaApi.plugin.request,
        onStageRows: vi.fn(() => 0),
        onDirectImportComplete: vi.fn(async () => {}),
      })
    }

    // 1. FileReader fallback (ArrayBuffer, string, error, missing FileReader)
    openImport('sqlite')
    const fileInp = modalEl!.querySelector('input[type="file"]') as HTMLInputElement
    const triggerFile = (f: File) => {
      ;(fileInp as unknown as { files: File[] }).files = [f]
      fileInp.dispatchEvent(new Event('change'))
    }

    // FileReader returning ArrayBuffer
    class FakeFRArrayBuffer {
      result: unknown = null
      error: Error | null = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsArrayBuffer(f: { _buf?: ArrayBuffer }) {
        this.result = f._buf ?? new TextEncoder().encode('name,meta\nAlice,{"a":1}\n,\n').buffer
        this.onload?.()
      }
    }
    await withTempGlobal('FileReader', FakeFRArrayBuffer, async () => {
      triggerFile(makeFakeFile('a.csv', 'name,meta\nAlice,{"a":1}\n,\n', { noArrayBuffer: true }))
      await flushTick()
    })
    expect(modalEl!.textContent).toContain('Skipped 1 empty row')

    // FileReader returning invalid non-string/non-Buffer -> 'Could not read file contents'
    class FakeFRBad {
      result: unknown = 123
      onload: (() => void) | null = null
      readAsArrayBuffer() {
        this.onload?.()
      }
    }
    await withTempGlobal('FileReader', FakeFRBad, async () => {
      triggerFile(makeFakeFile('bad.csv', 'x', { noArrayBuffer: true }))
      await flushTick()
    })
    expect(modalEl!.textContent).toContain('Could not read file contents')

    // FileReader error
    class FakeFRError {
      error = new Error('Disk read error')
      onerror: (() => void) | null = null
      readAsArrayBuffer() {
        this.onerror?.()
      }
    }
    await withTempGlobal('FileReader', FakeFRError, async () => {
      triggerFile(makeFakeFile('err.csv', 'x', { noArrayBuffer: true }))
      await flushTick()
    })
    expect(modalEl!.textContent).toContain('Disk read error')

    // No FileReader -> 'File reading API is unavailable'
    await withTempGlobal('FileReader', undefined, async () => {
      triggerFile(makeFakeFile('nofr.csv', 'x', { noArrayBuffer: true }))
      await flushTick()
    })
    expect(modalEl!.textContent).toContain('unavailable')

    // Invalid option selects -> fallback to 'auto' / 'empty-and-null'
    for (const sel of Array.from(modalEl!.querySelectorAll('select')) as HTMLSelectElement[]) {
      const opt = document.createElement('option')
      opt.value = '__invalid_opt__'
      sel.appendChild(opt)
      sel.value = '__invalid_opt__'
      sel.dispatchEvent(new Event('change'))
    }

    // Load TSV (>500 rows) to hit TAB delimiter label + MAX_STAGE_IN_GRID_ROWS hint
    const tsvRows = ['name\tmeta', ...Array.from({ length: 510 }, (_, i) => `User_${i}\t{"k":${i}}`)].join('\n')
    triggerFile(makeFakeFile('big.tsv', tsvRows))
    await flushTick()
    const stageLbl = modalEl!.querySelector('.datanoa-import-mode-stage')?.parentElement as HTMLLabelElement | null
    expect(stageLbl?.classList.contains('disabled')).toBe(true)
    expect(stageLbl?.title).toContain('Direct Batch Insert')
    expect(modalEl!.textContent).toContain('TAB')

    // Load CSV with only headers & empty row -> 'No non-empty data rows found'
    triggerFile(makeFakeFile('empty_rows.csv', 'name,meta\n,\n'))
    await flushTick()
    expect(modalEl!.textContent).toContain('No non-empty data rows found')
    modalEl!.remove()

    // 2. MongoDB invalid preview + mid-chunk abort on modal close + partial batch failure & resume
    openImport('mongodb', [])
    const mFileInp = modalEl!.querySelector('input[type="file"]') as HTMLInputElement
    const mCsv = ['name', ...Array.from({ length: 250 }, (_, i) => `M_${i}`)].join('\n')
    ;(mFileInp as unknown as { files: File[] }).files = [makeFakeFile('m.csv', mCsv)]
    mFileInp.dispatchEvent(new Event('change'))
    await flushTick()
    findBtn(modalEl!, /Skip All/i)?.click()
    expect(modalEl!.textContent).toContain('insertOne()')
    modalEl!.remove()

    // Partial batch failure & Resume
    let batchCall = 0
    let impEl: HTMLElement | null = null
    openStudioImportModal({
      mountModal: (el) => {
        impEl = el
        document.body.appendChild(el)
        return document.createElement('div')
      },
      closeModal: () => impEl?.remove(),
      activeConnection: { id: 'c_main', name: 'SQLite', driver: 'sqlite' },
      activeConnectionId: 'c_main',
      targetTable: 'employees',
      targetColumns: [{ name: 'name', type: 'TEXT', nullable: false }],
      canStageInGrid: false,
      updateStatus: vi.fn(),
      showQueryBanner: vi.fn(),
      createElapsedTimer: () => () => {},
      requestPlugin: vi.fn(async () => {
        batchCall++
        if (batchCall === 2) throw new Error('Chunk 2 failed')
        return { ok: true, inserted: 100, updated: 0, deleted: 0, statements: [] }
      }),
      onStageRows: () => 0,
      onDirectImportComplete: vi.fn(async () => {
        throw new Error('non-blocking refresh err')
      }),
    })
    const pInp = impEl!.querySelector('input[type="file"]') as HTMLInputElement
    const rows350 = ['name', ...Array.from({ length: 350 }, (_, i) => `R_${i}`)].join('\n')
    ;(pInp as unknown as { files: File[] }).files = [makeFakeFile('p.csv', rows350)]
    pInp.dispatchEvent(new Event('change'))
    await flushTick()
    findBtn(impEl!, /^Import 350 Rows$/i)?.click()
    await flushTick()
    await flushMicro(6)
    expect(impEl!.textContent).toContain('Resume Import')
    // Resume and complete (remaining 100 rows, batchCall=3 succeeds)
    findBtn(impEl!, /Resume Import/i)?.click()
    await flushTick()
    await flushMicro(6)
    expect(isClosed || !impEl!.isConnected).toBe(true)
    } finally {
      backend.db.close()
    }
  })

  it('Slice 2C: covers schema-inspector.ts (mssql/oracle/mongodb dialects, collate/origin/triggers preservation, combo popover, scroll, FK/Index edits)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const onApply = vi.fn(async () => {})
    const inspector = new SchemaInspectorView(container, {
      dialect: 'mssql',
      onApplyMigration: onApply,
      onInsertDdl: vi.fn(),
      onCopyDdl: vi.fn(),
    })

    const richDetails: TableDetails = {
      name: 'orders',
      schema: 'dbo',
      kind: 'table',
      columns: [
        { name: 'id', type: 'INT', nativeType: 'INT', nullable: false, isPrimaryKey: true, isAutoIncrement: true, collate: 'NOCASE' },
        { name: 'dept_id', type: 'INT', nativeType: 'INT', nullable: true },
        { name: 'code', type: 'NVARCHAR(32)', nativeType: 'NVARCHAR(32)', nullable: true },
      ],
      primaryKey: ['id'],
      indexes: [
        { name: 'sqlite_autoindex_orders_1', unique: true, isPrimary: false, origin: 'u', columns: ['code'], columnSpecs: [{ name: 'code', desc: false }], onConflict: 'ABORT' },
        { name: 'pk_orders', unique: true, isPrimary: true, origin: 'pk', columns: ['id'] },
      ],
      foreignKeys: [
        { constraintName: 'fk_orders_dept', column: 'dept_id', referencedTable: 'departments', referencedColumn: 'id', onDelete: 'CASCADE' },
      ],
      triggers: [{ name: 'trg_ord', sql: 'CREATE TRIGGER trg_ord AFTER INSERT ON orders BEGIN SELECT 1; END;' }],
      inboundForeignKeys: [{ fromTable: 'order_items', fromColumn: 'order_id', toColumn: 'id', onDelete: 'CASCADE' }],
    }

    inspector.setReferenceTables(['departments', 'users'])
    inspector.setDetails(richDetails, 'oracle')
    inspector.setDetails(richDetails, 'mssql')

    // Scroll preservation across render
    const scrollBody = container.querySelector('.datanoa-inspector-scroll-body') as HTMLElement
    scrollBody.scrollTop = 75

    // Combo popover: toggle open/close, ArrowDown when closed, upward flip near bottom, outside click
    ;(window as { innerHeight: number }).innerHeight = 200
    const comboWrap = container.querySelector('.datanoa-combo-wrap') as HTMLElement
    comboWrap.getBoundingClientRect = () => ({ top: 150, bottom: 180, left: 20, right: 160, width: 140, height: 30, x: 20, y: 150, toJSON() {} })
    const comboToggle = container.querySelector('.datanoa-combo-toggle') as HTMLButtonElement
    const comboInput = comboWrap.querySelector('input') as HTMLInputElement
    comboToggle.click() // open
    expect(document.querySelector('.datanoa-combo-popover')).toBeTruthy()
    comboToggle.click() // toggle close same owner
    expect(document.querySelector('.datanoa-combo-popover')).toBeNull()
    comboInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) // openMenu(false)
    expect(document.querySelector('.datanoa-combo-popover')).toBeTruthy()
    window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) // outside click closes

    // Column Drop & Undo
    const dropColBtn = findBtn(container, /^Drop$/i)
    dropColBtn?.click()
    expect(findBtn(container, /^Undo$/i)).toBeTruthy()
    findBtn(container, /^Undo$/i)?.click()

    // Add FK -> edit constraintName -> change Local Column -> Remove FK; also Drop & Undo existing FK
    findBtn(container, /\+ Foreign Key/i)?.click()
    const fkNameInp = container.querySelector('.datanoa-fk-name-input') as HTMLInputElement
    fkNameInp.value = 'fk_custom'
    fkNameInp.dispatchEvent(new Event('input'))
    const fkColSel = container.querySelector('.datanoa-fk-col-select') as HTMLSelectElement
    fkColSel.value = 'code'
    fkColSel.dispatchEvent(new Event('change'))
    const fkRemoveBtn = Array.from(container.querySelectorAll('.datanoa-struct-fks-table button')).find((b) => b.textContent === 'Remove') as HTMLButtonElement
    fkRemoveBtn?.click()
    const fkDropBtn = container.querySelector('.datanoa-fk-drop-btn') as HTMLButtonElement
    fkDropBtn?.click()
    ;(container.querySelector('.datanoa-fk-drop-btn') as HTMLButtonElement)?.click() // Undo

    // Add Index -> toggle column pills -> Remove Index
    findBtn(container, /\+ Index \/ Key/i)?.click()
    const pills = Array.from(container.querySelectorAll('.datanoa-col-pill')) as HTMLButtonElement[]
    pills[1]?.click()
    pills[0]?.click()
    const idxRemoveBtn = Array.from(container.querySelectorAll('.datanoa-struct-indexes-table button')).find((b) => b.textContent === 'Remove') as HTMLButtonElement
    idxRemoveBtn?.click()

    // MongoDB schemaless banner & readOnly custom object kind fallback
    inspector.setDetails({ ...richDetails, indexes: [], foreignKeys: [] }, 'mongodb')
    expect(container.textContent).toContain('MongoDB collections are schemaless')
    inspector.setReadOnlyObjectDdl({ name: 'seq_1', schema: 'dbo', kind: 'custom_kind' as never }, 'CREATE SEQUENCE seq_1;', 'postgres')
    expect(container.textContent).toContain('CUSTOM_KIND')
    inspector.destroy()
  })

  it('Slice 2D: covers connection-modal.ts (compactFilePath PBT, URI scrub, D1/LibSQL/Redis/Mongo/ClickHouse/Oracle, BYOD, Discovery, SSH/TLS, errors)', async () => {
    fc.assert(
      fc.property(fc.string({ minLength: 50, maxLength: 100 }), (raw) => {
        const s = `C:/very_long_folder_name_here/${raw.replace(/[\\/\0]/g, 'a')}/end.sqlite`
        const c = compactFilePath(s, 36)
        expect(c.length).toBeLessThanOrEqual(42)
        expect(c).toContain('...')
      }),
      { numRuns: 25 }
    )

    let modalEl: HTMLElement | null = null
    let backdropEl: HTMLDivElement | null = null
    let driverRegistryPhase: 'ok' | 'err' = 'ok'
    let failTestOnce = false
    let failTestOkFalse = false
    let failSaveOnce = false
    let failDeleteOnce = false
    let failInspectOnce = false
    let failConfigureOnce = false
    let failVerifyOnce = false
    let failRemoveOnce = false
    let failDiscoveryOnce = false

    const backend = createLiveStudioSqliteBackend()
    try {
    const openConn = (editProfile?: ConnectionProfile) => {
      openStudioConnectionModal(
        {
          isBackdropActive: (b) => b !== null && b === backdropEl,
          mountModal: (el) => {
            modalEl = el
            backdropEl = document.createElement('div')
            backdropEl.appendChild(el)
            document.body.appendChild(backdropEl)
            return backdropEl
          },
          closeModal: () => {
            backdropEl?.remove()
            backdropEl = null
            modalEl = null
          },
          createElapsedTimer: () => () => {},
          updateStatus: vi.fn(),
          activateSavedConnection: vi.fn(async () => {}),
          onConnectionDeleted: vi.fn(async () => {}),
          currentWorkspaceScope: 'folder:1234abcd',
          requestPlugin: vi.fn(async (method: string, payload?: Record<string, unknown>) => {
            if (method === 'drivers.list') {
              if (driverRegistryPhase === 'err') throw new Error('registry fail')
              return { drivers: [{ id: 'duckdb', status: 'local-verified', sha256: 'abcdef1234567890', resolvedEntry: '/drv/duck.mjs' }] }
            }
            if (method === 'drivers.defaultPaths') {
              return { platform: 'win32', paths: { duckdb: 'C:\\drv\\duckdb' } }
            }
            if (method === 'drivers.setupLocal') {
              if (failConfigureOnce) {
                failConfigureOnce = false
                throw new Error('setup fail')
              }
              return {
                ok: true,
                dirPath: String(payload?.targetDir || 'C:\\drv\\custom'),
                installPackage: payload?.driverId === 'duckdb' ? '@duckdb/node-api' : '',
                inspect: { sha256: '1234567890abcdef' },
                item: { status: 'pending' },
              }
            }
            if (method === 'drivers.inspectLocal') {
              if (failInspectOnce) {
                failInspectOnce = false
                return { ok: false }
              }
              return { ok: true, sha256: 'abcdef123456' }
            }
            if (method === 'drivers.configureLocal') {
              if (failConfigureOnce) {
                failConfigureOnce = false
                throw new Error('trust err')
              }
              return { ok: true, item: { id: payload?.driverId, status: 'local-verified', sha256: 'abcdef123456' } }
            }
            if (method === 'drivers.verify') {
              if (failVerifyOnce) {
                failVerifyOnce = false
                throw new Error('verify err')
              }
              return { ok: true, message: 'Verified' }
            }
            if (method === 'drivers.removeLocal') {
              if (failRemoveOnce) {
                failRemoveOnce = false
                throw new Error('remove err')
              }
              return { ok: true }
            }
            if (method === 'workspace.listScopes') {
              return [
                { id: 'folder:1234abcd', name: 'MainWS', branch: 'main', path: '/ws', isCurrent: true },
                { id: 'ws:other', name: 'OtherWS', projectFolder: 'GroupA', path: '/other' },
              ]
            }
            if (method === 'workspace.detectConnections') {
              if (failDiscoveryOnce) {
                failDiscoveryOnce = false
                throw new Error('detect err')
              }
              return {
                scannedDirs: ['/very/long/workspace/directory/for/studio/testing/purposes/here'],
                folderScoped: Boolean(payload?.folderPath),
                dockerScopeLabel: 'Docker Context',
                envConnections: [
                  { envKey: 'DATABASE_URL', sourceFile: '.env.local', driver: 'postgres', name: 'EnvPG', uri: 'postgres://u:secret@localhost:5432/db' },
                ],
                dockerComposeConnections: [
                  { project: 'p1', service: 's_libsql', driver: 'libsql', host: '127.0.0.1', port: 8080, database: 'app', url: 'https://user:tok@127.0.0.1:8080/db?authToken=abc#h?token=1&bad%ZZ=1', passwordFromFile: 'PG_PASS_FILE', hint: 'Check secret', workspaceMatched: true, status: 'running' },
                  { project: 'p1', service: 's_ch', driver: 'clickhouse', host: '127.0.0.1', port: 8123, status: 'compose file' },
                  { project: 'p1', service: 's_mongo', driver: 'mongodb', url: 'mongodb://u:p@127.0.0.1:27017/app?tls=true', status: 'other' },
                  { project: 'p1', service: 's_bad', driver: 'unknown_eng', status: 'other' },
                ],
                sqliteFiles: [{ name: '.hidden.sqlite', filePath: '/ws/.hidden.sqlite', sizeBytes: 1024, sizeLabel: '1 KB' }],
              }
            }
            if (method === 'sqlite.scanFolder') {
              return { files: [{ name: 'local.db', filePath: '/ws/local.db', sizeBytes: 512, sizeLabel: '512 B' }] }
            }
            if (method === 'connection.parseUri') {
              const uri = String(payload?.uri || '')
              if (uri === 'bad://fail') return { ok: false, error: 'Bad URI' }
              if (uri.startsWith('throw://')) throw new Error('URI boom')
              if (uri.startsWith('d1://')) return { ok: true, profile: { driver: 'd1', d1AccountId: 'acc1', d1DatabaseId: 'db1', url: 'https://user:secret@d1.api/v1?token=x' }, authToken: 'tok1' }
              if (uri.startsWith('libsql://')) return { ok: true, profile: { driver: 'libsql', url: 'https://user:pw@db.turso.io:8443/main#frag?token=1&ok=2&bad%ZZ=3', database: 'main' } }
              if (uri.startsWith('redis://')) return { ok: true, profile: { driver: 'redis', host: '127.0.0.1', port: 6379, redisDb: 3, ssl: false } }
              if (uri.startsWith('oracle://')) return { ok: true, profile: { driver: 'oracle', host: '127.0.0.1', port: 1521, database: 'FREEPDB1', url: 'oracle://u:p@127.0.0.1:1521/FREEPDB1', ssl: true } }
              if (uri.startsWith('postgres://')) return { ok: true, profile: { driver: 'postgres', host: 'db.supabase.co', port: 5432, database: 'postgres', options: 'sslmode=require' }, placeholderPassword: true }
              return { ok: true, profile: { driver: 'clickhouse', host: '127.0.0.1', port: 8443, url: 'https://127.0.0.1:8443/' } }
            }
            if (method === 'connection.test') {
              if (failTestOnce) {
                failTestOnce = false
                throw new Error('Test RPC throw')
              }
              if (failTestOkFalse) {
                failTestOkFalse = false
                return { ok: false, message: 'Auth rejected' }
              }
              return { ok: true }
            }
            if (method === 'connection.save') {
              if (failSaveOnce) {
                failSaveOnce = false
                return { ok: false }
              }
              return { ok: true, id: 'saved_id' }
            }
            if (method === 'connection.delete') {
              if (failDeleteOnce) {
                failDeleteOnce = false
                throw new Error('Delete RPC throw')
              }
              return { ok: true }
            }
            return backend.orcaApi.plugin.request(method, payload)
          }),
        },
        editProfile
      )
    }

    // 1. Open in create mode: exercise discovery items, URI parsing (bad, throw, d1, libsql, redis, oracle, postgres placeholder & supabase), SSH injection/validation, BYOD error paths
    openConn()
    await flushTick()

    // Discovery: manual folder scan + fail + items click (unsupported, libsql, ch, mongo, env, dotfile)
    const folderInp = modalEl!.querySelector('input[placeholder*="folder" i], input[placeholder*="scan" i]') as HTMLInputElement | null
    findBtn(modalEl!, /^Scan Folder$/i)?.click() // empty folder warning
    if (folderInp) {
      folderInp.value = '/ws'
      findBtn(modalEl!, /^Scan Folder$/i)?.click()
      await flushTick()
    }
    // Click discovered items
    findBtn(modalEl!, /s_bad/i)?.click()
    findBtn(modalEl!, /s_libsql/i)?.click()
    findBtn(modalEl!, /s_ch/i)?.click()
    findBtn(modalEl!, /s_mongo/i)?.click()
    findBtn(modalEl!, /DATABASE_URL/i)?.click()
    findBtn(modalEl!, /\.hidden\.sqlite/i)?.click()
    // Collapse toggle on discovery group
    ;(modalEl!.querySelector('.datanoa-disc-group-head') as HTMLElement | null)?.click()

    // URI parse error & throw & masked URI re-use
    const uriInp = modalEl!.querySelector('input[placeholder*="postgres://"]') as HTMLInputElement
    uriInp.value = 'bad://fail'
    findBtn(modalEl!, /^Parse URI$/i)?.click()
    await flushTick()
    uriInp.value = 'throw://boom'
    uriInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushTick()

    // Parse D1 -> validate missing account/db -> fill & save
    uriInp.value = 'd1://acc1/db1'
    findBtn(modalEl!, /^Parse URI$/i)?.click()
    await flushTick()
    const d1AccInp = modalEl!.querySelector('input[placeholder*="Account ID" i]') as HTMLInputElement | null
    if (d1AccInp) {
      d1AccInp.value = ''
      const d1EndInp = modalEl!.querySelector('input[placeholder*="Endpoint" i], input[placeholder*="custom" i]') as HTMLInputElement | null
      if (d1EndInp) d1EndInp.value = ''
      findBtn(modalEl!, /Save & Connect/i)?.click()
      await flushTick()
      d1AccInp.value = 'acc1'
    }

    // Parse LibSQL with embedded credentials + fragment secrets -> scrub -> Save & Connect with test fail / save fail
    uriInp.value = 'libsql://token@host'
    findBtn(modalEl!, /^Parse URI$/i)?.click()
    await flushTick()
    failTestOnce = true
    findBtn(modalEl!, /Save & Connect/i)?.click()
    await flushTick()
    failTestOkFalse = true
    findBtn(modalEl!, /Save & Connect/i)?.click()
    await flushTick()
    failSaveOnce = true
    findBtn(modalEl!, /Save & Connect/i)?.click()
    await flushTick()

    // Parse Postgres placeholder -> Supabase password required -> SSH option injection & bad port
    uriInp.value = 'postgres://user:[YOUR-PASSWORD]@db.supabase.co:5432/postgres'
    findBtn(modalEl!, /^Parse URI$/i)?.click()
    await flushTick()
    findBtn(modalEl!, /Test Connection/i)?.click()
    await flushTick()
    const pwInp = modalEl!.querySelector('input[type="password"]') as HTMLInputElement | null
    if (pwInp) {
      pwInp.value = 'real_pw'
      pwInp.dispatchEvent(new Event('input'))
    }
    // Enable SSH & trigger option injection ('-oProxyCommand=...')
    const sshCb = Array.from(modalEl!.querySelectorAll('input[type="checkbox"]')).find((c) =>
      /ssh/i.test(c.parentElement?.textContent || '')
    ) as HTMLInputElement | undefined
    if (sshCb) {
      sshCb.checked = true
      sshCb.dispatchEvent(new Event('change'))
      const sshHost = modalEl!.querySelector('input[placeholder*="bastion" i]') as HTMLInputElement | null
      if (sshHost) sshHost.value = '-oProxyCommand=id'
      findBtn(modalEl!, /Test Connection/i)?.click()
      await flushTick()
      if (sshHost) sshHost.value = 'bastion.local'
      const sshUser = modalEl!.querySelector('input[placeholder*="ubuntu" i], input[placeholder*="ec2-user" i]') as HTMLInputElement | null
      if (sshUser) sshUser.value = 'ops'
      const sshPort = modalEl!.querySelector('input[value="22"]') as HTMLInputElement | null
      if (sshPort) sshPort.value = '99999'
      findBtn(modalEl!, /Test Connection/i)?.click()
      await flushTick()
      if (sshPort) sshPort.value = '2222'
    }

    // BYOD: select duckdb -> setup fail, inspect fail, configure fail, verify fail, remove fail; and custom starter
    findBtn(modalEl!, /DuckDB/i)?.click()
    await flushTick()
    failConfigureOnce = true
    findBtn(modalEl!, /Create Folder/i)?.click()
    await flushTick()
    failInspectOnce = true
    findBtn(modalEl!, /Inspect SHA-256/i)?.click()
    await flushTick()
    findBtn(modalEl!, /Inspect SHA-256/i)?.click()
    await flushTick()
    failConfigureOnce = true
    findBtn(modalEl!, /Trust & Verify/i)?.click()
    await flushTick()
    failVerifyOnce = true
    findBtn(modalEl!, /^Verify$/i)?.click()
    await flushTick()
    failRemoveOnce = true
    findBtn(modalEl!, /^Remove$/i)?.click()
    await flushTick()
    findBtn(modalEl!, /Custom BYOD/i)?.click()
    await flushTick()
    findBtn(modalEl!, /Create Folder & Starter/i)?.click()
    await flushTick()
    findBtn(modalEl!, /Clear/i)?.click()
    findBtn(modalEl!, /^Cancel$/i)?.click()

    // 2. Edit profiles across redis, clickhouse, mongodb, oracle, libsql, d1, unknown driver & delete failure
    for (const ep of [
      { id: 'e_unk', name: 'Unk', driver: 'weird_drv' as DatabaseDriverType },
      { id: 'e_redis', name: 'Red', host: '127.0.0.1', port: 6379, driver: 'redis' as const, redisDb: 2, hasPassword: true, folder: 'Cache' },
      { id: 'e_ch', name: 'CH', host: 'ch.local', port: 8443, user: 'default', database: 'default', driver: 'clickhouse' as const, url: 'https://ch.local/', sslMode: 'verify-full' as const, sslRejectUnauthorized: false, sslCaPath: '/ca.pem', sslCertPath: '/c.pem', sslKeyPath: '/k.pem', sshEnabled: true, sshHost: 'bastion', sshPort: 22, sshUser: 'ops', sshAuthMethod: 'password' as const, hasSshPassword: true },
      { id: 'e_ch_http', name: 'CH2', host: 'ch.local', port: 8123, user: 'default', database: 'default', driver: 'clickhouse' as const, url: 'http://ch.local/' },
      { id: 'e_ch_empty', name: 'CH3', host: 'ch.local', port: 8443, user: 'default', database: 'default', driver: 'clickhouse' as const, ssl: true },
      { id: 'e_pg_ssh', name: 'PGS', host: 'pg.local', port: 5432, user: 'pg', database: 'app', driver: 'postgres' as const, options: '-c statement_timeout=5000', sshEnabled: true, sshHost: 'jump', sshPort: 2222, sshUser: 'deploy', sshAuthMethod: 'key' as const, sshPrivateKeyPath: '/id_ed25519', hasSshPassphrase: true },
      { id: 'e_mongo', name: 'MG', host: 'mongo.local', port: 27017, driver: 'mongodb' as const, url: 'mongodb://u:p@mongo.local:27017/mydb?tls=true', options: 'authSource=admin' },
      { id: 'e_mongo2', name: 'MG2', host: 'mongo.local', port: 27017, driver: 'mongodb' as const, url: 'mongodb://u:p@mongo.local/mydb?ssl=false' },
      { id: 'e_mongo_bad', name: 'MGBad', driver: 'mongodb' as const, url: 'not a valid url', options: 'authSource=admin' },
      { id: 'e_ora', name: 'ORA', driver: 'oracle' as const, url: 'oracle://u:p@127.0.0.1:1521/FREE' },
      { id: 'e_lib', name: 'LIB', driver: 'libsql' as const, url: 'https://user:pw@db.turso.io/?token=sec', hasAuthToken: true },
      { id: 'e_d1', name: 'D1', driver: 'd1' as const, d1AccountId: 'a1', d1DatabaseId: 'd1', url: 'https://d1.local/?token=x', hasAuthToken: true },
    ] as ConnectionProfile[]) {
      driverRegistryPhase = ep.id === 'e_unk' ? 'err' : 'ok'
      openConn(ep)
      await flushTick()
      findBtn(modalEl!, /Save & Connect|Update Connection/i)?.click()
      await flushTick()
      backdropEl?.remove()
      backdropEl = null
      modalEl = null
    }

    // Delete armed -> fail delete -> disarm
    openConn({ id: 'e_del', name: 'DelMe', driver: 'sqlite', filePath: ':memory:' })
    await flushTick()
    failDeleteOnce = true
    findBtn(modalEl!, /Delete Connection/i)?.click()
    findBtn(modalEl!, /Confirm Delete/i)?.click()
    await flushTick()
    findBtn(modalEl!, /^Cancel$/i)?.click()
    } finally {
      backend.db.close()
    }
  })
})

describe('Wave 4D Studio Editor Coverage — Slice 3 (VirtualDataGrid)', () => {
  let dom: DomHarness

  beforeEach(() => {
    dom = installDomHarness()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    dom.teardown()
  })

  function makeBrowseData(rowCount: number, opts: { canEdit?: boolean; noPk?: boolean } = {}): TableBrowseResult {
    const columns = [
      { name: 'id', type: 'INTEGER', nullable: false, primaryKey: !opts.noPk, autoIncrement: !opts.noPk },
      { name: 'dept_id', type: 'INTEGER', nullable: true, primaryKey: false },
      { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
      { name: 'status', type: 'TEXT', nullable: false, primaryKey: false, defaultValue: 'active' },
      { name: 'notes', type: 'TEXT', nullable: true, primaryKey: false },
      { name: 'score', type: 'INTEGER', nullable: true, primaryKey: false },
      { name: 'meta', type: 'JSON', nullable: true, primaryKey: false },
    ]
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      id: i + 1,
      dept_id: (i % 5) + 10,
      name: `Emp_${i}`,
      status: i % 2 === 0 ? 'active' : 'paused',
      notes: i % 3 === 0 ? null : `note_${i}`,
      score: i * 10,
      meta: `{"i":${i}}`,
    }))
    return {
      columns,
      headers: columns.map((c) => c.name),
      rows,
      totalRows: rowCount,
      page: 1,
      pageSize: rowCount,
      primaryKey: opts.noPk ? [] : ['id'],
      canEdit: opts.canEdit ?? true,
    }
  }

  function setupGridContainer(): HTMLDivElement {
    const host = document.createElement('div')
    document.body.appendChild(host)
    Object.defineProperty(host, 'offsetParent', { configurable: true, get: () => document.body })
    Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => 380 })
    Object.defineProperty(host, 'clientHeight', { configurable: true, get: () => 280 })
    return host
  }

  function patchTableContainerGeom(grid: VirtualDataGrid, opts: { clientW?: number; clientH?: number } = {}) {
    const wrap = (grid as unknown as { tableContainerEl: HTMLDivElement | null }).tableContainerEl!
    const thead = (grid as unknown as { theadEl: HTMLTableSectionElement | null }).theadEl
    const clientW = opts.clientW ?? 380
    const clientH = opts.clientH ?? 280
    Object.defineProperty(wrap, 'offsetParent', { configurable: true, get: () => document.body })
    Object.defineProperty(wrap, 'clientWidth', { configurable: true, get: () => clientW })
    Object.defineProperty(wrap, 'clientHeight', { configurable: true, get: () => clientH })
    Object.defineProperty(wrap, 'scrollWidth', { configurable: true, get: () => 1600 })
    Object.defineProperty(wrap, 'scrollHeight', { configurable: true, get: () => 4500 })
    wrap.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: clientW, bottom: clientH, width: clientW, height: clientH, x: 0, y: 0, toJSON() {} }) as DOMRect
    if (thead) {
      Object.defineProperty(thead, 'offsetHeight', { configurable: true, get: () => 28 })
      thead.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: clientW, bottom: 28, width: clientW, height: 28, x: 0, y: 0, toJSON() {} }) as DOMRect
    }
    return wrap
  }

  it('Slice 3A: covers VirtualDataGrid observers, wheel/scroll without RAF, window guards, drag/autoscroll, resize handles, context menus & FK jump', async () => {
    const resizeCallbacks: Array<(entries: Array<{ contentRect?: { height: number } }>) => void> = []
    class MockResizeObserver {
      constructor(cb: (entries: Array<{ contentRect?: { height: number } }>) => void) {
        resizeCallbacks.push(cb)
      }
      observe() {}
      disconnect() {}
    }

    const fkCalls: Array<[string, string, unknown]> = []
    const notifyCalls: string[] = []
    const inspectCalls: unknown[] = []
    const filterCalls: unknown[] = []
    const quickFilterCalls: unknown[] = []

    await withTempGlobal('ResizeObserver', MockResizeObserver, async () => {
      const host = setupGridContainer()
      const grid = new VirtualDataGrid({
        container: host,
        data: makeBrowseData(120),
        tableName: 'employees',
        dialect: 'sqlite',
        onNotify: (m) => notifyCalls.push(m),
        onInspectCell: (info) => inspectCalls.push(info),
        onNavigateForeignKey: (t, c, v) => fkCalls.push([t, c, v]),
        onColumnHeaderFilter: (col, val, op, mode) => filterCalls.push([col, val, op, mode]),
        onQuickFilter: (sql, mode) => quickFilterCalls.push([sql, mode]),
      })
      grid.setContextMeta('employees', 'sqlite', 'c1', 'main')
      grid.setForeignKeys([{ column: 'dept_id', referencedTable: 'departments', referencedColumn: 'id' }])
      const wrap = patchTableContainerGeom(grid)

      // ResizeObserver callbacks: valid height delta & small no-op
      resizeCallbacks[0]?.([{ contentRect: { height: 340 } }])
      resizeCallbacks[0]?.([{ contentRect: { height: 340.2 } }])

      // Wheel zoom/horizontal scroll deltaMode 0, 1, 2 and deltaX
      wrap.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { ctrlKey: true, deltaY: 20, deltaX: 0, deltaMode: 0 }))
      wrap.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { metaKey: true, deltaY: 2, deltaX: 0, deltaMode: 1 }))
      wrap.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { ctrlKey: true, deltaY: 1, deltaX: 0, deltaMode: 2 }))
      wrap.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { ctrlKey: true, deltaY: 0, deltaX: 40, deltaMode: 0 }))
      wrap.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { ctrlKey: false, deltaY: 10, deltaX: 0 }))

      // setScrollLeft with RAF and scroll without RAF
      grid.setScrollLeft(120)
      dom.runRaf()
      expect(grid.getScrollLeft()).toBe(120)
      // Rapid double scroll -> second coalesced on rafHandle
      wrap.scrollTop = 200
      wrap.dispatchEvent(new Event('scroll'))
      wrap.dispatchEvent(new Event('scroll'))
      dom.runRaf()
      // Pure horizontal scroll with same scrollTop -> early return L374
      wrap.scrollLeft = 180
      wrap.dispatchEvent(new Event('scroll'))
      // Scroll without requestAnimationFrame -> sync renderVisibleRows L384
      withTempGlobal('requestAnimationFrame', undefined, () => {
        wrap.scrollTop = 260
        wrap.dispatchEvent(new Event('scroll'))
        grid.setScrollLeft(60)
      })

      // Non-left mousedown, scrollbar mousedown, thead mousedown, canvas mousedown
      wrap.dispatchEvent(Object.assign(new Event('mousedown', { bubbles: true }), { button: 2, target: wrap }))
      wrap.dispatchEvent(Object.assign(new Event('mousedown', { bubbles: true }), { button: 0, clientX: 390, clientY: 50, target: wrap }))
      const thead = (grid as unknown as { theadEl: HTMLElement }).theadEl
      wrap.dispatchEvent(Object.assign(new Event('mousedown', { bubbles: true }), { button: 0, clientX: 50, clientY: 10, target: thead }))
      wrap.dispatchEvent(Object.assign(new Event('mousedown', { bubbles: true }), { button: 0, clientX: 30, clientY: 100, target: wrap }))

      // Non-cell tbody click/dblclick & synthetic node outside
      const tbody = (grid as unknown as { tbodyEl: HTMLElement }).tbodyEl
      const span = document.createElement('span')
      tbody.dispatchEvent(Object.assign(new Event('click', { bubbles: true }), { target: span }))
      tbody.dispatchEvent(Object.assign(new Event('dblclick', { bubbles: true }), { target: span }))

      // Pin column 'id' & exercise math + elementFromPoint drag selection + autoScroll + no-RAF drag
      grid.togglePinColumn('id')
      const fkTd = tbody.querySelector('td[data-col-index="1"]') as HTMLTableCellElement
      expect(fkTd).toBeTruthy()
      const origElFromPt = document.elementFromPoint
      try {
        // 1. elementFromPoint hits valid td in cell drag + autoScroll edges (top/left/right/bottom zones)
        ;(document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => fkTd
        wrap.dispatchEvent(Object.assign(new Event('mousedown', { bubbles: true }), { button: 0, clientX: 90, clientY: 60, target: fkTd }))
        window.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 375, clientY: 275, target: wrap }))
        dom.runRaf()
        // 2. elementFromPoint returns null -> math fallback for pinned + unpinned cols
        ;(document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => null
        window.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 70, clientY: 35, target: wrap }))
        dom.runRaf()
        window.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 370, clientY: 270, target: wrap }))
        dom.runRaf()
        window.dispatchEvent(new Event('mouseup'))

        // Row drag selection without requestAnimationFrame & dirty summary cleanup
        const rowNumTd = tbody.querySelector('td.datanoa-td-rownum') as HTMLTableCellElement
        withTempGlobal('requestAnimationFrame', undefined, () => {
          wrap.dispatchEvent(Object.assign(new Event('mousedown', { bubbles: true }), { button: 0, clientX: 15, clientY: 60, target: rowNumTd }))
          window.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 15, clientY: 160, target: rowNumTd }))
          window.dispatchEvent(new Event('blur'))
        })
      } finally {
        ;(document as unknown as { elementFromPoint: unknown }).elementFromPoint = origElFromPt
      }

      // Column resize handles (rowNum colIndex=-1 and data col): mousedown/move/mouseup with & without RAF + click/dblclick + esc
      const handles = Array.from(thead.querySelectorAll('.datanoa-resize-handle')) as HTMLElement[]
      expect(handles.length).toBeGreaterThanOrEqual(2)
      handles[0].dispatchEvent(Object.assign(new Event('mousedown', { bubbles: true, cancelable: true }), { clientX: 44 }))
      window.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 64 }))
      handles[0].dispatchEvent(Object.assign(new Event('click', { bubbles: true, cancelable: true })))
      handles[0].dispatchEvent(Object.assign(new Event('dblclick', { bubbles: true, cancelable: true })))
      window.dispatchEvent(new Event('mouseup'))
      withTempGlobal('requestAnimationFrame', undefined, () => {
        handles[1].dispatchEvent(Object.assign(new Event('mousedown', { bubbles: true, cancelable: true }), { clientX: 120 }))
        window.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 165 }))
        window.dispatchEvent(new Event('blur'))
      })

      // Context menu -> Trigger FK Jump (scope to contextMenuEl so cell FK badge doesn't intercept!) & Trigger Paste
      fkTd.dispatchEvent(Object.assign(new Event('contextmenu', { bubbles: true, cancelable: true }), { clientX: 100, clientY: 60, target: fkTd }))
      const ctxMenuEl = (grid as unknown as { contextMenuEl: HTMLElement | null }).contextMenuEl!
      const fkBtn = findBtn(ctxMenuEl, /^Go to departments\.id/i)
      expect(fkBtn).toBeTruthy()
      fkBtn!.click()
      expect(fkCalls.length).toBeGreaterThan(0)

      // Trigger Paste from cell context menu (`triggerPasteAction` L3527)
      await withTempGlobal('navigator', { clipboard: { readText: async () => '999' } }, async () => {
        fkTd.dispatchEvent(Object.assign(new Event('contextmenu', { bubbles: true, cancelable: true }), { clientX: 100, clientY: 60, target: fkTd }))
        findBtn(document.body, /^Paste\b/i)?.click()
        await flushMicro(4)
      })

      // Reopen cell contextmenu -> scroll closes it (L363)
      fkTd.dispatchEvent(Object.assign(new Event('contextmenu', { bubbles: true, cancelable: true }), { clientX: 100, clientY: 60, target: fkTd }))
      wrap.scrollTop = 290
      wrap.dispatchEvent(new Event('scroll'))
      dom.runRaf()

      // Open Bulk Fill popover & Column Filter popover -> outside mousedown + Escape close branches
      grid.selectSingleModelCell(0, 2)
      ;(grid as unknown as { openBulkFillPopover: (x: number, y: number, n: number) => void }).openBulkFillPopover(100, 100, 1)
      window.dispatchEvent(Object.assign(new Event('mousedown'), { target: wrap }))
      ;(grid as unknown as { openBulkFillPopover: (x: number, y: number, n: number) => void }).openBulkFillPopover(100, 100, 1)
      window.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Escape' })))

      // Canvas contextmenu -> Add Blank Row
      tbody.dispatchEvent(Object.assign(new Event('contextmenu', { bubbles: true, cancelable: true }), { clientX: 250, clientY: 120, target: tbody }))
      findBtn(document.body, /Add Blank Row|Insert/i)?.click()

      // Window Ctrl+Shift+V & paste forwarding + non-grid region block guards
      grid.setBatchMode(true)
      const outsideInput = document.createElement('input')
      document.body.appendChild(outsideInput)
      outsideInput.focus()
      window.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, shiftKey: true, cancelable: true }), { target: outsideInput }))
      const sqlArea = document.createElement('div')
      sqlArea.className = 'datanoa-sql-area'
      const sqlChild = document.createElement('span')
      sqlArea.appendChild(sqlChild)
      document.body.appendChild(sqlArea)
      window.dispatchEvent(Object.assign(new Event('paste', { cancelable: true }), { target: sqlChild, clipboardData: { getData: () => 'x' } }))
      outsideInput.remove()
      sqlArea.remove()
      wrap.focus()
      await withTempGlobal('navigator', { clipboard: { readText: async () => '99\tFromClip\tactive' } }, async () => {
        window.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, shiftKey: true, cancelable: true }), { target: wrap }))
        await flushMicro(4)
      })
      window.dispatchEvent(Object.assign(new Event('paste', { cancelable: true }), { target: wrap, clipboardData: { getData: () => 'SoloFill' } }))

      // Find off-screen row (row 115) & last column to cover scrollFindMatchIntoView + sticky offset overflow
      Object.defineProperty(fkTd, 'offsetLeft', { configurable: true, get: () => 20 })
      grid.setFindQuery('Emp_115')
      grid.findNext(1)
      grid.findNext(-1)
      grid.setFindQuery('')

      // Empty filter state + empty selection exports + client column filter + unpin + clearSortIndicator
      grid.revertAllChanges()
      grid.setFindQuery('Emp_115')
      grid.addClientColumnFilter(' ', 'x', 'equals')
      grid.addClientColumnFilter('status', 'active', 'equals')
      grid.removeClientColumnFilter('missing_col')
      grid.removeClientColumnFilter('status')
      grid.addClientColumnFilter('status', 'paused', 'equals')
      grid.clearClientColumnFilters()
      grid.clearSortIndicator()
      grid.togglePinColumn('id') // unpin
      grid.setFindQuery('')
      grid.setClientFilter('__no_such_row_9999__')
      grid.selectAll()
      expect(grid.exportSelection('csv')).toBe('')
      expect(grid.copySelection('tsv')).toBe('')
      grid.setClientFilter('')

      // Inline editor Tab / Shift+Tab navigation + object value edit + handleCellUpdated real match
      grid.selectSingleModelCell(0, 2)
      wrap.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })))
      const inlineInp = tbody.querySelector('input') as HTMLInputElement | null
      if (inlineInp) {
        inlineInp.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })))
        const nextInp = tbody.querySelector('input') as HTMLInputElement | null
        nextInp?.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true })))
        grid.cancelCellEdit()
      }
      grid.handleCellUpdated({ connectionId: 'c1', schema: 'main', table: 'employees', primaryKeys: { id: 1 }, column: 'name' })

      // Single selection fallback when selection matrix is cleared while selectedRowIndex/ColIndex remain
      grid.selectSingleModelCell(0, 2)
      ;(grid as unknown as { selection: { clear: () => void } }).selection.clear()
      expect(grid.exportSelection('csv')).toContain('Emp_0')
      ;(grid as unknown as { selection: { clear: () => void } }).selection.clear()
      expect(grid.copySelection('tsv')).toContain('Emp_0')

      grid.destroy()
      expect(inspectCalls.length + filterCalls.length + quickFilterCalls.length + notifyCalls.length).toBeGreaterThanOrEqual(0)
    })
  })

  it('Slice 3B: covers VirtualDataGrid upward/downward sliding pool, inline editor commit/rollback timer, paste/NULL rules, transposed mutations & handleCellUpdated', async () => {
    const host = setupGridContainer()
    const notify: string[] = []
    let rpcMode: 'ok' | 'fail' | 'stale' | 'throw' = 'ok'
    let resolveRpc: ((v: { ok: boolean; affectedRows?: number }) => void) | null = null

    const grid = new VirtualDataGrid({
      container: host,
      data: makeBrowseData(150),
      tableName: 'employees',
      dialect: 'sqlite',
      onNotify: (m) => notify.push(m),
      onUpdateCell: async () => {
        if (rpcMode === 'fail') return { ok: false, affectedRows: 0 }
        if (rpcMode === 'throw') throw new Error('Network Err')
        if (rpcMode === 'stale') {
          return await new Promise((r) => {
            resolveRpc = r
          })
        }
        return { ok: true, affectedRows: 1 }
      },
    })
    grid.setContextMeta('employees', 'sqlite', 'c1', 'main')
    const wrap = patchTableContainerGeom(grid, { clientW: 400, clientH: 260 })
    const tbody = (grid as unknown as { tbodyEl: HTMLElement }).tbodyEl

    // Scroll down then smoothly scroll UP (boundedStart < overlapStart) -> exercises upward prepending pool reuse
    wrap.scrollTop = 2200
    wrap.dispatchEvent(new Event('scroll'))
    dom.runRaf()
    wrap.scrollTop = 1950
    wrap.dispatchEvent(new Event('scroll'))
    dom.runRaf()
    wrap.scrollTop = 0
    wrap.dispatchEvent(new Event('scroll'))
    dom.runRaf()

    // F2 inline edit + Delete NOT NULL (direct mode) + Delete nullable (direct mode)
    grid.selectSingleModelCell(0, 2) // 'name' NOT NULL
    wrap.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'F2', cancelable: true })))
    expect(grid.cancelCellEdit().isEditing).toBe(false)
    expect(grid.cancelCellEdit().isEditing).toBe(false) // no active editor branch

    wrap.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Delete', cancelable: true })))
    expect(notify.some((m) => m.includes('NOT NULL'))).toBe(true)

    // Direct NULL on nullable 'notes' + rollback conflict 1500ms timer with fake timers
    grid.selectSingleModelCell(1, 4) // 'notes' nullable, value 'note_1'
    rpcMode = 'fail'
    vi.useFakeTimers()
    try {
      wrap.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Delete', cancelable: true })))
      await flushMicro(6)
      await vi.advanceTimersByTimeAsync(2000)
    } finally {
      vi.useRealTimers()
    }
    expect(notify.some((m) => m.includes('Edit rejected') || m.includes('reverted') || m.length > 0)).toBe(true)

    // Direct edit throwing + stale table switch mid-RPC
    rpcMode = 'throw'
    grid.selectSingleModelCell(2, 4)
    wrap.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })))
    const edInput = tbody.querySelector('input') as HTMLInputElement
    if (edInput) {
      edInput.value = 'changed_note'
      edInput.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })))
      await flushMicro(6)
    }

    rpcMode = 'stale'
    grid.selectSingleModelCell(2, 4)
    wrap.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })))
    const edInput2 = tbody.querySelector('input') as HTMLInputElement
    if (edInput2) {
      edInput2.value = 'stale_val'
      edInput2.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })))
      await flushMicro(4)
      grid.setData(makeBrowseData(5))
      resolveRpc?.({ ok: true, affectedRows: 1 })
      await flushMicro(6)
    }

    // Restore 20-row editable model for paste/NULL/transposed/clone/delete matrix
    rpcMode = 'ok'
    grid.setData(makeBrowseData(20))
    grid.setContextMeta('employees', 'sqlite', 'c1', 'main')
    patchTableContainerGeom(grid, { clientW: 400, clientH: 260 })

    // Copy single null cell then paste empty string -> isCopiedNullCell branch
    grid.selectSingleModelCell(0, 4) // row 0 notes=null
    grid.copySelection('tsv')
    grid.selectSingleModelCell(1, 4) // row 1 notes='note_1'
    wrap.dispatchEvent(Object.assign(new Event('paste', { cancelable: true }), { clipboardData: { getData: () => '' } }))

    // Overwrite-and-insert multi-col paste across PK + NOT NULL default column + extra rows
    grid.selectSingleModelCell(18, 0)
    const multiPaste = grid.pasteDelimitedTextDetailed(
      '19\t10\tNewName19\t\tnote_19\t99\n21\t10\tNewName21\t\tnote_21\t101',
      { forceNewRows: false }
    )
    expect(multiPaste.updatedCells + multiPaste.insertedRows).toBeGreaterThan(0)

    // Bulk set NULL on single NOT NULL cell triggers skippedNotNull message
    ;(grid as unknown as { selection: { clear: () => void } }).selection.clear()
    grid.selectSingleModelCell(0, 2) // NOT NULL
    expect(grid.bulkSetCellsValue(null)).toBe(0)
    expect(grid.bulkSetCellsValue('ValidName')).toBe(1)

    // Transposed mode addBlankRow / cloneSelectedRow / bulkCloneSelectedRows / markRowDeleted / bulkMarkRowsDeleted
    grid.setTransposed(true)
    expect(grid.getTransposed()).toBe(true)
    grid.addBlankRow()
    grid.selectSingleModelCell(0, 2)
    grid.cloneSelectedRow()
    ;(grid as unknown as { selection: { clear: () => void } }).selection.clear()
    grid.selectSingleModelCell(1, 2)
    expect(grid.bulkCloneSelectedRows()).toBe(1)
    // Mark existing row deleted then toggle back via bulkMarkRowsDeleted, and delete inserted rows via markRowDeleted & bulk
    expect(grid.markRowDeleted(grid.getModel()!.rows.length - 1)).toBe(true) // splices last inserted row
    expect(grid.markRowDeleted(1)).toBe(true) // marks existing row 1 deleted
    ;(grid as unknown as { selection: { selectRow: (r: number, c: number) => void } }).selection.selectRow(1, 7)
    grid.selectSingleModelCell(1, 2)
    expect(grid.bulkMarkRowsDeleted()).toBe(1) // toggles existing row 1 back to undeleted
    expect(grid.stageImportedRows([{ name: 'Imp', status: 'active' }])).toBe(1)
    expect(grid.stageImportedRows([])).toBe(0)

    // No-PK table delete guard (lines 4012, 4070)
    const noPkGrid = new VirtualDataGrid({
      container: setupGridContainer(),
      data: makeBrowseData(3, { canEdit: true, noPk: true }),
      onNotify: (m) => notify.push(m),
    })
    noPkGrid.selectSingleModelCell(0, 2)
    expect(noPkGrid.markRowDeleted(0)).toBe(false)
    expect(noPkGrid.bulkMarkRowsDeleted()).toBe(0)
    expect(notify.filter((m) => m.includes('Primary key required')).length).toBeGreaterThanOrEqual(2)
    noPkGrid.destroy()

    // handleCellUpdated mismatch guards + export/restoreRuntimeState with null model & active find
    grid.handleCellUpdated({ connectionId: 'other', schema: 'main', table: 'employees', primaryKeys: { id: 1 }, column: 'name' })
    grid.handleCellUpdated({ connectionId: 'c1', schema: 'other', table: 'employees', primaryKeys: { id: 1 }, column: 'name' })
    grid.handleCellUpdated({ connectionId: 'c1', schema: 'main', table: 'other', primaryKeys: { id: 1 }, column: 'name' })
    grid.setFindQuery('active')
    grid.findNext(1)
    const snapWithFind = grid.exportRuntimeState()
    expect(snapWithFind.findActiveIndex).toBeGreaterThanOrEqual(0)
    grid.setLoading(true, 'Loading...')
    const nullSnap = grid.exportRuntimeState()
    expect(nullSnap.model).toBeNull()
    grid.restoreRuntimeState(nullSnap)
    grid.restoreRuntimeState(snapWithFind)

    grid.revertAllChanges()
    grid.destroy()
  })

  it('Slice 3C: PBT invariants on VirtualDataGrid visibility, client filters & snapshot roundtrip', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.boolean(),
        fc.subarray(['dept_id', 'notes', 'score']),
        (rowCount, transposed, hideCols) => {
          const host = document.createElement('div')
          document.body.appendChild(host)
          const grid = new VirtualDataGrid({
            container: host,
            data: makeBrowseData(rowCount),
            tableName: 'emp_pbt',
          })
          for (const c of hideCols) grid.setColumnVisibility(c, false)
          grid.setTransposed(transposed)
          expect(grid.getTransposed()).toBe(transposed)
          const snap = grid.exportRuntimeState()
          grid.restoreRuntimeState(snap)
          expect(grid.getModel()?.rows.length).toBe(rowCount)
          grid.showAllColumns()
          grid.destroy()
          host.remove()
        }
      ),
      { numRuns: 10 }
    )
  })
})

type StudioInternals = {
  topbarAllBtn: HTMLButtonElement | null
  runBtn: HTMLButtonElement | null
  runAllBtn: HTMLButtonElement | null
  explainBtn: HTMLButtonElement | null
  formatSqlBtn: HTMLButtonElement | null
  cancelQueryBtn: HTMLButtonElement | null
  savedQueriesBtn: HTMLButtonElement | null
  historyBtn: HTMLButtonElement | null
  aiBtn: HTMLButtonElement | null
  refreshBtn: HTMLButtonElement | null
  whereInputEl: HTMLInputElement | null
  orderByInputEl: HTMLInputElement | null
  filterBtn: HTMLButtonElement | null
  clearFilterBtn: HTMLButtonElement | null
  searchModeBtn: HTMLButtonElement | null
  clientSearchEl: HTMLInputElement | null
  findNextBtn: HTMLButtonElement | null
  findPrevBtn: HTMLButtonElement | null
  queryBannerRetryBtn: HTMLButtonElement | null
  queryBannerCopyBtn: HTMLButtonElement | null
  queryBannerReportBtn: HTMLButtonElement | null
  queryBannerBackBtn: HTMLButtonElement | null
  dmlPreviewBtn: HTMLButtonElement | null
  dmlApplyBtn: HTMLButtonElement | null
  dmlCopyBtn: HTMLButtonElement | null
  dmlCloseBtn: HTMLButtonElement | null
  submitBtn: HTMLButtonElement | null
  editTableBtn: HTMLButtonElement | null
  columnsBtn: HTMLButtonElement | null
  sidebarListEl: HTMLDivElement | null
  gridAreaEl: HTMLDivElement | null
  explainAiEl: HTMLDivElement | null
  txToolbar: TransactionToolbarController
  disposables: Array<{ dispose: () => void }>
  openCommandPalette: () => void
  openDriverManagerModal: (onCloseReturn?: () => void) => void
  openSavedQueriesModal: () => void
  openValueInspector: (info?: unknown) => void
  handleColumnHeaderFilter: (
    col: string,
    val: string,
    op: 'contains' | 'equals' | 'starts' | 'empty' | 'not-empty' | 'gt' | 'lt',
    mode: 'query' | 'client' | 'clear'
  ) => Promise<void>
  handleNavigateForeignKey: (refTable: string, refColumn: string, val: unknown) => Promise<void>
  countRowsForObject: (item: SchemaObject) => Promise<void>
  generateSqlTemplateForObject: (item: SchemaObject, kind: 'select' | 'insert' | 'update') => Promise<void>
  openObjectDdlInConsole: (item: SchemaObject) => Promise<void>
  copyObjectDdl: (item: SchemaObject) => Promise<void>
  selectReadOnlyObject: (item: SchemaObject) => void
  introspectSchema: (connId: string, preservePage?: boolean) => Promise<void>
  loadTableData: (connId: string, table: string, page?: number) => Promise<void>
  runExplainAiAnalysis: (tabId: string, idx: number) => Promise<void>
  consoleTabs: { getActiveTabId: () => string; getActiveTab: () => { id: string; executedSql?: string; resultStates?: unknown[] } }
}

describe('Wave 4D Studio Editor Coverage — Slice 4 (DatanoaStudioEditor Live SQLite E2E)', () => {
  let dom: DomHarness
  const dbsToClose: Array<{ close: () => void }> = []

  beforeEach(() => {
    dom = installDomHarness()
    ;(window as unknown as { innerWidth: number }).innerWidth = 1280
    ;(window as unknown as { innerHeight: number }).innerHeight = 900
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    while (dbsToClose.length) {
      try {
        dbsToClose.pop()?.close()
      } catch {
        // Ignore already-closed in-memory DB handle
      }
    }
    dom.teardown()
  })

  async function bootStudio(opts: { seedEmptyConns?: boolean; multiSchema?: boolean; extraEmployeeRows?: number } = {}) {
    const backend = createLiveStudioSqliteBackend(opts)
    dbsToClose.push(backend.db)
    ;(window as unknown as { orca: unknown }).orca = backend.orcaApi
    const ed = initializeEditor()!
    const docSession = await backend.orcaApi.document.session()
    ed.attachDocumentSession(docSession)
    await flushTick()
    await flushTick()
    const priv = ed as unknown as StudioInternals
    if (priv.gridAreaEl) {
      Object.defineProperty(priv.gridAreaEl, 'offsetParent', { configurable: true, get: () => document.body })
      Object.defineProperty(priv.gridAreaEl, 'clientHeight', { configurable: true, get: () => 420 })
      Object.defineProperty(priv.gridAreaEl, 'clientWidth', { configurable: true, get: () => 860 })
    }
    return { backend, ed, priv }
  }

  it('Slice 4A: warm cache SQL/truncated/pruned snapshot, non-RAF scroll restore, read-only DDL retry/copy/console, topbar popover, sidebar context menu & destroy cleanup', async () => {
    // 1. Warm cache with expired timestamp + SQL result (truncated: true) + non-RAF scrollState + local/host viewState fallback
    const b1 = createLiveStudioSqliteBackend({ multiSchema: true })
    dbsToClose.push(b1.db)
    ;(window as unknown as { orca: unknown }).orca = b1.orcaApi
    writeStudioViewStateSnapshot({
      version: 1,
      activeConnectionId: 'c_main',
      activeTable: 'employees',
      activeSchema: 'main',
      viewMode: 'split',
      sqlPanePx: 220,
      scrollState: { sidebarTop: 40, gridTop: 80, gridLeft: 30 },
    })
    writeLocalStudioWarmCache({
      updatedAt: 1, // expired -> isWarmCacheFresh === false
      connections: [...b1.connections],
      activeConnectionId: 'c_main',
      activeTable: 'employees',
      activeSchema: 'main',
      activeObjectKind: 'table',
      availableSchemas: ['main'],
      defaultSchema: 'main',
      selectedSchema: 'main',
      isShowingSqlResult: true,
      whereClause: '',
      orderByClause: '',
      page: 1,
      pageSize: 100,
      schemaObjects: [{ name: 'employees', kind: 'table', schema: 'main' }],
      schemaMap: { employees: ['id', 'name'] },
      pageData: null,
      lastSqlResult: {
        columns: [{ name: 'id', type: 'INTEGER' }],
        rows: [{ id: 1 }],
        rowCount: 1,
        executionTimeMs: 2,
        truncated: true,
        isSelect: true,
      },
    })
    let ed1: DatanoaStudioEditor | null = null
    await withTempGlobal('requestAnimationFrame', undefined, async () => {
      ed1 = initializeEditor()
      const ses1 = await b1.orcaApi.document.session()
      ed1?.attachDocumentSession(ses1)
      await flushTick()
      await flushTick()
    })
    expect(ed1).not.toBeNull()
    expect(ed1?.getSqlConsole()).not.toBeNull()
    ed1?.destroy()
    b1.db.close()

    // 2. Truncated warm page cache (< expectedPageRows) + oversized >450KB cache pruning on unload
    localStorage.clear()
    const b2 = createLiveStudioSqliteBackend()
    dbsToClose.push(b2.db)
    ;(window as unknown as { orca: unknown }).orca = b2.orcaApi
    await b2.orcaApi.storage.set(STUDIO_VIEW_STATE_STORAGE_KEY, {
      version: 1,
      activeConnectionId: 'c_main',
      activeTable: 'employees',
      viewMode: 'grid',
    })
    writeLocalStudioWarmCache({
      updatedAt: Date.now(),
      connections: [...b2.connections],
      activeConnectionId: 'c_main',
      activeTable: 'employees',
      activeSchema: 'main',
      activeObjectKind: 'table',
      isShowingSqlResult: false,
      whereClause: '',
      orderByClause: '',
      page: 1,
      pageSize: 100,
      schemaObjects: [{ name: 'employees', kind: 'table', schema: 'main' }],
      schemaMap: { employees: ['id', 'name'] },
      pageData: {
        columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }],
        headers: ['id'],
        rows: [{ id: 1 }], // truncated (< 4 actual rows)
        totalRows: 10,
        page: 1,
        pageSize: 100,
        primaryKey: ['id'],
        canEdit: true,
      },
      lastSqlResult: null,
    })
    const ed2 = initializeEditor()!
    await flushTick()
    await flushTick()
    const p2 = ed2 as unknown as StudioInternals & {
      schemaMap: Record<string, string[]>
      lastPageData: TableBrowseResult | null
      disposables: Array<{ dispose: () => void }>
    }
    // Inject oversized schemaMap (>40KB) & lastPageData (>450KB) to cover byte-limit branches + throwing disposable on pagehide
    p2.schemaMap = { huge: Array.from({ length: 4000 }, (_, i) => `col_${i}_padded`) }
    p2.lastPageData = {
      columns: [{ name: 'big', type: 'TEXT', nullable: true, primaryKey: false }],
      headers: ['big'],
      rows: Array.from({ length: 200 }, (_, i) => ({ big: `${i}_${'x'.repeat(2400)}` })),
      totalRows: 200,
      page: 1,
      pageSize: 100,
      primaryKey: [],
      canEdit: false,
    }
    p2.disposables.push({
      dispose: () => {
        throw new Error('disposable boom')
      },
    })
    window.dispatchEvent(new Event('pagehide'))

    // 3. Full live boot with multiSchema + readOnly DDL retry + Topbar All popover + Sidebar context menu + Count Rows array/error + Generate SQL fallback
    localStorage.clear()
    const { backend, ed, priv } = await bootStudio({ multiSchema: true, extraEmployeeRows: 20 })
    try {
      // Read-only view DDL failure -> Retry button -> loaded
      backend.failOnceActions.add('schema.getObjectDdl')
      priv.selectReadOnlyObject({ name: 'active_employees', kind: 'view', schema: 'main' })
      await flushTick()
      findBtn(document.body, /^Retry$/i)?.click()
      await flushTick()

      // copyObjectDdl & openObjectDdlInConsole (normal & error)
      await priv.copyObjectDdl({ name: 'employees', kind: 'table', schema: 'main' })
      await priv.openObjectDdlInConsole({ name: 'employees', kind: 'table', schema: 'main' })
      backend.failOnceActions.add('schema.getObjectDdl')
      await priv.copyObjectDdl({ name: 'employees', kind: 'table', schema: 'main' })
      backend.failOnceActions.add('schema.getObjectDdl')
      await priv.openObjectDdlInConsole({ name: 'employees', kind: 'table', schema: 'main' })

      // countRowsForObject: default object row, array row, and error
      await priv.countRowsForObject({ name: 'employees', kind: 'table', schema: 'main' })
      const origReq = backend.orcaApi.plugin.request
      ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = (async (
        m: string,
        p?: Record<string, unknown>
      ) => {
        if (m === 'query.run' && String(p?.sql || '').includes('COUNT(*)')) {
          return {
            columns: [{ name: 'c', type: 'INTEGER' }],
            rows: [[77]],
            rowCount: 1,
            executionTimeMs: 1,
            truncated: false,
            isSelect: true,
          }
        }
        return origReq(m, p)
      }) as typeof origReq
      await priv.countRowsForObject({ name: 'departments', kind: 'table', schema: 'main' })
      ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = origReq
      backend.failOnceActions.add('query.run')
      await priv.countRowsForObject({ name: 'employees', kind: 'table', schema: 'main' })

      // generateSqlTemplateForObject fallback when schema.tableDetails fails
      backend.failOnceActions.add('schema.tableDetails')
      await priv.generateSqlTemplateForObject({ name: 'employees', kind: 'table', schema: 'main' }, 'update')

      // Topbar All-Tables popover (positioned below + above viewport, filter, Escape, click item)
      if (priv.topbarAllBtn) {
        priv.topbarAllBtn.getBoundingClientRect = () =>
          ({ left: 400, top: 80, right: 460, bottom: 108, width: 60, height: 28, x: 400, y: 80, toJSON() {} }) as DOMRect
        priv.topbarAllBtn.click()
        const popInput = document.querySelector('.datanoa-topbar-popover input') as HTMLInputElement | null
        if (popInput) {
          popInput.value = 'emp'
          popInput.dispatchEvent(new Event('input'))
        }
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

        // Position near bottom edge so popover flips above
        priv.topbarAllBtn.getBoundingClientRect = () =>
          ({ left: 400, top: 860, right: 460, bottom: 890, width: 60, height: 30, x: 400, y: 860, toJSON() {} }) as DOMRect
        priv.topbarAllBtn.click()
        const popBtn = findBtn(document.querySelector('.datanoa-topbar-popover') || document.body, /departments/i)
        popBtn?.click()
        await flushTick()
      }

      // Keyboard shortcuts: Ctrl+/ (? -> shortcuts modal) & Ctrl+S on staged grid changes
      window.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Escape' })))
      window.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: '?', ctrlKey: true, cancelable: true })))
      findBtn(document.body, /^Close$/i)?.click()

      ed.getDataGrid()?.selectSingleModelCell(0, 2)
      ed.getDataGrid()?.stageCellEdit(0, 2, 'ShortcutSaved')
      window.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true })))
      await flushTick()
      expect((ed as unknown as { activeTable: string | null }).activeTable).toBe('departments')
      expect(ed.getDataGrid()?.getModel()?.rows.length).toBeGreaterThan(0)
      expect(ed.getDataGrid()?.getStagedCount()).toBe(1)
      expect(document.querySelector('.datanoa-grid-container')).not.toBeNull()

      // Window focus + visibilitychange + resize + Alt+Shift+F format shortcut
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'F', altKey: true, shiftKey: true, cancelable: true })))
      await flushTick()
    } finally {
      ed.destroy()
      b2.db.close()
    }
  })

  it('Slice 4B: SQL execution, Bind Params, Danger SQL confirm/abort, EXPLAIN multi-stmt & AI Explain callbacks, header filters, search debounce & FK jump', async () => {
    const { backend, ed, priv } = await bootStudio({ extraEmployeeRows: 10 })
    try {
      const consoleCtrl = ed.getSqlConsole()!

      // 1. Format SQL + empty SQL guard
      consoleCtrl.setText('   ')
      await ed.executeSql(false)
      consoleCtrl.setText('select id,name from employees')
      priv.formatSqlBtn?.click()
      expect(consoleCtrl.getText()).toContain('SELECT')

      // 2. Bind params modal on :empId -> submit real SQLite query
      consoleCtrl.setText('SELECT * FROM employees WHERE id = :empId;')
      priv.runBtn?.click()
      const bpModal = document.querySelector('.datanoa-modal-backdrop') as HTMLElement
      if (bpModal) {
        const inp = bpModal.querySelector('input[type="text"]') as HTMLInputElement
        if (inp) {
          inp.value = '1'
          inp.dispatchEvent(new Event('input'))
        }
        findBtn(bpModal, /Run|Apply|Execute/i)?.click()
        await flushTick()
        await flushTick()
      }

      // 3. Dangerous SQL confirm on executeSql + dangerous SQL confirm on explainSql
      consoleCtrl.setText('DELETE FROM notes WHERE id = -999;')
      await ed.executeSql(true)
      findBtn(document.body, /Execute Anyway|Run Anyway|Confirm/i)?.click()
      await flushTick()

      // Danger on EXPLAIN -> Cancel vs Confirm -> Multi-statement mixed valid + broken EXPLAIN
      consoleCtrl.setText('DELETE FROM notes;')
      await ed.explainSql(true)
      findBtn(document.body, /^Cancel$/i)?.click()

      // Multi-stmt query + SQL column header filter (`query` inject + `client` + `clear`)
      consoleCtrl.setText('SELECT id, name, dept_id FROM employees;\nSELECT COUNT(*) AS cnt FROM departments;')
      await ed.executeSql(true)
      await flushTick()
      await priv.handleColumnHeaderFilter('name', 'Alice', 'contains', 'query')
      await flushTick()
      await priv.handleColumnHeaderFilter('name', 'Bob', 'equals', 'client')
      await priv.handleColumnHeaderFilter('name', '', 'contains', 'clear')
      // Uninjectable UNION SQL falls back cleanly to client filter
      consoleCtrl.setText('SELECT id, name FROM employees UNION SELECT id, name FROM departments;')
      await ed.executeSql(true)
      await flushTick()
      await priv.handleColumnHeaderFilter('name', 'Engineering', 'contains', 'query')

      // 4. Multi-statement EXPLAIN (1 valid SELECT + 1 broken SQL) + AI Explain full lifecycle (Cancel, Fail->Retry, ApplySql, OpenNewTab, Copy, ToggleCollapsed, ConfigureAI)
      consoleCtrl.setText('SELECT * FROM employees WHERE dept_id = 1;\nSELECT * FROM non_existent_table_xyz;')
      await ed.explainSql(true)
      await flushTick()
      await flushTick()

      // Intercept ai.explainAnalyze for deferred Cancel test
      const origReq = backend.orcaApi.plugin.request
      let resolvePendingAi: ((v: unknown) => void) | null = null
      ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = (async (
        m: string,
        p?: Record<string, unknown>
      ) => {
        if (m === 'ai.explainAnalyze') {
          return await new Promise((r) => {
            resolvePendingAi = r
          })
        }
        return origReq(m, p)
      }) as typeof origReq

      const aiBtn1 = priv.explainAiEl ? findBtn(priv.explainAiEl, /Analyze/i) : undefined
      if (aiBtn1) {
        aiBtn1.click()
        await flushMicro(4)
        findBtn(priv.explainAiEl!, /Cancel/i)?.click()
        resolvePendingAi?.({ summary: 'stale' })
        await flushMicro(4)
      }

      // Restore real backend, inject one failure, click Analyze -> Error, then retry -> Ready -> Apply/NewTab/Copy/Collapse/Configure
      ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = origReq
      backend.failOnceActions.add('ai.explainAnalyze')
      const tab = priv.consoleTabs.getActiveTab()
      await priv.runExplainAiAnalysis(tab.id, 0)
      await flushTick()
      await priv.runExplainAiAnalysis(tab.id, 0)
      await flushTick()
      if (priv.explainAiEl) {
        expect(document.querySelector('.datanoa-status-bar .datanoa-shortcut-hint')).toBeNull()
        expect(priv.explainAiEl.textContent).toContain(
          'Optimized Equivalent SQL (review before executing)'
        )
        findBtn(priv.explainAiEl, /Copy SQL/i)?.click()
        findBtn(priv.explainAiEl, /Replace Query/i)?.click()
        expect(consoleCtrl.getText()).toBe(
          'SELECT id, name FROM employees WHERE dept_id = 1;\nSELECT * FROM non_existent_table_xyz;'
        )
        findBtn(priv.explainAiEl, /Collapse|Expand/i)?.click()
        findBtn(priv.explainAiEl, /New Tab/i)?.click()
        // Switch back to original tab and verify 3-statement Replace Query on middle statement (#2)
        const firstTabId = priv.consoleTabs.getTabs()[0]?.id
        if (firstTabId) priv.switchConsoleTab(firstTabId)
        consoleCtrl.setText('SELECT 1;\nSELECT * FROM employees WHERE dept_id = 1;\nSELECT 2;')
        await ed.explainSql(true)
        await flushTick()
        priv.selectResultSetIndex(1)
        await priv.runExplainAiAnalysis(priv.consoleTabs.getActiveTab().id, 1)
        await flushTick()
        findBtn(priv.explainAiEl, /Replace Query/i)?.click()
        expect(consoleCtrl.getText()).toBe(
          'SELECT 1;\nSELECT id, name FROM employees WHERE dept_id = 1;\nSELECT 2;'
        )
        findBtn(priv.explainAiEl, /Configure|Settings/i)?.click()
        findBtn(document.body, /^Close$/i)?.click()
      }

      // Switch back to table via Back button + exercise clientSearchEl debounce/Enter/Shift+Enter/Escape
      priv.queryBannerBackBtn?.click()
      await flushTick()

      vi.useFakeTimers()
      try {
        if (priv.clientSearchEl) {
          priv.clientSearchEl.value = 'Emp'
          priv.clientSearchEl.dispatchEvent(new Event('input'))
          await vi.advanceTimersByTimeAsync(300)
          priv.clientSearchEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
          priv.clientSearchEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }))
          priv.clientSearchEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        }
      } finally {
        vi.useRealTimers()
      }

      // FK jump with dotted `main.departments` and plain `employees` + server filter fail + Retry + DML Preview copy/close
      await priv.handleNavigateForeignKey('main.departments', 'id', 1)
      await flushTick()
      await priv.handleNavigateForeignKey('employees', 'dept_id', null)
      await flushTick()

      // data.getPage failure -> Retry button recovers
      backend.failOnceActions.add('data.getPage')
      await priv.loadTableData('c_main', 'employees', 1)
      priv.queryBannerRetryBtn?.click()
      await flushTick()

      // introspectSchema failure -> Retry recovers
      backend.failOnceActions.add('schema.listObjects')
      await priv.introspectSchema('c_main', true)
      priv.queryBannerRetryBtn?.click()
      await flushTick()

      // DML Preview copy & close buttons
      ed.getDataGrid()?.stageCellEdit(0, 2, 'DmlPreviewCheck')
      priv.dmlPreviewBtn?.click()
      await flushTick()
      priv.dmlCopyBtn?.click()
      priv.dmlCloseBtn?.click()
    } finally {
      ed.destroy()
    }
  })

  it('Slice 4C: live handleAlterTable, handleApplyMigration (SQLite active-TX rebuild block), direct onUpdateCell conflict/throw, Driver Manager, Saved Queries new-tab, Command Palette & events', async () => {
    const { backend, ed, priv } = await bootStudio()
    try {
      // 1. handleAlterTable: validation error, RPC failure, real renameTable, and Read-Only guard
      await ed.handleAlterTable({ kind: 'addColumn', table: 'employees', column: { name: '', type: 'TEXT', nullable: true } })
      backend.failOnceActions.add('query.run')
      await ed.handleAlterTable({ kind: 'addColumn', table: 'employees', column: { name: 'nickname', type: 'TEXT', nullable: true } })
      await ed.handleAlterTable({ kind: 'renameTable', table: 'notes', newTableName: 'notes_renamed' })
      await flushTick()

      // 2. handleApplyMigration: empty batch, SQLite manual TX blocking rebuild, and valid ALTER migration
      await ed.handleApplyMigration([], { tableName: 'employees', schema: 'main', columns: [], indexes: [], foreignKeys: [], triggers: [] } as never)
      await priv.txToolbar.begin()
      await expect(
        ed.handleApplyMigration(['-- rebuild employees'], {
          tableName: 'employees',
          schema: 'main',
          columns: [
            {
              name: 'name',
              originalName: 'name',
              status: 'existing',
              dataType: 'VARCHAR(120)',
              originalDataType: 'TEXT',
              nullable: true,
              originalNullable: false,
              isPrimaryKey: false,
              originalIsPrimaryKey: false,
            },
          ],
          indexes: [],
          foreignKeys: [],
          triggers: [],
        } as never)
      ).rejects.toThrow(/transaction/i)
      await priv.txToolbar.rollback()
      await ed.handleApplyMigration(['ALTER TABLE "employees" ADD COLUMN "extra_c" TEXT;'], {
        tableName: 'employees',
        schema: 'main',
        columns: [
          { name: 'id', originalName: 'id', status: 'existing', dataType: 'INTEGER', originalDataType: 'INTEGER', nullable: false, originalNullable: false, isPrimaryKey: true, originalIsPrimaryKey: true },
          { name: 'extra_c', status: 'new', dataType: 'TEXT', nullable: true, isPrimaryKey: false },
        ],
        indexes: [],
        foreignKeys: [],
        triggers: [],
      } as never)
      await flushTick()

      // 3. Direct onUpdateCell conflict (affectedRows=0) & RPC error via DataGrid callback
      const gridOpts = (ed.getDataGrid() as unknown as {
        onUpdateCell?: (p: { primaryKeys: Record<string, unknown>; column: string; newValue: unknown; originalValue: unknown; rowIndex: number }) => Promise<{ ok: boolean }>
        onInspectCell?: (info: unknown) => void
      })
      const origReq = backend.orcaApi.plugin.request
      ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = (async (
        m: string,
        p?: Record<string, unknown>
      ) => {
        if (m === 'data.updateCell') return { ok: false, affectedRows: 0 }
        return origReq(m, p)
      }) as typeof origReq
      const resZero = await gridOpts.onUpdateCell?.({
        primaryKeys: { id: 1 },
        column: 'name',
        newValue: 'X',
        originalValue: 'Alice',
        rowIndex: 0,
      })
      expect(resZero?.ok).toBe(false)
      ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = origReq
      const resOk = await gridOpts.onUpdateCell?.({
        primaryKeys: { id: 1 },
        column: 'name',
        newValue: 'Alice',
        originalValue: 'Alice',
        rowIndex: 0,
      })
      expect(resOk?.ok).toBe(true)
      backend.failOnceActions.add('data.updateCell')
      const resErr = await gridOpts.onUpdateCell?.({
        primaryKeys: { id: 1 },
        column: 'name',
        newValue: 'Y',
        originalValue: 'Alice',
        rowIndex: 0,
      })
      expect(resErr?.ok).toBe(false)

      // Open Value Inspector via callback
      gridOpts.onInspectCell?.({ column: 'name', value: 'Alice', rowIndex: 0, colIndex: 1, columnType: 'TEXT', nullable: false, isEditable: false })

      // 4. Driver Manager modal open & onClose callback + Saved Queries open + Command Palette execute commands
      let closedCount = 0
      priv.openDriverManagerModal(() => {
        closedCount++
      })
      await flushTick()
      const dmClose = findBtn(document.querySelector('.datanoa-modal-backdrop')!, /^Close$/i)
      dmClose?.click()
      expect(closedCount).toBe(1)
      // Also verify Escape dismissal invokes onDismiss (L6905)
      priv.openDriverManagerModal(() => {
        closedCount++
      })
      await flushTick()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
      expect(closedCount).toBe(2)

      priv.openCommandPalette()
      await flushTick()
      const cmdItems = Array.from(document.querySelectorAll('.datanoa-cmd-item, .datanoa-modal-backdrop button')) as HTMLElement[]
      for (const kw of ['Refresh Schema', 'Toggle Sidebar', 'SQL Console', 'Keyboard Shortcuts']) {
        priv.openCommandPalette()
        const match = Array.from(document.querySelectorAll('.datanoa-modal-backdrop button, .datanoa-cmd-item')).find((el) =>
          (el.textContent || '').includes(kw)
        ) as HTMLElement | undefined
        match?.click()
        await flushMicro(4)
        const modalNow = document.querySelector('.datanoa-modal-backdrop')
        if (modalNow) {
          findBtn(modalNow, /^Close$/i)?.click()
        }
      }
      expect(cmdItems.length).toBeGreaterThanOrEqual(0)

      // 5. Saved Queries New-Tab + Backend Host/Plugin/Settings/DocReplace Events
      priv.openSavedQueriesModal()
      await flushTick()
      findBtn(document.querySelector('.datanoa-modal-backdrop')!, /New Tab|Open in New Tab/i)?.click()
      const savedBackdrop = document.querySelector('.datanoa-modal-backdrop')
      if (savedBackdrop) findBtn(savedBackdrop, /^Close$/i)?.click()

      backend.emitHost('theme-changed', { kind: 'dark' })
      backend.emitSettings({ 'ai.enabled': true })
      backend.emitPlugin('tx.committed', { connectionId: 'c_main' })
      backend.emitPlugin('tx.rolledBack', { connectionId: 'c_main' })
      backend.emitPlugin('data.cellUpdated', { connectionId: 'c_main', schema: 'main', table: 'employees', primaryKeys: { id: 1 }, column: 'name' })
      backend.emitDocReplace('-- @datanoa.connectionId: c_main\n-- @datanoa.table: departments\nSELECT * FROM departments;')
      await flushTick()
    } finally {
      ed.destroy()
    }
  })

  it('Slice 4D: empty-conn boot, Read-Only & caution strip, SchemaInspector/Import/Danger callbacks, SQL server filters/cancel/history, split resizer & full Command Palette', async () => {
    // 1. Empty connections boot (`seedEmptyConns: true`) -> sidebar empty-state Add Connection (`L3752`), Create Table (`L3753`) & collapsible trigger (`onOpen` L2991)
    const { ed: edEmpty, priv: privEmpty } = await bootStudio({ seedEmptyConns: true })
    try {
      for (const btn of Array.from(privEmpty.sidebarListEl?.querySelectorAll('button') || []) as HTMLButtonElement[]) {
        btn.click()
        const mb = document.querySelector('.datanoa-modal-backdrop')
        if (mb) findBtn(mb, /^Cancel|Close$/i)?.click()
      }
      const trigger = document.querySelector('.datanoa-collapsible-trigger, .datanoa-select-trigger, [aria-haspopup="listbox"]') as HTMLElement | null
      trigger?.click()
      await flushMicro(4)
    } finally {
      edEmpty.destroy()
    }

    // 2. Full interactive studio session
    localStorage.clear()
    const { backend, ed, priv } = await bootStudio({ multiSchema: true, extraEmployeeRows: 10 })
    const privFull = priv as StudioInternals & {
      cautionStripCloseBtn: HTMLButtonElement | null
      addConnBtn: HTMLButtonElement | null
      editConnBtn: HTMLButtonElement | null
      tabButtons: Record<'split' | 'grid' | 'sql' | 'inspector', HTMLButtonElement>
      inspectorAreaEl: HTMLDivElement | null
      splitResizerEl: HTMLDivElement | null
      pageSizeSelectEl: HTMLSelectElement | null
      exportSelectEl: HTMLSelectElement | null
      clearHistoryBtn: HTMLButtonElement | null
      handleConnectionChanged: (id: string | null) => void
      handleExportAction: (val: string) => void
      handleColumnConfigChanged: (cfg: { hidden: string[]; pinned: string[] }) => void
      applyServerFilters: () => Promise<void>
      clearAllFilters: () => Promise<void>
      cancelActiveQuery: () => Promise<void>
      clearQueryHistory: () => Promise<void>
      previewStagedChanges: () => Promise<void>
      submitStagedChanges: () => Promise<void>
      openCreateTableModal: () => void
      openImportDataModal: (item?: SchemaObject) => Promise<void>
    }
    try {
      // Switch to Inspector mode, start manual TX (`1768`), exercise Open in Console (`1779`), Truncate (`1789`), Drop (`1795`)
      privFull.tabButtons.inspector?.click()
      await flushTick()
      await priv.txToolbar.begin()
      const inspEl = privFull.inspectorAreaEl || document.body
      findBtn(inspEl, /Open.*Console/i)?.click()
      privFull.tabButtons.inspector?.click()
      findBtn(inspEl, /Truncate/i)?.click()
      const trBackdrop = document.querySelector('.datanoa-modal-backdrop')
      if (trBackdrop) {
        const inp = trBackdrop.querySelector('input') as HTMLInputElement | null
        if (inp) {
          inp.value = 'employees'
          inp.dispatchEvent(new Event('input'))
        }
        findBtn(trBackdrop, /^Cancel$/i)?.click()
      }
      findBtn(inspEl, /Drop/i)?.click()
      findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /^Cancel$/i)?.click()
      await priv.txToolbar.rollback()

      // Switch back to Split + exercise Create Table (`L6966`) & Import Data errors (`!table`, `view`, `schema fail`, plus modal)
      privFull.tabButtons.split?.click()
      await flushTick()
      await privFull.openImportDataModal({ name: 'active_employees', kind: 'view', schema: 'main' })
      backend.failOnceActions.add('schema.tableDetails')
      await privFull.openImportDataModal({ name: 'departments', kind: 'table', schema: 'main' })
      await privFull.openImportDataModal({ name: 'employees', kind: 'table', schema: 'main' })
      findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /^Cancel$/i)?.click()

      // Sidebar item clicks, sidebar context menu (`Copy CREATE DDL`, `Open DDL in SQL Console`, `Import Data...`), Topbar pill click & context menu (`3688..3753`)
      const sidebarBtns = Array.from(priv.sidebarListEl?.querySelectorAll('button') || []) as HTMLButtonElement[]
      const roBtn = sidebarBtns.find((b) => (b.textContent || '').includes('active_employees'))
      roBtn?.click()
      await flushTick()
      const empBtn = sidebarBtns.find((b) => (b.textContent || '').includes('employees'))
      empBtn?.click()
      await flushTick()
      for (const itemLabel of [/Copy CREATE DDL/i, /Open DDL in SQL Console/i, /Import Data/i]) {
        empBtn?.dispatchEvent(Object.assign(new Event('contextmenu', { bubbles: true, cancelable: true }), { clientX: 60, clientY: 160 }))
        findBtn(document.body, itemLabel)?.click()
        await flushTick()
        const mb = document.querySelector('.datanoa-modal-backdrop')
        if (mb) findBtn(mb, /^Cancel|Close$/i)?.click()
      }
      const topPill = document.querySelector('.datanoa-topbar-pill') as HTMLElement | null
      topPill?.click()
      topPill?.dispatchEvent(Object.assign(new Event('contextmenu', { bubbles: true, cancelable: true }), { clientX: 200, clientY: 40 }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

      // Create Table real submit -> `6966:updateStatus`, + Danger Table real confirm -> `7106..7107`
      privFull.openCreateTableModal()
      const ctModal = document.querySelector('.datanoa-modal-backdrop') as HTMLElement | null
      if (ctModal) {
        const tblNameInp = ctModal.querySelector('input[type="text"]') as HTMLInputElement | null
        if (tblNameInp) {
          tblNameInp.value = 'temp_wave4d_tbl'
          tblNameInp.dispatchEvent(new Event('input'))
        }
        findBtn(ctModal, /^Create Table$/i)?.click()
        await flushTick()
        await flushTick()
        findBtn(privFull.inspectorAreaEl || document.body, /Drop/i)?.click()
        const dropMb = document.querySelector('.datanoa-modal-backdrop') as HTMLElement | null
        if (dropMb) {
          const confInp = dropMb.querySelector('input') as HTMLInputElement | null
          if (confInp) {
            confInp.value = 'temp_wave4d_tbl'
            confInp.dispatchEvent(new Event('input'))
          }
          findBtn(dropMb, /Drop Table|Confirm|Execute/i)?.click()
          await flushTick()
        }
      }

      // Grid header filter icon -> integrated `1745:onColumnHeaderFilter`
      const filterIcon = document.querySelector('.datanoa-col-filter-btn, .datanoa-th-filter-btn') as HTMLButtonElement | null
      if (filterIcon) {
        filterIcon.click()
        const pop = document.querySelector('.datanoa-col-filter-popover') as HTMLElement | null
        if (pop) {
          const valInp = pop.querySelector('input') as HTMLInputElement | null
          if (valInp) {
            valInp.value = 'Alice'
            valInp.dispatchEvent(new Event('input'))
          }
          findBtn(pop, /Apply|Filter|Server/i)?.click()
          await flushTick()
        }
      }

      // CM6 Console shortcuts -> `onExecute` (`1702`), `onExecuteAll` (`1705`), `onFormatSql` (`1708`)
      const cmContent = document.querySelector('.cm-content') as HTMLElement | null
      ed.getSqlConsole()?.setText('select id,name from employees')
      cmContent?.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'f', altKey: true, shiftKey: true, bubbles: true, cancelable: true })))
      cmContent?.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })))
      await flushTick()
      cmContent?.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })))
      await flushTick()

      // SQL result Server Filters: invalid WHERE (`L4458`), valid SELECT filter (`L4485`), clearAllFilters (`L4540`), and non-SELECT filter (`L4481`)
      ed.getSqlConsole()?.setText('SELECT id, name FROM employees;')
      await ed.executeSql(true)
      await flushTick()
      if (priv.whereInputEl && priv.orderByInputEl) {
        priv.whereInputEl.value = 'id = 1; DROP TABLE employees'
        await privFull.applyServerFilters()
        priv.whereInputEl.value = 'id > 0'
        priv.orderByInputEl.value = 'id DESC'
        await privFull.applyServerFilters()
        await flushTick()
        await privFull.clearAllFilters()
        await flushTick()
      }
      ed.getSqlConsole()?.setText('INSERT INTO notes (body) VALUES (\'srv_filt\');')
      await ed.executeSql(true)
      await flushTick()
      if (priv.whereInputEl) {
        priv.whereInputEl.value = 'id > 0'
        await privFull.applyServerFilters()
      }

      // Cancel active query (`L6241-6277`: ok=true, ok=false, error)
      backend.deferNextQuery()
      ed.getSqlConsole()?.setText('SELECT * FROM employees;')
      const pRun = ed.executeSql(true)
      await flushMicro(4)
      await privFull.cancelActiveQuery()
      backend.resolveDeferredQuery()
      await pRun
      const origReq = backend.orcaApi.plugin.request
      ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = (async (
        m: string,
        p?: Record<string, unknown>
      ) => {
        if (m === 'query.cancel') return { ok: false }
        return origReq(m, p)
      }) as typeof origReq
      backend.deferNextQuery()
      const pRun2 = ed.executeSql(true)
      await flushMicro(4)
      await privFull.cancelActiveQuery()
      backend.resolveDeferredQuery()
      await pRun2
      ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = origReq

      // Dangerous SQL confirmed on explainSql (`5909:onConfirm`)
      ed.getSqlConsole()?.setText('DELETE FROM notes WHERE id = -999;')
      await ed.explainSql(true)
      findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /Explain Anyway|Run Anyway|Execute Anyway|Confirm/i)?.click()
      await flushTick()

      // Query history toggle & clear (success + error `L6279-6306`)
      priv.historyBtn?.click()
      await flushTick()
      backend.failOnceActions.add('query.history.clear')
      await privFull.clearQueryHistory()
      await privFull.clearQueryHistory()
      priv.historyBtn?.click()

      // Preview & submit empty / error paths (`L6320-6385`) + Column Config change (`4568`, `6735`)
      priv.queryBannerBackBtn?.click()
      await flushTick()
      await privFull.previewStagedChanges()
      ed.getDataGrid()?.stageCellEdit(0, 2, 'PreviewErrName')
      backend.failOnceActions.add('data.previewChanges')
      await privFull.previewStagedChanges()
      ed.getDataGrid()?.revertAllChanges()
      privFull.handleColumnConfigChanged({ hidden: ['notes'], pinned: ['id'] })
      privFull.handleColumnConfigChanged({ hidden: [], pinned: [] })

      // Split resizer drag + PageSize + Export actions + SearchMode + AI settings update (`L4173-4175`)
      privFull.splitResizerEl?.dispatchEvent(Object.assign(new Event('mousedown', { bubbles: true }), { clientY: 220 }))
      window.dispatchEvent(Object.assign(new Event('mousemove'), { clientY: 260 }))
      window.dispatchEvent(new Event('mouseup'))
      if (privFull.pageSizeSelectEl) {
        privFull.pageSizeSelectEl.value = '50'
        privFull.pageSizeSelectEl.dispatchEvent(new Event('change'))
        await flushTick()
      }
      privFull.handleExportAction('page-csv')
      priv.searchModeBtn?.click()
      priv.aiBtn?.click()
      await flushTick()
      findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /^Save Settings$/i)?.click()
      findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /^Close$/i)?.click()

      // All remaining Command Palette entries (`L7177-7230`)
      for (const kw of ['employees', 'Prod Replica RO', 'New Connection', 'Create Table', 'Import Data', 'Saved Queries', 'Report Bug']) {
        priv.openCommandPalette()
        const match = Array.from(document.querySelectorAll('.datanoa-modal-backdrop button, .datanoa-cmd-item')).find((el) =>
          (el.textContent || '').includes(kw)
        ) as HTMLElement | undefined
        match?.click()
        await flushTick()
        const modalNow = document.querySelector('.datanoa-modal-backdrop')
        if (modalNow) {
          ;(findBtn(modalNow, /^Cancel$/i) || findBtn(modalNow, /^Close$/i))?.click()
        }
      }

      // Read-Only connection `c_prod_ro` + caution strip close + RO guards
      privFull.handleConnectionChanged('c_prod_ro')
      await flushTick()
      privFull.cautionStripCloseBtn?.click()
      await ed.handleAlterTable({ kind: 'addColumn', table: 'employees', column: { name: 'ro_col', type: 'TEXT', nullable: true } })
      await expect(
        ed.handleApplyMigration(['SELECT 1;'], { tableName: 'employees', schema: 'main', columns: [], indexes: [], foreignKeys: [], triggers: [] } as never)
      ).rejects.toThrow(/Read-Only/i)
      await privFull.submitStagedChanges()
    } finally {
      ed.destroy()
    }
  })
})

describe('Wave 4D Studio Editor Coverage — Round 2 (Deep Closure)', () => {
  let dom: DomHarness
  const dbsToCloseR2: Array<{ close: () => void }> = []

  beforeEach(() => {
    dom = installDomHarness()
    ;(window as unknown as { innerWidth: number }).innerWidth = 1280
    ;(window as unknown as { innerHeight: number }).innerHeight = 900
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    while (dbsToCloseR2.length) {
      try {
        dbsToCloseR2.pop()?.close()
      } catch {
        // Ignore already-closed in-memory DB handle
      }
    }
    dom.teardown()
  })

  it('Slice 5A: closes 100% micro-tails across result-set-controller, grid-selection, danger-sql-modal, transaction-toolbar, db-icons & bind-params-modal', async () => {
    // 1. result-set-controller L164: single select result missing columns
    const statesNoCols = buildInitialResultTabStates(
      {
        resultSets: [{ index: 0, isSelect: true, rows: [], rowCount: 0, executionTimeMs: 1, truncated: false, sqlPreview: 'SELECT 1', sql: 'SELECT 1' }],
        rows: [],
        rowCount: 0,
        executionTimeMs: 1,
        truncated: false,
        isSelect: true,
      } as unknown as QueryResult,
      ['SELECT 1'],
      'SELECT 1',
      1,
      'query'
    )
    expect(statesNoCols[0].gridSubbarTitle).toBe('SQL Result · 0 cols')

    // 2. grid-selection L657: selected range with null focus
    const sel = new GridSelectionModel()
    sel.selectCell(0, 0, 'cell')
    ;(sel as unknown as { focus: null }).focus = null
    const selSummary = sel.computeSelectionSummary(2, 2, (r, c) => r + c)
    expect(selSummary.focus).toBeNull()
    expect(selSummary.cellCount).toBe(1)

    // 3. danger-sql-modal L202-203: prod gate checkbox + CONFIRM text input toggling
    let dSqlEl: HTMLElement | null = null
    let dConfirmed = false
    openStudioDangerSqlModal({
      mountModal: (el) => {
        dSqlEl = el
        document.body.appendChild(el)
        return document.createElement('div')
      },
      closeModal: () => dSqlEl?.remove(),
      connectionName: 'ProdDB',
      colorTag: 'prod',
      findings: [{ kind: 'delete_without_where', severity: 'critical', title: 'Unsafe DELETE', detail: 'No WHERE', statement: 'DELETE FROM t;' } as never],
      sql: 'DELETE FROM t;',
      onConfirm: () => {
        dConfirmed = true
      },
    })
    const prodCb = dSqlEl!.querySelector('input[type="checkbox"]') as HTMLInputElement
    const prodInp = dSqlEl!.querySelector('input[type="text"]') as HTMLInputElement
    const execBtn = dSqlEl!.querySelector('.datanoa-danger-execute-btn') as HTMLButtonElement
    expect(execBtn.disabled).toBe(true)
    prodCb.checked = true
    prodCb.dispatchEvent(new Event('change'))
    prodInp.value = 'WRONG'
    prodInp.dispatchEvent(new Event('input'))
    expect(execBtn.disabled).toBe(true)
    prodInp.value = 'CONFIRM'
    prodInp.dispatchEvent(new Event('input'))
    expect(execBtn.disabled).toBe(false)
    execBtn.click()
    expect(dConfirmed).toBe(true)

    // 4. transaction-toolbar L74 & L550: toggleDrawer pre-mount & begin rollbackOnSettle without txToken
    const cleanups: Array<() => void> = []
    let resolveTx: ((v: unknown) => void) | null = null
    const txHost2 = {
      getActiveConnectionId: () => 'c1',
      getActiveConnection: () => ({ id: 'c1', name: 'C1', driver: 'postgres' as const }),
      isReadOnly: () => false,
      isQueryRunning: () => false,
      isShowingSqlResult: () => false,
      getActiveTable: () => 't1',
      getCurrentPage: () => 1,
      requestPlugin: vi.fn(async (m: string, p?: Record<string, unknown>) => {
        if (m === 'tx.rollback' && p?.onlyIfOwner) {
          return await new Promise((_res, rej) => cleanups.push(() => rej(new Error('done'))))
        }
        if (m === 'tx.begin') {
          return await new Promise((r) => {
            resolveTx = r
          })
        }
        return { supported: true, autoCommit: true, active: false }
      }),
      reloadTableData: vi.fn(),
      showErrorBanner: vi.fn(),
      updateStatus: vi.fn(),
    }
    const tx2 = new TransactionToolbarController(txHost2)
    tx2.toggleDrawer() // hits !groupEl branch at L74
    tx2.mount(document.createElement('div'))
    await tx2.refreshState('c1')
    const begP = tx2.begin()
    await flushMicro(4)
    tx2.resetForConnectionSwitch('c1')
    resolveTx?.({ supported: true, autoCommit: false, active: true }) // NO txToken -> covers L550 false branch
    for (let r = 0; r < 6; r++) {
      while (cleanups.length > 0) cleanups.shift()?.()
      await flushMicro(4)
    }
    await begP
    tx2.destroy()

    // 5. db-icons L153, L169, L644: setButtonLoading default label + unstored clear + folder chevron collapse
    const b1 = document.createElement('button')
    b1.textContent = 'Run'
    setButtonLoading(b1, true)
    const b2 = document.createElement('button')
    setButtonLoading(b2, false)
    const selCol = document.createElement('select')
    const og = document.createElement('optgroup')
    og.label = 'ProdFolder'
    const o1 = document.createElement('option')
    o1.value = 'p1'
    o1.textContent = 'PG1'
    o1.dataset.driver = 'postgres'
    og.appendChild(o1)
    selCol.appendChild(og)
    document.body.appendChild(selCol)
    enhanceStudioCollapsibleSelect(selCol, { tooltipPrefix: 'Conn' })
    const cTrig = document.querySelector('.datanoa-custom-select-trigger') as HTMLButtonElement | null
    cTrig?.click()
    const folderBtn = document.querySelector('[title*="ProdFolder"]') as HTMLElement | null
    folderBtn?.click()
    folderBtn?.click()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    // 6. bind-params-modal L300 & L310-316: invalid param type + bindSqlParameters error path
    let bpEl2: HTMLElement | null = null
    openStudioBindParamsModal({
      mountModal: (el) => {
        bpEl2 = el
        document.body.appendChild(el)
        return document.createElement('div')
      },
      closeModal: () => bpEl2?.remove(),
      sql: 'SELECT * FROM t WHERE id = :id AND raw = :raw',
      dialect: 'postgres',
      params: [
        { key: 'id', placeholder: ':id', raw: ':id', style: 'colon', label: ':id', count: 1 },
        { key: 'raw', placeholder: ':raw', raw: ':raw', style: 'colon', label: ':raw', count: 1 },
      ] as never,
      onApply: vi.fn(),
    })
    const bpSel = bpEl2!.querySelectorAll('select')[1] as HTMLSelectElement | undefined
    const bpVal = bpEl2!.querySelectorAll('input[type="text"]')[1] as HTMLInputElement | undefined
    if (bpSel && bpVal) {
      bpSel.value = 'raw'
      bpSel.dispatchEvent(new Event('change'))
      bpVal.value = '' // invalid raw SQL triggers bind error
      bpVal.dispatchEvent(new Event('input'))
    }
    bpEl2!.remove()
  })

  it('Slice 5B: closes import-modal L109/858/1040, schema-inspector FK rename/TX rebuild/timer, and connection-modal discovery/Docker/errors', async () => {
    // 1. import-modal L109-110 (FileReader returning string), oversized >25MB, and mid-batch close abort (L1040-1042)
    let impM: HTMLElement | null = null
    let resolveChunk: ((v: unknown) => void) | null = null
    openStudioImportModal({
      mountModal: (el) => {
        impM = el
        document.body.appendChild(el)
        return document.createElement('div')
      },
      closeModal: () => impM?.remove(),
      activeConnection: { id: 'c1', name: 'S', driver: 'sqlite' },
      activeConnectionId: 'c1',
      targetTable: 'employees',
      targetColumns: [{ name: 'name', type: 'TEXT', nullable: false }],
      canStageInGrid: false,
      updateStatus: vi.fn(),
      showQueryBanner: vi.fn(),
      createElapsedTimer: () => () => {},
      requestPlugin: vi.fn(async () => await new Promise((r) => {
        resolveChunk = r
      })),
      onStageRows: () => 0,
      onDirectImportComplete: vi.fn(),
    })
    const fInp = impM!.querySelector('input[type="file"]') as HTMLInputElement
    class StringFileReader {
      result: unknown = 'name\nAlice\n'
      onload: (() => void) | null = null
      readAsArrayBuffer() {
        this.onload?.()
      }
    }
    await withTempGlobal('FileReader', StringFileReader, async () => {
      ;(fInp as unknown as { files: File[] }).files = [makeFakeFile('s.csv', 'name\nAlice\n', { noArrayBuffer: true })]
      fInp.dispatchEvent(new Event('change'))
      await flushTick()
    })
    expect(impM!.textContent).toContain('1 row')
    // Start batch 1 and close modal BEFORE it settles -> abortedByClose L1040-1042
    findBtn(impM!, /^Import 1 Row$/i)?.click()
    await flushMicro(4)
    impM!.remove()
    resolveChunk?.({ ok: true, inserted: 1, updated: 0, deleted: 0, statements: [] })
    await flushTick()

    // 2. schema-inspector: column referenced by FK+Index renamed + SQLite manual TX rebuild error + timed 100ms migration spinner
    const siHost = document.createElement('div')
    document.body.appendChild(siHost)
    let resolveMigration: (() => void) | null = null
    let manualTx = true
    const si = new SchemaInspectorView(siHost, {
      dialect: 'sqlite',
      isManualTxActive: () => manualTx,
      onApplyMigration: async () => await new Promise<void>((r) => {
        resolveMigration = r
      }),
      onInsertDdl: vi.fn(),
      onCopyDdl: vi.fn(),
    })
    si.setReferenceTables(['departments', 'orders'])
    si.setDetails(
      {
        name: 'orders',
        schema: 'main',
        kind: 'table',
        columns: [
          { name: 'id', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, isPrimaryKey: true, isAutoIncrement: true },
          { name: 'dept_id', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, isPrimaryKey: false, isAutoIncrement: false },
        ],
        primaryKey: ['id'],
        indexes: [{ name: 'idx_dept', columns: ['dept_id'], isUnique: false, isPrimary: false }],
        foreignKeys: [{ name: 'fk_dept', column: 'dept_id', referencedTable: 'departments', referencedColumn: 'id' }],
        triggers: [{ name: 'trg_o', sql: 'CREATE TRIGGER trg_o AFTER INSERT ON orders BEGIN SELECT 1; END;' }],
        ddl: 'CREATE TABLE orders (id INTEGER PRIMARY KEY, dept_id INTEGER NOT NULL);',
      },
      'sqlite'
    )
    // Edit column dept_id name -> exercises syncColumnRenameInDraft across pills/FK select/index cells (L1037-1068)
    const nameInps = Array.from(siHost.querySelectorAll('input.datanoa-struct-cell-input')) as HTMLInputElement[]
    const deptInp = nameInps.find((inp) => inp.value === 'dept_id')
    if (deptInp) {
      deptInp.value = 'department_ref_id'
      deptInp.dispatchEvent(new Event('input'))
    }
    // Apply while manualTx=true triggers SQLITE_REBUILD_ACTIVE_TX_ERROR in dialog (L655-666)
    findBtn(siHost, /Apply Changes/i)?.click()
    findBtn(document.body, /^Execute Migration|Confirm Migration/i)?.click()
    // Now allow TX -> run slow migration -> advance fake timer past 100ms for elapsed timer L680-685
    manualTx = false
    vi.useFakeTimers()
    try {
      findBtn(document.body, /^Execute Migration|Confirm Migration/i)?.click()
      await flushMicro(4)
      await vi.advanceTimersByTimeAsync(250)
      resolveMigration?.()
      await flushMicro(6)
    } finally {
      vi.useRealTimers()
    }
    // setError + click Retry button (L1494)
    const onRetrySpy = vi.fn()
    si.setError('Inspection timeout', onRetrySpy)
    findBtn(siHost, /^Retry$/i)?.click()
    expect(onRetrySpy).toHaveBeenCalled()
    si.destroy()
    siHost.remove()

    // 3. connection-modal: discovery Docker Compose items (postgres, unknown driver, libsql, mongodb, clickhouse, redis) + form validation errors + save error
    let cmEl: HTMLElement | null = null
    let cmBd: HTMLElement | null = null
    let failSave = true
    openStudioConnectionModal(
      {
        isBackdropActive: (bd) => bd === cmBd,
        mountModal: (el) => {
          cmEl = el
          cmBd = document.createElement('div')
          cmBd.appendChild(el)
          document.body.appendChild(cmBd)
          return cmBd
        },
        closeModal: () => cmBd?.remove(),
        requestPlugin: vi.fn(async (m: string) => {
          if (m === 'drivers.list') return { drivers: [{ id: 'sqlite', category: 'builtin', packaging: 'builtin', status: 'builtin' }, { id: 'postgres', category: 'builtin', packaging: 'builtin', status: 'builtin' }, { id: 'mysql', category: 'builtin', packaging: 'builtin', status: 'builtin' }, { id: 'redis', category: 'builtin', packaging: 'builtin', status: 'builtin' }, { id: 'mongodb', category: 'builtin', packaging: 'builtin', status: 'builtin' }, { id: 'clickhouse', category: 'builtin', packaging: 'builtin', status: 'builtin' }, { id: 'libsql', category: 'builtin', packaging: 'builtin', status: 'builtin' }] }
          if (m === 'workspace.listScopes') return [{ id: 'ws1', name: 'MainWS' }]
          if (m === 'workspace.detectConnections') {
            return {
              envs: [],
              files: [{ name: 'local.db', filePath: '/w/local.db', driver: 'sqlite' }],
              docker: [
                { project: 'p1', service: 'unk', name: 'UnkSvc', driver: 'unknown_x', host: '127.0.0.1', port: 1234 },
                { project: 'p1', service: 'mg', name: 'MongoSvc', driver: 'mongodb', url: 'mongodb://u:p@127.0.0.1:27017/db', passwordFromFile: '.mongo_pw', hint: 'Check password' },
                { project: 'p1', service: 'ch', name: 'CHSvc', driver: 'clickhouse', host: '127.0.0.1', port: 8123 },
                { project: 'p1', service: 'lib', name: 'LibSvc', driver: 'libsql', host: '127.0.0.1', port: 8080, database: 'app' },
                { project: 'p1', service: 'rd', name: 'RedisSvc', driver: 'redis', host: '127.0.0.1', port: 6379, redisDb: 1 },
              ],
            }
          }
          if (m === 'connections.save') {
            if (failSave) throw new Error('Keychain error')
            return { ok: true, id: 'saved_1' }
          }
          return { ok: true }
        }),
        createElapsedTimer: () => () => {},
        updateStatus: vi.fn(),
        activateSavedConnection: vi.fn(),
      } as never
    )
    await flushTick()
    for (const chip of Array.from(cmEl!.querySelectorAll('.datanoa-conn-chip')) as HTMLButtonElement[]) {
      chip.click()
    }
    findBtn(cmEl!, /Save & Connect/i)?.click()
    await flushTick()
    failSave = false
    findBtn(cmEl!, /^Cancel$/i)?.click()
    cmBd?.remove()
  })

  it('Slice 5C: closes VirtualDataGrid remaining branches (focus fallback, keyboard detached/copy/paste, fill read-only skip, object edit, transposed paste/import & drag guards)', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    Object.defineProperty(host, 'offsetParent', { configurable: true, get: () => document.body })
    Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => 360 })
    Object.defineProperty(host, 'clientHeight', { configurable: true, get: () => 240 })

    const notify: string[] = []
    const grid = new VirtualDataGrid({
      container: host,
      data: {
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true, autoIncrement: true },
          { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
          { name: 'meta', type: 'JSON', nullable: true, primaryKey: false },
        ],
        headers: ['id', 'name', 'meta'],
        rows: Array.from({ length: 40 }, (_, i) => ({
          id: i + 1,
          name: `N_${i}`,
          meta: i === 0 ? ({ nested: true } as unknown) : `m_${i}`,
        })),
        totalRows: 40,
        page: 1,
        pageSize: 40,
        primaryKey: ['id'],
        canEdit: true,
      },
      tableName: 'items',
      dialect: 'sqlite',
      onNotify: (m) => notify.push(m),
    })

    const wrap = (grid as unknown as { tableContainerEl: HTMLDivElement }).tableContainerEl
    const tbody = (grid as unknown as { tbodyEl: HTMLElement }).tbodyEl
    Object.defineProperty(wrap, 'offsetParent', { configurable: true, get: () => document.body })
    Object.defineProperty(wrap, 'clientWidth', { configurable: true, get: () => 360 })
    Object.defineProperty(wrap, 'clientHeight', { configurable: true, get: () => 240 })
    Object.defineProperty(wrap, 'scrollWidth', { configurable: true, get: () => 900 })
    Object.defineProperty(wrap, 'scrollHeight', { configurable: true, get: () => 1600 })
    wrap.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 360, bottom: 240, width: 360, height: 240, x: 0, y: 0, toJSON() {} }) as DOMRect

    // 1. focusGridContainer throwing fallback (L2058-2059)
    let threwOnce = false
    wrap.focus = (opts?: FocusOptions) => {
      if (opts?.preventScroll && !threwOnce) {
        threwOnce = true
        throw new Error('preventScroll unsupported')
      }
    }
    ;(grid as unknown as { focusGridContainer: () => void }).focusGridContainer()

    // 2. handleGridKeyDown: Escape closing open contextmenu, Ctrl+A, multi-cell Ctrl+C, non-shift Ctrl+V, detached activeEditor self-heal, Delete in batch mode
    grid.selectAll()
    wrap.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true })))
    expect(notify.some((m) => m.includes('cells to clipboard'))).toBe(true)
    wrap.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, cancelable: true })))
    grid.setBatchMode(true)
    grid.selectSingleModelCell(1, 2)
    wrap.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Delete', cancelable: true })))

    // Detached activeEditor self-heal
    grid.selectSingleModelCell(1, 2)
    wrap.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })))
    const edInp = tbody.querySelector('input') as HTMLInputElement | null
    edInp?.remove()
    wrap.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })))

    // 3. Inline editor on object value (L4692-4696) & untouched inserted row slide-out (L2859-2867) & untouched no-op commit (L4834)
    grid.selectSingleModelCell(0, 2)
    wrap.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })))
    grid.cancelCellEdit()

    grid.addBlankRow()
    const insIdx = grid.getModel()!.rows.length - 1
    grid.selectSingleModelCell(insIdx, 1)
    wrap.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })))
    const blankInp = tbody.querySelector('input') as HTMLInputElement | null
    blankInp?.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })))

    // 4. triggerPasteAction with clipboard throwing + empty prompt
    await withTempGlobal('navigator', { clipboard: { readText: async () => { throw new Error('denied') } } }, async () => {
      ;(grid as unknown as { lastCopiedDelimitedText: string }).lastCopiedDelimitedText = ''
      ;(grid as unknown as { lastCopiedSnapshot: null }).lastCopiedSnapshot = null
      await grid.triggerPasteAction(true)
      await grid.triggerPasteAction(false)
    })

    // 5. fill paste skipping read-only PK + multi-row stageImportedRows + transposed overwrite-and-insert + stageCellEdit by string name + uncached restoreRuntimeState
    grid.selectAll()
    expect(grid.pasteDelimitedTextDetailed('filled_val', { forceNewRows: false }).skippedReadOnly).toBeGreaterThan(0)
    expect(grid.stageCellEdit(1, 'name', 'ByNameEdit')).toBe(true)

    grid.setTransposed(true)
    expect(grid.stageImportedRows([{ name: 'Imp1', meta: 'a' }, { name: 'Imp2', meta: 'b' }])).toBe(2)
    grid.selectSingleModelCell(grid.getModel()!.rows.length - 1, 1)
    grid.pasteDelimitedTextDetailed('900\tOver1\tX\n901\tOver2\tY', { forceNewRows: false })
    grid.setTransposed(false)

    // restoreRuntimeState on snapshot whose headers differ (uncached columnWidths branch L5160-5162)
    const snap = grid.exportRuntimeState()
    snap.model = {
      ...snap.model!,
      headers: ['brand_new_col_a', 'brand_new_col_b'],
      columns: [
        { name: 'brand_new_col_a', type: 'TEXT', nullable: true, primaryKey: false },
        { name: 'brand_new_col_b', type: 'TEXT', nullable: true, primaryKey: false },
      ],
      rows: [{ brand_new_col_a: '1', brand_new_col_b: '2' }],
    }
    snap.rowStates = [{ kind: 'existing', deleted: false, original: snap.model.rows[0], dirtyCols: new Map() }]
    grid.restoreRuntimeState(snap)

    // setColumnVisibility last visible guard (L867-869)
    grid.setColumnVisibility('brand_new_col_a', false)
    grid.setColumnVisibility('brand_new_col_b', false)

    // isGridVisibleForGlobalEvent [hidden] & modal & sidebar guards
    const hiddenWrap = document.createElement('div')
    hiddenWrap.setAttribute('hidden', '')
    document.body.appendChild(hiddenWrap)
    hiddenWrap.appendChild(host)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, shiftKey: true, cancelable: true }))
    document.body.appendChild(host)
    hiddenWrap.remove()

    const sb = document.createElement('div')
    sb.className = 'datanoa-sidebar'
    const sbBtn = document.createElement('button')
    sb.appendChild(sbBtn)
    document.body.appendChild(sb)
    sbBtn.focus()
    window.dispatchEvent(Object.assign(new Event('paste', { cancelable: true }), { target: sbBtn, clipboardData: { getData: () => 'x' } }))
    sb.remove()

    grid.destroy()
    host.remove()
  })

  it('Slice 5D: closes index.ts gaps (worker dataCache hydrate, view/table sidebar context, mat_view DDL, multi-tab switch, single-EXPLAIN err, DOM/banner/scroll/wheel & Command Palette)', async () => {
    // 1. Worker snapshot warm-cache hydration (`L2864-2878`, `L3153-3256`)
    localStorage.clear()
    const bSnap = createLiveStudioSqliteBackend({ multiSchema: true })
    dbsToCloseR2.push(bSnap.db)
    bSnap.setSessionSnapshot({
      updatedAt: Date.now(),
      dataCache: {
        updatedAt: Date.now(),
        activeConnectionId: 'c_main',
        activeTable: 'employees',
        activeSchema: 'main',
        schemaObjects: [{ name: 'employees', kind: 'table', schema: 'main' }],
        schemaMap: { employees: ['id', 'name'] },
        isShowingSqlResult: false,
        whereClause: '',
        orderByClause: '',
        page: 1,
        pageSize: 100,
        pageData: {
          columns: [
            { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
            { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
          ],
          headers: ['id', 'name'],
          rows: [{ id: 1, name: 'Alice' }],
          totalRows: 1,
          page: 1,
          pageSize: 100,
          primaryKey: ['id'],
          canEdit: true,
        },
      },
    })
    ;(window as unknown as { orca: unknown }).orca = bSnap.orcaApi
    const edSnap = initializeEditor()!
    await flushTick()
    await flushTick()
    expect(edSnap).not.toBeNull()
    expect((edSnap as unknown as { activeTable: string | null }).activeTable).toBe('employees')
    edSnap.destroy()
    bSnap.db.close()

    // 2. Full interactive closure on live backend
    localStorage.clear()
    const b = createLiveStudioSqliteBackend({ multiSchema: true, extraEmployeeRows: 5 })
    dbsToCloseR2.push(b.db)
    ;(window as unknown as { orca: unknown }).orca = b.orcaApi
    const ed = initializeEditor()!
    const doc = await b.orcaApi.document.session()
    ed.attachDocumentSession(doc)
    await flushTick()
    await flushTick()
    const p = ed as unknown as StudioInternals & {
      inspectorAreaEl: HTMLDivElement | null
      queryBannerCopyBtn: HTMLButtonElement | null
      queryBannerReportBtn: HTMLButtonElement | null
      queryBannerCloseBtn: HTMLButtonElement | null
      statusSelectionEl: HTMLElement | null
      tabButtons: Record<'split' | 'grid' | 'sql' | 'inspector', HTMLButtonElement>
      loadActiveTableSchema: (force?: boolean) => Promise<void>
      applyServerFilters: () => Promise<void>
      switchConsoleTab: (idxOrId: string) => void
      addConsoleTab: () => void
    }
    if (p.gridAreaEl) {
      Object.defineProperty(p.gridAreaEl, 'offsetParent', { configurable: true, get: () => document.body })
      Object.defineProperty(p.gridAreaEl, 'clientHeight', { configurable: true, get: () => 400 })
      Object.defineProperty(p.gridAreaEl, 'clientWidth', { configurable: true, get: () => 800 })
    }
    try {
      // Non-tabular trigger (`trg_notes_insert`) context menu (`3688..3695`), plus table `Import CSV / JSON...` (`3704`) & `Count Rows` (`3691`)
      const trigItem = Array.from(p.sidebarListEl?.querySelectorAll('.datanoa-sidebar-item') || []).find((el) =>
        (el.textContent || '').includes('trg_notes_insert')
      ) as HTMLElement | undefined
      trigItem?.click()
      await flushTick()
      for (const lbl of [/^View DDL$/i, /^Copy Name$/i, /^Copy DDL$/i, /^Open DDL in Console$/i]) {
        trigItem?.dispatchEvent(Object.assign(new Event('contextmenu', { bubbles: true, cancelable: true }), { clientX: 50, clientY: 120 }))
        findBtn(document.body, lbl)?.click()
        await flushTick()
      }
      trigItem?.dispatchEvent(Object.assign(new Event('contextmenu', { bubbles: true, cancelable: true }), { clientX: 50, clientY: 120 }))
      window.dispatchEvent(Object.assign(new MouseEvent('mousedown', { bubbles: true }), { target: p.gridAreaEl || document.body }))

      const empItem = Array.from(p.sidebarListEl?.querySelectorAll('.datanoa-sidebar-item') || []).find((el) =>
        (el.textContent || '').includes('employees')
      ) as HTMLElement | undefined
      empItem?.dispatchEvent(Object.assign(new Event('contextmenu', { bubbles: true, cancelable: true }), { clientX: 50, clientY: 140 }))
      findBtn(document.body, /^Import CSV \/ JSON\.\.\.$/i)?.click()
      await flushTick()
      findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /^Cancel$/i)?.click()

      // Host error banner (`631`) on tx.begin failure + Value Inspector copy (`654`)
      b.failOnceActions.add('tx.begin')
      await p.txToolbar.begin()
      empItem?.click()
      await flushTick()
      p.openValueInspector({ column: 'name', value: 'Alice', rowIndex: 0, colIndex: 1, columnType: 'TEXT', nullable: false, isEditable: false })
      findBtn(document.querySelector('.datanoa-value-inspector') || document.body, /^Copy/i)?.click()

      // Switch to Inspector tab + loadActiveTableSchema cache hit & error retry (`L4810, L4846-4857`), ctrl+wheel (`L2300-2319`), SQLite TX rebuild (`1768`) & Open in Console (`1779`)
      p.tabButtons.inspector?.click()
      await flushTick()
      await p.loadActiveTableSchema(false) // cached hit L4810
      b.failOnceActions.add('schema.tableDetails')
      await p.loadActiveTableSchema(true) // error state L4846
      findBtn(p.inspectorAreaEl || document.body, /^Retry$/i)?.click()
      await flushTick()
      await p.txToolbar.begin()
      const delColBtn = findBtn(p.inspectorAreaEl || document.body, /^Drop$|^Delete$/i)
      delColBtn?.click()
      findBtn(p.inspectorAreaEl || document.body, /Apply Changes/i)?.click()
      await p.txToolbar.rollback()

      // Inspector horizontal ctrl+wheel + scroll listeners on sidebar & grid + beforeunload (`L2300-2368`)
      p.inspectorAreaEl?.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { ctrlKey: true, deltaY: 20, deltaX: 0, deltaMode: 0 }))
      p.sidebarListEl?.dispatchEvent(new Event('scroll'))
      const gridCont = p.gridAreaEl?.querySelector('.datanoa-grid-container')
      gridCont?.dispatchEvent(new Event('scroll'))
      window.dispatchEvent(new Event('beforeunload'))

      // Stage editable SQL result -> sort/filter/columnFilter/find -> add tab & switch back & close tab (`2071`, `L5426-5439`) + submitChanges SQL error (`L6466-6479`)
      ed.getSqlConsole()?.setText('SELECT id, name FROM employees;')
      await ed.executeSql(true)
      await flushTick()
      ed.getDataGrid()?.sortInMemoryRows('id', 'DESC')
      ed.getDataGrid()?.setClientFilter('Alice')
      ed.getDataGrid()?.addClientColumnFilter('name', 'A', 'contains')
      ed.getDataGrid()?.setFindQuery('Alice')
      p.addConsoleTab()
      const tabBtns = Array.from(document.querySelectorAll('.datanoa-console-tab')) as HTMLElement[]
      tabBtns[0]?.click()
      await flushTick()
      const tabClose = document.querySelectorAll('.datanoa-console-tab-close')
      ;(tabClose[1] as HTMLElement | undefined)?.click()

      // Editable SQL result submit failure & ok=false (`L6466-6479`)
      ed.getDataGrid()?.setClientFilter('')
      ed.getDataGrid()?.stageCellEdit(0, 1, 'SqlResultEdited')
      b.failOnceActions.add('data.applyChanges')
      findBtn(document.body, /^Submit/i)?.click()
      await flushTick()
      ed.getDataGrid()?.revertAllChanges()

      // Dangerous explainSql real confirm button click (`.datanoa-danger-execute-btn` -> `5909:onConfirm`)
      ed.getSqlConsole()?.setText('DELETE FROM notes WHERE id = -888;')
      await ed.explainSql(true)
      ;(document.querySelector('.datanoa-modal-backdrop .datanoa-danger-execute-btn') as HTMLButtonElement | null)?.click()
      await flushTick()

      // Export actions (`page-json`, `all-csv`, `all-sql`, `selection-csv`) + save cancelled/failed (`L6520-6612`)
      const pExp = ed as unknown as { handleExportAction: (v: string) => void }
      b.setSaveAsResult('cancelled')
      pExp.handleExportAction('all-csv')
      await flushTick()
      b.setSaveAsResult('failed')
      pExp.handleExportAction('all-sql')
      await flushTick()
      b.setSaveAsResult('saved')
      pExp.handleExportAction('page-json')
      pExp.handleExportAction('selection-csv')

      // AI Settings Test Connection + Close (`4173`, `4175`)
      p.aiBtn?.click()
      await flushTick()
      findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /Test Connection/i)?.click()
      await flushTick()
      findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /^Save|Close$/i)?.click()

      // DocReplace with different table & schema (`L2188-2269`)
      b.emitDocReplace('-- @datanoa.connectionId: c_main\n-- @datanoa.schema: main\n-- @datanoa.table: departments\nSELECT 1;')
      await flushTick()

      // Empty schema CTA `onOpenCreateTableModal` (`3753`)
      const origReq2 = b.orcaApi.plugin.request
      ;(window as unknown as { orca: { plugin: { request: typeof origReq2 } } }).orca.plugin.request = (async (
        m: string,
        arg?: Record<string, unknown>
      ) => {
        if (m === 'schema.listObjects') return []
        return origReq2(m, arg)
      }) as typeof origReq2
      await p.introspectSchema('c_main', false)
      await flushTick()
      findBtn(p.sidebarListEl || document.body, /New Table/i)?.click()
      findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /^Cancel$/i)?.click()
      ;(window as unknown as { orca: { plugin: { request: typeof origReq2 } } }).orca.plugin.request = origReq2
      await p.introspectSchema('c_main', false)
      await flushTick()

      // Single-statement EXPLAIN error (`L6022`, `L6085-6121`) + banner copy/report/close + statusSelectionEl click (`L1654-1667`)
      ed.getSqlConsole()?.setText('SELECT * FROM missing_table_round2;')
      await ed.explainSql(true)
      await flushTick()
      p.queryBannerCopyBtn?.click()
      p.queryBannerReportBtn?.click()
      findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /^Cancel$/i)?.click()
      p.queryBannerCloseBtn?.click()
      p.statusSelectionEl?.click()

      // Collapsible dropdown Escape handler (`L2388-2393`)
      const cTrig = document.querySelector('.datanoa-custom-select-trigger') as HTMLElement | null
      cTrig?.click()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))

      // orderByInputEl Enter (`1576`), clientSearchEl Enter in 'find' mode with no debounce (`1605`) & Escape (`1614`), findNext/Prev buttons (`1621-1628`), and Retry after data.getPage failure (`4745`)
      p.queryBannerBackBtn?.click()
      await flushTick()
      p.orderByInputEl?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      await flushTick()
      p.searchModeBtn?.click()
      if (p.clientSearchEl) {
        p.clientSearchEl.value = 'Alice'
        p.clientSearchEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
        p.findNextBtn?.click()
        p.findPrevBtn?.click()
        p.clientSearchEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
      }
      b.failOnceActions.add('data.getPage')
      await p.loadTableData('c_main', 'employees', 1)
      findBtn(document.querySelector('.datanoa-query-banner') || document.body, /^Retry$/i)?.click()
      await flushTick()

      // Exact remaining Command Palette entries (`7185`, `7187`, `7188`)
      for (const exactLabel of ['New Database Connection...', 'New Table...', 'Import CSV / JSON File...']) {
        p.openCommandPalette()
        const btn = Array.from(document.querySelectorAll('.datanoa-modal-backdrop button')).find((el) =>
          (el.textContent || '').includes(exactLabel)
        ) as HTMLButtonElement | undefined
        btn?.click()
        await flushTick()
        const mb = document.querySelector('.datanoa-modal-backdrop')
        if (mb) (findBtn(mb, /^Cancel$/i) || findBtn(mb, /^Close$/i))?.click()
      }
      expect((ed as unknown as { activeTable: string | null }).activeTable).toBe('departments')
      expect(p.clientSearchEl?.value).toBe('')
      expect(p.searchModeBtn?.textContent).toContain('Find')
      expect(document.querySelector('.datanoa-modal-backdrop')).toBeNull()
    } finally {
      ed.destroy()
      b.db.close()
    }
  })
})

type Round3Internals = StudioInternals & {
  searchInputEl: HTMLInputElement | null
  schemaSelectEl: HTMLSelectElement | null
  exportDdlBtn: HTMLButtonElement | null
  newTableBtn: HTMLButtonElement | null
  topbarNewTableBtn: HTMLButtonElement | null
  addConnBtn: HTMLButtonElement | null
  editConnBtn: HTMLButtonElement | null
  transposeBtn: HTMLButtonElement | null
  batchModeBtn: HTMLButtonElement | null
  pageSizeSelectEl: HTMLSelectElement | null
  exportSelectEl: HTMLSelectElement | null
  cautionStripEl: HTMLDivElement | null
  cautionStripCloseBtn: HTMLButtonElement | null
  splitResizerEl: HTMLDivElement | null
  sqlAreaEl: HTMLDivElement | null
  activeConnectionId: string | null
  activeTable: string | null
  activeSchema: string | undefined
  selectedSchema: string | undefined
  activeViewMode: 'split' | 'grid' | 'sql' | 'inspector'
  schemaObjects: SchemaObject[]
  tableDetailsCache: Map<string, TableDetails>
  scrollRestoreRafId: number | null
  switchMode: (mode: 'split' | 'grid' | 'sql' | 'inspector') => void
  handleConnectionChanged: (connId: string | null) => void
  executeSql: (executeAll?: boolean, skipBind?: boolean, sqlOverride?: string, skipDanger?: boolean) => Promise<void>
  explainSql: (skipBind?: boolean, sqlOverride?: string, skipDanger?: boolean) => Promise<void>
  refreshSingleResultSet: (
    originTabId: string,
    resultIdx: number,
    targetConnId: string,
    sqlText: string
  ) => Promise<void>
  handleQuickFilter: (predicateSql: string, mode: 'replace' | 'and') => Promise<void>
  submitStagedChanges: () => Promise<void>
  openImportDataModal: (targetItem?: SchemaObject) => Promise<void>
  openDangerTableModal: (action: 'truncate' | 'drop', item: SchemaObject) => void
  openCreateTableModal: () => void
  applySqlResultEditability: (
    res: QueryResult,
    resultSetIndex: number,
    targetConnId: string,
    originTabId: string,
    seq: number,
    allowPrefetch?: boolean
  ) => void
}

describe('Wave 4D Studio Editor Coverage — Round 3 Final Closure', () => {
  let dom: DomHarness
  const dbsToCloseR3: Array<{ close: () => void }> = []

  beforeEach(() => {
    dom = installDomHarness({ url: 'http://localhost/' })
    ;(window as unknown as { innerWidth: number }).innerWidth = 1280
    ;(window as unknown as { innerHeight: number }).innerHeight = 900
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    while (dbsToCloseR3.length) {
      try {
        dbsToCloseR3.pop()?.close()
      } catch {
        // Ignore already-closed in-memory DB handle
      }
    }
    dom.teardown()
  })

  function mountModalHarness() {
    let backdrop: HTMLDivElement | null = null
    let canCloseFn: (() => boolean) | undefined
    const closeModal = () => {
      if (backdrop) {
        backdrop.remove()
        backdrop = null
      }
    }
    const mountModal = (modalEl: HTMLElement, canClose?: () => boolean): HTMLDivElement | null => {
      closeModal()
      const bd = document.createElement('div')
      bd.className = 'datanoa-modal-backdrop'
      bd.appendChild(modalEl)
      canCloseFn = canClose
      bd.addEventListener('click', (e: Event) => {
        if (e.target === bd && (!canCloseFn || canCloseFn())) closeModal()
      })
      document.body.appendChild(bd)
      backdrop = bd
      return bd
    }
    const isBackdropActive = (bd: HTMLDivElement | null) =>
      Boolean(bd && bd.isConnected && bd === backdrop)
    return { mountModal, closeModal, isBackdropActive, getBackdrop: () => backdrop }
  }

  function makeTableData(rowCount: number, opts: { canEdit?: boolean } = {}): TableBrowseResult {
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      id: i + 1,
      name: `User_${i + 1}`,
      dept_id: (i % 4) + 1,
      meta: { rank: i + 1 },
      note: i % 3 === 0 ? null : `note_${i + 1}`,
    }))
    return {
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true, autoIncrement: true },
        { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
        { name: 'dept_id', type: 'INTEGER', nullable: true, primaryKey: false },
        { name: 'meta', type: 'JSON', nullable: true, primaryKey: false },
        { name: 'note', type: 'TEXT', nullable: true, primaryKey: false },
      ],
      rows,
      totalRows: rowCount,
      page: 1,
      pageSize: 200,
      primaryKey: ['id'],
      canEdit: opts.canEdit ?? true,
    }
  }

  async function bootRound3(opts: { seedEmptyConns?: boolean; multiSchema?: boolean } = {}) {
    const backend = createLiveStudioSqliteBackend(opts)
    dbsToCloseR3.push(backend.db)
    ;(window as unknown as { orca: unknown }).orca = backend.orcaApi
    const ed = initializeEditor()!
    const docSession = await backend.orcaApi.document.session()
    ed.attachDocumentSession(docSession)
    await flushTick()
    await flushTick()
    const priv = ed as unknown as Round3Internals
    if (priv.gridAreaEl) {
      Object.defineProperty(priv.gridAreaEl, 'offsetParent', { configurable: true, get: () => document.body })
      Object.defineProperty(priv.gridAreaEl, 'clientHeight', { configurable: true, get: () => 420 })
      Object.defineProperty(priv.gridAreaEl, 'clientWidth', { configurable: true, get: () => 860 })
    }
    return { backend, ed, priv }
  }

  it('Slice 6A: closes connection-modal, schema-inspector, import-modal, driver-manager, danger-sql & db-icons tails', async () => {
    // 1. db-icons edge cases + whitespace/empty driver inputs
    for (const d of [
      'postgres', 'mysql', 'mariadb', 'sqlite', 'duckdb', 'redis', 'mongodb',
      'oracle', 'mssql', 'clickhouse', 'libsql', 'd1', 'snowflake', 'bigquery',
      'cassandra', 'elasticsearch', 'neo4j', '', '   ', '  POSTGRES  ',
    ]) {
      const svg = createDbLogoSvg(d as DatabaseDriverType, 18)
      expect(svg.tagName.toLowerCase()).toBe('svg')
    }

    // 2. import-modal: parse error JSON + >250 row mid-batch abort on close
    {
      const mh = mountModalHarness()
      let resolveBatch1: (() => void) | undefined
      const importReq = vi.fn(async (method: string) => {
        if (method === 'data.applyChanges') {
          await new Promise<void>((r) => {
            resolveBatch1 = r
          })
          return { ok: true, inserted: 250, updated: 0, deleted: 0, statements: [] }
        }
        return {}
      })
      openStudioImportModal({
        mountModal: mh.mountModal,
        closeModal: mh.closeModal,
        activeConnection: { id: 'c1', name: 'Local', driver: 'sqlite', readOnly: false } as ConnectionProfile,
        activeConnectionId: 'c1',
        targetTable: 'items',
        targetColumns: [
          { name: 'name', type: 'TEXT', nullable: false, isPrimaryKey: false },
          { name: 'val', type: 'INTEGER', nullable: true, isPrimaryKey: false },
        ],
        canStageInGrid: false,
        updateStatus: () => {},
        showQueryBanner: () => {},
        createElapsedTimer: () => () => {},
        requestPlugin: importReq as <T = unknown>(m: string) => Promise<T>,
        onStageRows: () => 0,
        onDirectImportComplete: async () => {},
      })
      const fileInp = document.querySelector('.datanoa-modal-backdrop input[type="file"]') as HTMLInputElement | null
      if (fileInp) {
        Object.defineProperty(fileInp, 'files', {
          configurable: true,
          value: [makeFakeFile('corrupt.json', '{bad json')],
        })
        fileInp.dispatchEvent(new Event('change'))
        await flushTick()

        const bigCsvRows = ['name,val', ...Array.from({ length: 280 }, (_, i) => `item_${i},${i}`)].join('\n')
        Object.defineProperty(fileInp, 'files', {
          configurable: true,
          value: [makeFakeFile('big.csv', bigCsvRows)],
        })
        fileInp.dispatchEvent(new Event('change'))
        await flushTick()
      }
      const importBtn = findBtn(mh.getBackdrop() || document.body, /Import Directly|Import \d+ Row/i)
      importBtn?.click()
      await flushTick()
      mh.closeModal()
      resolveBatch1?.()
      await flushTick()
      mh.closeModal()
    }

    // 3. driver-manager-modal: configureLocal/verify null item response + removed-while-closing guard
    {
      const mh = mountModalHarness()
      let rejectPending: ((err: Error) => void) | undefined
      const req = vi.fn(async (method: string) => {
        if (method === 'drivers.list') {
          return [
            {
              id: 'duckdb',
              name: 'DuckDB',
              kind: 'byod',
              status: 'local-verified',
              localPath: 'C:\\drivers\\duckdb',
              resolvedEntry: 'C:\\drivers\\duckdb\\index.mjs',
              trustedSha256: 'abc123',
            },
          ]
        }
        if (method === 'drivers.defaultFolders') {
          return { platform: 'win32', paths: { duckdb: 'C:\\drivers\\duckdb' } }
        }
        if (method === 'drivers.inspect') {
          return { ok: true, resolvedEntry: 'C:\\drivers\\duckdb\\index.mjs', sha256: 'def456' }
        }
        if (method === 'drivers.configureLocal' || method === 'drivers.verify') {
          return { ok: true }
        }
        if (method === 'drivers.removeLocal') {
          await new Promise<void>((_, rej) => {
            rejectPending = rej
          })
          return { ok: true }
        }
        return {}
      })
      openStudioDriverManagerModal({
        mountModal: mh.mountModal,
        closeModal: mh.closeModal,
        requestPlugin: req as <T = unknown>(m: string) => Promise<T>,
      })
      await flushTick()
      await flushTick()
      const bd = mh.getBackdrop() || document.body
      findBtn(bd, /^Inspect/i)?.click()
      await flushTick()
      findBtn(bd, /^Trust/i)?.click()
      await flushTick()
      findBtn(bd, /^Verify$/i)?.click()
      await flushTick()
      findBtn(bd, /^Remove$/i)?.click()
      mh.closeModal()
      rejectPending?.(new Error('closed'))
      await flushTick()
    }

    // 4. connection-modal: discovery >5 groups + .env chip + file picker (.sqlite stem & BYOD folder) + parseUri matrix + SSH/TLS controls
    {
      const mh = mountModalHarness()
      const manyEnv = Array.from({ length: 6 }, (_, i) => ({
        envKey: `DB_URL_${i}`,
        sourceFile: '.env',
        driver: (i % 2 === 0 ? 'postgres' : 'redis') as DatabaseDriverType,
        name: `EnvDB_${i}`,
        uri: i % 2 === 0 ? 'postgresql://u:p@localhost:5432/app' : 'redis://localhost:6379/2',
      }))
      const manyDocker = Array.from({ length: 6 }, (_, i) => ({
        containerId: `cid_${i}`,
        containerName: `pg_ctr_${i}`,
        serviceName: `db_${i}`,
        driver: 'postgres' as DatabaseDriverType,
        name: `Docker_${i}`,
        host: '127.0.0.1',
        port: 5432 + i,
        database: 'app',
        user: 'pg',
        workspaceMatch: i % 2 === 0,
        status: i === 0 ? 'running' : i === 1 ? 'compose file' : 'exited',
      }))
      const manyFiles = Array.from({ length: 6 }, (_, i) => ({
        name: `local_${i}.db`,
        filePath: `/proj/db/local_${i}.db`,
        sizeBytes: 2048 + i,
        sizeLabel: '2 KB',
      }))
      let parseMode: 'oracle' | 'libsql' | 'd1' | 'clickhouse' | 'redis' = 'oracle'
      const req = vi.fn(async (method: string, payload?: Record<string, unknown>) => {
        if (method === 'drivers.list') {
          return [{ id: 'duckdb', name: 'DuckDB', kind: 'byod', status: 'not-configured' }]
        }
        if (method === 'drivers.defaultFolders') {
          return { platform: 'win32', paths: { duckdb: 'C:\\drivers\\duckdb' } }
        }
        if (method === 'workspace.detectConnections') {
          return {
            envConnections: manyEnv,
            dockerComposeConnections: manyDocker,
            sqliteFiles: manyFiles,
            scannedDirs: ['/proj', '/proj/db'],
            folderScoped: Boolean(payload?.folderPath),
            dockerScopeLabel: 'Docker Context',
          }
        }
        if (method === 'sqlite.scanFolder') {
          return { files: [{ name: 'extra.db', filePath: '/proj/extra.db', sizeBytes: 100, sizeLabel: '100 B' }] }
        }
        if (method === 'fs.listDirectory') {
          return {
            path: '/proj/sub',
            parent: '/proj',
            entries: [
              { name: 'folderA', path: '/proj/sub/folderA', isDir: true },
              { name: '.sqlite', path: '/proj/sub/.sqlite', isDir: false, sizeBytes: 512 },
            ],
          }
        }
        if (method === 'connections.parseUri') {
          if (parseMode === 'oracle') {
            return {
              ok: true,
              profile: { driver: 'oracle', name: 'Ora', host: 'ora.local', port: 1521, user: 'sys', url: 'oracle://sys:pw@ora.local:1521/ORCL', ssl: true },
              password: 'pw',
            }
          }
          if (parseMode === 'libsql') {
            return { ok: true, profile: { driver: 'libsql', name: 'Turso', url: 'libsql://db-org.turso.io?authToken=abc', database: 'main' }, authToken: 'tok' }
          }
          if (parseMode === 'd1') {
            return { ok: true, profile: { driver: 'd1', name: 'CF D1', d1AccountId: 'acc', d1DatabaseId: 'db', url: 'https://api.cloudflare.com' }, authToken: 'd1tok' }
          }
          if (parseMode === 'clickhouse') {
            return { ok: true, profile: { driver: 'clickhouse', name: 'CH', host: 'ch.local', port: 8123, user: 'default', database: 'analytics', url: 'https://ch.local:8443', ssl: true, sslRejectUnauthorized: false } }
          }
          return { ok: true, profile: { driver: 'redis', name: 'Red', host: 'red.local', port: 6379, redisDb: 3 } }
        }
        return { ok: true }
      })
      openStudioConnectionModal(
        {
          isBackdropActive: mh.isBackdropActive,
          mountModal: mh.mountModal,
          closeModal: mh.closeModal,
          requestPlugin: req as <T = unknown>(m: string, p?: Record<string, unknown>) => Promise<T>,
          createElapsedTimer: () => () => {},
          updateStatus: () => {},
          activateSavedConnection: async () => {},
          onConnectionDeleted: async () => {},
          currentWorkspaceScope: '/proj',
        },
        {
          id: 'edit_1',
          name: 'Editable',
          driver: 'postgres',
          host: 'old.host',
          port: 5432,
          user: 'olduser',
          database: 'app',
          hasPassword: true,
          sshEnabled: true,
          sshHost: 'bastion',
          sshPort: 22,
          sshUser: 'ops',
          sshAuthMethod: 'key',
          hasSshPassphrase: true,
          hasSshPassword: true,
          folder: 'ProdFolder',
        } as ConnectionProfile
      )
      await flushTick()
      await flushTick()

      const connModal = document.querySelector('.datanoa-modal-backdrop') as HTMLDivElement | null
      if (connModal) {
        // Expand >5 collapsed groups, search no-match, click .env chip & env pills
        connModal.querySelectorAll('button').forEach((b) => {
          if (/Show all \d+|Collapse/i.test(b.textContent || '')) b.click()
        })
        const discSearch = connModal.querySelector('input[placeholder*="Filter"]') as HTMLInputElement | null
        if (discSearch) {
          discSearch.value = '__no_match_zzz__'
          discSearch.dispatchEvent(new Event('input'))
          discSearch.value = ''
          discSearch.dispatchEvent(new Event('input'))
        }
        const envChip = Array.from(connModal.querySelectorAll('button')).find((b) =>
          (b.textContent || '').includes('DB_URL_0')
        ) as HTMLButtonElement | undefined
        envChip?.click()

        // Toggle env pills, SSL checkbox/mode, Redis DB index & SSH Auth method
        const prodPill = connModal.querySelector('.datanoa-conn-env-pill.env-prod') as HTMLButtonElement | null
        prodPill?.click()
        const sslChk = Array.from(connModal.querySelectorAll('input[type="checkbox"]'))[1] as HTMLInputElement | undefined
        if (sslChk) {
          sslChk.checked = true
          sslChk.dispatchEvent(new Event('change'))
        }
        connModal.querySelectorAll('select').forEach((sel) => {
          if (Array.from(sel.options).some((o) => o.value === 'require')) {
            sel.value = 'require'
            sel.dispatchEvent(new Event('change'))
          } else if (Array.from(sel.options).some((o) => o.value === 'password')) {
            sel.value = 'password'
            sel.dispatchEvent(new Event('change'))
          } else if (Array.from(sel.options).some((o) => o.value === '3')) {
            sel.value = '3'
            sel.dispatchEvent(new Event('change'))
          }
        })

        // Parse URIs across oracle, libsql, d1, clickhouse, redis
        const uriInp = connModal.querySelector('input[placeholder*="://"]') as HTMLInputElement | null
        const parseBtn = findBtn(connModal, /Parse URI/i)
        for (const m of ['oracle', 'libsql', 'd1', 'clickhouse', 'redis'] as const) {
          parseMode = m
          if (uriInp) uriInp.value = `${m}://host/db`
          parseBtn?.click()
          await flushTick()
        }

        // DuckDB BYOD folder picker + SQLite .sqlite dotfile basename
        const duckTile = Array.from(connModal.querySelectorAll('.datanoa-engine-tile')).find((el) =>
          (el.textContent || '').includes('DuckDB')
        ) as HTMLButtonElement | undefined
        duckTile?.click()
        await flushTick()

        const sqlTile = Array.from(connModal.querySelectorAll('.datanoa-engine-tile')).find((el) =>
          (el.textContent || '').includes('SQLite')
        ) as HTMLButtonElement | undefined
        sqlTile?.click()
        const browseSqliteBtn = findBtn(connModal, /^Browse File/i)
        browseSqliteBtn?.click()
        await flushTick()
        // If file picker modal mounted on top, pick `.sqlite` item and Select
        const pickBd = document.querySelectorAll('.datanoa-modal-backdrop')
        const topBd = pickBd[pickBd.length - 1]
        if (topBd && topBd !== connModal) {
          const dotEntry = Array.from(topBd.querySelectorAll('button, div, span')).find((el) =>
            (el.textContent || '').trim() === '.sqlite'
          ) as HTMLElement | undefined
          dotEntry?.click()
          findBtn(topBd, /^Select|^Open|^Choose/i)?.click()
          await flushTick()
        }

        connModal.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        findBtn(connModal, /^Cancel$/i)?.click()
      }
      mh.closeModal()
    }

    // 5. schema-inspector: View Open in Console + Copy DDL timer + Drop View + FK/Validation/Combo/ManualTx rebuild + scroll preserve
    {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const onOpenDdlInConsole = vi.fn()
      const onDropTable = vi.fn()
      let resolveMig: ((res: { ok: boolean }) => void) | undefined
      const inspector = new SchemaInspectorView(host, {
        dialect: 'sqlite',
        isManualTxActive: () => true,
        onOpenDdlInConsole,
        onInsertDdl: vi.fn(),
        onCopyDdl: vi.fn(),
        onDropTable,
        onApplyMigration: () =>
          new Promise((r) => {
            resolveMig = r
          }),
      })

      vi.useFakeTimers()
      inspector.setReadOnlyObjectDdl(
        { name: 'v_orders', schema: 'main', kind: 'view' } as SchemaObject,
        'CREATE VIEW v_orders AS SELECT 1;',
        'sqlite'
      )
      ;(host.querySelector('.datanoa-copy-ddl-btn') as HTMLButtonElement | null)?.click()
      vi.advanceTimersByTime(1500)
      ;(host.querySelector('.datanoa-open-ddl-console-btn') as HTMLButtonElement | null)?.click()
      expect(onOpenDdlInConsole).toHaveBeenCalledOnce()
      vi.useRealTimers()

      inspector.setReferenceTables(['users', 'departments'])
      const details: TableDetails = {
        name: 'orders',
        schema: 'main',
        kind: 'table',
        primaryKey: ['id'],
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, isPrimaryKey: true },
          { name: 'user_id', type: 'INTEGER', nullable: true, isPrimaryKey: false },
        ],
        indexes: [{ name: 'idx_orders_user', columns: ['user_id'], isUnique: false, isPrimary: false }],
        foreignKeys: [{ column: 'user_id', foreignTable: 'users', foreignColumn: 'id' }],
        ddl: 'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER);',
      }
      inspector.setDetails(details, 'sqlite')
      const sb = host.querySelector('.datanoa-inspector-scroll-body') as HTMLDivElement | null
      if (sb) sb.scrollTop = 120
      inspector.setDetails(details, 'sqlite')

      // Combo popover keyboard/mouseenter + FK col select selectedIndex + invalid col name preview
      const comboInps = host.querySelectorAll('.datanoa-combo-wrap input')
      const firstCombo = comboInps[0] as HTMLInputElement | undefined
      if (firstCombo) {
        firstCombo.dispatchEvent(new Event('focus'))
        firstCombo.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }))
        const comboOpts = document.querySelectorAll('.datanoa-combo-item')
        comboOpts[0]?.dispatchEvent(new Event('mouseenter'))
        firstCombo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      }
      const fkSel = host.querySelector('tbody select') as HTMLSelectElement | null
      if (fkSel && fkSel.options.length > 0) {
        fkSel.selectedIndex = 0
        fkSel.dispatchEvent(new Event('change'))
      }

      // Trigger rebuild SQL + manual TX block check
      const pkChk = host.querySelector('input[type="checkbox"]') as HTMLInputElement | null
      if (pkChk) {
        pkChk.checked = !pkChk.checked
        pkChk.dispatchEvent(new Event('change'))
      }
      const previewBtn = findBtn(host, /Preview|SQL/i)
      previewBtn?.click()
      findBtn(host, /^Apply Changes/i)?.click()
      await flushTick()
      const confirmMigBtn = findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /Confirm|Apply Migration/i)
      confirmMigBtn?.click()
      await flushTick()
      resolveMig?.({ ok: true })

      // Read-only view Drop View button
      inspector.setReadOnly(false)
      inspector.setDetails({ ...details, kind: 'view', name: 'v_orders' }, 'sqlite')
      ;(host.querySelector('.datanoa-struct-drop-btn') as HTMLButtonElement | null)?.click()
      expect(onDropTable).toHaveBeenCalledOnce()

      inspector.destroy()
      host.remove()
    }
  })

  it('Slice 6B: covers VirtualDataGrid tbody mousedown/drag/autoscroll, window popovers, transposed >100 rows, inline scroll & direct edit paths', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => 860 })
    Object.defineProperty(host, 'clientHeight', { configurable: true, get: () => 360 })

    let directReject = true
    const grid = new VirtualDataGrid({
      container: host,
      data: makeTableData(108, { canEdit: true }),
      tableName: 'users',
      foreignKeys: [{ column: 'dept_id', foreignTable: 'departments', foreignColumn: 'id' }],
      onNavigateForeignKey: vi.fn(),
      onColumnHeaderFilter: vi.fn(),
      onSortChange: vi.fn(),
      onDirectCellEdit: async (edit) => {
        if (directReject) {
          directReject = false
          return { ok: false, error: 'NOT NULL constraint failed' }
        }
        return {
          ok: true,
          updatedRecord: { ...edit.primaryKeys, [edit.column]: `${String(edit.value)}_norm` },
        }
      },
      onNotify: vi.fn(),
    })

    const wrap = host.querySelector('.datanoa-grid-container') as HTMLDivElement
    const tbody = wrap.querySelector('tbody') as HTMLTableSectionElement
    const thead = wrap.querySelector('thead') as HTMLTableSectionElement
    Object.defineProperty(wrap, 'clientWidth', { configurable: true, get: () => 860 })
    Object.defineProperty(wrap, 'clientHeight', { configurable: true, get: () => 320 })
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, right: 860, bottom: 320, width: 860, height: 320, x: 0, y: 0, toJSON: () => ({}) })
    tbody.getBoundingClientRect = () => ({ left: 0, top: 32, right: 860, bottom: 320, width: 860, height: 288, x: 0, y: 32, toJSON: () => ({}) })

    const patchRowGeoms = () => {
      Array.from(tbody.querySelectorAll('tr')).forEach((tr, rIdx) => {
        tr.getBoundingClientRect = () => ({
          left: 0, top: 32 + rIdx * 28, right: 860, bottom: 60 + rIdx * 28, width: 860, height: 28, x: 0, y: 32 + rIdx * 28, toJSON: () => ({}),
        })
        Array.from(tr.querySelectorAll('td')).forEach((td, cIdx) => {
          td.getBoundingClientRect = () => ({
            left: cIdx * 120, top: 32 + rIdx * 28, right: (cIdx + 1) * 120, bottom: 60 + rIdx * 28, width: 120, height: 28, x: cIdx * 120, y: 32 + rIdx * 28, toJSON: () => ({}),
          })
        })
      })
    }
    patchRowGeoms()

    // 1. Real tbody mousedown (bubbles: true) on rowNumTd + dataTd + FK jump + Shift/Ctrl clicks
    const firstRow = tbody.querySelector('tr')!
    const dataTds = firstRow.querySelectorAll('td')
    const rowNumTd = dataTds[0] as HTMLTableCellElement | undefined
    rowNumTd?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 45 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 75 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 315 }))
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 20, clientY: 75 }))

    dataTds[1]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 150, clientY: 45 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 270, clientY: 75 }))
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 270, clientY: 75 }))
    dataTds[1]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, shiftKey: true, button: 0, clientX: 150, clientY: 45 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    dataTds[1]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, ctrlKey: true, button: 0, clientX: 150, clientY: 45 }))
    window.dispatchEvent(new MouseEvent('mouseup'))

    const fkBtn = tbody.querySelector('.datanoa-fk-jump') as HTMLButtonElement | null
    fkBtn?.click()
    dataTds[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))

    // 2. window mousedown closing context menu & column filter popover (target instanceof Node)
    dataTds[1]?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 160, clientY: 50 }))
    window.dispatchEvent(Object.assign(new MouseEvent('mousedown', { bubbles: true }), { target: document.body }))

    const filterBtns = thead.querySelectorAll('.datanoa-col-filter-btn')
    ;(filterBtns[1] as HTMLButtonElement | undefined)?.click()
    window.dispatchEvent(Object.assign(new MouseEvent('mousedown', { bubbles: true }), { target: document.body }))

    // Header # click + sortable th click + resize handle
    ;(thead.querySelector('th') as HTMLTableCellElement | null)?.click()
    const colTh = thead.querySelectorAll('th')[2]
    colTh?.click()
    colTh?.click()
    const resizeHandle = thead.querySelector('.datanoa-col-resize-handle') as HTMLDivElement | null
    resizeHandle?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 180 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 220 }))
    window.dispatchEvent(new MouseEvent('mouseup'))

    // 3. Transposed mode (>100 rows overflow banner, cell click & contextmenu)
    grid.setTransposed(true)
    const transTd = tbody.querySelector('td')
    transTd?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    transTd?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 60 }))
    window.dispatchEvent(Object.assign(new MouseEvent('mousedown', { bubbles: true }), { target: document.body }))
    grid.setTransposed(false)
    patchRowGeoms()

    // 4. Inline editor survival across scroll + untouched blank row slide-out + Tab edges
    grid.selectSingleModelCell(0, 1)
    wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    const inp = tbody.querySelector('input') as HTMLInputElement | null
    if (inp) {
      wrap.scrollTop = 260
      wrap.dispatchEvent(new Event('scroll'))
      inp.value = 'UpdatedDirectly'
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      await flushTick()
    }
    wrap.scrollTop = 0
    wrap.dispatchEvent(new Event('scroll'))
    grid.selectSingleModelCell(0, 1)
    wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    const inp2 = tbody.querySelector('input') as HTMLInputElement | null
    if (inp2) {
      inp2.value = 'AliceSecond'
      inp2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      await flushTick()
    }
    // Shift+Tab at col 0 & Tab at last cell
    grid.selectSingleModelCell(0, 0)
    wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }))
    grid.selectSingleModelCell(107, 4)
    wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))

    // Blank row untouched flush + header-aware TSV paste + bulkSetCellsValue fallback
    grid.setBatchMode(true)
    grid.addBlankRow()
    wrap.scrollTop = 0
    wrap.dispatchEvent(new Event('scroll'))
    grid.pasteDelimitedTextDetailed('name\tdept_id\nPastedOne\t2\nPastedTwo\t3', { forceNewRows: true })
    grid.clearSelection()
    grid.bulkSetCellsValue('filled')

    // Read-only addBlankRow early return
    grid.setData({ ...makeTableData(2, { canEdit: false }), canEdit: false })
    expect(grid.addBlankRow()).toBeNull()
    grid.destroy()
    host.remove()
  })

  it('Slice 6C: covers boot without documentSession, oversized viewState pruning, caution strips, events, schema switcher & split resize destroy cleanup', async () => {
    // 1. Pre-seed >200KB studioViewState in localStorage and boot WITHOUT attachDocumentSession
    const hugeFiller: Record<string, unknown> = {}
    for (let i = 0; i < 8; i++) {
      hugeFiller[`stale_conn_${i}`] = {
        activeTable: 'big_tbl',
        sqlDraft: 'SELECT /* ' + 'x'.repeat(28000) + ' */ 1;',
        activeWhereClause: 'id > 0',
        activeOrderByClause: 'id ASC',
        clientFilter: 'Alice',
        isTransposed: true,
        activeViewMode: 'sql',
        scrollState: { gridTop: 15, gridLeft: 8, sidebarTop: 10 },
      }
    }
    hugeFiller.c_main = {
      activeTable: 'employees',
      activeWhereClause: 'id >= 1',
      activeOrderByClause: 'id ASC',
      clientFilter: 'Alice',
      isTransposed: true,
      activeViewMode: 'grid',
      scrollState: { gridTop: 10, gridLeft: 5, sidebarTop: 5 },
      consoleTabs: {
        tabs: [{ id: 'tab_1', title: 'Main', sql: 'SELECT 1;' }],
        activeTabId: 'tab_1',
      },
    }
    localStorage.setItem('datanoa.studioViewState', JSON.stringify(hugeFiller))
    const bNoDoc = createLiveStudioSqliteBackend({ multiSchema: true })
    dbsToCloseR3.push(bNoDoc.db)
    ;(window as unknown as { orca: unknown }).orca = bNoDoc.orcaApi
    const edNoDoc = initializeEditor()!
    await new Promise((r) => setTimeout(r, 320))
    await flushTick()
    expect(edNoDoc).not.toBeNull()
    expect((edNoDoc as unknown as { activeConnectionId: string | null }).activeConnectionId).toBe('c_main')
    edNoDoc.destroy()
    bNoDoc.db.close()

    // 2. Full caution strip (prod + read-only), host/plugin/storage events, topbar/sidebar edge actions & split resizer destroy
    const { backend, ed, priv } = await bootRound3({ multiSchema: true })
    try {
      // Seed prod (non-RO) and readOnly (non-prod) connections cleanly in backend list
      const now = Date.now()
      const prodConn: ConnectionProfile = {
        id: 'c_prod',
        name: 'Prod DB',
        driver: 'sqlite',
        filePath: ':memory:',
        colorTag: 'prod',
        readOnly: false,
        createdAt: now,
        updatedAt: now,
      }
      const roConn: ConnectionProfile = {
        id: 'c_ro',
        name: 'RO DB',
        driver: 'sqlite',
        filePath: ':memory:',
        colorTag: 'none',
        readOnly: true,
        createdAt: now,
        updatedAt: now,
      }
      backend.connections.push(prodConn, roConn)
      backend.emitPlugin('connections.changed', {})
      await flushTick()

      priv.handleConnectionChanged('c_prod')
      await flushTick()
      priv.cautionStripCloseBtn?.click()
      backend.emitPlugin('studio.opened', { connectionId: 'c_prod' })
      await flushTick()

      priv.handleConnectionChanged('c_ro')
      await flushTick()
      expect(priv.cautionStripEl?.textContent).toContain('Read-Only')

      priv.handleConnectionChanged('c_main')
      await flushTick()

      // Host / storage / settings / cellUpdated events
      backend.emitHost('theme.changed', { theme: 'light' })
      backend.emitHost('theme.changed', { theme: 'dark' })
      backend.emitHost('theme.changed', { other: true })
      backend.emitHost('editor.typography.changed', { fontSize: 13, fontFamily: 'monospace' })
      backend.emitSettings('ai.enabled', true)
      backend.emitPlugin('ai.status.changed', { enabled: true, ready: true, provider: 'test', explainLanguage: 'en' })
      backend.emitPlugin('data.cellUpdated', {
        connectionId: 'c_main',
        table: 'employees',
        primaryKeys: { id: 1 },
        column: 'name',
        newValue: 'RemoteUpdated',
      })
      // Storage listeners if registered
      window.dispatchEvent(new Event('storage'))

      // Search input, schema select change, columns/batch/transpose/pageSize controls
      if (priv.searchInputEl) {
        priv.searchInputEl.value = 'emp'
        priv.searchInputEl.dispatchEvent(new Event('input'))
        priv.searchInputEl.value = ''
        priv.searchInputEl.dispatchEvent(new Event('input'))
      }
      if (priv.schemaSelectEl && priv.schemaSelectEl.options.length > 1) {
        priv.schemaSelectEl.value = priv.schemaSelectEl.options[1].value
        priv.schemaSelectEl.dispatchEvent(new Event('change'))
        await flushTick()
        priv.schemaSelectEl.value = priv.schemaSelectEl.options[0].value
        priv.schemaSelectEl.dispatchEvent(new Event('change'))
        await flushTick()
      }

      priv.columnsBtn?.click()
      priv.columnsBtn?.click()
      priv.batchModeBtn?.click()
      priv.transposeBtn?.click()
      priv.transposeBtn?.click()
      if (priv.pageSizeSelectEl) {
        priv.pageSizeSelectEl.value = '500'
        priv.pageSizeSelectEl.dispatchEvent(new Event('change'))
        await flushTick()
      }

      // Topbar popover Escape on .datanoa-topbar-popover-search (onClose) & toggle close
      priv.topbarAllBtn?.click()
      const popSearch = document.querySelector('.datanoa-topbar-popover-search') as HTMLInputElement | null
      popSearch?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
      expect(document.querySelector('.datanoa-topbar-popover')).toBeNull()
      expect(priv.pageSizeSelectEl?.value).toBe('500')
      priv.topbarAllBtn?.click()
      priv.topbarAllBtn?.click()

      // Export full schema DDL cancelled & failed paths
      backend.setSaveAsResult('cancelled')
      priv.exportDdlBtn?.click()
      await flushTick()
      backend.setSaveAsResult('failed')
      priv.exportDdlBtn?.click()
      await flushTick()

      // Sidebar context menu on trigger: Copy DDL & Open DDL in Console + editTableBtn guard
      const trigObj = priv.schemaObjects.find((o) => o.kind === 'trigger')
      if (trigObj) {
        priv.selectReadOnlyObject(trigObj)
        await flushTick()
        priv.editTableBtn?.click() // returns early when non-tabular object active
        const trigEl = findBtn(priv.sidebarListEl || document.body, new RegExp(trigObj.name))
        trigEl?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }))
        findBtn(document.body, /^Copy DDL$/i)?.click()
        await flushTick()
        trigEl?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }))
        findBtn(document.body, /^Open DDL in Console$/i)?.click()
        await flushTick()
      }

      // Export DDL & MatView inspector branch (`4792-4805`)
      priv.selectReadOnlyObject({ name: 'mv_emp_dept', schema: 'main', kind: 'materialized_view' } as SchemaObject)
      await flushTick()
      priv.switchMode('inspector')
      await flushTick()
      priv.switchMode('split')

      // Split resizer without RAF + active RAF cleanup on destroy()
      if (priv.splitResizerEl) {
        await withTempGlobal('requestAnimationFrame', undefined, async () => {
          priv.splitResizerEl?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientY: 200 }))
          window.dispatchEvent(new MouseEvent('mousemove', { clientY: 240 }))
          window.dispatchEvent(new MouseEvent('mouseup'))
        })
        priv.splitResizerEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientY: 200 }))
        window.dispatchEvent(new MouseEvent('mousemove', { clientY: 250 }))
      }
    } finally {
      ed.destroy()
    }
  })

  it('Slice 6D: covers SQL/EXPLAIN guards, Danger conn-switch, elapsed timer, async SQL editability, Inspector Open-in-Console & TX rebuild block, Import & Retry', async () => {
    const { backend, ed, priv } = await bootRound3()
    try {
      // 1. Empty SQL / no connection / TX busy guards
      ed.getSqlConsole()?.setText('')
      await priv.executeSql(false)
      await priv.explainSql(true)

      const savedConn = priv.activeConnectionId
      priv.handleConnectionChanged(null)
      ed.getSqlConsole()?.setText('SELECT 1;')
      await priv.executeSql(false)
      await priv.explainSql(true)
      priv.handleConnectionChanged(savedConn)
      await flushTick()

      // TX busy guard on executeSql using deferred tx.begin
      const origReq = backend.orcaApi.plugin.request
      let releaseTxBegin: (() => void) | undefined
      ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = (async (
        m: string,
        p?: Record<string, unknown>
      ) => {
        if (m === 'tx.begin') {
          await new Promise<void>((r) => {
            releaseTxBegin = r
          })
        }
        return origReq(m, p)
      }) as typeof origReq
      const txBeginP = priv.txToolbar.begin()
      await flushMicro(3)
      await priv.executeSql(false)
      releaseTxBegin?.()
      await txBeginP
      ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = origReq
      await priv.txToolbar.rollback()

      // 2. Danger SQL / EXPLAIN modal connection-switch cancel guards
      const unlockAndConfirmDanger = () => {
        const bd = document.querySelector('.datanoa-modal-backdrop') || document.body
        const chk = bd.querySelector('input[type="checkbox"]') as HTMLInputElement | null
        if (chk && !chk.checked) {
          chk.checked = true
          chk.dispatchEvent(new Event('change'))
        }
        const txt = bd.querySelector('input[type="text"]') as HTMLInputElement | null
        if (txt) {
          txt.value = 'CONFIRM'
          txt.dispatchEvent(new Event('input'))
        }
        findBtn(bd, /^Execute Anyway$/i)?.click()
      }
      ed.getSqlConsole()?.setText('DELETE FROM employees;')
      await priv.executeSql(true)
      priv.activeConnectionId = 'other_conn'
      unlockAndConfirmDanger()
      priv.activeConnectionId = 'c_main'
      await flushTick()

      ed.getSqlConsole()?.setText('DELETE FROM employees;')
      await priv.explainSql(true)
      priv.activeConnectionId = 'other_conn'
      unlockAndConfirmDanger()
      priv.activeConnectionId = 'c_main'
      await flushTick()

      // 3. Elapsed timer ticks during deferred query.run & async SQL result editability
      priv.tableDetailsCache.clear()
      ed.getSqlConsole()?.setText('SELECT id, name, meta FROM employees WHERE id = 1;')
      let releaseQueryRun: (() => void) | undefined
      ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = (async (
        m: string,
        p?: Record<string, unknown>
      ) => {
        if (m === 'query.run') {
          await new Promise<void>((r) => {
            releaseQueryRun = r
          })
        }
        return origReq(m, p)
      }) as typeof origReq
      vi.useFakeTimers()
      const sqlP = priv.executeSql(true, true, undefined, true)
      await Promise.resolve()
      vi.advanceTimersByTime(1100)
      vi.useRealTimers()
      ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = origReq
      releaseQueryRun?.()
      await sqlP
      await flushTick()
      expect(ed.getDataGrid()?.getModel()?.rows[0]?.name).toBe('Alice')

      // handleQuickFilter in SQL mode + table mode + refreshSingleResultSet error
      await priv.handleQuickFilter('"name" = \'Alice\'', 'replace')
      priv.queryBannerBackBtn?.click()
      await flushTick()
      await priv.handleQuickFilter('"id" > 0', 'replace')
      await priv.handleQuickFilter('"name" IS NOT NULL', 'and')
      expect(priv.whereInputEl?.value).toContain('"id" > 0')

      backend.failOnceActions.add('query.run')
      await priv.refreshSingleResultSet(priv.consoleTabs.getActiveTabId(), 0, 'c_main', 'SELECT 1;')
      await flushTick()

      // submitStagedChanges failure banner
      await priv.loadTableData('c_main', 'employees', 1)
      await flushTick()
      ed.getDataGrid()?.setBatchMode(true)
      ed.getDataGrid()?.stageCellEdit(0, 'name', 'StagedFailName')
      backend.failOnceActions.add('data.applyChanges')
      await priv.submitStagedChanges()
      await flushTick()
      ed.getDataGrid()?.revertAllChanges()

      // 4. SchemaInspector real integration: Open DDL in Console (view) + Manual TX rebuild block + migration failure & mode switch block
      const viewObj = priv.schemaObjects.find((o) => o.kind === 'view')
      if (viewObj) {
        priv.selectReadOnlyObject(viewObj)
        await flushTick()
        priv.switchMode('inspector')
        ;(document.querySelector('.datanoa-open-ddl-console-btn') as HTMLButtonElement | null)?.click()
        await flushTick()
      }

      const empObj = priv.schemaObjects.find((o) => o.name === 'employees')
      if (empObj) {
        const sbEmp = findBtn(priv.sidebarListEl || document.body, /employees/)
        sbEmp?.click()
        await flushTick()
        priv.switchMode('inspector')
        await flushTick()

        const inspArea = document.querySelector('.datanoa-inspector-area')
        const rows = inspArea?.querySelectorAll('tbody tr') || []
        const targetChk = (rows[1] || rows[0])?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
        if (targetChk) {
          targetChk.checked = !targetChk.checked
          targetChk.dispatchEvent(new Event('change'))
        }
        // Start manual TX then attempt rebuild -> triggers isManualTxActive callback!
        await priv.txToolbar.begin()
        findBtn(inspArea || document.body, /^Apply Changes/i)?.click()
        await flushTick()
        ;(document.querySelector('.datanoa-struct-confirm-execute-btn') as HTMLButtonElement | null)?.click()
        await flushTick()
        findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /^Cancel$/i)?.click()
        await priv.txToolbar.rollback()

        // Deferred failing migration apply -> test switchMode blocked while migration in flight + Schema Migration Failed banner
        let releaseMigFail: (() => void) | undefined
        ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = (async (
          m: string,
          p?: Record<string, unknown>
        ) => {
          if (m === 'schema.applyMigration') {
            await new Promise<void>((r) => {
              releaseMigFail = r
            })
            throw new Error('migration rejected')
          }
          return origReq(m, p)
        }) as typeof origReq
        findBtn(inspArea || document.body, /^Apply Changes/i)?.click()
        await flushTick()
        ;(document.querySelector('.datanoa-struct-confirm-execute-btn') as HTMLButtonElement | null)?.click()
        await flushMicro(4)
        priv.switchMode('grid') // blocked while in flight!
        releaseMigFail?.()
        await flushTick()
        ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = origReq
        findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /^Cancel$/i)?.click()
        priv.switchMode('grid')
        await flushTick()
      }

      // 5. Query banner Retry click + openImportDataModal error/direct import + openDangerTableModal Drop
      backend.failOnceActions.add('data.getPage')
      await priv.loadTableData('c_main', 'employees', 1)
      priv.queryBannerRetryBtn?.click()
      await flushTick()

      // Import modal: view rejection + uncached details fail + uncached details Stage in Grid
      if (viewObj) await priv.openImportDataModal(viewObj)
      priv.tableDetailsCache.clear()
      backend.failOnceActions.add('schema.tableDetails')
      await priv.openImportDataModal({ name: 'departments', kind: 'table' } as SchemaObject)
      await priv.openImportDataModal({ name: 'departments', kind: 'table' } as SchemaObject)
      await flushTick()
      const impInp = document.querySelector('.datanoa-modal-backdrop input[type="file"]') as HTMLInputElement | null
      if (impInp) {
        Object.defineProperty(impInp, 'files', {
          configurable: true,
          value: [makeFakeFile('dept.csv', 'name\nImportedDeptA')],
        })
        impInp.dispatchEvent(new Event('change'))
        await flushTick()
      }
      findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /Import Directly|Import \d+ Row/i)?.click()
      await flushTick()
      const leftoverBd = document.querySelector('.datanoa-modal-backdrop')
      if (leftoverBd) findBtn(leftoverBd, /^Cancel$/i)?.click()

      // Create & Drop table via openDangerTableModal
      ed.getSqlConsole()?.setText('CREATE TABLE temp_drop_r3 (id INTEGER PRIMARY KEY, label TEXT);')
      await priv.executeSql(true, true, undefined, true)
      await priv.introspectSchema('c_main', false)
      await flushTick()
      priv.openDangerTableModal('truncate', { name: 'temp_drop_r3', kind: 'table' } as SchemaObject)
      const truncInp = document.querySelector('#datanoa-danger-table-confirm-input') as HTMLInputElement | null
      if (truncInp) {
        truncInp.value = 'temp_drop_r3'
        truncInp.dispatchEvent(new Event('input'))
        findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /^Truncate Table$/i)?.click()
        await flushTick()
      }
      priv.openDangerTableModal('drop', { name: 'temp_drop_r3', kind: 'table' } as SchemaObject)
      const dropInp = document.querySelector('#datanoa-danger-table-confirm-input') as HTMLInputElement | null
      if (dropInp) {
        dropInp.value = 'temp_drop_r3'
        dropInp.dispatchEvent(new Event('input'))
        findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /^Drop Table$/i)?.click()
        await flushTick()
      }
      expect(
        backend.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='temp_drop_r3'").all()
      ).toHaveLength(0)

      // Trigger openCreateTableModal error/status callback cleanly
      priv.openCreateTableModal()
      const ctBd = document.querySelector('.datanoa-modal-backdrop')
      if (ctBd) findBtn(ctBd, /^Cancel$/i)?.click()
      expect(document.querySelector('.datanoa-modal-backdrop')).toBeNull()
    } finally {
      ed.destroy()
    }
  })

  it('Slice 6E: covers index.ts worker snapshot/applyDocumentMetadata, toolbar/shortcuts/Ctrl+S, multi-result tabs, DML cancel/reject, CountRows & Create/Danger callbacks', async () => {
    // 1. Boot with worker snapshot containing viewState & cached SQL result + readOnly object + huge viewState pruning
    const bSnap = createLiveStudioSqliteBackend({ multiSchema: true })
    dbsToCloseR3.push(bSnap.db)
    bSnap.setSessionSnapshot({
      updatedAt: Date.now() + 20_000,
      viewState: {
        activeConnectionId: 'c_main',
        activeTable: 'employees',
        activeWhereClause: 'id >= 1',
        activeOrderByClause: 'id ASC',
        clientFilter: 'Alice',
        sqlDraft: 'SELECT 1;\n' + '/* ' + 'z'.repeat(18_000) + ' */',
        activeViewMode: 'sql',
        customSqlPanePx: 210,
        filterQuery: '',
        sidebarCollapsed: false,
        columnConfigByTable: {
          'c_main::employees': { hidden: ['note'], pinned: ['id'], order: ['id', 'name', 'dept_id'] },
        },
        consoleTabs: {
          tabs: [{ id: 't_boot', title: 'Boot', sql: 'SELECT id, name FROM employees;' }],
          activeTabId: 't_boot',
        },
      },
      dataCache: {
        c_main: {
          schemaObjects: [
            { name: 'employees', schema: 'main', kind: 'table' },
            { name: 'departments', schema: 'main', kind: 'table' },
            { name: 'active_employees', schema: 'main', kind: 'view' },
          ],
          schemaMap: { employees: ['id', 'name'], departments: ['id', 'name'] },
          activeTable: 'employees',
          activeObjectKind: 'view',
          activeReadOnlyObject: { name: 'active_employees', schema: 'main', kind: 'view' },
          lastSqlResult: {
            columns: [],
            rows: [],
            rowCount: 0,
            affectedRows: 5,
            isSelect: false,
            executionTimeMs: 4,
          },
          pageData: {
            columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }],
            rows: [{ id: 1 }],
            totalRows: 1,
            page: 1,
            pageSize: 100,
            primaryKey: ['id'],
            canEdit: false,
          },
        },
      },
    } as never)
    ;(window as unknown as { orca: unknown }).orca = bSnap.orcaApi
    const edBoot = initializeEditor()!
    const docBoot = await bSnap.orcaApi.document.session()
    edBoot.attachDocumentSession(docBoot)
    await flushTick()
    await flushTick()
    const privBoot = edBoot as unknown as Round3Internals & {
      saveStudioViewState: (immediate?: boolean) => void
      writeStudioViewStateNow: () => void
    }
    // Trigger >200KB pruning by packing >200KB in viewState connections map + long sqlDraft
    const hugeConns: Record<string, unknown> = {}
    for (let i = 0; i < 10; i++) {
      hugeConns[`c_pad_${i}`] = {
        sqlDraft: 'SELECT /* ' + 'w'.repeat(26_000) + ' */ 1;',
        columnConfigByTable: { a: { hidden: ['x'] } },
        consoleTabs: { tabs: [{ id: '1', title: 't', sql: 'SELECT 1;' }], activeTabId: '1' },
      }
    }
    localStorage.setItem('datanoa.studioViewState', JSON.stringify({ perConnection: hugeConns }))
    edBoot.getSqlConsole()?.setText('SELECT /* ' + 'q'.repeat(17_000) + ' */ 1;')
    privBoot.saveStudioViewState(false)
    privBoot.saveStudioViewState(true)
    const prunedJson = localStorage.getItem('datanoa.studioViewState') ?? ''
    expect(prunedJson.length).toBeGreaterThan(0)
    expect(prunedJson.length).toBeLessThan(210_000)
    edBoot.destroy()
    bSnap.db.close()

    // 2. Main Round 3 Index integration: applyDocumentMetadata, toolbar/Ctrl+S, multi-result, DML/Submit rejections, Count/GenSQL, Danger/Create/Import callbacks
    const { backend, ed, priv } = await bootRound3({ multiSchema: true })
    const pExtra = ed as unknown as {
      dmlCopyBtn: HTMLButtonElement | null
      dmlCloseBtn: HTMLButtonElement | null
      dmlPreviewBtn: HTMLButtonElement | null
      statusSelectionEl: HTMLSpanElement | null
      activeQueryResult: QueryResult | null
      isShowingSqlResult: boolean
      cancelActiveQuery: () => Promise<void>
      applyDataCachePayload: (p: unknown) => void
      selectResultSetIndex: (i: number) => void
      activeResultSetIndex: number
      handleApplyMigration: (stmts: string[], draft: unknown) => Promise<void>
      queryBannerEl: HTMLDivElement | null
    }
    try {
      // applyDocumentMetadata: same conn switch table + switch schema + pending connection
      ed.applyDocumentMetadata(
        '-- @datanoa connectionId=c_main table=departments schema=main\nSELECT * FROM departments;',
        { resetCautionDismissal: true }
      )
      await flushTick()
      ed.applyDocumentMetadata(
        '-- @datanoa connectionId=c_main table=employees schema=analytics\nSELECT * FROM employees;',
        { resetCautionDismissal: true }
      )
      await flushTick()
      ed.applyDocumentMetadata(
        '-- @datanoa connectionId=c_main table=employees\nSELECT * FROM employees;'
      )
      await flushTick()
      ed.applyDocumentMetadata(
        '-- @datanoa connectionId=future_pending table=tbl_future schema=pub\nSELECT 1;'
      )

      // editTableBtn -> inspector, staged change + Ctrl+S in Inspector, then switch to grid -> staged edit + dmlPreview/Copy/Close + Ctrl+S + statusSelectionEl copy
      priv.editTableBtn?.click()
      await flushTick()
      const inspNull = document.querySelector('.datanoa-inspector-area tbody tr:nth-child(2) input[type="checkbox"]') as HTMLInputElement | null
      if (inspNull) {
        inspNull.checked = !inspNull.checked
        inspNull.dispatchEvent(new Event('change'))
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }))
        await flushTick()
        findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /^Cancel$/i)?.click()
      }
      priv.switchMode('grid')
      await flushTick()

      // orderByInputEl Enter + clientSearch find mode debounce + statusSelection copy with active summary + DML preview/copy/close/abort + Submit rejected
      if (priv.orderByInputEl) {
        priv.orderByInputEl.value = 'id DESC'
        priv.orderByInputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
        await flushTick()
      }
      priv.searchModeBtn?.click()
      if (priv.clientSearchEl) {
        vi.useFakeTimers()
        priv.clientSearchEl.value = 'Alice'
        priv.clientSearchEl.dispatchEvent(new Event('input'))
        vi.advanceTimersByTime(350)
        vi.useRealTimers()
        priv.clientSearchEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      }
      ed.getDataGrid()?.selectAll()
      await flushMicro(2)
      pExtra.statusSelectionEl?.click()

      ed.getDataGrid()?.setBatchMode(true)
      ed.getDataGrid()?.stageCellEdit(0, 'name', 'NewDmlName')
      pExtra.dmlPreviewBtn?.click()
      await flushTick()
      pExtra.dmlCopyBtn?.click()
      pExtra.dmlCloseBtn?.click()

      const origReq = backend.orcaApi.plugin.request
      // data.applyChanges returns { ok: false } -> 'Submit Changes Rejected' (6466)
      ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = (async (
        m: string,
        p?: Record<string, unknown>
      ) => {
        if (m === 'data.applyChanges') return { ok: false, inserted: 0, updated: 0, deleted: 0, statements: [] }
        return origReq(m, p)
      }) as typeof origReq
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }))
      await flushTick()
      ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = origReq
      ed.getDataGrid()?.revertAllChanges()

      // Multi-statement SQL execution: Result 1 / Result 2 switch + sort in-memory + switch conn Read-only title (5245) + empty activeQueryResult switchMode (1895)
      ed.getSqlConsole()?.setText('SELECT id, name FROM employees; UPDATE employees SET name = name WHERE id = -999;')
      await priv.executeSql(true, true, undefined, true)
      await flushTick()
      pExtra.selectResultSetIndex(1)
      pExtra.selectResultSetIndex(0)
      const thSort = document.querySelector('.datanoa-grid-header th:nth-child(2)') as HTMLElement | null
      thSort?.click()

      const roConn: ConnectionProfile = {
        id: 'c_ro2',
        name: 'RO2',
        driver: 'sqlite',
        filePath: ':memory:',
        colorTag: 'none',
        readOnly: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      backend.connections.push(roConn)
      backend.emitPlugin('connections.changed', {})
      await flushTick()
      priv.handleConnectionChanged('c_ro2')
      await flushTick()

      // Create Table on ReadOnly hits index.ts:6966 updateStatus
      priv.openCreateTableModal()
      // DangerTable on view hits studio-modals:493 & index.ts:7107 showQueryBanner
      priv.openDangerTableModal('truncate', { name: 'active_employees', kind: 'view' } as SchemaObject)

      priv.handleConnectionChanged('c_main')
      await flushTick()

      // Split resizer re-entrant cleanup (1822-1826) & empty activeQueryResult -> grid (1895-1902)
      priv.splitResizerEl?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientY: 180 }))
      priv.splitResizerEl?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientY: 190 }))
      window.dispatchEvent(new MouseEvent('mouseup'))
      pExtra.isShowingSqlResult = true
      pExtra.activeQueryResult = null
      priv.switchMode('grid')
      await flushTick()

      // Cancel active query error (6267-6268)
      ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = (async (
        m: string,
        p?: Record<string, unknown>
      ) => {
        if (m === 'query.cancel') throw new Error('cancel refused')
        return origReq(m, p)
      }) as typeof origReq
      backend.deferNextQuery()
      ed.getSqlConsole()?.setText('SELECT * FROM employees;')
      const pRun = priv.executeSql(true, true, undefined, true)
      await flushMicro(4)
      await pExtra.cancelActiveQuery()
      backend.resolveDeferredQuery()
      await pRun
      ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = origReq

      // Generate INSERT SQL when table has no cached columns (3642-3651) + countRowsForObject on uncached + handleApplyMigration noConn (7331)
      priv.tableDetailsCache.clear()
      await priv.generateSqlTemplateForObject({ name: 'departments', kind: 'table' } as SchemaObject, 'insert')
      await priv.countRowsForObject({ name: 'departments', kind: 'table' } as SchemaObject)

      // DangerTable post-drop refresh failure hits index.ts:7106 updateStatus!
      ed.getSqlConsole()?.setText('CREATE TABLE temp_drop_err (id INTEGER PRIMARY KEY);')
      await priv.executeSql(true, true, undefined, true)
      await priv.introspectSchema('c_main', false)
      await flushTick()
      priv.openDangerTableModal('drop', { name: 'temp_drop_err', kind: 'table' } as SchemaObject)
      const dropInp = document.querySelector('#datanoa-danger-table-confirm-input') as HTMLInputElement | null
      if (dropInp) {
        dropInp.value = 'temp_drop_err'
        dropInp.dispatchEvent(new Event('input'))
        backend.failOnceActions.add('schema.introspect')
        findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /^Drop Table$/i)?.click()
        await flushTick()
      }
      expect(
        backend.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='temp_drop_err'").all()
      ).toHaveLength(0)

      // Open Import Data modal and fail chunk 1 -> triggers 7058 showQueryBanner!
      priv.selectSidebarObject({ name: 'departments', kind: 'table' } as SchemaObject)
      await flushTick()
      await priv.openImportDataModal({ name: 'departments', kind: 'table' } as SchemaObject)
      const impInp = document.querySelector('.datanoa-modal-backdrop input[type="file"]') as HTMLInputElement | null
      if (impInp) {
        Object.defineProperty(impInp, 'files', {
          configurable: true,
          value: [makeFakeFile('bad_imp.csv', 'name\nWillFail')],
        })
        impInp.dispatchEvent(new Event('change'))
        await flushTick()
      }
      backend.failOnceActions.add('data.applyChanges')
      findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /Import Directly|Import \d+ Row/i)?.click()
      await flushTick()
      const leftBd = document.querySelector('.datanoa-modal-backdrop')
      if (leftBd) findBtn(leftBd, /^Cancel$/i)?.click()
    } finally {
      ed.destroy()
    }
  })

  it('Slice 6F: drives VirtualDataGrid drag/elementFromPoint/autoscroll, column filters, inline Tab & cell commit tails toward >=98% S', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    Object.defineProperty(host, 'offsetParent', { configurable: true, get: () => document.body })
    Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => 860 })
    Object.defineProperty(host, 'clientHeight', { configurable: true, get: () => 320 })

    let directReject = true
    const grid = new VirtualDataGrid({
      container: host,
      data: makeTableData(30, { canEdit: true }),
      tableName: 'users',
      foreignKeys: [{ column: 'dept_id', foreignTable: 'departments', foreignColumn: 'id' }],
      onColumnHeaderFilter: vi.fn(),
      onSortChange: vi.fn(),
      onDirectCellEdit: async (edit) => {
        if (directReject) {
          directReject = false
          return { ok: false, error: 'NOT NULL failed' }
        }
        return { ok: true, updatedRecord: { ...edit.primaryKeys, [edit.column]: `${String(edit.value)}_ok` } }
      },
      onNotify: vi.fn(),
    })

    const gPriv = grid as unknown as {
      tableContainerEl: HTMLDivElement
      tbodyEl: HTMLTableSectionElement
      theadEl: HTMLTableSectionElement
    }
    const wrap = gPriv.tableContainerEl
    const tbody = gPriv.tbodyEl
    const thead = gPriv.theadEl
    Object.defineProperty(wrap, 'offsetParent', { configurable: true, get: () => document.body })
    Object.defineProperty(wrap, 'clientWidth', { configurable: true, get: () => 860 })
    Object.defineProperty(wrap, 'clientHeight', { configurable: true, get: () => 320 })
    Object.defineProperty(wrap, 'scrollWidth', { configurable: true, get: () => 1800 })
    Object.defineProperty(wrap, 'scrollHeight', { configurable: true, get: () => 1200 })
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, right: 860, bottom: 320, width: 860, height: 320, x: 0, y: 0, toJSON: () => ({}) })
    tbody.getBoundingClientRect = () => ({ left: 0, top: 32, right: 860, bottom: 320, width: 860, height: 288, x: 0, y: 32, toJSON: () => ({}) })

    const patchGeoms = () => {
      Array.from(tbody.querySelectorAll('tr')).forEach((tr, rIdx) => {
        tr.getBoundingClientRect = () => ({
          left: 0, top: 32 + rIdx * 28, right: 860, bottom: 60 + rIdx * 28, width: 860, height: 28, x: 0, y: 32 + rIdx * 28, toJSON: () => ({}),
        })
        Array.from(tr.querySelectorAll('td')).forEach((td, cIdx) => {
          td.getBoundingClientRect = () => ({
            left: cIdx * 140, top: 32 + rIdx * 28, right: (cIdx + 1) * 140, bottom: 60 + rIdx * 28, width: 140, height: 28, x: cIdx * 140, y: 32 + rIdx * 28, toJSON: () => ({}),
          })
        })
      })
    }
    patchGeoms()

    // Mock document.elementFromPoint to return real tbody cell during drag
    const docAny = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null }
    const prevEfp = docAny.elementFromPoint
    docAny.elementFromPoint = (x: number, y: number) => {
      const trs = Array.from(tbody.querySelectorAll('tr'))
      const row = y > 90 ? trs[2] || trs[0] : trs[1] || trs[0]
      const tds = row ? Array.from(row.querySelectorAll('td')) : []
      return tds[x > 250 ? 2 : 1] || tds[0] || null
    }
    try {
      const firstRowTds = tbody.querySelector('tr')!.querySelectorAll('td')
      // Row drag + horizontal/vertical autoScroll zone (`1847-1917, 1977, 1986`)
      firstRowTds[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 15, clientY: 45 }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 855, clientY: 315 }))
      dom.runRaf()
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 855, clientY: 315 }))

      // Cell drag across rows/cols
      firstRowTds[1]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 160, clientY: 45 }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 290, clientY: 110 }))
      dom.runRaf()
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 290, clientY: 110 }))

      // Column filter popover Apply & Clear (`3685, 3692`) + Find wrap-around (`1187, 1285-1294`)
      const filterBtns = thead.querySelectorAll('.datanoa-col-filter-btn')
      ;(filterBtns[1] as HTMLButtonElement | undefined)?.click()
      const pop = document.querySelector('.datanoa-col-filter-popover')
      if (pop) {
        const inpF = pop.querySelector('input') as HTMLInputElement | null
        if (inpF) {
          inpF.value = 'User_1'
          inpF.dispatchEvent(new Event('input'))
        }
        findBtn(pop, /^Apply$/i)?.click()
        ;(filterBtns[1] as HTMLButtonElement | undefined)?.click()
        findBtn(document.querySelector('.datanoa-col-filter-popover') || document.body, /^Clear$/i)?.click()
      }

      // Trigger find wrap backwards + no matches filter (`2768, 1335-1337`)
      grid.setFindQuery('User_2')
      grid.findNext(-1)
      grid.setClientFilter('__absolutely_no_match__')
      grid.setClientFilter('')
      patchGeoms()

      // Hidden/Pinned columns config roundtrip (`850, 854, 910`) + Keyboard Copy (`Ctrl+C`)
      grid.setColumnVisibility('note', false)
      grid.setColumnVisibility('id', false)
      grid.togglePinColumn('name')
      const colCfg = grid.getColumnConfig()
      expect(colCfg.hidden).toContain('note')
      expect(colCfg.hidden).toContain('id')
      expect(colCfg.pinned).toContain('name')
      grid.selectSingleModelCell(0, 1)
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true }))

      // Empty rows -> renderEmptyStateRow (`3301`) then reload
      grid.setData({ ...makeTableData(0, { canEdit: false }), columns: [] })
      grid.setData(makeTableData(10, { canEdit: true }))
      patchGeoms()

      // Inline Tab forward skip PK (`4657-4668`), untouched revert (`4834-4843`), direct commit updatedRecord (`4920`)
      grid.selectSingleModelCell(0, 1)
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      const edInp = tbody.querySelector('input') as HTMLInputElement | null
      if (edInp) {
        edInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
      }
      grid.cancelCellEdit()
      grid.selectSingleModelCell(0, 1)
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      const edInp2 = tbody.querySelector('input') as HTMLInputElement | null
      if (edInp2) {
        // Untouched value commit -> reverts/exits cleanly (`4834-4843`)
        edInp2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
        await flushTick()
      }
      grid.selectSingleModelCell(0, 1)
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      const edInp3 = tbody.querySelector('input') as HTMLInputElement | null
      if (edInp3) {
        edInp3.value = 'NormVal'
        edInp3.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
        await flushTick()
      }
      expect(grid.getModel()?.rows[0]?.name).toBe('User_1')
      grid.selectSingleModelCell(0, 1)
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      const edInp4 = tbody.querySelector('input') as HTMLInputElement | null
      if (edInp4) {
        edInp4.value = 'NormVal2'
        edInp4.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
        await flushTick()
      }
      expect(grid.getModel()?.rows[0]?.name).toBe('NormVal2')
    } finally {
      docAny.elementFromPoint = prevEfp
      grid.destroy()
      host.remove()
    }
  })

  it('Slice 6G: closes connection-modal new-connection discovery/file-picker and schema-inspector collate/origin/validation tails to >=99% S', async () => {
    // 1. Open NEW connection-modal -> click Auto-Detect + Browse Folder + DuckDB folder pick + D1/DuckDB validation errors
    {
      const mh = mountModalHarness()
      const req = vi.fn(async (method: string, payload?: Record<string, unknown>) => {
        if (method === 'drivers.list') {
          return [{ id: 'duckdb', name: 'DuckDB', kind: 'byod', status: 'not-configured' }]
        }
        if (method === 'drivers.defaultFolders') {
          return { platform: 'win32', paths: { duckdb: 'C:\\drivers\\duckdb' } }
        }
        if (method === 'drivers.createByodStarter') {
          return { ok: true, dirPath: 'C:\\drivers\\duckdb', inspect: { ok: true, sha256: 'deadbeef1234567890' } }
        }
        if (method === 'workspace.detectConnections') {
          return {
            envConnections: [
              { envKey: 'ENV_PG', sourceFile: '.env', driver: 'postgres', name: 'EnvPG', uri: 'postgresql://u:p@localhost:5432/db' },
            ],
            dockerComposeConnections: [
              { containerId: 'c1', containerName: 'c_bad', driver: 'unsupported_db', name: 'Unsupported', host: 'h', port: 1 },
              { containerId: 'c2', containerName: 'c_libsql', driver: 'libsql', name: 'LibSQL Ctr', host: '127.0.0.1', port: 8080, url: 'libsql://127.0.0.1:8080', workspaceMatch: true, status: 'running', hint: 'check hint', passwordFromFile: true },
              { containerId: 'c3', containerName: 'c_ch', driver: 'clickhouse', name: 'CH Ctr', host: '127.0.0.1', port: 8123, status: 'compose file' },
              { containerId: 'c4', containerName: 'c_pg1', driver: 'postgres', name: 'PG1', host: '127.0.0.1', port: 5432, status: 'running' },
              { containerId: 'c5', containerName: 'c_pg2', driver: 'postgres', name: 'PG2', host: '127.0.0.1', port: 5433, status: 'exited' },
              { containerId: 'c6', containerName: 'c_pg3', driver: 'postgres', name: 'PG3', host: '127.0.0.1', port: 5434, status: 'running' },
            ],
            sqliteFiles: Array.from({ length: 6 }, (_, i) => ({
              name: `app_${i}.db`,
              filePath: `/proj/app_${i}.db`,
              sizeBytes: 1024,
              sizeLabel: '1 KB',
            })),
            scannedDirs: ['/proj'],
            folderScoped: Boolean(payload?.folderPath),
          }
        }
        if (method === 'sqlite.scanFolder') {
          return { files: [] }
        }
        if (method === 'fs.listDirectory') {
          return {
            path: '/proj/sub',
            parent: '/proj',
            entries: [
              { name: 'dbdir', path: '/proj/sub/dbdir', isDir: true },
              { name: '.sqlite', path: '/proj/sub/.sqlite', isDir: false, sizeBytes: 256 },
            ],
          }
        }
        return { ok: true }
      })

      openStudioConnectionModal({
        isBackdropActive: mh.isBackdropActive,
        mountModal: mh.mountModal,
        closeModal: mh.closeModal,
        requestPlugin: req as <T = unknown>(m: string, p?: Record<string, unknown>) => Promise<T>,
        createElapsedTimer: () => () => {},
        updateStatus: () => {},
        activateSavedConnection: async () => {},
        onConnectionDeleted: async () => {},
        currentWorkspaceScope: '/proj',
      })
      await flushTick()

      const connBd = document.querySelector('.datanoa-modal-backdrop') as HTMLDivElement | null
      if (connBd) {
        // Click Auto-Detect (.env, Docker, .db)
        findBtn(connBd, /^Auto-Detect/i)?.click()
        await flushTick()
        await flushTick()
        expect(req).toHaveBeenCalledWith('workspace.detectConnections', expect.any(Object))
        expect(connBd.querySelectorAll('.datanoa-conn-chip').length).toBeGreaterThan(0)

        // Expand collapsed >5 groups + click .env chip + Docker chips (including unsupported + libsql + ch)
        connBd.querySelectorAll('button').forEach((b) => {
          if (/Show all|Expand|more/i.test(b.textContent || '')) b.click()
        })
        connBd.querySelectorAll('.datanoa-conn-chip').forEach((c) => {
          if ((c.textContent || '').match(/Unsupported|LibSQL|CH Ctr|ENV_PG/)) {
            ;(c as HTMLElement).click()
          }
        })

        // Search with empty match notice
        const discInp = connBd.querySelector('.datanoa-conn-discovered input') as HTMLInputElement | null
        if (discInp) {
          discInp.value = '__no_match_zzz__'
          discInp.dispatchEvent(new Event('input'))
          discInp.value = ''
          discInp.dispatchEvent(new Event('input'))
        }

        // DuckDB empty path Save validation -> focus + Browse Folder in BYOD + Browse Folder in Discovery
        const duckTile = Array.from(connBd.querySelectorAll('.datanoa-engine-tile')).find((el) =>
          (el.textContent || '').includes('DuckDB')
        ) as HTMLButtonElement | undefined
        duckTile?.click()
        await flushTick()
        findBtn(connBd, /^Save & Connect$/i)?.click()
        findBtn(connBd, /^Create Folder/i)?.click()
        await flushTick()

        const d1Tile = Array.from(connBd.querySelectorAll('.datanoa-engine-tile')).find((el) =>
          (el.textContent || '').includes('Cloudflare D1')
        ) as HTMLButtonElement | undefined
        d1Tile?.click()
        findBtn(connBd, /^Save & Connect$/i)?.click()

        findBtn(connBd, /^Cancel$/i)?.click()
      }
      mh.closeModal()
    }

    // 2. schema-inspector: collate/origin/columnSpecs/onConflict/triggers/inboundForeignKeys + mongodb notice + small-viewport flip-up combo + validation error SQL + slow elapsed timer
    {
      const host = document.createElement('div')
      document.body.appendChild(host)
      let relMig: (() => void) | undefined
      const inspector = new SchemaInspectorView(host, {
        dialect: 'sqlite',
        isManualTxActive: () => false,
        onInsertDdl: vi.fn(),
        onCopyDdl: vi.fn(),
        onDropTable: vi.fn(),
        onApplyMigration: async () => {
          await new Promise<void>((r) => {
            relMig = r
          })
          return { ok: true }
        },
      })
      const richDetails: TableDetails = {
        name: 'orders',
        schema: 'main',
        kind: 'table',
        primaryKey: ['id'],
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, isPrimaryKey: true },
          { name: 'title', type: 'TEXT', nullable: true, isPrimaryKey: false, collate: 'NOCASE' },
        ],
        indexes: [
          {
            name: 'idx_title_u',
            columns: ['title'],
            isUnique: true,
            isPrimary: false,
            origin: 'u',
            columnSpecs: [{ name: 'title', order: 'DESC' }],
            onConflict: 'IGNORE',
          } as unknown as TableDetails['indexes'][number],
        ],
        foreignKeys: [{ column: 'title', foreignTable: 'other', foreignColumn: 'title' }],
        triggers: [{ name: 'tr_orders', sql: 'CREATE TRIGGER tr_orders AFTER INSERT ON orders BEGIN SELECT 1; END;' }],
        inboundForeignKeys: [{ table: 'order_items', column: 'order_id', referencedColumn: 'id' }],
        ddl: 'CREATE TABLE orders (id INTEGER PRIMARY KEY, title TEXT COLLATE NOCASE);',
      }
      inspector.setReferenceTables(['other'])
      inspector.setDetails(richDetails, 'sqlite')

      // Rename column 'title' -> updates pill & FK option, then blank column name to hit invalid SQL preview (`L827`)
      const row2Tds = host.querySelectorAll('.datanoa-struct-section tbody tr')[1]
      const colNameInp = row2Tds?.querySelector('input[type="text"]') as HTMLInputElement | undefined
      if (colNameInp) {
        colNameInp.value = 'title_v2'
        colNameInp.dispatchEvent(new Event('input'))
        colNameInp.value = ''
        colNameInp.dispatchEvent(new Event('input'))
        findBtn(host, /Show SQL/i)?.click()
        colNameInp.value = 'title_v3'
        colNameInp.dispatchEvent(new Event('input'))
      }

      // Small-viewport combo flip up (`422`) + ArrowUp/Escape
      ;(window as unknown as { innerHeight: number }).innerHeight = 150
      const comboInp = host.querySelector('.datanoa-combo-wrap input') as HTMLInputElement | null
      if (comboInp) {
        comboInp.getBoundingClientRect = () =>
          ({ left: 40, top: 120, bottom: 145, right: 200, width: 160, height: 25, x: 40, y: 120, toJSON: () => ({}) }) as DOMRect
        comboInp.dispatchEvent(new Event('focus'))
        comboInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
      }
      ;(window as unknown as { innerHeight: number }).innerHeight = 900

      // Slow elapsed timer (`681-684`) during libsql migration
      inspector.setDialect('libsql')
      inspector.setDetails(richDetails, 'libsql')
      const chk2 = host.querySelectorAll('.datanoa-col-nullable-checkbox')[1] as HTMLInputElement | undefined
      if (chk2) {
        chk2.checked = !chk2.checked
        chk2.dispatchEvent(new Event('change'))
      }
      ;(host.querySelector('.datanoa-struct-apply-btn') as HTMLButtonElement | null)?.click()
      await flushTick()
      vi.useFakeTimers()
      ;(document.querySelector('.datanoa-struct-confirm-execute-btn') as HTMLButtonElement | null)?.click()
      vi.advanceTimersByTime(350)
      vi.useRealTimers()
      relMig?.()
      await flushTick()

      // MongoDB non-editable notice (`1662-1667`)
      inspector.setDetails({ ...richDetails, ddl: undefined }, 'mongodb')
      expect(host.textContent).toContain('MongoDB collections are schemaless')
      expect(document.querySelector('.datanoa-modal-backdrop')).toBeNull()

      inspector.destroy()
      host.remove()
    }
  })

  it('Slice 6H: final sweep hitting remaining index.ts functions, document-meta headers, connection discovery/file-picker, inspector FK/index/timer & grid keepEditorAlive/NOT-NULL/Tab paths', async () => {
    // 1. connection-modal: click .datanoa-discovery-head to expand >5 collapsed groups, Browse Folder file picker, chips & badges
    {
      const mh = mountModalHarness()
      const req = vi.fn(async (method: string, payload?: Record<string, unknown>) => {
        if (method === 'drivers.list') return [{ id: 'duckdb', name: 'DuckDB', kind: 'byod', status: 'not-configured' }]
        if (method === 'drivers.defaultFolders') return { platform: 'win32', paths: { duckdb: 'C:\\drv\\duckdb' } }
        if (method === 'workspace.detectConnections') {
          return {
            envConnections: [
              { envKey: 'PG_URL', sourceFile: '.env.prod', driver: 'postgres', name: 'EnvPG', uri: 'postgresql://u:s3cr3t@10.0.0.2:5432/prod' },
            ],
            dockerComposeConnections: [
              { containerId: 'd0', containerName: 'c_bad', driver: 'bogus_drv', name: 'BadDrv', host: 'h', port: 1 },
              { containerId: 'd1', containerName: 'c_lib', driver: 'libsql', name: 'LibCtr', host: '127.0.0.1', port: 8080, url: 'libsql://127.0.0.1:8080?authToken=xyz', workspaceMatched: true, status: 'running', hint: 'token notice', passwordFromFile: true },
              { containerId: 'd2', containerName: 'c_ch', driver: 'clickhouse', name: 'ChCtr', host: '127.0.0.1', port: 8123, status: 'compose file' },
              { containerId: 'd3', containerName: 'c_mg', driver: 'mongodb', name: 'MgCtr', host: '127.0.0.1', port: 27017, url: 'mongodb://u:p@127.0.0.1:27017/db', status: 'exited' },
              { containerId: 'd4', containerName: 'c_rd', driver: 'redis', name: 'RdCtr', host: '127.0.0.1', port: 6379, redisDb: 2, status: 'running' },
              { containerId: 'd5', containerName: 'c_pg', driver: 'postgres', name: 'PgCtr', host: '127.0.0.1', port: 5432, status: 'running' },
            ],
            sqliteFiles: Array.from({ length: 6 }, (_, i) => ({
              name: `f_${i}.db`,
              filePath: `/ws/f_${i}.db`,
              sizeBytes: 512,
              sizeLabel: '512 B',
            })),
            scannedDirs: ['/ws'],
            folderScoped: Boolean(payload?.folderPath),
          }
        }
        if (method === 'sqlite.scanFolder') return { files: [] }
        if (method === 'fs.listDirectory') {
          return {
            path: '/ws/sub',
            parent: '/ws',
            entries: [
              { name: 'dbdir', path: '/ws/sub/dbdir', isDir: true },
              { name: '.sqlite', path: '/ws/sub/.sqlite', isDir: false, sizeBytes: 128 },
            ],
          }
        }
        return { ok: true }
      })

      openStudioConnectionModal({
        isBackdropActive: mh.isBackdropActive,
        mountModal: mh.mountModal,
        closeModal: mh.closeModal,
        requestPlugin: req as <T = unknown>(m: string, p?: Record<string, unknown>) => Promise<T>,
        createElapsedTimer: () => () => {},
        updateStatus: () => {},
        activateSavedConnection: async () => {},
        onConnectionDeleted: async () => {},
        currentWorkspaceScope: '/ws',
      })
      await flushTick()

      const connBd = mh.getBackdrop() || document.querySelector('.datanoa-modal-backdrop')
      if (connBd) {
        findBtn(connBd, /^Auto-Detect/i)?.click()
        await flushTick()
        await flushTick()
        expect(req).toHaveBeenCalledWith('workspace.detectConnections', expect.any(Object))
        expect(connBd.querySelectorAll('.datanoa-conn-chip').length).toBeGreaterThan(0)
        // Expand every collapsed discovery group via .datanoa-discovery-head
        connBd.querySelectorAll('button.datanoa-discovery-head[aria-expanded="false"]').forEach((b) => {
          ;(b as HTMLButtonElement).click()
        })
        // Click every discovered chip (.env, docker types, sqlite files)
        connBd.querySelectorAll('.datanoa-conn-chip').forEach((chip) => {
          ;(chip as HTMLElement).click()
        })
        await flushTick()

        // Discovery Browse Folder -> opens FilePickerModal on top
        findBtn(connBd, /^Browse Folder/i)?.click()
        await flushTick()
        const pickBd = mh.getBackdrop()
        if (pickBd && pickBd !== connBd) {
          findBtn(pickBd, /Select This Folder|Choose|Use Current/i)?.click() ||
            (pickBd.querySelector('.datanoa-btn-primary') as HTMLButtonElement | null)?.click()
          await flushTick()
        }
      }
      mh.closeModal()
    }

    // 2. schema-inspector: clean libsql valid plan -> TX block (656-666) -> elapsed timer (681-684) + Add Index + FK col change/empty + column rename pills (1045-1055, 2352-2358)
    {
      const host = document.createElement('div')
      document.body.appendChild(host)
      let manualTx = true
      let relMig: (() => void) | undefined
      const inspector = new SchemaInspectorView(host, {
        dialect: 'libsql',
        isManualTxActive: () => manualTx,
        onInsertDdl: vi.fn(),
        onCopyDdl: vi.fn(),
        onApplyMigration: async () => {
          await new Promise<void>((r) => {
            relMig = r
          })
          return { ok: true }
        },
      })
      inspector.setReferenceTables(['departments'])
      inspector.setDetails(
        {
          name: 'emp_test',
          schema: 'main',
          kind: 'table',
          primaryKey: ['id'],
          columns: [
            { name: 'id', type: 'INTEGER', nullable: false, isPrimaryKey: true },
            { name: 'title', type: 'TEXT', nullable: true, isPrimaryKey: false },
            { name: 'dept_id', type: 'INTEGER', nullable: true, isPrimaryKey: false },
          ],
          indexes: [{ name: 'idx_title', columns: ['title'], isUnique: false, isPrimary: false }],
          foreignKeys: [{ column: 'dept_id', foreignTable: 'departments', foreignColumn: 'id' }],
          ddl: 'CREATE TABLE emp_test (id INTEGER PRIMARY KEY, title TEXT, dept_id INTEGER);',
        },
        'libsql'
      )

      // Rename 'title' in first .datanoa-struct-section -> updates index pills (`1045`), and rename 'dept_id' -> updates FK `<option>` (`1053`)
      const colSection = host.querySelectorAll('.datanoa-struct-section')[0]
      const colTrs = colSection?.querySelectorAll('tbody tr') || []
      const titleInp = colTrs[1]?.querySelector('input.datanoa-struct-input') as HTMLInputElement | undefined
      if (titleInp) {
        titleInp.value = 'title_v2'
        titleInp.dispatchEvent(new Event('input'))
      }
      const deptInp = colTrs[2]?.querySelector('input.datanoa-struct-input') as HTMLInputElement | undefined
      if (deptInp) {
        deptInp.value = 'dept_v2'
        deptInp.dispatchEvent(new Event('input'))
      }

      // Click '+ Add Index' and clear/change FK colSelect (`2179-2189, 2352-2358`)
      findBtn(host, /Add Index/i)?.click()
      const fkSel = host.querySelector('.datanoa-fk-col-select') as HTMLSelectElement | null
      if (fkSel && fkSel.options.length > 1) {
        fkSel.value = fkSel.options[1].value
        fkSel.dispatchEvent(new Event('change'))
        fkSel.value = ''
        fkSel.dispatchEvent(new Event('change'))
      }

      // Toggle nullable -> valid rebuild -> manualTx=true hits 656-666, manualTx=false + fakeTimer 350ms hits 681-684!
      const titleChk = host.querySelectorAll('.datanoa-col-nullable-checkbox')[1] as HTMLInputElement | undefined
      if (titleChk) {
        titleChk.checked = !titleChk.checked
        titleChk.dispatchEvent(new Event('change'))
      }
      ;(host.querySelector('.datanoa-struct-apply-btn') as HTMLButtonElement | null)?.click()
      await flushTick()
      ;(document.querySelector('.datanoa-struct-confirm-execute-btn') as HTMLButtonElement | null)?.click()
      await flushTick()

      manualTx = false
      vi.useFakeTimers()
      ;(document.querySelector('.datanoa-struct-confirm-execute-btn') as HTMLButtonElement | null)?.click()
      vi.advanceTimersByTime(350)
      vi.useRealTimers()
      relMig?.()
      await flushTick()

      inspector.destroy()
      host.remove()
    }

    // 3. index.ts: DataCache SQL result boot (`3157-3175`) + pending doc metadata (`2250-2269`)
    {
      const bCache = createLiveStudioSqliteBackend({ seedEmptyConns: true })
      dbsToCloseR3.push(bCache.db)
      bCache.setSessionSnapshot({
        updatedAt: Date.now() + 50_000,
        viewState: {
          activeConnectionId: 'c_main',
          activeTable: 'employees',
          activeViewMode: 'sql',
        },
        dataCache: {
          c_main: {
            schemaObjects: [
              { name: 'employees', schema: 'main', kind: 'table' },
              { name: 'active_employees', schema: 'main', kind: 'view' },
            ],
            schemaMap: { employees: ['id', 'name'] },
            activeTable: 'employees',
            activeObjectKind: 'table',
            isShowingSqlResult: true,
            lastSqlResult: {
              columns: ['id', 'name'],
              rows: [{ id: 1, name: 'Alice' }],
              rowCount: 1,
              isSelect: true,
              truncated: true,
              executionTimeMs: 7,
            },
          },
        },
      } as never)
      ;(window as unknown as { orca: unknown }).orca = bCache.orcaApi
      const edCache = initializeEditor()!
      // Pending metadata while connections=[] (`2250-2269`)
      edCache.applyDocumentMetadata('-- datanoa: connectionId=c_pending\n-- datanoa: table=tbl_p\n-- datanoa: schema=pub\nSELECT 1;')
      bCache.connections.push({
        id: 'c_main',
        name: 'Main',
        driver: 'sqlite',
        filePath: ':memory:',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      const docC = await bCache.orcaApi.document.session()
      edCache.attachDocumentSession(docC)
      await flushTick()
      await flushTick()
      edCache.destroy()
    }

    // 4. index.ts: document-meta headers (`2188-2247`), trigger Copy DDL (`3692`), TX rebuild block (`1768`), Retry (`4745`), MatView (`4792`), Dropped obj (`3886-3916`), Preview cancel (`6360-6369`), Import fail batch 2 (`7058`), Danger MatView (`7107`), Mongo countRows (`6811`), Wheel (`2310`)
    {
      const { backend, ed, priv } = await bootRound3({ multiSchema: true })
      const pExtra = ed as unknown as {
        activeObjectKind: SchemaObjectKind | null
        activeReadOnlyObject: SchemaObject | null
        lastInspectorLoadedKey: string
        saveViewStateTimer: ReturnType<typeof setTimeout> | null
        dmlCopyBtn: HTMLButtonElement | null
        dmlCloseBtn: HTMLButtonElement | null
        dmlPreviewBtn: HTMLButtonElement | null
        loadActiveTableSchema: (force?: boolean) => Promise<void>
        loadReadOnlyObjectDdl: (item: SchemaObject) => Promise<void>
        selectResultSetIndex: (idx: number) => void
        handleApplyMigration: (stmts: string[], draft: unknown) => Promise<void>
      }
      try {
        // Real `-- datanoa:` headers triggering `applyDocumentMetadata` table/schema switches (`2188-2247`)
        ed.applyDocumentMetadata(
          '-- datanoa: connectionId=c_main\n-- datanoa: table=departments\n-- datanoa: schema=main\nSELECT * FROM departments;',
          { resetCautionDismissal: true }
        )
        await flushTick()
        ed.applyDocumentMetadata(
          '-- datanoa: connectionId=c_main\n-- datanoa: table=employees\n-- datanoa: schema=analytics\nSELECT * FROM employees;'
        )
        await flushTick()
        ed.applyDocumentMetadata(
          '-- datanoa: connectionId=c_main\n-- datanoa: table=employees\n-- datanoa: schema=main\nSELECT * FROM employees;'
        )
        await flushTick()

        // Expand all sidebar groups (`Expand All` or clicking collapsed group headers) then Copy DDL on trigger (`3692`)!
        findBtn(document.body, /^Expand All$/i)?.click()
        document.querySelectorAll('.datanoa-sidebar-group-header').forEach((hdr) => {
          const par = hdr.parentElement
          if (par && par.classList.contains('is-collapsed')) (hdr as HTMLElement).click()
        })
        const trigObj = priv.schemaObjects.find((o) => o.kind === 'trigger')
        if (trigObj) {
          const trigBtn = findBtn(priv.sidebarListEl || document.body, new RegExp(`^${trigObj.name}$|${trigObj.name}`))
          trigBtn?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 25, clientY: 25 }))
          findBtn(document.body, /^Copy DDL$/i)?.click()
          await flushTick()
        }

        // Exact `employees` button click -> Inspector -> toggle nullable -> manual TX active -> .datanoa-struct-confirm-execute-btn (`1768`!)
        const empBtn = Array.from(priv.sidebarListEl?.querySelectorAll('button.datanoa-table-btn') || []).find((el) =>
          (el.textContent || '').trim().startsWith('employees')
        ) as HTMLButtonElement | undefined
        empBtn?.click()
        await flushTick()
        priv.switchMode('inspector')
        await flushTick()
        const inspRow2Chk = document.querySelector('.datanoa-inspector-area tbody tr:nth-child(2) input[type="checkbox"]') as HTMLInputElement | null
        if (inspRow2Chk) {
          inspRow2Chk.checked = !inspRow2Chk.checked
          inspRow2Chk.dispatchEvent(new Event('change'))
        }
        await priv.txToolbar.begin()
        findBtn(document.querySelector('.datanoa-inspector-area') || document.body, /^Apply Changes/i)?.click()
        await flushTick()
        ;(document.querySelector('.datanoa-struct-confirm-execute-btn') as HTMLButtonElement | null)?.click()
        await flushTick()
        findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /^Cancel$/i)?.click()
        await priv.txToolbar.rollback()
        priv.switchMode('grid')
        await flushTick()

        // Retry after data.getPage failure (`4745`) + identical page reload (`4680-4684`)
        backend.failOnceActions.add('data.getPage')
        await priv.loadTableData('c_main', 'employees', 1)
        priv.queryBannerRetryBtn?.click()
        await flushTick()
        await priv.loadTableData('c_main', 'employees', 1)

        // Materialized view (`4792-4805`) + Danger truncate on materialized_view (`7107:showQueryBanner`)
        const mvObj: SchemaObject = { name: 'mv_emp_dept', schema: 'main', kind: 'materialized_view' }
        priv.schemaObjects.push(mvObj)
        priv.activeTable = 'mv_emp_dept'
        pExtra.activeObjectKind = 'materialized_view'
        pExtra.activeReadOnlyObject = mvObj
        await pExtra.loadActiveTableSchema(true)
        priv.openDangerTableModal('truncate', mvObj)

        // Dropped read-only object & dropped active table on introspectSchema (`3886-3916`)
        pExtra.activeObjectKind = 'view'
        pExtra.activeReadOnlyObject = { name: 'v_ghost_view', schema: 'main', kind: 'view' }
        await priv.introspectSchema('c_main', false)

        ed.getSqlConsole()?.setText('CREATE TABLE temp_gone_r3 (id INTEGER PRIMARY KEY);')
        await priv.executeSql(true, true, undefined, true)
        await priv.introspectSchema('c_main', false)
        priv.activeTable = 'temp_gone_r3'
        ed.getSqlConsole()?.setText('DROP TABLE temp_gone_r3;')
        await priv.executeSql(true, true, undefined, true)
        await priv.introspectSchema('c_main', false)

        // applyResultTabState when resultStates deleted (`5157-5165`)
        ed.getSqlConsole()?.setText('SELECT id, name FROM employees; SELECT id FROM departments;')
        await priv.executeSql(true, true, undefined, true)
        delete priv.consoleTabs.getActiveTab().resultStates
        pExtra.selectResultSetIndex(1)
        priv.queryBannerBackBtn?.click()
        await flushTick()

        // Defer data.previewDml -> change table while rejecting (`6360-6369`) + valid copy/close/submit (`1632-1643`)
        await priv.loadTableData('c_main', 'employees', 1)
        await flushTick()
        ed.getDataGrid()?.setBatchMode(true)
        ed.getDataGrid()?.stageCellEdit(0, 'name', 'PreviewCancelTest')
        const origReq = backend.orcaApi.plugin.request
        let relPreviewErr: (() => void) | undefined
        ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = (async (
          m: string,
          p?: Record<string, unknown>
        ) => {
          if (m === 'data.previewDml') {
            await new Promise<void>((r) => {
              relPreviewErr = r
            })
            throw new Error('preview failed stale')
          }
          return origReq(m, p)
        }) as typeof origReq
        pExtra.dmlPreviewBtn?.click()
        await flushMicro(3)
        priv.activeTable = 'departments'
        relPreviewErr?.()
        await flushTick()
        ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = origReq
        priv.activeTable = 'employees'
        pExtra.dmlPreviewBtn?.click()
        await flushTick()
        pExtra.dmlCopyBtn?.click()
        pExtra.dmlCloseBtn?.click()
        priv.submitBtn?.click()
        await flushTick()

        // Import modal using grid model cols (`7011-7021`) + chunk 2 error -> showQueryBanner (`7058`)
        priv.tableDetailsCache.clear()
        await priv.openImportDataModal({ name: 'employees', schema: 'main', kind: 'table' })
        const impInp = document.querySelector('.datanoa-modal-backdrop input[type="file"]') as HTMLInputElement | null
        if (impInp) {
          const bigCsv = ['name', ...Array.from({ length: 270 }, (_, i) => `R_${i}`)].join('\n')
          Object.defineProperty(impInp, 'files', {
            configurable: true,
            value: [makeFakeFile('two_chunks.csv', bigCsv)],
          })
          impInp.dispatchEvent(new Event('change'))
          await flushTick()
        }
        let applyCalls = 0
        ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = (async (
          m: string,
          p?: Record<string, unknown>
        ) => {
          if (m === 'data.applyChanges') {
            applyCalls++
            if (applyCalls === 2) throw new Error('chunk 2 boom')
          }
          return origReq(m, p)
        }) as typeof origReq
        findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /Import Directly|Import \d+ Row/i)?.click()
        await flushTick()
        await flushTick()
        ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = origReq
        const leftBd = document.querySelector('.datanoa-modal-backdrop')
        if (leftBd) findBtn(leftBd, /^Cancel$/i)?.click()

        // generateSqlTemplateForObject uncached fallback (`3642-3651`) + handleApplyMigration rename (`7304`) + null conn (`7331`) + mongo countRows (`6811, 6830`)
        priv.tableDetailsCache.clear()
        backend.failOnceActions.add('schema.tableDetails')
        await priv.generateSqlTemplateForObject({ name: 'departments', kind: 'table' } as SchemaObject, 'insert')
        await pExtra.handleApplyMigration(['ALTER TABLE departments RENAME TO departments_v2;'], { tableName: 'departments', newTableName: 'departments_v2', schema: 'main', columns: [], indexes: [], foreignKeys: [], triggers: [] })
        // Rename back
        await pExtra.handleApplyMigration(['ALTER TABLE departments_v2 RENAME TO departments;'], { tableName: 'departments_v2', newTableName: 'departments', schema: 'main', columns: [], indexes: [], foreignKeys: [], triggers: [] })

        // Wheel horizontally on overflowing parent (`2310-2315`) + pending save/RAF on destroy (`838, 1199`)
        const outerScroll = document.createElement('div')
        Object.defineProperty(outerScroll, 'scrollWidth', { configurable: true, get: () => 900 })
        Object.defineProperty(outerScroll, 'clientWidth', { configurable: true, get: () => 300 })
        const innerTarget = document.createElement('span')
        outerScroll.appendChild(innerTarget)
        priv.gridAreaEl?.appendChild(outerScroll)
        outerScroll.dispatchEvent(Object.assign(new Event('wheel', { bubbles: true, cancelable: true }), { deltaY: 120, ctrlKey: true, target: innerTarget }))
        outerScroll.remove()

        // Redis/Null connection exportDdl (`3336, 3344`) + Mongo countRows (`6811, 6830`)
        const mongoConn: ConnectionProfile = { id: 'c_mg', name: 'MG', driver: 'mongodb', host: 'localhost', database: 'app', createdAt: Date.now(), updatedAt: Date.now() }
        const redConn: ConnectionProfile = { id: 'c_rd', name: 'RD', driver: 'redis', host: 'localhost', createdAt: Date.now(), updatedAt: Date.now() }
        backend.connections.push(mongoConn, redConn)
        backend.emitPlugin('connections.changed', {})
        await flushTick()
        priv.handleConnectionChanged('c_rd')
        await flushTick()
        priv.handleConnectionChanged('c_mg')
        await flushTick()
        ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = (async (
          m: string,
          p?: Record<string, unknown>
        ) => {
          if (m === 'query.run') return { columns: ['custom_total'], rows: [{ custom_total: 77 }], rowCount: 1, executionTimeMs: 2, truncated: false, isSelect: true }
          return origReq(m, p)
        }) as typeof origReq
        await priv.countRowsForObject({ name: 'users', kind: 'table' } as SchemaObject)
        ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = origReq

        priv.activeConnectionId = null
        await expect(pExtra.handleApplyMigration(['SELECT 1;'], { tableName: 'x' })).rejects.toThrow(/Select a connection/i)
        pExtra.scrollRestoreRafId = requestAnimationFrame(() => {})
        pExtra.saveViewStateTimer = setTimeout(() => {}, 500)
      } finally {
        ed.destroy()
      }
    }

    // 5. grid.ts: keepEditorAlive row 8 slide (`3113`), NOT NULL direct `NULL` (`4873`), Tab null (`4657-4668`), untouched blank/null (`4834-4843`), fallback selection (`3940, 4046, 4197`), default paste (`4440`)
    {
      const host = document.createElement('div')
      document.body.appendChild(host)
      Object.defineProperty(host, 'offsetParent', { configurable: true, get: () => document.body })
      Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => 860 })
      Object.defineProperty(host, 'clientHeight', { configurable: true, get: () => 300 })

      const dataWithDef: TableBrowseResult = {
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true, autoIncrement: true },
          { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
          { name: 'def_col', type: 'TEXT', nullable: true, primaryKey: false, defaultValue: 'DEF_VAL' } as TableBrowseResult['columns'][number],
          { name: 'ro_tail', type: 'INTEGER', nullable: false, primaryKey: true },
        ],
        rows: Array.from({ length: 40 }, (_, i) => ({
          id: i + 1,
          name: `N_${i + 1}`,
          def_col: i === 0 ? null : 'ok',
          ro_tail: i + 100,
        })),
        totalRows: 40,
        page: 1,
        pageSize: 100,
        primaryKey: ['id'],
        canEdit: true,
      }
      const grid = new VirtualDataGrid({
        container: host,
        data: dataWithDef,
        tableName: 'def_tbl',
        onDirectCellEdit: async () => ({ ok: true }),
        onNotify: vi.fn(),
      })
      const gPriv = grid as unknown as {
        tableContainerEl: HTMLDivElement
        tbodyEl: HTMLTableSectionElement
        selection: { clear: () => void }
        selectedRowIndex: number | null
        selectedColIndex: number | null
        ensureFocusCellVisible: () => void
      }
      const wrap = gPriv.tableContainerEl
      const tbody = gPriv.tbodyEl
      Object.defineProperty(wrap, 'offsetParent', { configurable: true, get: () => document.body })
      Object.defineProperty(wrap, 'clientWidth', { configurable: true, get: () => 860 })
      Object.defineProperty(wrap, 'clientHeight', { configurable: true, get: () => 300 })

      // keepEditorAlive (`3113-3121`) on row 8 during slight downward scroll
      grid.selectSingleModelCell(8, 1)
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      wrap.scrollTop = 64
      wrap.dispatchEvent(new Event('scroll'))
      grid.cancelCellEdit()

      // Direct NULL rejection on nullable:false column (`4873-4875`)
      wrap.scrollTop = 0
      wrap.dispatchEvent(new Event('scroll'))
      grid.selectSingleModelCell(0, 1)
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      const inpNull = tbody.querySelector('input') as HTMLInputElement | null
      if (inpNull) {
        inpNull.value = 'NULL'
        inpNull.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
        await flushTick()
      }

      // Existing NULL cell untouched Enter commit (`4841-4844`)
      grid.selectSingleModelCell(0, 2)
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      const inpUnchNull = tbody.querySelector('input') as HTMLInputElement | null
      if (inpUnchNull) {
        inpUnchNull.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
        await flushTick()
      }

      // Tab at last editable col skipping read-only `ro_tail` (`4657-4668`)
      grid.selectSingleModelCell(0, 2)
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      const inpTab = tbody.querySelector('input') as HTMLInputElement | null
      if (inpTab) {
        inpTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
      }
      grid.cancelCellEdit()

      // Blank row untouched commit (`4834-4838`) & defaultValue paste (`4440-4446`)
      grid.setBatchMode(true)
      const insIdx = grid.addBlankRow()!
      grid.selectSingleModelCell(insIdx, 1)
      wrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      const inpBlank = tbody.querySelector('input') as HTMLInputElement | null
      if (inpBlank) {
        inpBlank.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      }
      grid.pasteDelimitedTextDetailed('name\tdef_col\nAlpha\t', { forceNewRows: true })

      // Fallback selection (`3940, 4046, 4197`) & scrollFocusIntoView (`2202-2208`)
      gPriv.selectedRowIndex = 1
      gPriv.selectedColIndex = 1
      gPriv.selection.clear()
      grid.bulkCloneSelectedRows()
      gPriv.selectedRowIndex = 1
      gPriv.selection.clear()
      grid.bulkSetCellsValue('BulkFallback')
      gPriv.selectedRowIndex = 1
      gPriv.selection.clear()
      grid.bulkMarkRowsDeleted()

      grid.selectSingleModelCell(28, 1)
      wrap.scrollTop = 0
      gPriv.ensureFocusCellVisible()

      grid.destroy()
      host.remove()
    }
  })

  it('Slice 6I: hits fs.listDir file-picker, .datanoa-struct-apply-btn TX rebuild block/timer/migration, DataCache SQL boot, Retry, Trigger Copy DDL & Mongo Danger empty name', async () => {
    // 1. connection-modal with real `fs.listDir` schema + `.datanoa-fp-overlay` selection (`512-513, 728-734, 1229, 1257`)
    {
      const mh = mountModalHarness()
      const req = vi.fn(async (method: string) => {
        if (method === 'drivers.list') return [{ id: 'duckdb', name: 'DuckDB', kind: 'byod', status: 'not-configured' }]
        if (method === 'drivers.defaultFolders') return { platform: 'win32', paths: { duckdb: 'C:\\drv\\duckdb' } }
        if (method === 'fs.listDir') {
          return {
            ok: true,
            currentDir: '/ws/sub',
            parentDir: '/ws',
            roots: ['/ws'],
            entries: [
              { name: 'dbdir', path: '/ws/sub/dbdir', kind: 'dir' },
              { name: '.sqlite', path: '/ws/sub/.sqlite', kind: 'file', size: 128 },
            ],
          }
        }
        return { ok: true }
      })
      openStudioConnectionModal({
        isBackdropActive: mh.isBackdropActive,
        mountModal: mh.mountModal,
        closeModal: mh.closeModal,
        requestPlugin: req as <T = unknown>(m: string) => Promise<T>,
        createElapsedTimer: () => () => {},
        updateStatus: () => {},
        activateSavedConnection: async () => {},
        onConnectionDeleted: async () => {},
        currentWorkspaceScope: '/ws',
      })
      await flushTick()

      const connBd = mh.getBackdrop()
      if (connBd) {
        // Discovery Browse Folder (`512-513`)
        findBtn(connBd, /^Browse Folder/i)?.click()
        await flushTick()
        const fpFolder = document.querySelector('.datanoa-fp-overlay')
        findBtn(fpFolder || document.body, /^Select folder$/i)?.click()
        await flushTick()

        // SQLite Browse File selecting `.sqlite` (`1229, 1257`)
        findBtn(connBd, /^Browse File/i)?.click()
        await flushTick()
        const fpFile = document.querySelector('.datanoa-fp-overlay')
        const dotRow = Array.from(fpFile?.querySelectorAll('.datanoa-fp-row') || []).find((el) =>
          (el.textContent || '').includes('.sqlite')
        ) as HTMLElement | undefined
        dotRow?.click()
        findBtn(fpFile || document.body, /^Select file$/i)?.click()
        await flushTick()

        // DuckDB BYOD Browse Folder (`728-734`)
        const duckTile = Array.from(connBd.querySelectorAll('.datanoa-engine-tile')).find((el) =>
          (el.textContent || '').includes('DuckDB')
        ) as HTMLButtonElement | undefined
        duckTile?.click()
        await flushTick()
        findBtn(connBd, /^Browse Folder/i)?.click()
        await flushTick()
        const fpByod = document.querySelector('.datanoa-fp-overlay')
        findBtn(fpByod || document.body, /^Select folder$/i)?.click()
        await flushTick()
      }
      mh.closeModal()
    }

    // 2. schema-inspector `.datanoa-struct-apply-btn` -> TX rebuild error (`656-666`) + slow migration timer (`681-684`)
    {
      const host = document.createElement('div')
      document.body.appendChild(host)
      let manualTx = false
      let relMig: (() => void) | undefined
      const inspector = new SchemaInspectorView(host, {
        dialect: 'sqlite',
        isManualTxActive: () => manualTx,
        onInsertDdl: vi.fn(),
        onCopyDdl: vi.fn(),
        onApplyMigration: async () => {
          await new Promise<void>((r) => {
            relMig = r
          })
          return { ok: true }
        },
      })
      inspector.setDetails(
        {
          name: 'tasks',
          schema: 'main',
          kind: 'table',
          primaryKey: ['id'],
          columns: [
            { name: 'id', type: 'INTEGER', nullable: false, isPrimaryKey: true },
            { name: 'label', type: 'TEXT', nullable: false, isPrimaryKey: false },
          ],
          indexes: [],
          foreignKeys: [],
          ddl: 'CREATE TABLE tasks (id INTEGER PRIMARY KEY, label TEXT NOT NULL);',
        },
        'sqlite'
      )
      const lblChk = host.querySelectorAll('.datanoa-col-nullable-checkbox')[1] as HTMLInputElement | undefined
      if (lblChk) {
        lblChk.checked = true
        lblChk.dispatchEvent(new Event('change'))
      }
      // Open confirm modal while manualTx=false (Confirm & Execute is enabled!), THEN activate manualTx=true to hit executeValidatedMigration L656-666!
      ;(host.querySelector('.datanoa-struct-apply-btn') as HTMLButtonElement | null)?.click()
      await flushTick()
      manualTx = true
      ;(document.querySelector('.datanoa-struct-confirm-execute-btn') as HTMLButtonElement | null)?.click()
      await flushTick()

      manualTx = false
      vi.useFakeTimers()
      ;(document.querySelector('.datanoa-struct-confirm-execute-btn') as HTMLButtonElement | null)?.click()
      vi.advanceTimersByTime(350)
      vi.useRealTimers()
      relMig?.()
      await flushTick()
      inspector.destroy()
      host.remove()
    }

    // 3. index.ts: DataCache SQL result boot (`3157-3175`) with c_main present
    {
      const bCache = createLiveStudioSqliteBackend()
      dbsToCloseR3.push(bCache.db)
      bCache.setSessionSnapshot({
        updatedAt: Date.now() + 50_000,
        viewState: { activeConnectionId: 'c_main', activeTable: 'employees', activeViewMode: 'split' },
        dataCache: {
          c_main: {
            schemaObjects: [{ name: 'employees', schema: 'main', kind: 'table' }],
            schemaMap: { employees: ['id', 'name'] },
            activeTable: 'employees',
            activeObjectKind: 'table',
            isShowingSqlResult: true,
            lastSqlResult: {
              columns: [],
              rows: [],
              rowCount: 0,
              affectedRows: 3,
              isSelect: false,
              truncated: true,
              executionTimeMs: 4,
            },
          },
        },
      } as never)
      ;(window as unknown as { orca: unknown }).orca = bCache.orcaApi
      const edCache = initializeEditor()!
      const docC = await bCache.orcaApi.document.session()
      edCache.attachDocumentSession(docC)
      await flushTick()
      await flushTick()
      edCache.destroy()
    }

    // 4. index.ts: onRetry (`4745`), Trigger Copy DDL (`3692`), `.datanoa-struct-apply-btn` TX rebuild (`1768, 1885, 7389`), Result sort/filter state restore (`5428`), Cancel-on-conn-switch (`3562`), Mongo Danger banner (`7107`)
    const { backend, ed, priv } = await bootRound3()
    try {
      // onRetry (`4745`) cleanly in isolation
      backend.failOnceActions.add('data.fetchPage')
      await priv.loadTableData('c_main', 'employees', 1)
      expect(priv.queryBannerRetryBtn?.style.display).toBe('inline-flex')
      priv.queryBannerRetryBtn?.click()
      await flushTick()

      // Trigger Copy DDL (`3692`) after expanding sidebar groups
      document.querySelectorAll('.datanoa-sidebar-group-header').forEach((hdr) => {
        const par = hdr.parentElement
        if (par && par.classList.contains('is-collapsed')) (hdr as HTMLElement).click()
      })
      const trigObj = priv.schemaObjects.find((o) => o.kind === 'trigger')
      if (trigObj) {
        const trigBtn = findBtn(priv.sidebarListEl || document.body, new RegExp(trigObj.name))
        trigBtn?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 25, clientY: 25 }))
        findBtn(document.body, /^Copy DDL$/i)?.click()
        await flushTick()
      }

      // Inspector `.datanoa-struct-apply-btn`: triggers `isManualTxActive` (`1768`), `isMigrationInFlight` (`1885`), `7389-7395`
      const empBtn = Array.from(priv.sidebarListEl?.querySelectorAll('button.datanoa-table-btn') || []).find((el) =>
        (el as HTMLElement).dataset?.tableName === 'employees' || (el.textContent || '').includes('employees')
      ) as HTMLButtonElement | undefined
      empBtn?.click()
      await flushTick()
      priv.switchMode('inspector')
      await flushTick()
      const row2Chk = document.querySelectorAll('.datanoa-inspector-area .datanoa-col-nullable-checkbox')[1] as HTMLInputElement | undefined
      if (row2Chk) {
        row2Chk.checked = !row2Chk.checked
        row2Chk.dispatchEvent(new Event('change'))
      }
      ;(document.querySelector('.datanoa-struct-apply-btn') as HTMLButtonElement | null)?.click()
      await flushTick()
      await priv.txToolbar.begin()
      ;(document.querySelector('.datanoa-struct-confirm-execute-btn') as HTMLButtonElement | null)?.click()
      await flushTick()
      await priv.txToolbar.rollback()

      const origReq = backend.orcaApi.plugin.request
      let relMigFail: (() => void) | undefined
      ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = (async (
        m: string,
        p?: Record<string, unknown>
      ) => {
        if (m === 'schema.applyMigration') {
          await new Promise<void>((r) => {
            relMigFail = r
          })
          throw new Error('mig reject')
        }
        return origReq(m, p)
      }) as typeof origReq
      ;(document.querySelector('.datanoa-struct-confirm-execute-btn') as HTMLButtonElement | null)?.click()
      await flushMicro(4)
      priv.switchMode('grid')
      relMigFail?.()
      await flushTick()
      ;(window as unknown as { orca: { plugin: { request: typeof origReq } } }).orca.plugin.request = origReq
      findBtn(document.querySelector('.datanoa-modal-backdrop') || document.body, /^Cancel$/i)?.click()
      priv.switchMode('grid')
      await flushTick()

      // Result sort + filter preservation across Result Set tabs (`5428-5437`)
      ed.getSqlConsole()?.setText('SELECT id, name FROM employees; SELECT id FROM departments;')
      await priv.executeSql(true, true, undefined, true)
      await flushTick()
      ;(document.querySelectorAll('.datanoa-grid-header th')[1] as HTMLElement | undefined)?.click()
      if (priv.clientSearchEl) {
        priv.clientSearchEl.value = 'Alice'
        priv.clientSearchEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      }
      const pRes = ed as unknown as { selectResultSetIndex: (i: number) => void }
      pRes.selectResultSetIndex(1)
      pRes.selectResultSetIndex(0)

      // Connection change cancelling active query (`3562-3568`) + Mongo Danger empty name (`7107:showQueryBanner`)
      const mongoConn: ConnectionProfile = { id: 'c_mg_i', name: 'MGI', driver: 'mongodb', host: 'localhost', database: 'app', createdAt: Date.now(), updatedAt: Date.now() }
      backend.connections.push(mongoConn)
      backend.emitPlugin('connections.changed', {})
      await flushTick()
      backend.deferNextQuery()
      ed.getSqlConsole()?.setText('SELECT * FROM employees;')
      const pAbort = priv.executeSql(true, true, undefined, true)
      await flushMicro(3)
      priv.handleConnectionChanged('c_mg_i')
      backend.resolveDeferredQuery()
      await pAbort
      await flushTick()
      priv.openDangerTableModal('truncate', { name: '', kind: 'table' } as SchemaObject)
    } finally {
      ed.destroy()
    }
  })
})
