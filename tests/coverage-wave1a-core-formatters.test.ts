import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { bindCtrlWheelHorizontalScroll } from '../src/shared-wheel-scroll.js'
import {
  CUSTOM_DRIVERS_STORAGE_KEY,
  DATANOA_APP_VERSION,
  DEFAULT_IMPORT_CHUNK_SIZE,
  DEFAULT_MAX_QUERY_ROWS,
  DEFAULT_RPC_TIMEOUT_MS,
  MAX_QUERY_ROWS_CEILING,
  SAVED_QUERIES_STORAGE_KEY,
} from '../src/shared-constants.js'
import {
  BYOD_LOGO_PATHS,
  CLICKHOUSE_LOGO_RECTS,
  DB_LOGO_COLORS,
  DB_LOGO_PATHS,
  FOLDER_CLOSED_PATH,
  FOLDER_OPEN_PATH,
  WORKSPACE_ICON_SHAPES,
  buildPanelDbSvgMarkupMap,
  buildWorkspaceSvgMarkup,
} from '../src/shared-db-icons.js'
import {
  BUILTIN_ENGINE_CATALOG,
  getDefaultPortForDriver,
  getEngineCatalogEntry,
  isTcpNetworkDriver,
} from '../src/drivers/common/engine-catalog.js'
import {
  DatabaseDriverError,
  buildCombinedAbortSignal,
  createUnsupportedTransactionError,
  createUnsupportedTransactionState,
  runDriverConnectionTest,
  type IDatabaseSession,
} from '../src/drivers/common/driver.js'
import { createDriver, getDriver, type DriverType } from '../src/drivers/index.js'
import * as sqlTools from '../src/drivers/common/sql-tools.js'
import * as editorSqlSafety from '../src/editor/sql-safety.js'
import {
  formatCellMatrixExport,
  formatDataExport,
  formatSqlInList,
} from '../src/drivers/common/sql-formatter.js'
import type { DatabaseDriverType } from '../src/protocol.js'

const ALL_DIALECTS: readonly DatabaseDriverType[] = [
  'sqlite',
  'postgres',
  'mysql',
  'mariadb',
  'cockroachdb',
  'clickhouse',
  'redis',
  'libsql',
  'd1',
  'mssql',
  'oracle',
  'mongodb',
]

const SQL_DIALECTS: readonly DatabaseDriverType[] = [
  'sqlite',
  'postgres',
  'mysql',
  'mariadb',
  'cockroachdb',
  'clickhouse',
  'libsql',
  'd1',
  'mssql',
  'oracle',
]

function makeWheelTarget() {
  const listeners = new Map<string, Set<(ev: unknown) => void>>()
  const el = {
    scrollLeft: 0,
    addEventListener(type: string, fn: (ev: unknown) => void) {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(fn)
    },
    removeEventListener(type: string, fn: (ev: unknown) => void) {
      listeners.get(type)?.delete(fn)
    },
  }
  const emit = (ev: Record<string, unknown>) => {
    for (const fn of Array.from(listeners.get('wheel') ?? [])) {
      fn(ev)
    }
  }
  return { el: el as unknown as HTMLElement, emit, listeners }
}

