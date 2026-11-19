import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  introspectSqliteObjects,
  introspectSqliteTableDetails,
} from '../../src/drivers/common/schema'
import {
  buildFetchPageQueries,
  assembleTableBrowseResult,
} from '../../src/drivers/common/update-builder'
import {
  SqliteDriver,
  SqliteSession,
} from '../../src/drivers/sqlite/driver'
import { DatabaseDriverError } from '../../src/drivers/common/driver'

describe('SQLite Schema Introspection & Query Builder (Direct DatabaseSync)', () => {
  let db: DatabaseSync

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        email TEXT,
        bio TEXT DEFAULT 'New user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE tags (
        post_id INTEGER NOT NULL,
        tag_name TEXT NOT NULL,
        PRIMARY KEY (post_id, tag_name),
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
      );

      CREATE VIEW v_user_posts AS
      SELECT u.username, p.title FROM users u JOIN posts p ON u.id = p.user_id;

      CREATE INDEX idx_posts_user ON posts(user_id);
      CREATE UNIQUE INDEX idx_users_email ON users(email);
    `)
  })

  afterEach(() => {
    db.close()
  })

  const queryExecutor = async (sql: string, params: unknown[] = []) => {
    const stmt = db.prepare(sql)
    return stmt.all(...(params as any[])) as Record<string, unknown>[]
  }

  it('lists tables and views excluding internal sqlite_* tables', async () => {
    const objects = await introspectSqliteObjects(queryExecutor, 'main')
    const names = objects.map((o) => o.name)

    expect(names).toContain('users')
    expect(names).toContain('posts')
    expect(names).toContain('tags')
    expect(names).toContain('v_user_posts')
    expect(names.some((n) => n.startsWith('sqlite_'))).toBe(false)

    const viewObj = objects.find((o) => o.name === 'v_user_posts')
    expect(viewObj?.kind).toBe('view')

    const tableObj = objects.find((o) => o.name === 'users')
    expect(tableObj?.kind).toBe('table')
  })

  it('introspects tableDetails for single PK and autoincrement table', async () => {
    const details = await introspectSqliteTableDetails(queryExecutor, 'users', 'main')
    expect(details.name).toBe('users')
    expect(details.kind).toBe('table')
    expect(details.primaryKey).toEqual(['id'])

    const idCol = details.columns.find((c) => c.name === 'id')
    expect(idCol?.isPrimaryKey).toBe(true)
    expect(idCol?.isAutoIncrement).toBe(true)
    expect(idCol?.nullable).toBe(false)

    const bioCol = details.columns.find((c) => c.name === 'bio')
    expect(bioCol?.defaultValue).toBe("'New user'")
    expect(bioCol?.nullable).toBe(true)

    expect(details.indexes.some((i) => i.name === 'idx_users_email' && i.isUnique)).toBe(true)
  })

  it('introspects composite primary keys and foreign keys', async () => {
    const details = await introspectSqliteTableDetails(queryExecutor, 'tags', 'main')
    expect(details.primaryKey).toEqual(['post_id', 'tag_name'])
    expect(details.foreignKeys.length).toBe(1)
    expect(details.foreignKeys[0].column).toBe('post_id')
    expect(details.foreignKeys[0].referencedTable).toBe('posts')
    expect(details.foreignKeys[0].referencedColumn).toBe('id')
  })

  it('executes data.fetchPage with deterministic paging and sorting', async () => {
    for (let i = 1; i <= 10; i++) {
      db.prepare(`INSERT INTO users (username, email) VALUES (?, ?);`).run(`user_${i}`, `user${i}@example.com`)
    }

    const details = await introspectSqliteTableDetails(queryExecutor, 'users')
    const { countSql, dataSql, params } = buildFetchPageQueries({
      driver: 'sqlite',
      table: 'users',
      page: 2,
      pageSize: 3,
      sortColumn: 'id',
      sortDirection: 'ASC',
      primaryKey: details.primaryKey,
    })

    const countRows = await queryExecutor(countSql)
    const dataRows = await queryExecutor(dataSql, params)

    const browseResult = assembleTableBrowseResult({
      tableDetails: details,
      rows: dataRows,
      countRow: countRows[0],
      page: 2,
      pageSize: 3,
    })

    expect(browseResult.totalRows).toBe(10)
    expect(browseResult.page).toBe(2)
    expect(browseResult.pageSize).toBe(3)
    expect(browseResult.rows.length).toBe(3)
    expect(browseResult.rows[0].username).toBe('user_4')
    expect(browseResult.canEdit).toBe(true)
  })

  it('marks views as non-editable (canEdit = false)', async () => {
    const details = await introspectSqliteTableDetails(queryExecutor, 'v_user_posts')
    const { countSql, dataSql, params } = buildFetchPageQueries({
      driver: 'sqlite',
      table: 'v_user_posts',
      page: 1,
      pageSize: 10,
    })
    const countRows = await queryExecutor(countSql)
    const dataRows = await queryExecutor(dataSql, params)

    const browseResult = assembleTableBrowseResult({
      tableDetails: details,
      rows: dataRows,
      countRow: countRows[0],
      page: 1,
      pageSize: 10,
    })

    expect(browseResult.canEdit).toBe(false)
  })
})

describe('SqliteDriver & SqliteSession (worker_threads Runner)', () => {
  let driver: SqliteDriver
  let session: SqliteSession | null = null
  let tmpDir: string | null = null
  let testDbPath: string | null = null

  beforeEach(async () => {
    driver = new SqliteDriver()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa_sqlite_test_'))
    testDbPath = path.join(tmpDir, 'test.db')

    // Initialize schema in the disk file
    const setupDb = new DatabaseSync(testDbPath)
    setupDb.exec(`
      CREATE TABLE products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        in_stock INTEGER DEFAULT 1
      );

      CREATE TABLE order_items (
        order_id INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        PRIMARY KEY (order_id, item_id)
      );

      CREATE VIEW v_in_stock AS
      SELECT * FROM products WHERE in_stock = 1;

      INSERT INTO products (name, price, in_stock) VALUES
        ('Widget A', 19.99, 1),
        ('Widget B', 29.99, 1),
        ('Widget C', 39.99, 0);

      INSERT INTO order_items (order_id, item_id, quantity) VALUES
        (100, 1, 2),
        (100, 2, 5);
    `)
    setupDb.close()

    session = (await driver.createSession({
      id: 'test-sqlite',
      name: 'Test SQLite',
      driver: 'sqlite',
      database: 'test.db',
      filePath: testDbPath,
    })) as SqliteSession
  })

  afterEach(async () => {
    if (session) {
      await session.close().catch(() => {})
      session = null
    }

    if (tmpDir && fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch {}
      tmpDir = null
    }
  })

  it('verifies connection using test() and testConnection()', async () => {
    const testRes = await session!.test()
    expect(testRes.ok).toBe(true)

    const driverTestRes = await driver.testConnection({
      id: 'test-2',
      name: 'Test 2',
      driver: 'sqlite',
      database: 'test.db',
      filePath: testDbPath!,
    })
    expect(driverTestRes.ok).toBe(true)
  })

  it('lists objects including tables and views', async () => {
    const objects = await session!.listObjects()
    const names = objects.map((o) => o.name)
    expect(names).toContain('products')
    expect(names).toContain('order_items')
    expect(names).toContain('v_in_stock')

    const view = objects.find((o) => o.name === 'v_in_stock')
    expect(view?.kind).toBe('view')
  })

  it('inspects table details accurately', async () => {
    const details = await session!.getTableDetails('products')
    expect(details.name).toBe('products')
    expect(details.kind).toBe('table')
    expect(details.primaryKey).toEqual(['id'])
    expect(details.columns.length).toBe(4)

    const idCol = details.columns.find((c) => c.name === 'id')
    expect(idCol?.isPrimaryKey).toBe(true)
    expect(idCol?.isAutoIncrement).toBe(true)
  })

  it('fetches paginated rows with sorting', async () => {
    const page = await session!.fetchPage({
      table: 'products',
      page: 1,
      pageSize: 2,
      sortColumn: 'price',
      sortDirection: 'ASC',
    })

    expect(page.totalRows).toBe(3)
    expect(page.page).toBe(1)
    expect(page.pageSize).toBe(2)
    expect(page.rows.length).toBe(2)
    expect(page.rows[0].name).toBe('Widget A')
    expect(page.rows[1].name).toBe('Widget B')
    expect(page.canEdit).toBe(true)
  })

  it('performs inline cell updates with optimistic concurrency locking', async () => {
    // 1. Successful update
    const updateRes = await session!.updateCell({
      table: 'products',
      primaryKeys: { id: 1 },
      column: 'price',
      newValue: 24.99,
      originalValue: 19.99,
    })

    expect(updateRes.ok).toBe(true)
    expect(updateRes.affectedRows).toBe(1)
    expect(updateRes.updatedRecord?.price).toBe(24.99)

    // 2. Optimistic concurrency conflict when originalValue is stale
    await expect(
      session!.updateCell({
        table: 'products',
        primaryKeys: { id: 1 },
        column: 'price',
        newValue: 30.0,
        originalValue: 19.99, // Stale! Current price is 24.99
      })
    ).rejects.toThrow(DatabaseDriverError)
  })

  it('updates composite primary key table cells', async () => {
    const updateRes = await session!.updateCell({
      table: 'order_items',
      primaryKeys: { order_id: 100, item_id: 1 },
      column: 'quantity',
      newValue: 10,
      originalValue: 2,
    })

    expect(updateRes.ok).toBe(true)
    expect(updateRes.affectedRows).toBe(1)
    expect(updateRes.updatedRecord?.quantity).toBe(10)
  })

  it('runs arbitrary queries (SELECT and DML)', async () => {
    // SELECT query
    const selectRes = await session!.runQuery(
      'q1',
      'SELECT id, name, price FROM products ORDER BY id ASC;',
      10
    )

    expect(selectRes.isSelect).toBe(true)
    expect(selectRes.columns.map((c) => c.name)).toEqual(['id', 'name', 'price'])
    expect(selectRes.rowCount).toBe(3)
    expect(selectRes.rows.length).toBe(3)
    expect(selectRes.rows[0][1]).toBe('Widget A')
    expect(selectRes.truncated).toBe(false)
    expect(selectRes.executionTimeMs).toBeGreaterThanOrEqual(0)

    // Non-SELECT query (UPDATE)
    const dmlRes = await session!.runQuery(
      'q2',
      "UPDATE products SET in_stock = 0 WHERE name = 'Widget A';"
    )
    expect(dmlRes.isSelect).toBe(false)
    expect(dmlRes.affectedRows).toBe(1)
    expect(dmlRes.rowCount).toBe(0)
  })

  it('truncates queries exceeding maxRows', async () => {
    const res = await session!.runQuery('q_trunc', 'SELECT * FROM products;', 1)
    expect(res.isSelect).toBe(true)
    expect(res.rowCount).toBe(1)
    expect(res.rows.length).toBe(1)
    expect(res.truncated).toBe(true)
  })

  it('supports query cancellation and keeps session functional', async () => {
    // Enable test sleep_ms UDF strictly for this cancellation test session
    const prevEnv = process.env.DATANOA_ENABLE_TEST_UDF
    process.env.DATANOA_ENABLE_TEST_UDF = '1'
    let udfSession: SqliteSession | null = null
    try {
      udfSession = (await driver.createSession({
        id: 'test-sqlite-cancel-udf',
        name: 'Test SQLite Cancel UDF',
        driver: 'sqlite',
        database: 'test.db',
        filePath: testDbPath!,
      })) as SqliteSession

      // Start a query that sleeps
      const longQueryPromise = udfSession.runQuery(
        'heavy_1',
        'SELECT sleep_ms(3000);'
      )
      longQueryPromise.catch(() => {}) // prevent unhandled rejection during cancellation

      // Give worker brief moment to enter loop
      await new Promise((r) => setTimeout(r, 50))

      // Cancel query
      const cancelRes = await udfSession.cancelQuery('heavy_1')
      expect(cancelRes.ok).toBe(true)

      // Expect original query promise to reject with 'cancelled'
      await expect(longQueryPromise).rejects.toMatchObject({
        code: 'cancelled',
      })

      // Verify session remains fully functional for subsequent queries!
      const followUpRes = await udfSession.runQuery('q_followup', 'SELECT COUNT(*) AS total FROM products;')
      expect(followUpRes.isSelect).toBe(true)
      expect(followUpRes.rowCount).toBe(1)
    } finally {
      if (prevEnv === undefined) {
        delete process.env.DATANOA_ENABLE_TEST_UDF
      } else {
        process.env.DATANOA_ENABLE_TEST_UDF = prevEnv
      }
      if (udfSession) {
        await udfSession.close().catch(() => {})
      }
    }
  })

  it('gates sleep_ms UDF off by default in production connections', async () => {
    await expect(
      session!.runQuery('q-no-sleep-udf', 'SELECT sleep_ms(1);')
    ).rejects.toThrow(/no such function:\s*sleep_ms/i)
  })
})

describe('Wave 12 — SQLite Stability, Atomicity, 64-bit BigInt, WAL Busy Timeout, Leak Prevention & Schema Parity', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa_w12_sqlite_'))
  })

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        // Ignore Windows delayed lock cleanup
      }
    }
  })

  it('reads 64-bit INTEGER Snowflake IDs and INT64_MAX cleanly in fetchPage and runQuery via readBigInts', async () => {
    const dbPath = path.join(tmpDir, 'bigint.db')
    const setup = new DatabaseSync(dbPath)
    setup.exec(`
      CREATE TABLE events (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
      INSERT INTO events (id, label) VALUES (7234567890123456789, 'snowflake');
      INSERT INTO events (id, label) VALUES (9223372036854775807, 'int64_max');
      INSERT INTO events (id, label) VALUES (42, 'small_safe');
    `)
    setup.close()

    const driver = new SqliteDriver()
    const session = await driver.createSession({
      id: 'w12-bigint',
      name: 'BigInt SQLite',
      driver: 'sqlite',
      database: 'bigint.db',
      filePath: dbPath,
    })

    try {
      const page = await session.fetchPage({
        table: 'events',
        page: 1,
        pageSize: 10,
        sortColumn: 'id',
        sortDirection: 'ASC',
      })
      expect(page.totalRows).toBe(3)
      expect(page.rows).toEqual([
        { id: 42, label: 'small_safe' },
        { id: '7234567890123456789', label: 'snowflake' },
        { id: '9223372036854775807', label: 'int64_max' },
      ])

      const qRes = await session.runQuery('q-bigint', 'SELECT id, label FROM events ORDER BY id DESC;')
      expect(qRes.rows).toEqual([
        ['9223372036854775807', 'int64_max'],
        ['7234567890123456789', 'snowflake'],
        [42, 'small_safe'],
      ])
    } finally {
      await session.close()
    }
  })

  it('keeps applyChanges 100% atomic when a concurrent runQuery fails mid-batch', async () => {
    const dbPath = path.join(tmpDir, 'atomic.db')
    const setup = new DatabaseSync(dbPath)
    setup.exec(`
      CREATE TABLE ledger (
        id INTEGER PRIMARY KEY,
        bal INTEGER NOT NULL CHECK (bal >= 0)
      );
    `)
    const ins = setup.prepare('INSERT INTO ledger (id, bal) VALUES (?, ?);')
    for (let i = 1; i <= 40; i++) {
      ins.run(i, 100)
    }
    setup.close()

    const driver = new SqliteDriver()
    const session = await driver.createSession({
      id: 'w12-atomic',
      name: 'Atomic SQLite',
      driver: 'sqlite',
      database: 'atomic.db',
      filePath: dbPath,
    })

    try {
      const updates = Array.from({ length: 40 }, (_, idx) => ({
        primaryKeys: { id: idx + 1 },
        changes: { bal: idx === 39 ? -5 : 200 },
        originalRow: { id: idx + 1, bal: 100 },
      }))

      const applyPromise = session.applyChanges({ table: 'ledger', updates })
      const failingQueryPromise = session.runQuery('q-fail-mid-batch', 'SELECT * FROM no_such_tbl;')

      await Promise.all([
        expect(applyPromise).rejects.toThrow(/CHECK constraint/i),
        expect(failingQueryPromise).rejects.toThrow(/no such table/i),
      ])

      // Zero partial commits: all 40 rows must still have bal = 100
      const verify = await session.runQuery(
        'q-verify-atomic',
        'SELECT COUNT(*) AS unchanged FROM ledger WHERE bal = 100;'
      )
      expect(verify.rows).toEqual([[40]])
    } finally {
      await session.close()
    }
  })

  it('waits on WAL busy_timeout = 5000 instead of immediately failing with database is locked', async () => {
    const dbPath = path.join(tmpDir, 'wal-busy.db')
    const setup = new DatabaseSync(dbPath)
    setup.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      INSERT INTO items (name) VALUES ('init');
    `)
    setup.close()

    const driver = new SqliteDriver()
    const session = await driver.createSession({
      id: 'w12-wal',
      name: 'WAL SQLite',
      driver: 'sqlite',
      database: 'wal-busy.db',
      filePath: dbPath,
    })

    const locker = new DatabaseSync(dbPath)
    try {
      locker.exec('BEGIN IMMEDIATE;')
      locker.prepare("INSERT INTO items (name) VALUES ('from_locker');").run()

      // Release external lock after 150ms while worker waits via busy_timeout = 5000
      setTimeout(() => {
        try {
          locker.exec('COMMIT;')
        } catch {
          // Ignore
        }
      }, 150)

      const res = await session.runQuery(
        'q-wal-write',
        "INSERT INTO items (name) VALUES ('from_worker');"
      )
      expect(res.affectedRows).toBe(1)

      const check = await session.runQuery('q-wal-check', 'SELECT COUNT(*) FROM items;')
      expect(check.rows).toEqual([[3]])
    } finally {
      locker.close()
      await session.close()
    }
  })

  it('cleans up worker thread on failed createSession / testConnection without leaking handles', async () => {
    const driver = new SqliteDriver()
    const missingPath = path.join(tmpDir, 'does_not_exist_ro.db')

    await expect(
      driver.createSession({
        id: 'w12-leak-1',
        name: 'Missing RO',
        driver: 'sqlite',
        database: 'does_not_exist_ro.db',
        filePath: missingPath,
        readOnly: true,
      })
    ).rejects.toThrow()

    const testRes = await driver.testConnection({
      id: 'w12-leak-2',
      name: 'Missing RO Test',
      driver: 'sqlite',
      database: 'does_not_exist_ro.db',
      filePath: missingPath,
      readOnly: true,
    })
    expect(testRes.ok).toBe(false)
  })

  it('introspects generated columns (table_xinfo), ATTACH schemas, expression indexes, implicit FKs, and WITHOUT ROWID accurately', async () => {
    const db = new DatabaseSync(':memory:')
    const auxPath = path.join(tmpDir, 'aux.db')
    const auxSetup = new DatabaseSync(auxPath)
    auxSetup.exec('CREATE TABLE aux_only (aid INTEGER PRIMARY KEY, note TEXT);')
    auxSetup.close()

    try {
      db.exec(`
        CREATE TABLE parent (pid INTEGER PRIMARY KEY, title TEXT);
        CREATE TABLE items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parent_id INTEGER REFERENCES parent,
          label TEXT NOT NULL,
          qty INTEGER NOT NULL,
          price REAL NOT NULL,
          total REAL GENERATED ALWAYS AS (qty * price) VIRTUAL,
          tag TEXT GENERATED ALWAYS AS (lower(label)) STORED
        );
        CREATE INDEX idx_lower_label ON items(lower(label));
        CREATE TABLE kv_no_rowid (
          k INTEGER PRIMARY KEY,
          v TEXT
        ) WITHOUT ROWID;
        ATTACH DATABASE '${auxPath.replace(/'/g, "''")}' AS aux;
      `)

      const queryExecutor = async (sql: string, params: unknown[] = []) => {
        const stmt = db.prepare(sql)
        return stmt.all(...(params as SQLInputValue[])) as Record<string, unknown>[]
      }

      // 1. table_xinfo includes virtual & stored generated columns with isGenerated: true
      const itemDetails = await introspectSqliteTableDetails(queryExecutor, 'items', 'main')
      const totalCol = itemDetails.columns.find((c) => c.name === 'total')
      const tagCol = itemDetails.columns.find((c) => c.name === 'tag')
      const labelCol = itemDetails.columns.find((c) => c.name === 'label')
      expect(totalCol?.isGenerated).toBe(true)
      expect(tagCol?.isGenerated).toBe(true)
      expect(labelCol?.isGenerated).toBeUndefined()

      // 2. Implicit FK REFERENCES parent resolves parent PK 'pid' (NOT "null")
      expect(itemDetails.foreignKeys).toHaveLength(1)
      expect(itemDetails.foreignKeys[0].referencedTable).toBe('parent')
      expect(itemDetails.foreignKeys[0].referencedColumn).toBe('pid')

      // 3. Expression index filters null column names (NOT ["null"])
      const exprIdx = itemDetails.indexes.find((i) => i.name === 'idx_lower_label')
      expect(exprIdx).toBeDefined()
      expect(exprIdx?.columns).toEqual([])

      // 4. WITHOUT ROWID INTEGER PRIMARY KEY is NOT autoincrement
      const noRowidDetails = await introspectSqliteTableDetails(queryExecutor, 'kv_no_rowid', 'main')
      expect(noRowidDetails.columns.find((c) => c.name === 'k')?.isAutoIncrement).toBe(false)

      // 5. ATTACH schema 'aux' lists aux_only (NOT main tables) and inspects aux_only
      const auxObjects = await introspectSqliteObjects(queryExecutor, 'aux')
      expect(auxObjects).toEqual([{ name: 'aux_only', schema: 'aux', kind: 'table' }])
      const auxDetails = await introspectSqliteTableDetails(queryExecutor, 'aux_only', 'aux')
      expect(auxDetails.schema).toBe('aux')
      expect(auxDetails.columns.map((c) => c.name)).toEqual(['aid', 'note'])
    } finally {
      db.close()
    }
  })
})

