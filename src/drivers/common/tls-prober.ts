// Credential-less TLS capability prober (<= 4s, runnable inside withTunnel) and
// 13-kind TlsFailure classifier with strictly safe remedies.

import * as net from 'node:net'
import * as tls from 'node:tls'
import type {
  DatabaseDriverType,
  SslMode,
  TlsFailure,
  TlsFailureKind,
} from '../../protocol'
import { dialTcp } from './network-dialer'

export const MAX_TLS_PROBE_TIMEOUT_MS = 4000

const PG_SSL_REQUEST_PACKET = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f])

// 20-byte TDS 7.4 PRELOGIN packet: 8-byte TDS header + VERSION option (5B) + TERMINATOR (1B) + 6-byte version data
const MSSQL_TDS74_PRELOGIN_PACKET = Buffer.from([
  0x12, 0x01, 0x00, 0x14, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x06, 0x00, 0x06,
  0xff,
  0x10, 0x00, 0x00, 0x00, 0x00, 0x00,
])

export interface TlsCertificateSnapshot {
  subject?: string
  issuer?: string
  san?: string[]
  validFrom?: string
  validTo?: string
  fingerprintSha256?: string
}

export interface TlsProbeOptions {
  driver: DatabaseDriverType
  host: string
  port: number
  originalServername?: string
  sslMode?: SslMode
  timeoutMs?: number
  signal?: AbortSignal
}

export interface TlsProbeResult {
  supportsTls: boolean | null
  requiresTls: boolean
  requiresStrict: boolean
  refusedStrict: boolean
  servesPlaintext: boolean
  timedOut: boolean
  errorCode?: number | string
  certificate?: TlsCertificateSnapshot
  alpnProtocol?: string
}

export interface TlsDiagnoseOptions {
  driver: DatabaseDriverType
  host: string
  port: number
  originalServername?: string
  sslMode?: SslMode
  error: unknown
  timeoutMs?: number
  skipProbe?: boolean
  signal?: AbortSignal
}

interface ProbeBudget {
  deadline: number
  signal?: AbortSignal
  remainingMs(): number
  isExpired(): boolean
}

function createProbeBudget(timeoutMs: number, signal?: AbortSignal): ProbeBudget {
  const deadline = Date.now() + timeoutMs
  return {
    deadline,
    signal,
    remainingMs: () => Math.max(0, deadline - Date.now()),
    isExpired: () => Boolean(signal?.aborted) || Date.now() >= deadline,
  }
}

function clampProbeTimeout(timeoutMs?: number): number {
  const raw = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : MAX_TLS_PROBE_TIMEOUT_MS
  return Math.max(100, Math.min(MAX_TLS_PROBE_TIMEOUT_MS, raw))
}

function normalizeServername(raw?: string): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const unwrapped =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
  const pctIdx = unwrapped.indexOf('%')
  const clean = pctIdx >= 0 ? unwrapped.slice(0, pctIdx) : unwrapped
  if (!clean || net.isIP(clean) !== 0) return undefined
  return clean
}

function formatPeerCertSnapshot(cert: tls.PeerCertificate | undefined): TlsCertificateSnapshot | undefined {
  if (!cert || Object.keys(cert).length === 0) return undefined
  const subject =
    typeof cert.subject?.CN === 'string' && cert.subject.CN
      ? cert.subject.CN
      : cert.subject
        ? Object.entries(cert.subject)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(', ')
        : undefined
  const issuer =
    typeof cert.issuer?.CN === 'string' && cert.issuer.CN
      ? cert.issuer.CN
      : cert.issuer
        ? Object.entries(cert.issuer)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(', ')
        : undefined
  const san =
    typeof cert.subjectaltname === 'string' && cert.subjectaltname.trim().length > 0
      ? cert.subjectaltname
          .split(',')
          .map((part) => part.trim().replace(/^(?:DNS|IP Address):\s*/i, ''))
          .filter(Boolean)
      : undefined
  const fingerprintSha256 =
    typeof cert.fingerprint256 === 'string' && cert.fingerprint256.trim().length > 0
      ? cert.fingerprint256.trim()
      : undefined

  return {
    ...(subject ? { subject } : {}),
    ...(issuer ? { issuer } : {}),
    ...(san && san.length > 0 ? { san } : {}),
    ...(cert.valid_from ? { validFrom: cert.valid_from } : {}),
    ...(cert.valid_to ? { validTo: cert.valid_to } : {}),
    ...(fingerprintSha256 ? { fingerprintSha256 } : {}),
  }
}

