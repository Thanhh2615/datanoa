/**
 * Pure dialect-aware SQL lexing, quoting, statement splitting, DDL detection,
 * and type/default expression validation shared by Worker/Studio (.ts) and
 * native-ESM Side Panel (.js) modules.
 */

const BACKTICK_DIALECTS = new Set(['mysql', 'mariadb', 'clickhouse'])

const MYSQL_FAMILY_DIALECTS = new Set(['mysql', 'mariadb'])

const POSTGRES_FAMILY_DIALECTS = new Set(['postgres', 'cockroachdb'])

export function usesBackslashAndHash(dialect) {
  return dialect !== undefined && BACKTICK_DIALECTS.has(dialect)
}

function usesMysqlExecutableComments(dialect) {
  return dialect !== undefined && MYSQL_FAMILY_DIALECTS.has(dialect)
}

export function supportsNestedBlockComments(dialect) {
  return dialect === 'postgres' || dialect === 'cockroachdb'
}

export function supportsDollarQuoting(dialect) {
  return dialect === 'postgres' || dialect === 'cockroachdb'
}

export function matchMysqlExecCommentPrefix(sql, index, dialect) {
  if (!usesMysqlExecutableComments(dialect)) return 0
  if (sql[index] !== '/' || sql[index + 1] !== '*') return 0
  let cursor = -1
  if (sql[index + 2] === '!') {
    cursor = index + 3
  } else if (
    dialect === 'mariadb' &&
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

export function isPostgresEscapeStringStart(sql, index, dialect) {
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
export function quoteIdentForDialect(ident, dialect) {
  const raw = String(ident)
  if (BACKTICK_DIALECTS.has(dialect)) {
    return `\`${raw.replace(/`/g, '``')}\``
  }
  return `"${raw.replace(/"/g, '""')}"`
}

function tryParseQuotedTableParts(trimmed) {
  const quoteChar = trimmed[0]
  if (quoteChar !== '"' && quoteChar !== '`') return null
  const parts = []
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

export function quoteTableReference(tableName, dialect) {
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

export function normalizeJsonValue(value) {
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
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined && typeof v !== 'function' && typeof v !== 'symbol') {
        out[k] = normalizeJsonValue(v)
      }
    }
    return out
  }
  return null
}

