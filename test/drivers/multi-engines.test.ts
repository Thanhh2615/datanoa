import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  quoteIdentifier,
  quoteQualifiedTable,
  makePlaceholder,
  buildSelectPageSql,
  buildInsertStatement,
  buildDeleteStatement,
  buildBatchStatements,
} from '../../src/drivers/common/update-builder'
import { SqliteDriver, type SqliteSession } from '../../src/drivers/sqlite/driver'
import { PostgresDriver, PostgresSession } from '../../src/drivers/postgres/driver'
import { MysqlDriver, MysqlSession } from '../../src/drivers/mysql/driver'
import { RedisDriver, RedisSession } from '../../src/drivers/redis/driver'
import { ClickHouseDriver, ClickHouseSession } from '../../src/drivers/clickhouse/driver'
import { LibsqlDriver, LibsqlSession } from '../../src/drivers/libsql/driver'
import { getDriver, createDriver } from '../../src/drivers/index'
import { parseConnectionUri, SUPPORTED_DRIVERS } from '../../src/drivers/common/connection-uri'
import { DatabaseDriverError } from '../../src/drivers/common/driver'
import {
  introspectMysqlTableDetails,
  introspectPostgresTableDetails,
  toSqlBool,
} from '../../src/drivers/common/schema'
import {
  buildTableMigrationSql,
  createInitialTableDraft,
  isMutatingStatement,
} from '../../src/drivers/common/sql-tools'

describe('Wave 2A Slice 1 — Multi-Dialect Query & Batch Statement Builders', () => {
  it('quotes identifiers and qualified tables cleanly for all SQL dialects', () => {
    expect(quoteQualifiedTable('orders', 'main', 'sqlite')).toBe('"orders"')
    expect(quoteQualifiedTable('orders', 'main', 'libsql')).toBe('"orders"')
    expect(quoteQualifiedTable('orders', 'temp', 'sqlite')).toBe('"temp"."orders"')
    expect(quoteQualifiedTable('users', 'public', 'postgres')).toBe('"public"."users"')
    expect(quoteQualifiedTable('users', 'public', 'cockroachdb')).toBe('"public"."users"')
    expect(quoteQualifiedTable('products', 'shop', 'mysql')).toBe('`shop`.`products`')
    expect(quoteQualifiedTable('products', 'shop', 'mariadb')).toBe('`shop`.`products`')
    expect(quoteQualifiedTable('events', 'analytics', 'clickhouse')).toBe('`analytics`.`events`')

    expect(quoteIdentifier('user"col', 'cockroachdb')).toBe('"user""col"')
    expect(quoteIdentifier('ev`col', 'clickhouse')).toBe('`ev``col`')
    expect(quoteIdentifier('mariadb', 'items', 'store')).toBe('`store`.`items`')
  })

  it('generates dialect-specific bound parameter placeholders', () => {
    expect(makePlaceholder('postgres', 1)).toBe('$1')
    expect(makePlaceholder('cockroachdb', 3)).toBe('$3')
    expect(makePlaceholder('mysql', 2)).toBe('?')
    expect(makePlaceholder('mariadb', 2)).toBe('?')
    expect(makePlaceholder('sqlite', 2)).toBe('?')
    expect(makePlaceholder('libsql', 2)).toBe('?')
    expect(makePlaceholder('clickhouse', 2)).toBe('?')
  })

  it('builds SELECT page + COUNT queries with sanitized whereClause & orderByClause', () => {
    const res = buildSelectPageSql({
      driver: 'cockroachdb',
      table: 'orders',
      schema: 'public',
      page: 2,
      pageSize: 25,
      whereClause: "WHERE status = 'paid' AND total >= 100",
      orderByClause: 'ORDER BY created_at DESC',
      primaryKey: ['id'],
    })

    expect(res.countSql).toBe(
      `SELECT COUNT(*) AS total FROM "public"."orders" WHERE status = 'paid' AND total >= 100;`
    )
    expect(res.dataSql).toBe(
      `SELECT * FROM "public"."orders" WHERE status = 'paid' AND total >= 100 ORDER BY created_at DESC LIMIT $1 OFFSET $2;`
    )
    expect(res.params).toEqual([25, 25])

    expect(() =>
      buildSelectPageSql({
        driver: 'sqlite',
        table: 'orders',
        page: 1,
        pageSize: 10,
        whereClause: 'id = 1; DROP TABLE orders',
      })
    ).toThrow(/semicolon/i)
  })

  it('builds parameterized INSERT, DELETE, and batch statements with safe preview SQL', () => {
    const ins = buildInsertStatement({
      driver: 'postgres',
      table: 'users',
      schema: 'public',
      row: { name: "O'Reilly", active: true, bio: null },
    })
    expect(ins.sql).toBe('INSERT INTO "public"."users" ("name", "active", "bio") VALUES ($1, $2, $3)')
    expect(ins.params).toEqual(["O'Reilly", true, null])
    expect(ins.previewSql).toBe(
      'INSERT INTO "public"."users" ("name", "active", "bio") VALUES (\'O\'\'Reilly\', TRUE, NULL);'
    )

    const del = buildDeleteStatement({
      driver: 'mariadb',
      table: 'sessions',
      schema: 'auth',
      primaryKeys: { id: 'abc', tenant_id: 7 },
    })
    expect(del.sql).toBe('DELETE FROM `auth`.`sessions` WHERE `id` = ? AND `tenant_id` = ?')
    expect(del.params).toEqual(['abc', 7])
    expect(del.previewSql).toBe("DELETE FROM `auth`.`sessions` WHERE `id` = 'abc' AND `tenant_id` = 7;")

    expect(() =>
      buildDeleteStatement({ driver: 'sqlite', table: 'sessions', primaryKeys: {} })
    ).toThrow(/primary key/i)

    const batch = buildBatchStatements({
      driver: 'sqlite',
      table: 'items',
      inserts: [{ id: 10, label: 'New' }],
      updates: [
        {
          primaryKeys: { id: 2 },
          changes: { label: 'Updated' },
          originalRow: { id: 2, label: 'Old' },
        },
      ],
      deletes: [{ id: 1 }],
    })
    expect(batch.deletes).toHaveLength(1)
    expect(batch.updates).toHaveLength(1)
    expect(batch.inserts).toHaveLength(1)
    expect(batch.updates[0].sql).toBe(
      'UPDATE "items" SET "label" = ? WHERE "id" = ? AND "label" = ?'
    )
    expect(batch.updates[0].params).toEqual(['Updated', 2, 'Old'])
    expect(batch.previewStatements).toHaveLength(3)
  })
})

