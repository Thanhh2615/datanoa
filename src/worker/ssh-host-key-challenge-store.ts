import { randomUUID } from 'node:crypto'
import type { SshHostKeyChallenge, SshHostKeyDecision } from '../protocol'
import { isSystemKnownHostsPath, updateKnownHostsAtomically } from '../drivers/common/ssh-host-keys'
import type { TrustedHostKeyPin } from '../drivers/common/ssh-multi-hop'
import { createHostError } from './worker-utils'

export const MAX_SSH_HOST_KEY_CHALLENGES = 64
export const SSH_HOST_KEY_CHALLENGE_TTL_MS = 5 * 60 * 1000
export const SSH_TRUST_ONCE_PIN_TTL_MS = 60 * 1000
export const SSH_RETRY_TOKEN_TTL_MS = 60 * 1000

interface StoredChallengeEntry {
  challenge: SshHostKeyChallenge
  scopeKey: string
  hopSignature?: string
  retryToken?: string
  hasExplicitRetryScope: boolean
  expiresAt: number
}

interface StoredTrustedPinEntry {
  connectionKey: string
  hopSignature?: string
  retryToken?: string
  pin: TrustedHostKeyPin
  expiresAt: number
  trustOnce: boolean
}

interface ActiveRetryTokenEntry {
  scopeKey: string
  hopSignature?: string
  expiresAt: number
}

function normalizePinScopeKey(connectionId?: string): string {
  const trimmed = typeof connectionId === 'string' ? connectionId.trim() : ''
  return trimmed.length > 0 ? trimmed : '__unscoped__'
}

function normalizeRetryToken(retryToken?: string): string | undefined {
  const trimmed = typeof retryToken === 'string' ? retryToken.trim() : ''
  return trimmed.length > 0 ? trimmed : undefined
}

function makeRetryScopeEntryKey(
  scopeKey: string,
  hopSignature?: string,
  retryToken?: string
): string {
  return `${scopeKey}\0${hopSignature ?? ''}\0${retryToken ?? ''}`
}

/**
 * Server-minted SSH host-key challenge store (max 64 entries, 5m TTL, single-use)
 * and `TrustedHostKeyPin` store for `trust-once` (retry-token & retry-scope retained, 60s TTL) &
 * `mismatch + replace` retries.
 * RPC `ssh.hostKey.resolve` accepts ONLY `{ challengeId, decision }` and never trusts
 * client-supplied host/key/path metadata.
 */
export class SshHostKeyChallengeStore {
  private readonly challenges = new Map<string, StoredChallengeEntry>()
  private readonly pins: StoredTrustedPinEntry[] = []
  private readonly retryScopes = new Map<string, number>()
  private readonly activeRetryTokens = new Map<string, ActiveRetryTokenEntry>()

  createRetryToken(): string {
    return `sshrt_${randomUUID()}`
  }

  private activateRetryToken(
    retryToken: string,
    scopeKey: string,
    hopSignature: string | undefined,
    now = Date.now()
  ): void {
    this.activeRetryTokens.set(retryToken, {
      scopeKey,
      ...(hopSignature ? { hopSignature } : {}),
      expiresAt: now + SSH_RETRY_TOKEN_TTL_MS,
    })
    while (this.activeRetryTokens.size > MAX_SSH_HOST_KEY_CHALLENGES * 2) {
      const oldestToken = this.activeRetryTokens.keys().next().value
      if (oldestToken === undefined) break
      this.revokeRetryToken(oldestToken)
    }
  }

  revokeRetryToken(retryToken?: string): void {
    const token = normalizeRetryToken(retryToken)
    if (!token) return
    this.activeRetryTokens.delete(token)
    for (const scopeEntryKey of Array.from(this.retryScopes.keys())) {
      if (scopeEntryKey.endsWith(`\0${token}`)) {
        this.retryScopes.delete(scopeEntryKey)
      }
    }
    for (let i = this.pins.length - 1; i >= 0; i -= 1) {
      const entry = this.pins[i]
      if (entry.trustOnce && entry.retryToken === token) {
        this.pins.splice(i, 1)
      }
    }
  }

