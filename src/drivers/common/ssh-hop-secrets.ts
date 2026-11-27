// Per-hop SSH keyring secret management and full-chain prefix-closed SSRF guard (C2).

import * as path from 'node:path'
import type { ConnectionProfile, SshJumpHopSecret, SshJumpHostProfile } from '../../protocol'
import { getDefaultPortForDriver } from './engine-catalog'

export const MAX_SSH_JUMP_HOPS = 8
export const SSH_HOP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

const BASE_SECRET_PREFIXES = ['pwd', 'tok', 'sslkey', 'sshpass', 'sshpwd'] as const

export interface SecretsVaultLike {
  get(key: string): Promise<string | null | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export type ChainSecretReuseTarget =
  | { kind: 'hop'; hopIndex: number }
  | { kind: 'bastion' }

function assertValidHopId(hopId: string): string {
  const trimmed = typeof hopId === 'string' ? hopId.trim() : ''
  if (!SSH_HOP_ID_RE.test(trimmed)) {
    throw new Error(`Invalid SSH jump hopId "${String(hopId)}"`)
  }
  return trimmed
}

function getLegacyHopPasswordSecretKey(connId: string, hopId: string): string {
  return `sshhop_pwd_${connId}_${assertValidHopId(hopId)}`
}

function getLegacyHopPassphraseSecretKey(connId: string, hopId: string): string {
  return `sshhop_pass_${connId}_${assertValidHopId(hopId)}`
}

/**
 * Returns the unambiguous tuple-encoded keyring key for an intermediate SSH jump hop password.
 */
export function getHopPasswordSecretKey(connId: string, hopId: string): string {
  return `sshhop_v2_pwd_${connId.length}_${connId}_${assertValidHopId(hopId)}`
}

/**
 * Returns the unambiguous tuple-encoded keyring key for an intermediate SSH jump hop private-key passphrase.
 */
export function getHopPassphraseSecretKey(connId: string, hopId: string): string {
  return `sshhop_v2_pass_${connId.length}_${connId}_${assertValidHopId(hopId)}`
}

/**
 * Persists or clears per-hop SSH passwords/passphrases in `orca.secrets`.
 */
export async function saveHopSecrets(
  vault: SecretsVaultLike,
  connId: string,
  hopIds: readonly string[],
  secretsMap: Readonly<Record<string, SshJumpHopSecret>> | undefined,
  assertSecureStorage?: () => Promise<void>
): Promise<void> {
  if (!connId || !secretsMap) return
  let checkedStorage = false
  for (const rawHopId of hopIds) {
    const hopId = assertValidHopId(rawHopId)
    const entry = secretsMap[hopId]
    if (!entry) continue
    if (entry.password !== undefined) {
      if (entry.password) {
        if (!checkedStorage && assertSecureStorage) {
          await assertSecureStorage()
          checkedStorage = true
        }
        await vault.set(getHopPasswordSecretKey(connId, hopId), entry.password)
      } else {
        await vault.delete(getHopPasswordSecretKey(connId, hopId))
        await vault.delete(getLegacyHopPasswordSecretKey(connId, hopId))
      }
    }
    if (entry.passphrase !== undefined) {
      if (entry.passphrase) {
        if (!checkedStorage && assertSecureStorage) {
          await assertSecureStorage()
          checkedStorage = true
        }
        await vault.set(getHopPassphraseSecretKey(connId, hopId), entry.passphrase)
      } else {
        await vault.delete(getHopPassphraseSecretKey(connId, hopId))
        await vault.delete(getLegacyHopPassphraseSecretKey(connId, hopId))
      }
    }
  }
}

/**
 * Reads all stored per-hop secrets for the profile's `sshJumpHosts` (with legacy key fallback).
 */
export async function getHopSecrets(
  vault: SecretsVaultLike,
  connId: string,
  jumpHosts: readonly SshJumpHostProfile[] | undefined
): Promise<Record<string, SshJumpHopSecret>> {
  if (!connId || !Array.isArray(jumpHosts) || jumpHosts.length === 0) {
    return {}
  }
  const result: Record<string, SshJumpHopSecret> = {}
  await Promise.all(
    jumpHosts.map(async (hop) => {
      if (!SSH_HOP_ID_RE.test(hop.hopId)) return
      const [v2Pwd, v2Pass] = await Promise.all([
        vault.get(getHopPasswordSecretKey(connId, hop.hopId)),
        vault.get(getHopPassphraseSecretKey(connId, hop.hopId)),
      ])
      const password = v2Pwd ?? (await vault.get(getLegacyHopPasswordSecretKey(connId, hop.hopId)))
      const passphrase =
        v2Pass ?? (await vault.get(getLegacyHopPassphraseSecretKey(connId, hop.hopId)))
      if (password || passphrase) {
        result[hop.hopId] = {
          ...(password ? { password } : {}),
          ...(passphrase ? { passphrase } : {}),
        }
      }
    })
  )
  return result
}

function throwFirstRejected(results: readonly PromiseSettledResult<unknown>[]): void {
  for (const res of results) {
    if (res.status === 'rejected') {
      throw res.reason
    }
  }
}

/**
 * Deletes all per-hop secrets (v2 and legacy `sshhop_pwd_*` / `sshhop_pass_*`) for the specified `hopIds`.
 */
export async function deleteHopSecrets(
  vault: SecretsVaultLike,
  connId: string,
  hopIds: readonly string[] = []
): Promise<void> {
  if (!connId || hopIds.length === 0) return
  const results = await Promise.allSettled(
    hopIds.flatMap((rawHopId) => {
      if (!SSH_HOP_ID_RE.test(rawHopId)) return []
      return [
        vault.delete(getHopPasswordSecretKey(connId, rawHopId)),
        vault.delete(getHopPassphraseSecretKey(connId, rawHopId)),
        vault.delete(getLegacyHopPasswordSecretKey(connId, rawHopId)),
        vault.delete(getLegacyHopPassphraseSecretKey(connId, rawHopId)),
      ]
    })
  )
  throwFirstRejected(results)
}

/**
 * Purges all base connection secrets (`pwd_`, `tok_`, `sslkey_`, `sshpass_`, `sshpwd_`)
 * plus every per-hop secret (`sshhop_v2_*` and legacy `sshhop_*`) for the given `hopIds`.
 * Required because `SecretsApi` does not expose `keys()`.
 */
export async function deleteSecret(
  vault: SecretsVaultLike,
  connId: string,
  hopIds: readonly string[] = []
): Promise<void> {
  if (!connId) return
  const results = await Promise.allSettled([
    ...BASE_SECRET_PREFIXES.map((prefix) => vault.delete(`${prefix}_${connId}`)),
    deleteHopSecrets(vault, connId, hopIds),
  ])
  throwFirstRejected(results)
}

/**
 * Copies per-hop secrets from one connection ID to another when duplicating a connection.
 */
export async function copyHopSecrets(
  vault: SecretsVaultLike,
  sourceConnId: string,
  targetConnId: string,
  hopIds: readonly string[],
  assertSecureStorage?: () => Promise<void>
): Promise<void> {
  if (!sourceConnId || !targetConnId || sourceConnId === targetConnId || hopIds.length === 0) {
    return
  }
  const toWrite: Array<{ key: string; value: string }> = []
  const readResults = await Promise.allSettled(
    hopIds.map(async (rawHopId) => {
      if (!SSH_HOP_ID_RE.test(rawHopId)) return
      const [v2PwdRes, v2PassRes] = await Promise.allSettled([
        vault.get(getHopPasswordSecretKey(sourceConnId, rawHopId)),
        vault.get(getHopPassphraseSecretKey(sourceConnId, rawHopId)),
      ])
      throwFirstRejected([v2PwdRes, v2PassRes])
      const v2Pwd = v2PwdRes.status === 'fulfilled' ? v2PwdRes.value : undefined
      const v2Pass = v2PassRes.status === 'fulfilled' ? v2PassRes.value : undefined
      const [legacyPwdRes, legacyPassRes] = await Promise.allSettled([
        v2Pwd !== null && v2Pwd !== undefined
          ? Promise.resolve(v2Pwd)
          : vault.get(getLegacyHopPasswordSecretKey(sourceConnId, rawHopId)),
        v2Pass !== null && v2Pass !== undefined
          ? Promise.resolve(v2Pass)
          : vault.get(getLegacyHopPassphraseSecretKey(sourceConnId, rawHopId)),
      ])
      throwFirstRejected([legacyPwdRes, legacyPassRes])
      const pwd = legacyPwdRes.status === 'fulfilled' ? legacyPwdRes.value : undefined
      const pass = legacyPassRes.status === 'fulfilled' ? legacyPassRes.value : undefined
      if (pwd) toWrite.push({ key: getHopPasswordSecretKey(targetConnId, rawHopId), value: pwd })
      if (pass) toWrite.push({ key: getHopPassphraseSecretKey(targetConnId, rawHopId), value: pass })
    })
  )
  throwFirstRejected(readResults)
  if (toWrite.length === 0) return
  if (assertSecureStorage) await assertSecureStorage()
  const writeResults = await Promise.allSettled(
    toWrite.map(({ key, value }) => vault.set(key, value))
  )
  throwFirstRejected(writeResults)
}

function normalizeCanonicalHost(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim().toLowerCase()
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
}

function normalizePathCompare(rawPath: string): string {
  const resolved = path.resolve(rawPath).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved || '/'
}

function normalizeJumpHopForCompare(hop: SshJumpHostProfile): {
  hopId: string
  host: string
  port: number
  user: string
  authMethod: string
  privateKeyPath: string
} | null {
  const hopId = typeof hop.hopId === 'string' ? hop.hopId.trim() : ''
  const host = normalizeCanonicalHost(hop.host)
  const user = typeof hop.user === 'string' ? hop.user.trim() : ''
  if (!SSH_HOP_ID_RE.test(hopId) || !host || !user) return null
  const port =
    typeof hop.port === 'number' && Number.isInteger(hop.port) && hop.port >= 1 && hop.port <= 65535
      ? hop.port
      : 22
  const authMethod = hop.authMethod ?? 'agent'
  const rawKeyPath = typeof hop.privateKeyPath === 'string' ? hop.privateKeyPath.trim() : ''
  const privateKeyPath = authMethod === 'key' && rawKeyPath ? normalizePathCompare(rawKeyPath) : ''
  return { hopId, host, port, user, authMethod, privateKeyPath }
}

function jumpHopsEqual(a: SshJumpHostProfile, b: SshJumpHostProfile): boolean {
  const na = normalizeJumpHopForCompare(a)
  const nb = normalizeJumpHopForCompare(b)
  if (!na || !nb) return false
  return (
    na.hopId === nb.hopId &&
    na.host === nb.host &&
    na.port === nb.port &&
    na.user === nb.user &&
    na.authMethod === nb.authMethod &&
    na.privateKeyPath === nb.privateKeyPath
  )
}

function canonicalDbTargetKey(profile: ConnectionProfile): string | null {
  const driver = typeof profile.driver === 'string' ? profile.driver.trim().toLowerCase() : ''
  if (!driver) return null

  if (driver === 'sqlite' || driver === 'duckdb') {
    const rawFile = (profile.filePath || profile.database || '').trim()
    const fileNorm =
      !rawFile ? '' : rawFile === ':memory:' ? ':memory:' : normalizePathCompare(rawFile)
    return `${driver}|file|${fileNorm}`
  }

  const rawUrl = typeof profile.url === 'string' ? profile.url.trim() : ''
  if (rawUrl) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawUrl)) {
      try {
        const u = new URL(rawUrl)
        const port = u.port || String(getDefaultPortForDriver(profile.driver) || (u.protocol === 'https:' ? 443 : 80))
        return `${driver}|${u.protocol.toLowerCase()}|${normalizeCanonicalHost(u.hostname)}|${port}`
      } catch {
        return `${driver}|raw|${rawUrl.toLowerCase()}`
      }
    }
    return `${driver}|raw|${rawUrl.replace(/\s+/g, ' ').trim().toLowerCase()}`
  }

  const host = normalizeCanonicalHost(profile.host) || 'localhost'
  const defaultPort = getDefaultPortForDriver(profile.driver)
  const port =
    typeof profile.port === 'number' && Number.isInteger(profile.port) && profile.port > 0
      ? profile.port
      : defaultPort
  return `${driver}|${host}|${port}|${profile.d1AccountId?.trim() ?? ''}`
}

