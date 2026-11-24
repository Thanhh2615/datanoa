import oracledb, {
  BLOB,
  CLOB,
  NCLOB,
  OUT_FORMAT_ARRAY,
  OUT_FORMAT_OBJECT,
  type ConnectionAttributes,
  type ExecuteOptions,
} from '../../../vendor/oracledb.js'
import type {
  ConnectionProfile,
  QueryResult,
  QueryResultSet,
  SchemaObject,
  SchemaObjectKind,
  TableBrowseResult,
  TableDetails,
  TransactionState,
} from '../../protocol'
import { sanitizeJsonPayload } from '../../protocol'
import {
  DatabaseDriverError,
  runDriverConnectionTest,
  type ApplyChangesParams,
  type ApplyChangesResult,
  type FetchPageParams,
  type IDatabaseDriver,
  type IDatabaseSession,
  type PreviewChangesResult,
  type UpdateCellParams,
  type UpdateCellResult,
} from '../common/driver'
import {
  isOracleImplicitCommitStatement,
  splitOracleStatements,
  type OracleStatementChunk,
} from '../common/oracle-sql'
import {
  collectAndAssembleSchemaDdl,
  introspectOracleObjectDdl,
  introspectOracleObjects,
  introspectOracleSchemas,
  introspectOracleTableDetails,
  TableDetailsCache,
} from '../common/schema'
import {
  compactSql,
  containsDdlStatement,
  isMutatingStatement,
  splitSqlStatements,
  stripCommentsAndLiterals,
  stripLeadingSqlComments,
} from '../common/sql-tools'
import { type DriverTlsOptions, resolveEffectiveTlsOptions } from '../common/tls-and-tunnel'
import {
  assembleTableBrowseResult,
  buildBatchStatements,
  buildSelectByPrimaryKeySql,
  buildSelectPageSql,
  buildUpdateSql,
  projectDeleteRowsToPrimaryKeys,
} from '../common/update-builder'
import { scrubDriverErrorText } from '../common/sql-credentials'

export { splitOracleStatements, type OracleStatementChunk }

function getOracleOutFormatObject(): number {
  return OUT_FORMAT_OBJECT
}

function getOracleOutFormatArray(): number {
  return OUT_FORMAT_ARRAY
}

export interface OracleMetadataLike {
  name?: string
  dbTypeName?: string
  fetchType?: number
}

export interface OracleResultLike {
  metaData?: OracleMetadataLike[]
  rows?: unknown[]
  rowsAffected?: number
}

export interface OracleConnectionLike {
  execute(
    sql: string,
    binds?: unknown,
    options?: ExecuteOptions | Record<string, unknown>
  ): Promise<OracleResultLike>
  commit(): Promise<void>
  rollback(): Promise<void>
  breakExecution?: () => Promise<void>
  break?: (cb?: (err?: Error) => void) => Promise<void> | void
  isHealthy?: () => boolean
  close(): Promise<void>
  callTimeout?: number
}

export interface OracleBuiltConfig {
  attrs: ConnectionAttributes
  currentSchema?: string
  usedDatabaseAsService: boolean
  defaultSchema: string
}

interface OracleLobLike {
  getData(): Promise<string | Buffer>
}

interface ActiveOracleQuery {
  cancelled: boolean
}

const ORACLE_READONLY_BLOCK_RE =
  /^\s*\(*\s*(?:BEGIN|DECLARE|CALL|EXEC(?:UTE)?|LOCK\s+TABLE|PURGE|FLASHBACK|RENAME|COMMENT\s+ON|AUDIT|NOAUDIT|ANALYZE|GRANT|REVOKE|MERGE|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|SAVEPOINT)\b/i

let oracleLobDefaultsApplied = false

function ensureOracleLobFetchDefaults(): void {
  if (oracleLobDefaultsApplied) return
  oracleLobDefaultsApplied = true
  if (oracledb && typeof oracledb === 'object') {
    if (CLOB !== undefined && NCLOB !== undefined) {
      oracledb.fetchAsString = [CLOB, NCLOB]
    }
    if (BLOB !== undefined) {
      oracledb.fetchAsBuffer = [BLOB]
    }
  }
}

function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;\s*$/, '').trimEnd()
}

function isOracleReadOnlyBlocked(chunk: OracleStatementChunk): boolean {
  if (chunk.isPlSql) return true
  if (isMutatingStatement(chunk.text, 'oracle')) return true
  const stmts = splitSqlStatements(chunk.text, 'oracle')
  const list = stmts.length > 0 ? stmts.map((s) => s.text) : [chunk.text]
  for (const s of list) {
    const clean = stripCommentsAndLiterals(s, 'oracle', false).trim()
    if (ORACLE_READONLY_BLOCK_RE.test(clean)) return true
  }
  return false
}

function isStandaloneCommit(sql: string): boolean {
  const clean = stripCommentsAndLiterals(sql, 'oracle', false).trim().replace(/;+$/, '').trim()
  return /^COMMIT(?:\s+WORK)?$/i.test(clean)
}

function isStandaloneRollback(sql: string): boolean {
  const clean = stripCommentsAndLiterals(sql, 'oracle', false).trim().replace(/;+$/, '').trim()
  return /^ROLLBACK(?:\s+WORK)?$/i.test(clean)
}

function normalizeOracleSchemaIdentifier(raw: string | undefined, fallback = 'SYSTEM'): string {
  const trimmed = (raw || '').trim()
  if (!trimmed) return fallback.toUpperCase()
  return trimmed === trimmed.toLowerCase() ? trimmed.toUpperCase() : trimmed
}

