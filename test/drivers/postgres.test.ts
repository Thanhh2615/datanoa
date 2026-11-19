import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as net from 'node:net'
import {
  introspectPostgresObjects,
  introspectPostgresTableDetails,
} from '../../src/drivers/common/schema'
import {
  quoteIdentifier,
  makePlaceholder,
  buildUpdateSql,
  buildSelectPageSql,
  buildFetchPageQueries,
  assembleTableBrowseResult,
} from '../../src/drivers/common/update-builder'
import { PostgresDriver, PostgresSession } from '../../src/drivers/postgres/driver'
import { DatabaseDriverError } from '../../src/drivers/common/driver'

describe('PostgreSQL Dialect & Quoting', () => {
  it('quotes identifiers with double quotes and escapes embedded quotes', () => {
    expect(quoteIdentifier('postgres', 'users')).toBe('"users"')
    expect(quoteIdentifier('postgres', 'users', 'public')).toBe('"public"."users"')
    expect(quoteIdentifier('postgres', 'special "quote" table')).toBe('"special ""quote"" table"')
    expect(quoteIdentifier('postgres', 'item', 'inventory "dept"')).toBe('"inventory ""dept"""."item"')
  })

  it('generates $1, $2 positional placeholders', () => {
    expect(makePlaceholder('postgres', 1)).toBe('$1')
    expect(makePlaceholder('postgres', 42)).toBe('$42')
  })
})

describe('PostgreSQL Safe Parameterized UPDATE Builder', () => {
  it('generates parameterized UPDATE with primary key condition', () => {
    const { sql, params } = buildUpdateSql({
      driver: 'postgres',
      table: 'accounts',
      schema: 'public',
      column: 'balance',
      newValue: 5000.5,
      primaryKeys: { id: 101 },
    })

    expect(sql).toBe('UPDATE "public"."accounts" SET "balance" = $1 WHERE "id" = $2')
    expect(params).toEqual([5000.5, 101])
  })

  it('includes optimistic concurrency locking when originalValue is provided', () => {
    const { sql, params } = buildUpdateSql({
      driver: 'postgres',
      table: 'accounts',
      column: 'status',
      newValue: 'active',
      primaryKeys: { id: 101 },
      originalValue: 'pending',
    })

    expect(sql).toBe('UPDATE "accounts" SET "status" = $1 WHERE "id" = $2 AND "status" = $3')
    expect(params).toEqual(['active', 101, 'pending'])
  })

  it('handles null originalValue with IS NULL optimistic check', () => {
    const { sql, params } = buildUpdateSql({
      driver: 'postgres',
      table: 'accounts',
      column: 'closed_at',
      newValue: '2026-11-16',
      primaryKeys: { id: 101 },
      originalValue: null,
    })

    expect(sql).toBe('UPDATE "accounts" SET "closed_at" = $1 WHERE "id" = $2 AND "closed_at" IS NULL')
    expect(params).toEqual(['2026-11-16', 101])
  })

  it('rejects UPDATE without primary keys as a safety guard', () => {
    expect(() =>
      buildUpdateSql({
        driver: 'postgres',
        table: 'accounts',
        column: 'balance',
        newValue: 0,
        primaryKeys: {},
      })
    ).toThrow('Cannot generate UPDATE statement without primary key conditions (safety guard)')
  })
})

describe('PostgreSQL Pagination Builder', () => {
  it('builds fetchPage queries using $1, $2 placeholders and COUNT(*)', () => {
    const queries = buildFetchPageQueries({
      driver: 'postgres',
      table: 'orders',
      schema: 'public',
      page: 3,
      pageSize: 25,
      sortColumn: 'created_at',
      sortDirection: 'DESC',
      primaryKey: ['id'],
    })

    expect(queries.countSql).toBe('SELECT COUNT(*) AS total FROM "public"."orders";')
    expect(queries.dataSql).toBe('SELECT * FROM "public"."orders" ORDER BY "created_at" DESC LIMIT $1 OFFSET $2;')
    expect(queries.params).toEqual([25, 50])
  })

  it('falls back to primary key sorting when sortColumn is not provided', () => {
    const queries = buildSelectPageSql({
      driver: 'postgres',
      table: 'items',
      page: 1,
      pageSize: 50,
      primaryKey: ['category_id', 'item_id'],
    })

    expect(queries.sql).toBe('SELECT * FROM "items" ORDER BY "category_id", "item_id" ASC LIMIT $1 OFFSET $2;')
  })

  it('correctly coerces PostgreSQL string BigInt count results in assembleTableBrowseResult', () => {
    const tableDetails = {
      name: 'items',
      schema: 'public',
      kind: 'table' as const,
      columns: [],
      primaryKey: ['id'],
      indexes: [],
      foreignKeys: [],
    }

    const result = assembleTableBrowseResult({
      tableDetails,
      rows: [{ id: 1 }],
      countRow: { total: '142857' }, // pg returns string for bigint COUNT
      page: 1,
      pageSize: 50,
    })

    expect(result.totalRows).toBe(142857)
    expect(typeof result.totalRows).toBe('number')
    expect(result.canEdit).toBe(true)
  })
})

