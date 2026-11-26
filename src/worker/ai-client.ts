import type {
  AiMetricKind,
  AiPresetId,
  AiProviderFormat,
  DatabaseDriverType,
} from '../protocol'
import { detectRecognizableSqlCredential } from '../drivers/common/sql-credentials'
import {
  getDialectLexerRules,
  isPostgresEscapeStringStart,
  matchDollarQuoteTag,
  scanBlockCommentEnd,
  scanBracketIdentEnd,
  scanLineCommentEnd,
  scanOracleQuoteEnd,
  scanQuotedSegmentEnd,
} from '../shared-sql-core.js'
import {
  findCredentialAuthorityAtIndex,
  isSensitiveUriParamKey,
  scrubSensitiveText,
} from '../shared-sql-safety.js'
import { doesInsertionIntroduceGrammarError } from './sql-grammar'

export type AiDialect = DatabaseDriverType

export const AI_COMPLETE_TIMEOUT_MS = 15_000
export const AI_EXPLAIN_TIMEOUT_MS = 60_000
export const AI_TEST_TIMEOUT_MS = 15_000
export const AI_MODELS_TIMEOUT_MS = 10_000
export const AI_BENCH_TIMEOUT_MS = 6000
export const AI_BENCH_MAX_TOKENS = 32
export const AI_BENCH_MAX_MODELS = 12
export const AI_BENCH_BATCH_SIZE = 4
export const AI_MODEL_LIST_MAX_SHOWN = 100
export const AI_SHORT_LIST_MAX = 15
export const AI_ANTHROPIC_VERSION = '2023-06-01'
export const AI_PREFIX_CHARS = 6000
export const AI_SUFFIX_CHARS = 2000
export const AI_SECRET_MARGIN_CHARS = 2000
export const AI_RPC_MAX_PREFIX_CHARS = AI_PREFIX_CHARS + AI_SECRET_MARGIN_CHARS
export const AI_RPC_MAX_SUFFIX_CHARS = AI_SUFFIX_CHARS + AI_SECRET_MARGIN_CHARS
export const AI_MAX_COMPLETION_BODY_BYTES = 256 * 1024
export const AI_MAX_EXPLAIN_BODY_BYTES = 1024 * 1024
export const AI_MAX_MODELS_BODY_BYTES = 2 * 1024 * 1024
export const AI_EVENT_KINDS = ['shown', 'accepted', 'partial', 'kept', 'undone', 'stale'] as const

const FORMATS: readonly AiProviderFormat[] = ['openai', 'anthropic', 'ollama', 'mistral-fim']
const FIM_TEMPERATURE = 0.01
const OLLAMA_NUM_CTX = 4096
const OLLAMA_MAX_ADAPTIVE_NUM_CTX = 16384
const OLLAMA_KEEP_ALIVE = '30m'
const ECHO_MAX_LINES = 24
const ECHO_MIN_CHARS = 3
const OVERLAP_PROBE_CHARS = 30
const OVERLAP_MIN_PROBE_CHARS = 8
const LATENCY_SAMPLES = 50
const STATS_MODELS_KEPT = 40
const RECOMMENDED_COUNT = 3
const AI_CHAT_RETRY_DELAY_MS = 750
const TRANSIENT_GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])
export const CHAT_INLINE_TEMPERATURE = 0.01
const MAX_HOSTED_STOP_SEQUENCES = 4

export interface AiProviderConfig {
  format: AiProviderFormat
  baseUrl: string
  model: string
  apiKey: string
  maxTokens: number
}

export interface AiPreset {
  id: AiPresetId
  format: AiProviderFormat
  baseUrl: string | null
  model: string
  keyKind: 'required' | 'optional' | 'none'
  bench: 'off' | 'all' | 'some'
}

