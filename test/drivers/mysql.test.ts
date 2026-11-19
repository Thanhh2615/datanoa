import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  introspectMysqlObjects,
  introspectMysqlTableDetails,
  MYSQL_SCHEMA_QUERIES,
} from '../../src/drivers/common/schema'
import {
  quoteIdentifier,
  makePlaceholder,
  buildUpdateSql,
  buildSelectPageSql,
  buildFetchPageQueries,
  assembleTableBrowseResult,
} from '../../src/drivers/common/update-builder'
import {
  MysqlDriver,
  MysqlSession,
  type MysqlConnectionLike,
  type MysqlPoolLike,
} from '../../src/drivers/mysql/driver'
import { DatabaseDriverError } from '../../src/drivers/common/driver'

describe('MySQL Dialect & Quoting', () => {
  it('quotes identifiers with backticks and escapes embedded backticks', () => {
    expect(quoteIdentifier('mysql', 'users')).toBe('`users`')
    expect(quoteIdentifier('mysql', 'users', 'shop_db')).toBe('`shop_db`.`users`')
    expect(quoteIdentifier('mysql', 'special`col')).toBe('`special``col`')
    expect(quoteIdentifier('mysql', 'order`item', 'app`schema')).toBe('`app``schema`.`order``item`')
  })

  it('generates ? positional placeholders', () => {
    expect(makePlaceholder('mysql', 1)).toBe('?')
    expect(makePlaceholder('mysql', 10)).toBe('?')
  })
})

describe('MySQL Safe Parameterized UPDATE Builder', () => {
  it('generates parameterized UPDATE with primary key condition', () => {
    const { sql, params } = buildUpdateSql({
      driver: 'mysql',
      table: 'products',
      schema: 'store',
      column: 'price',
      newValue: 99.95,
      primaryKeys: { sku: 'PROD-001' },
    })

    expect(sql).toBe('UPDATE `store`.`products` SET `price` = ? WHERE `sku` = ?')
    expect(params).toEqual([99.95, 'PROD-001'])
  })

  it('includes optimistic concurrency locking when originalValue is provided', () => {
    const { sql, params } = buildUpdateSql({
      driver: 'mysql',
      table: 'products',
      column: 'status',
      newValue: 'in_stock',
      primaryKeys: { sku: 'PROD-001' },
      originalValue: 'backorder',
    })

    expect(sql).toBe('UPDATE `products` SET `status` = ? WHERE `sku` = ? AND `status` = ?')
    expect(params).toEqual(['in_stock', 'PROD-001', 'backorder'])
  })

  it('handles null originalValue with IS NULL optimistic check', () => {
    const { sql, params } = buildUpdateSql({
      driver: 'mysql',
      table: 'products',
      column: 'discontinued_at',
      newValue: '2026-11-16',
      primaryKeys: { sku: 'PROD-001' },
      originalValue: null,
    })

    expect(sql).toBe('UPDATE `products` SET `discontinued_at` = ? WHERE `sku` = ? AND `discontinued_at` IS NULL')
    expect(params).toEqual(['2026-11-16', 'PROD-001'])
  })

  it('rejects UPDATE without primary keys as a safety guard', () => {
    expect(() =>
      buildUpdateSql({
        driver: 'mysql',
        table: 'products',
        column: 'price',
        newValue: 0,
        primaryKeys: {},
      })
    ).toThrow('Cannot generate UPDATE statement without primary key conditions (safety guard)')
  })
})

describe('MySQL Pagination Builder', () => {
  it('builds fetchPage queries using ? placeholders for MySQL', () => {
    const queries = buildFetchPageQueries({
      driver: 'mysql',
      table: 'products',
      schema: 'store',
      page: 2,
      pageSize: 20,
      sortColumn: 'price',
      sortDirection: 'ASC',
      primaryKey: ['sku'],
    })

    expect(queries.countSql).toBe('SELECT COUNT(*) AS total FROM `store`.`products`;')
    expect(queries.dataSql).toBe('SELECT * FROM `store`.`products` ORDER BY `price` ASC LIMIT ? OFFSET ?;')
    expect(queries.params).toEqual([20, 20])
  })

  it('falls back to primary key sorting when sortColumn is not provided', () => {
    const queries = buildSelectPageSql({
      driver: 'mysql',
      table: 'order_lines',
      page: 1,
      pageSize: 50,
      primaryKey: ['order_id', 'line_no'],
    })

    expect(queries.sql).toBe('SELECT * FROM `order_lines` ORDER BY `order_id`, `line_no` ASC LIMIT ? OFFSET ?;')
  })

  it('assembles TableBrowseResult with canEdit correctly', () => {
    const tableDetails = {
      name: 'products',
      schema: 'store',
      kind: 'table' as const,
      columns: [],
      primaryKey: ['sku'],
      indexes: [],
      foreignKeys: [],
    }

    const result = assembleTableBrowseResult({
      tableDetails,
      rows: [{ sku: 'PROD-1' }],
      countRow: { total: 42 },
      page: 1,
      pageSize: 20,
    })

    expect(result.totalRows).toBe(42)
    expect(result.canEdit).toBe(true)
  })
})

