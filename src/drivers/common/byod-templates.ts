// src/drivers/common/byod-templates.ts
// Single canonical source of truth for BYOD starter adapters conforming 100% to
// IDatabaseDriver + IDatabaseSession (TableDetails, TableBrowseResult, QueryResult, ApplyChangesResult, TransactionState).

const BYOD_SQL_READONLY_GUARD_SNIPPET = String.raw`function stripLeadingSqlComments(raw) {
  let s = String(raw || '')
  let prev = ''
  while (s !== prev) {
    prev = s
    s = s.replace(/^\s+/, '').replace(/^--[^\r\n]*/, '').replace(/^\/\*[\s\S]*?\*\//, '')
  }
  return s.trim()
}
function assertReadOnlySql(sql, allowedLeadRe) {
  const clean = stripLeadingSqlComments(sql)
  const noComments = clean.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\r\n]*/g, ' ').replace(/'(?:''|\\.|[^'\\])*'/g, "''")
  if (!allowedLeadRe.test(noComments.trim()) || /\b(?:INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|COPY|ATTACH|DETACH|PUT|GET|BATCH|EXEC|EXECUTE|CALL|GRANT|REVOKE|VACUUM|PRAGMA\s+\w+\s*=)\b/i.test(noComments)) {
    throw new Error('Connection is read-only.')
  }
}`

const BYOD_OPTIONS_PARSER_SNIPPET = String.raw`function parseKeyValueOrJsonOptions(raw) {
  if (!raw || typeof raw !== 'string') return {}
  const trimmed = raw.trim()
  if (!trimmed) return {}
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const safe = {}
        for (const [k, v] of Object.entries(parsed)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
          safe[k] = v
        }
        return safe
      }
    } catch { return {} }
  }
  const out = {}
  const pairs = []
  let cur = ''
  let quote = ''
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (quote) {
      cur += ch
      if (ch === quote && trimmed[i - 1] !== '\\') quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === ',' || ch === ';' || ch === '\n' || ch === '\r') {
      if (cur.trim()) pairs.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) pairs.push(cur.trim())
  for (const part of pairs) {
    const eqIdx = part.indexOf('=')
    if (eqIdx <= 0) continue
    const key = part.slice(0, eqIdx).trim()
    let val = part.slice(eqIdx + 1).trim()
    if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      if (val.length >= 2) val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}`