describe('Wave 1A Group 1: shared wheel scroll, constants, icons, catalog, driver helpers, and barrels', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ignores zero-delta ctrl+wheel events without calling preventDefault and pans monotonically across deltaModes', () => {
    const { el, emit, listeners } = makeWheelTarget()
    const unbind = bindCtrlWheelHorizontalScroll(el)
    let prevented = false
    emit({
      ctrlKey: true,
      metaKey: false,
      deltaX: 0,
      deltaY: 0,
      deltaMode: 0,
      preventDefault: () => {
        prevented = true
      },
    })
    expect(prevented).toBe(false)
    expect(el.scrollLeft).toBe(0)
    unbind()
    expect(listeners.get('wheel')?.size ?? 0).toBe(0)

    // Invalid element returns no-op unbind
    const noopUnbind = bindCtrlWheelHorizontalScroll(null as unknown as HTMLElement)
    expect(() => noopUnbind()).not.toThrow()

    // Property: horizontal delta sign & mode scale factor invariant
    fc.assert(
      fc.property(
        fc.integer({ min: -500, max: 500 }).filter((n) => n !== 0),
        fc.constantFrom(0, 1, 2),
        fc.boolean(),
        (delta, mode, useDeltaY) => {
          const target = makeWheelTarget()
          const dispose = bindCtrlWheelHorizontalScroll(target.el)
          let calledPrevent = false
          target.emit({
            ctrlKey: true,
            metaKey: false,
            deltaX: useDeltaY ? 0 : delta,
            deltaY: useDeltaY ? delta : 0,
            deltaMode: mode,
            preventDefault: () => {
              calledPrevent = true
            },
          })
          dispose()
          const expectedScale = mode === 1 ? 28 : mode === 2 ? 320 : 1.25
          expect(calledPrevent).toBe(true)
          expect(target.el.scrollLeft).toBe(delta * expectedScale)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('exposes shared constants, re-export barrels, and icon SVG helpers including non-finite and clamped sizes', () => {
    expect(DATANOA_APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(DEFAULT_RPC_TIMEOUT_MS).toBeGreaterThan(0)
    expect(DEFAULT_MAX_QUERY_ROWS).toBeGreaterThan(0)
    expect(MAX_QUERY_ROWS_CEILING).toBeGreaterThanOrEqual(DEFAULT_MAX_QUERY_ROWS)
    expect(DEFAULT_IMPORT_CHUNK_SIZE).toBeGreaterThan(0)
    expect(SAVED_QUERIES_STORAGE_KEY).toContain('datanoa')
    expect(CUSTOM_DRIVERS_STORAGE_KEY).toContain('datanoa')

    expect(typeof sqlTools.formatSql).toBe('function')
    expect(typeof sqlTools.stripCommentsAndLiterals).toBe('function')
    expect(typeof sqlTools.buildAlterTableSql).toBe('function')
    expect(typeof editorSqlSafety.analyzeDangerousSql).toBe('function')

    expect(Object.keys(DB_LOGO_COLORS)).toHaveLength(12)
    expect(Object.keys(DB_LOGO_PATHS)).toHaveLength(11) // clickhouse uses CLICKHOUSE_LOGO_RECTS
    expect(CLICKHOUSE_LOGO_RECTS.length).toBeGreaterThan(0)
    expect(Object.keys(BYOD_LOGO_PATHS)).toHaveLength(7)
    expect(FOLDER_OPEN_PATH.length).toBeGreaterThan(0)
    expect(FOLDER_CLOSED_PATH.length).toBeGreaterThan(0)
    expect(WORKSPACE_ICON_SHAPES.length).toBe(3)

    const panelSvgs = buildPanelDbSvgMarkupMap()
    expect(Object.keys(panelSvgs)).toHaveLength(19)
    expect(buildWorkspaceSvgMarkup('ws-icon')).toContain('width="13" height="13"')
    expect(buildWorkspaceSvgMarkup('ws-icon', Number.NaN)).toContain('width="13" height="13"')
    expect(buildWorkspaceSvgMarkup('ws-icon', 2)).toContain('width="10" height="10"')
    expect(buildWorkspaceSvgMarkup('ws-icon', 999)).toContain('width="32" height="32"')
    expect(buildWorkspaceSvgMarkup('ws-icon', 18.6)).toContain('width="19" height="19"')
  })

  it('validates engine catalog helpers, driver registry, and driver base utilities', async () => {
    for (const entry of BUILTIN_ENGINE_CATALOG) {
      expect(getEngineCatalogEntry(entry.id)).toEqual(entry)
      expect(isTcpNetworkDriver(entry.id)).toBe(entry.transport === 'tcp')
      expect(getDefaultPortForDriver(entry.id)).toBe(entry.defaultPort ?? 0)
    }
    expect(getDefaultPortForDriver('sqlite')).toBe(0)
    expect(() => getEngineCatalogEntry('invalid-engine' as DatabaseDriverType)).toThrow(
      'Unsupported database driver: invalid-engine'
    )

    for (const id of ALL_DIALECTS) {
      const d1 = getDriver(id)
      const d2 = createDriver(id)
      expect(d1.type).toBe(id)
      expect(d2).toBe(d1)
    }
    expect(() => getDriver('not-a-driver' as DriverType)).toThrow(
      'Unsupported database driver: not-a-driver'
    )

    // buildCombinedAbortSignal: no parent signal, AbortSignal.any available, and fallback without AbortSignal.any
    const timeoutOnly = buildCombinedAbortSignal(500)
    expect(timeoutOnly.aborted).toBe(false)

    const controller = new AbortController()
    const combined = buildCombinedAbortSignal(500, controller.signal)
    expect(combined.aborted).toBe(false)
    controller.abort()
    expect(combined.aborted).toBe(true)

    const origAny = (AbortSignal as { any?: typeof AbortSignal.any }).any
    try {
      ;(AbortSignal as { any?: typeof AbortSignal.any }).any = undefined
      const fallbackCtrl = new AbortController()
      const fallbackResult = buildCombinedAbortSignal(500, fallbackCtrl.signal)
      expect(fallbackResult).toBe(fallbackCtrl.signal)
    } finally {
      ;(AbortSignal as { any?: typeof AbortSignal.any }).any = origAny
    }

    // runDriverConnectionTest: success, session.test throw (with close failure), createSession rejection
    const okRes = await runDriverConnectionTest(
      async () =>
        ({
          test: async () => ({ ok: true, message: 'pong' }),
          close: async () => {},
        }) as unknown as IDatabaseSession,
      (e) => String(e)
    )
    expect(okRes).toEqual({ ok: true, message: 'pong' })

    let closedOnErr = false
    const errSessionRes = await runDriverConnectionTest(
      async () =>
        ({
          test: async () => {
            throw new Error('handshake failed')
          },
          close: async () => {
            closedOnErr = true
            throw new Error('close failed too')
          },
        }) as unknown as IDatabaseSession,
      (e) => (e instanceof Error ? e.message : String(e))
    )
    expect(closedOnErr).toBe(true)
    expect(errSessionRes).toEqual({ ok: false, message: 'handshake failed' })

    const errCreateRes = await runDriverConnectionTest(
      async () => {
        throw new Error('dial timeout')
      },
      (e) => (e instanceof Error ? e.message : String(e))
    )
    expect(errCreateRes).toEqual({ ok: false, message: 'dial timeout' })

    // Formatter throwing inside catch triggers abrupt-completion finally exit path
    await expect(
      runDriverConnectionTest(
        async () => {
          throw new Error('raw err')
        },
        () => {
          throw new Error('formatter failed')
        }
      )
    ).rejects.toThrow('formatter failed')

    const state = createUnsupportedTransactionState('No TX in Redis')
    expect(state).toEqual({
      active: false,
      autoCommit: true,
      statementCount: 0,
      supported: false,
      reason: 'No TX in Redis',
    })
    const txErr = createUnsupportedTransactionError('redis', 'No TX in Redis')
    expect(txErr).toBeInstanceOf(DatabaseDriverError)
    expect(txErr.code).toBe('UNSUPPORTED_TRANSACTION')
    expect(txErr.driver).toBe('redis')
    expect(txErr.message).toBe('No TX in Redis')
  })
})

describe('Wave 1A Group 1: sql-formatter.ts behavioral & property-based tests', () => {
  it('handles all 7 export formats, special cell values, blob filtering, and empty boundary cases', () => {
    const validDate = new Date('2026-01-15T12:30:00.000Z')
    const invalidDate = new Date('invalid-date')
    const bytes = new Uint8Array([1, 2, 3])
    const buf = new ArrayBuffer(4)

    // Empty columns / empty rows guard paths
    expect(formatDataExport({ columns: [], rows: [{ a: 1 }], format: 'sql-insert' })).toBe('')
    expect(formatDataExport({ columns: ['a'], rows: [], format: 'sql-insert' })).toBe('')
    expect(formatDataExport({ columns: [], rows: [{ a: 1 }], format: 'sql-update' })).toBe('')
    expect(formatDataExport({ columns: ['a'], rows: [], format: 'sql-update' })).toBe('')
    expect(formatDataExport({ columns: [], rows: [{ a: 1 }], format: 'csv' })).toBe('')
    expect(formatDataExport({ columns: [], rows: [{ a: 1 }], format: 'tsv' })).toBe('')
    expect(formatDataExport({ columns: [], rows: [{ a: 1 }], format: 'markdown' })).toBe('')

    // JSON / NDJSON with empty columns projects entire normalized row (safe bigints -> number, unsafe -> string)
    const jsonFull = formatDataExport({
      columns: [],
      rows: [{ id: 9007199254740993n, safeBig: 10n, extra: 'ok' }],
      format: 'json',
    })
    expect(JSON.parse(jsonFull)).toEqual([
      { id: '9007199254740993', safeBig: 10, extra: 'ok' },
    ])
    const ndjsonProj = formatDataExport({
      columns: ['id'],
      rows: [{ id: 1, ignored: 'x' }, { id: 2, ignored: 'y' }],
      format: 'ndjson',
    })
    expect(ndjsonProj.split('\n').map((l) => JSON.parse(l))).toEqual([{ id: 1 }, { id: 2 }])

    // CSV / TSV / Markdown escaping across cell types
    const csvOut = formatDataExport({
      columns: ['a,b', 'plain'],
      rows: [
        {
          'a,b': 'quote "here"\nand\rCR',
          plain: validDate,
        },
        {
          'a,b': invalidDate,
          plain: 42n,
        },
        {
          'a,b': { nested: true },
          plain: null,
        },
      ],
      format: 'csv',
    })
    expect(csvOut).toContain('"a,b",plain')
    expect(csvOut).toContain('"quote ""here""\nand\rCR"')
    expect(csvOut).toContain('2026-01-15T12:30:00.000Z')
    expect(csvOut).toContain('42')
    expect(csvOut).toContain('"{""nested"":true}"')

    const tsvOut = formatDataExport({
      columns: ['c1', 'c2'],
      rows: [{ c1: 'has\ttab', c2: undefined }],
      format: 'tsv',
    })
    expect(tsvOut).toBe('c1\tc2\n"has\ttab"\t')

    const mdOut = formatDataExport({
      columns: ['col|1', 'col\n2'],
      rows: [{ 'col|1': 'a|b\r\nc', 'col\n2': null }],
      format: 'markdown',
    })
    expect(mdOut).toBe('| col\\|1 | col<br>2 |\n| --- | --- |\n| a\\|b<br>c | NULL |')

    // sql-insert
    const insertSql = formatDataExport({
      columns: ['id', 'name'],
      rows: [{ id: 1, name: "O'Brien" }],
      format: 'sql-insert',
      tableName: 'users',
      dialect: 'postgres',
    })
    expect(insertSql).toBe(`INSERT INTO "users" ("id", "name") VALUES (1, 'O''Brien');`)

    // sql-update with explicit PKs, all-PK fallback, no-PK non-BLOB filter, all-BLOB fallback, and NULL PK
    const updateWithPk = formatDataExport({
      columns: ['id', 'name'],
      rows: [{ id: 1, name: 'Alice' }],
      format: 'sql-update',
      tableName: 'users',
      dialect: 'mysql',
      primaryKeys: ['id'],
    })
    expect(updateWithPk).toBe("UPDATE `users` SET `name` = 'Alice' WHERE `id` = 1;")

    const updateAllPk = formatDataExport({
      columns: ['id'],
      rows: [{ id: null }],
      format: 'sql-update',
      primaryKeys: ['id'],
    })
    expect(updateAllPk).toBe('UPDATE "table_name" SET "id" = NULL WHERE "id" IS NULL;')

    const updateNoPkWithBlob = formatDataExport({
      columns: ['id', 'note', 'raw_u8', 'raw_buf', 'raw_tag', 'raw_node_buf', 'meta'],
      rows: [
        {
          id: 7,
          note: null,
          raw_u8: bytes,
          raw_buf: buf,
          raw_tag: '[BLOB 12 B]',
          raw_node_buf: { type: 'Buffer', data: [1, 2] },
          meta: { ok: true },
        },
      ],
      format: 'sql-update',
    })
    expect(updateNoPkWithBlob).toContain('-- WARNING: Table has no primary key')
    expect(updateNoPkWithBlob).toContain(
      'WHERE "id" = 7 AND "note" IS NULL AND "meta" = \'{"ok":true}\';'
    )
    expect(updateNoPkWithBlob).not.toContain('WHERE "id" = 7 AND "raw_u8"')

    const updateAllBlobs = formatDataExport({
      columns: ['payload'],
      rows: [{ payload: '[BLOB 4 B]' }],
      format: 'sql-update',
    })
    expect(updateAllBlobs).toContain('WHERE "payload" = \'[BLOB 4 B]\';')
  })

  it('handles formatSqlInList and formatCellMatrixExport edge cases', () => {
    expect(formatSqlInList([], 'postgres')).toBe('')
    expect(formatSqlInList('not-array' as unknown as unknown[], 'postgres')).toBe('')
    expect(formatSqlInList([null, undefined], 'postgres')).toBe('(NULL)')
    expect(formatSqlInList([1, 1, 2], 'postgres')).toBe('(1, 2)')
    expect(formatSqlInList([1, 1, 2], 'postgres', { deduplicate: false })).toBe('(1, 1, 2)')
    expect(formatSqlInList([1, null, 1], 'postgres', { columnName: ' id ' })).toBe(
      '("id" IN (1) OR "id" IS NULL)'
    )
    expect(formatSqlInList([1, 2], 'mysql', { columnName: 'id' })).toBe('`id` IN (1, 2)')
    expect(formatSqlInList([null, undefined], 'mssql', { columnName: 'id' })).toBe('[id] IS NULL')

    // formatCellMatrixExport
    expect(formatCellMatrixExport([], [], 'json')).toBe('[]')
    expect(
      JSON.parse(
        formatCellMatrixExport(['name', ''], [['Alice', 9007199254740993n, 'extra']], 'json')
      )
    ).toEqual([{ name: 'Alice', col_2: '9007199254740993', col_3: 'extra' }])

    // Single cell TSV stays unquoted raw text even when containing tabs/quotes
    expect(formatCellMatrixExport(['col'], [['raw\t"val"']], 'tsv')).toBe('raw\t"val"')
    expect(formatCellMatrixExport(['c1', 'c2'], [['a\tb', 'c']], 'tsv')).toBe('"a\tb"\tc')
    expect(formatCellMatrixExport(['c1', 'c2'], [['a', 'b']], 'tsv-headers')).toBe('c1\tc2\na\tb')
    expect(formatCellMatrixExport([], [['a,b', 'c']], 'csv')).toBe('"a,b",c')
    expect(formatCellMatrixExport(['h1', 'h2'], [['a,b', null]], 'csv')).toBe('h1,h2\n"a,b",')
  })

  it('PBT: satisfies structural, escaping, roundtrip, and deduplication invariants', () => {
    const cellValueArb = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.integer({ min: -1_000_000, max: 1_000_000 }),
      fc.boolean(),
      fc.string({ maxLength: 30 }),
      fc.date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2035-01-01T00:00:00Z'), noInvalidDate: true })
    )

    // JSON / NDJSON format produces valid parseable JSON with exact row count
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/), { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 0, max: 6 }),
        (cols, rowCount) => {
          const rows = Array.from({ length: rowCount }, (_, i) => {
            const r: Record<string, unknown> = {}
            for (const c of cols) r[c] = `v_${i}_${c}`
            return r
          })
          const parsedJson = JSON.parse(formatDataExport({ columns: cols, rows, format: 'json' }))
          expect(parsedJson).toHaveLength(rowCount)
          const ndjson = formatDataExport({ columns: cols, rows, format: 'ndjson' })
          const ndLines = ndjson ? ndjson.split('\n') : []
          expect(ndLines).toHaveLength(rowCount)
          for (const line of ndLines) {
            const obj = JSON.parse(line)
            expect(Object.keys(obj)).toEqual(cols)
          }
        }
      ),
      { numRuns: 100 }
    )

    // formatSqlInList deduplication idempotency & non-empty guarantee
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.constant(null), fc.integer({ min: -50, max: 50 }), fc.string({ maxLength: 10 })), {
          minLength: 1,
          maxLength: 12,
        }),
        fc.constantFrom(...SQL_DIALECTS),
        fc.option(fc.stringMatching(/^[a-z_][a-z0-9_]{0,8}$/), { nil: undefined }),
        (vals, dialect, columnName) => {
          const deduped = formatSqlInList(vals, dialect, { deduplicate: true, columnName })
          const doubled = formatSqlInList([...vals, ...vals], dialect, { deduplicate: true, columnName })
          expect(deduped.length).toBeGreaterThan(0)
          expect(doubled).toBe(deduped)
          if (vals.some((v) => v === null) && columnName) {
            expect(deduped).toContain('IS NULL')
          }
        }
      ),
      { numRuns: 100 }
    )

    // formatDataExport sql-insert & sql-update emit one statement per row across all SQL dialects
    fc.assert(
      fc.property(
        fc.constantFrom(...SQL_DIALECTS),
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_]{0,6}$/), { minLength: 1, maxLength: 4 }),
        fc.array(cellValueArb, { minLength: 1, maxLength: 4 }),
        (dialect, cols, rawVals) => {
          const row: Record<string, unknown> = {}
          cols.forEach((c, idx) => {
            row[c] = rawVals[idx % rawVals.length]
          })
          const ins = formatDataExport({ columns: cols, rows: [row], format: 'sql-insert', tableName: 'items', dialect })
          expect(ins.startsWith('INSERT INTO ')).toBe(true)
          expect(ins.endsWith(';')).toBe(true)

          const upd = formatDataExport({
            columns: cols,
            rows: [row],
            format: 'sql-update',
            tableName: 'items',
            dialect,
            primaryKeys: [cols[0]],
          })
          expect(upd.startsWith('UPDATE ')).toBe(true)
          expect(upd).toContain(' SET ')
          expect(upd).toContain(' WHERE ')
        }
      ),
      { numRuns: 100 }
    )
  })
})
