import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import type {
  ConnectionProfile,
  DatabaseDriverType,
  SshHostKeyChallenge,
  SshJumpHopSecret,
  SshJumpHostProfile,
  TlsFailure,
} from '../protocol'
import { SAVED_CONNECTIONS_STORAGE_KEY, sanitizeJsonPayload } from '../protocol'
import {
  HealthPolicy,
  type ConnectionHealthState,
  type HealthPolicySnapshot,
  type IDatabaseDriver,
  type IDatabaseSession,
} from '../drivers/common/driver'
import { loadBuiltinDriver } from '../drivers/lazy-loader'
import { getByodDefaultPort, isByodDriverId } from '../drivers/driver-manager'
import type { DriverTlsOptions, SshTunnelHandle } from '../drivers/common/tls-and-tunnel'
import { openSshTunnel, SshHostKeyVerificationError } from '../drivers/common/tls-and-tunnel'
import {
  copyHopSecrets as copyHopSecretsVault,
  deleteSecret as deleteAllConnectionSecrets,
  getHopSecrets as getHopSecretsVault,
  saveHopSecrets as saveHopSecretsVault,
} from '../drivers/common/ssh-hop-secrets'
import { diagnoseTlsFailure } from '../drivers/common/tls-prober'
import {
  BUILTIN_ENGINE_CATALOG,
  getDefaultPortForDriver,
} from '../drivers/common/engine-catalog'
import type { SshHostKeyChallengeStore } from './ssh-host-key-challenge-store'
import { appendActionableTlsErrorHint, scrubCredentialsInText } from './worker-utils'

/** TCP engines that can be reached through an SSH bastion */
const SSH_TUNNEL_ENGINES: ReadonlySet<DatabaseDriverType> = new Set(
  BUILTIN_ENGINE_CATALOG.filter((engine) => engine.supportsSshTunnel).map((engine) => engine.id)
)

const TCP_TLS_PROBE_DRIVERS: ReadonlySet<DatabaseDriverType> = new Set([
  'postgres',
  'cockroachdb',
  'mysql',
  'mariadb',
  'mssql',
  'oracle',
  'redis',
  'mongodb',
  'clickhouse',
])

/** Secrets held only in `orca.secrets` (never persisted on the ConnectionProfile) */
export interface ExtendedSecrets {
  sslKeyPassphrase?: string
  sshPassphrase?: string
  sshPassword?: string
  sshJumpHopSecrets?: Record<string, SshJumpHopSecret>
  sshRetryToken?: string
  panelId?: string
}

export interface SessionManagerHostApi {
  storage: Pick<OrcaWorkerApi['storage'], 'get' | 'set'> & {
    delete?: OrcaWorkerApi['storage']['delete']
  }
  secrets: Pick<OrcaWorkerApi['secrets'], 'get' | 'set' | 'delete'> & {
    protection?: () => Promise<string | { status?: string }>
  }
  host?: Pick<OrcaWorkerApi['host'], 'call' | 'has'>
  panels?: Pick<OrcaWorkerApi['panels'], 'post'>
  log: OrcaWorkerApi['log']
}

export interface SessionManagerOptions {
  challengeStore?: SshHostKeyChallengeStore
  onSessionClosed?: (connectionId: string) => Promise<void> | void
}

/** Default port for URL-based engines when the URL does not spell one out */
function defaultUrlPort(driver: DatabaseDriverType, protocol: string): number {
  if (driver === 'redis') return getDefaultPortForDriver('redis')
  if (driver === 'mongodb') return getDefaultPortForDriver('mongodb')
  if (/^https:$/i.test(protocol)) return 443
  if (/^clickhouses:$/i.test(protocol)) return 8443
  return getDefaultPortForDriver(driver)
}

function isUrlTunnelDriver(driver: DatabaseDriverType): boolean {
  return (
    driver === 'clickhouse' ||
    driver === 'redis' ||
    driver === 'mongodb' ||
    driver === 'mssql' ||
    driver === 'oracle'
  )
}

function parseAdoNetServerTarget(
  rawUrl: string
): { targetHost: string; targetPort: number } | null {
  const match = /(?:^|;)\s*(?:Server|Data Source)\s*=\s*([^;]+)/i.exec(rawUrl)
  if (!match) return null
  const rawServer = match[1].trim().replace(/^tcp:/i, '')
  if (!rawServer) return null
  const commaIdx = rawServer.lastIndexOf(',')
  if (commaIdx > 0) {
    const hostPart = rawServer.slice(0, commaIdx).trim()
    const portNum = Number(rawServer.slice(commaIdx + 1).trim())
    if (hostPart) {
      return {
        targetHost: hostPart,
        targetPort: Number.isInteger(portNum) && portNum > 0 ? portNum : 1433,
      }
    }
  }
  return { targetHost: rawServer, targetPort: 1433 }
}

function rewriteAdoNetServerTarget(rawUrl: string, localHost: string, localPort: number): string | null {
  const match = /((?:^|;)\s*(?:Server|Data Source)\s*=\s*)([^;]+)/i.exec(rawUrl)
  if (!match) return null
  return (
    rawUrl.slice(0, match.index) +
    `${match[1]}${localHost},${localPort}` +
    rawUrl.slice(match.index + match[0].length)
  )
}

const HAS_URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//
const ORACLE_EASY_CONNECT_RE =
  /^(?:(tcps?):\/\/|\/\/)?(\[[0-9a-fA-F:]+\]|[A-Za-z0-9_.-]+)(?::(\d{1,5}))?(\/[^\s]*)$/i
const ORACLE_TNS_HOST_RE = /\(\s*HOST\s*=\s*([^)\s]+)\s*\)/gi
const ORACLE_TNS_PORT_RE = /\(\s*PORT\s*=\s*(\d{1,5})\s*\)/gi

const MONGODB_SRV_SSH_ERROR =
  'SSH tunneling cannot be used with mongodb+srv:// URIs because SRV DNS lookup resolves multiple remote replica-set hosts dynamically. Use a standard mongodb://host:port URI or explicit Host/Port fields instead.'

