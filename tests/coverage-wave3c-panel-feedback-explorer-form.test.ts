import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'
import { installDomHarness, type DomHarness } from './helpers/dom-harness.js'
import { parseConnectionUri } from '../src/drivers/common/connection-uri'
import { createPanelFeedbackAndPaletteController } from '../src/panel/panel-feedback-palette.js'
import {
  getExplorerObjectGroupLabel,
  buildCountQueryForObject,
  generateSqlForTable,
  closeContextMenu,
  createPanelExplorerController,
} from '../src/panel/panel-explorer.js'
import {
  formatConnSubtitle,
  createPanelConnectionFormController,
} from '../src/panel/panel-connection-form.js'

let dom: DomHarness

async function flushMicro(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  dom = installDomHarness()
  dom.mountPanelHtml()
})

afterEach(() => {
  dom.teardown()
})

describe('Wave 3C Step 2: panel-feedback-palette, panel-explorer & panel-connection-form', () => {
  it('covers src/panel/panel-feedback-palette.js feedback, shortcuts & command palette flows', async () => {
    const calls: string[] = []
    let activeConn: Record<string, unknown> | null = { id: 'c1', driver: 'postgres', readOnly: true }
    const state = { tab: 'sql', lastError: 'postgres://user:secretpw@db:5432/app' }

    const openExtSpy = vi
      .fn()
      .mockResolvedValueOnce({ opened: true })
      .mockResolvedValueOnce({ opened: false, reason: 'cancelled' })
      .mockRejectedValueOnce(new Error('blocked'))
    const winOpenSpy = vi.fn().mockReturnValueOnce({}).mockReturnValueOnce(null)
    window.open = winOpenSpy as unknown as typeof window.open
    ;(window as { orca?: unknown }).orca = {
      api: { major: 2, minor: 3 },
      shell: { openExternal: openExtSpy },
    }

    const ctrl = createPanelFeedbackAndPaletteController({
      state,
      getActiveConn: () => activeConn,
      closeContextMenu: () => calls.push('closeCtx'),
      closeDataColsPopover: () => calls.push('closeCols'),
      closePanelComboPopover: () => calls.push('closeCombo'),
      resetConnectionForm: () => calls.push('resetForm'),
      setFormOpen: (v: boolean) => calls.push(`setForm:${v}`),
      openFullStudio: async () => {
        calls.push('openStudio')
      },
      switchTab: (t: string) => {
        state.tab = t
        calls.push(`tab:${t}`)
      },
      formatSqlInEditor: () => calls.push('formatSql'),
      openCreateTableModal: () => calls.push('createTbl'),
      refreshConnections: async () => {
        calls.push('refresh')
      },
      copyText: async (_t: string, msg: string) => {
        calls.push(`copy:${msg}`)
      },
      showBanner: (msg: string, kind: string) => calls.push(`banner:${kind}:${msg}`),
    })

    ctrl.bindEvents()

    // 1. Feedback modal: open via button -> feature/bug toggle -> copy -> GitHub (openExternal / cancelled / window.open / fallback copy) -> backdrop & cancel
    document.getElementById('feedbackBtn')!.click()
    expect((document.getElementById('feedbackModal') as HTMLElement).hidden).toBe(false)
    ;(document.getElementById('feedbackTitleInput') as HTMLInputElement).value = 'Grid freezes'
    ;(document.getElementById('feedbackDescInput') as HTMLInputElement).value = 'Steps to repro'
    document.getElementById('feedbackKindFeatureBtn')!.click()
    expect(document.getElementById('feedbackDescLabel')!.textContent).toContain('Proposed Feature')
    document.getElementById('feedbackKindBugBtn')!.click()
    document.getElementById('feedbackCopyBtn')!.click()
    await flushMicro()
    expect(calls.some((c) => c.startsWith('copy:Diagnostic report'))).toBe(true)

    const ghBtn = document.getElementById('feedbackOpenGithubBtn')!
    ghBtn.click()
    await flushMicro()
    ghBtn.click()
    await flushMicro()
    ghBtn.click()
    await flushMicro()
    ghBtn.click()
    await flushMicro()
    expect(calls.some((c) => c.startsWith('banner:success:Opened GitHub'))).toBe(true)
    expect(calls.some((c) => c.startsWith('copy:Report copied'))).toBe(true)

    // Exercise Orca API major-only and absent branches + empty activeConn
    ;(window as { orca?: unknown }).orca = { api: { major: 1 } }
    activeConn = null
    ctrl.openFeedbackModal('feature')
    ;(window as { orca?: unknown }).orca = {}
    ctrl.openFeedbackModal('bug')
    document.getElementById('feedbackModal')!.dispatchEvent(new MouseEvent('click', { bubbles: false }))
    expect((document.getElementById('feedbackModal') as HTMLElement).hidden).toBe(true)
    ctrl.openFeedbackModal('bug')
    document.getElementById('feedbackCancelBtn')!.click()
    expect((document.getElementById('feedbackModal') as HTMLElement).hidden).toBe(true)

    // 2. Shortcuts modal
    document.getElementById('shortcutsBtn')!.click()
    expect((document.getElementById('shortcutsModal') as HTMLElement).hidden).toBe(false)
    document.getElementById('shortcutsModal')!.dispatchEvent(new MouseEvent('click', { bubbles: false }))
    expect((document.getElementById('shortcutsModal') as HTMLElement).hidden).toBe(true)
    ctrl.openShortcutsModal()
    document.getElementById('shortcutsCloseBtn')!.click()
    expect((document.getElementById('shortcutsModal') as HTMLElement).hidden).toBe(true)

    // 3. Command palette: filter empty -> keyboard navigation -> click every command
    ctrl.openCmdPaletteModal()
    const palInp = document.getElementById('cmdPaletteInput') as HTMLInputElement
    palInp.value = 'nonexistent-xyz'
    palInp.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.getElementById('cmdPaletteList')!.textContent).toContain('No matching commands')

    palInp.value = ''
    palInp.dispatchEvent(new Event('input', { bubbles: true }))
    palInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    palInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    palInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    palInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    const itemCount = (() => {
      ctrl.openCmdPaletteModal()
      return document.querySelectorAll('#cmdPaletteList .cmd-palette-item').length
    })()
    expect(itemCount).toBe(13)
    for (let i = 0; i < itemCount; i++) {
      ctrl.openCmdPaletteModal()
      const items = document.querySelectorAll('#cmdPaletteList .cmd-palette-item')
      ;(items[i] as HTMLButtonElement).click()
    }
    ctrl.openCmdPaletteModal()
    document.getElementById('cmdPaletteModal')!.dispatchEvent(new MouseEvent('click', { bubbles: false }))
    ctrl.closeCmdPaletteModal()
    expect(calls).toEqual(expect.arrayContaining(['resetForm', 'setForm:true', 'openStudio', 'formatSql', 'createTbl', 'refresh']))
  })

  it('covers src/panel/panel-explorer.js pure generators, tree rendering & all 8 context menu types', async () => {
    expect(getExplorerObjectGroupLabel('redis')).toBe('Keyspaces')
    expect(getExplorerObjectGroupLabel('mongodb')).toBe('Collections')
    expect(getExplorerObjectGroupLabel('postgres')).toBe('Tables')

    expect(buildCountQueryForObject({ driver: 'mongodb' }, { name: 'users' })).toContain('countDocuments')
    expect(buildCountQueryForObject({ driver: 'postgres' }, { name: 'users', schema: 'public' })).toContain('COUNT(*)')

    fc.assert(
      fc.property(
        fc.constantFrom('postgres', 'mysql', 'sqlite', 'mssql', 'oracle', 'mongodb', 'redis'),
        fc.constantFrom('select', 'insert', 'update', 'other'),
        (driver, kind) => {
          const sql = generateSqlForTable(
            kind,
            { driver },
            { name: driver === 'redis' ? '(root)' : 'orders', schema: 'app' },
            {
              columns: [
                { name: 'id', type: 'INT', isPrimaryKey: true, isAutoIncrement: true },
                { name: 'total', type: 'DECIMAL', isPrimaryKey: false },
                { name: 'active', type: 'BOOLEAN', isPrimaryKey: false },
              ],
            }
          )
          expect(typeof sql).toBe('string')
          expect(sql.length).toBeGreaterThan(0)
        }
      ),
      { numRuns: 35 }
    )
    expect(generateSqlForTable('insert', { driver: 'sqlite' }, { name: 'empty_t' }, { columns: [] })).toContain('VALUES ()')

    // Setup stateful controller & RPC mocks
    let countThrows = false
    let ddlThrows = false
    const rpcSpy = vi.fn(async (name: string) => {
      if (name === 'query.run') {
        if (countThrows) throw new Error('count timeout')
        return { rows: [[42]] }
      }
      if (name === 'schema.tableDetails') {
        return { columns: [{ name: 'id', type: 'INT', isPrimaryKey: true }] }
      }
      if (name === 'schema.generateDdl') {
        if (ddlThrows) throw new Error('DDL unavailable')
        return { ddl: 'CREATE TABLE orders (id INT PRIMARY KEY);' }
      }
      return {}
    })
    ;(window as { orca?: unknown }).orca = { plugin: { request: rpcSpy } }

    const calls: string[] = []
    const pgConn = { id: 'c_pg', name: 'Prod PG', driver: 'postgres', folder: 'Prod', colorTag: 'prod', readOnly: false }
    const roSqlite = { id: 'c_sq', name: 'RO SQLite', driver: 'sqlite', folder: 'Prod', readOnly: true }
    const mongoConn = { id: 'c_mg', name: 'Mongo Local', driver: 'mongodb', folder: '', readOnly: false }
    const redisConn = { id: 'c_rd', name: 'Redis Cache', driver: 'redis', folder: '', readOnly: false }

    const state = {
      initialBootLoading: true,
      connections: [] as Array<Record<string, unknown>>,
      activeConnectionId: 'c_pg',
      activeTable: 'orders',
      activeSchema: 'public',
      filter: '',
      schemaObjects: {
        c_pg: [
          { name: 'orders', schema: 'public', kind: 'table' },
          { name: 'logs', schema: 'audit', kind: 'table' },
          { name: 'v_orders', schema: 'public', kind: 'view' },
        ],
        c_sq: [],
        c_mg: [{ name: 'events', kind: 'table' }],
        c_rd: [{ name: '(root)', kind: 'table' }],
      } as Record<string, Array<Record<string, unknown>>>,
      schemaLoading: new Set(['c_pg', 'c_sq']),
      tableDetails: {
        'c_pg:public:orders': {
          columns: [
            { name: 'id', type: 'bigint', isPrimaryKey: true },
            { name: 'user_id', type: 'bigint' },
          ],
          indexes: [{ name: 'idx_uid', columns: ['user_id'] }],
          foreignKeys: [{ column: 'user_id', referencedTable: 'users', referencedColumn: 'id' }],
        },
      } as Record<string, unknown>,
      tableDetailsErrors: {
        'c_pg:audit:logs': 'Permission denied',
      } as Record<string, string>,
      collapsedFolders: new Set<string>(),
      expandedConns: new Set(['c_pg', 'c_sq', 'c_mg']),
      expandedTables: new Set(['c_pg:public:orders', 'c_pg:audit:logs', 'c_pg:public:v_orders']),
      expandedMeta: new Set<string>(),
      pageData: { canEdit: true },
      sql: '',
    }

    const fakeSel = { selectCol: vi.fn() }
    const pinnedSet = new Set(['id'])
    const ctrl = createPanelExplorerController({
      state,
      QUERY_TIMEOUT_MS: 5000,
      getActiveConn: () => state.connections.find((c) => c.id === state.activeConnectionId) || null,
      getConnById: (id: string) => state.connections.find((c) => c.id === id) || null,
      isSubmittingChanges: () => false,
      getDataGridSel: () => fakeSel,
      getActiveTableKey: () => 'c_pg:public:orders',
      getPinnedColsSet: () => pinnedSet,
      activateConnection: (id: string) => {
        state.activeConnectionId = id
        calls.push(`activate:${id}`)
      },
      loadSchema: async (id: string) => {
        calls.push(`loadSchema:${id}`)
      },
      selectTableAndOpen: async (_cid: string, tbl: string, _sch: string, openData: boolean) => {
        calls.push(`sel:${tbl}:${openData}`)
      },
      showBanner: (msg: string, kind: string) => calls.push(`banner:${kind}:${msg}`),
      copyText: async (txt: string, msg: string) => {
        calls.push(`copy:${msg}:${txt.slice(0, 12)}`)
      },
      exportCurrentDataPage: (fmt: string) => calls.push(`expData:${fmt}`),
      exportCurrentSqlResult: (fmt: string) => calls.push(`expSql:${fmt}`),
      renderValueInspector: () => calls.push('valInsp'),
      renderStagingBar: () => calls.push('stageBar'),
      copyDataSelection: (fmt: string) => calls.push(`copyData:${fmt}`),
      copySqlSelection: (fmt: string) => calls.push(`copySql:${fmt}`),
      triggerPanelPasteSmart: async () => calls.push('pasteSmart'),
      triggerPanelPasteNewRows: async () => calls.push('pasteNew'),
      isActiveDataObjectView: () => false,
      addBlankDataRow: () => calls.push('addRow'),
      bulkSetSelectedCellsValue: () => calls.push('bulkNull'),
      openBulkFillModal: () => calls.push('bulkFill'),
      applyQuickWhere: (w: string) => calls.push(`where:${w}`),
      jumpToForeignKeyTarget: (t: string) => calls.push(`fk:${t}`),
      cloneSelectedRows: () => calls.push('cloneRows'),
      toggleDeleteSelectedRows: () => calls.push('delRows'),
      toggleColumnPinned: (c: string) => {
        if (pinnedSet.has(c)) pinnedSet.delete(c)
        else pinnedSet.add(c)
        calls.push(`pin:${c}`)
      },
      toggleColumnHidden: (c: string) => calls.push(`hide:${c}`),
      autoFitDataColumn: (c: string) => calls.push(`fit:${c}`),
      switchTab: (t: string) => calls.push(`tab:${t}`),
      openFullStudio: (opts: unknown) => calls.push(`studio:${JSON.stringify(opts)}`),
      openDangerTableModal: (kind: string, _c: unknown, o: { name: string }) => calls.push(`danger:${kind}:${o.name}`),
      openCreateTableModal: () => calls.push('createTbl'),
      persistActiveConnectionId: async (id: string) => {
        calls.push(`persist:${id}`)
      },
      renderConnectionsBar: () => calls.push('renderBar'),
      renderSqlSafetyBanner: () => calls.push('safetyBanner'),
      resetSqlSafetyBannerDismissal: () => calls.push('resetSafety'),
      setSqlText: (s: string) => {
        state.sql = s
        calls.push('setSql')
      },
      populateFormFromProfile: (_c: unknown, m: string) => calls.push(`popForm:${m}`),
      openDeleteConfirmModal: (c: { id: string }) => calls.push(`delConn:${c.id}`),
      savePanelViewState: () => calls.push('saveView'),
    })

    // Boot skeleton -> empty
    ctrl.renderExplorer()
    expect(document.querySelectorAll('#schemaTreeContainer .panel-skeleton-bar').length).toBeGreaterThan(0)
    state.initialBootLoading = false
    ctrl.renderExplorer()
    expect((document.getElementById('explorerEmpty') as HTMLElement).hidden).toBe(false)

    // Connections without folders vs with folders + filtering + toggle/expand/collapse
    state.connections = [mongoConn, redisConn]
    ctrl.renderExplorer()
    state.connections = [pgConn, roSqlite, mongoConn, redisConn]
    ctrl.renderExplorer()
    state.filter = 'user_id'
    ctrl.renderExplorer()
    state.filter = 'zzz-no-match'
    ctrl.renderExplorer()
    state.filter = ''
    ctrl.renderExplorer()

    // Click folder header, connection header (switch & toggle), table item, Data mini-btn, ⋮ actions
    ;(document.querySelector('.tree-folder-item') as HTMLElement | null)?.click()
    ctrl.expandAllExplorer()
    ctrl.renderExplorer()
    const connItems = Array.from(document.querySelectorAll('.tree-conn-item')) as HTMLElement[]
    connItems[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    connItems[1]?.click()
    ctrl.renderExplorer()
    ;(document.querySelector('.tree-list .tree-item') as HTMLElement | null)?.click()
    ;(document.querySelector('.tree-list .mini-btn') as HTMLElement | null)?.click()
    ctrl.collapseAllExplorer()
    ctrl.expandAllExplorer()

    // countRowsForTable success & failure
    await ctrl.countRowsForTable(pgConn, { name: 'orders', schema: 'public', kind: 'table' })
    countThrows = true
    await ctrl.countRowsForTable(pgConn, { name: 'orders', schema: 'public', kind: 'table' })
    countThrows = false
    await ctrl.countRowsForTable(redisConn, { name: '(root)', kind: 'table' })

    // Open and click every enabled menuitem across ALL 8 context menu types
    const targets = [
      { type: 'dataDownload' },
      { type: 'sqlDownload' },
      { type: 'dataCanvas' },
      {
        type: 'dataCell',
        col: { name: 'user_id' },
        entry: { rowKey: '1', isInsert: false },
        val: null,
        cellCount: 1,
        rowCount: 1,
      },
      {
        type: 'dataCell',
        col: { name: 'user_id' },
        entry: { rowKey: '1', isInsert: false },
        val: 7,
        cellCount: 2,
        rowCount: 2,
        fkInfo: { referencedTable: 'users', referencedColumn: 'id' },
      },
      { type: 'dataHeader', col: { name: 'id' }, colIdx: 0 },
      { type: 'dataHeader', col: { name: 'id' }, colIdx: 0 }, // toggles Pin -> Unpin
      { type: 'sqlCell', colName: 'email', cellCount: 2 },
      { type: 'object', conn: pgConn, obj: { name: 'logs', schema: 'audit', kind: 'table' } }, // fetches details + ddl
      { type: 'object', conn: mongoConn, obj: { name: 'events', kind: 'table' } },
      { type: 'object', conn: roSqlite, obj: { name: 'v_items', kind: 'view' } },
      { type: 'connection', conn: redisConn },
      { type: 'connection', conn: pgConn },
    ]
    for (const target of targets) {
      ctrl.openContextMenu(20, 20, target)
      const count = document.querySelectorAll('#contextMenu .ctx-item:not(:disabled)').length
      for (let idx = 0; idx < count; idx++) {
        ctrl.openContextMenu(20, 20, target)
        const btns = document.querySelectorAll('#contextMenu .ctx-item:not(:disabled)')
        ;(btns[idx] as HTMLButtonElement | undefined)?.click()
        await Promise.resolve()
        await Promise.resolve()
      }
    }
    ddlThrows = true
    ctrl.openContextMenu(10, 10, { type: 'object', conn: pgConn, obj: { name: 'orders', schema: 'public', kind: 'table' } })
    const ddlBtn = Array.from(document.querySelectorAll('#contextMenu .ctx-item')).find((b) =>
      (b.textContent ?? '').includes('CREATE DDL')
    ) as HTMLButtonElement | undefined
    ddlBtn?.click()
    await Promise.resolve()
    await Promise.resolve()
    closeContextMenu()
    expect(calls).toContain('expData:csv')
    expect(calls).toContain('expSql:json')
    expect(calls).toContain('valInsp')
    expect(calls).toContain('fk:users')
    expect(calls).toContain('hide:id')
    expect(calls).toContain('delConn:c_pg')
  })

  it('covers src/panel/panel-connection-form.js formatConnSubtitle, BYOD, URI parser, discovery & form submission', async () => {
    expect(formatConnSubtitle(null)).toBe('')
    expect(formatConnSubtitle({ driver: 'sqlite', filePath: '/a/b.db' })).toBe('/a/b.db')
    expect(formatConnSubtitle({ driver: 'duckdb', database: 'duck.db' })).toBe('duck.db')
    expect(formatConnSubtitle({ driver: 'libsql', url: 'libsql://host/?authToken=secret' })).not.toContain('secret')
    expect(formatConnSubtitle({ driver: 'd1', d1AccountId: 'acct', d1DatabaseId: 'db1' })).toBe('acct/db1')
    expect(formatConnSubtitle({ driver: 'd1', database: 'db_only' })).toBe('db_only')
    expect(formatConnSubtitle({ driver: 'd1', url: 'https://d1.example.com?token=secret_val' })).not.toContain('secret_val')
    expect(formatConnSubtitle({ driver: 'd1' })).toBe('Cloudflare D1')
    expect(formatConnSubtitle({ driver: 'redis', host: 'h', port: 6379, redisDb: 3 })).toBe('h:6379/db3')
    expect(formatConnSubtitle({ driver: 'postgres', user: 'alice', host: 'pg', port: 5432, database: 'app' })).toBe('alice@pg:5432/app')

    let byodPlatform: 'win32' | 'darwin' = 'win32'
    let inspectMode: 'ok' | 'enoent' | 'fail' | 'invalid' = 'ok'
    let setupMode: 'verified' | 'manual' | 'throw' = 'verified'
    let trustThrows = false
    let parseThrows = false
    let detectMode: 'ok' | 'empty' | 'throw' = 'ok'

    const driversList = [
      { id: 'duckdb', status: 'not-configured', localPath: 'C:\\drv\\duckdb' },
      { id: 'snowflake', status: 'local-verified', localPath: '/drv/sf', resolvedEntry: '/drv/sf/index.mjs', sha256: '0123456789abcdef' },
    ]

    ;(window as { orca?: unknown }).orca = {
      plugin: {
        request: vi.fn(async (method: string, payload?: Record<string, unknown>) => {
          if (method === 'drivers.list') return { drivers: driversList }
          if (method === 'drivers.defaultPaths') {
            return {
              platform: byodPlatform,
              paths: { duckdb: 'C:\\default\\duckdb', custom: '' },
              templates: { duckdb: 'export default {}', custom: 'export default { custom: true }' },
            }
          }
          if (method === 'workspace.listScopes') {
            return {
              workspaces: [
                { id: 'ws1', name: 'App', branch: 'main', path: '/repo/app', label: 'App (main)', isCurrent: true },
                { id: 'ws2', name: 'Api', branch: 'dev', path: '/repo/api', projectFolder: 'mono', label: 'Api', isCurrent: false },
              ],
            }
          }
          if (method === 'drivers.setupLocal') {
            if (setupMode === 'throw') throw new Error('disk full')
            const dirPath = String(payload?.localPath || 'C:\\drv\\duckdb')
            const inspect = { ok: true, sha256: 'feedface1234567890abcdef' }
            if (setupMode === 'manual') {
              return { ok: true, dirPath, inspect, installPackage: '@duckdb/node-api' }
            }
            return { ok: true, dirPath, inspect, item: { id: payload?.driverId, status: 'local-verified', localPath: dirPath, sha256: inspect.sha256 } }
          }
          if (method === 'drivers.inspectLocal') {
            if (inspectMode === 'enoent') throw new Error('No driver entry found in folder')
            if (inspectMode === 'fail') throw new Error('permission error')
            if (inspectMode === 'invalid') return { ok: false, message: 'Bad entry' }
            return { ok: true, sha256: 'cafebabe1234567890abcdef' }
          }
          if (method === 'drivers.configureLocal') {
            if (trustThrows) throw new Error('sha mismatch')
            return { ok: true }
          }
          if (method === 'fs.listDir') {
            return {
              ok: true,
              currentDir: '/repo/data',
              parentDir: '/repo',
              roots: ['/repo'],
              entries: [
                { name: 'sub', path: '/repo/data/sub', kind: 'dir' },
                { name: 'chinook.sqlite', path: '/repo/data/chinook.sqlite', kind: 'file', size: 2048 },
                { name: '.db', path: '/repo/data/.db', kind: 'file', size: 128 },
              ],
            }
          }
          if (method === 'connection.parseUri') {
            if (parseThrows) throw new Error('uri parse crash')
            return parseConnectionUri(String(payload?.uri ?? ''))
          }
          if (method === 'workspace.detectConnections') {
            if (detectMode === 'throw') throw new Error('docker unreachable')
            if (detectMode === 'empty') {
              return { envConnections: [], dockerComposeConnections: [], sqliteFiles: [], scannedDirs: ['/repo/app'] }
            }
            return {
              scannedDirs: ['/repo/app'],
              folderScoped: Boolean(payload?.folderPath),
              dockerIsLocal: false,
              dockerScopeLabel: 'Docker Context',
              envConnections: [
                { envKey: 'DATABASE_URL', name: 'Env PG', driver: 'postgres', sourceFile: '/repo/.env', uri: 'postgres://u:pw@localhost:5432/app' },
              ],
              dockerComposeConnections: [
                { project: 'app', service: 'ch', name: 'Compose CH', driver: 'clickhouse', host: '127.0.0.1', port: 8123, database: 'default', status: 'running', sourceFile: 'docker-compose.yml', workspaceMatched: true },
                { project: 'app', service: 'mongo', name: 'Compose Mongo', driver: 'mongodb', host: '127.0.0.1', port: 27017, database: 'admin', status: 'exited', sourceFile: 'docker-compose.yml', workspaceMatched: false, url: 'mongodb://u:p@127.0.0.1:27017/admin', passwordFromFile: '/run/secrets/db_pw', hint: 'Uses secret file' },
                { project: 'app', service: 'd1', name: 'Studio D1', driver: 'd1', host: 'localhost', port: 443, database: 'd1' },
              ],
              sqliteFiles: [
                { name: 'chinook.sqlite', filePath: '/repo/chinook.sqlite', sizeBytes: 4096, sizeLabel: '4 KB' },
              ],
            }
          }
          if (method === 'sqlite.scanFolder') {
            return { files: [{ name: 'extra.db', filePath: '/repo/custom/extra.db', sizeBytes: 512, sizeLabel: '512 B' }] }
          }
          return {}
        }),
      },
    }

    const notices: string[] = []
    const banners: string[] = []
    const state = {
      connections: [
        { id: 'c_saved', name: 'Existing PG', driver: 'postgres', folder: 'Prod', sslMode: 'verify-full', sslCaPath: '/ca.pem', sshEnabled: true, sshHost: 'bastion' },
        { id: 'c_an', name: 'Existing An', driver: 'postgres', folder: 'Analytics' },
      ],
      formOpen: true,
      formBusy: false,
      formDriver: 'sqlite',
      formColorTag: 'none',
      editingId: null as string | null,
      sourceSecretConnId: null as string | null,
      formHadPassword: false,
      formHadAuthToken: false,
      placeholderPasswordPending: false,
      lastParsedPlaceholderUri: false,
      lastParsedUri: '',
      formOptions: '',
      formSslMode: undefined as string | undefined,
      formSslRejectUnauthorized: undefined as boolean | undefined,
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

    const ctrl = createPanelConnectionFormController({
      state,
      showBanner: (m: string) => banners.push(m),
      showFormNotice: (m: string) => notices.push(m),
      clearFormNotice: () => {},
      setFormOpen: (v: boolean) => { state.formOpen = v },
      updateViewportLayout: () => {},
      savePanelViewState: () => {},
      copyText: async (txt: string, msg: string) => notices.push(`copied:${msg}:${txt.slice(0, 10)}`),
    })

    ctrl.initStaticSelectors()
    await flushMicro(10)

    // 1. Folder chips & env pills & tracked inputs
    document.querySelector('#formFolderChips button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    document.querySelectorAll('.env-pill').forEach((p) => (p as HTMLElement).click())
    ;(document.getElementById('formSsl') as HTMLInputElement).checked = true
    document.getElementById('formSsl')!.dispatchEvent(new Event('change', { bubbles: true }))
    document.getElementById('formHost')!.dispatchEvent(new Event('input', { bubbles: true }))

    // 2. Driver switching across SQL + BYOD engines + BYOD setup/inspect/trust/copy
    for (const d of ['postgres', 'mysql', 'mssql', 'oracle', 'redis', 'libsql', 'clickhouse', 'mongodb', 'snowflake', 'bigquery', 'cassandra', 'duckdb']) {
      ctrl.setFormDriver(d, true)
    }
    byodPlatform = 'darwin'
    await ctrl.refreshPanelByodAndWorkspaces()
    const folderInp = document.getElementById('panelByodFolderInput') as HTMLInputElement
    folderInp.value = '/tmp/my driver'
    folderInp.dispatchEvent(new Event('input', { bubbles: true }))

    document.getElementById('panelByodCopyCmdBtn')?.click()
    document.getElementById('panelByodCopyStarterBtn')?.click()
    await flushMicro()

    document.getElementById('panelByodBrowseBtn')?.click()
    await flushMicro()
    const folderBtn = Array.from(document.querySelectorAll('.panel-fp-actions button')).find((b) =>
      (b.textContent ?? '').includes('Select folder')
    ) as HTMLButtonElement | undefined
    folderBtn?.click()
    await flushMicro()

    inspectMode = 'enoent'
    document.getElementById('panelByodInspectBtn')?.click()
    await flushMicro()
    inspectMode = 'fail'
    document.getElementById('panelByodInspectBtn')?.click()
    await flushMicro()
    inspectMode = 'invalid'
    document.getElementById('panelByodInspectBtn')?.click()
    await flushMicro()
    inspectMode = 'ok'
    document.getElementById('panelByodInspectBtn')?.click()
    await flushMicro()

    trustThrows = true
    document.getElementById('panelByodTrustBtn')?.click()
    await flushMicro()
    trustThrows = false
    inspectMode = 'ok'
    document.getElementById('panelByodInspectBtn')?.click()
    await flushMicro()
    document.getElementById('panelByodTrustBtn')?.click()
    await flushMicro()

    setupMode = 'manual'
    document.getElementById('panelByodAutoSetupBtn')?.click()
    await flushMicro()
    setupMode = 'throw'
    document.getElementById('panelByodAutoSetupBtn')?.click()
    await flushMicro()
    setupMode = 'verified'
    document.getElementById('panelByodAutoSetupBtn')?.click()
    await flushMicro()

    // 3. Local SQLite file picker & quick scan folder picker
    ctrl.setFormDriver('sqlite', true)
    document.getElementById('browseSqliteFileBtn')?.click()
    await flushMicro()
    ;(document.querySelectorAll('.panel-fp-row')[2] as HTMLElement | undefined)?.click() // .db dotfile -> parent/base name
    const pickFileBtn = Array.from(document.querySelectorAll('.panel-fp-actions button')).find((b) =>
      (b.textContent ?? '').includes('Select file')
    ) as HTMLButtonElement | undefined
    pickFileBtn?.click()
    await flushMicro()

    document.getElementById('quickScanFolderBtn')?.click()
    await flushMicro()
    const pickScanFolderBtn = Array.from(document.querySelectorAll('.panel-fp-actions button')).find((b) =>
      (b.textContent ?? '').includes('Select folder')
    ) as HTMLButtonElement | undefined
    pickScanFolderBtn?.click()
    await flushMicro()

    // 4. Discovery paths (throw -> empty -> ok -> toggle collapses -> search -> click all chips)
    detectMode = 'throw'
    await ctrl.detectWorkspace('', true)
    detectMode = 'empty'
    await ctrl.detectWorkspace('/repo/app', true)
    detectMode = 'ok'
    await ctrl.detectWorkspace('/repo/app', true)
    document.getElementById('discoveredEnvToggle')?.click()
    document.getElementById('discoveredDockerToggle')?.click()
    document.getElementById('discoveredFileToggle')?.click()
    state.discoveredSearch = 'zzz-none'
    ctrl.renderDiscoveredItems()
    state.discoveredSearch = ''
    ctrl.renderDiscoveredItems()
    for (const chip of Array.from(document.querySelectorAll('#discoveredBox .file-chip')) as HTMLButtonElement[]) {
      chip.click()
      await flushMicro()
    }

    // 5. URI parser (studioOnly D1, placeholder password, libsql hash scrub, error, throw) + ensureUriParsedBeforeAction + ensureRequiredPasswordBeforeSubmit
    expect(await ctrl.handleParseUri('')).toBe(false)
    expect(await ctrl.handleParseUri('d1://acct/db?apiToken=abc')).toBe(false)
    parseThrows = true
    expect(await ctrl.handleParseUri('postgres://localhost/a')).toBe(false)
    parseThrows = false
    expect(await ctrl.handleParseUri('postgres://u:[YOUR-PASSWORD]@db.test.supabase.co:5432/postgres')).toBe(true)
    expect(ctrl.ensureRequiredPasswordBeforeSubmit('new_id')).toBe(false)
    ;(document.getElementById('uriInput') as HTMLInputElement).value = 'libsql://app.turso.io/?authToken=tok#fragment=secret'
    expect(await ctrl.ensureUriParsedBeforeAction()).toBe(true)
    expect((ctrl.buildFormSubmission('c_lib').profile as { url: string }).url).not.toContain('secret')

    ;(document.getElementById('formPassword') as HTMLInputElement).value = ''
    ctrl.setFormDriver('postgres', true)
    ;(document.getElementById('formHost') as HTMLInputElement).value = 'db.proj.supabase.co'
    expect(ctrl.ensureRequiredPasswordBeforeSubmit('new_id')).toBe(false)

    // 6. populateFormFromProfile (edit, duplicate, studioOnly, libsql, clickhouse, mongodb, oracle, redis, postgres extendedKeys)
    ctrl.populateFormFromProfile({ id: 'sd1', name: 'D1', driver: 'd1' }, 'edit')
    expect(banners.some((b) => b.includes('Fullscreen Studio'))).toBe(true)
    ctrl.populateFormFromProfile({
      id: 'c_saved',
      name: 'Saved PG',
      driver: 'postgres',
      host: 'pg.internal',
      port: 5432,
      database: 'app',
      user: 'alice',
      hasPassword: true,
      ssl: true,
      sslMode: 'verify-full',
      options: 'connect_timeout=5',
      workspaceScope: 'ws_custom',
    }, 'edit')
    const pgSub = ctrl.buildFormSubmission('c_saved')
    expect((pgSub.profile as { sshHost?: string }).sshHost).toBe('bastion')

    ctrl.populateFormFromProfile({ id: 'c_dup', name: 'Lib Dup', driver: 'libsql', url: 'https://t.turso.io?authToken=abc#pw=1', hasAuthToken: true }, 'duplicate')
    ctrl.buildFormSubmission('c_dup_new')
    ctrl.populateFormFromProfile({ id: 'c_ch', name: 'CH', driver: 'clickhouse', url: 'https://ch.internal:8443/db' }, 'edit')
    ctrl.buildFormSubmission('c_ch')
    ctrl.populateFormFromProfile({ id: 'c_mg', name: 'MG', driver: 'mongodb', url: 'mongodb://mg.internal:27018/app?tls=true' }, 'edit')
    ctrl.buildFormSubmission('c_mg')
    ctrl.populateFormFromProfile({ id: 'c_or', name: 'ORA', driver: 'oracle', url: 'https://user:pw@ora.internal/ORCL?password=x' }, 'edit')
    ctrl.buildFormSubmission('c_or')
    ctrl.populateFormFromProfile({ id: 'c_rd', name: 'RD', driver: 'redis', host: '127.0.0.1', port: 6379, redisDb: 4 }, 'edit')
    expect((ctrl.buildFormSubmission('c_rd').profile as { redisDb: number }).redisDb).toBe(4)

    ctrl.setFormControlsBusy(true)
    ctrl.setFormControlsBusy(false)
    ctrl.clearFormFields()
    expect(notices.length).toBeGreaterThan(0)
  })
})