export const AI_PRESETS: readonly AiPreset[] = [
  { id: 'openai', format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyKind: 'required', bench: 'off' },
  { id: 'anthropic', format: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5', keyKind: 'required', bench: 'off' },
  { id: 'openrouter', format: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'mistralai/codestral-2508', keyKind: 'required', bench: 'some' },
  { id: 'ollama', format: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:1.5b', keyKind: 'none', bench: 'all' },
  { id: 'mistral', format: 'mistral-fim', baseUrl: 'https://api.mistral.ai/v1', model: 'codestral-latest', keyKind: 'required', bench: 'off' },
  { id: 'custom-openai', format: 'openai', baseUrl: null, model: '', keyKind: 'optional', bench: 'some' },
  { id: 'custom-anthropic', format: 'anthropic', baseUrl: null, model: '', keyKind: 'optional', bench: 'some' },
]

export function parseFormat(value: unknown): AiProviderFormat {
  return FORMATS.find((f) => f === value) ?? 'openai'
}

const FIM_ONLY_MODEL_RE =
  /(?:^|[:/_-])(base|fim)(?:$|[:_-])|(?:^|\/)(?:mellum|starcoder|sweep-next-edit)|-base$/i

export function isChatIncompatibleBaseModel(model: string): boolean {
  const trimmed = typeof model === 'string' ? model.trim() : ''
  if (!trimmed) return false
  return FIM_ONLY_MODEL_RE.test(trimmed)
}

export function isFimOnlyModel(format: AiProviderFormat, model: string): boolean {
  if (format === 'mistral-fim') return true
  return isChatIncompatibleBaseModel(model)
}

export function isQwenCoderModel(model: string): boolean {
  const trimmed = typeof model === 'string' ? model.trim() : ''
  return /qwen.*coder/i.test(trimmed)
}

export function sameAddress(a: string, b: string): boolean {
  const norm = (url: string): string => {
    try {
      const parsed = new URL(url.trim())
      const pathname = parsed.pathname.replace(/\/+$/, '')
      return `${parsed.origin.toLowerCase()}${pathname}${parsed.search}`
    } catch {
      return ''
    }
  }
  const na = norm(a)
  return na !== '' && na === norm(b)
}

export function presetFor(format: AiProviderFormat, baseUrl: string): AiPreset {
  const known = AI_PRESETS.find((p) => p.baseUrl !== null && p.format === format && sameAddress(baseUrl, p.baseUrl))
  const fallback = AI_PRESETS.find((p) => p.id === `custom-${format}`) ?? AI_PRESETS.find((p) => p.format === format)
  return known ?? fallback ?? AI_PRESETS[0]
}

export function presetById(id: string): AiPreset {
  return AI_PRESETS.find((p) => p.id === id) ?? AI_PRESETS[0]
}

export function withV1(base: string): string {
  const root = base.trim().replace(/\/+$/, '')
  return /\/v1$/i.test(root) ? root : `${root}/v1`
}

export function withoutV1(base: string): string {
  return base.trim().replace(/\/+$/, '').replace(/\/v1$/i, '')
}

function joinUrl(base: string, path: string): string {
  return `${base.trim().replace(/\/+$/, '')}${path}`
}

export interface BuiltPostRequest {
  url: string
  init: { method: 'POST'; headers: Record<string, string>; body: string }
}

const postJson = (url: string, headers: Record<string, string>, body: object): BuiltPostRequest => ({
  url,
  init: { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
})

const bearer = (apiKey: string): Record<string, string> => (apiKey ? { authorization: `Bearer ${apiKey}` } : {})

function resolveOllamaChatNumCtx(
  system: string,
  user: string,
  maxTokens: number,
  extraBody?: Record<string, unknown>
): number {
  if (extraBody && 'num_ctx' in extraBody) {
    const raw = extraBody.num_ctx
    if (typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')) {
      const explicit = Math.trunc(Number(raw))
      if (Number.isFinite(explicit) && explicit > 0) {
        return explicit
      }
    }
  }
  const safeMaxTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.trunc(maxTokens) : 0
  const estimatedTokens =
    Math.ceil((system.length + user.length) / 3) + safeMaxTokens + 256
  if (estimatedTokens <= OLLAMA_NUM_CTX) {
    return OLLAMA_NUM_CTX
  }
  return Math.min(OLLAMA_MAX_ADAPTIVE_NUM_CTX, Math.ceil(estimatedTokens / 1024) * 1024)
}

/** Builds a chat completion request across all 4 formats (used for chat inline completion and EXPLAIN analysis). */
export function buildChatRequest(
  provider: AiProviderConfig,
  system: string,
  user: string,
  maxTokens: number,
  extraBody?: Record<string, unknown>,
  stream = false
): BuiltPostRequest {
  if (provider.format === 'anthropic') {
    return postJson(
      joinUrl(withV1(provider.baseUrl), '/messages'),
      {
        'anthropic-version': AI_ANTHROPIC_VERSION,
        ...(provider.apiKey ? { 'x-api-key': provider.apiKey } : {}),
      },
      {
        ...(extraBody ?? {}),
        model: provider.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
        ...(stream ? { stream: true } : {}),
      }
    )
  }
  if (provider.format === 'ollama') {
    const options: Record<string, unknown> = {
      num_ctx: resolveOllamaChatNumCtx(system, user, maxTokens, extraBody),
      num_predict: maxTokens,
    }
    if (
      extraBody &&
      'temperature' in extraBody &&
      typeof extraBody.temperature === 'number' &&
      Number.isFinite(extraBody.temperature)
    ) {
      options.temperature = extraBody.temperature
    }
    if (extraBody && 'stop' in extraBody && Array.isArray(extraBody.stop)) {
      options.stop = extraBody.stop
    }
    return postJson(joinUrl(withoutV1(provider.baseUrl), '/api/chat'), bearer(provider.apiKey), {
      model: provider.model,
      stream,
      keep_alive: OLLAMA_KEEP_ALIVE,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      options,
    })
  }
  const chatRoot = provider.format === 'mistral-fim' ? withV1(provider.baseUrl) : provider.baseUrl
  return postJson(joinUrl(chatRoot, '/chat/completions'), bearer(provider.apiKey), {
    ...(extraBody ?? {}),
    ...(stream ? { stream: true } : {}),
    model: provider.model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  })
}

export interface AiCompletionRequest {
  dialect?: AiDialect
  system: string
  user: string
  prefix: string
  suffix: string
  fimPrefix?: string
  fimSuffix?: string
  fimSchemaDdl?: string
  fimHistorySql?: string
  fimPriorSql?: string
  multiline?: boolean
  knownIdentifiers?: Iterable<string>
}

export interface LeadingTokenReplacement {
  suggestion: string
  replaceChars: number
}

export interface ResolvedTrailingTypoToken {
  rawWord: string
  trailingSpaces: string
  correctedWord: string
  replaceChars: number
  healedPrefix: string
}

export interface SqlCompletionResult {
  suggestion: string
  replaceChars: number
}

export type CompleteSqlParams = AiCompletionRequest

const MODEL_FIM_STOP_RULES: readonly { pattern: RegExp; stops: readonly string[] }[] = [
  {
    pattern: /qwen/i,
    stops: [
      '<|endoftext|>',
      '<|fim_prefix|>',
      '<|fim_middle|>',
      '<|fim_suffix|>',
      '<|fim_pad|>',
      '<|file_sep|>',
      '<|repo_name|>',
      '<|im_start|>',
      '<|im_end|>',
    ],
  },
  {
    pattern: /codestral/i,
    stops: ['[PREFIX]', '[SUFFIX]'],
  },
  {
    pattern: /deepseek/i,
    stops: ['<｜fim▁begin｜>', '<｜fim▁hole｜>', '<｜fim▁end｜>', '<｜end▁of▁sentence｜>'],
  },
  {
    pattern: /codegemma/i,
    stops: ['<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', '<|file_separator|>', '<end_of_turn>'],
  },
  {
    pattern: /codellama|code-llama/i,
    stops: ['<PRE>', '<SUF>', '<MID>', '<EOT>'],
  },
  {
    pattern: /starcoder|star-coder|stable-?code|granite|seed/i,
    stops: ['<fim_prefix>', '<fim_suffix>', '<fim_middle>', '<file_sep>', '<|endoftext|>'],
  },
]

export function getModelFimStopTokens(model: string): string[] {
  const name = model || ''
  for (const rule of MODEL_FIM_STOP_RULES) {
    if (rule.pattern.test(name)) {
      return [...rule.stops]
    }
  }
  return []
}

export function buildCompletionRequest(
  provider: AiProviderConfig,
  req: AiCompletionRequest,
  extraBody?: Record<string, unknown>,
  stream = false,
  stop?: string[]
): BuiltPostRequest {
  const prefix = (req.fimPrefix ?? req.prefix).slice(-AI_PREFIX_CHARS)
  const suffix = (req.fimSuffix ?? req.suffix).slice(0, AI_SUFFIX_CHARS)
  const effectiveSuffix = suffix || '\n'
  const stopList =
    stop ??
    (Array.isArray(extraBody?.stop)
      ? extraBody.stop.filter((value): value is string => typeof value === 'string')
      : undefined)
  const hasStop = stopList !== undefined && stopList.length > 0
  if (provider.format === 'ollama') {
    const schemaDdl = typeof req.fimSchemaDdl === 'string' ? req.fimSchemaDdl.trim() : ''
    const historySql = typeof req.fimHistorySql === 'string' ? req.fimHistorySql.trim() : ''
    const priorTabSql = typeof req.fimPriorSql === 'string' ? req.fimPriorSql.trim() : ''
    if (
      isQwenCoderModel(provider.model) &&
      (schemaDdl.length > 0 || historySql.length > 0 || priorTabSql.length > 0)
    ) {
      const rawPrefix = req.prefix.slice(-AI_PREFIX_CHARS)
      const repoName = req.dialect || 'sql'
      const schemaBlock = schemaDdl ? `<|file_sep|>schema.sql\n${schemaDdl}\n` : ''
      const historyBlock = historySql ? `<|file_sep|>history.sql\n${historySql}\n` : ''
      const recentBlock = priorTabSql ? `<|file_sep|>recent.sql\n${priorTabSql}\n` : ''
      const rawPrompt =
        `<|repo_name|>${repoName}\n` +
        schemaBlock +
        historyBlock +
        recentBlock +
        `<|file_sep|>query.sql\n` +
        `<|fim_prefix|>${rawPrefix}<|fim_suffix|>${effectiveSuffix}<|fim_middle|>`
      return postJson(joinUrl(withoutV1(provider.baseUrl), '/api/generate'), bearer(provider.apiKey), {
        model: provider.model,
        prompt: rawPrompt,
        raw: true,
        stream,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: {
          num_ctx: resolveOllamaChatNumCtx('', rawPrompt, provider.maxTokens, extraBody),
          num_predict: provider.maxTokens,
          temperature: FIM_TEMPERATURE,
          ...(hasStop ? { stop: stopList } : {}),
        },
      })
    }
    return postJson(joinUrl(withoutV1(provider.baseUrl), '/api/generate'), bearer(provider.apiKey), {
      model: provider.model,
      prompt: prefix,
      suffix: effectiveSuffix,
      stream,
      keep_alive: OLLAMA_KEEP_ALIVE,
      options: {
        num_ctx: resolveOllamaChatNumCtx(prefix, effectiveSuffix, provider.maxTokens, extraBody),
        num_predict: provider.maxTokens,
        temperature: FIM_TEMPERATURE,
        ...(hasStop ? { stop: stopList } : {}),
      },
    })
  }
  if (provider.format === 'mistral-fim') {
    return postJson(joinUrl(withV1(provider.baseUrl), '/fim/completions'), bearer(provider.apiKey), {
      model: provider.model,
      prompt: prefix,
      suffix: effectiveSuffix,
      max_tokens: provider.maxTokens,
      temperature: FIM_TEMPERATURE,
      stream,
      ...(hasStop ? { stop: stopList.slice(0, MAX_HOSTED_STOP_SEQUENCES) } : {}),
    })
  }
  const extra: Record<string, unknown> = { ...(extraBody ?? {}) }
  delete extra.stop
  if (provider.format === 'anthropic') {
    if (hasStop) extra.stop_sequences = stopList
  } else if (hasStop) {
    extra.stop = stopList
  }
  return buildChatRequest(provider, req.system, req.user, provider.maxTokens, extra, stream)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function extractCompletionText(format: AiProviderFormat, json: unknown): string {
  if (!isRecord(json)) return ''
  if (format === 'ollama') {
    return typeof json.response === 'string' ? json.response : ''
  }
  if (format === 'anthropic') {
    const blocks = Array.isArray(json.content) ? json.content : []
    return blocks
      .map((b) => (isRecord(b) && b.type === 'text' ? String(b.text ?? '') : ''))
      .join('')
  }
  const choices = Array.isArray(json.choices) ? json.choices : []
  const first = choices[0]
  const message = isRecord(first) && isRecord(first.message) ? first.message : null
  if (typeof message?.content === 'string') return message.content
  if (Array.isArray(message?.content)) {
    return message.content
      .map((b) => (isRecord(b) && (b.type === 'text' || b.text !== undefined) ? String(b.text ?? '') : ''))
      .join('')
  }
  return isRecord(first) && typeof first.text === 'string' ? first.text : ''
}

export function extractChatText(format: AiProviderFormat, json: unknown): string {
  if (!isRecord(json)) return ''
  if (format === 'ollama') {
    const msg = isRecord(json.message) ? json.message : null
    if (typeof msg?.content === 'string') return msg.content
    return typeof json.response === 'string' ? json.response : ''
  }
  return extractCompletionText(format, json)
}

const PLACEHOLDER_RE =
  /^(?:x{3,}|\*{3,}|\.{3,}|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|your[_-].*|example.*|changeme|placeholder.*|secret|password|token)$/i

const SECRET_RULES: readonly { kind: string; pattern: RegExp }[] = [
  { kind: 'private key', pattern: /-----(?:BEGIN|END) (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'key body', pattern: /(?:^[ \t]*["']?[A-Za-z0-9+/]{60,80}={0,2}["']?[ \t]*,?[ \t]*\r?\n){3}/m },
  { kind: 'key body', pattern: /(?:[A-Za-z0-9+/]{60,80}={0,2}\\n){3}/ },
  { kind: 'AWS access key', pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/ },
  { kind: 'AWS secret key', pattern: /aws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}\b/i },
  { kind: 'API key (sk-)', pattern: /\bsk-(?:ant-|proj-|live-|or-)?[A-Za-z0-9_-]{20,}/ },
  { kind: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { kind: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'Stripe key', pattern: /\b[sr]k_(?:live|test)_[0-9a-zA-Z]{16,}/ },
  { kind: 'JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { kind: 'password in a URL', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:[^\s@/"']{3,}@/i },
]

const ASSIGNED_SECRET_RE =
  /(?:[a-zA-Z0-9_.-]*(?:pass(?:word|wd)?|secret|api[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key|token)|(?<![a-zA-Z])pwd)["']?\s*[:=]\s*["']([^"'\r\n\s]{6,})(?:["']|$)/gi

const SQL_KEY_VALUE_SECRET_TUPLE_RE =
  /["'](?:[a-zA-Z0-9_.-]*(?:pass(?:word|wd)?|secret|api[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key|token))["']\s*,\s*["']([^"'\r\n\s]{6,})(?:["']|$)/gi

const UNQUOTED_CONN_PASSWORD_RE =
  /(?:^|[\s;'",(])(?:password|passwd|pwd)\s*=\s*([^\s;'")}\]]{4,})/gi

const ORACLE_DBLINK_CRED_RE =
  /\bCREATE\s+(?:SHARED\s+)?(?:PUBLIC\s+)?DATABASE\s+LINK\b[\s\S]{0,160}?\bIDENTIFIED\s+BY\s+(?:["']([^"'\r\n]+)(?:["']|$)|([^\s;,'")]+))/gi

const ORACLE_EASY_CONNECT_CRED_RE =
  /(?:^|[\s'"(,;])([A-Za-z][A-Za-z0-9_$#]{0,63})\/([^\s@/'",;()]{4,})@(?:\/\/)?(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9_.-]+):(\d{1,5})\/[A-Za-z0-9_.$#-]+/g

const UNCLOSED_SQL_CRED_TAIL_RE =
  /\b(?:(?:CREATE|ALTER)\s+(?:USER|ROLE|LOGIN)\b[\s\S]{0,160}?\b(?:PASSWORD\s*=?\s*|IDENTIFIED\s+BY\s+)|SET\s+PASSWORD\b[\s\S]{0,80}?=\s*)(?:N)?(['"])([^'"\r\n]{4,})$/i

const SQL_CRED_CLAUSE_START_RE = /\b(?:CREATE|ALTER|SET\s+PASSWORD|GRANT)\b/gi

const MONGO_USER_AUTH_CALL_RE =
  /\b(?:changeUserPassword|auth)\s*\(\s*["'][^"']+["']\s*,\s*["']([^"'\s]{4,})["']/gi

const AUTH_HEADER_SECRET_RE =
  /\bAuthorization\s*[:=]\s*(?:Bearer|Basic)[ \t]+([^\s,;'"`}\])<>]+)/gi

const STANDALONE_BEARER_RE =
  /\bBearer[ \t]+([A-Za-z0-9._~+/=-]{12,})(?=$|[\s,;'"`}\])<>])/gi

const BEARER_PROSE_WORD_RE =
  /^(?:authentication|authorization|credentials?|token|certificate|instrument)$/i

const STANDALONE_BASIC_RE =
  /\bBasic[ \t]+([A-Za-z0-9+/]{8,}={0,2})(?=$|[\s,;'"`}\])<>])/g

const URI_SCHEME_SCAN_RE = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)/gi

const URI_WITH_QUERY_OR_FRAG_RE =
  /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s'"`<>}\]]+([?#][^\s'"`<>}\]]+)/gi

const SAFE_ASSIGNED_LITERAL_RE = /^(?:true|false|null|none|empty|default|unknown|active|inactive|pending|disabled|enabled)$/i

function isLikelyAssignedSecretValue(val: string): boolean {
  if (!val || val.length < 6) return false
  if (val === '[REDACTED]' || val === '***') return false
  if (PLACEHOLDER_RE.test(val) || SAFE_ASSIGNED_LITERAL_RE.test(val)) return false
  if (val.startsWith('/') || /^[A-Za-z]:\\/.test(val)) return false
  if (val.length < 16) {
    // Reject obvious placeholder words/identifiers without digit/symbol/mixed-case entropy
    const hasDigit = /\d/.test(val)
    const hasSymbol = /[^A-Za-z0-9]/.test(val)
    const hasMixedCase = /[A-Z]/.test(val) && /[a-z]/.test(val)
    if (!hasDigit && !hasSymbol && !hasMixedCase) return false
  }
  return true
}

function hasSensitiveKvParams(segment: string): boolean {
  for (const pair of segment.split('&')) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx <= 0) continue
    const rawKey = pair.slice(0, eqIdx)
    const rawVal = pair.slice(eqIdx + 1)
    let val = rawVal
    try {
      val = decodeURIComponent(rawVal)
    } catch {
      // Keep rawVal when percent-encoding is partial
    }
    if (
      isSensitiveUriParamKey(rawKey) &&
      val.length >= 4 &&
      !PLACEHOLDER_RE.test(val) &&
      val !== '***' &&
      val !== '[REDACTED]'
    ) {
      return true
    }
  }
  return false
}

function scanTextForSecret(text: string, dialect?: AiDialect): string | null {
  for (const { kind, pattern } of SECRET_RULES) {
    if (pattern.test(text)) return kind
  }
  // Catch URI passwords even when password contains `/` or `@` via shared authority parser
  for (const match of text.matchAll(URI_SCHEME_SCAN_RE)) {
    const scheme = match[1]
    const idx = match.index ?? 0
    const restStart = idx + scheme.length
    const tailEnd = text.slice(restStart).search(/[\s'"`<>}\])]/)
    const body = tailEnd === -1 ? text.slice(restStart) : text.slice(restStart, restStart + tailEnd)
    const colonIdx = body.indexOf(':')
    if (colonIdx > 0) {
      const atIdx = findCredentialAuthorityAtIndex(scheme, body, colonIdx)
      if (atIdx > colonIdx) {
        const pw = body.slice(colonIdx + 1, atIdx)
        if (pw.length >= 3 && pw !== '***' && pw !== '[REDACTED]' && !PLACEHOLDER_RE.test(pw)) {
          return 'password in a URL'
        }
      }
    }
  }
  for (const match of text.matchAll(AUTH_HEADER_SECRET_RE)) {
    const val = match[1]
    if (val.length >= 4 && val !== '[REDACTED]' && val !== '***' && !PLACEHOLDER_RE.test(val)) {
      return 'Authorization header'
    }
  }
  for (const match of text.matchAll(STANDALONE_BEARER_RE)) {
    const val = match[1]
    if (
      val !== '[REDACTED]' &&
      !PLACEHOLDER_RE.test(val) &&
      !BEARER_PROSE_WORD_RE.test(val)
    ) {
      return 'Bearer token'
    }
  }
  for (const match of text.matchAll(STANDALONE_BASIC_RE)) {
    const val = match[1]
    const looksLikeBase64Cred =
      val.endsWith('=') ||
      (/[A-Z]/.test(val) && /[a-z]/.test(val) && /\d/.test(val)) ||
      val.length >= 16
    if (looksLikeBase64Cred && !PLACEHOLDER_RE.test(val)) {
      return 'Basic auth credential'
    }
  }
  for (const match of text.matchAll(URI_WITH_QUERY_OR_FRAG_RE)) {
    const tail = match[1]
    const hashIdx = tail.indexOf('#')
    const queryPart = tail.startsWith('?')
      ? hashIdx >= 0
        ? tail.slice(1, hashIdx)
        : tail.slice(1)
      : ''
    const fragPart = hashIdx >= 0 ? tail.slice(hashIdx + 1) : ''
    if (queryPart && hasSensitiveKvParams(queryPart)) {
      return 'sensitive URI query parameter'
    }
    if (fragPart && hasSensitiveKvParams(fragPart)) {
      return 'sensitive URI fragment parameter'
    }
  }
  for (const match of text.matchAll(ASSIGNED_SECRET_RE)) {
    if (isLikelyAssignedSecretValue(match[1])) {
      return 'secret assigned in code'
    }
  }
  for (const match of text.matchAll(SQL_KEY_VALUE_SECRET_TUPLE_RE)) {
    if (isLikelyAssignedSecretValue(match[1])) {
      return 'secret assigned in code'
    }
  }
  for (const match of text.matchAll(UNQUOTED_CONN_PASSWORD_RE)) {
    const val = match[1]
    if (
      val !== '[REDACTED]' &&
      val !== '***' &&
      !val.startsWith(':') &&
      !val.startsWith('$') &&
      !val.startsWith('@') &&
      !val.startsWith('?') &&
      !PLACEHOLDER_RE.test(val) &&
      !SAFE_ASSIGNED_LITERAL_RE.test(val) &&
      !val.startsWith('/') &&
      !/^[A-Za-z]:\\/.test(val) &&
      (/[0-9]/.test(val) || /[^A-Za-z0-9_]/.test(val) || (/[A-Z]/.test(val) && /[a-z]/.test(val)) || val.length >= 12)
    ) {
      return 'connection string password'
    }
  }
  for (const match of text.matchAll(ORACLE_DBLINK_CRED_RE)) {
    const val = match[1] ?? match[2] ?? ''
    if (val && !PLACEHOLDER_RE.test(val) && !/^[:?$@]/.test(val)) {
      return 'sql-auth-literal'
    }
  }
  for (const match of text.matchAll(ORACLE_EASY_CONNECT_CRED_RE)) {
    const pw = match[2]
    if (pw && !PLACEHOLDER_RE.test(pw)) {
      return 'Oracle Easy Connect credential'
    }
  }
  const unclosedCred = UNCLOSED_SQL_CRED_TAIL_RE.exec(text)
  if (unclosedCred && !PLACEHOLDER_RE.test(unclosedCred[2])) {
    return 'sql-auth-literal'
  }
  for (const match of text.matchAll(MONGO_USER_AUTH_CALL_RE)) {
    if (!PLACEHOLDER_RE.test(match[1])) {
      return 'sql-auth-literal'
    }
  }
  const sqlCred = detectRecognizableSqlCredential(text, dialect)
  if (sqlCred) return sqlCred
  // Scan SQL credential statement slices so prompt prefixes ("Broken SQL query:\nCREATE USER ...") cannot mask DDL credentials
  for (const match of text.matchAll(SQL_CRED_CLAUSE_START_RE)) {
    const startIdx = match.index ?? 0
    if (startIdx === 0) continue
    const slice = text.slice(startIdx)
    const nestedCred = detectRecognizableSqlCredential(slice, dialect)
    if (nestedCred) return nestedCred
    const unclosedNested = UNCLOSED_SQL_CRED_TAIL_RE.exec(slice)
    if (unclosedNested && !PLACEHOLDER_RE.test(unclosedNested[2])) {
      return 'sql-auth-literal'
    }
  }
  return null
}

export function hasSensitiveContent(
  before: string,
  after: string,
  extra = '',
  dialect?: AiDialect
): string | null {
  return (
    scanTextForSecret(`${extra}\n${before}\n${after}`, dialect) ??
    scanTextForSecret(`${before}${after}`, dialect)
  )
}

const TOOL_MARKUP_RE = /<tool_call>|<function=|<parameter=|<\/(?:tool_call|function|parameter)>/

export function looksInjected(answer: string): boolean {
  return TOOL_MARKUP_RE.test(answer)
}

const SPECIAL_TOKENS_RE =
  /<\/?CURSOR>|<COMPLETION>|\[\/?CODE\]|<\|[A-Za-z0-9_:-]{1,32}\|?>|<｜[^｜\r\n]{1,32}｜>/gi

const TRAILING_TRUNCATED_SPECIAL_TOKEN_RE = /<\|[A-Za-z0-9_:-]*$/i

const TRAILING_SPECIAL_MARKER_RE =
  /(?:<\/?CURSOR>|\[\/CODE\]|<\|[A-Za-z0-9_:-]{1,32}\|?>|<｜[^｜\r\n]{1,32}｜>|<\|[A-Za-z0-9_:-]*)[ \t]*$/i

export function stripSpecialCompletionTokens(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(SPECIAL_TOKENS_RE, '')
    .replace(TRAILING_TRUNCATED_SPECIAL_TOKEN_RE, '')
}

function lineDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[b.length]
}

function isSimilarLine(a: string, b: string): boolean {
  const threshold = Math.max(0.1 * a.length, 0.1 * b.length)
  return lineDistance(a, b) <= threshold
}

const MAX_LINE_CYCLE_PERIOD = 8

function collectNonEmptyIndices(items: readonly string[]): number[] {
  const indices: number[] = []
  for (let i = 0; i < items.length; i++) {
    if (items[i].trim().length > 0) indices.push(i)
  }
  return indices
}

function findTrailingLineCycleKeepEnd(
  lines: readonly string[],
  nonEmpty: readonly number[]
): number | null {
  const total = nonEmpty.length
  const maxPeriod = Math.min(MAX_LINE_CYCLE_PERIOD, Math.floor(total / 2))
  for (let period = 1; period <= maxPeriod; period++) {
    const minCycles = period === 1 ? 3 : 2
    let cycles = 1
    while ((cycles + 1) * period <= total) {
      const baseStart = total - (cycles + 1) * period
      const tailStart = total - period
      let matches = true
      for (let offset = 0; offset < period; offset++) {
        if (lines[nonEmpty[baseStart + offset]].trim() !== lines[nonEmpty[tailStart + offset]].trim()) {
          matches = false
          break
        }
      }
      if (!matches) break
      cycles++
    }
    if (cycles >= minCycles) {
      return nonEmpty[total - cycles * period + period - 1]
    }
  }
  return null
}

export function removeRepetitiveLines(text: string): string {
  const lines = text.split('\n')
  const nonEmpty = collectNonEmptyIndices(lines)
  if (nonEmpty.length < 3) return text
  const cycleEnd = findTrailingLineCycleKeepEnd(lines, nonEmpty)
  if (cycleEnd !== null) {
    return lines.slice(0, cycleEnd + 1).join('\n').trimEnd()
  }
  let repetitionCount = 0
  let pos = nonEmpty.length - 1
  while (pos >= 1) {
    if (isSimilarLine(lines[nonEmpty[pos]].trim(), lines[nonEmpty[pos - 1]].trim())) {
      repetitionCount++
      pos--
    } else {
      break
    }
  }
  return repetitionCount >= 5 ? lines.slice(0, nonEmpty[pos] + 1).join('\n').trimEnd() : text
}

export function removeRepetitiveBlocks(text: string): string {
  const blocks = text.split(/\n\s*\n/)
  const nonEmpty = collectNonEmptyIndices(blocks)
  let repetitionCount = 0
  let pos = nonEmpty.length - 1
  while (pos >= 1) {
    if (isSimilarLine(blocks[nonEmpty[pos]].trim(), blocks[nonEmpty[pos - 1]].trim())) {
      repetitionCount++
      pos--
    } else {
      break
    }
  }
  return repetitionCount >= 2 ? blocks.slice(0, nonEmpty[pos] + 1).join('\n\n').trimEnd() : text
}

function leadingNonBlankLines(text: string, max: number): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    out.push(line)
    if (out.length >= max) break
  }
  return out
}

function findLineBoundarySuffixMatch(text: string, needle: string): number {
  let i = text.indexOf('\n')
  while (i !== -1) {
    let ws = i + 1
    while (ws < text.length && (text[ws] === ' ' || text[ws] === '\t')) ws += 1
    if (text.startsWith(needle, ws)) {
      let after = ws + needle.length
      while (after < text.length && (text[after] === ' ' || text[after] === '\t')) after += 1
      if (after === text.length || text[after] === '\r' || text[after] === '\n') {
        return text[i - 1] === '\r' ? i - 1 : i
      }
    }
    i = text.indexOf('\n', i + 1)
  }
  return -1
}

function findInlineSuffixChopOutsideQuotes(text: string, needle: string): number {
  let inQuote: "'" | '"' | '`' | null = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuote) {
      if (ch === '\\' && inQuote !== '`') {
        i += 1
        continue
      }
      if (ch === inQuote) {
        if (text[i + 1] === inQuote) {
          i += 1
          continue
        }
        inQuote = null
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inQuote = ch
      continue
    }
    if (i > 0 && /[\s,;(\[]/.test(text[i - 1]) && text.startsWith(needle, i)) {
      return i
    }
  }
  return -1
}

export function dropDuplicatedFromSuffix(text: string, suffix: string): string {
  const textLines = leadingNonBlankLines(text, 3)
  const suffixLines = leadingNonBlankLines(suffix, 3)
  const count = Math.min(3, textLines.length, suffixLines.length)
  if (count === 1) {
    const normA = textLines[0].replace(/[ \t]+/g, ' ').trim().toLowerCase()
    const normB = suffixLines[0].replace(/[ \t]+/g, ' ').trim().toLowerCase()
    if (normA && normA === normB) return ''
  } else if (count >= 2) {
    const a = textLines.slice(0, count).join('\n').trim()
    const b = suffixLines.slice(0, count).join('\n').trim()
    const threshold = Math.max(1, 0.05 * a.length, 0.05 * b.length)
    if (lineDistance(a, b) <= threshold) return ''
  }
  const firstSuffixLine = suffixLines[0]?.trim()
  if (firstSuffixLine && /\w/.test(firstSuffixLine)) {
    const lineAt = findLineBoundarySuffixMatch(text, firstSuffixLine)
    if (lineAt > 0) {
      return text.slice(0, lineAt).trimEnd()
    }
    if (firstSuffixLine.length >= 6) {
      const inlineAt = findInlineSuffixChopOutsideQuotes(text, firstSuffixLine)
      if (inlineAt > 0) {
        const before = text.slice(0, inlineAt)
        const trimmed = before.trimEnd()
        if (
          trimmed.length > 0 &&
          /[ \t]+$/.test(before) &&
          suffix.length > 0 &&
          !/^\s/.test(suffix) &&
          /^[A-Za-z0-9_]/.test(suffix)
        ) {
          return `${trimmed} `
        }
        return trimmed
      }
    }
  }
  return text
}

export function trimMultiLineInSingleLineMode(
  text: string,
  suffix: string,
  multiline: boolean
): string {
  if (multiline) return text
  const lines = text.split('\n')
  if (lines.length <= 1) return text
  const firstIdx = lines.findIndex((l) => l.trim().length > 0)
  const rawFirst = firstIdx === -1 ? lines[0] : lines[firstIdx]
  const suffixLine = suffix.slice(0, suffix.indexOf('\n') === -1 ? suffix.length : suffix.indexOf('\n')).trimEnd()
  const firstTrimmedEnd = rawFirst.trimEnd()
  if (suffixLine && firstTrimmedEnd.endsWith(suffixLine)) {
    return firstTrimmedEnd.slice(0, firstTrimmedEnd.length - suffixLine.length)
  }
  if (
    firstTrimmedEnd.length > 0 &&
    /[ \t]+$/.test(rawFirst) &&
    suffix.length > 0 &&
    !/^\s/.test(suffix) &&
    /^[A-Za-z0-9_]/.test(suffix)
  ) {
    return `${firstTrimmedEnd} `
  }
  return firstTrimmedEnd
}

function extractCompletionTagContent(raw: string): string {
  const openMatch = /<COMPLETION>/i.exec(raw)
  if (openMatch) {
    const afterOpen = raw.slice(openMatch.index + openMatch[0].length)
    const closeIdx = afterOpen.search(/<\/COMPLETION>/i)
    return closeIdx === -1 ? afterOpen : afterOpen.slice(0, closeIdx)
  }
  const closeIdx = raw.search(/<\/COMPLETION>/i)
  return closeIdx === -1 ? raw : raw.slice(0, closeIdx)
}

function unwrapSingleBacktickInline(text: string, prefix: string, dialect?: AiDialect): string {
  const trimmed = text.trim()
  if (!trimmed || trimmed.includes('\n') || trimmed.includes('\r')) return text
  const state = scanSqlBoundaryState(prefix, dialect)
  if (state.inQuote === '`' || state.inQuote === "'") return text
  const closed = /^`([^`\r\n]+)`$/.exec(trimmed)
  if (closed) {
    const inner = closed[1]
    if (dialect !== 'mysql' || /[\s*(),;=]/.test(inner) || prefix.toLowerCase().endsWith(inner.slice(0, 2).toLowerCase())) {
      return inner
    }
    return text
  }
  if (dialect !== 'mysql' && trimmed.startsWith('`') && !trimmed.slice(1).includes('`')) {
    const afterTick = trimmed.slice(1)
    if (/^[A-Za-z_*(]/.test(afterTick)) {
      return afterTick
    }
  }
  return text
}

function extractUnfencedSuggestion(raw: string, prefix = '', dialect?: AiDialect): string {
  const withoutThink = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
  const tagExtracted = extractCompletionTagContent(withoutThink)
  const stripped = stripSpecialCompletionTokens(tagExtracted)
  let text = stripped
  if (stripped !== tagExtracted) {
    text = text.replace(/^\r?\n+/, '')
  } else if (/<COMPLETION>/i.test(withoutThink)) {
    text = text.replace(/^(?:\r?\n)+/, '')
  }
  const fenced = /^\s*```[^\n]*\n([\s\S]*?)\n?```[\s\S]*$/.exec(text)
  if (fenced) return fenced[1]
  const preambleFenced = /^[A-Za-z][^\n`]{0,60}:\s*\r?\n```[^\n]*\n([\s\S]*?)\n?```[\s\S]*$/.exec(text)
  if (preambleFenced) return preambleFenced[1]
  const unclosed = /^\s*```[^\n]*\n([\s\S]*)$/.exec(text)
  if (unclosed) return unclosed[1]
  return unwrapSingleBacktickInline(text, prefix, dialect)
}

function stripTrailingCaretPipe(
  suggestion: string,
  prefix = '',
  dialect?: AiDialect,
  hadTrailingMarker = false
): string {
  if (!suggestion || dialect === 'redis') return suggestion
  let out = suggestion
  if (scanSqlBoundaryState(`${prefix}${out}`, dialect).inQuote === null) {
    const withoutPipe = out.replace(/(?<!\|)\|[ \t]*$/, '')
    if (withoutPipe !== out) {
      out = withoutPipe.replace(/[ \t]+$/, '')
    } else if (hadTrailingMarker) {
      out = out.replace(/[ \t]+$/, '')
    }
  }
  return out
}

export function cleanSuggestion(raw: string, prefix = '', dialect?: AiDialect): string {
  const hadTrailingMarker = TRAILING_SPECIAL_MARKER_RE.test(raw)
  return stripTrailingCaretPipe(extractUnfencedSuggestion(raw, prefix, dialect), prefix, dialect, hadTrailingMarker)
}

const STANDALONE_SQL_CLAUSE_KEYWORDS: ReadonlySet<string> = new Set([
  'WHERE',
  'ORDER',
  'GROUP',
  'HAVING',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'OUTER',
  'CROSS',
  'SELECT',
  'FROM',
  'LIMIT',
  'OFFSET',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'QUALIFY',
  'AND',
  'OR',
  'SET',
  'VALUES',
  'INTO',
  'RETURNING',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'FETCH',
  'TOP',
  'DISTINCT',
  'ON',
  'USING',
  'AS',
  'BY',
])

const SQL_KEYWORDS: ReadonlySet<string> = new Set([
  ...STANDALONE_SQL_CLAUSE_KEYWORDS,
  'FULL',
  'NATURAL',
  'NOT',
  'FIRST',
  'NEXT',
  'ROWS',
  'ONLY',
  'ASC',
  'DESC',
  'NULLS',
  'LAST',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'WITH',
  'RECURSIVE',
  'OVER',
  'PARTITION',
  'WINDOW',
  'CONFLICT',
  'NOTHING',
  'COALESCE',
  'BETWEEN',
  'ILIKE',
  'LIKE',
  'EXISTS',
  'IN',
  'IS',
  'NULL',
  'TRUE',
  'FALSE',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'EXPLAIN',
  'ANALYZE',
  'INDEX',
  'TABLE',
  'VIEW',
  'SCHEMA',
  'CONSTRAINT',
  'PRIMARY',
  'FOREIGN',
  'REFERENCES',
  'DEFAULT',
  'UNIQUE',
  'CHECK',
  'CASCADE',
  'RESTRICT',
  'RESET',
  'UNSET',
  'CHARSET',
  'TRANSACTION',
  'FUNCTION',
  'COLLATION',
  'PRECISION',
  'EXPRESSION',
  'CONDITION',
  'EXCEPTION',
  'POSITION',
  'SESSION',
  'ACTION',
  'VERSION',
  'OPTION',
  'CONNECTION',
  'ISOLATION',
  'AUTHORIZATION',
  'ASSERTION',
  'FOR',
  'CURSOR',
  'OPERATOR',
  'PRIOR',
  'FLOOR',
  'RAND',
  'VECTOR',
  'STANDBY',
  'STOP',
])

const SHORT_LOWER_WORD_ENDINGS: ReadonlySet<string> = new Set([
  'on',
  'or',
  'as',
  'by',
  'and',
  'set',
  'top',
])

const STATEMENT_STARTER_KEYWORDS: ReadonlySet<string> = new Set([
  'SELECT',
  'WITH',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'EXPLAIN',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'VALUES',
  'SHOW',
  'DESCRIBE',
  'PRAGMA',
  'MERGE',
  'CALL',
  'GRANT',
  'REVOKE',
  'SET',
  'RESET',
  'USE',
])

const POST_TABLE_CLAUSE_KEYWORDS: ReadonlySet<string> = new Set([
  'WHERE',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'CROSS',
  'FULL',
  'ORDER',
  'GROUP',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'RETURNING',
  'FETCH',
  'ON',
  'SET',
  'VALUES',
])

export const VALID_SQL_WORDS: ReadonlySet<string> = new Set([
  ...SQL_KEYWORDS,
  ...STATEMENT_STARTER_KEYWORDS,
  'ADD',
  'ALL',
  'ANY',
  'SOME',
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'CAST',
  'TRY_CAST',
  'CONVERT',
  'EXTRACT',
  'SUBSTRING',
  'SUBSTR',
  'CONCAT',
  'LOWER',
  'UPPER',
  'TRIM',
  'LTRIM',
  'RTRIM',
  'LENGTH',
  'ROUND',
  'CEIL',
  'CEILING',
  'ABS',
  'MOD',
  'POWER',
  'SQRT',
  'NOW',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURRENT_TIMESTAMP',
  'CURRENT_USER',
  'USER',
  'ROW',
  'RANGE',
  'GROUPS',
  'FILTER',
  'WITHIN',
  'LATERAL',
  'PIVOT',
  'UNPIVOT',
  'MATCHED',
  'VACUUM',
  'REINDEX',
  'ATTACH',
  'DETACH',
  'EXEC',
  'EXECUTE',
  'DECLARE',
  'OPEN',
  'CLOSE',
  'IF',
  'ELSIF',
  'ELSEIF',
  'LOOP',
  'WHILE',
  'REPEAT',
  'RETURN',
  'RETURNS',
  'LANGUAGE',
  'TEMP',
  'TEMPORARY',
  'MATERIALIZED',
  'CONCURRENTLY',
  'REPLACE',
  'IGNORE',
  'KEY',
  'KEYS',
  'COLUMNS',
  'TABLES',
  'DATABASES',
  'SCHEMAS',
  'STATUS',
  'VARIABLES',
  'SEQUENCE',
  'TYPE',
  'DOMAIN',
  'EXTENSION',
  'ROLE',
  'ROLES',
  'TO',
  'SIMILAR',
  'ESCAPE',
  'COLLATE',
  'LEADING',
  'TRAILING',
  'BOTH',
  'NULLIF',
  'GREATEST',
  'LEAST',
  'IIF',
  'ISNULL',
  'NVL',
  'DECODE',
  'STRING_AGG',
  'ARRAY_AGG',
  'JSON_AGG',
  'JSONB_AGG',
  'JSON_OBJECT',
  'JSON_ARRAY',
  'BOOL_AND',
  'BOOL_OR',
  'LAG',
  'LEAD',
  'FIRST_VALUE',
  'LAST_VALUE',
  'NTH_VALUE',
  'ROW_NUMBER',
  'RANK',
  'DENSE_RANK',
  'NTILE',
  'INT',
  'INTEGER',
  'BIGINT',
  'SMALLINT',
  'TINYINT',
  'DECIMAL',
  'NUMERIC',
  'REAL',
  'FLOAT',
  'DOUBLE',
  'TEXT',
  'VARCHAR',
  'NVARCHAR',
  'CHAR',
  'NCHAR',
  'BOOLEAN',
  'BOOL',
  'DATE',
  'TIME',
  'DATETIME',
  'TIMESTAMP',
  'TIMESTAMPTZ',
  'INTERVAL',
  'UUID',
  'JSON',
  'JSONB',
  'BYTEA',
  'BLOB',
  'CLOB',
  'XML',
  'SERIAL',
  'BIGSERIAL',
  'MONEY',
  'BIT',
  'VARBINARY',
  'STRFTIME',
  'UNNEST',
  'GENERATE_SERIES',
  'IFNULL',
  'DATE_TRUNC',
  'TO_CHAR',
  'GROUP_CONCAT',
  'JSON_EXTRACT',
  'BINARY',
])

const TYPO_TARGET_SQL_KEYWORDS: ReadonlySet<string> = new Set([
  ...STANDALONE_SQL_CLAUSE_KEYWORDS,
  ...STATEMENT_STARTER_KEYWORDS,
  'FULL',
  'NATURAL',
  'NOT',
  'FIRST',
  'NEXT',
  'ROWS',
  'ONLY',
  'ASC',
  'DESC',
  'NULLS',
  'LAST',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'RECURSIVE',
  'OVER',
  'PARTITION',
  'WINDOW',
  'CONFLICT',
  'NOTHING',
  'COALESCE',
  'BETWEEN',
  'ILIKE',
  'LIKE',
  'EXISTS',
  'NULL',
  'TRUE',
  'FALSE',
  'ANALYZE',
  'PRIMARY',
  'FOREIGN',
  'REFERENCES',
  'DEFAULT',
  'UNIQUE',
  'CHECK',
  'CASCADE',
  'RESTRICT',
])

const AFTER_OBJECT_KEYWORD_RE = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s*$/i

const AFTER_FROM_OR_JOIN_TABLE_RE =
  /\b(?:FROM|JOIN)\s+(?:"[^"\n]+"|`[^`\n]+`|\[[^\]\n]+\]|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*(?:"[^"\n]+"|`[^`\n]+`|\[[^\]\n]+\]|[A-Za-z_][A-Za-z0-9_]*))*\s*$/i

interface SqlBoundaryState {
  inQuote: "'" | '"' | '`' | null
  inComment: boolean
}

function scanSqlBoundaryState(prefix: string, dialect?: AiDialect): SqlBoundaryState {
  const rules = getDialectLexerRules(dialect)
  let i = 0
  const len = prefix.length
  while (i < len) {
    const ch = prefix[i]
    const next = prefix[i + 1]
    if (rules.lineCommentDash && ch === '-' && next === '-') {
      const end = scanLineCommentEnd(prefix, i)
      if (end >= len && prefix[len - 1] !== '\n' && prefix[len - 1] !== '\r') {
        return { inQuote: null, inComment: true }
      }
      i = end
      continue
    }
    if (rules.lineCommentHash && ch === '#') {
      const end = scanLineCommentEnd(prefix, i - 1)
      if (end >= len && prefix[len - 1] !== '\n' && prefix[len - 1] !== '\r') {
        return { inQuote: null, inComment: true }
      }
      i = end
      continue
    }
    if (rules.lineCommentSlash && ch === '/' && next === '/') {
      const end = scanLineCommentEnd(prefix, i)
      if (end >= len && prefix[len - 1] !== '\n' && prefix[len - 1] !== '\r') {
        return { inQuote: null, inComment: true }
      }
      i = end
      continue
    }
    if (ch === '/' && next === '*') {
      const end = scanBlockCommentEnd(prefix, i, rules.nestedBlockComments)
      if (end >= len && !prefix.slice(i + 2).endsWith('*/')) {
        return { inQuote: null, inComment: true }
      }
      i = end
      continue
    }
    if (rules.oracleQQuote) {
      const oq = scanOracleQuoteEnd(prefix, i, dialect)
      if (oq) {
        if (!oq.closed) return { inQuote: "'", inComment: false }
        i = oq.end
        continue
      }
    }
    if (rules.dollarQuoting && ch === '$') {
      const tag = matchDollarQuoteTag(prefix, i)
      if (tag) {
        const closeAt = prefix.indexOf(tag, i + tag.length)
        if (closeAt === -1) return { inQuote: "'", inComment: false }
        i = closeAt + tag.length
        continue
      }
    }
    if (rules.postgresEscapeString && (ch === 'E' || ch === 'e') && next === "'" && isPostgresEscapeStringStart(prefix, i, dialect)) {
      const seg = scanQuotedSegmentEnd(prefix, i + 1, "'", true)
      if (!seg.closed) return { inQuote: "'", inComment: false }
      i = seg.end
      continue
    }
    if (ch === "'") {
      const seg = scanQuotedSegmentEnd(prefix, i, "'", rules.backslashEscapesSingleQuote)
      if (!seg.closed) return { inQuote: "'", inComment: false }
      i = seg.end
      continue
    }
    if (ch === '"' && rules.doubleQuoteIdentifiers) {
      const seg = scanQuotedSegmentEnd(prefix, i, '"', rules.backslashEscapesDoubleQuote)
      if (!seg.closed) return { inQuote: '"', inComment: false }
      i = seg.end
      continue
    }
    if (ch === '`' && rules.backtickIdentifiers) {
      const seg = scanQuotedSegmentEnd(prefix, i, '`', false)
      if (!seg.closed) return { inQuote: '`', inComment: false }
      i = seg.end
      continue
    }
    if (ch === '[' && rules.bracketIdentifiers !== 'none') {
      const seg = scanBracketIdentEnd(prefix, i, rules.bracketIdentifiers === 'doubling')
      if (!seg.closed) return { inQuote: null, inComment: false }
      i = seg.end
      continue
    }
    i += 1
  }
  return { inQuote: null, inComment: false }
}

export function damerauLevenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i += 1) dp[i][0] = i
  for (let j = 0; j <= n; j += 1) dp[0][j] = j
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let best = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, dp[i - 2][j - 2] + 1)
      }
      dp[i][j] = best
    }
  }
  return dp[m][n]
}

function matchesKnownIdentifier(tokenLower: string, knownIdentifiers?: Iterable<string>): boolean {
  if (!knownIdentifiers) return false
  if (knownIdentifiers instanceof Set && knownIdentifiers.has(tokenLower)) {
    return true
  }
  for (const raw of knownIdentifiers) {
    if (typeof raw !== 'string' || !raw) continue
    const lower = raw.trim().toLowerCase()
    if (!lower) continue
    if (lower === tokenLower) return true
    if (lower.includes('.')) {
      const bare = lower.split('.').pop() || ''
      if (bare === tokenLower) return true
    }
  }
  return false
}

function collectIdentifierCandidates(knownIdentifiers?: Iterable<string>): string[] {
  if (!knownIdentifiers) return []
  const out: string[] = []
  const seen = new Set<string>()
  const push = (ident: string) => {
    if (ident.length < 3) return
    const lower = ident.toLowerCase()
    if (seen.has(lower)) return
    seen.add(lower)
    out.push(ident)
  }
  for (const raw of knownIdentifiers) {
    if (typeof raw !== 'string' || !raw) continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (trimmed.includes('.')) {
      const bare = trimmed.split('.').pop()?.trim() ?? ''
      if (bare) push(bare)
    } else {
      push(trimmed)
    }
  }
  return out
}

function isAtSqlStatementStart(before: string, dialect?: AiDialect): boolean {
  const rules = getDialectLexerRules(dialect)
  const lastSemi = before.lastIndexOf(';')
  const segment = lastSemi >= 0 ? before.slice(lastSemi + 1) : before
  let i = 0
  while (i < segment.length) {
    const ch = segment[i]
    const next = segment[i + 1]
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (rules.lineCommentDash && ch === '-' && next === '-') {
      i = scanLineCommentEnd(segment, i)
      continue
    }
    if (rules.lineCommentHash && ch === '#') {
      i = scanLineCommentEnd(segment, i - 1)
      continue
    }
    if (rules.lineCommentSlash && ch === '/' && next === '/') {
      i = scanLineCommentEnd(segment, i)
      continue
    }
    if (ch === '/' && next === '*') {
      i = scanBlockCommentEnd(segment, i, rules.nestedBlockComments)
      continue
    }
    return false
  }
  return true
}

export function formatCorrectedKeyword(keywordUpper: string, rawWord: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(rawWord) ? keywordUpper.toLowerCase() : keywordUpper
}

export function resolveTrailingTypoToken(
  prefix: string,
  dialect?: AiDialect,
  knownIdentifiers?: Iterable<string>
): ResolvedTrailingTypoToken | null {
  if (!prefix || dialect === 'redis' || dialect === 'mongodb') return null
  const boundary = scanSqlBoundaryState(prefix, dialect)
  if (boundary.inQuote !== null || boundary.inComment) return null

  const tailMatch = /([A-Za-z0-9_]+)([ \t]*)$/.exec(prefix)
  if (!tailMatch) return null
  const rawWord = tailMatch[1]
  const trailingSpaces = tailMatch[2]
  if (rawWord.length < 3 || !/^[A-Za-z_]/.test(rawWord)) return null

  const tokenStart = prefix.length - rawWord.length - trailingSpaces.length
  if (tokenStart > 0) {
    const prevChar = prefix[tokenStart - 1]
    if (dialect === 'mssql' && prevChar === '[') return null
    if (prevChar === '@' || prevChar === '$') return null
    if (prevChar === ':' && (tokenStart < 2 || prefix[tokenStart - 2] !== ':')) return null
  }

  const before = prefix.slice(0, tokenStart)
  if (/\bAS\s*$/i.test(before)) return null

  const precededByDot = /\.\s*$/.test(before)
  const afterTableRef = !precededByDot && AFTER_FROM_OR_JOIN_TABLE_RE.test(before)
  if (afterTableRef && rawWord.length < 4) return null

  const rawLower = rawWord.toLowerCase()
  const rawUpper = rawWord.toUpperCase()
  if (!precededByDot && VALID_SQL_WORDS.has(rawUpper)) return null
  if (matchesKnownIdentifier(rawLower, knownIdentifiers)) return null

  const atStatementStart = !precededByDot && isAtSqlStatementStart(before, dialect)
  const identCandidates =
    !atStatementStart && !afterTableRef ? collectIdentifierCandidates(knownIdentifiers) : []

  if (trailingSpaces.length === 0) {
    if (!precededByDot) {
      for (const word of VALID_SQL_WORDS) {
        if (word.length > rawUpper.length && word.startsWith(rawUpper)) return null
      }
    }
    for (const ident of identCandidates) {
      if (ident.length > rawLower.length && ident.toLowerCase().startsWith(rawLower)) return null
    }
  }

  const expectsObjectName = !precededByDot && AFTER_OBJECT_KEYWORD_RE.test(before)
  const expectsIdentifier = precededByDot || expectsObjectName
  let bestWord: string | null = null
  let bestDist = Infinity
  let bestPriority = Infinity
  let bestLenDiff = Infinity
  let bestHeadDiff = Infinity

  const consider = (displayWord: string, priority: number, isKeyword: boolean) => {
    const candLower = displayWord.toLowerCase()
    if (candLower === rawLower || candLower.length < 3) return
    if (isKeyword && rawLower === `${candLower}s`) return
    const maxDist = Math.min(rawLower.length, candLower.length) <= 4 ? 1 : 2
    const lenDiff = Math.abs(rawLower.length - candLower.length)
    if (lenDiff > maxDist) return
    const dist = damerauLevenshtein(rawLower, candLower)
    if (dist < 1 || dist > maxDist) return
    const headDiff = candLower[0] === rawLower[0] ? 0 : 1
    const isBetter =
      dist < bestDist ||
      (dist === bestDist &&
        (priority < bestPriority ||
          (priority === bestPriority &&
            (lenDiff < bestLenDiff || (lenDiff === bestLenDiff && headDiff < bestHeadDiff)))))
    if (isBetter) {
      bestWord = displayWord
      bestDist = dist
      bestPriority = priority
      bestLenDiff = lenDiff
      bestHeadDiff = headDiff
    }
  }

  for (const ident of identCandidates) {
    consider(ident, expectsIdentifier ? 0 : 1, false)
  }

  if (!precededByDot && !expectsObjectName) {
    const keywordPool = atStatementStart
      ? STATEMENT_STARTER_KEYWORDS
      : afterTableRef
        ? POST_TABLE_CLAUSE_KEYWORDS
        : TYPO_TARGET_SQL_KEYWORDS
    for (const kw of keywordPool) {
      if (kw.length < 3) continue
      const kwPriority = STANDALONE_SQL_CLAUSE_KEYWORDS.has(kw) ? 0 : 2
      consider(formatCorrectedKeyword(kw, rawWord), kwPriority, true)
    }
  }

  if (!bestWord) return null
  const replaceChars = rawWord.length + trailingSpaces.length
  const healedPrefix = `${before}${bestWord}${trailingSpaces ? ' ' : ''}`
  return {
    rawWord,
    trailingSpaces,
    correctedWord: bestWord,
    replaceChars,
    healedPrefix,
  }
}

function detectQuotedLeadingSpaceReplacement(
  prefix: string,
  suggestion: string,
  quoteChar: string,
  knownIdentifiers?: Iterable<string>
): LeadingTokenReplacement | null {
  if (quoteChar !== '"' && quoteChar !== '`') return null
  const quoteRe = quoteChar === '"' ? /"([A-Za-z0-9_$]+)([ \t]+)$/ : /`([A-Za-z0-9_$]+)([ \t]+)$/
  const openMatch = quoteRe.exec(prefix)
  if (!openMatch) return null

  const partial = openMatch[1]
  const spaces = openMatch[2]
  const trimmedSuggestion = suggestion.replace(/^[ \t]+/, '')
  const strippedQuote = trimmedSuggestion.startsWith(quoteChar) ? trimmedSuggestion.slice(1) : trimmedSuggestion
  const headMatch = /^([A-Za-z_][A-Za-z0-9_$]*)/.exec(strippedQuote)
  if (!headMatch) return null

  const partialLower = partial.toLowerCase()
  const nextLower = headMatch[1].toLowerCase()
  if (!matchesKnownIdentifier(nextLower, knownIdentifiers)) return null

  const isPrefixOrSingleTypo =
    nextLower.startsWith(partialLower) || (partialLower.length >= 2 && damerauLevenshtein(partialLower, nextLower) <= 1)
  if (!isPrefixOrSingleTypo) return null

  return { suggestion: strippedQuote, replaceChars: partial.length + spaces.length }
}

export function detectLeadingTokenReplacement(
  prefix: string,
  suggestion: string,
  dialect?: AiDialect,
  knownIdentifiers?: Iterable<string>
): LeadingTokenReplacement | null {
  if (!prefix || !suggestion) return null
  if (dialect === 'redis' || dialect === 'mongodb') return null
  const boundary = scanSqlBoundaryState(prefix, dialect)
  if (boundary.inComment) return null
  if (boundary.inQuote !== null) {
    return detectQuotedLeadingSpaceReplacement(prefix, suggestion, boundary.inQuote, knownIdentifiers)
  }

  const tailMatch = /([A-Za-z0-9_]+)$/.exec(prefix)
  if (!tailMatch) return null
  const prevToken = tailMatch[1]
  if (prevToken.length < 3 || !/^[A-Za-z_]/.test(prevToken)) return null
  const tokenStart = prefix.length - prevToken.length
  if (dialect === 'mssql' && tokenStart > 0 && prefix[tokenStart - 1] === '[') return null

  const prevLower = prevToken.toLowerCase()
  const prevUpper = prevToken.toUpperCase()
  if (SQL_KEYWORDS.has(prevUpper)) return null
  if (matchesKnownIdentifier(prevLower, knownIdentifiers)) return null

  const tryMatchCandidate = (candidate: string): LeadingTokenReplacement | null => {
    const trimmedSuggestion = candidate.replace(/^[ \t]+/, '')
    const headMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmedSuggestion)
    if (!headMatch) return null
    const nextToken = headMatch[1]
    const nextLower = nextToken.toLowerCase()
    if (prevLower === nextLower || nextLower.startsWith(prevLower)) return null
    const maxDist = Math.min(prevLower.length, nextLower.length) <= 4 ? 1 : 2
    const dist = damerauLevenshtein(prevLower, nextLower)
    if (dist < 1 || dist > maxDist) return null
    if (!SQL_KEYWORDS.has(nextToken.toUpperCase()) && !matchesKnownIdentifier(nextLower, knownIdentifiers)) {
      return null
    }
    return { suggestion: trimmedSuggestion, replaceChars: prevToken.length }
  }

  const direct = tryMatchCandidate(suggestion)
  if (direct) return direct

  const lineStart = prefix.lastIndexOf('\n') + 1
  const lineBeforeToken = prefix.slice(lineStart, tokenStart)
  if (lineBeforeToken.trim().length >= ECHO_MIN_CHARS) {
    const trimmedLeading = suggestion.replace(/^[ \t]+/, '')
    const trimmedLineBefore = lineBeforeToken.replace(/^[ \t]+/, '')
    if (
      trimmedLineBefore.length > 0 &&
      trimmedLeading.length > trimmedLineBefore.length &&
      trimmedLeading.slice(0, trimmedLineBefore.length).toLowerCase() ===
        trimmedLineBefore.toLowerCase()
    ) {
      return tryMatchCandidate(trimmedLeading.slice(trimmedLineBefore.length))
    }
  }

  return null
}

function normalizeLeftCompletionBoundary(
  out: string,
  prefix: string,
  startState: { inQuote: string | null; inComment: boolean },
  knownIdentifiers?: Iterable<string>
): string {
  if (/^\s/.test(out) || startState.inComment) return out

  if (startState.inQuote !== null) {
    if (startState.inQuote !== '"' && startState.inQuote !== '`') return out
    const clauseHead = /^([A-Za-z_][A-Za-z0-9_]*)(?=$|[\s;])/.exec(out.trimStart())?.[1]
    const isGluedClauseInQuote =
      Boolean(clauseHead) &&
      STANDALONE_SQL_CLAUSE_KEYWORDS.has((clauseHead ?? '').toUpperCase()) &&
      !out.includes(startState.inQuote)
    return isGluedClauseInQuote ? '' : out
  }

  const lastChar = prefix[prefix.length - 1]
  if ((lastChar === '"' || lastChar === '`' || lastChar === "'" || lastChar === ']' || lastChar === ')') && /^[A-Za-z_]/.test(out)) {
    return ` ${out}`
  }

  const tailWord = /([A-Za-z0-9_]+)$/.exec(prefix)?.[1]
  if (!tailWord || tailWord.endsWith('_')) return out
  const firstWord = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(out)?.[1]
  if (!firstWord) return out

  const isGluedStandaloneClause =
    STANDALONE_SQL_CLAUSE_KEYWORDS.has(firstWord.toUpperCase()) &&
    !SQL_KEYWORDS.has((tailWord + firstWord).toUpperCase()) &&
    !(/[a-z]$/.test(tailWord) && /^[A-Z][a-z]+$/.test(firstWord)) &&
    !(/[a-z]$/.test(tailWord) && SHORT_LOWER_WORD_ENDINGS.has(firstWord))
  if (!isGluedStandaloneClause) return out

  const beforeTailIdx = prefix.length - tailWord.length
  const prevBeforeTail = beforeTailIdx > 0 ? prefix[beforeTailIdx - 1] : ''
  const isStandaloneNumeric = /^\d+$/.test(tailWord) && (!prevBeforeTail || !/[A-Za-z0-9_.]/.test(prevBeforeTail))
  return isStandaloneNumeric || matchesKnownIdentifier(tailWord.toLowerCase(), knownIdentifiers) ? ` ${out}` : ''
}

function normalizeRightCompletionBoundary(
  out: string,
  prefix: string,
  dialect: AiDialect | undefined,
  suffix: string
): string {
  if (!out || !suffix || /\s$/.test(out) || /^\s/.test(suffix)) return out
  const endState = scanSqlBoundaryState(`${prefix}${out}`, dialect)
  if (endState.inQuote !== null || endState.inComment || !/^[A-Za-z]/.test(suffix)) return out

  const lastOut = out[out.length - 1]
  if (out.endsWith(',')) return `${out} `
  if (lastOut === '.' || lastOut === '_' || !/[A-Za-z0-9_)'"`\]]$/.test(lastOut)) return out

  const sufWord = /^([A-Za-z][A-Za-z0-9_]*)/.exec(suffix)?.[1] ?? ''
  const outTailWord = /([A-Za-z0-9_]+)$/.exec(out)?.[1] ?? ''
  const needsRightSpace =
    VALID_SQL_WORDS.has(sufWord.toUpperCase()) ||
    /[)'"`\]]$/.test(lastOut) ||
    /^\d+$/.test(outTailWord) ||
    STANDALONE_SQL_CLAUSE_KEYWORDS.has(outTailWord.toUpperCase())
  return needsRightSpace ? `${out} ` : out
}

export function normalizeCompletionBoundary(
  suggestion: string,
  prefix: string,
  dialect?: AiDialect,
  knownIdentifiers?: Iterable<string>,
  suffix = ''
): string {
  if (!suggestion || !prefix) return suggestion
  if (dialect === 'redis' || dialect === 'mongodb') return suggestion
  const startState = scanSqlBoundaryState(prefix, dialect)
  let out =
    prefix.endsWith('\n') &&
    suggestion.startsWith('\n') &&
    !suggestion.startsWith('\n\n') &&
    startState.inQuote === null &&
    !startState.inComment
      ? suggestion.slice(1)
      : suggestion
  if (!out) return ''

  out = normalizeLeftCompletionBoundary(out, prefix, startState, knownIdentifiers)
  if (!out) return ''
  return normalizeRightCompletionBoundary(out, prefix, dialect, suffix)
}

function matchIndentNormalizedMultiLineEcho(suggestion: string, tailLines: string[]): string | null {
  const joined = tailLines.join('\n')
  if (tailLines.length < 2 || joined.trim().length < ECHO_MIN_CHARS) return null
  const sugLines: Array<{ start: number; endWithoutCr: number }> = []
  let lineStart = 0
  while (lineStart <= suggestion.length && sugLines.length < tailLines.length) {
    const nl = suggestion.indexOf('\n', lineStart)
    const end = nl === -1 ? suggestion.length : nl
    const endWithoutCr = end > lineStart && suggestion[end - 1] === '\r' ? end - 1 : end
    sugLines.push({ start: lineStart, endWithoutCr })
    if (nl === -1) break
    lineStart = nl + 1
  }
  if (sugLines.length < tailLines.length) return null

  for (let i = 0; i < tailLines.length - 1; i += 1) {
    const sugLineNorm = suggestion.slice(sugLines[i].start, sugLines[i].endWithoutCr).trim().toLowerCase()
    const tailLineNorm = tailLines[i].trim().toLowerCase()
    if (sugLineNorm !== tailLineNorm) return null
  }

  const last = tailLines.length - 1
  const tailLastTrimStart = tailLines[last].replace(/^[ \t]+/, '')
  const sugLastRaw = suggestion.slice(sugLines[last].start, sugLines[last].endWithoutCr)
  const sugLastLeadingWsLen = (/^[ \t]*/.exec(sugLastRaw)?.[0] ?? '').length
  const sugLastAfterWs = sugLastRaw.slice(sugLastLeadingWsLen)
  if (
    sugLastAfterWs.length < tailLastTrimStart.length ||
    sugLastAfterWs.slice(0, tailLastTrimStart.length).toLowerCase() !== tailLastTrimStart.toLowerCase()
  ) {
    return null
  }

  const cutOffset = sugLines[last].start + sugLastLeadingWsLen + tailLastTrimStart.length
  const rest = suggestion.slice(cutOffset)
  const tailWord = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(tailLastTrimStart)?.[1]
  const restWord = /^([A-Za-z0-9_]+)/.exec(rest)?.[1]
  if (tailWord && restWord) {
    const matchedTail = suggestion.slice(cutOffset - tailWord.length, cutOffset)
    return matchKeywordTailCasing(tailWord, restWord, matchedTail + restWord) + rest.slice(restWord.length)
  }
  return rest
}

function matchKeywordTailCasing(
  prefixWord: string,
  remainderWord: string,
  fullWord: string
): string {
  if (!remainderWord || !SQL_KEYWORDS.has(fullWord.toUpperCase())) return remainderWord
  if (/^[A-Z]+$/.test(prefixWord) && /[a-z]/.test(remainderWord)) return remainderWord.toUpperCase()
  if (/^[a-z]+$/.test(prefixWord) && /[A-Z]/.test(remainderWord)) return remainderWord.toLowerCase()
  return remainderWord
}

export function trimPrefixEcho(
  suggestion: string,
  prefix: string,
  dialect?: AiDialect,
  knownIdentifiers?: Iterable<string>
): string {
  if (!suggestion || !prefix) return suggestion
  const state = scanSqlBoundaryState(prefix, dialect)
  const leadingSpacesMatch = /^([ \t]+)/.exec(suggestion)
  const leadingSpaces = leadingSpacesMatch?.[1] ?? ''
  const suggestionTrimmedStart = leadingSpaces ? suggestion.slice(leadingSpaces.length) : suggestion

  const lines = prefix.split('\n')
  for (let count = Math.min(lines.length, ECHO_MAX_LINES); count >= 1; count -= 1) {
    const tail = lines.slice(-count).join('\n')
    if (tail.trim().length < ECHO_MIN_CHARS) continue
    const candidate =
      suggestion.startsWith(tail) ||
      (suggestion.length >= tail.length &&
        suggestion.slice(0, tail.length).toLowerCase() === tail.toLowerCase())
        ? suggestion
        : leadingSpaces &&
            !suggestionTrimmedStart.startsWith('\n') &&
            (suggestionTrimmedStart.startsWith(tail) ||
              (suggestionTrimmedStart.length >= tail.length &&
                suggestionTrimmedStart.slice(0, tail.length).toLowerCase() === tail.toLowerCase()))
          ? suggestionTrimmedStart
          : null
    if (!candidate) {
      if (count >= 2) {
        const indentEcho = matchIndentNormalizedMultiLineEcho(suggestion, lines.slice(-count))
        if (indentEcho !== null) return indentEcho
      }
      continue
    }
    if (candidate.startsWith(tail)) {
      return candidate.slice(tail.length)
    }
    const rest = candidate.slice(tail.length)
    const tailWord = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(tail)?.[1]
    const restWord = /^([A-Za-z0-9_]+)/.exec(rest)?.[1]
    if (tailWord && restWord) {
      const fullWord = candidate.slice(tail.length - tailWord.length, tail.length + restWord.length)
      return matchKeywordTailCasing(tailWord, restWord, fullWord) + rest.slice(restWord.length)
    }
    return rest
  }

  if (state.inQuote === '"' || state.inQuote === '`') {
    const q = state.inQuote
    const openMatch = q === '"' ? /"([A-Za-z0-9_$]+)$/.exec(prefix) : /`([A-Za-z0-9_$]+)$/.exec(prefix)
    if (openMatch) {
      const quotedPartial = openMatch[0]
      if (
        suggestionTrimmedStart.length > quotedPartial.length &&
        suggestionTrimmedStart.slice(0, quotedPartial.length).toLowerCase() === quotedPartial.toLowerCase()
      ) {
        return suggestionTrimmedStart.slice(quotedPartial.length)
      }
    }
  }

  const quotedTail = /("[^"\n]+"|`[^`\n]+`|\[[^\]\n]+\])$/.exec(prefix)?.[1]
  if (
    quotedTail &&
    quotedTail.length >= ECHO_MIN_CHARS &&
    suggestion.startsWith(quotedTail) &&
    state.inQuote === null
  ) {
    return suggestion.slice(quotedTail.length)
  }

  const tailWordMatch = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(prefix)
  const tailWord = tailWordMatch?.[1]
  const headMatch = /^([ \t]*)([A-Za-z_][A-Za-z0-9_]*)/.exec(suggestion)
  const leadingWs = headMatch?.[1] ?? ''
  const headWord = headMatch?.[2]
  if (
    tailWord &&
    headWord &&
    headWord.length >= tailWord.length &&
    (leadingWs.length === 0 || state.inQuote === null)
  ) {
    const headPrefix = headWord.slice(0, tailWord.length)
    const beforeTailWord = prefix.slice(0, prefix.length - tailWord.length)
    const isLongMatch =
      tailWord.length >= ECHO_MIN_CHARS && headPrefix.toLowerCase() === tailWord.toLowerCase()
    const isShortKeywordMatch =
      tailWord.length === 2 && headPrefix === tailWord && SQL_KEYWORDS.has(headWord.toUpperCase())
    const isShortIdentEcho =
      tailWord.length === 2 &&
      headWord.length > 2 &&
      headPrefix.toLowerCase() === tailWord.toLowerCase() &&
      (matchesKnownIdentifier(headWord.toLowerCase(), knownIdentifiers) ||
        state.inQuote === '"' ||
        state.inQuote === '`' ||
        AFTER_OBJECT_KEYWORD_RE.test(beforeTailWord) ||
        /\.\s*$/.test(beforeTailWord))
    const isSingleCharQuotedIdentEcho =
      tailWord.length === 1 &&
      headWord.length > 1 &&
      (state.inQuote === '"' || state.inQuote === '`') &&
      headPrefix.toLowerCase() === tailWord.toLowerCase() &&
      matchesKnownIdentifier(headWord.toLowerCase(), knownIdentifiers)
    if (isLongMatch || isShortKeywordMatch || isShortIdentEcho || isSingleCharQuotedIdentEcho) {
      const wordRest = headWord.slice(tailWord.length)
      return (
        matchKeywordTailCasing(tailWord, wordRest, headWord) +
        suggestion.slice(leadingWs.length + headWord.length)
      )
    }
  }

  if (
    (prefix.endsWith(' ') || prefix.endsWith('\t')) &&
    suggestion.startsWith(' ') &&
    !/^\s*\n/.test(suggestion) &&
    state.inQuote === null &&
    !state.inComment
  ) {
    return suggestion.replace(/^ +/, '')
  }
  return suggestion
}

interface ScannedSqlLiteral {
  kind: 'string' | 'number'
  value: string
  raw: string
  start: number
  end: number
}

interface TopLevelSqlKeyword {
  keyword: string
  start: number
  end: number
  parenDepth: number
  caseDepth: number
}

interface WherePredicateSegment {
  cutAt: number
  text: string
  connector: 'none' | 'and' | 'or'
}

const WHERE_CLAUSE_TERMINATORS: ReadonlySet<string> = new Set([
  'GROUP',
  'ORDER',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'RETURNING',
  'FETCH',
  'FOR',
  'WINDOW',
  'QUALIFY',
  'SETTINGS',
  'FORMAT',
])

const PLACEHOLDER_LITERAL_WORDS: ReadonlySet<string> = new Set([
  'test',
  'example',
  'sample',
  'dummy',
  'foo',
  'bar',
  'baz',
  'qux',
  'abc',
  'abcd',
  'xyz',
  'xxx',
  'placeholder',
  'value',
  'something',
  'unknown',
  'user',
  'user1',
  'admin',
  'john',
  'jane',
  'doe',
  'john doe',
  'password',
  'secret',
])

function isSqlIdentChar(ch: string | undefined): boolean {
  return Boolean(ch && /[A-Za-z0-9_$]/.test(ch))
}

function skipCommentOrQuotedSpan(sql: string, i: number, dialect?: AiDialect): number | null {
  const rules = getDialectLexerRules(dialect)
  const ch = sql[i]
  const next = sql[i + 1]
  if (rules.lineCommentDash && ch === '-' && next === '-') {
    return scanLineCommentEnd(sql, i)
  }
  if (rules.lineCommentHash && ch === '#') {
    return scanLineCommentEnd(sql, i - 1)
  }
  if (rules.lineCommentSlash && ch === '/' && next === '/') {
    return scanLineCommentEnd(sql, i)
  }
  if (ch === '/' && next === '*') {
    return scanBlockCommentEnd(sql, i, rules.nestedBlockComments)
  }
  if (rules.oracleQQuote) {
    const oq = scanOracleQuoteEnd(sql, i, dialect)
    if (oq) return oq.end
  }
  if (rules.dollarQuoting && ch === '$') {
    const tag = matchDollarQuoteTag(sql, i)
    if (tag) {
      const closeAt = sql.indexOf(tag, i + tag.length)
      return closeAt === -1 ? sql.length : closeAt + tag.length
    }
  }
  if (ch === '"' && rules.doubleQuoteIdentifiers) {
    return scanQuotedSegmentEnd(sql, i, '"', rules.backslashEscapesDoubleQuote).end
  }
  if (ch === '`' && rules.backtickIdentifiers) {
    return scanQuotedSegmentEnd(sql, i, '`', false).end
  }
  if (ch === '[' && rules.bracketIdentifiers !== 'none') {
    return scanBracketIdentEnd(sql, i, rules.bracketIdentifiers === 'doubling').end
  }
  return null
}

function scanSingleQuotedLiteral(
  sql: string,
  start: number,
  dialect?: AiDialect
): { lit: ScannedSqlLiteral; nextIndex: number } {
  const rules = getDialectLexerRules(dialect)
  const isPgEscape =
    rules.postgresEscapeString &&
    start > 0 &&
    (sql[start - 1] === 'E' || sql[start - 1] === 'e') &&
    isPostgresEscapeStringStart(sql, start - 1, dialect)
  const allowBackslash = rules.backslashEscapesSingleQuote || isPgEscape
  let value = ''
  let j = start + 1
  while (j < sql.length) {
    const c = sql[j]
    if (allowBackslash && c === '\\' && j + 1 < sql.length) {
      value += sql[j + 1]
      j += 2
      continue
    }
    if (c === "'") {
      if (sql[j + 1] === "'") {
        value += "'"
        j += 2
        continue
      }
      j += 1
      break
    }
    value += c
    j += 1
  }
  return {
    lit: { kind: 'string', value, raw: sql.slice(start, j), start, end: j },
    nextIndex: j,
  }
}

function scanSqlLiterals(sql: string, dialect?: AiDialect): ScannedSqlLiteral[] {
  const literals: ScannedSqlLiteral[] = []
  let i = 0
  while (i < sql.length) {
    const skipped = skipCommentOrQuotedSpan(sql, i, dialect)
    if (skipped !== null) {
      i = skipped
      continue
    }
    const ch = sql[i]
    if (ch === "'") {
      const scanned = scanSingleQuotedLiteral(sql, i, dialect)
      literals.push(scanned.lit)
      i = scanned.nextIndex
      continue
    }
    const prev = i > 0 ? sql[i - 1] : ''
    const isNegative = ch === '-' && /[0-9]/.test(sql[i + 1] ?? '') && (i === 0 || /[\s(=<>!,+*/]/.test(prev))
    const isDigitStart = /[0-9]/.test(ch) && !isSqlIdentChar(prev) && prev !== '.'
    if (isNegative || isDigitStart) {
      let j = isNegative ? i + 1 : i
      while (j < sql.length && /[0-9]/.test(sql[j])) j += 1
      if (sql[j] === '.' && /[0-9]/.test(sql[j + 1] ?? '')) {
        j += 1
        while (j < sql.length && /[0-9]/.test(sql[j])) j += 1
      }
      if (!/[A-Za-z_$]/.test(sql[j] ?? '')) {
        const raw = sql.slice(i, j)
        literals.push({ kind: 'number', value: raw, raw, start: i, end: j })
        i = j
        continue
      }
    }
    i += 1
  }
  return literals
}

function scanTopLevelSqlTokens(
  sql: string,
  startOffset: number,
  endOffset: number,
  dialect?: AiDialect
): { keywords: TopLevelSqlKeyword[]; semicolons: number[]; firstTerminatorAt: number | null } {
  const keywords: TopLevelSqlKeyword[] = []
  const semicolons: number[] = []
  let firstTerminatorAt: number | null = null
  let parenDepth = 0
  let caseDepth = 0
  let i = startOffset
  while (i < endOffset) {
    const skipped = skipCommentOrQuotedSpan(sql, i, dialect)
    if (skipped !== null) {
      i = Math.min(skipped, endOffset)
      continue
    }
    const ch = sql[i]
    if (ch === "'") {
      i = Math.min(scanSingleQuotedLiteral(sql, i, dialect).nextIndex, endOffset)
      continue
    }
    if (ch === '(') {
      parenDepth += 1
      i += 1
      continue
    }
    if (ch === ')') {
      if (parenDepth > 0) parenDepth -= 1
      i += 1
      continue
    }
    if (ch === ';' && parenDepth === 0) {
      semicolons.push(i)
      if (firstTerminatorAt === null) firstTerminatorAt = i
      i += 1
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      const prev = i > 0 ? sql[i - 1] : ''
      let j = i + 1
      while (j < endOffset && isSqlIdentChar(sql[j])) j += 1
      if (!isSqlIdentChar(prev) && prev !== '.') {
        const upper = sql.slice(i, j).toUpperCase()
        if (parenDepth === 0) {
          if (upper === 'CASE') {
            caseDepth += 1
          } else if (upper === 'END') {
            if (caseDepth > 0) caseDepth -= 1
          } else {
            keywords.push({ keyword: upper, start: i, end: j, parenDepth, caseDepth })
            if (firstTerminatorAt === null && caseDepth === 0 && WHERE_CLAUSE_TERMINATORS.has(upper)) {
              firstTerminatorAt = i
            }
          }
        }
      }
      i = j
      continue
    }
    i += 1
  }
  return { keywords, semicolons, firstTerminatorAt }
}

function isFabricatedPlaceholderLiteral(lit: ScannedSqlLiteral, modelIntroducedWhere: boolean): boolean {
  const v = lit.value.trim().toLowerCase()
  if (!v) return false
  if (lit.kind === 'number' || /^-?\d+(?:\.\d+)?$/.test(v)) {
    const digits = v.replace(/[-.]/g, '')
    if (digits.length >= 4) return true
    if (/^(?:123|234|345|456|567|678|789|321|000|111|222|999)$/.test(digits)) return true
    return modelIntroducedWhere && lit.kind === 'string' && /^\d+$/.test(v)
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return true
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v)) return true
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return true
  const stripped = v.replace(/^[%_]+|[%_]+$/g, '')
  return PLACEHOLDER_LITERAL_WORDS.has(stripped)
}

function prefixHasActiveWhereClause(prefix: string, dialect?: AiDialect): boolean {
  const scanned = scanTopLevelSqlTokens(prefix, 0, prefix.length, dialect)
  const afterSemi = scanned.semicolons.length > 0 ? scanned.semicolons[scanned.semicolons.length - 1] + 1 : 0
  let active = false
  for (const kw of scanned.keywords) {
    if (kw.start < afterSemi || kw.caseDepth > 0) continue
    if (kw.keyword === 'WHERE') active = true
    else if (WHERE_CLAUSE_TERMINATORS.has(kw.keyword)) active = false
  }
  return active
}

function prefixEndsWithComparisonOp(prefix: string): boolean {
  const trimmed = prefix.trimEnd()
  if (!trimmed) return false
  if (/(?:!=|<>|<=|>=|=|<|>)$/.test(trimmed)) return true
  if (/\b(?:NOT\s+)?I?LIKE$/i.test(trimmed)) return true
  if (/\b(?:NOT\s+)?IN\s*\(\s*$/i.test(trimmed)) return true
  return /\b(?:NOT\s+)?IN\s*\([^)]*,\s*$/i.test(trimmed)
}

function splitTopLevelWherePredicates(
  sql: string,
  startOffset: number,
  endOffset: number,
  dialect?: AiDialect
): WherePredicateSegment[] {
  const { keywords } = scanTopLevelSqlTokens(sql, startOffset, endOffset, dialect)
  const segments: WherePredicateSegment[] = []
  let segStart = startOffset
  let cutAt = startOffset
  let connector: 'none' | 'and' | 'or' = 'none'
  let pendingBetween = false

  for (const kw of keywords) {
    if (kw.caseDepth > 0) continue
    if (kw.keyword === 'BETWEEN') {
      pendingBetween = true
      continue
    }
    if (kw.keyword === 'AND') {
      if (pendingBetween) {
        pendingBetween = false
        continue
      }
      segments.push({ cutAt, text: sql.slice(segStart, kw.start), connector })
      cutAt = kw.start
      segStart = kw.end
      connector = 'and'
      continue
    }
    if (kw.keyword === 'OR') {
      pendingBetween = false
      segments.push({ cutAt, text: sql.slice(segStart, kw.start), connector })
      cutAt = kw.start
      segStart = kw.end
      connector = 'or'
    }
  }
  segments.push({ cutAt, text: sql.slice(segStart, endOffset), connector })
  return segments
}

export function trimFabricatedFilterLiterals(
  suggestion: string,
  prefix: string,
  suffix: string,
  groundedSources: readonly string[],
  dialect?: AiDialect
): string {
  if (!suggestion || dialect === 'redis' || dialect === 'mongodb') return suggestion

  const groundedValues = new Set<string>()
  for (const src of [prefix, suffix, ...groundedSources]) {
    if (!src) continue
    for (const lit of scanSqlLiterals(src, dialect)) {
      const key = lit.value.trim().toLowerCase()
      if (key) groundedValues.add(key)
    }
  }

  const findUngrounded = (text: string): ScannedSqlLiteral[] =>
    scanSqlLiterals(text, dialect).filter((lit) => {
      const key = lit.value.trim().toLowerCase()
      return Boolean(key) && !groundedValues.has(key)
    })

  const fullScan = scanTopLevelSqlTokens(suggestion, 0, suggestion.length, dialect)
  if (!prefixHasActiveWhereClause(prefix, dialect)) {
    const whereKw = fullScan.keywords.find((kw) => kw.caseDepth === 0 && kw.keyword === 'WHERE')
    if (!whereKw) return suggestion
    const bodyStart = whereKw.end
    const postWhereScan = scanTopLevelSqlTokens(suggestion, bodyStart, suggestion.length, dialect)
    const whereZoneEnd = postWhereScan.firstTerminatorAt ?? suggestion.length
    const hasPrecedingClause = suggestion.slice(0, whereKw.start).trim().length > 0
    const segments = splitTopLevelWherePredicates(suggestion, bodyStart, whereZoneEnd, dialect)
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i]
      const ungrounded = findUngrounded(seg.text)
      if (ungrounded.length === 0) continue
      const hasFabricatedLiteral = ungrounded.some(
        (lit) =>
          isFabricatedPlaceholderLiteral(lit, true) ||
          (hasPrecedingClause && lit.kind === 'string')
      )
      if (hasFabricatedLiteral) {
        const cutIdx = i === 0 ? whereKw.start : seg.cutAt
        return suggestion.slice(0, cutIdx).trimEnd()
      }
    }
    return suggestion
  }

  const whereZoneEnd = fullScan.firstTerminatorAt ?? suggestion.length
  const segments = splitTopLevelWherePredicates(suggestion, 0, whereZoneEnd, dialect)
  if (prefixEndsWithComparisonOp(prefix) && segments.length > 0) {
    const ungroundedLead = findUngrounded(segments[0].text)
    if (ungroundedLead.some((lit) => isFabricatedPlaceholderLiteral(lit, false))) {
      return ''
    }
  }
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]
    const ungrounded = findUngrounded(seg.text)
    if (ungrounded.length === 0) continue
    if (seg.connector !== 'none') {
      const hasFabricated = ungrounded.some(
        (lit) => lit.kind === 'string' || isFabricatedPlaceholderLiteral(lit, false)
      )
      if (hasFabricated) {
        return suggestion.slice(0, seg.cutAt).trimEnd()
      }
      continue
    }
    if (ungrounded.some((lit) => isFabricatedPlaceholderLiteral(lit, false))) {
      return ''
    }
  }
  return suggestion
}

export function skipRewrittenSuffix(suggestion: string, suffix: string): string {
  const compLine = suggestion.split(/\r?\n/).find((line) => line.trim().length > 0) ?? ''
  const comp = compLine.trimStart()
  const nlSuf = suffix.indexOf('\n')
  const after = (nlSuf === -1 ? suffix : suffix.slice(0, nlSuf)).trimStart()
  if (!comp || !after) return suggestion
  const compLower = comp.toLowerCase()
  const afterLower = after.toLowerCase()
  if (compLower === afterLower) return ''
  let shared = 0
  while (shared < compLower.length && shared < afterLower.length && compLower[shared] === afterLower[shared]) {
    shared += 1
  }
  const sharedSignificant = after.slice(0, shared).replace(/\s/g, '').length
  const afterSignificant = after.replace(/\s/g, '').length
  const isCommaListItem = comp.trimEnd().endsWith(',')
  if (!isCommaListItem && sharedSignificant >= 6 && shared / Math.min(compLower.length, afterLower.length) >= 0.75) {
    return ''
  }
  if (!isCommaListItem && compLower.startsWith(afterLower) && afterSignificant >= 4) {
    return ''
  }
  return suggestion
}

function hasUnmatchedTrailingCloser(suggestion: string, closer: ')' | ']' | '}', dialect?: AiDialect): boolean {
  const opener = closer === ')' ? '(' : closer === ']' ? '[' : '{'
  if (closer === ']' && dialect === 'mssql') return false
  let depth = 0
  let inQuote: string | null = null
  for (let i = 0; i < suggestion.length; i += 1) {
    const ch = suggestion[i]
    if (inQuote) {
      if (ch === '\\' && inQuote !== '`') {
        i += 1
      } else if (ch === inQuote) {
        inQuote = null
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inQuote = ch
    } else if (ch === opener) {
      depth += 1
    } else if (ch === closer) {
      depth -= 1
    }
  }
  return depth < 0
}

export function trimSingleLineSuffixOverlap(
  suggestion: string,
  suffix: string,
  prefix = '',
  dialect?: AiDialect
): string {
  if (!suggestion || !suffix) return suggestion
  const nl = suffix.indexOf('\n')
  const suffixLine = nl === -1 ? suffix : suffix.slice(0, nl)
  if (!suffixLine) return suggestion
  const maxLen = Math.min(suggestion.length, suffixLine.length)
  for (let len = maxLen; len >= 2; len -= 1) {
    const overlap = suffixLine.slice(0, len)
    if (!suggestion.endsWith(overlap)) continue
    const cutStart = suggestion.length - len
    // Do not split mid-identifier across overlap boundaries (e.g. `user_id` + `id_parent`, `login` + `in (1,2)`)
    const charBeforeCut = cutStart > 0 ? suggestion[cutStart - 1] : ''
    const firstOverlapChar = overlap[0]
    if (charBeforeCut && /[A-Za-z0-9_]/.test(charBeforeCut) && /[A-Za-z0-9_]/.test(firstOverlapChar)) {
      continue
    }
    const lastOverlapChar = overlap[overlap.length - 1]
    const charAfterSuffixOverlap = suffixLine[len] ?? ''
    if (charAfterSuffixOverlap && /[A-Za-z0-9_]/.test(lastOverlapChar) && /[A-Za-z0-9_]/.test(charAfterSuffixOverlap)) {
      continue
    }
    return suggestion.slice(0, cutStart)
  }
  const firstSuf = suffixLine[0]
  if (suggestion.endsWith(firstSuf)) {
    if (firstSuf === '"' || firstSuf === "'" || firstSuf === '`') {
      if (scanSqlBoundaryState(`${prefix}${suggestion}`, dialect).inQuote === null) {
        return suggestion.slice(0, -1)
      }
    } else if (firstSuf === ')' || firstSuf === ']' || firstSuf === '}') {
      if (hasUnmatchedTrailingCloser(suggestion, firstSuf, dialect)) {
        return suggestion.slice(0, -1)
      }
    }
  }
  return suggestion
}

export function matchCompletionBrackets(
  suggestion: string,
  prefix: string,
  dialect?: AiDialect,
  suffix = ''
): string {
  if (!suggestion || dialect === 'redis') return suggestion
  const rules = getDialectLexerRules(dialect)
  const skipSquare = rules.bracketIdentifiers !== 'none'
  const prefixOpen = { '(': 0, '[': 0, '{': 0 }

  const scanText = (
    text: string,
    mode: 'prefix' | 'suffix' | 'suggestion',
    stack: Array<')' | ']' | '}'>,
    initState = {
      inQuote: null as string | null,
      escapeQuote: false,
      inLineComment: false,
      blockDepth: 0,
    }
  ): {
    out: string
    inQuote: string | null
    escapeQuote: boolean
    inLineComment: boolean
    blockDepth: number
    suffixUnmatched: { '(': number; '[': number; '{': number }
  } => {
    let { inQuote, escapeQuote, inLineComment, blockDepth } = initState
    const localSuffixOpen = { '(': 0, '[': 0, '{': 0 }
    const suffixUnmatched = { '(': 0, '[': 0, '{': 0 }
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]
      const next = text[i + 1]
      if (inLineComment) {
        if (ch === '\n' || ch === '\r') inLineComment = false
        continue
      }
      if (blockDepth > 0) {
        if (rules.nestedBlockComments && ch === '/' && next === '*') {
          blockDepth += 1
          i += 1
        } else if (ch === '*' && next === '/') {
          blockDepth -= 1
          i += 1
        }
        continue
      }
      if (inQuote) {
        const allowBackslash =
          inQuote === "'"
            ? rules.backslashEscapesSingleQuote || escapeQuote
            : inQuote === '"'
              ? rules.backslashEscapesDoubleQuote
              : false
        if (allowBackslash && ch === '\\' && i + 1 < text.length) {
          i += 1
          continue
        }
        if (ch === inQuote) {
          if (next === inQuote) {
            i += 1
            continue
          }
          inQuote = null
          escapeQuote = false
        }
        continue
      }
      if (rules.lineCommentDash && ch === '-' && next === '-') {
        inLineComment = true
        i += 1
        continue
      }
      if (rules.lineCommentHash && ch === '#') {
        inLineComment = true
        continue
      }
      if (rules.lineCommentSlash && ch === '/' && next === '/') {
        inLineComment = true
        i += 1
        continue
      }
      if (ch === '/' && next === '*') {
        blockDepth = 1
        i += 1
        continue
      }
      if (rules.oracleQQuote) {
        const oq = scanOracleQuoteEnd(text, i, dialect)
        if (oq) {
          i = oq.end - 1
          continue
        }
      }
      if (rules.dollarQuoting && ch === '$') {
        const tag = matchDollarQuoteTag(text, i)
        if (tag) {
          const closeAt = text.indexOf(tag, i + tag.length)
          i = closeAt === -1 ? text.length - 1 : closeAt + tag.length - 1
          continue
        }
      }
      if (
        rules.postgresEscapeString &&
        (ch === 'E' || ch === 'e') &&
        next === "'" &&
        isPostgresEscapeStringStart(text, i, dialect)
      ) {
        inQuote = "'"
        escapeQuote = true
        i += 1
        continue
      }
      if (ch === "'" || (ch === '"' && rules.doubleQuoteIdentifiers) || (ch === '`' && rules.backtickIdentifiers)) {
        inQuote = ch
        escapeQuote = false
        continue
      }
      if (ch === '(' || (ch === '[' && !skipSquare) || ch === '{') {
        if (mode === 'prefix') {
          prefixOpen[ch] += 1
        } else if (mode === 'suffix') {
          localSuffixOpen[ch] += 1
        } else {
          stack.push(ch === '(' ? ')' : ch === '[' ? ']' : '}')
        }
      } else if (ch === ')' || (ch === ']' && !skipSquare) || ch === '}') {
        const openKey = ch === ')' ? '(' : ch === ']' ? '[' : '{'
        if (mode === 'prefix') {
          if (prefixOpen[openKey] > 0) prefixOpen[openKey] -= 1
        } else if (mode === 'suffix') {
          if (localSuffixOpen[openKey] > 0) localSuffixOpen[openKey] -= 1
          else suffixUnmatched[openKey] += 1
        } else {
          if (stack.length > 0 && stack[stack.length - 1] === ch) {
            stack.pop()
          } else if (prefixOpen[openKey] > 0) {
            prefixOpen[openKey] -= 1
          } else {
            return {
              out: text.slice(0, i).trimEnd(),
              inQuote,
              escapeQuote,
              inLineComment,
              blockDepth,
              suffixUnmatched,
            }
          }
        }
      }
    }
    return { out: text, inQuote, escapeQuote, inLineComment, blockDepth, suffixUnmatched }
  }

  const prefixRes = scanText(prefix, 'prefix', [])
  if (suffix && prefixRes.inQuote === null && !prefixRes.inLineComment && prefixRes.blockDepth === 0) {
    const sufRes = scanText(suffix, 'suffix', [])
    prefixOpen['('] = Math.max(0, prefixOpen['('] - sufRes.suffixUnmatched['('])
    prefixOpen['['] = Math.max(0, prefixOpen['['] - sufRes.suffixUnmatched['['])
    prefixOpen['{'] = Math.max(0, prefixOpen['{'] - sufRes.suffixUnmatched['{'])
  }
  const stack: Array<')' | ']' | '}'> = []
  return scanText(suggestion, 'suggestion', stack, {
    inQuote: prefixRes.inQuote,
    escapeQuote: prefixRes.escapeQuote,
    inLineComment: prefixRes.inLineComment,
    blockDepth: prefixRes.blockDepth,
  }).out
}

export function trimSuffixOverlap(suggestion: string, suffix: string): string {
  const probe = suffix.trimStart().slice(0, OVERLAP_PROBE_CHARS)
  if (probe.length >= OVERLAP_MIN_PROBE_CHARS) {
    const at = suggestion.indexOf(probe)
    if (at > 0) return suggestion.slice(0, at).trimEnd()
  }
  for (let len = Math.min(suffix.length, suggestion.length); len >= 2; len -= 1) {
    const head = suffix.slice(0, len)
    if (head.startsWith('\n') && suggestion.endsWith(head)) {
      return suggestion.slice(0, suggestion.length - len)
    }
  }
  return suggestion
}

const PROSE_PHRASE_RE =
  /(?:^|[\s.;:!?—–-])(?:depends on|provide|please|sorry|here is|here are|here's|sure,|you can|you could|you should|you might|you may|you want|you need|you'll|you're|i can|i think|i believe|i would|i'd|i'll|i'm|we can|we should|let me|let's|it looks like|it seems|it appears|looks like (?:you|we|the|a|an|this|that|it|there)|seems like|appears to be|maybe|perhaps|clarify|cursor intent|for example|e\.g\.:|want to|trying to|need to|in order to|to do this|based on (?:the|your|this|that|what|existing)|assuming (?:you|the|that|this|a)|this query|the query (?:is|will|should|needs?|seems?|looks?)|the user (?:wants?|is|seems?))(?=$|[\s.;:!?—–,-])|(?:^|[.!?]\s+)to\s+(?:filter|sort|group|select|query|get|find|update|delete|insert|join|limit|check|count|retrieve)(?=$|[\s.;:!?—–,-])/i
const PROSE_LABEL_RE = /(?:^|[.\n!?]\s+)(?:note|explanation)\s*:/i
const PROSE_INDICATOR_WORD_RE =
  /\b(?:you|your|yours|i|we|our|they|their|this|that|these|those|there|here|the|an|should|would|could|might|must|will|want|need|looks|seems|appears|means|helps|allows|returns|selects|filters)\b/i

function stripQuotedSegments(text: string): string {
  return text
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`[^`]*`/g, '``')
}

export function isProseExplanation(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  const stripped = stripQuotedSegments(trimmed)
  if (PROSE_PHRASE_RE.test(stripped) || PROSE_LABEL_RE.test(stripped)) return true
  const proseQuestion = /[A-Za-z]{2,}\?(?=\s|$)/.test(stripped) || /[A-Za-z]{2,}!(?=\s|$)/.test(stripped)
  const hasEmDash = /[—–]/.test(stripped)
  const sentenceBreaks = (stripped.match(/[A-Za-z]{2,}[.!?](?=\s|$)/g) ?? []).length
  if (proseQuestion || hasEmDash || sentenceBreaks >= 2) return true
  if (sentenceBreaks === 1 && /(?:^|\s)[A-Za-z]{2,}\.(?=\s|$)/.test(stripped)) {
    const words = stripped.match(/\b[A-Za-z]+\b/g) ?? []
    if (
      words.length >= 4 &&
      (/^[A-Z][a-z]+\s+[a-z]/.test(stripped) || PROSE_INDICATOR_WORD_RE.test(stripped))
    ) {
      return true
    }
  }
  return false
}

export class ProviderHttpError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`provider answered HTTP ${status}`)
    this.name = 'ProviderHttpError'
    this.status = status
  }
}

export class SensitiveContentBlockedError extends Error {
  readonly kind: string
  constructor(kind: string) {
    super(`Request blocked: sensitive credential detected (${kind}).`)
    this.name = 'SensitiveContentBlockedError'
    this.kind = kind
  }
}

export type FetchPostLike = (
  url: string,
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
    redirect?: RequestRedirect
    signal?: AbortSignal
  }
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
  body?: ReadableStream<Uint8Array> | null
  headers?: { get(name: string): string | null }
}>

export type FetchGetLike = (
  url: string,
  init: {
    method: 'GET'
    headers: Record<string, string>
    redirect?: RequestRedirect
    signal?: AbortSignal
  }
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  body?: ReadableStream<Uint8Array> | null
  headers?: { get(name: string): string | null }
}>

export class ReasoningExhaustedError extends Error {
  constructor() {
    super('Model spent all tokens on reasoning. Increase Inline max tokens or switch to a non-reasoning model.')
    this.name = 'ReasoningExhaustedError'
  }
}

export interface AiCompleteAdaptiveOptions {
  reasoning?: boolean
  skipEffort?: boolean
  isEffortUnsupported?: (model: string) => boolean
  markEffortUnsupported?: (model: string) => void
  onReasoningDetected?: () => void
  onEffortRejected?: () => void
  skipTemperature?: boolean
  isTemperatureUnsupported?: (model: string) => boolean
  markTemperatureUnsupported?: (model: string) => void
  onTemperatureRejected?: () => void
  onStreamDelta?: (accumulatedText: string) => void
}

export function isReasoningExhausted(format: AiProviderFormat, json: unknown): boolean {
  if ((format !== 'openai' && format !== 'mistral-fim') || !isRecord(json)) return false
  const choices = Array.isArray(json.choices) ? json.choices : []
  const first = choices[0]
  if (!isRecord(first) || first.finish_reason !== 'length') return false
  if (extractCompletionText(format, json).trim() !== '') return false
  const msg = isRecord(first.message) ? first.message : null
  return Boolean(
    msg &&
      ((typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim().length > 0) ||
        (typeof msg.reasoning === 'string' && msg.reasoning.trim().length > 0))
  )
}

interface SqlFetchResult {
  json?: unknown
  text?: string
  sawReasoning?: boolean
  finishReason?: string | null
}

interface StreamDelta {
  delta: string
  done: boolean
  finishReason: string | null
  sawReasoning: boolean
  error: string | null
}

function extractStreamErrorMessage(obj: unknown): string | null {
  if (!isRecord(obj)) return null
  if (obj.type === 'error') {
    if (isRecord(obj.error) && typeof obj.error.message === 'string' && obj.error.message.trim()) {
      return obj.error.message.trim()
    }
    if (typeof obj.message === 'string' && obj.message.trim()) return obj.message.trim()
    return 'Provider reported a streaming error.'
  }
  if (isRecord(obj.error)) {
    if (typeof obj.error.message === 'string' && obj.error.message.trim()) {
      return obj.error.message.trim()
    }
    if (typeof obj.error.type === 'string' && obj.error.type.trim()) {
      return obj.error.type.trim()
    }
    return 'Provider reported a streaming error.'
  }
  if (typeof obj.error === 'string' && obj.error.trim()) {
    return obj.error.trim()
  }
  return null
}

function extractStreamDelta(format: AiProviderFormat, obj: unknown): string {
  if (!isRecord(obj)) return ''
  if (format === 'ollama') {
    const msg = isRecord(obj.message) ? obj.message : null
    if (typeof msg?.content === 'string') return msg.content
    return typeof obj.response === 'string' ? obj.response : ''
  }
  if (format === 'anthropic') {
    const delta = isRecord(obj.delta) ? obj.delta : null
    return typeof delta?.text === 'string' ? delta.text : ''
  }
  const choices = Array.isArray(obj.choices) ? obj.choices : []
  const first = choices[0]
  if (!isRecord(first)) return ''
  const delta = isRecord(first.delta) ? first.delta : null
  if (typeof delta?.content === 'string') return delta.content
  if (Array.isArray(delta?.content)) {
    return delta.content
      .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .join('')
  }
  if (typeof delta?.text === 'string') return delta.text
  return typeof first.text === 'string' ? first.text : ''
}

function parseStreamLine(format: AiProviderFormat, rawLine: string): StreamDelta {
  const empty: StreamDelta = { delta: '', done: false, finishReason: null, sawReasoning: false, error: null }
  let line = rawLine.trim()
  if (!line) return empty
  if (line.startsWith('data:')) line = line.slice(5).trim()
  if (!line) return empty
  if (line === '[DONE]') return { ...empty, done: true }
  if (!line.startsWith('{')) return empty
  try {
    const obj: unknown = JSON.parse(line)
    const errMsg = extractStreamErrorMessage(obj)
    if (errMsg) return { ...empty, error: errMsg }
    const delta = extractStreamDelta(format, obj)
    let done = false
    let finishReason: string | null = null
    let sawReasoning = false
    if (isRecord(obj)) {
      if (format === 'ollama') {
        if (obj.done === true) done = true
        if (typeof obj.done_reason === 'string' && obj.done_reason) finishReason = obj.done_reason
        const msg = isRecord(obj.message) ? obj.message : null
        if (
          (typeof msg?.thinking === 'string' && msg.thinking.trim().length > 0) ||
          (typeof obj.thinking === 'string' && obj.thinking.trim().length > 0)
        ) {
          sawReasoning = true
        }
      } else if (format === 'anthropic') {
        if (obj.type === 'message_stop') done = true
        const d = isRecord(obj.delta) ? obj.delta : null
        if (typeof d?.stop_reason === 'string' && d.stop_reason) finishReason = d.stop_reason
        if (d?.type === 'thinking_delta' || (typeof d?.thinking === 'string' && d.thinking.trim().length > 0)) {
          sawReasoning = true
        }
      } else {
        const choices = Array.isArray(obj.choices) ? obj.choices : []
        const first = choices[0]
        if (isRecord(first)) {
          if (typeof first.finish_reason === 'string' && first.finish_reason) {
            finishReason = first.finish_reason
          }
          const d = isRecord(first.delta) ? first.delta : null
          if (
            d &&
            ((typeof d.reasoning_content === 'string' && d.reasoning_content.trim().length > 0) ||
              (typeof d.reasoning === 'string' && d.reasoning.trim().length > 0))
          ) {
            sawReasoning = true
          }
        }
      }
    }
    return { delta, done, finishReason, sawReasoning, error: null }
  } catch {
    return empty
  }
}

function stripThinkForBoundary(text: string): { visible: string; unclosedThink: boolean } {
  const withoutClosed = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const unclosedThink = /<think>/i.test(withoutClosed)
  if (unclosedThink) {
    return { visible: withoutClosed.replace(/<think>[\s\S]*$/gi, ''), unclosedThink: true }
  }
  return { visible: withoutClosed, unclosedThink: false }
}

function stripLeadingWrapperPrefix(text: string): string {
  let out = text
  out = out.replace(/^(?:\s|<COMPLETION>)+/i, '')
  const fenceStart = /^```[^\n]*\r?\n/.exec(out)
  if (fenceStart) {
    out = out.slice(fenceStart[0].length)
  }
  return out
}

function suffixOverlapStopIndex(text: string, suffix: string): number {
  const probe = suffix.trimStart().slice(0, 20)
  if (probe.replace(/\s/g, '').length < 12) return -1
  return text.indexOf(probe)
}

function findBlankLineAfterContent(text: string): number {
  const content = stripLeadingWrapperPrefix(text)
  const match = /\r?\n[ \t]*\r?\n/.exec(content)
  if (!match) return -1
  if (content.slice(0, match.index).trim().length === 0) return -1
  return (text.length - content.length) + match.index
}

interface StreamBoundaryContext {
  dialect?: AiDialect
  initialQuote?: "'" | '"' | '`' | null
}

export function findFirstUnquotedSemicolon(
  text: string,
  initialQuote: "'" | '"' | '`' | null = null,
  dialect?: AiDialect
): number {
  const rules = getDialectLexerRules(dialect)
  let inSingle = initialQuote === "'"
  let inDouble = initialQuote === '"'
  let inBacktick = initialQuote === '`'
  let escapeSingle = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (inSingle) {
      if ((rules.backslashEscapesSingleQuote || escapeSingle) && ch === '\\' && i + 1 < text.length) {
        i += 1
      } else if (ch === "'") {
        if (next === "'") i += 1
        else {
          inSingle = false
          escapeSingle = false
        }
      }
      continue
    }
    if (inDouble) {
      if (rules.backslashEscapesDoubleQuote && ch === '\\' && i + 1 < text.length) {
        i += 1
      } else if (ch === '"') {
        if (next === '"') i += 1
        else inDouble = false
      }
      continue
    }
    if (inBacktick) {
      if (ch === '`') {
        if (next === '`') i += 1
        else inBacktick = false
      }
      continue
    }
    if (rules.lineCommentDash && ch === '-' && next === '-') {
      i = scanLineCommentEnd(text, i) - 1
      continue
    }
    if (rules.lineCommentHash && ch === '#') {
      i = scanLineCommentEnd(text, i - 1) - 1
      continue
    }
    if (rules.lineCommentSlash && ch === '/' && next === '/') {
      i = scanLineCommentEnd(text, i) - 1
      continue
    }
    if (ch === '/' && next === '*') {
      i = scanBlockCommentEnd(text, i, rules.nestedBlockComments) - 1
      continue
    }
    if (rules.oracleQQuote) {
      const oq = scanOracleQuoteEnd(text, i, dialect)
      if (oq) {
        i = oq.end - 1
        continue
      }
    }
    if (rules.dollarQuoting && ch === '$') {
      const tag = matchDollarQuoteTag(text, i)
      if (tag) {
        const closeAt = text.indexOf(tag, i + tag.length)
        if (closeAt === -1) return -1
        i = closeAt + tag.length - 1
        continue
      }
    }
    if (
      rules.postgresEscapeString &&
      (ch === 'E' || ch === 'e') &&
      next === "'" &&
      isPostgresEscapeStringStart(text, i, dialect)
    ) {
      inSingle = true
      escapeSingle = true
      i += 1
      continue
    }
    if (ch === '[' && rules.bracketIdentifiers !== 'none') {
      i = scanBracketIdentEnd(text, i, rules.bracketIdentifiers === 'doubling').end - 1
      continue
    }
    if (ch === "'") {
      inSingle = true
      escapeSingle = false
    } else if (ch === '"' && rules.doubleQuoteIdentifiers) {
      inDouble = true
    } else if (ch === '`' && rules.backtickIdentifiers) {
      inBacktick = true
    } else if (ch === ';') {
      return i
    }
  }
  return -1
}

function statementEnded(
  text: string,
  multiline: boolean,
  suffix = '',
  boundaryCtx?: StreamBoundaryContext
): boolean {
  const { visible, unclosedThink } = stripThinkForBoundary(text)
  if (unclosedThink) return false
  if (!visible) return false
  if (/<\/COMPLETION>/i.test(visible)) return true
  if (suffixOverlapStopIndex(visible, suffix) > 0) return true
  if (!multiline) {
    const content = stripLeadingWrapperPrefix(visible)
    if (content.includes('\n')) return true
    if (visible.trimStart().startsWith('```') && !content && visible.includes('\n')) {
      return false
    }
  }
  if (findBlankLineAfterContent(visible) >= 0) return true
  const lines = visible.split('\n')
  const nonEmpty = collectNonEmptyIndices(lines)
  if (nonEmpty.length >= 3 && findTrailingLineCycleKeepEnd(lines, nonEmpty) !== null) {
    return true
  }
  if (boundaryCtx?.dialect === 'redis') return false
  return findFirstUnquotedSemicolon(visible, boundaryCtx?.initialQuote ?? null, boundaryCtx?.dialect) >= 0
}

function applyBoundary(
  text: string,
  multiline: boolean,
  suffix = '',
  boundaryCtx?: StreamBoundaryContext
): { text: string; done: boolean } {
  const { visible, unclosedThink } = stripThinkForBoundary(text)
  if (unclosedThink) return { text, done: false }
  if (!statementEnded(visible, multiline, suffix, boundaryCtx)) return { text: visible, done: false }
  let out = visible
  const closeIdx = out.search(/<\/COMPLETION>/i)
  if (closeIdx !== -1) {
    out = out.slice(0, closeIdx)
  }
  const suffixOverlapAt = suffixOverlapStopIndex(out, suffix)
  if (suffixOverlapAt > 0) {
    out = out.slice(0, suffixOverlapAt)
  }
  if (boundaryCtx?.dialect !== 'redis') {
    const firstSemi = findFirstUnquotedSemicolon(out, boundaryCtx?.initialQuote ?? null, boundaryCtx?.dialect)
    if (firstSemi >= 0) {
      out = out.slice(0, firstSemi + 1)
    }
  }
  if (!multiline) {
    const trimmed = out.trimStart()
    const hasOpenFence = trimmed.startsWith('```')
    const hasOpenTag = /^<COMPLETION>/i.test(trimmed)
    if (hasOpenFence || hasOpenTag) {
      const content = stripLeadingWrapperPrefix(out)
      const contentNl = content.indexOf('\n')
      if (contentNl !== -1) {
        const prefixLen = out.length - content.length
        out = out.slice(0, prefixLen + contentNl)
      }
    } else {
      const leadingEmptyMatch = /^(?:[ \t]*\r?\n)+/.exec(out)
      if (leadingEmptyMatch) {
        out = out.slice(leadingEmptyMatch[0].length)
      }
      const newline = out.indexOf('\n')
      if (newline !== -1) out = out.slice(0, newline)
    }
  } else {
    const blankBreak = findBlankLineAfterContent(out)
    if (blankBreak !== -1) out = out.slice(0, blankBreak)
  }
  const trimmedOut = out.trimEnd()
  if (
    trimmedOut.length > 0 &&
    /[ \t]+$/.test(out) &&
    !/\r?\n$/.test(out) &&
    suffix.length > 0 &&
    /^[A-Za-z0-9_'"`(]/.test(suffix)
  ) {
    return { text: `${trimmedOut} `, done: true }
  }
  return { text: trimmedOut, done: true }
}

export class AiResponseTooLargeError extends Error {
  readonly maxBytes: number
  constructor(maxBytes: number) {
    super(`AI provider response exceeded the ${Math.round(maxBytes / 1024)} KiB limit.`)
    this.name = 'AiResponseTooLargeError'
    this.maxBytes = maxBytes
  }
}

async function readBodyAll(
  body: ReadableStream<Uint8Array>,
  maxBytes = AI_MAX_COMPLETION_BODY_BYTES
): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let totalBytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new AiResponseTooLargeError(maxBytes)
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // reader already released/cancelled
    }
  }
  return text
}

function isTimeoutAbortReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'TimeoutError'
}

async function readStreamBody(
  format: AiProviderFormat,
  body: ReadableStream<Uint8Array>,
  multiline: boolean,
  onEarlyStop?: () => void,
  maxBytes = AI_MAX_COMPLETION_BODY_BYTES,
  suffix = '',
  signal?: AbortSignal,
  onDelta?: (accumulatedText: string) => void,
  boundaryCtx?: StreamBoundaryContext
): Promise<{ text: string; sawReasoning: boolean; finishReason: string | null }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let totalBytes = 0
  let sawReasoning = false
  let finishReason: string | null = null
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (err) {
        const visibleTrimmed = stripSpecialCompletionTokens(text).trim()
        if (
          visibleTrimmed.length > 0 &&
          (isTimeoutAbortReason(err) || isTimeoutAbortReason(signal?.reason))
        ) {
          return {
            text: applyBoundary(text, multiline, suffix, boundaryCtx).text,
            sawReasoning,
            finishReason,
          }
        }
        throw err
      }
      const { done, value } = chunk
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        onEarlyStop?.()
        throw new AiResponseTooLargeError(maxBytes)
      }
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const parsed = parseStreamLine(format, line)
        if (parsed.error) {
          await reader.cancel().catch(() => undefined)
          onEarlyStop?.()
          throw new Error(parsed.error)
        }
        if (parsed.sawReasoning) sawReasoning = true
        if (parsed.finishReason) finishReason = parsed.finishReason
        if (parsed.delta) {
          text += parsed.delta
          onDelta?.(text)
          const boundary = applyBoundary(text, multiline, suffix, boundaryCtx)
          if (boundary.done) {
            await reader.cancel().catch(() => undefined)
            onEarlyStop?.()
            return { text: boundary.text, sawReasoning, finishReason }
          }
        }
        if (parsed.done) {
          await reader.cancel().catch(() => undefined)
          onEarlyStop?.()
          return {
            text: applyBoundary(text, multiline, suffix, boundaryCtx).text,
            sawReasoning,
            finishReason,
          }
        }
        newline = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      const tail = parseStreamLine(format, buffer)
      if (tail.error) throw new Error(tail.error)
      if (tail.sawReasoning) sawReasoning = true
      if (tail.finishReason) finishReason = tail.finishReason
      if (tail.delta) {
        text += tail.delta
        onDelta?.(text)
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // reader already released/cancelled
    }
  }
  return {
    text: applyBoundary(text, multiline, suffix, boundaryCtx).text,
    sawReasoning,
    finishReason,
  }
}

function parseStreamText(
  format: AiProviderFormat,
  raw: string,
  multiline: boolean,
  suffix = '',
  boundaryCtx?: StreamBoundaryContext
): { text: string; sawReasoning: boolean; finishReason: string | null } {
  let text = ''
  let sawReasoning = false
  let finishReason: string | null = null
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseStreamLine(format, line)
    if (parsed.error) throw new Error(parsed.error)
    if (parsed.sawReasoning) sawReasoning = true
    if (parsed.finishReason) finishReason = parsed.finishReason
    if (parsed.delta) {
      text += parsed.delta
      if (applyBoundary(text, multiline, suffix, boundaryCtx).done) break
    }
    if (parsed.done) break
  }
  return {
    text: applyBoundary(text, multiline, suffix, boundaryCtx).text,
    sawReasoning,
    finishReason,
  }
}

interface ChatReadResult {
  text: string
  sawReasoning: boolean
  finishReason: string | null
  json?: unknown
}

async function readChatStreamBody(
  format: AiProviderFormat,
  body: ReadableStream<Uint8Array>,
  maxBytes = AI_MAX_EXPLAIN_BODY_BYTES
): Promise<ChatReadResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let totalBytes = 0
  let sawReasoning = false
  let finishReason: string | null = null
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new AiResponseTooLargeError(maxBytes)
      }
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const parsed = parseStreamLine(format, line)
        if (parsed.error) {
          await reader.cancel().catch(() => undefined)
          throw new Error(parsed.error)
        }
        if (parsed.sawReasoning) sawReasoning = true
        if (parsed.finishReason) finishReason = parsed.finishReason
        if (parsed.delta) {
          text += parsed.delta
        }
        if (parsed.done) {
          await reader.cancel().catch(() => undefined)
          return { text, sawReasoning, finishReason }
        }
        newline = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      const tail = parseStreamLine(format, buffer)
      if (tail.error) throw new Error(tail.error)
      if (tail.sawReasoning) sawReasoning = true
      if (tail.finishReason) finishReason = tail.finishReason
      if (tail.delta) text += tail.delta
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // reader already released/cancelled
    }
  }
  return { text, sawReasoning, finishReason }
}

