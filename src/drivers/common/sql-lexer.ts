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

/** Collapses SQL to a single line and bounds its length for display previews. */
export function compactSql(sql: string, maxLength = 80): string {
  const compact = sql.replace(/\s+/g, ' ').trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact
}

function usesMysqlExecutableComments(dialect?: DatabaseDriverType): boolean {
  return dialect !== undefined && MYSQL_FAMILY_DIALECTS.has(dialect)
}

export function supportsNestedBlockComments(dialect?: DatabaseDriverType): boolean {
  return dialect === 'postgres' || dialect === 'cockroachdb'
}

export function supportsDollarQuoting(dialect?: DatabaseDriverType): boolean {
  return dialect === 'postgres' || dialect === 'cockroachdb'
}

export function matchMysqlExecCommentPrefix(
  sql: string,
  index: number,
  dialect?: DatabaseDriverType
): number {
  if (!usesMysqlExecutableComments(dialect)) return 0
  if (sql[index] !== '/' || sql[index + 1] !== '*') return 0
  let cursor = -1
  if (sql[index + 2] === '!') {
    cursor = index + 3
  } else if (dialect === 'mariadb' && (sql[index + 2] === 'M' || sql[index + 2] === 'm') && sql[index + 3] === '!') {
    cursor = index + 4
  } else {
    return 0
  }
  while (cursor < sql.length && sql[cursor] >= '0' && sql[cursor] <= '9') {
    cursor++
  }
  return cursor - index
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
  if (
    raw.includes('\0') &&
    (dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1')
  ) {
    const parts = raw.split('\0').map((seg) => `'${seg.replace(/'/g, "''")}'`)
    return parts.join(' || char(0) || ')
  }
  let escaped = raw
  if (BACKTICK_DIALECTS.has(dialect)) {
    escaped = escaped.replace(/\\/g, '\\\\').replace(/\0/g, '\\0')
  }
  escaped = escaped.replace(/'/g, "''")
  return `'${escaped}'`
}

export function formatSqlBinaryLiteral(hex: string, dialect: DatabaseDriverType): string {
  if (dialect === 'postgres' || dialect === 'cockroachdb') {
    return `E'\\\\x${hex}'::bytea`
  }
  if (dialect === 'clickhouse') {
    return `unhex('${hex}')`
  }
  return `X'${hex}'`
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
    return formatSqlBinaryLiteral(hex, dialect)
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
  if (index > 0 && isIdentContChar(sql.charCodeAt(index - 1))) return null
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

export function scanBlockCommentEnd(sql: string, start: number, nested = true): number {
  let i = start + 2
  let depth = 1
  const len = sql.length
  while (i < len && depth > 0) {
    if (nested && sql[i] === '/' && i + 1 < len && sql[i + 1] === '*') {
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

const COMPOUND_CREATE_TARGETS: ReadonlySet<string> = new Set([
  'TRIGGER',
  'PROCEDURE',
  'FUNCTION',
  'EVENT',
])

const COMPOUND_END_SUFFIX_WORDS: ReadonlySet<string> = new Set([
  'IF',
  'LOOP',
  'WHILE',
  'REPEAT',
  'CASE',
])

const NON_TRANSACTION_BEGIN_FOLLOWERS: ReadonlySet<string> = new Set([
  ';',
  'TRANSACTION',
  'TRAN',
  'WORK',
  'DEFERRED',
  'IMMEDIATE',
  'EXCLUSIVE',
  'CONCURRENT',
  'ATOMIC',
  'READ',
  'WRITE',
  'ISOLATION',
])

/**
 * Splits a SQL script into executable statements, preserving source offsets and ignoring
 * semicolons inside quotes, compound trigger/routine BEGIN..END blocks, MySQL DELIMITER blocks,
 * PG dollar-quoted blocks, and comments.
 */
export function splitSqlStatements(
  script: string,
  dialect?: DatabaseDriverType
): SqlStatementSlice[] {
  const results: SqlStatementSlice[] = []
  const len = script.length
  const backslashAndHash = usesBackslashAndHash(dialect)
  const nestedComments = supportsNestedBlockComments(dialect)
  const dollarQuotes = supportsDollarQuoting(dialect)
  const allowMysqlDelimiter = dialect !== undefined && MYSQL_FAMILY_DIALECTS.has(dialect)
  const supportsCompoundRoutineBegin =
    dialect === 'sqlite' ||
    dialect === 'libsql' ||
    dialect === 'd1' ||
    dialect === 'mysql' ||
    dialect === 'mariadb'

  let segStart = 0
  let hasExecutableToken = false
  let delimiter = ';'
  let execCommentDepth = 0
  let i = 0

  // State per active statement for CREATE TRIGGER/PROCEDURE/FUNCTION/EVENT ... BEGIN ... END
  let stmtHeaderWords: string[] = []
  let isCompoundHeader = false
  let compoundDepth = 0
  let caseDepth = 0
  let prevWordUpper = ''

  const resetStatementState = (): void => {
    stmtHeaderWords = []
    isCompoundHeader = false
    compoundDepth = 0
    caseDepth = 0
    prevWordUpper = ''
  }

  const flushSegment = (rawEnd: number, delimLen: number): void => {
    if (hasExecutableToken) {
      const { start, end } = trimSliceBounds(script, segStart, rawEnd)
      if (end > start) {
        results.push({ text: script.slice(start, end), start, end })
      }
    }
    segStart = rawEnd + delimLen
    hasExecutableToken = false
    resetStatementState()
  }

  const peekNextUpperWord = (fromIdx: number): string => {
    let k = fromIdx
    while (k < len && /\s/.test(script[k])) k++
    if (k >= len) return ''
    if (script[k] === ';') return ';'
    if (!isIdentStartChar(script.charCodeAt(k))) return ''
    let end = k + 1
    while (end < len && isIdentContChar(script.charCodeAt(end))) end++
    return script.slice(k, end).toUpperCase()
  }

  while (i < len) {
    // Check MySQL DELIMITER directive when at the start of a statement (no tokens yet)
    if (allowMysqlDelimiter && !hasExecutableToken) {
      const atLineStart = i === 0 || script[i - 1] === '\n' || script[i - 1] === '\r'
      if (atLineStart) {
        let wsEnd = i
        while (wsEnd < len && (script[wsEnd] === ' ' || script[wsEnd] === '\t')) wsEnd++
        const delimMatch = /^DELIMITER\s+([^\s\r\n]+)[ \t]*(?:\r?\n|$)/i.exec(script.slice(wsEnd))
        if (delimMatch && delimMatch[1]) {
          delimiter = delimMatch[1]
          i = wsEnd + delimMatch[0].length
          segStart = i
          resetStatementState()
          continue
        }
      }
    }

    // Check custom or default delimiter before scanning single chars when not inside compound block
    if (delimiter.length > 0 && compoundDepth === 0 && execCommentDepth === 0) {
      if (script.startsWith(delimiter, i)) {
        if (delimiter === ';' || !isIdentContChar(script.charCodeAt(i))) {
          flushSegment(i, delimiter.length)
          i += delimiter.length
          continue
        }
      }
    }

    const ch = script[i]
    if (ch === '-' && i + 1 < len && script[i + 1] === '-') {
      i = scanLineCommentEnd(script, i)
      continue
    }
    if (ch === '#' && backslashAndHash) {
      i = scanLineCommentEnd(script, i - 1)
      continue
    }
    if (execCommentDepth > 0 && ch === '*' && i + 1 < len && script[i + 1] === '/') {
      execCommentDepth--
      i += 2
      continue
    }
    if (ch === '/' && i + 1 < len && script[i + 1] === '*') {
      const execLen = matchMysqlExecCommentPrefix(script, i, dialect)
      if (execLen > 0) {
        hasExecutableToken = true
        execCommentDepth++
        i += execLen
        continue
      }
      i = scanBlockCommentEnd(script, i, nestedComments)
      continue
    }
    if (isPostgresEscapeStringStart(script, i, dialect)) {
      hasExecutableToken = true
      i = scanQuotedSegmentEnd(script, i + 1, "'", true).end
      prevWordUpper = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      hasExecutableToken = true
      const allowBackslash = ch === "'" && backslashAndHash
      i = scanQuotedSegmentEnd(script, i, ch, allowBackslash).end
      prevWordUpper = ''
      continue
    }
    if (dollarQuotes && ch === '$') {
      const tag = matchDollarQuoteTag(script, i)
      if (tag !== null) {
        hasExecutableToken = true
        const closeIdx = script.indexOf(tag, i + tag.length)
        i = closeIdx >= 0 ? closeIdx + tag.length : len
        prevWordUpper = ''
        continue
      }
    }

    if (delimiter !== ';' && script.startsWith(delimiter, i) && compoundDepth === 0 && execCommentDepth === 0) {
      flushSegment(i, delimiter.length)
      i += delimiter.length
      continue
    }

    if (ch === ';' && delimiter === ';' && compoundDepth === 0 && execCommentDepth === 0) {
      flushSegment(i, 1)
      i++
      continue
    }

    if (isIdentStartChar(script.charCodeAt(i))) {
      hasExecutableToken = true
      let end = i + 1
      while (end < len && isIdentContChar(script.charCodeAt(end))) end++
      const wordUpper = script.slice(i, end).toUpperCase()

      if (stmtHeaderWords.length < 10) {
        stmtHeaderWords.push(wordUpper)
        if (
          supportsCompoundRoutineBegin &&
          !isCompoundHeader &&
          stmtHeaderWords[0] === 'CREATE' &&
          COMPOUND_CREATE_TARGETS.has(wordUpper)
        ) {
          isCompoundHeader = true
        }
      }

      if (isCompoundHeader && delimiter === ';') {
        if (wordUpper === 'BEGIN') {
          const nextWord = peekNextUpperWord(end)
          if (!NON_TRANSACTION_BEGIN_FOLLOWERS.has(nextWord)) {
            compoundDepth++
          }
        } else if (wordUpper === 'CASE' && prevWordUpper !== 'END') {
          caseDepth++
        } else if (wordUpper === 'END') {
          const nextWord = peekNextUpperWord(end)
          if (COMPOUND_END_SUFFIX_WORDS.has(nextWord)) {
            if (nextWord === 'CASE' && caseDepth > 0) {
              caseDepth--
            }
          } else if (caseDepth > 0 && compoundDepth === 0) {
            caseDepth--
          } else if (caseDepth > 0 && nextWord !== ';') {
            caseDepth--
          } else if (compoundDepth > 0) {
            compoundDepth--
          }
        }
      }

      prevWordUpper = wordUpper
      i = end
      continue
    }

    if (!/\s/.test(ch)) {
      hasExecutableToken = true
      prevWordUpper = ''
    }
    i++
  }

  if (segStart < len) {
    flushSegment(len, 0)
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
  const nestedComments = supportsNestedBlockComments(dialect)
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
      if (matchMysqlExecCommentPrefix(sql, i, dialect) > 0) {
        break
      }
      i = scanBlockCommentEnd(sql, i, nestedComments)
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
    if (ch === "'" || ch === '"' || ch === '`') {
      out += ' '
      const allowBackslash = ch === "'" && backslashAndHash
      i = scanQuotedSegmentEnd(sql, i, ch, allowBackslash).end
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
    if (/\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(clean)) return true
    if (/\bINTO\s+(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?(?:TABLE\s+)?[A-Za-z_"]/i.test(clean)) {
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
      if (token.kind === 'punct' && token.text === '(') {
        frame.expectRelation = false
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
    if (span.start < cursor) continue
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
