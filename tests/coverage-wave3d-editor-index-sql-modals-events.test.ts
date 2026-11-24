import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installDomHarness, type DomHarness } from './helpers/dom-harness.js'
import { createLiveStudioSqliteBackend, flushMicro, flushTick } from './helpers/live-studio-sqlite.js'

function setupStudioViewportGeometry(): void {
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

function patchMountedStudioMetrics(): void {
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

function findBtn(root: ParentNode, re: RegExp): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll('button')).find((b) =>
    re.test(b.textContent || '') || re.test(b.title || '') || re.test(b.getAttribute('aria-label') || '')
  ) as HTMLButtonElement | undefined
}

function createFakeCsvFile(name: string, content: string): File {
  const bytes = new TextEncoder().encode(content)
  return {
    name,
    size: bytes.byteLength,
    type: 'text/csv',
    lastModified: Date.now(),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => content,
    slice: () => new Blob([bytes]),
    stream: () => new Blob([bytes]).stream(),
  } as unknown as File
}

async function createIsolatedStudioEditor(orcaApi: unknown) {
  document.body.innerHTML = ''
  ;(window as { orca?: unknown }).orca = orcaApi
  const prevDoc = globalThis.document
  ;(globalThis as { document?: unknown }).document = undefined
  const { DatanoaStudioEditor } = await import('../src/editor/index.js')
  ;(globalThis as { document?: unknown }).document = prevDoc
  return new DatanoaStudioEditor()
}

