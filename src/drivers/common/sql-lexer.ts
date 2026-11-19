import type { DatabaseDriverType } from '../../protocol'

const BACKTICK_DIALECTS: ReadonlySet<DatabaseDriverType> = new Set([
  'mysql',
  'mariadb',
  'clickhouse',
])

const MYSQL_FAMILY_DIALECTS: ReadonlySet<DatabaseDriverType> = new Set([
  'mysql',
  'mariadb',
])

const POSTGRES_FAMILY_DIALECTS: ReadonlySet<DatabaseDriverType> = new Set([
  'postgres',
  'cockroachdb',
])

export function usesBackslashAndHash(dialect?: DatabaseDriverType): boolean {
  return dialect !== undefined && BACKTICK_DIALECTS.has(dialect)
}

function usesMysqlExecutableComments(dialect?: DatabaseDriverType): boolean {
  return dialect !== undefined && MYSQL_FAMILY_DIALECTS.has(dialect)
}

export function isPostgresEscapeStringStart(
  sql: string,
  index: number,
  dialect?: DatabaseDriverType
): boolean {
  if (dialect === undefined || !POSTGRES_FAMILY_DIALECTS.has(dialect)) return false
  const ch = sql[index]
  if (ch !== 'E' && ch !== 'e') return false
  if (index + 1 >= sql.length || sql[index + 1] !== "'") return false
  return index === 0 || !isIdentContChar(sql.charCodeAt(index - 1))
}

/**
 * Quotes a single SQL identifier according to the target database dialect,
 * preserving dots inside single-identifier names rather than splitting them.
 */
export function quoteIdentForDialect(ident: string, dialect: DatabaseDriverType): string {
  if (BACKTICK_DIALECTS.has(dialect)) {
    return `\`${ident.replace(/`/g, '``')}\``
  }
  return `"${ident.replace(/"/g, '""')}"`
}

function tryParseQuotedTableParts(trimmed: string): string[] | null {
  const quoteChar = trimmed[0]
  if (quoteChar !== '"' && quoteChar !== '`') return null
  const parts: string[] = []
  let pos = 0
  const len = trimmed.length

  while (pos < len) {
    if (trimmed[pos] !== quoteChar) return null
    const seg = scanQuotedSegmentEnd(trimmed, pos, quoteChar, false)
    if (!seg.closed) return null
    const rawInner = trimmed.slice(pos + 1, seg.end - 1)
    const unescaped =
      quoteChar === '`' ? rawInner.replace(/``/g, '`') : rawInner.replace(/""/g, '"')
    if (!unescaped) return null
    parts.push(unescaped)
    pos = seg.end
    if (pos < len) {
      if (trimmed[pos] !== '.') return null
      pos++
      if (pos >= len) return null
    }
  }

  return parts.length > 0 ? parts : null
}

export function quoteTableReference(tableName: string, dialect: DatabaseDriverType): string {
  const trimmed = tableName.trim()
  if (!trimmed) {
    return quoteIdentForDialect('table_name', dialect)
  }
  const parsedQuotedParts = tryParseQuotedTableParts(trimmed)
  if (parsedQuotedParts) {
    return parsedQuotedParts.map((part) => quoteIdentForDialect(part, dialect)).join('.')
  }
  if (!trimmed.includes('"') && !trimmed.includes('`') && trimmed.includes('.')) {
    return trimmed
      .split('.')
      .filter((part) => part.length > 0)
      .map((part) => quoteIdentForDialect(part, dialect))
      .join('.')
  }
  return quoteIdentForDialect(trimmed, dialect)
}

export function normalizeJsonValue(value: unknown): unknown {
  if (value === undefined) return null
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') {
    const num = Number(value)
    return Number.isSafeInteger(num) ? num : value.toString()
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (value instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, '0')).join('')
  }
  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    return Array.from(view, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item))
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined && typeof v !== 'function' && typeof v !== 'symbol') {
        out[k] = normalizeJsonValue(v)
      }
    }
    return out
  }
  return null
}

