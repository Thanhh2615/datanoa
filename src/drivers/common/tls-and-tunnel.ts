// TLS (custom CA / client certs) + in-process ssh2 & OS SSH tunnel helpers.

import { spawn, type ChildProcess } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tls from 'node:tls'
import type { ConnectionProfile } from '../../protocol'

const MAX_PEM_FILE_BYTES = 1024 * 1024
const MAX_KNOWN_HOSTS_BYTES = 4 * 1024 * 1024

/**
 * Safely opens and reads a regular file using a single bounded FileHandle.
 * Uses `O_NONBLOCK` on POSIX to prevent hanging on FIFOs/named pipes, verifies
 * `stat.isFile()`, and fails closed if size exceeds `maxBytes`.
 */
export async function readRegularFileBounded(
  filePath: string,
  maxBytes: number,
  label: string
): Promise<Buffer> {
  const openFlags =
    fs.constants.O_RDONLY |
    (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0)
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(filePath, openFlags)
    const stat = await handle.stat()
    if (!stat.isFile()) {
      throw new Error(`${label} "${filePath}" is not a regular file`)
    }
    if (stat.size > maxBytes) {
      throw new Error(
        `${label} "${filePath}" exceeds maximum allowed size of ${maxBytes} bytes`
      )
    }
    const chunks: Buffer[] = []
    let total = 0
    const chunkBuf = Buffer.allocUnsafe(Math.min(65_536, Math.max(1024, maxBytes + 1)))
    for (;;) {
      const { bytesRead } = await handle.read(chunkBuf, 0, chunkBuf.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) {
        throw new Error(
          `${label} "${filePath}" exceeds maximum allowed size of ${maxBytes} bytes`
        )
      }
      chunks.push(Buffer.from(chunkBuf.subarray(0, bytesRead)))
    }
    return Buffer.concat(chunks, total)
  } finally {
    if (handle) {
      await handle.close().catch(() => {})
    }
  }
}

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
  /** True while the underlying ssh child process is still running and the handle is open */
  isAlive: () => boolean
  close: () => Promise<void>
}

const SSH_DEFAULT_PORT = 22
const SSH_STDERR_MAX_BYTES = 2048
const SSH_POLL_INTERVAL_MS = 80
const SSH_DEFAULT_TIMEOUT_MS = 12_000
const SSH_PROBE_TIMEOUT_MS = 1000
const SSH_KILL_GRACE_MS = 1200

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
  try {
    const buf = await readRegularFileBounded(filePath, MAX_PEM_FILE_BYTES, label)
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

  if (!hasCustomCerts && !explicitMode && !hasExplicitRejectUnauthorized) return undefined

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

  const rawServername = typeof originalServername === 'string' ? originalServername.trim() : ''
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
      options.rejectUnauthorized = true
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

/** Builds a fully separated argv array for `spawn('ssh', args, { shell: false })` (zero shell interpolation) */
export function buildSshSpawnArgs(
  profile: ConnectionProfile,
  localPort: number,
  targetHost: string,
  targetPort: number,
  options?: { useAskpass?: boolean }
): string[] {
  const config = validateSshTunnelConfig(profile, targetHost, targetPort)
  const authMethod = profile.sshAuthMethod ?? 'agent'
  const useAskpass = Boolean(options?.useAskpass)
  const keyPath =
    authMethod === 'key'
      ? requireSafePath(profile.sshPrivateKeyPath, 'SSH private key path')
      : undefined
  // RFC 3986: IPv6 literals must be bracketed inside ssh `-L` forwarding specs
  const forwardedHost = isIpv6WithOptionalZone(config.targetHost)
    ? `[${config.targetHost}]`
    : config.targetHost

  const authArgs: string[] = useAskpass
    ? [
        '-o',
        'NumberOfPasswordPrompts=1',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'KbdInteractiveAuthentication=no',
        ...(authMethod === 'password'
          ? ['-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no']
          : ['-o', 'PreferredAuthentications=publickey', '-o', 'PasswordAuthentication=no']),
      ]
    : ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes']

  return [
    '-N',
    '-T',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    ...authArgs,
    '-L',
    `127.0.0.1:${localPort}:${forwardedHost}:${config.targetPort}`,
    '-p',
    String(config.sshPort),
    ...(keyPath ? ['-i', keyPath, '-o', 'IdentitiesOnly=yes'] : []),
    '--',
    `${config.sshUser}@${config.sshHost}`,
  ]
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

function probeTcpPort(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (open: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(SSH_PROBE_TIMEOUT_MS, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Terminates the ssh child cleanly: SIGTERM, force SIGKILL after the grace period */
async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const clearKillTimer = (): void => {
    if (killTimer !== undefined) {
      clearTimeout(killTimer)
      killTimer = undefined
    }
  }
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      clearKillTimer()
      resolve()
    })
    child.once('error', () => {
      clearKillTimer()
      resolve()
    })
  })
  try {
    child.kill('SIGTERM')
  } catch {
    return
  }
  const forced = new Promise<void>((resolve) => {
    killTimer = setTimeout(() => {
      killTimer = undefined
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      } catch {
        // Already gone
      }
      // Give the OS kernel a brief window to reap after SIGKILL
      const reapTimer = setTimeout(() => resolve(), 300)
      child.once('exit', () => {
        clearTimeout(reapTimer)
        resolve()
      })
    }, SSH_KILL_GRACE_MS)
  })
  await Promise.race([exited, forced])
  // Never leave a dangling kill timer keeping the Node event loop alive
  clearKillTimer()
}