  isRetryTokenActive(
    retryToken?: string,
    connectionId?: string,
    hopSignature?: string,
    now = Date.now()
  ): boolean {
    const token = normalizeRetryToken(retryToken)
    if (!token) return false
    const entry = this.activeRetryTokens.get(token)
    if (!entry || entry.expiresAt <= now) return false
    if (connectionId !== undefined && entry.scopeKey !== normalizePinScopeKey(connectionId)) {
      return false
    }
    if (hopSignature && entry.hopSignature && entry.hopSignature !== hopSignature) {
      return false
    }
    return true
  }

  private prune(now = Date.now()): void {
    for (const [id, entry] of this.challenges.entries()) {
      if (entry.expiresAt <= now) {
        this.challenges.delete(id)
      }
    }
    while (this.challenges.size > MAX_SSH_HOST_KEY_CHALLENGES) {
      const oldest = this.challenges.keys().next().value
      if (oldest === undefined) break
      this.challenges.delete(oldest)
    }

    for (const [token, entry] of Array.from(this.activeRetryTokens.entries())) {
      if (entry.expiresAt <= now) {
        this.revokeRetryToken(token)
      }
    }

    for (let i = this.pins.length - 1; i >= 0; i -= 1) {
      if (this.pins[i].expiresAt <= now) {
        this.pins.splice(i, 1)
      }
    }
    while (this.pins.length > MAX_SSH_HOST_KEY_CHALLENGES) {
      this.pins.shift()
    }
  }

  /**
   * Mints an authoritative server-side `challengeId` for a host-key verification failure.
   */
  mint(
    rawChallenge: Omit<SshHostKeyChallenge, 'challengeId'> & { challengeId?: string },
    panelId?: string,
    scopeOpts?: { scopeKey?: string; hopSignature?: string; retryToken?: string }
  ): SshHostKeyChallenge {
    const now = Date.now()
    this.prune(now)
    const challengeId = `sshchk_${randomUUID()}`
    const explicitToken = normalizeRetryToken(scopeOpts?.retryToken ?? rawChallenge.retryToken)
    const retryToken = explicitToken ?? this.createRetryToken()
    const knownHostsReadOnly =
      rawChallenge.knownHostsReadOnly === true ||
      Boolean(rawChallenge.knownHostsPath && isSystemKnownHostsPath(rawChallenge.knownHostsPath))
    const challenge: SshHostKeyChallenge = {
      ...rawChallenge,
      ...(panelId && !rawChallenge.panelId ? { panelId } : {}),
      ...(knownHostsReadOnly ? { knownHostsReadOnly: true } : {}),
      challengeId,
      retryToken,
    }
    this.challenges.set(challengeId, {
      challenge,
      scopeKey: normalizePinScopeKey(scopeOpts?.scopeKey ?? rawChallenge.connectionId),
      hopSignature: scopeOpts?.hopSignature,
      retryToken,
      hasExplicitRetryScope: Boolean(explicitToken),
      expiresAt: now + SSH_HOST_KEY_CHALLENGE_TTL_MS,
    })
    this.prune(now)
    return challenge
  }

  get(challengeId: string): SshHostKeyChallenge | null {
    const now = Date.now()
    this.prune(now)
    return this.challenges.get(challengeId)?.challenge ?? null
  }

  private consumeStoredEntry(challengeId: string): StoredChallengeEntry | null {
    const now = Date.now()
    this.prune(now)
    const entry = this.challenges.get(challengeId)
    if (!entry) return null
    this.challenges.delete(challengeId)
    if (entry.expiresAt <= now) return null
    return entry
  }

  /**
   * Consumes a challenge atomically (single-use). Returns null if missing or expired.
   */
  consume(challengeId: string): SshHostKeyChallenge | null {
    return this.consumeStoredEntry(challengeId)?.challenge ?? null
  }