describe('Wave 2A Slice 2 — SQLite Transactional Staging, Filtering & DDL', () => {
  let tmpDir: string
  let dbPath: string
  let session: SqliteSession | null = null

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa_slice2_sqlite_'))
    dbPath = path.join(tmpDir, 'staging.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        balance REAL NOT NULL DEFAULT 0,
        tier TEXT DEFAULT 'free'
      );
      CREATE INDEX idx_accounts_tier ON accounts(tier);
      INSERT INTO accounts (code, balance, tier) VALUES
        ('ACC-1', 100.5, 'pro'),
        ('ACC-2', 250.0, 'pro'),
        ('ACC-3', 15.0, 'free');
    `)
    db.close()

    const driver = new SqliteDriver()
    session = (await driver.createSession({
      id: 'sqlite-staging',
      name: 'SQLite Staging',
      driver: 'sqlite',
      database: 'staging.db',
      filePath: dbPath,
    })) as SqliteSession
  })

  afterEach(async () => {
    if (session) {
      await session.close().catch(() => {})
      session = null
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('filters and sorts fetchPage via whereClause and orderByClause', async () => {
    const page = await session!.fetchPage({
      table: 'accounts',
      page: 1,
      pageSize: 10,
      whereClause: "tier = 'pro' AND balance > 50",
      orderByClause: 'balance DESC',
    })

    expect(page.totalRows).toBe(2)
    expect(page.rows.map((r) => r.code)).toEqual(['ACC-2', 'ACC-1'])
  })

  it('previews changes without mutating and commits transactional applyChanges atomically', async () => {
    const changes = {
      table: 'accounts',
      inserts: [{ code: 'ACC-4', balance: 500, tier: 'enterprise' }],
      updates: [
        {
          primaryKeys: { id: 1 },
          changes: { balance: 199.5, tier: 'enterprise' },
          originalRow: { id: 1, code: 'ACC-1', balance: 100.5, tier: 'pro' },
        },
      ],
      deletes: [{ id: 3 }],
    }

    const preview = await session!.previewChanges(changes)
    expect(preview.statements).toHaveLength(3)
    expect(preview.statements[0]).toMatch(/^DELETE FROM "accounts"/)
    expect(preview.statements[1]).toMatch(/^UPDATE "accounts"/)
    expect(preview.statements[2]).toMatch(/^INSERT INTO "accounts"/)

    const before = await session!.fetchPage({ table: 'accounts', page: 1, pageSize: 10 })
    expect(before.totalRows).toBe(3)

    const applied = await session!.applyChanges(changes)
    expect(applied.ok).toBe(true)
    expect(applied.deleted).toBe(1)
    expect(applied.updated).toBe(1)
    expect(applied.inserted).toBe(1)
    expect(applied.statements).toEqual(preview.statements)

    const after = await session!.fetchPage({
      table: 'accounts',
      page: 1,
      pageSize: 10,
      orderByClause: 'id ASC',
    })
    expect(after.totalRows).toBe(3)
    expect(after.rows.map((r) => r.code)).toEqual(['ACC-1', 'ACC-2', 'ACC-4'])
    expect(after.rows[0].balance).toBe(199.5)
    expect(after.rows[0].tier).toBe('enterprise')
  })

  it('rolls back entire applyChanges transaction on optimistic conflict or SQL constraint error', async () => {
    // 1. Optimistic concurrency conflict after an insert and delete in same batch
    await expect(
      session!.applyChanges({
        table: 'accounts',
        inserts: [{ code: 'ACC-TEMP', balance: 10 }],
        updates: [
          {
            primaryKeys: { id: 2 },
            changes: { balance: 999 },
            originalRow: { id: 2, code: 'ACC-2', balance: 123.45 }, // stale!
          },
        ],
        deletes: [{ id: 3 }],
      })
    ).rejects.toSatisfy((err: unknown) => err instanceof DatabaseDriverError && err.code === 'conflict')

    // Verify ACC-3 was NOT deleted and ACC-TEMP was NOT inserted (full rollback)
    const afterConflict = await session!.fetchPage({
      table: 'accounts',
      page: 1,
      pageSize: 10,
      orderByClause: 'id ASC',
    })
    expect(afterConflict.totalRows).toBe(3)
    expect(afterConflict.rows.map((r) => r.code)).toEqual(['ACC-1', 'ACC-2', 'ACC-3'])

    // 2. Constraint violation mid-batch rolls back earlier insert
    await expect(
      session!.applyChanges({
        table: 'accounts',
        inserts: [
          { code: 'ACC-VALID', balance: 50 },
          { code: 'ACC-1', balance: 60 }, // duplicate UNIQUE code
        ],
      })
    ).rejects.toThrow()

    const afterConstraint = await session!.fetchPage({ table: 'accounts', page: 1, pageSize: 10 })
    expect(afterConstraint.totalRows).toBe(3)
  })

  it('retrieves real sqlite_master DDL including indexes', async () => {
    const ddl = await session!.getDdl('accounts')
    expect(ddl).toContain('CREATE TABLE accounts')
    expect(ddl).toContain('CREATE INDEX idx_accounts_tier ON accounts(tier)')
  })
})

describe('Wave 2A Slice 3 — PostgreSQL & CockroachDB Driver/Session', () => {
  it('configures CockroachDB default port 26257 and default SSL enabled', async () => {
    const crdbDriver = new PostgresDriver('cockroachdb')
    expect(crdbDriver.type).toBe('cockroachdb')

    const session = (await crdbDriver.createSession(
      {
        id: 'crdb-1',
        name: 'Cockroach',
        driver: 'cockroachdb',
        database: 'defaultdb',
        host: 'crdb.local',
      },
      'secret'
    )) as PostgresSession
    expect(session.driverType).toBe('cockroachdb')

    const poolOptions = (session as unknown as { pool: { options?: Record<string, unknown> } }).pool
      .options
    expect(poolOptions?.port).toBe(26257)
    expect(poolOptions?.ssl).toEqual({ rejectUnauthorized: false })
    await session.close()

    const noSslSession = (await crdbDriver.createSession({
      id: 'crdb-2',
      name: 'Cockroach NoSSL',
      driver: 'cockroachdb',
      database: 'defaultdb',
      host: 'crdb.local',
      ssl: false,
    })) as PostgresSession
    const noSslOpts = (
      noSslSession as unknown as { pool: { options?: Record<string, unknown> } }
    ).pool.options
    expect(noSslOpts?.ssl).toBeUndefined()
    await noSslSession.close()
  })

  it('supports whereClause/orderByClause fetchPage, transactional applyChanges + ROLLBACK, and getDdl on CockroachDB', async () => {
    const executed: Array<{ sql: string; params?: unknown[] }> = []
    const mockClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        executed.push({ sql, params })
        if (sql.includes('UPDATE') && Array.isArray(params) && params.includes('stale')) {
          return { rowCount: 0, rows: [] }
        }
        return { rowCount: 1, rows: [] }
      }),
      release: vi.fn(),
    }

    const mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
      query: vi.fn(
        async (
          arg: string | { text: string; values?: unknown[]; queryMode?: string },
          params?: unknown[]
        ) => {
          const sql = typeof arg === 'string' ? arg : arg.text
          const effectiveParams = typeof arg === 'string' ? params : arg.values
          executed.push({ sql, params: effectiveParams })
        if (sql.includes("WHEN table_type = 'VIEW'")) return { rows: [{ kind: 'table' }] }
        if (sql.includes("tc.constraint_type = 'PRIMARY KEY'")) {
          return { rows: [{ column_name: 'id' }] }
        }
        if (sql.includes('FROM information_schema.columns')) {
          return {
            rows: [
              {
                name: 'id',
                type: 'bigint',
                native_type: 'int8',
                nullable: false,
                default_value: null,
                is_auto_increment: true,
              },
              {
                name: 'name',
                type: 'text',
                native_type: 'text',
                nullable: false,
                default_value: null,
                is_auto_increment: false,
              },
            ],
          }
        }
        if (sql.includes('SELECT COUNT(*)')) return { rows: [{ total: '1' }] }
        if (sql.includes('SELECT * FROM')) return { rows: [{ id: 1, name: 'Node' }] }
        return { rows: [] }
        }
      ),
      end: vi.fn().mockResolvedValue(undefined),
    }

    const session = new PostgresSession(mockPool as any, {
      id: 'crdb-sess',
      name: 'CRDB',
      driver: 'cockroachdb',
      database: 'defaultdb',
    })

    const page = await session.fetchPage({
      table: 'nodes',
      schema: 'public',
      page: 1,
      pageSize: 10,
      whereClause: "name = 'Node'",
      orderByClause: 'id DESC',
    })
    expect(page.rows).toEqual([{ id: 1, name: 'Node' }])
    expect(executed.some((e) => e.sql.includes(`WHERE name = 'Node' ORDER BY id DESC LIMIT $1 OFFSET $2`))).toBe(true)

    const preview = await session.previewChanges({
      table: 'nodes',
      schema: 'public',
      inserts: [{ id: 2, name: 'Edge' }],
    })
    expect(preview.statements).toEqual(['INSERT INTO "public"."nodes" ("id", "name") VALUES (2, \'Edge\');'])

    const applied = await session.applyChanges({
      table: 'nodes',
      schema: 'public',
      inserts: [{ id: 2, name: 'Edge' }],
      updates: [{ primaryKeys: { id: 1 }, changes: { name: 'Core' }, originalRow: { id: 1, name: 'Node' } }],
      deletes: [{ id: 9 }],
    })
    expect(applied.ok).toBe(true)
    expect(applied.deleted).toBe(1)
    expect(applied.updated).toBe(1)
    expect(applied.inserted).toBe(1)
    expect(executed.some((e) => e.sql === 'BEGIN')).toBe(true)
    expect(executed.some((e) => e.sql === 'COMMIT')).toBe(true)

    // Rollback on optimistic lock conflict
    await expect(
      session.applyChanges({
        table: 'nodes',
        schema: 'public',
        updates: [{ primaryKeys: { id: 1 }, changes: { name: 'Core' }, originalRow: { id: 1, name: 'stale' } }],
      })
    ).rejects.toSatisfy((err: unknown) => err instanceof DatabaseDriverError && err.code === 'conflict' && err.driver === 'cockroachdb')
    expect(executed.some((e) => e.sql === 'ROLLBACK')).toBe(true)

    const ddl = await session.getDdl('nodes', 'public')
    expect(ddl).toContain('CREATE TABLE "public"."nodes"')
    expect(ddl).toContain('GENERATED BY DEFAULT AS IDENTITY')
  })
})

describe('Wave 2A Slice 4 — MySQL & MariaDB Driver/Session', () => {
  it('supports MariaDB dialect, whereClause/orderByClause fetchPage, transactional applyChanges, and SHOW CREATE TABLE + fallback DDL', async () => {
    const mariaDriver = new MysqlDriver('mariadb')
    expect(mariaDriver.type).toBe('mariadb')

    const executed: Array<{ sql: string; params?: unknown[] }> = []
    const mockConn = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        executed.push({ sql, params })
        if (sql.includes('UPDATE') && Array.isArray(params) && params.includes('stale')) {
          return [{ affectedRows: 0 }]
        }
        return [{ affectedRows: 1 }]
      }),
      release: vi.fn(),
    }

    let allowShowCreate = true
    const mockPool = {
      getConnection: vi.fn().mockResolvedValue(mockConn),
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        executed.push({ sql, params })
        if (sql.startsWith('SHOW CREATE TABLE')) {
          if (!allowShowCreate) {
            throw new Error('SHOW CREATE denied')
          }
          return [[{ Table: 'items', 'Create Table': 'CREATE TABLE `items` (`sku` varchar(32) PRIMARY KEY)' }]]
        }
        if (sql.includes("WHEN table_type = 'VIEW'")) return [[{ kind: 'table' }]]
        if (sql.includes('FROM information_schema.columns')) {
          return [[
            {
              name: 'sku',
              type: 'varchar(32)',
              native_type: 'varchar',
              nullable: false,
              default_value: null,
              is_primary_key: true,
              is_auto_increment: false,
            },
          ]]
        }
        if (sql.includes("constraint_name = 'PRIMARY'")) return [[{ column_name: 'sku' }]]
        if (sql.includes('referenced_table_name IS NOT NULL')) return [[]]
        if (sql.includes('FROM information_schema.statistics')) return [[]]
        if (sql.includes('SELECT COUNT(*)')) return [[{ total: 1 }]]
        if (sql.includes('SELECT * FROM')) return [[{ sku: 'A-1' }]]
        return [[]]
      }),
      end: vi.fn().mockResolvedValue(undefined),
    }

    const session = new MysqlSession(mockPool as any, {
      id: 'maria-1',
      name: 'MariaDB Prod',
      driver: 'mariadb',
      database: 'inventory',
    })
    expect(session.driverType).toBe('mariadb')

    const page = await session.fetchPage({
      table: 'items',
      page: 1,
      pageSize: 10,
      whereClause: "sku LIKE 'A-%'",
      orderByClause: 'sku ASC',
    })
    expect(page.rows).toEqual([{ sku: 'A-1' }])
    expect(executed.some((e) => e.sql.includes("WHERE sku LIKE 'A-%' ORDER BY sku ASC LIMIT ? OFFSET ?"))).toBe(true)

    const preview = await session.previewChanges({
      table: 'items',
      inserts: [{ sku: 'A-2' }],
    })
    expect(preview.statements).toEqual(["INSERT INTO `inventory`.`items` (`sku`) VALUES ('A-2');"])

    const applied = await session.applyChanges({
      table: 'items',
      inserts: [{ sku: 'A-2' }],
      updates: [{ primaryKeys: { sku: 'A-1' }, changes: { sku: 'A-1B' }, originalRow: { sku: 'A-1' } }],
      deletes: [{ sku: 'OLD-1' }],
    })
    expect(applied.ok).toBe(true)
    expect(applied.deleted).toBe(1)
    expect(applied.updated).toBe(1)
    expect(applied.inserted).toBe(1)
    expect(mockConn.beginTransaction).toHaveBeenCalledTimes(1)
    expect(mockConn.commit).toHaveBeenCalledTimes(1)

    await expect(
      session.applyChanges({
        table: 'items',
        updates: [{ primaryKeys: { sku: 'A-1' }, changes: { sku: 'X' }, originalRow: { sku: 'stale' } }],
      })
    ).rejects.toSatisfy((err: unknown) => err instanceof DatabaseDriverError && err.code === 'conflict' && err.driver === 'mariadb')
    expect(mockConn.rollback).toHaveBeenCalledTimes(1)

    const nativeDdl = await session.getDdl('items')
    expect(nativeDdl).toContain('CREATE TABLE `items`')

    allowShowCreate = false
    const fallbackDdl = await session.getDdl('items')
    expect(fallbackDdl).toContain('CREATE TABLE `inventory`.`items`')
    expect(fallbackDdl).toContain('PRIMARY KEY (`sku`)')
  })
})

function encodeRespValue(val: unknown): Buffer {
  if (val === null || val === undefined) return Buffer.from('$-1\r\n', 'utf8')
  if (val instanceof Error) return Buffer.from(`-ERR ${val.message}\r\n`, 'utf8')
  if (typeof val === 'number') return Buffer.from(`:${Math.trunc(val)}\r\n`, 'utf8')
  if (Array.isArray(val)) {
    return Buffer.concat([
      Buffer.from(`*${val.length}\r\n`, 'utf8'),
      ...val.map((item) => encodeRespValue(item)),
    ])
  }
  const s = String(val)
  const b = Buffer.from(s, 'utf8')
  return Buffer.concat([Buffer.from(`$${b.length}\r\n`, 'utf8'), b, Buffer.from('\r\n', 'utf8')])
}

function tryParseRespArrays(buf: Buffer): { commands: string[][]; rest: Buffer } {
  const commands: string[][] = []
  let offset = 0
  while (offset < buf.length) {
    if (buf[offset] !== 42 /* * */) break
    const lineEnd = buf.indexOf('\r\n', offset)
    if (lineEnd < 0) break
    const count = Number(buf.subarray(offset + 1, lineEnd).toString('utf8'))
    let pos = lineEnd + 2
    const args: string[] = []
    let complete = true
    for (let i = 0; i < count; i++) {
      if (pos >= buf.length || buf[pos] !== 36 /* $ */) {
        complete = false
        break
      }
      const lenEnd = buf.indexOf('\r\n', pos)
      if (lenEnd < 0) {
        complete = false
        break
      }
      const len = Number(buf.subarray(pos + 1, lenEnd).toString('utf8'))
      const dataStart = lenEnd + 2
      if (buf.length < dataStart + len + 2) {
        complete = false
        break
      }
      args.push(buf.subarray(dataStart, dataStart + len).toString('utf8'))
      pos = dataStart + len + 2
    }
    if (!complete) break
    commands.push(args)
    offset = pos
  }
  return { commands, rest: buf.subarray(offset) }
}

describe('Wave 2A Slice 5 — Redis Pure TCP RESP Driver/Session', () => {
  type Entry = { type: 'string' | 'hash' | 'list' | 'set' | 'zset'; value: unknown; ttl: number }
  let server: net.Server
  let port: number
  let store: Map<string, Entry>
  let seenAuths: string[][]
  let seenSelects: string[]

  beforeEach(async () => {
    store = new Map<string, Entry>([
      ['user:1', { type: 'string', value: 'Nguyễn An', ttl: 120 }],
      ['user:2', { type: 'hash', value: { role: 'admin', active: '1' }, ttl: -1 }],
      ['session:abc', { type: 'list', value: ['step1', 'step2'], ttl: 600 }],
      ['tags:hot', { type: 'set', value: ['db', 'oled'], ttl: -1 }],
      ['scores:top', { type: 'zset', value: ['alice', '100', 'bob', '90'], ttl: -1 }],
      ['app_version', { type: 'string', value: '0.1.0', ttl: -1 }],
    ])
    seenAuths = []
    seenSelects = []

    server = net.createServer((socket) => {
      let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        const { commands, rest } = tryParseRespArrays(buffer)
        buffer = rest

        for (const args of commands) {
          const cmd = (args[0] || '').toUpperCase()
          if (cmd === 'AUTH') {
            seenAuths.push(args.slice(1))
            socket.write('+OK\r\n')
          } else if (cmd === 'SELECT') {
            seenSelects.push(args[1] ?? '0')
            socket.write('+OK\r\n')
          } else if (cmd === 'PING') {
            socket.write('+PONG\r\n')
          } else if (cmd === 'DBSIZE') {
            socket.write(encodeRespValue(store.size))
          } else if (cmd === 'INFO') {
            socket.write(encodeRespValue(`# Keyspace\r\ndb2:keys=${store.size},expires=2,avg_ttl=0\r\n`))
          } else if (cmd === 'SCAN') {
            let matchPattern = '*'
            const matchIdx = args.findIndex((a) => a.toUpperCase() === 'MATCH')
            if (matchIdx >= 0 && args[matchIdx + 1]) {
              matchPattern = args[matchIdx + 1]
            }
            const regex = new RegExp(
              '^' + matchPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
            )
            const matched = Array.from(store.keys()).filter((k) => regex.test(k))
            socket.write(encodeRespValue(['0', matched]))
          } else if (cmd === 'TYPE') {
            const entry = store.get(args[1])
            socket.write(`+${entry ? entry.type : 'none'}\r\n`)
          } else if (cmd === 'TTL') {
            const entry = store.get(args[1])
            socket.write(encodeRespValue(entry ? entry.ttl : -2))
          } else if (cmd === 'GET') {
            const entry = store.get(args[1])
            socket.write(encodeRespValue(entry && entry.type === 'string' ? String(entry.value) : null))
          } else if (cmd === 'HGETALL') {
            const entry = store.get(args[1])
            const obj = (entry?.value as Record<string, string>) || {}
            const flat: string[] = []
            for (const [k, v] of Object.entries(obj)) flat.push(k, v)
            socket.write(encodeRespValue(flat))
          } else if (cmd === 'LRANGE') {
            const entry = store.get(args[1])
            socket.write(encodeRespValue(Array.isArray(entry?.value) ? entry!.value : []))
          } else if (cmd === 'SMEMBERS') {
            const entry = store.get(args[1])
            socket.write(encodeRespValue(Array.isArray(entry?.value) ? entry!.value : []))
          } else if (cmd === 'ZRANGE') {
            const entry = store.get(args[1])
            socket.write(encodeRespValue(Array.isArray(entry?.value) ? entry!.value : []))
          } else if (cmd === 'SET') {
            const key = args[1]
            const val = args[2]
            const keepTtl = args.some((a) => a.toUpperCase() === 'KEEPTTL')
            const prevTtl = store.get(key)?.ttl ?? -1
            store.set(key, { type: 'string', value: val, ttl: keepTtl ? prevTtl : -1 })
            socket.write('+OK\r\n')
          } else if (cmd === 'HSET') {
            const key = args[1]
            const obj: Record<string, string> = {}
            for (let i = 2; i + 1 < args.length; i += 2) obj[args[i]] = args[i + 1]
            store.set(key, { type: 'hash', value: obj, ttl: store.get(key)?.ttl ?? -1 })
            socket.write(encodeRespValue(Object.keys(obj).length))
          } else if (cmd === 'DEL') {
            let removed = 0
            for (const k of args.slice(1)) {
              if (store.delete(k)) removed++
            }
            socket.write(encodeRespValue(removed))
          } else if (cmd === 'SLOW') {
            // Deliberately leave pending to test socket.destroy() cancellation
          } else {
            socket.write(encodeRespValue(new Error(`unknown command '${cmd}'`)))
          }
        }
      })
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    port = (server.address() as net.AddressInfo).port
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('authenticates, selects redisDb, scans namespaces, fetches paginated typed rows, updates/applies changes, runs commands & cancels via socket destroy', async () => {
    const driver = new RedisDriver()
    const profile = {
      id: 'redis-1',
      name: 'Local Redis',
      driver: 'redis' as const,
      host: '127.0.0.1',
      port,
      user: 'default',
      database: '2',
      redisDb: 2,
      hasPassword: true,
    }

    const testRes = await driver.testConnection(profile, 's3cr3t')
    expect(testRes.ok).toBe(true)
    expect(seenAuths).toContainEqual(['default', 's3cr3t'])
    expect(seenSelects).toContain('2')

    const session = (await driver.createSession(profile, 's3cr3t')) as RedisSession
    try {
      const objects = await session.listObjects()
      const names = objects.map((o) => o.name)
      expect(names).toContain('(all)')
      expect(names).toContain('(root)')
      expect(names).toContain('user:*')
      expect(names).toContain('session:*')
      expect(objects[0].schema).toBe('db2')

      const details = await session.getTableDetails('user:*')
      expect(details.primaryKey).toEqual(['key'])
      expect(details.columns.map((c) => c.name)).toEqual(['key', 'type', 'ttl', 'value'])

      const page = await session.fetchPage({
        table: 'user:*',
        page: 1,
        pageSize: 10,
        orderByClause: 'key ASC',
      })
      expect(page.totalRows).toBe(2)
      expect(page.canEdit).toBe(true)
      expect(page.rows[0]).toMatchObject({ key: 'user:1', type: 'string', ttl: 120, value: 'Nguyễn An' })
      expect(page.rows[1].key).toBe('user:2')
      expect(page.rows[1].type).toBe('hash')
      expect(JSON.parse(String(page.rows[1].value))).toEqual({ role: 'admin', active: '1' })

      const filteredAll = await session.fetchPage({
        table: '(all)',
        page: 1,
        pageSize: 10,
        whereClause: 'scores:*',
      })
      expect(filteredAll.rows.map((r) => r.key)).toEqual(['scores:top'])

      const upd = await session.updateCell({
        table: 'user:*',
        primaryKeys: { key: 'user:1' },
        column: 'value',
        newValue: 'An Updated',
      })
      expect(upd.ok).toBe(true)
      expect(store.get('user:1')?.ttl).toBe(120) // KEEPTTL preserved!
      expect(store.get('user:1')?.value).toBe('An Updated')

      const preview = await session.previewChanges({
        table: 'user:*',
        inserts: [{ key: 'user:3', value: 'New' }],
        updates: [{ primaryKeys: { key: 'user:1' }, changes: { value: 'Batch' } }],
        deletes: [{ key: 'app_version' }],
      })
      expect(preview.statements).toHaveLength(3)

      const applied = await session.applyChanges({
        table: 'user:*',
        inserts: [{ key: 'user:3', value: 'New' }],
        updates: [{ primaryKeys: { key: 'user:1' }, changes: { value: 'Batch' } }],
        deletes: [{ key: 'app_version' }],
      })
      expect(applied.ok).toBe(true)
      expect(applied.inserted).toBe(1)
      expect(applied.updated).toBe(1)
      expect(applied.deleted).toBe(1)
      expect(store.has('app_version')).toBe(false)
      expect(store.get('user:3')?.value).toBe('New')

      const ddl = await session.getDdl('user:*')
      expect(ddl).toContain('db2:keys=')

      const cmdRes = await session.runQuery(
        'q-redis-1',
        'SET "greeting" "hello \\"world\\""\nGET "greeting"\nSCAN 0 MATCH user:* COUNT 50'
      )
      expect(cmdRes.isSelect).toBe(true)
      expect(cmdRes.rowCount).toBe(3)
      expect(cmdRes.rows[1][1]).toBe('hello "world"')

      // Cancel active socket command and confirm session recovers cleanly
      const slowPromise = session.runQuery('q-slow', 'SLOW')
      slowPromise.catch(() => {})
      await new Promise((r) => setTimeout(r, 30))
      const cancelRes = await session.cancelQuery('q-slow')
      expect(cancelRes.ok).toBe(true)
      await expect(slowPromise).rejects.toMatchObject({ code: 'cancelled' })

      const afterCancel = await session.runQuery('q-after', 'PING')
      expect(afterCancel.rows).toEqual([['PONG']])
    } finally {
      await session.close()
    }

    await expect(session.runQuery('q-closed', 'PING')).rejects.toSatisfy(
      (err: unknown) => err instanceof DatabaseDriverError && err.code === 'SESSION_CLOSED' && err.driver === 'redis'
    )
  })
})

