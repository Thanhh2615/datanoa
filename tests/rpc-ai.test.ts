import { describe, expect, it, vi } from 'vitest'
import type { OrcaWorkerApi } from 'orca/worker'
import { WorkerSchemaMetadataCache } from '../src/worker/ai-sql-context'
import { registerAiHandlers } from '../src/worker/rpc-ai'
import type { SessionManager } from '../src/worker/session-manager'
import type { WorkerRegisterHandler } from '../src/worker/worker-utils'

function createFakeWorkerEnv(opts?: { keyringOk?: boolean; settings?: Record<string, unknown> }) {
  const handlers = new Map<string, (input: unknown, ctx: unknown) => Promise<unknown>>()
  const settingsData: Record<string, unknown> = { ...(opts?.settings ?? {}) }
  const storageData = new Map<string, unknown>()
  const secretsData = new Map<string, string>()
  const posts: Array<{ event: string; payload: unknown }> = []
  const logs: string[] = []
  const settingsListeners: Array<(change: { key: string }) => void> = []

  const orca = {
    settings: {
      get: async (k?: string) => (k ? settingsData[k] : { ...settingsData }),
      set: async (k: string, v: unknown) => {
        settingsData[k] = v
        settingsListeners.forEach((fn) => fn({ key: k }))
      },
      onDidChange: (fn: (change: { key: string }) => void) => {
        settingsListeners.push(fn)
        return { dispose: () => {} }
      },
    },
    storage: {
      get: async (k: string) => storageData.get(k) ?? null,
      set: async (k: string, v: unknown) => {
        storageData.set(k, v)
      },
      delete: async (k: string) => {
        storageData.delete(k)
      },
      keys: async () => Array.from(storageData.keys()),
      onDidChange: () => ({ dispose: () => {} }),
    },
    secrets: {
      get: async (k: string) => secretsData.get(k) ?? null,
      set: async (k: string, v: string) => {
        secretsData.set(k, v)
      },
      delete: async (k: string) => {
        secretsData.delete(k)
      },
    },
    panels: {
      handle: () => ({ dispose: () => {} }),
      post: (event: string, payload: unknown) => {
        posts.push({ event, payload })
      },
    },
    log: (msg: string) => {
      logs.push(msg)
    },
  } as unknown as OrcaWorkerApi

  const registerHandler = ((name: string, fn: (input: unknown, ctx: unknown) => Promise<unknown>) => {
    handlers.set(name, fn)
    return { dispose: () => {} }
  }) as unknown as WorkerRegisterHandler

  const sessionManager = {
    assertSecureSecretStorage: async () => {
      if (opts?.keyringOk === false) {
        throw new Error('OS keyring unavailable')
      }
    },
    getSession: async () => ({
      driverType: 'postgres',
      getTableDetails: async (table: string) => ({
        name: table,
        schema: 'public',
        kind: 'table',
        primaryKey: ['id'],
        columns: [
          { name: 'id', type: 'bigint', nativeType: 'int8', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true },
        ],
        indexes: [{ name: 'idx_orders_created', isUnique: false, isPrimary: false, columns: ['created_at'] }],
        foreignKeys: [],
      }),
    }),
  } as unknown as SessionManager

  const call = async <T = unknown>(name: string, input?: unknown, panelId = 'studio-1', signal?: AbortSignal): Promise<T> => {
    const fn = handlers.get(name)
    if (!fn) throw new Error(`Missing handler ${name}`)
    return (await fn(input, {
      panel: { id: panelId, surface: 'editor', contributionId: 'studio' },
      signal: signal ?? new AbortController().signal,
    })) as T
  }

  return { orca, registerHandler, sessionManager, settingsData, secretsData, storageData, posts, logs, call }
}