function formatSqlStringLiteral(raw, dialect) {
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

export function formatSqlBinaryLiteral(hex, dialect) {
  if (dialect === 'postgres' || dialect === 'cockroachdb') {
    return `E'\\\\x${hex}'::bytea`
  }
  if (dialect === 'clickhouse') {
    return `unhex('${hex}')`
  }
  return `X'${hex}'`
}

export function formatSqlLiteral(value, dialect) {
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

export function isIdentStartChar(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
}

export function isIdentContChar(code) {
  return isIdentStartChar(code) || (code >= 48 && code <= 57)
}

export function matchDollarQuoteTag(sql, index) {
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

export function scanQuotedSegmentEnd(sql, start, quoteChar, allowBackslashEscape) {
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

export function scanLineCommentEnd(sql, start) {
  let i = start + 2
  const len = sql.length
  while (i < len && sql[i] !== '\n') {
    i++
  }
  return i < len ? i + 1 : len
}

export function scanBlockCommentEnd(sql, start, nested = true) {
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

function trimSliceBounds(script, rawStart, rawEnd) {
  let start = rawStart
  let end = rawEnd
  while (start < end && /\s/.test(script[start])) start++
  while (end > start && /\s/.test(script[end - 1])) end--
  return { start, end }
}

const COMPOUND_CREATE_TARGETS = new Set([
  'TRIGGER',
  'PROCEDURE',
  'FUNCTION',
  'EVENT',
])

const COMPOUND_END_SUFFIX_WORDS = new Set([
  'IF',
  'LOOP',
  'WHILE',
  'REPEAT',
  'CASE',
])

const NON_TRANSACTION_BEGIN_FOLLOWERS = new Set([
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
export function splitSqlStatements(script, dialect) {
  const results = []
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

  let stmtHeaderWords = []
  let isCompoundHeader = false
  let compoundDepth = 0
  let caseDepth = 0
  let prevWordUpper = ''

  const resetStatementState = () => {
    stmtHeaderWords = []
    isCompoundHeader = false
    compoundDepth = 0
    caseDepth = 0
    prevWordUpper = ''
  }

  const flushSegment = (rawEnd, delimLen) => {
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

  const peekNextUpperWord = (fromIdx) => {
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
export function findStatementAtOffset(script, offset, dialect) {
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

/**
 * Strips leading SQL comments while stopping before MySQL executable comments (`/*!50001 ...`).
 */
export function stripLeadingSqlComments(sql, dialect) {
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

export function stripCommentsAndLiterals(sql, dialect, preserveMysqlExecComments = true) {
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

const SQL_DDL_VERBS = new Set([
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
export function containsDdlStatement(sql, dialect) {
  if (!sql || !sql.trim() || dialect === 'redis') return false
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

export const KNOWN_SQL_DEFAULT_KEYWORDS =
  /^(?:CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|LOCALTIME|LOCALTIMESTAMP|NOW\(\)|UUID\(\)|GEN_RANDOM_UUID\(\)|UUID_GENERATE_V1\(\)|UUID_GENERATE_V4\(\)|NEWID\(\)|UNIXEPOCH\(\)|NEXTVAL\([^;]+\)|CURRVAL\([^;]+\)|ARRAY\[[^;]*\]|DATETIME\([^;]+\)|DATE\([^;]+\)|TIME\([^;]+\)|STRFTIME\([^;]+\)|COALESCE\([^;]+\)|RANDOMBLOB\([^;]+\)|HEX\([^;]+\))$/i

export const FORBIDDEN_DEFAULT_TOKENS = /[;\r\n\0]|--|\/\*|\*\//
export const FORBIDDEN_SUBQUERY_VERBS =
  /\b(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|UNION|EXEC)\b/i

export function findTopLevelPostgresCastIndex(input) {
  let depth = 0
  let inSingle = false
  let inDouble = false
  let lastCastIdx = -1
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === "'" && !inDouble) {
      if (inSingle && input[i + 1] === "'") {
        i++
        continue
      }
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      if (inDouble && input[i + 1] === '"') {
        i++
        continue
      }
      inDouble = !inDouble
      continue
    }
    if (inSingle || inDouble) continue
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') {
      if (depth > 0) depth--
    } else if (depth === 0 && ch === ':' && input[i + 1] === ':') {
      lastCastIdx = i
      i++
    }
  }
  return lastCastIdx
}

export function hasBalancedParens(input, singleOuterGroupOnly = false) {
  let depth = 0
  let inSingle = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === "'") {
      if (inSingle && input[i + 1] === "'") {
        i++
        continue
      }
      inSingle = !inSingle
      continue
    }
    if (inSingle) continue
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth < 0) return false
      if (singleOuterGroupOnly && depth === 0 && i < input.length - 1) {
        return false
      }
    }
  }
  return !inSingle && depth === 0
}

function isPureSqlStringLiteral(val) {
  return /^'(?:[^']|'')*'$/.test(val)
}

export function isNumericOrBooleanTypeName(dataType) {
  return /^(?:INT|BIGINT|SMALLINT|TINYINT|MEDIUMINT|SERIAL|BIGSERIAL|REAL|FLOAT|DOUBLE|DEC|NUMERIC|BOOL|BIT)/i.test(
    (dataType || '').trim()
  )
}

export function normalizeSqlDefaultExpression(rawDefault, dataType = 'TEXT') {
  const trimmed = (rawDefault ?? '').trim()
  if (!trimmed) return ''

  if (FORBIDDEN_DEFAULT_TOKENS.test(trimmed)) {
    throw new Error('Default value contains invalid SQL tokens (semicolons or comments).')
  }

  if (isPureSqlStringLiteral(trimmed)) {
    if (isNumericOrBooleanTypeName(dataType)) {
      const inner = trimmed.slice(1, -1).replace(/''/g, "'").trim()
      if (
        !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(inner) &&
        !/^(?:TRUE|FALSE)$/i.test(inner)
      ) {
        throw new Error(`Invalid default ${trimmed} for numeric/boolean type "${dataType}".`)
      }
    }
    return trimmed
  }

  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    if (!hasBalancedParens(trimmed, true)) {
      throw new Error(`Invalid parenthesized default expression: ${trimmed}`)
    }
    if (FORBIDDEN_SUBQUERY_VERBS.test(trimmed)) {
      throw new Error('Default expression cannot contain SQL queries or DDL/DML statements.')
    }
    return trimmed
  }

  if (/^X'[0-9A-Fa-f]*'$/i.test(trimmed)) {
    return trimmed
  }

  const castIdx = findTopLevelPostgresCastIndex(trimmed)
  if (castIdx > 0) {
    const lhs = trimmed.slice(0, castIdx).trim()
    const rhs = trimmed.slice(castIdx + 2).trim()
    const cleanRhs = validateColumnTypeSpec(rhs)
    const safeLhs = normalizeSqlDefaultExpression(lhs, cleanRhs)
    return `${safeLhs}::${cleanRhs}`
  }

  if (
    /^NULL$/i.test(trimmed) ||
    /^(?:TRUE|FALSE)$/i.test(trimmed) ||
    /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)
  ) {
    return trimmed
  }

  if (KNOWN_SQL_DEFAULT_KEYWORDS.test(trimmed)) {
    if (!hasBalancedParens(trimmed) || FORBIDDEN_SUBQUERY_VERBS.test(trimmed)) {
      throw new Error(`Invalid SQL default function expression: ${trimmed}`)
    }
    return trimmed
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    if (isNumericOrBooleanTypeName(dataType)) {
      throw new Error(`Numeric/boolean column cannot use string default ${trimmed}.`)
    }
    const inner = trimmed.slice(1, -1).replace(/'/g, "''")
    return `'${inner}'`
  }

  if (trimmed.includes('#') || trimmed.includes("'")) {
    if (
      /^'(?:[^']|'')*'$/.test(`'${trimmed.replace(/'/g, "''")}'`) &&
      !trimmed.startsWith("'") &&
      !isNumericOrBooleanTypeName(dataType) &&
      !/\b(?:OR|AND|SELECT|UNION)\b/i.test(trimmed)
    ) {
      return `'${trimmed.replace(/'/g, "''")}'`
    }
    throw new Error(`Invalid SQL default expression: ${trimmed}`)
  }

  if (isNumericOrBooleanTypeName(dataType)) {
    throw new Error(`Invalid default "${trimmed}" for numeric/boolean type "${dataType}".`)
  }

  if (FORBIDDEN_SUBQUERY_VERBS.test(trimmed)) {
    throw new Error(`Invalid SQL keyword in default expression: ${trimmed}`)
  }

  return `'${trimmed.replace(/'/g, "''")}'`
}

export function validateColumnTypeSpec(rawType) {
  const cleaned = (rawType || '').trim()
  if (!cleaned) {
    throw new Error('Column data type is required.')
  }
  const isMysqlEnumOrSet =
    /^(?:ENUM|SET)\s*\(\s*'(?:[^']|'')*'(?:\s*,\s*'(?:[^']|'')*')*\s*\)$/i.test(cleaned)
  if (isMysqlEnumOrSet) {
    if (FORBIDDEN_DEFAULT_TOKENS.test(cleaned)) {
      throw new Error(`Invalid SQL column type: ${rawType}`)
    }
    return cleaned
  }
  if (!/^[A-Za-z][A-Za-z0-9_(),\s[\]]*$/.test(cleaned) || !hasBalancedParens(cleaned)) {
    throw new Error(`Invalid SQL column type: ${rawType}`)
  }
  if (FORBIDDEN_SUBQUERY_VERBS.test(cleaned)) {
    throw new Error(`Invalid SQL keyword in column type: ${rawType}`)
  }
  return cleaned
}

const SQL_FORMAT_KEYWORDS = new Set([
  'SELECT',
  'DISTINCT',
  'ALL',
  'FROM',
  'AS',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'OUTER',
  'CROSS',
  'NATURAL',
  'ON',
  'USING',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'IN',
  'IS',
  'NULL',
  'LIKE',
  'ILIKE',
  'BETWEEN',
  'EXISTS',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'GROUP',
  'BY',
  'HAVING',
  'ORDER',
  'ASC',
  'DESC',
  'NULLS',
  'FIRST',
  'LAST',
  'LIMIT',
  'OFFSET',
  'FETCH',
  'NEXT',
  'ROWS',
  'ONLY',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'INSERT',
  'INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',
  'RETURNING',
  'WITH',
  'RECURSIVE',
  'CREATE',
  'TABLE',
  'VIEW',
  'INDEX',
  'UNIQUE',
  'PRIMARY',
  'KEY',
  'FOREIGN',
  'REFERENCES',
  'CONSTRAINT',
  'DEFAULT',
  'ALTER',
  'ADD',
  'DROP',
  'COLUMN',
  'RENAME',
  'TO',
  'TRUNCATE',
  'IF',
  'EXPLAIN',
  'ANALYZE',
  'QUERY',
  'PLAN',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'PRAGMA',
  'TRUE',
  'FALSE',
  'OVER',
  'PARTITION',
  'WINDOW',
  'CONFLICT',
  'DO',
  'NOTHING',
  'CAST',
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'COALESCE',
])

const TOP_LEVEL_SINGLE_CLAUSES = new Set([
  'SELECT',
  'FROM',
  'JOIN',
  'WHERE',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'VALUES',
  'UPDATE',
  'SET',
  'RETURNING',
  'WITH',
])

const KEYWORDS_WITH_SPACE_BEFORE_PAREN = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'IN',
  'ON',
  'USING',
  'VALUES',
  'SET',
  'INTO',
  'AS',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'HAVING',
  'BY',
  'JOIN',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'EXISTS',
  'OVER',
  'TABLE',
  'RETURNING',
])

const UNARY_PRECEDING_KEYWORDS = new Set([
  'SELECT',
  'DISTINCT',
  'ALL',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'BETWEEN',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'BY',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'SET',
  'VALUES',
  'RETURN',
  'RETURNING',
  'IN',
  'LIKE',
  'ILIKE',
  'SIMILAR',
  'IS',
  'AS',
  'ON',
  'DEFAULT',
  'ANY',
  'SOME',
  'OVER',
])

const UNARY_PRECEDING_OPERATORS = new Set([
  '=',
  '!=',
  '<>',
  '<',
  '<=',
  '>',
  '>=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '||',
  '->',
  '->>',
  '~',
  '!~',
  '&',
  '|',
  '^',
  ':',
])

function isUnarySignContext(tokens) {
  let prev
  for (let idx = tokens.length - 1; idx >= 0; idx--) {
    const candidate = tokens[idx]
    if (candidate.kind === 'line_comment' || candidate.kind === 'block_comment') {
      continue
    }
    prev = candidate
    break
  }
  if (!prev) return true
  if (prev.kind === 'paren_open' || prev.kind === 'comma' || prev.kind === 'semicolon') {
    return true
  }
  if (prev.kind === 'word') {
    return UNARY_PRECEDING_KEYWORDS.has(prev.upper)
  }
  if (prev.kind === 'other') {
    return UNARY_PRECEDING_OPERATORS.has(prev.text)
  }
  return false
}

function tokenizeSqlForFormat(sql, dialect) {
  const tokens = []
  const len = sql.length
  let i = 0

  while (i < len) {
    const ch = sql[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '-' && i + 1 < len && sql[i + 1] === '-') {
      const end = scanLineCommentEnd(sql, i)
      const text = sql.slice(i, end).replace(/[\r\n]+$/, '')
      tokens.push({ kind: 'line_comment', text, upper: '' })
      i = end
      continue
    }
    if (ch === '#' && usesBackslashAndHash(dialect)) {
      const end = scanLineCommentEnd(sql, i - 1)
      const text = sql.slice(i, end).replace(/[\r\n]+$/, '')
      tokens.push({ kind: 'line_comment', text, upper: '' })
      i = end
      continue
    }
    if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
      const end = scanBlockCommentEnd(sql, i, supportsNestedBlockComments(dialect))
      tokens.push({ kind: 'block_comment', text: sql.slice(i, end), upper: '' })
      i = end
      continue
    }
    if (isPostgresEscapeStringStart(sql, i, dialect)) {
      const end = scanQuotedSegmentEnd(sql, i + 1, "'", true).end
      tokens.push({ kind: 'quoted', text: sql.slice(i, end), upper: '' })
      i = end
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const allowBackslash = ch === "'" && usesBackslashAndHash(dialect)
      const end = scanQuotedSegmentEnd(sql, i, ch, allowBackslash).end
      tokens.push({ kind: 'quoted', text: sql.slice(i, end), upper: '' })
      i = end
      continue
    }
    if (ch === '$') {
      const tag = matchDollarQuoteTag(sql, i)
      if (tag !== null) {
        const closeIdx = sql.indexOf(tag, i + tag.length)
        const end = closeIdx >= 0 ? closeIdx + tag.length : len
        tokens.push({ kind: 'quoted', text: sql.slice(i, end), upper: '' })
        i = end
        continue
      }
    }
    if (ch === ':' && i + 1 < len && sql[i + 1] === ':') {
      tokens.push({ kind: 'cast', text: '::', upper: '::' })
      i += 2
      continue
    }
    if (ch === '(') {
      tokens.push({ kind: 'paren_open', text: '(', upper: '(' })
      i++
      continue
    }
    if (ch === ')') {
      tokens.push({ kind: 'paren_close', text: ')', upper: ')' })
      i++
      continue
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma', text: ',', upper: ',' })
      i++
      continue
    }
    if (ch === ';') {
      tokens.push({ kind: 'semicolon', text: ';', upper: ';' })
      i++
      continue
    }
    if (ch === '.') {
      tokens.push({ kind: 'dot', text: '.', upper: '.' })
      i++
      continue
    }
    if (isIdentStartChar(sql.charCodeAt(i))) {
      let end = i + 1
      while (end < len && (isIdentContChar(sql.charCodeAt(end)) || sql.charCodeAt(end) === 36)) {
        end++
      }
      const text = sql.slice(i, end)
      tokens.push({ kind: 'word', text, upper: text.toUpperCase() })
      i = end
      continue
    }
    if (/[0-9]/.test(ch)) {
      let end = i + 1
      while (end < len && /[0-9._eE+-]/.test(sql[end])) {
        if ((sql[end] === '+' || sql[end] === '-') && !/[eE]/.test(sql[end - 1])) break
        end++
      }
      const text = sql.slice(i, end)
      tokens.push({ kind: 'other', text, upper: text })
      i = end
      continue
    }
    const two = i + 1 < len ? sql.slice(i, i + 2) : ''
    if (two === '<=' || two === '>=' || two === '<>' || two === '!=' || two === '||' || two === '->') {
      if (two === '->' && i + 2 < len && sql[i + 2] === '>') {
        tokens.push({ kind: 'other', text: '->>', upper: '->>' })
        i += 3
        continue
      }
      tokens.push({ kind: 'other', text: two, upper: two })
      i += 2
      continue
    }
    if (
      (ch === '-' || ch === '+') &&
      i + 1 < len &&
      (/[0-9]/.test(sql[i + 1]) || (sql[i + 1] === '.' && i + 2 < len && /[0-9]/.test(sql[i + 2]))) &&
      isUnarySignContext(tokens)
    ) {
      let end = i + 1
      if (sql[end] === '.') end++
      while (end < len && /[0-9._eE+-]/.test(sql[end])) {
        if ((sql[end] === '+' || sql[end] === '-') && !/[eE]/.test(sql[end - 1])) break
        end++
      }
      const text = sql.slice(i, end)
      tokens.push({ kind: 'other', text, upper: text })
      i = end
      continue
    }
    tokens.push({ kind: 'other', text: ch, upper: ch })
    i++
  }

  return tokens
}