describe('Wave 2A Slice 6 — ClickHouse HTTP JSONCompact Driver/Session', () => {
  let server: http.Server
  let baseUrl: string
  let requests: Array<{ headers: http.IncomingHttpHeaders; queryId: string | null; sql: string }>
  let events: Array<{ id: number; name: string | null; total: number }>

  beforeEach(async () => {
    requests = []
    events = [
      { id: 1, name: 'signup', total: 10 },
      { id: 2, name: 'purchase', total: 42 },
      { id: 3, name: 'logout', total: 5 },
    ]

    server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1')
      const queryId = reqUrl.searchParams.get('query_id')
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const sql = Buffer.concat(chunks).toString('utf8').trim()
        requests.push({ headers: req.headers, queryId, sql })

        if (sql.includes('SLEEP_SLOW')) {
          // Hold connection open until aborted
          return
        }

        if (sql.startsWith('KILL QUERY')) {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('')
          return
        }

        if (sql.includes('FROM system.tables')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              meta: [
                { name: 'name', type: 'String' },
                { name: 'schema', type: 'String' },
                { name: 'engine', type: 'String' },
              ],
              data: [
                ['events', 'analytics', 'MergeTree'],
                ['v_events', 'analytics', 'View'],
              ],
              rows: 2,
            })
          )
          return
        }

        if (sql.includes('FROM system.columns')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              meta: [
                { name: 'name', type: 'String' },
                { name: 'type', type: 'String' },
                { name: 'is_in_primary_key', type: 'UInt8' },
                { name: 'is_in_sorting_key', type: 'UInt8' },
                { name: 'default_kind', type: 'String' },
                { name: 'default_expression', type: 'String' },
              ],
              data: [
                ['id', 'UInt64', 1, 1, '', ''],
                ['name', 'Nullable(String)', 0, 0, '', ''],
                ['total', 'Int32', 0, 0, 'DEFAULT', '0'],
              ],
              rows: 3,
            })
          )
          return
        }

        if (sql.startsWith('SHOW CREATE TABLE')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              meta: [{ name: 'statement', type: 'String' }],
              data: [['CREATE TABLE `analytics`.`events` (`id` UInt64, `name` Nullable(String), `total` Int32 DEFAULT 0) ENGINE = MergeTree ORDER BY id']],
              rows: 1,
            })
          )
          return
        }

        if (sql.startsWith('SELECT COUNT(*)')) {
          const filtered = sql.includes('total > 8') ? events.filter((e) => e.total > 8) : events
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              meta: [{ name: 'total', type: 'UInt64' }],
              data: [[String(filtered.length)]],
              rows: 1,
            })
          )
          return
        }

        if (sql.startsWith('SELECT * FROM')) {
          let filtered = [...events]
          if (sql.includes('total > 8')) filtered = filtered.filter((e) => e.total > 8)
          if (sql.includes('ORDER BY total DESC')) filtered.sort((a, b) => b.total - a.total)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              meta: [
                { name: 'id', type: 'UInt64' },
                { name: 'name', type: 'Nullable(String)' },
                { name: 'total', type: 'Int32' },
              ],
              data: filtered.map((e) => [e.id, e.name, e.total]),
              rows: filtered.length,
            })
          )
          return
        }

        if (sql.startsWith('INSERT INTO') || sql.startsWith('ALTER TABLE')) {
          if (sql.startsWith('INSERT INTO')) events.push({ id: 4, name: 'upgrade', total: 99 })
          res.writeHead(200, { 'Content-Type': 'text/plain', 'X-ClickHouse-Summary': '{"written_rows":"1"}' })
          res.end('')
          return
        }

        // Generic SELECT 1 or custom SELECT query
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            meta: [{ name: 'ok', type: 'UInt8' }],
            data: [[1], [2]],
            rows: 2,
          })
        )
      })
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address() as net.AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterEach(async () => {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('sends auth headers, introspects system.tables/columns, fetches filtered JSONCompact pages, applies changes, runs & cancels queries', async () => {
    const driver = new ClickHouseDriver()
    const profile = {
      id: 'ch-1',
      name: 'Analytics CH',
      driver: 'clickhouse' as const,
      url: baseUrl,
      database: 'analytics',
      user: 'analyst',
      hasPassword: true,
    }

    const testRes = await driver.testConnection(profile, 'ch-key-123')
    expect(testRes.ok).toBe(true)
    expect(requests[0].headers['x-clickhouse-user']).toBe('analyst')
    expect(requests[0].headers['x-clickhouse-key']).toBe('ch-key-123')
    expect(requests[0].headers['x-clickhouse-database']).toBe('analytics')

    const session = (await driver.createSession(profile, 'ch-key-123')) as ClickHouseSession
    try {
      const objects = await session.listObjects()
      expect(objects).toEqual([
        { name: 'events', schema: 'analytics', kind: 'table' },
        { name: 'v_events', schema: 'analytics', kind: 'view' },
      ])

      const details = await session.getTableDetails('events')
      expect(details.primaryKey).toEqual(['id'])
      expect(details.columns.find((c) => c.name === 'name')?.nullable).toBe(true)

      const page = await session.fetchPage({
        table: 'events',
        page: 1,
        pageSize: 10,
        whereClause: 'total > 8',
        orderByClause: 'total DESC',
      })
      expect(page.totalRows).toBe(2)
      expect(page.rows.map((r) => r.name)).toEqual(['purchase', 'signup'])

      const ddl = await session.getDdl('events')
      expect(ddl).toContain('CREATE TABLE `analytics`.`events`')

      const preview = await session.previewChanges({
        table: 'events',
        inserts: [{ id: 4, name: 'upgrade', total: 99 }],
        updates: [{ primaryKeys: { id: 2 }, changes: { total: 50 } }],
        deletes: [{ id: 3 }],
      })
      expect(preview.statements[0]).toMatch(/^ALTER TABLE `analytics`\.`events` DELETE WHERE/)
      expect(preview.statements[1]).toMatch(/^ALTER TABLE `analytics`\.`events` UPDATE/)
      expect(preview.statements[2]).toMatch(/^INSERT INTO `analytics`\.`events`/)

      const applied = await session.applyChanges({
        table: 'events',
        inserts: [{ id: 4, name: 'upgrade', total: 99 }],
        updates: [{ primaryKeys: { id: 2 }, changes: { total: 50 } }],
        deletes: [{ id: 3 }],
      })
      expect(applied.ok).toBe(true)
      expect(applied.inserted).toBe(1)
      expect(applied.updated).toBe(1)
      expect(applied.deleted).toBe(1)

      const qRes = await session.runQuery('q-ch-1', 'SELECT 1;', 1)
      expect(qRes.isSelect).toBe(true)
      expect(qRes.rowCount).toBe(1)
      expect(qRes.truncated).toBe(true)
      const selectReq = requests.find((r) => r.queryId === 'q-ch-1')
      expect(selectReq?.sql).toBe('SELECT 1 FORMAT JSONCompact')

      const slowPromise = session.runQuery('q-ch-cancel', 'SELECT SLEEP_SLOW()')
      slowPromise.catch(() => {})
      await new Promise((r) => setTimeout(r, 30))
      const cancelRes = await session.cancelQuery('q-ch-cancel')
      expect(cancelRes.ok).toBe(true)
      await expect(slowPromise).rejects.toMatchObject({ code: 'cancelled' })
      expect(requests.some((r) => r.sql.includes("KILL QUERY WHERE query_id = 'q-ch-cancel'"))).toBe(true)
    } finally {
      await session.close()
    }

    await expect(session.runQuery('q-closed', 'SELECT 1')).rejects.toSatisfy(
      (err: unknown) => err instanceof DatabaseDriverError && err.code === 'SESSION_CLOSED' && err.driver === 'clickhouse'
    )
  })
})

function decodeHranaArg(arg: { type: string; value?: unknown; base64?: string }): unknown {
  if (!arg || arg.type === 'null') return null
  if (arg.type === 'integer') return Number(arg.value)
  if (arg.type === 'float') return Number(arg.value)
  if (arg.type === 'text') return String(arg.value ?? '')
  if (arg.type === 'blob') return arg.base64 ? Buffer.from(arg.base64, 'base64') : null
  return arg.value ?? null
}

function encodeHranaCell(val: unknown): { type: string; value?: string | number } {
  if (val === null || val === undefined) return { type: 'null' }
  if (typeof val === 'number') {
    return Number.isInteger(val)
      ? { type: 'integer', value: String(val) }
      : { type: 'float', value: val }
  }
  return { type: 'text', value: String(val) }
}

