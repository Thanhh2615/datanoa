import type { DatabaseDriverType } from '../../protocol'
import { isMssqlReadOnlyBlocked } from './mssql-sql'
import { splitOracleStatements } from './oracle-sql'
import {
  DIALECT_LEXER_RULES,
  containsDdlStatement,
  findStatementAtOffset,
  formatSqlBinaryLiteral,
  formatSqlLiteral,
  getDialectLexerRules,
  isIdentContChar,
  isIdentStartChar,
  isPostgresEscapeStringStart,
  matchDollarQuoteTag,
  matchMysqlExecCommentPrefix,
  normalizeJsonValue,
  quoteIdentForDialect,
  quoteTableReference,
  scanBlockCommentEnd,
  scanBracketIdentEnd,
  scanLineCommentEnd,
  scanOracleQuoteEnd,
  scanQuotedSegmentEnd,
  splitSqlStatements,
  stripCommentsAndLiteralsDetailed,
  stripLeadingSqlComments,
  supportsBracketIdentifiers,
  supportsDollarQuoting,
  supportsNestedBlockComments,
  supportsSlashLineComments,
  usesBackslashAndHash,
  type DialectLexerRule,
  type SqlStatementSlice,
} from '../../shared-sql-core.js'
import { tokenizeRedisCommandLine } from '../../shared-sql-safety.js'

export {
  DIALECT_LEXER_RULES,
  containsDdlStatement,
  findStatementAtOffset,
  formatSqlBinaryLiteral,
  formatSqlLiteral,
  getDialectLexerRules,
  isIdentContChar,
  isIdentStartChar,
  isPostgresEscapeStringStart,
  matchDollarQuoteTag,
  matchMysqlExecCommentPrefix,
  normalizeJsonValue,
  quoteIdentForDialect,
  quoteTableReference,
  scanBlockCommentEnd,
  scanBracketIdentEnd,
  scanLineCommentEnd,
  scanOracleQuoteEnd,
  scanQuotedSegmentEnd,
  splitSqlStatements,
  stripCommentsAndLiteralsDetailed,
  stripLeadingSqlComments,
  supportsBracketIdentifiers,
  supportsDollarQuoting,
  supportsNestedBlockComments,
  supportsSlashLineComments,
  usesBackslashAndHash,
  type DialectLexerRule,
  type SqlStatementSlice,
}

/**
 * Strips SQL comments and string/dollar literals to spaces while preserving
 * quoted identifiers (including SQLite/MSSQL `[...]`) as neutral `x` placeholders so
 * `SELECT * INTO [dbo].[copy]` does not degenerate into `INTO  . `.
 */
export function stripCommentsAndLiterals(
  sql: string,
  dialect?: DatabaseDriverType,
  preserveMysqlExecComments = true
): string {
  return stripCommentsAndLiteralsDetailed(sql, dialect, {
    preserveMysqlExecComments,
    literalPlaceholder: ' ',
    identPlaceholder: ' x ',
  }).text
}

/** Collapses SQL to a single line and bounds its length for display previews. */
export function compactSql(sql: string, maxLength = 80): string {
  const compact = sql.replace(/\s+/g, ' ').trim()
  if (maxLength <= 0) return ''
  if (compact.length <= maxLength) return compact
  if (maxLength <= 3) return compact.slice(0, maxLength)
  return `${compact.slice(0, maxLength - 3)}...`
}

const LEADING_FILTER_KEYWORD_REGEX = /^(?:WHERE|ORDER\s+BY)\b\s*/i

