import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import {
  ACTIVE_CONNECTION_STORAGE_KEY,
  sanitizeJsonPayload,
  type ConnectionColorTag,
  type ConnectionProfile,
  type DatabaseDriverType,
  type PersistedLocalDriverConfig,
  type QueryResult,
  type SavedQueryEntry,
} from '../protocol'
import type { IDatabaseSession } from '../drivers'
import { getCanonicalByodStarterCode } from '../drivers/common/byod-templates'
import { scrubUrlCredentials, SUPPORTED_DRIVERS } from '../drivers/common/connection-uri'
import { detectRecognizableSqlCredential } from '../drivers/common/sql-credentials'
import { quoteIdentForDialect } from '../drivers/common/sql-tools'
import {
  isLocalWorkspaceHost,
  normalizePathForCompare,
  resolveSqliteFilePath,
} from './discovery'
import type { SessionManager } from './session-manager'

export type WorkerRegisterHandler = OrcaWorkerApi['panels']['handle']

export const READ_ONLY_MUTATION_ERROR =
  'Connection is Read-Only. Uncheck Read-Only in connection settings to modify data.'
export const QUERY_HISTORY_STORAGE_KEY = 'datanoa.queryHistory'
export const MAX_QUERY_HISTORY = 50
export const MAX_SAVED_QUERIES = 200
const SAVED_QUERY_NAME_MAX = 120
const SAVED_QUERY_SQL_MAX = 100_000
const SAVED_QUERY_DESC_MAX = 300
const SAVED_QUERY_TAG_MAX = 32
const SAVED_QUERY_TAGS_MAX = 10
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g
const SQL_DISALLOWED_CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const PRE_CANCELLED_QUERY_TTL_MS = 60_000

export function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS_RE, '')
}

export function stripDisallowedSqlControlChars(value: string): string {
  return value.replace(SQL_DISALLOWED_CONTROL_CHARS_RE, '')
}

export interface SanitizedSavedQueryInput {
  name: string
  sql: string
  description?: string
  dialect?: DatabaseDriverType
  tags?: string[]
}

export function createHostError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  return err
}

export function sanitizeSavedQueryInput(input: {
  name?: unknown
  sql?: unknown
  description?: unknown
  dialect?: unknown
  tags?: unknown
}): SanitizedSavedQueryInput {
  if (typeof input.name !== 'string') {
    throw createHostError('invalid_params', 'Saved query name is required')
  }
  const name = stripControlChars(input.name).trim().slice(0, SAVED_QUERY_NAME_MAX)
  if (!name) {
    throw createHostError('invalid_params', 'Saved query name cannot be empty')
  }

  if (typeof input.sql !== 'string') {
    throw createHostError('invalid_params', 'Saved query SQL is required')
  }
  const sql = stripDisallowedSqlControlChars(input.sql).trim()
  if (!sql) {
    throw createHostError('invalid_params', 'Saved query SQL cannot be empty')
  }
  if (sql.length > SAVED_QUERY_SQL_MAX) {
    throw createHostError(
      'invalid_params',
      `Saved query SQL exceeds ${SAVED_QUERY_SQL_MAX} characters`
    )
  }

  let description: string | undefined
  if (typeof input.description === 'string') {
    const cleaned = stripControlChars(input.description).trim().slice(0, SAVED_QUERY_DESC_MAX)
    description = cleaned.length > 0 ? cleaned : undefined
  }

  let dialect: DatabaseDriverType | undefined
  if (input.dialect !== undefined) {
    if (
      typeof input.dialect !== 'string' ||
      !SUPPORTED_DRIVERS.includes(input.dialect as DatabaseDriverType)
    ) {
      throw createHostError('invalid_params', `Unsupported query dialect: ${String(input.dialect)}`)
    }
    dialect = input.dialect as DatabaseDriverType
  }

  let tags: string[] | undefined
  if (Array.isArray(input.tags)) {
    const seen = new Set<string>()
    const cleanedTags: string[] = []
    for (const rawTag of input.tags) {
      if (typeof rawTag !== 'string') continue
      const tag = stripControlChars(rawTag).trim().slice(0, SAVED_QUERY_TAG_MAX)
      if (!tag) continue
      const key = tag.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      cleanedTags.push(tag)
      if (cleanedTags.length >= SAVED_QUERY_TAGS_MAX) break
    }
    tags = cleanedTags.length > 0 ? cleanedTags : undefined
  }

  if (detectRecognizableSqlCredential(sql, dialect) !== null) {
    throw createHostError(
      'invalid_params',
      'Saved queries cannot contain inline database passwords or credential URIs. Use bind parameters or saved connection profiles instead.'
    )
  }

  return { name, sql, description, dialect, tags }
}

export function readSavedQueries(raw: unknown): SavedQueryEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (entry): entry is SavedQueryEntry =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      typeof (entry as SavedQueryEntry).id === 'string' &&
      typeof (entry as SavedQueryEntry).name === 'string' &&
      typeof (entry as SavedQueryEntry).sql === 'string'
  )
}

export async function assertMutableConnection(
  sessionManager: SessionManager,
  connectionId: string
): Promise<ConnectionProfile> {
  const profile = await sessionManager.findProfile(connectionId)
  if (!profile) {
    throw createHostError('invalid_params', `Connection '${connectionId}' not found in storage`)
  }
  if (profile.readOnly) {
    throw createHostError('not_permitted', READ_ONLY_MUTATION_ERROR)
  }
  return profile
}

export function normalizeColorTag(tag: unknown): ConnectionColorTag | undefined {
  if (tag === 'none' || tag === 'dev' || tag === 'staging' || tag === 'prod') {
    return tag
  }
  return undefined
}

