import type { ConnectionProfile, DatabaseDriverType } from '../../protocol'
import { BUILTIN_ENGINE_CATALOG } from './engine-catalog'

export type EngineKind = 'file' | 'sql' | 'kv' | 'http'

export interface EngineMetadata {
  readonly id: DatabaseDriverType
  readonly label: string
  readonly shortLabel: string
  readonly defaultPort: number
  readonly supportsSsl: boolean
  readonly kind: EngineKind
}

export interface ParsedConnectionUri {
  ok: boolean
  profile?: Partial<ConnectionProfile>
  password?: string
  authToken?: string
  placeholderPassword?: boolean
  error?: string
}

export const ENGINE_CATALOG: readonly EngineMetadata[] = BUILTIN_ENGINE_CATALOG.map(
  (engine) => ({
    id: engine.id,
    label: engine.label,
    shortLabel: engine.shortLabel,
    defaultPort: engine.defaultPort ?? 0,
    supportsSsl: engine.supportsTlsConfig,
    kind:
      engine.transport === 'local-file'
        ? 'file'
        : engine.transport === 'http'
          ? 'http'
          : engine.isSql
            ? 'sql'
            : 'kv',
  })
)

export const SUPPORTED_DRIVERS: readonly DatabaseDriverType[] = ENGINE_CATALOG.map((engine) => engine.id)

export const ENGINE_BY_ID: Readonly<Record<DatabaseDriverType, EngineMetadata>> = Object.fromEntries(
  ENGINE_CATALOG.map((engine) => [engine.id, engine])
) as Readonly<Record<DatabaseDriverType, EngineMetadata>>

/**
 * Looks up static engine metadata for a supported database driver.
 */
export function getEngineMetadata(driver: DatabaseDriverType): EngineMetadata {
  const found = ENGINE_BY_ID[driver]
  if (!found) {
    throw new Error(`Unsupported database driver: ${driver}`)
  }
  return found
}

function decodeUriPart(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function parsePort(portStr: string, fallbackPort: number): number | null {
  if (!portStr) return fallbackPort
  const parsed = Number(portStr)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return null
  }
  return parsed
}

function resolveTlsFlag(params: URLSearchParams, defaultSsl: boolean): boolean {
  const sslMode = (params.get('sslmode') ?? params.get('ssl-mode'))?.trim().toLowerCase()
  if (
    sslMode === 'disable' ||
    sslMode === 'disabled' ||
    sslMode === 'false' ||
    sslMode === '0' ||
    sslMode === 'off' ||
    sslMode === 'no'
  ) {
    return false
  }
  if (
    sslMode === 'require' ||
    sslMode === 'required' ||
    sslMode === 'verify-full' ||
    sslMode === 'verify-ca' ||
    sslMode === 'verify_ca' ||
    sslMode === 'verify_identity'
  ) {
    return true
  }

  for (const key of ['tls', 'ssl', 'secure']) {
    const raw = params.get(key)
    if (raw === null) continue
    const normalized = raw.trim().toLowerCase()
    if (
      normalized === 'false' ||
      normalized === '0' ||
      normalized === 'disable' ||
      normalized === 'disabled' ||
      normalized === 'off' ||
      normalized === 'no'
    ) {
      return false
    }
    if (normalized.length > 0) return true
  }

  return defaultSsl
}

const CLOUD_DB_HOST_SUFFIXES: readonly string[] = [
  '.supabase.co',
  '.supabase.com',
  '.neon.tech',
  '.cockroachlabs.cloud',
  '.rds.amazonaws.com',
  '.aivencloud.com',
  '.render.com',
  '.railway.app',
  '.rlwy.net',
  '.database.azure.com',
  '.ondigitalocean.com',
  '.tidbcloud.com',
  '.psdb.cloud',
  '.planetscale.com',
  '.upstash.io',
  '.turso.io',
  '.clickhouse.cloud',
  '.clever-cloud.com',
  '.elephantsql.com',
  '.timescale.com',
  '.xata.sh',
  '.tembo.io',
]

