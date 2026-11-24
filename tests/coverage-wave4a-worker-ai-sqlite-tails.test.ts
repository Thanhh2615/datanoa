import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  presetFor,
  isProseExplanation,
  isReasoningExhausted,
  completeSql,
  rankModels,
  explainFailure,
  ProviderHttpError,
} from '../src/worker/ai-client.js'
import { registerAiHandlers } from '../src/worker/rpc-ai.js'
import {
  WorkerSchemaMetadataCache,
  extractReferencedTables,
  extractReferencedMongoCollections,
  buildSqlCompletionContext,
  resolveExplainLanguage,
  parseExplainAnalysis,
} from '../src/worker/ai-sql-context.js'
import { SqliteDriver } from '../src/drivers/sqlite/driver.js'

function withTempGlobal<T>(key: string, value: unknown, fn: () => T): T {
  const hadOwn = Object.prototype.hasOwnProperty.call(globalThis, key)
  const desc = Object.getOwnPropertyDescriptor(globalThis, key)
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  try {
    return fn()
  } finally {
    if (hadOwn && desc) {
      Object.defineProperty(globalThis, key, desc)
    } else {
      delete (globalThis as Record<string, unknown>)[key]
    }
  }
}

describe('Wave 4A Step 2: 5 Worker / AI / SQLite Micro-Tails Closure', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!
      fs.rmSync(dir, { recursive: true, force: true })
    }
    vi.restoreAllMocks()
  })

  it('closes src/worker/ai-client.ts & src/worker/ai-sql-context.ts tails', async () => {
    // 1. ai-client.ts
    expect(presetFor('unknown-fmt' as never, 'https://custom.local').id).toBe('openai')
    expect(presetFor('mistral-fim', 'https://custom.local').format).toBe('mistral-fim')

    expect(isProseExplanation('aa. bb')).toBe(false)
    expect(isReasoningExhausted('openai', null)).toBe(false)
    expect(isReasoningExhausted('openai', { choices: [{ finish_reason: 'length', message: { content: '' } }] })).toBe(false)

    // Streaming completeSql where reader.releaseLock() throws in finally
    const enc = new TextEncoder()
    const streamResp = {
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
      body: {
        getReader: () => {
          let readCount = 0
          return {
            read: async () => {
              readCount++
              if (readCount === 1) {
                return { done: false, value: enc.encode('data: {"choices":[{"delta":{"content":"SELECT 1"}}]}\n') }
              }
              return { done: true, value: undefined }
            },
            cancel: async () => {},
            releaseLock: () => {
              throw new Error('already released')
            },
          }
        },
      },
      json: async () => ({}),
    }
    const streamed = await completeSql(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-test-12345678901234567890', maxTokens: 64 },
      { dialect: 'sqlite', system: 'sys', user: 'SELECT ', prefix: 'SELECT ', suffix: '' },
      new AbortController().signal,
      (async () => streamResp) as never
    )
    expect(streamed).toBe('1')

    // rankModels identical names/tiers & tie-breaker
    const ranked = rankModels(
      ['gpt-4o', 'custom-slow', 'gpt-4o-mini'],
      { 'gpt-4o': { ok: true, ms: 50 }, 'custom-slow': { ok: true, ms: 50 } },
      1500
    )
    expect(ranked).toEqual(['gpt-4o', 'custom-slow', 'gpt-4o-mini'])
    expect(explainFailure(new TypeError('network'), '', 10000, 'openai')).toContain('Could not reach provider')
    expect(explainFailure(new ProviderHttpError(400), 'localhost', 10000, 'ollama')).toContain('Ollama refused')

    // 2. ai-sql-context.ts
    expect(extractReferencedTables('SELECT * FROM ""; SELECT * FROM "schema.";')).not.toContain('')

    const cache = new WorkerSchemaMetadataCache()
    const longTables: string[] = []
    for (let i = 0; i < 20; i++) {
      const tName = `very_long_table_name_for_pruning_budget_coverage_${i}_${'x'.repeat(70)}`
      longTables.push(tName)
      cache.setObjects('c1', longTables.map((n) => ({ name: n, kind: 'table' as const })))
      cache.setTableDetails('c1', {
        name: tName,
        kind: 'table',
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, isPrimaryKey: true },
          { name: 'very_long_column_name_overflowing_budget_check_abcdefghijklmnopqrstuvwxyz', type: 'TEXT', nullable: true, isPrimaryKey: false },
        ],
        primaryKey: ['id'],
        indexes: undefined as never,
        foreignKeys: i === 0 ? [{ name: 'fk0', column: 'id', referencedTable: 'neighbor_tbl', referencedColumn: 'id' }] : [],
      })
    }
    cache.setTableDetails('c1', {
      name: 'neighbor_tbl',
      kind: 'table',
      columns: [{ name: 'id', type: 'INTEGER', nullable: false, isPrimaryKey: true }],
      primaryKey: ['id'],
      indexes: [],
      foreignKeys: [],
    })
    const snap = cache.getSnapshot('c1')
    expect(snap).not.toBeNull()

    const ctxBuilt = buildSqlCompletionContext({
      connectionId: 'c1',
      dialect: 'sqlite',
      prefix: `SELECT * FROM ${longTables.join(', ')} WHERE `,
      suffix: '',
      schemaMap: { 'pub.users': ['id', 'name'], 'pub.': ['id'] },
      snapshot: snap,
      historyEntries: Array.from({ length: 12 }, (_, idx) => ({
        id: `h${idx}`,
        connectionId: 'c1',
        connectionName: 'Main',
        driver: 'sqlite' as const,
        sql: `SELECT ${'col, '.repeat(20)}id FROM orders WHERE id = ${idx}`,
        durationMs: 1,
        rowCount: 1,
        timestamp: Date.now() - idx * 1000,
      })),
    })
    expect(ctxBuilt.system.length).toBeGreaterThan(0)

    expect(extractReferencedMongoCollections("db.getCollection('orders').find({}); { explain: { aggregate: 'items' } };")).toEqual(['orders', 'items'])

    withTempGlobal('Intl', undefined, () => {
      expect(resolveExplainLanguage('auto').code).toBe('en')
    })

    const noBrace = parseExplainAnalysis('Plan looks fine without JSON braces.', 'English', 12)
    expect(noBrace.summary).toContain('Plan looks fine')
  })

  it('closes src/worker/rpc-ai.ts handler branches (longest prefix, backspace, abort, key & dotted tables)', async () => {
    const handlers = new Map<string, (input: any, ctx?: any) => Promise<any>>()
    const settingsStore: Record<string, unknown> = {
      aiEnabled: true,
      aiFormat: 'openai',
      aiBaseUrl: undefined,
      aiModel: 'gpt-4o-mini',
    }
    const secretsStore = new Map<string, string>()
    const storageStore = new Map<string, unknown>()
    const schemaCache = new WorkerSchemaMetadataCache()
    const events: string[] = []

    let releaseFirstFetch!: (res: any) => void
    let fetchCount = 0
    const controller = registerAiHandlers({
      registerHandler: (name, fn) => {
        handlers.set(name, fn)
      },
      orca: {
        settings: {
          get: async (k?: string) => (k ? settingsStore[k] : { ...settingsStore }),
          onDidChange: () => ({ dispose: () => {} }),
        },
        secrets: {
          get: async (k: string) => secretsStore.get(k) ?? null,
          set: async (k: string, v: string) => { secretsStore.set(k, v) },
          delete: async (k: string) => { secretsStore.delete(k) },
        },
        storage: {
          get: async (k: string) => storageStore.get(k) ?? null,
          set: async (k: string, v: unknown) => { storageStore.set(k, v) },
          delete: async (k: string) => { storageStore.delete(k) },
        },
        events: { emit: (e: string) => events.push(e) },
        panels: { post: vi.fn() },
        log: vi.fn(),
      } as never,
      schemaCache,
      sessionManager: {
        assertSecureSecretStorage: async () => {},
        getSession: async () => ({
          getTableDetails: async (table: string, schema?: string) => ({
            name: table,
            ...(schema ? { schema } : {}),
            kind: 'table',
            columns: [{ name: 'id', type: 'INTEGER', nullable: false, isPrimaryKey: true }],
            primaryKey: ['id'],
            indexes: [],
            foreignKeys: [],
          }),
        }),
      } as never,
      fetchPost: vi.fn(async (_url: string, _init: unknown) => {
        fetchCount++
        if (fetchCount === 999) {
          return new Promise((r) => { releaseFirstFetch = r })
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({
            choices: [{ message: { content: 'id, name FROM users' } }],
          }),
        }
      }) as never,
      fetchGet: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'gpt-4o-mini' }] }),
      })) as never,
    })

    // 1. ai.key.set with undefined aiBaseUrl -> fails invalid URL, then set valid aiBaseUrl
    await expect(handlers.get('ai.key.set')!({ key: 'sk-1234567890' })).rejects.toThrow(/Base URL/i)
    settingsStore.aiBaseUrl = 'https://api.openai.com/v1'
    await handlers.get('ai.key.set')!({ key: 'sk-1234567890' })

    // 2. Prefix completion caching + longest rawPrefix lookup + backspace shortest deletedTail
    await handlers.get('ai.complete')!({ prefix: 'SELECT ', suffix: '', connectionId: 'c1', dialect: 'sqlite' })
    await handlers.get('ai.complete')!({ prefix: 'SELECT id, ', suffix: '', connectionId: 'c1', dialect: 'sqlite' })
    const longestHit = await handlers.get('ai.complete')!({ prefix: 'SELECT id, name', suffix: '', connectionId: 'c1', dialect: 'sqlite' })
    expect(longestHit.suggestion).toBe(' FROM users')

    // Populate backspace entries cleanly (including invalid newline entry -> continue)
    await handlers.get('ai.complete')!({ prefix: 'SELECT id, name FROM users \nWHERE', suffix: '', connectionId: 'c1', dialect: 'sqlite' })
    await handlers.get('ai.complete')!({ prefix: 'SELECT id, name FROM users ORDER', suffix: '', connectionId: 'c1', dialect: 'sqlite' })
    await handlers.get('ai.complete')!({ prefix: 'SELECT id, name FROM users O', suffix: '', connectionId: 'c1', dialect: 'sqlite' })
    const backHit = await handlers.get('ai.complete')!({ prefix: 'SELECT id, name FROM users ', suffix: '', connectionId: 'c1', dialect: 'sqlite' })
    expect(backHit.suggestion.length).toBeGreaterThan(0)

    // 3. In-flight abort waiter
    fetchCount = 998 // next call triggers deferred fetch
    const ac = new AbortController()
    const p1 = handlers.get('ai.complete')!({ prefix: 'SELECT DISTINCT ', suffix: '', connectionId: 'c1', dialect: 'sqlite' })
    const p2 = handlers.get('ai.complete')!({ prefix: 'SELECT DISTINCT ', suffix: '', connectionId: 'c1', dialect: 'sqlite' }, { signal: ac.signal })
    ac.abort()
    const r2 = await p2
    expect(r2.suggestion).toBe('')
    releaseFirstFetch?.({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { content: 'id FROM users' } }] }),
    })
    await p1

    // 4. ai.models.bench with non-string key & empty/invalid baseUrl + ai.explainAnalyze with dotted table
    const badBench = await handlers.get('ai.models.bench')!({ baseUrl: 'not-a-url', models: ['m1'] })
    expect(badBench.results).toEqual([])
    await handlers.get('ai.models.bench')!({ baseUrl: 'https://api.openai.com/v1', key: 123, models: [123, 'gpt-4o-mini'] })

    const expRes = await handlers.get('ai.explainAnalyze')!({
      connectionId: 'c1',
      dialect: 'sqlite',
      sql: 'SELECT * FROM main.employees;',
      planColumns: [{ name: 'detail', type: 'TEXT' }],
      planRows: [['SCAN employees']],
    })
    expect(expRes.summary.length).toBeGreaterThan(0)
    await handlers.get('ai.stats.get')!({})
    await handlers.get('ai.stats.reset')!({})
    controller.dispose()
  })

  it('closes live src/drivers/sqlite/driver.ts & src/drivers/sqlite/thread.ts worker & rollback catch paths', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datanoa-w4a-sq-'))
    tempDirs.push(tmpDir)
    const dbPath = path.join(tmpDir, 'test.db')
    const driver = new SqliteDriver()
    const session = await driver.createSession({ id: 'sq_w4a', name: 'SQLite', driver: 'sqlite', filePath: dbPath, readOnly: false })

    try {
      // Leading comment SQL statement (`stripLeadingSqlComments`) + applyChanges with boolean/undefined/null params
      await session.runQuery(
        'sq_c1',
        '/* multi\nline */ -- single comment\nCREATE TABLE uq (id INTEGER PRIMARY KEY, flag INTEGER, note TEXT, x INTEGER UNIQUE ON CONFLICT ROLLBACK);',
        100
      )
      await session.applyChanges({
        table: 'uq',
        inserts: [{ id: 1, flag: true, note: undefined, x: 10 }, { id: 2, flag: false, note: null, x: 20 }],
        updates: [],
        deletes: [],
      })
      await expect(
        session.runQuery('sq_c2', 'BEGIN; INSERT INTO uq (id, x) VALUES (3, 10);', 100)
      ).rejects.toThrow()

      // Active slow CTE + concurrent cancelQuery + test() waiting on cancelPromise + isAlive()
      const slowP = session.runQuery(
        'sq_slow',
        'WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 15000000) SELECT COUNT(*) FROM cnt;',
        100
      )
      const cancel1 = session.cancelQuery('sq_slow')
      expect(session.isAlive()).toBe(true)
      const testDuringCancel = session.test()
      const cancel2 = session.cancelQuery('sq_slow')
      await Promise.allSettled([slowP, cancel1, cancel2, testDuringCancel])

      // Begin manual tx then close concurrently (closingPromise reuse + close rollback catch)
      await session.beginTransaction()
      await Promise.all([session.close(), session.close()])
      expect(session.isAlive()).toBe(false)

      // Closed session guards across tx & cancel methods
      await expect(session.cancelQuery('x')).rejects.toThrow(/closed/i)
      await expect(session.beginTransaction()).rejects.toThrow(/closed/i)
      await expect(session.commitTransaction()).rejects.toThrow(/closed/i)
      await expect(session.rollbackTransaction()).rejects.toThrow(/closed/i)
      await expect(session.setAutoCommit(true)).rejects.toThrow(/closed/i)
    } finally {
      await session.close().catch(() => {})
    }
  }, 20_000)
})
