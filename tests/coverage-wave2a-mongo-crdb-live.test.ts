import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { ConnectionProfile } from '../src/protocol'
import {
  BSONRegExp,
  Binary,
  Code,
  Decimal128,
  Double,
  EJSON,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
} from '../vendor/mongodb.js'
import {
  MongoDriver,
  MongoLiteralParser,
  buildMongoConnectionConfig,
  detectBsonTypeName,
  formatMongoEjsonString,
  hydrateEjsonValues,
  parseMongoStatement,
  serializeMongoDocument,
  serializeMongoValue,
  splitMongoScriptStatements,
  translateSqlFilterToMongoFilter,
  type MongoClientFactory,
  type MongoClientLike,
} from '../src/drivers/mongodb/driver'
import { PostgresDriver } from '../src/drivers/postgres/driver'
import {
  BYOD_DRIVER_IDS,
  BYOD_DRIVER_SLOTS,
  DriverManager,
  getByodDefaultPort,
  isByodDriverId,
} from '../src/drivers/driver-manager'

const LIVE_MONGO_PORT = 57017
const LIVE_MONGO_DB = 'datanoa_cov_mongo'
const LIVE_MONGO_DROP_DB = 'datanoa_cov_mongo_drop'
const LIVE_CRDB_PORT = 56257
const LIVE_CRDB_SCHEMA = 'cov_crdb_live'

function makeMongoProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'cov-mongo-live',
    name: 'Live MongoDB 7',
    type: 'mongodb',
    host: '127.0.0.1',
    port: LIVE_MONGO_PORT,
    database: LIVE_MONGO_DB,
    options: JSON.stringify({
      replicaSet: 'rs0',
      directConnection: true,
      appName: 'datanoa-cov',
      retryWrites: true,
      maxPoolSize: 4,
      connectTimeoutMS: 5000,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 10000,
    }),
    ...overrides,
  }
}

function makeCrdbProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'cov-crdb-live',
    name: 'Live CockroachDB',
    type: 'cockroachdb',
    host: '127.0.0.1',
    port: LIVE_CRDB_PORT,
    user: 'root',
    database: 'datanoa_test',
    ssl: false,
    ...overrides,
  }
}

