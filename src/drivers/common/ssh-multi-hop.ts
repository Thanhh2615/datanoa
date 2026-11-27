// Pure-JS multi-hop SSH tunnel chain (1..N hops) over vendor/ssh2.js and Happy Eyeballs dialTcp.
// Zero OS ssh binary spawning; all connections run in-process.

import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Duplex } from 'node:stream'
import type {
  ConnectionProfile,
  SshHostKeyChallenge,
  SshJumpHopSecret,
  SshJumpHostProfile,
} from '../../protocol'
import type { Ssh2ClientChannel, Ssh2ConnectConfig } from '../../../vendor/ssh2.d.ts'
import { readRegularFileBounded } from './bounded-file-reader'
import { networkDialer, type DialTcpOptions } from './network-dialer'
import {
  collectAllChainSecretStrings,
  MAX_SSH_JUMP_HOPS,
  resolveChainRuntimeSecrets,
  scrubChainSecrets,
  SSH_HOP_ID_RE,
} from './ssh-hop-secrets'
import {
  computeSshHostKeyFingerprintSha256,
  extractSshKeyTypeFromBlob,
  loadKnownHostsFiles,
  resolvePreferredServerHostKeyAlgorithms,
  verifySshHostKeyAcrossFiles,
  type KnownHostsFileSource,
} from './ssh-host-keys'

const MAX_PEM_FILE_BYTES = 1024 * 1024
const DEFAULT_SSH_TIMEOUT_MS = 12_000
const INVALID_TOKEN_CHARS = /[\s\u0000-\u001f\u007f]/
const INVALID_CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export interface TrustedHostKeyPin {
  host: string
  port?: number
  exactFingerprint: string
}

export interface MultiHopSshTunnelHandle {
  localHost: '127.0.0.1'
  localPort: number
  originalServername: string
  hopCount: number
  isAlive: () => boolean
  close: () => Promise<void>
}

export interface SshClientLike {
  connect(config: Ssh2ConnectConfig): this
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (err: Error | undefined, channel: Ssh2ClientChannel) => void
  ): this
  end(): this
  destroy(): this
  on(event: string, listener: (...args: unknown[]) => void): this
  once(event: string, listener: (...args: unknown[]) => void): this
  removeAllListeners(event?: string): this
}

export interface MultiHopSshOptions {
  timeoutMs?: number
  connectionId?: string
  panelId?: string
  secrets?: {
    sshPassphrase?: string
    sshPassword?: string
  }
  hopSecrets?: Readonly<Record<string, SshJumpHopSecret>>
  knownHostsPaths?: readonly string[]
  trustedHostKeys?: TrustedHostKeyPin[]
  consumeTrustedHostKeyPin?: (host: string, port: number, exactFingerprint: string) => boolean
  readPrivateKey?: (resolvedPath: string) => Promise<Buffer>
  dialTcpFn?: (opts: DialTcpOptions) => Promise<net.Socket>
  createSshClient?: () => SshClientLike
}

/**
 * Structured host-key verification error preserving full `SshHostKeyChallenge` metadata
 * through `scrubAndEnhanceWorkerError` so Studio & Side Panel can present the trust modal.
 */
export class SshHostKeyVerificationError extends Error {
  readonly code = 'SSH_HOST_KEY_VERIFICATION_FAILED'
  readonly sshChallenge: SshHostKeyChallenge

  constructor(message: string, challenge: SshHostKeyChallenge) {
    super(message)
    this.name = 'SshHostKeyVerificationError'
    this.sshChallenge = challenge
  }
}

interface NormalizedSshHop {
  hopIndex: number
  host: string
  port: number
  user: string
  authMethod: 'agent' | 'key' | 'password'
  privateKeyPath?: string
  password?: string
  passphrase?: string
}

/**
 * Safely expands leading `~/` or `~\` to `os.homedir()` while rejecting control characters,
 * option-injection prefixes (`-`), and `~otheruser/` forms.
 */
export function expandSshPrivateKeyPath(rawPath: string): string {
  if (typeof rawPath !== 'string') {
    throw new Error('SSH private key path is required when SSH authMethod is "key"')
  }
  const trimmed = rawPath.trim()
  if (!trimmed) {
    throw new Error('SSH private key path is required when SSH authMethod is "key"')
  }
  if (INVALID_CONTROL_CHARS.test(trimmed)) {
    throw new Error('SSH private key path must not contain control characters')
  }
  if (trimmed.startsWith('-')) {
    throw new Error("SSH private key path must not start with '-' (prevents option injection)")
  }
  if (trimmed === '~') {
    return os.homedir()
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2))
  }
  if (trimmed.startsWith('~')) {
    throw new Error('SSH private key path "~user" syntax is unsupported; use ~/ or an absolute path')
  }
  return trimmed
}