function formatSqlStringLiteral(raw: string, dialect: DatabaseDriverType): string {
  let escaped = raw
  if (BACKTICK_DIALECTS.has(dialect)) {
    escaped = escaped.replace(/\\/g, '\\\\').replace(/\0/g, '\\0')
  }
  escaped = escaped.replace(/'/g, "''")
  return `'${escaped}'`
}

export function formatSqlLiteral(value: unknown, dialect: DatabaseDriverType): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'NULL' : formatSqlStringLiteral(value.toISOString(), dialect)
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const hex = String(normalizeJsonValue(value))
    return `X'${hex}'`
  }
  if (typeof value === 'object') {
    return formatSqlStringLiteral(JSON.stringify(normalizeJsonValue(value)), dialect)
  }
  return formatSqlStringLiteral(String(value), dialect)
}

export interface SqlStatementSlice {
  text: string
  start: number
  end: number
}

export function isIdentStartChar(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
}

export function isIdentContChar(code: number): boolean {
  return isIdentStartChar(code) || (code >= 48 && code <= 57)
}

export function matchDollarQuoteTag(sql: string, index: number): string | null {
  if (sql.charCodeAt(index) !== 36 /* $ */) return null
  const len = sql.length
  if (index + 1 >= len) return null
  if (sql.charCodeAt(index + 1) === 36) return '$$'
  if (!isIdentStartChar(sql.charCodeAt(index + 1))) return null
  let cursor = index + 2
  while (cursor < len && isIdentContChar(sql.charCodeAt(cursor))) {
    cursor++
  }
  if (cursor < len && sql.charCodeAt(cursor) === 36) {
    return sql.slice(index, cursor + 1)
  }
  return null
}

export function scanQuotedSegmentEnd(
  sql: string,
  start: number,
  quoteChar: string,
  allowBackslashEscape: boolean
): { end: number; closed: boolean } {
  let i = start + 1
  const len = sql.length
  while (i < len) {
    const ch = sql[i]
    if (allowBackslashEscape && ch === '\\') {
      i += 2
      continue
    }
    if (ch === quoteChar) {
      if (i + 1 < len && sql[i + 1] === quoteChar) {
        i += 2
        continue
      }
      return { end: i + 1, closed: true }
    }
    i++
  }
  return { end: len, closed: false }
}

export function scanLineCommentEnd(sql: string, start: number): number {
  let i = start + 2
  const len = sql.length
  while (i < len && sql[i] !== '\n') {
    i++
  }
  return i < len ? i + 1 : len
}

export function scanBlockCommentEnd(sql: string, start: number): number {
  let i = start + 2
  let depth = 1
  const len = sql.length
  while (i < len && depth > 0) {
    if (sql[i] === '/' && i + 1 < len && sql[i + 1] === '*') {
      depth++
      i += 2
      continue
    }
    if (sql[i] === '*' && i + 1 < len && sql[i + 1] === '/') {
      depth--
      i += 2
      continue
    }
    i++
  }
  return i
}

function trimSliceBounds(script: string, rawStart: number, rawEnd: number): { start: number; end: number } {
  let start = rawStart
  let end = rawEnd
  while (start < end && /\s/.test(script[start])) start++
  while (end > start && /\s/.test(script[end - 1])) end--
  return { start, end }
}

/**
 * Splits a SQL script into executable statements, preserving source offsets and ignoring
 * semicolons inside single/double/backtick quotes, $$ dollar blocks, and -- or /* *\/ comments.
 * Backslash single-quote escaping and `#` line comments are enabled strictly for MySQL/MariaDB/ClickHouse.
 */