function sanitizeStderr(stderr: string, secretToScrub?: string): string {
  const masked =
    secretToScrub && secretToScrub.length > 0 ? stderr.split(secretToScrub).join('[REDACTED]') : stderr
  return masked.trim().replace(/\s+/g, ' ').slice(0, SSH_STDERR_MAX_BYTES)
}

interface EphemeralAskpass {
  scriptPath: string
  cleanup: () => Promise<void>
}

const ASKPASS_HELPER_JS = [
  'function extractPrompt() {',
  '  const argvPrompt = process.argv.slice(2).join(" ").trim();',
  '  if (argvPrompt) return argvPrompt;',
  '  const raw = String(process.env.DATANOA_CMD_RAW || "");',
  '  if (!raw) return "";',
  '  const m = /askpass\\.cmd"?\\s+([\\s\\S]+)$/i.exec(raw);',
  '  if (!m) return "";',
  '  let rest = m[1].trim();',
  '  if (/\\/c\\s+""/i.test(raw) && rest.endsWith(\'"\')) rest = rest.slice(0, -1).trim();',
  '  if (rest.length >= 2 && rest.startsWith(\'"\') && rest.endsWith(\'"\')) rest = rest.slice(1, -1);',
  '  return rest.trim();',
  '}',
  'const prompt = extractPrompt();',
  'if (!prompt) { process.exit(1); }',
  'if (/(?:continue connecting|fingerprint|\\(yes\\/no|are you sure|host key)/i.test(prompt)) { process.exit(1); }',
  'const mode = String(process.env.DATANOA_SSH_AUTH_MODE || "").trim().toLowerCase();',
  'if (mode === "password") {',
  '  const body = prompt.replace(/^[^\\s:]+@[^\\s:]+\'s\\s+/i, "");',
  '  if (/\\b(?:passphrase|verification|passcode|otp|token|pin|one-time)\\b/i.test(body) || !/\\bpassword\\s*:?\\s*$/i.test(prompt)) { process.exit(1); }',
  '} else if (mode === "passphrase") {',
  '  if (!/\\bpassphrase\\b/i.test(prompt)) { process.exit(1); }',
  '} else {',
  '  process.exit(1);',
  '}',
  'const secret = process.env.DATANOA_SSH_SECRET || "";',
  'if (!secret) { process.exit(1); }',
  'process.stdout.write(secret);',
  '',
].join('\n')

async function createEphemeralAskpassHelper(): Promise<EphemeralAskpass> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'datanoa-ssh-'))
  const isWin = process.platform === 'win32'
  let cleaned = false
  const cleanup = async (): Promise<void> => {
    if (cleaned) return
    cleaned = true
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  let scriptPath: string
  try {
    if (!isWin) {
      await fs.promises.chmod(dir, 0o700).catch(() => {})
    }
    const jsPath = path.join(dir, 'askpass.cjs')
    await fs.promises.writeFile(jsPath, ASKPASS_HELPER_JS, { encoding: 'utf8', mode: 0o600 })
    if (isWin) {
      scriptPath = path.join(dir, 'askpass.cmd')
      // Pass raw command line via delayed expansion so cmd.exe never re-parses quotes or metacharacters
      const cmdContent =
        '@echo off\r\nsetlocal EnableDelayedExpansion\r\nset "DATANOA_CMD_RAW=!CMDCMDLINE!"\r\n"%DATANOA_NODE_EXE%" "%~dp0askpass.cjs"\r\n'
      await fs.promises.writeFile(scriptPath, cmdContent, { encoding: 'utf8', mode: 0o700 })
    } else {
      scriptPath = path.join(dir, 'askpass.sh')
      const scriptContent = '#!/bin/sh\nexec "$DATANOA_NODE_EXE" "$(dirname "$0")/askpass.cjs" "$@"\n'
      await fs.promises.writeFile(scriptPath, scriptContent, { encoding: 'utf8', mode: 0o700 })
      await fs.promises.chmod(scriptPath, 0o700).catch(() => {})
    }
  } catch (err) {
    await cleanup()
    throw err
  }

  return { scriptPath, cleanup }
}