function sanitizeCurrentSchemaIdentifier(schema: string): string {
  const cleaned = schema.trim().replace(/"/g, '')
  return `"${cleaned}"`
}

function extractOracleErrorCode(err: unknown): { code?: string; errorNum?: number } {
  if (!err || typeof err !== 'object') return {}
  const rec = err as { code?: unknown; errorNum?: unknown; message?: unknown }
  const code = typeof rec.code === 'string' ? rec.code : undefined
  const errorNum = typeof rec.errorNum === 'number' ? rec.errorNum : undefined
  if (errorNum === undefined && typeof rec.message === 'string') {
    const match = /\bORA-(\d{4,5})\b/.exec(rec.message)
    if (match) {
      return { code, errorNum: Number(match[1]) }
    }
  }
  return { code, errorNum }
}

function extractOracleErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) {
    return scrubDriverErrorText(err.message) || fallback
  }
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message
    if (typeof msg === 'string' && msg.trim()) {
      return scrubDriverErrorText(msg) || fallback
    }
  }
  return typeof err === 'string' && err.trim()
    ? scrubDriverErrorText(err) || fallback
    : fallback
}

function scrubOracleError(err: unknown): unknown {
  if (err instanceof Error && err.message) {
    const clean = scrubDriverErrorText(err.message)
    if (clean !== err.message) {
      try {
        err.message = clean
      } catch {
        return new DatabaseDriverError(clean, extractOracleErrorCode(err).code || 'ORACLE_ERROR', 'oracle', err)
      }
    }
  }
  return err
}

function coerceOracleBindValue(value: unknown): unknown {
  if (value === undefined) return null
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  }
  return value
}

function toOracleBindObject(params?: unknown[]): Record<string, unknown> {
  const binds: Record<string, unknown> = {}
  if (!params || params.length === 0) return binds
  for (let i = 0; i < params.length; i++) {
    binds[`p${i + 1}`] = coerceOracleBindValue(params[i])
  }
  return binds
}

function isOracleLobLike(val: unknown): val is OracleLobLike {
  return (
    typeof val === 'object' &&
    val !== null &&
    'getData' in val &&
    typeof (val as { getData?: unknown }).getData === 'function'
  )
}

async function serializeOracleCell(value: unknown): Promise<unknown> {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return sanitizeJsonPayload(value)
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return sanitizeJsonPayload(value)
  if (isOracleLobLike(value)) {
    const data = await value.getData()
    return Buffer.isBuffer(data) ? sanitizeJsonPayload(data) : data
  }
  return sanitizeJsonPayload(value)
}

async function serializeOracleRowRecord(row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    out[k] = await serializeOracleCell(v)
  }
  return out
}

function buildUniqueColumnNames(metaData: OracleMetadataLike[]): { name: string; type: string }[] {
  const seenCounts = new Map<string, number>()
  return metaData.map((col, idx) => {
    const baseName = col.name && col.name.length > 0 ? col.name : `col_${idx + 1}`
    const count = seenCounts.get(baseName) ?? 0
    seenCounts.set(baseName, count + 1)
    const name = count === 0 ? baseName : `${baseName}_${count + 1}`
    return {
      name,
      type: col.dbTypeName || 'VARCHAR2',
    }
  })
}

async function extractOracleColumnsAndRows(
  res: OracleResultLike,
  maxRows: number
): Promise<{
  columns: { name: string; type: string }[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
}> {
  const metaData = Array.isArray(res.metaData) ? res.metaData : []
  const rawRows = Array.isArray(res.rows) ? res.rows : []
  const columns =
    metaData.length > 0
      ? buildUniqueColumnNames(metaData)
      : rawRows.length > 0 && !Array.isArray(rawRows[0]) && typeof rawRows[0] === 'object' && rawRows[0] !== null
        ? Object.keys(rawRows[0] as Record<string, unknown>).map((name) => ({ name, type: 'VARCHAR2' }))
        : []

  const truncated = rawRows.length > maxRows
  const limited = truncated ? rawRows.slice(0, maxRows) : rawRows
  const rows: unknown[][] = []
  for (const rawRow of limited) {
    if (Array.isArray(rawRow)) {
      const tuple: unknown[] = []
      for (const cell of rawRow) {
        tuple.push(await serializeOracleCell(cell))
      }
      rows.push(tuple)
    } else if (rawRow && typeof rawRow === 'object') {
      const rec = rawRow as Record<string, unknown>
      const tuple: unknown[] = []
      for (const col of columns) {
        tuple.push(await serializeOracleCell(rec[col.name]))
      }
      rows.push(tuple)
    }
  }

  return {
    columns,
    rows,
    rowCount: rows.length,
    truncated,
  }
}

function isValidOracleServerCertDn(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  const parts: string[] = []
  let cur = ''
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === '\\' && i + 1 < trimmed.length) {
      cur += ch + trimmed[i + 1]
      i++
      continue
    }
    if (ch === ',') {
      parts.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  parts.push(cur.trim())
  if (parts.length === 0) return false
  return parts.every((rdn) => rdn.length > 0 && /^[A-Za-z][A-Za-z0-9.-]*\s*=\s*.+$/.test(rdn))
}

function extractOracleConnectHost(connectString: string, fallbackHost: string): string {
  const trimmed = connectString.trim()
  if (trimmed.startsWith('(')) {
    const hostMatch = /\(\s*HOST\s*=\s*([^)\s]+)\s*\)/i.exec(trimmed)
    if (hostMatch && hostMatch[1]) {
      const h = hostMatch[1].trim()
      return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
    }
  } else {
    const easyMatch =
      /^(?:tcps?:\/\/|\/\/)?(\[[0-9a-fA-F:]+\]|[A-Za-z0-9_.-]+)(?::\d{1,5})?(?:\/|$)/i.exec(trimmed)
    if (easyMatch && easyMatch[1]) {
      const h = easyMatch[1].trim()
      return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
    }
  }
  const fb = fallbackHost.trim()
  return fb.startsWith('[') && fb.endsWith(']') ? fb.slice(1, -1) : fb || 'localhost'
}

