import type { DatabaseDriverType } from '../../protocol'
import {
  detectRedisCredentialCommand,
  findCredentialAuthorityAtIndex,
  scrubSensitiveText,
} from '../../shared-sql-safety.js'
import { isCloudDatabaseHost, splitCommaSeedAuthority } from './connection-uri'
import {
  isIdentContChar,
  isIdentStartChar,
  matchDollarQuoteTag,
  scanBlockCommentEnd,
  scanLineCommentEnd,
  scanQuotedSegmentEnd,
} from './sql-lexer'

export type SqlCredentialMatchKind = 'sql-auth-literal' | 'db-uri-credential'

interface SqlToken {
  kind: 'word' | 'string' | 'quoted_ident' | 'symbol'
  raw: string
  value: string
  upper: string
}

interface ScannedStatement {
  tokens: SqlToken[]
  unquotedNonCommentText: string
}

const DB_SPECIFIC_SCHEMES: ReadonlySet<string> = new Set([
  'postgres',
  'postgresql',
  'cockroachdb',
  'cockroach',
  'mysql',
  'mariadb',
  'redis',
  'rediss',
  'clickhouse',
  'clickhouses',
  'libsql',
  'd1',
  'd1+http',
  'd1+https',
  'mssql',
  'sqlserver',
  'oracle',
  'oracledb',
  'mongodb',
  'mongodb+srv',
])

const HTTP_SCHEMES: ReadonlySet<string> = new Set(['http', 'https'])
const WS_SCHEMES: ReadonlySet<string> = new Set(['ws', 'wss'])

const PLACEHOLDER_CREDENTIAL_RE =
  /^\[?(?:YOUR[-_]?DATABASE[-_]?PASSWORD|YOUR[-_]?PASSWORD|PASSWORD|<PASSWORD>|YOUR[-_]?TOKEN|<TOKEN>)\]?$/i

const BIND_PLACEHOLDER_RE = /^(?:\$\d+|\?|:[\w]+|@[\w]+|\{\{?[\w.-]+\}?\})$/

const URI_CANDIDATE_RE = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"`<>\\]+/g

const D1_API_PATH_RE = /\/client\/v4\/accounts\/[^/]+\/d1\/database\/[^/]+/i

