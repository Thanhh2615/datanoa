import { vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

export type StudioEventCb = (...args: unknown[]) => void

export interface LiveStudioSqliteOpts {
  seedEmptyConns?: boolean
  multiSchema?: boolean
  extraEmployeeRows?: number
}

export function createLiveStudioSqliteBackend(opts: LiveStudioSqliteOpts = {}) {
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
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note TEXT
    );
    CREATE VIEW active_employees AS
      SELECT e.id, e.name, e.salary, d.name AS dept_name
      FROM employees e LEFT JOIN departments d ON e.dept_id = d.id;
    CREATE TRIGGER trg_notes_insert AFTER INSERT ON notes BEGIN
      SELECT 1;
    END;
    INSERT INTO departments (id, name, budget) VALUES (1, 'Engineering', 50000), (2, 'Design', 30000);
    INSERT INTO employees (id, name, dept_id, salary, meta) VALUES
      (1, 'Alice', 1, 9000, '{"role":"lead"}'),
      (2, 'Bob', 2, 7500, NULL),
      (3, 'Charlie', 1, 8200, '[1,2]'),
      (4, 'Dana', 2, 6400, '{"role":"ux"}');
    INSERT INTO notes (id, note) VALUES (1, 'First note');
  `)

  if (opts.extraEmployeeRows && opts.extraEmployeeRows > 0) {
    db.exec('BEGIN')
    const st = db.prepare(`INSERT INTO employees (name, dept_id, salary, meta) VALUES (?, 1, 5100, NULL)`)
    for (let i = 0; i < opts.extraEmployeeRows; i++) {
      st.run(`SeedEmp_${i}`)
    }
    db.exec('COMMIT')
  }

  const qIdent = (name: string) => `"${String(name).replace(/"/g, '""')}"`

  const connections: Array<Record<string, unknown>> = opts.seedEmptyConns
    ? []
    : [
        {
          id: 'c_main',
          name: 'Primary Studio SQLite',
          driver: 'sqlite',
          filePath: ':memory:',
          colorTag: 'dev',
          folder: 'Local',
          readOnly: false,
        },
        {
          id: 'c_prod_ro',
          name: 'Prod Replica RO',
          driver: 'sqlite',
          filePath: ':memory:',
          colorTag: 'prod',
          folder: 'Prod',
          readOnly: true,
        },
      ]

  const storageMap = new Map<string, unknown>()
  const hostListeners = new Map<string, Set<StudioEventCb>>()
  const pluginListeners = new Map<string, Set<StudioEventCb>>()
  const settingsListeners = new Set<StudioEventCb>()
  const storageListeners = new Set<StudioEventCb>()
  let docReplaceCb: ((val: string) => void) | null = null

  const savedFiles: Array<{ content: string; filters?: unknown }> = []
  const openedUrls: string[] = []
  const savedQueries: Array<Record<string, unknown>> = [
    { id: 'sq1', name: 'All Employees', sql: 'SELECT * FROM employees;', dialect: 'sqlite', tags: ['hr'], updatedAt: Date.now(), createdAt: Date.now() },
  ]
  const historyEntries: Array<Record<string, unknown>> = [
    {
      id: 'h1',
      connectionId: 'c_main',
      connectionName: 'Primary Studio SQLite',
      driver: 'sqlite',
      sql: 'SELECT * FROM employees;',
      durationMs: 3,
      rowCount: 4,
      timestamp: Date.now(),
      executedAt: new Date().toISOString(),
    },
  ]

  let sessionSnapshot: unknown = null
  let autoCommit = true
  let inTransaction = false
  let txStartedAt: number | undefined
  let txStatementCount = 0
  let saveAsResult: 'saved' | 'cancelled' | 'failed' = 'saved'
  let slowQueryGate: { resolve: () => void } | null = null
  let nextQueryDeferred = false
  const docChanges: string[] = []
  let docInitialValue = '-- @datanoa.connectionId: c_main\n-- @datanoa.table: employees\nSELECT * FROM employees;'

  let aiStatus: Record<string, unknown> = {
    enabled: true,
    state: 'on',
    lastMs: 12,
    suggested: 1,
    reason: null,
    format: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    host: 'generativelanguage.googleapis.com',
    model: 'gemini-2.5-flash',
    maxTokens: 96,
    explainLanguage: 'auto',
    hasKey: true,
    destination: 'orca',
  }

  const failOnceActions = new Set<string>()
  const alwaysFailActions = new Set<string>()

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

  const getSchemaObjects = (schema?: string) => {
    const rows = db
      .prepare(
        `SELECT name, type FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type, name`
      )
      .all() as Array<{ name: string; type: string }>
    return rows.map((r) => ({
      name: r.name,
      kind: r.type,
      ...(opts.multiSchema ? { schema: schema || 'main' } : {}),
    }))
  }

  const getTableDetails = (table: string, schema?: string) => {
    const master = db
      .prepare(`SELECT type, sql FROM sqlite_master WHERE name = ? LIMIT 1`)
      .get(table) as { type?: string; sql?: string } | undefined
    if (!master) {
      throw new Error(`Unknown object "${table}"`)
    }
    if (master.type === 'trigger') {
      return {
        name: table,
        ...(schema ? { schema } : {}),
        kind: 'trigger',
        columns: [],
        primaryKey: [],
        indexes: [],
        foreignKeys: [],
        ddl: master.sql || '',
      }
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
      ...(schema ? { schema } : {}),
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

  const runSingleSqlForStudio = (sqlText: string, index: number) => {
    const trimmed = sqlText.trim()
    const isSelect = /^(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(trimmed)
    const tableMatch = /\bFROM\s+["`[]?([a-zA-Z0-9_]+)["`\]]?/i.exec(trimmed)
    const sourceTable = tableMatch ? tableMatch[1] : undefined
    if (isSelect) {
      const stmt = db.prepare(trimmed)
      const objRows = stmt.all() as Array<Record<string, unknown>>
      const colNames = objRows.length > 0 ? Object.keys(objRows[0]) : []
      const columns = colNames.map((name) => ({ name, type: 'TEXT' }))
      const rows = objRows.map((rec) => colNames.map((c) => rec[c]))
      return {
        index,
        sqlPreview: trimmed.slice(0, 60),
        sql: trimmed,
        executionTimeMs: 2,
        columns,
        rows,
        rowCount: rows.length,
        affectedRows: 0,
        truncated: false,
        isSelect: true,
        ...(sourceTable ? { sourceTable } : {}),
      }
    }
    const info = db.prepare(trimmed).run()
    return {
      index,
      sqlPreview: trimmed.slice(0, 60),
      sql: trimmed,
      executionTimeMs: 2,
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: Number(info.changes ?? 0),
      truncated: false,
      isSelect: false,
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
        return { ok: true, latencyMs: 3, version: 'SQLite 3.x' }
      case 'connection.save': {
        const profile = (input.profile as Record<string, unknown>) || input
        const id = String(profile.id || input.id || `c_${Date.now()}`)
        const idx = connections.findIndex((c) => c.id === id)
        const next = { ...profile, id }
        if (idx >= 0) connections[idx] = next
        else connections.push(next)
        return { ok: true, id }
      }
      case 'connection.delete': {
        const idx = connections.findIndex((c) => c.id === input.id)
        if (idx >= 0) connections.splice(idx, 1)
        return { ok: true }
      }
      case 'connection.parseUri': {
        const uri = String(input.uri || '')
        if (!uri.includes('://')) return { ok: false, error: 'Invalid URI' }
        return {
          ok: true,
          profile: {
            driver: 'sqlite',
            name: 'Parsed SQLite',
            filePath: uri.replace(/^sqlite:\/\//, ''),
          },
        }
      }
      case 'schema.listSchemas':
        return opts.multiSchema
          ? { schemas: ['main', 'analytics'], defaultSchema: 'main' }
          : { schemas: [], defaultSchema: '' }
      case 'schema.listObjects':
        return getSchemaObjects(input.schema ? String(input.schema) : undefined)
      case 'schema.tableDetails':
        return getTableDetails(String(input.table), input.schema ? String(input.schema) : undefined)
      case 'schema.getObjectDdl': {
        const name = String(input.name || input.table || '')
        const m = db
          .prepare(`SELECT sql FROM sqlite_master WHERE name = ? LIMIT 1`)
          .get(name) as { sql?: string } | undefined
        return { ddl: m?.sql || `-- No DDL for ${name}` }
      }
      case 'schema.exportSchemaDdl': {
        const all = db
          .prepare(`SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL`)
          .all() as Array<{ sql: string }>
        return {
          ddl: all.map((r) => `${r.sql};`).join('\n\n'),
          objectCount: all.length,
          fileName: 'studio_schema.sql',
        }
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
      case 'data.updateCell': {
        const tbl = String(input.table)
        const col = String(input.column)
        const pk = (input.primaryKeys as Record<string, unknown>) || {}
        const pkCols = Object.keys(pk)
        const sql = `UPDATE ${qIdent(tbl)} SET ${qIdent(col)} = ? WHERE ${pkCols.map((k) => `${qIdent(k)} = ?`).join(' AND ')}`
        const info = db
          .prepare(sql)
          .run((input.newValue as null | number | string) ?? null, ...pkCols.map((k) => (pk[k] as null | number | string) ?? null))
        return { ok: true, affectedRows: Number(info.changes ?? 1) }
      }
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
        return {
          ok: true,
          inserted: inserts.length,
          updated: updates.length,
          deleted: deletes.length,
          statements: buildDmlStatements(input),
        }
      }
      case 'query.run': {
        if (nextQueryDeferred) {
          nextQueryDeferred = false
          await new Promise<void>((resolve) => {
            slowQueryGate = { resolve }
          })
        }
        const sql = String(input.sql || '').trim()
        const parts = sql
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)
        const list = parts.length > 0 ? parts : [sql]
        const resultSets = list.map((stmt, idx) => {
          if (list.length === 1) {
            return runSingleSqlForStudio(stmt, idx)
          }
          try {
            return runSingleSqlForStudio(stmt, idx)
          } catch (err: unknown) {
            return {
              index: idx,
              sqlPreview: stmt.slice(0, 60),
              sql: stmt,
              executionTimeMs: 1,
              columns: [],
              rows: [],
              rowCount: 0,
              affectedRows: 0,
              truncated: false,
              isSelect: false,
              isError: true,
              errorMessage: err instanceof Error ? err.message : String(err),
            }
          }
        })
        const last = resultSets[resultSets.length - 1]
        historyEntries.unshift({
          id: `h_${Date.now()}`,
          connectionId: input.connectionId,
          connectionName: 'Primary Studio SQLite',
          driver: 'sqlite',
          sql,
          durationMs: 2,
          rowCount: last.rowCount,
          timestamp: Date.now(),
          executedAt: new Date().toISOString(),
        })
        return {
          ...last,
          resultSets,
        }
      }
      case 'query.cancel': {
        slowQueryGate?.resolve()
        slowQueryGate = null
        return { ok: true, cancelled: true }
      }
      case 'query.explain': {
        const sql = String(input.sql || '')
        const rawRows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<Record<string, unknown>>
        const columns = [
          { name: 'id', type: 'INTEGER' },
          { name: 'parent', type: 'INTEGER' },
          { name: 'notused', type: 'INTEGER' },
          { name: 'detail', type: 'TEXT' },
        ]
        const rows = rawRows.map((r) => [r.id ?? 0, r.parent ?? 0, r.notused ?? 0, String(r.detail || '')])
        return {
          driver: 'sqlite',
          analyzed: true,
          columns,
          rows,
          rowCount: rows.length,
          executionTimeMs: 2,
          truncated: false,
          isSelect: true,
          rawText: rawRows.map((r) => String(r.detail || JSON.stringify(r))).join('\n'),
          lines: rawRows.map((r) => String(r.detail || JSON.stringify(r))),
          planRows: rawRows,
          summary: 'SQLite query plan ready',
          nodes: [],
        }
      }
      case 'query.history.list':
        return { entries: [...historyEntries] }
      case 'query.history.clear':
        historyEntries.length = 0
        return { ok: true }
      case 'tx.begin':
        inTransaction = true
        autoCommit = false
        txStartedAt = Date.now()
        txStatementCount = 1
        return { supported: true, autoCommit, inTransaction, startedAt: txStartedAt, statementCount: txStatementCount, active: true, txActive: true, mode: 'manual' }
      case 'tx.commit':
      case 'tx.rollback':
        inTransaction = false
        txStartedAt = undefined
        txStatementCount = 0
        return { supported: true, autoCommit, inTransaction, active: false, txActive: false }
      case 'tx.setAutoCommit':
        autoCommit = Boolean(input.autoCommit)
        return { supported: true, autoCommit, inTransaction, startedAt: txStartedAt, statementCount: txStatementCount, active: inTransaction, txActive: inTransaction }
      case 'tx.status':
        return { supported: true, autoCommit, inTransaction, startedAt: txStartedAt, statementCount: txStatementCount, active: inTransaction, txActive: inTransaction }
      case 'queries.saved.list':
        return { entries: [...savedQueries] }
      case 'queries.saved.save': {
        const now = Date.now()
        const entry = {
          id: String(input.id || `sq_${now}`),
          name: String(input.name || 'Saved Query'),
          sql: String(input.sql || ''),
          tags: Array.isArray(input.tags) ? input.tags : [],
          dialect: String(input.dialect || 'sqlite'),
          createdAt: now,
          updatedAt: now,
        }
        const existingIdx = savedQueries.findIndex((q) => q.id === entry.id)
        if (existingIdx >= 0) savedQueries[existingIdx] = entry
        else savedQueries.unshift(entry)
        return { ok: true, entry }
      }
      case 'queries.saved.delete': {
        const idx = savedQueries.findIndex((q) => q.id === input.id)
        if (idx >= 0) savedQueries.splice(idx, 1)
        return { ok: true }
      }
      case 'savedQueries.list':
        return [...savedQueries]
      case 'savedQueries.save': {
        const q = { ...input, id: `sq_${Date.now()}`, createdAt: new Date().toISOString() }
        savedQueries.unshift(q)
        return { ok: true, query: q }
      }
      case 'savedQueries.delete': {
        const idx = savedQueries.findIndex((q) => q.id === input.id)
        if (idx >= 0) savedQueries.splice(idx, 1)
        return { ok: true }
      }
      case 'drivers.list':
        return {
          drivers: [
            { id: 'sqlite', installed: true, mode: 'builtin', label: 'SQLite' },
            { id: 'postgres', installed: true, mode: 'bundled', label: 'PostgreSQL' },
          ],
        }
      case 'drivers.defaultPaths':
        return { platform: 'win32', paths: { sqlite: 'builtin', duckdb: '/tmp/duck' } }
      case 'drivers.inspectLocal':
      case 'drivers.configureLocal':
      case 'drivers.setupLocal':
      case 'drivers.verify':
      case 'drivers.removeLocal':
        return { ok: true, installed: true }
      case 'workspace.listScopes':
        return [{ id: 'ws1', name: 'Workspace', path: 'D:/orca-custom-extensions/datanoa' }]
      case 'workspace.detectConnections':
        return { files: [{ path: 'app.sqlite', name: 'app.sqlite', driver: 'sqlite' }], envs: [], docker: [] }
      case 'fs.listDir':
        return { ok: true, currentDir: 'D:/', parentDir: null, roots: ['D:/'], entries: [] }
      case 'ui.getSessionSnapshot':
        return sessionSnapshot
      case 'ui.saveSessionSnapshot':
        sessionSnapshot = input.snapshot
        return { ok: true }
      case 'ai.status.get':
        return aiStatus
      case 'ai.stats.get':
        return { total: 5, suggested: 4, accepted: 2, avgMs: 18, lastMs: 12 }
      case 'ai.stats.reset':
      case 'ai.key.set':
        return { ok: true }
      case 'ai.provider.test':
        return { ok: true, latencyMs: 11, model: 'gemini-2.5-flash' }
      case 'ai.models.list':
        return { models: [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }] }
      case 'ai.models.usage':
        return { used: 100, limit: 10000 }
      case 'ai.complete':
        return { suggestion: ' WHERE salary > 5000', id: 42, text: '-- AI\nSELECT id, name FROM employees;' }
      case 'ai.explainAnalyze':
        return {
          summary: 'Add index on dept_id',
          durationMs: 14,
          language: 'en',
          bottlenecks: [{ severity: 'medium', title: 'Full Table Scan', detail: 'Scanning employees without index' }],
          indexSuggestions: [{ reason: 'Speeds up dept lookup', ddl: 'CREATE INDEX idx_emp_dept ON employees(dept_id);' }],
          optimizedSql: 'SELECT id, name FROM employees WHERE dept_id = 1;',
          caveats: ['Small sample size'],
          suggestedSql: 'CREATE INDEX idx_emp_dept ON employees(dept_id);',
        }
      case 'ai.metrics.event':
        return { ok: true }
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
  const emitStorage = (change: { key: string; area?: string }) => {
    for (const cb of storageListeners) cb(change)
  }
  const emitDocReplace = (val: string) => {
    docReplaceCb?.(val)
  }

  const orcaApi = {
    locale: 'en-US',
    on(ev: string, cb: StudioEventCb) {
      if (!hostListeners.has(ev)) hostListeners.set(ev, new Set())
      hostListeners.get(ev)!.add(cb)
      return { dispose: () => hostListeners.get(ev)?.delete(cb) }
    },
    plugin: {
      request: rpcSpy,
      on(ev: string, cb: StudioEventCb) {
        if (!pluginListeners.has(ev)) pluginListeners.set(ev, new Set())
        pluginListeners.get(ev)!.add(cb)
        return { dispose: () => pluginListeners.get(ev)?.delete(cb) }
      },
    },
    settings: {
      get: (k: string) => (k === 'maxRows' ? 200 : undefined),
      onDidChange(cb: StudioEventCb) {
        settingsListeners.add(cb)
        return { dispose: () => settingsListeners.delete(cb) }
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
      onDidChange(cb: StudioEventCb) {
        storageListeners.add(cb)
        return { dispose: () => storageListeners.delete(cb) }
      },
    },
    host: {
      has: () => true,
      call: async (method: string) => {
        if (method === 'editor.readTypography') {
          return { fontFamily: 'Consolas', fontSize: 13 }
        }
        return { ok: true }
      },
    },
    files: {
      saveAs: async (content: string, filters?: unknown) => {
        savedFiles.push({ content, filters })
        return { status: saveAsResult, path: 'D:/studio-export.sql' }
      },
    },
    shell: {
      openExternal: async (url: string) => {
        openedUrls.push(url)
      },
    },
    document: {
      session: async () => ({
        value: docInitialValue,
        change: (next: string) => {
          docChanges.push(next)
        },
        onReplace: (cb: (val: string) => void) => {
          docReplaceCb = cb
          return { dispose: () => { docReplaceCb = null } }
        },
        dispose: () => {},
      }),
    },
  }

  return {
    db,
    connections,
    storageMap,
    savedFiles,
    openedUrls,
    docChanges,
    rpcSpy,
    failOnceActions,
    alwaysFailActions,
    setSaveAsResult: (v: 'saved' | 'cancelled' | 'failed') => { saveAsResult = v },
    setSessionSnapshot: (v: unknown) => { sessionSnapshot = v },
    setDocInitialValue: (v: string) => { docInitialValue = v },
    deferNextQuery: () => { nextQueryDeferred = true },
    resolveDeferredQuery: () => {
      slowQueryGate?.resolve()
      slowQueryGate = null
    },
    setAiStatus: (v: Record<string, unknown>) => { aiStatus = v },
    orcaApi,
    emitHost,
    emitPlugin,
    emitSettings,
    emitStorage,
    emitDocReplace,
  }
}

export async function flushMicro(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
  }
}

export async function flushTick(): Promise<void> {
  await flushMicro(8)
  await new Promise((r) => setTimeout(r, 0))
  await flushMicro(12)
}