function matchKnownHostsPattern(pattern: string, targetHost: string, targetPort: number): boolean {
  const candidates =
    targetPort === 22
      ? [targetHost.toLowerCase(), `[${targetHost.toLowerCase()}]:22`]
      : [`[${targetHost.toLowerCase()}]:${targetPort}`]
  if (pattern.startsWith('|1|')) {
    const parts = pattern.split('|')
    if (parts.length !== 4 || !parts[2] || !parts[3]) return false
    let salt: Buffer
    let expectedHash: Buffer
    try {
      salt = Buffer.from(parts[2], 'base64')
      expectedHash = Buffer.from(parts[3], 'base64')
    } catch {
      return false
    }
    for (const candidate of candidates) {
      const digest = crypto.createHmac('sha1', salt).update(candidate, 'utf8').digest()
      if (digest.length === expectedHash.length && crypto.timingSafeEqual(digest, expectedHash)) {
        return true
      }
    }
    return false
  }
  const normalizedPattern = pattern.toLowerCase()
  return candidates.includes(normalizedPattern)
}

export type KnownHostsCheckResult = 'matched' | 'mismatch' | 'revoked' | 'unknown'

/**
 * Verifies an SSH server host key against OpenSSH `known_hosts` text (plain, `[host]:port`,
 * comma-separated host patterns, and `|1|<salt>|<hmac-sha1>` hashed entries).
 */
export function verifySshHostKeyAgainstKnownHosts(
  host: string,
  port: number,
  serverHostKey: Buffer,
  knownHostsText: string
): KnownHostsCheckResult {
  const normalizedHost = host.trim().toLowerCase()
  let sawMatchingHost = false
  let matchedKey = false

  for (const rawLine of knownHostsText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    let idx = 0
    let marker: '' | '@revoked' | '@cert-authority' = ''
    if (parts[0] === '@revoked' || parts[0] === '@cert-authority') {
      marker = parts[0]
      idx = 1
    }
    if (parts.length < idx + 3) continue
    if (marker === '@cert-authority') continue

    const hostField = parts[idx]
    const keyBase64 = parts[idx + 2]
    const patterns = hostField.split(',').filter(Boolean)
    let matchedHost = false
    let negated = false
    for (const pat of patterns) {
      if (pat.startsWith('!')) {
        if (matchKnownHostsPattern(pat.slice(1), normalizedHost, port)) {
          negated = true
        }
      } else if (matchKnownHostsPattern(pat, normalizedHost, port)) {
        matchedHost = true
      }
    }
    if (!matchedHost || negated) continue

    let entryKey: Buffer
    try {
      entryKey = Buffer.from(keyBase64, 'base64')
    } catch {
      continue
    }
    if (entryKey.length === 0) continue

    const keyEquals =
      entryKey.length === serverHostKey.length && crypto.timingSafeEqual(entryKey, serverHostKey)
    if (marker === '@revoked') {
      if (keyEquals) return 'revoked'
      continue
    }
    sawMatchingHost = true
    if (keyEquals) {
      matchedKey = true
    }
  }

  if (matchedKey) return 'matched'
  if (sawMatchingHost) return 'mismatch'
  return 'unknown'
}

async function loadKnownHostsTexts(overridePaths?: readonly string[]): Promise<string[]> {
  const candidates =
    overridePaths && overridePaths.length > 0
      ? [...overridePaths]
      : [
          path.join(os.homedir(), '.ssh', 'known_hosts'),
          ...(process.platform === 'win32'
            ? [path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'ssh', 'ssh_known_hosts')]
            : ['/etc/ssh/ssh_known_hosts']),
        ]
  const out: string[] = []
  for (const filePath of candidates) {
    try {
      const buf = await readRegularFileBounded(filePath, MAX_KNOWN_HOSTS_BYTES, 'known_hosts')
      out.push(buf.toString('utf8'))
    } catch {
      // Missing or unreadable known_hosts file
    }
  }
  return out
}