export function isCloudDatabaseHost(hostname: string): boolean {
  const lower = (hostname || '').trim().toLowerCase()
  if (
    !lower ||
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower === '[::1]'
  ) {
    return false
  }
  return CLOUD_DB_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

export function isSupabaseHost(hostname: string): boolean {
  return /\.supabase\.(?:co|com)$/i.test((hostname || '').trim())
}

export function isSupabaseDirectHost(hostname: string): boolean {
  return /^db\.([a-z0-9-]+)\.supabase\.co$/i.test((hostname || '').trim())
}

const PLACEHOLDER_PASSWORD_RE =
  /^\[?(?:YOUR[-_]?DATABASE[-_]?PASSWORD|YOUR[-_]?PASSWORD|PASSWORD|<PASSWORD>)\]?$/i

interface StandardUrlResult {
  url: URL
  placeholderPassword: boolean
}

function safeParseUrl(candidate: string): URL | null {
  try {
    return new URL(candidate)
  } catch {
    return null
  }
}

function buildPasswordNormalizedUrl(
  prefix: string,
  rawPass: string,
  hostAndRest: string
): StandardUrlResult | null {
  const trimmedPass = rawPass.trim()
  if (!trimmedPass || PLACEHOLDER_PASSWORD_RE.test(trimmedPass)) {
    const parsed = safeParseUrl(`${prefix}@${hostAndRest}`)
    return parsed ? { url: parsed, placeholderPassword: true } : null
  }
  const parsed = safeParseUrl(
    `${prefix}:${encodeURIComponent(decodeUriPart(rawPass))}@${hostAndRest}`
  )
  return parsed ? { url: parsed, placeholderPassword: false } : null
}

function normalizeRawUriInput(rawUri: string): string {
  let value = rawUri.trim()
  const envAssign = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/.exec(value)
  if (envAssign && envAssign[1]) {
    const rhs = envAssign[1].trim()
    if (
      /^["']?(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|(?:sqlite|file):)/.test(rhs)
    ) {
      value = rhs
    }
  }
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim()
  }
  return value
}

function parseStandardUrl(rawUri: string): StandardUrlResult | null {
  // Always normalize bracketed userinfo passwords BEFORE calling new URL(), because inputs
  // without '#' (e.g. postgres://user:[MyPass]@host) parse cleanly in WHATWG URL and would
  // otherwise keep literal '[' and ']' inside url.password.
  const bracketMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:/?#\s@]*):\[([^\]]*)\]@(.+)$/.exec(rawUri)
  if (bracketMatch) {
    const normalized = buildPasswordNormalizedUrl(
      bracketMatch[1],
      bracketMatch[2],
      bracketMatch[3]
    )
    if (normalized) return normalized
  }

  const direct = safeParseUrl(rawUri)
  const suspiciousAuthorityMisparse =
    direct !== null &&
    ((direct.hash.length > 0 && direct.hash.includes('@')) ||
      (direct.search.length > 0 && direct.search.includes('@') && !direct.password))
  if (direct && !suspiciousAuthorityMisparse) {
    return { url: direct, placeholderPassword: false }
  }

  // Recover URIs whose unencoded '#' or '?' in password truncated the authority or confused new URL()
  const authorityMatch =
    /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:/?#\s@]*):(.*)@((?:\[[0-9a-fA-F:%.]+\]|[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)(?::\d{1,5})?(?:\/[^?#@]*)?(?:\?[^@]*)?(?:#[^@]*)?)$/.exec(
      rawUri
    )
  if (authorityMatch) {
    const normalized = buildPasswordNormalizedUrl(
      authorityMatch[1],
      authorityMatch[2],
      authorityMatch[3]
    )
    if (normalized) return normalized
  }

  return direct ? { url: direct, placeholderPassword: false } : null
}

function resolveUriPassword(
  rawPassword: string | undefined,
  placeholderFromUrl: boolean
): { password?: string; placeholderPassword: boolean } {
  const isPlaceholder =
    placeholderFromUrl || (rawPassword ? PLACEHOLDER_PASSWORD_RE.test(rawPassword.trim()) : false)
  return {
    password: rawPassword && !isPlaceholder ? rawPassword : undefined,
    placeholderPassword: isPlaceholder,
  }
}