  beginRetryScope(
    connectionId?: string,
    hopSignature?: string,
    callerRetryToken?: string
  ): string {
    const now = Date.now()
    this.prune(now)
    const key = normalizePinScopeKey(connectionId)
    const normHop = hopSignature || undefined
    const candidateToken = normalizeRetryToken(callerRetryToken)
    const effectiveToken =
      candidateToken && this.isRetryTokenActive(candidateToken, key, normHop, now)
        ? candidateToken
        : this.createRetryToken()
    const scopeEntryKey = makeRetryScopeEntryKey(key, normHop, effectiveToken)
    this.retryScopes.set(scopeEntryKey, (this.retryScopes.get(scopeEntryKey) ?? 0) + 1)
    return effectiveToken
  }

  endRetryScope(
    connectionId?: string,
    opts?: { keepPins?: boolean; hopSignature?: string; retryToken?: string }
  ): void {
    const key = normalizePinScopeKey(connectionId)
    const normHop = opts?.hopSignature || undefined
    const token = normalizeRetryToken(opts?.retryToken)
    const scopeEntryKey = makeRetryScopeEntryKey(key, normHop, token)
    const cur = this.retryScopes.get(scopeEntryKey) ?? 0
    if (cur <= 1) {
      this.retryScopes.delete(scopeEntryKey)
    } else {
      this.retryScopes.set(scopeEntryKey, cur - 1)
    }
    if (!opts?.keepPins) {
      this.clearTrustOncePins(connectionId, normHop, token)
      if (token) {
        this.revokeRetryToken(token)
      }
    }
  }

  clearTrustOncePins(connectionId?: string, hopSignature?: string, retryToken?: string): void {
    const key = normalizePinScopeKey(connectionId)
    const token = normalizeRetryToken(retryToken)
    for (let i = this.pins.length - 1; i >= 0; i -= 1) {
      const entry = this.pins[i]
      if (
        entry.trustOnce &&
        entry.connectionKey === key &&
        (!hopSignature || !entry.hopSignature || entry.hopSignature === hopSignature) &&
        (!token || entry.retryToken === token)
      ) {
        this.pins.splice(i, 1)
      }
    }
  }

  mintTrustedPin(
    connectionId: string | undefined,
    pin: TrustedHostKeyPin,
    opts?: { trustOnce?: boolean; hopSignature?: string; retryToken?: string }
  ): void {
    const now = Date.now()
    this.prune(now)
    const key = normalizePinScopeKey(connectionId)
    const trustOnce = opts?.trustOnce ?? true
    const retryToken = normalizeRetryToken(opts?.retryToken)
    if (retryToken) {
      this.activateRetryToken(retryToken, key, opts?.hopSignature, now)
    }
    this.pins.push({
      connectionKey: key,
      ...(opts?.hopSignature ? { hopSignature: opts.hopSignature } : {}),
      ...(retryToken ? { retryToken } : {}),
      pin: { ...pin },
      expiresAt: now + (trustOnce ? SSH_TRUST_ONCE_PIN_TTL_MS : SSH_HOST_KEY_CHALLENGE_TTL_MS),
      trustOnce,
    })
    this.prune(now)
  }

  private isRetryScopeActive(
    key: string,
    hopSignature?: string,
    retryToken?: string
  ): boolean {
    const token = normalizeRetryToken(retryToken)
    if (token) {
      if ((this.retryScopes.get(makeRetryScopeEntryKey(key, undefined, token)) ?? 0) > 0) {
        return true
      }
      if (
        hopSignature &&
        (this.retryScopes.get(makeRetryScopeEntryKey(key, hopSignature, token)) ?? 0) > 0
      ) {
        return true
      }
      return false
    }
    if ((this.retryScopes.get(makeRetryScopeEntryKey(key)) ?? 0) > 0) return true
    if (hopSignature && (this.retryScopes.get(makeRetryScopeEntryKey(key, hopSignature)) ?? 0) > 0) {
      return true
    }
    return false
  }