describe('PostgreSQL Schema Introspection Functions', () => {
  it('introspects objects in schema', async () => {
    const mockQuery = vi.fn().mockResolvedValue([
      { name: 'users', schema: 'public', kind: 'table' },
      { name: 'v_active_users', schema: 'public', kind: 'view' },
    ])

    const objects = await introspectPostgresObjects(mockQuery, 'public')
    expect(objects).toEqual([
      { name: 'users', schema: 'public', kind: 'table' },
      { name: 'v_active_users', schema: 'public', kind: 'view' },
    ])
  })

  it('introspects tableDetails including PK, autoincrement, FK, and indexes', async () => {
    const mockQuery = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("WHEN table_type = 'VIEW'")) {
        return [{ kind: 'table' }]
      }
      if (sql.includes("tc.constraint_type = 'PRIMARY KEY'")) {
        return [{ column_name: 'id' }]
      }
      if (sql.includes('FROM information_schema.columns')) {
        return [
          {
            name: 'id',
            type: 'integer',
            native_type: 'int4',
            nullable: false,
            default_value: "nextval('users_id_seq'::regclass)",
            is_auto_increment: true,
          },
          {
            name: 'email',
            type: 'character varying(255)',
            native_type: 'varchar',
            nullable: false,
            default_value: null,
            is_auto_increment: false,
          },
        ]
      }
      if (sql.includes("tc.constraint_type = 'FOREIGN KEY'")) {
        return [
          {
            constraint_name: 'fk_users_org',
            column_name: 'org_id',
            referenced_table: 'organizations',
            referenced_column: 'id',
          },
        ]
      }
      if (sql.includes('pg_catalog.pg_index')) {
        return [
          { index_name: 'users_pkey', is_unique: true, is_primary: true, column_name: 'id' },
          { index_name: 'users_email_key', is_unique: true, is_primary: false, column_name: 'email' },
        ]
      }
      return []
    })

    const details = await introspectPostgresTableDetails(mockQuery, 'users', 'public')

    expect(details.name).toBe('users')
    expect(details.schema).toBe('public')
    expect(details.kind).toBe('table')
    expect(details.primaryKey).toEqual(['id'])
    expect(details.columns.length).toBe(2)
    expect(details.columns[0].isPrimaryKey).toBe(true)
    expect(details.columns[0].isAutoIncrement).toBe(true)
    expect(details.columns[1].isPrimaryKey).toBe(false)
    expect(details.foreignKeys.length).toBe(1)
    expect(details.foreignKeys[0].referencedTable).toBe('organizations')
    expect(details.indexes.length).toBe(2)
    expect(details.indexes[0].isPrimary).toBe(true)
    expect(details.indexes[1].isUnique).toBe(true)
  })
})