function finalBastionMatches(stored: ConnectionProfile, candidate: ConnectionProfile): boolean {
  const sh = normalizeCanonicalHost(stored.sshHost)
  const ch = normalizeCanonicalHost(candidate.sshHost)
  if (!sh || sh !== ch) return false
  const sp =
    typeof stored.sshPort === 'number' && Number.isInteger(stored.sshPort) && stored.sshPort > 0
      ? stored.sshPort
      : 22
  const cp =
    typeof candidate.sshPort === 'number' && Number.isInteger(candidate.sshPort) && candidate.sshPort > 0
      ? candidate.sshPort
      : 22
  if (sp !== cp) return false
  const su = typeof stored.sshUser === 'string' ? stored.sshUser.trim() : ''
  const cu = typeof candidate.sshUser === 'string' ? candidate.sshUser.trim() : ''
  if (!su || su !== cu) return false
  const sm = stored.sshAuthMethod ?? 'agent'
  const cm = candidate.sshAuthMethod ?? 'agent'
  if (sm !== cm) return false
  if (sm === 'key') {
    const sk = typeof stored.sshPrivateKeyPath === 'string' ? stored.sshPrivateKeyPath.trim() : ''
    const ck = typeof candidate.sshPrivateKeyPath === 'string' ? candidate.sshPrivateKeyPath.trim() : ''
    if (sk || ck) {
      if (!sk || !ck || normalizePathCompare(sk) !== normalizePathCompare(ck)) return false
    }
  }
  return true
}

