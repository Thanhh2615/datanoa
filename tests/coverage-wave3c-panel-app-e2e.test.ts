import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { installDomHarness, type DomHarness } from './helpers/dom-harness.js'

type EventCb = (...args: unknown[]) => void

interface LiveBackendOpts {
  seedEmptyConns?: boolean
  initialTabFailMode?: boolean
  onSaveSession?: (snap: unknown) => void
}

function createLiveSqliteBackend(opts: LiveBackendOpts = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      budget INTEGER DEFAULT 1000
    );
    CREATE TABLE employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      dept_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      salary INTEGER DEFAULT 5000,
      meta TEXT
    );
    CREATE TABLE empty_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note TEXT
    );
    CREATE VIEW active_employees AS
      SELECT e.id, e.name, e.salary, d.name AS dept_name
      FROM employees e LEFT JOIN departments d ON e.dept_id = d.id;
    INSERT INTO departments (id, name, budget) VALUES (1, 'Engineering', 50000), (2, 'Design', 30000);
    INSERT INTO employees (id, name, dept_id, salary, meta) VALUES
      (1, 'Alice', 1, 9000, '{"role":"lead"}'),
      (2, 'Bob', 2, 7500, NULL),
      (3, 'Charlie', 1, 8200, '[1,2]'),
      (4, 'Dana', 2, 6400, '{"role":"ux"}');
  `)

  const qIdent = (name: string) => `"${String(name).replace(/"/g, '""')}"`

  const connections: Array<Record<string, unknown>> = opts.seedEmptyConns
    ? []
    : [
        {
          id: 'c_main',
          name: 'Primary SQLite',
          driver: 'sqlite',
          filePath: ':memory:',
          colorTag: 'dev',
          folder: 'Local',
          readOnly: false,
        },
        {
          id: 'c_prod_ro',
          name: 'Prod Analytics',
          driver: 'sqlite',
          filePath: ':memory:',
          colorTag: 'prod',
          folder: 'Prod',
          readOnly: true,
        },
      ]

  const storageMap = new Map<string, unknown>()
  const hostListeners = new Map<string, Set<EventCb>>()
  const pluginListeners = new Map<string, Set<EventCb>>()
  const settingsListeners = new Set<EventCb>()
  const savedFiles: Array<{ content: string; filters?: unknown }> = []
  const openedUrls: string[] = []
  const historyEntries: Array<Record<string, unknown>> = [
    {
      id: 'h1',
      connectionId: 'c_main',
      connectionName: 'Primary SQLite',
      driver: 'sqlite',
      sql: 'SELECT * FROM employees;',
      durationMs: 4,
      rowCount: 4,
      executedAt: new Date().toISOString(),
    },
  ]

  let sessionSnapshot: unknown = null
  let aiStatus: Record<string, unknown> = {
    configured: true,
    enabled: true,
    ready: true,
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    source: 'orca',
  }
  const failOnceActions = new Set<string>()
  const alwaysFailActions = new Set<string>()
  let studioOpenResult: { ok: boolean; message?: string } = { ok: true }
  let testConnResult: { ok: boolean; latencyMs?: number; version?: string; message?: string } = {
    ok: true,
    latencyMs: 3,
    version: 'SQLite 3.x',
  }
  let saveConnResult: { ok: boolean; id?: string } = { ok: true }

  const getTableCols = (table: string) => {
    const info = db.prepare(`PRAGMA table_info(${qIdent(table)})`).all() as Array<Record<string, unknown>>
    return info.map((r) => ({
      name: String(r.name),
      type: String(r.type || 'TEXT'),
      nativeType: String(r.type || 'TEXT'),
      nullable: Number(r.notnull) === 0,
      isPrimaryKey: Number(r.pk) > 0,
      isAutoIncrement: Number(r.pk) > 0 && /INT/i.test(String(r.type || '')),
      defaultValue: r.dflt_value === null || r.dflt_value === undefined ? undefined : String(r.dflt_value),
    }))
  }

  const getSchemaObjects = () => {
    const rows = db
      .prepare(
        `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name`
      )
      .all() as Array<{ name: string; type: string }>
    return rows.map((r) => ({ name: r.name, kind: r.type === 'view' ? 'view' : 'table' }))
  }

  const getTableDetails = (table: string) => {
    const master = db
      .prepare(`SELECT type, sql FROM sqlite_master WHERE name = ? LIMIT 1`)
      .get(table) as { type?: string; sql?: string } | undefined
    if (!master) {
      throw new Error(`Unknown table "${table}"`)
    }
    const columns = getTableCols(table)
    const pk = columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
    const idxRaw = db.prepare(`PRAGMA index_list(${qIdent(table)})`).all() as Array<Record<string, unknown>>
    const indexes = idxRaw.map((idx) => {
      const idxCols = db
        .prepare(`PRAGMA index_info(${qIdent(String(idx.name))})`)
        .all() as Array<Record<string, unknown>>
      return {
        name: String(idx.name),
        unique: Number(idx.unique) === 1,
        columns: idxCols.map((ic) => String(ic.name)),
      }
    })
    const fkRaw = db.prepare(`PRAGMA foreign_key_list(${qIdent(table)})`).all() as Array<Record<string, unknown>>
    const foreignKeys = fkRaw.map((fk, i) => ({
      name: `fk_${table}_${i}`,
      column: String(fk.from),
      referencedTable: String(fk.table),
      referencedColumn: String(fk.to),
      onDelete: String(fk.on_delete || 'NO ACTION'),
    }))
    return {
      name: table,
      table,
      kind: master.type === 'view' ? 'view' : 'table',
      columns,
      primaryKey: pk,
      indexes,
      foreignKeys,
      ddl: master.sql || '',
    }
  }

  const buildDmlStatements = (input: Record<string, unknown>) => {
    const table = String(input.table || '')
    const stmts: string[] = []
    const inserts = (input.inserts as Array<Record<string, unknown>>) || []
    const updates = (input.updates as Array<{ primaryKeys?: Record<string, unknown>; changes?: Record<string, unknown> }>) || []
    const deletes = (input.deletes as Array<{ primaryKeys?: Record<string, unknown> }>) || []
    for (const row of inserts) {
      const cols = Object.keys(row)
      stmts.push(
        `INSERT INTO ${qIdent(table)} (${cols.map(qIdent).join(', ')}) VALUES (${cols.map((c) => JSON.stringify(row[c])).join(', ')});`
      )
    }
    for (const upd of updates) {
      const ch = upd.changes || {}
      const sets = Object.keys(ch).map((k) => `${qIdent(k)} = ${JSON.stringify(ch[k])}`).join(', ')
      const pk = upd.primaryKeys || {}
      const where = Object.keys(pk).map((k) => `${qIdent(k)} = ${JSON.stringify(pk[k])}`).join(' AND ')
      if (sets) stmts.push(`UPDATE ${qIdent(table)} SET ${sets} WHERE ${where || '1=0'};`)
    }
    for (const del of deletes) {
      const pk = del.primaryKeys || {}
      const where = Object.keys(pk).map((k) => `${qIdent(k)} = ${JSON.stringify(pk[k])}`).join(' AND ')
      stmts.push(`DELETE FROM ${qIdent(table)} WHERE ${where || '1=0'};`)
    }
    return stmts
  }

  const runSingleSql = (sqlText: string) => {
    const trimmed = sqlText.trim()
    const isRead = /^(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(trimmed)
    if (isRead) {
      const stmt = db.prepare(trimmed)
      const rows = stmt.all() as Array<Record<string, unknown>>
      const colNames = rows.length > 0 ? Object.keys(rows[0]) : []
      return {
        columns: colNames.map((name) => ({ name, type: 'TEXT' })),
        rows,
        rowsAffected: 0,
        durationMs: 2,
      }
    }
    const info = db.prepare(trimmed).run()
    return {
      columns: [],
      rows: [],
      rowsAffected: Number(info.changes ?? 0),
      durationMs: 2,
    }
  }

  const rpcSpy = vi.fn(async (action: string, input: Record<string, unknown> = {}) => {
    if (failOnceActions.delete(action) || alwaysFailActions.has(action)) {
      throw new Error(`Simulated failure for ${action}`)
    }
    switch (action) {
      case 'connections.list':
        return connections.map((c) => ({ ...c }))
      case 'connection.test':
        return testConnResult
      case 'connection.save': {
        const profile = (input.profile as Record<string, unknown>) || {}
        const id = String(profile.id || input.id || `c_${Date.now()}`)
        const idx = connections.findIndex((c) => c.id === id)
        const next = { ...profile, id }
        if (idx >= 0) connections[idx] = next
        else connections.push(next)
        return saveConnResult.ok ? { ok: true, id } : { ok: false, message: 'Save rejected' }
      }
      case 'connection.delete': {
        const idx = connections.findIndex((c) => c.id === input.id)
        if (idx >= 0) connections.splice(idx, 1)
        return { ok: true }
      }
      case 'connection.parseUri': {
        const uri = String(input.uri || '')
        if (!uri.includes('://')) return { ok: false, error: 'Invalid URI scheme' }
        return {
          ok: true,
          profile: {
            driver: uri.startsWith('postgres') ? 'postgres' : 'sqlite',
            name: 'Parsed Conn',
            filePath: uri.replace(/^[a-z]+:\/\//, ''),
            host: 'localhost',
            port: 5432,
            database: 'appdb',
            user: 'admin',
          },
          password: 'secret',
        }
      }
      case 'schema.listObjects':
        return getSchemaObjects()
      case 'schema.tableDetails':
        return getTableDetails(String(input.table))
      case 'schema.generateDdl': {
        const m = db
          .prepare(`SELECT sql FROM sqlite_master WHERE name = ? LIMIT 1`)
          .get(String(input.table)) as { sql?: string } | undefined
        return { ddl: m?.sql || '' }
      }
      case 'data.fetchPage': {
        const tbl = String(input.table)
        const page = Math.max(1, Number(input.page || 1))
        const pageSize = Math.max(1, Number(input.pageSize || 100))
        const master = db
          .prepare(`SELECT type FROM sqlite_master WHERE name = ? LIMIT 1`)
          .get(tbl) as { type?: string } | undefined
        const isView = master?.type === 'view'
        const cols = getTableCols(tbl)
        const pk = cols.filter((c) => c.isPrimaryKey).map((c) => c.name)
        const whereSql = input.whereClause ? ` WHERE ${String(input.whereClause)}` : ''
        const orderSql = input.orderByClause
          ? ` ORDER BY ${String(input.orderByClause)}`
          : input.sortColumn
          ? ` ORDER BY ${qIdent(String(input.sortColumn))} ${String(input.sortDirection || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`
          : ''
        const cntRow = db.prepare(`SELECT COUNT(*) AS cnt FROM ${qIdent(tbl)}${whereSql}`).get() as { cnt: number }
        const totalRows = Number(cntRow?.cnt ?? 0)
        const offset = (page - 1) * pageSize
        const rows = db
          .prepare(`SELECT * FROM ${qIdent(tbl)}${whereSql}${orderSql} LIMIT ? OFFSET ?`)
          .all(pageSize, offset) as Array<Record<string, unknown>>
        return {
          columns: cols,
          rows,
          totalRows,
          page,
          pageSize,
          primaryKey: pk,
          canEdit: !isView && pk.length > 0,
        }
      }
      case 'data.previewChanges':
        return { statements: buildDmlStatements(input) }
      case 'data.applyChanges': {
        const tbl = String(input.table)
        const inserts = (input.inserts as Array<Record<string, unknown>>) || []
        const updates = (input.updates as Array<{ primaryKeys?: Record<string, unknown>; changes?: Record<string, unknown> }>) || []
        const deletes = (input.deletes as Array<{ primaryKeys?: Record<string, unknown> }>) || []
        db.exec('BEGIN')
        try {
          for (const ins of inserts) {
            const cols = Object.keys(ins).filter((k) => ins[k] !== undefined)
            const sql = `INSERT INTO ${qIdent(tbl)} (${cols.map(qIdent).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
            db.prepare(sql).run(...cols.map((c) => (ins[c] as null | number | string) ?? null))
          }
          for (const upd of updates) {
            const ch = upd.changes || {}
            const pk = upd.primaryKeys || {}
            const setCols = Object.keys(ch)
            const pkCols = Object.keys(pk)
            if (setCols.length > 0 && pkCols.length > 0) {
              const sql = `UPDATE ${qIdent(tbl)} SET ${setCols.map((c) => `${qIdent(c)} = ?`).join(', ')} WHERE ${pkCols.map((k) => `${qIdent(k)} = ?`).join(' AND ')}`
              db.prepare(sql).run(
                ...setCols.map((c) => (ch[c] as null | number | string) ?? null),
                ...pkCols.map((k) => (pk[k] as null | number | string) ?? null)
              )
            }
          }
          for (const del of deletes) {
            const pk = del.primaryKeys || {}
            const pkCols = Object.keys(pk)
            if (pkCols.length > 0) {
              const sql = `DELETE FROM ${qIdent(tbl)} WHERE ${pkCols.map((k) => `${qIdent(k)} = ?`).join(' AND ')}`
              db.prepare(sql).run(...pkCols.map((k) => (pk[k] as null | number | string) ?? null))
            }
          }
          db.exec('COMMIT')
        } catch (err) {
          db.exec('ROLLBACK')
          throw err
        }
        return { ok: true, inserted: inserts.length, updated: updates.length, deleted: deletes.length }
      }
      case 'query.run': {
        const sql = String(input.sql || '').trim()
        const parts = sql
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)
        const list = parts.length > 0 ? parts : [sql]
        const sets = list.map((stmt) => runSingleSql(stmt))
        historyEntries.unshift({
          id: `h_${Date.now()}`,
          connectionId: input.connectionId,
          connectionName: 'Primary SQLite',
          driver: 'sqlite',
          sql,
          durationMs: 2,
          rowCount: sets[0]?.rows?.length || 0,
          executedAt: new Date().toISOString(),
        })
        if (sets.length === 1) {
          return { ...sets[0], resultSets: sets }
        }
        return { columns: sets[0].columns, rows: sets[0].rows, rowsAffected: 0, durationMs: 4, resultSets: sets }
      }
      case 'query.cancel':
        return { ok: true }
      case 'query.explain': {
        const sql = String(input.sql || '')
        const planRows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<Record<string, unknown>>
        return {
          driver: 'sqlite',
          analyzed: true,
          rawText: planRows.map((r) => String(r.detail || JSON.stringify(r))).join('\n'),
          lines: planRows.map((r) => String(r.detail || JSON.stringify(r))),
          planRows,
          summary: 'SQLite query plan ready',
          nodes: [],
        }
      }
      case 'query.history.list':
        return [...historyEntries]
      case 'query.history.clear':
        historyEntries.length = 0
        return { ok: true }
      case 'tx.status':
        return { active: false, txActive: false }
      case 'studio.open':
        return studioOpenResult
      case 'ui.getSessionSnapshot':
        return sessionSnapshot
      case 'ui.saveSessionSnapshot':
        sessionSnapshot = input.snapshot
        opts.onSaveSession?.(input.snapshot)
        return { ok: true }
      case 'ai.status.get':
        return aiStatus
      case 'ai.complete':
        return { text: '-- AI suggestion\nSELECT id, name FROM employees;' }
      case 'ai.explainAnalyze':
        return { summary: 'Add index on dept_id', suggestedSql: 'CREATE INDEX idx_emp_dept ON employees(dept_id);' }
      case 'ai.metrics.event':
        return { ok: true }
      case 'drivers.list':
        return [
          { id: 'sqlite', installed: true, mode: 'builtin', label: 'SQLite' },
          { id: 'postgres', installed: true, mode: 'bundled', label: 'PostgreSQL' },
        ]
      case 'drivers.defaultPaths':
        return { sqlite: 'builtin', duckdb: '/tmp/duck' }
      case 'drivers.inspectLocal':
      case 'drivers.configureLocal':
      case 'drivers.setupLocal':
        return { ok: true, installed: true }
      case 'workspace.listScopes':
        return [{ id: 'ws1', name: 'Workspace A', path: 'D:/orca-custom-extensions/datanoa' }]
      case 'workspace.detectConnections':
        return {
          files: [{ path: 'data/app.sqlite', name: 'app.sqlite', driver: 'sqlite' }],
          envs: [{ path: '.env', key: 'DATABASE_URL', driver: 'postgres', connectionString: 'postgres://u:p@localhost/db' }],
          docker: [{ id: 'dk1', name: 'pg-dev', driver: 'postgres', port: 5432 }],
        }
      case 'sqlite.scanFolder':
        return [{ path: 'data/scanned.db', name: 'scanned.db' }]
      case 'fs.listDir':
        return { ok: true, currentDir: 'D:/', parentDir: null, roots: ['D:/'], entries: [] }
      default:
        return { ok: true }
    }
  })

  const emitHost = (ev: string, ...args: unknown[]) => {
    for (const cb of hostListeners.get(ev) || []) cb(...args)
  }
  const emitPlugin = (ev: string, ...args: unknown[]) => {
    for (const cb of pluginListeners.get(ev) || []) cb(...args)
  }
  const emitSettings = (change: { key: string; value?: unknown }) => {
    for (const cb of settingsListeners) cb(change)
  }

  const orcaApi = {
    on(ev: string, cb: EventCb) {
      if (!hostListeners.has(ev)) hostListeners.set(ev, new Set())
      hostListeners.get(ev)!.add(cb)
      return () => hostListeners.get(ev)?.delete(cb)
    },
    plugin: {
      request: rpcSpy,
      on(ev: string, cb: EventCb) {
        if (!pluginListeners.has(ev)) pluginListeners.set(ev, new Set())
        pluginListeners.get(ev)!.add(cb)
        return () => pluginListeners.get(ev)?.delete(cb)
      },
    },
    settings: {
      get: (k: string) => (k === 'maxRows' ? 200 : undefined),
      onDidChange(cb: EventCb) {
        settingsListeners.add(cb)
        return () => settingsListeners.delete(cb)
      },
    },
    storage: {
      get: async (k: string) => storageMap.get(k) ?? null,
      set: async (k: string, v: unknown) => {
        storageMap.set(k, v)
      },
      delete: async (k: string) => {
        storageMap.delete(k)
      },
    },
    host: {
      call: async (method: string) => {
        if (method === 'editor.readTypography') {
          return { fontFamily: 'Consolas', fontSize: 13 }
        }
        return { ok: true }
      },
    },
    files: {
      saveAs: async (content: string, options?: unknown) => {
        savedFiles.push({ content, filters: options })
        return { status: 'saved', path: 'D:/export.csv' }
      },
    },
    shell: {
      openExternal: async (url: string) => {
        openedUrls.push(url)
      },
    },
  }

  return {
    db,
    connections,
    storageMap,
    savedFiles,
    openedUrls,
    rpcSpy,
    failOnceActions,
    alwaysFailActions,
    setStudioOpenResult: (v: { ok: boolean; message?: string }) => { studioOpenResult = v },
    setTestConnResult: (v: typeof testConnResult) => { testConnResult = v },
    setSaveConnResult: (v: typeof saveConnResult) => { saveConnResult = v },
    setAiStatus: (v: Record<string, unknown>) => { aiStatus = v },
    setSessionSnapshot: (v: unknown) => { sessionSnapshot = v },
    orcaApi,
    emitHost,
    emitPlugin,
    emitSettings,
  }
}

async function flushMicro(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
  }
}

async function flushTick(): Promise<void> {
  await flushMicro(8)
  await new Promise((r) => setTimeout(r, 0))
  await flushMicro(12)
}

function setupPanelDomMetrics() {
  const rect = (h: number, w = 900) => () => ({
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
  const tabSql = document.getElementById('tabSql')
  if (tabSql) {
    tabSql.clientHeight = 700
    tabSql.getBoundingClientRect = rect(700)
  }
  const gridWrap = document.getElementById('dataGridWrap')
  if (gridWrap) {
    gridWrap.clientHeight = 420
    gridWrap.clientWidth = 800
    gridWrap.getBoundingClientRect = rect(420, 800)
  }
  const sqlWrap = document.getElementById('sqlResultWrap')
  if (sqlWrap) {
    sqlWrap.clientHeight = 320
    sqlWrap.clientWidth = 800
    sqlWrap.getBoundingClientRect = rect(320, 800)
  }
  const viewport = document.querySelector('.viewport') as HTMLElement | null
  if (viewport) {
    viewport.clientHeight = 680
    viewport.getBoundingClientRect = rect(680)
  }
}

describe('Wave 3C Step 4: src/panel/panel-app.js E2E with live SQLite', () => {
  let dom: DomHarness | undefined

  beforeEach(() => {
    vi.resetModules()
    dom = installDomHarness({ url: 'http://localhost/' })
    dom.mountPanelHtml()
    setupPanelDomMetrics()
  })

  afterEach(() => {
    try {
      window.dispatchEvent(new Event('beforeunload'))
      window.dispatchEvent(new Event('pagehide'))
    } catch {}
    vi.useRealTimers()
    dom?.teardown()
    dom = undefined
  })

  it('restores warm cache & persisted view state with sensitive scrubbing on boot', async () => {
    const backend = createLiveSqliteBackend()
    try {
      ;(window as { orca?: unknown }).orca = backend.orcaApi
      backend.storageMap.set('datanoa.activeConnectionId', 'c_main')
      localStorage.setItem(
        'datanoa.panelViewState',
        JSON.stringify({
          activeConnectionId: 'c_main',
          activeTable: 'employees',
          page: 1,
          pageSize: 100,
          sortCol: 'id',
          sortDir: 'ASC',
          whereClause: 'salary > 6000',
          orderByClause: 'id ASC',
          transposed: false,
          collapsedFolders: ['Prod'],
          expandedConns: ['c_main'],
          expandedTables: ['c_main::employees'],
          expandedMeta: [],
          filter: '',
          tab: 'data',
          sqlDraft: "SELECT * FROM employees WHERE password = 'secret';",
          sqlEditorHeight: 180,
          scrollState: { dataTop: 10, dataLeft: 0, sqlTop: 0, viewportTop: 0 },
          formDriver: 'sqlite',
          formColorTag: 'dev',
          formDraft: { name: 'Draft Conn', folder: 'Local', workspaceScope: 'ws1' },
        })
      )
      localStorage.setItem(
        'datanoa.panelWarmCache',
        JSON.stringify({
          updatedAt: Date.now(),
          activeConnectionId: 'c_main',
          activeTable: 'employees',
          page: 1,
          pageSize: 100,
          whereClause: 'salary > 6000',
          orderByClause: 'id ASC',
          connections: backend.connections,
          schemaObjects: {
            c_main: [
              { name: 'departments', kind: 'table' },
              { name: 'employees', kind: 'table' },
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
          lastSqlResult: {
            columns: [{ name: 'ok', type: 'INTEGER' }],
            rows: [{ ok: 1 }],
            durationMs: 1,
            rowsAffected: 0,
          },
        })
      )

      await import('../src/panel/panel-app.js')
      await flushTick()
      dom?.runRaf()
      await flushTick()

      expect(document.getElementById('connCountBadge')?.textContent).toBe('2')
      expect((document.getElementById('dataWhereInput') as HTMLInputElement).value).toBe('salary > 6000')
      expect(document.querySelectorAll('#dataTable tbody tr').length).toBeGreaterThan(0)

      // Scroll events trigger pending view-state save & scrub sensitive draft / URI creds
      ;(document.getElementById('uriInput') as HTMLInputElement).value = 'postgres://user:topsecret@localhost/app'
      document.querySelector('.viewport')?.dispatchEvent(new Event('scroll'))
      document.getElementById('dataGridWrap')?.dispatchEvent(new Event('scroll'))
      document.getElementById('sqlResultWrap')?.dispatchEvent(new Event('scroll'))
      await new Promise((r) => setTimeout(r, 300))
      await flushMicro()

      const savedViewRaw = localStorage.getItem('datanoa.panelViewState') || ''
      expect(savedViewRaw).not.toContain('topsecret')
    } finally {
      window.dispatchEvent(new Event('beforeunload'))
      backend.db.close()
    }
  })

  it('executes full live SQLite E2E flows across Explorer, Data CRUD, Create/Drop/Truncate modals, Structure migration & SQL console', async () => {
    const backend = createLiveSqliteBackend()
    try {
      ;(window as { orca?: unknown }).orca = backend.orcaApi
      await import('../src/panel/panel-app.js')
      await flushTick()
      dom?.runRaf()
      await flushTick()

      // Live connections booted -> schema loaded -> departments or employees auto-selected
      expect(backend.rpcSpy).toHaveBeenCalledWith('connections.list')
      expect(document.getElementById('connCountBadge')?.textContent).toBe('2')

      // 1. Explorer & Table Selection (employees with FK badge jump + active_employees view)
      const schemaFilter = document.getElementById('schemaFilter') as HTMLInputElement
      schemaFilter.value = 'emp'
      schemaFilter.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 200))
      schemaFilter.value = ''
      schemaFilter.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 200))

      document.getElementById('expandAllTreeBtn')?.click()
      document.getElementById('collapseAllTreeBtn')?.click()
      document.getElementById('expandAllTreeBtn')?.click()

      const tableSel = document.getElementById('dataTableSelect') as HTMLSelectElement
      tableSel.value = 'employees'
      tableSel.dispatchEvent(new Event('change', { bubbles: true }))
      await flushTick()
      await flushTick()

      // Click FK badge inside employees data table -> jumps to departments!
      const fkBadge = document.querySelector('#dataTable .fk-link-badge') as HTMLElement | null
      fkBadge?.click()
      await flushTick()
      await flushTick()

      // Switch back to employees & exercise toolbar: filter, sort, pageSize, cols popover, transpose, find, export
      tableSel.value = 'employees'
      tableSel.dispatchEvent(new Event('change', { bubbles: true }))
      await flushTick()
      await flushTick()

      ;(document.getElementById('dataWhereInput') as HTMLInputElement).value = 'salary >= 7000'
      ;(document.getElementById('dataOrderInput') as HTMLInputElement).value = 'id DESC'
      document.getElementById('applyFilterBtn')?.click()
      await flushTick()
      await flushTick()
      expect(document.querySelectorAll('#dataTable tbody tr[data-row-idx]').length).toBe(3) // Alice, Bob, Charlie

      document.getElementById('clearFilterBtn')?.click()
      await flushTick()
      await flushTick()
      expect(document.querySelectorAll('#dataTable tbody tr[data-row-idx]').length).toBe(4)

      const psSel = document.getElementById('pageSizeSelect') as HTMLSelectElement
      psSel.value = '500'
      psSel.dispatchEvent(new Event('change', { bubbles: true }))
      await flushTick()

      // Columns popover: open, search, toggle hide, toggle pin, show all, close on doc click
      document.getElementById('dataColsBtn')?.click()
      const colsSearch = document.getElementById('dataColsSearchInput') as HTMLInputElement
      colsSearch.value = 'meta'
      colsSearch.dispatchEvent(new Event('input', { bubbles: true }))
      ;(document.querySelector('#dataColsList input[type="checkbox"]') as HTMLInputElement | null)?.click()
      document.getElementById('dataColsShowAllBtn')?.click()
      ;(document.querySelector('#dataColsList button') as HTMLButtonElement | null)?.click()
      document.dispatchEvent(new MouseEvent('click', { bubbles: true }))

      // Find in Grid
      const findInp = document.getElementById('dataFindInput') as HTMLInputElement
      findInp.value = 'Alice'
      findInp.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 150))
      document.getElementById('dataFindNextBtn')?.click()
      document.getElementById('dataFindPrevBtn')?.click()
      findInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      findInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

      // Export dropdown & download context menu
      const expSel = document.getElementById('exportFormatSelect') as HTMLSelectElement
      expSel.value = 'csv'
      expSel.dispatchEvent(new Event('change', { bubbles: true }))
      await flushMicro()
      document.getElementById('downloadDataBtn')?.click()
      document.dispatchEvent(new MouseEvent('click', { bubbles: true }))

      // 2. Live CRUD on Data Tab: Add Blank Row -> Inline Edit -> Bulk Fill -> Value Inspector -> DML Preview -> Submit -> Verify in real SQLite!
      document.getElementById('addRowBtn')?.click()
      const newNameTd = document.querySelector('#dataTable tbody tr[data-row-idx="0"] td[data-col-name="name"]') as HTMLElement
      newNameTd.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      const inlineInp = document.querySelector('#dataTable input.cell-edit-input') as HTMLInputElement | null
      if (inlineInp) {
        inlineInp.value = 'Eve Live'
        inlineInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      }

      // Open Value Inspector, edit meta cell on row 1, format/minify/copy/apply/collapse/resizer/close
      const firstRowMetaTd = document.querySelector('#dataTable tbody td[data-col-name="meta"]') as HTMLElement | null
      firstRowMetaTd?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      document.querySelector('#dataTable input.cell-edit-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      firstRowMetaTd?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      document.getElementById('inspectCellBtn')?.click()
      const inspText = document.getElementById('valueInspectorText') as HTMLInputElement
      inspText.value = '{"role":"staff","ok":true}'
      inspText.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('inspectorFormatJsonBtn')?.click()
      document.getElementById('inspectorMinifyJsonBtn')?.click()
      document.getElementById('inspectorCopyBtn')?.click()
      document.getElementById('inspectorApplyBtn')?.click()
      document.getElementById('toggleInspectorBodyBtn')?.click()
      document.getElementById('toggleInspectorBodyBtn')?.click()
      const inspResizer = document.getElementById('valueInspectorResizer')
      inspResizer?.dispatchEvent(new MouseEvent('mousedown', { clientY: 300, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientY: 260 }))
      window.dispatchEvent(new Event('mouseup'))
      inspResizer?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
      inspResizer?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      document.getElementById('closeInspectorBtn')?.click()

      // DML Preview Drawer
      document.getElementById('dmlPreviewBtn')?.click()
      await flushTick()
      expect((document.getElementById('dmlPreviewDrawer') as HTMLElement).hidden).toBe(false)
      document.getElementById('copyDmlBtn')?.click()
      document.getElementById('closeDmlBtn')?.click()

      // Submit real changes -> committed into DatabaseSync!
      document.getElementById('submitChangesBtn')?.click()
      await flushTick()
      await flushTick()

      const eveRow = backend.db.prepare(`SELECT name FROM employees WHERE name = 'Eve Live'`).get() as { name: string } | undefined
      expect(eveRow?.name).toBe('Eve Live')

      // Clone + Delete + Revert
      document.getElementById('cloneRowBtn')?.click()
      document.getElementById('delRowBtn')?.click()
      document.getElementById('revertChangesBtn')?.click()

      // Transposed mode toggle + click FK in transposed
      document.getElementById('transposeBtn')?.click()
      ;(document.querySelector('#dataTable tbody td[data-col-name="name"]') as HTMLElement | null)?.click()
      document.getElementById('transposeBtn')?.click()

      // 3. Create New Table Modal -> creates real SQLite table `tasks`, then Truncate & Drop via Explorer context menu!
      const connTreeItem = Array.from(document.querySelectorAll('#schemaTreeContainer .tree-item.tree-conn-item')).find((el) =>
        (el.textContent || '').includes('Primary SQLite')
      ) as HTMLElement | undefined
      connTreeItem?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      const createItem = Array.from(document.querySelectorAll('#contextMenu button, #contextMenu .ctx-item')).find((b) =>
        /New Table|New Collection|Create/i.test(b.textContent || '')
      ) as HTMLElement | undefined
      createItem?.click()

      expect((document.getElementById('createTableModal') as HTMLElement).hidden).toBe(false)
      ;(document.getElementById('createTableNameInput') as HTMLInputElement).value = 'tasks'
      document.getElementById('createTableNameInput')?.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('createTableAddColBtn')?.click()
      const taskColInputs = Array.from(document.querySelectorAll('#createTableColsBody input[placeholder="column_name"]')) as HTMLInputElement[]
      const lastColInp = taskColInputs[taskColInputs.length - 1]
      if (lastColInp) {
        lastColInp.value = 'title'
        lastColInp.dispatchEvent(new Event('input', { bubbles: true }))
      }
      document.getElementById('createTableExecuteBtn')?.click()
      await flushTick()
      await flushTick()
      const createdTbl = backend.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'`).get() as { name?: string } | undefined
      expect(createdTbl?.name).toBe('tasks')
      backend.db.prepare(`INSERT INTO tasks (name, title) VALUES ('Seed', 'Seed Task')`).run()

      // Truncate `tasks` via Explorer object contextmenu -> #dangerTableModal
      const findTreeObjItem = (tblName: string) =>
        Array.from(document.querySelectorAll('#schemaTreeContainer .tree-list .tree-item')).find((el) =>
          (el.textContent || '').includes(tblName)
        ) as HTMLElement | undefined
      findTreeObjItem('tasks')?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      const truncItem = Array.from(document.querySelectorAll('#contextMenu button, #contextMenu .ctx-item')).find((b) =>
        /Truncate/i.test(b.textContent || '')
      ) as HTMLElement | undefined
      truncItem?.click()
      if (!(document.getElementById('dangerTableModal') as HTMLElement).hidden) {
        const confInp = document.getElementById('dangerTableConfirmInput') as HTMLInputElement
        confInp.value = 'tasks'
        confInp.dispatchEvent(new Event('input', { bubbles: true }))
        document.getElementById('dangerTableExecuteBtn')?.click()
        await flushTick()
        await flushTick()
        const cntAfterTrunc = backend.db.prepare(`SELECT COUNT(*) AS cnt FROM tasks`).get() as { cnt: number }
        expect(cntAfterTrunc.cnt).toBe(0)
      }

      // Drop `tasks` via Explorer object contextmenu -> #dangerTableModal
      findTreeObjItem('tasks')?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      const dropItem = Array.from(document.querySelectorAll('#contextMenu button, #contextMenu .ctx-item')).find((b) =>
        /Drop/i.test(b.textContent || '')
      ) as HTMLElement | undefined
      dropItem?.click()
      if (!(document.getElementById('dangerTableModal') as HTMLElement).hidden) {
        const confInp = document.getElementById('dangerTableConfirmInput') as HTMLInputElement
        confInp.value = 'tasks'
        confInp.dispatchEvent(new Event('input', { bubbles: true }))
        confInp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        await flushTick()
        await flushTick()
        const droppedTbl = backend.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'`).get()
        expect(droppedTbl).toBeUndefined()
      }

      // Bulk Fill modal via Data grid cell contextmenu
      const empRow0Name = document.querySelector('#dataTable tbody tr[data-row-idx="0"] td[data-col-name="name"]') as HTMLElement | null
      empRow0Name?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }))
      empRow0Name?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 40, clientY: 40, bubbles: true }))
      const bulkItem = Array.from(document.querySelectorAll('#contextMenu button, #contextMenu .ctx-item')).find((b) =>
        /Bulk Fill|Set Value/i.test(b.textContent || '')
      ) as HTMLElement | undefined
      bulkItem?.click()
      if (!(document.getElementById('bulkFillModal') as HTMLElement).hidden) {
        const bInp = document.getElementById('bulkFillInput') as HTMLInputElement
        bInp.value = 'BulkVal'
        document.getElementById('bulkFillApplyBtn')?.click()
        document.getElementById('revertChangesBtn')?.click()
      }

      // Data Grid real selection/keyboard/contextmenu/pagination/paste/inspector-null flows on `employees`
      // Seed 110 employees so totalRows > pageSize (100) -> test nextPage/prevPage + virtual scroll!
      backend.db.exec('BEGIN')
      const insStmt = backend.db.prepare(`INSERT INTO employees (name, dept_id, salary) VALUES (?, 1, 5100)`)
      for (let i = 0; i < 110; i++) insStmt.run(`EmpPage_${i}`)
      backend.db.exec('COMMIT')

      document.getElementById('nextPageBtn')?.click()
      await flushTick()
      document.getElementById('prevPageBtn')?.click()
      await flushTick()
      document.getElementById('reloadDataBtn')?.click()
      await flushTick()

      // Switch back to pageSize 100 and scroll virtual window (trigger RAF handler)
      psSel.value = '100'
      psSel.dispatchEvent(new Event('change', { bubbles: true }))
      await flushTick()
      const dWrap = document.getElementById('dataGridWrap')!
      dWrap.scrollTop = 600
      dWrap.dispatchEvent(new Event('scroll'))
      dom?.runRaf()
      dWrap.scrollTop = 0
      dWrap.dispatchEvent(new Event('scroll'))
      dom?.runRaf()

      // Column resize handle drag (setActiveResizeCleanup & setSuppressSortClickUntil)
      const colResize = document.querySelector('#dataTable thead th .col-resize-handle') as HTMLElement | null
      colResize?.dispatchEvent(new MouseEvent('mousedown', { clientX: 60, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 90 }))
      window.dispatchEvent(new Event('mouseup'))

      const clickCtxItem = (re: RegExp) => {
        const btn = Array.from(document.querySelectorAll('#contextMenu button, #contextMenu .ctx-item')).find((b) =>
          re.test(b.textContent || '')
        ) as HTMLElement | undefined
        btn?.click()
        return Boolean(btn)
      }

      // Real DataGrid selection keyboard/mouse/contextmenu actions: Ctrl+Click FK, F2 edit, Delete, Ctrl+C, document/wrap paste, canvas/header/cell ctxmenu
      const deptTd = document.querySelector('#dataTable tbody tr[data-row-idx="0"] td[data-col-name="dept_id"]') as HTMLElement | null
      deptTd?.dispatchEvent(new MouseEvent('mousedown', { button: 0, ctrlKey: true, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }))
      await flushTick()
      tableSel.value = 'employees'
      tableSel.dispatchEvent(new Event('change', { bubbles: true }))
      await flushTick()

      const nameCell0 = document.querySelector('#dataTable tbody tr[data-row-idx="0"] td[data-col-name="name"]') as HTMLElement | null
      nameCell0?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }))
      document.getElementById('dataSelectionStats')?.click()
      nameCell0?.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))
      dWrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
      dWrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, shiftKey: true, bubbles: true }))
      await flushTick()
      const wrapDt = new DataTransfer()
      wrapDt.setData('text/plain', 'WrapPasted')
      dWrap.dispatchEvent(new ClipboardEvent('paste', { clipboardData: wrapDt, bubbles: true }))
      nameCell0?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      document.querySelector('#dataTable input.cell-edit-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      const dtPaste = new DataTransfer()
      dtPaste.setData('text/plain', 'PastedEmp')
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dtPaste, bubbles: true }))

      // Exercise cell contextmenu items with exact labels (Edit Inspector, Copy, Paste Smart/New, Bulk NULL, Clone, Delete, Filter WHERE, Go to FK)
      nameCell0?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 30, clientY: 30, bubbles: true }))
      clickCtxItem(/Edit in Value Inspector/i)
      document.getElementById('closeInspectorBtn')?.click()
      nameCell0?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 30, clientY: 30, bubbles: true }))
      clickCtxItem(/^Copy \(TSV\)/i)
      nameCell0?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 30, clientY: 30, bubbles: true }))
      clickCtxItem(/^Paste \(Overwrite/i)
      await flushTick()
      nameCell0?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 30, clientY: 30, bubbles: true }))
      clickCtxItem(/^Paste as New Row/i)
      await flushTick()
      nameCell0?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 30, clientY: 30, bubbles: true }))
      clickCtxItem(/^Bulk Set NULL/i)
      nameCell0?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 30, clientY: 30, bubbles: true }))
      clickCtxItem(/^Clone Row/i)
      nameCell0?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 30, clientY: 30, bubbles: true }))
      clickCtxItem(/^Mark Row Deleted/i)
      nameCell0?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 30, clientY: 30, bubbles: true }))
      clickCtxItem(/^Filter WHERE/i)
      await flushTick()
      document.getElementById('clearFilterBtn')?.click()
      await flushTick()
      const deptTd2 = document.querySelector('#dataTable tbody tr[data-row-idx="0"] td[data-col-name="dept_id"]') as HTMLElement | null
      deptTd2?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 30, clientY: 30, bubbles: true }))
      clickCtxItem(/^Go to /i)
      await flushTick()
      tableSel.value = 'employees'
      tableSel.dispatchEvent(new Event('change', { bubbles: true }))
      await flushTick()
      document.getElementById('revertChangesBtn')?.click()

      // Header contextmenu (Pin, Hide, Auto-fit) & canvas contextmenu (+ Add Blank Row, Paste New Rows)
      const nameTh = document.querySelector('#dataTable thead th[data-col-name="name"]') as HTMLElement | null
      nameTh?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 30, clientY: 10, bubbles: true }))
      clickCtxItem(/Pin Column/i)
      const pinnedTh = document.querySelector('#dataTable thead th[data-col-name="name"]') as HTMLElement | null
      pinnedTh?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 30, clientY: 10, bubbles: true }))
      clickCtxItem(/Hide Column/i)
      document.getElementById('dataColsShowAllBtn')?.click()
      const shownTh = document.querySelector('#dataTable thead th[data-col-name="name"]') as HTMLElement | null
      shownTh?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 30, clientY: 10, bubbles: true }))
      clickCtxItem(/Auto-fit/i)
      dWrap.dispatchEvent(new MouseEvent('contextmenu', { clientX: 50, clientY: 50, bubbles: true }))
      clickCtxItem(/Add Blank/i)
      document.getElementById('revertChangesBtn')?.click()
      document.getElementById('downloadDataBtn')?.click()
      clickCtxItem(/CSV/i)
      await flushMicro()

      // Inspector NULL button & Ctrl+Enter
      const metaTd0 = document.querySelector('#dataTable tbody tr[data-row-idx="0"] td[data-col-name="meta"]') as HTMLElement | null
      metaTd0?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }))
      document.getElementById('inspectCellBtn')?.click()
      document.getElementById('inspectorNullBtn')?.click()
      ;(document.getElementById('valueInspectorText') as HTMLInputElement).value = '{"k":2}'
      document.getElementById('valueInspectorText')?.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('valueInspectorText')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
      document.getElementById('revertChangesBtn')?.click()
      document.getElementById('closeInspectorBtn')?.click()

      // 4. Structure Tab: switch to empty_notes, test add/revert/preview/apply/shortcut, then add `priority` & migrate!
      document.querySelector('.nav-tab[data-tab="structure"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushTick()
      const structSel = document.getElementById('structureTableSelect') as HTMLSelectElement
      structSel.value = 'empty_notes'
      structSel.dispatchEvent(new Event('change', { bubbles: true }))
      await flushTick()

      // Structure buttons: add col/idx/fk, Ctrl+S shortcut on dirty structure, open/apply/close preview, revert
      document.getElementById('btnStructAddCol')?.click()
      document.getElementById('btnStructAddIdx')?.click()
      document.getElementById('btnStructAddFk')?.click()
      document.getElementById('btnStructPreview')?.click()
      document.getElementById('applyStructSqlBtn')?.click()
      await flushTick()
      document.getElementById('cancelMigrationBtn')?.click()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
      document.getElementById('cancelMigrationBtn')?.click()
      document.getElementById('closeStructSqlBtn')?.click()
      document.getElementById('btnStructRevert')?.click()
      document.getElementById('btnStructAddCol')?.click()

      const structRows = document.querySelectorAll('#structureColTable tbody tr')
      const lastStructRow = structRows[structRows.length - 1]
      const newStructCol = lastStructRow?.querySelector('td:first-child input.struct-cell-input') as HTMLInputElement | undefined
      if (newStructCol) {
        newStructCol.value = 'priority'
        newStructCol.dispatchEvent(new Event('input', { bubbles: true }))
      }
      document.getElementById('btnStructPreview')?.click()
      document.getElementById('copyStructSqlBtn')?.click()
      document.getElementById('openStructSqlBtn')?.click()
      document.querySelector('.nav-tab[data-tab="structure"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      document.getElementById('btnStructApply')?.click()
      if (!(document.getElementById('confirmMigrationModal') as HTMLElement).hidden) {
        document.getElementById('copyMigrationSqlModalBtn')?.click()
        document.getElementById('confirmMigrationExecuteBtn')?.click()
        await flushTick()
        await flushTick()
        const colsAfter = backend.db.prepare(`PRAGMA table_info("empty_notes")`).all() as Array<{ name: string }>
        expect(colsAfter.some((c) => c.name === 'priority')).toBe(true)
      }
      document.getElementById('copyDdlBtn')?.click()
      document.getElementById('openDdlConsoleBtn')?.click()

      // 5. Explorer contextmenu -> Generate SELECT & Count Rows & Folder toggle, then SQL Tab (110+ rows virtual grid + sqlGridSel + export + cancel + AI)
      findTreeObjItem('employees')?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      clickCtxItem(/Count Rows/i)
      await flushTick()
      findTreeObjItem('employees')?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      clickCtxItem(/Generate SELECT/i)
      await flushTick()

      document.getElementById('formatSqlBtn')?.click()
      document.getElementById('runAllSqlBtn')?.click()
      await flushTick()
      await flushTick()
      const sqlWrap = document.getElementById('sqlResultWrap')!
      sqlWrap.scrollTop = 300
      sqlWrap.dispatchEvent(new Event('scroll'))
      dom?.runRaf()
      sqlWrap.scrollTop = 0
      sqlWrap.dispatchEvent(new Event('scroll'))
      dom?.runRaf()

      const sqlCell = document.querySelector('#sqlResultTable tbody tr[data-row-idx="0"] td') as HTMLElement | null
      sqlCell?.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }))
      sqlWrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      sqlWrap.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))
      sqlCell?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 25, clientY: 25, bubbles: true }))
      clickCtxItem(/^Copy \(TSV\)/i)
      sqlCell?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 25, clientY: 25, bubbles: true }))
      clickCtxItem(/^Download CSV/i)
      await flushMicro()
      document.getElementById('sqlSelectionStats')?.click()

      // Explorer connection contextmenu actions: Open Full Studio, Jump to Console, Edit, Delete Cancel
      const prodConnItem = Array.from(document.querySelectorAll('#schemaTreeContainer .tree-item.tree-conn-item')).find((el) =>
        (el.textContent || '').includes('Prod Analytics')
      ) as HTMLElement | undefined
      prodConnItem?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      clickCtxItem(/Open in Full Studio/i)
      await flushTick()
      prodConnItem?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      clickCtxItem(/Jump to Console/i)
      prodConnItem?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      clickCtxItem(/Edit Connection/i)
      document.getElementById('closeFormBtn')?.click()
      prodConnItem?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      clickCtxItem(/Delete Connection/i)
      document.getElementById('cancelDeleteBtn')?.click()
      connTreeItem?.dispatchEvent(new MouseEvent('contextmenu', { clientX: 20, clientY: 20, bubbles: true }))
      clickCtxItem(/Jump to Console/i)

      document.getElementById('explainSqlBtn')?.click()
      await flushTick()
      document.getElementById('sqlCopyExportBtn')?.click()
      document.getElementById('sqlDownloadExportBtn')?.click()
      clickCtxItem(/CSV/i)
      await flushMicro()
      document.getElementById('sqlSuccessCloseBtn')?.click()
      document.getElementById('sqlErrorCloseBtn')?.click()

      // Command Palette actions + Feedback Modal
      for (const labelRe of [
        /New Database Connection/i,
        /Open Full-Screen Studio/i,
        /Create New Table/i,
        /Format SQL Query/i,
        /Switch to Explorer/i,
        /Switch to Data/i,
        /Switch to SQL/i,
        /Refresh Connections/i,
      ]) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
        const pBtn = Array.from(document.querySelectorAll('#cmdPaletteList .cmd-palette-item')).find((b) =>
          labelRe.test(b.textContent || '')
        ) as HTMLElement | undefined
        pBtn?.click()
        await flushTick()
        // Close any opened modal/form before next palette command
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      }
      document.getElementById('feedbackBtn')?.click()
      ;(document.getElementById('feedbackTitleInput') as HTMLInputElement).value = 'Issue test'
      ;(document.getElementById('feedbackDescInput') as HTMLInputElement).value = 'Details'
      document.getElementById('feedbackCopyBtn')?.click()
      document.getElementById('feedbackOpenGithubBtn')?.click()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

      // Folder collapse toggle in Explorer + custom connSelect folder toggle
      const folderItem = document.querySelector('#schemaTreeContainer .tree-folder-item') as HTMLElement | null
      folderItem?.click()
      folderItem?.click()

      document.getElementById('toggleHistoryBtn')?.click()
      await flushTick()
      ;(document.getElementById('historySearchInput') as HTMLInputElement).value = 'employees'
      document.getElementById('historySearchInput')?.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('refreshHistoryBtn')?.click()
      await flushTick()
      document.getElementById('clearHistoryBtn')?.click()
      await flushTick()
      document.getElementById('closeHistoryBtn')?.click()

      // 6. Connections Bar: Test Active, Open Studio, Edit, Duplicate, Cancel Delete, Delete Prod RO
      document.getElementById('testActiveBtn')?.click()
      await flushTick()
      document.getElementById('openStudioBtn')?.click()
      await flushTick()

      const connSel = document.getElementById('connSelect') as HTMLSelectElement
      connSel.value = 'c_prod_ro'
      connSel.dispatchEvent(new Event('change', { bubbles: true }))
      await flushTick()
      document.getElementById('deleteActiveBtn')?.click()
      document.getElementById('cancelDeleteBtn')?.click()
      document.getElementById('deleteActiveBtn')?.click()
      document.getElementById('confirmDeleteBtn')?.click()
      await flushTick()
      expect(backend.connections.some((c) => c.id === 'c_prod_ro')).toBe(false)
    } finally {
      window.dispatchEvent(new Event('beforeunload'))
      backend.db.close()
    }
  })

  it('handles connection form CRUD, Orca host/plugin events, remote data reload banner, global shortcuts & RPC errors', async () => {
    const backend = createLiveSqliteBackend()
    try {
      ;(window as { orca?: unknown }).orca = backend.orcaApi
      await import('../src/panel/panel-app.js')
      await flushTick()
      dom?.runRaf()
      await flushTick()

      // 1. Open New Server form -> Detect Workspace -> Parse URI -> Test -> Save live connection -> Edit -> Duplicate
      document.getElementById('newServerBtn')?.click()
      document.getElementById('detectWorkspaceBtn')?.click()
      await flushTick()
      const discSearch = document.getElementById('discoveredSearchInput') as HTMLInputElement
      discSearch.value = 'app'
      discSearch.dispatchEvent(new Event('input', { bubbles: true }))

      const uriInp = document.getElementById('uriInput') as HTMLInputElement
      uriInp.value = 'sqlite:///D:/test.db'
      document.getElementById('parseUriBtn')?.click()
      await flushTick()
      ;(document.getElementById('formName') as HTMLInputElement).value = 'New SQLite Profile'
      document.getElementById('formName')?.dispatchEvent(new Event('input', { bubbles: true }))
      ;(document.getElementById('formFilePath') as HTMLInputElement).value = ':memory:'
      document.getElementById('testFormBtn')?.click()
      await flushTick()
      document.getElementById('saveFormBtn')?.click()
      await flushTick()
      expect(backend.connections.length).toBe(3)

      document.getElementById('editActiveBtn')?.click()
      document.getElementById('formNoticeClose')?.click()
      document.getElementById('clearFormBtn')?.click()
      document.getElementById('closeFormBtn')?.click()
      document.getElementById('dupActiveBtn')?.click()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

      // 2. Orca Host & Plugin Events: theme light/dark colorScheme + token sync, typography, ai status, settings change, data.cellUpdated clean & dirty
      backend.emitHost('theme', { colorScheme: 'light' })
      backend.emitHost('theme', { colorScheme: 'dark' })
      backend.emitHost('theme', { tokens: {} })
      backend.emitHost('editor.typography.changed', { fontFamily: 'JetBrains Mono', fontSize: 14 })
      backend.emitPlugin('ai.status.changed', { configured: false, enabled: false, ready: false })
      backend.emitPlugin('connections.changed')
      backend.emitSettings({ key: 'ai.model', value: 'gemini-2.5-pro' })
      await flushTick()

      // data.cellUpdated when clean -> silent reload
      document.querySelector('.nav-tab[data-tab="data"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushTick()
      backend.emitPlugin('data.cellUpdated', { connectionId: 'c_main', table: 'employees' })
      await flushTick()

      // data.cellUpdated when dirty -> shows remote banner -> reload / dismiss
      document.getElementById('addRowBtn')?.click()
      backend.emitPlugin('data.cellUpdated', { connectionId: backend.connections[backend.connections.length - 1]?.id || 'c_main', table: 'employees' })
      document.getElementById('dataRemoteDismissBtn')?.click()
      document.getElementById('dataRemoteReloadBtn')?.click()
      await flushTick()

      // 3. Form validation & URI paste/Enter + Escape priority chain across overlays
      document.getElementById('newServerBtn')?.click()
      ;(document.getElementById('formPassword') as HTMLInputElement).value = 'pw'
      document.getElementById('formPassword')?.dispatchEvent(new Event('input', { bubbles: true }))
      ;(document.getElementById('formOptions') as HTMLInputElement).value = '{}'
      document.getElementById('formOptions')?.dispatchEvent(new Event('input', { bubbles: true }))
      const uriEl = document.getElementById('uriInput') as HTMLInputElement
      const uriDt = new DataTransfer()
      uriDt.setData('text/plain', 'sqlite:///D:/pasted.db')
      uriEl.dispatchEvent(new ClipboardEvent('paste', { clipboardData: uriDt, bubbles: true }))
      uriEl.value = 'sqlite:///D:/entered.db'
      uriEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushTick()
      ;(document.getElementById('formFilePath') as HTMLInputElement).value = ''
      document.getElementById('saveFormBtn')?.click()
      await flushTick()
      ;(document.getElementById('formFilePath') as HTMLInputElement).value = ':memory:'
      backend.setTestConnResult({ ok: false, message: 'Bad auth' })
      document.getElementById('saveFormBtn')?.click()
      await flushTick()
      backend.setTestConnResult({ ok: true, latencyMs: 2 })
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

      // Popover & modal Escape dismissal chain
      document.getElementById('dataColsBtn')?.click()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.getElementById('deleteActiveBtn')?.click()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))

      // dataWhereInput / dataOrderInput Enter keys
      ;(document.getElementById('dataWhereInput') as HTMLInputElement).value = '1=1'
      document.getElementById('dataWhereInput')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushTick()
      ;(document.getElementById('dataOrderInput') as HTMLInputElement).value = 'id ASC'
      document.getElementById('dataOrderInput')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushTick()

      document.getElementById('revertChangesBtn')?.click()
      document.getElementById('addRowBtn')?.click()
      const rowTd = document.querySelector('#dataTable tbody tr[data-row-idx="0"] td[data-col-name="name"]') as HTMLElement | null
      if (rowTd) {
        rowTd.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        const inp = document.querySelector('#dataTable input.cell-edit-input') as HTMLInputElement | null
        if (inp) {
          inp.value = 'Shortcut Row'
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
          await flushTick()
        }
      }

      // 4. Error resilience: AI modal, Studio fail, data.fetchPage / schema.listObjects / connections.list errors
      backend.setStudioOpenResult({ ok: false, message: 'No workspace open' })
      document.getElementById('openStudioBtn')?.click()
      await flushTick()

      document.getElementById('sqlAiBtn')?.click()
      await flushTick()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

      backend.failOnceActions.add('query.history.clear')
      document.getElementById('clearHistoryBtn')?.click()
      await flushTick()

      backend.failOnceActions.add('connection.test')
      document.getElementById('testActiveBtn')?.click()
      await flushTick()

      backend.failOnceActions.add('data.fetchPage')
      document.getElementById('reloadDataBtn')?.click()
      await flushTick()
      const bannerTxt =
        document.getElementById('globalBannerText')?.textContent ||
        document.getElementById('globalBanner')?.textContent ||
        ''
      expect(bannerTxt).toContain('Error loading')
      expect(bannerTxt).toContain('Simulated failure for data.fetchPage')

      document.getElementById('globalBannerClose')?.click()
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('blur'))
    } finally {
      window.dispatchEvent(new Event('beforeunload'))
      backend.db.close()
    }
  })

  it('restores state & edit-mode form from ui.getSessionSnapshot and handles empty database/connections', async () => {
    const backend = createLiveSqliteBackend({ seedEmptyConns: true })
    try {
      ;(window as { orca?: unknown }).orca = backend.orcaApi
      // Drop all user tables to exercise empty schema branch when a connection has 0 objects
      backend.db.exec('DROP VIEW IF EXISTS active_employees; DROP TABLE IF EXISTS employees; DROP TABLE IF EXISTS departments; DROP TABLE IF EXISTS empty_notes;')
      backend.connections.push({
        id: 'c_empty',
        name: 'Empty SQLite',
        driver: 'sqlite',
        filePath: ':memory:',
        hasPassword: true,
        colorTag: 'none',
      })
      backend.setSessionSnapshot({
        updatedAt: Date.now(),
        viewState: {
          activeConnectionId: 'c_empty',
          activeTable: 'missing_tbl',
          tab: 'data',
          formOpen: true,
          editingId: 'c_empty',
          formHadPassword: true,
          scrollState: { dataTop: 5, dataLeft: 5, sqlTop: 5, viewportTop: 5 },
          consoleTabsState: { activeTabId: 't1', tabs: [{ id: 't1', title: 'S1', sql: 'SELECT 1;' }] },
        },
        dataCache: {
          updatedAt: Date.now(),
          activeConnectionId: 'c_empty',
          schemaObjects: {},
          tableDetails: {},
          lastSqlResult: { columns: [{ name: 'x', type: 'INTEGER' }], rows: [{ x: 1 }], durationMs: 1, rowsAffected: 0 },
        },
      })
      await import('../src/panel/panel-app.js')
      await flushTick()
      dom?.runRaf()
      await flushTick()
      expect(document.getElementById('connCountBadge')?.textContent).toBe('1')
      expect((document.getElementById('connFormTitle')?.textContent || '')).toContain('Empty SQLite')

      // Empty connections boot branch (`emptyAddConnBtn`)
      backend.connections.length = 0
      document.getElementById('refreshBtn')?.click()
      await flushTick()
      expect(document.getElementById('connCountBadge')?.textContent).toBe('0')
      document.getElementById('emptyAddConnBtn')?.click()
    } finally {
      window.dispatchEvent(new Event('beforeunload'))
      backend.db.close()
    }
  })
})
