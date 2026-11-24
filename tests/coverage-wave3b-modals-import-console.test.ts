import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installDomHarness, type DomHarness } from './helpers/dom-harness.js'
import type { ColumnInfo, ConnectionProfile, SchemaObject } from '../src/protocol.js'
import { DEFAULT_IMPORT_CHUNK_SIZE } from '../src/shared-constants.js'
import {
  openStudioCreateTableModal,
  buildDangerTableCommand,
  openStudioDangerTableModal,
  openStudioCommandPalette,
  openStudioShortcutsModal,
} from '../src/editor/studio-modals.js'
import {
  buildImportCommandPreview,
  openStudioImportModal,
} from '../src/editor/import-modal.js'
import {
  SqlConsoleController,
  extractExecutableSql,
  extractCaretStatementSql,
  resolveSqlDialect,
  buildLanguageExtension,
  computeSmartSqlCompletions,
} from '../src/editor/console.js'

let dom: DomHarness

beforeEach(() => {
  dom = installDomHarness()
})

afterEach(() => {
  vi.useRealTimers()
  dom.teardown()
})

describe('Wave 3B Step 3: studio-modals.ts, import-modal.ts & console.ts', () => {
  it('covers src/editor/studio-modals.ts create-table, danger-table, command-palette & shortcuts', async () => {
    let mountedEl: HTMLElement | null = null
    let canCloseFn: (() => boolean) | undefined
    const closeModal = vi.fn(() => {
      mountedEl?.remove()
    })
    const updateStatus = vi.fn()
    const showQueryBanner = vi.fn()
    const onTableCreated = vi.fn(async () => {})
    const onDangerActionSucceeded = vi.fn(async () => {})
    let tickCb: ((txt: string, ms: number) => void) | null = null
    const createElapsedTimer = vi.fn((cb: (txt: string, ms: number) => void) => {
      tickCb = cb
      return () => {}
    })

    // Blocked connection guards for Create Table
    openStudioCreateTableModal({
      activeConnection: undefined,
      activeConnectionId: null,
      mountModal: () => null,
      closeModal,
      updateStatus,
      requestPlugin: vi.fn() as never,
      createElapsedTimer,
      onTableCreated,
    })
    openStudioCreateTableModal({
      activeConnection: { id: 'r1', name: 'R', driver: 'redis' } as ConnectionProfile,
      activeConnectionId: 'r1',
      mountModal: () => null,
      closeModal,
      updateStatus,
      requestPlugin: vi.fn() as never,
      createElapsedTimer,
      onTableCreated,
    })
    expect(updateStatus).toHaveBeenCalledWith('Cannot create tables on this connection')

    // Oracle & MSSQL column defaults + SQLite schema hide
    for (const driver of ['oracle', 'mssql', 'sqlite'] as const) {
      openStudioCreateTableModal({
        activeConnection: { id: 'c', name: 'D', driver } as ConnectionProfile,
        activeConnectionId: 'c',
        activeSchema: 'dbo',
        mountModal: (el, canClose) => {
          mountedEl = el
          canCloseFn = canClose
          dom.body.appendChild(el)
        },
        closeModal,
        updateStatus,
        requestPlugin: vi.fn(async () => ({})) as never,
        createElapsedTimer,
        onTableCreated,
      })
      expect(canCloseFn?.()).toBe(true)
      dom.click(mountedEl!.querySelector('.datanoa-modal-actions button')!)
    }

    // Postgres interactive table builder: add/edit/toggle PK/AI/Null/Default/Remove, RPC fail, retry + onTableCreated fail
    let queryMode: 'fail-err' | 'fail-str' | 'ok' = 'fail-err'
    const pgReq = vi.fn(async () => {
      if (queryMode === 'fail-err') {
        tickCb?.('0.2s', 200)
        throw new Error('syntax err')
      }
      if (queryMode === 'fail-str') throw 'str-fail'
      return { columns: [], rows: [], executionTimeMs: 1, truncated: false, isSelect: false }
    })
    openStudioCreateTableModal({
      activeConnection: { id: 'pg1', name: 'PG', driver: 'postgres' } as ConnectionProfile,
      activeConnectionId: 'pg1',
      activeSchema: 'public',
      mountModal: (el, canClose) => {
        mountedEl = el
        canCloseFn = canClose
        dom.body.appendChild(el)
      },
      closeModal,
      updateStatus,
      requestPlugin: pgReq as never,
      createElapsedTimer,
      onTableCreated,
    })
    dom.click(mountedEl!.querySelector('.datanoa-modal-body button')!) // + Add Column (3 cols)
    const inputs = mountedEl!.querySelectorAll('tbody input[type="text"]')
    const cbs = mountedEl!.querySelectorAll('tbody input[type="checkbox"]')
    dom.setInput(inputs[0], 'user_id', 'input')
    dom.setInput(inputs[1], 'BIGINT', 'input')
    dom.setInput(inputs[2], '0', 'input')
    dom.click(cbs[0]) // toggle PK off
    dom.click(cbs[1]) // toggle AI off
    dom.click(cbs[2]) // toggle nullable
    dom.click(mountedEl!.querySelectorAll('tbody button')[2]) // remove 3rd column
    dom.click(mountedEl!.querySelector('.datanoa-btn-primary')!) // RPC error
    await dom.flushMicrotasks()
    expect(mountedEl!.textContent).toContain('Create Table failed: syntax err')

    queryMode = 'ok'
    onTableCreated.mockRejectedValueOnce(new Error('refresh warn'))
    dom.click(mountedEl!.querySelector('.datanoa-btn-primary')!)
    await dom.flushMicrotasks()
    expect(updateStatus).toHaveBeenCalledWith('Table created, but refresh failed: refresh warn')

    // MongoDB Create Collection (empty error preview + create)
    openStudioCreateTableModal({
      activeConnection: { id: 'mg1', name: 'M', driver: 'mongodb' } as ConnectionProfile,
      activeConnectionId: 'mg1',
      mountModal: (el) => {
        mountedEl = el
        dom.body.appendChild(el)
      },
      closeModal,
      updateStatus,
      requestPlugin: pgReq as never,
      createElapsedTimer,
      onTableCreated,
    })
    const tblInp = mountedEl!.querySelector('#datanoa-create-table-name-input')!
    dom.setInput(tblInp, '  ', 'input')
    expect(mountedEl!.textContent).toContain('-- Collection name is required.')
    dom.setInput(tblInp, 'events', 'input')
    dom.click(mountedEl!.querySelector('.datanoa-btn-primary')!)
    await dom.flushMicrotasks()

    // Danger table command & modal
    expect(() => buildDangerTableCommand('drop', { name: '  ', kind: 'table' }, 'mongodb')).toThrow()
    expect(buildDangerTableCommand('truncate', { name: 'logs', kind: 'table' }, 'mongodb')).toContain('deleteMany({})')
    expect(buildDangerTableCommand('drop', { name: 'logs', kind: 'table' }, 'mongodb')).toContain('.drop()')

    openStudioDangerTableModal(
      {
        activeConnection: { id: 'ro', name: 'RO', driver: 'postgres', readOnly: true } as ConnectionProfile,
        activeConnectionId: 'ro',
        mountModal: () => null,
        closeModal,
        updateStatus,
        requestPlugin: pgReq as never,
        createElapsedTimer,
        showQueryBanner,
        onDangerActionSucceeded,
      },
      'drop',
      { name: 't', kind: 'table' }
    )
    expect(updateStatus).toHaveBeenCalledWith('Cannot run destructive table operation on a Read-Only or Redis connection')

    openStudioDangerTableModal(
      {
        activeConnection: { id: 'mg1', name: 'M', driver: 'mongodb' } as ConnectionProfile,
        activeConnectionId: 'mg1',
        mountModal: () => null,
        closeModal,
        updateStatus,
        requestPlugin: pgReq as never,
        createElapsedTimer,
        showQueryBanner,
        onDangerActionSucceeded,
      },
      'truncate',
      { name: '', kind: 'table' }
    )
    expect(showQueryBanner).toHaveBeenCalledWith('error', 'Operation Unavailable', expect.any(String))

    // Prod warning + truncate + fail + succeed with refresh warn
    queryMode = 'fail-err'
    openStudioDangerTableModal(
      {
        activeConnection: { id: 'pg1', name: 'PG', driver: 'postgres', colorTag: 'prod' } as ConnectionProfile,
        activeConnectionId: 'pg1',
        mountModal: (el) => {
          mountedEl = el
          dom.body.appendChild(el)
        },
        closeModal,
        updateStatus,
        requestPlugin: pgReq as never,
        createElapsedTimer,
        showQueryBanner,
        onDangerActionSucceeded,
      },
      'truncate',
      { name: 'orders', schema: 'public', kind: 'table' }
    )
    expect(mountedEl!.textContent).toContain('PRODUCTION CONNECTION WARNING')
    const confInp = mountedEl!.querySelector('#datanoa-danger-table-confirm-input')!
    const confBtn = mountedEl!.querySelector('.datanoa-btn-danger-solid') as HTMLButtonElement
    expect(confBtn.disabled).toBe(true)
    dom.setInput(confInp, 'orders', 'input')
    expect(confBtn.disabled).toBe(false)
    dom.click(confBtn)
    await dom.flushMicrotasks()
    expect(mountedEl!.textContent).toContain('Execution failed: syntax err')

    queryMode = 'ok'
    onDangerActionSucceeded.mockRejectedValueOnce(new Error('reload err'))
    dom.click(confBtn)
    await dom.flushMicrotasks()
    expect(updateStatus).toHaveBeenCalledWith(expect.stringContaining('succeeded, but refresh failed: reload err'))

    // Mongo drop + SQL view drop + Cancel button
    openStudioDangerTableModal(
      {
        activeConnection: { id: 'pg1', name: 'PG', driver: 'postgres' } as ConnectionProfile,
        activeConnectionId: 'pg1',
        mountModal: (el) => {
          mountedEl = el
          dom.body.appendChild(el)
        },
        closeModal,
        updateStatus,
        requestPlugin: pgReq as never,
        createElapsedTimer,
        showQueryBanner,
        onDangerActionSucceeded,
      },
      'drop',
      { name: 'v_orders', schema: 'public', kind: 'view' }
    )
    expect(mountedEl!.textContent).toContain('Drop View "v_orders"')
    dom.click(mountedEl!.querySelector('.datanoa-modal-actions button')!)

    // Command Palette: test keyboard nav, no-match, and click EVERY entry so all 20 run() closures execute
    const schemaObjects: SchemaObject[] = [
      { name: 'users', schema: 'public', kind: 'table' },
      { name: 'local_items', kind: 'table' },
    ]
    const connections: ConnectionProfile[] = [
      { id: 'c1', name: 'Prod', driver: 'postgres', folder: 'Core', workspaceScope: '/ws' } as ConnectionProfile,
      { id: 'c2', name: 'Local', driver: 'sqlite' } as ConnectionProfile,
    ]
    const cmdSpy = vi.fn()
    const openPalette = () => {
      openStudioCommandPalette({
        schemaObjects,
        connections,
        activeConnection: connections[0],
        sidebarCollapsed: false,
        selectSidebarObject: cmdSpy,
        selectConnection: cmdSpy,
        openConnectionModal: cmdSpy,
        formatSqlInConsole: cmdSpy,
        openCreateTableModal: cmdSpy,
        openImportDataModal: cmdSpy,
        openExportSchemaDdl: cmdSpy,
        openDriverManagerModal: cmdSpy,
        setSidebarCollapsed: cmdSpy,
        switchMode: cmdSpy,
        toggleQueryHistory: async () => cmdSpy('history'),
        handleRefreshAction: async () => cmdSpy('refresh'),
        openShortcutsModal: cmdSpy,
        openFeedbackModal: cmdSpy,
        openSavedQueriesModal: cmdSpy,
        mountModal: (el) => {
          mountedEl = el
          dom.body.appendChild(el)
        },
        closeModal,
      })
    }
    openPalette()
    const palSearch = mountedEl!.querySelector('#datanoa-cmd-palette-search')!
    dom.setInput(palSearch, 'zzz-nomatch', 'input')
    expect(mountedEl!.textContent).toContain('No matching tables, connections, or commands.')
    dom.setInput(palSearch, '', 'input')
    dom.fireKey(palSearch, 'ArrowUp')
    dom.fireKey(palSearch, 'ArrowDown')
    dom.fireKey(palSearch, 'Enter')
    expect(cmdSpy).toHaveBeenCalled()

    // Click every item in palette
    openPalette()
    const totalItems = mountedEl!.querySelectorAll('.datanoa-cmd-palette-item').length
    for (let i = 0; i < totalItems; i++) {
      openPalette()
      const btn = mountedEl!.querySelectorAll('.datanoa-cmd-palette-item')[i]
      dom.click(btn)
    }
    expect(dom.document.documentElement.classList.contains('light') || dom.document.documentElement.classList.contains('dark')).toBe(true)

    // Shortcuts modal
    openStudioShortcutsModal({
      mountModal: (el) => {
        mountedEl = el
        dom.body.appendChild(el)
      },
      closeModal,
    })
    expect(mountedEl!.textContent).toContain('Keyboard Shortcuts')
    dom.click(mountedEl!.querySelector('.datanoa-modal-head button')!)
  })

  it('covers src/editor/import-modal.ts file reading, options, mapping, preview, stage & chunked direct commit', async () => {
    expect(
      buildImportCommandPreview([{ a: 1 }], { driver: 'mongodb', table: 'events' })
    ).toContain('db.getCollection("events").insertOne')
    expect(
      buildImportCommandPreview([{ a: 1 }], { driver: 'postgres', table: 'events', schema: 'public' })
    ).toContain('INSERT INTO')

    let mountedEl: HTMLElement | null = null
    let canCloseFn: (() => boolean) | undefined
    const closeModal = vi.fn(() => {
      mountedEl?.remove()
    })
    const updateStatus = vi.fn()
    const showQueryBanner = vi.fn()
    const onDirectImportComplete = vi.fn(async () => {})
    const createElapsedTimer = vi.fn((cb: (t: string, ms: number) => void) => {
      cb('0.1s', 100)
      return () => {}
    })
    let stageReturn = 2
    const onStageRows = vi.fn(() => stageReturn)
    let rpcBatchMode: 'ok' | 'fail-on-2' | 'not-ok' = 'ok'
    let rpcCalls = 0
    const requestPlugin = vi.fn(async (_method: string, payload: Record<string, unknown> = {}) => {
      rpcCalls++
      const inserts = payload.inserts as unknown[]
      if (rpcBatchMode === 'not-ok') return { ok: false, inserted: 0, updated: 0, deleted: 0, statements: [] }
      if (rpcBatchMode === 'fail-on-2' && rpcCalls === 2) throw new Error('chunk 2 fail')
      return { ok: true, inserted: inserts.length, updated: 0, deleted: 0, statements: [] }
    })

    const pgConn = { id: 'pg1', name: 'PG', driver: 'postgres' } as ConnectionProfile
    const targetColumns: ColumnInfo[] = [
      { name: 'id', type: 'INTEGER', nativeType: 'int4', nullable: false, defaultValue: '0', isPrimaryKey: true, isAutoIncrement: true },
      { name: 'name', type: 'TEXT', nullable: true, defaultValue: null, isPrimaryKey: false },
    ]

    // Entry guards: RO/redis conn & missing columns
    openStudioImportModal({
      activeConnection: { id: 'r', name: 'R', driver: 'redis' } as ConnectionProfile,
      activeConnectionId: 'r',
      targetTable: 't',
      targetColumns,
      canStageInGrid: true,
      mountModal: () => null,
      closeModal,
      updateStatus,
      requestPlugin: requestPlugin as never,
      createElapsedTimer,
      showQueryBanner,
      onStageRows,
      onDirectImportComplete,
    })
    openStudioImportModal({
      activeConnection: pgConn,
      activeConnectionId: 'pg1',
      targetTable: 't',
      targetColumns: [],
      canStageInGrid: true,
      mountModal: () => null,
      closeModal,
      updateStatus,
      requestPlugin: requestPlugin as never,
      createElapsedTimer,
      showQueryBanner,
      onStageRows,
      onDirectImportComplete,
    })
    expect(updateStatus).toHaveBeenCalledWith('Select a table with columns before importing data')

    const openFor = (driver: 'postgres' | 'mongodb', cols: ColumnInfo[], canStage = true) => {
      openStudioImportModal({
        activeConnection: { id: 'c1', name: 'DB', driver } as ConnectionProfile,
        activeConnectionId: 'c1',
        targetTable: 'items',
        targetSchema: driver === 'postgres' ? 'public' : undefined,
        targetColumns: cols,
        canStageInGrid: canStage,
        mountModal: (el, canClose) => {
          mountedEl = el
          canCloseFn = canClose
          dom.body.appendChild(el)
        },
        closeModal,
        updateStatus,
        requestPlugin: requestPlugin as never,
        createElapsedTimer,
        showQueryBanner,
        onStageRows,
        onDirectImportComplete,
      })
    }

    openFor('postgres', targetColumns, true)
    expect(canCloseFn?.()).toBe(true)

    const dropzone = mountedEl!.querySelector('.datanoa-import-dropzone')!
    const fileInput = mountedEl!.querySelector('#datanoa-import-file-input') as unknown as {
      files: unknown[]
      value: string
      dispatchEvent: (e: Event) => boolean
    }
    const browseBtn = mountedEl!.querySelector('.datanoa-import-browse-btn')!
    dom.click(browseBtn)
    dropzone.dispatchEvent(new DragEvent('dragover', { bubbles: true }))
    dropzone.dispatchEvent(new DragEvent('dragleave', { bubbles: true }))

    // 1. Oversized file (> 25 MB)
    fileInput.files = [{ name: 'huge.csv', size: 26 * 1024 * 1024 }]
    fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    await dom.flushMicrotasks()
    expect(mountedEl!.textContent).toContain('exceeds the 25 MB browser import limit')

    // 2. Drop file using FileReader fallback (ArrayBuffer + string + error) & unavailable FileReader
    const origFR = (globalThis as Record<string, unknown>).FileReader
    class FakeFileReader {
      result: unknown = null
      error: unknown = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsArrayBuffer(f: { _mode?: string; _bytes?: Uint8Array; _text?: string }) {
        if (f._mode === 'err') {
          this.error = new Error('disk io err')
          this.onerror?.()
          return
        }
        this.result = f._mode === 'str' ? f._text : f._bytes?.buffer
        this.onload?.()
      }
    }
    ;(globalThis as Record<string, unknown>).FileReader = FakeFileReader
    try {
      const badEv = new DragEvent('drop', { bubbles: true })
      ;(badEv.dataTransfer as unknown as { files: unknown[] }).files = [{ name: 'err.csv', size: 10, _mode: 'err' }]
      dropzone.dispatchEvent(badEv)
      await dom.flushMicrotasks()
      expect(mountedEl!.textContent).toContain('Failed to read "err.csv": disk io err')

      const strEv = new DragEvent('drop', { bubbles: true })
      ;(strEv.dataTransfer as unknown as { files: unknown[] }).files = [
        { name: 'ok.csv', size: 2048, _mode: 'str', _text: 'id,name\n1,alice\n2,bob\n\n' },
      ]
      dropzone.dispatchEvent(strEv)
      await dom.flushMicrotasks()
      expect(mountedEl!.textContent).toContain('2 row(s) ready')
    } finally {
      ;(globalThis as Record<string, unknown>).FileReader = origFR
    }

    // 3. Test File.arrayBuffer() + parse error + options + mapping + stage failure & success
    const csvBytes = new TextEncoder().encode(`id,name\n1,"${'z'.repeat(70)}"\n2,\n`)
    fileInput.files = [{ name: 'data.csv', size: csvBytes.byteLength, arrayBuffer: async () => csvBytes.buffer }]
    fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    await dom.flushMicrotasks()

    const fmtSel = mountedEl!.querySelector('.datanoa-import-format-select') as HTMLSelectElement
    const delimSel = mountedEl!.querySelector('.datanoa-import-delimiter-select') as HTMLSelectElement
    const encSel = mountedEl!.querySelector('.datanoa-import-encoding-select') as HTMLSelectElement
    const nullSel = mountedEl!.querySelector('.datanoa-import-null-select') as HTMLSelectElement
    for (const [sel, v] of [
      [fmtSel, 'csv'],
      [delimSel, ','],
      [encSel, 'utf-8'],
      [nullSel, 'empty-only'],
    ] as const) {
      sel.value = v
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    }
    dom.click(mountedEl!.querySelector('.datanoa-import-header-cb')!) // false
    dom.click(mountedEl!.querySelector('.datanoa-import-header-cb')!) // true
    dom.click(mountedEl!.querySelector('.datanoa-import-trim-cb')!)
    dom.click(mountedEl!.querySelector('.datanoa-import-skip-empty-cb')!)

    // Skip All -> Auto-Map -> duplicate mapping error -> fix
    const [autoMapBtn, skipAllBtn] = mountedEl!.querySelectorAll('.datanoa-import-section-bar button')
    dom.click(skipAllBtn)
    expect(mountedEl!.textContent).toContain('0 /')
    dom.click(autoMapBtn)
    const mapSel0 = mountedEl!.querySelector('#datanoa-import-target-col-0') as HTMLSelectElement
    mapSel0.value = ''
    mapSel0.dispatchEvent(new Event('change', { bubbles: true }))
    dom.click(autoMapBtn)

    // Switch stage/direct radios & test stage returning 0 vs >0
    dom.click(mountedEl!.querySelector('.datanoa-import-mode-direct')!)
    dom.click(mountedEl!.querySelector('.datanoa-import-mode-stage')!)
    stageReturn = 0
    dom.click(mountedEl!.querySelector('.datanoa-import-submit-btn')!)
    expect(mountedEl!.textContent).toContain('Could not stage rows in grid')
    stageReturn = 2
    dom.click(mountedEl!.querySelector('.datanoa-import-submit-btn')!)
    expect(closeModal).toHaveBeenCalled()

    // 4. MongoDB + inferred columns + >DEFAULT_IMPORT_CHUNK_SIZE rows for chunked batch failure & resume
    openFor('mongodb', [], true)
    const countBig = DEFAULT_IMPORT_CHUNK_SIZE + 5
    const bigJson = JSON.stringify(
      Array.from({ length: countBig }, (_, i) => ({
        _num: i,
        nested: i === 0 ? { x: 1 } : null,
      }))
    )
    const bigBytes = new TextEncoder().encode(bigJson)
    const bigInp = mountedEl!.querySelector('#datanoa-import-file-input') as unknown as {
      files: unknown[]
      dispatchEvent: (e: Event) => boolean
    }
    bigInp.files = [{ name: 'rows.json', size: bigBytes.byteLength, arrayBuffer: async () => bigBytes.buffer }]
    bigInp.dispatchEvent(new Event('change', { bubbles: true }))
    await dom.flushMicrotasks()

    rpcCalls = 0
    rpcBatchMode = 'fail-on-2'
    dom.click(mountedEl!.querySelector('.datanoa-import-submit-btn')!) // batch 1 succeeds, batch 2 fails -> Resume
    await dom.flushMicrotasks()
    expect(mountedEl!.textContent).toContain('Resume Import (5 remaining)')
    expect(onDirectImportComplete).toHaveBeenCalledWith('c1', 'items', undefined, DEFAULT_IMPORT_CHUNK_SIZE, { partial: true })

    rpcCalls = 0
    rpcBatchMode = 'ok'
    dom.click(mountedEl!.querySelector('.datanoa-import-submit-btn')!) // resumes & completes!
    await dom.flushMicrotasks()
    expect(closeModal).toHaveBeenCalled()

    // 5. Cancel on idle modal & rejected-batch check
    openFor('postgres', targetColumns, false)
    const smallCsv = new TextEncoder().encode('id,name\n5,bob\n')
    ;(mountedEl!.querySelector('#datanoa-import-file-input') as unknown as { files: unknown[]; dispatchEvent: (e: Event) => boolean }).files = [
      { name: 'small.csv', size: smallCsv.byteLength, arrayBuffer: async () => smallCsv.buffer },
    ]
    mountedEl!.querySelector('#datanoa-import-file-input')!.dispatchEvent(new Event('change', { bubbles: true }))
    await dom.flushMicrotasks()
    rpcBatchMode = 'not-ok'
    dom.click(mountedEl!.querySelector('.datanoa-import-submit-btn')!)
    await dom.flushMicrotasks()
    expect(mountedEl!.textContent).toContain('The database rejected this import batch')
    dom.click(mountedEl!.querySelector('.datanoa-import-actions button')!) // Cancel
  })

  it('covers src/editor/console.ts dialects, tokenizers, completions & CodeMirror controller', () => {
    // Pure extraction & dialect resolution
    expect(extractExecutableSql({ sliceDoc: () => '', doc: { toString: () => '  SELECT 1;  ' } })).toBe('SELECT 1;')
    expect(
      extractExecutableSql({
        selection: { main: { empty: false, from: 0, to: 8 } },
        sliceDoc: () => 'SELECT 2',
        doc: { toString: () => 'SELECT 2; SELECT 3;' },
      })
    ).toBe('SELECT 2')
    expect(
      extractCaretStatementSql({
        selection: { main: { empty: false, from: 0, to: 8, head: 4 } },
        sliceDoc: () => 'SELECT 9',
        doc: { toString: () => 'SELECT 9;' },
      })
    ).toBe('SELECT 9')
      expect(
      extractCaretStatementSql(
        {
          selection: { main: { empty: true, from: 0, to: 0, head: 22 } },
          sliceDoc: () => '',
          doc: { toString: () => 'SELECT 1;\nSELECT 2 FROM b;' },
        },
        'postgres'
      )
    ).toBe('SELECT 2 FROM b')

    expect(resolveSqlDialect('clickhouse')).toBeDefined()
    expect(resolveSqlDialect('mariadb')).toBeDefined()

    // Parse samples directly via buildLanguageExtension parser so StreamLanguage tokenizers execute every rule!
    const parseSamples: Array<[Parameters<typeof buildLanguageExtension>[0], string]> = [
      ['mssql', "SELECT TOP 10 [my]]col], \"q\"\"id\", N'it''s', @@ROWCOUNT, 42.5 FROM dbo.t -- c\n/* ml \n comment */ + - ;"],
      ['oracle', "SELECT Nq'[hello]' || q'(world\nnext)', 'str''1', \"COL\", :p1, 10 FROM DUAL WHERE 1 <= 2 -- c\n/* blk\nend */\n/\n"],
      ['mongodb', "db.getCollection('users').find({ $match: { active: true, empty: null, tag: '$set', num: -12.5, txt: \"a\\\"b\" } }) // line\n/* blk\n*/ + ;"],
      ['redis', 'SCAN 0 MATCH * COUNT 50'],
    ]
    for (const [dialect, code] of parseSamples) {
      const langExt = buildLanguageExtension(dialect) as { language?: { parser?: { parse: (doc: string) => unknown } } }
      expect(langExt.language?.parser?.parse(code)).toBeDefined()
    }

    // Smart SQL completions across dialects & contexts
    const schema = { users: ['id', 'email', 'created_at'], orders: ['id', 'user_id', 'total'] }
    expect(computeSmartSqlCompletions('db.us', 5, 'mongodb', schema, undefined, false)?.options.length).toBeGreaterThan(0)
    expect(computeSmartSqlCompletions('db.users.fi', 11, 'mongodb', schema, undefined, false)?.options.length).toBeGreaterThan(0)
    expect(computeSmartSqlCompletions('$ma', 3, 'mongodb', schema, undefined, false)?.options.length).toBeGreaterThan(0)
    expect(computeSmartSqlCompletions('', 0, 'mongodb', schema, undefined, true)?.options.length).toBeGreaterThan(0)
    expect(computeSmartSqlCompletions('SELECT u.em FROM users AS u', 11, 'postgres', schema, undefined, false)?.options[0].label).toBe('email')
    expect(computeSmartSqlCompletions('SELECT * FROM us', 16, 'postgres', schema, undefined, false)?.options[0].label).toBe('users')
    expect(computeSmartSqlCompletions('SELECT sys FROM DUAL', 10, 'oracle', schema, 'users', false)?.options.length).toBeGreaterThan(0)
    expect(computeSmartSqlCompletions('SELECT to FROM orders', 9, 'mssql', schema, 'orders', false)?.options.length).toBeGreaterThan(0)
    expect(computeSmartSqlCompletions('SCAN', 4, 'redis', schema, undefined, false)?.options.length).toBeGreaterThan(0)
    expect(computeSmartSqlCompletions('', 0, 'redis', schema, undefined, true)).toBeNull()
    expect(computeSmartSqlCompletions('', 0, 'sqlite', schema, undefined, false)).toBeNull()

    // Real SqlConsoleController with CodeMirror 6 + aiInline
    const parent = dom.document.createElement('div')
    dom.body.appendChild(parent)
    const onExecute = vi.fn()
    const onExecuteAll = vi.fn()
    const onFormatSql = vi.fn()
    const onChange = vi.fn()
    const ctrl = new SqlConsoleController({
      parent,
      initialDoc: 'SELECT 1;',
      dialect: 'sqlite',
      schema,
      typography: { cssFontFamily: 'monospace', fontSize: 14, lineHeight: 20, fontWeight: '500', fontLigatures: false },
      aiInline: {
        isEnabled: () => false,
        requestCompletion: async () => null,
      },
      onExecute,
      onExecuteAll,
      onFormatSql,
      onChange,
    })

    try {
      expect(ctrl.getText()).toBe('SELECT 1;')
      ctrl.setDialect('postgres')
      ctrl.setDialect('postgres') // no-op when unchanged
      ctrl.setDialect('mssql')
      ctrl.setDialect('oracle')
      ctrl.setDialect('mongodb')
      ctrl.setDialect('redis')
      ctrl.setDialect('sqlite')

      ctrl.updateSchema(schema, 'users')
      ctrl.setColorScheme(true)
      ctrl.setColorScheme(true) // unchanged guard
      ctrl.setColorScheme(false)
      ctrl.applyTypography({ fontSize: 13, lineHeight: 1.6 })

      ctrl.setText('')
      expect(ctrl.getText()).toBe('')
      ctrl.insertText('SELECT 10')
      ctrl.insertText('SELECT 20;')
      ctrl.insertText('SELECT 30;')
      expect(onChange).toHaveBeenCalled()
      expect(ctrl.getExecutableSql()).toContain('SELECT 30;')
      expect(ctrl.getSelectedSql()).toBe('')
      expect(ctrl.hasSelection()).toBe(false)
      expect(ctrl.getCaretStatementSql()).toBeDefined()

      ctrl.setCursorOffset(-5)
      expect(ctrl.getCursorOffset()).toBe(0)
      ctrl.setCursorOffset(9999)
      expect(ctrl.getCursorOffset()).toBe(ctrl.getText().length)

      ctrl.openFindReplace()
      ctrl.focus()
      ctrl.clearAiGhost()

      // Dispatch keybindings on view.contentDOM
      const viewContent = (ctrl as unknown as { view: { contentDOM: HTMLElement } }).view.contentDOM
      dom.fireKey(viewContent, 'Enter', { ctrlKey: true })
      dom.fireKey(viewContent, 'Enter', { ctrlKey: true, shiftKey: true })
      dom.fireKey(viewContent, 'f', { shiftKey: true, altKey: true })
    } finally {
      ctrl.destroy()
    }

    // Post-destroy safe no-op guards
    expect(ctrl.getText()).toBe('')
    expect(ctrl.getExecutableSql()).toBe('')
    expect(ctrl.getSelectedSql()).toBe('')
    expect(ctrl.getCaretStatementSql()).toBe('')
    expect(ctrl.getCursorOffset()).toBe(0)
    ctrl.setDialect('postgres')
    ctrl.updateSchema(schema)
    ctrl.setColorScheme(true)
    ctrl.applyTypography({ fontSize: 12 })
    ctrl.setText('x')
    ctrl.insertText('y')
    ctrl.setCursorOffset(1)
    ctrl.openFindReplace()
    ctrl.focus()
    ctrl.clearAiGhost()
  })
})