function matchCompoundClauseLength(tokens, index) {
  const t0 = tokens[index]
  const t1 = tokens[index + 1]
  const t2 = tokens[index + 2]
  if (!t0 || t0.kind !== 'word') return null

  if (
    t1 &&
    t1.kind === 'word' &&
    t2 &&
    t2.kind === 'word' &&
    (t0.upper === 'LEFT' || t0.upper === 'RIGHT' || t0.upper === 'FULL') &&
    t1.upper === 'OUTER' &&
    t2.upper === 'JOIN'
  ) {
    return { length: 3, label: `${t0.upper} OUTER JOIN` }
  }

  if (t1 && t1.kind === 'word') {
    const pair = `${t0.upper} ${t1.upper}`
    if (
      pair === 'LEFT JOIN' ||
      pair === 'RIGHT JOIN' ||
      pair === 'INNER JOIN' ||
      pair === 'OUTER JOIN' ||
      pair === 'CROSS JOIN' ||
      pair === 'FULL JOIN' ||
      pair === 'NATURAL JOIN' ||
      pair === 'GROUP BY' ||
      pair === 'ORDER BY' ||
      pair === 'INSERT INTO' ||
      pair === 'DELETE FROM' ||
      pair === 'UNION ALL'
    ) {
      return { length: 2, label: pair }
    }
  }

  return null
}

