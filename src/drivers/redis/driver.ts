import * as net from 'node:net'
import * as tls from 'node:tls'
import type {
  ApplyChangesParams,
  ApplyChangesResult,
  ColumnInfo,
  ConnectionProfile,
  FetchPageParams,
  IDatabaseDriver,
  IDatabaseSession,
  PreviewChangesResult,
  QueryResult,
  SchemaObject,
  SchemaObjectKind,
  TableBrowseResult,
  TableDetails,
  TransactionState,
  UpdateCellParams,
  UpdateCellResult,
} from '../common/driver'
import {
  DatabaseDriverError,
  attachFailedStatementMeta,
  copyFailedStatementMeta,
  createUnsupportedTransactionError,
  createUnsupportedTransactionState,
  runDriverConnectionTest,
} from '../common/driver'
import type { DriverTlsOptions } from '../common/tls-and-tunnel'
import { buildDefaultTlsOptions, resolveEffectiveTlsOptions } from '../common/tls-and-tunnel'
import { networkDialer } from '../common/network-dialer'
import { scrubDriverErrorText } from '../common/sql-credentials'
import { assembleTableBrowseResult } from '../common/update-builder'
import { tokenizeRedisCommandLine } from '../../shared-sql-safety.js'

const REDIS_UNSUPPORTED_TX_REASON =
  'Redis does not support interactive multi-statement transactions'

function scrubRedisError(err: unknown): unknown {
  if (err instanceof Error && err.message) {
    const clean = scrubDriverErrorText(err.message)
    if (clean !== err.message) {
      try {
        err.message = clean
      } catch {
        const code =
          err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
            ? err.code
            : 'REDIS_ERROR'
        return copyFailedStatementMeta(err, new DatabaseDriverError(clean, code, 'redis', err))
      }
    }
  }
  return err
}

function formatRedisErrorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return scrubDriverErrorText(raw).trim() || fallback
}

const MAX_SCAN_KEYS = 2000
const MAX_SCAN_ITERATIONS = 500
const MAX_SCAN_DURATION_MS = 5000
const HYDRATE_CHUNK_SIZE = 250

const REDIS_READONLY_COMMANDS: ReadonlySet<string> = new Set([
  'GET', 'MGET', 'STRLEN', 'GETRANGE', 'SUBSTR', 'EXISTS', 'TYPE', 'TTL', 'PTTL',
  'EXPIRETIME', 'PEXPIRETIME', 'KEYS', 'SCAN',
  'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'HSCAN', 'HRANDFIELD',
  'LRANGE', 'LLEN', 'LINDEX', 'LPOS',
  'SMEMBERS', 'SCARD', 'SISMEMBER', 'SMISMEMBER', 'SSCAN', 'SRANDMEMBER', 'SDIFF', 'SINTER', 'SUNION',
  'ZRANGE', 'ZREVRANGE', 'ZRANGEBYSCORE', 'ZREVRANGEBYSCORE', 'ZRANGEBYLEX', 'ZCARD',
  'ZCOUNT', 'ZLEXCOUNT', 'ZSCORE', 'ZMSCORE', 'ZRANK', 'ZREVRANK', 'ZSCAN',
  'XLEN', 'XRANGE', 'XREVRANGE', 'DBSIZE', 'INFO', 'PING', 'ECHO', 'TIME', 'SELECT',
  'RANDOMKEY', 'DUMP', 'BITCOUNT', 'BITPOS', 'GETBIT', 'PFCOUNT',
  'GEOPOS', 'GEODIST', 'GEOHASH', 'GEOSEARCH',
  'JSON.GET', 'JSON.MGET', 'JSON.TYPE', 'JSON.STRLEN', 'JSON.ARRLEN', 'JSON.OBJKEYS', 'JSON.OBJLEN',
  'FT.SEARCH', 'FT.AGGREGATE', 'FT.INFO', 'FT._LIST',
])

const REDIS_READONLY_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['CONFIG', new Set(['GET'])],
  ['CLIENT', new Set(['LIST', 'INFO', 'ID', 'GETNAME'])],
  ['ACL', new Set(['WHOAMI', 'LIST', 'USERS', 'GETUSER', 'CAT', 'DRYRUN'])],
  ['SLOWLOG', new Set(['GET', 'LEN'])],
  ['CLUSTER', new Set(['INFO', 'NODES', 'SLOTS', 'SHARDS', 'COUNTKEYSINSLOT', 'GETKEYSINSLOT'])],
  ['XINFO', new Set(['STREAM', 'GROUPS', 'CONSUMERS', 'HELP'])],
  ['MEMORY', new Set(['USAGE', 'STATS', 'MALLOC-STATS', 'DOCTOR'])],
  ['OBJECT', new Set(['ENCODING', 'FREQ', 'IDLETIME', 'REFCOUNT'])],
  ['SCRIPT', new Set(['EXISTS'])],
])

function isReadOnlyRedisCommand(args: readonly string[]): boolean {
  const cmd = (args[0] || '').toUpperCase()
  if (!cmd) return false
  if (REDIS_READONLY_COMMANDS.has(cmd)) return true
  if (cmd === 'COMMAND') {
    const sub = (args[1] || '').toUpperCase()
    return sub === '' || sub === 'COUNT' || sub === 'INFO' || sub === 'LIST' || sub === 'GETKEYS'
  }
  const allowedSubs = REDIS_READONLY_SUBCOMMANDS.get(cmd)
  if (!allowedSubs) return false
  const sub = (args[1] || '').toUpperCase()
  return allowedSubs.has(sub)
}

const REDIS_COLUMNS: ColumnInfo[] = [
  {
    name: 'key',
    type: 'TEXT',
    nativeType: 'key',
    nullable: false,
    defaultValue: null,
    isPrimaryKey: true,
    isAutoIncrement: false,
  },
  {
    name: 'type',
    type: 'TEXT',
    nativeType: 'type',
    nullable: false,
    defaultValue: null,
    isPrimaryKey: false,
    isAutoIncrement: false,
  },
  {
    name: 'ttl',
    type: 'INTEGER',
    nativeType: 'ttl',
    nullable: false,
    defaultValue: '-1',
    isPrimaryKey: false,
    isAutoIncrement: false,
  },
  {
    name: 'value',
    type: 'TEXT',
    nativeType: 'value',
    nullable: true,
    defaultValue: null,
    isPrimaryKey: false,
    isAutoIncrement: false,
  },
]

class RespProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RespProtocolError'
  }
}

type DecodedFrame = { value: unknown; nextOffset: number; isPush?: boolean } | null

function findCrlf(buf: Buffer, start: number): number {
  return buf.indexOf('\r\n', start)
}

function parseStrictRespInt(raw: string, offset: number, label: string): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new RespProtocolError(`Malformed RESP ${label} at offset ${offset}`)
  }
  const num = Number(raw)
  if (!Number.isSafeInteger(num)) {
    throw new RespProtocolError(`Out-of-range RESP ${label} at offset ${offset}`)
  }
  return num
}

const MAX_RESP_DEPTH = 64
const MAX_RESP_BUFFER_BYTES = 32 * 1024 * 1024
const MAX_FULL_HASH_FIELDS = 500