describe('Wave 2A Slice 7 — Turso / LibSQL Hrana v2 HTTP Pipeline Driver/Session', () => {
  let server: http.Server
  let baseUrl: string
  let db: DatabaseSync
  let seenAuthHeaders: string[]
  let pipelineBatches: Array<{ path: string; requestCount: number; sqls: string[] }>

  beforeEach(async () => {
    db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_todos_done ON todos(done);
      INSERT INTO todos (title, done) VALUES ('Write tests', 1), ('Ship OLED', 0);
    `)
    seenAuthHeaders = []
    pipelineBatches = []

    server = http.createServer((req, res) => {
      const auth = req.headers.authorization
      if (auth) seenAuthHeaders.push(auth)

      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          requests: Array<{
            type: string
            stmt?: { sql: string; args?: Array<{ type: string; value?: unknown; base64?: string }> }
          }>
        }

        const sqls = body.requests
          .filter((r) => r.type === 'execute' && r.stmt)
          .map((r) => r.stmt!.sql)
        pipelineBatches.push({
          path: req.url || '',
          requestCount: body.requests.length,
          sqls,
        })

        if (sqls.some((s) => s.includes('SLEEP_HRANA'))) {
          // Leave request hanging so AbortController cancellation is tested
          return
        }

        const results: unknown[] = []
        let failed = false
        for (const item of body.requests) {
          if (item.type === 'close') {
            results.push({ type: 'ok', response: { type: 'close' } })
            continue
          }
          if (item.type !== 'execute' || !item.stmt) {
            results.push({ type: 'ok', response: {} })
            continue
          }
          if (failed) {
            results.push({ type: 'error', error: { message: 'Aborted after prior error', code: 'SQL_ERROR' } })
            continue
          }

          try {
            const sql = item.stmt.sql
            const params = (item.stmt.args || []).map(decodeHranaArg)
            const isQuery = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(sql)
            if (isQuery) {
              const stmt = db.prepare(sql)
              stmt.setReturnArrays(true)
              const cols = stmt.columns().map((c) => ({ name: c.name, decltype: c.type || 'TEXT' }))
              const rawRows = stmt.all(...(params as any[])) as unknown as unknown[][]
              results.push({
                type: 'ok',
                response: {
                  type: 'execute',
                  result: {
                    cols,
                    rows: rawRows.map((row) => row.map(encodeHranaCell)),
                    affected_row_count: 0,
                    last_insert_rowid: null,
                  },
                },
              })
            } else {
              const stmt = db.prepare(sql)
              const runRes = stmt.run(...(params as any[]))
              results.push({
                type: 'ok',
                response: {
                  type: 'execute',
                  result: {
                    cols: [],
                    rows: [],
                    affected_row_count: runRes.changes,
                    last_insert_rowid: runRes.lastInsertRowid ? String(runRes.lastInsertRowid) : null,
                  },
                },
              })
            }
          } catch (err: any) {
            failed = true
            results.push({
              type: 'error',
              error: { message: err?.message || 'SQLite error', code: 'SQLITE_ERROR' },
            })
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        const hasClose = body.requests.some((r) => r.type === 'close')
        res.end(
          JSON.stringify({
            baton: hasClose ? null : 'baton-slice7-1',
            results,
          })
        )
      })
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address() as net.AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterEach(async () => {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
  })

  it('normalizes libsql:// URL, authenticates Bearer token, introspects schema/DDL, filters fetchPage, pipelines applyChanges & cancels queries', async () => {
    const driver = new LibsqlDriver()

    // Verify libsql:// -> https:// URL normalization helper on session
    const httpsSession = (await driver.createSession(
      {
        id: 'turso-tls',
        name: 'Turso Cloud',
        driver: 'libsql',
        database: 'cloud-db',
        url: 'libsql://my-db.turso.io/',
      },
      'tok_123'
    )) as LibsqlSession
    expect((httpsSession as unknown as { pipelineUrl: string }).pipelineUrl).toBe(
      'https://my-db.turso.io/v2/pipeline'
    )
    await httpsSession.close()

    const profile = {
      id: 'libsql-local',
      name: 'Local sqld',
      driver: 'libsql' as const,
      database: 'todos',
      url: baseUrl,
      hasAuthToken: true,
    }

    const testRes = await driver.testConnection(profile, 'turso-bearer-xyz')
    expect(testRes.ok).toBe(true)
    expect(seenAuthHeaders).toContain('Bearer turso-bearer-xyz')

    const session = (await driver.createSession(profile, 'turso-bearer-xyz')) as LibsqlSession
    try {
      const objects = await session.listObjects()
      expect(objects).toEqual([{ name: 'todos', schema: 'main', kind: 'table' }])

      const details = await session.getTableDetails('todos')
      expect(details.primaryKey).toEqual(['id'])
      expect(details.indexes.some((i) => i.name === 'idx_todos_done')).toBe(true)

      const ddl = await session.getDdl('todos')
      expect(ddl).toContain('CREATE TABLE todos')
      expect(ddl).toContain('CREATE INDEX idx_todos_done ON todos(done)')

      const page = await session.fetchPage({
        table: 'todos',
        page: 1,
        pageSize: 10,
        whereClause: 'done = 0',
        orderByClause: 'id DESC',
      })
      expect(page.totalRows).toBe(1)
      expect(page.rows[0].title).toBe('Ship OLED')

      const batchBefore = pipelineBatches.length
      const preview = await session.previewChanges({
        table: 'todos',
        inserts: [{ title: 'Verify 8 engines', done: 0 }],
        updates: [{ primaryKeys: { id: 2 }, changes: { done: 1 }, originalRow: { id: 2, title: 'Ship OLED', done: 0 } }],
        deletes: [{ id: 1 }],
      })
      expect(preview.statements).toHaveLength(3)

      const applied = await session.applyChanges({
        table: 'todos',
        inserts: [{ title: 'Verify 8 engines', done: 0 }],
        updates: [{ primaryKeys: { id: 2 }, changes: { done: 1 }, originalRow: { id: 2, title: 'Ship OLED', done: 0 } }],
        deletes: [{ id: 1 }],
      })
      expect(applied.ok).toBe(true)
      expect(applied.deleted).toBe(1)
      expect(applied.updated).toBe(1)
      expect(applied.inserted).toBe(1)
      // Must use stateful Hrana v2 baton: round-trip 1 (BEGIN IMMEDIATE + DML), round-trip 2 (COMMIT + close)
      const applyBatch = pipelineBatches.slice(batchBefore)
      expect(applyBatch).toHaveLength(2)
      expect(applyBatch[0].path).toBe('/v2/pipeline')
      expect(applyBatch[0].sqls[0]).toMatch(/^BEGIN IMMEDIATE/i)
      expect(applyBatch[0].sqls.some((s) => s.includes('DELETE FROM "todos"'))).toBe(true)
      expect(applyBatch[0].sqls.some((s) => s.includes('UPDATE "todos"'))).toBe(true)
      expect(applyBatch[0].sqls.some((s) => s.includes('INSERT INTO "todos"'))).toBe(true)
      expect(applyBatch[0].sqls.some((s) => /^COMMIT/i.test(s))).toBe(false)
      expect(applyBatch[1].path).toBe('/v2/pipeline')
      expect(applyBatch[1].sqls).toEqual(['COMMIT;'])

      const qRes = await session.runQuery('q-libsql-1', 'SELECT id, title, done FROM todos ORDER BY id ASC;', 1)
      expect(qRes.isSelect).toBe(true)
      expect(qRes.rowCount).toBe(1)
      expect(qRes.truncated).toBe(true)
      expect(qRes.columns.map((c) => c.name)).toEqual(['id', 'title', 'done'])

      const slowPromise = session.runQuery('q-libsql-cancel', 'SELECT SLEEP_HRANA();')
      slowPromise.catch(() => {})
      await new Promise((r) => setTimeout(r, 30))
      const cancelRes = await session.cancelQuery('q-libsql-cancel')
      expect(cancelRes.ok).toBe(true)
      await expect(slowPromise).rejects.toMatchObject({ code: 'cancelled' })
    } finally {
      await session.close()
    }

    await expect(session.runQuery('q-closed', 'SELECT 1;')).rejects.toSatisfy(
      (err: unknown) => err instanceof DatabaseDriverError && err.code === 'SESSION_CLOSED' && err.driver === 'libsql'
    )
  })
})

describe('Wave 2A Slice 8 — 8-Engine Driver Registry & URI Dialect Integration', () => {
  it('registers all 8 drivers in getDriver/createDriver with matching type property', () => {
    for (const driverType of SUPPORTED_DRIVERS) {
      const driver = getDriver(driverType)
      expect(driver.type).toBe(driverType)
      expect(createDriver(driverType)).toBe(driver)
    }

    expect(() => getDriver('oracle' as any)).toThrow(/Unsupported database driver/i)
  })

  it('integrates CockroachDB & MariaDB parsed URIs cleanly with driver registry and session dialects', async () => {
    const crdbUri = parseConnectionUri('cockroachdb://max:roach@crdb.internal/movr')
    expect(crdbUri.ok).toBe(true)
    const crdbDriver = getDriver(crdbUri.profile!.driver!)
    expect(crdbDriver.type).toBe('cockroachdb')
    const crdbSession = await crdbDriver.createSession(
      {
        id: 'crdb-uri',
        name: 'CRDB URI',
        driver: crdbUri.profile!.driver!,
        database: crdbUri.profile!.database!,
        host: crdbUri.profile!.host,
        port: crdbUri.profile!.port,
        ssl: crdbUri.profile!.ssl,
      },
      crdbUri.password
    )
    expect(crdbSession.driverType).toBe('cockroachdb')
    await crdbSession.close()

    const mariaUri = parseConnectionUri('mariadb://dba:pass@maria.internal/shop')
    expect(mariaUri.ok).toBe(true)
    const mariaDriver = getDriver(mariaUri.profile!.driver!)
    expect(mariaDriver.type).toBe('mariadb')
    const mariaSession = await mariaDriver.createSession(
      {
        id: 'maria-uri',
        name: 'MariaDB URI',
        driver: mariaUri.profile!.driver!,
        database: mariaUri.profile!.database!,
        host: mariaUri.profile!.host,
        port: mariaUri.profile!.port,
        ssl: mariaUri.profile!.ssl,
      },
      mariaUri.password
    )
    expect(mariaSession.driverType).toBe('mariadb')
    await mariaSession.close()
  })

  it('rejects previewChanges, applyChanges, and getDdl on closed sessions with SESSION_CLOSED', async () => {
    const sqliteDriver = new SqliteDriver()
    const sqliteSess = await sqliteDriver.createSession({
      id: 'closed-sqlite',
      name: 'Closed SQLite',
      driver: 'sqlite',
      database: ':memory:',
    })
    await sqliteSess.close()

    const crdbSess = new PostgresSession(
      { connect: vi.fn(), query: vi.fn(), end: vi.fn().mockResolvedValue(undefined) } as any,
      { id: 'closed-crdb', name: 'Closed CRDB', driver: 'cockroachdb', database: 'defaultdb' }
    )
    await crdbSess.close()

    const mariaSess = new MysqlSession(
      { getConnection: vi.fn(), query: vi.fn(), end: vi.fn().mockResolvedValue(undefined) } as any,
      { id: 'closed-maria', name: 'Closed Maria', driver: 'mariadb', database: 'shop' }
    )
    await mariaSess.close()

    const chSess = new ClickHouseSession({
      id: 'closed-ch',
      name: 'Closed CH',
      driver: 'clickhouse',
      database: 'default',
      url: 'http://127.0.0.1:8123',
    })
    await chSess.close()

    const libsqlSess = new LibsqlSession({
      id: 'closed-libsql',
      name: 'Closed LibSQL',
      driver: 'libsql',
      database: 'db',
      url: 'http://127.0.0.1:8080',
    })
    await libsqlSess.close()

    const redisSess = new RedisSession({
      id: 'closed-redis',
      name: 'Closed Redis',
      driver: 'redis',
      database: '0',
      host: '127.0.0.1',
      port: 6379,
    })
    await redisSess.close()

    for (const [expectedDriver, sess] of [
      ['sqlite', sqliteSess],
      ['cockroachdb', crdbSess],
      ['mariadb', mariaSess],
      ['clickhouse', chSess],
      ['libsql', libsqlSess],
      ['redis', redisSess],
    ] as const) {
      await expect(sess.previewChanges({ table: 't' })).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof DatabaseDriverError &&
          err.code === 'SESSION_CLOSED' &&
          err.driver === expectedDriver
      )
      await expect(sess.applyChanges({ table: 't', inserts: [{ id: 1 }] })).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof DatabaseDriverError &&
          err.code === 'SESSION_CLOSED' &&
          err.driver === expectedDriver
      )
      await expect(sess.getDdl('t')).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof DatabaseDriverError &&
          err.code === 'SESSION_CLOSED' &&
          err.driver === expectedDriver
      )
    }
  })
})

describe('Wave 4 — BE Hardening Slice 1: Safe SQL Boolean Coercion (toSqlBool)', () => {
  it('coerces SQL boolean representations without treating "0" or Uint8Array([0]) as true', () => {
    expect(toSqlBool(true)).toBe(true)
    expect(toSqlBool(1)).toBe(true)
    expect(toSqlBool('1')).toBe(true)
    expect(toSqlBool('true')).toBe(true)
    expect(toSqlBool('TRUE')).toBe(true)
    expect(toSqlBool(new Uint8Array([1]))).toBe(true)
    expect(toSqlBool(Buffer.from([1]))).toBe(true)

    expect(toSqlBool(false)).toBe(false)
    expect(toSqlBool(0)).toBe(false)
    expect(toSqlBool('0')).toBe(false)
    expect(toSqlBool('false')).toBe(false)
    expect(toSqlBool('FALSE')).toBe(false)
    expect(toSqlBool(new Uint8Array([0]))).toBe(false)
    expect(toSqlBool(Buffer.from([0]))).toBe(false)
    expect(toSqlBool(null)).toBe(false)
    expect(toSqlBool(undefined)).toBe(false)
  })

  it('prevents mysql2 bigNumberStrings "0" flags from coercing to true in introspectMysqlTableDetails and introspectPostgresTableDetails', async () => {
    const mysqlMockQuery = vi.fn(async (sql: string) => {
      if (sql.includes("WHEN table_type = 'VIEW'")) return [{ kind: 'table' }]
      if (sql.includes('FROM information_schema.columns')) {
        return [
          {
            name: 'id',
            type: 'int',
            native_type: 'int',
            nullable: '0',
            default_value: null,
            is_primary_key: '1',
            is_auto_increment: '1',
          },
          {
            name: 'title',
            type: 'varchar(100)',
            native_type: 'varchar',
            nullable: '0',
            default_value: null,
            is_primary_key: '0',
            is_auto_increment: '0',
          },
          {
            name: 'flag',
            type: 'bit(1)',
            native_type: 'bit',
            nullable: new Uint8Array([1]),
            default_value: null,
            is_primary_key: new Uint8Array([0]),
            is_auto_increment: '0',
          },
        ]
      }
      if (sql.includes("constraint_name = 'PRIMARY'")) return [{ column_name: 'id' }]
      if (sql.includes('referenced_table_name IS NOT NULL')) return []
      if (sql.includes('FROM information_schema.statistics')) {
        return [
          {
            name: 'idx_title',
            is_unique: '0',
            is_primary: '0',
            column_name: 'title',
            seq_in_index: 1,
          },
        ]
      }
      return []
    })

    const mysqlDetails = await introspectMysqlTableDetails(mysqlMockQuery, 'posts', 'app')
    expect(mysqlDetails.columns[0]).toMatchObject({
      name: 'id',
      nullable: false,
      isPrimaryKey: true,
      isAutoIncrement: true,
    })
    expect(mysqlDetails.columns[1]).toMatchObject({
      name: 'title',
      nullable: false,
      isPrimaryKey: false,
      isAutoIncrement: false,
    })
    expect(mysqlDetails.columns[2]).toMatchObject({
      name: 'flag',
      nullable: true,
      isPrimaryKey: false,
      isAutoIncrement: false,
    })
    expect(mysqlDetails.indexes[0]).toMatchObject({
      name: 'idx_title',
      isUnique: false,
      isPrimary: false,
    })

    const pgMockQuery = vi.fn(async (sql: string) => {
      if (sql.includes("WHEN table_type = 'VIEW'")) return [{ kind: 'table' }]
      if (sql.includes("tc.constraint_type = 'PRIMARY KEY'")) return [{ column_name: 'id' }]
      if (sql.includes('FROM information_schema.columns')) {
        return [
          {
            name: 'id',
            type: 'integer',
            native_type: 'int4',
            nullable: '0',
            default_value: null,
            is_auto_increment: '1',
          },
          {
            name: 'note',
            type: 'text',
            native_type: 'text',
            nullable: 'true',
            default_value: null,
            is_auto_increment: '0',
          },
        ]
      }
      if (sql.includes("tc.constraint_type = 'FOREIGN KEY'")) return []
      if (sql.includes('pg_catalog.pg_index')) {
        return [
          { index_name: 'idx_note', is_unique: '0', is_primary: '0', column_name: 'note' },
        ]
      }
      return []
    })

    const pgDetails = await introspectPostgresTableDetails(pgMockQuery, 'posts', 'public')
    expect(pgDetails.columns[0]).toMatchObject({
      name: 'id',
      nullable: false,
      isAutoIncrement: true,
    })
    expect(pgDetails.columns[1]).toMatchObject({
      name: 'note',
      nullable: true,
      isAutoIncrement: false,
    })
    expect(pgDetails.indexes[0]).toMatchObject({
      name: 'idx_note',
      isUnique: false,
      isPrimary: false,
    })
  })
})

describe('Wave 4 — BE Hardening Slice 2: SQLite Param Normalization & Multi-Statement Execution', () => {
  it('normalizes booleans, undefined, valid/invalid Dates, bigint, and Uint8Array/Buffer in node:sqlite worker_threads', async () => {
    const driver = new SqliteDriver()
    const session = (await driver.createSession({
      id: 'sqlite-params',
      name: 'SQLite Params',
      driver: 'sqlite',
      database: ':memory:',
    })) as SqliteSession

    try {
      await session.runQuery(
        'init-param-tbl',
        `CREATE TABLE param_check (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          active INTEGER NOT NULL,
          created_at TEXT,
          invalid_dt TEXT,
          undef_col TEXT,
          big_num INTEGER,
          payload BLOB
        );`
      )

      const validDate = new Date('2026-11-18T03:30:00.000Z')
      const invalidDate = new Date('invalid-date')
      const binaryData = new Uint8Array([1, 2, 3, 4])

      const applied = await session.applyChanges({
        table: 'param_check',
        inserts: [
          {
            active: true,
            created_at: validDate,
            invalid_dt: invalidDate,
            undef_col: 'initial',
            big_num: 123456n,
            payload: binaryData,
          },
        ],
      })
      expect(applied.ok).toBe(true)
      expect(applied.inserted).toBe(1)

      const updBool = await session.updateCell({
        table: 'param_check',
        primaryKeys: { id: 1 },
        column: 'active',
        newValue: false,
        originalValue: true,
      })
      expect(updBool.ok).toBe(true)
      expect(updBool.updatedRecord?.active).toBe(0)

      const updUndef = await session.updateCell({
        table: 'param_check',
        primaryKeys: { id: 1 },
        column: 'undef_col',
        newValue: undefined,
        originalValue: 'initial',
      })
      expect(updUndef.ok).toBe(true)
      expect(updUndef.updatedRecord?.undef_col).toBeNull()

      const checkRes = await session.runQuery(
        'check-params',
        'SELECT active, created_at, invalid_dt, undef_col, big_num, payload FROM param_check WHERE id = 1;'
      )
      expect(checkRes.rows[0][0]).toBe(0)
      expect(checkRes.rows[0][1]).toBe('2026-11-18T03:30:00.000Z')
      expect(checkRes.rows[0][2]).toBeNull()
      expect(checkRes.rows[0][3]).toBeNull()
      expect(checkRes.rows[0][4]).toBe(123456)
      expect(Buffer.from(checkRes.rows[0][5] as Uint8Array)).toEqual(Buffer.from([1, 2, 3, 4]))
    } finally {
      await session.close()
    }
  })

  it('executes multi-statement SQLite scripts sequentially, preserving quoted semicolons, RETURNING rows, and cumulative affectedRows', async () => {
    const driver = new SqliteDriver()
    const session = (await driver.createSession({
      id: 'sqlite-multi-stmt',
      name: 'SQLite Multi Stmt',
      driver: 'sqlite',
      database: ':memory:',
    })) as SqliteSession

    try {
      const dmlBatch = await session.runQuery(
        'q-dml-batch',
        `
          CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);
          INSERT INTO notes (title) VALUES ('first;part');
          INSERT INTO notes (title) VALUES ('second');
          UPDATE notes SET title = 'second-updated' WHERE title = 'second';
        `
      )
      expect(dmlBatch.isSelect).toBe(false)
      expect(dmlBatch.affectedRows).toBe(3)
      expect(dmlBatch.rowCount).toBe(0)

      const mixedSelect = await session.runQuery(
        'q-mixed-select',
        `
          INSERT INTO notes (title) VALUES ('third;semi');
          SELECT 1 AS ignore_me;
          -- last row-returning statement wins
          SELECT id, title FROM notes ORDER BY id ASC;
        `,
        2
      )
      expect(mixedSelect.isSelect).toBe(true)
      expect(mixedSelect.columns.map((c) => c.name)).toEqual(['id', 'title'])
      expect(mixedSelect.rowCount).toBe(2)
      expect(mixedSelect.truncated).toBe(true)
      expect(mixedSelect.rows).toEqual([
        [1, 'first;part'],
        [2, 'second-updated'],
      ])

      const returningRes = await session.runQuery(
        'q-returning',
        `
          INSERT INTO notes (title) VALUES ('from-returning') RETURNING id, title;
        `
      )
      expect(returningRes.isSelect).toBe(true)
      expect(returningRes.columns.map((c) => c.name)).toEqual(['id', 'title'])
      expect(returningRes.rows).toEqual([[4, 'from-returning']])

      const selectThenDelete = await session.runQuery(
        'q-sel-then-del',
        `
          SELECT title FROM notes WHERE id = 4;
          DELETE FROM notes WHERE id = 4;
        `
      )
      expect(selectThenDelete.isSelect).toBe(true)
      expect(selectThenDelete.rows).toEqual([['from-returning']])

      const remaining = await session.runQuery('q-verify-del', 'SELECT COUNT(*) AS cnt FROM notes;')
      expect(remaining.rows).toEqual([[3]])
    } finally {
      await session.close()
    }
  })
})

describe('Wave 4 — BE Hardening Slice 3: Multi-Statement Query Execution (LibSQL, Postgres, MySQL)', () => {
  it('executes multi-statement scripts in LibsqlSession via single executePipeline batch, returning last row-returning result or cumulative affectedRows', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT NOT NULL);')
    const pipelineSqlBatches: string[][] = []

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          requests: Array<{
            type: string
            stmt?: { sql: string }
            batch?: {
              steps: Array<{
                condition?: unknown
                stmt: { sql: string }
              }>
            }
          }>
        }
        const execSqls: string[] = []
        for (const r of body.requests) {
          if (r.type === 'execute' && r.stmt) {
            execSqls.push(r.stmt.sql)
          } else if (r.type === 'batch' && r.batch) {
            for (const step of r.batch.steps) {
              execSqls.push(step.stmt.sql)
            }
          }
        }
        pipelineSqlBatches.push(execSqls)

        const evalCond = (
          cond: unknown,
          stepResults: Array<unknown | null>,
          stepErrors: Array<unknown | null>
        ): boolean => {
          if (!cond || typeof cond !== 'object') return true
          const c = cond as {
            type: string
            step?: number
            cond?: unknown
            conds?: unknown[]
          }
          if (c.type === 'ok' && typeof c.step === 'number') {
            return stepResults[c.step] !== null && stepResults[c.step] !== undefined
          }
          if (c.type === 'error' && typeof c.step === 'number') {
            return stepErrors[c.step] !== null && stepErrors[c.step] !== undefined
          }
          if (c.type === 'not') return !evalCond(c.cond, stepResults, stepErrors)
          if (c.type === 'and' && Array.isArray(c.conds)) {
            return c.conds.every((sub) => evalCond(sub, stepResults, stepErrors))
          }
          if (c.type === 'or' && Array.isArray(c.conds)) {
            return c.conds.some((sub) => evalCond(sub, stepResults, stepErrors))
          }
          return true
        }

        const runOneSql = (sql: string) => {
          const stmt = db.prepare(sql)
          if (stmt.columns().length > 0) {
            stmt.setReturnArrays(true)
            const cols = stmt.columns().map((c) => ({ name: c.name, decltype: c.type || 'TEXT' }))
            const rows = (stmt.all() as unknown as unknown[][]).map((row) =>
              row.map(encodeHranaCell)
            )
            return { cols, rows, affected_row_count: 0 }
          }
          const runRes = stmt.run()
          return { cols: [], rows: [], affected_row_count: runRes.changes }
        }

        const results = body.requests.map((item) => {
          if (item.type === 'close') {
            return { type: 'ok', response: { type: 'close' } }
          }
          if (item.type === 'batch' && item.batch) {
            const step_results: Array<unknown | null> = []
            const step_errors: Array<unknown | null> = []
            for (const step of item.batch.steps) {
              if (!evalCond(step.condition, step_results, step_errors)) {
                step_results.push(null)
                step_errors.push(null)
                continue
              }
              try {
                step_results.push(runOneSql(step.stmt.sql))
                step_errors.push(null)
              } catch (err: unknown) {
                step_results.push(null)
                step_errors.push({
                  message: err instanceof Error ? err.message : String(err),
                  code: 'SQLITE_ERROR',
                })
              }
            }
            return {
              type: 'ok',
              response: { type: 'batch', result: { step_results, step_errors } },
            }
          }
          const sql = item.stmt!.sql
          return {
            type: 'ok',
            response: { type: 'execute', result: runOneSql(sql) },
          }
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ results }))
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as net.AddressInfo).port
    const session = new LibsqlSession({
      id: 'libsql-multi',
      name: 'LibSQL Multi',
      driver: 'libsql',
      database: 'logs',
      url: `http://127.0.0.1:${port}`,
    })

    try {
      const dmlOnly = await session.runQuery(
        'q-libsql-dml',
        "INSERT INTO logs (msg) VALUES ('one;two'); INSERT INTO logs (msg) VALUES ('three');"
      )
      expect(pipelineSqlBatches[0]).toEqual([
        "INSERT INTO logs (msg) VALUES ('one;two')",
        "INSERT INTO logs (msg) VALUES ('three')",
      ])
      expect(dmlOnly.isSelect).toBe(false)
      expect(dmlOnly.affectedRows).toBe(2)

      const mixed = await session.runQuery(
        'q-libsql-mixed',
        "INSERT INTO logs (msg) VALUES ('four'); SELECT 1 AS first_col; SELECT id, msg FROM logs ORDER BY id ASC;",
        2
      )
      expect(pipelineSqlBatches[1]).toHaveLength(3)
      expect(mixed.isSelect).toBe(true)
      expect(mixed.columns.map((c) => c.name)).toEqual(['id', 'msg'])
      expect(mixed.rowCount).toBe(2)
      expect(mixed.truncated).toBe(true)
      expect(mixed.rows).toEqual([
        [1, 'one;two'],
        [2, 'three'],
      ])

      // Single-statement path preserved unchanged
      await session.runQuery('q-libsql-single', 'SELECT COUNT(*) AS c FROM logs;')
      expect(pipelineSqlBatches[2]).toEqual(['SELECT COUNT(*) AS c FROM logs;'])
    } finally {
      await session.close()
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      db.close()
    }
  })

  it('executes multi-statement scripts sequentially on PostgresSession client, returning last row-returning result or cumulative affectedRows', async () => {
    const executedSqls: string[] = []
    const mockClient = {
      processID: 777,
      query: vi.fn(async (arg: string | { text: string; rowMode?: string }) => {
        const sql = typeof arg === 'string' ? arg : arg.text
        const arrayMode = typeof arg !== 'string' && arg.rowMode === 'array'
        executedSqls.push(sql)
        if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) {
          return { fields: [], rows: [], rowCount: 2 }
        }
        if (sql.startsWith('SELECT 1')) {
          return {
            fields: [{ name: 'first_val', dataTypeID: 23 }],
            rows: arrayMode ? [[1]] : [{ first_val: 1 }],
            rowCount: 1,
          }
        }
        return {
          fields: [
            { name: 'id', dataTypeID: 23 },
            { name: 'label', dataTypeID: 25 },
          ],
          rows: arrayMode
            ? [
                [1, 'alpha'],
                [2, 'beta'],
                [3, 'gamma'],
              ]
            : [
                { id: 1, label: 'alpha' },
                { id: 2, label: 'beta' },
                { id: 3, label: 'gamma' },
              ],
          rowCount: 3,
        }
      }),
      release: vi.fn(),
    }
    const mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
      query: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    }

    const session = new PostgresSession(mockPool as any, {
      id: 'pg-multi',
      name: 'PG Multi',
      driver: 'postgres',
      database: 'app',
    })

    const dmlRes = await session.runQuery(
      'q-pg-dml',
      "INSERT INTO t VALUES ('a;b'); UPDATE t SET v = 'c';"
    )
    expect(executedSqls).toEqual(["INSERT INTO t VALUES ('a;b')", "UPDATE t SET v = 'c'"])
    expect(dmlRes.isSelect).toBe(false)
    expect(dmlRes.affectedRows).toBe(4)

    executedSqls.length = 0
    const mixedRes = await session.runQuery(
      'q-pg-mixed',
      'INSERT INTO t VALUES (1); SELECT 1; SELECT id, label FROM t;',
      2
    )
    expect(executedSqls).toEqual([
      'INSERT INTO t VALUES (1)',
      'SELECT 1',
      'SELECT id, label FROM t',
    ])
    expect(mixedRes.isSelect).toBe(true)
    expect(mixedRes.rowCount).toBe(2)
    expect(mixedRes.truncated).toBe(true)
    expect(mixedRes.rows).toEqual([
      [1, 'alpha'],
      [2, 'beta'],
    ])

    // Single statement keeps original string intact
    executedSqls.length = 0
    await session.runQuery('q-pg-single', 'SELECT id, label FROM t;')
    expect(executedSqls).toEqual(['SELECT id, label FROM t;'])
  })

  it('executes multi-statement scripts sequentially on MysqlSession connection, returning last row-returning result or cumulative affectedRows', async () => {
    const executedSqls: string[] = []
    const mockConn = {
      threadId: 888,
      query: vi.fn(async (arg: string | { sql: string; rowsAsArray?: boolean }) => {
        const sql = typeof arg === 'string' ? arg : arg.sql
        const arrayMode = typeof arg !== 'string' && arg.rowsAsArray === true
        executedSqls.push(sql)
        if (sql.startsWith('INSERT') || sql.startsWith('DELETE')) {
          return [{ affectedRows: 3 }, undefined]
        }
        if (sql.startsWith('SELECT 1')) {
          return [
            arrayMode ? [[1]] : [{ first_val: 1 }],
            [{ name: 'first_val', columnType: 3 }],
          ]
        }
        return [
          arrayMode
            ? [
                [10, 'A'],
                [20, 'B'],
                [30, 'C'],
              ]
            : [
                { id: 10, sku: 'A' },
                { id: 20, sku: 'B' },
                { id: 30, sku: 'C' },
              ],
          [
            { name: 'id', columnType: 3 },
            { name: 'sku', columnType: 253 },
          ],
        ]
      }),
      release: vi.fn(),
    }
    const mockPool = {
      getConnection: vi.fn().mockResolvedValue(mockConn),
      query: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    }

    const session = new MysqlSession(mockPool as any, {
      id: 'mysql-multi',
      name: 'MySQL Multi',
      driver: 'mysql',
      database: 'shop',
    })

    const dmlRes = await session.runQuery(
      'q-my-dml',
      "INSERT INTO items VALUES ('x;y'); DELETE FROM items WHERE id = 0;"
    )
    expect(executedSqls).toEqual([
      "INSERT INTO items VALUES ('x;y')",
      'DELETE FROM items WHERE id = 0',
    ])
    expect(dmlRes.isSelect).toBe(false)
    expect(dmlRes.affectedRows).toBe(6)

    executedSqls.length = 0
    const mixedRes = await session.runQuery(
      'q-my-mixed',
      'INSERT INTO items VALUES (1); SELECT 1; SELECT id, sku FROM items;',
      2
    )
    expect(executedSqls).toEqual([
      'INSERT INTO items VALUES (1)',
      'SELECT 1',
      'SELECT id, sku FROM items',
    ])
    expect(mixedRes.isSelect).toBe(true)
    expect(mixedRes.rowCount).toBe(2)
    expect(mixedRes.truncated).toBe(true)
    expect(mixedRes.rows).toEqual([
      [10, 'A'],
      [20, 'B'],
    ])

    // Single statement preserves original SQL string
    executedSqls.length = 0
    await session.runQuery('q-my-single', 'SELECT id, sku FROM items;')
    expect(executedSqls).toEqual(['SELECT id, sku FROM items;'])
  })
})