/**
 * Normalizes a table WHERE or ORDER BY filter clause and rejects unquoted SQL statement breakouts
 * (`;`, `--`, `/*`, dialect-specific `#` / `//`, unbalanced parentheses, or unclosed quotes).
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

  const rules = getDialectLexerRules(dialect)
  const allowDollarQuotes = dialect === undefined || rules.dollarQuoting
  let i = 0
  let parenDepth = 0
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
    const oracleQuote = scanOracleQuoteEnd(trimmed, i, dialect)
    if (oracleQuote) {
      if (!oracleQuote.closed) {
        throw new Error("Invalid filter clause: unclosed q'...' quote literal.")
      }
      i = oracleQuote.end
      continue
    }
    if (ch === "'" || ch === '"' || (ch === '`' && rules.backtickIdentifiers)) {
      const allowBackslash =
        (ch === "'" && rules.backslashEscapesSingleQuote) ||
        (ch === '"' && rules.backslashEscapesDoubleQuote)
      const seg = scanQuotedSegmentEnd(trimmed, i, ch, allowBackslash)
      if (!seg.closed) {
        throw new Error(`Invalid filter clause: unclosed ${ch} quote literal.`)
      }
      i = seg.end
      continue
    }
    if (ch === '[' && rules.bracketIdentifiers !== 'none') {
      const seg = scanBracketIdentEnd(trimmed, i, rules.bracketIdentifiers === 'doubling')
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
    if (ch === '(') {
      parenDepth++
      i++
      continue
    }
    if (ch === ')') {
      parenDepth--
      if (parenDepth < 0) {
        throw new Error('Invalid filter clause: unbalanced closing parenthesis ).')
      }
      i++
      continue
    }
    if (ch === ';') {
      throw new Error('Invalid filter clause: unquoted semicolon (;) is not allowed.')
    }
    if (ch === '#' && rules.lineCommentHash) {
      throw new Error('Invalid filter clause: unquoted SQL comment (#) is not allowed.')
    }
    if (ch === '-' && i + 1 < len && trimmed[i + 1] === '-') {
      throw new Error('Invalid filter clause: unquoted SQL comment (--) is not allowed.')
    }
    if (ch === '/' && i + 1 < len && trimmed[i + 1] === '/' && rules.lineCommentSlash) {
      throw new Error('Invalid filter clause: unquoted SQL comment (//) is not allowed.')
    }
    if (ch === '/' && i + 1 < len && trimmed[i + 1] === '*') {
      throw new Error('Invalid filter clause: unquoted SQL block comment (/*) is not allowed.')
    }
    i++
  }

  if (parenDepth !== 0) {
    throw new Error('Invalid filter clause: unbalanced parentheses.')
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

/** Fail-closed read-only SQL top-level verb allowlist. Any verb outside this set is blocked on RO connections. */
const SQL_READONLY_VERBS: ReadonlySet<string> = new Set([
  'SELECT',
  'WITH',
  'VALUES',
  'TABLE',
  'SHOW',
  'DESCRIBE',
  'DESC',
  'EXPLAIN',
  'PRAGMA',
])

/** 16 read-only reporting pragmas allowed bare or with parens (never with `=`). */
const SQLITE_REPORTING_PRAGMAS: ReadonlySet<string> = new Set([
  'TABLE_INFO',
  'TABLE_XINFO',
  'TABLE_LIST',
  'INDEX_LIST',
  'INDEX_INFO',
  'INDEX_XINFO',
  'FOREIGN_KEY_LIST',
  'FOREIGN_KEY_CHECK',
  'DATABASE_LIST',
  'COLLATION_LIST',
  'FUNCTION_LIST',
  'MODULE_LIST',
  'PRAGMA_LIST',
  'COMPILE_OPTIONS',
  'INTEGRITY_CHECK',
  'QUICK_CHECK',
  'COLLATE',
])

/** Read-only SQLite metadata getter pragmas allowed ONLY bare (no `=` and no `(...)`). */
const SQLITE_READONLY_BARE_GETTER_PRAGMAS: ReadonlySet<string> = new Set([
  'USER_VERSION',
  'SCHEMA_VERSION',
  'DATA_VERSION',
  'APPLICATION_ID',
  'PAGE_COUNT',
  'PAGE_SIZE',
  'FREELIST_COUNT',
  'ENCODING',
  'FOREIGN_KEYS',
  'JOURNAL_MODE',
  'CACHE_SIZE',
  'SYNCHRONOUS',
  'AUTO_VACUUM',
  'TEMP_STORE',
  'LOCKING_MODE',
  'READ_UNCOMMITTED',
  'BUSY_TIMEOUT',
  'MAX_PAGE_COUNT',
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
  'ROLE',
])

const REDIS_READONLY_MEMORY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'USAGE',
  'STATS',
  'DOCTOR',
  'MALLOC-STATS',
  'HELP',
])

const REDIS_READONLY_OBJECT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'ENCODING',
  'FREQ',
  'IDLETIME',
  'REFCOUNT',
  'HELP',
])