export function sanitizeConnectionProfile(conn: ConnectionProfile): ConnectionProfile {
  const redisDb =
    typeof conn.redisDb === 'number' &&
    Number.isInteger(conn.redisDb) &&
    conn.redisDb >= 0 &&
    conn.redisDb <= 15
      ? conn.redisDb
      : undefined
  const rawUrl =
    typeof conn.url === 'string' && conn.url.trim().length > 0 ? conn.url.trim() : undefined
  const url = rawUrl ? scrubSensitiveUrlDraft(rawUrl) : undefined
  const options =
    typeof conn.options === 'string' && conn.options.trim().length > 0
      ? conn.options.trim()
      : undefined

  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
  const scopedText = (value: unknown, max: number): string | undefined => {
    if (typeof value !== 'string') return undefined
    const cleaned = value.replace(CONTROL_CHARS_RE, '').trim()
    return cleaned.length > 0 ? cleaned.slice(0, max) : undefined
  }
  const folder = scopedText(conn.folder, 64)
  const workspaceScope = scopedText(conn.workspaceScope, 260)
  const sslMode =
    conn.sslMode === 'auto' ||
    conn.sslMode === 'disable' ||
    conn.sslMode === 'require' ||
    conn.sslMode === 'verify-ca' ||
    conn.sslMode === 'verify-full'
      ? conn.sslMode
      : undefined
  const sshAuthMethod =
    conn.sshAuthMethod === 'agent' ||
    conn.sshAuthMethod === 'key' ||
    conn.sshAuthMethod === 'password'
      ? conn.sshAuthMethod
      : undefined
  const sshPort =
    typeof conn.sshPort === 'number' &&
    Number.isInteger(conn.sshPort) &&
    conn.sshPort >= 1 &&
    conn.sshPort <= 65535
      ? conn.sshPort
      : undefined

  return sanitizeJsonPayload({
    id: conn.id,
    name: conn.name,
    driver: conn.driver,
    database: conn.database,
    filePath: conn.filePath,
    host: conn.host,
    port: conn.port,
    user: conn.user,
    hasPassword: Boolean(conn.hasPassword),
    hasAuthToken: conn.hasAuthToken !== undefined ? Boolean(conn.hasAuthToken) : undefined,
    d1AccountId: scopedText(conn.d1AccountId, 128),
    d1DatabaseId: scopedText(conn.d1DatabaseId, 128),
    ssl: conn.ssl,
    readOnly: conn.readOnly,
    url,
    redisDb,
    colorTag: normalizeColorTag(conn.colorTag),
    options,
    folder,
    workspaceScope,
    sslMode,
    sslCaPath: text(conn.sslCaPath),
    sslCertPath: text(conn.sslCertPath),
    sslKeyPath: text(conn.sslKeyPath),
    hasSslKeyPassphrase: conn.hasSslKeyPassphrase ? true : undefined,
    sslRejectUnauthorized:
      conn.sslRejectUnauthorized !== undefined
        ? Boolean(conn.sslRejectUnauthorized)
        : undefined,
    sshEnabled: conn.sshEnabled ? true : undefined,
    sshHost: text(conn.sshHost),
    sshPort,
    sshUser: text(conn.sshUser),
    sshAuthMethod,
    sshPrivateKeyPath: text(conn.sshPrivateKeyPath),
    hasSshPassphrase: conn.hasSshPassphrase ? true : undefined,
    hasSshPassword: conn.hasSshPassword ? true : undefined,
  })
}

export async function normalizeSqliteProfile(
  profile: ConnectionProfile
): Promise<ConnectionProfile> {
  if (profile.driver !== 'sqlite') {
    return sanitizeJsonPayload(profile)
  }
  const rawTarget = profile.filePath || profile.database || ''
  const resolvedPath = await resolveSqliteFilePath(rawTarget)
  const dbName =
    resolvedPath && resolvedPath !== ':memory:'
      ? path.basename(resolvedPath)
      : profile.database || ':memory:'
  return sanitizeJsonPayload({
    ...profile,
    database: dbName,
    filePath: resolvedPath || profile.filePath,
  })
}

export interface SerializedQueue {
  run<T>(fn: () => Promise<T>): Promise<T>
  waitIdle(): Promise<void>
}

export function createSerializedQueue(): SerializedQueue {
  let chain: Promise<void> = Promise.resolve()
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const task = chain.then(fn)
      chain = task.then(
        () => undefined,
        () => undefined
      )
      return task
    },
    waitIdle(): Promise<void> {
      return chain
    },
  }
}

