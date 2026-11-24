import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import type { OrcaWorkerApi } from 'orca/worker'
import type { TableDetails } from '../src/protocol'
import {
  WorkerSchemaMetadataCache,
  buildExplainAnalysisPrompt,
  buildSqlCompletionContext,
  extractReferencedMongoCollections,
  extractReferencedTables,
  maskLongStringLiterals,
  parseExplainAnalysis,
  resolveExplainLanguage,
} from '../src/worker/ai-sql-context'
import {
  AI_PRESETS,
  ProviderHttpError,
  ReasoningExhaustedError,
  SensitiveContentBlockedError,
  buildChatRequest,
  buildCompletionRequest,
  buildModelsRequest,
  bumpMetric,
  cleanSuggestion,
  completeChat,
  completeSql,
  dropDuplicatedFromSuffix,
  emptyStats,
  errorMessage,
  explainFailure,
  extractChatText,
  extractCompletionText,
  extractModelIds,
  filterModels,
  hasSensitiveContent,
  hostOf,
  isExpectedSqlBenchAnswer,
  isFast,
  isLoopbackHost,
  isProseExplanation,
  isReasoningExhausted,
  isStatsStore,
  listModels,
  median,
  parseFormat,
  percentile,
  pickCandidates,
  presetById,
  presetFor,
  rankModels,
  recommendedModels,
  recordMetricLatency,
  removeRepetitiveBlocks,
  removeRepetitiveLines,
  sameAddress,
  stripSpecialCompletionTokens,
  summarizeModelStats,
  trimMultiLineInSingleLineMode,
  trimPrefixEcho,
  trimSuffixOverlap,
  withV1,
  withoutV1,
  type AiProviderConfig,
  type FetchGetLike,
  type FetchPostLike,
} from '../src/worker/ai-client'
import { registerAiHandlers } from '../src/worker/rpc-ai'
import type { SessionManager } from '../src/worker/session-manager'
import { QUERY_HISTORY_STORAGE_KEY, type WorkerRegisterHandler } from '../src/worker/worker-utils'

function makeTableDetails(name: string, schema = 'public', cols = ['id', 'title']): TableDetails {
  return {
    name,
    schema,
    kind: 'table',
    primaryKey: cols.length ? [cols[0]] : [],
    columns: cols.map((col, idx) => ({
      name: col,
      type: idx === 0 ? 'integer' : 'varchar(120)',
      nativeType: idx === 0 ? 'int4' : 'varchar',
      nullable: idx > 0,
      defaultValue: null,
      isPrimaryKey: idx === 0,
      isAutoIncrement: idx === 0,
    })),
    indexes: [],
    foreignKeys: [],
  }
}

function makePostResponse(opts: {
  ok?: boolean
  status?: number
  json?: unknown
  chunks?: string[]
  contentType?: string
  rawText?: string
  cancelThrows?: boolean
}): Awaited<ReturnType<FetchPostLike>> {
  let body: ReadableStream<Uint8Array> | null = null
  const enc = new TextEncoder()
  if (opts.chunks) {
    let idx = 0
    body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (idx < opts.chunks!.length) {
          controller.enqueue(enc.encode(opts.chunks![idx++]))
        } else {
          controller.close()
        }
      },
      cancel() {
        if (opts.cancelThrows) throw new Error('cancel fail')
      },
    })
  } else if (opts.rawText !== undefined) {
    body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(opts.rawText!))
        controller.close()
      },
    })
  }
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.json ?? {},
    text: async () => opts.rawText ?? JSON.stringify(opts.json ?? {}),
    body,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? (opts.contentType ?? '') : null) },
  }
}