async function servesTls(
  host: string,
  port: number,
  budget: ProbeBudget,
  options?: { servername?: string; alpnProtocols?: string[] }
): Promise<{
  ok: boolean
  timedOut: boolean
  certificate?: TlsCertificateSnapshot
  alpnProtocol?: string
  code?: string
}> {
  if (budget.isExpired()) {
    return { ok: false, timedOut: !budget.signal?.aborted, code: budget.signal?.aborted ? 'ABORT_ERR' : 'ETIMEDOUT' }
  }
  let tcpSock: net.Socket | undefined
  try {
    tcpSock = await dialTcp({
      host,
      port,
      timeoutMs: Math.max(1, budget.remainingMs()),
      signal: budget.signal,
    })
    tcpSock.on('error', () => {
      // Prevent unhandled socket errors when TLS wrapper destroys the underlying TCP socket
    })
  } catch (err: unknown) {
    const code =
      err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : undefined
    return { ok: false, timedOut: code === 'ETIMEDOUT', code }
  }

  const rem = budget.remainingMs()
  if (rem <= 0 || budget.isExpired()) {
    tcpSock.destroy()
    return { ok: false, timedOut: !budget.signal?.aborted, code: budget.signal?.aborted ? 'ABORT_ERR' : 'ETIMEDOUT' }
  }

  return await new Promise((resolve) => {
    let settled = false
    let tlsSock: tls.TLSSocket | undefined
    const onAbort = (): void => {
      finish({ ok: false, timedOut: false, code: 'ABORT_ERR' })
    }
    const timer = setTimeout(() => {
      finish({ ok: false, timedOut: true, code: 'ETIMEDOUT' })
    }, rem)

    const finish = (res: {
      ok: boolean
      timedOut: boolean
      certificate?: TlsCertificateSnapshot
      alpnProtocol?: string
      code?: string
    }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      budget.signal?.removeEventListener('abort', onAbort)
      if (tlsSock && !tlsSock.destroyed) tlsSock.destroy()
      if (tcpSock && !tcpSock.destroyed) tcpSock.destroy()
      resolve(res)
    }

    if (budget.signal) {
      if (budget.signal.aborted) {
        onAbort()
        return
      }
      budget.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      tlsSock = tls.connect({
        socket: tcpSock,
        rejectUnauthorized: false,
        ...(options?.servername ? { servername: options.servername } : {}),
        ...(options?.alpnProtocols ? { ALPNProtocols: options.alpnProtocols } : {}),
      })
      tlsSock.once('secureConnect', () => {
        const peer = tlsSock?.getPeerCertificate(false)
        const alpn =
          typeof tlsSock?.alpnProtocol === 'string' && tlsSock.alpnProtocol
            ? tlsSock.alpnProtocol
            : undefined
        finish({
          ok: true,
          timedOut: false,
          certificate: formatPeerCertSnapshot(peer),
          ...(alpn ? { alpnProtocol: alpn } : {}),
        })
      })
      tlsSock.once('error', (err: Error & { code?: string }) => {
        finish({ ok: false, timedOut: false, code: err.code })
      })
      tlsSock.once('close', () => {
        finish({ ok: false, timedOut: false })
      })
    } catch (err: unknown) {
      const code =
        err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : undefined
      finish({ ok: false, timedOut: false, code })
    }
  })
}