describe('Wave 4 — BE Hardening Slice 4: 15s TableDetails Metadata Cache & DDL Invalidation', () => {
  it('caches SqliteSession getTableDetails for 15s across fetchPage calls and invalidates on DDL, updateCell, applyChanges, and close', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa_cache_sqlite_'))
    const dbPath = path.join(tmpDir, 'cache.db')
    const setupDb = new DatabaseSync(dbPath)
    setupDb.exec(`
      CREATE TABLE widgets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      INSERT INTO widgets (name) VALUES ('w1'), ('w2'), ('w3');
    `)
    setupDb.close()

    const driver = new SqliteDriver()
    const session = (await driver.createSession({
      id: 'sqlite-cache',
      name: 'SQLite Cache',
      driver: 'sqlite',
      database: 'cache.db',
      filePath: dbPath,
    })) as SqliteSession

    let nowMs = 1_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs)

    try {
      // 1st fetchPage populates metadata cache
      const page1 = await session.fetchPage({ table: 'widgets', page: 1, pageSize: 2 })
      expect(page1.columns.map((c) => c.name)).toEqual(['id', 'name'])

      // Mutate schema externally out-of-band: within 15s, cache serves stale 2-col metadata (no PRAGMA round-trip)
      const extDb = new DatabaseSync(dbPath)
      extDb.exec('ALTER TABLE widgets ADD COLUMN ext_col TEXT;')
      extDb.close()

      nowMs += 5_000
      const page2 = await session.fetchPage({ table: 'widgets', page: 2, pageSize: 2 })
      expect(page2.columns.map((c) => c.name)).toEqual(['id', 'name'])

      // TTL expiry (> 15000ms) refreshes metadata
      nowMs += 10_001
      const refreshed = await session.getTableDetails('widgets')
      expect(refreshed.columns.map((c) => c.name)).toEqual(['id', 'name', 'ext_col'])

      // runQuery with string literal containing 'ALTER TABLE' does NOT clear cache
      const extDb2 = new DatabaseSync(dbPath)
      extDb2.exec('ALTER TABLE widgets ADD COLUMN ext_col_2 TEXT;')
      extDb2.close()
      await session.runQuery('q-no-ddl', "SELECT 'ALTER TABLE widgets DROP COLUMN x' AS note;")
      expect((await session.getTableDetails('widgets')).columns.map((c) => c.name)).toEqual([
        'id',
        'name',
        'ext_col',
      ])

      // runQuery with real DDL (including multi-statement) invalidates cache immediately
      await session.runQuery(
        'q-ddl',
        'SELECT 1; ALTER TABLE widgets ADD COLUMN ddl_col TEXT;'
      )
      expect((await session.getTableDetails('widgets')).columns.map((c) => c.name)).toEqual([
        'id',
        'name',
        'ext_col',
        'ext_col_2',
        'ddl_col',
      ])

      // updateCell invalidates cache
      const extDb3 = new DatabaseSync(dbPath)
      extDb3.exec('ALTER TABLE widgets ADD COLUMN after_upd TEXT;')
      extDb3.close()
      await session.updateCell({
        table: 'widgets',
        primaryKeys: { id: 1 },
        column: 'name',
        newValue: 'w1-edited',
      })
      expect((await session.getTableDetails('widgets')).columns.map((c) => c.name)).toContain(
        'after_upd'
      )

      // applyChanges invalidates cache
      const extDb4 = new DatabaseSync(dbPath)
      extDb4.exec('ALTER TABLE widgets ADD COLUMN after_apply TEXT;')
      extDb4.close()
      await session.applyChanges({
        table: 'widgets',
        inserts: [{ name: 'w4' }],
      })
      expect((await session.getTableDetails('widgets')).columns.map((c) => c.name)).toContain(
        'after_apply'
      )
    } finally {
      nowSpy.mockRestore()
      await session.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('caches PostgresSession and MysqlSession getTableDetails for 15s and invalidates on DDL, updateCell, applyChanges, and close', async () => {
    let nowMs = 2_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs)

    try {
      // --- PostgreSQL cache verification ---
      let pgColQueries = 0
      const pgMockClient = {
        processID: 111,
        query: vi.fn(async () => ({ fields: [], rows: [], rowCount: 1 })),
        release: vi.fn(),
      }
      const pgMockPool = {
        connect: vi.fn().mockResolvedValue(pgMockClient),
        query: vi.fn(
          async (arg: string | { text: string; values?: unknown[]; queryMode?: string }) => {
            const sql = typeof arg === 'string' ? arg : arg.text
          if (sql.includes('FROM information_schema.columns')) {
            pgColQueries++
            return {
              rows: [
                {
                  name: 'id',
                  type: 'integer',
                  native_type: 'int4',
                  nullable: false,
                  default_value: null,
                  is_auto_increment: true,
                },
              ],
            }
          }
          if (sql.includes("WHEN table_type = 'VIEW'")) return { rows: [{ kind: 'table' }] }
          if (sql.includes("tc.constraint_type = 'PRIMARY KEY'")) {
            return { rows: [{ column_name: 'id' }] }
          }
          if (sql.includes('SELECT COUNT(*)')) return { rows: [{ total: '2' }] }
          if (sql.includes('SELECT * FROM')) return { rows: [{ id: 1 }], rowCount: 1 }
          if (sql.startsWith('UPDATE')) return { rows: [{ id: 1 }], rowCount: 1 }
          return { rows: [], rowCount: 0 }
          }
        ),
        end: vi.fn().mockResolvedValue(undefined),
      }

      const pgSession = new PostgresSession(pgMockPool as any, {
        id: 'pg-cache',
        name: 'PG Cache',
        driver: 'postgres',
        database: 'app',
      })

      await pgSession.fetchPage({ table: 'orders', page: 1, pageSize: 10 })
      expect(pgColQueries).toBe(1)

      nowMs += 5_000
      await pgSession.fetchPage({ table: 'orders', page: 2, pageSize: 10, sortColumn: 'id' })
      expect(pgColQueries).toBe(1) // Cache hit!

      nowMs += 10_001
      await pgSession.getTableDetails('orders')
      expect(pgColQueries).toBe(2) // Expired after 15s

      await pgSession.updateCell({
        table: 'orders',
        primaryKeys: { id: 1 },
        column: 'id',
        newValue: 1,
      })
      await pgSession.getTableDetails('orders')
      expect(pgColQueries).toBe(3) // Cleared by updateCell

      await pgSession.applyChanges({ table: 'orders', inserts: [{ id: 2 }] })
      await pgSession.getTableDetails('orders')
      expect(pgColQueries).toBe(4) // Cleared by applyChanges

      await pgSession.runQuery('q-pg-non-ddl', "SELECT 'DROP TABLE orders';")
      await pgSession.getTableDetails('orders')
      expect(pgColQueries).toBe(4) // Non-DDL keeps cache warm

      await pgSession.runQuery('q-pg-ddl', 'TRUNCATE TABLE orders;')
      await pgSession.getTableDetails('orders')
      expect(pgColQueries).toBe(5) // DDL clears cache

      await pgSession.close()

      // --- MySQL cache verification ---
      let myColQueries = 0
      const myMockConn = {
        threadId: 222,
        beginTransaction: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined),
        query: vi.fn(async () => [{ affectedRows: 1 }, undefined]),
        release: vi.fn(),
      }
      const myMockPool = {
        getConnection: vi.fn().mockResolvedValue(myMockConn),
        query: vi.fn(async (sql: string) => {
          if (sql.includes('FROM information_schema.columns')) {
            myColQueries++
            return [[
              {
                name: 'id',
                type: 'int',
                native_type: 'int',
                nullable: '0',
                default_value: null,
                is_primary_key: '1',
                is_auto_increment: '1',
              },
            ]]
          }
          if (sql.includes("WHEN table_type = 'VIEW'")) return [[{ kind: 'table' }]]
          if (sql.includes("constraint_name = 'PRIMARY'")) return [[{ column_name: 'id' }]]
          if (sql.includes('SELECT COUNT(*)')) return [[{ total: 2 }]]
          if (sql.includes('SELECT * FROM')) return [[{ id: 1 }]]
          if (sql.startsWith('UPDATE')) return [{ affectedRows: 1 }]
          return [[]]
        }),
        end: vi.fn().mockResolvedValue(undefined),
      }

      const mySession = new MysqlSession(myMockPool as any, {
        id: 'my-cache',
        name: 'MySQL Cache',
        driver: 'mysql',
        database: 'shop',
      })

      await mySession.fetchPage({ table: 'orders', page: 1, pageSize: 10 })
      expect(myColQueries).toBe(1)

      nowMs += 5_000
      await mySession.fetchPage({ table: 'orders', page: 2, pageSize: 10 })
      expect(myColQueries).toBe(1) // Cache hit!

      nowMs += 10_001
      await mySession.getTableDetails('orders')
      expect(myColQueries).toBe(2) // Expired after 15s

      await mySession.updateCell({
        table: 'orders',
        primaryKeys: { id: 1 },
        column: 'id',
        newValue: 1,
      })
      await mySession.getTableDetails('orders')
      expect(myColQueries).toBe(3) // Cleared by updateCell

      await mySession.applyChanges({ table: 'orders', inserts: [{ id: 2 }] })
      await mySession.getTableDetails('orders')
      expect(myColQueries).toBe(4) // Cleared by applyChanges

      await mySession.runQuery('q-my-ddl', 'RENAME TABLE orders TO orders_v2;')
      await mySession.getTableDetails('orders')
      expect(myColQueries).toBe(5) // Cleared by DDL

      await mySession.close()
    } finally {
      nowSpy.mockRestore()
    }
  })
})