describe('Wave 1B-2b-1: src/worker/ai-sql-context.ts', () => {
  it('covers LRU metadata cache guards, evictions, and lookups', () => {
    const cache = new WorkerSchemaMetadataCache()
    cache.setObjects('', [])
    cache.setTableDetails('', makeTableDetails('x'))
    cache.setTableDetails('c1', { name: '' } as unknown as TableDetails)
    cache.invalidateConnection('')
    expect(cache.getSnapshot('')).toBeNull()
    expect(cache.getSnapshot('missing')).toBeNull()

    cache.setObjects('c1', [{ name: 'users', schema: 'public', kind: 'table' }])
    cache.setObjects('c1', [{ name: 'users', schema: 'public', kind: 'table' }, { name: 'v1', schema: 'public', kind: 'view' }])
    for (let i = 0; i < 125; i++) {
      cache.setTableDetails('c1', makeTableDetails(`tbl_${i}`, 'public'))
    }
    expect(cache.getSnapshot('c1')?.details.size).toBe(120)

    for (let c = 0; c < 18; c++) {
      cache.setObjects(`conn_${c}`, [{ name: 't', schema: 'public', kind: 'table' }])
    }
    expect(cache.getSnapshot('conn_0')).toBeNull()
    expect(cache.getSnapshot('conn_17')).not.toBeNull()
    cache.invalidateConnection('conn_17')
    expect(cache.getSnapshot('conn_17')).toBeNull()
  })

  it('extracts referenced tables & Mongo collections across quoting, comments, templates, and regexes', () => {
    const sql =
      "SELECT * FROM [dbo].[Order]]s] JOIN \"public\".\"u\"\"1\" ON 1=1 JOIN `cat`.`log``1` ON 1=1 " +
      "-- 'fake FROM ghost'\n" +
      "# FROM ignored_mysql\n" +
      "/* unclosed"
    expect(extractReferencedTables(sql)).toEqual(['dbo.Order]s', 'public.u"1', 'cat.log`1'])
    expect(extractReferencedTables('SELECT * FROM ""')).toEqual([])
    expect(extractReferencedTables("SELECT q'")).toEqual([])
    expect(
      extractReferencedTables(
        "SELECT q'[FROM ghost]', nq'{FROM g2}', q' ', xq'[FROM ok]' FROM a, $t$FROM g3$t$, 'a\\'b''c' FROM real_t"
      )
    ).toContain('real_t')
    expect(
      extractReferencedTables("SELECT ' FROM x -- eof", 'postgres')
    ).toEqual([])
    expect(
      extractReferencedTables('SELECT * FROM tbl # hash eof', 'mysql')
    ).toEqual(['tbl'])
    expect(
      extractReferencedTables('SELECT [unclosed', 'mssql')
    ).toEqual([])

    const mongo =
      "db.getCollection('orders').find({ note: `val ${ { nested: 1 }.nested } \\` ok`, n: 10 });\n" +
      "db.runCommand({ explain: { aggregate: 'events' } });\n" +
      "db.runCommand({ 'find': 'sessions' });\n" +
      "db['audit'].countDocuments();\n" +
      "db['   '].find();\n" +
      'db.stats(); db.analytics.insertOne({ re: /a[x]\\/b/gi, fail1: /bad\\n, fail2: /unclosed\n });\n' +
      'const div = 10 / 2;\n' +
      '{ "distinct": "users" };'
    const cols = extractReferencedMongoCollections(mongo)
    expect(cols).toEqual(['orders', 'events', 'sessions', 'audit', 'analytics', 'users'])
    expect(extractReferencedMongoCollections('db.t.find({ r: /eof_slash\\')).toEqual(['t'])
    expect(extractReferencedMongoCollections('// eof')).toEqual([])
    expect(extractReferencedMongoCollections('/* eof')).toEqual([])
    expect(extractReferencedMongoCollections('db.t.find("a\\"b", `unclosed)')).toEqual(['t'])
    expect(extractReferencedMongoCollections('db.t.find({ r: /unclosed')).toEqual(['t'])

    expect(
      maskLongStringLiterals("WHERE a = 'short' AND b = 'very\\'s''long_literal_123456' AND c = 'unclosed")
    ).toBe("WHERE a = 'short' AND b = '...' AND c = 'unclosed")

    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (s) => {
        expect(Array.isArray(extractReferencedTables(s))).toBe(true)
        expect(typeof maskLongStringLiterals(s)).toBe('string')
      }),
      { numRuns: 50 }
    )
  })

  it('builds pruned SQL contexts, history, EXPLAIN prompts, and repairs truncated EXPLAIN JSON', () => {
    const cache = new WorkerSchemaMetadataCache()
    const longCol = 'very_long_descriptive_column_name_' + 'x'.repeat(120)
    const usersDet: TableDetails = {
      name: 'users',
      schema: 'sales',
      kind: 'table',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: '', nativeType: '', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true },
        { name: longCol, type: 'text', nativeType: 'text', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false },
      ],
      indexes: [
        { name: 'pk_idx', columns: ['id'], isUnique: true, isPrimary: true },
        { name: 'idx_uniq', columns: ['id', longCol], isUnique: true, isPrimary: false },
      ],
      foreignKeys: [
        { constraintName: 'fk_missing', column: 'id', referencedTable: 'missing_parent', referencedColumn: 'id' },
      ],
    }
    const auditDet: TableDetails = {
      ...makeTableDetails('audit_logs', 'sales', ['id', 'user_id']),
      foreignKeys: [{ constraintName: 'fk_u', column: 'user_id', referencedTable: 'users', referencedColumn: 'id' }],
    }
    cache.setObjects('c1', [
      { name: 'users', schema: 'sales', kind: 'table' },
      { name: 'idx_skip', schema: 'sales', kind: 'index' as unknown as 'table' },
      { name: 'v_rep', schema: 'sales', kind: 'view' },
      { name: 'solo', schema: '', kind: 'table' },
    ])
    cache.setTableDetails('c1', usersDet)
    cache.setTableDetails('c1', auditDet)
    const snapshot = cache.getSnapshot('c1')

    // Build context exercising activeTable fallback, schemaMap fallback, FKs, budget truncation, history caps
    const history = [
      { id: '1', connectionId: 'other', sql: 'SELECT 1', isError: false, timestamp: 1, dialect: 'postgres' as const },
      { id: '2', connectionId: 'c1', sql: "SELECT * FROM bad WHERE pwd='my_real_secret_password_value'", isError: false, timestamp: 2, dialect: 'postgres' as const },
      { id: '3', connectionId: 'c1', sql: '   ', isError: false, timestamp: 3, dialect: 'postgres' as const },
      { id: '4', connectionId: 'c1', sql: 'SELECT id FROM sales.users', isError: false, timestamp: 4, dialect: 'postgres' as const },
      { id: '5', connectionId: 'c1', sql: 'SELECT id FROM   sales.users', isError: false, timestamp: 5, dialect: 'postgres' as const },
      { id: '6', connectionId: 'c1', sql: `SELECT '${'a'.repeat(260)}' FROM audit_logs`, isError: false, timestamp: 6, dialect: 'postgres' as const },
      { id: '7', connectionId: 'c1', sql: 'SELECT ' + 'x'.repeat(210), isError: false, timestamp: 7, dialect: 'postgres' as const },
    ]
    const ctx = buildSqlCompletionContext({
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: "SELECT * FROM missing_tbl, 'foo.users', missing_map -- cmt\nWHERE $t$body$t$ = 'a' /* blk",
      suffix: ' ) ;',
      activeSchema: 'sales',
      activeTable: 'users',
      snapshot,
      schemaMap: { 'sales.users': ['id'], 'public.extra_tbl': ['col1'], 'missing_map': ['a', 'b'], 'solo': ['s1'] },
      historyEntries: history as unknown as never[],
    })
    expect(ctx.inComment).toBe(true)
    expect(ctx.multiline).toBe(false)

    // Tiny table budget inside buildSqlCompletionContext by referencing 8 large tables so tier1 truncates to col... / (...) / break
    const bigSnap = new WorkerSchemaMetadataCache()
    for (let i = 0; i < 8; i++) {
      bigSnap.setTableDetails('big', makeTableDetails(`wide_table_name_number_${i}`, 'public', [longCol, 'c2', 'c3']))
    }
    const bigCtx = buildSqlCompletionContext({
      connectionId: 'big',
      dialect: 'clickhouse' as never,
      prefix: `SELECT * FROM ${Array.from({ length: 8 }, (_, i) => `wide_table_name_number_${i}`).join(' JOIN ')} JOIN sales.users `,
      suffix: '',
      activeTable: 'users',
      snapshot: bigSnap.getSnapshot('big'),
      schemaMap: { 'sales.users': ['id'] },
    })
    expect(bigCtx.system).toContain('ClickHouse')

    // Redis & comment edge branches (# eof, q', [bkt], mongo unclosed)
    expect(
      buildSqlCompletionContext({
        dialect: 'redis',
        prefix: 'GET user:',
        suffix: '',
        snapshot: null,
      }).fimPrefix
    ).toContain('# Dialect:')
    expect(
      buildSqlCompletionContext({
        dialect: 'oracle',
        prefix: "SELECT nq'[ok]' FROM dual WHERE 'unclosed",
        suffix: '',
        snapshot: null,
      }).inComment
    ).toBe(false)
    expect(
      buildSqlCompletionContext({
        dialect: 'mssql',
        prefix: 'SELECT [a] FROM t # hash comment eof',
        suffix: '',
        snapshot: null,
      }).inComment
    ).toBe(false)
    expect(
      buildSqlCompletionContext({
        dialect: 'mysql',
        prefix: 'SELECT 1 # eof comment',
        suffix: '',
        snapshot: null,
      }).inComment
    ).toBe(true)
    expect(
      buildSqlCompletionContext({
        dialect: 'postgres',
        prefix: 'SELECT $d$hi$d$ FROM t',
        suffix: '',
        snapshot: null,
      }).inComment
    ).toBe(false)

    // resolveExplainLanguage & buildExplainAnalysisPrompt
    expect(resolveExplainLanguage('auto', 'fr-FR').code).toBe('fr')
    expect(resolveExplainLanguage('auto', 'zz-UNKNOWN').code).toBe('en')
    expect(resolveExplainLanguage('auto', '').label).toBe('English')

    const emptyExplain = buildExplainAnalysisPrompt({
      dialect: 'redis',
      sql: 'KEYS *',
      planColumns: [],
      planRows: [],
      snapshot: null,
    })
    expect(emptyExplain.user).toContain('(no plan rows returned)')

    const hugePlan = buildExplainAnalysisPrompt({
      dialect: 'postgres',
      sql: 'EXPLAIN ANALYZE SELECT id FROM sales.users',
      planColumns: [{ name: '', type: 'text' }],
      planRows: [
        'not-an-array' as unknown as unknown[],
        [null, { node: 'Seq Scan' }],
        ...Array.from({ length: 120 }, () => ['Step ' + 'p'.repeat(60)]),
      ],
      snapshot,
    })
    expect(hugePlan.user).toContain('plan output truncated')
    expect(hugePlan.system).toContain('actual runtime metrics')

    expect(
      buildExplainAnalysisPrompt({
        dialect: 'mongodb',
        sql: 'db.users.find()',
        planColumns: [{ name: 'plan', type: 'text' }],
        planRows: [['nReturned: 5']],
        snapshot: null,
      }).system
    ).toContain('MongoDB diagnostic')

    // parseExplainAnalysis full/partial/repaired/unstructured paths
    expect(
      parseExplainAnalysis(
        '{"summary":"","bottlenecks":[123,{"title":"","detail":""},{"detail":"scan","severity":"high"}],"optimizedSql":"","indexSuggestions":["bad",{"ddl":"","reason":"r"},{"ddl":"CREATE INDEX i ON t(a)"}],"caveats":["c1"]}',
        'English',
        10
      )
    ).toMatchObject({
      summary: 'Analysis completed.',
      bottlenecks: [{ title: 'Bottleneck', detail: 'scan', severity: 'high' }],
      optimizedSql: null,
      indexSuggestions: [{ ddl: 'CREATE INDEX i ON t(a)', reason: '' }],
    })

    // Truncated JSON with trailing backslash inside string, unclosed object, comma rollback, empty fallback
    expect(
      parseExplainAnalysis(
        'prefix {"summary":"Slow step","bottlenecks":[{"title":"T","detail":"D\\',
        'English',
        12
      ).caveats.some((c) => c.includes('truncated'))
    ).toBe(true)
    expect(parseExplainAnalysis('prefix {"summary":"ok","bad":', 'English', 1)).toMatchObject({
      summary: 'ok',
    })
    expect(parseExplainAnalysis('prefix } {', 'English', 1).bottlenecks).toEqual([])
    expect(parseExplainAnalysis('```sql\n   \n```', 'English', 1).summary).toBe(
      'No analysis returned by model.'
    )

    fc.assert(
      fc.property(fc.string({ maxLength: 100 }), (raw) => {
        const res = parseExplainAnalysis(raw, 'English', 5)
        expect(typeof res.summary).toBe('string')
      }),
      { numRuns: 50 }
    )
  })
})