function selectClauseHasTopLevelComma(tokens, selectIndex) {
  let depth = 0
  let i = selectIndex + 1
  if (i < tokens.length && tokens[i].kind === 'word' && (tokens[i].upper === 'DISTINCT' || tokens[i].upper === 'ALL')) {
    i++
  }
  while (i < tokens.length) {
    const tok = tokens[i]
    if (tok.kind === 'paren_open') {
      depth++
    } else if (tok.kind === 'paren_close') {
      if (depth > 0) depth--
    } else if (depth === 0) {
      if (tok.kind === 'comma') return true
      if (tok.kind === 'semicolon') return false
      if (
        tok.kind === 'word' &&
        (tok.upper === 'FROM' ||
          tok.upper === 'WHERE' ||
          tok.upper === 'UNION' ||
          tok.upper === 'INTERSECT' ||
          tok.upper === 'EXCEPT' ||
          tok.upper === 'GROUP' ||
          tok.upper === 'ORDER' ||
          tok.upper === 'HAVING' ||
          tok.upper === 'LIMIT' ||
          tok.upper === 'OFFSET' ||
          tok.upper === 'INTO')
      ) {
        return false
      }
    }
    i++
  }
  return false
}

/**
 * Lightweight dialect-aware SQL formatter that uppercases major keywords and formats
 * major clauses on clean lines while strictly preserving strings, identifiers, dollar-quotes,
 * comments, and multi-statement boundaries.
 */
