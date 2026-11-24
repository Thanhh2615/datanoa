import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'
import { installDomHarness, type DomHarness } from './helpers/dom-harness.js'
import { introspectSqliteTableDetails } from '../src/drivers/common/schema'
import {
  computeVirtualRange as coreComputeVirtualRange,
} from '../src/panel/panel-core.js'
import { PanelGridSelection } from '../src/panel/panel-selection.js'
import {
  canEditDriverStructure,
  getPanelDriverColumnTypes,
  createPanelStructureController,
} from '../src/panel/panel-structure.js'
import {
  getPanelEditorPlaceholder,
  getPanelDangerFindingBadgeLabel,
  findMongoStatementAtOffset,
  splitPanelTargetStatements,
  createPanelSqlController,
} from '../src/panel/panel-sql.js'
import {
  shouldDisableEditStructureButton,
  createPanelDataGridController,
} from '../src/panel/panel-data-grid.js'

let dom: DomHarness

async function flushAsync(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  dom = installDomHarness()
  dom.mountPanelHtml()
})

afterEach(() => {
  vi.useRealTimers()
  dom.teardown()
})

describe('Wave 3C Step 3: panel-structure, panel-sql & panel-data-grid', () => {
  it('covers src/panel/panel-structure.js with live SQLite introspection, combo popovers, validations & migrations', async () => {
    expect(canEditDriverStructure(null, { driver: 'sqlite' })).toBe(false)
    expect(canEditDriverStructure({ kind: 'view' }, { driver: 'sqlite' })).toBe(false)
    expect(canEditDriverStructure({ kind: 'table' }, { driver: 'redis' })).toBe(false)
    expect(canEditDriverStructure({ kind: 'table' }, { driver: 'mongodb' })).toBe(false)
    expect(canEditDriverStructure({ kind: 'table' }, { driver: 'postgres', readOnly: true })).toBe(false)
    expect(canEditDriverStructure({ kind: 'table' }, { driver: 'sqlite', readOnly: false })).toBe(true)

    expect(getPanelDriverColumnTypes('mssql')).toContain('UNIQUEIDENTIFIER')
    expect(getPanelDriverColumnTypes('oracle')).toContain('VARCHAR2(255)')
    expect(getPanelDriverColumnTypes('sqlite').length).toBeGreaterThan(3)
    expect(getPanelDriverColumnTypes('unknown').length).toBeGreaterThan(3)

    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'open',
        amount REAL
      );
      CREATE INDEX idx_orders_status ON orders(status);
    `)
    const execSqlite = async (sql: string) => sqlite.prepare(sql).all() as Record<string, unknown>[]
    const liveDetails = await introspectSqliteTableDetails(execSqlite, 'orders', 'main')

    let txActive = false
    let migrationThrows = false
    const calls: string[] = []
    ;(window as { orca?: unknown }).orca = {
      plugin: {
        request: vi.fn(async (name: string, payload?: Record<string, unknown>) => {
          if (name === 'tx.status') return { active: txActive, supported: true, autoCommit: !txActive }
          if (name === 'query.run') {
            if (migrationThrows) throw new Error('FK constraint mismatch')
            calls.push(`migrate:${String(payload?.sql || '')}`)
            return { ok: true }
          }
          return {}
        }),
      },
    }

    const pgConn = { id: 'c_sq', name: 'Local', driver: 'sqlite', readOnly: false }
    const roConn = { id: 'c_sq_ro', name: 'RO', driver: 'sqlite', readOnly: true }
    const mgConn = { id: 'c_mg', name: 'Mongo', driver: 'mongodb', readOnly: false }

    const state = {
      activeConnectionId: 'c_sq',
      activeTable: 'orders',
      activeSchema: 'main',
      structureLoading: true,
      structureError: null as string | null,
      structDraftKey: null as string | null,
      structDraft: null as Record<string, unknown> | null,
      structPreviewOpen: false,
      isMigrating: false,
      schemaObjects: {
        c_sq: [
          { name: 'users', schema: 'main', kind: 'table' },
          { name: 'orders', schema: 'main', kind: 'table' },
        ],
      } as Record<string, Array<Record<string, unknown>>>,
      tableDetails: {} as Record<string, unknown>,
    }

    let activeConn: Record<string, unknown> = pgConn
    const ctrl = createPanelStructureController({
      state,
      QUERY_TIMEOUT_MS: 5000,
      getActiveConn: () => activeConn,
      getConnById: (id: string) => (id === 'c_sq' ? pgConn : null),
      showBanner: (m: string, k: string) => calls.push(`banner:${k}:${m}`),
      savePanelViewState: () => calls.push('saveView'),
      loadSchema: async () => { calls.push('loadSchema') },
      loadTableDetails: async () => { calls.push('loadDetails') },
      loadTablePage: async () => { calls.push('loadPage') },
    })

    // 1. Loading skeleton -> Error + Retry -> Empty no-table
    ctrl.renderStructure()
    expect(document.querySelectorAll('#structureColTable .panel-skeleton-bar').length).toBeGreaterThan(0)
    state.structureLoading = false
    state.structureError = 'Timeout introspecting'
    ctrl.renderStructure()
    const retryBtn = Array.from(document.querySelectorAll('#structureEmpty button')).find((b) =>
      b.textContent === 'Retry'
    ) as HTMLButtonElement | undefined
    retryBtn?.click()
    await flushAsync()
    expect(calls).toContain('loadDetails')
    state.activeTable = null
    state.structureError = null
    ctrl.renderStructure()
    expect(document.getElementById('structureEmpty')!.textContent).toContain('No Table Selected')

    // 2. Render live SQLite TableDetails & exercise columns, combo popover (above/below/outside/scroll/resize), indexes, FKs
    state.activeTable = 'orders'
    state.tableDetails['c_sq:main:orders'] = liveDetails
    ctrl.renderStructure()

    // Rename 'status' column -> updates index pill & FK select
    const colInputs = Array.from(document.querySelectorAll('#structureColTable .struct-cell-input')) as HTMLInputElement[]
    const statusInp = colInputs.find((el) => el.value === 'status')!
    statusInp.value = 'order_status'
    statusInp.dispatchEvent(new Event('input', { bubbles: true }))

    // Default input & clear button
    const defInp = document.querySelector('#structureColTable .struct-default-wrap input') as HTMLInputElement | null
    if (defInp) {
      defInp.value = "'pending'"
      defInp.dispatchEvent(new Event('input', { bubbles: true }))
    }
    ;(document.querySelector('#structureColTable .struct-clear-btn') as HTMLButtonElement | null)?.click()

    // PK & Nullable checkboxes
    const cbs = Array.from(document.querySelectorAll('#structureColTable .struct-checkbox')) as HTMLInputElement[]
    if (cbs[2]) {
      cbs[2].checked = true
      cbs[2].dispatchEvent(new Event('change', { bubbles: true }))
      cbs[2].checked = false
      cbs[2].dispatchEvent(new Event('change', { bubbles: true }))
    }
    if (cbs[3]) {
      cbs[3].checked = !cbs[3].checked
      cbs[3].dispatchEvent(new Event('change', { bubbles: true }))
    }

    // Combo popover: open below -> open above (near viewport bottom) -> select item -> same-owner close -> doc mousedown -> scroll -> resize
    const comboToggle = document.querySelector('#structureColTable .struct-combo-toggle') as HTMLButtonElement
    comboToggle.click()
    expect(ctrl.isPanelComboOpen()).toBe(true)
    const comboItem = document.querySelector('.struct-combo-popover .struct-combo-item') as HTMLElement | null
    comboItem?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(ctrl.isPanelComboOpen()).toBe(false)

    // Mock wrap near bottom to trigger openAbove branch
    const wrapEl = comboToggle.parentElement!
    wrapEl.getBoundingClientRect = () => ({ left: 10, top: 550, right: 150, bottom: 580, width: 140, height: 30 })
    comboToggle.click()
    expect(ctrl.isPanelComboOpen()).toBe(true)
    window.dispatchEvent(new Event('resize'))
    expect(ctrl.isPanelComboOpen()).toBe(false)
    comboToggle.click()
    document.dispatchEvent(new Event('scroll'))
    comboToggle.click()
    comboToggle.click() // same-owner close
    comboToggle.click()
    window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(ctrl.isPanelComboOpen()).toBe(false)

    // Drop & Undo column
    ;(document.querySelector('#structureColTable .btn-danger') as HTMLButtonElement).click()
    const undoColBtn = Array.from(document.querySelectorAll('#structureColTable button')).find((b) => b.textContent === 'Undo') as HTMLButtonElement
    undoColBtn.click()

    // Stage new column (and remove), new index (name/unique/pills/Remove), drop/undo existing index, new FK (fields/onDelete/Remove), drop/undo existing FK
    const draft = state.structDraft as {
      tableName: string
      columns: Array<Record<string, unknown>>
      indexes: Array<Record<string, unknown>>
      foreignKeys: Array<Record<string, unknown>>
    }
    draft.columns.push({ id: 'new_c1', status: 'new', name: 'notes', dataType: 'TEXT', isPrimaryKey: false, nullable: true, defaultValue: '' })
    draft.columns.push({ id: 'new_bad', status: 'new', name: '', dataType: 'TEXT', isPrimaryKey: false, nullable: true, defaultValue: '' })
    draft.indexes.push({ id: 'new_i1', status: 'new', name: 'idx_notes', unique: false, columns: ['notes'] })
    draft.foreignKeys.push({ id: 'new_f1', status: 'new', columnId: null, column: 'user_id', foreignTable: 'users', foreignColumn: 'id', onDelete: 'CASCADE' })
    ctrl.renderStructure()

    // Preview validation error on blank new_bad column, then remove new_bad column via × button
    state.structPreviewOpen = true
    ctrl.refreshPanelStructStageBar()
    ctrl.applyPanelStructChanges() // invalid modal (Fix Errors)
    ctrl.closeMigrationConfirmModal()

    // Remove the invalid column button (last × in col table)
    const rmColBtns = Array.from(document.querySelectorAll('#structureColTable button')).filter((b) => b.textContent === '×') as HTMLButtonElement[]
    rmColBtns[rmColBtns.length - 1]?.click()

    // Exercise new index controls + drop/undo existing idx
    const idxInput = document.querySelector('#structureIdxList .struct-cell-input') as HTMLInputElement | null
    if (idxInput) {
      idxInput.value = 'idx_orders_notes'
      idxInput.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const idxKindSel = document.querySelector('#structureIdxList .struct-cell-select') as HTMLSelectElement | null
    if (idxKindSel) {
      idxKindSel.value = 'unique'
      idxKindSel.dispatchEvent(new Event('change', { bubbles: true }))
    }
    document.querySelectorAll('#structureIdxList .struct-col-pill').forEach((p) => (p as HTMLElement).click())
    const dropIdxBtn = Array.from(document.querySelectorAll('#structureIdxList button')).find((b) => b.textContent === 'Drop') as HTMLButtonElement | undefined
    dropIdxBtn?.click()
    const undoIdxBtn = Array.from(document.querySelectorAll('#structureIdxList button')).find((b) => b.textContent === 'Undo') as HTMLButtonElement | undefined
    undoIdxBtn?.click()

    // Exercise new FK controls + drop/undo existing FK
    const fkSel = document.querySelector('#structureFkList .struct-fk-col-select') as HTMLSelectElement | null
    if (fkSel) {
      fkSel.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const fkInputs = Array.from(document.querySelectorAll('#structureFkList .struct-cell-input')) as HTMLInputElement[]
    fkInputs.forEach((inp) => inp.dispatchEvent(new Event('input', { bubbles: true })))
    const fkOnDel = Array.from(document.querySelectorAll('#structureFkList .struct-cell-select')).find((s) =>
      Array.from((s as HTMLSelectElement).options).some((o) => o.value === 'CASCADE')
    ) as HTMLSelectElement | undefined
    if (fkOnDel) {
      fkOnDel.value = 'SET NULL'
      fkOnDel.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const dropFkBtn = Array.from(document.querySelectorAll('#structureFkList button')).find((b) => b.textContent === 'Drop') as HTMLButtonElement | undefined
    dropFkBtn?.click()
    const undoFkBtn = Array.from(document.querySelectorAll('#structureFkList button')).find((b) => b.textContent === 'Undo') as HTMLButtonElement | undefined
    undoFkBtn?.click()

    // Rename column while index pills & FK options exist, plus buildPanelMigrationSql & rename table
    const firstColInp = document.querySelector('#structureColTable input.struct-cell-input') as HTMLInputElement | null
    if (firstColInp) {
      const origColName = firstColInp.value
      firstColInp.value = 'order_pk'
      firstColInp.dispatchEvent(new Event('input', { bubbles: true }))
      firstColInp.value = origColName
      firstColInp.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const migRes = ctrl.buildPanelMigrationSql(state.structDraft, 'sqlite')
    expect(migRes && typeof migRes).toBe('object')
    ;(document.getElementById('structureTableNameInput') as HTMLInputElement).value = 'orders_v2'
    ctrl.refreshPanelStructStageBar()

    // 3. Apply staged migration: manual TX blocks SQLite rebuild -> fail -> elapsed timer -> success
    txActive = true
    ctrl.applyPanelStructChanges()
    await flushAsync(4)
    expect(document.getElementById('confirmMigrationErrors')!.textContent).toContain('manual transaction')
    ctrl.closeMigrationConfirmModal()

    txActive = false
    ctrl.applyPanelStructChanges()
    await flushAsync(2)
    migrationThrows = true
    void ctrl.executeConfirmedPanelMigration()
    await vi.advanceTimersByTimeAsync(250)
    await flushAsync(4)
    expect(document.getElementById('confirmMigrationErrors')!.textContent).toContain('FK constraint mismatch')

    migrationThrows = false
    void ctrl.executeConfirmedPanelMigration()
    await vi.advanceTimersByTimeAsync(250)
    await flushAsync(6)
    expect(calls.some((c) => c.startsWith('migrate:'))).toBe(true)

    // 4. ReadOnly & MongoDB views
    activeConn = roConn
    ctrl.applyPanelStructChanges() // read-only guard
    ctrl.renderStructure()
    activeConn = mgConn
    ctrl.renderStructure()
    sqlite.close()
  })

  it('covers src/panel/panel-sql.js pure helpers + PBT, real CM6 tabs, splitters, EXPLAIN AI, danger modal & history', async () => {
    expect(getPanelEditorPlaceholder('redis')).toContain('SCAN')
    expect(getPanelEditorPlaceholder('mongodb')).toContain('getCollection')
    expect(getPanelEditorPlaceholder('postgres')).toContain('SELECT')

    for (const d of ['mongodb', 'postgres']) {
      for (const k of ['delete_without_where', 'update_without_where', 'drop', 'truncate', 'other']) {
        expect(getPanelDangerFindingBadgeLabel(k, d).length).toBeGreaterThan(3)
      }
    }

    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('db.users.find({})', 'db.orders.countDocuments({})', ''), { minLength: 1, maxLength: 3 }),
        fc.integer({ min: -5, max: 60 }),
        (parts, pos) => {
          const out = findMongoStatementAtOffset(parts.join(';\n'), pos)
          expect(typeof out).toBe('string')
        }
      ),
      { numRuns: 30 }
    )
    expect(findMongoStatementAtOffset('   ', 0)).toBe('')
    expect(splitPanelTargetStatements('', 'sqlite')).toEqual([])
    expect(splitPanelTargetStatements('GET a; SET b c', 'redis')).toEqual(['GET a; SET b c'])
    expect(splitPanelTargetStatements('SELECT 1; SELECT 2;', 'postgres')).toHaveLength(2)

    let runMode: 'select' | 'multi' | 'empty' | 'throw' = 'select'
    let explainFailOne = true
    let aiMode: 'ok' | 'fail' = 'fail'
    ;(window as { orca?: unknown }).orca = {
      locale: 'en',
      settings: {
        get: vi.fn(async (k: string) => (k === 'maxRows' ? 250 : undefined)),
      },
      plugin: {
        request: vi.fn(async (method: string, payload?: Record<string, unknown>) => {
          if (method === 'query.run') {
            if (runMode === 'throw') throw new Error('syntax error near FROM')
            if (runMode === 'empty') {
              return { columns: [{ name: 'id', type: 'INT' }], rows: [], rowCount: 0, isSelect: true, executionTimeMs: 2 }
            }
            if (runMode === 'multi') {
              return {
                executionTimeMs: 15,
                resultSets: [
                  { index: 0, isSelect: false, affectedRows: 2, executionTimeMs: 3 },
                  {
                    index: 1,
                    isSelect: true,
                    columns: [{ name: 'id', type: 'INT' }, { name: 'score', type: 'INT' }, { name: 'meta', type: 'JSON' }],
                    rows: [[1, 10, { a: 1 }], [2, null, null], [3, 5, { b: 2 }]],
                    rowCount: 3,
                    executionTimeMs: 8,
                  },
                  { index: 2, isError: true, errorMessage: 'division by zero' },
                ],
              }
            }
            return {
              columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'TEXT' }],
              rows: [[1, 'Alice'], [2, 'Bob']],
              rowCount: 2,
              isSelect: true,
              executionTimeMs: 4,
            }
          }
          if (method === 'query.explain') {
            const sql = String(payload?.sql || '')
            if (explainFailOne && sql.includes('bad_tbl')) throw new Error('no such table: bad_tbl')
            return {
              columns: [{ name: 'detail' }],
              rows: [['SCAN users']],
              rowCount: 1,
              isSelect: true,
              executionTimeMs: 3,
            }
          }
          if (method === 'ai.explainAnalyze') {
            if (aiMode === 'fail') throw new Error('API quota exceeded')
            return {
              summary: 'Full table scan detected.',
              severity: 'warn',
              bottlenecks: ['Full scan on users'],
              recommendations: ['Add index'],
              suggestedSql: 'CREATE INDEX idx_u ON users(id); SELECT * FROM users;',
            }
          }
          if (method === 'query.history.list') {
            return {
              entries: [
                { connectionName: 'Prod PG', driver: 'postgres', sql: 'SELECT * FROM users;', rowCount: 2, durationMs: 4, isError: false, timestamp: Date.now() - 30000 },
                { connectionName: '', driver: 'sqlite', sql: 'BAD SQL', rowCount: 0, durationMs: 1, isError: true, timestamp: Date.now() - 5000 },
              ],
            }
          }
          return {}
        }),
      },
    }

    const calls: string[] = []
    const prodConn = { id: 'c_pg', name: 'Prod PG', driver: 'postgres', colorTag: 'prod', readOnly: false }
    const roConn = { id: 'c_ro', name: 'ReadOnly', driver: 'postgres', colorTag: 'staging', readOnly: true }
    let activeConn: Record<string, unknown> | null = prodConn
    const state = {
      activeConnectionId: 'c_pg',
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

    let sqlGridSel: PanelGridSelection | null = null
    const ctrl = createPanelSqlController({
      state,
      QUERY_TIMEOUT_MS: 5000,
      VIRT_ROW_HEIGHT_PX: 26,
      getActiveConn: () => activeConn,
      getConnById: (id: string) => (id === 'c_pg' ? prodConn : id === 'c_ro' ? roConn : null),
      getSqlGridSel: () => sqlGridSel,
      getSuppressSortClickUntil: () => 0,
      setLastPanelCopiedText: (t: string) => calls.push(`lastCopy:${t.length}`),
      computeVirtualRange: (s: number, h: number, tot: number) => coreComputeVirtualRange(s, h, tot, 26, 4),
      attachColumnResizeHandle: () => {},
      copyText: async (_t: string, msg: string) => { calls.push(`copy:${msg}`) },
      showBanner: (m: string, k: string) => calls.push(`banner:${k}:${m}`),
      loadSchema: async () => { calls.push('loadSchema') },
      savePanelViewState: () => {},
      scheduleSavePanelViewState: () => {},
      savePanelDataCache: () => {},
      onFormatSql: () => calls.push('format'),
      getAiStatus: () => ({ enabled: true, state: 'on', explainLanguage: 'en' }),
      openAiSettingsModal: async () => calls.push('aiSettings'),
      onRefreshAiStatus: () => {},
    })

    sqlGridSel = new PanelGridSelection({
      wrapEl: document.getElementById('sqlResultWrap')!,
      tableEl: document.getElementById('sqlResultTable')!,
      editable: false,
      getDimensions: () => ({
        rows: ctrl.sqlVirt.sortedRows.length,
        cols: ctrl.sqlVirt.columns.length,
      }),
      getValueAt: (r: number, c: number) => ctrl.sqlVirt.sortedRows[r]?.[c],
      onSelectionChange: () => ctrl.renderSqlSelectionStats(),
      onCopy: () => ctrl.copySqlSelection('tsv', false),
    })

    try {
      // 1. Editor tabs, text, dialect, schema, safety banner & resizer drag
      ctrl.restoreConsoleTabsState(null, 'SELECT 1;')
      ctrl.restoreConsoleTabsState({ activeTabId: 'x', tabs: [{ id: 'x', title: 'Main', sql: 'SELECT 1;' }] })
      ctrl.setSqlDialect('postgres')
      ctrl.setSqlSchema({ users: ['id', 'name'] }, 'users')
      ctrl.setSqlColorScheme(true)
      ctrl.setSqlTypography({ fontSize: 13 })
      ctrl.openSqlFindReplace()

      // Console tab bar UI: add tab, dblclick/F2 rename (Escape + Enter), switch, close
      ;(document.querySelector('#sqlConsoleTabsBar .sql-console-tab-add') as HTMLButtonElement).click()
      const tabs = document.querySelectorAll('#sqlConsoleTabsBar .sql-console-tab')
      tabs[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
      const renInp = document.querySelector('#sqlConsoleTabsBar .sql-console-tab-rename') as HTMLInputElement | null
      if (renInp) {
        renInp.value = 'Analytics'
        renInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      }
      tabs[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      ;(document.querySelector('#sqlConsoleTabsBar .sql-console-tab-close') as HTMLButtonElement | null)?.click()

      // Resizer pointer & mouse drag, keyboard keys, dblclick, window resize
      // First exercise fallback when container height is 0, then applyClampedSqlEditorHeight with null height
      expect(ctrl.setSqlEditorHeight(200, { persist: false })).toBe(132)
      const tabSql = document.getElementById('tabSql')!
      tabSql.getBoundingClientRect = () => ({
        top: 0, left: 0, right: 900, bottom: 700, width: 900, height: 700, x: 0, y: 0, toJSON() {},
      })
      const resizer = document.getElementById('sqlEditorResizer')!
      resizer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      ctrl.applyClampedSqlEditorHeight()
      resizer.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientY: 100, bubbles: true }))
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 180 }))
      window.dispatchEvent(new Event('pointerup'))
      resizer.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientY: 100, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientY: 160 }))
      window.dispatchEvent(new Event('blur'))
      for (const k of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter']) {
        resizer.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
      }
      resizer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      window.dispatchEvent(new Event('resize'))
      expect(ctrl.setSqlEditorHeight(200, { persist: true })).toBe(200)
      expect(ctrl.getSqlEditorHeight()).toBe(200)

      // Safety banners across prod, prod+ro, ro, none
      ctrl.renderSqlSafetyBanner()
      ctrl.dismissSqlSafetyBanner()
      ctrl.resetSqlSafetyBannerDismissal()
      activeConn = roConn
      ctrl.renderSqlSafetyBanner()
      activeConn = { id: 'c_none', driver: 'sqlite', readOnly: false }
      ctrl.renderSqlSafetyBanner()
      activeConn = prodConn
      ctrl.renderSqlSafetyBanner()

      // 2. Danger SQL modal on Prod connection -> confirm -> execute query
      ctrl.setSqlText('DELETE FROM users;')
      await ctrl.runSql('all')
      expect((document.getElementById('dangerSqlModal') as HTMLElement).hidden).toBe(false)
      ;(document.getElementById('dangerSqlConfirmCheck') as HTMLInputElement).checked = true
      document.getElementById('dangerSqlConfirmCheck')!.dispatchEvent(new Event('change', { bubbles: true }))
      const dangerInp = document.getElementById('dangerSqlConfirmInput') as HTMLInputElement
      dangerInp.value = 'CONFIRM'
      dangerInp.dispatchEvent(new Event('input', { bubbles: true }))
      dangerInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushAsync(8)

      // 3. Multi-result set query + sort + selection + copy + export + banners + empty + error
      runMode = 'multi'
      ctrl.setSqlText('INSERT INTO a VALUES (1); SELECT id, score, meta FROM users; SELECT 1/0;')
      await ctrl.runSql('all', { skipDangerGuard: true })
      await flushAsync(6)
      const resTabs = document.querySelectorAll('#sqlResultSetsBar .sql-result-tab')
      expect(resTabs.length).toBe(3)
      ;(resTabs[1] as HTMLButtonElement).click()
      // Sort column click (ASC -> DESC) + Shift click
      const ths = Array.from(document.querySelectorAll('#sqlResultTable thead th')) as HTMLElement[]
      ths[1]?.click()
      ths[1]?.click()
      ths[2]?.dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }))
      ctrl.copySqlSelection('csv', true)
      ctrl.exportCurrentSqlResult('json', true, 'json', 'application/json')
      ctrl.exportCurrentSqlResult('csv', false, 'csv', 'text/csv')
      ;(resTabs[2] as HTMLButtonElement).click()
      ctrl.dismissActiveSqlErrorBanner()
      ;(resTabs[1] as HTMLButtonElement).click()
      ctrl.dismissActiveSqlSuccessBanner()

      ctrl.ensureSqlVirtualRowVisible(1)
      runMode = 'empty'
      ctrl.setSqlText('SELECT * FROM empty_tbl;')
      await ctrl.runSql('caret', { skipDangerGuard: true })
      await flushAsync(6)

      runMode = 'throw'
      ctrl.setSqlText('SELECT * FROM broken;')
      await ctrl.runSql('caret', { skipDangerGuard: true })
      await flushAsync(6)

      // 4. Multi-statement EXPLAIN + AI Explain Analysis (fail -> success -> buttons)
      ctrl.setSqlText('SELECT * FROM users; SELECT * FROM bad_tbl;')
      await ctrl.runSql('explain', { skipDangerGuard: true })
      await flushAsync(8)
      // Trigger Analyze AI (fail -> retry ok -> apply/new-tab/copy/collapse)
      aiMode = 'fail'
      const analyzeBtn = Array.from(document.querySelectorAll('#sqlExplainAiPanel button')).find((b) =>
        /Analyze|Explain with AI/i.test(b.textContent ?? '')
      ) as HTMLButtonElement | undefined
      analyzeBtn?.click()
      await flushAsync(8)
      aiMode = 'ok'
      const retryAiBtn = Array.from(document.querySelectorAll('#sqlExplainAiPanel button')).find((b) =>
        /Retry|Analyze/i.test(b.textContent ?? '')
      ) as HTMLButtonElement | undefined
      retryAiBtn?.click()
      await flushAsync(8)
      for (const btn of Array.from(document.querySelectorAll('#sqlExplainAiPanel button')) as HTMLButtonElement[]) {
        if (/Apply|New Tab|Copy|Collapse|Expand/i.test(btn.textContent ?? '')) btn.click()
      }

      // 5. History filter, Insert/Copy, Cancel, AI status changed, Clear
      await ctrl.loadQueryHistory()
      state.historyFilter = 'users'
      ctrl.renderQueryHistory()
      state.historyFilter = 'zzz'
      ctrl.renderQueryHistory()
      state.historyFilter = ''
      ctrl.renderQueryHistory()
      ;(document.querySelector('#sqlHistoryList button') as HTMLButtonElement | null)?.click()
      ctrl.onAiStatusChanged()
      ctrl.markSqlRunCancelled()
      ctrl.cancelPendingSqlRun()
      ctrl.bumpHistorySeq()
      ctrl.clearSqlResultDisplay()
      expect(ctrl.getConsoleTabsPersistedState(() => false).tabs.length).toBeGreaterThanOrEqual(1)
    } finally {
      sqlGridSel?.destroy()
      ctrl.destroySqlEditor()
    }
  })

  it('covers src/panel/panel-data-grid.js virtual grid, transpose, resize, copy/paste, inline edit, staging & Value Inspector', async () => {
    expect(shouldDisableEditStructureButton({ busy: true, isView: false, activeTable: 't', driver: 'sqlite' })).toBe(true)
    expect(shouldDisableEditStructureButton({ busy: false, isView: true, activeTable: 't', driver: 'sqlite' })).toBe(true)
    expect(shouldDisableEditStructureButton({ busy: false, isView: false, activeTable: '', driver: 'sqlite' })).toBe(true)
    expect(shouldDisableEditStructureButton({ busy: false, isView: false, activeTable: 't', driver: 'mongodb' })).toBe(true)
    expect(shouldDisableEditStructureButton({ busy: false, isView: false, activeTable: 't', driver: 'postgres' })).toBe(false)

    ;(window as { orca?: unknown }).orca = {
      files: {
        saveAs: vi
          .fn()
          .mockResolvedValueOnce({ status: 'saved' })
          .mockResolvedValueOnce({ status: 'cancelled' }),
      },
    }

    const banners: string[] = []
    let activeResizeCleanup: (() => void) | null = null
    let suppressUntil = 0
    let lastCopied = ''
    const pinnedSet = new Set(['id'])
    const hiddenSet = new Set<string>()
    const tableCols = [
      { name: 'id', type: 'INTEGER', nativeType: 'INTEGER', isPrimaryKey: true, nullable: false, isAutoIncrement: true },
      { name: 'name', type: 'TEXT', nativeType: 'TEXT', nullable: true },
      { name: 'score', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, defaultValue: '0' },
      { name: 'payload', type: 'JSON', nativeType: 'JSON', nullable: true },
    ]

    const state = {
      activeConnectionId: 'c_pg',
      activeTable: 'users',
      activeSchema: 'public',
      dataLoading: true,
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
      stagedDeletes: new Map<string, { primaryKeys: Record<string, unknown>; originalRow: Record<string, unknown> }>(),
      schemaObjects: {
        c_pg: [
          { name: 'users', schema: 'public', kind: 'table' },
          { name: 'v_users', schema: 'audit', kind: 'view' },
        ],
      } as Record<string, Array<Record<string, unknown>>>,
      pageData: null as {
        columns: Array<Record<string, unknown>>
        rows: Array<Record<string, unknown>>
        totalRows: number
        page: number
        pageSize: number
        primaryKey: string[]
        canEdit: boolean
      } | null,
    }

    let activeConn = { id: 'c_pg', driver: 'postgres', readOnly: false }
    let gridSel: PanelGridSelection | null = null

    const ctrl = createPanelDataGridController({
      state,
      VIRT_ROW_HEIGHT_PX: 26,
      VIRT_OVERSCAN_ROWS: 4,
      getActiveConn: () => activeConn,
      getStagedCount: () => state.stagedInserts.length + state.stagedUpdates.size + state.stagedDeletes.size,
      isSubmittingChanges: () => false,
      isPreviewingDml: () => false,
      getDataGridSel: () => gridSel,
      getActiveTableKey: () => 'c_pg:public:users',
      getOrderedVisibleColumns: () => tableCols.filter((c) => !hiddenSet.has(c.name)),
      getPinnedColsSet: () => pinnedSet,
      getHiddenColsSet: () => hiddenSet,
      getActiveForeignKeyMap: () => new Map([['score', { referencedTable: 'tiers', referencedColumn: 'id' }]]),
      getLastPanelCopiedText: () => lastCopied,
      setLastPanelCopiedText: (t: string) => { lastCopied = t },
      getSuppressSortClickUntil: () => suppressUntil,
      setSuppressSortClickUntil: (v: number) => { suppressUntil = v },
      getActiveResizeCleanup: () => activeResizeCleanup,
      setActiveResizeCleanup: (fn: (() => void) | null) => { activeResizeCleanup = fn },
      setInspectorUserModified: () => {},
      showBanner: (m: string) => banners.push(m),
      copyText: async (t: string) => { lastCopied = t },
      loadTablePage: async () => { banners.push('loadPage') },
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
      onCopy: () => ctrl.copyDataSelection('tsv', false),
      onPaste: (_s: unknown, txt: string) => ctrl.pasteDelimitedIntoDataGrid(txt, { forceNewRows: false }),
      onPasteNewRows: () => void ctrl.triggerPanelPasteNewRows(),
      onBulkDeleteRows: () => ctrl.toggleDeleteSelectedRows(),
      onBulkSetNull: () => ctrl.bulkSetSelectedCellsValue(null),
      onStartEdit: (r: number, c: number) => {
        const td = gridTable.querySelector(`tbody td[data-row-idx="${r}"][data-col-idx="${c}"]`) as HTMLElement | null
        const entry = ctrl.dataVirt.allRows[r]
        const col = ctrl.dataVirt.visCols[c]
        if (td && entry && col) {
          ctrl.startInlineEdit(td, entry.rowKey, entry.data, col, ctrl.getEffectiveCellValue(entry.rowKey, entry.data, col.name))
        }
      },
    })

    try {
      // 1. Skeleton -> Empty -> Empty rows -> Populated page
      ctrl.renderDataGrid()
      state.dataLoading = false
      ctrl.renderDataGrid()
      expect((document.getElementById('dataEmpty') as HTMLElement).hidden).toBe(false)

      state.pageData = {
        columns: tableCols,
        rows: [],
        totalRows: 0,
        page: 1,
        pageSize: 100,
        primaryKey: ['id'],
        canEdit: true,
      }
      ctrl.renderDataToolbar()
      ctrl.renderDataGrid()

      state.pageData = {
        columns: tableCols,
        rows: [
          { id: 1, name: 'Alice', score: 90, payload: { role: 'admin' } },
          { id: 2, name: null, score: 80, payload: null },
          { id: 3, name: 'Charlie', score: 75, payload: '[1,2]' },
        ],
        totalRows: 3,
        page: 1,
        pageSize: 100,
        primaryKey: ['id'],
        canEdit: true,
      }
      ctrl.renderDataToolbar()
      ctrl.renderDataGrid()

      // 2. Column resize drag + dblclick auto-fit + sort + pin + hide (to last col guard)
      const resizeHandle = gridTable.querySelector('thead th .col-resize-handle') as HTMLElement
      resizeHandle.dispatchEvent(new MouseEvent('mousedown', { clientX: 50, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 95 }))
      dom.runRaf()
      window.dispatchEvent(new Event('mouseup'))
      resizeHandle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      suppressUntil = 0

      ctrl.toggleColumnPinned('name')
      ctrl.toggleColumnHidden('payload')
      ctrl.toggleColumnHidden('payload') // unhide
      ctrl.autoFitDataColumn('name')

      // Sort column click + Ctrl+click selectCol
      const colTh = gridTable.querySelector('thead th[data-col-name="name"]') as HTMLElement
      colTh.click()
      colTh.dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }))

      // 3. Inline editing (Enter, Escape, Tab next, Shift+Tab, blur)
      const nameTd = gridTable.querySelector('tbody td[data-row-idx="0"][data-col-idx="1"]') as HTMLElement
      ctrl.startInlineEdit(nameTd, 'row_0', state.pageData.rows[0], tableCols[1], 'Alice')
      const editInp = nameTd.querySelector('input') as HTMLInputElement
      editInp.value = 'Alice Updated'
      editInp.dispatchEvent(new Event('input', { bubbles: true }))
      editInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

      const scoreTd = gridTable.querySelector('tbody td[data-row-idx="0"][data-col-idx="2"]') as HTMLElement
      ctrl.startInlineEdit(scoreTd, 'row_0', state.pageData.rows[0], tableCols[2], 90)
      const scoreInp = scoreTd.querySelector('input') as HTMLInputElement
      scoreInp.value = '99'
      scoreInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
      // Escape on newly tabbed cell
      const nextInp = gridTable.querySelector('input.cell-edit-input') as HTMLInputElement | null
      nextInp?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

      // 4. Copy + Paste (fill, overwrite + overflow new rows) + Clone + Delete + Bulk Set + Build Payload
      gridSel.selectCell(0, 1)
      gridSel.selectCell(1, 2, { shift: true })
      ctrl.copyDataSelection('csv', true)
      expect(ctrl.pasteDelimitedIntoDataGrid('Alice2\t95\nRowA\t10\nOverflow\t50')).toBe(true)
      ctrl.clearCopiedSnapshot()
      gridSel.selectCell(0, 1)
      ctrl.bulkSetSelectedCellsValue('Bob')
      ctrl.cloneSelectedRows()
      gridSel.selectRow(0)
      ctrl.toggleDeleteSelectedRows() // removes cloned row_ins
      gridSel.selectRow(1)
      ctrl.toggleDeleteSelectedRows() // marks row_1 deleted
      const payload = ctrl.buildDataChangesPayload()
      expect(payload.updates?.length).toBeGreaterThan(0)
      expect(payload.deletes?.length).toBeGreaterThan(0)

      // 5. Find in Grid (normal & transposed), Value Inspector JSON / Invalid JSON / NULL, Export
      state.findQuery = 'Overflow'
      ctrl.updateDataFindHighlights(true)
      expect(document.getElementById('dataFindCount')!.textContent).toBe('1/1')

      ctrl.exportCurrentDataPage('csv', true, 'csv', 'text/csv')
      ctrl.exportCurrentDataPage('json', true, 'json', 'application/json')
      ctrl.exportCurrentDataPage('tsv', false, 'tsv', 'text/tab-separated-values')
      await flushAsync(4)

      state.selectedRowKey = 'row_0'
      state.selectedCol = 'payload'
      ctrl.renderValueInspector()
      ;(document.getElementById('valueInspectorText') as HTMLInputElement).value = '{bad json'
      ctrl.updateInspectorMetaAndJson()
      expect(document.getElementById('inspectorJsonBadge')!.textContent).toBe('Invalid JSON')

      // Transposed mode + Tab navigation + readOnly/view/noPk banners
      state.transposed = true
      ctrl.renderDataGrid()
      ctrl.updateDataFindHighlights(true)
      const transTd = gridTable.querySelector('tbody td[data-editable="1"]') as HTMLElement | null
      if (transTd) {
        ctrl.startInlineEdit(transTd, transTd.dataset.rowKey!, state.pageData.rows[0], tableCols[1], 'Bob')
        transTd.querySelector('input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
        gridTable.querySelector('input.cell-edit-input')?.dispatchEvent(new Event('blur'))
      }

      ctrl.applyQuickWhere('"name" IS NOT NULL')
      activeConn = { id: 'c_ro', driver: 'postgres', readOnly: true }
      ctrl.renderStagingBar()
      ctrl.stageCellValue('row_0', state.pageData.rows[0], 'name', 'BlockedRo')
      state.activeTable = 'v_users'
      activeConn = { id: 'c_pg', driver: 'postgres', readOnly: false }
      ctrl.renderStagingBar()
      expect(ctrl.pasteDelimitedIntoDataGrid('x\t1')).toBe(false)

      // 6. Polish: Clipboard menu paste (empty / throw fallback / NULL snapshot / fill / new-rows / no-PK / staged-insert DOM scan)
      state.activeTable = 'users'
      state.transposed = false
      ctrl.renderDataGrid()
      const origReadText = navigator.clipboard.readText
      try {
        lastCopied = ''
        ctrl.clearCopiedSnapshot()
        navigator.clipboard.readText = async () => ''
        await ctrl.triggerPanelPasteNewRows()
        await ctrl.triggerPanelPasteSmart()
        expect(banners.some((b) => b.includes('Copy rows first'))).toBe(true)
        expect(banners.some((b) => b.includes('Use Ctrl+V'))).toBe(true)

        // Throwing readText falls back to getLastPanelCopiedText
        gridSel.selectCell(0, 1)
        ctrl.copyDataSelection('tsv', false)
        navigator.clipboard.readText = async () => {
          throw new Error('clipboard denied')
        }
        await ctrl.triggerPanelPasteSmart()

        // Single NULL cell copy snapshot (isCopiedNullCell) -> triggerPanelPasteSmart on non-nullable & nullable cells
        gridSel.selectCell(1, 1) // row_1.name is null
        ctrl.copyDataSelection('tsv', false)
        lastCopied = ''
        navigator.clipboard.readText = async () => ''
        gridSel.selectCell(0, 1)
        await ctrl.triggerPanelPasteSmart()

        // Fill mode across mixed PK + editable + non-nullable null
        ctrl.clearCopiedSnapshot()
        gridSel.selectCell(0, 0)
        gridSel.selectCell(1, 2, { shift: true })
        ctrl.pasteDelimitedIntoDataGrid('FillVal') // Fill across PK (skipped) + editable name + score
        gridSel.selectCell(0, 0)
        ctrl.pasteDelimitedIntoDataGrid('OnlyPkSkipped')

        // Multi-row paste with snapshot headers & overflow inserts (`added > 0` + `applied > 0`)
        gridSel.selectCell(0, 1)
        gridSel.selectCell(1, 2, { shift: true })
        ctrl.copyDataSelection('tsv', true)
        gridSel.selectCell(2, 1)
        navigator.clipboard.readText = async () => lastCopied
        await ctrl.triggerPanelPasteSmart()

        // Paste only as new rows (`added > 0`) & object coercion fallback via snapshot-less delimited paste
        await ctrl.triggerPanelPasteNewRows()
        expect(ctrl.pasteAsNewRowsInDataGrid('AddedName\t42')).toBe(true)

        // Focus-only selectionBBox + state.selectedRowKey fallback (`gridSel = null`)
        gridSel.selectCell(0, 1)
        ;(gridSel as unknown as { ranges: unknown[]; focus: { r: number; c: number } | null }).ranges = []
        ;(gridSel as unknown as { focus: { r: number; c: number } | null }).focus = { r: 0, c: 1 }
        ctrl.pasteDelimitedIntoDataGrid('FocusOnly')
        const savedSel = gridSel
        gridSel = null
        state.selectedRowKey = 'row_0'
        state.selectedCol = 'name'
        ctrl.pasteDelimitedIntoDataGrid('StateSelectedOnly')
        gridSel = savedSel

        // Pasting onto staged insert row + DOM scan patchRenderedDataCell(patchTd = null) + active findQuery
        const stagedIns = state.stagedInserts[0]
        if (stagedIns) {
          state.findQuery = 'AddedName'
          ctrl.stageCellValue(stagedIns.tempId, stagedIns.values, 'name', 'AddedNamePatched', false, null)
          state.selectedRowKey = stagedIns.tempId
          state.selectedCol = 'id' // auto-increment / undefined -> AUTO
          ctrl.renderValueInspector()
          state.selectedCol = 'name'
          ctrl.renderValueInspector()
        }

        // No-PK table warn banner (`canEdit: false`) when pasting over existing cells
        const prevCanEdit = state.pageData.canEdit
        state.pageData.canEdit = false
        gridSel.selectCell(2, 1)
        ctrl.pasteDelimitedIntoDataGrid('NoPkEdit')
        state.pageData.canEdit = prevCanEdit

        // 7. Virtual scroll (>80 rows) + onBeforeDetachRow blur + ensureDataVirtualRowVisible + Value Inspector null/object
        const manyRows = Array.from({ length: 90 }, (_, idx) => ({
          id: idx + 1,
          name: idx === 1 ? null : `User_${idx}`,
          score: idx * 2,
          payload: idx === 0 ? { nested: true } : idx === 2 ? null : '{"ok":1}',
        }))
        state.stagedInserts = []
        state.stagedUpdates.clear()
        state.stagedDeletes.clear()
        state.findQuery = ''
        state.pageData = {
          columns: tableCols,
          rows: manyRows,
          totalRows: 90,
          page: 1,
          pageSize: 100,
          primaryKey: ['id'],
          canEdit: true,
        }
        gridWrap.clientHeight = 200
        gridWrap.scrollTop = 0
        ctrl.renderDataGrid()
        expect(ctrl.dataVirt.active).toBe(true)

        // Start inline edit on row 0, then scroll far down so onBeforeDetachRow blurs input.cell-edit-input
        const row0Td = gridTable.querySelector('tbody td[data-row-idx="0"][data-col-idx="1"]') as HTMLElement | null
        if (row0Td) {
          ctrl.startInlineEdit(row0Td, 'row_0', manyRows[0], tableCols[1], 'User_0')
        }
        gridWrap.scrollTop = 1800
        ctrl.renderDataVirtualWindow(false)
        ctrl.ensureDataVirtualRowVisible(0)
        ctrl.ensureDataVirtualRowVisible(82)

        // Value Inspector with NULL cell & object cell & valid JSON string
        state.selectedRowKey = 'row_1'
        state.selectedCol = 'name'
        ctrl.renderValueInspector()
        state.selectedRowKey = 'row_0'
        state.selectedCol = 'payload'
        ctrl.renderValueInspector()
        state.selectedRowKey = 'row_2'
        state.selectedCol = 'payload'
        ctrl.renderValueInspector()
      } finally {
        navigator.clipboard.readText = origReadText
      }
    } finally {
      activeResizeCleanup?.()
      gridSel?.destroy()
    }
  })
})
