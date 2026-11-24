import type { DatabaseDriverType } from '../../protocol'
import { isMssqlReadOnlyBlocked } from './mssql-sql'
import { splitOracleStatements } from './oracle-sql'
import {
  containsDdlStatement,
  formatSqlBinaryLiteral,
  formatSqlLiteral,
  isIdentContChar,
  isIdentStartChar,
  isPostgresEscapeStringStart,
  matchDollarQuoteTag,
  matchMysqlExecCommentPrefix,
  normalizeJsonValue,
  quoteIdentForDialect,
  quoteTableReference,
  scanBlockCommentEnd,
  scanLineCommentEnd,
  scanQuotedSegmentEnd,
  splitSqlStatements,
  stripLeadingSqlComments,
  supportsDollarQuoting,
  supportsNestedBlockComments,
  usesBackslashAndHash,
  findStatementAtOffset,
  type SqlStatementSlice,
} from '../../shared-sql-core.js'

export {
  containsDdlStatement,
  formatSqlBinaryLiteral,
  formatSqlLiteral,
  isIdentContChar,
  isIdentStartChar,
  isPostgresEscapeStringStart,
  matchDollarQuoteTag,
  matchMysqlExecCommentPrefix,
  normalizeJsonValue,
  quoteIdentForDialect,
  quoteTableReference,
  scanBlockCommentEnd,
  scanLineCommentEnd,
  scanQuotedSegmentEnd,
  splitSqlStatements,
  stripLeadingSqlComments,
  supportsDollarQuoting,
  supportsNestedBlockComments,
  usesBackslashAndHash,
  findStatementAtOffset,
  type SqlStatementSlice,
}

function scanMssqlBracketIdentEnd(sql: string, start: number): { end: number; closed: boolean } {
  let i = start + 1
  const len = sql.length
  while (i < len) {
    if (sql[i] === ']') {
      if (i + 1 < len && sql[i + 1] === ']') {
        i += 2
        continue
      }
      return { end: i + 1, closed: true }
    }
    i++
  }
  return { end: len, closed: false }
}

/**
 * Strips SQL comments and string/dollar literals to spaces while preserving
 * quoted identifiers (including MSSQL `[...]`) as neutral `x` placeholders so
 * `SELECT * INTO [dbo].[copy]` does not degenerate into `INTO  . `.
 */