describe('Wave 3D Step 3: src/editor/index.ts SQL Console, Modals, Command Palette & Events', () => {
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

  it('exercises Split Resizer, Console Tabs, Multi-Stmt Editable SQLite Results, Bind Params, Danger SQL, Cancel, EXPLAIN + AI, History & TX Toolbar', async () => {
    const backend = createLiveStudioSqliteBackend({ multiSchema: true })
    const editor = await createIsolatedStudioEditor(backend.orcaApi)
    try {
      await flushTick()
      patchMountedStudioMetrics()
      await flushTick()

      expect(editor.getSqlConsole()).toBeTruthy()
      expect(editor.getDataGrid()).toBeTruthy()
      expect(editor.getSchemaInspector()).toBeTruthy()

      // Select employees first so tableDetailsCache caches PK + FK metadata for editable SELECT
      const empItem = document.querySelector('.datanoa-sidebar-list .datanoa-sidebar-item[data-table-name="employees"]') as HTMLElement | null
      empItem?.click()
      await flushTick()
      patchMountedStudioMetrics()

      // 1. Split resizer drag + window resize/focus/visibilitychange + mode tabs
      findBtn(document.querySelector('.datanoa-tabs')!, /SQL Console/i)?.click()
      findBtn(document.querySelector('.datanoa-tabs')!, /Data Grid/i)?.click()
      findBtn(document.querySelector('.datanoa-tabs')!, /Split View/i)?.click()
      patchMountedStudioMetrics()

      const resizer = document.querySelector('.datanoa-split-resizer') as HTMLElement
      resizer.dispatchEvent(new MouseEvent('mousedown', { clientY: 220, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientY: 280, bubbles: true }))
      dom?.runRaf()
      window.dispatchEvent(new MouseEvent('mouseup', { clientY: 280, bubbles: true }))
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))

      // Topbar wheel/scroll nav
      const topTrack = document.querySelector('.datanoa-table-topbar-track') as HTMLElement
      topTrack.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }))
      findBtn(document.querySelector('.datanoa-table-topbar')!, /Scroll tables right/i)?.click()
      findBtn(document.querySelector('.datanoa-table-topbar')!, /Scroll tables left/i)?.click()

      // 2. Console Tabs: add, dblclick rename, F2 Escape rename, switch, close
      ;(document.querySelector('.datanoa-console-tab-add') as HTMLButtonElement).click()
      const tabs = () => Array.from(document.querySelectorAll('.datanoa-console-tab')) as HTMLElement[]
      expect(tabs().length).toBe(2)

      const tab2Title = tabs()[1].querySelector('.datanoa-console-tab-title') as HTMLElement
      tab2Title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      const renameInp1 = document.querySelector('.datanoa-console-tab-rename') as HTMLInputElement
      renameInp1.value = 'Analytics Tab'
      renameInp1.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      expect(tabs()[1].title).toBe('Analytics Tab')

      tabs()[0].click()
      tabs()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
      const renameInp2 = document.querySelector('.datanoa-console-tab-rename') as HTMLInputElement | null
      renameInp2?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

      tabs()[0].click()
      const sqlConsole = editor.getSqlConsole()!

      // 3. Format SQL & Empty SQL guard
      sqlConsole.setText('')
      const execBtn = findBtn(document.querySelector('.datanoa-sql-toolbar')!, /^Execute \(Ctrl\+Enter\)/i)!
      const execAllBtn = findBtn(document.querySelector('.datanoa-sql-toolbar')!, /^Execute All$/i)!
      const explainBtn = findBtn(document.querySelector('.datanoa-sql-toolbar')!, /^Explain$/i)!
      const formatBtn = findBtn(document.querySelector('.datanoa-sql-toolbar')!, /^Format SQL$/i)!
      execBtn.click()
      formatBtn.click()

      sqlConsole.setText('select id, name from employees')
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', shiftKey: true, altKey: true, bubbles: true }))
      formatBtn.click()

      // 4. Bind Params Modal
      sqlConsole.setText('SELECT * FROM employees WHERE id = :emp_id;')
      execBtn.click()
      await flushTick()
      const bindInput = document.querySelector('.datanoa-modal-backdrop input') as HTMLInputElement | null
      if (bindInput) {
        bindInput.value = '1'
        bindInput.dispatchEvent(new Event('input', { bubbles: true }))
      }
      findBtn(document.querySelector('.datanoa-modal-backdrop')!, /Run Query/i)?.click()
      await flushTick()
      expect(document.querySelectorAll('.datanoa-grid-table tbody tr').length).toBeGreaterThan(0)

      // 5. Danger SQL Modal (DELETE without WHERE -> Cancel -> Execute Anyway)
      sqlConsole.setText('DELETE FROM notes;')
      execBtn.click()
      await flushTick()
      ;(document.querySelector('.datanoa-danger-modal .datanoa-danger-cancel-btn') as HTMLButtonElement | null)?.click()
      execBtn.click()
      await flushTick()
      const dangerChk = document.querySelector('.datanoa-danger-modal .datanoa-danger-confirm-check') as HTMLInputElement | null
      if (dangerChk) {
        dangerChk.checked = true
        dangerChk.dispatchEvent(new Event('change', { bubbles: true }))
      }
      ;(document.querySelector('.datanoa-danger-modal .datanoa-danger-execute-btn') as HTMLButtonElement | null)?.click()
      await flushTick()
      expect((backend.db.prepare('SELECT COUNT(*) AS c FROM notes').get() as { c: number }).c).toBe(0)

      // 6. Cancel Active Query
      backend.deferNextQuery()
      sqlConsole.setText('SELECT * FROM employees;')
      execBtn.click()
      await flushMicro(4)
      const cancelQBtn = findBtn(document.querySelector('.datanoa-sql-toolbar')!, /^Cancel$/i)!
      cancelQBtn.click()
      backend.resolveDeferredQuery()
      await flushTick()

      // 7. Single-statement Query Error Banner -> Copy, Report, Retry, Back, Dismiss
      sqlConsole.setText('SELECT nonexistent_col FROM missing_table;')
      execBtn.click()
      await flushTick()
      const errBanner = document.querySelector('.datanoa-query-banner') as HTMLElement
      expect(errBanner.className).toContain('error')
      findBtn(errBanner, /Copy/i)?.click()
      findBtn(errBanner, /Report/i)?.click()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      findBtn(errBanner, /Retry/i)?.click()
      await flushTick()
      findBtn(errBanner, /Dismiss|Close|×/i)?.click()

      // 8. Multi-statement live SQLite script + Result Sets switching + Editable SELECT + Filter & FK
      sqlConsole.setText(
        "SELECT id, name, dept_id, salary FROM employees ORDER BY id; INSERT INTO notes (note) VALUES ('from_sql'); SELECT bad_col FROM missing_tbl;"
      )
      execAllBtn.click()
      await flushTick()

      const insertedNote = backend.db.prepare(`SELECT note FROM notes WHERE note = 'from_sql'`).get() as { note?: string } | undefined
      expect(insertedNote?.note).toBe('from_sql')

      const rsBtns = () => Array.from(document.querySelectorAll('.datanoa-result-sets-bar .datanoa-result-set-btn')) as HTMLButtonElement[]
      expect(rsBtns().length).toBe(3)
      rsBtns()[1].click()
      rsBtns()[2].click()
      rsBtns()[0].click()

      // Inline edit inside editable SELECT Result Set 1 -> Submit -> check live SQLite DB
      const sqlGridCell = document.querySelector('.datanoa-grid-table tbody td[data-col-index="1"]') as HTMLElement | null
      sqlGridCell?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      const sqlInlineInp = document.querySelector('.datanoa-inline-input') as HTMLInputElement | null
      if (sqlInlineInp) {
        sqlInlineInp.value = 'Alice SQL Edited'
        sqlInlineInp.dispatchEvent(new Event('input', { bubbles: true }))
        sqlInlineInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      }
      findBtn(document.querySelector('.datanoa-grid-subbar-left')!, /^Submit/i)?.click()
      await flushTick()
      const editedRow = backend.db.prepare(`SELECT name FROM employees WHERE id = 1`).get() as { name?: string } | undefined
      expect(editedRow?.name).toBe('Alice SQL Edited')

      // Context menu Quick Filter on SQL result, Header column filter popover (.datanoa-col-filter-popover), Pin/Hide Column
      const salCell = document.querySelector('.datanoa-grid-table tbody td[data-col-index="3"]') as HTMLElement | null
      salCell?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 50, clientY: 50, bubbles: true }))
      const quickFilterBtn = Array.from(document.querySelectorAll('.datanoa-context-item')).find((b) =>
        /^Filter:\s/i.test(b.textContent || '')
      ) as HTMLElement | undefined
      quickFilterBtn?.click()

      const colFilterBtn = document.querySelector('.datanoa-th[data-col-index="1"] .datanoa-th-filter-btn') as HTMLButtonElement | null
      colFilterBtn?.click()
      const hdrInp = document.querySelector('.datanoa-col-filter-popover .datanoa-col-filter-input') as HTMLInputElement | null
      if (hdrInp) {
        hdrInp.value = 'Alice'
        hdrInp.dispatchEvent(new Event('input', { bubbles: true }))
        findBtn(document.querySelector('.datanoa-col-filter-popover')!, /Filter Loaded|Client|Apply/i)?.click()
        await flushTick()
      }
      colFilterBtn?.click()
      const hdrInp2 = document.querySelector('.datanoa-col-filter-popover .datanoa-col-filter-input') as HTMLInputElement | null
      if (hdrInp2) {
        hdrInp2.value = 'Alice'
        findBtn(document.querySelector('.datanoa-col-filter-popover')!, /Query/i)?.click()
        await flushTick()
      }
      const th1 = document.querySelector('.datanoa-th[data-col-index="1"]') as HTMLElement | null
      th1?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 60, clientY: 20, bubbles: true }))
      ;(Array.from(document.querySelectorAll('.datanoa-context-item')).find((b) => /Pin Column/i.test(b.textContent || '')) as HTMLElement | undefined)?.click()

      // 9. EXPLAIN + AI Explain (error -> AI Settings, then Retry -> Copy DDL / Copy / Apply / New Tab / Collapse / Expand)
      sqlConsole.setText('SELECT * FROM employees WHERE dept_id = 1;')
      backend.failOnceActions.add('ai.explainAnalyze')
      explainBtn.click()
      await flushTick()
      const explainPanel = document.querySelector('.datanoa-ai-explain-panel, .datanoa-explain-ai') as HTMLElement
      expect(explainPanel).toBeTruthy()
      expect(explainPanel.hidden).toBe(false)

      findBtn(explainPanel, /Analyze with AI/i)?.click()
      await flushTick()
      findBtn(explainPanel, /^AI Settings$/i)?.click()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      findBtn(explainPanel, /Retry/i)?.click()
      await flushTick()
      expect(explainPanel.textContent).toContain('Add index on dept_id')

      findBtn(explainPanel, /^Copy DDL$/i)?.click()
      findBtn(explainPanel, /^Copy$/i)?.click()
      findBtn(explainPanel, /^Collapse$/i)?.click()
      findBtn(explainPanel, /^Expand$/i)?.click()
      findBtn(explainPanel, /^Apply$/i)?.click()
      findBtn(explainPanel, /^New Tab$/i)?.click()
      findBtn(explainPanel, /Auto lang/i)?.click()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

      // Close extra tab created by AI "New Tab" + test closeConsoleTab
      const closeTabBtn = document.querySelectorAll('.datanoa-console-tab-close')[1] as HTMLButtonElement | undefined
      closeTabBtn?.click()

      // Multi-statement EXPLAIN with one invalid statement
      sqlConsole.setText('SELECT * FROM employees; SELECT bad FROM nope;')
      explainBtn.click()
      await flushTick()

      // Danger SQL inside ExplainSql + Banner "Back to table" + FK badge navigation + Direct Cell Edit + Edit Cell button
      sqlConsole.setText('DELETE FROM notes;')
      explainBtn.click()
      await flushTick()
      ;(document.querySelector('.datanoa-danger-modal .datanoa-danger-cancel-btn') as HTMLButtonElement | null)?.click()

      findBtn(document.querySelector('.datanoa-query-banner')!, /Back to/i)?.click()
      await flushTick()
      const fkBtn = document.querySelector('.datanoa-grid-table tbody .datanoa-fk-badge') as HTMLElement | null
      fkBtn?.click()
      await flushTick()

      // Switch back to employees, QuickFilter, Direct Auto-Commit edit & Edit Cell button
      document.querySelector('.datanoa-sidebar-list .datanoa-sidebar-item[data-table-name="employees"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushTick()
      const empCell1 = document.querySelector('.datanoa-grid-table tbody td[data-col-index="1"]') as HTMLElement | null
      empCell1?.click()
      findBtn(document.querySelector('.datanoa-grid-subbar-left')!, /^Edit Cell$/i)?.click()
      ;(document.querySelector('.datanoa-grid-subbar-right button[title*="Commit"], .datanoa-grid-subbar-right button:nth-child(4)') as HTMLButtonElement | null)?.click()
      const autoBatchBtn = Array.from(document.querySelectorAll('.datanoa-grid-subbar-right button')).find((b) =>
        /Batch|Auto/i.test(b.textContent || '')
      ) as HTMLButtonElement | undefined
      autoBatchBtn?.click()
      empCell1?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      const directInp = document.querySelector('.datanoa-inline-input') as HTMLInputElement | null
      if (directInp) {
        directInp.value = 'Alice Direct Studio'
        directInp.dispatchEvent(new Event('input', { bubbles: true }))
        directInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        await flushTick()
      }

      // 10. Query History Drawer: open, search, click SQL, Copy, Insert, Clear, Close
      findBtn(document.querySelector('.datanoa-sql-toolbar')!, /^Query History$/i)?.click()
      await flushTick()
      const histSearch = document.querySelector('.datanoa-history-search') as HTMLInputElement
      histSearch.value = 'employees'
      histSearch.dispatchEvent(new Event('input', { bubbles: true }))
      histSearch.value = ''
      histSearch.dispatchEvent(new Event('input', { bubbles: true }))
      const histRow = document.querySelector('.datanoa-history-row')
      if (histRow) {
        ;(histRow.querySelector('.datanoa-history-sql') as HTMLElement | null)?.click()
        findBtn(histRow, /^Copy$/i)?.click()
        findBtn(histRow, /^Insert$/i)?.click()
      }
      findBtn(document.querySelector('.datanoa-history-drawer')!, /^Clear$/i)?.click()
      await flushTick()
      findBtn(document.querySelector('.datanoa-history-drawer')!, /^Close$/i)?.click()

      // SQL Console DDL statement triggers refreshSchemaObjectsOnly
      sqlConsole.setText('CREATE TABLE ddl_hook_tbl (id INTEGER PRIMARY KEY);')
      execBtn.click()
      await flushTick()

      // 11. TX Toolbar: expand tray, toggle manual autoCommit, BEGIN, COMMIT, BEGIN, ROLLBACK
      ;(document.querySelector('.datanoa-tx-toggle-btn') as HTMLButtonElement).click()
      ;(document.querySelector('.datanoa-tx-autocommit-btn') as HTMLButtonElement).click()
      await flushTick()
      ;(document.querySelector('.datanoa-tx-begin-btn') as HTMLButtonElement).click()
      await flushTick()
      ;(document.querySelector('.datanoa-tx-commit-btn') as HTMLButtonElement).click()
      await flushTick()
      ;(document.querySelector('.datanoa-tx-begin-btn') as HTMLButtonElement).click()
      await flushTick()
      ;(document.querySelector('.datanoa-tx-rollback-btn') as HTMLButtonElement).click()
      await flushTick()

      // 12. Direct handleAlterTable live SQLite (addColumn + validation error + RO guard)
      await editor.handleAlterTable({
        kind: 'addColumn',
        table: 'notes',
        columnName: 'author',
        dataType: 'TEXT',
        nullable: true,
      })
      const noteCols = backend.db.prepare('PRAGMA table_info("notes")').all() as Array<{ name: string }>
      expect(noteCols.some((c) => c.name === 'author')).toBe(true)
      await editor.handleAlterTable({ kind: 'renameColumn', table: '', oldColumnName: '', newColumnName: '' })
    } finally {
      editor.destroy()
      backend.db.close()
    }
  })

  it('exercises Connection, Create Table, Import Data, Danger Table, Saved Queries, Command Palette, Feedback, AI Settings & host/plugin events', async () => {
    const backend = createLiveStudioSqliteBackend({ multiSchema: true })
    const editor = await createIsolatedStudioEditor(backend.orcaApi)
    try {
      await flushTick()
      patchMountedStudioMetrics()
      await flushTick()

      // 1. Connection Modal (+ Connect -> Parse URI -> Test -> Save & Connect; Edit -> Delete)
      ;(document.querySelector('.datanoa-add-conn-btn') as HTMLButtonElement).click()
      await flushTick()
      const connModal = document.querySelector('.datanoa-conn-modal') as HTMLElement
      const uriInp = connModal.querySelector('.datanoa-conn-uri-bar .datanoa-conn-input') as HTMLInputElement
      uriInp.value = 'sqlite://:memory:'
      findBtn(connModal, /Parse URI/i)?.click()
      await flushTick()
      const nameInp = connModal.querySelector('.datanoa-conn-fields .datanoa-conn-input') as HTMLInputElement | null
      if (nameInp) {
        nameInp.value = 'Added Studio SQLite'
        nameInp.dispatchEvent(new Event('input', { bubbles: true }))
      }
      findBtn(connModal, /Test Connection/i)?.click()
      await flushTick()
      findBtn(connModal, /Save & Connect/i)?.click()
      await flushTick()
      expect(backend.connections.some((c) => c.name === 'Added Studio SQLite')).toBe(true)

      // Open Edit Connection -> arm Delete twice -> deleted -> falls back cleanly
      ;(document.querySelector('.datanoa-edit-conn-btn') as HTMLButtonElement).click()
      await flushTick()
      const editModal = document.querySelector('.datanoa-conn-modal') as HTMLElement
      findBtn(editModal, /Delete Connection/i)?.click()
      findBtn(editModal, /Confirm Delete/i)?.click()
      await flushTick()
      expect(backend.connections.some((c) => c.name === 'Added Studio SQLite')).toBe(false)

      // Switch back to c_main cleanly
      const connSel = document.querySelector('.datanoa-conn-cluster .datanoa-select') as HTMLSelectElement
      connSel.value = 'c_main'
      connSel.dispatchEvent(new Event('change', { bubbles: true }))
      await flushTick()

      // 2. Create Table Modal -> verify audit_logs exists in real DatabaseSync
      const newTblBtn = findBtn(document.querySelector('.datanoa-sidebar')!, /\+ New Table/i)!
      newTblBtn.click()
      const ctModal = document.querySelector('.datanoa-create-table-modal') as HTMLElement
      const ctName = ctModal.querySelector('.datanoa-filter-input') as HTMLInputElement
      ctName.value = 'audit_logs'
      ctName.dispatchEvent(new Event('input', { bubbles: true }))
      const colNameInp = ctModal.querySelector('.datanoa-struct-cell-input') as HTMLInputElement | null
      if (colNameInp && !colNameInp.value) {
        colNameInp.value = 'id'
        colNameInp.dispatchEvent(new Event('input', { bubbles: true }))
      }
      findBtn(ctModal, /^Create Table$/i)?.click()
      await flushTick()
      const createdMaster = backend.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_logs'`)
        .get() as { name?: string } | undefined
      expect(createdMaster?.name).toBe('audit_logs')

      // 3. Sidebar DDL actions, Sidebar scroll/group collapse, Topbar Popover interactions, Stage Import + Direct Import
      ;(document.querySelector('.datanoa-sidebar-list') as HTMLElement).dispatchEvent(new Event('scroll'))
      ;(document.querySelector('.datanoa-sidebar-group-header') as HTMLElement | null)?.click()
      ;(document.querySelector('.datanoa-sidebar-group-header') as HTMLElement | null)?.click()

      const notesSide = document.querySelector('.datanoa-sidebar-list .datanoa-sidebar-item[data-table-name="notes"]') as HTMLElement | null
      notesSide?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 30, clientY: 30, bubbles: true }))
      ;(Array.from(document.querySelectorAll('.datanoa-context-item')).find((b) => /^Copy DDL$/i.test(b.textContent || '')) as HTMLElement | undefined)?.click()
      await flushTick()
      notesSide?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 30, clientY: 30, bubbles: true }))
      ;(Array.from(document.querySelectorAll('.datanoa-context-item')).find((b) => /Open DDL in Console/i.test(b.textContent || '')) as HTMLElement | undefined)?.click()
      await flushTick()

      // Collapsed Topbar Popover click + context menu
      ;(document.querySelector('.datanoa-sidebar-toggle') as HTMLButtonElement).click()
      ;(document.querySelector('.datanoa-topbar-all-btn') as HTMLButtonElement).click()
      const popItem = document.querySelector('.datanoa-topbar-popover-item') as HTMLElement | null
      popItem?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      popItem?.click()
      await flushTick()
      ;(document.querySelector('.datanoa-sidebar-toggle') as HTMLButtonElement).click()

      notesSide?.click()
      await flushTick()
      // Schema Inspector wheel scroll + DDL/Danger buttons
      findBtn(document.querySelector('.datanoa-tabs')!, /Schema/i)?.click()
      await flushTick()
      const inspEl = document.querySelector('.datanoa-inspector-view') as HTMLElement
      inspEl.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }))
      findBtn(inspEl, /^Copy DDL$/i)?.click()
      findBtn(inspEl, /Insert DDL/i)?.click()
      findBtn(inspEl, /Open in Console/i)?.click()
      findBtn(document.querySelector('.datanoa-tabs')!, /Data Grid/i)?.click()

      // Import Data Modal: Stage Rows first, then Direct Import into SQLite
      ;(document.querySelector('.datanoa-import-btn') as HTMLButtonElement).click()
      await flushTick()
      const impStageModal = document.querySelector('.datanoa-import-modal') as HTMLElement
      const stageFileInp = impStageModal.querySelector('.datanoa-import-file-input') as HTMLInputElement
      Object.defineProperty(stageFileInp, 'files', {
        value: [createFakeCsvFile('stage.csv', 'note\nstaged_row_1')],
        configurable: true,
      })
      stageFileInp.dispatchEvent(new Event('change', { bubbles: true }))
      await flushTick()
      const stageRadio = impStageModal.querySelector('input[type="radio"]') as HTMLInputElement | null
      if (stageRadio) {
        stageRadio.checked = true
        stageRadio.dispatchEvent(new Event('change', { bubbles: true }))
      }
      findBtn(impStageModal, /Import|Stage/i)?.click()
      await flushTick()
      findBtn(document.querySelector('.datanoa-grid-subbar-left')!, /^Revert$/i)?.click()

      ;(document.querySelector('.datanoa-import-btn') as HTMLButtonElement).click()
      await flushTick()
      const impModal = document.querySelector('.datanoa-import-modal') as HTMLElement
      const fileInput = impModal.querySelector('.datanoa-import-file-input') as HTMLInputElement
      Object.defineProperty(fileInput, 'files', {
        value: [createFakeCsvFile('notes.csv', 'note\nimported_row_1\nimported_row_2')],
        configurable: true,
      })
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
      await flushTick()

      findBtn(impModal, /^Auto-Map$/i)?.click()
      const directRadio = Array.from(impModal.querySelectorAll('input[type="radio"]')).pop() as HTMLInputElement | undefined
      if (directRadio) {
        directRadio.checked = true
        directRadio.dispatchEvent(new Event('change', { bubbles: true }))
      }
      findBtn(impModal, /Import/i)?.click()
      await flushTick()
      await flushTick()
      const impCheck = backend.db
        .prepare(`SELECT COUNT(*) AS c FROM notes WHERE note IN ('imported_row_1', 'imported_row_2')`)
        .get() as { c: number }
      expect(impCheck.c).toBe(2)

      // 4. Danger Table Modal (Truncate -> Drop `audit_logs` via sidebar context menu)
      backend.db.exec(`INSERT INTO audit_logs (name) VALUES ('entry_1');`)
      const findSideAudit = () =>
        document.querySelector('.datanoa-sidebar-list .datanoa-sidebar-item[data-table-name="audit_logs"]') as HTMLElement | null

      findSideAudit()?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 40, bubbles: true }))
      ;(Array.from(document.querySelectorAll('.datanoa-context-item')).find((b) =>
        /Truncate Table/i.test(b.textContent || '')
      ) as HTMLElement | undefined)?.click()
      const truncInp = document.querySelector('#datanoa-danger-table-confirm-input') as HTMLInputElement
      truncInp.value = 'audit_logs'
      truncInp.dispatchEvent(new Event('input', { bubbles: true }))
      findBtn(document.querySelector('.datanoa-danger-modal')!, /Truncate Table/i)?.click()
      await flushTick()
      expect((backend.db.prepare('SELECT COUNT(*) AS c FROM audit_logs').get() as { c: number }).c).toBe(0)

      findSideAudit()?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 40, bubbles: true }))
      ;(Array.from(document.querySelectorAll('.datanoa-context-item')).find((b) =>
        /Drop Table/i.test(b.textContent || '')
      ) as HTMLElement | undefined)?.click()
      const dropInp = document.querySelector('#datanoa-danger-table-confirm-input') as HTMLInputElement
      dropInp.value = 'audit_logs'
      dropInp.dispatchEvent(new Event('input', { bubbles: true }))
      findBtn(document.querySelector('.datanoa-danger-modal')!, /Drop Table/i)?.click()
      await flushTick()
      expect(
        backend.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='audit_logs'`).get()
      ).toBeUndefined()

      // 5. Saved Queries Modal
      findBtn(document.querySelector('.datanoa-sql-toolbar')!, /^Saved$/i)?.click()
      await flushTick()
      const sqModal = document.querySelector('.datanoa-saved-queries-modal') as HTMLElement
      const sqInputs = Array.from(sqModal.querySelectorAll('.datanoa-filter-input')) as HTMLInputElement[]
      sqInputs[0].value = 'Emp Sample'
      sqInputs[1].value = 'hr,sample'
      const sqTa = sqModal.querySelector('.datanoa-saved-sql-input') as HTMLTextAreaElement
      sqTa.value = 'SELECT id, name FROM employees;'
      findBtn(sqModal, /Save Query/i)?.click()
      await flushTick()
      findBtn(sqModal, /^Load$/i)?.click()
      findBtn(document.querySelector('.datanoa-sql-toolbar')!, /^Saved$/i)?.click()
      await flushTick()
      const sqModal2 = document.querySelector('.datanoa-saved-queries-modal') as HTMLElement
      findBtn(sqModal2, /^Edit$/i)?.click()
      findBtn(sqModal2, /^New Tab$/i)?.click()

      // 6. Command Palette (`Ctrl+K` across multiple command actions), Shortcuts Modal (`Ctrl+/`), Feedback Modal, AI Settings Modal
      for (const term of ['Shortcuts', 'Format SQL', 'Query History', 'Toggle Sidebar', 'Toggle Sidebar', 'Export Full Schema DDL']) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
        const cmdInp = document.querySelector('.datanoa-cmd-palette-input') as HTMLInputElement
        cmdInp.value = term
        cmdInp.dispatchEvent(new Event('input', { bubbles: true }))
        ;(document.querySelector('.datanoa-cmd-palette-item') as HTMLElement | null)?.click()
        await flushTick()
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      }

      ;(document.querySelector('.datanoa-ai-toolbar-btn') as HTMLButtonElement).click()
      await flushTick()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

      editor.openFeedbackModal('feature')
      const fbModal = document.querySelector('.datanoa-feedback-modal') as HTMLElement
      ;(fbModal.querySelector('.datanoa-feedback-title-input') as HTMLInputElement).value = 'Live test issue'
      ;(fbModal.querySelector('.datanoa-feedback-body-input') as HTMLTextAreaElement).value = 'Details'
      ;(fbModal.querySelector('.datanoa-feedback-copy-btn') as HTMLButtonElement).click()
      document.querySelector('.datanoa-modal-backdrop')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

      // 7. Global shortcuts (Ctrl+F find mode, Ctrl+S staged submit, Ctrl+/)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

      // 8. Host / Plugin / Settings / Storage Events + pagehide
      backend.emitHost('theme', { colorScheme: 'light' })
      backend.emitHost('theme', { colorScheme: 'dark' })
      backend.emitHost('theme', {})
      backend.emitHost('editor.typography.changed', { fontFamily: 'Fira Code', fontSize: 14 })
      backend.emitPlugin('connections.changed')
      backend.emitPlugin('studio.opened', { connectionId: 'c_main' })
      backend.emitPlugin('data.cellUpdated', {
        connectionId: 'c_main',
        table: 'notes',
        schema: 'main',
        primaryKeys: { id: 1 },
        column: 'note',
        newValue: 'RemoteUpdated',
      })
      backend.emitPlugin('ai.status.changed', { enabled: false, state: 'disabled', suggested: 0 })
      backend.emitSettings({ key: 'ai.enabled', value: false })
      backend.emitStorage({ key: 'datanoa.savedConnections' })
      await flushTick()

      window.dispatchEvent(new Event('pagehide'))
    } finally {
      editor.destroy()
      backend.db.close()
    }
  })
})