function buildSuccessResult(
  profile: Partial<ConnectionProfile>,
  options?: { user?: string; password?: string; authToken?: string; placeholderPassword?: boolean }
): ParsedConnectionUri {
  if (options?.user !== undefined) profile.user = options.user
  if (options?.password !== undefined) profile.hasPassword = true
  if (options?.authToken !== undefined) profile.hasAuthToken = true

  const result: ParsedConnectionUri = { ok: true, profile }
  if (options?.password !== undefined) result.password = options.password
  if (options?.authToken !== undefined) result.authToken = options.authToken
  if (options?.placeholderPassword) result.placeholderPassword = true
  return result
}

function buildHttpOrigin(protocol: 'http' | 'https', hostname: string, port: number): string {
  const isStandardPort = (protocol === 'http' && port === 80) || (protocol === 'https' && port === 443)
  return isStandardPort ? `${protocol}://${hostname}` : `${protocol}://${hostname}:${port}`
}

interface SqlUriSpec {
  readonly driver: DatabaseDriverType
  readonly defaultPort: number
  readonly defaultDatabase: string
  readonly defaultSsl: boolean
}

const SQL_URI_SPECS: Readonly<Record<string, SqlUriSpec>> = {
  postgres: { driver: 'postgres', defaultPort: 5432, defaultDatabase: 'postgres', defaultSsl: false },
  postgresql: { driver: 'postgres', defaultPort: 5432, defaultDatabase: 'postgres', defaultSsl: false },
  cockroachdb: { driver: 'cockroachdb', defaultPort: 26257, defaultDatabase: 'defaultdb', defaultSsl: true },
  cockroach: { driver: 'cockroachdb', defaultPort: 26257, defaultDatabase: 'defaultdb', defaultSsl: true },
  mysql: { driver: 'mysql', defaultPort: 3306, defaultDatabase: '', defaultSsl: false },
  mariadb: { driver: 'mariadb', defaultPort: 3306, defaultDatabase: '', defaultSsl: false },
  mssql: { driver: 'mssql' as DatabaseDriverType, defaultPort: 1433, defaultDatabase: 'master', defaultSsl: false },
  sqlserver: { driver: 'mssql' as DatabaseDriverType, defaultPort: 1433, defaultDatabase: 'master', defaultSsl: false },
  oracle: { driver: 'oracle' as DatabaseDriverType, defaultPort: 1521, defaultDatabase: 'FREEPDB1', defaultSsl: false },
  mongodb: { driver: 'mongodb' as DatabaseDriverType, defaultPort: 27017, defaultDatabase: 'admin', defaultSsl: false },
  'mongodb+srv': { driver: 'mongodb' as DatabaseDriverType, defaultPort: 27017, defaultDatabase: 'admin', defaultSsl: true },
}

function parseSqlNetworkUri(
  url: URL,
  spec: SqlUriSpec,
  placeholderFromUrl = false
): ParsedConnectionUri {
  if (!url.hostname) {
    return { ok: false, error: `Missing host in ${spec.driver} connection URI.` }
  }

  const port = parsePort(url.port, spec.defaultPort)
  if (port === null) {
    return { ok: false, error: `Invalid port in ${spec.driver} connection URI.` }
  }

  const rawDb = decodeUriPart(url.pathname.replace(/^\/+/, ''))
  const database = rawDb || spec.defaultDatabase
  const user = url.username ? decodeUriPart(url.username) : undefined
  const rawPassword = url.password ? decodeUriPart(url.password) : undefined
  const { password, placeholderPassword } = resolveUriPassword(rawPassword, placeholderFromUrl)
  const defaultSsl = spec.defaultSsl || isCloudDatabaseHost(url.hostname)
  const ssl = resolveTlsFlag(url.searchParams, defaultSsl)
  const rawOptions = url.searchParams.get('options')
  const options = rawOptions && rawOptions.trim().length > 0 ? rawOptions.trim() : undefined

  return buildSuccessResult(
    {
      driver: spec.driver,
      name: url.hostname,
      host: url.hostname,
      port,
      database,
      ssl,
      ...(options ? { options } : {}),
    },
    { user, password, placeholderPassword }
  )
}

