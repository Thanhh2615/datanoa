import {
  BSONRegExp,
  Binary,
  Code,
  Decimal128,
  Double,
  EJSON,
  Int32,
  Long,
  MaxKey,
  MinKey,
  MongoClient,
  ObjectId,
  Timestamp,
  UUID,
  type AggregationCursor,
  type ClientSession,
  type Collection,
  type Db,
  type Document,
  type FindCursor,
  type MongoClientOptions,
} from '../../../vendor/mongodb.js'
import {
  maskConnectionUriSecret,
  scanSecretValueSpan,
} from '../../shared-sql-safety.js'
import type {
  ApplyChangesParams,
  ApplyChangesResult,
  ColumnInfo,
  ConnectionProfile,
  FetchPageParams,
  IDatabaseDriver,
  IDatabaseSession,
  IndexInfo,
  PreviewChangesResult,
  QueryResult,
  QueryResultSet,
  SchemaObject,
  SchemaObjectKind,
  TableBrowseResult,
  TableDetails,
  TransactionState,
  UpdateCellParams,
  UpdateCellResult,
} from '../common/driver'
import { DatabaseDriverError, runDriverConnectionTest } from '../common/driver'
import { TableDetailsCache } from '../common/schema'
import type { DriverTlsOptions } from '../common/tls-and-tunnel'
import { resolveEffectiveTlsOptions } from '../common/tls-and-tunnel'

export interface MongoCursorLike {
  sort(sort: Record<string, unknown>): MongoCursorLike
  skip(value: number): MongoCursorLike
  limit(value: number): MongoCursorLike
  project(value: Record<string, unknown>): MongoCursorLike
  explain?: (verbosity?: string) => Promise<unknown>
  toArray(): Promise<Record<string, unknown>[]>
  close?: () => Promise<void>
}

export interface MongoAggregateCursorLike {
  explain?: (verbosity?: string) => Promise<unknown>
  toArray(): Promise<Record<string, unknown>[]>
  close?: () => Promise<void>
}

export interface MongoCollectionLike {
  collectionName: string
  find(filter?: Record<string, unknown>, options?: Record<string, unknown>): MongoCursorLike
  findOne(filter?: Record<string, unknown>, options?: Record<string, unknown>): Promise<Record<string, unknown> | null>
  countDocuments(filter?: Record<string, unknown>, options?: Record<string, unknown>): Promise<number>
  estimatedDocumentCount(options?: Record<string, unknown>): Promise<number>
  indexes(options?: Record<string, unknown>): Promise<Record<string, unknown>[]>
  aggregate(pipeline?: Record<string, unknown>[], options?: Record<string, unknown>): MongoAggregateCursorLike
  distinct(key: string, filter?: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown[]>
  insertOne(doc: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ acknowledged?: boolean; insertedId?: unknown }>
  insertMany(docs: Record<string, unknown>[], options?: Record<string, unknown>): Promise<{ acknowledged?: boolean; insertedCount?: number; insertedIds?: Record<number, unknown> }>
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ acknowledged?: boolean; matchedCount?: number; modifiedCount?: number; upsertedCount?: number }>
  updateMany(filter: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ acknowledged?: boolean; matchedCount?: number; modifiedCount?: number }>
  replaceOne(filter: Record<string, unknown>, replacement: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ acknowledged?: boolean; matchedCount?: number; modifiedCount?: number }>
  deleteOne(filter: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ acknowledged?: boolean; deletedCount?: number }>
  deleteMany(filter: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ acknowledged?: boolean; deletedCount?: number }>
  findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>
  findOneAndDelete(filter: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>
  createIndex(indexSpec: Record<string, unknown>, options?: Record<string, unknown>): Promise<string>
  dropIndex(indexName: string, options?: Record<string, unknown>): Promise<unknown>
  dropIndexes?: (options?: Record<string, unknown>) => Promise<unknown>
  drop(options?: Record<string, unknown>): Promise<boolean>
  rename(newName: string, options?: Record<string, unknown>): Promise<unknown>
}

export interface MongoAdminLike {
  listDatabases(): Promise<{ databases: Array<{ name: string; sizeOnDisk?: number; empty?: boolean }> }>
  command(cmd: Record<string, unknown>, options?: Record<string, unknown>): Promise<Record<string, unknown>>
  serverStatus?: () => Promise<Record<string, unknown>>
}

export interface MongoDbLike {
  databaseName: string
  admin(): MongoAdminLike
  command(cmd: Record<string, unknown>, options?: Record<string, unknown>): Promise<Record<string, unknown>>
  listCollections(filter?: Record<string, unknown>, options?: Record<string, unknown>): { toArray(): Promise<Array<{ name: string; type?: string; options?: Record<string, unknown> }>> }
  collection(name: string): MongoCollectionLike
  createCollection(name: string, options?: Record<string, unknown>): Promise<unknown>
  stats?(options?: Record<string, unknown>): Promise<Record<string, unknown>>
}

export interface MongoClientSessionLike {
  inTransaction(): boolean
  startTransaction(): void
  commitTransaction(): Promise<void>
  abortTransaction(): Promise<void>
  withTransaction<T>(fn: () => Promise<T>): Promise<T>
  endSession(): Promise<void>
}

export interface MongoClientLike {
  connect(): Promise<unknown>
  close(force?: boolean): Promise<void>
  db(dbName?: string): MongoDbLike
  startSession(): MongoClientSessionLike
}

export type MongoClientFactory = (uri: string, options: MongoClientOptions) => MongoClientLike

const HEX_24_RE = /^[0-9a-f]{24}$/i
const SCHEMA_SAMPLE_LIMIT = 50
const EJSON_WRAPPER_KEYS: ReadonlySet<string> = new Set([
  '$oid',
  '$date',
  '$numberDecimal',
  '$numberLong',
  '$numberInt',
  '$numberDouble',
  '$binary',
  '$uuid',
  '$timestamp',
  '$regularExpression',
  '$minKey',
  '$maxKey',
  '$code',
])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function getBsonTag(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const tag = Reflect.get(value, '_bsontype')
  return typeof tag === 'string' ? tag : undefined
}

function isBsonInstance(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof ObjectId ||
    value instanceof Decimal128 ||
    value instanceof Long ||
    value instanceof Binary ||
    value instanceof UUID ||
    value instanceof Int32 ||
    value instanceof Double ||
    value instanceof Timestamp ||
    value instanceof MinKey ||
    value instanceof MaxKey ||
    value instanceof BSONRegExp ||
    value instanceof Code ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer
  ) {
    return true
  }
  return getBsonTag(value) !== undefined
}

export function detectBsonTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'Null'
  if (typeof value === 'string') return 'String'
  if (typeof value === 'boolean') return 'Boolean'
  if (typeof value === 'bigint') return 'Long'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'Double'
    return Number.isInteger(value) ? 'Int32' : 'Double'
  }
  if (value instanceof Date) return 'Date'
  if (value instanceof RegExp || value instanceof BSONRegExp) return 'BSONRegExp'
  if (value instanceof ObjectId) return 'ObjectId'
  if (value instanceof Decimal128) return 'Decimal128'
  if (value instanceof Timestamp) return 'Timestamp'
  if (value instanceof Long) return 'Long'
  if (value instanceof UUID) return 'UUID'
  if (value instanceof Binary) return value.sub_type === 4 && value.position === 16 ? 'UUID' : 'Binary'
  if (value instanceof Int32) return 'Int32'
  if (value instanceof Double) return 'Double'
  if (value instanceof MinKey) return 'MinKey'
  if (value instanceof MaxKey) return 'MaxKey'
  if (value instanceof Code) return 'Code'
  if (Array.isArray(value)) return 'Array'
  const bsonTag = getBsonTag(value)
  if (bsonTag) return bsonTag
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return 'Binary'
  return 'Object'
}

export function serializeMongoValue(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') {
    const num = Number(value)
    return Number.isSafeInteger(num) ? num : value.toString()
  }
  if (typeof value !== 'object') {
    return null
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (value instanceof ObjectId || getBsonTag(value) === 'ObjectId') {
    const hex = Reflect.get(value, 'toHexString')
    return typeof hex === 'function' ? String(hex.call(value)) : String(value)
  }
  if (value instanceof Decimal128 || getBsonTag(value) === 'Decimal128') {
    return String(value)
  }
  if (value instanceof Timestamp || getBsonTag(value) === 'Timestamp') {
    const highFn = Reflect.get(value, 'getHighBits')
    const lowFn = Reflect.get(value, 'getLowBits')
    if (typeof highFn === 'function' && typeof lowFn === 'function') {
      return {
        $timestamp: {
          t: Number(highFn.call(value)) >>> 0,
          i: Number(lowFn.call(value)) >>> 0,
        },
      }
    }
    return EJSON.serialize(value, { relaxed: false })
  }
  if (value instanceof Long || getBsonTag(value) === 'Long') {
    const toNum = Reflect.get(value, 'toNumber')
    const strVal = String(value)
    if (typeof toNum === 'function') {
      const n = Number(toNum.call(value))
      if (Number.isSafeInteger(n)) return n
    }
    return strVal
  }
  if (value instanceof Int32 || getBsonTag(value) === 'Int32') {
    const v = Reflect.get(value, 'valueOf')
    return typeof v === 'function' ? Number(v.call(value)) : Number(value)
  }
  if (value instanceof Double || getBsonTag(value) === 'Double') {
    const v = Reflect.get(value, 'valueOf')
    const num = typeof v === 'function' ? Number(v.call(value)) : Number(value)
    return Number.isFinite(num) ? num : null
  }
  if (value instanceof UUID || getBsonTag(value) === 'UUID') {
    return String(value)
  }
  if (value instanceof Binary || getBsonTag(value) === 'Binary') {
    const subTypeRaw = Reflect.get(value, 'sub_type')
    const subType = typeof subTypeRaw === 'number' ? subTypeRaw : 0
    const bufProp = Reflect.get(value, 'buffer')
    const lenProp = Reflect.get(value, 'position')
    const bytes =
      bufProp instanceof Uint8Array
        ? bufProp.subarray(0, typeof lenProp === 'number' ? lenProp : bufProp.length)
        : Buffer.alloc(0)
    if (subType === 4 && bytes.byteLength === 16) {
      return new UUID(bytes).toString()
    }
    return {
      $binary: {
        base64: Buffer.from(bytes).toString('base64'),
        subType: subType.toString(16).padStart(2, '0'),
      },
    }
  }
  if (value instanceof BSONRegExp || getBsonTag(value) === 'BSONRegExp') {
    const pattern = String(Reflect.get(value, 'pattern') ?? '')
    const options = String(Reflect.get(value, 'options') ?? '')
    return `/${pattern}/${options}`
  }
  if (value instanceof RegExp) {
    return `/${value.source}/${value.flags}`
  }
  if (value instanceof MinKey || getBsonTag(value) === 'MinKey') {
    return { $minKey: 1 }
  }
  if (value instanceof MaxKey || getBsonTag(value) === 'MaxKey') {
    return { $maxKey: 1 }
  }
  if (value instanceof Code || getBsonTag(value) === 'Code') {
    const code = String(Reflect.get(value, 'code') ?? '')
    const scope = Reflect.get(value, 'scope')
    return scope ? { $code: code, $scope: serializeMongoValue(scope) } : { $code: code }
  }
  if (value instanceof ArrayBuffer) {
    return {
      $binary: {
        base64: Buffer.from(new Uint8Array(value)).toString('base64'),
        subType: '00',
      },
    }
  }
  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    return {
      $binary: {
        base64: Buffer.from(view).toString('base64'),
        subType: '00',
      },
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeMongoValue(item))
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined && typeof v !== 'function' && typeof v !== 'symbol') {
      out[k] = serializeMongoValue(v)
    }
  }
  return out
}

export function serializeMongoDocument(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(doc)) {
    if (v !== undefined && typeof v !== 'function' && typeof v !== 'symbol') {
      out[k] = serializeMongoValue(v)
    }
  }
  return out
}

export function formatMongoEjsonString(value: unknown): string {
  return EJSON.stringify(value, { relaxed: false })
}

export function hydrateEjsonValues(node: unknown): unknown {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (isBsonInstance(node)) return node
  if (Array.isArray(node)) return node.map((item) => hydrateEjsonValues(item))
  if (!isPlainRecord(node)) return node
  const keys = Object.keys(node)
  if (keys.length > 0 && EJSON_WRAPPER_KEYS.has(keys[0])) {
    try {
      return EJSON.deserialize(node, { relaxed: false })
    } catch {
      // Fall through to plain object traversal if malformed EJSON wrapper
    }
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === '__proto__') continue
    out[k] = hydrateEjsonValues(v)
  }
  return out
}

// ============================================================================
// Safe Zero-Eval Recursive-Descent Relaxed JSON / Mongo Shell Value Parser
// ============================================================================

function parseBinDataArgs(subTypeArg: unknown, base64Arg: unknown): Binary {
  let subType: number
  if (typeof subTypeArg === 'string') {
    const cleaned = subTypeArg.startsWith('0x') || subTypeArg.startsWith('0X')
      ? subTypeArg.slice(2)
      : subTypeArg
    subType = parseInt(cleaned, 16)
  } else {
    subType = Number(subTypeArg)
  }
  if (!Number.isInteger(subType) || subType < 0 || subType > 255) {
    throw new Error(`Invalid BinData subType: ${String(subTypeArg)}`)
  }
  if (typeof base64Arg !== 'string') {
    throw new Error('BinData requires a base64 string as second argument')
  }
  return new Binary(Buffer.from(base64Arg, 'base64'), subType)
}

function invokeMongoHelper(name: string, args: unknown[]): unknown {
  switch (name) {
    case 'ObjectId':
    case 'ObjectId.createFromHexString': {
      if (args.length === 0) return new ObjectId()
      const arg = args[0]
      if (typeof arg !== 'string') throw new Error(`${name} requires a hex string`)
      return ObjectId.createFromHexString(arg)
    }
    case 'ISODate':
    case 'Date': {
      if (args.length === 0) return new Date()
      const arg = args[0]
      if (typeof arg !== 'string' && typeof arg !== 'number') {
        throw new Error(`${name} requires a date string or timestamp`)
      }
      const d = new Date(arg)
      if (Number.isNaN(d.getTime())) throw new Error(`Invalid date literal: ${String(arg)}`)
      return d
    }
    case 'Date.now':
      return Date.now()
    case 'NumberDecimal':
    case 'Decimal128':
    case 'Decimal128.fromString': {
      if (args.length === 0) throw new Error(`${name} requires a numeric string`)
      return Decimal128.fromString(String(args[0]))
    }
    case 'NumberLong':
    case 'Long':
    case 'Long.fromString':
    case 'Long.fromNumber': {
      if (args.length === 0) return Long.fromNumber(0)
      const arg = args[0]
      if (typeof arg === 'number') return Long.fromNumber(arg)
      return Long.fromString(String(arg))
    }
    case 'NumberInt':
    case 'Int32': {
      if (args.length === 0) return new Int32(0)
      const n = Number(args[0])
      if (!Number.isFinite(n)) throw new Error(`Invalid integer for ${name}: ${String(args[0])}`)
      return new Int32(Math.trunc(n))
    }
    case 'Double': {
      if (args.length === 0) return new Double(0)
      return new Double(Number(args[0]))
    }
    case 'UUID': {
      if (args.length === 0) return new UUID()
      return new UUID(String(args[0]))
    }
    case 'BinData':
      return parseBinDataArgs(args[0], args[1])
    case 'Binary':
    case 'Binary.createFromBase64': {
      const b64 = typeof args[0] === 'string' ? args[0] : ''
      const sub = args.length > 1 ? Number(args[1]) : 0
      return new Binary(Buffer.from(b64, 'base64'), Number.isInteger(sub) ? sub : 0)
    }
    case 'Timestamp': {
      if (args.length === 1 && isPlainRecord(args[0])) {
        return new Timestamp({
          t: Number(args[0].t ?? 0),
          i: Number(args[0].i ?? 0),
        })
      }
      const t = Number(args[0] ?? 0)
      const i = Number(args[1] ?? 0)
      return new Timestamp({ t, i })
    }
    case 'RegExp':
    case 'BSONRegExp':
      return new BSONRegExp(String(args[0] ?? ''), typeof args[1] === 'string' ? args[1] : '')
    case 'MinKey':
      return new MinKey()
    case 'MaxKey':
      return new MaxKey()
    case 'Code':
      return new Code(String(args[0] ?? ''), isPlainRecord(args[1]) ? args[1] : undefined)
    default:
      throw new Error(`Unsupported MongoDB helper function: ${name}`)
  }
}

export class MongoLiteralParser {
  private static readonly MAX_DEPTH = 128
  readonly input: string
  pos = 0
  private depth = 0

  constructor(input: string) {
    this.input = input
  }

  private withDepth<T>(fn: () => T): T {
    this.depth++
    if (this.depth > MongoLiteralParser.MAX_DEPTH) {
      this.depth--
      throw new Error(
        `MongoDB expression exceeds maximum nesting depth of ${MongoLiteralParser.MAX_DEPTH}`
      )
    }
    try {
      return fn()
    } finally {
      this.depth--
    }
  }

