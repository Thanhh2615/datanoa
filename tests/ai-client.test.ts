import { afterEach, describe, expect, it, vi } from 'vitest'
import { openSharedAiConfigModal } from '../src/shared-ai-ui.js'
import {
  AI_COMPLETE_TIMEOUT_MS,
  AI_EXPLAIN_TIMEOUT_MS,
  AI_MAX_EXPLAIN_BODY_BYTES,
  AI_PRESETS,
  AiResponseTooLargeError,
  ProviderHttpError,
  ReasoningExhaustedError,
  buildChatRequest,
  buildCompletionRequest,
  bumpMetric,
  cleanSuggestion,
  completeChat,
  completeSql,
  completeSqlWithMeta,
  detectLeadingTokenReplacement,
  dropDuplicatedFromSuffix,
  emptyStats,
  explainFailure,
  extractChatText,
  extractCompletionText,
  extractModelIds,
  hasSensitiveContent,
  hostOf,
  isExpectedSqlBenchAnswer,
  isLoopbackHost,
  isProseExplanation,
  listModels,
  looksInjected,
  median,
  pickCandidates,
  presetFor,
  rankModels,
  recommendedModels,
  recordMetricLatency,
  removeRepetitiveBlocks,
  removeRepetitiveLines,
  resolveTrailingTypoToken,
  sameAddress,
  stripSpecialCompletionTokens,
  summarizeModelStats,
  trimMultiLineInSingleLineMode,
  trimPrefixEcho,
  trimSuffixOverlap,
} from '../src/worker/ai-client'

describe('ai-client presets & address matching', () => {
  it('resolves known and custom presets cleanly', () => {
    expect(AI_COMPLETE_TIMEOUT_MS).toBe(15_000)
    expect(AI_EXPLAIN_TIMEOUT_MS).toBe(60_000)
    expect(AI_PRESETS).toHaveLength(7)
    expect(sameAddress('https://api.openai.com/v1/', 'HTTPS://API.OPENAI.COM/v1')).toBe(true)
    expect(presetFor('ollama', 'http://localhost:11434/v1/').id).toBe('ollama')
    expect(presetFor('openai', 'https://my-gateway.internal/v1').id).toBe('custom-openai')
    expect(presetFor('anthropic', 'https://my-proxy.internal').id).toBe('custom-anthropic')
    expect(isLoopbackHost('localhost:11434')).toBe(true)
    expect(isLoopbackHost('localhost.example.com')).toBe(false)
    expect(hostOf('https://openrouter.ai/api/v1')).toBe('openrouter.ai')
  })
})