/**
 * Full-chain prefix-closed SSRF guard:
 * Reusing stored credentials for `hopIndex` requires matching DB target AND matching hops `0..hopIndex`.
 * Reusing stored credentials for the final bastion requires matching DB target, all jump hops `0..K-1`,
 * AND matching final bastion endpoint/auth.
 */
export function canReuseStoredChainSecret(
  stored: ConnectionProfile | null | undefined,
  candidate: ConnectionProfile | null | undefined,
  target: ChainSecretReuseTarget
): boolean {
  if (!stored || !candidate) return false
  const dbA = canonicalDbTargetKey(stored)
  const dbB = canonicalDbTargetKey(candidate)
  if (!dbA || !dbB || dbA !== dbB) return false

  const storedHops = Array.isArray(stored.sshJumpHosts) ? stored.sshJumpHosts : []
  const candHops = Array.isArray(candidate.sshJumpHosts) ? candidate.sshJumpHosts : []

  if (target.kind === 'hop') {
    const idx = target.hopIndex
    if (!Number.isInteger(idx) || idx < 0) return false
    if (idx >= storedHops.length || idx >= candHops.length) return false
    for (let i = 0; i <= idx; i++) {
      if (!jumpHopsEqual(storedHops[i], candHops[i])) {
        return false
      }
    }
    return true
  }

  if (storedHops.length !== candHops.length) return false
  for (let i = 0; i < storedHops.length; i++) {
    if (!jumpHopsEqual(storedHops[i], candHops[i])) {
      return false
    }
  }
  return finalBastionMatches(stored, candidate)
}