function parseChatStreamText(format: AiProviderFormat, raw: string): ChatReadResult {
  let text = ''
  let sawReasoning = false
  let finishReason: string | null = null
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseStreamLine(format, line)
    if (parsed.error) throw new Error(parsed.error)
    if (parsed.sawReasoning) sawReasoning = true
    if (parsed.finishReason) finishReason = parsed.finishReason
    if (parsed.delta) text += parsed.delta
    if (parsed.done) break
  }
  return { text, sawReasoning, finishReason }
}

async function readChatResult(
  format: AiProviderFormat,
  response: Awaited<ReturnType<FetchPostLike>>,
  maxBytes = AI_MAX_EXPLAIN_BODY_BYTES
): Promise<ChatReadResult> {
  const rawLength = response.headers?.get('content-length')
  if (rawLength !== null && rawLength !== undefined && rawLength.trim() !== '') {
    const declared = Number(rawLength)
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new AiResponseTooLargeError(maxBytes)
    }
  }
  const contentType = (response.headers?.get('content-type') ?? '').toLowerCase()
  const isStreamType = /text\/event-stream|x-ndjson/.test(contentType)
  if (isStreamType && response.body) {
    return await readChatStreamBody(format, response.body, maxBytes)
  }
  if (!response.body) {
    const json = await readJsonBounded(response, maxBytes)
    return {
      text: extractChatText(format, json),
      sawReasoning: false,
      finishReason: extractFinishReasonFromJson(format, json),
      json,
    }
  }
  const raw = await readBodyAll(response.body, maxBytes)
  const trimmed = raw.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const json: unknown = JSON.parse(raw)
      return {
        text: extractChatText(format, json),
        sawReasoning: false,
        finishReason: extractFinishReasonFromJson(format, json),
        json,
      }
    } catch {
      // Fall through to SSE/NDJSON line parsing when a proxy omits stream content-type
    }
  }
  return parseChatStreamText(format, raw)
}

function waitAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error('Aborted'))
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('Aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function readJsonBounded(
  response: {
    json(): Promise<unknown>
    body?: ReadableStream<Uint8Array> | null
    headers?: { get(name: string): string | null }
  },
  maxBytes: number
): Promise<unknown> {
  const rawLength = response.headers?.get('content-length')
  if (rawLength !== null && rawLength !== undefined && rawLength.trim() !== '') {
    const declared = Number(rawLength)
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new AiResponseTooLargeError(maxBytes)
    }
  }
  if (response.body) {
    const raw = await readBodyAll(response.body, maxBytes)
    return JSON.parse(raw)
  }
  return await response.json()
}

async function readCompletionResult(
  format: AiProviderFormat,
  response: Awaited<ReturnType<FetchPostLike>>,
  multiline: boolean,
  onEarlyStop?: () => void,
  suffix = '',
  signal?: AbortSignal,
  onDelta?: (accumulatedText: string) => void,
  boundaryCtx?: StreamBoundaryContext
): Promise<SqlFetchResult> {
  const rawLength = response.headers?.get('content-length')
  if (rawLength !== null && rawLength !== undefined && rawLength.trim() !== '') {
    const declared = Number(rawLength)
    if (Number.isFinite(declared) && declared > AI_MAX_COMPLETION_BODY_BYTES) {
      await response.body?.cancel().catch(() => undefined)
      onEarlyStop?.()
      throw new AiResponseTooLargeError(AI_MAX_COMPLETION_BODY_BYTES)
    }
  }
  const contentType = (response.headers?.get('content-type') ?? '').toLowerCase()
  const isStreamType = /text\/event-stream|x-ndjson/.test(contentType)
  if (isStreamType && response.body) {
    const streamed = await readStreamBody(
      format,
      response.body,
      multiline,
      onEarlyStop,
      AI_MAX_COMPLETION_BODY_BYTES,
      suffix,
      signal,
      onDelta,
      boundaryCtx
    )
    return {
      text: streamed.text,
      sawReasoning: streamed.sawReasoning,
      finishReason: streamed.finishReason,
    }
  }
  if (!response.body) {
    return { json: await readJsonBounded(response, AI_MAX_COMPLETION_BODY_BYTES) }
  }
  const raw = await readBodyAll(response.body, AI_MAX_COMPLETION_BODY_BYTES)
  const trimmed = raw.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return { json: JSON.parse(raw) }
    } catch {
      // fall through to stream parsing
    }
  }
  const parsed = parseStreamText(format, raw, multiline, suffix, boundaryCtx)
  return {
    text: parsed.text,
    sawReasoning: parsed.sawReasoning,
    finishReason: parsed.finishReason,
  }
}

