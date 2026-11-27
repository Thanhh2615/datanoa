import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import {
  ACTIVE_CONNECTION_STORAGE_KEY,
  sanitizeJsonPayload,
  type ConnectionColorTag,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type DatabaseDriverType,
  type ErLayoutStateEntry,
  type PersistedLocalDriverConfig,
  type QueryResult,
  type SavedQueryEntry,
  type SshJumpHostProfile,
  type StudioViewMode,
  type TableDisplayStateEntry,
} from '../protocol'
import type { IDatabaseSession } from '../drivers'
import { copyFailedStatementMeta } from '../drivers/common/driver'
import { getCanonicalByodStarterCode } from '../drivers/common/byod-templates'
import { scrubUrlCredentials, SUPPORTED_DRIVERS } from '../drivers/common/connection-uri'
import { detectRecognizableSqlCredential } from '../drivers/common/sql-credentials'
import { quoteIdentForDialect } from '../drivers/common/sql-tools'
import {
  ACTIONABLE_TLS_CERT_ERROR_HINT,
  appendActionableTlsErrorHint,
} from '../drivers/common/tls-and-tunnel'
import { isReservedFolderName, normalizeFolderOrder } from '../shared-connection-order.js'
import {
  containsSensitiveSqlText,
  isSensitiveUriParamKey,
  sanitizeSqlResultForStorage,
  scrubConnectionNameForStorage,
  scrubSensitiveText,
} from '../shared-sql-safety.js'
import {
  isBlockedScanRoot,
  isLocalWorkspaceHost,
  normalizePathForCompare,
  resolveSqliteFilePath,
} from './discovery'
import type { SessionManager } from './session-manager'

export { ACTIONABLE_TLS_CERT_ERROR_HINT, appendActionableTlsErrorHint }

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

const MAX_SSH_JUMP_HOPS = 8
const SSH_HOP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function sanitizeSshJumpHosts(raw: unknown): SshJumpHostProfile[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const cleaned: SshJumpHostProfile[] = []
  const seenHopIds = new Set<string>()
  for (const item of raw.slice(0, MAX_SSH_JUMP_HOPS)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>
    const hopId = typeof rec.hopId === 'string' ? rec.hopId.trim() : ''
    const host = typeof rec.host === 'string' ? rec.host.trim() : ''
    if (!SSH_HOP_ID_RE.test(hopId) || !host) continue
    if (seenHopIds.has(hopId)) {
      throw createHostError(
        'invalid_params',
        `Duplicate SSH jump hopId "${hopId}" — each intermediate hop must have a unique hopId.`
      )
    }
    seenHopIds.add(hopId)
    const port =
      typeof rec.port === 'number' &&
      Number.isInteger(rec.port) &&
      rec.port >= 1 &&
      rec.port <= 65535
        ? rec.port
        : undefined
    const user = typeof rec.user === 'string' && rec.user.trim().length > 0 ? rec.user.trim() : undefined
    const authMethod =
      rec.authMethod === 'agent' || rec.authMethod === 'key' || rec.authMethod === 'password'
        ? rec.authMethod
        : undefined
    const privateKeyPath =
      typeof rec.privateKeyPath === 'string' && rec.privateKeyPath.trim().length > 0
        ? rec.privateKeyPath.trim()
        : undefined
    cleaned.push({
      hopId,
      host,
      ...(port !== undefined ? { port } : {}),
      ...(user !== undefined ? { user } : {}),
      ...(authMethod !== undefined ? { authMethod } : {}),
      ...(privateKeyPath !== undefined ? { privateKeyPath } : {}),
      ...(rec.hasPassphrase ? { hasPassphrase: true } : {}),
      ...(rec.hasPassword ? { hasPassword: true } : {}),
    })
  }
  return cleaned.length > 0 ? cleaned : undefined
}

export function sanitizeConnectionProfile(conn: ConnectionProfileInput): ConnectionProfile {
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
  const rawFolder = scopedText(conn.folder, 64)
  const folder = rawFolder && !isReservedFolderName(rawFolder) ? rawFolder : undefined
  const workspaceScope = scopedText(conn.workspaceScope, 260)
  const sslMode =
    conn.sslMode === 'auto' ||
    conn.sslMode === 'disable' ||
    conn.sslMode === 'require' ||
    conn.sslMode === 'verify-ca' ||
    conn.sslMode === 'verify-full' ||
    conn.sslMode === 'strict'
      ? conn.sslMode
      : undefined
  const sshJumpHosts = sanitizeSshJumpHosts(conn.sshJumpHosts)
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
  const aiPolicy =
    conn.aiPolicy === 'allow' || conn.aiPolicy === 'ask' || conn.aiPolicy === 'never'
      ? conn.aiPolicy
      : undefined

  return sanitizeJsonPayload({
    id: conn.id,
    name: scrubConnectionName(conn.name),
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
    tlsServername: scopedText(conn.tlsServername, 255),
    sshEnabled: conn.sshEnabled ? true : undefined,
    sshHost: text(conn.sshHost),
    sshPort,
    sshUser: text(conn.sshUser),
    sshAuthMethod,
    sshPrivateKeyPath: text(conn.sshPrivateKeyPath),
    hasSshPassphrase: conn.hasSshPassphrase ? true : undefined,
    hasSshPassword: conn.hasSshPassword ? true : undefined,
    ...(sshJumpHosts !== undefined ? { sshJumpHosts } : {}),
    ...(aiPolicy !== undefined ? { aiPolicy } : {}),
  })
}

export async function normalizeSqliteProfile(
  profile: ConnectionProfileInput
): Promise<ConnectionProfileInput> {
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

function normalizeStudioViewMode(raw: unknown): StudioViewMode | undefined {
  return raw === 'split' || raw === 'grid' || raw === 'sql' || raw === 'inspector' || raw === 'er'
    ? raw
    : undefined
}

export async function openStudioDocumentInOrca(
  orca: OrcaWorkerApi,
  options?: {
    connectionId?: string
    table?: string
    schema?: string
    sql?: string
    viewMode?: StudioViewMode
    action?: 'import'
  },
  sessionManager?: SessionManager
): Promise<{ ok: boolean; path?: string; message?: string; navToken?: string }> {
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

    let resolvedSchema =
      typeof options?.schema === 'string' && options.schema.trim().length > 0
        ? options.schema.trim()
        : undefined
    if (!resolvedSchema && resolvedConnectionId && !options?.table) {
      const persistedSchemas = await readPersistedSelectedSchemas(orca)
      const remembered = persistedSchemas[resolvedConnectionId]?.schema
      if (typeof remembered === 'string' && remembered.trim().length > 0) {
        resolvedSchema = remembered.trim()
      }
    }

    const validViewMode = normalizeStudioViewMode(options?.viewMode)
    const studioAction = options?.action === 'import' ? 'import' : undefined
    const navToken = randomUUID()
    const headerLines = [
      `-- datanoa: connectionId=${resolvedConnectionId}`,
      options?.table ? `-- datanoa: table=${options.table}` : '',
      resolvedSchema ? `-- datanoa: schema=${resolvedSchema}` : '',
      validViewMode ? `-- datanoa: viewMode=${validViewMode}` : '',
      studioAction ? `-- datanoa: action=${studioAction}` : '',
      navToken ? `-- datanoa: navToken=${navToken}` : '',
    ].filter(Boolean)

    const profile =
      resolvedConnectionId && sessionManager
        ? await sessionManager.findProfile(resolvedConnectionId)
        : null
    const dialect = profile?.driver ?? 'postgres'
    const quotedTable = options?.table ? quoteIdentForDialect(options.table, dialect) : ''
    const qualifiedTable =
      quotedTable &&
      resolvedSchema &&
      !((dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1') && resolvedSchema === 'main') &&
      resolvedSchema !== 'public'
        ? `${quoteIdentForDialect(resolvedSchema, dialect)}.${quotedTable}`
        : quotedTable

    const defaultSql =
      options?.sql ||
      (dialect === 'redis'
        ? 'SCAN 0 MATCH * COUNT 50'
        : dialect === 'mongodb'
          ? options?.table
            ? `db.getCollection(${JSON.stringify(options.table)}).find({}).limit(100);`
            : 'db.stats();'
          : dialect === 'mssql'
            ? qualifiedTable
              ? `SELECT TOP 100 * FROM ${qualifiedTable};`
              : '-- Datanoa SQL Studio\nSELECT 1;\n'
            : dialect === 'oracle'
              ? qualifiedTable
                ? `SELECT * FROM ${qualifiedTable} FETCH FIRST 100 ROWS ONLY;`
                : '-- Datanoa SQL Studio\nSELECT 1 FROM DUAL;\n'
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
        schema: resolvedSchema || null,
        ...(typeof target.id === 'string' && target.id ? { workspaceId: target.id } : {}),
        docPath: relPath,
        ...(validViewMode ? { viewMode: validViewMode } : {}),
        ...(studioAction ? { action: studioAction } : {}),
        ...(navToken ? { navToken } : {}),
      })
    } catch {
      // Optional event broadcast in minimal/test hosts
    }
    return {
      ok: true,
      path: relPath,
      ...(navToken ? { navToken } : {}),
    }
  } catch (err: unknown) {
    const msg = scrubCredentialsInText(err instanceof Error ? err.message : String(err))
    orca.log(`[Worker] studio.open failed: ${msg}`)
    return { ok: false, message: msg }
  }
}

