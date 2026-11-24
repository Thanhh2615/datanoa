import * as http from 'node:http'
import * as fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionProfile } from '../src/drivers/common/driver'
import {
  ClickHouseDriver,
  ClickHouseSession,
  normalizeClickHouseBaseUrl,
} from '../src/drivers/clickhouse/driver'
import { LibsqlDriver, LibsqlSession } from '../src/drivers/libsql/driver'

const CH_HOST = '127.0.0.1'
const CH_PORT = 58123
const CH_USER = 'datanoa'
const CH_PASS = 'datanoa_ch_pass'
const CH_DB = 'datanoa_test'

const LIBSQL_URL = 'http://127.0.0.1:58080'

function chProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'cov-ch',
    name: 'cov-ch',
    driver: 'clickhouse',
    host: CH_HOST,
    port: CH_PORT,
    database: CH_DB,
    user: CH_USER,
    sslMode: 'disable',
    ...overrides,
  }
}

function libsqlProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'cov-libsql',
    name: 'cov-libsql',
    driver: 'libsql',
    url: LIBSQL_URL,
    ssl: false,
    ...overrides,
  }
}

describe('Wave 2A-2a Live ClickHouse 24.8 & LibSQL Drivers', () => {
  const trackedCh: ClickHouseSession[] = []
  const trackedLs: LibsqlSession[] = []

  const trackCh = (s: ClickHouseSession) => {
    trackedCh.push(s)
    return s
  }
  const trackLs = (s: LibsqlSession) => {
    trackedLs.push(s)
    return s
  }

  async function cleanupCh() {
    const driver = new ClickHouseDriver()
    const s = (await driver.createSession(chProfile(), CH_PASS)) as ClickHouseSession
    try {
      await s.runQuery('ch-drop-mv', `DROP VIEW IF EXISTS ${CH_DB}.cov_ch_mv`)
      await s.runQuery('ch-drop-v', `DROP VIEW IF EXISTS ${CH_DB}.cov_ch_view`)
      await s.runQuery('ch-drop-dst', `DROP TABLE IF EXISTS ${CH_DB}.cov_ch_dst`)
      await s.runQuery('ch-drop-tbl', `DROP TABLE IF EXISTS ${CH_DB}.cov_ch_items`)
    } finally {
      await s.close().catch(() => {})
    }
  }

  async function cleanupLibsql() {
    const driver = new LibsqlDriver()
    const s = (await driver.createSession(libsqlProfile())) as LibsqlSession
    try {
      await s.runQuery('ls-drop-trg', 'DROP TRIGGER IF EXISTS trg_ls_fk')
      await s.runQuery('ls-drop-v', 'DROP VIEW IF EXISTS cov_ls_v')
      await s.runQuery('ls-drop-ch', 'DROP TABLE IF EXISTS cov_ls_children')
      await s.runQuery('ls-drop-par', 'DROP TABLE IF EXISTS cov_ls_parents')
      await s.runQuery('ls-drop-comp', 'DROP TABLE IF EXISTS cov_ls_comp')
    } finally {
      await s.close().catch(() => {})
    }
  }

  beforeAll(async () => {
    await cleanupCh()
    await cleanupLibsql()
  })

  afterAll(async () => {
    await cleanupCh().catch(() => {})
    await cleanupLibsql().catch(() => {})
    for (const s of trackedCh) await s.close().catch(() => {})
    for (const s of trackedLs) await s.close().catch(() => {})
  })

  it('covers normalizeClickHouseBaseUrl PBT + live ClickHouse 24.8 introspection, MergeTree CRUD, formats, cancelQuery, and HTTP error paths', async () => {
    // 1) Pure URL normalization & PBT
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{1,10}\.example\.com$/),
        fc.integer({ min: 1, max: 65535 }),
        (host, port) => {
          expect(normalizeClickHouseBaseUrl(chProfile({ host, port, url: undefined }), false)).toBe(
            `http://${host}:${port}`
          )
          expect(
            normalizeClickHouseBaseUrl(chProfile({ url: `http://u:secret@${host}:${port}/` }), {
              rejectUnauthorized: false,
            })
          ).toBe(`https://${host}:${port}`)
        }
      )
    )
    expect(normalizeClickHouseBaseUrl(chProfile({ url: 'clickhouses://u:p@ch.cloud:8443/' }), false)).toBe(
      'http://ch.cloud:8443'
    )
    expect(normalizeClickHouseBaseUrl(chProfile({ url: '', host: 'ch.cloud', port: undefined }), { rejectUnauthorized: false })).toBe(
      'https://ch.cloud:8443'
    )
    expect(normalizeClickHouseBaseUrl(chProfile({ url: 'clickhouse://ch.cloud:8123/' }), { rejectUnauthorized: false })).toBe(
      'https://ch.cloud:8123'
    )
    expect(normalizeClickHouseBaseUrl(chProfile({ url: 'https://ch.cloud:8443/' }), { rejectUnauthorized: false })).toBe(
      'https://ch.cloud:8443'
    )
    expect(normalizeClickHouseBaseUrl(chProfile({ url: 'clickhouses://ch.cloud/' }), undefined)).toBe(
      'https://ch.cloud'
    )
    expect(normalizeClickHouseBaseUrl(chProfile({ url: 'clickhouse://ch.cloud/' }), undefined)).toBe(
      'http://ch.cloud'
    )
    expect(normalizeClickHouseBaseUrl(chProfile({ url: undefined, host: 'ch.cloud', port: undefined, ssl: true }), undefined)).toBe(
      'https://ch.cloud:8443'
    )

    // 2) Live ClickHouse connection & auth error
    const chDriver = new ClickHouseDriver()
    expect((await chDriver.testConnection(chProfile(), 'wrong_ch_pass')).ok).toBe(false)
    expect(await chDriver.testConnection(chProfile(), CH_PASS)).toEqual({
      ok: true,
      message: 'ClickHouse connection valid',
    })

    const session = trackCh((await chDriver.createSession(chProfile(), CH_PASS)) as ClickHouseSession)
    expect(session.isAlive()).toBe(true)
    expect((await session.test()).ok).toBe(true)

    await session.runQuery(
      'ch-ddl',
      `
        CREATE TABLE ${CH_DB}.cov_ch_items (
          id UInt64,
          label String,
          score Float64,
          opt Nullable(String),
          tags Array(UInt8)
        ) ENGINE = MergeTree ORDER BY id;
        CREATE TABLE ${CH_DB}.cov_ch_dst (
          id UInt64,
          label String
        ) ENGINE = MergeTree ORDER BY id;
        CREATE VIEW ${CH_DB}.cov_ch_view AS SELECT id, label FROM ${CH_DB}.cov_ch_items;
        CREATE MATERIALIZED VIEW ${CH_DB}.cov_ch_mv TO ${CH_DB}.cov_ch_dst AS SELECT id, label FROM ${CH_DB}.cov_ch_items;
      `
    )

    const schemas = await session.listSchemas()
    expect(schemas.defaultSchema).toBe(CH_DB)
    expect(schemas.schemas).toContain(CH_DB)

    const objs = await session.listObjects()
    expect(objs.some((o) => o.name === 'cov_ch_items' && o.kind === 'table')).toBe(true)
    expect(objs.some((o) => o.name === 'cov_ch_view' && o.kind === 'view')).toBe(true)
    expect(objs.some((o) => o.name === 'cov_ch_mv' && o.kind === 'materialized_view')).toBe(true)

    const det1 = await session.getTableDetails('cov_ch_items')
    const det2 = await session.getTableDetails('cov_ch_items', CH_DB)
    expect(det2).toStrictEqual(det1)
    expect(det1.primaryKey).toEqual(['id'])
    expect(det1.columns.find((c) => c.name === 'opt')?.nullable).toBe(true)

    expect(await session.getDdl('cov_ch_items')).toContain('CREATE TABLE')
    expect(await session.getObjectDdl('cov_ch_view', 'view')).toContain('CREATE VIEW')
    const chExp = await session.exportSchemaDdl()
    expect(chExp.ddl).toContain('cov_ch_items')
    expect(chExp.objectCount).toBeGreaterThanOrEqual(3)

    // Validation & CRUD via previewChanges / applyChanges / fetchPage / updateCell
    await expect(session.previewChanges({ table: 'cov_ch_items', inserts: [{}] })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(
      session.previewChanges({ table: 'cov_ch_items', deletes: [{ id: 1 }], deleteRows: [] })
    ).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(
      session.previewChanges({ table: 'cov_ch_items', deletes: [{}] })
    ).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(
      session.previewChanges({ table: 'cov_ch_items', deletes: [{ id: 1 }], deleteRows: ['bad' as never] })
    ).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(
      session.previewChanges({ table: 'cov_ch_items', deletes: [{ id: 1 }], deleteRows: [{ id: 2 }] })
    ).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(
      session.previewChanges({ table: 'cov_ch_items', updates: [{ primaryKeys: {}, changes: { label: 'x' }, originalRow: {} }] })
    ).rejects.toMatchObject({ code: 'invalid_params' })

    const prevCh = await session.previewChanges({
      table: 'cov_ch_items',
      inserts: [
        { id: 1, label: 'alpha', score: 1.5, opt: null, tags: [1, 2] },
        { id: 2, label: 'beta', score: 2.5, opt: 'o2', tags: [3] },
        { id: 3, label: 'gamma', score: 3.5 },
      ],
      updates: [
        { primaryKeys: { id: 1 }, changes: { label: 'alpha2' }, originalRow: { id: 1, label: 'alpha' } },
        { primaryKeys: { id: 2 }, changes: {}, originalRow: { id: 2 } },
      ],
      deletes: [{ id: 3 }],
      deleteRows: [{ id: 3, label: 'gamma' }],
    })
    expect(prevCh.statements.length).toBeGreaterThanOrEqual(3)

    const insRes = await session.applyChanges({
      table: 'cov_ch_items',
      inserts: [
        { id: 1, label: 'alpha', score: 1.5, opt: null, tags: [1, 2] },
        { id: 2, label: 'beta', score: 2.5, opt: 'o2', tags: [3] },
        { id: 3, label: 'gamma', score: 3.5 },
      ],
    })
    expect(insRes.inserted).toBe(3)

    // fetchPage + updateCell + applyChanges update/delete + conflicts
    const page1 = await session.fetchPage({
      table: 'cov_ch_items',
      page: 1,
      pageSize: 2,
      sortColumn: 'id',
      sortDirection: 'ASC',
      whereClause: 'id >= 1',
      orderByClause: 'id DESC',
    })
    expect(page1.totalRows).toBe(3)

    const updCell = await session.updateCell({
      table: 'cov_ch_items',
      column: 'label',
      newValue: 'alpha_v2',
      primaryKeys: { id: 1 },
      originalValue: 'alpha',
    })
    expect(updCell.updatedRecord?.label).toBe('alpha_v2')

    await expect(
      session.updateCell({ table: 'cov_ch_items', column: 'label', newValue: 'x', primaryKeys: {}, originalValue: '' })
    ).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(
      session.updateCell({ table: 'cov_ch_items', column: 'label', newValue: 'x', primaryKeys: { id: 999 }, originalValue: 'nope' })
    ).rejects.toMatchObject({ code: 'conflict' })

    const mutApply = await session.applyChanges({
      table: 'cov_ch_items',
      updates: [{ primaryKeys: { id: 2 }, changes: { label: 'beta_v2' }, originalRow: { id: 2, label: 'beta' } }],
      deletes: [{ id: 3 }],
      deleteRows: [{ id: 3, label: 'gamma' }],
    })
    expect(mutApply).toMatchObject({ ok: true, updated: 1, deleted: 1 })

    await expect(
      session.applyChanges({ table: 'cov_ch_items', deletes: [{ id: 999 }] })
    ).rejects.toMatchObject({ code: 'conflict' })

    // runQuery variants: JSONCompact + maxRows, FORMAT TabSeparated, EXPLAIN, WITH CTE, multi-stmt, inline comment, cancelQuery
    await expect(session.runQuery('ch-empty', '   ')).rejects.toMatchObject({ code: 'invalid_params' })
    const qSel = await session.runQuery('ch-sel', `SELECT id, label FROM ${CH_DB}.cov_ch_items ORDER BY id -- tail comment\n`, 1)
    expect(qSel.truncated).toBe(true)
    const qTsv = await session.runQuery('ch-tsv', `SELECT id, label FROM ${CH_DB}.cov_ch_items ORDER BY id FORMAT TabSeparated`, 1)
    expect(qTsv.columns[0].name).toContain('TabSeparated')
    expect(qTsv.truncated).toBe(true)
    const qExp = await session.runQuery('ch-exp', `EXPLAIN SELECT id FROM ${CH_DB}.cov_ch_items`)
    expect(qExp.isSelect).toBe(true)
    const qWith = await session.runQuery('ch-with', `/* comment */ WITH t AS (SELECT 1 AS n) SELECT * FROM t`)
    expect(qWith.rows).toEqual([[1]])
    const qMulti = await session.runQuery(
      'ch-multi',
      `INSERT INTO ${CH_DB}.cov_ch_items (id, label, score, opt, tags) VALUES (4, 'delta', 4.0, 'o4', []); SELECT count() AS c FROM ${CH_DB}.cov_ch_items;`
    )
    expect(qMulti.resultSets?.length).toBe(2)

    expect(await session.cancelQuery('missing-ch-q')).toEqual({ ok: true })
    const slowCh = session.runQuery('ch-slow', 'SELECT sleepEachRow(1) FROM numbers(5)')
    const slowChDone = slowCh.then(
      (r) => r,
      (e: unknown) => e
    )
    await new Promise((r) => setTimeout(r, 80))
    expect((await session.cancelQuery('ch-slow')).ok).toBe(true)
    await slowChDone

    // readOnly mode & unsupported tx
    const roCh = trackCh((await chDriver.createSession(chProfile({ readOnly: true }), CH_PASS)) as ClickHouseSession)
    expect((await roCh.runQuery('ch-ro-sel', `SELECT count() FROM ${CH_DB}.cov_ch_items`)).isSelect).toBe(true)
    await expect(roCh.runQuery('ch-ro-mut', `INSERT INTO ${CH_DB}.cov_ch_items (id, label, score) VALUES (99, 'ro', 1)`)).rejects.toMatchObject({ code: 'READ_ONLY' })
    await expect(roCh.updateCell({ table: 'cov_ch_items', column: 'label', newValue: 'x', primaryKeys: { id: 1 }, originalValue: 'a' })).rejects.toMatchObject({ code: 'READ_ONLY' })
    await expect(roCh.applyChanges({ table: 'cov_ch_items', inserts: [{ id: 99, label: 'ro' }] })).rejects.toMatchObject({ code: 'READ_ONLY' })
    await roCh.close()

    expect(session.getTransactionState().supported).toBe(false)
    await expect(session.beginTransaction()).rejects.toThrow(/ClickHouse/)
    await expect(session.commitTransaction()).rejects.toThrow(/ClickHouse/)
    await expect(session.rollbackTransaction()).rejects.toThrow(/ClickHouse/)
    expect((await session.setAutoCommit(true)).supported).toBe(false)
    await expect(session.setAutoCommit(false)).rejects.toThrow(/ClickHouse/)

    await session.close()
    expect(session.isAlive()).toBe(false)
    expect((await session.test()).ok).toBe(false)
    await expect(session.listObjects()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.listSchemas()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.getObjectDdl('t', 'table')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.exportSchemaDdl()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.getTableDetails('t')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.fetchPage({ table: 't', page: 1, pageSize: 5 })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.updateCell({ table: 't', column: 'c', newValue: 'x', primaryKeys: { id: 1 }, originalValue: 'y' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.previewChanges({ table: 't' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.applyChanges({ table: 't' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.getDdl('t')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.runQuery('q', 'SELECT 1')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.cancelQuery('q')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })

    // 3) Local loopback ClickHouse edge HTTP server: readonly setting retry, empty SELECT, sorting_key fallback, SHOW CREATE fallback, malformed JSON, bad summary header, cancelQuery
    expect(normalizeClickHouseBaseUrl(chProfile({ url: 'invalid raw@url/' }), false)).toContain('invalid raw')
    const session2 = trackCh((await chDriver.createSession(chProfile(), CH_PASS)) as ClickHouseSession)
    expect((await session2.runQuery('ch-hash-c', "# hash comment\n-- dash comment\nSELECT 1")).rows).toEqual([[1]])
    await expect(session2.runQuery('ch-with-mut', 'WITH t AS (SELECT 1) INSERT INTO nonexistent_ch_tbl VALUES (1)')).rejects.toThrow()
    await session2.close()

    let chEdgeStep = 0
    let holdResp: (() => void) | null = null
    const chSrv = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => {
        body += String(c)
      })
      req.on('end', () => {
        if (req.url?.includes('output_format_json_quote_denormals') && chEdgeStep === 0) {
          chEdgeStep = 1
          res.statusCode = 500
          res.end("Code: 164. DB::Exception: Cannot modify 'output_format_json_quote_denormals' setting in readonly mode.")
          return
        }
        if (chEdgeStep === 1) {
          chEdgeStep = 2
          res.statusCode = 200
          res.setHeader('x-clickhouse-summary', '{not-json')
          res.end('{"meta":[{"name":"ok","type":"UInt8"}],"data":[[1]]}')
          return
        }
        if (body.includes('EMPTY_SELECT')) {
          res.statusCode = 200
          res.end('')
          return
        }
        if (body.includes('SHOW CREATE TABLE')) {
          res.statusCode = 500
          res.end('show create denied')
          return
        }
        if (body.includes('FROM system.tables')) {
          res.statusCode = 200
          res.end(
            JSON.stringify({
              meta: [{ name: 'engine', type: 'String' }, { name: 'primary_key', type: 'String' }, { name: 'sorting_key', type: 'String' }],
              data: [['MergeTree', '(missing_col)', 'sort_id']],
            })
          )
          return
        }
        if (body.includes('FROM system.columns')) {
          res.statusCode = 200
          res.end(
            JSON.stringify({
              meta: [
                { name: 'name', type: 'String' },
                { name: 'type', type: 'String' },
                { name: 'is_in_primary_key', type: 'UInt8' },
                { name: 'is_in_sorting_key', type: 'UInt8' },
                { name: 'default_kind', type: 'String' },
                { name: 'default_expression', type: 'String' },
              ],
              data: [['sort_id', 'UInt64', 0, 1, 'DEFAULT', '0']],
            })
          )
          return
        }
        if (body.includes('HOLD_FOR_CANCEL')) {
          holdResp = () => {
            res.statusCode = 200
            res.end('{"meta":[],"data":[]}')
          }
          return
        }
        if (body.includes('KILL QUERY')) {
          holdResp?.()
          holdResp = null
          res.statusCode = 500
          res.end('kill denied')
          return
        }
        res.statusCode = 200
        res.end('not valid json')
      })
    })
    await new Promise<void>((r) => chSrv.listen(0, '127.0.0.1', () => r()))
    try {
      const addr = chSrv.address() as { port: number }
      const roRetrySess = trackCh(new ClickHouseSession(chProfile({ url: `http://127.0.0.1:${addr.port}`, port: addr.port })))
      expect((await roRetrySess.runQuery('ro-retry', 'SELECT 1')).rows).toEqual([[1]])
      expect((await roRetrySess.runQuery('ch-empty-body', 'SELECT EMPTY_SELECT')).rows).toEqual([])
      expect(await roRetrySess.getDdl('fallback_tbl')).toContain('CREATE TABLE')

      const qAbort = roRetrySess.runQuery('ch-abort-q', 'SELECT HOLD_FOR_CANCEL')
      const qAbortErr = qAbort.then(
        () => null,
        (e: unknown) => e
      )
      await new Promise((r) => setTimeout(r, 30))
      await roRetrySess.cancelQuery('ch-abort-q')
      expect(await qAbortErr).toMatchObject({ code: 'cancelled' })

      await expect(roRetrySess.runQuery('bad-json', 'SELECT 2')).rejects.toMatchObject({ code: 'CLICKHOUSE_PARSE_ERROR' })
      await roRetrySess.close()

      // SSL https request failure path (covers sendHttpsRequest + CONNECTION_FAILED)
      const httpsSess = new ClickHouseSession(
        chProfile({ url: `https://127.0.0.1:${addr.port}`, port: addr.port }),
        CH_PASS,
        { rejectUnauthorized: false }
      )
      expect((await httpsSess.test()).ok).toBe(false)
      await httpsSess.close()
    } finally {
      holdResp?.()
      chSrv.closeAllConnections?.()
      await new Promise<void>((r) => chSrv.close(() => r()))
    }
  })

  it('covers live LibSQL Hrana v2, parameter/value PBT, security URL validation, FK trigger/DDL/batch, and local Hrana edge server', async () => {
    const lsDriver = new LibsqlDriver()
    expect((await lsDriver.testConnection(libsqlProfile({ url: '', host: '' }))).ok).toBe(false)
    expect(await lsDriver.testConnection(libsqlProfile())).toEqual({
      ok: true,
      message: 'LibSQL connection valid',
    })

    // Host/port resolution + TLS validation rules
    const tlsSessCheck = new LibsqlSession(libsqlProfile({ url: 'https://mydb-org.turso.io' }), 'tok')
    expect(tlsSessCheck.resolveTargetUrl(null)).toBe('https://mydb-org.turso.io/v2/pipeline')
    expect(tlsSessCheck.resolveTargetUrl('https://eu.mydb-org.turso.io/v2/pipeline')).toBe(
      'https://eu.mydb-org.turso.io/v2/pipeline'
    )
    expect(() => tlsSessCheck.resolveTargetUrl('http://mydb-org.turso.io')).toThrow(/downgrade/)
    expect(() => tlsSessCheck.resolveTargetUrl('ftp://mydb-org.turso.io')).toThrow(/scheme/)
    expect(() => tlsSessCheck.resolveTargetUrl('https://evil.example.com')).toThrow(/Untrusted/)
    expect(() => tlsSessCheck.resolveTargetUrl('https://mydb-org.turso.io?q=1')).toThrow(/query/)
    expect(() => tlsSessCheck.resolveTargetUrl('not-a-url')).toThrow(/Invalid LibSQL/)
    expect(() => tlsSessCheck.resolveTargetUrl('https://bad\nurl.turso.io')).toThrow(/control/)
    await tlsSessCheck.close()

    const session = trackLs((await lsDriver.createSession(libsqlProfile())) as LibsqlSession)
    expect(session.isAlive()).toBe(true)
    expect((await session.test()).ok).toBe(true)

    await session.runQuery(
      'ls-ddl',
      `
        CREATE TABLE cov_ls_parents (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          flag INTEGER,
          score REAL,
          raw BLOB,
          note TEXT
        );
        CREATE TABLE cov_ls_children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER REFERENCES cov_ls_parents(id) ON DELETE CASCADE,
          title TEXT
        );
        CREATE TABLE cov_ls_comp (
          k1 TEXT,
          k2 TEXT,
          val TEXT,
          PRIMARY KEY (k1, k2)
        );
        CREATE INDEX idx_ls_par_name ON cov_ls_parents(name);
        CREATE VIEW cov_ls_v AS SELECT id, name FROM cov_ls_parents;
        CREATE TRIGGER trg_ls_fk BEFORE INSERT ON cov_ls_children WHEN NEW.parent_id = -1 BEGIN
          SELECT RAISE(ABORT, '__datanoa_fk_violation__');
        END;
      `
    )

    // Schema & object introspection
    const schemas = await session.listSchemas()
    expect(schemas.defaultSchema).toBe('main')
    const objs = await session.listObjects()
    expect(objs.some((o) => o.name === 'cov_ls_parents' && o.kind === 'table')).toBe(true)
    expect(objs.some((o) => o.name === 'cov_ls_v' && o.kind === 'view')).toBe(true)

    const d1 = await session.getTableDetails('cov_ls_parents')
    const d2 = await session.getTableDetails('cov_ls_parents', 'main')
    expect(d2).toStrictEqual(d1)
    expect(await session.getDdl('cov_ls_parents')).toContain('CREATE TABLE')
    expect(await session.getObjectDdl('cov_ls_v', 'view')).toContain('CREATE VIEW')
    expect(await session.getObjectDdl('trg_ls_fk', 'trigger')).toContain('CREATE TRIGGER')
    const lsExp = await session.exportSchemaDdl()
    expect(lsExp.ddl).toContain('cov_ls_parents')

    // Trigger FK sentinel formatting
    await expect(
      session.runQuery('ls-fk-sent', 'INSERT INTO cov_ls_children (id, parent_id, title) VALUES (1, -1, "bad")')
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)

    // PBT parameter encoding/decoding roundtrip on real LibSQL server
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 24 }),
        fc.integer({ min: -100000, max: 100000 }),
        fc.boolean(),
        async (txt, num, flag) => {
          const ins = await session.applyChanges({
            table: 'cov_ls_parents',
            inserts: [{ id: 100000 + Math.abs(num) + 1, name: txt || 'p', flag, score: 1.25, raw: new Uint8Array([1, 2, 3]), note: null }],
          })
          expect(ins.inserted).toBe(1)
          const page = await session.fetchPage({
            table: 'cov_ls_parents',
            page: 1,
            pageSize: 5,
            whereClause: `id = ${100000 + Math.abs(num) + 1}`,
          })
          expect(page.rows[0].flag).toBe(flag ? 1 : 0)
          expect(page.rows[0].raw).toBeInstanceOf(Uint8Array)
          await session.applyChanges({
            table: 'cov_ls_parents',
            deletes: [{ id: 100000 + Math.abs(num) + 1 }],
          })
        }
      ),
      { numRuns: 5 }
    )

    // Seed clean rows for CRUD, updateCell, edited composite PK, applyChanges conflict rollback, runQuery batch/PRAGMA/WITH
    await session.applyChanges({
      table: 'cov_ls_parents',
      inserts: [
        { id: 1, name: 'p1', flag: 1, score: 9.5, note: 'n1' },
        { id: 2, name: 'p2', flag: 0, score: 8.5, note: 'n2' },
      ],
    })
    await session.applyChanges({
      table: 'cov_ls_comp',
      inserts: [{ k1: 'a', k2: 'b', val: 'v1' }],
    })

    const updComp = await session.updateCell({
      table: 'cov_ls_comp',
      column: 'k1',
      newValue: 'a2',
      primaryKeys: { k1: 'a', k2: 'b' },
      originalValue: 'a',
    })
    expect(updComp.updatedRecord?.k1).toBe('a2')

    await expect(
      session.updateCell({ table: 'cov_ls_parents', column: 'name', newValue: 'x', primaryKeys: { id: 9999 }, originalValue: 'y' })
    ).rejects.toMatchObject({ code: 'conflict' })

    expect(await session.applyChanges({ table: 'cov_ls_parents' })).toEqual({
      ok: true,
      inserted: 0,
      updated: 0,
      deleted: 0,
      statements: [],
    })
    expect((await session.previewChanges({ table: 'cov_ls_parents', deletes: [{ id: 2 }] })).statements.length).toBe(1)

    await expect(
      session.applyChanges({ table: 'cov_ls_parents', deletes: [{ id: 99999 }] })
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      session.applyChanges({ table: 'cov_ls_parents', updates: [{ primaryKeys: { id: 99999 }, changes: { name: 'z' }, originalRow: { id: 99999, name: 'n' } }] })
    ).rejects.toMatchObject({ code: 'conflict' })

    // PRAGMA, WITH, multi-statement transactional batch + failure guard rollback, truncation
    const qMulti = await session.runQuery(
      'ls-multi',
      "BEGIN; UPDATE cov_ls_parents SET name = 'p1_b' WHERE id = 1; SELECT id, name FROM cov_ls_parents ORDER BY id ASC; COMMIT;",
      1
    )
    expect(qMulti.truncated).toBe(true)
    expect(qMulti.resultSets?.length).toBeGreaterThanOrEqual(3)

    expect((await session.runQuery('ls-pragma', 'PRAGMA table_info(cov_ls_parents)')).isSelect).toBe(true)
    expect((await session.runQuery('ls-with', 'WITH c AS (SELECT 10 AS x) SELECT * FROM c')).rows).toEqual([[10]])
    await expect(
      session.runQuery('ls-mid-fail', 'BEGIN; INSERT INTO cov_ls_parents (id, name) VALUES (3, "p3"); INSERT INTO nope_tbl VALUES (1); COMMIT;')
    ).rejects.toThrow()
    // Row 3 must not remain committed after guarded batch failure
    expect((await session.runQuery('ls-verify-rb', 'SELECT COUNT(*) AS c FROM cov_ls_parents WHERE id = 3')).rows).toEqual([[0]])

    // readOnly & unsupported tx & cancelQuery
    const roLs = trackLs((await lsDriver.createSession(libsqlProfile({ readOnly: true }))) as LibsqlSession)
    await expect(roLs.runQuery('ls-ro-write', "INSERT INTO cov_ls_parents (id, name) VALUES (9, 'ro')")).rejects.toMatchObject({ code: 'READ_ONLY' })
    await expect(roLs.updateCell({ table: 'cov_ls_parents', column: 'name', newValue: 'x', primaryKeys: { id: 1 }, originalValue: 'p1' })).rejects.toMatchObject({ code: 'READ_ONLY' })
    await expect(roLs.applyChanges({ table: 'cov_ls_parents', inserts: [{ id: 9, name: 'ro' }] })).rejects.toMatchObject({ code: 'READ_ONLY' })
    await roLs.close()

    expect(await session.cancelQuery('missing-ls-q')).toEqual({ ok: true })
    expect(session.getTransactionState().supported).toBe(false)
    await expect(session.beginTransaction()).rejects.toThrow(/LibSQL/)
    await expect(session.commitTransaction()).rejects.toThrow(/LibSQL/)
    await expect(session.rollbackTransaction()).rejects.toThrow(/LibSQL/)
    expect((await session.setAutoCommit(true)).supported).toBe(false)
    await expect(session.setAutoCommit(false)).rejects.toThrow(/LibSQL/)

    await session.close()
    expect(session.isAlive()).toBe(false)
    expect((await session.test()).ok).toBe(false)
    await expect(session.listObjects()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.listSchemas()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.getObjectDdl('t', 'table')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.exportSchemaDdl()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.getTableDetails('t')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.fetchPage({ table: 't', page: 1, pageSize: 5 })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.updateCell({ table: 't', column: 'c', newValue: 'x', primaryKeys: { id: 1 }, originalValue: 'y' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.previewChanges({ table: 't' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.applyChanges({ table: 't' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.getDdl('t')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.runQuery('q', 'SELECT 1')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.cancelQuery('q')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })

    // Loopback Hrana v2 edge server: HTTP 500, invalid JSON, base_url + baton propagation, step_errors, begin/commit failures
    let lsEdgeMode = 'http500'
    let lsEdgeLastBody = ''
    let holdLsRes: (() => void) | null = null
    const lsSrv = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => {
        body += String(c)
      })
      req.on('end', () => {
        lsEdgeLastBody = body
        if (lsEdgeMode === 'http500') {
          res.statusCode = 500
          res.end('server error Bearer secret_tok')
          return
        }
        if (lsEdgeMode === 'badjson') {
          res.statusCode = 200
          res.end('{broken')
          return
        }
        if (lsEdgeMode === 'steperror') {
          res.statusCode = 200
          res.end(
            JSON.stringify({
              results: [
                {
                  type: 'ok',
                  response: {
                    type: 'batch',
                    result: {
                      step_results: [null, null],
                      step_errors: [null, { message: 'step 2 failed', code: 'SQL_ERR' }],
                    },
                  },
                },
                { type: 'ok' },
              ],
            })
          )
          return
        }
        if (lsEdgeMode === 'beginerr_baton') {
          res.statusCode = 200
          res.end(
            JSON.stringify({
              baton: 'baton_abc',
              base_url: `http://127.0.0.1:${(lsSrv.address() as { port: number }).port}/v2/pipeline`,
              results: [{ type: 'error', error: { message: 'begin with baton failed' } }],
            })
          )
          return
        }
        if (lsEdgeMode === 'missing_dml') {
          res.statusCode = 200
          res.end(JSON.stringify({ baton: 'b2', results: [{ type: 'ok' }] }))
          return
        }
        if (lsEdgeMode === 'empty_results') {
          res.statusCode = 200
          res.end(JSON.stringify({ results: [] }))
          return
        }
        if (lsEdgeMode === 'ddl_fallback') {
          res.statusCode = 200
          if (lsEdgeLastBody.includes('table_xinfo') || lsEdgeLastBody.includes('table_info')) {
            res.end(
              JSON.stringify({
                results: [
                  {
                    type: 'ok',
                    response: {
                      type: 'execute',
                      result: {
                        cols: [{ name: 'cid' }, { name: 'name' }, { name: 'type' }, { name: 'notnull' }, { name: 'dflt_value' }, { name: 'pk' }],
                        rows: [[{ type: 'integer', value: '0' }, { type: 'text', value: 'id' }, { type: 'text', value: 'INTEGER' }, { type: 'integer', value: '1' }, { type: 'null' }, { type: 'integer', value: '1' }]],
                      },
                    },
                  },
                  { type: 'ok' },
                ],
              })
            )
            return
          }
          res.end(
            JSON.stringify({
              results: [{ type: 'ok', response: { type: 'execute', result: { cols: [], rows: [] } } }, { type: 'ok' }],
            })
          )
          return
        }
        if (lsEdgeMode === 'hold') {
          holdLsRes = () => {
            res.statusCode = 200
            res.end(JSON.stringify({ results: [{ type: 'ok', response: { type: 'execute', result: { cols: [], rows: [] } } }, { type: 'ok' }] }))
          }
          return
        }
        res.statusCode = 200
        res.end(JSON.stringify({ results: [{ type: 'error', error: { message: 'begin rejected' } }] }))
      })
    })
    await new Promise<void>((r) => lsSrv.listen(0, '127.0.0.1', () => r()))
    try {
      const addr = lsSrv.address() as { port: number }
      expect(() => new LibsqlSession(libsqlProfile({ url: `http://127.0.0.1:${addr.port}` }), 'secret_tok')).toThrow(/plain HTTP/)

      // URL scheme & host/port normalization variants
      const sHostPort = new LibsqlSession(libsqlProfile({ url: undefined, host: '127.0.0.1', port: 80, ssl: false }))
      expect(sHostPort.pipelineUrl).toBe('http://127.0.0.1/v2/pipeline')
      await sHostPort.close()
      const sLibsqlScheme = new LibsqlSession(libsqlProfile({ url: `libsql://127.0.0.1:${addr.port}`, ssl: false }))
      expect(sLibsqlScheme.pipelineUrl).toBe(`http://127.0.0.1:${addr.port}/v2/pipeline`)
      await sLibsqlScheme.close()
      const sNoScheme = new LibsqlSession(libsqlProfile({ url: `127.0.0.1:${addr.port}/v2/pipeline`, ssl: false }))
      expect(sNoScheme.pipelineUrl).toBe(`http://127.0.0.1:${addr.port}/v2/pipeline`)
      await sNoScheme.close()
      expect(() => new LibsqlSession(libsqlProfile({ url: 'http://[::bad', ssl: false }))).toThrow(/not a valid absolute URL/)

      // Additional live LibSQL value encoding, PRAGMA non-select, empty query, happy applyChanges update
      const lsExtra = trackLs((await lsDriver.createSession(libsqlProfile())) as LibsqlSession)
      await expect(lsExtra.runQuery('ls-empty', '   ')).rejects.toMatchObject({ code: 'invalid_params' })
      expect((await lsExtra.runQuery('ls-pragma-w', 'PRAGMA foreign_keys = ON')).isSelect).toBe(false)
      expect((await lsExtra.runQuery('ls-bigint', 'SELECT 9007199254740993 AS b')).rows).toEqual([['9007199254740993']])
      await expect(
        lsExtra.applyChanges({
          table: 'cov_ls_parents',
          updates: [{ primaryKeys: { id: 1 }, changes: { name: 'p1_upd', score: NaN, note: new Date('invalid'), raw: new ArrayBuffer(2) }, originalRow: { id: 1 } }],
        })
      ).resolves.toMatchObject({ updated: 1 })
      await lsExtra.close()

      const eSess = trackLs(new LibsqlSession(libsqlProfile({ url: `http://127.0.0.1:${addr.port}`, port: addr.port })))
      expect((await eSess.test()).ok).toBe(false)
      lsEdgeMode = 'badjson'
      await expect(eSess.runQuery('e-json', 'SELECT 1')).rejects.toMatchObject({ code: 'LIBSQL_PARSE_ERROR' })
      lsEdgeMode = 'steperror'
      await expect(eSess.runQuery('e-step', 'SELECT 1; SELECT 2;')).rejects.toThrow('step 2 failed')
      lsEdgeMode = 'empty_results'
      await expect(eSess.runQuery('e-empty-res', 'SELECT 1')).rejects.toThrow('Missing Hrana pipeline result')
      await expect(eSess.runQuery('e-empty-batch', 'SELECT 1; SELECT 2;')).rejects.toThrow('Missing Hrana batch result')
      lsEdgeMode = 'beginerr_baton'
      await expect(eSess.applyChanges({ table: 't', inserts: [{ id: 1 }] })).rejects.toThrow('begin with baton failed')
      lsEdgeMode = 'missing_dml'
      await expect(eSess.applyChanges({ table: 't', inserts: [{ id: 1 }] })).rejects.toThrow('Missing Hrana pipeline DML result')
      lsEdgeMode = 'ddl_fallback'
      expect(await eSess.getDdl('fallback_t')).toContain('CREATE TABLE')

      lsEdgeMode = 'hold'
      const lsAbortP = eSess.runQuery('ls-abort', 'SELECT 1').then(
        () => null,
        (e: unknown) => e
      )
      await new Promise((r) => setTimeout(r, 25))
      await eSess.cancelQuery('ls-abort')
      expect(await lsAbortP).toMatchObject({ code: 'cancelled' })

      const lsCloseAbortP = eSess.runQuery('ls-close-q', 'SELECT 1').then(
        () => null,
        (e: unknown) => e
      )
      await new Promise((r) => setTimeout(r, 25))
      await eSess.close()
      expect(await lsCloseAbortP).toMatchObject({ code: 'cancelled' })
    } finally {
      holdLsRes?.()
      lsSrv.closeAllConnections?.()
      await new Promise<void>((r) => lsSrv.close(() => r()))
    }
  }, 15000)
})