describe('Wave 2A-2b Live MongoDB 7, CockroachDB & DriverManager', () => {
  const tempDirs: string[] = []

  const makeTempDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }

  beforeAll(async () => {
    const mongoDriver = new MongoDriver()
    const mSess = await mongoDriver.createSession(makeMongoProfile())
    try {
      await mSess.runQuery('prep-drop-1', `use ${LIVE_MONGO_DB}; db.dropDatabase();`)
      await mSess.runQuery('prep-drop-2', `use ${LIVE_MONGO_DROP_DB}; db.dropDatabase();`)
    } finally {
      await mSess.close()
    }

    const pgDriver = new PostgresDriver()
    const cSess = await pgDriver.createSession(makeCrdbProfile())
    try {
      await cSess.runQuery('crdb-prep-1', `DROP SCHEMA IF EXISTS ${LIVE_CRDB_SCHEMA} CASCADE;`)
      await cSess.runQuery('crdb-prep-2', `CREATE SCHEMA ${LIVE_CRDB_SCHEMA};`)
    } finally {
      await cSess.close()
    }
  }, 30000)

  afterAll(async () => {
    try {
      const mongoDriver = new MongoDriver()
      const mSess = await mongoDriver.createSession(makeMongoProfile())
      try {
        await mSess.runQuery('clean-drop-1', `use ${LIVE_MONGO_DB}; db.dropDatabase();`)
        await mSess.runQuery('clean-drop-2', `use ${LIVE_MONGO_DROP_DB}; db.dropDatabase();`)
      } finally {
        await mSess.close()
      }
    } catch {
      // Best-effort cleanup
    }

    try {
      const pgDriver = new PostgresDriver()
      const cSess = await pgDriver.createSession(makeCrdbProfile())
      try {
        await cSess.runQuery('crdb-clean', `DROP SCHEMA IF EXISTS ${LIVE_CRDB_SCHEMA} CASCADE;`)
      } finally {
        await cSess.close()
      }
    } catch {
      // Best-effort cleanup
    }

    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup failure
      }
    }
  }, 30000)

  it('covers MongoDB BSON/EJSON/literal-parser/SQL-filter/connection-config helpers & PBT', async () => {
    const hexIdArb = fc.stringMatching(/^[0-9a-f]{24}$/)

    fc.assert(
      fc.property(
        hexIdArb,
        fc.integer({ min: -100000, max: 100000 }),
        fc.string({ maxLength: 24 }),
        (hex, n, label) => {
          const oid = new ObjectId(hex)
          expect(detectBsonTypeName(oid)).toBe('ObjectId')
          expect(serializeMongoValue(oid)).toBe(hex)

          const doc = serializeMongoDocument({
            _id: oid,
            n,
            label,
            ignoredFn: () => 1,
            ignoredSym: Symbol('x'),
            ignoredUndef: undefined,
          })
          expect(doc._id).toBe(hex)
          expect(doc.n).toBe(n)
          expect('ignoredFn' in doc).toBe(false)
          expect('ignoredSym' in doc).toBe(false)
          expect('ignoredUndef' in doc).toBe(false)

          const filter = translateSqlFilterToMongoFilter(`_id = '${hex}' AND score >= ${n}`)
          expect(filter).toHaveProperty('$and')
        }
      ),
      { numRuns: 35 }
    )

    // Exercise every BSON type branch in detectBsonTypeName, serializeMongoValue, formatMongoEjsonString, hydrateEjsonValues
    const uuid = new UUID('11111111-2222-4333-8444-555555555555')
    const binUuid = new Binary(Buffer.from(uuid.buffer), 4)
    const binRaw = new Binary(Buffer.from('hello'), 2)
    const bsonRegex = new BSONRegExp('^abc', 'i')
    const jsRegex = /xyz/gi
    const minKey = new MinKey()
    const maxKey = new MaxKey()
    const codePlain = new Code('function(){}')
    const codeScoped = new Code('function(){return x}', { x: 42 })
    const dec = Decimal128.fromString('123.45')
    const lng = Long.fromNumber(9876543210)
    const ts = new Timestamp({ t: 10, i: 2 })
    const dbl = new Double(3.5)
    const i32 = new Int32(77)
    const ab = new Uint8Array([1, 2, 3]).buffer
    const view = new Uint8Array([4, 5, 6])

    const allValues: Array<[unknown, string]> = [
      [dec, 'Decimal128'],
      [lng, 'Long'],
      [ts, 'Timestamp'],
      [i32, 'Int32'],
      [dbl, 'Double'],
      [uuid, 'UUID'],
      [binUuid, 'UUID'],
      [binRaw, 'Binary'],
      [bsonRegex, 'BSONRegExp'],
      [jsRegex, 'BSONRegExp'],
      [minKey, 'MinKey'],
      [maxKey, 'MaxKey'],
      [codePlain, 'Code'],
      [codeScoped, 'Code'],
      [ab, 'Binary'],
      [view, 'Binary'],
      [new Date('2025-01-01T00:00:00Z'), 'Date'],
      [42n, 'Long'],
      [{ nested: true }, 'Object'],
      [[1, 2], 'Array'],
      [true, 'Boolean'],
      [7, 'Int32'],
      [1.5, 'Double'],
      [Infinity, 'Double'],
      [{ _bsontype: 'CustomTag' }, 'CustomTag'],
      ['s', 'String'],
      [null, 'Null'],
      [undefined, 'Null'],
    ]
    for (const [val, expectedType] of allValues) {
      expect(detectBsonTypeName(val)).toBe(expectedType)
      serializeMongoValue(val)
    }

    const ejsonStr = formatMongoEjsonString({ a: dec, b: lng })
    expect(ejsonStr).toContain('$numberDecimal')
    expect(hydrateEjsonValues(new ObjectId())).toBeInstanceOf(ObjectId)
    expect(hydrateEjsonValues([{ $oid: 'aaaaaaaaaaaaaaaaaaaaaaaa' }])).toBeTruthy()
    expect(hydrateEjsonValues({ $oid: 'not-valid-hex' })).toHaveProperty('$oid')
    const nonPlain = new Map([['a', 1]])
    expect(hydrateEjsonValues(nonPlain)).toBe(nonPlain)
    expect(hydrateEjsonValues(JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}'))).toEqual({
      ok: 1,
    })

    // Exercise MongoLiteralParser helper functions & error branches
    const helperLiteral = `({
      oid1: ObjectId(),
      oid2: ObjectId('0123456789abcdef01234567'),
      oid3: ObjectId.createFromHexString('fedcba9876543210fedcba98'),
      iso0: ISODate(),
      iso1: ISODate('2025-02-02T12:00:00Z'),
      dt: Date(1700000000000),
      now: Date.now(),
      dec: NumberDecimal('99.95'),
      dec2: Decimal128.fromString('10.5'),
      lng0: NumberLong(),
      lng1: NumberLong(42),
      lng2: Long.fromString('1234567890123'),
      i0: NumberInt(),
      i1: Int32(-9),
      d0: Double(),
      d1: Double(4.25),
      u0: UUID(),
      u1: UUID('11111111-2222-4333-8444-555555555555'),
      b1: BinData('0x02', 'aGVsbG8='),
      b2: Binary('aGVsbG8=', 5),
      ts1: Timestamp({ t: 3, i: 4 }),
      ts2: Timestamp(5, 6),
      rx: RegExp('^foo', 'm'),
      min: MinKey(),
      max: MaxKey(),
      cd: Code('x + 1', { x: 2 }),
    })`
    const parsedHelperObj = new MongoLiteralParser(
      helperLiteral.slice(1, -1)
    ).parseValue() as Record<string, unknown>
    expect(parsedHelperObj.oid2).toBeInstanceOf(ObjectId)
    expect(parsedHelperObj.dec).toBeInstanceOf(Decimal128)
    expect(parsedHelperObj.ts1).toBeInstanceOf(Timestamp)
    expect(parsedHelperObj.cd).toBeInstanceOf(Code)
    expect(EJSON.stringify(parsedHelperObj.b1)).toContain('$binary')

    for (const badHelper of [
      'ObjectId(123)',
      'ISODate({})',
      'ISODate("not-a-date")',
      'NumberDecimal()',
      'NumberInt("nan")',
      'BinData(999, "YQ==")',
      'BinData(0, 123)',
      'UnknownHelper(1)',
    ]) {
      expect(() => new MongoLiteralParser(badHelper).parseValue()).toThrow()
    }

    // Exercise translateSqlFilterToMongoFilter branches: NOT LIKE, !=, <, <=, >, IN, NOT IN, OR, trailing token error
    expect(translateSqlFilterToMongoFilter("name NOT LIKE '%foo%' OR age < 10 OR age <= 5 OR age > 90 OR _id != '0123456789abcdef01234567'")).toHaveProperty('$or')
    expect(translateSqlFilterToMongoFilter("tag IN ('a', 'b') AND _id IN ('0123456789abcdef01234567', 'raw') AND tag NOT IN ()")).toHaveProperty('$and')
    expect(() => translateSqlFilterToMongoFilter('age = 1 extra')).toThrow()
    expect(() => translateSqlFilterToMongoFilter('age ~ 1')).toThrow()
    expect(() => translateSqlFilterToMongoFilter('age IN (1; 2)')).toThrow()
    expect(() => translateSqlFilterToMongoFilter('age IN 1')).toThrow()

    // Exercise buildMongoConnectionConfig URI/SSH/TLS branches with real temp PEM files
    const tlsDir = makeTempDir('datanoa-mongo-tls-')
    const caPath = path.join(tlsDir, 'ca.pem')
    const certPath = path.join(tlsDir, 'cert.pem')
    fs.writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n')
    fs.writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----\n')
    const cfg = await buildMongoConnectionConfig(
      makeMongoProfile({
        url: 'mongodb://existingHost:27018/urldb?authSource=admin',
        database: undefined,
        user: 'u:1',
        sshEnabled: true,
        host: '::1',
        port: 27999,
        ssl: true,
        sslMode: 'verify-ca',
        sslRejectUnauthorized: false,
        sslCaPath: `  ${caPath} `,
        sslCertPath: ` ${certPath} `,
        sslKeyPath: ` ${certPath} `,
        options: JSON.stringify({
          authSource: 'admin',
          replicaSet: 'rs0',
          directConnection: true,
          appName: 'myApp',
          retryWrites: false,
          maxPoolSize: 8,
          connectTimeoutMS: 2000,
          serverSelectionTimeoutMS: 3000,
          socketTimeoutMS: 4000,
        }),
      }),
      'p@ss',
      {
        ca: 'CA_PEM',
        cert: 'CERT_PEM',
        key: 'KEY_PEM',
        passphrase: 'secret',
        tlsServername: 'mongo.internal',
        rejectUnauthorized: false,
      }
    )
    expect(cfg.dbName).toBe('urldb')
    expect(cfg.uri).toContain('[::1]:27999')
    expect(cfg.options.authSource).toBe('admin')
    expect(cfg.options.tls).toBe(true)
    expect(cfg.options.tlsCAFile).toBe(caPath)
    expect(cfg.options.tlsCertificateKeyFile).toBe(certPath)
    expect(cfg.options.tlsAllowInvalidCertificates).toBe(false)

    const requireTlsCfg = await buildMongoConnectionConfig(
      makeMongoProfile({ ssl: true, sslMode: 'require' })
    )
    expect(requireTlsCfg.options.tlsAllowInvalidCertificates).toBe(true)

    const inlineTlsCfg = await buildMongoConnectionConfig(
      makeMongoProfile({ ssl: true, sslMode: 'verify-full' }),
      'pw',
      { ca: 'CA_PEM', cert: 'CERT_PEM', key: 'KEY_PEM', passphrase: 'secret', rejectUnauthorized: true }
    )
    expect(inlineTlsCfg.options.tls).toBe(true)
    expect(inlineTlsCfg.options.tlsAllowInvalidCertificates).toBe(false)
    expect(inlineTlsCfg.options.rejectUnauthorized).toBe(true)

    // Additional MongoLiteralParser escape/comment/number/error edges + key=value options + scrubMongoError coverage
    const escapedParsed = new MongoLiteralParser(`
      // line comment
      {
        /* block comment */
        esc: 'a\\n\\r\\t\\\\\\'\\"',
        neg: -42.5e1,
        arr: [1, true, false, null, ],
      }
    `).parseValue() as Record<string, unknown>
    expect(escapedParsed.neg).toBe(-425)
    expect(Array.isArray(escapedParsed.arr)).toBe(true)
    for (const badLit of ['', '{bad:', '[1', '"unclosed', '{bad: 1']) {
      expect(() => {
        const p = new MongoLiteralParser(badLit)
        const v = p.parseValue()
        p.expectEnd()
        return v
      }).toThrow()
    }

    const kvCfg = await buildMongoConnectionConfig(
      makeMongoProfile({
        options: 'authSource=admin&retryWrites=true&directConnection=false&maxPoolSize=7&badpart',
      })
    )
    expect(kvCfg.options.authSource).toBe('admin')
    expect(kvCfg.options.retryWrites).toBe(true)
    expect(kvCfg.options.directConnection).toBe(false)
    expect(kvCfg.options.maxPoolSize).toBe(7)

    // Additional buildMongoConnectionConfig URL/hash/bad-encoding/IPv6-without-URL edge cases
    const hashUrlCfg = await buildMongoConnectionConfig(
      makeMongoProfile({
        url: 'mongodb://alreadyUser:p@h1:27017/%E0%A4%A#frag?a=1',
        database: undefined,
        user: 'ignoredUser',
      }),
      'ignoredPass'
    )
    expect(hashUrlCfg.dbName).toBe('%E0%A4%A')
    const hashOnlyCfg = await buildMongoConnectionConfig(
      makeMongoProfile({
        url: 'mongodb://h1:27017/hashdb#section',
        database: undefined,
        user: undefined,
      })
    )
    expect(hashOnlyCfg.dbName).toBe('hashdb')
    const ipv6NoUrlCfg = await buildMongoConnectionConfig(
      makeMongoProfile({
        host: '::1',
        port: undefined,
        user: 'alice',
        database: 'ipv6db',
      }),
      'pw'
    )
    expect(ipv6NoUrlCfg.uri).toContain('alice:pw@[::1]:27017/ipv6db')

    // parseMongoStatement sanity
    expect(parseMongoStatement('show collections').kind).toBe('show_collections')
    expect(splitMongoScriptStatements('db.a.find({}); // comment\n db.b.find({})').length).toBe(2)
  })

  it('exercises live MongoDB 7 replica set CRUD, introspection, views, indexes, transactions, and shell commands', async () => {
    const driver = new MongoDriver()
    const okConn = await driver.testConnection(makeMongoProfile())
    expect(okConn.ok).toBe(true)

    const badConn = await driver.testConnection(
      makeMongoProfile({
        port: 59998,
        options: JSON.stringify({ serverSelectionTimeoutMS: 300, connectTimeoutMS: 300 }),
      })
    )
    expect(badConn.ok).toBe(false)

    const sess = await driver.createSession(makeMongoProfile())
    try {
      expect(sess.isAlive()).toBe(true)
      expect((await sess.test()).ok).toBe(true)

      const schemas = await sess.listSchemas()
      expect(schemas.defaultSchema).toBe(LIVE_MONGO_DB)

      // Seed collection with rich BSON types & create view + drop collection
      const seedRes = await sess.runQuery(
        'seed-script',
        `
        use ${LIVE_MONGO_DB};
        db.createCollection('orders');
        db.orders.insertOne({ code: 'A1', amount: NumberDecimal('12.50'), qty: NumberInt(2), big: Long.fromString('9001'), tag: 'vip', createdAt: ISODate('2025-01-01T00:00:00Z'), meta: { city: 'HN' } });
        db.orders.insertMany([
          { code: 'A2', amount: NumberDecimal('20.00'), qty: 5, tag: 'std', extraCol: 'dynamic' },
          { code: 'A3', amount: NumberDecimal('30.00'), qty: 1, tag: 'vip' }
        ]);
        db.runCommand({ create: 'vip_orders', viewOn: 'orders', pipeline: [{ $match: { tag: 'vip' } }] });
        show dbs;
        show collections;
        orders;
        { ping: 1 };
        db.stats();
        db.serverStatus();
        db.getCollectionNames();
        db.adminCommand({ ping: 1 });
        `
      )
      expect(seedRes.resultSets?.length).toBeGreaterThanOrEqual(8)

      // Shell queries & chains on live collection
      const findChain = await sess.runQuery(
        'find-chains',
        `
        db.orders.find({}).sort({ qty: -1 }).skip(0).limit(2).projection({ code: 1, qty: 1 }).toArray();
        db.orders.find({}).project({ code: 1 }).count();
        db.orders.find({ tag: 'vip' }).explain('queryPlanner');
        db.orders.findOne({ code: 'A1' });
        db.orders.aggregate([{ $match: { qty: { $gte: 1 } } }, { $sort: { qty: 1 } }]).explain();
        db.orders.aggregate([{ $group: { _id: '$tag', total: { $sum: '$qty' } } }]);
        db.orders.countDocuments({ tag: 'vip' });
        db.orders.estimatedDocumentCount();
        db.orders.distinct('tag', {});
        db.orders.createIndex({ code: 1 }, { name: 'idx_code_1' });
        db.orders.getIndexes();
        db.orders.indexes();
        db.orders.stats();
        `
      )
      expect(findChain.resultSets?.length).toBe(13)

      // Mutation shell methods + index drop + rename + drop + dropDatabase on temp db
      await sess.runQuery(
        'mut-shell',
        `
        db.orders.updateOne({ code: 'A2' }, { $set: { qty: 6 } });
        db.orders.updateMany({ tag: 'vip' }, { $inc: { qty: 1 } });
        db.orders.replaceOne({ code: 'A3' }, { code: 'A3', amount: NumberDecimal('31.00'), qty: 9, tag: 'vip' });
        db.orders.findOneAndUpdate({ code: 'A1' }, { $set: { noted: true } }, { returnDocument: 'after' });
        db.orders.findOneAndDelete({ code: 'NONE' });
        db.orders.dropIndex('idx_code_1');
        db.orders.dropIndexes();
        db.createCollection('tmp_ren');
        db.tmp_ren.renameCollection('tmp_ren2');
        db.tmp_ren2.insertOne({ x: 1 });
        db.tmp_ren2.deleteOne({ x: 1 });
        db.tmp_ren2.deleteMany({});
        db.tmp_ren2.drop();
        use ${LIVE_MONGO_DROP_DB};
        db.createCollection('scratch');
        db.dropDatabase();
        `
      )

      // Error branches on runQuery
      await expect(sess.runQuery('empty', '   ')).rejects.toThrow()
      await expect(sess.runQuery('bad-chain', 'db.orders.insertOne({}).limit(1)')).rejects.toThrow()
      await expect(sess.runQuery('bad-db-method', 'db.noSuchMethod()')).rejects.toThrow()
      await expect(sess.runQuery('bad-create-coll', 'db.createCollection()')).rejects.toThrow()
      await expect(sess.runQuery('bad-admin', 'db.adminCommand("nope")')).rejects.toThrow()

      // Introspection & DDL & Export
      const objects = await sess.listObjects(LIVE_MONGO_DB)
      expect(objects.some((o) => o.name === 'orders' && o.kind === 'table')).toBe(true)
      expect(objects.some((o) => o.name === 'vip_orders' && o.kind === 'view')).toBe(true)

      const details1 = await sess.getTableDetails('orders', LIVE_MONGO_DB)
      const details2 = await sess.getTableDetails('orders', LIVE_MONGO_DB) // cache hit
      expect(details2.columns.length).toBe(details1.columns.length)
      expect(await sess.getDdl('orders', LIVE_MONGO_DB)).toContain('orders')
      expect(await sess.getObjectDdl('vip_orders', 'view', LIVE_MONGO_DB)).toContain('vip_orders')
      expect(await sess.getObjectDdl('idx_1', 'index', LIVE_MONGO_DB)).toContain('MongoDB index')

      const exported = await sess.exportSchemaDdl(LIVE_MONGO_DB)
      expect(exported.objectCount).toBeGreaterThanOrEqual(2)
      expect(exported.ddl).toContain('Datanoa MongoDB Schema Export')

      // fetchPage variations: JSON filter, SQL filter, orderByClause JSON & SQL, dynamic column merge, view readOnly
      const p1 = await sess.fetchPage({
        table: 'orders',
        schema: LIVE_MONGO_DB,
        page: 1,
        pageSize: 1,
        whereClause: "{ tag: 'std' }",
        orderByClause: '{ qty: -1 }',
      })
      expect(p1.rows.length).toBe(1)

      const p2 = await sess.fetchPage({
        table: 'orders',
        schema: LIVE_MONGO_DB,
        page: 1,
        pageSize: 10,
        whereClause: "tag = 'vip' AND qty >= 1",
        orderByClause: 'ORDER BY "code" ASC, [qty] DESC, `tag` ASC',
      })
      expect(p2.rows.length).toBeGreaterThanOrEqual(1)

      const p3 = await sess.fetchPage({
        table: 'orders',
        schema: LIVE_MONGO_DB,
        page: 1,
        pageSize: 10,
        sortColumn: 'code',
        sortDirection: 'DESC',
      })
      expect(p3.canEdit).toBe(true)

      const pView = await sess.fetchPage({
        table: 'vip_orders',
        schema: LIVE_MONGO_DB,
        page: 1,
        pageSize: 10,
      })
      expect(pView.canEdit).toBe(false)

      await expect(
        sess.fetchPage({ table: 'orders', page: 1, pageSize: 10, whereClause: '{ bad' })
      ).rejects.toThrow()
      await expect(
        sess.fetchPage({ table: 'orders', page: 1, pageSize: 10, whereClause: 'a ~~ 1' })
      ).rejects.toThrow()

      // Live updateCell, previewChanges, applyChanges inside Auto-Commit withTransaction AND manual multi-doc tx!
      const docA1 = (p3.rows as unknown as Array<Record<string, unknown>>).find(
        (r) => r.code === 'A1'
      )
      expect(docA1).toBeDefined()
      const a1Id = docA1!._id

      const updRes = await sess.updateCell({
        table: 'orders',
        schema: LIVE_MONGO_DB,
        primaryKeys: { _id: a1Id },
        column: 'meta.city',
        originalValue: 'HN',
        newValue: 'SGN',
      })
      expect(updRes.ok).toBe(true)
      expect(updRes.affectedRows).toBe(1)

      // Conflict check
      await expect(
        sess.updateCell({
          table: 'orders',
          schema: LIVE_MONGO_DB,
          primaryKeys: { _id: a1Id },
          column: 'meta.city',
          originalValue: 'WRONG',
          newValue: 'DN',
        })
      ).rejects.toThrow(/conflict/i)

      // Preview & applyChanges (insert -> update -> delete) inside live transaction commit & rollback
      const txBegin = await sess.beginTransaction()
      expect(txBegin.active).toBe(true)
      await expect(sess.beginTransaction()).rejects.toThrow(/already active/i)
      await expect(sess.setAutoCommit(true)).rejects.toThrow(/active transaction/i)

      const txId = new ObjectId().toHexString()
      const preview = await sess.previewChanges({
        table: 'orders',
        schema: LIVE_MONGO_DB,
        inserts: [{ _id: txId, code: 'TX1', amount: '5.5', qty: 1 }],
      })
      expect(preview.statements).toHaveLength(1)

      await sess.applyChanges({
        table: 'orders',
        schema: LIVE_MONGO_DB,
        inserts: [{ _id: txId, code: 'TX1', amount: Decimal128.fromString('5.50'), qty: 2 }],
      })
      await sess.applyChanges({
        table: 'orders',
        schema: LIVE_MONGO_DB,
        updates: [
          {
            primaryKeys: { _id: txId },
            changes: { qty: 3 },
            originalRow: { qty: 2 },
          },
        ],
      })
      const rbState = await sess.rollbackTransaction()
      expect(rbState.active).toBe(false)

      // Verify rollback removed TX1
      const afterRb = await sess.runQuery('after-rb', `db.orders.find({ code: 'TX1' })`)
      expect(afterRb.rowCount).toBe(0)

      // Manual autoCommit=false auto-starts tx on applyChanges and commits
      await sess.setAutoCommit(false)
      await sess.applyChanges({
        table: 'orders',
        schema: LIVE_MONGO_DB,
        inserts: [{ code: 'TX_COMMIT', qty: 4 }],
      })
      expect(sess.getTransactionState().active).toBe(true)
      await sess.commitTransaction()
      await sess.setAutoCommit(true)

      // Delete committed doc using withTransaction (live auto-commit replica-set tx!) + test coercion columnTypes
      const committedRes = await sess.runQuery('find-txc', `db.orders.find({ code: 'TX_COMMIT' })`)
      expect(committedRes.rowCount).toBe(1)
      const typedOid = new ObjectId().toHexString()
      const typedUuid = '11111111-2222-4333-8444-555555555555'
      await sess.applyChanges({
        table: 'orders',
        schema: LIVE_MONGO_DB,
        columnTypes: {
          oidCol: 'ObjectId',
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
        inserts: [
          {
            oidCol: typedOid,
            decCol: '42.5',
            lngCol: '9007199254740993',
            intCol: '12',
            dblCol: '3.14',
            boolCol: 'true',
            dtCol: '2025-03-01T00:00:00Z',
            uidCol: typedUuid,
            objCol: '{ nested: 1 }',
            arrCol: '[1, 2]',
            code: 'TYPED_INS',
          },
        ],
      })
      const typedDocRes = await sess.runQuery('find-typed', `db.orders.find({ code: 'TYPED_INS' })`)
      const typedId = typedDocRes.rows[0][0]
      await sess.applyChanges({
        table: 'orders',
        schema: LIVE_MONGO_DB,
        columnTypes: {
          decCol: 'Decimal128',
          lngCol: 'Long',
          dblCol: 'Double',
          dtCol: 'Date',
          uidCol: 'UUID',
          binCol: 'Binary',
        },
        updates: [
          {
            primaryKeys: { _id: typedId },
            changes: { decCol: 99.5, lngCol: 77, boolCol: false },
            originalRow: {
              decCol: '42.5',
              lngCol: '9007199254740993',
              dblCol: 3.14,
              dtCol: '2025-03-01T00:00:00Z',
              uidCol: typedUuid,
              binCol: '[BLOB 12 B]',
            },
          },
        ],
        deletes: [{ _id: committedRes.rows[0][0] }],
      })

      // Live cancelQuery + additional shell arg error paths + aggregate explain
      const slowQuery = sess
        .runQuery('slow-find', `db.orders.find({ $where: 'sleep(600) || true' }).toArray()`)
        .catch((err: unknown) => err)
      await new Promise((r) => setTimeout(r, 40))
      await sess.cancelQuery('slow-find')
      await slowQuery

      for (const badShell of [
        'db.orders.insertOne(123)',
        'db.orders.insertMany(123)',
        'db.orders.updateOne(123, {})',
        'db.orders.replaceOne(123, {})',
        'db.orders.deleteOne({ $unknownOp: 1 })',
        'db.orders.findOneAndUpdate(123, {})',
        'db.orders.findOneAndDelete({}).limit(1)',
        'db.orders.createIndex(123)',
        'db.orders.dropIndex()',
        'db.orders.renameCollection("")',
        'db.orders.distinct()',
      ]) {
        await expect(sess.runQuery('bad-arg', badShell)).rejects.toThrow()
      }

      const emptyChanges = await sess.applyChanges({ table: 'orders', schema: LIVE_MONGO_DB })
      expect(emptyChanges).toEqual({ ok: true, inserted: 0, updated: 0, deleted: 0, statements: [] })

      await expect(sess.commitTransaction()).rejects.toThrow(/no active/i)
      await expect(sess.rollbackTransaction()).rejects.toThrow(/no active/i)
      expect((await sess.cancelQuery('missing-qid')).ok).toBe(true)
    } finally {
      await sess.close()
    }

    // Read-only MongoSession + closed guards
    const roSess = await driver.createSession(makeMongoProfile({ readOnly: true }))
    try {
      await expect(roSess.runQuery('ro-mut', 'db.orders.insertOne({ a: 1 })')).rejects.toThrow(
        /Read-Only/i
      )
      await expect(
        roSess.updateCell({
          table: 'orders',
          primaryKeys: { _id: '1' },
          column: 'qty',
          originalValue: 1,
          newValue: 2,
        })
      ).rejects.toThrow(/Read-Only/i)
    } finally {
      await roSess.close()
      expect(roSess.isAlive()).toBe(false)
      await expect(roSess.listSchemas()).rejects.toThrow(/closed/i)
    }
  }, 30000)

  it('covers MongoDB standalone transaction fallback & compensating rollback + close/cancel races via mock factory', async () => {
    let docs: Array<Record<string, unknown>> = [
      { _id: 'id-1', name: 'One', val: 1 },
      { _id: 'id-2', name: 'Two', val: 2 },
    ]
    let failSecondUpdate = true
    let forceCloseDelay = false

    const standaloneErr = Object.assign(new Error('Transaction numbers are only allowed on a replica set member'), {
      code: 20,
      codeName: 'IllegalOperation',
    })

    const mockFactory: MongoClientFactory = () => {
      const mockClient: MongoClientLike = {
        connect: async () => ({}),
        close: async () => {
          if (forceCloseDelay) throw new Error('close boom')
        },
        startSession: () => ({
          inTransaction: () => false,
          startTransaction: () => {},
          commitTransaction: async () => {},
          abortTransaction: async () => {},
          withTransaction: async () => {
            throw standaloneErr
          },
          endSession: async () => {},
        }),
        db: () => ({
          databaseName: 'mockdb',
          admin: () => ({
            listDatabases: async () => ({ databases: [{ name: 'mockdb' }] }),
            command: async () => ({ ok: 1 }),
            serverStatus: async () => ({ ok: 1 }),
          }),
          command: async () => ({ ok: 1 }),
          listCollections: () => ({ toArray: async () => [{ name: 'items', type: 'collection' }] }),
          createCollection: async () => ({}),
          stats: async () => ({ ok: 1 }),
          collection: () => ({
            collectionName: 'items',
            find: () => {
              const cursor = {
                sort: () => cursor,
                skip: () => cursor,
                limit: () => cursor,
                project: () => cursor,
                explain: async () => ({ ok: 1 }),
                toArray: async () => docs.map((d) => ({ ...d })),
                close: async () => {},
              }
              return cursor
            },
            findOne: async (filter?: Record<string, unknown>) => {
              const found = docs.find((d) => d._id === filter?._id)
              return found ? { ...found } : null
            },
            countDocuments: async () => docs.length,
            estimatedDocumentCount: async () => docs.length,
            indexes: async () => [{ name: '_id_', key: { _id: 1 } }],
            aggregate: () => ({
              toArray: async () => [],
              close: async () => {},
            }),
            distinct: async () => [],
            insertOne: async (doc: Record<string, unknown>) => {
              if (failSecondUpdate && doc.name === 'FailInsert') {
                throw new Error('insert failed mid-fallback')
              }
              const id = doc._id ?? 'gen-id'
              docs.push({ ...doc, _id: id })
              return { acknowledged: true, insertedId: id }
            },
            insertMany: async () => ({ acknowledged: true, insertedCount: 0 }),
            updateOne: async (filter: Record<string, unknown>, upd: Record<string, unknown>) => {
              const target = docs.find((d) => d._id === filter._id)
              if (!target) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
              Object.assign(target, (upd.$set as Record<string, unknown>) || {})
              return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
            },
            updateMany: async () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0 }),
            replaceOne: async (filter: Record<string, unknown>, rep: Record<string, unknown>) => {
              const idx = docs.findIndex((d) => d._id === filter._id)
              if (idx >= 0) docs[idx] = { ...rep }
              return { acknowledged: true, matchedCount: idx >= 0 ? 1 : 0, modifiedCount: 1 }
            },
            deleteOne: async (filter: Record<string, unknown>) => {
              const before = docs.length
              docs = docs.filter((d) => d._id !== filter._id)
              return { acknowledged: true, deletedCount: before - docs.length }
            },
            deleteMany: async () => ({ acknowledged: true, deletedCount: 0 }),
            findOneAndUpdate: async () => null,
            findOneAndDelete: async () => null,
            createIndex: async () => 'idx',
            dropIndex: async () => ({ ok: 1 }),
            dropIndexes: async () => ({ ok: 1 }),
            drop: async () => true,
            rename: async () => ({ ok: 1 }),
          }),
        }),
      }
      return mockClient
    }

    const driver = new MongoDriver(mockFactory)
    const sess = await driver.createSession(makeMongoProfile({ database: 'mockdb' }))
    try {
      // Compensating rollback restores deleted/updated/inserted on mid-batch failure
      await expect(
        sess.applyChanges({
          table: 'items',
          deletes: [{ _id: 'id-1' }],
          deleteRows: [{ _id: 'id-1', name: 'One', val: 1 }],
          updates: [{ primaryKeys: { _id: 'id-2' }, changes: { val: 99 }, originalRow: { val: 2 } }],
          inserts: [{ _id: 'id-3', name: 'FailInsert', val: 3 }],
        })
      ).rejects.toThrow(/insert failed mid-fallback/i)
      expect(docs.find((d) => d._id === 'id-1')).toBeTruthy()
      expect(docs.find((d) => d._id === 'id-2')?.val).toBe(2)

      // Successful standalone fallback
      failSecondUpdate = false
      const res = await sess.applyChanges({
        table: 'items',
        deletes: [{ _id: 'id-1' }],
        updates: [{ primaryKeys: { _id: 'id-2' }, changes: { val: 42 } }],
        inserts: [{ _id: 'id-4', name: 'Four', val: 4 }],
      })
      expect(res).toMatchObject({ ok: true, deleted: 1, updated: 1, inserted: 1 })
      expect(docs.find((d) => d._id === 'id-4')).toBeTruthy()

      // Validate bad inputs in buildChangePlan
      await expect(
        sess.applyChanges({
          table: 'items',
          deletes: [{ _id: 'id-2' }],
          deleteRows: [],
        })
      ).rejects.toThrow(/deleteRows length/i)
      await expect(
        sess.applyChanges({
          table: 'items',
          deletes: [{ __proto__: 'bad' } as Record<string, unknown>],
        })
      ).rejects.toThrow(/Disallowed field path|Primary key/i)
      await expect(
        sess.applyChanges({
          table: 'items',
          deletes: [{ _id: 'id-2' }],
          deleteRows: ['not-obj' as unknown as Record<string, unknown>],
        })
      ).rejects.toThrow(/must be a row object/i)
    } finally {
      forceCloseDelay = true
      await sess.close()
    }
  })

  it('exercises live CockroachDB 25.1.0 via PostgresDriver (introspection, DDL, CRUD, savepoint rollback, readOnly, closed guards)', async () => {
    const driver = new PostgresDriver()
    const okConn = await driver.testConnection(makeCrdbProfile())
    expect(okConn.ok).toBe(true)

    const sess = await driver.createSession(makeCrdbProfile())
    try {
      await sess.runQuery(
        'crdb-ddl',
        `
        CREATE TABLE ${LIVE_CRDB_SCHEMA}.departments (
          id INT PRIMARY KEY,
          code STRING UNIQUE NOT NULL
        );
        CREATE TABLE ${LIVE_CRDB_SCHEMA}.employees (
          id INT PRIMARY KEY,
          dept_id INT REFERENCES ${LIVE_CRDB_SCHEMA}.departments(id),
          name STRING NOT NULL,
          tags STRING[]
        );
        CREATE INDEX idx_emp_name ON ${LIVE_CRDB_SCHEMA}.employees (name);
        CREATE VIEW ${LIVE_CRDB_SCHEMA}.v_emp AS SELECT id, name FROM ${LIVE_CRDB_SCHEMA}.employees;
        INSERT INTO ${LIVE_CRDB_SCHEMA}.departments (id, code) VALUES (1, 'ENG'), (2, 'OPS');
        INSERT INTO ${LIVE_CRDB_SCHEMA}.employees (id, dept_id, name, tags) VALUES (10, 1, 'Alice', ARRAY['core','sql']), (11, 2, 'Bob', ARRAY['ops']);
        `
      )

      const schemas = await sess.listSchemas()
      expect(schemas.schemas).toContain(LIVE_CRDB_SCHEMA)
      expect(await sess.listObjects(LIVE_CRDB_SCHEMA)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'departments', kind: 'table' }),
          expect.objectContaining({ name: 'v_emp', kind: 'view' }),
        ])
      )
      // Default schema ('public') branch
      await sess.listObjects(undefined)

      const empDetails = await sess.getTableDetails('employees', LIVE_CRDB_SCHEMA)
      expect(empDetails.primaryKey).toEqual(['id'])
      expect(await sess.getObjectDdl('employees', 'table', LIVE_CRDB_SCHEMA)).toContain('CREATE TABLE')
      expect(await sess.getObjectDdl('v_emp', 'view', LIVE_CRDB_SCHEMA)).toContain('v_emp')

      const exported = await sess.exportSchemaDdl(LIVE_CRDB_SCHEMA)
      expect(exported.objectCount).toBeGreaterThanOrEqual(3)

      const page = await sess.fetchPage({
        table: 'employees',
        schema: LIVE_CRDB_SCHEMA,
        page: 1,
        pageSize: 10,
      })
      expect(page.totalRows).toBe(2)

      // Update cell & applyChanges in pinned tx (plus savepoint failure rollback!)
      await sess.updateCell({
        table: 'employees',
        schema: LIVE_CRDB_SCHEMA,
        primaryKeys: { id: 10 },
        column: 'name',
        originalValue: 'Alice',
        newValue: 'Alice-Updated',
      })

      await sess.beginTransaction()
      await sess.applyChanges({
        table: 'employees',
        schema: LIVE_CRDB_SCHEMA,
        inserts: [{ id: 12, dept_id: 1, name: 'Carol' }],
      })
      await expect(
        sess.applyChanges({
          table: 'employees',
          schema: LIVE_CRDB_SCHEMA,
          inserts: [{ id: 10, dept_id: 999, name: 'DupOrBadFk' }],
        })
      ).rejects.toThrow()
      const rb = await sess.rollbackTransaction()
      expect(rb.active).toBe(false)

      await sess.setAutoCommit(false)
      await sess.runQuery('crdb-auto-tx', `UPDATE ${LIVE_CRDB_SCHEMA}.employees SET name = 'Bob2' WHERE id = 11;`)
      await sess.commitTransaction()
      await sess.setAutoCommit(true)
    } finally {
      await sess.close()
    }

    // Closed guards
    await expect(sess.test()).resolves.toMatchObject({ ok: false })
    await expect(sess.runQuery('closed', 'SELECT 1')).rejects.toThrow(/closed/i)
    await expect(sess.fetchPage({ table: 'employees', schema: LIVE_CRDB_SCHEMA, page: 1, pageSize: 5 })).rejects.toThrow(/closed/i)
    await expect(
      sess.updateCell({
        table: 'employees',
        schema: LIVE_CRDB_SCHEMA,
        primaryKeys: { id: 10 },
        column: 'name',
        originalValue: 'x',
        newValue: 'y',
      })
    ).rejects.toThrow(/closed/i)
    await expect(sess.applyChanges({ table: 'employees', schema: LIVE_CRDB_SCHEMA, inserts: [{ id: 99 }] })).rejects.toThrow(/closed/i)
    await expect(sess.beginTransaction()).rejects.toThrow(/closed/i)
    await expect(sess.commitTransaction()).rejects.toThrow(/closed/i)
    await expect(sess.rollbackTransaction()).rejects.toThrow(/closed/i)

    // Read-only CockroachDB + cloud-SSL auto default fallback branch (insecure server rejects TLS)
    const roSess = await driver.createSession(makeCrdbProfile({ readOnly: true }))
    try {
      await expect(
        roSess.runQuery('crdb-ro', `INSERT INTO ${LIVE_CRDB_SCHEMA}.departments VALUES (9, 'RO')`)
      ).rejects.toThrow()
    } finally {
      await roSess.close()
    }

    // Undefined ssl & port defaults for cockroachdb
    const badSsl = await driver.testConnection(
      makeCrdbProfile({ port: undefined, database: undefined, ssl: undefined })
    )
    expect(badSsl.ok).toBe(false)
  }, 30000)

  it('exercises DriverManager BYOD discovery, CJS/ESM loading, package.json resolution, TOCTOU SHA-256 verification, and PBT', async () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), (raw) => {
        const valid = (BYOD_DRIVER_IDS as readonly string[]).includes(raw)
        expect(isByodDriverId(raw)).toBe(valid)
        const port = getByodDefaultPort(raw)
        expect(typeof port).toBe('number')
      }),
      { numRuns: 50 }
    )
    expect(BYOD_DRIVER_SLOTS.length).toBeGreaterThanOrEqual(7)
    expect(getByodDefaultPort('duckdb')).toBe(0)
    expect(getByodDefaultPort('snowflake')).toBe(443)
    expect(getByodDefaultPort('cassandra')).toBe(9042)
    expect(getByodDefaultPort('elasticsearch')).toBe(9200)
    expect(getByodDefaultPort('neo4j')).toBe(7687)

    const makeAdapterSource = (driverId: string, format: 'cjs' | 'esm' | 'factory', extra = '') => {
      const body = `{
        type: '${driverId}',
        createSession: async () => ({}) ,
        testConnection: async () => ({ ok: true })
      }`
      if (format === 'cjs') return `module.exports = ${body}; ${extra}`
      if (format === 'factory') return `export function createDriver() { return ${body}; } ${extra}`
      return `export default ${body}; ${extra}`
    }

    const memStore = new Map<string, unknown>()
    const logs: string[] = []
    const mgr = new DriverManager(
      {
        get: async (k) => memStore.get(k) as never,
        set: async (k, v) => {
          memStore.set(k, v)
        },
        delete: async (k) => {
          memStore.delete(k)
        },
      },
      (msg) => logs.push(msg)
    )

    // Backup loader restoration path
    let backupCalls = 0
    mgr.setBackupLoader(async () => {
      backupCalls++
      throw new Error('backup error tolerated')
    })
    const initialList = await mgr.listDrivers()
    expect(backupCalls).toBe(1)
    expect(initialList.some((d) => d.status === 'builtin')).toBe(true)

    const rootDir = makeTempDir('datanoa-byod-')
    const cjsFile = path.join(rootDir, 'duck.cjs')
    fs.writeFileSync(cjsFile, makeAdapterSource('duckdb', 'cjs'), 'utf8')

    // Invalid IDs & missing paths & control chars & bad extensions
    await expect(mgr.inspectLocalDriver({ driverId: 'postgres', localPath: cjsFile })).rejects.toThrow(/built-in/i)
    await expect(mgr.inspectLocalDriver({ driverId: '1bad', localPath: cjsFile })).rejects.toThrow(/Driver ID/i)
    await expect(mgr.resolveEntryFile('')).rejects.toThrow(/required/i)
    await expect(mgr.resolveEntryFile('bad\u0001path')).rejects.toThrow(/control/i)
    await expect(mgr.resolveEntryFile(path.join(rootDir, 'missing.js'))).rejects.toThrow(/does not exist/i)
    const badExt = path.join(rootDir, 'bad.ts')
    fs.writeFileSync(badExt, 'export default {}', 'utf8')
    await expect(mgr.resolveEntryFile(badExt)).rejects.toThrow(/\.mjs, \.cjs, or \.js/i)

    // Directory with package.json variants
    const pkgDir = path.join(rootDir, 'pkg-exports')
    fs.mkdirSync(pkgDir)
    const entryMjs = path.join(pkgDir, 'driver.mjs')
    fs.writeFileSync(entryMjs, makeAdapterSource('custom', 'factory'), 'utf8')
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ exports: { '.': { import: './driver.mjs' } } }),
      'utf8'
    )
    const inspectCustom = await mgr.inspectLocalDriver({ driverId: 'custom', localPath: pkgDir })
    expect(inspectCustom.resolvedEntry).toBe(fs.realpathSync(entryMjs))

    // Configure & cache & verify CJS duckdb driver
    const inspectDuck = await mgr.inspectLocalDriver({ driverId: 'duckdb', localPath: cjsFile })
    await expect(
      mgr.configureLocalDriver({ driverId: 'duckdb', localPath: cjsFile })
    ).rejects.toThrow(/SHA-256 trust/i)
    await expect(
      mgr.configureLocalDriver({ driverId: 'duckdb', localPath: cjsFile, trustedSha256: '0'.repeat(64) })
    ).rejects.toThrow(/mismatch/i)

    const configured = await mgr.configureLocalDriver({
      driverId: 'duckdb',
      localPath: cjsFile,
      name: '  My Local DuckDB  ',
      trustedSha256: inspectDuck.sha256,
    })
    expect(configured.status).toBe('local-verified')
    expect(mgr.getAdapter('duckdb')).toBeDefined()
    expect(mgr.getAdapter('duckdb', { resolvedEntry: 'wrong' })).toBeUndefined()
    expect(mgr.getAdapter('duckdb', { sha256: 'f'.repeat(64) })).toBeUndefined()
    expect(await mgr.resolveVerifiedAdapter('duckdb')).toBe(mgr.getAdapter('duckdb'))

    // Verify unchanged -> ok
    const vOk = await mgr.verifyLocalDriver('duckdb')
    expect(vOk.ok).toBe(true)
    expect(vOk.sha256Changed).toBe(false)

    // Modify file -> verify detects change and requires re-trust -> then explicit re-trust succeeds
    fs.writeFileSync(cjsFile, makeAdapterSource('duckdb', 'cjs', '/* v2 */'), 'utf8')
    const newSha = createHash('sha256').update(fs.readFileSync(cjsFile)).digest('hex')
    const vChanged = await mgr.verifyLocalDriver('duckdb')
    expect(vChanged.ok).toBe(false)
    expect(vChanged.requiresTrust).toBe(true)
    expect(vChanged.pendingSha256).toBe(newSha)

    const vRetrusted = await mgr.verifyLocalDriver('duckdb', { trustedSha256: newSha })
    expect(vRetrusted.ok).toBe(true)
    expect(vRetrusted.sha256Changed).toBe(true)

    // ESM module directory with type:module + .js file + configure custom factory adapter
    const esmDir = path.join(rootDir, 'pkg-esm')
    fs.mkdirSync(esmDir)
    fs.writeFileSync(path.join(esmDir, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }), 'utf8')
    fs.writeFileSync(path.join(esmDir, 'index.js'), makeAdapterSource('neo4j', 'esm'), 'utf8')
    const inspectNeo = await mgr.inspectLocalDriver({ driverId: 'neo4j', localPath: esmDir })
    const cfgNeo = await mgr.configureLocalDriver({
      driverId: 'neo4j',
      localPath: esmDir,
      trustedSha256: inspectNeo.sha256,
    })
    expect(cfgNeo.id).toBe('neo4j')

    // configure custom factory adapter & mismatch type check & invalid module check
    const cfgCustom = await mgr.configureLocalDriver({
      driverId: 'custom',
      localPath: pkgDir,
      trustedSha256: inspectCustom.sha256,
    })
    expect(cfgCustom.status).toBe('local-verified')

    const wrongTypeFile = path.join(rootDir, 'wrong.mjs')
    fs.writeFileSync(wrongTypeFile, makeAdapterSource('snowflake', 'esm'), 'utf8')
    const wrongInspect = await mgr.inspectLocalDriver({ driverId: 'cassandra', localPath: wrongTypeFile })
    await expect(
      mgr.configureLocalDriver({ driverId: 'cassandra', localPath: wrongTypeFile, trustedSha256: wrongInspect.sha256 })
    ).rejects.toThrow(/does not match/i)

    expect(() => mgr.validateDriverAdapterModule({ default: { type: '' } })).toThrow(/Invalid Datanoa/i)
    await expect(mgr.resolveVerifiedAdapter('bigquery')).rejects.toThrow(/not configured/i)
    expect((await mgr.verifyLocalDriver('bigquery')).ok).toBe(false)

    // Verify failure catch branch + directory error guards
    fs.unlinkSync(cjsFile)
    const vBroken = await mgr.verifyLocalDriver('duckdb')
    expect(vBroken.ok).toBe(false)
    expect(vBroken.item.status).toBe('local-error')

    // ESM .js without package.json (hits looksLikeEsmSyntax!), plus package.json exports/main edge variants
    const bareEsmFile = path.join(rootDir, 'bare-esm.js')
    fs.writeFileSync(bareEsmFile, makeAdapterSource('elasticsearch', 'esm'), 'utf8')
    const inspectEs = await mgr.inspectLocalDriver({ driverId: 'elasticsearch', localPath: bareEsmFile })
    const cfgEs = await mgr.configureLocalDriver({
      driverId: 'elasticsearch',
      localPath: bareEsmFile,
      trustedSha256: inspectEs.sha256,
    })
    expect(cfgEs.id).toBe('elasticsearch')
    expect(await mgr.removeLocalDriver('elasticsearch')).toEqual({ ok: true })

    // package.json exports string + default + main fallbacks + persisted invalid array filtering
    const expStrDir = path.join(rootDir, 'exp-str')
    fs.mkdirSync(expStrDir)
    fs.writeFileSync(path.join(expStrDir, 'entry.cjs'), makeAdapterSource('duckdb', 'cjs'), 'utf8')
    fs.writeFileSync(path.join(expStrDir, 'package.json'), JSON.stringify({ exports: './entry.cjs' }), 'utf8')
    expect((await mgr.resolveEntryFile(expStrDir)).endsWith('entry.cjs')).toBe(true)

    const expDefDir = path.join(rootDir, 'exp-def')
    fs.mkdirSync(expDefDir)
    fs.writeFileSync(path.join(expDefDir, 'def.cjs'), makeAdapterSource('duckdb', 'cjs'), 'utf8')
    fs.writeFileSync(path.join(expDefDir, 'package.json'), JSON.stringify({ exports: { default: './def.cjs' } }), 'utf8')
    expect((await mgr.resolveEntryFile(expDefDir)).endsWith('def.cjs')).toBe(true)

    const fallbackCjsDir = path.join(rootDir, 'fallback-cjs')
    fs.mkdirSync(fallbackCjsDir)
    fs.writeFileSync(path.join(fallbackCjsDir, 'index.cjs'), makeAdapterSource('duckdb', 'cjs'), 'utf8')
    fs.writeFileSync(path.join(fallbackCjsDir, 'package.json'), JSON.stringify({ main: 'index.js' }), 'utf8')
    expect((await mgr.resolveEntryFile(fallbackCjsDir)).endsWith('index.cjs')).toBe(true)

    // Invalid persisted entries filtered out by normalizePersistedConfig
    const mgrFiltered = new DriverManager(
      {
        get: async () =>
          [
            null,
            { id: 'postgres', localPath: cjsFile, resolvedEntry: cjsFile, sha256: 'a'.repeat(64), verifiedAt: 1 },
            { id: '1bad', localPath: cjsFile, resolvedEntry: cjsFile, sha256: 'a'.repeat(64), verifiedAt: 1 },
            { id: 'custom', localPath: cjsFile, resolvedEntry: cjsFile, sha256: 'short', verifiedAt: 1 },
          ] as never,
        set: async () => {},
        delete: async () => {},
      },
      () => {}
    )
    expect((await mgrFiltered.listDrivers()).every((d) => d.status !== 'local-verified')).toBe(true)

    // Escape & bad package.json checks
    const badPkgDir = path.join(rootDir, 'bad-pkg')
    fs.mkdirSync(badPkgDir)
    fs.writeFileSync(path.join(badPkgDir, 'package.json'), '{bad json', 'utf8')
    await expect(mgr.resolveEntryFile(badPkgDir)).rejects.toThrow(/Cannot parse package\.json/i)
    fs.writeFileSync(path.join(badPkgDir, 'package.json'), JSON.stringify({ main: '../escape.js' }), 'utf8')
    await expect(mgr.resolveEntryFile(badPkgDir)).rejects.toThrow(/escapes/i)
    fs.writeFileSync(path.join(badPkgDir, 'package.json'), JSON.stringify({ exports: '  ' }), 'utf8')
    await expect(mgr.resolveEntryFile(badPkgDir)).rejects.toThrow(/No driver entry found/i)

    // Restore from backup loader into fresh manager
    const mgr2 = new DriverManager(
      { get: async () => undefined, set: async (k, v) => { memStore.set(k, v) }, delete: async () => {} },
      () => {}
    )
    mgr2.setBackupLoader(async () => memStore.get('datanoa.customDrivers') as never)
    expect((await mgr2.listDrivers()).some((d) => d.id === 'neo4j' && d.status === 'local-verified')).toBe(true)

    expect(await mgr.removeLocalDriver('')).toEqual({ ok: false })
    expect(await mgr.removeLocalDriver('duckdb')).toEqual({ ok: true })
    expect(await mgr.removeLocalDriver('neo4j')).toEqual({ ok: true })
    expect(await mgr.removeLocalDriver('custom')).toEqual({ ok: true })
  }, 30000)
})