function normalizeSshHopHost(raw: unknown, label: string): string {
  if (typeof raw !== 'string') {
    throw new Error(`${label} is required for SSH tunneling`)
  }
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error(`${label} is required for SSH tunneling`)
  }
  if (INVALID_TOKEN_CHARS.test(trimmed)) {
    throw new Error(`${label} must not contain whitespace or control characters`)
  }
  if (trimmed.startsWith('-')) {
    throw new Error(`${label} must not start with '-'`)
  }
  for (const ch of ['@', '/', '\\']) {
    if (trimmed.includes(ch)) {
      throw new Error(`${label} must not contain "${ch}"`)
    }
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1)
    if (net.isIP(inner.split('%')[0]) !== 6) {
      throw new Error(`${label} brackets may only wrap a valid IPv6 address`)
    }
    return inner
  }
  if (trimmed.includes(':') && net.isIP(trimmed.split('%')[0]) !== 6) {
    throw new Error(`${label} must not contain ":" unless it is a valid IPv6 address`)
  }
  return trimmed
}

function requireHopUser(raw: unknown, label: string): string {
  if (typeof raw !== 'string') {
    throw new Error(`${label} is required for SSH tunneling`)
  }
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error(`${label} is required for SSH tunneling`)
  }
  if (INVALID_TOKEN_CHARS.test(trimmed) || trimmed.startsWith('-')) {
    throw new Error(`${label} contains invalid characters`)
  }
  for (const ch of ['@', '/', ':', '\\']) {
    if (trimmed.includes(ch)) {
      throw new Error(`${label} must not contain "${ch}"`)
    }
  }
  return trimmed
}

function requireHopPort(raw: unknown, label: string, fallback?: number): number {
  const value = raw === undefined || raw === null || raw === '' ? fallback : raw
  const port = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`)
  }
  return port
}

function buildNormalizedHopChain(
  profile: ConnectionProfile,
  options?: MultiHopSshOptions
): NormalizedSshHop[] {
  const jumpList: SshJumpHostProfile[] = Array.isArray(profile.sshJumpHosts)
    ? profile.sshJumpHosts
    : []
  if (jumpList.length > MAX_SSH_JUMP_HOPS) {
    throw new Error(`SSH jump chain exceeds maximum of ${MAX_SSH_JUMP_HOPS} intermediate hops`)
  }

  const runtimeSecrets = resolveChainRuntimeSecrets(profile, options?.secrets, options?.hopSecrets)
  const hops: NormalizedSshHop[] = []
  const seenHopIds = new Set<string>()

  for (let i = 0; i < jumpList.length; i++) {
    const rawHop = jumpList[i]
    const hopId = typeof rawHop.hopId === 'string' ? rawHop.hopId.trim() : ''
    if (!SSH_HOP_ID_RE.test(hopId)) {
      throw new Error(`Invalid jump hopId at index ${i}`)
    }
    if (seenHopIds.has(hopId)) {
      throw new Error(`Duplicate SSH jump hopId "${hopId}"`)
    }
    seenHopIds.add(hopId)
    const authMethod = rawHop.authMethod ?? 'agent'
    const privateKeyPath =
      authMethod === 'key'
        ? expandSshPrivateKeyPath(rawHop.privateKeyPath ?? '')
        : undefined
    const hopSec = runtimeSecrets.jumpHops[i] ?? {}
    hops.push({
      hopIndex: i,
      host: normalizeSshHopHost(rawHop.host, `Jump hop #${i + 1} host`),
      port: requireHopPort(rawHop.port, `Jump hop #${i + 1} port`, 22),
      user: requireHopUser(rawHop.user, `Jump hop #${i + 1} user`),
      authMethod,
      privateKeyPath,
      password: hopSec.password,
      passphrase: hopSec.passphrase,
    })
  }

  const bastionAuth = profile.sshAuthMethod ?? 'agent'
  const bastionKeyPath =
    bastionAuth === 'key'
      ? expandSshPrivateKeyPath(profile.sshPrivateKeyPath ?? '')
      : undefined
  hops.push({
    hopIndex: jumpList.length,
    host: normalizeSshHopHost(profile.sshHost, 'SSH host'),
    port: requireHopPort(profile.sshPort, 'SSH port', 22),
    user: requireHopUser(profile.sshUser, 'SSH user'),
    authMethod: bastionAuth,
    privateKeyPath: bastionKeyPath,
    password: runtimeSecrets.bastion.password,
    passphrase: runtimeSecrets.bastion.passphrase,
  })

  return hops
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