export function splitSqlStatements(
  script: string,
  dialect?: DatabaseDriverType
): SqlStatementSlice[] {
  const results: SqlStatementSlice[] = []
  const len = script.length
  const backslashAndHash = usesBackslashAndHash(dialect)
  const mysqlExecComments = usesMysqlExecutableComments(dialect)
  let segStart = 0
  let hasExecutableToken = false
  let i = 0

  const flushSegment = (rawEnd: number): void => {
    if (hasExecutableToken) {
      const { start, end } = trimSliceBounds(script, segStart, rawEnd)
      if (end > start) {
        results.push({ text: script.slice(start, end), start, end })
      }
    }
    segStart = rawEnd + 1
    hasExecutableToken = false
  }

  while (i < len) {
    const ch = script[i]
    if (ch === '-' && i + 1 < len && script[i + 1] === '-') {
      i = scanLineCommentEnd(script, i)
      continue
    }
    if (ch === '#' && backslashAndHash) {
      i = scanLineCommentEnd(script, i - 1)
      continue
    }
    if (ch === '/' && i + 1 < len && script[i + 1] === '*') {
      if (mysqlExecComments && i + 2 < len && script[i + 2] === '!') {
        hasExecutableToken = true
        const closeIdx = script.indexOf('*/', i + 3)
        i = closeIdx >= 0 ? closeIdx + 2 : len
        continue
      }
      i = scanBlockCommentEnd(script, i)
      continue
    }
    if (isPostgresEscapeStringStart(script, i, dialect)) {
      hasExecutableToken = true
      i = scanQuotedSegmentEnd(script, i + 1, "'", true).end
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      hasExecutableToken = true
      const allowBackslash = ch === "'" && backslashAndHash
      i = scanQuotedSegmentEnd(script, i, ch, allowBackslash).end
      continue
    }
    if (ch === '$') {
      const tag = matchDollarQuoteTag(script, i)
      if (tag !== null) {
        hasExecutableToken = true
        const closeIdx = script.indexOf(tag, i + tag.length)
        i = closeIdx >= 0 ? closeIdx + tag.length : len
        continue
      }
    }
    if (ch === ';') {
      flushSegment(i)
      i++
      continue
    }
    if (!/\s/.test(ch)) {
      hasExecutableToken = true
    }
    i++
  }

  if (segStart < len) {
    flushSegment(len)
  }

  return results
}

/**
 * Finds the SQL statement enclosing or immediately preceding the given zero-based caret offset.
 */
export function findStatementAtOffset(
  script: string,
  offset: number,
  dialect?: DatabaseDriverType
): string {
  const stmts = splitSqlStatements(script, dialect)
  if (stmts.length === 0) return ''

  const pos = Math.max(0, Math.min(script.length, offset))
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i]
    if (pos <= stmt.end) {
      return stmt.text
    }
    const next = stmts[i + 1]
    if (!next) {
      return stmt.text
    }
    if (pos < next.start) {
      const gap = script.slice(stmt.end, next.start)
      const semiRel = gap.indexOf(';')
      const semiBoundary = semiRel >= 0 ? stmt.end + semiRel + 1 : stmt.end
      return pos <= semiBoundary ? stmt.text : next.text
    }
  }

  return stmts[stmts.length - 1].text
}

const LEADING_FILTER_KEYWORD_REGEX = /^(?:WHERE|ORDER\s+BY)\b\s*/i

/**
 * Normalizes a table WHERE or ORDER BY filter clause and rejects unquoted SQL statement breakouts
 * (`;`, `--`, `/*`, dialect-specific `#`, or unclosed string/identifier quotes).
 */
