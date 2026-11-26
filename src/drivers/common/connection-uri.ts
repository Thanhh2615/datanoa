import type { ConnectionProfile, DatabaseDriverType, SslMode } from '../../protocol'
import {
  findCredentialAuthorityAtIndex,
  isCloudDatabaseHost,
  isSensitiveUriParamKey,
} from '../../shared-sql-safety.js'
import { BUILTIN_ENGINE_CATALOG } from './engine-catalog'

export { isCloudDatabaseHost }

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
    return raw.replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq)
      } catch {
        return seq.replace(/%[0-7][0-9A-Fa-f]/g, (byte) =>
          String.fromCharCode(parseInt(byte.slice(1), 16))
        )
      }
    })
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

export interface ResolvedTlsSettings {
  ssl: boolean
  sslMode?: SslMode
  sslRejectUnauthorized?: boolean
  error?: string
}

export function resolveTlsSettings(
  params: URLSearchParams,
  defaultSsl: boolean
): ResolvedTlsSettings {
  const rawSslMode = (params.get('sslmode') || params.get('ssl-mode') || '').trim()
  const sslMode = rawSslMode.toLowerCase()
  if (
    sslMode === 'disable' ||
    sslMode === 'disabled' ||
    sslMode === 'false' ||
    sslMode === '0' ||
    sslMode === 'off' ||
    sslMode === 'no'
  ) {
    return { ssl: false, sslMode: 'disable' }
  }
  if (sslMode === 'verify-full' || sslMode === 'verify_identity') {
    return { ssl: true, sslMode: 'verify-full', sslRejectUnauthorized: true }
  }
  if (sslMode === 'verify-ca' || sslMode === 'verify_ca') {
    return { ssl: true, sslMode: 'verify-ca', sslRejectUnauthorized: true }
  }
  if (sslMode === 'require' || sslMode === 'required') {
    return { ssl: true, sslMode: 'require', sslRejectUnauthorized: false }
  }
  if (sslMode === 'prefer') {
    return { ssl: true }
  }
  if (sslMode === 'allow') {
    return { ssl: defaultSsl }
  }
  if (sslMode.length > 0) {
    return {
      ssl: true,
      sslMode: 'verify-full',
      sslRejectUnauthorized: true,
      error: `Unsupported sslmode: ${rawSslMode}`,
    }
  }

  for (const key of ['tls', 'ssl', 'secure']) {
    const raw = params.get(key)
    if (raw === null) continue
    const trimmedRaw = raw.trim()
    if (trimmedRaw.startsWith('{')) {
      try {
        const parsedJson = JSON.parse(trimmedRaw) as unknown
        if (parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)) {
          const rec = parsedJson as Record<string, unknown>
          if (rec.rejectUnauthorized === true) {
            return { ssl: true, sslMode: 'verify-full', sslRejectUnauthorized: true }
          }
          if (rec.rejectUnauthorized === false) {
            return { ssl: true, sslMode: 'require', sslRejectUnauthorized: false }
          }
        }
        return { ssl: true }
      } catch {
        return { ssl: true }
      }
    }
    const normalized = trimmedRaw.toLowerCase()
    if (
      normalized === 'false' ||
      normalized === '0' ||
      normalized === 'disable' ||
      normalized === 'disabled' ||
      normalized === 'off' ||
      normalized === 'no'
    ) {
      return { ssl: false }
    }
    if (normalized.length > 0) return { ssl: true }
  }

  return { ssl: defaultSsl }
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
  authoritySeedList?: string
}

function safeParseUrl(candidate: string): URL | null {
  try {
    return new URL(candidate)
  } catch {
    return null
  }
}