function consumeSingleUseTrustedHostKey(
  pins: TrustedHostKeyPin[] | undefined,
  host: string,
  port: number,
  fingerprintSha256: string
): boolean {
  if (!Array.isArray(pins) || pins.length === 0) return false
  const normHost = host.trim().toLowerCase()
  const idx = pins.findIndex((pin) => {
    const pinHost = pin.host.trim().toLowerCase()
    const portMatches = pin.port === undefined || pin.port === port
    return pinHost === normHost && portMatches && pin.exactFingerprint === fingerprintSha256
  })
  if (idx < 0) return false
  pins.splice(idx, 1)
  return true
}

interface OpenedHopResource {
  client: SshClientLike
  underlyingSock: Duplex
}

class SharedChainSessionEnd {
  firstError: Error | null = null
  ended = false
  private readonly openedHops: OpenedHopResource[] = []
  private readonly activeLocalSockets = new Set<net.Socket>()
  private readonly activeChannels = new Set<Duplex>()
  private localServer: net.Server | null = null
  private teardownPromise: Promise<void> | null = null

  constructor(private readonly allSecrets: readonly string[]) {}

  attachServer(server: net.Server): void {
    this.localServer = server
  }

  trackLocalSocket(sock: net.Socket): void {
    this.activeLocalSockets.add(sock)
    sock.once('close', () => {
      this.activeLocalSockets.delete(sock)
    })
  }

  trackChannel(channel: Duplex): void {
    this.activeChannels.add(channel)
    channel.once('close', () => {
      this.activeChannels.delete(channel)
    })
  }

  registerHop(resource: OpenedHopResource): void {
    this.openedHops.push(resource)
  }

  sanitizeError(err: unknown): Error {
    if (err instanceof SshHostKeyVerificationError) {
      return err
    }
    const rawMsg = err instanceof Error ? err.message : String(err)
    const cleanMsg = scrubChainSecrets(rawMsg, this.allSecrets)
    if (err instanceof Error && cleanMsg === err.message) {
      return err
    }
    const wrapped = new Error(cleanMsg)
    if (err && typeof err === 'object' && 'code' in err) {
      ;(wrapped as Error & { code?: unknown }).code = (err as { code?: unknown }).code
    }
    return wrapped
  }

  recordError(err: unknown): Error {
    const sanitized = this.sanitizeError(err)
    if (!this.firstError) {
      this.firstError = sanitized
    }
    return this.firstError
  }

  async teardown(): Promise<void> {
    this.ended = true
    if (this.teardownPromise) {
      return await this.teardownPromise
    }
    this.teardownPromise = (async () => {
      for (const sock of this.activeLocalSockets) {
        try {
          sock.destroy()
        } catch {
          // Ignore
        }
      }
      this.activeLocalSockets.clear()

      for (const ch of this.activeChannels) {
        try {
          const withClose = ch as Duplex & { close?: () => void }
          if (typeof withClose.close === 'function') withClose.close()
          if (!ch.destroyed) ch.destroy()
        } catch {
          // Ignore
        }
      }
      this.activeChannels.clear()

      if (this.localServer) {
        const srv = this.localServer
        this.localServer = null
        await new Promise<void>((resolve) => {
          try {
            srv.close(() => resolve())
          } catch {
            resolve()
          }
        })
      }

      // Reverse teardown of all opened hops [...hops].reverse()
      const reversed = [...this.openedHops].reverse()
      this.openedHops.length = 0
      for (const hop of reversed) {
        try {
          hop.client.end()
        } catch {
          // Ignore
        }
        try {
          hop.client.destroy()
        } catch {
          // Ignore
        }
        try {
          if (!hop.underlyingSock.destroyed) {
            hop.underlyingSock.destroy()
          }
        } catch {
          // Ignore
        }
      }
    })()
    return await this.teardownPromise
  }
}