describe('Wave 4 — BE Hardening Slice 5: Multi-Statement Read-Only Guard', () => {
  it('blocks multi-statement SQL scripts if any statement mutates, including PRAGMA setters and COPY, while allowing multi-statement read-only SQL', () => {
    expect(isMutatingStatement('SELECT 1; DELETE FROM users;', 'postgres')).toBe(true)
    expect(isMutatingStatement('SELECT 1; DELETE FROM users;', 'sqlite')).toBe(true)
    expect(isMutatingStatement('SELECT 1; PRAGMA query_only(0);', 'sqlite')).toBe(true)
    expect(isMutatingStatement('SELECT 1; PRAGMA foreign_keys = ON;', 'sqlite')).toBe(true)
    expect(isMutatingStatement("COPY users FROM '/tmp/u.csv';", 'postgres')).toBe(true)

    expect(
      isMutatingStatement(
        'PRAGMA table_info(users); PRAGMA foreign_key_list(orders);',
        'sqlite'
      )
    ).toBe(false)
    expect(isMutatingStatement('SHOW TABLES; DESCRIBE users;', 'mysql')).toBe(false)
    expect(
      isMutatingStatement('EXPLAIN SELECT 1; WITH c AS (SELECT 2) SELECT * FROM c;', 'postgres')
    ).toBe(false)

    expect(isMutatingStatement('# header\nPING\nDEL secret', 'redis')).toBe(true)
    expect(isMutatingStatement('# header\nPING\nGET ok', 'redis')).toBe(false)
  })
})

describe('Wave 4 — BE Hardening Slice 6: Untouched Column Defaults in buildInsertStatement & applyChanges', () => {
  it('omits undefined keys cleanly in buildInsertStatement and uses DEFAULT VALUES / () VALUES () when all columns are untouched', () => {
    const pgPartial = buildInsertStatement({
      driver: 'postgres',
      table: 'audit_items',
      schema: 'public',
      row: { id: undefined, created_at: undefined, label: 'Alpha', note: null },
    })
    expect(pgPartial.sql).toBe(
      'INSERT INTO "public"."audit_items" ("label", "note") VALUES ($1, $2)'
    )
    expect(pgPartial.params).toEqual(['Alpha', null])
    expect(pgPartial.previewSql).toBe(
      'INSERT INTO "public"."audit_items" ("label", "note") VALUES (\'Alpha\', NULL);'
    )

    const sqliteAllDefault = buildInsertStatement({
      driver: 'sqlite',
      table: 'audit_items',
      row: { id: undefined, created_at: undefined },
    })
    expect(sqliteAllDefault.sql).toBe('INSERT INTO "audit_items" DEFAULT VALUES')
    expect(sqliteAllDefault.params).toEqual([])
    expect(sqliteAllDefault.previewSql).toBe('INSERT INTO "audit_items" DEFAULT VALUES;')

    const mysqlAllDefault = buildInsertStatement({
      driver: 'mysql',
      table: 'audit_items',
      schema: 'shop',
      row: { id: undefined },
    })
    expect(mysqlAllDefault.sql).toBe('INSERT INTO `shop`.`audit_items` () VALUES ()')
    expect(mysqlAllDefault.params).toEqual([])
    expect(mysqlAllDefault.previewSql).toBe('INSERT INTO `shop`.`audit_items` () VALUES ();')
  })

  it('evaluates SQLite AUTOINCREMENT and DEFAULT values when untouched columns are omitted in applyChanges', async () => {
    const driver = new SqliteDriver()
    const session = (await driver.createSession({
      id: 'sqlite-defaults',
      name: 'SQLite Defaults',
      driver: 'sqlite',
      database: ':memory:',
    })) as SqliteSession

    try {
      await session.runQuery(
        'init-defaults-tbl',
        `CREATE TABLE defaults_demo (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );`
      )

      const applied = await session.applyChanges({
        table: 'defaults_demo',
        inserts: [
          { id: undefined, status: undefined, created_at: undefined },
          { id: undefined, status: 'ready', created_at: undefined },
        ],
      })
      expect(applied.ok).toBe(true)
      expect(applied.inserted).toBe(2)

      const rowsRes = await session.runQuery(
        'read-defaults',
        'SELECT id, status, created_at FROM defaults_demo ORDER BY id ASC;'
      )
      expect(rowsRes.rows).toHaveLength(2)
      expect(rowsRes.rows[0][0]).toBe(1)
      expect(rowsRes.rows[0][1]).toBe('pending')
      expect(String(rowsRes.rows[0][2])).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      expect(rowsRes.rows[1][0]).toBe(2)
      expect(rowsRes.rows[1][1]).toBe('ready')
      expect(String(rowsRes.rows[1][2])).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    } finally {
      await session.close()
    }
  })
})