describe('ai-client request builders & extractors', () => {
  it('builds chat requests across all 4 formats without temperature on openai/anthropic', () => {
    const oa = buildChatRequest(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1/', model: 'gpt-4o-mini', apiKey: 'k1', maxTokens: 120 },
      'sys',
      'usr',
      120
    )
    expect(oa.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(oa.init.headers.authorization).toBe('Bearer k1')
    expect(JSON.parse(oa.init.body).temperature).toBeUndefined()

    const ant = buildChatRequest(
      { format: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku', apiKey: 'k2', maxTokens: 200 },
      'sys',
      'usr',
      200
    )
    expect(ant.url).toBe('https://api.anthropic.com/v1/messages')
    expect(ant.init.headers['x-api-key']).toBe('k2')
    expect(JSON.parse(ant.init.body).temperature).toBeUndefined()

    const oll = buildChatRequest(
      { format: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:3b', apiKey: '', maxTokens: 300 },
      'sys',
      'usr',
      300
    )
    expect(oll.url).toBe('http://localhost:11434/api/chat')
    expect(JSON.parse(oll.init.body).stream).toBe(false)
    expect(JSON.parse(oll.init.body).options.num_predict).toBe(300)

    const ollStream = buildChatRequest(
      { format: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:3b', apiKey: '', maxTokens: 300 },
      'sys',
      'usr',
      300,
      undefined,
      true
    )
    expect(JSON.parse(ollStream.init.body).stream).toBe(true)

    const mis = buildChatRequest(
      { format: 'mistral-fim', baseUrl: 'https://api.mistral.ai', model: 'codestral-latest', apiKey: 'k3', maxTokens: 400 },
      'sys',
      'usr',
      400
    )
    expect(mis.url).toBe('https://api.mistral.ai/v1/chat/completions')
  })

  it('builds FIM completion requests for ollama and mistral-fim with temperature 0.2', () => {
    const oll = buildCompletionRequest(
      { format: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:1.5b', apiKey: '', maxTokens: 96 },
      { system: 's', user: 'u', prefix: 'SELECT ', suffix: ' FROM users', fimPrefix: '/* schema */\nSELECT ' }
    )
    expect(oll.url).toBe('http://localhost:11434/api/generate')
    const ollBody = JSON.parse(oll.init.body)
    expect(ollBody.prompt).toBe('/* schema */\nSELECT ')
    expect(ollBody.suffix).toBe(' FROM users')
    expect(ollBody.options.temperature).toBe(0.2)

    const mis = buildCompletionRequest(
      { format: 'mistral-fim', baseUrl: 'https://api.mistral.ai/v1', model: 'codestral-latest', apiKey: 'm1', maxTokens: 96 },
      { system: 's', user: 'u', prefix: 'SELECT ', suffix: ' FROM users' }
    )
    expect(mis.url).toBe('https://api.mistral.ai/v1/fim/completions')
    expect(JSON.parse(mis.init.body).temperature).toBe(0.2)
  })

  it('threads stop sequences through all four completion formats', () => {
    const req = { system: 's', user: 'u', prefix: 'SELECT ', suffix: '' }
    const stop = ['\n', ';']

    const oa = buildCompletionRequest(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
      req,
      undefined,
      false,
      stop
    )
    expect(JSON.parse(oa.init.body).stop).toEqual(stop)

    const mis = buildCompletionRequest(
      { format: 'mistral-fim', baseUrl: 'https://api.mistral.ai/v1', model: 'codestral-latest', apiKey: 'k', maxTokens: 64 },
      req,
      undefined,
      false,
      stop
    )
    expect(JSON.parse(mis.init.body).stop).toEqual(stop)

    const ant = buildCompletionRequest(
      { format: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku', apiKey: 'k', maxTokens: 64 },
      req,
      undefined,
      false,
      stop
    )
    const antBody = JSON.parse(ant.init.body)
    expect(antBody.stop_sequences).toEqual(stop)
    expect(antBody.stop).toBeUndefined()

    const oll = buildCompletionRequest(
      { format: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:1.5b', apiKey: '', maxTokens: 64 },
      req,
      undefined,
      false,
      stop
    )
    expect(JSON.parse(oll.init.body).options.stop).toEqual(stop)
  })

  it('extracts completion and chat text cleanly', () => {
    expect(extractCompletionText('openai', { choices: [{ message: { content: 'id FROM users' } }] })).toBe('id FROM users')
    expect(extractCompletionText('anthropic', { content: [{ type: 'text', text: 'id' }, { type: 'text', text: ', name' }] })).toBe('id, name')
    expect(extractCompletionText('ollama', { response: 'WHERE active = 1' })).toBe('WHERE active = 1')
    expect(extractChatText('ollama', { message: { content: '{"summary":"ok"}' } })).toBe('{"summary":"ok"}')
  })
})

describe('ai-client secret guard, sanitization & completion pipeline', () => {
  it('blocks API keys, JWTs, URL passwords, and SQL account auth literals, while allowing placeholders', () => {
    expect(hasSensitiveContent('const k = "sk-proj-abcdefghijklmnopqrstuvwxyz123"', '')).not.toBeNull()
    expect(hasSensitiveContent('SELECT * FROM cfg WHERE url = "postgres://admin:supersecret@db.internal/app"', '')).not.toBeNull()
    expect(hasSensitiveContent("CREATE USER alice IDENTIFIED BY 'myRealPassword123!';", '', '', 'mysql')).not.toBeNull()
    expect(hasSensitiveContent('const apiKey = "your_api_key"', '')).toBeNull()
    expect(hasSensitiveContent('SELECT id, email FROM users WHERE active = true;', '')).toBeNull()
  })

  it('cleans fences, prefix echo, suffix overlap, and drops injected tool markup', async () => {
    expect(looksInjected('<tool_call>run</tool_call>')).toBe(true)
    expect(cleanSuggestion('```sql\nWHERE id = 1\n```')).toBe('WHERE id = 1')
    expect(trimPrefixEcho('FROM users WHERE id = 1', 'SELECT *\nFROM users')).toBe(' WHERE id = 1')
    expect(trimPrefixEcho('SELECT * FROM users WHERE id = 1', 'SELECT * FROM users')).toBe(' WHERE id = 1')
    expect(trimSuffixOverlap('u.id = o.user_id\nORDER BY u.id', '\nORDER BY u.id')).toBe('u.id = o.user_id')

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '```sql\nu.id, u.email\n```' } }] }),
      text: async () => '',
    })
    const out = await completeSql(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
      { dialect: 'postgres', system: 'sys', user: 'usr', prefix: 'SELECT ', suffix: ' FROM users u' },
      new AbortController().signal,
      mockFetch
    )
    expect(out).toBe('u.id, u.email')

    const blocked = await completeSql(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
      { dialect: 'postgres', system: 'sys', user: 'usr', prefix: "ALTER USER bob PASSWORD 'RealPass987654!'; SELECT ", suffix: '' },
      new AbortController().signal,
      () => {
        throw new Error('fetch should not be called on secret content')
      }
    )
    expect(blocked).toBe('')
  })

  it('blocks secret content in completeChat as well', async () => {
    await expect(
      completeChat(
        { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
        'sys',
        'SELECT * FROM t WHERE tok = "ghp_123456789012345678901234567890123456"',
        64,
        new AbortController().signal,
        () => {
          throw new Error('must not fetch')
        }
      )
    ).rejects.toThrow(/sensitive/i)
  })

  it('streams completeChat across OpenAI SSE, Anthropic SSE, Ollama NDJSON, and text/plain SSE fallback without SQL early-stop', async () => {
    const enc = new TextEncoder()
    const makeStream = (chunks: string[]) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(enc.encode(chunk))
          controller.close()
        },
      })

    // 1. OpenAI SSE: sends stream:true + reasoning_effort:'low', reads full multiline JSON containing ';' and '\n\n'
    const oaBodies: Array<Record<string, unknown>> = []
    const fullJson = '{\n  "fixedSql": "SELECT * FROM banners LIMIT 100;",\n\n  "explanation": "Done."\n}'
    const oaOut = await completeChat(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 1024 },
      'sys',
      'usr',
      1024,
      new AbortController().signal,
      async (_u, init) => {
        oaBodies.push(JSON.parse(init.body) as Record<string, unknown>)
        return {
          ok: true,
          status: 200,
          headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null) },
          body: makeStream([
            `data: ${JSON.stringify({ choices: [{ delta: { content: fullJson.slice(0, 45) } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: fullJson.slice(45) } }] })}\n\n`,
            'data: [DONE]\n\n',
          ]),
          json: async () => {
            throw new Error('must read SSE stream, not json()')
          },
          text: async () => '',
        }
      }
    )
    expect(oaBodies[0].stream).toBe(true)
    expect(oaBodies[0].reasoning_effort).toBe('low')
    expect(oaOut).toBe(fullJson)

    // 2. Anthropic SSE streaming
    const antOut = await completeChat(
      { format: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5', apiKey: 'k', maxTokens: 512 },
      'sys',
      'usr',
      512,
      new AbortController().signal,
      async (_u, init) => {
        const body = JSON.parse(init.body) as Record<string, unknown>
        expect(body.stream).toBe(true)
        expect(body.reasoning_effort).toBeUndefined()
        return {
          ok: true,
          status: 200,
          headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
          body: makeStream([
            'event: content_block_delta\n',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"summary\\":\\"ok;"}}\n\n',
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"\\n\\ndone\\"}"}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ]),
          json: async () => ({}),
          text: async () => '',
        }
      }
    )
    expect(antOut).toBe('{"summary":"ok;\n\ndone"}')

    // 3. Ollama NDJSON streaming
    const ollOut = await completeChat(
      { format: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b', apiKey: '', maxTokens: 512 },
      'sys',
      'usr',
      512,
      new AbortController().signal,
      async (_u, init) => {
        const body = JSON.parse(init.body) as Record<string, unknown>
        expect(body.stream).toBe(true)
        return {
          ok: true,
          status: 200,
          headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/x-ndjson' : null) },
          body: makeStream([
            '{"message":{"role":"assistant","content":"{\\"fixedSql\\":\\"SELECT 1;\\""},"done":false}\n',
            '{"message":{"role":"assistant","content":"}"},"done":true}\n',
          ]),
          json: async () => ({}),
          text: async () => '',
        }
      }
    )
    expect(ollOut).toBe('{"fixedSql":"SELECT 1;"}')

    // 4. Proxy returning SSE text without text/event-stream header still parses via fallback
    const plainSseOut = await completeChat(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 512 },
      'sys',
      'usr',
      512,
      new AbortController().signal,
      async () => ({
        ok: true,
        status: 200,
        headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/plain' : null) },
        body: makeStream([
          'data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n',
          'data: [DONE]\n',
        ]),
        json: async () => ({}),
        text: async () => '',
      })
    )
    expect(plainSseOut).toBe('{"ok":true}')

    // 5. Enforces AI_MAX_EXPLAIN_BODY_BYTES limit on both content-length header and streaming chunks
    await expect(
      completeChat(
        { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 512 },
        'sys',
        'usr',
        512,
        new AbortController().signal,
        async () => ({
          ok: true,
          status: 200,
          headers: {
            get: (n: string) =>
              n.toLowerCase() === 'content-length' ? String(AI_MAX_EXPLAIN_BODY_BYTES + 1) : 'text/event-stream',
          },
          body: makeStream(['data: [DONE]\n']),
          json: async () => ({}),
          text: async () => '',
        })
      )
    ).rejects.toBeInstanceOf(AiResponseTooLargeError)

    const bigChunk = 'x'.repeat(Math.floor(AI_MAX_EXPLAIN_BODY_BYTES / 2) + 1024)
    await expect(
      completeChat(
        { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 512 },
        'sys',
        'usr',
        512,
        new AbortController().signal,
        async () => ({
          ok: true,
          status: 200,
          headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
          body: makeStream([bigChunk, bigChunk]),
          json: async () => ({}),
          text: async () => '',
        })
      )
    ).rejects.toBeInstanceOf(AiResponseTooLargeError)

    // 6. Standard application/json response body stream also extracts chat JSON cleanly
    const jsonStreamOut = await completeChat(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 512 },
      'sys',
      'usr',
      512,
      new AbortController().signal,
      async () => ({
        ok: true,
        status: 200,
        headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) },
        body: makeStream([JSON.stringify({ choices: [{ message: { content: '{"summary":"json-body"}' } }] })]),
        json: async () => ({}),
        text: async () => '',
      })
    )
    expect(jsonStreamOut).toBe('{"summary":"json-body"}')
  })

  it('falls back on 400/422 for reasoning_effort & stream and retries once on transient 502/503/504 (abort-aware)', async () => {
    vi.useFakeTimers()
    try {
      // 1. 400 rejecting reasoning_effort keeps stream: true; 422 rejecting stream falls back to stream: false
      const bodies: Array<Record<string, unknown>> = []
      const fallbackOut = await completeChat(
        { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 512 },
        'sys',
        'usr',
        512,
        new AbortController().signal,
        async (_u, init) => {
          const body = JSON.parse(init.body) as Record<string, unknown>
          bodies.push(body)
          if (body.reasoning_effort !== undefined) {
            return { ok: false, status: 400, json: async () => ({}), text: async () => '' }
          }
          if (body.stream === true) {
            return { ok: false, status: 422, json: async () => ({}), text: async () => '' }
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content: '{"ok":1}' } }] }),
            text: async () => '',
          }
        }
      )
      expect(fallbackOut).toBe('{"ok":1}')
      expect(bodies).toHaveLength(3)
      expect(bodies[0]).toMatchObject({ reasoning_effort: 'low', stream: true })
      expect(bodies[1].reasoning_effort).toBeUndefined()
      expect(bodies[1].stream).toBe(true)
      expect(bodies[2].reasoning_effort).toBeUndefined()
      expect(bodies[2].stream).toBeUndefined()

      // 2. Single transient 502/504 retries once after 750ms and succeeds
      for (const status of [502, 504]) {
        let attempts = 0
        const retryPromise = completeChat(
          { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 512 },
          'sys',
          'usr',
          512,
          new AbortController().signal,
          async () => {
            attempts += 1
            if (attempts === 1) {
              return { ok: false, status, json: async () => ({}), text: async () => '' }
            }
            return {
              ok: true,
              status: 200,
              json: async () => ({ choices: [{ message: { content: '{"recovered":true}' } }] }),
              text: async () => '',
            }
          }
        )
        await vi.advanceTimersByTimeAsync(1_000)
        expect(await retryPromise).toBe('{"recovered":true}')
        expect(attempts).toBe(2)
      }

      // 3. Persistent 504 retries at most once (2 total attempts) then throws ProviderHttpError(504)
      let failAttempts = 0
      const failPromise = completeChat(
        { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 512 },
        'sys',
        'usr',
        512,
        new AbortController().signal,
        async () => {
          failAttempts += 1
          return { ok: false, status: 504, json: async () => ({}), text: async () => '' }
        }
      )
      const caughtFail = failPromise.catch((err) => err)
      await vi.advanceTimersByTimeAsync(2_000)
      const failErr = await caughtFail
      expect(failErr).toBeInstanceOf(ProviderHttpError)
      expect((failErr as ProviderHttpError).status).toBe(504)
      expect(failAttempts).toBe(2)

      // 4. Aborting during 502/503/504 backoff rejects immediately without issuing 2nd fetch
      const ac = new AbortController()
      let abortAttempts = 0
      const abortPromise = completeChat(
        { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 512 },
        'sys',
        'usr',
        512,
        ac.signal,
        async () => {
          abortAttempts += 1
          return { ok: false, status: 503, json: async () => ({}), text: async () => '' }
        }
      )
      const caughtAbort = abortPromise.catch((err) => err)
      await Promise.resolve()
      await Promise.resolve()
      ac.abort(new Error('cancelled-by-user'))
      const abortErr = await caughtAbort
      expect(abortErr).toBeInstanceOf(Error)
      expect(abortAttempts).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('strips think blocks, handles array content parts, and retries reasoning exhaustion adaptively', async () => {
    expect(cleanSuggestion('<think>plan</think>\n```sql\nWHERE a.active = 1;')).toBe('WHERE a.active = 1;')
    expect(
      extractCompletionText('openai', {
        choices: [{ message: { content: [{ type: 'text', text: 'WHERE ' }, { type: 'text', text: 'a.id = 1;' }] } }],
      })
    ).toBe('WHERE a.id = 1;')

    const bodies: Array<Record<string, unknown>> = []
    let detected = 0
    let effortRejected = 0
    const res = await completeSql(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'coder', apiKey: 'k', maxTokens: 90 },
      { dialect: 'sqlite', system: 'sys', user: 'usr', prefix: 'select * from account a ', suffix: '' },
      new AbortController().signal,
      async (_u, init) => {
        const body = JSON.parse(init.body) as Record<string, unknown>
        bodies.push(body)
        if (bodies.length === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'thinking...' } }] }),
            text: async () => '',
          }
        }
        if (bodies.length === 2 && body.reasoning_effort === 'none') {
          return { ok: false, status: 400, json: async () => ({}), text: async () => '' }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'WHERE a.status = "active";' } }] }),
          text: async () => '',
        }
      },
      {
        onReasoningDetected: () => { detected += 1 },
        onEffortRejected: () => { effortRejected += 1 },
      }
    )
    expect(res).toBe('WHERE a.status = "active";')
    expect(detected).toBe(1)
    expect(effortRejected).toBe(1)
    expect(bodies[1].reasoning_effort).toBe('none')
    expect(Number(bodies[1].max_tokens)).toBeGreaterThanOrEqual(512)
    expect(bodies[2].reasoning_effort).toBeUndefined()
    expect(Number(bodies[2].max_tokens)).toBeGreaterThanOrEqual(512)

    await expect(
      completeSql(
        { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'coder', apiKey: 'k', maxTokens: 90 },
        { dialect: 'sqlite', system: 'sys', user: 'usr', prefix: 'select * from account a ', suffix: '' },
        new AbortController().signal,
        async () => ({
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'still thinking' } }] }),
          text: async () => '',
        }),
        { reasoning: true, skipEffort: true }
      )
    ).rejects.toBeInstanceOf(ReasoningExhaustedError)
  })

  it('does not re-send reasoning_effort on bumped retry after 400/422 rejection and sets adaptiveOpts.skipEffort', async () => {
    for (const status of [400, 422]) {
      const bodies: Array<Record<string, unknown>> = []
      let unsupported = false
      const adaptiveOpts = {
        skipEffort: false,
        isEffortUnsupported: () => unsupported,
        markEffortUnsupported: () => {
          unsupported = true
        },
      }
      const res = await completeSql(
        { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'coder', apiKey: 'k', maxTokens: 90 },
        { dialect: 'sqlite', system: 'sys', user: 'usr', prefix: 'select * from account a ', suffix: '' },
        new AbortController().signal,
        async (_u, init) => {
          const body = JSON.parse(init.body) as Record<string, unknown>
          bodies.push(body)
          if (body.reasoning_effort !== undefined) {
            return { ok: false, status, json: async () => ({}), text: async () => '' }
          }
          if (bodies.length === 2) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'thinking...' } }] }),
              text: async () => '',
            }
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'WHERE a.active = 1;' } }] }),
            text: async () => '',
          }
        },
        adaptiveOpts
      )
      expect(res).toBe('WHERE a.active = 1;')
      expect(bodies).toHaveLength(3)
      expect(bodies[0].reasoning_effort).toBe('none')
      expect(bodies[1].reasoning_effort).toBeUndefined()
      expect(bodies[2].reasoning_effort).toBeUndefined()
      expect(Number(bodies[2].max_tokens)).toBeGreaterThanOrEqual(512)
      expect(adaptiveOpts.skipEffort).toBe(true)
    }

    // Also respects skipEffort: true on initial attempt even when reasoning is false
    const skipBodies: Array<Record<string, unknown>> = []
    await completeSql(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'coder', apiKey: 'k', maxTokens: 90 },
      { dialect: 'sqlite', system: 'sys', user: 'usr', prefix: 'SELECT ', suffix: '' },
      new AbortController().signal,
      async (_u, init) => {
        skipBodies.push(JSON.parse(init.body) as Record<string, unknown>)
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: '1;' } }] }),
          text: async () => '',
        }
      },
      { skipEffort: true }
    )
    expect(skipBodies).toHaveLength(1)
    expect(skipBodies[0].reasoning_effort).toBeUndefined()
  })
})