export function stripLeadingSqlComments(
  sql: string,
  dialect?: DatabaseDriverType
): string {
  const allowHash = usesBackslashAndHash(dialect)
  const mysqlExecComments = usesMysqlExecutableComments(dialect)
  const len = sql.length
  let i = 0
  while (i < len) {
    while (i < len && /\s/.test(sql[i])) i++
    if (i >= len) break
    if (sql[i] === '-' && i + 1 < len && sql[i + 1] === '-') {
      i = scanLineCommentEnd(sql, i)
      continue
    }
    if (allowHash && sql[i] === '#') {
      i = scanLineCommentEnd(sql, i - 1)
      continue
    }
    if (sql[i] === '/' && i + 1 < len && sql[i + 1] === '*') {
      if (mysqlExecComments && i + 2 < len && sql[i + 2] === '!') {
        break
      }
      i = scanBlockCommentEnd(sql, i)
      continue
    }
    break
  }
  return sql.slice(i)
}

export function sanitizeFilterClause(
  clause?: string,
  dialect?: DatabaseDriverType
): string | undefined {
  if (clause === undefined || clause === null) return undefined
  let trimmed = clause.trim()
  if (!trimmed) return undefined

  trimmed = trimmed.replace(LEADING_FILTER_KEYWORD_REGEX, '').trim()
  if (!trimmed) return undefined

  const backslashAndHash = usesBackslashAndHash(dialect)
  const allowDollarQuotes =
    dialect === undefined || dialect === 'postgres' || dialect === 'cockroachdb'
  let i = 0
  const len = trimmed.length
  while (i < len) {
    const ch = trimmed[i]
    if (isPostgresEscapeStringStart(trimmed, i, dialect)) {
      const seg = scanQuotedSegmentEnd(trimmed, i + 1, "'", true)
      if (!seg.closed) {
        throw new Error("Invalid filter clause: unclosed ' quote literal.")
      }
      i = seg.end
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const allowBackslash = ch === "'" && backslashAndHash
      const seg = scanQuotedSegmentEnd(trimmed, i, ch, allowBackslash)
      if (!seg.closed) {
        throw new Error(`Invalid filter clause: unclosed ${ch} quote literal.`)
      }
      i = seg.end
      continue
    }
    if (ch === '$' && allowDollarQuotes) {
      const tag = matchDollarQuoteTag(trimmed, i)
      if (tag !== null) {
        const closeIdx = trimmed.indexOf(tag, i + tag.length)
        if (closeIdx < 0) {
          throw new Error(`Invalid filter clause: unclosed ${tag} dollar-quoted literal.`)
        }
        i = closeIdx + tag.length
        continue
      }
    }
    if (ch === ';') {
      throw new Error('Invalid filter clause: unquoted semicolon (;) is not allowed.')
    }
    if (ch === '#' && backslashAndHash) {
      throw new Error('Invalid filter clause: unquoted SQL comment (#) is not allowed.')
    }
    if (ch === '-' && i + 1 < len && trimmed[i + 1] === '-') {
      throw new Error('Invalid filter clause: unquoted SQL comment (--) is not allowed.')
    }
    if (ch === '/' && i + 1 < len && trimmed[i + 1] === '*') {
      throw new Error('Invalid filter clause: unquoted SQL block comment (/*) is not allowed.')
    }
    i++
  }

  return trimmed
}

/**
 * Builds a single-column quick-filter WHERE predicate verified against `sanitizeFilterClause`.
 */
export function buildQuickFilterPredicate(
  column: string,
  value: unknown,
  mode: 'eq' | 'neq' | 'is-null' | 'is-not-null',
  dialect: DatabaseDriverType
): string {
  const colName = (column ?? '').trim()
  if (!colName) {
    throw new Error('Column name is required for quick filter predicate.')
  }
  const qCol = quoteIdentForDialect(colName, dialect)
  let predicate: string
  switch (mode) {
    case 'is-null':
      predicate = `${qCol} IS NULL`
      break
    case 'is-not-null':
      predicate = `${qCol} IS NOT NULL`
      break
    case 'eq':
      predicate =
        value === null || value === undefined
          ? `${qCol} IS NULL`
          : `${qCol} = ${formatSqlLiteral(value, dialect)}`
      break
    case 'neq':
      predicate =
        value === null || value === undefined
          ? `${qCol} IS NOT NULL`
          : `${qCol} != ${formatSqlLiteral(value, dialect)}`
      break
  }
  const sanitized = sanitizeFilterClause(predicate, dialect)
  if (!sanitized) {
    throw new Error('Failed to build a valid quick filter predicate.')
  }
  return sanitized
}