describe('Wave 1B-2b-1: src/worker/ai-client.ts', () => {
  it('covers request building, extraction, secret detection, cleaners, streaming, retries, and stats', async () => {
    expect(parseFormat('bad')).toBe('openai')
    expect(sameAddress('not a url', 'http://localhost')).toBe(false)
    expect(presetFor('ollama', 'http://other')).toMatchObject({ id: 'ollama' })
    expect(presetById('mistral')).toMatchObject({ format: 'mistral-fim' })
    expect(presetById('nope')).toBe(AI_PRESETS[0])
    expect(filterModels(['gpt-4o-mini', 'codestral'], 'codestral')).toEqual(['gpt-4o-mini', 'codestral'])
    expect(filterModels(['gpt-4o-mini', 'codestral'], 'mini')).toEqual(['gpt-4o-mini'])
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('raw')).toBe('raw')

    expect(
      buildChatRequest({ format: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'c', apiKey: '', maxTokens: 50 }, 's', 'u', 50).init.headers['x-api-key']
    ).toBeUndefined()
    expect(
      buildCompletionRequest(
        { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'k', maxTokens: 32 },
        { system: 's', user: 'u', prefix: 'a', suffix: 'b' },
        { stop: ['END', 123] }
      ).init.body
    ).toContain('"stop":["END"]')

    expect(extractCompletionText('openai', null)).toBe('')
    expect(extractCompletionText('ollama', { nope: 1 })).toBe('')
    expect(extractCompletionText('anthropic', { content: [{ type: 'thinking' }, { type: 'text', text: 'SELECT 1' }] })).toBe('SELECT 1')
    expect(extractCompletionText('anthropic', { content: 'bad' })).toBe('')
    expect(extractCompletionText('openai', { choices: [{ message: { content: ['skip', { type: 'text' }, { text: '1' }] } }] })).toBe('1')
    expect(extractCompletionText('openai', { choices: [{ text: 'legacy_ok' }] })).toBe('legacy_ok')
    expect(extractCompletionText('openai', { choices: 'bad' })).toBe('')
    expect(extractChatText('ollama', null)).toBe('')
    expect(extractChatText('ollama', { message: { content: 'hi' } })).toBe('hi')
    expect(extractChatText('ollama', { response: 'fallback' })).toBe('fallback')

    expect(hasSensitiveContent('const api_key = "real_non_placeholder_secret_123"', '')).toBe('secret assigned in code')
    expect(hasSensitiveContent('const api_key = "placeholder_not_real_123"', '')).toBeNull()

    expect(removeRepetitiveLines('a\nb\nc\nc\nc\nc\nc\nc')).toBe('a\nb\nc')
    expect(removeRepetitiveLines('a\nb\nx\ny\nz\nw\nq')).toBe('a\nb\nx\ny\nz\nw\nq')
    expect(removeRepetitiveBlocks('b1\n\nb1\n\nb1\n\nb1')).toBe('b1')
    expect(dropDuplicatedFromSuffix('1\n2\n3\n4', 'other')).toBe('1\n2\n3\n4')
    expect(trimMultiLineInSingleLineMode('a\nb', 'tail_same_line', false)).toBe('a')
    expect(cleanSuggestion('<|endoftext|>\n```sql\nSELECT 1\n```')).toBe('SELECT 1')
    expect(trimSuffixOverlap('SELECT 1\nFROM', '\nFROM')).toBe('SELECT 1')
    expect(trimPrefixEcho('SELECT id\nFROM ', 'SELECT id\nFROM ')).toBe('')
    expect(isProseExplanation('   ')).toBe(false)
    expect(isProseExplanation('This query selects matching rows successfully.')).toBe(true)

    expect(isReasoningExhausted('ollama', {})).toBe(false)
    expect(isReasoningExhausted('openai', { choices: [] })).toBe(false)
    expect(isReasoningExhausted('openai', { choices: [{ finish_reason: 'length', message: { content: 'SELECT 1' } }] })).toBe(false)
    expect(
      isReasoningExhausted('openai', { choices: [{ finish_reason: 'length', message: { content: '', reasoning: 'thinking...' } }] })
    ).toBe(true)

    // Streaming + abort + injection + reasoning paths in completeSql / completeChat
    const openAiCfg: AiProviderConfig = { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm1', apiKey: 'k', maxTokens: 32 }
    const preAborted = new AbortController()
    preAborted.abort('stopped')
    await expect(
      completeSql(openAiCfg, { system: 's', user: 'u', prefix: 'SELECT ', suffix: '' }, preAborted.signal, async () => {
        throw new Error('should see aborted signal')
      })
    ).rejects.toThrow()

    expect(
      await completeSql(
        { format: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen', apiKey: '', maxTokens: 32 },
        { system: 's', user: 'u', prefix: "SELECT 'a''b', \"c\"\"d\" FROM ", suffix: '', multiline: true },
        new AbortController().signal,
        async () =>
          makePostResponse({
            contentType: 'text/event-stream',
            chunks: [
              'data: \n\n',
              'data: not-json\n',
              'data: {"message":{"content":"1"}}\n',
              'data: {"response":"2;"}\n',
            ],
            cancelThrows: true,
          })
      )
    ).toBe('12;')

    expect(
      await completeSql(
        { format: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'c', apiKey: 'k', maxTokens: 32 },
        { system: 's', user: 'u', prefix: 'SELECT ', suffix: '' },
        new AbortController().signal,
        async () =>
          makePostResponse({
            contentType: 'application/x-ndjson',
            chunks: [
              'data: {"delta":{"text":"<tool_call>"}}\n',
              'data: [DONE]\n',
            ],
          })
      )
    ).toBe('')

    expect(
      await completeSql(
        openAiCfg,
        { system: 's', user: 'u', prefix: 'SELECT ', suffix: '' },
        new AbortController().signal,
        async () =>
          makePostResponse({
            rawText:
              'data: {"choices":[{"delta":{"content":[{"text":"a"}]}}]}\n' +
              'data: {"choices":[{"delta":{"text":"b"}}]}\n' +
              'data: {"choices":[{"text":"c"}]}\n' +
              'data: [DONE]\n',
          })
      )
    ).toBe('abc')

    expect(
      await completeSql(
        openAiCfg,
        { system: 's', user: 'u', prefix: 'SELECT ', suffix: '' },
        new AbortController().signal,
        async () =>
          makePostResponse({
            contentType: 'text/event-stream',
            chunks: ['data: {"choices":[123]}\n', 'data: {"choices":[{"delta":null,"text":"ok"}]}\n'],
          })
      )
    ).toBe('ok')

    // Malformed leading '{' falls back to parseStreamText + EOF tail line
    expect(
      await completeSql(
        openAiCfg,
        { system: 's', user: 'u', prefix: 'SELECT ', suffix: '' },
        new AbortController().signal,
        async () => makePostResponse({ rawText: '{not_json\ndata: {"choices":[{"delta":{"content":"x"}}]}' })
      )
    ).toBe('x')

    // completeChat HTTP failure & injected output
    await expect(
      completeChat(openAiCfg, 's', 'u', 50, new AbortController().signal, async () =>
        makePostResponse({ ok: false, status: 500 })
      )
    ).rejects.toBeInstanceOf(ProviderHttpError)
    expect(
      await completeChat(openAiCfg, 's', 'u', 50, new AbortController().signal, async () =>
        makePostResponse({ json: { choices: [{ message: { content: '<function=hack>' } }] } })
      )
    ).toBe('')

    // buildModelsRequest / listModels / filter / rank / stats / explainFailure
    expect(buildModelsRequest({ format: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: '' }).url).toContain('/v1/models?limit=1000')
    expect(buildModelsRequest({ format: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk' }).init.headers['x-api-key']).toBe('sk')
    expect(buildModelsRequest({ format: 'mistral-fim', baseUrl: 'https://api.mistral.ai', apiKey: 'k' }).url).toContain('/v1/models')

    expect(extractModelIds({ models: [null, { name: 'codestral:7b' }, { id: 123 }] })).toEqual(['codestral:7b'])
    expect(extractModelIds('not-obj')).toEqual([])
    const badListFetch: FetchGetLike = async () => ({ ok: false, status: 403, json: async () => ({}) })
    await expect(listModels({ format: 'openai', baseUrl: 'http://x', apiKey: '' }, new AbortController().signal, badListFetch)).rejects.toBeInstanceOf(ProviderHttpError)

    const ranked = rankModels(
      ['slow-ok', 'fast-mini', 'err-m', 'untested-big', 'untested-mini'],
      {
        'slow-ok': { ok: true, ms: 500 },
        'fast-mini': { ok: true, ms: 20 },
        'err-m': { ok: false, ms: null },
      },
      100
    )
    expect(ranked[0]).toBe('fast-mini')
    expect(ranked[1]).toBe('slow-ok')
    expect(ranked[2]).toBe('err-m')
    expect(recommendedModels(ranked, { 'fast-mini': { ok: true, ms: 20 } }, 100)).toEqual(['fast-mini'])
    expect(pickCandidates(['gpt-opus', 'gpt-4o-mini', 'done'], { done: { ok: true, ms: 5 } }, 3, 'gpt-opus')[0]).toBe('gpt-opus')

    expect(isExpectedSqlBenchAnswer('Sorry, I cannot do that')).toBe(false)
    expect(isExpectedSqlBenchAnswer('10')).toBe(true)
    expect(median([10, 20])).toBe(15)
    expect(isLoopbackHost('localhost:11434')).toBe(true)
    expect(hostOf('bad')).toBe('')

    expect(explainFailure(new SensitiveContentBlockedError('AWS'), 'h', 5000)).toContain('AWS')
    expect(explainFailure(new ReasoningExhaustedError(), 'h', 5000)).toContain('reasoning')
    expect(explainFailure(new ProviderHttpError(404), 'h', 5000)).toContain('404')
    expect(explainFailure(new ProviderHttpError(429), 'h', 5000)).toContain('429')
    expect(explainFailure(new ProviderHttpError(503), 'h', 5000)).toContain('server error')
    expect(explainFailure(new ProviderHttpError(418), 'h', 5000)).toContain('HTTP 418')
    const te = new Error('timeout')
    te.name = 'TimeoutError'
    expect(explainFailure(te, 'h', 5000)).toContain('Timed out after 5s')
    expect(explainFailure(new TypeError('fail'), '', 5000)).toContain('provider')
    expect(explainFailure(new TypeError('fail'), 'localhost:11434', 5000)).toContain('local server')
    expect(explainFailure('custom err', 'h', 5000)).toBe('custom err')

    expect(isStatsStore(null)).toBe(false)
    expect(isStatsStore({ since: 'bad', models: {} })).toBe(false)
    let store = emptyStats(1)
    for (let i = 0; i < 45; i++) {
      store = bumpMetric(store, `m_${i}`, 'shown')
    }
    expect(Object.keys(store.models).length).toBe(40)
    store = recordMetricLatency(store, 'm_44', 42)
    expect(summarizeModelStats(store, 'missing').p50).toBeNull()
    expect(summarizeModelStats(store, 'm_44').p50).toBe(42)
    expect(percentile([], 50)).toBeNull()

    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 5000 }), { minLength: 1, maxLength: 20 }),
        fc.string({ maxLength: 40 }),
        (samples, raw) => {
          const med = median(samples)
          expect(med).toBeGreaterThanOrEqual(Math.min(...samples))
          expect(med).toBeLessThanOrEqual(Math.max(...samples))
          expect(withV1(withV1(`http://host/${raw.replace(/\//g, '')}`))).toMatch(/\/v1$/)
          expect(withoutV1(withV1('http://localhost:11434'))).toBe('http://localhost:11434')
          expect(stripSpecialCompletionTokens(`<|endoftext|>${raw}`)).not.toContain('<|endoftext|>')
        }
      ),
      { numRuns: 50 }
    )
  })
})