function safeDecodeComponent(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function isNonEmptyRealCredential(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string') return false
  const decoded = safeDecodeComponent(raw).trim()
  if (decoded.length === 0) return false
  if (PLACEHOLDER_CREDENTIAL_RE.test(decoded)) return false
  if (BIND_PLACEHOLDER_RE.test(decoded)) return false
  return true
}

function unescapeSingleQuoted(raw: string, allowBackslash: boolean): string {
  let inner = raw.slice(1, -1)
  if (allowBackslash) {
    inner = inner.replace(/\\(.)/g, '$1')
  }
  return inner.replace(/''/g, "'")
}

function unescapeDoubleQuoted(raw: string): string {
  return raw.slice(1, -1).replace(/""/g, '"')
}

function matchMysqlExecutableCommentStart(
  sql: string,
  index: number,
  allowMysqlExec: boolean,
  allowMariadbExec: boolean
): number {
  if (!allowMysqlExec || sql[index] !== '/' || sql[index + 1] !== '*') return 0
  let cursor = -1
  if (sql[index + 2] === '!') {
    cursor = index + 3
  } else if (
    allowMariadbExec &&
    (sql[index + 2] === 'M' || sql[index + 2] === 'm') &&
    sql[index + 3] === '!'
  ) {
    cursor = index + 4
  } else {
    return 0
  }
  while (cursor < sql.length && sql[cursor] >= '0' && sql[cursor] <= '9') {
    cursor++
  }
  return cursor - index
}

function scanStatements(
  sql: string,
  dialect: DatabaseDriverType | undefined,
  modeOverride?: { hashComments: boolean; backslashInPlainStrings: boolean; nestedBlockComments: boolean }
): ScannedStatement[] {
  const statements: ScannedStatement[] = []
  let tokens: SqlToken[] = []
  const unquotedParts: string[] = []

  const flush = (): void => {
    if (tokens.length > 0 || unquotedParts.length > 0) {
      statements.push({
        tokens,
        unquotedNonCommentText: unquotedParts.join(''),
      })
      tokens = []
      unquotedParts.length = 0
    }
  }

  const len = sql.length
  const hashComments =
    modeOverride?.hashComments ??
    (dialect === 'mysql' || dialect === 'mariadb' || dialect === 'clickhouse')
  const backslashInPlainStrings =
    modeOverride?.backslashInPlainStrings ??
    (dialect === 'mysql' || dialect === 'mariadb' || dialect === 'clickhouse')
  const nestedBlockComments =
    modeOverride?.nestedBlockComments ??
    (dialect === undefined || dialect === 'postgres' || dialect === 'cockroachdb')
  const allowMysqlExec =
    dialect === undefined || dialect === 'mysql' || dialect === 'mariadb'
  const allowMariadbExec = dialect === undefined || dialect === 'mariadb'
  let execCommentDepth = 0

  let i = 0
  while (i < len) {
    const ch = sql[i]

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
      unquotedParts.push(' ')
      i++
      continue
    }

    if (ch === '-' && i + 1 < len && sql[i + 1] === '-') {
      i = scanLineCommentEnd(sql, i)
      unquotedParts.push(' ')
      continue
    }

    if (hashComments && ch === '#') {
      i = scanLineCommentEnd(sql, i - 1)
      unquotedParts.push(' ')
      continue
    }

    if (execCommentDepth > 0 && ch === '*' && i + 1 < len && sql[i + 1] === '/') {
      execCommentDepth--
      unquotedParts.push(' ')
      i += 2
      continue
    }

    if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
      const execLen = matchMysqlExecutableCommentStart(sql, i, allowMysqlExec, allowMariadbExec)
      if (execLen > 0) {
        execCommentDepth++
        unquotedParts.push(' ')
        i += execLen
        continue
      }
      i = scanBlockCommentEnd(sql, i, nestedBlockComments)
      unquotedParts.push(' ')
      continue
    }

    if (ch === ';') {
      flush()
      i++
      continue
    }

    // PostgreSQL E'...' / e'...' escape string literal (recognized even when dialect is omitted)
    if (
      (ch === 'E' || ch === 'e') &&
      i + 1 < len &&
      sql[i + 1] === "'" &&
      (i === 0 || !isIdentContChar(sql.charCodeAt(i - 1)))
    ) {
      const seg = scanQuotedSegmentEnd(sql, i + 1, "'", true)
      const raw = sql.slice(i, seg.end)
      const value = seg.closed ? unescapeSingleQuoted(sql.slice(i + 1, seg.end), true) : ''
      tokens.push({ kind: 'string', raw, value, upper: '' })
      unquotedParts.push(' ')
      i = seg.end
      continue
    }

    // Standard single-quoted string literal
    if (ch === "'") {
      const seg = scanQuotedSegmentEnd(sql, i, "'", backslashInPlainStrings)
      const raw = sql.slice(i, seg.end)
      const value = seg.closed ? unescapeSingleQuoted(raw, backslashInPlainStrings) : ''
      tokens.push({ kind: 'string', raw, value, upper: '' })
      unquotedParts.push(' ')
      i = seg.end
      continue
    }

    // PostgreSQL dollar-quoted string literal $$...$$ or $tag$...$tag$
    if (ch === '$') {
      const tag = matchDollarQuoteTag(sql, i)
      if (tag) {
        const closeIdx = sql.indexOf(tag, i + tag.length)
        const end = closeIdx === -1 ? len : closeIdx + tag.length
        const raw = sql.slice(i, end)
        const value = closeIdx === -1 ? '' : sql.slice(i + tag.length, closeIdx)
        tokens.push({ kind: 'string', raw, value, upper: '' })
        unquotedParts.push(' ')
        i = end
        continue
      }
      let cursor = i + 1
      while (cursor < len && sql.charCodeAt(cursor) >= 48 && sql.charCodeAt(cursor) <= 57) {
        cursor++
      }
      const raw = sql.slice(i, cursor)
      tokens.push({ kind: 'symbol', raw, value: raw, upper: raw })
      unquotedParts.push(raw)
      i = cursor
      continue
    }

    // Double-quoted identifier (or MySQL string literal in ANSI-off mode)
    if (ch === '"') {
      const seg = scanQuotedSegmentEnd(sql, i, '"', backslashInPlainStrings)
      const raw = sql.slice(i, seg.end)
      const value = seg.closed ? unescapeDoubleQuoted(raw) : ''
      tokens.push({ kind: 'quoted_ident', raw, value, upper: '' })
      unquotedParts.push(' ')
      i = seg.end
      continue
    }

    // Backtick-quoted identifier
    if (ch === '`') {
      const seg = scanQuotedSegmentEnd(sql, i, '`', false)
      const raw = sql.slice(i, seg.end)
      const value = seg.closed ? raw.slice(1, -1).replace(/``/g, '`') : ''
      tokens.push({ kind: 'quoted_ident', raw, value, upper: '' })
      unquotedParts.push(' ')
      i = seg.end
      continue
    }

    const code = sql.charCodeAt(i)
    if (isIdentStartChar(code)) {
      let cursor = i + 1
      while (cursor < len && isIdentContChar(sql.charCodeAt(cursor))) {
        cursor++
      }
      const raw = sql.slice(i, cursor)
      tokens.push({ kind: 'word', raw, value: raw, upper: raw.toUpperCase() })
      unquotedParts.push(raw)
      i = cursor
      continue
    }

    if ((ch === ':' || ch === '@') && i + 1 < len && isIdentStartChar(sql.charCodeAt(i + 1))) {
      let cursor = i + 2
      while (cursor < len && isIdentContChar(sql.charCodeAt(cursor))) {
        cursor++
      }
      const raw = sql.slice(i, cursor)
      tokens.push({ kind: 'symbol', raw, value: raw, upper: raw })
      unquotedParts.push(raw)
      i = cursor
      continue
    }

    tokens.push({ kind: 'symbol', raw: ch, value: ch, upper: ch })
    unquotedParts.push(ch)
    i++
  }

  flush()
  return statements
}