export interface ResolvedChainRuntimeSecrets {
  jumpHops: Array<{ password?: string; passphrase?: string }>
  bastion: { password?: string; passphrase?: string }
}

/**
 * Strictly isolates per-hop secrets from the final bastion secret:
 * jump hops NEVER receive final bastion credentials.
 */
export function resolveChainRuntimeSecrets(
  profile: ConnectionProfile,
  bastionSecrets?: { sshPassword?: string; sshPassphrase?: string },
  hopSecrets?: Readonly<Record<string, SshJumpHopSecret>>
): ResolvedChainRuntimeSecrets {
  const jumpHops = (profile.sshJumpHosts ?? []).map((hop) => {
    const entry = hopSecrets?.[hop.hopId]
    return {
      password: entry?.password || undefined,
      passphrase: entry?.passphrase || undefined,
    }
  })
  return {
    jumpHops,
    bastion: {
      password: bastionSecrets?.sshPassword || undefined,
      passphrase: bastionSecrets?.sshPassphrase || undefined,
    },
  }
}

/**
 * Collects all non-empty secrets across every hop in the chain for error scrubbing.
 */
export function collectAllChainSecretStrings(
  bastionSecrets?: { sshPassword?: string; sshPassphrase?: string },
  hopSecrets?: Readonly<Record<string, SshJumpHopSecret>>
): string[] {
  const out = new Set<string>()
  if (bastionSecrets?.sshPassword) out.add(bastionSecrets.sshPassword)
  if (bastionSecrets?.sshPassphrase) out.add(bastionSecrets.sshPassphrase)
  if (hopSecrets) {
    for (const entry of Object.values(hopSecrets)) {
      if (entry?.password) out.add(entry.password)
      if (entry?.passphrase) out.add(entry.passphrase)
    }
  }
  return Array.from(out).sort((a, b) => b.length - a.length)
}

/**
 * Scrubs all SSH chain secrets from error/diagnostic text.
 */
export function scrubChainSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length > 0 && out.includes(secret)) {
      out = out.split(secret).join('[REDACTED]')
    }
  }
  return out
}