describe('rpc-ai handlers', () => {
  it('enforces OS keyring protection and key pinning across baseUrl changes', async () => {
    const blocked = createFakeWorkerEnv({ keyringOk: false })
    registerAiHandlers({
      orca: blocked.orca,
      registerHandler: blocked.registerHandler,
      sessionManager: blocked.sessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
    })
    await expect(blocked.call('ai.key.set', { key: 'sk-test-12345678901234567890' })).rejects.toThrow(/keyring/i)

    const env = createFakeWorkerEnv({
      keyringOk: true,
      settings: { aiEnabled: true, aiFormat: 'openai', aiBaseUrl: 'https://api.openai.com/v1', aiModel: 'gpt-4o-mini' },
    })
    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: env.sessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
    })
    await env.call('ai.key.set', { key: 'sk-test-12345678901234567890', baseUrl: 'https://api.openai.com/v1' })
    let st = await env.call<{ hasKey: boolean; state: string }>('ai.status.get')
    expect(st.hasKey).toBe(true)
    expect(st.state).toBe('on')

    // Changing baseUrl must NOT treat the old pinned OpenAI key as belonging to the new endpoint
    await env.orca.settings.set('aiBaseUrl', 'https://other-proxy.example/v1')
    st = await env.call<{ hasKey: boolean; state: string }>('ai.status.get')
    expect(st.hasKey).toBe(false)
  })

  it('returns cached SQL completion when enabled, skips when disabled, and isolates inflight aborts per panel', async () => {
    let fetches = 0
    const env = createFakeWorkerEnv({
      settings: { aiEnabled: true, aiFormat: 'openai', aiBaseUrl: 'https://api.openai.com/v1', aiModel: 'gpt-4o-mini' },
    })
    const schemaCache = new WorkerSchemaMetadataCache()
    schemaCache.setObjects('c1', [{ name: 'users', schema: 'public', kind: 'table' }])
    schemaCache.setTableDetails('c1', {
      name: 'users',
      schema: 'public',
      kind: 'table',
      primaryKey: ['id'],
      columns: [{ name: 'id', type: 'bigint', nativeType: 'int8', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true }],
      indexes: [],
      foreignKeys: [],
    })

    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: env.sessionManager,
      schemaCache,
      fetchPost: async () => {
        fetches++
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'id FROM users;' } }] }),
          text: async () => '',
        }
      },
    })
    await env.call('ai.key.set', { key: 'sk-test-12345678901234567890', baseUrl: 'https://api.openai.com/v1' })

    const r1 = await env.call<{ suggestion: string; id: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT ',
      suffix: '',
    })
    expect(r1.suggestion).toBe('id FROM users;')
    expect(r1.id).toBeGreaterThan(0)
    expect(fetches).toBe(1)

    // Same query hits LRU cache
    const r2 = await env.call<{ suggestion: string; id: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT ',
      suffix: '',
    })
    expect(r2.suggestion).toBe('id FROM users;')
    expect(fetches).toBe(1)

    // Disabling AI returns empty immediately
    await env.orca.settings.set('aiEnabled', false)
    const r3 = await env.call<{ suggestion: string; id: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT u.',
      suffix: '',
    })
    expect(r3).toEqual({ suggestion: '', id: 0 })
    expect(fetches).toBe(1)

    // Fail-closed: saving key with empty baseUrl rejects invalid_params and empty pin yields setup
    await expect(env.call('ai.key.set', { key: 'sk-test-123', baseUrl: '' })).rejects.toThrow(
      /Base URL/i
    )
    await env.orca.storage.set('datanoa.ai.keyAddress', '')
    await env.orca.settings.set('aiEnabled', true)
    const statusAfterEmptyPin = await env.call<{ hasKey: boolean; state: string }>('ai.status.get')
    expect(statusAfterEmptyPin.hasKey).toBe(false)
    expect(statusAfterEmptyPin.state).toBe('setup')
  })

  it('runs ai.explainAnalyze on demand with schema details and chosen explanation language', async () => {
    let sentUser = ''
    let sentSystem = ''
    const env = createFakeWorkerEnv({
      settings: {
        aiEnabled: true,
        aiFormat: 'openai',
        aiBaseUrl: 'https://api.openai.com/v1',
        aiModel: 'gpt-4o-mini',
        aiExplainLanguage: 'vi',
      },
    })
    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: env.sessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async (_url, init) => {
        const body = JSON.parse(init.body)
        sentSystem = body.messages[0].content
        sentUser = body.messages[1].content
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Quét tuần tự bảng orders',
                    bottlenecks: [{ title: 'Seq Scan', detail: 'Thiếu index trên total', severity: 'high' }],
                    optimizedSql: 'SELECT id FROM orders WHERE total > 10;',
                    indexSuggestions: [{ ddl: 'CREATE INDEX idx_orders_total ON orders(total);', reason: 'Lọc nhanh' }],
                    caveats: [],
                  }),
                },
              },
            ],
          }),
          text: async () => '',
        }
      },
    })
    await env.call('ai.key.set', { key: 'sk-test-12345678901234567890', baseUrl: 'https://api.openai.com/v1' })

    const analysis = await env.call<{ summary: string; language: string; indexSuggestions: Array<{ ddl: string }> }>(
      'ai.explainAnalyze',
      {
        connectionId: 'c1',
        dialect: 'postgres',
        sql: 'SELECT * FROM orders WHERE total > 10;',
        planColumns: [{ name: 'QUERY PLAN', type: 'TEXT' }],
        planRows: [['Seq Scan on orders']],
        language: 'vi',
      }
    )
    expect(sentSystem).toContain('Vietnamese (Tiếng Việt)')
    expect(sentUser).toContain('idx_orders_created')
    expect(analysis.summary).toBe('Quét tuần tự bảng orders')
    expect(analysis.language).toBe('Vietnamese (Tiếng Việt)')
    expect(analysis.indexSuggestions).toHaveLength(1)
  })

  it('lazily fetches MongoDB collection schema details during ai.explainAnalyze', async () => {
    const fetchedTables: Array<{ table: string; schema?: string }> = []
    let sentSystem = ''
    let sentUser = ''
    const env = createFakeWorkerEnv({
      settings: {
        aiEnabled: true,
        aiFormat: 'openai',
        aiBaseUrl: 'https://api.openai.com/v1',
        aiModel: 'gpt-4o-mini',
        aiExplainLanguage: 'en',
      },
    })
    const mongoSessionManager = {
      ...env.sessionManager,
      getSession: async () => ({
        driverType: 'mongodb',
        getTableDetails: async (table: string, schema?: string) => {
          fetchedTables.push({ table, schema })
          return {
            name: table,
            schema: '',
            kind: 'table',
            primaryKey: ['_id'],
            columns: [
              { name: '_id', type: 'ObjectId', nativeType: 'ObjectId', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: false },
              { name: 'status', type: 'string', nativeType: 'string', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
            ],
            indexes: [{ name: 'idx_orders_status', isUnique: false, isPrimary: false, columns: ['status'] }],
            foreignKeys: [],
          }
        },
      }),
    } as unknown as SessionManager

    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: mongoSessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async (_url, init) => {
        const body = JSON.parse(init.body) as { messages: Array<{ content: string }> }
        sentSystem = body.messages[0].content
        sentUser = body.messages[1].content
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Uses COLLSCAN on orders.',
                    bottlenecks: [{ title: 'COLLSCAN', detail: 'No index used', severity: 'high' }],
                    optimizedSql: null,
                    indexSuggestions: [],
                    caveats: [],
                  }),
                },
              },
            ],
          }),
          text: async () => '',
        }
      },
    })
    await env.call('ai.key.set', { key: 'sk-test-12345678901234567890', baseUrl: 'https://api.openai.com/v1' })

    const res = await env.call<{ summary: string }>('ai.explainAnalyze', {
      connectionId: 'mongo-1',
      dialect: 'mongodb',
      sql: "db.orders.find({ status: 'paid' })",
      planColumns: [{ name: 'stage', type: 'TEXT' }],
      planRows: [['COLLSCAN']],
      language: 'en',
    })
    expect(res.summary).toBe('Uses COLLSCAN on orders.')
    expect(fetchedTables).toEqual([{ table: 'orders', schema: undefined }])
    expect(sentSystem).toContain('MongoDB Shell / MQL')
    expect(sentUser).toContain('idx_orders_status(status)')

    await env.call('ai.explainAnalyze', {
      connectionId: 'mongo-1',
      dialect: 'mongodb',
      sql: "db.getCollection('users').aggregate([{ $match: { active: true } }])",
      planColumns: [{ name: 'stage', type: 'TEXT' }],
      planRows: [['COLLSCAN']],
      language: 'en',
    })
    expect(fetchedTables).toEqual([
      { table: 'orders', schema: undefined },
      { table: 'users', schema: undefined },
    ])
  })

  it('exposes explainMaxTokens default 2048 and passes configured aiExplainMaxTokens to EXPLAIN requests', async () => {
    const sentMaxTokens: number[] = []
    const env = createFakeWorkerEnv({
      settings: {
        aiEnabled: true,
        aiFormat: 'openai',
        aiBaseUrl: 'https://api.openai.com/v1',
        aiModel: 'gpt-4o-mini',
        aiExplainLanguage: 'vi',
      },
    })
    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: env.sessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async (_url, init) => {
        const body = JSON.parse(init.body) as { max_tokens?: number }
        if (typeof body.max_tokens === 'number') sentMaxTokens.push(body.max_tokens)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: '{"summary":"OK","bottlenecks":[],"optimizedSql":null,"indexSuggestions":[],"caveats":[]}' } }],
          }),
          text: async () => '',
        }
      },
    })
    await env.call('ai.key.set', { key: 'sk-test-12345678901234567890', baseUrl: 'https://api.openai.com/v1' })

    const defaultStatus = await env.call<{ explainMaxTokens: number }>('ai.status.get')
    expect(defaultStatus.explainMaxTokens).toBe(2048)

    await env.call('ai.explainAnalyze', {
      dialect: 'sqlite',
      sql: 'SELECT * FROM users LIMIT 10;',
      planColumns: [{ name: 'detail', type: 'TEXT' }],
      planRows: [['SCAN users']],
    })
    expect(sentMaxTokens[0]).toBe(2048)

    await env.orca.settings.set('aiExplainMaxTokens', 4096)
    const updatedStatus = await env.call<{ explainMaxTokens: number }>('ai.status.get')
    expect(updatedStatus.explainMaxTokens).toBe(4096)

    await env.call('ai.explainAnalyze', {
      dialect: 'sqlite',
      sql: 'SELECT * FROM users LIMIT 10;',
      planColumns: [{ name: 'detail', type: 'TEXT' }],
      planRows: [['SCAN users']],
    })
    expect(sentMaxTokens[1]).toBe(4096)

    await env.orca.settings.set('aiExplainMaxTokens', 99999)
    const clampedStatus = await env.call<{ explainMaxTokens: number }>('ai.status.get')
    expect(clampedStatus.explainMaxTokens).toBe(8192)
  })

  it('caps FIM suffix to <= 250 chars for Ollama/Mistral, scans full unsliced prefix/suffix for secrets, and keys cache by activeSchema/activeTable', async () => {
    const sentBodies: Array<Record<string, unknown>> = []
    const env = createFakeWorkerEnv({
      settings: {
        aiEnabled: true,
        aiFormat: 'ollama',
        aiBaseUrl: 'http://localhost:11434/v1',
        aiModel: 'qwen2.5-coder:1.5b',
      },
    })
    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: env.sessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async (_url, init) => {
        const body = JSON.parse(init.body) as Record<string, unknown>
        sentBodies.push(body)
        return {
          ok: true,
          status: 200,
          json: async () => ({ response: 'id FROM users;' }),
          text: async () => '',
        }
      },
    })

    const longSuffix = ' FROM users WHERE ' + 'a'.repeat(1000)
    const rOllama = await env.call<{ suggestion: string }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT ',
      suffix: longSuffix,
      activeSchema: 'public',
      activeTable: 'users',
    })
    expect(rOllama.suggestion).toBe('id FROM users;')
    expect(sentBodies).toHaveLength(1)
    expect(String(sentBodies[0].suffix ?? '').length).toBeLessThanOrEqual(250)

    // Changing activeTable or activeSchema with identical prefix/suffix must NOT reuse stale cache
    await env.call('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT ',
      suffix: longSuffix,
      activeSchema: 'public',
      activeTable: 'orders',
    })
    expect(sentBodies).toHaveLength(2)

    await env.call('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT ',
      suffix: longSuffix,
      activeSchema: 'analytics',
      activeTable: 'orders',
    })
    expect(sentBodies).toHaveLength(3)

    // Secret far beyond 250-char FIM suffix or 8000-char prefix window must STILL block completion
    const farSuffixSecret = ' '.repeat(3500) + 'sk-proj-abcdefghijklmnopqrstuvwxyz123456'
    const blockedSuffix = await env.call<{ suggestion: string; id: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT ',
      suffix: farSuffixSecret,
      activeSchema: 'public',
      activeTable: 'users',
    })
    expect(blockedSuffix).toEqual({ suggestion: '', id: 0 })
    expect(sentBodies).toHaveLength(3)

    const farPrefixSecret =
      "ALTER USER admin PASSWORD 'SuperSecretPassword98765!';\n" + '-- pad\n'.repeat(2000) + 'SELECT '
    const blockedPrefix = await env.call<{ suggestion: string; id: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: farPrefixSecret,
      suffix: '',
    })
    expect(blockedPrefix).toEqual({ suggestion: '', id: 0 })
    expect(sentBodies).toHaveLength(3)

    // Mistral FIM also caps suffix to <= 250 chars
    await env.orca.settings.set('aiFormat', 'mistral-fim')
    await env.orca.settings.set('aiBaseUrl', 'https://api.mistral.ai/v1')
    await env.orca.settings.set('aiModel', 'codestral-latest')
    await env.call('ai.key.set', { key: 'sk-mistral-12345678901234567890', baseUrl: 'https://api.mistral.ai/v1' })
    const mistralBodies: Array<Record<string, unknown>> = []
    const envM = createFakeWorkerEnv({
      settings: {
        aiEnabled: true,
        aiFormat: 'mistral-fim',
        aiBaseUrl: 'https://api.mistral.ai/v1',
        aiModel: 'codestral-latest',
      },
    })
    registerAiHandlers({
      orca: envM.orca,
      registerHandler: envM.registerHandler,
      sessionManager: envM.sessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async (_url, init) => {
        const body = JSON.parse(init.body) as Record<string, unknown>
        mistralBodies.push(body)
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'id FROM orders;' } }] }),
          text: async () => '',
        }
      },
    })
    await envM.call('ai.key.set', { key: 'sk-mistral-12345678901234567890', baseUrl: 'https://api.mistral.ai/v1' })
    await envM.call('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT ',
      suffix: longSuffix,
    })
    expect(mistralBodies).toHaveLength(1)
    expect(String(mistralBodies[0].suffix ?? '').length).toBeLessThanOrEqual(250)
  })

  it('serves longest-prefix forward typing and backspace hits from cache with one fetch', async () => {
    let fetches = 0
    const env = createFakeWorkerEnv({
      settings: { aiEnabled: true, aiFormat: 'openai', aiBaseUrl: 'https://api.openai.com/v1', aiModel: 'gpt-4o-mini' },
    })
    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: env.sessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async () => {
        fetches++
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'WHERE id = 1;' } }] }),
          text: async () => '',
        }
      },
    })
    await env.call('ai.key.set', { key: 'sk-test-12345678901234567890', baseUrl: 'https://api.openai.com/v1' })

    const base = await env.call<{ suggestion: string }>('ai.complete', {
      dialect: 'sqlite',
      prefix: 'SELECT * FROM users ',
      suffix: '',
    })
    expect(base.suggestion).toBe('WHERE id = 1;')
    expect(fetches).toBe(1)

    const forward1 = await env.call<{ suggestion: string }>('ai.complete', {
      dialect: 'sqlite',
      prefix: 'SELECT * FROM users WH',
      suffix: '',
    })
    expect(forward1.suggestion).toBe('ERE id = 1;')
    expect(fetches).toBe(1)

    const forward2 = await env.call<{ suggestion: string }>('ai.complete', {
      dialect: 'sqlite',
      prefix: 'SELECT * FROM users WHERE ',
      suffix: '',
    })
    expect(forward2.suggestion).toBe('id = 1;')
    expect(fetches).toBe(1)

    const backspace = await env.call<{ suggestion: string }>('ai.complete', {
      dialect: 'sqlite',
      prefix: 'SELECT * FROM users ',
      suffix: '',
    })
    expect(backspace.suggestion).toBe('WHERE id = 1;')
    expect(fetches).toBe(1)
  })

  it('reuses cached completion when backspacing over a short safe tail with one fetch', async () => {
    let fetches = 0
    const env = createFakeWorkerEnv({
      settings: { aiEnabled: true, aiFormat: 'openai', aiBaseUrl: 'https://api.openai.com/v1', aiModel: 'gpt-4o-mini' },
    })
    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: env.sessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async () => {
        fetches++
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: ' = 1;' } }] }),
          text: async () => '',
        }
      },
    })
    await env.call('ai.key.set', { key: 'sk-test-12345678901234567890', baseUrl: 'https://api.openai.com/v1' })

    const typed = await env.call<{ suggestion: string }>('ai.complete', {
      dialect: 'sqlite',
      prefix: 'SELECT * FROM users WHERE id',
      suffix: '',
    })
    expect(typed.suggestion).toBe(' = 1;')
    expect(fetches).toBe(1)

    const backspaced = await env.call<{ suggestion: string }>('ai.complete', {
      dialect: 'sqlite',
      prefix: 'SELECT * FROM users WHERE ',
      suffix: '',
    })
    expect(backspaced.suggestion).toBe('id = 1;')
    expect(fetches).toBe(1)
  })

  it('coalesces concurrent identical ai.complete calls for a panel onto one fetch', async () => {
    let fetches = 0
    const env = createFakeWorkerEnv({
      settings: { aiEnabled: true, aiFormat: 'openai', aiBaseUrl: 'https://api.openai.com/v1', aiModel: 'gpt-4o-mini' },
    })
    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: env.sessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async () => {
        fetches++
        await new Promise((resolve) => setTimeout(resolve, 20))
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'id FROM users;' } }] }),
          text: async () => '',
        }
      },
    })
    await env.call('ai.key.set', { key: 'sk-test-12345678901234567890', baseUrl: 'https://api.openai.com/v1' })

    const input = { dialect: 'sqlite', prefix: 'SELECT ', suffix: '' }
    const [r1, r2] = await Promise.all([
      env.call<{ suggestion: string }>('ai.complete', input),
      env.call<{ suggestion: string }>('ai.complete', input),
    ])
    expect(fetches).toBe(1)
    expect(r1.suggestion).toBe('id FROM users;')
    expect(r2.suggestion).toBe('id FROM users;')
  })

  it('forwards buildSqlCompletionContext multiline to completeSql', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const env = createFakeWorkerEnv({
      settings: { aiEnabled: true, aiFormat: 'openai', aiBaseUrl: 'https://api.openai.com/v1', aiModel: 'gpt-4o-mini' },
    })
    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: env.sessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async (_url, init) => {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>)
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'id = 1;' } }] }),
          text: async () => '',
        }
      },
    })
    await env.call('ai.key.set', { key: 'sk-test-12345678901234567890', baseUrl: 'https://api.openai.com/v1' })

    await env.call('ai.complete', {
      dialect: 'sqlite',
      prefix: 'SELECT * FROM users ',
      suffix: 'WHERE id = 1;',
    })
    expect(bodies).toHaveLength(1)
    expect(bodies[0].stop).toEqual(['\n', ';', '```'])
    expect(bodies[0].max_tokens).toBeLessThanOrEqual(48)
  })

  it('keeps a coalesced waiter alive when another waiter aborts', async () => {
    let fetches = 0
    let upstreamSignal: AbortSignal | undefined
    let releaseFetch: () => void = () => {}
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    const env = createFakeWorkerEnv({
      settings: { aiEnabled: true, aiFormat: 'openai', aiBaseUrl: 'https://api.openai.com/v1', aiModel: 'gpt-4o-mini' },
    })
    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: env.sessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async (_url, init) => {
        fetches++
        upstreamSignal = init.signal ?? undefined
        await fetchGate
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'id FROM users;' } }] }),
          text: async () => '',
        }
      },
    })
    await env.call('ai.key.set', { key: 'sk-test-12345678901234567890', baseUrl: 'https://api.openai.com/v1' })

    const ac1 = new AbortController()
    const ac2 = new AbortController()
    const input = { dialect: 'sqlite', prefix: 'SELECT ', suffix: '' }
    const p1 = env.call<{ suggestion: string }>('ai.complete', input, 'studio-1', ac1.signal)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const p2 = env.call<{ suggestion: string }>('ai.complete', input, 'studio-1', ac2.signal)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetches).toBe(1)

    ac1.abort()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(upstreamSignal?.aborted).toBe(false)

    releaseFetch()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.suggestion).toBe('')
    expect(r2.suggestion).toBe('id FROM users;')
    expect(upstreamSignal?.aborted).toBe(false)
  })

  it('aborts the shared upstream only after every coalesced waiter aborts', async () => {
    let fetches = 0
    let upstreamSignal: AbortSignal | undefined
    let releaseFetch: () => void = () => {}
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    const env = createFakeWorkerEnv({
      settings: { aiEnabled: true, aiFormat: 'openai', aiBaseUrl: 'https://api.openai.com/v1', aiModel: 'gpt-4o-mini' },
    })
    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: env.sessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async (_url, init) => {
        fetches++
        upstreamSignal = init.signal ?? undefined
        await fetchGate
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'id FROM users;' } }] }),
          text: async () => '',
        }
      },
    })
    await env.call('ai.key.set', { key: 'sk-test-12345678901234567890', baseUrl: 'https://api.openai.com/v1' })

    const ac1 = new AbortController()
    const ac2 = new AbortController()
    const input = { dialect: 'sqlite', prefix: 'SELECT ', suffix: '' }
    const p1 = env.call<{ suggestion: string }>('ai.complete', input, 'studio-1', ac1.signal)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const p2 = env.call<{ suggestion: string }>('ai.complete', input, 'studio-1', ac2.signal)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetches).toBe(1)

    ac1.abort()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(upstreamSignal?.aborted).toBe(false)

    ac2.abort()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(upstreamSignal?.aborted).toBe(true)

    releaseFetch()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.suggestion).toBe('')
    expect(r2.suggestion).toBe('')
  })

  it('does not collide in exactCacheKey when >300-char prefixes share a 300-char tail or >100-char suffixes share a 100-char head', async () => {
    const sharedTail = 'status = 1 AND deleted_at IS NULL AND '.repeat(10) // 380 chars
    const prefixA = `SELECT alpha_col FROM alpha_tbl WHERE ${sharedTail}`
    const prefixB = `SELECT beta_col  FROM beta_tbl  WHERE ${sharedTail}`
    expect(prefixA.slice(-300)).toBe(prefixB.slice(-300))

    let fetches = 0
    const env = createFakeWorkerEnv({
      settings: { aiEnabled: true, aiFormat: 'openai', aiBaseUrl: 'https://api.openai.com/v1', aiModel: 'gpt-4o-mini' },
    })
    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: env.sessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async (_url, init) => {
        fetches += 1
        const body = JSON.parse(init.body) as { messages: Array<{ content: string }> }
        const usr = body.messages[1]?.content ?? ''
        const text = usr.includes('alpha_tbl')
          ? 'alpha_flag = 1;'
          : usr.includes('beta_tbl')
            ? 'beta_flag = 1;'
            : usr.includes('table_one')
              ? 'one_id'
              : 'two_id'
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: text } }] }),
          text: async () => '',
        }
      },
    })
    await env.call('ai.key.set', { key: 'sk-test-12345678901234567890', baseUrl: 'https://api.openai.com/v1' })

    const resA1 = await env.call<{ suggestion: string }>('ai.complete', {
      dialect: 'postgres',
      prefix: prefixA,
      suffix: '',
    })
    expect(resA1.suggestion).toBe('alpha_flag = 1;')
    expect(fetches).toBe(1)

    const resB1 = await env.call<{ suggestion: string }>('ai.complete', {
      dialect: 'postgres',
      prefix: prefixB,
      suffix: '',
    })
    expect(resB1.suggestion).toBe('beta_flag = 1;')
    expect(fetches).toBe(2)

    // Repeat both: exact cache hits without extra fetches
    const resA2 = await env.call<{ suggestion: string }>('ai.complete', {
      dialect: 'postgres',
      prefix: prefixA,
      suffix: '',
    })
    const resB2 = await env.call<{ suggestion: string }>('ai.complete', {
      dialect: 'postgres',
      prefix: prefixB,
      suffix: '',
    })
    expect(resA2.suggestion).toBe('alpha_flag = 1;')
    expect(resB2.suggestion).toBe('beta_flag = 1;')
    expect(fetches).toBe(2)

    // Suffixes > 100 chars sharing identical 100-char head must not collide either
    const sharedSuffixHead = ' '.repeat(110)
    const resS1 = await env.call<{ suggestion: string }>('ai.complete', {
      dialect: 'postgres',
      prefix: 'SELECT ',
      suffix: `${sharedSuffixHead}FROM table_one`,
    })
    const resS2 = await env.call<{ suggestion: string }>('ai.complete', {
      dialect: 'postgres',
      prefix: 'SELECT ',
      suffix: `${sharedSuffixHead}FROM table_two`,
    })
    expect(resS1.suggestion).toBe('one_id')
    expect(resS2.suggestion).toBe('two_id')
    expect(fetches).toBe(4)
  })

  it('rejects glued mid-word clauses and caches normalized partial-word/delimiter completions cleanly in ai.complete', async () => {
    let fetches = 0
    const replies = ['WHERE id = 1', 'LIMIT 100', 'WHERE active = true']
    const env = createFakeWorkerEnv({
      settings: { aiEnabled: true, aiFormat: 'openai', aiBaseUrl: 'https://api.openai.com/v1', aiModel: 'gpt-4o-mini' },
    })
    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: env.sessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async () => {
        const content = replies[fetches++] ?? ''
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content } }] }),
          text: async () => '',
        }
      },
    })
    await env.call('ai.key.set', { key: 'sk-test-12345678901234567890', baseUrl: 'https://api.openai.com/v1' })

    // Glued LIM + WHERE is rejected and NOT cached
    const glued = await env.call<{ suggestion: string; id: number }>('ai.complete', {
      dialect: 'postgres',
      prefix: 'SELECT * FROM "banners" LIM',
      suffix: '',
    })
    expect(glued).toEqual({ suggestion: '', id: 0 })
    expect(fetches).toBe(1)

    // Next attempt for same prefix fetches again, strips repeated LIM -> 'IT 100', and caches cleanly
    const limDedup = await env.call<{ suggestion: string; id: number }>('ai.complete', {
      dialect: 'postgres',
      prefix: 'SELECT * FROM "banners" LIM',
      suffix: '',
    })
    expect(limDedup.suggestion).toBe('IT 100')
    expect(fetches).toBe(2)

    // Forward typing 'I' hits cache cleanly without refetching
    const forward = await env.call<{ suggestion: string }>('ai.complete', {
      dialect: 'postgres',
      prefix: 'SELECT * FROM "banners" LIMI',
      suffix: '',
    })
    expect(forward.suggestion).toBe('T 100')
    expect(fetches).toBe(2)

    // Backspacing to closing quote reuses cached completion with leading space
    const backspacedToQuote = await env.call<{ suggestion: string }>('ai.complete', {
      dialect: 'postgres',
      prefix: 'SELECT * FROM "banners"',
      suffix: '',
    })
    expect(backspacedToQuote.suggestion).toBe(' LIMIT 100')
    expect(fetches).toBe(2)

    // Uncached closing quote + WHERE normalizes leading space
    const afterQuote = await env.call<{ suggestion: string }>('ai.complete', {
      dialect: 'postgres',
      prefix: 'SELECT * FROM "orders"',
      suffix: '',
    })
    expect(afterQuote.suggestion).toBe(' WHERE active = true')
    expect(fetches).toBe(3)
  })

  it('runs ai.fixQuery happy path with 3-tier schema context, language resolution, maxTokens cap, and status update', async () => {
    let sentSystem = ''
    let sentUser = ''
    let sentMaxTokens: number | undefined
    const env = createFakeWorkerEnv({
      settings: {
        aiEnabled: true,
        aiFormat: 'openai',
        aiBaseUrl: 'https://api.openai.com/v1',
        aiModel: 'gpt-4o-mini',
        aiExplainLanguage: 'vi',
        aiExplainMaxTokens: 4096,
      },
    })
    const schemaCache = new WorkerSchemaMetadataCache()
    schemaCache.setObjects('c1', [
      { name: 'banners', schema: 'public', kind: 'table' },
      { name: 'campaigns', schema: 'public', kind: 'table' },
    ])
    schemaCache.setTableDetails('c1', {
      name: 'banners',
      schema: 'public',
      kind: 'table',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: 'bigint', nativeType: 'int8', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true },
        { name: 'title', type: 'text', nativeType: 'text', nullable: false, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
      ],
      indexes: [],
      foreignKeys: [],
    })

    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: env.sessionManager,
      schemaCache,
      fetchPost: async (_url, init) => {
        const body = JSON.parse(init.body) as {
          max_tokens?: number
          messages: Array<{ content: string }>
        }
        sentMaxTokens = body.max_tokens
        sentSystem = body.messages[0].content
        sentUser = body.messages[1].content
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    fixedSql: 'SELECT * FROM "banners" LIMIT 100;',
                    explanation: 'Từ khóa LIM bị thiếu ký tự cuối, đã hoàn thiện thành LIMIT 100.',
                    changesSummary: 'Hoàn thiện từ khóa LIM thành LIMIT 100',
                  }),
                },
              },
            ],
          }),
          text: async () => '',
        }
      },
    })
    await env.call('ai.key.set', {
      key: 'sk-test-12345678901234567890',
      baseUrl: 'https://api.openai.com/v1',
    })

    const res = await env.call<{
      fixedSql: string
      explanation: string
      changesSummary: string
      language: string
      model: string
      durationMs: number
    }>('ai.fixQuery', {
      connectionId: 'c1',
      dialect: 'postgres',
      sql: 'SELECT * FROM "banners" LIM',
      errorMessage: 'ERROR: syntax error at or near "LIM"',
      activeSchema: 'public',
      activeTable: 'banners',
      schemaMap: { campaigns: ['id', 'name'] },
      language: 'vi',
    })

    expect(sentMaxTokens).toBe(4096)
    expect(sentSystem).toContain('PostgreSQL')
    expect(sentSystem).toContain('Vietnamese (Tiếng Việt)')
    expect(sentUser).toContain('public.banners (id bigint PK, title text)')
    expect(sentUser).toContain('campaigns(id, name)')
    expect(res.fixedSql).toBe('SELECT * FROM "banners" LIMIT 100;')
    expect(res.explanation).toContain('LIMIT 100')
    expect(res.changesSummary).toContain('LIM')
    expect(res.language).toBe('Vietnamese (Tiếng Việt)')
    expect(res.model).toBe('gpt-4o-mini')
    expect(typeof res.durationMs).toBe('number')
    expect(res.durationMs).toBeGreaterThanOrEqual(0)

    // Floor at 2048 when explainMaxTokens is smaller, and cap at 8192 when larger
    await env.orca.settings.set('aiExplainMaxTokens', 512)
    await env.call('ai.fixQuery', {
      connectionId: 'c1',
      dialect: 'postgres',
      sql: 'SELECT * FROM "banners" LIM',
      errorMessage: 'ERROR: syntax error at or near "LIM"',
    })
    expect(sentMaxTokens).toBe(2048)

    await env.orca.settings.set('aiExplainMaxTokens', 16384)
    await env.call('ai.fixQuery', {
      connectionId: 'c1',
      dialect: 'postgres',
      sql: 'SELECT * FROM "banners" LIM',
      errorMessage: 'ERROR: syntax error at or near "LIM"',
    })
    expect(sentMaxTokens).toBe(8192)

    const status = await env.call<{ state: string; lastMs: number | null; reason: string | null }>(
      'ai.status.get'
    )
    expect(status.state).toBe('on')
    expect(status.lastMs).toBeGreaterThanOrEqual(0)
    expect(status.reason).toBeNull()
  })

  it('rejects ai.fixQuery when input is invalid, AI is disabled, key is missing/unpinned, or baseUrl fails validation', async () => {
    let fetches = 0
    const env = createFakeWorkerEnv({
      settings: {
        aiEnabled: false,
        aiFormat: 'openai',
        aiBaseUrl: 'https://api.openai.com/v1',
        aiModel: 'gpt-4o-mini',
      },
    })
    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: env.sessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async () => {
        fetches++
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: '{}' } }] }),
          text: async () => '',
        }
      },
    })

    // Empty sql / errorMessage
    await expect(
      env.call('ai.fixQuery', { dialect: 'postgres', sql: '   ', errorMessage: 'syntax error' })
    ).rejects.toThrow(/SQL query is required/i)
    await expect(
      env.call('ai.fixQuery', { dialect: 'postgres', sql: 'SELECT 1', errorMessage: '   ' })
    ).rejects.toThrow(/Error message is required/i)

    // AI disabled
    await expect(
      env.call('ai.fixQuery', { dialect: 'postgres', sql: 'SELECT * FROM t LIM', errorMessage: 'syntax error' })
    ).rejects.toThrow(/Enable AI SQL Assistant/i)

    // Enabled but missing key
    await env.orca.settings.set('aiEnabled', true)
    await expect(
      env.call('ai.fixQuery', { dialect: 'postgres', sql: 'SELECT * FROM t LIM', errorMessage: 'syntax error' })
    ).rejects.toThrow(/Configure an AI provider/i)

    // Key pinned to openai, then baseUrl swapped to another host (unpinned) -> rejected
    await env.call('ai.key.set', {
      key: 'sk-test-12345678901234567890',
      baseUrl: 'https://api.openai.com/v1',
    })
    await env.orca.settings.set('aiBaseUrl', 'https://other-provider.example/v1')
    await env.orca.settings.set('aiFormat', 'openai')
    // Non-preset openai URL falls back to custom-openai (optional key); test invalid/SSRF URLs instead:
    await env.orca.settings.set('aiBaseUrl', 'file:///etc/passwd')
    await expect(
      env.call('ai.fixQuery', { dialect: 'postgres', sql: 'SELECT * FROM t LIM', errorMessage: 'syntax error' })
    ).rejects.toThrow(/Configure an AI provider/i)

    await env.orca.settings.set('aiBaseUrl', 'https://user:pass@evil.example/v1')
    await expect(
      env.call('ai.fixQuery', { dialect: 'postgres', sql: 'SELECT * FROM t LIM', errorMessage: 'syntax error' })
    ).rejects.toThrow(/Configure an AI provider/i)

    // Non-loopback HTTP with pinned API key must be blocked
    await env.orca.storage.set('datanoa.ai.keyAddress', 'http://169.254.169.254/v1')
    await env.orca.settings.set('aiBaseUrl', 'http://169.254.169.254/v1')
    await expect(
      env.call('ai.fixQuery', { dialect: 'postgres', sql: 'SELECT * FROM t LIM', errorMessage: 'syntax error' })
    ).rejects.toThrow(/Configure an AI provider/i)

    // Unpinned key on preset provider requiring a key (Anthropic)
    await env.orca.settings.set('aiFormat', 'anthropic')
    await env.orca.settings.set('aiBaseUrl', 'https://api.anthropic.com')
    await expect(
      env.call('ai.fixQuery', { dialect: 'postgres', sql: 'SELECT * FROM t LIM', errorMessage: 'syntax error' })
    ).rejects.toThrow(/Configure an AI provider/i)

    expect(fetches).toBe(0)
  })

  it('blocks ai.fixQuery when sql or errorMessage contains secrets, and scrubs sensitive fragments before prompting', async () => {
    let fetches = 0
    let sentUser = ''
    const env = createFakeWorkerEnv({
      settings: {
        aiEnabled: true,
        aiFormat: 'openai',
        aiBaseUrl: 'https://api.openai.com/v1',
        aiModel: 'gpt-4o-mini',
        aiExplainLanguage: 'en',
      },
    })
    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: env.sessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async (_url, init) => {
        fetches++
        const body = JSON.parse(init.body) as { messages: Array<{ content: string }> }
        sentUser = body.messages[1].content
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    fixedSql: 'SELECT id FROM orders LIMIT 10;',
                    explanation: 'Fixed syntax.',
                    changesSummary: 'Fixed LIMIT',
                  }),
                },
              },
            ],
          }),
          text: async () => '',
        }
      },
    })
    await env.call('ai.key.set', {
      key: 'sk-test-12345678901234567890',
      baseUrl: 'https://api.openai.com/v1',
    })

    // Secret in SQL
    await expect(
      env.call('ai.fixQuery', {
        dialect: 'postgres',
        sql: "ALTER USER admin WITH PASSWORD 'RealSecretPassword123!' LIM",
        errorMessage: 'ERROR: syntax error at or near "LIM"',
      })
    ).rejects.toThrow(
      'Query or error message appears to contain sensitive credentials/secrets and was not sent to AI.'
    )

    // API key in errorMessage
    await expect(
      env.call('ai.fixQuery', {
        dialect: 'postgres',
        sql: 'SELECT * FROM orders LIM',
        errorMessage: 'Failed using token sk-proj-abcdefghijklmnopqrstuvwxyz123456 near LIM',
      })
    ).rejects.toThrow(
      'Query or error message appears to contain sensitive credentials/secrets and was not sent to AI.'
    )

    // Credential URI in errorMessage
    await expect(
      env.call('ai.fixQuery', {
        dialect: 'postgres',
        sql: 'SELECT * FROM orders LIM',
        errorMessage: 'Connection postgres://admin:SuperSecret99@prod.internal:5432/app syntax error',
      })
    ).rejects.toThrow(
      'Query or error message appears to contain sensitive credentials/secrets and was not sent to AI.'
    )

    expect(fetches).toBe(0)

    // Non-secret opaque URI fragment in errorMessage is scrubbed via scrubCredentialsInText before prompt
    const res = await env.call<{ fixedSql: string }>('ai.fixQuery', {
      dialect: 'postgres',
      sql: 'SELECT id FROM orders LIM',
      errorMessage: 'ERROR: syntax error near LIM (see https://docs.internal/err#opaqueTokenSecret987)',
    })
    expect(fetches).toBe(1)
    expect(res.fixedSql).toBe('SELECT id FROM orders LIMIT 10;')
    expect(sentUser).not.toContain('opaqueTokenSecret987')
    expect(sentUser).toContain('#[REDACTED]')
  })

  it('scrubs provider errors cleanly in ai.fixQuery response and logs without emojis or poisoning global AI status', async () => {
    let shouldFail: 'error' | 'timeout' | 'ok' = 'error'
    const env = createFakeWorkerEnv({
      settings: {
        aiEnabled: true,
        aiFormat: 'openai',
        aiBaseUrl: 'https://api.openai.com/v1',
        aiModel: 'gpt-4o-mini',
      },
    })
    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: env.sessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async () => {
        if (shouldFail === 'error') {
          throw new Error(
            'Upstream failure at https://svc:TopSecretPass99@proxy.internal/v1?api_key=leak999#fragSecret'
          )
        }
        if (shouldFail === 'timeout') {
          const timeoutErr = new Error('The operation timed out')
          timeoutErr.name = 'TimeoutError'
          throw timeoutErr
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    fixedSql: 'SELECT * FROM orders LIMIT 100;',
                    explanation: 'Completed LIMIT keyword.',
                    changesSummary: 'LIM -> LIMIT 100',
                  }),
                },
              },
            ],
          }),
          text: async () => '',
        }
      },
    })
    await env.call('ai.key.set', {
      key: 'sk-test-12345678901234567890',
      baseUrl: 'https://api.openai.com/v1',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const statusPostsBefore = env.posts.filter((p) => p.event === 'ai.status.changed').length

    let caughtMessage = ''
    try {
      await env.call('ai.fixQuery', {
        dialect: 'postgres',
        sql: 'SELECT * FROM orders LIM',
        errorMessage: 'ERROR: syntax error at or near "LIM"',
      })
    } catch (err) {
      caughtMessage = err instanceof Error ? err.message : String(err)
    }

    expect(caughtMessage).not.toBe('')
    expect(caughtMessage).not.toContain('TopSecretPass99')
    expect(caughtMessage).not.toContain('leak999')
    expect(caughtMessage).not.toContain('fragSecret')

    expect(env.logs.length).toBeGreaterThan(0)
    for (const line of env.logs) {
      expect(line).not.toContain('TopSecretPass99')
      expect(line).not.toContain('leak999')
      expect(line).not.toContain('fragSecret')
      expect(line).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u)
    }

    // P1 regression guard: ai.fixQuery failure MUST NOT poison global AI state to 'error' or broadcast status
    const statusAfterError = await env.call<{ state: string; reason: string | null }>('ai.status.get')
    expect(statusAfterError.state).toBe('on')
    expect(statusAfterError.reason).toBeNull()
    expect(env.posts.filter((p) => p.event === 'ai.status.changed')).toHaveLength(statusPostsBefore)

    // TimeoutError also must NOT poison global AI state to 'slow' or 'error'
    shouldFail = 'timeout'
    await expect(
      env.call('ai.fixQuery', {
        dialect: 'postgres',
        sql: 'SELECT * FROM orders LIM',
        errorMessage: 'ERROR: syntax error at or near "LIM"',
      })
    ).rejects.toThrow(/timed out/i)
    const statusAfterTimeout = await env.call<{ state: string; reason: string | null }>('ai.status.get')
    expect(statusAfterTimeout.state).toBe('on')
    expect(statusAfterTimeout.reason).toBeNull()

    // Subsequent retry succeeds immediately
    shouldFail = 'ok'
    const retried = await env.call<{ fixedSql: string }>('ai.fixQuery', {
      dialect: 'postgres',
      sql: 'SELECT * FROM orders LIM',
      errorMessage: 'ERROR: syntax error at or near "LIM"',
    })
    expect(retried.fixedSql).toBe('SELECT * FROM orders LIMIT 100;')
  })

  it('returns replaceChars for mistyped SQL keywords and schema identifiers, preserves exact cache hit, and skips prefix/backspace cache delta', async () => {
    let fetches = 0
    const replies = [
      'SELECT * FROM banners',
      'banners WHERE active = true',
      'banners WHERE active = true',
      'banners LIMIT 50',
      'LIMIT 100',
      'WHERE id = 1',
    ]
    const env = createFakeWorkerEnv({
      settings: { aiEnabled: true, aiFormat: 'openai', aiBaseUrl: 'https://api.openai.com/v1', aiModel: 'gpt-4o-mini' },
    })
    const schemaCache = new WorkerSchemaMetadataCache()
    schemaCache.setObjects('c1', [{ name: 'banners', schema: 'public', kind: 'table' }])
    schemaCache.setTableDetails('c1', {
      name: 'banners',
      schema: 'public',
      kind: 'table',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: 'bigint', nativeType: 'int8', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true },
        { name: 'active', type: 'boolean', nativeType: 'bool', nullable: false, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
      ],
      indexes: [],
      foreignKeys: [],
    })
    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: env.sessionManager,
      schemaCache,
      fetchPost: async () => {
        const content = replies[fetches++] ?? ''
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content } }] }),
          text: async () => '',
        }
      },
    })
    await env.call('ai.key.set', { key: 'sk-test-12345678901234567890', baseUrl: 'https://api.openai.com/v1' })

    // 1. Misspelled SQL keyword -> replaceChars = 5
    const rKeyword = await env.call<{ suggestion: string; id: number; replaceChars?: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELCT',
      suffix: '',
    })
    expect(rKeyword.suggestion).toBe('SELECT * FROM banners')
    expect(rKeyword.replaceChars).toBe(5)
    expect(fetches).toBe(1)

    // Exact cache hit returns replaceChars safely without refetch
    const rKeywordCached = await env.call<{ suggestion: string; id: number; replaceChars?: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELCT',
      suffix: '',
    })
    expect(rKeywordCached.suggestion).toBe('SELECT * FROM banners')
    expect(rKeywordCached.replaceChars).toBe(5)
    expect(fetches).toBe(1)

    // 2. Misspelled table name resolved via schemaCache / schemaMap -> replaceChars = 6
    const rTable = await env.call<{ suggestion: string; id: number; replaceChars?: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT * FROM baners',
      suffix: '',
      schemaMap: { campaigns: ['id', 'title'] },
    })
    expect(rTable.suggestion).toBe('banners WHERE active = true')
    expect(rTable.replaceChars).toBe(6)
    expect(fetches).toBe(2)

    // 3. Forward typing or backspacing from a replaceChars > 0 entry MUST NOT reuse prefix/backspace cache delta
    const rBackspaced = await env.call<{ suggestion: string; id: number; replaceChars?: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT * FROM baner',
      suffix: '',
    })
    expect(fetches).toBe(3)
    expect(rBackspaced.suggestion).toBe('banners WHERE active = true')
    expect(rBackspaced.replaceChars).toBe(5)

    const rExtended = await env.call<{ suggestion: string; id: number; replaceChars?: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT * FROM banerss',
      suffix: '',
    })
    expect(fetches).toBe(4)
    expect(rExtended.suggestion).toBe('banners LIMIT 50')
    expect(rExtended.replaceChars).toBe(7)

    // 4. Normal prefix completion keeps clean append with no replaceChars
    const rNormalPrefix = await env.call<{ suggestion: string; id: number; replaceChars?: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT * FROM banners LIM',
      suffix: '',
    })
    expect(rNormalPrefix.suggestion).toBe('IT 100')
    expect(rNormalPrefix.replaceChars).toBeUndefined()
    expect(fetches).toBe(5)

    // 5. Unrelated keyword gluing (LIM + WHERE) is STILL rejected as ''
    const rGlued = await env.call<{ suggestion: string; id: number; replaceChars?: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT * FROM campaigns LIM',
      suffix: '',
    })
    expect(rGlued).toEqual({ suggestion: '', id: 0 })
    expect(fetches).toBe(6)
  })

  it('pre-heals mistyped SQL tokens before buildSqlCompletionContext for both chat and FIM models while preserving aliases and mid-word prefixes', async () => {
    const seenPrompts: string[] = []
    const fimReplies: Record<string, string> = {
      SELECT: ' * FROM "banners" LIMIT 100',
      'SELECT ': '* FROM "banners"',
      'SELECT * FROM ': '"banners"',
      'SELECT * FROM "banners" LIMIT ': '100',
      'SELECT * FROM UserProfiles ': 'WHERE active = true',
      'ORDER BY id DESC': '',
      'SELECT * FROM orders o ': 'WHERE o.id = 1',
      'SELECT * FROM "banners" LIM': 'IT 100',
    }
    const env = createFakeWorkerEnv({
      settings: {
        aiEnabled: true,
        aiFormat: 'ollama',
        aiBaseUrl: 'http://localhost:11434/v1',
        aiModel: 'qwen2.5-coder:1.5b',
      },
    })
    const schemaCache = new WorkerSchemaMetadataCache()
    schemaCache.setObjects('c1', [
      { name: 'banners', schema: 'public', kind: 'table' },
      { name: 'orders', schema: 'public', kind: 'table' },
      { name: 'UserProfiles', schema: 'public', kind: 'table' },
    ])

    registerAiHandlers({
      orca: env.orca,
      registerHandler: env.registerHandler,
      sessionManager: env.sessionManager,
      schemaCache,
      fetchPost: async (_url, init) => {
        const body = JSON.parse(init.body) as { prompt: string }
        seenPrompts.push(body.prompt)
        const queryTail = body.prompt.split('*/\n').pop() ?? ''
        const response = fimReplies[queryTail] ?? ''
        return {
          ok: true,
          status: 200,
          json: async () => ({ response }),
          text: async () => '',
        }
      },
    })

    // 1. SELCT (no space) + continuation-only FIM response
    const rSelctNoSpace = await env.call<{ suggestion: string; replaceChars?: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELCT',
      suffix: '',
    })
    expect(rSelctNoSpace).toMatchObject({
      suggestion: 'SELECT * FROM "banners" LIMIT 100',
      replaceChars: 5,
    })
    expect(seenPrompts[0].endsWith('*/\nSELECT')).toBe(true)

    // 2. SELCT  (with trailing space) + continuation-only FIM response
    const rSelctSpace = await env.call<{ suggestion: string; replaceChars?: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELCT ',
      suffix: '',
    })
    expect(rSelctSpace).toMatchObject({
      suggestion: 'SELECT * FROM "banners"',
      replaceChars: 6,
    })
    expect(seenPrompts[1].endsWith('*/\nSELECT ')).toBe(true)

    // 3. SELECT * FORM  -> FROM "banners", replaceChars: 5
    const rForm = await env.call<{ suggestion: string; replaceChars?: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT * FORM ',
      suffix: '',
    })
    expect(rForm).toMatchObject({
      suggestion: 'FROM "banners"',
      replaceChars: 5,
    })

    // 4. SELECT * FROM "banners" LIMI  (with space) -> LIMIT 100, replaceChars: 5
    const rLimiSpace = await env.call<{ suggestion: string; replaceChars?: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT * FROM "banners" LIMI ',
      suffix: '',
    })
    expect(rLimiSpace).toMatchObject({
      suggestion: 'LIMIT 100',
      replaceChars: 5,
    })

    // 5. Exact identifier casing preserved: UserProfils  -> UserProfiles WHERE active = true
    const rExactCase = await env.call<{ suggestion: string; replaceChars?: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT * FROM UserProfils ',
      suffix: '',
    })
    expect(rExactCase).toMatchObject({
      suggestion: 'UserProfiles WHERE active = true',
      replaceChars: 12,
    })

    // 6. ORDER BY id DSEC + empty continuation -> DESC, replaceChars: 4
    const rDsec = await env.call<{ suggestion: string; replaceChars?: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'ORDER BY id DSEC',
      suffix: '',
    })
    expect(rDsec).toMatchObject({
      suggestion: 'DESC',
      replaceChars: 4,
    })

    // 7. Short table alias after FROM NOT replaced
    const rAlias = await env.call<{ suggestion: string; replaceChars?: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT * FROM orders o ',
      suffix: '',
    })
    expect(rAlias.suggestion).toBe('WHERE o.id = 1')
    expect(rAlias.replaceChars).toBeUndefined()

    // 8. Mid-word prefix without space (LIM) stays normal append with no replaceChars
    const rMidWord = await env.call<{ suggestion: string; replaceChars?: number }>('ai.complete', {
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT * FROM "banners" LIM',
      suffix: '',
    })
    expect(rMidWord.suggestion).toBe('IT 100')
    expect(rMidWord.replaceChars).toBeUndefined()
  })

  it('applies light 8s auto-cooldown only after >=2 consecutive errors, never blocks manual triggers, and self-heals on success', async () => {
    let now = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      let fetches = 0
      let mode: '504' | 'ok' = '504'
      const env = createFakeWorkerEnv({
        settings: {
          aiEnabled: true,
          aiFormat: 'openai',
          aiBaseUrl: 'https://api.openai.com/v1',
          aiModel: 'gpt-4o-mini',
        },
      })
      registerAiHandlers({
        orca: env.orca,
        registerHandler: env.registerHandler,
        sessionManager: env.sessionManager,
        schemaCache: new WorkerSchemaMetadataCache(),
        fetchPost: async () => {
          fetches += 1
          if (mode === '504') {
            return { ok: false, status: 504, json: async () => ({}), text: async () => '' }
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content: ' LIMIT 100' } }] }),
            text: async () => '',
          }
        },
      })
      await env.call('ai.key.set', {
        key: 'sk-test-12345678901234567890',
        baseUrl: 'https://api.openai.com/v1',
      })

      // 1st error: NEVER pauses automatic triggers
      const err1 = await env.call<{ suggestion: string; id: number }>('ai.complete', {
        dialect: 'postgres',
        prefix: 'SELECT * FROM "banners" 1',
        suffix: '',
        manual: false,
      })
      expect(err1).toEqual({ suggestion: '', id: 0 })
      expect(fetches).toBe(1)

      // 2nd consecutive error: runs (not paused on 1st error) and activates 8s auto cooldown
      const err2 = await env.call<{ suggestion: string; id: number }>('ai.complete', {
        dialect: 'postgres',
        prefix: 'SELECT * FROM "banners" 2',
        suffix: '',
        manual: false,
      })
      expect(err2).toEqual({ suggestion: '', id: 0 })
      expect(fetches).toBe(2)

      // 3rd automatic call within 8s is paused cleanly (0 upstream fetches)
      now += 2_000
      const pausedAuto = await env.call<{ suggestion: string; id: number }>('ai.complete', {
        dialect: 'postgres',
        prefix: 'SELECT * FROM "banners" 3',
        suffix: '',
        manual: false,
      })
      expect(pausedAuto).toEqual({ suggestion: '', id: 0 })
      expect(fetches).toBe(2)

      // Manual trigger (Tab) ALWAYS bypasses auto cooldown even inside the 8s window
      mode = 'ok'
      const manualOk = await env.call<{ suggestion: string; id: number }>('ai.complete', {
        dialect: 'postgres',
        prefix: 'SELECT * FROM "banners" LIMI',
        suffix: '',
        manual: true,
      })
      expect(fetches).toBe(3)
      expect(manualOk.suggestion).toBe('T 100')

      // Success immediately heals status to 'on', clears lastError, and resets cooldown for auto triggers!
      const healedStatus = await env.call<{ state: string; reason: string | null }>('ai.status.get')
      expect(healedStatus.state).toBe('on')
      expect(healedStatus.reason).toBeNull()
      await new Promise((r) => setTimeout(r, 0))
      const lastBroadcast = env.posts.filter((p) => p.event === 'ai.status.changed').at(-1)?.payload as
        | { state?: string; reason?: string | null }
        | undefined
      expect(lastBroadcast?.state).toBe('on')
      expect(lastBroadcast?.reason).toBeNull()

      const autoAfterHeal = await env.call<{ suggestion: string; id: number }>('ai.complete', {
        dialect: 'postgres',
        prefix: 'SELECT * FROM "orders" LIMI',
        suffix: '',
        manual: false,
      })
      expect(fetches).toBe(4)
      expect(autoAfterHeal.suggestion).toBe('T 100')

      // Trigger cooldown again (2 consecutive errors), then advance past 8s -> auto resumes naturally
      mode = '504'
      await env.call('ai.complete', { dialect: 'postgres', prefix: 'SELECT a1', suffix: '', manual: false })
      await env.call('ai.complete', { dialect: 'postgres', prefix: 'SELECT a2', suffix: '', manual: false })
      expect(fetches).toBe(6)
      await env.call('ai.complete', { dialect: 'postgres', prefix: 'SELECT a3', suffix: '', manual: false })
      expect(fetches).toBe(6)

      now += 8_001
      mode = 'ok'
      const resumed = await env.call<{ suggestion: string }>('ai.complete', {
        dialect: 'postgres',
        prefix: 'SELECT * FROM "items" LIMI',
        suffix: '',
        manual: false,
      })
      expect(fetches).toBe(7)
      expect(resumed.suggestion).toBe('T 100')
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('recovers ai.fixQuery & ai.explainAnalyze from transient HTTP 504 via SSE streaming + retry and surfaces actionable 504 message on double failure', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const env = createFakeWorkerEnv({
        settings: {
          aiEnabled: true,
          aiFormat: 'openai',
          aiBaseUrl: 'https://api.openai.com/v1',
          aiModel: 'gpt-4o-mini',
          aiExplainLanguage: 'en',
        },
      })
      const enc = new TextEncoder()
      registerAiHandlers({
        orca: env.orca,
        registerHandler: env.registerHandler,
        sessionManager: env.sessionManager,
        schemaCache: new WorkerSchemaMetadataCache(),
        fetchPost: async (_url, init) => {
          calls += 1
          const body = JSON.parse(init.body) as { stream?: boolean; reasoning_effort?: string }
          expect(body.stream).toBe(true)
          expect(body.reasoning_effort).toBe('low')
          if (calls === 1 || calls >= 3) {
            return { ok: false, status: 504, json: async () => ({}), text: async () => '' }
          }
          const payload = JSON.stringify({
            fixedSql: 'SELECT * FROM "banners" LIMIT 100;',
            explanation: 'Completed LIMIT.',
            changesSummary: 'LIMI -> LIMIT 100',
          })
          return {
            ok: true,
            status: 200,
            headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: payload } }] })}\n\n`))
                controller.enqueue(enc.encode('data: [DONE]\n\n'))
                controller.close()
              },
            }),
            json: async () => ({}),
            text: async () => '',
          }
        },
      })
      await env.call('ai.key.set', {
        key: 'sk-test-12345678901234567890',
        baseUrl: 'https://api.openai.com/v1',
      })

      // 1. Transient 504 recovers on 2nd attempt via SSE stream
      const fixP = env.call<{ fixedSql: string }>('ai.fixQuery', {
        dialect: 'postgres',
        sql: 'SELECT * FROM "banners" LIMI',
        errorMessage: 'syntax error at or near "LIMI"',
      })
      await vi.advanceTimersByTimeAsync(1_500)
      const fixed = await fixP
      expect(fixed.fixedSql).toBe('SELECT * FROM "banners" LIMIT 100;')
      expect(calls).toBe(2)

      // 2. Persistent 504 surfaces actionable HTTP 504 message in ai.explainAnalyze
      const explainP = env
        .call('ai.explainAnalyze', {
          dialect: 'postgres',
          sql: 'SELECT * FROM "banners"',
          planColumns: [{ name: 'QUERY PLAN', type: 'TEXT' }],
          planRows: [['Seq Scan on banners']],
        })
        .catch((err) => err)
      await vi.advanceTimersByTimeAsync(1_500)
      const explainErr = await explainP
      expect(explainErr).toBeInstanceOf(Error)
      expect((explainErr as Error).message).toContain('Provider gateway timed out (HTTP 504)')
      expect(calls).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })
})