function isStringCredentialToken(token: SqlToken | undefined, allowDoubleQuoted: boolean): boolean {
  if (!token) return false
  if (token.kind === 'string') {
    return isNonEmptyRealCredential(token.value)
  }
  if (allowDoubleQuoted && token.kind === 'quoted_ident') {
    return isNonEmptyRealCredential(token.value)
  }
  return false
}

function hasAccountAuthLiteral(tokens: SqlToken[]): boolean {
  if (tokens.length < 3) return false
  const first = tokens[0]
  if (first.kind !== 'word') return false

  const isCreateOrAlter = first.upper === 'CREATE' || first.upper === 'ALTER'
  let accountTargetIdx = 1
  if (
    first.upper === 'CREATE' &&
    tokens[1]?.kind === 'word' &&
    tokens[1].upper === 'OR' &&
    tokens[2]?.kind === 'word' &&
    tokens[2].upper === 'REPLACE'
  ) {
    accountTargetIdx = 3
  }
  const isAccountTarget =
    isCreateOrAlter &&
    tokens[accountTargetIdx]?.kind === 'word' &&
    (tokens[accountTargetIdx].upper === 'USER' || tokens[accountTargetIdx].upper === 'ROLE')

  const isSetPassword =
    first.upper === 'SET' && tokens[1]?.kind === 'word' && tokens[1].upper === 'PASSWORD'

  const isGrant = first.upper === 'GRANT'

  if (!isAccountTarget && !isSetPassword && !isGrant) {
    return false
  }

  // MySQL: SET PASSWORD [FOR user] = '<literal>' | PASSWORD('<literal>')
  if (isSetPassword) {
    for (let i = 2; i < tokens.length - 1; i++) {
      if (tokens[i].kind === 'symbol' && tokens[i].raw === '=') {
        if (isStringCredentialToken(tokens[i + 1], true)) {
          return true
        }
        if (
          tokens[i + 1]?.kind === 'word' &&
          tokens[i + 1].upper === 'PASSWORD' &&
          tokens[i + 2]?.kind === 'symbol' &&
          tokens[i + 2].raw === '(' &&
          isStringCredentialToken(tokens[i + 3], true)
        ) {
          return true
        }
      }
    }
    return false
  }

  for (let i = accountTargetIdx + 1; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.kind !== 'word') continue

    // PostgreSQL / CockroachDB: CREATE/ALTER USER|ROLE ... [ENCRYPTED|UNENCRYPTED] PASSWORD '<literal>'
    if (isAccountTarget && tok.upper === 'PASSWORD') {
      const next = tokens[i + 1]
      if (next && next.kind === 'word' && next.upper === 'NULL') {
        continue
      }
      if (isStringCredentialToken(next, false)) {
        return true
      }
    }

    // MySQL / MariaDB / ClickHouse: IDENTIFIED [WITH <plugin>] BY '<literal>'
    if (tok.upper === 'IDENTIFIED') {
      let cursor = i + 1
      if (tokens[cursor]?.kind === 'word' && tokens[cursor].upper === 'WITH') {
        cursor += 2
      }
      if (tokens[cursor]?.kind === 'word' && tokens[cursor].upper === 'BY') {
        const secretTok = tokens[cursor + 1]
        if (
          secretTok &&
          secretTok.kind === 'word' &&
          (secretTok.upper === 'RANDOM' || secretTok.upper === 'PASSWORD')
        ) {
          continue
        }
        if (isStringCredentialToken(secretTok, true)) {
          return true
        }
      }
    }
  }

  return false
}

