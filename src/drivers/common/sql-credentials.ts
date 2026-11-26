import type { DatabaseDriverType } from '../../protocol'
import {
  detectRedisCredentialCommand,
  findCredentialAuthorityAtIndex,
  isSensitiveUriParamKey,
  scrubSensitiveText,
} from '../../shared-sql-safety.js'
import {
  getDialectLexerRules,
  scanBracketIdentEnd,
  scanOracleQuoteEnd,
} from '../../shared-sql-core.js'
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

function unescapeSingleQuoted(raw: string, allowBackslash: boolean, closed = true): string {
  let inner = closed ? raw.slice(1, -1) : raw.slice(1)
  if (allowBackslash) {
    inner = inner.replace(/\\(.)/g, '$1')
  }
  return inner.replace(/''/g, "'")
}

function unescapeDoubleQuoted(raw: string, allowBackslash = false, closed = true): string {
  let inner = closed ? raw.slice(1, -1) : raw.slice(1)
  if (allowBackslash) {
    inner = inner.replace(/\\(.)/g, '$1')
  }
  return inner.replace(/""/g, '"')
}

function extractOracleQuotedValue(raw: string, closed: boolean): string {
  const quotePos = raw.indexOf("'")
  if (quotePos < 0 || quotePos + 2 > raw.length) return ''
  const innerStart = quotePos + 2
  const innerEnd = closed ? Math.max(innerStart, raw.length - 2) : raw.length
  return raw.slice(innerStart, innerEnd)
}

