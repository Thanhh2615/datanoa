// Happy Eyeballs (RFC 8305) TCP network dialer with 250ms stagger and clean failure aggregation.

import * as dns from 'node:dns'
import * as net from 'node:net'

export const HAPPY_EYEBALLS_DELAY_MS = 250
export const DEFAULT_DIAL_TIMEOUT_MS = 10_000

export type DialFailureKind =
  | 'Refused'
  | 'ConnectTimeout'
  | 'Unreachable'
  | 'DnsFailed'
  | 'Cancelled'
  | 'InvalidTarget'
  | 'Other'

export type AggregatedDialFailureKind = 'Refused' | 'ConnectTimeout' | 'Unreachable'

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

export interface DialAttemptFailure {
  address: string
  family: 4 | 6
  kind: 'Refused' | 'ConnectTimeout' | 'Unreachable' | 'Other'
  code?: string
  message: string
}

export type DialLookupFn = (host: string) => Promise<ResolvedAddress[]>
export type DialCreateSocketFn = (opts: { host: string; port: number; family: 4 | 6 }) => net.Socket

export interface DialTcpOptions {
  host: string
  port: number
  timeoutMs?: number
  attemptDelayMs?: number
  connectTimeoutMs?: number
  signal?: AbortSignal
  lookup?: DialLookupFn
  createSocket?: DialCreateSocketFn
}

/**
 * Error raised when Happy Eyeballs TCP dialing fails across all resolved addresses.
 */
export class NetworkDialError extends Error {
  readonly kind: DialFailureKind
  readonly host: string
  readonly port: number
  readonly attempts: readonly DialAttemptFailure[]
  readonly code?: string

  constructor(
    message: string,
    kind: DialFailureKind,
    host: string,
    port: number,
    attempts: readonly DialAttemptFailure[] = [],
    code?: string
  ) {
    super(message)
    this.name = 'NetworkDialError'
    this.kind = kind
    this.host = host
    this.port = port
    this.attempts = attempts
    if (code) this.code = code
  }
}

function stripIpv6BracketsAndZone(raw: string): { host: string; ipHost: string } {
  const trimmed = raw.trim()
  const unwrapped =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
  const pctIdx = unwrapped.indexOf('%')
  const bare = pctIdx >= 0 ? unwrapped.slice(0, pctIdx) : unwrapped
  return { host: unwrapped, ipHost: bare }
}

/**
 * Interleaves IPv6 and IPv4 addresses per RFC 8305 Section 4, starting with IPv6
 * while preserving relative order within each address family and deduplicating entries.
 */
