/**
 * test/e2e/wave11-ux-selection-utilities.e2e.test.ts
 *
 * Wave 11 Comprehensive Integration & Regression E2E Gate:
 * 1. Studio async loading states, elapsed timers & anti-double-submit guards (deferred-promise RPCs)
 * 2. Multi-row / multi-column / rectangular range selection, keyboard/drag/delegation,
 *    bulk operations, live Status Bar aggregates, pinned/hidden columns, Find & Highlight,
 *    Quick Filter, and Foreign Key Jump-to-Row
 * 3. Studio Tier A utilities (Format SQL, Value Inspector NULL badge + JSON validator/format/minify,
 *    + New Table modal, Truncate/Drop typed confirm modal + readOnly guard, Command Palette,
 *    Keyboard Shortcuts modal, Light-mode contrast & :focus-visible)
 * 4. Side Panel (src/panel/panel.html) Wave 11 contract & static Gate A (zero TS2304/TS2552)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type {
  ConnectionProfile,
  QueryResult,
  SchemaObject,
  TableBrowseResult,
  TableDetails,
} from '../../src/protocol.js'
import { EDITOR_STYLE } from '../../src/editor/theme.js'
import { DatanoaStudioEditor } from '../../src/editor/index.js'
import { VirtualDataGrid } from '../../src/editor/grid.js'
import { SchemaInspectorView } from '../../src/editor/schema-inspector.js'
import {
  FakeDomHarness,
  FakeElement,
  FakeEvent,
  FakeHTMLButtonElement,
  FakeHTMLInputElement,
  FakeHTMLSelectElement,
  FakeHTMLTextAreaElement,
  flushMicrotasks,
} from './harness/fake-dom.js'

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..')

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  let reject: (err: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface RecordedRpcCall {
  name: string
  input: unknown
}

function createSampleBrowseData(overrides?: Partial<TableBrowseResult>): TableBrowseResult {
  return {
    columns: [
      {
        name: 'id',
        type: 'INTEGER',
        nativeType: 'INTEGER',
        nullable: false,
        defaultValue: null,
        isPrimaryKey: true,
        isAutoIncrement: true,
      },
      {
        name: 'name',
        type: 'TEXT',
        nativeType: 'TEXT',
        nullable: false,
        defaultValue: null,
        isPrimaryKey: false,
        isAutoIncrement: false,
      },
      {
        name: 'amount',
        type: 'REAL',
        nativeType: 'REAL',
        nullable: true,
        defaultValue: null,
        isPrimaryKey: false,
        isAutoIncrement: false,
      },
      {
        name: 'org_id',
        type: 'INTEGER',
        nativeType: 'INTEGER',
        nullable: true,
        defaultValue: null,
        isPrimaryKey: false,
        isAutoIncrement: false,
      },
    ],
    rows: [
      { id: 1, name: 'Alice', amount: 10, org_id: 100 },
      { id: 2, name: 'Bob', amount: 20, org_id: 101 },
      { id: 3, name: 'Carol', amount: null, org_id: 100 },
    ],
    totalRows: 3,
    page: 1,
    pageSize: 100,
    primaryKey: ['id'],
    canEdit: true,
    ...overrides,
  }
}

function createSampleTableDetails(name = 'users'): TableDetails {
  return {
    name,
    kind: 'table',
    columns: [
      {
        name: 'id',
        type: 'INTEGER',
        nativeType: 'INTEGER',
        nullable: false,
        defaultValue: null,
        isPrimaryKey: true,
        isAutoIncrement: true,
      },
      {
        name: 'name',
        type: 'TEXT',
        nativeType: 'TEXT',
        nullable: false,
        defaultValue: null,
        isPrimaryKey: false,
        isAutoIncrement: false,
      },
      {
        name: 'org_id',
        type: 'INTEGER',
        nativeType: 'INTEGER',
        nullable: true,
        defaultValue: null,
        isPrimaryKey: false,
        isAutoIncrement: false,
      },
    ],
    primaryKey: ['id'],
    indexes: [],
    foreignKeys: [
      {
        constraintName: 'fk_users_org',
        column: 'org_id',
        referencedTable: 'orgs',
        referencedColumn: 'id',
      },
    ],
    ddl: `CREATE TABLE "${name}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL, "org_id" INTEGER);`,
  }
}

function installMockOrcaOnWindow(
  dom: FakeDomHarness,
  handler: (name: string, input?: unknown) => Promise<unknown> | unknown
): RecordedRpcCall[] {
  const calls: RecordedRpcCall[] = []
  const storage = new Map<string, unknown>()
  dom.window.localStorage = {
    getItem: (key: string) => {
      const val = storage.get(`ls:${key}`)
      return typeof val === 'string' ? val : null
    },
    setItem: (key: string, value: string) => {
      storage.set(`ls:${key}`, value)
    },
    removeItem: (key: string) => {
      storage.delete(`ls:${key}`)
    },
    clear: () => {
      storage.clear()
    },
  }
  dom.window.orca = {
    on: () => ({ dispose: () => {} }),
    storage: {
      get: async (key: string) => storage.get(key) ?? null,
      set: async (key: string, val: unknown) => {
        storage.set(key, val)
      },
    },
    host: {
      has: () => false,
      call: async () => null,
    },
    plugin: {
      on: () => ({ dispose: () => {} }),
      request: async (name: string, input?: unknown) => {
        calls.push({ name, input })
        return await handler(name, input)
      },
    },
  }
  return calls
}

function findButtonByText(root: FakeElement, text: string): FakeHTMLButtonElement | null {
  const buttons = root.querySelectorAll<FakeHTMLButtonElement>('button')
  for (const btn of buttons) {
    if (btn.textContent.trim() === text) return btn
  }
  return null
}

function findButtonContaining(root: FakeElement, substr: string): FakeHTMLButtonElement | null {
  const buttons = root.querySelectorAll<FakeHTMLButtonElement>('button')
  for (const btn of buttons) {
    if (btn.textContent.includes(substr)) return btn
  }
  return null
}

describe('Wave 11 — Loading UX, Multi-Selection, Bulk Ops & Studio/Panel Utilities', () => {
  const activeDomHarnesses: FakeDomHarness[] = []
  const activeEditors: DatanoaStudioEditor[] = []
  const activeGrids: VirtualDataGrid[] = []
  const activeInspectors: SchemaInspectorView[] = []

  beforeEach(() => {
    const dom = new FakeDomHarness()
    dom.install()
    activeDomHarnesses.push(dom)
  })

  afterEach(() => {
    while (activeEditors.length > 0) {
      activeEditors.pop()?.destroy()
    }
    while (activeGrids.length > 0) {
      activeGrids.pop()?.destroy()
    }
    while (activeInspectors.length > 0) {
      activeInspectors.pop()?.destroy()
    }
    while (activeDomHarnesses.length > 0) {
      activeDomHarnesses.pop()?.uninstall()
    }
    vi.restoreAllMocks()
  })

  // ==========================================================================
  // 1. Studio Async Loading States, Timers & Anti-Double-Submit Guards
  // ==========================================================================
  describe('1. Studio Async Loading States & Anti-Double-Submit Guards', () => {
    it('shows spinner & disables controls during executeSql, blocks re-entrant runs, and Execute All runs full document', async () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const conn: ConnectionProfile = {
        id: 'conn-1',
        name: 'Local SQLite',
        driver: 'sqlite',
        filePath: ':memory:',
      }
      const objects: SchemaObject[] = [{ name: 'users', kind: 'table' }]
      const queryDeferreds: Array<Deferred<QueryResult>> = []

      const calls = installMockOrcaOnWindow(dom, (name) => {
        if (name === 'connections.list') return [conn]
        if (name === 'schema.listObjects') return objects
        if (name === 'data.fetchPage') return createSampleBrowseData()
        if (name === 'schema.tableDetails') return createSampleTableDetails('users')
        if (name === 'query.run') {
          const def = createDeferred<QueryResult>()
          queryDeferreds.push(def)
          return def.promise
        }
        return null
      })

      const editor = new DatanoaStudioEditor()
      activeEditors.push(editor)
      await flushMicrotasks(12)

      const consoleCtrl = editor.getSqlConsole()
      expect(consoleCtrl).not.toBeNull()
      consoleCtrl?.setText('SELECT 1 AS a;\nSELECT 2 AS b;')

      const runBtn = findButtonByText(dom.body, 'Execute (Ctrl+Enter)')
      const runAllBtn = findButtonByText(dom.body, 'Execute All')
      const explainBtn = findButtonByText(dom.body, 'Explain')
      const cancelBtn = findButtonByText(dom.body, 'Cancel')
      expect(runBtn).not.toBeNull()
      expect(runAllBtn).not.toBeNull()
      expect(explainBtn).not.toBeNull()
      expect(cancelBtn).not.toBeNull()

      // Start Execute (caret statement only)
      const p1 = editor.executeSql(false)
      await flushMicrotasks(4)

      // Loading state active while RPC is pending
      expect(runBtn?.disabled).toBe(true)
      expect(runAllBtn?.disabled).toBe(true)
      expect(explainBtn?.disabled).toBe(true)
      expect(runBtn?.classList.contains('is-loading')).toBe(true)
      expect(runBtn?.querySelector('.datanoa-spinner')).not.toBeNull()
      expect(cancelBtn?.style.display).toBe('inline-flex')

      // Re-entrant call while in-flight must be ignored
      await editor.executeSql(false)
      const queryRunCalls1 = calls.filter((c) => c.name === 'query.run')
      expect(queryRunCalls1).toHaveLength(1)
      expect((queryRunCalls1[0].input as { sql: string }).sql).toBe('SELECT 1 AS a')

      // Resolve first query
      queryDeferreds[0].resolve({
        columns: [{ name: 'a' }],
        rows: [{ a: 1 }],
        rowCount: 1,
        executionTimeMs: 4,
        truncated: false,
        isSelect: true,
      })
      await p1
      await flushMicrotasks(4)

      expect(runBtn?.disabled).toBe(false)
      expect(runBtn?.classList.contains('is-loading')).toBe(false)
      expect(cancelBtn?.style.display).toBe('none')

      // Execute All (executeSql(true)) must run the FULL multi-statement document
      const pAll = editor.executeSql(true)
      await flushMicrotasks(4)

      expect(runAllBtn?.classList.contains('is-loading')).toBe(true)
      const queryRunCalls2 = calls.filter((c) => c.name === 'query.run')
      expect(queryRunCalls2).toHaveLength(2)
      expect((queryRunCalls2[1].input as { sql: string }).sql).toBe(
        'SELECT 1 AS a;\nSELECT 2 AS b;'
      )

      queryDeferreds[1].resolve({
        columns: [{ name: 'b' }],
        rows: [{ b: 2 }],
        rowCount: 1,
        executionTimeMs: 6,
        truncated: false,
        isSelect: true,
      })
      await pAll
      await flushMicrotasks(4)

      expect(runAllBtn?.classList.contains('is-loading')).toBe(false)
      expect(runAllBtn?.disabled).toBe(false)
    })

    it('sends queryId in query.explain, supports cancellation via Cancel button, and prevents stale finally reset', async () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const conn: ConnectionProfile = {
        id: 'conn-1',
        name: 'Local SQLite',
        driver: 'sqlite',
        filePath: ':memory:',
      }
      const explainDeferred = createDeferred<QueryResult>()
      const cancelDeferred = createDeferred<{ ok: boolean }>()

      const calls = installMockOrcaOnWindow(dom, (name) => {
        if (name === 'connections.list') return [conn]
        if (name === 'schema.listObjects') return [{ name: 'users', kind: 'table' }]
        if (name === 'data.fetchPage') return createSampleBrowseData()
        if (name === 'schema.tableDetails') return createSampleTableDetails('users')
        if (name === 'query.explain') return explainDeferred.promise
        if (name === 'query.cancel') return cancelDeferred.promise
        return null
      })

      const editor = new DatanoaStudioEditor()
      activeEditors.push(editor)
      await flushMicrotasks(12)

      editor.getSqlConsole()?.setText('SELECT * FROM users;')
      const explainBtn = findButtonByText(dom.body, 'Explain')
      const cancelBtn = findButtonByText(dom.body, 'Cancel')
      expect(explainBtn).not.toBeNull()
      expect(cancelBtn).not.toBeNull()

      const explainPromise = editor.explainSql()
      await flushMicrotasks(4)

      expect(explainBtn?.classList.contains('is-loading')).toBe(true)
      expect(cancelBtn?.style.display).toBe('inline-flex')

      const explainCall = calls.find((c) => c.name === 'query.explain')
      expect(explainCall).toBeDefined()
      const sentQueryId = (explainCall?.input as { queryId?: string }).queryId
      expect(typeof sentQueryId).toBe('string')
      expect(sentQueryId?.startsWith('explain_')).toBe(true)

      // Click Cancel -> dispatches query.cancel with the same queryId
      cancelBtn?.click()
      await flushMicrotasks(4)
      expect(cancelBtn?.classList.contains('is-loading')).toBe(true)

      const cancelCall = calls.find((c) => c.name === 'query.cancel')
      expect(cancelCall).toBeDefined()
      expect((cancelCall?.input as { queryId: string }).queryId).toBe(sentQueryId)

      cancelDeferred.resolve({ ok: true })
      await flushMicrotasks(4)

      // Start a fresh query before the cancelled EXPLAIN promise settles
      const run2Deferred = createDeferred<QueryResult>()
      const origReq = (dom.window.orca as { plugin: { request: (n: string, i?: unknown) => Promise<unknown> } }).plugin.request
      ;(dom.window.orca as { plugin: { request: (n: string, i?: unknown) => Promise<unknown> } }).plugin.request =
        async (n: string, i?: unknown) => {
          if (n === 'query.run') return run2Deferred.promise
          return origReq(n, i)
        }

      const runBtn = findButtonByText(dom.body, 'Execute (Ctrl+Enter)')
      const run2Promise = editor.executeSql(false)
      await flushMicrotasks(4)
      expect(runBtn?.classList.contains('is-loading')).toBe(true)

      // Late rejection from cancelled EXPLAIN must NOT reset Query #2's loading state
      explainDeferred.reject(new Error('Query cancelled'))
      await explainPromise
      await flushMicrotasks(4)
      expect(runBtn?.classList.contains('is-loading')).toBe(true)
      expect(runBtn?.disabled).toBe(true)

      // Resolve Query #2 cleanly
      run2Deferred.resolve({
        columns: [{ name: 'id' }],
        rows: [{ id: 1 }],
        rowCount: 1,
        executionTimeMs: 3,
        truncated: false,
        isSelect: true,
      })
      await run2Promise
      await flushMicrotasks(4)

      expect(runBtn?.classList.contains('is-loading')).toBe(false)
      expect(runBtn?.disabled).toBe(false)
      expect(explainBtn?.classList.contains('is-loading')).toBe(false)
      expect(explainBtn?.disabled).toBe(false)
      expect(cancelBtn?.style.display).toBe('none')
    })

    it('guards submitStagedChanges against double-click, locks grid interaction, and shows spinner', async () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const conn: ConnectionProfile = {
        id: 'conn-1',
        name: 'Local SQLite',
        driver: 'sqlite',
        filePath: ':memory:',
      }
      const applyDeferred = createDeferred<{
        ok: boolean
        inserted: number
        updated: number
        deleted: number
        statements: string[]
      }>()

      const calls = installMockOrcaOnWindow(dom, (name) => {
        if (name === 'connections.list') return [conn]
        if (name === 'schema.listObjects') return [{ name: 'users', kind: 'table' }]
        if (name === 'data.fetchPage') return createSampleBrowseData()
        if (name === 'schema.tableDetails') return createSampleTableDetails('users')
        if (name === 'data.applyChanges') return applyDeferred.promise
        return null
      })

      const editor = new DatanoaStudioEditor()
      activeEditors.push(editor)
      await flushMicrotasks(12)

      const grid = editor.getDataGrid()
      expect(grid).not.toBeNull()
      expect(grid?.stageCellEdit(0, 'name', 'Alice Updated')).toBe(true)

      const submitBtn = findButtonContaining(dom.body, 'Submit [1]')
      expect(submitBtn).not.toBeNull()
      expect(submitBtn?.disabled).toBe(false)

      // Double-click Submit rapidly
      submitBtn?.click()
      submitBtn?.click()
      await flushMicrotasks(4)

      const applyCalls = calls.filter((c) => c.name === 'data.applyChanges')
      expect(applyCalls).toHaveLength(1)
      expect(submitBtn?.disabled).toBe(true)
      expect(submitBtn?.classList.contains('is-loading')).toBe(true)
      expect(submitBtn?.querySelector('.datanoa-spinner')).not.toBeNull()

      // Grid mutations are locked while submitting
      expect(grid?.addBlankRow()).toBeNull()

      applyDeferred.resolve({
        ok: true,
        inserted: 0,
        updated: 1,
        deleted: 0,
        statements: ["UPDATE \"users\" SET \"name\" = 'Alice Updated' WHERE \"id\" = 1;"],
      })
      await flushMicrotasks(12)

      expect(submitBtn?.classList.contains('is-loading')).toBe(false)
      expect(submitBtn?.textContent).toBe('Submit [0]')
      expect(submitBtn?.disabled).toBe(true)
    })

    it('keeps SchemaInspectorView migration modal open & locked during async query.run and shows error on failure', async () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const container = dom.createElement('div')
      dom.body.appendChild(container)

      const firstRun = createDeferred<void>()
      const secondRun = createDeferred<void>()
      let runCount = 0

      const inspector = new SchemaInspectorView(container as unknown as HTMLElement, {
        dialect: 'sqlite',
        onApplyMigration: () => {
          runCount++
          return runCount === 1 ? firstRun.promise : secondRun.promise
        },
      })
      activeInspectors.push(inspector)
      inspector.setDetails(createSampleTableDetails('users'), 'sqlite')

      // Stage a column addition
      const addColBtn = container.querySelector<FakeHTMLButtonElement>('.datanoa-add-col-btn')
      expect(addColBtn).not.toBeNull()
      addColBtn?.click()

      // Open confirmation modal
      await inspector.applyStagedChanges()
      const backdrop = container.querySelector('.datanoa-modal-backdrop')
      expect(backdrop).not.toBeNull()
      const confirmBtn = container.querySelector<FakeHTMLButtonElement>(
        '.datanoa-struct-confirm-execute-btn'
      )
      const cancelBtn = container.querySelector<FakeHTMLButtonElement>(
        '.datanoa-struct-confirm-cancel-btn'
      )
      expect(confirmBtn).not.toBeNull()
      expect(confirmBtn?.disabled).toBe(false)

      // Click Confirm twice rapidly -> only 1 execution, modal stays open & locked
      confirmBtn?.click()
      confirmBtn?.click()
      await flushMicrotasks(4)

      expect(runCount).toBe(1)
      expect(inspector.isMigrationInFlight()).toBe(true)
      expect(container.querySelector('.datanoa-modal-backdrop')).not.toBeNull()
      expect(confirmBtn?.disabled).toBe(true)
      expect(cancelBtn?.disabled).toBe(true)
      expect(confirmBtn?.querySelector('.datanoa-spinner')).not.toBeNull()

      // Backdrop click and Escape must NOT close modal while migrating
      backdrop?.dispatchEvent(new FakeEvent({ type: 'click', target: backdrop, bubbles: true }))
      dom.window.dispatchEvent(new FakeEvent({ type: 'keydown', key: 'Escape', bubbles: true }))
      expect(container.querySelector('.datanoa-modal-backdrop')).not.toBeNull()

      // Reject first migration -> modal stays open, error shown, buttons re-enabled
      firstRun.reject(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed'))
      await flushMicrotasks(6)

      expect(inspector.isMigrationInFlight()).toBe(false)
      expect(container.querySelector('.datanoa-modal-backdrop')).not.toBeNull()
      const errBox = container.querySelector('.datanoa-struct-exec-error')
      expect(errBox?.style.display).toBe('block')
      expect(errBox?.textContent).toContain('SQLITE_CONSTRAINT')
      expect(confirmBtn?.disabled).toBe(false)
      expect(cancelBtn?.disabled).toBe(false)

      // Retry succeeds -> modal closes cleanly
      confirmBtn?.click()
      await flushMicrotasks(4)
      expect(runCount).toBe(2)
      secondRun.resolve()
      await flushMicrotasks(6)

      expect(inspector.isMigrationInFlight()).toBe(false)
      expect(container.querySelector('.datanoa-modal-backdrop')).toBeNull()
    })

    it('never sticks SchemaInspectorView skeleton on setLoading(false) and wires Retry CTA on setError', () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const container = dom.createElement('div')
      dom.body.appendChild(container)

      const inspector = new SchemaInspectorView(container as unknown as HTMLElement, {
        dialect: 'sqlite',
      })
      activeInspectors.push(inspector)

      inspector.setLoading(true, 'orders')
      expect(container.querySelector('.datanoa-inspector-skeleton')).not.toBeNull()
      expect(container.textContent).toContain('orders')

      // Turning loading off must clear the skeleton instead of staying stuck
      inspector.setLoading(false)
      expect(container.querySelector('.datanoa-inspector-skeleton')).toBeNull()
      expect(container.textContent).toContain('No table selected')

      // Error state renders error card with functional Retry button
      let retried = 0
      inspector.setError('Connection timed out', () => {
        retried++
      })
      expect(container.querySelector('.datanoa-inspector-skeleton')).toBeNull()
      const errCard = container.querySelector('.datanoa-inspector-error-card')
      expect(errCard).not.toBeNull()
      expect(errCard?.textContent).toContain('Connection timed out')

      const retryBtn = container.querySelector<FakeHTMLButtonElement>('.datanoa-error-retry-btn')
      expect(retryBtn).not.toBeNull()
      retryBtn?.click()
      expect(retried).toBe(1)
    })

    it('resets subbar title on loadTableData error and enforces Prev/Next disabled bounds', async () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const conn: ConnectionProfile = {
        id: 'conn-1',
        name: 'Local SQLite',
        driver: 'sqlite',
        filePath: ':memory:',
      }
      let fetchShouldFail = false
      let totalRows = 3

      installMockOrcaOnWindow(dom, (name, input) => {
        if (name === 'connections.list') return [conn]
        if (name === 'schema.listObjects') return [{ name: 'users', kind: 'table' }]
        if (name === 'schema.tableDetails') return createSampleTableDetails('users')
        if (name === 'data.fetchPage') {
          if (fetchShouldFail) {
            return Promise.reject(new Error('Disk I/O failure'))
          }
          const req = (input || {}) as { page?: number; pageSize?: number }
          return createSampleBrowseData({
            totalRows,
            page: req.page ?? 1,
            pageSize: req.pageSize ?? 100,
          })
        }
        return null
      })

      const editor = new DatanoaStudioEditor()
      activeEditors.push(editor)
      await flushMicrotasks(12)

      const prevBtn = findButtonByText(dom.body, 'Prev')
      const nextBtn = findButtonByText(dom.body, 'Next')
      const subbarTitle = dom.body.querySelector('.datanoa-grid-subbar-title')
      expect(prevBtn?.disabled).toBe(true)
      expect(nextBtn?.disabled).toBe(true)
      expect(subbarTitle?.textContent).toContain('users')

      // Simulate multi-page table then trigger error on page 2
      totalRows = 250
      const refreshBtn = findButtonByText(dom.body, 'Refresh')
      refreshBtn?.click()
      await flushMicrotasks(12)

      expect(prevBtn?.disabled).toBe(true)
      expect(nextBtn?.disabled).toBe(false)

      fetchShouldFail = true
      nextBtn?.click()
      await flushMicrotasks(12)

      expect(subbarTitle?.textContent).toBe('users · Error')
      expect(dom.body.querySelector('.datanoa-query-banner.error')?.textContent).toContain(
        'Disk I/O failure'
      )
      // Clicking Retry recovers cleanly
      fetchShouldFail = false
      const retryBtn = dom.body.querySelector<FakeHTMLButtonElement>(
        '.datanoa-query-banner .datanoa-error-retry-btn'
      )
      expect(retryBtn).not.toBeNull()
      retryBtn?.click()
      await flushMicrotasks(12)
      expect(subbarTitle?.textContent).toContain('users · 4 cols')
      expect(prevBtn?.disabled).toBe(false)
      expect(nextBtn?.disabled).toBe(false)
    })
  })

  // ==========================================================================
  // 2. Multi-Selection, Bulk Ops, Pinned/Hidden Columns, Find, Quick Filter, FK
  // ==========================================================================
  describe('2. VirtualDataGrid Multi-Selection, Bulk Ops, Pinned/Hidden, Find, Quick Filter & FK Jump', () => {
    it('supports drag range, Shift+Click, Ctrl+Click toggle/split, # row gutter, corner # Select All, and non-conflicting Column Select vs Sort', () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const container = dom.createElement('div')
      dom.body.appendChild(container)

      const sortCalls: Array<{ col: string; dir: string }> = []
      const grid = new VirtualDataGrid({
        container: container as unknown as HTMLElement,
        data: createSampleBrowseData(),
        batchMode: true,
        tableName: 'users',
        dialect: 'sqlite',
        onSort: (col, dir) => {
          sortCalls.push({ col, dir })
        },
      })
      activeGrids.push(grid)

      const getCell = (vr: number, vc: number) =>
        container.querySelector(`tbody td[data-vis-row="${vr}"][data-vis-col="${vc}"]`)

      // 1. Drag rectangular range from (0,0) to (2,1) -> 3x2 = 6 cells with perimeter classes
      const c00 = getCell(0, 0)
      const c21 = getCell(2, 1)
      expect(c00).not.toBeNull()
      expect(c21).not.toBeNull()

      c00?.dispatchEvent(
        new FakeEvent({ type: 'mousedown', button: 0, bubbles: true, target: c00 })
      )
      dom.window.dispatchEvent(
        new FakeEvent({ type: 'mousemove', bubbles: true, target: c21, clientX: 120, clientY: 60 })
      )
      dom.window.dispatchEvent(new FakeEvent({ type: 'mouseup', bubbles: true }))

      let summary = grid.getSelectionSummary()
      expect(summary.rowCount).toBe(3)
      expect(summary.colCount).toBe(2)
      expect(summary.cellCount).toBe(6)
      expect(c00?.classList.contains('datanoa-cell-in-range')).toBe(true)
      expect(c00?.classList.contains('datanoa-range-top')).toBe(true)
      expect(c00?.classList.contains('datanoa-range-left')).toBe(true)
      expect(c21?.classList.contains('datanoa-range-bottom')).toBe(true)
      expect(c21?.classList.contains('datanoa-range-right')).toBe(true)

      // 2. Ctrl+Click inside range (1,0) splits rectangle -> 5 cells selected
      const c10 = getCell(1, 0)
      c10?.dispatchEvent(
        new FakeEvent({ type: 'mousedown', button: 0, ctrlKey: true, bubbles: true, target: c10 })
      )
      summary = grid.getSelectionSummary()
      expect(summary.cellCount).toBe(5)
      expect(c10?.classList.contains('datanoa-cell-in-range')).toBe(false)

      // 3. Shift+Click from (0,1) to (1,2) -> 2x2 = 4 cells
      const c01 = getCell(0, 1)
      const c12 = getCell(1, 2)
      c01?.dispatchEvent(
        new FakeEvent({ type: 'mousedown', button: 0, bubbles: true, target: c01 })
      )
      dom.window.dispatchEvent(new FakeEvent({ type: 'mouseup', bubbles: true }))
      c12?.dispatchEvent(
        new FakeEvent({ type: 'mousedown', button: 0, shiftKey: true, bubbles: true, target: c12 })
      )
      dom.window.dispatchEvent(new FakeEvent({ type: 'mouseup', bubbles: true }))
      summary = grid.getSelectionSummary()
      expect(summary.rowCount).toBe(2)
      expect(summary.colCount).toBe(2)
      expect(summary.cellCount).toBe(4)

      // 4. Row gutter `#` click + Shift+Click selects rows 0..1 across all 4 columns (8 cells)
      const rowNum0 = container.querySelector('tbody td.datanoa-td-rownum[data-vis-row="0"]')
      const rowNum1 = container.querySelector('tbody td.datanoa-td-rownum[data-vis-row="1"]')
      rowNum0?.dispatchEvent(
        new FakeEvent({ type: 'mousedown', button: 0, bubbles: true, target: rowNum0 })
      )
      dom.window.dispatchEvent(new FakeEvent({ type: 'mouseup', bubbles: true }))
      rowNum1?.dispatchEvent(
        new FakeEvent({
          type: 'mousedown',
          button: 0,
          shiftKey: true,
          bubbles: true,
          target: rowNum1,
        })
      )
      dom.window.dispatchEvent(new FakeEvent({ type: 'mouseup', bubbles: true }))
      summary = grid.getSelectionSummary()
      expect(summary.rowCount).toBe(2)
      expect(summary.colCount).toBe(4)
      expect(summary.cellCount).toBe(8)
      expect(rowNum0?.classList.contains('row-selected')).toBe(true)
      expect(rowNum1?.classList.contains('row-selected')).toBe(true)

      // 5. Corner `#` selects all 3x4 = 12 cells
      const cornerTh = container.querySelector('thead th.datanoa-th-rownum')
      cornerTh?.click()
      summary = grid.getSelectionSummary()
      expect(summary.cellCount).toBe(12)

      // 6. Column select via .datanoa-col-select-btn & Shift+Click <th> does NOT trigger sort,
      // while plain click on <th> DOES trigger sort
      const amountTh = container.querySelector('thead th[data-vis-col="2"]')
      const colSelectBtn = amountTh?.querySelector<FakeHTMLButtonElement>('.datanoa-col-select-btn')
      expect(colSelectBtn).not.toBeNull()
      colSelectBtn?.click()
      expect(sortCalls).toHaveLength(0)
      summary = grid.getSelectionSummary()
      expect(summary.rowCount).toBe(3)
      expect(summary.colCount).toBe(1)
      expect(summary.numericCount).toBe(2)
      expect(summary.sum).toBe(30)
      expect(summary.avg).toBe(15)
      expect(summary.min).toBe(10)
      expect(summary.max).toBe(20)

      // Shift+Click next <th> (org_id) extends column selection to 2 cols without sorting
      const orgTh = container.querySelector('thead th[data-vis-col="3"]')
      orgTh?.dispatchEvent(
        new FakeEvent({ type: 'click', shiftKey: true, bubbles: true, target: orgTh })
      )
      expect(sortCalls).toHaveLength(0)
      expect(grid.getSelectionSummary().colCount).toBe(2)

      // Plain click on <th> sorts normally
      amountTh?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true, target: amountTh }))
      expect(sortCalls).toEqual([{ col: 'amount', dir: 'ASC' }])
    })

    it('supports keyboard navigation, Ctrl+A/C/V, Delete -> NULL, bulk export formats, bulk clone/delete, and pasteDelimitedText', () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const container = dom.createElement('div')
      dom.body.appendChild(container)

      let lastCopied = ''
      const origCreate = dom.document.createElement.bind(dom.document)
      vi.spyOn(dom.document, 'createElement').mockImplementation((tag: string) => {
        const el = origCreate(tag)
        return el
      })
      dom.document.execCommand = (cmd: string) => {
        if (cmd === 'copy') {
          const active = dom.document.activeElement
          if (active instanceof FakeHTMLTextAreaElement) {
            lastCopied = active.value
            return true
          }
        }
        return false
      }

      const grid = new VirtualDataGrid({
        container: container as unknown as HTMLElement,
        data: createSampleBrowseData(),
        batchMode: true,
        tableName: 'users',
        dialect: 'sqlite',
      })
      activeGrids.push(grid)

      const gridContainer = container.querySelector('.datanoa-grid-container')
      expect(gridContainer).not.toBeNull()

      // ArrowDown selects (0,0), Shift+ArrowRight + Shift+ArrowDown extends to 2x2
      gridContainer?.dispatchEvent(
        new FakeEvent({ type: 'keydown', key: 'ArrowDown', bubbles: true })
      )
      gridContainer?.dispatchEvent(
        new FakeEvent({ type: 'keydown', key: 'ArrowRight', shiftKey: true, bubbles: true })
      )
      gridContainer?.dispatchEvent(
        new FakeEvent({ type: 'keydown', key: 'ArrowDown', shiftKey: true, bubbles: true })
      )
      expect(grid.getSelectionSummary().cellCount).toBe(4)

      // Export selection in all 6 formats
      expect(grid.copySelection('tsv')).toBe('1\tAlice\n2\tBob')
      expect(lastCopied).toBe('1\tAlice\n2\tBob')
      expect(grid.exportSelection('tsv-headers')).toBe('id\tname\n1\tAlice\n2\tBob')
      expect(grid.exportSelection('csv')).toContain('id,name')
      expect(JSON.parse(grid.exportSelection('json'))).toEqual([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ])
      expect(grid.exportSelection('sql-in')).toBe("(1, 'Alice', 2, 'Bob')")
      expect(grid.exportSelection('sql-insert')).toContain('INSERT INTO "users"')

      // Single-column SQL IN includes column identifier prefix
      const idColBtn = container.querySelector<FakeHTMLButtonElement>(
        'thead th[data-vis-col="0"] .datanoa-col-select-btn'
      )
      idColBtn?.click()
      expect(grid.exportSelection('sql-in')).toBe('"id" IN (1, 2, 3)')

      // Restore 2x2 selection at (0,0)..(1,1) for Ctrl+C test
      gridContainer?.dispatchEvent(
        new FakeEvent({ type: 'keydown', key: 'ArrowDown', bubbles: true })
      )
      gridContainer?.dispatchEvent(
        new FakeEvent({ type: 'keydown', key: 'ArrowUp', bubbles: true })
      )
      gridContainer?.dispatchEvent(
        new FakeEvent({ type: 'keydown', key: 'ArrowRight', shiftKey: true, bubbles: true })
      )
      gridContainer?.dispatchEvent(
        new FakeEvent({ type: 'keydown', key: 'ArrowDown', shiftKey: true, bubbles: true })
      )

      // Ctrl+C copies TSV
      lastCopied = ''
      gridContainer?.dispatchEvent(
        new FakeEvent({ type: 'keydown', key: 'c', ctrlKey: true, bubbles: true })
      )
      expect(lastCopied).toBe('1\tAlice\n2\tBob')

      // 1x1 paste across multi-cell selection fills every selected cell
      const c01First = container.querySelector('tbody td[data-vis-row="0"][data-vis-col="1"]')
      const c11Second = container.querySelector('tbody td[data-vis-row="1"][data-vis-col="1"]')
      c01First?.dispatchEvent(
        new FakeEvent({ type: 'mousedown', button: 0, bubbles: true, target: c01First })
      )
      dom.window.dispatchEvent(new FakeEvent({ type: 'mouseup', bubbles: true }))
      c11Second?.dispatchEvent(
        new FakeEvent({
          type: 'mousedown',
          button: 0,
          shiftKey: true,
          bubbles: true,
          target: c11Second,
        })
      )
      dom.window.dispatchEvent(new FakeEvent({ type: 'mouseup', bubbles: true }))
      expect(grid.pasteDelimitedText('SharedName')).toBe(2)
      expect((grid.getModel()?.rows[0] as Record<string, unknown>).name).toBe('SharedName')
      expect((grid.getModel()?.rows[1] as Record<string, unknown>).name).toBe('SharedName')

      // Paste 2x2 TSV matrix via paste event into (0,1)
      const c01 = container.querySelector('tbody td[data-vis-row="0"][data-vis-col="1"]')
      c01?.dispatchEvent(new FakeEvent({ type: 'mousedown', button: 0, bubbles: true, target: c01 }))
      dom.window.dispatchEvent(new FakeEvent({ type: 'mouseup', bubbles: true }))
      gridContainer?.dispatchEvent(
        new FakeEvent({
          type: 'paste',
          bubbles: true,
          clipboardData: {
            getData: () => 'Alicia\t15\nBobby\t25',
          },
        })
      )
      const model = grid.getModel()
      expect((model?.rows[0] as Record<string, unknown>).name).toBe('Alicia')
      expect((model?.rows[0] as Record<string, unknown>).amount).toBe(15)
      expect((model?.rows[1] as Record<string, unknown>).name).toBe('Bobby')
      expect((model?.rows[1] as Record<string, unknown>).amount).toBe(25)
      expect(grid.getStagedCount()).toBe(2)

      // Delete sets selected nullable cells to NULL while preserving NOT NULL columns (name)
      gridContainer?.dispatchEvent(
        new FakeEvent({ type: 'keydown', key: 'Delete', bubbles: true })
      )
      expect((model?.rows[0] as Record<string, unknown>).name).toBe('Alicia')
      expect((model?.rows[0] as Record<string, unknown>).amount).toBeNull()
      expect((model?.rows[1] as Record<string, unknown>).amount).toBeNull()

      // Bulk clone 2 selected rows (auto-increment id omitted)
      const clonedCount = grid.bulkCloneSelectedRows()
      expect(clonedCount).toBe(2)
      expect(grid.getModel()?.rows).toHaveLength(5)
      expect((grid.getModel()?.rows[3] as Record<string, unknown>).id).toBeUndefined()

      // Bulk delete the 2 newly cloned inserted rows (descending splice)
      const removed = grid.bulkMarkRowsDeleted()
      expect(removed).toBe(2)
      expect(grid.getModel()?.rows).toHaveLength(3)

      // Ctrl+A selects all 12 cells, then bulkMarkRowsDeleted marks all 3 existing rows deleted
      gridContainer?.dispatchEvent(
        new FakeEvent({ type: 'keydown', key: 'a', ctrlKey: true, bubbles: true })
      )
      expect(grid.getSelectionSummary().cellCount).toBe(12)
      expect(grid.bulkMarkRowsDeleted()).toBe(3)
      expect(grid.getChangesPayload().deletes).toHaveLength(3)

      // Escape clears selection
      gridContainer?.dispatchEvent(new FakeEvent({ type: 'keydown', key: 'Escape', bubbles: true }))
      expect(grid.getSelectionSummary().cellCount).toBe(0)
    })

    it('supports pinned/hidden columns, Find & Highlight cycling, Quick Filter, FK jump, and live Status Bar aggregates', async () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const conn: ConnectionProfile = {
        id: 'conn-1',
        name: 'Local SQLite',
        driver: 'sqlite',
        filePath: ':memory:',
      }
      const objects: SchemaObject[] = [
        { name: 'users', kind: 'table' },
        { name: 'orgs', kind: 'table' },
      ]

      const calls = installMockOrcaOnWindow(dom, (name, input) => {
        if (name === 'connections.list') return [conn]
        if (name === 'schema.listObjects') return objects
        if (name === 'schema.tableDetails') {
          const req = (input || {}) as { table?: string }
          return createSampleTableDetails(req.table || 'users')
        }
        if (name === 'data.fetchPage') {
          const req = (input || {}) as { table?: string }
          if (req.table === 'orgs') {
            return {
              columns: [
                {
                  name: 'id',
                  type: 'INTEGER',
                  nativeType: 'INTEGER',
                  nullable: false,
                  defaultValue: null,
                  isPrimaryKey: true,
                  isAutoIncrement: true,
                },
                {
                  name: 'title',
                  type: 'TEXT',
                  nativeType: 'TEXT',
                  nullable: false,
                  defaultValue: null,
                  isPrimaryKey: false,
                  isAutoIncrement: false,
                },
              ],
              rows: [{ id: 100, title: 'Acme Corp' }],
              totalRows: 1,
              page: 1,
              pageSize: 100,
              primaryKey: ['id'],
              canEdit: true,
            }
          }
          return createSampleBrowseData()
        }
        return null
      })

      const editor = new DatanoaStudioEditor()
      activeEditors.push(editor)
      await flushMicrotasks(16)

      const grid = editor.getDataGrid()
      expect(grid).not.toBeNull()

      // Live Status Bar aggregates when selecting numeric `amount` column
      const amountSelectBtn = dom.body.querySelector<FakeHTMLButtonElement>(
        'thead th[data-vis-col="2"] .datanoa-col-select-btn'
      )
      expect(amountSelectBtn).not.toBeNull()
      amountSelectBtn?.click()

      const statusSel = dom.body.querySelector('.datanoa-status-selection')
      const shortcutHint = dom.body.querySelector('.datanoa-shortcut-hint')
      expect(statusSel).not.toBeNull()
      expect(statusSel?.style.display).toBe('inline-flex')
      expect(shortcutHint?.style.display).toBe('none')
      expect(statusSel?.textContent).toContain('Selected: 3 rows × 1 col (3 cells)')
      expect(statusSel?.textContent).toContain('Non-null: 2')
      expect(statusSel?.textContent).toContain('Sum: 30')
      expect(statusSel?.textContent).toContain('Avg: 15')
      expect(statusSel?.textContent).toContain('Min: 10')
      expect(statusSel?.textContent).toContain('Max: 20')

      // Refined hairline selection border tokens (1px edge, subtle tint)
      expect(EDITOR_STYLE).toContain('--sel-edge: rgba(56, 189, 248, 0.42)')
      expect(EDITOR_STYLE).toContain('inset 0 1px 0 0 var(--sel-edge)')
      expect(EDITOR_STYLE).toContain('.datanoa-grid-table.datanoa-grid-empty-no-cols')
      expect(EDITOR_STYLE).toContain('.datanoa-sql-area .cm-scroller')
      expect(EDITOR_STYLE).toContain('.datanoa-sql-toolbar')

      // Contextual SQL toolbar: visible in split/sql, hidden in grid/inspector
      const sqlToolbar = dom.body.querySelector('.datanoa-sql-toolbar')
      expect(sqlToolbar).not.toBeNull()
      const gridTabBtn = findButtonContaining(dom.body, 'Data Grid')
      const inspectorTabBtn = findButtonContaining(dom.body, 'Schema Inspector')
      const splitTabBtn = findButtonContaining(dom.body, 'Split View')
      gridTabBtn?.click()
      expect(sqlToolbar?.style.display).toBe('none')
      inspectorTabBtn?.click()
      expect(sqlToolbar?.style.display).toBe('none')
      splitTabBtn?.click()
      expect(sqlToolbar?.style.display).toBe('flex')

      // Bottom cushion row + exact 22px row height (21px line-height + 1px border) prevents last row clipping
      expect(dom.body.querySelector('.datanoa-grid-bottom-cushion')).not.toBeNull()
      expect(EDITOR_STYLE).toContain('line-height: 21px;')

      // Paste as New Row(s) appends staged PASTE row(s) with badge and updates status metrics
      const pastedNewCount = grid?.pasteAsNewRows('name\tamount\torg_id\nDave\t42\t100')
      expect(pastedNewCount).toBe(1)
      expect(dom.body.querySelector('.datanoa-row-badge')?.textContent).toBe('PASTE')
      expect(dom.body.querySelector('.datanoa-status-metrics')?.textContent).toContain('+1 staged')
      grid?.revertAllChanges()

      // Preserve horizontal scrollLeft when sorting on the same table
      grid?.setScrollLeft(240)
      expect(grid?.getScrollLeft()).toBe(240)
      const nameTh = dom.body.querySelector('thead th[data-vis-col="1"]')
      nameTh?.dispatchEvent(new FakeEvent({ type: 'click', bubbles: true, target: nameTh }))
      await flushMicrotasks(12)
      expect(grid?.getScrollLeft()).toBe(240)

      // Pin `name` column -> moves to visCol=0 with pinned classes & sticky left offset
      grid?.togglePinColumn('name')
      const pinnedTh = dom.body.querySelector('thead th[data-vis-col="0"]')
      expect(pinnedTh?.textContent).toContain('name')
      expect(pinnedTh?.classList.contains('datanoa-col-pinned')).toBe(true)
      expect(pinnedTh?.classList.contains('datanoa-col-pinned-last')).toBe(true)
      expect(pinnedTh?.style.left).toBe('44px')

      // Hide `amount` column -> remaining 3 columns visible; hiding all columns blocked
      grid?.setColumnVisibility('amount', false)
      expect(grid?.getColumnConfig().hidden).toEqual(['amount'])
      grid?.setColumnVisibility('name', false)
      grid?.setColumnVisibility('id', false)
      grid?.setColumnVisibility('org_id', false) // blocked: at least 1 must remain visible
      expect(grid?.getColumnConfig().hidden).not.toContain('org_id')
      grid?.showAllColumns()
      expect(grid?.getColumnConfig().hidden).toEqual([])

      // Find & Highlight (`o` matches Bob and Carol)
      const findState = grid?.setFindQuery('o')
      expect(findState?.total).toBe(2)
      expect(findState?.activeIndex).toBe(0)
      expect(dom.body.querySelectorAll('.datanoa-cell-match')).toHaveLength(2)
      expect(dom.body.querySelectorAll('.datanoa-cell-match-active')).toHaveLength(1)
      expect(grid?.findNext(1).activeIndex).toBe(1)
      expect(grid?.findNext(1).activeIndex).toBe(0) // wraps around
      grid?.setFindQuery('')

      // Quick Filter via right-click context menu on Alice cell
      const aliceCell = dom.body.querySelector('tbody td[data-row-index="0"][data-col-index="1"]')
      expect(aliceCell).not.toBeNull()
      aliceCell?.dispatchEvent(
        new FakeEvent({ type: 'contextmenu', bubbles: true, target: aliceCell })
      )
      const filterEqBtn = findButtonContaining(dom.body, 'Filter: name = Alice')
      expect(filterEqBtn).not.toBeNull()
      filterEqBtn?.click()
      await flushMicrotasks(10)

      const filteredFetch = [...calls].reverse().find((c) => c.name === 'data.fetchPage')
      expect((filteredFetch?.input as { whereClause?: string }).whereClause).toBe(
        '"name" = \'Alice\''
      )

      // Foreign Key Jump badge -> jumps to `orgs` table with WHERE "id" = 100 and clears stale client filter
      const clientSearch = dom.body.querySelector<FakeHTMLInputElement>('.datanoa-client-search')
      if (clientSearch) {
        clientSearch.value = 'Alice'
        clientSearch.dispatchEvent(new FakeEvent({ type: 'input', bubbles: true }))
      }
      const fkBadge = dom.body.querySelector<FakeHTMLButtonElement>('tbody .datanoa-fk-badge')
      expect(fkBadge).not.toBeNull()
      fkBadge?.dispatchEvent(
        new FakeEvent({ type: 'mousedown', button: 0, bubbles: true, target: fkBadge })
      )
      await flushMicrotasks(12)

      const orgFetch = [...calls].reverse().find((c) => c.name === 'data.fetchPage')
      expect((orgFetch?.input as { table?: string }).table).toBe('orgs')
      expect((orgFetch?.input as { whereClause?: string }).whereClause).toBe('"id" = 100')
      expect(clientSearch?.value).toBe('')
    })
  })

  // ==========================================================================
  // 3. Studio Tier A Utilities & Light-Mode / Focus CSS Tokens
  // ==========================================================================
  describe('3. Studio Tier A Utilities & Theme Accessibility', () => {
    it('formats SQL, inspects NULL badge + live JSON validation/format/minify, creates table, runs typed Truncate/Drop modal, enforces readOnly, and opens Command Palette & Shortcuts', async () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const conn: ConnectionProfile = {
        id: 'conn-1',
        name: 'Dev SQLite',
        driver: 'sqlite',
        filePath: ':memory:',
      }
      const roConn: ConnectionProfile = {
        id: 'conn-ro',
        name: 'Prod RO',
        driver: 'sqlite',
        filePath: ':memory:',
        readOnly: true,
        colorTag: 'prod',
      }
      const objects: SchemaObject[] = [{ name: 'users', kind: 'table' }]

      const calls = installMockOrcaOnWindow(dom, (name) => {
        if (name === 'connections.list') return [conn, roConn]
        if (name === 'schema.listObjects') return objects
        if (name === 'schema.tableDetails') return createSampleTableDetails('users')
        if (name === 'data.fetchPage') return createSampleBrowseData()
        if (name === 'query.run') {
          return {
            columns: [],
            rows: [],
            rowCount: 0,
            affectedRows: 0,
            executionTimeMs: 3,
            truncated: false,
            isSelect: false,
          }
        }
        return null
      })

      const editor = new DatanoaStudioEditor()
      activeEditors.push(editor)
      await flushMicrotasks(14)

      // 1. Format SQL button & Shift+Alt+F
      const consoleCtrl = editor.getSqlConsole()
      consoleCtrl?.setText('select id, name from users where amount > 5 order by id desc;')
      const formatBtn = findButtonByText(dom.body, 'Format SQL')
      expect(formatBtn).not.toBeNull()
      formatBtn?.click()
      expect(consoleCtrl?.getText()).toContain('SELECT')
      expect(consoleCtrl?.getText()).toContain('\nFROM users')
      expect(consoleCtrl?.getText()).toContain('\nWHERE amount > 5')

      // 2. Value Inspector: NULL badge vs empty string + JSON validator/Format/Minify
      const nullAmountCell = dom.body.querySelector('tbody td[data-row-index="2"][data-col-index="2"]')
      nullAmountCell?.dispatchEvent(
        new FakeEvent({ type: 'mousedown', button: 0, bubbles: true, target: nullAmountCell })
      )
      dom.window.dispatchEvent(new FakeEvent({ type: 'mouseup', bubbles: true }))
      const editCellBtn = findButtonByText(dom.body, 'Edit Cell')
      expect(editCellBtn?.disabled).toBe(false)
      editCellBtn?.click()

      const nullBadge = dom.body.querySelector('.datanoa-null-badge')
      const inspectorTextarea = dom.body.querySelector<FakeHTMLTextAreaElement>(
        '.datanoa-value-textarea'
      )
      const jsonStatus = dom.body.querySelector('.datanoa-json-status')
      expect(nullBadge?.style.display).toBe('inline-flex')
      expect(jsonStatus?.textContent).toContain('NULL value')

      // Type invalid JSON -> invalid class; fix JSON -> valid class + Format/Minify
      if (inspectorTextarea) {
        inspectorTextarea.value = '{"broken": '
        inspectorTextarea.dispatchEvent(new FakeEvent({ type: 'input', bubbles: true }))
        expect(nullBadge?.style.display).toBe('none')
        expect(jsonStatus?.classList.contains('invalid')).toBe(true)

        inspectorTextarea.value = '{"a":1,"b":[2,3]}'
        inspectorTextarea.dispatchEvent(new FakeEvent({ type: 'input', bubbles: true }))
        expect(jsonStatus?.classList.contains('valid')).toBe(true)

        findButtonByText(dom.body, 'Format JSON')?.click()
        expect(inspectorTextarea.value).toContain('\n  "a": 1')

        findButtonByText(dom.body, 'Minify JSON')?.click()
        expect(inspectorTextarea.value).toBe('{"a":1,"b":[2,3]}')
      }

      // 3. + New Table modal
      const newTableBtn = findButtonByText(dom.body, '+ New Table')
      expect(newTableBtn).not.toBeNull()
      expect(newTableBtn?.disabled).toBe(false)
      newTableBtn?.click()

      const createModal = dom.body.querySelector('.datanoa-create-table-modal')
      expect(createModal).not.toBeNull()
      const tblNameInp = createModal?.querySelector<FakeHTMLInputElement>('.datanoa-filter-input')
      expect(tblNameInp).not.toBeNull()
      if (tblNameInp) {
        tblNameInp.value = 'invoices'
        tblNameInp.dispatchEvent(new FakeEvent({ type: 'input', bubbles: true }))
      }
      const ddlPreview = createModal?.querySelector('.datanoa-modal-sql')
      expect(ddlPreview?.textContent).toContain('CREATE TABLE "invoices"')

      const createExecBtn = createModal ? findButtonByText(createModal, 'Create Table') : null
      expect(createExecBtn?.disabled).toBe(false)
      createExecBtn?.click()
      await flushMicrotasks(12)

      expect(dom.body.querySelector('.datanoa-create-table-modal')).toBeNull()
      expect(
        calls.some(
          (c) =>
            c.name === 'query.run' &&
            String((c.input as { sql?: string }).sql).includes('CREATE TABLE "invoices"')
        )
      ).toBe(true)

      // 4. Truncate / Drop typed confirmation modal from sidebar context menu
      const usersSidebarBtn = dom.body.querySelector('.datanoa-sidebar-item[data-table-name="users"]')
      expect(usersSidebarBtn).not.toBeNull()
      usersSidebarBtn?.dispatchEvent(
        new FakeEvent({ type: 'contextmenu', bubbles: true, target: usersSidebarBtn })
      )
      findButtonByText(dom.body, 'Truncate Table...')?.click()

      const dangerModal = dom.body.querySelector('.datanoa-danger-modal')
      expect(dangerModal).not.toBeNull()
      const confirmInput = dangerModal?.querySelector<FakeHTMLInputElement>('.datanoa-filter-input')
      const truncateExecBtn = dangerModal ? findButtonByText(dangerModal, 'Truncate Table') : null
      expect(truncateExecBtn?.disabled).toBe(true)

      if (confirmInput) {
        confirmInput.value = 'wrong_name'
        confirmInput.dispatchEvent(new FakeEvent({ type: 'input', bubbles: true }))
        expect(truncateExecBtn?.disabled).toBe(true)

        confirmInput.value = 'users'
        confirmInput.dispatchEvent(new FakeEvent({ type: 'input', bubbles: true }))
        expect(truncateExecBtn?.disabled).toBe(false)
      }

      truncateExecBtn?.click()
      await flushMicrotasks(12)
      expect(dom.body.querySelector('.datanoa-danger-modal')).toBeNull()
      expect(
        calls.some(
          (c) =>
            c.name === 'query.run' &&
            String((c.input as { sql?: string }).sql) === 'DELETE FROM "users";'
        )
      ).toBe(true)

      // 5. Command Palette (Ctrl+K)
      dom.window.dispatchEvent(
        new FakeEvent({ type: 'keydown', key: 'k', ctrlKey: true, bubbles: true })
      )
      const palette = dom.body.querySelector('.datanoa-cmd-palette')
      expect(palette).not.toBeNull()
      const paletteInp = palette?.querySelector<FakeHTMLInputElement>('.datanoa-filter-input')
      if (paletteInp) {
        paletteInp.value = 'Schema Inspector'
        paletteInp.dispatchEvent(new FakeEvent({ type: 'input', bubbles: true }))
        paletteInp.dispatchEvent(new FakeEvent({ type: 'keydown', key: 'Enter', bubbles: true }))
      }
      expect(dom.body.querySelector('.datanoa-cmd-palette')).toBeNull()
      expect(dom.body.querySelector('.datanoa-inspector-view')?.style.display).toBe('flex')

      // 6. Keyboard Shortcuts modal (`?` button)
      const shortcutsBtn = findButtonByText(dom.body, '?')
      expect(shortcutsBtn).not.toBeNull()
      shortcutsBtn?.click()
      const shortcutsModal = dom.body.querySelector('.datanoa-shortcuts-modal')
      expect(shortcutsModal).not.toBeNull()
      expect(shortcutsModal?.textContent).toContain('Ctrl+Shift+Enter')
      expect(shortcutsModal?.textContent).toContain('Shift+Alt+F')
      dom.window.dispatchEvent(new FakeEvent({ type: 'keydown', key: 'Escape', bubbles: true }))
      expect(dom.body.querySelector('.datanoa-shortcuts-modal')).toBeNull()

      // 7. Read-Only connection guard disables + New Table and Truncate/Drop items
      const connSelect = dom.body.querySelector<FakeHTMLSelectElement>('.datanoa-select')
      expect(connSelect).not.toBeNull()
      if (connSelect) {
        connSelect.value = 'conn-ro'
        connSelect.dispatchEvent(new FakeEvent({ type: 'change', bubbles: true }))
      }
      await flushMicrotasks(12)
      expect(newTableBtn?.disabled).toBe(true)
      const roUsersBtn = dom.body.querySelector('.datanoa-sidebar-item[data-table-name="users"]')
      roUsersBtn?.dispatchEvent(
        new FakeEvent({ type: 'contextmenu', bubbles: true, target: roUsersBtn })
      )
      expect(findButtonByText(dom.body, 'Truncate Table...')?.disabled).toBe(true)
      expect(findButtonByText(dom.body, 'Drop Table...')?.disabled).toBe(true)
    })

    it('verifies Light-mode danger solid contrast, :focus-visible outline, and border-collapse: separate in EDITOR_STYLE', () => {
      expect(EDITOR_STYLE).toContain('html.light .datanoa-btn-danger-solid')
      expect(EDITOR_STYLE).toContain('color: #ffffff;')
      expect(EDITOR_STYLE).toContain(':focus-visible')
      expect(EDITOR_STYLE).toContain('border-collapse: separate;')
      expect(EDITOR_STYLE).toContain('.datanoa-spinner')
      expect(EDITOR_STYLE).toContain('.datanoa-col-pinned')
    })
  })

  // ==========================================================================
  // 4. Side Panel (src/panel/panel.html) Contract & Gate A Verification
  // ==========================================================================
  describe('4. Side Panel (panel.html) Wave 11 Contract & Gate A Verification', () => {
    it('contains all Wave 11 panel features, zero eval/new Function/<datalist>, and zero TS2304/TS2552 diagnostics', () => {
      const panelHtmlPath = path.join(REPO_ROOT, 'src', 'panel', 'panel.html')
      const html = fs.readFileSync(panelHtmlPath, 'utf8')

      // Required Wave 11 contracts
      const requiredTokens = [
        'function setButtonLoading(',
        'function createElapsedTimer(',
        'id="testActiveBtn"',
        'id="detectWorkspaceBtn"',
        'executeConfirmedPanelMigration',
        'state.isMigrating',
        'class PanelGridSelection',
        'id="sqlResultTable"',
        'id="createTableModal"',
        'id="dangerTableModal"',
        'id="formatSqlBtn"',
        'id="inspectorNullBadge"',
        'btn-spinner',
      ]
      for (const token of requiredTokens) {
        expect(html).toContain(token)
      }

      // Security & iframe compatibility invariants
      expect(html).not.toMatch(/\beval\s*\(/)
      expect(html).not.toMatch(/\bnew\s+Function\s*\(/)
      expect(html).not.toMatch(/<datalist\b/i)

      // Gate A: TypeScript checkJs semantic validation (zero TS2304 / TS2552)
      const match = /<script\b[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)
      expect(match).not.toBeNull()
      const scriptSource = match?.[1] ?? ''
      const virtualFile = path.join(REPO_ROOT, '__virtual_wave11_panel__.js')
      const options: ts.CompilerOptions = {
        allowJs: true,
        checkJs: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      }

      const defaultHost = ts.createCompilerHost(options, true)
      const virtualHost: ts.CompilerHost = {
        ...defaultHost,
        fileExists: (fileName: string) =>
          path.resolve(fileName) === virtualFile || defaultHost.fileExists(fileName),
        readFile: (fileName: string) =>
          path.resolve(fileName) === virtualFile ? scriptSource : defaultHost.readFile(fileName),
        getSourceFile: (
          fileName: string,
          languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
          onError?: (message: string) => void,
          shouldCreateNewSourceFile?: boolean
        ) => {
          if (path.resolve(fileName) === virtualFile) {
            return ts.createSourceFile(
              fileName,
              scriptSource,
              ts.ScriptTarget.ES2022,
              true,
              ts.ScriptKind.JS
            )
          }
          return defaultHost.getSourceFile(
            fileName,
            languageVersionOrOptions,
            onError,
            shouldCreateNewSourceFile
          )
        },
      }

      const program = ts.createProgram([virtualFile], options, virtualHost)
      const sourceFile = program.getSourceFile(virtualFile)
      expect(sourceFile).toBeDefined()

      const undeclared = program
        .getSemanticDiagnostics(sourceFile)
        .filter((d) => d.code === 2304 || d.code === 2552)
        .map((d) => {
          const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n')
          const pos =
            d.file && d.start !== undefined
              ? d.file.getLineAndCharacterOfPosition(d.start)
              : { line: 0, character: 0 }
          return `TS${d.code} at L${pos.line + 1}:C${pos.character + 1}: ${msg}`
        })

      expect(undeclared).toEqual([])
    })
  })
})