const SQL_MUTATING_VERBS: ReadonlySet<string> = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'UPSERT',
  'MERGE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'ATTACH',
  'DETACH',
  'VACUUM',
  'REINDEX',
  'RENAME',
  'COMMENT',
  'CALL',
  'DO',
  'LOCK',
  'KILL',
  'OPTIMIZE',
  'REPAIR',
  'FLUSH',
  'PURGE',
  'LOAD',
  'IMPORT',
  'COPY',
  'EXEC',
  'EXECUTE',
  'ANALYZE',
  'ANALYSE',
  'SHUTDOWN',
  'RESTART',
  'RESET',
  'SET',
  'SYSTEM',
  'EXCHANGE',
  'REFRESH',
  'CLUSTER',
  'RESTORE',
  'INSTALL',
  'UNINSTALL',
  'REASSIGN',
  'PREPARE',
  'BEGIN',
  'USE',
  'START',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'DEALLOCATE',
  'DISCARD',
  'CHECKPOINT',
])

const SQLITE_READONLY_PARENS_PRAGMAS: ReadonlySet<string> = new Set([
  'TABLE_INFO',
  'TABLE_XINFO',
  'FOREIGN_KEY_LIST',
  'FOREIGN_KEY_CHECK',
  'INDEX_LIST',
  'INDEX_INFO',
  'INDEX_XINFO',
  'TABLE_LIST',
  'INTEGRITY_CHECK',
  'QUICK_CHECK',
  'COLLATE',
])

const SQL_CTE_MUTATING_REGEX =
  /\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|ATTACH|DETACH)\b/i

const REDIS_READONLY_COMMANDS: ReadonlySet<string> = new Set([
  'GET',
  'MGET',
  'GETRANGE',
  'STRLEN',
  'EXISTS',
  'TYPE',
  'TTL',
  'PTTL',
  'SCAN',
  'HSCAN',
  'SSCAN',
  'ZSCAN',
  'KEYS',
  'DBSIZE',
  'PING',
  'ECHO',
  'INFO',
  'TIME',
  'HGET',
  'HMGET',
  'HGETALL',
  'HKEYS',
  'HVALS',
  'HLEN',
  'HEXISTS',
  'LRANGE',
  'LLEN',
  'LINDEX',
  'LPOS',
  'SMEMBERS',
  'SISMEMBER',
  'SMISMEMBER',
  'SCARD',
  'SRANDMEMBER',
  'ZRANGE',
  'ZREVRANGE',
  'ZRANGEBYSCORE',
  'ZSCORE',
  'ZRANK',
  'ZREVRANK',
  'ZCARD',
  'ZCOUNT',
  'XLEN',
  'XRANGE',
  'XREVRANGE',
  'OBJECT',
  'MEMORY',
  'COMMAND',
  'ROLE',
])