  skipTrivia(): void {
    const len = this.input.length
    while (this.pos < len) {
      const ch = this.input[this.pos]
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        this.pos++
        continue
      }
      if (ch === '/' && this.pos + 1 < len && this.input[this.pos + 1] === '/') {
        this.pos += 2
        while (this.pos < len && this.input[this.pos] !== '\n') this.pos++
        continue
      }
      if (ch === '/' && this.pos + 1 < len && this.input[this.pos + 1] === '*') {
        const end = this.input.indexOf('*/', this.pos + 2)
        if (end < 0) throw new Error('Unterminated block comment in MongoDB query')
        this.pos = end + 2
        continue
      }
      break
    }
  }

  peekChar(): string {
    this.skipTrivia()
    return this.input[this.pos] ?? ''
  }

  expectEnd(): void {
    this.skipTrivia()
    if (this.pos < this.input.length) {
      throw new Error(`Unexpected trailing token at position ${this.pos}: ${this.input.slice(this.pos, this.pos + 24)}`)
    }
  }

  parseValue(): unknown {
    this.skipTrivia()
    if (this.pos >= this.input.length) {
      throw new Error('Unexpected end of MongoDB expression')
    }
    const ch = this.input[this.pos]
    if (ch === '{') return this.parseObject()
    if (ch === '[') return this.parseArray()
    if (ch === '"' || ch === "'" || ch === '`') return this.parseString()
    if (ch === '/') return this.parseRegex()
    if (ch === '-' || (ch >= '0' && ch <= '9') || (ch === '.' && /[0-9]/.test(this.input[this.pos + 1] || ''))) {
      return this.parseNumberOrNegInfinity()
    }
    return this.parseKeywordOrHelper()
  }

  parseString(): string {
    const quote = this.input[this.pos]
    this.pos++
    let out = ''
    const len = this.input.length
    while (this.pos < len) {
      const ch = this.input[this.pos]
      if (quote === '`' && ch === '$' && this.input[this.pos + 1] === '{') {
        throw new Error('Template literal interpolation (${...}) is not supported')
      }
      if (ch === '\\') {
        this.pos++
        if (this.pos >= len) throw new Error('Unterminated string escape')
        const esc = this.input[this.pos++]
        switch (esc) {
          case 'n': out += '\n'; break
          case 'r': out += '\r'; break
          case 't': out += '\t'; break
          case 'b': out += '\b'; break
          case 'f': out += '\f'; break
          case '\\': out += '\\'; break
          case '"': out += '"'; break
          case "'": out += "'"; break
          case '`': out += '`'; break
          case '/': out += '/'; break
          case '0': out += '\0'; break
          case 'x': {
            const hex = this.input.slice(this.pos, this.pos + 2)
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error('Invalid hex escape in string')
            out += String.fromCharCode(parseInt(hex, 16))
            this.pos += 2
            break
          }
          case 'u': {
            if (this.input[this.pos] === '{') {
              const closeBrace = this.input.indexOf('}', this.pos + 1)
              if (closeBrace < 0) throw new Error('Invalid unicode escape in string')
              const hex = this.input.slice(this.pos + 1, closeBrace)
              if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error('Invalid unicode escape in string')
              out += String.fromCodePoint(parseInt(hex, 16))
              this.pos = closeBrace + 1
            } else {
              const hex = this.input.slice(this.pos, this.pos + 4)
              if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('Invalid unicode escape in string')
              out += String.fromCharCode(parseInt(hex, 16))
              this.pos += 4
            }
            break
          }
          default:
            out += esc
            break
        }
        continue
      }
      if (ch === quote) {
        this.pos++
        return out
      }
      out += ch
      this.pos++
    }
    throw new Error('Unterminated string literal')
  }

  private parseRegex(): BSONRegExp {
    this.pos++ // skip opening /
    let pattern = ''
    let inClass = false
    const len = this.input.length
    while (this.pos < len) {
      const ch = this.input[this.pos]
      if (ch === '\\') {
        if (this.pos + 1 >= len) throw new Error('Unterminated regex literal')
        pattern += ch + this.input[this.pos + 1]
        this.pos += 2
        continue
      }
      if (ch === '[') inClass = true
      else if (ch === ']' && inClass) inClass = false
      else if (ch === '/' && !inClass) {
        this.pos++
        let flags = ''
        while (this.pos < len && /[gimsuvy]/.test(this.input[this.pos])) {
          flags += this.input[this.pos++]
        }
        return new BSONRegExp(pattern, flags)
      } else if (ch === '\n' || ch === '\r') {
        throw new Error('Unterminated regex literal')
      }
      pattern += ch
      this.pos++
    }
    throw new Error('Unterminated regex literal')
  }

  private parseNumberOrNegInfinity(): number {
    if (this.input.startsWith('-Infinity', this.pos)) {
      const after = this.input[this.pos + 9] || ''
      if (!/[A-Za-z0-9_$]/.test(after)) {
        this.pos += 9
        return -Infinity
      }
    }
    const hexMatch = /^-?0[xX][0-9a-fA-F]+/.exec(this.input.slice(this.pos))
    if (hexMatch) {
      const raw = hexMatch[0]
      this.pos += raw.length
      return raw.startsWith('-') ? -Number(raw.slice(1)) : Number(raw)
    }
    const numMatch = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.input.slice(this.pos))
    if (!numMatch) {
      throw new Error(`Invalid number literal at position ${this.pos}`)
    }
    this.pos += numMatch[0].length
    const n = Number(numMatch[0])
    if (Number.isNaN(n)) {
      throw new Error(`Invalid numeric value: ${numMatch[0]}`)
    }
    return n
  }

  private parseIdentifierToken(): string {
    const start = this.pos
    const len = this.input.length
    while (this.pos < len && /[A-Za-z0-9_$]/.test(this.input[this.pos])) {
      this.pos++
    }
    if (this.pos === start) {
      throw new Error(`Unexpected token "${this.input[this.pos]}" at position ${this.pos}`)
    }
    return this.input.slice(start, this.pos)
  }

  private parseKeywordOrHelper(): unknown {
    let hadNew = false
    let ident = this.parseIdentifierToken()
    if (ident === 'new') {
      hadNew = true
      this.skipTrivia()
      ident = this.parseIdentifierToken()
    }
    if (!hadNew) {
      if (ident === 'true') return true
      if (ident === 'false') return false
      if (ident === 'null') return null
      if (ident === 'undefined') return undefined
      if (ident === 'NaN') return NaN
      if (ident === 'Infinity') return Infinity
    }

    let fullName = ident
    while (this.peekChar() === '.') {
      this.pos++ // skip '.'
      this.skipTrivia()
      const part = this.parseIdentifierToken()
      fullName += `.${part}`
    }

    if (this.peekChar() !== '(') {
      throw new Error(`Unsupported bare identifier "${fullName}" in MongoDB expression`)
    }
    const args = this.parseCallArgList()
    return invokeMongoHelper(fullName, args)
  }

  parseCallArgList(): unknown[] {
    return this.withDepth(() => {
      this.skipTrivia()
      if (this.input[this.pos] !== '(') {
        throw new Error(`Expected "(" at position ${this.pos}`)
      }
      this.pos++
      const args: unknown[] = []
      while (true) {
        if (this.peekChar() === ')') {
          this.pos++
          return args
        }
        args.push(this.parseValue())
        const next = this.peekChar()
        if (next === ',') {
          this.pos++
          continue
        }
        if (next === ')') {
          this.pos++
          return args
        }
        throw new Error(`Expected "," or ")" in argument list at position ${this.pos}`)
      }
    })
  }

  private parseArray(): unknown[] {
    return this.withDepth(() => {
      this.pos++ // skip '['
      const items: unknown[] = []
      while (true) {
        if (this.peekChar() === ']') {
          this.pos++
          return items
        }
        items.push(this.parseValue())
        const next = this.peekChar()
        if (next === ',') {
          this.pos++
          continue
        }
        if (next === ']') {
          this.pos++
          return items
        }
        throw new Error(`Expected "," or "]" in array at position ${this.pos}`)
      }
    })
  }

  private parseObject(): Record<string, unknown> {
    return this.withDepth(() => {
      this.pos++ // skip '{'
      const obj: Record<string, unknown> = {}
      while (true) {
        const ch = this.peekChar()
        if (ch === '}') {
          this.pos++
          return obj
        }
        let key: string
        if (ch === '"' || ch === "'" || ch === '`') {
          key = this.parseString()
        } else {
          const start = this.pos
          while (this.pos < this.input.length && /[A-Za-z0-9_$.\-]/.test(this.input[this.pos])) {
            this.pos++
          }
          if (this.pos === start) {
            throw new Error(`Expected object key at position ${this.pos}`)
          }
          key = this.input.slice(start, this.pos)
        }
        if (this.peekChar() !== ':') {
          throw new Error(`Expected ":" after key "${key}" at position ${this.pos}`)
        }
        this.pos++ // skip ':'
        const val = this.parseValue()
        if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
          obj[key] = val
        }
        const next = this.peekChar()
        if (next === ',') {
          this.pos++
          continue
        }
        if (next === '}') {
          this.pos++
          return obj
        }
        throw new Error(`Expected "," or "}" in object at position ${this.pos}`)
      }
    })
  }
}

export function parseRelaxedMongoValue(raw: string): unknown {
  const parser = new MongoLiteralParser(raw)
  const val = parser.parseValue()
  parser.expectEnd()
  return hydrateEjsonValues(val)
}

function parseRelaxedMongoObject(raw: string, label: string): Record<string, unknown> {
  const parsed = parseRelaxedMongoValue(raw)
  if (!isPlainRecord(parsed)) {
    throw new Error(`${label} must evaluate to a JSON/MQL object`)
  }
  return parsed
}

// ============================================================================
// Safe SQL-Style Grid Quick-Filter & OrderBy Translator
// ============================================================================

type SqlFilterToken =
  | { kind: 'ident'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'op'; value: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'comma' }
  | { kind: 'kw'; value: string }

const SQL_FILTER_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'IS', 'NULL', 'LIKE', 'ILIKE', 'IN', 'TRUE', 'FALSE'])

function tokenizeSqlFilter(clause: string): SqlFilterToken[] {
  const tokens: SqlFilterToken[] = []
  let i = 0
  const len = clause.length

  while (i < len) {
    const ch = clause[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' })
      i++
      continue
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' })
      i++
      continue
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma' })
      i++
      continue
    }
    if (ch === "'" ) {
      i++
      let str = ''
      let closed = false
      while (i < len) {
        if (clause[i] === "'") {
          if (clause[i + 1] === "'") {
            str += "'"
            i += 2
            continue
          }
          i++
          closed = true
          break
        }
        if (clause[i] === '\\' && i + 1 < len) {
          const next = clause[i + 1]
          str += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next
          i += 2
          continue
        }
        str += clause[i++]
      }
      if (!closed) throw new Error('Unterminated string literal in filter clause')
      tokens.push({ kind: 'string', value: str })
      continue
    }
    if (ch === '"' || ch === '`' || ch === '[') {
      const endChar = ch === '[' ? ']' : ch
      i++
      let ident = ''
      let closed = false
      while (i < len) {
        if (clause[i] === endChar) {
          if (endChar !== ']' && clause[i + 1] === endChar) {
            ident += endChar
            i += 2
            continue
          }
          i++
          closed = true
          break
        }
        ident += clause[i++]
      }
      if (!closed) throw new Error('Unterminated quoted identifier in filter clause')
      tokens.push({ kind: 'ident', value: ident })
      continue
    }
    if (ch === '!' && clause[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '!=' })
      i += 2
      continue
    }
    if (ch === '<' && clause[i + 1] === '>') {
      tokens.push({ kind: 'op', value: '!=' })
      i += 2
      continue
    }
    if ((ch === '<' || ch === '>') && clause[i + 1] === '=') {
      tokens.push({ kind: 'op', value: `${ch}=` })
      i += 2
      continue
    }
    if (ch === '=' || ch === '<' || ch === '>') {
      tokens.push({ kind: 'op', value: ch })
      i++
      continue
    }
    const numMatch = /^-?(?:\d+\.?\d*|\.\d+)/.exec(clause.slice(i))
    if (numMatch && (ch !== '-' || (tokens.length > 0 && tokens[tokens.length - 1].kind !== 'number'))) {
      tokens.push({ kind: 'number', value: Number(numMatch[0]) })
      i += numMatch[0].length
      continue
    }
    const wordMatch = /^[A-Za-z_$][A-Za-z0-9_$.-]*/.exec(clause.slice(i))
    if (wordMatch) {
      const word = wordMatch[0]
      const upper = word.toUpperCase()
      i += word.length
      if (SQL_FILTER_KEYWORDS.has(upper)) {
        tokens.push({ kind: 'kw', value: upper })
      } else {
        tokens.push({ kind: 'ident', value: word })
      }
      continue
    }
    throw new Error(`Unsupported token "${ch}" in filter clause`)
  }
  return tokens
}

function escapeRegexChars(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function likePatternToRegex(pattern: string, caseInsensitive: boolean): BSONRegExp {
  let regexStr = '^'
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\' && i + 1 < pattern.length) {
      regexStr += escapeRegexChars(pattern[i + 1])
      i++
      continue
    }
    if (ch === '%') regexStr += '.*'
    else if (ch === '_') regexStr += '.'
    else regexStr += escapeRegexChars(ch)
  }
  regexStr += '$'
  return new BSONRegExp(regexStr, caseInsensitive ? 'i' : '')
}

function coerceIdCandidateIfNeeded(field: string, value: unknown): { isDual: boolean; single: unknown; pair?: [ObjectId, string] } {
  if (field === '_id' && typeof value === 'string' && HEX_24_RE.test(value)) {
    return { isDual: true, single: value, pair: [new ObjectId(value), value] }
  }
  return { isDual: false, single: value }
}

export function translateSqlFilterToMongoFilter(whereClause: string): Record<string, unknown> {
  const tokens = tokenizeSqlFilter(whereClause)
  if (tokens.length === 0) return {}
  let pos = 0

  const peek = (): SqlFilterToken | undefined => tokens[pos]
  const next = (): SqlFilterToken => {
    if (pos >= tokens.length) throw new Error('Unexpected end of filter clause')
    return tokens[pos++]
  }

  const parseScalarValue = (): unknown => {
    const tok = next()
    if (tok.kind === 'string' || tok.kind === 'number') return tok.value
    if (tok.kind === 'kw') {
      if (tok.value === 'TRUE') return true
      if (tok.value === 'FALSE') return false
      if (tok.value === 'NULL') return null
    }
    throw new Error('Expected literal value in filter predicate')
  }

  const parsePrimary = (): Record<string, unknown> => {
    const tok = peek()
    if (!tok) throw new Error('Unexpected end of filter clause')
    if (tok.kind === 'lparen') {
      next()
      const inner = parseOr()
      const close = next()
      if (close.kind !== 'rparen') throw new Error('Missing closing ")" in filter clause')
      return inner
    }
    const colTok = next()
    if (colTok.kind !== 'ident') {
      throw new Error('Expected column name in filter predicate')
    }
    const col = colTok.value
    const opTok = peek()
    if (!opTok) throw new Error(`Expected operator after "${col}"`)

    if (opTok.kind === 'kw' && opTok.value === 'IS') {
      next()
      const maybeNot = peek()
      if (maybeNot?.kind === 'kw' && maybeNot.value === 'NOT') {
        next()
        const nullTok = next()
        if (nullTok.kind !== 'kw' || nullTok.value !== 'NULL') {
          throw new Error('Expected NULL after IS NOT')
        }
        return { [col]: { $ne: null } }
      }
      const nullTok = next()
      if (nullTok.kind !== 'kw' || nullTok.value !== 'NULL') {
        throw new Error('Expected NULL after IS')
      }
      return { [col]: null }
    }

    if (opTok.kind === 'kw' && opTok.value === 'NOT') {
      next()
      const second = next()
      if (second.kind === 'kw' && (second.value === 'LIKE' || second.value === 'ILIKE')) {
        const val = parseScalarValue()
        return { [col]: { $not: likePatternToRegex(String(val ?? ''), second.value === 'ILIKE') } }
      }
      if (second.kind === 'kw' && second.value === 'IN') {
        const list = parseInList(col)
        return { [col]: { $nin: list } }
      }
      throw new Error(`Unsupported NOT ${second.kind === 'kw' ? second.value : ''} predicate`)
    }

    if (opTok.kind === 'kw' && (opTok.value === 'LIKE' || opTok.value === 'ILIKE')) {
      next()
      const val = parseScalarValue()
      return { [col]: likePatternToRegex(String(val ?? ''), opTok.value === 'ILIKE') }
    }

    if (opTok.kind === 'kw' && opTok.value === 'IN') {
      next()
      const list = parseInList(col)
      return { [col]: { $in: list } }
    }

    if (opTok.kind === 'op') {
      next()
      const val = parseScalarValue()
      if (opTok.value === '=') {
        const idCand = coerceIdCandidateIfNeeded(col, val)
        return idCand.isDual && idCand.pair ? { [col]: { $in: idCand.pair } } : { [col]: idCand.single }
      }
      if (opTok.value === '!=') {
        const idCand = coerceIdCandidateIfNeeded(col, val)
        return idCand.isDual && idCand.pair ? { [col]: { $nin: idCand.pair } } : { [col]: { $ne: idCand.single } }
      }
      const mongoOp =
        opTok.value === '>'
          ? '$gt'
          : opTok.value === '>='
            ? '$gte'
            : opTok.value === '<'
              ? '$lt'
              : '$lte'
      return { [col]: { [mongoOp]: val } }
    }

    throw new Error(`Unsupported operator in filter predicate for "${col}"`)
  }

  const parseInList = (col: string): unknown[] => {
    const open = next()
    if (open.kind !== 'lparen') throw new Error('Expected "(" after IN')
    const out: unknown[] = []
    while (true) {
      if (peek()?.kind === 'rparen') {
        next()
        return out
      }
      const val = parseScalarValue()
      const idCand = coerceIdCandidateIfNeeded(col, val)
      if (idCand.isDual && idCand.pair) {
        out.push(idCand.pair[0], idCand.pair[1])
      } else {
        out.push(idCand.single)
      }
      const sep = peek()
      if (sep?.kind === 'comma') {
        next()
        continue
      }
      if (sep?.kind === 'rparen') {
        next()
        return out
      }
      throw new Error('Expected "," or ")" in IN list')
    }
  }

  const isKeyword = (tok: SqlFilterToken | undefined, kw: string): boolean =>
    tok !== undefined && tok.kind === 'kw' && tok.value === kw

  const parseAnd = (): Record<string, unknown> => {
    const clauses: Record<string, unknown>[] = [parsePrimary()]
    while (isKeyword(peek(), 'AND')) {
      next()
      clauses.push(parsePrimary())
    }
    return clauses.length === 1 ? clauses[0] : { $and: clauses }
  }

  const parseOr = (): Record<string, unknown> => {
    const clauses: Record<string, unknown>[] = [parseAnd()]
    while (isKeyword(peek(), 'OR')) {
      next()
      clauses.push(parseAnd())
    }
    return clauses.length === 1 ? clauses[0] : { $or: clauses }
  }

  const result = parseOr()
  if (pos < tokens.length) {
    throw new Error('Unexpected trailing tokens in filter clause')
  }
  return result
}

function parseMongoOrderByClause(orderByClause: string): Record<string, 1 | -1> {
  const trimmed = orderByClause.trim().replace(/^ORDER\s+BY\b\s*/i, '').trim()
  if (!trimmed) return {}
  if (trimmed.startsWith('{')) {
    const parsed = parseRelaxedMongoObject(trimmed, 'orderByClause')
    const out: Record<string, 1 | -1> = {}
    for (const [k, v] of Object.entries(parsed)) {
      out[k] = Number(v) < 0 ? -1 : 1
    }
    return out
  }
  const out: Record<string, 1 | -1> = {}
  for (const part of trimmed.split(',')) {
    const item = part.trim()
    if (!item) continue
    const m = /^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z0-9_$.-]+))(?:\s+(ASC|DESC))?$/i.exec(item)
    if (!m) continue
    const col = m[1] || m[2] || m[3] || m[4]
    const dir = m[5]?.toUpperCase() === 'DESC' ? -1 : 1
    if (col) out[col] = dir
  }
  return out
}

