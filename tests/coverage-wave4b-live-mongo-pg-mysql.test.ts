import * as dns from 'node:dns'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tls from 'node:tls'
import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from '../vendor/pg.js'
import {
  BSONRegExp,
  Decimal128,
  Double,
  Long,
  ObjectId,
  Timestamp,
} from '../vendor/mongodb.js'
import type { ConnectionProfile } from '../src/protocol'
import { DatabaseDriverError } from '../src/drivers/common/driver'
import * as tlsAndTunnel from '../src/drivers/common/tls-and-tunnel'
import {
  MongoDriver,
  MongoLiteralParser,
  buildMongoConnectionConfig,
  parseMongoStatement,
  parseRelaxedMongoValue,
  serializeMongoDocument,
  serializeMongoValue,
  splitMongoScriptStatements,
  translateSqlFilterToMongoFilter,
  type MongoClientFactory,
  type MongoClientLike,
} from '../src/drivers/mongodb/driver'
import {
  PostgresDriver,
  PostgresSession,
  formatPostgresError,
  resolveSupabasePoolerConfig,
} from '../src/drivers/postgres/driver'
import {
  MysqlDriver,
  MysqlSession,
  type MysqlConnectionLike,
  type MysqlPoolLike,
} from '../src/drivers/mysql/driver'

const MONGO_PORT = 57017
const MONGO_DB = 'datanoa_cov_mongo_w4b'
const MONGO_DROP_DB = 'datanoa_cov_mongo_w4b_drop'

const PG_HOST = '127.0.0.1'
const PG_PORT = 55433
const PG_USER = 'datanoa'
const PG_PASS = 'datanoa_pass'
const PG_DB = 'datanoa_test'
const PG_SCHEMA = 'cov_pg_w4b'

const CRDB_PORT = 56257
const CRDB_SCHEMA = 'cov_crdb_w4b'

const MYSQL_PORT = 53306
const MARIA_PORT = 53307
const MYSQL_USER = 'datanoa'
const MYSQL_PASS = 'datanoa_mysql_pass'
const MARIA_PASS = 'datanoa_maria_pass'
const MYSQL_DB = 'datanoa_test'
const MYSQL_W4B_TABLES = ['cov_w4b_parent', 'cov_w4b_child', 'cov_w4b_tx_tbl', 'cov_w4b_bit_tbl']

function makeMongoProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'cov-mongo-w4b',
    name: 'Live MongoDB W4B',
    type: 'mongodb',
    host: '127.0.0.1',
    port: MONGO_PORT,
    database: MONGO_DB,
    options: JSON.stringify({
      replicaSet: 'rs0',
      directConnection: true,
      appName: 'datanoa-cov-w4b',
      retryWrites: true,
      maxPoolSize: 4,
      connectTimeoutMS: 5000,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 10000,
    }),
    ...overrides,
  }
}

function makePgProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'cov-pg-w4b',
    name: 'Live PG W4B',
    driver: 'postgres',
    type: 'postgres',
    host: PG_HOST,
    port: PG_PORT,
    database: PG_DB,
    user: PG_USER,
    sslMode: 'disable',
    ...overrides,
  }
}

function makeCrdbProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'cov-crdb-w4b',
    name: 'Live CRDB W4B',
    driver: 'cockroachdb',
    type: 'cockroachdb',
    host: PG_HOST,
    port: CRDB_PORT,
    database: PG_DB,
    user: 'root',
    ssl: false,
    ...overrides,
  }
}

function makeMysqlProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'cov-mysql-w4b',
    name: 'Live MySQL W4B',
    driver: 'mysql',
    type: 'mysql',
    host: PG_HOST,
    port: MYSQL_PORT,
    database: MYSQL_DB,
    user: MYSQL_USER,
    sslMode: 'disable',
    ...overrides,
  }
}

function makeMariaProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'cov-maria-w4b',
    name: 'Live MariaDB W4B',
    driver: 'mariadb',
    type: 'mariadb',
    host: PG_HOST,
    port: MARIA_PORT,
    database: MYSQL_DB,
    user: MYSQL_USER,
    sslMode: 'disable',
    ...overrides,
  }
}

