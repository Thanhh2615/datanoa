import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BSONRegExp,
  Binary,
  Decimal128,
  Int32,
  Long,
  ObjectId,
  Timestamp,
  UUID,
  type MongoClientOptions,
} from '../vendor/mongodb.js'
import { getCanonicalByodStarterCode } from '../src/drivers/common/byod-templates'
import { ClickHouseDriver } from '../src/drivers/clickhouse/driver'
import { DriverManager } from '../src/drivers/driver-manager'
import {
  MongoDriver,
  buildMongoConnectionConfig,
  hydrateEjsonValues,
  splitMongoScriptStatements,
  translateSqlFilterToMongoFilter,
  type MongoClientLike,
} from '../src/drivers/mongodb/driver'
import { RedisDriver } from '../src/drivers/redis/driver'
import {
  findCredentialAuthorityAtIndex,
  maskConnectionUriSecret,
  scrubSensitiveText,
} from '../src/shared-sql-safety.js'
import type { ConnectionProfile } from '../src/protocol'

interface FakeMongoRecording {
  uri: string
  options: MongoClientOptions
  closed: boolean
  commands: Array<{ db: string; cmd: Record<string, unknown>; options?: Record<string, unknown> }>
  finds: Array<{
    db: string
    coll: string
    filter: Record<string, unknown>
    sort?: Record<string, unknown>
    skip?: number
    limit?: number
    project?: Record<string, unknown>
    options?: Record<string, unknown>
  }>
  counts: Array<{ db: string; coll: string; filter: Record<string, unknown>; options?: Record<string, unknown> }>
  updates: Array<{ db: string; coll: string; filter: Record<string, unknown>; update: Record<string, unknown>; options?: Record<string, unknown> }>
  inserts: Array<{ db: string; coll: string; docs: Record<string, unknown>[]; options?: Record<string, unknown> }>
  deletes: Array<{ db: string; coll: string; filter: Record<string, unknown>; options?: Record<string, unknown> }>
  txEvents: string[]
}

function valuesEqualMongo(a: unknown, b: unknown): boolean {
  if (a instanceof ObjectId && b instanceof ObjectId) return a.toHexString() === b.toHexString()
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (a instanceof Decimal128 && b instanceof Decimal128) return a.toString() === b.toString()
  if (a instanceof Timestamp && b instanceof Timestamp) return a.toString() === b.toString()
  if (a instanceof Long && b instanceof Long) return a.toString() === b.toString()
  if (a instanceof UUID && b instanceof UUID) return a.toString() === b.toString()
  if (a instanceof Binary && b instanceof Binary) {
    return a.sub_type === b.sub_type && a.toString('base64') === b.toString('base64')
  }
  return Object.is(a, b)
}

function getDottedField(doc: Record<string, unknown>, pathKey: string): unknown {
  const parts = pathKey.split('.')
  let cur: unknown = doc
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function setDottedField(doc: Record<string, unknown>, pathKey: string, value: unknown): void {
  const parts = pathKey.split('.')
  let cur: Record<string, unknown> = doc
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    const next = cur[part]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cur[part] = {}
    }
    cur = cur[part] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}

function matchesFilterMongo(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [k, cond] of Object.entries(filter)) {
    if (k === '$and' && Array.isArray(cond)) {
      if (!cond.every((sub) => matchesFilterMongo(doc, sub as Record<string, unknown>))) return false
      continue
    }
    if (k === '$or' && Array.isArray(cond)) {
      if (!cond.some((sub) => matchesFilterMongo(doc, sub as Record<string, unknown>))) return false
      continue
    }
    const actual = getDottedField(doc, k)
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof ObjectId) && !(cond instanceof Date) && !(cond instanceof Decimal128) && !(cond instanceof Timestamp) && !(cond instanceof Long) && !(cond instanceof UUID) && !(cond instanceof Binary) && !(cond instanceof BSONRegExp) && !(cond instanceof RegExp)) {
      const ops = cond as Record<string, unknown>
      const keys = Object.keys(ops)
      if (keys.some((op) => op.startsWith('$'))) {
        if ('$in' in ops && Array.isArray(ops.$in)) {
          if (!ops.$in.some((item) => valuesEqualMongo(actual, item))) return false
        }
        if ('$nin' in ops && Array.isArray(ops.$nin)) {
          if (ops.$nin.some((item) => valuesEqualMongo(actual, item))) return false
        }
        if ('$ne' in ops) {
          if (ops.$ne === null ? actual === null || actual === undefined : valuesEqualMongo(actual, ops.$ne)) return false
        }
        if ('$gt' in ops && !(Number(actual) > Number(ops.$gt))) return false
        if ('$gte' in ops && !(Number(actual) >= Number(ops.$gte))) return false
        if ('$lt' in ops && !(Number(actual) < Number(ops.$lt))) return false
        if ('$lte' in ops && !(Number(actual) <= Number(ops.$lte))) return false
        if ('$exists' in ops) {
          const exists = actual !== undefined
          if (Boolean(ops.$exists) !== exists) return false
        }
        continue
      }
    }
    if (cond === null) {
      if (actual !== null && actual !== undefined) return false
    } else if (!valuesEqualMongo(actual, cond)) {
      return false
    }
  }
  return true
}

function createFakeMongoHarness(opts?: {
  databases?: Array<{ name: string; sizeOnDisk?: number; empty?: boolean }>
  listDatabasesError?: Error
  collectionsByDb?: Record<string, Array<{ name: string; type?: string; options?: Record<string, unknown> }>>
  docsByColl?: Record<string, Record<string, unknown>[]>
  indexesByColl?: Record<string, Record<string, unknown>[]>
  standaloneMode?: boolean
}) {
  const recording: FakeMongoRecording = {
    uri: '',
    options: {},
    closed: false,
    commands: [],
    finds: [],
    counts: [],
    updates: [],
    inserts: [],
    deletes: [],
    txEvents: [],
  }

  const docsByColl: Record<string, Record<string, unknown>[]> = {}
  for (const [k, list] of Object.entries(opts?.docsByColl ?? {})) {
    docsByColl[k] = list.map((d) => ({ ...d }))
  }
  const indexesByColl = opts?.indexesByColl ?? {}
  const collectionsByDb = opts?.collectionsByDb ?? {
    appdb: [{ name: 'users', type: 'collection' }],
  }

  const assertSessionSupported = (callOpts?: Record<string, unknown>): void => {
    if (opts?.standaloneMode && callOpts && 'session' in callOpts && callOpts.session) {
      const err = new Error('Transaction numbers are only allowed on a replica set member or mongos') as Error & { code: number }
      err.code = 20
      throw err
    }
  }

  const fakeClient: MongoClientLike = {
    async connect() {
      return fakeClient
    },
    async close() {
      recording.closed = true
    },
    db(dbName?: string) {
      const targetDb = dbName || 'appdb'
      return {
        databaseName: targetDb,
        admin() {
          return {
            async listDatabases() {
              if (opts?.listDatabasesError) throw opts.listDatabasesError
              return {
                databases: opts?.databases ?? [
                  { name: 'admin', sizeOnDisk: 1024, empty: false },
                  { name: 'appdb', sizeOnDisk: 4096, empty: false },
                ],
                ok: 1,
              }
            },
            async command(cmd: Record<string, unknown>, callOpts?: Record<string, unknown>) {
              assertSessionSupported(callOpts)
              recording.commands.push({ db: 'admin', cmd, options: callOpts })
              if ('serverStatus' in cmd) return { host: 'fake-mongo', ok: 1 }
              return { ok: 1 }
            },
            async serverStatus() {
              recording.commands.push({ db: 'admin', cmd: { serverStatus: 1 } })
              return { host: 'fake-mongo', ok: 1 }
            },
          }
        },
        async command(cmd: Record<string, unknown>, callOpts?: Record<string, unknown>) {
          assertSessionSupported(callOpts)
          recording.commands.push({ db: targetDb, cmd, options: callOpts })
          if ('ping' in cmd) return { ok: 1 }
          if ('collStats' in cmd) return { ns: `${targetDb}.${String(cmd.collStats)}`, count: 2, ok: 1 }
          if ('explain' in cmd) return { ok: 1, queryPlanner: { winningPlan: { stage: 'COLLSCAN' } } }
          return { ok: 1 }
        },
        listCollections(filter?: Record<string, unknown>) {
          const all = collectionsByDb[targetDb] ?? []
          const nameFilter = filter && typeof filter.name === 'string' ? filter.name : undefined
          const list = nameFilter ? all.filter((c) => c.name === nameFilter) : all
          return {
            async toArray() {
              return list
            },
          }
        },
        collection(name: string) {
          if (!docsByColl[name]) docsByColl[name] = []
          const getDocs = () => docsByColl[name]
          return {
            collectionName: name,
            find(filter: Record<string, unknown> = {}, callOpts?: Record<string, unknown>) {
              assertSessionSupported(callOpts)
              const entry: FakeMongoRecording['finds'][number] = {
                db: targetDb,
                coll: name,
                filter,
                options: callOpts,
              }
              recording.finds.push(entry)
              const cursor = {
                sort(s: Record<string, unknown>) {
                  entry.sort = s
                  return cursor
                },
                skip(v: number) {
                  entry.skip = v
                  return cursor
                },
                limit(v: number) {
                  entry.limit = v
                  return cursor
                },
                project(p: Record<string, unknown>) {
                  entry.project = p
                  return cursor
                },
                async explain(verbosity = 'queryPlanner') {
                  recording.commands.push({
                    db: targetDb,
                    cmd: { explain: { find: name, filter }, verbosity },
                    options: callOpts,
                  })
                  return { ok: 1, queryPlanner: { namespace: `${targetDb}.${name}`, verbosity } }
                },
                async toArray() {
                  const matched = getDocs().filter((d) => matchesFilterMongo(d, filter))
                  const start = entry.skip ?? 0
                  const end = entry.limit !== undefined && entry.limit > 0 ? start + entry.limit : matched.length
                  return matched.slice(start, end)
                },
              }
              return cursor
            },
            async findOne(filter: Record<string, unknown> = {}, callOpts?: Record<string, unknown>) {
              assertSessionSupported(callOpts)
              return getDocs().find((d) => matchesFilterMongo(d, filter)) ?? null
            },
            async countDocuments(filter: Record<string, unknown> = {}, callOpts?: Record<string, unknown>) {
              assertSessionSupported(callOpts)
              recording.counts.push({ db: targetDb, coll: name, filter, options: callOpts })
              return getDocs().filter((d) => matchesFilterMongo(d, filter)).length
            },
            async estimatedDocumentCount() {
              return getDocs().length
            },
            async indexes() {
              return indexesByColl[name] ?? [{ name: '_id_', key: { _id: 1 } }]
            },
            aggregate(pipeline: Record<string, unknown>[] = [], callOpts?: Record<string, unknown>) {
              assertSessionSupported(callOpts)
              const cursor = {
                async explain(verbosity = 'queryPlanner') {
                  recording.commands.push({
                    db: targetDb,
                    cmd: { explain: { aggregate: name, pipeline }, verbosity },
                    options: callOpts,
                  })
                  return { ok: 1, stages: [], queryPlanner: { namespace: `${targetDb}.${name}` } }
                },
                async toArray() {
                  recording.commands.push({
                    db: targetDb,
                    cmd: { aggregate: name, pipeline },
                    options: callOpts,
                  })
                  return getDocs()
                },
              }
              return cursor
            },
            async distinct(field: string, filter: Record<string, unknown> = {}, callOpts?: Record<string, unknown>) {
              assertSessionSupported(callOpts)
              const seen = new Set<unknown>()
              for (const d of getDocs()) {
                if (matchesFilterMongo(d, filter) && field in d) seen.add(d[field])
              }
              return Array.from(seen)
            },
            async insertOne(doc: Record<string, unknown>, callOpts?: Record<string, unknown>) {
              assertSessionSupported(callOpts)
              const inserted = { _id: new ObjectId(), ...doc }
              getDocs().push(inserted)
              recording.inserts.push({ db: targetDb, coll: name, docs: [inserted], options: callOpts })
              return { acknowledged: true, insertedId: inserted._id }
            },
            async insertMany(docs: Record<string, unknown>[], callOpts?: Record<string, unknown>) {
              assertSessionSupported(callOpts)
              const inserted = docs.map((d) => ({ _id: new ObjectId(), ...d }))
              getDocs().push(...inserted)
              recording.inserts.push({ db: targetDb, coll: name, docs: inserted, options: callOpts })
              return { acknowledged: true, insertedCount: inserted.length, insertedIds: {} }
            },
            async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, callOpts?: Record<string, unknown>) {
              assertSessionSupported(callOpts)
              recording.updates.push({ db: targetDb, coll: name, filter, update, options: callOpts })
              const doc = getDocs().find((d) => matchesFilterMongo(d, filter))
              if (!doc) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
              if (update.$set && typeof update.$set === 'object') {
                for (const [k, v] of Object.entries(update.$set as Record<string, unknown>)) {
                  setDottedField(doc, k, v)
                }
              }
              return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
            },
            async updateMany(filter: Record<string, unknown>, update: Record<string, unknown>, callOpts?: Record<string, unknown>) {
              assertSessionSupported(callOpts)
              recording.updates.push({ db: targetDb, coll: name, filter, update, options: callOpts })
              let matched = 0
              for (const doc of getDocs()) {
                if (!matchesFilterMongo(doc, filter)) continue
                matched++
                if (update.$set && typeof update.$set === 'object') {
                  for (const [k, v] of Object.entries(update.$set as Record<string, unknown>)) {
                    setDottedField(doc, k, v)
                  }
                }
              }
              return { acknowledged: true, matchedCount: matched, modifiedCount: matched }
            },
            async replaceOne(filter: Record<string, unknown>, replacement: Record<string, unknown>, callOpts?: Record<string, unknown>) {
              assertSessionSupported(callOpts)
              const idx = getDocs().findIndex((d) => matchesFilterMongo(d, filter))
              if (idx < 0) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
              const oldId = getDocs()[idx]._id
              getDocs()[idx] = { _id: oldId, ...replacement }
              return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
            },
            async deleteOne(filter: Record<string, unknown>, callOpts?: Record<string, unknown>) {
              assertSessionSupported(callOpts)
              recording.deletes.push({ db: targetDb, coll: name, filter, options: callOpts })
              const idx = getDocs().findIndex((d) => matchesFilterMongo(d, filter))
              if (idx < 0) return { acknowledged: true, deletedCount: 0 }
              getDocs().splice(idx, 1)
              return { acknowledged: true, deletedCount: 1 }
            },
            async deleteMany(filter: Record<string, unknown>, callOpts?: Record<string, unknown>) {
              assertSessionSupported(callOpts)
              recording.deletes.push({ db: targetDb, coll: name, filter, options: callOpts })
              const before = getDocs().length
              docsByColl[name] = getDocs().filter((d) => !matchesFilterMongo(d, filter))
              return { acknowledged: true, deletedCount: before - docsByColl[name].length }
            },
            async findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>, callOpts?: Record<string, unknown>) {
              assertSessionSupported(callOpts)
              recording.updates.push({ db: targetDb, coll: name, filter, update, options: callOpts })
              const doc = getDocs().find((d) => matchesFilterMongo(d, filter))
              if (!doc) return null
              if (update.$set && typeof update.$set === 'object') {
                for (const [k, v] of Object.entries(update.$set as Record<string, unknown>)) {
                  setDottedField(doc, k, v)
                }
              }
              return { ...doc }
            },
            async findOneAndDelete(filter: Record<string, unknown>, callOpts?: Record<string, unknown>) {
              assertSessionSupported(callOpts)
              recording.deletes.push({ db: targetDb, coll: name, filter, options: callOpts })
              const idx = getDocs().findIndex((d) => matchesFilterMongo(d, filter))
              if (idx < 0) return null
              const [removed] = getDocs().splice(idx, 1)
              return removed
            },
            async createIndex(keys: Record<string, unknown>) {
              recording.commands.push({ db: targetDb, cmd: { createIndexes: name, key: keys } })
              return 'custom_idx'
            },
            async dropIndex(indexName: string) {
              recording.commands.push({ db: targetDb, cmd: { dropIndexes: name, index: indexName } })
              return { ok: 1 }
            },
            async drop() {
              recording.commands.push({ db: targetDb, cmd: { drop: name } })
              delete docsByColl[name]
              return true
            },
            async rename(newName: string) {
              recording.commands.push({ db: targetDb, cmd: { renameCollection: name, to: newName } })
              docsByColl[newName] = getDocs()
              delete docsByColl[name]
              return {}
            },
          }
        },
        async createCollection(collName: string, callOpts?: Record<string, unknown>) {
          if (callOpts && 'signal' in callOpts && callOpts.signal !== undefined) {
            const err = new Error("BSON field 'create.signal' is an unknown field.") as Error & { code: number }
            err.code = 40415
            throw err
          }
          recording.commands.push({ db: targetDb, cmd: { create: collName }, options: callOpts })
          return {}
        },
        async stats() {
          return { db: targetDb, collections: 1, ok: 1 }
        },
      }
    },
    startSession() {
      let inTx = false
      let snapshot: Record<string, Record<string, unknown>[]> | null = null
      const cloneStore = () => {
        const out: Record<string, Record<string, unknown>[]> = {}
        for (const [k, list] of Object.entries(docsByColl)) {
          out[k] = list.map((d) => ({ ...d }))
        }
        return out
      }
      const restoreStore = () => {
        if (!snapshot) return
        for (const k of Object.keys(docsByColl)) delete docsByColl[k]
        for (const [k, list] of Object.entries(snapshot)) docsByColl[k] = list
      }
      return {
        inTransaction: () => inTx,
        startTransaction() {
          recording.txEvents.push('startTransaction')
          snapshot = cloneStore()
          inTx = true
        },
        async commitTransaction() {
          recording.txEvents.push('commitTransaction')
          snapshot = null
          inTx = false
        },
        async abortTransaction() {
          recording.txEvents.push('abortTransaction')
          restoreStore()
          snapshot = null
          inTx = false
        },
        async withTransaction<T>(fn: () => Promise<T>) {
          recording.txEvents.push('withTransaction:begin')
          snapshot = cloneStore()
          inTx = true
          try {
            const res = await fn()
            recording.txEvents.push('withTransaction:commit')
            snapshot = null
            return res
          } catch (err) {
            recording.txEvents.push('withTransaction:abort')
            restoreStore()
            snapshot = null
            throw err
          } finally {
            inTx = false
          }
        },
        async endSession() {
          recording.txEvents.push('endSession')
          inTx = false
        },
      }
    },
  }

  const driver = new MongoDriver((uri, options) => {
    recording.uri = uri
    recording.options = options
    return fakeClient
  })

  return { driver, recording, fakeClient, docsByColl }
}