async function probePostgresTls(
  host: string,
  port: number,
  budget: ProbeBudget,
  servername?: string
): Promise<TlsProbeResult> {
  if (budget.isExpired()) {
    return {
      supportsTls: null,
      requiresTls: false,
      requiresStrict: false,
      refusedStrict: false,
      servesPlaintext: false,
      timedOut: !budget.signal?.aborted,
    }
  }
  let sock: net.Socket | undefined
  try {
    sock = await dialTcp({
      host,
      port,
      timeoutMs: Math.max(1, budget.remainingMs()),
      signal: budget.signal,
    })
  } catch (err: unknown) {
    const code =
      err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : undefined
    return {
      supportsTls: null,
      requiresTls: false,
      requiresStrict: false,
      refusedStrict: false,
      servesPlaintext: false,
      timedOut: code === 'ETIMEDOUT',
      ...(code ? { errorCode: code } : {}),
    }
  }

  const replyRem = budget.remainingMs()
  if (replyRem <= 0 || budget.isExpired()) {
    sock.destroy()
    return {
      supportsTls: null,
      requiresTls: false,
      requiresStrict: false,
      refusedStrict: false,
      servesPlaintext: false,
      timedOut: !budget.signal?.aborted,
    }
  }

  const reply = await new Promise<{ byte?: string; timedOut: boolean }>((resolve) => {
    let settled = false
    const onAbort = (): void => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        sock?.destroy()
        resolve({ timedOut: false })
      }
    }
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        budget.signal?.removeEventListener('abort', onAbort)
        sock?.destroy()
        resolve({ timedOut: true })
      }
    }, replyRem)

    const done = (res: { byte?: string; timedOut: boolean }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      budget.signal?.removeEventListener('abort', onAbort)
      resolve(res)
    }

    if (budget.signal) {
      if (budget.signal.aborted) {
        onAbort()
        return
      }
      budget.signal.addEventListener('abort', onAbort, { once: true })
    }
    sock?.once('data', (chunk: Buffer) => {
      done({ byte: chunk.subarray(0, 1).toString('ascii'), timedOut: false })
    })
    sock?.once('error', () => done({ timedOut: false }))
    sock?.once('close', () => done({ timedOut: false }))
    sock?.write(PG_SSL_REQUEST_PACKET)
  })

  if (reply.byte === 'S') {
    const hsRem = budget.remainingMs()
    const cert =
      hsRem <= 0 || budget.isExpired()
        ? (() => {
            sock?.destroy()
            return Promise.resolve(undefined)
          })()
        : new Promise<TlsCertificateSnapshot | undefined>((resolve) => {
            if (!sock || sock.destroyed) {
              resolve(undefined)
              return
            }
            let settled = false
            const onAbort = (): void => {
              if (!settled) {
                settled = true
                clearTimeout(timer)
                sock?.destroy()
                resolve(undefined)
              }
            }
            const timer = setTimeout(() => {
              if (!settled) {
                settled = true
                budget.signal?.removeEventListener('abort', onAbort)
                sock?.destroy()
                resolve(undefined)
              }
            }, Math.min(2000, hsRem))
            if (budget.signal) {
              budget.signal.addEventListener('abort', onAbort, { once: true })
            }
            const tSock = tls.connect({
              socket: sock,
              rejectUnauthorized: false,
              ...(servername ? { servername } : {}),
            })
            tSock.once('secureConnect', () => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              budget.signal?.removeEventListener('abort', onAbort)
              const snap = formatPeerCertSnapshot(tSock.getPeerCertificate(false))
              tSock.destroy()
              resolve(snap)
            })
            tSock.once('error', () => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              budget.signal?.removeEventListener('abort', onAbort)
              tSock.destroy()
              resolve(undefined)
            })
          })
    const certSnap = await cert
    return {
      supportsTls: true,
      requiresTls: false,
      requiresStrict: false,
      refusedStrict: false,
      servesPlaintext: false,
      timedOut: false,
      ...(certSnap ? { certificate: certSnap } : {}),
    }
  }

  sock.destroy()
  if (reply.byte === 'N') {
    return {
      supportsTls: false,
      requiresTls: false,
      requiresStrict: false,
      refusedStrict: false,
      servesPlaintext: true,
      timedOut: false,
    }
  }

  return {
    supportsTls: null,
    requiresTls: false,
    requiresStrict: false,
    refusedStrict: false,
    servesPlaintext: false,
    timedOut: reply.timedOut,
  }
}

async function probeMysqlTls(
  host: string,
  port: number,
  budget: ProbeBudget
): Promise<TlsProbeResult> {
  if (budget.isExpired()) {
    return {
      supportsTls: null,
      requiresTls: false,
      requiresStrict: false,
      refusedStrict: false,
      servesPlaintext: false,
      timedOut: !budget.signal?.aborted,
    }
  }
  let sock: net.Socket | undefined
  try {
    sock = await dialTcp({
      host,
      port,
      timeoutMs: Math.max(1, budget.remainingMs()),
      signal: budget.signal,
    })
  } catch (err: unknown) {
    const code =
      err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : undefined
    return {
      supportsTls: null,
      requiresTls: false,
      requiresStrict: false,
      refusedStrict: false,
      servesPlaintext: false,
      timedOut: code === 'ETIMEDOUT',
      ...(code ? { errorCode: code } : {}),
    }
  }

  const rem = budget.remainingMs()
  if (rem <= 0 || budget.isExpired()) {
    sock.destroy()
    return {
      supportsTls: null,
      requiresTls: false,
      requiresStrict: false,
      refusedStrict: false,
      servesPlaintext: false,
      timedOut: !budget.signal?.aborted,
    }
  }

  return await new Promise<TlsProbeResult>((resolve) => {
    let settled = false
    const chunks: Buffer[] = []
    let totalBytes = 0
    const onAbort = (): void => {
      finish({
        supportsTls: null,
        requiresTls: false,
        requiresStrict: false,
        refusedStrict: false,
        servesPlaintext: false,
        timedOut: false,
      })
    }
    const timer = setTimeout(() => {
      finish({
        supportsTls: null,
        requiresTls: false,
        requiresStrict: false,
        refusedStrict: false,
        servesPlaintext: false,
        timedOut: true,
      })
    }, rem)

    const finish = (res: TlsProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      budget.signal?.removeEventListener('abort', onAbort)
      if (sock && !sock.destroyed) sock.destroy()
      resolve(res)
    }

    if (budget.signal) {
      if (budget.signal.aborted) {
        onAbort()
        return
      }
      budget.signal.addEventListener('abort', onAbort, { once: true })
    }

    const parsePacket = (buf: Buffer): void => {
      if (buf.length < 5) return
      const payloadLen = buf[0] | (buf[1] << 8) | (buf[2] << 16)
      if (buf.length < 4 + payloadLen) return
      const payload = buf.subarray(4, 4 + payloadLen)
      if (payload.length === 0) return

      if (payload[0] === 0xff && payload.length >= 3) {
        const errCode = payload.readUInt16LE(1)
        finish({
          supportsTls: errCode === 3159 ? true : null,
          requiresTls: errCode === 3159,
          requiresStrict: false,
          refusedStrict: false,
          servesPlaintext: false,
          timedOut: false,
          errorCode: errCode,
        })
        return
      }

      if (payload[0] === 10) {
        const nulIdx = payload.indexOf(0x00, 1)
        if (nulIdx < 0) return
        const capOffset = nulIdx + 1 + 4 + 8 + 1
        if (payload.length < capOffset + 2) return
        const capLower = payload.readUInt16LE(capOffset)
        const hasClientSsl = (capLower & 0x0800) !== 0
        finish({
          supportsTls: hasClientSsl,
          requiresTls: false,
          requiresStrict: false,
          refusedStrict: false,
          servesPlaintext: true,
          timedOut: false,
        })
      }
    }

    sock?.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      totalBytes += chunk.length
      if (totalBytes > 8192) {
        finish({
          supportsTls: null,
          requiresTls: false,
          requiresStrict: false,
          refusedStrict: false,
          servesPlaintext: false,
          timedOut: false,
        })
        return
      }
      parsePacket(Buffer.concat(chunks, totalBytes))
    })
    sock?.once('error', () => {
      finish({
        supportsTls: null,
        requiresTls: false,
        requiresStrict: false,
        refusedStrict: false,
        servesPlaintext: false,
        timedOut: false,
      })
    })
    sock?.once('close', () => {
      finish({
        supportsTls: null,
        requiresTls: false,
        requiresStrict: false,
        refusedStrict: false,
        servesPlaintext: false,
        timedOut: false,
      })
    })
  })
}