// ============================================================================
// Safe Zero-Eval MongoDB Shell / MQL Script Splitter, Parser & Read-Only Guard
// ============================================================================

const MONGO_COLLECTION_SHORTHAND_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/
const MONGO_READONLY_COMMANDS: ReadonlySet<string> = new Set([
  'find',
  'count',
  'distinct',
  'ping',
  'listcollections',
  'listdatabases',
  'collstats',
  'dbstats',
  'explain',
  'hello',
  'ismaster',
  'buildinfo',
  'serverstatus',
  'whatsmyuri',
  'getlasterror',
])

const MONGO_READONLY_COLL_METHODS: ReadonlySet<string> = new Set([
  'find',
  'findOne',
  'aggregate',
  'countDocuments',
  'estimatedDocumentCount',
  'distinct',
  'getIndexes',
  'indexes',
  'stats',
])

const MONGO_WRITE_COLL_METHODS: ReadonlySet<string> = new Set([
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndUpdate',
  'findOneAndDelete',
  'createIndex',
  'dropIndex',
  'dropIndexes',
  'drop',
  'renameCollection',
])

const MONGO_DB_METHODS: ReadonlySet<string> = new Set([
  'stats',
  'serverStatus',
  'runCommand',
  'adminCommand',
  'createCollection',
  'getCollectionNames',
  'dropDatabase',
])

interface MongoChainCall {
  method: string
  args: unknown[]
}

export type ParsedMongoStatement =
  | { kind: 'show_dbs'; raw: string }
  | { kind: 'show_collections'; raw: string }
  | { kind: 'use_db'; dbName: string; raw: string }
  | { kind: 'raw_command'; command: Record<string, unknown>; raw: string }
  | { kind: 'db_method'; method: string; args: unknown[]; raw: string }
  | {
      kind: 'collection_method'
      collection: string
      method: string
      args: unknown[]
      chains: MongoChainCall[]
      raw: string
    }
  | { kind: 'collection_shorthand'; collection: string; raw: string }

function hasMongoWriteStage(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some((item) => hasMongoWriteStage(item))
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === '$out' || k === '$merge') return true
      if (hasMongoWriteStage(v)) return true
    }
  }
  return false
}

function isMongoCommandRecordReadOnly(cmdObj: Record<string, unknown>): boolean {
  const keys = Object.keys(cmdObj)
  if (keys.length === 0) return false
  const cmd = keys[0].toLowerCase()
  if (cmd === 'aggregate') {
    return !hasMongoWriteStage(cmdObj)
  }
  if (cmd === 'explain') {
    const target = cmdObj.explain
    if (hasMongoWriteStage(target)) return false
    if (isPlainRecord(target)) return isMongoCommandRecordReadOnly(target)
    return true
  }
  return MONGO_READONLY_COMMANDS.has(cmd)
}

function isMongoStatementReadOnly(stmt: ParsedMongoStatement): boolean {
  switch (stmt.kind) {
    case 'show_dbs':
    case 'show_collections':
    case 'use_db':
    case 'collection_shorthand':
      return true
    case 'raw_command':
      return isMongoCommandRecordReadOnly(stmt.command)
    case 'db_method': {
      if (stmt.method === 'stats' || stmt.method === 'serverStatus' || stmt.method === 'getCollectionNames') {
        return true
      }
      if (stmt.method === 'runCommand' || stmt.method === 'adminCommand') {
        return isPlainRecord(stmt.args[0]) && isMongoCommandRecordReadOnly(stmt.args[0])
      }
      return false
    }
    case 'collection_method': {
      if (stmt.method === 'aggregate') {
        const pipeline = Array.isArray(stmt.args[0]) ? stmt.args[0] : []
        return !hasMongoWriteStage(pipeline)
      }
      return MONGO_READONLY_COLL_METHODS.has(stmt.method)
    }
  }
}

interface MongoTokenScanResult {
  kind: 'string' | 'comment' | 'regex'
  nextIndex: number
  isBlockComment?: boolean
}

function isMongoRegexStartAllowed(prevSigChar: string): boolean {
  return prevSigChar === '' || '([{:,;=!&|?^~+-*%<>'.includes(prevSigChar)
}

function scanMongoQuotedOrComment(
  text: string,
  pos: number,
  prevSigChar: string
): MongoTokenScanResult | null {
  const len = text.length
  const ch = text[pos]
  if (ch === '"' || ch === "'" || ch === '`') {
    let i = pos + 1
    while (i < len) {
      if (text[i] === '\\' && i + 1 < len) {
        i += 2
        continue
      }
      i++
      if (text[i - 1] === ch) break
    }
    return { kind: 'string', nextIndex: i }
  }
  if (ch === '/' && pos + 1 < len && text[pos + 1] === '/') {
    let i = pos + 2
    while (i < len && text[i] !== '\n') i++
    return { kind: 'comment', nextIndex: i }
  }
  if (ch === '/' && pos + 1 < len && text[pos + 1] === '*') {
    const end = text.indexOf('*/', pos + 2)
    return {
      kind: 'comment',
      nextIndex: end < 0 ? len : end + 2,
      isBlockComment: true,
    }
  }
  if (ch === '/' && isMongoRegexStartAllowed(prevSigChar)) {
    let i = pos + 1
    let inCharClass = false
    while (i < len) {
      const c = text[i]
      if (c === '\n' || c === '\r') return null
      if (c === '\\' && i + 1 < len) {
        i += 2
        continue
      }
      if (c === '[') {
        inCharClass = true
      } else if (c === ']' && inCharClass) {
        inCharClass = false
      } else if (c === '/' && !inCharClass) {
        i++
        while (i < len && /[a-zA-Z]/.test(text[i])) i++
        return { kind: 'regex', nextIndex: i }
      }
      i++
    }
  }
  return null
}

function stripMongoComments(raw: string): string {
  let out = ''
  let i = 0
  let prevSigChar = ''
  const len = raw.length
  while (i < len) {
    const token = scanMongoQuotedOrComment(raw, i, prevSigChar)
    if (token) {
      if (token.kind === 'comment') {
        if (token.isBlockComment) out += ' '
      } else {
        out += raw.slice(i, token.nextIndex)
        prevSigChar = token.kind === 'regex' ? '/' : '"'
      }
      i = token.nextIndex
      continue
    }
    const ch = raw[i]
    if (!/\s/.test(ch)) prevSigChar = ch
    out += ch
    i++
  }
  return out.trim()
}

export function splitMongoScriptStatements(script: string): string[] {
  const stmts: string[] = []
  let start = 0
  let i = 0
  let depth = 0
  let prevSigChar = ''
  const len = script.length

  const pushSlice = (endIdx: number): void => {
    const raw = script.slice(start, endIdx)
    if (stripMongoComments(raw).length > 0) {
      stmts.push(raw.trim())
    }
    start = endIdx + 1
    prevSigChar = ''
  }

  while (i < len) {
    const token = scanMongoQuotedOrComment(script, i, prevSigChar)
    if (token) {
      if (token.kind !== 'comment') {
        prevSigChar = token.kind === 'regex' ? '/' : '"'
      }
      i = token.nextIndex
      continue
    }
    const ch = script[i]
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++
      prevSigChar = ch
      i++
      continue
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      if (depth > 0) depth--
      prevSigChar = ch
      i++
      continue
    }
    if (ch === ';' && depth === 0) {
      pushSlice(i)
      i++
      continue
    }
    if (ch === '\n' && depth === 0) {
      const current = stripMongoComments(script.slice(start, i))
      if (/^(?:show\s+(?:dbs|databases|collections|tables)|use\s+\S+)$/i.test(current)) {
        pushSlice(i)
        i++
        continue
      }
    }
    if (!/\s/.test(ch)) prevSigChar = ch
    i++
  }

  if (start < len) {
    const tail = script.slice(start)
    if (stripMongoComments(tail).length > 0) {
      stmts.push(tail.trim())
    }
  }
  return stmts
}

export function parseMongoStatement(rawInput: string): ParsedMongoStatement {
  const cleaned = stripMongoComments(rawInput).replace(/;+\s*$/, '').trim()
  if (!cleaned) {
    throw new DatabaseDriverError('MongoDB query cannot be empty', 'invalid_params', 'mongodb')
  }

  if (/^show\s+(?:dbs|databases)$/i.test(cleaned)) {
    return { kind: 'show_dbs', raw: cleaned }
  }
  if (/^show\s+(?:collections|tables)$/i.test(cleaned)) {
    return { kind: 'show_collections', raw: cleaned }
  }
  const useMatch = /^use\s+([A-Za-z0-9_.-]+)$/i.exec(cleaned)
  if (useMatch && useMatch[1]) {
    return { kind: 'use_db', dbName: useMatch[1], raw: cleaned }
  }

  if (cleaned.startsWith('{')) {
    const cmdObj = parseRelaxedMongoObject(cleaned, 'MongoDB command')
    return { kind: 'raw_command', command: cmdObj, raw: cleaned }
  }

  if (MONGO_COLLECTION_SHORTHAND_RE.test(cleaned) && !/^db$/i.test(cleaned)) {
    return { kind: 'collection_shorthand', collection: cleaned, raw: cleaned }
  }

  if (/^db(?:\.|\[)/.test(cleaned)) {
    const parser = new MongoLiteralParser(cleaned)
    parser.pos = 2 // after 'db'
    parser.skipTrivia()

    let collectionName: string | null = null
    let methodName = ''
    let methodArgs: unknown[] = []

    const readIdent = (): string => {
      parser.skipTrivia()
      const start = parser.pos
      while (parser.pos < parser.input.length && /[A-Za-z0-9_$-]/.test(parser.input[parser.pos])) {
        parser.pos++
      }
      if (parser.pos === start) {
        throw new Error(`Expected identifier at position ${parser.pos}`)
      }
      return parser.input.slice(start, parser.pos)
    }

    if (parser.peekChar() === '[') {
      parser.pos++
      const keyVal = parser.parseValue()
      if (typeof keyVal !== 'string' || !keyVal) {
        throw new Error('Collection name inside db[...] must be a non-empty string')
      }
      if (parser.peekChar() !== ']') {
        throw new Error('Expected "]" after collection name')
      }
      parser.pos++
      collectionName = keyVal
      if (parser.peekChar() !== '.') {
        throw new Error(`Expected ".<method>(...)" after db[${JSON.stringify(keyVal)}]`)
      }
      parser.pos++
      methodName = readIdent()
      methodArgs = parser.parseCallArgList().map((a) => hydrateEjsonValues(a))
    } else {
      const segments: string[] = []
      while (parser.peekChar() === '.') {
        parser.pos++
        segments.push(readIdent())
        if (parser.peekChar() === '(') break
      }
      if (segments.length === 0) {
        throw new Error('Expected method or collection name after "db."')
      }
      if (segments.length === 1 && MONGO_DB_METHODS.has(segments[0])) {
        const dbMethod = segments[0]
        const dbArgs = parser.parseCallArgList().map((a) => hydrateEjsonValues(a))
        parser.expectEnd()
        return { kind: 'db_method', method: dbMethod, args: dbArgs, raw: cleaned }
      }
      if (segments.length === 1 && segments[0] === 'getCollection') {
        const gcArgs = parser.parseCallArgList()
        if (typeof gcArgs[0] !== 'string' || !gcArgs[0]) {
          throw new Error('db.getCollection(...) requires a non-empty collection name string')
        }
        collectionName = gcArgs[0]
        if (parser.peekChar() !== '.') {
          throw new Error(`Expected ".<method>(...)" after db.getCollection(${JSON.stringify(collectionName)})`)
        }
        parser.pos++
        methodName = readIdent()
        methodArgs = parser.parseCallArgList().map((a) => hydrateEjsonValues(a))
      } else if (segments.length >= 2) {
        methodName = segments.pop() || ''
        collectionName = segments.join('.')
        methodArgs = parser.parseCallArgList().map((a) => hydrateEjsonValues(a))
      } else {
        throw new Error(`Unsupported db method "db.${segments[0]}"`)
      }
    }

    const preChains: MongoChainCall[] = []
    if (methodName === 'explain' && parser.peekChar() === '.') {
      preChains.push({ method: 'explain', args: methodArgs })
      parser.pos++
      methodName = readIdent()
      methodArgs = parser.parseCallArgList().map((a) => hydrateEjsonValues(a))
      if (methodName !== 'find' && methodName !== 'aggregate') {
        throw new Error(`Unsupported .explain() target ".${methodName}()"`)
      }
    }

    if (!collectionName || !methodName) {
      throw new Error('Invalid MongoDB collection method expression')
    }
    if (!MONGO_READONLY_COLL_METHODS.has(methodName) && !MONGO_WRITE_COLL_METHODS.has(methodName)) {
      throw new Error(`Unsupported MongoDB collection method ".${methodName}()"`)
    }

    const chains: MongoChainCall[] = [...preChains]
    while (parser.peekChar() === '.') {
      parser.pos++
      const chainMethod = readIdent()
      const chainArgs = parser.parseCallArgList().map((a) => hydrateEjsonValues(a))
      chains.push({ method: chainMethod, args: chainArgs })
    }
    parser.expectEnd()

    return {
      kind: 'collection_method',
      collection: collectionName,
      method: methodName,
      args: methodArgs,
      chains,
      raw: cleaned,
    }
  }

  throw new DatabaseDriverError(
    `Unsupported MongoDB command syntax: "${cleaned.slice(0, 64)}"`,
    'SYNTAX_ERROR',
    'mongodb'
  )
}

function buildQueryResultFromDocs(
  docs: Record<string, unknown>[],
  truncated: boolean,
  sourceTable?: { table: string; schema: string }
): Omit<QueryResult, 'executionTimeMs'> {
  if (docs.length === 0) {
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      truncated,
      isSelect: true,
      ...(sourceTable ? { sourceTable } : {}),
    }
  }

  const colNames: string[] = []
  const colTypes = new Map<string, string>()
  for (const doc of docs) {
    if (!doc || typeof doc !== 'object') continue
    for (const [k, v] of Object.entries(doc)) {
      if (!colTypes.has(k)) {
        colNames.push(k)
        colTypes.set(k, detectBsonTypeName(v))
      } else if (colTypes.get(k) === 'Null' && v !== null && v !== undefined) {
        colTypes.set(k, detectBsonTypeName(v))
      }
    }
  }
  if (colNames.includes('_id') && colNames[0] !== '_id') {
    colNames.splice(colNames.indexOf('_id'), 1)
    colNames.unshift('_id')
  }

  const columns = colNames.map((name) => ({
    name,
    type: colTypes.get(name) ?? 'Mixed',
  }))
  const rows = docs.map((doc) =>
    colNames.map((col) => serializeMongoValue(doc[col]))
  )

  return {
    columns,
    rows,
    rowCount: rows.length,
    truncated,
    isSelect: true,
    ...(sourceTable ? { sourceTable } : {}),
  }
}

// ============================================================================
// Connection Config & URI Builder
// ============================================================================