const REDIS_WRITE_COMMANDS: ReadonlySet<string> = new Set([
  'SET',
  'SETEX',
  'PSETEX',
  'SETNX',
  'MSET',
  'MSETNX',
  'GETSET',
  'GETDEL',
  'APPEND',
  'SETRANGE',
  'DEL',
  'UNLINK',
  'HSET',
  'HSETNX',
  'HMSET',
  'HDEL',
  'HINCRBY',
  'HINCRBYFLOAT',
  'LPUSH',
  'RPUSH',
  'LPOP',
  'RPOP',
  'BLPOP',
  'BRPOP',
  'LSET',
  'LINSERT',
  'LREM',
  'LTRIM',
  'SADD',
  'SREM',
  'SPOP',
  'SMOVE',
  'ZADD',
  'ZREM',
  'ZINCRBY',
  'ZPOPMIN',
  'ZPOPMAX',
  'FLUSHDB',
  'FLUSHALL',
  'RENAME',
  'RENAMENX',
  'EXPIRE',
  'EXPIREAT',
  'PEXPIRE',
  'PEXPIREAT',
  'PERSIST',
  'INCR',
  'INCRBY',
  'INCRBYFLOAT',
  'DECR',
  'DECRBY',
  'COPY',
  'MOVE',
  'SWAPDB',
  'MIGRATE',
  'RESTORE',
  'XADD',
  'XDEL',
  'XTRIM',
  'PFADD',
  'PFMERGE',
  'GEOADD',
  'PUBLISH',
  'EVAL',
  'EVALSHA',
  'SAVE',
  'BGSAVE',
  'BGREWRITEAOF',
  'SHUTDOWN',
])

function stripCommentsAndLiterals(
  sql: string,
  dialect?: DatabaseDriverType,
  preserveMysqlExecComments = true
): string {
  const backslashAndHash = usesBackslashAndHash(dialect)
  const unwrapMysqlExec = preserveMysqlExecComments && usesMysqlExecutableComments(dialect)
  let out = ''
  let i = 0
  let execCommentDepth = 0
  const len = sql.length

  while (i < len) {
    const ch = sql[i]
    if (ch === '-' && i + 1 < len && sql[i + 1] === '-') {
      out += ' '
      i = scanLineCommentEnd(sql, i)
      continue
    }
    if (ch === '#' && backslashAndHash) {
      out += ' '
      i = scanLineCommentEnd(sql, i - 1)
      continue
    }
    if (execCommentDepth > 0 && ch === '*' && i + 1 < len && sql[i + 1] === '/') {
      out += ' '
      execCommentDepth--
      i += 2
      continue
    }
    if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
      if (unwrapMysqlExec && i + 2 < len && sql[i + 2] === '!') {
        out += ' '
        execCommentDepth++
        i += 3
        while (i < len && sql[i] >= '0' && sql[i] <= '9') {
          i++
        }
        continue
      }
      out += ' '
      i = scanBlockCommentEnd(sql, i)
      continue
    }
    if (isPostgresEscapeStringStart(sql, i, dialect)) {
      out += ' '
      i = scanQuotedSegmentEnd(sql, i + 1, "'", true).end
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      out += ' '
      const allowBackslash = ch === "'" && backslashAndHash
      i = scanQuotedSegmentEnd(sql, i, ch, allowBackslash).end
      continue
    }
    if (ch === '$') {
      const tag = matchDollarQuoteTag(sql, i)
      if (tag !== null) {
        out += ' '
        const closeIdx = sql.indexOf(tag, i + tag.length)
        i = closeIdx >= 0 ? closeIdx + tag.length : len
        continue
      }
    }
    out += ch
    i++
  }

  return out
}

interface ParsedExplainInfo {
  hasAnalyze: boolean
  hasWriteOption: boolean
  remainder: string
}