type Ssh2VendorModule = typeof import('../../../vendor/ssh2.js')
let ssh2VendorPromise: Promise<Ssh2VendorModule> | null = null

async function loadSsh2Vendor(): Promise<Ssh2VendorModule> {
  if (!ssh2VendorPromise) {
    ssh2VendorPromise = import('../../../vendor/ssh2.js').catch((err: unknown) => {
      ssh2VendorPromise = null
      throw err
    })
  }
  return ssh2VendorPromise
}

async function openInProcessSsh2Tunnel(
  profile: ConnectionProfile,
  targetHost: string,
  targetPort: number,
  options?: {
    timeoutMs?: number
    secrets?: SshSecretBundle
    knownHostsPaths?: readonly string[]
  }
): Promise<SshTunnelHandle> {
  const timeoutMs = options?.timeoutMs ?? SSH_DEFAULT_TIMEOUT_MS
  const config = validateSshTunnelConfig(profile, targetHost, targetPort)
  const authMethod = profile.sshAuthMethod ?? 'agent'

  let sshPassword: string | undefined
  let privateKey: Buffer | undefined
  let passphrase: string | undefined
  let agent: string | undefined

  if (authMethod === 'password') {
    const pwd = options?.secrets?.sshPassword
    if (typeof pwd !== 'string' || pwd.length === 0) {
      throw new Error('SSH password is required when SSH authentication method is "password".')
    }
    sshPassword = pwd
  } else if (authMethod === 'key') {
    const keyPath = requireSafePath(profile.sshPrivateKeyPath, 'SSH private key path')
    privateKey = await readRegularFileBounded(keyPath, MAX_PEM_FILE_BYTES, 'SSH private key')
    if (typeof options?.secrets?.sshPassphrase === 'string' && options.secrets.sshPassphrase.length > 0) {
      passphrase = options.secrets.sshPassphrase
    }
  } else {
    agent =
      process.env.SSH_AUTH_SOCK ||
      (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
  }

  const knownHostsTexts = await loadKnownHostsTexts(options?.knownHostsPaths)
  const { Client } = await loadSsh2Vendor()
  const client = new Client()
  let hostVerifyError = ''
  let clientReady = false
  let clientClosed = false
  let closed = false
  const activeSockets = new Set<net.Socket>()

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finishErr = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        client.destroy()
      } catch {
        // Ignore
      }
      reject(err)
    }
    const timer = setTimeout(() => {
      finishErr(
        new Error(
          `SSH tunnel to ${config.targetHost}:${config.targetPort} via ${config.sshHost}:${config.sshPort} timed out after ${timeoutMs}ms.`
        )
      )
    }, timeoutMs)

    client.once('ready', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clientReady = true
      resolve()
    })
    client.once('error', (err) => {
      const detail = hostVerifyError || sanitizeStderr(err.message, sshPassword ?? passphrase)
      const authHint =
        authMethod === 'password'
          ? ' Verify the SSH password, username, and that the bastion host key is in known_hosts.'
          : authMethod === 'key'
            ? ' Verify the private key path, passphrase (if encrypted), and known_hosts entry.'
            : ''
      finishErr(
        new Error(
          `SSH tunnel to ${config.targetHost}:${config.targetPort} via ${config.sshHost}:${config.sshPort} failed: ${detail}.${authHint}`
        )
      )
    })
    client.once('close', () => {
      clientClosed = true
      if (!settled) {
        finishErr(
          new Error(
            hostVerifyError ||
              `SSH tunnel to ${config.targetHost}:${config.targetPort} closed before handshake completed.`
          )
        )
      }
    })
    if (sshPassword) {
      let kbdAttempted = false
      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        if (kbdAttempted || prompts.length === 0) {
          finish([])
          return
        }
        kbdAttempted = true
        const responses = prompts.map((p) => {
          const text = String(p.prompt || '')
          if (/(?:continue connecting|fingerprint|host key|passphrase|otp|token|verification)/i.test(text)) {
            return ''
          }
          return sshPassword ?? ''
        })
        finish(responses)
      })
    }

    client.connect({
      host: config.sshHost,
      port: config.sshPort,
      username: config.sshUser,
      ...(sshPassword ? { password: sshPassword, tryKeyboard: true } : {}),
      ...(privateKey ? { privateKey } : {}),
      ...(passphrase ? { passphrase } : {}),
      ...(agent ? { agent } : {}),
      readyTimeout: timeoutMs,
      keepaliveInterval: 30_000,
      keepaliveCountMax: 3,
      hostVerifier: (rawKey: Buffer | string): boolean => {
        const keyBuf = Buffer.isBuffer(rawKey) ? rawKey : Buffer.from(rawKey, 'binary')
        let verdict: KnownHostsCheckResult = 'unknown'
        for (const text of knownHostsTexts) {
          const res = verifySshHostKeyAgainstKnownHosts(config.sshHost, config.sshPort, keyBuf, text)
          if (res === 'revoked') {
            verdict = 'revoked'
            break
          }
          if (res === 'matched') {
            verdict = 'matched'
            break
          }
          if (res === 'mismatch') {
            verdict = 'mismatch'
          }
        }
        if (verdict === 'matched') return true
        if (verdict === 'revoked') {
          hostVerifyError = `Host key for ${config.sshHost}:${config.sshPort} is revoked in known_hosts`
        } else if (verdict === 'mismatch') {
          hostVerifyError = `Host key verification failed: remote host identification for ${config.sshHost}:${config.sshPort} has changed`
        } else {
          hostVerifyError = `Host key verification failed: ${config.sshHost}:${config.sshPort} is not present in known_hosts`
        }
        return false
      },
    })
  })

  const server = net.createServer((localSock) => {
    activeSockets.add(localSock)
    localSock.once('close', () => activeSockets.delete(localSock))
    localSock.on('error', () => {
      localSock.destroy()
    })
    if (closed || clientClosed) {
      localSock.destroy()
      return
    }
    const srcIp = localSock.remoteAddress || '127.0.0.1'
    const srcPort = localSock.remotePort || 0
    client.forwardOut(srcIp, srcPort, config.targetHost, config.targetPort, (err, channel) => {
      if (err || !channel || localSock.destroyed) {
        localSock.destroy(err ?? undefined)
        return
      }
      localSock.pipe(channel)
      channel.pipe(localSock)
      channel.on('error', () => {
        localSock.destroy()
      })
      channel.once('close', () => {
        localSock.destroy()
      })
      localSock.once('close', () => {
        try {
          channel.close()
        } catch {
          // Ignore
        }
      })
    })
  })

  client.on('error', () => {
    clientClosed = true
  })
  client.on('close', () => {
    clientClosed = true
    for (const sock of activeSockets) {
      sock.destroy()
    }
    activeSockets.clear()
    server.close()
  })

  const localPort = await new Promise<number>((resolve, reject) => {
    server.once('error', (err) => {
      client.destroy()
      reject(err)
    })
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      if (port > 0) resolve(port)
      else {
        server.close()
        client.destroy()
        reject(new Error('Failed to bind local SSH forwarding port on 127.0.0.1'))
      }
    })
  })

  let closePromise: Promise<void> | null = null
  const close = (): Promise<void> => {
    closed = true
    if (!closePromise) {
      closePromise = new Promise<void>((resolve) => {
        for (const sock of activeSockets) {
          sock.destroy()
        }
        activeSockets.clear()
        server.close(() => {
          try {
            client.end()
            client.destroy()
          } catch {
            // Ignore
          }
          resolve()
        })
      })
    }
    return closePromise
  }

  const isAlive = (): boolean => !closed && clientReady && !clientClosed && server.listening
  return { localHost: '127.0.0.1', localPort, isAlive, close }
}