function parseRedisUri(
  url: URL,
  scheme: string,
  placeholderFromUrl = false
): ParsedConnectionUri {
  if (!url.hostname) {
    return { ok: false, error: 'Missing host in redis connection URI.' }
  }

  const port = parsePort(url.port, 6379)
  if (port === null) {
    return { ok: false, error: 'Invalid port in redis connection URI.' }
  }

  const rawDbSegment = decodeUriPart(url.pathname.replace(/^\/+/, '').replace(/\/+$/, ''))
  const dbCandidate = rawDbSegment || (url.searchParams.get('db') ?? '')
  let redisDb = 0
  if (dbCandidate.length > 0) {
    if (!/^\d+$/.test(dbCandidate)) {
      return { ok: false, error: `Invalid Redis database index: '${dbCandidate}'. Expected 0..15.` }
    }
    const parsedDb = Number(dbCandidate)
    if (parsedDb < 0 || parsedDb > 15) {
      return { ok: false, error: `Redis database index '${dbCandidate}' out of range (0..15).` }
    }
    redisDb = parsedDb
  }

  const defaultSsl = scheme === 'rediss' || isCloudDatabaseHost(url.hostname)
  const ssl = resolveTlsFlag(url.searchParams, defaultSsl)
  const user = url.username ? decodeUriPart(url.username) : undefined
  const queryPassword = url.searchParams.get('password') || undefined
  const rawPassword = url.password ? decodeUriPart(url.password) : queryPassword
  const { password, placeholderPassword } = resolveUriPassword(rawPassword, placeholderFromUrl)

  return buildSuccessResult(
    {
      driver: 'redis',
      name: url.hostname,
      host: url.hostname,
      port,
      database: String(redisDb),
      redisDb,
      ssl,
    },
    { user, password, placeholderPassword }
  )
}

function parseClickHouseUri(
  url: URL,
  scheme: string,
  placeholderFromUrl = false
): ParsedConnectionUri {
  if (!url.hostname) {
    return { ok: false, error: 'Missing host in ClickHouse connection URI.' }
  }

  const defaultSsl =
    scheme === 'https' ||
    scheme === 'clickhouses' ||
    (scheme !== 'http' && isCloudDatabaseHost(url.hostname))
  const ssl = resolveTlsFlag(url.searchParams, defaultSsl)
  const defaultPortMap: Readonly<Record<string, number>> = {
    clickhouse: 8123,
    clickhouses: 8443,
    http: 80,
    https: 443,
  }
  const port = parsePort(url.port, defaultPortMap[scheme] ?? 8123)
  if (port === null) {
    return { ok: false, error: 'Invalid port in ClickHouse connection URI.' }
  }

  const normalizedUrl = buildHttpOrigin(ssl ? 'https' : 'http', url.hostname, port)
  const pathDb = decodeUriPart(url.pathname.replace(/^\/+/, ''))
  const database = pathDb || url.searchParams.get('database') || 'default'
  const user = url.username ? decodeUriPart(url.username) : (url.searchParams.get('user') || undefined)
  const rawPassword = url.password
    ? decodeUriPart(url.password)
    : (url.searchParams.get('password') || undefined)
  const { password, placeholderPassword } = resolveUriPassword(rawPassword, placeholderFromUrl)

  return buildSuccessResult(
    {
      driver: 'clickhouse',
      name: url.hostname,
      url: normalizedUrl,
      host: url.hostname,
      port,
      database,
      ssl,
    },
    { user, password, placeholderPassword }
  )
}

function parseLibsqlUri(url: URL): ParsedConnectionUri {
  if (!url.hostname) {
    return { ok: false, error: 'Missing host in LibSQL connection URI.' }
  }

  const defaultSsl = url.protocol !== 'http:'
  const ssl = resolveTlsFlag(url.searchParams, defaultSsl)
  const port = parsePort(url.port, ssl ? 443 : 80)
  if (port === null) {
    return { ok: false, error: 'Invalid port in LibSQL connection URI.' }
  }

  const cleanPath = url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/+$/, '') : ''
  const normalizedUrl = `${buildHttpOrigin(ssl ? 'https' : 'http', url.hostname, port)}${cleanPath}`
  const pathDb = decodeUriPart(url.pathname.replace(/^\/+/, '').replace(/\/+$/, ''))
  const database = pathDb || url.hostname
  const authTokenRaw =
    url.searchParams.get('authToken') ??
    url.searchParams.get('auth_token') ??
    url.searchParams.get('jwt')
  const authToken = authTokenRaw && authTokenRaw.length > 0 ? authTokenRaw : undefined

  return buildSuccessResult(
    {
      driver: 'libsql',
      name: url.hostname,
      url: normalizedUrl,
      host: url.hostname,
      port,
      database,
      ssl,
    },
    { authToken }
  )
}