const MONGO_URI_SCHEME_IN_ERR_RE =
  /[a-z][a-z0-9+.-]*:(?:\\*\/){2}(?:\[[^\s[\]"'<>]+\]|\{(?:[^}"'\s]|\}\})*\}|\\*\/|[^\s'"`<>[\])},\\])+/gi

const MONGO_KV_SECRET_PREFIX_RE =
  /\b(password|passwd|pwd|passphrase|tlsCertificateKeyFilePassword|sslCertificateKeyFilePassword)\s*([=:])\s*/gi

function scrubMongoKvAttributes(text: string): string {
  MONGO_KV_SECRET_PREFIX_RE.lastIndex = 0
  let out = ''
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = MONGO_KV_SECRET_PREFIX_RE.exec(text)) !== null) {
    const valStart = match.index + match[0].length
    const span = scanSecretValueSpan(text, valStart, 'mongo')
    if (span.skip) {
      if (span.end > MONGO_KV_SECRET_PREFIX_RE.lastIndex) {
        MONGO_KV_SECRET_PREFIX_RE.lastIndex = span.end
      }
      continue
    }
    out += `${text.slice(cursor, match.index)}${match[1]}${match[2]}***`
    cursor = span.end
    if (span.end > MONGO_KV_SECRET_PREFIX_RE.lastIndex) {
      MONGO_KV_SECRET_PREFIX_RE.lastIndex = span.end
    }
  }
  return cursor === 0 ? text : out + text.slice(cursor)
}

function scrubMongoErrorMessage(err: unknown, fallback = 'MongoDB operation failed'): string {
  const raw =
    err instanceof Error && err.message
      ? err.message
      : typeof err === 'string' && err
        ? err
        : fallback
  const preQuery = raw
    .replace(
      /([?&#])([^=&\s#;"'{}\\]+)=((?:Bearer|Basic)[ \t]+(?:\\*\/|[^\\&\s#"'`}\]),<>])+)/gi,
      (full, sep: string, key: string) =>
        /^(?:authorization|auth[-_]?token|authtoken|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|apikey|token|bearer|credentials?|secret|pass(?:word|wd|phrase)?|pwd|sig(?:nature)?)$/i.test(
          key.trim()
        )
          ? `${sep}${key}=***`
          : full
    )
    .replace(MONGO_URI_SCHEME_IN_ERR_RE, (match, offset: number, src: string) => {
      if (offset > 0 && /[a-z0-9+.-]/i.test(src[offset - 1])) return match
      const sepMatch = /^[a-z][a-z0-9+.-]*:(\\+\/)\\+\//i.exec(match)
      if (sepMatch) {
        const sep = sepMatch[1]
        const unescaped = match.replace(/\\+\//g, '/')
        return maskConnectionUriSecret(unescaped).replace(/\//g, () => sep)
      }
      return maskConnectionUriSecret(match)
    })
  return scrubMongoKvAttributes(preQuery)
    .replace(
      /\b(Authorization\s*[:=]\s*(?:Bearer|Basic))[ \t]+(?!\[REDACTED\](?:$|[\s,;'"`}\])<>\\])|\*\*\*(?:$|[\s,;'"`}\])<>\\]))(?:\\*\/|[^\s,;'"`}\])<>\\])+/gi,
      '$1 ***'
    )
    .replace(
      /\b(Bearer)[ \t]+(?!(?:token|auth|header|scheme|flow|missing|required|invalid|expired|type|based|only|mode)\b)((?:\\*\/|[A-Za-z0-9\-._~+]){4,}=*)(?=$|[\s,;'"`}\])<>]|\\["'nrt])/gi,
      '$1 ***'
    )
    .replace(
      /\b(Basic)[ \t]+((?:(?:\\*\/|[A-Za-z0-9+]){4,}={1,2}|(?=(?:\\*\/|[A-Za-z0-9+])*[0-9+/A-Z])(?:\\*\/|[A-Za-z0-9+]){4,}))(?=$|[\s,;'"`}\])<>]|\\["'nrt])/g,
      '$1 ***'
    )
}

function scrubMongoError(
  err: unknown,
  fallback = 'MongoDB operation failed',
  defaultCode = 'QUERY_ERROR'
): DatabaseDriverError {
  if (err instanceof DatabaseDriverError) {
    const scrubbed = scrubMongoErrorMessage(err.message, fallback)
    if (scrubbed === err.message) return err
    return new DatabaseDriverError(scrubbed, err.code, err.driver ?? 'mongodb', err.cause ?? err)
  }
  return new DatabaseDriverError(scrubMongoErrorMessage(err, fallback), defaultCode, 'mongodb', err)
}

function parseMongoProfileOptions(rawOptions: string | undefined): Record<string, unknown> {
  if (typeof rawOptions !== 'string') return {}
  const trimmed = rawOptions.trim()
  if (!trimmed) return {}
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return {}
    }
    return {}
  }
  const out: Record<string, unknown> = {}
  for (const part of trimmed.split(/[&;,]/)) {
    const eqIdx = part.indexOf('=')
    if (eqIdx <= 0) continue
    const k = part.slice(0, eqIdx).trim()
    const v = part.slice(eqIdx + 1).trim()
    if (!k) continue
    if (v === 'true') out[k] = true
    else if (v === 'false') out[k] = false
    else if (/^-?\d+$/.test(v)) out[k] = Number(v)
    else out[k] = v
  }
  return out
}

function extractDbNameFromUri(rawUri: string): string | undefined {
  const withoutScheme = rawUri.replace(/^mongodb(?:\+srv)?:\/\//i, '')
  const slashIdx = withoutScheme.indexOf('/')
  if (slashIdx < 0) return undefined
  const afterSlash = withoutScheme.slice(slashIdx + 1)
  const qIdx = afterSlash.indexOf('?')
  const hashIdx = afterSlash.indexOf('#')
  const cut =
    qIdx >= 0 && hashIdx >= 0
      ? Math.min(qIdx, hashIdx)
      : qIdx >= 0
        ? qIdx
        : hashIdx >= 0
          ? hashIdx
          : afterSlash.length
  const dbSegment = afterSlash.slice(0, cut).trim()
  if (!dbSegment) return undefined
  try {
    return decodeURIComponent(dbSegment)
  } catch {
    return dbSegment
  }
}

function injectCredentialsIntoRawMongoUri(rawUri: string, user?: string, password?: string): string {
  if (!user && !password) return rawUri
  const match = /^(mongodb(?:\+srv)?:\/\/)(.*)$/i.exec(rawUri)
  if (!match) return rawUri
  const scheme = match[1]
  const rest = match[2]
  const sepIdx = rest.search(/[/?#]/)
  const authority = sepIdx >= 0 ? rest.slice(0, sepIdx) : rest
  const tail = sepIdx >= 0 ? rest.slice(sepIdx) : ''
  if (authority.includes('@')) {
    return rawUri
  }
  const authPrefix = `${encodeURIComponent(user || '')}:${encodeURIComponent(password || '')}@`
  return `${scheme}${authPrefix}${authority}${tail}`
}

function rewriteTunneledMongoUri(rawUri: string, host: string, port: number): string {
  if (!/^mongodb:\/\//i.test(rawUri)) return rawUri
  try {
    const parsed = new URL(rawUri)
    parsed.hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    parsed.port = String(port)
    return parsed.toString()
  } catch {
    return rawUri
  }
}

export async function buildMongoConnectionConfig(
  profile: ConnectionProfile,
  password?: string,
  extraSecrets?: DriverTlsOptions
): Promise<{ uri: string; dbName: string; options: MongoClientOptions }> {
  const parsedOpts = parseMongoProfileOptions(profile.options)
  const rawUrl = typeof profile.url === 'string' ? profile.url.trim() : ''
  const urlDb = rawUrl ? extractDbNameFromUri(rawUrl) : undefined
  const dbName = (profile.database || '').trim() || urlDb || 'admin'

  let uri: string
  if (rawUrl) {
    let workingUrl = injectCredentialsIntoRawMongoUri(rawUrl, profile.user, password)
    if (profile.sshEnabled && /^mongodb:\/\//i.test(workingUrl)) {
      const targetHost = (profile.host || '127.0.0.1').trim()
      const targetPort =
        profile.port && Number.isInteger(profile.port) && profile.port > 0 ? profile.port : 27017
      workingUrl = rewriteTunneledMongoUri(workingUrl, targetHost, targetPort)
    }
    uri = workingUrl
  } else {
    const host = (profile.host || 'localhost').trim()
    const port =
      profile.port && Number.isInteger(profile.port) && profile.port > 0 ? profile.port : 27017
    const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    const auth = profile.user
      ? `${encodeURIComponent(profile.user)}:${encodeURIComponent(password || '')}@`
      : ''
    uri = `mongodb://${auth}${formattedHost}:${port}/${encodeURIComponent(dbName)}`
  }

  const options: MongoClientOptions = {
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 10_000,
  }

  if (typeof parsedOpts.authSource === 'string' && parsedOpts.authSource.trim().length > 0) {
    options.authSource = parsedOpts.authSource.trim()
  }
  if (typeof parsedOpts.replicaSet === 'string' && parsedOpts.replicaSet.trim().length > 0) {
    options.replicaSet = parsedOpts.replicaSet.trim()
  }
  if (typeof parsedOpts.directConnection === 'boolean') {
    options.directConnection = parsedOpts.directConnection
  }
  if (typeof parsedOpts.appName === 'string' && parsedOpts.appName.trim().length > 0) {
    options.appName = parsedOpts.appName.trim()
  }
  if (typeof parsedOpts.retryWrites === 'boolean') {
    options.retryWrites = parsedOpts.retryWrites
  }
  if (typeof parsedOpts.maxPoolSize === 'number' && Number.isInteger(parsedOpts.maxPoolSize) && parsedOpts.maxPoolSize > 0) {
    options.maxPoolSize = parsedOpts.maxPoolSize
  }
  if (typeof parsedOpts.connectTimeoutMS === 'number' && parsedOpts.connectTimeoutMS > 0) {
    options.connectTimeoutMS = parsedOpts.connectTimeoutMS
  }
  if (typeof parsedOpts.serverSelectionTimeoutMS === 'number' && parsedOpts.serverSelectionTimeoutMS > 0) {
    options.serverSelectionTimeoutMS = parsedOpts.serverSelectionTimeoutMS
  }
  if (typeof parsedOpts.socketTimeoutMS === 'number' && parsedOpts.socketTimeoutMS > 0) {
    options.socketTimeoutMS = parsedOpts.socketTimeoutMS
  }

  const tlsOverride = await resolveEffectiveTlsOptions(
    profile,
    extraSecrets,
    extraSecrets?.tlsServername
  )

  if (tlsOverride === false) {
    options.tls = false
  } else if (tlsOverride) {
    options.tls = true
    if (tlsOverride.ca) options.ca = tlsOverride.ca
    if (profile.sslCaPath?.trim()) options.tlsCAFile = profile.sslCaPath.trim()
    if (tlsOverride.cert) options.cert = tlsOverride.cert
    if (tlsOverride.key) options.key = tlsOverride.key
    const certKeyPath = profile.sslCertPath?.trim() || profile.sslKeyPath?.trim()
    if (certKeyPath) options.tlsCertificateKeyFile = certKeyPath
    if (typeof tlsOverride.passphrase === 'string' && tlsOverride.passphrase.length > 0) {
      options.passphrase = tlsOverride.passphrase
      options.tlsCertificateKeyFilePassword = tlsOverride.passphrase
    }
    if (tlsOverride.servername) options.servername = tlsOverride.servername
    if (tlsOverride.checkServerIdentity) options.checkServerIdentity = tlsOverride.checkServerIdentity
    if (tlsOverride.rejectUnauthorized === false) {
      options.tlsAllowInvalidCertificates = true
      options.rejectUnauthorized = false
    } else if (tlsOverride.rejectUnauthorized === true) {
      options.tlsAllowInvalidCertificates = false
      options.rejectUnauthorized = true
    }
  } else if (profile.ssl === true) {
    options.tls = true
  } else if (profile.ssl === false) {
    options.tls = false
  }

  return { uri, dbName, options }
}

// ============================================================================
// Schema Inference & DDL Rendering
// ============================================================================

function inferFieldsFromSampleDocs(
  docs: Record<string, unknown>[],
  kind: 'table' | 'view'
): ColumnInfo[] {
  const fieldOrder: string[] = []
  const statsMap = new Map<
    string,
    { typeCounts: Map<string, number>; presentNonNullCount: number }
  >()

  const recordField = (name: string, typeName: string): void => {
    let entry = statsMap.get(name)
    if (!entry) {
      entry = { typeCounts: new Map(), presentNonNullCount: 0 }
      statsMap.set(name, entry)
      fieldOrder.push(name)
    }
    if (typeName !== 'Null') {
      entry.presentNonNullCount++
      entry.typeCounts.set(typeName, (entry.typeCounts.get(typeName) ?? 0) + 1)
    }
  }

  for (const doc of docs) {
    if (!doc || typeof doc !== 'object') continue
    for (const [k, v] of Object.entries(doc)) {
      recordField(k, detectBsonTypeName(v))
    }
  }

  if (fieldOrder.length === 0 && kind === 'table') {
    fieldOrder.push('_id')
    statsMap.set('_id', {
      typeCounts: new Map([['ObjectId', 1]]),
      presentNonNullCount: 1,
    })
  } else if (fieldOrder.includes('_id') && fieldOrder[0] !== '_id') {
    fieldOrder.splice(fieldOrder.indexOf('_id'), 1)
    fieldOrder.unshift('_id')
  }

  const totalDocs = docs.length
  return fieldOrder.map((name) => {
    const stats = statsMap.get(name)
    let dominantType = 'Mixed'
    let bestCount = -1
    if (stats) {
      for (const [t, count] of stats.typeCounts.entries()) {
        if (count > bestCount) {
          bestCount = count
          dominantType = t
        }
      }
      if (bestCount <= 0) dominantType = 'Null'
    }
    const nullable =
      totalDocs > 0 && stats ? stats.presentNonNullCount < totalDocs : name !== '_id'
    const isPk = kind === 'table' && name === '_id'
    return {
      name,
      type: dominantType,
      nativeType: dominantType,
      nullable: isPk ? false : nullable,
      defaultValue: null,
      isPrimaryKey: isPk,
      isAutoIncrement: false,
    }
  })
}

function mapMongoIndexes(rawIndexes: Record<string, unknown>[]): IndexInfo[] {
  const indexes: IndexInfo[] = []
  for (const idx of rawIndexes) {
    const name = typeof idx.name === 'string' ? idx.name : ''
    if (!name) continue
    const keyDoc = isPlainRecord(idx.key) ? idx.key : {}
    const columns = Object.keys(keyDoc)
    const columnSpecs = columns.map((col) => ({
      name: col,
      desc: Number(keyDoc[col]) === -1,
    }))
    const isPrimary = name === '_id_'
    indexes.push({
      name,
      isPrimary,
      isUnique: isPrimary || Boolean(idx.unique),
      columns,
      columnSpecs,
    })
  }
  return indexes
}

function buildMongoCollectionDdl(params: {
  table: string
  kind: 'table' | 'view'
  colMetaOptions?: Record<string, unknown>
  rawIndexes?: Record<string, unknown>[]
}): string {
  const { table, kind, colMetaOptions, rawIndexes = [] } = params
  if (kind === 'view') {
    const viewOn = typeof colMetaOptions?.viewOn === 'string' ? colMetaOptions.viewOn : 'source_collection'
    const pipeline = Array.isArray(colMetaOptions?.pipeline) ? colMetaOptions.pipeline : []
    return `db.createView(${JSON.stringify(table)}, ${JSON.stringify(viewOn)}, ${EJSON.stringify(pipeline, undefined, 2)});`
  }

  const collectionOpts: Record<string, unknown> = {}
  if (colMetaOptions) {
    for (const key of ['capped', 'size', 'max', 'validator', 'validationLevel', 'validationAction', 'timeseries', 'expireAfterSeconds']) {
      if (colMetaOptions[key] !== undefined) {
        collectionOpts[key] = colMetaOptions[key]
      }
    }
  }
  const lines: string[] = []
  if (Object.keys(collectionOpts).length > 0) {
    lines.push(`db.createCollection(${JSON.stringify(table)}, ${EJSON.stringify(collectionOpts, undefined, 2)});`)
  } else {
    lines.push(`db.createCollection(${JSON.stringify(table)});`)
  }

  for (const idx of rawIndexes) {
    const name = typeof idx.name === 'string' ? idx.name : ''
    if (!name || name === '_id_') continue
    const keyDoc = isPlainRecord(idx.key) ? idx.key : {}
    const idxOpts: Record<string, unknown> = { name }
    if (idx.unique) idxOpts.unique = true
    if (idx.sparse) idxOpts.sparse = true
    if (typeof idx.expireAfterSeconds === 'number') idxOpts.expireAfterSeconds = idx.expireAfterSeconds
    lines.push(
      `db.getCollection(${JSON.stringify(table)}).createIndex(${JSON.stringify(keyDoc)}, ${JSON.stringify(idxOpts)});`
    )
  }

  return lines.join('\n')
}

interface ActiveMongoQuery {
  controller: AbortController
  cancelled: boolean
  activeCursor?: { close?: () => Promise<void> }
}

export class MongoSession implements IDatabaseSession {
  readonly driverType = 'mongodb' as const
  readonly profile: ConnectionProfile
  private readonly client: MongoClientLike
  private readonly dbName: string
  private readonly tableDetailsCache = new TableDetailsCache()
  private readonly knownColumnTypes = new Map<string, Record<string, string>>()
  private readonly activeQueries = new Map<string, ActiveMongoQuery>()
  private isClosed = false
  private activeTxSession: MongoClientSessionLike | null = null
  private txOpChain: Promise<void> = Promise.resolve()
  private autoCommit = true
  private statementCount = 0
  private txStartedAt: number | undefined

  constructor(client: MongoClientLike, profile: ConnectionProfile, dbName: string) {
    this.client = client
    this.profile = profile
    this.dbName = dbName
  }

  private assertOpen(): void {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'mongodb')
    }
  }

  private async runScrubbed<T>(
    fallback: string,
    defaultCode: string,
    fn: () => Promise<T>
  ): Promise<T> {
    try {
      return await fn()
    } catch (err: unknown) {
      throw scrubMongoError(err, fallback, defaultCode)
    }
  }

  private makeColumnTypeKey(targetDb: string, table: string): string {
    return `${targetDb}:${table}`
  }

  private recordKnownColumnTypes(
    targetDb: string,
    table: string,
    entries: Iterable<[string, string | undefined]>
  ): void {
    const key = this.makeColumnTypeKey(targetDb, table)
    const existing = this.knownColumnTypes.get(key) ?? {}
    let changed = false
    for (const [col, colType] of entries) {
      if (!col || !colType || colType === 'Null' || colType === 'Mixed') continue
      if (existing[col] !== colType) {
        existing[col] = colType
        changed = true
      }
    }
    if (changed || !this.knownColumnTypes.has(key)) {
      this.knownColumnTypes.set(key, existing)
    }
  }

  private async resolveCollectionColumnTypes(
    targetDb: string,
    table: string,
    explicit?: Record<string, string>
  ): Promise<Record<string, string>> {
    const key = this.makeColumnTypeKey(targetDb, table)
    let cached = this.tableDetailsCache.get(targetDb, this.dbName, table)
    let known = this.knownColumnTypes.get(key)
    if (!cached && !known) {
      cached = await this.getTableDetails(table, targetDb).catch(() => undefined)
      known = this.knownColumnTypes.get(key)
    }
    const merged: Record<string, string> = {}
    if (known) {
      Object.assign(merged, known)
    }
    if (cached) {
      for (const col of cached.columns) {
        const t = col.nativeType || col.type
        if (t && t !== 'Null' && (t !== 'Mixed' || !merged[col.name])) {
          merged[col.name] = t
        }
      }
    }
    if (explicit) {
      for (const [k, v] of Object.entries(explicit)) {
        if (v) merged[k] = v
      }
      this.recordKnownColumnTypes(targetDb, table, Object.entries(explicit))
    }
    return merged
  }

  isAlive(): boolean {
    return !this.isClosed
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    if (this.isClosed) {
      return { ok: false, message: 'Session is closed' }
    }
    try {
      await this.client.db(this.dbName).command({ ping: 1 })
      return { ok: true, message: 'MongoDB connection valid' }
    } catch (err: unknown) {
      return { ok: false, message: scrubMongoErrorMessage(err, 'MongoDB connection test failed') }
    }
  }

  async close(): Promise<void> {
    this.tableDetailsCache.clear()
    this.knownColumnTypes.clear()
    if (this.isClosed) return
    this.isClosed = true
    for (const active of this.activeQueries.values()) {
      active.cancelled = true
      active.controller.abort()
      void active.activeCursor?.close?.().catch(() => {})
    }
    this.activeQueries.clear()
    const tx = this.activeTxSession
    this.activeTxSession = null
    this.statementCount = 0
    this.txStartedAt = undefined
    if (tx) {
      try {
        if (tx.inTransaction()) {
          await tx.abortTransaction().catch(() => {})
        }
      } finally {
        await tx.endSession().catch(() => {})
      }
    }
    await this.client.close().catch(() => {})
  }

  async listSchemas(): Promise<{ schemas: string[]; defaultSchema: string }> {
    this.assertOpen()
    try {
      const res = await this.client.db(this.dbName).admin().listDatabases()
      const names = (res.databases || [])
        .map((d) => String(d.name || '').trim())
        .filter((n) => n.length > 0)
      if (!names.includes(this.dbName)) {
        names.unshift(this.dbName)
      }
      return { schemas: names, defaultSchema: this.dbName }
    } catch {
      return { schemas: [this.dbName], defaultSchema: this.dbName }
    }
  }

  async listObjects(schema?: string): Promise<SchemaObject[]> {
    this.assertOpen()
    const targetDb = schema?.trim() || this.dbName
    return await this.runScrubbed('Failed to list MongoDB collections', 'QUERY_ERROR', async () => {
      const cols = await this.client.db(targetDb).listCollections({}, { nameOnly: false }).toArray()
      const objects: SchemaObject[] = []
      for (const col of cols) {
        const name = String(col.name || '')
        if (!name || name.startsWith('system.')) continue
        const kind: SchemaObjectKind = col.type === 'view' ? 'view' : 'table'
        const viewOn = col.options && typeof col.options.viewOn === 'string' ? col.options.viewOn : undefined
        objects.push({
          name,
          schema: targetDb,
          kind,
          ...(viewOn ? { detail: `viewOn: ${viewOn}` } : {}),
        })
      }
      objects.sort((a, b) => a.name.localeCompare(b.name))
      return objects
    })
  }

  async getTableDetails(table: string, schema?: string): Promise<TableDetails> {
    this.assertOpen()
    const targetDb = schema?.trim() || this.dbName
    const cached = this.tableDetailsCache.get(targetDb, this.dbName, table)
    if (cached) {
      this.recordKnownColumnTypes(
        targetDb,
        table,
        cached.columns.map((c) => [c.name, c.nativeType || c.type])
      )
      return cached
    }

    return await this.runScrubbed('Failed to inspect MongoDB collection', 'QUERY_ERROR', async () => {
      const db = this.client.db(targetDb)
      const metaList = await db.listCollections({ name: table }, { nameOnly: false }).toArray()
      const colMeta = metaList.find((item) => item.name === table)
      const kind: 'table' | 'view' = colMeta?.type === 'view' ? 'view' : 'table'

      const coll = db.collection(table)
      let sampleDocs: Record<string, unknown>[] = []
      try {
        sampleDocs = await coll.find({}).limit(SCHEMA_SAMPLE_LIMIT).toArray()
      } catch {
        sampleDocs = []
      }

      let rawIndexes: Record<string, unknown>[] = []
      if (kind === 'table') {
        try {
          rawIndexes = await coll.indexes()
        } catch {
          rawIndexes = []
        }
      }

      const columns = inferFieldsFromSampleDocs(sampleDocs, kind)
      const indexes = mapMongoIndexes(rawIndexes)
      const primaryKey = kind === 'table' && columns.some((c) => c.name === '_id') ? ['_id'] : []
      const ddl = buildMongoCollectionDdl({
        table,
        kind,
        colMetaOptions: colMeta?.options,
        rawIndexes,
      })

      const details: TableDetails = {
        name: table,
        schema: targetDb,
        kind,
        columns,
        primaryKey,
        indexes,
        foreignKeys: [],
        ddl,
      }
      this.tableDetailsCache.set(targetDb, this.dbName, table, details)
      this.recordKnownColumnTypes(
        targetDb,
        table,
        columns.map((c) => [c.name, c.nativeType || c.type])
      )
      return details
    })
  }

  async fetchPage(params: FetchPageParams): Promise<TableBrowseResult> {
    this.assertOpen()
    const targetDb = params.schema?.trim() || this.dbName
    const details = await this.getTableDetails(params.table, targetDb)
    const isView = details.kind === 'view'

    const page = Math.max(1, Math.floor(Number(params.page) || 1))
    const pageSize = Math.max(1, Math.min(10000, Math.floor(Number(params.pageSize) || 50)))
    const skip = (page - 1) * pageSize

    let filter: Record<string, unknown> = {}
    const rawWhere = typeof params.whereClause === 'string' ? params.whereClause.trim() : ''
    if (rawWhere) {
      if (rawWhere.startsWith('{')) {
        try {
          filter = parseRelaxedMongoObject(rawWhere, 'whereClause')
        } catch (err: unknown) {
          throw new DatabaseDriverError(
            `Invalid MongoDB filter JSON: ${err instanceof Error ? err.message : String(err)}`,
            'invalid_params',
            'mongodb',
            err
          )
        }
      } else {
        try {
          filter = translateSqlFilterToMongoFilter(rawWhere)
        } catch (err: unknown) {
          throw new DatabaseDriverError(
            `Invalid filter clause: ${err instanceof Error ? err.message : String(err)}`,
            'invalid_params',
            'mongodb',
            err
          )
        }
      }
    }

    let sort: Record<string, 1 | -1> = {}
    if (typeof params.orderByClause === 'string' && params.orderByClause.trim().length > 0) {
      sort = parseMongoOrderByClause(params.orderByClause)
    } else if (typeof params.sortColumn === 'string' && params.sortColumn.trim().length > 0) {
      sort = {
        [params.sortColumn.trim()]:
          String(params.sortDirection || 'ASC').toUpperCase() === 'DESC' ? -1 : 1,
      }
    }

    return await this.runScrubbed('Failed to fetch MongoDB page', 'QUERY_ERROR', async () => {
      const coll = this.client.db(targetDb).collection(params.table)
      const sessionOpts = params.bypassTransaction
        ? undefined
        : await this.ensureTxSessionOptionsIfManual()
      const totalRows = await coll.countDocuments(filter, sessionOpts)
      let cursor = coll.find(filter, sessionOpts)
      if (Object.keys(sort).length > 0) {
        cursor = cursor.sort(sort)
      }
      const rawDocs = await cursor.skip(skip).limit(pageSize).toArray()
      const serializedRows = rawDocs.map((doc) => serializeMongoDocument(doc))

      // Merge any keys present in this page that were missing from initial schema sample
      const knownCols = new Set(details.columns.map((c) => c.name))
      const columns = [...details.columns]
      for (const doc of rawDocs) {
        for (const [k, v] of Object.entries(doc)) {
          if (knownCols.has(k)) continue
          knownCols.add(k)
          const typeName = detectBsonTypeName(v)
          columns.push({
            name: k,
            type: typeName,
            nativeType: typeName,
            nullable: k !== '_id',
            defaultValue: null,
            isPrimaryKey: !isView && k === '_id',
            isAutoIncrement: false,
          })
        }
      }

      if (columns.length > details.columns.length) {
        this.tableDetailsCache.set(targetDb, this.dbName, params.table, {
          ...details,
          columns,
        })
      }
      this.recordKnownColumnTypes(
        targetDb,
        params.table,
        columns.map((c) => [c.name, c.nativeType || c.type])
      )

      const canEdit = !this.profile.readOnly && !isView && details.primaryKey.length > 0
      return {
        columns,
        rows: serializedRows,
        totalRows,
        page,
        pageSize,
        primaryKey: details.primaryKey,
        canEdit,
      }
    })
  }

  private assertWritable(): void {
    if (this.profile.readOnly) {
      throw new DatabaseDriverError(
        'Connection is Read-Only. Uncheck Read-Only in connection settings to modify data.',
        'READ_ONLY',
        'mongodb'
      )
    }
  }

  private runExclusiveTxOp<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.txOpChain
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.txOpChain = prev.then(
      () => gate,
      () => gate
    )
    return prev.catch(() => {}).then(fn).finally(() => release())
  }

  private async beginTransactionLocked(): Promise<TransactionState> {
    this.assertOpen()
    if (this.activeTxSession !== null) {
      throw new DatabaseDriverError(
        'Transaction is already active',
        'TX_ALREADY_ACTIVE',
        'mongodb'
      )
    }
    const cs = this.client.startSession()
    try {
      cs.startTransaction()
    } catch (err: unknown) {
      await cs.endSession().catch(() => {})
      throw new DatabaseDriverError(
        scrubMongoErrorMessage(err, 'Failed to start MongoDB transaction'),
        'TX_START_FAILED',
        'mongodb',
        err
      )
    }
    this.activeTxSession = cs
    this.statementCount = 0
    this.txStartedAt = Date.now()
    return this.getTransactionState()
  }

  private async ensureTxSessionOptionsIfManual(): Promise<Record<string, unknown> | undefined> {
    if (!this.autoCommit && this.activeTxSession === null) {
      await this.runExclusiveTxOp(async () => {
        if (!this.autoCommit && this.activeTxSession === null) {
          await this.beginTransactionLocked()
        }
      })
    }
    return this.activeTxSession ? { session: this.activeTxSession } : undefined
  }

  private validateDottedFieldPath(fieldPath: string): void {
    if (!fieldPath || typeof fieldPath !== 'string') {
      throw new DatabaseDriverError('Field path is required', 'invalid_params', 'mongodb')
    }
    for (const seg of fieldPath.split('.')) {
      if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') {
        throw new DatabaseDriverError(
          `Disallowed field path segment "${seg}"`,
          'invalid_params',
          'mongodb'
        )
      }
    }
  }

  private buildPkFilter(
    primaryKeys: Record<string, unknown>,
    columnTypes?: Record<string, string>,
    forcedCol?: string,
    forcedColType?: string
  ): Record<string, unknown> {
    const entries = Object.entries(primaryKeys || {}).filter(([, v]) => v !== undefined)
    if (entries.length === 0) {
      throw new DatabaseDriverError(
        'Primary key conditions are required for MongoDB record mutation',
        'invalid_params',
        'mongodb'
      )
    }
    const filter: Record<string, unknown> = {}
    for (const [k, rawVal] of entries) {
      this.validateDottedFieldPath(k)
      const explicitType = this.normalizeColumnType(
        forcedCol === k && forcedColType ? forcedColType : columnTypes?.[k]
      )
      const callerForcedString =
        forcedCol === k && this.normalizeColumnType(forcedColType) === 'String'
      if ((k === '_id' || explicitType === 'ObjectId') && typeof rawVal === 'string' && HEX_24_RE.test(rawVal.trim())) {
        filter[k] = callerForcedString ? rawVal : { $in: [new ObjectId(rawVal.trim()), rawVal] }
      } else if (
        typeof rawVal === 'string' &&
        (explicitType === 'Date' ||
          explicitType === 'Decimal128' ||
          explicitType === 'Long' ||
          explicitType === 'UUID')
      ) {
        const pred = this.buildOptimisticPredicate(k, rawVal, explicitType)
        filter[k] = pred && Object.prototype.hasOwnProperty.call(pred, k) ? pred[k] : hydrateEjsonValues(rawVal)
      } else {
        filter[k] = hydrateEjsonValues(rawVal)
      }
    }
    return filter
  }

  private normalizeColumnType(columnType?: string): string | undefined {
    if (!columnType) return undefined
    const canonical: Record<string, string> = {
      objectid: 'ObjectId',
      decimal128: 'Decimal128',
      decimal: 'Decimal128',
      long: 'Long',
      int64: 'Long',
      bigint: 'Long',
      int32: 'Int32',
      int: 'Int32',
      double: 'Double',
      float: 'Double',
      boolean: 'Boolean',
      bool: 'Boolean',
      date: 'Date',
      datetime: 'Date',
      uuid: 'UUID',
      object: 'Object',
      array: 'Array',
      string: 'String',
    }
    return canonical[columnType.trim().toLowerCase()] ?? columnType
  }

  private coerceInputValue(value: unknown, columnType?: string): unknown {
    if (value === null || value === undefined) return value
    if (isPlainRecord(value)) return hydrateEjsonValues(value)
    const normType = this.normalizeColumnType(columnType)
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (normType === 'ObjectId' && HEX_24_RE.test(trimmed)) {
        return new ObjectId(trimmed)
      }
      if (normType === 'Decimal128' && trimmed.length > 0) {
        try {
          return Decimal128.fromString(trimmed)
        } catch {
          return value
        }
      }
      if (normType === 'Long' && /^-?\d+$/.test(trimmed)) {
        try {
          return Long.fromString(trimmed)
        } catch {
          return value
        }
      }
      if (normType === 'Int32' && /^-?\d+$/.test(trimmed)) {
        const n = Number(trimmed)
        if (Number.isSafeInteger(n) && n >= -2147483648 && n <= 2147483647) {
          return n
        }
      }
      if (normType === 'Double' && /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
        const n = Number(trimmed)
        if (Number.isFinite(n)) return n
      }
      if (normType === 'Boolean') {
        if (/^true$/i.test(trimmed)) return true
        if (/^false$/i.test(trimmed)) return false
      }
      if (normType === 'Date' && trimmed.length > 0) {
        const d = new Date(value)
        if (!Number.isNaN(d.getTime())) return d
      }
      if (normType === 'UUID' && trimmed.length > 0) {
        try {
          return new UUID(trimmed)
        } catch {
          return value
        }
      }
      if (normType === 'Object' || normType === 'Array') {
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            return parseRelaxedMongoValue(trimmed)
          } catch {
            return value
          }
        }
      }
    } else if (typeof value === 'number') {
      if (normType === 'Decimal128' && Number.isFinite(value)) {
        try {
          return Decimal128.fromString(String(value))
        } catch {
          return value
        }
      }
      if (normType === 'Long' && Number.isSafeInteger(value)) {
        return Long.fromNumber(value)
      }
    } else if (typeof value === 'bigint' && normType === 'Long') {
      return Long.fromBigInt(value)
    }
    return hydrateEjsonValues(value)
  }

  private buildOptimisticPredicate(
    column: string,
    origVal: unknown,
    columnType?: string
  ): Record<string, unknown> | null {
    if (origVal === undefined) return null
    const normType = this.normalizeColumnType(columnType)
    if (normType === 'Double') return null
    if (typeof origVal === 'string' && /^\[BLOB\s+\d+\s*B\]$/i.test(origVal.trim())) return null
    if (origVal === null) return { [column]: null }
    if (typeof origVal === 'object' && !isBsonInstance(origVal)) {
      if (isPlainRecord(origVal)) {
        const keys = Object.keys(origVal)
        if (keys.length > 0 && EJSON_WRAPPER_KEYS.has(keys[0])) {
          return { [column]: hydrateEjsonValues(origVal) }
        }
      }
      return null
    }
    if (typeof origVal === 'string') {
      const trimmed = origVal.trim()
      if ((column === '_id' || normType === 'ObjectId') && HEX_24_RE.test(trimmed)) {
        return { [column]: { $in: [new ObjectId(trimmed), origVal] } }
      }
      if (normType === 'Decimal128' && trimmed.length > 0) {
        try {
          return { [column]: { $in: [Decimal128.fromString(trimmed), origVal] } }
        } catch {
          return { [column]: origVal }
        }
      }
      if (normType === 'Date' && trimmed.length > 0) {
        const d = new Date(origVal)
        if (!Number.isNaN(d.getTime())) {
          return { [column]: { $in: [d, origVal] } }
        }
      }
      if (normType === 'Long' && /^-?\d+$/.test(trimmed)) {
        try {
          return { [column]: { $in: [Long.fromString(trimmed), origVal] } }
        } catch {
          return { [column]: origVal }
        }
      }
      if (normType === 'UUID' && trimmed.length > 0) {
        try {
          return { [column]: { $in: [new UUID(trimmed), origVal] } }
        } catch {
          return { [column]: origVal }
        }
      }
      if (normType === 'Int32' && /^-?\d+$/.test(trimmed)) {
        const n = Number(trimmed)
        if (Number.isSafeInteger(n)) {
          return { [column]: { $in: [n, origVal] } }
        }
      }
    }
    if (typeof origVal === 'number') {
      if (normType === 'Long' && Number.isSafeInteger(origVal)) {
        return { [column]: { $in: [Long.fromNumber(origVal), origVal] } }
      }
      if (normType === 'Decimal128' && Number.isFinite(origVal)) {
        try {
          return { [column]: { $in: [Decimal128.fromString(String(origVal)), origVal] } }
        } catch {
          return { [column]: origVal }
        }
      }
    }
    if (typeof origVal === 'bigint' && normType === 'Long') {
      return { [column]: Long.fromBigInt(origVal) }
    }
    return { [column]: origVal }
  }

  private combineFilters(parts: Record<string, unknown>[]): Record<string, unknown> {
    const merged: Record<string, unknown> = {}
    const extras: Record<string, unknown>[] = []
    for (const part of parts) {
      for (const [k, v] of Object.entries(part)) {
        if (k === '$and' || Object.prototype.hasOwnProperty.call(merged, k)) {
          extras.push({ [k]: v })
        } else {
          merged[k] = v
        }
      }
    }
    if (extras.length === 0) return merged
    return { $and: [merged, ...extras] }
  }

  async updateCell(params: UpdateCellParams): Promise<UpdateCellResult> {
    this.assertOpen()
    this.assertWritable()
    this.validateDottedFieldPath(params.column)

    const targetDb = params.schema?.trim() || this.dbName
    const resolvedTypes = await this.resolveCollectionColumnTypes(
      targetDb,
      params.table,
      params.columnType ? { [params.column]: params.columnType } : undefined
    )
    const columnType = resolvedTypes[params.column]
    const pkFilter = this.buildPkFilter(
      params.primaryKeys,
      resolvedTypes,
      params.column,
      params.columnType
    )
    const optLock = this.buildOptimisticPredicate(
      params.column,
      params.originalValue,
      columnType
    )
    const filter = optLock ? this.combineFilters([pkFilter, optLock]) : pkFilter
    const coercedNewVal = this.coerceInputValue(params.newValue, columnType)
    if (!columnType && coercedNewVal !== null && coercedNewVal !== undefined) {
      this.recordKnownColumnTypes(targetDb, params.table, [
        [params.column, detectBsonTypeName(coercedNewVal)],
      ])
    }

    return await this.runScrubbed('Failed to update MongoDB cell', 'QUERY_ERROR', async () => {
      return await this.runExclusiveTxOp(async () => {
        this.assertOpen()
        if (!this.autoCommit && this.activeTxSession === null) {
          await this.beginTransactionLocked()
        }
        const sessionOpts = this.activeTxSession ? { session: this.activeTxSession } : undefined
        const coll = this.client.db(targetDb).collection(params.table)
        const res = await coll.updateOne(filter, { $set: { [params.column]: coercedNewVal } }, sessionOpts)
        const matched = Number(res.matchedCount ?? 0)
        if (matched === 0) {
          throw new DatabaseDriverError(
            'Record was modified or deleted by another session (optimistic lock conflict)',
            'conflict',
            'mongodb'
          )
        }
        if (this.activeTxSession !== null) {
          this.statementCount++
        }

        const readbackPk: Record<string, unknown> = { ...params.primaryKeys }
        if (Object.prototype.hasOwnProperty.call(readbackPk, params.column)) {
          readbackPk[params.column] = coercedNewVal
        }
        const readbackFilter = this.buildPkFilter(
          readbackPk,
          resolvedTypes,
          params.column,
          params.columnType
        )
        const updatedDoc = await coll.findOne(readbackFilter, sessionOpts).catch(() => null)
        this.tableDetailsCache.clear()
        return {
          ok: true,
          affectedRows: matched,
          updatedRecord: updatedDoc ? serializeMongoDocument(updatedDoc) : undefined,
        }
      })
    })
  }

  private async buildChangePlan(params: ApplyChangesParams): Promise<{
    deletes: Array<{ filter: Record<string, unknown>; preview: string }>
    updates: Array<{ filter: Record<string, unknown>; setDoc: Record<string, unknown>; preview: string }>
    inserts: Array<{ doc: Record<string, unknown>; preview: string }>
  }> {
    const targetDb = params.schema?.trim() || this.dbName
    const columnTypes = await this.resolveCollectionColumnTypes(
      targetDb,
      params.table,
      params.columnTypes
    )
    const safeCollLiteral = JSON.stringify(params.table)

    const rawDeletes = params.deletes ?? []
    const rawDeleteRows = params.deleteRows
    if (rawDeleteRows !== undefined) {
      if (!Array.isArray(rawDeleteRows) || rawDeleteRows.length !== rawDeletes.length) {
        throw new DatabaseDriverError(
          'MongoDB deleteRows length must match deletes length',
          'invalid_params',
          'mongodb'
        )
      }
    }

    const deletes: Array<{ filter: Record<string, unknown>; preview: string }> = []
    for (let i = 0; i < rawDeletes.length; i++) {
      const pk = rawDeletes[i]
      const pkFilter = this.buildPkFilter(pk, columnTypes)
      const parts: Record<string, unknown>[] = [pkFilter]
      const origRow = rawDeleteRows?.[i]
      if (origRow !== undefined) {
        if (!origRow || typeof origRow !== 'object' || Array.isArray(origRow)) {
          throw new DatabaseDriverError(
            'MongoDB deleteRows entry must be a row object',
            'invalid_params',
            'mongodb'
          )
        }
        for (const [k, origVal] of Object.entries(origRow)) {
          if (Object.prototype.hasOwnProperty.call(pk, k)) continue
          this.validateDottedFieldPath(k)
          const opt = this.buildOptimisticPredicate(k, origVal, columnTypes[k])
          if (opt) parts.push(opt)
        }
      }
      const filter = this.combineFilters(parts)
      deletes.push({
        filter,
        preview: `db.getCollection(${safeCollLiteral}).deleteOne(${EJSON.stringify(filter)});`,
      })
    }

    const updates: Array<{ filter: Record<string, unknown>; setDoc: Record<string, unknown>; preview: string }> = []
    for (const upd of params.updates ?? []) {
      const pkFilter = this.buildPkFilter(upd.primaryKeys, columnTypes)
      const changeEntries = Object.entries(upd.changes || {}).filter(([, v]) => v !== undefined)
      if (changeEntries.length === 0) continue

      const setDoc: Record<string, unknown> = {}
      const parts: Record<string, unknown>[] = [pkFilter]
      for (const [col, newVal] of changeEntries) {
        this.validateDottedFieldPath(col)
        const coerced = this.coerceInputValue(newVal, columnTypes[col])
        setDoc[col] = coerced
        if (!columnTypes[col] && coerced !== null && coerced !== undefined) {
          this.recordKnownColumnTypes(targetDb, params.table, [[col, detectBsonTypeName(coerced)]])
        }
        if (upd.originalRow && Object.prototype.hasOwnProperty.call(upd.originalRow, col)) {
          const opt = this.buildOptimisticPredicate(col, upd.originalRow[col], columnTypes[col])
          if (opt) parts.push(opt)
        }
      }
      const filter = this.combineFilters(parts)
      updates.push({
        filter,
        setDoc,
        preview: `db.getCollection(${safeCollLiteral}).updateOne(${EJSON.stringify(filter)}, ${EJSON.stringify({ $set: setDoc })});`,
      })
    }

    const inserts: Array<{ doc: Record<string, unknown>; preview: string }> = []
    for (const rawDoc of params.inserts ?? []) {
      const doc: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(rawDoc || {})) {
        if (v === undefined || k === '__proto__' || k === 'constructor' || k === 'prototype') continue
        const coerced = this.coerceInputValue(v, columnTypes[k])
        doc[k] = coerced
        if (!columnTypes[k] && coerced !== null && coerced !== undefined) {
          this.recordKnownColumnTypes(targetDb, params.table, [[k, detectBsonTypeName(coerced)]])
        }
      }
      inserts.push({
        doc,
        preview: `db.getCollection(${safeCollLiteral}).insertOne(${EJSON.stringify(doc)});`,
      })
    }

    return { deletes, updates, inserts }
  }

  private isStandaloneTransactionUnsupported(err: unknown): boolean {
    const queue: unknown[] = [err]
    const visited = new Set<unknown>()
    while (queue.length > 0) {
      const node = queue.shift()
      if (!node || visited.has(node)) continue
      if (typeof node === 'object') {
        visited.add(node)
        const code = Number(Reflect.get(node, 'code'))
        if (code === 20 || code === 263) return true
        const codeName = String(Reflect.get(node, 'codeName') ?? '')
        if (codeName === 'IllegalOperation') return true
        for (const prop of ['originalError', 'cause', 'errorResponse']) {
          const nested = Reflect.get(node, prop)
          if (nested) queue.push(nested)
        }
      }
      const msg =
        node instanceof Error
          ? node.message
          : typeof node === 'string'
            ? node
            : typeof node === 'object'
              ? String(Reflect.get(node, 'errmsg') ?? '')
              : ''
      if (
        /Transaction numbers are only allowed on a replica set|Standalone servers do not support transactions|does not support transactions|Sessions are not supported|does not support retryable writes|retryable writes.*not supported/i.test(
          msg
        )
      ) {
        return true
      }
    }
    return false
  }

  private async executePlanMutations(
    coll: MongoCollectionLike,
    plan: Awaited<ReturnType<MongoSession['buildChangePlan']>>,
    execOpts?: Record<string, unknown>
  ): Promise<{ deleted: number; updated: number; inserted: number }> {
    let deleted = 0
    for (const del of plan.deletes) {
      const res = await coll.deleteOne(del.filter, execOpts)
      const count = Number(res.deletedCount ?? 0)
      if (count === 0) {
        throw new DatabaseDriverError(
          'Record was modified or deleted by another session (optimistic lock conflict)',
          'conflict',
          'mongodb'
        )
      }
      deleted += count
    }

    let updated = 0
    for (const upd of plan.updates) {
      const res = await coll.updateOne(upd.filter, { $set: upd.setDoc }, execOpts)
      const count = Number(res.matchedCount ?? 0)
      if (count === 0) {
        throw new DatabaseDriverError(
          'Record was modified or deleted by another session (optimistic lock conflict)',
          'conflict',
          'mongodb'
        )
      }
      updated += count
    }

    let inserted = 0
    for (const ins of plan.inserts) {
      await coll.insertOne(ins.doc, execOpts)
      inserted += 1
    }

    return { deleted, updated, inserted }
  }

  async applyChanges(params: ApplyChangesParams): Promise<ApplyChangesResult> {
    this.assertOpen()
    this.assertWritable()

    const targetDb = params.schema?.trim() || this.dbName
    const plan = await this.buildChangePlan(params)
    const statements = [
      ...plan.deletes.map((d) => d.preview),
      ...plan.updates.map((u) => u.preview),
      ...plan.inserts.map((i) => i.preview),
    ]
    if (statements.length === 0) {
      return { ok: true, inserted: 0, updated: 0, deleted: 0, statements: [] }
    }

    return await this.runScrubbed('Failed to apply MongoDB changes', 'QUERY_ERROR', async () => {
      return await this.runExclusiveTxOp(async () => {
        this.assertOpen()
        if (!this.autoCommit && this.activeTxSession === null) {
          await this.beginTransactionLocked()
        }

        const coll = this.client.db(targetDb).collection(params.table)
        if (this.activeTxSession !== null) {
          const counts = await this.executePlanMutations(coll, plan, {
            session: this.activeTxSession,
          })
          this.statementCount += statements.length
          this.tableDetailsCache.clear()
          return { ok: true, ...counts, statements }
        }

        const txSession = this.client.startSession()
        try {
          const counts = await txSession.withTransaction(async () =>
            this.executePlanMutations(coll, plan, { session: txSession })
          )
          this.tableDetailsCache.clear()
          return { ok: true, ...counts, statements }
        } catch (err: unknown) {
          if (!this.isStandaloneTransactionUnsupported(err)) {
            throw err
          }

          // Standalone mongod fallback: pre-flight all delete/update locks and snapshot originals for compensating rollback
          const deletedOriginals: Record<string, unknown>[] = []
          const updatedOriginals: Array<{ filter: Record<string, unknown>; original: Record<string, unknown> }> = []
          const insertedIds: unknown[] = []

          for (const del of plan.deletes) {
            const existing = await coll.findOne(del.filter)
            if (!existing) {
              throw new DatabaseDriverError(
                'Record was modified or deleted by another session (optimistic lock conflict)',
                'conflict',
                'mongodb'
              )
            }
            deletedOriginals.push(existing)
          }
          for (const upd of plan.updates) {
            const existing = await coll.findOne(upd.filter)
            if (!existing) {
              throw new DatabaseDriverError(
                'Record was modified or deleted by another session (optimistic lock conflict)',
                'conflict',
                'mongodb'
              )
            }
            updatedOriginals.push({ filter: { _id: existing._id }, original: existing })
          }

          let deleted = 0
          let updated = 0
          let inserted = 0
          try {
            for (const del of plan.deletes) {
              const res = await coll.deleteOne(del.filter)
              if (Number(res.deletedCount ?? 0) === 0) {
                throw new DatabaseDriverError(
                  'Record was modified or deleted by another session (optimistic lock conflict)',
                  'conflict',
                  'mongodb'
                )
              }
              deleted += 1
            }
            for (const upd of plan.updates) {
              const res = await coll.updateOne(upd.filter, { $set: upd.setDoc })
              if (Number(res.matchedCount ?? 0) === 0) {
                throw new DatabaseDriverError(
                  'Record was modified or deleted by another session (optimistic lock conflict)',
                  'conflict',
                  'mongodb'
                )
              }
              updated += 1
            }
            for (const ins of plan.inserts) {
              const res = await coll.insertOne(ins.doc)
              if (res.insertedId !== undefined) insertedIds.push(res.insertedId)
              inserted += 1
            }
            this.tableDetailsCache.clear()
            return { ok: true, deleted, updated, inserted, statements }
          } catch (fallbackErr: unknown) {
            for (const insId of insertedIds) {
              await coll.deleteOne({ _id: insId }).catch(() => {})
            }
            for (let i = 0; i < updated && i < updatedOriginals.length; i++) {
              const item = updatedOriginals[i]
              await coll.replaceOne(item.filter, item.original).catch(() => {})
            }
            for (let i = 0; i < deleted && i < deletedOriginals.length; i++) {
              await coll.insertOne(deletedOriginals[i]).catch(() => {})
            }
            throw fallbackErr
          }
        } finally {
          await txSession.endSession().catch(() => {})
        }
      })
    })
  }

  async previewChanges(params: ApplyChangesParams): Promise<PreviewChangesResult> {
    this.assertOpen()
    const plan = await this.buildChangePlan(params)
    return {
      statements: [
        ...plan.deletes.map((d) => d.preview),
        ...plan.updates.map((u) => u.preview),
        ...plan.inserts.map((i) => i.preview),
      ],
    }
  }

  async getDdl(table: string, schema?: string): Promise<string> {
    this.assertOpen()
    const details = await this.getTableDetails(table, schema)
    return details.ddl || `// MongoDB Collection: ${schema?.trim() || this.dbName}.${table}`
  }

  async getObjectDdl(name: string, kind: SchemaObjectKind, schema?: string): Promise<string> {
    this.assertOpen()
    const targetDb = schema?.trim() || this.dbName
    if (kind === 'table' || kind === 'view') {
      return this.getDdl(name, targetDb)
    }
    return `// MongoDB ${kind}: ${targetDb}.${name}`
  }

  async exportSchemaDdl(schema?: string): Promise<{ ddl: string; objectCount: number }> {
    this.assertOpen()
    const targetDb = schema?.trim() || this.dbName
    return await this.runScrubbed('Failed to export MongoDB schema DDL', 'QUERY_ERROR', async () => {
      const objects = await this.listObjects(targetDb)
      const sections: string[] = [
        '// Datanoa MongoDB Schema Export',
        `// Database: ${targetDb}`,
        '',
      ]
      let objectCount = 0
      for (const obj of objects) {
        try {
          const ddl = await this.getObjectDdl(obj.name, obj.kind, targetDb)
          sections.push(`// ${obj.kind}: ${obj.name}`, ddl, '')
          objectCount++
        } catch (err: unknown) {
          sections.push(
            `// Failed to export ${obj.kind} ${obj.name}: ${scrubMongoErrorMessage(err)}`,
            ''
          )
        }
      }
      return {
        ddl: `${sections.join('\n').trimEnd()}\n`,
        objectCount,
      }
    })
  }

  private buildCallOptions(
    active: ActiveMongoQuery,
    baseOpts?: Record<string, unknown>
  ): Record<string, unknown> {
    return {
      ...(baseOpts ?? {}),
      ...(this.activeTxSession ? { session: this.activeTxSession } : {}),
      signal: active.controller.signal,
    }
  }

  private async executeRawCommandStatement(
    db: MongoDbLike,
    cmdObj: Record<string, unknown>,
    active: ActiveMongoQuery,
    maxRows: number
  ): Promise<Omit<QueryResult, 'executionTimeMs'> & { mutates: boolean }> {
    const callOpts = this.buildCallOptions(active)
    const mutates = !isMongoCommandRecordReadOnly(cmdObj)
    const rawRes = await db.command(cmdObj, callOpts)
    const cursor = isPlainRecord(rawRes.cursor) ? rawRes.cursor : null
    if (cursor && Array.isArray(cursor.firstBatch)) {
      const batch = cursor.firstBatch.filter((item): item is Record<string, unknown> =>
        isPlainRecord(item)
      )
      const limit = maxRows > 0 ? maxRows : batch.length
      const truncated = batch.length > limit
      const sliced = batch.slice(0, limit)
      return { ...buildQueryResultFromDocs(sliced, truncated), mutates }
    }
    if (Array.isArray(rawRes.databases)) {
      const dbs = rawRes.databases.filter((item): item is Record<string, unknown> =>
        isPlainRecord(item)
      )
      return { ...buildQueryResultFromDocs(dbs, false), mutates }
    }
    if (Array.isArray(rawRes.values)) {
      return {
        columns: [{ name: 'value', type: 'Mixed' }],
        rows: rawRes.values.map((v) => [serializeMongoValue(v)]),
        rowCount: rawRes.values.length,
        truncated: false,
        isSelect: true,
        mutates,
      }
    }
    return { ...buildQueryResultFromDocs([rawRes], false), mutates }
  }

  private async executeSingleMongoStatement(
    stmt: ParsedMongoStatement,
    currentDbName: string,
    active: ActiveMongoQuery,
    maxRows: number
  ): Promise<{ result: Omit<QueryResult, 'executionTimeMs'>; nextDbName: string; mutates: boolean }> {
    if (active.cancelled || active.controller.signal.aborted || this.isClosed) {
      throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'mongodb')
    }

    const db = this.client.db(currentDbName)
    switch (stmt.kind) {
      case 'use_db': {
        return {
          result: {
            columns: [{ name: 'switched_to_db', type: 'String' }],
            rows: [[stmt.dbName]],
            rowCount: 1,
            truncated: false,
            isSelect: true,
          },
          nextDbName: stmt.dbName,
          mutates: false,
        }
      }

      case 'show_dbs': {
        const res = await db.admin().listDatabases()
        const docs = (res.databases || []).map((d) => ({
          name: d.name,
          sizeOnDisk: d.sizeOnDisk ?? 0,
          empty: Boolean(d.empty),
        }))
        return {
          result: buildQueryResultFromDocs(docs, false),
          nextDbName: currentDbName,
          mutates: false,
        }
      }

      case 'show_collections': {
        const cols = await db.listCollections({}, { nameOnly: false }).toArray()
        const docs = cols
          .filter((c) => c.name && !String(c.name).startsWith('system.'))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
          .map((c) => ({ name: c.name, type: c.type || 'collection' }))
        return {
          result: buildQueryResultFromDocs(docs, false),
          nextDbName: currentDbName,
          mutates: false,
        }
      }

      case 'collection_shorthand': {
        const coll = db.collection(stmt.collection)
        const limit = Math.min(100, maxRows > 0 ? maxRows : 100)
        const cursor = coll.find({}, this.buildCallOptions(active)).limit(limit + 1)
        active.activeCursor = cursor
        try {
          const docs = await cursor.toArray()
          const truncated = docs.length > limit
          const sliced = truncated ? docs.slice(0, limit) : docs
          return {
            result: buildQueryResultFromDocs(sliced, truncated, {
              table: stmt.collection,
              schema: currentDbName,
            }),
            nextDbName: currentDbName,
            mutates: false,
          }
        } finally {
          active.activeCursor = undefined
        }
      }

      case 'raw_command': {
        const res = await this.executeRawCommandStatement(db, stmt.command, active, maxRows)
        const { mutates, ...queryRes } = res
        return { result: queryRes, nextDbName: currentDbName, mutates }
      }

      case 'db_method': {
        const callOpts = this.buildCallOptions(active)
        switch (stmt.method) {
          case 'stats': {
            const opts = isPlainRecord(stmt.args[0]) ? stmt.args[0] : undefined
            const statsRes =
              typeof db.stats === 'function'
                ? await db.stats({ ...(opts ?? {}), ...callOpts })
                : await db.command({ dbStats: 1, ...(opts ?? {}) }, callOpts)
            return {
              result: buildQueryResultFromDocs([statsRes], false),
              nextDbName: currentDbName,
              mutates: false,
            }
          }
          case 'serverStatus': {
            const admin = db.admin()
            const status =
              typeof admin.serverStatus === 'function'
                ? await admin.serverStatus()
                : await admin.command({ serverStatus: 1 }, callOpts)
            return {
              result: buildQueryResultFromDocs([status], false),
              nextDbName: currentDbName,
              mutates: false,
            }
          }
          case 'getCollectionNames': {
            const cols = await db.listCollections({}, { nameOnly: true }).toArray()
            const rows = cols
              .filter((c) => c.name && !String(c.name).startsWith('system.'))
              .map((c) => [c.name])
            return {
              result: {
                columns: [{ name: 'name', type: 'String' }],
                rows,
                rowCount: rows.length,
                truncated: false,
                isSelect: true,
              },
              nextDbName: currentDbName,
              mutates: false,
            }
          }
          case 'runCommand': {
            if (!isPlainRecord(stmt.args[0])) {
              throw new DatabaseDriverError(
                'db.runCommand requires a command object argument',
                'invalid_params',
                'mongodb'
              )
            }
            const res = await this.executeRawCommandStatement(db, stmt.args[0], active, maxRows)
            const { mutates, ...queryRes } = res
            return { result: queryRes, nextDbName: currentDbName, mutates }
          }
          case 'adminCommand': {
            if (!isPlainRecord(stmt.args[0])) {
              throw new DatabaseDriverError(
                'db.adminCommand requires a command object argument',
                'invalid_params',
                'mongodb'
              )
            }
            const adminRes = await db.admin().command(stmt.args[0], callOpts)
            return {
              result: buildQueryResultFromDocs([adminRes], false),
              nextDbName: currentDbName,
              mutates: !isMongoCommandRecordReadOnly(stmt.args[0]),
            }
          }
          case 'createCollection': {
            const collName = typeof stmt.args[0] === 'string' ? stmt.args[0] : ''
            if (!collName) {
              throw new DatabaseDriverError(
                'db.createCollection requires a collection name string',
                'invalid_params',
                'mongodb'
              )
            }
            const collOpts = isPlainRecord(stmt.args[1]) ? { ...stmt.args[1] } : {}
            delete collOpts.signal
            const createOpts: Record<string, unknown> = {
              ...collOpts,
              ...(this.activeTxSession ? { session: this.activeTxSession } : {}),
            }
            await db.createCollection(collName, createOpts)
            return {
              result: {
                columns: [{ name: 'ok', type: 'Int32' }, { name: 'collection', type: 'String' }],
                rows: [[1, collName]],
                rowCount: 1,
                affectedRows: 1,
                truncated: false,
                isSelect: false,
              },
              nextDbName: currentDbName,
              mutates: true,
            }
          }
          case 'dropDatabase': {
            await db.command({ dropDatabase: 1 }, callOpts)
            return {
              result: {
                columns: [{ name: 'ok', type: 'Int32' }],
                rows: [[1]],
                rowCount: 1,
                affectedRows: 1,
                truncated: false,
                isSelect: false,
              },
              nextDbName: currentDbName,
              mutates: true,
            }
          }
          default:
            throw new DatabaseDriverError(
              `Unsupported db method: db.${stmt.method}()`,
              'SYNTAX_ERROR',
              'mongodb'
            )
        }
      }

      case 'collection_method': {
        return await this.executeCollectionMethodStatement(db, currentDbName, stmt, active, maxRows)
      }
    }
  }

  private async executeCollectionMethodStatement(
    db: MongoDbLike,
    currentDbName: string,
    stmt: Extract<ParsedMongoStatement, { kind: 'collection_method' }>,
    active: ActiveMongoQuery,
    maxRows: number
  ): Promise<{ result: Omit<QueryResult, 'executionTimeMs'>; nextDbName: string; mutates: boolean }> {
    const coll = db.collection(stmt.collection)
    const callOpts = this.buildCallOptions(active)

    const validateAllowedChains = (allowed: ReadonlySet<string>): void => {
      for (const ch of stmt.chains) {
        if (!allowed.has(ch.method)) {
          throw new DatabaseDriverError(
            `Method ".${ch.method}()" cannot be chained onto ".${stmt.method}()"`,
            'SYNTAX_ERROR',
            'mongodb'
          )
        }
      }
    }

    switch (stmt.method) {
      case 'find': {
        validateAllowedChains(
          new Set(['sort', 'skip', 'limit', 'project', 'projection', 'count', 'explain', 'toArray'])
        )
        const filter = isPlainRecord(stmt.args[0]) ? stmt.args[0] : {}
        const initProj = isPlainRecord(stmt.args[1]) ? stmt.args[1] : undefined
        let sortSpec: Record<string, unknown> | undefined
        let skipNum: number | undefined
        let limitNum: number | undefined
        let projSpec = initProj
        let countMode = false
        let explainVerbosity: string | null = null

        for (const chain of stmt.chains) {
          switch (chain.method) {
            case 'sort':
              if (!isPlainRecord(chain.args[0])) {
                throw new DatabaseDriverError('.sort() requires a sort object', 'invalid_params', 'mongodb')
              }
              sortSpec = chain.args[0]
              break
            case 'skip':
              skipNum = Math.max(0, Math.floor(Number(chain.args[0] ?? 0)))
              break
            case 'limit':
              limitNum = Math.max(0, Math.floor(Number(chain.args[0] ?? 0)))
              break
            case 'project':
            case 'projection':
              if (!isPlainRecord(chain.args[0])) {
                throw new DatabaseDriverError(`.${chain.method}() requires a projection object`, 'invalid_params', 'mongodb')
              }
              projSpec = chain.args[0]
              break
            case 'count':
              countMode = true
              break
            case 'explain':
              explainVerbosity =
                typeof chain.args[0] === 'string' && chain.args[0].trim().length > 0
                  ? chain.args[0].trim()
                  : 'queryPlanner'
              break
            case 'toArray':
              break
          }
        }

        if (countMode) {
          const total = await coll.countDocuments(filter, callOpts)
          return {
            result: {
              columns: [{ name: 'count', type: 'Int32' }],
              rows: [[total]],
              rowCount: 1,
              truncated: false,
              isSelect: true,
            },
            nextDbName: currentDbName,
            mutates: false,
          }
        }

        let cursor = coll.find(filter, callOpts)
        if (sortSpec) cursor = cursor.sort(sortSpec)
        if (skipNum !== undefined) cursor = cursor.skip(skipNum)
        if (projSpec) cursor = cursor.project(projSpec)

        if (explainVerbosity !== null) {
          if (limitNum !== undefined && limitNum > 0) cursor = cursor.limit(limitNum)
          const explainDoc =
            typeof cursor.explain === 'function'
              ? await cursor.explain(explainVerbosity)
              : await db.command(
                  {
                    explain: {
                      find: stmt.collection,
                      filter,
                      ...(sortSpec ? { sort: sortSpec } : {}),
                      ...(skipNum !== undefined ? { skip: skipNum } : {}),
                      ...(limitNum !== undefined ? { limit: limitNum } : {}),
                      ...(projSpec ? { projection: projSpec } : {}),
                    },
                    verbosity: explainVerbosity,
                  },
                  callOpts
                )
          const doc = isPlainRecord(explainDoc) ? explainDoc : { result: explainDoc }
          return {
            result: buildQueryResultFromDocs([doc], false),
            nextDbName: currentDbName,
            mutates: false,
          }
        }

        const explicitLimit = limitNum !== undefined && limitNum > 0 ? limitNum : 0
        const exceedsMaxRows = maxRows > 0 && (explicitLimit === 0 || explicitLimit > maxRows)
        const driverLimit = exceedsMaxRows ? maxRows + 1 : explicitLimit
        if (driverLimit > 0) {
          cursor = cursor.limit(driverLimit)
        }

        active.activeCursor = cursor
        try {
          const docs = await cursor.toArray()
          const truncated = exceedsMaxRows && docs.length > maxRows
          const sliced = truncated ? docs.slice(0, maxRows) : docs
          return {
            result: buildQueryResultFromDocs(sliced, truncated, {
              table: stmt.collection,
              schema: currentDbName,
            }),
            nextDbName: currentDbName,
            mutates: false,
          }
        } finally {
          active.activeCursor = undefined
        }
      }

      case 'findOne': {
        validateAllowedChains(new Set())
        const filter = isPlainRecord(stmt.args[0]) ? stmt.args[0] : {}
        const projection = isPlainRecord(stmt.args[1]) ? stmt.args[1] : undefined
        const doc = await coll.findOne(filter, {
          ...callOpts,
          ...(projection ? { projection } : {}),
        })
        return {
          result: buildQueryResultFromDocs(doc ? [doc] : [], false, {
            table: stmt.collection,
            schema: currentDbName,
          }),
          nextDbName: currentDbName,
          mutates: false,
        }
      }

      case 'aggregate': {
        validateAllowedChains(new Set(['explain', 'toArray']))
        const rawPipeline = stmt.args[0]
        if (!Array.isArray(rawPipeline)) {
          throw new DatabaseDriverError(
            '.aggregate() requires an array pipeline',
            'invalid_params',
            'mongodb'
          )
        }
        const pipeline = rawPipeline.filter((stage): stage is Record<string, unknown> =>
          isPlainRecord(stage)
        )
        const aggOpts = isPlainRecord(stmt.args[1]) ? stmt.args[1] : undefined
        const explainChain = stmt.chains.find((c) => c.method === 'explain')
        const cursor = coll.aggregate(pipeline, { ...(aggOpts ?? {}), ...callOpts })
        if (explainChain) {
          const verbosity =
            typeof explainChain.args[0] === 'string' && explainChain.args[0].trim().length > 0
              ? explainChain.args[0].trim()
              : 'queryPlanner'
          const explainDoc =
            typeof cursor.explain === 'function'
              ? await cursor.explain(verbosity)
              : await db.command(
                  {
                    explain: { aggregate: stmt.collection, pipeline, cursor: {} },
                    verbosity,
                  },
                  callOpts
                )
          const doc = isPlainRecord(explainDoc) ? explainDoc : { result: explainDoc }
          return {
            result: buildQueryResultFromDocs([doc], false),
            nextDbName: currentDbName,
            mutates: false,
          }
        }

        active.activeCursor = cursor
        try {
          const docs = await cursor.toArray()
          const limit = maxRows > 0 ? maxRows : docs.length
          const truncated = docs.length > limit
          const sliced = truncated ? docs.slice(0, limit) : docs
          return {
            result: buildQueryResultFromDocs(sliced, truncated),
            nextDbName: currentDbName,
            mutates: hasMongoWriteStage(pipeline),
          }
        } finally {
          active.activeCursor = undefined
        }
      }

      case 'countDocuments': {
        validateAllowedChains(new Set())
        const filter = isPlainRecord(stmt.args[0]) ? stmt.args[0] : {}
        const extraOpts = isPlainRecord(stmt.args[1]) ? stmt.args[1] : undefined
        const count = await coll.countDocuments(filter, { ...(extraOpts ?? {}), ...callOpts })
        return {
          result: {
            columns: [{ name: 'count', type: 'Int32' }],
            rows: [[count]],
            rowCount: 1,
            truncated: false,
            isSelect: true,
          },
          nextDbName: currentDbName,
          mutates: false,
        }
      }

      case 'estimatedDocumentCount': {
        validateAllowedChains(new Set())
        const extraOpts = isPlainRecord(stmt.args[0]) ? stmt.args[0] : undefined
        const count = await coll.estimatedDocumentCount({ ...(extraOpts ?? {}), ...callOpts })
        return {
          result: {
            columns: [{ name: 'count', type: 'Int32' }],
            rows: [[count]],
            rowCount: 1,
            truncated: false,
            isSelect: true,
          },
          nextDbName: currentDbName,
          mutates: false,
        }
      }

      case 'distinct': {
        validateAllowedChains(new Set())
        const field = typeof stmt.args[0] === 'string' ? stmt.args[0] : ''
        if (!field) {
          throw new DatabaseDriverError(
            '.distinct() requires a field name string',
            'invalid_params',
            'mongodb'
          )
        }
        const filter = isPlainRecord(stmt.args[1]) ? stmt.args[1] : {}
        const extraOpts = isPlainRecord(stmt.args[2]) ? stmt.args[2] : undefined
        const values = await coll.distinct(field, filter, { ...(extraOpts ?? {}), ...callOpts })
        const limit = maxRows > 0 ? maxRows : values.length
        const truncated = values.length > limit
        const sliced = truncated ? values.slice(0, limit) : values
        return {
          result: {
            columns: [{ name: field, type: 'Mixed' }],
            rows: sliced.map((v) => [serializeMongoValue(v)]),
            rowCount: sliced.length,
            truncated,
            isSelect: true,
          },
          nextDbName: currentDbName,
          mutates: false,
        }
      }

      case 'getIndexes':
      case 'indexes': {
        validateAllowedChains(new Set())
        const rawIndexes = await coll.indexes(callOpts)
        return {
          result: buildQueryResultFromDocs(rawIndexes, false),
          nextDbName: currentDbName,
          mutates: false,
        }
      }

      case 'stats': {
        validateAllowedChains(new Set())
        let statsDoc: Record<string, unknown>
        try {
          statsDoc = await db.command({ collStats: stmt.collection }, callOpts)
        } catch {
          const aggDocs = await coll.aggregate([{ $collStats: { storageStats: {} } }], callOpts).toArray()
          statsDoc = aggDocs[0] ?? { ns: `${currentDbName}.${stmt.collection}` }
        }
        return {
          result: buildQueryResultFromDocs([statsDoc], false),
          nextDbName: currentDbName,
          mutates: false,
        }
      }

      case 'insertOne': {
        validateAllowedChains(new Set())
        if (!isPlainRecord(stmt.args[0])) {
          throw new DatabaseDriverError('.insertOne() requires a document object', 'invalid_params', 'mongodb')
        }
        const extraOpts = isPlainRecord(stmt.args[1]) ? stmt.args[1] : undefined
        const res = await coll.insertOne(stmt.args[0], { ...(extraOpts ?? {}), ...callOpts })
        const count = res.insertedId !== undefined ? 1 : 0
        return {
          result: {
            columns: [{ name: 'insertedId', type: 'Mixed' }],
            rows: [[serializeMongoValue(res.insertedId)]],
            rowCount: 1,
            affectedRows: count,
            truncated: false,
            isSelect: false,
          },
          nextDbName: currentDbName,
          mutates: true,
        }
      }

      case 'insertMany': {
        validateAllowedChains(new Set())
        if (!Array.isArray(stmt.args[0])) {
          throw new DatabaseDriverError('.insertMany() requires an array of documents', 'invalid_params', 'mongodb')
        }
        const docs = stmt.args[0].filter((d): d is Record<string, unknown> => isPlainRecord(d))
        const extraOpts = isPlainRecord(stmt.args[1]) ? stmt.args[1] : undefined
        const res = await coll.insertMany(docs, { ...(extraOpts ?? {}), ...callOpts })
        const count = Number(res.insertedCount ?? docs.length)
        return {
          result: {
            columns: [{ name: 'insertedCount', type: 'Int32' }],
            rows: [[count]],
            rowCount: 1,
            affectedRows: count,
            truncated: false,
            isSelect: false,
          },
          nextDbName: currentDbName,
          mutates: true,
        }
      }

      case 'updateOne':
      case 'updateMany': {
        validateAllowedChains(new Set())
        if (!isPlainRecord(stmt.args[0]) || !isPlainRecord(stmt.args[1])) {
          throw new DatabaseDriverError(
            `.${stmt.method}() requires filter and update objects`,
            'invalid_params',
            'mongodb'
          )
        }
        const extraOpts = isPlainRecord(stmt.args[2]) ? stmt.args[2] : undefined
        const opts = { ...(extraOpts ?? {}), ...callOpts }
        const res =
          stmt.method === 'updateOne'
            ? await coll.updateOne(stmt.args[0], stmt.args[1], opts)
            : await coll.updateMany(stmt.args[0], stmt.args[1], opts)
        const modified = Number(res.modifiedCount ?? 0)
        const matched = Number(res.matchedCount ?? 0)
        const affected = modified > 0 ? modified : matched
        return {
          result: {
            columns: [{ name: 'matchedCount', type: 'Int32' }, { name: 'modifiedCount', type: 'Int32' }],
            rows: [[matched, modified]],
            rowCount: 1,
            affectedRows: affected,
            truncated: false,
            isSelect: false,
          },
          nextDbName: currentDbName,
          mutates: true,
        }
      }

      case 'replaceOne': {
        validateAllowedChains(new Set())
        if (!isPlainRecord(stmt.args[0]) || !isPlainRecord(stmt.args[1])) {
          throw new DatabaseDriverError(
            '.replaceOne() requires filter and replacement objects',
            'invalid_params',
            'mongodb'
          )
        }
        const extraOpts = isPlainRecord(stmt.args[2]) ? stmt.args[2] : undefined
        const res = await coll.replaceOne(stmt.args[0], stmt.args[1], {
          ...(extraOpts ?? {}),
          ...callOpts,
        })
        const matched = Number(res.matchedCount ?? 0)
        const modified = Number(res.modifiedCount ?? 0)
        return {
          result: {
            columns: [{ name: 'matchedCount', type: 'Int32' }, { name: 'modifiedCount', type: 'Int32' }],
            rows: [[matched, modified]],
            rowCount: 1,
            affectedRows: modified > 0 ? modified : matched,
            truncated: false,
            isSelect: false,
          },
          nextDbName: currentDbName,
          mutates: true,
        }
      }

      case 'deleteOne':
      case 'deleteMany': {
        validateAllowedChains(new Set())
        const filter = isPlainRecord(stmt.args[0]) ? stmt.args[0] : {}
        const extraOpts = isPlainRecord(stmt.args[1]) ? stmt.args[1] : undefined
        const opts = { ...(extraOpts ?? {}), ...callOpts }
        const res =
          stmt.method === 'deleteOne'
            ? await coll.deleteOne(filter, opts)
            : await coll.deleteMany(filter, opts)
        const deleted = Number(res.deletedCount ?? 0)
        return {
          result: {
            columns: [{ name: 'deletedCount', type: 'Int32' }],
            rows: [[deleted]],
            rowCount: 1,
            affectedRows: deleted,
            truncated: false,
            isSelect: false,
          },
          nextDbName: currentDbName,
          mutates: true,
        }
      }

      case 'findOneAndUpdate': {
        validateAllowedChains(new Set())
        if (!isPlainRecord(stmt.args[0]) || !isPlainRecord(stmt.args[1])) {
          throw new DatabaseDriverError(
            '.findOneAndUpdate() requires filter and update objects',
            'invalid_params',
            'mongodb'
          )
        }
        const extraOpts = isPlainRecord(stmt.args[2]) ? stmt.args[2] : undefined
        const res = await coll.findOneAndUpdate(stmt.args[0], stmt.args[1], {
          returnDocument: 'after',
          ...(extraOpts ?? {}),
          ...callOpts,
        })
        const doc = isPlainRecord(res) ? res : null
        return {
          result: {
            ...buildQueryResultFromDocs(doc ? [doc] : [], false),
            affectedRows: doc ? 1 : 0,
          },
          nextDbName: currentDbName,
          mutates: true,
        }
      }

      case 'findOneAndDelete': {
        validateAllowedChains(new Set())
        const filter = isPlainRecord(stmt.args[0]) ? stmt.args[0] : {}
        const extraOpts = isPlainRecord(stmt.args[1]) ? stmt.args[1] : undefined
        const res = await coll.findOneAndDelete(filter, {
          ...(extraOpts ?? {}),
          ...callOpts,
        })
        const doc = isPlainRecord(res) ? res : null
        return {
          result: {
            ...buildQueryResultFromDocs(doc ? [doc] : [], false),
            affectedRows: doc ? 1 : 0,
          },
          nextDbName: currentDbName,
          mutates: true,
        }
      }

      case 'createIndex': {
        validateAllowedChains(new Set())
        if (!isPlainRecord(stmt.args[0])) {
          throw new DatabaseDriverError('.createIndex() requires a key specification object', 'invalid_params', 'mongodb')
        }
        const extraOpts = isPlainRecord(stmt.args[1]) ? stmt.args[1] : undefined
        const idxName = await coll.createIndex(stmt.args[0], { ...(extraOpts ?? {}), ...callOpts })
        return {
          result: {
            columns: [{ name: 'indexName', type: 'String' }],
            rows: [[idxName]],
            rowCount: 1,
            affectedRows: 1,
            truncated: false,
            isSelect: false,
          },
          nextDbName: currentDbName,
          mutates: true,
        }
      }

      case 'dropIndex': {
        validateAllowedChains(new Set())
        const idxName = typeof stmt.args[0] === 'string' ? stmt.args[0] : ''
        if (!idxName) {
          throw new DatabaseDriverError('.dropIndex() requires an index name string', 'invalid_params', 'mongodb')
        }
        const extraOpts = isPlainRecord(stmt.args[1]) ? stmt.args[1] : undefined
        await coll.dropIndex(idxName, { ...(extraOpts ?? {}), ...callOpts })
        return {
          result: {
            columns: [{ name: 'droppedIndex', type: 'String' }],
            rows: [[idxName]],
            rowCount: 1,
            affectedRows: 1,
            truncated: false,
            isSelect: false,
          },
          nextDbName: currentDbName,
          mutates: true,
        }
      }

      case 'dropIndexes': {
        validateAllowedChains(new Set())
        if (typeof coll.dropIndexes === 'function') {
          await coll.dropIndexes(callOpts)
        } else {
          await db.command({ dropIndexes: stmt.collection, index: '*' }, callOpts)
        }
        return {
          result: {
            columns: [{ name: 'ok', type: 'Int32' }],
            rows: [[1]],
            rowCount: 1,
            affectedRows: 1,
            truncated: false,
            isSelect: false,
          },
          nextDbName: currentDbName,
          mutates: true,
        }
      }

      case 'drop': {
        validateAllowedChains(new Set())
        await coll.drop(callOpts)
        return {
          result: {
            columns: [{ name: 'dropped', type: 'String' }],
            rows: [[stmt.collection]],
            rowCount: 1,
            affectedRows: 1,
            truncated: false,
            isSelect: false,
          },
          nextDbName: currentDbName,
          mutates: true,
        }
      }

      case 'renameCollection': {
        validateAllowedChains(new Set())
        const newName = typeof stmt.args[0] === 'string' ? stmt.args[0].trim() : ''
        if (!newName) {
          throw new DatabaseDriverError(
            '.renameCollection() requires a non-empty target name',
            'invalid_params',
            'mongodb'
          )
        }
        const extraOpts = isPlainRecord(stmt.args[1]) ? stmt.args[1] : undefined
        await coll.rename(newName, { ...(extraOpts ?? {}), ...callOpts })
        return {
          result: {
            columns: [{ name: 'renamedTo', type: 'String' }],
            rows: [[newName]],
            rowCount: 1,
            affectedRows: 1,
            truncated: false,
            isSelect: false,
          },
          nextDbName: currentDbName,
          mutates: true,
        }
      }

      default:
        throw new DatabaseDriverError(
          `Unsupported collection method ".${stmt.method}()"`,
          'SYNTAX_ERROR',
          'mongodb'
        )
    }
  }

  async runQuery(queryId: string, rawQuery: string, maxRows = 1000): Promise<QueryResult> {
    this.assertOpen()
    const rawText = typeof rawQuery === 'string' ? rawQuery : ''
    let parsedStmts: ParsedMongoStatement[]
    try {
      const rawStmts = splitMongoScriptStatements(rawText)
      if (rawStmts.length === 0) {
        throw new DatabaseDriverError('MongoDB query cannot be empty', 'invalid_params', 'mongodb')
      }
      parsedStmts = rawStmts.map((raw) => parseMongoStatement(raw))
    } catch (err: unknown) {
      throw scrubMongoError(err, 'Invalid MongoDB query', 'SYNTAX_ERROR')
    }

    if (this.profile.readOnly) {
      for (const stmt of parsedStmts) {
        if (!isMongoStatementReadOnly(stmt)) {
          throw new DatabaseDriverError(
            'Connection is Read-Only. Only read-only MongoDB queries and commands are allowed.',
            'READ_ONLY',
            'mongodb'
          )
        }
      }
    }

    if (!this.autoCommit && this.activeTxSession === null) {
      await this.runScrubbed('Failed to start MongoDB transaction', 'TX_START_FAILED', async () => {
        await this.runExclusiveTxOp(async () => {
          if (!this.autoCommit && this.activeTxSession === null) {
            await this.beginTransactionLocked()
          }
        })
      })
    }

    const activeEntry: ActiveMongoQuery = {
      controller: new AbortController(),
      cancelled: false,
    }
    this.activeQueries.set(queryId, activeEntry)
    const startTime = performance.now()

    try {
      let currentDbName = this.dbName
      let totalAffectedRows = 0
      let lastSelect: Omit<QueryResult, 'executionTimeMs'> | null = null
      let lastResult: Omit<QueryResult, 'executionTimeMs'> | null = null
      const collectedSets: QueryResultSet[] = []
      let mutatedAny = false

      for (let idx = 0; idx < parsedStmts.length; idx++) {
        if (activeEntry.cancelled || activeEntry.controller.signal.aborted || this.isClosed) {
          throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'mongodb')
        }
        const stmt = parsedStmts[idx]
        const stmtStart = performance.now()
        const { result, nextDbName, mutates } = await this.executeSingleMongoStatement(
          stmt,
          currentDbName,
          activeEntry,
          maxRows
        )
        currentDbName = nextDbName
        if (mutates) mutatedAny = true
        if (this.activeTxSession !== null) this.statementCount++

        lastResult = result
        if (result.isSelect) lastSelect = result
        totalAffectedRows += result.affectedRows ?? 0

        if (parsedStmts.length > 1) {
          collectedSets.push({
            index: idx,
            sqlPreview: stmt.raw.replace(/\s+/g, ' ').slice(0, 80),
            sql: stmt.raw,
            executionTimeMs: Math.round(performance.now() - stmtStart),
            columns: result.columns,
            rows: result.rows,
            rowCount: result.rowCount,
            ...(result.affectedRows !== undefined ? { affectedRows: result.affectedRows } : {}),
            truncated: result.truncated,
            isSelect: result.isSelect,
            ...(result.sourceTable ? { sourceTable: result.sourceTable } : {}),
          })
        }
      }

      if (mutatedAny) {
        this.tableDetailsCache.clear()
        for (const s of parsedStmts) {
          if (
            (s.kind === 'db_method' && s.method === 'dropDatabase') ||
            (s.kind === 'collection_method' &&
              (s.method === 'drop' || s.method === 'renameCollection'))
          ) {
            this.knownColumnTypes.clear()
            break
          }
        }
      }

      const executionTimeMs = Math.round(performance.now() - startTime)
      if (parsedStmts.length === 1 && lastResult) {
        return { ...lastResult, executionTimeMs }
      }
      const primary = lastSelect ?? lastResult
      if (!primary) {
        return {
          columns: [],
          rows: [],
          rowCount: 0,
          affectedRows: totalAffectedRows,
          executionTimeMs,
          truncated: false,
          isSelect: false,
        }
      }
      return {
        ...primary,
        affectedRows: totalAffectedRows,
        resultSets: collectedSets,
        executionTimeMs,
      }
    } catch (err: unknown) {
      if (activeEntry.cancelled || activeEntry.controller.signal.aborted) {
        throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'mongodb', err)
      }
      throw scrubMongoError(err, 'MongoDB query failed', 'QUERY_ERROR')
    } finally {
      this.activeQueries.delete(queryId)
    }
  }

  async cancelQuery(queryId: string): Promise<{ ok: boolean }> {
    this.assertOpen()
    const active = this.activeQueries.get(queryId)
    if (!active) return { ok: true }
    active.cancelled = true
    active.controller.abort()
    await active.activeCursor?.close?.().catch(() => {})
    return { ok: true }
  }

  getTransactionState(): TransactionState {
    return {
      active: this.activeTxSession !== null,
      autoCommit: this.autoCommit,
      statementCount: this.statementCount,
      startedAt: this.txStartedAt,
      supported: true,
    }
  }

  async beginTransaction(): Promise<TransactionState> {
    return await this.runExclusiveTxOp(() => this.beginTransactionLocked())
  }

  async commitTransaction(): Promise<TransactionState> {
    return await this.runExclusiveTxOp(async () => {
      this.assertOpen()
      const cs = this.activeTxSession
      if (cs === null) {
        throw new DatabaseDriverError(
          'Cannot commit: no active transaction',
          'NO_ACTIVE_TX',
          'mongodb'
        )
      }
      this.activeTxSession = null
      this.statementCount = 0
      this.txStartedAt = undefined
      try {
        await cs.commitTransaction()
        this.tableDetailsCache.clear()
        return this.getTransactionState()
      } catch (err: unknown) {
        throw scrubMongoError(err, 'Failed to commit MongoDB transaction', 'TX_COMMIT_FAILED')
      } finally {
        await cs.endSession().catch(() => {})
      }
    })
  }

  async rollbackTransaction(): Promise<TransactionState> {
    return await this.runExclusiveTxOp(async () => {
      this.assertOpen()
      const cs = this.activeTxSession
      if (cs === null) {
        throw new DatabaseDriverError(
          'Cannot rollback: no active transaction',
          'NO_ACTIVE_TX',
          'mongodb'
        )
      }
      this.activeTxSession = null
      this.statementCount = 0
      this.txStartedAt = undefined
      try {
        await cs.abortTransaction()
        this.tableDetailsCache.clear()
        return this.getTransactionState()
      } catch (err: unknown) {
        throw scrubMongoError(err, 'Failed to rollback MongoDB transaction', 'TX_ROLLBACK_FAILED')
      } finally {
        await cs.endSession().catch(() => {})
      }
    })
  }

  async setAutoCommit(enabled: boolean): Promise<TransactionState> {
    return await this.runExclusiveTxOp(async () => {
      this.assertOpen()
      if (enabled) {
        if (this.activeTxSession !== null) {
          throw new DatabaseDriverError(
            'Commit or rollback the active transaction before switching to Auto-Commit',
            'TX_ACTIVE',
            'mongodb'
          )
        }
        this.autoCommit = true
      } else {
        this.autoCommit = false
      }
      return this.getTransactionState()
    })
  }
}