export async function openStudioDocumentInOrca(
  orca: OrcaWorkerApi,
  options?: { connectionId?: string; table?: string; schema?: string; sql?: string },
  sessionManager?: SessionManager
): Promise<{ ok: boolean; path?: string; message?: string }> {
  try {
    if (!orca.host || typeof orca.host.call !== 'function') {
      return {
        ok: false,
        message: 'Open a local workspace folder in Orca to launch Full Studio.',
      }
    }

    const listResult = (await orca.host.call('workspace.list')) as {
      workspaces?: Array<{
        id: string
        path: string
        name?: string
        branch?: string | null
        hostId?: string | null
      }>
    } | null
    const localWorkspaces = (listResult?.workspaces || []).filter(
      (w) =>
        Boolean(w) &&
        typeof w.path === 'string' &&
        w.path.trim().length > 0 &&
        isLocalWorkspaceHost(w.hostId)
    )
    if (localWorkspaces.length === 0) {
      return {
        ok: false,
        message: 'Open a local workspace folder in Orca to launch Full Studio.',
      }
    }

    let matched: (typeof localWorkspaces)[number] | undefined
    try {
      const ctx = await orca.host.call('workspace.readContext')
      if (ctx?.workspaceId) {
        matched = localWorkspaces.find((w) => w.id === ctx.workspaceId)
      }
      if (!matched && ctx?.displayName) {
        matched = localWorkspaces.find(
          (w) =>
            w.name === ctx.displayName &&
            (ctx.branch ? w.branch === ctx.branch : true)
        )
      }
    } catch {
      // Fall back to local workspace selection
    }

    const homeNorm = normalizePathForCompare(os.homedir())
    const target =
      matched ??
      localWorkspaces.find((w) => normalizePathForCompare(w.path) !== homeNorm) ??
      localWorkspaces[0]

    const studioDir = path.join(target.path, '.datanoa')
    await fs.promises.mkdir(studioDir, { recursive: true })
    const gitignorePath = path.join(studioDir, '.gitignore')
    if (!fs.existsSync(gitignorePath)) {
      await fs.promises.writeFile(gitignorePath, '*\n', 'utf8')
    }

    const fileName = 'studio.datanoa'
    const fullFilePath = path.join(studioDir, fileName)
    try {
      const existingFiles = await fs.promises.readdir(studioDir)
      for (const entry of existingFiles) {
        if (entry.endsWith('.datanoa') && entry !== fileName) {
          await fs.promises.unlink(path.join(studioDir, entry)).catch(() => {})
        }
      }
    } catch {
      // Ignore cleanup errors
    }

    let resolvedConnectionId =
      typeof options?.connectionId === 'string' && options.connectionId.trim().length > 0
        ? options.connectionId.trim()
        : ''

    if (!resolvedConnectionId && sessionManager) {
      const savedList = (await sessionManager.getStoredConnections()).filter(
        (c) => c && typeof c.id === 'string' && c.id.length > 0 && !c.id.startsWith('ws_')
      )
      const storedActiveId = await orca.storage.get(ACTIVE_CONNECTION_STORAGE_KEY)
      if (
        typeof storedActiveId === 'string' &&
        storedActiveId.trim().length > 0 &&
        savedList.some((c) => c.id === storedActiveId)
      ) {
        resolvedConnectionId = storedActiveId
      } else if (savedList[0]?.id) {
        resolvedConnectionId = savedList[0].id
      }
    }

    const headerLines = [
      `-- datanoa: connectionId=${resolvedConnectionId}`,
      options?.table ? `-- datanoa: table=${options.table}` : '',
      options?.schema ? `-- datanoa: schema=${options.schema}` : '',
    ].filter(Boolean)

    const profile =
      resolvedConnectionId && sessionManager
        ? await sessionManager.findProfile(resolvedConnectionId)
        : null
    const dialect = profile?.driver ?? 'postgres'
    const quotedTable = options?.table ? quoteIdentForDialect(options.table, dialect) : ''
    const qualifiedTable =
      quotedTable &&
      options?.schema &&
      !((dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1') && options.schema === 'main') &&
      options.schema !== 'public'
        ? `${quoteIdentForDialect(options.schema, dialect)}.${quotedTable}`
        : quotedTable

    const defaultSql =
      options?.sql ||
      (dialect === 'redis'
        ? 'SCAN 0 MATCH * COUNT 50'
        : qualifiedTable
          ? `SELECT * FROM ${qualifiedTable} LIMIT 100;`
          : '-- Datanoa SQL Studio\nSELECT 1;\n')

    const content = `${headerLines.join('\n')}\n${defaultSql}\n`
    await fs.promises.writeFile(fullFilePath, content, 'utf8')

    const relPath = `.datanoa/${fileName}`
    try {
      await orca.host.call('workspace.open', { workspaceId: target.id })
    } catch {
      // Ignore if workspace is already open/focused
    }
    await orca.host.call('editor.open', {
      workspaceId: target.id,
      path: relPath,
    })
    try {
      orca.panels?.post?.('studio.opened', {
        connectionId: resolvedConnectionId || null,
        table: options?.table || null,
        schema: options?.schema || null,
      })
    } catch {
      // Optional event broadcast in minimal/test hosts
    }
    return { ok: true, path: relPath }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    orca.log(`[Worker] studio.open failed: ${msg}`)
    return { ok: false, message: msg }
  }
}

export interface QueryRuntimeTracker {
  readonly activeQuerySessions: Map<string, IDatabaseSession>
  markQueryPreCancelled(queryId: string): void
  consumePreCancelledQuery(queryId: string): boolean
  clear(): void
}

export function createQueryRuntimeTracker(): QueryRuntimeTracker {
  const activeQuerySessions = new Map<string, IDatabaseSession>()
  const preCancelledQueryIds = new Map<string, number>()

  const prunePreCancelledQueries = (now: number): void => {
    for (const [id, expiresAt] of preCancelledQueryIds.entries()) {
      if (expiresAt <= now) {
        preCancelledQueryIds.delete(id)
      }
    }
  }

  return {
    activeQuerySessions,
    markQueryPreCancelled(queryId: string): void {
      const now = Date.now()
      prunePreCancelledQueries(now)
      preCancelledQueryIds.set(queryId, now + PRE_CANCELLED_QUERY_TTL_MS)
    },
    consumePreCancelledQuery(queryId: string): boolean {
      const now = Date.now()
      const expiresAt = preCancelledQueryIds.get(queryId)
      if (expiresAt === undefined) {
        return false
      }
      preCancelledQueryIds.delete(queryId)
      return expiresAt > now
    },
    clear(): void {
      activeQuerySessions.clear()
      preCancelledQueryIds.clear()
    },
  }
}

export async function readClampedTimeoutSeconds(orca: OrcaWorkerApi): Promise<number> {
  const settingTimeout = Number(await orca.settings.get('queryTimeoutSeconds'))
  return Number.isFinite(settingTimeout) && settingTimeout > 0
    ? Math.max(1, Math.min(110, Math.floor(settingTimeout)))
    : 30
}

export async function executeSessionQuery(
  tracker: QueryRuntimeTracker,
  session: IDatabaseSession,
  queryId: string,
  sql: string,
  maxRows: number,
  timeoutSeconds: number,
  signal: AbortSignal
): Promise<QueryResult> {
  tracker.activeQuerySessions.set(queryId, session)

  let abortCleanup: (() => void) | undefined
  const abortPromise = new Promise<QueryResult>((_, reject) => {
    const onAbort = () => {
      void session.cancelQuery(queryId).catch(() => {})
      reject(createHostError('cancelled', 'Query execution was cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    abortCleanup = () => signal.removeEventListener('abort', onAbort)
  })
  abortPromise.catch(() => {})

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<QueryResult>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      void session.cancelQuery(queryId).catch(() => {})
      reject(createHostError('timeout', `Query timed out after ${timeoutSeconds}s`))
    }, timeoutSeconds * 1000)
  })
  timeoutPromise.catch(() => {})

  try {
    const queryPromise = session.runQuery(queryId, sql, maxRows)
    queryPromise.catch(() => {})
    return await Promise.race([queryPromise, abortPromise, timeoutPromise])
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle)
    }
    if (typeof abortCleanup === 'function') {
      abortCleanup()
    }
    tracker.activeQuerySessions.delete(queryId)
  }
}

export interface HostConfigBackupPayload {
  updatedAt?: number
  connections?: ConnectionProfile[]
  byodConfigs?: PersistedLocalDriverConfig[]
  savedQueries?: SavedQueryEntry[]
  panelViewState?: Record<string, unknown>
  studioViewState?: Record<string, unknown>
}

const inMemoryUiSessionSnapshots = new Map<
  'panel' | 'studio',
  {
    viewState: Record<string, unknown> | null
    dataCache: Record<string, unknown> | null
    updatedAt: number
  }
>()

export function clearInMemoryUiSessionSnapshots(): void {
  inMemoryUiSessionSnapshots.clear()
}

function regexScrubUrlText(input: string): string {
  // Scrub embedded scheme://user:pass@ (handles '#', '?', ':', '@' inside passwords)
  let out = input.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:/\s?#@]*):([^\s/]*)@/g,
    '$1$2@'
  )
  // Scrub sensitive query parameters even in malformed / partial URLs
  out = out.replace(
    /([?&])([^=&\s#]*(?:token|pass|pwd|secret|key|auth)[^=&\s#]*)=([^&\s#]*)/gi,
    '$1$2=[REDACTED]'
  )
  return out
}

export function scrubCredentialsInText(raw: string): string {
  if (!raw) return ''
  return regexScrubUrlText(raw)
}

function scrubSensitiveUrlDraft(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const preScrubbed = regexScrubUrlText(trimmed)
  const urlScrubbed = scrubUrlCredentials(preScrubbed)
  if (urlScrubbed !== undefined) {
    let cleaned = urlScrubbed
    try {
      const parsed = new URL(cleaned)
      let mutated = false
      for (const key of Array.from(parsed.searchParams.keys())) {
        if (/(?:token|pass|pwd|secret|key|auth)/i.test(key)) {
          parsed.searchParams.delete(key)
          mutated = true
        }
      }
      if (mutated) cleaned = parsed.toString()
    } catch {
      cleaned = regexScrubUrlText(cleaned)
    }
    return cleaned
  }
  return preScrubbed
}

function stripSecretsFromViewState(
  viewState: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...viewState }
  if (typeof out.sqlDraft === 'string' && out.sqlDraft.trim().length > 0) {
    try {
      if (detectRecognizableSqlCredential(out.sqlDraft) !== null) {
        out.sqlDraft = ''
      }
    } catch {
      // Ignore credential detector error
    }
  }
  if (out.consoleTabs && typeof out.consoleTabs === 'object' && !Array.isArray(out.consoleTabs)) {
    const ct = { ...(out.consoleTabs as Record<string, unknown>) }
    if (Array.isArray(ct.tabs)) {
      ct.tabs = ct.tabs.map((tab) => {
        if (!tab || typeof tab !== 'object' || Array.isArray(tab)) return tab
        const rec = { ...(tab as Record<string, unknown>) }
        if (typeof rec.sql === 'string' && rec.sql.trim().length > 0) {
          try {
            if (detectRecognizableSqlCredential(rec.sql) !== null) {
              rec.sql = ''
            }
          } catch {
            // Ignore detector error
          }
        }
        return rec
      })
    }
    out.consoleTabs = ct
  }
  if (out.formDraft && typeof out.formDraft === 'object' && !Array.isArray(out.formDraft)) {
    const draft = { ...(out.formDraft as Record<string, unknown>) }
    delete draft.uri
    delete draft.password
    delete draft.authToken
    delete draft.sshPassword
    delete draft.sshPassphrase
    delete draft.sslKeyPassphrase
    if (typeof draft.libsqlUrl === 'string') {
      draft.libsqlUrl = scrubSensitiveUrlDraft(draft.libsqlUrl)
    }
    if (typeof draft.clickhouseUrl === 'string') {
      draft.clickhouseUrl = scrubSensitiveUrlDraft(draft.clickhouseUrl)
    }
    out.formDraft = draft
  }
  return sanitizeJsonPayload(out)
}