function tryParseUrlSafely(rawUri: string): URL | null {
  let direct: URL | null = null
  try {
    direct = new URL(rawUri)
  } catch {
    direct = null
  }
  if (
    direct &&
    direct.password.length > 0 &&
    !(direct.hash.includes('@') && !/^#[^#@=]*=/.test(direct.hash))
  ) {
    return direct
  }

  const schemeEnd = rawUri.indexOf('://')
  if (schemeEnd > 0) {
    const schemePrefix = rawUri.slice(0, schemeEnd + 3)
    const body = rawUri.slice(schemeEnd + 3)
    const colonIdx = body.search(/[:/?#@[\]]/)
    if (colonIdx >= 0 && body[colonIdx] === ':') {
      const atIdx = findCredentialAuthorityAtIndex(schemePrefix, body, colonIdx)
      if (atIdx > colonIdx) {
        const user = body.slice(0, colonIdx)
        const rawPass = body.slice(colonIdx + 1, atIdx)
        const { primaryHostAndRest } = splitCommaSeedAuthority(body.slice(atIdx + 1))
        try {
          const encodedPass = encodeURIComponent(safeDecodeComponent(rawPass))
          return new URL(`${schemePrefix}${user}:${encodedPass}@${primaryHostAndRest}`)
        } catch {
          // Fall through to direct URL if any
        }
      }
    }
  }

  return direct
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  return (
    lower === 'localhost' ||
    lower === '::1' ||
    lower === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)
  )
}

function inspectCandidateUri(rawUri: string, dialect?: DatabaseDriverType): boolean {
  const cleaned = rawUri.replace(/[),;]+$/, '')
  const schemeEnd = cleaned.indexOf('://')
  const scheme = cleaned.slice(0, schemeEnd).toLowerCase()

  const isExplicitDbScheme = DB_SPECIFIC_SCHEMES.has(scheme)
  const isHttpScheme = HTTP_SCHEMES.has(scheme)
  const isWsScheme = WS_SCHEMES.has(scheme)
  if (!isExplicitDbScheme && !isHttpScheme && !isWsScheme) {
    return false
  }

  const parsed = tryParseUrlSafely(cleaned)
  if (!parsed || !parsed.hostname) return false

  const hostname = parsed.hostname.toLowerCase()
  const port = parsed.port ? Number(parsed.port) : undefined
  const params = parsed.searchParams

  // 1. Explicit database schemes (always database URIs regardless of dialect)
  if (isExplicitDbScheme) {
    if (isNonEmptyRealCredential(parsed.password)) {
      return true
    }
    if (
      scheme === 'redis' ||
      scheme === 'rediss' ||
      scheme === 'clickhouse' ||
      scheme === 'clickhouses'
    ) {
      if (isNonEmptyRealCredential(params.get('password'))) return true
    }
    if (scheme === 'libsql') {
      if (
        isNonEmptyRealCredential(params.get('authToken')) ||
        isNonEmptyRealCredential(params.get('auth_token')) ||
        isNonEmptyRealCredential(params.get('jwt')) ||
        isNonEmptyRealCredential(params.get('token'))
      ) {
        return true
      }
    }
    if (scheme === 'd1' || scheme === 'd1+http' || scheme === 'd1+https') {
      if (
        isNonEmptyRealCredential(params.get('authToken')) ||
        isNonEmptyRealCredential(params.get('auth_token')) ||
        isNonEmptyRealCredential(params.get('token')) ||
        isNonEmptyRealCredential(params.get('apiToken')) ||
        isNonEmptyRealCredential(params.get('api_token'))
      ) {
        return true
      }
    }
    return false
  }

  // 2. WebSocket schemes: only recognized LibSQL/Turso endpoints
  if (isWsScheme) {
    const isLibsqlWs =
      hostname.endsWith('.turso.io') ||
      (dialect === 'libsql' &&
        (isLoopbackHost(hostname) || port === 8080 || port === 8081 || parsed.pathname.startsWith('/v2/')))
    if (!isLibsqlWs) return false
    return (
      isNonEmptyRealCredential(parsed.password) ||
      isNonEmptyRealCredential(params.get('authToken')) ||
      isNonEmptyRealCredential(params.get('auth_token')) ||
      isNonEmptyRealCredential(params.get('jwt'))
    )
  }

  // 3. HTTP/HTTPS schemes: ONLY clearly identified DB HTTP endpoints (never ordinary web URLs)
  const isD1ApiEndpoint =
    D1_API_PATH_RE.test(parsed.pathname) ||
    (dialect === 'd1' && isLoopbackHost(hostname) && /\/(?:d1|query)\b/i.test(parsed.pathname))
  if (isD1ApiEndpoint) {
    return (
      isNonEmptyRealCredential(parsed.password) ||
      isNonEmptyRealCredential(params.get('authToken')) ||
      isNonEmptyRealCredential(params.get('auth_token')) ||
      isNonEmptyRealCredential(params.get('token')) ||
      isNonEmptyRealCredential(params.get('apiToken')) ||
      isNonEmptyRealCredential(params.get('api_token'))
    )
  }

  const isLibsqlHttpEndpoint =
    hostname.endsWith('.turso.io') ||
    (dialect === 'libsql' &&
      (isLoopbackHost(hostname) ||
        port === 8080 ||
        port === 8081 ||
        parsed.pathname.startsWith('/v2/pipeline')))
  if (isLibsqlHttpEndpoint) {
    return (
      isNonEmptyRealCredential(parsed.password) ||
      isNonEmptyRealCredential(params.get('authToken')) ||
      isNonEmptyRealCredential(params.get('auth_token')) ||
      isNonEmptyRealCredential(params.get('jwt'))
    )
  }

  const isClickHouseHttpEndpoint =
    hostname.endsWith('.clickhouse.cloud') ||
    ((port === 8123 || port === 8443) &&
      (parsed.password.length > 0 || params.has('password') || params.has('user'))) ||
    (dialect === 'clickhouse' &&
      (isLoopbackHost(hostname) ||
        isCloudDatabaseHost(hostname) ||
        port === 8123 ||
        port === 8443 ||
        (params.has('password') && (params.has('user') || params.has('database')))))
  if (isClickHouseHttpEndpoint) {
    return (
      isNonEmptyRealCredential(parsed.password) ||
      isNonEmptyRealCredential(params.get('password'))
    )
  }

  if (isCloudDatabaseHost(hostname) && isNonEmptyRealCredential(parsed.password)) {
    return true
  }

  return false
}

function containsDbCredentialUriInText(text: string, dialect?: DatabaseDriverType): boolean {
  if (!text.includes('://')) return false
  URI_CANDIDATE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = URI_CANDIDATE_RE.exec(text)) !== null) {
    if (inspectCandidateUri(match[0], dialect)) {
      return true
    }
  }
  return false
}

