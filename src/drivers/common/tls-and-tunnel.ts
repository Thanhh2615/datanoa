// TLS (custom CA / client certs) + in-process pure-JS ssh2 tunnel facade.

import * as net from 'node:net'
import * as tls from 'node:tls'
import type { ConnectionProfile, SshJumpHopSecret } from '../../protocol'
import { readRegularFileBounded } from './bounded-file-reader'
import {
  verifySshHostKeyAgainstKnownHosts as verifyKnownHostsImpl,
  type KnownHostsCheckResult,
} from './ssh-host-keys'
import {
  openMultiHopSshTunnel,
  SshHostKeyVerificationError,
  type TrustedHostKeyPin,
} from './ssh-multi-hop'

export {
  readRegularFileBounded,
  SshHostKeyVerificationError,
  type KnownHostsCheckResult,
  type TrustedHostKeyPin,
}

const MAX_PEM_FILE_BYTES = 1024 * 1024

function stripIpv6ZoneId(ip: string): string {
  const pct = ip.indexOf('%')
  return pct >= 0 ? ip.slice(0, pct) : ip
}

function isIpv6WithOptionalZone(raw: string): boolean {
  const pct = raw.indexOf('%')
  if (pct >= 0) {
    const addr = raw.slice(0, pct)
    const zone = raw.slice(pct + 1)
    if (!zone || /[^A-Za-z0-9._-]/.test(zone)) return false
    return net.isIP(addr) === 6
  }
  return net.isIP(raw) === 6
}

function isIpLiteralWithOptionalZone(raw: string): boolean {
  const bare = stripIpv6ZoneId(raw)
  return net.isIP(bare) !== 0
}

/** Secrets resolved from `orca.secrets` (never persisted on the profile) */
export interface TlsSecretBundle {
  sslKeyPassphrase?: string
}

/** SSH bastion secrets resolved from `orca.secrets` (never persisted on disk) */
export interface SshSecretBundle {
  sshPassphrase?: string
  sshPassword?: string
}

/** TLS overrides handed to a driver (SSH tunnels keep SNI of the real remote host) */
export interface DriverTlsOptions extends TlsSecretBundle {
  tlsServername?: string
}

export interface SshTunnelHandle {
  localHost: '127.0.0.1'
  localPort: number
  originalServername?: string
  hopCount?: number
  /** True while the underlying ssh tunnel is still running and the handle is open */
  isAlive: () => boolean
  close: () => Promise<void>
}

const SSH_DEFAULT_PORT = 22

const INVALID_TOKEN_CHARS = /[\s\u0000-\u001f\u007f]/
const INVALID_CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export const ACTIONABLE_TLS_CERT_ERROR_HINT =
  'Add a trusted CA certificate in Studio (TLS/mTLS), or edit this connection and uncheck "Verify TLS certificate" (or use ?sslmode=require) if you trust this server.'

const ACTIONABLE_TLS_CERT_ERROR_RE =
  /(?:self[\s-]signed certificate(?:\s+in\s+certificate\s+chain)?|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|ERR_TLS_CERT_ALTNAME_INVALID|unable to verify the first certificate|Hostname\/IP does not match certificate'?s altnames)/i

const ACTIONABLE_TLS_CERT_ERROR_CODES: ReadonlySet<string> = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

/**
 * Appends a concise, actionable remediation hint to Node.js TLS certificate verification errors
 * without weakening fail-closed defaults or duplicating the hint if already present.
 */
export function appendActionableTlsErrorHint(message: string, errorCode?: string): string {
  if (typeof message !== 'string' || message.trim().length === 0) return message
  if (message.includes(ACTIONABLE_TLS_CERT_ERROR_HINT)) return message
  const normalizedCode = typeof errorCode === 'string' ? errorCode.trim().toUpperCase() : ''
  const isTlsCertError =
    ACTIONABLE_TLS_CERT_ERROR_RE.test(message) ||
    (normalizedCode.length > 0 && ACTIONABLE_TLS_CERT_ERROR_CODES.has(normalizedCode))
  if (!isTlsCertError) return message
  return `${message.trimEnd()} — ${ACTIONABLE_TLS_CERT_ERROR_HINT}`
}

function trimOptionalPath(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

async function readPemFile(filePath: string, label: string): Promise<string> {
  let buf: Buffer | undefined
  try {
    buf = await readRegularFileBounded(filePath, MAX_PEM_FILE_BYTES, label)
    return buf.toString('utf8')
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      /exceeds maximum allowed size|not a regular file/i.test(err.message)
    ) {
      throw err
    }
    const reason =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: unknown }).code)
        : 'unreadable'
    // NEVER include key passphrases or file contents here
    throw new Error(`Cannot read ${label} from "${filePath}" (${reason})`)
  } finally {
    if (buf) {
      buf.fill(0)
    }
  }
}

