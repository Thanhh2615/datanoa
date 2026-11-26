import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import type { ConnectionProfile, DatabaseDriverType } from '../protocol'
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
import { openSshTunnel } from '../drivers/common/tls-and-tunnel'
import {
  BUILTIN_ENGINE_CATALOG,
  getDefaultPortForDriver,
} from '../drivers/common/engine-catalog'
import { appendActionableTlsErrorHint, scrubCredentialsInText } from './worker-utils'

/** TCP engines that can be reached through an SSH bastion */
const SSH_TUNNEL_ENGINES: ReadonlySet<DatabaseDriverType> = new Set(
  BUILTIN_ENGINE_CATALOG.filter((engine) => engine.supportsSshTunnel).map((engine) => engine.id)
)

/** Secrets held only in `orca.secrets` (never persisted on the ConnectionProfile) */
export interface ExtendedSecrets {
  sslKeyPassphrase?: string
  sshPassphrase?: string
  sshPassword?: string
}

export interface SessionManagerHostApi {
  storage: Pick<OrcaWorkerApi['storage'], 'get' | 'set'>
  secrets: Pick<OrcaWorkerApi['secrets'], 'get' | 'set' | 'delete'> & {
    protection?: () => Promise<string | { status?: string }>
  }
  host?: Pick<OrcaWorkerApi['host'], 'call' | 'has'>
  log: OrcaWorkerApi['log']
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
  private globalGeneration = 0
  private readonly orca: SessionManagerHostApi
  private driverManager?: { resolveVerifiedAdapter(driverId: string): Promise<IDatabaseDriver> }

  constructor(orca: SessionManagerHostApi) {
    this.orca = orca
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
   * Retrieves all user-persisted connection profiles from Orca storage.
   */
  async getStoredConnections(): Promise<ConnectionProfile[]> {
    const primary = (await this.orca.storage.get(
      SAVED_CONNECTIONS_STORAGE_KEY
    )) as ConnectionProfile[] | null
    if (Array.isArray(primary)) return primary

    const fallback = (await this.orca.storage.get('connections')) as ConnectionProfile[] | null
    if (Array.isArray(fallback)) return fallback

    return []
  }

  /**
   * Persists connection profiles to Orca storage.
   */
  async saveStoredConnections(connections: ConnectionProfile[]): Promise<void> {
    const sanitized = sanitizeJsonPayload(connections) as unknown as JsonValue
    await this.orca.storage.set(SAVED_CONNECTIONS_STORAGE_KEY, sanitized)
    await this.orca.storage.set('connections', sanitized)
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
   * Purges `pwd_`, `tok_`, `sslkey_`, `sshpass_` and `sshpwd_` secrets for a deleted connection.
   */
  async deleteSecret(connectionId: string): Promise<void> {
    await Promise.all(
      ['pwd', 'tok', 'sslkey', 'sshpass', 'sshpwd'].map(async (prefix) => {
        await this.orca.secrets.delete(`${prefix}_${connectionId}`)
      })
    )
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
    await Promise.all(
      toWrite.map(async ({ prefix, value }) => {
        if (value) {
          await this.orca.secrets.set(`${prefix}_${targetConnectionId}`, value)
        }
      })
    )
  }

  /**
   * Locates a connection profile by ID strictly from Orca storage (never crawls filesystem).
   */
  async findProfile(connectionId: string): Promise<ConnectionProfile | null> {
    if (!connectionId || connectionId.startsWith('ws_')) {
      return null
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
  async getSession(connectionId: string): Promise<IDatabaseSession> {
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

    const inFlight = this.pendingSessions.get(connectionId)
    if (inFlight) {
      return inFlight
    }

    const expectedGen = this.getGeneration(connectionId)
    const createPromise = (async () => {
      try {
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
        const secret = shouldFetchSecret
          ? await this.getSecret(connectionId, profile.driver)
          : undefined
        const extraSecrets = await this.getExtendedSecrets(connectionId)
        const session = await this.openSessionWithTunnel(profile, secret, extraSecrets)
        if (this.getGeneration(connectionId) !== expectedGen) {
          await session.close().catch(() => {})
          throw new Error(`Session initialization for '${connectionId}' was superseded by close/update`)
        }
        this.activeSessions.set(connectionId, session)
        this.getOrCreateHealthPolicy(connectionId).recordSuccess()
        return session
      } catch (err: unknown) {
        const msg = scrubCredentialsInText(err instanceof Error ? err.message : String(err))
        this.getOrCreateHealthPolicy(connectionId).recordFailure(msg)
        throw err
      }
    })()

    this.pendingSessions.set(connectionId, createPromise)
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

  /**
   * Runs `task` against either the direct profile or a `127.0.0.1:<localPort>` proxied profile,
   * always closing the temporary SSH tunnel afterwards (used by `connection.test`).
   */
  private async withTunnel<T>(
    profile: ConnectionProfile,
    extraSecrets: ExtendedSecrets | undefined,
    task: (target: ConnectionProfile, tlsOptions: DriverTlsOptions | undefined) => Promise<T>
  ): Promise<T> {
    if (!this.shouldTunnel(profile)) {
      return await task(profile, this.buildDriverTlsOptions(extraSecrets))
    }

    const target = this.resolveTunnelTarget(profile)
    const tunnel = await openSshTunnel(profile, target.targetHost, target.targetPort, {
      secrets: {
        sshPassphrase: extraSecrets?.sshPassphrase,
        sshPassword: extraSecrets?.sshPassword,
      },
    })
    this.trackTunnel(tunnel, profile.id)
    try {
      return await task(
        this.buildProxiedProfile(profile, tunnel),
        this.buildDriverTlsOptions(extraSecrets, target.targetHost)
      )
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
      return await driver.createSession(profile, secret, this.buildDriverTlsOptions(extraSecrets))
    }

    const expectedGen = this.getGeneration(profile.id)
    const target = this.resolveTunnelTarget(profile)
    const tunnel: SshTunnelHandle = await openSshTunnel(
      profile,
      target.targetHost,
      target.targetPort,
      {
        secrets: {
          sshPassphrase: extraSecrets?.sshPassphrase,
          sshPassword: extraSecrets?.sshPassword,
        },
      }
    )
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
        this.buildDriverTlsOptions(extraSecrets, target.targetHost)
      )
    } catch (err) {
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
   * to the duration of the test while preserving per-driver error messages.
   */
  async testConnection(
    profile: ConnectionProfile,
    secret?: string,
    extraSecrets?: ExtendedSecrets
  ): Promise<{ ok: boolean; message?: string }> {
    try {
      const driver = await this.resolveDriver(profile.driver)
      const result = await this.withTunnel(profile, extraSecrets, async (target, tlsOptions) =>
        await driver.testConnection(target, secret, tlsOptions)
      )
      if (profile.id) {
        if (result.ok) {
          this.getOrCreateHealthPolicy(profile.id).recordSuccess()
        } else {
          const msg = typeof result.message === 'string' ? scrubCredentialsInText(result.message) : 'Connection test failed'
          this.getOrCreateHealthPolicy(profile.id).recordFailure(msg)
        }
      }
      if (!result.ok && typeof result.message === 'string') {
        return {
          ...result,
          message: appendActionableTlsErrorHint(scrubCredentialsInText(result.message)),
        }
      }
      return result
    } catch (err: unknown) {
      if (profile.id) {
        const msg = scrubCredentialsInText(err instanceof Error ? err.message : String(err))
        this.getOrCreateHealthPolicy(profile.id).recordFailure(msg)
      }
      throw err
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