const D1_ENDPOINT_CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/
const SENSITIVE_URL_QUERY_PARAM_RE =
  /^(?:token|auth_?token|api_?key|key|secret|password|pwd|access_?token|bearer)$/i

function isD1LoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase()
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true
  if (!/^127(?:\.\d{1,3}){3}$/.test(host)) return false
  return host.split('.').every((part) => Number(part) <= 255)
}

export function isD1HttpLoopbackEndpoint(rawUrl: string): boolean {
  const trimmed = rawUrl.trim()
  if (!trimmed) return false
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' && isD1LoopbackHostname(parsed.hostname)
  } catch {
    return false
  }
}

export function validateD1EndpointUrl(
  rawUrl: string,
  options?: { hasAuthToken?: boolean }
): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = rawUrl.trim()
  if (!trimmed) {
    return { ok: false, error: 'Cloudflare D1 endpoint URL cannot be empty.' }
  }
  if (D1_ENDPOINT_CONTROL_CHARS_RE.test(trimmed)) {
    return { ok: false, error: 'Cloudflare D1 endpoint URL must not contain control characters.' }
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: 'Cloudflare D1 endpoint URL is not a valid absolute URL.' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      ok: false,
      error: `Unsupported Cloudflare D1 endpoint scheme "${parsed.protocol}" — only http(s) is allowed.`,
    }
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error:
        'Cloudflare D1 endpoint URL must not contain embedded credentials; store the API token in Secrets.',
    }
  }
  for (const key of parsed.searchParams.keys()) {
    if (SENSITIVE_URL_QUERY_PARAM_RE.test(key)) {
      return {
        ok: false,
        error: `Cloudflare D1 endpoint URL must not include credential query parameter "${key}"; store the API token in Secrets.`,
      }
    }
  }
  if (parsed.protocol === 'http:') {
    if (!isD1LoopbackHostname(parsed.hostname)) {
      return {
        ok: false,
        error:
          'Cloudflare D1 endpoint URL must use HTTPS; plain HTTP is only allowed for localhost, 127.0.0.0/8, or [::1].',
      }
    }
    if (options?.hasAuthToken) {
      return {
        ok: false,
        error:
          'Cloudflare D1 endpoint URL cannot send an API token over plain HTTP; use HTTPS or remove the token for localhost/loopback emulators.',
      }
    }
  }
  return { ok: true, url: trimmed }
}

export function scrubUrlCredentials(rawUrl: string): string | undefined {
  const trimmed = rawUrl.trim()
  if (!trimmed) return undefined
  try {
    const parsed = new URL(trimmed)
    parsed.username = ''
    parsed.password = ''
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_URL_QUERY_PARAM_RE.test(key)) {
        parsed.searchParams.delete(key)
      }
    }
    return parsed.toString()
  } catch {
    return undefined
  }
}

function parseD1Uri(url: URL): ParsedConnectionUri {
  const accountId = decodeUriPart(url.hostname)
  const databaseId = decodeUriPart(url.pathname.replace(/^\/+/, '').replace(/\/+$/, ''))
  if (!accountId) {
    return { ok: false, error: 'Cloudflare D1 URI must include an account ID (d1://account/database).' }
  }
  if (!databaseId) {
    return { ok: false, error: 'Cloudflare D1 URI must include a database ID (d1://account/database).' }
  }
  const tokenRaw =
    url.searchParams.get('token') ??
    url.searchParams.get('authToken') ??
    url.searchParams.get('auth_token')
  const authToken = tokenRaw && tokenRaw.length > 0 ? tokenRaw : undefined
  const endpoint = (url.searchParams.get('endpoint') ?? '').trim()
  const profile: Partial<ConnectionProfile> = {
    driver: 'd1',
    name: databaseId,
    database: databaseId,
    d1AccountId: accountId,
    d1DatabaseId: databaseId,
    ssl: true,
  }
  if (endpoint) {
    const validated = validateD1EndpointUrl(endpoint, {
      hasAuthToken: Boolean(authToken && authToken.trim().length > 0),
    })
    if (!validated.ok) {
      return { ok: false, error: validated.error }
    }
    profile.url = validated.url
  }
  return buildSuccessResult(profile, { authToken })
}