/**
 * Resolves the network endpoint and TLS servername for a driver without altering `profile.host`.
 */
export function resolveDriverEndpoint(
  profile: ConnectionProfile,
  overrideServername?: string
): { host: string; port?: number; tlsServername?: string } {
  const host = typeof profile.host === 'string' ? profile.host.trim() : ''
  const port =
    typeof profile.port === 'number' && Number.isInteger(profile.port) && profile.port > 0
      ? profile.port
      : undefined
  const rawOverride = typeof overrideServername === 'string' ? overrideServername.trim() : ''
  const rawProfileSni = typeof profile.tlsServername === 'string' ? profile.tlsServername.trim() : ''
  const tlsServername = rawOverride || rawProfileSni || undefined
  return {
    host,
    ...(port !== undefined ? { port } : {}),
    ...(tlsServername ? { tlsServername } : {}),
  }
}

/**
 * Resolves effective TLS connection options for a profile.
 * - `false` => TLS explicitly disabled (`sslMode: 'disable'`), caller must NOT fall back to auto-SSL.
 * - `undefined` => no custom TLS configured, caller keeps legacy `profile.ssl` / cloud auto-SSL behaviour.
 * - object => caller must use these `tls.ConnectionOptions` as-is.
 */
export async function resolveEffectiveTlsOptions(
  profile: ConnectionProfile,
  secrets?: TlsSecretBundle,
  originalServername?: string
): Promise<false | tls.ConnectionOptions | undefined> {
  if (profile.sslMode === 'disable') return false

  const caPath = trimOptionalPath(profile.sslCaPath)
  const certPath = trimOptionalPath(profile.sslCertPath)
  const keyPath = trimOptionalPath(profile.sslKeyPath)
  const explicitMode =
    profile.sslMode !== undefined && profile.sslMode !== 'auto' ? profile.sslMode : undefined
  const hasCustomCerts = Boolean(caPath || certPath || keyPath)
  const hasExplicitRejectUnauthorized =
    profile.sslRejectUnauthorized !== undefined && profile.ssl !== false
  const endpointSni = resolveDriverEndpoint(profile, originalServername).tlsServername ?? ''

  if (!hasCustomCerts && !explicitMode && !hasExplicitRejectUnauthorized && !endpointSni) return undefined

  if (profile.sslMode === 'require' && caPath && profile.sslRejectUnauthorized !== true) {
    const err = new Error(
      'Custom CA certificate (sslCaPath) cannot be enforced when sslMode is "require" because certificate verification is disabled (tls.ca_requires_verify). Switch TLS mode to "verify-ca" or "verify-full".'
    ) as Error & { code?: string }
    err.code = 'tls.ca_requires_verify'
    throw err
  }

  const options: tls.ConnectionOptions = {}
  if (caPath) options.ca = await readPemFile(caPath, 'SSL CA certificate')
  if (certPath) options.cert = await readPemFile(certPath, 'SSL client certificate')
  if (keyPath) options.key = await readPemFile(keyPath, 'SSL client private key')

  const passphrase = secrets?.sslKeyPassphrase
  if (typeof passphrase === 'string' && passphrase.length > 0) {
    options.passphrase = passphrase
  }

  const rawServername = endpointSni
  const unwrappedServername =
    rawServername.startsWith('[') &&
    rawServername.endsWith(']') &&
    isIpv6WithOptionalZone(rawServername.slice(1, -1))
      ? rawServername.slice(1, -1)
      : rawServername
  const trimmedServername = stripIpv6ZoneId(unwrappedServername)
  const servernameIsIpLiterals =
    unwrappedServername.length > 0 && isIpLiteralWithOptionalZone(unwrappedServername)
  // RFC 6066: SNI must never carry an IP literal (OpenSSL rejects/ignores it)
  if (trimmedServername.length > 0 && !servernameIsIpLiterals) {
    options.servername = trimmedServername
  }

  switch (profile.sslMode) {
    case 'require':
      options.rejectUnauthorized = profile.sslRejectUnauthorized ?? false
      if (options.rejectUnauthorized === true && trimmedServername.length > 0) {
        options.checkServerIdentity = (_hostname: string, cert: tls.PeerCertificate) =>
          tls.checkServerIdentity(trimmedServername, cert)
      }
      break
    case 'verify-ca':
      options.rejectUnauthorized = true
      options.checkServerIdentity = () => undefined
      break
    case 'verify-full':
    case 'strict':
      options.rejectUnauthorized = true
      if (profile.sslMode === 'strict' && profile.driver === 'mssql') {
        options.ALPNProtocols = ['tds/8.0']
      }
      // Over an SSH tunnel the host is 127.0.0.1, so verify the certificate against the
      // original remote hostname/IP explicitly (works for both DNS names and IP SANs).
      if (trimmedServername.length > 0) {
        options.checkServerIdentity = (_hostname: string, cert: tls.PeerCertificate) =>
          tls.checkServerIdentity(trimmedServername, cert)
      }
      break
    default:
      options.rejectUnauthorized = Boolean(profile.sslRejectUnauthorized ?? true)
      if (options.rejectUnauthorized !== false && trimmedServername.length > 0) {
        options.checkServerIdentity = (_hostname: string, cert: tls.PeerCertificate) =>
          tls.checkServerIdentity(trimmedServername, cert)
      }
      break
  }

  return options
}