describe('ai-client completion post-processing helpers', () => {
  it('strips special completion tokens and think blocks', () => {
    expect(stripSpecialCompletionTokens('<|fim_prefix|>SELECT <|fim_suffix|><|endoftext|>')).toBe('SELECT ')
    expect(stripSpecialCompletionTokens('<|fim_middle|><|fim_pad|><|EOT|><|file_separator|>')).toBe('')
    expect(stripSpecialCompletionTokens('<COMPLETION>WHERE x = 1[/CODE]')).toBe('WHERE x = 1')
    expect(stripSpecialCompletionTokens('[CODE]SELECT 1[/CODE]')).toBe('SELECT 1')
    expect(stripSpecialCompletionTokens('SELECT * FROM t <CURSOR></CURSOR>')).toBe('SELECT * FROM t ')
    expect(stripSpecialCompletionTokens('SELECT 1 <|im_end|><|eot_id|><|end|><|cursor|>')).toBe('SELECT 1 ')
    expect(stripSpecialCompletionTokens('SELECT 1 <｜end▁of▁sentence｜>')).toBe('SELECT 1 ')
    expect(stripSpecialCompletionTokens('SELECT 1 <|im_en')).toBe('SELECT 1 ')
    expect(stripSpecialCompletionTokens('SELECT 1 <|')).toBe('SELECT 1 ')
    expect(stripSpecialCompletionTokens('a<think>plan</think>b')).toBe('ab')
  })

  it('strips trailing snippet-caret pipe | and special markers while preserving || concat, bitwise |, quotes, and redis', async () => {
    const runComplete = async (
      prefix: string,
      content: string,
      dialect: 'postgres' | 'sqlite' | 'redis' = 'postgres'
    ) =>
      await completeSql(
        { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
        { dialect, system: 's', user: 'u', prefix, suffix: '' },
        new AbortController().signal,
        async () => ({
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content } }] }),
          text: async () => '',
        })
      )

    expect(cleanSuggestion('SELECT |')).toBe('SELECT')
    expect(cleanSuggestion('SELECT  |')).toBe('SELECT')
    expect(cleanSuggestion(' * FROM banners |')).toBe(' * FROM banners')
    expect(cleanSuggestion('SELECT * FROM t <CURSOR>')).toBe('SELECT * FROM t')
    expect(cleanSuggestion('SELECT 1 <|im_end|>')).toBe('SELECT 1')
    expect(cleanSuggestion('a || b')).toBe('a || b')

    expect(await runComplete('', 'SELECT |')).toBe('SELECT')
    expect(await runComplete('', 'SELECT  |')).toBe('SELECT')
    expect(await runComplete('SELECT ', 'SELECT  |')).toBe('')
    expect(await runComplete('SELECT ', ' |')).toBe('')
    expect(await runComplete('SELECT', ' * FROM banners |')).toBe(' * FROM banners')
    expect(await runComplete('', 'SELECT * FROM t <CURSOR>')).toBe('SELECT * FROM t')
    expect(await runComplete('', 'SELECT 1 <|im_end|>')).toBe('SELECT 1')
    expect(await runComplete('SELECT ', 'a || b')).toBe('a || b')
    expect(await runComplete('SELECT ', 'a ||')).toBe('a ||')
    expect(await runComplete('SELECT ', 'flags | 1')).toBe('flags | 1')
    expect(await runComplete("SELECT 'hello ", "|")).toBe('|')
    expect(await runComplete('SET k ', 'val|', 'redis')).toBe('val|')
  })

  it('flags conversational prose but keeps valid SQL and Redis completions', () => {
    expect(
      isProseExplanation('depends what filter. Guess deletedAt not null? Provide cursor intent — e.g.:')
    ).toBe(true)
    expect(isProseExplanation('Sure, here is the query you can use:')).toBe(true)
    expect(isProseExplanation('Please clarify which table to use.')).toBe(true)
    expect(isProseExplanation('note: this query is slow')).toBe(true)
    expect(isProseExplanation('This picks rows. It helps speed?')).toBe(true)

    expect(isProseExplanation('a.deletedAt IS NULL')).toBe(false)
    expect(isProseExplanation("= 'active'")).toBe(false)
    expect(isProseExplanation('o.account_id = a.id')).toBe(false)
    expect(isProseExplanation('createdAt DESC')).toBe(false)
    expect(isProseExplanation("SET EX 60 'ok'")).toBe(false)
    expect(isProseExplanation('WHERE id = ?')).toBe(false)
    expect(isProseExplanation("SELECT 'depends on input'")).toBe(false)
  })

  it('rejects conversational prose containing SQL keywords while keeping valid SQL, Redis, and Mongo completions', () => {
    expect(isProseExplanation('It looks like you want to filter users by active status.')).toBe(true)
    expect(isProseExplanation('You can filter users by status in the where clause and order by name.')).toBe(true)
    expect(isProseExplanation('To group orders by user from the table, set a condition on status.')).toBe(true)
    expect(isProseExplanation('It looks like you want to filter users by active')).toBe(true)
    expect(isProseExplanation('The query selects rows from users where active is not null.')).toBe(true)
    expect(isProseExplanation('Filter the users in the table by active status.')).toBe(true)

    expect(isProseExplanation('WHERE active = 1')).toBe(false)
    expect(isProseExplanation("LIKE '%foo%'")).toBe(false)
    expect(isProseExplanation('ORDER BY created_at DESC')).toBe(false)
    expect(isProseExplanation('GROUP BY user_id HAVING COUNT(*) > 1')).toBe(false)
    expect(isProseExplanation("WHERE looks LIKE '%foo%'")).toBe(false)
    expect(isProseExplanation('JOIN based ON based.id = u.id')).toBe(false)
    expect(isProseExplanation('SET updated_at = NOW()')).toBe(false)
    expect(isProseExplanation('db.users.find({ note: "ok", active: true }).sort({ createdAt: -1 }).limit(10)')).toBe(false)
    expect(isProseExplanation('WHERE data ? \'key\' AND a!=1')).toBe(false)
  })

  it('truncates repetitive trailing lines and blocks', () => {
    expect(removeRepetitiveLines('SELECT 1;\n'.repeat(6))).toBe('SELECT 1;')
    expect(removeRepetitiveLines('SELECT a;\nSELECT b;')).toBe('SELECT a;\nSELECT b;')
    expect(removeRepetitiveBlocks('SELECT 1;\n\nSELECT 1;\n\nSELECT 1;\n\n')).toBe('SELECT 1;')
    expect(removeRepetitiveBlocks('SELECT a;\n\nSELECT b;')).toBe('SELECT a;\n\nSELECT b;')
  })

  it('collapses repetitive blocks without trailing separator and preserves \\n\\n between earlier blocks', () => {
    expect(removeRepetitiveBlocks('SELECT 1;\n\nSELECT 1;\n\nSELECT 1;')).toBe('SELECT 1;')
    expect(removeRepetitiveBlocks('SELECT 0;\n\nSELECT 1;\n\nSELECT 1;\n\nSELECT 1;')).toBe('SELECT 0;\n\nSELECT 1;')
    expect(removeRepetitiveBlocks('SELECT 0;\n\nSELECT 1;\n\nSELECT 2;\n\nSELECT 2;\n\nSELECT 2;\n\n')).toBe(
      'SELECT 0;\n\nSELECT 1;\n\nSELECT 2;'
    )
    expect(removeRepetitiveBlocks('SELECT 1;\n\nSELECT 1;')).toBe('SELECT 1;\n\nSELECT 1;')
  })

  it('collapses >=3 repetitive lines without trailing newline and multi-line cycles while keeping distinct lines', async () => {
    expect(removeRepetitiveLines('AND a = 1\nAND a = 1\nAND a = 1')).toBe('AND a = 1')
    expect(removeRepetitiveLines('SELECT 1;\n'.repeat(6).trimEnd())).toBe('SELECT 1;')
    expect(removeRepetitiveLines('WHERE x = 1\nAND a = 1\nAND a = 1\nAND a = 1')).toBe('WHERE x = 1\nAND a = 1')
    expect(
      removeRepetitiveLines('WHERE x = 1\nAND a = 1\nAND b = 2\nAND a = 1\nAND b = 2\nAND a = 1\nAND b = 2')
    ).toBe('WHERE x = 1\nAND a = 1\nAND b = 2')
    expect(removeRepetitiveLines('END;\nEND;')).toBe('END;\nEND;')
    expect(removeRepetitiveLines('AND user_id = 1\nAND user_id = 2\nAND user_id = 3')).toBe(
      'AND user_id = 1\nAND user_id = 2\nAND user_id = 3'
    )

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        for (const chunk of [
          'data: {"choices":[{"delta":{"content":"AND a = 1\\n"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"AND a = 1\\n"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"AND a = 1\\n"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"AND a = 1\\n"}}]}\n\n',
        ]) {
          controller.enqueue(enc.encode(chunk))
        }
        controller.close()
      },
    })
    const out = await completeSql(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
      { dialect: 'sqlite', system: 's', user: 'u', prefix: 'SELECT * FROM t WHERE x = 0 ', suffix: '' },
      new AbortController().signal,
      async () => ({
        ok: true,
        status: 200,
        body,
        headers: { get: () => 'text/event-stream' },
        json: async () => ({}),
        text: async () => '',
      })
    )
    expect(out).toBe('AND a = 1')
  })

  it('drops completions duplicated with the suffix and trims suffix run-in', () => {
    expect(dropDuplicatedFromSuffix('u.id = o.user_id\n', 'u.id = o.user_id\nORDER BY u.id')).toBe('')
    expect(dropDuplicatedFromSuffix('u.id, u.email', ' FROM users u')).toBe('u.id, u.email')
    expect(dropDuplicatedFromSuffix('WHERE a = 1\nORDER BY x', 'ORDER BY x\nLIMIT 1')).toBe('WHERE a = 1')
  })

  it('trims multiline output to a single line in single-line mode', () => {
    expect(trimMultiLineInSingleLineMode('WHERE a = 1\nAND b = 2', '', false)).toBe('WHERE a = 1')
    expect(trimMultiLineInSingleLineMode('WHERE a = 1\nAND b = 2', '1', false)).toBe('WHERE a = ')
    expect(trimMultiLineInSingleLineMode('WHERE a = 1\nAND b = 2', '', true)).toBe('WHERE a = 1\nAND b = 2')
  })

  it('drops prose explanations from completeSql output while keeping valid SQL', async () => {
    const prose = await completeSql(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
      { dialect: 'sqlite', system: 's', user: 'u', prefix: 'SELECT * FROM account a WHERE ', suffix: '' },
      new AbortController().signal,
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'depends what filter. Guess deletedAt not null? Provide cursor intent — e.g.:',
              },
            },
          ],
        }),
        text: async () => '',
      })
    )
    expect(prose).toBe('')

    const prose2 = await completeSql(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
      { dialect: 'sqlite', system: 's', user: 'u', prefix: 'SELECT * FROM account a WHERE ', suffix: '' },
      new AbortController().signal,
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'It looks like you want to filter users by active status.' } }],
        }),
        text: async () => '',
      })
    )
    expect(prose2).toBe('')

    const sql = await completeSql(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
      { dialect: 'sqlite', system: 's', user: 'u', prefix: 'SELECT * FROM account a WHERE ', suffix: '' },
      new AbortController().signal,
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'a.deletedAt IS NULL' } }] }),
        text: async () => '',
      })
    )
    expect(sql).toBe('a.deletedAt IS NULL')
  })

  it('falls back cleanly when a non-OpenAI provider rejects stop', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const out = await completeSql(
      { format: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku', apiKey: 'k', maxTokens: 64 },
      { dialect: 'postgres', system: 's', user: 'u', prefix: 'SELECT ', suffix: '' },
      new AbortController().signal,
      async (_u, init) => {
        const body = JSON.parse(init.body) as Record<string, unknown>
        bodies.push(body)
        if (bodies.length === 1) {
          return { ok: false, status: 400, json: async () => ({}), text: async () => '' }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: 'text', text: 'id FROM t;' }] }),
          text: async () => '',
        }
      }
    )
    expect(out).toBe('id FROM t;')
    expect(bodies).toHaveLength(2)
    expect(bodies[0].stop_sequences).toEqual(['\n\n', '```'])
    expect(bodies[1].stop_sequences).toBeUndefined()
  })

  it('sends stream, proactive effort, stop and capped tokens for inline requests', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const out = await completeSql(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'coder', apiKey: 'k', maxTokens: 200 },
      { dialect: 'sqlite', system: 's', user: 'u', prefix: 'select * from account ', suffix: ';', multiline: false },
      new AbortController().signal,
      async (_u, init) => {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>)
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'WHERE id = 1;' } }] }),
          text: async () => '',
        }
      }
    )
    expect(out).toBe('WHERE id = 1;')
    expect(bodies[0].stream).toBe(true)
    expect(bodies[0].reasoning_effort).toBe('none')
    expect(bodies[0].stop).toEqual(['\n', ';', '```'])
    expect(Number(bodies[0].max_tokens)).toBe(48)
  })

  it('skips proactive effort when marked unsupported', async () => {
    const bodies: Array<Record<string, unknown>> = []
    await completeSql(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'coder', apiKey: 'k', maxTokens: 64 },
      { dialect: 'sqlite', system: 's', user: 'u', prefix: 'select 1', suffix: '' },
      new AbortController().signal,
      async (_u, init) => {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>)
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: ' WHERE 1' } }] }),
          text: async () => '',
        }
      },
      { isEffortUnsupported: () => true }
    )
    expect(bodies[0].reasoning_effort).toBeUndefined()
    expect(bodies[0].stop).toEqual(['\n\n', '```'])
  })

  it('streams SSE deltas and stops early at a statement boundary', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"WHERE "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"a.status = "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"\\\"active\\\";"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" trailing garbage"}}]}\n\n',
    ]
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        for (const chunk of chunks) controller.enqueue(enc.encode(chunk))
        controller.close()
      },
    })
    let requestedStream = false
    const out = await completeSql(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
      { dialect: 'sqlite', system: 's', user: 'u', prefix: 'select * from account a ', suffix: '' },
      new AbortController().signal,
      async (_u, init) => {
        requestedStream = JSON.parse(init.body).stream === true
        return {
          ok: true,
          status: 200,
          body,
          headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
          json: async () => {
            throw new Error('should not parse stream as json')
          },
          text: async () => '',
        }
      }
    )
    expect(requestedStream).toBe(true)
    expect(out).toBe('WHERE a.status = "active";')
  })

  it('aborts per-attempt fetch signal on early stream stops (; , \\n\\n, single-line \\n, 3-line loop) without aborting caller signal', async () => {
    const runEarlyStopCase = async (chunks: string[], multiline: boolean) => {
      const caller = new AbortController()
      let fetchSignal: AbortSignal | undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder()
          for (const c of chunks) controller.enqueue(enc.encode(c))
          controller.close()
        },
      })
      const out = await completeSql(
        { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
        { dialect: 'sqlite', system: 's', user: 'u', prefix: 'SELECT * FROM users ', suffix: '', multiline },
        caller.signal,
        async (_u, init) => {
          fetchSignal = init.signal
          return {
            ok: true,
            status: 200,
            body,
            headers: { get: () => 'text/event-stream' },
            json: async () => ({}),
            text: async () => '',
          }
        }
      )
      return { out, fetchAborted: fetchSignal?.aborted, callerAborted: caller.signal.aborted }
    }

    const semi = await runEarlyStopCase(
      ['data: {"choices":[{"delta":{"content":"WHERE id = 1;"}}]}\n\n', 'data: {"choices":[{"delta":{"content":" extra"}}]}\n\n'],
      true
    )
    expect(semi).toEqual({ out: 'WHERE id = 1;', fetchAborted: true, callerAborted: false })

    const dblNl = await runEarlyStopCase(
      ['data: {"choices":[{"delta":{"content":"WHERE id = 1\\n\\n"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"SELECT 2"}}]}\n\n'],
      true
    )
    expect(dblNl).toEqual({ out: 'WHERE id = 1', fetchAborted: true, callerAborted: false })

    const dblNlSameChunk = await runEarlyStopCase(
      [
        'data: {"choices":[{"delta":{"content":"FROM orders\\n"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"WHERE total > 0\\n\\nSELECT extra"}}]}\n\n',
      ],
      true
    )
    expect(dblNlSameChunk).toEqual({
      out: 'FROM orders\nWHERE total > 0',
      fetchAborted: true,
      callerAborted: false,
    })

    // Non-SSE stream fallback text also truncates at \n\n in multiline mode
    const fallbackBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"WHERE total > 0\\n\\nSELECT extra"}}]}\n'
          )
        )
        controller.close()
      },
    })
    const fallbackOut = await completeSql(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
      { dialect: 'sqlite', system: 's', user: 'u', prefix: 'SELECT * FROM orders ', suffix: '' },
      new AbortController().signal,
      async () => ({
        ok: true,
        status: 200,
        body: fallbackBody,
        headers: { get: () => 'text/plain' },
        json: async () => ({}),
        text: async () => '',
      })
    )
    expect(fallbackOut).toBe('WHERE total > 0')

    const singleNl = await runEarlyStopCase(
      ['data: {"choices":[{"delta":{"content":"WHERE id = 1\\nAND x = 2"}}]}\n\n'],
      false
    )
    expect(singleNl).toEqual({ out: 'WHERE id = 1', fetchAborted: true, callerAborted: false })

    const loop3 = await runEarlyStopCase(
      [
        'data: {"choices":[{"delta":{"content":"AND a = 1\\n"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"AND a = 1\\n"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"AND a = 1\\n"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"AND a = 1\\n"}}]}\n\n',
      ],
      true
    )
    expect(loop3).toEqual({ out: 'AND a = 1', fetchAborted: true, callerAborted: false })

    // Caller abort propagates to per-attempt fetch signal; 400 retry gets fresh un-aborted signal
    const seenSignals: AbortSignal[] = []
    const retryOut = await completeSql(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
      { dialect: 'sqlite', system: 's', user: 'u', prefix: 'SELECT ', suffix: '' },
      new AbortController().signal,
      async (_u, init) => {
        if (init.signal) seenSignals.push(init.signal)
        if (seenSignals.length === 1) {
          return { ok: false, status: 400, json: async () => ({}), text: async () => '' }
        }
        expect(init.signal?.aborted).toBe(false)
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"1;"}}]}\n\n'))
            controller.close()
          },
        })
        return {
          ok: true,
          status: 200,
          body: stream,
          headers: { get: () => 'text/event-stream' },
          json: async () => ({}),
          text: async () => '',
        }
      }
    )
    expect(retryOut).toBe('1;')
    expect(seenSignals).toHaveLength(2)
    expect(seenSignals[0]).not.toBe(seenSignals[1])
    expect(seenSignals[1].aborted).toBe(true)

    // Caller abort cancels per-attempt fetch signal cleanly
    const callerAc = new AbortController()
    let linkedSignal: AbortSignal | undefined
    await expect(
      completeSql(
        { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
        { dialect: 'sqlite', system: 's', user: 'u', prefix: 'SELECT ', suffix: '' },
        callerAc.signal,
        async (_u, init) => {
          linkedSignal = init.signal
          callerAc.abort()
          throw new Error('aborted')
        }
      )
    ).rejects.toThrow('aborted')
    expect(linkedSignal?.aborted).toBe(true)
  })

  it('falls back to JSON extraction when a body is present but not an event stream', async () => {
    const payload = JSON.stringify({ choices: [{ message: { content: 'u.id FROM users' } }] })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload))
        controller.close()
      },
    })
    const out = await completeSql(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
      { dialect: 'sqlite', system: 's', user: 'u', prefix: 'select ', suffix: '' },
      new AbortController().signal,
      async () => ({
        ok: true,
        status: 200,
        body,
        headers: { get: () => 'application/json' },
        json: async () => JSON.parse(payload),
        text: async () => payload,
      })
    )
    expect(out).toBe('u.id FROM users')
  })

  it('rejects standalone SQL clause keywords glued mid-word without whitespace (e.g. LIM + WHERE)', async () => {
    const runComplete = async (prefix: string, content: string, dialect: 'postgres' | 'sqlite' = 'postgres') =>
      await completeSql(
        { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
        { dialect, system: 's', user: 'u', prefix, suffix: '' },
        new AbortController().signal,
        async () => ({
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content } }] }),
          text: async () => '',
        })
      )

    expect(await runComplete('SELECT * FROM "banners" LIM', 'WHERE id = 1')).toBe('')
    expect(await runComplete('SELECT * FROM "banners" LIM', 'WHERE')).toBe('')
    expect(await runComplete('SELECT * FROM "banners" LIM', 'ORDER BY id')).toBe('')
    expect(await runComplete('SELECT * FROM "banners" lim', 'where id = 1')).toBe('')
    expect(await runComplete('SELECT * FROM users', 'WHERE id = 1')).toBe('')
    expect(await runComplete('SELECT * FROM users u', 'JOIN orders o ON o.user_id = u.id')).toBe('')

    // Leading space after LIM is distinct from glued LIMWHERE and remains allowed
    expect(await runComplete('SELECT * FROM "banners" LIM', ' WHERE id = 1')).toBe(' WHERE id = 1')

    // Legitimate mid-word continuations must NEVER be falsely rejected
    expect(await runComplete('SELECT * FROM "banners" LIM', 'IT 100')).toBe('IT 100')
    expect(await runComplete('SELECT * FROM "banners" WHE', 'RE id = 1')).toBe('RE id = 1')
    expect(await runComplete('SELECT * FROM "banners" OR', 'DER BY id DESC')).toBe('DER BY id DESC')
    expect(await runComplete('SELECT * FROM "banners" IN', 'NER JOIN users u ON u.id = banners.user_id')).toBe(
      'NER JOIN users u ON u.id = banners.user_id'
    )
    expect(await runComplete('SELECT * FROM "banners" OFF', 'SET 10')).toBe('SET 10')
    expect(await runComplete('SELECT * FROM "banners" UNI', 'ON SELECT * FROM archived')).toBe(
      'ON SELECT * FROM archived'
    )
    expect(await runComplete('SELECT * FROM ban', 'ners WHERE active = true')).toBe('ners WHERE active = true')
    expect(await runComplete('SELECT user', '_id, email FROM users')).toBe('_id, email FROM users')
    expect(await runComplete('SELECT max_', 'limit FROM plans')).toBe('limit FROM plans')
    expect(await runComplete('SELECT sort', 'Order FROM banners')).toBe('Order FROM banners')
    expect(await runComplete('SELECT * FROM pers', 'on WHERE id = 1')).toBe('on WHERE id = 1')
    expect(await runComplete('SELECT * FROM auth', 'or WHERE id = 1')).toBe('or WHERE id = 1')
  })

  it('strips partial-word and case-insensitive prefix echoes without corrupting short aliases', async () => {
    const runComplete = async (prefix: string, content: string) =>
      await completeSql(
        { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
        { dialect: 'postgres', system: 's', user: 'u', prefix, suffix: '' },
        new AbortController().signal,
        async () => ({
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content } }] }),
          text: async () => '',
        })
      )

    expect(await runComplete('SELECT * FROM "banners" LIM', 'LIMIT 100')).toBe('IT 100')
    expect(await runComplete('SELECT * FROM "banners" LIM', 'limit 100')).toBe('IT 100')
    expect(await runComplete('SELECT * FROM "banners" lim', 'LIMIT 100')).toBe('it 100')
    expect(await runComplete('SELECT * FROM "banners" LIMIT', 'LIMIT 100')).toBe(' 100')
    expect(await runComplete('SELECT * FROM "banners" WH', 'WHERE id = 1')).toBe('ERE id = 1')
    expect(await runComplete('SELECT * FROM "banners" ban', 'banners')).toBe('ners')
    expect(await runComplete('SELECT * FROM ban', 'banners WHERE active = true')).toBe('ners WHERE active = true')
    expect(await runComplete('select * from "banners" lim', 'SELECT * FROM "banners" LIMIT 100')).toBe('it 100')
    expect(await runComplete('SELECT * FROM "banners"', '"banners" WHERE active = true')).toBe(' WHERE active = true')

    // Must NOT strip 1-char alias or case-mismatched 2-char alias into corrupted keyword glue
    expect(await runComplete('SELECT * FROM users u', 'UNION SELECT * FROM admins')).toBe('')
    expect(await runComplete('SELECT * FROM orders o', 'ORDER BY o.id')).toBe('')
    expect(await runComplete('SELECT * FROM line_items li', 'LIMIT 10')).toBe('')

    // Leading-whitespace mid-word prefix echo (Bug 1: LIMI + " LIMIT 100" -> "T 100", never " LIMI LIMIT")
    expect(await runComplete('SELECT * FROM "banners" LIMI', ' LIMIT 100')).toBe('T 100')
    expect(await runComplete('SELECT * FROM "banners" LIMI', ' LIMIT')).toBe('T')
    expect(await runComplete('SELECT * FROM "banners" LIMI', '  limit 50')).toBe('T 50')
    expect(await runComplete('SELECT * FROM "banners" limi', ' LIMIT 100')).toBe('t 100')
    expect(await runComplete('SELECT * FROM "banners" LIM', ' LIMIT 100')).toBe('IT 100')
    expect(await runComplete('SELECT * FROM "banners" WH', ' WHERE id = 1')).toBe('ERE id = 1')
    expect(await runComplete('SELECT * FROM "banners" LIMIT', ' LIMIT 100')).toBe(' 100')
    expect(await runComplete('SELECT * FROM "banners" LIMIT', ' LIMIT')).toBe('')

    // Normal valid table aliases followed by leading-space SQL keywords must NEVER be stripped
    expect(await runComplete('SELECT * FROM users u', ' UNION SELECT * FROM admins')).toBe(' UNION SELECT * FROM admins')
    expect(await runComplete('SELECT * FROM orders o', ' ORDER BY o.id')).toBe(' ORDER BY o.id')
    expect(await runComplete('SELECT * FROM line_items li', ' LIMIT 10')).toBe(' LIMIT 10')
    expect(await runComplete('SELECT * FROM banners b', ' WHERE b.active = true')).toBe(' WHERE b.active = true')
    expect(await runComplete("SELECT * FROM logs WHERE msg = 'LIMI", ' LIMIT')).toBe(' LIMIT')
    // Algorithmic prefix-echo trimming also handles arbitrary identifiers (not just SQL keywords)
    expect(await runComplete('SELECT * FROM ban', ' banners WHERE active = true')).toBe('ners WHERE active = true')
  })

  it('normalizes missing leading space after closing quote/bracket/paren without touching opening quotes or punctuation', async () => {
    const runComplete = async (prefix: string, content: string, dialect: 'postgres' | 'mysql' | 'mssql' | 'mongodb' = 'postgres') =>
      await completeSql(
        { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
        { dialect, system: 's', user: 'u', prefix, suffix: '' },
        new AbortController().signal,
        async () => ({
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content } }] }),
          text: async () => '',
        })
      )

    expect(await runComplete('SELECT * FROM "banners"', 'WHERE active = true')).toBe(' WHERE active = true')
    expect(await runComplete('SELECT * FROM `banners`', 'WHERE active = 1', 'mysql')).toBe(' WHERE active = 1')
    expect(await runComplete('SELECT * FROM [banners]', 'ORDER BY id DESC', 'mssql')).toBe(' ORDER BY id DESC')
    expect(await runComplete('SELECT * FROM users WHERE id IN (1, 2)', 'ORDER BY id')).toBe(' ORDER BY id')
    expect(await runComplete("SELECT * FROM users WHERE name = 'alice'", 'AND active = true')).toBe(' AND active = true')
    expect(await runComplete('SELECT * FROM "banners"', '```sql\nWHERE active = true\n```')).toBe(' WHERE active = true')

    // Opening quotes, punctuation continuations, string interiors, and MongoDB must stay untouched
    expect(await runComplete('SELECT * FROM "', 'banners" WHERE active = true')).toBe('banners" WHERE active = true')
    expect(await runComplete('SELECT * FROM `', 'banners` WHERE active = 1', 'mysql')).toBe('banners` WHERE active = 1')
    expect(await runComplete("SELECT * FROM users WHERE name = '", "alice'")).toBe("alice'")
    expect(await runComplete("SELECT * FROM logs WHERE msg = 'LIM", 'WHERE')).toBe('WHERE')
    expect(await runComplete('SELECT * FROM #temp', 'WHERE id = 1', 'mssql')).toBe('')
    expect(await runComplete('SELECT 1 # note LIM', 'WHERE', 'mysql')).toBe('WHERE')
    expect(await runComplete('SELECT * FROM "public"', '."banners"')).toBe('."banners"')
    expect(await runComplete('SELECT * FROM "banners"', ';')).toBe(';')
    expect(await runComplete('SELECT * FROM "banners"', ' WHERE active = true')).toBe(' WHERE active = true')
    expect(await runComplete('db.users.find({ name: "alice" })', '.sort({ createdAt: -1 })', 'mongodb')).toBe(
      '.sort({ createdAt: -1 })'
    )
  })

  it('detects close mistyped leading SQL keywords and known schema identifiers without replacing valid keywords, prefixes, or unrelated clauses', async () => {
    const known = new Set(['banners', 'orders', 'created_at', 'users'])

    // Positive typos: SQL keywords (distance 1-2 via Damerau-Levenshtein)
    expect(detectLeadingTokenReplacement('SELCT', 'SELECT * FROM banners', 'postgres', known)).toEqual({
      suggestion: 'SELECT * FROM banners',
      replaceChars: 5,
    })
    expect(detectLeadingTokenReplacement('SELECT * FORM', 'FROM banners', 'postgres', known)).toEqual({
      suggestion: 'FROM banners',
      replaceChars: 4,
    })
    expect(detectLeadingTokenReplacement('SELECT * FROM banners WEHRE', ' WHERE active = true', 'postgres', known)).toEqual({
      suggestion: 'WHERE active = true',
      replaceChars: 5,
    })
    expect(detectLeadingTokenReplacement('SELECT * FROM banners ODRER', 'ORDER BY id DESC', 'postgres', known)).toEqual({
      suggestion: 'ORDER BY id DESC',
      replaceChars: 5,
    })
    expect(detectLeadingTokenReplacement('SELECT * FROM banners GRUOP', 'GROUP BY status', 'postgres', known)).toEqual({
      suggestion: 'GROUP BY status',
      replaceChars: 5,
    })
    expect(detectLeadingTokenReplacement('SELECT * FROM banners LIMT', 'LIMIT 100', 'postgres', known)).toEqual({
      suggestion: 'LIMIT 100',
      replaceChars: 4,
    })

    // Positive typos: known table/column identifiers
    expect(detectLeadingTokenReplacement('SELECT * FROM baners', 'banners WHERE active = true', 'postgres', known)).toEqual({
      suggestion: 'banners WHERE active = true',
      replaceChars: 6,
    })
    expect(detectLeadingTokenReplacement('SELECT * FROM baners', 'SELECT * FROM banners WHERE active = true', 'postgres', known)).toEqual({
      suggestion: 'banners WHERE active = true',
      replaceChars: 6,
    })
    expect(detectLeadingTokenReplacement('SELECT creted_at', 'created_at FROM orders', 'postgres', known)).toEqual({
      suggestion: 'created_at FROM orders',
      replaceChars: 9,
    })

    // Negative guards: normal prefixes, exact matches, valid keywords, valid identifiers, quotes/comments, non-SQL, unrelated clauses
    expect(detectLeadingTokenReplacement('SELECT * FROM banners LIM', 'LIMIT 100', 'postgres', known)).toBeNull()
    expect(detectLeadingTokenReplacement('SELECT * FROM ban', 'banners WHERE id = 1', 'postgres', known)).toBeNull()
    expect(detectLeadingTokenReplacement('SELECT * FROM banners LIM', 'WHERE id = 1', 'postgres', known)).toBeNull()
    expect(detectLeadingTokenReplacement('SELECT * FROM', 'FROM banners', 'postgres', known)).toBeNull()
    expect(detectLeadingTokenReplacement('SELECT * FROM FOR', 'FROM banners', 'postgres', known)).toBeNull()
    expect(detectLeadingTokenReplacement('SELECT * FROM users', 'orders', 'postgres', known)).toBeNull()
    expect(detectLeadingTokenReplacement('SELCT ', 'SELECT * FROM banners', 'postgres', known)).toBeNull()
    expect(detectLeadingTokenReplacement('SELECT * FROM "baners', 'banners"', 'postgres', known)).toBeNull()
    expect(detectLeadingTokenReplacement("SELECT 'SELCT", 'SELECT', 'postgres', known)).toBeNull()
    expect(detectLeadingTokenReplacement('-- SELCT', 'SELECT', 'postgres', known)).toBeNull()
    expect(detectLeadingTokenReplacement('/* SELCT', 'SELECT', 'postgres', known)).toBeNull()
    expect(detectLeadingTokenReplacement('SELCT', 'SELECT * FROM banners', 'redis', known)).toBeNull()
    expect(detectLeadingTokenReplacement('SELCT', 'SELECT * FROM banners', 'mongodb', known)).toBeNull()
    expect(detectLeadingTokenReplacement('SELECT * FROM baners', 'unknown_xyz', 'postgres', known)).toBeNull()
    expect(detectLeadingTokenReplacement('SELECT * FROM SE', 'SELECT', 'postgres', known)).toBeNull()
    expect(detectLeadingTokenReplacement('SELECT * FROM WHR', 'WHERE id = 1', 'postgres', known)).toBeNull()

    // End-to-end completeSqlWithMeta vs completeSql
    const runMeta = async (prefix: string, content: string) =>
      await completeSqlWithMeta(
        { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
        { dialect: 'postgres', system: 's', user: 'u', prefix, suffix: '', knownIdentifiers: known },
        new AbortController().signal,
        async () => ({
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content } }] }),
          text: async () => '',
        })
      )

    expect(await runMeta('SELCT', 'SELECT * FROM banners')).toEqual({
      suggestion: 'SELECT * FROM banners',
      replaceChars: 5,
    })
    expect(await runMeta('SELECT * FROM baners', 'banners LIMIT 10')).toEqual({
      suggestion: 'banners LIMIT 10',
      replaceChars: 6,
    })
    expect(await runMeta('SELECT * FROM banners LIM', 'LIMIT 100')).toEqual({
      suggestion: 'IT 100',
      replaceChars: 0,
    })
    expect(await runMeta('SELECT * FROM banners LIM', 'WHERE id = 1')).toEqual({
      suggestion: '',
      replaceChars: 0,
    })
  })

  it('pre-heals mistyped trailing SQL keywords and schema identifiers (with or without trailing space) even when model returns continuation-only', async () => {
    const known = new Set(['banners', 'orders', 'UserProfiles', 'created_at', 'users'])

    // Pure helper checks: positive cases (no space & with trailing space)
    expect(resolveTrailingTypoToken('SELCT', 'postgres', known)).toEqual({
      rawWord: 'SELCT',
      trailingSpaces: '',
      correctedWord: 'SELECT',
      replaceChars: 5,
      healedPrefix: 'SELECT',
    })
    expect(resolveTrailingTypoToken('selct ', 'postgres', known)).toEqual({
      rawWord: 'selct',
      trailingSpaces: ' ',
      correctedWord: 'select',
      replaceChars: 6,
      healedPrefix: 'select ',
    })
    expect(resolveTrailingTypoToken('SELECT * FORM ', 'postgres', known)).toEqual({
      rawWord: 'FORM',
      trailingSpaces: ' ',
      correctedWord: 'FROM',
      replaceChars: 5,
      healedPrefix: 'SELECT * FROM ',
    })
    expect(resolveTrailingTypoToken('SELECT * FROM "banners" LIMI ', 'postgres', known)).toEqual({
      rawWord: 'LIMI',
      trailingSpaces: ' ',
      correctedWord: 'LIMIT',
      replaceChars: 5,
      healedPrefix: 'SELECT * FROM "banners" LIMIT ',
    })
    expect(resolveTrailingTypoToken('SELECT * FROM "banners" WHER ', 'postgres', known)).toEqual({
      rawWord: 'WHER',
      trailingSpaces: ' ',
      correctedWord: 'WHERE',
      replaceChars: 5,
      healedPrefix: 'SELECT * FROM "banners" WHERE ',
    })
    expect(resolveTrailingTypoToken('SELECT * FROM UserProfils ', 'postgres', known)).toEqual({
      rawWord: 'UserProfils',
      trailingSpaces: ' ',
      correctedWord: 'UserProfiles',
      replaceChars: 12,
      healedPrefix: 'SELECT * FROM UserProfiles ',
    })
    expect(resolveTrailingTypoToken('SELECT u.creted_at ', 'postgres', known)).toEqual({
      rawWord: 'creted_at',
      trailingSpaces: ' ',
      correctedWord: 'created_at',
      replaceChars: 10,
      healedPrefix: 'SELECT u.created_at ',
    })

    // Zero false positives: aliases after FROM/JOIN/AS, mid-word prefixes without space, statement-start non-keywords, valid SQL words
    expect(resolveTrailingTypoToken('SELECT * FROM orders o ', 'postgres', known)).toBeNull()
    expect(resolveTrailingTypoToken('SELECT * FROM orders ord ', 'postgres', known)).toBeNull()
    expect(resolveTrailingTypoToken('SELECT * FROM orders o JOIN users usr ', 'postgres', known)).toBeNull()
    expect(resolveTrailingTypoToken('SELECT * FROM banners baners ', 'postgres', known)).toBeNull()
    expect(resolveTrailingTypoToken('SELECT count(*) AS totl ', 'postgres', known)).toBeNull()
    expect(resolveTrailingTypoToken('SELECT * FROM "banners" LIM', 'postgres', known)).toBeNull()
    expect(resolveTrailingTypoToken('SELECT * FROM "banners" LIMI', 'postgres', known)).toBeNull()
    expect(resolveTrailingTypoToken('SELECT * FROM ban', 'postgres', known)).toBeNull()
    expect(resolveTrailingTypoToken('baners', 'postgres', known)).toBeNull()
    expect(resolveTrailingTypoToken('SELECT * FROM [baners', 'mssql', known)).toBeNull()
    expect(resolveTrailingTypoToken('SELECT MIN ', 'postgres', known)).toBeNull()
    expect(resolveTrailingTypoToken('SELECT x::INT ', 'postgres', known)).toBeNull()
    expect(resolveTrailingTypoToken('SELECT x::TEXT ', 'postgres', known)).toBeNull()
    expect(resolveTrailingTypoToken('ALTER TABLE banners ADD ', 'postgres', known)).toBeNull()
    expect(resolveTrailingTypoToken('SELECT * FROM orders ', 'sqlite')).toBeNull()
    expect(resolveTrailingTypoToken('SELECT orders, groups, limits FROM t ', 'sqlite')).toBeNull()

    // End-to-end completeSqlWithMeta when LLM returns continuation-only (chat or FIM!)
    const seenUserPrompts: string[] = []
    const runContinuation = async (prefix: string, continuation: string) =>
      await completeSqlWithMeta(
        { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'k', maxTokens: 64 },
        {
          dialect: 'postgres',
          system: 's',
          user: `Query:\n${prefix}<CURSOR>`,
          prefix,
          suffix: '',
          knownIdentifiers: known,
        },
        new AbortController().signal,
        async (_u, init) => {
          const body = JSON.parse(init.body) as { messages: Array<{ content: string }> }
          seenUserPrompts.push(body.messages[1].content)
          return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content: continuation } }] }),
            text: async () => '',
          }
        }
      )

    expect(await runContinuation('SELCT', ' * FROM "banners" LIMIT 100')).toEqual({
      suggestion: 'SELECT * FROM "banners" LIMIT 100',
      replaceChars: 5,
    })
    expect(seenUserPrompts[0]).toContain('SELECT<CURSOR>')

    expect(await runContinuation('SELCT ', '* FROM "banners"')).toEqual({
      suggestion: 'SELECT * FROM "banners"',
      replaceChars: 6,
    })
    expect(seenUserPrompts[1]).toContain('SELECT <CURSOR>')

    expect(await runContinuation('SELECT * FORM ', '"banners"')).toEqual({
      suggestion: 'FROM "banners"',
      replaceChars: 5,
    })
    expect(await runContinuation('SELECT * FROM "banners" LIMI ', '100')).toEqual({
      suggestion: 'LIMIT 100',
      replaceChars: 5,
    })
    expect(await runContinuation('ORDER BY id DSEC', '')).toEqual({
      suggestion: 'DESC',
      replaceChars: 4,
    })
    expect(await runContinuation('SELECT * FROM orders o ', 'WHERE o.id = 1')).toEqual({
      suggestion: 'WHERE o.id = 1',
      replaceChars: 0,
    })
    expect(await runContinuation('SELECT * FROM "banners" LIM', 'IT 100')).toEqual({
      suggestion: 'IT 100',
      replaceChars: 0,
    })
  })
})

