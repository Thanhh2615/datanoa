import { createHash } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  sanitizeJsonPayload,
  type AiExplainAnalysisResult,
  type AiFixQueryResult,
  type AiInlineEdit,
  type AiRole,
  type AiStatusSnapshot,
  type ConnectionAiPolicy,
  type ConnectionProfile,
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
  SensitiveContentBlockedError,
  bumpMetric,
  completeChat,
  completeSql,
  completeSqlStatementEdit,
  completeSqlWithMeta,
  emptyStats,
  explainFailure,
  extractUnfencedSuggestion,
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
  redactAiSecretsInText,
  resolveTrailingTypoToken,
  sanitizePlainContinuationFallback,
  summarizeModelStats,
  truncateAiErrorMessage,
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
import {
  isolateActiveSqlStatement,
  stripLeadingSqlComments,
} from '../shared-sql-core.js'
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

const UNTAGGED_STATEMENT_STARTER_RE =
  /^(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE|MERGE|PRAGMA|EXPLAIN|BEGIN|COMMIT|ROLLBACK|SHOW|DESCRIBE|DESC|USE)\b/i

const CONTINUATION_SELECT_CONTEXT_RE = /\b(?:UNION(?:\s+ALL)?|INTERSECT|EXCEPT|\()\s*$/i

function isLoopbackBaseUrl(baseUrl: string): boolean {
  return isLoopbackHost(hostOf(baseUrl))
}

export type ConnectionAiPolicyRpcKind = 'complete' | 'edit' | 'explain' | 'fix'

export interface ConnectionAiPolicyDecision {
  allowed: boolean
  effectivePolicy: ConnectionAiPolicy
  code?: 'ai.blocked'
  reason?: string
}

/**
 * Resolves the effective per-connection AI egress policy.
 * Explicit `aiPolicy` always wins; when omitted, `prod`/`production` connections fail closed to `'ask'`
 * while non-production profiles remain `'allow'` for backwards compatibility.
 */
export function resolveEffectiveConnectionAiPolicy(
  profile: { colorTag?: string; aiPolicy?: ConnectionAiPolicy } | null | undefined,
  _isLocalProvider: boolean
): ConnectionAiPolicy {
  if (profile?.aiPolicy === 'never' || profile?.aiPolicy === 'ask' || profile?.aiPolicy === 'allow') {
    return profile.aiPolicy
  }
  const normalizedTag =
    typeof profile?.colorTag === 'string' ? profile.colorTag.trim().toLowerCase() : ''
  if (normalizedTag === 'prod' || normalizedTag === 'production') {
    return 'ask'
  }
  return 'allow'
}

/**
 * Evaluates whether a given AI RPC request may proceed for a connection profile.
 * Enforces fail-closed blocking (`ai.blocked`) for `'never'`, auto-inline on `'ask'`/`prod`,
 * and unconfirmed manual requests on `'ask'`/`prod`.
 */
export function evaluateConnectionAiPolicy(input: {
  colorTag?: string
  aiPolicy?: ConnectionAiPolicy
  isLocalProvider: boolean
  manual?: boolean
  confirmed?: boolean
  rpcKind: ConnectionAiPolicyRpcKind
}): ConnectionAiPolicyDecision {
  const effectivePolicy = resolveEffectiveConnectionAiPolicy(
    { colorTag: input.colorTag, aiPolicy: input.aiPolicy },
    input.isLocalProvider
  )
  if (effectivePolicy === 'never') {
    return {
      allowed: false,
      effectivePolicy,
      code: 'ai.blocked',
      reason: 'ai.blocked: AI assistance is disabled for this connection (policy: never).',
    }
  }
  if (effectivePolicy === 'ask') {
    const isExplicitUserAction =
      input.rpcKind === 'explain' || input.rpcKind === 'fix' ? true : input.manual === true
    if (!isExplicitUserAction) {
      return {
        allowed: false,
        effectivePolicy,
        code: 'ai.blocked',
        reason:
          'ai.blocked: Automatic inline AI requests are blocked on this connection (policy: ask).',
      }
    }
    if (input.confirmed !== true) {
      return {
        allowed: false,
        effectivePolicy,
        code: 'ai.blocked',
        reason:
          'ai.blocked: Explicit confirmation is required before sending SQL from this connection to AI (policy: ask).',
      }
    }
  }
  return { allowed: true, effectivePolicy }
}

function readOptionalBoolean(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false
  return (value as Record<string, unknown>)[key] === true
}

function readOptionalString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'string' ? raw : undefined
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
const AI_KEY_CONTROL_CHARS_RE = /[\r\n\u0000-\u001f\u007f]/
const MAX_RPC_SQL_CHARS = 65_536
const MAX_RPC_ERROR_MESSAGE_CHARS = 16_384
const MAX_RPC_PLAN_COLUMNS = 128
const MAX_RPC_PLAN_ROWS = 2_000
const MAX_RPC_SCHEMA_MAP_TABLES = 500
const MAX_RPC_SCHEMA_MAP_COLS_PER_TABLE = 200
const DISALLOWED_OBJECT_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
])
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
    !Array.isArray(value) &&
    Object.values(value).every(
      (v) =>
        Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
    )
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