const realMongoSessionMap = new WeakMap<object, ClientSession>()

function unwrapMongoOptions(
  options?: Record<string, unknown>,
  stripSignal = false
): Record<string, unknown> | undefined {
  if (!options) return undefined
  let resolved = options
  if (stripSignal && 'signal' in resolved) {
    const rest = { ...resolved }
    delete rest.signal
    resolved = rest
  }
  const sess = resolved.session
  if (sess && typeof sess === 'object') {
    const real = realMongoSessionMap.get(sess)
    if (real) {
      return { ...resolved, session: real }
    }
  }
  return resolved
}

function toMongoSortDirections(sort: Record<string, unknown>): Record<string, 1 | -1> {
  const out: Record<string, 1 | -1> = {}
  for (const [k, v] of Object.entries(sort)) {
    out[k] = Number(v) < 0 ? -1 : 1
  }
  return out
}

function wrapFindCursor(cursor: FindCursor<Document>): MongoCursorLike {
  const wrapper: MongoCursorLike = {
    sort(sort) {
      cursor.sort(toMongoSortDirections(sort))
      return wrapper
    },
    skip(value) {
      cursor.skip(value)
      return wrapper
    },
    limit(value) {
      cursor.limit(value)
      return wrapper
    },
    project(value) {
      cursor.project(value)
      return wrapper
    },
    explain: (verbosity) => cursor.explain(verbosity || 'queryPlanner'),
    toArray: () => cursor.toArray(),
    close: () => cursor.close(),
  }
  return wrapper
}