function parseTdsPreloginEncryption(buf: Buffer): number | null {
  if (buf.length < 9 || buf[0] !== 0x04) return null
  const body = buf.subarray(8)
  for (let offset = 0; offset < body.length; ) {
    const token = body[offset]
    if (token === 0xff) break
    if (offset + 5 > body.length) break
    const dataOffset = body.readUInt16BE(offset + 1)
    const dataLen = body.readUInt16BE(offset + 3)
    if (token === 0x01 && dataLen >= 1 && dataOffset < body.length) {
      return body[dataOffset]
    }
    offset += 5
  }
  return null
}

async function probeMssqlPrelogin(
  host: string,
  port: number,
  budget: ProbeBudget
): Promise<{ responded: boolean; encryptionByte: number | null; timedOut: boolean }> {
  if (budget.isExpired()) {
    return { responded: false, encryptionByte: null, timedOut: !budget.signal?.aborted }
  }
  let sock: net.Socket | undefined
  try {
    sock = await dialTcp({
      host,
      port,
      timeoutMs: Math.max(1, budget.remainingMs()),
      signal: budget.signal,
    })
  } catch (err: unknown) {
    const code =
      err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : undefined
    return { responded: false, encryptionByte: null, timedOut: code === 'ETIMEDOUT' }
  }

  const rem = budget.remainingMs()
  if (rem <= 0 || budget.isExpired()) {
    sock.destroy()
    return { responded: false, encryptionByte: null, timedOut: !budget.signal?.aborted }
  }

  return await new Promise((resolve) => {
    let settled = false
    const chunks: Buffer[] = []
    const onAbort = (): void => {
      done({ responded: false, encryptionByte: null, timedOut: false })
    }
    const timer = setTimeout(() => {
      done({ responded: false, encryptionByte: null, timedOut: true })
    }, rem)

    const done = (res: { responded: boolean; encryptionByte: number | null; timedOut: boolean }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      budget.signal?.removeEventListener('abort', onAbort)
      if (sock && !sock.destroyed) sock.destroy()
      resolve(res)
    }

    if (budget.signal) {
      if (budget.signal.aborted) {
        onAbort()
        return
      }
      budget.signal.addEventListener('abort', onAbort, { once: true })
    }

    sock?.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      const combined = Buffer.concat(chunks)
      if (combined.length >= 8) {
        const expectedLen = combined.readUInt16BE(2)
        if (combined.length >= expectedLen) {
          done({
            responded: combined[0] === 0x04,
            encryptionByte: parseTdsPreloginEncryption(combined),
            timedOut: false,
          })
        }
      }
    })
    sock?.once('error', () => done({ responded: false, encryptionByte: null, timedOut: false }))
    sock?.once('close', () => done({ responded: false, encryptionByte: null, timedOut: false }))
    sock?.write(MSSQL_TDS74_PRELOGIN_PACKET)
  })
}