describe('ai-client models, ranking, errors & metrics', () => {
  it('filters non-code models, ranks by latency, and computes percentiles', async () => {
    const models = await listModels(
      { format: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k' },
      new AbortController().signal,
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 'text-embedding-3-small' }, { id: 'gpt-4o-mini' }, { id: 'whisper-1' }, { id: 'gpt-4.1-mini' }],
        }),
      })
    )
    expect(models).toEqual(['gpt-4.1-mini', 'gpt-4o-mini'])

    const speeds = {
      'gpt-4o-mini': { ok: true, ms: 900 },
      'gpt-4.1-mini': { ok: true, ms: 450 },
    }
    expect(rankModels(['gpt-4o-mini', 'gpt-4.1-mini'], speeds, 2500)).toEqual(['gpt-4.1-mini', 'gpt-4o-mini'])
    expect(recommendedModels(['gpt-4o-mini', 'gpt-4.1-mini'], speeds, 2500)).toEqual(['gpt-4.1-mini', 'gpt-4o-mini'])
    expect(pickCandidates(['gpt-4o-mini', 'gpt-4.1-mini', 'claude-haiku-4'], { 'gpt-4o-mini': { ok: true, ms: 500 } }, 2, 'claude-haiku-4')[0]).toBe('claude-haiku-4')
    expect(isExpectedSqlBenchAnswer('1;')).toBe(true)
    expect(isExpectedSqlBenchAnswer('')).toBe(false)
    expect(median([100, 300, 900])).toBe(300)

    expect(explainFailure(new ProviderHttpError(401), 'api.openai.com', 2500, 'openai')).toMatch(/API key/i)
    expect(explainFailure(new ProviderHttpError(400), 'localhost:11434', 2500, 'ollama')).toMatch(/fill-in-the-middle/i)
    expect(explainFailure(new ProviderHttpError(504), 'gateway.example', 60_000, 'openai')).toBe(
      'Provider gateway timed out (HTTP 504). Retry, lower EXPLAIN max tokens, or try a faster model in AI Settings.'
    )

    let stats = emptyStats(1000)
    stats = bumpMetric(stats, 'm1', 'shown')
    stats = bumpMetric(stats, 'm1', 'accepted')
    stats = recordMetricLatency(stats, 'm1', 200)
    stats = recordMetricLatency(stats, 'm1', 800)
    const summary = summarizeModelStats(stats, 'm1')
    expect(summary.shown).toBe(1)
    expect(summary.accepted).toBe(1)
    expect(summary.p50).toBe(200)
    expect(summary.p95).toBe(800)
  })

  it('extracts all matching model IDs without truncation and supports Ollama models array', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: `vendor/model-${String(i + 1).padStart(2, '0')}`,
    }))
    const extracted = extractModelIds({ data: many })
    expect(extracted).toHaveLength(60)
    expect(extracted).toContain('vendor/model-60')

    const ollamaExtracted = extractModelIds({
      models: [{ name: 'qwen2.5-coder:7b' }, { name: 'nomic-embed-text' }],
    })
    expect(ollamaExtracted).toEqual(['qwen2.5-coder:7b'])
  })
})