function wrapAggregateCursor(cursor: AggregationCursor<Document>): MongoAggregateCursorLike {
  return {
    explain: (verbosity) => cursor.explain(verbosity || 'queryPlanner'),
    toArray: () => cursor.toArray(),
    close: () => cursor.close(),
  }
}

function wrapMongoCollection(coll: Collection<Document>): MongoCollectionLike {
  return {
    collectionName: coll.collectionName,
    find: (filter, options) => wrapFindCursor(coll.find(filter ?? {}, unwrapMongoOptions(options))),
    findOne: (filter, options) => coll.findOne(filter ?? {}, unwrapMongoOptions(options)),
    countDocuments: (filter, options) =>
      coll.countDocuments(filter ?? {}, unwrapMongoOptions(options)),
    estimatedDocumentCount: (options) =>
      coll.estimatedDocumentCount(unwrapMongoOptions(options)),
    indexes: (options) => coll.indexes(unwrapMongoOptions(options)),
    aggregate: (pipeline, options) =>
      wrapAggregateCursor(coll.aggregate(pipeline ?? [], unwrapMongoOptions(options))),
    distinct: (key, filter, options) =>
      coll.distinct(key, filter ?? {}, unwrapMongoOptions(options) ?? {}),
    insertOne: (doc, options) => coll.insertOne(doc, unwrapMongoOptions(options)),
    insertMany: (docs, options) => coll.insertMany(docs, unwrapMongoOptions(options)),
    updateOne: (filter, update, options) =>
      coll.updateOne(filter, update, unwrapMongoOptions(options)),
    updateMany: (filter, update, options) =>
      coll.updateMany(filter, update, unwrapMongoOptions(options)),
    replaceOne: (filter, replacement, options) =>
      coll.replaceOne(filter, replacement, unwrapMongoOptions(options)),
    deleteOne: (filter, options) => coll.deleteOne(filter, unwrapMongoOptions(options)),
    deleteMany: (filter, options) => coll.deleteMany(filter, unwrapMongoOptions(options)),
    findOneAndUpdate: (filter, update, options) =>
      coll.findOneAndUpdate(filter, update, unwrapMongoOptions(options) ?? {}),
    findOneAndDelete: (filter, options) =>
      coll.findOneAndDelete(filter, unwrapMongoOptions(options) ?? {}),
    createIndex: (indexSpec, options) =>
      coll.createIndex(toMongoSortDirections(indexSpec), unwrapMongoOptions(options)),
    dropIndex: (indexName, options) => coll.dropIndex(indexName, unwrapMongoOptions(options)),
    dropIndexes: (options) => coll.dropIndexes(unwrapMongoOptions(options)),
    drop: (options) => coll.drop(unwrapMongoOptions(options)),
    rename: (newName, options) => coll.rename(newName, unwrapMongoOptions(options)),
  }
}