function isStandaloneGoBatchSeparator(sql: string, start: number, end: number): number {
  let left = start - 1
  while (left >= 0 && (sql[left] === ' ' || sql[left] === '\t')) left--
  if (left >= 0 && sql[left] !== '\n' && sql[left] !== '\r') return -1

  let right = end
  while (right < sql.length && (sql[right] === ' ' || sql[right] === '\t')) right++
  // Optional positive integer batch count: GO 5
  let afterCount = right
  if (afterCount < sql.length && sql[afterCount] >= '0' && sql[afterCount] <= '9') {
    while (afterCount < sql.length && sql[afterCount] >= '0' && sql[afterCount] <= '9') {
      afterCount++
    }
    right = afterCount
    while (right < sql.length && (sql[right] === ' ' || sql[right] === '\t')) right++
  }
  if (right >= sql.length || sql[right] === '\n' || sql[right] === '\r') {
    return right
  }
  if (sql[right] === '-' && right + 1 < sql.length && sql[right + 1] === '-') {
    return scanLineCommentEnd(sql, right)
  }
  return -1
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
  const rules = getDialectLexerRules(dialect)
  const hashComments = modeOverride?.hashComments ?? rules.lineCommentHash
  const slashComments = dialect !== undefined ? rules.lineCommentSlash : false
  const backslashInPlainStrings =
    modeOverride?.backslashInPlainStrings ?? rules.backslashEscapesSingleQuote
  const backslashInDoubleQuotes =
    modeOverride?.backslashInPlainStrings ?? rules.backslashEscapesDoubleQuote
  const nestedBlockComments =
    modeOverride?.nestedBlockComments ??
    (dialect === undefined ? true : rules.nestedBlockComments)
  const allowMysqlExec =
    dialect === undefined || rules.mysqlExecComments
  const allowMariadbExec = dialect === undefined || dialect === 'mariadb'
  const allowMssqlGo = dialect === undefined || dialect === 'mssql'
  const bracketMode =
    dialect === undefined ? 'doubling' : rules.bracketIdentifiers
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

    if (slashComments && ch === '/' && i + 1 < len && sql[i + 1] === '/') {
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

    // Oracle q'[...]' / nq'[...]' string literals (fail-closed on unclosed literals)
    if (dialect === 'oracle' || dialect === undefined) {
      const oracleSeg = scanOracleQuoteEnd(sql, i, 'oracle')
      if (oracleSeg) {
        const raw = sql.slice(i, oracleSeg.end)
        const value = extractOracleQuotedValue(raw, oracleSeg.closed)
        tokens.push({ kind: 'string', raw, value, upper: '' })
        unquotedParts.push(' ')
        i = oracleSeg.end
        continue
      }
    }

    // PostgreSQL E'...' / e'...' escape string literal (recognized even when dialect is omitted; fail-closed if unclosed)
    if (
      (ch === 'E' || ch === 'e') &&
      i + 1 < len &&
      sql[i + 1] === "'" &&
      (i === 0 || !isIdentContChar(sql.charCodeAt(i - 1)))
    ) {
      const seg = scanQuotedSegmentEnd(sql, i + 1, "'", true)
      const raw = sql.slice(i, seg.end)
      const value = unescapeSingleQuoted(sql.slice(i + 1, seg.end), true, seg.closed)
      tokens.push({ kind: 'string', raw, value, upper: '' })
      unquotedParts.push(' ')
      i = seg.end
      continue
    }

    // Standard single-quoted string literal (fail-closed when unclosed during live editing)
    if (ch === "'") {
      const seg = scanQuotedSegmentEnd(sql, i, "'", backslashInPlainStrings)
      const raw = sql.slice(i, seg.end)
      const value = unescapeSingleQuoted(raw, backslashInPlainStrings, seg.closed)
      tokens.push({ kind: 'string', raw, value, upper: '' })
      unquotedParts.push(' ')
      i = seg.end
      continue
    }

    // PostgreSQL dollar-quoted string literal $$...$$ or $tag$...$tag$ (fail-closed when unclosed)
    if (ch === '$') {
      const tag = matchDollarQuoteTag(sql, i)
      if (tag) {
        const closeIdx = sql.indexOf(tag, i + tag.length)
        const end = closeIdx === -1 ? len : closeIdx + tag.length
        const raw = sql.slice(i, end)
        const value = closeIdx === -1 ? sql.slice(i + tag.length) : sql.slice(i + tag.length, closeIdx)
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

    // Double-quoted identifier (or MySQL string literal in ANSI-off mode; fail-closed if unclosed)
    if (ch === '"') {
      const seg = scanQuotedSegmentEnd(sql, i, '"', backslashInDoubleQuotes)
      const raw = sql.slice(i, seg.end)
      const value = unescapeDoubleQuoted(raw, backslashInDoubleQuotes, seg.closed)
      tokens.push({ kind: 'quoted_ident', raw, value, upper: '' })
      unquotedParts.push(' ')
      i = seg.end
      continue
    }

    // Backtick-quoted identifier
    if (ch === '`') {
      const seg = scanQuotedSegmentEnd(sql, i, '`', false)
      const raw = sql.slice(i, seg.end)
      const value = seg.closed ? raw.slice(1, -1).replace(/``/g, '`') : raw.slice(1).replace(/``/g, '`')
      tokens.push({ kind: 'quoted_ident', raw, value, upper: '' })
      unquotedParts.push(' ')
      i = seg.end
      continue
    }

    // Bracket-quoted identifier ([...]) on MSSQL/SQLite-family
    if (ch === '[' && bracketMode !== 'none') {
      const seg = scanBracketIdentEnd(sql, i, bracketMode === 'doubling')
      const raw = sql.slice(i, seg.end)
      const inner = seg.closed ? raw.slice(1, -1) : raw.slice(1)
      const value = bracketMode === 'doubling' ? inner.replace(/\]\]/g, ']') : inner
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
      const upper = raw.toUpperCase()
      if (allowMssqlGo && upper === 'GO') {
        const goEnd = isStandaloneGoBatchSeparator(sql, i, cursor)
        if (goEnd >= 0) {
          flush()
          i = goEnd
          continue
        }
      }
      tokens.push({ kind: 'word', raw, value: raw, upper })
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

const ORACLE_IDENTIFIED_BY_NON_SECRET_WORDS: ReadonlySet<string> = new Set([
  'RANDOM',
  'PASSWORD',
  'NULL',
  'EXTERNALLY',
  'GLOBALLY',
  'VALUES',
])

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

const PREFIXED_SECRET_ASSIGN_IDENT_RE =
  /^[A-Za-z][A-Za-z0-9_]*_(?:PASSWORD|PASSWD|PWD|PASSPHRASE|API_?KEY|APIKEY|SECRET|TOKEN)$/i

const LIBPQ_CONNINFO_SECRET_RE =
  /(?:^|[\s;])(?:password|passfile|sslpassword)\s*=\s*(?:'([^']+)'|"([^"]+)"|([^\s;'"]+))/gi

const JSON_SECRET_KV_RE =
  /"((?:[A-Za-z0-9_.-]*_)?(?:password|passwd|pwd|passphrase|secret|token|api_?key|apikey|private_?key|authorization|credential))"\s*:\s*"((?:\\.|[^"])*)"/gi

