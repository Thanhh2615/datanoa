/**
 * test/e2e/wave12-stability-perf-ux.e2e.test.ts
 *
 * Wave 12 Comprehensive Stability, 60fps Virtualization & UX Regression E2E Gate:
 * 1. Studio 60fps VirtualDataGrid: row-window cache (zero-rebuild horizontal scroll),
 *    memoized clientFilter, JSON inline edit (no "[object Object]"), BIGINT safe coercion,
 *    ResizeObserver & handleViewportResize (zero blank void), and zebra parity stability.
 * 2. Studio Race Guards & UX Polish: unified gridViewSeq race guard, applyDocumentMetadata
 *    filter reset, Command Palette / Shortcuts / Create Table / Columns Popover / Context Menu /
 *    Query History .active cleanup, SchemaInspectorView single Ctrl+Wheel + scrollTop preservation,
 *    SQL autocomplete deduplication, and EDITOR_STYLE Light/Dark opaque pinned & compact toolbar CSS.
 * 3. Side Panel (src/panel/panel.html) Wave 12 Contracts & Gate A (zero TS2304 / TS2552):
 *    row virtualization, Ctrl+S/Ctrl+F modal guards, stable col.id rename, ClickHouse URL &
 *    RENAME TABLE parity, multi-schema keys, and non-destructive data.cellUpdated banner.
 * 4. Track E: orca-plugin.json contributes.newFiles & Fullscreen Studio + Connect / Edit
 *    8-Engine Connection Modal (Parse URI, placeholderPassword, options, Auto-Detect, Save & Delete).
 * 5. Wave 12 Review Round 1 Fixes (#118, #119, #122): dialect-aware caret SQL splitting & completion,
 *    NOT NULL Delete/Set NULL guard & TEXT NULL->"" coercion, Studio stable col.id rename,
 *    and Side Panel profile.options, opaque sticky td.td-rownum, & MySQL executable-comment DDL guard.
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
import {
  DatanoaStudioEditor,
  VirtualDataGrid,
  SchemaInspectorView,
  computeSmartSqlCompletions,
  extractCaretStatementSql,
} from '../../src/editor/index.js'
import { coerceCellInputValue } from '../../src/editor/grid.js'
import {
  FakeDomHarness,
  FakeElement,
  FakeEvent,
  FakeHTMLButtonElement,
  FakeHTMLInputElement,
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

function createWideBrowseData(rowCount: number, colCount = 8): TableBrowseResult {
  const columns: TableBrowseResult['columns'] = [
    {
      name: 'id',
      type: 'BIGINT',
      nativeType: 'BIGINT',
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
      name: 'payload',
      type: 'JSON',
      nativeType: 'JSONB',
      nullable: true,
      defaultValue: null,
      isPrimaryKey: false,
      isAutoIncrement: false,
    },
  ]
  for (let c = 3; c < colCount; c++) {
    columns.push({
      name: `col_${c}`,
      type: c % 2 === 0 ? 'INTEGER' : 'TEXT',
      nativeType: c % 2 === 0 ? 'INTEGER' : 'TEXT',
      nullable: true,
      defaultValue: null,
      isPrimaryKey: false,
      isAutoIncrement: false,
    })
  }

  const rows: Record<string, unknown>[] = []
  for (let r = 0; r < rowCount; r++) {
    const row: Record<string, unknown> = {
      id: r + 1,
      name: `User_${r}${r % 10 === 0 ? '_needle' : ''}`,
      payload: { id: r + 1, nested: { ok: true, tag: `row_${r}` } },
    }
    for (let c = 3; c < colCount; c++) {
      row[`col_${c}`] = c % 2 === 0 ? r * 10 + c : `val_${r}_${c}`
    }
    rows.push(row)
  }

  return {
    columns,
    rows,
    totalRows: rowCount,
    page: 1,
    pageSize: Math.max(100, rowCount),
    primaryKey: ['id'],
    canEdit: true,
  }
}

function createSampleTableDetails(name = 'users', extraCols = 0): TableDetails {
  const columns: TableDetails['columns'] = [
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
  ]
  for (let i = 0; i < extraCols; i++) {
    columns.push({
      name: `extra_${i}`,
      type: 'TEXT',
      nativeType: 'TEXT',
      nullable: true,
      defaultValue: null,
      isPrimaryKey: false,
      isAutoIncrement: false,
    })
  }
  return {
    name,
    kind: 'table',
    columns,
    primaryKey: ['id'],
    indexes: [{ name: `idx_${name}_name`, unique: false, columns: ['name'] }],
    foreignKeys: [
      {
        constraintName: `fk_${name}_org`,
        column: 'org_id',
        referencedTable: 'orgs',
        referencedColumn: 'id',
      },
    ],
    ddl: `CREATE TABLE "${name}" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "org_id" INTEGER);`,
  }
}

function installMockOrcaOnWindow(
  dom: FakeDomHarness,
  handler: (name: string, input?: unknown) => Promise<unknown> | unknown,
  initialLocalStorage?: Record<string, string>
): RecordedRpcCall[] {
  const calls: RecordedRpcCall[] = []
  const storage = new Map<string, unknown>()
  if (initialLocalStorage) {
    for (const [k, v] of Object.entries(initialLocalStorage)) {
      storage.set(`ls:${k}`, v)
    }
  }
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

describe('Wave 12 — Full-System 60fps Stability, Virtualization & UX Regression Gate', () => {
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
  // 1. Studio 60fps Virtualization, Memoized Filter, JSON Edit & BIGINT Safety
  // ==========================================================================
  describe('1. Studio 60fps VirtualDataGrid, JSON Inline Edit & BIGINT Safety', () => {
    it('rebuilds ZERO tbody rows during horizontal scroll and keeps .datanoa-tr-even zebra parity stable across vertical scrolls', () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const host = dom.document.createElement('div')
      dom.body.appendChild(host)

      const grid = new VirtualDataGrid({
        container: host as unknown as HTMLElement,
        data: createWideBrowseData(500, 12),
        batchMode: true,
      })
      activeGrids.push(grid)

      const scroller = host.querySelector('.datanoa-grid-container')
      const tbody = host.querySelector('.datanoa-grid-table tbody')
      expect(scroller).not.toBeNull()
      expect(tbody).not.toBeNull()

      // Capture exact rendered <tr> node references before horizontal scrolling
      const initialTrs = tbody ? Array.from(tbody.querySelectorAll('tr[data-row-index]')) : []
      expect(initialTrs.length).toBeGreaterThan(0)

      const createElementSpy = vi.spyOn(dom.document, 'createElement')

      // Scroll horizontally 20 ticks without changing scrollTop
      if (scroller) {
        for (let tick = 1; tick <= 20; tick++) {
          scroller.scrollLeft = tick * 120
          scroller.dispatchEvent(new FakeEvent({ type: 'scroll' }))
        }
      }

      // Zero new <tr> or <td> elements created and exact same row nodes remain in tbody
      const createdRowTags = createElementSpy.mock.calls.filter(
        ([tag]) => String(tag).toLowerCase() === 'tr' || String(tag).toLowerCase() === 'td'
      )
      expect(createdRowTags).toHaveLength(0)

      const afterHScrollTrs = tbody ? Array.from(tbody.querySelectorAll('tr[data-row-index]')) : []
      expect(afterHScrollTrs).toHaveLength(initialTrs.length)
      for (let i = 0; i < initialTrs.length; i++) {
        expect(afterHScrollTrs[i]).toBe(initialTrs[i])
      }

      // Vertical scroll checks explicit .datanoa-tr-even parity matches visRow % 2 === 1
      if (scroller && tbody) {
        for (const top of [22, 110, 440, 2200, 5500]) {
          scroller.scrollTop = top
          scroller.dispatchEvent(new FakeEvent({ type: 'scroll' }))
          const trs = tbody.querySelectorAll('tr[data-row-index]')
          expect(trs.length).toBeGreaterThan(0)
          for (const tr of trs) {
            const visRow = Number(tr.dataset.visRow ?? tr.dataset.rowIndex)
            expect(tr.classList.contains('datanoa-tr-even')).toBe(visRow % 2 === 1)
          }
        }
      }
    })

    it('memoizes clientFilter row indices across scroll frames and invalidates cleanly on filter or data mutation', () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const host = dom.document.createElement('div')
      dom.body.appendChild(host)

      const grid = new VirtualDataGrid({
        container: host as unknown as HTMLElement,
        data: createWideBrowseData(400, 6),
        batchMode: true,
      })
      activeGrids.push(grid)

      const scroller = host.querySelector('.datanoa-grid-container')
      expect(scroller).not.toBeNull()

      // Activate client filter matching every 10th row (40 rows out of 400)
      grid.setClientFilter('_needle')

      const tbody = host.querySelector('.datanoa-grid-table tbody')
      const initialFilteredTrs = tbody?.querySelectorAll('tr[data-row-index]') ?? []
      expect(initialFilteredTrs.length).toBeGreaterThan(0)
      expect(initialFilteredTrs[0]?.textContent).toContain('_needle')

      // Spy on JSON.stringify (used when scanning object/JSON cells during filter calculation)
      // Scrolling across filtered rows must NOT re-run the full-table filter scan!
      const stringifySpy = vi.spyOn(JSON, 'stringify')
      if (scroller) {
        for (const top of [0, 88, 176, 352, 528]) {
          scroller.scrollTop = top
          scroller.dispatchEvent(new FakeEvent({ type: 'scroll' }))
        }
      }
      // Only rendered cells format their JSON payload (far fewer than 400 rows * 5 ticks = 2,000)
      expect(stringifySpy.mock.calls.length).toBeLessThan(300)

      // Clearing filter restores all 400 rows (invalidation works)
      grid.setClientFilter('')
      if (scroller) {
        scroller.scrollTop = 0
        scroller.dispatchEvent(new FakeEvent({ type: 'scroll' }))
      }
      const secondRow = tbody?.querySelector('tr[data-row-index="1"]')
      expect(secondRow).not.toBeNull()
      expect(secondRow?.textContent).toContain('User_1')
    })

    it('serializes JSON object cells cleanly in inline editor (NOT "[object Object]") and preserves editor on horizontal scroll', () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const host = dom.document.createElement('div')
      dom.body.appendChild(host)

      const grid = new VirtualDataGrid({
        container: host as unknown as HTMLElement,
        data: createWideBrowseData(120, 8),
        batchMode: true,
      })
      activeGrids.push(grid)

      const scroller = host.querySelector('.datanoa-grid-container')
      const jsonTd = host.querySelector('td[data-row-index="0"][data-col-index="2"]')
      expect(jsonTd).not.toBeNull()

      // Double-click JSON cell (0, 2)
      jsonTd?.dispatchEvent(new FakeEvent({ type: 'dblclick', bubbles: true, target: jsonTd }))
      const jsonInput = host.querySelector<FakeHTMLInputElement>('.datanoa-inline-input')
      expect(jsonInput).not.toBeNull()
      expect(jsonInput?.value).not.toBe('[object Object]')
      expect(JSON.parse(jsonInput?.value ?? '')).toEqual({
        id: 1,
        nested: { ok: true, tag: 'row_0' },
      })

      // Update text and scroll horizontally -> input must remain connected with typed text intact
      if (jsonInput && scroller) {
        jsonInput.value = '{"id":1,"nested":{"ok":false}}'
        scroller.scrollLeft = 480
        scroller.dispatchEvent(new FakeEvent({ type: 'scroll' }))
        expect(jsonInput.isConnected).toBe(true)
        expect(jsonInput.value).toBe('{"id":1,"nested":{"ok":false}}')

        // Commit via Enter
        jsonInput.dispatchEvent(new FakeEvent({ type: 'keydown', key: 'Enter', bubbles: true }))
      }

      expect(host.querySelector('.datanoa-inline-input')).toBeNull()
      expect(grid.getStagedCount()).toBe(1)
    })

    it('enforces safe 64-bit BIGINT coercion via Number.isSafeInteger and avoids mis-coercing POINT/INTERVAL types', () => {
      // Safe integers coerce cleanly
      expect(coerceCellInputValue('42', 1, 'INTEGER')).toBe(42)
      expect(coerceCellInputValue('-9007199254740991', 0, 'BIGINT')).toBe(-9007199254740991)
      expect(coerceCellInputValue('9007199254740991', 0, 'BIGINT')).toBe(9007199254740991)

      // Unsafe >53-bit BIGINT strings MUST remain exact strings (no IEEE-754 precision loss!)
      expect(coerceCellInputValue('9007199254740993', 1, 'BIGINT')).toBe('9007199254740993')
      expect(coerceCellInputValue('-9223372036854775808', '1', 'BIGINT')).toBe('-9223372036854775808')

      // Floating point still works on REAL/NUMERIC
      expect(coerceCellInputValue('3.1415', 1.5, 'REAL')).toBe(3.1415)

      // PostgreSQL POINT / INTERVAL must NOT match numeric regex (avoiding false coercion)
      expect(coerceCellInputValue('(1,2)', null, 'POINT')).toBe('(1,2)')
      expect(coerceCellInputValue('1 day', null, 'INTERVAL')).toBe('1 day')
      expect(coerceCellInputValue('12345', null, 'POINT')).toBe('12345')
      expect(coerceCellInputValue('12345', null, 'INTERVAL')).toBe('12345')
    })

    it('attaches ResizeObserver to grid container, re-renders full row window via handleViewportResize, and disconnects on destroy', () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const observedTargets: unknown[] = []
      let disconnectCalls = 0
      let capturedCallback: ((entries: Array<{ contentRect: { height: number; width: number } }>) => void) | null =
        null

      class TrackingResizeObserver {
        constructor(
          cb: (entries: Array<{ contentRect: { height: number; width: number } }>) => void
        ) {
          capturedCallback = cb
        }
        observe(target: unknown): void {
          observedTargets.push(target)
        }
        unobserve(): void {}
        disconnect(): void {
          disconnectCalls++
        }
      }

      const prevRO = (globalThis as Record<string, unknown>).ResizeObserver
      ;(globalThis as Record<string, unknown>).ResizeObserver = TrackingResizeObserver
      try {
        const host = dom.document.createElement('div')
        dom.body.appendChild(host)

        const grid = new VirtualDataGrid({
          container: host as unknown as HTMLElement,
          data: createWideBrowseData(200, 5),
          batchMode: true,
        })
        activeGrids.push(grid)

        const scroller = host.querySelector('.datanoa-grid-container')
        expect(scroller).not.toBeNull()
        expect(observedTargets).toContain(scroller)

        // Start with small viewport (100px) -> fewer rows
        if (scroller) {
          scroller.clientHeight = 100
          grid.handleViewportResize()
        }
        const rowsSmall = host.querySelectorAll('.datanoa-grid-table tbody tr[data-row-index]').length
        expect(rowsSmall).toBeGreaterThan(0)

        // Simulate ResizeObserver firing when switching SQL/Split -> Data Grid (height jumps to 700px)
        if (scroller) {
          scroller.clientHeight = 700
        }
        capturedCallback?.([{ contentRect: { height: 700, width: 1200 } }])
        const rowsExpanded = host.querySelectorAll(
          '.datanoa-grid-table tbody tr[data-row-index]'
        ).length
        expect(rowsExpanded).toBeGreaterThan(rowsSmall + 10)

        grid.destroy()
        activeGrids.pop()
        expect(disconnectCalls).toBe(1)
      } finally {
        ;(globalThis as Record<string, unknown>).ResizeObserver = prevRO
      }
    })
  })

  // ==========================================================================
  // 2. Studio Race Guards, Metadata Filter Reset, Modals & Schema Inspector
  // ==========================================================================
  describe('2. Studio Race Guards, Metadata Reset, UI Polish & Schema Inspector', () => {
    it('prevents stale data.fetchPage from overwriting a newer SQL result or table load via unified gridViewSeq', async () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const conn: ConnectionProfile = {
        id: 'conn-1',
        name: 'Local SQLite',
        driver: 'sqlite',
        filePath: ':memory:',
      }
      const objects: SchemaObject[] = [
        { name: 'slow_table', kind: 'table' },
        { name: 'fast_table', kind: 'table' },
      ]
      const slowFetchDeferred = createDeferred<TableBrowseResult>()
      let tableDetailsCalls = 0

      installMockOrcaOnWindow(dom, (name, input) => {
        if (name === 'connections.list') return [conn]
        if (name === 'schema.listObjects') return objects
        if (name === 'schema.tableDetails') {
          tableDetailsCalls++
          return createSampleTableDetails(String((input as { table?: string })?.table || 'slow_table'))
        }
        if (name === 'data.fetchPage') {
          const tbl = (input as { table?: string })?.table
          if (tbl === 'slow_table') {
            return slowFetchDeferred.promise
          }
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
                name: 'label',
                type: 'TEXT',
                nativeType: 'TEXT',
                nullable: false,
                defaultValue: null,
                isPrimaryKey: false,
                isAutoIncrement: false,
              },
            ],
            rows: [{ id: 99, label: 'FRESH_FAST_TABLE' }],
            totalRows: 1,
            page: 1,
            pageSize: 100,
            primaryKey: ['id'],
            canEdit: true,
          } satisfies TableBrowseResult
        }
        if (name === 'query.run') {
          return {
            columns: [{ name: 'result' }],
            rows: [{ result: 'SQL_FRESH_WINNER' }],
            rowCount: 1,
            executionTimeMs: 2,
            truncated: false,
            isSelect: true,
          } satisfies QueryResult
        }
        return null
      })

      const editor = new DatanoaStudioEditor()
      activeEditors.push(editor)
      await flushMicrotasks(10)

      // slow_table fetch is still pending; now execute SQL (bumps unified gridViewSeq)
      editor.getSqlConsole()?.setText('SELECT 1 AS result;')
      await editor.executeSql(false)
      await flushMicrotasks(8)

      expect(dom.body.querySelector('.datanoa-grid-table tbody')?.textContent).toContain(
        'SQL_FRESH_WINNER'
      )

      // Now resolve the stale slow_table fetch — it MUST be discarded!
      slowFetchDeferred.resolve({
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
        ],
        rows: [{ id: 1, name: 'STALE_SLOW_TABLE_SHOULD_NOT_WIN' }],
        totalRows: 1,
        page: 1,
        pageSize: 100,
        primaryKey: ['id'],
        canEdit: true,
      })
      await flushMicrotasks(10)

      const gridText = dom.body.querySelector('.datanoa-grid-table tbody')?.textContent ?? ''
      expect(gridText).toContain('SQL_FRESH_WINNER')
      expect(gridText).not.toContain('STALE_SLOW_TABLE_SHOULD_NOT_WIN')
      // Table details should not be spammed eagerly when inspector isn't active
      expect(tableDetailsCalls).toBeLessThanOrEqual(3)
    })

    it('resets restored WHERE, ORDER BY, and page in applyDocumentMetadata when opening a different table', async () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const conn: ConnectionProfile = {
        id: 'conn-1',
        name: 'Local SQLite',
        driver: 'sqlite',
        filePath: ':memory:',
      }
      const objects: SchemaObject[] = [
        { name: 'users', kind: 'table' },
        { name: 'orders', kind: 'table' },
      ]

      const savedViewState = JSON.stringify({
        activeConnectionId: 'conn-1',
        activeTable: 'users',
        activeWhereClause: "status = 'legacy_only'",
        activeOrderByClause: 'created_at DESC',
        currentPage: 4,
      })

      const calls = installMockOrcaOnWindow(
        dom,
        (name, input) => {
          if (name === 'connections.list') return [conn]
          if (name === 'schema.listObjects') return objects
          if (name === 'schema.tableDetails') {
            return createSampleTableDetails(String((input as { table?: string })?.table || 'orders'))
          }
          if (name === 'data.fetchPage') return createWideBrowseData(5, 4)
          return null
        },
        { 'datanoa.studioViewState.v1': savedViewState }
      )

      const editor = new DatanoaStudioEditor()
      activeEditors.push(editor)
      await flushMicrotasks(12)

      // Open document targeting 'orders' instead of 'users'
      editor.applyDocumentMetadata(
        '-- datanoa: connectionId=conn-1\n-- datanoa: table=orders\nSELECT * FROM orders;\n'
      )
      await flushMicrotasks(12)

      const orderFetchCalls = calls.filter(
        (c) => c.name === 'data.fetchPage' && (c.input as { table?: string })?.table === 'orders'
      )
      expect(orderFetchCalls.length).toBeGreaterThanOrEqual(1)
      const latestOrderCall = orderFetchCalls[orderFetchCalls.length - 1]?.input as {
        page?: number
        whereClause?: string
        orderByClause?: string
      }
      expect(latestOrderCall.page).toBe(1)
      expect(latestOrderCall.whereClause).toBeUndefined()
      expect(latestOrderCall.orderByClause).toBeUndefined()
    })

    it('verifies Command Palette classes & modal guard, Shortcuts <kbd> & input guard, Create Table grid, History .active cleanup, and Popover/Menu clamping', async () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const conn: ConnectionProfile = {
        id: 'conn-1',
        name: 'Local SQLite',
        driver: 'sqlite',
        filePath: ':memory:',
      }
      const objects: SchemaObject[] = [{ name: 'users', kind: 'table' }]

      installMockOrcaOnWindow(dom, (name) => {
        if (name === 'connections.list') return [conn]
        if (name === 'schema.listObjects') return objects
        if (name === 'data.fetchPage') return createWideBrowseData(20, 12)
        if (name === 'schema.tableDetails') return createSampleTableDetails('users')
        if (name === 'query.history.list') return []
        return null
      })

      const editor = new DatanoaStudioEditor()
      activeEditors.push(editor)
      await flushMicrotasks(12)

      // 1. Command Palette uses dedicated input/list/item classes
      dom.window.dispatchEvent(new FakeEvent({ type: 'keydown', key: 'k', ctrlKey: true, bubbles: true }))
      const palette = dom.body.querySelector('.datanoa-cmd-palette')
      expect(palette).not.toBeNull()
      expect(palette?.querySelector('.datanoa-cmd-palette-input')).not.toBeNull()
      expect(palette?.querySelector('.datanoa-cmd-palette-list')).not.toBeNull()
      expect(palette?.querySelector('.datanoa-cmd-palette-item')).not.toBeNull()
      dom.window.dispatchEvent(new FakeEvent({ type: 'keydown', key: 'Escape', bubbles: true }))
      expect(dom.body.querySelector('.datanoa-cmd-palette')).toBeNull()

      // 2. Create Table modal uses .datanoa-struct-grid, and Ctrl+K does NOT close an open modal!
      findButtonByText(dom.body, '+ New Table')?.click()
      const createModal = dom.body.querySelector('.datanoa-create-table-modal')
      expect(createModal).not.toBeNull()
      expect(createModal?.querySelector('.datanoa-struct-grid')).not.toBeNull()

      dom.window.dispatchEvent(new FakeEvent({ type: 'keydown', key: 'k', ctrlKey: true, bubbles: true }))
      // Create Table modal stays intact; Command Palette does not hijack/close it
      expect(dom.body.querySelector('.datanoa-create-table-modal')).not.toBeNull()
      expect(dom.body.querySelector('.datanoa-cmd-palette')).toBeNull()
      dom.window.dispatchEvent(new FakeEvent({ type: 'keydown', key: 'Escape', bubbles: true }))
      expect(dom.body.querySelector('.datanoa-create-table-modal')).toBeNull()

      // 3. Shortcuts modal renders <kbd> elements, and Ctrl+/ inside an <input> does NOT hijack typing
      const filterInput = dom.body.querySelector<FakeHTMLInputElement>('input')
      expect(filterInput).not.toBeNull()
      dom.window.dispatchEvent(
        new FakeEvent({
          type: 'keydown',
          key: '/',
          ctrlKey: true,
          bubbles: true,
          target: filterInput,
        })
      )
      expect(dom.body.querySelector('.datanoa-shortcuts-modal')).toBeNull()

      findButtonByText(dom.body, '?')?.click()
      const shortcutsModal = dom.body.querySelector('.datanoa-shortcuts-modal')
      expect(shortcutsModal).not.toBeNull()
      expect(shortcutsModal?.querySelectorAll('kbd').length).toBeGreaterThan(3)
      dom.window.dispatchEvent(new FakeEvent({ type: 'keydown', key: 'Escape', bubbles: true }))
      expect(dom.body.querySelector('.datanoa-shortcuts-modal')).toBeNull()

      // 4. Query History button .active cleared when switching from Split View to Data Grid
      const histBtn = findButtonByText(dom.body, 'Query History')
      expect(histBtn).not.toBeNull()
      histBtn?.click()
      await flushMicrotasks(4)
      expect(histBtn?.classList.contains('active')).toBe(true)

      findButtonByText(dom.body, 'Data Grid')?.click()
      await flushMicrotasks(4)
      expect(histBtn?.classList.contains('active')).toBe(false)

      // 5. Columns Popover clamps to viewport height and Context Menu clamps to viewport
      dom.window.innerWidth = 780
      dom.window.innerHeight = 680
      const colsBtn = findButtonContaining(dom.body, 'Columns')
      expect(colsBtn).not.toBeNull()
      colsBtn?.click()
      const colsPopover = dom.body.querySelector('.datanoa-cols-popover')
      expect(colsPopover).not.toBeNull()
      const popTop = Number.parseFloat(colsPopover?.style.top || '0')
      const popLeft = Number.parseFloat(colsPopover?.style.left || '0')
      expect(popTop).toBeGreaterThanOrEqual(0)
      expect(popLeft).toBeGreaterThanOrEqual(0)
      colsBtn?.click()

      const td = dom.body.querySelector('td[data-row-index="0"][data-col-index="1"]')
      expect(td).not.toBeNull()
      td?.dispatchEvent(
        new FakeEvent({
          type: 'contextmenu',
          bubbles: true,
          target: td,
          clientX: 775,
          clientY: 675,
        })
      )
      const ctxMenu = dom.body.querySelector('.datanoa-context-menu')
      expect(ctxMenu).not.toBeNull()
      const menuTop = Number.parseFloat(ctxMenu?.style.top || '0')
      const menuLeft = Number.parseFloat(ctxMenu?.style.left || '0')
      expect(menuTop).toBeGreaterThanOrEqual(0)
      expect(menuLeft).toBeGreaterThanOrEqual(0)
      expect(menuTop).toBeLessThan(675)
      expect(menuLeft).toBeLessThan(775)
    })

    it('SchemaInspectorView stops Ctrl+Wheel propagation, closes combobox on horizontal scroll, and preserves scrollTop on + Column', () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const host = dom.document.createElement('div')
      dom.body.appendChild(host)

      const inspector = new SchemaInspectorView(host as unknown as HTMLElement, {
        dialect: 'postgres',
        onApplyMigration: async () => {},
      })
      activeInspectors.push(inspector)

      inspector.setDetails(createSampleTableDetails('wide_items', 18), 'postgres')

      const scrollBody = host.querySelector('.datanoa-inspector-scroll-body')
      expect(scrollBody).not.toBeNull()
      if (scrollBody) {
        scrollBody.scrollTop = 240
      }

      // Click + Column -> render() MUST preserve scrollTop on the newly rendered scrollBody
      const addColBtn = findButtonContaining(host, '+ Column')
      expect(addColBtn).not.toBeNull()
      addColBtn?.click()

      const nextScrollBody = host.querySelector('.datanoa-inspector-scroll-body')
      expect(nextScrollBody).not.toBeNull()
      expect(nextScrollBody?.scrollTop).toBe(240)

      // Open a type combobox popover, then dispatch Ctrl+Wheel on .datanoa-matrix-scroll
      const comboToggle = host.querySelector<FakeHTMLButtonElement>('.datanoa-combo-toggle')
      expect(comboToggle).not.toBeNull()
      comboToggle?.click()
      expect(dom.body.querySelector('.datanoa-combo-popover')).not.toBeNull()

      const matrixScroll = host.querySelector('.datanoa-matrix-scroll')
      expect(matrixScroll).not.toBeNull()
      if (matrixScroll) {
        matrixScroll.scrollWidth = 1200
        matrixScroll.clientWidth = 500
        matrixScroll.scrollLeft = 0
      }

      let parentSawWheel = false
      nextScrollBody?.addEventListener('wheel', () => {
        parentSawWheel = true
      })

      const wheelEvent = new FakeEvent({
        type: 'wheel',
        ctrlKey: true,
        deltaY: 100,
        bubbles: true,
        cancelable: true,
      })
      matrixScroll?.dispatchEvent(wheelEvent)

      expect(wheelEvent.defaultPrevented).toBe(true)
      expect(wheelEvent.propagationStopped).toBe(true)
      expect(parentSawWheel).toBe(false)
      expect(matrixScroll?.scrollLeft).toBeGreaterThan(0)

      // Native horizontal scroll event (triggered by scrollLeft update) closes active combobox popover
      matrixScroll?.dispatchEvent(new FakeEvent({ type: 'scroll' }))
      expect(dom.body.querySelector('.datanoa-combo-popover')).toBeNull()
    })

    it('deduplicates SQL autocomplete completions case-insensitively and preserves Wave 12 CSS invariants', () => {
      const schema: Record<string, string[]> = {
        users: ['id', 'ID', 'email', 'status'],
        orders: ['id', 'user_id', 'status'],
      }
      const result = computeSmartSqlCompletions(
        'SELECT  FROM users',
        7,
        'postgres',
        schema,
        'users',
        true
      )
      expect(result).not.toBeNull()
      const options = result?.options ?? []
      expect(options.length).toBeGreaterThan(0)
      const seenLower = new Set<string>()
      for (const item of options) {
        const key = item.label.toLowerCase()
        expect(seenLower.has(key)).toBe(false)
        seenLower.add(key)
      }

      // Wave 12 Studio CSS invariants
      expect(EDITOR_STYLE).toContain('.datanoa-tr-even')
      expect(EDITOR_STYLE).toContain('color-mix(in srgb')
      expect(EDITOR_STYLE).toContain('.datanoa-cmd-palette-input')
      expect(EDITOR_STYLE).toContain('height: 38px;')
      expect(EDITOR_STYLE).toContain('@media (max-width: 900px)')
    })
  })

  // ==========================================================================
  // 3. Side Panel (src/panel/panel.html) Wave 12 Contracts & Gate A Check
  // ==========================================================================
  describe('3. Side Panel (panel.html) Wave 12 Contracts & Gate A Verification', () => {
    it('enforces all Wave 12 Side Panel virtualization, modal/rename/ClickHouse/multi-schema/remote-sync contracts', () => {
      const panelHtmlPath = path.join(REPO_ROOT, 'src', 'panel', 'panel.html')
      const html = fs.readFileSync(panelHtmlPath, 'utf8')

      // 1. Virtualized row markers & zero sqlRowProxy
      const virtualizationTokens = [
        'const dataVirt = {',
        'const sqlVirt = {',
        'function renderDataVirtualWindow(',
        'function renderSqlVirtualWindow(',
        'function patchRenderedDataCell(',
        'tr.dataset.rowIdx = String(rowIdx)',
        'detachRow(',
        'rowNumWidth: 56',
        'sqlSortColIdx',
      ]
      for (const token of virtualizationTokens) {
        expect(html).toContain(token)
      }
      expect(html).not.toContain('sqlRowProxy')

      // 2. Ctrl+S & Ctrl+F modal/form guard + capture-phase Escape
      expect(html).toContain('function isAnyModalOpen()')
      expect(html).toContain('if (state.formOpen || isAnyModalOpen()) return')

      // 3. Stable col.id rename tracking (prevents PK index corruption on name collision)
      expect(html).toContain('function syncPanelColRename(colId, newName)')
      expect(html).toContain('idx.columnRefs')
      expect(html).toContain('fk.columnId')

      // 4. ClickHouse custom URL & ClickHouse RENAME TABLE parity
      expect(html).toContain('id="formClickhouseUrl"')
      expect(html).toContain('profile.url = chUrl')
      expect(html).toContain("if (driver === 'mysql' || driver === 'mariadb' || driver === 'clickhouse')")
      expect(html).toContain('RENAME TABLE ${qCur()} TO ${quoteTableRef(finalTable, draft.schema, driver)};')

      // 5. Multi-schema keys, race cancellation & formatPanelSql unary minus guard
      expect(html).toContain('function cancelPendingDataAndSchemaLoads()')
      expect(html).toContain('function formatPanelSql(sql, driver)')
      expect(html).toContain('function makeTableKey(connectionId, tableName, schemaName)')
      expect(html).toContain('function encodeTableSelectValue(schemaName, tableName)')
      expect(html).toContain('function decodeTableSelectValue(encoded)')
      expect(html).toContain('tableDetailsSeqByKey')

      // 6. data.cellUpdated non-destructive banner when staged edits exist
      expect(html).toContain('id="dataRemoteChangeBanner"')
      expect(html).toContain("if (payload?.connectionId && payload.connectionId !== state.activeConnectionId) return")
      expect(html).toContain("if (payload?.schema !== undefined && (payload.schema || '') !== (state.activeSchema || '')) return")
      expect(html).toContain('if (submittingChanges) return')
      expect(html).toContain('if (getStagedCount() > 0)')

      // 7. Light/Dark opaque pinned & selection CSS tokens + --border-strong
      expect(html).toContain('--border-strong:')
      expect(html).toContain('color-mix(in srgb')

      // 8. Security & iframe invariants
      expect(html).not.toMatch(/\beval\s*\(/)
      expect(html).not.toMatch(/\bnew\s+Function\s*\(/)
      expect(html).not.toMatch(/<datalist\b/i)
    })

    it('passes Gate A: compiles panel.html <script type="module"> with zero TS2304/TS2552 diagnostics', () => {
      const panelHtmlPath = path.join(REPO_ROOT, 'src', 'panel', 'panel.html')
      const html = fs.readFileSync(panelHtmlPath, 'utf8')
      const match = /<script\b[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)
      expect(match).not.toBeNull()

      const scriptSource = match?.[1] ?? ''
      const virtualFile = path.join(REPO_ROOT, '__virtual_wave12_panel__.js')
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

  // ==========================================================================
  // 4. Track E — orca-plugin.json newFiles & Fullscreen Studio Connection Modal
  // ==========================================================================
  describe('4. Track E — orca-plugin.json contributes.newFiles & Studio Connection Modal', () => {
    it('defines contributes.newFiles with datanoa-studio (.datanoa) in orca-plugin.json', () => {
      const manifestPath = path.join(REPO_ROOT, 'orca-plugin.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        contributes?: {
          newFiles?: Array<{ id?: string; title?: string; extension?: string; template?: string }>
          customEditors?: Array<{ id?: string; extensions?: string[] }>
        }
      }

      const newFiles = manifest.contributes?.newFiles ?? []
      expect(newFiles).toHaveLength(1)

      const studioFile = newFiles.find((f) => f.id === 'datanoa-studio')
      expect(studioFile).toBeDefined()
      expect(studioFile?.extension).toBe('.datanoa')
      expect(studioFile?.template).toBe('templates/studio.datanoa')
      expect(fs.existsSync(path.join(REPO_ROOT, 'templates', 'studio.datanoa'))).toBe(true)

      const studioEditor = manifest.contributes?.customEditors?.find((e) => e.id === 'datanoa-studio')
      expect(studioEditor?.extensions).toContain('.datanoa')
      expect(studioEditor?.extensions).toContain('.sql')
    })

    it('renders + Connect / Edit controls, empty-sidebar CTA, Command Palette actions, and full 8-Engine Connection Modal lifecycle', async () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const savedConns: ConnectionProfile[] = []
      const objectsByConn: Record<string, SchemaObject[]> = {
        'conn-neon-saved': [{ name: 'accounts', schema: 'public', kind: 'table' }],
      }

      const calls = installMockOrcaOnWindow(dom, (name, input) => {
        if (name === 'connections.list') return [...savedConns]
        if (name === 'workspace.detectConnections') {
          return {
            envConnections: [
              {
                key: 'DATABASE_URL',
                uri: 'postgres://user:pass@neon.example.com:5432/app?options=endpoint%3Dep-neon-123',
                maskedUri: 'postgres://user:***@neon.example.com:5432/app?options=endpoint%3Dep-neon-123',
                sourceFile: '.env',
                driver: 'postgres',
                name: 'Neon App',
              },
            ],
            sqliteFiles: [
              { name: 'alpha.db', filePath: 'D:\\work\\alpha.db', sizeBytes: 4096, sizeLabel: '4 KB' },
              { name: 'beta_analytics.db', filePath: 'D:\\work\\beta_analytics.db', sizeBytes: 8192, sizeLabel: '8 KB' },
            ],
          }
        }
        if (name === 'connection.parseUri') {
          const uri = String((input as { uri?: string })?.uri ?? '')
          if (uri.includes('[YOUR-PASSWORD]')) {
            return {
              ok: true,
              placeholderPassword: true,
              profile: {
                driver: 'postgres',
                host: 'db.proj.supabase.co',
                port: 5432,
                database: 'postgres',
                user: 'postgres',
                ssl: true,
              },
            }
          }
          return {
            ok: true,
            placeholderPassword: false,
            password: 'secret-pass',
            profile: {
              name: 'Neon Prod',
              driver: 'postgres',
              host: 'ep-neon-123.us-east-2.aws.neon.tech',
              port: 5432,
              database: 'neondb',
              user: 'neondb_owner',
              ssl: true,
              options: 'endpoint=ep-neon-123',
            },
          }
        }
        if (name === 'connection.test') {
          return { ok: true, message: 'Connected cleanly (4ms)' }
        }
        if (name === 'connection.save') {
          const payload = input as { profile: ConnectionProfile }
          const stored: ConnectionProfile = {
            ...payload.profile,
            id: 'conn-neon-saved',
            hasPassword: true,
          }
          const idx = savedConns.findIndex((c) => c.id === stored.id)
          if (idx >= 0) savedConns[idx] = stored
          else savedConns.push(stored)
          return { ok: true, id: stored.id }
        }
        if (name === 'connection.delete') {
          const id = String((input as { id?: string })?.id ?? '')
          const idx = savedConns.findIndex((c) => c.id === id)
          if (idx >= 0) savedConns.splice(idx, 1)
          return { ok: true }
        }
        if (name === 'schema.listObjects') {
          const connId = String((input as { connectionId?: string })?.connectionId ?? '')
          return objectsByConn[connId] ?? []
        }
        if (name === 'data.fetchPage') return createWideBrowseData(3, 4)
        if (name === 'schema.tableDetails') return createSampleTableDetails('accounts')
        return null
      })

      const editor = new DatanoaStudioEditor()
      activeEditors.push(editor)
      await flushMicrotasks(12)

      // 1. Toolbar cluster buttons & empty sidebar CTA
      const connCluster = dom.body.querySelector('.datanoa-conn-cluster')
      expect(connCluster).not.toBeNull()
      const addConnBtn = connCluster?.querySelector<FakeHTMLButtonElement>('.datanoa-add-conn-btn')
      const editConnBtn = connCluster?.querySelector<FakeHTMLButtonElement>('.datanoa-edit-conn-btn')
      expect(addConnBtn).not.toBeNull()
      expect(editConnBtn).not.toBeNull()
      expect(editConnBtn?.disabled).toBe(true)

      const emptySidebarCta = findButtonByText(dom.body, '+ Connect Database')
      expect(emptySidebarCta).not.toBeNull()

      // 2. Command Palette includes "New Database Connection..." & "Report Bug / Request Feature..."
      dom.window.dispatchEvent(new FakeEvent({ type: 'keydown', key: 'k', ctrlKey: true, bubbles: true }))
      const palette1 = dom.body.querySelector('.datanoa-cmd-palette')
      expect(palette1?.textContent).toContain('New Database Connection...')
      expect(palette1?.textContent).toContain('Report Bug / Request Feature...')
      dom.window.dispatchEvent(new FakeEvent({ type: 'keydown', key: 'Escape', bubbles: true }))

      // 2b. Feedback / Report Issue button opens privacy-safe feedback modal targeting Thanhh2615/datanoa
      const feedbackBtn = dom.body.querySelector<FakeHTMLButtonElement>('.datanoa-feedback-btn')
      expect(feedbackBtn).not.toBeNull()
      feedbackBtn?.click()
      await flushMicrotasks(4)
      const feedbackModal = dom.body.querySelector('.datanoa-feedback-modal')
      expect(feedbackModal).not.toBeNull()
      const diagText = feedbackModal?.querySelector('.datanoa-feedback-diag')?.textContent ?? ''
      expect(diagText).toContain('Datanoa v1.0.0')
      expect(diagText).toContain('Surface: Fullscreen Studio')
      dom.window.dispatchEvent(new FakeEvent({ type: 'keydown', key: 'Escape', bubbles: true }))
      expect(dom.body.querySelector('.datanoa-feedback-modal')).toBeNull()

      // 3. Open + Connect modal -> verify all 8 engine tiles
      addConnBtn?.click()
      await flushMicrotasks(10)

      const modal = dom.body.querySelector('.datanoa-conn-modal')
      expect(modal).not.toBeNull()

      const expectedDrivers = [
        'sqlite',
        'postgres',
        'mysql',
        'mariadb',
        'cockroachdb',
        'clickhouse',
        'redis',
        'libsql',
      ]
      const tileDrivers = Array.from(modal?.querySelectorAll('.datanoa-engine-tile') ?? []).map(
        (el) => el.dataset.driver
      )
      expect(tileDrivers).toEqual(expectedDrivers)

      // 4. Auto-Detect (.env & .db) + SQLite .db search filter
      const detectBtn = modal ? findButtonByText(modal, 'Auto-Detect (.env & .db)') : null
      expect(detectBtn).not.toBeNull()
      detectBtn?.click()
      await flushMicrotasks(8)

      const discoveredBox = modal?.querySelector('.datanoa-conn-discovered')
      expect(discoveredBox?.textContent).toContain('alpha.db')
      expect(discoveredBox?.textContent).toContain('beta_analytics.db')

      const dbSearchInput = discoveredBox?.querySelector<FakeHTMLInputElement>('input')
      expect(dbSearchInput).not.toBeNull()
      if (dbSearchInput) {
        dbSearchInput.value = 'beta'
        dbSearchInput.dispatchEvent(new FakeEvent({ type: 'input', bubbles: true }))
      }
      expect(discoveredBox?.textContent).toContain('beta_analytics.db')
      expect(discoveredBox?.textContent).not.toContain('alpha.db')

      // 5. Parse URI with placeholderPassword -> surfaces error notice
      const uriInp = modal?.querySelector<FakeHTMLInputElement>('.datanoa-conn-uri-input')
      const parseBtn = modal ? findButtonByText(modal, 'Parse URI') : null
      expect(uriInp).not.toBeNull()
      expect(parseBtn).not.toBeNull()

      if (uriInp) {
        uriInp.value = 'postgresql://postgres:[YOUR-PASSWORD]@db.proj.supabase.co:5432/postgres'
      }
      parseBtn?.click()
      await flushMicrotasks(8)

      const noticeBox = modal?.querySelector('.datanoa-modal-box')
      expect(noticeBox?.classList.contains('error')).toBe(true)
      expect(noticeBox?.textContent.toLowerCase()).toContain('password')

      // 6. Parse real Neon URI -> preserves profile.options, Test Connection & Save & Connect
      if (uriInp) {
        uriInp.value =
          'postgresql://neondb_owner:secret-pass@ep-neon-123.us-east-2.aws.neon.tech:5432/neondb?sslmode=require&options=endpoint%3Dep-neon-123'
      }
      parseBtn?.click()
      await flushMicrotasks(8)

      const testBtn = modal ? findButtonByText(modal, 'Test Connection') : null
      expect(testBtn).not.toBeNull()
      testBtn?.click()
      await flushMicrotasks(8)

      const testCalls = calls.filter((c) => c.name === 'connection.test')
      expect(testCalls.length).toBeGreaterThanOrEqual(1)
      expect((testCalls[0]?.input as { profile?: ConnectionProfile })?.profile?.options).toBe(
        'endpoint=ep-neon-123'
      )
      expect(noticeBox?.classList.contains('success')).toBe(true)

      const saveBtn = modal ? findButtonByText(modal, 'Save & Connect') : null
      expect(saveBtn).not.toBeNull()
      saveBtn?.click()
      await flushMicrotasks(16)

      // Modal closed, connection saved with options & auto-activated
      expect(dom.body.querySelector('.datanoa-conn-modal')).toBeNull()
      const saveCalls = calls.filter((c) => c.name === 'connection.save')
      expect(saveCalls).toHaveLength(1)
      expect((saveCalls[0]?.input as { profile?: ConnectionProfile })?.profile?.options).toBe(
        'endpoint=ep-neon-123'
      )
      expect(editConnBtn?.disabled).toBe(false)
      expect(
        calls.some(
          (c) =>
            c.name === 'schema.listObjects' &&
            (c.input as { connectionId?: string })?.connectionId === 'conn-neon-saved'
        )
      ).toBe(true)

      // 7. Command Palette now exposes "Edit Active Connection..."
      dom.window.dispatchEvent(new FakeEvent({ type: 'keydown', key: 'k', ctrlKey: true, bubbles: true }))
      const palette2 = dom.body.querySelector('.datanoa-cmd-palette')
      expect(palette2?.textContent).toContain('Edit Active Connection...')
      dom.window.dispatchEvent(new FakeEvent({ type: 'keydown', key: 'Escape', bubbles: true }))

      // 8. Edit modal + 2-click Delete Connection -> Confirm Delete?
      editConnBtn?.click()
      await flushMicrotasks(8)
      const editModal = dom.body.querySelector('.datanoa-conn-modal')
      expect(editModal).not.toBeNull()

      const deleteBtn = editModal ? findButtonByText(editModal, 'Delete Connection') : null
      expect(deleteBtn).not.toBeNull()

      // First click arms confirmation without deleting
      deleteBtn?.click()
      await flushMicrotasks(4)
      expect(deleteBtn?.textContent.trim()).toBe('Confirm Delete?')
      expect(calls.filter((c) => c.name === 'connection.delete')).toHaveLength(0)

      // Second click executes connection.delete & closes modal
      deleteBtn?.click()
      await flushMicrotasks(12)
      expect(calls.filter((c) => c.name === 'connection.delete')).toHaveLength(1)
      expect(dom.body.querySelector('.datanoa-conn-modal')).toBeNull()
    })
  })

  // ==========================================================================
  // 5. Wave 12 Review Round 1 Fixes (#118 Panel, #119 Backend, #122 Studio)
  // ==========================================================================
  describe('5. Wave 12 Review Round 1 Fixes (#118, #119, #122)', () => {
    it('Studio console.ts splits caret SQL and computes completions dialect-aware for MySQL escaped quotes and # comments', () => {
      const mysqlDoc =
        "SELECT 'it\\'s; still one' AS msg # trailing; comment\nFROM users;\nSELECT id FROM orders;"

      // Caret inside first MySQL statement (after escaped quote and before real semicolon)
      const stmt1 = extractCaretStatementSql(
        {
          doc: { toString: () => mysqlDoc },
          selection: { main: { from: 15, to: 15, head: 15, empty: true } },
          sliceDoc: (from: number, to: number) => mysqlDoc.slice(from, to),
        },
        'mysql'
      )
      expect(stmt1).toContain("SELECT 'it\\'s; still one' AS msg")
      expect(stmt1).toContain('FROM users')
      expect(stmt1).not.toContain('FROM orders')

      // Autocomplete after `u.` in a 2nd statement following a MySQL # comment containing a semicolon
      const compDoc = "SELECT 'a\\';b' # comment; ignored\n; SELECT u. FROM users u"
      const pos = compDoc.indexOf('u.') + 2
      const completion = computeSmartSqlCompletions(
        compDoc,
        pos,
        'mysql',
        { users: ['id', 'email'] },
        undefined,
        true
      )
      const labels = (completion?.options ?? []).map((o) => o.label)
      expect(labels).toContain('id')
      expect(labels).toContain('email')
    })

    it('Studio grid.ts blocks Delete/Set NULL on NOT NULL columns while coercing NULL -> "" on TEXT cells', () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const host = dom.document.createElement('div')
      dom.body.appendChild(host)

      const notifications: string[] = []
      const updateCalls: Array<{ col: string; val: unknown }> = []

      const data: TableBrowseResult = {
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
            name: 'note',
            type: 'TEXT',
            nativeType: 'TEXT',
            nullable: true,
            defaultValue: null,
            isPrimaryKey: false,
            isAutoIncrement: false,
          },
        ],
        rows: [{ id: 1, name: 'Alice', note: 'hello' }],
        totalRows: 1,
        page: 1,
        pageSize: 100,
        primaryKey: ['id'],
        canEdit: true,
      }

      const grid = new VirtualDataGrid({
        container: host as unknown as HTMLElement,
        data,
        batchMode: false,
        onNotify: (msg) => notifications.push(msg),
        onUpdateCell: async ({ column, newValue }) => {
          updateCalls.push({ col: column, val: newValue })
          return { ok: true, affectedRows: 1 }
        },
      })
      activeGrids.push(grid)

      const scroller = host.querySelector('.datanoa-grid-container')
      // Select NOT NULL 'name' cell (0, 1) and press Delete -> must NOT null it or fire RPC
      const nameTd = host.querySelector('td[data-row-index="0"][data-col-index="1"]')
      nameTd?.dispatchEvent(new FakeEvent({ type: 'mousedown', bubbles: true, target: nameTd, button: 0 }))
      dom.window.dispatchEvent(new FakeEvent({ type: 'mouseup', bubbles: true, button: 0 }))
      scroller?.dispatchEvent(new FakeEvent({ type: 'keydown', key: 'Delete', bubbles: true }))

      expect(updateCalls).toHaveLength(0)
      expect(nameTd?.textContent.trim()).toBe('Alice')
      expect(notifications.some((n) => /NOT NULL/i.test(n))).toBe(true)

      // Select nullable 'note' cell (0, 2) and press Delete -> allowed & triggers update to null
      const noteTd = host.querySelector('td[data-row-index="0"][data-col-index="2"]')
      noteTd?.dispatchEvent(new FakeEvent({ type: 'mousedown', bubbles: true, target: noteTd, button: 0 }))
      dom.window.dispatchEvent(new FakeEvent({ type: 'mouseup', bubbles: true, button: 0 }))
      scroller?.dispatchEvent(new FakeEvent({ type: 'keydown', key: 'Delete', bubbles: true }))

      expect(updateCalls).toHaveLength(1)
      expect(updateCalls[0]).toEqual({ col: 'note', val: null })

      // coerceCellInputValue: empty string on NULL TEXT -> "" (while numeric NULL stays null)
      expect(coerceCellInputValue('', null, 'TEXT')).toBe('')
      expect(coerceCellInputValue('', null, 'VARCHAR(128)')).toBe('')
      expect(coerceCellInputValue('', null, 'INTEGER')).toBeNull()
    })

    it('Studio schema-inspector.ts tracks column renames by stable col.id without corrupting unrelated PK indexes, and Side Panel panel.html satisfies Round 1 contracts', () => {
      const dom = activeDomHarnesses[activeDomHarnesses.length - 1]
      const host = dom.document.createElement('div')
      dom.body.appendChild(host)

      const inspector = new SchemaInspectorView(host as unknown as HTMLElement, {
        dialect: 'postgres',
        onApplyMigration: async () => {},
      })
      activeInspectors.push(inspector)

      inspector.setDetails(
        {
          name: 'items',
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
              name: 'code',
              type: 'TEXT',
              nativeType: 'TEXT',
              nullable: false,
              defaultValue: null,
              isPrimaryKey: false,
              isAutoIncrement: false,
            },
          ],
          primaryKey: ['id'],
          indexes: [
            { name: 'pk_items_id', unique: true, columns: ['id'], isPrimary: true },
            { name: 'idx_items_code', unique: false, columns: ['code'], isPrimary: false },
          ],
          foreignKeys: [],
          ddl: 'CREATE TABLE "items" ("id" INTEGER PRIMARY KEY, "code" TEXT NOT NULL);',
        },
        'postgres'
      )

      // Add a new index (defaults to PK column 'id') so we verify both live pill & existing PK card preservation
      findButtonContaining(host, '+ Index')?.click()

      // Rename 'code' -> 'id' (collision with PK column) -> 'code_v2'
      const nameInputs = host.querySelectorAll<FakeHTMLInputElement>('.datanoa-struct-cell-input')
      const codeInput = nameInputs.find((inp) => inp.value === 'code')
      expect(codeInput).not.toBeUndefined()
      if (codeInput) {
        codeInput.value = 'id'
        codeInput.dispatchEvent(new FakeEvent({ type: 'input', bubbles: true }))
        codeInput.value = 'code_v2'
        codeInput.dispatchEvent(new FakeEvent({ type: 'input', bubbles: true }))
      }

      // Live .datanoa-col-pill labels reflect stable col.id: active PK pill stays 'id', renamed pill becomes 'code_v2'
      const activePills = host
        .querySelectorAll('.datanoa-col-pill.active')
        .map((p) => p.textContent.trim())
      const allPills = host.querySelectorAll('.datanoa-col-pill').map((p) => p.textContent.trim())
      expect(activePills).toContain('id')
      expect(allPills).toContain('code_v2')

      // DDL Preview verifies generated migration SQL keeps new index bound to PK 'id' (NOT corrupted to 'code_v2')
      findButtonByText(host, 'DDL Preview')?.click()
      const previewSql = host.querySelector('.datanoa-dml-preview pre')?.textContent ?? ''
      expect(previewSql).toContain('RENAME COLUMN "code" TO "code_v2"')
      expect(previewSql).toContain('CREATE INDEX "idx_items_id" ON "items" ("id")')
      expect(previewSql).not.toContain('CREATE INDEX "idx_items_id" ON "items" ("code_v2")')

      // Side Panel panel.html Round 1 (#118) contract assertions
      const panelHtmlPath = path.join(REPO_ROOT, 'src', 'panel', 'panel.html')
      const html = fs.readFileSync(panelHtmlPath, 'utf8')

      // 1. profile.options end-to-end preservation
      expect(html).toContain('id="pgOptionsRow"')
      expect(html).toContain('id="formOptions"')
      expect(html).toContain('formOptions:')
      expect(html).toContain('if (pgOptions) profile.options = pgOptions')

      // 2. Sticky td.td-rownum opaque color-mix without ID-scoped background override
      expect(html).toContain('.data-table tr.row-selected td.td-rownum')
      expect(html).toContain('background: color-mix(in srgb, var(--info) 12%, var(--surface));')
      expect(html).toContain('.data-table tr.row-inserted td.td-rownum')
      expect(html).toContain('.data-table tr.row-deleted td.td-rownum')

      // 3. MySQL /*! ... */ executable comments in panelContainsDdlStatement
      expect(html).toContain("const MYSQL_EXEC_DRIVERS = new Set(['mysql', 'mariadb'])")
      expect(html).toContain('function panelContainsDdlStatement(sql, driver)')
    })
  })
})
