import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  ACTIVE_CONNECTION_STORAGE_KEY,
  type ConnectionProfile,
  type PersistedLocalDriverConfig,
} from '../protocol'
import { CUSTOM_DRIVERS_STORAGE_KEY } from '../shared-constants'
import { maskConnectionUriSecret } from '../shared-sql-safety.js'
import {
  isD1HttpLoopbackEndpoint,
  parseConnectionUri,
  SUPPORTED_DRIVERS,
  validateD1EndpointUrl,
  validateLibsqlEndpointUrl,
} from '../drivers/common/connection-uri'
import { getDefaultPortForDriver } from '../drivers/common/engine-catalog'
import { getByodDefaultPort, isByodDriverId, type DriverManager } from '../drivers/driver-manager'
import {
  detectWorkspaceEnvConnections,
  discoverWorkspaceSqliteFiles,
  formatByteSize,
  getLocalWorkspaceDirs,
  normalizePathForCompare,
  scanDirectoryForSqliteFiles,
  type DiscoveredSqliteFile,
} from './discovery'
import {
  detectDockerTargetLocality,
  detectWorkspaceDockerComposeConnections,
} from './docker-compose-discovery'
import type { WorkerSchemaMetadataCache } from './ai-sql-context'
import type { SessionManager } from './session-manager'
import {
  appendActionableTlsErrorHint,
  createHostError,
  createSerializedQueue,
  getDefaultByodDriverDirs,
  getUiSessionSnapshot,
  listDirectoryForPicker,
  listWorkspaceScopesForUi,
  normalizeSqliteProfile,
  readHostConfigBackup,
  sanitizeConnectionProfile,
  saveUiSessionSnapshot,
  scaffoldLocalDriverDirectory,
  scrubAndEnhanceWorkerError,
  scrubCredentialsInText,
  writeHostConfigBackupPatch,
  type WorkerRegisterHandler,
} from './worker-utils'

export interface ConnectionHandlersDeps {
  orca: OrcaWorkerApi
  registerHandler: WorkerRegisterHandler
  sessionManager: SessionManager
  driverManager: DriverManager
  schemaCache?: WorkerSchemaMetadataCache
}

export interface ConnectionHandlersController {
  clearDetectedCandidates: () => void
}

interface DetectedCandidateSecret {
  kind: 'env' | 'docker'
  rawUri?: string
  rawPassword?: string
  rawUrl?: string
  expiresAt: number
}

const DETECTED_CANDIDATE_TTL_MS = 15 * 60 * 1000
const DETECTED_CANDIDATE_MAX = 200

export type StoredSecretKind = 'db' | 'ssh' | 'sslKey'

function normalizeCanonicalHost(raw: string | undefined): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim().toLowerCase()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function normalizeCanonicalScheme(rawScheme: string, driver: string): string {
  const s = rawScheme.trim().toLowerCase()
  if (s === 'clickhouses:') return 'https:'
  if (s === 'clickhouse:') return 'http:'
  if (s === 'postgresql:' || s === 'postgres:') return 'postgres'
  if (s === 'cockroach:' || s === 'cockroachdb:') return 'cockroachdb'
  if (s === 'sqlserver:' || s === 'mssql:') return 'mssql'
  if (s === 'oracledb:' || s === 'oracle:') return 'oracle'
  if (s === 'mysql:') return 'mysql'
  if (s === 'mariadb:') return 'mariadb'
  if (s === 'mongodb:') return 'mongodb'
  if (s === 'redis:') return 'redis'
  return s || driver
}

interface CanonicalDbTarget {
  driver: string
  scheme: string
  host: string
  port: number
  filePath: string
  d1AccountId: string
  rawFallback: string
}

