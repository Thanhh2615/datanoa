import {
  DatabaseDriverError,
} from '../common/driver'
import { quoteIdentForDialect } from '../common/sql-tools'

export const COPY_PIECE_BYTES = 256 * 1024
export const COPY_MAX_IPC_CHUNK_BYTES = 512 * 1024
export const DEFAULT_COPY_IDLE_TIMEOUT_MS = 30_000
export const DEFAULT_COPY_DRAIN_TIMEOUT_MS = 30_000
export const DEFAULT_COPY_RFQ_TIMEOUT_MS = 5_000

export interface PgCopyWireStream {
  writableNeedDrain?: boolean
  writableLength?: number
  writableHighWaterMark?: number
  destroyed?: boolean
  destroy(err?: Error): unknown
  on(event: string, listener: (...args: unknown[]) => void): unknown
  once(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
  off?(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface PgCopyWireConnection {
  stream?: PgCopyWireStream
  query(text: string): void
  sendCopyFromChunk(chunk: Buffer): void
  endCopyFrom(): void
  sendCopyFail(msg: string): void
  sync(): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
  once(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
  off?(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface PgCopyQueryableClient {
  query(submittable: { submit(connection: PgCopyWireConnection): void }): unknown
}

export interface PostgresCopyInStreamOptions {
  table: string
  schema?: string
  columns: readonly string[]
  signal?: AbortSignal
  idleTimeoutMs?: number
  drainTimeoutMs?: number
  readyForQueryTimeoutMs?: number
  onIdleTimeout?: (stream: PostgresCopyInStream) => Promise<void> | void
}

function detachListener(
  target: {
    removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
    off?: (event: string, listener: (...args: unknown[]) => void) => void
  } | undefined,
  event: string,
  listener: (...args: unknown[]) => void
): void {
  if (!target) return
  if (typeof target.removeListener === 'function') {
    target.removeListener(event, listener)
  } else if (typeof target.off === 'function') {
    target.off(event, listener)
  }
}

function stripQuotedPartsForCopyCheck(sql: string): { text: string; hasUnclosedQuote: boolean } {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      let closed = false
      i += 1
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (i + 1 < sql.length && sql[i + 1] === quote) {
            i += 2
            continue
          }
          closed = true
          i += 1
          break
        }
        i += 1
      }
      if (!closed) {
        return { text: out, hasUnclosedQuote: true }
      }
      out += quote === '"' ? ' __ident__ ' : ' __lit__ '
      continue
    }
    out += ch
    i += 1
  }
  return { text: out, hasUnclosedQuote: false }
}

/**
 * Validates that a COPY statement strictly uses `FROM STDIN` and CSV format
 * (never `FROM <file>`, `FROM PROGRAM`, or `BINARY`).
 */
export function assertSafePostgresCopySql(sql: string): void {
  const trimmed = sql.trim()
  const { text: stripped, hasUnclosedQuote } = stripQuotedPartsForCopyCheck(trimmed)
  if (hasUnclosedQuote) {
    throw new DatabaseDriverError('Invalid PostgreSQL COPY statement', 'UNSAFE_COPY_SQL', 'postgres')
  }
  const sanitized = stripped.replace(/;\s*$/, '').trim()
  if (sanitized.includes(';')) {
    throw new DatabaseDriverError(
      'Multi-statement SQL is forbidden in PostgreSQL COPY.',
      'UNSAFE_COPY_SQL',
      'postgres'
    )
  }
  if (!/^COPY\s+/i.test(sanitized)) {
    throw new DatabaseDriverError('Invalid PostgreSQL COPY statement', 'UNSAFE_COPY_SQL', 'postgres')
  }
  if (/\bFROM\s+PROGRAM\b/i.test(sanitized) || !/\bFROM\s+STDIN\b/i.test(sanitized)) {
    throw new DatabaseDriverError(
      'Only COPY ... FROM STDIN is permitted; file and PROGRAM sources are forbidden.',
      'UNSAFE_COPY_SQL',
      'postgres'
    )
  }
  if (
    /\bFORMAT\s+BINARY\b/i.test(sanitized) ||
    /\bCOPY\s+BINARY\b/i.test(sanitized) ||
    /\bBINARY\b/i.test(sanitized.split(/\bWITH\b/i)[1] ?? '')
  ) {
    throw new DatabaseDriverError(
      'COPY BINARY format is forbidden; only CSV streaming is permitted.',
      'UNSAFE_COPY_SQL',
      'postgres'
    )
  }
}

/**
 * Generates the canonical safe PostgreSQL `COPY ... FROM STDIN WITH (FORMAT csv, ...)` command.
 */
export function buildPostgresCopyFromStdinSql(opts: {
  table: string
  schema?: string
  columns: readonly string[]
}): string {
  if (typeof opts.table !== 'string' || opts.table.trim().length === 0) {
    throw new DatabaseDriverError('Target table name is required for COPY import', 'invalid_params', 'postgres')
  }
  if (!Array.isArray(opts.columns) || opts.columns.length === 0) {
    throw new DatabaseDriverError('At least one column is required for COPY import', 'invalid_params', 'postgres')
  }
  const schemaName = opts.schema
  const hasSchema = typeof schemaName === 'string' && schemaName.trim().length > 0
  const qTable = hasSchema
    ? `${quoteIdentForDialect(schemaName, 'postgres')}.${quoteIdentForDialect(opts.table, 'postgres')}`
    : quoteIdentForDialect(opts.table, 'postgres')
  const quotedCols = opts.columns
    .map((col) => {
      if (typeof col !== 'string' || col.length === 0) {
        throw new DatabaseDriverError('Column name cannot be empty for COPY import', 'invalid_params', 'postgres')
      }
      return quoteIdentForDialect(col, 'postgres')
    })
    .join(', ')
  const sql = `COPY ${qTable} (${quotedCols}) FROM STDIN WITH (FORMAT csv, HEADER false, DELIMITER ',', QUOTE '"', ESCAPE '"', NULL '')`
  assertSafePostgresCopySql(sql)
  return sql
}

/**
 * Strips standalone `\.` end-of-copy marker lines for PostgreSQL 18 CSV compatibility.
 */
export function stripPgCopyEofLines(csvText: string): string {
  if (!csvText.includes('\\.')) return csvText
  return csvText.replace(/^\\\.(?:\r?\n|$)/gm, '')
}

/**
 * Formats a single cell value into PostgreSQL CSV format:
 * - `null` / `undefined` / non-finite numbers -> empty unquoted (`,,`)
 * - `""` (empty string) -> quoted (`,"",`)
 * - literal `\.` -> quoted (`"\."`) so it cannot trigger legacy EOF handling
 */
export function formatCsvCellValue(
  value: unknown,
  context?: { rowIndex?: number; colIndex?: number; columnName?: string }
): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'bigint') return value.toString()