export function interleaveAddresses(addresses: readonly ResolvedAddress[]): ResolvedAddress[] {
  const seen = new Set<string>()
  const v6: ResolvedAddress[] = []
  const v4: ResolvedAddress[] = []

  for (const entry of addresses) {
    const addr = entry.address.trim()
    if (!addr) continue
    const family: 4 | 6 = entry.family === 6 ? 6 : 4
    const key = `${family}:${addr.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    if (family === 6) v6.push({ address: addr, family: 6 })
    else v4.push({ address: addr, family: 4 })
  }

  const out: ResolvedAddress[] = []
  const maxLen = Math.max(v6.length, v4.length)
  for (let i = 0; i < maxLen; i++) {
    if (i < v6.length) out.push(v6[i])
    if (i < v4.length) out.push(v4[i])
  }
  return out
}

/**
 * Aggregates per-address attempt failures into a single deterministic failure kind:
 * all Refused -> Refused, all ConnectTimeout -> ConnectTimeout, mixed -> Unreachable.
 */
export function aggregateFailures(
  failures: readonly DialAttemptFailure[]
): AggregatedDialFailureKind {
  if (failures.length === 0) return 'Unreachable'
  let allRefused = true
  let allTimeout = true
  for (const f of failures) {
    if (f.kind !== 'Refused') allRefused = false
    if (f.kind !== 'ConnectTimeout') allTimeout = false
  }
  if (allRefused) return 'Refused'
  if (allTimeout) return 'ConnectTimeout'
  return 'Unreachable'
}

function classifySocketErrorKind(
  err: unknown
): { kind: 'Refused' | 'ConnectTimeout' | 'Unreachable' | 'Other'; code?: string; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  const rawCode =
    err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code.trim().toUpperCase()
      : undefined

  if (rawCode === 'ECONNREFUSED') {
    return { kind: 'Refused', code: rawCode, message }
  }
  if (rawCode === 'ETIMEDOUT' || rawCode === 'CONNECT_TIMEOUT') {
    return { kind: 'ConnectTimeout', code: rawCode, message }
  }
  if (
    rawCode === 'EHOSTUNREACH' ||
    rawCode === 'ENETUNREACH' ||
    rawCode === 'EADDRNOTAVAIL' ||
    rawCode === 'EHOSTDOWN' ||
    rawCode === 'ENETDOWN' ||
    rawCode === 'ECONNRESET' ||
    rawCode === 'EPIPE' ||
    rawCode === 'EACCES'
  ) {
    return { kind: 'Unreachable', code: rawCode, message }
  }
  return { kind: 'Other', ...(rawCode ? { code: rawCode } : {}), message }
}

async function defaultLookup(host: string): Promise<ResolvedAddress[]> {
  const { host: unwrapped, ipHost } = stripIpv6BracketsAndZone(host)
  const ipVersion = net.isIP(ipHost)
  if (ipVersion === 4) {
    return [{ address: ipHost, family: 4 }]
  }
  if (ipVersion === 6) {
    return [{ address: unwrapped, family: 6 }]
  }
  const records = await dns.promises.lookup(unwrapped, { all: true, verbatim: true })
  return records
    .filter((r) => r.family === 4 || r.family === 6)
    .map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }))
}

function defaultCreateSocket(opts: { host: string; port: number; family: 4 | 6 }): net.Socket {
  return net.connect({ host: opts.host, port: opts.port, family: opts.family })
}

/**
 * Dials a TCP connection using RFC 8305 Happy Eyeballs:
 * - Interleaves IPv6/IPv4 starting with IPv6
 * - Staggers new attempts by 250ms (starting the next address immediately on error)
 * - Destroys all losing sockets cleanly when the first connection succeeds
 */
export async function dialTcp(options: DialTcpOptions): Promise<net.Socket> {
  const rawHost = typeof options.host === 'string' ? options.host.trim() : ''
  const port = options.port
  if (!rawHost) {
    throw new NetworkDialError('Host is required for TCP dial', 'InvalidTarget', '', port)
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new NetworkDialError(
      `Invalid TCP port ${String(port)} for host "${rawHost}"`,
      'InvalidTarget',
      rawHost,
      port
    )
  }
  if (options.signal?.aborted) {
    throw new NetworkDialError(
      `TCP dial to ${rawHost}:${port} was cancelled`,
      'Cancelled',
      rawHost,
      port
    )
  }

  const lookupFn = options.lookup ?? defaultLookup
  const createSocketFn = options.createSocket ?? defaultCreateSocket
  const timeoutMs = Math.max(50, options.timeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS)
  const deadline = Date.now() + timeoutMs
  const attemptDelayMs = Math.max(1, options.attemptDelayMs ?? HAPPY_EYEBALLS_DELAY_MS)
  const requestedConnectTimeoutMs = Math.max(50, Math.min(timeoutMs, options.connectTimeoutMs ?? timeoutMs))

  let resolved: ResolvedAddress[]
  try {
    const rawResolved = await new Promise<ResolvedAddress[]>((resolveLookup, rejectLookup) => {
      let settled = false
      const lookupRemaining = Math.max(1, deadline - Date.now())
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = (): void => {
        if (settled) return
        settled = true
        cleanup()
        rejectLookup(
          new NetworkDialError(`TCP dial to ${rawHost}:${port} was cancelled`, 'Cancelled', rawHost, port)
        )
      }
      const cleanup = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort)
        }
      }
      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        rejectLookup(
          new NetworkDialError(
            `TCP dial to ${rawHost}:${port} timed out after ${timeoutMs}ms during DNS lookup`,
            'ConnectTimeout',
            rawHost,
            port,
            [],
            'ETIMEDOUT'
          )
        )
      }, lookupRemaining)

      Promise.resolve()
        .then(() => lookupFn(rawHost))
        .then(
          (addrs) => {
            if (settled) return
            settled = true
            cleanup()
            resolveLookup(addrs)
          },
          (err: unknown) => {
            if (settled) return
            settled = true
            cleanup()
            rejectLookup(err)
          }
        )
    })
    resolved = interleaveAddresses(rawResolved)
  } catch (err: unknown) {
    if (err instanceof NetworkDialError) {
      throw err
    }
    const msg = err instanceof Error ? err.message : String(err)
    const code =
      err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : undefined
    throw new NetworkDialError(
      `DNS lookup failed for ${rawHost}:${port}: ${msg}`,
      'DnsFailed',
      rawHost,
      port,
      [],
      code
    )
  }

  if (resolved.length === 0) {
    throw new NetworkDialError(
      `No IPv4 or IPv6 addresses resolved for ${rawHost}:${port}`,
      'DnsFailed',
      rawHost,
      port
    )
  }

  if (options.signal?.aborted) {
    throw new NetworkDialError(
      `TCP dial to ${rawHost}:${port} was cancelled`,
      'Cancelled',
      rawHost,
      port
    )
  }

  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    throw new NetworkDialError(
      `TCP dial to ${rawHost}:${port} timed out after ${timeoutMs}ms`,
      'ConnectTimeout',
      rawHost,
      port,
      [],
      'ETIMEDOUT'
    )
  }
  const effectiveTimeoutMs = Math.max(1, remainingMs)
  const connectTimeoutMs = Math.max(1, Math.min(effectiveTimeoutMs, requestedConnectTimeoutMs))

  return await new Promise<net.Socket>((resolve, reject) => {
    let settled = false
    let nextIndex = 0
    let staggerTimer: ReturnType<typeof setTimeout> | undefined
    let overallTimer: ReturnType<typeof setTimeout> | undefined
    const activeSockets = new Map<net.Socket, () => void>()
    const attemptTimers = new Map<net.Socket, ReturnType<typeof setTimeout>>()
    const failures: DialAttemptFailure[] = []

    const clearStagger = (): void => {
      if (staggerTimer !== undefined) {
        clearTimeout(staggerTimer)
        staggerTimer = undefined
      }
    }

    const cleanupAll = (winner?: net.Socket): void => {
      clearStagger()
      if (overallTimer !== undefined) {
        clearTimeout(overallTimer)
        overallTimer = undefined
      }
      if (options.signal) {
        options.signal.removeEventListener('abort', onAbort)
      }
      for (const timer of attemptTimers.values()) {
        clearTimeout(timer)
      }
      attemptTimers.clear()

      for (const [sock, detach] of activeSockets.entries()) {
        detach()
        if (sock !== winner && !sock.destroyed) {
          try {
            sock.destroy()
          } catch {
            // Ignore destroy errors on losing sockets
          }
        }
      }
      activeSockets.clear()
    }

    const failDial = (kind: DialFailureKind, message: string, code?: string): void => {
      if (settled) return
      settled = true
      cleanupAll()
      reject(new NetworkDialError(message, kind, rawHost, port, failures, code))
    }

    const maybeFinishIfAllFailed = (): void => {
      if (settled) return
      if (nextIndex >= resolved.length && activeSockets.size === 0) {
        const aggKind = aggregateFailures(failures)
        const summary = failures.map((f) => `${f.address}: ${f.code ?? f.message}`).join('; ')
        failDial(
          aggKind,
          `TCP dial to ${rawHost}:${port} failed (${aggKind}): ${summary}`,
          aggKind === 'Refused' ? 'ECONNREFUSED' : aggKind === 'ConnectTimeout' ? 'ETIMEDOUT' : undefined
        )
      }
    }

    const scheduleNextStagger = (): void => {
      clearStagger()
      if (settled || nextIndex >= resolved.length) return
      staggerTimer = setTimeout(() => {
        staggerTimer = undefined
        startNextAttempt()
      }, attemptDelayMs)
    }

    const startNextAttempt = (): void => {
      if (settled || nextIndex >= resolved.length) return
      const target = resolved[nextIndex]
      nextIndex += 1

      let socket: net.Socket
      try {
        socket = createSocketFn({ host: target.address, port, family: target.family })
      } catch (err: unknown) {
        const classified = classifySocketErrorKind(err)
        failures.push({
          address: target.address,
          family: target.family,
          ...classified,
        })
        if (nextIndex < resolved.length) {
          startNextAttempt()
        } else {
          maybeFinishIfAllFailed()
        }
        return
      }

      let attemptFinished = false
      const cleanupAttemptTimer = (): void => {
        const t = attemptTimers.get(socket)
        if (t !== undefined) {
          clearTimeout(t)
          attemptTimers.delete(socket)
        }
      }

      const onConnect = (): void => {
        if (attemptFinished || settled) {
          cleanupAttemptTimer()
          if (!socket.destroyed) socket.destroy()
          return
        }
        attemptFinished = true
        settled = true
        cleanupAttemptTimer()
        if (typeof socket.setTimeout === 'function') {
          socket.setTimeout(0)
        }
        cleanupAll(socket)
        resolve(socket)
      }

      const recordAttemptFailure = (
        kind: 'Refused' | 'ConnectTimeout' | 'Unreachable' | 'Other',
        message: string,
        code?: string
      ): void => {
        if (attemptFinished || settled) return
        attemptFinished = true
        cleanupAttemptTimer()
        const detach = activeSockets.get(socket)
        if (detach) {
          detach()
          activeSockets.delete(socket)
        }
        if (!socket.destroyed) {
          try {
            socket.destroy()
          } catch {
            // Ignore
          }
        }
        failures.push({
          address: target.address,
          family: target.family,
          kind,
          ...(code ? { code } : {}),
          message,
        })
        // RFC 8305: on error, start the next address immediately without waiting 250ms
        if (nextIndex < resolved.length) {
          clearStagger()
          startNextAttempt()
        } else {
          maybeFinishIfAllFailed()
        }
      }

      const onError = (err: Error): void => {
        const classified = classifySocketErrorKind(err)
        recordAttemptFailure(classified.kind, classified.message, classified.code)
      }

      const onClose = (): void => {
        if (!attemptFinished && !settled) {
          recordAttemptFailure('Unreachable', `Connection to ${target.address}:${port} closed`)
        }
      }

      const detach = (): void => {
        socket.removeListener('connect', onConnect)
        socket.removeListener('error', onError)
        socket.removeListener('close', onClose)
      }

      activeSockets.set(socket, detach)
      socket.once('connect', onConnect)
      socket.once('error', onError)
      socket.once('close', onClose)

      const timer = setTimeout(() => {
        recordAttemptFailure(
          'ConnectTimeout',
          `Connection to ${target.address}:${port} timed out after ${connectTimeoutMs}ms`,
          'ETIMEDOUT'
        )
      }, connectTimeoutMs)
      attemptTimers.set(socket, timer)

      if (nextIndex < resolved.length) {
        scheduleNextStagger()
      }
    }

    const onAbort = (): void => {
      failDial('Cancelled', `TCP dial to ${rawHost}:${port} was cancelled`)
    }

    if (options.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    overallTimer = setTimeout(() => {
      for (const [sock, detach] of activeSockets.entries()) {
        detach()
        if (!sock.destroyed) sock.destroy()
      }
      activeSockets.clear()
      if (failures.length === 0) {
        failures.push({
          address: resolved[0].address,
          family: resolved[0].family,
          kind: 'ConnectTimeout',
          code: 'ETIMEDOUT',
          message: `Timed out after ${timeoutMs}ms`,
        })
      }
      const aggKind = failures.every((f) => f.kind === 'Refused')
        ? 'Refused'
        : failures.every((f) => f.kind === 'ConnectTimeout')
          ? 'ConnectTimeout'
          : 'Unreachable'
      failDial(
        aggKind,
        `TCP dial to ${rawHost}:${port} timed out after ${timeoutMs}ms`,
        aggKind === 'ConnectTimeout' ? 'ETIMEDOUT' : undefined
      )
    }, effectiveTimeoutMs)

    startNextAttempt()
  })
}

export const networkDialer = {
  dialTcp,
  interleaveAddresses,
  aggregateFailures,
}