function resolveCanonicalDbTarget(profile: ConnectionProfile): CanonicalDbTarget | null {
  const driver = typeof profile.driver === 'string' ? profile.driver.trim().toLowerCase() : ''
  if (!driver) return null

  const defaultPort = isByodDriverId(driver)
    ? getByodDefaultPort(driver)
    : (SUPPORTED_DRIVERS as readonly string[]).includes(driver)
      ? getDefaultPortForDriver(driver as ConnectionProfile['driver'])
      : 0

  if (driver === 'sqlite' || driver === 'duckdb') {
    const rawFile = (profile.filePath || profile.database || '').trim()
    const filePath =
      rawFile.length === 0
        ? ''
        : rawFile === ':memory:'
          ? ':memory:'
          : normalizePathForCompare(path.resolve(rawFile))
    return {
      driver,
      scheme: 'file',
      host: '',
      port: 0,
      filePath,
      d1AccountId: '',
      rawFallback: '',
    }
  }

  if (driver === 'd1') {
    const rawUrl = typeof profile.url === 'string' ? profile.url.trim() : ''
    const d1AccountId = (profile.d1AccountId || '').trim()
    if (rawUrl) {
      try {
        const u = new URL(rawUrl)
        const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
        return {
          driver,
          scheme: u.protocol.toLowerCase(),
          host: normalizeCanonicalHost(u.hostname),
          port: Number.isInteger(port) && port > 0 ? port : 443,
          filePath: '',
          d1AccountId,
          rawFallback: u.pathname.replace(/\/+$/, ''),
        }
      } catch {
        return null
      }
    }
    return {
      driver,
      scheme: 'https:',
      host: 'api.cloudflare.com',
      port: 443,
      filePath: '',
      d1AccountId,
      rawFallback: '',
    }
  }

  if (driver === 'libsql') {
    const candidateUrl = resolveLibsqlEndpointCandidate(profile)
    if (!candidateUrl) {
      return {
        driver,
        scheme: profile.ssl === false ? 'http:' : 'https:',
        host: normalizeCanonicalHost(profile.host),
        port:
          typeof profile.port === 'number' && Number.isInteger(profile.port) && profile.port > 0
            ? profile.port
            : profile.ssl === false
              ? 80
              : 443,
        filePath: '',
        d1AccountId: '',
        rawFallback: '',
      }
    }
    try {
      const u = new URL(candidateUrl)
      const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
      return {
        driver,
        scheme: u.protocol.toLowerCase(),
        host: normalizeCanonicalHost(u.hostname),
        port: Number.isInteger(port) && port > 0 ? port : 443,
        filePath: '',
        d1AccountId: '',
        rawFallback: u.pathname.replace(/\/+$/, ''),
      }
    } catch {
      return null
    }
  }

  const rawUrl = typeof profile.url === 'string' ? profile.url.trim() : ''
  if (rawUrl) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawUrl)) {
      try {
        const u = new URL(rawUrl)
        const rawScheme = u.protocol.toLowerCase()
        const scheme = normalizeCanonicalScheme(rawScheme, driver)
        const fallbackPort =
          rawScheme === 'https:'
            ? 443
            : rawScheme === 'http:'
              ? 80
              : rawScheme === 'clickhouses:'
                ? 8443
                : defaultPort
        const parsedPort = u.port ? Number(u.port) : fallbackPort
        const schemeIdx = rawUrl.indexOf('://')
        const rest = rawUrl.slice(schemeIdx + 3)
        const delimIdx = rest.search(/[/?#]/)
        const rawAuth = delimIdx >= 0 ? rest.slice(0, delimIdx) : rest
        const atIdx = rawAuth.lastIndexOf('@')
        const hostList = (atIdx >= 0 ? rawAuth.slice(atIdx + 1) : rawAuth).toLowerCase()
        return {
          driver,
          scheme,
          host: hostList.includes(',') ? hostList : normalizeCanonicalHost(u.hostname),
          port: Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : fallbackPort,
          filePath: '',
          d1AccountId: '',
          rawFallback: '',
        }
      } catch {
        return {
          driver,
          scheme: 'raw',
          host: '',
          port: 0,
          filePath: '',
          d1AccountId: '',
          rawFallback: rawUrl.toLowerCase(),
        }
      }
    }
    return {
      driver,
      scheme: 'raw',
      host: normalizeCanonicalHost(profile.host),
      port:
        typeof profile.port === 'number' && Number.isInteger(profile.port) && profile.port > 0
          ? profile.port
          : defaultPort,
      filePath: '',
      d1AccountId: '',
      rawFallback: rawUrl.replace(/\s+/g, ' ').trim().toLowerCase(),
    }
  }

  const host = normalizeCanonicalHost(profile.host) || 'localhost'
  const port =
    typeof profile.port === 'number' && Number.isInteger(profile.port) && profile.port > 0
      ? profile.port
      : driver === 'clickhouse' && profile.ssl
        ? 8443
        : defaultPort
  const scheme =
    driver === 'clickhouse'
      ? profile.ssl
        ? 'https:'
        : 'http:'
      : driver === 'redis' && profile.ssl
        ? 'rediss:'
        : driver
  return {
    driver,
    scheme,
    host,
    port,
    filePath: '',
    d1AccountId: '',
    rawFallback: '',
  }
}

/**
 * Pure fail-closed predicate verifying whether a stored OS-keyring secret belonging to `stored`
 * may safely be reused when testing or saving `candidate`. Prevents SSRF secret-oracle exfiltration
 * where a caller mutates host/port/url/driver/sshHost/sslKeyPath while referencing an existing ID.
 */
export function canReuseStoredSecretForTarget(
  stored: ConnectionProfile | null | undefined,
  candidate: ConnectionProfile | null | undefined,
  kind: StoredSecretKind
): boolean {
  if (!stored || !candidate) return false

  if (kind === 'sslKey') {
    const storedKey = typeof stored.sslKeyPath === 'string' ? stored.sslKeyPath.trim() : ''
    const candKey = typeof candidate.sslKeyPath === 'string' ? candidate.sslKeyPath.trim() : ''
    if (!storedKey || !candKey) return false
    return (
      normalizePathForCompare(path.resolve(storedKey)) ===
      normalizePathForCompare(path.resolve(candKey))
    )
  }

  if (kind === 'ssh') {
    const storedHost = normalizeCanonicalHost(stored.sshHost)
    const candHost = normalizeCanonicalHost(candidate.sshHost)
    if (!storedHost || !candHost || storedHost !== candHost) return false
    const storedPort =
      typeof stored.sshPort === 'number' && Number.isInteger(stored.sshPort) && stored.sshPort > 0
        ? stored.sshPort
        : 22
    const candPort =
      typeof candidate.sshPort === 'number' &&
      Number.isInteger(candidate.sshPort) &&
      candidate.sshPort > 0
        ? candidate.sshPort
        : 22
    if (storedPort !== candPort) return false
    const storedUser = typeof stored.sshUser === 'string' ? stored.sshUser.trim() : ''
    const candUser = typeof candidate.sshUser === 'string' ? candidate.sshUser.trim() : ''
    if (!storedUser || storedUser !== candUser) return false
    const storedMethod = stored.sshAuthMethod ?? 'agent'
    const candMethod = candidate.sshAuthMethod ?? 'agent'
    if (storedMethod !== candMethod) return false
    if (storedMethod === 'key') {
      const storedKeyPath =
        typeof stored.sshPrivateKeyPath === 'string' ? stored.sshPrivateKeyPath.trim() : ''
      const candKeyPath =
        typeof candidate.sshPrivateKeyPath === 'string' ? candidate.sshPrivateKeyPath.trim() : ''
      if (storedKeyPath || candKeyPath) {
        if (!storedKeyPath || !candKeyPath) return false
        if (
          normalizePathForCompare(path.resolve(storedKeyPath)) !==
          normalizePathForCompare(path.resolve(candKeyPath))
        ) {
          return false
        }
      }
    }
    return true
  }

  const a = resolveCanonicalDbTarget(stored)
  const b = resolveCanonicalDbTarget(candidate)
  if (!a || !b) return false
  return (
    a.driver === b.driver &&
    a.scheme === b.scheme &&
    a.host === b.host &&
    a.port === b.port &&
    a.filePath === b.filePath &&
    a.d1AccountId === b.d1AccountId &&
    a.rawFallback === b.rawFallback
  )
}

