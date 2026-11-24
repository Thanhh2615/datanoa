import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fc from 'fast-check'
import { afterAll, describe, expect, it, vi } from 'vitest'

const tmpThreadDir = path.join(os.tmpdir(), 'ai-work', 'datanoa', 'coverage-100-full', 'tmp-sqlite-thread')

interface PostedWorkerMessage {
  id: string
  ok: boolean
  data?: unknown
  error?: { message: string; code: string; stack?: string }
  txState?: { active: boolean; autoCommit: boolean; statementCount: number; supported: boolean }
}

describe('Wave 2A-1 Live SQLite Worker Thread: src/drivers/sqlite/thread.ts', () => {
  const openPorts: Array<{ close?: () => void }> = []

  afterAll(() => {
    vi.resetModules()
    vi.doUnmock('node:worker_threads')
    for (const p of openPorts) {
      try {
        p.close?.()
      } catch {
        // ignore close cleanup errors
      }
    }
    fs.rmSync(tmpThreadDir, { recursive: true, force: true })
  })

  it('rejects loading thread.ts outside a Worker thread when parentPort is null', async () => {
    vi.resetModules()
    vi.doMock('node:worker_threads', async () => {
      const actual = await vi.importActual<typeof import('node:worker_threads')>('node:worker_threads')
      return {
        ...actual,
        parentPort: null,
      }
    })
    await expect(import('../src/drivers/sqlite/thread')).rejects.toThrow(
      'src/drivers/sqlite/thread.ts must be run within a Worker thread.'
    )
    vi.resetModules()
    vi.doUnmock('node:worker_threads')
  })

  it('exercises MessageChannel + real DatabaseSync across all WorkerRequest ops, FK triggers, rebuild guards, and normalizeSqliteParam PBT', async () => {
    vi.resetModules()
    const realWt = await import('node:worker_threads')
    const { port1, port2 } = new realWt.MessageChannel()
    openPorts.push(port1, port2)

    // Bridge EventEmitter-compatible wrapper over MessagePort ('on' + 'postMessage')
    class WorkerPortBridge extends EventEmitter {
      private port: import('node:worker_threads').MessagePort
      constructor(port: import('node:worker_threads').MessagePort) {
        super()
        this.port = port
        port.on('message', (msg: unknown) => {
          this.emit('message', msg)
        })
      }
      postMessage(msg: unknown): void {
        this.port.postMessage(msg)
      }
    }

    const fakeParentPort = new WorkerPortBridge(port2)
    vi.doMock('node:worker_threads', async () => {
      const actual = await vi.importActual<typeof import('node:worker_threads')>('node:worker_threads')
      return {
        ...actual,
        parentPort: fakeParentPort,
      }
    })

    const threadMod = await import('../src/drivers/sqlite/thread')
    const { normalizeSqliteParam } = threadMod

    // 1) Property-based test for normalizeSqliteParam
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(undefined),
          fc.constant(null),
          fc.boolean(),
          fc.integer(),
          fc.double({ noNaN: true, noDefaultInfinity: true }),
          fc.string(),
          fc.bigInt(),
          fc.date({ min: new Date(0), max: new Date('2100-01-01T00:00:00Z') }),
          fc.uint8Array({ maxLength: 16 }),
          fc.record({ k: fc.string(), n: fc.integer() })
        ),
        (val) => {
          const out = normalizeSqliteParam(val)
          if (val === undefined || val === null) {
            expect(out).toBeNull()
          } else if (typeof val === 'boolean') {
            expect(out).toBe(val ? 1 : 0)
          } else if (val instanceof Date) {
            expect(out).toBe(Number.isNaN(val.getTime()) ? null : val.toISOString())
          } else if (val instanceof Uint8Array) {
            expect(out).toBe(val)
          } else if (typeof val === 'object') {
            expect(out).toBe(JSON.stringify(val))
          } else {
            expect(out).toBe(val)
          }
        }
      )
    )
    expect(normalizeSqliteParam(new Date('invalid'))).toBeNull()
    const ab = new ArrayBuffer(4)
    const i16 = new Int16Array(ab)
    i16[0] = 42
    expect(normalizeSqliteParam(i16)).toBeInstanceOf(Uint8Array)
    expect(normalizeSqliteParam(ab)).toBeInstanceOf(Uint8Array)
    expect(normalizeSqliteParam(Symbol('sym'))).toBe('Symbol(sym)')

    let nextId = 0
    const callWorker = (payload: Record<string, unknown>): Promise<PostedWorkerMessage> => {
      const id = `msg_${++nextId}`
      return new Promise((resolve) => {
        const onMsg = (msg: PostedWorkerMessage) => {
          if (msg.id === id) {
            port1.off('message', onMsg)
            resolve(msg)
          }
        }
        port1.on('message', onMsg)
        port1.postMessage({ id, ...payload })
      })
    }

    // Request before init fails cleanly
    const uninit = await callWorker({ type: 'exec', sql: 'SELECT 1;' })
    expect(uninit.ok).toBe(false)
    expect(uninit.error?.code).toBe('SQLITE_ERROR')

    const prevUdf = process.env.DATANOA_ENABLE_TEST_UDF
    process.env.DATANOA_ENABLE_TEST_UDF = '1'
    try {
      const initRes = await callWorker({ type: 'init', filePath: ':memory:' })
      expect(initRes.ok).toBe(true)

      // UDF sleep_ms quick run
      const udfRes = await callWorker({ type: 'query', sql: 'SELECT sleep_ms(1) AS s;' })
      expect(udfRes.ok).toBe(true)

      // Schema + trigger raising __datanoa_fk_violation__ sentinel + long SQL compactSql truncation
      const setupSql = `
        CREATE TABLE parents (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id));
        CREATE TRIGGER trg_fk_sent BEFORE INSERT ON children WHEN NEW.parent_id = -1 BEGIN
          SELECT RAISE(ABORT, '__datanoa_fk_violation__');
        END;
        INSERT INTO parents (id, name) VALUES (1, 'p1');
      `
      const setupRes = await callWorker({ type: 'exec', sql: setupSql })
      expect(setupRes.ok).toBe(true)

      const sentinelErr = await callWorker({
        type: 'run',
        sql: 'INSERT INTO children (id, parent_id) VALUES (?, ?);',
        params: [1, -1],
      })
      expect(sentinelErr.ok).toBe(false)
      expect(sentinelErr.error?.code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY')
      expect(sentinelErr.error?.message).toBe('FOREIGN KEY constraint failed')

      // Safe + unsafe BigInt roundtrip
      const bigRun = await callWorker({
        type: 'run',
        sql: 'INSERT INTO parents (id, name) VALUES (?, ?);',
        params: [9007199254740993n, 'big'],
      })
      expect(bigRun.ok).toBe(true)
      const bigGet = await callWorker({ type: 'get', sql: 'SELECT id, name FROM parents WHERE name = ?;', params: ['big'] })
      expect(bigGet.data).toEqual({ id: '9007199254740993', name: 'big' })
      const emptyGet = await callWorker({ type: 'get', sql: 'SELECT id FROM parents WHERE id = -999;' })
      expect(emptyGet.data).toBeUndefined()
      const allRows = await callWorker({ type: 'all', sql: 'SELECT id, name FROM parents ORDER BY id;' })
      expect(Array.isArray(allRows.data)).toBe(true)

      // serialize + re-init from serialized snapshot
      const serialized = await callWorker({ type: 'serialize' })
      expect(serialized.ok).toBe(true)
      expect(serialized.data).toBeInstanceOf(Uint8Array)

      // Transaction commands + error guards
      expect((await callWorker({ type: 'txStatus' })).data).toMatchObject({ active: false, autoCommit: true })
      expect((await callWorker({ type: 'txCommit' })).ok).toBe(false)
      expect((await callWorker({ type: 'txRollback' })).ok).toBe(false)

      expect((await callWorker({ type: 'txBegin' })).data).toMatchObject({ active: true })
      expect((await callWorker({ type: 'txBegin' })).ok).toBe(false)
      expect((await callWorker({ type: 'txSetAutoCommit', enabled: true })).ok).toBe(false)

      // Multi-stmt rebuild blocked inside active manual tx
      const blockedRebuild = await callWorker({
        type: 'query',
        sql: 'PRAGMA foreign_keys = OFF; BEGIN; SELECT 1; COMMIT;',
        statements: ['PRAGMA foreign_keys = OFF;', 'BEGIN;', 'SELECT 1;', 'COMMIT;'],
      })
      expect(blockedRebuild.ok).toBe(false)
      expect(blockedRebuild.error?.message).toContain('Cannot rebuild SQLite table')

      // applyBatch nested success & delete/update conflict rollback
      const nestedOk = await callWorker({
        type: 'applyBatch',
        deletes: [],
        updates: [{ sql: 'UPDATE parents SET name = ? WHERE id = ?;', params: ['updated', 1] }],
        inserts: [{ sql: 'INSERT INTO parents (id, name) VALUES (?, ?);', params: [2, 'two'] }],
      })
      expect(nestedOk.ok).toBe(true)

      const nestedDelConflict = await callWorker({
        type: 'applyBatch',
        deletes: [{ sql: 'DELETE FROM parents WHERE id = ?;', params: [888] }],
        updates: [],
        inserts: [],
      })
      expect(nestedDelConflict.ok).toBe(false)
      expect(nestedDelConflict.error?.code).toBe('conflict')

      const nestedUpdConflict = await callWorker({
        type: 'applyBatch',
        deletes: [],
        updates: [{ sql: 'UPDATE parents SET name = ? WHERE id = ?;', params: ['x', 888] }],
        inserts: [],
      })
      expect(nestedUpdConflict.ok).toBe(false)
      expect(nestedUpdConflict.error?.code).toBe('conflict')

      await callWorker({ type: 'txCommit' })

      // Non-nested applyBatch + !autoCommit auto-begin
      await callWorker({ type: 'txSetAutoCommit', enabled: false })
      await callWorker({ type: 'run', sql: 'INSERT INTO parents (id, name) VALUES (?, ?);', params: [3, 'auto_off'] })
      await callWorker({ type: 'txRollback' })
      await callWorker({ type: 'txSetAutoCommit', enabled: true })

      const flatBatchOk = await callWorker({
        type: 'applyBatch',
        deletes: [{ sql: 'DELETE FROM parents WHERE id = ?;', params: [2] }],
        updates: [],
        inserts: [{ sql: 'INSERT INTO parents (id, name) VALUES (?, ?);', params: [4, 'four'] }],
      })
      expect(flatBatchOk.ok).toBe(true)

      const flatConflict = await callWorker({
        type: 'applyBatch',
        deletes: [],
        updates: [{ sql: 'UPDATE parents SET name = ? WHERE id = ?;', params: ['no', 777] }],
        inserts: [],
      })
      expect(flatConflict.ok).toBe(false)

      // Multi-stmt queries with leading comments (--, /* */), blank lines, COMMIT/ROLLBACK SQL, plus separate unterminated comment
      const longCol = 'c'.repeat(95)
      const qComments = await callWorker({
        type: 'query',
        sql: `-- header\nBEGIN; SELECT 1 AS "${longCol}"; COMMIT;`,
        statements: ['   ', '/* block */\n-- header\nBEGIN;', `SELECT 1 AS "${longCol}";`, 'COMMIT;'],
      })
      expect(qComments.ok).toBe(true)

      const qUnterminated = await callWorker({
        type: 'query',
        sql: '/* unterminated',
        statements: ['/* unterminated'],
      })
      expect(qUnterminated.ok).toBe(false)

      // Single-statement PRAGMA foreign_keys toggle updates tracked foreignKeysEnabled
      expect((await callWorker({ type: 'query', sql: 'PRAGMA foreign_keys = OFF;' })).ok).toBe(true)
      expect((await callWorker({ type: 'query', sql: 'PRAGMA foreign_keys = ON;' })).ok).toBe(true)

      // Multi-statement FK check failure with PRAGMA foreign_keys = OFF + standalone BEGIN rollback
      await callWorker({
        type: 'query',
        sql: 'PRAGMA foreign_keys = OFF; INSERT INTO children (id, parent_id) VALUES (50, 9999); PRAGMA foreign_keys = ON;',
        statements: ['PRAGMA foreign_keys = OFF;', 'INSERT INTO children (id, parent_id) VALUES (50, 9999);', 'PRAGMA foreign_keys = ON;'],
      })
      const fkViolation = await callWorker({
        type: 'query',
        sql: 'BEGIN; PRAGMA foreign_keys = OFF; PRAGMA foreign_key_check; COMMIT;',
        statements: ['BEGIN;', 'PRAGMA foreign_keys = OFF;', 'PRAGMA foreign_key_check;', 'COMMIT;'],
      })
      expect(fkViolation.ok).toBe(false)
      expect(fkViolation.error?.message).toBe('FOREIGN KEY constraint failed')

      // Non-select standalone ROLLBACK SQL
      const rbSql = await callWorker({
        type: 'query',
        sql: 'BEGIN; INSERT INTO parents (id, name) VALUES (5, "x"); ROLLBACK;',
        statements: ['BEGIN;', "INSERT INTO parents (id, name) VALUES (5, 'x');", 'ROLLBACK;'],
      })
      expect(rbSql.ok).toBe(true)

      // Trigger close while inManualTx is still active, then re-init with serialized bytes
      await callWorker({ type: 'txBegin' })
      expect((await callWorker({ type: 'close' })).ok).toBe(true)

      const reinit = await callWorker({
        type: 'init',
        filePath: ':memory:',
        serialized: serialized.data,
      })
      expect(reinit.ok).toBe(true)
      const checkRestored = await callWorker({ type: 'get', sql: 'SELECT name FROM parents WHERE id = 1;' })
      expect(checkRestored.data).toEqual({ name: 'p1' })

      // Close remaining thread.ts branches: maxRows truncation, no-newline comment, sleep_ms non-numeric,
      // PRAGMA foreign_keys = OFF multi-stmt restore on both success & error, and real file init
      const qMaxRows = await callWorker({
        type: 'query',
        sql: 'SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3;',
        maxRows: 1,
      })
      expect(qMaxRows.ok).toBe(true)
      expect((qMaxRows.data as { truncated: boolean; rowCount: number }).truncated).toBe(true)
      expect((qMaxRows.data as { rowCount: number }).rowCount).toBe(1)

      expect((await callWorker({ type: 'query', sql: '-- no newline' })).ok).toBe(false)
      expect((await callWorker({ type: 'query', sql: "SELECT sleep_ms('bad') AS s;" })).ok).toBe(true)

      await callWorker({ type: 'query', sql: 'PRAGMA foreign_keys = OFF;' })
      expect(
        (
          await callWorker({
            type: 'query',
            sql: 'PRAGMA foreign_keys = ON; SELECT 1;',
            statements: ['PRAGMA foreign_keys = ON;', 'SELECT 1;'],
          })
        ).ok
      ).toBe(true)
      expect(
        (
          await callWorker({
            type: 'query',
            sql: 'PRAGMA foreign_keys = ON; SELECT * FROM nope_table;',
            statements: ['PRAGMA foreign_keys = ON;', 'SELECT * FROM nope_table;'],
          })
        ).ok
      ).toBe(false)
      await callWorker({ type: 'close' })

      fs.mkdirSync(tmpThreadDir, { recursive: true })
      const realThreadDb = path.join(tmpThreadDir, 'thread-file.db')
      expect((await callWorker({ type: 'init', filePath: realThreadDb })).ok).toBe(true)
      expect((await callWorker({ type: 'exec', sql: 'CREATE TABLE f (x INTEGER);' })).ok).toBe(true)
      expect((await callWorker({ type: 'close' })).ok).toBe(true)
    } finally {
      if (prevUdf === undefined) {
        delete process.env.DATANOA_ENABLE_TEST_UDF
      } else {
        process.env.DATANOA_ENABLE_TEST_UDF = prevUdf
      }
      vi.resetModules()
      vi.doUnmock('node:worker_threads')
    }
  })
})