function hasMultiHostMongoAuthority(rawUrl: string): boolean {
  const schemeIdx = rawUrl.indexOf('://')
  if (schemeIdx < 0) return false
  const rest = rawUrl.slice(schemeIdx + 3)
  const endIdx = rest.search(/[/?#]/)
  const authority = endIdx >= 0 ? rest.slice(0, endIdx) : rest
  const atIdx = authority.lastIndexOf('@')
  const hostPortPart = atIdx >= 0 ? authority.slice(atIdx + 1) : authority
  return hostPortPart.includes(',')
}

const FILE_BASED_BYOD_DRIVERS: ReadonlySet<string> = new Set(['duckdb'])

function parseOracleEasyConnectTarget(
  raw: string,
  ssl?: boolean
): { targetHost: string; targetPort: number; schemePrefix: string; tail: string } | null {
  const withoutScheme = raw.replace(/^(?:tcps?:\/\/|\/\/)/i, '')
  const slashIdx = withoutScheme.indexOf('/')
  if (slashIdx > 0) {
    const beforeSlash = withoutScheme.slice(0, slashIdx)
    if (beforeSlash.includes(',')) {
      throw new Error(
        'SSH tunneling cannot be used with multi-host Oracle Easy Connect strings. Use a single host:port/service string or explicit Host/Port fields instead.'
      )
    }
  }
  const match = ORACLE_EASY_CONNECT_RE.exec(raw)
  if (!match) return null
  const scheme = match[1]?.toLowerCase()
  const targetHost = match[2].replace(/^\[|\]$/g, '')
  if (!targetHost) return null
  const parsedPort = match[3] ? Number(match[3]) : Number.NaN
  if (match[3] && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)) {
    throw new Error(`Invalid port in Oracle Easy Connect string for SSH tunnel: ${match[3]}`)
  }
  const targetPort = Number.isInteger(parsedPort)
    ? parsedPort
    : scheme === 'tcps' || ssl
      ? 2484
      : 1521
  const schemePrefix = match[1] ? `${match[1]}://` : raw.startsWith('//') ? '//' : ''
  return { targetHost, targetPort, schemePrefix, tail: match[4] }
}

function isOracleTnsDescriptor(raw: string): boolean {
  return raw.trimStart().startsWith('(') && /\(\s*(?:DESCRIPTION|ADDRESS)\b/i.test(raw)
}

function parseOracleTnsTarget(
  raw: string
): { targetHost: string; targetPort: number; hasPort: boolean } {
  const hostMatches = Array.from(raw.matchAll(ORACLE_TNS_HOST_RE))
  if (hostMatches.length === 0) {
    throw new Error(
      'SSH tunneling requires a valid (HOST=...) entry in the Oracle TNS descriptor.'
    )
  }
  if (hostMatches.length > 1) {
    throw new Error(
      'SSH tunneling cannot be used with multi-address Oracle TNS descriptors. Use a single-address descriptor or explicit Host/Port fields instead.'
    )
  }
  const portMatches = Array.from(raw.matchAll(ORACLE_TNS_PORT_RE))
  if (portMatches.length > 1) {
    throw new Error(
      'SSH tunneling cannot be used with multi-address Oracle TNS descriptors. Use a single-address descriptor or explicit Host/Port fields instead.'
    )
  }
  const targetHost = hostMatches[0][1].replace(/^\[|\]$/g, '')
  const isTcps = /\(\s*PROTOCOL\s*=\s*TCPS\s*\)/i.test(raw)
  const parsedPort = portMatches[0] ? Number(portMatches[0][1]) : Number.NaN
  const targetPort =
    Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
      ? parsedPort
      : isTcps
        ? 2484
        : 1521
  return { targetHost, targetPort, hasPort: portMatches.length === 1 }
}

function rewriteOracleTnsTarget(raw: string, localHost: string, localPort: number): string {
  const info = parseOracleTnsTarget(raw)
  let rewritten = raw.replace(/\(\s*HOST\s*=\s*[^)\s]+\s*\)/i, `(HOST=${localHost})`)
  if (info.hasPort) {
    rewritten = rewritten.replace(/\(\s*PORT\s*=\s*\d{1,5}\s*\)/i, `(PORT=${localPort})`)
  } else {
    rewritten = rewritten.replace(
      /\(\s*HOST\s*=\s*[^)\s]+\s*\)/i,
      `(HOST=${localHost})(PORT=${localPort})`
    )
  }
  return rewritten
}

/**
 * Resolves the real SSH forwarding target. URL-based profiles carry the remote host/port
 * inside `profile.url`, which must win over discrete fallback fields.
 */
export function resolveSshTunnelTarget(profile: ConnectionProfile): {
  targetHost: string
  targetPort: number
} {
  const explicitPort =
    profile.port && Number.isInteger(profile.port) && profile.port > 0 ? profile.port : undefined
  const rawUrl = typeof profile.url === 'string' ? profile.url.trim() : ''
  const rawHost = typeof profile.host === 'string' ? profile.host.trim() : ''

  if (rawUrl && isUrlTunnelDriver(profile.driver)) {
    if (/^mongodb\+srv:\/\//i.test(rawUrl)) {
      throw new Error(MONGODB_SRV_SSH_ERROR)
    }
    if (profile.driver === 'oracle') {
      if (isOracleTnsDescriptor(rawUrl)) {
        const tns = parseOracleTnsTarget(rawUrl)
        return { targetHost: tns.targetHost, targetPort: tns.targetPort }
      }
      const easy = parseOracleEasyConnectTarget(rawUrl, profile.ssl)
      if (easy) {
        return { targetHost: easy.targetHost, targetPort: easy.targetPort }
      }
    }
    if (HAS_URI_SCHEME_RE.test(rawUrl)) {
      if (profile.driver === 'mongodb' && hasMultiHostMongoAuthority(rawUrl)) {
        throw new Error(
          'SSH tunneling cannot be used with multi-host MongoDB URIs. Use a single mongodb://host:port URI or explicit Host/Port fields instead.'
        )
      }
      let parsed: URL
      try {
        parsed = new URL(rawUrl)
      } catch {
        throw new Error(
          `SSH tunneling could not parse the connection URL for driver '${profile.driver}'. Use a single-host URI or explicit Host/Port fields instead.`
        )
      }
      const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
      if (hostname.length === 0) {
        throw new Error(
          `SSH tunneling requires a valid hostname in the connection URL for driver '${profile.driver}'.`
        )
      }
      const parsedPort = parsed.port ? Number(parsed.port) : Number.NaN
      return {
        targetHost: hostname,
        targetPort:
          Number.isInteger(parsedPort) && parsedPort > 0
            ? parsedPort
            : defaultUrlPort(profile.driver, parsed.protocol),
      }
    }
    if (profile.driver === 'mssql') {
      const adoTarget = parseAdoNetServerTarget(rawUrl)
      if (adoTarget) return adoTarget
      if (!/(?:^|;)\s*(?:Server|Data Source)\s*=\s*[^;\s]+/i.test(rawUrl)) {
        return {
          targetHost: rawHost || 'localhost',
          targetPort: explicitPort ?? getDefaultPortForDriver('mssql'),
        }
      }
    }
    throw new Error(
      `SSH tunneling could not rewrite connection URL for driver '${profile.driver}'. Use a standard single-host URI or explicit Host/Port fields instead.`
    )
  }

  if (!rawUrl && profile.driver === 'oracle' && rawHost) {
    if (isOracleTnsDescriptor(rawHost)) {
      const tns = parseOracleTnsTarget(rawHost)
      return { targetHost: tns.targetHost, targetPort: tns.targetPort }
    }
    if (rawHost.includes('/')) {
      const easy = parseOracleEasyConnectTarget(rawHost, profile.ssl)
      if (easy) {
        return { targetHost: easy.targetHost, targetPort: easy.targetPort }
      }
    }
  }

  return {
    targetHost: rawHost || 'localhost',
    targetPort:
      explicitPort ??
      (isByodDriverId(profile.driver)
        ? getByodDefaultPort(profile.driver)
        : getDefaultPortForDriver(profile.driver)),
  }
}