function decodeRespFrame(buf: Buffer, offset: number, depth = 0): DecodedFrame {
  if (depth > MAX_RESP_DEPTH) {
    throw new RespProtocolError(`Maximum RESP nesting depth (${MAX_RESP_DEPTH}) exceeded`)
  }
  if (offset >= buf.length) return null
  const prefix = String.fromCharCode(buf[offset])

  if (prefix === '+' || prefix === '-' || prefix === ':' || prefix === '_' || prefix === '#' || prefix === ',' || prefix === '(') {
    const lineEnd = findCrlf(buf, offset + 1)
    if (lineEnd < 0) return null
    const text = buf.subarray(offset + 1, lineEnd).toString('utf8')
    const nextOffset = lineEnd + 2

    switch (prefix) {
      case '+':
        return { value: text, nextOffset }
      case '-':
        return { value: new RespProtocolError(text), nextOffset }
      case ':': {
        const num = Number(text)
        return { value: Number.isSafeInteger(num) ? num : text, nextOffset }
      }
      case '_':
        return { value: null, nextOffset }
      case '#':
        return { value: text === 't', nextOffset }
      case ',': {
        if (text === 'inf') return { value: Infinity, nextOffset }
        if (text === '-inf') return { value: -Infinity, nextOffset }
        if (text === 'nan') return { value: NaN, nextOffset }
        return { value: Number(text), nextOffset }
      }
      case '(':
        return { value: text, nextOffset }
    }
  }

  if (prefix === '$' || prefix === '!' || prefix === '=') {
    const lineEnd = findCrlf(buf, offset + 1)
    if (lineEnd < 0) return null
    const len = parseStrictRespInt(
      buf.subarray(offset + 1, lineEnd).toString('utf8'),
      offset,
      'bulk length'
    )
    if (len < -1) {
      throw new RespProtocolError(`Invalid negative RESP bulk length (${len}) at offset ${offset}`)
    }
    if (len === -1) {
      return { value: null, nextOffset: lineEnd + 2 }
    }
    const dataStart = lineEnd + 2
    const dataEnd = dataStart + len
    if (buf.length < dataEnd + 2) return null
    if (buf[dataEnd] !== 13 || buf[dataEnd + 1] !== 10) {
      throw new RespProtocolError(`Missing CRLF terminator in RESP bulk frame at offset ${offset}`)
    }
    const payload = buf.subarray(dataStart, dataEnd).toString('utf8')
    const nextOffset = dataEnd + 2
    if (prefix === '!') {
      return { value: new RespProtocolError(payload), nextOffset }
    }
    if (prefix === '=' && payload.length >= 4 && payload[3] === ':') {
      return { value: payload.slice(4), nextOffset }
    }
    return { value: payload, nextOffset }
  }

  if (prefix === '*' || prefix === '~' || prefix === '>') {
    const lineEnd = findCrlf(buf, offset + 1)
    if (lineEnd < 0) return null
    const count = parseStrictRespInt(
      buf.subarray(offset + 1, lineEnd).toString('utf8'),
      offset,
      'array count'
    )
    if (count < -1) {
      throw new RespProtocolError(`Invalid negative RESP array count (${count}) at offset ${offset}`)
    }
    if (count === -1) {
      return { value: null, nextOffset: lineEnd + 2, isPush: prefix === '>' }
    }
    let cursor = lineEnd + 2
    const items: unknown[] = []
    for (let i = 0; i < count; i++) {
      const elem = decodeRespFrame(buf, cursor, depth + 1)
      if (!elem) return null
      items.push(elem.value)
      cursor = elem.nextOffset
    }
    return { value: items, nextOffset: cursor, isPush: prefix === '>' }
  }

  if (prefix === '%') {
    const lineEnd = findCrlf(buf, offset + 1)
    if (lineEnd < 0) return null
    const pairs = parseStrictRespInt(
      buf.subarray(offset + 1, lineEnd).toString('utf8'),
      offset,
      'map count'
    )
    if (pairs < 0) {
      throw new RespProtocolError(`Malformed RESP map count at offset ${offset}`)
    }
    let cursor = lineEnd + 2
    const obj: Record<string, unknown> = {}
    for (let i = 0; i < pairs; i++) {
      const keyFrame = decodeRespFrame(buf, cursor, depth + 1)
      if (!keyFrame) return null
      cursor = keyFrame.nextOffset
      const valFrame = decodeRespFrame(buf, cursor, depth + 1)
      if (!valFrame) return null
      cursor = valFrame.nextOffset
      Object.defineProperty(obj, String(keyFrame.value), {
        value: valFrame.value,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return { value: obj, nextOffset: cursor }
  }

  // RESP3 attribute prefix `|`: metadata map followed immediately by the actual reply frame
  if (prefix === '|') {
    const lineEnd = findCrlf(buf, offset + 1)
    if (lineEnd < 0) return null
    const pairs = parseStrictRespInt(
      buf.subarray(offset + 1, lineEnd).toString('utf8'),
      offset,
      'attribute count'
    )
    if (pairs < 0) {
      throw new RespProtocolError(`Malformed RESP attribute count at offset ${offset}`)
    }
    let cursor = lineEnd + 2
    for (let i = 0; i < pairs; i++) {
      const keyFrame = decodeRespFrame(buf, cursor, depth + 1)
      if (!keyFrame) return null
      cursor = keyFrame.nextOffset
      const valFrame = decodeRespFrame(buf, cursor, depth + 1)
      if (!valFrame) return null
      cursor = valFrame.nextOffset
    }
    return decodeRespFrame(buf, cursor, depth + 1)
  }

  throw new RespProtocolError(`Unsupported RESP prefix '${prefix}'`)
}

export function encodeRespCommand(args: Array<string | number>): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`, 'utf8')]
  for (const arg of args) {
    const text = String(arg)
    const byteLen = Buffer.byteLength(text, 'utf8')
    parts.push(Buffer.from(`$${byteLen}\r\n`, 'utf8'))
    parts.push(Buffer.from(text, 'utf8'))
    parts.push(Buffer.from('\r\n', 'utf8'))
  }
  return Buffer.concat(parts)
}

interface PendingReply {
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
}

export class RespSocketClient {
  readonly socket: net.Socket
  private rxBuf: Buffer = Buffer.alloc(0)
  private rxReadOffset = 0
  private rxWriteOffset = 0
  private readonly pending: PendingReply[] = []
  private closed = false

  private constructor(socket: net.Socket) {
    this.socket = socket
    socket.on('data', (chunk: Buffer) => this.handleData(chunk))
    socket.on('error', (err) => this.failAll(err))
    socket.on('close', () => {
      this.closed = true
      this.failAll(new DatabaseDriverError('Redis socket closed', 'SOCKET_CLOSED', 'redis'))
    })
  }

  static async connect(options: {
    host: string
    port: number
    ssl: boolean
    timeoutMs?: number
    tlsOptions?: tls.ConnectionOptions
  }): Promise<RespSocketClient> {
    const timeoutMs = options.timeoutMs ?? 10000
    let tcpSock: net.Socket
    try {
      tcpSock = await networkDialer.dialTcp({
        host: options.host,
        port: options.port,
        timeoutMs,
      })
    } catch (err: unknown) {
      throw new DatabaseDriverError(
        formatRedisErrorMessage(err, 'Redis connection failed'),
        'SOCKET_ERROR',
        'redis',
        scrubRedisError(err)
      )
    }

    if (!options.ssl) {
      tcpSock.setNoDelay(true)
      return new RespSocketClient(tcpSock)
    }

    const tlsSocket = await new Promise<net.Socket>((resolve, reject) => {
      tcpSock.on('error', () => {
        // Prevent unhandled error if TLS wrapper destroys the underlying TCP socket
      })
      const tlsOpts: tls.ConnectionOptions = {
        socket: tcpSock,
        host: options.host,
        rejectUnauthorized: true,
      }
      if (!net.isIP(options.host)) {
        tlsOpts.servername = options.host
      }
      // Custom CA / client certs (mTLS) and SNI of the real remote host override the defaults
      Object.assign(tlsOpts, options.tlsOptions)
      tlsOpts.socket = tcpSock

      let settled = false
      let tlsSock: tls.TLSSocket | undefined
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const err = new Error(`Redis TLS handshake timed out after ${timeoutMs}ms`)
        if (tlsSock && !tlsSock.destroyed) tlsSock.destroy()
        if (!tcpSock.destroyed) tcpSock.destroy()
        reject(
          new DatabaseDriverError(
            formatRedisErrorMessage(err, 'Redis connection failed'),
            'SOCKET_ERROR',
            'redis',
            scrubRedisError(err)
          )
        )
      }, timeoutMs)

      try {
        tlsSock = tls.connect(tlsOpts)
      } catch (err: unknown) {
        clearTimeout(timer)
        if (!tcpSock.destroyed) tcpSock.destroy()
        reject(
          new DatabaseDriverError(
            formatRedisErrorMessage(err, 'Redis connection failed'),
            'SOCKET_ERROR',
            'redis',
            scrubRedisError(err)
          )
        )
        return
      }

      const activeTlsSock = tlsSock
      activeTlsSock.once('secureConnect', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        activeTlsSock.setNoDelay(true)
        resolve(activeTlsSock)
      })
      activeTlsSock.once('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (!activeTlsSock.destroyed) activeTlsSock.destroy()
        if (!tcpSock.destroyed) tcpSock.destroy()
        reject(
          new DatabaseDriverError(
            formatRedisErrorMessage(err, 'Redis connection failed'),
            'SOCKET_ERROR',
            'redis',
            scrubRedisError(err)
          )
        )
      })
      activeTlsSock.once('close', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(
          new DatabaseDriverError(
            'Redis TLS socket closed during handshake',
            'SOCKET_ERROR',
            'redis'
          )
        )
      })
    })

    return new RespSocketClient(tlsSocket)
  }

  isAlive(): boolean {
    return !this.closed && !this.socket.destroyed
  }

  private resetRxBuffer(): void {
    this.rxReadOffset = 0
    this.rxWriteOffset = 0
    if (this.rxBuf.length > 65_536) {
      this.rxBuf = Buffer.alloc(0)
    }
  }

  private appendChunkLinear(chunk: Buffer): void {
    const unread = this.rxWriteOffset - this.rxReadOffset
    const needed = unread + chunk.length
    if (this.rxWriteOffset + chunk.length > this.rxBuf.length) {
      if (this.rxReadOffset > 0 && needed <= this.rxBuf.length) {
        this.rxBuf.copy(this.rxBuf, 0, this.rxReadOffset, this.rxWriteOffset)
        this.rxWriteOffset = unread
        this.rxReadOffset = 0
      } else {
        const nextCap = Math.min(
          MAX_RESP_BUFFER_BYTES,
          Math.max(4096, this.rxBuf.length * 2, needed)
        )
        const nextBuf = Buffer.allocUnsafe(nextCap)
        if (unread > 0) {
          this.rxBuf.copy(nextBuf, 0, this.rxReadOffset, this.rxWriteOffset)
        }
        this.rxBuf = nextBuf
        this.rxReadOffset = 0
        this.rxWriteOffset = unread
      }
    }
    chunk.copy(this.rxBuf, this.rxWriteOffset)
    this.rxWriteOffset += chunk.length
  }

  private handleData(chunk: Buffer): void {
    if (chunk.length === 0) return
    const unreadBefore = this.rxWriteOffset - this.rxReadOffset
    if (unreadBefore + chunk.length > MAX_RESP_BUFFER_BYTES) {
      this.rxBuf = Buffer.alloc(0)
      this.rxReadOffset = 0
      this.rxWriteOffset = 0
      this.failAll(
        new DatabaseDriverError(
          `Redis response exceeded maximum buffer limit (${MAX_RESP_BUFFER_BYTES} bytes)`,
          'REDIS_RESPONSE_TOO_LARGE',
          'redis'
        )
      )
      this.destroy()
      return
    }

    // Zero-copy fast path when no partial frame is buffered
    let decodeView: Buffer
    let usingDirectChunk = false
    if (unreadBefore === 0) {
      decodeView = chunk
      usingDirectChunk = true
    } else {
      this.appendChunkLinear(chunk)
      decodeView = this.rxBuf.subarray(this.rxReadOffset, this.rxWriteOffset)
    }

    let offset = 0
    while (offset < decodeView.length) {
      let decoded: DecodedFrame
      try {
        decoded = decodeRespFrame(decodeView, offset, 0)
      } catch (err) {
        this.rxBuf = Buffer.alloc(0)
        this.rxReadOffset = 0
        this.rxWriteOffset = 0
        this.failAll(err)
        this.destroy()
        return
      }
      if (!decoded) break

      offset = decoded.nextOffset
      // Out-of-band RESP3 push frames (`>`) must not consume command reply waiters
      if (decoded.isPush) {
        continue
      }

      const waiter = this.pending.shift()
      if (!waiter) {
        continue
      }
      if (decoded.value instanceof RespProtocolError) {
        waiter.reject(
          new DatabaseDriverError(
            formatRedisErrorMessage(decoded.value, 'Redis command failed'),
            'REDIS_ERROR',
            'redis'
          )
        )
      } else {
        waiter.resolve(decoded.value)
      }
    }

    if (usingDirectChunk) {
      if (offset < chunk.length) {
        this.appendChunkLinear(offset === 0 ? chunk : chunk.subarray(offset))
      }
      return
    }

    this.rxReadOffset += offset
    if (this.rxReadOffset >= this.rxWriteOffset) {
      this.resetRxBuffer()
    } else if (this.rxReadOffset > 0 && this.rxReadOffset >= this.rxWriteOffset / 2) {
      const remaining = this.rxWriteOffset - this.rxReadOffset
      this.rxBuf.copy(this.rxBuf, 0, this.rxReadOffset, this.rxWriteOffset)
      this.rxReadOffset = 0
      this.rxWriteOffset = remaining
    }
  }

  private failAll(err: unknown): void {
    if (this.pending.length === 0) return
    const wrapped =
      err instanceof DatabaseDriverError
        ? scrubRedisError(err)
        : new DatabaseDriverError(
            formatRedisErrorMessage(err, 'Redis socket error'),
            'SOCKET_ERROR',
            'redis',
            scrubRedisError(err)
          )
    while (this.pending.length > 0) {
      const waiter = this.pending.shift()
      if (!waiter) break
      waiter.reject(wrapped)
    }
  }

  sendCommand(args: Array<string | number>): Promise<unknown> {
    return this.sendPipeline([args]).then((results) => results[0])
  }

  sendPipeline(commands: Array<Array<string | number>>): Promise<unknown[]> {
    if (commands.length === 0) return Promise.resolve([])
    if (!this.isAlive()) {
      return Promise.reject(
        new DatabaseDriverError('Redis connection is closed', 'SOCKET_CLOSED', 'redis')
      )
    }

    const promises = commands.map(
      () =>
        new Promise<unknown>((resolve, reject) => {
          this.pending.push({ resolve, reject })
        })
    )
    const payload = Buffer.concat(commands.map(encodeRespCommand))
    this.socket.write(payload)
    return Promise.all(promises)
  }

  sendPipelineSettled(
    commands: Array<Array<string | number>>
  ): Promise<PromiseSettledResult<unknown>[]> {
    if (commands.length === 0) return Promise.resolve([])
    if (!this.isAlive()) {
      return Promise.reject(
        new DatabaseDriverError('Redis connection is closed', 'SOCKET_CLOSED', 'redis')
      )
    }

    const promises = commands.map(
      () =>
        new Promise<unknown>((resolve, reject) => {
          this.pending.push({ resolve, reject })
        })
    )
    const payload = Buffer.concat(commands.map(encodeRespCommand))
    this.socket.write(payload)
    return Promise.allSettled(promises)
  }

  destroy(): void {
    this.closed = true
    if (!this.socket.destroyed) {
      this.socket.destroy()
    }
  }
}

export function tokenizeRedisCommandScript(script: string): string[][] {
  const commands: string[][] = []
  for (const rawLine of script.split(/\r?\n/)) {
    const args = tokenizeRedisCommandLine(rawLine, { strict: true })
    if (args.length > 0) {
      commands.push(args)
    }
  }
  return commands
}

function quoteRedisArg(arg: string): string {
  if (arg === '') return '""'
  if (/[\s"'\\]/.test(arg)) {
    const escaped = arg
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
    return `"${escaped}"`
  }
  return arg
}

export function redactRedisCommandArgs(cmdArgs: readonly string[]): string[] {
  const out = [...cmdArgs]
  if (out.length < 2) return out
  const cmd = (out[0] || '').toUpperCase()

  if (cmd === 'AUTH') {
    if (out.length === 2) {
      out[1] = '***'
    } else {
      for (let i = 2; i < out.length; i++) {
        out[i] = '***'
      }
    }
    return out
  }

  if (cmd === 'HELLO') {
    for (let i = 1; i < out.length; i++) {
      if ((out[i] || '').toUpperCase() === 'AUTH') {
        if (i + 2 < out.length) {
          out[i + 2] = '***'
          i += 2
        } else if (i + 1 < out.length) {
          out[i + 1] = '***'
          i += 1
        }
      }
    }
    return out
  }

  if (cmd === 'ACL' && (out[1] || '').toUpperCase() === 'SETUSER') {
    for (let i = 3; i < out.length; i++) {
      const rule = out[i] || ''
      if (
        (rule.startsWith('>') ||
          rule.startsWith('#') ||
          rule.startsWith('<') ||
          rule.startsWith('!')) &&
        rule.length > 1
      ) {
        out[i] = `${rule[0]}***`
      }
    }
    return out
  }

  if (cmd === 'CONFIG' && (out[1] || '').toUpperCase() === 'SET') {
    for (let i = 2; i + 1 < out.length; i += 2) {
      const param = (out[i] || '').toLowerCase()
      if (param === 'requirepass' || param === 'masterauth') {
        out[i + 1] = '***'
      }
    }
    return out
  }

  if (cmd === 'MIGRATE') {
    for (let i = 1; i < out.length; i++) {
      const opt = (out[i] || '').toUpperCase()
      if (opt === 'KEYS') break
      if (opt === 'AUTH' && i + 1 < out.length) {
        out[i + 1] = '***'
        i += 1
      } else if (opt === 'AUTH2' && i + 2 < out.length) {
        out[i + 2] = '***'
        i += 2
      }
    }
    return out
  }

  return out
}

/**
 * Linear-time case-insensitive wildcard glob matcher (`*` and `?`) with zero regex backtracking.
 */
export function matchRedisGlob(pattern: string, input: string): boolean {
  const p = pattern.toLowerCase()
  const s = input.toLowerCase()
  type GlobToken =
    | { kind: 'star' }
    | { kind: 'any' }
    | { kind: 'lit'; ch: string }
    | { kind: 'class'; negated: boolean; chars: Set<string>; ranges: Array<[number, number]> }

  const tokens: GlobToken[] = []
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]
    if (ch === '*') {
      if (tokens.length === 0 || tokens[tokens.length - 1]?.kind !== 'star') {
        tokens.push({ kind: 'star' })
      }
      continue
    }
    if (ch === '?') {
      tokens.push({ kind: 'any' })
      continue
    }
    if (ch === '\\' && i + 1 < p.length) {
      i += 1
      tokens.push({ kind: 'lit', ch: p[i] })
      continue
    }
    if (ch === '[') {
      let j = i + 1
      let negated = false
      if (j < p.length && p[j] === '^') {
        negated = true
        j += 1
      }
      const chars = new Set<string>()
      const ranges: Array<[number, number]> = []
      let closed = false
      while (j < p.length) {
        if (p[j] === ']' && (chars.size > 0 || ranges.length > 0 || j > i + (negated ? 2 : 1))) {
          closed = true
          break
        }
        let c = p[j]
        if (c === '\\' && j + 1 < p.length) {
          j += 1
          c = p[j]
        }
        if (j + 2 < p.length && p[j + 1] === '-' && p[j + 2] !== ']') {
          let endChar = p[j + 2]
          j += 2
          if (endChar === '\\' && j + 1 < p.length) {
            j += 1
            endChar = p[j]
          }
          const lo = c.charCodeAt(0)
          const hi = endChar.charCodeAt(0)
          ranges.push(lo <= hi ? [lo, hi] : [hi, lo])
        } else {
          chars.add(c)
        }
        j += 1
      }
      if (closed) {
        tokens.push({ kind: 'class', negated, chars, ranges })
        i = j
        continue
      }
    }
    tokens.push({ kind: 'lit', ch })
  }

  const m = tokens.length
  const n = s.length
  let prev = new Uint8Array(n + 1)
  let curr = new Uint8Array(n + 1)
  prev[0] = 1
  for (let ti = 0; ti < m; ti++) {
    const tok = tokens[ti]
    curr.fill(0)
    if (tok.kind === 'star') {
      let seen = 0
      for (let si = 0; si <= n; si++) {
        if (prev[si]) seen = 1
        curr[si] = seen
      }
    } else {
      for (let si = 1; si <= n; si++) {
        if (!prev[si - 1]) continue
        const sc = s[si - 1]
        if (tok.kind === 'any') {
          curr[si] = 1
        } else if (tok.kind === 'lit') {
          if (sc === tok.ch) curr[si] = 1
        } else {
          const code = sc.charCodeAt(0)
          let inClass = tok.chars.has(sc)
          if (!inClass) {
            for (const [lo, hi] of tok.ranges) {
              if (code >= lo && code <= hi) {
                inClass = true
                break
              }
            }
          }
          if (tok.negated ? !inClass : inClass) curr[si] = 1
        }
      }
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[n] === 1
}

function buildKeyMatcher(whereClause?: string): ((key: string) => boolean) | null {
  if (!whereClause || !whereClause.trim()) return null
  let trimmed = whereClause.trim().replace(/^WHERE\s+/i, '').trim()
  if (!trimmed) return null

  const likeMatch = /^key\s+LIKE\s+['"](.+)['"]$/i.exec(trimmed)
  if (likeMatch) {
    const glob = likeMatch[1].replace(/%/g, '*').replace(/_/g, '?')
    return (key) => matchRedisGlob(glob, key)
  }

  const eqMatch = /^key\s*=\s*['"](.+)['"]$/i.exec(trimmed)
  if (eqMatch) {
    const target = eqMatch[1]
    return (key) => key === target
  }

  if (trimmed.includes('*') || trimmed.includes('?')) {
    return (key) => matchRedisGlob(trimmed, key)
  }

  const needle = trimmed.toLowerCase()
  return (key) => key.toLowerCase().includes(needle)
}

function formatRedisStructureValue(type: string, raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (type === 'string') return String(raw)
  const payload =
    (type === 'hash' || type === 'set') &&
    Array.isArray(raw) &&
    raw.length === 2 &&
    Array.isArray(raw[1])
      ? raw[1]
      : raw
  if (type === 'hash') {
    if (Array.isArray(payload)) {
      const obj: Record<string, unknown> = {}
      for (let i = 0; i + 1 < payload.length; i += 2) {
        obj[String(payload[i])] = payload[i + 1]
      }
      return JSON.stringify(obj)
    }
    if (typeof payload === 'object') return JSON.stringify(payload)
  }
  if (type === 'zset' && Array.isArray(payload)) {
    const entries: Array<{ member: string; score: string }> = []
    for (let i = 0; i + 1 < payload.length; i += 2) {
      entries.push({ member: String(payload[i]), score: String(payload[i + 1]) })
    }
    return JSON.stringify(entries)
  }
  if (Array.isArray(payload)) return JSON.stringify(payload)
  if (typeof payload === 'object') return JSON.stringify(payload)
  return String(payload)
}

function serializeRespValue(value: unknown): unknown {
  if (value instanceof RespProtocolError) return scrubDriverErrorText(value.message)
  if (value instanceof Error) return scrubDriverErrorText(value.message)
  if (Array.isArray(value)) return value.map(serializeRespValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeRespValue(v)
    }
    return out
  }
  return value
}

function formatRedisReplyCell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (value instanceof RespProtocolError) return scrubDriverErrorText(value.message)
  if (value instanceof Error) return scrubDriverErrorText(value.message)
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  return JSON.stringify(serializeRespValue(value))
}

interface ActiveRedisQuery {
  client: RespSocketClient | null
  cancelled: boolean
  reject: (err: DatabaseDriverError) => void
}

/** TLS is on when explicitly overridden on, or when custom certs/mode resolved (override object) */
export function shouldUseRedisTls(
  tlsOverride: false | tls.ConnectionOptions | undefined,
  ssl: boolean
): boolean {
  return tlsOverride === false ? false : tlsOverride ? true : ssl
}

export class RedisSession implements IDatabaseSession {
  readonly driverType = 'redis' as const
  readonly profile: ConnectionProfile
  private readonly secret?: string
  private sharedClient: RespSocketClient | null = null
  private connectPromise: Promise<RespSocketClient> | null = null
  private readonly activeQueries = new Map<string, ActiveRedisQuery>()
  private readonly partialHashKeys = new Set<string>()
  private readonly hydratedHashFields = new Map<string, Set<string>>()
  private isClosed = false

  private readonly extraSecrets?: DriverTlsOptions
  private tlsOptionsPromise: Promise<false | tls.ConnectionOptions | undefined> | null = null

  constructor(profile: ConnectionProfile, secret?: string, extraSecrets?: DriverTlsOptions) {
    this.profile = profile
    this.secret = secret
    this.extraSecrets = extraSecrets
  }

  isAlive(): boolean {
    if (this.isClosed) return false
    if (this.sharedClient && !this.sharedClient.isAlive()) return false
    return true
  }

  private assertWritable(): void {
    if (this.profile.readOnly) {
      throw new DatabaseDriverError(
        'Connection is read-only. Write operations are disabled.',
        'READ_ONLY',
        'redis'
      )
    }
  }

  private resolveConnectionTarget(): {
    host: string
    port: number
    ssl: boolean
    dbIndex: number
  } {
    let host = this.profile.host || 'localhost'
    let port = this.profile.port || 6379
    let inferredSsl = false
    let dbIndex =
      typeof this.profile.redisDb === 'number' && Number.isInteger(this.profile.redisDb)
        ? this.profile.redisDb
        : Number.isInteger(Number(this.profile.database)) && this.profile.database !== ''
          ? Number(this.profile.database)
          : 0

    if (this.profile.url) {
      try {
        const parsed = new URL(this.profile.url)
        if (!this.profile.host && parsed.hostname) host = parsed.hostname
        if (!this.profile.port && parsed.port) port = Number(parsed.port) || port
        if (parsed.protocol === 'rediss:') inferredSsl = true
      } catch {
        // Fallback to discrete fields
      }
    }

    const ssl = this.profile.ssl !== undefined ? Boolean(this.profile.ssl) : inferredSsl
    const clampedDb = Math.max(0, Math.min(15, Math.floor(dbIndex || 0)))
    return { host, port, ssl, dbIndex: clampedDb }
  }

  private getDbSchemaLabel(): string {
    return `db${this.resolveConnectionTarget().dbIndex}`
  }

  private async openAuthenticatedClient(): Promise<RespSocketClient> {
    const { host, port, ssl, dbIndex } = this.resolveConnectionTarget()
    if (!this.tlsOptionsPromise) {
      this.tlsOptionsPromise = resolveEffectiveTlsOptions(
        this.profile,
        this.extraSecrets,
        this.extraSecrets?.tlsServername
      )
    }
    const tlsOverride = await this.tlsOptionsPromise
    const useTls = shouldUseRedisTls(tlsOverride, ssl)
    const tlsOptions =
      tlsOverride === false
        ? undefined
        : tlsOverride !== undefined
          ? tlsOverride
          : useTls
            ? buildDefaultTlsOptions(this.extraSecrets?.tlsServername)
            : undefined
    const client = await RespSocketClient.connect({ host, port, ssl: useTls, tlsOptions })
    try {
      if (this.secret && this.secret.length > 0) {
        const username = this.profile.user?.trim()
        if (username && username.length > 0) {
          try {
            await client.sendCommand(['AUTH', username, this.secret])
          } catch (authErr: unknown) {
            const msg = authErr instanceof Error ? authErr.message : String(authErr)
            // Redis 5.x does not support 2-argument ACL AUTH; fall back to 1-argument AUTH
            if (/wrong number of arguments|syntax error|invalid.*auth/i.test(msg)) {
              await client.sendCommand(['AUTH', this.secret])
            } else {
              throw authErr
            }
          }
        } else {
          await client.sendCommand(['AUTH', this.secret])
        }
      }
      // Only send SELECT when dbIndex > 0 so Redis Cluster / ElastiCache / restricted ACLs work on db0
      if (dbIndex > 0) {
        await client.sendCommand(['SELECT', dbIndex])
      }
      await client.sendCommand(['PING'])
      return client
    } catch (err) {
      client.destroy()
      throw scrubRedisError(err)
    }
  }

  private async runScrubbed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err: unknown) {
      throw scrubRedisError(err)
    }
  }

  private async getClient(): Promise<RespSocketClient> {
    return this.runScrubbed(async () => {
      if (this.isClosed) {
        throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'redis')
      }
      if (this.sharedClient && this.sharedClient.isAlive()) {
        return this.sharedClient
      }
      if (this.connectPromise) {
        return this.connectPromise
      }

      this.connectPromise = this.openAuthenticatedClient()
        .then((client) => {
          if (this.isClosed) {
            client.destroy()
            throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'redis')
          }
          this.sharedClient = client
          return client
        })
        .finally(() => {
          this.connectPromise = null
        })

      return this.connectPromise
    })
  }

  async init(): Promise<void> {
    await this.getClient()
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    if (this.isClosed) {
      return { ok: false, message: 'Session is closed' }
    }
    try {
      const client = await this.getClient()
      const pong = await client.sendCommand(['PING'])
      return {
        ok: String(pong).toUpperCase() === 'PONG',
        message: 'Redis connection valid',
      }
    } catch (err: unknown) {
      return {
        ok: false,
        message: formatRedisErrorMessage(err, 'Failed to connect to Redis'),
      }
    }
  }

  async close(): Promise<void> {
    if (this.isClosed) return
    this.isClosed = true
    if (this.sharedClient) {
      this.sharedClient.destroy()
      this.sharedClient = null
    }
    for (const active of this.activeQueries.values()) {
      active.cancelled = true
      if (active.client) {
        active.client.destroy()
      }
      active.reject(new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'redis'))
    }
    this.activeQueries.clear()
  }

  private async scanKeys(matchPattern: string, maxKeys = MAX_SCAN_KEYS): Promise<string[]> {
    const client = await this.getClient()
    const keys: string[] = []
    const seen = new Set<string>()
    let cursor = '0'
    let iterations = 0
    const deadline = Date.now() + MAX_SCAN_DURATION_MS

    do {
      const reply = (await client.sendCommand([
        'SCAN',
        cursor,
        'MATCH',
        matchPattern,
        'COUNT',
        200,
      ])) as [unknown, unknown[]]
      if (!Array.isArray(reply) || reply.length < 2) break

      cursor = String(reply[0] ?? '0')
      const batch = Array.isArray(reply[1]) ? reply[1] : []
      for (const rawKey of batch) {
        const key = String(rawKey)
        if (!seen.has(key)) {
          seen.add(key)
          keys.push(key)
          if (keys.length >= maxKeys) break
        }
      }
      iterations += 1
    } while (
      cursor !== '0' &&
      keys.length < maxKeys &&
      iterations < MAX_SCAN_ITERATIONS &&
      Date.now() < deadline
    )

    return keys
  }

  async listObjects(schema?: string): Promise<SchemaObject[]> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'redis')
    }
    const dbSchema = schema || this.getDbSchemaLabel()
    const keys = await this.scanKeys('*', MAX_SCAN_KEYS)

    const prefixes = new Set<string>()
    let hasRoot = false

    for (const key of keys) {
      const colonIdx = key.indexOf(':')
      if (colonIdx > 0) {
        prefixes.add(`${key.slice(0, colonIdx)}:*`)
      } else {
        hasRoot = true
      }
    }

    const objects: SchemaObject[] = [{ name: '(all)', schema: dbSchema, kind: 'table' }]
    if (hasRoot) {
      objects.push({ name: '(root)', schema: dbSchema, kind: 'table' })
    }
    for (const prefix of Array.from(prefixes).sort((a, b) => a.localeCompare(b))) {
      objects.push({ name: prefix, schema: dbSchema, kind: 'table' })
    }
    return objects
  }

  async listSchemas(): Promise<{ schemas: string[]; defaultSchema: string }> {
    const label = this.getDbSchemaLabel()
    return { schemas: [label], defaultSchema: label }
  }

  async getObjectDdl(name: string, kind: SchemaObjectKind, schema?: string): Promise<string> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'redis')
    }
    if (kind !== 'table') {
      return `# Redis exposes virtual key namespaces only; no ${kind} DDL exists for "${name}".`
    }
    return this.getDdl(name, schema)
  }

  async exportSchemaDdl(schema?: string): Promise<{ ddl: string; objectCount: number }> {
    const label = schema || this.getDbSchemaLabel()
    let keyCount = 0
    if (!this.isClosed) {
      try {
        const client = await this.getClient()
        const dbSize = await client.sendCommand(['DBSIZE'])
        const parsed = Number(dbSize)
        keyCount = Number.isFinite(parsed) ? parsed : 0
      } catch {
        keyCount = 0
      }
    }
    const lines = [
      '-- Datanoa Full Schema DDL Export',
      '-- Dialect: redis',
      `-- Schema: ${label}`,
      '',
      '# Redis is a schema-less key/value store: no executable DDL is generated.',
      `# Keyspace size: ${keyCount} key(s).`,
      '# Use DUMP/RESTORE or logical application migrations for data export.',
    ]
    return { ddl: `${lines.join('\n')}\n`, objectCount: 0 }
  }

  async getTableDetails(table: string, schema?: string): Promise<TableDetails> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'redis')
    }
    return {
      name: table || '(all)',
      schema: schema || this.getDbSchemaLabel(),
      kind: 'table',
      columns: REDIS_COLUMNS.map((c) => ({ ...c })),
      primaryKey: ['key'],
      indexes: [],
      foreignKeys: [],
    }
  }

  private async hydrateKeyRows(keys: string[]): Promise<Record<string, unknown>[]> {
    if (keys.length === 0) return []
    const client = await this.getClient()
    const allRows: Record<string, unknown>[] = []

    for (let startIdx = 0; startIdx < keys.length; startIdx += HYDRATE_CHUNK_SIZE) {
      const chunk = keys.slice(startIdx, startIdx + HYDRATE_CHUNK_SIZE)
      const metaCmds: Array<Array<string | number>> = []
      for (const key of chunk) {
        metaCmds.push(['TYPE', key])
        metaCmds.push(['TTL', key])
      }
      const metaSettled = await client.sendPipelineSettled(metaCmds)

      const types: string[] = []
      const ttls: number[] = []
      const valCmds: Array<Array<string | number>> = []
      const valCmdIndices: number[] = []

      for (let i = 0; i < chunk.length; i++) {
        const key = chunk[i]
        const typeRes = metaSettled[i * 2]
        const ttlRes = metaSettled[i * 2 + 1]
        const keyType =
          typeRes?.status === 'fulfilled'
            ? String(typeRes.value ?? 'none').toLowerCase()
            : 'none'
        const ttlRaw = ttlRes?.status === 'fulfilled' ? Number(ttlRes.value ?? -1) : -1
        types.push(keyType)
        ttls.push(Number.isFinite(ttlRaw) ? ttlRaw : -1)

        if (keyType === 'string') {
          valCmdIndices.push(i)
          valCmds.push(['GET', key])
        } else if (keyType === 'hash') {
          valCmdIndices.push(i)
          valCmds.push(['HSCAN', key, 0, 'COUNT', 20])
        } else if (keyType === 'list') {
          valCmdIndices.push(i)
          valCmds.push(['LRANGE', key, 0, 20])
        } else if (keyType === 'set') {
          valCmdIndices.push(i)
          valCmds.push(['SSCAN', key, 0, 'COUNT', 20])
        } else if (keyType === 'zset') {
          valCmdIndices.push(i)
          valCmds.push(['ZRANGE', key, 0, 20, 'WITHSCORES'])
        }
      }

      const valSettled = valCmds.length > 0 ? await client.sendPipelineSettled(valCmds) : []
      const valuesByIdx = new Array<string | null>(chunk.length).fill(null)
      for (let j = 0; j < valCmdIndices.length; j++) {
        const rowIdx = valCmdIndices[j]
        const valRes = valSettled[j]
        if (valRes?.status === 'fulfilled') {
          let effectiveRaw: unknown = valRes.value
          if (types[rowIdx] === 'hash') {
            const keyName = chunk[rowIdx]
            const isCursorScan =
              Array.isArray(effectiveRaw) &&
              effectiveRaw.length === 2 &&
              (Array.isArray(effectiveRaw[1]) ||
                (effectiveRaw[1] !== null && typeof effectiveRaw[1] === 'object'))
            const scanCursor = isCursorScan ? String((effectiveRaw as unknown[])[0] ?? '0') : '0'
            if (isCursorScan && scanCursor !== '0') {
              let loadedFull = false
              try {
                const hlen = Number(await client.sendCommand(['HLEN', keyName]))
                if (Number.isFinite(hlen) && hlen > 0 && hlen <= MAX_FULL_HASH_FIELDS) {
                  effectiveRaw = await client.sendCommand(['HGETALL', keyName])
                  loadedFull = true
                }
              } catch {
                // Fall back to partial preview tracking if HLEN/HGETALL unavailable
              }
              if (loadedFull) {
                this.partialHashKeys.delete(keyName)
              } else {
                this.partialHashKeys.add(keyName)
              }
            } else {
              this.partialHashKeys.delete(keyName)
            }
            const formatted = formatRedisStructureValue('hash', effectiveRaw)
            valuesByIdx[rowIdx] = formatted
            if (formatted) {
              try {
                const parsedObj = JSON.parse(formatted) as Record<string, unknown>
                if (parsedObj && typeof parsedObj === 'object' && !Array.isArray(parsedObj)) {
                  this.hydratedHashFields.set(keyName, new Set(Object.keys(parsedObj)))
                }
              } catch {
                // Ignore malformed preview
              }
            }
          } else {
            valuesByIdx[rowIdx] = formatRedisStructureValue(types[rowIdx], effectiveRaw)
          }
        } else {
          valuesByIdx[rowIdx] = null
        }
      }

      for (let i = 0; i < chunk.length; i++) {
        allRows.push({
          key: chunk[i],
          type: types[i],
          ttl: ttls[i],
          value: valuesByIdx[i],
        })
      }
    }

    return allRows
  }

  async fetchPage(params: FetchPageParams): Promise<TableBrowseResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'redis')
    }
    const details = await this.getTableDetails(params.table, params.schema)
    const ns = (params.table || '(all)').trim()
    const isRootNs = ns === '(root)'
    const scanPattern =
      ns === '(all)' || ns === '*' || isRootNs
        ? '*'
        : ns.includes('*') || ns.includes('?')
          ? ns
          : `${ns}:*`

    let keys = await this.scanKeys(scanPattern, MAX_SCAN_KEYS)
    if (isRootNs) {
      keys = keys.filter((k) => !k.includes(':'))
    }

    const matcher = buildKeyMatcher(params.whereClause)
    if (matcher) {
      keys = keys.filter(matcher)
    }

    let sortCol = params.sortColumn || 'key'
    let sortDir: 'ASC' | 'DESC' = params.sortDirection === 'DESC' ? 'DESC' : 'ASC'
    if (params.orderByClause && params.orderByClause.trim()) {
      const cleanOrder = params.orderByClause.trim().replace(/^ORDER\s+BY\s+/i, '').trim()
      const parts = cleanOrder.split(/\s+/)
      if (parts[0]) sortCol = parts[0].replace(/^["'`]|["'`]$/g, '')
      if (parts[1] && parts[1].toUpperCase() === 'DESC') sortDir = 'DESC'
      else if (parts[1] && parts[1].toUpperCase() === 'ASC') sortDir = 'ASC'
    }

    const rawPage = Number(params.page)
    const rawPageSize = Number(params.pageSize)
    const page = Math.max(1, Math.floor(Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1))
    const pageSize = Math.max(
      1,
      Math.min(10000, Math.floor(Number.isFinite(rawPageSize) && rawPageSize > 0 ? rawPageSize : 50))
    )
    const offset = Math.max(0, (page - 1) * pageSize)
    const dirSign = sortDir === 'DESC' ? -1 : 1

    let pageRows: Record<string, unknown>[]
    if (sortCol === 'key') {
      keys.sort((a, b) => a.localeCompare(b) * dirSign)
      const slicedKeys = keys.slice(offset, offset + pageSize)
      pageRows = await this.hydrateKeyRows(slicedKeys)
    } else {
      // Hydrate all scanned keys (already capped by MAX_SCAN_KEYS) so pagination aligns with totalRows
      const hydrated = await this.hydrateKeyRows(keys)
      hydrated.sort((a, b) => {
        const av = a[sortCol]
        const bv = b[sortCol]
        if (typeof av === 'number' && typeof bv === 'number') {
          return (av - bv) * dirSign
        }
        return String(av ?? '').localeCompare(String(bv ?? '')) * dirSign
      })
      pageRows = hydrated.slice(offset, offset + pageSize)
    }

    return assembleTableBrowseResult({
      tableDetails: details,
      rows: pageRows,
      countRow: { total: keys.length },
      page,
      pageSize,
    })
  }

  private async buildValueWriteCommands(
    key: string,
    value: unknown,
    hintType?: string,
    previewOnly = false
  ): Promise<{ commands: Array<Array<string | number>>; preview: string }> {
    const client = await this.getClient()
    const keyType = (
      hintType || String(await client.sendCommand(['TYPE', key]))
    ).toLowerCase()

    if (keyType === 'list' || keyType === 'set' || keyType === 'zset' || keyType === 'stream') {
      throw new DatabaseDriverError(
        `Cannot overwrite Redis ${keyType} key "${key}" via grid text edit. Use the Command Console with native ${keyType.toUpperCase()} commands instead.`,
        'not_supported',
        'redis'
      )
    }

    if (keyType === 'hash') {
      let parsed: Record<string, unknown> | null = null
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>
      } else if (typeof value === 'string') {
        try {
          const maybe = JSON.parse(value)
          if (maybe && typeof maybe === 'object' && !Array.isArray(maybe)) {
            parsed = maybe as Record<string, unknown>
          }
        } catch {
          parsed = null
        }
      }
      if (!parsed) {
        throw new DatabaseDriverError(
          `Redis hash key "${key}" requires a valid JSON object value.`,
          'invalid_params',
          'redis'
        )
      }

      const commands: Array<Array<string | number>> = []
      const previews: string[] = []
      const nextKeys = new Set(Object.keys(parsed))
      const isPartial = this.partialHashKeys.has(key)
      const shownFields = this.hydratedHashFields.get(key)

      if (!previewOnly) {
        if (isPartial) {
          // Partial hash preview (>500 fields): NEVER HDEL unseen fields beyond the preview.
          // Only delete fields that were explicitly shown and removed by the user.
          if (shownFields) {
            const removedShown = Array.from(shownFields).filter((f) => !nextKeys.has(f))
            if (removedShown.length > 0) {
              const delArgs = ['HDEL', key, ...removedShown]
              commands.push(delArgs)
              previews.push(delArgs.map(quoteRedisArg).join(' '))
            }
          }
        } else {
          try {
            const existingRaw = await client.sendCommand(['HKEYS', key])
            if (Array.isArray(existingRaw)) {
              const removedFields = existingRaw
                .map((f) => String(f))
                .filter((f) => !nextKeys.has(f) && (!shownFields || shownFields.has(f)))
              if (removedFields.length > 0) {
                const delArgs = ['HDEL', key, ...removedFields]
                commands.push(delArgs)
                previews.push(delArgs.map(quoteRedisArg).join(' '))
              }
            }
          } catch {
            // Ignore HKEYS error if server does not support it in mock
          }
        }
      }

      if (Object.keys(parsed).length > 0) {
        const setArgs: string[] = ['HSET', key]
        for (const [f, v] of Object.entries(parsed)) {
          setArgs.push(f, v === null || v === undefined ? '' : String(v))
        }
        commands.push(setArgs)
        previews.push(setArgs.map(quoteRedisArg).join(' '))
      }

      return {
        commands,
        preview: previews.join('\n') || `HSET ${quoteRedisArg(key)}`,
      }
    }

    const strVal = value === null || value === undefined ? '' : String(value)
    const args = ['SET', key, strVal, 'KEEPTTL']
    return {
      commands: [args],
      preview: args.map(quoteRedisArg).join(' '),
    }
  }

  private async runKeepTtlAwarePipeline(
    client: {
      sendPipeline(cmds: Array<Array<string | number>>): Promise<unknown[]>
      sendPipelineSettled?(cmds: Array<Array<string | number>>): Promise<PromiseSettledResult<unknown>[]>
      sendCommand(args: Array<string | number>): Promise<unknown>
    },
    cmds: Array<Array<string | number>>
  ): Promise<unknown[]> {
    const isKeepTtlCmd = (cmd: Array<string | number>): boolean =>
      String(cmd[0] ?? '').toUpperCase() === 'SET' &&
      String(cmd[3] ?? '').toUpperCase() === 'KEEPTTL'

    if (typeof client.sendPipelineSettled === 'function') {
      const settled = await client.sendPipelineSettled(cmds)
      const replies: unknown[] = []
      for (let i = 0; i < cmds.length; i++) {
        const res = settled[i]
        if (res && res.status === 'fulfilled') {
          replies.push(res.value)
          continue
        }
        const reason = res?.status === 'rejected' ? res.reason : new Error('Redis pipeline command failed')
        const msg = reason instanceof Error ? reason.message : String(reason)
        const cmd = cmds[i]
        if (isKeepTtlCmd(cmd) && /syntax/i.test(msg)) {
          // Redis < 6.0 rejects SET ... KEEPTTL; retry ONLY the failed KEEPTTL command (never earlier DEL/HSET)
          const pttlRaw = await client.sendCommand(['PTTL', String(cmd[1])])
          const pttl = Number(pttlRaw)
          if (Number.isFinite(pttl) && pttl > 0) {
            replies.push(await client.sendCommand(['SET', cmd[1], cmd[2], 'PX', Math.floor(pttl)]))
          } else {
            replies.push(await client.sendCommand(['SET', cmd[1], cmd[2]]))
          }
          continue
        }
        throw reason
      }
      return replies
    }

    try {
      return await client.sendPipeline(cmds)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!cmds.some(isKeepTtlCmd) || !/syntax/i.test(msg)) {
        throw err
      }
      const replies: unknown[] = []
      for (const cmd of cmds) {
        if (isKeepTtlCmd(cmd)) {
          const pttlRaw = await client.sendCommand(['PTTL', String(cmd[1])])
          const pttl = Number(pttlRaw)
          if (Number.isFinite(pttl) && pttl > 0) {
            replies.push(await client.sendCommand(['SET', cmd[1], cmd[2], 'PX', Math.floor(pttl)]))
          } else {
            replies.push(await client.sendCommand(['SET', cmd[1], cmd[2]]))
          }
        } else {
          replies.push(await client.sendCommand(cmd))
        }
      }
      return replies
    }
  }

  async updateCell(params: UpdateCellParams): Promise<UpdateCellResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'redis')
    }
    this.assertWritable()
    const key = String(params.primaryKeys?.key ?? '')
    if (key.length === 0) {
      throw new DatabaseDriverError('Primary key "key" is required for Redis updates', 'invalid_params', 'redis')
    }
    if (params.column !== 'value' && params.column !== 'ttl') {
      throw new DatabaseDriverError(
        `Redis column "${params.column}" is not editable (only "value" and "ttl" may be updated).`,
        'invalid_params',
        'redis'
      )
    }

    const client = await this.getClient()
    if (params.column === 'ttl') {
      const ttl = Number(params.newValue)
      if (!Number.isFinite(ttl) || ttl < 0) {
        await client.sendCommand(['PERSIST', key])
      } else {
        await client.sendCommand(['EXPIRE', key, Math.floor(ttl)])
      }
    } else {
      const { commands } = await this.buildValueWriteCommands(key, params.newValue)
      if (commands.length > 0) {
        await this.runKeepTtlAwarePipeline(client, commands)
      }
    }

    const [updatedRecord] = await this.hydrateKeyRows([key])
    return {
      ok: true,
      affectedRows: 1,
      updatedRecord,
    }
  }

  async previewChanges(params: ApplyChangesParams): Promise<PreviewChangesResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'redis')
    }
    const statements: string[] = []

    for (const del of params.deletes ?? []) {
      const key = String(del.key ?? '')
      if (key.length === 0) throw new DatabaseDriverError('Missing key for Redis delete', 'invalid_params', 'redis')
      statements.push(`DEL ${quoteRedisArg(key)}`)
    }

    for (const upd of params.updates ?? []) {
      const key = String(upd.primaryKeys?.key ?? '')
      if (key.length === 0) throw new DatabaseDriverError('Missing key for Redis update', 'invalid_params', 'redis')
      if (upd.changes.value !== undefined) {
        const hint = typeof upd.originalRow?.type === 'string' ? upd.originalRow.type : undefined
        if (hint === 'list' || hint === 'set' || hint === 'zset' || hint === 'stream') {
          throw new DatabaseDriverError(
            `Cannot overwrite Redis ${hint} key "${key}" via grid text edit. Use the Command Console with native ${hint.toUpperCase()} commands instead.`,
            'not_supported',
            'redis'
          )
        }
        if (hint === 'hash') {
          const { preview } = await this.buildValueWriteCommands(key, upd.changes.value, 'hash', true)
          statements.push(preview)
        } else {
          const val = upd.changes.value === null ? '' : String(upd.changes.value)
          statements.push(`SET ${quoteRedisArg(key)} ${quoteRedisArg(val)} KEEPTTL`)
        }
      }
      if (upd.changes.ttl !== undefined) {
        const ttl = Number(upd.changes.ttl)
        statements.push(
          !Number.isFinite(ttl) || ttl < 0
            ? `PERSIST ${quoteRedisArg(key)}`
            : `EXPIRE ${quoteRedisArg(key)} ${Math.floor(ttl)}`
        )
      }
    }

    for (const ins of params.inserts ?? []) {
      const key = String(ins.key ?? '')
      if (key.length === 0) throw new DatabaseDriverError('Missing key for Redis insert', 'invalid_params', 'redis')
      const val = ins.value === null || ins.value === undefined ? '' : String(ins.value)
      statements.push(`SET ${quoteRedisArg(key)} ${quoteRedisArg(val)}`)
      const ttl = Number(ins.ttl)
      if (Number.isFinite(ttl) && ttl > 0) {
        statements.push(`EXPIRE ${quoteRedisArg(key)} ${Math.floor(ttl)}`)
      }
    }

    return { statements }
  }

  async applyChanges(params: ApplyChangesParams): Promise<ApplyChangesResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'redis')
    }
    this.assertWritable()
    const preview = await this.previewChanges(params)
    const client = await this.getClient()

    const cmds: Array<Array<string | number>> = []
    const kinds: Array<'delete' | 'update' | 'insert' | 'aux'> = []

    for (const del of params.deletes ?? []) {
      const key = String(del.key ?? '')
      cmds.push(['DEL', key])
      kinds.push('delete')
    }

    for (const upd of params.updates ?? []) {
      const key = String(upd.primaryKeys?.key ?? '')
      let counted = false
      if (upd.changes.value !== undefined) {
        const hint = typeof upd.originalRow?.type === 'string' ? upd.originalRow.type : undefined
        const built = await this.buildValueWriteCommands(key, upd.changes.value, hint, false)
        for (const cmd of built.commands) {
          cmds.push(cmd)
          kinds.push(counted ? 'aux' : 'update')
          counted = true
        }
      }
      if (upd.changes.ttl !== undefined) {
        const ttl = Number(upd.changes.ttl)
        cmds.push(
          !Number.isFinite(ttl) || ttl < 0
            ? ['PERSIST', key]
            : ['EXPIRE', key, Math.floor(ttl)]
        )
        kinds.push(counted ? 'aux' : 'update')
      }
    }

    for (const ins of params.inserts ?? []) {
      const key = String(ins.key ?? '')
      const val = ins.value === null || ins.value === undefined ? '' : String(ins.value)
      cmds.push(['SET', key, val])
      kinds.push('insert')
      const ttl = Number(ins.ttl)
      if (Number.isFinite(ttl) && ttl > 0) {
        cmds.push(['EXPIRE', key, Math.floor(ttl)])
        kinds.push('aux')
      }
    }

    const replies = await this.runKeepTtlAwarePipeline(client, cmds)
    let deleted = 0
    let updated = 0
    let inserted = 0
    for (let i = 0; i < kinds.length; i++) {
      if (kinds[i] === 'delete') deleted += Number(replies[i]) > 0 ? 1 : 0
      else if (kinds[i] === 'update') updated += 1
      else if (kinds[i] === 'insert') inserted += 1
    }

    return {
      ok: true,
      inserted,
      updated,
      deleted,
      statements: preview.statements,
    }
  }

  async getDdl(table: string, schema?: string): Promise<string> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'redis')
    }
    const client = await this.getClient()
    const [infoKeyspace, dbSize] = await client.sendPipeline([
      ['INFO', 'keyspace'],
      ['DBSIZE'],
    ])

    const ns = (table || '(all)').trim()
    const pattern = ns === '(all)' || ns === '(root)' ? '*' : ns
    const sampleKeys = (await this.scanKeys(pattern, 10)).slice(0, 10)
    const sampleRows = await this.hydrateKeyRows(sampleKeys)

    const lines = [
      `# Redis Keyspace (${schema || this.getDbSchemaLabel()})`,
      `# Namespace: ${ns}`,
      `# DBSIZE: ${String(dbSize ?? 0)}`,
      '',
      String(infoKeyspace ?? '').trim(),
      '',
      '# Sample Keys (virtual schema: key, type, ttl, value):',
      ...(sampleRows.length > 0
        ? sampleRows.map((r) => `# - ${String(r.key)} (${String(r.type)}, ttl=${String(r.ttl)})`)
        : ['# - (no keys matched)']),
    ]
    return lines.join('\n')
  }

  async runQuery(queryId: string, commandText: string, maxRows = 1000): Promise<QueryResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'redis')
    }

    const parsedCommands = tokenizeRedisCommandScript(commandText)
    if (parsedCommands.length === 0) {
      throw new DatabaseDriverError('Redis command cannot be empty', 'invalid_params', 'redis')
    }
    if (this.profile.readOnly && parsedCommands.some((cmd) => !isReadOnlyRedisCommand(cmd))) {
      throw new DatabaseDriverError(
        'Connection is read-only. Write operations are disabled.',
        'READ_ONLY',
        'redis'
      )
    }

    const start = performance.now()
    const limit = maxRows > 0 ? maxRows : 1000

    return new Promise<QueryResult>((resolve, reject) => {
      const entry: ActiveRedisQuery = {
        client: null,
        cancelled: false,
        reject,
      }
      this.activeQueries.set(queryId, entry)

      ;(async () => {
        let queryClient: RespSocketClient | null = null
        let currentCmdIndex = -1
        try {
          // Dedicated per-query socket so cancelQuery never destroys sharedClient or disrupts concurrent ops
          queryClient = await this.openAuthenticatedClient()
          if (entry.cancelled || this.isClosed) {
            queryClient.destroy()
            return
          }
          entry.client = queryClient

          if (parsedCommands.length === 1) {
            const cmdArgs = parsedCommands[0]
            const verb = (cmdArgs[0] || '').toUpperCase()
            currentCmdIndex = 0
            const reply = await queryClient.sendCommand(cmdArgs)
            if (entry.cancelled) return

            const executionTimeMs = Math.round(performance.now() - start)
            if (verb === 'SCAN' && Array.isArray(reply) && reply.length >= 2 && Array.isArray(reply[1])) {
              const cursor = String(reply[0] ?? '0')
              const allKeys = reply[1] as unknown[]
              const truncated = allKeys.length > limit
              const sliced = allKeys.slice(0, limit)
              const rows =
                sliced.length > 0
                  ? sliced.map((k) => [cursor, formatRedisReplyCell(k)])
                  : [[cursor, null]]
              resolve({
                columns: [
                  { name: 'cursor', type: 'string' },
                  { name: 'key', type: 'string' },
                ],
                rows,
                rowCount: sliced.length,
                executionTimeMs,
                truncated,
                isSelect: true,
              })
              return
            }

            if (verb === 'HGETALL' && Array.isArray(reply)) {
              const allRows: unknown[][] = []
              for (let i = 0; i + 1 < reply.length; i += 2) {
                allRows.push([formatRedisReplyCell(reply[i]), formatRedisReplyCell(reply[i + 1])])
              }
              const truncated = allRows.length > limit
              const rows = allRows.slice(0, limit)
              resolve({
                columns: [
                  { name: 'field', type: 'string' },
                  { name: 'value', type: 'string' },
                ],
                rows,
                rowCount: rows.length,
                executionTimeMs,
                truncated,
                isSelect: true,
              })
              return
            }

            if (Array.isArray(reply)) {
              const truncated = reply.length > limit
              const rows = reply
                .slice(0, limit)
                .map((item, idx) => [idx, formatRedisReplyCell(item)])
              resolve({
                columns: [
                  { name: 'index', type: 'integer' },
                  { name: 'value', type: 'string' },
                ],
                rows,
                rowCount: rows.length,
                executionTimeMs,
                truncated,
                isSelect: true,
              })
              return
            }

            if (reply !== null && typeof reply === 'object') {
              const entries = Object.entries(reply as Record<string, unknown>)
              const truncated = entries.length > limit
              const rows = entries
                .slice(0, limit)
                .map(([k, v]) => [k, formatRedisReplyCell(v)])
              resolve({
                columns: [
                  { name: 'field', type: 'string' },
                  { name: 'value', type: 'string' },
                ],
                rows,
                rowCount: rows.length,
                executionTimeMs,
                truncated,
                isSelect: true,
              })
              return
            }

            resolve({
              columns: [{ name: 'result', type: 'string' }],
              rows: [[formatRedisReplyCell(reply)]],
              rowCount: 1,
              executionTimeMs,
              truncated: false,
              isSelect: true,
            })
            return
          }

          // Multi-line command batch
          const allRows: unknown[][] = []
          for (let cmdIndex = 0; cmdIndex < parsedCommands.length; cmdIndex++) {
            const cmdArgs = parsedCommands[cmdIndex]
            if (entry.cancelled) return
            currentCmdIndex = cmdIndex
            const reply = await queryClient.sendCommand(cmdArgs)
            if (entry.cancelled) return
            allRows.push([
              redactRedisCommandArgs(cmdArgs).map(quoteRedisArg).join(' '),
              formatRedisReplyCell(reply),
            ])
          }

          const executionTimeMs = Math.round(performance.now() - start)
          const truncated = allRows.length > limit
          const rows = allRows.slice(0, limit)
          resolve({
            columns: [
              { name: 'command', type: 'string' },
              { name: 'result', type: 'string' },
            ],
            rows,
            rowCount: rows.length,
            executionTimeMs,
            truncated,
            isSelect: true,
          })
        } catch (err) {
          if (!entry.cancelled) {
            const scrubbed = scrubRedisError(err)
            if (
              currentCmdIndex >= 0 &&
              !this.isClosed &&
              (scrubbed instanceof Error || parsedCommands.length > 1) &&
              !(
                scrubbed instanceof DatabaseDriverError &&
                (scrubbed.code === 'cancelled' || scrubbed.code === 'SESSION_CLOSED')
              )
            ) {
              reject(attachFailedStatementMeta(scrubbed, currentCmdIndex, parsedCommands.length))
            } else {
              reject(scrubbed)
            }
          }
        } finally {
          this.activeQueries.delete(queryId)
          if (queryClient) {
            queryClient.destroy()
          }
        }
      })()
    })
  }

  async cancelQuery(queryId: string): Promise<{ ok: boolean }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'redis')
    }
    const active = this.activeQueries.get(queryId)
    if (!active) {
      return { ok: true }
    }

    active.cancelled = true
    this.activeQueries.delete(queryId)
    if (active.client) {
      active.client.destroy()
    }
    active.reject(new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'redis'))
    return { ok: true }
  }

  getTransactionState(): TransactionState {
    return createUnsupportedTransactionState(REDIS_UNSUPPORTED_TX_REASON)
  }

  async beginTransaction(): Promise<TransactionState> {
    throw createUnsupportedTransactionError('redis', REDIS_UNSUPPORTED_TX_REASON)
  }

  async commitTransaction(): Promise<TransactionState> {
    throw createUnsupportedTransactionError('redis', REDIS_UNSUPPORTED_TX_REASON)
  }

  async rollbackTransaction(): Promise<TransactionState> {
    throw createUnsupportedTransactionError('redis', REDIS_UNSUPPORTED_TX_REASON)
  }

  async setAutoCommit(enabled: boolean): Promise<TransactionState> {
    if (!enabled) {
      throw createUnsupportedTransactionError('redis', REDIS_UNSUPPORTED_TX_REASON)
    }
    return this.getTransactionState()
  }
}

export class RedisDriver implements IDatabaseDriver {
  readonly type = 'redis' as const

  async createSession(
    profile: ConnectionProfile,
    secret?: string,
    extraSecrets?: DriverTlsOptions
  ): Promise<IDatabaseSession> {
    try {
      const session = new RedisSession(profile, secret, extraSecrets)
      await session.init()
      return session
    } catch (err: unknown) {
      throw scrubRedisError(err)
    }
  }

  async testConnection(
    profile: ConnectionProfile,
    secret?: string,
    extraSecrets?: DriverTlsOptions
  ): Promise<{ ok: boolean; message?: string }> {
    return runDriverConnectionTest(
      () => this.createSession(profile, secret, extraSecrets),
      (err) => formatRedisErrorMessage(err, 'Redis connection failed')
    )
  }
}