function parseExplainOptions(afterExplain: string): ParsedExplainInfo {
  let rest = afterExplain.trimStart()
  let hasAnalyze = false
  let hasWriteOption = false

  while (rest.length > 0) {
    if (rest.startsWith('(')) {
      let depth = 0
      let closeIdx = -1
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '(') depth++
        else if (rest[i] === ')') {
          depth--
          if (depth === 0) {
            closeIdx = i
            break
          }
        }
      }
      if (closeIdx < 0) {
        hasWriteOption = true
        break
      }
      const groupContent = rest.slice(1, closeIdx)
      const analyzeMatch = /\bANALY[ZS]E\b(?:\s+(FALSE|OFF|0)\b)?/i.exec(groupContent)
      if (analyzeMatch && !analyzeMatch[1]) {
        hasAnalyze = true
      }
      if (/\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(groupContent)) {
        hasWriteOption = true
      }
      rest = rest.slice(closeIdx + 1).trimStart()
      continue
    }

    const analyzeOpt = /^ANALY[ZS]E\b/i.exec(rest)
    if (analyzeOpt) {
      hasAnalyze = true
      rest = rest.slice(analyzeOpt[0].length).trimStart()
      continue
    }

    const stdOpt =
      /^(?:VERBOSE|QUERY\s+PLAN|EXTENDED|PARTITIONS|DISTSQL|OPT|TYPES|VEC|AST|SYNTAX|PLAN|PIPELINE|ESTIMATE|TABLE\s+OVERRIDE|CURRENT\s+TRANSACTION|FOR\s+CONNECTION\s+\d+|FORMAT\s*=\s*[A-Za-z0-9_]+|FORMAT\s+[A-Za-z0-9_]+)\b/i.exec(
        rest
      )
    if (stdOpt) {
      rest = rest.slice(stdOpt[0].length).trimStart()
      continue
    }

    // ClickHouse EXPLAIN PLAN settings e.g. `header = 1, actions = 1`
    const chSettingOpt = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*[A-Za-z0-9_]+\s*,?/i.exec(rest)
    if (chSettingOpt) {
      rest = rest.slice(chSettingOpt[0].length).trimStart()
      continue
    }

    break
  }

  if (/\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(rest)) {
    hasWriteOption = true
  }

  return { hasAnalyze, hasWriteOption, remainder: rest }
}

/**
 * Checks whether an EXPLAIN statement enables ANALYZE/ANALYSE execution (US or British spelling,
 * bare or inside PostgreSQL parenthesized option lists).
 */