describe('MySQL Schema Introspection Functions', () => {
  it('introspects objects in database', async () => {
    const mockQuery = vi.fn().mockResolvedValue([
      { name: 'orders', schema: 'shop', kind: 'table' },
      { name: 'v_open_orders', schema: 'shop', kind: 'view' },
    ])

    const objects = await introspectMysqlObjects(mockQuery, 'shop')
    expect(objects).toEqual([
      { name: 'orders', schema: 'shop', kind: 'table' },
      { name: 'v_open_orders', schema: 'shop', kind: 'view' },
    ])
  })

  it('introspects tableDetails including PK, autoincrement, FK, and indexes', async () => {
    const mockQuery = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("WHEN table_type = 'VIEW'")) {
        return [{ kind: 'table' }]
      }
      if (sql.includes('FROM information_schema.columns')) {
        return [
          {
            name: 'order_id',
            type: 'int',
            native_type: 'int',
            nullable: false,
            default_value: null,
            is_primary_key: true,
            is_auto_increment: true,
          },
          {
            name: 'status',
            type: 'varchar(20)',
            native_type: 'varchar',
            nullable: false,
            default_value: 'pending',
            is_primary_key: false,
            is_auto_increment: false,
          },
        ]
      }
      if (sql.includes("constraint_name = 'PRIMARY'")) {
        return [{ column_name: 'order_id' }]
      }
      if (sql.includes('referenced_table_name IS NOT NULL')) {
        return [
          {
            constraint_name: 'fk_orders_user',
            column: 'user_id',
            referenced_table: 'users',
            referenced_column: 'id',
          },
        ]
      }
      if (sql.includes('FROM information_schema.statistics')) {
        return [
          {
            name: 'PRIMARY',
            is_unique: true,
            is_primary: true,
            column_name: 'order_id',
            seq_in_index: 1,
          },
        ]
      }
      return []
    })

    const details = await introspectMysqlTableDetails(mockQuery, 'orders', 'shop')

    expect(details.name).toBe('orders')
    expect(details.schema).toBe('shop')
    expect(details.kind).toBe('table')
    expect(details.primaryKey).toEqual(['order_id'])
    expect(details.columns.length).toBe(2)
    expect(details.columns[0].isPrimaryKey).toBe(true)
    expect(details.columns[0].isAutoIncrement).toBe(true)
    expect(details.foreignKeys.length).toBe(1)
    expect(details.foreignKeys[0].referencedTable).toBe('users')
    expect(details.indexes.length).toBe(1)
    expect(details.indexes[0].isPrimary).toBe(true)
  })
})

describe('MysqlSession Query Execution & Cancellation (Mock Pool)', () => {
  it('executes runQuery and transforms rows to unknown[][]', async () => {
    const mockConn = {
      threadId: 9876,
      query: vi.fn().mockResolvedValue([
        [
          { id: 1, title: 'Item 1' },
          { id: 2, title: 'Item 2' },
        ],
        [{ name: 'id', columnType: 3 }, { name: 'title', columnType: 253 }],
      ]),
      release: vi.fn(),
    }

    const mockPool = {
      getConnection: vi.fn().mockResolvedValue(mockConn),
      query: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    }

    const session = new MysqlSession(mockPool as any, {
      id: 'mysql-1',
      name: 'MySQL DB',
      driver: 'mysql',
      database: 'mydb',
    })

    const result = await session.runQuery('q_mysql', 'SELECT * FROM items;')

    expect(result.isSelect).toBe(true)
    expect(result.columns.map((c) => c.name)).toEqual(['id', 'title'])
    expect(result.rows).toEqual([
      [1, 'Item 1'],
      [2, 'Item 2'],
    ])
    expect(result.rowCount).toBe(2)
    expect(mockConn.release).toHaveBeenCalledTimes(1)
  })

  it('cancels active query via KILL QUERY', async () => {
    let releaseConn!: () => void
    const connPromise = new Promise<void>((resolve) => {
      releaseConn = resolve
    })

    const mockConn = {
      threadId: 54321,
      query: vi.fn().mockImplementation(() => connPromise),
      release: vi.fn(),
    }

    const mockPool = {
      getConnection: vi.fn().mockResolvedValue(mockConn),
      query: vi.fn().mockResolvedValue([{ affectedRows: 0 }]),
      end: vi.fn(),
    }

    const session = new MysqlSession(mockPool as any, {
      id: 'mysql-1',
      name: 'MySQL DB',
      driver: 'mysql',
      database: 'mydb',
    })

    // Start long-running query
    const runPromise = session.runQuery('cancel_my1', 'SELECT SLEEP(10);')

    // Wait a tick for registration
    await new Promise((r) => setTimeout(r, 10))

    // Issue cancel
    const cancelRes = await session.cancelQuery('cancel_my1')
    expect(cancelRes.ok).toBe(true)
    expect(mockPool.query).toHaveBeenCalledWith('KILL QUERY 54321;')

    // Cleanup promise
    releaseConn()
    await runPromise.catch(() => {})
  })
})