export const STUDIO_CONSUMED_NAV_TOKENS_STORAGE_KEY = 'datanoa.consumedNavTokens'
const MAX_CONSUMED_NAV_TOKENS = 200

/**
 * Tracks one-shot Studio deep-link `navToken` consumption with bounded LRU storage persistence
 * so closing/reopening `.datanoa/studio.datanoa` across sessions or restarts never re-triggers stale links.
 */
export function createStudioNavTokenConsumer(
  orca: Pick<OrcaWorkerApi, 'storage'> & Partial<Pick<OrcaWorkerApi, 'host'>>
): (navToken: string) => Promise<{ consumed: boolean; alreadyConsumed: boolean }> {
  const seen = new Set<string>()
  let loaded = false
  let queue: Promise<void> = Promise.resolve()

  const ensureLoaded = async (): Promise<boolean> => {
    if (loaded) return true
    const isLiveDesktopHost =
      'host' in orca && Boolean(orca.host && typeof orca.host.call === 'function')
    try {
      let raw = await orca.storage.get(STUDIO_CONSUMED_NAV_TOKENS_STORAGE_KEY)
      if ((!Array.isArray(raw) || raw.length === 0) && isLiveDesktopHost) {
        const backup = await readHostConfigBackup()
        if (Array.isArray(backup?.consumedNavTokens) && backup.consumedNavTokens.length > 0) {
          raw = backup.consumedNavTokens as JsonValue
        }
      }
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (typeof item === 'string' && item.trim().length > 0) {
            seen.add(item.trim())
          }
        }
        while (seen.size > MAX_CONSUMED_NAV_TOKENS) {
          const oldest = seen.values().next().value
          if (oldest === undefined) break
          seen.delete(oldest)
        }
      }
      loaded = true
      return true
    } catch {
      if (isLiveDesktopHost) {
        const backup = await readHostConfigBackup()
        if (Array.isArray(backup?.consumedNavTokens)) {
          for (const item of backup.consumedNavTokens) {
            if (typeof item === 'string' && item.trim().length > 0) {
              seen.add(item.trim())
            }
          }
          loaded = true
          return true
        }
      }
      return false
    }
  }

  return async (navToken: string): Promise<{ consumed: boolean; alreadyConsumed: boolean }> => {
    const clean = typeof navToken === 'string' ? navToken.trim() : ''
    if (!clean) {
      return { consumed: false, alreadyConsumed: true }
    }
    let result = { consumed: false, alreadyConsumed: true }
    const run = queue.then(async () => {
      const isLoaded = await ensureLoaded()
      if (!isLoaded) {
        result = { consumed: false, alreadyConsumed: false }
        return
      }
      if (seen.has(clean)) {
        result = { consumed: false, alreadyConsumed: true }
        return
      }
      const nextTokens = Array.from(seen)
      nextTokens.push(clean)
      while (nextTokens.length > MAX_CONSUMED_NAV_TOKENS) {
        nextTokens.shift()
      }
      await orca.storage.set(STUDIO_CONSUMED_NAV_TOKENS_STORAGE_KEY, nextTokens)
      if ('host' in orca && orca.host && typeof orca.host.call === 'function') {
        void writeHostConfigBackupPatch({ consumedNavTokens: nextTokens })
      }
      seen.add(clean)
      while (seen.size > MAX_CONSUMED_NAV_TOKENS) {
        const oldest = seen.values().next().value
        if (oldest === undefined) break
        seen.delete(oldest)
      }
      result = { consumed: true, alreadyConsumed: false }
    })
    queue = run.catch(() => {})
    await run
    return result
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

const CANCEL_SETTLE_GRACE_MS = 5_000

async function awaitCancelSettlement(
  session: IDatabaseSession,
  queryId: string,
  queryPromise: Promise<QueryResult>,
  graceMs = CANCEL_SETTLE_GRACE_MS
): Promise<void> {
  const cancelCall = Promise.resolve()
    .then(() => session.cancelQuery(queryId))
    .catch(() => {})
  const settledQuery = queryPromise.then(
    () => undefined,
    () => undefined
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all([cancelCall, settledQuery]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function executeSessionQuery(
  tracker: QueryRuntimeTracker,
  session: IDatabaseSession,
  queryId: string,
  sql: string,
  maxRows: number,
  timeoutSeconds: number,
  signal: AbortSignal,
  cancelGraceMs = CANCEL_SETTLE_GRACE_MS
): Promise<QueryResult> {
  tracker.activeQuerySessions.set(queryId, session)

  const queryPromise = session.runQuery(queryId, sql, maxRows, Math.max(100, Math.round(timeoutSeconds * 1000)))
  queryPromise.catch(() => {})

  let abortCleanup: (() => void) | undefined
  const abortPromise = new Promise<QueryResult>((_, reject) => {
    const onAbort = () => {
      void awaitCancelSettlement(session, queryId, queryPromise, cancelGraceMs).finally(() => {
        reject(createHostError('cancelled', 'Query execution was cancelled'))
      })
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    abortCleanup = () => signal.removeEventListener('abort', onAbort)
  })
  abortPromise.catch(() => {})

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<QueryResult>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      void awaitCancelSettlement(session, queryId, queryPromise, cancelGraceMs).finally(() => {
        reject(createHostError('timeout', `Query timed out after ${timeoutSeconds}s`))
      })
    }, timeoutSeconds * 1000)
  })
  timeoutPromise.catch(() => {})

  try {
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

export const SELECTED_SCHEMA_BY_CONN_STORAGE_KEY = 'datanoa.selectedSchemaByConn'
const MAX_PERSISTED_SCHEMA_SELECTIONS = 500

export interface PersistedSchemaSelectionEntry {
  schema: string
  updatedAt: number
}

export interface HostConfigBackupPayload {
  updatedAt?: number
  connections?: ConnectionProfile[]
  folderOrder?: string[]
  byodConfigs?: PersistedLocalDriverConfig[]
  savedQueries?: SavedQueryEntry[]
  panelViewState?: Record<string, unknown>
  studioViewState?: Record<string, unknown>
  tableDisplayState?: Record<string, TableDisplayStateEntry>
  erLayoutState?: Record<string, ErLayoutStateEntry>
  selectedSchemaByConn?: Record<string, PersistedSchemaSelectionEntry>
  consumedNavTokens?: string[]
}

const inMemoryUiSessionSnapshots = new Map<
  'panel' | 'studio',
  {
    viewState: Record<string, unknown> | null
    dataCache: Record<string, unknown> | null
    updatedAt: number
  }
>()
let inMemorySelectedSchemaByConn: Record<string, PersistedSchemaSelectionEntry> | null = null
const selectedSchemaStoreQueue = createSerializedQueue()

export function clearInMemoryUiSessionSnapshots(): void {
  inMemoryUiSessionSnapshots.clear()
  inMemorySelectedSchemaByConn = null
}

export function sanitizePersistedSchemaSelections(
  raw: unknown
): Record<string, PersistedSchemaSelectionEntry> {
  const out: Record<string, PersistedSchemaSelectionEntry> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  let count = 0
  for (const [k, v] of Object.entries(raw)) {
    const cleanConn = typeof k === 'string' ? k.trim() : ''
    if (!cleanConn) continue
    if (typeof v === 'string') {
      const cleanSchema = v.trim()
      if (cleanSchema.length > 0) {
        out[cleanConn] = { schema: cleanSchema, updatedAt: 0 }
        if (++count >= MAX_PERSISTED_SCHEMA_SELECTIONS) break
      }
      continue
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const rec = v as { schema?: unknown; updatedAt?: unknown }
      const cleanSchema = typeof rec.schema === 'string' ? rec.schema.trim() : ''
      if (!cleanSchema) continue
      const updatedAt =
        typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) && rec.updatedAt >= 0
          ? rec.updatedAt
          : 0
      out[cleanConn] = { schema: cleanSchema, updatedAt }
      if (++count >= MAX_PERSISTED_SCHEMA_SELECTIONS) break
    }
  }
  return out
}

export async function readPersistedSelectedSchemas(
  orca: Pick<OrcaWorkerApi, 'storage'> & Partial<Pick<OrcaWorkerApi, 'host'>>
): Promise<Record<string, PersistedSchemaSelectionEntry>> {
  if (inMemorySelectedSchemaByConn) {
    const copy: Record<string, PersistedSchemaSelectionEntry> = {}
    for (const [cid, entry] of Object.entries(inMemorySelectedSchemaByConn)) {
      copy[cid] = { ...entry }
    }
    return copy
  }
  let loaded: Record<string, PersistedSchemaSelectionEntry> = {}
  try {
    const raw = await orca.storage.get(SELECTED_SCHEMA_BY_CONN_STORAGE_KEY)
    loaded = sanitizePersistedSchemaSelections(raw)
  } catch {
    // Ignore storage read failure
  }
  const isLiveDesktopHost =
    'host' in orca && Boolean(orca.host && typeof orca.host.call === 'function')
  if (Object.keys(loaded).length === 0 && isLiveDesktopHost) {
    const backup = await readHostConfigBackup()
    if (backup?.selectedSchemaByConn) {
      loaded = sanitizePersistedSchemaSelections(backup.selectedSchemaByConn)
    }
  }
  inMemorySelectedSchemaByConn = loaded
  const copy: Record<string, PersistedSchemaSelectionEntry> = {}
  for (const [cid, entry] of Object.entries(loaded)) {
    copy[cid] = { ...entry }
  }
  return copy
}

function stripConnectionSchemaFromViewStateObj(
  view: Record<string, unknown>,
  cleanConn: string
): { mutated: boolean; nextView: Record<string, unknown> } {
  const nextView: Record<string, unknown> = { ...view }
  let mutated = false
  if (
    nextView.selectedSchemaByConn &&
    typeof nextView.selectedSchemaByConn === 'object' &&
    !Array.isArray(nextView.selectedSchemaByConn)
  ) {
    const map = { ...(nextView.selectedSchemaByConn as Record<string, unknown>) }
    if (cleanConn in map) {
      delete map[cleanConn]
      nextView.selectedSchemaByConn = map
      mutated = true
    }
  }
  if (
    nextView.selectedSchemaUpdatedAtByConn &&
    typeof nextView.selectedSchemaUpdatedAtByConn === 'object' &&
    !Array.isArray(nextView.selectedSchemaUpdatedAtByConn)
  ) {
    const tsMap = { ...(nextView.selectedSchemaUpdatedAtByConn as Record<string, unknown>) }
    if (cleanConn in tsMap) {
      delete tsMap[cleanConn]
      nextView.selectedSchemaUpdatedAtByConn = tsMap
      mutated = true
    }
  }
  if (nextView.activeConnectionId === cleanConn) {
    if ('selectedSchema' in nextView) {
      delete nextView.selectedSchema
      mutated = true
    }
    if ('activeSchema' in nextView) {
      delete nextView.activeSchema
      mutated = true
    }
    if ('activeTable' in nextView) {
      delete nextView.activeTable
      mutated = true
    }
  }
  return { mutated, nextView }
}

async function mergePersistedSelectedSchemas(
  orca: Pick<OrcaWorkerApi, 'storage'> & Partial<Pick<OrcaWorkerApi, 'host'>>,
  viewState: Record<string, unknown>
): Promise<void> {
  const rawMap =
    viewState.selectedSchemaByConn &&
    typeof viewState.selectedSchemaByConn === 'object' &&
    !Array.isArray(viewState.selectedSchemaByConn)
      ? (viewState.selectedSchemaByConn as Record<string, unknown>)
      : null
  const rawTsMap =
    viewState.selectedSchemaUpdatedAtByConn &&
    typeof viewState.selectedSchemaUpdatedAtByConn === 'object' &&
    !Array.isArray(viewState.selectedSchemaUpdatedAtByConn)
      ? (viewState.selectedSchemaUpdatedAtByConn as Record<string, unknown>)
      : null
  const fallbackConn =
    typeof viewState.activeConnectionId === 'string' ? viewState.activeConnectionId.trim() : ''
  const fallbackSchema =
    typeof viewState.selectedSchema === 'string'
      ? viewState.selectedSchema.trim()
      : typeof viewState.activeSchema === 'string'
        ? viewState.activeSchema.trim()
        : ''
  const viewUpdatedAt =
    typeof viewState.updatedAt === 'number' &&
    Number.isFinite(viewState.updatedAt) &&
    viewState.updatedAt >= 0
      ? viewState.updatedAt
      : 0

  const candidates: Array<{ connId: string; schema: string; updatedAt: number }> = []
  if (rawMap) {
    for (const [k, v] of Object.entries(rawMap)) {
      const cleanConn = typeof k === 'string' ? k.trim() : ''
      const cleanSchema = typeof v === 'string' ? v.trim() : ''
      if (!cleanConn || !cleanSchema) continue
      const rawEntryTs = rawTsMap ? rawTsMap[cleanConn] : undefined
      const entryTs = rawTsMap
        ? typeof rawEntryTs === 'number' && Number.isFinite(rawEntryTs) && rawEntryTs >= 0
          ? rawEntryTs
          : 0
        : viewUpdatedAt
      candidates.push({ connId: cleanConn, schema: cleanSchema, updatedAt: entryTs })
    }
  } else if (fallbackConn && fallbackSchema) {
    candidates.push({ connId: fallbackConn, schema: fallbackSchema, updatedAt: viewUpdatedAt })
  }
  if (candidates.length === 0) return

  await selectedSchemaStoreQueue.run(async () => {
    const current = await readPersistedSelectedSchemas(orca)
    let changed = false
    for (const { connId, schema, updatedAt } of candidates) {
      const existing = current[connId]
      if (!existing || updatedAt > existing.updatedAt) {
        current[connId] = { schema, updatedAt }
        changed = true
      }
    }
    if (!changed) return
    const bounded = sanitizePersistedSchemaSelections(current)
    inMemorySelectedSchemaByConn = bounded
    try {
      await orca.storage.set(SELECTED_SCHEMA_BY_CONN_STORAGE_KEY, bounded as unknown as JsonValue)
    } catch {
      // Ignore storage write failure
    }
    const isLiveDesktopHost =
      'host' in orca && Boolean(orca.host && typeof orca.host.call === 'function')
    if (isLiveDesktopHost) {
      void writeHostConfigBackupPatch({ selectedSchemaByConn: bounded })
    }
  })
}

export async function clearPersistedSelectedSchema(
  orca: Pick<OrcaWorkerApi, 'storage'> & Partial<Pick<OrcaWorkerApi, 'host'>>,
  connectionId: string
): Promise<void> {
  const cleanConn = typeof connectionId === 'string' ? connectionId.trim() : ''
  if (!cleanConn) return
  const isLiveDesktopHost =
    'host' in orca && Boolean(orca.host && typeof orca.host.call === 'function')
  await selectedSchemaStoreQueue.run(async () => {
    const current = await readPersistedSelectedSchemas(orca)
    if (cleanConn in current) {
      delete current[cleanConn]
      inMemorySelectedSchemaByConn = current
      try {
        await orca.storage.set(SELECTED_SCHEMA_BY_CONN_STORAGE_KEY, current as unknown as JsonValue)
      } catch {
        // Ignore storage write failure
      }
      if (isLiveDesktopHost) {
        void writeHostConfigBackupPatch({ selectedSchemaByConn: current })
      }
    }

    const backupPatch: Partial<HostConfigBackupPayload> = {}
    for (const surface of ['panel', 'studio'] as const) {
      const mem = inMemoryUiSessionSnapshots.get(surface)
      if (mem?.viewState && typeof mem.viewState === 'object') {
        const cleanedMem = stripConnectionSchemaFromViewStateObj(mem.viewState, cleanConn)
        if (cleanedMem.mutated) {
          inMemoryUiSessionSnapshots.set(surface, {
            ...mem,
            viewState: cleanedMem.nextView,
          })
        }
      }
      const storageKey =
        surface === 'panel' ? 'datanoa.panelViewState' : 'datanoa.studioViewState'
      try {
        const stored = await orca.storage.get(storageKey)
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
          const cleanedStored = stripConnectionSchemaFromViewStateObj(
            stored as Record<string, unknown>,
            cleanConn
          )
          if (cleanedStored.mutated) {
            await orca.storage.set(storageKey, cleanedStored.nextView as JsonValue)
            if (surface === 'panel') backupPatch.panelViewState = cleanedStored.nextView
            else backupPatch.studioViewState = cleanedStored.nextView
          }
        }
      } catch {
        // Ignore storage update error
      }
    }
    if (isLiveDesktopHost && (backupPatch.panelViewState || backupPatch.studioViewState)) {
      void writeHostConfigBackupPatch(backupPatch)
    }
  })
}

function regexScrubUrlText(input: string): string {
  return scrubSensitiveText(input, { stripOpaqueFragment: true })
}

function scrubConnectionName(rawName: unknown): string {
  return scrubConnectionNameForStorage(rawName)
}

export function scrubCredentialsInText(raw: string): string {
  if (!raw) return ''
  return regexScrubUrlText(raw)
}

function extractWorkerErrorTlsContext(err: unknown): {
  rawCode?: unknown
  tlsCode?: string
  causeMessage?: string
} {
  if (!err || typeof err !== 'object') return {}
  const rec = err as { code?: unknown; cause?: unknown }
  const directCode = typeof rec.code === 'string' && rec.code.trim().length > 0 ? rec.code.trim() : undefined
  if (rec.cause && typeof rec.cause === 'object') {
    const causeRec = rec.cause as { code?: unknown; message?: unknown }
    const causeCode =
      typeof causeRec.code === 'string' && causeRec.code.trim().length > 0
        ? causeRec.code.trim()
        : undefined
    const causeMessage = typeof causeRec.message === 'string' ? causeRec.message : undefined
    return {
      rawCode: rec.code,
      tlsCode: directCode || causeCode,
      causeMessage,
    }
  }
  return { rawCode: rec.code, tlsCode: directCode }
}

export function formatActionableWorkerErrorMessage(rawMessage: string, err?: unknown): string {
  const scrubbed = scrubCredentialsInText(rawMessage)
  const ctx = extractWorkerErrorTlsContext(err)
  const direct = appendActionableTlsErrorHint(scrubbed, ctx.tlsCode)
  if (direct !== scrubbed || !ctx.causeMessage) {
    return direct
  }
  const causeCheck = appendActionableTlsErrorHint(ctx.causeMessage, ctx.tlsCode)
  if (causeCheck !== ctx.causeMessage && !scrubbed.includes(ACTIONABLE_TLS_CERT_ERROR_HINT)) {
    return `${scrubbed.trimEnd()} — ${ACTIONABLE_TLS_CERT_ERROR_HINT}`
  }
  return scrubbed
}

function isSshHostKeyVerificationError(err: Error): boolean {
  const code = (err as Error & { code?: unknown }).code
  return err.name === 'SshHostKeyVerificationError' || code === 'SSH_HOST_KEY_VERIFICATION_FAILED'
}

export function scrubAndEnhanceWorkerError(err: unknown): unknown {
  if (err instanceof Error) {
    const rawMsg = err.message
    const nextMsg = formatActionableWorkerErrorMessage(rawMsg, err)
    if (isSshHostKeyVerificationError(err)) {
      if (nextMsg !== rawMsg) {
        try {
          err.message = nextMsg
        } catch {
          const clone = Object.create(Object.getPrototypeOf(err)) as Error & Record<string, unknown>
          Object.assign(clone, err)
          clone.message = nextMsg
          clone.name = err.name
          return clone
        }
      }
      return err
    }
    if (nextMsg === rawMsg) {
      return err
    }
    const sanitized = new Error(nextMsg)
    sanitized.name = err.name
    const rec = err as Error & {
      code?: unknown
      tlsFailure?: unknown
      sshChallenge?: unknown
    }
    const sanitizedRec = sanitized as Error & {
      code?: unknown
      tlsFailure?: unknown
      sshChallenge?: unknown
    }
    if (rec.code !== undefined) {
      sanitizedRec.code = rec.code
    }
    if (rec.tlsFailure !== undefined) {
      sanitizedRec.tlsFailure = rec.tlsFailure
    }
    if (rec.sshChallenge !== undefined) {
      sanitizedRec.sshChallenge = rec.sshChallenge
    }
    return copyFailedStatementMeta(err, sanitized)
  }
  if (err !== null && typeof err === 'object' && 'message' in err) {
    const obj = err as Record<string, unknown>
    return {
      ...obj,
      message: formatActionableWorkerErrorMessage(String(obj.message ?? ''), err),
    }
  }
  return formatActionableWorkerErrorMessage(String(err))
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
        if (isSensitiveUriParamKey(key)) {
          parsed.searchParams.delete(key)
          mutated = true
        }
      }
      if (parsed.hash.length > 1) {
        const cleanedHash = parsed.hash
          .slice(1)
          .split('&')
          .filter((pair) => {
            const eqIdx = pair.indexOf('=')
            if (eqIdx <= 0) return true
            const key = pair.slice(0, eqIdx)
            if (isSensitiveUriParamKey(key)) {
              mutated = true
              return false
            }
            return true
          })
          .join('&')
        if (mutated) {
          parsed.hash = cleanedHash ? `#${cleanedHash}` : ''
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

function hasSensitiveDraftOrFilterSql(value: string): boolean {
  try {
    if (detectRecognizableSqlCredential(value) !== null) {
      return true
    }
  } catch {
    // Ignore credential detector error
  }
  return containsSensitiveSqlText(value)
}

function scrubConsoleTabsObject(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw
  }
  const ct = { ...(raw as Record<string, unknown>) }
  if (Array.isArray(ct.tabs)) {
    ct.tabs = ct.tabs.map((tab) => {
      if (!tab || typeof tab !== 'object' || Array.isArray(tab)) return tab
      const rec = { ...(tab as Record<string, unknown>) }
      if (typeof rec.sql === 'string' && rec.sql.trim().length > 0) {
        if (hasSensitiveDraftOrFilterSql(rec.sql)) {
          rec.sql = ''
        }
      }
      return rec
    })
  }
  return ct
}

function scrubSshJumpHostDraftArray(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw
  return raw.map((hop) => {
    if (!hop || typeof hop !== 'object' || Array.isArray(hop)) return hop
    const rec = { ...(hop as Record<string, unknown>) }
    delete rec.password
    delete rec.passphrase
    delete rec.sshPassword
    delete rec.sshPassphrase
    delete rec.secret
    delete rec.token
    delete rec.authToken
    delete rec.sslKeyPassphrase
    return rec
  })
}

function normalizeSqlResultTemplateForStorage(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const rec = { ...(raw as Record<string, unknown>) }
  if (typeof rec.templateSql === 'string' && rec.templateSql.trim().length > 0) {
    const tmpl = rec.templateSql.trim()
    rec.sql = tmpl
    if (typeof rec.sqlPreview === 'string') {
      rec.sqlPreview = tmpl.replace(/\s+/g, ' ').slice(0, 120)
    }
  }
  if (Array.isArray(rec.resultSets)) {
    rec.resultSets = rec.resultSets.map((rs) => normalizeSqlResultTemplateForStorage(rs))
  }
  return rec
}

function stripSecretsFromViewState(
  viewState: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...viewState }
  delete out.sshJumpHopSecrets
  if (Array.isArray(out.sshJumpHosts)) {
    out.sshJumpHosts = scrubSshJumpHostDraftArray(out.sshJumpHosts)
  }
  if (typeof out.sqlDraft === 'string' && out.sqlDraft.trim().length > 0) {
    if (hasSensitiveDraftOrFilterSql(out.sqlDraft)) {
      out.sqlDraft = ''
    }
  }
  if (out.consoleTabs && typeof out.consoleTabs === 'object' && !Array.isArray(out.consoleTabs)) {
    out.consoleTabs = scrubConsoleTabsObject(out.consoleTabs)
  }
  if (
    out.consoleTabsState &&
    typeof out.consoleTabsState === 'object' &&
    !Array.isArray(out.consoleTabsState)
  ) {
    out.consoleTabsState = scrubConsoleTabsObject(out.consoleTabsState)
  }
  if (typeof out.whereClause === 'string' && out.whereClause.trim().length > 0) {
    if (hasSensitiveDraftOrFilterSql(out.whereClause)) {
      out.whereClause = ''
    }
  }
  if (typeof out.activeWhereClause === 'string' && out.activeWhereClause.trim().length > 0) {
    if (hasSensitiveDraftOrFilterSql(out.activeWhereClause)) {
      out.activeWhereClause = ''
    }
  }
  if (out.lastSqlResult && typeof out.lastSqlResult === 'object') {
    out.lastSqlResult = sanitizeSqlResultForStorage(
      normalizeSqlResultTemplateForStorage(out.lastSqlResult)
    )
  }
  if (out.formDraft && typeof out.formDraft === 'object' && !Array.isArray(out.formDraft)) {
    const draft = { ...(out.formDraft as Record<string, unknown>) }
    delete draft.uri
    delete draft.password
    delete draft.authToken
    delete draft.sshPassword
    delete draft.sshPassphrase
    delete draft.sslKeyPassphrase
    delete draft.sshJumpHopSecrets
    if (Array.isArray(draft.sshJumpHosts)) {
      draft.sshJumpHosts = scrubSshJumpHostDraftArray(draft.sshJumpHosts)
    }
    if (typeof draft.name === 'string') {
      draft.name = scrubConnectionNameForStorage(draft.name)
    }
    if (typeof draft.url === 'string') {
      draft.url = scrubSensitiveUrlDraft(draft.url)
    }
    if (typeof draft.options === 'string') {
      draft.options = scrubSensitiveUrlDraft(draft.options)
    }
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

function sanitizeUiDataCache(cache: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cache }
  if (typeof out.whereClause === 'string' && out.whereClause.trim().length > 0) {
    if (hasSensitiveDraftOrFilterSql(out.whereClause)) {
      out.whereClause = ''
    }
  }
  if (typeof out.activeWhereClause === 'string' && out.activeWhereClause.trim().length > 0) {
    if (hasSensitiveDraftOrFilterSql(out.activeWhereClause)) {
      out.activeWhereClause = ''
    }
  }
  if (out.lastSqlResult && typeof out.lastSqlResult === 'object') {
    out.lastSqlResult = sanitizeSqlResultForStorage(
      normalizeSqlResultTemplateForStorage(out.lastSqlResult)
    )
  }
  return out
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
    const mergedCache = sanitizeUiDataCache({ ...(prev.dataCache || {}), ...input.dataCache })
    const bounded = fitResponseWithinOrcaIpcLimit({ dataCache: mergedCache }) as {
      dataCache?: Record<string, unknown> | null
    }
    nextDataCache = bounded.dataCache ?? null
  }
  const updatedAt = Date.now()
  inMemoryUiSessionSnapshots.set(surface, {
    viewState: nextViewState,
    dataCache: nextDataCache,
    updatedAt,
  })

  if (nextViewState) {
    await mergePersistedSelectedSchemas(orca, nextViewState)
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

function reconcileViewStateWithPersistedSchemas(
  baseView: Record<string, unknown> | null,
  sharedMap: Record<string, PersistedSchemaSelectionEntry>
): Record<string, unknown> | null {
  if (Object.keys(sharedMap).length === 0) {
    return baseView
  }
  const nextView: Record<string, unknown> = baseView ? { ...baseView } : {}
  const rawMap =
    nextView.selectedSchemaByConn &&
    typeof nextView.selectedSchemaByConn === 'object' &&
    !Array.isArray(nextView.selectedSchemaByConn)
      ? (nextView.selectedSchemaByConn as Record<string, unknown>)
      : {}
  const mergedSchemas: Record<string, string> = {}
  for (const [k, v] of Object.entries(rawMap)) {
    if (typeof k === 'string' && k.trim() && typeof v === 'string' && v.trim()) {
      mergedSchemas[k.trim()] = v.trim()
    }
  }
  const hasTsMap =
    nextView.selectedSchemaUpdatedAtByConn !== undefined &&
    nextView.selectedSchemaUpdatedAtByConn !== null &&
    typeof nextView.selectedSchemaUpdatedAtByConn === 'object' &&
    !Array.isArray(nextView.selectedSchemaUpdatedAtByConn)
  const rawTsMap = hasTsMap
    ? (nextView.selectedSchemaUpdatedAtByConn as Record<string, unknown>)
    : {}
  const mergedTs: Record<string, number> = {}
  const viewBaseTs =
    typeof nextView.updatedAt === 'number' &&
    Number.isFinite(nextView.updatedAt) &&
    nextView.updatedAt >= 0
      ? nextView.updatedAt
      : 0
  for (const cid of Object.keys(mergedSchemas)) {
    const ts = hasTsMap ? rawTsMap[cid] : viewBaseTs
    mergedTs[cid] = typeof ts === 'number' && Number.isFinite(ts) && ts >= 0 ? ts : 0
  }

  const activeConn =
    typeof nextView.activeConnectionId === 'string' ? nextView.activeConnectionId.trim() : ''
  let maxAppliedTs = viewBaseTs
  let upgraded = false
  for (const [cid, entry] of Object.entries(sharedMap)) {
    const existingTs = cid in mergedSchemas ? (mergedTs[cid] ?? 0) : -1
    if (!(cid in mergedSchemas) || entry.updatedAt > existingTs) {
      const prevSchema = mergedSchemas[cid]
      mergedSchemas[cid] = entry.schema
      mergedTs[cid] = entry.updatedAt
      if (entry.updatedAt > maxAppliedTs) maxAppliedTs = entry.updatedAt
      upgraded = true
      if (activeConn && cid === activeConn && prevSchema !== entry.schema) {
        nextView.selectedSchema = entry.schema
        nextView.activeSchema = entry.schema
        nextView.activeTable = null
      }
    }
  }
  nextView.selectedSchemaByConn = mergedSchemas
  nextView.selectedSchemaUpdatedAtByConn = mergedTs
  if (upgraded || !('updatedAt' in nextView)) {
    nextView.updatedAt = maxAppliedTs
  }
  return nextView
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
  let baseView: Record<string, unknown> | null = mem?.viewState ?? null
  if (!mem || (!mem.viewState && !mem.dataCache)) {
    const storageKey =
      surface === 'panel' ? 'datanoa.panelViewState' : 'datanoa.studioViewState'
    try {
      const raw = await orca.storage.get(storageKey)
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        baseView = stripSecretsFromViewState(raw as Record<string, unknown>)
      }
    } catch {
      // Ignore storage read failure
    }
    const isLiveDesktopHost = Boolean(orca.host && typeof orca.host.call === 'function')
    if (!baseView && isLiveDesktopHost) {
      const backup = await readHostConfigBackup()
      const fromBackup =
        surface === 'panel' ? backup?.panelViewState : backup?.studioViewState
      if (fromBackup && typeof fromBackup === 'object' && !Array.isArray(fromBackup)) {
        baseView = stripSecretsFromViewState(fromBackup)
      }
    }
  }

  const sharedMap = await readPersistedSelectedSchemas(orca)
  const reconciledView = reconcileViewStateWithPersistedSchemas(baseView, sharedMap)
  const viewTs =
    reconciledView &&
    typeof reconciledView.updatedAt === 'number' &&
    Number.isFinite(reconciledView.updatedAt) &&
    reconciledView.updatedAt >= 0
      ? reconciledView.updatedAt
      : 0
  const snapshot = {
    viewState: reconciledView,
    dataCache: mem?.dataCache ?? null,
    updatedAt: Math.max(mem?.updatedAt ?? 0, viewTs),
  }
  if (reconciledView) {
    inMemoryUiSessionSnapshots.set(surface, snapshot)
  }
  return snapshot
}

function getHostBackupFilePath(): string {
  return path.join(os.homedir(), '.datanoa', 'workspace-backup.json')
}

const MAX_HOST_BACKUP_BYTES = 2 * 1024 * 1024 // 2 MiB

export async function readHostConfigBackup(): Promise<HostConfigBackupPayload | null> {
  try {
    const filePath = getHostBackupFilePath()
    const stat = await fs.promises.lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_HOST_BACKUP_BYTES) {
      return null
    }
    const raw = await fs.promises.readFile(filePath, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_HOST_BACKUP_BYTES) {
      return null
    }
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const payload: HostConfigBackupPayload = { ...(parsed as HostConfigBackupPayload) }
    if ('folderOrder' in payload) {
      if (Array.isArray(payload.folderOrder)) {
        payload.folderOrder = normalizeFolderOrder(payload.folderOrder)
      } else {
        delete payload.folderOrder
      }
    }
    if ('tableDisplayState' in payload) {
      if (
        !payload.tableDisplayState ||
        typeof payload.tableDisplayState !== 'object' ||
        Array.isArray(payload.tableDisplayState)
      ) {
        delete payload.tableDisplayState
      }
    }
    if ('erLayoutState' in payload) {
      if (
        !payload.erLayoutState ||
        typeof payload.erLayoutState !== 'object' ||
        Array.isArray(payload.erLayoutState)
      ) {
        delete payload.erLayoutState
      }
    }
    if ('selectedSchemaByConn' in payload) {
      if (
        payload.selectedSchemaByConn &&
        typeof payload.selectedSchemaByConn === 'object' &&
        !Array.isArray(payload.selectedSchemaByConn)
      ) {
        payload.selectedSchemaByConn = sanitizePersistedSchemaSelections(payload.selectedSchemaByConn)
      } else {
        delete payload.selectedSchemaByConn
      }
    }
    if ('consumedNavTokens' in payload) {
      if (Array.isArray(payload.consumedNavTokens)) {
        payload.consumedNavTokens = payload.consumedNavTokens
          .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          .slice(-MAX_CONSUMED_NAV_TOKENS)
      } else {
        delete payload.consumedNavTokens
      }
    }
    return payload
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
      let dirExists = false
      try {
        const dirStat = await fs.promises.lstat(dir)
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
          return
        }
        dirExists = true
      } catch (err: unknown) {
        const code =
          err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : ''
        if (code !== 'ENOENT') return
      }
      if (!dirExists) {
        await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
        const dirStatAfter = await fs.promises.lstat(dir)
        if (dirStatAfter.isSymbolicLink() || !dirStatAfter.isDirectory()) {
          return
        }
      }
      try {
        const targetStat = await fs.promises.lstat(filePath)
        if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
          return
        }
      } catch (err: unknown) {
        const code =
          err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : ''
        if (code !== 'ENOENT') return
      }
      const existing = (await readHostConfigBackup()) ?? {}
      const sanitizedPatch: Partial<HostConfigBackupPayload> =
        patch.folderOrder !== undefined
          ? { ...patch, folderOrder: normalizeFolderOrder(patch.folderOrder) }
          : patch
      const merged: HostConfigBackupPayload = sanitizeJsonPayload({
        ...existing,
        ...sanitizedPatch,
        updatedAt: Date.now(),
      })
      const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${++hostBackupTmpSeq}`
      await fs.promises.writeFile(tmpPath, JSON.stringify(merged, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
      let renamed = false
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          try {
            const latestTargetStat = await fs.promises.lstat(filePath)
            if (latestTargetStat.isSymbolicLink() || !latestTargetStat.isFile()) {
              break
            }
          } catch (err: unknown) {
            const code =
              err && typeof err === 'object' && 'code' in err
                ? String((err as { code?: unknown }).code)
                : ''
            if (code !== 'ENOENT') break
          }
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
      duckdb: path.join(baseDir, 'duckdb'),
      snowflake: path.join(baseDir, 'snowflake'),
      bigquery: path.join(baseDir, 'bigquery'),
      cassandra: path.join(baseDir, 'cassandra'),
      elasticsearch: path.join(baseDir, 'elasticsearch'),
      neo4j: path.join(baseDir, 'neo4j'),
      custom: path.join(baseDir, 'custom'),
    },
    templates: {
      duckdb: getCanonicalByodStarterCode('duckdb'),
      snowflake: getCanonicalByodStarterCode('snowflake'),
      bigquery: getCanonicalByodStarterCode('bigquery'),
      cassandra: getCanonicalByodStarterCode('cassandra'),
      elasticsearch: getCanonicalByodStarterCode('elasticsearch'),
      neo4j: getCanonicalByodStarterCode('neo4j'),
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
  duckdb: '@duckdb/node-api',
  snowflake: 'snowflake-sdk',
  bigquery: '@google-cloud/bigquery',
  cassandra: 'cassandra-driver',
  elasticsearch: '@elastic/elasticsearch',
  neo4j: 'neo4j-driver',
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
  if (!rawDir || CONTROL_CHARS_RE.test(rawDir)) {
    throw createHostError('invalid_params', 'Target folder path is required and must not contain control characters')
  }
  const isExplicitFile = /[/\\][^/\\]+\.(?:mjs|cjs|js)$/i.test(rawDir)
  const dirPath = isExplicitFile ? path.dirname(path.resolve(rawDir)) : path.resolve(rawDir)
  if (isBlockedScanRoot(dirPath)) {
    throw createHostError('not_permitted', `Refusing to scaffold BYOD driver directly in system/home root: ${dirPath}`)
  }
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
  let end = Math.max(0, maxBytes)
  // Step back over UTF-8 continuation bytes (10xxxxxx)
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1
  }
  // If end landed on a multi-byte lead byte whose sequence overflows maxBytes, drop it too
  if (end > 0) {
    let lead = end - 1
    while (lead > 0 && (buf[lead] & 0xc0) === 0x80) {
      lead -= 1
    }
    const leadByte = buf[lead]
    const seqLen =
      leadByte < 0x80
        ? 1
        : (leadByte & 0xe0) === 0xc0
          ? 2
          : (leadByte & 0xf0) === 0xe0
            ? 3
            : (leadByte & 0xf8) === 0xf0
              ? 4
              : 1
    if (lead + seqLen > end) {
      end = lead
    }
  }
  return buf.subarray(0, end).toString('utf8')
}

function sliceUtf16Safe(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  let cut = maxChars
  // Never split a UTF-16 surrogate pair (high surrogate 0xD800..0xDBFF at cut - 1)
  const code = text.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) {
    cut -= 1
  }
  return text.slice(0, cut)
}

function compactCellValue(value: unknown, maxChars: number): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    if (value.length > maxChars) {
      const prefix = sliceUtf16Safe(value, maxChars)
      return {
        value: `${prefix}… [+${value.length - prefix.length} chars]`,
        changed: true,
      }
    }
    return { value, changed: false }
  }
  if (value !== null && typeof value === 'object') {
    try {
      const json = JSON.stringify(value)
      if (json && json.length > maxChars) {
        const prefix = sliceUtf16Safe(json, maxChars)
        return {
          value: `${prefix}… [+${json.length - prefix.length} chars]`,
          changed: true,
        }
      }
    } catch {
      // Keep original value if non-serializable
    }
  }
  return { value, changed: false }
}

function compactRowsStrings(
  rows: unknown[],
  maxChars: number,
  exemptNames?: ReadonlySet<string>,
  exemptIndices?: ReadonlySet<number>
): { rows: unknown[]; anyChanged: boolean } {
  let anyChanged = false
  const out = rows.map((row) => {
    if (Array.isArray(row)) {
      let changed = false
      const nextRow = row.map((cell, idx) => {
        if (exemptIndices?.has(idx)) return cell
        const compacted = compactCellValue(cell, maxChars)
        if (compacted.changed) {
          changed = true
          anyChanged = true
        }
        return compacted.value
      })
      return changed ? nextRow : row
    }
    if (row && typeof row === 'object') {
      const rec = row as Record<string, unknown>
      let changed = false
      const nextObj: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(rec)) {
        if (exemptNames?.has(k)) {
          nextObj[k] = v
          continue
        }
        const compacted = compactCellValue(v, maxChars)
        if (compacted.changed) {
          changed = true
          anyChanged = true
        }
        nextObj[k] = compacted.value
      }
      return changed ? nextObj : row
    }
    return row
  })
  return { rows: out, anyChanged }
}

function resolvePrimaryKeyExemptions(rec: Record<string, unknown>): {
  exemptNames?: ReadonlySet<string>
  exemptIndices?: ReadonlySet<number>
} {
  if (!Array.isArray(rec.primaryKey) || rec.primaryKey.length === 0) return {}
  const names = new Set<string>()
  for (const pk of rec.primaryKey) {
    if (typeof pk === 'string' && pk.length > 0) names.add(pk)
  }
  if (names.size === 0) return {}
  let indices: Set<number> | undefined
  if (Array.isArray(rec.columns)) {
    indices = new Set<number>()
    rec.columns.forEach((col, idx) => {
      const colName =
        typeof col === 'string'
          ? col
          : col && typeof col === 'object' && typeof (col as { name?: unknown }).name === 'string'
            ? (col as { name: string }).name
            : ''
      if (colName && names.has(colName)) indices?.add(idx)
    })
  }
  return { exemptNames: names, exemptIndices: indices }
}

export function measureJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function shrinkDdlFieldToFit(rec: Record<string, unknown>, maxBytes: number): boolean {
  if (typeof rec.ddl !== 'string' || rec.ddl.length === 0) return false
  const suffix = '\n-- [Truncated to fit 1 MiB Orca IPC response limit]\n'
  const origDdl = rec.ddl
  let targetBytes = Math.min(Buffer.byteLength(origDdl, 'utf8'), Math.max(1024, maxBytes - 130_000))
  for (let i = 0; i < 8 && targetBytes > 0; i++) {
    rec.ddl = `${truncateUtf8String(origDdl, targetBytes)}${suffix}`
    const curBytes = measureJsonBytes(rec)
    if (curBytes <= maxBytes) return true
    const ratio = maxBytes / curBytes
    targetBytes = Math.max(0, Math.floor(targetBytes * ratio * 0.85))
  }
  rec.ddl = '-- [DDL truncated to fit 1 MiB Orca IPC response limit]\n'
  return measureJsonBytes(rec) <= maxBytes
}

function clampViewStateToFit(rec: Record<string, unknown>, maxBytes: number): void {
  if (!rec.viewState || typeof rec.viewState !== 'object' || Array.isArray(rec.viewState)) return
  const vs = { ...(rec.viewState as Record<string, unknown>) }
  if (typeof vs.sqlDraft === 'string' && vs.sqlDraft.length > 8000) {
    vs.sqlDraft = sliceUtf16Safe(vs.sqlDraft, 8000)
  }
  if (vs.consoleTabs && typeof vs.consoleTabs === 'object' && !Array.isArray(vs.consoleTabs)) {
    const ct = { ...(vs.consoleTabs as Record<string, unknown>) }
    if (Array.isArray(ct.tabs)) {
      ct.tabs = ct.tabs.slice(0, 8).map((tab) => {
        if (!tab || typeof tab !== 'object' || Array.isArray(tab)) return tab
        const tRec = { ...(tab as Record<string, unknown>) }
        if (typeof tRec.sql === 'string' && tRec.sql.length > 4000) {
          tRec.sql = sliceUtf16Safe(tRec.sql, 4000)
        }
        return tRec
      })
    }
    vs.consoleTabs = ct
  }
  rec.viewState = vs
  if (measureJsonBytes(rec) > maxBytes) {
    delete vs.sqlDraft
    delete vs.consoleTabs
    delete vs.columnConfigByTable
    rec.viewState = vs
  }
  if (measureJsonBytes(rec) > maxBytes) {
    rec.viewState = null
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const V2_TABLE_KEY_COMPONENT_RE = /[:%|]|^\s|\s$/

export function buildInjectiveTableDisplayKey(
  connectionId: string,
  schema: string | undefined,
  table: string
): string {
  const rawConn = connectionId == null ? '' : String(connectionId)
  const conn = rawConn.trim().length > 0 ? rawConn : 'none'
  const sch = schema == null ? '' : String(schema)
  const tbl = table == null ? '' : String(table)
  if (
    conn === 'v2' ||
    V2_TABLE_KEY_COMPONENT_RE.test(conn) ||
    V2_TABLE_KEY_COMPONENT_RE.test(sch) ||
    V2_TABLE_KEY_COMPONENT_RE.test(tbl)
  ) {
    return `v2:${encodeURIComponent(conn)}:${encodeURIComponent(sch)}:${encodeURIComponent(tbl)}`
  }
  return `${conn}:${sch}:${tbl}`
}

function safeDecodeUriComponent(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

export function normalizeMigratedTableDisplayKey(rawKey: string): string {
  const raw = rawKey == null ? '' : String(rawKey)
  if (!raw) return raw
  if (raw.startsWith('v2:')) {
    const parts = raw.slice(3).split(':')
    if (parts.length === 3) {
      return buildInjectiveTableDisplayKey(
        safeDecodeUriComponent(parts[0]),
        safeDecodeUriComponent(parts[1]),
        safeDecodeUriComponent(parts[2])
      )
    }
  }
  const firstColon = raw.indexOf(':')
  if (firstColon < 0) return raw
  const secondColon = raw.indexOf(':', firstColon + 1)
  if (secondColon < 0) return raw
  return buildInjectiveTableDisplayKey(
    raw.slice(0, firstColon),
    raw.slice(firstColon + 1, secondColon),
    raw.slice(secondColon + 1)
  )
}

export function belongsToConnectionKey(key: string, connectionId: string): boolean {
  if (!key || !connectionId) return false
  if (key.startsWith('v2:')) {
    const secondColon = key.indexOf(':', 3)
    if (secondColon <= 3) return false
    const rawConn = key.slice(3, secondColon)
    if (rawConn === encodeURIComponent(connectionId)) return true
    try {
      return decodeURIComponent(rawConn) === connectionId
    } catch {
      // Ignore malformed percent-encoding
      return false
    }
  }
  return key === connectionId || key.startsWith(`${connectionId}:`)
}

const DEFAULT_LATEST_WINS_DEBOUNCE_MS = 120

/**
 * Coalescing async persistence writer ensuring only the latest snapshot wins and
 * burst resize/reorder writes settle cleanly before shutdown (`flush()`).
 */
export class LatestWinsWriter {
  private readonly debounceMs: number
  private readonly persistFn: () => Promise<void>
  private readonly canPersist?: () => boolean
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  private inFlight: Promise<void> | null = null
  private disposed = false

  constructor(
    persistFn: () => Promise<void>,
    debounceMs = DEFAULT_LATEST_WINS_DEBOUNCE_MS,
    canPersist?: () => boolean
  ) {
    this.persistFn = persistFn
    this.debounceMs = Math.max(0, debounceMs)
    this.canPersist = canPersist
  }

  schedule(): void {
    if (this.disposed) return
    this.dirty = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
    }, this.debounceMs)
    if (typeof this.timer.unref === 'function') {
      this.timer.unref()
    }
  }

  pauseTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async drain(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight
      if (this.dirty && !this.disposed && (!this.canPersist || this.canPersist())) {
        return await this.drain()
      }
      return
    }
    while (this.dirty && !this.disposed) {
      if (this.canPersist && !this.canPersist()) {
        break
      }
      this.dirty = false
      const run = this.persistFn().catch(() => {})
      this.inFlight = run
      try {
        await run
      } finally {
        this.inFlight = null
      }
    }
  }

  async flush(): Promise<void> {
    this.pauseTimer()
    await this.drain()
  }

  dispose(): void {
    this.disposed = true
    this.dirty = false
    this.pauseTimer()
  }
}

function pruneExplainNodeToDepth(
  node: unknown,
  maxDepth: number,
  maxChildren: number,
  stripDetails: boolean,
  depth = 0
): Record<string, unknown> | null {
  if (!isPlainRecord(node)) return null
  const out: Record<string, unknown> = { ...node }
  if (stripDetails) {
    delete out.details
  }
  const rawChildren = Array.isArray(out.children) ? out.children : []
  if (depth >= maxDepth) {
    out.children = []
    return out
  }
  // Prioritize nodes carrying critical/high severity or warnings before truncation
  const prioritized = rawChildren
    .filter(isPlainRecord)
    .sort((a, b) => {
      const aHot =
        a.severity === 'critical' ||
        a.severity === 'high' ||
        (Array.isArray(a.warnings) && a.warnings.length > 0)
      const bHot =
        b.severity === 'critical' ||
        b.severity === 'high' ||
        (Array.isArray(b.warnings) && b.warnings.length > 0)
      return aHot === bHot ? 0 : aHot ? -1 : 1
    })
    .slice(0, maxChildren)
    .map((child) => pruneExplainNodeToDepth(child, maxDepth, maxChildren, stripDetails, depth + 1))
    .filter((child): child is Record<string, unknown> => child !== null)
  out.children = prioritized
  return out
}

function compactExplainPlanInRecord(
  container: Record<string, unknown>,
  maxBytes: number
): boolean {
  if (!isPlainRecord(container.explainPlan)) return false
  let plan: Record<string, unknown> = { ...container.explainPlan }
  if (typeof plan.rawText === 'string' && plan.rawText.length > 4096) {
    plan.rawText = `${sliceUtf16Safe(plan.rawText, 4096)}\n-- [Truncated]`
    plan.truncated = true
  }
  container.explainPlan = plan
  if (measureJsonBytes(container) <= maxBytes) return true

  delete plan.rawText
  plan.truncated = true
  container.explainPlan = plan
  if (measureJsonBytes(container) <= maxBytes) return true

  const steps: Array<{ maxDepth: number; maxChildren: number; stripDetails: boolean }> = [
    { maxDepth: 12, maxChildren: 16, stripDetails: true },
    { maxDepth: 6, maxChildren: 8, stripDetails: true },
    { maxDepth: 3, maxChildren: 4, stripDetails: true },
    { maxDepth: 1, maxChildren: 2, stripDetails: true },
  ]
  for (const step of steps) {
    if (plan.root) {
      plan = {
        ...plan,
        root: pruneExplainNodeToDepth(
          plan.root,
          step.maxDepth,
          step.maxChildren,
          step.stripDetails
        ),
        truncated: true,
      }
      container.explainPlan = plan
      if (measureJsonBytes(container) <= maxBytes) return true
    }
  }

  plan = { ...plan, root: null, missingIndexes: undefined, truncated: true }
  container.explainPlan = plan
  return measureJsonBytes(container) <= maxBytes
}

function compactSchemaErGraphToFit(rec: Record<string, unknown>, maxBytes: number): boolean {
  if (!Array.isArray(rec.nodes) || !Array.isArray(rec.edges)) return false
  const origNodes = rec.nodes.filter(isPlainRecord)
  const origEdges = rec.edges.filter(isPlainRecord)
  if (typeof rec.totalTableCount !== 'number') {
    rec.totalTableCount = origNodes.length
  }

  // Pass 1: drop uniqueColumnSets and trim non-PK/non-FK columns from nodes
  rec.nodes = origNodes.map((node) => {
    const cols = Array.isArray(node.columns) ? node.columns.filter(isPlainRecord) : []
    const keyCols = cols.filter((c) => Boolean(c.isPrimaryKey) || Boolean(c.isForeignKey))
    const keptCols = (keyCols.length > 0 ? keyCols : cols.slice(0, 8)).slice(0, 16)
    const nextNode: Record<string, unknown> = {
      ...node,
      columns: keptCols,
    }
    delete nextNode.uniqueColumnSets
    return nextNode
  })
  rec.truncated = true
  if (measureJsonBytes(rec) <= maxBytes) return true

  // Pass 2: trim nodes proportionally and drop edges whose endpoints were pruned
  let keptNodes = rec.nodes as Record<string, unknown>[]
  while (keptNodes.length > 0 && measureJsonBytes(rec) > maxBytes) {
    const curBytes = measureJsonBytes(rec)
    const ratio = maxBytes / curBytes
    const nextLen = Math.max(
      0,
      Math.min(keptNodes.length - 1, Math.floor(keptNodes.length * ratio * 0.85))
    )
    keptNodes = keptNodes.slice(0, nextLen)
    const keptIds = new Set(
      keptNodes.map((n) => (typeof n.id === 'string' ? n.id : '')).filter(Boolean)
    )
    rec.nodes = keptNodes
    rec.edges = origEdges.filter(
      (e) =>
        typeof e.fromNodeId === 'string' &&
        typeof e.toNodeId === 'string' &&
        keptIds.has(e.fromNodeId) &&
        keptIds.has(e.toNodeId)
    )
    rec.truncated = true
  }
  return measureJsonBytes(rec) <= maxBytes
}

/**
 * Guarantees every worker RPC response stays safely below Orca's hard 1 MiB (1,048,576-byte)
 * IPC response limit so wide tables (e.g. chrome_profile with large JSON/cookie columns),
 * large DDL exports, top-level arrays, ER graphs, EXPLAIN plans, or session snapshots never fail
 * with "<method> answered with more than 1 MiB".
 */
function compactValueGeneric(val: unknown, maxStrChars: number, maxArrItems: number): unknown {
  if (typeof val === 'string') {
    return val.length > maxStrChars ? `${sliceUtf16Safe(val, maxStrChars)}...` : val
  }
  if (Array.isArray(val)) {
    return val.slice(0, maxArrItems).map((item) => compactValueGeneric(item, maxStrChars, maxArrItems))
  }
  if (isPlainRecord(val)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(val)) {
      out[k] = compactValueGeneric(v, maxStrChars, maxArrItems)
    }
    return out
  }
  return val
}

function finalizeRecordWithinIpcLimit<T>(rec: Record<string, unknown>, maxBytes: number): T {
  if (measureJsonBytes(rec) <= maxBytes) {
    return rec as T
  }
  const tiers: Array<[number, number]> = [
    [4096, 64],
    [1024, 16],
    [256, 4],
    [64, 0],
  ]
  let current: Record<string, unknown> = { ...rec }
  for (const [maxStr, maxArr] of tiers) {
    current = compactValueGeneric(current, maxStr, maxArr) as Record<string, unknown>
    current.truncated = true
    if (measureJsonBytes(current) <= maxBytes) {
      return current as T
    }
  }
  // Drop largest keys iteratively until under maxBytes
  const keysBySize = Object.keys(current).sort(
    (a, b) => measureJsonBytes(current[b]) - measureJsonBytes(current[a])
  )
  for (const key of keysBySize) {
    if (key === 'truncated') continue
    delete current[key]
    if (measureJsonBytes(current) <= maxBytes) {
      return current as T
    }
  }
  const envelope = {
    ok: false,
    truncated: true,
    error: {
      code: 'IPC_PAYLOAD_TOO_LARGE',
      message: 'Response exceeded maximum IPC payload limit.',
    },
  }
  if (measureJsonBytes(envelope) <= maxBytes) {
    return envelope as unknown as T
  }
  const minimal = { truncated: true }
  if (measureJsonBytes(minimal) <= maxBytes) {
    return minimal as unknown as T
  }
  return {} as T
}

export function fitResponseWithinOrcaIpcLimit<T>(
  payload: T,
  maxBytes = MAX_ORCA_IPC_RESPONSE_BYTES
): T {
  let serialized: string
  try {
    serialized = JSON.stringify(payload)
  } catch {
    return payload
  }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') <= maxBytes) {
    return payload
  }
  if (typeof payload === 'string') {
    const budget = Math.max(0, maxBytes - 16)
    let end = Math.min(payload.length, budget)
    let sliced = sliceUtf16Safe(payload, end)
    while (sliced.length > 0 && measureJsonBytes(sliced) > maxBytes) {
      end = Math.floor(end * 0.8)
      sliced = sliceUtf16Safe(payload, end)
    }
    return sliced as unknown as T
  }
  if (!payload || typeof payload !== 'object') {
    return payload
  }

  // 0. Top-level array response (e.g. schema.listObjects / connections.list)
  if (Array.isArray(payload)) {
    let items = compactRowsStrings(payload, 512).rows
    for (;;) {
      const curBytes = measureJsonBytes(items)
      if (items.length === 0 || curBytes <= maxBytes) break
      const ratio = maxBytes / curBytes
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
        dc.pageData = fitResponseWithinOrcaIpcLimit(dc.pageData, maxBytes)
      }
      if (dc.lastSqlResult && typeof dc.lastSqlResult === 'object') {
        dc.lastSqlResult = fitResponseWithinOrcaIpcLimit(dc.lastSqlResult, maxBytes)
      }
      rec.dataCache = dc
      if (measureJsonBytes(rec) <= maxBytes) {
        return rec as T
      }
      delete dc.pageData
      delete dc.lastSqlResult
      rec.dataCache = dc
      if (measureJsonBytes(rec) <= maxBytes) {
        return rec as T
      }
      rec.dataCache = null
      if (measureJsonBytes(rec) <= maxBytes) {
        return rec as T
      }
    }
    clampViewStateToFit(rec, maxBytes)
    if (measureJsonBytes(rec) <= maxBytes) {
      return rec as T
    }
  }

  // 2. Large DDL string response (schema.exportSchemaDdl / schema.generateDdl / schema.tableDetails)
  if (typeof rec.ddl === 'string' && rec.ddl.length > 0) {
    if (shrinkDdlFieldToFit(rec, maxBytes)) {
      return rec as T
    }
  }

  // 2.5. List wrapper `{ entries: [...] }` (queries.saved.list / query.history.list)
  if (Array.isArray(rec.entries)) {
    let entries = compactRowsStrings(rec.entries as unknown[], 4096).rows
    rec.entries = entries
    if (measureJsonBytes(rec) <= maxBytes) {
      return rec as T
    }
    entries = compactRowsStrings(rec.entries as unknown[], 1024).rows
    rec.entries = entries
    for (;;) {
      const curBytes = measureJsonBytes(rec)
      if (entries.length === 0 || curBytes <= maxBytes) break
      const ratio = maxBytes / curBytes
      const nextLen = Math.max(0, Math.min(entries.length - 1, Math.floor(entries.length * ratio * 0.88)))
      entries = entries.slice(0, nextLen)
      rec.entries = entries
    }
    if (measureJsonBytes(rec) <= maxBytes) {
      return rec as T
    }
  }

  // 2.6. Catalog wrapper `{ data: [...] }` (schema.listObjectsCatalog)
  if (Array.isArray(rec.data)) {
    const pass1 = compactRowsStrings(rec.data as unknown[], 1024)
    rec.data = pass1.rows
    if (pass1.anyChanged) rec.truncated = true
    if (measureJsonBytes(rec) <= maxBytes) {
      return rec as T
    }
    const pass2 = compactRowsStrings(rec.data as unknown[], 512)
    let items = pass2.rows
    rec.data = items
    if (pass2.anyChanged) rec.truncated = true
    for (;;) {
      const curBytes = measureJsonBytes(rec)
      if (items.length === 0 || curBytes <= maxBytes) break
      const ratio = maxBytes / curBytes
      const nextLen = Math.max(0, Math.min(items.length - 1, Math.floor(items.length * ratio * 0.88)))
      items = items.slice(0, nextLen)
      rec.data = items
      rec.truncated = true
    }
    if (measureJsonBytes(rec) <= maxBytes) {
      return rec as T
    }
  }

  // 2.7. Schema ER graph (schema.erGraph)
  if (Array.isArray(rec.nodes) && Array.isArray(rec.edges)) {
    if (compactSchemaErGraphToFit(rec, maxBytes)) {
      return rec as T
    }
  }

  // 2.8. Compact standalone explainPlan when response has no tabular rows/resultSets
  if (!Array.isArray(rec.rows) && !Array.isArray(rec.resultSets) && isPlainRecord(rec.explainPlan)) {
    if (compactExplainPlanInRecord(rec, maxBytes)) {
      return rec as T
    }
  }

  // 3. Tabular rows & multi-resultSets response (data.fetchPage / query.run)
  if (Array.isArray(rec.rows) || Array.isArray(rec.resultSets)) {
    const origRows = Array.isArray(rec.rows) ? (rec.rows as unknown[]) : null
    const origResultSets = Array.isArray(rec.resultSets)
      ? (rec.resultSets as Array<Record<string, unknown>>)
      : null
    const { exemptNames, exemptIndices } = resolvePrimaryKeyExemptions(rec)
    const charTiers = [8192, 4096, 2048, 1024, 512, 256, 128, 64, 32]

    for (const maxChars of charTiers) {
      let compactedAny = false
      if (origRows) {
        const res = compactRowsStrings(origRows, maxChars, exemptNames, exemptIndices)
        rec.rows = res.rows
        if (res.anyChanged) compactedAny = true
      }
      if (origResultSets) {
        rec.resultSets = origResultSets.map((rs) => {
          if (rs && typeof rs === 'object' && Array.isArray(rs.rows)) {
            const rsExempt = resolvePrimaryKeyExemptions(rs)
            const res = compactRowsStrings(
              rs.rows as unknown[],
              maxChars,
              rsExempt.exemptNames,
              rsExempt.exemptIndices
            )
            if (res.anyChanged) {
              compactedAny = true
              return { ...rs, rows: res.rows, truncated: true }
            }
            return { ...rs, rows: res.rows }
          }
          return rs
        })
      }
      if (compactedAny) {
        rec.truncated = true
      }
      if (measureJsonBytes(rec) <= maxBytes) {
        return rec as T
      }
    }

    // 4. Clamp row counts across rec.rows and rec.resultSets until safely <= maxBytes
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
      const curBytes = measureJsonBytes(rec)
      if (curBytes <= maxBytes) break
      const ratio = maxBytes / curBytes

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
        if (!shrunkAny && measureJsonBytes(rec) > maxBytes) {
          compactedResultSets = []
          rec.resultSets = []
          break
        }
      }
    }
    if (measureJsonBytes(rec) > maxBytes && Array.isArray(rec.resultSets)) {
      rec.resultSets = (rec.resultSets as Array<Record<string, unknown>>).map((rs) => {
        if (!isPlainRecord(rs) || !isPlainRecord(rs.explainPlan)) return rs
        const copy = { ...rs }
        compactExplainPlanInRecord(copy, maxBytes)
        return copy
      })
    }
    if (measureJsonBytes(rec) > maxBytes && isPlainRecord(rec.explainPlan)) {
      compactExplainPlanInRecord(rec, maxBytes)
    }
    if (measureJsonBytes(rec) <= maxBytes) {
      return rec as T
    }
  }

  return finalizeRecordWithinIpcLimit<T>(rec, maxBytes)
}
