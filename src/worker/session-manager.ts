import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import type { ConnectionProfile, DatabaseDriverType } from '../protocol'
import { SAVED_CONNECTIONS_STORAGE_KEY, sanitizeJsonPayload } from '../protocol'
import { type IDatabaseSession, getDriver } from '../drivers'

export interface SessionManagerHostApi {
  storage: Pick<OrcaWorkerApi['storage'], 'get' | 'set'>
  secrets: Pick<OrcaWorkerApi['secrets'], 'get' | 'set' | 'delete'>
  log: OrcaWorkerApi['log']
}

export class SessionManager {
  private readonly activeSessions = new Map<string, IDatabaseSession>()
  private readonly pendingSessions = new Map<string, Promise<IDatabaseSession>>()
  private readonly generations = new Map<string, number>()
  private globalGeneration = 0
  private readonly orca: SessionManagerHostApi

  constructor(orca: SessionManagerHostApi) {
    this.orca = orca
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
   * Saves password (`pwd_${connectionId}`) and/or authToken (`tok_${connectionId}`)
   * into Orca's encrypted secrets vault, or deletes cleared secrets.
   */
  async saveSecret(
    connectionId: string,
    secrets: { password?: string; authToken?: string }
  ): Promise<void> {
    if (secrets.password !== undefined) {
      if (secrets.password) {
        await this.orca.secrets.set(`pwd_${connectionId}`, secrets.password)
      } else {
        await this.orca.secrets.delete(`pwd_${connectionId}`)
      }
    }
    if (secrets.authToken !== undefined) {
      if (secrets.authToken) {
        await this.orca.secrets.set(`tok_${connectionId}`, secrets.authToken)
      } else {
        await this.orca.secrets.delete(`tok_${connectionId}`)
      }
    }
  }

  /**
   * Retrieves the password (`pwd_${id}`) or LibSQL authToken (`tok_${id}`) from Orca secrets.
   */
  async getSecret(
    connectionId: string,
    driver?: DatabaseDriverType
  ): Promise<string | undefined> {
    const key = driver === 'libsql' ? `tok_${connectionId}` : `pwd_${connectionId}`
    const secret = await this.orca.secrets.get(key)
    return secret || undefined
  }

  /**
   * Purges both `pwd_${id}` and `tok_${id}` secrets for a deleted connection.
   */
  async deleteSecret(connectionId: string): Promise<void> {
    await this.orca.secrets.delete(`pwd_${connectionId}`)
    await this.orca.secrets.delete(`tok_${connectionId}`)
  }

  /**
   * Copies stored password and/or authToken from one connection ID to another (used when duplicating profiles).
   */
  async copySecret(sourceConnectionId: string, targetConnectionId: string): Promise<void> {
    if (!sourceConnectionId || !targetConnectionId || sourceConnectionId === targetConnectionId) {
      return
    }
    const [pwd, tok] = await Promise.all([
      this.orca.secrets.get(`pwd_${sourceConnectionId}`),
      this.orca.secrets.get(`tok_${sourceConnectionId}`),
    ])
    if (pwd) {
      await this.orca.secrets.set(`pwd_${targetConnectionId}`, pwd)
    }
    if (tok) {
      await this.orca.secrets.set(`tok_${targetConnectionId}`, tok)
    }
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
        profile.driver === 'libsql'
          ? profile.hasAuthToken !== false
          : Boolean(profile.hasPassword)
      const secret = shouldFetchSecret
        ? await this.getSecret(connectionId, profile.driver)
        : undefined

      const driver = getDriver(profile.driver)
      const session = await driver.createSession(profile, secret)
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
   * Closes all active sessions on shutdown.
   */
  async closeAll(): Promise<void> {
    this.globalGeneration += 1
    this.pendingSessions.clear()
    const closePromises = Array.from(this.activeSessions.values()).map(async (session) => {
      try {
        await session.close()
      } catch (e) {
        this.orca.log(`[SessionManager] Error closing session on shutdown: ${e}`)
      }
    })
    this.activeSessions.clear()
    await Promise.all(closePromises)
  }
}