const REDIS_READONLY_COMMAND_SUBCOMMANDS: ReadonlySet<string> = new Set([
  '',
  'COUNT',
  'DOCS',
  'GETKEYS',
  'GETKEYSANDFLAGS',
  'INFO',
  'LIST',
  'HELP',
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
  hasOraclePlanWrite: boolean
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

function parseExplainOptions(
  afterExplain: string,
  dialect?: DatabaseDriverType
): ParsedExplainInfo {
  let rest = afterExplain.trimStart()
  let hasAnalyze = false
  let hasWriteOption = false
  let hasOraclePlanWrite = false
  let allowParenOptions = true

  while (rest.length > 0) {
    if (allowParenOptions && rest.startsWith('(')) {
      const closeIdx = findMatchingParenIndex(rest, 0)
      if (closeIdx < 0) {
        hasWriteOption = true
        break
      }
      const groupContent = rest.slice(1, closeIdx)
      const analyzeRe = /\bANALY[ZS]E\b(?:\s+(FALSE|OFF|0)\b)?/gi
      let analyzeMatch: RegExpExecArray | null
      while ((analyzeMatch = analyzeRe.exec(groupContent)) !== null) {
        if (!analyzeMatch[1]) {
          hasAnalyze = true
        }
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
      /^(?:VERBOSE|QUERY\s+PLAN|EXTENDED|PARTITIONS|DISTSQL|OPT|TYPES|VEC|AST|SYNTAX|PLAN|PIPELINE|ESTIMATE|TABLE\s+OVERRIDE|CURRENT\s+TRANSACTION|FOR\s+CONNECTION\s+\d+|FORMAT\s*=\s*(?:''|[A-Za-z0-9_]+)|FORMAT\s+(?:''|[A-Za-z0-9_]+))/i.exec(
        rest
      )
    if (stdOpt) {
      allowParenOptions = false
      rest = rest.slice(stdOpt[0].length).trimStart()
      continue
    }

    // Oracle EXPLAIN PLAN [SET STATEMENT_ID = ...] [INTO [schema.]table[@dblink]] FOR <stmt>
    const oracleSetOpt =
      /^SET\s+STATEMENT_ID\s*=\s*(?:''|[A-Za-z0-9_]+)?(?=\s*(?:\bINTO\b|\bFOR\b))/i.exec(rest)
    if (oracleSetOpt) {
      allowParenOptions = false
      rest = rest.slice(oracleSetOpt[0].length).trimStart()
      continue
    }

    const oracleIntoOpt = /^INTO\s+(?!OUTFILE\b|DUMPFILE\b)[\s\S]*?(?=\bFOR\b)/i.exec(rest)
    if (oracleIntoOpt) {
      hasOraclePlanWrite = true
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

    // ClickHouse EXPLAIN PLAN settings e.g. `header = 1, actions = 1` or `format = ''`
    const chSettingOpt =
      /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:''|[A-Za-z0-9_]+)\s*,?/i.exec(rest)
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

  return { hasAnalyze, hasWriteOption, hasOraclePlanWrite, remainder: rest }
}

function stripForReadOnlyAnalysis(
  sql: string,
  dialect?: DatabaseDriverType,
  backslashOverride?: boolean
): { text: string; hasUnclosedQuote: boolean; hasUnclosedComment: boolean } {
  return stripCommentsAndLiteralsDetailed(sql, dialect, {
    preserveMysqlExecComments: true,
    literalPlaceholder: " '' ",
    identPlaceholder: ' x ',
    backslashOverride,
  })
}

/**
 * Checks whether an EXPLAIN statement enables ANALYZE/ANALYSE execution (US or British spelling,
 * bare or inside PostgreSQL parenthesized option lists, including repeated ANALYZE flags).
 */
export function hasExplainAnalyzeOption(sql: string, dialect?: DatabaseDriverType): boolean {
  const clean = stripForReadOnlyAnalysis(sql, dialect).text.replace(/^[\s(]+/, '').trim()
  const firstMatch = /^EXPLAIN\b/i.exec(clean)
  if (!firstMatch) return false
  return parseExplainOptions(clean.slice(firstMatch[0].length), dialect).hasAnalyze
}

/**
 * Checks whether the statement wrapped inside an EXPLAIN (or the statement itself if not prefixed
 * with EXPLAIN) is mutating, independent of whether ANALYZE was specified.
 */
export function isExplainTargetMutating(sql: string, dialect?: DatabaseDriverType): boolean {
  const detail = stripForReadOnlyAnalysis(sql, dialect)
  if (detail.hasUnclosedQuote || detail.hasUnclosedComment) return true
  const clean = detail.text.replace(/^[\s(]+/, '').trim()
  if (!clean) return false
  const firstMatch = /^EXPLAIN\b/i.exec(clean)
  if (!firstMatch) {
    return isCleanSingleStatementMutating(clean, false, dialect)
  }
  const parsed = parseExplainOptions(clean.slice(firstMatch[0].length), dialect)
  if (parsed.hasWriteOption) return true
  return isCleanSingleStatementMutating(parsed.remainder, false, dialect)
}

const SQL_READONLY_FOLLOWING_WITH_VERBS: ReadonlySet<string> = new Set([
  'SELECT',
  'VALUES',
  'TABLE',
  'SHOW',
  'DESCRIBE',
  'DESC',
])

const SQL_OUTSIDE_REACH_AND_STATEFUL_FN_RE =
  /\b(?:nextval|setval|set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_create_restore_point|pg_create_logical_replication_slot|pg_create_physical_replication_slot|pg_drop_replication_slot|pg_advisory_lock|pg_advisory_xact_lock|pg_try_advisory_lock|pg_advisory_unlock|pg_advisory_unlock_all|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_ls_logdir|pg_ls_waldir|pg_ls_tmpdir|lo_unlink|lo_import|lo_export|lo_create|lo_creat|lo_open|lo_put|lo_from_bytea|dblink|dblink_exec|dblink_connect|dblink_send_query|load_file|load_extension|sqlite_load_extension)\s*\(/i

const CLICKHOUSE_OUTSIDE_REACH_FN_RE =
  /\b(?:file|url|s3|s3Cluster|hdfs|odbc|jdbc|mysql|postgresql|remote|remoteSecure|input)\s*\(/i

function isSelectStatementMutating(clean: string, dialect?: DatabaseDriverType): boolean {
  if (/\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(clean)) return true
  // Unquoted INTO in SELECT is either SELECT ... INTO (before OR after FROM, including UNION branches)
  if (/\bINTO\b/i.test(clean)) return true
  if (/\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/i.test(clean)) return true
  if (/\bNEXT\s+VALUE\s+FOR\b/i.test(clean)) return true
  if (SQL_OUTSIDE_REACH_AND_STATEFUL_FN_RE.test(clean)) return true
  if (dialect === 'clickhouse' && CLICKHOUSE_OUTSIDE_REACH_FN_RE.test(clean)) return true
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
  failClosedOnUnknown = false,
  dialect?: DatabaseDriverType
): boolean {
  const clean = rawClean.trim()
  if (!clean) return failClosedOnUnknown

  if (clean.startsWith('(')) {
    const closeIdx = findMatchingParenIndex(clean, 0)
    if (closeIdx < 0) return true
    const inner = clean.slice(1, closeIdx).trim()
    if (!inner || isCleanSingleStatementMutating(inner, failClosedOnUnknown, dialect)) return true

    const after = clean.slice(closeIdx + 1).trim()
    if (!after) return false
    if (
      /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(after) ||
      /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/i.test(after)
    ) {
      return true
    }
    const setOpMatch =
      /^(?:UNION(?:\s+(?:ALL|DISTINCT))?|INTERSECT(?:\s+(?:ALL|DISTINCT))?|EXCEPT(?:\s+(?:ALL|DISTINCT))?|MINUS)\b\s*/i.exec(
        after
      )
    if (setOpMatch) {
      const afterSetOp = after.slice(setOpMatch[0].length).trim()
      return !afterSetOp || isCleanSingleStatementMutating(afterSetOp, failClosedOnUnknown, dialect)
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
  if (!SQL_READONLY_VERBS.has(verb)) {
    return true
  }
  if (verb === 'SHOW' || verb === 'DESCRIBE' || verb === 'DESC') {
    return /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(clean)
  }
  if (verb === 'VALUES' || verb === 'TABLE') {
    return (
      /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(clean) ||
      /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/i.test(clean) ||
      /\bNEXT\s+VALUE\s+FOR\b/i.test(clean) ||
      SQL_OUTSIDE_REACH_AND_STATEFUL_FN_RE.test(clean)
    )
  }
  if (verb === 'SELECT') {
    return isSelectStatementMutating(clean, dialect)
  }
  if (verb === 'PRAGMA') {
    if (clean.includes('=')) {
      return true
    }
    const pragmaMatch =
      /^PRAGMA\s+(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)(\s*\([\s\S]*\))?\s*$/i.exec(
        clean
      )
    if (!pragmaMatch) {
      return true
    }
    const pragmaName = pragmaMatch[1].toUpperCase()
    const hasParens = Boolean(pragmaMatch[2])
    if (SQLITE_REPORTING_PRAGMAS.has(pragmaName)) {
      return false
    }
    if (!hasParens && SQLITE_READONLY_BARE_GETTER_PRAGMAS.has(pragmaName)) {
      return false
    }
    return true
  }
  if (verb === 'EXPLAIN') {
    const parsed = parseExplainOptions(clean.slice(firstMatch[0].length), dialect)
    if (parsed.hasAnalyze || parsed.hasWriteOption || parsed.hasOraclePlanWrite) {
      return true
    }
    return isCleanSingleStatementMutating(parsed.remainder, failClosedOnUnknown, dialect)
  }
  if (verb === 'WITH') {
    if (SQL_CTE_MUTATING_REGEX.test(clean) || /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(clean)) {
      return true
    }
    const parsedWith = parseWithCteStatement(clean)
    if (!parsedWith) {
      return true
    }
    if (parsedWith.cteBodies.some((body) => isCleanSingleStatementMutating(body, false, dialect))) {
      return true
    }
    return isCleanSingleStatementMutating(parsedWith.remainder, true, dialect)
  }
  return true
}

function isSingleSqlStatementMutating(stmtText: string, dialect?: DatabaseDriverType): boolean {
  const rules = getDialectLexerRules(dialect)
  const modes: Array<boolean | undefined> = rules.backslashEscapesSingleQuote
    ? [false, true]
    : [undefined]
  for (const bsMode of modes) {
    const detail = stripForReadOnlyAnalysis(stmtText, dialect, bsMode)
    if (detail.hasUnclosedQuote || detail.hasUnclosedComment) {
      return true
    }
    const parts = detail.text.includes(';') ? detail.text.split(';') : [detail.text]
    if (parts.some((part) => isCleanSingleStatementMutating(part, false, dialect))) {
      return true
    }
  }
  return false
}

function isRedisCommandMutating(script: string): boolean {
  const lines = script.split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('--') || line.startsWith('//')) {
      continue
    }
    let tokens: string[]
    try {
      tokens = tokenizeRedisCommandLine(line, { strict: true })
    } catch {
      return true
    }
    if (tokens.length === 0) continue
    const cmd = tokens[0].toUpperCase()
    const sub = (tokens[1] ?? '').toUpperCase()

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
    if (cmd === 'MEMORY') {
      if (!REDIS_READONLY_MEMORY_SUBCOMMANDS.has(sub)) return true
      continue
    }
    if (cmd === 'OBJECT') {
      if (!REDIS_READONLY_OBJECT_SUBCOMMANDS.has(sub)) return true
      continue
    }
    if (cmd === 'COMMAND') {
      if (!REDIS_READONLY_COMMAND_SUBCOMMANDS.has(sub)) return true
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

function skipMongoJsString(
  text: string,
  start: number
): { end: number; value: string; closed: boolean } {
  const quote = text[start]
  let i = start + 1
  let value = ''
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      if (i + 1 >= text.length) {
        return { end: text.length, value, closed: false }
      }
      const next = text[i + 1]
      if (next === 'u') {
        if (text[i + 2] === '{') {
          const closeBrace = text.indexOf('}', i + 3)
          const hex = closeBrace > i + 3 ? text.slice(i + 3, closeBrace) : ''
          if (/^[0-9a-fA-F]{1,6}$/.test(hex)) {
            const cp = parseInt(hex, 16)
            if (cp <= 0x10ffff) {
              value += String.fromCodePoint(cp)
              i = closeBrace + 1
              continue
            }
          }
        } else if (i + 5 < text.length && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
          value += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16))
          i += 6
          continue
        }
      } else if (next === 'x' && i + 3 < text.length && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 2, i + 4))) {
        value += String.fromCharCode(parseInt(text.slice(i + 2, i + 4), 16))
        i += 4
        continue
      } else if (next === 'n') {
        value += '\n'
        i += 2
        continue
      } else if (next === 'r') {
        value += '\r'
        i += 2
        continue
      } else if (next === 't') {
        value += '\t'
        i += 2
        continue
      }
      value += next
      i += 2
      continue
    }
    if (ch === quote) {
      return { end: i + 1, value, closed: true }
    }
    value += ch
    i++
  }
  return { end: text.length, value, closed: false }
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
      if (!seg.closed) return true
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
    if (ch === '\\' && text[i + 1] === 'u') {
      return true
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
    if (!seg.closed) return null
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
    const cmdKey = keys[0]
    const cmd = cmdKey.toLowerCase()
    if (cmd === 'aggregate') return hasMongoPipelineWriteStage(rec)
    if (cmd === 'explain') {
      const explainVal = rec[cmdKey]
      if (hasMongoPipelineWriteStage(explainVal)) return true
      if (explainVal && typeof explainVal === 'object' && !Array.isArray(explainVal)) {
        const innerKeys = Object.keys(explainVal as Record<string, unknown>)
        if (innerKeys.length === 0 || !MONGODB_READONLY_COMMANDS.has(innerKeys[0].toLowerCase())) {
          return true
        }
        return false
      }
      return true
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
      const sourceMatch =
        parts[0].kind === 'word'
          ? dbIdent === sourceDatabase.toLowerCase()
          : dbIdent === sourceDatabase
      if (parts.length >= 3 && sourceMatch) {
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