export function hasExplainAnalyzeOption(sql: string, dialect?: DatabaseDriverType): boolean {
  const clean = stripCommentsAndLiterals(sql, dialect, true).replace(/^[\s(]+/, '').trim()
  const firstMatch = /^EXPLAIN\b/i.exec(clean)
  if (!firstMatch) return false
  return parseExplainOptions(clean.slice(firstMatch[0].length)).hasAnalyze
}

/**
 * Checks whether the statement wrapped inside an EXPLAIN (or the statement itself if not prefixed
 * with EXPLAIN) is mutating, independent of whether ANALYZE was specified.
 */
export function isExplainTargetMutating(sql: string, dialect?: DatabaseDriverType): boolean {
  const clean = stripCommentsAndLiterals(sql, dialect, true).replace(/^[\s(]+/, '').trim()
  if (!clean) return false
  const firstMatch = /^EXPLAIN\b/i.exec(clean)
  if (!firstMatch) {
    return isCleanSingleStatementMutating(clean)
  }
  const parsed = parseExplainOptions(clean.slice(firstMatch[0].length))
  if (parsed.hasWriteOption) return true
  return isCleanSingleStatementMutating(parsed.remainder)
}

function isCleanSingleStatementMutating(rawClean: string): boolean {
  const clean = rawClean.replace(/^[\s(]+/, '').trim()
  if (!clean) return false

  const firstMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(clean)
  if (!firstMatch) return false

  const verb = firstMatch[1].toUpperCase()
  if (verb === 'SHOW' || verb === 'DESCRIBE' || verb === 'DESC') {
    return false
  }
  if (verb === 'SELECT') {
    return /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(clean)
  }
  if (verb === 'PRAGMA') {
    const upper = clean.toUpperCase()
    if (
      /\bWRITABLE_SCHEMA\b/.test(upper) ||
      /\bWAL_CHECKPOINT\b/.test(upper) ||
      /\bOPTIMIZE\b/.test(upper) ||
      clean.includes('=')
    ) {
      return true
    }
    const parenMatch =
      /^PRAGMA\s+(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/i.exec(clean)
    if (parenMatch) {
      return !SQLITE_READONLY_PARENS_PRAGMAS.has(parenMatch[1].toUpperCase())
    }
    return false
  }
  if (verb === 'EXPLAIN') {
    const parsed = parseExplainOptions(clean.slice(firstMatch[0].length))
    if (parsed.hasAnalyze || parsed.hasWriteOption) {
      return true
    }
    return isCleanSingleStatementMutating(parsed.remainder)
  }
  if (verb === 'WITH') {
    return SQL_CTE_MUTATING_REGEX.test(clean) || /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(clean)
  }
  return SQL_MUTATING_VERBS.has(verb)
}

function isSingleSqlStatementMutating(stmtText: string, dialect?: DatabaseDriverType): boolean {
  const stripped = stripCommentsAndLiterals(stmtText, dialect, true)
  const parts = stripped.includes(';') ? stripped.split(';') : [stripped]
  return parts.some((part) => isCleanSingleStatementMutating(part))
}

function isRedisCommandMutating(script: string): boolean {
  const lines = script.split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('--') || line.startsWith('//')) {
      continue
    }
    const tokens = line.split(/\s+/)
    const cmd = tokens[0].replace(/^["']|["']$/g, '').toUpperCase()
    const sub = (tokens[1] ?? '').replace(/^["']|["']$/g, '').toUpperCase()

    if (REDIS_WRITE_COMMANDS.has(cmd)) return true
    if (cmd === 'CONFIG') {
      if (sub !== 'GET') return true
      continue
    }
    if (cmd === 'CLIENT') {
      if (!new Set(['LIST', 'INFO', 'ID', 'GETNAME', 'GETREDIR']).has(sub)) return true
      continue
    }
    if (cmd === 'ACL') {
      if (!new Set(['LIST', 'WHOAMI', 'USERS', 'GETUSER', 'CAT']).has(sub)) return true
      continue
    }
    if (cmd === 'SCRIPT') {
      if (sub !== 'EXISTS') return true
      continue
    }
    if (!REDIS_READONLY_COMMANDS.has(cmd)) {
      return true
    }
  }
  return false
}

/**
 * Checks whether a SQL script or Redis command sequence can mutate state or schema,
 * supporting read-only enforcement on connections flagged `readOnly: true`.
 */
export function isMutatingStatement(sql: string, driver: DatabaseDriverType): boolean {
  if (!sql || !sql.trim()) return false
  if (driver === 'redis') {
    return isRedisCommandMutating(sql)
  }
  const statements = splitSqlStatements(sql, driver)
  if (statements.length === 0) {
    return isSingleSqlStatementMutating(sql, driver)
  }
  return statements.some((stmt) => isSingleSqlStatementMutating(stmt.text, driver))
}

const SQL_DDL_VERBS: ReadonlySet<string> = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'RENAME',
  'TRUNCATE',
  'VACUUM',
  'ATTACH',
  'DETACH',
])

/**
 * Detects whether a SQL script contains any DDL or schema-altering statement
 * (`CREATE`, `ALTER`, `DROP`, `RENAME`, `TRUNCATE`, `VACUUM`, `ATTACH`, `DETACH`),
 * ignoring comments and quoted string/identifier literals.
 */
export function containsDdlStatement(sql: string, dialect?: DatabaseDriverType): boolean {
  if (!sql || !sql.trim()) return false
  const statements = splitSqlStatements(sql, dialect)
  const list = statements.length > 0 ? statements.map((s) => s.text) : [sql]
  return list.some((stmtText) => {
    const stripped = stripCommentsAndLiterals(stmtText, dialect, true)
    const parts = stripped.includes(';') ? stripped.split(';') : [stripped]
    return parts.some((part) => {
      const clean = part.replace(/^[\s(]+/, '').trim()
      if (!clean) return false
      const firstMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(clean)
      if (!firstMatch) return false
      return SQL_DDL_VERBS.has(firstMatch[1].toUpperCase())
    })
  })
}
