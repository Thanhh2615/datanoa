import * as dns from 'node:dns'
import { EventEmitter } from 'node:events'
import * as net from 'node:net'
import * as fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from '../vendor/pg.js'
import type { ConnectionProfile } from '../src/drivers/common/driver'
import {
  PostgresDriver,
  PostgresSession,
  formatPostgresError,
  mapSupabaseIpv6ToRegion,
  resolveSupabasePoolerConfig,
} from '../src/drivers/postgres/driver'
import {
  RedisDriver,
  RedisSession,
  redactRedisCommandArgs,
  shouldUseRedisTls,
  tokenizeRedisCommandScript,
} from '../src/drivers/redis/driver'

const PG_HOST = '127.0.0.1'
const PG_PORT = 55433
const PG_USER = 'datanoa'
const PG_PASS = 'datanoa_pass'
const PG_DB = 'datanoa_test'
const PG_SCHEMA = 'cov_pg_live'

const REDIS_HOST = '127.0.0.1'
const REDIS_PORT = 56380
const REDIS_PASS = 'datanoa_redis_pass'
const REDIS_KEYS = [
  'datanoa_cov_test:str',
  'datanoa_cov_test:hash',
  'datanoa_cov_test:list',
  'datanoa_cov_test:set',
  'datanoa_cov_test:zset',
  'datanoa_cov_test:exp',
  'datanoa_cov_test:ttl_str',
  'datanoa_cov_test:batch_ins',
  'datanoa_cov_test:batch_upd',
  'datanoa_cov_test:batch_del',
  'datanoa_cov_root_key',
]

function pgProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'cov-pg',
    name: 'cov-pg',
    driver: 'postgres',
    host: PG_HOST,
    port: PG_PORT,
    database: PG_DB,
    user: PG_USER,
    sslMode: 'disable',
    ...overrides,
  }
}

function redisProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'cov-redis',
    name: 'cov-redis',
    driver: 'redis',
    host: REDIS_HOST,
    port: REDIS_PORT,
    sslMode: 'disable',
    ...overrides,
  }
}