describe('Wave 12 — Track C: LibSQL Hrana v2 Baton Atomicity, Conditional Batch & Edge Fixes', () => {
  interface SpecHranaServer {
    baseUrl: string
    db: DatabaseSync
    requestsLog: Array<{ baton?: string | null; requests: unknown[] }>
    close: () => Promise<void>
  }

  async function createSpecHranaServer(initSql: string): Promise<SpecHranaServer> {
    const db = new DatabaseSync(':memory:')
    db.exec(initSql)
    const requestsLog: Array<{ baton?: string | null; requests: unknown[] }> = []
    let batonSeq = 0
    const activeBatons = new Set<string>()

    const evalCond = (
      cond: unknown,
      stepResults: Array<unknown | null>,
      stepErrors: Array<unknown | null>
    ): boolean => {
      if (!cond || typeof cond !== 'object') return true
      const c = cond as { type: string; step?: number; cond?: unknown; conds?: unknown[] }
      if (c.type === 'ok' && typeof c.step === 'number') {
        return stepResults[c.step] !== null && stepResults[c.step] !== undefined
      }
      if (c.type === 'error' && typeof c.step === 'number') {
        return stepErrors[c.step] !== null && stepErrors[c.step] !== undefined
      }
      if (c.type === 'not') return !evalCond(c.cond, stepResults, stepErrors)
      if (c.type === 'and' && Array.isArray(c.conds)) {
        return c.conds.every((sub) => evalCond(sub, stepResults, stepErrors))
      }
      if (c.type === 'or' && Array.isArray(c.conds)) {
        return c.conds.some((sub) => evalCond(sub, stepResults, stepErrors))
      }
      return true
    }

    const runStmt = (stmtObj: {
      sql: string
      args?: Array<{ type: string; value?: unknown; base64?: string }>
    }) => {
      const sql = stmtObj.sql
      const params = (stmtObj.args || []).map(decodeHranaArg)
      const stmt = db.prepare(sql)
      if (stmt.columns().length > 0) {
        stmt.setReturnArrays(true)
        const cols = stmt.columns().map((c) => ({ name: c.name, decltype: c.type || 'TEXT' }))
        const rawRows = stmt.all(...(params as Array<string | number | Uint8Array | null>)) as unknown as unknown[][]
        return {
          cols,
          rows: rawRows.map((row) =>
            row.map((cell) => {
              if (cell instanceof Uint8Array) {
                return { type: 'blob', base64: Buffer.from(cell).toString('base64') }
              }
              return encodeHranaCell(cell)
            })
          ),
          affected_row_count: 0,
          last_insert_rowid: null,
        }
      }
      const runRes = stmt.run(...(params as Array<string | number | Uint8Array | null>))
      return {
        cols: [],
        rows: [],
        affected_row_count: runRes.changes,
        last_insert_rowid: runRes.lastInsertRowid ? String(runRes.lastInsertRowid) : null,
      }
    }

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          baton?: string | null
          requests: Array<{
            type: string
            stmt?: { sql: string; args?: Array<{ type: string; value?: unknown; base64?: string }> }
            batch?: {
              steps: Array<{
                condition?: unknown
                stmt: { sql: string; args?: Array<{ type: string; value?: unknown; base64?: string }> }
              }>
            }
          }>
        }
        requestsLog.push({ baton: body.baton ?? null, requests: body.requests })

        // Spec-faithful Hrana v2: execute items in a pipeline continue independently even after errors
        const results: unknown[] = []
        let streamClosed = false
        for (const item of body.requests) {
          if (item.type === 'close') {
            streamClosed = true
            if (body.baton) activeBatons.delete(body.baton)
            results.push({ type: 'ok', response: { type: 'close' } })
            continue
          }
          if (item.type === 'batch' && item.batch) {
            const step_results: Array<unknown | null> = []
            const step_errors: Array<unknown | null> = []
            for (const step of item.batch.steps) {
              if (!evalCond(step.condition, step_results, step_errors)) {
                step_results.push(null)
                step_errors.push(null)
                continue
              }
              try {
                step_results.push(runStmt(step.stmt))
                step_errors.push(null)
              } catch (err: unknown) {
                step_results.push(null)
                step_errors.push({
                  message: err instanceof Error ? err.message : String(err),
                  code: 'SQLITE_ERROR',
                })
              }
            }
            results.push({
              type: 'ok',
              response: { type: 'batch', result: { step_results, step_errors } },
            })
            continue
          }
          if (item.type === 'execute' && item.stmt) {
            try {
              results.push({
                type: 'ok',
                response: { type: 'execute', result: runStmt(item.stmt) },
              })
            } catch (err: unknown) {
              results.push({
                type: 'error',
                error: {
                  message: err instanceof Error ? err.message : String(err),
                  code: 'SQLITE_ERROR',
                },
              })
            }
          }
        }

        let nextBaton: string | null = null
        if (!streamClosed) {
          nextBaton = `baton-${++batonSeq}`
          if (body.baton) activeBatons.delete(body.baton)
          activeBatons.add(nextBaton)
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ baton: nextBaton, results }))
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as net.AddressInfo
    return {
      baseUrl: `http://127.0.0.1:${addr.port}`,
      db,
      requestsLog,
      close: async () => {
        server.closeAllConnections?.()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        db.close()
      },
    }
  }

  it('rolls back earlier DELETE and INSERT via stateful Hrana baton on optimistic-lock conflict and UNIQUE constraint errors', async () => {
    const srv = await createSpecHranaServer(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        balance INTEGER NOT NULL
      );
      INSERT INTO accounts VALUES (1, 'a@ex.com', 100), (2, 'b@ex.com', 200);
    `)
    const session = new LibsqlSession({
      id: 'libsql-w12-baton',
      name: 'LibSQL Baton',
      driver: 'libsql',
      database: 'accounts',
      url: srv.baseUrl,
    })

    try {
      // 1) Optimistic lock conflict on UPDATE must ROLLBACK the earlier DELETE of id=1!
      await expect(
        session.applyChanges({
          table: 'accounts',
          deletes: [{ id: 1 }],
          updates: [
            {
              primaryKeys: { id: 2 },
              changes: { balance: 250 },
              originalRow: { id: 2, email: 'b@ex.com', balance: 999 }, // stale value -> 0 rows updated
            },
          ],
        })
      ).rejects.toMatchObject({ code: 'conflict' })

      const afterConflict = srv.db.prepare('SELECT id, email, balance FROM accounts ORDER BY id').all()
      expect(afterConflict).toEqual([
        { id: 1, email: 'a@ex.com', balance: 100 },
        { id: 2, email: 'b@ex.com', balance: 200 },
      ])

      // 2) UNIQUE constraint failure on second INSERT must ROLLBACK first INSERT!
      await expect(
        session.applyChanges({
          table: 'accounts',
          inserts: [
            { id: 3, email: 'c@ex.com', balance: 300 },
            { id: 4, email: 'a@ex.com', balance: 400 }, // violates UNIQUE
          ],
        })
      ).rejects.toThrow(/UNIQUE/i)

      const afterUniqueErr = srv.db.prepare('SELECT id FROM accounts ORDER BY id').all()
      expect(afterUniqueErr).toEqual([{ id: 1 }, { id: 2 }])
    } finally {
      await session.close()
      await srv.close()
    }
  })

  it('halts failed 12-step table rebuild via Hrana batch conditions and ROLLBACKs so original table is never dropped', async () => {
    const srv = await createSpecHranaServer(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT
      );
      INSERT INTO users VALUES (1, 'alice@ex.com'), (2, NULL);
    `)
    const session = new LibsqlSession({
      id: 'libsql-w12-rebuild',
      name: 'LibSQL Rebuild',
      driver: 'libsql',
      database: 'users',
      url: srv.baseUrl,
    })

    try {
      const details = await session.getTableDetails('users')
      const draft = createInitialTableDraft(details)
      // Make nullable email column NOT NULL while row 2 has NULL -> INSERT INTO temp fails NOT NULL!
      const emailCol = draft.columns.find((c) => c.name === 'email')
      expect(emailCol).toBeDefined()
      if (emailCol) {
        emailCol.nullable = false
      }
      const migrationStmts = buildTableMigrationSql(draft, 'libsql')
      const script = migrationStmts.join('\n')

      await expect(session.runQuery('q-rebuild-fail', script)).rejects.toThrow(/NOT NULL/i)

      // Original users table MUST still exist with 100% of rows intact and no open transaction!
      const rows = srv.db.prepare('SELECT id, email FROM users ORDER BY id').all()
      expect(rows).toEqual([
        { id: 1, email: 'alice@ex.com' },
        { id: 2, email: null },
      ])
      expect(srv.db.isTransaction).toBe(false)
    } finally {
      await session.close()
      await srv.close()
    }
  })

  it('fixes libsql:// ssl:false query-stripping URL, empty BLOB decoding, and PRAGMA/WITH isSelect classification', async () => {
    // 1) URL normalization with ssl: false + query/hash stripped
    const localSession = new LibsqlSession({
      id: 'libsql-url',
      name: 'Local URL',
      driver: 'libsql',
      database: 'db',
      url: 'libsql://localhost:8080/sub?authToken=tok#frag',
      ssl: false,
    })
    expect(localSession.pipelineUrl).toBe('http://localhost:8080/sub/v2/pipeline')
    await localSession.close()

    // 2) Empty BLOB (base64: '') decodes to Uint8Array(0), NOT null; PRAGMA setter & WITH ... INSERT are isSelect: false
    const srv = await createSpecHranaServer(`
      CREATE TABLE blobs (id INTEGER PRIMARY KEY, raw BLOB);
      INSERT INTO blobs VALUES (1, X'');
      CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);
    `)
    const session = new LibsqlSession({
      id: 'libsql-w12-edges',
      name: 'LibSQL Edges',
      driver: 'libsql',
      database: 'blobs',
      url: srv.baseUrl,
    })

    try {
      const blobRes = await session.runQuery('q-empty-blob', 'SELECT raw FROM blobs WHERE id = 1;')
      expect(blobRes.isSelect).toBe(true)
      expect(blobRes.rows[0][0]).toBeInstanceOf(Uint8Array)
      expect((blobRes.rows[0][0] as Uint8Array).byteLength).toBe(0)

      const pragmaSet = await session.runQuery('q-pragma-set', 'PRAGMA foreign_keys = OFF;')
      expect(pragmaSet.isSelect).toBe(false)

      const withInsert = await session.runQuery(
        'q-with-ins',
        "WITH src AS (SELECT 10 AS id, 'ten' AS name) INSERT INTO items SELECT id, name FROM src;"
      )
      expect(withInsert.isSelect).toBe(false)
      expect(withInsert.affectedRows).toBe(1)
    } finally {
      await session.close()
      await srv.close()
    }
  })
})