async function probeMssqlTls(
  host: string,
  port: number,
  budget: ProbeBudget,
  sslMode?: SslMode,
  servername?: string
): Promise<TlsProbeResult> {
  const [prelogin, strictTls] = await Promise.all([
    probeMssqlPrelogin(host, port, budget),
    servesTls(host, port, budget, {
      ...(servername ? { servername } : {}),
      alpnProtocols: ['tds/8.0'],
    }),
  ])

  const strictSuccess = strictTls.ok && (strictTls.alpnProtocol === undefined || strictTls.alpnProtocol === 'tds/8.0')
  const requiresStrict = !prelogin.responded && strictSuccess
  const refusedStrict = sslMode === 'strict' && prelogin.responded && !strictTls.ok
  const enc = prelogin.encryptionByte
  const requiresTls = enc === 0x03 || enc === 0x01 || requiresStrict
  const supportsTls =
    enc === 0x02 ? false : enc !== null || strictSuccess ? true : null

  return {
    supportsTls,
    requiresTls,
    requiresStrict,
    refusedStrict,
    servesPlaintext: prelogin.responded,
    timedOut: prelogin.timedOut && strictTls.timedOut,
    ...(strictTls.certificate ? { certificate: strictTls.certificate } : {}),
    ...(strictTls.alpnProtocol ? { alpnProtocol: strictTls.alpnProtocol } : {}),
  }
}

async function probeRedisPlainPing(
  host: string,
  port: number,
  budget: ProbeBudget
): Promise<{ respondedPlain: boolean; timedOut: boolean }> {
  if (budget.isExpired()) {
    return { respondedPlain: false, timedOut: !budget.signal?.aborted }
  }
  let sock: net.Socket | undefined
  try {
    sock = await dialTcp({
      host,
      port,
      timeoutMs: Math.max(1, budget.remainingMs()),
      signal: budget.signal,
    })
  } catch (err: unknown) {
    const code =
      err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : undefined
    return { respondedPlain: false, timedOut: code === 'ETIMEDOUT' }
  }

  const rem = budget.remainingMs()
  if (rem <= 0 || budget.isExpired()) {
    sock.destroy()
    return { respondedPlain: false, timedOut: !budget.signal?.aborted }
  }

  return await new Promise((resolve) => {
    let settled = false
    const onAbort = (): void => {
      done({ respondedPlain: false, timedOut: false })
    }
    const timer = setTimeout(() => {
      done({ respondedPlain: false, timedOut: true })
    }, rem)

    const done = (res: { respondedPlain: boolean; timedOut: boolean }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      budget.signal?.removeEventListener('abort', onAbort)
      if (sock && !sock.destroyed) sock.destroy()
      resolve(res)
    }

    if (budget.signal) {
      if (budget.signal.aborted) {
        onAbort()
        return
      }
      budget.signal.addEventListener('abort', onAbort, { once: true })
    }

    sock?.once('data', (chunk: Buffer) => {
      const first = chunk.subarray(0, 1).toString('ascii')
      done({ respondedPlain: first === '+' || first === '-', timedOut: false })
    })
    sock?.once('error', () => done({ respondedPlain: false, timedOut: false }))
    sock?.once('close', () => done({ respondedPlain: false, timedOut: false }))
    sock?.write('PING\r\n')
  })
}

async function probeRedisTls(
  host: string,
  port: number,
  budget: ProbeBudget,
  servername?: string
): Promise<TlsProbeResult> {
  const [tlsRes, plainRes] = await Promise.all([
    servesTls(host, port, budget, servername ? { servername } : undefined),
    probeRedisPlainPing(host, port, budget),
  ])

  const requiresTls = tlsRes.ok && !plainRes.respondedPlain
  const supportsTls = tlsRes.ok ? true : plainRes.respondedPlain ? false : null
  return {
    supportsTls,
    requiresTls,
    requiresStrict: false,
    refusedStrict: false,
    servesPlaintext: plainRes.respondedPlain,
    timedOut: tlsRes.timedOut && plainRes.timedOut,
    ...(tlsRes.certificate ? { certificate: tlsRes.certificate } : {}),
  }
}

/**
 * Runs a credential-less TLS capability probe (bounded <= 4000ms, safe inside an SSH tunnel).
 */
export async function probeTlsCapabilities(options: TlsProbeOptions): Promise<TlsProbeResult> {
  const timeoutMs = clampProbeTimeout(options.timeoutMs)
  const budget = createProbeBudget(timeoutMs, options.signal)
  const servername = normalizeServername(options.originalServername ?? options.host)

  switch (options.driver) {
    case 'postgres':
    case 'cockroachdb':
      return await probePostgresTls(options.host, options.port, budget, servername)
    case 'mysql':
    case 'mariadb':
      return await probeMysqlTls(options.host, options.port, budget)
    case 'mssql':
      return await probeMssqlTls(options.host, options.port, budget, options.sslMode, servername)
    case 'redis':
      return await probeRedisTls(options.host, options.port, budget, servername)
    default: {
      const tlsRes = await servesTls(
        options.host,
        options.port,
        budget,
        servername ? { servername } : undefined
      )
      return {
        supportsTls: tlsRes.ok ? true : null,
        requiresTls: false,
        requiresStrict: false,
        refusedStrict: false,
        servesPlaintext: false,
        timedOut: tlsRes.timedOut,
        ...(tlsRes.certificate ? { certificate: tlsRes.certificate } : {}),
      }
    }
  }
}