class MockAiDomElement {
  readonly tagName: string
  children: MockAiDomElement[] = []
  parentNode: MockAiDomElement | null = null
  className = ''
  textContent = ''
  type = ''
  value = ''
  placeholder = ''
  autocomplete = ''
  min = ''
  max = ''
  title = ''
  disabled = false
  checked = false
  selected = false
  hidden = false
  readOnly = false
  tabIndex = 0
  htmlFor = ''
  private attrs = new Map<string, string>()
  private listeners = new Map<string, Array<(e: unknown) => void>>()
  private _id = ''

  constructor(tag: string) {
    this.tagName = tag.toUpperCase()
  }

  get id(): string {
    return this._id
  }

  set id(v: string) {
    this._id = String(v)
    this.attrs.set('id', this._id)
  }

  get firstChild(): MockAiDomElement | null {
    return this.children[0] ?? null
  }

  appendChild(child: MockAiDomElement): MockAiDomElement {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  removeChild(child: MockAiDomElement): MockAiDomElement {
    this.children = this.children.filter((c) => c !== child)
    child.parentNode = null
    return child
  }

  setAttribute(name: string, value: string): void {
    const str = String(value)
    this.attrs.set(name, str)
    if (name === 'id') this._id = str
    if (name === 'for') this.htmlFor = str
  }

  getAttribute(name: string): string | null {
    if (name === 'id' && this._id) return this._id
    if (name === 'for' && this.htmlFor) return this.htmlFor
    return this.attrs.get(name) ?? null
  }

  addEventListener(type: string, fn: (e: unknown) => void): void {
    const arr = this.listeners.get(type) ?? []
    arr.push(fn)
    this.listeners.set(type, arr)
  }

  click(): void {
    for (const fn of this.listeners.get('click') ?? []) {
      fn({ target: this })
    }
  }

  focus(): void {}
}

function collectElements(root: MockAiDomElement, pred: (el: MockAiDomElement) => boolean): MockAiDomElement[] {
  const out: MockAiDomElement[] = []
  const visit = (node: MockAiDomElement) => {
    if (pred(node)) out.push(node)
    for (const child of node.children) visit(child)
  }
  visit(root)
  return out
}

describe('openSharedAiConfigModal accessibility', () => {
  let restoreDoc: (() => void) | null = null

  afterEach(() => {
    restoreDoc?.()
    restoreDoc = null
  })

  it('wires unique ids, label.htmlFor, aria-label on all controls/buttons, and dialog aria-labelledby', async () => {
    const prevDocument: unknown = Reflect.get(globalThis, 'document')
    const body = new MockAiDomElement('body')
    Reflect.set(globalThis, 'document', {
      body,
      createElement: (tag: string) => new MockAiDomElement(tag),
    })
    restoreDoc = () => {
      if (prevDocument === undefined) {
        Reflect.deleteProperty(globalThis, 'document')
      } else {
        Reflect.set(globalThis, 'document', prevDocument)
      }
    }

    const mountRoot = async () => {
      let mounted: MockAiDomElement | null = null
      let closed = false
      await openSharedAiConfigModal({
        rpc: async (method: string) => {
          if (method === 'ai.status.get') {
            return {
              enabled: true,
              configured: true,
              hasKey: true,
              state: 'ready',
              format: 'openai',
              baseUrl: 'https://api.openai.com/v1',
              model: 'gpt-4o-mini',
              maxTokens: 96,
              explainMaxTokens: 2048,
              explainLanguage: 'auto',
            }
          }
          if (method === 'ai.stats.get') return { summary: {} }
          if (method === 'ai.models.list') return { ok: true, models: ['gpt-4o-mini'] }
          return {}
        },
        saveSettings: async () => {},
        mountModal: (card) => {
          if (card instanceof MockAiDomElement) {
            mounted = card
            body.appendChild(card)
          }
          return null
        },
        closeModal: () => {
          closed = true
        },
      })
      if (!mounted) {
        throw new Error('Expected openSharedAiConfigModal to mount dialog card')
      }
      return { mounted, isClosed: () => closed }
    }

    const first = await mountRoot()
    const second = await mountRoot()

    const dialog = first.mounted
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const labelledBy = dialog.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()

    const heading = collectElements(dialog, (n) => n.tagName === 'H3' && n.id === labelledBy)[0]
    expect(heading).toBeDefined()
    expect(heading.textContent.trim().length).toBeGreaterThan(0)

    const labels = collectElements(dialog, (n) => n.tagName === 'LABEL' && Boolean(n.htmlFor))
    const labelByFor = new Map(labels.map((l) => [l.htmlFor, l]))

    const formControls = collectElements(dialog, (n) => n.tagName === 'INPUT' || n.tagName === 'SELECT')
    expect(formControls.length).toBe(9)
    const ids = new Set<string>()
    for (const ctrl of formControls) {
      expect(ctrl.id.length).toBeGreaterThan(0)
      expect(ids.has(ctrl.id)).toBe(false)
      ids.add(ctrl.id)
      expect((ctrl.getAttribute('aria-label') || '').trim().length).toBeGreaterThan(0)
      if (ctrl.type !== 'search') {
        const matchedLabel = labelByFor.get(ctrl.id)
        expect(matchedLabel).toBeDefined()
        expect(matchedLabel?.getAttribute('for')).toBe(ctrl.id)
      }
    }

    const expectedGridControls = formControls.filter((c) => c.type !== 'checkbox' && c.type !== 'search')
    expect(expectedGridControls).toHaveLength(7)

    const buttons = collectElements(dialog, (n) => n.tagName === 'BUTTON')
    expect(buttons.length).toBeGreaterThanOrEqual(8)
    for (const btn of buttons) {
      expect((btn.getAttribute('aria-label') || '').trim().length).toBeGreaterThan(0)
    }

    // Second modal instance must generate distinct unique IDs.
    const secondIds = collectElements(second.mounted, (n) => Boolean(n.id)).map((n) => n.id)
    for (const sid of secondIds) {
      expect(ids.has(sid)).toBe(false)
    }

    const closeBtn = buttons.find((b) => b.textContent === '×')
    expect(closeBtn).toBeDefined()
    closeBtn?.click()
    expect(first.isClosed()).toBe(true)
  })
})
