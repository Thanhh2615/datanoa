import type { OrcaWorkerApi } from 'orca/worker'
import type {
  AiExplainLanguage,
  AiProviderFormat,
  AiRole,
  AiRoleStatus,
  AiStatusSnapshot,
  AiStatusState,
} from '../protocol'
import {
  hostOf,
  isLoopbackHost,
  parseFormat,
  presetFor,
  sameAddress,
  sanitizeAiBaseUrlForDisplay,
  validateAiBaseUrl,
  type AiProviderConfig,
} from './ai-client'
import type { SessionManager } from './session-manager'
import { createHostError } from './worker-utils'

export const AI_SECRET_KEY = 'ai_api_key'
export const AI_KEY_ADDRESS_STORAGE = 'datanoa.ai.keyAddress'
export const AI_EXPLAIN_SECRET_KEY = 'ai_explain_api_key'
export const AI_EXPLAIN_KEY_ADDRESS_STORAGE = 'datanoa.ai.explainKeyAddress'
export const AI_DUAL_ROLE_MIGRATED_STORAGE = 'datanoa.ai.dualRoleMigrated'

export const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_AI_MODEL = 'gpt-4o-mini'
export const DEFAULT_INLINE_MAX_TOKENS = 96
export const MIN_INLINE_MAX_TOKENS = 16
export const MAX_INLINE_MAX_TOKENS = 1024
export const DEFAULT_EXPLAIN_MAX_TOKENS = 2048
export const MIN_EXPLAIN_MAX_TOKENS = 256
export const MAX_EXPLAIN_MAX_TOKENS = 8192

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

export function parseAiRole(value: unknown): AiRole {
  return value === 'explain' ? 'explain' : 'autocomplete'
}

export function parseExplainLanguage(val: unknown): AiExplainLanguage {
  return EXPLAIN_LANGUAGES.find((l) => l === val) ?? 'auto'
}

function clampTokenLimit(raw: unknown, fallback: number, min: number, max: number): number {
  const num = Number(raw)
  return Number.isFinite(num) && num > 0 ? Math.min(max, Math.max(min, Math.floor(num))) : fallback
}

export interface ResolvedAiRoleConfig {
  role: AiRole
  enabled: boolean
  provider: AiProviderConfig
  validProvider: boolean
  hasKey: boolean
  usingSharedKey: boolean
}

export interface ResolvedDualAiConfig {
  sync: boolean
  explainLanguage: AiExplainLanguage
  explainMaxTokens: number
  autocomplete: ResolvedAiRoleConfig
  explain: ResolvedAiRoleConfig
}

export interface AiRoleRuntimeHealth {
  lastMs: number | null
  lastError: string | null
  lastSlow: boolean
}

export interface AiRuntimeSnapshotInput {
  autocomplete: AiRoleRuntimeHealth
  explain: AiRoleRuntimeHealth
  suggested: number
  latestLastMs: number | null
}

export interface AiConfigStoreDeps {
  orca: OrcaWorkerApi
  sessionManager: SessionManager
}

export function isRoleKeyMissing(roleCfg: ResolvedAiRoleConfig): boolean {
  return (
    presetFor(roleCfg.provider.format, roleCfg.provider.baseUrl).keyKind === 'required' &&
    !roleCfg.provider.apiKey
  )
}

export function isRoleReady(roleCfg: ResolvedAiRoleConfig): boolean {
  return roleCfg.enabled && roleCfg.validProvider && !isRoleKeyMissing(roleCfg)
}

export function roleStateOf(
  roleCfg: ResolvedAiRoleConfig,
  runtime: AiRoleRuntimeHealth
): AiStatusState {
  if (!roleCfg.enabled) return 'off'
  if (!roleCfg.validProvider || isRoleKeyMissing(roleCfg)) return 'setup'
  if (runtime.lastSlow) return 'slow'
  return runtime.lastError ? 'error' : 'on'
}