describe('Wave 4B Live MongoDB, Postgres/CRDB & MySQL/MariaDB Coverage Closure', () => {
  const tempDirs: string[] = []
  const trackedSessions: Array<{ close(): Promise<void> }> = []
  const makeTempDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }

  async function withSession<T extends { close(): Promise<void> }>(
    session: T,
    run?: (s: T) => Promise<void>
  ): Promise<T> {
    trackedSessions.push(session)
    try {
      if (run) await run(session)
    } finally {
      await session.close()
    }
    return session
  }

  afterEach(async () => {
    vi.restoreAllMocks()
    while (trackedSessions.length > 0) {
      const s = trackedSessions.pop()!
      await s.close().catch(() => {})
    }
  })

  async function cleanupMysqlObjects(driver: MysqlDriver, profile: ConnectionProfile, pass: string): Promise<void> {
    const s = (await driver.createSession(profile, pass)) as MysqlSession
    try {
      await s.runQuery('w4b-drop-v', 'DROP VIEW IF EXISTS cov_w4b_view;')
      for (const tbl of [...MYSQL_W4B_TABLES].reverse()) {
        await s.runQuery(`w4b-drop-${tbl}`, `DROP TABLE IF EXISTS ${tbl};`)
      }
    } finally {
      await s.close().catch(() => {})
    }
  }

  beforeAll(async () => {
    const mongoDriver = new MongoDriver()
    const mSess = await mongoDriver.createSession(makeMongoProfile())
    try {
      await mSess.runQuery('w4b-m-pre-1', `use ${MONGO_DB}; db.dropDatabase();`)
      await mSess.runQuery('w4b-m-pre-2', `use ${MONGO_DROP_DB}; db.dropDatabase();`)
    } finally {
      await mSess.close()
    }

    const pgDriver = new PostgresDriver()
    const pgSess = await pgDriver.createSession(makePgProfile(), PG_PASS)
    try {
      await pgSess.runQuery('w4b-pg-pre', `DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE; CREATE SCHEMA ${PG_SCHEMA};`)
    } finally {
      await pgSess.close()
    }

    const crdbSess = await pgDriver.createSession(makeCrdbProfile())
    try {
      await crdbSess.runQuery('w4b-crdb-pre', `DROP SCHEMA IF EXISTS ${CRDB_SCHEMA} CASCADE; CREATE SCHEMA ${CRDB_SCHEMA};`)
    } finally {
      await crdbSess.close()
    }

    await cleanupMysqlObjects(new MysqlDriver('mysql'), makeMysqlProfile(), MYSQL_PASS)
    await cleanupMysqlObjects(new MysqlDriver('mariadb'), makeMariaProfile(), MARIA_PASS)
  }, 30_000)

  afterAll(async () => {
    try {
      const mongoDriver = new MongoDriver()
      const mSess = await mongoDriver.createSession(makeMongoProfile())
      try {
        await mSess.runQuery('w4b-m-post-1', `use ${MONGO_DB}; db.dropDatabase();`)
        await mSess.runQuery('w4b-m-post-2', `use ${MONGO_DROP_DB}; db.dropDatabase();`)
      } finally {
        await mSess.close()
      }
    } catch {
      // best-effort cleanup
    }

    try {
      const pgDriver = new PostgresDriver()
      const pgSess = await pgDriver.createSession(makePgProfile(), PG_PASS)
      try {
        await pgSess.runQuery('w4b-pg-post', `DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE;`)
      } finally {
        await pgSess.close()
      }
    } catch {
      // best-effort cleanup
    }

    try {
      const pgDriver = new PostgresDriver()
      const crdbSess = await pgDriver.createSession(makeCrdbProfile())
      try {
        await crdbSess.runQuery('w4b-crdb-post', `DROP SCHEMA IF EXISTS ${CRDB_SCHEMA} CASCADE;`)
      } finally {
        await crdbSess.close()
      }
    } catch {
      // best-effort cleanup
    }

    await cleanupMysqlObjects(new MysqlDriver('mysql'), makeMysqlProfile(), MYSQL_PASS).catch(() => {})
    await cleanupMysqlObjects(new MysqlDriver('mariadb'), makeMariaProfile(), MARIA_PASS).catch(() => {})

    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore cleanup error
      }
    }
  }, 30_000)

  it('closes MongoDB pure BSON serialization, MongoLiteralParser, SQL filter translator, script parser & PBT gaps', async () => {
    const safeFieldArb = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,12}$/).filter(
      (s) =>
        ![
          '__proto__',
          'constructor',
          'prototype',
          'AND',
          'OR',
          'NOT',
          'IS',
          'NULL',
          'LIKE',
          'ILIKE',
          'IN',
          'TRUE',
          'FALSE',
        ].includes(s.toUpperCase())
    )
    const hex24Arb = fc.stringMatching(/^[0-9a-f]{24}$/)

    fc.assert(
      fc.property(
        safeFieldArb,
        fc.integer({ min: -50000, max: 50000 }),
        fc.stringMatching(/^[a-zA-Z0-9 _-]{0,16}$/),
        hex24Arb,
        (field, num, str, hex) => {
          const literal = `{ ${field}: ${num}, hexNum: -0x1f, posHex: 0x1f, rx: /a[x/y]b/i, txt: ${JSON.stringify(str)}, oid: ObjectId('${hex}') }`
          const parsed = parseRelaxedMongoValue(literal) as Record<string, unknown>
          expect(parsed[field]).toBe(num)
          expect(parsed.hexNum).toBe(-31)
          expect(parsed.posHex).toBe(31)
          expect(parsed.rx).toBeInstanceOf(BSONRegExp)
          expect(parsed.txt).toBe(str)
          expect((parsed.oid as ObjectId).toHexString()).toBe(hex)

          const ser = serializeMongoValue(parsed) as Record<string, unknown>
          expect(ser[field]).toBe(num)
          expect(ser.rx).toBe('/a[x/y]b/i')
          expect(ser.oid).toBe(hex)

          const escaped = str.replace(/'/g, "''").replace(/%/g, '\\%').replace(/_/g, '\\_')
          const clause = `("${field}" <> ${num} AND \`${field}\` <= ${num + 10} AND [${field}] >= ${num - 10}) OR (${field} NOT LIKE '%${escaped}%' AND _id = '${hex}')`
          const translated = translateSqlFilterToMongoFilter(clause)
          expect(translated).toHaveProperty('$or')
          expect(translateSqlFilterToMongoFilter(clause)).toEqual(translated)

          const stmts = splitMongoScriptStatements(`db.${field}.find({ p: /a;b/i }); db.${field}.find({ n: ${num} });`)
          expect(stmts).toHaveLength(2)
        }
      ),
      { numRuns: 40 }
    )

    // serializeMongoValue edge BSON / symbol / fn / invalid Date / Timestamp / Binary / Int32 / Double / Long / Code fallbacks
    expect(serializeMongoValue(Symbol('sym'))).toBeNull()
    expect(serializeMongoValue(() => 42)).toBeNull()
    expect(serializeMongoValue(new Date(NaN))).toBeNull()
    expect(serializeMongoValue(9007199254740993n)).toBe('9007199254740993')
    expect(serializeMongoValue(42n)).toBe(42)
    expect(serializeMongoValue(Infinity)).toBeNull()
    expect(serializeMongoValue(new Double(NaN))).toBeNull()
    expect(serializeMongoValue(Long.fromString('9007199254740993'))).toBe('9007199254740993')

    const nullProtoInt32 = Object.create(null) as Record<string | symbol, unknown>
    nullProtoInt32._bsontype = 'Int32'
    nullProtoInt32[Symbol.toPrimitive] = () => 19
    expect(serializeMongoValue(nullProtoInt32)).toBe(19)

    const nullProtoDouble = Object.create(null) as Record<string | symbol, unknown>
    nullProtoDouble._bsontype = 'Double'
    nullProtoDouble[Symbol.toPrimitive] = () => 2.25
    expect(serializeMongoValue(nullProtoDouble)).toBe(2.25)

    const fakeOidNoMethod = Object.create(null) as Record<string, unknown>
    fakeOidNoMethod._bsontype = 'ObjectId'
    fakeOidNoMethod.toString = () => 'custom-oid'
    expect(serializeMongoValue(fakeOidNoMethod)).toBe('custom-oid')

    const fakeLongNoToNumber = Object.create(null) as Record<string, unknown>
    fakeLongNoToNumber._bsontype = 'Long'
    fakeLongNoToNumber.toString = () => '12345678901234567890'
    expect(serializeMongoValue(fakeLongNoToNumber)).toBe('12345678901234567890')

    const fakeTs = Object.assign(new Timestamp({ t: 7, i: 9 }), {
      getHighBits: undefined,
      getLowBits: undefined,
    })
    expect(serializeMongoValue(fakeTs)).toEqual({ $timestamp: { t: 7, i: 9 } })

    const fakeBinEmpty = { _bsontype: 'Binary' }
    expect(serializeMongoValue(fakeBinEmpty)).toEqual({
      $binary: { base64: '', subType: '00' },
    })
    const fakeBinNoPos = { _bsontype: 'Binary', sub_type: 2, buffer: new Uint8Array([65, 66]) }
    expect(serializeMongoValue(fakeBinNoPos)).toEqual({
      $binary: { base64: 'QUI=', subType: '02' },
    })

    expect(serializeMongoValue({ _bsontype: 'BSONRegExp' })).toBe('//')
    expect(serializeMongoValue({ _bsontype: 'Code' })).toEqual({ $code: '' })
    expect(serializeMongoDocument({ a: 1, b: undefined, c: () => {}, d: Symbol('d') })).toEqual({ a: 1 })

    // MongoLiteralParser edge literals, escapes, regexes, helpers, and syntax errors
    const complexLit = parseRelaxedMongoValue(`{
      hexStr: '\\x41\\x42',
      uni4: '\\u0043',
      uniBrace: '\\u{1F600}',
      escChars: '\\b\\f\\/\\0\\z\\\`\\n\\r\\t',
      'sq': 'ok',
      "dq": "ok",
      \`bt\`: \`plain\`,
      rx1: /foo[a/b]\\/bar\\d+/ims,
      negInf: -Infinity,
      posInf: Infinity,
      nanVal: NaN,
      undefVal: undefined,
      hexPos: 0X10,
      frac: .5,
      newOid: new ObjectId('0123456789abcdef01234567'),
      newDt: new Date('2025-01-01T00:00:00Z'),
      binHex: BinData('02', 'YQ=='),
      bin0: Binary(123, 'bad'),
      ts0: Timestamp(),
      tsObj: Timestamp({}),
      rxHelper: BSONRegExp(),
      codeEmpty: Code(),
      __proto__: { polluted: true },
      constructor: 'skip',
      prototype: 'skip'
    }`) as Record<string, unknown>
    expect(complexLit.hexStr).toBe('AB')
    expect(complexLit.uni4).toBe('C')
    expect(complexLit.uniBrace).toBe('😀')
    expect(complexLit.negInf).toBe(-Infinity)
    expect(complexLit.posInf).toBe(Infinity)
    expect(Number.isNaN(complexLit.nanVal)).toBe(true)
    expect(complexLit.undefVal).toBeUndefined()
    expect(complexLit.hexPos).toBe(16)
    expect(complexLit.frac).toBe(0.5)
    expect(complexLit.rx1).toBeInstanceOf(BSONRegExp)
    expect((complexLit.rx1 as BSONRegExp).pattern).toBe('foo[a/b]\\/bar\\d+')
    expect((complexLit.rx1 as BSONRegExp).options).toBe('ims')
    expect(Object.prototype.hasOwnProperty.call(complexLit, 'constructor')).toBe(false)

    // Regression assertions for Bug #8: hex & negative hex literals (0x1f, -0x1f, -0X1F, -0x0)
    expect(parseRelaxedMongoValue('0x1f')).toBe(31)
    expect(parseRelaxedMongoValue('-0x1f')).toBe(-31)
    expect(parseRelaxedMongoValue('-0X1F')).toBe(-31)
    expect(parseRelaxedMongoValue('-0x0') === 0).toBe(true)
    expect(parseRelaxedMongoValue('Binary()')).toBeTruthy()
    expect(parseRelaxedMongoValue('.5')).toBe(0.5)
    expect(() => parseRelaxedMongoValue('.bad')).toThrow()

    for (const badExpr of [
      '/* unterminated comment',
      '`hello ${x}`',
      '"unterminated\\',
      '"\\xZZ"',
      '"\\u{123"',
      '"\\u{ZZZZ}"',
      '"\\u12ZZ"',
      '/unclosed[a/b',
      '/trail\\',
      '/line\nbreak/',
      '-foo',
      '-InfinityFoo',
      '@bad',
      'bareIdent',
      'ObjectId("0123456789abcdef01234567" "extra")',
      '[1 2]',
      '{ : 1 }',
      '{ a: 1 b: 2 }',
      '123 extraToken',
    ]) {
      expect(() => parseRelaxedMongoValue(badExpr)).toThrow()
    }
    expect(() => new MongoLiteralParser('notArgs').parseCallArgList()).toThrow(/Expected "\("/)

    // translateSqlFilterToMongoFilter complete coverage + errors
    expect(translateSqlFilterToMongoFilter('   ')).toEqual({})
    const f1 = translateSqlFilterToMongoFilter(
      `"col""q" = 'it''s\\n\\r\\t\\\\b' AND \`b\` IS NULL AND [c] IS NOT NULL AND d = TRUE AND e = FALSE AND f = NULL AND g = -5.5 AND h ILIKE '100\\\\%\\\\_x' AND i NOT ILIKE 'y%' AND j NOT LIKE NULL AND k ILIKE 123 AND l LIKE NULL`
    )
    expect(f1).toHaveProperty('$and')
    expect(translateSqlFilterToMongoFilter('(a = 1 OR b = 2)')).toEqual({ $or: [{ a: 1 }, { b: 2 }] })

    for (const badFilter of [
      "'unterminated",
      '"unterminatedIdent',
      '1 = 1',
      'colOnly',
      '(a = 1',
      '(a = 1 b = 2)',
      'a = 1 AND ',
      'a IS 1',
      'a IS NOT 1',
      'a NOT = 1',
      'a NOT 1',
      'a = (1)',
      'a AND',
      'a =',
      'a IN (1 2)',
      'a = 1 trailing',
      '()',
      'a ^ 1',
      'col NOT OR',
    ]) {
      expect(() => translateSqlFilterToMongoFilter(badFilter)).toThrow()
    }

    // splitMongoScriptStatements & parseMongoStatement edges
    expect(
      splitMongoScriptStatements("show dbs\nuse db_one\ndb.c.find({ x: 'a\\'b', r: /x;y[a\\/b]\\/z/i }); /* unterminated")
    ).toHaveLength(3)
    expect(splitMongoScriptStatements('db.c.find({ a: /unclosed\n })')).toHaveLength(1)
    expect(() => parseMongoStatement('   ')).toThrow(/empty/i)
    expect(parseMongoStatement("db['my.coll'].find({ a: 1 })")).toMatchObject({
      kind: 'collection_method',
      collection: 'my.coll',
      method: 'find',
    })
    expect(parseMongoStatement("db['my.coll'].explain('executionStats').find({})")).toMatchObject({
      kind: 'collection_method',
      collection: 'my.coll',
      method: 'find',
    })
    expect(parseMongoStatement("db.getCollection('my.coll').explain().aggregate([])")).toMatchObject({
      kind: 'collection_method',
      collection: 'my.coll',
      method: 'aggregate',
    })
    expect(parseMongoStatement("db.getCollection('my.coll').find({})")).toMatchObject({
      kind: 'collection_method',
      collection: 'my.coll',
      method: 'find',
    })

    for (const badStmt of [
      'db[123].find({})',
      "db['c'",
      "db['c']",
      "db['c'].",
      'db.()',
      'db',
      'db.getCollection()',
      "db.getCollection('c')",
      'db.notARealMethod()',
      'db.c.explain().insertOne({})',
      'db.c.unknownMethod()',
      'totally invalid statement!',
    ]) {
      expect(() => parseMongoStatement(badStmt)).toThrow()
    }

    // buildMongoConnectionConfig edge branches
    const cfgDisabled = await buildMongoConnectionConfig(
      makeMongoProfile({
        url: 'mongodb://h1:27017/plaindb',
        database: undefined,
        sslMode: 'disable',
        options: '{invalid-json',
      })
    )
    expect(cfgDisabled.dbName).toBe('plaindb')
    expect(cfgDisabled.options.tls).toBe(false)

    const cfgArrayOpts = await buildMongoConnectionConfig(
      makeMongoProfile({
        url: 'mongodb://bad host name:abc/db1',
        sshEnabled: true,
        ssl: false,
        sslMode: undefined,
        options: '[1,2,3]',
      })
    )
    expect(cfgArrayOpts.options.tls).toBe(false)

    const cfgKvFallback = await buildMongoConnectionConfig(
      makeMongoProfile({
        ssl: true,
        sslMode: undefined,
        options: 'customKey=hello;=emptyKey;emptyName=',
      }),
      undefined,
      { sslKeyPassphrase: 'keypw' }
    )
    expect(cfgKvFallback.options.tls).toBe(true)

    const cfgPrimitiveJson = await buildMongoConnectionConfig(
      makeMongoProfile({ options: '123' }),
      undefined,
      { sslKeyPassphrase: 'keypw' }
    )
    expect(cfgPrimitiveJson.options.tls).toBeUndefined()

    const tlsPassDir = makeTempDir('datanoa-mongo-pass-')
    const keyPemFile = path.join(tlsPassDir, 'key.pem')
    fs.writeFileSync(keyPemFile, 'FAKE_KEY')
    const cfgVerifyFullPass = await buildMongoConnectionConfig(
      makeMongoProfile({ sslMode: 'verify-full', sslKeyPath: keyPemFile }),
      undefined,
      { sslKeyPassphrase: 'secret-passphrase' }
    )
    expect(cfgVerifyFullPass.options.passphrase).toBe('secret-passphrase')
    expect(cfgVerifyFullPass.options.tlsCertificateKeyFilePassword).toBe('secret-passphrase')

    // Additional URI / default host / empty db / non-mongo url config edge branches
    const cfgNoSlash = await buildMongoConnectionConfig(
      makeMongoProfile({ url: 'mongodb://h1', database: '', user: '', host: '', port: 0 }),
      'onlyPass'
    )
    expect(cfgNoSlash.dbName).toBe('admin')
    expect(cfgNoSlash.uri).toContain(':onlyPass@h1')

    const cfgEmptyDbSeg = await buildMongoConnectionConfig(
      makeMongoProfile({ url: 'mongodb://h1/   ?x=1', database: '', user: 'u1', sshEnabled: true, host: '', port: 0 })
    )
    expect(cfgEmptyDbSeg.dbName).toBe('admin')
    expect(cfgEmptyDbSeg.uri).toContain('127.0.0.1:27017')

    const cfgNonMongoUrl = await buildMongoConnectionConfig(
      makeMongoProfile({ url: 'http://not-mongo', user: 'u1', database: 'dbx' }),
      'pw'
    )
    expect(cfgNonMongoUrl.uri).toBe('http://not-mongo')

    const cfgNoUrlDefaults = await buildMongoConnectionConfig(
      makeMongoProfile({ url: undefined, host: '', port: 0, database: '', user: 'u1' })
    )
    expect(cfgNoUrlDefaults.uri).toContain('u1:@localhost:27017/admin')

    const cfgWsAndEmptyKv = await buildMongoConnectionConfig(
      makeMongoProfile({ options: '   ' })
    )
    expect(cfgWsAndEmptyKv.options.connectTimeoutMS).toBe(10_000)
  })

  it('exercises live MongoDB 7 dynamic page column merge, runCommand batches, AggregationCursor cancel, tx close(), and mock fault-injection paths', async () => {
    const driver = new MongoDriver()
    const sess = await driver.createSession(makeMongoProfile())
    try {
      await sess.runQuery(
        'w4b-seed',
        `
        use ${MONGO_DB};
        db.createCollection('dyn_items', { capped: true, size: 65536 });
        db.dyn_items.createIndex({ tag: 1 }, { name: 'idx_tag_sparse', sparse: true });
        db.dyn_items.insertMany([
          { tag: 'alpha', note: null, qty: 1 },
          { tag: 'beta', note: 'filled', qty: 2 },
          { tag: 'alpha', note: 'third', qty: 3 }
        ]);
        `
      )

      const initialDetails = await sess.getTableDetails('dyn_items', MONGO_DB)
      expect(initialDetails.ddl).toContain('capped')
      expect(initialDetails.ddl).toContain('sparse')

      await sess.runQuery(
        'w4b-seed-warm',
        `
        db.createCollection('warm_coll');
        db.warm_coll.insertOne({ code: 'w1', base: 1 });
        `
      )
      const warmDetails = await sess.getTableDetails('warm_coll', MONGO_DB)
      expect(warmDetails.columns.some((c) => c.name === 'lateCol')).toBe(false)
      const helperSess = await driver.createSession(makeMongoProfile())
      try {
        await helperSess.runQuery(
          'w4b-helper-ins',
          `use ${MONGO_DB}; db.warm_coll.insertOne({ code: 'w2', base: 2, lateCol: 'merged!' });`
        )
      } finally {
        await helperSess.close()
      }
      const mergedPage = await sess.fetchPage({
        table: 'warm_coll',
        schema: MONGO_DB,
        page: 1,
        pageSize: 10,
      })
      expect(mergedPage.columns.some((c) => c.name === 'lateCol')).toBe(true)
      const refreshedCached = await sess.getTableDetails('warm_coll', MONGO_DB)
      expect(refreshedCached.columns.some((c) => c.name === 'lateCol')).toBe(true)

      await sess.runQuery('w4b-empty-coll', `db.createCollection('empty_coll');`)
      const emptyDetails = await sess.getTableDetails('empty_coll', MONGO_DB)
      expect(emptyDetails.columns.map((c) => c.name)).toEqual(['_id'])

      // db.runCommand({ find }) firstBatch + maxRows truncation, distinct values array, listDatabases on admin, db.stats, db.serverStatus, db.getCollectionNames
      const runFindTrunc = await sess.runQuery(
        'w4b-cmd-find',
        `db.runCommand({ find: 'dyn_items', filter: {} });`,
        2
      )
      expect(runFindTrunc.truncated).toBe(true)
      expect(runFindTrunc.rowCount).toBe(2)

      const runDistinct = await sess.runQuery(
        'w4b-cmd-distinct',
        `db.runCommand({ distinct: 'dyn_items', key: 'tag' });`
      )
      expect(runDistinct.columns[0].name).toBe('value')
      expect(runDistinct.rowCount).toBeGreaterThanOrEqual(2)

      const rawListDbs = await sess.runQuery(
        'w4b-raw-listdbs',
        `use admin; { listDatabases: 1 }; use ${MONGO_DB};`
      )
      expect(rawListDbs.resultSets?.[1]?.rowCount).toBeGreaterThanOrEqual(1)

      const dbInfoRes = await sess.runQuery(
        'w4b-db-info',
        `
        db.stats({ scale: 1 });
        db.serverStatus();
        db.getCollectionNames();
        db.dyn_items.find({}).explain();
        db.dyn_items.aggregate([{ $match: { qty: { $gte: 1 } } }]).explain('executionStats');
        `
      )
      expect(dbInfoRes.resultSets).toHaveLength(5)

      for (const bad of [
        'db.runCommand("not-obj")',
        'db.adminCommand(123)',
        'db.dyn_items.find({}).sort(123)',
        'db.dyn_items.find({}).project(123)',
        'db.dyn_items.aggregate("not-arr")',
      ]) {
        await expect(sess.runQuery('w4b-bad-cmd', bad)).rejects.toThrow()
      }

      const roSess = await driver.createSession(makeMongoProfile({ readOnly: true }))
      try {
        await expect(roSess.runQuery('w4b-ro-shorthand', `warm_coll`)).resolves.toBeTruthy()
        await expect(
          roSess.runQuery('w4b-ro-db-read', `db.stats(); db.serverStatus(); db.getCollectionNames();`)
        ).resolves.toBeTruthy()
        await expect(
          roSess.runQuery('w4b-ro-agg-ok', `db.runCommand({ aggregate: 'dyn_items', pipeline: [{ $match: { qty: 1 } }], cursor: {} })`)
        ).resolves.toBeTruthy()
        await expect(roSess.runQuery('w4b-ro-explain-ok', `{ explain: 'ping' }`)).rejects.toThrow()
        await expect(roSess.runQuery('w4b-ro-agg-no-arr', `db.dyn_items.aggregate()`)).rejects.toThrow(/requires an array pipeline/i)
        for (const blocked of [
          `{}`,
          `db.dyn_items.aggregate([{ $out: 'blocked_out' }])`,
          `db.runCommand({ aggregate: 'dyn_items', pipeline: [{ $merge: 'blocked_merge' }], cursor: {} })`,
          `{ explain: { aggregate: 'dyn_items', pipeline: [{ $out: 'x' }] } }`,
          `db.createCollection('blocked_c')`,
          `db.runCommand({ insert: 'dyn_items', documents: [{ a: 1 }] })`,
          `db.adminCommand({ dropDatabase: 1 })`,
        ]) {
          await expect(roSess.runQuery('w4b-ro-block', blocked)).rejects.toThrow(/Read-Only/i)
        }
      } finally {
        await roSess.close()
      }

      // Live aggregate() + cancelQuery closing real AggregationCursor
      await sess.runQuery('w4b-agg-seed', `db.createCollection('agg_heavy'); db.agg_heavy.insertOne({ n: 1 });`)
      const slowAgg = sess
        .runQuery(
          'w4b-slow-agg',
          `db.agg_heavy.aggregate([
            { $project: { a: { $range: [0, 2000] } } },
            { $unwind: '$a' },
            { $lookup: { from: 'agg_heavy', pipeline: [{ $project: { b: { $range: [0, 500] } } }, { $unwind: '$b' }], as: 'joined' } }
          ])`
        )
        .catch((err: unknown) => err)
      await new Promise((r) => setTimeout(r, 25))
      expect((await sess.cancelQuery('w4b-slow-agg')).ok).toBe(true)
      await slowAgg

      await sess.setAutoCommit(false)
      await sess.fetchPage({ table: 'warm_coll', schema: MONGO_DB, page: 1, pageSize: 5 })
      expect(sess.getTransactionState().active).toBe(true)
      await sess.rollbackTransaction()

      const warmPage = await sess.fetchPage({ table: 'warm_coll', schema: MONGO_DB, page: 1, pageSize: 10 })
      const firstRow = warmPage.rows[0] as Record<string, unknown>
      // Roll back first so updateCell hits !autoCommit && activeTxSession === null auto-start path (L2764-2765)
      await sess.rollbackTransaction()
      await sess.updateCell({
        table: 'warm_coll',
        schema: MONGO_DB,
        primaryKeys: { _id: firstRow._id },
        column: 'base',
        originalValue: firstRow.base,
        newValue: 77,
      })
      expect(sess.getTransactionState().active).toBe(true)
      await sess.rollbackTransaction()

      await sess.runQuery('w4b-tx-auto-run', `db.warm_coll.find({ code: 'w1' })`)
      expect(sess.getTransactionState().active).toBe(true)
      await sess.rollbackTransaction()
      await sess.setAutoCommit(true)

      // Live wrapMongoCollection & wrapFindCursor default arg paths (outside multi-doc tx so explain succeeds)
      await sess.runQuery(
        'w4b-wrap-defaults',
        `
        db.warm_coll.find().explain();
        db.warm_coll.find();
        db.warm_coll.findOne();
        db.warm_coll.countDocuments();
        db.warm_coll.distinct('code');
        db.warm_coll.findOneAndUpdate({ code: 'none' }, { $set: { base: 9 } });
        db.warm_coll.findOneAndDelete({ code: 'none' });
        `
      )
    } finally {
      await sess.close()
    }

    // Live beginTransaction() + write + close() invoking wrapMongoSession.inTransaction() & abortTransaction()
    const txCloseSess = await withSession(await driver.createSession(makeMongoProfile()), async (s) => {
      await s.beginTransaction()
      await s.runQuery('w4b-tx-unclosed', `use ${MONGO_DB}; db.warm_coll.insertOne({ code: 'aborted_on_close', base: 1 });`)
    })
    expect(txCloseSess.isAlive()).toBe(false)

    // Mock MongoClientFactory for unreachable/fault paths
    let startTxThrows = true
    let listDbThrows = false
    let findThrows = false
    let indexesThrows = false
    let pingThrows = false
    let commitThrows = false
    let abortThrows = false
    let customErr: unknown = null

    const mockFactory: MongoClientFactory = () => {
      const mockClient: MongoClientLike = {
        connect: async () => ({}),
        close: async () => {},
        startSession: () => ({
          inTransaction: () => true,
          startTransaction: () => {
            if (startTxThrows) {
              throw new Error('mongodb://admin:topSecret@host:27017/db password=rawpw Authorization: Bearer tok12345')
            }
          },
          commitTransaction: async () => {
            if (commitThrows) throw new Error('commit fail')
          },
          abortTransaction: async () => {
            if (abortThrows) throw new Error('abort fail')
          },
          withTransaction: async (fn) => {
            if (customErr) throw customErr
            return await fn()
          },
          endSession: async () => {},
        }),
        db: (dbName = 'mockdb') => ({
          databaseName: dbName,
          admin: () => ({
            listDatabases: async () => {
              if (listDbThrows) throw new Error('listDatabases forbidden')
              return { databases: [{ name: '', sizeOnDisk: undefined, empty: false }, { name: 'otherdb', sizeOnDisk: 1, empty: false }] }
            },
            command: async (cmd) => {
              if (cmd.serverStatus) return { host: 'mock-host', ok: 1 }
              return { ok: 1 }
            },
          }),
          command: async (cmd) => {
            if (cmd.ping && pingThrows) throw { notAnError: true }
            if (cmd.collStats) throw new Error('collStats removed')
            if (cmd.explain) return 'non-plain-explain' as unknown as Record<string, unknown>
            if (cmd.dbStats) return { db: dbName, ok: 1 }
            if (cmd.find) return { cursor: { firstBatch: ['not-obj', { a: 1 }, { a: 2 }] } }
            return { ok: 1 }
          },
          listCollections: () => ({
            toArray: async () => [
              { name: '', type: 'collection' },
              { name: 'system.views', type: 'collection' },
              { name: 'ok_coll', type: 'collection' },
              { name: 'bad_coll', type: 'collection' },
              { name: 'empty_view', type: 'view', options: {} },
              { name: 'untyped_coll', type: undefined as unknown as string },
            ],
          }),
          createCollection: async () => ({}),
          collection: (collName) => ({
            collectionName: collName,
            find: () => {
              const cursor = {
                sort: () => cursor,
                skip: () => cursor,
                limit: () => cursor,
                project: () => cursor,
                toArray: async () => {
                  if (findThrows) throw new Error('find failed')
                  if (collName === 'bad_coll') throw new Error('bad coll')
                  if (collName === 'null_coll') return [null as unknown as Record<string, unknown>, { a: null }]
                  return [{ val: null, _id: '1' }, { _id: '2', val: 'text' }]
                },
                close: async () => {},
              }
              return cursor
            },
            findOne: async (filter?: Record<string, unknown>) => {
              if (filter?._id === 'missing') return null
              if (collName === 'empty_res_coll') return null
              return { _id: 'row-1', val: 1 }
            },
            countDocuments: async () => 1,
            estimatedDocumentCount: async () => 1,
            indexes: async () => {
              if (indexesThrows) throw new Error('indexes failed')
              return [
                { name: '_id_', key: { _id: 1 } },
                { name: 'idx_ttl', key: 'bad-key' as unknown as Record<string, unknown>, expireAfterSeconds: 30 },
                { name: undefined as unknown as string, key: { b: 1 }, unique: true },
                { name: '' },
              ]
            },
            aggregate: (pipeline) => ({
              toArray: async () => {
                if (collName === 'empty_res_coll') return []
                if (Array.isArray(pipeline) && pipeline.some((s) => '$collStats' in s)) {
                  return [{ ns: `${dbName}.${collName}` }]
                }
                return [{ ok: 1 }, { ok: 2 }]
              },
              close: async () => {},
            }),
            distinct: async () => ['x', 'y'],
            insertOne: async (doc) => {
              if (doc.failNow) throw new Error('insert 2 failed')
              if (collName === 'empty_res_coll') return { acknowledged: true }
              return { acknowledged: true, insertedId: doc._id ?? 'ins-1' }
            },
            insertMany: async () =>
              collName === 'empty_res_coll'
                ? { acknowledged: true }
                : { acknowledged: true, insertedCount: 1 },
            updateOne: async (filter) => {
              if (filter._id === 'toctou-upd-zero') return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
              if (collName === 'empty_res_coll') return { acknowledged: true }
              return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
            },
            updateMany: async () =>
              collName === 'empty_res_coll'
                ? { acknowledged: true }
                : { acknowledged: true, matchedCount: 1, modifiedCount: 0 },
            replaceOne: async () =>
              collName === 'empty_res_coll'
                ? { acknowledged: true, matchedCount: 1, modifiedCount: 0 }
                : { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
            deleteOne: async (filter) => {
              if (filter._id === 'toctou-del-zero') return { acknowledged: true, deletedCount: 0 }
              if (collName === 'empty_res_coll') return { acknowledged: true }
              return { acknowledged: true, deletedCount: 1 }
            },
            deleteMany: async () =>
              collName === 'empty_res_coll'
                ? { acknowledged: true }
                : { acknowledged: true, deletedCount: 1 },
            findOneAndUpdate: async () => (collName === 'empty_res_coll' ? null : { _id: '1' }),
            findOneAndDelete: async () => (collName === 'empty_res_coll' ? null : { _id: '1' }),
            createIndex: async () => 'idx',
            dropIndex: async () => ({ ok: 1 }),
            drop: async () => true,
            rename: async () => ({ ok: 1 }),
          }),
        }),
      }
      return mockClient
    }

    const mockDriver = new MongoDriver(mockFactory)
    const ms = await mockDriver.createSession(makeMongoProfile({ database: 'mockdb' }))
    try {
      await expect(ms.beginTransaction()).rejects.toThrow(/\*\*\*/)
      startTxThrows = false

      pingThrows = true
      expect((await ms.test()).ok).toBe(false)
      pingThrows = false

      listDbThrows = true
      expect((await ms.listSchemas()).schemas).toEqual(['mockdb'])
      listDbThrows = false
      expect((await ms.listSchemas()).schemas).toEqual(['mockdb', 'otherdb'])

      findThrows = true
      indexesThrows = true
      const fallbackDetails = await ms.getTableDetails('any_coll')
      expect(fallbackDetails.indexes).toEqual([])
      findThrows = false
      indexesThrows = false

      vi.spyOn(ms, 'getObjectDdl').mockImplementationOnce(async () => 'ok').mockRejectedValueOnce(new Error('ddl boom'))
      try {
        const expRes = await ms.exportSchemaDdl()
        expect(expRes.ddl).toContain('Failed to export')
      } finally {
        vi.restoreAllMocks()
      }

      const fallbackQ = await ms.runQuery(
        'w4b-mock-fallbacks',
        `
        db.stats();
        db.serverStatus();
        db.ok_coll.find({}, { a: 1 }).sort({ a: 1 }).skip(1).limit(2).projection({ a: 1 }).explain('queryPlanner');
        db.ok_coll.find({}).limit(0);
        db.ok_coll.aggregate([]).explain();
        db.ok_coll.stats();
        db.ok_coll.dropIndexes();
        db.ok_coll.updateMany({}, { $set: { a: 1 } });
        db.ok_coll.insertOne({ ok: 1 });
        db.ok_coll.insertMany([{ ok: 1 }]);
        db.ok_coll.findOneAndUpdate({}, { $set: { a: 1 } }, { upsert: false });
        db.ok_coll.findOneAndDelete({}, {});
        db.ok_coll.renameCollection('new_name', { dropTarget: true });
        `,
        0
      )
      expect(fallbackQ.resultSets).toHaveLength(13)

      // fetchPage orderByClause empty / malformed + page=0/pageSize=0 + getDdl empty ddl fallback + getObjectDdl view/index + null_coll & empty_view schema inference
      await ms.getTableDetails('null_coll')
      await ms.getTableDetails('empty_view')
      await ms.fetchPage({ table: 'ok_coll', page: 0, pageSize: 0, sortColumn: 'a' })
      await ms.fetchPage({ table: 'ok_coll', page: 1, pageSize: 5, orderByClause: 'ORDER BY   ' })
      await ms.fetchPage({ table: 'ok_coll', page: 1, pageSize: 5, orderByClause: '"a" ASC, b, , bad$%, ' })
      await ms.fetchPage({ table: 'ok_coll', page: 1, pageSize: 5, orderByClause: '{ a: "bad" }' })
      expect(await ms.getObjectDdl('ok_coll', 'view')).toContain('db.createCollection')
      expect(await ms.getObjectDdl('idx_x', 'index')).toContain('MongoDB index')

      // Extra collection/command branches on empty_res_coll + maxRows=0 & maxRows=1 + shorthand + invalid args
      await ms.runQuery(
        'w4b-empty-res-branches',
        `
        show dbs;
        show collections;
        ok_coll;
        db.runCommand({ find: 'ok_coll' });
        db.empty_res_coll.find(123).skip().limit().toArray();
        db.empty_res_coll.findOne(123, 456);
        db.empty_res_coll.aggregate([], { allowDiskUse: true });
        db.empty_res_coll.countDocuments(123, { limit: 1 });
        db.empty_res_coll.estimatedDocumentCount({ maxTimeMS: 50 });
        db.empty_res_coll.distinct('tag', 123, { maxTimeMS: 50 });
        db.empty_res_coll.stats();
        db.empty_res_coll.insertOne({ a: 1 }, { bypassDocumentValidation: true });
        db.empty_res_coll.insertMany([{ a: 1 }], { ordered: false });
        db.empty_res_coll.updateOne({}, { $set: { a: 1 } }, { upsert: true });
        db.empty_res_coll.replaceOne({}, { a: 2 }, { upsert: true });
        db.empty_res_coll.deleteOne(123, { hint: {} });
        db.empty_res_coll.deleteMany(123, { hint: {} });
        db.empty_res_coll.findOneAndUpdate({}, { $set: { a: 1 } });
        db.empty_res_coll.findOneAndDelete(123);
        db.empty_res_coll.createIndex({ a: 1 }, { unique: true });
        db.empty_res_coll.createIndex({ a: 1 }, 'bad_opts');
        db.empty_res_coll.updateMany({}, { $set: { a: 1 } });
        db.ok_coll.findOne({}, { _id: 1 });
        db.empty_res_coll.dropIndex('idx', { maxTimeMS: 10 });
        `,
        0
      )
      await ms.runQuery(
        'w4b-trunc-1',
        `
        ok_coll;
        db.ok_coll.find({});
        db.ok_coll.aggregate([]);
        db.ok_coll.distinct('tag');
        db.runCommand({ find: 'ok_coll' });
        `,
        1
      )
      await ms.listObjects('mockdb')
      await ms.getObjectDdl('ok_coll', 'table', 'mockdb')
      await ms.beginTransaction()
      await ms.runQuery('w4b-create-coll-tx', `db.createCollection('tx_coll', { capped: true })`)
      await ms.rollbackTransaction()
      await expect(ms.runQuery('w4b-bad-rename', `db.ok_coll.renameCollection('   ')`)).rejects.toThrow()
      await expect(ms.runQuery('w4b-bad-rename-num', `db.ok_coll.renameCollection(123)`)).rejects.toThrow()
      await expect(ms.runQuery('w4b-undef-q', undefined as unknown as string)).rejects.toThrow()
      const errNoDriver = new DatabaseDriverError('password=abc', 'E_NODRV', undefined as unknown as 'mongodb')
      customErr = errNoDriver
      await expect(ms.applyChanges({ table: 'ok_coll', inserts: [{ _id: 'a' }] })).rejects.toThrow(/\*\*\*/)
      customErr = null
      await ms.updateCell({
        table: 'ok_coll',
        primaryKeys: { _id: '0123456789abcdef01234567' },
        column: '_id',
        columnType: 'String',
        originalValue: '0123456789abcdef01234567',
        newValue: 'plain_id',
      })
      for (const extraCell of [
        { column: 'a', originalValue: undefined as unknown, newValue: 1 },
        { column: 'b', columnType: 'Double', originalValue: 1, newValue: 2 },
        { column: 'c', originalValue: '[BLOB 12 B]', newValue: 'x' },
        { column: 'd', originalValue: null as unknown, newValue: 'y' },
      ]) {
        await ms.updateCell({
          table: 'ok_coll',
          primaryKeys: { _id: '1' },
          ...extraCell,
        })
      }
      await ms.applyChanges({
        table: 'ok_coll',
        inserts: [{ a: 1, skipUndef: undefined }],
        updates: [{ primaryKeys: { _id: '1' }, changes: { skipUndef: undefined } }],
      })
      await expect(ms.applyChanges({ table: 'empty_res_coll', deletes: [{ _id: '1' }] })).rejects.toThrow()
      await expect(
        ms.applyChanges({ table: 'empty_res_coll', updates: [{ primaryKeys: { _id: '1' }, changes: { a: 2 } }] })
      ).rejects.toThrow()
      await expect(
        ms.updateCell({ table: 'empty_res_coll', primaryKeys: { _id: '1' }, column: 'a', originalValue: 1, newValue: 2 })
      ).rejects.toThrow()
      await expect(
        ms.updateCell({
          table: 'ok_coll',
          primaryKeys: undefined as unknown as Record<string, unknown>,
          column: 'a',
          originalValue: 1,
          newValue: 2,
        })
      ).rejects.toThrow(/Primary key/i)
      vi.spyOn(ms, 'getTableDetails').mockResolvedValueOnce({
        name: 'ok_coll',
        schema: 'mockdb',
        kind: 'table',
        columns: [],
        primaryKey: [],
        indexes: [],
        foreignKeys: [],
        ddl: '',
      })
      try {
        expect(await ms.getDdl('ok_coll')).toContain('// MongoDB Collection: mockdb.ok_coll')
      } finally {
        vi.restoreAllMocks()
      }

      const multiCancelQ = ms.runQuery('w4b-mid-cancel', 'db.ok_coll.find({}); db.ok_coll.find({});').catch((e) => e)
      await ms.cancelQuery('w4b-mid-cancel')
      await multiCancelQ

      startTxThrows = false
      await ms.beginTransaction()
      commitThrows = true
      await expect(ms.commitTransaction()).rejects.toThrow(/commit fail/i)
      commitThrows = false

      await ms.beginTransaction()
      abortThrows = true
      await expect(ms.rollbackTransaction()).rejects.toThrow(/abort fail/i)
      abortThrows = false

      const errWithSecret = new DatabaseDriverError(
        'failed at mongodb:\\/\\/user:secret@host\\/db?token=Bearer secretTok123&other=Bearer keepMe password=[REDACTED] password=plainPw',
        'E_TEST',
        'mongodb'
      )
      customErr = errWithSecret
      await expect(ms.applyChanges({ table: 'ok_coll', inserts: [{ _id: 'a' }] })).rejects.toThrow(/\*\*\*/)

      const errPlain = new DatabaseDriverError('clean message', 'E_PLAIN', 'mongodb')
      customErr = errPlain
      await expect(ms.applyChanges({ table: 'ok_coll', inserts: [{ _id: 'a' }] })).rejects.toThrow('clean message')

      // Active cursor closed on session.close() -> L2192-2195
      const sCursorClose = await new MongoDriver(() => {
        const c: MongoClientLike = {
          connect: async () => ({}),
          close: async () => {},
          startSession: () => ({
            inTransaction: () => false,
            startTransaction: () => {},
            commitTransaction: async () => {},
            abortTransaction: async () => {},
            withTransaction: async (fn) => fn(),
            endSession: async () => {},
          }),
          db: () => ({
            databaseName: 'mockdb',
            admin: () => ({ listDatabases: async () => ({ databases: [] }), command: async () => ({}) }),
            command: async () => ({}),
            listCollections: () => ({ toArray: async () => [] }),
            createCollection: async () => ({}),
            collection: () => ({
              collectionName: 'c',
              find: () => {
                let rejectToArray!: (err: Error) => void
                const cur = {
                  sort: () => cur,
                  skip: () => cur,
                  limit: () => cur,
                  project: () => cur,
                  toArray: () =>
                    new Promise<Record<string, unknown>[]>((_res, rej) => {
                      rejectToArray = rej
                    }),
                  close: async () => {
                    rejectToArray?.(new Error('cursor closed'))
                  },
                }
                return cur
              },
              findOne: async () => null,
              countDocuments: async () => 0,
              estimatedDocumentCount: async () => 0,
              indexes: async () => [],
              aggregate: () => ({ toArray: async () => [], close: async () => {} }),
              distinct: async () => [],
              insertOne: async () => ({}),
              insertMany: async () => ({}),
              updateOne: async () => ({}),
              updateMany: async () => ({}),
              replaceOne: async () => ({}),
              deleteOne: async () => ({}),
              deleteMany: async () => ({}),
              findOneAndUpdate: async () => null,
              findOneAndDelete: async () => null,
              createIndex: async () => 'i',
              dropIndex: async () => ({}),
              drop: async () => true,
              rename: async () => ({}),
            }),
          }),
        }
        return c
      }).createSession(makeMongoProfile({ database: 'mockdb' }))
      const hungFindP = sCursorClose.runQuery('q-hung-cur', 'db.c.find({})').catch((e) => e)
      try {
        await new Promise((r) => setTimeout(r, 15))
      } finally {
        await sCursorClose.close()
      }
      await hungFindP

      // executePlanMutations conflicts inside active tx -> L2949-2954, L2963-2968
      await ms.beginTransaction()
      await expect(ms.applyChanges({ table: 'ok_coll', deletes: [{ _id: 'toctou-del-zero' }] })).rejects.toMatchObject({ code: 'conflict' })
      await expect(
        ms.applyChanges({ table: 'ok_coll', updates: [{ primaryKeys: { _id: 'toctou-upd-zero' }, changes: { v: 1 } }] })
      ).rejects.toMatchObject({ code: 'conflict' })
      await ms.rollbackTransaction()

      // isStandaloneTransactionUnsupported via errmsg on plain object
      customErr = { errmsg: 'Transaction numbers are only allowed on a replica set' }
      await expect(ms.applyChanges({ table: 'ok_coll', deletes: [{ _id: 'missing' }] })).rejects.toMatchObject({ code: 'conflict' })

      customErr = { errorResponse: { code: 263, errmsg: 'cannot use tx' } }
      await expect(ms.applyChanges({ table: 'ok_coll', deletes: [{ _id: 'missing' }] })).rejects.toMatchObject({ code: 'conflict' })
      await expect(
        ms.applyChanges({ table: 'ok_coll', updates: [{ primaryKeys: { _id: 'missing' }, changes: { v: 1 } }] })
      ).rejects.toMatchObject({ code: 'conflict' })

      customErr = { cause: 'Sessions are not supported here' }
      await expect(ms.applyChanges({ table: 'ok_coll', deletes: [{ _id: 'toctou-del-zero' }] })).rejects.toMatchObject({ code: 'conflict' })
      await expect(
        ms.applyChanges({ table: 'ok_coll', updates: [{ primaryKeys: { _id: 'toctou-upd-zero' }, changes: { v: 1 } }] })
      ).rejects.toMatchObject({ code: 'conflict' })

      await expect(
        ms.applyChanges({
          table: 'ok_coll',
          inserts: [{ _id: 'first-ok' }, { _id: 'second-fail', failNow: true }],
        })
      ).rejects.toThrow(/insert 2 failed/i)
      customErr = null

      await ms.applyChanges({
        table: 'ok_coll',
        columnTypes: {
          _id: 'UUID',
          decCol: 'Decimal128',
          lngCol: 'Long',
          intCol: 'Int32',
          dblCol: 'Double',
          boolCol: 'Boolean',
          dtCol: 'Date',
          uidCol: 'UUID',
          objCol: 'Object',
          arrCol: 'Array',
        },
        updates: [
          {
            primaryKeys: { _id: '11111111-2222-4333-8444-555555555555' },
            changes: {
              decCol: 'bad-decimal',
              lngCol: '99999999999999999999999999999999999',
              intCol: 'bad-int',
              dblCol: 'bad-dbl',
              boolCol: 'maybe',
              dtCol: 'not-a-date',
              uidCol: 'not-a-uuid',
              objCol: '{bad',
              arrCol: '[bad',
              ejsonCol: 'x',
              plainCol: 'y',
              nonPlainObj: 'z',
              customCol: 'v',
            },
            originalRow: {
              decCol: 'not-dec',
              lngCol: '99999999999999999999999999999999999',
              uidCol: 'not-uuid',
              ejsonCol: { $date: '2025-01-01T00:00:00Z' },
              plainCol: { nested: 1 },
              nonPlainObj: new Map([['a', 1]]),
            },
          },
          {
            primaryKeys: {
              _id: '0123456789abcdef01234567',
              dtPk: '2025-01-01T00:00:00Z',
              decPk: '12.50',
              lngPk: '9007199254740993',
            },
            changes: {
              decCol: 12.5,
              lngCol: 99,
              intCol: '42',
              dtCol: '2025-01-01T00:00:00Z',
              uidCol: '11111111-2222-4333-8444-555555555555',
              lngBigCol: 42n,
              boolCol: 'false',
            },
            originalRow: {
              decCol: 12.5,
              lngCol: 99,
              intCol: '42',
              dtCol: '2025-01-01T00:00:00Z',
              uidCol: '11111111-2222-4333-8444-555555555555',
              lngBigCol: 42n,
              _id: '0123456789abcdef01234567',
            },
          },
        ],
        inserts: [{ lngBig: 42n, decNum: 12.5, rawNull: null }],
      })
      // Duplicate field across pkFilter + optLock (combineFilters) + column in readbackPk
      await ms.updateCell({
        table: 'ok_coll',
        primaryKeys: { _id: '0123456789abcdef01234567' },
        column: '_id',
        columnType: 'ObjectId',
        originalValue: '0123456789abcdef01234567',
        newValue: 'fedcba9876543210fedcba98',
      })
      // Valid Decimal128/Date/Long/Int32/UUID in buildPkFilter & buildOptimisticPredicate
      await ms.applyChanges({
        table: 'ok_coll',
        columnTypes: {
          decCol: 'Decimal128',
          lngCol: 'Long',
          intCol: 'Int32',
          dtCol: 'Date',
          uidCol: 'UUID',
          lngBigCol: 'Long',
          customCol: 'GeoPoint',
        },
        updates: [
          {
            primaryKeys: { decCol: '12.34', lngCol: '12345', dtCol: '2025-01-01T00:00:00Z' },
            changes: { decCol: '56.78', lngCol: '12345', intCol: '7', dtCol: '2025-01-01T00:00:00Z', lngBigCol: 77n, customCol: 'pt' },
            originalRow: { decCol: '12.34', lngCol: '12345', intCol: '7', dtCol: '2025-01-01T00:00:00Z', lngBigCol: 77n },
          },
        ],
      })
      await expect(
        ms.updateCell({ table: 'ok_coll', primaryKeys: { _id: '1' }, column: '', originalValue: 1, newValue: 2 })
      ).rejects.toThrow(/Field path/i)
      await expect(
        ms.updateCell({
          table: 'ok_coll',
          primaryKeys: { _id: '1' },
          column: 'a.__proto__.b',
          originalValue: 1,
          newValue: 2,
        })
      ).rejects.toThrow(/Disallowed field path/i)
      await expect(
        ms.updateCell({ table: 'ok_coll', primaryKeys: {}, column: 'a', originalValue: 1, newValue: 2 })
      ).rejects.toThrow(/Primary key/i)
    } finally {
      await ms.close()
      expect((await ms.test()).ok).toBe(false)
    }
  }, 20_000)

  it('closes Postgres & CockroachDB live transaction/savepoint/cancel paths and Pool/PoolClient race & Supabase fallback branches', async () => {
    // 1) PBT on formatPostgresError invariants
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.constant(null), fc.constant(undefined), fc.integer()), (errVal) => {
        const msgPg = formatPostgresError(errVal, 'postgres', makePgProfile())
        const msgCrdb = formatPostgresError(errVal, 'cockroachdb', makeCrdbProfile())
        expect(typeof msgPg).toBe('string')
        expect(msgPg.length).toBeGreaterThan(0)
        expect(typeof msgCrdb).toBe('string')
        expect(msgCrdb.length).toBeGreaterThan(0)
      }),
      { numRuns: 30 }
    )

    // 2) Live Postgres 16 (cov_pg_w4b) & CockroachDB (cov_crdb_w4b)
    const pgDriver = new PostgresDriver()
    // Test default host/port/db fallback session close without dialing invalid db
    await withSession(
      await pgDriver.createSession(
        makePgProfile({ host: '', port: undefined, database: undefined, options: '   ' }),
        PG_PASS
      )
    )

    await withSession(
      await pgDriver.createSession(
        makePgProfile({ readOnly: true, options: '-c default_transaction_read_only=on' }),
        PG_PASS
      ),
      async (livePg) => {
        expect((await livePg.test()).ok).toBe(true)
      }
    )

    const sess = (await pgDriver.createSession(makePgProfile(), PG_PASS)) as PostgresSession
    try {
      await sess.runQuery(
        'w4b-pg-ddl',
        `
        CREATE DOMAIN ${PG_SCHEMA}.pos_int AS INTEGER CHECK (VALUE > 0);
        CREATE TABLE ${PG_SCHEMA}.items (
          id INTEGER PRIMARY KEY,
          qty ${PG_SCHEMA}.pos_int NOT NULL,
          note TEXT
        );
        INSERT INTO ${PG_SCHEMA}.items (id, qty, note) VALUES (1, 5, 'ok');
        `
      )

      // Custom domain OID -> hits fallback String(f.dataTypeID) and maxRows = 0
      const domainQ = await sess.runQuery('w4b-pg-domain', `SELECT id, qty FROM ${PG_SCHEMA}.items;`, 0)
      expect(domainQ.rowCount).toBe(1)

      // Live beginTransaction -> fetchPage SQL error -> txAborted -> rollbackTransaction
      await sess.beginTransaction()
      await expect(
        sess.fetchPage({ table: 'items', schema: PG_SCHEMA, page: 1, pageSize: 5, whereClause: 'nonexistent_col = 1' })
      ).rejects.toThrow()
      expect(sess.getTransactionState().aborted).toBe(true)
      await sess.rollbackTransaction()

      // Live beginTransaction -> updateCell constraint failure -> txAborted -> rollbackTransaction
      await sess.beginTransaction()
      await expect(
        sess.updateCell({
          table: 'items',
          schema: PG_SCHEMA,
          column: 'qty',
          newValue: -10,
          primaryKeys: { id: 1 },
          originalValue: 5,
        })
      ).rejects.toThrow()
      expect(sess.getTransactionState().aborted).toBe(true)
      await sess.rollbackTransaction()

      // Live beginTransaction -> applyChanges constraint failure -> ROLLBACK TO SAVEPOINT keeps tx alive!
      await sess.beginTransaction()
      await expect(
        sess.applyChanges({
          table: 'items',
          schema: PG_SCHEMA,
          inserts: [{ id: 2, qty: -99, note: 'bad' }],
        })
      ).rejects.toThrow()
      await sess.applyChanges({
        table: 'items',
        schema: PG_SCHEMA,
        inserts: [{ id: 2, qty: 10, note: 'recovered' }],
      })
      await sess.commitTransaction()
      expect((await sess.runQuery('w4b-pg-chk', `SELECT id FROM ${PG_SCHEMA}.items WHERE id = 2;`)).rowCount).toBe(1)

      // Live cancelQuery during pg_sleep
      const sleepQ = sess.runQuery('w4b-pg-sleep', 'SELECT pg_sleep(5);').catch((e) => e)
      await new Promise((r) => setTimeout(r, 60))
      expect((await sess.cancelQuery('w4b-pg-sleep')).ok).toBe(true)
      await sleepQ
    } finally {
      await sess.close()
    }

    // Live CRDB cov_crdb_w4b verification
    const crdbSess = (await pgDriver.createSession(makeCrdbProfile())) as PostgresSession
    try {
      await crdbSess.runQuery(
        'w4b-crdb-init',
        `CREATE TABLE ${CRDB_SCHEMA}.kv (k INT PRIMARY KEY, v STRING NOT NULL CHECK (length(v) > 0));
         INSERT INTO ${CRDB_SCHEMA}.kv VALUES (1, 'one');`
      )
      await crdbSess.beginTransaction()
      await expect(
        crdbSess.applyChanges({ table: 'kv', schema: CRDB_SCHEMA, inserts: [{ k: 2, v: '' }] })
      ).rejects.toThrow()
      await crdbSess.rollbackTransaction()
    } finally {
      await crdbSess.close()
    }

    // 3) Mock Pool / PoolClient for closeWaiters, activeBatches, error/destroy guards, _txStatus auto-ROLLBACK, and Supabase races
    try {
      // 3a) lease.release catch, parsePgQueryResult edge shapes, extractErrorCode/Message edge shapes, detach error, _txStatus 'T'/'E' auto-ROLLBACK
      class MockPgClient extends EventEmitter {
        processID = 777
        _txStatus: string | null = 'I'
        release = vi.fn(() => {
          throw new Error('release boom')
        })
        query = vi.fn(async (sqlOrCfg: string | { text?: string }) => {
          const text = typeof sqlOrCfg === 'string' ? sqlOrCfg : sqlOrCfg?.text || ''
          if (text.includes('SELECT_OBJ_ROWS')) {
            this._txStatus = 'T'
            return {
              fields: [
                { name: 'a', dataTypeID: 888888, tableID: 111 },
                { name: 'b', dataTypeID: 25, tableID: 222 },
              ],
              rows: [{ a: 1, b: 'hi' }],
              rowCount: 1,
            }
          }
          if (text.includes('SELECT_NO_FIELDS')) {
            this._txStatus = 'E'
            return { fields: undefined, rows: undefined, rowCount: undefined }
          }
          if (text.includes('SELECT_TX_E_OID')) {
            this._txStatus = 'E'
            return { fields: [{ name: 'x', dataTypeID: 23, tableID: 555 }], rows: [[1]], rowCount: 1 }
          }
          if (text.includes('SELECT_ONE_OID_ERR')) {
            this._txStatus = 'I'
            return { fields: [{ name: 'x', dataTypeID: 23, tableID: 555 }], rows: [[1]], rowCount: 1 }
          }
          if (text.includes('pg_class')) {
            throw new Error('catalog failed')
          }
          if (text === 'ROLLBACK' && this._txStatus === 'E') {
            throw new Error('rollback failed')
          }
          return { rows: [], fields: [], rowCount: 0 }
        })
      }

      const client1 = new MockPgClient()
      // Make removeListener throw once on detachTxClientErrorHandler to hit L407
      const origRemove = client1.removeListener.bind(client1)
      let throwOnDetach = false
      client1.removeListener = ((ev: string, fn: (...args: unknown[]) => void) => {
        if (throwOnDetach) {
          throwOnDetach = false
          throw new Error('detach failed')
        }
        return origRemove(ev, fn)
      }) as typeof client1.removeListener

      const mockPool1 = {
        connect: vi.fn(async () => client1),
        query: vi.fn(async (sql: string) => {
          if (sql.includes('pg_cancel_backend')) return { rows: [{ pg_cancel_backend: true }] }
          return { rows: [], fields: [], rowCount: 0 }
        }),
        end: vi.fn(async () => {}),
      }

      const s1 = new PostgresSession(mockPool1 as unknown as Pool, makePgProfile())
      try {
        expect(formatPostgresError({ message: null }, 'postgres')).toContain('PostgreSQL')
        // sendCancelBackend without activeConfig succeeding -> L540
        expect(await (s1 as unknown as { sendCancelBackend(pid: number): Promise<boolean> }).sendCancelBackend(777)).toBe(true)

        // Auto-ROLLBACK when _txStatus = 'T' on non-BEGIN query, and catch when _txStatus = 'E' & ROLLBACK fails
        const objRes = await s1.runQuery('q-obj', 'SELECT_OBJ_ROWS', 0)
        expect(objRes.rows[0]).toEqual([1, 'hi'])
        await s1.runQuery('q-nofield', 'SELECT_NO_FIELDS')
        await s1.runQuery('q-tx-e', 'SELECT_TX_E_OID')
        await s1.runQuery('q-one-oid-err', 'SELECT_ONE_OID_ERR')

        // Broken txClient + detach throw
        await s1.beginTransaction()
        throwOnDetach = true
        client1.emit('error', new Error('socket dead'))
        await s1.runQuery('q-after-broken', 'SELECT 1')
        throwOnDetach = false

        // Pinned query emits error while running -> catch & finally destroy
        await s1.beginTransaction()
        client1.query.mockImplementationOnce(async () => {
          client1.emit('error', new Error('mid query error'))
          throw new Error('query aborted')
        })
        await expect(s1.runQuery('q-pin-err', 'SELECT 1')).rejects.toThrow(/query aborted/i)

        // Pinned query cancelled via cancelQuery while resolving cleanly -> finally destroy
        await s1.beginTransaction()
        let resolvePin!: () => void
        client1.query.mockImplementationOnce(
          () =>
            new Promise((res) => {
              resolvePin = () => res({ rows: [], fields: [], rowCount: 0 })
            })
        )
        const pinCancelP = s1.runQuery('q-pin-cancel', 'SELECT 1')
        await new Promise((r) => setTimeout(r, 15))
        await s1.cancelQuery('q-pin-cancel')
        resolvePin()
        await pinCancelP

        // Pinned applyChanges where ROLLBACK TO SAVEPOINT fails with PgSqlStateError
        await s1.beginTransaction()
        client1.query
          .mockResolvedValueOnce({ rows: [], fields: [], rowCount: 0 }) // SAVEPOINT
          .mockRejectedValueOnce(Object.assign(new Error('insert err'), { code: '23505' }))
          .mockRejectedValueOnce(Object.assign(new Error('savepoint gone'), { code: '25P02' }))
        await expect(s1.applyChanges({ table: 't', inserts: [{ id: 1 }] })).rejects.toThrow(/insert err/)
        expect(s1.getTransactionState().aborted).toBe(true)

        // Close while pinned tx ROLLBACK fails -> hits L630
        client1._txStatus = 'E'
      } finally {
        await s1.close()
      }

      // Postgres undefined-schema, processID-less client, error code null, and Supabase user-with-dot + tlsServername branches
      const noPidClient = {
        query: vi.fn(async () => ({ fields: [{ name: 'a', dataTypeID: 23 }], rows: undefined, rowCount: undefined })),
        release: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
      }
      await withSession(
        new PostgresSession(
          {
            connect: async () => noPidClient,
            query: vi.fn(async (sql: string) => {
              if (sql.includes('pg_get_viewdef')) return { rows: [{ ddl: 'SELECT 1' }], fields: [], rowCount: 1 }
              return { rows: [], fields: [], rowCount: 0 }
            }),
            end: vi.fn(async () => {}),
          } as unknown as Pool,
          makePgProfile({ driver: 'postgres' })
        ),
        async (sPgNoPid) => {
          await sPgNoPid.runQuery('q-nopid', 'SELECT 1')
          expect(await sPgNoPid.getObjectDdl('v', 'view')).toContain('SELECT 1')
          await sPgNoPid.exportSchemaDdl()
          await sPgNoPid.getTableDetails('t').catch(() => {})
          await sPgNoPid.previewChanges({ table: 't', inserts: [{ id: 1 }] })
          await sPgNoPid.getDdl('t').catch(() => {})
          // autoCommit fetchPage empty count rows -> L839
          await sPgNoPid.fetchPage({ table: 't', page: 1, pageSize: 5 }).catch(() => {})
          // Non-string schema_name / table_name and undefined rows in resolveSourceTableFromFields -> L981-984
          noPidClient.query = vi
            .fn()
            .mockResolvedValueOnce({ fields: [{ name: 'a', dataTypeID: 23, tableID: 123 }], rows: [[1]], rowCount: 1 })
            .mockResolvedValueOnce({ rows: undefined, fields: [], rowCount: 0 })
          await sPgNoPid.runQuery('q-oid-undef', 'SELECT 1')
          noPidClient.query = vi
            .fn()
            .mockResolvedValueOnce({ fields: [{ name: 'a', dataTypeID: 23, tableID: 124 }], rows: [[1]], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ schema_name: 1, table_name: 2 }], fields: [], rowCount: 1 })
            .mockResolvedValueOnce({ fields: [], rows: [[1]], rowCount: 1 })
          await sPgNoPid.runQuery('q-oid-nonstr', 'SELECT 1')
          await sPgNoPid.runQuery('q-empty-fields', 'SELECT 1')
          // Undefined rowCount on updateCell (autoCommit & pinned) + applyChanges (autoCommit & pinned)
          noPidClient.query = vi.fn(async () => ({ rows: [], fields: [], rowCount: undefined }))
          await expect(
            sPgNoPid.updateCell({ table: 't', column: 'c', newValue: 'x', primaryKeys: { id: 1 }, originalValue: 'y' })
          ).rejects.toMatchObject({ code: 'conflict' })
          await sPgNoPid.applyChanges({ table: 't', inserts: [{ id: 1 }] })
          await expect(sPgNoPid.applyChanges({ table: 't', deletes: [{ id: 1 }] })).rejects.toMatchObject({ code: 'conflict' })
          await expect(
            sPgNoPid.applyChanges({ table: 't', updates: [{ primaryKeys: { id: 1 }, changes: { c: 'x' } }] })
          ).rejects.toMatchObject({ code: 'conflict' })
          await sPgNoPid.beginTransaction()
          await expect(
            sPgNoPid.updateCell({ table: 't', column: 'c', newValue: 'x', primaryKeys: { id: 1 }, originalValue: 'y' })
          ).rejects.toMatchObject({ code: 'conflict' })
          await sPgNoPid.applyChanges({ table: 't', inserts: [{ id: 1 }] })
          await expect(sPgNoPid.applyChanges({ table: 't', deletes: [{ id: 1 }] })).rejects.toMatchObject({ code: 'conflict' })
          await expect(
            sPgNoPid.applyChanges({ table: 't', updates: [{ primaryKeys: { id: 1 }, changes: { c: 'x' } }] })
          ).rejects.toMatchObject({ code: 'conflict' })
          // pinned listSchemas with undefined rows in txExecutor (L763) + fetchPage with undefined/empty count rows -> L839
          await sPgNoPid.listSchemas()
          noPidClient.query = vi.fn(async (sqlOrCfg: string | { text?: string }) => {
            const txt = typeof sqlOrCfg === 'string' ? sqlOrCfg : sqlOrCfg?.text || ''
            if (txt.includes('COUNT(*)')) return { rows: [], fields: [], rowCount: 0 }
            return { rows: undefined as unknown as Record<string, unknown>[], fields: [], rowCount: 0 }
          })
          await sPgNoPid.fetchPage({ table: 't', page: 1, pageSize: 5 }).catch(() => {})
        }
      )
      expect(formatPostgresError({ message: 42, code: null }, 'postgres')).toBe('42')
      expect(formatPostgresError({ message: 'err', code: undefined }, 'postgres')).toBe('err')
      expect(formatPostgresError({ code: undefined }, 'postgres')).toContain('PostgreSQL')
      expect((await resolveSupabasePoolerConfig('db.proj123.supabase.co', { host: 'db.proj123.supabase.co', user: 'u.proj123' })).user).toBe('u.proj123')
      // mapSupabaseIpv6ToRegion undefined + createSession readOnly with rawOptions + defaults for postgres/crdb
      const { mapSupabaseIpv6ToRegion } = await import('../src/drivers/postgres/driver')
      expect(mapSupabaseIpv6ToRegion(undefined as unknown as string)).toBe('ap-southeast-1')
      await withSession(
        await pgDriver.createSession(
          makePgProfile({ readOnly: true, options: '-c application_name=w4b', port: undefined, database: undefined }),
          PG_PASS
        )
      )
      await withSession(await pgDriver.createSession(makeCrdbProfile({ port: undefined, database: undefined })))
      await withSession(
        await pgDriver.createSession(makePgProfile({ sslMode: 'verify-full' }), PG_PASS, { tlsServername: 'pg.remote.example' })
      )

      // 3b) sendCancelBackend with unreachable activeConfig -> catches & returns false (L533)
      await withSession(
        new PostgresSession(
          mockPool1 as unknown as Pool,
          makePgProfile(),
          { host: '127.0.0.1', port: 59996, connectionTimeoutMillis: 80 }
        ),
        async (sDeadCancel) => {
          expect(await (sDeadCancel as unknown as { sendCancelBackend(pid: number): Promise<boolean> }).sendCancelBackend(999)).toBe(false)
        }
      )

      // 3c) test() failing inside SELECT 1 (L569-570), exportSchemaDdl non-catalog error rethrow (L710), queryExecutor isClosed (L504-505)
      const failClient = new MockPgClient()
      failClient.release = vi.fn()
      failClient.query = vi.fn(async (sqlOrCfg: string | { text?: string }) => {
        const text = typeof sqlOrCfg === 'string' ? sqlOrCfg : sqlOrCfg?.text || ''
        if (text.includes('SELECT 1')) throw new Error('select 1 boom')
        if (text.startsWith('INSERT')) throw new Error('insert boom')
        if (text.includes('ROLLBACK')) throw new Error('rb fail')
        return { rows: [], fields: [], rowCount: 0 }
      })
      const failPool = {
        connect: vi.fn(async () => failClient),
        query: vi.fn(async (sql: string) => {
          if (sql.includes('pg_depend')) throw Object.assign(new Error('fatal catalog err'), { code: '08000' })
          return { rows: [{ oid: 1, name: 't1', schema: 'public', kind: 'table', detail: null }] }
        }),
        end: vi.fn(async () => {}),
      }
      await withSession(new PostgresSession(failPool as unknown as Pool, makePgProfile()), async (sFail) => {
        expect((await sFail.test()).message).toContain('select 1 boom')
        await expect(sFail.exportSchemaDdl('public')).rejects.toThrow(/fatal catalog err/)
        // autoCommit applyChanges rollback failure (L1185-1186)
        await expect(sFail.applyChanges({ table: 't1', inserts: [{ id: 1 }] })).rejects.toThrow()
      })

      // queryExecutor isClosed during exportSchemaDdl
      const raceExpPool = {
        query: vi.fn(async () => {
          await sRaceExp.close()
          return { rows: [{ oid: 1, name: 't1', schema: 'public', kind: 'table', detail: null }] }
        }),
        end: vi.fn(async () => {}),
      }
      const sRaceExp = new PostgresSession(raceExpPool as unknown as Pool, makePgProfile())
      await expect(sRaceExp.exportSchemaDdl('public')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })

      // 3d) Close during activeBatches (!commitSent) & multi-statement cancel & BEGIN failure & queued txOps
      let activeBatchClient!: MockPgClient
      const batchPool = {
        connect: vi.fn(async () => {
          activeBatchClient = new MockPgClient()
          activeBatchClient.release = vi.fn()
          return activeBatchClient
        }),
        query: vi.fn(async () => ({ rows: [], fields: [], rowCount: 0 })),
        end: vi.fn(async () => {}),
      }
      const sBatchClose = new PostgresSession(batchPool as unknown as Pool, makePgProfile())
      let releaseInsert!: () => void
      const batchPromise = (async () => {
        await new Promise((r) => setTimeout(r, 0))
        return sBatchClose.applyChanges({ table: 't', inserts: [{ id: 1 }] })
      })()
      batchPool.connect.mockImplementationOnce(async () => {
        activeBatchClient = new MockPgClient()
        activeBatchClient.release = vi.fn()
        activeBatchClient.query = vi.fn(async (sqlOrCfg: string | { text?: string }) => {
          const text = typeof sqlOrCfg === 'string' ? sqlOrCfg : sqlOrCfg?.text || ''
          if (text.startsWith('INSERT')) {
            await new Promise<void>((res) => {
              releaseInsert = res
            })
          }
          return { rows: [], fields: [], rowCount: 1 }
        })
        return activeBatchClient
      })
      const batchRes = batchPromise.catch((e) => e)
      await new Promise((r) => setTimeout(r, 25))
      await sBatchClose.close()
      releaseInsert?.()
      await batchRes

      // Close while COMMIT is in-flight so batchEntry.commitSent === true (L1177)
      const sCommitClose = new PostgresSession(batchPool as unknown as Pool, makePgProfile())
      let releaseCommit!: () => void
      batchPool.connect.mockImplementationOnce(async () => {
        const c = new MockPgClient()
        c.release = vi.fn()
        c.query = vi.fn(async (sqlOrCfg: string | { text?: string }) => {
          const text = typeof sqlOrCfg === 'string' ? sqlOrCfg : sqlOrCfg?.text || ''
          if (text.trim().startsWith('COMMIT')) {
            await new Promise<void>((res) => {
              releaseCommit = res
            })
          }
          return { rows: [], fields: [], rowCount: 1 }
        })
        return c
      })
      const commitClosePromise = sCommitClose.applyChanges({ table: 't', inserts: [{ id: 1 }] }).catch((e) => e)
      await new Promise((r) => setTimeout(r, 25))
      await sCommitClose.close()
      releaseCommit?.()
      await commitClosePromise

      // Multi-stmt runQuery cancelled mid-script -> L1254-1256
      const sRunRaces = new PostgresSession(batchPool as unknown as Pool, makePgProfile(), { host: '127.0.0.1', port: 59996 })
      let releaseStmt1!: () => void
      batchPool.connect.mockImplementationOnce(async () => {
        const c = new MockPgClient()
        c.release = vi.fn()
        c.query = vi.fn(
          () =>
            new Promise((res) => {
              releaseStmt1 = () => res({ rows: [], fields: [], rowCount: 0 })
            })
        )
        return c
      })
      const multiQ = sRunRaces.runQuery('q-multi-cancel', 'SELECT 1; SELECT 2;').catch((e) => e)
      await new Promise((r) => setTimeout(r, 15))
      await sRunRaces.cancelQuery('q-multi-cancel')
      releaseStmt1()
      await multiQ

      // runQuery close microtask races after acquireLease (L1232-1234) and after client.query (L1270-1272)
      const sPgRunAcqRace = new PostgresSession(
        {
          connect: () =>
            new Promise((res) => {
              setTimeout(() => {
                res(new MockPgClient())
                Promise.resolve().then(() => void sPgRunAcqRace.close())
              }, 0)
            }),
          query: vi.fn(async () => ({ rows: [], fields: [], rowCount: 0 })),
          end: vi.fn(async () => {}),
        } as unknown as Pool,
        makePgProfile()
      )
      await expect(sPgRunAcqRace.runQuery('q-acq-r', 'SELECT 1')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })

      const sPgRunAfterQ = new PostgresSession(
        {
          connect: async () => {
            const c = new MockPgClient()
            c.release = vi.fn()
            c.query = vi.fn(
              () =>
                new Promise((res) => {
                  setTimeout(() => {
                    void sPgRunAfterQ.close()
                    res({ rows: [], fields: [], rowCount: 0 })
                  }, 0)
                })
            )
            return c
          },
          query: vi.fn(async () => ({ rows: [], fields: [], rowCount: 0 })),
          end: vi.fn(async () => {}),
        } as unknown as Pool,
        makePgProfile()
      )
      await expect(sPgRunAfterQ.runQuery('q-after-r', 'SELECT 1')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })

      // beginTransactionLocked failure & close microtask races (L1493-1509)
      batchPool.connect.mockImplementationOnce(async () => {
        const c = new MockPgClient()
        c.release = vi.fn()
        c.query = vi.fn(async () => {
          throw new Error('BEGIN failed')
        })
        return c
      })
      await expect(sRunRaces.beginTransaction()).rejects.toThrow(/BEGIN failed/)

      const sPgBegAcqRace = new PostgresSession(
        {
          connect: () =>
            new Promise((res) => {
              setTimeout(() => {
                res(new MockPgClient())
                Promise.resolve().then(() => void sPgBegAcqRace.close())
              }, 0)
            }),
          query: vi.fn(async () => ({ rows: [], fields: [], rowCount: 0 })),
          end: vi.fn(async () => {}),
        } as unknown as Pool,
        makePgProfile()
      )
      await expect(sPgBegAcqRace.beginTransaction()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })

      const sPgBegTxRace = new PostgresSession(
        {
          connect: async () => {
            const c = new MockPgClient()
            c.release = vi.fn()
            c.query = vi.fn(
              () =>
                new Promise((res) => {
                  setTimeout(() => {
                    void sPgBegTxRace.close()
                    res({ rows: [], fields: [], rowCount: 0 })
                  }, 0)
                })
            )
            return c
          },
          query: vi.fn(async () => ({ rows: [], fields: [], rowCount: 0 })),
          end: vi.fn(async () => {}),
        } as unknown as Pool,
        makePgProfile()
      )
      await expect(sPgBegTxRace.beginTransaction()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })

      // fetchPage !autoCommit microtask close race (L754-756, L805-807)
      const sPgFetchRace = new PostgresSession(
        {
          connect: async () => {
            const c = new MockPgClient()
            c.release = vi.fn()
            c.query = vi.fn(async (sqlOrCfg: string | { text?: string }) => {
              const t = typeof sqlOrCfg === 'string' ? sqlOrCfg : sqlOrCfg?.text || ''
              if (t === 'BEGIN') {
                Promise.resolve().then(() => Promise.resolve().then(() => void sPgFetchRace.close()))
                return { rows: [], fields: [], rowCount: 0 }
              }
              if (t.includes('information_schema') || t.includes('pg_attribute')) return { rows: [{ column_name: 'id', data_type: 'int4', is_nullable: 'NO', column_default: null, is_primary_key: true }], fields: [], rowCount: 1 }
              return { rows: [{ total: 0 }], fields: [], rowCount: 1 }
            })
            return c
          },
          query: vi.fn(async () => ({ rows: [], fields: [], rowCount: 0 })),
          end: vi.fn(async () => {}),
        } as unknown as Pool,
        makePgProfile()
      )
      await sPgFetchRace.setAutoCommit(false)
      await sPgFetchRace.fetchPage({ table: 't', page: 1, pageSize: 5 }).catch((e) => e)
      await sPgFetchRace.close()

      // pinned applyChanges PgSqlStateError when closed mid-query (L1095-1096) & autoCommit applyChanges close races (L1108-1163)
      const sPinClosedApply = new PostgresSession(batchPool as unknown as Pool, makePgProfile())
      await sPinClosedApply.beginTransaction()
      activeBatchClient.query = vi
        .fn()
        .mockResolvedValueOnce({ rows: [], fields: [], rowCount: 0 })
        .mockImplementationOnce(async () => {
          await sPinClosedApply.close()
          throw Object.assign(new Error('dup'), { code: '23505' })
        })
      await expect(sPinClosedApply.applyChanges({ table: 't', inserts: [{ id: 1 }] })).rejects.toThrow(/dup/)

      const makeAutoApplyRace = (mode: 'acq' | 'del' | 'upd' | 'ins' | 'commit') => {
        let sess!: PostgresSession
        const pool = {
          connect: () =>
            new Promise((res) => {
              setTimeout(() => {
                const c = new MockPgClient()
                c.release = vi.fn()
                c.query = vi.fn(async (sqlOrCfg: string | { text?: string }) => {
                  const txt = typeof sqlOrCfg === 'string' ? sqlOrCfg : sqlOrCfg?.text || ''
                  if (mode === 'del' && txt === 'BEGIN') void sess.close()
                  if (mode === 'upd' && txt === 'BEGIN') void sess.close()
                  if (mode === 'ins' && txt === 'BEGIN') void sess.close()
                  if (mode === 'commit' && txt.startsWith('INSERT')) void sess.close()
                  return { rows: [], fields: [], rowCount: 1 }
                })
                res(c)
                if (mode === 'acq') Promise.resolve().then(() => void sess.close())
              }, 0)
            }),
          query: vi.fn(async () => ({ rows: [], fields: [], rowCount: 0 })),
          end: vi.fn(async () => {}),
        } as unknown as Pool
        sess = new PostgresSession(pool, makePgProfile())
        return sess
      }
      await expect(makeAutoApplyRace('acq').applyChanges({ table: 't', inserts: [{ id: 1 }] })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(makeAutoApplyRace('del').applyChanges({ table: 't', deletes: [{ id: 1 }] })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(makeAutoApplyRace('upd').applyChanges({ table: 't', updates: [{ primaryKeys: { id: 1 }, changes: { c: 2 } }] })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(makeAutoApplyRace('ins').applyChanges({ table: 't', inserts: [{ id: 1 }] })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
      await expect(makeAutoApplyRace('commit').applyChanges({ table: 't', inserts: [{ id: 1 }] })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })

      // Microtask close race right after pool.connect() resolves in test() -> hits L553-555
      const sTestRace = new PostgresSession(
        {
          connect: () =>
            new Promise((res) => {
              setTimeout(() => {
                res(new MockPgClient())
                Promise.resolve().then(() => void sTestRace.close())
              }, 0)
            }),
          query: vi.fn(async () => ({ rows: [], fields: [], rowCount: 0 })),
          end: vi.fn(async () => {}),
        } as unknown as Pool,
        makePgProfile()
      )
      expect((await sTestRace.test()).ok).toBe(false)

      // Queued txOps when close() happens while first txOp is running -> hits L747, L870, L1022, L1219, L1464
      const sQueueClose = new PostgresSession(batchPool as unknown as Pool, makePgProfile())
      await sQueueClose.beginTransaction()
      const qFetch = sQueueClose.fetchPage({ table: 't', page: 1, pageSize: 5 }).catch((e) => e)
      const qUpd = sQueueClose.updateCell({ table: 't', column: 'c', newValue: 1, primaryKeys: { id: 1 }, originalValue: 0 }).catch((e) => e)
      const qApply = sQueueClose.applyChanges({ table: 't', inserts: [{ id: 1 }] }).catch((e) => e)
      const qRun = sQueueClose.runQuery('q-q', 'BEGIN; SELECT 1;').catch((e) => e)
      const qAuto = sQueueClose.setAutoCommit(false).catch((e) => e)
      await sQueueClose.close()
      await Promise.all([qFetch, qUpd, qApply, qRun, qAuto])

      // 3e) Supabase direct network failure via message (no .code), concurrent fallback, resolve6 failure, and close race
      vi.spyOn(Pool.prototype, 'query').mockResolvedValue({ rows: [], fields: [], rowCount: 0 } as never)
      vi.spyOn(Pool.prototype, 'end').mockResolvedValue(undefined as never)
      vi.spyOn(Pool.prototype, 'connect').mockResolvedValue(new MockPgClient() as never)
      vi.spyOn(dns.promises, 'resolve6').mockRejectedValueOnce(new Error('dns fail'))

      const supaDefault = await resolveSupabasePoolerConfig('db.proj123.supabase.co', { host: 'db.proj123.supabase.co' })
      expect(supaDefault.host).toBe('aws-0-ap-southeast-1.pooler.supabase.com')

      let releaseDns!: (v: string[]) => void
      vi.spyOn(dns.promises, 'resolve6').mockImplementation(
        () =>
          new Promise<string[]>((res) => {
            releaseDns = res
          })
      )
      const directFailPool = {
        connect: vi.fn(async () => {
          throw new Error('getaddrinfo ENOTFOUND db.proj123.supabase.co')
        }),
        query: vi.fn(async () => {
          throw new Error('getaddrinfo ENOTFOUND db.proj123.supabase.co')
        }),
        end: vi.fn(async () => {}),
      }
      const sSupa = new PostgresSession(
        directFailPool as unknown as Pool,
        makePgProfile({ host: 'db.proj123.supabase.co' }),
        { host: 'db.proj123.supabase.co', user: 'postgres' }
      )
      const p1 = sSupa.test()
      const p2 = sSupa.test()
      await new Promise((r) => setTimeout(r, 15))
      await sSupa.close()
      releaseDns(['2600:1f18:dead::1'])
      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1.ok).toBe(false)
      expect(r2.ok).toBe(false)
    } finally {
      vi.restoreAllMocks()
    }
  }, 20_000)

  it('closes MySQL 8.4 & MariaDB 11.4 tunnelStreamFactory, toMysqlPem variants, live TX fetchPage/cancel, BIT PBT, and mock fault-injection paths', async () => {
    // 1) fast-check PBT on BIT(1) & BIT(8) decoding via Mock MysqlPoolLike
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 1, maxLength: 2 }), async (bytes) => {
        const bitPool: MysqlPoolLike = {
          getConnection: async () => ({
            query: async () => [
              [[bytes, bytes]],
              [
                { name: 'b1', columnType: 16, columnLength: 1 },
                { name: 'b8', columnType: 16, columnLength: 8 },
              ],
            ],
            beginTransaction: async () => {},
            commit: async () => {},
            rollback: async () => {},
            release: () => {},
          }),
          query: async () => [[], []],
          end: async () => {},
        }
        await withSession(new MysqlSession(bitPool, makeMysqlProfile()), async (s) => {
          const res = await s.runQuery('pbt-bit', 'SELECT b1, b8', 0)
          expect(res.rows[0][0] === '0' || res.rows[0][0] === '1').toBe(true)
          expect(String(res.rows[0][1])).toMatch(/^b'[01]{8}'$/)
        })
      }),
      { numRuns: 20 }
    )

    // 2) Live createSession with extraSecrets.tlsServername targeting 127.0.0.1:53306 (executes tunnelStreamFactory at L1342)
    const mysqlDriver = new MysqlDriver('mysql')
    await withSession(
      await mysqlDriver.createSession(
        makeMysqlProfile({ sslMode: 'disable' }),
        MYSQL_PASS,
        { tlsServername: 'mysql.remote.example' }
      ),
      async (tunnelSess) => {
        expect(await tunnelSess.test()).toEqual({ ok: true, message: 'MySQL connection valid' })
      }
    )

    // 3) Live manual TX -> fetchPage cache miss & error, BIT(1)/BIT(8) live, KILL QUERY cancel
    const liveMysql = (await mysqlDriver.createSession(makeMysqlProfile(), MYSQL_PASS)) as MysqlSession
    try {
      await liveMysql.runQuery(
        'w4b-m-ddl',
        `
        CREATE TABLE cov_w4b_bit_tbl (id INT PRIMARY KEY, f1 BIT(1), f8 BIT(8), label VARCHAR(32));
        INSERT INTO cov_w4b_bit_tbl VALUES (1, b'1', b'10101010', 'row1');
        CREATE TABLE cov_w4b_tx_tbl (id INT PRIMARY KEY, v INT NOT NULL);
        INSERT INTO cov_w4b_tx_tbl VALUES (1, 100);
        `
      )

      // Manual TX fetchPage on uncached table (cache miss) + fetchPage error inside TX
      await liveMysql.beginTransaction()
      const txPage = await liveMysql.fetchPage({ table: 'cov_w4b_tx_tbl', page: 1, pageSize: 5 })
      expect(txPage.totalRows).toBe(1)
      await expect(
        liveMysql.fetchPage({ table: 'cov_w4b_tx_tbl', page: 1, pageSize: 5, whereClause: 'missing_col = 1' })
      ).rejects.toThrow()
      await liveMysql.rollbackTransaction()

      // Live BIT(1)/BIT(8) + KILL QUERY cancel
      const bitQ = await liveMysql.runQuery('w4b-m-bit', 'SELECT f1, f8 FROM cov_w4b_bit_tbl WHERE id = 1;')
      expect(bitQ.rows[0]).toEqual(['1', "b'10101010'"])

      const slowQ = liveMysql.runQuery('w4b-m-sleep', 'SELECT SLEEP(5);').catch((e) => e)
      await new Promise((r) => setTimeout(r, 80))
      expect((await liveMysql.cancelQuery('w4b-m-sleep')).ok).toBe(true)
      await slowQ
    } finally {
      await liveMysql.close()
    }

    // Live MariaDB sanity check with prefix
    const mariaDriver = new MysqlDriver('mariadb')
    const liveMaria = (await mariaDriver.createSession(makeMariaProfile(), MARIA_PASS)) as MysqlSession
    try {
      await liveMaria.runQuery('w4b-ma-init', `CREATE TABLE cov_w4b_parent (id INT PRIMARY KEY, name VARCHAR(20));`)
      const emptyPage = await liveMaria.fetchPage({ table: 'cov_w4b_parent', page: 1, pageSize: 5 })
      expect(emptyPage.totalRows).toBe(0)
    } finally {
      await liveMaria.close()
    }

    // 4) Mock resolveEffectiveTlsOptions for toMysqlPem array/Buffer/mixed branches + sslMode auto + verifyIpIdentity
    try {
      const tlsSpy = vi.spyOn(tlsAndTunnel, 'resolveEffectiveTlsOptions')
      tlsSpy.mockResolvedValueOnce({
        ca: ['CA1', 'CA2'] as unknown as string,
        cert: Buffer.from('CERT_BUF'),
        key: [Buffer.from('K1'), Buffer.from('K2')] as unknown as string[],
        rejectUnauthorized: true,
      })
      await withSession(await mysqlDriver.createSession(makeMysqlProfile({ sslMode: 'auto' }), MYSQL_PASS))

      tlsSpy.mockResolvedValueOnce({
        ca: 123 as unknown as string,
        cert: [123, Buffer.from('CERT_BUF')] as unknown as string,
        key: [123, 'KEY_STR'] as unknown as string,
        rejectUnauthorized: false,
      })
      await withSession(await mysqlDriver.createSession(makeMysqlProfile({ sslMode: undefined }), MYSQL_PASS))

      tlsSpy.mockResolvedValueOnce({
        ca: [Buffer.from('CA_BUF'), 'CA_STR'] as unknown as string,
        rejectUnauthorized: false,
      })
      await withSession(await mysqlDriver.createSession(makeMysqlProfile({ sslMode: undefined }), MYSQL_PASS))
    } finally {
      vi.restoreAllMocks()
    }

    // 5) Mock MysqlPoolLike & mysqlPromise.createConnection for error extractors, fatal errno, sendKillQuery, close/tx/query races
    try {
      const makeConn = (overrides: Partial<MysqlConnectionLike> = {}): MysqlConnectionLike => ({
        threadId: 55,
        query: vi.fn(async () => [{ affectedRows: 'bad' }, []] as [unknown, unknown]),
        beginTransaction: vi.fn(async () => {}),
        commit: vi.fn(async () => {}),
        rollback: vi.fn(async () => {}),
        release: vi.fn(),
        destroy: vi.fn(),
        ...overrides,
      })

      // 5a) Error extractors, fatal codes, verifyIpIdentity without stream, safeReleaseConn catch, empty/no-length BIT
      const noStreamConn = makeConn({
        query: vi.fn(async (sql) => {
          if (typeof sql === 'string' && sql.includes('SHOW CREATE TABLE')) {
            throw new Error('show create rejected')
          }
          if (typeof sql === 'object' && sql.sql.includes('SELECT_BIT_NOLEN')) {
            return [[{ b: new Uint8Array([0x0f]) }], [{ name: 'b', columnType: 16, columnLength: 0 }]]
          }
          return [null, []]
        }),
        release: vi.fn(() => {
          throw new Error('release throws')
        }),
      })
      const noStreamPool: MysqlPoolLike = {
        getConnection: async () => noStreamConn,
        query: vi.fn(async (sql: string) => {
          if (sql.includes('SHOW CREATE TABLE')) throw new Error('show create failed')
          if (sql.includes('information_schema.COLUMNS')) {
            return [[{ COLUMN_NAME: 'id', DATA_TYPE: 'int', COLUMN_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, COLUMN_KEY: 'PRI', EXTRA: '' }], []]
          }
          return [[], []]
        }),
        end: vi.fn(async () => {}),
      }

      const sEdge = new MysqlSession(noStreamPool, makeMysqlProfile(), undefined, '127.0.0.1')
      // test() error extractors (string error, object message, empty error)
      noStreamConn.query = vi.fn(async () => {
        throw 'string test err'
      })
      expect((await sEdge.test()).message).toBe('string test err')
      noStreamConn.query = vi.fn(async () => {
        throw { message: 'obj test err' }
      })
      expect((await sEdge.test()).message).toBe('obj test err')
      noStreamConn.query = vi.fn(async () => {
        throw { message: 99 }
      })
      expect((await sEdge.test()).message).toContain('Failed to connect to MySQL')
      // test() error without conn.destroy
      const noDestroyConn = makeConn({
        destroy: undefined,
        query: vi.fn(async () => {
          throw new Error('no destroy')
        }),
      })
      const noDestroyPool: MysqlPoolLike = {
        getConnection: async () => noDestroyConn,
        query: vi.fn(async () => [[], []]),
        end: vi.fn(async () => {}),
      }
      const sNoDestroy = new MysqlSession(noDestroyPool, makeMysqlProfile())
      expect((await sNoDestroy.test()).message).toBe('no destroy')
      await sNoDestroy.close()

      // BIT without columnLength, null res affectedRows, SHOW CREATE catch fallback, invalid affectedRows, non-array rows
      noStreamConn.query = vi.fn(async (sql) => {
        const txt = typeof sql === 'string' ? sql : sql.sql
        if (txt.includes('SHOW CREATE TABLE')) {
          throw new Error('show create failed on conn')
        }
        if (txt.includes('SELECT_BIT_NOLEN')) {
          return [[{ b: new Uint8Array([0x0f]) }], [{ name: 'b', columnType: 16, columnLength: 0 }]]
        }
        if (txt.includes('SELECT_BAD_ROWS')) {
          return [null, [{ name: 'x', columnType: 253 }]]
        }
        if (txt.includes('BAD_AFF')) {
          return [{ affectedRows: 'bad' }, []]
        }
        return [null, []]
      })
      const bitNoLen = await sEdge.runQuery('q-bit-nolen', 'SELECT_BIT_NOLEN', 0)
      expect(bitNoLen.rows[0][0]).toBe("b'00001111'")
      const badRowsRes = await sEdge.runQuery('q-bad-rows', 'SELECT_BAD_ROWS')
      expect(badRowsRes.rows).toEqual([])
      const badAff = await sEdge.runQuery('q-bad-aff', 'UPDATE t SET a = 1 /* BAD_AFF */')
      expect(badAff.affectedRows).toBe(0)
      const nullAff = await sEdge.runQuery('q-null-aff', 'UPDATE t SET a = 1')
      expect(nullAff.affectedRows).toBe(0)
      expect(await sEdge.getDdl('fallback_tbl')).toContain('CREATE TABLE')

      // Fatal code 123/null checks + mariadb test() null-err fallback
      const sMariaErr = new MysqlSession(
        {
          getConnection: async () =>
            makeConn({
              query: vi.fn(async () => {
                throw null
              }),
            }),
          query: vi.fn(async () => [[], []]),
          end: vi.fn(async () => {}),
        },
        makeMariaProfile()
      )
      expect((await sMariaErr.test()).message).toContain('Failed to connect to MariaDB')
      noStreamConn.query = vi.fn(async () => {
        throw { code: undefined, errno: 1.5 }
      })
      await expect(sEdge.runQuery('q-code-undef', 'SELECT 1')).rejects.toBeTruthy()
      noStreamConn.query = vi.fn(async () => {
        throw { code: 123, errno: 1.5 }
      })
      await expect(sEdge.runQuery('q-code-num', 'SELECT 1')).rejects.toBeTruthy()
      await sMariaErr.close()

      // Fatal PROTOCOL_CONNECTION_LOST + COMMIT AND CHAIN without serverStatus + pinned applyChanges rollback savepoint throw
      await sEdge.beginTransaction()
      noStreamConn.query = vi.fn(async () => [{ affectedRows: 1 }, []])
      await sEdge.runQuery('q-chain-noserv', 'COMMIT AND CHAIN;')
      expect(sEdge.getTransactionState().active).toBe(true)

      noStreamConn.query = vi.fn(async () => {
        throw Object.assign(new Error('lost'), { code: 'PROTOCOL_CONNECTION_LOST' })
      })
      await expect(sEdge.runQuery('q-proto-lost', 'SELECT 1')).rejects.toThrow('lost')
      expect(sEdge.getTransactionState().active).toBe(false)

      await sEdge.beginTransaction()
      noStreamConn.query = vi
        .fn()
        .mockResolvedValueOnce([{ affectedRows: 0 }, []]) // SAVEPOINT
        .mockRejectedValueOnce(new Error('stmt fail'))
        .mockRejectedValueOnce(new Error('rollback sp fail'))
      await expect(sEdge.applyChanges({ table: 't', inserts: [{ id: 1 }] })).rejects.toThrow('stmt fail')

      // close() when pinned txConn rollback throws
      noStreamConn.rollback = vi.fn(async () => {
        throw new Error('close rollback fail')
      })
      await sEdge.close()

      // 5b) sendKillQuery with unreachable cancelConnOptions -> catch returns false (L430); plus close() with active query + cancelConnOptions (L500-501)
      const sKill = new MysqlSession(noStreamPool, makeMysqlProfile(), {
        host: '127.0.0.1',
        port: 59997,
        connectTimeout: 80,
      })
      expect(await (sKill as unknown as { sendKillQuery(id: number): Promise<boolean> }).sendKillQuery(55)).toBe(false)
      await sKill.close()

      // close() with active query having threadId > 0 and cancelConnOptions
      let releaseHang!: () => void
      const hangConn = makeConn({
        threadId: 99,
        query: vi.fn(
          () =>
            new Promise<[unknown, unknown]>((res) => {
              releaseHang = () => res([[], []])
            })
        ),
      })
      const sHangClose = new MysqlSession(
        { getConnection: async () => hangConn, query: vi.fn(async () => [[], []]), end: vi.fn(async () => {}) },
        makeMysqlProfile(),
        { host: '127.0.0.1', port: 59997, connectTimeout: 80 }
      )
      const hangP = sHangClose.runQuery('q-hang-kill', 'SELECT SLEEP(5)').catch((e) => e)
      await new Promise((r) => setTimeout(r, 15))
      await sHangClose.close()
      releaseHang?.()
      await hangP

      // 5c) Pinned query cancelled while resolving normally (L1166-1170), multi-stmt cancel, commit/rollback/begin errors, and close microtask races
      let resolvePin!: () => void
      const pinConn = makeConn({
        query: vi.fn(
          () =>
            new Promise<[unknown, unknown]>((res) => {
              resolvePin = () => res([[], []])
            })
        ),
      })
      const sPinRace = new MysqlSession({
        getConnection: async () => pinConn,
        query: vi.fn(async () => [[], []]),
        end: vi.fn(async () => {}),
      }, makeMysqlProfile())
      await sPinRace.beginTransaction()
      const pinQ = sPinRace.runQuery('q-pin-ok-cancel', 'SELECT 1')
      await new Promise((r) => setTimeout(r, 10))
      await sPinRace.cancelQuery('q-pin-ok-cancel')
      resolvePin()
      await pinQ
      expect(sPinRace.getTransactionState().active).toBe(false)

      // commit/rollback/begin errors
      pinConn.commit = vi.fn(async () => {
        throw new Error('commit err')
      })
      pinConn.rollback = vi.fn(async () => {
        throw new Error('rollback err')
      })
      await sPinRace.beginTransaction()
      await expect(sPinRace.commitTransaction()).rejects.toThrow('commit err')
      await sPinRace.beginTransaction()
      await expect(sPinRace.rollbackTransaction()).rejects.toThrow('rollback err')

      pinConn.beginTransaction = vi.fn(async () => {
        throw new Error('begin err')
      })
      await expect(sPinRace.beginTransaction()).rejects.toThrow('begin err')

      // Multi-stmt runQuery cancelled mid-script -> L1020-1022
      let releaseMysqlStmt1!: () => void
      pinConn.query = vi.fn(
        () =>
          new Promise<[unknown, unknown]>((res) => {
            releaseMysqlStmt1 = () => res([[], []])
          })
      )
      const multiCancel = sPinRace.runQuery('q-m-cancel', 'SELECT 1; SELECT 2;').catch((e) => e)
      await new Promise((r) => setTimeout(r, 15))
      await sPinRace.cancelQuery('q-m-cancel')
      releaseMysqlStmt1()
      await multiCancel
      await sPinRace.close()

      // Extra database-undefined & cloud-host createSession config branches + empty-database session methods
      await withSession(
        await mysqlDriver.createSession(
          makeMysqlProfile({ host: 'db.rds.amazonaws.com', port: 0, database: undefined, user: undefined, ssl: undefined, sslMode: undefined })
        )
      )

      await withSession(
        await mysqlDriver.createSession(
          makeMysqlProfile({ host: undefined, port: undefined, database: undefined, ssl: false, sslMode: undefined })
        )
      )

      const noDbPool: MysqlPoolLike = {
        getConnection: async () =>
          makeConn({
            query: vi.fn(async (sql: unknown) => {
              const txt = typeof sql === 'string' ? sql : (sql as { sql?: string }).sql || ''
              if (txt.includes('SHOW CREATE TABLE')) return [[{ 'Create Table': 'CREATE TABLE t (id INT)' }], []]
              if (txt.includes('COUNT(*)')) return [[], []]
              return [{ affectedRows: 1 }, []]
            }),
          }),
        query: vi.fn(async (sql: string) => {
          const lower = sql.toLowerCase()
          if (lower.includes('show create table') && lower.includes('t2')) {
            return [[{ 'Create Table': 'CREATE TABLE t2 (id INT);' }], []]
          }
          if (lower.includes('show create table')) return [[{ 'Create Table': 'CREATE TABLE t (id INT)' }], []]
          if (lower.includes('information_schema.columns')) {
            return [[{ COLUMN_NAME: 'id', DATA_TYPE: 'int', COLUMN_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, COLUMN_KEY: 'PRI', EXTRA: '' }], []]
          }
          if (lower.includes('information_schema.tables')) {
            return [[{ TABLE_NAME: 't1', TABLE_SCHEMA: '', TABLE_TYPE: 'BASE TABLE' }], []]
          }
          return [{ affectedRows: 1 }, []]
        }),
        end: vi.fn(async () => {}),
      }
      await withSession(new MysqlSession(noDbPool, makeMysqlProfile({ database: undefined })), async (sEmptyDb) => {
        await sEmptyDb.listObjects()
        await sEmptyDb.listSchemas()
        await expect(sEmptyDb.getObjectDdl('v1', 'view')).rejects.toThrow(/database\/schema name is required/i)
        await sEmptyDb.exportSchemaDdl()
        await sEmptyDb.exportSchemaDdl('explicit_schema')
        expect(await sEmptyDb.getDdl('t1')).toBe('CREATE TABLE t (id INT);')
        expect(await sEmptyDb.getDdl('t2')).toBe('CREATE TABLE t2 (id INT);')
        await sEmptyDb.getTableDetails('t1')
        await sEmptyDb.fetchPage({ table: 't1', page: 1, pageSize: 5 })
        await sEmptyDb.beginTransaction()
        await sEmptyDb.fetchPage({ table: 't1', page: 1, pageSize: 5 })
        await sEmptyDb.commitTransaction()
        await sEmptyDb.updateCell({ table: 't1', column: 'id', newValue: 2, primaryKeys: { id: 1 }, originalValue: 1 })
        await sEmptyDb.previewChanges({ table: 't1', inserts: [{ id: 1 }] })
        await sEmptyDb.applyChanges({ table: 't1', inserts: [{ id: 1 }] })
      })

      // queryExecutor isClosed during multi-query getTableDetails -> L409-410
      const sExpRace = new MysqlSession({
        getConnection: async () => makeConn(),
        query: vi.fn(async () => {
          await sExpRace.close()
          return [[{ COLUMN_NAME: 'id', DATA_TYPE: 'int', COLUMN_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, COLUMN_KEY: 'PRI', EXTRA: '' }], []]
        }),
        end: vi.fn(async () => {}),
      }, makeMysqlProfile())
      await expect(sExpRace.getTableDetails('t')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })

      // Microtask close races:
      // - right after acquireConnection() in runQuery (L995-997)
      const sRunAcqRace = new MysqlSession({
        getConnection: () =>
          new Promise((res) => {
            setTimeout(() => {
              res(makeConn())
              Promise.resolve().then(() => void sRunAcqRace.close())
            }, 0)
          }),
        query: vi.fn(async () => [[], []]),
        end: vi.fn(async () => {}),
      }, makeMysqlProfile())
      await expect(sRunAcqRace.runQuery('q-acq-race', 'BEGIN;')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })

      // - right after conn.query() in non-pinned runQuery (L1051-1053)
      const sAfterQ2 = new MysqlSession({
        getConnection: async () =>
          makeConn({
            query: () =>
              new Promise((res) => {
                setTimeout(() => {
                  void sAfterQ2.close()
                  res([[], []])
                }, 0)
              }),
          }),
        query: vi.fn(async () => [[], []]),
        end: vi.fn(async () => {}),
      }, makeMysqlProfile(), undefined, '127.0.0.1')
      await expect(sAfterQ2.runQuery('q-after-race', 'SELECT 1')).rejects.toMatchObject({ code: 'SESSION_CLOSED' })

      // - right after acquireConnection() and right after beginTransaction() in beginTransactionLocked (L1239-1247)
      const sBeginAcqRace = new MysqlSession({
        getConnection: () =>
          new Promise((res) => {
            setTimeout(() => {
              res(makeConn())
              Promise.resolve().then(() => void sBeginAcqRace.close())
            }, 0)
          }),
        query: vi.fn(async () => [[], []]),
        end: vi.fn(async () => {}),
      }, makeMysqlProfile())
      await expect(sBeginAcqRace.beginTransaction()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })

      const sBeginTxRace = new MysqlSession({
        getConnection: async () =>
          makeConn({
            beginTransaction: () =>
              new Promise((res) => {
                setTimeout(() => {
                  void sBeginTxRace.close()
                  res()
                }, 0)
              }),
          }),
        query: vi.fn(async () => [[], []]),
        end: vi.fn(async () => {}),
      }, makeMysqlProfile())
      await expect(sBeginTxRace.beginTransaction()).rejects.toMatchObject({ code: 'SESSION_CLOSED' })

      // - fetchPage !autoCommit race where close() clears txConn right after beginTransactionLocked resolves -> hits L595-599, L638-639
      const sFetchRace = new MysqlSession({
        getConnection: async () =>
          makeConn({
            query: vi.fn(async (sql: unknown) => {
              const txt = typeof sql === 'string' ? sql : (sql as { sql?: string }).sql || ''
              if (txt.includes('information_schema.COLUMNS')) {
                return [[{ COLUMN_NAME: 'id', DATA_TYPE: 'int', COLUMN_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, COLUMN_KEY: 'PRI', EXTRA: '' }], []]
              }
              if (txt.includes('COUNT(*)')) return [[{ total: 0 }], []]
              return [[], []]
            }),
            beginTransaction: async () => {
              // schedule close() AFTER beginTransactionLocked sets txConn and resolves, BEFORE fetchPage resumes!
              Promise.resolve().then(() => Promise.resolve().then(() => void sFetchRace.close()))
            },
          }),
        query: vi.fn(async () => [[], []]),
        end: vi.fn(async () => {}),
      }, makeMysqlProfile())
      await sFetchRace.setAutoCommit(false)
      await sFetchRace.fetchPage({ table: 't', page: 1, pageSize: 5 })
      await sFetchRace.close()
    } finally {
      vi.restoreAllMocks()
    }
  }, 20_000)
})