export async function saveUiSessionSnapshot(
  orca: OrcaWorkerApi,
  surface: 'panel' | 'studio',
  input: {
    viewState?: Record<string, unknown> | null
    dataCache?: Record<string, unknown> | null
  }
): Promise<{ ok: true; updatedAt: number }> {
  const prev = inMemoryUiSessionSnapshots.get(surface) ?? {
    viewState: null,
    dataCache: null,
    updatedAt: 0,
  }
  const nextViewState =
    input.viewState && typeof input.viewState === 'object' && !Array.isArray(input.viewState)
      ? stripSecretsFromViewState(input.viewState)
      : prev.viewState
  let nextDataCache = prev.dataCache
  if (input.dataCache === null) {
    nextDataCache = null
  } else if (
    input.dataCache &&
    typeof input.dataCache === 'object' &&
    !Array.isArray(input.dataCache)
  ) {
    nextDataCache = { ...(prev.dataCache || {}), ...input.dataCache }
  }
  const updatedAt = Date.now()
  inMemoryUiSessionSnapshots.set(surface, {
    viewState: nextViewState,
    dataCache: nextDataCache,
    updatedAt,
  })

  if (nextViewState) {
    const storageKey =
      surface === 'panel' ? 'datanoa.panelViewState' : 'datanoa.studioViewState'
    try {
      await orca.storage.set(storageKey, nextViewState as JsonValue)
    } catch {
      // Ignore storage write failure
    }
    const isLiveDesktopHost = Boolean(orca.host && typeof orca.host.call === 'function')
    if (isLiveDesktopHost) {
      void writeHostConfigBackupPatch(
        surface === 'panel'
          ? { panelViewState: nextViewState }
          : { studioViewState: nextViewState }
      )
    }
  }
  return { ok: true, updatedAt }
}

export async function getUiSessionSnapshot(
  orca: OrcaWorkerApi,
  surface: 'panel' | 'studio'
): Promise<{
  viewState: Record<string, unknown> | null
  dataCache: Record<string, unknown> | null
  updatedAt: number
}> {
  const mem = inMemoryUiSessionSnapshots.get(surface)
  if (mem && (mem.viewState || mem.dataCache)) {
    return mem
  }
  const storageKey =
    surface === 'panel' ? 'datanoa.panelViewState' : 'datanoa.studioViewState'
  let storedView: Record<string, unknown> | null = null
  try {
    const raw = await orca.storage.get(storageKey)
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      storedView = stripSecretsFromViewState(raw as Record<string, unknown>)
    }
  } catch {
    // Ignore storage read failure
  }
  const isLiveDesktopHost = Boolean(orca.host && typeof orca.host.call === 'function')
  if (!storedView && isLiveDesktopHost) {
    const backup = await readHostConfigBackup()
    const fromBackup =
      surface === 'panel' ? backup?.panelViewState : backup?.studioViewState
    if (fromBackup && typeof fromBackup === 'object' && !Array.isArray(fromBackup)) {
      storedView = stripSecretsFromViewState(fromBackup)
    }
  }
  const snapshot = {
    viewState: storedView,
    dataCache: mem?.dataCache ?? null,
    updatedAt: mem?.updatedAt || (storedView ? Date.now() : 0),
  }
  if (storedView) {
    inMemoryUiSessionSnapshots.set(surface, snapshot)
  }
  return snapshot
}

function getHostBackupFilePath(): string {
  return path.join(os.homedir(), '.datanoa', 'workspace-backup.json')
}

