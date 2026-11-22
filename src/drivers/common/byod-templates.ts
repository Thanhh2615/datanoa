// src/drivers/common/byod-templates.ts
// Single canonical source of truth for BYOD starter adapters conforming 100% to
// IDatabaseDriver + IDatabaseSession (TableDetails, TableBrowseResult, QueryResult, ApplyChangesResult, TransactionState).

export function getCanonicalByodStarterCode(driverId: string): string {
  const id = driverId.trim().toLowerCase()
  const safeIdLiteral = JSON.stringify(id || 'custom')
  if (id === 'mssql') {
    return `// Datanoa BYOD Adapter for Microsoft SQL Server (npm install mssql)
import mssql from 'mssql'

const TX_UNSUPPORTED = { supported: false, autoCommit: true, active: false, statementCount: 0 }

export default {
  type: 'mssql',
  async createSession(profile, password) {
    const pool = await mssql.connect({
      server: profile.host || 'localhost',
      port: Number(profile.port) || 1433,
      user: profile.user || 'sa',
      password: password || '',
      database: profile.database || 'master',
      options: { encrypt: Boolean(profile.ssl), trustServerCertificate: !profile.ssl },
    })
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

export default {
  type: 'oracle',
  async createSession(profile, password) {
    const conn = await oracledb.getConnection({
      user: profile.user,
      password: password || '',
      connectString: \`\${profile.host || 'localhost'}:\${Number(profile.port) || 1521}/\${profile.database || 'FREEPDB1'}\`,
    })
    const defaultSchema = (profile.user || 'USER').toUpperCase()
    return {
      driverType: 'oracle',
      profile,
      isAlive: () => true,
      test: async () => {
        await conn.execute('SELECT 1 FROM DUAL')
        return { ok: true, message: 'Oracle Database connection valid' }
      },
      close: async () => { await conn.close() },
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
        const res = await conn.execute(sql)
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
    return {
      driverType: 'mongodb',
      profile,
      isAlive: () => true,
      test: async () => {
        await db.command({ ping: 1 })
        return { ok: true, message: 'MongoDB connection valid' }
      },
      close: async () => { await client.close() },
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