  let str: string
  if (typeof value === 'string') {
    str = value
  } else if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return ''
    str = value.toISOString()
  } else if (value instanceof Uint8Array) {
    return `\\x${Buffer.from(value).toString('hex')}`
  } else if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    return `\\x${Buffer.from(view).toString('hex')}`
  } else if (value instanceof ArrayBuffer) {
    return `\\x${Buffer.from(value).toString('hex')}`
  } else if (typeof value === 'object') {
    str = JSON.stringify(value)
  } else {
    str = String(value)
  }

  if (str.includes('\0')) {
    const location =
      context?.rowIndex !== undefined && context?.colIndex !== undefined
        ? ` at row ${context.rowIndex}, column ${context.colIndex}${context.columnName ? ` ("${context.columnName}")` : ''}`
        : ''
    throw new DatabaseDriverError(
      `COPY value${location} contains a NUL (\\0) byte, which is not permitted in PostgreSQL CSV COPY.`,
      'INVALID_COPY_VALUE',
      'postgres'
    )
  }

  if (str === '') return '""'
  if (str === '\\.' || /[,"\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/**
 * Splits a UTF-8 Buffer into chunks of at most `maxBytes` without splitting
 * multi-byte UTF-8 character sequences.
 */
export function sliceUtf8SafeBuffer(buf: Buffer, maxBytes = COPY_PIECE_BYTES): Buffer[] {
  if (buf.byteLength === 0) return []
  if (buf.byteLength <= maxBytes) return [buf]
  const limit = Math.max(4, maxBytes)
  const pieces: Buffer[] = []
  let offset = 0
  while (offset < buf.byteLength) {
    if (buf.byteLength - offset <= limit) {
      pieces.push(buf.subarray(offset))
      break
    }
    let end = offset + limit
    while (end > offset && (buf[end] & 0b1100_0000) === 0b1000_0000) {
      end -= 1
    }
    if (end === offset) {
      end = offset + limit
    }
    pieces.push(buf.subarray(offset, end))
    offset = end
  }
  return pieces
}

function streamNeedsDrain(stream: PgCopyWireStream | undefined): boolean {
  if (!stream) return false
  if (stream.writableNeedDrain === true) return true
  return (
    typeof stream.writableLength === 'number' &&
    typeof stream.writableHighWaterMark === 'number' &&
    stream.writableHighWaterMark > 0 &&
    stream.writableLength >= stream.writableHighWaterMark
  )
}

function extractPgCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const val = Reflect.get(err, 'code')
    return typeof val === 'string' ? val : ''
  }
  return ''
}