describe('Wave 2A-1 Live PostgreSQL & Redis Drivers', () => {
  const trackedPg: PostgresSession[] = []
  const trackedRedis: RedisSession[] = []

  const trackPg = (s: PostgresSession) => {
    trackedPg.push(s)
    return s
  }
  const trackRedis = (s: RedisSession) => {
    trackedRedis.push(s)
    return s
  }

  beforeAll(async () => {
    const pgDriver = new PostgresDriver()
    const setupPg = trackPg((await pgDriver.createSession(pgProfile(), PG_PASS)) as PostgresSession)
    await setupPg.runQuery('pg-clean-pre', `DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE; CREATE SCHEMA ${PG_SCHEMA};`)
    await setupPg.close()

    const redisDriver = new RedisDriver()
    const setupRedis = trackRedis((await redisDriver.createSession(redisProfile(), REDIS_PASS)) as RedisSession)
    await setupRedis.runQuery('redis-clean-pre', `DEL ${REDIS_KEYS.join(' ')}`)
    await setupRedis.close()
  })

  afterAll(async () => {
    const pgDriver = new PostgresDriver()
    try {
      const cleanupPg = trackPg((await pgDriver.createSession(pgProfile(), PG_PASS)) as PostgresSession)
      await cleanupPg.runQuery('pg-clean-post', `DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE;`)
      await cleanupPg.close()
    } catch {
      // ignore cleanup error if already torn down
    }
    for (const s of trackedPg) {
      await s.close().catch(() => {})
    }

    const redisDriver = new RedisDriver()
    try {
      const cleanupRedis = trackRedis((await redisDriver.createSession(redisProfile(), REDIS_PASS)) as RedisSession)
      await cleanupRedis.runQuery('redis-clean-post', `DEL ${REDIS_KEYS.join(' ')}`)
      await cleanupRedis.close()
    } catch {
      // ignore cleanup error
    }
    for (const s of trackedRedis) {
      await s.close().catch(() => {})
    }
  })

  it('covers Postgres pure helpers, SCRAM/error formatters, IPv6 region PBT, and Supabase non-match passthrough', async () => {
    expect(formatPostgresError(new Error('SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string'), 'postgres', pgProfile({ host: 'db.proj.supabase.co' }))).toContain('Supabase')
    expect(formatPostgresError('SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string', 'cockroachdb')).toContain('CockroachDB')
    expect(formatPostgresError({ message: 404 }, 'postgres')).toBe('404')
    expect(formatPostgresError(null, 'postgres')).toContain('Failed to connect to PostgreSQL')
    expect(formatPostgresError(undefined, 'cockroachdb')).toContain('Failed to connect to CockroachDB')

    const prefixExpectations: ReadonlyArray<[string, string]> = [
      ['2406:da18:', 'ap-southeast-1'],
      ['2406:da1c:', 'ap-northeast-1'],
      ['2406:da14:', 'ap-northeast-2'],
      ['2406:da1a:', 'ap-south-1'],
      ['2406:da12:', 'ap-southeast-2'],
      ['2600:1f18:', 'us-east-1'],
      ['2600:1f16:', 'us-east-2'],
      ['2600:1f14:', 'us-west-2'],
      ['2600:1f1c:', 'us-west-1'],
      ['2600:1f1d:', 'ca-central-1'],
      ['2600:1f1e:', 'sa-east-1'],
      ['2a05:d018:', 'eu-west-1'],
      ['2a05:d014:', 'eu-central-1'],
      ['2a05:d01c:', 'eu-west-2'],
      ['2a05:d012:', 'eu-west-3'],
      ['2a05:d016:', 'eu-north-1'],
      ['2a05:d01a:', 'eu-south-1'],
    ]
    fc.assert(
      fc.property(
        fc.constantFrom(...prefixExpectations),
        fc.stringMatching(/^[0-9a-f]{4,12}$/),
        fc.boolean(),
        ([prefix, region], suffix, upper) => {
          const input = ` ${upper ? prefix.toUpperCase() : prefix}${suffix} `
          expect(mapSupabaseIpv6ToRegion(input)).toBe(region)
        }
      )
    )
    expect(mapSupabaseIpv6ToRegion('fe80::1')).toBe('ap-southeast-1')

    const baseCfg = { host: 'db.local.test', port: 5432 }
    expect(await resolveSupabasePoolerConfig('db.local.test', baseCfg)).toBe(baseCfg)
  })

  it('exercises live Postgres connection modes, full DDL/OID introspection, exportSchemaDdl, CRUD, pinned tx, and cancelQuery', async () => {
    const pgDriver = new PostgresDriver()
    const badAuth = await pgDriver.testConnection(pgProfile(), 'wrong_pass')
    expect(badAuth.ok).toBe(false)
    expect(badAuth.message).toBeTruthy()

    const okTest = await pgDriver.testConnection(pgProfile(), PG_PASS)
    expect(okTest).toEqual({ ok: true, message: 'PostgreSQL connection valid' })

    const session = trackPg((await pgDriver.createSession(pgProfile({ options: '-c application_name=datanoa_cov' }), PG_PASS)) as PostgresSession)
    expect(session.isAlive()).toBe(true)
    expect((await session.test()).ok).toBe(true)

    // Create rich schema covering PG OIDs, sequences, views, materialized views, functions, triggers
    await session.runQuery(
      'pg-ddl-seed',
      `
        CREATE TYPE ${PG_SCHEMA}.mood_t AS ENUM ('ok', 'busy');
        CREATE SEQUENCE ${PG_SCHEMA}.item_seq START 10;
        CREATE TABLE ${PG_SCHEMA}.parents (
          id INTEGER PRIMARY KEY,
          flag BOOLEAN DEFAULT true,
          raw BYTEA,
          s SMALLINT,
          big BIGINT,
          label TEXT NOT NULL,
          bio VARCHAR(40),
          f8 DOUBLE PRECISION,
          num NUMERIC(10, 2),
          j JSON,
          jb JSONB,
          u UUID,
          d DATE,
          t TIME,
          ts TIMESTAMP,
          tstz TIMESTAMPTZ,
          iv INTERVAL,
          tags TEXT[]
        );
        CREATE TABLE ${PG_SCHEMA}.children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES ${PG_SCHEMA}.parents(id) ON DELETE CASCADE,
          title TEXT,
          qty INTEGER
        );
        CREATE VIEW ${PG_SCHEMA}.v_parents AS SELECT id, label FROM ${PG_SCHEMA}.parents;
        CREATE MATERIALIZED VIEW ${PG_SCHEMA}.mv_parents AS SELECT id, label FROM ${PG_SCHEMA}.parents;
        CREATE FUNCTION ${PG_SCHEMA}.fn_add(a INT, b INT) RETURNS INT LANGUAGE sql AS 'SELECT a + b';
        CREATE FUNCTION ${PG_SCHEMA}.trg_fn() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
        CREATE TRIGGER trg_children BEFORE INSERT ON ${PG_SCHEMA}.children FOR EACH ROW EXECUTE FUNCTION ${PG_SCHEMA}.trg_fn();
      `
    )

    const schemas = await session.listSchemas()
    expect(schemas.schemas).toContain(PG_SCHEMA)
    const objs = await session.listObjects(PG_SCHEMA)
    expect(objs.some((o) => o.name === 'parents' && o.kind === 'table')).toBe(true)
    expect(objs.some((o) => o.name === 'v_parents' && o.kind === 'view')).toBe(true)
    expect(objs.some((o) => o.name === 'mv_parents' && o.kind === 'materialized_view')).toBe(true)

    const d1 = await session.getTableDetails('parents', PG_SCHEMA)
    const d2 = await session.getTableDetails('parents', PG_SCHEMA)
    expect(d2).toStrictEqual(d1)
    expect(await session.getDdl('parents', PG_SCHEMA)).toContain('CREATE TABLE')
    expect(await session.getObjectDdl('parents', 'table', PG_SCHEMA)).toContain('CREATE TABLE')
    expect(await session.getObjectDdl('v_parents', 'view', PG_SCHEMA)).toContain('SELECT')
    expect(await session.getObjectDdl('mv_parents', 'materialized_view', PG_SCHEMA)).toContain('SELECT')
    expect(await session.getObjectDdl('item_seq', 'sequence', PG_SCHEMA)).toContain('SEQUENCE')

    const exp = await session.exportSchemaDdl(PG_SCHEMA)
    expect(exp.ddl).toContain('CREATE TABLE')
    expect(exp.objectCount).toBeGreaterThanOrEqual(4)

    // CockroachDB portability view branch exercised against live Postgres port
    const crdbDriver = new PostgresDriver('cockroachdb')
    const crdbSess = trackPg((await crdbDriver.createSession(pgProfile({ driver: 'cockroachdb' }), PG_PASS)) as PostgresSession)
    expect((await crdbSess.test()).message).toBe('CockroachDB connection valid')
    const crdbExp = await crdbSess.exportSchemaDdl(PG_SCHEMA)
    expect(crdbExp.ddl).toContain('parents')
    await crdbSess.close()

    // Seed data rows covering rich OIDs & test fetchPage/updateCell/applyChanges
    await session.runQuery(
      'pg-seed-rows',
      `
        INSERT INTO ${PG_SCHEMA}.parents (id, flag, raw, s, big, label, bio, f8, num, j, jb, u, d, t, ts, tstz, iv, tags) VALUES
          (1, true, '\\xdeadbeef', 7, 9007199254740993, 'alpha', 'b1', 1.5, 12.34, '{"a":1}', '{"b":2}', '11111111-1111-1111-1111-111111111111', '2026-01-01', '12:00:00', '2026-01-01 12:00:00', '2026-01-01 12:00:00+00', '1 day', ARRAY['t1','t2']),
          (2, false, NULL, 8, 200, 'beta', 'b2', 2.5, 56.78, '{}', '{}', '22222222-2222-2222-2222-222222222222', '2026-01-02', '13:00:00', '2026-01-02 13:00:00', '2026-01-02 13:00:00+00', '2 hours', ARRAY['t3']);
        INSERT INTO ${PG_SCHEMA}.children (id, parent_id, title, qty) VALUES (10, 1, 'c1', 3);
      `
    )

    // runQuery SELECT with real OID sourceTable resolution (cold + cached) + maxRows truncation + multi-resultSets
    const oidQ1 = await session.runQuery('pg-oid-1', `SELECT id, label, big, jb FROM ${PG_SCHEMA}.parents ORDER BY id ASC;`, 1)
    expect(oidQ1.truncated).toBe(true)
    expect(oidQ1.sourceTable).toEqual({ schema: PG_SCHEMA, table: 'parents' })
    const oidQ2 = await session.runQuery('pg-oid-2', `SELECT id, label FROM ${PG_SCHEMA}.parents ORDER BY id ASC;`, 5)
    expect(oidQ2.sourceTable).toEqual({ schema: PG_SCHEMA, table: 'parents' })

    const multiPg = await session.runQuery(
      'pg-multi',
      `UPDATE ${PG_SCHEMA}.parents SET bio = 'updated' WHERE id = 2; SELECT id, bio FROM ${PG_SCHEMA}.parents WHERE id = 2;`
    )
    expect(multiPg.resultSets?.length).toBe(2)

    // fetchPage, updateCell (autoCommit + conflict), previewChanges, applyChanges (empty + CRUD + conflict rollback)
    const pPage = await session.fetchPage({
      table: 'parents',
      schema: PG_SCHEMA,
      page: 1,
      pageSize: 10,
      sortColumn: 'id',
      sortDirection: 'ASC',
      whereClause: 'id >= 1',
      orderByClause: 'id DESC',
    })
    expect(pPage.totalRows).toBe(2)

    const updAuto = await session.updateCell({
      table: 'parents',
      schema: PG_SCHEMA,
      column: 'bio',
      newValue: 'auto_edited',
      primaryKeys: { id: 1 },
      originalValue: 'b1',
    })
    expect(updAuto.updatedRecord?.bio).toBe('auto_edited')

    await expect(
      session.updateCell({
        table: 'children',
        schema: PG_SCHEMA,
        column: 'title',
        newValue: 'nope',
        primaryKeys: { id: 9999 },
        originalValue: 'none',
      })
    ).rejects.toMatchObject({ code: 'conflict' })

    expect(await session.applyChanges({ table: 'children', schema: PG_SCHEMA })).toEqual({
      ok: true,
      inserted: 0,
      updated: 0,
      deleted: 0,
      statements: [],
    })

    const previewPg = await session.previewChanges({
      table: 'children',
      schema: PG_SCHEMA,
      inserts: [{ id: 11, parent_id: 1, title: 'c2', qty: 4 }],
    })
    expect(previewPg.statements.length).toBe(1)

    const appliedAuto = await session.applyChanges({
      table: 'children',
      schema: PG_SCHEMA,
      inserts: [{ id: 11, parent_id: 1, title: 'c2', qty: 4 }],
      updates: [{ primaryKeys: { id: 10 }, changes: { qty: 9 }, originalRow: { id: 10, qty: 3 } }],
    })
    expect(appliedAuto.inserted).toBe(1)
    expect(appliedAuto.updated).toBe(1)

    await expect(
      session.applyChanges({
        table: 'children',
        schema: PG_SCHEMA,
        deletes: [{ id: 77777 }],
      })
    ).rejects.toMatchObject({ code: 'conflict' })

    // Pinned transaction lifecycle, SAVEPOINT applyChanges, txAborted detection & TX_ABORTED_ROLLBACK, COMMIT AND CHAIN
    await expect(session.commitTransaction()).rejects.toMatchObject({ code: 'NO_ACTIVE_TX' })
    await expect(session.rollbackTransaction()).rejects.toMatchObject({ code: 'NO_ACTIVE_TX' })

    expect((await session.beginTransaction()).active).toBe(true)
    await expect(session.beginTransaction()).rejects.toMatchObject({ code: 'TX_ALREADY_ACTIVE' })
    await expect(session.setAutoCommit(true)).rejects.toMatchObject({ code: 'TX_ACTIVE' })

    await session.fetchPage({ table: 'children', schema: PG_SCHEMA, page: 1, pageSize: 5 })
    await session.updateCell({
      table: 'children',
      schema: PG_SCHEMA,
      column: 'title',
      newValue: 'pinned_upd',
      primaryKeys: { id: 10 },
      originalValue: 'c1',
    })
    await session.applyChanges({
      table: 'children',
      schema: PG_SCHEMA,
      deletes: [{ id: 11 }],
    })

    // Trigger SQL error inside manual tx -> txAborted becomes true -> commitTransaction detects ROLLBACK command tag
    await expect(session.runQuery('pg-tx-bad', `SELECT * FROM ${PG_SCHEMA}.missing_table_xyz;`)).rejects.toThrow()
    expect(session.getTransactionState().aborted).toBe(true)
    await expect(session.commitTransaction()).rejects.toMatchObject({ code: 'TX_ABORTED_ROLLBACK' })

    // COMMIT AND CHAIN + SAVEPOINT recovery via SQL
    await session.runQuery(
      'pg-chain',
      `BEGIN; SAVEPOINT sp1; INSERT INTO ${PG_SCHEMA}.children (id, parent_id, title, qty) VALUES (12, 1, 'chain', 1); ROLLBACK TO SAVEPOINT sp1; COMMIT AND CHAIN; ROLLBACK;`
    )
    expect(session.getTransactionState().active).toBe(false)

    // setAutoCommit(false) auto-begin & rollbackTransaction + readOnly session check
    await session.setAutoCommit(false)
    await session.runQuery('pg-auto-begin', `INSERT INTO ${PG_SCHEMA}.children (id, parent_id, title, qty) VALUES (13, 1, 'rb', 2);`)
    expect(session.getTransactionState().active).toBe(true)
    await session.rollbackTransaction()
    expect((await session.setAutoCommit(true)).autoCommit).toBe(true)

    const roSess = trackPg((await pgDriver.createSession(pgProfile({ readOnly: true }), PG_PASS)) as PostgresSession)
    await expect(roSess.runQuery('ro-write', `INSERT INTO ${PG_SCHEMA}.children (id, parent_id, title, qty) VALUES (99, 1, 'ro', 1);`)).rejects.toThrow()
    await roSess.close()

    // Live query cancellation via pg_cancel_backend(pid) + idempotent unknown cancel
    expect(await session.cancelQuery('missing-pg-q')).toEqual({ ok: true })
    const slowPg = session.runQuery('pg-slow-cancel', 'SELECT pg_sleep(5);')
    const slowPgDone = slowPg.then(
      () => {
        throw new Error('Expected pg_sleep query to reject after cancelQuery')
      },
      (err: unknown) => err
    )
    await new Promise((r) => setTimeout(r, 80))
    const cancelRes = await session.cancelQuery('pg-slow-cancel')
    expect(cancelRes.ok).toBe(true)
    expect(await slowPgDone).toBeTruthy()

    // Close active query & pinned tx cleanup + closed-session guards
    await session.beginTransaction()
    const hungAtClose = session.runQuery('pg-hung-close', 'SELECT pg_sleep(5);')
    const hungDone = hungAtClose.then(
      () => {
        throw new Error('Expected pg_sleep query to reject on close()')
      },
      (err: unknown) => err
    )
    await new Promise((r) => setTimeout(r, 50))
    await session.close()
    expect(await hungDone).toBeTruthy()
    expect(session.isAlive()).toBe(false)
    expect((await session.test()).ok).toBe(false)
    await expect(session.listObjects()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.listSchemas()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.getObjectDdl('parents', 'table')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.exportSchemaDdl()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.getTableDetails('parents')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.fetchPage({ table: 'parents', page: 1, pageSize: 5 })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.updateCell({ table: 'parents', column: 'label', newValue: 'x', primaryKeys: { id: 1 }, originalValue: 'alpha' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.previewChanges({ table: 'parents' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.applyChanges({ table: 'parents' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.getDdl('parents')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.runQuery('q', 'SELECT 1')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.cancelQuery('q')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.beginTransaction()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.commitTransaction()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.rollbackTransaction()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })

    // Live edge-case session: auto-begin on fetchPage/updateCell/applyChanges, pinned CRUD/conflicts, commit success, idle close rollback, ssl options
    const s2 = trackPg((await pgDriver.createSession(pgProfile(), PG_PASS)) as PostgresSession)
    await s2.runQuery('s2-seed', `INSERT INTO ${PG_SCHEMA}.children (id, parent_id, title, qty) VALUES (201, 1, 't201', 1), (202, 1, 't202', 2), (203, 1, 't203', 3);`)
    expect((await s2.runQuery('s2-lit', 'SELECT 1 AS a, 2 AS b;')).sourceTable).toBeUndefined()

    await s2.setAutoCommit(false)
    await s2.fetchPage({ table: 'children', schema: PG_SCHEMA, page: 1, pageSize: 5 })
    await s2.rollbackTransaction()
    await s2.updateCell({ table: 'children', schema: PG_SCHEMA, column: 'title', newValue: 't201b', primaryKeys: { id: 201 }, originalValue: 't201' })
    await s2.commitTransaction()
    await s2.applyChanges({ table: 'children', schema: PG_SCHEMA, updates: [{ primaryKeys: { id: 201 }, changes: { qty: 5 }, originalRow: { id: 201, qty: 1 } }] })
    expect((await s2.commitTransaction()).active).toBe(false)
    await s2.setAutoCommit(true)

    // autoCommit happy delete & update conflict
    const autoDel = await s2.applyChanges({ table: 'children', schema: PG_SCHEMA, deletes: [{ id: 202 }] })
    expect(autoDel.deleted).toBe(1)
    await expect(s2.applyChanges({ table: 'children', schema: PG_SCHEMA, updates: [{ primaryKeys: { id: 99999 }, changes: { qty: 1 }, originalRow: { id: 99999, qty: 0 } }] })).rejects.toMatchObject({ code: 'conflict' })

    // Pinned tx happy insert+update+delete, delete conflict, update conflict, updateCell conflict/sql error, fetchPage sql error, COMMIT aborted sql
    await s2.beginTransaction()
    const pinMix = await s2.applyChanges({
      table: 'children',
      schema: PG_SCHEMA,
      inserts: [{ id: 204, parent_id: 1, title: 't204', qty: 4 }],
      updates: [{ primaryKeys: { id: 201 }, changes: { qty: 7 }, originalRow: { id: 201, qty: 5 } }],
      deletes: [{ id: 203 }],
    })
    expect(pinMix.deleted).toBe(1)
    await expect(s2.applyChanges({ table: 'children', schema: PG_SCHEMA, deletes: [{ id: 99999 }] })).rejects.toMatchObject({ code: 'conflict' })
    await expect(s2.applyChanges({ table: 'children', schema: PG_SCHEMA, updates: [{ primaryKeys: { id: 99999 }, changes: { qty: 1 }, originalRow: { id: 99999, qty: 0 } }] })).rejects.toMatchObject({ code: 'conflict' })
    await expect(s2.updateCell({ table: 'children', schema: PG_SCHEMA, column: 'title', newValue: 'x', primaryKeys: { id: 99999 }, originalValue: 'y' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(s2.fetchPage({ table: 'children', schema: PG_SCHEMA, page: 1, pageSize: 5, whereClause: '1/0 = 1' })).rejects.toThrow()
    await expect(s2.runQuery('s2-commit-aborted', 'COMMIT;')).rejects.toMatchObject({ code: 'TX_ABORTED_ROLLBACK' })
    expect(s2.getTransactionState().active).toBe(false)

    // Pinned updateCell SQL error sets txAborted
    await s2.beginTransaction()
    await expect(s2.updateCell({ table: 'children', schema: PG_SCHEMA, column: 'qty', newValue: 'bad_int', primaryKeys: { id: 201 }, originalValue: 7 })).rejects.toThrow()
    await s2.rollbackTransaction()

    // Idle pinned tx close() triggers ROLLBACK cleanly
    await s2.beginTransaction()
    await s2.close()

    // SSL flag & require options config coverage (closes immediately without dialing)
    const sslSess1 = await pgDriver.createSession(pgProfile({ ssl: true, sslMode: undefined }), PG_PASS)
    await sslSess1.close()
    const sslSess2 = await pgDriver.createSession(pgProfile({ sslMode: 'verify-full' }), PG_PASS)
    await sslSess2.close()

    // 2B) Isolated pool/client error-guard, closeWaiter, Supabase pooler fallback, and catalog permission edge cases
    try {
      class OffEmitterClient extends EventEmitter {
        processID = 0
        _txStatus: string | null = 'I'
        release = vi.fn()
        offOnly?: boolean
        async query(sqlOrCfg: string | { text?: string }, _params?: unknown[]): Promise<unknown> {
          const text = typeof sqlOrCfg === 'string' ? sqlOrCfg : sqlOrCfg?.text || ''
          if (text.includes('pg_class c JOIN pg_catalog')) {
            const err = Object.assign(new Error('permission denied for relation pg_class'), { code: '42501' })
            throw err
          }
          if (text.includes('pg_depend')) {
            throw Object.assign(new Error('permission denied'), { code: '42501' })
          }
          if (text.includes('current_database')) {
            return { rows: [{ db: '' }] }
          }
          if (text.includes('SELECT 1')) {
            this.emit('error', new Error('stream glitch'))
            return { rows: [{ ok: 1 }], fields: [] }
          }
          if (text.includes('COMMIT') || text.includes('ROLLBACK')) {
            throw new Error('socket gone during tx end')
          }
          return { rows: [], fields: [], rowCount: 0 }
        }
      }
      // Make a client with `off` only (no `removeListener`) to cover L169-170 & L402-403
      const offClient = new OffEmitterClient() as unknown as Record<string, unknown>
      offClient.removeListener = undefined

      let poolMode: 'offClient' | 'hangConnect' | 'supabaseDirectFail' | 'txBroken' = 'offClient'
      const fakePool = {
        connect: vi.fn(async () => {
          if (poolMode === 'hangConnect') {
            return await new Promise((resolve) => {
              setTimeout(() => resolve(new OffEmitterClient()), 30)
            })
          }
          return offClient
        }),
        query: vi.fn(async (sql: string) => {
          if (poolMode === 'supabaseDirectFail') {
            throw Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' })
          }
          if (sql.includes('pg_depend')) {
            throw Object.assign(new Error('permission denied'), { code: '42501' })
          }
          if (sql.includes('pg_namespace') || sql.includes('pg_class') || sql.includes('information_schema')) {
            return { rows: [] }
          }
          if (sql.includes('pg_cancel_backend')) {
            throw new Error('cancel fail no cfg')
          }
          return { rows: [], rowCount: 0 }
        }),
        end: vi.fn(async () => {}),
      }

      const mockSess = new PostgresSession(fakePool as unknown as Pool, pgProfile({ driver: 'postgres' }))
      // Test client 'error' guard + emitter.off during test() + cancelQuery without activeConfig
      expect((await mockSess.test()).ok).toBe(true)
      expect(await (mockSess as unknown as { sendCancelBackend(pid: number): Promise<boolean> }).sendCancelBackend(0)).toBe(false)
      expect(await (mockSess as unknown as { sendCancelBackend(pid: number): Promise<boolean> }).sendCancelBackend(42)).toBe(false)
      expect(await mockSess.exportSchemaDdl('public')).toMatchObject({ objectCount: 0 })

      // Pinned broken client via txClient 'error' event -> TX_CONNECTION_LOST / rollback error / discardBrokenPinnedClient
      poolMode = 'offClient'
      await mockSess.beginTransaction()
      ;(offClient as unknown as EventEmitter).emit('error', new Error('tx broken'))
      await expect(mockSess.commitTransaction()).rejects.toMatchObject({ code: 'TX_CONNECTION_LOST' })
      await mockSess.beginTransaction()
      ;(offClient as unknown as EventEmitter).emit('error', new Error('tx broken 2'))
      expect((await mockSess.setAutoCommit(true)).active).toBe(false)
      await mockSess.beginTransaction()
      await expect(mockSess.rollbackTransaction()).rejects.toThrow(/socket gone/)

      // connectLease pending during close() -> wakes waiter & releases late client
      poolMode = 'hangConnect'
      const lateTestPromise = mockSess.test()
      await mockSess.close()
      expect((await lateTestPromise).ok).toBe(false)

      // CockroachDB empty current_database error branch
      const badCrdbPool = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('current_database')) return { rows: [{ db: '' }] }
          return {
            rows: [{ oid: 1, name: 'v1', schema: 'public', kind: 'view', detail: null }],
          }
        }),
        end: vi.fn(async () => {}),
      }
      const crdbErrSess = new PostgresSession(badCrdbPool as unknown as Pool, pgProfile({ driver: 'cockroachdb' }))
      await expect(crdbErrSess.exportSchemaDdl('public')).rejects.toMatchObject({ code: 'CATALOG_ERROR' })
      await crdbErrSess.close()

      // Supabase resolveSupabasePoolerConfig & activateSupabasePoolerFallback
      vi.spyOn(Pool.prototype, 'query').mockResolvedValue({ rows: [], fields: [], rowCount: 0 } as never)
      vi.spyOn(Pool.prototype, 'end').mockResolvedValue(undefined as never)
      vi.spyOn(dns.promises, 'resolve6').mockResolvedValue(['2600:1f18:dead::1'])
      let shardCalls = 0
      vi.spyOn(Pool.prototype, 'connect').mockImplementation(async () => {
        shardCalls++
        if (shardCalls === 1) {
          throw Object.assign(new Error('Tenant or user not found'), { code: 'XX000' })
        }
        if (shardCalls === 2) {
          throw Object.assign(new Error('password authentication failed'), { code: '28P01' })
        }
        return new OffEmitterClient() as never
      })
      const resolved28 = await resolveSupabasePoolerConfig('db.myprojref.supabase.co', { host: 'db.myprojref.supabase.co', user: 'postgres' })
      expect(resolved28.host).toBe('aws-1-us-east-1.pooler.supabase.com')
      expect(resolved28.user).toBe('postgres.myprojref')

      shardCalls = 0
      vi.spyOn(Pool.prototype, 'connect').mockImplementation(async () => {
        throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
      })
      const fallbackAllFail = await resolveSupabasePoolerConfig('db.myprojref.supabase.co', { host: 'db.myprojref.supabase.co' })
      expect(fallbackAllFail.host).toBe('aws-0-us-east-1.pooler.supabase.com')

      vi.spyOn(Pool.prototype, 'connect').mockImplementation(async () => new OffEmitterClient() as never)
      const directPool = {
        query: vi.fn(async () => {
          throw Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' })
        }),
        end: vi.fn(async () => {}),
      }
      const supaSess = new PostgresSession(
        directPool as unknown as Pool,
        pgProfile({ host: 'db.myprojref.supabase.co' }),
        { host: 'db.myprojref.supabase.co', user: 'postgres' }
      )
      await supaSess.listSchemas()
      await supaSess.close()
    } finally {
      vi.restoreAllMocks()
    }
  }, 20000)

  it('covers Redis pure helpers/PBT, live auth/db selection/readOnly/SCAN/CRUD/pipeline, live BLPOP cancel, and fake RESP3 server edges', async () => {
    // 1) Pure helpers & PBT
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !/[\r\n"'\\]/.test(s) && s.trim().length > 0), (tok) => {
        const auth1 = redactRedisCommandArgs(['AUTH', tok])
        expect(auth1[1]).toBe('***')
        const auth2 = redactRedisCommandArgs(['AUTH', 'default', tok])
        expect(auth2[2]).toBe('***')
      })
    )
    expect(redactRedisCommandArgs(['HELLO', '3', 'AUTH', 'user', 'secret'])).toEqual(['HELLO', '3', 'AUTH', 'user', '***'])
    expect(redactRedisCommandArgs(['HELLO', '3', 'AUTH', 'secret'])).toEqual(['HELLO', '3', 'AUTH', '***'])
    expect(redactRedisCommandArgs(['ACL', 'SETUSER', 'alice', 'on', '>pw', '#hash', '<rm', '!ban'])).toEqual([
      'ACL',
      'SETUSER',
      'alice',
      'on',
      '>***',
      '#***',
      '<***',
      '!***',
    ])
    expect(redactRedisCommandArgs(['CONFIG', 'SET', 'requirepass', 'pw', 'maxmemory', '10mb'])).toEqual([
      'CONFIG',
      'SET',
      'requirepass',
      '***',
      'maxmemory',
      '10mb',
    ])
    expect(redactRedisCommandArgs(['MIGRATE', '127.0.0.1', '6379', 'k', '0', '100', 'AUTH', 'pw', 'AUTH2', 'u', 'p2', 'KEYS', 'k1'])).toEqual([
      'MIGRATE',
      '127.0.0.1',
      '6379',
      'k',
      '0',
      '100',
      'AUTH',
      '***',
      'AUTH2',
      'u',
      '***',
      'KEYS',
      'k1',
    ])
    expect(redactRedisCommandArgs(['GET', 'k'])).toEqual(['GET', 'k'])
    expect(redactRedisCommandArgs(['PING'])).toEqual(['PING'])
    expect(tokenizeRedisCommandScript('GET a\n# comment line\nSET "a b" "c \\"d\\""\n')).toHaveLength(2)

    expect(shouldUseRedisTls(false, true)).toBe(false)
    expect(shouldUseRedisTls({ rejectUnauthorized: false }, false)).toBe(true)
    expect(shouldUseRedisTls(undefined, true)).toBe(true)
    expect(shouldUseRedisTls(undefined, false)).toBe(false)

    // 2) Live Redis 7 auth, ACL username, db index selection, readOnly, schemas/objects/CRUD
    const redisDriver = new RedisDriver()
    const badRedis = await redisDriver.testConnection(redisProfile(), 'wrong_redis_pass')
    expect(badRedis.ok).toBe(false)
    expect(badRedis.message).not.toContain('wrong_redis_pass')

    const okRedis = await redisDriver.testConnection(redisProfile({ user: 'default', url: `redis://${REDIS_HOST}:${REDIS_PORT}` }), REDIS_PASS)
    expect(okRedis).toEqual({ ok: true, message: 'Redis connection valid' })

    const db1Sess = trackRedis((await redisDriver.createSession(redisProfile({ redisDb: 1 }), REDIS_PASS)) as RedisSession)
    expect(await db1Sess.listSchemas()).toEqual({ schemas: ['db1'], defaultSchema: 'db1' })
    await db1Sess.close()

    const session = trackRedis((await redisDriver.createSession(redisProfile({ database: '0' }), REDIS_PASS)) as RedisSession)
    expect(session.isAlive()).toBe(true)
    expect((await session.test()).ok).toBe(true)

    // Seed all Redis data structures + expiring key + root key
    await session.runQuery(
      'r-seed',
      [
        'SET datanoa_cov_test:str "hello world"',
        'SET datanoa_cov_test:exp "ttlval" EX 120',
        'HSET datanoa_cov_test:hash f1 v1 f2 v2',
        'RPUSH datanoa_cov_test:list l1 l2 l3',
        'SADD datanoa_cov_test:set s1 s2',
        'ZADD datanoa_cov_test:zset 1.5 z1 2.5 z2',
        'SET datanoa_cov_root_key "rootv"',
      ].join('\n')
    )

    const objects = await session.listObjects()
    expect(objects.some((o) => o.name === '(all)')).toBe(true)
    expect(objects.some((o) => o.name === '(root)')).toBe(true)
    expect(objects.some((o) => o.name === 'datanoa_cov_test:*')).toBe(true)

    expect(await session.getTableDetails('datanoa_cov_test:*')).toMatchObject({ primaryKey: ['key'] })
    expect(await session.getObjectDdl('datanoa_cov_test:*', 'table')).toContain('# Redis Keyspace')
    expect(await session.getObjectDdl('v1', 'view')).toContain('virtual key namespaces')
    expect((await session.exportSchemaDdl()).objectCount).toBe(0)

    // fetchPage filtering, globs, ordering, sorting
    const pAll = await session.fetchPage({ table: '(all)', page: 1, pageSize: 50, whereClause: "WHERE key LIKE 'datanoa_cov_%'", orderByClause: 'ORDER BY ttl DESC' })
    expect(pAll.totalRows).toBeGreaterThanOrEqual(7)
    const pRoot = await session.fetchPage({ table: '(root)', page: 1, pageSize: 20, whereClause: "key = 'datanoa_cov_root_key'" })
    expect(pRoot.rows.length).toBe(1)
    const pNs = await session.fetchPage({ table: 'datanoa_cov_test', page: 1, pageSize: 10, whereClause: 'datanoa_cov_test:str', sortColumn: 'type', sortDirection: 'ASC' })
    expect(pNs.rows.length).toBe(1)
    const pGlob = await session.fetchPage({ table: 'datanoa_cov_test:*', page: 1, pageSize: 10, whereClause: 'datanoa_cov_test:*', sortColumn: 'key', sortDirection: 'DESC' })
    expect(pGlob.totalRows).toBeGreaterThanOrEqual(6)

    // updateCell across string, hash, list/error, ttl EXPIRE/PERSIST
    const updStr = await session.updateCell({ table: 'datanoa_cov_test:*', column: 'value', newValue: 'updated_str', primaryKeys: { key: 'datanoa_cov_test:str' }, originalValue: 'hello world' })
    expect(updStr.updatedRecord?.value).toBe('updated_str')

    const updHash = await session.updateCell({ table: 'datanoa_cov_test:*', column: 'value', newValue: JSON.stringify({ f1: 'new1', f3: 'v3' }), primaryKeys: { key: 'datanoa_cov_test:hash' }, originalValue: '' })
    expect(updHash.updatedRecord?.value).toContain('f3')
    expect(updHash.updatedRecord?.value).not.toContain('f2')

    await expect(
      session.updateCell({ table: 'datanoa_cov_test:*', column: 'value', newValue: 'not-json', primaryKeys: { key: 'datanoa_cov_test:hash' }, originalValue: '' })
    ).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(
      session.updateCell({ table: 'datanoa_cov_test:*', column: 'value', newValue: 'bad', primaryKeys: { key: 'datanoa_cov_test:list' }, originalValue: '' })
    ).rejects.toMatchObject({ code: 'not_supported' })

    const updTtlSet = await session.updateCell({ table: 'datanoa_cov_test:*', column: 'ttl', newValue: 90, primaryKeys: { key: 'datanoa_cov_test:ttl_str' }, originalValue: -1 })
    expect(updTtlSet.ok).toBe(true)
    const updTtlPersist = await session.updateCell({ table: 'datanoa_cov_test:*', column: 'ttl', newValue: -1, primaryKeys: { key: 'datanoa_cov_test:exp' }, originalValue: 120 })
    expect(updTtlPersist.updatedRecord?.ttl).toBe(-1)

    // previewChanges & applyChanges (insert with/without TTL, update value+ttl, delete, hash preview)
    const rPreview = await session.previewChanges({
      table: 'datanoa_cov_test:*',
      inserts: [
        { key: 'datanoa_cov_test:batch_ins', value: 'v_ins', ttl: 60 },
        { key: 'datanoa_cov_test:batch_upd', value: 'v_upd0' },
        { key: 'datanoa_cov_test:batch_del', value: 'v_del' },
      ],
      updates: [
        { primaryKeys: { key: 'datanoa_cov_test:hash' }, changes: { value: { f1: 'p1' }, ttl: 45 }, originalRow: { key: 'datanoa_cov_test:hash', type: 'hash' } },
      ],
    })
    expect(rPreview.statements.length).toBeGreaterThanOrEqual(5)

    const rInsert = await session.applyChanges({
      table: 'datanoa_cov_test:*',
      inserts: [
        { key: 'datanoa_cov_test:batch_ins', value: 'v_ins', ttl: 60 },
        { key: 'datanoa_cov_test:batch_upd', value: 'v_upd0' },
        { key: 'datanoa_cov_test:batch_del', value: 'v_del' },
      ],
    })
    expect(rInsert.inserted).toBe(3)

    const rMutate = await session.applyChanges({
      table: 'datanoa_cov_test:*',
      updates: [{ primaryKeys: { key: 'datanoa_cov_test:batch_upd' }, changes: { value: 'v_upd1', ttl: 30 }, originalRow: { key: 'datanoa_cov_test:batch_upd', type: 'string' } }],
      deletes: [{ key: 'datanoa_cov_test:batch_del' }],
    })
    expect(rMutate.updated).toBe(1)
    expect(rMutate.deleted).toBe(1)

    // runQuery: empty error, SCAN, HGETALL, array LRANGE, multi-line redacted command batch, truncated maxRows, live BLPOP cancel
    await expect(session.runQuery('r-empty', '  # only comment\n')).rejects.toMatchObject({ code: 'invalid_params' })
    const qScan = await session.runQuery('r-scan', 'SCAN 0 MATCH datanoa_cov_test:* COUNT 100', 2)
    expect(qScan.columns.map((c) => c.name)).toEqual(['cursor', 'key'])
    const qScanEmpty = await session.runQuery('r-scan0', 'SCAN 0 MATCH datanoa_cov_nonexistent:* COUNT 50')
    expect(qScanEmpty.rowCount).toBe(0)
    const qHgetall = await session.runQuery('r-hgetall', 'HGETALL datanoa_cov_test:hash', 1)
    expect(qHgetall.columns.map((c) => c.name)).toEqual(['field', 'value'])
    const qArr = await session.runQuery('r-lrange', 'LRANGE datanoa_cov_test:list 0 -1', 2)
    expect(qArr.truncated).toBe(true)
    const qBatch = await session.runQuery('r-batch', `AUTH ${REDIS_PASS}\nGET datanoa_cov_test:str`)
    expect(String(qBatch.rows[0][0])).toContain('***')

    expect(await session.cancelQuery('missing-redis-q')).toEqual({ ok: true })
    const slowBlpop = session.runQuery('r-blpop', 'BLPOP datanoa_cov_test:never_exists 5')
    const slowBlpopErr = slowBlpop.then(
      () => {
        throw new Error('Expected BLPOP query to be cancelled')
      },
      (err: unknown) => err
    )
    await new Promise((r) => setTimeout(r, 40))
    expect(await session.cancelQuery('r-blpop')).toEqual({ ok: true })
    expect(await slowBlpopErr).toMatchObject({ code: 'cancelled' })

    // readOnly session + unsupported transactions
    const roRedis = trackRedis((await redisDriver.createSession(redisProfile({ readOnly: true }), REDIS_PASS)) as RedisSession)
    await expect(roRedis.runQuery('ro-allowed', 'INFO server\nCOMMAND INFO GET\nCONFIG GET maxmemory\nACL WHOAMI')).resolves.toMatchObject({ isSelect: true })
    await expect(roRedis.runQuery('ro-blocked', 'SET datanoa_cov_test:blocked 1')).rejects.toMatchObject({ code: 'READ_ONLY' })
    await expect(roRedis.applyChanges({ table: '(all)', inserts: [{ key: 'k', value: 'v' }] })).rejects.toMatchObject({ code: 'READ_ONLY' })
    await expect(roRedis.updateCell({ table: '(all)', column: 'value', newValue: 'v', primaryKeys: { key: 'k' }, originalValue: '' })).rejects.toMatchObject({ code: 'READ_ONLY' })
    await roRedis.close()

    expect(session.getTransactionState().supported).toBe(false)
    await expect(session.beginTransaction()).rejects.toThrow(/Redis/)
    await expect(session.commitTransaction()).rejects.toThrow(/Redis/)
    await expect(session.rollbackTransaction()).rejects.toThrow(/Redis/)
    expect((await session.setAutoCommit(true)).supported).toBe(false)
    await expect(session.setAutoCommit(false)).rejects.toThrow(/Redis/)

    await session.close()
    expect(session.isAlive()).toBe(false)
    expect((await session.test()).ok).toBe(false)

    // 3) Ephemeral loopback RESP3 / legacy Redis 5 fake socket server (handles pipelined commands cleanly)
    const activeSockets = new Set<net.Socket>()
    const parseRespRequests = (input: string): string[][] => {
      const lines = input.split('\r\n')
      const out: string[][] = []
      let idx = 0
      while (idx < lines.length) {
        const header = lines[idx++]
        if (!header || !header.startsWith('*')) continue
        const argc = Number(header.slice(1))
        const args: string[] = []
        for (let j = 0; j < argc && idx < lines.length; j++) {
          if (lines[idx]?.startsWith('$')) {
            idx++
            args.push(lines[idx++] ?? '')
          }
        }
        if (args.length > 0) out.push(args)
      }
      return out
    }

    const srv = net.createServer((sock) => {
      activeSockets.add(sock)
      sock.on('close', () => activeSockets.delete(sock))
      sock.on('data', (chunk) => {
        const cmds = parseRespRequests(chunk.toString('utf8'))
        for (const args of cmds) {
          const verb = (args[0] || '').toUpperCase()
          if (verb === 'AUTH' && args[1] === 'acluser') {
            sock.write("-ERR wrong number of arguments for 'auth' command\r\n")
          } else if (verb === 'AUTH') {
            sock.write('+OK\r\n')
          } else if (verb === 'PING') {
            sock.write('>1\r\n$6\r\nnotice\r\n|1\r\n+ttl\r\n:1\r\n+PONG\r\n')
          } else if (verb === 'RESP3ALL') {
            sock.write('*14\r\n_\r\n#t\r\n#f\r\n,inf\r\n,-inf\r\n,nan\r\n,3.5\r\n(999999999999999999999\r\n!3\r\nbad\r\n=7\r\ntxt:hi!\r\n~2\r\n+a\r\n+b\r\n%1\r\n+k\r\n:7\r\n$-1\r\n*-1\r\n')
          } else if (verb === 'SET' && args.some((a) => a.toUpperCase() === 'KEEPTTL')) {
            sock.write('-ERR syntax error\r\n')
          } else if (verb === 'PTTL') {
            sock.write(':45000\r\n')
          } else if (verb === 'TYPE') {
            sock.write('+string\r\n')
          } else if (verb === 'TTL') {
            sock.write(':45\r\n')
          } else if (verb === 'GET') {
            sock.write('$8\r\nlegacy_v\r\n')
          } else if (verb === 'BADFRAME') {
            sock.write('?invalid_prefix\r\n')
          } else {
            sock.write('+OK\r\n')
          }
        }
      })
    })
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()))
    try {
      const addr = srv.address() as net.AddressInfo
      const fakeSess = trackRedis(
        (await redisDriver.createSession(
          redisProfile({ host: '127.0.0.1', port: addr.port, user: 'acluser' }),
          'pass123'
        )) as RedisSession
      )
      const resp3Res = await fakeSess.runQuery('f-resp3', 'RESP3ALL')
      expect(resp3Res.rows.length).toBe(14)
      const legacyUpd = await fakeSess.updateCell({
        table: '(all)',
        column: 'value',
        newValue: 'legacy_v',
        primaryKeys: { key: 'k1' },
        originalValue: 'old',
      })
      expect(legacyUpd.ok).toBe(true)
      await expect(fakeSess.runQuery('f-bad', 'BADFRAME')).rejects.toThrow(/Unsupported RESP/)
      await fakeSess.close()
    } finally {
      for (const s of activeSockets) s.destroy()
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }

    // 4) Additional Redis live & fake RESP3 closure edges
    const rClosed = trackRedis((await redisDriver.createSession(redisProfile(), REDIS_PASS)) as RedisSession)
    await expect(rClosed.fetchPage({ table: '(all)', page: 1, pageSize: 5, orderByClause: 'ORDER BY key ASC' })).resolves.toBeTruthy()
    await expect(rClosed.updateCell({ table: '(all)', column: 'value', newValue: 'x', primaryKeys: { key: '' }, originalValue: '' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(rClosed.previewChanges({ table: '(all)', updates: [{ primaryKeys: { key: 'datanoa_cov_test:list' }, changes: { value: 'v' }, originalRow: { key: 'datanoa_cov_test:list', type: 'list' } }] })).rejects.toMatchObject({ code: 'not_supported' })
    await expect(rClosed.previewChanges({ table: '(all)', updates: [{ primaryKeys: { key: 'datanoa_cov_test:str' }, changes: { ttl: -1 }, originalRow: { key: 'datanoa_cov_test:str', type: 'string' } }] })).resolves.toMatchObject({ statements: ['PERSIST datanoa_cov_test:str'] })
    await expect(rClosed.applyChanges({ table: '(all)', updates: [{ primaryKeys: { key: 'datanoa_cov_test:str' }, changes: { ttl: -1 }, originalRow: { key: 'datanoa_cov_test:str', type: 'string' } }] })).resolves.toMatchObject({ updated: 1 })
    expect(await rClosed.getDdl('datanoa_cov_nonexistent:*')).toContain('(no keys matched)')

    const rBlpopAtClose = rClosed.runQuery('r-close-blpop', 'BLPOP datanoa_cov_test:never_exists 5').then(
      () => {
        throw new Error('Expected close() to reject active BLPOP')
      },
      (err: unknown) => err
    )
    await new Promise((r) => setTimeout(r, 30))
    await rClosed.close()
    expect(await rBlpopAtClose).toMatchObject({ code: 'SESSION_CLOSED' })

    // Closed-session errors across remaining methods
    await expect(rClosed.listObjects()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(rClosed.getObjectDdl('k', 'table')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(rClosed.getTableDetails('k')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(rClosed.fetchPage({ table: '(all)', page: 1, pageSize: 5 })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(rClosed.updateCell({ table: '(all)', column: 'value', newValue: 'x', primaryKeys: { key: 'k' }, originalValue: '' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(rClosed.previewChanges({ table: '(all)' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(rClosed.applyChanges({ table: '(all)' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(rClosed.getDdl('k')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(rClosed.runQuery('q', 'PING')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(rClosed.cancelQuery('q')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })

    // readOnly command matrix edge checks
    const roCheck = trackRedis((await redisDriver.createSession(redisProfile({ readOnly: true }), REDIS_PASS)) as RedisSession)
    await expect(roCheck.runQuery('ro-cmd', 'COMMAND\nCOMMAND COUNT')).resolves.toMatchObject({ isSelect: true })
    await expect(roCheck.runQuery('ro-cfgset', 'CONFIG SET maxmemory 100mb')).rejects.toMatchObject({ code: 'READ_ONLY' })
    await roCheck.close()

    // Ephemeral fake server for RESP3 top-level map, PTTL=-1 fallback, malformed frames, AUTH failure, chunked TCP, and DBSIZE err
    const edgeSockets = new Set<net.Socket>()
    let edgeTypeCount = 0
    const parseEdgeReqs = (input: string): string[][] => {
      const lines = input.split('\r\n')
      const out: string[][] = []
      let idx = 0
      while (idx < lines.length) {
        const header = lines[idx++]
        if (!header || !header.startsWith('*')) continue
        const argc = Number(header.slice(1))
        const args: string[] = []
        for (let j = 0; j < argc && idx < lines.length; j++) {
          if (lines[idx]?.startsWith('$')) {
            idx++
            args.push(lines[idx++] ?? '')
          }
        }
        if (args.length > 0) out.push(args)
      }
      return out
    }
    const srvEdge = net.createServer((sock) => {
      edgeSockets.add(sock)
      sock.on('close', () => edgeSockets.delete(sock))
      sock.on('data', (chunk) => {
        const cmds = parseEdgeReqs(chunk.toString('utf8'))
        for (const args of cmds) {
          const verb = (args[0] || '').toUpperCase()
          const full = args.join(' ')
          if (verb === 'AUTH' && args[1] === 'WRONGPASS_USER') {
            sock.write('-WRONGPASS invalid username-password pair\r\n')
          } else if (verb === 'AUTH') {
            sock.write('+OK\r\n')
          } else if (verb === 'PING') {
            sock.write('+PONG\r\n')
          } else if (verb === 'MAPTOP') {
            sock.write('%1\r\n+k')
            setTimeout(() => {
              if (!sock.destroyed) sock.write('\r\n$3\r\nval\r\n')
            }, 10)
          } else if (verb === 'BAD_INT') {
            sock.write('$abc\r\n')
          } else if (verb === 'BIG_INT') {
            sock.write('$99999999999999999999999\r\n')
          } else if (verb === 'NEG_BULK') {
            sock.write('$-2\r\n')
          } else if (verb === 'BAD_CRLF') {
            sock.write('$3\r\nabcXX')
          } else if (verb === 'NEG_ARR') {
            sock.write('*-2\r\n')
          } else if (verb === 'NEG_MAP') {
            sock.write('%-1\r\n')
          } else if (verb === 'NEG_ATTR') {
            sock.write('|-1\r\n')
          } else if (verb === 'DBSIZE') {
            sock.write('-ERR dbsize denied\r\n')
          } else if (verb === 'SET' && full.includes('KEEPTTL')) {
            sock.write('-ERR syntax error\r\n')
          } else if (verb === 'PTTL') {
            sock.write(':-1\r\n')
          } else if (verb === 'TYPE') {
            edgeTypeCount++
            if (args[1] === 'k_pttl' && edgeTypeCount === 1) {
              sock.write('+string\r\n')
            } else if (args[1] === 'k_get_err') {
              sock.write('+string\r\n')
            } else {
              sock.write('-ERR type failed\r\n')
            }
          } else if (verb === 'TTL') {
            sock.write(':-1\r\n')
          } else if (verb === 'SCAN') {
            sock.write('*2\r\n$1\r\n0\r\n*1\r\n$9\r\nk_get_err\r\n')
          } else if (verb === 'GET') {
            sock.write('-ERR get failed\r\n')
          } else {
            sock.write('+OK\r\n')
          }
        }
      })
    })
    await new Promise<void>((resolve) => srvEdge.listen(0, '127.0.0.1', () => resolve()))
    try {
      const addr2 = srvEdge.address() as net.AddressInfo
      await expect(
        redisDriver.createSession(redisProfile({ host: '127.0.0.1', port: addr2.port, user: 'WRONGPASS_USER' }), 'pw')
      ).rejects.toThrow()

      const edgeSess = trackRedis((await redisDriver.createSession(redisProfile({ host: '127.0.0.1', port: addr2.port }), 'pw')) as RedisSession)
      const mapRes = await edgeSess.runQuery('e-map', 'MAPTOP')
      expect(mapRes.rows).toEqual([['k', 'val']])
      expect((await edgeSess.exportSchemaDdl()).ddl).toContain('Keyspace size: 0 key(s)')
      // PTTL = -1 fallback in KEEPTTL + failed TYPE in hydrateKeyRows
      const pttlNegUpd = await edgeSess.updateCell({
        table: '(all)',
        column: 'value',
        newValue: 'no_px',
        primaryKeys: { key: 'k_pttl' },
        originalValue: 'old',
      })
      expect(pttlNegUpd.updatedRecord?.type).toBe('none')
      // Failed GET in hydrateKeyRows sets value: null
      const pageGetErr = await edgeSess.fetchPage({ table: '(all)', page: 1, pageSize: 5 })
      expect(pageGetErr.rows[0]?.value).toBeNull()
      await edgeSess.close()

      for (const badCmd of ['BAD_INT', 'BIG_INT', 'NEG_BULK', 'BAD_CRLF', 'NEG_ARR', 'NEG_MAP', 'NEG_ATTR']) {
        const sBad = await redisDriver.createSession(redisProfile({ host: '127.0.0.1', port: addr2.port }), 'pw')
        await expect(sBad.runQuery(`q_${badCmd}`, badCmd)).rejects.toThrow(/RESP/i)
        await sBad.close()
      }
    } finally {
      for (const s of edgeSockets) s.destroy()
      await new Promise<void>((resolve) => srvEdge.close(() => resolve()))
    }
  }, 20000)
})