export function roleDestinationOf(roleCfg: ResolvedAiRoleConfig): 'none' | 'local' | 'remote' {
  if (!roleCfg.enabled || !roleCfg.validProvider || isRoleKeyMissing(roleCfg)) return 'none'
  return isLoopbackHost(hostOf(roleCfg.provider.baseUrl)) ? 'local' : 'remote'
}

export function combineRoleStates(
  autoState: AiStatusState,
  explainState: AiStatusState
): AiStatusState {
  if (autoState === 'off' && explainState === 'off') return 'off'
  if (autoState === 'error' || explainState === 'error') return 'error'
  if (autoState === 'slow' || explainState === 'slow') return 'slow'
  if (autoState === 'on' || explainState === 'on') return 'on'
  return 'setup'
}

export function buildRoleStatus(
  roleCfg: ResolvedAiRoleConfig,
  runtime: AiRoleRuntimeHealth
): AiRoleStatus {
  const displayBaseUrl = sanitizeAiBaseUrlForDisplay(roleCfg.provider.baseUrl)
  return {
    enabled: roleCfg.enabled,
    state: roleStateOf(roleCfg, runtime),
    reason: runtime.lastError,
    format: roleCfg.provider.format,
    baseUrl: displayBaseUrl,
    host: hostOf(displayBaseUrl),
    model: roleCfg.provider.model,
    hasKey: roleCfg.hasKey,
    ...(roleCfg.role === 'explain' ? { usingSharedKey: roleCfg.usingSharedKey } : {}),
    destination: roleDestinationOf(roleCfg),
  }
}

export function buildDualStatusSnapshot(
  cfg: ResolvedDualAiConfig,
  runtime: AiRuntimeSnapshotInput
): AiStatusSnapshot {
  const autoStatus = buildRoleStatus(cfg.autocomplete, runtime.autocomplete)
  const explainStatus = buildRoleStatus(cfg.explain, runtime.explain)
  return {
    enabled: autoStatus.enabled || explainStatus.enabled,
    state: combineRoleStates(autoStatus.state, explainStatus.state),
    lastMs: runtime.latestLastMs,
    suggested: runtime.suggested,
    reason: autoStatus.reason ?? explainStatus.reason,
    format: autoStatus.format,
    baseUrl: autoStatus.baseUrl,
    host: autoStatus.host,
    model: autoStatus.model,
    maxTokens: cfg.autocomplete.provider.maxTokens,
    explainMaxTokens: cfg.explainMaxTokens,
    explainLanguage: cfg.explainLanguage,
    hasKey: autoStatus.hasKey,
    destination: autoStatus.destination,
    sync: cfg.sync,
    roles: {
      autocomplete: autoStatus,
      explain: explainStatus,
    },
  }
}

function keySlotFor(role: AiRole): { secretKey: string; addressKey: string; urlSettingKey: string } {
  if (role === 'explain') {
    return {
      secretKey: AI_EXPLAIN_SECRET_KEY,
      addressKey: AI_EXPLAIN_KEY_ADDRESS_STORAGE,
      urlSettingKey: 'aiExplainBaseUrl',
    }
  }
  return {
    secretKey: AI_SECRET_KEY,
    addressKey: AI_KEY_ADDRESS_STORAGE,
    urlSettingKey: 'aiBaseUrl',
  }
}

export class AiConfigStore {
  private readonly orca: OrcaWorkerApi
  private readonly sessionManager: SessionManager
  private readonly pinReady: Promise<void>
  private pendingMigrationWrite: Promise<void> = Promise.resolve()

  constructor({ orca, sessionManager }: AiConfigStoreDeps) {
    this.orca = orca
    this.sessionManager = sessionManager
    this.pinReady = this.pinExistingKeys()
  }

  markDualRoleMigrated(): Promise<void> {
    const write = this.pendingMigrationWrite
      .then(async () => {
        await this.orca.storage.set(AI_DUAL_ROLE_MIGRATED_STORAGE, true)
      })
      .catch(() => undefined)
    this.pendingMigrationWrite = write
    return write
  }