describe('PostgresSession Query Execution & Cancellation (Mock Pool)', () => {
  it('executes runQuery and transforms rows to unknown[][]', async () => {
    const mockClient = {
      processID: 12345,
      query: vi.fn().mockResolvedValue({
        fields: [{ name: 'id', dataTypeID: 23 }, { name: 'name', dataTypeID: 25 }],
        rows: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        rowCount: 2,
      }),
      release: vi.fn(),
    }

    const mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
      query: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    }

    const session = new PostgresSession(mockPool as any, {
      id: 'pg-1',
      name: 'PG DB',
      driver: 'postgres',
      database: 'mydb',
    })

    const result = await session.runQuery('q1', 'SELECT * FROM test;')

    expect(result.isSelect).toBe(true)
    expect(result.columns).toEqual([
      { name: 'id', type: '23' },
      { name: 'name', type: '25' },
    ])
    expect(result.rows).toEqual([
      [1, 'Alice'],
      [2, 'Bob'],
    ])
    expect(result.rowCount).toBe(2)
    expect(mockClient.release).toHaveBeenCalledTimes(1)
  })

  it('cancels active query via pg_cancel_backend', async () => {
    let releaseClient!: () => void
    const clientPromise = new Promise<void>((resolve) => {
      releaseClient = resolve
    })

    const mockClient = {
      processID: 54321,
      query: vi.fn().mockImplementation(() => clientPromise),
      release: vi.fn(),
    }

    const mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
      query: vi.fn().mockResolvedValue({ rowCount: 1 }),
      end: vi.fn(),
    }

    const session = new PostgresSession(mockPool as any, {
      id: 'pg-1',
      name: 'PG DB',
      driver: 'postgres',
      database: 'mydb',
    })

    // Start long-running query
    const runPromise = session.runQuery('cancel_q1', 'SELECT pg_sleep(10);')

    // Wait a tick for registration
    await new Promise((r) => setTimeout(r, 10))

    // Issue cancel
    const cancelRes = await session.cancelQuery('cancel_q1')
    expect(cancelRes.ok).toBe(true)
    expect(mockPool.query).toHaveBeenCalledWith('SELECT pg_cancel_backend($1);', [54321])

    // Cleanup promise
    releaseClient()
    await runPromise.catch(() => {})
  })
})

describe('PostgresSession Closed State Guards', () => {
  let session: PostgresSession

  beforeEach(async () => {
    const mockPool = {
      connect: vi.fn(),
      query: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    }

    session = new PostgresSession(mockPool as any, {
      id: 'pg-closed',
      name: 'PG Closed',
      driver: 'postgres',
      database: 'mydb',
    })
    await session.close()
  })

  it('rejects runQuery immediately on closed session with SESSION_CLOSED', async () => {
    await expect(session.runQuery('q-closed', 'SELECT 1;')).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DatabaseDriverError &&
        err.code === 'SESSION_CLOSED' &&
        err.driver === 'postgres'
      )
    })
  })

  it('rejects fetchPage on closed session with SESSION_CLOSED', async () => {
    await expect(
      session.fetchPage({ table: 'orders', page: 1, pageSize: 10 })
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DatabaseDriverError &&
        err.code === 'SESSION_CLOSED' &&
        err.driver === 'postgres'
      )
    })
  })

  it('rejects updateCell on closed session with SESSION_CLOSED', async () => {
    await expect(
      session.updateCell({
        table: 'orders',
        primaryKeys: { id: 1 },
        column: 'status',
        newValue: 'closed',
      })
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DatabaseDriverError &&
        err.code === 'SESSION_CLOSED' &&
        err.driver === 'postgres'
      )
    })
  })

  it('rejects getTableDetails on closed session with SESSION_CLOSED', async () => {
    await expect(session.getTableDetails('orders')).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DatabaseDriverError &&
        err.code === 'SESSION_CLOSED' &&
        err.driver === 'postgres'
      )
    })
  })

  it('rejects listObjects on closed session with SESSION_CLOSED', async () => {
    await expect(session.listObjects()).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DatabaseDriverError &&
        err.code === 'SESSION_CLOSED' &&
        err.driver === 'postgres'
      )
    })
  })

  it('rejects cancelQuery on closed session with SESSION_CLOSED', async () => {
    await expect(session.cancelQuery('q-any')).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DatabaseDriverError &&
        err.code === 'SESSION_CLOSED' &&
        err.driver === 'postgres'
      )
    })
  })

  it('returns ok: false from test() on closed session', async () => {
    const res = await session.test()
    expect(res.ok).toBe(false)
  })

  it('translates raw SCRAM client password must be a string error into an actionable missing-password message', async () => {
    const mockPool: Pick<
      ConstructorParameters<typeof PostgresSession>[0],
      'connect' | 'query' | 'end'
    > = {
      connect: vi
        .fn()
        .mockRejectedValueOnce(
          new Error('SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string')
        )
        .mockRejectedValueOnce(
          new Error('SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a non-empty string')
        ),
      query: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    }

    const scramSession = new PostgresSession(
      mockPool as unknown as ConstructorParameters<typeof PostgresSession>[0],
      {
        id: 'pg-scram',
        name: 'Supabase Test',
        driver: 'postgres',
        host: 'db.toethftlamjmkkodtglq.supabase.co',
        port: 5432,
        user: 'postgres',
        database: 'postgres',
      }
    )

    const res1 = await scramSession.test()
    expect(res1.ok).toBe(false)
    expect(res1.message).toMatch(/Database Password/i)
    expect(res1.message).not.toContain('client password must be a string')

    const res2 = await scramSession.test()
    expect(res2.ok).toBe(false)
    expect(res2.message).toMatch(/Database Password/i)
    expect(res2.message).not.toContain('client password must be a non-empty string')
  })
})