export function getCanonicalByodStarterCode(driverId: string): string {
  const id = driverId.trim().toLowerCase()
  const safeIdLiteral = JSON.stringify(id || 'custom')

  if (id === 'duckdb') {
    return `// Datanoa BYOD Adapter for DuckDB (npm install @duckdb/node-api)
import { DuckDBInstance } from '@duckdb/node-api'

const TX_UNSUPPORTED = { supported: false, autoCommit: true, active: false, statementCount: 0 }

${BYOD_SQL_READONLY_GUARD_SNIPPET}

function quoteDuckIdent(ident) {
  return '"' + String(ident).replace(/"/g, '""') + '"'
}

function normalizeDuckValue(val) {
  if (typeof val === 'bigint') {
    const n = Number(val)
    return Number.isSafeInteger(n) ? n : val.toString()
  }
  return val === undefined ? null : val
}

export default {
  type: 'duckdb',
  async createSession(profile) {
    const dbPath = (profile.filePath || profile.database || ':memory:').trim() || ':memory:'
    const instance = await DuckDBInstance.create(
      dbPath,
      profile.readOnly ? { access_mode: 'READ_ONLY' } : undefined
    )
    const conn = await instance.connect()
    let closed = false

    const readRows = async (sql) => {
      const reader = await conn.runAndReadAll(sql)
      const names = reader.columnNames ? reader.columnNames() : []
      const types = reader.columnTypesJson ? reader.columnTypesJson() : []
      const rawObjs = reader.getRowObjectsJson ? reader.getRowObjectsJson() : []
      const rows = rawObjs.map((obj) => {
        const out = {}
        for (const k of names) out[k] = normalizeDuckValue(obj[k])
        return out
      })
      return { names, types, rows }
    }

    return {
      driverType: 'duckdb',
      profile,
      isAlive: () => !closed,
      test: async () => {
        await conn.runAndReadAll('SELECT 1 AS ok')
        return { ok: true, message: 'DuckDB connection valid' }
      },
      close: async () => {
        if (closed) return
        closed = true
        conn.closeSync?.()
        instance.closeSync?.()
      },
      listSchemas: async () => {
        const { rows } = await readRows(
          "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema', 'pg_catalog') ORDER BY schema_name"
        )
        const schemas = rows.map((r) => String(r.schema_name || 'main'))
        return { schemas: schemas.length ? schemas : ['main'], defaultSchema: schemas[0] || 'main' }
      },
      listObjects: async (schema) => {
        const filter = schema ? " WHERE table_schema = '" + String(schema).replace(/'/g, "''") + "'" : " WHERE table_schema NOT IN ('information_schema', 'pg_catalog')"
        const { rows } = await readRows(
          'SELECT table_schema AS s, table_name AS n, table_type AS t FROM information_schema.tables' + filter + ' ORDER BY table_schema, table_name'
        )
        return rows.map((r) => ({
          schema: String(r.s || 'main'),
          name: String(r.n),
          kind: String(r.t || '').toUpperCase().includes('VIEW') ? 'view' : 'table',
        }))
      },
      getTableDetails: async (table, schema = 'main') => {
        const sLit = String(schema).replace(/'/g, "''")
        const tLit = String(table).replace(/'/g, "''")
        const { rows } = await readRows(
          "SELECT column_name AS n, data_type AS dt, is_nullable AS nul, column_default AS d FROM information_schema.columns WHERE table_schema = '" + sLit + "' AND table_name = '" + tLit + "' ORDER BY ordinal_position"
        )
        const columns = rows.map((c) => ({
          name: String(c.n),
          type: String(c.dt || 'VARCHAR'),
          nativeType: String(c.dt || 'VARCHAR'),
          nullable: String(c.nul).toUpperCase() === 'YES',
          defaultValue: c.d ?? null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        }))
        return { name: table, schema, kind: 'table', columns, primaryKey: [], indexes: [], foreignKeys: [] }
      },
      fetchPage: async (params) => {
        const schema = params.schema || 'main'
        const page = Math.max(1, Math.floor(Number(params.page) || 1))
        const pageSize = Math.max(1, Math.min(10000, Math.floor(Number(params.pageSize || params.limit) || 100)))
        const offset = params.offset !== undefined ? Math.max(0, Number(params.offset) || 0) : (page - 1) * pageSize
        const qName = quoteDuckIdent(schema) + '.' + quoteDuckIdent(params.table)
        const whereSql = params.whereClause ? ' WHERE ' + params.whereClause : ''
        const orderSql = params.orderByClause
          ? ' ORDER BY ' + params.orderByClause
          : params.sortColumn
            ? ' ORDER BY ' + quoteDuckIdent(params.sortColumn) + ' ' + (String(params.sortDirection || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC')
            : ''
        const countRes = await readRows('SELECT COUNT(*) AS total FROM ' + qName + whereSql)
        const totalRows = Number(countRes.rows[0]?.total ?? 0)
        const dataRes = await readRows('SELECT * FROM ' + qName + whereSql + orderSql + ' LIMIT ' + pageSize + ' OFFSET ' + offset)
        const columns = dataRes.names.map((name, i) => ({
          name,
          type: String(dataRes.types[i] || 'VARCHAR'),
          nativeType: String(dataRes.types[i] || 'VARCHAR'),
          nullable: true,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        }))
        return { columns, rows: dataRes.rows, totalRows, page, pageSize, primaryKey: [], canEdit: false }
      },
      updateCell: async () => { throw new Error('Direct cell update requires SQL console in DuckDB BYOD adapter') },
      applyChanges: async () => { throw new Error('Staged changes require SQL console in DuckDB BYOD adapter') },
      previewChanges: async () => ({ statements: [] }),
      getDdl: async (table, schema = 'main') => '-- DuckDB Object: ' + quoteDuckIdent(schema) + '.' + quoteDuckIdent(table),
      runQuery: async (_queryId, sql, maxRows = 1000) => {
        const start = performance.now()
        if (profile.readOnly) {
          assertReadOnlySql(sql, /^(?:SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|VALUES|SUMMARIZE|TABLE)\\b/i)
        }
        const res = await readRows(sql)
        const limit = maxRows > 0 ? maxRows : res.rows.length
        const truncated = res.rows.length > limit
        const sliced = res.rows.slice(0, limit)
        const columns = res.names.map((name, i) => ({ name, type: String(res.types[i] || 'VARCHAR') }))
        return {
          columns,
          rows: sliced.map((row) => columns.map((c) => row[c.name])),
          rowCount: sliced.length,
          affectedRows: 0,
          executionTimeMs: Math.round(performance.now() - start),
          truncated,
          isSelect: columns.length > 0,
        }
      },
      cancelQuery: async () => ({ ok: false }),
      getTransactionState: () => ({ ...TX_UNSUPPORTED }),
      beginTransaction: async () => ({ ...TX_UNSUPPORTED }),
      commitTransaction: async () => ({ ...TX_UNSUPPORTED }),
      rollbackTransaction: async () => ({ ...TX_UNSUPPORTED }),
      setAutoCommit: async () => ({ ...TX_UNSUPPORTED }),
    }
  },
  async testConnection(profile, password) {
    const session = await this.createSession(profile, password)
    try { return await session.test() } finally { await session.close().catch(() => {}) }
  },
}
`
  }

  if (id === 'snowflake') {
    return `// Datanoa BYOD Adapter for Snowflake (npm install snowflake-sdk)
import snowflake from 'snowflake-sdk'

const TX_UNSUPPORTED = { supported: false, autoCommit: true, active: false, statementCount: 0 }

${BYOD_OPTIONS_PARSER_SNIPPET}
${BYOD_SQL_READONLY_GUARD_SNIPPET}
const parseSfOptions = parseKeyValueOrJsonOptions

function quoteSfIdent(ident) {
  return '"' + String(ident).replace(/"/g, '""') + '"'
}

export default {
  type: 'snowflake',
  async createSession(profile, password) {
    const opts = parseSfOptions(profile.options)
    const conn = snowflake.createConnection({
      account: String(opts.account || profile.host || ''),
      username: profile.user,
      password: password || '',
      database: profile.database || undefined,
      warehouse: opts.warehouse || undefined,
      schema: opts.schema || 'PUBLIC',
      role: opts.role || undefined,
      authenticator: opts.authenticator || undefined,
    })
    await new Promise((resolve, reject) => {
      conn.connect((err, c) => (err ? reject(err) : resolve(c)))
    })
    const activeStmts = new Map()
    let closed = false

    const execSql = (sqlText, binds = [], queryId) =>
      new Promise((resolve, reject) => {
        const stmt = conn.execute({
          sqlText,
          binds,
          complete: (err, executedStmt, rows) => {
            if (queryId) activeStmts.delete(queryId)
            if (err) return reject(err)
            resolve({ stmt: executedStmt, rows: rows || [] })
          },
        })
        if (queryId && stmt) activeStmts.set(queryId, stmt)
      })

    return {
      driverType: 'snowflake',
      profile,
      isAlive: () => !closed && (typeof conn.isUp === 'function' ? conn.isUp() : true),
      test: async () => {
        await execSql('SELECT 1 AS OK')
        return { ok: true, message: 'Snowflake connection valid' }
      },
      close: async () => {
        if (closed) return
        closed = true
        await new Promise((resolve) => conn.destroy(() => resolve()))
      },
      listSchemas: async () => {
        const { rows } = await execSql('SHOW SCHEMAS')
        const schemas = rows.map((r) => String(r.name || r.SCHEMA_NAME || '')).filter(Boolean)
        return { schemas: schemas.length ? schemas : ['PUBLIC'], defaultSchema: String(opts.schema || 'PUBLIC') }
      },
      listObjects: async (schema) => {
        const whereSchema = schema ? ' WHERE TABLE_SCHEMA = ?' : ''
        const binds = schema ? [schema] : []
        const { rows } = await execSql(
          'SELECT TABLE_SCHEMA AS S, TABLE_NAME AS N, TABLE_TYPE AS T FROM INFORMATION_SCHEMA.TABLES' + whereSchema + ' ORDER BY TABLE_SCHEMA, TABLE_NAME',
          binds
        )
        return rows.map((r) => ({
          schema: String(r.S || r.s || 'PUBLIC'),
          name: String(r.N || r.n),
          kind: String(r.T || r.t || '').toUpperCase().includes('VIEW') ? 'view' : 'table',
        }))
      },
      getTableDetails: async (table, schema = 'PUBLIC') => {
        const { rows } = await execSql(
          'SELECT COLUMN_NAME AS N, DATA_TYPE AS DT, IS_NULLABLE AS NUL, COLUMN_DEFAULT AS D FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
          [schema, table]
        )
        const columns = rows.map((c) => ({
          name: String(c.N || c.n),
          type: String(c.DT || c.dt || 'TEXT'),
          nativeType: String(c.DT || c.dt || 'TEXT'),
          nullable: String(c.NUL || c.nul).toUpperCase() === 'YES',
          defaultValue: c.D ?? c.d ?? null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        }))
        return { name: table, schema, kind: 'table', columns, primaryKey: [], indexes: [], foreignKeys: [] }
      },
      fetchPage: async (params) => {
        const schema = params.schema || 'PUBLIC'
        const page = Math.max(1, Math.floor(Number(params.page) || 1))
        const pageSize = Math.max(1, Math.min(10000, Math.floor(Number(params.pageSize || params.limit) || 100)))
        const offset = params.offset !== undefined ? Math.max(0, Number(params.offset) || 0) : (page - 1) * pageSize
        const qName = quoteSfIdent(schema) + '.' + quoteSfIdent(params.table)
        const whereSql = params.whereClause ? ' WHERE ' + params.whereClause : ''
        const orderSql = params.orderByClause
          ? ' ORDER BY ' + params.orderByClause
          : params.sortColumn
            ? ' ORDER BY ' + quoteSfIdent(params.sortColumn) + ' ' + (String(params.sortDirection || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC')
            : ''
        const countRes = await execSql('SELECT COUNT(*) AS TOTAL FROM ' + qName + whereSql)
        const firstCount = countRes.rows[0] || {}
        const totalRows = Number(firstCount.TOTAL ?? firstCount.total ?? 0)
        const dataRes = await execSql('SELECT * FROM ' + qName + whereSql + orderSql + ' LIMIT ' + pageSize + ' OFFSET ' + offset)
        const sfCols = dataRes.stmt && typeof dataRes.stmt.getColumns === 'function' ? dataRes.stmt.getColumns() : []
        const columns = sfCols.length > 0
          ? sfCols.map((c) => ({
              name: c.getName(),
              type: String(c.getType ? c.getType() : 'TEXT'),
              nativeType: String(c.getType ? c.getType() : 'TEXT'),
              nullable: true,
              defaultValue: null,
              isPrimaryKey: false,
              isAutoIncrement: false,
            }))
          : Object.keys(dataRes.rows[0] || {}).map((name) => ({
              name, type: 'TEXT', nativeType: 'TEXT', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false,
            }))
        return { columns, rows: dataRes.rows, totalRows, page, pageSize, primaryKey: [], canEdit: false }
      },
      updateCell: async () => { throw new Error('Direct cell update requires SQL console in Snowflake BYOD adapter') },
      applyChanges: async () => { throw new Error('Staged changes require SQL console in Snowflake BYOD adapter') },
      previewChanges: async () => ({ statements: [] }),
      getDdl: async (table, schema = 'PUBLIC') => {
        try {
          const { rows } = await execSql("SELECT GET_DDL('TABLE', ?) AS DDL", [schema + '.' + table])
          if (rows[0]?.DDL) return String(rows[0].DDL)
        } catch {}
        return '-- Snowflake Object: ' + quoteSfIdent(schema) + '.' + quoteSfIdent(table)
      },
      runQuery: async (queryId, sql, maxRows = 1000) => {
        const start = performance.now()
        if (profile.readOnly) {
          assertReadOnlySql(sql, /^(?:SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|VALUES)\\b/i)
        }
        const { stmt, rows } = await execSql(sql, [], queryId)
        const sfCols = stmt && typeof stmt.getColumns === 'function' ? stmt.getColumns() : []
        const colNames = sfCols.length > 0 ? sfCols.map((c) => c.getName()) : Object.keys(rows[0] || {})
        const columns = colNames.map((name, i) => ({ name, type: String(sfCols[i]?.getType?.() || 'TEXT') }))
        const limit = maxRows > 0 ? maxRows : rows.length
        const truncated = rows.length > limit
        const sliced = rows.slice(0, limit)
        return {
          columns,
          rows: sliced.map((r) => colNames.map((c) => r[c])),
          rowCount: sliced.length,
          affectedRows: stmt && typeof stmt.getNumUpdatedRows === 'function' ? stmt.getNumUpdatedRows() || 0 : 0,
          executionTimeMs: Math.round(performance.now() - start),
          truncated,
          isSelect: columns.length > 0,
        }
      },
      cancelQuery: async (queryId) => {
        const stmt = activeStmts.get(queryId)
        if (stmt && typeof stmt.cancel === 'function') {
          stmt.cancel(() => {})
          return { ok: true }
        }
        return { ok: false }
      },
      getTransactionState: () => ({ ...TX_UNSUPPORTED }),
      beginTransaction: async () => ({ ...TX_UNSUPPORTED }),
      commitTransaction: async () => ({ ...TX_UNSUPPORTED }),
      rollbackTransaction: async () => ({ ...TX_UNSUPPORTED }),
      setAutoCommit: async () => ({ ...TX_UNSUPPORTED }),
    }
  },
  async testConnection(profile, password) {
    const session = await this.createSession(profile, password)
    try { return await session.test() } finally { await session.close().catch(() => {}) }
  },
}
`
  }

  if (id === 'bigquery') {
    return `// Datanoa BYOD Adapter for Google BigQuery (npm install @google-cloud/bigquery)
import { BigQuery } from '@google-cloud/bigquery'

const TX_UNSUPPORTED = { supported: false, autoCommit: true, active: false, statementCount: 0 }

${BYOD_OPTIONS_PARSER_SNIPPET}
${BYOD_SQL_READONLY_GUARD_SNIPPET}
const parseBqOptions = parseKeyValueOrJsonOptions

function quoteBqIdent(ident) {
  return '\`' + String(ident).replace(/\\\\/g, '\\\\\\\\').replace(/\`/g, '\\\\\`') + '\`'
}

export default {
  type: 'bigquery',
  async createSession(profile) {
    const opts = parseBqOptions(profile.options)
    const projectId = opts.projectId || (profile.host && profile.host !== 'localhost' ? profile.host : undefined)
    const keyFilename = opts.keyFilename || profile.filePath || undefined
    const location = opts.location || undefined
    const bq = new BigQuery({
      ...(projectId ? { projectId } : {}),
      ...(keyFilename ? { keyFilename } : {}),
      ...(location ? { location } : {}),
    })
    const defaultDataset = profile.database || opts.dataset || 'default'
    let closed = false

    return {
      driverType: 'bigquery',
      profile,
      isAlive: () => !closed,
      test: async () => {
        await bq.query({ query: 'SELECT 1 AS ok' })
        return { ok: true, message: 'Google BigQuery connection valid' }
      },
      close: async () => { closed = true },
      listSchemas: async () => {
        const [datasets] = await bq.getDatasets()
        const schemas = datasets.map((d) => String(d.id || '')).filter(Boolean)
        return { schemas: schemas.length ? schemas : [defaultDataset], defaultSchema: defaultDataset }
      },
      listObjects: async (schema = defaultDataset) => {
        const [tables] = await bq.dataset(schema).getTables()
        return tables.map((t) => ({
          schema,
          name: String(t.id),
          kind: String(t.metadata?.type || '').toUpperCase().includes('VIEW') ? 'view' : 'table',
        }))
      },
      getTableDetails: async (table, schema = defaultDataset) => {
        const [meta] = await bq.dataset(schema).table(table).getMetadata()
        const fields = meta?.schema?.fields || []
        const columns = fields.map((f) => ({
          name: String(f.name),
          type: String(f.type || 'STRING'),
          nativeType: String(f.type || 'STRING'),
          nullable: f.mode !== 'REQUIRED',
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        }))
        return { name: table, schema, kind: 'table', columns, primaryKey: [], indexes: [], foreignKeys: [] }
      },
      fetchPage: async (params) => {
        const schema = params.schema || defaultDataset
        const page = Math.max(1, Math.floor(Number(params.page) || 1))
        const pageSize = Math.max(1, Math.min(10000, Math.floor(Number(params.pageSize || params.limit) || 100)))
        const offset = params.offset !== undefined ? Math.max(0, Number(params.offset) || 0) : (page - 1) * pageSize
        const qName = quoteBqIdent(schema) + '.' + quoteBqIdent(params.table)
        const whereSql = params.whereClause ? ' WHERE ' + params.whereClause : ''
        const orderSql = params.orderByClause
          ? ' ORDER BY ' + params.orderByClause
          : params.sortColumn
            ? ' ORDER BY ' + quoteBqIdent(params.sortColumn) + ' ' + (String(params.sortDirection || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC')
            : ''
        const [countRows] = await bq.query({ query: 'SELECT COUNT(*) AS total FROM ' + qName + whereSql })
        const totalRows = Number(countRows[0]?.total ?? 0)
        const [rows] = await bq.query({ query: 'SELECT * FROM ' + qName + whereSql + orderSql + ' LIMIT ' + pageSize + ' OFFSET ' + offset })
        const columns = Object.keys(rows[0] || {}).map((name) => ({
          name, type: 'STRING', nativeType: 'STRING', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false,
        }))
        return { columns, rows, totalRows, page, pageSize, primaryKey: [], canEdit: false }
      },
      updateCell: async () => { throw new Error('Direct cell update requires SQL console in BigQuery BYOD adapter') },
      applyChanges: async () => { throw new Error('Staged changes require SQL console in BigQuery BYOD adapter') },
      previewChanges: async () => ({ statements: [] }),
      getDdl: async (table, schema = defaultDataset) => '-- BigQuery Table: ' + quoteBqIdent(schema) + '.' + quoteBqIdent(table),
      runQuery: async (_queryId, sql, maxRows = 1000) => {
        const start = performance.now()
        if (profile.readOnly) {
          assertReadOnlySql(sql, /^(?:SELECT|WITH|EXPLAIN|VALUES)\\b/i)
        }
        const [rows] = await bq.query({ query: sql, ...(maxRows > 0 ? { maxResults: maxRows + 1 } : {}) })
        const limit = maxRows > 0 ? maxRows : rows.length
        const truncated = rows.length > limit
        const sliced = rows.slice(0, limit)
        const colNames = Object.keys(sliced[0] || {})
        const columns = colNames.map((name) => ({ name, type: 'STRING' }))
        return {
          columns,
          rows: sliced.map((r) => colNames.map((c) => (r[c]?.value !== undefined ? r[c].value : r[c]))),
          rowCount: sliced.length,
          affectedRows: 0,
          executionTimeMs: Math.round(performance.now() - start),
          truncated,
          isSelect: columns.length > 0,
        }
      },
      cancelQuery: async () => ({ ok: false }),
      getTransactionState: () => ({ ...TX_UNSUPPORTED }),
      beginTransaction: async () => ({ ...TX_UNSUPPORTED }),
      commitTransaction: async () => ({ ...TX_UNSUPPORTED }),
      rollbackTransaction: async () => ({ ...TX_UNSUPPORTED }),
      setAutoCommit: async () => ({ ...TX_UNSUPPORTED }),
    }
  },
  async testConnection(profile, password) {
    const session = await this.createSession(profile, password)
    try { return await session.test() } finally { await session.close().catch(() => {}) }
  },
}
`
  }

  if (id === 'cassandra') {
    return `// Datanoa BYOD Adapter for Apache Cassandra / ScyllaDB (npm install cassandra-driver)
import cassandra from 'cassandra-driver'

const TX_UNSUPPORTED = { supported: false, autoCommit: true, active: false, statementCount: 0 }

${BYOD_OPTIONS_PARSER_SNIPPET}
${BYOD_SQL_READONLY_GUARD_SNIPPET}
const parseCassOptions = parseKeyValueOrJsonOptions

function quoteCqlIdent(ident) {
  return '"' + String(ident).replace(/"/g, '""') + '"'
}

export default {
  type: 'cassandra',
  async createSession(profile, password) {
    const opts = parseCassOptions(profile.options)
    const contactPoints = (profile.host || '127.0.0.1').split(',').map((h) => h.trim()).filter(Boolean)
    const client = new cassandra.Client({
      contactPoints,
      protocolOptions: { port: Number(profile.port) || 9042 },
      localDataCenter: String(opts.localDataCenter || 'datacenter1'),
      ...(profile.database ? { keyspace: profile.database } : {}),
      ...(profile.user ? { credentials: { username: profile.user, password: password || '' } } : {}),
      ...(profile.ssl ? { sslOptions: { rejectUnauthorized: Boolean(profile.sslRejectUnauthorized ?? (profile.sslMode !== 'require')) } } : {}),
    })
    await client.connect()
    let closed = false

    return {
      driverType: 'cassandra',
      profile,
      isAlive: () => !closed,
      test: async () => {
        await client.execute('SELECT now() FROM system.local')
        return { ok: true, message: 'Cassandra connection valid' }
      },
      close: async () => {
        if (closed) return
        closed = true
        await client.shutdown()
      },
      listSchemas: async () => {
        const res = await client.execute('SELECT keyspace_name FROM system_schema.keyspaces')
        const schemas = (res.rows || []).map((r) => String(r.keyspace_name)).filter(Boolean)
        const def = profile.database || schemas[0] || 'system'
        return { schemas: schemas.length ? schemas : [def], defaultSchema: def }
      },
      listObjects: async (schema) => {
        const ks = schema || profile.database
        const tableQuery = ks
          ? ['SELECT keyspace_name, table_name FROM system_schema.tables WHERE keyspace_name = ?', [ks]]
          : ['SELECT keyspace_name, table_name FROM system_schema.tables', []]
        const viewQuery = ks
          ? ['SELECT keyspace_name, view_name FROM system_schema.views WHERE keyspace_name = ?', [ks]]
          : ['SELECT keyspace_name, view_name FROM system_schema.views', []]
        const [tblRes, viewRes] = await Promise.all([
          client.execute(tableQuery[0], tableQuery[1], { prepare: true }),
          client.execute(viewQuery[0], viewQuery[1], { prepare: true }).catch(() => ({ rows: [] })),
        ])
        const out = (tblRes.rows || []).map((r) => ({
          schema: String(r.keyspace_name),
          name: String(r.table_name),
          kind: 'table',
        }))
        for (const v of viewRes.rows || []) {
          out.push({ schema: String(v.keyspace_name), name: String(v.view_name), kind: 'view' })
        }
        return out
      },
      getTableDetails: async (table, schema = profile.database || 'system') => {
        const res = await client.execute(
          'SELECT column_name, type, kind FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?',
          [schema, table],
          { prepare: true }
        )
        const primaryKey = []
        const columns = (res.rows || []).map((c) => {
          const isPk = c.kind === 'partition_key' || c.kind === 'clustering'
          if (isPk) primaryKey.push(String(c.column_name))
          return {
            name: String(c.column_name),
            type: String(c.type || 'text'),
            nativeType: String(c.type || 'text'),
            nullable: !isPk,
            defaultValue: null,
            isPrimaryKey: isPk,
            isAutoIncrement: false,
          }
        })
        return { name: table, schema, kind: 'table', columns, primaryKey, indexes: [], foreignKeys: [] }
      },
      fetchPage: async (params) => {
        const schema = params.schema || profile.database || 'system'
        const page = Math.max(1, Math.floor(Number(params.page) || 1))
        const pageSize = Math.max(1, Math.min(10000, Math.floor(Number(params.pageSize || params.limit) || 100)))
        const qName = quoteCqlIdent(schema) + '.' + quoteCqlIdent(params.table)
        const whereSql = params.whereClause ? ' WHERE ' + params.whereClause + ' ALLOW FILTERING' : ''
        const res = await client.execute('SELECT * FROM ' + qName + whereSql + ' LIMIT ' + pageSize)
        const rows = (res.rows || []).map((r) => ({ ...r }))
        const columns = (res.columns || []).map((c) => ({
          name: String(c.name),
          type: 'text',
          nativeType: 'text',
          nullable: true,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        }))
        return { columns, rows, totalRows: rows.length, page, pageSize, primaryKey: [], canEdit: false }
      },
      updateCell: async () => { throw new Error('Direct cell update requires CQL console in Cassandra BYOD adapter') },
      applyChanges: async () => { throw new Error('Staged changes require CQL console in Cassandra BYOD adapter') },
      previewChanges: async () => ({ statements: [] }),
      getDdl: async (table, schema = profile.database || 'system') => '-- Cassandra Table: ' + quoteCqlIdent(schema) + '.' + quoteCqlIdent(table),
      runQuery: async (_queryId, cql, maxRows = 1000) => {
        const start = performance.now()
        if (profile.readOnly) {
          assertReadOnlySql(cql, /^(?:SELECT|DESCRIBE|DESC|LIST)\\b/i)
        }
        const res = await client.execute(cql, [], { prepare: false })
        const rawRows = res.rows || []
        const limit = maxRows > 0 ? maxRows : rawRows.length
        const truncated = rawRows.length > limit
        const sliced = rawRows.slice(0, limit)
        const columns = (res.columns || []).map((c) => ({ name: String(c.name), type: 'text' }))
        return {
          columns,
          rows: sliced.map((row) => columns.map((col) => row[col.name])),
          rowCount: sliced.length,
          affectedRows: 0,
          executionTimeMs: Math.round(performance.now() - start),
          truncated,
          isSelect: columns.length > 0,
        }
      },
      cancelQuery: async () => ({ ok: false }),
      getTransactionState: () => ({ ...TX_UNSUPPORTED }),
      beginTransaction: async () => ({ ...TX_UNSUPPORTED }),
      commitTransaction: async () => ({ ...TX_UNSUPPORTED }),
      rollbackTransaction: async () => ({ ...TX_UNSUPPORTED }),
      setAutoCommit: async () => ({ ...TX_UNSUPPORTED }),
    }
  },
  async testConnection(profile, password) {
    const session = await this.createSession(profile, password)
    try { return await session.test() } finally { await session.close().catch(() => {}) }
  },
}
`
  }

  if (id === 'elasticsearch') {
    return `// Datanoa BYOD Adapter for Elasticsearch / OpenSearch (npm install @elastic/elasticsearch)
import { Client } from '@elastic/elasticsearch'

const TX_UNSUPPORTED = { supported: false, autoCommit: true, active: false, statementCount: 0 }

export default {
  type: 'elasticsearch',
  async createSession(profile, password) {
    const node =
      profile.url ||
      (profile.ssl ? 'https' : 'http') + '://' + (profile.host || 'localhost') + ':' + (Number(profile.port) || 9200)
    const client = new Client({
      node,
      ...(profile.user ? { auth: { username: profile.user, password: password || '' } } : {}),
      ...(profile.ssl ? { tls: { rejectUnauthorized: Boolean(profile.sslRejectUnauthorized ?? (profile.sslMode !== 'require')) } } : {}),
    })
    let closed = false

    const flattenProps = (props, prefix = '') => {
      const cols = []
      for (const [k, def] of Object.entries(props || {})) {
        const name = prefix ? prefix + '.' + k : k
        const typeStr = String(def?.type || (def?.properties ? 'object' : 'text'))
        cols.push({
          name,
          type: typeStr,
          nativeType: typeStr,
          nullable: true,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        })
        if (def?.properties) cols.push(...flattenProps(def.properties, name))
      }
      return cols
    }

    return {
      driverType: 'elasticsearch',
      profile,
      isAlive: () => !closed,
      test: async () => {
        await client.ping()
        return { ok: true, message: 'Elasticsearch connection valid' }
      },
      close: async () => {
        if (closed) return
        closed = true
        await client.close()
      },
      listObjects: async () => {
        const indices = await client.cat.indices({ format: 'json' })
        return (indices || [])
          .filter((idx) => idx.index && !String(idx.index).startsWith('.'))
          .map((idx) => ({ schema: 'default', name: String(idx.index), kind: 'table' }))
      },
      getTableDetails: async (table, schema = 'default') => {
        const mapping = await client.indices.getMapping({ index: table })
        const idxEntry = mapping?.[table] || Object.values(mapping || {})[0] || {}
        const props = idxEntry?.mappings?.properties || {}
        const columns = [
          { name: '_id', type: 'keyword', nativeType: '_id', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: false },
          ...flattenProps(props),
        ]
        return { name: table, schema, kind: 'table', columns, primaryKey: ['_id'], indexes: [], foreignKeys: [] }
      },
      fetchPage: async (params) => {
        const page = Math.max(1, Math.floor(Number(params.page) || 1))
        const pageSize = Math.max(1, Math.min(10000, Math.floor(Number(params.pageSize || params.limit) || 100)))
        const offset = params.offset !== undefined ? Math.max(0, Number(params.offset) || 0) : (page - 1) * pageSize
        let query = { match_all: {} }
        if (params.whereClause && String(params.whereClause).trim().startsWith('{')) {
          query = JSON.parse(String(params.whereClause).trim())
        }
        const sort = params.sortColumn
          ? [{ [params.sortColumn]: { order: String(params.sortDirection || 'ASC').toUpperCase() === 'DESC' ? 'desc' : 'asc' } }]
          : undefined
        const res = await client.search({
          index: params.table,
          from: offset,
          size: pageSize,
          query,
          ...(sort ? { sort } : {}),
        })
        const hits = res?.hits?.hits || []
        const rawTotal = res?.hits?.total
        const totalRows = typeof rawTotal === 'number' ? rawTotal : Number(rawTotal?.value ?? hits.length)
        const rows = hits.map((h) => ({ _id: h._id, ...(h._source || {}) }))
        const keySet = new Set(['_id'])
        for (const r of rows) Object.keys(r).forEach((k) => keySet.add(k))
        const columns = Array.from(keySet).map((name) => ({
          name,
          type: name === '_id' ? 'keyword' : 'text',
          nativeType: name === '_id' ? 'keyword' : 'text',
          nullable: name !== '_id',
          defaultValue: null,
          isPrimaryKey: name === '_id',
          isAutoIncrement: false,
        }))
        return { columns, rows, totalRows, page, pageSize, primaryKey: ['_id'], canEdit: false }
      },
      updateCell: async () => { throw new Error('Direct cell update requires DSL console in Elasticsearch BYOD adapter') },
      applyChanges: async () => { throw new Error('Staged changes require DSL console in Elasticsearch BYOD adapter') },
      previewChanges: async () => ({ statements: [] }),
      getDdl: async (table) => {
        const info = await client.indices.get({ index: table })
        return JSON.stringify(info, null, 2)
      },
      runQuery: async (_queryId, rawQuery, maxRows = 1000) => {
        const start = performance.now()
        const trimmed = String(rawQuery || '').trim()
        if (trimmed.startsWith('{')) {
          const payload = JSON.parse(trimmed)
          if (profile.readOnly && (payload.doc || payload.script || payload.delete || payload.index_op === 'write')) {
            throw new Error('Connection is read-only.')
          }
          const searchRes = await client.search({
            index: payload.index || '_all',
            from: payload.from || 0,
            size: Math.min(Number(payload.size || maxRows || 100), maxRows || 1000),
            query: payload.query || { match_all: {} },
          })
          const hits = searchRes?.hits?.hits || []
          const rowsObj = hits.map((h) => ({ _id: h._id, _index: h._index, ...(h._source || {}) }))
          const colNames = Array.from(rowsObj.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s }, new Set()))
          const columns = colNames.map((name) => ({ name: String(name), type: 'json' }))
          return {
            columns,
            rows: rowsObj.map((r) => colNames.map((c) => r[c] ?? null)),
            rowCount: rowsObj.length,
            affectedRows: 0,
            executionTimeMs: Math.round(performance.now() - start),
            truncated: false,
            isSelect: true,
          }
        }
        if (profile.readOnly && /^\\s*(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|PUT|POST)\\b/i.test(trimmed)) {
          throw new Error('Connection is read-only.')
        }
        if (client.sql && typeof client.sql.query === 'function') {
          const sqlRes = await client.sql.query({ query: trimmed })
          const columns = (sqlRes.columns || []).map((c) => ({ name: String(c.name), type: String(c.type || 'text') }))
          const rows = sqlRes.rows || []
          return {
            columns,
            rows,
            rowCount: rows.length,
            affectedRows: 0,
            executionTimeMs: Math.round(performance.now() - start),
            truncated: false,
            isSelect: true,
          }
        }
        throw new Error('Provide an Elasticsearch JSON query {"index":"...","query":{...}}')
      },
      cancelQuery: async () => ({ ok: false }),
      getTransactionState: () => ({ ...TX_UNSUPPORTED }),
      beginTransaction: async () => ({ ...TX_UNSUPPORTED }),
      commitTransaction: async () => ({ ...TX_UNSUPPORTED }),
      rollbackTransaction: async () => ({ ...TX_UNSUPPORTED }),
      setAutoCommit: async () => ({ ...TX_UNSUPPORTED }),
    }
  },
  async testConnection(profile, password) {
    const session = await this.createSession(profile, password)
    try { return await session.test() } finally { await session.close().catch(() => {}) }
  },
}
`
  }

  if (id === 'neo4j') {
    return `// Datanoa BYOD Adapter for Neo4j Graph DB (npm install neo4j-driver)
import neo4j from 'neo4j-driver'

const TX_UNSUPPORTED = { supported: false, autoCommit: true, active: false, statementCount: 0 }

function normalizeNeo4jValue(val) {
  if (val === null || val === undefined) return null
  if (typeof neo4j.isInt === 'function' && neo4j.isInt(val)) {
    return val.inSafeRange() ? val.toNumber() : val.toString()
  }
  if (Array.isArray(val)) return val.map((item) => normalizeNeo4jValue(item))
  if (typeof val === 'object') {
    if ('properties' in val && 'labels' in val) {
      return { id: val.elementId || String(val.identity || ''), labels: val.labels, properties: normalizeNeo4jValue(val.properties) }
    }
    const out = {}
    for (const [k, v] of Object.entries(val)) out[k] = normalizeNeo4jValue(v)
    return out
  }
  return val
}

function quoteLabel(label) {
  return '\`' + String(label).replace(/\`/g, '\`\`') + '\`'
}

export default {
  type: 'neo4j',
  async createSession(profile, password) {
    const uri =
      profile.url ||
      (profile.ssl ? 'neo4j+s' : 'bolt') + '://' + (profile.host || 'localhost') + ':' + (Number(profile.port) || 7687)
    const auth = profile.user ? neo4j.auth.basic(profile.user, password || '') : undefined
    const driver = neo4j.driver(uri, auth)
    const database = profile.database || undefined
    let closed = false

    const runCypher = async (cypher, params = {}) => {
      const session = driver.session({
        ...(database ? { database } : {}),
        ...(profile.readOnly && neo4j.session?.READ ? { defaultAccessMode: neo4j.session.READ } : {}),
      })
      try {
        return await session.run(cypher, params)
      } finally {
        await session.close()
      }
    }

    return {
      driverType: 'neo4j',
      profile,
      isAlive: () => !closed,
      test: async () => {
        await driver.verifyConnectivity()
        return { ok: true, message: 'Neo4j connection valid' }
      },
      close: async () => {
        if (closed) return
        closed = true
        await driver.close()
      },
      listSchemas: async () => {
        const dbName = database || 'neo4j'
        return { schemas: [dbName], defaultSchema: dbName }
      },
      listObjects: async () => {
        const res = await runCypher('CALL db.labels() YIELD label RETURN label ORDER BY label')
        const schema = database || 'neo4j'
        return (res.records || []).map((rec) => ({
          schema,
          name: String(rec.get(0)),
          kind: 'table',
        }))
      },
      getTableDetails: async (label, schema = database || 'neo4j') => {
        const res = await runCypher('MATCH (n:' + quoteLabel(label) + ') RETURN properties(n) AS props LIMIT 25')
        const keySet = new Set(['_id'])
        for (const rec of res.records || []) {
          const props = rec.get('props') || {}
          Object.keys(props).forEach((k) => keySet.add(k))
        }
        const columns = Array.from(keySet).map((name) => ({
          name,
          type: name === '_id' ? 'String' : 'Any',
          nativeType: name === '_id' ? 'elementId' : 'property',
          nullable: name !== '_id',
          defaultValue: null,
          isPrimaryKey: name === '_id',
          isAutoIncrement: false,
        }))
        return { name: label, schema, kind: 'table', columns, primaryKey: ['_id'], indexes: [], foreignKeys: [] }
      },
      fetchPage: async (params) => {
        const page = Math.max(1, Math.floor(Number(params.page) || 1))
        const pageSize = Math.max(1, Math.min(10000, Math.floor(Number(params.pageSize || params.limit) || 100)))
        const offset = params.offset !== undefined ? Math.max(0, Number(params.offset) || 0) : (page - 1) * pageSize
        const qLabel = quoteLabel(params.table)
        const countRes = await runCypher('MATCH (n:' + qLabel + ') RETURN COUNT(n) AS total')
        const totalRows = Number(normalizeNeo4jValue(countRes.records?.[0]?.get?.('total')) ?? 0)
        const dataRes = await runCypher(
          'MATCH (n:' + qLabel + ') RETURN elementId(n) AS _id, properties(n) AS props SKIP $skip LIMIT $limit',
          { skip: offset, limit: pageSize }
        )
        const rows = (dataRes.records || []).map((rec) => {
          const props = normalizeNeo4jValue(rec.get('props')) || {}
          return { _id: normalizeNeo4jValue(rec.get('_id')), ...(typeof props === 'object' ? props : {}) }
        })
        const keySet = new Set(['_id'])
        for (const r of rows) Object.keys(r).forEach((k) => keySet.add(k))
        const columns = Array.from(keySet).map((name) => ({
          name, type: 'Any', nativeType: 'Any', nullable: name !== '_id', defaultValue: null, isPrimaryKey: name === '_id', isAutoIncrement: false,
        }))
        return { columns, rows, totalRows, page, pageSize, primaryKey: ['_id'], canEdit: false }
      },
      updateCell: async () => { throw new Error('Direct cell update requires Cypher console in Neo4j BYOD adapter') },
      applyChanges: async () => { throw new Error('Staged changes require Cypher console in Neo4j BYOD adapter') },
      previewChanges: async () => ({ statements: [] }),
      getDdl: async (label) => '// Neo4j Node Label: :' + label,
      runQuery: async (_queryId, cypher, maxRows = 1000) => {
        const start = performance.now()
        if (profile.readOnly && /\\b(?:CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP)\\b/i.test(cypher)) {
          throw new Error('Connection is read-only.')
        }
        const res = await runCypher(cypher)
        const recs = res.records || []
        const keys = recs.length > 0 ? recs[0].keys.map((k) => String(k)) : []
        const limit = maxRows > 0 ? maxRows : recs.length
        const truncated = recs.length > limit
        const sliced = recs.slice(0, limit)
        return {
          columns: keys.map((name) => ({ name, type: 'Any' })),
          rows: sliced.map((rec) => keys.map((k) => normalizeNeo4jValue(rec.get(k)))),
          rowCount: sliced.length,
          affectedRows: 0,
          executionTimeMs: Math.round(performance.now() - start),
          truncated,
          isSelect: keys.length > 0,
        }
      },
      cancelQuery: async () => ({ ok: false }),
      getTransactionState: () => ({ ...TX_UNSUPPORTED }),
      beginTransaction: async () => ({ ...TX_UNSUPPORTED }),
      commitTransaction: async () => ({ ...TX_UNSUPPORTED }),
      rollbackTransaction: async () => ({ ...TX_UNSUPPORTED }),
      setAutoCommit: async () => ({ ...TX_UNSUPPORTED }),
    }
  },
  async testConnection(profile, password) {
    const session = await this.createSession(profile, password)
    try { return await session.test() } finally { await session.close().catch(() => {}) }
  },
}
`
  }

  if (id === 'mssql') {
    return `// Datanoa BYOD Adapter for Microsoft SQL Server (npm install mssql)
import mssql from 'mssql'

const TX_UNSUPPORTED = { supported: false, autoCommit: true, active: false, statementCount: 0 }

${BYOD_SQL_READONLY_GUARD_SNIPPET}

export default {
  type: 'mssql',
  async createSession(profile, password) {
    const pool = new mssql.ConnectionPool({
      server: profile.host || 'localhost',
      port: Number(profile.port) || 1433,
      user: profile.user || 'sa',
      password: password || '',
      database: profile.database || 'master',
      options: { encrypt: Boolean(profile.ssl), trustServerCertificate: !profile.ssl },
    })
    await pool.connect()
    return {
      driverType: 'mssql',
      profile,
      isAlive: () => Boolean(pool.connected),
      test: async () => {
        await pool.request().query('SELECT 1 AS ok')
        return { ok: true, message: 'SQL Server connection valid' }
      },
      close: async () => { await pool.close() },
      listObjects: async () => {
        const res = await pool.request().query(
          "SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n, TABLE_TYPE AS t FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME"
        )
        return (res.recordset || []).map((r) => ({
          schema: r.s || 'dbo',
          name: r.n,
          kind: r.t === 'VIEW' ? 'view' : 'table',
        }))
      },
      getTableDetails: async (table, schema = 'dbo') => {
        const req = pool.request()
        req.input('s', schema)
        req.input('t', table)
        const colRes = await req.query(
          "SELECT COLUMN_NAME AS n, DATA_TYPE AS dt, IS_NULLABLE AS nul, COLUMN_DEFAULT AS d FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @s AND TABLE_NAME = @t ORDER BY ORDINAL_POSITION"
        )
        const pkReq = pool.request()
        pkReq.input('s', schema)
        pkReq.input('t', table)
        const pkRes = await pkReq.query(
          "SELECT kcu.COLUMN_NAME AS n FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = @s AND tc.TABLE_NAME = @t ORDER BY kcu.ORDINAL_POSITION"
        )
        const primaryKey = (pkRes.recordset || []).map((r) => String(r.n))
        const pkSet = new Set(primaryKey)
        const columns = (colRes.recordset || []).map((c) => ({
          name: String(c.n),
          type: String(c.dt || 'text'),
          nativeType: String(c.dt || 'text'),
          nullable: c.nul === 'YES',
          defaultValue: c.d ?? null,
          isPrimaryKey: pkSet.has(String(c.n)),
          isAutoIncrement: false,
        }))
        return { name: table, schema, kind: 'table', columns, primaryKey, indexes: [], foreignKeys: [] }
      },
      fetchPage: async (params) => {
        const schema = params.schema || 'dbo'
        const page = Math.max(1, Math.floor(Number(params.page) || 1))
        const pageSize = Math.max(1, Math.min(10000, Math.floor(Number(params.pageSize || params.limit) || 100)))
        const offset = params.offset !== undefined ? Math.max(0, Number(params.offset) || 0) : (page - 1) * pageSize
        const qName = \`[\${String(schema).replace(/\\]/g, ']]')}].[\${String(params.table).replace(/\\]/g, ']]')}]\`
        const whereSql = params.whereClause ? \` WHERE \${params.whereClause}\` : ''
        const orderSql = params.orderByClause
          ? \` ORDER BY \${params.orderByClause}\`
          : params.sortColumn
            ? \` ORDER BY [\${String(params.sortColumn).replace(/\\]/g, ']]')}] \${String(params.sortDirection || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}\`
            : ' ORDER BY (SELECT NULL)'
        const countRes = await pool.request().query(\`SELECT COUNT(*) AS total FROM \${qName}\${whereSql}\`)
        const totalRows = Number(countRes.recordset?.[0]?.total ?? 0)
        const res = await pool.request().query(
          \`SELECT * FROM \${qName}\${whereSql}\${orderSql} OFFSET \${offset} ROWS FETCH NEXT \${pageSize} ROWS ONLY\`
        )
        const rows = res.recordset || []
        let columns = []
        if (rows.length > 0) {
          columns = Object.keys(rows[0]).map((name) => ({
            name,
            type: 'text',
            nativeType: 'text',
            nullable: true,
            defaultValue: null,
            isPrimaryKey: false,
            isAutoIncrement: false,
          }))
        } else {
          const metaReq = pool.request()
          metaReq.input('s', schema)
          metaReq.input('t', params.table)
          const metaRes = await metaReq.query(
            "SELECT COLUMN_NAME AS n, DATA_TYPE AS dt, IS_NULLABLE AS nul, COLUMN_DEFAULT AS d FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @s AND TABLE_NAME = @t ORDER BY ORDINAL_POSITION"
          )
          columns = (metaRes.recordset || []).map((c) => ({
            name: String(c.n),
            type: String(c.dt || 'text'),
            nativeType: String(c.dt || 'text'),
            nullable: c.nul === 'YES',
            defaultValue: c.d ?? null,
            isPrimaryKey: false,
            isAutoIncrement: false,
          }))
        }
        return {
          columns,
          rows,
          totalRows,
          page,
          pageSize,
          primaryKey: [],
          canEdit: false,
        }
      },
      updateCell: async () => { throw new Error('Direct cell update requires SQL console in MSSQL BYOD adapter') },
      applyChanges: async () => { throw new Error('Staged changes require SQL console in MSSQL BYOD adapter') },
      previewChanges: async () => ({ statements: [] }),
      getDdl: async (table, schema = 'dbo') => \`-- SQL Server Object: [\${schema}].[\${table}]\`,
      runQuery: async (_queryId, sql) => {
        const start = performance.now()
        if (profile.readOnly) {
          assertReadOnlySql(sql, /^(?:SELECT|WITH|VALUES)\\b/i)
        }
        const res = await pool.request().query(sql)
        const rec = res.recordset || []
        const columns = rec.length > 0 ? Object.keys(rec[0]).map((name) => ({ name, type: 'text' })) : []
        return {
          columns,
          rows: rec.map((row) => columns.map((col) => row[col.name])),
          rowCount: rec.length,
          affectedRows: res.rowsAffected?.[0] ?? 0,
          executionTimeMs: Math.round(performance.now() - start),
          truncated: false,
          isSelect: columns.length > 0,
        }
      },
      cancelQuery: async () => ({ ok: false }),
      getTransactionState: () => ({ ...TX_UNSUPPORTED }),
      beginTransaction: async () => ({ ...TX_UNSUPPORTED }),
      commitTransaction: async () => ({ ...TX_UNSUPPORTED }),
      rollbackTransaction: async () => ({ ...TX_UNSUPPORTED }),
      setAutoCommit: async () => ({ ...TX_UNSUPPORTED }),
    }
  },
  async testConnection(profile, password) {
    const session = await this.createSession(profile, password)
    try { return await session.test() } finally { await session.close().catch(() => {}) }
  },
}
`
  }

  if (id === 'oracle') {
    return `// Datanoa BYOD Adapter for Oracle Database Thin Mode (npm install oracledb)
import oracledb from 'oracledb'

const TX_UNSUPPORTED = { supported: false, autoCommit: true, active: false, statementCount: 0 }

${BYOD_SQL_READONLY_GUARD_SNIPPET}

export default {
  type: 'oracle',
  async createSession(profile, password) {
    const conn = await oracledb.getConnection({
      user: profile.user,
      password: password || '',
      connectString: \`\${profile.host || 'localhost'}:\${Number(profile.port) || 1521}/\${profile.database || 'FREEPDB1'}\`,
    })
    const defaultSchema = (profile.user || 'USER').toUpperCase()
    let closed = false
    return {
      driverType: 'oracle',
      profile,
      isAlive: () => !closed,
      test: async () => {
        await conn.execute('SELECT 1 FROM DUAL')
        return { ok: true, message: 'Oracle Database connection valid' }
      },
      close: async () => {
        if (closed) return
        closed = true
        await conn.close()
      },
      listObjects: async () => {
        const res = await conn.execute(
          "SELECT OBJECT_NAME, OBJECT_TYPE FROM USER_OBJECTS WHERE OBJECT_TYPE IN ('TABLE','VIEW') ORDER BY OBJECT_NAME"
        )
        return (res.rows || []).map((r) => ({
          schema: defaultSchema,
          name: String(r[0]),
          kind: r[1] === 'VIEW' ? 'view' : 'table',
        }))
      },
      getTableDetails: async (table, schema = defaultSchema) => {
        const res = await conn.execute(
          'SELECT COLUMN_NAME, DATA_TYPE, NULLABLE FROM USER_TAB_COLUMNS WHERE TABLE_NAME = :t ORDER BY COLUMN_ID',
          { t: table }
        )
        const columns = (res.rows || []).map((r) => ({
          name: String(r[0]),
          type: String(r[1]),
          nativeType: String(r[1]),
          nullable: r[2] === 'Y',
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        }))
        return { name: table, schema, kind: 'table', columns, primaryKey: [], indexes: [], foreignKeys: [] }
      },
      fetchPage: async (params) => {
        const page = Math.max(1, Math.floor(Number(params.page) || 1))
        const pageSize = Math.max(1, Math.min(10000, Math.floor(Number(params.pageSize || params.limit) || 100)))
        const offset = params.offset !== undefined ? Math.max(0, Number(params.offset) || 0) : (page - 1) * pageSize
        const qTable = \`"\${String(params.table).replace(/"/g, '""')}"\`
        const whereSql = params.whereClause ? \` WHERE \${params.whereClause}\` : ''
        const orderSql = params.orderByClause
          ? \` ORDER BY \${params.orderByClause}\`
          : params.sortColumn
            ? \` ORDER BY "\${String(params.sortColumn).replace(/"/g, '""')}" \${String(params.sortDirection || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}\`
            : ''
        const countRes = await conn.execute(\`SELECT COUNT(*) FROM \${qTable}\${whereSql}\`)
        const totalRows = Number(countRes.rows?.[0]?.[0] ?? 0)
        const res = await conn.execute(\`SELECT * FROM \${qTable}\${whereSql}\${orderSql} OFFSET \${offset} ROWS FETCH NEXT \${pageSize} ROWS ONLY\`)
        const colNames = (res.metaData || []).map((m) => String(m.name))
        const columns = colNames.map((name) => ({
          name,
          type: 'text',
          nativeType: 'text',
          nullable: true,
          defaultValue: null,
          isPrimaryKey: false,
          isAutoIncrement: false,
        }))
        const rows = (res.rows || []).map((arr) => {
          const obj = {}
          colNames.forEach((c, idx) => { obj[c] = Array.isArray(arr) ? arr[idx] : arr?.[c] })
          return obj
        })
        return {
          columns,
          rows,
          totalRows,
          page,
          pageSize,
          primaryKey: [],
          canEdit: false,
        }
      },
      updateCell: async () => { throw new Error('Direct cell update requires SQL console in Oracle BYOD adapter') },
      applyChanges: async () => { throw new Error('Staged changes require SQL console in Oracle BYOD adapter') },
      previewChanges: async () => ({ statements: [] }),
      getDdl: async (table) => \`-- Oracle Object: "\${table}"\`,
      runQuery: async (_queryId, sql) => {
        const start = performance.now()
        let res
        if (profile.readOnly) {
          assertReadOnlySql(sql, /^(?:SELECT|WITH|EXPLAIN\\s+PLAN)\\b/i)
          res = await conn.execute(sql, [], { autoCommit: false })
        } else {
          res = await conn.execute(sql, [], { autoCommit: true })
        }
        const columns = (res.metaData || []).map((m) => ({ name: String(m.name), type: 'text' }))
        const rows = res.rows || []
        return {
          columns,
          rows,
          rowCount: rows.length,
          affectedRows: res.rowsAffected ?? 0,
          executionTimeMs: Math.round(performance.now() - start),
          truncated: false,
          isSelect: columns.length > 0,
        }
      },
      cancelQuery: async () => ({ ok: false }),
      getTransactionState: () => ({ ...TX_UNSUPPORTED }),
      beginTransaction: async () => ({ ...TX_UNSUPPORTED }),
      commitTransaction: async () => ({ ...TX_UNSUPPORTED }),
      rollbackTransaction: async () => ({ ...TX_UNSUPPORTED }),
      setAutoCommit: async () => ({ ...TX_UNSUPPORTED }),
    }
  },
  async testConnection(profile, password) {
    const session = await this.createSession(profile, password)
    try { return await session.test() } finally { await session.close().catch(() => {}) }
  },
}
`
  }

  if (id === 'mongodb') {
    return `// Datanoa BYOD Adapter for MongoDB (npm install mongodb)
import { MongoClient } from 'mongodb'

const TX_UNSUPPORTED = { supported: false, autoCommit: true, active: false, statementCount: 0 }
const MONGO_READONLY_COMMANDS = new Set([
  'find',
  'count',
  'distinct',
  'ping',
  'listcollections',
  'listdatabases',
  'collstats',
  'dbstats',
  'explain',
  'hello',
  'ismaster',
  'buildinfo',
  'serverstatus',
  'whatsmyuri',
  'getlasterror',
])

function hasMongoWriteStage(node) {
  if (Array.isArray(node)) return node.some((item) => hasMongoWriteStage(item))
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$out' || k === '$merge') return true
      if (hasMongoWriteStage(v)) return true
    }
  }
  return false
}

const MONGO_COLLECTION_SHORTHAND_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127};?$/

function isReadOnlyMongoCommandObj(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
  const keys = Object.keys(obj)
  if (keys.length === 0) return false
  const cmd = keys[0].toLowerCase()
  if (cmd === 'aggregate') {
    return !hasMongoWriteStage(obj)
  }
  if (cmd === 'explain') {
    const inner = obj.explain
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return false
    return isReadOnlyMongoCommandObj(inner)
  }
  return MONGO_READONLY_COMMANDS.has(cmd)
}

function isReadOnlyMongoCommand(rawText) {
  const trimmed = String(rawText || '').trim()
  if (MONGO_COLLECTION_SHORTHAND_RE.test(trimmed)) return true
  if (!trimmed.startsWith('{')) return false
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return false
  }
  return isReadOnlyMongoCommandObj(parsed)
}

function buildMongoUri(profile, password) {
  const dbName = profile.database || 'admin'
  if (profile.url) {
    try {
      const parsed = new URL(profile.url)
      if (!parsed.username && profile.user) parsed.username = profile.user
      if (!parsed.password && password) parsed.password = password
      return parsed.toString()
    } catch {
      return profile.url
    }
  }
  const auth = profile.user ? \`\${encodeURIComponent(profile.user)}:\${encodeURIComponent(password || '')}@\` : ''
  return \`mongodb://\${auth}\${profile.host || 'localhost'}:\${Number(profile.port) || 27017}/\${dbName}\`
}

export default {
  type: 'mongodb',
  async createSession(profile, password) {
    const dbName = profile.database || 'admin'
    const uri = buildMongoUri(profile, password)
    const client = new MongoClient(uri)
    await client.connect()
    const db = client.db(dbName)
    let closed = false
    return {
      driverType: 'mongodb',
      profile,
      isAlive: () => !closed,
      test: async () => {
        await db.command({ ping: 1 })
        return { ok: true, message: 'MongoDB connection valid' }
      },
      close: async () => {
        if (closed) return
        closed = true
        await client.close()
      },
      listObjects: async () => {
        const cols = await db.listCollections().toArray()
        return cols.map((c) => ({ schema: dbName, name: c.name, kind: 'table' }))
      },
      getTableDetails: async (table, schema = dbName) => {
        const sample = await db.collection(table).findOne({})
        const keys = sample ? Object.keys(sample) : ['_id']
        const columns = keys.map((k) => ({
          name: k,
          type: k === '_id' ? 'ObjectId' : typeof sample?.[k],
          nativeType: k === '_id' ? 'ObjectId' : typeof sample?.[k],
          nullable: k !== '_id',
          defaultValue: null,
          isPrimaryKey: k === '_id',
          isAutoIncrement: false,
        }))
        return { name: table, schema, kind: 'table', columns, primaryKey: ['_id'], indexes: [], foreignKeys: [] }
      },
      fetchPage: async (params) => {
        const page = Math.max(1, Math.floor(Number(params.page) || 1))
        const pageSize = Math.max(1, Math.min(10000, Math.floor(Number(params.pageSize || params.limit) || 100)))
        const offset = params.offset !== undefined ? Math.max(0, Number(params.offset) || 0) : (page - 1) * pageSize
        const docs = await db.collection(params.table).find({}).skip(offset).limit(pageSize).toArray()
        const totalRows = await db.collection(params.table).estimatedDocumentCount()
        const keySet = new Set(['_id'])
        for (const d of docs) Object.keys(d).forEach((k) => keySet.add(k))
        const colNames = Array.from(keySet)
        const columns = colNames.map((name) => ({
          name,
          type: name === '_id' ? 'ObjectId' : 'json',
          nativeType: name === '_id' ? 'ObjectId' : 'json',
          nullable: name !== '_id',
          defaultValue: null,
          isPrimaryKey: name === '_id',
          isAutoIncrement: false,
        }))
        const rows = docs.map((d) => {
          const obj = {}
          for (const k of colNames) {
            const v = d[k]
            obj[k] = v === undefined ? null : typeof v === 'object' && v !== null ? JSON.stringify(v) : v
          }
          return obj
        })
        return {
          columns,
          rows,
          totalRows,
          page,
          pageSize,
          primaryKey: ['_id'],
          canEdit: false,
        }
      },
      updateCell: async () => { throw new Error('Direct cell update requires MongoDB command in console') },
      applyChanges: async () => { throw new Error('Staged changes require MongoDB command in console') },
      previewChanges: async () => ({ statements: [] }),
      getDdl: async (table) => \`// MongoDB Collection: \${dbName}.\${table}\`,
      runQuery: async (_queryId, rawQuery) => {
        const start = performance.now()
        const trimmed = String(rawQuery || '').trim()
        if (profile.readOnly) {
          if (!isReadOnlyMongoCommand(trimmed)) {
            throw new Error('Connection is read-only. Only read-only MongoDB commands are allowed.')
          }
        }
        const docs = trimmed.startsWith('{')
          ? [await db.command(JSON.parse(trimmed))]
          : await db.collection(trimmed.replace(/;$/, '') || 'test').find({}).limit(100).toArray()
        const keySet = new Set()
        for (const d of docs) if (d && typeof d === 'object') Object.keys(d).forEach((k) => keySet.add(k))
        const columns = Array.from(keySet).map((name) => ({ name: String(name), type: 'json' }))
        const rows = docs.map((d) =>
          columns.map((c) => {
            const v = d?.[c.name]
            return v === undefined ? null : typeof v === 'object' && v !== null ? JSON.stringify(v) : v
          })
        )
        return {
          columns,
          rows,
          rowCount: rows.length,
          affectedRows: 0,
          executionTimeMs: Math.round(performance.now() - start),
          truncated: false,
          isSelect: true,
        }
      },
      cancelQuery: async () => ({ ok: false }),
      getTransactionState: () => ({ ...TX_UNSUPPORTED }),
      beginTransaction: async () => ({ ...TX_UNSUPPORTED }),
      commitTransaction: async () => ({ ...TX_UNSUPPORTED }),
      rollbackTransaction: async () => ({ ...TX_UNSUPPORTED }),
      setAutoCommit: async () => ({ ...TX_UNSUPPORTED }),
    }
  },
  async testConnection(profile, password) {
    const session = await this.createSession(profile, password)
    try { return await session.test() } finally { await session.close().catch(() => {}) }
  },
}
`
  }

  return `// Custom Datanoa BYOD Adapter implementing IDatabaseDriver + IDatabaseSession
const TX_UNSUPPORTED = { supported: false, autoCommit: true, active: false, statementCount: 0 }

export default {
  type: ${safeIdLiteral},
  async createSession(profile) {
    return {
      driverType: ${safeIdLiteral},
      profile,
      isAlive: () => true,
      test: async () => ({ ok: true, message: 'Custom BYOD adapter connected' }),
      close: async () => {},
      listObjects: async () => [],
      getTableDetails: async (table, schema = 'public') => ({
        name: table,
        schema,
        kind: 'table',
        columns: [],
        primaryKey: [],
        indexes: [],
        foreignKeys: [],
      }),
      fetchPage: async (params) => ({
        columns: [],
        rows: [],
        totalRows: 0,
        page: Math.max(1, Number(params.page) || 1),
        pageSize: Math.max(1, Number(params.pageSize || params.limit) || 100),
        primaryKey: [],
        canEdit: false,
      }),
      updateCell: async () => ({ ok: false, affectedRows: 0 }),
      applyChanges: async () => ({ ok: false, inserted: 0, updated: 0, deleted: 0, statements: [] }),
      previewChanges: async () => ({ statements: [] }),
      getDdl: async (table) => '-- Custom BYOD object: ' + table,
      runQuery: async () => ({
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: 0,
        executionTimeMs: 1,
        truncated: false,
        isSelect: true,
      }),
      cancelQuery: async () => ({ ok: false }),
      getTransactionState: () => ({ ...TX_UNSUPPORTED }),
      beginTransaction: async () => ({ ...TX_UNSUPPORTED }),
      commitTransaction: async () => ({ ...TX_UNSUPPORTED }),
      rollbackTransaction: async () => ({ ...TX_UNSUPPORTED }),
      setAutoCommit: async () => ({ ...TX_UNSUPPORTED }),
    }
  },
  async testConnection(profile, password) {
    const session = await this.createSession(profile, password)
    try { return await session.test() } finally { await session.close().catch(() => {}) }
  },
}
`
}