describe('SqliteSession Closed State Guards', () => {
  let driver: SqliteDriver
  let session: SqliteSession

  beforeEach(async () => {
    driver = new SqliteDriver()
    session = (await driver.createSession({
      id: 'test-sqlite-closed',
      name: 'Test SQLite Closed',
      driver: 'sqlite',
      database: ':memory:',
    })) as SqliteSession
    await session.close()
  })

  it('rejects runQuery immediately on closed session with SESSION_CLOSED', async () => {
    await expect(session.runQuery('q-closed', 'SELECT 1;')).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DatabaseDriverError &&
        err.code === 'SESSION_CLOSED' &&
        err.driver === 'sqlite'
      )
    })
  })

  it('rejects fetchPage on closed session with SESSION_CLOSED', async () => {
    await expect(
      session.fetchPage({ table: 'products', page: 1, pageSize: 10 })
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DatabaseDriverError &&
        err.code === 'SESSION_CLOSED' &&
        err.driver === 'sqlite'
      )
    })
  })

  it('rejects updateCell on closed session with SESSION_CLOSED', async () => {
    await expect(
      session.updateCell({
        table: 'products',
        primaryKeys: { id: 1 },
        column: 'price',
        newValue: 20,
      })
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DatabaseDriverError &&
        err.code === 'SESSION_CLOSED' &&
        err.driver === 'sqlite'
      )
    })
  })

  it('rejects getTableDetails on closed session with SESSION_CLOSED', async () => {
    await expect(session.getTableDetails('products')).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DatabaseDriverError &&
        err.code === 'SESSION_CLOSED' &&
        err.driver === 'sqlite'
      )
    })
  })

  it('rejects listObjects on closed session with SESSION_CLOSED', async () => {
    await expect(session.listObjects()).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DatabaseDriverError &&
        err.code === 'SESSION_CLOSED' &&
        err.driver === 'sqlite'
      )
    })
  })

  it('rejects cancelQuery on closed session with SESSION_CLOSED', async () => {
    await expect(session.cancelQuery('q-any')).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DatabaseDriverError &&
        err.code === 'SESSION_CLOSED' &&
        err.driver === 'sqlite'
      )
    })
  })

  it('returns ok: false from test() on closed session', async () => {
    const res = await session.test()
    expect(res.ok).toBe(false)
  })
})