async function connectSingleHopClient(params: {
  hop: NormalizedSshHop
  hopCount: number
  sock: Duplex
  timeoutMs: number
  knownHostsFiles: readonly KnownHostsFileSource[]
  trustedHostKeys?: TrustedHostKeyPin[]
  consumeTrustedHostKeyPin?: (host: string, port: number, exactFingerprint: string) => boolean
  connectionId?: string
  panelId?: string
  readPrivateKey: (p: string) => Promise<Buffer>
  createSshClient: () => SshClientLike
  sessionEnd: SharedChainSessionEnd
}): Promise<SshClientLike> {
  const { hop, hopCount, sock, timeoutMs } = params

  const client = params.createSshClient()
  params.sessionEnd.registerHop({ client, underlyingSock: sock })

  let privateKey: Buffer | undefined
  let sshPassword: string | undefined
  let passphrase: string | undefined
  let agent: string | undefined

  try {
    if (hop.authMethod === 'password') {
      if (!hop.password) {
        throw new Error(`SSH password is required for hop "${hop.host}:${hop.port}"`)
      }
      sshPassword = hop.password
    } else if (hop.authMethod === 'key') {
      if (!hop.privateKeyPath) {
        throw new Error(`SSH private key path is required for hop "${hop.host}:${hop.port}"`)
      }
      privateKey = await params.readPrivateKey(hop.privateKeyPath)
      if (hop.passphrase) {
        passphrase = hop.passphrase
      }
    } else {
      agent =
        process.env.SSH_AUTH_SOCK ||
        (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
    }

    const preferredAlgos = resolvePreferredServerHostKeyAlgorithms(
      hop.host,
      hop.port,
      params.knownHostsFiles
    )

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let hostKeyError: SshHostKeyVerificationError | null = null

      const finishErr = (err: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const recorded = hostKeyError ?? params.sessionEnd.recordError(err)
        reject(recorded)
      }

      const timer = setTimeout(() => {
        finishErr(
          new Error(`SSH handshake to ${hop.host}:${hop.port} (hop ${hop.hopIndex + 1}/${hopCount}) timed out after ${timeoutMs}ms`)
        )
      }, timeoutMs)

      client.once('ready', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      })

      client.on('error', (err: unknown) => {
        if (!settled) {
          if (hostKeyError) {
            finishErr(hostKeyError)
            return
          }
          const baseMsg = err instanceof Error ? err.message : String(err)
          finishErr(
            new Error(
              `SSH hop ${hop.hopIndex + 1}/${hopCount} (${hop.host}:${hop.port}) failed: ${baseMsg}`
            )
          )
          return
        }
        params.sessionEnd.recordError(err)
        void params.sessionEnd.teardown()
      })

      client.on('close', () => {
        if (!settled) {
          finishErr(
            hostKeyError ??
              new Error(
                `SSH hop ${hop.hopIndex + 1}/${hopCount} (${hop.host}:${hop.port}) closed before handshake completed`
              )
          )
          return
        }
        void params.sessionEnd.teardown()
      })

      if (sshPassword) {
        let kbdAttempted = false
        client.on(
          'keyboard-interactive',
          (
            _name: unknown,
            _instructions: unknown,
            _lang: unknown,
            prompts: unknown,
            finish: unknown
          ) => {
            const promptList = Array.isArray(prompts)
              ? (prompts as Array<{ prompt?: string }>)
              : []
            const finishFn = typeof finish === 'function' ? (finish as (r: string[]) => void) : null
            if (!finishFn) return
            if (kbdAttempted || promptList.length === 0) {
              finishFn([])
              return
            }
            kbdAttempted = true
            const responses = promptList.map((p) => {
              const text = String(p.prompt ?? '')
              if (
                /(?:continue connecting|fingerprint|host key|passphrase|otp|token|verification)/i.test(
                  text
                )
              ) {
                return ''
              }
              return sshPassword ?? ''
            })
            finishFn(responses)
          }
        )
      }

      client.connect({
        sock,
        host: hop.host,
        port: hop.port,
        username: hop.user,
        ...(sshPassword ? { password: sshPassword, tryKeyboard: true } : {}),
        ...(privateKey ? { privateKey } : {}),
        ...(passphrase ? { passphrase } : {}),
        ...(agent ? { agent } : {}),
        readyTimeout: timeoutMs,
        keepaliveInterval: 30_000,
        keepaliveCountMax: 3,
        algorithms: { serverHostKey: preferredAlgos },
        hostVerifier: (rawKey: Buffer | string): boolean => {
          const keyBuf = Buffer.isBuffer(rawKey) ? rawKey : Buffer.from(rawKey, 'binary')
          const fingerprintSha256 = computeSshHostKeyFingerprintSha256(keyBuf)
          const keyType = extractSshKeyTypeFromBlob(keyBuf)

          const check = verifySshHostKeyAcrossFiles(
            hop.host,
            hop.port,
            keyBuf,
            params.knownHostsFiles
          )
          if (check.result !== 'revoked') {
            const pinAccepted = params.consumeTrustedHostKeyPin
              ? params.consumeTrustedHostKeyPin(hop.host, hop.port, fingerprintSha256)
              : consumeSingleUseTrustedHostKey(
                  params.trustedHostKeys,
                  hop.host,
                  hop.port,
                  fingerprintSha256
                )
            if (pinAccepted || check.result === 'matched') {
              return true
            }
          }

          const reason =
            check.result === 'revoked'
              ? 'revoked'
              : check.result === 'mismatch'
                ? 'mismatch'
                : 'unknown'
          const challenge: SshHostKeyChallenge = {
            challengeId: '',
            ...(params.panelId ? { panelId: params.panelId } : {}),
            ...(params.connectionId ? { connectionId: params.connectionId } : {}),
            host: hop.host,
            port: hop.port,
            keyType,
            keyBlob: keyBuf.toString('base64'),
            fingerprintSha256,
            reason,
            ...(check.knownHostsPath ? { knownHostsPath: check.knownHostsPath } : {}),
            ...(check.line !== undefined ? { line: check.line } : {}),
            ...(check.existingFingerprintSha256
              ? { existingFingerprintSha256: check.existingFingerprintSha256 }
              : {}),
            ...(check.existingKeyType ? { existingKeyType: check.existingKeyType } : {}),
            hopIndex: hop.hopIndex,
            hopCount,
          }
          const msg =
            reason === 'revoked'
              ? `Host key for ${hop.host}:${hop.port} is revoked in known_hosts`
              : reason === 'mismatch'
                ? `Host key verification failed: remote host identification for ${hop.host}:${hop.port} has changed`
                : `Host key verification failed: ${hop.host}:${hop.port} is not present in known_hosts`
          hostKeyError = new SshHostKeyVerificationError(msg, challenge)
          params.sessionEnd.recordError(hostKeyError)
          return false
        },
      })
    })
  } finally {
    if (privateKey) {
      privateKey.fill(0)
    }
  }

  return client
}