export function formatSql(sql, dialect = 'postgres') {
  if (!sql || !sql.trim()) return ''
  if (dialect === 'redis') {
    return sql.trim()
  }

  const tokens = tokenizeSqlForFormat(sql, dialect)
  if (tokens.length === 0) return ''

  let out = ''
  let parenDepth = 0
  let inMultiSelectList = false
  let inBetween = false
  let forceNewlineNext = false
  let afterSemicolon = false
  let prevToken = null

  const appendBreak = (newlinePrefix) => {
    out = out.replace(/[ \t]+$/, '')
    if (out.length === 0) {
      if (newlinePrefix.startsWith('\n')) {
        out += newlinePrefix.replace(/^\n+/, '')
      }
      return
    }
    if (out.endsWith('\n') && newlinePrefix.startsWith('\n')) {
      out += newlinePrefix.slice(1)
      return
    }
    out += newlinePrefix
  }

  const needsSpaceBefore = (tok) => {
    if (out.length === 0 || out.endsWith('\n') || out.endsWith(' ')) return false
    if (prevToken === null) return false
    if (prevToken.kind === 'paren_open' || prevToken.kind === 'dot' || prevToken.kind === 'cast') {
      return false
    }
    if (
      tok.kind === 'comma' ||
      tok.kind === 'semicolon' ||
      tok.kind === 'paren_close' ||
      tok.kind === 'dot' ||
      tok.kind === 'cast'
    ) {
      return false
    }
    if (tok.kind === 'paren_open' && prevToken.kind === 'word') {
      return KEYWORDS_WITH_SPACE_BEFORE_PAREN.has(prevToken.upper)
    }
    return true
  }

  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]

    if (afterSemicolon) {
      appendBreak('\n\n')
      afterSemicolon = false
      forceNewlineNext = false
      prevToken = null
    } else if (forceNewlineNext) {
      appendBreak('\n')
      forceNewlineNext = false
      prevToken = null
    }

    if (tok.kind === 'line_comment') {
      if (needsSpaceBefore(tok)) out += ' '
      out += tok.text
      forceNewlineNext = true
      prevToken = tok
      i++
      continue
    }

    if (tok.kind === 'block_comment') {
      if (needsSpaceBefore(tok)) out += ' '
      out += tok.text
      prevToken = tok
      i++
      continue
    }

    if (tok.kind === 'semicolon') {
      out = out.replace(/[ \t]+$/, '') + ';'
      parenDepth = 0
      inMultiSelectList = false
      inBetween = false
      afterSemicolon = true
      prevToken = tok
      i++
      continue
    }

    if (tok.kind === 'paren_open') {
      if (needsSpaceBefore(tok)) out += ' '
      out += '('
      parenDepth++
      prevToken = tok
      i++
      continue
    }

    if (tok.kind === 'paren_close') {
      out = out.replace(/[ \t]+$/, '') + ')'
      if (parenDepth > 0) parenDepth--
      prevToken = tok
      i++
      continue
    }

    if (tok.kind === 'comma') {
      if (parenDepth === 0 && inMultiSelectList) {
        out = out.replace(/[ \t]+$/, '') + ',\n  '
      } else {
        out = out.replace(/[ \t]+$/, '') + ','
      }
      prevToken = tok
      i++
      continue
    }

    if (parenDepth === 0 && tok.kind === 'word' && prevToken?.kind !== 'dot') {
      const compound = matchCompoundClauseLength(tokens, i)
      if (compound) {
        inMultiSelectList = false
        inBetween = false
        appendBreak('\n')
        out += compound.label
        prevToken = tokens[i + compound.length - 1]
        i += compound.length
        continue
      }

      if (TOP_LEVEL_SINGLE_CLAUSES.has(tok.upper)) {
        inMultiSelectList = false
        inBetween = false
        appendBreak('\n')
        out += tok.upper
        prevToken = tok
        if (tok.upper === 'SELECT') {
          const hasComma = selectClauseHasTopLevelComma(tokens, i)
          if (
            i + 1 < tokens.length &&
            tokens[i + 1].kind === 'word' &&
            (tokens[i + 1].upper === 'DISTINCT' || tokens[i + 1].upper === 'ALL')
          ) {
            out += ` ${tokens[i + 1].upper}`
            prevToken = tokens[i + 1]
            i++
          }
          if (hasComma) {
            inMultiSelectList = true
            out += '\n  '
            prevToken = null
          }
        }
        i++
        continue
      }

      if (tok.upper === 'BETWEEN') {
        inBetween = true
      } else if ((tok.upper === 'AND' || tok.upper === 'OR') && !(tok.upper === 'AND' && inBetween)) {
        appendBreak('\n  ')
        out += tok.upper
        prevToken = tok
        i++
        continue
      } else if (tok.upper === 'AND' && inBetween) {
        inBetween = false
      }
    }

    const formattedText =
      tok.kind === 'word' && prevToken?.kind !== 'dot' && SQL_FORMAT_KEYWORDS.has(tok.upper)
        ? tok.upper
        : tok.text

    if (needsSpaceBefore(tok)) out += ' '
    out += formattedText
    prevToken = tok
    i++
  }

  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim()
}