function resultText(format: AiProviderFormat, result: SqlFetchResult): string {
  return result.text !== undefined ? result.text : extractCompletionText(format, result.json)
}

function resultExhausted(format: AiProviderFormat, result: SqlFetchResult): boolean {
  if (result.json !== undefined && isReasoningExhausted(format, result.json)) return true
  return Boolean(
    result.sawReasoning &&
      !(result.text ?? '').trim() &&
      (result.finishReason === 'length' || result.finishReason === 'max_tokens')
  )
}

function buildHealedCompletionRequest(
  req: AiCompletionRequest,
  typo: ResolvedTrailingTypoToken
): AiCompletionRequest {
  const rawTail = `${typo.rawWord}${typo.trailingSpaces}`
  const healedTail = `${typo.correctedWord}${typo.trailingSpaces ? ' ' : ''}`
  const nextFimPrefix =
    req.fimPrefix !== undefined && req.fimPrefix.endsWith(rawTail)
      ? `${req.fimPrefix.slice(0, req.fimPrefix.length - rawTail.length)}${healedTail}`
      : req.fimPrefix
  const cursorNeedle = `${rawTail}<CURSOR>`
  const nextUser = req.user.includes(cursorNeedle)
    ? req.user.replace(cursorNeedle, `${healedTail}<CURSOR>`)
    : req.user
  return {
    ...req,
    prefix: typo.healedPrefix,
    fimPrefix: nextFimPrefix,
    user: nextUser,
  }
}