  private migrateExplainEnabledFromManifestDefault(): Promise<void> {
    const write = this.pendingMigrationWrite
      .then(async () => {
        const settingsApi = this.orca.settings
        if (typeof settingsApi.set !== 'function') return
        const alreadyMigrated = await this.orca.storage
          .get(AI_DUAL_ROLE_MIGRATED_STORAGE)
          .catch(() => null)
        if (alreadyMigrated === true) return
        await settingsApi.set('aiExplainEnabled', true)
        await this.orca.storage.set(AI_DUAL_ROLE_MIGRATED_STORAGE, true)
      })
      .catch(() => undefined)
    this.pendingMigrationWrite = write
    return write
  }

  private async pinExistingKeyForRole(role: AiRole): Promise<void> {
    const { secretKey, addressKey, urlSettingKey } = keySlotFor(role)
    const pinned = await this.orca.storage.get(addressKey)
    if ((await this.orca.secrets.get(secretKey)) && (typeof pinned !== 'string' || !pinned.trim())) {
      const url = String((await this.orca.settings.get(urlSettingKey)) ?? DEFAULT_AI_BASE_URL).trim()
      const checked = validateAiBaseUrl(url, { hasApiKey: true })
      if (checked.ok) {
        await this.orca.storage.set(addressKey, checked.url)
      }
    }
  }

  private async pinExistingKeys(): Promise<void> {
    try {
      await Promise.all([
        this.pinExistingKeyForRole('autocomplete'),
        this.pinExistingKeyForRole('explain'),
      ])
    } catch {
      // Ignore startup pinning failure in minimal mocks
    }
  }

  async savedKeyFor(role: AiRole, baseUrl: string): Promise<string> {
    await this.pinReady
    const { secretKey, addressKey } = keySlotFor(role)
    const [key, pinned] = await Promise.all([
      this.orca.secrets.get(secretKey).then((v) => v ?? ''),
      this.orca.storage.get(addressKey),
    ])
    if (!key || typeof pinned !== 'string' || !pinned.trim() || !sameAddress(pinned, baseUrl)) {
      return ''
    }
    return key
  }