/**
 * Opens an SSH local port forward to `targetHost:targetPort` through the configured bastion.
 * Uses pure-JS in-process `ssh2` by default (zero child env secrets, zero temp askpass files,
 * zero ephemeral port TOCTOU, zero TCP RST probe spam). Falls back to OS `ssh` argv spawning
 * ONLY when an explicit `options.sshBinary` override is supplied (e.g. test harnesses).
 */
export async function openSshTunnel(
  profile: ConnectionProfile,
  targetHost: string,
  targetPort: number,
  options?: {
    timeoutMs?: number
    sshBinary?: string
    secrets?: SshSecretBundle
    knownHostsPaths?: readonly string[]
  }
): Promise<SshTunnelHandle> {
  const customBinary = options?.sshBinary?.trim()
  if (!customBinary) {
    return openInProcessSsh2Tunnel(profile, targetHost, targetPort, options)
  }

  const timeoutMs = options?.timeoutMs ?? SSH_DEFAULT_TIMEOUT_MS
  const sshBinary = customBinary
  const authMethod = profile.sshAuthMethod ?? 'agent'

  let askpassSecret: string | undefined
  if (authMethod === 'password') {
    const pwd = options?.secrets?.sshPassword
    if (typeof pwd !== 'string' || pwd.length === 0) {
      throw new Error('SSH password is required when SSH authentication method is "password".')
    }
    askpassSecret = pwd
  } else if (authMethod === 'key') {
    const passphrase = options?.secrets?.sshPassphrase
    if (typeof passphrase === 'string' && passphrase.length > 0) {
      askpassSecret = passphrase
    }
  }

  const useAskpass = typeof askpassSecret === 'string' && askpassSecret.length > 0
  const localPort = await allocateEphemeralPort()
  const args = buildSshSpawnArgs(profile, localPort, targetHost, targetPort, { useAskpass })

  const askpassHelper = useAskpass ? await createEphemeralAskpassHelper() : null

  let child: ChildProcess | undefined
  try {
    // A `.js`/`.mjs`/`.cjs` sshBinary runs through the current Node binary (tests/CI mock bastion)
    const isNodeScript = /\.(?:mjs|cjs|js)$/i.test(sshBinary)
    const spawnCommand = isNodeScript ? process.execPath : sshBinary
    const spawnArgs = isNodeScript ? [sshBinary, ...args] : args

    const spawnEnv: NodeJS.ProcessEnv =
      askpassHelper && askpassSecret
        ? {
            ...process.env,
            SSH_ASKPASS: askpassHelper.scriptPath,
            SSH_ASKPASS_REQUIRE: 'force',
            DISPLAY: process.env.DISPLAY || 'datanoa:0',
            DATANOA_SSH_SECRET: askpassSecret,
            DATANOA_SSH_AUTH_MODE: authMethod === 'password' ? 'password' : 'passphrase',
            DATANOA_NODE_EXE: process.execPath,
            ELECTRON_RUN_AS_NODE: '1',
          }
        : { ...process.env }

    child = spawn(spawnCommand, spawnArgs, {
      shell: false,
      // The ssh child never writes meaningful stdout; ignoring it prevents pipe backpressure
      stdio: ['ignore', 'ignore', 'pipe'],
      env: spawnEnv,
      windowsHide: true,
    })

    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < SSH_STDERR_MAX_BYTES) {
        stderr = (stderr + chunk).slice(0, SSH_STDERR_MAX_BYTES)
      }
    })
    // Never leave an unhandled stream error behind
    child.stderr?.on('error', () => {})

    let exitDetail = ''
    let hasExited = false
    child.once('error', (err: Error) => {
      hasExited = true
      exitDetail = `failed to start "${sshBinary}": ${err.message}`
    })
    child.once('exit', (code, signal) => {
      hasExited = true
      if (!exitDetail) {
        exitDetail = `exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`
      }
    })

    const failure = (reason: string): Error => {
      const detail = sanitizeStderr(stderr, askpassSecret)
      const authHint =
        authMethod === 'password'
          ? ' Verify the SSH password, username, and that the bastion host key is in known_hosts.'
          : authMethod === 'key'
            ? ' Verify the private key path, passphrase (if encrypted), and known_hosts entry.'
            : ''
      return new Error(
        `SSH tunnel to ${targetHost}:${targetPort} via ${sshBinary} ${reason}.${detail ? ` ssh: ${detail}` : ''}${authHint}`
      )
    }

    const deadline = Date.now() + timeoutMs
    for (;;) {
      // Check exit BEFORE probing: a dying ssh must never be masked by a stale bind (TOCTOU)
      if (hasExited) {
        throw failure(exitDetail)
      }
      if (await probeTcpPort(localPort)) break
      if (hasExited) {
        throw failure(exitDetail)
      }
      if (Date.now() >= deadline) {
        throw failure(`did not open local forwarding port ${localPort} within ${timeoutMs}ms`)
      }
      await delay(SSH_POLL_INTERVAL_MS)
    }

    const activeChild = child
    let closePromise: Promise<void> | null = null
    let closed = false
    const close = (): Promise<void> => {
      closed = true
      if (!closePromise) closePromise = terminateChild(activeChild)
      return closePromise
    }
    const isAlive = (): boolean =>
      !closed && !hasExited && activeChild.exitCode === null && activeChild.signalCode === null

    return { localHost: '127.0.0.1', localPort, isAlive, close }
  } catch (err) {
    if (child) {
      await terminateChild(child)
    }
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    if (askpassHelper) {
      await askpassHelper.cleanup()
    }
  }
}