export async function readHostConfigBackup(): Promise<HostConfigBackupPayload | null> {
  try {
    const raw = await fs.promises.readFile(getHostBackupFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as HostConfigBackupPayload
  } catch {
    return null
  }
}

const hostBackupQueue = createSerializedQueue()
let hostBackupTmpSeq = 0

export async function flushHostConfigBackupWrites(): Promise<void> {
  await hostBackupQueue.waitIdle()
}

export function writeHostConfigBackupPatch(
  patch: Partial<HostConfigBackupPayload>
): Promise<void> {
  return hostBackupQueue.run(async () => {
    try {
      const filePath = getHostBackupFilePath()
      const dir = path.dirname(filePath)
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
      const existing = (await readHostConfigBackup()) ?? {}
      const merged: HostConfigBackupPayload = sanitizeJsonPayload({
        ...existing,
        ...patch,
        updatedAt: Date.now(),
      })
      const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${++hostBackupTmpSeq}`
      await fs.promises.writeFile(tmpPath, JSON.stringify(merged, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      })
      let renamed = false
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await fs.promises.rename(tmpPath, filePath)
          renamed = true
          break
        } catch {
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 40 * (attempt + 1)))
          }
        }
      }
      if (!renamed) {
        await fs.promises.unlink(tmpPath).catch(() => {})
      }
    } catch {
      // Best-effort backup; never block primary storage
    }
  })
}

export function getDefaultByodDriverDirs(): {
  baseDir: string
  platform: string
  paths: Record<string, string>
  templates: Record<string, string>
} {
  const baseDir = path.join(os.homedir(), '.datanoa', 'drivers')
  return {
    baseDir,
    platform: process.platform,
    paths: {
      mssql: path.join(baseDir, 'mssql'),
      oracle: path.join(baseDir, 'oracle'),
      mongodb: path.join(baseDir, 'mongodb'),
      custom: path.join(baseDir, 'custom'),
    },
    templates: {
      mssql: getCanonicalByodStarterCode('mssql'),
      oracle: getCanonicalByodStarterCode('oracle'),
      mongodb: getCanonicalByodStarterCode('mongodb'),
      custom: getCanonicalByodStarterCode('custom'),
    },
  }
}

export interface WorkspaceScopeInfo {
  id: string
  name: string
  branch?: string
  path?: string
  projectFolder: string
  label: string
  isCurrent: boolean
}

export function deriveWorkspaceProjectFolder(wsPath?: string, fallbackName?: string): string {
  const raw = typeof wsPath === 'string' ? wsPath.trim() : ''
  if (raw) {
    const parts = raw.split(/[\\/]+/).filter(Boolean)
    const wsIdx = parts.findIndex((p) => p.toLowerCase() === 'workspaces')
    if (wsIdx >= 0 && wsIdx + 2 < parts.length) {
      return parts[wsIdx + 1]
    }
    if (parts.length > 0) {
      return parts[parts.length - 1]
    }
  }
  return (typeof fallbackName === 'string' && fallbackName.trim()) || 'General'
}

export async function listWorkspaceScopesForUi(orca: OrcaWorkerApi): Promise<{
  currentScopeId: string
  currentScopeLabel: string
  workspaces: WorkspaceScopeInfo[]
}> {
  const workspaces: WorkspaceScopeInfo[] = []
  let currentScopeId = ''
  let currentScopeLabel = ''

  if (!orca.host || typeof orca.host.call !== 'function') {
    return { currentScopeId, currentScopeLabel, workspaces }
  }

  let ctxId = ''
  let ctxName = ''
  let ctxBranch = ''
  try {
    const ctx = (await orca.host.call('workspace.readContext')) as {
      workspaceId?: string
      displayName?: string
      branch?: string | null
    } | null
    if (typeof ctx?.workspaceId === 'string') ctxId = ctx.workspaceId.trim()
    if (typeof ctx?.displayName === 'string') ctxName = ctx.displayName.trim()
    if (typeof ctx?.branch === 'string' && ctx.branch.trim()) ctxBranch = ctx.branch.trim()
  } catch {
    // Ignore readContext failure
  }

  try {
    const listResult = (await orca.host.call('workspace.list')) as {
      workspaces?: Array<{
        id: string
        path: string
        name?: string
        branch?: string | null
        hostId?: string | null
      }>
    } | null
    const rawList = Array.isArray(listResult?.workspaces) ? listResult.workspaces : []
    for (const w of rawList) {
      if (!w || typeof w.id !== 'string' || !w.id.trim()) continue
      const id = w.id.trim()
      const folderBase =
        typeof w.path === 'string' && w.path.trim() ? path.basename(w.path.trim()) : ''
      const name = (typeof w.name === 'string' && w.name.trim()) || folderBase || id
      const branch =
        typeof w.branch === 'string' && w.branch.trim() ? w.branch.trim() : undefined
      const isCurrent =
        (Boolean(ctxId) && id === ctxId) ||
        (!ctxId && Boolean(ctxName) && name === ctxName && (!ctxBranch || branch === ctxBranch))
      const projectFolder = deriveWorkspaceProjectFolder(w.path, name)
      const label = `${name}${branch ? ` (${branch})` : ''}${w.path ? ` — ${w.path}` : ''}`
      workspaces.push({
        id,
        name,
        branch,
        path: w.path,
        projectFolder,
        label,
        isCurrent,
      })
    }
  } catch {
    // Ignore workspace.list failure
  }

  if (ctxId) {
    currentScopeId = ctxId
    const exactMatch = workspaces.find((w) => w.id === ctxId)
    if (exactMatch) {
      exactMatch.isCurrent = true
      currentScopeLabel = `${exactMatch.name}${exactMatch.branch ? ` (${exactMatch.branch})` : ''}`
    } else {
      const byNameMatch = workspaces.find(
        (w) =>
          Boolean(ctxName) &&
          w.name === ctxName &&
          (!ctxBranch || !w.branch || w.branch === ctxBranch)
      )
      const readableName =
        ctxName ||
        byNameMatch?.name ||
        ctxId.replace(/^folder:[0-9a-f-]+$/i, 'Current Workspace')
      const readableBranch = ctxBranch || byNameMatch?.branch
      currentScopeLabel = `${readableName}${readableBranch ? ` (${readableBranch})` : ''}`
      const projectFolder = deriveWorkspaceProjectFolder(byNameMatch?.path, readableName)
      workspaces.unshift({
        id: ctxId,
        name: readableName,
        branch: readableBranch,
        path: byNameMatch?.path,
        projectFolder,
        label: `${currentScopeLabel}${byNameMatch?.path ? ` — ${byNameMatch.path}` : ''}`,
        isCurrent: true,
      })
    }
  } else {
    const firstCurrent = workspaces.find((w) => w.isCurrent) || workspaces[0]
    if (firstCurrent) {
      currentScopeId = firstCurrent.id
      currentScopeLabel = `${firstCurrent.name}${firstCurrent.branch ? ` (${firstCurrent.branch})` : ''}`
    }
  }

  return { currentScopeId, currentScopeLabel, workspaces }
}

const MAX_PICKER_ENTRIES = 500
const WIN_DRIVE_CACHE_TTL_MS = 30_000
const WIN_DRIVE_PROBE_TIMEOUT_MS = 150

let cachedWinDrives: string[] | null = null
let cachedWinDrivesAt = 0

async function resolvePickerInitialDir(
  rawInitial?: string,
  fallbackDirs?: readonly string[]
): Promise<string> {
  const candidates: string[] = []
  const trimmed = typeof rawInitial === 'string' ? rawInitial.trim() : ''
  if (trimmed) candidates.push(trimmed)
  if (fallbackDirs) {
    for (const dir of fallbackDirs) {
      if (typeof dir === 'string' && dir.trim()) candidates.push(dir.trim())
    }
  }
  const home = os.homedir()
  if (home) candidates.push(home)

  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate)
      const st = await fs.promises.stat(resolved)
      return st.isDirectory() ? resolved : path.dirname(resolved)
    } catch {
      try {
        const parent = path.dirname(path.resolve(candidate))
        const parentStat = await fs.promises.stat(parent)
        if (parentStat.isDirectory()) return parent
      } catch {
        // Continue to next fallback
      }
    }
  }
  return path.resolve('.')
}

async function probeWinDriveWithTimeout(drive: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fs.promises.access(drive).then(
        () => drive,
        () => null
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), WIN_DRIVE_PROBE_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function listWindowsDrivesCached(): Promise<string[]> {
  const now = Date.now()
  if (cachedWinDrives && now - cachedWinDrivesAt < WIN_DRIVE_CACHE_TTL_MS) {
    return cachedWinDrives
  }
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  const checks = await Promise.all(letters.map((l) => probeWinDriveWithTimeout(`${l}:\\`)))
  cachedWinDrives = checks.filter((d): d is string => d !== null)
  cachedWinDrivesAt = now
  return cachedWinDrives
}

async function listAvailablePickerRoots(workspaceDirs?: readonly string[]): Promise<string[]> {
  const seen = new Set<string>()
  const roots: string[] = []
  const pushUnique = (dir: string): void => {
    const norm = normalizePathForCompare(dir)
    if (!norm || seen.has(norm)) return
    seen.add(norm)
    roots.push(dir)
  }

  if (workspaceDirs) {
    for (const ws of workspaceDirs) {
      if (typeof ws === 'string' && ws.trim()) pushUnique(path.resolve(ws.trim()))
    }
  }
  const home = os.homedir()
  if (home) pushUnique(path.resolve(home))

  if (process.platform === 'win32') {
    for (const drive of await listWindowsDrivesCached()) {
      pushUnique(drive)
    }
  } else {
    pushUnique('/')
  }
  return roots
}

type PickerDirEntry = { name: string; path: string; kind: 'dir' | 'file'; size?: number }

async function classifyPickerDirent(
  currentDir: string,
  entry: fs.Dirent,
  mode: 'file' | 'folder',
  extSet: ReadonlySet<string> | null
): Promise<PickerDirEntry | null> {
  const fullPath = path.join(currentDir, entry.name)
  let isDir = entry.isDirectory()
  let isFile = entry.isFile()
  if (entry.isSymbolicLink()) {
    try {
      const st = await fs.promises.stat(fullPath)
      isDir = st.isDirectory()
      isFile = st.isFile()
    } catch {
      return null
    }
  }
  if (isDir) return { name: entry.name, path: fullPath, kind: 'dir' }
  if (mode === 'folder' || !isFile) return null
  if (extSet && !extSet.has(path.extname(entry.name).toLowerCase())) return null
  return { name: entry.name, path: fullPath, kind: 'file' }
}

export async function listDirectoryForPicker(
  options?: { dir?: string; mode?: 'file' | 'folder'; extensions?: string[]; strictDir?: boolean },
  workspaceDirs?: readonly string[]
): Promise<{
  ok: boolean
  currentDir: string
  parentDir: string | null
  roots: string[]
  entries: PickerDirEntry[]
  truncated?: boolean
  error?: string
}> {
  const mode = options?.mode === 'folder' ? 'folder' : 'file'
  const rawDir = typeof options?.dir === 'string' ? options.dir.trim() : ''
  const strictDir = Boolean(options?.strictDir && rawDir)
  const extSet =
    Array.isArray(options?.extensions) && options.extensions.length > 0
      ? new Set(
          options.extensions
            .filter((ext): ext is string => typeof ext === 'string')
            .map((ext) => ext.trim().toLowerCase())
            .filter(Boolean)
            .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))
        )
      : null

  const roots = await listAvailablePickerRoots(workspaceDirs)
  let currentDir: string
  if (strictDir) {
    currentDir = path.resolve(rawDir)
    try {
      const st = await fs.promises.stat(currentDir)
      if (!st.isDirectory()) {
        return {
          ok: false,
          currentDir: '',
          parentDir: null,
          roots,
          entries: [],
          error: `Not a directory: ${currentDir}`,
        }
      }
    } catch {
      return {
        ok: false,
        currentDir: '',
        parentDir: null,
        roots,
        entries: [],
        error: `Directory not found: ${currentDir}`,
      }
    }
  } else {
    currentDir = await resolvePickerInitialDir(rawDir, workspaceDirs)
  }

  const rawParent = path.dirname(currentDir)
  const parentDir =
    normalizePathForCompare(rawParent) !== normalizePathForCompare(currentDir) ? rawParent : null

  try {
    const dirents = await fs.promises.readdir(currentDir, { withFileTypes: true })
    dirents.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

    const dirs: PickerDirEntry[] = []
    const files: PickerDirEntry[] = []
    let truncated = false
    for (const entry of dirents) {
      const classified = await classifyPickerDirent(currentDir, entry, mode, extSet)
      if (!classified) continue
      if (classified.kind === 'dir') {
        if (dirs.length < MAX_PICKER_ENTRIES) dirs.push(classified)
        else truncated = true
      } else if (dirs.length + files.length < MAX_PICKER_ENTRIES) {
        files.push(classified)
      } else {
        truncated = true
      }
    }

    const combined = [...dirs, ...files].slice(0, MAX_PICKER_ENTRIES)
    if (dirs.length + files.length > MAX_PICKER_ENTRIES) truncated = true

    // Populate file sizes only for the bounded visible slice
    await Promise.all(
      combined.map(async (item) => {
        if (item.kind !== 'file') return
        try {
          item.size = (await fs.promises.stat(item.path)).size
        } catch {
          // Optional metadata
        }
      })
    )

    return { ok: true, currentDir, parentDir, roots, entries: combined, truncated }
  } catch (err) {
    return {
      ok: false,
      currentDir,
      parentDir,
      roots,
      entries: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

const ALLOWED_BYOD_NPM_PACKAGES: Readonly<Record<string, string>> = {
  mssql: 'mssql',
  oracle: 'oracledb',
  mongodb: 'mongodb',
}

export { getCanonicalByodStarterCode }

const BYOD_SETUP_DRIVER_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/

function assertValidByodSetupDriverId(driverId: string): string {
  const id = typeof driverId === 'string' ? driverId.trim().toLowerCase() : ''
  if (!BYOD_SETUP_DRIVER_ID_RE.test(id)) {
    throw createHostError(
      'invalid_params',
      'Driver ID must start with a letter and contain only letters, digits, "-" or "_" (2-64 chars)'
    )
  }
  if ((SUPPORTED_DRIVERS as readonly string[]).includes(id)) {
    throw createHostError(
      'invalid_params',
      `"${id}" is a built-in engine and cannot be scaffolded as a local BYOD driver`
    )
  }
  return id
}

export async function ensureByodDirectoryScaffolded(
  driverId: string,
  localPath: string,
  overwriteEntry = false
): Promise<{
  dirPath: string
  entryPath: string
  canonicalSha256: string
  wroteCanonicalEntry: boolean
}> {
  const id = assertValidByodSetupDriverId(driverId)
  const rawDir = typeof localPath === 'string' ? localPath.trim() : ''
  if (!rawDir) {
    throw createHostError('invalid_params', 'Target folder path is required')
  }
  const isExplicitFile = /[/\\][^/\\]+\.(?:mjs|cjs|js)$/i.test(rawDir)
  const dirPath = isExplicitFile ? path.dirname(path.resolve(rawDir)) : path.resolve(rawDir)
  await fs.promises.mkdir(dirPath, { recursive: true })

  const entryPath = isExplicitFile ? path.resolve(rawDir) : path.join(dirPath, 'index.mjs')
  const mainFileName = path.basename(entryPath)
  const pkgJsonPath = path.join(dirPath, 'package.json')
  let pkgObj: Record<string, unknown> = {
    name: `datanoa-byod-${id}`,
    version: '1.0.0',
    private: true,
    type: 'module',
    main: mainFileName,
  }
  try {
    const existingRaw = await fs.promises.readFile(pkgJsonPath, 'utf8')
    const existing = JSON.parse(existingRaw) as unknown
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      const sanitizedExisting = { ...(existing as Record<string, unknown>) }
      delete sanitizedExisting.exports
      delete sanitizedExisting.scripts
      pkgObj = {
        ...sanitizedExisting,
        type: 'module',
        main: mainFileName,
      }
    }
  } catch {
    // Missing or unreadable package.json — write fresh module manifest
  }
  await fs.promises.writeFile(pkgJsonPath, JSON.stringify(pkgObj, null, 2) + '\n', 'utf8')

  const codeToWrite = getCanonicalByodStarterCode(id)
  const canonicalSha256 = createHash('sha256').update(codeToWrite, 'utf8').digest('hex')

  let entryExists = false
  try {
    await fs.promises.access(entryPath)
    entryExists = true
  } catch {
    entryExists = false
  }
  let wroteCanonicalEntry = false
  if (!entryExists || overwriteEntry) {
    await fs.promises.writeFile(entryPath, codeToWrite, 'utf8')
    wroteCanonicalEntry = true
  } else {
    try {
      const existingBytes = await fs.promises.readFile(entryPath)
      const existingHash = createHash('sha256').update(existingBytes).digest('hex')
      wroteCanonicalEntry = existingHash === canonicalSha256
    } catch {
      wroteCanonicalEntry = false
    }
  }

  return { dirPath, entryPath, canonicalSha256, wroteCanonicalEntry }
}

export async function scaffoldLocalDriverDirectory(input: {
  driverId: string
  localPath: string
}): Promise<{
  dirPath: string
  entryPath: string
  installPackage?: string
  canonicalSha256: string
  wroteCanonicalEntry: boolean
}> {
  const id = assertValidByodSetupDriverId(input.driverId)
  const { dirPath, entryPath, canonicalSha256, wroteCanonicalEntry } =
    await ensureByodDirectoryScaffolded(id, input.localPath, false)

  return {
    dirPath,
    entryPath,
    installPackage: ALLOWED_BYOD_NPM_PACKAGES[id],
    canonicalSha256,
    wroteCanonicalEntry,
  }
}

export const COMPACTED_CELL_SUFFIX_RE = /… \[\+\d+ chars\]$/

export function assertNoCompactedPreviewOverwrite(value: unknown, columnName?: string): void {
  if (typeof value === 'string' && COMPACTED_CELL_SUFFIX_RE.test(value)) {
    const colLabel = columnName ? ` for column "${columnName}"` : ''
    throw createHostError(
      'invalid_params',
      `Refusing to save truncated display preview ("… [+N chars]")${colLabel} back to database. Replace the cell with the full value or update via SQL console.`
    )
  }
}

export const MAX_ORCA_IPC_RESPONSE_BYTES = 950_000

function truncateUtf8String(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return text
  return buf.subarray(0, maxBytes).toString('utf8')
}

function compactCellValue(value: unknown, maxChars: number): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    if (value.length > maxChars) {
      return {
        value: `${value.slice(0, maxChars)}… [+${value.length - maxChars} chars]`,
        changed: true,
      }
    }
    return { value, changed: false }
  }
  if (value !== null && typeof value === 'object') {
    try {
      const json = JSON.stringify(value)
      if (json && json.length > maxChars) {
        return {
          value: `${json.slice(0, maxChars)}… [+${json.length - maxChars} chars]`,
          changed: true,
        }
      }
    } catch {
      // Keep original value if non-serializable
    }
  }
  return { value, changed: false }
}

function compactRowsStrings(rows: unknown[], maxChars: number): unknown[] {
  return rows.map((row) => {
    if (Array.isArray(row)) {
      let changed = false
      const nextRow = row.map((cell) => {
        const compacted = compactCellValue(cell, maxChars)
        if (compacted.changed) changed = true
        return compacted.value
      })
      return changed ? nextRow : row
    }
    if (row && typeof row === 'object') {
      const rec = row as Record<string, unknown>
      let changed = false
      const nextObj: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(rec)) {
        const compacted = compactCellValue(v, maxChars)
        if (compacted.changed) changed = true
        nextObj[k] = compacted.value
      }
      return changed ? nextObj : row
    }
    return row
  })
}

function shrinkDdlFieldToFit(rec: Record<string, unknown>): boolean {
  if (typeof rec.ddl !== 'string' || rec.ddl.length === 0) return false
  const suffix = '\n-- [Truncated to fit 1 MiB Orca IPC response limit]\n'
  const origDdl = rec.ddl
  let targetBytes = Math.min(Buffer.byteLength(origDdl, 'utf8'), 820_000)
  for (let i = 0; i < 8 && targetBytes > 0; i++) {
    rec.ddl = `${truncateUtf8String(origDdl, targetBytes)}${suffix}`
    const curBytes = Buffer.byteLength(JSON.stringify(rec), 'utf8')
    if (curBytes <= MAX_ORCA_IPC_RESPONSE_BYTES) return true
    const ratio = MAX_ORCA_IPC_RESPONSE_BYTES / curBytes
    targetBytes = Math.max(0, Math.floor(targetBytes * ratio * 0.85))
  }
  rec.ddl = '-- [DDL truncated to fit 1 MiB Orca IPC response limit]\n'
  return Buffer.byteLength(JSON.stringify(rec), 'utf8') <= MAX_ORCA_IPC_RESPONSE_BYTES
}

function clampViewStateToFit(rec: Record<string, unknown>): void {
  if (!rec.viewState || typeof rec.viewState !== 'object' || Array.isArray(rec.viewState)) return
  const vs = { ...(rec.viewState as Record<string, unknown>) }
  if (typeof vs.sqlDraft === 'string' && vs.sqlDraft.length > 8000) {
    vs.sqlDraft = vs.sqlDraft.slice(0, 8000)
  }
  if (vs.consoleTabs && typeof vs.consoleTabs === 'object' && !Array.isArray(vs.consoleTabs)) {
    const ct = { ...(vs.consoleTabs as Record<string, unknown>) }
    if (Array.isArray(ct.tabs)) {
      ct.tabs = ct.tabs.slice(0, 8).map((tab) => {
        if (!tab || typeof tab !== 'object' || Array.isArray(tab)) return tab
        const tRec = { ...(tab as Record<string, unknown>) }
        if (typeof tRec.sql === 'string' && tRec.sql.length > 4000) {
          tRec.sql = tRec.sql.slice(0, 4000)
        }
        return tRec
      })
    }
    vs.consoleTabs = ct
  }
  rec.viewState = vs
  if (Buffer.byteLength(JSON.stringify(rec), 'utf8') > MAX_ORCA_IPC_RESPONSE_BYTES) {
    delete vs.sqlDraft
    delete vs.consoleTabs
    delete vs.columnConfigByTable
    rec.viewState = vs
  }
  if (Buffer.byteLength(JSON.stringify(rec), 'utf8') > MAX_ORCA_IPC_RESPONSE_BYTES) {
    rec.viewState = null
  }
}

/**
 * Guarantees every worker RPC response stays safely below Orca's hard 1 MiB (1,048,576-byte)
 * IPC response limit so wide tables (e.g. chrome_profile with large JSON/cookie columns),
 * large DDL exports, top-level arrays, or session snapshots never fail with "<method> answered with more than 1 MiB".
 */
export function fitResponseWithinOrcaIpcLimit<T>(payload: T): T {
  let serialized: string
  try {
    serialized = JSON.stringify(payload)
  } catch {
    return payload
  }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') <= MAX_ORCA_IPC_RESPONSE_BYTES) {
    return payload
  }
  if (!payload || typeof payload !== 'object') {
    return payload
  }

  // 0. Top-level array response (e.g. schema.listObjects / connections.list)
  if (Array.isArray(payload)) {
    let items = compactRowsStrings(payload, 512)
    while (items.length > 0 && Buffer.byteLength(JSON.stringify(items), 'utf8') > MAX_ORCA_IPC_RESPONSE_BYTES) {
      const curBytes = Buffer.byteLength(JSON.stringify(items), 'utf8')
      const ratio = MAX_ORCA_IPC_RESPONSE_BYTES / curBytes
      const nextLen = Math.max(0, Math.min(items.length - 1, Math.floor(items.length * ratio * 0.9)))
      items = items.slice(0, nextLen)
    }
    return items as unknown as T
  }

  const rec = { ...(payload as Record<string, unknown>) }

  // 1. Nested session snapshot dataCache & viewState (ui.getSessionSnapshot)
  if ('dataCache' in rec || 'viewState' in rec) {
    if (rec.dataCache && typeof rec.dataCache === 'object' && !Array.isArray(rec.dataCache)) {
      const dc = { ...(rec.dataCache as Record<string, unknown>) }
      if (dc.pageData && typeof dc.pageData === 'object') {
        dc.pageData = fitResponseWithinOrcaIpcLimit(dc.pageData)
      }
      if (dc.lastSqlResult && typeof dc.lastSqlResult === 'object') {
        dc.lastSqlResult = fitResponseWithinOrcaIpcLimit(dc.lastSqlResult)
      }
      rec.dataCache = dc
      if (Buffer.byteLength(JSON.stringify(rec), 'utf8') <= MAX_ORCA_IPC_RESPONSE_BYTES) {
        return rec as T
      }
      delete dc.pageData
      delete dc.lastSqlResult
      rec.dataCache = dc
      if (Buffer.byteLength(JSON.stringify(rec), 'utf8') <= MAX_ORCA_IPC_RESPONSE_BYTES) {
        return rec as T
      }
      rec.dataCache = null
      if (Buffer.byteLength(JSON.stringify(rec), 'utf8') <= MAX_ORCA_IPC_RESPONSE_BYTES) {
        return rec as T
      }
    }
    clampViewStateToFit(rec)
    if (Buffer.byteLength(JSON.stringify(rec), 'utf8') <= MAX_ORCA_IPC_RESPONSE_BYTES) {
      return rec as T
    }
  }

  // 2. Large DDL string response (schema.exportSchemaDdl / schema.generateDdl / schema.tableDetails)
  if (typeof rec.ddl === 'string' && rec.ddl.length > 0) {
    if (shrinkDdlFieldToFit(rec)) {
      return rec as T
    }
  }

  // 2.5. List wrapper `{ entries: [...] }` (queries.saved.list / query.history.list)
  if (Array.isArray(rec.entries)) {
    let entries = compactRowsStrings(rec.entries as unknown[], 4096)
    rec.entries = entries
    if (Buffer.byteLength(JSON.stringify(rec), 'utf8') <= MAX_ORCA_IPC_RESPONSE_BYTES) {
      return rec as T
    }
    entries = compactRowsStrings(rec.entries as unknown[], 1024)
    rec.entries = entries
    while (entries.length > 0 && Buffer.byteLength(JSON.stringify(rec), 'utf8') > MAX_ORCA_IPC_RESPONSE_BYTES) {
      const curBytes = Buffer.byteLength(JSON.stringify(rec), 'utf8')
      const ratio = MAX_ORCA_IPC_RESPONSE_BYTES / curBytes
      const nextLen = Math.max(0, Math.min(entries.length - 1, Math.floor(entries.length * ratio * 0.88)))
      entries = entries.slice(0, nextLen)
      rec.entries = entries
    }
    return rec as T
  }

  // 3. Tabular rows & multi-resultSets response (data.fetchPage / query.run)
  if (Array.isArray(rec.rows) || Array.isArray(rec.resultSets)) {
    const origRows = Array.isArray(rec.rows) ? (rec.rows as unknown[]) : null
    const origResultSets = Array.isArray(rec.resultSets)
      ? (rec.resultSets as Array<Record<string, unknown>>)
      : null
    const charTiers = [8192, 4096, 2048, 1024, 512, 256, 128, 64, 32]

    for (const maxChars of charTiers) {
      if (origRows) {
        rec.rows = compactRowsStrings(origRows, maxChars)
      }
      if (origResultSets) {
        rec.resultSets = origResultSets.map((rs) =>
          rs && typeof rs === 'object' && Array.isArray(rs.rows)
            ? { ...rs, rows: compactRowsStrings(rs.rows as unknown[], maxChars) }
            : rs
        )
      }
      if (Buffer.byteLength(JSON.stringify(rec), 'utf8') <= MAX_ORCA_IPC_RESPONSE_BYTES) {
        return rec as T
      }
    }

    // 4. Clamp row counts across rec.rows and rec.resultSets until safely < 950 KB
    let compactedRows = Array.isArray(rec.rows) ? (rec.rows as unknown[]) : []
    let compactedResultSets = Array.isArray(rec.resultSets)
      ? (rec.resultSets as Array<Record<string, unknown>>)
      : null

    const totalNestedRows = (): number => {
      if (!compactedResultSets) return 0
      return compactedResultSets.reduce(
        (sum, rs) => sum + (rs && typeof rs === 'object' && Array.isArray(rs.rows) ? rs.rows.length : 0),
        0
      )
    }

    while (compactedRows.length > 0 || totalNestedRows() > 0) {
      const curBytes = Buffer.byteLength(JSON.stringify(rec), 'utf8')
      if (curBytes <= MAX_ORCA_IPC_RESPONSE_BYTES) break
      const ratio = MAX_ORCA_IPC_RESPONSE_BYTES / curBytes

      if (compactedRows.length > 1) {
        const nextLen = Math.max(
          1,
          Math.min(compactedRows.length - 1, Math.floor(compactedRows.length * ratio * 0.88))
        )
        compactedRows = compactedRows.slice(0, nextLen)
        rec.rows = compactedRows
        rec.truncated = true
        if (typeof rec.rowCount === 'number') rec.rowCount = compactedRows.length
      } else if (compactedRows.length === 1) {
        compactedRows = []
        rec.rows = []
        rec.truncated = true
        if (typeof rec.rowCount === 'number') rec.rowCount = 0
      }

      if (compactedResultSets) {
        let shrunkAny = false
        compactedResultSets = compactedResultSets.map((rs) => {
          if (!rs || typeof rs !== 'object' || !Array.isArray(rs.rows) || rs.rows.length === 0) {
            return rs
          }
          shrunkAny = true
          const curLen = rs.rows.length
          const nextRsLen =
            curLen <= 1
              ? 0
              : Math.max(1, Math.min(curLen - 1, Math.floor(curLen * ratio * 0.85)))
          return {
            ...rs,
            rows: rs.rows.slice(0, nextRsLen),
            rowCount: nextRsLen,
            truncated: true,
          }
        })
        rec.resultSets = compactedResultSets
        rec.truncated = true
        if (!shrunkAny && Buffer.byteLength(JSON.stringify(rec), 'utf8') > MAX_ORCA_IPC_RESPONSE_BYTES) {
          compactedResultSets = []
          rec.resultSets = []
          break
        }
      }
    }
    return rec as T
  }

  return rec as T
}
