import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import type { ConnectionProfile, DatabaseDriverType } from '../protocol'
import { SAVED_CONNECTIONS_STORAGE_KEY, sanitizeJsonPayload } from '../protocol'
import { type IDatabaseDriver, type IDatabaseSession, getDriver } from '../drivers'
import { getByodDefaultPort, isByodDriverId } from '../drivers/driver-manager'
import type { DriverTlsOptions, SshTunnelHandle } from '../drivers/common/tls-and-tunnel'
import { openSshTunnel } from '../drivers/common/tls-and-tunnel'
import {
  BUILTIN_ENGINE_CATALOG,
  getDefaultPortForDriver,
} from '../drivers/common/engine-catalog'

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
  if (/^https:$/i.test(protocol)) return 443
  if (/^clickhouses:$/i.test(protocol)) return 8443
  return getDefaultPortForDriver(driver)
}

/**
 * Resolves the real SSH forwarding target. URL-based engines (ClickHouse / Redis) carry the
 * remote host/port inside `profile.url`, which must win over the discrete host/port fields.
 */
export function resolveSshTunnelTarget(profile: ConnectionProfile): {
  targetHost: string
  targetPort: number
} {
  const explicitPort =
    profile.port && Number.isInteger(profile.port) && profile.port > 0 ? profile.port : undefined
  const rawUrl = typeof profile.url === 'string' ? profile.url.trim() : ''
  if (rawUrl && (profile.driver === 'clickhouse' || profile.driver === 'redis')) {
    try {
      const parsed = new URL(rawUrl)
      const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
      if (hostname.length > 0) {
        const parsedPort = parsed.port ? Number(parsed.port) : Number.NaN
        return {
          targetHost: hostname,
          targetPort:
            Number.isInteger(parsedPort) && parsedPort > 0
              ? parsedPort
              : defaultUrlPort(profile.driver, parsed.protocol),
        }
      }
    } catch {
      // Fall back to discrete host/port below
    }
  }
  return {
    targetHost: (profile.host || 'localhost').trim(),
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
  if (rawUrl && (profile.driver === 'clickhouse' || profile.driver === 'redis')) {
    try {
      const parsed = new URL(rawUrl)
      parsed.hostname = tunnel.localHost
      parsed.port = String(tunnel.localPort)
      proxied.url = parsed.toString()
    } catch {
      // Keep the original URL; discrete host/port still target the tunnel
    }
  }
  return proxied
}

export class SessionManager {
  private readonly activeSessions = new Map<string, IDatabaseSession>()
  private readonly pendingSessions = new Map<string, Promise<IDatabaseSession>>()
  private readonly activeTunnels = new Set<SshTunnelHandle>()
  private readonly tunnelOwners = new Map<SshTunnelHandle, string>()
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
      return getDriver(driverType)
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

  /**
   * Returns an active database session for the connection ID, creating and caching it if needed.
   * Deduplicates concurrent in-flight creation requests for the same connectionId.
   */
  async getSession(connectionId: string): Promise<IDatabaseSession> {
    const existing = this.activeSessions.get(connectionId)
    if (existing) {
      if (typeof existing.isAlive !== 'function' || existing.isAlive()) {
        return existing
      }
      this.activeSessions.delete(connectionId)
      void existing.close().catch(() => {})
    }

    const inFlight = this.pendingSessions.get(connectionId)
    if (inFlight) {
      return inFlight
    }

    const expectedGen = this.getGeneration(connectionId)
    const createPromise = (async () => {
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
      return session
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
   * SSH tunneling only applies to TCP engines; other profiles pass through untouched.
   */
  private shouldTunnel(profile: ConnectionProfile): boolean {
    return (
      Boolean(profile.sshEnabled) &&
      (SSH_TUNNEL_ENGINES.has(profile.driver) || isByodDriverId(profile.driver))
    )
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
    await tunnel.close().catch(() => {})
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
    const driver = await this.resolveDriver(profile.driver)
    return await this.withTunnel(profile, extraSecrets, async (target, tlsOptions) =>
      await driver.testConnection(target, secret, tlsOptions)
    )
  }

  hasActiveSession(connectionId: string): boolean {
    const existing = this.activeSessions.get(connectionId)
    return Boolean(existing && (typeof existing.isAlive !== 'function' || existing.isAlive()))
  }

  getActiveSessions(): Map<string, IDatabaseSession> {
    return this.activeSessions
  }

  /**
   * Closes and unregisters a single cached session.
   */
  async closeSession(connectionId: string): Promise<void> {
    this.bumpGeneration(connectionId)
    this.pendingSessions.delete(connectionId)
    await this.closeOwnedTunnels(connectionId)
    const session = this.activeSessions.get(connectionId)
    if (session) {
      this.activeSessions.delete(connectionId)
      try {
        await session.close()
      } catch (e) {
        this.orca.log(`[SessionManager] Error closing session [${connectionId}]: ${e}`)
      }
    }
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
   * Closes all active sessions on shutdown.
   */
  async closeAll(): Promise<void> {
    this.globalGeneration += 1
    this.pendingSessions.clear()
    const tunnels = Array.from(this.activeTunnels)
    this.activeTunnels.clear()
    this.tunnelOwners.clear()
    const closeTunnels = tunnels.map(async (tunnel) => {
      try {
        await tunnel.close()
      } catch (e) {
        this.orca.log(`[SessionManager] Error closing SSH tunnel on shutdown: ${e}`)
      }
    })
    const closePromises = Array.from(this.activeSessions.values()).map(async (session) => {
      try {
        await session.close()
      } catch (e) {
        this.orca.log(`[SessionManager] Error closing session on shutdown: ${e}`)
      }
    })
    this.activeSessions.clear()
    await Promise.all([...closePromises, ...closeTunnels])
  }
}
