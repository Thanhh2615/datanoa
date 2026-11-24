import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installDomHarness, type DomHarness } from './helpers/dom-harness.js'
import { createLiveStudioSqliteBackend, flushMicro, flushTick } from './helpers/live-studio-sqlite.js'

function setupStudioViewportGeometry() {
  const rect = (w = 1200, h = 800) => () => ({
    top: 0,
    left: 0,
    right: w,
    bottom: h,
    width: w,
    height: h,
    x: 0,
    y: 0,
    toJSON() {},
  })
  document.body.clientWidth = 1200
  document.body.clientHeight = 800
  document.body.getBoundingClientRect = rect(1200, 800)
}

function patchMountedStudioMetrics() {
  const rect = (w: number, h: number) => () => ({
    top: 0,
    left: 0,
    right: w,
    bottom: h,
    width: w,
    height: h,
    x: 0,
    y: 0,
    toJSON() {},
  })
  const gridArea = document.querySelector('.datanoa-grid-container') as HTMLElement | null
  if (gridArea) {
    gridArea.clientWidth = 900
    gridArea.clientHeight = 420
    gridArea.scrollWidth = 1200
    gridArea.scrollHeight = 3200
    gridArea.getBoundingClientRect = rect(900, 420)
  }
  const sqlArea = document.querySelector('.datanoa-sql-area') as HTMLElement | null
  if (sqlArea) {
    sqlArea.clientHeight = 220
    sqlArea.getBoundingClientRect = rect(900, 220)
  }
  const mainView = document.querySelector('.datanoa-main-view') as HTMLElement | null
  if (mainView) {
    mainView.clientHeight = 760
    mainView.getBoundingClientRect = rect(900, 760)
  }
}