const PREFIXED_INLINE_SECRET_KV_RE =
  /(?:^|[\s,;({\[])([A-Za-z][A-Za-z0-9_]*_(?:PASSWORD|PASSWD|PWD|PASSPHRASE|API_?KEY|APIKEY|SECRET|TOKEN))\s*=\s*(?:'([^']+)'|"([^"]+)"|([^\s,;'"<>}\])]+))/gi

const ORACLE_EASY_CONNECT_RE =
  /(?:^|[\s'"(=,])([A-Za-z_][A-Za-z0-9_$#]*)\/([^/\s'",;()]+)(@(?:\[?[A-Za-z0-9.-]+\]?)(?::\d{1,5})\/[A-Za-z0-9_.$#-]+)/g

function containsConninfoPassword(text: string): boolean {
  LIBPQ_CONNINFO_SECRET_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = LIBPQ_CONNINFO_SECRET_RE.exec(text)) !== null) {
    const val = match[1] ?? match[2] ?? match[3] ?? ''
    if (isNonEmptyRealCredential(val)) return true
  }
  return false
}

function containsOracleEasyConnectInText(text: string): boolean {
  if (!text.includes('/') || !text.includes('@')) return false
  ORACLE_EASY_CONNECT_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ORACLE_EASY_CONNECT_RE.exec(text)) !== null) {
    const pass = match[2]
    if (pass === '[REDACTED]' || pass === '***') continue
    if (isNonEmptyRealCredential(pass)) return true
  }
  return false
}

function containsJsonOrPrefixedSecretInText(text: string): boolean {
  if (text.includes('"') && text.includes(':')) {
    JSON_SECRET_KV_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = JSON_SECRET_KV_RE.exec(text)) !== null) {
      const val = m[2]
      if (val === '[REDACTED]' || val === '***') continue
      if (isNonEmptyRealCredential(val)) return true
    }
  }
  if (text.includes('=')) {
    PREFIXED_INLINE_SECRET_KV_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = PREFIXED_INLINE_SECRET_KV_RE.exec(text)) !== null) {
      const val = m[2] ?? m[3] ?? m[4] ?? ''
      if (val === '[REDACTED]' || val === '***') continue
      if (isNonEmptyRealCredential(val)) return true
    }
  }
  return false
}

function isHexHashedPasswordToken(token: SqlToken | undefined): boolean {
  return Boolean(token && token.kind === 'word' && /^0x[0-9a-fA-F]{4,}$/.test(token.raw))
}