interface ExtractedErrorNode {
  upperCode: string
  message: string
}

interface ExtractedErrorChain {
  nodes: ExtractedErrorNode[]
  codes: string[]
  upperCodes: Set<string>
  messages: string[]
  combinedMessage: string
  detail: string
}

const MAX_ERROR_CHAIN_DEPTH = 6

function extractErrorChain(err: unknown): ExtractedErrorChain {
  if (!err || typeof err !== 'object') {
    const text = String(err ?? '')
    return {
      nodes: text ? [{ upperCode: '', message: text }] : [],
      codes: [],
      upperCodes: new Set<string>(),
      messages: text ? [text] : [],
      combinedMessage: text,
      detail: text,
    }
  }

  const nodes: ExtractedErrorNode[] = []
  const codes: string[] = []
  const upperCodes = new Set<string>()
  const messages: string[] = []
  const visited = new Set<object>()
  const queue: Array<{ value: unknown; depth: number }> = [{ value: err, depth: 0 }]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    const { value, depth } = current
    if (!value || typeof value !== 'object' || depth > MAX_ERROR_CHAIN_DEPTH) continue
    if (visited.has(value)) continue
    visited.add(value)

    const rec = value as {
      code?: unknown
      message?: unknown
      cause?: unknown
      originalError?: unknown
      errors?: unknown
    }

    let nodeUpperCode = ''
    if (typeof rec.code === 'string' || typeof rec.code === 'number') {
      const code = String(rec.code).trim()
      if (code) {
        codes.push(code)
        nodeUpperCode = code.toUpperCase()
        upperCodes.add(nodeUpperCode)
      }
    }

    let nodeMessage = ''
    if (typeof rec.message === 'string' && rec.message.length > 0) {
      nodeMessage = rec.message
      messages.push(rec.message)
    }

    if (nodeUpperCode || nodeMessage) {
      nodes.push({ upperCode: nodeUpperCode, message: nodeMessage })
    }

    if (depth < MAX_ERROR_CHAIN_DEPTH) {
      if (rec.cause !== undefined) {
        queue.push({ value: rec.cause, depth: depth + 1 })
      }
      if (rec.originalError !== undefined) {
        queue.push({ value: rec.originalError, depth: depth + 1 })
      }
      if (Array.isArray(rec.errors)) {
        for (const inner of rec.errors) {
          queue.push({ value: inner, depth: depth + 1 })
        }
      }
    }
  }

  const combinedMessage = messages.join(' | ')
  const detail = messages.join(': ') || codes[0] || String(err)
  return { nodes, codes, upperCodes, messages, combinedMessage, detail }
}