function resolveLibsqlEndpointCandidate(profile: ConnectionProfile): string {
  let raw = typeof profile.url === 'string' ? profile.url.trim() : ''
  const preferredProto = profile.ssl === false ? 'http' : 'https'
  if (!raw && typeof profile.host === 'string' && profile.host.trim().length > 0) {
    const host = profile.host.trim()
    const isDefaultPort =
      !profile.port ||
      (preferredProto === 'https' && profile.port === 443) ||
      (preferredProto === 'http' && profile.port === 80)
    raw = isDefaultPort
      ? `${preferredProto}://${host}`
      : `${preferredProto}://${host}:${profile.port}`
  }
  if (!raw) return ''
  if (/^libsql:\/\//i.test(raw) && profile.ssl === false) {
    return raw.replace(/^libsql:\/\//i, 'http://')
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    return `${preferredProto}://${raw}`
  }
  return raw
}

export function registerConnectionHandlers({
  orca,
  registerHandler,
  sessionManager,
  driverManager,
  schemaCache,
}: ConnectionHandlersDeps): ConnectionHandlersController {
  const connectionsQueue = createSerializedQueue()
  const detectedCandidates = new Map<string, DetectedCandidateSecret>()

  const pruneDetectedCandidates = (now = Date.now()): void => {
    for (const [id, entry] of detectedCandidates.entries()) {
      if (entry.expiresAt <= now) {
        detectedCandidates.delete(id)
      }
    }
    while (detectedCandidates.size > DETECTED_CANDIDATE_MAX) {
      const oldest = detectedCandidates.keys().next().value
      if (oldest === undefined) break
      detectedCandidates.delete(oldest)
    }
  }

  const storeDetectedCandidate = (entry: Omit<DetectedCandidateSecret, 'expiresAt'>): string => {
    const now = Date.now()
    pruneDetectedCandidates(now)
    const id = `cand_${randomUUID()}`
    detectedCandidates.set(id, { ...entry, expiresAt: now + DETECTED_CANDIDATE_TTL_MS })
    pruneDetectedCandidates(now)
    return id
  }

  const getDetectedCandidate = (candidateId: string): DetectedCandidateSecret | undefined => {
    const now = Date.now()
    const entry = detectedCandidates.get(candidateId)
    if (!entry) return undefined
    if (entry.expiresAt <= now) {
      detectedCandidates.delete(candidateId)
      return undefined
    }
    return entry
  }

  const isLiveDesktopHost = Boolean(orca.host && typeof orca.host.call === 'function')
  if (isLiveDesktopHost) {
    driverManager.setBackupLoader(async () => {
      const backup = await readHostConfigBackup()
      return Array.isArray(backup?.byodConfigs) ? backup.byodConfigs : null
    })
  }

  registerHandler('connections.list', async (): Promise<ConnectionProfile[]> => {
    await connectionsQueue.waitIdle()
    let stored = await sessionManager.getStoredConnections()
    if (stored.length === 0 && isLiveDesktopHost) {
      stored = await connectionsQueue.run(async () => {
        const latest = await sessionManager.getStoredConnections()
        if (latest.length > 0) return latest
        const backup = await readHostConfigBackup()
        if (Array.isArray(backup?.connections) && backup.connections.length > 0) {
          const sanitizedBackup = backup.connections
            .filter((c) => c && typeof c === 'object' && typeof c.id === 'string' && c.id.length > 0)
            .map(sanitizeConnectionProfile)
          if (sanitizedBackup.length > 0) {
            await sessionManager.saveStoredConnections(sanitizedBackup)
            return sanitizedBackup
          }
        }
        return latest
      })
    }
    const cleaned = stored.filter(
      (c) =>
        c &&
        typeof c === 'object' &&
        typeof c.id === 'string' &&
        c.id.length > 0 &&
        !c.id.startsWith('ws_')
    )
    if (cleaned.length !== stored.length) {
      await connectionsQueue.run(async () => {
        const latest = await sessionManager.getStoredConnections()
        const latestCleaned = latest.filter(
          (c) =>
            c &&
            typeof c === 'object' &&
            typeof c.id === 'string' &&
            c.id.length > 0 &&
            !c.id.startsWith('ws_')
        )
        if (latestCleaned.length !== latest.length) {
          await sessionManager.saveStoredConnections(latestCleaned)
        }
      })
    }

    return cleaned.map(sanitizeConnectionProfile)
  })

  registerHandler('connection.save', async (input) => {
    if (!input || !input.profile || !input.profile.driver) {
      throw createHostError('invalid_params', 'Missing profile configuration')
    }
    if (
      !SUPPORTED_DRIVERS.includes(input.profile.driver) &&
      !isByodDriverId(input.profile.driver)
    ) {
      throw createHostError(
        'invalid_params',
        `Unsupported database driver: ${String(input.profile.driver)}`
      )
    }

    if (
      input.profile.driver === 'd1' &&
      typeof input.profile.url === 'string' &&
      input.profile.url.trim().length > 0
    ) {
      const checked = validateD1EndpointUrl(input.profile.url)
      if (!checked.ok) {
        throw createHostError('invalid_params', checked.error)
      }
    }

    const libsqlSaveCandidate =
      input.profile.driver === 'libsql' ? resolveLibsqlEndpointCandidate(input.profile) : ''
    if (input.profile.driver === 'libsql' && libsqlSaveCandidate) {
      const checked = validateLibsqlEndpointUrl(libsqlSaveCandidate, {
        hasAuthToken: Boolean(
          (typeof input.authToken === 'string' && input.authToken.trim().length > 0) ||
            input.profile.hasAuthToken
        ),
      })
      if (!checked.ok) {
        throw createHostError('invalid_params', checked.error)
      }
    }

    const normalized = await normalizeSqliteProfile(input.profile)
    const id =
      normalized.id && !normalized.id.startsWith('ws_')
        ? normalized.id
        : `conn_${normalized.driver}_${randomUUID()}`
    const d1HttpLoopback =
      normalized.driver === 'd1' &&
      typeof normalized.url === 'string' &&
      isD1HttpLoopbackEndpoint(normalized.url)
    const libsqlHttpLoopback =
      normalized.driver === 'libsql' &&
      libsqlSaveCandidate.length > 0 &&
      isD1HttpLoopbackEndpoint(libsqlSaveCandidate)

    const rawProfile = input.profile as unknown as Record<string, unknown>
    const hasOwn = (key: string): boolean => Object.prototype.hasOwnProperty.call(rawProfile, key)
    const sshExplicitlyDisabled = hasOwn('sshEnabled') && !input.profile.sshEnabled

    return await connectionsQueue.run(async () => {
      if (d1HttpLoopback) {
        let effectiveToken: string | undefined
        if (input.authToken !== undefined) {
          effectiveToken = input.authToken
        } else {
          if (input.sourceConnectionId) {
            effectiveToken = await sessionManager.getSecret(input.sourceConnectionId, 'd1')
          }
          if (!effectiveToken) {
            effectiveToken = await sessionManager.getSecret(id, 'd1')
          }
        }
        if (effectiveToken && effectiveToken.trim().length > 0) {
          throw createHostError(
            'invalid_params',
            'Cloudflare D1 cannot send an API token over plain HTTP; use an HTTPS endpoint or remove the token for a localhost/loopback emulator.'
          )
        }
      }
      if (libsqlHttpLoopback) {
        let effectiveToken: string | undefined
        if (input.authToken !== undefined) {
          effectiveToken = input.authToken
        } else {
          if (input.sourceConnectionId) {
            effectiveToken = await sessionManager.getSecret(input.sourceConnectionId, 'libsql')
          }
          if (!effectiveToken) {
            effectiveToken = await sessionManager.getSecret(id, 'libsql')
          }
        }
        if (effectiveToken && effectiveToken.trim().length > 0) {
          const checked = validateLibsqlEndpointUrl(libsqlSaveCandidate, { hasAuthToken: true })
          if (!checked.ok) {
            throw createHostError('invalid_params', checked.error)
          }
        }
      }

      const list = await sessionManager.getStoredConnections()
      const idx = list.findIndex((c) => c.id === id)
      const existing = idx >= 0 ? list[idx] : undefined
      const sourceProfile = input.sourceConnectionId
        ? list.find((c) => c.id === input.sourceConnectionId)
        : undefined
      const merged: ConnectionProfile = { ...normalized }

      if (existing) {
        if (!hasOwn('folder')) merged.folder = existing.folder
        if (!hasOwn('workspaceScope')) merged.workspaceScope = existing.workspaceScope
        if (!hasOwn('aiPolicy')) merged.aiPolicy = existing.aiPolicy
        if (existing.driver === normalized.driver) {
          if (!hasOwn('sslMode')) merged.sslMode = existing.sslMode
          if (!hasOwn('sslCaPath')) merged.sslCaPath = existing.sslCaPath
          if (!hasOwn('sslCertPath')) merged.sslCertPath = existing.sslCertPath
          if (!hasOwn('sslKeyPath')) merged.sslKeyPath = existing.sslKeyPath
          if (!hasOwn('hasSslKeyPassphrase')) {
            merged.hasSslKeyPassphrase = existing.hasSslKeyPassphrase
          }
          if (!hasOwn('sslRejectUnauthorized')) {
            merged.sslRejectUnauthorized = existing.sslRejectUnauthorized
          }
          if (!hasOwn('d1AccountId')) merged.d1AccountId = existing.d1AccountId
          if (!hasOwn('d1DatabaseId')) merged.d1DatabaseId = existing.d1DatabaseId
          if (!hasOwn('sshEnabled')) merged.sshEnabled = existing.sshEnabled
          if (!sshExplicitlyDisabled) {
            if (!hasOwn('sshHost')) merged.sshHost = existing.sshHost
            if (!hasOwn('sshPort')) merged.sshPort = existing.sshPort
            if (!hasOwn('sshUser')) merged.sshUser = existing.sshUser
            if (!hasOwn('sshAuthMethod')) merged.sshAuthMethod = existing.sshAuthMethod
            if (!hasOwn('sshPrivateKeyPath')) merged.sshPrivateKeyPath = existing.sshPrivateKeyPath
            if (!hasOwn('hasSshPassphrase')) merged.hasSshPassphrase = existing.hasSshPassphrase
            if (!hasOwn('hasSshPassword')) merged.hasSshPassword = existing.hasSshPassword
          }
        }
      }

      const copyPrefixes: string[] = []
      if (input.sourceConnectionId) {
        const allowCopyDb = canReuseStoredSecretForTarget(sourceProfile, merged, 'db')
        const allowCopySslKey = canReuseStoredSecretForTarget(sourceProfile, merged, 'sslKey')
        const allowCopySsh = canReuseStoredSecretForTarget(sourceProfile, merged, 'ssh')
        const usesTokenSave = merged.driver === 'libsql' || merged.driver === 'd1'

        if (!allowCopyDb) {
          const wantsDbCopy = usesTokenSave
            ? input.authToken === undefined && Boolean(merged.hasAuthToken)
            : input.password === undefined && Boolean(merged.hasPassword)
          if (wantsDbCopy) {
            throw createHostError(
              'not_permitted',
              'Stored credentials cannot be copied after changing the target host, port, URL, or driver. Re-enter credentials before saving.'
            )
          }
        } else {
          if (input.password === undefined) copyPrefixes.push('pwd')
          if (input.authToken === undefined) copyPrefixes.push('tok')
        }

        const effectiveAllowCopySslKey = allowCopyDb && allowCopySslKey
        const effectiveAllowCopySsh = allowCopyDb && allowCopySsh

        if (!effectiveAllowCopySslKey) {
          if (
            input.sslKeyPassphrase === undefined &&
            Boolean(merged.hasSslKeyPassphrase) &&
            Boolean(merged.sslKeyPath?.trim())
          ) {
            throw createHostError(
              'not_permitted',
              'Stored TLS key passphrase cannot be copied after changing the target endpoint or TLS key path. Re-enter the passphrase before saving.'
            )
          }
        } else if (input.sslKeyPassphrase === undefined) {
          copyPrefixes.push('sslkey')
        }

        if (!effectiveAllowCopySsh) {
          if (
            Boolean(merged.sshEnabled) &&
            ((input.sshPassphrase === undefined && Boolean(merged.hasSshPassphrase)) ||
              (input.sshPassword === undefined && Boolean(merged.hasSshPassword)))
          ) {
            throw createHostError(
              'not_permitted',
              'Stored SSH credentials cannot be copied after changing the target endpoint or SSH host, port, user, or auth method. Re-enter SSH credentials before saving.'
            )
          }
        } else {
          if (input.sshPassphrase === undefined) copyPrefixes.push('sshpass')
          if (input.sshPassword === undefined) copyPrefixes.push('sshpwd')
        }
      }

      // When updating an existing profile whose target endpoint changed without new credentials,
      // purge stale keyring entries fail-closed so the next connect never leaks secrets to a new host.
      const existingDbTargetChanged = Boolean(
        existing && !canReuseStoredSecretForTarget(existing, merged, 'db')
      )
      const existingSshTargetChanged = Boolean(
        existing &&
          (existing.sshEnabled || merged.sshEnabled) &&
          !canReuseStoredSecretForTarget(existing, merged, 'ssh')
      )
      const existingSslKeyTargetChanged = Boolean(
        existing &&
          (existing.sslKeyPath || merged.sslKeyPath) &&
          !canReuseStoredSecretForTarget(existing, merged, 'sslKey')
      )

      const usesTokenSave = merged.driver === 'libsql' || merged.driver === 'd1'
      const effectivePasswordInput =
        input.password !== undefined
          ? input.password
          : existingDbTargetChanged || (existing && usesTokenSave && existing.driver !== merged.driver)
            ? ''
            : undefined
      const effectiveAuthTokenInput =
        input.authToken !== undefined
          ? input.authToken
          : existingDbTargetChanged || (existing && !usesTokenSave && existing.driver !== merged.driver)
            ? ''
            : undefined
      const effectiveSslKeyPassphraseInput =
        input.sslKeyPassphrase !== undefined
          ? input.sslKeyPassphrase
          : existingSslKeyTargetChanged
            ? ''
            : undefined
      const effectiveSshPassphraseInput =
        input.sshPassphrase !== undefined
          ? input.sshPassphrase
          : existingSshTargetChanged || sshExplicitlyDisabled
            ? ''
            : undefined
      const effectiveSshPasswordInput =
        input.sshPassword !== undefined
          ? input.sshPassword
          : existingSshTargetChanged || sshExplicitlyDisabled
            ? ''
            : undefined

      const hasPassword =
        effectivePasswordInput !== undefined
          ? Boolean(effectivePasswordInput)
          : Boolean(merged.hasPassword)
      const hasAuthToken =
        effectiveAuthTokenInput !== undefined
          ? Boolean(effectiveAuthTokenInput)
          : Boolean(merged.hasAuthToken)
      const hasSslKeyPassphrase =
        effectiveSslKeyPassphraseInput !== undefined
          ? Boolean(effectiveSslKeyPassphraseInput)
          : Boolean(merged.hasSslKeyPassphrase)
      const hasSshPassphrase =
        effectiveSshPassphraseInput !== undefined
          ? Boolean(effectiveSshPassphraseInput)
          : Boolean(merged.hasSshPassphrase)
      const hasSshPassword =
        effectiveSshPasswordInput !== undefined
          ? Boolean(effectiveSshPasswordInput)
          : Boolean(merged.hasSshPassword)

      const profileToSave = sanitizeConnectionProfile({
        ...merged,
        id,
        hasPassword,
        hasAuthToken: hasAuthToken || undefined,
        hasSslKeyPassphrase: hasSslKeyPassphrase || undefined,
        hasSshPassphrase: hasSshPassphrase || undefined,
        hasSshPassword: hasSshPassword || undefined,
      })

      const prevList = list.slice()
      if (idx >= 0) {
        list[idx] = profileToSave
      } else {
        list.push(profileToSave)
      }

      if (input.sourceConnectionId && copyPrefixes.length > 0) {
        await sessionManager.copySecret(input.sourceConnectionId, id, copyPrefixes)
      }
      await sessionManager.saveSecret(id, {
        password: effectivePasswordInput,
        authToken: effectiveAuthTokenInput,
        sslKeyPassphrase: effectiveSslKeyPassphraseInput,
        sshPassphrase: effectiveSshPassphraseInput,
        sshPassword: effectiveSshPasswordInput,
      })

      try {
        await sessionManager.saveStoredConnections(list)
      } catch (storageErr) {
        if (!existing) {
          await sessionManager.deleteSecret(id).catch(() => {})
        } else {
          await sessionManager.saveStoredConnections(prevList).catch(() => {})
        }
        throw storageErr
      }
      if (isLiveDesktopHost) {
        await writeHostConfigBackupPatch({ connections: list.map(sanitizeConnectionProfile) })
      }

      const currentActiveId = await orca.storage.get(ACTIVE_CONNECTION_STORAGE_KEY)
      const activeStillExists =
        typeof currentActiveId === 'string' &&
        currentActiveId.trim().length > 0 &&
        list.some((c) => c.id === currentActiveId)
      if (!activeStillExists) {
        await orca.storage.set(ACTIVE_CONNECTION_STORAGE_KEY, id)
      }

      await sessionManager.closeSession(id)
      schemaCache?.invalidateConnection(id)

      orca.panels.post('connections.changed', { count: list.length })
      return { ok: true, id }
    })
  })

  registerHandler('connection.delete', async (input) => {
    if (!input || !input.id) {
      throw createHostError('invalid_params', 'Missing id parameter')
    }

    return await connectionsQueue.run(async () => {
      const list = await sessionManager.getStoredConnections()
      const updated = list.filter((c) => c.id !== input.id)
      await sessionManager.saveStoredConnections(updated)
      if (isLiveDesktopHost) {
        await writeHostConfigBackupPatch({ connections: updated.map(sanitizeConnectionProfile) })
      }
      await sessionManager.deleteSecret(input.id)
      await sessionManager.closeSession(input.id)
      schemaCache?.invalidateConnection(input.id)

      const validUpdated = updated.filter(
        (c) => c && typeof c.id === 'string' && c.id.length > 0 && !c.id.startsWith('ws_')
      )
      const currentActiveId = await orca.storage.get(ACTIVE_CONNECTION_STORAGE_KEY)
      const activeStillValid =
        typeof currentActiveId === 'string' &&
        validUpdated.some((c) => c.id === currentActiveId)
      if (currentActiveId === input.id || !activeStillValid) {
        const nextActiveId = validUpdated[0]?.id
        if (nextActiveId) {
          await orca.storage.set(ACTIVE_CONNECTION_STORAGE_KEY, nextActiveId)
        } else {
          await orca.storage.delete(ACTIVE_CONNECTION_STORAGE_KEY)
        }
      }

      orca.panels.post('connections.changed', { count: updated.length })
      return { ok: true }
    })
  })

  registerHandler('connection.test', async (input) => {
    if (!input?.profile?.driver) {
      throw createHostError('invalid_params', 'Driver must be specified')
    }
    if (
      !SUPPORTED_DRIVERS.includes(input.profile.driver) &&
      !isByodDriverId(input.profile.driver)
    ) {
      throw createHostError(
        'invalid_params',
        `Unsupported database driver: ${String(input.profile.driver)}`
      )
    }

    const normalized = await normalizeSqliteProfile(input.profile)
    if (
      normalized.driver === 'd1' &&
      typeof normalized.url === 'string' &&
      normalized.url.trim().length > 0
    ) {
      const checked = validateD1EndpointUrl(normalized.url)
      if (!checked.ok) {
        throw createHostError('invalid_params', checked.error)
      }
    }
    const usesToken = normalized.driver === 'libsql' || normalized.driver === 'd1'
    let secret = usesToken ? input.authToken : input.password
    if (normalized.driver === 'libsql') {
      const libsqlTestCandidate = resolveLibsqlEndpointCandidate(normalized)
      if (libsqlTestCandidate) {
        const checked = validateLibsqlEndpointUrl(libsqlTestCandidate, {
          hasAuthToken: Boolean(
            (typeof secret === 'string' && secret.trim().length > 0) || normalized.hasAuthToken
          ),
        })
        if (!checked.ok) {
          throw createHostError('invalid_params', checked.error)
        }
      }
    }
    const secretLookupId =
      normalized.id &&
      !normalized.id.startsWith('ws_') &&
      !normalized.id.startsWith('conn_test_')
        ? normalized.id
        : input.sourceConnectionId
    const storedProfile =
      secretLookupId && typeof sessionManager.findProfile === 'function'
        ? await sessionManager.findProfile(secretLookupId)
        : null
    const allowDbSecret = canReuseStoredSecretForTarget(storedProfile, normalized, 'db')
    const allowSslKeySecret = canReuseStoredSecretForTarget(storedProfile, normalized, 'sslKey')
    const allowSshSecret = canReuseStoredSecretForTarget(storedProfile, normalized, 'ssh')

    if (secret === undefined && secretLookupId) {
      const hasStoredSecret = usesToken
        ? normalized.hasAuthToken === true ||
          (normalized.hasAuthToken !== false && Boolean(storedProfile?.hasAuthToken))
        : Boolean(normalized.hasPassword)
      if (hasStoredSecret) {
        if (!allowDbSecret) {
          throw createHostError(
            'not_permitted',
            'Stored credentials cannot be reused after changing the target host, port, URL, or driver. Re-enter credentials to test this connection.'
          )
        }
        secret = await sessionManager.getSecret(secretLookupId, normalized.driver)
      }
    }

    if (normalized.driver === 'libsql') {
      const libsqlTestCandidate = resolveLibsqlEndpointCandidate(normalized)
      if (libsqlTestCandidate) {
        const checked = validateLibsqlEndpointUrl(libsqlTestCandidate, {
          hasAuthToken: Boolean(
            (typeof secret === 'string' && secret.trim().length > 0) || normalized.hasAuthToken
          ),
        })
        if (!checked.ok) {
          throw createHostError('invalid_params', checked.error)
        }
      }
    }

    const effectiveAllowSslKey = allowDbSecret && allowSslKeySecret
    const effectiveAllowSsh = allowDbSecret && allowSshSecret

    if (
      secretLookupId &&
      input.sslKeyPassphrase === undefined &&
      Boolean(normalized.hasSslKeyPassphrase) &&
      Boolean(normalized.sslKeyPath?.trim()) &&
      !effectiveAllowSslKey
    ) {
      throw createHostError(
        'not_permitted',
        'Stored TLS key passphrase cannot be reused after changing the target endpoint or TLS key path. Re-enter the passphrase to test this connection.'
      )
    }

    if (
      secretLookupId &&
      Boolean(normalized.sshEnabled) &&
      !effectiveAllowSsh &&
      ((input.sshPassphrase === undefined && Boolean(normalized.hasSshPassphrase)) ||
        (input.sshPassword === undefined && Boolean(normalized.hasSshPassword)))
    ) {
      throw createHostError(
        'not_permitted',
        'Stored SSH credentials cannot be reused after changing the target endpoint or SSH host, port, user, or auth method. Re-enter SSH credentials to test this connection.'
      )
    }

    const storedSecrets =
      secretLookupId && (effectiveAllowSslKey || effectiveAllowSsh)
        ? await sessionManager.getExtendedSecrets(secretLookupId)
        : {}
    const allowStoredExtended = Boolean(input.sourceConnectionId)
    const extraSecrets = {
      sslKeyPassphrase:
        input.sslKeyPassphrase ??
        (effectiveAllowSslKey && (allowStoredExtended || normalized.hasSslKeyPassphrase)
          ? storedSecrets.sslKeyPassphrase
          : undefined),
      sshPassphrase:
        input.sshPassphrase ??
        (effectiveAllowSsh && (allowStoredExtended || normalized.hasSshPassphrase)
          ? storedSecrets.sshPassphrase
          : undefined),
      sshPassword:
        input.sshPassword ??
        (effectiveAllowSsh && (allowStoredExtended || normalized.hasSshPassword)
          ? storedSecrets.sshPassword
          : undefined),
    }
    try {
      const result = await sessionManager.testConnection(normalized, secret, extraSecrets)
      if (!result.ok && typeof result.message === 'string') {
        return {
          ...result,
          message: appendActionableTlsErrorHint(scrubCredentialsInText(result.message)),
        }
      }
      return result
    } catch (err: unknown) {
      throw scrubAndEnhanceWorkerError(err)
    }
  })

  registerHandler('connection.parseUri', async (input) => {
    const candidateId = typeof input?.candidateId === 'string' ? input.candidateId.trim() : ''
    if (candidateId) {
      const candidate = getDetectedCandidate(candidateId)
      if (!candidate) {
        return {
          ok: false,
          error: 'Detected connection candidate expired. Run Auto-Detect again.',
        }
      }
      const rawTarget = candidate.rawUri ?? candidate.rawUrl ?? ''
      return parseConnectionUri(rawTarget)
    }
    const rawUri = typeof input?.uri === 'string' ? input.uri : ''
    return parseConnectionUri(rawUri)
  })

  registerHandler('sqlite.scanFolder', async (input) => {
    const stored = await sessionManager.getStoredConnections()
    const rawFolder = input?.folderPath?.trim()
    let items: DiscoveredSqliteFile[] = []
    if (rawFolder) {
      try {
        let targetDir = rawFolder
        try {
          const stat = await fs.promises.stat(rawFolder)
          if (stat.isFile()) {
            targetDir = path.dirname(rawFolder)
          }
        } catch {
          // Keep rawFolder as directory candidate
        }
        items = await scanDirectoryForSqliteFiles(targetDir, stored)
      } catch {
        items = []
      }
    } else {
      items = await discoverWorkspaceSqliteFiles(orca, stored)
    }

    return {
      files: items.map((d) => ({
        name: d.name.replace(/\s*\(Workspace\)$/, ''),
        filePath: d.filePath,
        sizeBytes: d.sizeBytes ?? 0,
        sizeLabel: d.sizeLabel || formatByteSize(d.sizeBytes ?? 0),
      })),
    }
  })

  registerHandler('workspace.detectConnections', async (input) => {
    pruneDetectedCandidates()
    const stored = await sessionManager.getStoredConnections()
    const rawFolder = input?.folderPath?.trim()
    let targetDirs: string[] = []
    let sqliteFilesPromise: Promise<DiscoveredSqliteFile[]>

    if (rawFolder) {
      let targetDir = rawFolder
      try {
        const stat = await fs.promises.stat(rawFolder)
        if (stat.isFile()) {
          targetDir = path.dirname(rawFolder)
        }
      } catch {
        // Keep rawFolder
      }
      targetDirs = [targetDir]
      sqliteFilesPromise = scanDirectoryForSqliteFiles(targetDir, stored, { maxDurationMs: 750 })
    } else {
      targetDirs = await getLocalWorkspaceDirs(orca)
      sqliteFilesPromise = discoverWorkspaceSqliteFiles(orca, stored, { maxDurationMs: 750 })
    }

    const [envConnections, items, dockerComposeConnections] = await Promise.all([
      detectWorkspaceEnvConnections(targetDirs),
      sqliteFilesPromise,
      detectWorkspaceDockerComposeConnections(targetDirs, {
        onlyMatchedWorkspaces: Boolean(rawFolder),
      }),
    ])

    const maskedEnvConnections = envConnections.map((item) => {
      const candidateId = storeDetectedCandidate({ kind: 'env', rawUri: item.uri })
      return {
        ...item,
        candidateId,
        uri: maskConnectionUriSecret(item.uri),
      }
    })

    const maskedDockerComposeConnections = dockerComposeConnections.map((item) => {
      const hasPassword = Boolean(item.password)
      const candidateId = storeDetectedCandidate({
        kind: 'docker',
        rawPassword: item.password,
        rawUrl: item.url,
      })
      return {
        ...item,
        candidateId,
        password: undefined,
        hasPassword,
        url: item.url ? maskConnectionUriSecret(item.url) : undefined,
      }
    })

    const folderScoped = Boolean(rawFolder)
    const dockerLocality = detectDockerTargetLocality()
    const detectResult = {
      sqliteFiles: items.map((d) => ({
        name: d.name.replace(/\s*\(Workspace\)$/, ''),
        filePath: d.filePath,
        sizeBytes: d.sizeBytes ?? 0,
        sizeLabel: d.sizeLabel || formatByteSize(d.sizeBytes ?? 0),
      })),
      envConnections: maskedEnvConnections,
      dockerComposeConnections: maskedDockerComposeConnections,
      scannedDirs: targetDirs,
      folderScoped,
      dockerIsLocal: dockerLocality.isLocal,
      dockerScopeLabel: dockerLocality.contextLabel,
    }
    return detectResult
  })

  registerHandler('workspace.resolveDetectedCandidate', async (input) => {
    const candidateId = typeof input?.candidateId === 'string' ? input.candidateId.trim() : ''
    if (!candidateId) {
      return { ok: false }
    }
    const candidate = getDetectedCandidate(candidateId)
    if (!candidate) {
      return { ok: false }
    }
    if (candidate.kind === 'env' && candidate.rawUri) {
      const parsed = parseConnectionUri(candidate.rawUri)
      return {
        ok: parsed.ok,
        parsed,
        password: parsed.password,
        authToken: parsed.authToken,
        url: parsed.profile?.url,
      }
    }
    const parsed = candidate.rawUrl ? parseConnectionUri(candidate.rawUrl) : undefined
    return {
      ok: true,
      parsed,
      password: candidate.rawPassword ?? parsed?.password,
      authToken: parsed?.authToken,
      url: candidate.rawUrl,
    }
  })

  const syncByodConfigsToBackup = async (): Promise<void> => {
    if (!isLiveDesktopHost) return
    try {
      const raw = await orca.storage.get(CUSTOM_DRIVERS_STORAGE_KEY)
      if (Array.isArray(raw)) {
        await writeHostConfigBackupPatch({
          byodConfigs: raw as unknown as PersistedLocalDriverConfig[],
        })
      }
    } catch {
      // Ignore backup write failure
    }
  }

  registerHandler('drivers.list', async () => {
    return { drivers: await driverManager.listDrivers() }
  })

  registerHandler('drivers.inspectLocal', async (input) => {
    if (!input?.driverId || !input?.localPath) {
      throw createHostError('invalid_params', 'driverId and localPath are required')
    }
    return await driverManager.inspectLocalDriver({
      driverId: input.driverId,
      localPath: input.localPath,
    })
  })

  registerHandler('drivers.configureLocal', async (input) => {
    if (!input?.driverId || !input?.localPath) {
      throw createHostError('invalid_params', 'driverId and localPath are required')
    }
    const item = await driverManager.configureLocalDriver({
      driverId: input.driverId,
      localPath: input.localPath,
      name: input.name,
      trustedSha256: input.trustedSha256,
    })
    await sessionManager.closeSessionsByDriver(input.driverId)
    await syncByodConfigsToBackup()
    return { ok: true, item }
  })

  registerHandler('drivers.verify', async (input) => {
    if (!input?.driverId) {
      throw createHostError('invalid_params', 'driverId is required')
    }
    const res = await driverManager.verifyLocalDriver(input.driverId, {
      trustedSha256: input.trustedSha256,
    })
    if (!res.ok || res.sha256Changed) {
      await sessionManager.closeSessionsByDriver(input.driverId)
    }
    await syncByodConfigsToBackup()
    return res
  })

  registerHandler('drivers.removeLocal', async (input) => {
    if (!input?.driverId) {
      throw createHostError('invalid_params', 'driverId is required')
    }
    const res = await driverManager.removeLocalDriver(input.driverId)
    await sessionManager.closeSessionsByDriver(input.driverId)
    await syncByodConfigsToBackup()
    return res
  })

  registerHandler('drivers.defaultPaths', async () => {
    return getDefaultByodDriverDirs()
  })

  registerHandler('drivers.setupLocal', async (input) => {
    if (!input?.driverId || !input?.localPath) {
      throw createHostError('invalid_params', 'driverId and localPath are required')
    }
    const setupRes = await scaffoldLocalDriverDirectory({
      driverId: input.driverId,
      localPath: input.localPath,
    })
    const inspect = await driverManager.inspectLocalDriver({
      driverId: input.driverId,
      localPath: setupRes.dirPath,
    })
    let item = undefined
    const realSetupEntry = await fs.promises
      .realpath(setupRes.entryPath)
      .catch(() => setupRes.entryPath)
    const canAutoTrust =
      input.autoTrust !== false &&
      setupRes.wroteCanonicalEntry &&
      inspect.ok &&
      inspect.resolvedEntry === realSetupEntry &&
      inspect.sha256 === setupRes.canonicalSha256
    if (canAutoTrust) {
      try {
        item = await driverManager.configureLocalDriver({
          driverId: input.driverId,
          localPath: setupRes.dirPath,
          trustedSha256: inspect.sha256,
        })
        await sessionManager.closeSessionsByDriver(input.driverId)
        await syncByodConfigsToBackup()
      } catch {
        // Leave pending for manual Trust & Verify until npm package is installed
      }
    }
    return {
      ok: true,
      dirPath: setupRes.dirPath,
      entryPath: setupRes.entryPath,
      wroteCanonicalEntry: setupRes.wroteCanonicalEntry,
      installPackage: setupRes.installPackage,
      inspect,
      item,
    }
  })

  registerHandler('fs.listDir', async (input) => {
    const workspaceDirs = await getLocalWorkspaceDirs(orca).catch(() => [])
    return await listDirectoryForPicker(input || {}, workspaceDirs)
  })

  registerHandler('workspace.listScopes', async () => {
    return await listWorkspaceScopesForUi(orca)
  })

  registerHandler('ui.getSessionSnapshot', async (input) => {
    const surface = input?.surface === 'studio' ? 'studio' : 'panel'
    return await getUiSessionSnapshot(orca, surface)
  })

  registerHandler('ui.saveSessionSnapshot', async (input) => {
    const surface = input?.surface === 'studio' ? 'studio' : 'panel'
    return await saveUiSessionSnapshot(orca, surface, {
      viewState: input?.viewState,
      dataCache: input?.dataCache,
    })
  })

  return {
    clearDetectedCandidates: () => {
      detectedCandidates.clear()
    },
  }
}