function wrapMongoDb(db: Db): MongoDbLike {
  const admin = db.admin()
  return {
    databaseName: db.databaseName,
    admin: () => ({
      listDatabases: () => admin.listDatabases(),
      command: (cmd, options) => admin.command(cmd, unwrapMongoOptions(options)),
      serverStatus: () => admin.serverStatus(),
    }),
    command: (cmd, options) => db.command(cmd, unwrapMongoOptions(options)),
    listCollections: (filter, options) => db.listCollections(filter, unwrapMongoOptions(options)),
    collection: (name) => wrapMongoCollection(db.collection(name)),
    createCollection: (name, options) => db.createCollection(name, unwrapMongoOptions(options, true)),
    stats: (options) => db.stats(unwrapMongoOptions(options)),
  }
}

function wrapMongoSession(session: ClientSession): MongoClientSessionLike {
  const wrapped: MongoClientSessionLike = {
    inTransaction: () => session.inTransaction(),
    startTransaction: () => session.startTransaction(),
    commitTransaction: () => session.commitTransaction(),
    abortTransaction: () => session.abortTransaction(),
    withTransaction: <T>(fn: () => Promise<T>) => session.withTransaction(fn),
    endSession: () => session.endSession(),
  }
  realMongoSessionMap.set(wrapped, session)
  return wrapped
}

