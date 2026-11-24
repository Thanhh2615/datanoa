import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionProfile } from '../src/drivers/common/driver'
import { SqliteDriver, SqliteSession } from '../src/drivers/sqlite/driver'

const tmpRoot = path.join(os.tmpdir(), 'ai-work', 'datanoa', 'coverage-100-full', 'tmp-sqlite')
const trackedSessions: SqliteSession[] = []

function trackSession(session: SqliteSession): SqliteSession {
  trackedSessions.push(session)
  return session
}

function makeProfile(id: string, filePath: string, readOnly = false): ConnectionProfile {
  return {
    id,
    name: id,
    driver: 'sqlite',
    filePath,
    readOnly,
  }
}

describe('Wave 2A-1 Live SQLite: SqliteDriver & SqliteSession (real Worker threads + file DBs)', () => {
  const driver = new SqliteDriver()
  let mainDbPath = ''
  let auxDbPath = ''
  let cancelDbPath = ''

  beforeAll(() => {
    fs.mkdirSync(tmpRoot, { recursive: true })
    mainDbPath = path.join(tmpRoot, 'live-main.db')
    auxDbPath = path.join(tmpRoot, 'live-aux.db')
    cancelDbPath = path.join(tmpRoot, 'live-cancel.db')
  })

  afterAll(async () => {
    for (const s of trackedSessions) {
      await s.close().catch(() => {})
    }
    trackedSessions.length = 0
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('tests valid :memory: and file connections and handles missing readOnly DB failures', async () => {
    const okMem = await driver.testConnection(makeProfile('mem', ':memory:'))
    expect(okMem.ok).toBe(true)
    expect(okMem.message).toContain('SQLite')

    const okFile = await driver.testConnection(makeProfile('file', mainDbPath))
    expect(okFile.ok).toBe(true)

    const missingPath = path.join(tmpRoot, 'missing-dir', 'missing.db')
    const failRo = await driver.testConnection(makeProfile('ro-fail', missingPath, true))
    expect(failRo.ok).toBe(false)
    expect(failRo.message).toBeTruthy()
  })

  it('executes real file schema, ATTACH aux DB, introspection, DDL export, caching, and CRUD/batch mutations', async () => {
    // Seed aux DB first
    const auxSeed = trackSession((await driver.createSession(makeProfile('aux-seed', auxDbPath))) as SqliteSession)
    await auxSeed.runQuery('aux1', 'CREATE TABLE aux_items (id INTEGER PRIMARY KEY, label TEXT NOT NULL);')
    await auxSeed.runQuery('aux2', "INSERT INTO aux_items (label) VALUES ('aux_row_1');")
    await auxSeed.close()

    const session = trackSession((await driver.createSession(makeProfile('main-live', mainDbPath))) as SqliteSession)
    expect(session.isAlive()).toBe(true)
    expect(await session.test()).toEqual({ ok: true, message: 'SQLite connection valid' })

    const ddlSetup = `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        status TEXT DEFAULT 'active',
        score INTEGER CHECK (score >= 0)
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        note TEXT
      );
      CREATE TABLE kv_pairs (
        k1 TEXT,
        k2 TEXT,
        val TEXT,
        PRIMARY KEY (k1, k2)
      );
      CREATE INDEX idx_users_status ON users(status);
      CREATE VIEW active_users AS SELECT id, email FROM users WHERE status = 'active';
      CREATE TRIGGER trg_users_insert AFTER INSERT ON users BEGIN
        INSERT INTO orders (id, user_id, note) VALUES (NEW.id * 100, NEW.id, 'welcome');
      END;
    `
    await session.runQuery('q-ddl', ddlSetup)

    const escAux = auxDbPath.replace(/'/g, "''")
    await session.runQuery('q-attach', `ATTACH DATABASE '${escAux}' AS aux;`)

    const schemas = await session.listSchemas()
    expect(schemas.defaultSchema).toBe('main')
    expect(schemas.schemas).toContain('main')
    expect(schemas.schemas).toContain('aux')

    const mainObjs = await session.listObjects('main')
    expect(mainObjs.some((o) => o.name === 'users' && o.kind === 'table')).toBe(true)
    expect(mainObjs.some((o) => o.name === 'active_users' && o.kind === 'view')).toBe(true)

    const auxObjs = await session.listObjects('aux')
    expect(auxObjs.some((o) => o.name === 'aux_items' && o.kind === 'table')).toBe(true)

    // Table details cold & cache hit + aux table details
    const uDetails1 = await session.getTableDetails('users')
    const uDetails2 = await session.getTableDetails('users', 'main')
    expect(uDetails2).toStrictEqual(uDetails1)
    expect(uDetails1.primaryKey).toEqual(['id'])
    const auxDetails = await session.getTableDetails('aux_items', 'aux')
    expect(auxDetails.columns.map((c) => c.name)).toContain('label')

    // getObjectDdl & getDdl & exportSchemaDdl
    expect(await session.getObjectDdl('users', 'table', 'main')).toContain('CREATE TABLE')
    expect(await session.getObjectDdl('active_users', 'view', 'main')).toContain('CREATE VIEW')
    expect(await session.getObjectDdl('trg_users_insert', 'trigger', 'main')).toContain('CREATE TRIGGER')
    await expect(session.getObjectDdl('idx_users_status', 'index' as never, 'main')).rejects.toThrow(/DDL not found/)
    expect(await session.getDdl('aux_items', 'aux')).toContain('aux_items')
    expect(await session.getDdl('sqlite_master', 'main')).toContain('sqlite_master')

    const fullExport = await session.exportSchemaDdl('   ')
    expect(fullExport.ddl).toContain('CREATE TABLE')
    expect(fullExport.objectCount).toBeGreaterThanOrEqual(2)

    // Seed rows and run fetchPage + updateCell
    await session.runQuery(
      'q-seed',
      "INSERT INTO users (id, email, status, score) VALUES (1, 'a@x.dev', 'active', 10), (2, 'b@x.dev', 'active', 20), (3, 'c@x.dev', 'paused', 30);"
    )
    const page1 = await session.fetchPage({
      table: 'users',
      page: 1,
      pageSize: 2,
      sortColumn: 'id',
      sortDirection: 'DESC',
      whereClause: "status = 'active'",
      orderByClause: 'id ASC',
    })
    expect(page1.totalRows).toBe(2)
    expect(page1.rows.length).toBe(2)

    const updRegular = await session.updateCell({
      table: 'users',
      column: 'score',
      newValue: 99,
      primaryKeys: { id: 1 },
      originalValue: 10,
      columnType: 'INTEGER',
    })
    expect(updRegular.ok).toBe(true)
    expect(updRegular.updatedRecord?.score).toBe(99)

    // Edit primary key column directly (covers editedColumn reload path)
    await session.runQuery('q-kv-seed', "INSERT INTO kv_pairs (k1, k2, val) VALUES ('oldK1', 'rowK2', 'v');")
    const updPk = await session.updateCell({
      table: 'kv_pairs',
      column: 'k1',
      newValue: 'newK1',
      primaryKeys: { k1: 'oldK1', k2: 'rowK2' },
      originalValue: 'oldK1',
    })
    expect(updPk.ok).toBe(true)
    expect(updPk.updatedRecord?.k1).toBe('newK1')
  })

  it('handles previewChanges, applyChanges, optimistic conflicts, BigInt, multi-resultSets, and full tx lifecycle', async () => {
    const dbFile = path.join(tmpRoot, 'live-tx.db')
    const session = trackSession((await driver.createSession(makeProfile('tx-live', dbFile))) as SqliteSession)

    await session.runQuery(
      'init-tbl',
      'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER); CREATE TABLE nullable_pk (id TEXT PRIMARY KEY, note TEXT);'
    )
    await session.runQuery('seed-null', "INSERT INTO nullable_pk (id, note) VALUES (NULL, 'n1');")
    await expect(
      session.updateCell({
        table: 'nullable_pk',
        column: 'note',
        newValue: 'n2',
        primaryKeys: { id: null },
        originalValue: 'n1',
      })
    ).resolves.toMatchObject({ ok: true })

    // Missing row optimistic conflict in updateCell
    await expect(
      session.updateCell({
        table: 'items',
        column: 'name',
        newValue: 'ghost',
        primaryKeys: { id: 999 },
        originalValue: 'none',
      })
    ).rejects.toMatchObject({ code: 'conflict' })

    // Empty applyChanges fast-path & previewChanges
    const emptyBatch = await session.applyChanges({ table: 'items', inserts: [], updates: [], deletes: [] })
    expect(emptyBatch).toEqual({ ok: true, inserted: 0, updated: 0, deleted: 0, statements: [] })

    const preview = await session.previewChanges({
      table: 'items',
      inserts: [{ id: 1, name: 'one', qty: 5 }, { id: 2, name: 'two', qty: 10 }],
    })
    expect(preview.statements.length).toBe(2)

    const applied = await session.applyChanges({
      table: 'items',
      inserts: [{ id: 1, name: 'one', qty: 5 }, { id: 2, name: 'two', qty: 10 }],
    })
    expect(applied.inserted).toBe(2)

    // Updates & deletes via applyChanges + manual tx SAVEPOINT
    expect(session.getTransactionState()).toMatchObject({ active: false, autoCommit: true, supported: true })
    const txStarted = await session.beginTransaction()
    expect(txStarted.active).toBe(true)

    const inTxBatch = await session.applyChanges({
      table: 'items',
      updates: [{ primaryKeys: { id: 1 }, changes: { qty: 15 }, originalRow: { id: 1, name: 'one', qty: 5 } }],
      deletes: [{ id: 2 }],
    })
    expect(inTxBatch.updated).toBe(1)
    expect(inTxBatch.deleted).toBe(1)

    // Saving in-tx batch conflict should roll back savepoint without breaking manual tx
    await expect(
      session.applyChanges({
        table: 'items',
        updates: [{ primaryKeys: { id: 999 }, changes: { qty: 0 }, originalRow: { id: 999, qty: 0 } }],
      })
    ).rejects.toMatchObject({ code: 'conflict' })

    const txCommitted = await session.commitTransaction()
    expect(txCommitted.active).toBe(false)

    // Rollback + setAutoCommit(false) -> auto-begin -> error while switching back
    await session.beginTransaction()
    await session.runQuery('in-rb', "INSERT INTO items (id, name, qty) VALUES (3, 'rb', 1);")
    const txRolledBack = await session.rollbackTransaction()
    expect(txRolledBack.active).toBe(false)

    const manualMode = await session.setAutoCommit(false)
    expect(manualMode.autoCommit).toBe(false)
    await session.runQuery('auto-begins', "INSERT INTO items (id, name, qty) VALUES (4, 'auto', 4);")
    expect(session.getTransactionState().active).toBe(true)
    await expect(session.setAutoCommit(true)).rejects.toThrow(/Commit or rollback/i)
    await session.commitTransaction()
    expect((await session.setAutoCommit(true)).autoCommit).toBe(true)

    // Single truncated SELECT, BigInt formatting, multi-statement resultSets, failing DDL cache reset
    const bigRes = await session.runQuery(
      'q-big',
      'SELECT 9007199254740993 AS big, 1 AS small UNION ALL SELECT 2, 2 UNION ALL SELECT 3, 3;',
      2
    )
    expect(bigRes.truncated).toBe(true)
    expect(bigRes.rows[0][0]).toBe('9007199254740993')

    const multiRes = await session.runQuery(
      'q-multi',
      "INSERT INTO items (id, name, qty) VALUES (10, 'm', 1); SELECT id, name FROM items WHERE id = 10;"
    )
    expect(multiRes.resultSets?.length).toBe(2)

    await expect(session.runQuery('q-bad-ddl', 'CREATE TABLE "";')).rejects.toThrow()
    await session.close()
  })

  it('supports cancelQuery on slow UDF, concurrent cancel wait, worker crash/exit handlers, and closed guards', async () => {
    const prevUdf = process.env.DATANOA_ENABLE_TEST_UDF
    process.env.DATANOA_ENABLE_TEST_UDF = '1'
    try {
      const session = trackSession((await driver.createSession(makeProfile('cancel-live', cancelDbPath))) as SqliteSession)
      await session.runQuery('c-init', 'CREATE TABLE log (x INTEGER); INSERT INTO log (x) VALUES (7);')

      // Idempotent cancel for unknown query
      expect(await session.cancelQuery('missing-q')).toEqual({ ok: true })

      // Real slow query via DATANOA_ENABLE_TEST_UDF sleep_ms(...)
      const qPromise = session.runQuery('slow-q', 'SELECT sleep_ms(1200) AS done;')
      await new Promise((r) => setTimeout(r, 40))

      const c1 = session.cancelQuery('slow-q')
      // Enqueue a follow-up query while cancelPromise is active to cover sendToWorker cancel wait
      const qAfter = session.runQuery('after-cancel', 'SELECT x FROM log;')

      await expect(qPromise).rejects.toMatchObject({ code: 'cancelled' })
      expect(await c1).toEqual({ ok: true })
      const resAfter = await qAfter
      expect(resAfter.rows).toEqual([[7]])

      // Simulate worker 'error' event while a request is pending
      const errSession = trackSession((await driver.createSession(makeProfile('err-live', ':memory:'))) as SqliteSession)
      const internalWorker = (errSession as unknown as {
        worker: { emit(ev: string, arg: unknown): void } | null
      }).worker
      const pendingBeforeCrash = errSession.runQuery('q-crash', 'SELECT sleep_ms(800);')
      await new Promise((r) => setTimeout(r, 20))
      internalWorker?.emit('error', new Error('simulated worker error'))
      await expect(pendingBeforeCrash).rejects.toMatchObject({ code: 'WORKER_CRASHED' })
      // Unexpected non-zero exit event also marks session closed & rejects pending requests
      internalWorker?.emit('exit', 1)
      expect(errSession.isAlive()).toBe(false)
      await errSession.close()

      // Normal close + duplicate close + closed-session error checks across all methods
      const closedSess = trackSession((await driver.createSession(makeProfile('close-live', ':memory:'))) as SqliteSession)
      const inFlightAtClose = closedSess.runQuery('q-close', 'SELECT sleep_ms(3000);')
      const [cA, cB] = [closedSess.close(), closedSess.close()]
      await expect(inFlightAtClose).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await Promise.all([cA, cB])
      expect(closedSess.isAlive()).toBe(false)
      expect((await closedSess.test()).ok).toBe(false)
      await expect(closedSess.listObjects()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(closedSess.listSchemas()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(closedSess.getObjectDdl('t', 'table')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(closedSess.exportSchemaDdl()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(closedSess.getTableDetails('t')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(closedSess.fetchPage({ table: 't', page: 1, pageSize: 10 })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(
        closedSess.updateCell({ table: 't', column: 'c', newValue: 1, primaryKeys: { id: 1 }, originalValue: 0 })
      ).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(closedSess.previewChanges({ table: 't' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(closedSess.applyChanges({ table: 't' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(closedSess.getDdl('t')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(closedSess.runQuery('q', 'SELECT 1')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(closedSess.cancelQuery('q')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(closedSess.beginTransaction()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(closedSess.commitTransaction()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(closedSess.rollbackTransaction()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(closedSess.setAutoCommit(true)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })

      // Close remaining SqliteDriver branches: omitted schema defaults, concurrent cancelQuery + pendingRequests reject,
      // cancel+close race, respawn failure on missing readonly dir, exit while request pending, and worker error message fallbacks
      const extraSess = trackSession((await driver.createSession(makeProfile('extra-live', ':memory:'))) as SqliteSession)
      await extraSess.runQuery('ex-ddl', 'CREATE TABLE t_ex (id INTEGER PRIMARY KEY); CREATE TRIGGER trg_ex AFTER INSERT ON t_ex BEGIN SELECT 1; END;')
      expect((await extraSess.listObjects()).some((o) => o.name === 't_ex')).toBe(true)
      expect(await extraSess.getObjectDdl('trg_ex', 'trigger')).toContain('CREATE TRIGGER')
      expect((await extraSess.exportSchemaDdl()).ddl).toContain('t_ex')

      const qSlow1 = extraSess.runQuery('ex-q1', 'SELECT sleep_ms(600);').then(
        () => null,
        (e: unknown) => e
      )
      const qSlow2 = extraSess.runQuery('ex-q2', 'SELECT sleep_ms(600);').then(
        () => null,
        (e: unknown) => e
      )
      await new Promise((r) => setTimeout(r, 40))
      const cancelFirst = extraSess.cancelQuery('ex-q1')
      const cancelSecond = extraSess.cancelQuery('ex-q2')
      expect(await cancelFirst).toEqual({ ok: true })
      expect(await cancelSecond).toEqual({ ok: true })
      expect(await qSlow1).toMatchObject({ code: 'cancelled' })
      expect(await qSlow2).toMatchObject({ code: 'cancelled' })

      // Worker message edge cases (missing id, empty error object) & exit while pending
      const wRef = (extraSess as unknown as {
        worker: { emit(ev: string, arg: unknown): void } | null
        reqSeq: number
      }).worker
      wRef?.emit('message', { ok: true })
      const expectedReqId = `req_${
        (extraSess as unknown as { reqSeq: number }).reqSeq + 1
      }`
      const pMsgErr = extraSess.runQuery('ex-msg-err', 'SELECT sleep_ms(600);').then(
        () => null,
        (e: unknown) => e
      )
      await new Promise((r) => setTimeout(r, 20))
      wRef?.emit('message', { id: expectedReqId, ok: false, error: {} })
      expect(await pMsgErr).toMatchObject({ message: 'SQLite worker error', code: 'SQLITE_ERROR' })

      const pExitPending = extraSess.runQuery('ex-exit-pend', 'SELECT sleep_ms(600);').then(
        () => null,
        (e: unknown) => e
      )
      await new Promise((r) => setTimeout(r, 20))
      wRef?.emit('exit', 2)
      expect(await pExitPending).toMatchObject({ code: 'WORKER_CRASHED' })
      await extraSess.close()

      // cancelQuery immediately followed by close() before respawn completes
      const raceSess = trackSession((await driver.createSession(makeProfile('race-close', ':memory:'))) as SqliteSession)
      const pRace = raceSess.runQuery('race-q', 'SELECT sleep_ms(1200);').then(
        () => null,
        (e: unknown) => e
      )
      await new Promise((r) => setTimeout(r, 30))
      const cancelRace = raceSess.cancelQuery('race-q')
      const closeRace = raceSess.close()
      await Promise.all([cancelRace, closeRace])
      expect(await pRace).toBeTruthy()

      // Respawn failure inside cancelQuery when target readOnly file path disappears
      const respawnSess = trackSession((await driver.createSession(makeProfile('respawn-fail', ':memory:'))) as SqliteSession)
      const pRespawn = respawnSess.runQuery('respawn-q', 'SELECT sleep_ms(1200);').then(
        () => null,
        (e: unknown) => e
      )
      await new Promise((r) => setTimeout(r, 30))
      const mutableProfile = respawnSess.profile as { filePath?: string; readOnly?: boolean }
      mutableProfile.filePath = path.join(tmpRoot, 'nonexistent-dir-respawn', 'nope.db')
      mutableProfile.readOnly = true
      await expect(respawnSess.cancelQuery('respawn-q')).rejects.toThrow()
      expect(respawnSess.isAlive()).toBe(false)
      expect(await pRespawn).toMatchObject({ code: 'cancelled' })
      await respawnSess.close()
    } finally {
      if (prevUdf === undefined) {
        delete process.env.DATANOA_ENABLE_TEST_UDF
      } else {
        process.env.DATANOA_ENABLE_TEST_UDF = prevUdf
      }
    }
  })
})