/** Rewrites a URL-based profile to the local forwarding endpoint, preserving scheme/path/query */
export function buildTunnelProxiedProfile(
  profile: ConnectionProfile,
  tunnel: Pick<SshTunnelHandle, 'localHost' | 'localPort'>
): ConnectionProfile {
  const proxied: ConnectionProfile = {
    ...profile,
    host: tunnel.localHost,
    port: tunnel.localPort,
  }
  const rawUrl = typeof profile.url === 'string' ? profile.url.trim() : ''
  const rawHost = typeof profile.host === 'string' ? profile.host.trim() : ''

  if (rawUrl && isUrlTunnelDriver(profile.driver)) {
    if (/^mongodb\+srv:\/\//i.test(rawUrl)) {
      throw new Error(MONGODB_SRV_SSH_ERROR)
    }
    if (profile.driver === 'oracle') {
      if (isOracleTnsDescriptor(rawUrl)) {
        proxied.url = rewriteOracleTnsTarget(rawUrl, tunnel.localHost, tunnel.localPort)
        return proxied
      }
      const easy = parseOracleEasyConnectTarget(rawUrl, profile.ssl)
      if (easy) {
        proxied.url = `${easy.schemePrefix}${tunnel.localHost}:${tunnel.localPort}${easy.tail}`
        return proxied
      }
    }
    if (HAS_URI_SCHEME_RE.test(rawUrl)) {
      if (profile.driver === 'mongodb' && hasMultiHostMongoAuthority(rawUrl)) {
        throw new Error(
          'SSH tunneling cannot be used with multi-host MongoDB URIs. Use a single mongodb://host:port URI or explicit Host/Port fields instead.'
        )
      }
      let parsed: URL
      try {
        parsed = new URL(rawUrl)
      } catch {
        throw new Error(
          `SSH tunneling could not parse the connection URL for driver '${profile.driver}'. Use a single-host URI or explicit Host/Port fields instead.`
        )
      }
      if (!parsed.hostname) {
        throw new Error(
          `SSH tunneling requires a valid hostname in the connection URL for driver '${profile.driver}'.`
        )
      }
      parsed.hostname = tunnel.localHost
      parsed.port = String(tunnel.localPort)
      proxied.url = parsed.toString()
      return proxied
    }
    if (profile.driver === 'mssql') {
      const rewrittenAdo = rewriteAdoNetServerTarget(
        rawUrl,
        tunnel.localHost,
        tunnel.localPort
      )
      if (rewrittenAdo) {
        proxied.url = rewrittenAdo
        return proxied
      }
      if (!/(?:^|;)\s*(?:Server|Data Source)\s*=\s*[^;\s]+/i.test(rawUrl)) {
        return proxied
      }
    }
    throw new Error(
      `SSH tunneling could not rewrite connection URL for driver '${profile.driver}'. Use a standard single-host URI or explicit Host/Port fields instead.`
    )
  }

  if (!rawUrl && profile.driver === 'oracle' && rawHost) {
    if (isOracleTnsDescriptor(rawHost)) {
      proxied.host = rewriteOracleTnsTarget(rawHost, tunnel.localHost, tunnel.localPort)
      return proxied
    }
    if (rawHost.includes('/')) {
      const easy = parseOracleEasyConnectTarget(rawHost, profile.ssl)
      if (easy) {
        proxied.host = `${easy.schemePrefix}${tunnel.localHost}:${tunnel.localPort}${easy.tail}`
        return proxied
      }
    }
  }

  return proxied
}

export function shouldProfileUseSshTunnel(profile: ConnectionProfile): boolean {
  if (!profile.sshEnabled) return false
  if (FILE_BASED_BYOD_DRIVERS.has(profile.driver.trim().toLowerCase())) {
    const hasFile = typeof profile.filePath === 'string' && profile.filePath.trim().length > 0
    const hasRemoteHost =
      (typeof profile.host === 'string' && profile.host.trim().length > 0) ||
      (typeof profile.url === 'string' && profile.url.trim().length > 0)
    if (hasFile || !hasRemoteHost) return false
  }
  return SSH_TUNNEL_ENGINES.has(profile.driver) || isByodDriverId(profile.driver)
}

export class SessionManager {
  private readonly activeSessions = new Map<string, IDatabaseSession>()
  private readonly pendingSessions = new Map<string, Promise<IDatabaseSession>>()
  private readonly activeTunnels = new Set<SshTunnelHandle>()
  private readonly tunnelOwners = new Map<SshTunnelHandle, string>()
  private readonly healthPolicies = new Map<string, HealthPolicy>()
  private readonly generations = new Map<string, number>()
  private readonly connectionMutationChains = new Map<string, Promise<void>>()
  private readonly activeMutationContext = new AsyncLocalStorage<Set<string>>()
  private storageOpChain: Promise<void> = Promise.resolve()
  private readonly storageLockContext = new AsyncLocalStorage<boolean>()
  private globalGeneration = 0
  private readonly orca: SessionManagerHostApi
  private readonly challengeStore?: SshHostKeyChallengeStore
  private readonly onSessionClosed?: (connectionId: string) => Promise<void> | void
  private driverManager?: { resolveVerifiedAdapter(driverId: string): Promise<IDatabaseDriver> }

  constructor(orca: SessionManagerHostApi, options?: SessionManagerOptions) {
    this.orca = orca
    this.challengeStore = options?.challengeStore
    this.onSessionClosed = options?.onSessionClosed
  }

  setDriverManager(driverManager: {
    resolveVerifiedAdapter(driverId: string): Promise<IDatabaseDriver>
  }): void {
    this.driverManager = driverManager
  }

  private async resolveDriver(driverType: DatabaseDriverType): Promise<IDatabaseDriver> {
    if (BUILTIN_ENGINE_CATALOG.some((e) => e.id === driverType)) {
      return await loadBuiltinDriver(driverType)
    }
    if (this.driverManager) {
      return await this.driverManager.resolveVerifiedAdapter(driverType)
    }
    throw new Error(`Unsupported database driver: ${String(driverType)}`)
  }

  private getGeneration(connectionId: string): number {
    return (this.generations.get(connectionId) ?? 0) + this.globalGeneration
  }

  private bumpGeneration(connectionId: string): void {
    this.generations.set(connectionId, (this.generations.get(connectionId) ?? 0) + 1)
  }

