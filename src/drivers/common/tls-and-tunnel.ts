// TLS (custom CA / client certs) + OS SSH tunnel helpers.
// Zero vendor additions: uses node:fs / node:net / node:tls / node:child_process only.

import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tls from 'node:tls'
import type { ConnectionProfile } from '../../protocol'

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

function trimOptionalPath(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

async function readPemFile(filePath: string, label: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, 'utf8')
  } catch (err: unknown) {
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

  if (!hasCustomCerts && !explicitMode) return undefined

  const options: tls.ConnectionOptions = {}
  if (caPath) options.ca = await readPemFile(caPath, 'SSL CA certificate')
  if (certPath) options.cert = await readPemFile(certPath, 'SSL client certificate')
  if (keyPath) options.key = await readPemFile(keyPath, 'SSL client private key')

  const passphrase = secrets?.sslKeyPassphrase
  if (typeof passphrase === 'string' && passphrase.length > 0) {
    options.passphrase = passphrase
  }

  const rawServername = typeof originalServername === 'string' ? originalServername.trim() : ''
  const trimmedServername =
    rawServername.startsWith('[') && rawServername.endsWith(']') && net.isIP(rawServername.slice(1, -1)) === 6
      ? rawServername.slice(1, -1)
      : rawServername
  const servernameIsIpLiterals = trimmedServername.length > 0 && net.isIP(trimmedServername) !== 0
  // RFC 6066: SNI must never carry an IP literal (OpenSSL rejects/ignores it)
  if (trimmedServername.length > 0 && !servernameIsIpLiterals) {
    options.servername = trimmedServername
  }

  switch (profile.sslMode) {
    case 'require':
      options.rejectUnauthorized = profile.sslRejectUnauthorized ?? false
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
      options.rejectUnauthorized = profile.sslRejectUnauthorized ?? true
      break
  }

  return options
}

/** Backwards-compatible alias used by drivers that only need the TLS options */
export const buildTlsConnectionOptions = resolveEffectiveTlsOptions

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
    if (net.isIP(inner) !== 6) {
      throw new Error('SSH host brackets may only wrap a valid IPv6 address')
    }
    return inner
  }
  if (raw.includes(':') && net.isIP(raw) !== 6) {
    throw new Error('SSH host must not contain ":" unless it is a valid IPv6 address')
  }
  return raw
}

function normalizeTunnelTargetHost(value: unknown): string {
  const raw = requireSafeToken(value, 'SSH tunnel target host', ['@', '/', '\\'])
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1)
    if (net.isIP(inner) !== 6) {
      throw new Error('SSH tunnel target host brackets may only wrap a valid IPv6 address')
    }
    return inner
  }
  if (raw.includes(':') && net.isIP(raw) !== 6) {
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
  const forwardedHost = net.isIP(config.targetHost) === 6 ? `[${config.targetHost}]` : config.targetHost

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
      resolve()
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

/**
 * Opens an SSH local port forward to `targetHost:targetPort` through the configured bastion.
 * Uses the OS `ssh` binary with an argv array (`shell: false`) — never `sh -c`.
 */
export async function openSshTunnel(
  profile: ConnectionProfile,
  targetHost: string,
  targetPort: number,
  options?: { timeoutMs?: number; sshBinary?: string; secrets?: SshSecretBundle }
): Promise<SshTunnelHandle> {
  const timeoutMs = options?.timeoutMs ?? SSH_DEFAULT_TIMEOUT_MS
  const sshBinary = options?.sshBinary?.trim() || 'ssh'
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