function toCopyError(err: unknown, fallback: string): DatabaseDriverError {
  if (err instanceof DatabaseDriverError) return err
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : fallback
  const code = extractPgCode(err) || 'COPY_ERROR'
  return new DatabaseDriverError(msg || fallback, code, 'postgres', err)
}

type CopyStreamState = 'init' | 'opening' | 'streaming' | 'committing' | 'committed' | 'aborted' | 'failed'

export class PostgresCopyInStream {
  readonly supported = true
  private readonly client: PgCopyQueryableClient
  private readonly columns: readonly string[]
  private readonly copySql: string
  private readonly signal?: AbortSignal
  private readonly idleTimeoutMs: number
  private readonly drainTimeoutMs: number
  private readonly readyForQueryTimeoutMs: number
  private readonly onIdleTimeout?: (stream: PostgresCopyInStream) => Promise<void> | void

  private connection: PgCopyWireConnection | null = null
  private state: CopyStreamState = 'init'
  private copyInEntered = false
  private abortInitiated = false
  private abortedBeforeCopyIn = false
  private commitQueued = false
  private cancelReason = 'COPY import was cancelled'
  private bytesWritten = 0
  private rowsWritten = 0
  private serverInsertedCount: number | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private abortCleanupPromise: Promise<void> | null = null
  private writeOpQueue: Promise<void> = Promise.resolve()
  private readonly queuedOpRejectors = new Set<(err: unknown) => void>()
  private openResolve: (() => void) | null = null
  private openReject: ((err: unknown) => void) | null = null
  private openPreCopyAbortResolve: (() => void) | null = null
  private commitResolve: ((inserted: number) => void) | null = null
  private commitReject: ((err: unknown) => void) | null = null
  private backpressureReject: ((err: unknown) => void) | null = null
  private abortSignalHandler: (() => void) | null = null

  constructor(client: PgCopyQueryableClient, opts: PostgresCopyInStreamOptions) {
    this.client = client
    this.columns = [...opts.columns]
    this.copySql = buildPostgresCopyFromStdinSql(opts)
    this.signal = opts.signal
    this.idleTimeoutMs = Math.max(50, opts.idleTimeoutMs ?? DEFAULT_COPY_IDLE_TIMEOUT_MS)
    this.drainTimeoutMs = Math.max(50, opts.drainTimeoutMs ?? DEFAULT_COPY_DRAIN_TIMEOUT_MS)
    this.readyForQueryTimeoutMs = Math.max(50, opts.readyForQueryTimeoutMs ?? DEFAULT_COPY_RFQ_TIMEOUT_MS)
    this.onIdleTimeout = opts.onIdleTimeout
  }