function pgMsg(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(1 + 4 + body.length)
  out.write(type, 0, 1, 'ascii')
  out.writeInt32BE(4 + body.length, 1)
  body.copy(out, 5)
  return out
}

function pgAuthOkAndReady(pid: number): Buffer {
  const authOk = pgMsg('R', Buffer.from([0, 0, 0, 0]))
  const keyData = Buffer.alloc(8)
  keyData.writeInt32BE(pid, 0)
  keyData.writeInt32BE(9999, 4)
  const backendKey = pgMsg('K', keyData)
  const ready = pgMsg('Z', Buffer.from('I', 'ascii'))
  return Buffer.concat([authOk, backendKey, ready])
}

function pgRowDescription(cols: Array<{ name: string; oid: number }>): Buffer {
  const parts: Buffer[] = []
  const countBuf = Buffer.alloc(2)
  countBuf.writeInt16BE(cols.length, 0)
  parts.push(countBuf)
  for (const col of cols) {
    const nameBuf = Buffer.from(`${col.name}\0`, 'utf8')
    const meta = Buffer.alloc(18)
    meta.writeInt32BE(0, 0) // table oid
    meta.writeInt16BE(0, 4) // col attr
    meta.writeInt32BE(col.oid, 6) // type oid
    meta.writeInt16BE(-1, 10) // type size
    meta.writeInt32BE(-1, 12) // type mod
    meta.writeInt16BE(0, 16) // text format
    parts.push(nameBuf, meta)
  }
  return pgMsg('T', Buffer.concat(parts))
}

function pgDataRow(values: Array<string | null>): Buffer {
  const parts: Buffer[] = []
  const countBuf = Buffer.alloc(2)
  countBuf.writeInt16BE(values.length, 0)
  parts.push(countBuf)
  for (const val of values) {
    const lenBuf = Buffer.alloc(4)
    if (val === null) {
      lenBuf.writeInt32BE(-1, 0)
      parts.push(lenBuf)
    } else {
      const data = Buffer.from(val, 'utf8')
      lenBuf.writeInt32BE(data.length, 0)
      parts.push(lenBuf, data)
    }
  }
  return pgMsg('D', Buffer.concat(parts))
}

function pgCommandComplete(tag: string): Buffer {
  return pgMsg('C', Buffer.from(`${tag}\0`, 'utf8'))
}

function pgReady(status = 'I'): Buffer {
  return pgMsg('Z', Buffer.from(status, 'ascii'))
}

function pgFatalError(code: string, message: string): Buffer {
  const body = Buffer.from(`SFATAL\0C${code}\0M${message}\0\0`, 'utf8')
  return pgMsg('E', body)
}