const tempPaths: string[] = []
afterEach(async () => {
  while (tempPaths.length > 0) {
    const p = tempPaths.pop()
    if (p) await fs.promises.rm(p, { recursive: true, force: true }).catch(() => {})
  }
})

describe('MongoDriver — Connection, URI, TLS, and Schema Introspection', () => {
  it('builds mongodb:// URI with credential encoding, authSource from profile.options, and TLS options via resolveEffectiveTlsOptions', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'datanoa-mongo-tls-'))
    tempPaths.push(tmpDir)
    const caPath = path.join(tmpDir, 'ca.pem')
    const certPath = path.join(tmpDir, 'client.pem')
    await fs.promises.writeFile(caPath, '-----BEGIN CERTIFICATE-----\nFAKECA\n-----END CERTIFICATE-----\n', 'utf8')
    await fs.promises.writeFile(certPath, '-----BEGIN CERTIFICATE-----\nFAKECERT\n-----END CERTIFICATE-----\n', 'utf8')

    const { driver, recording } = createFakeMongoHarness()
    const profile: ConnectionProfile = {
      id: 'mongo-1',
      name: 'Mongo TLS',
      driver: 'mongodb',
      host: '127.0.0.1',
      port: 29017,
      database: 'analytics',
      user: 'admin@org',
      hasPassword: true,
      options: JSON.stringify({ authSource: 'admin', directConnection: true }),
      ssl: true,
      sslMode: 'require',
      sslCaPath: caPath,
      sslCertPath: certPath,
      sslRejectUnauthorized: false,
      sshEnabled: true,
    }

    const session = await driver.createSession(profile, 'p@ss:word#1', {
      sslKeyPassphrase: 'key-secret',
      tlsServername: 'mongo.internal.example',
    })

    expect(recording.uri).toBe('mongodb://admin%40org:p%40ss%3Aword%231@127.0.0.1:29017/analytics')
    expect(recording.options.authSource).toBe('admin')
    expect(recording.options.directConnection).toBe(true)
    expect(recording.options.tls).toBe(true)
    expect(recording.options.tlsCAFile).toBe(caPath)
    expect(recording.options.tlsCertificateKeyFile).toBe(certPath)
    expect(recording.options.tlsCertificateKeyFilePassword).toBe('key-secret')
    expect(recording.options.tlsAllowInvalidCertificates).toBe(true)
    expect(recording.options.servername).toBe('mongo.internal.example')

    const testRes = await session.test()
    expect(testRes).toEqual({ ok: true, message: 'MongoDB connection valid' })
    expect(session.isAlive()).toBe(true)

    await session.close()
    expect(recording.closed).toBe(true)
    expect(session.isAlive()).toBe(false)
  })

  it('supports mongodb+srv:// profile.url with credential injection and SSH host rewrite for mongodb:// URLs', async () => {
    const { driver, recording } = createFakeMongoHarness()
    const srvProfile: ConnectionProfile = {
      id: 'mongo-srv',
      name: 'Atlas SRV',
      driver: 'mongodb',
      database: 'prod',
      user: 'atlasUser',
      hasPassword: true,
      url: 'mongodb+srv://cluster0.abcde.mongodb.net/prod?retryWrites=true&w=majority',
    }
    const srvSession = await driver.createSession(srvProfile, 's3cr@t')
    expect(recording.uri).toBe('mongodb+srv://atlasUser:s3cr%40t@cluster0.abcde.mongodb.net/prod?retryWrites=true&w=majority')
    await srvSession.close()

    const { driver: tunnelDriver, recording: tunnelRec } = createFakeMongoHarness()
    const tunneledProfile: ConnectionProfile = {
      id: 'mongo-ssh',
      name: 'Tunneled Mongo',
      driver: 'mongodb',
      database: 'orders',
      host: '127.0.0.1',
      port: 54321,
      url: 'mongodb://user:pw@remote.mongo.local:27017/orders?authSource=admin',
      sshEnabled: true,
    }
    const tunnelSession = await tunnelDriver.createSession(tunneledProfile, undefined, {
      tlsServername: 'remote.mongo.local',
    })
    expect(tunnelRec.uri).toBe('mongodb://user:pw@127.0.0.1:54321/orders?authSource=admin')
    await tunnelSession.close()
  })

  it('lists schemas with fallback on restricted users and lists both collections and views', async () => {
    const { driver } = createFakeMongoHarness({
      listDatabasesError: new Error('not authorized on admin to execute command { listDatabases: 1 }'),
      collectionsByDb: {
        appdb: [
          { name: 'users', type: 'collection' },
          { name: 'active_users', type: 'view', options: { viewOn: 'users', pipeline: [{ $match: { active: true } }] } },
          { name: 'system.views', type: 'collection' },
        ],
      },
    })
    const session = await driver.createSession({
      id: 'mongo-restricted',
      name: 'Restricted',
      driver: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'appdb',
    })
    const schemas = await session.listSchemas?.()
    expect(schemas).toEqual({ schemas: ['appdb'], defaultSchema: 'appdb' })

    const objs = await session.listObjects('appdb')
    expect(objs).toEqual([
      { name: 'active_users', schema: 'appdb', kind: 'view', detail: 'viewOn: users' },
      { name: 'users', schema: 'appdb', kind: 'table' },
    ])
    await session.close()
  })

  it('samples up to 50 documents to infer union columns, dominant BSON types, nullability, indexes, and DDL', async () => {
    const oid1 = new ObjectId('507f1f77bcf86cd799439011')
    const oid2 = new ObjectId('507f1f77bcf86cd799439012')
    const { driver, recording } = createFakeMongoHarness({
      collectionsByDb: {
        appdb: [
          { name: 'orders', type: 'collection', options: { capped: true, size: 1024 } },
          {
            name: 'paid_orders',
            type: 'view',
            options: { viewOn: 'orders', pipeline: [{ $match: { status: 'paid' } }] },
          },
        ],
      },
      docsByColl: {
        orders: [
          {
            _id: oid1,
            total: Decimal128.fromString('199.950'),
            seq: Long.fromString('9007199254740993'),
            createdAt: new Date('2025-01-15T10:00:00.000Z'),
            status: 'paid',
          },
          {
            _id: oid2,
            total: Decimal128.fromString('42.00'),
            seq: Long.fromString('9007199254740995'),
            createdAt: new Date('2025-01-16T10:00:00.000Z'),
            status: 'pending',
            note: 'rush order',
          },
        ],
        paid_orders: [{ _id: oid1, status: 'paid' }],
      },
      indexesByColl: {
        orders: [
          { name: '_id_', key: { _id: 1 } },
          { name: 'status_created_idx', key: { status: 1, createdAt: -1 }, unique: true },
        ],
      },
    })

    const session = await driver.createSession({
      id: 'mongo-schema',
      name: 'Schema Test',
      driver: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'appdb',
    })

    const details = await session.getTableDetails('orders', 'appdb')
    expect(recording.finds[0]?.limit).toBe(50)
    expect(details.kind).toBe('table')
    expect(details.primaryKey).toEqual(['_id'])
    expect(details.columns.map((c) => [c.name, c.type, c.nullable, c.isPrimaryKey])).toEqual([
      ['_id', 'ObjectId', false, true],
      ['total', 'Decimal128', false, false],
      ['seq', 'Long', false, false],
      ['createdAt', 'Date', false, false],
      ['status', 'String', false, false],
      ['note', 'String', true, false],
    ])
    expect(details.indexes).toEqual([
      {
        name: '_id_',
        isPrimary: true,
        isUnique: true,
        columns: ['_id'],
        columnSpecs: [{ name: '_id', desc: false }],
      },
      {
        name: 'status_created_idx',
        isPrimary: false,
        isUnique: true,
        columns: ['status', 'createdAt'],
        columnSpecs: [
          { name: 'status', desc: false },
          { name: 'createdAt', desc: true },
        ],
      },
    ])
    expect(details.ddl).toContain('db.createCollection("orders"')
    expect(details.ddl).toContain('createIndex')

    const viewDdl = await session.getObjectDdl?.('paid_orders', 'view', 'appdb')
    expect(viewDdl).toContain('db.createView("paid_orders", "orders"')

    const exported = await session.exportSchemaDdl?.('appdb')
    expect(exported?.objectCount).toBe(2)
    expect(exported?.ddl).toContain('db.createCollection("orders"')
    expect(exported?.ddl).toContain('db.createView("paid_orders"')

    await session.close()
  })

  it('fetches paginated rows with BSON lossless serialization, EJSON/JSON filter, SQL quick-filter translation, and view/readOnly canEdit flags', async () => {
    const oid = new ObjectId('507f1f77bcf86cd799439011')
    const bin = new Binary(Buffer.from('hello'), 0)
    const uuid = new UUID('1368e202-7afd-4d8b-afec-19652d8e0410')
    const ts = new Timestamp({ t: 100, i: 7 })
    const rx = new BSONRegExp('^alice', 'i')

    const { driver, recording } = createFakeMongoHarness({
      collectionsByDb: {
        appdb: [
          { name: 'events', type: 'collection' },
          { name: 'events_view', type: 'view', options: { viewOn: 'events', pipeline: [] } },
        ],
      },
      docsByColl: {
        events: [
          {
            _id: oid,
            amount: Decimal128.fromString('99.95'),
            bigId: Long.fromString('9007199254740993'),
            smallNum: new Int32(42),
            payload: bin,
            traceId: uuid,
            oplogTs: ts,
            when: new Date('2025-02-01T12:30:00.000Z'),
            pattern: rx,
            status: 'active',
          },
          {
            _id: 'str-id-2',
            amount: Decimal128.fromString('10.00'),
            bigId: Long.fromNumber(5),
            status: 'archived',
          },
        ],
        events_view: [{ _id: oid, status: 'active' }],
      },
    })

    const session = await driver.createSession({
      id: 'mongo-page',
      name: 'Browse Test',
      driver: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'appdb',
    })

    const unfiltered = await session.fetchPage({
      table: 'events',
      schema: 'appdb',
      page: 1,
      pageSize: 10,
    })
    expect(unfiltered.totalRows).toBe(2)

    const page1 = await session.fetchPage({
      table: 'events',
      schema: 'appdb',
      page: 1,
      pageSize: 1,
      sortColumn: 'bigId',
      sortDirection: 'DESC',
      whereClause: '{ status: "active", _id: ObjectId("507f1f77bcf86cd799439011") }',
    })

    expect(page1.canEdit).toBe(true)
    expect(page1.totalRows).toBe(1)
    expect(page1.rows).toHaveLength(1)
    expect(page1.rows[0]._id).toBe('507f1f77bcf86cd799439011')
    expect(page1.rows[0].amount).toBe('99.95')
    expect(page1.rows[0].bigId).toBe('9007199254740993')
    expect(page1.rows[0].smallNum).toBe(42)
    expect(page1.rows[0].traceId).toBe('1368e202-7afd-4d8b-afec-19652d8e0410')
    expect(page1.rows[0].when).toBe('2025-02-01T12:30:00.000Z')
    expect(page1.rows[0].payload).toEqual({ $binary: { base64: Buffer.from('hello').toString('base64'), subType: '00' } })
    expect(page1.rows[0].oplogTs).toEqual({ $timestamp: { t: 100, i: 7 } })
    expect(page1.rows[0].pattern).toBe('/^alice/i')

    const lastFind = recording.finds[recording.finds.length - 1]
    expect(lastFind.sort).toEqual({ bigId: -1 })
    expect(lastFind.skip).toBe(0)
    expect(lastFind.limit).toBe(1)
    expect(lastFind.filter._id).toBeInstanceOf(ObjectId)

    // SQL-style quick filter translation
    await session.fetchPage({
      table: 'events',
      schema: 'appdb',
      page: 2,
      pageSize: 10,
      whereClause: `"status" = 'active' AND "tries" != 1 AND "deleted_at" IS NULL AND "email" IS NOT NULL AND "_id" = '507f1f77bcf86cd799439011'`,
    })
    const sqlFind = recording.finds[recording.finds.length - 1]
    expect(sqlFind.skip).toBe(10)
    expect(sqlFind.limit).toBe(10)
    expect(sqlFind.filter).toEqual({
      $and: [
        { status: 'active' },
        { tries: { $ne: 1 } },
        { deleted_at: null },
        { email: { $ne: null } },
        { _id: { $in: [new ObjectId('507f1f77bcf86cd799439011'), '507f1f77bcf86cd799439011'] } },
      ],
    })

    // View must have canEdit === false
    const viewPage = await session.fetchPage({
      table: 'events_view',
      schema: 'appdb',
      page: 1,
      pageSize: 50,
    })
    expect(viewPage.canEdit).toBe(false)

    await session.close()
  })
})