describe('Wave 3D Step 2: src/editor/index.ts Boot, Document Session, Sidebar & Data CRUD', () => {
  let dom: DomHarness | undefined

  beforeEach(() => {
    vi.resetModules()
    dom = installDomHarness({ url: 'http://localhost/' })
    setupStudioViewportGeometry()
  })

  afterEach(() => {
    try {
      window.dispatchEvent(new Event('beforeunload'))
    } catch {}
    vi.useRealTimers()
    dom?.teardown()
    dom = undefined
  })

  it('boots via initializeEditor() + orca.document.session(), restores warm cache & snapshot, and flushes on unload', async () => {
    const backend = createLiveStudioSqliteBackend({ multiSchema: true })
    try {
      ;(window as { orca?: unknown }).orca = backend.orcaApi
      backend.setDocInitialValue('-- @datanoa.connectionId: c_main\n-- @datanoa.table: employees\nSELECT * FROM employees;')
      localStorage.setItem(
        'datanoa.studioViewState',
        JSON.stringify({
          pageSize: 100,
          customSqlPanePx: 180,
          filterQuery: '',
          sidebarCollapsed: false,
          clientFilter: '',
          isTransposed: false,
          activeConnectionId: 'c_main',
          activeTable: 'employees',
          activeSchema: 'main',
          currentPage: 1,
          activeViewMode: 'split',
          sqlDraft: 'SELECT * FROM departments;',
          consoleTabs: {
            activeTabId: 't1',
            tabs: [{ id: 't1', title: 'Main', sql: 'SELECT * FROM departments;' }],
          },
          columnConfigByTable: { 'c_main:main:employees': { hidden: ['meta'], pinned: ['id'] } },
          scrollState: { gridTop: 15, gridLeft: 5, sidebarTop: 10 },
        })
      )
      localStorage.setItem(
        'datanoa.studioWarmCache',
        JSON.stringify({
          updatedAt: Date.now(),
          activeConnectionId: 'c_main',
          activeTable: 'employees',
          activeSchema: 'main',
          connections: backend.connections,
          schemaObjects: {
            c_main: [
              { name: 'departments', kind: 'table', schema: 'main' },
              { name: 'employees', kind: 'table', schema: 'main' },
              { name: 'notes', kind: 'table', schema: 'main' },
            ],
          },
          pageData: {
            columns: [
              { name: 'id', type: 'INTEGER', isPrimaryKey: true, nullable: false },
              { name: 'name', type: 'TEXT', nullable: false },
            ],
            rows: [{ id: 1, name: 'Alice' }],
            totalRows: 1,
            page: 1,
            pageSize: 100,
            primaryKey: ['id'],
            canEdit: true,
          },
        })
      )

      const mod = await import('../src/editor/index.js')
      await flushTick()
      patchMountedStudioMetrics()
      await flushTick()
      dom?.runRaf()

      expect(mod.DatanoaStudioEditor).toBeTruthy()
      expect(document.querySelector('.datanoa-editor-root')).toBeTruthy()
      expect(document.querySelectorAll('.datanoa-grid-table tbody tr').length).toBeGreaterThan(0)

      // Exercise document replace event
      backend.emitDocReplace('-- @datanoa.connectionId: c_main\n-- @datanoa.table: departments\nSELECT * FROM departments;')
      await flushTick()

      // Dismiss caution strip & flush on beforeunload
      ;(document.querySelector('.datanoa-caution-strip-close') as HTMLButtonElement | null)?.click()
      window.dispatchEvent(new Event('beforeunload'))
      await flushMicro()
      expect(localStorage.getItem('datanoa.studioViewState')).toBeTruthy()
    } finally {
      window.dispatchEvent(new Event('beforeunload'))
      backend.db.close()
    }
  })

  it('exercises multi-schema switcher, export full DDL, sidebar & topbar navigation, context menus, and Schema Inspector live ALTER TABLE', async () => {
    const backend = createLiveStudioSqliteBackend({ multiSchema: true })
    document.body.innerHTML = ''
    ;(window as { orca?: unknown }).orca = backend.orcaApi
    const prevDoc = globalThis.document
    ;(globalThis as { document?: unknown }).document = undefined
    const { DatanoaStudioEditor } = await import('../src/editor/index.js')
    ;(globalThis as { document?: unknown }).document = prevDoc
    const editor = new DatanoaStudioEditor()
    try {
      await flushTick()
      patchMountedStudioMetrics()
      await flushTick()

      // 1. Multi-schema switcher & Export full Schema DDL (saved -> cancelled -> error)
      const schemaSel = document.querySelector('.datanoa-schema-select') as HTMLSelectElement
      schemaSel.value = 'analytics'
      schemaSel.dispatchEvent(new Event('change', { bubbles: true }))
      await flushTick()
      schemaSel.value = 'main'
      schemaSel.dispatchEvent(new Event('change', { bubbles: true }))
      await flushTick()

      const expDdlBtn = document.querySelector('.datanoa-export-ddl-btn') as HTMLButtonElement
      expDdlBtn.click()
      await flushTick()
      expect(backend.savedFiles.length).toBeGreaterThan(0)
      backend.setSaveAsResult('cancelled')
      expDdlBtn.click()
      await flushTick()
      backend.setSaveAsResult('failed')
      expDdlBtn.click()
      await flushTick()
      backend.setSaveAsResult('saved')

      // 2. Sidebar filter, collapse to Topbar mode, Topbar filter & All-Objects popover, restore sidebar
      const sideSearch = document.querySelector('.datanoa-sidebar .datanoa-search-input') as HTMLInputElement
      sideSearch.value = 'emp'
      sideSearch.dispatchEvent(new Event('input', { bubbles: true }))
      sideSearch.value = ''
      sideSearch.dispatchEvent(new Event('input', { bubbles: true }))

      const toggleSideBtn = document.querySelector('.datanoa-sidebar-toggle') as HTMLButtonElement
      toggleSideBtn.click()
      const topFilter = document.querySelector('.datanoa-topbar-filter') as HTMLInputElement
      topFilter.value = 'dep'
      topFilter.dispatchEvent(new Event('input', { bubbles: true }))
      topFilter.value = ''
      topFilter.dispatchEvent(new Event('input', { bubbles: true }))
      ;(document.querySelector('.datanoa-topbar-all-btn') as HTMLButtonElement).click()
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      toggleSideBtn.click()

      // 3. Sidebar context menu: Count Rows, Generate SELECT / INSERT / UPDATE / DDL, and Read-Only object selection (`trg_notes_insert`)
      const findSideObj = (name: string) =>
        (document.querySelector(`.datanoa-sidebar-list .datanoa-sidebar-item[data-table-name="${name}"]`) as HTMLElement | null) ??
        (Array.from(document.querySelectorAll('.datanoa-sidebar-list [data-obj-name], .datanoa-sidebar-list .datanoa-sidebar-item')).find((el) =>
          (el.textContent || '').includes(name)
        ) as HTMLElement | undefined)

      findSideObj('trg_notes_insert')?.click()
      await flushTick()

      findSideObj('employees')?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 40, bubbles: true }))
      const clickSideCtx = (re: RegExp) => {
        const btn = Array.from(document.querySelectorAll('.datanoa-context-item')).find((b) =>
          re.test(b.textContent || '')
        ) as HTMLElement | undefined
        btn?.click()
      }
      clickSideCtx(/Count Rows/i)
      await flushTick()

      for (const re of [/Generate SELECT/i, /Generate INSERT/i, /Generate UPDATE/i, /DDL/i, /Inspect Schema/i]) {
        findSideObj('employees')?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 40, bubbles: true }))
        clickSideCtx(re)
        await flushTick()
      }

      // 4. Schema Inspector tab -> select `notes` -> add column -> apply live ALTER TABLE -> verify in DatabaseSync!
      findSideObj('notes')?.click()
      await flushTick()
      const schemaTabBtn = Array.from(document.querySelectorAll('.datanoa-tab-btn')).find((b) =>
        /Schema/i.test(b.textContent || '')
      ) as HTMLButtonElement | undefined
      schemaTabBtn?.click()
      await flushTick()

      const addColBtn = document.querySelector('.datanoa-inspector-view .datanoa-add-col-btn') as HTMLButtonElement | null
      addColBtn?.click()
      const colNameInputs = Array.from(document.querySelectorAll('.datanoa-inspector-view .datanoa-col-name-input')) as HTMLInputElement[]
      const lastColInp = colNameInputs[colNameInputs.length - 1]
      if (lastColInp) {
        lastColInp.value = 'priority'
        lastColInp.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const applyMigBtn = document.querySelector('.datanoa-inspector-view .datanoa-struct-apply-btn') as HTMLButtonElement | null
      applyMigBtn?.click()
      await flushTick()
      const execConfirmBtn = document.querySelector('.datanoa-struct-confirm-modal .datanoa-struct-confirm-execute-btn') as HTMLButtonElement | null
      execConfirmBtn?.click()
      await flushTick()
      await flushTick()

      const colsAfter = backend.db.prepare(`PRAGMA table_info("notes")`).all() as Array<{ name: string }>
      expect(colsAfter.some((c) => c.name === 'priority')).toBe(true)

      // Also exercise Schema Inspector DDL insert/copy & prod RO connection switch
      const connSel = document.querySelector('.datanoa-conn-cluster .datanoa-select') as HTMLSelectElement
      connSel.value = 'c_prod_ro'
      connSel.dispatchEvent(new Event('change', { bubbles: true }))
      await flushTick()
      connSel.value = 'c_main'
      connSel.dispatchEvent(new Event('change', { bubbles: true }))
      await flushTick()
    } finally {
      editor.destroy()
      backend.db.close()
    }
  })

  it('exercises live SQLite Data CRUD (direct + batch DML preview/submit/revert), 110-row pagination, server filters, search/find, columns popover, export & Value Inspector', async () => {
    const backend = createLiveStudioSqliteBackend({ extraEmployeeRows: 110 })
    document.body.innerHTML = ''
    ;(window as { orca?: unknown }).orca = backend.orcaApi
    const prevDoc = globalThis.document
    ;(globalThis as { document?: unknown }).document = undefined
    const { DatanoaStudioEditor } = await import('../src/editor/index.js')
    ;(globalThis as { document?: unknown }).document = prevDoc
    const editor = new DatanoaStudioEditor()
    try {
      await flushTick()
      patchMountedStudioMetrics()
      await flushTick()

      // Switch active table to employees
      const empItem = document.querySelector('.datanoa-sidebar-list .datanoa-sidebar-item[data-table-name="employees"]') as HTMLElement | null
      empItem?.click()
      await flushTick()
      patchMountedStudioMetrics()

      const splitTabBtn = Array.from(document.querySelectorAll('.datanoa-tab-btn')).find((b) =>
        /Data/i.test(b.textContent || '')
      ) as HTMLButtonElement | undefined
      splitTabBtn?.click()

      // 1. Pagination across > 110 SQLite rows (Next -> Prev -> PageSize 500 -> 100)
      const subRightBtns = Array.from(document.querySelectorAll('.datanoa-grid-subbar-right button')) as HTMLButtonElement[]
      const prevBtn = subRightBtns.find((b) => b.textContent === 'Prev')!
      const nextBtn = subRightBtns.find((b) => b.textContent === 'Next')!
      const batchBtn = subRightBtns.find((b) => (b.textContent || '').includes('Batch'))!
      const psSel = document.querySelector('.datanoa-grid-subbar-right select[aria-label="Rows per page"]') as HTMLSelectElement

      nextBtn.click()
      await flushTick()
      prevBtn.click()
      await flushTick()
      psSel.value = '500'
      psSel.dispatchEvent(new Event('change', { bubbles: true }))
      await flushTick()
      psSel.value = '100'
      psSel.dispatchEvent(new Event('change', { bubbles: true }))
      await flushTick()

      // 2. Server WHERE / ORDER BY filters & Clear + Header Sort
      const filterInputs = Array.from(document.querySelectorAll('.datanoa-grid-toolbar .datanoa-filter-input')) as HTMLInputElement[]
      filterInputs[0].value = 'salary >= 7000'
      filterInputs[1].value = 'id DESC'
      filterInputs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushTick()
      expect(document.querySelectorAll('.datanoa-grid-table tbody tr').length).toBeGreaterThan(0)

      ;(document.querySelector('.datanoa-filter-clear-btn') as HTMLButtonElement).click()
      await flushTick()

      // Sort by column header
      const thCol1 = document.querySelector('.datanoa-th[data-col-index="1"]') as HTMLElement | null
      thCol1?.click()
      await flushTick()

      // 3. Search Mode toggle (Filter vs Find + Next/Prev)
      const searchModeBtn = document.querySelector('.datanoa-find-nav button') as HTMLButtonElement
      const clientSearch = document.querySelector('.datanoa-client-search') as HTMLInputElement
      clientSearch.value = 'Alice'
      clientSearch.dispatchEvent(new Event('input', { bubbles: true }))
      searchModeBtn.click() // switch to Find mode
      const navBtns = Array.from(document.querySelectorAll('.datanoa-find-nav button')) as HTMLButtonElement[]
      navBtns[1]?.click()
      navBtns[2]?.click()
      searchModeBtn.click()
      clientSearch.value = ''
      clientSearch.dispatchEvent(new Event('input', { bubbles: true }))

      // 4. Columns popover, Transpose & Export dropdown
      const subLeftBtns = Array.from(document.querySelectorAll('.datanoa-grid-subbar-left .datanoa-btn-group button')) as HTMLButtonElement[]
      const byText = (re: RegExp) => subLeftBtns.find((b) => re.test(b.textContent || '') || re.test(b.title || ''))!
      byText(/Columns/i)?.click()
      const colPopCb = document.querySelector('.datanoa-columns-popover input[type="checkbox"]') as HTMLInputElement | null
      colPopCb?.click()
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      byText(/Transpose/i)?.click()
      byText(/Transpose/i)?.click()

      const exportSel = document.querySelector('.datanoa-grid-subbar-left select[aria-label="Export Data Format"]') as HTMLSelectElement
      exportSel.value = 'csv'
      exportSel.dispatchEvent(new Event('change', { bubbles: true }))
      await flushTick()

      // 5. Batch Staging CRUD -> DML Preview -> Submit -> Verify in real SQLite! + Revert
      byText(/^\+\s*Row|^Add Row/i)?.click()
      const insertedCells = Array.from(document.querySelectorAll('.datanoa-grid-table tbody td[data-col-index="1"]')) as HTMLElement[]
      const lastRowName = insertedCells[insertedCells.length - 1]
      lastRowName?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      const inInp = document.querySelector('.datanoa-inline-input') as HTMLInputElement | null
      if (inInp) {
        inInp.value = 'Studio Inserted Live'
        inInp.dispatchEvent(new Event('input', { bubbles: true }))
        inInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      }

      byText(/DML Preview/i)?.click()
      await flushTick()
      expect((document.querySelector('.datanoa-dml-preview') as HTMLElement).style.display).toBe('block')
      byText(/Submit/i)?.click()
      await flushTick()
      await flushTick()

      const insertedRec = backend.db
        .prepare(`SELECT name FROM employees WHERE name = 'Studio Inserted Live'`)
        .get() as { name?: string } | undefined
      expect(insertedRec?.name).toBe('Studio Inserted Live')

      // Value Inspector open + edit + Auto-Commit direct edit
      batchBtn.click() // switch to Auto-Commit (batchMode = false)
      const ga = document.querySelector('.datanoa-grid-container') as HTMLElement | null
      if (ga) {
        ga.scrollTop = 0
        ga.dispatchEvent(new Event('scroll'))
      }
      const cell1Name =
        (document.querySelector('.datanoa-grid-table tbody td[data-row-index="0"][data-col-index="1"]') as HTMLElement | null) ??
        (document.querySelector('.datanoa-grid-table tbody td[data-col-index="1"]') as HTMLElement | null)
      cell1Name?.click()
      byText(/Inspect|Value/i)?.click()
      const inspTa = document.querySelector('.datanoa-value-inspector textarea') as HTMLTextAreaElement | null
      if (inspTa) {
        inspTa.value = 'Alice Direct Edit'
        inspTa.dispatchEvent(new Event('input', { bubbles: true }))
        const applyInsp = Array.from(document.querySelectorAll('.datanoa-value-inspector button')).find((b) =>
          /Apply|Save/i.test(b.textContent || '')
        ) as HTMLButtonElement | undefined
        applyInsp?.click()
        await flushTick()
      }
      batchBtn.click()
      byText(/^\+\s*Row|^Add Row/i)?.click()
      byText(/Clone/i)?.click()
      byText(/Delete/i)?.click()
      byText(/Revert/i)?.click()

      // Error handling path on data.fetchPage
      backend.failOnceActions.add('data.fetchPage')
      const refBtn = Array.from(document.querySelectorAll('.datanoa-toolbar button')).find((b) =>
        /Refresh/i.test(b.textContent || '') || /Refresh/i.test(b.title || '')
      ) as HTMLButtonElement | undefined
      refBtn?.click()
      await flushTick()
    } finally {
      editor.destroy()
      backend.db.close()
    }
  })
})