describe('MysqlSession Closed State Guards', () => {
  let session: MysqlSession

  beforeEach(async () => {
    const mockPool = {
      getConnection: vi.fn(),
      query: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    }

    session = new MysqlSession(mockPool as any, {
      id: 'mysql-closed',
      name: 'MySQL Closed',
      driver: 'mysql',
      database: 'mydb',
    })
    await session.close()
  })

  it('rejects runQuery immediately on closed session with SESSION_CLOSED', async () => {
    await expect(session.runQuery('q-closed', 'SELECT 1;')).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DatabaseDriverError &&
        err.code === 'SESSION_CLOSED' &&
        err.driver === 'mysql'
      )
    })
  })

  it('rejects fetchPage on closed session with SESSION_CLOSED', async () => {
    await expect(
      session.fetchPage({ table: 'items', page: 1, pageSize: 10 })
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DatabaseDriverError &&
        err.code === 'SESSION_CLOSED' &&
        err.driver === 'mysql'
      )
    })
  })

  it('rejects updateCell on closed session with SESSION_CLOSED', async () => {
    await expect(
      session.updateCell({
        table: 'items',
        primaryKeys: { sku: 'SKU1' },
        column: 'price',
        newValue: 50,
      })
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DatabaseDriverError &&
        err.code === 'SESSION_CLOSED' &&
        err.driver === 'mysql'
      )
    })
  })

  it('rejects getTableDetails on closed session with SESSION_CLOSED', async () => {
    await expect(session.getTableDetails('items')).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DatabaseDriverError &&
        err.code === 'SESSION_CLOSED' &&
        err.driver === 'mysql'
      )
    })
  })

  it('rejects listObjects on closed session with SESSION_CLOSED', async () => {
    await expect(session.listObjects()).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DatabaseDriverError &&
        err.code === 'SESSION_CLOSED' &&
        err.driver === 'mysql'
      )
    })
  })

  it('rejects cancelQuery on closed session with SESSION_CLOSED', async () => {
    await expect(session.cancelQuery('q-any')).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DatabaseDriverError &&
        err.code === 'SESSION_CLOSED' &&
        err.driver === 'mysql'
      )
    })
  })

  it('returns ok: false from test() on closed session', async () => {
    const res = await session.test()
    expect(res.ok).toBe(false)
  })
})

