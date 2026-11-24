import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tls from 'node:tls'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile } from '../src/drivers/common/driver'
import {
  MysqlDriver,
  MysqlSession,
  type MysqlConnectionLike,
  type MysqlPoolLike,
} from '../src/drivers/mysql/driver'

const MYSQL_HOST = '127.0.0.1'
const MYSQL_PORT = 53306
const MARIA_PORT = 53307
const DB_NAME = 'datanoa_test'
const DB_USER = 'datanoa'
const MYSQL_PASS = 'datanoa_mysql_pass'
const MARIA_PASS = 'datanoa_maria_pass'

const TABLES_TO_CLEAN = [
  'cov_children',
  'cov_parents',
  'cov_comp',
  'cov_ddl_tmp',
]

function mysqlProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'cov-mysql',
    name: 'cov-mysql',
    driver: 'mysql',
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    database: DB_NAME,
    user: DB_USER,
    sslMode: 'disable',
    ...overrides,
  }
}

function mariaProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'cov-maria',
    name: 'cov-maria',
    driver: 'mariadb',
    host: MYSQL_HOST,
    port: MARIA_PORT,
    database: DB_NAME,
    user: DB_USER,
    sslMode: 'disable',
    ...overrides,
  }
}

describe('Wave 2A-2a Live MySQL 8.4 & MariaDB 11.4: src/drivers/mysql/driver.ts', () => {
  const tracked: MysqlSession[] = []
  const tmpPemDir = path.join(os.tmpdir(), 'ai-work', 'datanoa', 'coverage-100-full', 'tmp-mysql-pem')

  const track = (s: MysqlSession) => {
    tracked.push(s)
    return s
  }

  async function cleanupSchemaObjects(driver: MysqlDriver, profile: ConnectionProfile, pass: string): Promise<void> {
    const s = (await driver.createSession(profile, pass)) as MysqlSession
    try {
      await s.runQuery('drop-v', 'DROP VIEW IF EXISTS cov_v_parents;')
      await s.runQuery('drop-trg', 'DROP TRIGGER IF EXISTS cov_trg_child;')
      await s.runQuery('drop-fn', 'DROP FUNCTION IF EXISTS cov_fn_add;')
      for (const tbl of TABLES_TO_CLEAN) {
        await s.runQuery(`drop-${tbl}`, `DROP TABLE IF EXISTS ${tbl};`)
      }
    } finally {
      await s.close().catch(() => {})
    }
  }

  beforeAll(async () => {
    fs.rmSync(tmpPemDir, { recursive: true, force: true })
    fs.mkdirSync(tmpPemDir, { recursive: true })
    await cleanupSchemaObjects(new MysqlDriver('mysql'), mysqlProfile(), MYSQL_PASS)
    await cleanupSchemaObjects(new MysqlDriver('mariadb'), mariaProfile(), MARIA_PASS)
  })

  afterAll(async () => {
    await cleanupSchemaObjects(new MysqlDriver('mysql'), mysqlProfile(), MYSQL_PASS).catch(() => {})
    await cleanupSchemaObjects(new MysqlDriver('mariadb'), mariaProfile(), MARIA_PASS).catch(() => {})
    for (const s of tracked) {
      await s.close().catch(() => {})
    }
    fs.rmSync(tmpPemDir, { recursive: true, force: true })
  })

  it('exercises live MySQL 8.4 connection modes, TLS options, full DDL/BIT introspection, CRUD, pinned tx, and SLEEP cancelQuery', async () => {
    const driver = new MysqlDriver('mysql')
    expect((await driver.testConnection(mysqlProfile(), 'wrong_pass')).ok).toBe(false)
    expect(await driver.testConnection(mysqlProfile(), MYSQL_PASS)).toEqual({
      ok: true,
      message: 'MySQL connection valid',
    })

    // Live TLS connection to MySQL 8.4: explicit sslMode:'require' accepts self-signed cert, while default ssl:true fails closed
    const tlsReqSess = track(
      (await driver.createSession(mysqlProfile({ ssl: true, sslMode: 'require' }), MYSQL_PASS)) as MysqlSession
    )
    expect((await tlsReqSess.test()).ok).toBe(true)
    await tlsReqSess.close()

    const tlsDefaultSess = track(
      (await driver.createSession(mysqlProfile({ ssl: true, sslMode: undefined }), MYSQL_PASS)) as MysqlSession
    )
    expect((await tlsDefaultSess.test()).ok).toBe(false)
    await tlsDefaultSess.close()

    // Custom TLS PEM options + tunnel stream factory config paths (closed before connecting)
    const caFile = path.join(tmpPemDir, 'ca.pem')
    const certFile = path.join(tmpPemDir, 'cert.pem')
    const keyFile = path.join(tmpPemDir, 'key.pem')
    fs.writeFileSync(caFile, 'FAKECA', 'utf8')
    fs.writeFileSync(certFile, 'FAKECERT', 'utf8')
    fs.writeFileSync(keyFile, 'FAKEKEY', 'utf8')
    const pemSess = track(
      (await driver.createSession(
        mysqlProfile({
          sslCaPath: caFile,
          sslCertPath: certFile,
          sslKeyPath: keyFile,
          sslMode: 'verify-full',
        }),
        MYSQL_PASS,
        { sslKeyPassphrase: 'pw', tlsServername: 'mysql.remote.internal' }
      )) as MysqlSession
    )
    await pemSess.close()

    const session = track((await driver.createSession(mysqlProfile(), MYSQL_PASS)) as MysqlSession)
    expect(session.isAlive()).toBe(true)
    expect((await session.test()).ok).toBe(true)

    await session.runQuery(
      'm-ddl',
      `
        CREATE TABLE cov_parents (
          id INT AUTO_INCREMENT PRIMARY KEY,
          flag BIT(1) DEFAULT b'1',
          mask BIT(8) DEFAULT b'01010101',
          big BIGINT,
          price DECIMAL(10,2),
          meta JSON,
          raw VARBINARY(16),
          label VARCHAR(64) NOT NULL
        );
        CREATE TABLE cov_children (
          id INT PRIMARY KEY,
          parent_id INT NOT NULL,
          title VARCHAR(64),
          qty INT,
          CONSTRAINT fk_cov_par FOREIGN KEY (parent_id) REFERENCES cov_parents(id) ON DELETE CASCADE
        );
        CREATE TABLE cov_comp (
          k1 VARCHAR(20),
          k2 VARCHAR(20),
          val VARCHAR(40),
          PRIMARY KEY (k1, k2)
        );
        CREATE VIEW cov_v_parents AS SELECT id, label FROM cov_parents;
      `
    )

    // Schema & object introspection + cold/warm getTableDetails cache + DDL export
    const schemas = await session.listSchemas()
    expect(schemas.schemas).toContain(DB_NAME)
    expect(schemas.defaultSchema).toBe(DB_NAME)

    const objs = await session.listObjects()
    expect(objs.some((o) => o.name === 'cov_parents' && o.kind === 'table')).toBe(true)
    expect(objs.some((o) => o.name === 'cov_v_parents' && o.kind === 'view')).toBe(true)

    const pDetails1 = await session.getTableDetails('cov_parents')
    const pDetails2 = await session.getTableDetails('cov_parents', DB_NAME)
    expect(pDetails2).toStrictEqual(pDetails1)
    expect(pDetails1.primaryKey).toEqual(['id'])

    expect(await session.getDdl('cov_parents')).toContain('CREATE TABLE')
    expect(await session.getObjectDdl('cov_parents', 'table')).toContain('CREATE TABLE')
    expect(await session.getObjectDdl('cov_v_parents', 'view')).toContain('cov_v_parents')

    const exported = await session.exportSchemaDdl()
    expect(exported.ddl).toContain('cov_parents')
    expect(exported.objectCount).toBeGreaterThanOrEqual(2)

    // Seed rows covering BIT(1), BIT(8), BIGINT, JSON, VARBINARY
    await session.runQuery(
      'm-seed',
      `
        INSERT INTO cov_parents (id, flag, mask, big, price, meta, raw, label) VALUES
          (1, b'1', b'00001111', 9007199254740993, 12.34, '{"a":1}', X'DEADBEEF', 'alpha'),
          (2, b'0', b'11110000', 42, 56.78, '{}', NULL, 'beta');
        INSERT INTO cov_children (id, parent_id, title, qty) VALUES (10, 1, 'c1', 3), (11, 2, 'c2', 5);
        INSERT INTO cov_comp (k1, k2, val) VALUES ('old1', 'k2a', 'v1');
      `
    )

    // SELECT decoding BIT(1) & BIT(8) + maxRows truncation + multi-resultSets
    const bitRes = await session.runQuery('m-bit', 'SELECT id, flag, mask, big FROM cov_parents ORDER BY id ASC;', 1)
    expect(bitRes.truncated).toBe(true)
    expect(bitRes.rows[0][1]).toBe('1')
    expect(bitRes.rows[0][2]).toBe("b'00001111'")

    const multiRes = await session.runQuery(
      'm-multi',
      "UPDATE cov_children SET qty = 4 WHERE id = 10; SELECT id, qty FROM cov_children WHERE id = 10;"
    )
    expect(multiRes.resultSets?.length).toBe(2)

    // fetchPage + updateCell (autoCommit, edited composite PK, conflict) + previewChanges + applyChanges
    const page1 = await session.fetchPage({
      table: 'cov_parents',
      page: 1,
      pageSize: 2,
      sortColumn: 'id',
      sortDirection: 'DESC',
      whereClause: 'id >= 1',
      orderByClause: 'id ASC',
    })
    expect(page1.totalRows).toBe(2)
    expect(page1.rows[0].flag).toBe('1')

    const updComp = await session.updateCell({
      table: 'cov_comp',
      column: 'k1',
      newValue: 'new1',
      primaryKeys: { k1: 'old1', k2: 'k2a' },
      originalValue: 'old1',
    })
    expect(updComp.updatedRecord?.k1).toBe('new1')

    await expect(
      session.updateCell({
        table: 'cov_children',
        column: 'title',
        newValue: 'nope',
        primaryKeys: { id: 9999 },
        originalValue: 'none',
      })
    ).rejects.toMatchObject({ code: 'conflict' })

    expect(await session.applyChanges({ table: 'cov_children' })).toEqual({
      ok: true,
      inserted: 0,
      updated: 0,
      deleted: 0,
      statements: [],
    })

    const prevRes = await session.previewChanges({
      table: 'cov_children',
      inserts: [{ id: 12, parent_id: 1, title: 'c3', qty: 6 }],
    })
    expect(prevRes.statements.length).toBe(1)

    const autoApply = await session.applyChanges({
      table: 'cov_children',
      inserts: [{ id: 12, parent_id: 1, title: 'c3', qty: 6 }],
      updates: [{ primaryKeys: { id: 10 }, changes: { qty: 8 }, originalRow: { id: 10, qty: 4 } }],
      deletes: [{ id: 11 }],
    })
    expect(autoApply).toMatchObject({ ok: true, inserted: 1, updated: 1, deleted: 1 })

    await expect(session.applyChanges({ table: 'cov_children', deletes: [{ id: 99999 }] })).rejects.toMatchObject({ code: 'conflict' })
    await expect(session.applyChanges({ table: 'cov_children', updates: [{ primaryKeys: { id: 99999 }, changes: { qty: 1 }, originalRow: { id: 99999, qty: 0 } }] })).rejects.toMatchObject({ code: 'conflict' })

    // Pinned transactions, SAVEPOINT applyChanges, temporary vs regular DDL commit, setAutoCommit(false)
    await expect(session.commitTransaction()).rejects.toMatchObject({ code: 'NO_ACTIVE_TX' })
    await expect(session.rollbackTransaction()).rejects.toMatchObject({ code: 'NO_ACTIVE_TX' })

    expect((await session.beginTransaction()).active).toBe(true)
    await expect(session.beginTransaction()).rejects.toMatchObject({ code: 'TX_ALREADY_ACTIVE' })
    await expect(session.setAutoCommit(true)).rejects.toMatchObject({ code: 'TX_ACTIVE' })

    await session.fetchPage({ table: 'cov_children', page: 1, pageSize: 5 })
    await session.updateCell({
      table: 'cov_children',
      column: 'title',
      newValue: 'c1_pinned',
      primaryKeys: { id: 10 },
      originalValue: 'c1',
    })
    await expect(
      session.updateCell({
        table: 'cov_children',
        column: 'title',
        newValue: 'nope',
        primaryKeys: { id: 9999 },
        originalValue: 'x',
      })
    ).rejects.toMatchObject({ code: 'conflict' })

    const pinBatch = await session.applyChanges({
      table: 'cov_children',
      inserts: [{ id: 13, parent_id: 1, title: 'c4', qty: 9 }],
      updates: [{ primaryKeys: { id: 12 }, changes: { qty: 10 }, originalRow: { id: 12, qty: 6 } }],
      deletes: [{ id: 10 }],
    })
    expect(pinBatch).toMatchObject({ inserted: 1, updated: 1, deleted: 1 })
    await expect(session.applyChanges({ table: 'cov_children', deletes: [{ id: 99999 }] })).rejects.toMatchObject({ code: 'conflict' })
    await expect(session.applyChanges({ table: 'cov_children', updates: [{ primaryKeys: { id: 99999 }, changes: { qty: 1 }, originalRow: { id: 99999, qty: 0 } }] })).rejects.toMatchObject({ code: 'conflict' })

    expect((await session.commitTransaction()).active).toBe(false)

    // CREATE TEMPORARY TABLE keeps manual tx active; CREATE TABLE commits & txEndedInRun re-begins in !autoCommit
    await session.setAutoCommit(false)
    await session.fetchPage({ table: 'cov_children', page: 1, pageSize: 5 })
    await session.rollbackTransaction()
    await session.updateCell({ table: 'cov_children', column: 'title', newValue: 'c4b', primaryKeys: { id: 13 }, originalValue: 'c4' })
    await session.rollbackTransaction()
    await session.applyChanges({ table: 'cov_children', updates: [{ primaryKeys: { id: 13 }, changes: { qty: 11 }, originalRow: { id: 13, qty: 9 } }] })
    await session.commitTransaction()

    await session.runQuery(
      'm-implicit-ddl',
      'CREATE TEMPORARY TABLE cov_mem_tmp (id INT); CREATE TABLE cov_ddl_tmp (id INT); INSERT INTO cov_ddl_tmp VALUES (1); DROP TABLE cov_ddl_tmp;'
    )
    if (session.getTransactionState().active) {
      await session.rollbackTransaction()
    }
    expect((await session.setAutoCommit(true)).autoCommit).toBe(true)

    // COMMIT AND CHAIN + ROLLBACK SQL statements
    await session.runQuery('m-chain', "BEGIN; INSERT INTO cov_children VALUES (14, 1, 'chain', 1); COMMIT AND CHAIN; ROLLBACK;")

    // readOnly session check
    const roSess = track((await driver.createSession(mysqlProfile({ readOnly: true }), MYSQL_PASS)) as MysqlSession)
    expect((await roSess.test()).ok).toBe(true)
    await expect(roSess.runQuery('ro-write', "INSERT INTO cov_children VALUES (99, 1, 'ro', 1);")).rejects.toThrow()
    await roSess.close()

    // Live SLEEP cancelQuery (`KILL QUERY <threadId>`) + idempotent unknown cancel
    expect(await session.cancelQuery('missing-mysql-q')).toEqual({ ok: true })
    const slowMysql = session.runQuery('mysql-slow-q', 'SELECT SLEEP(5);')
    const slowMysqlErr = slowMysql.then(
      (r) => r,
      (e: unknown) => e
    )
    await new Promise((r) => setTimeout(r, 100))
    expect((await session.cancelQuery('mysql-slow-q')).ok).toBe(true)
    await slowMysqlErr

    // Close active query & idle pinned tx cleanup + closed guards
    await session.beginTransaction()
    await session.close()
    expect(session.isAlive()).toBe(false)
    expect((await session.test()).ok).toBe(false)
    await expect(session.listObjects()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.listSchemas()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.getObjectDdl('cov_parents', 'table')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.exportSchemaDdl()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.getTableDetails('cov_parents')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.fetchPage({ table: 'cov_parents', page: 1, pageSize: 5 })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.updateCell({ table: 'cov_parents', column: 'label', newValue: 'x', primaryKeys: { id: 1 }, originalValue: 'alpha' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.previewChanges({ table: 'cov_parents' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.applyChanges({ table: 'cov_parents' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.getDdl('cov_parents')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.runQuery('q', 'SELECT 1')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.cancelQuery('q')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.beginTransaction()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.commitTransaction()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.rollbackTransaction()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.setAutoCommit(true)).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  }, 20000)

  it('verifies live MariaDB 11.4 compatibility + mock MysqlPoolLike fatal errors, TLS verifyIpIdentity, BIT edge cases, and cancel/close races', async () => {
    const mariaDriver = new MysqlDriver('mariadb')
    expect(await mariaDriver.testConnection(mariaProfile(), MARIA_PASS)).toEqual({
      ok: true,
      message: 'MariaDB connection valid',
    })
    const mSess = track((await mariaDriver.createSession(mariaProfile(), MARIA_PASS)) as MysqlSession)
    await mSess.runQuery(
      'ma-init',
      'CREATE TABLE cov_parents (id INT PRIMARY KEY, label VARCHAR(40), flag BIT(1)); INSERT INTO cov_parents VALUES (1, "maria1", b\'1\');'
    )
    expect((await mSess.fetchPage({ table: 'cov_parents', page: 1, pageSize: 5 })).rows[0].label).toBe('maria1')
    await mSess.runQuery('ma-drop', 'DROP TABLE cov_parents;')
    await mSess.close()

    // Mock MysqlPoolLike edge paths: BIT zero-length buffer, object-rows, verifyIpIdentity mismatch/missing, fatal errno 2006, dirtyTxState, kill without options
    const makeConn = (overrides: Partial<MysqlConnectionLike> = {}): MysqlConnectionLike => ({
      threadId: 77,
      query: vi.fn(async () => [{ affectedRows: 1 }, []] as [unknown, unknown]),
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(),
      destroy: vi.fn(),
      ...overrides,
    })

    // 1) verifyIpIdentity: missing cert & mismatched cert & matching cert
    const missingCertPool: MysqlPoolLike = {
      getConnection: async () =>
        makeConn({
          stream: { getPeerCertificate: () => ({} as tls.PeerCertificate) },
        }),
      query: vi.fn(async () => [[], []]),
      end: vi.fn(async () => {}),
    }
    const sMiss = new MysqlSession(missingCertPool, mysqlProfile(), undefined, '127.0.0.1')
    expect((await sMiss.test()).message).toContain('did not present a peer certificate')
    await sMiss.close()

    const badIpPool: MysqlPoolLike = {
      getConnection: async () =>
        makeConn({
          connection: {
            stream: {
              getPeerCertificate: () =>
                ({
                  subject: { CN: 'wrong.host' },
                  subjectaltname: 'DNS:wrong.host',
                }) as unknown as tls.PeerCertificate,
            },
          },
        }),
      query: vi.fn(async () => [[], []]),
      end: vi.fn(async () => {}),
    }
    const sBadIp = new MysqlSession(badIpPool, mysqlProfile(), undefined, '127.0.0.1')
    expect((await sBadIp.test()).code === undefined && (await sBadIp.test()).ok).toBe(false)
    await sBadIp.close()

    const okIpConn = makeConn({
      stream: {
        getPeerCertificate: () =>
          ({
            subject: { CN: '127.0.0.1' },
            subjectaltname: 'IP Address:127.0.0.1',
          }) as unknown as tls.PeerCertificate,
      },
      query: vi.fn(async (sql) => {
        if (typeof sql === 'object' && sql.sql.includes('SELECT')) {
          return [
            [{ emptyBit: new Uint8Array(0), b1: new Uint8Array([1]), nullBit: null, raw: 'ok' }],
            [
              { name: 'emptyBit', columnType: 16, columnLength: 1 },
              { name: 'b1', columnType: 16, columnLength: 1 },
              { name: 'nullBit', columnType: 16, columnLength: 4 },
              { name: 'raw', columnType: 253 },
            ],
          ]
        }
        return [{ affectedRows: 0, serverStatus: 0x0001 }, []]
      }),
    })
    const okIpPool: MysqlPoolLike = {
      getConnection: async () => okIpConn,
      query: vi.fn(async () => [[], []]),
      end: vi.fn(async () => {}),
    }
    const sOkIp = new MysqlSession(okIpPool, mysqlProfile(), undefined, '127.0.0.1')
    const bitMock = await sOkIp.runQuery('mock-bit', 'SELECT 1')
    expect(bitMock.rows[0]).toEqual(['0', '1', null, 'ok'])
    // Calling again hits verifiedIdentityConns WeakSet cache & query without cancelConnOptions
    await sOkIp.cancelQuery('none')
    await (sOkIp as unknown as { sendKillQuery(id: number): Promise<boolean> }).sendKillQuery(0)
    await (sOkIp as unknown as { sendKillQuery(id: number): Promise<boolean> }).sendKillQuery(77)
    await sOkIp.close()

    // 2) Fatal error inside pinned tx clears txConn and destroys connection; readOnly failure releases conn
    const fatalConn = makeConn({
      query: vi.fn(async (sql) => {
        if (typeof sql === 'string' && sql.includes('READ ONLY')) {
          throw new Error('readOnly unsupported')
        }
        if (typeof sql === 'object') {
          throw Object.assign(new Error('gone'), { errno: 2006 })
        }
        return [{ affectedRows: 0 }, []]
      }),
    })
    const fatalPool: MysqlPoolLike = {
      getConnection: async () => fatalConn,
      query: vi.fn(async () => {
        throw new Error('kill failed')
      }),
      end: vi.fn(async () => {}),
    }
    const sFatal = new MysqlSession(fatalPool, mysqlProfile())
    await sFatal.beginTransaction()
    await expect(sFatal.runQuery('q-fatal', 'SELECT 1')).rejects.toThrow('gone')
    expect(sFatal.getTransactionState().active).toBe(false)
    expect(await (sFatal as unknown as { sendKillQuery(id: number): Promise<boolean> }).sendKillQuery(77)).toBe(false)
    await sFatal.close()

    const roFailSess = new MysqlSession(fatalPool, mysqlProfile({ readOnly: true }))
    expect((await roFailSess.test()).ok).toBe(false)
    await roFailSess.close()

    // 3) close() with active query running on mock pool destroys conn
    const hangConn = makeConn({
      query: vi.fn(() => new Promise(() => {})),
    })
    const hangPool: MysqlPoolLike = {
      getConnection: async () => hangConn,
      query: vi.fn(async () => [[], []]),
      end: vi.fn(async () => {}),
    }
    const sHang = new MysqlSession(hangPool, mysqlProfile())
    const qHang = sHang.runQuery('q-hang', 'SELECT SLEEP(5)').then(
      () => null,
      (e: unknown) => e
    )
    await new Promise((r) => setTimeout(r, 20))
    await sHang.close()
    await Promise.race([qHang, new Promise((r) => setTimeout(r, 20))])

    // 4) Additional MysqlSession branches: serverStatus-less CREATE TEMPORARY TABLE vs CREATE TABLE implicit commit,
    // SHOW CREATE VIEW + empty SHOW CREATE fallback to reconstructTableDdl, unknown column type, fatal PROTOCOL_CONNECTION_LOST
    const impConn = makeConn({
      query: vi.fn(async (sql) => {
        const text = typeof sql === 'string' ? sql : sql.sql
        if (text.includes('SHOW CREATE TABLE')) return [[{ 'Create View': 'CREATE VIEW v_m AS SELECT 1' }], []]
        if (text.includes('SHOW CREATE')) return [[{}], []]
        if (text.includes('SELECT') && typeof sql === 'object') {
          return [[[1]], [{ name: 'x', columnType: 99999 }]]
        }
        return [{ affectedRows: 0 }, []]
      }),
    })
    const impPool: MysqlPoolLike = {
      getConnection: async () => impConn,
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SHOW CREATE TABLE') && sql.includes('v_m')) return [[{ 'Create View': 'CREATE VIEW v_m AS SELECT 1' }], []]
        if (sql.includes('SHOW CREATE TABLE')) return [[{}], []]
        if (sql.includes('information_schema.COLUMNS')) return [[{ COLUMN_NAME: 'id', DATA_TYPE: 'int', COLUMN_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, COLUMN_KEY: 'PRI', EXTRA: '' }], []]
        if (sql.includes('information_schema')) return [[], []]
        return [{ affectedRows: 0 }, []]
      }),
      end: vi.fn(async () => {}),
    }
    const sImp = new MysqlSession(impPool, mysqlProfile())
    await sImp.beginTransaction()
    await sImp.runQuery('m-tmp-vs-ddl', 'CREATE TEMPORARY TABLE t_tmp (a INT); CREATE TABLE t_perm (a INT); SELECT 1;')
    expect(sImp.getTransactionState().active).toBe(false)
    expect(await sImp.getDdl('v_m')).toContain('CREATE VIEW v_m')
    expect(await sImp.getDdl('tbl_fallback')).toContain('CREATE TABLE')
    await sImp.close()

    // Queued txOp entering runExclusiveTxOp right as close() sets isClosed -> SESSION_CLOSED inside callback
    const sCloseRace = new MysqlSession(impPool, mysqlProfile())
    await sCloseRace.beginTransaction()
    const raceFetch = sCloseRace.fetchPage({ table: 't', page: 1, pageSize: 5 }).catch((e) => e)
    const raceUpd = sCloseRace.updateCell({ table: 't', column: 'c', newValue: 1, primaryKeys: { id: 1 }, originalValue: 0 }).catch((e) => e)
    const raceBatch = sCloseRace.applyChanges({ table: 't', inserts: [{ id: 1 }] }).catch((e) => e)
    const raceRun = sCloseRace.runQuery('r-race', 'BEGIN; SELECT 1;').catch((e) => e)
    await sCloseRace.close()
    await Promise.all([raceFetch, raceUpd, raceBatch, raceRun])
  })
})