  isOpen(): boolean {
    return this.state === 'opening' || this.state === 'streaming' || this.state === 'committing'
  }

  getConnection(): PgCopyWireConnection | null {
    return this.connection
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer()
    if (this.state !== 'streaming') return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.state !== 'streaming') return
      const hook = this.onIdleTimeout
      if (hook) {
        void Promise.resolve(hook(this)).catch(() => {})
      } else {
        void this.abortWithCleanup('COPY stream idle timeout exceeded (>30s)').catch(() => {})
      }
    }, this.idleTimeoutMs)
    if (typeof this.idleTimer.unref === 'function') {
      this.idleTimer.unref()
    }
  }

  private detachSignal(): void {
    if (this.signal && this.abortSignalHandler) {
      this.signal.removeEventListener('abort', this.abortSignalHandler)
      this.abortSignalHandler = null
    }
  }

  // Submittable interface consumed by pg@8.23.1 Client
  submit(connection: PgCopyWireConnection): void {
    this.connection = connection
    connection.query(this.copySql)
  }

  handleCopyInResponse(connection: PgCopyWireConnection): void {
    this.copyInEntered = true
    this.connection = connection
    if (this.abortInitiated) {
      if (this.openPreCopyAbortResolve) {
        const wake = this.openPreCopyAbortResolve
        this.openPreCopyAbortResolve = null
        wake()
      } else {
        // Abort occurred while waiting for CopyInResponse: send CopyFail and wait for ReadyForQuery
        void this.abortWithCleanup(this.cancelReason)
      }
      return
    }
    if (this.state !== 'opening') return
    this.state = 'streaming'
    this.armIdleTimer()
    const resolve = this.openResolve
    this.openResolve = null
    this.openReject = null
    resolve?.()
  }

  handleCopyData(_msg: unknown, _connection: PgCopyWireConnection): void {
    // No-op for COPY FROM STDIN
  }

  handleCommandComplete(msg: { text?: string }, _connection: PgCopyWireConnection): void {
    const text = typeof msg?.text === 'string' ? msg.text : ''
    const match = /^COPY\s+(\d+)/i.exec(text.trim())
    if (match && match[1]) {
      const parsed = Number(match[1])
      if (Number.isFinite(parsed)) {
        this.serverInsertedCount = parsed
      }
    }
  }

  handleEmptyQuery(_connection: PgCopyWireConnection): void {
    // No-op
  }

  handleReadyForQuery(_connection: PgCopyWireConnection): void {
    if (this.state === 'committing') {
      this.clearIdleTimer()
      this.detachSignal()
      if (this.abortInitiated || this.signal?.aborted) {
        this.state = 'aborted'
        const reject = this.commitReject
        this.commitResolve = null
        this.commitReject = null
        reject?.(new DatabaseDriverError(this.cancelReason, 'cancelled', 'postgres'))
        return
      }
      this.state = 'committed'
      const resolve = this.commitResolve
      this.commitResolve = null
      this.commitReject = null
      resolve?.(this.serverInsertedCount ?? this.rowsWritten)
    }
  }

  handleError(err: unknown, connection: PgCopyWireConnection): void {
    this.clearIdleTimer()
    if (!this.copyInEntered) {
      // Wait for ReadyForQuery before rejecting open() so the pg.Client stays healthy
      this.waitForReadyForQuery(connection, this.readyForQueryTimeoutMs)
        .catch(() => {})
        .finally(() => {
          this.state = 'failed'
          this.detachSignal()
          const reject = this.openReject
          this.openResolve = null
          this.openReject = null
          reject?.(err)
        })
      return
    }

    if (this.abortInitiated) {
      // Suppress server's CopyFail ErrorResponse echo; caller receives user cancellation error
      return
    }

    this.state = 'failed'
    this.detachSignal()
    const wrapped = toCopyError(err, 'PostgreSQL COPY IN failed')
    if (this.backpressureReject) {
      const rejectBp = this.backpressureReject
      this.backpressureReject = null
      rejectBp(wrapped)
    }
    if (this.commitReject) {
      const reject = this.commitReject
      this.commitResolve = null
      this.commitReject = null
      reject(wrapped)
    }
  }

  async open(): Promise<void> {
    if (this.state !== 'init') {
      throw new DatabaseDriverError('COPY stream has already been opened', 'INVALID_STATE', 'postgres')
    }
    if (this.signal?.aborted) {
      throw new DatabaseDriverError('COPY import was cancelled', 'cancelled', 'postgres')
    }

    this.state = 'opening'
    await new Promise<void>((resolve, reject) => {
      this.openResolve = resolve
      this.openReject = reject

      if (this.signal) {
        const onAbort = (): void => {
          this.abortInitiated = true
          this.cancelReason = 'COPY import was cancelled'
          void this.abortWithCleanup(this.cancelReason)
            .catch(() => {})
            .finally(() => {
              if (this.openReject) {
                const rej = this.openReject
                this.openResolve = null
                this.openReject = null
                rej(new DatabaseDriverError(this.cancelReason, 'cancelled', 'postgres'))
              }
            })
        }
        this.abortSignalHandler = onAbort
        this.signal.addEventListener('abort', onAbort, { once: true })
      }

      this.client.query(this)
    })

    if (this.signal?.aborted) {
      await this.abortWithCleanup('COPY import was cancelled')
      throw new DatabaseDriverError('COPY import was cancelled', 'cancelled', 'postgres')
    }
  }

  private waitForBackpressure(stream: PgCopyWireStream): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null

      const cleanup = (): void => {
        if (this.backpressureReject === rejectWith) {
          this.backpressureReject = null
        }
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        detachListener(stream, 'drain', onDrain)
        detachListener(stream, 'error', onError)
        detachListener(stream, 'close', onClose)
        if (this.signal) {
          this.signal.removeEventListener('abort', onAbort)
        }
      }

      const rejectWith = (err: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(err)
      }
      this.backpressureReject = rejectWith

      const onDrain = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }

      const onError = (err: unknown): void => {
        rejectWith(toCopyError(err, 'Stream error during COPY backpressure'))
      }

      const onClose = (): void => {
        rejectWith(new DatabaseDriverError('Stream closed during COPY backpressure', 'SOCKET_CLOSED', 'postgres'))
      }

      const onAbort = (): void => {
        rejectWith(new DatabaseDriverError('COPY import was cancelled', 'cancelled', 'postgres'))
      }

      timer = setTimeout(() => {
        rejectWith(new DatabaseDriverError('Timed out waiting for socket drain during COPY', 'TIMEOUT', 'postgres'))
      }, this.drainTimeoutMs)

      stream.once('drain', onDrain)
      stream.once('error', onError)
      stream.once('close', onClose)
      if (this.signal) {
        if (this.signal.aborted) {
          onAbort()
          return
        }
        this.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  private waitForReadyForQuery(
    connection: PgCopyWireConnection,
    timeoutMs: number
  ): Promise<{ timedOut: boolean }> {
    return new Promise<{ timedOut: boolean }>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null

      const cleanup = (): void => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        detachListener(connection, 'readyForQuery', onRfq)
        detachListener(connection, 'error', onDisconnect)
        detachListener(connection, 'end', onDisconnect)
      }

      const onRfq = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve({ timedOut: false })
      }

      const onDisconnect = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve({ timedOut: true })
      }

      timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        resolve({ timedOut: true })
      }, timeoutMs)

      connection.once('readyForQuery', onRfq)
      connection.once('error', onDisconnect)
      connection.once('end', onDisconnect)
    })
  }

  private async writeWirePiece(piece: Buffer): Promise<void> {
    const conn = this.connection
    if (!conn || this.state !== 'streaming') {
      throw new DatabaseDriverError('COPY stream is not active', 'INVALID_STATE', 'postgres')
    }
    if (this.signal?.aborted || this.abortInitiated) {
      throw new DatabaseDriverError(this.cancelReason, 'cancelled', 'postgres')
    }
    conn.sendCopyFromChunk(piece)
    this.bytesWritten += piece.byteLength
    if (streamNeedsDrain(conn.stream)) {
      if (conn.stream) {
        await this.waitForBackpressure(conn.stream)
      }
    }
  }

  private enqueueWriteOp<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let cancelledByAbort = false
      const rejectFromAbort = (err: unknown): void => {
        if (cancelledByAbort) return
        cancelledByAbort = true
        this.queuedOpRejectors.delete(rejectFromAbort)
        reject(err)
      }
      this.queuedOpRejectors.add(rejectFromAbort)

      const run = async (): Promise<void> => {
        this.queuedOpRejectors.delete(rejectFromAbort)
        if (cancelledByAbort) return
        if (this.signal?.aborted || this.abortInitiated) {
          throw new DatabaseDriverError(this.cancelReason, 'cancelled', 'postgres')
        }
        resolve(await fn())
      }

      const next = this.writeOpQueue.then(run)
      this.writeOpQueue = next.then(
        () => undefined,
        () => undefined
      )
      next.catch((err: unknown) => {
        if (!cancelledByAbort) {
          reject(err)
        }
      })
    })
  }

  async writeRows(
    rows: Array<Record<string, unknown> | unknown[]>
  ): Promise<{ bytesWritten: number; rowCount: number }> {
    if (this.signal?.aborted || this.abortInitiated) {
      await this.abortWithCleanup('COPY import was cancelled')
      throw new DatabaseDriverError('COPY import was cancelled', 'cancelled', 'postgres')
    }
    if (this.commitQueued || this.state !== 'streaming') {
      throw new DatabaseDriverError('COPY stream is not open for writing', 'INVALID_STATE', 'postgres')
    }

    return this.enqueueWriteOp(async () => {
      if (this.signal?.aborted || this.abortInitiated) {
        await this.abortWithCleanup('COPY import was cancelled')
        throw new DatabaseDriverError('COPY import was cancelled', 'cancelled', 'postgres')
      }
      if (this.state !== 'streaming') {
        throw new DatabaseDriverError('COPY stream is not open for writing', 'INVALID_STATE', 'postgres')
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        this.armIdleTimer()
        return { bytesWritten: 0, rowCount: 0 }
      }

      this.clearIdleTimer()
      const startBytes = this.bytesWritten
      let chunkLines: string[] = []
      let chunkByteLen = 0
      let batchRows = 0

      const flushLines = async (): Promise<void> => {
        if (chunkLines.length === 0) return
        // formatCsvCellValue() already quotes standalone \. cells; never strip \. inside multiline CSV cells
        const payload = chunkLines.join('')
        chunkLines = []
        chunkByteLen = 0
        if (payload.length === 0) return
        const buf = Buffer.from(payload, 'utf8')
        for (const piece of sliceUtf8SafeBuffer(buf, COPY_PIECE_BYTES)) {
          await this.writeWirePiece(piece)
        }
      }

      try {
        for (const row of rows) {
          if (this.signal?.aborted || this.abortInitiated) {
            throw new DatabaseDriverError('COPY import was cancelled', 'cancelled', 'postgres')
          }
          const rowIndex = this.rowsWritten + 1
          const cells = Array.isArray(row)
            ? this.columns.map((col, idx) =>
                formatCsvCellValue(row[idx], { rowIndex, colIndex: idx + 1, columnName: col })
              )
            : this.columns.map((col, idx) =>
                formatCsvCellValue(row[col], { rowIndex, colIndex: idx + 1, columnName: col })
              )
          const line = `${cells.join(',')}\n`
          const lineBytes = Buffer.byteLength(line, 'utf8')

          if (chunkLines.length > 0 && chunkByteLen + lineBytes > COPY_PIECE_BYTES) {
            await flushLines()
          }

          if (lineBytes > COPY_PIECE_BYTES) {
            await flushLines()
            const lineBuf = Buffer.from(line, 'utf8')
            for (const piece of sliceUtf8SafeBuffer(lineBuf, COPY_PIECE_BYTES)) {
              await this.writeWirePiece(piece)
            }
          } else {
            chunkLines.push(line)
            chunkByteLen += lineBytes
          }
          batchRows += 1
          this.rowsWritten += 1
        }
        await flushLines()
        this.armIdleTimer()
        return {
          bytesWritten: this.bytesWritten - startBytes,
          rowCount: batchRows,
        }
      } catch (err: unknown) {
        if (err instanceof DatabaseDriverError && err.code === 'cancelled') {
          await this.abortWithCleanup(err.message)
        }
        throw err
      }
    })
  }

  async commit(): Promise<{ inserted: number }> {
    if (this.signal?.aborted || this.abortInitiated) {
      await this.abortWithCleanup('COPY import was cancelled')
      throw new DatabaseDriverError('COPY import was cancelled', 'cancelled', 'postgres')
    }
    if (this.commitQueued || this.state !== 'streaming' || !this.connection) {
      throw new DatabaseDriverError('COPY stream is not open for commit', 'INVALID_STATE', 'postgres')
    }
    this.commitQueued = true

    return this.enqueueWriteOp(async () => {
      if (this.signal?.aborted || this.abortInitiated) {
        await this.abortWithCleanup('COPY import was cancelled')
        throw new DatabaseDriverError('COPY import was cancelled', 'cancelled', 'postgres')
      }
      if (this.state !== 'streaming' || !this.connection) {
        throw new DatabaseDriverError('COPY stream is not open for commit', 'INVALID_STATE', 'postgres')
      }

      this.clearIdleTimer()
      this.state = 'committing'
      const conn = this.connection

      return await new Promise<{ inserted: number }>((resolve, reject) => {
        let settled = false
        let rfqTimer: ReturnType<typeof setTimeout> | null = null
        const cleanupExtra = (): void => {
          if (rfqTimer !== null) {
            clearTimeout(rfqTimer)
            rfqTimer = null
          }
          detachListener(conn, 'error', onError)
          detachListener(conn, 'end', onEnd)
        }
        const failCommit = (err: unknown): void => {
          if (settled) return
          settled = true
          cleanupExtra()
          this.commitResolve = null
          this.commitReject = null
          reject(err)
        }
        const onError = (err: unknown): void => {
          failCommit(toCopyError(err, 'COPY commit failed'))
        }
        const onEnd = (): void => {
          failCommit(new DatabaseDriverError('Connection closed during COPY commit', 'SOCKET_CLOSED', 'postgres'))
        }

        rfqTimer = setTimeout(() => {
          if (settled) return
          settled = true
          cleanupExtra()
          this.commitResolve = null
          this.commitReject = null
          this.state = 'failed'
          this.detachSignal()
          if (conn.stream && !conn.stream.destroyed && typeof conn.stream.destroy === 'function') {
            conn.stream.destroy()
          }
          reject(
            new DatabaseDriverError(
              `Timed out waiting for PostgreSQL ReadyForQuery after COPY commit (${this.readyForQueryTimeoutMs}ms)`,
              'TIMEOUT',
              'postgres'
            )
          )
        }, this.readyForQueryTimeoutMs)

        this.commitResolve = (inserted: number) => {
          if (settled) return
          settled = true
          cleanupExtra()
          this.commitResolve = null
          this.commitReject = null
          resolve({ inserted })
        }
        this.commitReject = failCommit

        conn.once('error', onError)
        conn.once('end', onEnd)
        try {
          conn.endCopyFrom()
        } catch (err: unknown) {
          failCommit(toCopyError(err, 'COPY commit failed'))
        }
      })
    })
  }

  async abort(reason = 'COPY import was cancelled'): Promise<void> {
    await this.abortWithCleanup(reason)
  }

  wasAbortedBeforeCopyIn(): boolean {
    return this.abortedBeforeCopyIn
  }

  async abortWithCleanup(
    reason = 'COPY import was cancelled',
    hooks?: { onReadyForQueryTimeout?: () => void }
  ): Promise<void> {
    if (this.abortCleanupPromise) {
      return this.abortCleanupPromise
    }
    if (this.state === 'committed' || this.state === 'aborted') {
      return
    }

    this.abortInitiated = true
    this.cancelReason = reason
    if (!this.copyInEntered) {
      this.abortedBeforeCopyIn = true
    }
    this.clearIdleTimer()
    this.detachSignal()
    const cancelErr = new DatabaseDriverError(reason, 'cancelled', 'postgres')
    if (this.openReject) {
      const rejOpen = this.openReject
      this.openResolve = null
      this.openReject = null
      rejOpen(cancelErr)
    }
    if (this.backpressureReject) {
      const rejectBp = this.backpressureReject
      this.backpressureReject = null
      rejectBp(cancelErr)
    }
    for (const rejQueued of Array.from(this.queuedOpRejectors)) {
      rejQueued(cancelErr)
    }
    this.queuedOpRejectors.clear()

    this.abortCleanupPromise = (async () => {
      const conn = this.connection
      if (conn && this.state === 'opening' && !this.copyInEntered) {
        const preCopyWait = new Promise<'copyIn'>((resolve) => {
          this.openPreCopyAbortResolve = () => resolve('copyIn')
        })
        const rfqPromise = this.waitForReadyForQuery(conn, Math.min(this.readyForQueryTimeoutMs, 500)).then(
          (res) => ({ kind: 'rfq' as const, timedOut: res.timedOut })
        )
        const outcome = await Promise.race([
          preCopyWait.then(() => ({ kind: 'copyIn' as const, timedOut: false })),
          rfqPromise,
        ])
        this.openPreCopyAbortResolve = null
        if (outcome.kind === 'rfq' && outcome.timedOut && !this.copyInEntered) {
          hooks?.onReadyForQueryTimeout?.()
          if (conn.stream && !conn.stream.destroyed && typeof conn.stream.destroy === 'function') {
            conn.stream.destroy()
          }
          this.state = 'aborted'
          return
        }
      }

      const wasCommitting = this.state === 'committing'
      if (conn && this.copyInEntered && (this.state === 'streaming' || this.state === 'committing' || this.state === 'opening')) {
        const rfqPromise = this.waitForReadyForQuery(conn, this.readyForQueryTimeoutMs)
        if (!wasCommitting) {
          try {
            // Simple Query COPY IN emits a single ReadyForQuery on CopyFail; never emit redundant Sync
            conn.sendCopyFail(reason)
          } catch {
            // Ignore send errors on an already-broken socket
          }
        }
        const { timedOut } = await rfqPromise
        if (timedOut) {
          hooks?.onReadyForQueryTimeout?.()
          if (conn.stream && !conn.stream.destroyed && typeof conn.stream.destroy === 'function') {
            conn.stream.destroy()
          }
        }
      }
      if (this.commitReject) {
        const rejCommit = this.commitReject
        this.commitResolve = null
        this.commitReject = null
        rejCommit(cancelErr)
      }
      this.state = 'aborted'
    })()

    return this.abortCleanupPromise
  }
}

export async function openPostgresCopyInStream(
  client: PgCopyQueryableClient,
  opts: PostgresCopyInStreamOptions
): Promise<PostgresCopyInStream> {
  const stream = new PostgresCopyInStream(client, opts)
  await stream.open()
  return stream
}