function buildTlsFailureFromKind(
  kind: TlsFailureKind,
  detail: string,
  cert?: TlsCertificateSnapshot,
  suggestedServerName?: string
): TlsFailure {
  const certFields = cert
    ? {
        ...(cert.subject ? { certificateSubject: cert.subject } : {}),
        ...(cert.issuer ? { certificateIssuer: cert.issuer } : {}),
        ...(cert.san ? { certificateSan: cert.san } : {}),
        ...(cert.validFrom ? { validFrom: cert.validFrom } : {}),
        ...(cert.validTo ? { validTo: cert.validTo } : {}),
        ...(cert.fingerprintSha256 ? { fingerprintSha256: cert.fingerprintSha256 } : {}),
      }
    : {}

  switch (kind) {
    case 'ServerRequiresTls':
      return {
        kind,
        summary: 'The database server requires TLS encryption.',
        detail,
        canRetryWithFix: true,
        remedy: 'ChangeEncryption',
        suggestedSslMode: 'verify-full',
        ...certFields,
      }
    case 'ServerRefusedTls':
      return {
        kind,
        summary: 'The database server does not support or refused TLS connections.',
        detail,
        canRetryWithFix: true,
        remedy: 'ChangeEncryption',
        suggestedSslMode: 'disable',
        ...certFields,
      }
    case 'ServerRequiresStrict':
      return {
        kind,
        summary: 'The SQL Server requires TDS 8.0 strict TLS encryption.',
        detail,
        canRetryWithFix: true,
        remedy: 'ChangeEncryption',
        suggestedSslMode: 'strict',
        ...certFields,
      }
    case 'ServerRefusedStrict':
      return {
        kind,
        summary: 'The SQL Server refused TDS 8.0 strict TLS negotiation.',
        detail,
        canRetryWithFix: true,
        remedy: 'ChangeEncryption',
        suggestedSslMode: 'verify-full',
        ...certFields,
      }
    case 'UnknownIssuer':
      return {
        kind,
        summary: 'The server TLS certificate was issued by an untrusted or self-signed authority.',
        detail,
        canRetryWithFix: true,
        remedy: 'ChooseCaCert',
        ...certFields,
      }
    case 'NameMismatch':
      return {
        kind,
        summary: 'The server TLS certificate hostname does not match the connection host.',
        detail,
        canRetryWithFix: true,
        remedy: 'SetServerName',
        ...(suggestedServerName ? { suggestedServerName } : {}),
        ...certFields,
      }
    case 'Expired':
      return {
        kind,
        summary: 'The server TLS certificate has expired.',
        detail,
        canRetryWithFix: false,
        ...certFields,
      }
    case 'NotYetValid':
      return {
        kind,
        summary: 'The server TLS certificate is not yet valid.',
        detail,
        canRetryWithFix: false,
        ...certFields,
      }
    case 'Revoked':
      return {
        kind,
        summary: 'The server TLS certificate has been revoked.',
        detail,
        canRetryWithFix: false,
        ...certFields,
      }
    case 'HandshakeRejected':
      return {
        kind,
        summary: 'TLS handshake was rejected by the server (incompatible protocol or cipher suite).',
        detail,
        canRetryWithFix: false,
        ...certFields,
      }
    case 'CaFileInvalid':
      return {
        kind,
        summary: 'The configured CA certificate file is invalid or unreadable.',
        detail,
        canRetryWithFix: false,
        ...certFields,
      }
    case 'ClientIdentityInvalid':
      return {
        kind,
        summary: 'The client TLS certificate, private key, or passphrase is invalid.',
        detail,
        canRetryWithFix: false,
        ...certFields,
      }
    default:
      return {
        kind: 'Other',
        summary: 'TLS connection failed.',
        detail,
        canRetryWithFix: false,
        ...certFields,
      }
  }
}

/**
 * Classifies a TLS/connection error into one of the 13 canonical `TlsFailureKind` values
 * and assigns strictly safe remedies (never offering bypass for Expired/NotYetValid/Revoked/HandshakeRejected/CaFileInvalid/ClientIdentityInvalid).
 */