export async function completeSqlWithMeta(
  provider: AiProviderConfig,
  req: AiCompletionRequest,
  signal: AbortSignal,
  fetchImpl: FetchPostLike = fetch as unknown as FetchPostLike,
  adaptiveOpts?: AiCompleteAdaptiveOptions
): Promise<SqlCompletionResult> {
  const empty: SqlCompletionResult = { suggestion: '', replaceChars: 0 }
  if (
    hasSensitiveContent(
      req.prefix,
      req.suffix,
      `${req.user}\n${req.fimPrefix ?? ''}\n${req.fimSuffix ?? ''}\n${req.fimSchemaDdl ?? ''}\n${req.fimHistorySql ?? ''}\n${req.fimPriorSql ?? ''}`,
      req.dialect
    )
  ) {
    return empty
  }

  const typo = resolveTrailingTypoToken(req.prefix, req.dialect, req.knownIdentifiers)
  const effectiveReq = typo ? buildHealedCompletionRequest(req, typo) : req
  const boundaryCtx: StreamBoundaryContext = {
    dialect: effectiveReq.dialect,
    initialQuote:
      effectiveReq.dialect === 'redis'
        ? null
        : scanSqlBoundaryState(effectiveReq.prefix, effectiveReq.dialect).inQuote,
  }

  const multiline = effectiveReq.multiline !== false
  const baseTokens = multiline ? provider.maxTokens : Math.min(provider.maxTokens, 48)
  const baseStops = ['</COMPLETION>']
  const fimStops = getModelFimStopTokens(provider.model)
  const stop =
    provider.format === 'ollama' || provider.format === 'mistral-fim'
      ? Array.from(new Set([...fimStops, ...(multiline ? ['\n\n', '```'] : ['\n', '```'])]))
      : baseStops
  let effortDisabled = false
  let temperatureDisabled = false
  const isEffortAllowed = (): boolean =>
    provider.format === 'openai' &&
    !effortDisabled &&
    !adaptiveOpts?.skipEffort &&
    !(adaptiveOpts?.isEffortUnsupported?.(provider.model) ?? false)
  const isTemperatureAllowed = (): boolean =>
    (provider.format === 'openai' || provider.format === 'anthropic') &&
    !temperatureDisabled &&
    !adaptiveOpts?.skipTemperature &&
    !(adaptiveOpts?.isTemperatureUnsupported?.(provider.model) ?? false)
  const stopAllowed = true

  const attempt = async (
    tokens: number,
    withEffort: boolean,
    withTemperature: boolean,
    withStop: boolean
  ): Promise<SqlFetchResult> => {
    const extra: Record<string, unknown> = {}
    if (provider.format === 'openai' && withEffort) {
      extra.reasoning_effort = 'none'
    }
    if ((provider.format === 'openai' || provider.format === 'anthropic') && withTemperature) {
      extra.temperature = CHAT_INLINE_TEMPERATURE
    }
    const { url, init } = buildCompletionRequest(
      { ...provider, maxTokens: tokens },
      effectiveReq,
      Object.keys(extra).length > 0 ? extra : undefined,
      true,
      withStop ? stop : undefined
    )
    const streamAbortController = new AbortController()
    const onCallerAbort = () => streamAbortController.abort(signal.reason)
    if (signal.aborted) {
      streamAbortController.abort(signal.reason)
    } else {
      signal.addEventListener('abort', onCallerAbort, { once: true })
    }
    try {
      const response = await fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: streamAbortController.signal,
      })
      if (!response.ok) {
        throw new ProviderHttpError(response.status)
      }
      return await readCompletionResult(
        provider.format,
        response,
        multiline,
        () => streamAbortController.abort(),
        effectiveReq.suffix,
        signal,
        adaptiveOpts?.onStreamDelta,
        boundaryCtx
      )
    } finally {
      signal.removeEventListener('abort', onCallerAbort)
    }
  }

  const runWithFallback = async (
    tokens: number,
    allowStop: boolean
  ): Promise<SqlFetchResult> => {
    let curEffort = isEffortAllowed()
    let curTemperature = isTemperatureAllowed()
    let curStop = allowStop
    for (;;) {
      try {
        return await attempt(tokens, curEffort, curTemperature, curStop)
      } catch (err) {
        if (
          err instanceof ProviderHttpError &&
          (err.status === 400 || err.status === 422)
        ) {
          if (curEffort) {
            curEffort = false
            effortDisabled = true
            if (adaptiveOpts && !Object.isFrozen(adaptiveOpts)) {
              adaptiveOpts.skipEffort = true
            }
            adaptiveOpts?.markEffortUnsupported?.(provider.model)
            adaptiveOpts?.onEffortRejected?.()
            continue
          }
          if (curTemperature) {
            curTemperature = false
            temperatureDisabled = true
            if (adaptiveOpts && !Object.isFrozen(adaptiveOpts)) {
              adaptiveOpts.skipTemperature = true
            }
            adaptiveOpts?.markTemperatureUnsupported?.(provider.model)
            adaptiveOpts?.onTemperatureRejected?.()
            continue
          }
          if (curStop) {
            curStop = false
            continue
          }
        }
        throw err
      }
    }
  }

  const bumpedTokens = Math.max(provider.maxTokens, 512)
  const canAdapt = provider.format === 'openai' || provider.format === 'mistral-fim'
  let result: SqlFetchResult
  if (canAdapt && adaptiveOpts?.reasoning) {
    result = await runWithFallback(bumpedTokens, stopAllowed)
  } else {
    result = await runWithFallback(baseTokens, stopAllowed)
    if (canAdapt && resultExhausted(provider.format, result)) {
      adaptiveOpts?.onReasoningDetected?.()
      result = await runWithFallback(bumpedTokens, stopAllowed)
    }
  }

  if (canAdapt && resultExhausted(provider.format, result)) {
    throw new ReasoningExhaustedError()
  }

  const raw = resultText(provider.format, result)
  if (looksInjected(raw)) return empty
  const hadTrailingMarker = TRAILING_SPECIAL_MARKER_RE.test(raw)
  const unfenced = extractUnfencedSuggestion(raw, effectiveReq.prefix, effectiveReq.dialect)
  const cleaned =
    effectiveReq.dialect !== 'redis'
      ? (() => {
          const semiAt = findFirstUnquotedSemicolon(
            unfenced,
            boundaryCtx.initialQuote ?? null,
            effectiveReq.dialect
          )
          return semiAt >= 0 ? unfenced.slice(0, semiAt + 1) : unfenced
        })()
      : unfenced
  const deduped = dropDuplicatedFromSuffix(
    removeRepetitiveBlocks(removeRepetitiveLines(cleaned)),
    req.suffix
  )
  const singleLine = trimMultiLineInSingleLineMode(deduped, effectiveReq.suffix, multiline)
  const echoed = trimPrefixEcho(
    singleLine,
    effectiveReq.prefix,
    effectiveReq.dialect,
    effectiveReq.knownIdentifiers
  )
  const withoutCaret = stripTrailingCaretPipe(
    echoed,
    effectiveReq.prefix,
    effectiveReq.dialect,
    hadTrailingMarker
  )
  const bracketed = matchCompletionBrackets(
    withoutCaret,
    effectiveReq.prefix,
    effectiveReq.dialect,
    effectiveReq.suffix
  )
  const notRewritten = skipRewrittenSuffix(bracketed, effectiveReq.suffix)
  const overlapped = trimSingleLineSuffixOverlap(
    trimSuffixOverlap(notRewritten, effectiveReq.suffix),
    effectiveReq.suffix,
    effectiveReq.prefix,
    effectiveReq.dialect
  )
  const groundedSources: string[] = []
  if (effectiveReq.fimHistorySql) groundedSources.push(effectiveReq.fimHistorySql)
  if (effectiveReq.fimPriorSql) groundedSources.push(effectiveReq.fimPriorSql)
  const grounded = trimFabricatedFilterLiterals(
    overlapped,
    effectiveReq.prefix,
    effectiveReq.suffix,
    groundedSources,
    effectiveReq.dialect
  )
  if (typo) {
    if (grounded && isProseExplanation(grounded)) return empty
    let fullSuggestion: string
    if (typo.trailingSpaces.length > 0) {
      const cont = normalizeCompletionBoundary(
        grounded,
        typo.healedPrefix,
        effectiveReq.dialect,
        effectiveReq.knownIdentifiers,
        effectiveReq.suffix
      )
      fullSuggestion = cont.trim() ? `${typo.correctedWord} ${cont.trimStart()}` : `${typo.correctedWord} `
    } else if (grounded) {
      const needsSeparator =
        /^[A-Za-z0-9_]/.test(grounded) ||
        (VALID_SQL_WORDS.has(typo.correctedWord.toUpperCase()) && /^[*'"`[]/.test(grounded))
      fullSuggestion = needsSeparator
        ? `${typo.correctedWord} ${grounded}`
        : `${typo.correctedWord}${grounded}`
    } else {
      fullSuggestion = typo.correctedWord
    }
    return isProseExplanation(fullSuggestion)
      ? empty
      : { suggestion: fullSuggestion, replaceChars: typo.replaceChars }
  }
  const replacement = detectLeadingTokenReplacement(
    req.prefix,
    grounded,
    req.dialect,
    req.knownIdentifiers
  )
  if (replacement) {
    return isProseExplanation(replacement.suggestion) ? empty : replacement
  }
  const final = normalizeCompletionBoundary(
    grounded,
    req.prefix,
    req.dialect,
    req.knownIdentifiers,
    req.suffix
  )
  if (!final || isProseExplanation(final)) return empty
  if (
    (provider.format === 'ollama' || provider.format === 'mistral-fim') &&
    doesInsertionIntroduceGrammarError(req.prefix, final, req.suffix, req.dialect)
  ) {
    return empty
  }
  return { suggestion: final, replaceChars: 0 }
}

export async function completeSql(
  provider: AiProviderConfig,
  req: AiCompletionRequest,
  signal: AbortSignal,
  fetchImpl: FetchPostLike = fetch as unknown as FetchPostLike,
  adaptiveOpts?: AiCompleteAdaptiveOptions
): Promise<string> {
  const res = await completeSqlWithMeta(provider, req, signal, fetchImpl, adaptiveOpts)
  return res.replaceChars > 0 ? '' : res.suggestion
}

export interface StatementEditCompletionRequest {
  dialect?: AiDialect
  system: string
  user: string
  statement: string
}

export interface StatementEditCompletionResult {
  raw: string
  finishReason: string | null
}

interface ParsedEditStreamMeta {
  delta: string
  done: boolean
  finishReason: string | null
  sawReasoning: boolean
  error: string | null
}

function parseStatementEditStreamLine(format: AiProviderFormat, rawLine: string): ParsedEditStreamMeta {
  const parsed = parseStreamLine(format, rawLine)
  return {
    delta: parsed.delta,
    done: parsed.done,
    finishReason: parsed.finishReason,
    sawReasoning: parsed.sawReasoning,
    error: parsed.error,
  }
}

function extractFinishReasonFromJson(format: AiProviderFormat, json: unknown): string | null {
  if (!isRecord(json)) return null
  if (format === 'ollama') return typeof json.done_reason === 'string' ? json.done_reason : null
  if (format === 'anthropic') return typeof json.stop_reason === 'string' ? json.stop_reason : null
  const choices = Array.isArray(json.choices) ? json.choices : []
  const first = choices[0]
  return isRecord(first) && typeof first.finish_reason === 'string' ? first.finish_reason : null
}

function shouldStopEditStreamText(text: string): boolean {
  const { visible, unclosedThink } = stripThinkForBoundary(text)
  if (unclosedThink) return false
  if (/<\/REWRITE>/i.test(visible)) return true
  const withoutOpen = visible.replace(/<REWRITE>/i, '')
  const openFence = /^\s*```[^\n]*\r?\n/.exec(withoutOpen)
  if (openFence) {
    const rest = withoutOpen.slice(openFence[0].length)
    return /\r?\n?```/.test(rest)
  }
  return false
}