function hasAccountAuthLiteralFrom(tokens: SqlToken[], startIdx: number): boolean {
  if (tokens.length - startIdx < 3) return false
  const first = tokens[startIdx]
  if (first.kind !== 'word') return false

  const isCreateOrAlter = first.upper === 'CREATE' || first.upper === 'ALTER'
  let targetIdx = startIdx + 1
  if (
    first.upper === 'CREATE' &&
    tokens[targetIdx]?.kind === 'word' &&
    tokens[targetIdx].upper === 'OR' &&
    tokens[targetIdx + 1]?.kind === 'word' &&
    tokens[targetIdx + 1].upper === 'REPLACE'
  ) {
    targetIdx += 2
  }
  // Skip optional SHARED / PUBLIC / DATABASE / SCOPED qualifiers for DB LINK & CREDENTIAL
  let qualifierCursor = targetIdx
  while (
    tokens[qualifierCursor]?.kind === 'word' &&
    (tokens[qualifierCursor].upper === 'SHARED' ||
      tokens[qualifierCursor].upper === 'PUBLIC' ||
      tokens[qualifierCursor].upper === 'DATABASE' ||
      tokens[qualifierCursor].upper === 'SCOPED' ||
      tokens[qualifierCursor].upper === 'FOREIGN' ||
      tokens[qualifierCursor].upper === 'DATA')
  ) {
    qualifierCursor++
  }

  const targetWord = tokens[targetIdx]?.kind === 'word' ? tokens[targetIdx].upper : ''
  const qualWord = tokens[qualifierCursor]?.kind === 'word' ? tokens[qualifierCursor].upper : ''

  const isAccountTarget =
    isCreateOrAlter &&
    (targetWord === 'USER' || targetWord === 'ROLE' || targetWord === 'LOGIN')

  const isDatabaseLink =
    isCreateOrAlter &&
    qualWord === 'LINK' &&
    tokens[qualifierCursor - 1]?.upper === 'DATABASE'

  const isCredentialTarget = isCreateOrAlter && qualWord === 'CREDENTIAL'

  const isKeyOrCertTarget =
    (isCreateOrAlter || first.upper === 'OPEN' || first.upper === 'BACKUP' || first.upper === 'RESTORE') &&
    ((targetWord === 'MASTER' || targetWord === 'SYMMETRIC' || targetWord === 'ASYMMETRIC') &&
      tokens[targetIdx + 1]?.kind === 'word' &&
      tokens[targetIdx + 1].upper === 'KEY' ||
      targetWord === 'CERTIFICATE')

  const isSubscriptionOrFdw =
    isCreateOrAlter &&
    (targetWord === 'SUBSCRIPTION' ||
      targetWord === 'SERVER' ||
      (targetWord === 'USER' && tokens[targetIdx + 1]?.upper === 'MAPPING'))

  const isChangeReplication =
    first.upper === 'CHANGE' &&
    (targetWord === 'MASTER' ||
      (targetWord === 'REPLICATION' && tokens[targetIdx + 1]?.upper === 'SOURCE'))

  const isSetPassword =
    first.upper === 'SET' && tokens[startIdx + 1]?.kind === 'word' && tokens[startIdx + 1].upper === 'PASSWORD'

  const isSetPrefixedSecret =
    first.upper === 'SET' &&
    tokens[startIdx + 1]?.kind === 'word' &&
    PREFIXED_SECRET_ASSIGN_IDENT_RE.test(tokens[startIdx + 1].raw)

  const isGrant = first.upper === 'GRANT'

  if (isSetPrefixedSecret) {
    const eqTok = tokens[startIdx + 2]
    const valTok =
      eqTok?.kind === 'symbol' && (eqTok.raw === '=' || eqTok.raw === ':')
        ? tokens[startIdx + 3]
        : eqTok?.kind === 'word' && eqTok.upper === 'TO'
          ? tokens[startIdx + 3]
          : undefined
    if (isStringCredentialToken(valTok, true)) {
      return true
    }
    return false
  }

  if (
    !isAccountTarget &&
    !isDatabaseLink &&
    !isCredentialTarget &&
    !isKeyOrCertTarget &&
    !isSubscriptionOrFdw &&
    !isChangeReplication &&
    !isSetPassword &&
    !isGrant
  ) {
    return false
  }

  // MySQL: SET PASSWORD [FOR user] = '<literal>' | PASSWORD('<literal>')
  if (isSetPassword) {
    for (let i = startIdx + 2; i < tokens.length - 1; i++) {
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

  for (let i = targetIdx + 1; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.kind !== 'word') continue

    // PostgreSQL / CockroachDB / MSSQL:
    // CREATE/ALTER USER|ROLE|LOGIN|MASTER KEY|CERTIFICATE ... PASSWORD [=] [N]'<literal>' | 0x...
    if (
      (isAccountTarget || isKeyOrCertTarget || isSubscriptionOrFdw) &&
      (tok.upper === 'PASSWORD' || tok.upper === 'OLD_PASSWORD')
    ) {
      let valIdx = i + 1
      if (tokens[valIdx]?.kind === 'symbol' && tokens[valIdx].raw === '=') {
        valIdx += 1
      }
      if (
        tokens[valIdx]?.kind === 'word' &&
        tokens[valIdx].upper === 'N' &&
        tokens[valIdx + 1]?.kind === 'string'
      ) {
        valIdx += 1
      }
      const next = tokens[valIdx]
      if (next && next.kind === 'word' && next.upper === 'NULL') {
        continue
      }
      if (isStringCredentialToken(next, false) || isHexHashedPasswordToken(next)) {
        return true
      }
    }

    // MSSQL: CREATE/ALTER [DATABASE SCOPED] CREDENTIAL ... SECRET [=] [N]'<literal>'
    if (isCredentialTarget && tok.upper === 'SECRET') {
      let valIdx = i + 1
      if (tokens[valIdx]?.kind === 'symbol' && tokens[valIdx].raw === '=') {
        valIdx += 1
      }
      if (
        tokens[valIdx]?.kind === 'word' &&
        tokens[valIdx].upper === 'N' &&
        tokens[valIdx + 1]?.kind === 'string'
      ) {
        valIdx += 1
      }
      if (isStringCredentialToken(tokens[valIdx], false)) {
        return true
      }
    }

    // PostgreSQL: CREATE/ALTER SUBSCRIPTION ... CONNECTION '<conninfo>'
    if (isSubscriptionOrFdw && tok.upper === 'CONNECTION') {
      const connTok = tokens[i + 1]
      if (connTok?.kind === 'string' && containsConninfoPassword(connTok.value)) {
        return true
      }
    }

    // MySQL: CHANGE REPLICATION SOURCE|MASTER TO ... SOURCE_PASSWORD|MASTER_PASSWORD = '<literal>'
    if (
      isChangeReplication &&
      (tok.upper === 'SOURCE_PASSWORD' || tok.upper === 'MASTER_PASSWORD')
    ) {
      let valIdx = i + 1
      if (tokens[valIdx]?.kind === 'symbol' && tokens[valIdx].raw === '=') {
        valIdx += 1
      }
      if (isStringCredentialToken(tokens[valIdx], true)) {
        return true
      }
    }

    // MySQL / MariaDB / ClickHouse / Oracle (including DATABASE LINK):
    // IDENTIFIED [WITH|VIA <plugin>] (BY|AS|USING) '<literal>' | "<literal>" | <unquoted_oracle_pw>
    if (tok.upper === 'IDENTIFIED') {
      let cursor = i + 1
      if (
        tokens[cursor]?.kind === 'word' &&
        (tokens[cursor].upper === 'WITH' || tokens[cursor].upper === 'VIA')
      ) {
        cursor += 2
      }
      if (
        tokens[cursor]?.kind === 'word' &&
        (tokens[cursor].upper === 'BY' ||
          tokens[cursor].upper === 'AS' ||
          tokens[cursor].upper === 'USING')
      ) {
        let valIdx = cursor + 1
        if (
          tokens[valIdx]?.kind === 'word' &&
          tokens[valIdx].upper === 'N' &&
          tokens[valIdx + 1]?.kind === 'string'
        ) {
          valIdx += 1
        }
        const secretTok = tokens[valIdx]
        if (
          secretTok &&
          secretTok.kind === 'word' &&
          ORACLE_IDENTIFIED_BY_NON_SECRET_WORDS.has(secretTok.upper)
        ) {
          continue
        }
        if (isStringCredentialToken(secretTok, true)) {
          return true
        }
        if (secretTok && secretTok.kind === 'word' && isNonEmptyRealCredential(secretTok.value)) {
          return true
        }
      }
    }
  }

  return false
}

const SUB_STMT_AUTH_STARTERS: ReadonlySet<string> = new Set([
  'CREATE',
  'ALTER',
  'SET',
  'GRANT',
  'CHANGE',
  'OPEN',
  'BACKUP',
  'RESTORE',
])

function hasDblinkPasswordCall(tokens: SqlToken[]): boolean {
  for (let i = 0; i < tokens.length - 2; i++) {
    const tok = tokens[i]
    if (
      tok.kind === 'word' &&
      /^DBLINK(?:_[A-Z0-9_]+)?$/.test(tok.upper) &&
      tokens[i + 1]?.kind === 'symbol' &&
      tokens[i + 1].raw === '('
    ) {
      let depth = 1
      for (let j = i + 2; j < tokens.length && depth > 0; j++) {
        const arg = tokens[j]
        if (arg.kind === 'symbol' && arg.raw === '(') depth++
        else if (arg.kind === 'symbol' && arg.raw === ')') depth--
        else if (arg.kind === 'string' && containsConninfoPassword(arg.value)) {
          return true
        }
      }
    }
  }
  return false
}

function hasAccountAuthLiteral(tokens: SqlToken[]): boolean {
  if (tokens.length < 3) return false
  if (hasDblinkPasswordCall(tokens)) return true
  for (let i = 0; i < tokens.length - 2; i++) {
    const tok = tokens[i]
    if (tok.kind !== 'word' || !SUB_STMT_AUTH_STARTERS.has(tok.upper)) continue
    const prev = i > 0 ? tokens[i - 1] : undefined
    if (prev?.kind === 'symbol' && prev.raw === '.') continue
    if (hasAccountAuthLiteralFrom(tokens, i)) {
      return true
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
    for (const [paramKey, paramVal] of params.entries()) {
      if (isSensitiveUriParamKey(paramKey) && isNonEmptyRealCredential(paramVal)) {
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
  const allowDoubleQuotedLiterals =
    dialect === undefined ||
    dialect === 'mysql' ||
    dialect === 'mariadb' ||
    dialect === 'clickhouse'

  for (const stmt of statements) {
    if (hasAccountAuthLiteral(stmt.tokens)) {
      return 'sql-auth-literal'
    }
    for (const tok of stmt.tokens) {
      const isLiteralCarrier =
        tok.kind === 'string' ||
        (allowDoubleQuotedLiterals && tok.kind === 'quoted_ident' && tok.raw.startsWith('"'))
      if (!isLiteralCarrier) continue
      if (containsDbCredentialUriInText(tok.value, dialect)) {
        return 'db-uri-credential'
      }
      if (containsOracleEasyConnectInText(tok.value)) {
        return 'db-uri-credential'
      }
      if (containsJsonOrPrefixedSecretInText(tok.value)) {
        return 'sql-auth-literal'
      }
    }
    if (containsDbCredentialUriInText(stmt.unquotedNonCommentText, dialect)) {
      return 'db-uri-credential'
    }
    if (containsOracleEasyConnectInText(stmt.unquotedNonCommentText)) {
      return 'db-uri-credential'
    }
  }
  return null
}

const NON_REDIS_SQL_LEADING_RE =
  /^\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*(?:WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|UPSERT|REPLACE|EXPLAIN|PRAGMA|SHOW|DESCRIBE|BEGIN|COMMIT|ROLLBACK|VALUES|TABLE)\b/i

const SQL_SELECT_LEADING_RE =
  /^\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*SELECT\b(?![ \t]+\d+[ \t]*(?:\r?\n|$))/i

function shouldCheckRedisCredentialHeuristic(
  sql: string,
  dialect: DatabaseDriverType | undefined
): boolean {
  if (dialect === 'redis') return true
  if (dialect !== undefined) return false
  // When dialect is omitted, skip Redis line-based AUTH heuristic on clearly SQL statements
  // (while preserving Redis `SELECT 0\nAUTH <pw>`).
  if (NON_REDIS_SQL_LEADING_RE.test(sql) || SQL_SELECT_LEADING_RE.test(sql)) {
    return false
  }
  return true
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
  if (shouldCheckRedisCredentialHeuristic(sql, dialect) && detectRedisCredentialCommand(sql)) {
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

const SCRUB_PREFIXED_KV_RE =
  /(^|[\s,;({\[])((?:[A-Za-z0-9_.-]+_)(?:password|passwd|pwd|passphrase|secret|token|api_?key|apikey|private_?key))(\s*=\s*)(\[REDACTED\]|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;'"<>}\])]+)/gi

/**
 * Redacts embedded URI passwords, genuine sensitive query/fragment parameters (while
 * preserving non-secret auth config keys like `authSource`/`authMechanism`/`authType`),
 * Bearer/Basic tokens, ADO.NET password attributes, JSON secret fields, Oracle Easy Connect
 * credentials, and prefixed `*_PASSWORD`/`*_API_KEY`/`*_SECRET`/`*_TOKEN` assignments.
 */
export function scrubDriverErrorText(input: string): string {
  let out = scrubSensitiveText(input, { stripAllFragments: true })
  if (!out) return out

  out = out.replace(JSON_SECRET_KV_RE, (full, key: string, val: string) =>
    val === '[REDACTED]' ? full : `"${key}": "[REDACTED]"`
  )
  out = out.replace(
    ORACLE_EASY_CONNECT_RE,
    (full, user: string, pass: string, rest: string) => {
      if (pass === '[REDACTED]') return full
      const leadLen = full.length - (user.length + 1 + pass.length + rest.length)
      const lead = leadLen > 0 ? full.slice(0, leadLen) : ''
      return `${lead}${user}/[REDACTED]${rest}`
    }
  )
  out = out.replace(
    SCRUB_PREFIXED_KV_RE,
    (full, lead: string, key: string, sep: string, val: string) =>
      val === '[REDACTED]' || val === '"[REDACTED]"' || val === "'[REDACTED]'"
        ? full
        : `${lead}${key}${sep}[REDACTED]`
  )
  return out
}