/** Backwards-compatible alias used by drivers that only need the TLS options */
export const buildTlsConnectionOptions = resolveEffectiveTlsOptions

/**
 * Builds fail-closed default TLS connection options (`rejectUnauthorized: true`),
 * binding DNS-only SNI and `checkServerIdentity` to `originalServername` when provided
 * (for example when tunnelling via SSH over 127.0.0.1).
 */
export function buildDefaultTlsOptions(originalServername?: string): tls.ConnectionOptions {
  const opts: tls.ConnectionOptions = { rejectUnauthorized: true }
  const raw = typeof originalServername === 'string' ? originalServername.trim() : ''
  const unwrapped =
    raw.startsWith('[') && raw.endsWith(']') && isIpv6WithOptionalZone(raw.slice(1, -1))
      ? raw.slice(1, -1)
      : raw
  const clean = stripIpv6ZoneId(unwrapped)
  if (clean.length > 0) {
    if (!isIpLiteralWithOptionalZone(unwrapped)) {
      opts.servername = clean
    }
    opts.checkServerIdentity = (_hostname: string, cert: tls.PeerCertificate) =>
      tls.checkServerIdentity(clean, cert)
  }
  return opts
}

function requireSafeToken(value: unknown, label: string, forbidden: readonly string[] = []): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} is required for SSH tunneling`)
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new Error(`${label} is required for SSH tunneling`)
  }
  if (INVALID_TOKEN_CHARS.test(trimmed)) {
    throw new Error(`${label} must not contain whitespace or control characters`)
  }
  if (trimmed.startsWith('-')) {
    throw new Error(`${label} must not start with '-' (prevents SSH option injection)`)
  }
  for (const char of forbidden) {
    if (trimmed.includes(char)) {
      throw new Error(`${label} must not contain "${char}" (prevents SSH URI/token injection)`)
    }
  }
  return trimmed
}

/**
 * A private key path is NOT shell-interpolated (`shell: false`), so spaces are legal
 * (e.g. `C:\\Users\\My Name\\.ssh\\id_ed25519`) while control characters and
 * option-injection payloads are still rejected.
 */
function requireSafePath(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} is required for SSH tunneling`)
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new Error(`${label} is required for SSH tunneling`)
  }
  if (INVALID_CONTROL_CHARS.test(trimmed)) {
    throw new Error(`${label} must not contain control characters`)
  }
  if (trimmed.startsWith('-')) {
    throw new Error(`${label} must not start with '-' (prevents SSH option injection)`)
  }
  return trimmed
}

function normalizeSshHost(value: unknown): string {
  const raw = requireSafeToken(value, 'SSH host', ['@', '/', '\\'])
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1)
    if (!isIpv6WithOptionalZone(inner)) {
      throw new Error('SSH host brackets may only wrap a valid IPv6 address')
    }
    return inner
  }
  if (raw.includes(':') && !isIpv6WithOptionalZone(raw)) {
    throw new Error('SSH host must not contain ":" unless it is a valid IPv6 address')
  }
  return raw
}