export function classifyTlsError(
  err: unknown,
  context?: {
    sslMode?: SslMode
    probe?: TlsProbeResult
  }
): TlsFailure {
  const { nodes, upperCodes, combinedMessage: message, detail } = extractErrorChain(err)
  const cert = context?.probe?.certificate
  const suggestedServerName = cert?.san?.find((entry) => !entry.startsWith('*')) ?? cert?.subject
  const isNodeWrongVersionNumber = (n: ExtractedErrorNode): boolean =>
    n.upperCode === 'ERR_SSL_WRONG_VERSION_NUMBER' || /\bwrong version number\b/i.test(n.message)
  const isNodeExplicitSslHandshake = (n: ExtractedErrorNode): boolean =>
    !isNodeWrongVersionNumber(n) &&
    (n.upperCode.startsWith('ERR_SSL_') ||
      n.upperCode === 'EPROTO' ||
      /handshake failure|no shared cipher|unsupported protocol/i.test(n.message))

  // 1. Classify explicit certificate, identity, and CA errors per error node across the bounded chain
  // so a non-TLS probe never downgrades hard security failures or certificate errors to ServerRefusedTls ('disable').
  if (
    nodes.some(
      (n) => n.upperCode === 'CERT_HAS_EXPIRED' || /\bcertificate has expired\b/i.test(n.message)
    )
  ) {
    return buildTlsFailureFromKind('Expired', detail, cert)
  }

  if (
    nodes.some(
      (n) =>
        n.upperCode === 'CERT_NOT_YET_VALID' || /\bcertificate is not yet valid\b/i.test(n.message)
    )
  ) {
    return buildTlsFailureFromKind('NotYetValid', detail, cert)
  }

  if (
    nodes.some(
      (n) =>
        n.upperCode === 'CERT_REVOKED' || /\bcertificate (?:has been )?revoked\b/i.test(n.message)
    )
  ) {
    return buildTlsFailureFromKind('Revoked', detail, cert)
  }

  if (
    nodes.some(
      (n) =>
        n.upperCode === 'TLS.CA_REQUIRES_VERIFY' ||
        /Cannot read SSL CA certificate/i.test(n.message) ||
        /\b(?:invalid|unreadable)\s+CA\b/i.test(n.message)
    )
  ) {
    return buildTlsFailureFromKind('CaFileInvalid', detail, cert)
  }

  if (
    nodes.some(
      (n) =>
        n.upperCode === 'ERR_OSSL_EVP_BAD_DECRYPT' ||
        n.upperCode === 'ERR_OSSL_X509_KEY_VALUES_MISMATCH' ||
        n.upperCode === 'ERR_CRYPTO_INVALID_KEY' ||
        /Cannot read SSL client (?:certificate|private key)/i.test(n.message) ||
        /\b(?:bad decrypt|wrong passphrase|client certificate)\b/i.test(n.message)
    )
  ) {
    return buildTlsFailureFromKind('ClientIdentityInvalid', detail, cert)
  }

  if (
    nodes.some(
      (n) =>
        n.upperCode === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
        n.upperCode === 'HOSTNAME_MISMATCH' ||
        /Hostname\/IP does not match certificate/i.test(n.message)
    )
  ) {
    return buildTlsFailureFromKind('NameMismatch', detail, cert, suggestedServerName)
  }

  if (
    nodes.some(
      (n) =>
        n.upperCode === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
        n.upperCode === 'SELF_SIGNED_CERT_IN_CHAIN' ||
        n.upperCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
        n.upperCode === 'UNABLE_TO_GET_ISSUER_CERT' ||
        n.upperCode === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' ||
        n.upperCode === 'CERT_UNTRUSTED' ||
        n.upperCode === 'CERT_SIGNATURE_FAILURE' ||
        /self[\s-]signed certificate|unable to verify the first certificate|unable to get local issuer certificate/i.test(
          n.message
        )
    )
  ) {
    return buildTlsFailureFromKind('UnknownIssuer', detail, cert)
  }

  // Distinguish plaintext non-TLS responses (ERR_SSL_WRONG_VERSION_NUMBER) from explicit TLS alerts/ciphers per node
  if (nodes.some(isNodeExplicitSslHandshake)) {
    return buildTlsFailureFromKind('HandshakeRejected', detail, cert)
  }
  const isWrongVersionNumber = nodes.some(isNodeWrongVersionNumber)

  // 2. Probe-assisted exact protocol mismatches for ambiguous / plaintext-mismatch errors
  if (context?.probe) {
    if (context.probe.refusedStrict) {
      return buildTlsFailureFromKind('ServerRefusedStrict', detail, cert, suggestedServerName)
    }
    if (context.probe.requiresStrict && context.sslMode !== 'strict') {
      return buildTlsFailureFromKind('ServerRequiresStrict', detail, cert, suggestedServerName)
    }
    if (context.probe.requiresTls && context.sslMode === 'disable') {
      return buildTlsFailureFromKind('ServerRequiresTls', detail, cert, suggestedServerName)
    }
    if (context.probe.supportsTls === false && context.sslMode !== 'disable') {
      return buildTlsFailureFromKind('ServerRefusedTls', detail, cert, suggestedServerName)
    }
  }

  if (/refused strict|strict.*tds\/?8\.0.*refused/i.test(message)) {
    return buildTlsFailureFromKind('ServerRefusedStrict', detail, cert)
  }

  if (/requires? strict|tds\s*8\.0.*strict/i.test(message)) {
    return buildTlsFailureFromKind('ServerRequiresStrict', detail, cert)
  }

  if (
    upperCodes.has('3159') ||
    (upperCodes.has('28000') && /no pg_hba\.conf.*no encryption|ssl off|ssl is required/i.test(message)) ||
    /require_secure_transport|insecure transport are prohibited|server requires (?:ssl|tls)|ssl off/i.test(
      message
    )
  ) {
    return buildTlsFailureFromKind('ServerRequiresTls', detail, cert)
  }

  if (
    /does not support SSL|refused SSL|server does not support TLS|server refused TLS/i.test(message)
  ) {
    return buildTlsFailureFromKind('ServerRefusedTls', detail, cert)
  }

  if (isWrongVersionNumber) {
    return buildTlsFailureFromKind('HandshakeRejected', detail, cert)
  }

  return buildTlsFailureFromKind('Other', detail, cert)
}

/**
 * Diagnoses a TLS/connection failure by combining static error classification with a bounded
 * (<= 4s, credential-less) wire probe against `host:port` (safe to run inside an SSH tunnel).
 */
export async function diagnoseTlsFailure(options: TlsDiagnoseOptions): Promise<TlsFailure> {
  const initial = classifyTlsError(options.error, { sslMode: options.sslMode })
  if (options.skipProbe) {
    return initial
  }
  const needsProbe =
    initial.kind === 'Other' ||
    initial.kind === 'HandshakeRejected' ||
    initial.kind === 'UnknownIssuer' ||
    initial.kind === 'NameMismatch' ||
    initial.kind === 'ServerRequiresTls' ||
    initial.kind === 'ServerRefusedTls'
  if (!needsProbe) {
    return initial
  }

  const probe = await probeTlsCapabilities({
    driver: options.driver,
    host: options.host,
    port: options.port,
    originalServername: options.originalServername,
    sslMode: options.sslMode,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  })
  return classifyTlsError(options.error, { sslMode: options.sslMode, probe })
}