  async readConfig(): Promise<ResolvedDualAiConfig> {
    await this.pendingMigrationWrite
    const [settings, migratedRaw] = await Promise.all([
      this.orca.settings.get(),
      this.orca.storage.get(AI_DUAL_ROLE_MIGRATED_STORAGE).catch(() => null),
    ])
    const isMigrated = migratedRaw === true
    const autoEnabled = settings.aiEnabled === true
    const sync = settings.aiSync === undefined ? true : settings.aiSync === true

    const explainAtManifestDefaults =
      (settings.aiExplainFormat === undefined || settings.aiExplainFormat === 'openai') &&
      (settings.aiExplainBaseUrl === undefined ||
        String(settings.aiExplainBaseUrl).trim() === '' ||
        String(settings.aiExplainBaseUrl).trim() === DEFAULT_AI_BASE_URL) &&
      (settings.aiExplainModel === undefined ||
        String(settings.aiExplainModel).trim() === '' ||
        String(settings.aiExplainModel).trim() === DEFAULT_AI_MODEL)

    const shouldMigrateFromManifestDefault =
      !isMigrated &&
      settings.aiExplainEnabled === false &&
      autoEnabled &&
      sync &&
      explainAtManifestDefaults

    const explainEnabled =
      settings.aiExplainEnabled === undefined
        ? autoEnabled
        : settings.aiExplainEnabled === true || shouldMigrateFromManifestDefault

    if (shouldMigrateFromManifestDefault) {
      await this.migrateExplainEnabledFromManifestDefault()
    } else if (!isMigrated && settings.aiExplainEnabled === true) {
      void this.markDualRoleMigrated()
    }

    const maxTokens = clampTokenLimit(
      settings.aiMaxTokens,
      DEFAULT_INLINE_MAX_TOKENS,
      MIN_INLINE_MAX_TOKENS,
      MAX_INLINE_MAX_TOKENS
    )
    const explainMaxTokens = clampTokenLimit(
      settings.aiExplainMaxTokens,
      DEFAULT_EXPLAIN_MAX_TOKENS,
      MIN_EXPLAIN_MAX_TOKENS,
      MAX_EXPLAIN_MAX_TOKENS
    )
    const explainLanguage = parseExplainLanguage(settings.aiExplainLanguage)

    const autoFormat = parseFormat(settings.aiFormat)
    const autoBaseUrl = (
      settings.aiBaseUrl !== undefined ? String(settings.aiBaseUrl) : DEFAULT_AI_BASE_URL
    ).trim()
    const autoModel = (
      settings.aiModel !== undefined ? String(settings.aiModel) : DEFAULT_AI_MODEL
    ).trim()
    const autoUrlCheck = validateAiBaseUrl(autoBaseUrl)
    const autoCanonicalUrl = autoUrlCheck.ok ? autoUrlCheck.url : autoBaseUrl
    let autoValid = autoUrlCheck.ok && autoModel.length > 0
    let autoKey = autoUrlCheck.ok ? await this.savedKeyFor('autocomplete', autoCanonicalUrl) : ''
    let autoUsingExplainKey = false
    if (sync && !autoKey && autoUrlCheck.ok) {
      const explainFallbackKey = await this.savedKeyFor('explain', autoCanonicalUrl)
      if (explainFallbackKey) {
        autoKey = explainFallbackKey
        autoUsingExplainKey = true
      }
    }
    let autoHasKey = Boolean(autoKey)
    if (autoKey && !validateAiBaseUrl(autoCanonicalUrl, { hasApiKey: true }).ok) {
      autoKey = ''
      autoHasKey = false
      autoUsingExplainKey = false
      autoValid = false
    }

    const autocomplete: ResolvedAiRoleConfig = {
      role: 'autocomplete',
      enabled: autoEnabled,
      validProvider: autoValid,
      hasKey: autoHasKey,
      usingSharedKey: autoUsingExplainKey,
      provider: {
        format: autoFormat,
        baseUrl: autoCanonicalUrl,
        model: autoModel,
        apiKey: autoKey,
        maxTokens,
      },
    }

    if (sync) {
      const explain: ResolvedAiRoleConfig = {
        role: 'explain',
        enabled: explainEnabled,
        validProvider: autoValid,
        hasKey: autoHasKey,
        usingSharedKey: autoHasKey && !autoUsingExplainKey,
        provider: {
          format: autoFormat,
          baseUrl: autoCanonicalUrl,
          model: autoModel,
          apiKey: autoKey,
          maxTokens: explainMaxTokens,
        },
      }
      return { sync, explainLanguage, explainMaxTokens, autocomplete, explain }
    }

    const expFormat = parseFormat(settings.aiExplainFormat)
    const expBaseUrl = (
      settings.aiExplainBaseUrl !== undefined
        ? String(settings.aiExplainBaseUrl)
        : DEFAULT_AI_BASE_URL
    ).trim()
    const expModel = (
      settings.aiExplainModel !== undefined ? String(settings.aiExplainModel) : DEFAULT_AI_MODEL
    ).trim()
    const expUrlCheck = validateAiBaseUrl(expBaseUrl)
    const expCanonicalUrl = expUrlCheck.ok ? expUrlCheck.url : expBaseUrl
    let expValid = expUrlCheck.ok && expModel.length > 0
    let expKey = ''
    let expUsingShared = false
    if (expUrlCheck.ok) {
      const ownKey = await this.savedKeyFor('explain', expCanonicalUrl)
      if (ownKey) {
        expKey = ownKey
      } else if (sameAddress(expCanonicalUrl, autoCanonicalUrl)) {
        const sharedKey = await this.savedKeyFor('autocomplete', expCanonicalUrl)
        if (sharedKey) {
          expKey = sharedKey
          expUsingShared = true
        }
      }
    }
    let expHasKey = Boolean(expKey)
    if (expKey && !validateAiBaseUrl(expCanonicalUrl, { hasApiKey: true }).ok) {
      expKey = ''
      expHasKey = false
      expUsingShared = false
      expValid = false
    }

    const explain: ResolvedAiRoleConfig = {
      role: 'explain',
      enabled: explainEnabled,
      validProvider: expValid,
      hasKey: expHasKey,
      usingSharedKey: expUsingShared,
      provider: {
        format: expFormat,
        baseUrl: expCanonicalUrl,
        model: expModel,
        apiKey: expKey,
        maxTokens: explainMaxTokens,
      },
    }

    return { sync, explainLanguage, explainMaxTokens, autocomplete, explain }
  }