  private matchesPinEntry(
    entry: StoredTrustedPinEntry,
    key: string,
    hopSignature: string | undefined,
    retryToken: string | undefined,
    now: number
  ): boolean {
    if (entry.connectionKey !== key) return false
    if (hopSignature && entry.hopSignature && entry.hopSignature !== hopSignature) return false
    const token = normalizeRetryToken(retryToken)
    if (entry.trustOnce) {
      if (entry.retryToken) {
        return Boolean(
          token &&
            entry.retryToken === token &&
            this.isRetryTokenActive(token, key, hopSignature ?? entry.hopSignature, now)
        )
      }
      return !token
    }
    if (token && entry.retryToken) {
      return (
        entry.retryToken === token &&
        this.isRetryTokenActive(token, key, hopSignature ?? entry.hopSignature, now)
      )
    }
    return true
  }

  consumePin(
    connectionId: string | undefined,
    host: string,
    port: number,
    exactFingerprint: string,
    hopSignature?: string,
    retryToken?: string
  ): boolean {
    const now = Date.now()
    this.prune(now)
    const key = normalizePinScopeKey(connectionId)
    const normHost = host.trim().toLowerCase()
    const token = normalizeRetryToken(retryToken)
    const idx = this.pins.findIndex(
      (entry) =>
        this.matchesPinEntry(entry, key, hopSignature, token, now) &&
        entry.pin.host.trim().toLowerCase() === normHost &&
        (entry.pin.port === undefined || entry.pin.port === port) &&
        entry.pin.exactFingerprint === exactFingerprint
    )
    if (idx < 0) return false
    const entry = this.pins[idx]
    const scopeActive = this.isRetryScopeActive(key, hopSignature ?? entry.hopSignature, token)
    if (!(entry.trustOnce && scopeActive)) {
      this.pins.splice(idx, 1)
    }
    return true
  }

  /**
   * Returns active pins strictly matching `connectionId` (and optional `hopSignature` / `retryToken`).
   * Pass to `openSshTunnel` and call `syncConsumedPins()` afterwards so consumed pins are removed.
   */
  borrowPins(
    connectionId?: string,
    hopSignature?: string,
    retryToken?: string
  ): TrustedHostKeyPin[] {
    const now = Date.now()
    this.prune(now)
    const key = normalizePinScopeKey(connectionId)
    const token = normalizeRetryToken(retryToken)
    return this.pins
      .filter((entry) => this.matchesPinEntry(entry, key, hopSignature, token, now))
      .map((entry) => entry.pin)
  }

  syncConsumedPins(
    connectionId: string | undefined,
    borrowedBefore: readonly TrustedHostKeyPin[],
    remainingAfter: readonly TrustedHostKeyPin[],
    hopSignature?: string,
    retryToken?: string
  ): void {
    const consumed = borrowedBefore.filter((pin) => !remainingAfter.includes(pin))
    if (consumed.length === 0) return
    const key = normalizePinScopeKey(connectionId)
    const token = normalizeRetryToken(retryToken)
    for (const pin of consumed) {
      const idx = this.pins.findIndex((entry) => {
        if (entry.connectionKey !== key) return false
        if (hopSignature && entry.hopSignature && entry.hopSignature !== hopSignature) return false
        if (entry.trustOnce) {
          if (entry.retryToken) {
            if (!token || entry.retryToken !== token) return false
          } else if (token) {
            return false
          }
        } else if (token && entry.retryToken && entry.retryToken !== token) {
          return false
        }
        return (
          entry.pin.host === pin.host &&
          entry.pin.port === pin.port &&
          entry.pin.exactFingerprint === pin.exactFingerprint
        )
      })
      if (idx >= 0) {
        this.pins.splice(idx, 1)
      }
    }
  }