export async function buildOracleConnectionConfig(
  profile: ConnectionProfile,
  password?: string,
  extraSecrets?: DriverTlsOptions
): Promise<OracleBuiltConfig> {
  let host = (profile.host || '').trim()
  let port = profile.port
  let user = profile.user
  let resolvedPassword = password
  const profileDb = (profile.database || '').trim()
  let urlService = ''
  let urlSid = ''
  let urlSchema = ''
  let urlConnectString = ''
  let urlUsesTcps = false
  let rawUrlCertDn = ''

  const rawUrl = (profile.url || '').trim()
  if (rawUrl) {
    if (rawUrl.startsWith('(')) {
      urlConnectString = rawUrl
    } else if (/^(?:oracle|oracledb|tcps):\/\//i.test(rawUrl)) {
      if (/^tcps:\/\//i.test(rawUrl)) urlUsesTcps = true
      try {
        const normalizedUrl = rawUrl.replace(/^(?:oracle|oracledb|tcps):\/\//i, 'http://')
        const parsed = new URL(normalizedUrl)
        if (!host && parsed.hostname) host = parsed.hostname
        if (!port && parsed.port) {
          const parsedPort = Number(parsed.port)
          if (Number.isInteger(parsedPort) && parsedPort > 0) port = parsedPort
        }
        if (!user && parsed.username) user = decodeURIComponent(parsed.username)
        if (!resolvedPassword && parsed.password) {
          resolvedPassword = decodeURIComponent(parsed.password)
        }
        const rawPath = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
        if (rawPath) urlService = decodeURIComponent(rawPath)
        const qSchema = (parsed.searchParams.get('schema') || '').trim()
        if (qSchema) urlSchema = qSchema
        const qService = (
          parsed.searchParams.get('serviceName') ||
          parsed.searchParams.get('service') ||
          ''
        ).trim()
        if (!urlService && qService) urlService = qService
        const qSid = (parsed.searchParams.get('sid') || '').trim()
        if (qSid) urlSid = qSid
        const qCertDn = (
          parsed.searchParams.get('ssl_server_cert_dn') ||
          parsed.searchParams.get('sslServerCertDN') ||
          ''
        ).trim()
        if (qCertDn) rawUrlCertDn = qCertDn
      } catch {
        urlConnectString = rawUrl
      }
    } else {
      urlConnectString = rawUrl
    }
  }

  let urlSslServerCertDn: string | undefined
  if (rawUrlCertDn) {
    if (!isValidOracleServerCertDn(rawUrlCertDn)) {
      throw new DatabaseDriverError(
        `Invalid Oracle ssl_server_cert_dn "${rawUrlCertDn}". Expected an RFC 2253 Distinguished Name (e.g. "CN=db.example.com,O=Acme").`,
        'invalid_params',
        'oracle'
      )
    }
    urlSslServerCertDn = rawUrlCertDn
  }

  const tlsOverride = await resolveEffectiveTlsOptions(
    profile,
    extraSecrets,
    extraSecrets?.tlsServername
  )

  const tnsUsesTcps = /\(\s*PROTOCOL\s*=\s*TCPS\s*\)/i.test(urlConnectString || host)
  const wantsTls =
    urlUsesTcps ||
    tnsUsesTcps ||
    (tlsOverride !== false && (Boolean(tlsOverride) || profile.ssl === true))

  let connectString = ''
  let usedDatabaseAsService = false

  if (urlConnectString) {
    connectString = urlConnectString
  } else if (host.startsWith('(')) {
    connectString = host
  } else if (host.includes('/')) {
    connectString = wantsTls && !host.startsWith('tcps://') ? `tcps://${host}` : host
  } else {
    const resolvedHost = host || 'localhost'
    const resolvedPort = port || (wantsTls ? 2484 : 1521)
    if (urlSid) {
      connectString = `(DESCRIPTION=(ADDRESS=(PROTOCOL=${wantsTls ? 'TCPS' : 'TCP'})(HOST=${resolvedHost})(PORT=${resolvedPort}))(CONNECT_DATA=(SID=${urlSid})))`
    } else {
      const resolvedService = urlService || profileDb || 'FREEPDB1'
      usedDatabaseAsService =
        !urlService &&
        Boolean(profileDb) &&
        profileDb === resolvedService &&
        !urlSchema
      const prefix = wantsTls ? 'tcps://' : ''
      connectString = `${prefix}${resolvedHost}:${resolvedPort}/${resolvedService}`
    }
  }

  let currentSchema: string | undefined
  if (urlSchema) {
    currentSchema = normalizeOracleSchemaIdentifier(urlSchema)
  } else if (
    !usedDatabaseAsService &&
    profileDb &&
    !((urlSid || urlService) && (profileDb.toUpperCase() === 'FREEPDB1' || profileDb === urlService))
  ) {
    currentSchema = normalizeOracleSchemaIdentifier(profileDb)
  }

  const defaultSchema = currentSchema
    ? currentSchema
    : normalizeOracleSchemaIdentifier(user, 'SYSTEM')

  const attrs: ConnectionAttributes = {
    user,
    password: resolvedPassword,
    connectString,
    connectTimeout: 10,
  }

  if (tlsOverride && typeof tlsOverride === 'object') {
    const pemChunks: string[] = []
    if (typeof tlsOverride.ca === 'string' && tlsOverride.ca.trim()) pemChunks.push(tlsOverride.ca.trim())
    if (typeof tlsOverride.cert === 'string' && tlsOverride.cert.trim()) pemChunks.push(tlsOverride.cert.trim())
    if (typeof tlsOverride.key === 'string' && tlsOverride.key.trim()) pemChunks.push(tlsOverride.key.trim())
    if (pemChunks.length > 0) {
      attrs.walletContent = `${pemChunks.join('\n')}\n`
    }
    if (typeof extraSecrets?.sslKeyPassphrase === 'string' && extraSecrets.sslKeyPassphrase) {
      attrs.walletPassword = extraSecrets.sslKeyPassphrase
    }
  }

  if (wantsTls) {
    const verifyHost =
      profile.sslMode === 'verify-ca'
        ? false
        : tlsOverride && typeof tlsOverride === 'object'
          ? tlsOverride.rejectUnauthorized !== false
          : profile.sslRejectUnauthorized !== false
    attrs.sslServerDNMatch = verifyHost
    if (urlSslServerCertDn) {
      attrs.sslServerCertDN = urlSslServerCertDn
    }
    const hasTnsCertDn = /\(\s*SSL_SERVER_CERT_DN\s*=/i.test(connectString)
    const rawExpectedServername =
      typeof extraSecrets?.tlsServername === 'string' ? extraSecrets.tlsServername.trim() : ''
    const cleanExpectedServername =
      rawExpectedServername.startsWith('[') && rawExpectedServername.endsWith(']')
        ? rawExpectedServername.slice(1, -1)
        : rawExpectedServername
    const connectHost = extractOracleConnectHost(connectString, host || 'localhost')
    if (
      verifyHost &&
      cleanExpectedServername &&
      connectHost.toLowerCase() !== cleanExpectedServername.toLowerCase() &&
      !attrs.sslServerCertDN &&
      !hasTnsCertDn
    ) {
      throw new DatabaseDriverError(
        `Oracle thin-mode TLS verify-full over an SSH tunnel cannot match remote host "${cleanExpectedServername}" against "${connectHost}". Provide an exact RFC 2253 ?ssl_server_cert_dn=CN=... in the URL (or TNS SSL_SERVER_CERT_DN), or use SSL Mode "verify-ca".`,
        'ORACLE_SSH_TLS_VERIFY_FULL_UNSUPPORTED',
        'oracle'
      )
    }
  }

  return {
    attrs,
    currentSchema,
    usedDatabaseAsService,
    defaultSchema,
  }
}

export class OracleSession implements IDatabaseSession {
  readonly driverType = 'oracle' as const
  private readonly conn: OracleConnectionLike
  readonly profile: ConnectionProfile
  private readonly defaultSchema: string
  private readonly tableDetailsCache = new TableDetailsCache()
  private readonly activeQueries = new Map<string, ActiveOracleQuery>()

  private isClosed = false
  private autoCommit = true
  private txActive = false
  private statementCount = 0
  private txStartedAt: number | undefined
  private opChain: Promise<void> = Promise.resolve()

  constructor(
    conn: OracleConnectionLike,
    profile: ConnectionProfile,
    options?: { defaultSchema?: string }
  ) {
    this.conn = conn
    this.profile = profile
    this.defaultSchema = normalizeOracleSchemaIdentifier(
      options?.defaultSchema || profile.user,
      'SYSTEM'
    )
  }

  isAlive(): boolean {
    if (this.isClosed) return false
    return typeof this.conn.isHealthy === 'function' ? this.conn.isHealthy() : true
  }

  private runExclusiveOp<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.opChain
    let release: (() => void) | undefined
    this.opChain = new Promise<void>((resolve) => {
      release = resolve
    })
    return prev
      .then(fn)
      .catch((err: unknown) => {
        throw scrubOracleError(err)
      })
      .finally(() => {
        if (release) release()
      })
  }

  private async runScrubbed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err: unknown) {
      throw scrubOracleError(err)
    }
  }

  private resolveSchema(schema?: string): string {
    return normalizeOracleSchemaIdentifier(schema || this.defaultSchema, this.defaultSchema)
  }

  private assertOpen(): void {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'oracle')
    }
  }

  private assertWritable(): void {
    if (this.profile.readOnly) {
      throw new DatabaseDriverError(
        'Connection is Read-Only. Uncheck Read-Only in connection settings to modify data.',
        'read_only',
        'oracle'
      )
    }
  }

  private readonly queryExecutor = async (
    sql: string,
    params?: unknown[]
  ): Promise<Record<string, unknown>[]> => {
    this.assertOpen()
    const binds = toOracleBindObject(params)
    const res = await this.conn.execute(stripTrailingSemicolon(sql), binds, {
      outFormat: getOracleOutFormatObject(),
      autoCommit: !this.txActive && this.autoCommit,
    })
    const rows = Array.isArray(res.rows) ? (res.rows as Record<string, unknown>[]) : []
    const serialized: Record<string, unknown>[] = []
    for (const r of rows) {
      serialized.push(await serializeOracleRowRecord(r))
    }
    return serialized
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    if (this.isClosed) {
      return { ok: false, message: 'Session is closed' }
    }
    try {
      await this.conn.execute('SELECT 1 AS ok FROM DUAL', {}, { outFormat: getOracleOutFormatObject() })
      return { ok: true, message: 'Oracle connection valid' }
    } catch (err: unknown) {
      return {
        ok: false,
        message: extractOracleErrorMessage(err, 'Failed to connect to Oracle'),
      }
    }
  }

  async close(): Promise<void> {
    this.tableDetailsCache.clear()
    if (this.isClosed) return
    this.isClosed = true

    for (const active of this.activeQueries.values()) {
      active.cancelled = true
    }
    if (this.activeQueries.size > 0) {
      await this.breakConnectionExecution().catch(() => {})
    }
    this.activeQueries.clear()

    if (this.txActive) {
      this.txActive = false
      this.statementCount = 0
      this.txStartedAt = undefined
      await this.conn.rollback().catch(() => {})
    }

    await this.conn.close().catch(() => {})
  }

  private async breakConnectionExecution(): Promise<void> {
    if (typeof this.conn.breakExecution === 'function') {
      await this.conn.breakExecution()
      return
    }
    if (typeof this.conn.break === 'function') {
      const res = this.conn.break()
      if (res instanceof Promise) await res
    }
  }

  async listSchemas(): Promise<{ schemas: string[]; defaultSchema: string }> {
    return this.runScrubbed(async () => {
      this.assertOpen()
      return introspectOracleSchemas(this.queryExecutor, this.defaultSchema)
    })
  }

  async listObjects(schema?: string): Promise<SchemaObject[]> {
    return this.runScrubbed(async () => {
      this.assertOpen()
      return introspectOracleObjects(this.queryExecutor, this.resolveSchema(schema))
    })
  }

  async getTableDetails(table: string, schema?: string): Promise<TableDetails> {
    return this.runScrubbed(async () => {
      this.assertOpen()
      const targetSchema = this.resolveSchema(schema)
      const cached = this.tableDetailsCache.get(targetSchema, this.defaultSchema, table)
      if (cached) return cached
      const details = await introspectOracleTableDetails(this.queryExecutor, table, targetSchema)
      this.tableDetailsCache.set(targetSchema, this.defaultSchema, table, details)
      return details
    })
  }

  async getDdl(table: string, schema?: string): Promise<string> {
    return this.runScrubbed(async () => {
      const details = await this.getTableDetails(table, schema)
      return details.ddl || ''
    })
  }

  async getObjectDdl(name: string, kind: SchemaObjectKind, schema?: string): Promise<string> {
    return this.runScrubbed(async () => {
      this.assertOpen()
      const targetSchema = this.resolveSchema(schema)
      if (kind === 'table') {
        return this.getDdl(name, targetSchema)
      }
      return introspectOracleObjectDdl(this.queryExecutor, name, kind, targetSchema)
    })
  }

  async exportSchemaDdl(schema?: string): Promise<{ ddl: string; objectCount: number }> {
    return this.runScrubbed(async () => {
      this.assertOpen()
      const targetSchema = this.resolveSchema(schema)
      const objects = await this.listObjects(targetSchema)
      return collectAndAssembleSchemaDdl({
        dialect: 'oracle',
        schemaName: targetSchema,
        objects,
        getObjectDdl: (object) =>
          this.getObjectDdl(object.name, object.kind, object.schema || targetSchema),
      })
    })
  }

  async fetchPage(params: FetchPageParams): Promise<TableBrowseResult> {
    this.assertOpen()
    const targetSchema = this.resolveSchema(params.schema)

    return this.runExclusiveOp(async () => {
      this.assertOpen()
      const details = await this.getTableDetails(params.table, targetSchema)
      const { sql, countSql, params: queryParams } = buildSelectPageSql({
        driver: 'oracle',
        table: params.table,
        schema: targetSchema,
        page: params.page,
        pageSize: params.pageSize,
        sortColumn: params.sortColumn,
        sortDirection: params.sortDirection,
        primaryKey: details.primaryKey,
        whereClause: params.whereClause,
        orderByClause: params.orderByClause,
      })

      const countRows = await this.queryExecutor(stripTrailingSemicolon(countSql))
      const dataRows = await this.queryExecutor(stripTrailingSemicolon(sql), queryParams)

      return assembleTableBrowseResult({
        tableDetails: details,
        rows: dataRows,
        countRow: countRows[0] || { total: 0 },
        page: params.page,
        pageSize: params.pageSize,
      })
    })
  }

  async updateCell(params: UpdateCellParams): Promise<UpdateCellResult> {
    this.assertOpen()
    this.assertWritable()
    const targetSchema = this.resolveSchema(params.schema)
    const originalColumnType = this.tableDetailsCache.findColumnType(
      targetSchema,
      this.defaultSchema,
      params.table,
      params.column,
      params.columnType
    )

    const { sql, params: updateParams } = buildUpdateSql({
      driver: 'oracle',
      table: params.table,
      schema: targetSchema,
      column: params.column,
      newValue: params.newValue,
      primaryKeys: params.primaryKeys,
      originalValue: params.originalValue,
      originalColumnType,
    })

    const selectPk = buildSelectByPrimaryKeySql({
      driver: 'oracle',
      table: params.table,
      schema: targetSchema,
      primaryKeys: params.primaryKeys,
      editedColumn: params.column,
      newValue: params.newValue,
    })

    return this.runExclusiveOp(async () => {
      this.assertOpen()
      const insideManualTx = this.txActive || !this.autoCommit
      if (insideManualTx) {
        await this.conn.execute('SAVEPOINT datanoa_uc', {}, { autoCommit: false })
      }
      try {
        const res = await this.conn.execute(
          stripTrailingSemicolon(sql),
          toOracleBindObject(updateParams),
          { autoCommit: false }
        )
        const affected = Number(res.rowsAffected ?? 0)
        if (affected !== 1) {
          throw new DatabaseDriverError(
            affected === 0
              ? 'Record was modified or deleted by another session (optimistic lock conflict)'
              : `Optimistic update affected ${affected} rows instead of 1`,
            'conflict',
            'oracle'
          )
        }

        let updatedRecord: Record<string, unknown> | undefined
        if (selectPk) {
          const fetched = await this.conn.execute(
            stripTrailingSemicolon(selectPk.sql),
            toOracleBindObject(selectPk.params),
            { outFormat: getOracleOutFormatObject(), autoCommit: false }
          )
          const rawUpdated = Array.isArray(fetched.rows)
            ? (fetched.rows[0] as Record<string, unknown> | undefined)
            : undefined
          updatedRecord = rawUpdated ? await serializeOracleRowRecord(rawUpdated) : undefined
        }

        if (!insideManualTx) {
          await this.conn.commit()
        } else {
          if (!this.txActive) {
            this.txActive = true
            this.txStartedAt = Date.now()
          }
          this.statementCount += 1
        }
        return {
          ok: true,
          affectedRows: affected,
          ...(updatedRecord ? { updatedRecord } : {}),
        }
      } catch (err: unknown) {
        if (insideManualTx) {
          await this.conn
            .execute('ROLLBACK TO SAVEPOINT datanoa_uc', {}, { autoCommit: false })
            .catch(() => {})
        } else {
          await this.conn.rollback().catch(() => {})
        }
        throw err
      }
    })
  }

  private async resolveEffectiveDeletes(
    params: ApplyChangesParams,
    targetSchema: string
  ): Promise<Record<string, unknown>[]> {
    if (Array.isArray(params.deletes) && params.deletes.length > 0) {
      return params.deletes
    }
    if (!Array.isArray(params.deleteRows) || params.deleteRows.length === 0) {
      return []
    }
    let pkCols: string[] = []
    try {
      const details = await this.getTableDetails(params.table, targetSchema)
      pkCols = details.primaryKey
    } catch {
      pkCols = []
    }
    return projectDeleteRowsToPrimaryKeys(params.deleteRows, pkCols)
  }

  async previewChanges(params: ApplyChangesParams): Promise<PreviewChangesResult> {
    return this.runScrubbed(async () => {
      this.assertOpen()
      const targetSchema = this.resolveSchema(params.schema)
      const columnTypes = this.tableDetailsCache.resolveColumnTypes(
        targetSchema,
        this.defaultSchema,
        params.table,
        params.columnTypes
      )
      const normalizedDeletes = await this.resolveEffectiveDeletes(params, targetSchema)
      const batch = buildBatchStatements({
        driver: 'oracle',
        table: params.table,
        schema: targetSchema,
        inserts: params.inserts,
        updates: params.updates,
        deletes: normalizedDeletes,
        columnTypes,
      })
      return { statements: batch.previewStatements }
    })
  }

  async applyChanges(params: ApplyChangesParams): Promise<ApplyChangesResult> {
    return this.runScrubbed(async () => {
      this.assertOpen()
      this.assertWritable()
      const targetSchema = this.resolveSchema(params.schema)
      const columnTypes = this.tableDetailsCache.resolveColumnTypes(
        targetSchema,
        this.defaultSchema,
        params.table,
        params.columnTypes
      )
      const normalizedDeletes = await this.resolveEffectiveDeletes(params, targetSchema)

    const batch = buildBatchStatements({
      driver: 'oracle',
      table: params.table,
      schema: targetSchema,
      inserts: params.inserts,
      updates: params.updates,
      deletes: normalizedDeletes,
      columnTypes,
    })

    return this.runExclusiveOp(async () => {
      this.assertOpen()
      const insideManualTx = this.txActive || !this.autoCommit
      if (insideManualTx) {
        await this.conn.execute('SAVEPOINT datanoa_apply', {}, { autoCommit: false })
      }
      try {
        let deleted = 0
        for (const stmt of batch.deletes) {
          const res = await this.conn.execute(
            stripTrailingSemicolon(stmt.sql),
            toOracleBindObject(stmt.params),
            { autoCommit: false }
          )
          const count = Number(res.rowsAffected ?? 0)
          if (count === 0) {
            throw new DatabaseDriverError(
              'Record was modified or deleted by another session (optimistic lock conflict)',
              'conflict',
              'oracle'
            )
          }
          deleted += count
        }

        let updated = 0
        for (const stmt of batch.updates) {
          const res = await this.conn.execute(
            stripTrailingSemicolon(stmt.sql),
            toOracleBindObject(stmt.params),
            { autoCommit: false }
          )
          const count = Number(res.rowsAffected ?? 0)
          if (count === 0) {
            throw new DatabaseDriverError(
              'Record was modified or deleted by another session (optimistic lock conflict)',
              'conflict',
              'oracle'
            )
          }
          updated += count
        }

        let inserted = 0
        for (const stmt of batch.chunkedInserts) {
          const res = await this.conn.execute(
            stripTrailingSemicolon(stmt.sql),
            toOracleBindObject(stmt.params),
            { autoCommit: false }
          )
          inserted += Number(res.rowsAffected ?? stmt.rowCount)
        }

        if (!insideManualTx) {
          await this.conn.commit()
        } else {
          if (!this.txActive) {
            this.txActive = true
            this.txStartedAt = Date.now()
          }
          this.statementCount +=
            batch.deletes.length + batch.updates.length + batch.chunkedInserts.length
        }

        this.tableDetailsCache.clear()
        return {
          ok: true,
          inserted,
          updated,
          deleted,
          statements: batch.previewStatements,
        }
      } catch (err: unknown) {
        if (insideManualTx) {
          await this.conn
            .execute('ROLLBACK TO SAVEPOINT datanoa_apply', {}, { autoCommit: false })
            .catch(() => {})
        } else {
          await this.conn.rollback().catch(() => {})
        }
        throw err
      }
    })
    })
  }

  async runQuery(queryId: string, sql: string, maxRows = 1000): Promise<QueryResult> {
    this.assertOpen()
    const chunks = splitOracleStatements(sql)
    const execChunks: OracleStatementChunk[] =
      chunks.length > 0 ? chunks : [{ text: stripTrailingSemicolon(sql), isPlSql: false }]

    if (this.profile.readOnly && execChunks.some((c) => isOracleReadOnlyBlocked(c))) {
      this.assertWritable()
    }

    const activeEntry: ActiveOracleQuery = { cancelled: false }
    this.activeQueries.set(queryId, activeEntry)

    return this.runExclusiveOp(async () => {
      if (activeEntry.cancelled || this.isClosed) {
        this.activeQueries.delete(queryId)
        throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'oracle')
      }
      const startTime = performance.now()

      const collectedSets: QueryResultSet[] = []
      let totalAffectedRows = 0
      let lastSelect:
        | {
            columns: { name: string; type: string }[]
            rows: unknown[][]
            rowCount: number
            truncated: boolean
            isSelect: boolean
          }
        | undefined

      try {
        for (const chunk of execChunks) {
          if (activeEntry.cancelled || this.isClosed) {
            throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'oracle')
          }

          if (!chunk.isPlSql && isStandaloneCommit(chunk.text)) {
            await this.conn.commit()
            this.txActive = false
            this.statementCount = 0
            this.txStartedAt = undefined
            collectedSets.push({
              index: collectedSets.length,
              sqlPreview: compactSql(chunk.text),
              sql: chunk.text,
              executionTimeMs: 0,
              columns: [{ name: 'affected_rows', type: 'INTEGER' }],
              rows: [[0]],
              rowCount: 1,
              affectedRows: 0,
              truncated: false,
              isSelect: false,
            })
            continue
          }

          if (!chunk.isPlSql && isStandaloneRollback(chunk.text)) {
            await this.conn.rollback()
            this.txActive = false
            this.statementCount = 0
            this.txStartedAt = undefined
            collectedSets.push({
              index: collectedSets.length,
              sqlPreview: compactSql(chunk.text),
              sql: chunk.text,
              executionTimeMs: 0,
              columns: [{ name: 'affected_rows', type: 'INTEGER' }],
              rows: [[0]],
              rowCount: 1,
              affectedRows: 0,
              truncated: false,
              isSelect: false,
            })
            continue
          }

          const stmtStart = performance.now()
          let res: OracleResultLike
          try {
            res = await this.conn.execute(chunk.text, {}, {
              outFormat: getOracleOutFormatArray(),
              autoCommit: !this.txActive && this.autoCommit,
            })
          } catch (err: unknown) {
            const { errorNum } = extractOracleErrorCode(err)
            if (activeEntry.cancelled || errorNum === 1013) {
              throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'oracle', err)
            }
            throw scrubOracleError(err)
          }

          if (activeEntry.cancelled || this.isClosed) {
            throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'oracle')
          }

          if (isOracleImplicitCommitStatement(chunk.text)) {
            this.txActive = false
            this.statementCount = 0
            this.txStartedAt = undefined
          } else if (!this.autoCommit || this.txActive) {
            if (
              !this.txActive &&
              (chunk.isPlSql || isMutatingStatement(chunk.text, 'oracle'))
            ) {
              this.txActive = true
              this.txStartedAt = Date.now()
            }
            if (this.txActive) this.statementCount += 1
          }

          const stmtDurationMs = Math.round(performance.now() - stmtStart)
          const hasTabularResult =
            (Array.isArray(res.metaData) && res.metaData.length > 0) ||
            (Array.isArray(res.rows) && res.rows.length > 0)
          const affected = Number(res.rowsAffected ?? 0)
          totalAffectedRows += affected

          if (hasTabularResult) {
            const parsed = await extractOracleColumnsAndRows(res, maxRows)
            lastSelect = {
              columns: parsed.columns,
              rows: parsed.rows,
              rowCount: parsed.rowCount,
              truncated: parsed.truncated,
              isSelect: true,
            }
            collectedSets.push({
              index: collectedSets.length,
              sqlPreview: compactSql(chunk.text),
              sql: chunk.text,
              executionTimeMs: stmtDurationMs,
              columns: parsed.columns,
              rows: parsed.rows,
              rowCount: parsed.rowCount,
              affectedRows: affected,
              truncated: parsed.truncated,
              isSelect: true,
            })
          } else {
            collectedSets.push({
              index: collectedSets.length,
              sqlPreview: compactSql(chunk.text),
              sql: chunk.text,
              executionTimeMs: stmtDurationMs,
              columns: [{ name: 'affected_rows', type: 'INTEGER' }],
              rows: [[affected]],
              rowCount: 1,
              affectedRows: affected,
              truncated: false,
              isSelect: false,
            })
          }
        }

        const executionTimeMs = Math.round(performance.now() - startTime)
        return lastSelect
          ? {
              ...lastSelect,
              affectedRows: totalAffectedRows,
              ...(collectedSets.length > 1 ? { resultSets: collectedSets } : {}),
              executionTimeMs,
            }
          : {
              columns: [],
              rows: [],
              rowCount: 0,
              affectedRows: totalAffectedRows,
              executionTimeMs,
              truncated: false,
              isSelect: false,
              ...(collectedSets.length > 1 ? { resultSets: collectedSets } : {}),
            }
      } finally {
        if (containsDdlStatement(sql, 'oracle')) {
          this.tableDetailsCache.clear()
        }
        this.activeQueries.delete(queryId)
      }
    })
  }

  async cancelQuery(queryId: string): Promise<{ ok: boolean }> {
    this.assertOpen()
    const active = this.activeQueries.get(queryId)
    if (!active) {
      return { ok: true }
    }
    active.cancelled = true
    try {
      await this.breakConnectionExecution()
      return { ok: true }
    } catch {
      return { ok: false }
    }
  }

  getTransactionState(): TransactionState {
    return {
      active: this.txActive,
      autoCommit: this.autoCommit,
      statementCount: this.statementCount,
      startedAt: this.txStartedAt,
      supported: true,
    }
  }

  async beginTransaction(): Promise<TransactionState> {
    return this.runExclusiveOp(async () => {
      this.assertOpen()
      if (this.txActive) {
        throw new DatabaseDriverError('A transaction is already active', 'TX_ALREADY_ACTIVE', 'oracle')
      }
      this.txActive = true
      this.statementCount = 0
      this.txStartedAt = Date.now()
      return this.getTransactionState()
    })
  }

  async commitTransaction(): Promise<TransactionState> {
    return this.runExclusiveOp(async () => {
      this.assertOpen()
      if (!this.txActive) {
        throw new DatabaseDriverError('No active transaction to commit', 'NO_ACTIVE_TX', 'oracle')
      }
      await this.conn.commit()
      this.txActive = false
      this.statementCount = 0
      this.txStartedAt = undefined
      return this.getTransactionState()
    })
  }

  async rollbackTransaction(): Promise<TransactionState> {
    return this.runExclusiveOp(async () => {
      this.assertOpen()
      if (!this.txActive) {
        throw new DatabaseDriverError('No active transaction to rollback', 'NO_ACTIVE_TX', 'oracle')
      }
      await this.conn.rollback()
      this.txActive = false
      this.statementCount = 0
      this.txStartedAt = undefined
      return this.getTransactionState()
    })
  }

  async setAutoCommit(enabled: boolean): Promise<TransactionState> {
    return this.runExclusiveOp(async () => {
      this.assertOpen()
      if (enabled && this.txActive) {
        throw new DatabaseDriverError(
          'Cannot re-enable auto-commit while a transaction is active',
          'TX_ACTIVE',
          'oracle'
        )
      }
      this.autoCommit = enabled
      return this.getTransactionState()
    })
  }
}

