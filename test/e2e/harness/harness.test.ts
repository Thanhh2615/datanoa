/**
 * test/e2e/harness/harness.test.ts
 *
 * Self-verification test suite for the Datanoa E2E Test Harness.
 * Validates MockOrcaRuntime, SQLite fixtures, dialect generators,
 * and test helper utilities.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import {
  MockOrcaRuntime,
  createHostError,
  type HostCallError
} from './mock-orca-runtime.js'
import {
  createTestSqliteDatabase,
  introspectSqliteDatabase,
  quoteIdentifier,
  makePlaceholder,
  buildTestUpdateSql,
  POSTGRES_MOCK_FIXTURES,
  MYSQL_MOCK_FIXTURES
} from './test-db-fixtures.js'
import {
  setupE2ETestContext,
  teardownE2ETestContext,
  invokeRequest,
  assertOk,
  assertRejection,
  verifyOptimisticLocking,
  measureQueryPerformance,
  assertBrowseResult,
  assertQueryResult,
  registerSqliteWorkerHandlers,
  type TestContext
} from './test-helpers.js'
import type { ConnectionProfile } from './protocol-types.js'

describe('Datanoa E2E Test Harness Self-Verification', () => {
  let context: TestContext

  beforeEach(() => {
    context = setupE2ETestContext({ withSqlite: true, inMemory: true })
  })

  afterEach(async () => {
    await teardownE2ETestContext(context)
  })

  describe('1. MockOrcaRuntime Core Services', () => {
    it('should store, retrieve, list keys, and delete items in storage:own with deep cloning', async () => {
      const { runtime } = context
      const workerApi = runtime.getWorkerApi()

      // Set item
      const originalObj = { active: true, count: 42, tags: ['alpha', 'beta'] }
      await workerApi.storage.set('config', originalObj)

      // Get item and verify deep cloning
      const retrieved = (await workerApi.storage.get('config')) as any
      expect(retrieved).toEqual(originalObj)
      expect(retrieved).not.toBe(originalObj) // Must be distinct memory reference

      // Mutate retrieved to verify storage isolation
      retrieved.tags.push('gamma')
      const reFetched = (await workerApi.storage.get('config')) as any
      expect(reFetched.tags).toEqual(['alpha', 'beta'])

      // Keys check
      const keys = await workerApi.storage.keys()
      expect(keys).toContain('config')

      // Delete item
      await workerApi.storage.delete('config')
      const afterDelete = await workerApi.storage.get('config')
      expect(afterDelete).toBeNull()
    })

    it('should notify storage change listeners on set and delete', async () => {
      const { runtime } = context
      const workerApi = runtime.getWorkerApi()
      const changes: string[] = []

      const disposable = workerApi.storage.onDidChange(({ key }) => {
        changes.push(key)
      })

      await workerApi.storage.set('key1', 'value1')
      await workerApi.storage.set('key2', 'value2')
      await workerApi.storage.delete('key1')

      expect(changes).toEqual(['key1', 'key2', 'key1'])
      disposable.dispose()

      await workerApi.storage.set('key3', 'value3')
      expect(changes.length).toBe(3) // No new notifications after dispose
    })

    it('should manage secrets vault asynchronously and keep values isolated', async () => {
      const { runtime } = context
      const workerApi = runtime.getWorkerApi()

      await workerApi.secrets.set('conn_pwd_1', 's3cr3t!P@ss')
      const retrieved = await workerApi.secrets.get('conn_pwd_1')
      expect(retrieved).toBe('s3cr3t!P@ss')

      const missing = await workerApi.secrets.get('non_existent')
      expect(missing).toBeNull()

      await workerApi.secrets.delete('conn_pwd_1')
      const afterDelete = await workerApi.secrets.get('conn_pwd_1')
      expect(afterDelete).toBeNull()
    })

    it('should handle settings defaults, updates, and change notifications', async () => {
      const { runtime } = context
      const workerApi = runtime.getWorkerApi()

      const defaultDriver = await workerApi.settings.get('defaultDriver')
      expect(defaultDriver).toBe('sqlite')

      const allSettings = await workerApi.settings.get()
      expect(allSettings.rowLimit).toBe(1000)

      let notifiedKey = ''
      const sub = workerApi.settings.onDidChange(({ key }) => {
        notifiedKey = key
      })

      await workerApi.settings.set('rowLimit', 500)
      expect(notifiedKey).toBe('rowLimit')
      expect(await workerApi.settings.get('rowLimit')).toBe(500)

      sub.dispose()
    })

    it('should dispatch panel requests, support AbortSignal, and handle timeouts', async () => {
      const { runtime } = context
      const workerApi = runtime.getWorkerApi()

      // Register request handler
      workerApi.panels.handle('connection.delete', async (input) => {
        if (!input.id) throw createHostError('invalid_params', 'Missing id')
        return { ok: true }
      })

      // Successful request
      const res = await runtime.client.request('connection.delete', { id: 'conn_1' })
      expect(res).toEqual({ ok: true })

      // Unknown method error
      await assertRejection(
        runtime.client.request('unknown.method' as any, {}),
        'unknown_method'
      )

      // Timeout handling
      workerApi.panels.handle('query.run', async (_input, ctx) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ ok: true } as any), 500)
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(createHostError('cancelled', 'Aborted'))
          })
        })
      })

      await assertRejection(
        runtime.client.request('query.run', { connectionId: 'c1', queryId: 'q1', sql: 'SELECT 1' }, { timeoutMs: 50 }),
        'timeout'
      )
    })

    it('should post and receive panel events asynchronously', async () => {
      const { runtime } = context
      const workerApi = runtime.getWorkerApi()

      const receivedEvents: any[] = []
      const subscription = runtime.client.on('connections.changed', (payload) => {
        receivedEvents.push(payload)
      })

      workerApi.panels.post('connections.changed', { count: 3 })
      workerApi.panels.post('connections.changed', { count: 4 })

      expect(receivedEvents).toEqual([{ count: 3 }, { count: 4 }])
      expect(runtime.eventHistory.length).toBe(2)

      subscription.dispose()
      workerApi.panels.post('connections.changed', { count: 5 })
      expect(receivedEvents.length).toBe(2) // No new events after dispose
    })
  })

  describe('2. Native SQLite Fixture & Introspection', () => {
    it('should initialize rich in-memory schema and seed multi-dialect Unicode data', () => {
      const { sqlite } = context
      expect(sqlite).toBeDefined()
      const db = sqlite!.db

      // Verify tables exist
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[]

      const tableNames = tables.map((t) => t.name)
      expect(tableNames).toContain('customers')
      expect(tableNames).toContain('categories')
      expect(tableNames).toContain('products')
      expect(tableNames).toContain('orders')
      expect(tableNames).toContain('order_items')
      expect(tableNames).toContain('audit_logs')
      expect(tableNames).toContain('types_matrix')
      expect(tableNames).toContain('special_order-items')

      // Verify Unicode and JSON data
      const customer = db.prepare('SELECT * FROM customers WHERE id = 1').get() as any
      expect(customer.name).toBe('Nguyễn Văn An')
      expect(customer.email).toBe('an.nguyen@example.com')
      expect(JSON.parse(customer.metadata).tier).toBe('gold')

      const japanese = db.prepare('SELECT * FROM customers WHERE id = 2').get() as any
      expect(japanese.name).toBe('佐藤 健 (Ken Sato)')

      const typesRow = db.prepare('SELECT * FROM types_matrix WHERE id = 1').get() as any
      expect(typesRow.int_val).toBe(9007199254740991)
      expect(typesRow.unicode_val).toContain('Tiếng Việt có dấu - 🇻🇳 - 日本語 - 漢字')
    })

    it('should create and safely tear down temporary file databases without Windows file lock errors', () => {
      const tempFixture = createTestSqliteDatabase({ inMemory: false, seed: true })
      expect(tempFixture.filePath).toBeDefined()
      expect(fs.existsSync(tempFixture.filePath!)).toBe(true)

      // Perform a write
      tempFixture.db.exec("INSERT INTO categories (name, slug) VALUES ('Temp Cat', 'temp-cat')")
      const cat = tempFixture.db.prepare("SELECT * FROM categories WHERE slug = 'temp-cat'").get() as any
      expect(cat.name).toBe('Temp Cat')

      // Cleanup
      const filePath = tempFixture.filePath!
      tempFixture.cleanup()

      // Verify file is safely unlinked on Windows
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('should introspect SQLite schema completely, including primary keys, composite PKs, FKs, and indexes', () => {
      const { sqlite } = context
      const { objects, tables } = introspectSqliteDatabase(sqlite!.db)

      expect(objects.length).toBeGreaterThanOrEqual(9)
      const customerObj = objects.find((o) => o.name === 'customers')
      expect(customerObj).toEqual({ name: 'customers', schema: 'main', kind: 'table' })

      const viewObj = objects.find((o) => o.name === 'v_customer_orders')
      expect(viewObj).toEqual({ name: 'v_customer_orders', schema: 'main', kind: 'view' })

      // Single PK table
      const customersTable = tables['customers']
      expect(customersTable.primaryKey).toEqual(['id'])
      expect(customersTable.columns.find((c) => c.name === 'id')?.isAutoIncrement).toBe(true)
      expect(customersTable.columns.find((c) => c.name === 'email')?.nullable).toBe(false)
      expect(customersTable.indexes.some((i) => i.name === 'idx_customers_phone')).toBe(true)

      // Composite PK table
      const orderItemsTable = tables['order_items']
      expect(orderItemsTable.primaryKey).toEqual(['order_id', 'item_id'])
      expect(orderItemsTable.foreignKeys.length).toBe(2)
      expect(orderItemsTable.foreignKeys.some((fk) => fk.referencedTable === 'orders')).toBe(true)
      expect(orderItemsTable.foreignKeys.some((fk) => fk.referencedTable === 'products')).toBe(true)

      // No-PK table
      const auditTable = tables['audit_logs']
      expect(auditTable.primaryKey).toEqual([])
    })
  })

  describe('3. Dialect Quoting & Parameterized UPDATE Builder', () => {
    it('should quote identifiers correctly for SQLite, PostgreSQL, and MySQL', () => {
      // SQLite
      expect(quoteIdentifier('sqlite', 'users')).toBe('"users"')
      expect(quoteIdentifier('sqlite', 'users', 'main')).toBe('"main"."users"')
      expect(quoteIdentifier('sqlite', 'user"table')).toBe('"user""table"')

      // PostgreSQL
      expect(quoteIdentifier('postgres', 'users', 'public')).toBe('"public"."users"')

      // MySQL
      expect(quoteIdentifier('mysql', 'users')).toBe('`users`')
      expect(quoteIdentifier('mysql', 'users', 'shop')).toBe('`shop`.`users`')
      expect(quoteIdentifier('mysql', 'user`table')).toBe('`user``table`')
    })

    it('should generate correct placeholders ($1 for PG, ? for SQLite/MySQL)', () => {
      expect(makePlaceholder('postgres', 1)).toBe('$1')
      expect(makePlaceholder('postgres', 5)).toBe('$5')
      expect(makePlaceholder('sqlite', 1)).toBe('?')
      expect(makePlaceholder('mysql', 1)).toBe('?')
    })

    it('should generate safe parameterized UPDATE statements with optimistic locking', () => {
      // Single PK
      const singlePkUpdate = buildTestUpdateSql({
        driver: 'sqlite',
        table: 'customers',
        column: 'name',
        newValue: 'An Nguyen New',
        primaryKeys: { id: 1 },
        originalValue: 'Nguyễn Văn An'
      })

      expect(singlePkUpdate.sql).toBe(
        'UPDATE "customers" SET "name" = ? WHERE "id" = ? AND "name" = ?'
      )
      expect(singlePkUpdate.params).toEqual(['An Nguyen New', 1, 'Nguyễn Văn An'])

      // Composite PK with PostgreSQL syntax
      const compositePgUpdate = buildTestUpdateSql({
        driver: 'postgres',
        table: 'order_items',
        schema: 'public',
        column: 'quantity',
        newValue: 5,
        primaryKeys: { order_id: 1, item_id: 2 },
        originalValue: 1
      })

      expect(compositePgUpdate.sql).toBe(
        'UPDATE "public"."order_items" SET "quantity" = $1 WHERE "order_id" = $2 AND "item_id" = $3 AND "quantity" = $4'
      )
      expect(compositePgUpdate.params).toEqual([5, 1, 2, 1])

      // Optimistic lock with original value NULL
      const nullOriginalUpdate = buildTestUpdateSql({
        driver: 'sqlite',
        table: 'customers',
        column: 'phone',
        newValue: '+84999999999',
        primaryKeys: { id: 3 },
        originalValue: null
      })

      expect(nullOriginalUpdate.sql).toBe(
        'UPDATE "customers" SET "phone" = ? WHERE "id" = ? AND "phone" IS NULL'
      )
      expect(nullOriginalUpdate.params).toEqual(['+84999999999', 3])
    })

    it('should match PostgreSQL and MySQL mock fixtures specifications', () => {
      expect(POSTGRES_MOCK_FIXTURES.connectionSuccess.ok).toBe(true)
      expect(POSTGRES_MOCK_FIXTURES.sampleTableDetails.primaryKey).toEqual(['id'])
      expect(POSTGRES_MOCK_FIXTURES.expectedUpdateSql).toBe(
        'UPDATE "public"."users" SET "username" = $1 WHERE "id" = $2 AND "username" = $3'
      )

      expect(MYSQL_MOCK_FIXTURES.connectionSuccess.ok).toBe(true)
      expect(MYSQL_MOCK_FIXTURES.sampleTableDetails.primaryKey).toEqual(['order_id'])
      expect(MYSQL_MOCK_FIXTURES.expectedUpdateSql).toBe(
        'UPDATE `shop`.`orders` SET `order_status` = ? WHERE `order_id` = ? AND `order_status` = ?'
      )
    })
  })

  describe('4. Full In-Process SQLite Worker Bridge & Assertion Helpers', () => {
    beforeEach(() => {
      // Register all 10 IPC handlers backed by real SQLite database
      registerSqliteWorkerHandlers(context.runtime, context.sqlite!.db)
    })

    it('should list connections, retrieve schema objects, and get table details', async () => {
      const { runtime } = context

      // 1. connections.list
      const connections = await invokeRequest(runtime, 'connections.list', undefined)
      expect(connections.length).toBe(1)
      expect(connections[0].driver).toBe('sqlite')

      // 2. schema.listObjects
      const objects = await invokeRequest(runtime, 'schema.listObjects', {
        connectionId: connections[0].id
      })
      expect(objects.length).toBeGreaterThanOrEqual(8)
      expect(objects.some((o) => o.name === 'customers')).toBe(true)

      // 3. schema.tableDetails
      const details = await invokeRequest(runtime, 'schema.tableDetails', {
        connectionId: connections[0].id,
        table: 'customers'
      })
      expect(details.name).toBe('customers')
      expect(details.primaryKey).toEqual(['id'])
      expect(details.columns.length).toBe(7)
    })

    it('should fetch paginated table rows with sorting and verify browse result helper', async () => {
      const { runtime } = context

      const page1 = await invokeRequest(runtime, 'data.fetchPage', {
        connectionId: 'conn-sqlite-test',
        table: 'customers',
        page: 1,
        pageSize: 2,
        sortColumn: 'id',
        sortDirection: 'ASC'
      })

      assertBrowseResult(page1, {
        minRows: 2,
        page: 1,
        pageSize: 2,
        hasPrimaryKey: true,
        canEdit: true
      })

      expect(page1.rows[0].id).toBe(1)
      expect(page1.rows[1].id).toBe(2)
      expect(page1.totalRows).toBe(3)
    })

    it('should perform parameterized inline cell updates, emit events, and update the database', async () => {
      const { runtime, sqlite } = context
      let eventPayload: any = null

      runtime.client.on('data.cellUpdated', (p) => {
        eventPayload = p
      })

      const updateRes = await invokeRequest(runtime, 'data.updateCell', {
        connectionId: 'conn-sqlite-test',
        table: 'customers',
        primaryKeys: { id: 1 },
        column: 'phone',
        newValue: '+84988888888',
        originalValue: '+84901234567'
      })

      assertOk(updateRes)
      expect(updateRes.affectedRows).toBe(1)
      expect(updateRes.updatedRecord?.phone).toBe('+84988888888')

      // Verify row persisted in SQLite database
      const row = sqlite!.db.prepare('SELECT phone FROM customers WHERE id = 1').get() as any
      expect(row.phone).toBe('+84988888888')

      // Verify event broadcast
      expect(eventPayload).toEqual({
        table: 'customers',
        primaryKeys: { id: 1 },
        column: 'phone'
      })
    })

    it('should verify optimistic concurrency locking conflict detection', async () => {
      const { runtime } = context

      const { firstUpdate, conflictDetected } = await verifyOptimisticLocking(runtime, {
        connectionId: 'conn-sqlite-test',
        table: 'customers',
        primaryKeys: { id: 2 },
        column: 'email',
        originalValue: 'ken.sato@example.jp',
        concurrentValue: 'ken.sato.updated@example.jp',
        attemptedValue: 'ken.stale@example.jp'
      })

      expect(firstUpdate.ok).toBe(true)
      expect(firstUpdate.affectedRows).toBe(1)
      expect(conflictDetected).toBe(true)
    })

    it('should run SQL statements, measure query execution time, and assert results', async () => {
      const { runtime } = context

      // SELECT query
      const queryResult = await invokeRequest(runtime, 'query.run', {
        connectionId: 'conn-sqlite-test',
        queryId: 'q-perf-1',
        sql: 'SELECT c.name, p.name as product, oi.quantity FROM customers c JOIN orders o ON c.id = o.customer_id JOIN order_items oi ON o.id = oi.order_id JOIN products p ON oi.product_sku = p.sku'
      })

      assertQueryResult(queryResult, {
        minRows: 3,
        isSelect: true,
        truncated: false
      })

      expect(queryResult.columns.map((c) => c.name)).toEqual(['name', 'product', 'quantity'])

      // Performance measurement helper
      const perf = await measureQueryPerformance(async () => {
        return await invokeRequest(runtime, 'query.run', {
          connectionId: 'conn-sqlite-test',
          queryId: 'q-perf-2',
          sql: 'SELECT * FROM products'
        })
      }, 100) // Budget: 100ms

      expect(perf.result.rowCount).toBe(3)
      expect(perf.durationMs).toBeLessThan(100)

      // Non-SELECT (INSERT) query
      const insertResult = await invokeRequest(runtime, 'query.run', {
        connectionId: 'conn-sqlite-test',
        queryId: 'q-ins-1',
        sql: "INSERT INTO categories (name, slug) VALUES ('Gaming', 'gaming')"
      })

      expect(insertResult.isSelect).toBe(false)
      expect(insertResult.affectedRows).toBe(1)
    })

    it('should reject invalid SQL queries with action_failed code and descriptive message', async () => {
      const { runtime } = context

      await assertRejection(
        invokeRequest(runtime, 'query.run', {
          connectionId: 'conn-sqlite-test',
          queryId: 'q-err-1',
          sql: 'SELECT * FROM non_existent_table'
        }),
        'action_failed',
        'no such table'
      )
    })

    it('should reject inline cell update on read-only / no-PK table with not_permitted', async () => {
      const { runtime } = context

      await assertRejection(
        invokeRequest(runtime, 'data.updateCell', {
          connectionId: 'conn-sqlite-test',
          table: 'audit_logs', // Has no PK
          primaryKeys: {},
          column: 'actor',
          newValue: 'hacker'
        }),
        'not_permitted',
        'no primary key'
      )
    })
  })

  describe('5. Adversarial Audit Remediation & Defect Hardening', () => {
    beforeEach(() => {
      registerSqliteWorkerHandlers(context.runtime, context.sqlite!.db)
    })

    it('should reject pre-aborted signal without leaking activeControllers', async () => {
      const { runtime } = context
      const ac = new AbortController()
      ac.abort()

      expect(runtime.activeControllers.size).toBe(0)

      await assertRejection(
        runtime.client.request('connections.list', undefined, { signal: ac.signal }),
        'cancelled'
      )

      expect(runtime.activeControllers.size).toBe(0)
    })

    it('should cancel mid-flight requests immediately on signal abort without waiting for uncooperative handlers', async () => {
      const { runtime } = context
      const workerApi = runtime.getWorkerApi()

      // Register an uncooperative handler that sleeps 300ms without checking ctx.signal
      workerApi.panels.handle('connection.delete', async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
        return { ok: true }
      })

      const ac = new AbortController()
      const startTime = performance.now()

      // Trigger abort at 20ms
      setTimeout(() => ac.abort(), 20)

      await assertRejection(
        runtime.client.request('connection.delete', { id: 'c1' }, { signal: ac.signal }),
        'cancelled'
      )

      const elapsed = performance.now() - startTime
      expect(elapsed).toBeLessThan(200)
      expect(runtime.activeControllers.size).toBe(0)
    })

    it('should clean up signal listeners on successful request completion without listener leaks', async () => {
      const { runtime } = context
      const workerApi = runtime.getWorkerApi()

      workerApi.panels.handle('connection.delete', async () => ({ ok: true }))

      const ac = new AbortController()
      const initialActiveCount = runtime.activeControllers.size

      // Execute 20 consecutive requests using the same shared signal
      for (let i = 0; i < 20; i++) {
        const res = await runtime.client.request('connection.delete', { id: `c_${i}` }, { signal: ac.signal })
        expect(res).toEqual({ ok: true })
      }

      expect(runtime.activeControllers.size).toBe(initialActiveCount)
    })

    it('should support active query cancellation via query.cancel and track activeQueries lifecycle', async () => {
      const { runtime } = context
      const activeQueries = (runtime as any).activeQueries as Map<string, AbortController>
      expect(activeQueries).toBeDefined()
      expect(activeQueries.size).toBe(0)

      // 1. Cancel a running query mid-flight
      const queryPromise = runtime.client.request('query.run', {
        connectionId: 'conn-sqlite-test',
        queryId: 'q-cancel-test-1',
        sql: 'SELECT * FROM customers'
      })

      const cancelRes = await runtime.client.request('query.cancel', {
        queryId: 'q-cancel-test-1'
      })

      expect(cancelRes).toEqual({ ok: true })
      await assertRejection(queryPromise, 'cancelled')
      expect(activeQueries.size).toBe(0)

      // 2. query.cancel on non-existent queryId returns { ok: true }
      const cancelNonExistent = await runtime.client.request('query.cancel', {
        queryId: 'non-existent-query-id'
      })
      expect(cancelNonExistent).toEqual({ ok: true })

      // 3. query.cancel without queryId rejects with invalid_params
      await assertRejection(
        runtime.client.request('query.cancel', {} as any),
        'invalid_params'
      )
    })

    it('should handle idempotent and repeated query.cancel calls without state corruption', async () => {
      const { runtime } = context
      const activeQueries = (runtime as any).activeQueries as Map<string, AbortController>

      // Completed query cancellation
      const queryId = 'q-already-completed'
      const queryResult = await runtime.client.request('query.run', {
        connectionId: 'conn-sqlite-test',
        queryId,
        sql: 'SELECT id, name FROM customers LIMIT 1'
      })
      expect(queryResult.rowCount).toBe(1)
      expect(activeQueries.size).toBe(0)

      const cancelCompleted = await runtime.client.request('query.cancel', { queryId })
      expect(cancelCompleted).toEqual({ ok: true })
      expect(activeQueries.size).toBe(0)

      // Repeated cancellation calls
      const doubleCancelId = 'q-double-cancel'
      const p = runtime.client.request('query.run', {
        connectionId: 'conn-sqlite-test',
        queryId: doubleCancelId,
        sql: 'SELECT * FROM products'
      })

      const c1 = await runtime.client.request('query.cancel', { queryId: doubleCancelId })
      const c2 = await runtime.client.request('query.cancel', { queryId: doubleCancelId })
      const c3 = await runtime.client.request('query.cancel', { queryId: doubleCancelId })

      expect(c1).toEqual({ ok: true })
      expect(c2).toEqual({ ok: true })
      expect(c3).toEqual({ ok: true })

      await assertRejection(p, 'cancelled')
      expect(activeQueries.size).toBe(0)
    })

    it('should support selective cancellation with multiple concurrent queries', async () => {
      const { runtime } = context
      const activeQueries = (runtime as any).activeQueries as Map<string, AbortController>

      const q1 = runtime.client.request('query.run', {
        connectionId: 'conn-sqlite-test',
        queryId: 'multi-q1',
        sql: 'SELECT count(*) FROM customers'
      })

      const q2 = runtime.client.request('query.run', {
        connectionId: 'conn-sqlite-test',
        queryId: 'multi-q2',
        sql: 'SELECT count(*) FROM products'
      })

      const q3 = runtime.client.request('query.run', {
        connectionId: 'conn-sqlite-test',
        queryId: 'multi-q3',
        sql: 'SELECT count(*) FROM orders'
      })

      // Cancel only q2
      const cancelQ2 = await runtime.client.request('query.cancel', { queryId: 'multi-q2' })
      expect(cancelQ2).toEqual({ ok: true })

      await assertRejection(q2, 'cancelled')

      const [res1, res3] = await Promise.all([q1, q3])
      expect(res1.isSelect).toBe(true)
      expect(res3.isSelect).toBe(true)
      expect(activeQueries.size).toBe(0)
    })

    it('should handle direct AbortSignal cancellation on query.run and clean up activeQueries with zero unhandled rejections', async () => {
      const { runtime } = context
      const activeQueries = (runtime as any).activeQueries as Map<string, AbortController>

      const ac = new AbortController()
      const queryId = 'query-aborted-by-signal'

      const queryPromise = runtime.client.request(
        'query.run',
        {
          connectionId: 'conn-sqlite-test',
          queryId,
          sql: 'SELECT * FROM customers'
        },
        { signal: ac.signal }
      )

      ac.abort()

      await assertRejection(queryPromise, 'cancelled')
      expect(activeQueries.size).toBe(0)
      expect(runtime.activeControllers.size).toBe(0)
    })

    it('should clean up activeQueries completely when query has a syntax error', async () => {
      const { runtime } = context
      const activeQueries = (runtime as any).activeQueries as Map<string, AbortController>

      const queryId = 'query-with-syntax-error'

      await assertRejection(
        runtime.client.request('query.run', {
          connectionId: 'conn-sqlite-test',
          queryId,
          sql: 'MALFORMED SQL STATEMENT FROM TABLE'
        }),
        'action_failed'
      )

      expect(activeQueries.size).toBe(0)
      expect(runtime.activeControllers.size).toBe(0)
    })

    it('should survive rapid stress test of 50 sequential and overlapping query-cancel cycles', async () => {
      const { runtime } = context
      const activeQueries = (runtime as any).activeQueries as Map<string, AbortController>

      for (let i = 0; i < 50; i++) {
        const queryId = `stress-q-${i}`
        const p = runtime.client.request('query.run', {
          connectionId: 'conn-sqlite-test',
          queryId,
          sql: 'SELECT 1 AS val'
        })

        const cancel = runtime.client.request('query.cancel', { queryId })
        const [cRes] = await Promise.all([
          cancel,
          p.catch((err) => {
            expect(err.code).toBe('cancelled')
          })
        ])
        expect(cRes).toEqual({ ok: true })
        expect(activeQueries.size).toBe(0)
      }

      expect(runtime.activeControllers.size).toBe(0)
    })

    it('should validate primaryKeys in data.updateCell and reject empty primaryKeys or missing PK columns with invalid_params', async () => {
      const { runtime } = context

      // Empty primaryKeys object on a table that has primary keys
      await assertRejection(
        invokeRequest(runtime, 'data.updateCell', {
          connectionId: 'conn-sqlite-test',
          table: 'customers',
          primaryKeys: {},
          column: 'name',
          newValue: 'Nobody'
        }),
        'invalid_params',
        'Primary keys are required'
      )

      // Missing primary key column on composite PK table (order_items has PK: [order_id, item_id])
      await assertRejection(
        invokeRequest(runtime, 'data.updateCell', {
          connectionId: 'conn-sqlite-test',
          table: 'order_items',
          primaryKeys: { order_id: 1 }, // Missing item_id
          column: 'quantity',
          newValue: 5
        }),
        'invalid_params',
        'Missing primary key column'
      )
    })

    it('should throw Error in buildTestUpdateSql when primaryKeys is empty and originalValue is undefined', () => {
      // SQLite
      expect(() =>
        buildTestUpdateSql({
          driver: 'sqlite',
          table: 'customers',
          column: 'name',
          newValue: 'John Doe',
          primaryKeys: {}
        })
      ).toThrow('Cannot generate UPDATE without WHERE conditions')

      // PostgreSQL
      expect(() =>
        buildTestUpdateSql({
          driver: 'postgres',
          table: 'users',
          column: 'email',
          newValue: 'test@example.com',
          primaryKeys: {}
        })
      ).toThrow('Cannot generate UPDATE without WHERE conditions')

      // MySQL
      expect(() =>
        buildTestUpdateSql({
          driver: 'mysql',
          table: 'products',
          column: 'price',
          newValue: 99.99,
          primaryKeys: {}
        })
      ).toThrow('Cannot generate UPDATE without WHERE conditions')

      // Valid case with primary keys should still succeed
      const valid = buildTestUpdateSql({
        driver: 'sqlite',
        table: 'customers',
        column: 'name',
        newValue: 'Jane Doe',
        primaryKeys: { id: 1 }
      })
      expect(valid.sql).toContain('WHERE "id" = ?')
      expect(valid.params).toEqual(['Jane Doe', 1])
    })

    it('should support IS NULL, falsy values, and composite keys in buildTestUpdateSql', () => {
      // IS NULL when originalValue is null
      const resNull = buildTestUpdateSql({
        driver: 'sqlite',
        table: 'accounts',
        column: 'balance',
        newValue: 500,
        primaryKeys: {},
        originalValue: null
      })
      expect(resNull.sql).toBe('UPDATE "accounts" SET "balance" = ? WHERE "balance" IS NULL')
      expect(resNull.params).toEqual([500])

      // Falsy value (0, empty string, false)
      const resZero = buildTestUpdateSql({
        driver: 'sqlite',
        table: 'stats',
        column: 'counter',
        newValue: 1,
        primaryKeys: {},
        originalValue: 0
      })
      expect(resZero.sql).toBe('UPDATE "stats" SET "counter" = ? WHERE "counter" = ?')
      expect(resZero.params).toEqual([1, 0])

      // Composite primary keys
      const resComposite = buildTestUpdateSql({
        driver: 'postgres',
        table: 'order_items',
        column: 'quantity',
        newValue: 10,
        primaryKeys: { order_id: 'ord_1', item_id: 'itm_2' },
        originalValue: 5
      })
      expect(resComposite.sql).toBe(
        'UPDATE "order_items" SET "quantity" = $1 WHERE "order_id" = $2 AND "item_id" = $3 AND "quantity" = $4'
      )
      expect(resComposite.params).toEqual([10, 'ord_1', 'itm_2', 5])
    })
  })
})