function normalizeTunnelTargetHost(value: unknown): string {
  const raw = requireSafeToken(value, 'SSH tunnel target host', ['@', '/', '\\'])
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1)
    if (!isIpv6WithOptionalZone(inner)) {
      throw new Error('SSH tunnel target host brackets may only wrap a valid IPv6 address')
    }
    return inner
  }
  if (raw.includes(':') && !isIpv6WithOptionalZone(raw)) {
    throw new Error('SSH tunnel target host must not contain ":" unless it is a valid IPv6 address')
  }
  return raw
}

function requirePort(value: unknown, label: string, fallback?: number): number {
  const raw = value === undefined || value === null || value === '' ? fallback : value
  const port = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`)
  }
  return port
}

/**
 * Strict validation of the SSH bastion configuration and its forwarding target.
 * Rejects option-injection payloads (`-oProxyCommand=...`) in every user-controlled token.
 */
export function validateSshTunnelConfig(
  profile: ConnectionProfile,
  targetHost: string,
  targetPort: number
): { sshHost: string; sshPort: number; sshUser: string; targetHost: string; targetPort: number } {
  const sshHost = normalizeSshHost(profile.sshHost)
  const sshUser = requireSafeToken(profile.sshUser, 'SSH user', ['@', '/', ':', '\\'])
  const resolvedTargetHost = normalizeTunnelTargetHost(targetHost)
  const sshPort = requirePort(profile.sshPort, 'SSH port', SSH_DEFAULT_PORT)
  const resolvedTargetPort = requirePort(targetPort, 'SSH tunnel target port')

  if (profile.sshAuthMethod === 'key') {
    requireSafePath(profile.sshPrivateKeyPath, 'SSH private key path')
  }

  return {
    sshHost,
    sshPort,
    sshUser,
    targetHost: resolvedTargetHost,
    targetPort: resolvedTargetPort,
  }
}

/** Reserves a free ephemeral port on 127.0.0.1 and releases it immediately (retries on EADDRINUSE) */
export async function allocateEphemeralPort(): Promise<number> {
  const attempt = (): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      const server = net.createServer()
      server.unref()
      server.once('error', (err) => reject(err))
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        server.close(() => {
          if (port > 0) resolve(port)
          else reject(new Error('Failed to allocate an ephemeral local port'))
        })
      })
    })
  let lastErr: unknown
  for (let i = 0; i < 3; i++) {
    try {
      return await attempt()
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * Verifies an SSH server host key against OpenSSH `known_hosts` text (plain, `[host]:port`,
 * wildcards `*`/`?`, `!` negation, `@revoked`, and `|1|<salt>|<hmac-sha1>` hashed entries).
 */
export function verifySshHostKeyAgainstKnownHosts(
  host: string,
  port: number,
  serverHostKey: Buffer,
  knownHostsText: string
): KnownHostsCheckResult {
  return verifyKnownHostsImpl(host, port, serverHostKey, knownHostsText)
}

/**
 * Opens an SSH local port forward to `targetHost:targetPort` through the configured bastion
 * (and optional intermediate jump hosts) strictly in-process via pure-JS `ssh2`
 * (zero OS `ssh` child processes, zero env secrets, zero temp askpass files).
 */
export async function openSshTunnel(
  profile: ConnectionProfile,
  targetHost: string,
  targetPort: number,
  options?: {
    timeoutMs?: number
    secrets?: SshSecretBundle
    hopSecrets?: Readonly<Record<string, SshJumpHopSecret>>
    knownHostsPaths?: readonly string[]
    trustedHostKeys?: TrustedHostKeyPin[]
    consumeTrustedHostKeyPin?: (host: string, port: number, exactFingerprint: string) => boolean
    connectionId?: string
    panelId?: string
  }
): Promise<SshTunnelHandle> {
  return await openMultiHopSshTunnel(profile, targetHost, targetPort, {
    timeoutMs: options?.timeoutMs,
    secrets: options?.secrets,
    hopSecrets: options?.hopSecrets,
    knownHostsPaths: options?.knownHostsPaths,
    trustedHostKeys: options?.trustedHostKeys,
    consumeTrustedHostKeyPin: options?.consumeTrustedHostKeyPin,
    connectionId: options?.connectionId,
    panelId: options?.panelId,
  })
}