describe('MongoDriver — Mutations (updateCell, applyChanges, previewChanges) & Transactions', () => {
  it('updates nested/dotted cells with optimistic locking and matches both ObjectId and string 24-hex _id values', async () => {
    const oid = new ObjectId('507f1f77bcf86cd799439011')
    const strHexId = '507f1f77bcf86cd799439099'
    const { driver, docsByColl } = createFakeMongoHarness({
      docsByColl: {
        users: [
          { _id: oid, name: 'Alice', profile: { city: 'Danang' } },
          { _id: strHexId, name: 'Bob', profile: { city: 'Hue' } },
        ],
      },
    })

    const session = await driver.createSession({
      id: 'mongo-upd',
      name: 'Update Test',
      driver: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'appdb',
    })

    // 1. ObjectId _id doc updated with dotted path + optimistic lock
    const res1 = await session.updateCell({
      table: 'users',
      schema: 'appdb',
      primaryKeys: { _id: '507f1f77bcf86cd799439011' },
      column: 'profile.city',
      newValue: 'Hanoi',
      originalValue: 'Danang',
    })
    expect(res1.ok).toBe(true)
    expect(res1.affectedRows).toBe(1)
    expect((docsByColl.users[0].profile as Record<string, unknown>).city).toBe('Hanoi')

    // 2. String 24-hex _id doc updated reliably without forcing ObjectId
    const res2 = await session.updateCell({
      table: 'users',
      schema: 'appdb',
      primaryKeys: { _id: strHexId },
      column: 'name',
      newValue: 'Robert',
      originalValue: 'Bob',
    })
    expect(res2.ok).toBe(true)
    expect(docsByColl.users[1].name).toBe('Robert')

    // 3. Stale originalValue triggers conflict error
    await expect(
      session.updateCell({
        table: 'users',
        schema: 'appdb',
        primaryKeys: { _id: '507f1f77bcf86cd799439011' },
        column: 'profile.city',
        newValue: 'Saigon',
        originalValue: 'Danang',
      })
    ).rejects.toMatchObject({ code: 'conflict' })

    await session.close()
  })

  it('previews changes, runs applyChanges in ClientSession withTransaction, and falls back cleanly on standalone mongod preserving rollback semantics', async () => {
    const oid1 = new ObjectId('507f1f77bcf86cd799439011')
    const oid2 = new ObjectId('507f1f77bcf86cd799439012')
    const { driver, recording, docsByColl } = createFakeMongoHarness({
      docsByColl: {
        orders: [
          { _id: oid1, status: 'pending', total: 10 },
          { _id: oid2, status: 'draft', total: 20 },
        ],
      },
    })

    const session = await driver.createSession({
      id: 'mongo-apply',
      name: 'Apply Test',
      driver: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'appdb',
    })

    const preview = await session.previewChanges({
      table: 'orders',
      schema: 'appdb',
      deletes: [{ _id: oid2.toHexString() }],
      updates: [
        {
          primaryKeys: { _id: oid1.toHexString() },
          changes: { status: 'paid' },
          originalRow: { _id: oid1.toHexString(), status: 'pending' },
        },
      ],
      inserts: [{ status: 'new', total: 50 }],
    })
    expect(preview.statements).toHaveLength(3)
    expect(preview.statements[0]).toContain('db.getCollection("orders").deleteOne(')
    expect(preview.statements[1]).toContain('db.getCollection("orders").updateOne(')
    expect(preview.statements[2]).toContain('db.getCollection("orders").insertOne(')

    const applied = await session.applyChanges({
      table: 'orders',
      schema: 'appdb',
      deletes: [{ _id: oid2.toHexString() }],
      deleteRows: [{ _id: oid2.toHexString(), status: 'draft', total: 20 }],
      updates: [
        {
          primaryKeys: { _id: oid1.toHexString() },
          changes: { status: 'paid' },
          originalRow: { _id: oid1.toHexString(), status: 'pending' },
        },
      ],
      inserts: [{ status: 'new', total: 50 }],
    })
    expect(applied).toMatchObject({ ok: true, deleted: 1, updated: 1, inserted: 1 })
    expect(recording.txEvents).toContain('withTransaction:commit')
    expect(docsByColl.orders).toHaveLength(2)
    expect(docsByColl.orders.find((d) => d._id === oid1)?.status).toBe('paid')

    // Standalone mongod fallback: succeeds when valid, and preserves conflict rollback (nothing deleted if later update fails)
    const { driver: standaloneDriver, docsByColl: standaloneDocs } = createFakeMongoHarness({
      standaloneMode: true,
      docsByColl: {
        orders: [
          { _id: oid1, status: 'pending', total: 10 },
          { _id: oid2, status: 'draft', total: 20 },
        ],
      },
    })
    const standaloneSession = await standaloneDriver.createSession({
      id: 'mongo-standalone',
      name: 'Standalone',
      driver: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'appdb',
    })

    // Conflict in update must leave oid2 intact on standalone!
    await expect(
      standaloneSession.applyChanges({
        table: 'orders',
        schema: 'appdb',
        deletes: [{ _id: oid2.toHexString() }],
        updates: [
          {
            primaryKeys: { _id: oid1.toHexString() },
            changes: { status: 'paid' },
            originalRow: { _id: oid1.toHexString(), status: 'WRONG_STATUS' },
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(standaloneDocs.orders).toHaveLength(2)

    const standaloneOk = await standaloneSession.applyChanges({
      table: 'orders',
      schema: 'appdb',
      deletes: [{ _id: oid2.toHexString() }],
      inserts: [{ status: 'fresh', total: 99 }],
    })
    expect(standaloneOk).toMatchObject({ ok: true, deleted: 1, updated: 0, inserted: 1 })
    expect(standaloneDocs.orders).toHaveLength(2)

    await session.close()
    await standaloneSession.close()
  })

  it('supports interactive ClientSession transactions (begin, commit, rollback, setAutoCommit) and forwards session option', async () => {
    const oid1 = new ObjectId('507f1f77bcf86cd799439011')
    const { driver, recording, docsByColl } = createFakeMongoHarness({
      docsByColl: {
        accounts: [{ _id: oid1, balance: 100 }],
      },
    })

    const session = await driver.createSession({
      id: 'mongo-tx',
      name: 'Tx Test',
      driver: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'appdb',
    })

    expect(session.getTransactionState()).toMatchObject({
      supported: true,
      active: false,
      autoCommit: true,
      statementCount: 0,
    })

    const begun = await session.beginTransaction()
    expect(begun.active).toBe(true)
    expect(recording.txEvents).toContain('startTransaction')

    await session.updateCell({
      table: 'accounts',
      schema: 'appdb',
      primaryKeys: { _id: oid1.toHexString() },
      column: 'balance',
      newValue: 250,
    })
    expect(recording.updates[recording.updates.length - 1].options?.session).toBeDefined()
    expect(session.getTransactionState().statementCount).toBe(1)

    const rolledBack = await session.rollbackTransaction()
    expect(rolledBack.active).toBe(false)
    expect(docsByColl.accounts[0].balance).toBe(100)

    await session.setAutoCommit(false)
    expect(session.getTransactionState().autoCommit).toBe(false)
    await session.updateCell({
      table: 'accounts',
      schema: 'appdb',
      primaryKeys: { _id: oid1.toHexString() },
      column: 'balance',
      newValue: 300,
    })
    expect(session.getTransactionState().active).toBe(true)

    await expect(session.setAutoCommit(true)).rejects.toMatchObject({ code: 'TX_ACTIVE' })

    const committed = await session.commitTransaction()
    expect(committed.active).toBe(false)
    expect(docsByColl.accounts[0].balance).toBe(300)

    await session.setAutoCommit(true)
    expect(session.getTransactionState().autoCommit).toBe(true)
    await session.close()
  })
})

describe('MongoDriver — Zero-Eval Shell Parser, runQuery, cancelQuery, readOnly, and .explain()', () => {
  it('contains zero eval or new Function anywhere in src/drivers/mongodb/driver.ts', async () => {
    const src = await fs.promises.readFile(
      path.resolve('src/drivers/mongodb/driver.ts'),
      'utf8'
    )
    expect(src).not.toMatch(/\beval\s*\(/)
    expect(src).not.toMatch(/\bnew\s+Function\b/)
  })

  it('executes db.<col>.find/findOne/aggregate/distinct/countDocuments/getIndexes/stats/write methods with relaxed JSON & BSON helpers', async () => {
    const oid = new ObjectId('507f1f77bcf86cd799439011')
    const { driver, recording, docsByColl } = createFakeMongoHarness({
      collectionsByDb: {
        appdb: [{ name: 'users', type: 'collection' }, { name: 'audit.logs', type: 'collection' }],
      },
      docsByColl: {
        users: [
          {
            _id: oid,
            name: 'Alice',
            role: 'admin',
            balance: Decimal128.fromString('12.34'),
            created: new Date('2025-01-01T00:00:00Z'),
          },
          { _id: new ObjectId('507f1f77bcf86cd799439012'), name: 'Bob', role: 'viewer' },
        ],
        'audit.logs': [{ _id: new ObjectId(), action: 'login' }],
      },
    })

    const session = await driver.createSession({
      id: 'mongo-shell',
      name: 'Shell Test',
      driver: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'appdb',
    })

    // 1. db.users.find({...}).sort({...}).skip(0).limit(10).project({...}) with BSON helpers & unquoted keys
    const findRes = await session.runQuery(
      'q1',
      `db.users.find({ _id: ObjectId("507f1f77bcf86cd799439011"), created: ISODate('2025-01-01T00:00:00Z'), balance: NumberDecimal("12.34") }).sort({ name: -1 }).skip(0).limit(10).project({ name: 1, balance: 1 })`
    )
    expect(findRes.isSelect).toBe(true)
    expect(findRes.rowCount).toBe(1)
    const lastFind = recording.finds[recording.finds.length - 1]
    expect(lastFind.filter._id).toBeInstanceOf(ObjectId)
    expect(lastFind.filter.created).toBeInstanceOf(Date)
    expect(lastFind.filter.balance).toBeInstanceOf(Decimal128)
    expect(lastFind.sort).toEqual({ name: -1 })
    expect(lastFind.limit).toBe(10)
    expect(lastFind.project).toEqual({ name: 1, balance: 1 })

    // 2. db.getCollection("audit.logs").find({})
    const dottedRes = await session.runQuery('q2', 'db.getCollection("audit.logs").find({})')
    expect(dottedRes.rowCount).toBe(1)

    // 3. Chained .count()
    const chainedCount = await session.runQuery('q3', 'db.users.find({ role: "admin" }).count()')
    expect(chainedCount.rows).toEqual([[1]])

    // 4. aggregate, distinct, estimatedDocumentCount, getIndexes, stats
    const aggRes = await session.runQuery(
      'q4',
      'db.users.aggregate([{ $match: { role: "admin" } }, { $project: { name: 1 } }])'
    )
    expect(aggRes.isSelect).toBe(true)
    expect(recording.commands.some((c) => 'aggregate' in c.cmd)).toBe(true)

    const distRes = await session.runQuery('q5', 'db.users.distinct("role")')
    expect(distRes.rows.map((r) => r[0])).toEqual(['admin', 'viewer'])

    const idxRes = await session.runQuery('q6', 'db.users.getIndexes()')
    expect(idxRes.rows.length).toBeGreaterThanOrEqual(1)

    const statsRes = await session.runQuery('q7', 'db.users.stats()')
    expect(statsRes.rowCount).toBe(1)

    // 5. Write methods: insertOne, updateOne, deleteOne, createIndex, dropIndex, renameCollection, drop
    const insRes = await session.runQuery(
      'q8',
      'db.users.insertOne({ name: "Charlie", role: "editor", credits: NumberLong("9007199254740993") })'
    )
    expect(insRes.affectedRows).toBe(1)
    expect(docsByColl.users.some((d) => d.name === 'Charlie' && d.credits instanceof Long)).toBe(true)

    const updRes = await session.runQuery(
      'q9',
      'db.users.updateOne({ name: "Charlie" }, { $set: { role: "owner" } })'
    )
    expect(updRes.affectedRows).toBe(1)

    const delRes = await session.runQuery('q10', 'db.users.deleteOne({ name: "Charlie" })')
    expect(delRes.affectedRows).toBe(1)

    await session.runQuery('q11', 'db.users.createIndex({ name: 1 }, { unique: true })')
    await session.runQuery('q12', 'db.users.dropIndex("name_1")')
    await session.runQuery('q13', 'db.getCollection("audit.logs").renameCollection("audit_archive")')
    expect(recording.commands.some((c) => c.cmd.renameCollection === 'audit.logs')).toBe(true)

    await session.close()
  })

  it('supports show dbs, show collections, db.stats(), db.serverStatus(), db.runCommand, raw JSON commands, collection shorthand, and .explain()', async () => {
    const { driver, recording } = createFakeMongoHarness({
      collectionsByDb: {
        appdb: [{ name: 'users', type: 'collection' }],
      },
      docsByColl: {
        users: [{ _id: new ObjectId(), name: 'Alice' }],
      },
    })

    const session = await driver.createSession({
      id: 'mongo-admin',
      name: 'Admin Shell',
      driver: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'appdb',
    })

    const dbs = await session.runQuery('qa1', 'show dbs')
    expect(dbs.rows.map((r) => r[0])).toEqual(['admin', 'appdb'])

    const cols = await session.runQuery('qa2', 'show collections')
    expect(cols.rows.map((r) => r[0])).toEqual(['users'])

    const dbStats = await session.runQuery('qa3', 'db.stats()')
    expect(dbStats.isSelect).toBe(true)

    const srvStatus = await session.runQuery('qa4', 'db.serverStatus()')
    expect(srvStatus.isSelect).toBe(true)

    const runCmd = await session.runQuery('qa5', 'db.runCommand({ ping: 1 })')
    expect(runCmd.isSelect).toBe(true)

    const rawJson = await session.runQuery('qa6', '{ "ping": 1 }')
    expect(rawJson.isSelect).toBe(true)

    const shorthand = await session.runQuery('qa7', 'users;')
    expect(shorthand.rowCount).toBe(1)

    // .explain() chained and raw { explain: ... }
    const explainFind = await session.runQuery('qa8', 'db.users.find({ name: "Alice" }).explain("queryPlanner")')
    expect(explainFind.isSelect).toBe(true)
    expect(recording.commands.some((c) => 'explain' in c.cmd)).toBe(true)

    const explainAgg = await session.runQuery('qa9', 'db.users.aggregate([{ $match: {} }]).explain("executionStats")')
    expect(explainAgg.isSelect).toBe(true)

    const explainRaw = await session.runQuery('qa10', '{ "explain": { "find": "users", "filter": {} } }')
    expect(explainRaw.isSelect).toBe(true)

    await session.close()
  })

  it('strictly enforces profile.readOnly across write methods, write commands, $out/$merge stages, and rejects arbitrary JS payloads', async () => {
    const { driver } = createFakeMongoHarness({
      docsByColl: {
        users: [{ _id: new ObjectId(), name: 'Alice' }],
      },
    })

    const roSession = await driver.createSession({
      id: 'mongo-ro',
      name: 'Read Only',
      driver: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'appdb',
      readOnly: true,
    })

    // Allowed read-only commands
    await expect(roSession.runQuery('r1', 'show collections')).resolves.toMatchObject({ isSelect: true })
    await expect(roSession.runQuery('r2', 'db.users.find({}).limit(5)')).resolves.toMatchObject({ isSelect: true })
    await expect(roSession.runQuery('r3', 'db.users.find({}).explain("queryPlanner")')).resolves.toMatchObject({ isSelect: true })
    await expect(roSession.runQuery('r4', '{ "explain": { "find": "users" } }')).resolves.toMatchObject({ isSelect: true })
    await expect(roSession.runQuery('r5', 'users;')).resolves.toMatchObject({ isSelect: true })

    // Blocked mutations & $out / $merge
    await expect(roSession.runQuery('w1', 'db.users.insertOne({ a: 1 })')).rejects.toMatchObject({ code: 'READ_ONLY' })
    await expect(roSession.runQuery('w2', 'db.users.updateOne({}, { $set: { a: 2 } })')).rejects.toMatchObject({ code: 'READ_ONLY' })
    await expect(roSession.runQuery('w3', 'db.users.deleteMany({})')).rejects.toMatchObject({ code: 'READ_ONLY' })
    await expect(roSession.runQuery('w4', 'db.users.drop()')).rejects.toMatchObject({ code: 'READ_ONLY' })
    await expect(roSession.runQuery('w5', 'db.users.aggregate([{ $match: {} }, { $out: "copy" }])')).rejects.toMatchObject({ code: 'READ_ONLY' })
    await expect(roSession.runQuery('w6', 'db.users.aggregate([{ $facet: { a: [{ $merge: "target" }] } }])')).rejects.toMatchObject({ code: 'READ_ONLY' })
    await expect(roSession.runQuery('w7', '{ "insert": "users", "documents": [{"a":1}] }')).rejects.toMatchObject({ code: 'READ_ONLY' })
    await expect(roSession.runQuery('w8', 'db.runCommand({ dropDatabase: 1 })')).rejects.toMatchObject({ code: 'READ_ONLY' })

    // Arbitrary JS injection rejected cleanly by zero-eval parser
    await expect(roSession.runQuery('x1', 'process.exit(1)')).rejects.toThrow()
    await expect(roSession.runQuery('x2', '(() => require("fs"))()')).rejects.toThrow()

    await roSession.close()
  })

  it('supports remaining BSON constructors, regex literals, bracketed collection names, multi-statement use/resultSets, bulk write methods, and error credential scrubbing', async () => {
    const { driver, recording, docsByColl } = createFakeMongoHarness({
      collectionsByDb: {
        appdb: [{ name: 'my-items', type: 'collection' }],
        analytics: [{ name: 'events', type: 'collection' }],
      },
      docsByColl: {
        'my-items': [{ _id: new ObjectId('507f1f77bcf86cd799439011'), name: 'Alpha', qty: 1 }],
        events: [{ _id: new ObjectId('507f1f77bcf86cd799439012'), kind: 'click' }],
      },
    })

    const session = await driver.createSession({
      id: 'mongo-extra',
      name: 'Extra Shell',
      driver: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'appdb',
    })

    // Bracketed collection name + regex literal + BSON constructors
    await session.runQuery(
      'e1',
      `db["my-items"].insertMany([
        { name: 'Beta', qty: NumberInt(5), bin: BinData(0, 'aGk='), uid: UUID('1368e202-7afd-4d8b-afec-19652d8e0410'), ts: Timestamp(10, 1), at: new Date('2025-03-01T00:00:00Z') }
      ])`
    )
    expect(docsByColl['my-items']).toHaveLength(2)
    expect(docsByColl['my-items'][1].qty).toBeInstanceOf(Int32)
    expect(docsByColl['my-items'][1].bin).toBeInstanceOf(Binary)
    expect(docsByColl['my-items'][1].uid).toBeInstanceOf(UUID)
    expect(docsByColl['my-items'][1].ts).toBeInstanceOf(Timestamp)

    await session.runQuery('e2', 'db["my-items"].find({ name: /^be/i })')
    const regexFind = recording.finds[recording.finds.length - 1]
    expect(regexFind.filter.name).toBeInstanceOf(BSONRegExp)

    await session.runQuery('e3', 'db["my-items"].updateMany({}, { $set: { active: true } })')
    await session.runQuery('e4', 'db["my-items"].replaceOne({ name: "Beta" }, { name: "Gamma", qty: 9 })')
    const fou = await session.runQuery(
      'e5',
      'db["my-items"].findOneAndUpdate({ name: "Gamma" }, { $set: { qty: 10 } })'
    )
    expect(fou.affectedRows).toBe(1)
    const fod = await session.runQuery('e6', 'db["my-items"].findOneAndDelete({ name: "Gamma" })')
    expect(fod.affectedRows).toBe(1)

    const est = await session.runQuery('e7', 'db["my-items"].estimatedDocumentCount()')
    expect(est.rows).toEqual([[1]])

    await session.runQuery('e8', 'db.createCollection("temp_col")')
    await session.runQuery('e9', 'db.getCollectionNames()')
    await session.runQuery('e10', 'db["my-items"].deleteMany({})')
    await session.runQuery('e11', 'db["my-items"].drop()')

    // Multi-statement script switching DB via `use analytics`
    const multi = await session.runQuery(
      'e12',
      'use analytics;\nshow collections;\ndb.events.find({});'
    )
    expect(multi.resultSets).toHaveLength(3)
    expect(multi.resultSets?.[1].rows.map((r) => r[0])).toEqual(['events'])
    expect(multi.rowCount).toBe(1)
    await session.close()

    // Error scrubbing must redact embedded MongoDB URI passwords
    const failDriver = new MongoDriver(() => ({
      async connect() {
        throw new Error('Authentication failed on mongodb://admin:SuperSecret123@db.internal:27017/appdb')
      },
      async close() {},
      db() {
        throw new Error('unused')
      },
      startSession() {
        throw new Error('unused')
      },
    }))
    const testFail = await failDriver.testConnection(
      { id: 'fail-1', name: 'Fail', driver: 'mongodb', host: 'db.internal', port: 27017, database: 'appdb', user: 'admin' },
      'SuperSecret123'
    )
    expect(testFail.ok).toBe(false)
    expect(testFail.message).not.toContain('SuperSecret123')
    expect(testFail.message).toContain('***')
  })

  it('cancels an in-flight query cleanly via cancelQuery(queryId)', async () => {
    const { driver, fakeClient } = createFakeMongoHarness()
    let seenSignal: AbortSignal | undefined
    const origDb = fakeClient.db.bind(fakeClient)
    fakeClient.db = (name?: string) => {
      const dbObj = origDb(name)
      const origColl = dbObj.collection.bind(dbObj)
      dbObj.collection = (cName: string) => {
        const cObj = origColl(cName)
        const origFind = cObj.find.bind(cObj)
        cObj.find = (filter?: Record<string, unknown>, callOpts?: Record<string, unknown>) => {
          seenSignal = callOpts?.signal as AbortSignal | undefined
          const cur = origFind(filter, callOpts)
          cur.toArray = () =>
            new Promise((resolve, reject) => {
              const onAbort = () => reject(new Error('Aborted'))
              if (seenSignal?.aborted) return onAbort()
              seenSignal?.addEventListener('abort', onAbort, { once: true })
              setTimeout(() => resolve([]), 5000)
            })
          return cur
        }
        return cObj
      }
      return dbObj
    }

    const session = await driver.createSession({
      id: 'mongo-cancel',
      name: 'Cancel Test',
      driver: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'appdb',
    })

    const queryPromise = session.runQuery('q_cancel_1', 'db.users.find({})')
    await new Promise((r) => setTimeout(r, 15))
    const cancelRes = await session.cancelQuery('q_cancel_1')
    expect(cancelRes).toEqual({ ok: true })
    expect(seenSignal?.aborted).toBe(true)
    await expect(queryPromise).rejects.toMatchObject({ code: 'cancelled' })

    await session.close()
  })

  it('keeps regex literals containing comment or semicolon tokens intact across script splitting and queries', async () => {
    const script = [
      '/* comment-only statement */;',
      'db.logs.find({ url: /https?:\\/\\/a;b\\/*c/, tag: /[/*;]/i }); // trailing comment',
      'db.logs.countDocuments({ msg: /foo;bar/ })',
    ].join('\n')

    const statements = splitMongoScriptStatements(script)
    expect(statements).toHaveLength(2)
    expect(statements[0]).toContain('db.logs.find({ url: /https?:\\/\\/a;b\\/*c/, tag: /[/*;]/i })')
    expect(statements[1]).toContain('db.logs.countDocuments({ msg: /foo;bar/ })')

    const { driver, recording } = createFakeMongoHarness()
    const session = await driver.createSession({
      id: 'mongo-regex-split',
      name: 'Regex Split',
      driver: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'appdb',
    })
    const multi = await session.runQuery('q_regex_1', script)
    expect(multi.resultSets).toHaveLength(2)
    expect(recording.finds).toHaveLength(1)
    expect(recording.finds[0].filter.url).toBeInstanceOf(BSONRegExp)
    expect(recording.finds[0].filter.tag).toBeInstanceOf(BSONRegExp)
    expect((recording.finds[0].filter.tag as BSONRegExp).pattern).toBe('[/*;]')
    expect((recording.finds[0].filter.tag as BSONRegExp).options).toBe('i')
    await session.close()
  })

  it('builds TLS options cleanly for disable, verify-ca, and verify-full sslModes', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'datanoa-mongo-tls-'))
    try {
      const caFile = path.join(tmpDir, 'ca.pem')
      const certFile = path.join(tmpDir, 'client.pem')
      await fs.promises.writeFile(caFile, '-----BEGIN CERTIFICATE-----\nFAKECA\n-----END CERTIFICATE-----\n', 'utf8')
      await fs.promises.writeFile(certFile, '-----BEGIN CERTIFICATE-----\nFAKECERT\n-----END CERTIFICATE-----\n', 'utf8')

      const disabled = await buildMongoConnectionConfig({
        id: 'tls-dis',
        name: 'Disabled',
        driver: 'mongodb',
        host: 'db.local',
        port: 27017,
        database: 'appdb',
        sslMode: 'disable',
      })
      expect(disabled.options.tls).toBe(false)

      const verifyCa = await buildMongoConnectionConfig({
        id: 'tls-ca',
        name: 'VerifyCA',
        driver: 'mongodb',
        host: 'db.local',
        port: 27017,
        database: 'appdb',
        sslMode: 'verify-ca',
        sslCaPath: caFile,
        sslCertPath: certFile,
      })
      expect(verifyCa.options.tls).toBe(true)
      expect(verifyCa.options.tlsCAFile).toBe(caFile)
      expect(verifyCa.options.tlsCertificateKeyFile).toBe(certFile)
      expect(verifyCa.options.rejectUnauthorized).toBe(true)
      expect(verifyCa.options.tlsAllowInvalidCertificates).toBe(false)
      expect(typeof verifyCa.options.checkServerIdentity).toBe('function')

      const verifyFull = await buildMongoConnectionConfig({
        id: 'tls-full',
        name: 'VerifyFull',
        driver: 'mongodb',
        host: 'db.local',
        port: 27017,
        database: 'appdb',
        sslMode: 'verify-full',
        sslCaPath: caFile,
      })
      expect(verifyFull.options.tls).toBe(true)
      expect(verifyFull.options.tlsCAFile).toBe(caFile)
      expect(verifyFull.options.rejectUnauthorized).toBe(true)
      expect(verifyFull.options.tlsAllowInvalidCertificates).toBe(false)
      expect(verifyFull.options.checkServerIdentity).toBeUndefined()
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('translates SQL quick-filter operators LIKE, ILIKE, >, <=, IN, NOT IN, OR, and negative numbers', () => {
    const filter = translateSqlFilterToMongoFilter(
      "(name LIKE 'al%' AND score > -10.5 AND qty <= 5 AND role IN ('admin', 'ops') AND tier NOT IN ('guest')) OR note ILIKE '%urgent%'"
    )
    expect(Array.isArray(filter.$or)).toBe(true)
    const branches = filter.$or as Array<Record<string, unknown>>
    expect(branches).toHaveLength(2)

    const leftAnd = branches[0].$and as Array<Record<string, unknown>>
    expect(leftAnd).toHaveLength(5)
    expect(leftAnd[0].name).toBeInstanceOf(BSONRegExp)
    expect((leftAnd[0].name as BSONRegExp).pattern).toBe('^al.*$')
    expect(leftAnd[1]).toEqual({ score: { $gt: -10.5 } })
    expect(leftAnd[2]).toEqual({ qty: { $lte: 5 } })
    expect(leftAnd[3]).toEqual({ role: { $in: ['admin', 'ops'] } })
    expect(leftAnd[4]).toEqual({ tier: { $nin: ['guest'] } })

    const rightBranch = branches[1]
    expect(rightBranch.note).toBeInstanceOf(BSONRegExp)
    expect((rightBranch.note as BSONRegExp).pattern).toBe('^.*urgent.*$')
    expect((rightBranch.note as BSONRegExp).options).toBe('i')
  })

  it('preserves resolved BSON column types across sequential updateCell/applyChanges calls without explicit columnTypes and matches non-_id ObjectId columns in optimistic locking', async () => {
    const id1 = new ObjectId('507f1f77bcf86cd799439011')
    const id2 = new ObjectId('507f1f77bcf86cd799439012')
    const org1 = new ObjectId('507f1f77bcf86cd799439099')
    const org2 = new ObjectId('507f1f77bcf86cd799439088')
    const uid1 = new UUID('1368e202-7afd-4d8b-afec-19652d8e0410')
    const uid2 = new UUID('2368e202-7afd-4d8b-afec-19652d8e0411')
    const dt1 = new Date('2026-01-10T08:00:00.000Z')
    const dt2 = new Date('2026-02-20T09:30:00.000Z')

    const docsByColl: Record<string, Array<Record<string, unknown>>> = {
      ledger: [
        {
          _id: id1,
          orgId: org1,
          amount: Decimal128.fromString('15.25'),
          createdAt: dt1,
          seq: Long.fromString('9007199254740993'),
          traceId: uid1,
          note: 'initial',
        },
        {
          _id: id2,
          orgId: org2,
          amount: Decimal128.fromString('25.50'),
          createdAt: dt2,
          seq: Long.fromString('9007199254740994'),
          traceId: uid2,
          note: 'second',
        },
      ],
    }

    const { driver, recording } = createFakeMongoHarness({ docsByColl })
    const session = await driver.createSession({
      id: 'mongo-seq-bson',
      name: 'Sequential BSON',
      driver: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'appdb',
    })

    // Populate metadata once via fetchPage, then omit columnType / columnTypes on all edits
    await session.fetchPage({ table: 'ledger', page: 1, pageSize: 10 })

    // 1st updateCell clears tableDetailsCache on completion
    const r1 = await session.updateCell({
      table: 'ledger',
      primaryKeys: { _id: id1.toHexString() },
      column: 'amount',
      originalValue: '15.25',
      newValue: '42.75',
    })
    expect(r1.ok).toBe(true)
    const u1Set = recording.updates[recording.updates.length - 1].update.$set as Record<string, unknown>
    expect(u1Set.amount).toBeInstanceOf(Decimal128)
    expect(String(u1Set.amount)).toBe('42.75')

    // 2nd sequential updateCell WITHOUT re-fetching schema: non-_id ObjectId optimistic lock + ObjectId coercion
    const r2 = await session.updateCell({
      table: 'ledger',
      primaryKeys: { _id: id1.toHexString() },
      column: 'orgId',
      originalValue: org1.toHexString(),
      newValue: '507f1f77bcf86cd7994390aa',
    })
    expect(r2.ok).toBe(true)
    const u2Set = recording.updates[recording.updates.length - 1].update.$set as Record<string, unknown>
    expect(u2Set.orgId).toBeInstanceOf(ObjectId)
    expect((u2Set.orgId as ObjectId).toHexString()).toBe('507f1f77bcf86cd7994390aa')

    // 3rd sequential updateCell on Date WITHOUT columnType
    const r3 = await session.updateCell({
      table: 'ledger',
      primaryKeys: { _id: id1.toHexString() },
      column: 'createdAt',
      originalValue: dt1.toISOString(),
      newValue: '2026-03-15T10:15:00.000Z',
    })
    expect(r3.ok).toBe(true)
    const u3Set = recording.updates[recording.updates.length - 1].update.$set as Record<string, unknown>
    expect(u3Set.createdAt).toBeInstanceOf(Date)
    expect((u3Set.createdAt as Date).toISOString()).toBe('2026-03-15T10:15:00.000Z')

    // 4th sequential call: applyChanges with Date/Decimal128/Long/UUID/ObjectId updates + deleteRows WITHOUT columnTypes
    const applyRes = await session.applyChanges({
      table: 'ledger',
      updates: [
        {
          primaryKeys: { _id: id1.toHexString() },
          changes: {
            seq: '9007199254740999',
            traceId: '3368e202-7afd-4d8b-afec-19652d8e0412',
          },
          originalRow: {
            seq: '9007199254740993',
            traceId: uid1.toString(),
            orgId: '507f1f77bcf86cd7994390aa',
          },
        },
      ],
      deletes: [{ _id: id2.toHexString() }],
      deleteRows: [
        {
          _id: id2.toHexString(),
          orgId: org2.toHexString(),
          amount: '25.50',
          createdAt: dt2.toISOString(),
          seq: '9007199254740994',
          traceId: uid2.toString(),
          note: 'second',
        },
      ],
      inserts: [
        {
          orgId: '507f1f77bcf86cd7994390bb',
          amount: '100.00',
          createdAt: '2026-04-01T00:00:00.000Z',
          seq: '9007199254741005',
          traceId: '4368e202-7afd-4d8b-afec-19652d8e0413',
        },
      ],
    })
    expect(applyRes).toMatchObject({ ok: true, updated: 1, deleted: 1, inserted: 1 })
    const u4Set = recording.updates[recording.updates.length - 1].update.$set as Record<string, unknown>
    expect(u4Set.seq).toBeInstanceOf(Long)
    expect(String(u4Set.seq)).toBe('9007199254740999')
    expect(u4Set.traceId).toBeInstanceOf(UUID)
    const insertedDoc = recording.inserts[recording.inserts.length - 1].docs[0]
    expect(insertedDoc.orgId).toBeInstanceOf(ObjectId)
    expect(insertedDoc.createdAt).toBeInstanceOf(Date)
    expect(insertedDoc.seq).toBeInstanceOf(Long)
    expect(insertedDoc.traceId).toBeInstanceOf(UUID)

    // Cold session (never called fetchPage/getTableDetails): updateCell still resolves BSON types by introspecting!
    const coldHarness = createFakeMongoHarness({ docsByColl })
    const coldSession = await coldHarness.driver.createSession({
      id: 'mongo-cold-bson',
      name: 'Cold Session',
      driver: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'appdb',
    })
    const coldRes = await coldSession.updateCell({
      table: 'ledger',
      primaryKeys: { _id: id1.toHexString() },
      column: 'amount',
      originalValue: '15.25',
      newValue: '55.00',
    })
    expect(coldRes.ok).toBe(true)
    const coldSet = coldHarness.recording.updates[coldHarness.recording.updates.length - 1].update.$set as Record<string, unknown>
    expect(coldSet.amount).toBeInstanceOf(Decimal128)
    expect(String(coldSet.amount)).toBe('55.00')

    await coldSession.close()
    await session.close()
  })

  it('supports prefixed .explain().find/aggregate, blocks write commands inside readOnly { explain }, and scrubs secrets across all error paths', async () => {
    const { driver, fakeClient } = createFakeMongoHarness()
    const roSession = await driver.createSession({
      id: 'mongo-explain-ro',
      name: 'Explain ReadOnly',
      driver: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'appdb',
      readOnly: true,
    })

    const prefFind = await roSession.runQuery(
      'exp_pref_1',
      'db.users.explain("queryPlanner").find({ active: true }).limit(5)'
    )
    expect(prefFind.isSelect).toBe(true)
    expect(prefFind.rows[0]?.[prefFind.columns.findIndex((c) => c.name === 'queryPlanner')]).toBeDefined()

    const prefAgg = await roSession.runQuery(
      'exp_pref_2',
      'db.users.explain("executionStats").aggregate([{ $match: { active: true } }])'
    )
    expect(prefAgg.isSelect).toBe(true)
    expect(prefAgg.rows[0]?.[prefAgg.columns.findIndex((c) => c.name === 'queryPlanner')]).toBeDefined()

    await expect(
      roSession.runQuery('exp_ro_write', '{ "explain": { "delete": "users", "deletes": [] } }')
    ).rejects.toMatchObject({ code: 'READ_ONLY' })
    await roSession.close()

    // Error scrubbing across listObjects, fetchPage, updateCell, applyChanges, runQuery, commit/rollback
    const secretErr = new Error(
      'Auth failed at mongodb+srv://admin:TopSecret99@cluster.mongodb.net/appdb password=InlineSecret'
    )
    const origDb = fakeClient.db.bind(fakeClient)
    fakeClient.db = (name?: string) => {
      const dbObj = origDb(name)
      dbObj.listCollections = () => ({ toArray: async () => { throw secretErr } })
      const origColl = dbObj.collection.bind(dbObj)
      dbObj.collection = (cName: string) => {
        const cObj = origColl(cName)
        cObj.countDocuments = async () => { throw secretErr }
        cObj.updateOne = async () => { throw secretErr }
        return cObj
      }
      return dbObj
    }
    const origStart = fakeClient.startSession.bind(fakeClient)
    fakeClient.startSession = () => {
      const s = origStart()
      s.withTransaction = async () => { throw secretErr }
      s.commitTransaction = async () => { throw secretErr }
      s.abortTransaction = async () => { throw secretErr }
      return s
    }

    const errSession = await driver.createSession({
      id: 'mongo-err-scrub',
      name: 'Scrub Errors',
      driver: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'appdb',
    })

    for (const runOp of [
      () => errSession.listObjects('appdb'),
      () => errSession.getTableDetails('users', 'appdb'),
      () => errSession.fetchPage({ table: 'users', page: 1, pageSize: 10 }),
      () =>
        errSession.updateCell({
          table: 'users',
          primaryKeys: { _id: '1' },
          column: 'name',
          originalValue: 'a',
          newValue: 'b',
        }),
      () =>
        errSession.applyChanges({
          table: 'users',
          inserts: [{ name: 'x' }],
        }),
      () => errSession.runQuery('q_bad_syntax', 'mongodb://admin:LeakInQuery@host:27017/db'),
    ]) {
      let caught: unknown
      try {
        await runOp()
      } catch (e: unknown) {
        caught = e
      }
      expect(caught).toBeInstanceOf(Error)
      const msg = (caught as Error).message
      expect(msg).not.toContain('TopSecret99')
      expect(msg).not.toContain('InlineSecret')
      expect(msg).not.toContain('LeakInQuery')
    }

    await errSession.beginTransaction()
    let txErr: unknown
    try {
      await errSession.commitTransaction()
    } catch (e: unknown) {
      txErr = e
    }
    expect(txErr).toBeInstanceOf(Error)
    expect((txErr as Error).message).not.toContain('TopSecret99')
    expect((txErr as Error).message).not.toContain('InlineSecret')

    await errSession.beginTransaction()
    let rbErr: unknown
    try {
      await errSession.rollbackTransaction()
    } catch (e: unknown) {
      rbErr = e
    }
    expect(rbErr).toBeInstanceOf(Error)
    expect((rbErr as Error).message).not.toContain('TopSecret99')
    expect((rbErr as Error).message).not.toContain('InlineSecret')

    await errSession.close()
  })

  it('handles retryable-writes nested standalone error, avoids create.signal on createCollection, preserves resolved ObjectId PK type in updateCell, and masks unencoded # in URI passwords', async () => {
    // 1. #70 Bug 1: standalone MongoDB error wrapped with .originalError { code: 20 } and retryable-writes message
    const oid1 = new ObjectId('507f1f77bcf86cd799439011')
    const refOid = new ObjectId('507f1f77bcf86cd799439055')
    const { driver, fakeClient, recording } = createFakeMongoHarness({
      docsByColl: {
        refs: [{ _id: oid1, refId: refOid, label: 'before' }],
      },
    })

    const origStartSession = fakeClient.startSession.bind(fakeClient)
    fakeClient.startSession = () => {
      const s = origStartSession()
      s.withTransaction = async () => {
        const err = new Error(
          'This MongoDB deployment does not support retryable writes. Please add retryWrites=false to your connection string.'
        ) as Error & { originalError?: { code: number; codeName: string } }
        err.originalError = { code: 20, codeName: 'IllegalOperation' }
        throw err
      }
      return s
    }

    const session = await driver.createSession({
      id: 'mongo-w2-fixes',
      name: 'Wave 2',
      driver: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'appdb',
    })

    const applied = await session.applyChanges({
      table: 'refs',
      inserts: [{ refId: '507f1f77bcf86cd799439066', label: 'inserted' }],
    })
    expect(applied).toMatchObject({ ok: true, inserted: 1 })
    expect(recording.inserts[recording.inserts.length - 1].docs[0].refId).toBeInstanceOf(ObjectId)

    // 2. #70 Bug 2: db.createCollection must never pass signal field
    const created = await session.runQuery('q_cc_1', 'db.createCollection("w2_clean_coll", { capped: true, size: 4096 })')
    expect(created.affectedRows).toBe(1)
    const createCmd = recording.commands.find((c) => c.cmd.create === 'w2_clean_coll')
    expect(createCmd).toBeDefined()
    expect(createCmd?.options).not.toHaveProperty('signal')

    // 3. #70 Bug 3: updateCell matching by non-_id ObjectId PK column (both editing another column and editing refId itself) without columnType
    await session.fetchPage({ table: 'refs', page: 1, pageSize: 10 })
    const updNoteByRef = await session.updateCell({
      table: 'refs',
      primaryKeys: { refId: refOid.toHexString() },
      column: 'label',
      originalValue: 'before',
      newValue: 'after',
    })
    expect(updNoteByRef.ok).toBe(true)
    const noteUpd = recording.updates[recording.updates.length - 1]
    expect(noteUpd.filter.refId).toEqual({ $in: [refOid, refOid.toHexString()] })

    const updPkRef = await session.updateCell({
      table: 'refs',
      primaryKeys: { refId: refOid.toHexString() },
      column: 'refId',
      originalValue: refOid.toHexString(),
      newValue: '507f1f77bcf86cd799439077',
    })
    expect(updPkRef.ok).toBe(true)
    const lastUpd = recording.updates[recording.updates.length - 1]
    const refConds = (lastUpd.filter.$and as Array<Record<string, unknown>>) ?? [lastUpd.filter]
    expect(refConds[0].refId).toEqual({ $in: [refOid, refOid.toHexString()] })
    expect((lastUpd.update.$set as Record<string, unknown>).refId).toBeInstanceOf(ObjectId)

    await session.close()

    // 4. #70 Bug 4: maskConnectionUriSecret handles unencoded # and ? inside password while preserving authSource & path @user
    expect(maskConnectionUriSecret('mongodb+srv://admin:MongoSecret#99@!@cluster0.example.net/w2_r3_db')).toBe(
      'mongodb+srv://admin:***@cluster0.example.net/w2_r3_db'
    )
    expect(
      maskConnectionUriSecret('mongodb+srv://admin:p#1?x=2@cluster0.example.net/w2_r3_db?authSource=admin#token=sec')
    ).toBe('mongodb+srv://admin:***@cluster0.example.net/w2_r3_db?authSource=admin#token=***')
    expect(maskConnectionUriSecret('https://example.com:8443/users/@alice?token=secret&x=1')).toBe(
      'https://example.com:8443/users/@alice?token=***&x=1'
    )
  })

  it('masks URI passwords containing slashes, hashes, queries, and @ while preserving non-auth @ in paths and queries (#93 Bug 1 / #96)', async () => {
    // (a) '/' inside password before @host
    expect(maskConnectionUriSecret('mongodb+srv://admin:Mongo/Pass@cluster0.example.net/w3_r3_db')).toBe(
      'mongodb+srv://admin:***@cluster0.example.net/w3_r3_db'
    )

    // (b) Combined '#', '?', '@', ':', '/' inside password before @host
    expect(
      maskConnectionUriSecret(
        'mongodb+srv://admin:M#1?2@3:4/5@cluster0.example.net/w3_r3_db?authSource=admin&authMechanism=SCRAM-SHA-256&token=secret#authToken=s2&section=top'
      )
    ).toBe(
      'mongodb+srv://admin:***@cluster0.example.net/w3_r3_db?authSource=admin&authMechanism=SCRAM-SHA-256&token=***#authToken=***&section=top'
    )

    // (c) redis with '/', '#', '?' inside password plus '?password=' query param
    expect(maskConnectionUriSecret('redis://u:Pass/With#Sec?1@127.0.0.1:56379/0?password=Sec99')).toBe(
      'redis://u:***@127.0.0.1:56379/0?password=***'
    )

    // (d) Literal '@' in path with host:port before '/'
    expect(
      maskConnectionUriSecret('https://example.com:8443/users/@alice?token=secret&x=1#authToken=s2&section=top')
    ).toBe('https://example.com:8443/users/@alice?token=***&x=1#authToken=***&section=top')

    // (e) Literal '@' in query WITHOUT '/' before '?'
    expect(maskConnectionUriSecret('https://example.com:8443?next=@alice&token=secret')).toBe(
      'https://example.com:8443?next=@alice&token=***'
    )

    // (f) Slash-less URI with query '@email'
    expect(maskConnectionUriSecret('mongodb+srv://u:p@host?authSource=admin&email=a@b')).toBe(
      'mongodb+srv://u:***@host?authSource=admin&email=a@b'
    )

    // Extra: user:pass@host/users/@alice AND replica-set comma hosts AND oracle with Pwd={p@ss;1}
    expect(
      maskConnectionUriSecret('https://admin:Secret123@example.com:8443/users/@alice?token=tok')
    ).toBe('https://admin:***@example.com:8443/users/@alice?token=***')
    expect(
      maskConnectionUriSecret('mongodb://admin:p/w#1@h1.example.com:27017,h2.example.com:27017/mydb?authSource=admin')
    ).toBe('mongodb://admin:***@h1.example.com:27017,h2.example.com:27017/mydb?authSource=admin')
    expect(
      maskConnectionUriSecret('oracle://hr:Sec!99@ora.example:1521?token=tok123&authSource=admin&Pwd={p@ss;1}')
    ).toBe('oracle://hr:***@ora.example:1521?token=***&authSource=admin&Pwd=***')

    // End-to-end MongoDriver error scrubbing with slash+hash password
    const failDriver = new MongoDriver(() => ({
      async connect() {
        throw new Error(
          'Failed connecting to mongodb+srv://admin:M#1?2@3:4/5@cluster0.example.net/w3_r3_db?authSource=admin&token=tok99'
        )
      },
      async close() {},
      db() {
        throw new Error('unused')
      },
      startSession() {
        throw new Error('unused')
      },
    }))
    const res = await failDriver.testConnection(
      { id: 'fail-w3', name: 'Fail W3', driver: 'mongodb', host: 'cluster0.example.net', database: 'w3_r3_db' }
    )
    expect(res.ok).toBe(false)
    expect(res.message).not.toContain('M#1?2@3:4/5')
    expect(res.message).not.toContain('tok99')
    expect(res.message).toContain('authSource=admin')
    expect(res.message).toContain('admin:***@cluster0.example.net')
  })

  it('preserves unqualified single-label hosts and single-label host:port origins with path/fragment @domain (#111 Bug 1 / #116)', () => {
    expect(maskConnectionUriSecret('https://u:p@myhost/users/@alice.dev?token=secret')).toBe(
      'https://u:***@myhost/users/@alice.dev?token=***'
    )
    expect(maskConnectionUriSecret('mongodb://u:p@mongo-primary/db#section=a@b.com')).toBe(
      'mongodb://u:***@mongo-primary/db#section=a@b.com'
    )
    expect(maskConnectionUriSecret('mongodb+srv://u:p@host#section=a@b.com')).toBe(
      'mongodb+srv://u:***@host#section=a@b.com'
    )
    expect(maskConnectionUriSecret('https://api-server:8443/users/@alice?token=secret')).toBe(
      'https://api-server:8443/users/@alice?token=***'
    )
    expect(
      maskConnectionUriSecret(
        'mongodb+srv://admin:pass?a=1@cluster0.example.net/w4_r3_db?authSource=admin&email=x@y.com&credentials=c123'
      )
    ).toBe('mongodb+srv://admin:***@cluster0.example.net/w4_r3_db?authSource=admin&email=x@y.com&credentials=***')
    expect(
      maskConnectionUriSecret(
        'mongodb+srv://admin:pass?a=1@mongo-primary/w4_r3_db?email=x@y.com'
      )
    ).toBe('mongodb+srv://admin:***@mongo-primary/w4_r3_db?email=x@y.com')
  })

  it('masks numeric-prefix delimiter passwords, keeps single-label host before /@dotted.dev, and preserves 64-bit Long precision in hydrateEjsonValues & applyChanges (#137)', async () => {
    // 1. Numeric-prefix passwords containing '/' or '?'
    expect(maskConnectionUriSecret('redis://u:1234/x@127.0.0.1:56379/0?password=Sec99')).toBe(
      'redis://u:***@127.0.0.1:56379/0?password=***'
    )
    expect(maskConnectionUriSecret('mongodb://u:1234?a=1@cluster0.example.net/w5_r3_db')).toBe(
      'mongodb://u:***@cluster0.example.net/w5_r3_db'
    )
    // 2. Single-label host before /users/@alice.dev when password has '/' or '#sec=1'
    expect(maskConnectionUriSecret('https://u:p/1@myhost/users/@alice.dev?token=secret')).toBe(
      'https://u:***@myhost/users/@alice.dev?token=***'
    )
    expect(maskConnectionUriSecret('https://u:p#sec=1@myhost/users/@alice.dev?token=secret')).toBe(
      'https://u:***@myhost/users/@alice.dev?token=***'
    )
    // Preserve dotted path handle on uncredentialed single-label host:port
    expect(maskConnectionUriSecret('https://api-server:8443/users/@alice.dev?token=secret')).toBe(
      'https://api-server:8443/users/@alice.dev?token=***'
    )

    // 3. Lossless 64-bit Long deserialization in hydrateEjsonValues & lowercase/PascalCase columnTypes
    const hydrated = hydrateEjsonValues({ $numberLong: '9007199254740995' })
    expect(hydrated).toBeInstanceOf(Long)
    expect(String(hydrated)).toBe('9007199254740995')

    const oid = new ObjectId('507f1f77bcf86cd799439011')
    const { driver, recording } = createFakeMongoHarness({
      docsByColl: {
        metrics: [{ _id: oid, bigSeq: Long.fromString('9007199254740993') }],
      },
    })
    const session = await driver.createSession({
      id: 'mongo-w5-long',
      name: 'Wave 5 Long',
      driver: 'mongodb',
      host: 'localhost',
      port: 27017,
      database: 'appdb',
    })

    const resLower = await session.applyChanges({
      table: 'metrics',
      columnTypes: { bigSeq: 'long' },
      inserts: [
        { bigSeq: { $numberLong: '9007199254740995' } },
        { bigSeq: '9007199254740997' },
      ],
      updates: [
        {
          primaryKeys: { _id: oid.toHexString() },
          changes: { bigSeq: { $numberLong: '9007199254740999' } },
          originalRow: { bigSeq: { $numberLong: '9007199254740993' } },
        },
      ],
    })
    expect(resLower).toMatchObject({ ok: true, inserted: 2, updated: 1 })
    const ins1 = recording.inserts[0].docs[0]
    const ins2 = recording.inserts[1].docs[0]
    expect(ins1.bigSeq).toBeInstanceOf(Long)
    expect(String(ins1.bigSeq)).toBe('9007199254740995')
    expect(ins2.bigSeq).toBeInstanceOf(Long)
    expect(String(ins2.bigSeq)).toBe('9007199254740997')
    const updSet = recording.updates[0].update.$set as Record<string, unknown>
    expect(updSet.bigSeq).toBeInstanceOf(Long)
    expect(String(updSet.bigSeq)).toBe('9007199254740999')

    await session.updateCell({
      table: 'metrics',
      primaryKeys: { _id: oid.toHexString() },
      column: 'bigSeq',
      columnType: 'Long',
      originalValue: '9007199254740999',
      newValue: '9007199254741001',
    })
    const upd2Set = recording.updates[1].update.$set as Record<string, unknown>
    expect(upd2Set.bigSeq).toBeInstanceOf(Long)
    expect(String(upd2Set.bigSeq)).toBe('9007199254741001')

    await session.close()
  })

  it('Wave 6: masks non-HTTP single-label numeric passwords, preserves HTTPS ?next=@dotted, and scrubs JSON-escaped/delimited URLs cleanly (#154)', async () => {
    // 1. Non-HTTP numeric-prefix delimiter passwords on single-label hosts without port
    expect(maskConnectionUriSecret('mongodb://svc:8080?x=1@mongo-primary/w6_r3_db?authSource=admin')).toBe(
      'mongodb://svc:***@mongo-primary/w6_r3_db?authSource=admin'
    )
    expect(maskConnectionUriSecret('redis://svc:9981/sub@redis-node/2?password=Top99')).toBe(
      'redis://svc:***@redis-node/2?password=***'
    )
    expect(maskConnectionUriSecret('redis://redis-node:6379/0?email=a@b.com&password=Top99')).toBe(
      'redis://redis-node:6379/0?email=a@b.com&password=***'
    )

    // 2. Uncredentialed single-label host:port HTTPS URL ending in ?next=@charlie.dev
    expect(maskConnectionUriSecret('https://edge-gw:9443?next=@charlie.dev')).toBe(
      'https://edge-gw:9443?next=@charlie.dev'
    )
    expect(maskConnectionUriSecret('https://edge-gw:9443?next=@charlie.dev#top')).toBe(
      'https://edge-gw:9443?next=@charlie.dev#***'
    )
    expect(maskConnectionUriSecret('https://edge-gw:9443/login?next=@charlie.dev')).toBe(
      'https://edge-gw:9443/login?next=@charlie.dev'
    )
    expect(maskConnectionUriSecret('https://u:p/2@edge-gw/users/@charlie.dev?token=Sec77')).toBe(
      'https://u:***@edge-gw/users/@charlie.dev?token=***'
    )
    expect(
      maskConnectionUriSecret('https://edge-gw:9443/org/@charlie.dev?token=Sec77&authSource=admin')
    ).toBe('https://edge-gw:9443/org/@charlie.dev?token=***&authSource=admin')

    // 3. scrubMongoErrorMessage preserves JSON closing delimiters & handles JSON-escaped '\\/' URLs
    const jsonEscapedDriver = new MongoDriver(() => ({
      async connect() {
        throw new Error(
          'Wrapped {"err":"https:\\/\\/svc:SecPass9@edge-gw:8443\\/db?credentials=Cred9"}'
        )
      },
      async close() {},
      db() {
        throw new Error('unused')
      },
      startSession() {
        throw new Error('unused')
      },
    }))
    const res1 = await jsonEscapedDriver.testConnection({
      id: 'w6-esc',
      name: 'W6 Esc',
      driver: 'mongodb',
      host: 'localhost',
      database: 'appdb',
    })
    expect(res1.ok).toBe(false)
    expect(res1.message).toBe(
      'Wrapped {"err":"https:\\/\\/svc:***@edge-gw:8443\\/db?credentials=***"}'
    )

    const wrappedParenDriver = new MongoDriver(() => ({
      async connect() {
        throw new Error('Failed (https://u:p/2@edge-gw/users/@charlie.dev?token=Sec77)')
      },
      async close() {},
      db() {
        throw new Error('unused')
      },
      startSession() {
        throw new Error('unused')
      },
    }))
    const res2 = await wrappedParenDriver.testConnection({
      id: 'w6-paren',
      name: 'W6 Paren',
      driver: 'mongodb',
      host: 'localhost',
      database: 'appdb',
    })
    expect(res2.ok).toBe(false)
    expect(res2.message).toBe('Failed (https://u:***@edge-gw/users/@charlie.dev?token=***)')
  })

  it('Wave 7: resolves findCredentialAuthorityAtIndex across non-HTTP #tag/replica/query edges, parses plain-text ClickHouse EXPLAIN AST, and scrubs array-nested Redis errors (#173)', async () => {
    // 1. findCredentialAuthorityAtIndex & maskConnectionUriSecret Wave 7 R3 matrix
    expect(findCredentialAuthorityAtIndex('https:\\/\\/', 'svc:SecPass9@edge-gw:8443\\/db', 3)).toBe(12)
    expect(findCredentialAuthorityAtIndex('https://', 'edge-gw:9443/v1?q=a@charlie.dev/extra', 7)).toBe(-1)
    expect(findCredentialAuthorityAtIndex('https://', 'edge-gw:9443#tab=users@v2', 7)).toBe(-1)

    const maskedPairs: Array<[string, string]> = [
      ['mongodb://svc:443#h=1@rs1:27017,rs2:27017/w7_r3_db', 'mongodb://svc:***@rs1:27017,rs2:27017/w7_r3_db'],
      ['redis://svc:443#h=1@redis-node/2?password=Top99', 'redis://svc:***@redis-node/2?password=***'],
      ['postgres://svc:5432#k=1@pgnode/w7', 'postgres://svc:***@pgnode/w7'],
      ['mongodb://svc.internal:443#h=1@rs1:27017,rs2:27017/w7_r3_db', 'mongodb://svc.internal:***@rs1:27017,rs2:27017/w7_r3_db'],
      ['mongodb://svc:8080?x=1@mongo-primary/w7_r3_db?authSource=admin', 'mongodb://svc:***@mongo-primary/w7_r3_db?authSource=admin'],
      ['mongodb://mongo:27017?email=a@b.com', 'mongodb://mongo:27017?email=a@b.com'],
      ['https://edge-gw:9443/v1?q=a@charlie.dev/extra', 'https://edge-gw:9443/v1?q=a@charlie.dev/extra'],
      ['https://ch.internal:8443/v1?notify=ops@corp.io#top', 'https://ch.internal:8443/v1?notify=ops@corp.io#***'],
      ['mongodb://mongo:27017/w7_db?email=a@b.io', 'mongodb://mongo:27017/w7_db?email=a@b.io'],
      ['redis://redis-node:6379/0?email=a@b.com', 'redis://redis-node:6379/0?email=a@b.com'],
      ['https://u:1234/z@api.internal/v2/@bob?authSource=admin', 'https://u:***@api.internal/v2/@bob?authSource=admin'],
      ['https://ch.internal:8443?notify=ops@corp.io', 'https://ch.internal:8443?notify=ops@corp.io'],
      ['https://edge-gw:9443?q=a@charlie.dev', 'https://edge-gw:9443?q=a@charlie.dev'],
      ['https://edge-gw:9443?next=@charlie.dev#top', 'https://edge-gw:9443?next=@charlie.dev#***'],
      ['https://edge-gw:9443#tab=users@v2', 'https://edge-gw:9443#tab=users@v2'],
      ['https://ops:1234?k=1@ch.internal:8443/v1?notify=ops@corp.io', 'https://ops:***@ch.internal:8443/v1?notify=ops@corp.io'],
      ['https://ops:1234#tag=1@ch.internal/db', 'https://ops:***@ch.internal/db'],
      ['mongodb://u:p/x@rs1:27017,rs2:27017/app?replicaSet=rs0&email=a@b.io', 'mongodb://u:***@rs1:27017,rs2:27017/app?replicaSet=rs0&email=a@b.io'],
    ]
    for (const [input, expected] of maskedPairs) {
      expect(maskConnectionUriSecret(input)).toBe(expected)
    }

    // 2. ClickHouseDriver plain-text 200 OK EXPLAIN AST response
    const chServer = http.createServer((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        if (/EXPLAIN\s+AST/i.test(body)) {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('SelectWithUnionQuery (children 1)\n ExpressionList (children 1)\n  Literal UInt64_1\n')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ meta: [{ name: '1', type: 'UInt8' }], data: [[1]], rows: 1 }))
      })
    })
    await new Promise<void>((resolve) => chServer.listen(0, '127.0.0.1', resolve))
    try {
      const addr = chServer.address()
      const chPort = typeof addr === 'object' && addr ? addr.port : 0
      const chDriver = new ClickHouseDriver()
      const chSession = await chDriver.createSession({
        id: 'w7-ch',
        name: 'W7 CH',
        driver: 'clickhouse',
        host: '127.0.0.1',
        port: chPort,
        database: 'default',
      })
      const explainRes = await chSession.runQuery('q_ch_ast', 'EXPLAIN AST SELECT 1')
      expect(explainRes.columns).toEqual([{ name: 'explain', type: 'String' }])
      expect(explainRes.rows).toEqual([
        ['SelectWithUnionQuery (children 1)'],
        [' ExpressionList (children 1)'],
        ['  Literal UInt64_1'],
      ])
      expect(explainRes.isSelect).toBe(true)
      await chSession.close()
    } finally {
      chServer.closeAllConnections?.()
      await new Promise<void>((resolve) => chServer.close(() => resolve()))
    }

    // 3. RedisDriver array-nested RespProtocolError scrubbing
    const redisServer = net.createServer((socket) => {
      let buf = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => {
        buf += chunk
        while (buf.includes('\r\n')) {
          if (!buf.startsWith('*')) {
            buf = ''
            break
          }
          const headerEnd = buf.indexOf('\r\n')
          const argc = Number(buf.slice(1, headerEnd))
          if (!Number.isInteger(argc) || argc <= 0) {
            buf = ''
            break
          }
          let cursor = headerEnd + 2
          const args: string[] = []
          let incomplete = false
          for (let i = 0; i < argc; i++) {
            const lenEnd = buf.indexOf('\r\n', cursor)
            if (lenEnd < 0) {
              incomplete = true
              break
            }
            const len = Number(buf.slice(cursor + 1, lenEnd))
            const valStart = lenEnd + 2
            const valEnd = valStart + len
            if (buf.length < valEnd + 2) {
              incomplete = true
              break
            }
            args.push(buf.slice(valStart, valEnd))
            cursor = valEnd + 2
          }
          if (incomplete) break
          buf = buf.slice(cursor)
          const cmd = (args[0] || '').toUpperCase()
          if (cmd === 'PING') {
            socket.write('+PONG\r\n')
          } else if (cmd === 'SELECT' || cmd === 'QUIT') {
            socket.write('+OK\r\n')
          } else {
            socket.write('*1\r\n-ERR https://u:Sec@h:8443/db?token=Tok\r\n')
          }
        }
      })
    })
    await new Promise<void>((resolve) => redisServer.listen(0, '127.0.0.1', resolve))
    try {
      const addr = redisServer.address()
      const rPort = typeof addr === 'object' && addr ? addr.port : 0
      const redisDriver = new RedisDriver()
      const redisSession = await redisDriver.createSession({
        id: 'w7-redis',
        name: 'W7 Redis',
        driver: 'redis',
        host: '127.0.0.1',
        port: rPort,
        database: '0',
      })
      const qRes = await redisSession.runQuery(
        'q_r_err',
        `EVAL "return {redis.error_reply('ERR https://u:Sec@h:8443/db?token=Tok')}" 0`
      )
      const serialized = JSON.stringify(qRes.rows)
      expect(serialized).not.toContain('u:Sec@')
      expect(serialized).not.toContain('token=Tok')
      expect(serialized).toContain('u@h:8443/db?token=[REDACTED]')
      await redisSession.close()
    } finally {
      redisServer.closeAllConnections?.()
      await new Promise<void>((resolve) => redisServer.close(() => resolve()))
    }
  })

  it('Wave 8: enforces IPv6 bracket guard, arbitrary ClickHouse multi-backslash escaping, non-HTTP ?query after targetHost, unified scrubSensitiveText, and Mongo error scrubbing (#193)', async () => {
    // 1. IPv6 bracket guard: uncredentialed [::1] preserved; credentialed u:p?1@[::1] masked/stripped
    expect(findCredentialAuthorityAtIndex('mongodb://', '[::1]:27017/w8db?email=ops@acme.io', 2)).toBe(-1)
    expect(findCredentialAuthorityAtIndex('https://', '[::1]:8443/v2/@bob.dev?token=Sec', 2)).toBe(-1)
    expect(findCredentialAuthorityAtIndex('mongodb://', 'u:p?1@[::1]:27017/w8db?email=ops@acme.io', 1)).toBe(5)

    expect(maskConnectionUriSecret('mongodb://[::1]:27017/w8db?email=ops@acme.io')).toBe(
      'mongodb://[::1]:27017/w8db?email=ops@acme.io'
    )
    expect(maskConnectionUriSecret('https://[::1]:8443/v2/@bob.dev?token=Sec')).toBe(
      'https://[::1]:8443/v2/@bob.dev?token=***'
    )
    expect(maskConnectionUriSecret('mongodb://[::1]:27017,seed-b:27018/w8db?email=ops@acme.io')).toBe(
      'mongodb://[::1]:27017,seed-b:27018/w8db?email=ops@acme.io'
    )
    expect(maskConnectionUriSecret('mongodb://u:p?1@[::1]:27017/w8db?email=ops@acme.io')).toBe(
      'mongodb://u:***@[::1]:27017/w8db?email=ops@acme.io'
    )

    expect(scrubSensitiveText('mongodb://[::1]:27017/w8db?email=ops@acme.io')).toBe(
      'mongodb://[::1]:27017/w8db?email=ops@acme.io'
    )
    expect(scrubSensitiveText('https://[::1]:8443/v2/@bob.dev?token=Sec')).toBe(
      'https://[::1]:8443/v2/@bob.dev?token=[REDACTED]'
    )
    expect(scrubSensitiveText('mongodb://[::1]:27017,seed-b:27018/w8db?email=ops@acme.io')).toBe(
      'mongodb://[::1]:27017,seed-b:27018/w8db?email=ops@acme.io'
    )
    expect(scrubSensitiveText('mongodb://u:p?1@[::1]:27017/w8db?email=ops@acme.io')).toBe(
      'mongodb://u@[::1]:27017/w8db?email=ops@acme.io'
    )

    // 2. Arbitrary ClickHouse multi-backslash escaping (3 and 4+ backslashes before '/')
    expect(findCredentialAuthorityAtIndex('https:\\\\\\/\\\\\\/', 'svc:Sec8@edge-gw:8443\\\\\\/db', 3)).toBe(8)
    expect(findCredentialAuthorityAtIndex('https:\\\\\\\\/\\\\\\\\/', 'svc:Sec8@edge-gw:8443\\\\\\\\/db', 3)).toBe(8)
    expect(
      findCredentialAuthorityAtIndex('https:\\\\\\\\/\\\\\\\\/', 'edge-gw:8443\\\\\\\\/v1?q=a@charlie.dev', 7)
    ).toBe(-1)
    expect(
      findCredentialAuthorityAtIndex('https:\\\\\\/\\\\\\/', 'edge-gw:8443\\\\\\/v2\\\\\\/@bob.dev?token=Sec', 7)
    ).toBe(-1)

    const quadJsonErr =
      '{"err":"https:\\\\\\\\/\\\\\\\\/svc:Sec8@edge-gw:8443\\\\\\\\/db?credentials=C8&Pwd={a;b}&authSource=admin#frag=F1\\""}'
    expect(scrubSensitiveText(quadJsonErr, { stripAllFragments: true })).toBe(
      '{"err":"https:\\\\\\\\/\\\\\\\\/svc@edge-gw:8443\\\\\\\\/db?credentials=[REDACTED]&Pwd=[REDACTED]&authSource=admin\\""}'
    )
    const quadOpaqueErr =
      '{"err":"https:\\\\\\\\/\\\\\\\\/svc:Sec8@edge-gw:8443\\\\\\\\/db#opaqueTok9\\""}'
    expect(scrubSensitiveText(quadOpaqueErr, { stripOpaqueFragment: true })).toBe(
      '{"err":"https:\\\\\\\\/\\\\\\\\/svc@edge-gw:8443\\\\\\\\/db#[REDACTED]\\""}'
    )

    // 3. Non-HTTP ?query after targetHost (single-label host without :port and without /path)
    expect(findCredentialAuthorityAtIndex('mongodb://', 'svc:8080?x=1@mongo-primary?authSource=admin', 3)).toBe(12)
    expect(findCredentialAuthorityAtIndex('postgres://', 'svc:5432#k=1@pgnode?sslmode=require', 3)).toBe(12)
    expect(findCredentialAuthorityAtIndex('redis://', 'svc:443#h=1@redis-node?password=Top99', 3)).toBe(11)
    expect(findCredentialAuthorityAtIndex('mongodb://', 'mongo:27017?email=a@b.com', 5)).toBe(-1)

    expect(maskConnectionUriSecret('mongodb://svc:8080?x=1@mongo-primary?authSource=admin')).toBe(
      'mongodb://svc:***@mongo-primary?authSource=admin'
    )
    expect(maskConnectionUriSecret('postgres://svc:5432#k=1@pgnode?sslmode=require')).toBe(
      'postgres://svc:***@pgnode?sslmode=require'
    )
    expect(maskConnectionUriSecret('redis://svc:443#h=1@redis-node?password=Top99')).toBe(
      'redis://svc:***@redis-node?password=***'
    )
    expect(maskConnectionUriSecret('mongodb://mongo:27017?email=a@b.com')).toBe(
      'mongodb://mongo:27017?email=a@b.com'
    )

    expect(
      scrubSensitiveText('mongodb://svc:8080?x=1@mongo-primary?authSource=admin', { stripAllFragments: true })
    ).toBe('mongodb://svc@mongo-primary?authSource=admin')
    expect(
      scrubSensitiveText('postgres://svc:5432#k=1@pgnode?sslmode=require', { stripAllFragments: true })
    ).toBe('postgres://svc@pgnode?sslmode=require')
    expect(
      scrubSensitiveText('redis://svc:443#h=1@redis-node?password=Top99', { stripAllFragments: true })
    ).toBe('redis://svc@redis-node?password=[REDACTED]')
    expect(
      scrubSensitiveText('mongodb://mongo:27017?email=a@b.com', { stripAllFragments: true })
    ).toBe('mongodb://mongo:27017?email=a@b.com')

    // 4. Unified scrubSensitiveText: ?Authorization=Bearer/Basic, JSON-escaped Pwd=\"Sec8\", fragments, headers, myhttps:// boundary
    expect(scrubSensitiveText('https://edge-gw:8443/db?Authorization=Bearer Tok88&authSource=admin')).toBe(
      'https://edge-gw:8443/db?Authorization=[REDACTED]&authSource=admin'
    )
    expect(
      scrubSensitiveText(
        '{"err":"https://edge-gw:8443/db?Authorization=Basic dXNlcjpwYXNz#top\\""}',
        { stripAllFragments: true }
      )
    ).toBe('{"err":"https://edge-gw:8443/db?Authorization=[REDACTED]\\""}')

    const pwdJsonInput = JSON.stringify({ err: 'Server=db;Pwd="Sec8";Host=h' })
    const pwdJsonScrubbed = scrubSensitiveText(pwdJsonInput, { stripAllFragments: true })
    expect(pwdJsonScrubbed).toBe('{"err":"Server=db;Pwd=[REDACTED];Host=h"}')
    expect(JSON.parse(pwdJsonScrubbed)).toEqual({ err: 'Server=db;Pwd=[REDACTED];Host=h' })

    const nestedPwdJsonInput = JSON.stringify({
      outer: JSON.stringify({ err: 'Server=db;Pwd="Sec8";Host=h' }),
    })
    const nestedPwdJsonScrubbed = scrubSensitiveText(nestedPwdJsonInput, { stripAllFragments: true })
    expect(nestedPwdJsonScrubbed).not.toContain('Sec8')
    expect(JSON.parse(JSON.parse(nestedPwdJsonScrubbed).outer as string)).toEqual({
      err: 'Server=db;Pwd=[REDACTED];Host=h',
    })

    expect(scrubSensitiveText('{"err":"Server=db;Pwd=\\"Sec8\\";next=\\"ok\\""}')).toBe(
      '{"err":"Server=db;Pwd=[REDACTED];next=\\"ok\\""}'
    )
    expect(scrubSensitiveText('Server=db;Password={p@}}ss;1};Database=app')).toBe(
      'Server=db;Password=[REDACTED];Database=app'
    )
    expect(scrubSensitiveText('Authorization: Bearer Tok88 | Basic authentication failed')).toBe(
      'Authorization: Bearer [REDACTED] | Basic authentication failed'
    )
    expect(scrubSensitiveText('1https://u:p@host/db')).toBe('1https://u:p@host/db')
    expect(scrubSensitiveText('https://host/db#tab=indexes')).toBe('https://host/db#tab=indexes')
    expect(scrubSensitiveText('https://host/db#tab=indexes', { stripOpaqueFragment: true })).toBe(
      'https://host/db#tab=indexes'
    )
    expect(scrubSensitiveText('https://host/db#secretFrag', { stripOpaqueFragment: true })).toBe(
      'https://host/db#[REDACTED]'
    )
    expect(scrubSensitiveText('https://host/db#secretFrag', { stripAllFragments: true })).toBe(
      'https://host/db'
    )

    // 5. Mongo scrubMongoErrorMessage: multi-backslash schemes, JSON Pwd=\"Sec8\", ?Authorization=Bearer Tok88
    const errorVectors = [
      {
        raw: '{"err":"mongodb:\\\\\\\\/\\\\\\\\/svc:Sec8@mongo-primary:27017\\\\\\\\/w8_db?token=Top99#frag\\""}',
        assertClean: (msg: string) => {
          expect(msg).toBe(
            '{"err":"mongodb:\\\\\\\\/\\\\\\\\/svc:***@mongo-primary:27017\\\\\\\\/w8_db?token=***#***\\""}'
          )
          expect(JSON.parse(msg)).toBeTruthy()
          expect(msg).not.toContain('Sec8')
          expect(msg).not.toContain('Top99')
        },
      },
      {
        raw: JSON.stringify({ err: 'Server=db;Pwd="Sec8";Host=h' }),
        assertClean: (msg: string) => {
          expect(msg).toBe('{"err":"Server=db;Pwd=***;Host=h"}')
          expect(JSON.parse(msg)).toEqual({ err: 'Server=db;Pwd=***;Host=h' })
        },
      },
      {
        raw: '{"err":"https://edge-gw:8443/db?Authorization=Bearer Tok88&authSource=admin\\""}',
        assertClean: (msg: string) => {
          expect(msg).toBe('{"err":"https://edge-gw:8443/db?Authorization=***&authSource=admin\\""}')
          expect(msg).not.toContain('Tok88')
        },
      },
      {
        raw: '{"err":"Server=db;Pwd=\\\\\\\\\\"Sec5Bs\\\\\\\\\\";Host=\\"h\\"","nested":"mongodb://u@node:27017/db?Authorization=***"}',
        assertClean: (msg: string) => {
          expect(msg).toBe(
            '{"err":"Server=db;Pwd=***;Host=\\"h\\"","nested":"mongodb://u@node:27017/db?Authorization=***"}'
          )
          expect(JSON.parse(msg)).toBeTruthy()
          expect(msg).not.toContain('Sec5Bs')
        },
      },
      {
        raw: '{"err":"Pwd=***realSecret;password=[REDACTED]alsoSecret;Authorization: Bearer [REDACTED];uri=mongodb://u@node:27017/db?token=[REDACTED]alsoSecret"}',
        assertClean: (msg: string) => {
          expect(msg).toBe(
            '{"err":"Pwd=***;password=***;Authorization: Bearer [REDACTED];uri=mongodb://u@node:27017/db?token=***"}'
          )
          expect(msg).not.toContain('realSecret')
          expect(msg).not.toContain('alsoSecret')
        },
      },
    ]

    for (const vec of errorVectors) {
      const failingDriver = new MongoDriver(() => ({
        db: () => ({
          admin: () => ({
            ping: async () => ({ ok: 1 }),
            command: async () => ({ ok: 1 }),
            listDatabases: async () => ({ databases: [] }),
          }),
          listCollections: () => ({ toArray: async () => [] }),
          collection: () => ({}) as never,
          command: async () => ({ ok: 1 }),
        }),
        connect: async () => {
          throw new Error(vec.raw)
        },
        close: async () => {},
        startSession: () => {
          throw new Error('no session')
        },
      }))
      const testRes = await failingDriver.testConnection({
        id: 'w8-mongo-err',
        name: 'W8 Mongo Err',
        driver: 'mongodb',
        host: '127.0.0.1',
        port: 27017,
        database: 'w8_db',
      })
      expect(testRes.ok).toBe(false)
      vec.assertClean(testRes.message ?? '')
    }
  })
})

describe('BYOD Starter Templates (6 New Popular Engines + 4 Legacy Templates)', () => {
  const ALL_BYOD_IDS = [
    'duckdb',
    'snowflake',
    'bigquery',
    'cassandra',
    'elasticsearch',
    'neo4j',
    'mssql',
    'oracle',
    'mongodb',
    'custom',
  ] as const

  const EXPECTED_PACKAGES: Readonly<Record<string, string>> = {
    duckdb: '@duckdb/node-api',
    snowflake: 'snowflake-sdk',
    bigquery: '@google-cloud/bigquery',
    cassandra: 'cassandra-driver',
    elasticsearch: '@elastic/elasticsearch',
    neo4j: 'neo4j-driver',
    mssql: 'mssql',
    oracle: 'oracledb',
    mongodb: 'mongodb',
  }

  it('validates ESM syntax via esbuild and exports valid IDatabaseDriver contract for all 10 templates', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'datanoa-byod-ast-'))
    tempPaths.push(tmpDir)
    const manager = new DriverManager(
      { get: async () => null, set: async () => {}, delete: async () => {} },
      () => {}
    )

    for (const driverId of ALL_BYOD_IDS) {
      const code = getCanonicalByodStarterCode(driverId)
      expect(code.length).toBeGreaterThan(200)
      expect(code).not.toMatch(/\beval\s*\(/)
      expect(code).not.toMatch(/\bnew\s+Function\b/)

      const expectedPkg = EXPECTED_PACKAGES[driverId]
      if (expectedPkg) {
        expect(code).toContain(expectedPkg)
      }

      // 1. Validate pure ESM syntax with esbuild
      const transformed = await esbuild.transform(code, {
        loader: 'js',
        format: 'esm',
        target: 'node22',
      })
      expect(transformed.warnings).toEqual([])

      // 2. Bundle with stubbed external npm modules & import via Node ESM to verify DriverManager structural validation
      const outFile = path.join(tmpDir, `${driverId}.mjs`)
      await esbuild.build({
        stdin: { contents: code, resolveDir: tmpDir, loader: 'js' },
        bundle: true,
        format: 'esm',
        platform: 'node',
        outfile: outFile,
        plugins: [
          {
            name: 'stub-byod-pkgs',
            setup(build) {
              build.onResolve({ filter: /^[^./]/ }, (args) => ({
                path: args.path,
                namespace: 'stub-pkg',
              }))
              build.onLoad({ filter: /.*/, namespace: 'stub-pkg' }, () => ({
                contents: `
                  const fn = () => ({});
                  export default {};
                  export const DuckDBInstance = { create: async () => ({ connect: async () => ({}) }) };
                  export const BigQuery = class {};
                  export const Client = class {};
                  export const MongoClient = class {};
                `,
                loader: 'js',
              }))
            },
          },
        ],
      })

      const mod = (await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)) as unknown
      const validated = manager.validateDriverAdapterModule(mod)
      expect(validated.type).toBe(driverId)
      expect(typeof validated.createSession).toBe('function')
      expect(typeof validated.testConnection).toBe('function')
    }
  }, 20_000)

  it('executes createSession, test, listObjects, getTableDetails, fetchPage, runQuery, and close on the 6 new BYOD templates with mocked SDKs', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'datanoa-byod-exec-'))
    tempPaths.push(tmpDir)

    const pkgStubs: Record<string, string> = {
      '@duckdb/node-api': `
        export const DuckDBInstance = {
          async create() {
            return {
              closeSync() {},
              async connect() {
                return {
                  closeSync() {},
                  async runAndReadAll(sql) {
                    const isCount = /COUNT\\(\\*\\)/i.test(sql);
                    const isTables = /information_schema\\.tables/i.test(sql);
                    const isCols = /information_schema\\.columns/i.test(sql);
                    if (isTables) {
                      return {
                        columnNames: () => ['s', 'n', 't'],
                        columnTypesJson: () => ['VARCHAR', 'VARCHAR', 'VARCHAR'],
                        getRowObjectsJson: () => [{ s: 'main', n: 'events', t: 'BASE TABLE' }],
                      };
                    }
                    if (isCols) {
                      return {
                        columnNames: () => ['n', 'dt', 'nul', 'd'],
                        columnTypesJson: () => ['VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR'],
                        getRowObjectsJson: () => [{ n: 'id', dt: 'INTEGER', nul: 'NO', d: null }],
                      };
                    }
                    if (isCount) {
                      return {
                        columnNames: () => ['total'],
                        columnTypesJson: () => ['BIGINT'],
                        getRowObjectsJson: () => [{ total: 1 }],
                      };
                    }
                    return {
                      columnNames: () => ['id'],
                      columnTypesJson: () => ['INTEGER'],
                      getRowObjectsJson: () => [{ id: 1 }],
                    };
                  },
                };
              },
            };
          },
        };
      `,
      'snowflake-sdk': `
        export default {
          createConnection() {
            return {
              connect(cb) { cb(null, this); },
              destroy(cb) { cb(null); },
              isUp: () => true,
              execute({ sqlText, complete }) {
                const isTables = /INFORMATION_SCHEMA\\.TABLES/i.test(sqlText);
                const isCols = /INFORMATION_SCHEMA\\.COLUMNS/i.test(sqlText);
                const isCount = /COUNT\\(\\*\\)/i.test(sqlText);
                const cols = isTables
                  ? [{ getName: () => 'S', getType: () => 'TEXT' }, { getName: () => 'N', getType: () => 'TEXT' }, { getName: () => 'T', getType: () => 'TEXT' }]
                  : isCols
                    ? [{ getName: () => 'N', getType: () => 'TEXT' }, { getName: () => 'DT', getType: () => 'TEXT' }, { getName: () => 'NUL', getType: () => 'TEXT' }, { getName: () => 'D', getType: () => 'TEXT' }]
                    : isCount
                      ? [{ getName: () => 'TOTAL', getType: () => 'NUMBER' }]
                      : [{ getName: () => 'ID', getType: () => 'NUMBER' }];
                const rows = isTables
                  ? [{ S: 'PUBLIC', N: 'USERS', T: 'BASE TABLE' }]
                  : isCols
                    ? [{ N: 'ID', DT: 'NUMBER', NUL: 'NO', D: null }]
                    : isCount
                      ? [{ TOTAL: 1 }]
                      : [{ ID: 42 }];
                complete(null, { getColumns: () => cols, getNumUpdatedRows: () => 0, cancel: () => {} }, rows);
              },
            };
          },
        };
      `,
      '@google-cloud/bigquery': `
        export class BigQuery {
          async getDatasets() { return [[{ id: 'analytics' }]]; }
          dataset(id) {
            return {
              id,
              async getTables() { return [[{ id: 'events', metadata: { type: 'TABLE' } }]]; },
              table(tId) {
                return {
                  id: tId,
                  async getMetadata() {
                    return [{ schema: { fields: [{ name: 'id', type: 'INT64', mode: 'REQUIRED' }] } }];
                  },
                };
              },
            };
          }
          async query({ query }) {
            if (/COUNT\\(\\*\\)/i.test(query)) return [[{ total: 1 }]];
            return [[{ id: 7 }]];
          }
        }
      `,
      'cassandra-driver': `
        export default {
          Client: class {
            async connect() {}
            async shutdown() {}
            async execute(cql) {
              if (/system_schema\\.keyspaces/i.test(cql)) return { columns: [{ name: 'keyspace_name', type: { code: 10 } }], rows: [{ keyspace_name: 'ks1' }] };
              if (/system_schema\\.tables/i.test(cql)) return { columns: [{ name: 'keyspace_name' }, { name: 'table_name' }], rows: [{ keyspace_name: 'ks1', table_name: 'items' }] };
              if (/system_schema\\.views/i.test(cql)) return { columns: [], rows: [] };
              if (/system_schema\\.columns/i.test(cql)) return { columns: [], rows: [{ column_name: 'id', type: 'uuid', kind: 'partition_key' }] };
              if (/COUNT\\(\\*\\)/i.test(cql)) return { columns: [{ name: 'total' }], rows: [{ total: 1 }] };
              return { columns: [{ name: 'id', type: { code: 12 } }], rows: [{ id: 'u1' }] };
            }
          },
        };
      `,
      '@elastic/elasticsearch': `
        export class Client {
          async ping() { return true; }
          async info() { return { version: { number: '8.15.0' } }; }
          async close() {}
          cat = {
            indices: async () => [{ index: 'logs' }],
          };
          indices = {
            getMapping: async () => ({ logs: { mappings: { properties: { message: { type: 'text' } } } } }),
            get: async () => ({ logs: { settings: {} } }),
          };
          async search() {
            return { hits: { total: { value: 1 }, hits: [{ _id: '1', _source: { message: 'ok' } }] } };
          }
        }
      `,
      'neo4j-driver': `
        const neo4j = {
          auth: { basic: (u, p) => ({ u, p }) },
          driver: () => ({
            async verifyConnectivity() {},
            async close() {},
            session() {
              return {
                async run(cypher) {
                  if (/db\\.labels/i.test(cypher)) return { records: [{ keys: ['label'], get: () => 'Person' }] };
                  if (/COUNT\\(n\\)/i.test(cypher)) return { records: [{ keys: ['total'], get: () => 1 }] };
                  return { records: [{ keys: ['n'], get: () => ({ name: 'Alice' }) }] };
                },
                async close() {},
              };
            },
          }),
        };
        export default neo4j;
      `,
    }

    const targets = ['duckdb', 'snowflake', 'bigquery', 'cassandra', 'elasticsearch', 'neo4j'] as const
    for (const id of targets) {
      const code = getCanonicalByodStarterCode(id)
      const outFile = path.join(tmpDir, `exec-${id}.mjs`)
      await esbuild.build({
        stdin: { contents: code, resolveDir: tmpDir, loader: 'js' },
        bundle: true,
        format: 'esm',
        platform: 'node',
        outfile: outFile,
        plugins: [
          {
            name: 'mock-byod-sdk',
            setup(build) {
              build.onResolve({ filter: /^[^./]/ }, (args) => ({
                path: args.path,
                namespace: 'mock-sdk',
              }))
              build.onLoad({ filter: /.*/, namespace: 'mock-sdk' }, (args) => ({
                contents: pkgStubs[args.path] || 'export default {};',
                loader: 'js',
              }))
            },
          },
        ],
      })

      const mod = (await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)) as {
        default: {
          type: string
          createSession: (profile: ConnectionProfile, password?: string) => Promise<Record<string, (...a: unknown[]) => unknown>>
          testConnection: (profile: ConnectionProfile, password?: string) => Promise<{ ok: boolean }>
        }
      }
      const profile: ConnectionProfile = {
        id: `test-${id}`,
        name: `Test ${id}`,
        driver: id as ConnectionProfile['driver'],
        host: 'localhost',
        database: id === 'duckdb' ? ':memory:' : 'analytics',
        user: 'tester',
      }
      const testRes = await mod.default.testConnection(profile, 'secret')
      expect(testRes.ok).toBe(true)

      const session = await mod.default.createSession(profile, 'secret')
      expect(session.isAlive()).toBe(true)
      const objs = (await session.listObjects('analytics')) as Array<{ name: string }>
      expect(objs.length).toBeGreaterThan(0)
      const details = (await session.getTableDetails(
        id === 'elasticsearch' ? 'logs' : id === 'neo4j' ? 'Person' : 'events',
        'analytics'
      )) as { columns: unknown[] }
      expect(details.columns.length).toBeGreaterThan(0)
      const page = (await session.fetchPage({
        table: id === 'elasticsearch' ? 'logs' : id === 'neo4j' ? 'Person' : 'events',
        schema: 'analytics',
        page: 1,
        pageSize: 10,
      })) as { rows: unknown[]; totalRows: number }
      expect(page.rows.length).toBeGreaterThan(0)
      expect(page.totalRows).toBeGreaterThan(0)
      const qRes = (await session.runQuery(
        'q1',
        id === 'elasticsearch'
          ? '{"index":"logs","query":{"match_all":{}}}'
          : id === 'neo4j'
            ? 'MATCH (n:Person) RETURN n LIMIT 5'
            : 'SELECT 1'
      )) as { isSelect: boolean; rowCount: number }
      expect(qRes.rowCount).toBeGreaterThan(0)
      await session.close()
    }
  })

  it('parses both key=value and JSON profile.options in snowflake, bigquery, and cassandra BYOD templates (#70 Bug 6)', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'datanoa-byod-opts-'))
    tempPaths.push(tmpDir)

    const captured: Record<string, unknown> = {}
    const loadTemplate = async (
      driverId: 'snowflake' | 'bigquery' | 'cassandra',
      stubCode: string
    ) => {
      const code = getCanonicalByodStarterCode(driverId)
      const outFile = path.join(tmpDir, `${driverId}-opts.mjs`)
      await esbuild.build({
        stdin: { contents: code, resolveDir: tmpDir, loader: 'js' },
        bundle: true,
        format: 'esm',
        platform: 'node',
        outfile: outFile,
        plugins: [
          {
            name: 'mock-byod-opts',
            setup(build) {
              build.onResolve({ filter: /^[^./]/ }, (args) => ({
                path: args.path,
                namespace: 'mock-sdk-opts',
              }))
              build.onLoad({ filter: /.*/, namespace: 'mock-sdk-opts' }, () => ({
                contents: stubCode,
                loader: 'js',
              }))
            },
          },
        ],
      })
      return (await import(`${pathToFileURL(outFile).href}?t=${Date.now()}-${driverId}`)) as {
        default: {
          createSession: (profile: ConnectionProfile, password?: string) => Promise<{ close: () => Promise<void> }>
        }
      }
    }

    const sfMod = await loadTemplate(
      'snowflake',
      `
        globalThis.__capturedOpts ??= {};
        export default {
          createConnection(cfg) {
            globalThis.__capturedOpts.snowflake = cfg;
            return { connect(cb) { cb(null, {}); }, destroy(cb) { cb(null); } };
          },
        };
      `
    )
    const bqMod = await loadTemplate(
      'bigquery',
      `
        globalThis.__capturedOpts ??= {};
        export class BigQuery {
          constructor(cfg) { globalThis.__capturedOpts.bigquery = cfg; }
        }
      `
    )
    const cassMod = await loadTemplate(
      'cassandra',
      `
        globalThis.__capturedOpts ??= {};
        export default {
          Client: class {
            constructor(cfg) { globalThis.__capturedOpts.cassandra = cfg; }
            async connect() {}
            async shutdown() {}
          },
        };
      `
    )

    const g = globalThis as Record<string, unknown>
    g.__capturedOpts = captured

    const sfKv = await sfMod.default.createSession(
      {
        id: 'sf-kv',
        name: 'SF KV',
        driver: 'custom',
        host: '',
        database: 'ANALYTICS',
        user: 'svc',
        options: 'account=acme-us1, warehouse="COMPUTE_WH"; schema=\'PUBLIC\'\nrole=ANALYST',
      },
      'pw'
    )
    await sfKv.close()
    expect(captured.snowflake).toMatchObject({
      account: 'acme-us1',
      warehouse: 'COMPUTE_WH',
      schema: 'PUBLIC',
      role: 'ANALYST',
    })

    const sfJson = await sfMod.default.createSession(
      {
        id: 'sf-json',
        name: 'SF JSON',
        driver: 'custom',
        host: '',
        database: 'ANALYTICS',
        user: 'svc',
        options: '{"account":"acme-eu2","warehouse":"ETL_WH","schema":"CORE"}',
      },
      'pw'
    )
    await sfJson.close()
    expect(captured.snowflake).toMatchObject({
      account: 'acme-eu2',
      warehouse: 'ETL_WH',
      schema: 'CORE',
    })

    const bqKv = await bqMod.default.createSession({
      id: 'bq-kv',
      name: 'BQ KV',
      driver: 'custom',
      host: '',
      database: 'events_ds',
      options: 'projectId=prod-lake-1, location="US"',
    })
    await bqKv.close()
    expect(captured.bigquery).toMatchObject({
      projectId: 'prod-lake-1',
      location: 'US',
    })

    const cassKv = await cassMod.default.createSession({
      id: 'cass-kv',
      name: 'Cass KV',
      driver: 'custom',
      host: '127.0.0.1',
      port: 9042,
      database: 'ks1',
      options: "localDataCenter='us-east-1'",
    })
    await cassKv.close()
    expect(captured.cassandra).toMatchObject({
      localDataCenter: 'us-east-1',
    })

    // #154 Bug 4: JSON branch in parseSfOptions / parseBqOptions / parseCassOptions strips __proto__/constructor/prototype
    for (const driverId of ['snowflake', 'bigquery', 'cassandra'] as const) {
      const rawCode = getCanonicalByodStarterCode(driverId)
      const helperFile = path.join(tmpDir, `${driverId}-proto-guard.mjs`)
      await esbuild.build({
        stdin: {
          contents: `${rawCode}\nexport { parseKeyValueOrJsonOptions };\n`,
          resolveDir: tmpDir,
          loader: 'js',
        },
        bundle: true,
        format: 'esm',
        platform: 'node',
        outfile: helperFile,
        plugins: [
          {
            name: 'mock-byod-proto',
            setup(build) {
              build.onResolve({ filter: /^[^./]/ }, (args) => ({
                path: args.path,
                namespace: 'mock-sdk-proto',
              }))
              build.onLoad({ filter: /.*/, namespace: 'mock-sdk-proto' }, () => ({
                contents: 'export class BigQuery {} export default { createConnection() {}, Client: class {} };',
                loader: 'js',
              }))
            },
          },
        ],
      })
      const helperMod = (await import(`${pathToFileURL(helperFile).href}?t=${Date.now()}`)) as {
        parseKeyValueOrJsonOptions: (raw: string) => Record<string, unknown>
      }
      const parsed = helperMod.parseKeyValueOrJsonOptions(
        '{"__proto__":{"polluted":"yes"},"constructor":{"bad":1},"prototype":{"bad":2},"account":"a1"}'
      )
      expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(parsed, 'constructor')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(parsed, 'prototype')).toBe(false)
      const merged = Object.assign({}, parsed)
      expect((merged as Record<string, unknown>).polluted).toBeUndefined()
      expect(merged.account).toBe('a1')
    }
  })
})