async function openForwardOutChannel(
  prevClient: SshClientLike,
  dstHost: string,
  dstPort: number,
  timeoutMs: number
): Promise<Ssh2ClientChannel> {
  return await new Promise<Ssh2ClientChannel>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error(`SSH port-forward to ${dstHost}:${dstPort} timed out after ${timeoutMs}ms`))
      }
    }, timeoutMs)

    prevClient.forwardOut('127.0.0.1', 0, dstHost, dstPort, (err, channel) => {
      if (settled) {
        if (channel) {
          try {
            channel.close()
          } catch {
            // Ignore
          }
        }
        return
      }
      settled = true
      clearTimeout(timer)
      if (err || !channel) {
        reject(err ?? new Error(`Failed to open SSH forwardOut channel to ${dstHost}:${dstPort}`))
        return
      }
      resolve(channel)
    })
  })
}

/**
 * Opens an in-process 1..N-hop SSH tunnel over `vendor/ssh2.js`:
 * - Hop 0 dialed via Happy Eyeballs `networkDialer.dialTcp`
 * - Hops 1..N-1 chained via `prev.forwardOut('127.0.0.1', 0, hop.host, hop.port)` -> `next.connect({ sock: channel })`
 * - Shared `SessionEnd` records the first error and tears down all hops in reverse order `[...hops].reverse()`
 * - Scrubs ALL hops' secrets from every error while preserving `SshHostKeyVerificationError` and `originalServername`
 */
