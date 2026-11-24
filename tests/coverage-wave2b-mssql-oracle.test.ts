import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ConnectionPool } from '../vendor/mssql.js'
import oracledb from '../vendor/oracledb.js'
import type { ConnectionProfile } from '../src/protocol'
import {
  buildMssqlPoolConfig,
  isMssqlReadOnlyBlocked,
  MssqlDriver,
  MssqlSession,
  splitMssqlBatches,
  type MssqlPoolLike,
  type MssqlRequestLike,
  type MssqlTransactionLike,
} from '../src/drivers/mssql/driver'
import {
  buildOracleConnectionConfig,
  OracleDriver,
  OracleSession,
  splitOracleStatements,
  type OracleConnectionLike,
} from '../src/drivers/oracle/driver'

async function getClosedLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo
      const port = addr.port
      srv.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

function makeMssqlProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'cov_mssql',
    name: 'MSSQL Cov',
    type: 'mssql',
    host: 'localhost',
    port: 1433,
    user: 'sa',
    database: 'appdb',
    ...overrides,
  }
}

function makeOracleProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'cov_oracle',
    name: 'Oracle Cov',
    type: 'oracle',
    host: 'localhost',
    port: 1521,
    user: 'hr',
    database: 'FREEPDB1',
    ...overrides,
  }
}

