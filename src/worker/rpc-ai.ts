import { createHash } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  sanitizeJsonPayload,
  type AiExplainAnalysisResult,
  type AiExplainLanguage,
  type AiFixQueryResult,
  type AiMetricKind,
  type AiProviderFormat,
  type AiStatusSnapshot,
  type AiStatusState,
  type DatabaseDriverType,
  type QueryHistoryEntry,
} from '../protocol'
import {
  AI_BENCH_BATCH_SIZE,
  AI_BENCH_MAX_TOKENS,
  AI_BENCH_TIMEOUT_MS,
  AI_COMPLETE_TIMEOUT_MS,
  AI_EVENT_KINDS,
  AI_EXPLAIN_TIMEOUT_MS,
  AI_MODELS_TIMEOUT_MS,
  AI_RPC_MAX_PREFIX_CHARS,
  AI_RPC_MAX_SUFFIX_CHARS,
  AI_TEST_TIMEOUT_MS,
  bumpMetric,
  completeChat,
  completeSql,
  completeSqlWithMeta,
  emptyStats,
  explainFailure,
  hasSensitiveContent,
  hostOf,
  isExpectedSqlBenchAnswer,
  isLoopbackHost,
  isStatsStore,
  listModels,
  median,
  parseFormat,
  presetFor,
  recordMetricLatency,
  resolveTrailingTypoToken,
  sameAddress,
  sanitizeAiBaseUrlForDisplay,
  summarizeModelStats,
  validateAiBaseUrl,
  type AiProviderConfig,
  type AiStatsStore,
  type FetchGetLike,
  type FetchPostLike,
} from './ai-client'
import {
  MAX_FIX_QUERY_SCHEMA_CHARS,
  WorkerSchemaMetadataCache,
  buildExplainAnalysisPrompt,
  buildFixQueryPrompt,
  buildPrunedSchemaBlock,
  buildSqlCompletionContext,
  extractReferencedMongoCollections,
  extractReferencedTables,
  parseExplainAnalysis,
  parseFixQueryResult,
  type WorkerSchemaSnapshot,
} from './ai-sql-context'
import type { SessionManager } from './session-manager'
import {
  QUERY_HISTORY_STORAGE_KEY,
  createHostError,
  scrubCredentialsInText,
  type WorkerRegisterHandler,
} from './worker-utils'

const AI_SECRET_KEY = 'ai_api_key'
const AI_KEY_ADDRESS_STORAGE = 'datanoa.ai.keyAddress'
const AI_USAGE_KEY = 'datanoa.ai.usage'
const AI_STATS_KEY = 'datanoa.ai.stats'

const CACHE_SIZE = 64
const USAGE_SAMPLES = 9
const USAGE_MODELS = 40
const SUGGESTION_IDS_KEPT = 200
const MAX_INLINE_TOKENS = 1024
const DEFAULT_EXPLAIN_MAX_TOKENS = 2048
const MIN_EXPLAIN_MAX_TOKENS = 256
const MAX_EXPLAIN_MAX_TOKENS = 8192
const ERROR_TEXT_CHARS = 160
const LOG_REPEAT_MS = 60_000
const AUTO_ERROR_COOLDOWN_THRESHOLD = 2
const AUTO_ERROR_COOLDOWN_MS = 8_000

const EXPLAIN_LANGUAGES: readonly AiExplainLanguage[] = [
  'auto',
  'vi',
  'en',
  'ja',
  'zh',
  'ko',
  'es',
  'fr',
  'de',
  'pt',
]

function parseExplainLanguage(val: unknown): AiExplainLanguage {
  return EXPLAIN_LANGUAGES.find((l) => l === val) ?? 'auto'
}

type UsageMap = Record<string, number[]>

function isUsageMap(value: unknown): value is UsageMap {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((v) => Array.isArray(v) && v.every((n) => typeof n === 'number'))
  )
}

const modelKey = (baseUrl: string, model: string): string => `${hostOf(baseUrl)}|${model}`

interface ResolvedAiConfig {
  enabled: boolean
  explainLanguage: AiExplainLanguage
  explainMaxTokens: number
  provider: AiProviderConfig
  validProvider: boolean
}

function buildExactCacheKey(scopeKey: string, prefix: string, suffix: string): string {
  const fullHash = createHash('sha256')
    .update(String(prefix.length))
    .update('\0')
    .update(prefix)
    .update('\0')
    .update(String(suffix.length))
    .update('\0')
    .update(suffix)
    .digest('hex')
  return `${scopeKey}\n${prefix.slice(-300)}\n${suffix.slice(0, 100)}\n${fullHash}`
}

interface CompletionCacheEntry {
  exactKey: string
  scopeKey: string
  rawPrefix: string
  rawSuffix: string
  suggestion: string
  replaceChars: number
}

interface CompletionResultPayload {
  suggestion: string
  id: number
  replaceChars?: number
}

function collectKnownIdentifiers(
  snapshot: WorkerSchemaSnapshot | null,
  schemaMap?: Record<string, string[]>
): Set<string> {
  const ids = new Set<string>()
  const addIdent = (raw: string | undefined) => {
    if (typeof raw !== 'string') return
    const trimmed = raw.trim()
    if (!trimmed) return
    ids.add(trimmed)
    if (trimmed.includes('.')) {
      const bare = trimmed.split('.').pop()?.trim() || ''
      if (bare) ids.add(bare)
    }
  }
  if (snapshot) {
    for (const obj of snapshot.objects) {
      addIdent(obj.name)
    }
    for (const det of snapshot.details.values()) {
      addIdent(det.name)
      for (const col of det.columns || []) {
        addIdent(col.name)
      }
    }
  }
  if (schemaMap) {
    for (const [tableName, cols] of Object.entries(schemaMap)) {
      addIdent(tableName)
      if (Array.isArray(cols)) {
        for (const col of cols) {
          addIdent(col)
        }
      }
    }
  }
  return ids
}

