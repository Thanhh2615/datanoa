import { createHash } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  sanitizeJsonPayload,
  type AiExplainAnalysisResult,
  type AiFixQueryResult,
  type AiInlineEdit,
  type AiRole,
  type AiStatusSnapshot,
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
  completeSqlStatementEdit,
  completeSqlWithMeta,
  emptyStats,
  explainFailure,
  hasSensitiveContent,
  hostOf,
  isChatIncompatibleBaseModel,
  isExpectedSqlBenchAnswer,
  isFimOnlyModel,
  isLoopbackHost,
  isStatsStore,
  listModels,
  median,
  parseFormat,
  recordMetricLatency,
  resolveTrailingTypoToken,
  summarizeModelStats,
  validateAiBaseUrl,
  type AiProviderConfig,
  type AiStatsStore,
  type FetchGetLike,
  type FetchPostLike,
} from './ai-client'
import {
  AiConfigStore,
  buildDualStatusSnapshot,
  isRoleKeyMissing,
  isRoleReady,
  parseAiRole,
  type AiRoleRuntimeHealth,
  type ResolvedAiRoleConfig,
  type ResolvedDualAiConfig,
} from './ai-config-store'
import {
  MAX_FIX_QUERY_SCHEMA_CHARS,
  WorkerSchemaMetadataCache,
  buildExplainAnalysisPrompt,
  buildFixQueryPrompt,
  buildPrunedSchemaBlock,
  buildSqlCompletionContext,
  buildSqlStatementEditContext,
  collectPartialTableMatches,
  countFixQueryStatements,
  extractReferencedMongoCollections,
  extractReferencedTables,
  extractTrailingPartialTableName,
  parseExplainAnalysis,
  parseFixQueryResult,
  type HistoryBudgetOptions,
  type SchemaContextBudget,
  type WorkerSchemaSnapshot,
} from './ai-sql-context'
import { isolateActiveSqlStatement } from '../shared-sql-core.js'
import type { SessionManager } from './session-manager'
import {
  computeFilteredStatementEdits,
  decideCompletionTier,
  extractActiveStatementWindow,
  extractRewriteTagContent,
  shadowHealStatementForSchema,
} from './ai-nep'
import {
  QUERY_HISTORY_STORAGE_KEY,
  createHostError,
  scrubCredentialsInText,
  type WorkerRegisterHandler,
} from './worker-utils'

const AI_USAGE_KEY = 'datanoa.ai.usage'
const AI_STATS_KEY = 'datanoa.ai.stats'

const SAFE_MIDLINE_SUFFIX_BOUNDARY_RE =
  /^(?:$|[\r\n]|[\s]*[)\]},;'"`]|[\s]*(?:FROM|WHERE|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|NATURAL|ON|USING|AND|OR|GROUP|ORDER|HAVING|LIMIT|OFFSET|UNION|INTERSECT|EXCEPT|THEN|ELSE|END|AS|SET|VALUES|INTO|RETURNING)\b)/i

function isLoopbackBaseUrl(baseUrl: string): boolean {
  return isLoopbackHost(hostOf(baseUrl))
}

function isMidLineBeforeExistingExpression(suffix: string): boolean {
  const nl = suffix.indexOf('\n')
  const sameLine = nl === -1 ? suffix : suffix.slice(0, nl)
  if (!sameLine.trim()) return false
  return !SAFE_MIDLINE_SUFFIX_BOUNDARY_RE.test(sameLine)
}