function isValidAuthoritySeedItem(rawHostPort: string): boolean {
  const m =
    /^(\[[0-9a-fA-F:%.]+\]|[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)(?::(\d{1,5}))?$/.exec(
      rawHostPort
    )
  if (!m) return false
  if (/^\d+$/.test(m[1])) return false
  if (m[2]) {
    const port = Number(m[2])
    if (port < 1 || port > 65535) return false
  }
  return true
}

export function splitCommaSeedAuthority(hostAndRest: string): {
  primaryHostAndRest: string
  authoritySeedList?: string
} {
  const delimIdx = hostAndRest.search(/[/?#]/)
  const rawAuthority = delimIdx >= 0 ? hostAndRest.slice(0, delimIdx) : hostAndRest
  if (!rawAuthority.includes(',')) {
    return { primaryHostAndRest: hostAndRest }
  }
  const items = rawAuthority.split(',')
  if (items.length < 2 || !items.every(isValidAuthoritySeedItem)) {
    return { primaryHostAndRest: hostAndRest }
  }
  const suffix = delimIdx >= 0 ? hostAndRest.slice(delimIdx) : ''
  return {
    primaryHostAndRest: `${items[0]}${suffix}`,
    authoritySeedList: rawAuthority,
  }
}

function replaceAuthorityHostPreservingPath(
  scrubbedUrlString: string,
  authoritySeedList?: string
): string {
  if (!authoritySeedList) return scrubbedUrlString
  const schemeEnd = scrubbedUrlString.indexOf('://')
  const afterScheme = scrubbedUrlString.slice(schemeEnd + 3)
  const delimIdx = afterScheme.search(/[/?#]/)
  const suffix = delimIdx >= 0 ? afterScheme.slice(delimIdx) : ''
  return `${scrubbedUrlString.slice(0, schemeEnd + 3)}${authoritySeedList}${suffix}`
}

function buildPasswordNormalizedUrl(
  prefix: string,
  rawPass: string,
  hostAndRest: string
): StandardUrlResult | null {
  const { primaryHostAndRest, authoritySeedList } = splitCommaSeedAuthority(hostAndRest)
  const trimmedPass = rawPass.trim()
  if (!trimmedPass || PLACEHOLDER_PASSWORD_RE.test(trimmedPass)) {
    const parsed = safeParseUrl(`${prefix}@${primaryHostAndRest}`)
    return parsed
      ? { url: parsed, placeholderPassword: true, ...(authoritySeedList ? { authoritySeedList } : {}) }
      : null
  }
  const parsed = safeParseUrl(
    `${prefix}:${encodeURIComponent(decodeUriPart(rawPass))}@${primaryHostAndRest}`
  )
  return parsed
    ? { url: parsed, placeholderPassword: false, ...(authoritySeedList ? { authoritySeedList } : {}) }
    : null
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

function recoverAuthorityUrl(rawUri: string): StandardUrlResult | null {
  const schemeEnd = rawUri.indexOf('://')
  if (schemeEnd <= 0) return null

  const schemePrefix = rawUri.slice(0, schemeEnd + 3)
  const body = rawUri.slice(schemeEnd + 3)
  const delimIdx = body.search(/[:/?#@[\]]/)
  if (delimIdx < 0 || body[delimIdx] !== ':') return null

  const atIdx = findCredentialAuthorityAtIndex(schemePrefix, body, delimIdx)
  if (atIdx <= delimIdx) return null

  return buildPasswordNormalizedUrl(
    `${schemePrefix}${body.slice(0, delimIdx)}`,
    body.slice(delimIdx + 1, atIdx),
    body.slice(atIdx + 1)
  )
}

function recoverCommaSeedAuthorityUrl(rawUri: string): StandardUrlResult | null {
  const m =
    /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(?:([^:/?#\s@[\]]*)@)?([^/?#\s@]+(?:,[^/?#\s@]+)+)(.*)$/.exec(
      rawUri
    )
  if (!m) return null
  const { primaryHostAndRest, authoritySeedList } = splitCommaSeedAuthority(`${m[3]}${m[4]}`)
  if (!authoritySeedList) return null
  const prefix = m[2] !== undefined ? `${m[1]}${m[2]}@` : m[1]
  const parsed = safeParseUrl(`${prefix}${primaryHostAndRest}`)
  return parsed ? { url: parsed, placeholderPassword: false, authoritySeedList } : null
}

function shouldAttemptAuthorityRecovery(direct: URL, rawUri: string): boolean {
  if (
    (direct.protocol === 'mongodb:' || direct.protocol === 'mongodb+srv:') &&
    direct.hostname.includes(',')
  ) {
    return true
  }
  if (direct.hostname.startsWith('[')) {
    return false
  }
  const hashLooksLikePasswordTail =
    direct.hash.includes('@') && !/^#[^#@=]*=/.test(direct.hash)
  if (direct.password.length > 0) {
    return hashLooksLikePasswordTail
  }
  if (direct.username.length > 0) {
    return false
  }
  const hasColonBeforeDelim = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^:/?#\s@[\]]*:/.test(rawUri)
  return hasColonBeforeDelim && (direct.pathname + direct.search + direct.hash).includes('@')
}

function parseStandardUrl(rawUri: string): StandardUrlResult | null {
  // Always normalize bracketed userinfo passwords BEFORE calling new URL(), because inputs
  // without '#' (e.g. postgres://user:[MyPass]@host) parse cleanly in WHATWG URL and would
  // otherwise keep literal '[' and ']' inside url.password.
  const bracketMatch =
    /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:/?#\s@[\]]*):\[([^\]]*)\]@(.+)$/.exec(rawUri)
  if (bracketMatch) {
    const normalized = buildPasswordNormalizedUrl(
      bracketMatch[1],
      bracketMatch[2],
      bracketMatch[3]
    )
    if (normalized) return normalized
  }

  const direct = safeParseUrl(rawUri)
  if (direct && !shouldAttemptAuthorityRecovery(direct, rawUri)) {
    return { url: direct, placeholderPassword: false }
  }

  // Recover URIs whose unencoded '/', '#' or '?' in password truncated the authority or confused new URL()
  const recovered = recoverAuthorityUrl(rawUri)
  if (recovered) {
    return recovered
  }

  const commaRecovered = recoverCommaSeedAuthorityUrl(rawUri)
  if (commaRecovered) {
    return commaRecovered
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
  mssql: { driver: 'mssql', defaultPort: 1433, defaultDatabase: 'master', defaultSsl: false },
  sqlserver: { driver: 'mssql', defaultPort: 1433, defaultDatabase: 'master', defaultSsl: false },
  oracle: { driver: 'oracle', defaultPort: 1521, defaultDatabase: 'FREEPDB1', defaultSsl: false },
  oracledb: { driver: 'oracle', defaultPort: 1521, defaultDatabase: 'FREEPDB1', defaultSsl: false },
  mongodb: { driver: 'mongodb', defaultPort: 27017, defaultDatabase: 'admin', defaultSsl: false },
  'mongodb+srv': { driver: 'mongodb', defaultPort: 27017, defaultDatabase: 'admin', defaultSsl: true },
}

function parseSqlNetworkUri(
  url: URL,
  spec: SqlUriSpec,
  placeholderFromUrl = false,
  authoritySeedList?: string
): ParsedConnectionUri {
  if (!url.hostname) {
    return { ok: false, error: `Missing host in ${spec.driver} connection URI.` }
  }

  const port = parsePort(url.port, spec.defaultPort)
  if (port === null) {
    return { ok: false, error: `Invalid port in ${spec.driver} connection URI.` }
  }

  const rawDb = decodeUriPart(url.pathname.replace(/^\/+/, '').replace(/\/+$/, ''))
  const hasOracleQueryTarget =
    spec.driver === 'oracle' &&
    ['sid', 'serviceName', 'service'].some((key) =>
      Boolean((url.searchParams.get(key) || '').trim())
    )
  const database = rawDb || (hasOracleQueryTarget ? '' : spec.defaultDatabase)
  const user = url.username ? decodeUriPart(url.username) : undefined
  const rawPassword = url.password ? decodeUriPart(url.password) : undefined
  const { password, placeholderPassword } = resolveUriPassword(rawPassword, placeholderFromUrl)
  const defaultSsl = spec.defaultSsl || isCloudDatabaseHost(url.hostname)
  let tls = resolveTlsSettings(url.searchParams, defaultSsl)
  if (tls.error) {
    return { ok: false, error: tls.error }
  }
  if (
    spec.driver === 'mssql' &&
    tls.sslMode === undefined &&
    !url.searchParams.has('ssl') &&
    !url.searchParams.has('tls')
  ) {
    const encRaw = (url.searchParams.get('encrypt') || '').trim().toLowerCase()
    const trustRaw = (url.searchParams.get('trustServerCertificate') || '').trim().toLowerCase()
    if (encRaw === 'false' || encRaw === '0' || encRaw === 'no') {
      tls = { ssl: false, sslMode: 'disable' }
    } else if (encRaw === 'true' || encRaw === '1' || encRaw === 'yes') {
      if (trustRaw === 'true' || trustRaw === '1' || trustRaw === 'yes') {
        tls = { ssl: true, sslMode: 'require', sslRejectUnauthorized: false }
      } else if (trustRaw === 'false' || trustRaw === '0' || trustRaw === 'no') {
        tls = { ssl: true, sslMode: 'verify-full', sslRejectUnauthorized: true }
      } else {
        tls = { ssl: true }
      }
    }
  }
  const rawOptions = url.searchParams.get('options')
  const options = rawOptions && rawOptions.trim().length > 0 ? rawOptions.trim() : undefined
  const hasOracleUrlParams =
    spec.driver === 'oracle' &&
    ['schema', 'sid', 'serviceName', 'service'].some((key) => url.searchParams.has(key))
  const networkUrl =
    spec.driver === 'mongodb' || hasOracleUrlParams
      ? scrubParsedStandardUrl(url, authoritySeedList)
      : undefined

  return buildSuccessResult(
    {
      driver: spec.driver,
      name: url.hostname,
      host: url.hostname,
      port,
      database,
      ssl: tls.ssl,
      ...(tls.sslMode !== undefined ? { sslMode: tls.sslMode } : {}),
      ...(tls.sslRejectUnauthorized !== undefined
        ? { sslRejectUnauthorized: tls.sslRejectUnauthorized }
        : {}),
      ...(networkUrl ? { url: networkUrl } : {}),
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
  const tls = resolveTlsSettings(url.searchParams, defaultSsl)
  if (tls.error) {
    return { ok: false, error: tls.error }
  }
  const { ssl } = tls
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
      ...(tls.sslMode !== undefined ? { sslMode: tls.sslMode } : {}),
      ...(tls.sslRejectUnauthorized !== undefined
        ? { sslRejectUnauthorized: tls.sslRejectUnauthorized }
        : {}),
    },
    { user, password, placeholderPassword }
  )
}

function parseClickHouseUri(
  url: URL,
  scheme: 'clickhouse' | 'clickhouses' | 'http' | 'https',
  placeholderFromUrl = false
): ParsedConnectionUri {
  if (!url.hostname) {
    return { ok: false, error: 'Missing host in ClickHouse connection URI.' }
  }

  const defaultSsl =
    scheme === 'https' ||
    scheme === 'clickhouses' ||
    (scheme !== 'http' && isCloudDatabaseHost(url.hostname))
  const chTls = resolveTlsSettings(url.searchParams, defaultSsl)
  if (chTls.error) {
    return { ok: false, error: chTls.error }
  }
  const { ssl } = chTls
  const defaultPortMap: Readonly<Record<'clickhouse' | 'clickhouses' | 'http' | 'https', number>> = {
    clickhouse: 8123,
    clickhouses: 8443,
    http: 80,
    https: 443,
  }
  const port = parsePort(url.port, defaultPortMap[scheme])
  if (port === null) {
    return { ok: false, error: 'Invalid port in ClickHouse connection URI.' }
  }

  const normalizedUrl = buildHttpOrigin(ssl ? 'https' : 'http', url.hostname, port)
  const pathDb = decodeUriPart(url.pathname.replace(/^\/+/, '').replace(/\/+$/, ''))
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
      ...(chTls.sslMode !== undefined ? { sslMode: chTls.sslMode } : {}),
      ...(chTls.sslRejectUnauthorized !== undefined
        ? { sslRejectUnauthorized: chTls.sslRejectUnauthorized }
        : {}),
    },
    { user, password, placeholderPassword }
  )
}

function parseLibsqlUri(url: URL): ParsedConnectionUri {
  if (!url.hostname) {
    return { ok: false, error: 'Missing host in LibSQL connection URI.' }
  }

  const defaultSsl = url.protocol !== 'http:'
  const libTls = resolveTlsSettings(url.searchParams, defaultSsl)
  if (libTls.error) {
    return { ok: false, error: libTls.error }
  }
  const { ssl } = libTls
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
  const validated = validateLibsqlEndpointUrl(normalizedUrl, {
    hasAuthToken: Boolean(authToken),
  })
  if (!validated.ok) {
    return { ok: false, error: validated.error }
  }

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
export const SENSITIVE_URL_QUERY_PARAM_RE =
  /^(?:(?:.*[-_])?(?:token|pass(?:word|wd|phrase)?|pwd|secret|api[-_]?key|apikey|key|jwt|bearer|credentials?|auth[-_]?token|authtoken|authorization|sig(?:nature)?)|(?:auth|access|refresh|id|api|client|session|private|secret|signing|encryption)[_-]?(?:token|key|secret|pass(?:word|wd|phrase)?|pwd)|.*(?:pass(?:word|wd|phrase)|secret|token|apikey|privatekey))$/i

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
    if (isSensitiveUriParamKey(key)) {
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

export function validateLibsqlEndpointUrl(
  rawUrl: string,
  options?: { hasAuthToken?: boolean }
): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = rawUrl.trim()
  if (!trimmed) {
    return { ok: false, error: 'LibSQL endpoint URL cannot be empty.' }
  }
  if (D1_ENDPOINT_CONTROL_CHARS_RE.test(trimmed)) {
    return { ok: false, error: 'LibSQL endpoint URL must not contain control characters.' }
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: 'LibSQL endpoint URL is not a valid absolute URL.' }
  }
  if (
    parsed.protocol !== 'https:' &&
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'libsql:'
  ) {
    return {
      ok: false,
      error: `Unsupported LibSQL endpoint scheme "${parsed.protocol}" — only https, libsql, or loopback http is allowed.`,
    }
  }
  if (!parsed.hostname) {
    return { ok: false, error: 'LibSQL endpoint URL must include a valid host.' }
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error:
        'LibSQL endpoint URL must not contain embedded credentials; store the auth token in Secrets.',
    }
  }
  for (const key of parsed.searchParams.keys()) {
    if (isSensitiveUriParamKey(key)) {
      return {
        ok: false,
        error: `LibSQL endpoint URL must not include credential query parameter "${key}"; store the auth token in Secrets.`,
      }
    }
  }
  if (parsed.protocol === 'http:') {
    if (!isD1LoopbackHostname(parsed.hostname)) {
      return {
        ok: false,
        error:
          'LibSQL endpoint URL must use HTTPS (or libsql://); plain HTTP is only allowed for localhost, 127.0.0.0/8, or [::1].',
      }
    }
    if (options?.hasAuthToken) {
      return {
        ok: false,
        error:
          'LibSQL endpoint URL cannot send an auth token over plain HTTP; use HTTPS or remove the token for localhost/loopback emulators.',
      }
    }
  }
  return { ok: true, url: trimmed }
}

function scrubQueryOrHashPairs(segment: string): string {
  return segment
    .split('&')
    .filter((pair) => {
      const eqIdx = pair.indexOf('=')
      if (eqIdx <= 0) return true
      const rawKey = pair.slice(0, eqIdx).trim()
      return !isSensitiveUriParamKey(rawKey)
    })
    .join('&')
}

function scrubParsedStandardUrl(parsed: URL, authoritySeedList?: string): string {
  const clone = new URL(parsed.toString())
  clone.username = ''
  clone.password = ''
  if (clone.search.length > 1) {
    const cleanedSearch = scrubQueryOrHashPairs(clone.search.slice(1))
    clone.search = cleanedSearch ? `?${cleanedSearch}` : ''
  }
  if (clone.hash.length > 1) {
    const rawFrag = clone.hash.slice(1)
    const qIdx = rawFrag.indexOf('?')
    let cleanedFrag: string
    if (qIdx >= 0) {
      const prefix = scrubQueryOrHashPairs(rawFrag.slice(0, qIdx))
      const tail = scrubQueryOrHashPairs(rawFrag.slice(qIdx + 1))
      cleanedFrag = tail ? `${prefix}?${tail}` : prefix
    } else {
      cleanedFrag = scrubQueryOrHashPairs(rawFrag)
    }
    clone.hash = cleanedFrag ? `#${cleanedFrag}` : ''
  }
  return replaceAuthorityHostPreservingPath(clone.toString(), authoritySeedList)
}

export function scrubUrlCredentials(rawUrl: string): string | undefined {
  const trimmed = rawUrl.trim()
  if (!trimmed) return undefined
  const recovered = parseStandardUrl(trimmed)
  if (!recovered) return undefined
  return scrubParsedStandardUrl(recovered.url, recovered.authoritySeedList)
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
  const { url, placeholderPassword, authoritySeedList } = parsedUrl

  const sqlSpec = SQL_URI_SPECS[scheme]
  if (sqlSpec) {
    return parseSqlNetworkUri(url, sqlSpec, placeholderPassword, authoritySeedList)
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
    const lowerHost = url.hostname.toLowerCase()
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