function extractBasename(filePath: string): string {
  if (filePath === ':memory:') return ':memory:'
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

function parseSqliteUri(rawUri: string): ParsedConnectionUri {
  const withoutHash = rawUri.split('#', 1)[0]
  const qIdx = withoutHash.indexOf('?')
  const pathPart = qIdx >= 0 ? withoutHash.slice(0, qIdx) : withoutHash
  const queryPart = qIdx >= 0 ? withoutHash.slice(qIdx + 1) : ''
  const searchParams = new URLSearchParams(queryPart)

  let rawTarget = pathPart.replace(/^(?:sqlite|file):(?:\/\/)?/i, '')
  if (/^localhost\//i.test(rawTarget)) {
    rawTarget = rawTarget.slice('localhost'.length)
  }

  let filePath = decodeUriPart(rawTarget)
  if (/^\/[A-Za-z]:[/\\]/.test(filePath)) {
    filePath = filePath.slice(1)
  }

  if (!filePath || filePath === '/') {
    return { ok: false, error: 'SQLite URI is missing a file path.' }
  }

  const database = extractBasename(filePath)
  if (!database) {
    return { ok: false, error: 'SQLite URI must point to a database file or :memory:.' }
  }

  const profile: Partial<ConnectionProfile> = {
    driver: 'sqlite',
    name: database,
    database,
    filePath,
  }
  if (searchParams.get('mode')?.toLowerCase() === 'ro') {
    profile.readOnly = true
  }

  return { ok: true, profile }
}

/**
 * Parses a database connection URI across supported Datanoa engines into a partial ConnectionProfile and credentials.
 */
export function parseConnectionUri(rawUri: string): ParsedConnectionUri {
  if (typeof rawUri !== 'string' || rawUri.trim().length === 0) {
    return { ok: false, error: 'Connection URI cannot be empty.' }
  }

  const trimmed = normalizeRawUriInput(rawUri)
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)
  if (!schemeMatch) {
    return { ok: false, error: 'Connection URI must start with a valid scheme (e.g. postgres://).' }
  }

  const scheme = schemeMatch[1].toLowerCase()
  if (scheme === 'sqlite' || scheme === 'file') {
    return parseSqliteUri(trimmed)
  }

  const parsedUrl = parseStandardUrl(trimmed)
  if (!parsedUrl) {
    return { ok: false, error: `Malformed ${scheme} connection URI.` }
  }
  const { url, placeholderPassword } = parsedUrl

  const sqlSpec = SQL_URI_SPECS[scheme]
  if (sqlSpec) {
    return parseSqlNetworkUri(url, sqlSpec, placeholderPassword)
  }

  if (scheme === 'redis' || scheme === 'rediss') {
    return parseRedisUri(url, scheme, placeholderPassword)
  }

  if (scheme === 'libsql') {
    return parseLibsqlUri(url)
  }

  if (scheme === 'd1' || scheme === 'd1+http' || scheme === 'd1+https') {
    return parseD1Uri(url)
  }

  if (scheme === 'http' || scheme === 'https') {
    const lowerHost = (url.hostname || '').toLowerCase()
    const hasLibsqlToken =
      url.searchParams.has('authToken') ||
      url.searchParams.has('auth_token') ||
      url.searchParams.has('jwt')
    if (lowerHost.endsWith('.turso.io') || hasLibsqlToken) {
      return parseLibsqlUri(url)
    }
    return parseClickHouseUri(url, scheme, placeholderPassword)
  }

  if (scheme === 'clickhouse' || scheme === 'clickhouses') {
    return parseClickHouseUri(url, scheme, placeholderPassword)
  }

  return { ok: false, error: `Unsupported connection URI scheme: ${scheme}` }
}