function boundRpcSchemaMap(
  raw: Record<string, string[]> | undefined
): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const bounded = Object.create(null) as Record<string, string[]>
  let tableCount = 0
  for (const [tableName, cols] of Object.entries(raw)) {
    if (tableCount >= MAX_RPC_SCHEMA_MAP_TABLES) break
    if (DISALLOWED_OBJECT_KEYS.has(tableName)) continue
    const cleanCols: string[] = []
    if (Array.isArray(cols)) {
      const limit = Math.min(cols.length, MAX_RPC_SCHEMA_MAP_COLS_PER_TABLE)
      for (let i = 0; i < limit; i += 1) {
        const col = cols[i]
        if (typeof col === 'string') cleanCols.push(col)
      }
    }
    bounded[tableName] = cleanCols
    tableCount += 1
  }
  return bounded
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
    let tablesSeen = 0
    for (const [tableName, cols] of Object.entries(schemaMap)) {
      if (tablesSeen >= MAX_RPC_SCHEMA_MAP_TABLES) break
      tablesSeen += 1
      addIdent(tableName)
      if (Array.isArray(cols)) {
        const limit = Math.min(cols.length, MAX_RPC_SCHEMA_MAP_COLS_PER_TABLE)
        for (let i = 0; i < limit; i += 1) {
          addIdent(cols[i])
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
      const delta = rawPrefix.slice(entry.rawPrefix.length)
      if (delta.length >= entry.suggestion.length || !entry.suggestion.startsWith(delta)) continue
      if (!best || entry.rawPrefix.length > best.rawPrefix.length) best = entry
    }
    if (best) {
      const delta = rawPrefix.slice(best.rawPrefix.length)
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
    if (signal?.aborted) {
      if (flight.waiters <= 0 && !flight.controller.signal.aborted) {
        flight.controller.abort()
      }
      return Promise.resolve({ suggestion: '', id: 0 })
    }
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
  let autocompleteProviderGeneration = 0
  const pendingRoleHealthSeq: Record<AiRole, number> = { autocomplete: 0, explain: 0 }
  const reconciledRoleSeq: Record<AiRole, number> = { autocomplete: 0, explain: 0 }
  const lastRoleHealthSig: Record<AiRole, string | null> = { autocomplete: null, explain: null }
  const roleLastTestedDraft: Record<AiRole, boolean> = { autocomplete: false, explain: false }
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
  let usageQueue: Promise<void> = Promise.resolve()
  let disposed = false

  async function checkConnectionAiPolicy(
    connId: string,
    isLocalProvider: boolean,
    rpcKind: ConnectionAiPolicyRpcKind,
    manual: boolean,
    confirmed: boolean,
    expectConnectionId = false
  ): Promise<ConnectionAiPolicyDecision> {
    const cleanConnId = connId.trim()
    const failClosed = (reason: string): ConnectionAiPolicyDecision => ({
      allowed: false,
      effectivePolicy: 'never',
      code: 'ai.blocked',
      reason,
    })

    if (!cleanConnId) {
      if (expectConnectionId) {
        return failClosed(
          'ai.blocked: Connection identity is missing for this AI request; blocking fail-closed.'
        )
      }
      return { allowed: true, effectivePolicy: 'allow' }
    }
    const finder = (
      sessionManager as { findProfile?: (id: string) => Promise<ConnectionProfile | null> }
    ).findProfile
    if (typeof finder !== 'function') {
      try {
        const listFn = (
          sessionManager as { getStoredConnections?: () => Promise<ConnectionProfile[]> }
        ).getStoredConnections
        let saved: unknown
        if (typeof listFn === 'function') {
          saved = await listFn.call(sessionManager)
        } else {
          const primary = await orca.storage.get('datanoa.savedConnections')
          saved = Array.isArray(primary)
            ? primary
            : await orca.storage.get('connections')
        }
        if (!Array.isArray(saved)) {
          return failClosed(
            'ai.blocked: Connection profile not found; blocking AI request fail-closed.'
          )
        }
        const matched = saved.find(
          (item) => item && typeof item === 'object' && (item as { id?: unknown }).id === cleanConnId
        ) as ConnectionProfile | undefined
        if (!matched) {
          return failClosed(
            'ai.blocked: Connection profile not found; blocking AI request fail-closed.'
          )
        }
        return evaluateConnectionAiPolicy({
          colorTag: matched.colorTag,
          aiPolicy: matched.aiPolicy,
          isLocalProvider,
          manual,
          confirmed,
          rpcKind,
        })
      } catch {
        return failClosed(
          'ai.blocked: Unable to verify connection AI policy; blocking request fail-closed.'
        )
      }
    }
    try {
      const profile = await finder.call(sessionManager, cleanConnId)
      if (!profile) {
        return failClosed(
          'ai.blocked: Connection profile not found; blocking AI request fail-closed.'
        )
      }
      return evaluateConnectionAiPolicy({
        colorTag: profile.colorTag,
        aiPolicy: profile.aiPolicy,
        isLocalProvider,
        manual,
        confirmed,
        rpcKind,
      })
    } catch {
      return failClosed(
        'ai.blocked: Unable to verify connection AI policy; blocking request fail-closed.'
      )
    }
  }

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

  function recordRoleRuntimeSuccess(role: AiRole, elapsedMs?: number): void {
    if (elapsedMs !== undefined) {
      roleRuntime[role].lastMs = elapsedMs
      latestLastMs = elapsedMs
    }
    roleRuntime[role].lastError = null
    roleRuntime[role].lastSlow = false
  }

  function sanitizeAiFailureMessage(
    rawMessage: string,
    knownSecrets?: readonly string[]
  ): string {
    return truncateAiErrorMessage(
      redactAiSecretsInText(scrubCredentialsInText(rawMessage), knownSecrets)
    )
  }

  function recordRoleRuntimeFailure(
    role: AiRole,
    rawMessage: string,
    opts?: { logError?: boolean; knownSecrets?: readonly string[] }
  ): string {
    const safe = sanitizeAiFailureMessage(rawMessage, opts?.knownSecrets)
    if (opts?.logError !== false) {
      logFailure(safe)
    }
    roleRuntime[role].lastError = safe.slice(0, ERROR_TEXT_CHARS)
    roleRuntime[role].lastSlow = false
    return safe
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
      const syncedDraftReconciled: Record<AiRole, boolean> = { autocomplete: false, explain: false }
      for (const role of ['autocomplete', 'explain'] as const) {
        const sig = roleHealthSignature(cfg[role])
        const sigChanged = lastRoleHealthSig[role] !== null && sig !== lastRoleHealthSig[role]
        if (seqBeforeRead[role] > reconciledRoleSeq[role]) {
          reconciledRoleSeq[role] = seqBeforeRead[role]
          if (!sigChanged && roleLastTestedDraft[role]) {
            syncedDraftReconciled[role] = true
            roleLastTestedDraft[role] = false
          }
        }
        if (sigChanged) {
          changedRoles[role] = true
          roleRuntime[role].lastError = null
          roleRuntime[role].lastSlow = false
          if (
            role === 'autocomplete' ||
            (role === 'explain' && !cfg.sync && lastAutoIsFimOnly)
          ) {
            autocompleteProviderGeneration += 1
          }
          if (role === 'autocomplete') {
            resetCompleteErrorCooldown()
            completionCache.clear()
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
        if (
          (changedRoles.explain || syncedDraftReconciled.explain) &&
          !changedRoles.autocomplete &&
          roleRuntime.autocomplete.lastError
        ) {
          roleRuntime.explain.lastError = roleRuntime.autocomplete.lastError
          roleRuntime.explain.lastSlow = roleRuntime.autocomplete.lastSlow
        } else if (
          (changedRoles.autocomplete || syncedDraftReconciled.autocomplete) &&
          !changedRoles.explain &&
          roleRuntime.explain.lastError
        ) {
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
    if (disposed) return
    const snap = await buildStatusSnapshot()
    if (disposed) return
    orca.panels.post('ai.status.changed', snap)
  }

  async function readUsage(): Promise<UsageMap> {
    const stored = await orca.storage.get(AI_USAGE_KEY)
    return isUsageMap(stored) ? stored : {}
  }

  function recordUsage(baseUrl: string, model: string, ms: number): Promise<void> {
    if (disposed || !Number.isFinite(ms) || ms < 0) return Promise.resolve()
    if (!model || DISALLOWED_OBJECT_KEYS.has(model.trim())) return Promise.resolve()
    const key = modelKey(baseUrl, model)
    usageQueue = usageQueue
      .then(async () => {
        if (disposed) return
        const usage = await readUsage()
        const { [key]: prev = [], ...rest } = usage
        const next: UsageMap = { ...rest, [key]: [...prev, ms].slice(-USAGE_SAMPLES) }
        const keys = Object.keys(next)
        for (const old of keys.slice(0, Math.max(0, keys.length - USAGE_MODELS))) {
          delete next[old]
        }
        await orca.storage.set(AI_USAGE_KEY, next)
      })
      .catch(() => undefined)
    return usageQueue
  }

  function updateStats(change: (store: AiStatsStore) => AiStatsStore): void {
    if (disposed) return
    statsQueue = statsQueue
      .then(async () => {
        if (disposed) return
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
      return historyCache
    } catch {
      return []
    }
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
    if (typeof input?.key === 'string' && AI_KEY_CONTROL_CHARS_RE.test(input.key)) {
      throw createHostError('invalid_params', 'API key contains invalid control characters.')
    }
    const res = await configStore.setKey(input)
    if (res.role === 'autocomplete') {
      autocompleteProviderGeneration += 1
      completionCache.clear()
      resetCompleteErrorCooldown()
      clearRoleRuntimeHealth('autocomplete')
      if (lastKnownSync || lastExplainUsingSharedKey) {
        clearRoleRuntimeHealth('explain')
      }
    } else {
      if (lastAutoIsFimOnly && !lastKnownSync) {
        autocompleteProviderGeneration += 1
        completionCache.clear()
      }
      clearRoleRuntimeHealth('explain')
      if (lastKnownSync) {
        autocompleteProviderGeneration += 1
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
    const savedRoleCfg = role === 'explain' ? cfg.explain : cfg.autocomplete

    const rawDraftFormat = readOptionalString(input, 'format')
    const rawDraftBaseUrl = readOptionalString(input, 'baseUrl')
    const rawDraftModel = readOptionalString(input, 'model')
    const rawDraftKey = readOptionalString(input, 'key')
    if (rawDraftKey !== undefined && AI_KEY_CONTROL_CHARS_RE.test(rawDraftKey)) {
      return { ok: false, message: 'API key contains invalid control characters.', ms: null, role }
    }
    const isDraftTest =
      rawDraftFormat !== undefined ||
      rawDraftBaseUrl !== undefined ||
      rawDraftModel !== undefined ||
      rawDraftKey !== undefined

    let roleCfg: ResolvedAiRoleConfig = savedRoleCfg
    if (isDraftTest) {
      const draftFormat = rawDraftFormat !== undefined ? parseFormat(rawDraftFormat) : savedRoleCfg.provider.format
      const draftBaseUrlRaw = (rawDraftBaseUrl ?? savedRoleCfg.provider.baseUrl).trim()
      const draftModel = (rawDraftModel ?? savedRoleCfg.provider.model).trim()
      const urlCheck = validateAiBaseUrl(draftBaseUrlRaw)
      if (!urlCheck.ok) {
        return { ok: false, message: urlCheck.error, ms: null, role }
      }
      const draftKey = await configStore.keyForListing(
        draftFormat,
        urlCheck.url,
        (rawDraftKey ?? '').trim(),
        role
      )
      if (draftKey) {
        const keyCheck = validateAiBaseUrl(urlCheck.url, { hasApiKey: true })
        if (!keyCheck.ok) {
          return { ok: false, message: keyCheck.error, ms: null, role }
        }
      }
      roleCfg = {
        role,
        enabled: true,
        validProvider: urlCheck.ok && draftModel.length > 0,
        hasKey: Boolean(draftKey),
        usingSharedKey: false,
        provider: {
          format: draftFormat,
          baseUrl: urlCheck.url,
          model: draftModel,
          apiKey: draftKey,
          maxTokens: savedRoleCfg.provider.maxTokens,
        },
      }
    }

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
      const isUnsavedDraftOverride =
        isDraftTest && roleProviderSignature(roleCfg) !== roleProviderSignature(savedRoleCfg)
      if (!isUnsavedDraftOverride) {
        recordRoleRuntimeSuccess(role)
        roleLastTestedDraft[role] = false
        void refreshStatus()
      } else if (roleRuntime[role].lastError !== null) {
        // Clear modal preview error dot when testing a working draft for an errored role,
        // reconciled via roleLastTestedDraft without broadcasting global status to other panels.
        recordRoleRuntimeSuccess(role)
        roleLastTestedDraft[role] = true
      }
      return { ok: true, message: '', ms, role }
    } catch (err) {
      const knownSecrets = roleCfg.provider.apiKey ? [roleCfg.provider.apiKey] : []
      const msg = explainFailure(
        err,
        hostOf(roleCfg.provider.baseUrl),
        AI_TEST_TIMEOUT_MS,
        roleCfg.provider.format,
        knownSecrets
      )
      const isUnsavedDraftOverride =
        isDraftTest && roleProviderSignature(roleCfg) !== roleProviderSignature(savedRoleCfg)
      if (isUnsavedDraftOverride) {
        const safeMsg = sanitizeAiFailureMessage(msg, knownSecrets)
        return { ok: false, message: safeMsg, ms: null, role }
      }
      const safeMsg = recordRoleRuntimeFailure(role, msg, { logError: false, knownSecrets })
      void refreshStatus()
      return { ok: false, message: safeMsg, ms: null, role }
    }
  })

  registerHandler('ai.models.list', async (input) => {
    if (typeof input?.key === 'string' && AI_KEY_CONTROL_CHARS_RE.test(input.key)) {
      return { ok: false, models: [], message: 'API key contains invalid control characters.' }
    }
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
        message: explainFailure(
          err,
          hostOf(url),
          AI_MODELS_TIMEOUT_MS,
          format,
          apiKey ? [apiKey] : []
        ),
      }
    }
  })

  registerHandler('ai.models.bench', async (input, ctx) => {
    if (typeof input?.key === 'string' && AI_KEY_CONTROL_CHARS_RE.test(input.key)) {
      return { results: [], message: 'API key contains invalid control characters.' }
    }
    const role = parseAiRole(input?.role)
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
      role
    )
    if (apiKey) {
      const keyCheck = validateAiBaseUrl(url, { hasApiKey: true })
      if (!keyCheck.ok) {
        return { results: [], message: keyCheck.error }
      }
    }
    const rawModels = Array.isArray(input?.models) ? input.models : []
    const ids = Array.from(
      new Set(
        rawModels
          .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
          .map((id) => id.trim())
      )
    ).slice(0, AI_BENCH_BATCH_SIZE)
    const req = buildTestCompletionRequest()
    const chatReq = buildTestExplainChatRequest()
    const results = await Promise.all(
      ids.map(async (model) => {
        if (role === 'explain' && (format === 'mistral-fim' || isChatIncompatibleBaseModel(model))) {
          return { model, ok: false, ms: null }
        }
        const provider: AiProviderConfig = {
          format,
          baseUrl: url,
          model,
          apiKey,
          maxTokens: AI_BENCH_MAX_TOKENS,
        }
        const signals = [AbortSignal.timeout(AI_BENCH_TIMEOUT_MS)]
        if (ctx?.signal) signals.push(ctx.signal)
        const started = Date.now()
        try {
          if (role === 'explain') {
            const reply = await completeChat(
              provider,
              chatReq.system,
              chatReq.user,
              AI_BENCH_MAX_TOKENS,
              AbortSignal.any(signals),
              fetchPost,
              'sqlite'
            )
            return { model, ok: reply.trim().length > 0, ms: Date.now() - started }
          }
          const suggestion = await completeSql(
            provider,
            req,
            AbortSignal.any(signals),
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
    const usage = Object.create(null) as Record<string, { ms: number; uses: number }>
    for (const [k, samples] of Object.entries(await readUsage())) {
      if (k.startsWith(prefix) && samples.length > 0) {
        const modelId = k.slice(prefix.length)
        if (!modelId || DISALLOWED_OBJECT_KEYS.has(modelId.trim())) continue
        usage[modelId] = { ms: median(samples), uses: samples.length }
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

  function resolveConnectionAiPolicyExpectation(input: {
    connectionId?: unknown
    fromConnection?: unknown
    activeSchema?: unknown
    activeTable?: unknown
  }): { connId: string; activeSchema: string; activeTable: string; expectConnectionId: boolean } {
    const connId = typeof input.connectionId === 'string' ? input.connectionId : ''
    const activeSchema = typeof input.activeSchema === 'string' ? input.activeSchema.trim() : ''
    const activeTable = typeof input.activeTable === 'string' ? input.activeTable.trim() : ''
    const expectConnectionId =
      connId.length > 0 ||
      input.fromConnection === true ||
      Object.prototype.hasOwnProperty.call(input, 'connectionId') ||
      activeSchema.length > 0 ||
      activeTable.length > 0
    return { connId, activeSchema, activeTable, expectConnectionId }
  }

  registerHandler('ai.complete', async (input, ctx) => {
    const empty = { suggestion: '', id: 0 }
    if (!input || typeof input.prefix !== 'string' || typeof input.suffix !== 'string') {
      return empty
    }
    const cfg = await readConfig()
    const reqGen = autocompleteProviderGeneration
    const auto = cfg.autocomplete
    if (!isRoleReady(auto)) {
      return empty
    }

    const dialect: DatabaseDriverType = input.dialect || 'sqlite'
    const boundedPrefix = input.prefix.slice(-AI_RPC_MAX_PREFIX_CHARS)
    const boundedSuffix = input.suffix.slice(0, AI_RPC_MAX_SUFFIX_CHARS)
    const boundedSchemaMap = boundRpcSchemaMap(input.schemaMap)
    const {
      connId,
      activeSchema,
      activeTable,
      expectConnectionId: expectCompleteConnId,
    } = resolveConnectionAiPolicyExpectation(input)
    const requestedMode: 'auto' | 'complete' | 'edit' =
      input.mode === 'edit' ? 'edit' : input.mode === 'complete' ? 'complete' : 'auto'
    const isManual = input.manual === true
    const isConfirmed = readOptionalBoolean(input, 'confirmed')

    const autoFimOnly = isFimOnlyModel(auto.provider.format, auto.provider.model)
    const crossesLocalToRemote =
      isLoopbackBaseUrl(auto.provider.baseUrl) && !isLoopbackBaseUrl(cfg.explain.provider.baseUrl)
    const canRouteEditToExplain =
      !cfg.sync &&
      autoFimOnly &&
      isRoleReady(cfg.explain) &&
      !isFimOnlyModel(cfg.explain.provider.format, cfg.explain.provider.model) &&
      (!crossesLocalToRemote || isManual)

    const policyCheck = await checkConnectionAiPolicy(
      connId,
      isLoopbackBaseUrl(auto.provider.baseUrl) &&
        (!canRouteEditToExplain || isLoopbackBaseUrl(cfg.explain.provider.baseUrl)),
      requestedMode === 'edit' ? 'edit' : 'complete',
      isManual,
      isConfirmed,
      expectCompleteConnId
    )
    if (!policyCheck.allowed) {
      if (isManual) {
        throw createHostError(
          'not_permitted',
          policyCheck.reason ?? 'ai.blocked: AI assistance is blocked for this connection.'
        )
      }
      return empty
    }

    const rawIsolated = isolateActiveSqlStatement(boundedPrefix, boundedSuffix, dialect)
    const strippedStmtPrefix = stripLeadingSqlComments(rawIsolated.stmtPrefix, dialect)
    const leadingCommentsStripped =
      strippedStmtPrefix !== rawIsolated.stmtPrefix &&
      (strippedStmtPrefix.trim().length > 0 || rawIsolated.stmtSuffix.trim().length > 0)
    const effectiveStmtPrefix = leadingCommentsStripped
      ? strippedStmtPrefix
      : rawIsolated.stmtPrefix
    const isolated =
      effectiveStmtPrefix === rawIsolated.stmtPrefix
        ? rawIsolated
        : {
            ...rawIsolated,
            stmtPrefix: effectiveStmtPrefix,
            text: `${effectiveStmtPrefix}${rawIsolated.stmtSuffix}`,
            relCursor: effectiveStmtPrefix.length,
            cursorOffsetInSpan: effectiveStmtPrefix.length,
          }
    const precedingPrefix = boundedPrefix.slice(0, boundedPrefix.length - rawIsolated.stmtPrefix.length)
    const rawFullPrefix =
      effectiveStmtPrefix === rawIsolated.stmtPrefix
        ? boundedPrefix
        : `${precedingPrefix}${effectiveStmtPrefix}`
    if (hasSensitiveContent(isolated.stmtPrefix, isolated.stmtSuffix, '', dialect)) {
      return empty
    }
    const rawActiveWindow = extractActiveStatementWindow(rawFullPrefix, boundedSuffix, dialect, {
      allowPrecedingOnFreshLine: requestedMode === 'edit',
    })
    if (rawActiveWindow && hasSensitiveContent(rawActiveWindow.text, '', '', dialect)) {
      return empty
    }
    const scrubbedPrecedingPrefix = scrubCredentialsInText(precedingPrefix)
    const sanitizedFullPrefix = `${scrubbedPrecedingPrefix}${effectiveStmtPrefix}`
    const activeWindow =
      scrubbedPrecedingPrefix === precedingPrefix
        ? rawActiveWindow
        : extractActiveStatementWindow(sanitizedFullPrefix, boundedSuffix, dialect, {
            allowPrecedingOnFreshLine: requestedMode === 'edit',
          })

    const targetingPrecedingErrored = Boolean(
      activeWindow && isolated.isFreshStatementAfterSemicolon && requestedMode === 'edit'
    )
    const cachePrefixKey =
      targetingPrecedingErrored && activeWindow
        ? `${activeWindow.text}@${activeWindow.cursorOffsetInSpan}`
        : isolated.stmtPrefix
    const cacheSuffixKey = targetingPrecedingErrored ? '' : isolated.stmtSuffix

    const editScopeTag = canRouteEditToExplain
      ? `|edit:${cfg.explain.provider.baseUrl}|${cfg.explain.provider.model}`
      : autoFimOnly
        ? '|fim-only'
        : ''

    const mKey = modelKey(auto.provider.baseUrl, auto.provider.model)
    const autoCooldownKey = `${auto.provider.format}|${mKey}|${auto.hasKey ? 'k' : 'n'}`
    const schemaRev = connId ? schemaCache.getConnectionRevision(connId) : 0
    const scopeKey = `${auto.provider.baseUrl}|${auto.provider.model}${editScopeTag}|${connId}|r${schemaRev}|g${reqGen}|${dialect}|${activeSchema}|${activeTable}|${requestedMode}`
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

    if (!isManual && autoCooldownModelKey === autoCooldownKey && Date.now() < autoCooldownUntil) {
      return empty
    }

    if (ctx?.signal?.aborted) {
      return empty
    }
    const snapshot = connId ? schemaCache.getSnapshot(connId) : null
    const shadowHeal = activeWindow
      ? shadowHealStatementForSchema(activeWindow, dialect, snapshot, boundedSchemaMap, activeSchema || undefined)
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
        const currentPanelFlight = activeFlightByPanel.get(panelId)
        if (
          ctx?.signal?.aborted ||
          activeFlight.controller.signal.aborted ||
          (currentPanelFlight !== undefined && currentPanelFlight !== activeFlight)
        ) {
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
    const activeCooldownKey =
      activeHealthRole === 'autocomplete' ? autoCooldownKey : activeModelKey

    const promise = (async (): Promise<CompletionResultPayload> => {
      const started = Date.now()
      try {
        const uncachedRefs = collectUncachedRefsForComplete(
          connId,
          dialect,
          isolated.isFreshStatementAfterSemicolon ? '' : isolated.text,
          isolated.stmtPrefix,
          snapshot,
          boundedSchemaMap,
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
            : collectKnownIdentifiers(enrichedSnapshot, boundedSchemaMap)
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
            schemaMap: boundedSchemaMap,
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
          } else if (
            requestedMode !== 'edit' &&
            !targetingPrecedingErrored &&
            !isolated.cursorAfterSemicolon &&
            !/<\/?REWRITE\b/i.test(editRes.raw) &&
            !(dialect !== 'redis' && dialect !== 'mongodb' && isMidLineBeforeExistingExpression(isolated.stmtSuffix))
          ) {
            const unfencedRaw = extractUnfencedSuggestion(editRes.raw, isolated.stmtPrefix, dialect).trim()
            if (
              !UNTAGGED_STATEMENT_STARTER_RE.test(unfencedRaw) ||
              (/^(?:SELECT|WITH)\b/i.test(unfencedRaw) && CONTINUATION_SELECT_CONTEXT_RE.test(isolated.stmtPrefix))
            ) {
              const plainFallback = sanitizePlainContinuationFallback(editRes.raw, {
                prefix: isolated.stmtPrefix,
                suffix: isolated.stmtSuffix,
                dialect,
                multiline: activeWindow.lineCount > 1 || isolated.stmtPrefix.includes('\n'),
                knownIdentifiers,
                groundedSources: historyEntries
                  .slice(0, 4)
                  .map((h) => (typeof h.sql === 'string' ? h.sql : ''))
                  .filter(Boolean),
              })
              if (plainFallback) {
                suggestion = plainFallback
                outMode = 'complete'
              }
            }
          }
        } else {
          const typo = resolveTrailingTypoToken(isolated.stmtPrefix, dialect, knownIdentifiers)
          const sqlCtx = buildSqlCompletionContext({
            connectionId: connId || undefined,
            dialect,
            prefix: typo ? typo.healedPrefix : isolated.stmtPrefix,
            suffix: isolated.stmtSuffix,
            fullPrefix: sanitizedFullPrefix,
            activeSchema: activeSchema || undefined,
            activeTable: activeTable || undefined,
            snapshot: enrichedSnapshot,
            schemaMap: boundedSchemaMap,
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
        if (reqGen !== autocompleteProviderGeneration) {
          return empty
        }
        if (activeHealthRole === 'autocomplete') {
          resetCompleteErrorCooldown()
        }
        recordRoleRuntimeSuccess(activeHealthRole, elapsed)
        void recordUsage(activeProvider.baseUrl, activeProvider.model, elapsed).catch(() => undefined)
        if (!suggestion && (!edits || edits.length === 0)) {
          void refreshStatus()
          return empty
        }

        suggestedCount += 1
        updateStats((store) => recordMetricLatency(store, activeModelKey, elapsed))
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
          id: rememberSuggestion(activeModelKey),
          ...(replaceChars > 0 ? { replaceChars } : {}),
          ...(edits ? { edits } : {}),
          ...(outMode ? { mode: outMode } : {}),
        }
      } catch (err) {
        if (err instanceof SensitiveContentBlockedError) {
          return empty
        }
        if (reqGen !== autocompleteProviderGeneration) {
          return empty
        }
        if (err instanceof Error && err.name === 'TimeoutError') {
          if (activeHealthRole === 'autocomplete') {
            noteCompleteError(activeCooldownKey)
          }
          roleRuntime[activeHealthRole].lastSlow = true
          void recordUsage(activeProvider.baseUrl, activeProvider.model, AI_COMPLETE_TIMEOUT_MS).catch(
            () => undefined
          )
          updateStats((store) => recordMetricLatency(store, activeModelKey, AI_COMPLETE_TIMEOUT_MS))
          void refreshStatus()
        } else if (controller.signal.aborted) {
          updateStats((store) => bumpMetric(store, activeModelKey, 'stale'))
        } else {
          if (activeHealthRole === 'autocomplete') {
            noteCompleteError(activeCooldownKey)
          }
          const knownSecrets = activeProvider.apiKey ? [activeProvider.apiKey] : []
          const msg = explainFailure(
            err,
            hostOf(activeProvider.baseUrl),
            AI_COMPLETE_TIMEOUT_MS,
            activeProvider.format,
            knownSecrets
          )
          recordRoleRuntimeFailure(activeHealthRole, msg, { knownSecrets })
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
      const hasDot = dialect !== 'mongodb' && lower.includes('.')
      const bare = hasDot ? lower.split('.').pop() || lower : lower
      const qualified =
        dialect !== 'mongodb' && activeSchema && !hasDot
          ? `${activeSchema.toLowerCase()}.${lower}`
          : ''
      const alreadyDetailed = hasDot
        ? Boolean(snapshot?.details.has(lower))
        : Boolean(
            (qualified && snapshot?.details.has(qualified)) ||
              (!qualified && snapshot?.details.has(lower))
          )
      if (alreadyDetailed) {
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
      const hasDot = dialect !== 'mongodb' && lower.includes('.')
      const qualified =
        dialect !== 'mongodb' && activeSchema && !hasDot
          ? `${activeSchema.toLowerCase()}.${lower}`
          : ''
      if (hasDot) {
        return !existingSnap?.details.has(lower)
      }
      if (qualified) {
        return !existingSnap?.details.has(qualified)
      }
      return !existingSnap?.details.has(lower)
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
              if (schemaCache.getConnectionRevision(connId) === startRevision) {
                enrichMissCache.delete(missKey)
                schemaCache.setTableDetails(connId, det)
              }
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

  function assertExplainRoleConfigured(explainCfg: ResolvedAiRoleConfig): void {
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
  }

  async function assertExplainModelCompatible(explainCfg: ResolvedAiRoleConfig): Promise<void> {
    if (isChatIncompatibleBaseModel(explainCfg.provider.model)) {
      const incompatMsg = `Model "${explainCfg.provider.model}" is a Fill-in-the-Middle (FIM) autocomplete model and cannot run chat-based EXPLAIN analysis or SQL fixes. Open AI Settings → Explain & Fix (turn off Sync both) and select a chat/instruct model.`
      recordRoleRuntimeFailure('explain', incompatMsg, { logError: false })
      await refreshStatus()
      throw createHostError('invalid_params', incompatMsg)
    }
  }

  async function failExplainChatRequest(
    err: unknown,
    explainCfg: ResolvedAiRoleConfig,
    cancelled: boolean,
    cancelMessage: string
  ): Promise<never> {
    if (cancelled) {
      throw createHostError('cancelled', cancelMessage)
    }
    const knownSecrets = explainCfg.provider.apiKey ? [explainCfg.provider.apiKey] : []
    const msg = explainFailure(
      err,
      hostOf(explainCfg.provider.baseUrl),
      AI_EXPLAIN_TIMEOUT_MS,
      explainCfg.provider.format,
      knownSecrets
    )
    if (err instanceof SensitiveContentBlockedError) {
      const safeSensitiveMsg = scrubCredentialsInText(msg)
      logFailure(safeSensitiveMsg)
      throw createHostError('action_failed', safeSensitiveMsg)
    }
    const safeMsg = recordRoleRuntimeFailure('explain', msg, { knownSecrets })
    await refreshStatus()
    throw createHostError('action_failed', safeMsg)
  }

  registerHandler('ai.explainAnalyze', async (input, ctx): Promise<AiExplainAnalysisResult> => {
    if (!input?.sql || typeof input.sql !== 'string') {
      throw createHostError('invalid_params', 'SQL string is required for EXPLAIN analysis.')
    }
    const boundedSql = input.sql.slice(0, MAX_RPC_SQL_CHARS)
    const boundedPlanColumns = Array.isArray(input.planColumns)
      ? input.planColumns.slice(0, MAX_RPC_PLAN_COLUMNS)
      : []
    const boundedPlanRows = Array.isArray(input.planRows)
      ? input.planRows.slice(0, MAX_RPC_PLAN_ROWS)
      : []
    const cfg = await readConfig()
    const explainCfg = cfg.explain
    assertExplainRoleConfigured(explainCfg)

    const dialect: DatabaseDriverType = input.dialect || 'sqlite'
    if (hasSensitiveContent(boundedSql, '', '', dialect)) {
      throw createHostError(
        'invalid_params',
        'Query appears to contain sensitive credentials/secrets and was not sent to AI.'
      )
    }

    const { connId, expectConnectionId: requiresConnectionPolicy } =
      resolveConnectionAiPolicyExpectation(input)
    const explainPolicy = await checkConnectionAiPolicy(
      connId,
      isLoopbackBaseUrl(explainCfg.provider.baseUrl),
      'explain',
      true,
      readOptionalBoolean(input, 'confirmed'),
      requiresConnectionPolicy
    )
    if (!explainPolicy.allowed) {
      throw createHostError(
        'not_permitted',
        explainPolicy.reason ?? 'ai.blocked: AI EXPLAIN analysis is blocked for this connection.'
      )
    }
    await assertExplainModelCompatible(explainCfg)

    const panelId = ctx?.panel?.id || 'default'
    inflightExplainByPanel.get(panelId)?.abort()
    const controller = new AbortController()
    inflightExplainByPanel.set(panelId, controller)

    const activeSchema = (readOptionalString(input, 'activeSchema') ?? '').trim()

    try {
      const refs =
        dialect === 'redis'
          ? []
          : dialect === 'mongodb'
            ? extractReferencedMongoCollections(boundedSql)
            : extractReferencedTables(boundedSql, dialect)
      await enrichTableDetailsForRefs(connId, dialect, refs, activeSchema || undefined)

      const { system, user, resolvedLanguage } = buildExplainAnalysisPrompt({
        dialect,
        sql: boundedSql,
        planColumns: boundedPlanColumns,
        planRows: boundedPlanRows,
        explainPlan: input.explainPlan,
        snapshot: connId ? schemaCache.getSnapshot(connId) : null,
        activeSchema: activeSchema || undefined,
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
      recordRoleRuntimeSuccess('explain', durationMs)
      void recordUsage(explainCfg.provider.baseUrl, explainCfg.provider.model, durationMs).catch(
        () => undefined
      )
      await refreshStatus()
      return parsed
    } catch (err) {
      return await failExplainChatRequest(
        err,
        explainCfg,
        Boolean(controller.signal.aborted || ctx?.signal?.aborted),
        'EXPLAIN analysis cancelled.'
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
    const boundedSql = sql.slice(0, MAX_RPC_SQL_CHARS)
    const boundedErrorMessage = rawErrorMessage.slice(0, MAX_RPC_ERROR_MESSAGE_CHARS)
    const boundedSchemaMap = boundRpcSchemaMap(input.schemaMap)

    const cfg = await readConfig()
    const explainCfg = cfg.explain
    assertExplainRoleConfigured(explainCfg)

    const dialect: DatabaseDriverType = input.dialect || 'sqlite'
    if (
      hasSensitiveContent(boundedSql, '', '', dialect) ||
      hasSensitiveContent(boundedErrorMessage, '', '', dialect)
    ) {
      throw createHostError(
        'invalid_params',
        'Query or error message appears to contain sensitive credentials/secrets and was not sent to AI.'
      )
    }

    const {
      connId,
      activeSchema,
      activeTable,
      expectConnectionId: expectFixConnId,
    } = resolveConnectionAiPolicyExpectation(input)
    const fixPolicy = await checkConnectionAiPolicy(
      connId,
      isLoopbackBaseUrl(explainCfg.provider.baseUrl),
      'fix',
      true,
      readOptionalBoolean(input, 'confirmed'),
      expectFixConnId
    )
    if (!fixPolicy.allowed) {
      throw createHostError(
        'not_permitted',
        fixPolicy.reason ?? 'ai.blocked: AI query fix is blocked for this connection.'
      )
    }
    await assertExplainModelCompatible(explainCfg)

    const panelId = ctx?.panel?.id || 'default'
    inflightFixByPanel.get(panelId)?.abort()
    const controller = new AbortController()
    inflightFixByPanel.set(panelId, controller)

    try {
      const referencedTables =
        dialect === 'redis'
          ? []
          : dialect === 'mongodb'
            ? extractReferencedMongoCollections(boundedSql)
            : extractReferencedTables(boundedSql, dialect)
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
              boundedSchemaMap,
              referencedTables,
              activeSchema || undefined,
              activeTable || undefined,
              MAX_FIX_QUERY_SCHEMA_CHARS
            )

      const statementCount = countFixQueryStatements(boundedSql, dialect)
      const safeErrorMessage = scrubCredentialsInText(boundedErrorMessage)
      const { system, user, resolvedLanguage } = buildFixQueryPrompt({
        dialect,
        sql: boundedSql,
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
      recordRoleRuntimeSuccess('explain', durationMs)
      void recordUsage(explainCfg.provider.baseUrl, explainCfg.provider.model, durationMs).catch(
        () => undefined
      )
      await refreshStatus()

      return sanitizeJsonPayload(result)
    } catch (err) {
      return await failExplainChatRequest(
        err,
        explainCfg,
        Boolean(controller.signal.aborted || ctx?.signal?.aborted),
        'AI query fix cancelled.'
      )
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
      disposed = true
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