async function readStatementEditStreamBody(
  format: AiProviderFormat,
  body: ReadableStream<Uint8Array>,
  onEarlyStop?: () => void,
  maxBytes = AI_MAX_COMPLETION_BODY_BYTES
): Promise<{ text: string; finishReason: string | null; sawReasoning: boolean }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let totalBytes = 0
  let finishReason: string | null = null
  let sawReasoning = false
  try {
    for (;;) {
      // Do NOT swallow TimeoutError on partial statement edits (incomplete <REWRITE> risks truncating SQL)
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        onEarlyStop?.()
        throw new AiResponseTooLargeError(maxBytes)
      }
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const parsed = parseStatementEditStreamLine(format, line)
        if (parsed.error) {
          await reader.cancel().catch(() => undefined)
          onEarlyStop?.()
          throw new Error(parsed.error)
        }
        if (parsed.finishReason) finishReason = parsed.finishReason
        if (parsed.sawReasoning) sawReasoning = true
        if (parsed.delta) {
          text += parsed.delta
          if (shouldStopEditStreamText(text)) {
            await reader.cancel().catch(() => undefined)
            onEarlyStop?.()
            return { text, finishReason, sawReasoning }
          }
        }
        if (parsed.done) {
          await reader.cancel().catch(() => undefined)
          onEarlyStop?.()
          return { text, finishReason, sawReasoning }
        }
        newline = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      const tail = parseStatementEditStreamLine(format, buffer)
      if (tail.error) throw new Error(tail.error)
      if (tail.finishReason) finishReason = tail.finishReason
      if (tail.sawReasoning) sawReasoning = true
      if (tail.delta) text += tail.delta
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // reader already released/cancelled
    }
  }
  return { text, finishReason, sawReasoning }
}

/** Requests a statement-level `<REWRITE>` completion for Mini-NEP Tier 2 using dynamic token budget and timeout safety. */
export async function completeSqlStatementEdit(
  provider: AiProviderConfig,
  req: StatementEditCompletionRequest,
  signal: AbortSignal,
  fetchImpl: FetchPostLike = fetch as unknown as FetchPostLike,
  adaptiveOpts?: AiCompleteAdaptiveOptions
): Promise<StatementEditCompletionResult> {
  const empty: StatementEditCompletionResult = { raw: '', finishReason: null }
  if (hasSensitiveContent(req.statement, '', `${req.user}\n${req.statement}`, req.dialect)) {
    return empty
  }

  const estimatedStmtTokens = Math.ceil(req.statement.length / 3.2)
  const nepMaxTokens = Math.min(
    2048,
    Math.max(provider.maxTokens, estimatedStmtTokens + Math.max(provider.maxTokens, 96) + 32)
  )
  const editStops = ['</REWRITE>']

  let effortDisabled = false
  let temperatureDisabled = false
  const isEffortAllowed = (): boolean =>
    provider.format === 'openai' &&
    !effortDisabled &&
    !adaptiveOpts?.skipEffort &&
    !(adaptiveOpts?.isEffortUnsupported?.(provider.model) ?? false)
  const isTemperatureAllowed = (): boolean =>
    (provider.format === 'openai' || provider.format === 'anthropic' || provider.format === 'ollama') &&
    !temperatureDisabled &&
    !adaptiveOpts?.skipTemperature &&
    !(adaptiveOpts?.isTemperatureUnsupported?.(provider.model) ?? false)

  const attempt = async (
    tokens: number,
    withEffort: boolean,
    withTemperature: boolean,
    withStop: boolean
  ): Promise<{ raw: string; finishReason: string | null; sawReasoning: boolean; json?: unknown }> => {
    const extra: Record<string, unknown> = {}
    if (provider.format === 'openai' && withEffort) {
      extra.reasoning_effort = 'none'
    }
    if (withTemperature) {
      extra.temperature = CHAT_INLINE_TEMPERATURE
    }
    if (withStop) {
      if (provider.format === 'anthropic') {
        extra.stop_sequences = editStops
      } else {
        extra.stop = editStops
      }
    }
    const { url, init } = buildChatRequest(
      provider,
      req.system,
      req.user,
      tokens,
      Object.keys(extra).length > 0 ? extra : undefined,
      true
    )
    const streamAbortController = new AbortController()
    const onCallerAbort = () => streamAbortController.abort(signal.reason)
    if (signal.aborted) {
      streamAbortController.abort(signal.reason)
    } else {
      signal.addEventListener('abort', onCallerAbort, { once: true })
    }
    try {
      const response = await fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: streamAbortController.signal,
      })
      if (!response.ok) {
        throw new ProviderHttpError(response.status)
      }
      const rawLength = response.headers?.get('content-length')
      if (rawLength !== null && rawLength !== undefined && rawLength.trim() !== '') {
        const declared = Number(rawLength)
        if (Number.isFinite(declared) && declared > AI_MAX_COMPLETION_BODY_BYTES) {
          await response.body?.cancel().catch(() => undefined)
          streamAbortController.abort()
          throw new AiResponseTooLargeError(AI_MAX_COMPLETION_BODY_BYTES)
        }
      }
      const contentType = (response.headers?.get('content-type') ?? '').toLowerCase()
      if (/text\/event-stream|x-ndjson/.test(contentType) && response.body) {
        const streamed = await readStatementEditStreamBody(
          provider.format,
          response.body,
          () => streamAbortController.abort(),
          AI_MAX_COMPLETION_BODY_BYTES
        )
        return {
          raw: streamed.text,
          finishReason: streamed.finishReason,
          sawReasoning: streamed.sawReasoning,
        }
      }
      if (!response.body) {
        const json = await readJsonBounded(response, AI_MAX_COMPLETION_BODY_BYTES)
        return {
          raw: extractChatText(provider.format, json),
          finishReason: extractFinishReasonFromJson(provider.format, json),
          sawReasoning: false,
          json,
        }
      }
      const bodyText = await readBodyAll(response.body, AI_MAX_COMPLETION_BODY_BYTES)
      const trimmed = bodyText.trimStart()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const json: unknown = JSON.parse(bodyText)
          return {
            raw: extractChatText(provider.format, json),
            finishReason: extractFinishReasonFromJson(provider.format, json),
            sawReasoning: false,
            json,
          }
        } catch {
          // fall through to SSE text parsing
        }
      }
      let parsedText = ''
      let parsedFinish: string | null = null
      let parsedReasoning = false
      for (const line of bodyText.split(/\r?\n/)) {
        const parsed = parseStatementEditStreamLine(provider.format, line)
        if (parsed.finishReason) parsedFinish = parsed.finishReason
        if (parsed.sawReasoning) parsedReasoning = true
        if (parsed.delta) {
          parsedText += parsed.delta
          if (shouldStopEditStreamText(parsedText)) break
        }
        if (parsed.done) break
      }
      return { raw: parsedText, finishReason: parsedFinish, sawReasoning: parsedReasoning }
    } finally {
      signal.removeEventListener('abort', onCallerAbort)
    }
  }

  const runWithFallback = async (
    tokens: number,
    allowStop: boolean
  ): Promise<{ raw: string; finishReason: string | null; sawReasoning: boolean; json?: unknown }> => {
    let curEffort = isEffortAllowed()
    let curTemperature = isTemperatureAllowed()
    let curStop = allowStop
    for (;;) {
      try {
        return await attempt(tokens, curEffort, curTemperature, curStop)
      } catch (err) {
        if (
          err instanceof ProviderHttpError &&
          (err.status === 400 || err.status === 422)
        ) {
          if (curEffort) {
            curEffort = false
            effortDisabled = true
            if (adaptiveOpts && !Object.isFrozen(adaptiveOpts)) adaptiveOpts.skipEffort = true
            adaptiveOpts?.markEffortUnsupported?.(provider.model)
            adaptiveOpts?.onEffortRejected?.()
            continue
          }
          if (curTemperature) {
            curTemperature = false
            temperatureDisabled = true
            if (adaptiveOpts && !Object.isFrozen(adaptiveOpts)) adaptiveOpts.skipTemperature = true
            adaptiveOpts?.markTemperatureUnsupported?.(provider.model)
            adaptiveOpts?.onTemperatureRejected?.()
            continue
          }
          if (curStop) {
            curStop = false
            continue
          }
        }
        throw err
      }
    }
  }

  const bumpedTokens = Math.min(2048, Math.max(nepMaxTokens, 512))
  const canAdapt = provider.format === 'openai' || provider.format === 'mistral-fim'
  let res =
    canAdapt && adaptiveOpts?.reasoning
      ? await runWithFallback(bumpedTokens, true)
      : await runWithFallback(nepMaxTokens, true)

  const exhausted =
    (res.json !== undefined && isReasoningExhausted(provider.format, res.json)) ||
    (res.sawReasoning && !res.raw.trim() && (res.finishReason === 'length' || res.finishReason === 'max_tokens'))

  if (canAdapt && !adaptiveOpts?.reasoning && exhausted) {
    adaptiveOpts?.onReasoningDetected?.()
    res = await runWithFallback(bumpedTokens, true)
  }

  const exhaustedAfter =
    (res.json !== undefined && isReasoningExhausted(provider.format, res.json)) ||
    (res.sawReasoning && !res.raw.trim() && (res.finishReason === 'length' || res.finishReason === 'max_tokens'))
  if (canAdapt && exhaustedAfter) {
    throw new ReasoningExhaustedError()
  }

  return { raw: res.raw, finishReason: res.finishReason }
}