export class OracleDriver implements IDatabaseDriver {
  readonly type = 'oracle' as const

  async createSession(
    profile: ConnectionProfile,
    password?: string,
    extraSecrets?: DriverTlsOptions
  ): Promise<IDatabaseSession> {
    ensureOracleLobFetchDefaults()
    const built = await buildOracleConnectionConfig(profile, password, extraSecrets)
    try {
      const conn = await oracledb.getConnection(built.attrs)

      try {
        if (built.currentSchema) {
          await conn.execute(
            `ALTER SESSION SET CURRENT_SCHEMA = ${sanitizeCurrentSchemaIdentifier(built.currentSchema)}`,
            {},
            { autoCommit: true }
          )
        } else if (built.usedDatabaseAsService && profile.database) {
          const dbSchema = normalizeOracleSchemaIdentifier(profile.database)
          if (dbSchema !== built.defaultSchema && dbSchema !== 'FREEPDB1' && dbSchema !== 'ORCLPDB1') {
            try {
              await conn.execute(
                `ALTER SESSION SET CURRENT_SCHEMA = ${sanitizeCurrentSchemaIdentifier(dbSchema)}`,
                {},
                { autoCommit: true }
              )
            } catch (err: unknown) {
              const { errorNum } = extractOracleErrorCode(err)
              if (errorNum !== 1435) throw err
            }
          }
        }
      } catch (err: unknown) {
        await conn.close().catch(() => {})
        throw err
      }

      return new OracleSession(conn as unknown as OracleConnectionLike, profile, {
        defaultSchema: built.defaultSchema,
      })
    } catch (err: unknown) {
      throw scrubOracleError(err)
    }
  }

  async testConnection(
    profile: ConnectionProfile,
    password?: string,
    extraSecrets?: DriverTlsOptions
  ): Promise<{ ok: boolean; message?: string }> {
    return runDriverConnectionTest(
      () => this.createSession(profile, password, extraSecrets),
      (err) => extractOracleErrorMessage(err, 'Oracle connection failed')
    )
  }
}