describe('Wave 12 — Track C: Redis Cluster, RESP3, Isolated Cancel, Key Hygiene & Sorting', () => {
  function encodeRespBulk(s: string): string {
    return `$${Buffer.byteLength(s, 'utf8')}\r\n${s}\r\n`
  }

  function encodeRespArr(items: string[]): string {
    return `*${items.length}\r\n${items.join('')}`
  }

  function parseRespCommandsFromBuffer(
    buf: Buffer
  ): { commands: string[][]; remaining: Buffer } {
    const commands: string[][] = []
    let offset = 0
    while (offset < buf.length) {
      if (buf[offset] !== 42) break // '*'
      const firstEnd = buf.indexOf('\r\n', offset)
      if (firstEnd < 0) break
      const argc = Number(buf.subarray(offset + 1, firstEnd).toString('utf8'))
      let cursor = firstEnd + 2
      const args: string[] = []
      let complete = true
      for (let i = 0; i < argc; i++) {
        if (cursor >= buf.length || buf[cursor] !== 36) {
          complete = false
          break
        }
        const lenEnd = buf.indexOf('\r\n', cursor)
        if (lenEnd < 0) {
          complete = false
          break
        }
        const byteLen = Number(buf.subarray(cursor + 1, lenEnd).toString('utf8'))
        const dataStart = lenEnd + 2
        const dataEnd = dataStart + byteLen
        if (buf.length < dataEnd + 2) {
          complete = false
          break
        }
        args.push(buf.subarray(dataStart, dataEnd).toString('utf8'))
        cursor = dataEnd + 2
      }
      if (!complete) break
      commands.push(args)
      offset = cursor
    }
    return { commands, remaining: buf.subarray(offset) }
  }

  it('omits SELECT for db0 (Redis Cluster), supports Redis 5 1-arg AUTH fallback, and isolates runQuery cancelQuery from sharedClient', async () => {
    const seenCommands: string[][] = []
    const sockets = new Set<net.Socket>()
    const server = net.createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      let acc: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk])
        const parsed = parseRespCommandsFromBuffer(acc)
        acc = parsed.remaining
        for (const cmd of parsed.commands) {
          seenCommands.push(cmd)
          const op = (cmd[0] || '').toUpperCase()
          if (op === 'AUTH') {
            if (cmd.length === 3) {
              socket.write('-ERR wrong number of arguments for \'auth\' command\r\n')
            } else if (cmd.length === 2 && cmd[1] === 'secret5') {
              socket.write('+OK\r\n')
            } else {
              socket.write('-WRONGPASS invalid password\r\n')
            }
          } else if (op === 'SELECT') {
            socket.write('-ERR SELECT is not allowed in cluster mode\r\n')
          } else if (op === 'PING') {
            socket.write('+PONG\r\n')
          } else if (op === 'SCAN') {
            socket.write(encodeRespArr([encodeRespBulk('0'), encodeRespArr([encodeRespBulk('app:k1')])]))
          } else if (op === 'SLOW') {
            // Never respond so cancelQuery aborts dedicated query socket
          } else {
            socket.write('+OK\r\n')
          }
        }
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as net.AddressInfo).port
    const session = new RedisSession(
      {
        id: 'redis-w12-cluster',
        name: 'Cluster Redis',
        driver: 'redis',
        host: '127.0.0.1',
        port,
        user: 'default',
        redisDb: 0,
        database: '0',
      },
      'secret5'
    )

    try {
      const testRes = await session.test()
      expect(testRes.ok).toBe(true)
      // Must NOT have sent SELECT 0, and must have fallen back to 1-arg AUTH
      expect(seenCommands.some((c) => c[0].toUpperCase() === 'SELECT')).toBe(false)
      expect(seenCommands.some((c) => c[0] === 'AUTH' && c.length === 2 && c[1] === 'secret5')).toBe(true)

      // Start slow query on dedicated per-query socket, cancel it, and verify sharedClient stays alive
      const slowPromise = session.runQuery('q-redis-slow', 'SLOW')
      slowPromise.catch(() => {})
      await new Promise((r) => setTimeout(r, 35))
      const cancelRes = await session.cancelQuery('q-redis-slow')
      expect(cancelRes.ok).toBe(true)
      await expect(slowPromise).rejects.toMatchObject({ code: 'cancelled' })

      // sharedClient must NOT be destroyed by cancelling runQuery
      const objs = await session.listObjects()
      expect(objs.map((o) => o.name)).toContain('app:*')
    } finally {
      await session.close()
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('decodes RESP3 attributes and push frames, rejects malformed bulk lengths, and preserves nested EXEC error text', async () => {
    const sockets = new Set<net.Socket>()
    const server = net.createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      let acc: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk])
        const parsed = parseRespCommandsFromBuffer(acc)
        acc = parsed.remaining
        for (const cmd of parsed.commands) {
          const op = (cmd[0] || '').toUpperCase()
          if (op === 'PING') {
            socket.write('+PONG\r\n')
          } else if (op === 'GETATTR') {
            // RESP3 attribute `|` followed by push `>` followed by actual reply
            socket.write(
              '|1\r\n+key-popularity\r\n:42\r\n>2\r\n+invalidate\r\n*1\r\n$3\r\nfoo\r\n+ATTR_OK\r\n'
            )
          } else if (op === 'EXEC_MIXED') {
            socket.write('*2\r\n+OK\r\n-WRONGTYPE Operation against wrong kind\r\n')
          } else if (op === 'BAD_FRAME') {
            socket.write('$Infinity\r\n')
          } else {
            socket.write('+OK\r\n')
          }
        }
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as net.AddressInfo).port
    const session = new RedisSession({
      id: 'redis-w12-resp3',
      name: 'RESP3 Redis',
      driver: 'redis',
      host: '127.0.0.1',
      port,
      redisDb: 0,
      database: '0',
    })

    try {
      const attrRes = await session.runQuery('q-resp3-attr', 'GETATTR')
      expect(attrRes.rows).toEqual([['ATTR_OK']])

      const execRes = await session.runQuery('q-resp3-exec', 'EXEC_MIXED')
      expect(execRes.rows).toEqual([
        [0, 'OK'],
        [1, 'WRONGTYPE Operation against wrong kind'],
      ])

      await expect(session.runQuery('q-resp3-bad', 'BAD_FRAME')).rejects.toThrow(/Malformed RESP/i)
    } finally {
      await session.close()
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('preserves whitespace keys, protects non-string structures, removes stale hash fields via HDEL, handles >500 sorted keys and per-key WRONGTYPE', async () => {
    const store = new Map<
      string,
      { type: string; ttl: number; value: unknown }
    >()
    store.set(' spaced ', { type: 'string', ttl: -1, value: 'orig' })
    store.set('mylist', { type: 'list', ttl: -1, value: ['a', 'b'] })
    store.set('myhash', { type: 'hash', ttl: 120, value: { f1: 'v1', f2: 'v2' } })
    store.set('flaky:wrongtype', { type: 'string', ttl: -1, value: '__THROW_WRONGTYPE__' })
    for (let i = 1; i <= 599; i++) {
      store.set(`k:${String(i).padStart(4, '0')}`, { type: 'string', ttl: i, value: `val-${i}` })
    }
    const executedCmds: string[][] = []
    const sockets = new Set<net.Socket>()

    const server = net.createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      let acc: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk])
        const parsed = parseRespCommandsFromBuffer(acc)
        acc = parsed.remaining
        for (const cmd of parsed.commands) {
          executedCmds.push(cmd)
          const op = (cmd[0] || '').toUpperCase()
          if (op === 'PING') {
            socket.write('+PONG\r\n')
          } else if (op === 'SCAN') {
            const allKeys = Array.from(store.keys())
            socket.write(
              encodeRespArr([encodeRespBulk('0'), encodeRespArr(allKeys.map(encodeRespBulk))])
            )
          } else if (op === 'TYPE') {
            const entry = store.get(cmd[1])
            socket.write(`+${entry ? entry.type : 'none'}\r\n`)
          } else if (op === 'TTL') {
            const entry = store.get(cmd[1])
            socket.write(`:${entry ? entry.ttl : -2}\r\n`)
          } else if (op === 'GET') {
            const entry = store.get(cmd[1])
            if (entry?.value === '__THROW_WRONGTYPE__') {
              socket.write('-WRONGTYPE Operation against a key holding the wrong kind of value\r\n')
            } else if (!entry) {
              socket.write('$-1\r\n')
            } else {
              socket.write(encodeRespBulk(String(entry.value)))
            }
          } else if (op === 'SET') {
            const key = cmd[1]
            const existing = store.get(key)
            store.set(key, { type: 'string', ttl: existing?.ttl ?? -1, value: cmd[2] })
            socket.write('+OK\r\n')
          } else if (op === 'HGETALL') {
            const entry = store.get(cmd[1])
            const obj = (entry?.value || {}) as Record<string, string>
            const flat: string[] = []
            for (const [k, v] of Object.entries(obj)) {
              flat.push(encodeRespBulk(k), encodeRespBulk(v))
            }
            socket.write(encodeRespArr(flat))
          } else if (op === 'HKEYS') {
            const entry = store.get(cmd[1])
            const obj = (entry?.value || {}) as Record<string, string>
            socket.write(encodeRespArr(Object.keys(obj).map(encodeRespBulk)))
          } else if (op === 'HDEL') {
            const entry = store.get(cmd[1])
            const obj = (entry?.value || {}) as Record<string, string>
            let removed = 0
            for (const field of cmd.slice(2)) {
              if (field in obj) {
                delete obj[field]
                removed++
              }
            }
            socket.write(`:${removed}\r\n`)
          } else if (op === 'HSET') {
            const entry = store.get(cmd[1]) || { type: 'hash', ttl: -1, value: {} }
            const obj = entry.value as Record<string, string>
            for (let i = 2; i + 1 < cmd.length; i += 2) {
              obj[cmd[i]] = cmd[i + 1]
            }
            store.set(cmd[1], entry)
            socket.write(':1\r\n')
          } else if (op === 'LRANGE') {
            const entry = store.get(cmd[1])
            const arr = (entry?.value || []) as string[]
            socket.write(encodeRespArr(arr.map(encodeRespBulk)))
          } else {
            socket.write('+OK\r\n')
          }
        }
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as net.AddressInfo).port
    const session = new RedisSession({
      id: 'redis-w12-keys',
      name: 'Redis Keys',
      driver: 'redis',
      host: '127.0.0.1',
      port,
      redisDb: 0,
      database: '0',
    })

    try {
      // 1) Whitespace key is NOT trimmed
      await session.updateCell({
        table: '(all)',
        primaryKeys: { key: ' spaced ' },
        column: 'value',
        newValue: 'updated',
      })
      expect(store.get(' spaced ')?.value).toBe('updated')
      expect(store.has('spaced')).toBe(false)

      // 2) List key is protected from destructive SET overwrite
      await expect(
        session.updateCell({
          table: '(all)',
          primaryKeys: { key: 'mylist' },
          column: 'value',
          newValue: '["x"]',
        })
      ).rejects.toMatchObject({ code: 'not_supported' })
      expect(store.get('mylist')?.type).toBe('list')

      // 3) Hash update removes deleted field f2 via HDEL and preserves TTL
      await session.updateCell({
        table: '(all)',
        primaryKeys: { key: 'myhash' },
        column: 'value',
        newValue: JSON.stringify({ f1: 'v1-new', f3: 'v3' }),
      })
      expect(store.get('myhash')?.value).toEqual({ f1: 'v1-new', f3: 'v3' })
      expect(store.get('myhash')?.ttl).toBe(120)
      expect(executedCmds.some((c) => c[0] === 'HDEL' && c[1] === 'myhash' && c[2] === 'f2')).toBe(true)

      // 4) >500 keys sorted by TTL: page 13 (offset 600, pageSize 50) returns remaining 3 rows (total 603)
      //    and per-key WRONGTYPE on flaky:wrongtype degrades gracefully without throwing
      const page13 = await session.fetchPage({
        table: '(all)',
        page: 13,
        pageSize: 50,
        sortColumn: 'ttl',
        sortDirection: 'ASC',
      })
      expect(page13.totalRows).toBe(603)
      expect(page13.rows).toHaveLength(3)
      expect(page13.rows.map((r) => r.ttl)).toEqual([597, 598, 599])

      const flakyPage = await session.fetchPage({
        table: '(all)',
        page: 1,
        pageSize: 10,
        whereClause: 'flaky:wrongtype',
      })
      expect(flakyPage.rows).toHaveLength(1)
      expect(flakyPage.rows[0].key).toBe('flaky:wrongtype')
      expect(flakyPage.rows[0].value).toBeNull()

      // 5) Non-finite page / pageSize values clamp safely to defaults instead of producing NaN/Infinity offset
      const infPage = await session.fetchPage({
        table: '(all)',
        page: Number.POSITIVE_INFINITY,
        pageSize: Number.NaN,
      })
      expect(infPage.page).toBe(1)
      expect(infPage.pageSize).toBe(50)
      expect(infPage.rows).toHaveLength(50)

      // 6) Explicit ssl: false overrides rediss:// URL scheme
      const plainOverRediss = new RedisSession({
        id: 'redis-explicit-no-ssl',
        name: 'Redis Plain',
        driver: 'redis',
        database: '0',
        url: `rediss://127.0.0.1:${port}/0`,
        ssl: false,
      })
      try {
        const plainTest = await plainOverRediss.test()
        expect(plainTest.ok).toBe(true)
      } finally {
        await plainOverRediss.close()
      }
    } finally {
      await session.close()
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('Wave 12 — Track C: ClickHouse Custom FORMAT, Parenthesized SELECT, Multi-Stmt KILL & PK Order', () => {
  it('supports non-JSONCompact FORMAT, parenthesized SELECT, multi-statement sub-query KILL, array optimistic-lock skip, conflict check, and PK tuple order', async () => {
    const seenRequests: Array<{ queryId: string | null; sql: string }> = []

    const server = http.createServer((req, res) => {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1')
      const queryId = parsed.searchParams.get('query_id')
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const sql = Buffer.concat(chunks).toString('utf8').trim()
        seenRequests.push({ queryId, sql })

        if (sql.includes('SLEEP_SLOW_CH')) {
          return // hang until cancelled
        }

        if (sql.includes('FROM system.columns')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              meta: [
                { name: 'name', type: 'String' },
                { name: 'type', type: 'String' },
                { name: 'is_in_primary_key', type: 'UInt8' },
                { name: 'is_in_sorting_key', type: 'UInt8' },
                { name: 'default_kind', type: 'String' },
                { name: 'default_expression', type: 'String' },
              ],
              data: [
                ['id', 'UInt64', 1, 1, '', ''],
                ['tenant_id', 'String', 1, 1, '', ''],
                ['tags', 'Array(String)', 0, 0, '', ''],
              ],
            })
          )
          return
        }

        if (sql.includes('FROM system.tables')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              meta: [
                { name: 'engine', type: 'String' },
                { name: 'primary_key', type: 'String' },
                { name: 'sorting_key', type: 'String' },
              ],
              data: [['MergeTree', 'tenant_id, id', 'tenant_id, id']],
            })
          )
          return
        }

        if (/FORMAT\s+TabSeparated/i.test(sql)) {
          res.writeHead(200, { 'Content-Type': 'text/tab-separated-values' })
          res.end('1\talpha\n2\tbeta\n')
          return
        }

        if (sql.startsWith('(SELECT 1)')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              meta: [{ name: 'n', type: 'UInt8' }],
              data: [[1], [2]],
            })
          )
          return
        }

        if (/^SELECT COUNT\(\*\) AS total/i.test(sql)) {
          const isMissing = sql.includes('= 999')
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              meta: [{ name: 'total', type: 'UInt64' }],
              data: [[isMissing ? 0 : 1]],
            })
          )
          return
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ meta: [{ name: 'ok', type: 'UInt8' }], data: [[1]] }))
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as net.AddressInfo).port
    const session = new ClickHouseSession({
      id: 'ch-w12',
      name: 'CH W12',
      driver: 'clickhouse',
      host: '127.0.0.1',
      port,
      database: 'analytics',
    })

    try {
      // 1) Custom non-JSONCompact FORMAT returns raw text lines cleanly
      const tsvRes = await session.runQuery('q-ch-tsv', 'SELECT id, name FROM t FORMAT TabSeparated')
      expect(tsvRes.isSelect).toBe(true)
      expect(tsvRes.columns).toEqual([{ name: 'result (TabSeparated)', type: 'String' }])
      expect(tsvRes.rows).toEqual([['1\talpha'], ['2\tbeta']])

      // 2) Parenthesized SELECT recognized as row-returning
      const parenRes = await session.runQuery('q-ch-paren', '(SELECT 1) UNION ALL (SELECT 2)')
      expect(parenRes.isSelect).toBe(true)
      expect(parenRes.rowCount).toBe(2)

      // 3) Multi-statement cancel kills the active sub-query ID ('chq_2')
      const slowMulti = session.runQuery('chq', 'SELECT 1; SELECT SLEEP_SLOW_CH()')
      slowMulti.catch(() => {})
      await new Promise((r) => setTimeout(r, 35))
      await session.cancelQuery('chq')
      await expect(slowMulti).rejects.toMatchObject({ code: 'cancelled' })
      expect(
        seenRequests.some((r) => r.sql.includes("KILL QUERY WHERE query_id = 'chq_2' SYNC"))
      ).toBe(true)

      // 4) updateCell skips array optimistic lock value and throws conflict when row doesn't exist
      await expect(
        session.updateCell({
          table: 'events',
          primaryKeys: { id: 999 },
          column: 'tags',
          newValue: '["x"]',
          originalValue: ['a', 'b'],
        })
      ).rejects.toMatchObject({ code: 'conflict' })

      const countCheck = seenRequests.find(
        (r) => r.sql.startsWith('SELECT COUNT(*) AS total') && r.sql.includes('999')
      )
      expect(countCheck).toBeDefined()
      expect(countCheck?.sql).not.toContain('tags')

      // 5) getTableDetails preserves system.tables.primary_key tuple order (tenant_id before id)
      const details = await session.getTableDetails('events')
      expect(details.primaryKey).toEqual(['tenant_id', 'id'])
    } finally {
      await session.close()
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})