export class MongoDriver implements IDatabaseDriver {
  readonly type = 'mongodb' as const
  private readonly clientFactory: MongoClientFactory

  constructor(clientFactory?: MongoClientFactory) {
    this.clientFactory =
      clientFactory ??
      ((uri: string, options: MongoClientOptions) => {
        const client = new MongoClient(uri, options)
        return {
          connect: () => client.connect(),
          close: (force?: boolean) => client.close(force),
          db: (name?: string) => wrapMongoDb(client.db(name)),
          startSession: () => wrapMongoSession(client.startSession()),
        }
      })
  }

  async createSession(
    profile: ConnectionProfile,
    password?: string,
    extraSecrets?: DriverTlsOptions
  ): Promise<IDatabaseSession> {
    const { uri, dbName, options } = await buildMongoConnectionConfig(profile, password, extraSecrets)
    const client = this.clientFactory(uri, options)
    try {
      await client.connect()
    } catch (err: unknown) {
      await client.close().catch(() => {})
      throw new DatabaseDriverError(
        scrubMongoErrorMessage(err, 'Failed to connect to MongoDB'),
        'CONNECTION_FAILED',
        'mongodb',
        err
      )
    }
    return new MongoSession(client, profile, dbName)
  }

  async testConnection(
    profile: ConnectionProfile,
    password?: string,
    extraSecrets?: DriverTlsOptions
  ): Promise<{ ok: boolean; message?: string }> {
    return runDriverConnectionTest(
      () => this.createSession(profile, password, extraSecrets),
      (err) => scrubMongoErrorMessage(err, 'MongoDB connection failed')
    )
  }
}