export async function completeChat(
  provider: AiProviderConfig,
  system: string,
  user: string,
  maxTokens: number,
  signal: AbortSignal,
  fetchImpl: FetchPostLike = fetch as unknown as FetchPostLike,
  dialect?: AiDialect
): Promise<string> {
  const secretKind = hasSensitiveContent(user, '', '', dialect)
  if (secretKind) {
    throw new SensitiveContentBlockedError(secretKind)
  }

  let useEffort = provider.format === 'openai'
  let useStream = true
  let retriedTransient = false

  for (;;) {
    const extraBody = useEffort ? { reasoning_effort: 'low' } : undefined
    const { url, init } = buildChatRequest(provider, system, user, maxTokens, extraBody, useStream)
    try {
      const response = await fetchImpl(url, { ...init, redirect: 'error', signal })
      if (!response.ok) {
        throw new ProviderHttpError(response.status)
      }
      const chatResult = await readChatResult(provider.format, response, AI_MAX_EXPLAIN_BODY_BYTES)
      const exhausted =
        (chatResult.json !== undefined && isReasoningExhausted(provider.format, chatResult.json)) ||
        (chatResult.sawReasoning &&
          !chatResult.text.trim() &&
          (chatResult.finishReason === 'length' || chatResult.finishReason === 'max_tokens'))
      if (exhausted) {
        throw new ReasoningExhaustedError()
      }
      if (looksInjected(chatResult.text)) return ''
      return chatResult.text
    } catch (err) {
      if (err instanceof ProviderHttpError && (err.status === 400 || err.status === 422)) {
        if (useEffort) {
          useEffort = false
          continue
        }
        if (useStream) {
          useStream = false
          continue
        }
      }
      if (
        !retriedTransient &&
        err instanceof ProviderHttpError &&
        TRANSIENT_GATEWAY_STATUSES.has(err.status)
      ) {
        retriedTransient = true
        await waitAbortable(AI_CHAT_RETRY_DELAY_MS, signal)
        continue
      }
      throw err
    }
  }
}

const NOT_FOR_CODE_RE = /embed|tts|whisper|asr|transcribe|speech|moderation|dall-e|image|rerank|guard/i

export function buildModelsRequest(target: Pick<AiProviderConfig, 'format' | 'baseUrl' | 'apiKey'>): {
  url: string
  init: { method: 'GET'; headers: Record<string, string> }
} {
  const base = target.baseUrl.trim().replace(/\/+$/, '')
  if (target.format === 'anthropic') {
    const root = base.endsWith('/v1') ? base : `${base}/v1`
    const headers: Record<string, string> = { 'anthropic-version': AI_ANTHROPIC_VERSION }
    if (target.apiKey) headers['x-api-key'] = target.apiKey
    return { url: `${root}/models?limit=1000`, init: { method: 'GET', headers } }
  }
  const headers: Record<string, string> = {}
  if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`
  const root = target.format === 'ollama' || target.format === 'mistral-fim' ? withV1(base) : base
  return { url: `${root}/models`, init: { method: 'GET', headers } }
}

export function extractModelIds(json: unknown): string[] {
  const data = isRecord(json)
    ? Array.isArray(json.data)
      ? json.data
      : Array.isArray(json.models)
        ? json.models
        : null
    : null
  if (!Array.isArray(data)) return []
  const ids = data
    .map((entry) => {
      if (!isRecord(entry)) return null
      if (typeof entry.id === 'string') return entry.id
      if (typeof entry.name === 'string') return entry.name
      return null
    })
    .filter((id): id is string => typeof id === 'string' && id.length > 0 && !NOT_FOR_CODE_RE.test(id))
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}

export async function listModels(
  target: Pick<AiProviderConfig, 'format' | 'baseUrl' | 'apiKey'>,
  signal: AbortSignal,
  fetchImpl: FetchGetLike = fetch as unknown as FetchGetLike
): Promise<string[]> {
  const { url, init } = buildModelsRequest(target)
  const response = await fetchImpl(url, { ...init, redirect: 'error', signal })
  if (!response.ok) throw new ProviderHttpError(response.status)
  return extractModelIds(await readJsonBounded(response, AI_MAX_MODELS_BODY_BYTES))
}

export function filterModels(all: readonly string[], typed: string): string[] {
  const q = typed.trim().toLowerCase()
  const exact = all.some((id) => id.toLowerCase() === q)
  return !q || exact ? [...all] : all.filter((id) => id.toLowerCase().includes(q))
}

export interface AiSpeed {
  ok: boolean
  ms: number | null
  uses?: number
}

export type AiSpeeds = Readonly<Record<string, AiSpeed>>

export function isFast(speed: AiSpeed | undefined, limitMs: number): boolean {
  return Boolean(speed?.ok && speed.ms !== null && speed.ms < limitMs)
}

function speedTier(speed: AiSpeed | undefined, limitMs: number): number {
  if (isFast(speed, limitMs)) return 0
  if (speed?.ok) return 1
  return !speed ? 2 : 3
}

const LIKELY_FAST_RE = /haiku|mini|flash|lite|nano|small|instant|turbo|codestral|devstral|coder|\b([1-9]|1[0-4])b\b/i
const LIKELY_SLOW_RE = /opus|\bpro\b|thinking|reason|large|ultra|high|max|\b(70|120|405)b\b|\b(r1|o1|o3)\b/i

export function isLikelyFast(id: string): boolean {
  return LIKELY_FAST_RE.test(id) && !LIKELY_SLOW_RE.test(id)
}

export function rankModels(models: readonly string[], speeds: AiSpeeds, limitMs: number): string[] {
  const order = new Map(models.map((id, i) => [id, i]))
  return [...models].sort((a, b) => {
    const [sa, sb] = [speeds[a], speeds[b]]
    const byTier = speedTier(sa, limitMs) - speedTier(sb, limitMs)
    if (byTier !== 0) return byTier
    const byMs = (sa?.ms ?? 0) - (sb?.ms ?? 0)
    if (byMs !== 0) return byMs
    const byName = !sa && !sb ? Number(!isLikelyFast(a)) - Number(!isLikelyFast(b)) : 0
    return byName !== 0 ? byName : (order.get(a) ?? 0) - (order.get(b) ?? 0)
  })
}

export function recommendedModels(models: readonly string[], speeds: AiSpeeds, limitMs: number): string[] {
  return rankModels(models, speeds, limitMs)
    .filter((id) => isFast(speeds[id], limitMs))
    .slice(0, RECOMMENDED_COUNT)
}

export function pickCandidates(
  models: readonly string[],
  speeds: AiSpeeds,
  limit = AI_BENCH_MAX_MODELS,
  current = ''
): string[] {
  const score = (id: string): number => (id === current ? -1 : isLikelyFast(id) ? 0 : 1)
  return models
    .filter((id) => !speeds[id])
    .sort((a, b) => score(a) - score(b))
    .slice(0, limit)
}

export function isExpectedSqlBenchAnswer(suggestion: string): boolean {
  const trimmed = suggestion.trim()
  if (!trimmed || looksInjected(trimmed)) return false
  if (/^(?:sorry|i cannot|i can't|as an ai|here is|sure)/i.test(trimmed)) return false
  return /^[0-9:@$a-zA-Z_('"`]/.test(trimmed)
}

export function median(samples: readonly number[]): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((x, y) => x - y)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

const STRICT_IPV4_OCTET_RE = /^(?:0|[1-9]\d{0,2})$/
const IPV6_HEXTET_RE = /^[0-9a-f]{1,4}$/i
const LOCALHOST_NAME_RE =
  /^(?:localhost|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.localhost)$/i

function parseStrictIpv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const p of parts) {
    if (!STRICT_IPV4_OCTET_RE.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out.push(n)
  }
  return [out[0], out[1], out[2], out[3]]
}

function parseIpv6GroupSlice(groups: readonly string[]): number[] | null {
  const out: number[] = []
  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i]
    if (!g) return null
    if (g.includes('.')) {
      if (i !== groups.length - 1) return null
      const v4 = parseStrictIpv4Octets(g)
      if (!v4) return null
      out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3])
    } else {
      if (!IPV6_HEXTET_RE.test(g)) return null
      out.push(Number.parseInt(g, 16))
    }
  }
  return out
}

function parseIpv6Hextets(rawIpv6: string): number[] | null {
  if (!rawIpv6 || rawIpv6.includes('%')) return null
  const doubleColonParts = rawIpv6.split('::')
  if (doubleColonParts.length > 2) return null
  if (doubleColonParts.length === 1) {
    const groups = rawIpv6.split(':')
    const hextets = parseIpv6GroupSlice(groups)
    return hextets && hextets.length === 8 ? hextets : null
  }
  const [leftRaw, rightRaw] = doubleColonParts
  const leftGroups = leftRaw ? leftRaw.split(':') : []
  const rightGroups = rightRaw ? rightRaw.split(':') : []
  const left = parseIpv6GroupSlice(leftGroups)
  const right = parseIpv6GroupSlice(rightGroups)
  if (!left || !right) return null
  if (leftGroups.some((g) => g.includes('.'))) return null
  const zeros = 8 - (left.length + right.length)
  if (zeros < 1) return null
  return [...left, ...new Array<number>(zeros).fill(0), ...right]
}

function isIpv6Loopback(rawIpv6: string): boolean {
  const h = parseIpv6Hextets(rawIpv6)
  if (!h) return false
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0 && h[6] === 0 && h[7] === 1) {
    return true
  }
  if (
    h[0] === 0 &&
    h[1] === 0 &&
    h[2] === 0 &&
    h[3] === 0 &&
    h[4] === 0 &&
    h[5] === 0xffff &&
    ((h[6] >> 8) & 0xff) === 127
  ) {
    return true
  }
  return false
}

export function isLoopbackHost(host: string): boolean {
  const trimmed = typeof host === 'string' ? host.trim() : ''
  if (!trimmed || /[\s/?#@%]/.test(trimmed)) return false

  let bare = trimmed
  let expectIpv6 = false
  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']')
    if (closeIdx <= 1) return false
    const rest = trimmed.slice(closeIdx + 1)
    if (rest && !/^:\d+$/.test(rest)) return false
    bare = trimmed.slice(1, closeIdx)
    if (bare.includes('[') || bare.includes(']')) return false
    expectIpv6 = true
  } else {
    if (trimmed.includes('[') || trimmed.includes(']')) return false
    const firstColon = trimmed.indexOf(':')
    if (firstColon !== -1) {
      const lastColon = trimmed.lastIndexOf(':')
      if (firstColon === lastColon) {
        if (!/^\d+$/.test(trimmed.slice(firstColon + 1))) return false
        bare = trimmed.slice(0, firstColon)
      } else {
        expectIpv6 = true
      }
    }
  }

  if (expectIpv6 || bare.includes(':')) {
    return isIpv6Loopback(bare)
  }
  const normalizedName = bare.endsWith('.') ? bare.slice(0, -1) : bare
  if (LOCALHOST_NAME_RE.test(normalizedName)) return true
  const v4 = parseStrictIpv4Octets(normalizedName)
  return v4 !== null && v4[0] === 127
}

const BLOCKED_METADATA_HOSTS: ReadonlySet<string> = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
])

function isBlockedIpv4Address(v4: readonly [number, number, number, number]): boolean {
  // 0.0.0.0/8 (unspecified), 169.254.0.0/16 (link-local / cloud IMDS), 100.100.100.200 (Alibaba IMDS)
  if (v4[0] === 0) return true
  if (v4[0] === 169 && v4[1] === 254) return true
  if (v4[0] === 100 && v4[1] === 100 && v4[2] === 100 && v4[3] === 200) return true
  return false
}

function isBlockedMetadataOrUnspecifiedHost(rawHost: string): boolean {
  const trimmed = typeof rawHost === 'string' ? rawHost.trim() : ''
  if (!trimmed) return true
  let bare = trimmed
  if (bare.startsWith('[') && bare.endsWith(']')) {
    bare = bare.slice(1, -1)
  }
  const normalized = (bare.endsWith('.') ? bare.slice(0, -1) : bare).toLowerCase()
  if (BLOCKED_METADATA_HOSTS.has(normalized)) return true
  for (const h of BLOCKED_METADATA_HOSTS) {
    if (normalized.endsWith(`.${h}`)) return true
  }
  if (normalized.includes(':')) {
    const h = parseIpv6Hextets(normalized)
    if (!h) return false
    // Unspecified ::
    if (h.every((part) => part === 0)) return true
    // Link-local fe80::/10
    if ((h[0] & 0xffc0) === 0xfe80) return true
    // AWS IPv6 IMDS fd00:ec2::254
    if (
      h[0] === 0xfd00 &&
      h[1] === 0x0ec2 &&
      h[2] === 0 &&
      h[3] === 0 &&
      h[4] === 0 &&
      h[5] === 0 &&
      h[6] === 0 &&
      h[7] === 0x0254
    ) {
      return true
    }
    // IPv4-mapped IPv6 ::ffff:a.b.c.d
    if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
      const v4: [number, number, number, number] = [
        (h[6] >> 8) & 0xff,
        h[6] & 0xff,
        (h[7] >> 8) & 0xff,
        h[7] & 0xff,
      ]
      return isBlockedIpv4Address(v4)
    }
    return false
  }
  const v4 = parseStrictIpv4Octets(normalized)
  return v4 !== null && isBlockedIpv4Address(v4)
}

export function validateAiBaseUrl(
  rawUrl: string,
  _options?: { hasApiKey?: boolean }
): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (!trimmed) {
    return { ok: false, error: 'Set a valid http(s) Base URL.' }
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, error: 'Base URL contains invalid control characters.' }
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: 'Set a valid http(s) Base URL.' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Base URL must use http:// or https://.' }
  }
  if (!parsed.hostname) {
    return { ok: false, error: 'Set a valid http(s) Base URL.' }
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error:
        'Base URL must not embed credentials (username or password). Store API keys in the API Key field instead.',
    }
  }
  if (parsed.search || parsed.hash) {
    return {
      ok: false,
      error: 'Base URL must not include query parameters or fragments.',
    }
  }
  if (isBlockedMetadataOrUnspecifiedHost(parsed.hostname)) {
    return {
      ok: false,
      error:
        'Base URL targets a blocked link-local, unspecified, or cloud metadata address.',
    }
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    return {
      ok: false,
      error:
        'Unencrypted http:// is only allowed for local loopback hosts. Use https:// for remote endpoints.',
    }
  }
  const pathname = parsed.pathname.replace(/\/+$/, '')
  return { ok: true, url: `${parsed.origin}${pathname}` }
}

export function sanitizeAiBaseUrlForDisplay(rawUrl: string): string {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (!trimmed) return ''
  try {
    const parsed = new URL(trimmed)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    const pathname = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.origin}${pathname}`
  } catch {
    return scrubSensitiveText(trimmed, { stripAllFragments: true })
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRedirectFailureError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (/\bredirect/i.test(error.message)) return true
  const cause = (error as Error & { cause?: unknown }).cause
  if (cause instanceof Error && /\bredirect/i.test(cause.message)) return true
  return typeof cause === 'string' && /\bredirect/i.test(cause)
}

export function explainFailure(
  error: unknown,
  host: string,
  timeoutMs: number,
  format?: AiProviderFormat
): string {
  const seconds = (timeoutMs / 1000).toFixed(1).replace(/\.0$/, '')
  if (
    error instanceof SensitiveContentBlockedError ||
    error instanceof ReasoningExhaustedError ||
    error instanceof AiResponseTooLargeError
  ) {
    return error.message
  }
  if (error instanceof ProviderHttpError) {
    const { status } = error
    if (status === 401 || status === 403) return 'The provider rejected the API key.'
    if (status === 404) return 'Model or endpoint URL not found (HTTP 404).'
    if (status === 400 && format === 'ollama') {
      return 'Ollama refused fill-in-the-middle; pick a code model such as qwen2.5-coder or use Custom OpenAI-compatible.'
    }
    if (status === 429) return 'Rate limit reached (HTTP 429). Try again shortly.'
    if (status === 504) {
      return 'Provider gateway timed out (HTTP 504). Retry, lower EXPLAIN max tokens, or try a faster model in AI Settings.'
    }
    return status >= 500 ? `Provider server error (HTTP ${status}).` : `Provider returned HTTP ${status}.`
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `Timed out after ${seconds}s.`
  }
  if (isRedirectFailureError(error)) {
    return `Blocked HTTP redirect from ${host || 'provider'} to protect your API key. Use the final endpoint URL directly.`
  }
  if (error instanceof TypeError) {
    return isLoopbackHost(host)
      ? `Could not reach ${host || 'localhost'}. Is the local server running?`
      : `Could not reach ${host || 'provider'}. Check the base URL and network connection.`
  }
  return scrubSensitiveText(errorMessage(error), { stripAllFragments: true })
}

export type AiModelStats = {
  shown: number
  accepted: number
  partial: number
  kept: number
  undone: number
  stale: number
  latency: number[]
}

export type AiStatsStore = {
  since: number
  models: Record<string, AiModelStats>
}

export interface AiModelStatsSummary extends Omit<AiModelStats, 'latency'> {
  p50: number | null
  p95: number | null
  samples: number
}

const emptyModelStats = (): AiModelStats => ({
  shown: 0,
  accepted: 0,
  partial: 0,
  kept: 0,
  undone: 0,
  stale: 0,
  latency: [],
})

export function emptyStats(now: number): AiStatsStore {
  return { since: now, models: {} }
}

const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0

export function isStatsStore(value: unknown): value is AiStatsStore {
  if (!isRecord(value)) return false
  if (!isCount(value.since) || !isRecord(value.models)) return false
  return Object.values(value.models).every(
    (entry) =>
      isRecord(entry) &&
      AI_EVENT_KINDS.every((k) => isCount(entry[k])) &&
      Array.isArray(entry.latency) &&
      entry.latency.every(isCount)
  )
}

function updateStatsModel(
  store: AiStatsStore,
  key: string,
  change: (entry: AiModelStats) => AiModelStats
): AiStatsStore {
  const { [key]: prev = emptyModelStats(), ...rest } = store.models
  const next = { ...rest, [key]: change(prev) }
  const keys = Object.keys(next)
  for (const old of keys.slice(0, Math.max(0, keys.length - STATS_MODELS_KEPT))) {
    delete next[old]
  }
  return { ...store, models: next }
}

export function bumpMetric(store: AiStatsStore, key: string, kind: AiMetricKind): AiStatsStore {
  return updateStatsModel(store, key, (entry) => ({ ...entry, [kind]: entry[kind] + 1 }))
}

export function recordMetricLatency(store: AiStatsStore, key: string, ms: number): AiStatsStore {
  return updateStatsModel(store, key, (entry) => ({
    ...entry,
    latency: [...entry.latency, Math.round(ms)].slice(-LATENCY_SAMPLES),
  }))
}

export function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[Math.min(rank, sorted.length) - 1]
}

export function summarizeModelStats(store: AiStatsStore, key: string): AiModelStatsSummary {
  const { latency, ...counts } = store.models[key] ?? emptyModelStats()
  return {
    ...counts,
    p50: percentile(latency, 50),
    p95: percentile(latency, 95),
    samples: latency.length,
  }
}