const CACHE_SIZE = 64
const USAGE_SAMPLES = 9
const USAGE_MODELS = 40
const SUGGESTION_IDS_KEPT = 200
const ERROR_TEXT_CHARS = 160
const LOG_REPEAT_MS = 60_000
const AUTO_ERROR_COOLDOWN_THRESHOLD = 2
const AUTO_ERROR_COOLDOWN_MS = 8_000
const COMPLETE_ENRICH_TIMEOUT_MS = 400
const MAX_COMPLETE_ENRICH_REFS = 4
const ENRICH_MISS_TTL_MS = 30_000
const MAX_ENRICH_MISS_ENTRIES = 128
const LOCAL_SCHEMA_BUDGET: SchemaContextBudget = {
  maxChars: 6000,
  compactTier3WhenReferenced: true,
  maxTier3Chars: 1280,
}
const LOCAL_HISTORY_BUDGET: Readonly<HistoryBudgetOptions> = {
  maxItems: 2,
  maxChars: 360,
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

function normalizeStreamPartial(raw: string): string {
  if (!raw) return ''
  let text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
  const completionOpen = /<COMPLETION>/i.exec(text)
  if (completionOpen) {
    text = text.slice(completionOpen.index + completionOpen[0].length)
  }
  const completionClose = /<\/COMPLETION>/i.exec(text)
  if (completionClose) {
    text = text.slice(0, completionClose.index)
  }
  const fenceOpen = /^\s*```[^\n]*\r?\n([\s\S]*)$/.exec(text)
  if (fenceOpen) {
    text = fenceOpen[1]
  }
  return text
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
  edits?: AiInlineEdit[]
  mode?: 'complete' | 'edit'
}

interface CompletionResultPayload {
  suggestion: string
  id: number
  replaceChars?: number
  edits?: AiInlineEdit[]
  mode?: 'complete' | 'edit'
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
    scopeKey: string
    rawPrefix: string
    rawSuffix: string
    partialText: string
    mode: 'complete' | 'edit'
  }
  const inflightByPanel = new Map<string, AbortController>()
  const activeFlightByPanel = new Map<string, CompletionFlight>()
  const inFlightByPanelAndKey = new Map<string, CompletionFlight>()
  const inflightExplainByPanel = new Map<string, AbortController>()
  const inflightFixByPanel = new Map<string, AbortController>()
  const suggestionModels = new Map<number, string>()
  const reasoningModels = new Set<string>()
  const effortUnsupportedModels = new Set<string>()
  const temperatureUnsupportedModels = new Set<string>()
  const enrichMissCache = new Map<string, { at: number; revision: number }>()
  let lastSuggestionId = 0

  function buildEnrichMissKey(
    connId: string,
    dialect: DatabaseDriverType,
    refName: string,
    activeSchema?: string
  ): string {
    const parts = dialect !== 'mongodb' ? refName.split('.') : [refName]
    const schema = (
      parts.length > 1
        ? parts[0]
        : dialect !== 'mongodb' && activeSchema
          ? activeSchema
          : ''
    )
      .trim()
      .toLowerCase()
    const table = (parts.length > 1 ? parts[1] : parts[0]).trim().toLowerCase()
    return `${connId}\0${dialect}\0${schema}\0${table}`
  }

  function isFreshEnrichMiss(key: string, revision: number, now: number): boolean {
    const entry = enrichMissCache.get(key)
    if (entry === undefined) return false
    if (entry.revision !== revision || now < entry.at || now - entry.at >= ENRICH_MISS_TTL_MS) {
      enrichMissCache.delete(key)
      return false
    }
    return true
  }

  function recordEnrichMiss(key: string, revision: number, now: number): void {
    enrichMissCache.delete(key)
    enrichMissCache.set(key, { at: now, revision })
    while (enrichMissCache.size > MAX_ENRICH_MISS_ENTRIES) {
      const oldest = enrichMissCache.keys().next().value
      if (oldest === undefined) break
      enrichMissCache.delete(oldest)
    }
  }

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
      skipTemperature: temperatureUnsupportedModels.has(key),
      isTemperatureUnsupported: () => temperatureUnsupportedModels.has(key),
      markTemperatureUnsupported: () => rememberBoundedKey(temperatureUnsupportedModels, key),
      onTemperatureRejected: () => rememberBoundedKey(temperatureUnsupportedModels, key),
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
  ): { suggestion: string; replaceChars: number; edits?: AiInlineEdit[]; mode?: 'complete' | 'edit' } | null {
    const exact = completionCache.get(exactKey)
    if (exact) {
      rememberCompletion(exact)
      return {
        suggestion: exact.suggestion,
        replaceChars: exact.replaceChars,
        ...(exact.edits ? { edits: exact.edits } : {}),
        ...(exact.mode ? { mode: exact.mode } : {}),
      }
    }
    let best: CompletionCacheEntry | null = null
    for (const entry of completionCache.values()) {
      if (entry.replaceChars > 0 || (entry.edits && entry.edits.length > 0)) continue
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
      if (entry.replaceChars > 0 || (entry.edits && entry.edits.length > 0)) continue
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
    let onAbort: (() => void) | undefined
    const aborted = new Promise<CompletionResultPayload>((resolve) => {
      onAbort = () => {
        leave(true)
        resolve({ suggestion: '', id: 0 })
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const raced = Promise.race([settled, aborted])
    const detachAbort = () => {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
    void raced.then(detachAbort, detachAbort)
    return raced
  }

  const configStore = new AiConfigStore({ orca, sessionManager })
  const roleRuntime: Record<AiRole, AiRoleRuntimeHealth> = {
    autocomplete: { lastMs: null, lastError: null, lastSlow: false },
    explain: { lastMs: null, lastError: null, lastSlow: false },
  }
  let settingsChangeSeq = 0
  const pendingRoleHealthSeq: Record<AiRole, number> = { autocomplete: 0, explain: 0 }
  const reconciledRoleSeq: Record<AiRole, number> = { autocomplete: 0, explain: 0 }
  const lastRoleHealthSig: Record<AiRole, string | null> = { autocomplete: null, explain: null }
  let lastExplainUsingSharedKey = false

  function roleHealthSignature(roleCfg: ResolvedAiRoleConfig): string {
    const keyDigest = roleCfg.provider.apiKey
      ? createHash('sha256').update(roleCfg.provider.apiKey).digest('hex')
      : ''
    return JSON.stringify([
      roleCfg.enabled,
      roleCfg.validProvider,
      roleCfg.provider.format,
      roleCfg.provider.baseUrl,
      roleCfg.provider.model,
      roleCfg.hasKey,
      keyDigest,
    ])
  }

  function clearRoleRuntimeHealth(role: AiRole): void {
    roleRuntime[role].lastError = null
    roleRuntime[role].lastSlow = false
    lastRoleHealthSig[role] = null
  }
  let suggestedCount = 0
  let latestLastMs: number | null = null
  let lastKnownSync = true
  let lastAutoIsFimOnly = false
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

  function roleProviderSignature(roleCfg: ResolvedAiRoleConfig): string {
    const keyDigest = roleCfg.provider.apiKey
      ? createHash('sha256').update(roleCfg.provider.apiKey).digest('hex')
      : ''
    return JSON.stringify([
      roleCfg.validProvider,
      roleCfg.provider.format,
      roleCfg.provider.baseUrl,
      roleCfg.provider.model,
      roleCfg.hasKey,
      keyDigest,
    ])
  }

  async function readConfig(): Promise<ResolvedDualAiConfig> {
    const snapChangeSeq = settingsChangeSeq
    const seqBeforeRead = {
      autocomplete: pendingRoleHealthSeq.autocomplete,
      explain: pendingRoleHealthSeq.explain,
    }
    const cfg = await configStore.readConfig()
    lastKnownSync = cfg.sync
    lastExplainUsingSharedKey = cfg.explain.usingSharedKey
    lastAutoIsFimOnly = isFimOnlyModel(
      cfg.autocomplete.provider.format,
      cfg.autocomplete.provider.model
    )
    if (snapChangeSeq === settingsChangeSeq) {
      const changedRoles: Record<AiRole, boolean> = { autocomplete: false, explain: false }
      for (const role of ['autocomplete', 'explain'] as const) {
        const sig = roleHealthSignature(cfg[role])
        if (seqBeforeRead[role] > reconciledRoleSeq[role]) {
          reconciledRoleSeq[role] = seqBeforeRead[role]
          if (lastRoleHealthSig[role] !== null && sig !== lastRoleHealthSig[role]) {
            changedRoles[role] = true
            roleRuntime[role].lastError = null
            roleRuntime[role].lastSlow = false
          }
        }
        lastRoleHealthSig[role] = sig
      }
      if (
        cfg.sync &&
        cfg.autocomplete.enabled &&
        cfg.explain.enabled &&
        roleProviderSignature(cfg.autocomplete) === roleProviderSignature(cfg.explain)
      ) {
        if (changedRoles.explain && !changedRoles.autocomplete && roleRuntime.autocomplete.lastError) {
          roleRuntime.explain.lastError = roleRuntime.autocomplete.lastError
          roleRuntime.explain.lastSlow = roleRuntime.autocomplete.lastSlow
        } else if (changedRoles.autocomplete && !changedRoles.explain && roleRuntime.explain.lastError) {
          roleRuntime.autocomplete.lastError = roleRuntime.explain.lastError
          roleRuntime.autocomplete.lastSlow = roleRuntime.explain.lastSlow
        }
      }
    }
    return cfg
  }

  async function buildStatusSnapshot(known?: ResolvedDualAiConfig): Promise<AiStatusSnapshot> {
    const cfg = known ?? (await readConfig())
    return buildDualStatusSnapshot(cfg, {
      autocomplete: roleRuntime.autocomplete,
      explain: roleRuntime.explain,
      suggested: suggestedCount,
      latestLastMs,
    })
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

  function buildTestExplainChatRequest() {
    return {
      system: 'You are a SQL assistant. Reply with one concise sentence.',
      user: 'Briefly explain: SELECT id, name FROM users WHERE id = 1;',
      maxTokens: 64,
    }
  }

  registerHandler('ai.status.get', async () => await buildStatusSnapshot())

  registerHandler('ai.key.set', async (input) => {
    const res = await configStore.setKey(input)
    if (res.role === 'autocomplete') {
      completionCache.clear()
      resetCompleteErrorCooldown()
      clearRoleRuntimeHealth('autocomplete')
      if (lastKnownSync || lastExplainUsingSharedKey) {
        clearRoleRuntimeHealth('explain')
      }
    } else {
      if (lastAutoIsFimOnly && !lastKnownSync) {
        completionCache.clear()
      }
      clearRoleRuntimeHealth('explain')
      if (lastKnownSync) {
        completionCache.clear()
        resetCompleteErrorCooldown()
        clearRoleRuntimeHealth('autocomplete')
      }
    }
    void refreshStatus()
    return input?.role !== undefined ? { hasKey: res.hasKey, role: res.role } : { hasKey: res.hasKey }
  })

  registerHandler('ai.provider.test', async (input) => {
    const role = parseAiRole(input?.role)
    const cfg = await readConfig()
    const roleCfg = role === 'explain' ? cfg.explain : cfg.autocomplete
    const runtime = roleRuntime[role]
    if (!roleCfg.validProvider) {
      return { ok: false, message: 'Set a valid http(s) Base URL and model name.', ms: null, role }
    }
    if (isRoleKeyMissing(roleCfg)) {
      return { ok: false, message: 'Paste an API key for this provider first.', ms: null, role }
    }
    if (role === 'explain' && isChatIncompatibleBaseModel(roleCfg.provider.model)) {
      return {
        ok: false,
        message: `Model "${roleCfg.provider.model}" is a Fill-in-the-Middle (FIM) autocomplete model and cannot run chat-based EXPLAIN analysis or SQL fixes. Turn off Sync both and select a chat/instruct model for Explain & Fix.`,
        ms: null,
        role,
      }
    }
    const started = Date.now()
    try {
      if (role === 'explain') {
        const chatReq = buildTestExplainChatRequest()
        await completeChat(
          roleCfg.provider,
          chatReq.system,
          chatReq.user,
          chatReq.maxTokens,
          AbortSignal.timeout(AI_TEST_TIMEOUT_MS),
          fetchPost,
          'sqlite'
        )
      } else {
        await completeSql(
          roleCfg.provider,
          buildTestCompletionRequest(),
          AbortSignal.timeout(AI_TEST_TIMEOUT_MS),
          fetchPost,
          adaptiveOptsFor(modelKey(roleCfg.provider.baseUrl, roleCfg.provider.model))
        )
        resetCompleteErrorCooldown()
      }
      const ms = Date.now() - started
      runtime.lastError = null
      runtime.lastSlow = false
      void refreshStatus()
      return { ok: true, message: '', ms, role }
    } catch (err) {
      const msg = explainFailure(
        err,
        hostOf(roleCfg.provider.baseUrl),
        AI_TEST_TIMEOUT_MS,
        roleCfg.provider.format
      )
      runtime.lastError = scrubCredentialsInText(msg).slice(0, ERROR_TEXT_CHARS)
      runtime.lastSlow = false
      void refreshStatus()
      return { ok: false, message: msg, ms: null, role }
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
    const apiKey = await configStore.keyForListing(
      format,
      url,
      typeof input?.key === 'string' ? input.key.trim() : '',
      input?.role
    )
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
    const apiKey = await configStore.keyForListing(
      format,
      url,
      typeof input?.key === 'string' ? input.key.trim() : '',
      input?.role
    )
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
    const auto = cfg.autocomplete
    const model = auto.validProvider ? modelKey(auto.provider.baseUrl, auto.provider.model) : ''
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
    const auto = cfg.autocomplete
    if (!isRoleReady(auto)) {
      return empty
    }

    const dialect: DatabaseDriverType = input.dialect || 'sqlite'
    const boundedPrefix = input.prefix.slice(-AI_RPC_MAX_PREFIX_CHARS)
    const boundedSuffix = input.suffix.slice(0, AI_RPC_MAX_SUFFIX_CHARS)
    const connId = typeof input.connectionId === 'string' ? input.connectionId : ''
    const activeSchema = typeof input.activeSchema === 'string' ? input.activeSchema : ''
    const activeTable = typeof input.activeTable === 'string' ? input.activeTable : ''
    const requestedMode: 'auto' | 'complete' | 'edit' =
      input.mode === 'edit' ? 'edit' : input.mode === 'complete' ? 'complete' : 'auto'
    const isManual = input.manual === true

    const isolated = isolateActiveSqlStatement(boundedPrefix, boundedSuffix, dialect)
    if (hasSensitiveContent(isolated.stmtPrefix, isolated.stmtSuffix, '', dialect)) {
      return empty
    }
    const activeWindow = extractActiveStatementWindow(boundedPrefix, boundedSuffix, dialect, {
      allowPrecedingOnFreshLine: requestedMode === 'edit',
    })
    if (activeWindow && hasSensitiveContent(activeWindow.text, '', '', dialect)) {
      return empty
    }

    const targetingPrecedingErrored = Boolean(
      activeWindow && isolated.isFreshStatementAfterSemicolon && requestedMode === 'edit'
    )
    const cachePrefixKey =
      targetingPrecedingErrored && activeWindow
        ? `${activeWindow.text}@${activeWindow.cursorOffsetInSpan}`
        : isolated.stmtPrefix
    const cacheSuffixKey = targetingPrecedingErrored ? '' : isolated.stmtSuffix

    const autoFimOnly = isFimOnlyModel(auto.provider.format, auto.provider.model)
    const crossesLocalToRemote =
      isLoopbackBaseUrl(auto.provider.baseUrl) && !isLoopbackBaseUrl(cfg.explain.provider.baseUrl)
    const canRouteEditToExplain =
      !cfg.sync &&
      autoFimOnly &&
      isRoleReady(cfg.explain) &&
      !isFimOnlyModel(cfg.explain.provider.format, cfg.explain.provider.model) &&
      (!crossesLocalToRemote || isManual)
    const editScopeTag = canRouteEditToExplain
      ? `|edit:${cfg.explain.provider.baseUrl}|${cfg.explain.provider.model}`
      : autoFimOnly
        ? '|fim-only'
        : ''

    const mKey = modelKey(auto.provider.baseUrl, auto.provider.model)
    const scopeKey = `${auto.provider.baseUrl}|${auto.provider.model}${editScopeTag}|${connId}|${dialect}|${activeSchema}|${activeTable}|${requestedMode}`
    const exactCacheKey = buildExactCacheKey(scopeKey, cachePrefixKey, cacheSuffixKey)
    const cached = lookupCompletion(scopeKey, cachePrefixKey, cacheSuffixKey, exactCacheKey)
    if (cached !== null) {
      if (
        !isManual &&
        cached.mode !== 'edit' &&
        !(cached.edits && cached.edits.length > 0) &&
        dialect !== 'redis' &&
        dialect !== 'mongodb' &&
        isMidLineBeforeExistingExpression(isolated.stmtSuffix)
      ) {
        return empty
      }
      return {
        suggestion: cached.suggestion,
        id: rememberSuggestion(mKey),
        ...(cached.replaceChars > 0 ? { replaceChars: cached.replaceChars } : {}),
        ...(cached.edits && cached.edits.length > 0 ? { edits: cached.edits } : {}),
        ...(cached.mode ? { mode: cached.mode } : {}),
      }
    }

    if (!isManual && autoCooldownModelKey === mKey && Date.now() < autoCooldownUntil) {
      return empty
    }

    if (ctx?.signal?.aborted) {
      return empty
    }
    const snapshot = connId ? schemaCache.getSnapshot(connId) : null
    const shadowHeal = activeWindow
      ? shadowHealStatementForSchema(activeWindow, dialect, snapshot, input.schemaMap, activeSchema || undefined)
      : null
    let resolvedTier = decideCompletionTier({
      dialect,
      prefix: targetingPrecedingErrored && activeWindow ? activeWindow.text : isolated.stmtPrefix,
      stmt: activeWindow,
      heal: shadowHeal,
      requestedMode,
      manual: isManual,
    })

    let editProvider: AiProviderConfig = auto.provider
    let editRoutedToExplain = false
    if (resolvedTier === 'edit' && autoFimOnly) {
      if (canRouteEditToExplain) {
        editProvider = cfg.explain.provider
        editRoutedToExplain = true
      } else {
        resolvedTier = 'complete'
      }
    }

    if ((isolated.cursorAfterSemicolon || targetingPrecedingErrored) && resolvedTier === 'complete') {
      return empty
    }
    const prevCh = isolated.stmtPrefix.slice(-1)
    const nextCh = isolated.stmtSuffix.slice(0, 1)
    if (
      resolvedTier === 'complete' &&
      !isManual &&
      /[A-Za-z0-9_]/.test(prevCh) &&
      /[A-Za-z0-9_]/.test(nextCh)
    ) {
      return empty
    }
    if (
      resolvedTier === 'complete' &&
      !isManual &&
      dialect !== 'redis' &&
      dialect !== 'mongodb' &&
      isMidLineBeforeExistingExpression(isolated.stmtSuffix)
    ) {
      return empty
    }

    const panelId = ctx?.panel?.id || 'default'
    const flightKey = `${panelId}::${exactCacheKey}`
    const existingFlight = inFlightByPanelAndKey.get(flightKey)
    if (existingFlight && !existingFlight.controller.signal.aborted) {
      return await joinFlight(existingFlight, ctx?.signal)
    }

    const activeFlight = activeFlightByPanel.get(panelId)
    if (
      activeFlight &&
      !activeFlight.controller.signal.aborted &&
      activeFlight.mode === 'complete' &&
      resolvedTier === 'complete' &&
      activeFlight.scopeKey === scopeKey &&
      activeFlight.rawSuffix === cacheSuffixKey &&
      cachePrefixKey.startsWith(activeFlight.rawPrefix)
    ) {
      const delta = cachePrefixKey.slice(activeFlight.rawPrefix.length)
      const partial = normalizeStreamPartial(activeFlight.partialText)
      const canReuse =
        delta.length > 0 &&
        ((partial && partial.startsWith(delta)) ||
          (!partial && delta.length <= 3 && !delta.includes('\n')))
      if (canReuse) {
        const reused = await joinFlight(activeFlight, ctx?.signal)
        if (ctx?.signal?.aborted) {
          return empty
        }
        if (
          reused.suggestion &&
          !(reused.replaceChars && reused.replaceChars > 0) &&
          !(reused.edits && reused.edits.length > 0) &&
          reused.suggestion.startsWith(delta)
        ) {
          const remainderText = reused.suggestion.slice(delta.length)
          if (remainderText) {
            return { suggestion: remainderText, id: rememberSuggestion(mKey) }
          }
        }
      }
    }

    inflightByPanel.get(panelId)?.abort()
    const controller = new AbortController()
    inflightByPanel.set(panelId, controller)
    let flightRef: CompletionFlight | null = null

    const activeProvider = resolvedTier === 'edit' ? editProvider : auto.provider
    const activeModelKey = modelKey(activeProvider.baseUrl, activeProvider.model)
    const activeHealthRole: AiRole =
      resolvedTier === 'edit' && editRoutedToExplain ? 'explain' : 'autocomplete'

    const promise = (async (): Promise<CompletionResultPayload> => {
      const started = Date.now()
      try {
        const uncachedRefs = collectUncachedRefsForComplete(
          connId,
          dialect,
          isolated.isFreshStatementAfterSemicolon ? '' : isolated.text,
          isolated.stmtPrefix,
          snapshot,
          input.schemaMap,
          activeSchema || undefined,
          shadowHeal?.healedTables
        )
        if (uncachedRefs.length > 0) {
          await enrichTableDetailsBounded(
            connId,
            dialect,
            uncachedRefs,
            activeSchema || undefined,
            COMPLETE_ENRICH_TIMEOUT_MS
          )
        }
        const enrichedSnapshot = connId ? schemaCache.getSnapshot(connId) : snapshot
        const historyEntries = await getHistoryEntries()
        const knownIdentifiers =
          dialect === 'redis' || dialect === 'mongodb'
            ? undefined
            : collectKnownIdentifiers(enrichedSnapshot, input.schemaMap)
        const signals = [controller.signal, AbortSignal.timeout(AI_COMPLETE_TIMEOUT_MS)]

        let suggestion = ''
        let replaceChars = 0
        let edits: AiInlineEdit[] | undefined
        let outMode: 'complete' | 'edit' | undefined

        const isLocalProvider =
          activeProvider.format === 'ollama' || isLoopbackHost(hostOf(activeProvider.baseUrl))
        const localBudgets = isLocalProvider
          ? { schemaBudget: LOCAL_SCHEMA_BUDGET, historyBudget: LOCAL_HISTORY_BUDGET }
          : {}

        if (resolvedTier === 'edit' && activeWindow && shadowHeal) {
          const editCtx = buildSqlStatementEditContext({
            connectionId: connId || undefined,
            dialect,
            statementBeforeCursor: activeWindow.text.slice(0, activeWindow.relCursor),
            statementAfterCursor: activeWindow.text.slice(activeWindow.relCursor),
            activeSchema: activeSchema || undefined,
            activeTable: activeTable || undefined,
            snapshot: enrichedSnapshot,
            schemaMap: input.schemaMap,
            historyEntries,
            fuzzyTables: shadowHeal.healedTables,
            cursorAfterSemicolon: activeWindow.cursorAfterSemicolon,
            ...localBudgets,
          })
          const editRes = await completeSqlStatementEdit(
            editProvider,
            {
              dialect,
              system: editCtx.system,
              user: editCtx.user,
              statement: activeWindow.text,
            },
            AbortSignal.any(signals),
            fetchPost,
            adaptiveOptsFor(activeModelKey)
          )
          const rewritten = extractRewriteTagContent(editRes.raw, activeWindow.text, editRes.finishReason)
          const filtered = rewritten
            ? computeFilteredStatementEdits({
                stmt: activeWindow,
                rewrittenSql: rewritten,
                dialect,
                heal: shadowHeal,
                prefixLength: boundedPrefix.length,
                suffixLength: boundedSuffix.length,
              })
            : []
          if (filtered.length === 1) {
            const single = filtered[0]
            if (single && single.fromOffset === 0 && single.toOffset === 0 && single.insert.length > 0) {
              suggestion = single.insert
              outMode = 'complete'
            } else if (single && single.fromOffset < 0 && single.toOffset === 0 && single.insert.length > 0) {
              suggestion = single.insert
              replaceChars = -single.fromOffset
              outMode = 'edit'
            } else if (single) {
              edits = filtered
              outMode = 'edit'
            }
          } else if (filtered.length > 1) {
            const cursorHunk = filtered.find((e) => e.fromOffset === 0 && e.toOffset === 0)
            suggestion = cursorHunk ? cursorHunk.insert : ''
            edits = filtered
            outMode = 'edit'
          }
        } else {
          const typo = resolveTrailingTypoToken(isolated.stmtPrefix, dialect, knownIdentifiers)
          const sqlCtx = buildSqlCompletionContext({
            connectionId: connId || undefined,
            dialect,
            prefix: typo ? typo.healedPrefix : isolated.stmtPrefix,
            suffix: isolated.stmtSuffix,
            fullPrefix: boundedPrefix,
            activeSchema: activeSchema || undefined,
            activeTable: activeTable || undefined,
            snapshot: enrichedSnapshot,
            schemaMap: input.schemaMap,
            historyEntries,
            fuzzyTables: shadowHeal?.healedTables,
            skipFimDdl: auto.provider.format !== 'ollama',
            ...localBudgets,
          })
          const adaptiveOpts = {
            ...adaptiveOptsFor(mKey),
            onStreamDelta: (accumulatedText: string) => {
              if (flightRef) {
                flightRef.partialText = accumulatedText
              }
            },
          }
          const completed = await completeSqlWithMeta(
            auto.provider,
            {
              dialect,
              system: sqlCtx.system,
              user: sqlCtx.user,
              prefix: isolated.stmtPrefix,
              suffix: isolated.stmtSuffix,
              fimPrefix: sqlCtx.fimPrefix,
              fimSuffix: sqlCtx.fimSuffix,
              fimSchemaDdl: sqlCtx.fimSchemaDdl,
              fimHistorySql: sqlCtx.fimHistorySql,
              fimPriorSql: sqlCtx.priorTabSql,
              multiline: sqlCtx.multiline,
              knownIdentifiers,
            },
            AbortSignal.any(signals),
            fetchPost,
            adaptiveOpts
          )
          suggestion = completed.suggestion
          replaceChars = completed.replaceChars
          outMode = completed.replaceChars > 0 ? 'edit' : 'complete'
        }

        const elapsed = Date.now() - started
        resetCompleteErrorCooldown()
        roleRuntime[activeHealthRole].lastMs = elapsed
        roleRuntime[activeHealthRole].lastError = null
        roleRuntime[activeHealthRole].lastSlow = false
        if (activeHealthRole === 'explain') {
          roleRuntime.autocomplete.lastMs = elapsed
          roleRuntime.autocomplete.lastError = null
          roleRuntime.autocomplete.lastSlow = false
        }
        latestLastMs = elapsed
        void recordUsage(activeProvider.baseUrl, activeProvider.model, elapsed).catch(() => undefined)
        if (!suggestion && (!edits || edits.length === 0)) {
          void refreshStatus()
          return empty
        }

        suggestedCount += 1
        updateStats((store) => recordMetricLatency(store, mKey, elapsed))
        void refreshStatus()

        rememberCompletion({
          exactKey: exactCacheKey,
          scopeKey,
          rawPrefix: cachePrefixKey,
          rawSuffix: cacheSuffixKey,
          suggestion,
          replaceChars,
          ...(edits ? { edits } : {}),
          ...(outMode ? { mode: outMode } : {}),
        })
        return {
          suggestion,
          id: rememberSuggestion(mKey),
          ...(replaceChars > 0 ? { replaceChars } : {}),
          ...(edits ? { edits } : {}),
          ...(outMode ? { mode: outMode } : {}),
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'TimeoutError') {
          noteCompleteError(mKey)
          roleRuntime[activeHealthRole].lastSlow = true
          void recordUsage(activeProvider.baseUrl, activeProvider.model, AI_COMPLETE_TIMEOUT_MS).catch(
            () => undefined
          )
          updateStats((store) => recordMetricLatency(store, mKey, AI_COMPLETE_TIMEOUT_MS))
          void refreshStatus()
        } else if (controller.signal.aborted) {
          updateStats((store) => bumpMetric(store, mKey, 'stale'))
        } else {
          noteCompleteError(mKey)
          const msg = explainFailure(
            err,
            hostOf(activeProvider.baseUrl),
            AI_COMPLETE_TIMEOUT_MS,
            activeProvider.format
          )
          logFailure(msg)
          roleRuntime[activeHealthRole].lastError = scrubCredentialsInText(msg).slice(
            0,
            ERROR_TEXT_CHARS
          )
          roleRuntime[activeHealthRole].lastSlow = false
          void refreshStatus()
        }
        return empty
      }
    })()

    const flight: CompletionFlight = {
      promise,
      controller,
      waiters: 0,
      scopeKey,
      rawPrefix: cachePrefixKey,
      rawSuffix: cacheSuffixKey,
      partialText: '',
      mode: resolvedTier,
    }
    flightRef = flight
    activeFlightByPanel.set(panelId, flight)
    inFlightByPanelAndKey.set(flightKey, flight)
    const cleanup = () => {
      if (inFlightByPanelAndKey.get(flightKey) === flight) {
        inFlightByPanelAndKey.delete(flightKey)
      }
      if (activeFlightByPanel.get(panelId) === flight) {
        activeFlightByPanel.delete(panelId)
      }
      if (inflightByPanel.get(panelId) === controller) {
        inflightByPanel.delete(panelId)
      }
    }
    void promise.then(cleanup, cleanup)
    return await joinFlight(flight, ctx?.signal)
  })

  function collectUncachedRefsForComplete(
    connId: string,
    dialect: DatabaseDriverType,
    statementText: string,
    partialPrefix: string,
    snapshot: WorkerSchemaSnapshot | null,
    schemaMap: Record<string, string[]> | undefined,
    activeSchema?: string,
    fuzzyTables?: readonly string[]
  ): string[] {
    if (!connId || dialect === 'redis' || !statementText) return []
    const referenced =
      dialect === 'mongodb'
        ? extractReferencedMongoCollections(statementText)
        : extractReferencedTables(statementText, dialect)
    const partial = extractTrailingPartialTableName(partialPrefix, dialect)
    const partialMatches = partial
      ? collectPartialTableMatches(snapshot, schemaMap, partial, activeSchema)
      : []

    const knownTabular = new Set<string>()
    if (snapshot && snapshot.objects.length > 0) {
      for (const obj of snapshot.objects) {
        if (
          obj.kind &&
          obj.kind !== 'table' &&
          obj.kind !== 'view' &&
          obj.kind !== 'materialized_view'
        ) {
          continue
        }
        const bare = obj.name.toLowerCase()
        knownTabular.add(bare)
        if (obj.schema) {
          knownTabular.add(`${obj.schema.toLowerCase()}.${bare}`)
        }
      }
    }

    const candidates = [...partialMatches, ...(fuzzyTables ?? []), ...referenced]
    const seen = new Set<string>()
    const missing: string[] = []
    const now = Date.now()
    const connRevision = schemaCache.getConnectionRevision(connId)
    for (const rawName of candidates) {
      if (missing.length >= MAX_COMPLETE_ENRICH_REFS) break
      const lower = rawName.toLowerCase()
      if (seen.has(lower)) continue
      seen.add(lower)
      const bare =
        dialect !== 'mongodb' && lower.includes('.') ? lower.split('.').pop() || lower : lower
      const qualified =
        dialect !== 'mongodb' && activeSchema && !lower.includes('.')
          ? `${activeSchema.toLowerCase()}.${lower}`
          : ''
      if (
        snapshot?.details.has(lower) ||
        snapshot?.details.has(bare) ||
        (qualified && snapshot?.details.has(qualified))
      ) {
        continue
      }
      if (isFreshEnrichMiss(buildEnrichMissKey(connId, dialect, rawName, activeSchema), connRevision, now)) {
        continue
      }
      if (knownTabular.size > 0 && !knownTabular.has(lower) && !knownTabular.has(bare)) {
        continue
      }
      if (
        knownTabular.size === 0 &&
        partial &&
        lower === partial.partial.toLowerCase() &&
        partialMatches.length === 0
      ) {
        continue
      }
      missing.push(rawName)
    }
    return missing
  }

  async function enrichTableDetailsBounded(
    connId: string,
    dialect: DatabaseDriverType,
    refs: readonly string[],
    activeSchema: string | undefined,
    timeoutMs: number
  ): Promise<void> {
    if (!connId || dialect === 'redis' || refs.length === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        enrichTableDetailsForRefs(connId, dialect, refs.slice(0, MAX_COMPLETE_ENRICH_REFS), activeSchema),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

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
          const missKey = buildEnrichMissKey(connId, dialect, refName, activeSchema)
          const startRevision = schemaCache.getConnectionRevision(connId)
          try {
            const det = await session.getTableDetails(table, schema)
            if (det) {
              enrichMissCache.delete(missKey)
              schemaCache.setTableDetails(connId, det)
            } else if (schemaCache.getConnectionRevision(connId) === startRevision) {
              recordEnrichMiss(missKey, startRevision, Date.now())
            }
          } catch {
            if (schemaCache.getConnectionRevision(connId) === startRevision) {
              recordEnrichMiss(missKey, startRevision, Date.now())
            }
          }
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
    const explainCfg = cfg.explain
    if (!explainCfg.enabled) {
      throw createHostError(
        'not_permitted',
        'Enable AI SQL Assistant (Explain & Fix) in AI settings first.'
      )
    }
    if (!explainCfg.validProvider || isRoleKeyMissing(explainCfg)) {
      throw createHostError(
        'invalid_params',
        'Configure an AI provider, model, and API key for Explain & Fix in AI settings first.'
      )
    }
    if (isChatIncompatibleBaseModel(explainCfg.provider.model)) {
      throw createHostError(
        'invalid_params',
        `Model "${explainCfg.provider.model}" is a Fill-in-the-Middle (FIM) autocomplete model and cannot run chat-based EXPLAIN analysis or SQL fixes. Open AI Settings → Explain & Fix (turn off Sync both) and select a chat/instruct model.`
      )
    }

    const dialect: DatabaseDriverType = input.dialect || 'sqlite'
    if (hasSensitiveContent(input.sql, '', '', dialect)) {
      throw createHostError(
        'invalid_params',
        'Query appears to contain sensitive credentials/secrets and was not sent to AI.'
      )
    }

    const panelId = ctx?.panel?.id || 'default'
    inflightExplainByPanel.get(panelId)?.abort()
    const controller = new AbortController()
    inflightExplainByPanel.set(panelId, controller)

    const connId = typeof input.connectionId === 'string' ? input.connectionId : ''

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
        explainCfg.provider,
        system,
        user,
        cfg.explainMaxTokens,
        AbortSignal.any(signals),
        fetchPost,
        dialect
      )
      const durationMs = Date.now() - started
      const parsed = parseExplainAnalysis(raw, resolvedLanguage.label, durationMs)
      roleRuntime.explain.lastMs = durationMs
      roleRuntime.explain.lastError = null
      roleRuntime.explain.lastSlow = false
      latestLastMs = durationMs
      void recordUsage(explainCfg.provider.baseUrl, explainCfg.provider.model, durationMs).catch(
        () => undefined
      )
      void refreshStatus()
      return parsed
    } catch (err) {
      if (controller.signal.aborted || ctx?.signal?.aborted) {
        throw createHostError('cancelled', 'EXPLAIN analysis cancelled.')
      }
      const msg = explainFailure(
        err,
        hostOf(explainCfg.provider.baseUrl),
        AI_EXPLAIN_TIMEOUT_MS,
        explainCfg.provider.format
      )
      const safeMsg = scrubCredentialsInText(msg)
      logFailure(safeMsg)
      throw createHostError('action_failed', safeMsg)
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
    const explainCfg = cfg.explain
    if (!explainCfg.enabled) {
      throw createHostError(
        'not_permitted',
        'Enable AI SQL Assistant (Explain & Fix) in AI settings first.'
      )
    }
    if (!explainCfg.validProvider || isRoleKeyMissing(explainCfg)) {
      throw createHostError(
        'invalid_params',
        'Configure an AI provider, model, and API key for Explain & Fix in AI settings first.'
      )
    }
    if (isChatIncompatibleBaseModel(explainCfg.provider.model)) {
      throw createHostError(
        'invalid_params',
        `Model "${explainCfg.provider.model}" is a Fill-in-the-Middle (FIM) autocomplete model and cannot run chat-based EXPLAIN analysis or SQL fixes. Open AI Settings → Explain & Fix (turn off Sync both) and select a chat/instruct model.`
      )
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

      const statementCount = countFixQueryStatements(input.sql, dialect)
      const safeErrorMessage = scrubCredentialsInText(rawErrorMessage)
      const { system, user, resolvedLanguage } = buildFixQueryPrompt({
        dialect,
        sql: input.sql,
        errorMessage: safeErrorMessage,
        schemaBlock,
        language: input.language ?? cfg.explainLanguage,
        uiLocale: input.uiLocale,
        statementCount,
      })

      const signals = [controller.signal, AbortSignal.timeout(AI_EXPLAIN_TIMEOUT_MS)]
      if (ctx?.signal) signals.push(ctx.signal)

      const started = Date.now()
      const maxTokens = Math.max(2048, Math.min(cfg.explainMaxTokens, 8192))
      const raw = await completeChat(
        explainCfg.provider,
        system,
        user,
        maxTokens,
        AbortSignal.any(signals),
        fetchPost,
        dialect
      )
      const durationMs = Date.now() - started
      const result = parseFixQueryResult(raw, {
        model: explainCfg.provider.model,
        durationMs,
        language: resolvedLanguage.label,
      })

      if (cfg.sync) {
        resetCompleteErrorCooldown()
      }
      roleRuntime.explain.lastMs = durationMs
      roleRuntime.explain.lastError = null
      roleRuntime.explain.lastSlow = false
      latestLastMs = durationMs
      void recordUsage(explainCfg.provider.baseUrl, explainCfg.provider.model, durationMs).catch(
        () => undefined
      )
      void refreshStatus()

      return sanitizeJsonPayload(result)
    } catch (err) {
      if (controller.signal.aborted || ctx?.signal?.aborted) {
        throw createHostError('cancelled', 'AI query fix cancelled.')
      }
      const msg = explainFailure(
        err,
        hostOf(explainCfg.provider.baseUrl),
        AI_EXPLAIN_TIMEOUT_MS,
        explainCfg.provider.format
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

  const settingsSub = orca.settings.onDidChange((change) => {
    const key = change?.key
    if (key === 'aiExplainEnabled' || key === 'aiSync') {
      void configStore.markDualRoleMigrated()
    }
    if (!key || key.startsWith('ai')) {
      const isExplainOnlyParam = key === 'aiExplainLanguage' || key === 'aiExplainMaxTokens'
      const isExplainProviderKey =
        key === 'aiExplainEnabled' ||
        key === 'aiExplainFormat' ||
        key === 'aiExplainBaseUrl' ||
        key === 'aiExplainModel'
      const isAutocompleteOrSyncKey = !key || (!isExplainOnlyParam && !isExplainProviderKey)

      if (isAutocompleteOrSyncKey) {
        completionCache.clear()
        resetCompleteErrorCooldown()
        settingsChangeSeq += 1
        pendingRoleHealthSeq.autocomplete = settingsChangeSeq
        if (!key || key === 'aiSync' || lastKnownSync) {
          pendingRoleHealthSeq.explain = settingsChangeSeq
        }
      } else if (isExplainProviderKey) {
        if (lastAutoIsFimOnly && !lastKnownSync) {
          completionCache.clear()
        }
        settingsChangeSeq += 1
        pendingRoleHealthSeq.explain = settingsChangeSeq
      }
      void refreshStatus()
    }
  })

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
      activeFlightByPanel.clear()
      inFlightByPanelAndKey.clear()
      inflightExplainByPanel.clear()
      inflightFixByPanel.clear()
      reasoningModels.clear()
      effortUnsupportedModels.clear()
      temperatureUnsupportedModels.clear()
      enrichMissCache.clear()
    },
  }
}