  /**
   * Resolves a server-minted challenge using ONLY `{ challengeId, decision }`.
   */
  async resolve(input: {
    challengeId: string
    decision: SshHostKeyDecision
  }): Promise<{
    ok: boolean
    decision: SshHostKeyDecision
    savedPath?: string
    challenge: SshHostKeyChallenge
    retryToken?: string
  }> {
    const challengeId = typeof input?.challengeId === 'string' ? input.challengeId.trim() : ''
    const decision = input?.decision
    if (!challengeId) {
      throw createHostError('invalid_params', 'challengeId is required')
    }
    if (
      decision !== 'trust-once' &&
      decision !== 'save' &&
      decision !== 'replace' &&
      decision !== 'cancel'
    ) {
      throw createHostError('invalid_params', `Invalid SSH host key decision: ${String(decision)}`)
    }

    const storedEntry = this.consumeStoredEntry(challengeId)
    if (!storedEntry) {
      throw createHostError(
        'invalid_params',
        'SSH host key challenge has expired or was already resolved.'
      )
    }
    const challenge = storedEntry.challenge

    if (challenge.reason === 'revoked' && decision !== 'cancel') {
      throw createHostError(
        'not_permitted',
        'Revoked SSH host keys cannot be trusted or saved to known_hosts.'
      )
    }

    if (decision === 'cancel') {
      if (storedEntry.hasExplicitRetryScope && storedEntry.retryToken) {
        this.clearTrustOncePins(storedEntry.scopeKey, storedEntry.hopSignature, storedEntry.retryToken)
      } else {
        this.clearTrustOncePins(storedEntry.scopeKey, storedEntry.hopSignature)
      }
      this.revokeRetryToken(storedEntry.retryToken)
      return { ok: true, decision, challenge }
    }

    if (decision === 'trust-once') {
      const retryToken = storedEntry.retryToken ?? this.createRetryToken()
      this.activateRetryToken(retryToken, storedEntry.scopeKey, storedEntry.hopSignature)
      const challengeWithToken: SshHostKeyChallenge =
        challenge.retryToken === retryToken ? challenge : { ...challenge, retryToken }
      this.mintTrustedPin(
        storedEntry.scopeKey,
        {
          host: challenge.host,
          port: challenge.port,
          exactFingerprint: challenge.fingerprintSha256,
        },
        { trustOnce: true, hopSignature: storedEntry.hopSignature, retryToken }
      )
      return { ok: true, decision, challenge: challengeWithToken, retryToken }
    }

    if (
      decision === 'replace' &&
      ((challenge.knownHostsPath && isSystemKnownHostsPath(challenge.knownHostsPath)) ||
        challenge.knownHostsReadOnly)
    ) {
      throw createHostError(
        'not_permitted',
        `Cannot replace host key in system known_hosts file "${challenge.knownHostsPath ?? 'system known_hosts'}". System known_hosts files must be updated by an administrator (replacing in user known_hosts would not override the system entry).`
      )
    }

    // decision === 'save' | 'replace'
    const targetPath =
      decision === 'replace' && challenge.knownHostsPath ? challenge.knownHostsPath : undefined

    const savedPath = await updateKnownHostsAtomically({
      filePath: targetPath,
      mode: decision,
      host: challenge.host,
      port: challenge.port,
      keyType: challenge.keyType,
      keyBlob: Buffer.from(challenge.keyBlob, 'base64'),
    })

    const retryToken =
      decision === 'replace' || storedEntry.hasExplicitRetryScope
        ? (storedEntry.retryToken ?? this.createRetryToken())
        : storedEntry.retryToken
    if (retryToken) {
      this.activateRetryToken(retryToken, storedEntry.scopeKey, storedEntry.hopSignature)
    }
    const challengeWithToken: SshHostKeyChallenge =
      retryToken && challenge.retryToken !== retryToken
        ? { ...challenge, retryToken }
        : challenge

    if (decision === 'replace' && challenge.reason === 'mismatch') {
      // Pin exact replacement fingerprint strictly AFTER known_hosts write succeeds
      this.mintTrustedPin(
        storedEntry.scopeKey,
        {
          host: challenge.host,
          port: challenge.port,
          exactFingerprint: challenge.fingerprintSha256,
        },
        { trustOnce: false, hopSignature: storedEntry.hopSignature, retryToken }
      )
    }

    return {
      ok: true,
      decision,
      savedPath,
      challenge: challengeWithToken,
      ...(retryToken ? { retryToken } : {}),
    }
  }

  dispose(): void {
    this.challenges.clear()
    this.pins.length = 0
    this.retryScopes.clear()
    this.activeRetryTokens.clear()
  }
}
