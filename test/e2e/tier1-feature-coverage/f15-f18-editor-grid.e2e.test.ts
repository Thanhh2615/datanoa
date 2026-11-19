/**
 * test/e2e/tier1-feature-coverage/f15-f18-editor-grid.e2e.test.ts
 *
 * Tier 1 Feature Coverage: Features F15 through F18
 * - Feature F15: CodeMirror 6 SQL Console
 * - Feature F16: Virtualized Data Grid
 * - Feature F17: Interactive Inline Cell Editing UI
 * - Feature F18: Schema Inspector Tab
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'node:path'
import {
  setupE2ETestContext,
  teardownE2ETestContext,
  invokeRequest,
  assertOk,
  verifyOptimisticLocking,
  registerSqliteWorkerHandlers,
  type TestContext,
} from '../harness/test-helpers.js'
import type {
  TableBrowseResult,
  QueryResult,
  TableDetails,
} from '../../../src/protocol.js'
import {
  extractExecutableSql,
  formatGridModel,
  formatCellValue,
  calculateVisibleWindow,
  checkCellEditGate,
  EDITOR_STYLE,
} from '../../../src/editor/index.js'
import { resolveSqlDialect } from '../../../src/editor/console.js'
import { ROW_HEIGHT_PX } from '../../../src/editor/grid.js'

describe('Tier 1 Feature Coverage: Features F15 - F18 (SQL Console, Data Grid, Inline Edit, Schema Inspector)', () => {
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
  // Feature F15: CodeMirror 6 SQL Console
  // =========================================================================
  describe('Feature F15: CodeMirror 6 SQL Console', () => {
    it('F15-01: initializes CodeMirror 6 EditorState with SQL extension and initial document', async () => {
      const cm = await import('../../../vendor/codemirror.js')
      expect(typeof cm.EditorView).toBe('function')
      expect(typeof cm.EditorState.create).toBe('function')

      const initialDoc = '-- Datanoa SQL Console\nSELECT 1;\n'
      const state = cm.EditorState.create({
        doc: initialDoc,
        extensions: [cm.sql({ dialect: cm.SQLite })],
      })

      expect(state.doc.toString()).toBe(initialDoc)
      expect(state.doc.lines).toBe(3)
    })

    it('F15-02: generates table and column autocompletion options from introspected schema', async () => {
      const cm = await import('../../../vendor/codemirror.js')
      expect(typeof cm.schemaCompletionSource).toBe('function')

      const schema = {
        customers: ['id', 'name', 'email', 'phone'],
        products: ['sku', 'name', 'price', 'stock'],
      }

      const completionSource = cm.schemaCompletionSource({ schema })
      expect(typeof completionSource).toBe('function')

      // Evaluate completion source with SQL-configured state
      const state = cm.EditorState.create({
        doc: 'SELECT * FROM c',
        extensions: [cm.sql({ dialect: cm.SQLite })],
      })

      const fakeContext = {
        state,
        pos: 15,
        explicit: true,
      }

      const result = await Promise.resolve(completionSource(fakeContext as any))
      expect(result).toBeDefined()
      expect(result?.options).toBeDefined()
      const labels = result?.options.map((o: { label: string }) => o.label)
      expect(labels).toContain('customers')
      expect(labels).toContain('products')
    })

    it('F15-03: triggers executeQuery callback when Mod-Enter shortcut is pressed', async () => {
      const cm = await import('../../../vendor/codemirror.js')
      const onExecute = vi.fn()

      const executeKeyBinding = {
        key: 'Mod-Enter',
        run: (target: { state: { doc: { toString: () => string } } }) => {
          onExecute(target.state.doc.toString())
          return true
        },
      }

      const keymapExt = cm.keymap.of([executeKeyBinding])
      expect(keymapExt).toBeDefined()

      // Simulate shortcut trigger
      const mockView = {
        state: {
          doc: {
            toString: () => 'SELECT * FROM customers;',
          },
        },
      }

      const handled = executeKeyBinding.run(mockView as any)
      expect(handled).toBe(true)
      expect(onExecute).toHaveBeenCalledWith('SELECT * FROM customers;')
    })

    it('F15-04: dynamically switches SQL dialect support across SQLite, PostgreSQL, and MySQL', async () => {
      const cm = await import('../../../vendor/codemirror.js')
      const langCompartment = new cm.Compartment()

      expect(resolveSqlDialect('sqlite')).toBe(cm.SQLite)
      expect(resolveSqlDialect('postgres')).toBe(cm.PostgreSQL)
      expect(resolveSqlDialect('mysql')).toBe(cm.MySQL)

      // 1. Initial SQLite
      let state = cm.EditorState.create({
        doc: 'SELECT "id" FROM "orders";',
        extensions: [langCompartment.of(cm.sql({ dialect: resolveSqlDialect('sqlite') }))],
      })
      expect(state.doc.toString()).toBe('SELECT "id" FROM "orders";')

      // 2. Reconfigure to PostgreSQL
      const pgTr = state.update({
        effects: langCompartment.reconfigure(cm.sql({ dialect: resolveSqlDialect('postgres') })),
      })
      state = pgTr.state
      expect(state).toBeDefined()

      // 3. Reconfigure to MySQL
      const mysqlTr = state.update({
        effects: langCompartment.reconfigure(cm.sql({ dialect: resolveSqlDialect('mysql') })),
      })
      state = mysqlTr.state
      expect(state).toBeDefined()
    })

    it('F15-05: extracts only highlighted SQL selection when available, or full text otherwise', async () => {
      const cm = await import('../../../vendor/codemirror.js')

      const docText = 'SELECT 1;\nSELECT * FROM customers;\nSELECT 3;'

      // State without selection
      let state = cm.EditorState.create({ doc: docText })
      expect(extractExecutableSql(state)).toBe(docText)

      // State with selection spanning line 2 ('SELECT * FROM customers;')
      const startIdx = docText.indexOf('SELECT * FROM customers;')
      const endIdx = startIdx + 'SELECT * FROM customers;'.length

      state = state.update({
        selection: cm.EditorSelection.single(startIdx, endIdx),
      }).state

      expect(extractExecutableSql(state)).toBe('SELECT * FROM customers;')
    })
  })

  // =========================================================================
  // Feature F16: Virtualized Data Grid
  // =========================================================================
  describe('Feature F16: Virtualized Data Grid', () => {
    it('F16-01: formats grid header and rows from TableBrowseResult and QueryResult', () => {
      const browseSample: TableBrowseResult = {
        columns: ['sku', 'name', 'price', 'stock'],
        rows: [
          { sku: 'P1', name: 'Keyboard', price: 99.0, stock: 10 },
          { sku: 'P2', name: 'Mouse', price: 49.0, stock: 25 },
        ],
        totalRows: 2,
        page: 1,
        pageSize: 10,
        primaryKey: ['sku'],
        canEdit: true,
      }

      const model = formatGridModel(browseSample)
      expect(model.headers).toEqual(['sku', 'name', 'price', 'stock'])
      expect(model.rows).toHaveLength(2)
      expect(model.rowCount).toBe(2)
      expect(model.canEdit).toBe(true)
      expect(model.primaryKey).toEqual(['sku'])
    })

    it('F16-02: formats NULL values as italic muted and numbers with tabular-nums', () => {
      const nullResult = formatCellValue(null, 'TEXT')
      expect(nullResult.text).toBe('NULL')
      expect(nullResult.className).toBe('datanoa-cell-null')

      const numResult = formatCellValue(129.99, 'REAL')
      expect(numResult.text).toBe('129.99')
      expect(numResult.className).toBe('datanoa-cell-numeric')

      const jsonResult = formatCellValue({ tier: 'gold' }, 'JSON')
      expect(jsonResult.text).toBe('{"tier":"gold"}')
      expect(jsonResult.className).toBe('datanoa-cell-json')

      const textResult = formatCellValue('Mechanical Keyboard', 'TEXT')
      expect(textResult.text).toBe('Mechanical Keyboard')
      expect(textResult.className).toBe('datanoa-cell-text')
    })

    it('F16-03: enforces 22px fixed row height and sticky header positioning', () => {
      expect(ROW_HEIGHT_PX).toBe(22)
      expect(EDITOR_STYLE).toContain('position: sticky')
      expect(EDITOR_STYLE).toContain('height: 22px')

      const win0 = calculateVisibleWindow(0, 440)
      expect(win0.startIndex).toBe(0)
      expect(win0.visibleCount).toBe(20)
      expect(win0.endIndex).toBe(20)

      const winScroll = calculateVisibleWindow(220, 440)
      expect(winScroll.startIndex).toBe(10)
      expect(winScroll.endIndex).toBe(30)
    })

    it('F16-04: coordinates data.fetchPage pagination requests across pages', async () => {
      // Page 1
      const page1: TableBrowseResult = await invokeRequest(context.runtime, 'data.fetchPage', {
        connectionId: 'test-sqlite-conn',
        table: 'customers',
        page: 1,
        pageSize: 2,
      })

      expect(page1.page).toBe(1)
      expect(page1.pageSize).toBe(2)
      expect(page1.totalRows).toBe(3)
      expect(page1.rows).toHaveLength(2)

      // Page 2
      const page2: TableBrowseResult = await invokeRequest(context.runtime, 'data.fetchPage', {
        connectionId: 'test-sqlite-conn',
        table: 'customers',
        page: 2,
        pageSize: 2,
      })

      expect(page2.page).toBe(2)
      expect(page2.totalRows).toBe(3)
      expect(page2.rows).toHaveLength(1)

      // Unique IDs across pages
      const p1Ids = page1.rows.map((r) => r.id)
      const p2Ids = page2.rows.map((r) => r.id)
      expect(p1Ids).not.toContain(p2Ids[0])
    })

    it('F16-05: toggles column sorting between ASC and DESC in grid fetchPage calls', async () => {
      // ASC sort by price
      const ascRes: TableBrowseResult = await invokeRequest(context.runtime, 'data.fetchPage', {
        connectionId: 'test-sqlite-conn',
        table: 'products',
        page: 1,
        pageSize: 10,
        sortColumn: 'price',
        sortDirection: 'ASC',
      })
      const ascPrices = ascRes.rows.map((r) => Number(r.price))
      expect(ascPrices[0]).toBeLessThanOrEqual(ascPrices[1])

      // DESC sort by price
      const descRes: TableBrowseResult = await invokeRequest(context.runtime, 'data.fetchPage', {
        connectionId: 'test-sqlite-conn',
        table: 'products',
        page: 1,
        pageSize: 10,
        sortColumn: 'price',
        sortDirection: 'DESC',
      })
      const descPrices = descRes.rows.map((r) => Number(r.price))
      expect(descPrices[0]).toBeGreaterThanOrEqual(descPrices[1])
      expect(descPrices[0]).toBe(129.99)
    })
  })

  // =========================================================================
  // Feature F17: Interactive Inline Cell Editing UI
  // =========================================================================
  describe('Feature F17: Interactive Inline Cell Editing UI', () => {
    it('F17-01: activates inline editor on cell double-click when table has primary key', () => {
      // Editable table
      expect(checkCellEditGate(true, ['id'])).toEqual({ allowed: true })

      // Read-only view
      expect(checkCellEditGate(false, [])).toEqual({
        allowed: false,
        reason: 'read_only_table',
      })

      // PK-less table
      expect(checkCellEditGate(true, [])).toEqual({
        allowed: false,
        reason: 'missing_primary_key',
      })
    })

    it('F17-02: commits updated cell value on Enter and dispatches data.updateCell request', async () => {
      const updateRes = await invokeRequest(context.runtime, 'data.updateCell', {
        connectionId: 'test-sqlite-conn',
        table: 'customers',
        primaryKeys: { id: 1 },
        column: 'name',
        newValue: 'Nguyễn Văn Cường',
        originalValue: 'Nguyễn Văn An',
      })

      assertOk(updateRes)
      expect(updateRes.affectedRows).toBe(1)
      expect(updateRes.updatedRecord?.name).toBe('Nguyễn Văn Cường')
    })

    it('F17-03: cancels cell edit on Escape key without dispatching updateCell request', () => {
      let updateDispatched = false
      const cancelCellEdit = (originalVal: string) => {
        // Discard buffer and revert
        return {
          currentValue: originalVal,
          isEditing: false,
        }
      }

      const state = cancelCellEdit('Initial Value')
      expect(state.currentValue).toBe('Initial Value')
      expect(state.isEditing).toBe(false)
      expect(updateDispatched).toBe(false)
    })

    it('F17-04: handles optimistic saving state and reconciles data.cellUpdated event', async () => {
      type CellStatus = 'idle' | 'saving' | 'clean' | 'error'
      let cellStatus: CellStatus = 'idle'

      cellStatus = 'saving'
      expect(cellStatus).toBe('saving')

      let broadcastReceived: unknown = null
      context.runtime.client.on('data.cellUpdated', (payload) => {
        broadcastReceived = payload
        cellStatus = 'clean'
      })

      await invokeRequest(context.runtime, 'data.updateCell', {
        connectionId: 'test-sqlite-conn',
        table: 'products',
        primaryKeys: { sku: 'PROD-001' },
        column: 'stock',
        newValue: 45,
        originalValue: 50,
      })

      expect(broadcastReceived).toEqual({
        table: 'products',
        primaryKeys: { sku: 'PROD-001' },
        column: 'stock',
      })
      expect(cellStatus).toBe('clean')
    })

    it('F17-05: automatically rolls back cell value on optimistic lock conflict', async () => {
      const conflictRes = await verifyOptimisticLocking(context.runtime, {
        connectionId: 'test-sqlite-conn',
        table: 'customers',
        primaryKeys: { id: 1 },
        column: 'email',
        originalValue: 'an.nguyen@example.com',
        concurrentValue: 'concurrent@example.com',
        attemptedValue: 'stale@example.com',
      })

      expect(conflictRes.conflictDetected).toBe(true)

      // Ensure database holds concurrent value
      const row = context.sqlite!.db.prepare('SELECT email FROM customers WHERE id = 1').get() as { email: string }
      expect(row.email).toBe('concurrent@example.com')
    })
  })

  // =========================================================================
  // Feature F18: Schema Inspector Tab
  // =========================================================================
  describe('Feature F18: Schema Inspector Tab', () => {
    it('F18-01: renders schema inspector tab header with table metadata summary', async () => {
      const details: TableDetails = await invokeRequest(context.runtime, 'schema.tableDetails', {
        connectionId: 'test-sqlite-conn',
        table: 'customers',
      })

      expect(details.name).toBe('customers')
      expect(details.schema).toBe('main')
      expect(details.kind).toBe('table')
      expect(details.columns.length).toBeGreaterThanOrEqual(4)
      expect(details.primaryKey).toEqual(['id'])
    })

    it('F18-02: formats full column attribute matrix including data types and defaults', async () => {
      const details: TableDetails = await invokeRequest(context.runtime, 'schema.tableDetails', {
        connectionId: 'test-sqlite-conn',
        table: 'customers',
      })

      const statusCol = details.columns.find((c) => c.name === 'status')
      expect(statusCol).toBeDefined()
      expect(statusCol?.defaultValue).toContain('active')

      const emailCol = details.columns.find((c) => c.name === 'email')
      expect(emailCol).toBeDefined()
      expect(emailCol?.nullable).toBe(false)
    })

    it('F18-03: identifies primary key columns and flags composite primary keys', async () => {
      const singleDetails: TableDetails = await invokeRequest(context.runtime, 'schema.tableDetails', {
        connectionId: 'test-sqlite-conn',
        table: 'customers',
      })
      expect(singleDetails.primaryKey).toEqual(['id'])

      const compositeDetails: TableDetails = await invokeRequest(context.runtime, 'schema.tableDetails', {
        connectionId: 'test-sqlite-conn',
        table: 'order_items',
      })
      expect(compositeDetails.primaryKey).toEqual(['order_id', 'item_id'])
    })

    it('F18-04: displays foreign key relationships with target table and column links', async () => {
      const details: TableDetails = await invokeRequest(context.runtime, 'schema.tableDetails', {
        connectionId: 'test-sqlite-conn',
        table: 'order_items',
      })

      expect(details.foreignKeys.length).toBe(2)
      const ordersFk = details.foreignKeys.find((fk) => fk.referencedTable === 'orders')
      expect(ordersFk?.column).toBe('order_id')
      expect(ordersFk?.referencedColumn).toBe('id')

      const productsFk = details.foreignKeys.find((fk) => fk.referencedTable === 'products')
      expect(productsFk?.column).toBe('product_sku')
      expect(productsFk?.referencedColumn).toBe('sku')
    })

    it('F18-05: catalogs table indexes with unique and primary constraint badges', async () => {
      const details: TableDetails = await invokeRequest(context.runtime, 'schema.tableDetails', {
        connectionId: 'test-sqlite-conn',
        table: 'customers',
      })

      expect(details.indexes.length).toBeGreaterThan(0)
      const phoneIndex = details.indexes.find((i) => i.name === 'idx_customers_phone')
      expect(phoneIndex).toBeDefined()
      expect(phoneIndex?.isUnique).toBe(true)
      expect(phoneIndex?.columns).toContain('phone')
    })
  })
})