describe('Wave 12 — MySQL / MariaDB Stability, Array Mode, SSL Override, Destroy-on-Error & Empty DB Schemas', () => {
  it('respects explicit ssl: false on cloud hostnames and preserves COLUMN_TYPE / backslash escaping', async () => {
    const driver = new MysqlDriver('mysql')
    const session = (await driver.createSession({
      id: 'mysql-railway-nossl',
      name: 'Railway MySQL Non-TLS',
      driver: 'mysql',
      host: 'viaduct.proxy.rlwy.net',
      port: 3306,
      database: 'railway',
      ssl: false,
    })) as MysqlSession

    const poolConfig = (
      session as unknown as {
        cancelConnOptions?: { ssl?: unknown }
      }
    ).cancelConnOptions
    expect(poolConfig?.ssl).toBeUndefined()
    expect(session.isAlive()).toBe(true)
    await session.close()
    expect(session.isAlive()).toBe(false)

    // Backslashes escaped in MYSQL_SCHEMA_QUERIES
    const q = MYSQL_SCHEMA_QUERIES.listObjects("shop\\'; DROP TABLE x; --")
    expect(q).toContain("shop\\\\''; DROP TABLE x; --")

    // introspectMysqlTableDetails preserves COLUMN_TYPE (varchar(255) / enum) in nativeType
    const details = await introspectMysqlTableDetails(
      async (sql) => {
        if (sql.includes("WHEN table_type = 'VIEW'")) return [{ kind: 'table' }]
        if (sql.includes('FROM information_schema.columns')) {
          return [
            {
              name: 'status',
              type: "enum('active','disabled')",
              native_type: 'enum',
              nullable: '0',
              default_value: 'active',
              is_primary_key: '0',
              is_auto_increment: '0',
            },
          ]
        }
        return []
      },
      'accounts',
      'shop'
    )
    expect(details.columns[0].nativeType).toBe("enum('active','disabled')")
  })

  it('uses rowsAsArray: true for duplicate JOIN columns, destroys connections on error, validates threadId, and lists non-system schemas when database is empty', async () => {
    const mockConn = {
      threadId: 4242,
      query: vi.fn(
        async (arg: string | { sql: string; rowsAsArray?: boolean }): Promise<[unknown, unknown]> => {
          if (typeof arg === 'object' && arg.rowsAsArray && arg.sql.includes('JOIN')) {
            return [
              [[1, 999]],
              [
                { name: 'id', columnType: 3 },
                { name: 'id', columnType: 3 },
              ],
            ]
          }
          if (typeof arg === 'object' && arg.sql.includes('BOOM')) {
            throw new Error('Syntax error BOOM')
          }
          return [{ affectedRows: 0 }, undefined]
        }
      ),
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
      destroy: vi.fn(),
    } satisfies MysqlConnectionLike

    const capturedPoolSqls: string[] = []
    const getConnectionMock = vi.fn<() => Promise<MysqlConnectionLike>>().mockResolvedValue(mockConn)
    const mockPool = {
      getConnection: getConnectionMock,
      query: vi.fn(async (sql: string | { sql: string }): Promise<[unknown, unknown]> => {
        const sqlStr = typeof sql === 'string' ? sql : sql.sql
        capturedPoolSqls.push(sqlStr)
        if (sqlStr.includes("NOT IN ('information_schema'")) {
          return [[{ name: 'orders', schema: 'app_db', kind: 'table' }], undefined]
        }
        return [[], undefined]
      }),
      end: vi.fn().mockResolvedValue(undefined),
    } satisfies MysqlPoolLike

    const session = new MysqlSession(mockPool, {
      id: 'mysql-empty-db',
      name: 'MySQL No DB',
      driver: 'mysql',
      database: '',
    })

    // 1. Empty database lists all non-system schemas instead of WHERE table_schema = ''
    const objects = await session.listObjects()
    expect(objects).toEqual([{ name: 'orders', schema: 'app_db', kind: 'table' }])
    expect(capturedPoolSqls[0]).toContain("NOT IN ('information_schema'")

    // 2. Duplicate JOIN column names preserved via rowsAsArray: true
    const joinRes = await session.runQuery('q-join', 'SELECT u.id, p.id FROM u JOIN p ON u.id = p.uid;')
    expect(joinRes.columns.map((c) => c.name)).toEqual(['id', 'id'])
    expect(joinRes.rows).toEqual([[1, 999]])
    expect(mockConn.release).toHaveBeenCalledTimes(1)
    expect(mockConn.destroy).not.toHaveBeenCalled()

    // 3. Error in runQuery calls conn.destroy() instead of returning poisoned conn to pool
    await expect(session.runQuery('q-err', 'SELECT BOOM;')).rejects.toThrow('Syntax error BOOM')
    expect(mockConn.destroy).toHaveBeenCalledTimes(1)
    expect(mockConn.release).toHaveBeenCalledTimes(1)

    // 4. Error in applyChanges also destroys conn after rollback
    mockConn.query.mockRejectedValueOnce(new Error('Duplicate key'))
    await expect(
      session.applyChanges({ table: 'orders', schema: 'app_db', inserts: [{ id: 1 }] })
    ).rejects.toThrow('Duplicate key')
    expect(mockConn.rollback).toHaveBeenCalledTimes(1)
    expect(mockConn.destroy).toHaveBeenCalledTimes(2)

    // 5. Invalid non-integer threadId never interpolates into KILL QUERY
    const badConn: MysqlConnectionLike = {
      ...mockConn,
      threadId: Number.NaN,
      query: vi.fn(() => new Promise<[unknown, unknown]>(() => {})),
    }
    getConnectionMock.mockResolvedValueOnce(badConn)
    const hungPromise = session.runQuery('q-bad-tid', 'SELECT SLEEP(5);')
    hungPromise.catch(() => {})
    await new Promise((r) => setTimeout(r, 10))
    const cancelBad = await session.cancelQuery('q-bad-tid')
    expect(cancelBad.ok).toBe(false)
    expect(capturedPoolSqls.some((s) => s.includes('KILL QUERY'))).toBe(false)
    await session.close()
  })
})