export interface AiHandlersDeps {
  orca: OrcaWorkerApi
  registerHandler: WorkerRegisterHandler
  sessionManager: SessionManager
  schemaCache: WorkerSchemaMetadataCache
  fetchPost?: FetchPostLike
  fetchGet?: FetchGetLike
}

export interface AiHandlersController {
  invalidateHistoryCache: () => void
  dispose: () => void
}

export function registerAiHandlers({
  orca,
  registerHandler,
  sessionManager,
  schemaCache,
  fetchPost,
  fetchGet,
}: AiHandlersDeps): AiHandlersController {
  const completionCache = new Map<string, CompletionCacheEntry>()
  type CompletionFlight = {
    promise: Promise<CompletionResultPayload>
    controller: AbortController
    waiters: number
  }
  const inflightByPanel = new Map<string, AbortController>()
  const inFlightByPanelAndKey = new Map<string, CompletionFlight>()
  const inflightExplainByPanel = new Map<string, AbortController>()
  const inflightFixByPanel = new Map<string, AbortController>()
  const suggestionModels = new Map<number, string>()
  const reasoningModels = new Set<string>()
  const effortUnsupportedModels = new Set<string>()
  let lastSuggestionId = 0

  function rememberBoundedKey(set: Set<string>, key: string): void {
    set.delete(key)
    set.add(key)
    while (set.size > USAGE_MODELS) {
      const oldest = set.keys().next().value
      if (oldest === undefined) break
      set.delete(oldest)
    }
  }

  function adaptiveOptsFor(key: string) {
    return {
      reasoning: reasoningModels.has(key),
      skipEffort: effortUnsupportedModels.has(key),
      isEffortUnsupported: () => effortUnsupportedModels.has(key),
      markEffortUnsupported: () => rememberBoundedKey(effortUnsupportedModels, key),
      onReasoningDetected: () => rememberBoundedKey(reasoningModels, key),
      onEffortRejected: () => rememberBoundedKey(effortUnsupportedModels, key),
    }
  }

  function rememberCompletion(entry: CompletionCacheEntry): void {
    completionCache.delete(entry.exactKey)
    completionCache.set(entry.exactKey, entry)
    while (completionCache.size > CACHE_SIZE) {
      const oldest = completionCache.keys().next().value
      if (oldest === undefined) break
      completionCache.delete(oldest)
    }
  }

  function lookupCompletion(
    scopeKey: string,
    rawPrefix: string,
    rawSuffix: string,
    exactKey: string
  ): { suggestion: string; replaceChars: number } | null {
    const exact = completionCache.get(exactKey)
    if (exact) {
      rememberCompletion(exact)
      return { suggestion: exact.suggestion, replaceChars: exact.replaceChars }
    }
    let best: CompletionCacheEntry | null = null
    for (const entry of completionCache.values()) {
      if (entry.replaceChars > 0) continue
      if (entry.scopeKey !== scopeKey || entry.rawSuffix !== rawSuffix) continue
      if (!rawPrefix.startsWith(entry.rawPrefix)) continue
      if (!best || entry.rawPrefix.length > best.rawPrefix.length) best = entry
    }
    if (best) {
      const delta = rawPrefix.slice(best.rawPrefix.length)
      if (delta.length > best.suggestion.length || !best.suggestion.startsWith(delta)) return null
      rememberCompletion(best)
      return { suggestion: best.suggestion.slice(delta.length), replaceChars: 0 }
    }
    let backspace: CompletionCacheEntry | null = null
    let backspaceTail = ''
    for (const entry of completionCache.values()) {
      if (entry.replaceChars > 0) continue
      if (entry.scopeKey !== scopeKey || entry.rawSuffix !== rawSuffix) continue
      if (!entry.rawPrefix.startsWith(rawPrefix)) continue
      const deletedTail = entry.rawPrefix.slice(rawPrefix.length)
      if (
        deletedTail.length === 0 ||
        deletedTail.length > 16 ||
        deletedTail.includes('\n') ||
        !/^[A-Za-z0-9_.,= ]+$/.test(deletedTail) ||
        entry.suggestion.length === 0
      ) {
        continue
      }
      if (!backspace || deletedTail.length < backspaceTail.length) {
        backspace = entry
        backspaceTail = deletedTail
      }
    }
    if (!backspace) return null
    rememberCompletion(backspace)
    return { suggestion: backspaceTail + backspace.suggestion, replaceChars: 0 }
  }

  function joinFlight(
    flight: CompletionFlight,
    signal?: AbortSignal
  ): Promise<CompletionResultPayload> {
    if (signal?.aborted) return Promise.resolve({ suggestion: '', id: 0 })
    flight.waiters += 1
    let released = false
    const leave = (abortUpstream: boolean) => {
      if (released) return
      released = true
      flight.waiters -= 1
      if (abortUpstream && flight.waiters <= 0 && !flight.controller.signal.aborted) {
        flight.controller.abort()
      }
    }
    const settled = flight.promise.finally(() => leave(false))
    if (!signal) return settled
    let onAbort: () => void = () => {}
    const aborted = new Promise<CompletionResultPayload>((resolve) => {
      onAbort = () => {
        leave(true)
        resolve({ suggestion: '', id: 0 })
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const raced = Promise.race([settled, aborted])
    void raced.then(
      () => signal.removeEventListener('abort', onAbort),
      () => signal.removeEventListener('abort', onAbort)
    )
    return raced
  }

  const runtimeStats = {
    suggested: 0,
    lastMs: null as number | null,
    lastError: null as string | null,
    lastSlow: false,
  }
  let consecutiveCompleteErrors = 0
  let autoCooldownUntil = 0
  let autoCooldownModelKey = ''
  let lastLog = { message: '', at: 0 }
  let historyCache: QueryHistoryEntry[] | null = null
  let statsQueue: Promise<void> = Promise.resolve()

  function resetCompleteErrorCooldown(): void {
    consecutiveCompleteErrors = 0
    autoCooldownUntil = 0
    autoCooldownModelKey = ''
  }

  function noteCompleteError(mKey: string): void {
    if (autoCooldownModelKey !== mKey) {
      autoCooldownModelKey = mKey
      consecutiveCompleteErrors = 1
    } else {
      consecutiveCompleteErrors += 1
    }
    if (consecutiveCompleteErrors >= AUTO_ERROR_COOLDOWN_THRESHOLD) {
      autoCooldownUntil = Date.now() + AUTO_ERROR_COOLDOWN_MS
    }
  }

  function logFailure(message: string): void {
    const safe = scrubCredentialsInText(message)
    const now = Date.now()
    if (safe === lastLog.message && now - lastLog.at < LOG_REPEAT_MS) return
    lastLog = { message: safe, at: now }
    orca.log(`[AI] ${safe}`)
  }

  async function savedKeyFor(baseUrl: string): Promise<string> {
    await pinReady
    const [key, pinned] = await Promise.all([
      orca.secrets.get(AI_SECRET_KEY).then((v) => v ?? ''),
      orca.storage.get(AI_KEY_ADDRESS_STORAGE),
    ])
    if (!key || typeof pinned !== 'string' || !pinned.trim() || !sameAddress(pinned, baseUrl)) {
      return ''
    }
    return key
  }

  async function readConfig(): Promise<ResolvedAiConfig> {
    const settings = await orca.settings.get()
    const enabled = settings.aiEnabled === true
    const format = parseFormat(settings.aiFormat)
    const rawUrl = settings.aiBaseUrl !== undefined ? String(settings.aiBaseUrl) : 'https://api.openai.com/v1'
    const baseUrl = rawUrl.trim()
    const rawModel = settings.aiModel !== undefined ? String(settings.aiModel) : 'gpt-4o-mini'
    const model = rawModel.trim()
    const maxTokensRaw = Number(settings.aiMaxTokens)
    const maxTokens =
      Number.isFinite(maxTokensRaw) && maxTokensRaw > 0
        ? Math.min(MAX_INLINE_TOKENS, Math.max(16, Math.floor(maxTokensRaw)))
        : 96
    const explainTokensRaw = Number(settings.aiExplainMaxTokens)
    const explainMaxTokens =
      Number.isFinite(explainTokensRaw) && explainTokensRaw > 0
        ? Math.min(MAX_EXPLAIN_MAX_TOKENS, Math.max(MIN_EXPLAIN_MAX_TOKENS, Math.floor(explainTokensRaw)))
        : DEFAULT_EXPLAIN_MAX_TOKENS
    const explainLanguage = parseExplainLanguage(settings.aiExplainLanguage)
    const urlCheck = validateAiBaseUrl(baseUrl)
    const canonicalBaseUrl = urlCheck.ok ? urlCheck.url : baseUrl
    let validProvider = urlCheck.ok && model.length > 0
    let apiKey = validProvider ? await savedKeyFor(canonicalBaseUrl) : ''
    if (apiKey && !validateAiBaseUrl(canonicalBaseUrl, { hasApiKey: true }).ok) {
      apiKey = ''
      validProvider = false
    }
    return {
      enabled,
      explainLanguage,
      explainMaxTokens,
      validProvider,
      provider: { format, baseUrl: canonicalBaseUrl, model, apiKey, maxTokens },
    }
  }

  function isKeyMissing(cfg: ResolvedAiConfig): boolean {
    return (
      presetFor(cfg.provider.format, cfg.provider.baseUrl).keyKind === 'required' &&
      !cfg.provider.apiKey
    )
  }

  function stateOf(cfg: ResolvedAiConfig): AiStatusState {
    if (!cfg.enabled) return 'off'
    if (!cfg.validProvider || isKeyMissing(cfg)) return 'setup'
    if (runtimeStats.lastSlow) return 'slow'
    return runtimeStats.lastError ? 'error' : 'on'
  }

  function destinationOf(cfg: ResolvedAiConfig): 'none' | 'local' | 'remote' {
    if (!cfg.enabled || !cfg.validProvider || isKeyMissing(cfg)) return 'none'
    return isLoopbackHost(hostOf(cfg.provider.baseUrl)) ? 'local' : 'remote'
  }

  async function buildStatusSnapshot(known?: ResolvedAiConfig): Promise<AiStatusSnapshot> {
    const cfg = known ?? (await readConfig())
    const displayBaseUrl = sanitizeAiBaseUrlForDisplay(cfg.provider.baseUrl)
    const hasKey = Boolean(
      cfg.validProvider
        ? cfg.provider.apiKey
        : validateAiBaseUrl(cfg.provider.baseUrl, { hasApiKey: true }).ok
          ? await savedKeyFor(cfg.provider.baseUrl)
          : ''
    )
    return {
      enabled: cfg.enabled,
      state: stateOf(cfg),
      lastMs: runtimeStats.lastMs,
      suggested: runtimeStats.suggested,
      reason: runtimeStats.lastError,
      format: cfg.provider.format,
      baseUrl: displayBaseUrl,
      host: hostOf(displayBaseUrl),
      model: cfg.provider.model,
      maxTokens: cfg.provider.maxTokens,
      explainMaxTokens: cfg.explainMaxTokens,
      explainLanguage: cfg.explainLanguage,
      hasKey,
      destination: destinationOf(cfg),
    }
  }

  async function refreshStatus(): Promise<void> {
    const snap = await buildStatusSnapshot()
    orca.panels.post('ai.status.changed', snap)
  }

  async function readUsage(): Promise<UsageMap> {
    const stored = await orca.storage.get(AI_USAGE_KEY)
    return isUsageMap(stored) ? stored : {}
  }

  async function recordUsage(baseUrl: string, model: string, ms: number): Promise<void> {
    const key = modelKey(baseUrl, model)
    const usage = await readUsage()
    const { [key]: prev = [], ...rest } = usage
    const next: UsageMap = { ...rest, [key]: [...prev, ms].slice(-USAGE_SAMPLES) }
    const keys = Object.keys(next)
    for (const old of keys.slice(0, Math.max(0, keys.length - USAGE_MODELS))) {
      delete next[old]
    }
    await orca.storage.set(AI_USAGE_KEY, next)
  }

  function updateStats(change: (store: AiStatsStore) => AiStatsStore): void {
    statsQueue = statsQueue
      .then(async () => {
        const stored = await orca.storage.get(AI_STATS_KEY)
        const base = isStatsStore(stored) ? stored : emptyStats(Date.now())
        await orca.storage.set(AI_STATS_KEY, sanitizeJsonPayload(change(base)))
      })
      .catch(() => undefined)
  }

  function rememberSuggestion(model: string): number {
    lastSuggestionId += 1
    suggestionModels.set(lastSuggestionId, model)
    if (suggestionModels.size > SUGGESTION_IDS_KEPT) {
      const oldest = suggestionModels.keys().next().value
      if (oldest !== undefined) suggestionModels.delete(oldest)
    }
    return lastSuggestionId
  }

  async function keyForListing(format: AiProviderFormat, url: string, typed: string): Promise<string> {
    if (presetFor(format, url).keyKind === 'none') return ''
    if (typed) return typed
    const settings = await orca.settings.get()
    const savedFormat = parseFormat(settings.aiFormat)
    const savedUrl = String(settings.aiBaseUrl ?? '')
    return savedFormat === format && sameAddress(savedUrl, url) ? await savedKeyFor(url) : ''
  }

  async function getHistoryEntries(): Promise<QueryHistoryEntry[]> {
    if (historyCache) return historyCache
    try {
      const raw = await orca.storage.get(QUERY_HISTORY_STORAGE_KEY)
      historyCache = Array.isArray(raw) ? (raw as unknown as QueryHistoryEntry[]) : []
    } catch {
      historyCache = []
    }
    return historyCache
  }

  function buildTestCompletionRequest(dialect: DatabaseDriverType = 'sqlite') {
    const prefix = 'SELECT id, name FROM users WHERE id = '
    return {
      dialect,
      system:
        'You are a SQL completion engine. Reply with ONLY the SQL token(s) to continue the query at <CURSOR>. No explanation or fences.',
      user: `Dialect: SQLite\n\nQuery:\n${prefix}<CURSOR>`,
      prefix,
      suffix: '',
    }
  }

  registerHandler('ai.status.get', async () => await buildStatusSnapshot())

  registerHandler('ai.key.set', async (input) => {
    const trimmed = typeof input?.key === 'string' ? input.key.trim() : ''
    if (trimmed) {
      await sessionManager.assertSecureSecretStorage()
      const baseUrl =
        input?.baseUrl !== undefined
          ? String(input.baseUrl).trim()
          : String((await orca.settings.get('aiBaseUrl')) ?? '').trim()
      const checked = validateAiBaseUrl(baseUrl, { hasApiKey: true })
      if (!checked.ok) {
        throw createHostError('invalid_params', checked.error)
      }
      await orca.secrets.set(AI_SECRET_KEY, trimmed)
      await orca.storage.set(AI_KEY_ADDRESS_STORAGE, checked.url)
    } else {
      await orca.secrets.delete(AI_SECRET_KEY)
      await orca.storage.delete(AI_KEY_ADDRESS_STORAGE)
    }
    completionCache.clear()
    resetCompleteErrorCooldown()
    runtimeStats.lastError = null
    runtimeStats.lastSlow = false
    void refreshStatus()
    return { hasKey: Boolean(trimmed) }
  })

  registerHandler('ai.provider.test', async () => {
    const cfg = await readConfig()
    if (!cfg.validProvider) {
      return { ok: false, message: 'Set a valid http(s) Base URL and model name.', ms: null }
    }
    if (isKeyMissing(cfg)) {
      return { ok: false, message: 'Paste an API key for this provider first.', ms: null }
    }
    const started = Date.now()
    try {
      await completeSql(
        cfg.provider,
        buildTestCompletionRequest(),
        AbortSignal.timeout(AI_TEST_TIMEOUT_MS),
        fetchPost,
        adaptiveOptsFor(modelKey(cfg.provider.baseUrl, cfg.provider.model))
      )
      const ms = Date.now() - started
      resetCompleteErrorCooldown()
      runtimeStats.lastError = null
      runtimeStats.lastSlow = false
      void refreshStatus()
      return { ok: true, message: '', ms }
    } catch (err) {
      const msg = explainFailure(
        err,
        hostOf(cfg.provider.baseUrl),
        AI_TEST_TIMEOUT_MS,
        cfg.provider.format
      )
      runtimeStats.lastError = scrubCredentialsInText(msg).slice(0, ERROR_TEXT_CHARS)
      runtimeStats.lastSlow = false
      void refreshStatus()
      return { ok: false, message: msg, ms: null }
    }
  })

  registerHandler('ai.models.list', async (input) => {
    const rawUrl = typeof input?.baseUrl === 'string' ? input.baseUrl.trim() : ''
    const baseCheck = validateAiBaseUrl(rawUrl)
    if (!baseCheck.ok) {
      return { ok: false, models: [], message: baseCheck.error }
    }
    const url = baseCheck.url
    const format = parseFormat(input?.format)
    const apiKey = await keyForListing(format, url, typeof input?.key === 'string' ? input.key.trim() : '')
    if (apiKey) {
      const keyCheck = validateAiBaseUrl(url, { hasApiKey: true })
      if (!keyCheck.ok) {
        return { ok: false, models: [], message: keyCheck.error }
      }
    }
    try {
      const models = await listModels(
        { format, baseUrl: url, apiKey },
        AbortSignal.timeout(AI_MODELS_TIMEOUT_MS),
        fetchGet
      )
      return { ok: true, models, message: '' }
    } catch (err) {
      return {
        ok: false,
        models: [],
        message: explainFailure(err, hostOf(url), AI_MODELS_TIMEOUT_MS, format),
      }
    }
  })

  registerHandler('ai.models.bench', async (input) => {
    const rawUrl = typeof input?.baseUrl === 'string' ? input.baseUrl.trim() : ''
    const baseCheck = validateAiBaseUrl(rawUrl)
    if (!baseCheck.ok) {
      return { results: [], message: baseCheck.error }
    }
    const url = baseCheck.url
    const format = parseFormat(input?.format)
    const apiKey = await keyForListing(format, url, typeof input?.key === 'string' ? input.key.trim() : '')
    if (apiKey) {
      const keyCheck = validateAiBaseUrl(url, { hasApiKey: true })
      if (!keyCheck.ok) {
        return { results: [], message: keyCheck.error }
      }
    }
    const ids = (Array.isArray(input?.models) ? input.models : [])
      .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      .slice(0, AI_BENCH_BATCH_SIZE)
    const req = buildTestCompletionRequest()
    const results = await Promise.all(
      ids.map(async (model) => {
        const provider: AiProviderConfig = {
          format,
          baseUrl: url,
          model,
          apiKey,
          maxTokens: AI_BENCH_MAX_TOKENS,
        }
        const started = Date.now()
        try {
          const suggestion = await completeSql(
            provider,
            req,
            AbortSignal.timeout(AI_BENCH_TIMEOUT_MS),
            fetchPost
          )
          return { model, ok: isExpectedSqlBenchAnswer(suggestion), ms: Date.now() - started }
        } catch {
          return { model, ok: false, ms: null }
        }
      })
    )
    return { results, message: '' }
  })

  registerHandler('ai.models.usage', async (input) => {
    const baseUrl = typeof input?.baseUrl === 'string' ? input.baseUrl : ''
    const prefix = `${hostOf(baseUrl)}|`
    const usage: Record<string, { ms: number; uses: number }> = {}
    for (const [k, samples] of Object.entries(await readUsage())) {
      if (k.startsWith(prefix) && samples.length > 0) {
        usage[k.slice(prefix.length)] = { ms: median(samples), uses: samples.length }
      }
    }
    return { usage }
  })

  registerHandler('ai.metrics.event', async (input) => {
    const id = Number(input?.id)
    const kind = input?.kind
    const model = suggestionModels.get(id)
    if (model && AI_EVENT_KINDS.includes(kind)) {
      updateStats((store) => bumpMetric(store, model, kind))
    }
    return {}
  })

  registerHandler('ai.stats.get', async () => {
    const cfg = await readConfig()
    const model = cfg.validProvider ? modelKey(cfg.provider.baseUrl, cfg.provider.model) : ''
    await statsQueue
    const stored = await orca.storage.get(AI_STATS_KEY)
    const store = isStatsStore(stored) ? stored : emptyStats(Date.now())
    return { model, since: store.since, summary: summarizeModelStats(store, model) }
  })

  registerHandler('ai.stats.reset', async () => {
    statsQueue = statsQueue.then(() => orca.storage.delete(AI_STATS_KEY)).catch(() => undefined)
    await statsQueue
    return {}
  })

  registerHandler('ai.complete', async (input, ctx) => {
    const empty = { suggestion: '', id: 0 }
    if (!input || typeof input.prefix !== 'string' || typeof input.suffix !== 'string') {
      return empty
    }
    const cfg = await readConfig()
    if (!cfg.enabled || !cfg.validProvider || isKeyMissing(cfg)) {
      return empty
    }

    const dialect: DatabaseDriverType = input.dialect || 'sqlite'
    if (hasSensitiveContent(input.prefix, input.suffix, '', dialect)) {
      return empty
    }
    const boundedPrefix = input.prefix.slice(-AI_RPC_MAX_PREFIX_CHARS)
    const boundedSuffix = input.suffix.slice(0, AI_RPC_MAX_SUFFIX_CHARS)
    const connId = typeof input.connectionId === 'string' ? input.connectionId : ''
    const activeSchema = typeof input.activeSchema === 'string' ? input.activeSchema : ''
    const activeTable = typeof input.activeTable === 'string' ? input.activeTable : ''
    const mKey = modelKey(cfg.provider.baseUrl, cfg.provider.model)
    const scopeKey = `${cfg.provider.baseUrl}|${cfg.provider.model}|${connId}|${dialect}|${activeSchema}|${activeTable}`
    const exactCacheKey = buildExactCacheKey(scopeKey, boundedPrefix, boundedSuffix)
    const cached = lookupCompletion(scopeKey, boundedPrefix, boundedSuffix, exactCacheKey)
    if (cached !== null) {
      return {
        suggestion: cached.suggestion,
        id: rememberSuggestion(mKey),
        ...(cached.replaceChars > 0 ? { replaceChars: cached.replaceChars } : {}),
      }
    }

    const isManual = input.manual === true
    if (!isManual && autoCooldownModelKey === mKey && Date.now() < autoCooldownUntil) {
      return empty
    }

    if (ctx?.signal?.aborted) {
      return empty
    }
    const panelId = ctx?.panel?.id || 'default'
    const flightKey = `${panelId}::${exactCacheKey}`
    const existingFlight = inFlightByPanelAndKey.get(flightKey)
    if (existingFlight && !existingFlight.controller.signal.aborted) {
      return await joinFlight(existingFlight, ctx?.signal)
    }

    inflightByPanel.get(panelId)?.abort()
    const controller = new AbortController()
    inflightByPanel.set(panelId, controller)

    const promise = (async (): Promise<CompletionResultPayload> => {
      const started = Date.now()
      try {
        const historyEntries = await getHistoryEntries()
        const snapshot = connId ? schemaCache.getSnapshot(connId) : null
        const knownIdentifiers =
          dialect === 'redis' || dialect === 'mongodb'
            ? undefined
            : collectKnownIdentifiers(snapshot, input.schemaMap)
        const typo = resolveTrailingTypoToken(boundedPrefix, dialect, knownIdentifiers)
        const sqlCtx = buildSqlCompletionContext({
          connectionId: connId || undefined,
          dialect,
          prefix: typo ? typo.healedPrefix : boundedPrefix,
          suffix: boundedSuffix,
          activeSchema: activeSchema || undefined,
          activeTable: activeTable || undefined,
          snapshot,
          schemaMap: input.schemaMap,
          historyEntries,
        })

        const signals = [controller.signal, AbortSignal.timeout(AI_COMPLETE_TIMEOUT_MS)]
        const completed = await completeSqlWithMeta(
          cfg.provider,
          {
            dialect,
            system: sqlCtx.system,
            user: sqlCtx.user,
            prefix: boundedPrefix,
            suffix: boundedSuffix,
            fimPrefix: sqlCtx.fimPrefix,
            fimSuffix: sqlCtx.fimSuffix,
            multiline: sqlCtx.multiline,
            knownIdentifiers,
          },
          AbortSignal.any(signals),
          fetchPost,
          adaptiveOptsFor(mKey)
        )
        const { suggestion, replaceChars } = completed

        const elapsed = Date.now() - started
        resetCompleteErrorCooldown()
        runtimeStats.lastMs = elapsed
        runtimeStats.lastError = null
        runtimeStats.lastSlow = false
        void recordUsage(cfg.provider.baseUrl, cfg.provider.model, elapsed).catch(() => undefined)
        if (!suggestion) {
          void refreshStatus()
          return empty
        }

        runtimeStats.suggested += 1
        updateStats((store) => recordMetricLatency(store, mKey, elapsed))
        void refreshStatus()

        rememberCompletion({
          exactKey: exactCacheKey,
          scopeKey,
          rawPrefix: boundedPrefix,
          rawSuffix: boundedSuffix,
          suggestion,
          replaceChars,
        })
        return {
          suggestion,
          id: rememberSuggestion(mKey),
          ...(replaceChars > 0 ? { replaceChars } : {}),
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'TimeoutError') {
          noteCompleteError(mKey)
          runtimeStats.lastSlow = true
          void recordUsage(cfg.provider.baseUrl, cfg.provider.model, AI_COMPLETE_TIMEOUT_MS).catch(() => undefined)
          updateStats((store) => recordMetricLatency(store, mKey, AI_COMPLETE_TIMEOUT_MS))
          void refreshStatus()
        } else if (controller.signal.aborted) {
          updateStats((store) => bumpMetric(store, mKey, 'stale'))
        } else {
          noteCompleteError(mKey)
          const msg = explainFailure(
            err,
            hostOf(cfg.provider.baseUrl),
            AI_COMPLETE_TIMEOUT_MS,
            cfg.provider.format
          )
          logFailure(msg)
          runtimeStats.lastError = scrubCredentialsInText(msg).slice(0, ERROR_TEXT_CHARS)
          runtimeStats.lastSlow = false
          void refreshStatus()
        }
        return empty
      }
    })()

    const flight: CompletionFlight = { promise, controller, waiters: 0 }
    inFlightByPanelAndKey.set(flightKey, flight)
    const cleanup = () => {
      if (inFlightByPanelAndKey.get(flightKey) === flight) {
        inFlightByPanelAndKey.delete(flightKey)
      }
      if (inflightByPanel.get(panelId) === controller) {
        inflightByPanel.delete(panelId)
      }
    }
    void promise.then(cleanup, cleanup)
    return await joinFlight(flight, ctx?.signal)
  })

  async function enrichTableDetailsForRefs(
    connId: string,
    dialect: DatabaseDriverType,
    refs: readonly string[],
    activeSchema?: string
  ): Promise<void> {
    if (!connId || dialect === 'redis' || refs.length === 0) return
    const existingSnap = schemaCache.getSnapshot(connId)
    const missing = refs.slice(0, 8).filter((name) => {
      const lower = name.toLowerCase()
      const bare =
        dialect !== 'mongodb' && lower.includes('.') ? lower.split('.').pop() || lower : lower
      const qualified =
        dialect !== 'mongodb' && activeSchema && !lower.includes('.')
          ? `${activeSchema.toLowerCase()}.${lower}`
          : ''
      return (
        !existingSnap?.details.has(lower) &&
        !existingSnap?.details.has(bare) &&
        (!qualified || !existingSnap?.details.has(qualified))
      )
    })
    if (missing.length === 0) return
    try {
      const session = await sessionManager.getSession(connId)
      await Promise.allSettled(
        missing.map(async (refName) => {
          const parts = dialect !== 'mongodb' ? refName.split('.') : [refName]
          const schema =
            parts.length > 1
              ? parts[0]
              : dialect !== 'mongodb' && activeSchema
                ? activeSchema
                : undefined
          const table = parts.length > 1 ? parts[1] : parts[0]
          const det = await session.getTableDetails(table, schema)
          if (det) schemaCache.setTableDetails(connId, det)
        })
      )
    } catch {
      // Best-effort schema enrichment; AI request proceeds without blocking
    }
  }

  registerHandler('ai.explainAnalyze', async (input, ctx): Promise<AiExplainAnalysisResult> => {
    if (!input?.sql || typeof input.sql !== 'string') {
      throw createHostError('invalid_params', 'SQL string is required for EXPLAIN analysis.')
    }
    const cfg = await readConfig()
    if (!cfg.enabled) {
      throw createHostError('not_permitted', 'Enable AI SQL Assistant in AI settings first.')
    }
    if (!cfg.validProvider || isKeyMissing(cfg)) {
      throw createHostError('invalid_params', 'Configure an AI provider, model, and API key first.')
    }

    const panelId = ctx?.panel?.id || 'default'
    inflightExplainByPanel.get(panelId)?.abort()
    const controller = new AbortController()
    inflightExplainByPanel.set(panelId, controller)

    const connId = typeof input.connectionId === 'string' ? input.connectionId : ''
    const dialect: DatabaseDriverType = input.dialect || 'sqlite'

    try {
      const refs =
        dialect === 'redis'
          ? []
          : dialect === 'mongodb'
            ? extractReferencedMongoCollections(input.sql)
            : extractReferencedTables(input.sql, dialect)
      await enrichTableDetailsForRefs(connId, dialect, refs)

      const { system, user, resolvedLanguage } = buildExplainAnalysisPrompt({
        dialect,
        sql: input.sql,
        planColumns: Array.isArray(input.planColumns) ? input.planColumns : [],
        planRows: Array.isArray(input.planRows) ? input.planRows : [],
        snapshot: connId ? schemaCache.getSnapshot(connId) : null,
        language: input.language ?? cfg.explainLanguage,
        uiLocale: input.uiLocale,
      })

      const signals = [controller.signal, AbortSignal.timeout(AI_EXPLAIN_TIMEOUT_MS)]
      if (ctx?.signal) signals.push(ctx.signal)

      const started = Date.now()
      const raw = await completeChat(
        cfg.provider,
        system,
        user,
        cfg.explainMaxTokens,
        AbortSignal.any(signals),
        fetchPost,
        dialect
      )
      return parseExplainAnalysis(raw, resolvedLanguage.label, Date.now() - started)
    } catch (err) {
      if (controller.signal.aborted || ctx?.signal?.aborted) {
        throw createHostError('cancelled', 'EXPLAIN analysis cancelled.')
      }
      throw createHostError(
        'action_failed',
        explainFailure(err, hostOf(cfg.provider.baseUrl), AI_EXPLAIN_TIMEOUT_MS, cfg.provider.format)
      )
    } finally {
      if (inflightExplainByPanel.get(panelId) === controller) {
        inflightExplainByPanel.delete(panelId)
      }
    }
  })

  registerHandler('ai.fixQuery', async (input, ctx): Promise<AiFixQueryResult> => {
    const sql = typeof input?.sql === 'string' ? input.sql.trim() : ''
    if (!sql) {
      throw createHostError('invalid_params', 'SQL query is required for AI query fix.')
    }
    const rawErrorMessage = typeof input?.errorMessage === 'string' ? input.errorMessage.trim() : ''
    if (!rawErrorMessage) {
      throw createHostError('invalid_params', 'Error message is required for AI query fix.')
    }

    const cfg = await readConfig()
    if (!cfg.enabled) {
      throw createHostError('not_permitted', 'Enable AI SQL Assistant in AI settings first.')
    }
    if (!cfg.validProvider || isKeyMissing(cfg)) {
      throw createHostError('invalid_params', 'Configure an AI provider, model, and API key first.')
    }

    const dialect: DatabaseDriverType = input.dialect || 'sqlite'
    if (
      hasSensitiveContent(input.sql, '', '', dialect) ||
      hasSensitiveContent(input.errorMessage, '', '', dialect)
    ) {
      throw createHostError(
        'invalid_params',
        'Query or error message appears to contain sensitive credentials/secrets and was not sent to AI.'
      )
    }

    const panelId = ctx?.panel?.id || 'default'
    inflightFixByPanel.get(panelId)?.abort()
    const controller = new AbortController()
    inflightFixByPanel.set(panelId, controller)

    const connId = typeof input.connectionId === 'string' ? input.connectionId : ''
    const activeSchema = typeof input.activeSchema === 'string' ? input.activeSchema.trim() : ''
    const activeTable = typeof input.activeTable === 'string' ? input.activeTable.trim() : ''

    try {
      const referencedTables =
        dialect === 'redis'
          ? []
          : dialect === 'mongodb'
            ? extractReferencedMongoCollections(input.sql)
            : extractReferencedTables(input.sql, dialect)
      const enrichRefs =
        referencedTables.length > 0
          ? referencedTables
          : activeTable
            ? [activeSchema && dialect !== 'mongodb' ? `${activeSchema}.${activeTable}` : activeTable]
            : []
      await enrichTableDetailsForRefs(connId, dialect, enrichRefs, activeSchema || undefined)

      const schemaBlock =
        dialect === 'redis'
          ? ''
          : buildPrunedSchemaBlock(
              connId ? schemaCache.getSnapshot(connId) : null,
              input.schemaMap,
              referencedTables,
              activeSchema || undefined,
              activeTable || undefined,
              MAX_FIX_QUERY_SCHEMA_CHARS
            )

      const safeErrorMessage = scrubCredentialsInText(rawErrorMessage)
      const { system, user, resolvedLanguage } = buildFixQueryPrompt({
        dialect,
        sql: input.sql,
        errorMessage: safeErrorMessage,
        schemaBlock,
        language: input.language ?? cfg.explainLanguage,
        uiLocale: input.uiLocale,
      })

      const signals = [controller.signal, AbortSignal.timeout(AI_EXPLAIN_TIMEOUT_MS)]
      if (ctx?.signal) signals.push(ctx.signal)

      const started = Date.now()
      const maxTokens = Math.max(2048, Math.min(cfg.explainMaxTokens, 8192))
      const raw = await completeChat(
        cfg.provider,
        system,
        user,
        maxTokens,
        AbortSignal.any(signals),
        fetchPost,
        dialect
      )
      const durationMs = Date.now() - started
      const result = parseFixQueryResult(raw, {
        model: cfg.provider.model,
        durationMs,
        language: resolvedLanguage.label,
      })

      resetCompleteErrorCooldown()
      runtimeStats.lastMs = durationMs
      runtimeStats.lastError = null
      runtimeStats.lastSlow = false
      void recordUsage(cfg.provider.baseUrl, cfg.provider.model, durationMs).catch(() => undefined)
      void refreshStatus()

      return sanitizeJsonPayload(result)
    } catch (err) {
      if (controller.signal.aborted || ctx?.signal?.aborted) {
        throw createHostError('cancelled', 'AI query fix cancelled.')
      }
      const msg = explainFailure(
        err,
        hostOf(cfg.provider.baseUrl),
        AI_EXPLAIN_TIMEOUT_MS,
        cfg.provider.format
      )
      const safeMsg = scrubCredentialsInText(msg)
      logFailure(safeMsg)
      throw createHostError('action_failed', safeMsg)
    } finally {
      if (inflightFixByPanel.get(panelId) === controller) {
        inflightFixByPanel.delete(panelId)
      }
    }
  })

  async function pinExistingKey(): Promise<void> {
    try {
      const pinned = await orca.storage.get(AI_KEY_ADDRESS_STORAGE)
      if ((await orca.secrets.get(AI_SECRET_KEY)) && (pinned === null || pinned === '')) {
        const url = String((await orca.settings.get('aiBaseUrl')) ?? 'https://api.openai.com/v1').trim()
        const checked = validateAiBaseUrl(url, { hasApiKey: true })
        if (checked.ok) {
          await orca.storage.set(AI_KEY_ADDRESS_STORAGE, checked.url)
        }
      }
    } catch {
      // Ignore startup pinning failure in minimal mocks
    }
  }

  const settingsSub = orca.settings.onDidChange((change) => {
    if (!change?.key || change.key.startsWith('ai')) {
      if (change?.key !== 'aiExplainLanguage' && change?.key !== 'aiExplainMaxTokens') {
        completionCache.clear()
      }
      resetCompleteErrorCooldown()
      runtimeStats.lastError = null
      runtimeStats.lastSlow = false
      void refreshStatus()
    }
  })

  const pinReady = pinExistingKey()

  return {
    invalidateHistoryCache: () => {
      historyCache = null
    },
    dispose: () => {
      settingsSub.dispose()
      for (const ctrl of inflightByPanel.values()) ctrl.abort()
      for (const ctrl of inflightExplainByPanel.values()) ctrl.abort()
      for (const ctrl of inflightFixByPanel.values()) ctrl.abort()
      inflightByPanel.clear()
      inFlightByPanelAndKey.clear()
      inflightExplainByPanel.clear()
      inflightFixByPanel.clear()
      reasoningModels.clear()
      effortUnsupportedModels.clear()
    },
  }
}