describe('Wave 12 — PostgreSQL / CockroachDB Wire-Protocol Stability & Correctness', () => {
  it('respects explicit ssl: false on cloud hostnames, passes profile.options to PoolConfig, and detects CockroachDB unique_rowid()', async () => {
    const pgDriver = new PostgresDriver('postgres')
    const noSslCloud = (await pgDriver.createSession({
      id: 'pg-railway-nossl',
      name: 'Railway Non-TLS',
      driver: 'postgres',
      host: 'roundhouse.proxy.rlwy.net',
      port: 12345,
      database: 'railway',
      ssl: false,
      options: 'endpoint=ep-cool-123',
    })) as PostgresSession

    const opts = (noSslCloud as unknown as { pool: { options?: Record<string, unknown> } }).pool
      .options
    expect(opts?.ssl).toBeUndefined()
    expect(opts?.options).toBe('endpoint=ep-cool-123')
    expect(noSslCloud.isAlive()).toBe(true)
    await noSslCloud.close()
    expect(noSslCloud.isAlive()).toBe(false)

    // CockroachDB unique_rowid() detection
    const crdbQuery = vi.fn(async (sql: string) => {
      if (sql.includes("WHEN table_type = 'VIEW'")) return [{ kind: 'table' }]
      if (sql.includes("tc.constraint_type = 'PRIMARY KEY'")) return [{ column_name: 'id' }]
      if (sql.includes('FROM information_schema.columns')) {
        return [
          {
            name: 'id',
            type: 'bigint',
            native_type: 'int8',
            nullable: false,
            default_value: 'unique_rowid()',
            is_auto_increment: false,
          },
        ]
      }
      return []
    })
    const crdbDetails = await introspectPostgresTableDetails(crdbQuery, 'rides', 'public')
    expect(crdbDetails.columns[0].isAutoIncrement).toBe(true)
  })

  it('survives idle pool 57P01 + checked-out socket drops without uncaughtException, preserves duplicate JOIN columns via rowMode array, and cancels without pool deadlock', async () => {
    let nextPid = 1000
    const receivedCancelPids: number[] = []
    const heldSockets = new Map<number, net.Socket>()
    const allSockets = new Set<net.Socket>()
    let mode: 'normal' | 'idle-57p01' | 'drop-mid-query' | 'hold-slow' = 'normal'
    let sawExtendedCountParse = false

    const server = net.createServer((socket) => {
      allSockets.add(socket)
      socket.once('close', () => allSockets.delete(socket))
      const pid = ++nextPid
      let startupDone = false
      let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0)

      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        if (!startupDone) {
          if (buf.length < 4) return
          const len = buf.readInt32BE(0)
          if (buf.length < len) return
          buf = buf.subarray(len)
          startupDone = true
          socket.write(pgAuthOkAndReady(pid))
        }

        while (buf.length >= 5) {
          const msgType = String.fromCharCode(buf[0])
          const msgLen = buf.readInt32BE(1)
          if (buf.length < 1 + msgLen) break
          const payload = buf.subarray(5, 1 + msgLen)
          buf = buf.subarray(1 + msgLen)

          if (msgType === 'X') {
            socket.end()
            return
          }

          if (msgType === 'P') {
            // Extended Query Protocol Parse message: stmtName\0query\0...
            const nul1 = payload.indexOf(0)
            const nul2 = payload.indexOf(0, nul1 + 1)
            const sqlText = payload.subarray(nul1 + 1, nul2).toString('utf8')
            if (sqlText.includes('SELECT COUNT(*)')) {
              sawExtendedCountParse = true
            }
            if (sqlText.includes('pg_cancel_backend')) {
              // Wait for Bind+Execute below
              ;(socket as unknown as { __lastParseSql?: string }).__lastParseSql = sqlText
            } else {
              ;(socket as unknown as { __lastParseSql?: string }).__lastParseSql = sqlText
            }
            socket.write(pgMsg('1', Buffer.alloc(0))) // ParseComplete
          } else if (msgType === 'B') {
            const sqlText = (socket as unknown as { __lastParseSql?: string }).__lastParseSql || ''
            if (sqlText.includes('pg_cancel_backend')) {
              // Extract first text parameter from Bind payload
              const rawStr = payload.toString('utf8')
              const match = /(\d{4,})/.exec(rawStr)
              if (match) {
                const targetPid = Number(match[1])
                receivedCancelPids.push(targetPid)
                const victim = heldSockets.get(targetPid)
                if (victim) {
                  heldSockets.delete(targetPid)
                  victim.write(
                    Buffer.concat([
                      pgMsg('E', Buffer.from('SERROR\0C57014\0Mcanceling statement due to user request\0\0', 'utf8')),
                      pgReady(),
                    ])
                  )
                }
              }
            }
            socket.write(pgMsg('2', Buffer.alloc(0))) // BindComplete
          } else if (msgType === 'D') {
            socket.write(pgMsg('n', Buffer.alloc(0))) // NoData / handled at Execute
          } else if (msgType === 'E') {
            const sqlText = (socket as unknown as { __lastParseSql?: string }).__lastParseSql || ''
            if (sqlText.includes('SELECT COUNT(*)')) {
              socket.write(
                Buffer.concat([
                  pgRowDescription([{ name: 'total', oid: 20 }]),
                  pgDataRow(['1']),
                  pgCommandComplete('SELECT 1'),
                ])
              )
            } else if (sqlText.includes('pg_cancel_backend')) {
              socket.write(
                Buffer.concat([
                  pgRowDescription([{ name: 'pg_cancel_backend', oid: 16 }]),
                  pgDataRow(['t']),
                  pgCommandComplete('SELECT 1'),
                ])
              )
            } else if (sqlText.includes('information_schema') || sqlText.includes('pg_catalog')) {
              socket.write(
                Buffer.concat([
                  pgRowDescription([{ name: 'kind', oid: 25 }]),
                  pgDataRow(['table']),
                  pgCommandComplete('SELECT 1'),
                ])
              )
            } else {
              socket.write(
                Buffer.concat([
                  pgRowDescription([{ name: 'id', oid: 23 }]),
                  pgDataRow(['1']),
                  pgCommandComplete('SELECT 1'),
                ])
              )
            }
          } else if (msgType === 'S') {
            socket.write(pgReady())
          } else if (msgType === 'Q') {
            const sqlText = payload.subarray(0, payload.length - 1).toString('utf8')
            if (mode === 'drop-mid-query' && sqlText.includes('DROP_ME')) {
              socket.destroy()
              return
            }
            if (mode === 'hold-slow' && sqlText.includes('SLOW_QUERY')) {
              heldSockets.set(pid, socket)
              return
            }
            if (sqlText.includes('JOIN')) {
              // Duplicate column name 'id' from u.id = 1 and p.id = 999
              socket.write(
                Buffer.concat([
                  pgRowDescription([
                    { name: 'id', oid: 23 },
                    { name: 'id', oid: 23 },
                  ]),
                  pgDataRow(['1', '999']),
                  pgCommandComplete('SELECT 1'),
                  pgReady(),
                ])
              )
            } else {
              socket.write(
                Buffer.concat([
                  pgRowDescription([{ name: 'ok', oid: 23 }]),
                  pgDataRow(['1']),
                  pgCommandComplete('SELECT 1'),
                  pgReady(),
                ])
              )
              if (mode === 'idle-57p01') {
                setTimeout(() => {
                  if (!socket.destroyed) {
                    socket.write(pgFatalError('57P01', 'terminating connection due to administrator command'))
                    socket.end()
                  }
                }, 20)
              }
            }
          }
        }
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as net.AddressInfo).port

    let uncaughtCount = 0
    const onUncaught = (): void => {
      uncaughtCount++
    }
    process.on('uncaughtException', onUncaught)

    const driver = new PostgresDriver('postgres')
    const session = (await driver.createSession({
      id: 'pg-wire-test',
      name: 'PG Wire',
      driver: 'postgres',
      host: '127.0.0.1',
      port,
      user: 'postgres',
      database: 'testdb',
      ssl: false,
    })) as PostgresSession

    try {
      // 1. Duplicate JOIN column names preserved via rowMode: 'array'
      const joinRes = await session.runQuery('q-join', 'SELECT u.id, p.id FROM u JOIN p ON u.id = p.uid;')
      expect(joinRes.columns.map((c) => c.name)).toEqual(['id', 'id'])
      expect(joinRes.rows).toEqual([[1, 999]])

      // 2. Idle pool 57P01 + FIN must NOT crash Node via uncaughtException
      mode = 'idle-57p01'
      const tRes = await session.test()
      expect(tRes.ok).toBe(true)
      await new Promise((r) => setTimeout(r, 60))
      expect(uncaughtCount).toBe(0)

      // 3. Sudden socket drop on checked-out PoolClient must NOT emit uncaughtException
      mode = 'drop-mid-query'
      await expect(session.runQuery('q-drop', 'SELECT DROP_ME;')).rejects.toThrow()
      await new Promise((r) => setTimeout(r, 40))
      expect(uncaughtCount).toBe(0)

      // 4. fetchPage uses Extended Query Protocol for countSql
      mode = 'normal'
      await session.fetchPage({ table: 'users', page: 1, pageSize: 10 })
      expect(sawExtendedCountParse).toBe(true)

      // 5. Saturated pool (5/5 connections busy) -> cancelQuery uses dedicated Client without deadlocking!
      mode = 'hold-slow'
      const slowQueries = [1, 2, 3, 4, 5].map((n) => {
        const p = session.runQuery(`slow-${n}`, `SELECT SLOW_QUERY_${n};`)
        p.catch(() => {})
        return p
      })
      await new Promise((r) => setTimeout(r, 60))

      const cancelRes = await session.cancelQuery('slow-1')
      expect(cancelRes.ok).toBe(true)
      expect(receivedCancelPids.length).toBeGreaterThanOrEqual(1)
      await expect(slowQueries[0]).rejects.toThrow(/canceling statement/i)

      // 6. close() with remaining active queries must resolve promptly (no hang!)
      const closeStart = Date.now()
      await session.close()
      expect(Date.now() - closeStart).toBeLessThan(2000)
      await Promise.allSettled(slowQueries)
      expect(uncaughtCount).toBe(0)
    } finally {
      process.off('uncaughtException', onUncaught)
      await session.close().catch(() => {})
      for (const s of allSockets) {
        s.destroy()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