function evaluateScannedStatements(
  statements: ScannedStatement[],
  dialect?: DatabaseDriverType
): SqlCredentialMatchKind | null {
  for (const stmt of statements) {
    if (hasAccountAuthLiteral(stmt.tokens)) {
      return 'sql-auth-literal'
    }
    for (const tok of stmt.tokens) {
      if (tok.kind === 'string' && containsDbCredentialUriInText(tok.value, dialect)) {
        return 'db-uri-credential'
      }
    }
    if (containsDbCredentialUriInText(stmt.unquotedNonCommentText, dialect)) {
      return 'db-uri-credential'
    }
  }
  return null
}

/**
 * Total, non-throwing classifier for SQL text containing recognizable database
 * credentials (account-management literal passwords or supported DB URIs with
 * non-empty credentials). Ignores SQL comments, quoted identifiers, bind
 * placeholders, and ordinary web URLs.
 */
export function detectRecognizableSqlCredential(
  sql: string,
  dialect?: DatabaseDriverType
): SqlCredentialMatchKind | null {
  if (typeof sql !== 'string' || sql.trim().length === 0) return null
  if ((dialect === 'redis' || dialect === undefined) && detectRedisCredentialCommand(sql)) {
    return 'sql-auth-literal'
  }
  if (dialect !== undefined) {
    return evaluateScannedStatements(scanStatements(sql, dialect), dialect)
  }
  // When dialect is omitted, scan under both PG/ANSI and MySQL lexical rules
  const pgMatch = evaluateScannedStatements(
    scanStatements(sql, undefined, {
      hashComments: false,
      backslashInPlainStrings: false,
      nestedBlockComments: true,
    }),
    undefined
  )
  if (pgMatch !== null) return pgMatch
  return evaluateScannedStatements(
    scanStatements(sql, undefined, {
      hashComments: true,
      backslashInPlainStrings: true,
      nestedBlockComments: false,
    }),
    undefined
  )
}

/**
 * Redacts embedded URI passwords, genuine sensitive query/fragment parameters (while
 * preserving non-secret auth config keys like `authSource`/`authMechanism`/`authType`),
 * Bearer/Basic tokens, and ADO.NET password attributes (including `{...}` / JSON-escaped values).
 */
export function scrubDriverErrorText(input: string): string {
  return scrubSensitiveText(input, { stripAllFragments: true })
}