describe('Wave 2B Step 2: MSSQL & Oracle Coverage + PBT + Bundled Driver Edge Cases', () => {
  let certTmpDir = ''
  let caPath = ''
  let certPath = ''
  let keyPath = ''

  beforeAll(async () => {
    certTmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'datanoa-wave2b-certs-'))
    caPath = path.join(certTmpDir, 'ca.pem')
    certPath = path.join(certTmpDir, 'client.crt')
    keyPath = path.join(certTmpDir, 'client.key')
    await fs.promises.writeFile(caPath, '-----BEGIN CERTIFICATE-----\nDUMMY-CA\n-----END CERTIFICATE-----\n', 'utf8')
    await fs.promises.writeFile(certPath, '-----BEGIN CERTIFICATE-----\nDUMMY-CERT\n-----END CERTIFICATE-----\n', 'utf8')
    await fs.promises.writeFile(keyPath, '-----BEGIN PRIVATE KEY-----\nDUMMY-KEY\n-----END PRIVATE KEY-----\n', 'utf8')
  })

  afterAll(async () => {
    if (certTmpDir) {
      await fs.promises.rm(certTmpDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('Block 1: fast-check PBT and parser edge cases (isMssqlReadOnlyBlocked, splitMssqlBatches, splitOracleStatements)', () => {
    // MSSQL read-only guard edge cases
    expect(isMssqlReadOnlyBlocked('SELECT 1; -- note\nSET SHOWPLAN_ALL ON;')).toBe(false)
    expect(isMssqlReadOnlyBlocked('WITH cte AS (SELECT 1 AS x) SELECT * INTO #tmp FROM cte;')).toBe(true)
    expect(isMssqlReadOnlyBlocked('   -- comment only\n   ')).toBe(false)

    // Nested block comments, escaped quotes/brackets, and GO [count]
    const nested = splitMssqlBatches(`
      /* outer /* inner GO */ still comment '' "" [] */
      SELECT 'a''b GO', "c""d GO", [col]]GO] FROM tbl; -- trailing comment
      GO 3
      /* second */
      SELECT 2;
    `)
    expect(nested).toHaveLength(4)
    expect(nested[3]).toContain('SELECT 2')

    const literalArbitrary = fc.stringMatching(/^[A-Za-z0-9 _-]{0,16}$/)
    fc.assert(
      fc.property(fc.array(literalArbitrary, { minLength: 1, maxLength: 4 }), (tokens) => {
        const script = tokens
          .map((t) => `SELECT '${t}' AS v, "${t}" AS q, [${t}] AS b;`)
          .join('\nGO\n')
        const batches = splitMssqlBatches(script)
        expect(batches.length).toBe(tokens.length)
      }),
      { numRuns: 30 }
    )

    // Oracle q'...' delimiters (all pair forms + arbitrary char + unclosed) & escaped quotes/comments
    const oraScript = [
      "SELECT q'(a;b)' FROM DUAL;",
      "SELECT q'[a;b]' FROM DUAL;",
      "SELECT q'{a;b}' FROM DUAL;",
      "SELECT q'<a;b>' FROM DUAL;",
      "SELECT q'|a;b|', 'it''s', \"bad\"\"id\" /* c;d */ -- e;f\nFROM DUAL;",
      'DECLARE v NUMBER; BEGIN v := 1; END;',
      '/',
      "SELECT q'|unclosed;tail",
    ].join('\n')
    const chunks = splitOracleStatements(oraScript)
    expect(chunks.length).toBe(7)
    expect(chunks[5].isPlSql).toBe(true)
    expect(chunks[6].text).toContain('unclosed;tail')

    fc.assert(
      fc.property(
        fc.constantFrom(['(', ')'], ['[', ']'], ['{', '}'], ['<', '>'], ['|', '|']),
        literalArbitrary,
        ([open, close], payload) => {
          const safe = payload.replace(/[\r\n]/g, ' ')
          const sql = `SELECT q'${open}${safe};inside${close}' FROM DUAL; SELECT 1 FROM DUAL;`
          const res = splitOracleStatements(sql)
          expect(res.length).toBe(2)
          expect(res[0].text).toContain(';inside')
        }
      ),
      { numRuns: 30 }
    )
  })

  it('Block 2: buildMssqlPoolConfig, buildOracleConnectionConfig, TLS overrides, real dead-port Driver tests & createSession hooks', async () => {
    // buildMssqlPoolConfig edge branches: invalid URL fallback, ADO named instance, disable TLS, verify-full w/ PEMs
    const badUrlCfg = await buildMssqlPoolConfig(makeMssqlProfile({ host: '', url: 'mssql://[invalid-host' }), 'pw')
    expect(badUrlCfg.server).toBe('localhost')

    const adoCfg = await buildMssqlPoolConfig(
      makeMssqlProfile({
        host: '',
        port: undefined,
        user: '',
        database: '',
        url: 'Server=sql.corp;Database=salesdb;User Id=svc;Password=ado_pw;',
        sslMode: 'disable',
      })
    )
    expect(adoCfg.server).toBe('sql.corp')
    expect(adoCfg.options?.encrypt).toBe(false)

    const namedInstCfg = await buildMssqlPoolConfig(
      makeMssqlProfile({
        host: 'sql.corp\\INST1',
        port: undefined,
        database: 'salesdb',
        sslMode: 'disable',
      }),
      'pw'
    )
    expect(namedInstCfg.server).toBe('sql.corp')
    expect(namedInstCfg.options?.instanceName).toBe('INST1')
    expect(namedInstCfg.port).toBeUndefined()

    const tlsMssqlCfg = await buildMssqlPoolConfig(
      makeMssqlProfile({
        sslMode: 'verify-full',
        sslCaPath: caPath,
        sslCertPath: certPath,
        sslKeyPath: keyPath,
      }),
      'pw',
      { tlsServername: 'sql.internal', sslKeyPassphrase: 'kp' }
    )
    expect(tlsMssqlCfg.options?.encrypt).toBe(true)
    expect(tlsMssqlCfg.options?.trustServerCertificate).toBe(false)
    expect(tlsMssqlCfg.options?.cryptoCredentialsDetails?.ca).toContain('DUMMY-CA')
    expect(tlsMssqlCfg.options?.cryptoCredentialsDetails?.servername).toBe('sql.internal')
    expect(typeof tlsMssqlCfg.options?.cryptoCredentialsDetails?.checkServerIdentity).toBe('function')

    // buildOracleConnectionConfig edge branches
    const badOraCfg = await buildOracleConnectionConfig(makeOracleProfile({ url: 'oracle://[invalid' }), 'pw')
    expect(badOraCfg.attrs.connectString).toBe('oracle://[invalid')

    const plainOraCfg = await buildOracleConnectionConfig(makeOracleProfile({ url: 'ora.internal:1521/ORCL' }), 'pw')
    expect(plainOraCfg.attrs.connectString).toBe('ora.internal:1521/ORCL')

    const tnsHostCfg = await buildOracleConnectionConfig(
      makeOracleProfile({ host: '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521)))', database: '' }),
      'pw'
    )
    expect(tnsHostCfg.attrs.connectString).toContain('DESCRIPTION=')

    const slashHostCfg = await buildOracleConnectionConfig(
      makeOracleProfile({ host: 'ora.example.com/SVC1', database: '', ssl: true }),
      'pw'
    )
    expect(slashHostCfg.attrs.connectString).toBe('tcps://ora.example.com/SVC1')

    const sidCfg = await buildOracleConnectionConfig(
      makeOracleProfile({
        host: 'ora-sid.local',
        port: 2484,
        database: 'HR',
        url: 'tcps://u:p@ora-sid.local:2484?sid=XE',
        sslMode: 'verify-full',
        sslCaPath: caPath,
        sslCertPath: certPath,
        sslKeyPath: keyPath,
      }),
      undefined,
      { tlsServername: 'ora-sid.local', sslKeyPassphrase: 'opw' }
    )
    expect(sidCfg.attrs.connectString).toContain('SID=XE')
    expect(sidCfg.attrs.walletContent).toContain('DUMMY-CA')
    expect(sidCfg.attrs.walletContent).toContain('DUMMY-CERT')
    expect(sidCfg.attrs.walletContent).toContain('DUMMY-KEY')
    expect(sidCfg.attrs.walletPassword).toBe('opw')
    expect(sidCfg.attrs.sslServerCertDN).toBeUndefined()
    expect(sidCfg.attrs.sslServerDNMatch).toBe(true)

    // Real bundled driver dead-port tests (127.0.0.1 closed ephemeral port -> fast ECONNREFUSED)
    const closedPort = await getClosedLoopbackPort()
    const msDriver = new MssqlDriver()
    const msDead = await msDriver.testConnection(
      makeMssqlProfile({ host: '127.0.0.1', port: closedPort }),
      'badpw'
    )
    expect(msDead.ok).toBe(false)

    const oraDriver = new OracleDriver()
    const oraDead = await oraDriver.testConnection(
      makeOracleProfile({ host: '127.0.0.1', port: closedPort }),
      'badpw'
    )
    expect(oraDead.ok).toBe(false)

    // Verify MssqlDriver.createSession happy path & error scrubbing
    const connectSpy = vi.spyOn(ConnectionPool.prototype, 'connect')
    try {
      connectSpy.mockResolvedValueOnce({} as ConnectionPool)
      const msSess = await msDriver.createSession(makeMssqlProfile({ host: '127.0.0.1', port: 1433 }), 'pw')
      expect(msSess.driverType).toBe('mssql')
      await msSess.close()

      const frozenErr = new Error('mssql://sa:SecretPass!@127.0.0.1/appdb failed')
      Object.defineProperty(frozenErr, 'message', { value: frozenErr.message, writable: false, configurable: true })
      connectSpy.mockRejectedValueOnce(frozenErr)
      await expect(msDriver.createSession(makeMssqlProfile(), 'SecretPass!')).rejects.toMatchObject({
        driver: 'mssql',
        code: 'MSSQL_ERROR',
      })
    } finally {
      connectSpy.mockRestore()
    }

    // Verify OracleDriver.createSession CURRENT_SCHEMA paths + ORA-01435 ignore + failure cleanup
    const getConnSpy = vi.spyOn(oracledb, 'getConnection')
    try {
      const mockClose = vi.fn(async () => {})
      const mockExecute = vi.fn(async () => ({ rows: [], rowsAffected: 0 }))
      getConnSpy.mockResolvedValueOnce({
        execute: mockExecute,
        commit: async () => {},
        rollback: async () => {},
        close: mockClose,
      } as unknown as Awaited<ReturnType<typeof oracledb.getConnection>>)
      const s1 = await oraDriver.createSession(makeOracleProfile({ user: 'hr', database: 'SALES' }), 'pw')
      expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining('CURRENT_SCHEMA'), {}, { autoCommit: true })
      await s1.close()

      const execIgnore1435 = vi.fn(async () => {
        throw Object.assign(new Error('ORA-01435: user does not exist'), { errorNum: 1435 })
      })
      getConnSpy.mockResolvedValueOnce({
        execute: execIgnore1435,
        commit: async () => {},
        rollback: async () => {},
        close: mockClose,
      } as unknown as Awaited<ReturnType<typeof oracledb.getConnection>>)
      const s2 = await oraDriver.createSession(makeOracleProfile({ user: 'hr', database: 'APPDB' }), 'pw')
      await s2.close()

      const execFatal = vi.fn(async () => {
        throw Object.assign(new Error('ORA-01031: insufficient privileges'), { errorNum: 1031 })
      })
      mockClose.mockClear()
      getConnSpy.mockResolvedValueOnce({
        execute: execFatal,
        commit: async () => {},
        rollback: async () => {},
        close: mockClose,
      } as unknown as Awaited<ReturnType<typeof oracledb.getConnection>>)
      await expect(oraDriver.createSession(makeOracleProfile({ user: 'hr', database: 'APPDB' }), 'pw')).rejects.toThrow(/1031/)
      expect(mockClose).toHaveBeenCalled()
    } finally {
      getConnSpy.mockRestore()
    }
  }, 15000)

  it('Block 3: MssqlSession full lifecycle, types, pinned tx, savepoints, conflicts, cancellation & closed guards', async () => {
    let failTestOnce: unknown = null
    let failDetailsOnce = false
    let failViewDdl = false
    let updateAffected = 1
    let deleteAffected = 1
    let failUpdateOnce = false
    let failApplyOnce = false
    let txBeginCount = 0
    let txRollbackCount = 0
    let cancelShouldThrow = false
    let delaySelectResolve: ((val: { recordset: unknown[]; recordsets: unknown[][]; rowsAffected: number[] }) => void) | null = null

    const makeReq = (inTx: boolean): MssqlRequestLike => {
      const inputs: Record<string, unknown> = {}
      return {
        arrayRowMode: false,
        input(name: string, _t: unknown, val?: unknown) {
          inputs[name] = arguments.length >= 3 ? val : _t
          return this
        },
        async query(sql: string) {
          if (failTestOnce !== null) {
            const e = failTestOnce
            failTestOnce = null
            throw e
          }
          if (sql.includes('FROM sys.columns')) {
            if (failDetailsOnce) {
              failDetailsOnce = false
              throw new Error('catalog denied')
            }
            return {
              recordset: [
                {
                  name: 'id',
                  base_type: 'int',
                  system_type: 'int',
                  max_length: 4,
                  precision: 10,
                  scale: 0,
                  is_nullable: false,
                  is_identity: true,
                  is_computed: false,
                  default_value: null,
                  computed_definition: null,
                },
              ],
            }
          }
          if (sql.includes('FROM sys.indexes')) {
            return {
              recordset: [
                {
                  index_name: 'PK_users',
                  is_unique: true,
                  is_primary_key: true,
                  is_unique_constraint: false,
                  column_name: 'id',
                  is_descending_key: false,
                  is_included_column: false,
                },
              ],
            }
          }
          if (sql.includes('FROM sys.objects')) {
            const isView = String(inputs.p2 || '').startsWith('v_')
            return { recordset: [{ obj_type: isView ? 'V' : 'U', object_id: 10 }] }
          }
          if (sql.includes('FROM sys.foreign_keys') || sql.includes('FROM sys.triggers')) {
            return { recordset: [] }
          }
          if (sql.includes('OBJECT_DEFINITION') || sql.includes('sys.sql_modules')) {
            if (failViewDdl) {
              failViewDdl = false
              throw new Error('no view definition')
            }
            return { recordset: [{ definition: 'CREATE VIEW [dbo].[v_u] AS SELECT 1 AS id;' }] }
          }
          if (sql.includes('COUNT(*) AS total')) {
            return { recordset: [{ total: 1 }] }
          }
          if (sql.includes('OFFSET @p1 ROWS FETCH NEXT @p2 ROWS ONLY')) {
            return {
              recordset: [
                {
                  id: 1,
                  big: 9007199254740999n,
                  badDate: new Date('invalid'),
                  ab: new Uint8Array([1, 2]).buffer,
                  u8: new Uint8Array([3]),
                },
              ],
            }
          }
          if (sql.startsWith('UPDATE ')) {
            if (failUpdateOnce) {
              failUpdateOnce = false
              throw new Error('update failed')
            }
            return { rowsAffected: [updateAffected] }
          }
          if (sql.startsWith('DELETE ')) {
            return { rowsAffected: [deleteAffected] }
          }
          if (sql.startsWith('INSERT ')) {
            if (failApplyOnce) {
              failApplyOnce = false
              throw new Error('insert constraint violation')
            }
            return { rowsAffected: [1] }
          }
          if (sql.includes('SLOW_QUERY')) {
            return new Promise((resolve) => {
              delaySelectResolve = resolve
            })
          }
          if (sql.includes('CANCEL_ERR')) {
            throw Object.assign(new Error('Operation cancelled'), { code: 'ECANCEL' })
          }
          if (sql.includes('MAP_META')) {
            const rs = Object.assign([[1, 'a'], [2, 'b'], [3, 'c']], {
              columns: {
                c0: { index: 0, name: 'id', type: () => {} },
                c1: { index: 1, name: '', type: 'VarChar' },
              },
            })
            return { recordsets: [rs], rowsAffected: [3] }
          }
          if (sql.includes('OBJ_NOMETA')) {
            return {
              recordset: [{ k: 'v', n: 42 }, { k: 'w', n: 99 }],
              rowsAffected: [2],
            }
          }
          if (sql.includes('DML_ONLY')) {
            return { recordsets: [], rowsAffected: [4] }
          }
          void inTx
          return { recordset: [{ ok: 1 }], rowsAffected: [0] }
        },
        cancel() {
          if (cancelShouldThrow) throw new Error('cancel transport broken')
        },
      }
    }

    const pool: MssqlPoolLike = {
      connected: true,
      request: () => makeReq(false),
      close: vi.fn(async () => {
        pool.connected = false
      }),
      transaction: () => {
        const tx: MssqlTransactionLike = {
          begin: vi.fn(async () => {
            txBeginCount++
          }),
          commit: vi.fn(async () => {}),
          rollback: vi.fn(async () => {
            txRollbackCount++
          }),
          request: () => makeReq(true),
        }
        return tx
      },
    }

    const session = new MssqlSession(pool, makeMssqlProfile())
    expect(session.isAlive()).toBe(true)
    expect((await session.test()).ok).toBe(true)

    failTestOnce = 'raw secret string error'
    expect(await session.test()).toMatchObject({ ok: false })
    failTestOnce = { message: 'object error payload' }
    expect(await session.test()).toMatchObject({ ok: false, message: 'object error payload' })
    failTestOnce = 12345
    expect(await session.test()).toMatchObject({ ok: false, message: 'Failed to connect to SQL Server' })

    // Scrub frozen error w/ numeric code + error extraction in runScrubbed
    failTestOnce = (() => {
      const e = new Error('mssql://sa:TopSecret99@db/main broken')
      Object.defineProperty(e, 'message', { value: e.message, writable: false, configurable: true })
      Object.assign(e, { code: 18456 })
      return e
    })()
    await expect(session.runQuery('q-frozen', 'SELECT 1')).rejects.toMatchObject({ code: '18456' })

    // View DDL live & fallback + getObjectDdl table delegation
    expect(await session.getDdl('v_u', 'dbo')).toContain('CREATE VIEW')
    failViewDdl = true
    expect(await session.getDdl('v_u', 'dbo')).toContain('CREATE TABLE')
    expect(await session.getObjectDdl('v_u', 'table', 'dbo')).toContain('CREATE VIEW')

    // updateCell param types + unpinned rollback + conflict 0/2 + pinned savepoint
    updateAffected = 1
    await session.updateCell({
      table: 'users',
      primaryKeys: { id: 1 },
      column: 'bin',
      newValue: new Uint8Array([1, 2]).buffer,
      originalValue: new Uint8Array([3, 4]),
    })
    await session.updateCell({
      table: 'users',
      primaryKeys: { id: 2 },
      column: 'meta',
      newValue: null,
      originalValue: new Date('invalid'),
    })
    await session.updateCell({
      table: 'users',
      primaryKeys: { id: 3 },
      column: 'flag',
      newValue: false,
      originalValue: 9007199254740993n,
    })

    failUpdateOnce = true
    await expect(
      session.updateCell({ table: 'users', primaryKeys: { id: 1 }, column: 'c', newValue: 'x' })
    ).rejects.toThrow(/update failed/i)

    updateAffected = 0
    await expect(
      session.updateCell({ table: 'users', primaryKeys: { id: 1 }, column: 'c', newValue: 'x' })
    ).rejects.toMatchObject({ code: 'conflict' })

    updateAffected = 2
    await expect(
      session.updateCell({ table: 'users', primaryKeys: { id: 1 }, column: 'c', newValue: 'x' })
    ).rejects.toMatchObject({ code: 'conflict' })

    // Pinned tx mode: fetchPage, previewChanges, applyChanges empty / conflicts / savepoints, runQuery BEGIN/COMMIT/ROLLBACK
    const beforePinnedTxBegins = txBeginCount
    await session.setAutoCommit(false)
    await session.fetchPage({ table: 'users', page: 1, pageSize: 10 })
    expect(txBeginCount).toBe(beforePinnedTxBegins + 1)

    updateAffected = 1
    failUpdateOnce = true
    await expect(
      session.updateCell({ table: 'users', primaryKeys: { id: 1 }, column: 'c', newValue: 'x' })
    ).rejects.toThrow(/update failed/i)

    // previewChanges & resolveEffectiveDeletes (both working catalog and throwing fallback)
    const preview = await session.previewChanges({
      table: 'users',
      deleteRows: [{ id: 10, extra: 'ignored' }],
    })
    expect(preview.statements[0]).toContain('DELETE FROM [dbo].[users] WHERE [id] = 10')

    failDetailsOnce = true
    const previewFallback = await session.previewChanges({
      table: 'missing_tbl',
      deleteRows: [{ id: 11 }],
    })
    expect(previewFallback.statements[0]).toContain('[id] = 11')

    expect(await session.applyChanges({ table: 'users' })).toEqual({
      ok: true,
      inserted: 0,
      updated: 0,
      deleted: 0,
      statements: [],
    })

    deleteAffected = 0
    await expect(session.applyChanges({ table: 'users', deletes: [{ id: 1 }] })).rejects.toMatchObject({
      code: 'conflict',
    })
    deleteAffected = 1
    updateAffected = 0
    await expect(
      session.applyChanges({ table: 'users', updates: [{ primaryKeys: { id: 1 }, changes: { name: 'a' } }] })
    ).rejects.toMatchObject({ code: 'conflict' })
    updateAffected = 1
    failApplyOnce = true
    await expect(session.applyChanges({ table: 'users', inserts: [{ name: 'b' }] })).rejects.toThrow(/constraint/i)
    await session.commitTransaction()

    // runQuery branches: BEGIN TRAN / COMMIT / ROLLBACK + map columns + obj rows + DML + DDL cache clear + ECANCEL
    const multi = await session.runQuery(
      'q-tx-batches',
      'BEGIN TRAN;\nGO\nSELECT * FROM MAP_META;\nGO\nSELECT * FROM OBJ_NOMETA;\nGO\nUPDATE t SET a = 1; -- DML_ONLY\nGO\nCOMMIT TRAN;',
      2
    )
    expect(multi.resultSets?.length).toBe(5)
    expect(multi.resultSets?.[1].truncated).toBe(true)
    expect(multi.resultSets?.[1].columns[1].name).toBe('col_2')
    expect(multi.resultSets?.[2].columns[0].name).toBe('k')

    await session.runQuery('q-begin-rb', 'BEGIN TRAN;\nGO\nROLLBACK TRAN;')
    await session.runQuery('q-ddl', 'CREATE TABLE [dbo].[tmp_cov] (id INT);')
    await expect(session.runQuery('q-cancel-ec', 'SELECT * FROM CANCEL_ERR;')).rejects.toMatchObject({
      code: 'cancelled',
    })

    // Transaction error guards (rollback auto-begun tx from !autoCommit first, then re-enable autoCommit)
    await session.rollbackTransaction()
    await session.setAutoCommit(true)
    await expect(session.rollbackTransaction()).rejects.toMatchObject({ code: 'NO_ACTIVE_TX' })
    await expect(session.commitTransaction()).rejects.toMatchObject({ code: 'NO_ACTIVE_TX' })
    await session.beginTransaction()
    await expect(session.beginTransaction()).rejects.toMatchObject({ code: 'TX_ALREADY_ACTIVE' })
    await session.rollbackTransaction()

    // cancelQuery error path ({ ok: false }) + close() while active query & tx pending
    await session.beginTransaction()
    const pendingQuery = session.runQuery('q-hang', 'SELECT * FROM SLOW_QUERY;')
    await new Promise((r) => setTimeout(r, 15))
    cancelShouldThrow = true
    expect(await session.cancelQuery('q-hang')).toEqual({ ok: false })
    cancelShouldThrow = false

    const closePromise = session.close()
    delaySelectResolve?.({ recordset: [{ ok: 1 }], recordsets: [], rowsAffected: [0] })
    await closePromise
    await expect(pendingQuery).rejects.toMatchObject({ code: 'cancelled' })
    expect(txRollbackCount).toBeGreaterThanOrEqual(2)

    // Closed guards across all MSSQL session methods
    expect(session.isAlive()).toBe(false)
    expect(await session.test()).toEqual({ ok: false, message: 'Session is closed' })
    await expect(session.listSchemas()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.listObjects('dbo')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.getTableDetails('users')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.getDdl('users')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.getObjectDdl('v_u', 'view')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.exportSchemaDdl('dbo')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.fetchPage({ table: 'users', page: 1, pageSize: 5 })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.updateCell({ table: 'users', primaryKeys: { id: 1 }, column: 'c', newValue: 'v' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.previewChanges({ table: 'users' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.applyChanges({ table: 'users' })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.runQuery('q-closed', 'SELECT 1')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.cancelQuery('q-closed')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.beginTransaction()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.commitTransaction()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(session.rollbackTransaction()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  })

  it('Block 4: OracleSession lifecycle, LOB/cell serialization, manual tx savepoints, conflicts & cancellation', async () => {
    let failTestWith: unknown = null
    let failDetails = false
    let updateAffected = 1
    let deleteAffected = 1
    let failUpdateOnce = false
    let failApplyOnce = false
    let breakShouldThrow = false
    let slowResolve: ((v: { rows: unknown[]; metaData?: Array<{ name: string; dbTypeName?: string }> }) => void) | null = null
    let rollbackCount = 0

    const conn: OracleConnectionLike = {
      async execute(sql: string) {
        if (failTestWith !== null) {
          const e = failTestWith
          failTestWith = null
          throw e
        }
        if (sql.includes('FROM all_tab_columns')) {
          if (failDetails) {
            failDetails = false
            throw new Error('ORA-00942: table or view does not exist')
          }
          return { rows: [{ column_name: 'ID', data_type: 'NUMBER', nullable: 'N', identity_column: 'YES' }] }
        }
        if (sql.includes("ac.constraint_type = 'P'")) {
          return { rows: [{ column_name: 'ID', constraint_name: 'PK_EMP' }] }
        }
        if (sql.includes('SLOW_ORA')) {
          return new Promise((resolve) => {
            slowResolve = resolve
          })
        }
        if (sql.includes('ERR_1013')) {
          throw new Error('ORA-01013: user requested cancel of current operation')
        }
        if (sql.includes('LOB_AND_DUP')) {
          return {
            metaData: [{ name: 'ID' }, { name: 'ID' }, { name: '' }],
            rows: [
              [
                9007199254740999n,
                { getData: async () => Buffer.from([0xca, 0xfe]) },
                new Uint8Array([1, 2]).buffer,
              ],
              [1, 'second', new Uint8Array([9])],
            ],
          }
        }
        if (sql.includes('OBJ_NOMETA')) {
          return {
            rows: [
              { A: { getData: async () => 'clob-str' }, B: 9007199254740999n },
            ],
          }
        }
        if (sql.startsWith('UPDATE ')) {
          if (failUpdateOnce) {
            failUpdateOnce = false
            throw new Error('ORA-02290: check constraint violated')
          }
          return { rowsAffected: updateAffected }
        }
        if (sql.startsWith('DELETE ')) {
          return { rowsAffected: deleteAffected }
        }
        if (sql.startsWith('INSERT ')) {
          if (failApplyOnce) {
            failApplyOnce = false
            throw new Error('ORA-00001: unique constraint violated')
          }
          return { rowsAffected: 1 }
        }
        return { rows: [{ OK: 1 }], rowsAffected: 0 }
      },
      async commit() {},
      async rollback() {
        rollbackCount++
      },
      async close() {},
      async break() {
        if (breakShouldThrow) throw new Error('break error')
      },
    }

    const session = new OracleSession(conn, makeOracleProfile(), { defaultSchema: 'HR' })
    expect((await session.test()).ok).toBe(true)
    failTestWith = { message: 'object fail msg' }
    expect(await session.test()).toMatchObject({ ok: false, message: 'object fail msg' })
    failTestWith = 'raw oracle fail'
    expect(await session.test()).toMatchObject({ ok: false, message: 'raw oracle fail' })
    failTestWith = 0
    expect(await session.test()).toMatchObject({ ok: false, message: 'Failed to connect to Oracle' })

    // Scrubbing frozen error on runScrubbed
    failTestWith = (() => {
      const e = new Error('oracle://hr:SecretOra!@db:1521/FREEPDB1 error')
      Object.defineProperty(e, 'message', { value: e.message, writable: false, configurable: true })
      return e
    })()
    await expect(session.test()).resolves.toMatchObject({ ok: false })

    // LOB Buffer + Uint8Array/ArrayBuffer + duplicate/empty col names + object row w/o meta + truncation + unsafe bigint bind
    const lobRes = await session.runQuery('q-lob', 'SELECT * FROM LOB_AND_DUP;', 1)
    expect(lobRes.columns.map((c) => c.name)).toEqual(['ID', 'ID_2', 'col_3'])
    expect(lobRes.truncated).toBe(true)

    const objRes = await session.runQuery('q-obj', 'SELECT * FROM OBJ_NOMETA;')
    expect(objRes.columns[0].name).toBe('A')
    expect(objRes.rows[0]).toEqual(['clob-str', '9007199254740999'])

    // Script COMMIT / ROLLBACK + ORA-01013 + DDL cache clear
    const scriptTx = await session.runQuery('q-script', 'SELECT 1 FROM DUAL; COMMIT; SELECT 2 FROM DUAL; ROLLBACK;')
    expect(scriptTx.resultSets?.length).toBe(4)
    await expect(session.runQuery('q-1013', 'SELECT * FROM ERR_1013;')).rejects.toMatchObject({ code: 'cancelled' })
    await session.runQuery('q-ddl', 'CREATE TABLE TMP_O (id NUMBER);')

    // autoCommit=false transitions -> SAVEPOINT datanoa_uc & ROLLBACK TO SAVEPOINT datanoa_uc
    await session.setAutoCommit(false)
    await session.updateCell({
      table: 'EMPLOYEES',
      primaryKeys: { ID: 1 },
      column: 'BIG_VAL',
      newValue: 9007199254740999n,
      originalValue: undefined,
    })
    expect(session.getTransactionState().active).toBe(true)
    await expect(session.setAutoCommit(true)).rejects.toMatchObject({ code: 'TX_ACTIVE' })

    failUpdateOnce = true
    await expect(
      session.updateCell({ table: 'EMPLOYEES', primaryKeys: { ID: 1 }, column: 'NAME', newValue: 'X' })
    ).rejects.toThrow(/ORA-02290/)

    // previewChanges & resolveEffectiveDeletes fallback + applyChanges conflicts / savepoint rollback
    failDetails = true
    const preview = await session.previewChanges({ table: 'MISSING_EMP', deleteRows: [{ ID: 5 }] })
    expect(preview.statements[0]).toContain('"ID" = 5')

    deleteAffected = 0
    await expect(
      session.applyChanges({ table: 'EMPLOYEES', deletes: [{ ID: 1 }] })
    ).rejects.toMatchObject({ code: 'conflict' })
    deleteAffected = 1
    updateAffected = 0
    await expect(
      session.applyChanges({ table: 'EMPLOYEES', updates: [{ primaryKeys: { ID: 1 }, changes: { NAME: 'Y' } }] })
    ).rejects.toMatchObject({ code: 'conflict' })
    updateAffected = 1
    failApplyOnce = true
    await expect(
      session.applyChanges({ table: 'EMPLOYEES', inserts: [{ ID: 2 }] })
    ).rejects.toThrow(/ORA-00001/)

    // Manual tx errors
    await expect(session.beginTransaction()).rejects.toMatchObject({ code: 'TX_ALREADY_ACTIVE' })
    await session.commitTransaction()
    await expect(session.commitTransaction()).rejects.toMatchObject({ code: 'NO_ACTIVE_TX' })
    await expect(session.rollbackTransaction()).rejects.toMatchObject({ code: 'NO_ACTIVE_TX' })

    // Unpinned applyChanges failure triggers conn.rollback()
    await session.setAutoCommit(true)
    failApplyOnce = true
    await expect(session.applyChanges({ table: 'EMPLOYEES', inserts: [{ ID: 3 }] })).rejects.toThrow(/ORA-00001/)
    expect(rollbackCount).toBeGreaterThanOrEqual(1)

    // Pending query cancel -> throw -> { ok: false } & post-execute cancelled guard + close() while active query & txActive
    await session.beginTransaction()
    const slowP = session.runQuery('q-slow-ora', 'SELECT * FROM SLOW_ORA;')
    await new Promise((r) => setTimeout(r, 15))
    breakShouldThrow = true
    expect(await session.cancelQuery('q-slow-ora')).toEqual({ ok: false })
    breakShouldThrow = false

    const closing = session.close()
    slowResolve?.({ rows: [{ OK: 1 }] })
    await closing
    await expect(slowP).rejects.toMatchObject({ code: 'cancelled' })

    expect(await session.test()).toEqual({ ok: false, message: 'Session is closed' })
    await expect(session.runQuery('closed', 'SELECT 1 FROM DUAL')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  })
})
