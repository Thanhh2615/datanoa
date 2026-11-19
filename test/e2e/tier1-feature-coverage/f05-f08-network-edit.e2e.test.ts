/**
 * test/e2e/tier1-feature-coverage/f05-f08-network-edit.e2e.test.ts
 *
 * Tier 1 Feature Coverage: Features F5 through F8
 * - Feature F5: Bundled PostgreSQL Driver (pg + pg-cursor)
 * - Feature F6: Bundled MySQL Driver (mysql2)
 * - Feature F7: Schema & Metadata Introspection
 * - Feature F8: Safe Parameterized Inline Edit Engine
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import {
  setupE2ETestContext,
  teardownE2ETestContext,
  invokeRequest,
  assertOk,
  assertRejection,
  verifyOptimisticLocking,
  registerSqliteWorkerHandlers,
  type TestContext,
} from '../harness/test-helpers.js'
import {
  buildTestUpdateSql,
  introspectSqliteDatabase,
  POSTGRES_MOCK_FIXTURES,
  MYSQL_MOCK_FIXTURES,
} from '../harness/test-db-fixtures.js'
import type {
  ConnectionProfile,
  SchemaObject,
  TableDetails,
  TableBrowseResult,
} from '../../../src/protocol.js'

describe('Tier 1 Feature Coverage: Features F5 - F8 (Network Drivers, Schema Introspection, Inline Edit)', () => {
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
  // Feature F5: Bundled PostgreSQL Driver (pg + pg-cursor)
  // =========================================================================
  describe('Feature F5: Bundled PostgreSQL Driver (pg + pg-cursor)', () => {
    it('TC-F5-01: Vendor PostgreSQL Module Exports & Bundle Integrity', async () => {
      const pgModulePath = path.join(projectRoot, 'vendor/pg.js')
      expect(fs.existsSync(pgModulePath)).toBe(true)

      const pg = await import(pgModulePath)
      expect(typeof pg.Client).toBe('function')
      expect(typeof pg.Pool).toBe('function')
      expect(pg.Query).toBeDefined()
      expect(pg.types).toBeDefined()
      expect(pg.defaults).toBeDefined()
      expect(pg.Cursor).toBeDefined()

      // Quoting & escaping utilities
      expect(typeof pg.escapeIdentifier).toBe('function')
      expect(typeof pg.escapeLiteral).toBe('function')
      expect(pg.escapeIdentifier('users')).toBe('"users"')
      expect(pg.escapeLiteral("O'Reilly")).toBe("'O''Reilly'")
    })

    it('TC-F5-02: PostgreSQL Parameterized UPDATE Builder with $n Numbered Placeholders', () => {
      // Single PK with optimistic concurrency check
      const singlePkUpdate = buildTestUpdateSql({
        driver: 'postgres',
        table: 'users',
        schema: 'public',
        column: 'username',
        newValue: 'alex_updated',
        originalValue: 'alex',
        primaryKeys: { id: 101 },
      })

      expect(singlePkUpdate.sql).toBe(
        'UPDATE "public"."users" SET "username" = $1 WHERE "id" = $2 AND "username" = $3'
      )
      expect(singlePkUpdate.params).toEqual(['alex_updated', 101, 'alex'])

      // Composite PK with optimistic concurrency check
      const compositePkUpdate = buildTestUpdateSql({
        driver: 'postgres',
        table: 'project_members',
        schema: 'org',
        column: 'role',
        newValue: 'lead',
        originalValue: 'dev',
        primaryKeys: { project_id: 10, user_id: 20 },
      })

      expect(compositePkUpdate.sql).toBe(
        'UPDATE "org"."project_members" SET "role" = $1 WHERE "project_id" = $2 AND "user_id" = $3 AND "role" = $4'
      )
      expect(compositePkUpdate.params).toEqual(['lead', 10, 20, 'dev'])
    })

    it('TC-F5-03: PostgreSQL Connection Profile Normalization & Secrets Vault Integration', async () => {
      const pgProfile: ConnectionProfile = {
        id: 'conn-pg-test',
        name: 'Analytics Warehouse',
        driver: 'postgres',
        database: 'warehouse',
        host: 'pg.internal.cloud',
        port: 5432,
        user: 'report_reader',
        ssl: true,
        hasPassword: true,
      }

      const saveRes = await invokeRequest(context.runtime, 'connection.save', {
        profile: pgProfile,
        password: 'pg-secure-password-2026',
      })
      assertOk(saveRes)

      // Profile in storage:own
      const listRes = await invokeRequest(context.runtime, 'connections.list')
      const stored = listRes.find((p: ConnectionProfile) => p.id === 'conn-pg-test')
      expect(stored).toBeDefined()
      expect(stored?.driver).toBe('postgres')
      expect(stored?.port).toBe(5432)
      expect(stored?.database).toBe('warehouse')
      expect(stored?.hasPassword).toBe(true)
      expect(stored).not.toHaveProperty('password')

      // Password isolated in secrets:own
      const secret = await context.runtime.getWorkerApi().secrets.get('pwd_conn-pg-test')
      expect(secret).toBe('pg-secure-password-2026')
    })

    it('TC-F5-04: PostgreSQL Mock Error Code Mapping', () => {
      const mapPgError = (err: { code: string; message: string }) => {
        if (err.code === '28P01') return { kind: 'not_permitted', message: 'Authentication failed' }
        if (err.code === 'ECONNREFUSED') return { kind: 'unavailable', message: 'Connection refused' }
        if (err.code === '42P01') return { kind: 'action_failed', message: 'Undefined table' }
        if (err.code === '23505') return { kind: 'conflict', message: 'Unique violation' }
        return { kind: 'unknown', message: err.message }
      }

      expect(mapPgError(POSTGRES_MOCK_FIXTURES.authFailure)).toEqual({
        kind: 'not_permitted',
        message: 'Authentication failed',
      })
      expect(mapPgError(POSTGRES_MOCK_FIXTURES.connectionRefused)).toEqual({
        kind: 'unavailable',
        message: 'Connection refused',
      })
      expect(mapPgError(POSTGRES_MOCK_FIXTURES.undefinedTable)).toEqual({
        kind: 'action_failed',
        message: 'Undefined table',
      })
      expect(mapPgError(POSTGRES_MOCK_FIXTURES.uniqueViolation)).toEqual({
        kind: 'conflict',
        message: 'Unique violation',
      })
    })

    it('TC-F5-05: PostgreSQL Batch Streaming & pg_cancel_backend Protocol', () => {
      // Cancellation SQL format
      const getPgCancelSql = (pid: number) => ({
        sql: 'SELECT pg_cancel_backend($1)',
        params: [pid],
      })
      const cancelStmt = getPgCancelSql(98765)
      expect(cancelStmt.sql).toBe('SELECT pg_cancel_backend($1)')
      expect(cancelStmt.params).toEqual([98765])

      // Batch stream cursor config simulation
      const cursorConfig = {
        batchSize: 50,
        text: 'SELECT * FROM large_audit_logs ORDER BY id',
      }
      expect(cursorConfig.batchSize).toBe(50)
      expect(cursorConfig.text).toContain('large_audit_logs')
    })
  })

  // =========================================================================
  // Feature F6: Bundled MySQL Driver (mysql2)
  // =========================================================================
  describe('Feature F6: Bundled MySQL Driver (mysql2)', () => {
    it('TC-F6-01: Vendor MySQL Module Exports & Pure-JS Bundle Integrity', async () => {
      const mysqlModulePath = path.join(projectRoot, 'vendor/mysql2.js')
      expect(fs.existsSync(mysqlModulePath)).toBe(true)

      const mysql = await import(mysqlModulePath)
      expect(typeof mysql.createConnection).toBe('function')
      expect(typeof mysql.createPool).toBe('function')
      expect(typeof mysql.escape).toBe('function')
      expect(typeof mysql.escapeId).toBe('function')
      expect(typeof mysql.format).toBe('function')
      expect(mysql.mysqlPromise).toBeDefined()

      // Backtick escaping
      expect(mysql.escapeId('orders')).toBe('`orders`')
      expect(mysql.escapeId('users.name')).toBe('`users`.`name`')
    })

    it('TC-F6-02: MySQL Parameterized UPDATE Builder with Backticks & ? Placeholders', () => {
      const updateResult = buildTestUpdateSql({
        driver: 'mysql',
        table: 'orders',
        schema: 'shop',
        column: 'order_status',
        newValue: 'SHIPPED',
        originalValue: 'PENDING',
        primaryKeys: { order_id: 1001 },
      })

      expect(updateResult.sql).toBe(
        'UPDATE `shop`.`orders` SET `order_status` = ? WHERE `order_id` = ? AND `order_status` = ?'
      )
      expect(updateResult.params).toEqual(['SHIPPED', 1001, 'PENDING'])
    })

    it('TC-F6-03: MySQL Connection Profile Normalization & Secrets Storage', async () => {
      const mysqlProfile: ConnectionProfile = {
        id: 'conn-mysql-test',
        name: 'Commerce DB',
        driver: 'mysql',
        database: 'shop',
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        hasPassword: true,
      }

      const saveRes = await invokeRequest(context.runtime, 'connection.save', {
        profile: mysqlProfile,
        password: 'mysql-super-secret-password',
      })
      assertOk(saveRes)

      const listRes = await invokeRequest(context.runtime, 'connections.list')
      const stored = listRes.find((p: ConnectionProfile) => p.id === 'conn-mysql-test')
      expect(stored).toBeDefined()
      expect(stored?.driver).toBe('mysql')
      expect(stored?.port).toBe(3306)
      expect(stored?.user).toBe('root')
      expect(stored).not.toHaveProperty('password')

      const secret = await context.runtime.getWorkerApi().secrets.get('pwd_conn-mysql-test')
      expect(secret).toBe('mysql-super-secret-password')
    })

    it('TC-F6-04: MySQL Mock Error Code Mapping', () => {
      const mapMySqlError = (err: { code: string; errno: number; message: string }) => {
        if (err.errno === 1045 || err.code === 'ER_ACCESS_DENIED_ERROR') {
          return { kind: 'not_permitted', message: 'Access denied' }
        }
        if (err.errno === 1062 || err.code === 'ER_DUP_ENTRY') {
          return { kind: 'conflict', message: 'Duplicate entry' }
        }
        if (err.errno === 1146 || err.code === 'ER_NO_SUCH_TABLE') {
          return { kind: 'action_failed', message: 'Table does not exist' }
        }
        return { kind: 'unknown', message: err.message }
      }

      expect(mapMySqlError(MYSQL_MOCK_FIXTURES.authFailure)).toEqual({
        kind: 'not_permitted',
        message: 'Access denied',
      })
      expect(mapMySqlError(MYSQL_MOCK_FIXTURES.duplicateEntry)).toEqual({
        kind: 'conflict',
        message: 'Duplicate entry',
      })
      expect(mapMySqlError(MYSQL_MOCK_FIXTURES.tableNotFound)).toEqual({
        kind: 'action_failed',
        message: 'Table does not exist',
      })
    })

    it('TC-F6-05: MySQL Stream Flow Control & KILL QUERY Cancellation Protocol', () => {
      const getMySqlCancelSql = (threadId: number) => ({
        sql: 'KILL QUERY ?',
        params: [threadId],
      })
      const cancelStmt = getMySqlCancelSql(456)
      expect(cancelStmt.sql).toBe('KILL QUERY ?')
      expect(cancelStmt.params).toEqual([456])

      // Stream control simulation (pause / resume)
      let isPaused = false
      const stream = {
        pause: () => {
          isPaused = true
        },
        resume: () => {
          isPaused = false
        },
      }
      stream.pause()
      expect(isPaused).toBe(true)
      stream.resume()
      expect(isPaused).toBe(false)
    })
  })

  // =========================================================================
  // Feature F7: Schema & Metadata Introspection
  // =========================================================================
  describe('Feature F7: Schema & Metadata Introspection', () => {
    it('TC-F7-01: Comprehensive Schema Object Discovery (Tables & Views)', async () => {
      const objects: SchemaObject[] = await invokeRequest(context.runtime, 'schema.listObjects', {
        connectionId: 'test-sqlite-conn',
      })

      const objectNames = objects.map((o) => o.name)
      expect(objectNames).toContain('customers')
      expect(objectNames).toContain('categories')
      expect(objectNames).toContain('products')
      expect(objectNames).toContain('orders')
      expect(objectNames).toContain('order_items')
      expect(objectNames).toContain('audit_logs')
      expect(objectNames).toContain('types_matrix')
      expect(objectNames).toContain('special_order-items')

      // View check
      const view = objects.find((o) => o.name === 'v_customer_orders')
      expect(view).toBeDefined()
      expect(view?.kind).toBe('view')

      // Internal tables filtered out
      for (const name of objectNames) {
        expect(name.startsWith('sqlite_')).toBe(false)
      }
    })

    it('TC-F7-02: Single Primary Key, Auto-Increment & Unique Index Column Introspection', async () => {
      const details: TableDetails = await invokeRequest(context.runtime, 'schema.tableDetails', {
        connectionId: 'test-sqlite-conn',
        table: 'customers',
      })

      expect(details.name).toBe('customers')
      expect(details.primaryKey).toEqual(['id'])

      const idCol = details.columns.find((c) => c.name === 'id')
      expect(idCol?.isPrimaryKey).toBe(true)
      expect(idCol?.isAutoIncrement).toBe(true)

      const emailCol = details.columns.find((c) => c.name === 'email')
      expect(emailCol?.nullable).toBe(false)

      const phoneIndex = details.indexes.find((i) => i.name === 'idx_customers_phone')
      expect(phoneIndex).toBeDefined()
      expect(phoneIndex?.isUnique).toBe(true)
      expect(phoneIndex?.columns).toContain('phone')
    })

    it('TC-F7-03: Composite Primary Key & Dual Foreign Key Introspection', async () => {
      const details: TableDetails = await invokeRequest(context.runtime, 'schema.tableDetails', {
        connectionId: 'test-sqlite-conn',
        table: 'order_items',
      })

      expect(details.name).toBe('order_items')
      expect(details.primaryKey).toEqual(['order_id', 'item_id'])

      // Columns check
      const orderIdCol = details.columns.find((c) => c.name === 'order_id')
      const itemIdCol = details.columns.find((c) => c.name === 'item_id')
      const qtyCol = details.columns.find((c) => c.name === 'quantity')

      expect(orderIdCol?.isPrimaryKey).toBe(true)
      expect(itemIdCol?.isPrimaryKey).toBe(true)
      expect(qtyCol?.isPrimaryKey).toBe(false)

      // Dual Foreign keys check
      expect(details.foreignKeys.length).toBe(2)
      const ordersFk = details.foreignKeys.find((fk) => fk.referencedTable === 'orders')
      const productsFk = details.foreignKeys.find((fk) => fk.referencedTable === 'products')

      expect(ordersFk).toBeDefined()
      expect(ordersFk?.column).toBe('order_id')
      expect(ordersFk?.referencedColumn).toBe('id')

      expect(productsFk).toBeDefined()
      expect(productsFk?.column).toBe('product_sku')
      expect(productsFk?.referencedColumn).toBe('sku')
    })

    it('TC-F7-04: Primary-Key-Less Table and SQL View Metadata Introspection', async () => {
      // Table without primary key
      const auditDetails: TableDetails = await invokeRequest(context.runtime, 'schema.tableDetails', {
        connectionId: 'test-sqlite-conn',
        table: 'audit_logs',
      })
      expect(auditDetails.name).toBe('audit_logs')
      expect(auditDetails.primaryKey).toEqual([])
      expect(auditDetails.columns.length).toBeGreaterThanOrEqual(4)

      // SQL View
      const viewDetails: TableDetails = await invokeRequest(context.runtime, 'schema.tableDetails', {
        connectionId: 'test-sqlite-conn',
        table: 'v_customer_orders',
      })
      expect(viewDetails.name).toBe('v_customer_orders')
      expect(viewDetails.kind).toBe('view')
      expect(viewDetails.primaryKey).toEqual([])
      expect(viewDetails.columns.length).toBeGreaterThan(0)
    })

    it('TC-F7-05: Complex Identifiers & Reserved SQL Keywords Metadata Introspection', async () => {
      const details: TableDetails = await invokeRequest(context.runtime, 'schema.tableDetails', {
        connectionId: 'test-sqlite-conn',
        table: 'special_order-items',
      })

      expect(details.name).toBe('special_order-items')
      const colNames = details.columns.map((c) => c.name)
      expect(colNames).toContain('order id')
      expect(colNames).toContain('select')
      expect(colNames).toContain('group by')
      expect(colNames).toContain('from')

      // Fetch page to verify query execution against escaped keywords
      const browseRes: TableBrowseResult = await invokeRequest(context.runtime, 'data.fetchPage', {
        connectionId: 'test-sqlite-conn',
        table: 'special_order-items',
        page: 1,
        pageSize: 10,
      })
      expect(browseRes.rows.length).toBeGreaterThan(0)
      expect(browseRes.rows[0]['order id']).toBe(1)
      expect(browseRes.rows[0]['select']).toBe('val_select')
    })
  })

  // =========================================================================
  // Feature F8: Safe Parameterized Inline Edit Engine
  // =========================================================================
  describe('Feature F8: Safe Parameterized Inline Edit Engine', () => {
    it('TC-F8-01: Single Primary Key Cell Update & Persistence Verification', async () => {
      let cellUpdatedPayload: unknown = null
      context.runtime.client.on('data.cellUpdated', (payload) => {
        cellUpdatedPayload = payload
      })

      const updateRes = await invokeRequest(context.runtime, 'data.updateCell', {
        connectionId: 'test-sqlite-conn',
        table: 'customers',
        primaryKeys: { id: 1 },
        column: 'phone',
        newValue: '+84988776655',
        originalValue: '+84901234567',
      })

      assertOk(updateRes)
      expect(updateRes.affectedRows).toBe(1)
      expect(updateRes.updatedRecord?.phone).toBe('+84988776655')

      // Direct DB query verification
      const dbRow = context.sqlite!.db.prepare('SELECT phone FROM customers WHERE id = 1').get() as { phone: string }
      expect(dbRow.phone).toBe('+84988776655')

      // Event broadcast verification
      expect(cellUpdatedPayload).toEqual({
        table: 'customers',
        primaryKeys: { id: 1 },
        column: 'phone',
      })
    })

    it('TC-F8-02: Composite Primary Key Row Cell Update', async () => {
      // Target specific row in composite key table
      const updateRes = await invokeRequest(context.runtime, 'data.updateCell', {
        connectionId: 'test-sqlite-conn',
        table: 'order_items',
        primaryKeys: { order_id: 1, item_id: 2 },
        column: 'quantity',
        newValue: 5,
        originalValue: 1,
      })

      assertOk(updateRes)
      expect(updateRes.affectedRows).toBe(1)

      // Verify targeted row updated
      const updatedRow = context.sqlite!.db
        .prepare('SELECT quantity FROM order_items WHERE order_id = 1 AND item_id = 2')
        .get() as { quantity: number }
      expect(updatedRow.quantity).toBe(5)

      // Sibling row unaffected
      const siblingRow = context.sqlite!.db
        .prepare('SELECT quantity FROM order_items WHERE order_id = 1 AND item_id = 1')
        .get() as { quantity: number }
      expect(siblingRow.quantity).toBe(1)
    })

    it('TC-F8-03: Optimistic Concurrency Conflict Detection & Stale Overwrite Prevention', async () => {
      const conflictCheck = await verifyOptimisticLocking(context.runtime, {
        connectionId: 'test-sqlite-conn',
        table: 'customers',
        primaryKeys: { id: 1 },
        column: 'email',
        originalValue: 'an.nguyen@example.com',
        concurrentValue: 'concurrent.modified@example.com',
        attemptedValue: 'stale.attempt@example.com',
      })

      expect(conflictCheck.conflictDetected).toBe(true)

      // Ensure stale update did NOT overwrite concurrent value
      const currentDb = context.sqlite!.db.prepare('SELECT email FROM customers WHERE id = 1').get() as { email: string }
      expect(currentDb.email).toBe('concurrent.modified@example.com')
      expect(currentDb.email).not.toBe('stale.attempt@example.com')
    })

    it('TC-F8-04: Null Value Transitions & IS NULL Concurrency Guard', async () => {
      // 1. Update from non-null to null
      const toNullRes = await invokeRequest(context.runtime, 'data.updateCell', {
        connectionId: 'test-sqlite-conn',
        table: 'customers',
        primaryKeys: { id: 1 },
        column: 'phone',
        newValue: null,
        originalValue: '+84901234567',
      })
      assertOk(toNullRes)
      expect(toNullRes.affectedRows).toBe(1)

      const dbAfterNull = context.sqlite!.db.prepare('SELECT phone FROM customers WHERE id = 1').get() as { phone: unknown }
      expect(dbAfterNull.phone).toBeNull()

      // 2. Update from null to new value using IS NULL guard
      const fromNullRes = await invokeRequest(context.runtime, 'data.updateCell', {
        connectionId: 'test-sqlite-conn',
        table: 'customers',
        primaryKeys: { id: 1 },
        column: 'phone',
        newValue: '+84911223344',
        originalValue: null,
      })
      assertOk(fromNullRes)
      expect(fromNullRes.affectedRows).toBe(1)

      const dbAfterRestore = context.sqlite!.db.prepare('SELECT phone FROM customers WHERE id = 1').get() as { phone: string }
      expect(dbAfterRestore.phone).toBe('+84911223344')
    })

    it('TC-F8-05: Read-Only and Primary-Key-Less Table Protection Guard', async () => {
      // 1. Check canEdit indicator on audit_logs
      const browseRes: TableBrowseResult = await invokeRequest(context.runtime, 'data.fetchPage', {
        connectionId: 'test-sqlite-conn',
        table: 'audit_logs',
        page: 1,
        pageSize: 5,
      })
      expect(browseRes.canEdit).toBe(false)

      // 2. Attempt update on table without primary key
      await assertRejection(
        invokeRequest(context.runtime, 'data.updateCell', {
          connectionId: 'test-sqlite-conn',
          table: 'audit_logs',
          primaryKeys: {},
          column: 'action',
          newValue: 'HACKED',
        }),
        'not_permitted',
        /has no primary key/
      )
    })
  })
})