export async function openMultiHopSshTunnel(
  profile: ConnectionProfile,
  targetHost: string,
  targetPort: number,
  options?: MultiHopSshOptions
): Promise<MultiHopSshTunnelHandle> {
  const timeoutMs = Math.max(200, options?.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS)
  const resolvedTargetHost = normalizeSshHopHost(targetHost, 'SSH tunnel target host')
  const resolvedTargetPort = requireHopPort(targetPort, 'SSH tunnel target port')
  const hops = buildNormalizedHopChain(profile, options)

  // Fail fast before opening any TCP socket if a hop is missing required credentials
  for (const hop of hops) {
    if (hop.authMethod === 'password' && !hop.password) {
      throw new Error(`SSH password is required for hop "${hop.host}:${hop.port}"`)
    }
    if (hop.authMethod === 'key' && !hop.privateKeyPath) {
      throw new Error(`SSH private key path is required for hop "${hop.host}:${hop.port}"`)
    }
  }

  const allSecrets = collectAllChainSecretStrings(options?.secrets, options?.hopSecrets)
  const sessionEnd = new SharedChainSessionEnd(allSecrets)

  const dialFn = options?.dialTcpFn ?? ((opts: DialTcpOptions) => networkDialer.dialTcp(opts))
  const readKeyFn =
    options?.readPrivateKey ??
    ((p: string) => readRegularFileBounded(p, MAX_PEM_FILE_BYTES, 'SSH private key'))
  const knownHostsFiles = await loadKnownHostsFiles(options?.knownHostsPaths)

  let createClientFn = options?.createSshClient
  if (!createClientFn) {
    const { Client } = await loadSsh2Vendor()
    createClientFn = () => new Client() as unknown as SshClientLike
  }

  let lastClient: SshClientLike
  try {
    const hop0 = hops[0]
    const hop0Sock = await dialFn({
      host: hop0.host,
      port: hop0.port,
      timeoutMs,
    })
    lastClient = await connectSingleHopClient({
      hop: hop0,
      hopCount: hops.length,
      sock: hop0Sock,
      timeoutMs,
      knownHostsFiles,
      trustedHostKeys: options?.trustedHostKeys,
      consumeTrustedHostKeyPin: options?.consumeTrustedHostKeyPin,
      connectionId: options?.connectionId ?? profile.id,
      panelId: options?.panelId,
      readPrivateKey: readKeyFn,
      createSshClient: createClientFn,
      sessionEnd,
    })

    for (let i = 1; i < hops.length; i++) {
      const nextHop = hops[i]
      const channel = await openForwardOutChannel(lastClient, nextHop.host, nextHop.port, timeoutMs)
      lastClient = await connectSingleHopClient({
        hop: nextHop,
        hopCount: hops.length,
        sock: channel,
        timeoutMs,
        knownHostsFiles,
        trustedHostKeys: options?.trustedHostKeys,
        consumeTrustedHostKeyPin: options?.consumeTrustedHostKeyPin,
        connectionId: options?.connectionId ?? profile.id,
        panelId: options?.panelId,
        readPrivateKey: readKeyFn,
        createSshClient: createClientFn,
        sessionEnd,
      })
    }

    const server = net.createServer((localSock) => {
      sessionEnd.trackLocalSocket(localSock)
      localSock.on('error', () => {
        localSock.destroy()
      })
      if (sessionEnd.ended) {
        localSock.destroy()
        return
      }
      const srcIp = localSock.remoteAddress || '127.0.0.1'
      const srcPort = localSock.remotePort || 0
      lastClient.forwardOut(srcIp, srcPort, resolvedTargetHost, resolvedTargetPort, (err, channel) => {
        if (err || !channel || localSock.destroyed) {
          if (channel && !channel.destroyed) {
            try {
              channel.destroy()
            } catch {
              // Ignore
            }
          }
          localSock.destroy(err ?? undefined)
          return
        }
        sessionEnd.trackChannel(channel)
        localSock.pipe(channel)
        channel.pipe(localSock)
        channel.on('error', () => localSock.destroy())
        channel.once('close', () => localSock.destroy())
        localSock.once('close', () => {
          try {
            if (typeof channel.close === 'function') channel.close()
            if (!channel.destroyed) channel.destroy()
          } catch {
            // Ignore
          }
        })
      })
    })
    sessionEnd.attachServer(server)

    lastClient.on('error', (err: unknown) => {
      sessionEnd.recordError(err)
      void sessionEnd.teardown()
    })
    lastClient.on('close', () => {
      void sessionEnd.teardown()
    })

    const localPort = await new Promise<number>((resolve, reject) => {
      server.once('error', (err) => reject(sessionEnd.recordError(err)))
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        const addr = server.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        if (port > 0) resolve(port)
        else reject(new Error('Failed to bind local SSH forwarding port on 127.0.0.1'))
      })
    })

    return {
      localHost: '127.0.0.1',
      localPort,
      originalServername: resolvedTargetHost,
      hopCount: hops.length,
      isAlive: () => !sessionEnd.ended && server.listening,
      close: () => sessionEnd.teardown(),
    }
  } catch (err: unknown) {
    const first = sessionEnd.recordError(err)
    await sessionEnd.teardown()
    throw first
  }
}
