import * as http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { ConnectionProfile } from '../src/protocol'
import { D1Driver } from '../src/drivers/d1/driver'

function execSqliteStatement(
  db: DatabaseSync,
  sql: string,
  params: unknown[] = []
): { success: boolean; results: Record<string, unknown>[]; meta: { changes: number } } {
  const normalizedParams = params.map((p) => {
    if (p === undefined) return null
    if (typeof p === 'boolean') return p ? 1 : 0
    return p as null | number | bigint | string | Uint8Array
  })
  const stmt = db.prepare(sql)
  const cols = stmt.columns()
  if (cols.length > 0) {
    const rows = stmt.all(...normalizedParams) as Record<string, unknown>[]
    return { success: true, results: rows, meta: { changes: 0 } }
  }
  const info = stmt.run(...normalizedParams)
  return { success: true, results: [], meta: { changes: Number(info.changes) } }
}

describe('Wave 2B Step 1: Cloudflare D1 Live HTTP Server + node:sqlite Engine + PBT', () => {
  let db: DatabaseSync
  let srv: http.Server
  let baseUrl = ''
  let faultMode: string | null = null
  let pendingSlowGate: { onArrived: () => void; releasePromise: Promise<void> } | null = null
  const activeSlowReleases = new Set<() => void>()

  const armSlowRequest = (): { arrived: Promise<void>; release: () => void } => {
    let resolveArrived: (() => void) | undefined
    const arrived = new Promise<void>((resolve) => {
      resolveArrived = resolve
    })
    let resolveRelease: (() => void) | undefined
    const releasePromise = new Promise<void>((resolve) => {
      resolveRelease = resolve
    })
    const release = () => {
      activeSlowReleases.delete(release)
      resolveRelease?.()
    }
    activeSlowReleases.add(release)
    pendingSlowGate = {
      onArrived: () => resolveArrived?.(),
      releasePromise,
    }
    faultMode = 'slow'
    return { arrived, release }
  }

  beforeAll(async () => {
    db = new DatabaseSync(':memory:')
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE orgs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id INTEGER NOT NULL REFERENCES orgs(id),
        email TEXT NOT NULL UNIQUE,
        score REAL DEFAULT 0,
        active INTEGER DEFAULT 1,
        blob_data BLOB,
        created_at TEXT
      );
      CREATE INDEX idx_users_email ON users (email);
      CREATE VIEW v_users AS SELECT id, email, score FROM users;
      CREATE TRIGGER trg_users_audit AFTER INSERT ON users BEGIN
        UPDATE orgs SET name = name WHERE id = NEW.org_id;
      END;
      INSERT INTO orgs (name) VALUES ('Core'), ('Ops');
      CREATE TABLE def_tbl (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT DEFAULT 'ok');
      INSERT INTO users (org_id, email, score) VALUES (1, 'alice@example.com', 10.5), (2, 'bob@example.com', 20);
      ATTACH ':memory:' AS alt;
      CREATE TABLE alt.alt_items (id INTEGER PRIMARY KEY, label TEXT);
    `)

    srv = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', async () => {
        const mode = faultMode
        faultMode = null

        const sendJson = (status: number, body: unknown) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json')
          res.end(typeof body === 'string' ? body : JSON.stringify(body))
        }

        if (mode === 'slow') {
          const gate = pendingSlowGate
          pendingSlowGate = null
          gate?.onArrived()
          if (res.writableEnded || res.destroyed || res.closed) return
          let aborted = false
          await new Promise<void>((resolve) => {
            let settled = false
            const finish = (wasAborted: boolean) => {
              if (settled) return
              settled = true
              aborted = wasAborted
              clearTimeout(timer)
              res.off('close', onAbort)
              activeSlowReleases.delete(onAbort)
              resolve()
            }
            const onAbort = () => finish(true)
            const timer = setTimeout(() => finish(false), 5_000)
            timer.unref?.()
            activeSlowReleases.add(onAbort)
            res.once('close', onAbort)
            void gate?.releasePromise.then(onAbort)
          })
          if (aborted) {
            if (!res.writableEnded && !res.destroyed && !res.closed) res.destroy()
            return
          }
          if (res.writableEnded || res.destroyed || res.closed) return
          return sendJson(200, { success: true, errors: [], result: [{ success: true, results: [{ ok: 1 }], meta: { changes: 0 } }] })
        }
        if (mode === 'bad-json') return sendJson(200, '{invalid json')
        if (mode === 'non-object') return sendJson(200, '[1,2,3]')
        if (mode === 'bad-success') return sendJson(200, { success: 'yes', errors: [] })
        if (mode === 'bad-errors') return sendJson(200, { success: false, errors: 'not-array' })
        if (mode === 'http-500-text') {
          res.statusCode = 500
          return res.end('Internal proxy failure')
        }
        if (mode === 'envelope-fail') {
          return sendJson(200, { success: false, errors: [{ message: 'D1 overload' }], result: [] })
        }
        if (mode === 'malformed-mut-result') {
          return sendJson(200, { success: true, errors: [], result: 'oops' })
        }
        if (mode === 'two-mut-results') {
          return sendJson(200, { success: true, errors: [], result: [{ success: true }, { success: true }] })
        }
        if (mode === 'stmt-fail') {
          return sendJson(200, { success: true, errors: [], result: [{ success: false }] })
        }
        if (mode === 'bad-meta') {
          return sendJson(200, { success: true, errors: [], result: [{ success: true, meta: 'bad' }] })
        }
        if (mode === 'bad-changes') {
          return sendJson(200, { success: true, errors: [], result: [{ success: true, meta: { changes: -5 } }] })
        }
        if (mode === 'bad-results') {
          return sendJson(200, { success: true, errors: [], result: [{ success: true, results: 'bad' }] })
        }
        if (mode === 'batch-mismatch') {
          return sendJson(200, { success: true, errors: [], result: [{ success: true, results: [] }] })
        }
        if (mode === 'batch-bad-guard') {
          return sendJson(200, {
            success: true,
            errors: [],
            result: [
              { success: true, results: [], meta: { changes: 1 } },
              { success: true, results: [{ guard_ok: 0 }], meta: { changes: 0 } },
            ],
          })
        }
        if (mode === 'fk-sentinel') {
          return sendJson(400, { success: false, errors: [{ message: '__datanoa_fk_violation__' }], result: [] })
        }
        if (mode === 'http-500-empty') {
          res.statusCode = 500
          return res.end('')
        }
        if (mode === 'http-500-json') {
          return sendJson(500, { success: false, errors: [], result: [] })
        }
        if (mode === 'http-500-json-err') {
          return sendJson(500, { success: false, errors: [{ message: 'D1 unavailable' }], result: [] })
        }
        if (mode === 'malformed-mut-item') {
          return sendJson(200, { success: true, errors: [], result: ['bad-item'] })
        }
        if (mode === 'non-bool-stmt-success') {
          return sendJson(200, { success: true, errors: [], result: [{ success: 'yes' }] })
        }
        if (mode === 'empty-ddl') {
          return sendJson(200, { success: true, errors: [], result: [{ success: true, results: [], meta: { changes: 0 } }] })
        }

        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            sql?: string
            params?: unknown[]
            batch?: Array<{ sql: string; params?: unknown[] }>
          }

          if (Array.isArray(parsed.batch)) {
            const results: Array<{ success: boolean; results: Record<string, unknown>[]; meta: { changes: number } }> = []
            db.exec('BEGIN;')
            try {
              for (const item of parsed.batch) {
                results.push(execSqliteStatement(db, item.sql, item.params || []))
              }
              db.exec('COMMIT;')
              return sendJson(200, { success: true, errors: [], result: results })
            } catch (err: unknown) {
              try {
                db.exec('ROLLBACK;')
              } catch {
                // Ignore rollback error
              }
              const msg = err instanceof Error ? err.message : String(err)
              return sendJson(400, { success: false, errors: [{ message: msg }] })
            }
          }

          const singleRes = execSqliteStatement(db, parsed.sql || '', parsed.params || [])
          return sendJson(200, { success: true, errors: [], result: [singleRes] })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          return sendJson(400, { success: false, errors: [{ message: msg }] })
        }
      })
    })

    await new Promise<void>((resolve) => {
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address() as { port: number }
        baseUrl = `http://127.0.0.1:${addr.port}/query`
        resolve()
      })
    })
  })

  afterAll(async () => {
    for (const release of [...activeSlowReleases]) release()
    activeSlowReleases.clear()
    try {
      srv.closeAllConnections?.()
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    } catch {
      // Ignore server close error
    }
    try {
      db.close()
    } catch {
      // Ignore DB close error
    }
  })

  const makeProfile = (overrides: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
    id: 'cov-d1-live',
    name: 'Local D1 Emulator',
    type: 'd1',
    url: baseUrl,
    ...overrides,
  })

  it('validates endpoint resolution (Cloudflare API URL vs loopback HTTP vs invalid configs) & D1 parameter PBT', async () => {
    const driver = new D1Driver()

    // Invalid endpoint configs
    await expect(driver.createSession({ id: '1', name: 'Bad', type: 'd1' })).rejects.toThrow(/Account ID and Database ID/i)
    await expect(
      driver.createSession({ id: '1', name: 'Bad', type: 'd1', d1AccountId: 'bad$id', d1DatabaseId: 'db1' })
    ).rejects.toThrow(/only contain/i)
    await expect(
      driver.createSession({ id: '1', name: 'Bad', type: 'd1', url: 'http://127.0.0.1:8787/query' }, 'secret-token')
    ).rejects.toThrow()

    const failConn = await driver.testConnection({ id: '1', name: 'Unreachable', type: 'd1', url: 'http://127.0.0.1:59997/query' })
    expect(failConn.ok).toBe(false)

    // Cloudflare HTTPS API URL construction via mocked fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, errors: [], result: [{ success: true, results: [{ '1': 1 }], meta: { changes: 0 } }] }), { status: 200 })
    )
    try {
      const cfSession = await driver.createSession(
        { id: 'cf', name: 'CF', type: 'd1', d1AccountId: 'acct_123', d1DatabaseId: 'db_456' },
        'tok-xyz'
      )
      expect((await cfSession.test()).ok).toBe(true)
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts/acct_123/d1/database/db_456/query',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer tok-xyz' }),
        })
      )
      await cfSession.close()
    } finally {
      fetchSpy.mockRestore()
    }

    // PBT parameter normalization across SQLite D1 parameter types via live HTTP SQL execution
    const sess = await driver.createSession(makeProfile())
    try {
      const execRaw = (sess as unknown as { queryExecutor: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]> }).queryExecutor
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.constant(null),
            fc.constant(undefined),
            fc.boolean(),
            fc.integer({ min: -10000, max: 10000 }),
            fc.constant(NaN),
            fc.constant(BigInt(9007199254740999)),
            fc.bigInt({ min: -1000n, max: 1000n }),
            fc.string({ maxLength: 16 }),
            fc.constant(new Date('2025-05-01T00:00:00Z')),
            fc.constant(new Date('invalid')),
            fc.constant(new Uint8Array([1, 2, 3])),
            fc.constant(new Uint8Array([4, 5]).buffer),
            fc.constant({ nestedBig: 12n })
          ),
          async (paramVal) => {
            const rows = await execRaw('SELECT ? AS v;', [paramVal])
            expect(rows).toHaveLength(1)
          }
        ),
        { numRuns: 20 }
      )
    } finally {
      await sess.close()
    }
  })

  it('exercises live D1 schema introspection, DDL export, fetchPage, updateCell, preview/applyChanges, runQuery, cancel & error envelope branches', async () => {
    const driver = new D1Driver()
    expect((await driver.testConnection(makeProfile())).ok).toBe(true)

    const sess = await driver.createSession(makeProfile())
    try {
      expect(sess.isAlive()).toBe(true)
      expect((await sess.test()).ok).toBe(true)
      expect(await sess.listSchemas()).toEqual({ schemas: ['main'], defaultSchema: 'main' })

      const objs = await sess.listObjects('main')
      expect(objs.some((o) => o.name === 'users' && o.kind === 'table')).toBe(true)
      expect(objs.some((o) => o.name === 'v_users' && o.kind === 'view')).toBe(true)

      const details = await sess.getTableDetails('users')
      expect(details.primaryKey).toEqual(['id'])
      expect(await sess.getDdl('users')).toContain('CREATE INDEX')
      expect(await sess.getObjectDdl('v_users', 'view')).toContain('CREATE VIEW')
      expect(await sess.getObjectDdl('trg_users_audit', 'trigger')).toContain('CREATE TRIGGER')
      const exported = await sess.exportSchemaDdl('main')
      expect(exported.objectCount).toBeGreaterThanOrEqual(4)

      const page = await sess.fetchPage({
        table: 'users',
        page: 1,
        pageSize: 10,
        whereClause: "email = 'alice@example.com'",
        orderByClause: 'id ASC',
      })
      expect(page.totalRows).toBe(1)

      // updateCell happy path + optimistic lock conflict
      const upd = await sess.updateCell({
        table: 'users',
        primaryKeys: { id: 1 },
        column: 'score',
        originalValue: 10.5,
        newValue: 99.5,
      })
      expect(upd.affectedRows).toBe(1)
      await expect(
        sess.updateCell({
          table: 'users',
          primaryKeys: { id: 1 },
          column: 'score',
          originalValue: 10.5,
          newValue: 50,
        })
      ).rejects.toThrow(/conflict/i)

      // previewChanges & applyChanges (multi-row insert, DEFAULT VALUES insert, mixed shapes, update, delete)
      const preview = await sess.previewChanges({
        table: 'users',
        inserts: [{ org_id: 1, email: 'carol@example.com', score: 30 }],
      })
      expect(preview.statements).toHaveLength(1)

      expect(await sess.applyChanges({ table: 'users' })).toEqual({
        ok: true,
        inserted: 0,
        updated: 0,
        deleted: 0,
        statements: [],
      })

      const applyRes = await sess.applyChanges({
        table: 'users',
        inserts: [
          { org_id: 1, email: 'carol@example.com', score: 30 },
          { org_id: 1, email: 'dave@example.com', score: 40 },
          { org_id: 2, email: 'eve@example.com' },
        ],
        updates: [{ primaryKeys: { id: 2 }, changes: { score: 25 }, originalRow: { score: 20 } }],
      })
      expect(applyRes.inserted).toBe(3)
      expect(applyRes.updated).toBe(1)

      await sess.applyChanges({ table: 'def_tbl', inserts: [{}] }) // DEFAULT VALUES branch

      // Optimistic conflict in applyChanges triggers D1_GUARD_SQL bad json path -> conflict!
      await expect(
        sess.applyChanges({
          table: 'users',
          updates: [{ primaryKeys: { id: 2 }, changes: { score: 1 }, originalRow: { score: 999 } }],
        })
      ).rejects.toThrow(/conflict/i)

      // Limits: >100 bound params and >100KB SQL
      await expect(
        sess.applyChanges({
          table: 'users',
          deletes: Array.from({ length: 1 }, () =>
            Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`c${i}`, i]))
          ),
        })
      ).rejects.toThrow(/at most 100/i)

      // Single & multi-statement runQuery + PRAGMA + FK violation + cancelQuery
      await expect(sess.runQuery('empty', '   ')).rejects.toThrow(/empty/i)
      const singleQ = await sess.runQuery('q-sel', 'SELECT id, email FROM users ORDER BY id LIMIT 2;')
      expect(singleQ.isSelect).toBe(true)
      expect(singleQ.rowCount).toBe(2)

      const multiQ = await sess.runQuery(
        'q-multi',
        "INSERT INTO orgs (name) VALUES ('QA'); PRAGMA table_info('orgs'); SELECT COUNT(*) AS cnt FROM users;"
      )
      expect(multiQ.resultSets?.length).toBe(3)

      // Multi-statement PRAGMA foreign_key_check detection
      await expect(
        sess.runQuery(
          'q-fk',
          "PRAGMA foreign_keys = OFF; INSERT INTO users (org_id, email) VALUES (9999, 'orphan@x.io'); PRAGMA foreign_key_check;"
        )
      ).rejects.toThrow(/FOREIGN KEY/i)
      await sess.runQuery('q-fk-cleanup', "DELETE FROM users WHERE email = 'orphan@x.io'; PRAGMA foreign_keys = ON;")

      // cancelQuery aborting slow HTTP request cleanly
      const slowGate = armSlowRequest()
      try {
        const slowP = sess.runQuery('q-slow', 'SELECT 1;').catch((e) => e)
        await slowGate.arrived
        await sess.cancelQuery('q-slow')
        const slowErr = await slowP
        expect(slowErr).toBeInstanceOf(Error)
      } finally {
        slowGate.release()
      }
      expect((await sess.cancelQuery('nonexistent')).ok).toBe(true)

      // Transaction unsupported contract
      expect(sess.getTransactionState().supported).toBe(false)
      await expect(sess.beginTransaction()).rejects.toThrow()
      await expect(sess.commitTransaction()).rejects.toThrow()
      await expect(sess.rollbackTransaction()).rejects.toThrow()
      await expect(sess.setAutoCommit(false)).rejects.toThrow()
      expect(await sess.setAutoCommit(true)).toMatchObject({ supported: false })

      // Protocol error / envelope parsing fault coverage
      for (const fm of [
        'bad-json',
        'non-object',
        'bad-success',
        'bad-errors',
        'http-500-text',
        'envelope-fail',
      ]) {
        faultMode = fm
        await expect(sess.runQuery(`fault-${fm}`, 'SELECT 1;')).rejects.toThrow()
      }
      for (const fm of [
        'malformed-mut-result',
        'two-mut-results',
        'stmt-fail',
        'bad-meta',
        'bad-changes',
        'bad-results',
      ]) {
        faultMode = fm
        await expect(sess.applyChanges({ table: 'orgs', inserts: [{}] })).rejects.toThrow()
      }
      faultMode = 'batch-mismatch'
      await expect(sess.runQuery('fault-bm', 'SELECT 1; SELECT 2;')).rejects.toThrow(/unexpected number/i)
      faultMode = 'batch-bad-guard'
      await expect(
        sess.applyChanges({ table: 'users', deletes: [{ id: 1 }] })
      ).rejects.toThrow(/did not confirm/i)

      // Attached schema DDL & reconstructTableDdl fallback + comment/CTE/large/chunk paths
      expect(await sess.getDdl('alt_items', 'alt')).toContain('alt_items')
      faultMode = 'empty-ddl'
      expect(await sess.getDdl('orgs')).toMatch(/CREATE TABLE/i)
      const cteRes = await sess.runQuery('q-cte', 'WITH c AS (SELECT 1 AS v) SELECT * FROM c; EXPLAIN SELECT 1;')
      expect(cteRes.resultSets?.length).toBe(2)
      const commentRes = await sess.runQuery('q-empty-stmt', '-- only comment\n/* c */')
      expect(commentRes.isSelect).toBe(false)

      // Multi-column-signature + payload-budget insert batching + internal SQL size guard
      const bigText = 'z'.repeat(18_000)
      const batchChunkRes = await sess.applyChanges({
        table: 'users',
        inserts: [
          { org_id: 1, email: 'c1@x.io', score: 1, created_at: bigText },
          { org_id: 1, email: 'c2@x.io', score: 2 },
          { org_id: 1, email: 'c3@x.io', score: 3, created_at: bigText },
          { org_id: 1, email: 'c4@x.io', score: 4, created_at: bigText },
          { org_id: 1, email: 'c5@x.io', score: 5, created_at: bigText },
        ],
      })
      expect(batchChunkRes.inserted).toBe(5)
      await expect(
        sess.runQuery('q-batch-oversize', `SELECT 1; SELECT '${'x'.repeat(102 * 1024)}';`)
      ).rejects.toThrow(/bytes per SQL/i)

      // Extra fault modes & single/batch fetch error paths
      for (const fm of [
        'fk-sentinel',
        'http-500-empty',
        'http-500-json',
        'http-500-json-err',
        'malformed-mut-item',
        'non-bool-stmt-success',
      ]) {
        faultMode = fm
        await expect(sess.applyChanges({ table: 'orgs', inserts: [{}] })).rejects.toThrow()
      }
      for (const fm of ['http-500-json', 'http-500-json-err']) {
        faultMode = fm
        await expect(sess.runQuery(`single-${fm}`, 'SELECT 1;')).rejects.toThrow(/success|D1|unavailable/i)
      }
      for (const fm of ['http-500-empty', 'envelope-fail', 'malformed-mut-result']) {
        faultMode = fm
        await expect(sess.runQuery(`batch-${fm}`, 'SELECT 1; SELECT 2;')).rejects.toThrow()
      }
      faultMode = 'batch-mismatch'
      await expect(
        sess.applyChanges({ table: 'orgs', inserts: [{ name: 'A' }, { id: 999999, name: 'B' }] })
      ).rejects.toThrow(/unexpected number/i)

      // Fallback param normalization (symbol) & direct fetch Timeout/generic failures
      const normRes = await (sess as unknown as { queryExecutor: (s: string, p: unknown[]) => Promise<unknown[]> }).queryExecutor(
        'SELECT ? AS sym;',
        [Symbol('tag')]
      )
      expect(normRes.length).toBe(1)

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      try {
        fetchSpy.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
        await expect(sess.runQuery('to-1', 'SELECT 1;')).rejects.toThrow(/timed out/i)
        fetchSpy.mockRejectedValueOnce(new Error(''))
        await expect(sess.runQuery('err-1', 'SELECT 1;')).rejects.toThrow(/HTTP request failed/i)
        fetchSpy.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
        await expect(sess.runQuery('to-b', 'SELECT 1; SELECT 2;')).rejects.toThrow(/timed out/i)
        fetchSpy.mockRejectedValueOnce(new Error(''))
        await expect(sess.runQuery('err-b', 'SELECT 1; SELECT 2;')).rejects.toThrow(/HTTP request failed/i)
        fetchSpy.mockRejectedValueOnce('raw-empty-throw')
        expect((await sess.test()).ok).toBe(false)
      } finally {
        fetchSpy.mockRestore()
      }

      // Cancel active batch query + close session while query is in flight
      const slowBatchGate = armSlowRequest()
      try {
        const slowBatch = sess.runQuery('q-slow-batch', 'SELECT 1; SELECT 2;').catch((e) => e)
        await slowBatchGate.arrived
        await sess.cancelQuery('q-slow-batch')
        expect(await slowBatch).toBeInstanceOf(Error)
      } finally {
        slowBatchGate.release()
      }

      const closeAbortGate = armSlowRequest()
      try {
        const inFlightOnClose = sess.runQuery('q-close-abort', 'SELECT 1;').catch((e) => e)
        await closeAbortGate.arrived
        await sess.close()
        expect(await inFlightOnClose).toBeInstanceOf(Error)
      } finally {
        closeAbortGate.release()
      }
    } finally {
      await sess.close()
      await sess.close() // idempotent close
    }

    // Closed guards + readOnly guards
    expect(sess.isAlive()).toBe(false)
    expect((await sess.test()).ok).toBe(false)
    await expect(sess.runQuery('closed', 'SELECT 1')).rejects.toThrow(/closed/i)
    await expect(sess.applyChanges({ table: 'users', inserts: [{ org_id: 1, email: 'a@b.c' }] })).rejects.toThrow(/closed/i)

    const roSess = await driver.createSession(makeProfile({ readOnly: true }))
    try {
      await expect(roSess.runQuery('ro-q', 'DELETE FROM users;')).rejects.toThrow(/read-only/i)
      await expect(
        roSess.updateCell({ table: 'users', primaryKeys: { id: 1 }, column: 'score', originalValue: 1, newValue: 2 })
      ).rejects.toThrow(/read-only/i)
      await expect(roSess.applyChanges({ table: 'users', inserts: [{ org_id: 1, email: 'r@x.io' }] })).rejects.toThrow(/read-only/i)
    } finally {
      await roSess.close()
    }
  }, 20000)
})