  /**
   * Serializes profile/secret mutations and atomic connect-snapshot reads per `connectionId`
   * while bumping the connection generation so concurrent connects fail closed cleanly.
   */
  async withConnectionMutation<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
    this.bumpGeneration(connectionId)
    const prev = this.connectionMutationChains.get(connectionId) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = prev.then(() => next)
    this.connectionMutationChains.set(connectionId, tail)
    await prev.catch(() => {})
    const activeIds = new Set(this.activeMutationContext.getStore())
    activeIds.add(connectionId)
    try {
      this.bumpGeneration(connectionId)
      return await this.activeMutationContext.run(activeIds, fn)
    } finally {
      this.bumpGeneration(connectionId)
      release()
      if (this.connectionMutationChains.get(connectionId) === tail) {
        this.connectionMutationChains.delete(connectionId)
      }
    }
  }

  /**
   * Serializes multi-key connection storage writes/rollbacks so concurrent reads never
   * observe partially written or uncommitted connection profiles.
   */
  async withConnectionStorageLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.storageLockContext.getStore() === true) {
      return await fn()
    }
    const prev = this.storageOpChain
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    this.storageOpChain = prev.then(() => next)
    await prev.catch(() => {})
    try {
      return await this.storageLockContext.run(true, fn)
    } finally {
      release()
    }
  }

  private async snapshotConnectionForConnect(connectionId: string): Promise<{
    expectedGen: number
    profile: ConnectionProfile
    secret: string | undefined
    extraSecrets: ExtendedSecrets
  }> {
    const pendingMutation = this.connectionMutationChains.get(connectionId)
    if (pendingMutation) {
      await pendingMutation.catch(() => {})
    }
    const expectedGen = this.getGeneration(connectionId)
    const profile = await this.findProfile(connectionId)
    if (!profile) {
      const err = new Error(`Connection '${connectionId}' not found in storage`) as Error & {
        code: string
      }
      err.code = 'invalid_params'
      throw err
    }

    const shouldFetchSecret =
      profile.driver === 'libsql' || profile.driver === 'd1'
        ? profile.hasAuthToken !== false
        : Boolean(profile.hasPassword)
    const [secret, extraSecrets, hopSecrets] = await Promise.all([
      shouldFetchSecret ? this.getSecret(connectionId, profile.driver) : Promise.resolve(undefined),
      this.getExtendedSecrets(connectionId),
      profile.sshJumpHosts && profile.sshJumpHosts.length > 0
        ? this.getHopSecrets(connectionId, profile.sshJumpHosts)
        : Promise.resolve(undefined),
    ])
    if (hopSecrets) {
      extraSecrets.sshJumpHopSecrets = hopSecrets
    }
    if (this.getGeneration(connectionId) !== expectedGen) {
      throw new Error(`Session initialization for '${connectionId}' was superseded by close/update`)
    }
    return { expectedGen, profile, secret, extraSecrets }
  }

  /**
   * Retrieves all user-persisted connection profiles from Orca storage after any in-flight write settles.
   */
  async getStoredConnections(): Promise<ConnectionProfile[]> {
    if (this.storageLockContext.getStore() !== true) {
      await this.storageOpChain.catch(() => {})
    }
    const primary = (await this.orca.storage.get(
      SAVED_CONNECTIONS_STORAGE_KEY
    )) as ConnectionProfile[] | null
    if (Array.isArray(primary)) return primary

    const fallback = (await this.orca.storage.get('connections')) as ConnectionProfile[] | null
    if (Array.isArray(fallback)) return fallback

    return []
  }

  /**
   * Persists connection profiles to Orca storage atomically across both primary and legacy keys.
   */
  async saveStoredConnections(connections: ConnectionProfile[]): Promise<void> {
    return await this.withConnectionStorageLock(async () => {
      const sanitized = sanitizeJsonPayload(connections) as unknown as JsonValue
      const prevPrimary = await this.orca.storage.get(SAVED_CONNECTIONS_STORAGE_KEY)
      await this.orca.storage.get('connections')
      await this.orca.storage.set(SAVED_CONNECTIONS_STORAGE_KEY, sanitized)
      try {
        await this.orca.storage.set('connections', sanitized)
      } catch (err) {
        try {
          if (prevPrimary === null || prevPrimary === undefined) {
            if (typeof this.orca.storage.delete === 'function') {
              await this.orca.storage.delete(SAVED_CONNECTIONS_STORAGE_KEY)
            } else {
              await this.orca.storage.set(SAVED_CONNECTIONS_STORAGE_KEY, null as unknown as JsonValue)
            }
          } else {
            await this.orca.storage.set(SAVED_CONNECTIONS_STORAGE_KEY, prevPrimary)
          }
        } catch {
          // Best-effort rollback of primary storage key
        }
        throw err
      }
    })
  }

  /**
   * Verifies that Orca's OS keyring is available before persisting any non-empty secret.
   */
  async assertSecureSecretStorage(): Promise<void> {
    const readStatus = (res: unknown): string | undefined => {
      if (typeof res === 'string') return res
      if (res && typeof res === 'object') {
        const value = (res as { status?: unknown }).status
        if (typeof value === 'string') return value
      }
      return undefined
    }
    let status: string | undefined
    try {
      if (typeof this.orca.secrets.protection === 'function') {
        status = readStatus(await this.orca.secrets.protection())
      } else if (
        this.orca.host &&
        typeof this.orca.host.call === 'function' &&
        (typeof this.orca.host.has !== 'function' || this.orca.host.has('secrets.protection'))
      ) {
        status = readStatus(await this.orca.host.call('secrets.protection'))
      }
    } catch {
      status = undefined
    }
    if (status !== 'os-keyring') {
      throw new Error(
        'Cannot save credentials securely because Orca OS keyring protection is unavailable on this machine.'
      )
    }
  }

  /**
   * Saves password (`pwd_${connectionId}`), authToken (`tok_${connectionId}`) and the
   * Phase 4 secrets (`sslkey_`, `sshpass_`, `sshpwd_`) into Orca's encrypted secrets vault.
   */
  async saveSecret(
    connectionId: string,
    secrets: {
      password?: string
      authToken?: string
      sslKeyPassphrase?: string
      sshPassphrase?: string
      sshPassword?: string
    }
  ): Promise<void> {
    const hasNonEmptySecret = Boolean(
      secrets.password ||
        secrets.authToken ||
        secrets.sslKeyPassphrase ||
        secrets.sshPassphrase ||
        secrets.sshPassword
    )
    if (hasNonEmptySecret) {
      await this.assertSecureSecretStorage()
    }
    await this.writeSecret('pwd', connectionId, secrets.password)
    await this.writeSecret('tok', connectionId, secrets.authToken)
    await this.writeSecret('sslkey', connectionId, secrets.sslKeyPassphrase)
    await this.writeSecret('sshpass', connectionId, secrets.sshPassphrase)
    await this.writeSecret('sshpwd', connectionId, secrets.sshPassword)
  }

  private async writeSecret(
    prefix: string,
    connectionId: string,
    value: string | undefined
  ): Promise<void> {
    if (value === undefined) return
    const key = `${prefix}_${connectionId}`
    if (value) {
      await this.orca.secrets.set(key, value)
    } else {
      await this.orca.secrets.delete(key)
    }
  }

  /**
   * Reads the Phase 4 secrets (`sslkey_`, `sshpass_`, `sshpwd_`) for a connection.
   */
  async getExtendedSecrets(connectionId: string): Promise<ExtendedSecrets> {
    if (!connectionId) return {}
    const [sslKeyPassphrase, sshPassphrase, sshPassword] = await Promise.all([
      this.orca.secrets.get(`sslkey_${connectionId}`),
      this.orca.secrets.get(`sshpass_${connectionId}`),
      this.orca.secrets.get(`sshpwd_${connectionId}`),
    ])
    return {
      sslKeyPassphrase: sslKeyPassphrase || undefined,
      sshPassphrase: sshPassphrase || undefined,
      sshPassword: sshPassword || undefined,
    }
  }

  /**
   * Retrieves the password (`pwd_${id}`) or bearer token (`tok_${id}`) for LibSQL / D1.
   */
  async getSecret(
    connectionId: string,
    driver?: DatabaseDriverType
  ): Promise<string | undefined> {
    const key =
      driver === 'libsql' || driver === 'd1'
        ? `tok_${connectionId}`
        : `pwd_${connectionId}`
    const secret = await this.orca.secrets.get(key)
    return secret || undefined
  }

  /**
   * Reads per-hop SSH secrets (`sshhop_pwd_`, `sshhop_pass_`) for a profile's jump hosts.
   */
  async getHopSecrets(
    connectionId: string,
    jumpHosts: readonly SshJumpHostProfile[] | undefined
  ): Promise<Record<string, SshJumpHopSecret>> {
    return await getHopSecretsVault(this.orca.secrets, connectionId, jumpHosts)
  }

  /**
   * Persists or clears per-hop SSH secrets (`sshhop_pwd_`, `sshhop_pass_`) for the given `hopIds`.
   */
  async saveHopSecrets(
    connectionId: string,
    hopIds: readonly string[],
    secretsMap: Readonly<Record<string, SshJumpHopSecret>> | undefined
  ): Promise<void> {
    await saveHopSecretsVault(
      this.orca.secrets,
      connectionId,
      hopIds,
      secretsMap,
      () => this.assertSecureSecretStorage()
    )
  }

  /**
   * Copies per-hop SSH secrets from one connection profile to another.
   */
  async copyHopSecrets(
    sourceConnectionId: string,
    targetConnectionId: string,
    hopIds: readonly string[]
  ): Promise<void> {
    await copyHopSecretsVault(
      this.orca.secrets,
      sourceConnectionId,
      targetConnectionId,
      hopIds,
      () => this.assertSecureSecretStorage()
    )
  }

  /**
   * Purges `pwd_`, `tok_`, `sslkey_`, `sshpass_`, `sshpwd_`, and all `sshhop_pwd_`/`sshhop_pass_`
   * secrets for a deleted or rolled-back connection.
   */
  async deleteSecret(connectionId: string, hopIds: readonly string[] = []): Promise<void> {
    await deleteAllConnectionSecrets(this.orca.secrets, connectionId, hopIds)
  }

  /**
   * Copies all persisted secrets from one connection ID to another (used when duplicating profiles).
   */
  async copySecret(
    sourceConnectionId: string,
    targetConnectionId: string,
    prefixes: readonly string[] = ['pwd', 'tok', 'sslkey', 'sshpass', 'sshpwd']
  ): Promise<void> {
    if (!sourceConnectionId || !targetConnectionId || sourceConnectionId === targetConnectionId) {
      return
    }
    const values = await Promise.all(
      prefixes.map(async (prefix) => ({
        prefix,
        value: await this.orca.secrets.get(`${prefix}_${sourceConnectionId}`),
      }))
    )
    const toWrite = values.filter((entry) => Boolean(entry.value))
    if (toWrite.length === 0) return
    await this.assertSecureSecretStorage()
    const results = await Promise.allSettled(
      toWrite.map(async ({ prefix, value }) => {
        if (value) {
          await this.orca.secrets.set(`${prefix}_${targetConnectionId}`, value)
        }
      })
    )
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (rejected) {
      throw rejected.reason
    }
  }

  /**
   * Locates a connection profile by ID strictly from Orca storage (never crawls filesystem).
   */
  async findProfile(connectionId: string): Promise<ConnectionProfile | null> {
    if (!connectionId || connectionId.startsWith('ws_')) {
      return null
    }
    if (!this.activeMutationContext.getStore()?.has(connectionId)) {
      const pendingMutation = this.connectionMutationChains.get(connectionId)
      if (pendingMutation) {
        await pendingMutation.catch(() => {})
      }
    }
    const list = await this.getStoredConnections()
    return list.find((c) => c.id === connectionId) ?? null
  }

  private getOrCreateHealthPolicy(connectionId: string): HealthPolicy {
    let policy = this.healthPolicies.get(connectionId)
    if (!policy) {
      policy = new HealthPolicy()
      this.healthPolicies.set(connectionId, policy)
    }
    return policy
  }

  getHealthSnapshot(connectionId: string): HealthPolicySnapshot {
    return this.getOrCreateHealthPolicy(connectionId).getSnapshot()
  }

  beginSessionReconnect(connectionId: string): {
    allowed: boolean
    backoffMs: number
    state: ConnectionHealthState
  } {
    const session = this.activeSessions.get(connectionId)
    const txState = session?.getTransactionState?.() as
      | { active?: boolean; inTransaction?: boolean }
      | undefined
    const txActive = Boolean(txState?.active || txState?.inTransaction)
    return this.getOrCreateHealthPolicy(connectionId).beginReconnect(txActive)
  }

  parkSession(connectionId: string): ConnectionHealthState {
    return this.getOrCreateHealthPolicy(connectionId).park()
  }

  /**
   * Returns an active database session for the connection ID, creating and caching it if needed.
   * Deduplicates concurrent in-flight creation requests for the same connectionId.
   */
  async getSession(
    connectionId: string,
    opts?: { sshRetryToken?: string }
  ): Promise<IDatabaseSession> {
    const existing = this.activeSessions.get(connectionId)
    if (existing) {
      if (typeof existing.isAlive !== 'function' || existing.isAlive()) {
        this.getOrCreateHealthPolicy(connectionId).recordSuccess()
        return existing
      }
      this.getOrCreateHealthPolicy(connectionId).recordFailure('Session is no longer alive')
      this.activeSessions.delete(connectionId)
      void existing.close().catch(() => {})
    }

    const retryToken =
      typeof opts?.sshRetryToken === 'string' && opts.sshRetryToken.trim()
        ? opts.sshRetryToken.trim()
        : undefined
    const inFlight = !retryToken ? this.pendingSessions.get(connectionId) : undefined
    if (inFlight) {
      return inFlight
    }

    const createPromise = (async () => {
      try {
        const { expectedGen, profile, secret, extraSecrets } =
          await this.snapshotConnectionForConnect(connectionId)
        const extraWithRetry = retryToken
          ? { ...extraSecrets, sshRetryToken: retryToken }
          : extraSecrets
        const session = await this.openSessionWithTunnel(profile, secret, extraWithRetry)
        if (this.getGeneration(connectionId) !== expectedGen) {
          await session.close().catch(() => {})
          throw new Error(`Session initialization for '${connectionId}' was superseded by close/update`)
        }
        this.activeSessions.set(connectionId, session)
        this.getOrCreateHealthPolicy(connectionId).recordSuccess()
        return session
      } catch (err: unknown) {
        if (!(err instanceof SshHostKeyVerificationError)) {
          const msg = scrubCredentialsInText(err instanceof Error ? err.message : String(err))
          this.getOrCreateHealthPolicy(connectionId).recordFailure(msg)
        }
        throw err
      }
    })()

    if (!retryToken) {
      this.pendingSessions.set(connectionId, createPromise)
    }
    try {
      return await createPromise
    } finally {
      if (this.pendingSessions.get(connectionId) === createPromise) {
        this.pendingSessions.delete(connectionId)
      }
    }
  }

  /**
   * Resolves the SSH forwarding target and TLS override for a profile.
   * SSH tunneling only applies to TCP engines; file-based drivers (including DuckDB BYOD) pass through untouched.
   */
  private shouldTunnel(profile: ConnectionProfile): boolean {
    return shouldProfileUseSshTunnel(profile)
  }

  private buildDriverTlsOptions(
    extraSecrets?: ExtendedSecrets,
    tlsServername?: string
  ): DriverTlsOptions | undefined {
    if (!extraSecrets && !tlsServername) return undefined
    const options: DriverTlsOptions = {
      sslKeyPassphrase: extraSecrets?.sslKeyPassphrase,
      tlsServername,
    }
    return options
  }

  private resolveTunnelTarget(profile: ConnectionProfile): {
    targetHost: string
    targetPort: number
  } {
    return resolveSshTunnelTarget(profile)
  }

  private buildProxiedProfile(
    profile: ConnectionProfile,
    tunnel: SshTunnelHandle
  ): ConnectionProfile {
    return buildTunnelProxiedProfile(profile, tunnel)
  }

  private trackTunnel(tunnel: SshTunnelHandle, ownerId: string): void {
    this.activeTunnels.add(tunnel)
    this.tunnelOwners.set(tunnel, ownerId)
  }

  private async releaseTunnel(tunnel: SshTunnelHandle): Promise<void> {
    this.activeTunnels.delete(tunnel)
    this.tunnelOwners.delete(tunnel)
    try {
      await tunnel.close()
    } catch (e) {
      const msg = scrubCredentialsInText(e instanceof Error ? e.message : String(e))
      this.orca.log(`[SessionManager] Error closing SSH tunnel: ${msg}`)
    }
  }

  /** Closes any tunnel already forwarding for a connection invalidated mid-`createSession` */
  private async closeOwnedTunnels(connectionId: string): Promise<void> {
    const owned = Array.from(this.tunnelOwners)
      .filter(([, ownerId]) => ownerId === connectionId)
      .map(([tunnel]) => tunnel)
    await Promise.all(owned.map(async (tunnel) => await this.releaseTunnel(tunnel)))
  }

  private isLikelyNonTlsAuthError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false
    const rec = err as { code?: unknown; message?: unknown }
    const code = typeof rec.code === 'string' || typeof rec.code === 'number' ? String(rec.code).trim() : ''
    const msg = typeof rec.message === 'string' ? rec.message : ''
    if (
      code === '28P01' ||
      code === '1045' ||
      code === '18456' ||
      code === 'ORA-01017'
    ) {
      return true
    }
    return /password authentication failed|invalid username\/password|access denied for user|login failed for user/i.test(
      msg
    )
  }

  private hasExplicitTlsErrorSignal(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false
    const rec = err as { code?: unknown; cause?: unknown }
    const codes = [
      typeof rec.code === 'string' ? rec.code : '',
      rec.cause && typeof rec.cause === 'object' && 'code' in rec.cause
        ? String((rec.cause as { code?: unknown }).code ?? '')
        : '',
    ]
    return codes.some((c) =>
      /^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_VERIFY_|UNABLE_TO_GET_ISSUER_|HOSTNAME_MISMATCH|EPROTO|TLS\.)/i.test(
        c.trim()
      )
    )
  }

  private async maybeDiagnoseConnectionTlsFailure(
    profile: ConnectionProfile,
    probeHost: string,
    probePort: number,
    originalServername: string | undefined,
    err: unknown
  ): Promise<TlsFailure | undefined> {
    if (!TCP_TLS_PROBE_DRIVERS.has(profile.driver)) return undefined
    if (err instanceof SshHostKeyVerificationError) return undefined
    if (this.isLikelyNonTlsAuthError(err)) return undefined
    if (!probeHost || !Number.isInteger(probePort) || probePort < 1 || probePort > 65535) {
      return undefined
    }
    try {
      const diagnosed = await diagnoseTlsFailure({
        driver: profile.driver,
        host: probeHost,
        port: probePort,
        originalServername: originalServername || probeHost,
        sslMode: profile.sslMode,
        error: err,
      })
      if (
        diagnosed.kind !== 'Other' ||
        Boolean(diagnosed.fingerprintSha256) ||
        this.hasExplicitTlsErrorSignal(err)
      ) {
        return diagnosed
      }
      return undefined
    } catch {
      return undefined
    }
  }

  private buildSshHopChainSignature(profile: ConnectionProfile): string {
    const target = this.resolveTunnelTarget(profile)
    const hops = (profile.sshJumpHosts ?? []).map((h) => [
      h.hopId,
      h.host.trim().toLowerCase(),
      h.port ?? 22,
      h.user ?? '',
      h.authMethod ?? '',
      h.privateKeyPath ?? '',
    ])
    return createHash('sha256')
      .update(
        JSON.stringify([
          profile.driver,
          target.targetHost.toLowerCase(),
          target.targetPort,
          (profile.sshHost ?? '').trim().toLowerCase(),
          profile.sshPort ?? 22,
          profile.sshUser ?? '',
          profile.sshAuthMethod ?? '',
          profile.sshPrivateKeyPath ?? '',
          hops,
        ])
      )
      .digest('hex')
      .slice(0, 24)
  }

  private resolveSshPinScopeKey(
    profile: ConnectionProfile,
    extraSecrets?: ExtendedSecrets
  ): string {
    const explicitId = typeof profile.id === 'string' ? profile.id.trim() : ''
    if (explicitId) return explicitId
    const hopSignature = this.buildSshHopChainSignature(profile)
    const digest = createHash('sha256')
      .update(JSON.stringify([extraSecrets?.panelId ?? '', hopSignature]))
      .digest('hex')
      .slice(0, 24)
    return `unsaved_${digest}`
  }

  private mintHostKeyChallengeError(
    err: SshHostKeyVerificationError,
    panelId?: string,
    scopeKey?: string,
    hopSignature?: string,
    retryToken?: string
  ): SshHostKeyVerificationError {
    if (!this.challengeStore) return err
    const minted = err.sshChallenge.challengeId
      ? retryToken && !err.sshChallenge.retryToken
        ? { ...err.sshChallenge, retryToken }
        : err.sshChallenge
      : this.challengeStore.mint(err.sshChallenge, panelId, {
          scopeKey,
          hopSignature,
          retryToken,
        })
    if (!err.sshChallenge.challengeId) {
      try {
        this.orca.panels?.post?.('ssh.hostKeyChallenge', sanitizeJsonPayload(minted))
      } catch {
        // Ignore broadcast error in minimal hosts
      }
    }
    return new SshHostKeyVerificationError(err.message, minted)
  }

  private async openTrackedSshTunnel(
    profile: ConnectionProfile,
    target: { targetHost: string; targetPort: number },
    extraSecrets: ExtendedSecrets | undefined,
    retryToken?: string
  ): Promise<SshTunnelHandle> {
    const store = this.challengeStore
    const scopeKey = this.resolveSshPinScopeKey(profile, extraSecrets)
    const hopSignature = this.buildSshHopChainSignature(profile)
    const effectiveRetryToken = retryToken ?? extraSecrets?.sshRetryToken
    try {
      const tunnel = await openSshTunnel(profile, target.targetHost, target.targetPort, {
        secrets: {
          sshPassphrase: extraSecrets?.sshPassphrase,
          sshPassword: extraSecrets?.sshPassword,
        },
        hopSecrets: extraSecrets?.sshJumpHopSecrets,
        consumeTrustedHostKeyPin: store
          ? (host: string, port: number, exactFingerprint: string) =>
              store.consumePin(
                scopeKey,
                host,
                port,
                exactFingerprint,
                hopSignature,
                effectiveRetryToken
              )
          : undefined,
        connectionId: profile.id,
        panelId: extraSecrets?.panelId,
      })
      return tunnel
    } catch (err: unknown) {
      if (err instanceof SshHostKeyVerificationError) {
        throw this.mintHostKeyChallengeError(
          err,
          extraSecrets?.panelId,
          scopeKey,
          hopSignature,
          effectiveRetryToken
        )
      }
      throw err
    }
  }

  /**
   * Runs `task` against either the direct profile or a `127.0.0.1:<localPort>` proxied profile,
   * running credential-less TLS probes INSIDE the tunnel when `sshEnabled: true` before closing
   * the temporary SSH tunnel afterwards (used by `connection.test`).
   */
  private async withTunnel<T>(
    profile: ConnectionProfile,
    extraSecrets: ExtendedSecrets | undefined,
    task: (target: ConnectionProfile, tlsOptions: DriverTlsOptions | undefined) => Promise<T>,
    retryToken?: string
  ): Promise<T> {
    if (!this.shouldTunnel(profile)) {
      const target = TCP_TLS_PROBE_DRIVERS.has(profile.driver)
        ? this.resolveTunnelTarget(profile)
        : null
      const profileSni = profile.tlsServername?.trim() || undefined
      try {
        return await task(profile, this.buildDriverTlsOptions(extraSecrets, profileSni))
      } catch (err: unknown) {
        if (target) {
          const tlsFailure = await this.maybeDiagnoseConnectionTlsFailure(
            profile,
            target.targetHost,
            target.targetPort,
            profileSni || target.targetHost,
            err
          )
          if (tlsFailure && err instanceof Error) {
            ;(err as Error & { tlsFailure?: TlsFailure }).tlsFailure = tlsFailure
          }
        }
        throw err
      }
    }

    const target = this.resolveTunnelTarget(profile)
    const tunnelSni = profile.tlsServername?.trim() || target.targetHost
    const tunnel = await this.openTrackedSshTunnel(profile, target, extraSecrets, retryToken)
    this.trackTunnel(tunnel, profile.id)
    try {
      const proxied = this.buildProxiedProfile(profile, tunnel)
      const tlsOpts = this.buildDriverTlsOptions(extraSecrets, tunnelSni)
      try {
        return await task(proxied, tlsOpts)
      } catch (err: unknown) {
        const tlsFailure = await this.maybeDiagnoseConnectionTlsFailure(
          profile,
          tunnel.localHost,
          tunnel.localPort,
          tunnelSni,
          err
        )
        if (tlsFailure && err instanceof Error) {
          ;(err as Error & { tlsFailure?: TlsFailure }).tlsFailure = tlsFailure
        }
        throw err
      }
    } finally {
      await this.releaseTunnel(tunnel)
    }
  }

  /**
   * Opens a driver session for a profile, routing TCP engines through an SSH tunnel when enabled.
   * Any tunnel is closed on failure and on session `close()`.
   */
  async openSessionWithTunnel(
    profile: ConnectionProfile,
    secret?: string,
    extraSecrets?: ExtendedSecrets
  ): Promise<IDatabaseSession> {
    const driver = await this.resolveDriver(profile.driver)
    if (!this.shouldTunnel(profile)) {
      const profileSni = profile.tlsServername?.trim() || undefined
      try {
        return await driver.createSession(
          profile,
          secret,
          this.buildDriverTlsOptions(extraSecrets, profileSni)
        )
      } catch (err: unknown) {
        if (TCP_TLS_PROBE_DRIVERS.has(profile.driver)) {
          const target = this.resolveTunnelTarget(profile)
          const tlsFailure = await this.maybeDiagnoseConnectionTlsFailure(
            profile,
            target.targetHost,
            target.targetPort,
            profileSni || target.targetHost,
            err
          )
          if (tlsFailure && err instanceof Error) {
            ;(err as Error & { tlsFailure?: TlsFailure }).tlsFailure = tlsFailure
          }
        }
        throw err
      }
    }

    const expectedGen = this.getGeneration(profile.id)
    const target = this.resolveTunnelTarget(profile)
    const tunnelSni = profile.tlsServername?.trim() || target.targetHost
    const scopeKey = this.resolveSshPinScopeKey(profile, extraSecrets)
    const hopSignature = this.buildSshHopChainSignature(profile)
    const retryToken = this.challengeStore?.beginRetryScope(
      scopeKey,
      hopSignature,
      extraSecrets?.sshRetryToken
    )
    let keepRetryPins = false
    let tunnel: SshTunnelHandle
    try {
      tunnel = await this.openTrackedSshTunnel(profile, target, extraSecrets, retryToken)
    } catch (err: unknown) {
      if (err instanceof SshHostKeyVerificationError) {
        keepRetryPins = true
        throw this.mintHostKeyChallengeError(
          err,
          extraSecrets?.panelId,
          scopeKey,
          hopSignature,
          retryToken
        )
      }
      throw err
    } finally {
      this.challengeStore?.endRetryScope(scopeKey, {
        keepPins: keepRetryPins,
        hopSignature,
        retryToken,
      })
    }
    this.trackTunnel(tunnel, profile.id)
    const superseded = (): Error =>
      new Error(`SSH tunnel for '${profile.id}' was superseded by close/update`)

    // closeSession()/closeAll() may have run while the ssh handshake was in flight
    if (this.getGeneration(profile.id) !== expectedGen) {
      await this.releaseTunnel(tunnel)
      throw superseded()
    }

    let session: IDatabaseSession
    try {
      session = await driver.createSession(
        this.buildProxiedProfile(profile, tunnel),
        secret,
        this.buildDriverTlsOptions(extraSecrets, tunnelSni)
      )
    } catch (err: unknown) {
      const tlsFailure = await this.maybeDiagnoseConnectionTlsFailure(
        profile,
        tunnel.localHost,
        tunnel.localPort,
        tunnelSni,
        err
      )
      if (tlsFailure && err instanceof Error) {
        ;(err as Error & { tlsFailure?: TlsFailure }).tlsFailure = tlsFailure
      }
      await this.releaseTunnel(tunnel)
      throw err
    }

    if (this.getGeneration(profile.id) !== expectedGen) {
      await session.close().catch(() => {})
      await this.releaseTunnel(tunnel)
      throw superseded()
    }

    const originalIsAlive = session.isAlive.bind(session)
    const closeSession = session.close.bind(session)
    let closed = false
    session.isAlive = (): boolean => originalIsAlive() && tunnel.isAlive()
    session.close = async (): Promise<void> => {
      if (closed) return
      closed = true
      try {
        await closeSession()
      } finally {
        await this.releaseTunnel(tunnel)
      }
    }
    return session
  }

  /**
   * Tests a connection (without caching a session), keeping any temporary SSH tunnel scoped
   * to the duration of the test while diagnosing TLS failures inside the active tunnel and
   * preserving `SshHostKeyVerificationError` without penalizing `HealthPolicy`.
   */
  async testConnection(
    profile: ConnectionProfile,
    secret?: string,
    extraSecrets?: ExtendedSecrets
  ): Promise<{
    ok: boolean
    message?: string
    tlsFailure?: TlsFailure
    sshChallenge?: SshHostKeyChallenge
  }> {
    const useRetryScope = this.shouldTunnel(profile)
    const scopeKey = useRetryScope ? this.resolveSshPinScopeKey(profile, extraSecrets) : ''
    const hopSignature = useRetryScope ? this.buildSshHopChainSignature(profile) : ''
    const retryToken =
      useRetryScope && this.challengeStore
        ? this.challengeStore.beginRetryScope(scopeKey, hopSignature, extraSecrets?.sshRetryToken)
        : undefined
    let keepRetryPins = false
    try {
      const driver = await this.resolveDriver(profile.driver)
      const outcome = await this.withTunnel(
        profile,
        extraSecrets,
        async (target, tlsOptions) => {
          const res = await driver.testConnection(target, secret, tlsOptions)
          if (res.ok) {
            return res as { ok: boolean; message?: string; tlsFailure?: TlsFailure }
          }
          const probeHost =
            typeof target.host === 'string' && target.host.trim()
              ? target.host.trim()
              : TCP_TLS_PROBE_DRIVERS.has(profile.driver)
                ? this.resolveTunnelTarget(profile).targetHost
                : ''
          const probePort =
            typeof target.port === 'number' && target.port > 0
              ? target.port
              : TCP_TLS_PROBE_DRIVERS.has(profile.driver)
                ? this.resolveTunnelTarget(profile).targetPort
                : 0
          const tlsFailure = await this.maybeDiagnoseConnectionTlsFailure(
            profile,
            probeHost,
            probePort,
            tlsOptions?.tlsServername ?? probeHost,
            new Error(res.message || 'Connection test failed')
          )
          return {
            ...res,
            ...(tlsFailure ? { tlsFailure } : {}),
          }
        },
        retryToken
      )

      if (profile.id) {
        if (outcome.ok) {
          this.getOrCreateHealthPolicy(profile.id).recordSuccess()
        } else {
          const msg =
            typeof outcome.message === 'string'
              ? scrubCredentialsInText(outcome.message)
              : 'Connection test failed'
          this.getOrCreateHealthPolicy(profile.id).recordFailure(msg)
        }
      }
      if (!outcome.ok && typeof outcome.message === 'string') {
        return {
          ...outcome,
          message: appendActionableTlsErrorHint(scrubCredentialsInText(outcome.message)),
        }
      }
      return outcome
    } catch (err: unknown) {
      if (err instanceof SshHostKeyVerificationError) {
        keepRetryPins = true
        // Skip HealthPolicy.recordFailure on interactive host-key verification challenges
        const enhanced = this.mintHostKeyChallengeError(
          err,
          extraSecrets?.panelId,
          scopeKey,
          hopSignature,
          retryToken
        )
        return {
          ok: false,
          message: scrubCredentialsInText(enhanced.message),
          sshChallenge: enhanced.sshChallenge,
        }
      }
      if (profile.id) {
        const msg = scrubCredentialsInText(err instanceof Error ? err.message : String(err))
        this.getOrCreateHealthPolicy(profile.id).recordFailure(msg)
      }
      const tlsFailure =
        err && typeof err === 'object' && 'tlsFailure' in err
          ? (err as { tlsFailure?: TlsFailure }).tlsFailure
          : undefined
      if (tlsFailure) {
        const rawMsg = err instanceof Error ? err.message : String(err)
        return {
          ok: false,
          message: appendActionableTlsErrorHint(scrubCredentialsInText(rawMsg)),
          tlsFailure,
        }
      }
      throw err
    } finally {
      if (useRetryScope) {
        this.challengeStore?.endRetryScope(scopeKey, {
          keepPins: keepRetryPins,
          hopSignature,
          retryToken,
        })
      }
    }
  }

  hasActiveSession(connectionId: string): boolean {
    const existing = this.activeSessions.get(connectionId)
    return Boolean(existing && (typeof existing.isAlive !== 'function' || existing.isAlive()))
  }

  getActiveSessions(): Map<string, IDatabaseSession> {
    return this.activeSessions
  }

  private async closeWithGrace(fn: () => Promise<void>, graceMs = 5_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        fn(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, graceMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Closes and unregisters a single cached session.
   * Always closes the DB session gracefully BEFORE tearing down its SSH tunnel so
   * clean protocol shutdown (e.g. PG Terminate / MySQL COM_QUIT / rollback) succeeds.
   */
  async closeSession(connectionId: string): Promise<void> {
    this.bumpGeneration(connectionId)
    this.pendingSessions.delete(connectionId)
    this.healthPolicies.delete(connectionId)
    if (this.onSessionClosed) {
      try {
        await this.onSessionClosed(connectionId)
      } catch {
        // Best-effort pre-close cleanup
      }
    }
    const session = this.activeSessions.get(connectionId)
    if (session) {
      this.activeSessions.delete(connectionId)
      try {
        await this.closeWithGrace(() => session.close())
      } catch (e) {
        const msg = scrubCredentialsInText(e instanceof Error ? e.message : String(e))
        this.orca.log(`[SessionManager] Error closing session [${connectionId}]: ${msg}`)
      }
    }
    await this.closeOwnedTunnels(connectionId)
  }

  /**
   * Closes all cached or pending sessions whose profile uses the specified driver.
   */
  async closeSessionsByDriver(driverId: string): Promise<void> {
    if (!driverId) return
    const targetIds = new Set<string>()
    for (const [connId, session] of this.activeSessions.entries()) {
      if (session.driverType === driverId) {
        targetIds.add(connId)
      }
    }
    try {
      const stored = await this.getStoredConnections()
      for (const profile of stored) {
        if (profile?.id && profile.driver === driverId) {
          targetIds.add(profile.id)
        }
      }
    } catch {
      // Best-effort lookup; active sessions already collected above
    }
    await Promise.all(Array.from(targetIds).map(async (connId) => await this.closeSession(connId)))
  }

  /**
   * Closes all active sessions on shutdown (DB sessions first with bounded grace, then SSH tunnels).
   */
  async closeAll(): Promise<void> {
    this.globalGeneration += 1
    const activeIds = Array.from(this.activeSessions.keys())
    if (this.onSessionClosed) {
      for (const connId of activeIds) {
        try {
          await this.onSessionClosed(connId)
        } catch {
          // Best-effort pre-close cleanup
        }
      }
    }
    this.pendingSessions.clear()
    this.healthPolicies.clear()
    const sessions = Array.from(this.activeSessions.values())
    this.activeSessions.clear()
    await Promise.all(
      sessions.map(async (session) => {
        try {
          await this.closeWithGrace(() => session.close())
        } catch (e) {
          const msg = scrubCredentialsInText(e instanceof Error ? e.message : String(e))
          this.orca.log(`[SessionManager] Error closing session on shutdown: ${msg}`)
        }
      })
    )
    const tunnels = Array.from(this.activeTunnels)
    this.activeTunnels.clear()
    this.tunnelOwners.clear()
    await Promise.all(
      tunnels.map(async (tunnel) => {
        try {
          await tunnel.close()
        } catch (e) {
          const msg = scrubCredentialsInText(e instanceof Error ? e.message : String(e))
          this.orca.log(`[SessionManager] Error closing SSH tunnel on shutdown: ${msg}`)
        }
      })
    )
  }
}