export function stripCommentsAndLiterals(
  sql: string,
  dialect?: DatabaseDriverType,
  preserveMysqlExecComments = true
): string {
  const backslashAndHash = usesBackslashAndHash(dialect)
  const nestedComments = supportsNestedBlockComments(dialect)
  const dollarQuotes = supportsDollarQuoting(dialect)
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
      const execLen = preserveMysqlExecComments
        ? matchMysqlExecCommentPrefix(sql, i, dialect)
        : 0
      if (execLen > 0) {
        out += ' '
        execCommentDepth++
        i += execLen
        continue
      }
      out += ' '
      i = scanBlockCommentEnd(sql, i, nestedComments)
      continue
    }
    if (isPostgresEscapeStringStart(sql, i, dialect)) {
      out += ' '
      i = scanQuotedSegmentEnd(sql, i + 1, "'", true).end
      continue
    }
    if (ch === "'") {
      out += ' '
      i = scanQuotedSegmentEnd(sql, i, "'", backslashAndHash).end
      continue
    }
    if (ch === '"' || ch === '`') {
      out += ' x '
      i = scanQuotedSegmentEnd(sql, i, ch, false).end
      continue
    }
    if (ch === '[' && dialect === 'mssql') {
      out += ' x '
      i = scanMssqlBracketIdentEnd(sql, i).end
      continue
    }
    if (dollarQuotes && ch === '$') {
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

/** Collapses SQL to a single line and bounds its length for display previews. */
export function compactSql(sql: string, maxLength = 80): string {
  const compact = sql.replace(/\s+/g, ' ').trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact
}

const LEADING_FILTER_KEYWORD_REGEX = /^(?:WHERE|ORDER\s+BY)\b\s*/i

/**
 * Normalizes a table WHERE or ORDER BY filter clause and rejects unquoted SQL statement breakouts
 * (`;`, `--`, `/*`, dialect-specific `#`, or unclosed string/identifier quotes).
 */
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
    if (ch === '[' && dialect === 'mssql') {
      const seg = scanMssqlBracketIdentEnd(trimmed, i)
      if (!seg.closed) {
        throw new Error('Invalid filter clause: unclosed [ bracket identifier.')
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
  sanitizeFilterClause(predicate, dialect)
  return predicate
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
  /\b(?:INSERT|UPDATE|DELETE|REPLACE\s+INTO|UPSERT|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|ATTACH|DETACH)\b/i

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

interface ParsedExplainInfo {
  hasAnalyze: boolean
  hasWriteOption: boolean
  remainder: string
}

function findMatchingParenIndex(text: string, openIdx: number): number {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function parseExplainOptions(afterExplain: string): ParsedExplainInfo {
  let rest = afterExplain.trimStart()
  let hasAnalyze = false
  let hasWriteOption = false
  let allowParenOptions = true

  while (rest.length > 0) {
    if (allowParenOptions && rest.startsWith('(')) {
      const closeIdx = findMatchingParenIndex(rest, 0)
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
      allowParenOptions = false
      continue
    }

    const analyzeOpt = /^ANALY[ZS]E\b/i.exec(rest)
    if (analyzeOpt) {
      hasAnalyze = true
      allowParenOptions = false
      rest = rest.slice(analyzeOpt[0].length).trimStart()
      continue
    }

    const stdOpt =
      /^(?:VERBOSE|QUERY\s+PLAN|EXTENDED|PARTITIONS|DISTSQL|OPT|TYPES|VEC|AST|SYNTAX|PLAN|PIPELINE|ESTIMATE|TABLE\s+OVERRIDE|CURRENT\s+TRANSACTION|FOR\s+CONNECTION\s+\d+|FORMAT\s*=\s*[A-Za-z0-9_]+|FORMAT\s+[A-Za-z0-9_]+)\b/i.exec(
        rest
      )
    if (stdOpt) {
      allowParenOptions = false
      rest = rest.slice(stdOpt[0].length).trimStart()
      continue
    }

    // Oracle EXPLAIN PLAN [SET STATEMENT_ID = ...] [INTO [schema.]table[@dblink]] FOR <stmt>
    const oracleSetOpt = /^SET\s+STATEMENT_ID\s*=\s*(?:[A-Za-z0-9_]+)?(?=\s*(?:\bINTO\b|\bFOR\b))/i.exec(
      rest
    )
    if (oracleSetOpt) {
      allowParenOptions = false
      rest = rest.slice(oracleSetOpt[0].length).trimStart()
      continue
    }

    const oracleIntoOpt = /^INTO\s+(?!OUTFILE\b|DUMPFILE\b)[\s\S]*?(?=\bFOR\b)/i.exec(rest)
    if (oracleIntoOpt) {
      allowParenOptions = false
      rest = rest.slice(oracleIntoOpt[0].length).trimStart()
      continue
    }

    const oracleForOpt = /^FOR\b(?!\s+CONNECTION\b)/i.exec(rest)
    if (oracleForOpt) {
      allowParenOptions = false
      rest = rest.slice(oracleForOpt[0].length).trimStart()
      continue
    }

    // ClickHouse EXPLAIN PLAN settings e.g. `header = 1, actions = 1`
    const chSettingOpt = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*[A-Za-z0-9_]+\s*,?/i.exec(rest)
    if (chSettingOpt) {
      allowParenOptions = false
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

const SQL_READONLY_FOLLOWING_WITH_VERBS: ReadonlySet<string> = new Set([
  'SELECT',
  'VALUES',
  'TABLE',
  'SHOW',
  'DESCRIBE',
  'DESC',
])

function isSelectStatementMutating(clean: string): boolean {
  if (/\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(clean)) return true
  if (/\bINTO\s+(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?(?:TABLE\s+)?[#\[A-Za-z_"]/i.test(clean)) {
    const fromMatch = /\bFROM\b/i.exec(clean)
    const intoMatch = /\bINTO\b/i.exec(clean)
    if (intoMatch && (!fromMatch || intoMatch.index < fromMatch.index)) {
      return true
    }
  }
  if (/\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/i.test(clean)) return true
  if (
    /\b(?:setval|pg_terminate_backend|pg_cancel_backend|lo_unlink|lo_import|lo_export)\s*\(/i.test(
      clean
    )
  ) {
    return true
  }
  return false
}

function parseWithCteStatement(
  clean: string
): { cteBodies: string[]; remainder: string } | null {
  let rest = clean.replace(/^WITH\b/i, '').trimStart()
  if (/^RECURSIVE\b/i.test(rest)) {
    rest = rest.replace(/^RECURSIVE\b/i, '').trimStart()
  }
  const cteBodies: string[] = []
  while (rest.length > 0) {
    const nameMatch = /^[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*/.exec(rest)
    if (!nameMatch) return null
    rest = rest.slice(nameMatch[0].length).trimStart()

    if (rest.startsWith('(')) {
      const closeColsIdx = findMatchingParenIndex(rest, 0)
      if (closeColsIdx < 0) return null
      rest = rest.slice(closeColsIdx + 1).trimStart()
    }

    const asMatch = /^AS\b(?:\s+(?:NOT\s+)?MATERIALIZED\b)?\s*/i.exec(rest)
    if (!asMatch) return null
    rest = rest.slice(asMatch[0].length).trimStart()

    if (!rest.startsWith('(')) return null
    const closeBodyIdx = findMatchingParenIndex(rest, 0)
    if (closeBodyIdx < 0) return null
    const body = rest.slice(1, closeBodyIdx).trim()
    if (!body) return null
    cteBodies.push(body)

    rest = rest.slice(closeBodyIdx + 1).trimStart()
    if (rest.startsWith(',')) {
      rest = rest.slice(1).trimStart()
      if (!rest) return null
      continue
    }
    break
  }
  if (cteBodies.length === 0 || !rest) return null
  return { cteBodies, remainder: rest }
}

function isCleanSingleStatementMutating(
  rawClean: string,
  failClosedOnUnknown = false
): boolean {
  const clean = rawClean.trim()
  if (!clean) return failClosedOnUnknown

  if (clean.startsWith('(')) {
    const closeIdx = findMatchingParenIndex(clean, 0)
    if (closeIdx < 0) return true
    const inner = clean.slice(1, closeIdx).trim()
    if (!inner || isCleanSingleStatementMutating(inner, failClosedOnUnknown)) return true

    const after = clean.slice(closeIdx + 1).trim()
    if (!after) return false
    if (
      /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(after) ||
      /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/i.test(after)
    ) {
      return true
    }
    const setOpMatch =
      /^(?:UNION(?:\s+(?:ALL|DISTINCT))?|INTERSECT(?:\s+(?:ALL|DISTINCT))?|EXCEPT(?:\s+(?:ALL|DISTINCT))?)\b\s*/i.exec(
        after
      )
    if (setOpMatch) {
      const afterSetOp = after.slice(setOpMatch[0].length).trim()
      return !afterSetOp || isCleanSingleStatementMutating(afterSetOp, failClosedOnUnknown)
    }
    if (/^(?:ORDER\s+BY|LIMIT|OFFSET|FETCH)\b/i.test(after)) {
      return false
    }
    return true
  }

  const firstMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(clean)
  if (!firstMatch) return failClosedOnUnknown

  const verb = firstMatch[1].toUpperCase()
  if (failClosedOnUnknown && !SQL_READONLY_FOLLOWING_WITH_VERBS.has(verb)) {
    return true
  }
  if (verb === 'SHOW' || verb === 'DESCRIBE' || verb === 'DESC') {
    return false
  }
  if (verb === 'VALUES' || verb === 'TABLE') {
    return (
      /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(clean) ||
      /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/i.test(clean)
    )
  }
  if (verb === 'SELECT') {
    return isSelectStatementMutating(clean)
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
    return isCleanSingleStatementMutating(parsed.remainder, failClosedOnUnknown)
  }
  if (verb === 'WITH') {
    if (SQL_CTE_MUTATING_REGEX.test(clean) || /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(clean)) {
      return true
    }
    const parsedWith = parseWithCteStatement(clean)
    if (!parsedWith) {
      return true
    }
    if (parsedWith.cteBodies.some((body) => isCleanSingleStatementMutating(body))) {
      return true
    }
    return isCleanSingleStatementMutating(parsedWith.remainder, true)
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

const MONGODB_READONLY_COMMANDS: ReadonlySet<string> = new Set([
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

function hasMongoPipelineWriteStage(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some((item) => hasMongoPipelineWriteStage(item))
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === '$out' || k === '$merge') return true
      if (hasMongoPipelineWriteStage(v)) return true
    }
  }
  return false
}

const MONGODB_READONLY_COLL_METHODS: ReadonlySet<string> = new Set([
  'find',
  'findOne',
  'aggregate',
  'countDocuments',
  'estimatedDocumentCount',
  'distinct',
  'getIndexes',
  'indexes',
  'stats',
  'explain',
])

const MONGODB_READONLY_CURSOR_CHAIN_METHODS: ReadonlySet<string> = new Set([
  'sort',
  'limit',
  'skip',
  'projection',
  'project',
  'collation',
  'hint',
  'maxTimeMS',
  'toArray',
  'explain',
  'count',
  'find',
  'findOne',
  'aggregate',
  'countDocuments',
  'estimatedDocumentCount',
  'distinct',
])

const MONGODB_READONLY_DB_METHODS: ReadonlySet<string> = new Set([
  'stats',
  'serverStatus',
  'getCollectionNames',
])

const MONGODB_COLLECTION_SHORTHAND_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127};?$/

function skipMongoJsString(text: string, start: number): { end: number; value: string } {
  const quote = text[start]
  let i = start + 1
  let value = ''
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      if (i + 1 < text.length) value += text[i + 1]
      i += 2
      continue
    }
    if (ch === quote) {
      return { end: i + 1, value }
    }
    value += ch
    i++
  }
  return { end: text.length, value }
}

function scanMongoGroupEnd(text: string, openPos: number, openChar: string, closeChar: string): number {
  let i = openPos + 1
  let depth = 1
  let prevSig = openChar
  while (i < text.length && depth > 0) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipMongoJsString(text, i).end
      prevSig = '"'
      continue
    }
    if (ch === '/' && (prevSig === '' || '([{:,;=!&|?^~+-*%<>'.includes(prevSig))) {
      let j = i + 1
      let inClass = false
      while (j < text.length) {
        const rch = text[j]
        if (rch === '\\') {
          j += 2
          continue
        }
        if (rch === '[') inClass = true
        else if (rch === ']') inClass = false
        else if (rch === '/' && !inClass) {
          j++
          while (j < text.length && /[a-z]/i.test(text[j])) j++
          break
        }
        j++
      }
      i = j
      prevSig = '/'
      continue
    }
    if (ch === openChar) depth++
    else if (ch === closeChar) depth--
    if (!/\s/.test(ch)) prevSig = ch
    i++
  }
  return i
}

function stripMongoComments(raw: string): string {
  let out = ''
  let i = 0
  let prevSig = ''
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const seg = skipMongoJsString(raw, i)
      out += raw.slice(i, seg.end)
      i = seg.end
      prevSig = '"'
      continue
    }
    if (ch === '/' && i + 1 < raw.length && raw[i + 1] === '/') {
      const nl = raw.indexOf('\n', i + 2)
      out += '\n'
      i = nl < 0 ? raw.length : nl + 1
      continue
    }
    if (ch === '/' && i + 1 < raw.length && raw[i + 1] === '*') {
      const close = raw.indexOf('*/', i + 2)
      out += ' '
      i = close < 0 ? raw.length : close + 2
      continue
    }
    if (ch === '/' && (prevSig === '' || '([{:,;=!&|?^~+-*%<>'.includes(prevSig))) {
      let j = i + 1
      let inClass = false
      while (j < raw.length) {
        const rch = raw[j]
        if (rch === '\\') {
          j += 2
          continue
        }
        if (rch === '[') inClass = true
        else if (rch === ']') inClass = false
        else if (rch === '/' && !inClass) {
          j++
          while (j < raw.length && /[a-z]/i.test(raw[j])) j++
          break
        }
        j++
      }
      out += raw.slice(i, j)
      i = j
      prevSig = '/'
      continue
    }
    if (!/\s/.test(ch)) prevSig = ch
    out += ch
    i++
  }
  return out
}

function splitMongoShellStatements(raw: string): string[] {
  const clean = stripMongoComments(raw)
  const stmts: string[] = []
  let i = 0
  let start = 0
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let prevSig = ''

  while (i < clean.length) {
    const ch = clean[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipMongoJsString(clean, i).end
      prevSig = '"'
      continue
    }
    if (ch === '/' && (prevSig === '' || '([{:,;=!&|?^~+-*%<>'.includes(prevSig))) {
      let j = i + 1
      let inClass = false
      while (j < clean.length) {
        const rch = clean[j]
        if (rch === '\\') {
          j += 2
          continue
        }
        if (rch === '[') inClass = true
        else if (rch === ']') inClass = false
        else if (rch === '/' && !inClass) {
          j++
          while (j < clean.length && /[a-z]/i.test(clean[j])) j++
          break
        }
        j++
      }
      i = j
      prevSig = '/'
      continue
    }
    if (ch === '(') parenDepth++
    else if (ch === ')' && parenDepth > 0) parenDepth--
    else if (ch === '[') bracketDepth++
    else if (ch === ']' && bracketDepth > 0) bracketDepth--
    else if (ch === '{') braceDepth++
    else if (ch === '}' && braceDepth > 0) braceDepth--

    const atTop = parenDepth === 0 && bracketDepth === 0 && braceDepth === 0
    if (atTop && (ch === ';' || ch === '\n')) {
      if (ch === '\n') {
        let nextNonWs = i + 1
        while (nextNonWs < clean.length && /\s/.test(clean[nextNonWs])) nextNonWs++
        if (clean[nextNonWs] === '.') {
          i++
          continue
        }
      }
      const seg = clean.slice(start, i).trim()
      if (seg) stmts.push(seg)
      start = i + 1
      if (ch === ';') prevSig = ''
      i++
      continue
    }
    if (!/\s/.test(ch)) prevSig = ch
    i++
  }

  const tail = clean.slice(start).trim()
  if (tail) stmts.push(tail)
  return stmts
}

function hasMongoWriteKeyInObjectText(text: string): boolean {
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const seg = skipMongoJsString(text, i)
      let k = seg.end
      while (k < text.length && /\s/.test(text[k])) k++
      if (text[k] === ':' && (seg.value === '$out' || seg.value === '$merge')) {
        return true
      }
      i = seg.end
      continue
    }
    if (ch === '$') {
      const m = /^\$(?:out|merge)\b/.exec(text.slice(i))
      if (m) {
        let k = i + m[0].length
        while (k < text.length && /\s/.test(text[k])) k++
        if (text[k] === ':') return true
      }
    }
    i++
  }
  return false
}

function extractFirstObjectKey(objText: string): string | null {
  let i = 0
  while (i < objText.length && (/\s/.test(objText[i]) || objText[i] === '{')) i++
  if (i >= objText.length || objText[i] === '}') return null
  if (objText[i] === '"' || objText[i] === "'" || objText[i] === '`') {
    const seg = skipMongoJsString(objText, i)
    let k = seg.end
    while (k < objText.length && /\s/.test(objText[k])) k++
    return objText[k] === ':' ? seg.value : null
  }
  const keyMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(objText.slice(i))
  return keyMatch ? keyMatch[1] : null
}

function isMongoRawCommandObjectMutating(rawObjText: string): boolean {
  const trimmed = rawObjText.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return true
  try {
    const rec = JSON.parse(trimmed) as Record<string, unknown>
    const keys = Object.keys(rec)
    if (keys.length === 0) return true
    const cmd = keys[0].toLowerCase()
    if (cmd === 'aggregate') return hasMongoPipelineWriteStage(rec)
    if (cmd === 'explain') {
      if (hasMongoPipelineWriteStage(rec.explain)) return true
      if (rec.explain && typeof rec.explain === 'object' && !Array.isArray(rec.explain)) {
        const innerKeys = Object.keys(rec.explain as Record<string, unknown>)
        if (innerKeys.length > 0 && !MONGODB_READONLY_COMMANDS.has(innerKeys[0].toLowerCase())) {
          return true
        }
      }
      return false
    }
    return !MONGODB_READONLY_COMMANDS.has(cmd)
  } catch {
    if (hasMongoWriteKeyInObjectText(trimmed)) return true
    const firstKey = extractFirstObjectKey(trimmed)
    if (!firstKey) return true
    const lower = firstKey.toLowerCase()
    if (lower === 'explain') {
      const innerStart = trimmed.indexOf('{', trimmed.indexOf(':'))
      if (innerStart < 0) return true
      const innerEnd = scanMongoGroupEnd(trimmed, innerStart, '{', '}')
      const innerKey = extractFirstObjectKey(trimmed.slice(innerStart, innerEnd))
      return !innerKey || !MONGODB_READONLY_COMMANDS.has(innerKey.toLowerCase())
    }
    return !MONGODB_READONLY_COMMANDS.has(lower)
  }
}

function parseSingleMongoShellStatementMutating(stmt: string): boolean {
  const trimmed = stmt.replace(/;+\s*$/, '').trim()
  if (MONGODB_COLLECTION_SHORTHAND_RE.test(trimmed)) return false
  if (/^show\s+(?:dbs|databases|collections|tables)\s*$/i.test(trimmed)) return false
  if (/^use\s+[A-Za-z0-9_.-]+\s*$/i.test(trimmed)) return false

  if (trimmed.startsWith('{')) {
    return isMongoRawCommandObjectMutating(trimmed)
  }

  if (!/^db\s*(?:\.|\[)/.test(trimmed)) {
    return true
  }

  let cursor = 2
  const len = trimmed.length
  const skipWs = (): void => {
    while (cursor < len && /\s/.test(trimmed[cursor])) cursor++
  }

  interface MongoParsedCallSegment {
    name: string
    argsText: string | null
  }
  const segments: MongoParsedCallSegment[] = []

  while (cursor < len) {
    skipWs()
    if (trimmed[cursor] === '.') {
      cursor++
      skipWs()
      const idMatch = /^([A-Za-z_$][A-Za-z0-9_$-]*)/.exec(trimmed.slice(cursor))
      if (!idMatch) return true
      const name = idMatch[1]
      cursor += name.length
      skipWs()
      let argsText: string | null = null
      if (cursor < len && trimmed[cursor] === '(') {
        const endParen = scanMongoGroupEnd(trimmed, cursor, '(', ')')
        if (endParen > len || trimmed[endParen - 1] !== ')') return true
        argsText = trimmed.slice(cursor + 1, endParen - 1)
        cursor = endParen
      }
      segments.push({ name, argsText })
      continue
    }
    if (trimmed[cursor] === '[') {
      const endBracket = scanMongoGroupEnd(trimmed, cursor, '[', ']')
      if (endBracket > len || trimmed[endBracket - 1] !== ']') return true
      const inner = trimmed.slice(cursor + 1, endBracket - 1).trim()
      if (!inner || (inner[0] !== "'" && inner[0] !== '"' && inner[0] !== '`')) return true
      const strSeg = skipMongoJsString(inner, 0)
      if (!strSeg.value) return true
      cursor = endBracket
      segments.push({ name: strSeg.value, argsText: null })
      continue
    }
    return true
  }

  const first = segments[0]
  if (segments.length === 1 && first.argsText !== null) {
    if (MONGODB_READONLY_DB_METHODS.has(first.name)) return false
    if (first.name === 'runCommand' || first.name === 'adminCommand') {
      return isMongoRawCommandObjectMutating(first.argsText)
    }
    return true
  }

  let methodIdx = -1
  if (first.name === 'getCollection' && first.argsText !== null) {
    methodIdx = 1
  } else {
    if (first.argsText !== null) {
      return true
    }
    methodIdx = segments.findIndex((seg, idx) => idx >= 1 && seg.argsText !== null)
  }
  if (methodIdx < 1 || methodIdx >= segments.length) {
    return true
  }
  const primary = segments[methodIdx]
  const primaryArgs = primary.argsText
  if (primaryArgs === null) {
    return true
  }
  if (!MONGODB_READONLY_COLL_METHODS.has(primary.name)) {
    return true
  }
  if (primary.name === 'aggregate' && hasMongoWriteKeyInObjectText(primaryArgs)) {
    return true
  }

  for (let i = methodIdx + 1; i < segments.length; i++) {
    const chain = segments[i]
    if (chain.argsText === null || !MONGODB_READONLY_CURSOR_CHAIN_METHODS.has(chain.name)) {
      return true
    }
    if (chain.name === 'aggregate' && hasMongoWriteKeyInObjectText(chain.argsText)) {
      return true
    }
  }
  return false
}

function isMongoCommandMutating(raw: string): boolean {
  const stmts = splitMongoShellStatements(raw)
  if (stmts.length === 0) return false
  return stmts.some((stmt) => parseSingleMongoShellStatementMutating(stmt))
}

export const SQL_STANDALONE_ROLLBACK_RE = /^ROLLBACK\b(?!\s+(?:(?:TRANSACTION|WORK)\s+)?TO\b)/i

const MYSQL_IMPLICIT_COMMIT_RE =
  /^(?:(?:CREATE|DROP)\s+(?!TEMPORARY\s+TABLE\b)|ALTER\b|TRUNCATE\b|RENAME\b|LOCK\s+TABLES\b|UNLOCK\s+TABLES\b|LOAD\s+DATA\b|ANALYZE\b|OPTIMIZE\b|REPAIR\b|FLUSH\b|RESET\b|SET\s+(?:(?:SESSION|LOCAL)\s+)?(?:@@(?:SESSION\.|LOCAL\.)?)?AUTOCOMMIT\s*=\s*(?:1|ON|TRUE)\b)/i

const MYSQL_AUTOCOMMIT_OFF_RE =
  /^SET\s+(?:(?:SESSION|LOCAL)\s+)?(?:@@(?:SESSION\.|LOCAL\.)?)?AUTOCOMMIT\s*=\s*(?:0|OFF|FALSE)\b/i

export function isMysqlImplicitCommitStatement(sql: string): boolean {
  const clean = stripCommentsAndLiterals(sql, 'mysql', true).replace(/^[\s(]+/, '').trim()
  if (!clean) return false
  return MYSQL_IMPLICIT_COMMIT_RE.test(clean)
}

export function isMysqlAutoCommitOffStatement(sql: string): boolean {
  const clean = stripCommentsAndLiterals(sql, 'mysql', true).replace(/^[\s(]+/, '').trim()
  if (!clean) return false
  return MYSQL_AUTOCOMMIT_OFF_RE.test(clean)
}

/**
 * Checks whether a SQL script, Redis command sequence, or MongoDB command can mutate state or schema,
 * supporting read-only enforcement on connections flagged `readOnly: true`.
 */
export function isMutatingStatement(
  sql: string,
  driver: DatabaseDriverType | 'mongodb'
): boolean {
  if (!sql || !sql.trim()) return false
  if (driver === 'mongodb') {
    return isMongoCommandMutating(sql)
  }
  if (driver === 'redis') {
    return isRedisCommandMutating(sql)
  }
  if (driver === 'mssql') {
    return isMssqlReadOnlyBlocked(sql)
  }
  if (driver === 'oracle') {
    const chunks = splitOracleStatements(sql)
    if (chunks.length === 0) {
      return isSingleSqlStatementMutating(sql, driver)
    }
    return chunks.some(
      (chunk) => chunk.isPlSql || isSingleSqlStatementMutating(chunk.text, driver)
    )
  }
  const statements = splitSqlStatements(sql, driver)
  if (statements.length === 0) {
    return isSingleSqlStatementMutating(sql, driver)
  }
  return statements.some((stmt) => isSingleSqlStatementMutating(stmt.text, driver))
}

type CockroachViewTokenKind = 'word' | 'quoted' | 'string' | 'comment' | 'punct'

interface CockroachViewToken {
  kind: CockroachViewTokenKind
  text: string
  value: string
  start: number
  end: number
  upper: string
}

const COCKROACH_VIEW_CLAUSE_RESET: ReadonlySet<string> = new Set([
  'SELECT',
  'VALUES',
  'WHERE',
  'GROUP',
  'HAVING',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'FETCH',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'WINDOW',
  'QUALIFY',
  'RETURNING',
])

function tokenizeCockroachViewBody(body: string): {
  tokens: CockroachViewToken[]
  unbalanced: boolean
} {
  const tokens: CockroachViewToken[] = []
  const len = body.length
  let unbalanced = false
  let i = 0

  const push = (
    kind: CockroachViewTokenKind,
    start: number,
    end: number,
    value: string,
    upper = ''
  ): void => {
    tokens.push({ kind, text: body.slice(start, end), value, start, end, upper })
  }

  while (i < len) {
    const ch = body[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '-' && i + 1 < len && body[i + 1] === '-') {
      const end = scanLineCommentEnd(body, i)
      push('comment', i, end, '')
      i = end
      continue
    }
    if (ch === '/' && i + 1 < len && body[i + 1] === '*') {
      const end = scanBlockCommentEnd(body, i, true)
      const closed = end >= i + 2 && body[end - 2] === '*' && body[end - 1] === '/'
      if (!closed) unbalanced = true
      push('comment', i, end, '')
      i = end
      continue
    }
    if (isPostgresEscapeStringStart(body, i, 'cockroachdb')) {
      const seg = scanQuotedSegmentEnd(body, i + 1, "'", true)
      if (!seg.closed) unbalanced = true
      push('string', i, seg.end, '')
      i = seg.end
      continue
    }
    if (ch === "'") {
      const seg = scanQuotedSegmentEnd(body, i, "'", false)
      if (!seg.closed) unbalanced = true
      push('string', i, seg.end, '')
      i = seg.end
      continue
    }
    if (ch === '"') {
      const seg = scanQuotedSegmentEnd(body, i, '"', false)
      if (!seg.closed) unbalanced = true
      const value = body.slice(i + 1, seg.end - 1).replace(/""/g, '"')
      push('quoted', i, seg.end, value)
      i = seg.end
      continue
    }
    if (ch === '$') {
      const tag = matchDollarQuoteTag(body, i)
      if (tag !== null) {
        const closeIndex = body.indexOf(tag, i + tag.length)
        if (closeIndex < 0) unbalanced = true
        const end = closeIndex < 0 ? len : closeIndex + tag.length
        push('string', i, end, '')
        i = end
        continue
      }
    }
    if (isIdentStartChar(body.charCodeAt(i))) {
      let end = i + 1
      while (end < len) {
        const code = body.charCodeAt(end)
        if (!isIdentContChar(code) && code !== 36) break
        end++
      }
      const text = body.slice(i, end)
      push('word', i, end, text, text.toUpperCase())
      i = end
      continue
    }
    if (ch >= '0' && ch <= '9') {
      let end = i + 1
      while (end < len && body[end] >= '0' && body[end] <= '9') end++
      push('punct', i, end, '')
      i = end
      continue
    }
    push('punct', i, i + 1, '')
    i++
  }

  return { tokens, unbalanced }
}

export interface CockroachViewRewriteResult {
  body: string
  hasExternalDbReference: boolean
}

/**
 * Removes the leading source-database qualifier from relation references in a
 * CockroachDB view body while reporting whether external-database references remain.
 */
export function rewriteCockroachViewBodyWithMeta(
  body: string,
  sourceDatabase: string
): CockroachViewRewriteResult {
  if (!body || !sourceDatabase) {
    return { body, hasExternalDbReference: false }
  }

  const { tokens, unbalanced: lexUnbalanced } = tokenizeCockroachViewBody(body)
  interface Frame {
    query: boolean
    inFrom: boolean
    expectRelation: boolean
  }
  const frames: Frame[] = [{ query: true, inFrom: false, expectRelation: false }]
  const spans: Array<{ start: number; end: number }> = []
  let sawSourceRelation = false
  let hasExternalDbReference = false
  let unsafe = false
  let unbalanced = lexUnbalanced

  const nextSignificant = (from: number): number => {
    let index = from
    while (index < tokens.length && tokens[index].kind === 'comment') index++
    return index
  }
  const prevSignificant = (from: number): number => {
    let index = from
    while (index >= 0 && tokens[index].kind === 'comment') index--
    return index
  }
  const hasCommentBetween = (fromExclusive: number, toExclusive: number): boolean => {
    for (let index = fromExclusive + 1; index < toExclusive; index++) {
      if (tokens[index].kind === 'comment') return true
    }
    return false
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.kind === 'comment') continue
    const frame = frames[frames.length - 1]

    if (token.kind === 'punct' && token.text === '(') {
      const after = nextSignificant(i + 1)
      const next = after < tokens.length ? tokens[after] : undefined
      const isQuery =
        next !== undefined &&
        next.kind === 'word' &&
        (next.upper === 'SELECT' || next.upper === 'WITH' || next.upper === 'VALUES')
      const opensRelationGroup = frame.expectRelation && !isQuery
      if (frame.expectRelation) frame.expectRelation = false
      frames.push(
        opensRelationGroup
          ? { query: true, inFrom: true, expectRelation: true }
          : { query: isQuery, inFrom: false, expectRelation: false }
      )
      continue
    }

    if (token.kind === 'punct' && token.text === ')') {
      if (frames.length > 1) frames.pop()
      else unbalanced = true
      continue
    }

    if (frame.query && frame.expectRelation) {
      if (token.kind === 'word' && (token.upper === 'LATERAL' || token.upper === 'ONLY')) {
        continue
      }
      if (token.kind !== 'word' && token.kind !== 'quoted') {
        frame.expectRelation = false
        continue
      }

      const parts: CockroachViewToken[] = [token]
      let lastIndex = i
      let chainEndsWithDot = false
      let hasComment = false
      while (true) {
        const dotIndex = nextSignificant(lastIndex + 1)
        if (
          dotIndex >= tokens.length ||
          tokens[dotIndex].kind !== 'punct' ||
          tokens[dotIndex].text !== '.'
        ) {
          break
        }
        const partIndex = nextSignificant(dotIndex + 1)
        if (
          partIndex >= tokens.length ||
          (tokens[partIndex].kind !== 'word' && tokens[partIndex].kind !== 'quoted')
        ) {
          chainEndsWithDot = true
          lastIndex = dotIndex
          break
        }
        if (hasCommentBetween(lastIndex, partIndex)) hasComment = true
        parts.push(tokens[partIndex])
        lastIndex = partIndex
      }
      i = lastIndex

      const afterChain = nextSignificant(lastIndex + 1)
      const afterToken = afterChain < tokens.length ? tokens[afterChain] : undefined
      const isFunctionCall =
        afterToken !== undefined && afterToken.kind === 'punct' && afterToken.text === '('
      frame.expectRelation = false
      if (isFunctionCall) continue

      const dbIdent =
        parts[0].kind === 'word' ? parts[0].value.toLowerCase() : parts[0].value
      if (parts.length >= 3 && dbIdent === sourceDatabase) {
        sawSourceRelation = true
        if (parts.length > 3 || chainEndsWithDot || hasComment) {
          unsafe = true
        } else {
          spans.push({ start: parts[0].start, end: parts[1].start })
        }
      } else if (parts.length >= 3) {
        hasExternalDbReference = true
      }
      continue
    }

    if (!frame.query || token.kind !== 'word') {
      if (token.kind === 'punct' && token.text === ',' && frame.query && frame.inFrom) {
        frame.expectRelation = true
      }
      continue
    }

    const upper = token.upper
    if (upper === 'FROM') {
      const prev = prevSignificant(i - 1)
      const prevUpper = prev >= 0 ? tokens[prev].upper : ''
      if (prevUpper !== 'DISTINCT') {
        frame.inFrom = true
        frame.expectRelation = true
      }
      continue
    }
    if (upper === 'JOIN') {
      frame.inFrom = true
      frame.expectRelation = true
      continue
    }
    if (upper === 'ON' || upper === 'USING') {
      frame.expectRelation = false
      continue
    }
    if (COCKROACH_VIEW_CLAUSE_RESET.has(upper)) {
      frame.inFrom = false
      frame.expectRelation = false
    }
  }

  if (frames.length > 1) unbalanced = true
  if ((unsafe || unbalanced) && sawSourceRelation) {
    throw new Error(
      `CockroachDB view definition references database "${sourceDatabase}" but cannot be made portable.`
    )
  }
  if (spans.length === 0) return { body, hasExternalDbReference }

  spans.sort((a, b) => a.start - b.start)
  let result = ''
  let cursor = 0
  for (const span of spans) {
    result += body.slice(cursor, span.start)
    cursor = span.end
  }
  return { body: result + body.slice(cursor), hasExternalDbReference }
}

/**
 * Removes the leading source-database qualifier from relation references in a
 * CockroachDB view body while preserving every byte outside those qualifiers.
 */
export function rewriteCockroachViewBodyDatabaseQualifier(
  body: string,
  sourceDatabase: string
): string {
  return rewriteCockroachViewBodyWithMeta(body, sourceDatabase).body
}
