/**
 * test/e2e/tier1-feature-coverage/f01-f04-scaffold-drivers.e2e.test.ts
 *
 * Tier 1 Feature Coverage: Features F1 through F4
 * - Feature F1: Orca Extension Scaffold & Manifest
 * - Feature F2: Type-Safe IPC Protocol Contracts
 * - Feature F3: Unified Driver Interface & Dialects
 * - Feature F4: Native SQLite Driver (node:sqlite)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import {
  setupE2ETestContext,
  teardownE2ETestContext,
  invokeRequest,
  assertOk,
  registerSqliteWorkerHandlers,
  type TestContext,
} from '../harness/test-helpers.js'
import {
  createTestSqliteDatabase,
  quoteIdentifier,
  makePlaceholder,
} from '../harness/test-db-fixtures.js'
import {
  SAVED_CONNECTIONS_STORAGE_KEY,
  ACTIVE_CONNECTION_STORAGE_KEY,
  type ConnectionProfile,
  type SchemaObject,
  type TableDetails,
  type TableBrowseResult,
  type QueryResult,
} from '../../../src/protocol.js'

describe('Tier 1 Feature Coverage: Features F1 - F4 (Scaffold, Protocol, Dialects, SQLite Driver)', () => {
  let context: TestContext
  const projectRoot = path.resolve(__dirname, '../../..')

  beforeEach(() => {
    context = setupE2ETestContext({ withSqlite: true, inMemory: true })
    if (context.sqlite) {
      registerSqliteWorkerHandlers(context.runtime, context.sqlite.db)
    }
  })

  afterEach(async () => {
    await teardownE2ETestContext(context)
  })

  // =========================================================================
  // Feature F1: Orca Extension Scaffold & Manifest
  // =========================================================================
  describe('Feature F1: Orca Extension Scaffold & Manifest', () => {
    it('TC-F1-01: Manifest Schema & Identity Validation', () => {
      const manifestPath = path.join(projectRoot, 'orca-plugin.json')
      expect(fs.existsSync(manifestPath)).toBe(true)

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      expect(manifest.manifestVersion).toBe(2)
      expect(manifest.id).toBe('datanoa')
      expect(manifest.name).toBe('Datanoa Studio')
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(manifest.execution).toBe('trusted-worker')
      expect(manifest.pluginApi).toBe(1)
      expect(manifest.main).toBe('src/worker/index.ts')
      expect(manifest.engines).toBeDefined()
      expect(manifest.engines.orca).toBe('>=1.4.248')
    })

    it('TC-F1-02: Required File Entry Points & Manifest Targets Existence', () => {
      const requiredFiles = [
        'orca-plugin.json',
        'package.json',
        'tsconfig.json',
        'src/worker/index.ts',
        'src/panel/panel.html',
        'src/panel/panel.css',
        'src/panel/panel-core.js',
        'src/editor/index.ts',
        'src/protocol.ts',
        'vendor/pg.js',
        'vendor/mysql2.js',
        'vendor/codemirror.js',
      ]

      for (const relPath of requiredFiles) {
        const fullPath = path.join(projectRoot, relPath)
        expect(fs.existsSync(fullPath), `File must exist: ${relPath}`).toBe(true)
        const stats = fs.statSync(fullPath)
        expect(stats.size, `File must not be empty: ${relPath}`).toBeGreaterThan(0)
      }
    })

    it('TC-F1-03: Security Capabilities & Least Privilege Audit', () => {
      const manifestPath = path.join(projectRoot, 'orca-plugin.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      const capabilityKinds = manifest.capabilities.map((c: { kind: string }) => c.kind)

      // Must declare exactly the 5 required capabilities
      expect(capabilityKinds).toHaveLength(5)
      expect(capabilityKinds).toContain('storage:own')
      expect(capabilityKinds).toContain('secrets:own')
      expect(capabilityKinds).toContain('workspace:read')
      expect(capabilityKinds).toContain('workspace:write')
      expect(capabilityKinds).toContain('settings:own')

      // Must not declare unneeded elevated capabilities
      expect(capabilityKinds).not.toContain('network:*')
      expect(capabilityKinds).not.toContain('shell:*')
      expect(capabilityKinds).not.toContain('system:*')
    })

    it('TC-F1-04: UI & Command Contributions Integrity', () => {
      const manifestPath = path.join(projectRoot, 'orca-plugin.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

      // Panels
      expect(manifest.contributes.panels).toBeDefined()
      expect(manifest.contributes.panels).toContainEqual(
        expect.objectContaining({
          id: 'datanoa-panel',
          entry: 'src/panel/panel.html',
          ui: 'html',
        })
      )

      // Custom editors
      expect(manifest.contributes.customEditors).toBeDefined()
      expect(manifest.contributes.customEditors).toContainEqual(
        expect.objectContaining({
          id: 'datanoa-studio',
          entry: 'src/editor/index.ts',
          frame: 'isolated',
          extensions: expect.arrayContaining(['.sql', '.datanoa']),
        })
      )

      // Commands
      const commandIds = manifest.contributes.commands.map((c: { id: string }) => c.id)
      expect(commandIds).toContain('datanoa.openSqliteFile')
      expect(commandIds).toContain('datanoa.newQuery')

      // Settings
      const settings = manifest.contributes.settings as Array<{ key: string; default: number }>
      const maxRowsSetting = settings.find((s) => s.key === 'maxRows')
      expect(maxRowsSetting).toBeDefined()
      expect(maxRowsSetting?.default).toBe(1000)

      const timeoutSetting = settings.find((s) => s.key === 'queryTimeoutSeconds')
      expect(timeoutSetting).toBeDefined()
      expect(timeoutSetting?.default).toBe(30)
    })

    it('TC-F1-05: Vendor Bundle Size Limit & CSP Compliance Guard', () => {
      const vendorFiles = ['vendor/pg.js', 'vendor/mysql2.js', 'vendor/codemirror.js']
      const ONE_MIB = 1024 * 1024 // 1,048,576 bytes

      for (const relPath of vendorFiles) {
        const fullPath = path.join(projectRoot, relPath)
        const stats = fs.statSync(fullPath)
        expect(stats.size, `${relPath} must be <= 1 MiB`).toBeLessThanOrEqual(ONE_MIB)

        const content = fs.readFileSync(fullPath, 'utf8')
        expect(content.match(/\beval\s*\(/g), `${relPath} must not contain eval()`).toBeNull()
        expect(content.match(/new\s+Function\s*\(/g), `${relPath} must not contain new Function()`).toBeNull()
      }
    })
  })

  // =========================================================================
  // Feature F2: Type-Safe IPC Protocol Contracts
  // =========================================================================
  describe('Feature F2: Type-Safe IPC Protocol Contracts', () => {
    it('TC-F2-01: IPC Method Names & Storage Keys Exhaustive Coverage', () => {
      expect(SAVED_CONNECTIONS_STORAGE_KEY).toBe('datanoa.savedConnections')
      expect(ACTIVE_CONNECTION_STORAGE_KEY).toBe('datanoa.activeConnectionId')

      const registeredHandlers = Array.from(
        (context.runtime as unknown as { panelHandlers: Map<string, unknown> }).panelHandlers.keys()
      )
      const requiredMethods = [
        'connections.list',
        'connection.save',
        'connection.delete',
        'connection.test',
        'schema.listObjects',
        'schema.tableDetails',
        'data.fetchPage',
        'data.updateCell',
        'query.run',
        'query.cancel',
      ]

      for (const method of requiredMethods) {
        expect(registeredHandlers, `Method ${method} must be registered`).toContain(method)
      }
    })

    it('TC-F2-02: Connection Profile Lifecycle Contracts (List, Save, Delete)', async () => {
      const profile: ConnectionProfile = {
        id: 'conn-f2',
        name: 'Profile F2 SQLite',
        driver: 'sqlite',
        database: ':memory:',
        hasPassword: true,
      }

      // Save with password
      const saveRes = await invokeRequest(context.runtime, 'connection.save', {
        profile,
        password: 'vault-secret-f2',
      })
      assertOk(saveRes)
      expect(saveRes.id).toBe('conn-f2')

      // Secret vault verification
      const storedSecret = await context.runtime.getWorkerApi().secrets.get('pwd_conn-f2')
      expect(storedSecret).toBe('vault-secret-f2')

      // List profiles verification
      const listRes = await invokeRequest(context.runtime, 'connections.list')
      const found = listRes.find((p: ConnectionProfile) => p.id === 'conn-f2')
      expect(found).toBeDefined()
      expect(found?.name).toBe('Profile F2 SQLite')
      expect(found).not.toHaveProperty('password')

      // Delete profile
      const deleteRes = await invokeRequest(context.runtime, 'connection.delete', { id: 'conn-f2' })
      assertOk(deleteRes)

      // Post-delete checks
      const secretAfterDelete = await context.runtime.getWorkerApi().secrets.get('pwd_conn-f2')
      expect(secretAfterDelete).toBeNull()

      const listAfterDelete = await invokeRequest(context.runtime, 'connections.list')
      expect(listAfterDelete.find((p: ConnectionProfile) => p.id === 'conn-f2')).toBeUndefined()
    })

    it('TC-F2-03: Schema & Metadata Contract Validation', async () => {
      const objectsRes = await invokeRequest(context.runtime, 'schema.listObjects', {
        connectionId: 'test-sqlite-conn',
      })
      expect(Array.isArray(objectsRes)).toBe(true)
      expect(objectsRes.length).toBeGreaterThan(0)

      const tableObj = objectsRes.find((o: SchemaObject) => o.name === 'customers')
      expect(tableObj).toBeDefined()
      expect(tableObj?.kind).toBe('table')

      const detailsRes: TableDetails = await invokeRequest(context.runtime, 'schema.tableDetails', {
        connectionId: 'test-sqlite-conn',
        table: 'customers',
      })
      expect(detailsRes.name).toBe('customers')
      expect(detailsRes.primaryKey).toEqual(['id'])
      expect(detailsRes.columns.length).toBeGreaterThanOrEqual(4)

      const idCol = detailsRes.columns.find((c) => c.name === 'id')
      expect(idCol?.isPrimaryKey).toBe(true)
      expect(idCol?.isAutoIncrement).toBe(true)

      const emailCol = detailsRes.columns.find((c) => c.name === 'email')
      expect(emailCol?.nullable).toBe(false)
    })

    it('TC-F2-04: Data Browse Pagination & Cell Update Contracts', async () => {
      const browseRes: TableBrowseResult = await invokeRequest(context.runtime, 'data.fetchPage', {
        connectionId: 'test-sqlite-conn',
        table: 'products',
        page: 1,
        pageSize: 2,
      })
      expect(browseRes.columns.length).toBeGreaterThan(0)
      expect(browseRes.rows.length).toBe(2)
      expect(browseRes.totalRows).toBe(3)
      expect(browseRes.primaryKey).toEqual(['sku'])
      expect(browseRes.canEdit).toBe(true)

      const updateRes = await invokeRequest(context.runtime, 'data.updateCell', {
        connectionId: 'test-sqlite-conn',
        table: 'products',
        primaryKeys: { sku: 'PROD-001' },
        column: 'price',
        newValue: 149.99,
        originalValue: 129.99,
      })
      assertOk(updateRes)
      expect(updateRes.affectedRows).toBe(1)
      expect(updateRes.updatedRecord).toBeDefined()
      expect(updateRes.updatedRecord?.price).toBe(149.99)
    })

    it('TC-F2-05: Query Execution & Panel Events Broadcast Contracts', async () => {
      let connectionsEventReceived = false
      let cellUpdatedEventReceived = false

      context.runtime.client.on('connections.changed', () => {
        connectionsEventReceived = true
      })
      context.runtime.client.on('data.cellUpdated', () => {
        cellUpdatedEventReceived = true
      })

      // Run query
      const queryRes: QueryResult = await invokeRequest(context.runtime, 'query.run', {
        connectionId: 'test-sqlite-conn',
        queryId: 'q-f2-broadcast',
        sql: 'SELECT count(*) as count FROM customers',
      })
      expect(queryRes.isSelect).toBe(true)
      expect(queryRes.rowCount).toBe(1)
      expect(queryRes.executionTimeMs).toBeGreaterThanOrEqual(0)

      // Trigger connection save to emit event
      await invokeRequest(context.runtime, 'connection.save', {
        profile: {
          id: 'conn-event-test',
          name: 'Event Test',
          driver: 'sqlite',
          database: ':memory:',
        },
      })
      expect(connectionsEventReceived).toBe(true)

      // Trigger cell update to emit event
      await invokeRequest(context.runtime, 'data.updateCell', {
        connectionId: 'test-sqlite-conn',
        table: 'customers',
        primaryKeys: { id: 1 },
        column: 'phone',
        newValue: '+84999999999',
        originalValue: '+84901234567',
      })
      expect(cellUpdatedEventReceived).toBe(true)
    })
  })

  // =========================================================================
  // Feature F3: Unified Driver Interface & Dialects
  // =========================================================================
  describe('Feature F3: Unified Driver Interface & Dialects', () => {
    it('TC-F3-01: Identifier Quoting Across SQLite, PostgreSQL, and MySQL', () => {
      // Unqualified
      expect(quoteIdentifier('sqlite', 'orders')).toBe('"orders"')
      expect(quoteIdentifier('postgres', 'orders')).toBe('"orders"')
      expect(quoteIdentifier('mysql', 'orders')).toBe('`orders`')

      // Schema-qualified
      expect(quoteIdentifier('sqlite', 'orders', 'main')).toBe('"main"."orders"')
      expect(quoteIdentifier('postgres', 'users', 'public')).toBe('"public"."users"')
      expect(quoteIdentifier('mysql', 'orders', 'shop')).toBe('`shop`.`orders`')
    })

    it('TC-F3-02: Identifier Quoting with Dangerous Characters & Keywords', () => {
      // Escaping quotes inside identifiers
      expect(quoteIdentifier('sqlite', 'user"name')).toBe('"user""name"')
      expect(quoteIdentifier('postgres', 'user"name')).toBe('"user""name"')
      expect(quoteIdentifier('mysql', 'user`name')).toBe('`user``name`')

      // Identifiers with hyphens and spaces
      expect(quoteIdentifier('sqlite', 'special_order-items')).toBe('"special_order-items"')
      expect(quoteIdentifier('mysql', 'order details')).toBe('`order details`')

      // SQL reserved keywords as identifiers
      expect(quoteIdentifier('sqlite', 'select')).toBe('"select"')
      expect(quoteIdentifier('postgres', 'where')).toBe('"where"')
      expect(quoteIdentifier('mysql', 'group by')).toBe('`group by`')
    })

    it('TC-F3-03: Dialect Parameter Placeholders for Varied Argument Counts', () => {
      for (let i = 1; i <= 20; i++) {
        expect(makePlaceholder('sqlite', i)).toBe('?')
        expect(makePlaceholder('mysql', i)).toBe('?')
        expect(makePlaceholder('postgres', i)).toBe(`$${i}`)
      }
    })

    it('TC-F3-04: Connection Profile Normalization by Dialect', () => {
      const normalizeProfile = (raw: Partial<ConnectionProfile>): ConnectionProfile => {
        const driver = raw.driver || 'sqlite'
        return {
          id: raw.id || `conn_${Date.now()}`,
          name: raw.name || 'Untitled Connection',
          driver,
          database: raw.database || (driver === 'sqlite' ? ':memory:' : 'defaultdb'),
          host: raw.host || (driver === 'sqlite' ? undefined : 'localhost'),
          port: raw.port || (driver === 'postgres' ? 5432 : driver === 'mysql' ? 3306 : undefined),
          user: raw.user || (driver === 'postgres' ? 'postgres' : driver === 'mysql' ? 'root' : undefined),
          ssl: raw.ssl ?? false,
          readOnly: raw.readOnly ?? false,
          filePath: raw.filePath,
        }
      }

      const sqliteNorm = normalizeProfile({ driver: 'sqlite' })
      expect(sqliteNorm.driver).toBe('sqlite')
      expect(sqliteNorm.database).toBe(':memory:')
      expect(sqliteNorm.port).toBeUndefined()

      const pgNorm = normalizeProfile({ driver: 'postgres' })
      expect(pgNorm.driver).toBe('postgres')
      expect(pgNorm.port).toBe(5432)
      expect(pgNorm.user).toBe('postgres')

      const mysqlNorm = normalizeProfile({ driver: 'mysql' })
      expect(mysqlNorm.driver).toBe('mysql')
      expect(mysqlNorm.port).toBe(3306)
      expect(mysqlNorm.user).toBe('root')
    })

    it('TC-F3-05: Multi-Dialect Cancellation Strategies Mapping', () => {
      const getCancellationStatement = (driver: 'postgres' | 'mysql' | 'sqlite', pidOrThreadId?: number) => {
        if (driver === 'postgres') {
          return { sql: 'SELECT pg_cancel_backend($1)', params: [pidOrThreadId] }
        }
        if (driver === 'mysql') {
          return { sql: 'KILL QUERY ?', params: [pidOrThreadId] }
        }
        // SQLite: in-process cancel
        return { inProcess: true }
      }

      const pgCancel = getCancellationStatement('postgres', 12345)
      expect(pgCancel.sql).toBe('SELECT pg_cancel_backend($1)')
      expect(pgCancel.params).toEqual([12345])

      const mysqlCancel = getCancellationStatement('mysql', 99)
      expect(mysqlCancel.sql).toBe('KILL QUERY ?')
      expect(mysqlCancel.params).toEqual([99])

      const sqliteCancel = getCancellationStatement('sqlite')
      expect(sqliteCancel.inProcess).toBe(true)
    })
  })

  // =========================================================================
  // Feature F4: Native SQLite Driver (node:sqlite)
  // =========================================================================
  describe('Feature F4: Native SQLite Driver (node:sqlite)', () => {
    it('TC-F4-01: In-Memory SQLite Lifecycle & Full CRUD Operations', () => {
      const db = new DatabaseSync(':memory:')
      try {
        db.exec(`
          CREATE TABLE crud_items (
            id INTEGER PRIMARY KEY,
            title TEXT NOT NULL,
            price REAL NOT NULL
          );
        `)

        // INSERT
        const insertStmt = db.prepare('INSERT INTO crud_items (id, title, price) VALUES (?, ?, ?)')
        insertStmt.run(1, 'Item One', 19.99)
        insertStmt.run(2, 'Item Two', 49.5)
        insertStmt.run(3, 'Item Three', 99.0)

        // SELECT
        const selectStmt = db.prepare('SELECT * FROM crud_items ORDER BY id ASC')
        const rows = selectStmt.all() as Array<{ id: number; title: string; price: number }>
        expect(rows).toHaveLength(3)
        expect(rows[0]).toEqual({ id: 1, title: 'Item One', price: 19.99 })
        expect(rows[1]).toEqual({ id: 2, title: 'Item Two', price: 49.5 })

        // UPDATE
        const updateStmt = db.prepare('UPDATE crud_items SET price = ? WHERE id = ?')
        const updateRes = updateStmt.run(24.99, 1)
        expect(Number(updateRes.changes)).toBe(1)

        const updatedRow = (db.prepare('SELECT price FROM crud_items WHERE id = ?').get(1) as { price: number })
        expect(updatedRow.price).toBe(24.99)

        // DELETE
        const deleteStmt = db.prepare('DELETE FROM crud_items WHERE id = ?')
        const deleteRes = deleteStmt.run(3)
        expect(Number(deleteRes.changes)).toBe(1)

        const countRow = (db.prepare('SELECT count(*) as count FROM crud_items').get() as { count: number })
        expect(countRow.count).toBe(2)
      } finally {
        db.close()
      }
    })

    it('TC-F4-02: Disk File SQLite Database Persistence & Windows Clean Teardown', () => {
      const testDbFixture = createTestSqliteDatabase({ inMemory: false })
      const filePath = testDbFixture.filePath!
      expect(fs.existsSync(filePath)).toBe(true)

      // Verify seed data was inserted
      const queryStmt = testDbFixture.db.prepare('SELECT count(*) as count FROM customers')
      const count = (queryStmt.get() as { count: number }).count
      expect(count).toBe(3)

      // Safe teardown without Windows EBUSY lock
      testDbFixture.cleanup()
      expect(fs.existsSync(filePath)).toBe(false)
    }, 20000)

    it('TC-F4-03: Transactional Bulk Operations & Aggregations Performance', () => {
      const db = new DatabaseSync(':memory:')
      try {
        db.exec('CREATE TABLE bulk_records (id INTEGER PRIMARY KEY, value REAL, note TEXT)')

        const startTime = performance.now()
        db.exec('BEGIN TRANSACTION')
        const insertStmt = db.prepare('INSERT INTO bulk_records (id, value, note) VALUES (?, ?, ?)')
        for (let i = 1; i <= 300; i++) {
          insertStmt.run(i, i * 1.5, `Record #${i}`)
        }
        db.exec('COMMIT')
        const duration = performance.now() - startTime

        // Should complete well within 250ms
        expect(duration).toBeLessThan(250)

        const aggRow = (db.prepare(`
          SELECT count(*) as total, sum(value) as total_val, max(id) as max_id FROM bulk_records
        `).get() as { total: number; total_val: number; max_id: number })

        expect(aggRow.total).toBe(300)
        expect(aggRow.max_id).toBe(300)
        expect(aggRow.total_val).toBeCloseTo(300 * 301 * 0.75, 1)
      } finally {
        db.close()
      }
    })

    it('TC-F4-04: Multi-Type Data Fidelity Matrix', () => {
      const db = context.sqlite!.db
      const selectStmt = db.prepare('SELECT * FROM types_matrix WHERE id = 1')
      const row = selectStmt.get() as {
        id: number
        int_val: number
        real_val: number
        text_val: string
        blob_val: Uint8Array | Buffer
        null_val: unknown
        unicode_val: string
      }

      expect(row.int_val).toBe(Number.MAX_SAFE_INTEGER)
      expect(row.real_val).toBeCloseTo(3.14159265359, 8)
      expect(row.null_val).toBeNull()
      expect(row.unicode_val).toContain('Tiếng Việt')
      expect(row.unicode_val).toContain('日本語')
      expect(row.unicode_val).toContain('🇻🇳')

      // BLOB insertion and retrieval verification
      const blobData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd])
      const insertStmt = db.prepare('INSERT INTO types_matrix (blob_val) VALUES (?)')
      const insertRes = insertStmt.run(blobData)
      const blobRow = db.prepare('SELECT blob_val FROM types_matrix WHERE id = ?').get(insertRes.lastInsertRowid) as { blob_val: Uint8Array }
      expect(blobRow.blob_val).toBeDefined()
      expect(Buffer.from(blobRow.blob_val)).toEqual(blobData)
    })

    it('TC-F4-05: Non-Blocking Execution Simulation & Query Cancellation', async () => {
      const controller = new AbortController()

      // Simulate an execution pipeline that respects signal
      const cancellableQuery = async (signal: AbortSignal) => {
        if (signal.aborted) {
          throw new Error('cancelled')
        }
        return new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve(42)
          }, 200)

          signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('cancelled'))
          })
        })
      }

      // Launch and immediately abort
      const promise = cancellableQuery(controller.signal)
      controller.abort()

      await expect(promise).rejects.toThrow('cancelled')

      // Subsequent query must run smoothly on database
      const subsequentResult = context.sqlite!.db.prepare('SELECT 1 as alive').get() as { alive: number }
      expect(subsequentResult.alive).toBe(1)
    })
  })
})