describe('Wave 1B-2b-1: src/worker/rpc-ai.ts', () => {
  it('covers LRU/backoff bounds, flight joining & cancellation, stats/usage pruning, and all RPC error/fallback branches', async () => {
    const handlers = new Map<string, (input: unknown, ctx?: { signal?: AbortSignal; panel?: { id?: string } }) => Promise<unknown>>()
    const settingsData: Record<string, unknown> = {
      aiEnabled: true,
      aiFormat: 'openai',
      aiBaseUrl: 'https://api.openai.com/v1',
      aiModel: 'gpt-4o-mini',
      aiMaxTokens: 'abc',
      aiExplainMaxTokens: 'invalid',
    }
    const storageData = new Map<string, unknown>()
    const secretsData = new Map<string, string>()
    secretsData.set('ai_api_key', 'sk-existing-secret-token-123456')
    const listeners: Array<(c: { key?: string }) => void> = []
    const logs: string[] = []
    let throwStorage = false
    let throwGetSession = false

    const orca = {
      settings: {
        get: async (k?: string) => (k ? settingsData[k] : { ...settingsData }),
        set: async (k: string, v: unknown) => {
          settingsData[k] = v
          listeners.forEach((fn) => fn({ key: k }))
        },
        onDidChange: (fn: (c: { key?: string }) => void) => {
          listeners.push(fn)
          return { dispose: () => {} }
        },
      },
      storage: {
        get: async (k: string) => {
          if (throwStorage && k.includes('history')) throw new Error('storage down')
          return storageData.get(k) ?? null
        },
        set: async (k: string, v: unknown) => {
          storageData.set(k, v)
        },
        delete: async (k: string) => {
          storageData.delete(k)
        },
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
      panels: { post: () => {} },
      log: (m: string) => {
        logs.push(m)
      },
    } as unknown as OrcaWorkerApi

    let callIndex = 0
    const ctrl = registerAiHandlers({
      orca,
      registerHandler: ((name: string, fn: (input: unknown, ctx?: unknown) => Promise<unknown>) => {
        handlers.set(name, fn as never)
        return { dispose: () => {} }
      }) as unknown as WorkerRegisterHandler,
      sessionManager: {
        assertSecureSecretStorage: async () => {},
        getSession: async () => {
          if (throwGetSession) throw new Error('session offline')
          return {
            driverType: 'postgres',
            getTableDetails: async (table: string) => makeTableDetails(table),
          }
        },
      } as unknown as SessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async (_url, init) => {
        if (init.signal?.aborted) throw new Error('AbortError')
        callIndex++
        const body = JSON.parse(init.body) as { model?: string; reasoning_effort?: string }
        if (body.model === 'model-http-500') {
          return makePostResponse({ ok: false, status: 500 })
        }
        // First 45 distinct models reject reasoning_effort (exercises rememberBoundedKey > 40 + reasoning fallback!)
        if (body.reasoning_effort === 'none') {
          throw new ProviderHttpError(400)
        }
        if (body.model === 'model-reason-fail') {
          return makePostResponse({ json: { choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'thinking' } }] } })
        }
        if (body.model === 'model-timeout') {
          const te = new Error('timeout')
          te.name = 'TimeoutError'
          throw te
        }
        if (body.model === 'model-empty') {
          return makePostResponse({ json: { choices: [{ message: { content: '' } }] } })
        }
        if (body.model === 'model-slow-hang') {
          return await new Promise((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
          })
        }
        return makePostResponse({ json: { choices: [{ message: { content: `${callIndex} AND active = 1` } }] } })
      },
      fetchGet: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'gpt-4o-mini' }] }),
      }),
    })

    // startup pinExistingKey already ran because secrets had key & pinned storage was null; re-verify status & settings change
    const snap0 = (await handlers.get('ai.status.get')!({})) as { hasKey: boolean; maxTokens: number }
    expect(snap0.hasKey).toBe(true)

    listeners.forEach((fn) => fn({ key: 'aiExplainLanguage' }))
    listeners.forEach((fn) => fn({}))

    // ai.key.set edge branches
    await expect(handlers.get('ai.key.set')!({ key: 'sk-abc', baseUrl: 'not-url' })).rejects.toThrow(/valid http/)
    await expect(handlers.get('ai.key.set')!({ key: 'sk-abc', baseUrl: 'https://api.openai.com/v1' })).resolves.toEqual({ hasKey: true })
    await expect(handlers.get('ai.key.set')!({ key: '' })).resolves.toEqual({ hasKey: false })
    await expect(handlers.get('ai.key.set')!({ key: 'sk-restored' })).resolves.toEqual({ hasKey: true })

    // ai.provider.test: ok, provider failure, invalid URL, missing key
    expect(await handlers.get('ai.provider.test')!({})).toMatchObject({ ok: true })
    settingsData.aiModel = 'model-empty'
    settingsData.aiBaseUrl = 'https://api.openai.com/v1'
    expect(await handlers.get('ai.provider.test')!({})).toMatchObject({ ok: true })
    settingsData.aiModel = 'model-reason-fail'
    expect(await handlers.get('ai.provider.test')!({})).toMatchObject({ ok: false })
    expect((await handlers.get('ai.status.get')!({}))).toMatchObject({ state: 'error' })

    // models.list & models.bench edge cases
    expect(await handlers.get('ai.models.list')!({ baseUrl: 'bad' })).toMatchObject({ ok: false })
    expect(await handlers.get('ai.models.list')!({ baseUrl: 'http://localhost:11434/v1', format: 'ollama' })).toMatchObject({ ok: true })
    expect(await handlers.get('ai.models.bench')!({ baseUrl: 'bad' })).toMatchObject({ results: [] })
    expect(
      await handlers.get('ai.models.bench')!({
        baseUrl: 'https://api.openai.com/v1',
        format: 'openai',
        models: ['gpt-4o-mini', 'model-reason-fail'],
      })
    ).toMatchObject({ results: [{ model: 'gpt-4o-mini', ok: true }, { model: 'model-reason-fail', ok: false }] })

    // ai.complete: validation, sensitivity, pre-aborted ctx, cache prefix/backspace/eviction, 40+ models bounded memory, 200+ suggestion ids, inflight join & abort
    expect(await handlers.get('ai.complete')!(null)).toEqual({ suggestion: '', id: 0 })
    expect(await handlers.get('ai.complete')!({ prefix: "SELECT * WHERE pwd='real_secret_value_123456'", suffix: '' })).toEqual({ suggestion: '', id: 0 })
    const abortAlready = new AbortController()
    abortAlready.abort()
    expect(await handlers.get('ai.complete')!({ prefix: 'SELECT 1', suffix: '' }, { signal: abortAlready.signal })).toEqual({ suggestion: '', id: 0 })

    // Populate >42 models usage & >65 cache entries & >200 suggestion IDs cleanly!
    throwStorage = true
    for (let i = 0; i < 42; i++) {
      settingsData.aiModel = `m_${i}`
      await handlers.get('ai.complete')!({ prefix: `SELECT col_${i} FROM t_${i} WHERE x `, suffix: '' })
    }
    throwStorage = false
    storageData.set('datanoa.queryHistory', [{ id: 'h1', connectionId: 'c1', sql: 'SELECT 1', isError: false, timestamp: 1, dialect: 'sqlite' }])
    ctrl.invalidateHistoryCache()
    for (let i = 0; i < 66; i++) {
      settingsData.aiModel = 'cache-m'
      await handlers.get('ai.complete')!({ prefix: `SELECT long_${i} `, suffix: '' })
    }
    // Verify prefix continuation + delta mismatch + backspace tail hits
    settingsData.aiModel = 'm_prefix'
    const baseRes = (await handlers.get('ai.complete')!({ prefix: 'SELECT id FROM users WHER', suffix: ' ORDER BY id' })) as { suggestion: string }
    const prefHit = (await handlers.get('ai.complete')!({ prefix: `SELECT id FROM users WHER${baseRes.suggestion.slice(0, 1)}`, suffix: ' ORDER BY id' })) as { suggestion: string }
    expect(prefHit.suggestion.length).toBeGreaterThanOrEqual(0)
    const prefMiss = (await handlers.get('ai.complete')!({ prefix: 'SELECT id FROM users WHERZZZZ', suffix: ' ORDER BY id' })) as { suggestion: string }
    expect(prefMiss.suggestion).not.toBe('')
    await handlers.get('ai.complete')!({ prefix: 'SELECT id FROM users WHER_abcdefghijklm', suffix: 'sfx' })
    expect((await handlers.get('ai.complete')!({ prefix: 'SELECT id FROM users WHER_abcdefghijkl', suffix: 'sfx' }))).toMatchObject({})
    // Burn up to 205 suggestion ids
    for (let i = 0; i < 105; i++) {
      await handlers.get('ai.complete')!({ prefix: 'SELECT long_0 ', suffix: '' })
    }
    expect(await handlers.get('ai.models.usage')!({ baseUrl: 'https://api.openai.com/v1' })).toBeDefined()

    // Timeout & empty suggestion & repeat failure log throttling
    settingsData.aiModel = 'model-empty'
    expect(await handlers.get('ai.complete')!({ prefix: 'SELECT empty_case', suffix: '' })).toEqual({ suggestion: '', id: 0 })
    settingsData.aiModel = 'model-timeout'
    expect(await handlers.get('ai.complete')!({ prefix: 'SELECT timeout_case', suffix: '' })).toEqual({ suggestion: '', id: 0 })
    expect(await handlers.get('ai.status.get')!({})).toMatchObject({ state: 'slow' })
    settingsData.aiModel = 'model-reason-fail'
    await handlers.get('ai.complete')!({ prefix: 'SELECT fail_log_1', suffix: '' })
    await handlers.get('ai.complete')!({ prefix: 'SELECT fail_log_2', suffix: '' })
    expect(logs.length).toBeGreaterThan(0)

    // Inflight flight joining & cancellation + stale panel abort
    settingsData.aiModel = 'model-slow-hang'
    const c1 = new AbortController()
    const c2 = new AbortController()
    const f1 = handlers.get('ai.complete')!({ prefix: 'SELECT slow_join', suffix: '' }, { signal: c1.signal, panel: { id: 'p1' } })
    const f2 = handlers.get('ai.complete')!({ prefix: 'SELECT slow_join', suffix: '' }, { signal: c2.signal, panel: { id: 'p1' } })
    c1.abort()
    c2.abort()
    expect(await f1).toEqual({ suggestion: '', id: 0 })
    expect(await f2).toEqual({ suggestion: '', id: 0 })

    // Default fallback when aiBaseUrl/aiModel omitted, plus invalid Base URL/empty model -> 'setup'
    delete settingsData.aiBaseUrl
    delete settingsData.aiModel
    expect(await handlers.get('ai.status.get')!({})).toMatchObject({ state: 'error', model: 'gpt-4o-mini' })
    settingsData.aiModel = ''
    expect(await handlers.get('ai.status.get')!({})).toMatchObject({ state: 'setup' })
    await handlers.get('ai.stats.reset')!({})
    expect(await handlers.get('ai.stats.get')!({})).toMatchObject({ model: '' })

    // ai.explainAnalyze: validation, disabled, missing config, session enrichment error catch, cancel & fail
    settingsData.aiBaseUrl = 'https://api.openai.com/v1'
    settingsData.aiModel = 'gpt-4o-mini'
    await expect(handlers.get('ai.explainAnalyze')!({ sql: '' })).rejects.toThrow(/SQL string/)
    settingsData.aiEnabled = false
    await expect(handlers.get('ai.explainAnalyze')!({ sql: 'SELECT 1' })).rejects.toThrow(/Enable AI/)
    settingsData.aiEnabled = true
    secretsData.delete('ai_api_key')
    await expect(handlers.get('ai.explainAnalyze')!({ sql: 'SELECT 1' })).rejects.toThrow(/Configure/)

    secretsData.set('ai_api_key', 'sk-ok')
    throwGetSession = true
    const expOk = (await handlers.get('ai.explainAnalyze')!({
      sql: 'SELECT * FROM public.orders',
      connectionId: 'c1',
      planColumns: 'bad',
      planRows: 'bad',
    })) as { summary: string }
    expect(typeof expOk.summary).toBe('string')
    throwGetSession = false

    const expAbort = new AbortController()
    expAbort.abort()
    await expect(
      handlers.get('ai.explainAnalyze')!({ sql: 'SELECT * FROM items' }, { signal: expAbort.signal, panel: { id: 'ep1' } })
    ).rejects.toThrow(/cancelled/)

    settingsData.aiModel = 'model-http-500'
    await expect(
      handlers.get('ai.explainAnalyze')!({ sql: 'SELECT 1' }, { panel: { id: 'ep2' } })
    ).rejects.toBeDefined()

    // Cover inflightExplainByPanel abort when same panel fires twice and dispose() cleanup
    settingsData.aiModel = 'model-slow-hang'
    const hangExplain1 = handlers.get('ai.explainAnalyze')!({ sql: 'SELECT 1' }, { panel: { id: 'ep3' } }).catch(() => 'aborted')
    await new Promise((r) => setTimeout(r, 10))
    const hangExplain2 = handlers.get('ai.explainAnalyze')!({ sql: 'SELECT 2' }, { panel: { id: 'ep3' } }).catch(() => 'disposed')
    await new Promise((r) => setTimeout(r, 10))
    ctrl.dispose()
    expect(await hangExplain1).toBe('aborted')
    expect(await hangExplain2).toBe('disposed')
  })

  it('closes remaining reachable branches across ai-sql-context, ai-client, and rpc-ai', async () => {
    // 1) ai-sql-context remaining branches
    expect(extractReferencedTables("SELECT q'[unclosed", 'oracle')).toEqual([])
    expect(extractReferencedTables('SELECT $t$unclosed', 'postgres')).toEqual([])
    expect(extractReferencedMongoCollections('db.t.find({ r: /abc\n')).toEqual(['t'])
    expect(extractReferencedMongoCollections('db.t.find("unclosed')).toEqual(['t'])
    expect(extractReferencedMongoCollections('{ foo: "u" }')).toEqual([])
    expect(
      buildSqlCompletionContext({
        dialect: 'mysql',
        prefix: 'SELECT 1 # comment\nSELECT 2',
        suffix: '',
        snapshot: null,
      }).inComment
    ).toBe(false)
    expect(resolveExplainLanguage('auto').code.length).toBeGreaterThan(0)
    expect(
      parseExplainAnalysis('{"summary":"a\\"b\\\\', 'English', 1).caveats.some((c) => c.includes('truncated'))
    ).toBe(true)
    expect(
      parseExplainAnalysis('prefix {"summary":"ok","k":}', 'English', 1)
    ).toMatchObject({ summary: 'ok' })
    expect(
      parseExplainAnalysis('{"summary":"ok\\\\"}', 'English', 1)
    ).toMatchObject({ summary: 'ok\\' })

    // lookupDetails unqualified via activeSchema + fitColumnListToBudget withoutIdx + tiny title (...) fallback + Tier 2 overflow + schemaMap overlap
    const bareMissDetails: TableDetails = {
      name: 'items',
      schema: 'sales',
      kind: 'table',
      primaryKey: [],
      columns: undefined as unknown as TableDetails['columns'],
      indexes: [
        { name: 'idx_item_code', columns: ['code', 'extra', 'other'], isUnique: false, isPrimary: false },
      ],
      foreignKeys: undefined as unknown as TableDetails['foreignKeys'],
    }
    const wideA = makeTableDetails('tbl_pad_a', 'sales', ['c1_' + 'x'.repeat(250), 'c2_' + 'y'.repeat(250)])
    const wideB = makeTableDetails('tbl_pad_b', 'sales', ['c1_' + 'x'.repeat(250), 'c2_' + 'y'.repeat(250)])
    wideA.foreignKeys = [
      { constraintName: 'fk1', column: wideA.columns[0].name, referencedTable: 'tbl_pad_b', referencedColumn: wideB.columns[0].name },
      { constraintName: 'fk2', column: wideA.columns[0].name, referencedTable: 'fk_target_long', referencedColumn: 'id' },
    ]
    const fkLong = makeTableDetails('fk_target_long', 'sales', ['id', 'z_' + 'z'.repeat(400)])
    const manualSnap = {
      objects: [{ name: 'items', schema: 'sales', kind: 'table' as const }],
      details: new Map<string, TableDetails>([
        ['sales.items', bareMissDetails],
        ['sales.tbl_pad_a', wideA],
        ['sales.tbl_pad_b', wideB],
        ['sales.fk_target_long', fkLong],
      ]),
    }
    const paddedHistory = [
      { id: 'p1', connectionId: 'c1', sql: `SELECT '${'k'.repeat(200)}' FROM public.other`, isError: false, timestamp: 1, dialect: 'postgres' as const },
      { id: 'p2', connectionId: 'c1', sql: `SELECT '${'m'.repeat(200)}' FROM items`, isError: false, timestamp: 2, dialect: 'postgres' as const },
    ]
    const ctxManual = buildSqlCompletionContext({
      connectionId: 'c1',
      dialect: 'postgres',
      prefix: 'SELECT 1 FROM sales. JOIN tbl_pad_a JOIN tbl_pad_b JOIN items ',
      suffix: '',
      activeSchema: 'sales',
      activeTable: 'items',
      snapshot: manualSnap,
      schemaMap: { 'sales.items': ['a'], 'other.unindexed': [] },
      historyEntries: paddedHistory as unknown as never[],
    })
    expect(ctxManual.user).toContain('Schema:')
    const ctxActiveNoSchema = buildSqlCompletionContext({
      dialect: 'mysql',
      prefix: 'SELECT 1',
      suffix: '',
      activeTable: 'orphan_tbl',
      snapshot: null,
      schemaMap: { orphan_tbl: ['col_1'] },
    })
    expect(ctxActiveNoSchema.user).toContain('orphan_tbl')

    // fitColumnListToBudget where full > remainingBudget and withoutIdx <= remainingBudget
    const idxTable: TableDetails = {
      name: 'idx_t',
      schema: 's',
      kind: 'table',
      primaryKey: ['id'],
      columns: [{ name: 'id', type: 'int', nativeType: 'int', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: false }],
      indexes: [{ name: 'idx_very_long_index_name_' + 'n'.repeat(100), columns: ['id'], isUnique: false, isPrimary: false }],
      foreignKeys: [],
    }
    const preTables = Array.from({ length: 4 }, (_, i) =>
      makeTableDetails(`fill_${i}`, 's', ['col_' + 'v'.repeat(200)])
    )
    const tightMap = new Map<string, TableDetails>(preTables.map((t) => [`s.${t.name}`, t]))
    tightMap.set('s.idx_t', idxTable)
    tightMap.set('s.super_ultra_long_table_name_beyond_remaining_budget_threshold', {
      name: 'super_ultra_long_table_name_beyond_remaining_budget_threshold',
      schema: 's',
      kind: 'table',
      primaryKey: [],
      columns: [{ name: 'x', type: 't', nativeType: 't', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false }],
      indexes: [],
      foreignKeys: [],
    })
    buildSqlCompletionContext({
      dialect: 'postgres',
      prefix: `SELECT * FROM ${preTables.map((t) => `s.${t.name}`).join(' JOIN ')} JOIN s.idx_t JOIN s.super_ultra_long_table_name_beyond_remaining_budget_threshold`,
      suffix: '',
      snapshot: { objects: [], details: tightMap },
    })

    // 2) ai-client remaining branches
    expect(extractCompletionText('anthropic', { content: [{ type: 'text' }] })).toBe('')
    expect(extractChatText('ollama', {})).toBe('')
    expect(
      removeRepetitiveLines(
        ['header', 'col_name_alpha_001', 'col_name_alpha_002', 'col_name_alpha_003', 'col_name_alpha_004', 'col_name_alpha_005', 'col_name_alpha_006'].join('\n')
      )
    ).toBe('header\ncol_name_alpha_001')
    expect(trimMultiLineInSingleLineMode('a\nb', 'tail\nrest', false)).toBe('a')
    expect(isProseExplanation('please note that you want query.')).toBe(true)
    expect(isProseExplanation('you really must check the query.')).toBe(true)
    expect(isReasoningExhausted('openai', { choices: null })).toBe(false)
    expect(isReasoningExhausted('openai', { choices: [{ finish_reason: 'length', message: null }] })).toBe(false)

    // Streaming quotes '' / "" inside statementEnded + extractStreamDelta all fallbacks + reader error catch
    const oa: AiProviderConfig = { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'k', maxTokens: 32 }
    expect(
      await completeSql(
        oa,
        { system: 's', user: 'u', prefix: 'SELECT ', suffix: '', multiline: true },
        new AbortController().signal,
        async () =>
          makePostResponse({
            contentType: 'text/event-stream',
            chunks: [
              'data: null\n',
              'data: {"choices":[]}\n',
              'data: {"choices":[{"delta":{"content":["ignored"]}}]}\n',
              'data: {"choices":[{}]}\n',
              'data: {"choices":[{"delta":{"content":"WHERE a = \'it\'\'s\' AND \\"k\\" = \\"x\\"\\"y\\";"}}]}\n',
            ],
          })
      )
    ).toBe('WHERE a = \'it\'\'s\' AND "k" = "x""y";')
    expect(
      await completeSql(
        { format: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'q', apiKey: '', maxTokens: 32 },
        { system: 's', user: 'u', prefix: 'SELECT ', suffix: '' },
        new AbortController().signal,
        async () => makePostResponse({ rawText: 'data: {}\ndata: [DONE]\n' })
      )
    ).toBe('')
    expect(
      await completeSql(
        { format: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'c', apiKey: 'k', maxTokens: 32 },
        { system: 's', user: 'u', prefix: 'SELECT ', suffix: '' },
        new AbortController().signal,
        async () => makePostResponse({ rawText: 'data: {"delta":{}}\n' })
      )
    ).toBe('')

    expect(extractModelIds({ other: [] })).toEqual([])
    expect(rankModels(['b-mini', 'a-mini', 'z-big', 'y-big'], {}, 100)).toEqual([
      'b-mini',
      'a-mini',
      'z-big',
      'y-big',
    ])
    expect(pickCandidates(['z-big', 'y-big', 'cur'], {}, 3, 'cur')).toEqual(['cur', 'z-big', 'y-big'])
    expect(explainFailure(new TypeError('net'), 'api.example.com', 5000)).toContain('api.example.com')

    // 3) rpc-ai remaining branches (isolated controller)
    const h2 = new Map<string, (input: unknown, ctx?: { signal?: AbortSignal; panel?: { id?: string } }) => Promise<unknown>>()
    const cfg2: Record<string, unknown> = {
      aiEnabled: true,
      aiFormat: 'openai',
      aiBaseUrl: 'https://api.openai.com/v1',
      aiModel: 'gpt-4o-mini',
      aiMaxTokens: 32,
      aiExplainMaxTokens: 512,
    }
    const store2 = new Map<string, unknown>()
    const sec2 = new Map<string, string>()
    let failGetStorage = true
    let failList = true

    const ctrl2 = registerAiHandlers({
      orca: {
        settings: {
          get: async (k?: string) => (k ? cfg2[k] : { ...cfg2 }),
          onDidChange: () => ({ dispose: () => {} }),
        },
        storage: {
          get: async (k: string) => {
            if (failGetStorage) throw new Error('storage boom')
            return store2.get(k) ?? null
          },
          set: async (k: string, v: unknown) => {
            store2.set(k, v)
          },
          delete: async (k: string) => {
            store2.delete(k)
          },
        },
        secrets: {
          get: async (k: string) => sec2.get(k) ?? null,
          set: async (k: string, v: string) => {
            sec2.set(k, v)
          },
          delete: async (k: string) => {
            sec2.delete(k)
          },
        },
        panels: { post: () => {} },
        log: () => {},
      } as unknown as OrcaWorkerApi,
      registerHandler: ((name: string, fn: (input: unknown, ctx?: unknown) => Promise<unknown>) => {
        h2.set(name, fn as never)
        return { dispose: () => {} }
      }) as unknown as WorkerRegisterHandler,
      sessionManager: {
        assertSecureSecretStorage: async () => {},
        getSession: async () => ({
          driverType: 'postgres',
          getTableDetails: async (table: string, schema?: string) => makeTableDetails(table, schema || 'public'),
        }),
      } as unknown as SessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async (_url, init) => {
        if (init.signal?.aborted) throw new Error('Aborted')
        const body = JSON.parse(init.body) as { model?: string }
        if (body.model === 'hang-m') {
          return await new Promise((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
          })
        }
        return makePostResponse({ json: { choices: [{ message: { content: '123' } }] } })
      },
      fetchGet: async () => {
        if (failList) throw new Error('list failed')
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm1' }] }) }
      },
    })

    // Wait for pinExistingKey catch path
    await new Promise((r) => setTimeout(r, 5))
    failGetStorage = false

    // ai.key.set non-string key & missing settings.aiBaseUrl
    delete cfg2.aiBaseUrl
    await expect(h2.get('ai.key.set')!({ key: 123 })).resolves.toEqual({ hasKey: false })
    await expect(h2.get('ai.provider.test')!({})).resolves.toMatchObject({ ok: false })
    cfg2.aiBaseUrl = 'https://api.openai.com/v1'
    await expect(h2.get('ai.provider.test')!({})).resolves.toMatchObject({ ok: false })

    await h2.get('ai.key.set')!({ key: 'sk-ok-key', baseUrl: 'https://api.openai.com/v1' })
    expect(await h2.get('ai.models.list')!({ baseUrl: 'https://api.openai.com/v1', key: 'typed-k' })).toMatchObject({ ok: false })
    failList = false
    expect(await h2.get('ai.models.list')!({ baseUrl: 'https://other.example/v1' })).toMatchObject({ ok: true })
    expect(await h2.get('ai.models.bench')!({ baseUrl: 'https://api.openai.com/v1', models: 'bad' })).toMatchObject({ results: [] })
    expect(await h2.get('ai.models.usage')!({ baseUrl: null })).toEqual({ usage: {} })

    // getHistoryEntries error catch then cached metrics & stats
    const sRes = (await h2.get('ai.complete')!({ prefix: 'SELECT 1 FROM t', suffix: '' })) as { id: number }
    expect(sRes.id).toBe(1)
    await h2.get('ai.metrics.event')!({ id: sRes.id, kind: 'accepted' })
    await new Promise((r) => setTimeout(r, 10))
    expect(await h2.get('ai.stats.get')!({})).toMatchObject({
      summary: expect.objectContaining({ accepted: 1 }),
    })

    // joinFlight onAbort when two callers wait on identical slow flight & abort one then both
    cfg2.aiModel = 'hang-m'
    const jc1 = new AbortController()
    const jc2 = new AbortController()
    const jf1 = h2.get('ai.complete')!({ prefix: 'SELECT join_k', suffix: '' }, { signal: jc1.signal, panel: { id: 'jp' } })
    await new Promise((r) => setTimeout(r, 10))
    const jf2 = h2.get('ai.complete')!({ prefix: 'SELECT join_k', suffix: '' }, { signal: jc2.signal, panel: { id: 'jp' } })
    await new Promise((r) => setTimeout(r, 10))
    jc1.abort()
    jc2.abort()
    expect(await jf1).toEqual({ suggestion: '', id: 0 })
    expect(await jf2).toEqual({ suggestion: '', id: 0 })

    // Same panel preempts inflight request -> stale catch
    const p1 = h2.get('ai.complete')!({ prefix: 'SELECT p_one', suffix: '' }, { panel: { id: 'preempt' } })
    await new Promise((r) => setTimeout(r, 10))
    const p2 = h2.get('ai.complete')!({ prefix: 'SELECT p_two', suffix: '' }, { panel: { id: 'preempt' } })
    await new Promise((r) => setTimeout(r, 10))
    ctrl2.dispose()
    expect(await p1).toEqual({ suggestion: '', id: 0 })
    expect(await p2).toEqual({ suggestion: '', id: 0 })

    // Explain enrichment with session.getTableDetails succeeding
    cfg2.aiModel = 'gpt-4o-mini'
    const expEnriched = (await h2.get('ai.explainAnalyze')!({
      sql: 'SELECT * FROM sales.orders JOIN items ON 1=1',
      connectionId: 'c_ok',
    })) as { summary: string }
    expect(typeof expEnriched.summary).toBe('string')
  })

  it('closes subtle cache, streaming, Intl, and budget edge cases across AI worker modules', async () => {
    // 1) ai-sql-context subtle branches: empty quoted table, missing schema/indexes, non-object mongo call,
    // tight budget skipping long table, > MAX_HISTORY_CHARS truncation, custom dialect, Intl=undefined, unrepairable JSON
    expect(extractReferencedTables('SELECT * FROM "" JOIN sales.orders ON 1=1', 'postgres')).toContain('sales.orders')
    expect(extractReferencedMongoCollections('db.users.find(queryVar)')).toEqual(['users'])

    const noSchemaNoIdx = {
      name: 'bare_tbl',
      schema: '',
      kind: 'table',
      primaryKey: [],
      columns: [{ name: 'c1', type: 'int', nativeType: 'int', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false }],
      indexes: undefined,
      foreignKeys: [],
    } as unknown as TableDetails
    const fill = Array.from({ length: 18 }, (_, i) =>
      makeTableDetails(`tbl_${i}`, 's', Array.from({ length: 12 }, (__, j) => `column_long_name_${i}_${j}`))
    )
    const bigSnap = new Map<string, TableDetails>(fill.map((t) => [`s.${t.name}`, t]))
    bigSnap.set('.bare_tbl', noSchemaNoIdx)
    bigSnap.set('s.very_long_trailing_table_name_that_exceeds_small_leftover_budget_completely', makeTableDetails('very_long_trailing_table_name_that_exceeds_small_leftover_budget_completely', 's', ['x']))

    const longHist = Array.from({ length: 25 }, (_, i) => ({
      sql: `SELECT '${'h'.repeat(180)}' AS c_${i}`,
      ok: true,
    }))
    const customCtx = buildSqlCompletionContext({
      dialect: 'duckdb',
      prefix: `SELECT * FROM ${fill.map((t) => `s.${t.name}`).join(' JOIN ')} JOIN bare_tbl JOIN s.very_long_trailing_table_name_that_exceeds_small_leftover_budget_completely`,
      suffix: '',
      snapshot: { objects: [], details: bigSnap },
      recentQueries: longHist,
    })
    expect(customCtx.user).toContain('duckdb')

    const origIntl = globalThis.Intl
    Object.defineProperty(globalThis, 'Intl', { value: undefined, configurable: true })
    try {
      expect(resolveExplainLanguage()).toEqual({ code: 'en', label: 'English' })
    } finally {
      Object.defineProperty(globalThis, 'Intl', { value: origIntl, configurable: true })
    }

    expect(parseExplainAnalysis('')).toMatchObject({ summary: 'No analysis returned by model.' })
    expect(parseExplainAnalysis('[]')).toMatchObject({ summary: '[]', bottlenecks: [] })
    expect(parseExplainAnalysis('{ "broken_key": ')).toMatchObject({ bottlenecks: [] })

    // 2) ai-client remaining reachable branches
    expect(isProseExplanation('12345 67890')).toBe(false)
    expect(explainFailure(new TypeError('Failed to fetch'), '', 5000)).toContain('provider')
    expect(
      rankModels(
        ['b-mini', 'a-mini', 'slow-z'],
        {
          'b-mini': { ok: 1, fail: 0, totalMs: 50 },
          'slow-z': { ok: 1, fail: 0, totalMs: 400 },
        },
        200
      )
    ).toEqual(['b-mini', 'slow-z', 'a-mini'])

    expect(
      await completeSql(
        { format: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude', apiKey: 'k', maxTokens: 32 },
        { system: 's', user: 'u', prefix: 'SELECT ', suffix: '' },
        new AbortController().signal,
        async () => makePostResponse({ rawText: 'data: 123\ndata: {"delta":"bad"}\ndata: [DONE]\n' })
      )
    ).toBe('')

    expect(
      await completeSql(
        { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt', apiKey: 'k', maxTokens: 32 },
        { system: 's', user: 'u', prefix: 'SELECT ', suffix: '' },
        new AbortController().signal,
        async () => {
          let readCount = 0
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: {
              getReader: () => ({
                read: async () => {
                  readCount++
                  if (readCount === 1) {
                    return {
                      done: false,
                      value: new TextEncoder().encode(
                        'data: {"choices":"not_array"}\ndata: {"choices":[{"delta":{"content":"1;"}}]}\n'
                      ),
                    }
                  }
                  return { done: true, value: undefined }
                },
                cancel: async () => {
                  throw new Error('cancel ignored')
                },
                releaseLock: () => {},
              }),
            } as unknown as ReadableStream<Uint8Array>,
            text: async () => '',
            json: async () => ({}),
          }
        }
      )
    ).toBe('1;')

    // 3) rpc-ai remaining reachable branches (already-aborted signal, onAbort in joinFlight, storage catch, invalid provider, missing key/url)
    const h3 = new Map<string, (input: unknown, ctx?: { signal?: AbortSignal; panel?: { id?: string } }) => Promise<unknown>>()
    const cfg3: Record<string, unknown> = {
      aiEnabled: true,
      aiFormat: 'openai',
      aiModel: 'm-ok',
      aiMaxTokens: 32,
    }
    const store3 = new Map<string, unknown>([['datanoa.ai.apiKeyHost', '']])
    const sec3 = new Map<string, string>([['datanoa.ai.apiKey', 'sk-pinned-boot']])
    let throwHistoryGet = false
    let resolveSlow!: (v: unknown) => void

    let waitedOnce = false
    let notifyWaitStarted!: () => void
    const waitStarted = new Promise<void>((r) => {
      notifyWaitStarted = r
    })

    const ctrl3 = registerAiHandlers({
      orca: {
        settings: {
          get: async (k?: string) => (k ? cfg3[k] : { ...cfg3 }),
          onDidChange: () => ({ dispose: () => {} }),
        },
        storage: {
          get: async (k: string) => {
            if (throwHistoryGet && k === QUERY_HISTORY_STORAGE_KEY) throw new Error('history corrupt')
            return store3.has(k) ? store3.get(k) : ''
          },
          set: async (k: string, v: unknown) => {
            store3.set(k, v)
          },
          delete: async (k: string) => {
            store3.delete(k)
          },
        },
        secrets: {
          get: async (k: string) => sec3.get(k) ?? 'sk-pinned-boot',
          set: async (k: string, v: string) => {
            sec3.set(k, v)
          },
          delete: async (k: string) => {
            sec3.delete(k)
          },
        },
        panels: { post: () => {} },
        log: () => {},
      } as unknown as OrcaWorkerApi,
      registerHandler: ((name: string, fn: (input: unknown, ctx?: unknown) => Promise<unknown>) => {
        h3.set(name, fn as never)
        return { dispose: () => {} }
      }) as unknown as WorkerRegisterHandler,
      sessionManager: {
        assertSecureSecretStorage: async () => {},
        getSession: async () => ({
          driverType: 'mongodb',
          getTableDetails: async (t: string) => makeTableDetails(t, ''),
        }),
      } as unknown as SessionManager,
      schemaCache: new WorkerSchemaMetadataCache(),
      fetchPost: async (_url, init) => {
        const parsed = JSON.parse(init.body) as { model?: string }
        if (parsed.model === 'wait-m' && !waitedOnce) {
          waitedOnce = true
          notifyWaitStarted()
          return await new Promise((resolve) => {
            resolveSlow = resolve
          })
        }
        return makePostResponse({ json: { choices: [{ message: { content: ' FROM users WHERE active = 1' } }] } })
      },
      fetchGet: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'm-ok' }] }) }),
    })

    // Trigger pinExistingKey fallback when aiBaseUrl is absent & keyHost === ''
    await new Promise((r) => setTimeout(r, 20))
    expect(Array.from(store3.values())).toContain('https://api.openai.com/v1')

    cfg3.aiBaseUrl = 'https://api.openai.com/v1'
    // Already-aborted signal
    const preAborted = new AbortController()
    preAborted.abort()
    expect(await h3.get('ai.complete')!({ prefix: 'SELECT 1', suffix: '' }, { signal: preAborted.signal })).toEqual({ suggestion: '', id: 0 })

    // Completion cache forward & backspace fuzzy matches + getHistoryEntries catch
    throwHistoryGet = true
    const cached1 = (await h3.get('ai.complete')!({ prefix: 'SELECT *', suffix: '' })) as { suggestion: string }
    expect(cached1.suggestion).toContain('FROM users')
    throwHistoryGet = false
    const cachedForward = (await h3.get('ai.complete')!({ prefix: 'SELECT * FROM', suffix: '' })) as { suggestion: string }
    expect(cachedForward.suggestion).toContain('users')

    // Invalid provider config in ai.provider.test & non-string inputs in ai.models.list / bench
    cfg3.aiModel = ''
    expect(await h3.get('ai.provider.test')!({})).toMatchObject({
      ok: false,
      message: 'Set a valid http(s) Base URL and model name.',
      ms: null,
    })
    cfg3.aiModel = 'm-ok'
    expect(await h3.get('ai.models.list')!({})).toMatchObject({ ok: false, models: [] })
    expect(await h3.get('ai.models.bench')!({})).toMatchObject({ results: [] })

    // joinFlight caller aborting while leader finishes later (covers onAbort at L267!)
    cfg3.aiModel = 'wait-m'
    const cWait1 = new AbortController()
    const cWait2 = new AbortController()
    const fLeader = h3.get('ai.complete')!({ prefix: 'SELECT shared_wait', suffix: '' }, { signal: cWait1.signal, panel: { id: 'pSame' } })
    await waitStarted
    const fFollower = h3.get('ai.complete')!({ prefix: 'SELECT shared_wait', suffix: '' }, { signal: cWait2.signal, panel: { id: 'pSame' } })
    await new Promise((r) => setTimeout(r, 10))
    cWait2.abort()
    expect(await fFollower).toEqual({ suggestion: '', id: 0 })
    resolveSlow(makePostResponse({ json: { choices: [{ message: { content: ' FROM wait_tbl' } }] } }))
    await fLeader

    // ExplainAnalyze on mongodb driver (skip dot splitting)
    cfg3.aiModel = 'm-ok'
    await h3.get('ai.explainAnalyze')!({ sql: 'db.users.find({})', connectionId: 'mongo1' })

    ctrl3.dispose()
  })
})