  async setKey(input: {
    key?: unknown
    baseUrl?: unknown
    role?: unknown
  } | undefined): Promise<{ hasKey: boolean; role: AiRole }> {
    const role = parseAiRole(input?.role)
    const { secretKey, addressKey, urlSettingKey } = keySlotFor(role)
    const trimmed = typeof input?.key === 'string' ? input.key.trim() : ''
    if (trimmed) {
      await this.sessionManager.assertSecureSecretStorage()
      const baseUrl =
        input?.baseUrl !== undefined
          ? String(input.baseUrl).trim()
          : String((await this.orca.settings.get(urlSettingKey)) ?? '').trim()
      const checked = validateAiBaseUrl(baseUrl, { hasApiKey: true })
      if (!checked.ok) {
        throw createHostError('invalid_params', checked.error)
      }
      await this.orca.secrets.set(secretKey, trimmed)
      await this.orca.storage.set(addressKey, checked.url)
    } else {
      await this.orca.secrets.delete(secretKey)
      await this.orca.storage.delete(addressKey)
      if (role === 'autocomplete') {
        const settings = await this.orca.settings.get()
        const sync = settings.aiSync === undefined ? true : settings.aiSync === true
        if (sync) {
          await this.pinReady
          const savedAutoUrl = String(settings.aiBaseUrl ?? DEFAULT_AI_BASE_URL).trim()
          const inputUrl = typeof input?.baseUrl === 'string' ? input.baseUrl.trim() : ''
          const explainPinned = await this.orca.storage.get(AI_EXPLAIN_KEY_ADDRESS_STORAGE)
          if (
            typeof explainPinned === 'string' &&
            explainPinned.trim() &&
            ((inputUrl && sameAddress(explainPinned, inputUrl)) ||
              (savedAutoUrl && sameAddress(explainPinned, savedAutoUrl)))
          ) {
            await this.orca.secrets.delete(AI_EXPLAIN_SECRET_KEY)
            await this.orca.storage.delete(AI_EXPLAIN_KEY_ADDRESS_STORAGE)
          }
        }
      }
    }
    await this.markDualRoleMigrated()
    return { hasKey: Boolean(trimmed), role }
  }

  async keyForListing(
    format: AiProviderFormat,
    url: string,
    typed: string,
    roleInput?: unknown
  ): Promise<string> {
    if (presetFor(format, url).keyKind === 'none') return ''
    if (typed) return typed
    const role = parseAiRole(roleInput)
    const settings = await this.orca.settings.get()
    const sync = settings.aiSync === undefined ? true : settings.aiSync === true
    const autoFormat = parseFormat(settings.aiFormat)
    const autoUrl = String(settings.aiBaseUrl ?? DEFAULT_AI_BASE_URL).trim()
    if (role === 'explain') {
      const expFormat = parseFormat(settings.aiExplainFormat)
      const expUrl = String(settings.aiExplainBaseUrl ?? DEFAULT_AI_BASE_URL).trim()
      if (expFormat === format && sameAddress(expUrl, url)) {
        const ownKey = await this.savedKeyFor('explain', url)
        if (ownKey) return ownKey
      }
      if (autoFormat === format && sameAddress(autoUrl, url)) {
        return await this.savedKeyFor('autocomplete', url)
      }
      return ''
    }
    if (autoFormat === format && sameAddress(autoUrl, url)) {
      const autoKey = await this.savedKeyFor('autocomplete', url)
      if (autoKey) return autoKey
      if (sync) {
        return await this.savedKeyFor('explain', url)
      }
    }
    return ''
  }
}
