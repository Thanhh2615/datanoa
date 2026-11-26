/**
 * Pure dialect-aware SQL lexing, quoting, statement splitting, DDL detection,
 * and type/default expression validation shared by Worker/Studio (.ts) and
 * native-ESM Side Panel (.js) modules.
 */

const BACKTICK_DIALECTS = new Set(['mysql', 'mariadb', 'clickhouse'])

const MYSQL_FAMILY_DIALECTS = new Set(['mysql', 'mariadb'])

const POSTGRES_FAMILY_DIALECTS = new Set(['postgres', 'cockroachdb'])

const SQLITE_FAMILY_LEXER_RULE = Object.freeze({
  lineCommentDash: true,
  lineCommentHash: false,
  lineCommentSlash: false,
  nestedBlockComments: false,
  backslashEscapesSingleQuote: false,
  backslashEscapesDoubleQuote: false,
  dollarQuoting: false,
  postgresEscapeString: false,
  oracleQQuote: false,
  mysqlExecComments: false,
  mysqlDelimiter: false,
  bracketIdentifiers: 'no-doubling',
  backtickIdentifiers: true,
  doubleQuoteIdentifiers: true,
  compoundRoutineBegin: true,
})

const POSTGRES_FAMILY_LEXER_RULE = Object.freeze({
  lineCommentDash: true,
  lineCommentHash: false,
  lineCommentSlash: false,
  nestedBlockComments: true,
  backslashEscapesSingleQuote: false,
  backslashEscapesDoubleQuote: false,
  dollarQuoting: true,
  postgresEscapeString: true,
  oracleQQuote: false,
  mysqlExecComments: false,
  mysqlDelimiter: false,
  bracketIdentifiers: 'none',
  backtickIdentifiers: false,
  doubleQuoteIdentifiers: true,
  compoundRoutineBegin: false,
})

const MYSQL_FAMILY_LEXER_RULE = Object.freeze({
  lineCommentDash: true,
  lineCommentHash: true,
  lineCommentSlash: false,
  nestedBlockComments: false,
  backslashEscapesSingleQuote: true,
  backslashEscapesDoubleQuote: true,
  dollarQuoting: false,
  postgresEscapeString: false,
  oracleQQuote: false,
  mysqlExecComments: true,
  mysqlDelimiter: true,
  bracketIdentifiers: 'none',
  backtickIdentifiers: true,
  doubleQuoteIdentifiers: true,
  compoundRoutineBegin: true,
})

const DEFAULT_DIALECT_LEXER_RULES = Object.freeze({
  lineCommentDash: true,
  lineCommentHash: false,
  lineCommentSlash: false,
  nestedBlockComments: false,
  backslashEscapesSingleQuote: false,
  backslashEscapesDoubleQuote: false,
  dollarQuoting: false,
  postgresEscapeString: false,
  oracleQQuote: false,
  mysqlExecComments: false,
  mysqlDelimiter: false,
  bracketIdentifiers: 'none',
  backtickIdentifiers: true,
  doubleQuoteIdentifiers: true,
  compoundRoutineBegin: false,
})

/**
 * Single source of truth for lexical rules across all 12 supported Datanoa dialects.
 * Reused by splitters, RO/danger guards, diagnostics, grammar checks, params, editability, and AI context.
 */
export const DIALECT_LEXER_RULES = Object.freeze({
  sqlite: SQLITE_FAMILY_LEXER_RULE,
  libsql: SQLITE_FAMILY_LEXER_RULE,
  d1: SQLITE_FAMILY_LEXER_RULE,
  postgres: POSTGRES_FAMILY_LEXER_RULE,
  cockroachdb: POSTGRES_FAMILY_LEXER_RULE,
  mysql: MYSQL_FAMILY_LEXER_RULE,
  mariadb: MYSQL_FAMILY_LEXER_RULE,
  clickhouse: Object.freeze({
    lineCommentDash: true,
    lineCommentHash: true,
    lineCommentSlash: true,
    nestedBlockComments: true,
    backslashEscapesSingleQuote: true,
    backslashEscapesDoubleQuote: true,
    dollarQuoting: false,
    postgresEscapeString: false,
    oracleQQuote: false,
    mysqlExecComments: false,
    mysqlDelimiter: false,
    bracketIdentifiers: 'none',
    backtickIdentifiers: true,
    doubleQuoteIdentifiers: true,
    compoundRoutineBegin: false,
  }),
  mssql: Object.freeze({
    lineCommentDash: true,
    lineCommentHash: false,
    lineCommentSlash: false,
    nestedBlockComments: true,
    backslashEscapesSingleQuote: false,
    backslashEscapesDoubleQuote: false,
    dollarQuoting: false,
    postgresEscapeString: false,
    oracleQQuote: false,
    mysqlExecComments: false,
    mysqlDelimiter: false,
    bracketIdentifiers: 'doubling',
    backtickIdentifiers: false,
    doubleQuoteIdentifiers: true,
    compoundRoutineBegin: true,
  }),
  oracle: Object.freeze({
    lineCommentDash: true,
    lineCommentHash: false,
    lineCommentSlash: false,
    nestedBlockComments: false,
    backslashEscapesSingleQuote: false,
    backslashEscapesDoubleQuote: false,
    dollarQuoting: false,
    postgresEscapeString: false,
    oracleQQuote: true,
    mysqlExecComments: false,
    mysqlDelimiter: false,
    bracketIdentifiers: 'none',
    backtickIdentifiers: false,
    doubleQuoteIdentifiers: true,
    compoundRoutineBegin: true,
  }),
  mongodb: Object.freeze({
    lineCommentDash: false,
    lineCommentHash: false,
    lineCommentSlash: true,
    nestedBlockComments: false,
    backslashEscapesSingleQuote: true,
    backslashEscapesDoubleQuote: true,
    dollarQuoting: false,
    postgresEscapeString: false,
    oracleQQuote: false,
    mysqlExecComments: false,
    mysqlDelimiter: false,
    bracketIdentifiers: 'none',
    backtickIdentifiers: false,
    doubleQuoteIdentifiers: true,
    compoundRoutineBegin: false,
  }),
  redis: Object.freeze({
    lineCommentDash: false,
    lineCommentHash: true,
    lineCommentSlash: false,
    nestedBlockComments: false,
    backslashEscapesSingleQuote: true,
    backslashEscapesDoubleQuote: true,
    dollarQuoting: false,
    postgresEscapeString: false,
    oracleQQuote: false,
    mysqlExecComments: false,
    mysqlDelimiter: false,
    bracketIdentifiers: 'none',
    backtickIdentifiers: false,
    doubleQuoteIdentifiers: true,
    compoundRoutineBegin: false,
  }),
})

export function getDialectLexerRules(dialect) {
  if (typeof dialect === 'string' && Object.prototype.hasOwnProperty.call(DIALECT_LEXER_RULES, dialect)) {
    return DIALECT_LEXER_RULES[dialect]
  }
  return DEFAULT_DIALECT_LEXER_RULES
}

export function usesBackslashAndHash(dialect) {
  const rules = getDialectLexerRules(dialect)
  return rules.lineCommentHash && rules.backslashEscapesSingleQuote && dialect !== 'redis'
}

function usesMysqlExecutableComments(dialect) {
  return getDialectLexerRules(dialect).mysqlExecComments
}

export function supportsNestedBlockComments(dialect) {
  return getDialectLexerRules(dialect).nestedBlockComments
}

export function supportsDollarQuoting(dialect) {
  return getDialectLexerRules(dialect).dollarQuoting
}

export function supportsBracketIdentifiers(dialect) {
  return getDialectLexerRules(dialect).bracketIdentifiers !== 'none'
}

export function supportsSlashLineComments(dialect) {
  return getDialectLexerRules(dialect).lineCommentSlash
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
  if (!getDialectLexerRules(dialect).postgresEscapeString) return false
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
  if (dialect === 'mssql') {
    return `[${raw.replace(/\]/g, ']]')}]`
  }
  if (BACKTICK_DIALECTS.has(dialect)) {
    return `\`${raw.replace(/`/g, '``')}\``
  }
  return `"${raw.replace(/"/g, '""')}"`
}

export function scanBracketIdentEnd(sql, start, allowDoubling = true) {
  let i = start + 1
  const len = sql.length
  while (i < len) {
    if (sql[i] === ']') {
      if (allowDoubling && i + 1 < len && sql[i + 1] === ']') {
        i += 2
        continue
      }
      return { end: i + 1, closed: true }
    }
    i++
  }
  return { end: len, closed: false }
}

function tryParseTableReferenceParts(trimmed) {
  const parts = []
  let pos = 0
  const len = trimmed.length

  while (pos < len) {
    const ch = trimmed[pos]
    if (ch === '[') {
      const seg = scanBracketIdentEnd(trimmed, pos, true)
      if (!seg.closed) return null
      const unescaped = trimmed.slice(pos + 1, seg.end - 1).replace(/\]\]/g, ']')
      if (!unescaped) return null
      parts.push(unescaped)
      pos = seg.end
    } else if (ch === '"' || ch === '`') {
      const seg = scanQuotedSegmentEnd(trimmed, pos, ch, false)
      if (!seg.closed) return null
      const rawInner = trimmed.slice(pos + 1, seg.end - 1)
      const unescaped =
        ch === '`' ? rawInner.replace(/``/g, '`') : rawInner.replace(/""/g, '"')
      if (!unescaped) return null
      parts.push(unescaped)
      pos = seg.end
    } else {
      let end = pos
      while (end < len && trimmed[end] !== '.') {
        const c = trimmed[end]
        if (c === '"' || c === '`' || c === '[' || c === ']' || /\s/.test(c)) {
          return null
        }
        end++
      }
      if (end === pos) return null
      parts.push(trimmed.slice(pos, end))
      pos = end
    }

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
  const parsedParts = tryParseTableReferenceParts(trimmed)
  if (parsedParts) {
    return parsedParts.map((part) => quoteIdentForDialect(part, dialect)).join('.')
  }
  return quoteIdentForDialect(trimmed, dialect)
}

const MAX_NORMALIZE_JSON_DEPTH = 64

function normalizeJsonValueInternal(value, depth, ancestors) {
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
  if (typeof value === 'object') {
    if (ancestors.has(value)) {
      return '[Circular]'
    }
    if (depth >= MAX_NORMALIZE_JSON_DEPTH) {
      return '[MaxDepth]'
    }
    ancestors.add(value)
    try {
      if (Array.isArray(value)) {
        return value.map((item) => normalizeJsonValueInternal(item, depth + 1, ancestors))
      }
      const out = {}
      for (const [k, v] of Object.entries(value)) {
        if (v !== undefined && typeof v !== 'function' && typeof v !== 'symbol') {
          const normalized = normalizeJsonValueInternal(v, depth + 1, ancestors)
          if (k === '__proto__') {
            Object.defineProperty(out, k, {
              value: normalized,
              enumerable: true,
              writable: true,
              configurable: true,
            })
          } else {
            out[k] = normalized
          }
        }
      }
      return out
    } finally {
      ancestors.delete(value)
    }
  }
  return null
}

export function normalizeJsonValue(value) {
  return normalizeJsonValueInternal(value, 0, new WeakSet())
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
  if (dialect === 'mssql') {
    return `0x${hex}`
  }
  if (dialect === 'oracle') {
    return `HEXTORAW('${hex}')`
  }
  return `X'${hex}'`
}

export function formatSqlLiteral(value, dialect) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') {
    return dialect === 'mssql' ? (value ? '1' : '0') : value ? 'TRUE' : 'FALSE'
  }
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

const ORACLE_Q_CLOSE_DELIM = {
  '[': ']',
  '(': ')',
  '{': '}',
  '<': '>',
}

export function scanOracleQuoteEnd(sql, index, dialect) {
  if (dialect !== 'oracle') return null
  const len = sql.length
  let qIdx = index
  const first = sql[index]
  if (
    (first === 'n' || first === 'N') &&
    index + 2 < len &&
    (sql[index + 1] === 'q' || sql[index + 1] === 'Q')
  ) {
    qIdx = index + 1
  } else if (first !== 'q' && first !== 'Q') {
    return null
  }
  if (qIdx + 2 >= len || sql[qIdx + 1] !== "'") return null
  if (index > 0) {
    const prevCode = sql.charCodeAt(index - 1)
    if (isIdentContChar(prevCode) || prevCode === 36 || prevCode === 35) return null
  }
  const openDelim = sql[qIdx + 2]
  if (/\s/.test(openDelim)) return null
  const closeDelim = ORACLE_Q_CLOSE_DELIM[openDelim] ?? openDelim
  const closeIdx = sql.indexOf(`${closeDelim}'`, qIdx + 3)
  if (closeIdx >= 0) {
    return { end: closeIdx + 2, closed: true }
  }
  return { end: len, closed: false }
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

function scanBlockCommentWithState(sql, start, nested = true) {
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
  return { end: i, closed: depth === 0 }
}

export function scanBlockCommentEnd(sql, start, nested = true) {
  return scanBlockCommentWithState(sql, start, nested).end
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

const MONGO_REGEX_PREFIX_KEYWORDS = new Set([
  'return',
  'typeof',
  'void',
  'delete',
  'in',
  'instanceof',
  'new',
  'throw',
  'case',
  'else',
  'of',
  'await',
  'yield',
])

function skipJsTemplateInterpolation(text, start) {
  let i = start
  let depth = 1
  let prevKind = 'op'
  while (i < text.length && depth > 0) {
    const tok = advanceMongoJsToken(text, i, prevKind)
    if (tok.kind === 'ws' || tok.kind === 'comment') {
      i = tok.end
      continue
    }
    if (tok.text === '{') depth++
    else if (tok.text === '}') depth--
    prevKind = tok.nextPrevKind
    i = tok.end
  }
  return i
}

function scanJsStringLiteralEnd(text, start, quoteChar) {
  let i = start + 1
  const len = text.length
  while (i < len) {
    const ch = text[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (quoteChar === '`' && ch === '$' && i + 1 < len && text[i + 1] === '{') {
      i = skipJsTemplateInterpolation(text, i + 2)
      continue
    }
    if (ch === quoteChar) return i + 1
    i++
  }
  return len
}

function scanJsRegexLiteralEnd(text, start) {
  let i = start + 1
  const len = text.length
  let inClass = false
  while (i < len) {
    const ch = text[i]
    if (ch === '\n' || ch === '\r') return -1
    if (ch === '\\') {
      if (i + 1 >= len || text[i + 1] === '\n' || text[i + 1] === '\r') return -1
      i += 2
      continue
    }
    if (ch === '[') {
      inClass = true
      i++
      continue
    }
    if (ch === ']' && inClass) {
      inClass = false
      i++
      continue
    }
    if (ch === '/' && !inClass) {
      i++
      while (i < len && /[a-z]/i.test(text[i])) i++
      return i
    }
    i++
  }
  return -1
}

export function advanceMongoJsToken(text, i, prevKind) {
  const len = text.length
  const ch = text[i]
  if (/\s/.test(ch)) {
    let end = i + 1
    while (end < len && /\s/.test(text[end])) end++
    return { kind: 'ws', end, text: text.slice(i, end), nextPrevKind: prevKind }
  }
  if (ch === '/' && i + 1 < len && text[i + 1] === '/') {
    const end = scanLineCommentEnd(text, i)
    return { kind: 'comment', end, text: '', nextPrevKind: prevKind }
  }
  if (ch === '/' && i + 1 < len && text[i + 1] === '*') {
    const end = scanBlockCommentEnd(text, i, false)
    return { kind: 'comment', end, text: '', nextPrevKind: prevKind }
  }
  if (ch === "'" || ch === '"' || ch === '`') {
    const end = scanJsStringLiteralEnd(text, i, ch)
    return { kind: 'string', end, text: text.slice(i, end), nextPrevKind: 'string' }
  }
  if (ch === '/' && (prevKind === 'start' || prevKind === 'op' || prevKind === 'keyword')) {
    const rxEnd = scanJsRegexLiteralEnd(text, i)
    if (rxEnd > i) {
      return { kind: 'regex', end: rxEnd, text: text.slice(i, rxEnd), nextPrevKind: 'regex' }
    }
  }
  if (ch === '{' || ch === '(' || ch === '[' || ch === ';' || ch === ',' || ch === ':') {
    return { kind: 'punct', end: i + 1, text: ch, nextPrevKind: 'op' }
  }
  if (ch === '}' || ch === ')' || ch === ']') {
    return { kind: 'punct', end: i + 1, text: ch, nextPrevKind: 'close' }
  }
  if (isIdentStartChar(text.charCodeAt(i)) || ch === '$') {
    let end = i + 1
    while (end < len && (isIdentContChar(text.charCodeAt(end)) || text.charCodeAt(end) === 36)) {
      end++
    }
    const word = text.slice(i, end)
    return {
      kind: 'ident',
      end,
      text: word,
      nextPrevKind: MONGO_REGEX_PREFIX_KEYWORDS.has(word) ? 'keyword' : 'ident',
    }
  }
  if (/[0-9]/.test(ch)) {
    let end = i + 1
    while (end < len && /[0-9._a-zA-Z]/.test(text[end])) end++
    return { kind: 'number', end, text: text.slice(i, end), nextPrevKind: 'number' }
  }
  return { kind: 'op', end: i + 1, text: ch, nextPrevKind: 'op' }
}

function splitMongoStatements(script) {
  const results = []
  const len = script.length
  let segStart = 0
  let hasExecutableToken = false
  let braceDepth = 0
  let parenDepth = 0
  let bracketDepth = 0
  let prevKind = 'start'
  let i = 0

  const flush = (rawEnd, delimLen) => {
    if (hasExecutableToken) {
      const { start, end } = trimSliceBounds(script, segStart, rawEnd)
      if (end > start) {
        results.push({ text: script.slice(start, end), start, end })
      }
    }
    segStart = rawEnd + delimLen
    hasExecutableToken = false
    braceDepth = 0
    parenDepth = 0
    bracketDepth = 0
    prevKind = 'start'
  }

  while (i < len) {
    const tok = advanceMongoJsToken(script, i, prevKind)
    if (tok.kind === 'ws' || tok.kind === 'comment') {
      if (!hasExecutableToken) segStart = tok.end
      i = tok.end
      continue
    }
    if (tok.text === ';' && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
      flush(i, 1)
      i = tok.end
      continue
    }
    hasExecutableToken = true
    if (tok.text === '{') braceDepth++
    else if (tok.text === '}' && braceDepth > 0) braceDepth--
    else if (tok.text === '(') parenDepth++
    else if (tok.text === ')' && parenDepth > 0) parenDepth--
    else if (tok.text === '[') bracketDepth++
    else if (tok.text === ']' && bracketDepth > 0) bracketDepth--
    prevKind = tok.nextPrevKind
    i = tok.end
  }

  if (segStart < len) {
    flush(len, 0)
  }
  return results
}

const MYSQL_DELIMITER_LINE_RE =
  /^DELIMITER[ \t]+([^\s\r\n]+)(?:[ \t]+(?:--|#)[^\r\n]*)?[ \t]*(?:\r?\n|$)/i

function matchesCustomDelimiterAt(script, i, delimiter) {
  if (!delimiter || !script.startsWith(delimiter, i)) return false
  if (delimiter === ';') return true
  const firstIsWord = isIdentContChar(delimiter.charCodeAt(0))
  const lastIsWord = isIdentContChar(delimiter.charCodeAt(delimiter.length - 1))
  if (firstIsWord && i > 0 && isIdentContChar(script.charCodeAt(i - 1))) return false
  if (
    lastIsWord &&
    i + delimiter.length < script.length &&
    isIdentContChar(script.charCodeAt(i + delimiter.length))
  ) {
    return false
  }
  return true
}

function popLastBlockEntry(blockStack, targetKind) {
  for (let idx = blockStack.length - 1; idx >= 0; idx--) {
    if (blockStack[idx] === targetKind) {
      blockStack.splice(idx, 1)
      return true
    }
  }
  return false
}

/**
 * Splits a SQL script into executable statements, preserving source offsets and ignoring
 * semicolons inside quotes, compound trigger/routine BEGIN..END blocks, MySQL DELIMITER blocks,
 * PG dollar-quoted blocks, and comments.
 */
export function splitSqlStatements(script, dialect) {
  if (dialect === 'mongodb') {
    return splitMongoStatements(script)
  }
  const results = []
  const len = script.length
  const rules = getDialectLexerRules(dialect)
  const allowMysqlDelimiter = rules.mysqlDelimiter
  const supportsCompoundRoutineBegin = rules.compoundRoutineBegin

  let segStart = 0
  let hasExecutableToken = false
  let delimiter = ';'
  let execCommentDepth = 0
  let i = 0

  let stmtHeaderWords = []
  let isCompoundHeader = false
  let blockStack = []
  let prevWordUpper = ''

  const hasOpenBegin = () => blockStack.includes('BEGIN')

  const resetStatementState = () => {
    stmtHeaderWords = []
    isCompoundHeader = false
    blockStack = []
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
        const delimMatch = MYSQL_DELIMITER_LINE_RE.exec(script.slice(wsEnd))
        if (delimMatch && delimMatch[1]) {
          delimiter = delimMatch[1]
          i = wsEnd + delimMatch[0].length
          segStart = i
          resetStatementState()
          continue
        }
      }
    }

    if (delimiter.length > 0 && !hasOpenBegin() && execCommentDepth === 0) {
      if (matchesCustomDelimiterAt(script, i, delimiter)) {
        flushSegment(i, delimiter.length)
        i += delimiter.length
        continue
      }
    }

    const ch = script[i]
    if (rules.lineCommentDash && ch === '-' && i + 1 < len && script[i + 1] === '-') {
      i = scanLineCommentEnd(script, i)
      continue
    }
    if (rules.lineCommentSlash && ch === '/' && i + 1 < len && script[i + 1] === '/') {
      i = scanLineCommentEnd(script, i)
      continue
    }
    if (rules.lineCommentHash && ch === '#') {
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
      i = scanBlockCommentEnd(script, i, rules.nestedBlockComments)
      continue
    }
    if (isPostgresEscapeStringStart(script, i, dialect)) {
      hasExecutableToken = true
      i = scanQuotedSegmentEnd(script, i + 1, "'", true).end
      prevWordUpper = ''
      continue
    }
    const oracleQuote = scanOracleQuoteEnd(script, i, dialect)
    if (oracleQuote) {
      hasExecutableToken = true
      i = oracleQuote.end
      prevWordUpper = ''
      continue
    }
    if (ch === "'" || ch === '"' || (ch === '`' && rules.backtickIdentifiers)) {
      hasExecutableToken = true
      const allowBackslash =
        (ch === "'" && rules.backslashEscapesSingleQuote) ||
        (ch === '"' && rules.backslashEscapesDoubleQuote)
      i = scanQuotedSegmentEnd(script, i, ch, allowBackslash).end
      prevWordUpper = ''
      continue
    }
    if (ch === '[' && rules.bracketIdentifiers !== 'none') {
      hasExecutableToken = true
      i = scanBracketIdentEnd(script, i, rules.bracketIdentifiers === 'doubling').end
      prevWordUpper = ''
      continue
    }
    if (rules.dollarQuoting && ch === '$') {
      const tag = matchDollarQuoteTag(script, i)
      if (tag !== null) {
        hasExecutableToken = true
        const closeIdx = script.indexOf(tag, i + tag.length)
        i = closeIdx >= 0 ? closeIdx + tag.length : len
        prevWordUpper = ''
        continue
      }
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
            blockStack.push('BEGIN')
          }
        } else if (wordUpper === 'CASE' && prevWordUpper !== 'END') {
          blockStack.push('CASE')
        } else if (wordUpper === 'END') {
          const nextWord = peekNextUpperWord(end)
          if (COMPOUND_END_SUFFIX_WORDS.has(nextWord)) {
            if (nextWord === 'CASE') {
              popLastBlockEntry(blockStack, 'CASE')
            }
          } else if (blockStack.length > 0) {
            blockStack.pop()
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
  for (let i = 0; i < stmts.length - 1; i++) {
    const stmt = stmts[i]
    if (pos <= stmt.end) {
      return stmt.text
    }
    const next = stmts[i + 1]
    if (pos < next.start) {
      const gap = script.slice(stmt.end, next.start)
      const semiRel = gap.indexOf(';')
      const semiBoundary = semiRel >= 0 ? stmt.end + semiRel + 1 : stmt.end
      return pos <= semiBoundary ? stmt.text : next.text
    }
  }

  return stmts[stmts.length - 1].text
}

function buildTrimmedSpan(text, baseOffset) {
  const safeText = String(text ?? '')
  const trimmed = safeText.trim()
  if (!trimmed) return null
  const leadingWs = safeText.length - safeText.trimStart().length
  const from = baseOffset + leadingWs
  const to = from + trimmed.length
  return { from, to, sql: trimmed, originalSlice: trimmed }
}

/**
 * Resolves the exact document range `{ from, to, sql, originalSlice }` targeted by execution.
 * Uses selection when non-empty (for caret/explain/redis), full doc for `'all'`, `'explain'`,
 * or `'redis'`, or the statement span enclosing/preceding the caret.
 */
export function resolveSqlExecutionSpan(docText, selection, mode = 'caret', dialect = 'sqlite') {
  const fullText = String(docText ?? '')
  const resolvedDialect = dialect || 'sqlite'

  if (mode === 'all') {
    return buildTrimmedSpan(fullText, 0)
  }

  if (selection && !(selection.empty ?? selection.from === selection.to)) {
    const rawFrom = selection.from
    const rawTo = selection.to
    if (Number.isFinite(rawFrom) && Number.isFinite(rawTo)) {
      const selFrom = Math.max(0, Math.min(fullText.length, Math.trunc(rawFrom)))
      const selTo = Math.max(0, Math.min(fullText.length, Math.trunc(rawTo)))
      if (selTo > selFrom) {
        const selectedRaw = fullText.slice(selFrom, selTo)
        const selectedSpan = buildTrimmedSpan(selectedRaw, selFrom)
        if (selectedSpan) {
          return selectedSpan
        }
      }
    }
  }

  if (mode === 'explain' || resolvedDialect === 'redis') {
    return buildTrimmedSpan(fullText, 0)
  }

  const stmts = splitSqlStatements(fullText, resolvedDialect)
  if (stmts.length === 0) return null

  const rawPos = selection?.head ?? selection?.from ?? 0
  const pos = Math.max(0, Math.min(fullText.length, Number.isFinite(rawPos) ? rawPos : 0))
  let chosen = stmts[stmts.length - 1]
  for (let i = 0; i < stmts.length - 1; i++) {
    const stmt = stmts[i]
    if (pos <= stmt.end) {
      chosen = stmt
      break
    }
    const next = stmts[i + 1]
    if (pos < next.start) {
      const gap = fullText.slice(stmt.end, next.start)
      const semiRel = gap.indexOf(';')
      const semiBoundary = semiRel >= 0 ? stmt.end + semiRel + 1 : stmt.end
      chosen = pos <= semiBoundary ? stmt : next
      break
    }
  }

  const originalSlice = fullText.slice(chosen.start, chosen.end)
  const sqlText = originalSlice.trim()
  if (!sqlText) return null
  return {
    from: chosen.start,
    to: chosen.end,
    sql: sqlText,
    originalSlice,
  }
}

const UNTERM_STMT_STARTERS = new Set([
  'SELECT',
  'WITH',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'ALTER',
  'DROP',
  'REPLACE',
  'MERGE',
  'TRUNCATE',
  'PRAGMA',
  'EXPLAIN',
  'SHOW',
  'DESCRIBE',
])

const UNTERM_WITH_MAIN_VERBS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'])

const UNTERM_CONTINUATION_BEFORE_STARTER = new Set([
  'UNION',
  'ALL',
  'DISTINCT',
  'INTERSECT',
  'EXCEPT',
  'MINUS',
  'AS',
  'DO',
  'ON',
  'BEFORE',
  'AFTER',
  'OF',
  'FOR',
  'TO',
  'THEN',
  'ELSE',
  'BEGIN',
  'RETURN',
  'RETURNING',
  'GRANT',
  'REVOKE',
  'INSTEAD',
  'OR',
  'AND',
])

const SQL_SIGNATURE_STOPWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'TRUE', 'FALSE',
  'AS', 'ON', 'USING', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL',
  'ORDER', 'GROUP', 'BY', 'HAVING', 'LIMIT', 'OFFSET', 'ASC', 'DESC', 'DISTINCT', 'ALL',
  'UNION', 'INTERSECT', 'EXCEPT', 'MINUS', 'WITH', 'RECURSIVE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'REPLACE', 'MERGE', 'CREATE', 'ALTER', 'DROP',
  'TABLE', 'VIEW', 'INDEX', 'TRIGGER', 'TEMP', 'TEMPORARY', 'IF', 'EXISTS', 'ONLY', 'LATERAL',
  'BETWEEN', 'LIKE', 'ILIKE', 'CAST', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF',
  'RETURNING', 'CONFLICT', 'NOTHING', 'DEFAULT', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES',
  'UNIQUE', 'CONSTRAINT', 'CHECK', 'CASCADE', 'RESTRICT', 'PRAGMA', 'EXPLAIN', 'ANALYZE', 'QUERY', 'PLAN',
])

const TABLE_INTRO_MODIFIERS = new Set([
  'ONLY',
  'LATERAL',
  'IF',
  'NOT',
  'EXISTS',
  'OR',
  'REPLACE',
  'IGNORE',
  'ABORT',
  'ROLLBACK',
  'FAIL',
  'TEMP',
  'TEMPORARY',
  'LOW_PRIORITY',
  'DELAYED',
  'HIGH_PRIORITY',
  'QUICK',
  'OVERWRITE',
  'TABLE',
])

function unquoteSqlIdent(raw) {
  if (!raw || raw.length < 2) return raw
  const first = raw[0]
  const last = raw[raw.length - 1]
  if (first === '"' && last === '"') return raw.slice(1, -1).replace(/""/g, '"')
  if (first === '`' && last === '`') return raw.slice(1, -1).replace(/``/g, '`')
  if (first === '[' && last === ']') return raw.slice(1, -1).replace(/\]\]/g, ']')
  return raw
}

function splitUnterminatedSqlStatements(script, dialect) {
  if (!script || dialect === 'redis' || dialect === 'mongodb') {
    const trimmed = trimSliceBounds(script || '', 0, (script || '').length)
    return trimmed.end > trimmed.start
      ? [{ text: script.slice(trimmed.start, trimmed.end), start: trimmed.start, end: trimmed.end }]
      : []
  }

  const len = script.length
  const rules = getDialectLexerRules(dialect)
  const supportsCompoundRoutineBegin = rules.compoundRoutineBegin
  const results = []

  let i = 0
  let segStart = 0
  let hasToken = false
  let lastTokenEnd = 0
  let parenDepth = 0
  let stmtHeaderWords = []
  let isCompoundHeader = false
  let blockStack = []
  let execCommentDepth = 0
  let stmtVerb = ''
  let awaitingWithMainVerb = false
  let awaitingExplainMainVerb = false
  let sawValuesOrSelect = false
  let prevWordUpper = ''
  let prevNonWsKind = 'start'
  let sawNewline = false

  const hasOpenBegin = () => blockStack.includes('BEGIN')

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

  const flushSeg = (endPos) => {
    if (hasToken) {
      const { start, end } = trimSliceBounds(script, segStart, endPos)
      if (end > start) {
        results.push({ text: script.slice(start, end), start, end })
      }
    }
    hasToken = false
    stmtHeaderWords = []
    isCompoundHeader = false
    blockStack = []
    execCommentDepth = 0
    stmtVerb = ''
    awaitingWithMainVerb = false
    awaitingExplainMainVerb = false
    sawValuesOrSelect = false
    prevWordUpper = ''
    prevNonWsKind = 'start'
  }

  while (i < len) {
    const ch = script[i]
    if (/\s/.test(ch)) {
      if (ch === '\n' || ch === '\r') sawNewline = true
      i++
      continue
    }
    if (rules.lineCommentDash && ch === '-' && i + 1 < len && script[i + 1] === '-') {
      const end = scanLineCommentEnd(script, i)
      if (script.slice(i, end).includes('\n')) sawNewline = true
      i = end
      continue
    }
    if (rules.lineCommentSlash && ch === '/' && i + 1 < len && script[i + 1] === '/') {
      const end = scanLineCommentEnd(script, i)
      if (script.slice(i, end).includes('\n')) sawNewline = true
      i = end
      continue
    }
    if (rules.lineCommentHash && ch === '#') {
      const end = scanLineCommentEnd(script, i - 1)
      if (script.slice(i, end).includes('\n')) sawNewline = true
      i = end
      continue
    }
    if (execCommentDepth > 0 && ch === '*' && i + 1 < len && script[i + 1] === '/') {
      execCommentDepth--
      lastTokenEnd = i + 2
      sawNewline = false
      i += 2
      continue
    }
    if (ch === '/' && i + 1 < len && script[i + 1] === '*') {
      const execLen = matchMysqlExecCommentPrefix(script, i, dialect)
      if (execLen > 0) {
        if (!hasToken) segStart = i
        hasToken = true
        execCommentDepth++
        lastTokenEnd = i + execLen
        sawNewline = false
        i += execLen
        continue
      }
      const end = scanBlockCommentEnd(script, i, rules.nestedBlockComments)
      if (script.slice(i, end).includes('\n')) sawNewline = true
      i = end
      continue
    }

    if (isPostgresEscapeStringStart(script, i, dialect)) {
      if (!hasToken) segStart = i
      hasToken = true
      const end = scanQuotedSegmentEnd(script, i + 1, "'", true).end
      lastTokenEnd = end
      prevWordUpper = ''
      prevNonWsKind = 'literal'
      sawNewline = false
      i = end
      continue
    }
    const oracleQ = scanOracleQuoteEnd(script, i, dialect)
    if (oracleQ) {
      if (!hasToken) segStart = i
      hasToken = true
      lastTokenEnd = oracleQ.end
      prevWordUpper = ''
      prevNonWsKind = 'literal'
      sawNewline = false
      i = oracleQ.end
      continue
    }
    if (ch === "'" || ch === '"' || (ch === '`' && rules.backtickIdentifiers)) {
      if (!hasToken) segStart = i
      hasToken = true
      const allowBs =
        (ch === "'" && rules.backslashEscapesSingleQuote) ||
        (ch === '"' && rules.backslashEscapesDoubleQuote)
      const end = scanQuotedSegmentEnd(script, i, ch, allowBs).end
      lastTokenEnd = end
      prevWordUpper = ''
      prevNonWsKind = ch === "'" ? 'literal' : 'ident'
      sawNewline = false
      i = end
      continue
    }
    if (ch === '[' && rules.bracketIdentifiers !== 'none') {
      if (!hasToken) segStart = i
      hasToken = true
      const end = scanBracketIdentEnd(script, i, rules.bracketIdentifiers === 'doubling').end
      lastTokenEnd = end
      prevWordUpper = ''
      prevNonWsKind = 'ident'
      sawNewline = false
      i = end
      continue
    }
    if (rules.dollarQuoting && ch === '$') {
      const tag = matchDollarQuoteTag(script, i)
      if (tag !== null) {
        if (!hasToken) segStart = i
        hasToken = true
        const closeIdx = script.indexOf(tag, i + tag.length)
        const end = closeIdx >= 0 ? closeIdx + tag.length : len
        lastTokenEnd = end
        prevWordUpper = ''
        prevNonWsKind = 'literal'
        sawNewline = false
        i = end
        continue
      }
    }

    if (ch === '(') {
      if (!hasToken) segStart = i
      hasToken = true
      parenDepth++
      lastTokenEnd = i + 1
      prevWordUpper = ''
      prevNonWsKind = 'op'
      sawNewline = false
      i++
      continue
    }
    if (ch === ')') {
      if (!hasToken) segStart = i
      hasToken = true
      if (parenDepth > 0) parenDepth--
      lastTokenEnd = i + 1
      prevWordUpper = ''
      prevNonWsKind = 'close'
      sawNewline = false
      i++
      continue
    }
    if (ch === ';') {
      if (parenDepth === 0 && !hasOpenBegin() && execCommentDepth === 0) {
        flushSeg(i)
        segStart = i + 1
      }
      sawNewline = false
      i++
      continue
    }

    if (isIdentStartChar(script.charCodeAt(i))) {
      let end = i + 1
      while (end < len && isIdentContChar(script.charCodeAt(end))) end++
      const wordUpper = script.slice(i, end).toUpperCase()

      if (
        hasToken &&
        sawNewline &&
        parenDepth === 0 &&
        !hasOpenBegin() &&
        execCommentDepth === 0 &&
        UNTERM_STMT_STARTERS.has(wordUpper)
      ) {
        let isContinuation = false
        if (prevNonWsKind === 'op' || prevNonWsKind === 'comma') {
          isContinuation = true
        } else if (stmtVerb === 'WITH' && awaitingWithMainVerb && UNTERM_WITH_MAIN_VERBS.has(wordUpper)) {
          awaitingWithMainVerb = false
          isContinuation = true
        } else if (stmtVerb === 'EXPLAIN' && awaitingExplainMainVerb) {
          awaitingExplainMainVerb = false
          isContinuation = true
        } else if (
          (stmtVerb === 'INSERT' || stmtVerb === 'REPLACE') &&
          !sawValuesOrSelect &&
          (wordUpper === 'SELECT' || wordUpper === 'WITH')
        ) {
          sawValuesOrSelect = true
          isContinuation = true
        } else if (stmtVerb === 'ALTER' && (wordUpper === 'DROP' || wordUpper === 'ALTER')) {
          isContinuation = true
        } else if (UNTERM_CONTINUATION_BEFORE_STARTER.has(prevWordUpper)) {
          isContinuation = true
        }

        if (!isContinuation) {
          flushSeg(lastTokenEnd)
          segStart = i
        }
      }

      if (!hasToken) {
        segStart = i
        hasToken = true
        stmtVerb = wordUpper
        if (wordUpper === 'WITH') awaitingWithMainVerb = true
        if (wordUpper === 'EXPLAIN') awaitingExplainMainVerb = true
      } else if (parenDepth === 0) {
        if (stmtVerb === 'WITH' && awaitingWithMainVerb && UNTERM_WITH_MAIN_VERBS.has(wordUpper)) {
          awaitingWithMainVerb = false
        }
        if (
          stmtVerb === 'EXPLAIN' &&
          awaitingExplainMainVerb &&
          UNTERM_STMT_STARTERS.has(wordUpper) &&
          wordUpper !== 'EXPLAIN'
        ) {
          awaitingExplainMainVerb = false
        }
        if (
          (stmtVerb === 'INSERT' || stmtVerb === 'REPLACE') &&
          (wordUpper === 'VALUES' || wordUpper === 'SELECT' || wordUpper === 'DEFAULT')
        ) {
          sawValuesOrSelect = true
        }
      }

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

      if (
        parenDepth === 0 &&
        (isCompoundHeader || stmtVerb === 'BEGIN' || stmtVerb === 'DECLARE' || stmtVerb === 'DO')
      ) {
        if (wordUpper === 'BEGIN') {
          const nextWord = peekNextUpperWord(end)
          if (!NON_TRANSACTION_BEGIN_FOLLOWERS.has(nextWord)) {
            blockStack.push('BEGIN')
          }
        } else if (wordUpper === 'CASE' && prevWordUpper !== 'END') {
          blockStack.push('CASE')
        } else if (wordUpper === 'END') {
          const nextWord = peekNextUpperWord(end)
          if (COMPOUND_END_SUFFIX_WORDS.has(nextWord)) {
            if (nextWord === 'CASE') {
              popLastBlockEntry(blockStack, 'CASE')
            }
          } else if (blockStack.length > 0) {
            blockStack.pop()
          }
        }
      }

      lastTokenEnd = end
      prevWordUpper = wordUpper
      prevNonWsKind = 'word'
      sawNewline = false
      i = end
      continue
    }

    if (!hasToken) segStart = i
    hasToken = true
    lastTokenEnd = i + 1
    prevWordUpper = ''
    prevNonWsKind = ch === ',' ? 'comma' : /[=<>!+\-*/%|&^~:]/.test(ch) ? 'op' : 'punct'
    sawNewline = false
    i++
  }

  if (hasToken) {
    flushSeg(lastTokenEnd)
  }
  return results
}

function extractSqlStatementSignature(stmtSql, dialect) {
  const sql = String(stmtSql || '')
  const len = sql.length
  const rules = getDialectLexerRules(dialect)
  const tokens = []

  let i = 0
  while (i < len) {
    const ch = sql[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (rules.lineCommentDash && ch === '-' && i + 1 < len && sql[i + 1] === '-') {
      i = scanLineCommentEnd(sql, i)
      continue
    }
    if (rules.lineCommentSlash && ch === '/' && i + 1 < len && sql[i + 1] === '/') {
      i = scanLineCommentEnd(sql, i)
      continue
    }
    if (rules.lineCommentHash && ch === '#') {
      i = scanLineCommentEnd(sql, i - 1)
      continue
    }
    if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
      i = scanBlockCommentEnd(sql, i, rules.nestedBlockComments)
      continue
    }
    if (isPostgresEscapeStringStart(sql, i, dialect)) {
      i = scanQuotedSegmentEnd(sql, i + 1, "'", true).end
      continue
    }
    const oracleQ = scanOracleQuoteEnd(sql, i, dialect)
    if (oracleQ) {
      i = oracleQ.end
      continue
    }
    if (ch === "'") {
      i = scanQuotedSegmentEnd(sql, i, "'", rules.backslashEscapesSingleQuote).end
      continue
    }
    if (rules.dollarQuoting && ch === '$') {
      const tag = matchDollarQuoteTag(sql, i)
      if (tag !== null) {
        const closeIdx = sql.indexOf(tag, i + tag.length)
        i = closeIdx >= 0 ? closeIdx + tag.length : len
        continue
      }
    }
    if (ch === '"' || (ch === '`' && rules.backtickIdentifiers)) {
      const allowBs = ch === '"' && rules.backslashEscapesDoubleQuote
      const end = scanQuotedSegmentEnd(sql, i, ch, allowBs).end
      const bare = unquoteSqlIdent(sql.slice(i, end)).trim().toLowerCase()
      if (bare) tokens.push({ kind: 'ident', isQuoted: true, upper: bare.toUpperCase(), bare })
      i = end
      continue
    }
    if (ch === '[' && rules.bracketIdentifiers !== 'none') {
      const end = scanBracketIdentEnd(sql, i, rules.bracketIdentifiers === 'doubling').end
      const bare = unquoteSqlIdent(sql.slice(i, end)).trim().toLowerCase()
      if (bare) tokens.push({ kind: 'ident', isQuoted: true, upper: bare.toUpperCase(), bare })
      i = end
      continue
    }
    if (ch === '.') {
      tokens.push({ kind: 'dot', isQuoted: false, upper: '.', bare: '.' })
      i++
      continue
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ kind: ch === '(' ? 'lparen' : 'rparen', isQuoted: false, upper: ch, bare: ch })
      i++
      continue
    }
    if (isIdentStartChar(sql.charCodeAt(i))) {
      let end = i + 1
      while (end < len && isIdentContChar(sql.charCodeAt(end))) end++
      const raw = sql.slice(i, end)
      tokens.push({ kind: 'ident', isQuoted: false, upper: raw.toUpperCase(), bare: raw.toLowerCase() })
      i = end
      continue
    }
    i++
  }

  const verb = tokens.find((t) => t.kind === 'ident' && !t.isQuoted)?.upper || ''
  const tables = new Set()
  const idents = new Set()

  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx]
    if (t.kind !== 'ident') continue
    if (t.isQuoted || (t.bare.length >= 2 && !SQL_SIGNATURE_STOPWORDS.has(t.upper))) {
      idents.add(t.bare)
    }
    if (
      !t.isQuoted &&
      (t.upper === 'FROM' || t.upper === 'JOIN' || t.upper === 'INTO' || t.upper === 'UPDATE')
    ) {
      let k = idx + 1
      while (k < tokens.length && tokens[k].kind === 'ident' && !tokens[k].isQuoted && TABLE_INTRO_MODIFIERS.has(tokens[k].upper)) {
        k++
      }
      if (k < tokens.length && tokens[k].kind === 'ident') {
        const first = tokens[k]
        if (first.isQuoted || !SQL_SIGNATURE_STOPWORDS.has(first.upper)) {
          let tableTok = first
          while (
            k + 2 < tokens.length &&
            tokens[k + 1].kind === 'dot' &&
            tokens[k + 2].kind === 'ident'
          ) {
            k += 2
            tableTok = tokens[k]
          }
          if (tableTok.bare) tables.add(tableTok.bare)
        }
      }
    }
  }

  return { verb, tables, idents }
}

function boundedEditDistance(a, b, maxDist) {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (Math.abs(m - n) > maxDist) return maxDist + 1
  let prev = new Array(n + 1)
  let curr = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    let rowMin = curr[0]
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      const val = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      curr[j] = val
      if (val < rowMin) rowMin = val
    }
    if (rowMin > maxDist) return maxDist + 1
    const tmp = prev
    prev = curr
    curr = tmp
  }
  return prev[n]
}

function findUnambiguousAlignedStatementIndex(targetStmts, replacementSql, dialect) {
  const repSig = extractSqlStatementSignature(replacementSql, dialect)
  if (repSig.tables.size === 0) return null
  const repNorm = normalizeStmtForPreservation(replacementSql)

  const candSigs = targetStmts.map((s) => extractSqlStatementSignature(s.text, dialect))
  const scored = []
  for (let i = 0; i < targetStmts.length; i++) {
    const candSig = candSigs[i]
    let exactTableOverlap = 0
    let fuzzyTableOverlap = 0
    for (const rt of repSig.tables) {
      if (candSig.tables.has(rt)) {
        exactTableOverlap++
      } else if (rt.length >= 4) {
        for (const ct of candSig.tables) {
          if (ct.length >= 4 && boundedEditDistance(rt, ct, 2) <= 2) {
            fuzzyTableOverlap++
            break
          }
        }
      }
    }
    const tableOverlapTotal = exactTableOverlap + fuzzyTableOverlap
    if (tableOverlapTotal === 0) continue

    let identOverlap = 0
    for (const id of repSig.idents) {
      if (candSig.idents.has(id)) identOverlap++
    }
    const unionSize = repSig.idents.size + candSig.idents.size - identOverlap
    const identJaccard = unionSize > 0 ? identOverlap / unionSize : 0
    const score =
      tableOverlapTotal * 10 +
      identJaccard * 5 +
      (repSig.verb && repSig.verb === candSig.verb ? 1 : 0)

    scored.push({
      index: i,
      exactTableOverlap,
      fuzzyTableOverlap,
      tableOverlapTotal,
      identOverlap,
      identJaccard,
      isAlreadyIdentical: normalizeStmtForPreservation(targetStmts[i].text) === repNorm,
      score,
    })
  }

  if (scored.length === 0) return null
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]

  // Never overwrite a statement already normalized-equal to replacement when any sibling also overlaps
  if (best.isAlreadyIdentical && scored.length > 1) {
    return null
  }

  // Fail closed if any OTHER target statement mentions a replacement table in its identifiers
  // (e.g. `SELET * FORM rules;` where `FORM` prevented table extraction on Query 2).
  const siblingMentionsRepTable = (chosenIdx) =>
    candSigs.some((sig, idx) => {
      if (idx === chosenIdx) return false
      for (const rt of repSig.tables) {
        if (sig.tables.has(rt) || sig.idents.has(rt)) return true
      }
      return false
    })

  if (scored.length === 1) {
    if (best.exactTableOverlap > 0) {
      return siblingMentionsRepTable(best.index) ? null : best.index
    }
    if (
      best.fuzzyTableOverlap > 0 &&
      best.identOverlap >= 1 &&
      !siblingMentionsRepTable(best.index)
    ) {
      return best.index
    }
    return null
  }

  const second = scored[1]
  // Treat (exactTableOverlap + fuzzyTableOverlap) together for ambiguity so a healthy exact-table
  // sibling (`users`) can NEVER beat a typo-broken sibling (`userz`) and wipe Query 1.
  if (best.exactTableOverlap > 0 && second.fuzzyTableOverlap > 0) {
    return null
  }
  if (best.tableOverlapTotal > second.tableOverlapTotal && !best.isAlreadyIdentical) {
    return best.index
  }
  if (
    best.exactTableOverlap > 0 &&
    second.fuzzyTableOverlap === 0 &&
    !best.isAlreadyIdentical &&
    best.score - second.score >= 2.5 &&
    best.identJaccard >= 0.5
  ) {
    return best.index
  }
  return null
}

function normalizeStmtForPreservation(sql) {
  return String(sql || '')
    .trim()
    .replace(/;\s*$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/**
 * Computes a safe document edit `{ from, to, insert }` for replacing a targeted SQL span.
 * Never silently overwrites unrelated statements in a multi-statement script when target no longer matches.
 */
export function resolveSqlReplacementSpan(docText, target, nextSql, dialect = 'sqlite') {
  const replacement = String(nextSql ?? '').trim()
  if (!replacement) return null

  const text = String(docText ?? '')
  const docLen = text.length
  const resolvedDialect = dialect || 'sqlite'

  let replaceFrom = -1
  let replaceTo = -1

  if (
    target &&
    Number.isInteger(target.from) &&
    Number.isInteger(target.to) &&
    target.from >= 0 &&
    target.to >= target.from &&
    target.to <= docLen &&
    (!target.originalSlice || text.slice(target.from, target.to) === target.originalSlice)
  ) {
    replaceFrom = target.from
    replaceTo = target.to
  }

  let blockedInvalidatedIndexedTarget = false

  // Priority 1.5: Re-anchor shifted offsets by statementIndex when earlier statements changed length
  if (
    replaceFrom < 0 &&
    resolvedDialect !== 'redis' &&
    target &&
    Number.isInteger(target.statementIndex) &&
    target.statementIndex >= 0
  ) {
    const normStatementText = (s) => String(s || '').trim().replace(/;\s*$/, '').trim()
    const expectedNorm = normStatementText(target.originalSlice || target.fallbackSql || '')
    if (expectedNorm.length > 0) {
      const stmts = splitSqlStatements(text, resolvedDialect)
      const countMatches =
        !Number.isInteger(target.totalStatements) || target.totalStatements === stmts.length
      const indexedStmt = countMatches ? stmts[target.statementIndex] : null
      if (indexedStmt && normStatementText(indexedStmt.text) === expectedNorm) {
        replaceFrom = indexedStmt.start
        replaceTo = indexedStmt.end
      } else if (
        (countMatches && stmts.length > 1) ||
        (target.from === -1 && target.to === -1 && stmts.length > 1)
      ) {
        // The originally targeted statement was already modified or invalidated (e.g. duplicate re-apply).
        // Never hijack a duplicate sibling statement at a different index!
        blockedInvalidatedIndexedTarget = true
      } else if (!countMatches) {
        // Handle statementIndex derived from a sub-selection (execRange.from > 0) when unique in doc
        const exactMatches = stmts.filter((s) => normStatementText(s.text) === expectedNorm)
        if (exactMatches.length === 1) {
          replaceFrom = exactMatches[0].start
          replaceTo = exactMatches[0].end
        }
      }
    }
  }

  if (replaceFrom < 0 && !blockedInvalidatedIndexedTarget && target?.fallbackSql) {
    const needle = String(target.fallbackSql).trim()
    if (needle.length > 0) {
      const firstIdx = text.indexOf(needle)
      if (firstIdx >= 0 && text.indexOf(needle, firstIdx + 1) === -1) {
        replaceFrom = firstIdx
        replaceTo = firstIdx + needle.length
      }
    }
  }

  if (replaceFrom < 0) {
    if (blockedInvalidatedIndexedTarget) {
      return null
    }
    const trimmedDoc = text.trim()
    const fallbackTrimmed = String(target?.fallbackSql ?? '').trim()
    const matchesFallback = fallbackTrimmed.length > 0 && trimmedDoc === fallbackTrimmed
    const stmts =
      resolvedDialect === 'redis'
        ? trimmedDoc
          ? [{ text: trimmedDoc, start: 0, end: docLen }]
          : []
        : splitSqlStatements(text, resolvedDialect)
    if (matchesFallback || stmts.length <= 1) {
      replaceFrom = 0
      replaceTo = docLen
    } else {
      return null
    }
  }

  if (target?.preserveOtherStatements && resolvedDialect !== 'redis') {
    const targetSlice = text.slice(replaceFrom, replaceTo)
    const rawTargetStmts = splitSqlStatements(targetSlice, resolvedDialect)
    const effectiveTargetStmts =
      rawTargetStmts.length === 1
        ? (() => {
            const split = splitUnterminatedSqlStatements(targetSlice, resolvedDialect)
            return split.length > 1 ? split : rawTargetStmts
          })()
        : rawTargetStmts

    if (effectiveTargetStmts.length > 1) {
      const rawReplacementStmts = splitSqlStatements(replacement, resolvedDialect)
      const effectiveReplacementStmts =
        rawReplacementStmts.length === 1
          ? (() => {
              const split = splitUnterminatedSqlStatements(replacement, resolvedDialect)
              return split.length > 1 ? split : rawReplacementStmts
            })()
          : rawReplacementStmts

      if (effectiveReplacementStmts.length === 1) {
        const alignedIdx = findUnambiguousAlignedStatementIndex(
          effectiveTargetStmts,
          effectiveReplacementStmts[0].text,
          resolvedDialect
        )
        if (alignedIdx === null) {
          return null
        }
        const alignedSlice = effectiveTargetStmts[alignedIdx]
        const baseFrom = replaceFrom
        replaceFrom = baseFrom + alignedSlice.start
        replaceTo = baseFrom + alignedSlice.end
      } else if (effectiveReplacementStmts.length < effectiveTargetStmts.length) {
        return null
      } else {
        // Verify at least N-1 original sibling statements remain preserved so AI cannot silently drop Query 1
        const repFreq = new Map()
        for (const rs of effectiveReplacementStmts) {
          const norm = normalizeStmtForPreservation(rs.text)
          if (!norm) continue
          repFreq.set(norm, (repFreq.get(norm) || 0) + 1)
        }
        let preservedCount = 0
        for (const ts of effectiveTargetStmts) {
          const norm = normalizeStmtForPreservation(ts.text)
          const avail = repFreq.get(norm) || 0
          if (avail > 0) {
            preservedCount++
            repFreq.set(norm, avail - 1)
          }
        }
        if (preservedCount < effectiveTargetStmts.length - 1) {
          return null
        }
      }
    }
  }

  let finalInsert = replacement
  if (resolvedDialect !== 'redis') {
    if (!finalInsert.endsWith(';')) {
      const spanText = text.slice(replaceFrom, replaceTo)
      const trimmedSpanLen = spanText.trimEnd().length
      if (trimmedSpanLen > 0 && spanText[trimmedSpanLen - 1] === ';') {
        replaceTo = replaceFrom + trimmedSpanLen - 1
      } else if (target?.preserveOtherStatements) {
        const trailingText = text.slice(replaceTo)
        const trimmedTrailing = trailingText.trimStart()
        if (
          trimmedTrailing.length > 0 &&
          trimmedTrailing[0] !== ';' &&
          splitSqlStatements(trailingText, resolvedDialect).length > 0
        ) {
          finalInsert = `${finalInsert};`
        }
      }
    } else if (replaceTo < docLen && text[replaceTo] === ';') {
      replaceTo += 1
    }
  }

  return { from: replaceFrom, to: replaceTo, insert: finalInsert }
}

/**
 * Remaps a stored SQL statement target range after an earlier or sibling document edit.
 */
export function remapSqlTargetRange(target, editFrom, editTo, insertLen) {
  if (
    !target ||
    !Number.isInteger(target.from) ||
    !Number.isInteger(target.to) ||
    target.from < 0 ||
    target.to < target.from
  ) {
    return target
  }
  if (target.to <= editFrom) {
    return target
  }
  const delta = insertLen - (editTo - editFrom)
  if (target.from >= editTo) {
    return {
      ...target,
      from: target.from + delta,
      to: target.to + delta,
    }
  }
  return {
    ...target,
    from: -1,
    to: -1,
  }
}

/**
 * Strips leading SQL comments while stopping before MySQL executable comments (`/*!50001 ...`).
 */
export function stripLeadingSqlComments(sql, dialect) {
  const rules = getDialectLexerRules(dialect)
  const len = sql.length
  let i = 0
  while (i < len) {
    while (i < len && /\s/.test(sql[i])) i++
    if (i >= len) break
    if (rules.lineCommentDash && sql[i] === '-' && i + 1 < len && sql[i + 1] === '-') {
      i = scanLineCommentEnd(sql, i)
      continue
    }
    if (rules.lineCommentSlash && sql[i] === '/' && i + 1 < len && sql[i + 1] === '/') {
      i = scanLineCommentEnd(sql, i)
      continue
    }
    if (rules.lineCommentHash && sql[i] === '#') {
      i = scanLineCommentEnd(sql, i - 1)
      continue
    }
    if (sql[i] === '/' && i + 1 < len && sql[i + 1] === '*') {
      if (matchMysqlExecCommentPrefix(sql, i, dialect) > 0) {
        break
      }
      i = scanBlockCommentEnd(sql, i, rules.nestedBlockComments)
      continue
    }
    break
  }
  return sql.slice(i)
}

export function stripCommentsAndLiteralsDetailed(sql, dialect, options = {}) {
  const rules = getDialectLexerRules(dialect)
  const preserveMysqlExecComments = options.preserveMysqlExecComments ?? true
  const literalPlaceholder = options.literalPlaceholder ?? ' '
  const identPlaceholder = options.identPlaceholder ?? literalPlaceholder
  const allowBsSingle =
    typeof options.backslashOverride === 'boolean'
      ? options.backslashOverride
      : rules.backslashEscapesSingleQuote
  const allowBsDouble =
    typeof options.backslashOverride === 'boolean'
      ? options.backslashOverride && rules.backslashEscapesDoubleQuote
      : rules.backslashEscapesDoubleQuote

  let out = ''
  let i = 0
  let execCommentDepth = 0
  let hasUnclosedQuote = false
  let hasUnclosedComment = false
  const len = sql.length

  while (i < len) {
    const ch = sql[i]
    if (rules.lineCommentDash && ch === '-' && i + 1 < len && sql[i + 1] === '-') {
      out += ' '
      i = scanLineCommentEnd(sql, i)
      continue
    }
    if (rules.lineCommentSlash && ch === '/' && i + 1 < len && sql[i + 1] === '/') {
      out += ' '
      i = scanLineCommentEnd(sql, i)
      continue
    }
    if (rules.lineCommentHash && ch === '#') {
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
      const block = scanBlockCommentWithState(sql, i, rules.nestedBlockComments)
      if (!block.closed) hasUnclosedComment = true
      i = block.end
      continue
    }
    if (isPostgresEscapeStringStart(sql, i, dialect)) {
      out += literalPlaceholder
      const seg = scanQuotedSegmentEnd(sql, i + 1, "'", true)
      if (!seg.closed) hasUnclosedQuote = true
      i = seg.end
      continue
    }
    const oracleQuote = scanOracleQuoteEnd(sql, i, dialect)
    if (oracleQuote) {
      out += literalPlaceholder
      if (!oracleQuote.closed) hasUnclosedQuote = true
      i = oracleQuote.end
      continue
    }
    if (ch === "'" || ch === '"' || (ch === '`' && rules.backtickIdentifiers)) {
      out += ch === "'" ? literalPlaceholder : identPlaceholder
      const allowBackslash = ch === "'" ? allowBsSingle : ch === '"' ? allowBsDouble : false
      const seg = scanQuotedSegmentEnd(sql, i, ch, allowBackslash)
      if (!seg.closed) hasUnclosedQuote = true
      i = seg.end
      continue
    }
    if (ch === '[' && rules.bracketIdentifiers !== 'none') {
      out += identPlaceholder
      const seg = scanBracketIdentEnd(sql, i, rules.bracketIdentifiers === 'doubling')
      if (!seg.closed) hasUnclosedQuote = true
      i = seg.end
      continue
    }
    if (rules.dollarQuoting && ch === '$') {
      const tag = matchDollarQuoteTag(sql, i)
      if (tag !== null) {
        out += literalPlaceholder
        const closeIdx = sql.indexOf(tag, i + tag.length)
        if (closeIdx < 0) hasUnclosedQuote = true
        i = closeIdx >= 0 ? closeIdx + tag.length : len
        continue
      }
    }
    out += ch
    i++
  }

  if (execCommentDepth > 0) {
    hasUnclosedComment = true
  }

  return { text: out, hasUnclosedQuote, hasUnclosedComment }
}

export function stripCommentsAndLiterals(sql, dialect, preserveMysqlExecComments = true) {
  return stripCommentsAndLiteralsDetailed(sql, dialect, { preserveMysqlExecComments }).text
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

const MONGO_DDL_METHODS = new Set([
  'createCollection',
  'createView',
  'drop',
  'renameCollection',
  'createIndex',
  'createIndexes',
  'dropIndex',
  'dropIndexes',
  'dropDatabase',
])

const MONGO_DDL_JSON_KEYS = new Set([
  'create',
  'createIndexes',
  'drop',
  'dropIndexes',
  'dropDatabase',
  'renameCollection',
  'collMod',
])

function tokenizeMongoCode(text) {
  const tokens = []
  let i = 0
  let prevKind = 'start'
  while (i < text.length) {
    const tok = advanceMongoJsToken(text, i, prevKind)
    if (tok.kind !== 'ws' && tok.kind !== 'comment') {
      tokens.push({ kind: tok.kind, text: tok.text })
    }
    prevKind = tok.nextPrevKind
    i = tok.end
  }
  return tokens
}

function unquoteMongoKeyToken(tok) {
  if (!tok) return ''
  if (tok.kind === 'ident') return tok.text
  if (tok.kind === 'string' && tok.text.length >= 2) {
    return tok.text.slice(1, -1)
  }
  return ''
}

function isMongoDdlStatement(stmtText) {
  const tokens = tokenizeMongoCode(stmtText)
  if (tokens.length === 0) return false
  if (tokens[0].text === '{') {
    const key = unquoteMongoKeyToken(tokens[1])
    return MONGO_DDL_JSON_KEYS.has(key) && tokens[2]?.text === ':'
  }
  if (tokens[0].text !== 'db') return false
  if (
    tokens[1]?.text === '.' &&
    (tokens[2]?.text === 'runCommand' || tokens[2]?.text === 'adminCommand') &&
    tokens[3]?.text === '(' &&
    tokens[4]?.text === '{'
  ) {
    const key = unquoteMongoKeyToken(tokens[5])
    if (MONGO_DDL_JSON_KEYS.has(key) && tokens[6]?.text === ':') return true
  }
  let parenDepth = 0
  let braceDepth = 0
  for (let k = 1; k < tokens.length - 1; k++) {
    const t = tokens[k].text
    if (t === '{') {
      braceDepth++
      continue
    }
    if (t === '}') {
      if (braceDepth > 0) braceDepth--
      continue
    }
    if (t === '(') {
      parenDepth++
      continue
    }
    if (t === ')') {
      if (parenDepth > 0) parenDepth--
      continue
    }
    if (
      parenDepth === 0 &&
      braceDepth === 0 &&
      tokens[k - 1].text === '.' &&
      MONGO_DDL_METHODS.has(t) &&
      tokens[k + 1].text === '('
    ) {
      return true
    }
  }
  return false
}

/**
 * Detects whether a SQL script contains any DDL or schema-altering statement
 * (`CREATE`, `ALTER`, `DROP`, `RENAME`, `TRUNCATE`, `VACUUM`, `ATTACH`, `DETACH`),
 * ignoring comments and quoted string/identifier literals.
 */
export function containsDdlStatement(sql, dialect) {
  if (!sql || !sql.trim() || dialect === 'redis') return false
  const statements = splitSqlStatements(sql, dialect)
  const list = statements.length > 0 ? statements.map((s) => s.text) : [sql]
  if (dialect === 'mongodb') {
    return list.some((stmtText) => isMongoDdlStatement(stmtText))
  }
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
  /\b(?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|UNION|EXEC|EXECUTE|TRUNCATE|REPLACE|MERGE|GRANT|REVOKE|CALL|DO|COPY|LOAD|SET|VACUUM)\b/i

function isSafeSingleQuotedLiteralBothModes(val) {
  if (!val || val.length < 2 || val[0] !== "'") return false
  const noBs = scanQuotedSegmentEnd(val, 0, "'", false)
  if (!noBs.closed || noBs.end !== val.length) return false
  const withBs = scanQuotedSegmentEnd(val, 0, "'", true)
  return withBs.closed && withBs.end === val.length
}

function hasUnquotedForbiddenDefaultToken(val) {
  for (const allowBs of [false, true]) {
    let i = 0
    const len = val.length
    while (i < len) {
      const ch = val[i]
      if (ch === "'") {
        const seg = scanQuotedSegmentEnd(val, i, "'", allowBs)
        if (!seg.closed) return true
        i = seg.end
        continue
      }
      if (ch === ';' || ch === '\r' || ch === '\n' || ch === '\0' || ch === '#') {
        return true
      }
      if (ch === '-' && i + 1 < len && val[i + 1] === '-') return true
      if (ch === '/' && i + 1 < len && (val[i + 1] === '*' || val[i + 1] === '/')) return true
      if (ch === '*' && i + 1 < len && val[i + 1] === '/') return true
      i++
    }
  }
  return false
}

function hasBalancedParensBothModes(input, singleOuterGroupOnly = false) {
  for (const allowBs of [false, true]) {
    let depth = 0
    let i = 0
    const len = input.length
    while (i < len) {
      const ch = input[i]
      if (ch === "'") {
        const seg = scanQuotedSegmentEnd(input, i, "'", allowBs)
        if (!seg.closed) return false
        i = seg.end
        continue
      }
      if (ch === '(') {
        depth++
      } else if (ch === ')') {
        depth--
        if (depth < 0) return false
        if (singleOuterGroupOnly && depth === 0 && i < len - 1) return false
      }
      i++
    }
    if (depth !== 0) return false
  }
  return true
}

function isSafeMysqlEnumOrSetBothModes(cleaned) {
  const header = /^(?:ENUM|SET)\s*\(/i.exec(cleaned)
  if (!header || !cleaned.endsWith(')')) return false
  const inner = cleaned.slice(header[0].length, -1).trim()
  if (!inner) return false
  for (const allowBs of [false, true]) {
    let i = 0
    const len = inner.length
    let count = 0
    while (i < len) {
      while (i < len && /\s/.test(inner[i])) i++
      if (i >= len || inner[i] !== "'") return false
      const seg = scanQuotedSegmentEnd(inner, i, "'", allowBs)
      if (!seg.closed) return false
      const lit = inner.slice(i, seg.end)
      if (FORBIDDEN_DEFAULT_TOKENS.test(lit) || !isSafeSingleQuotedLiteralBothModes(lit)) {
        return false
      }
      count++
      i = seg.end
      while (i < len && /\s/.test(inner[i])) i++
      if (i < len) {
        if (inner[i] !== ',') return false
        i++
        while (i < len && /\s/.test(inner[i])) i++
        if (i >= len) return false
      }
    }
    if (count === 0) return false
  }
  return true
}

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
  return isSafeSingleQuotedLiteralBothModes(val)
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
    if (!hasBalancedParensBothModes(trimmed, true) || hasUnquotedForbiddenDefaultToken(trimmed)) {
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
    if (
      !hasBalancedParensBothModes(trimmed) ||
      hasUnquotedForbiddenDefaultToken(trimmed) ||
      FORBIDDEN_SUBQUERY_VERBS.test(trimmed)
    ) {
      throw new Error(`Invalid SQL default function expression: ${trimmed}`)
    }
    return trimmed
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    if (isNumericOrBooleanTypeName(dataType)) {
      throw new Error(`Numeric/boolean column cannot use string default ${trimmed}.`)
    }
    const inner = trimmed.slice(1, -1).replace(/'/g, "''")
    const quoted = `'${inner}'`
    if (!isSafeSingleQuotedLiteralBothModes(quoted)) {
      throw new Error(`Invalid SQL default expression: ${trimmed}`)
    }
    return quoted
  }

  if (trimmed.includes('#') || trimmed.includes("'") || trimmed.includes('\\')) {
    const quoted = `'${trimmed.replace(/'/g, "''")}'`
    if (
      isSafeSingleQuotedLiteralBothModes(quoted) &&
      !trimmed.startsWith("'") &&
      !isNumericOrBooleanTypeName(dataType) &&
      !/\b(?:OR|AND|SELECT|UNION)\b/i.test(trimmed)
    ) {
      return quoted
    }
    throw new Error(`Invalid SQL default expression: ${trimmed}`)
  }

  if (isNumericOrBooleanTypeName(dataType)) {
    throw new Error(`Invalid default "${trimmed}" for numeric/boolean type "${dataType}".`)
  }

  if (FORBIDDEN_SUBQUERY_VERBS.test(trimmed)) {
    throw new Error(`Invalid SQL keyword in default expression: ${trimmed}`)
  }

  const wrapped = `'${trimmed.replace(/'/g, "''")}'`
  if (!isSafeSingleQuotedLiteralBothModes(wrapped)) {
    throw new Error(`Invalid SQL default expression: ${trimmed}`)
  }
  return wrapped
}

export function validateColumnTypeSpec(rawType) {
  const cleaned = (rawType || '').trim()
  if (!cleaned) {
    throw new Error('Column data type is required.')
  }
  if (/^(?:ENUM|SET)\s*\(/i.test(cleaned)) {
    if (
      FORBIDDEN_DEFAULT_TOKENS.test(cleaned) ||
      hasUnquotedForbiddenDefaultToken(cleaned) ||
      !isSafeMysqlEnumOrSetBothModes(cleaned)
    ) {
      throw new Error(`Invalid SQL column type: ${rawType}`)
    }
    return cleaned
  }
  if (FORBIDDEN_DEFAULT_TOKENS.test(cleaned) || cleaned.includes('#')) {
    throw new Error(`Invalid SQL column type: ${rawType}`)
  }
  const isSchemaQualifiedOrPlainType =
    /^(?:(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\.)?(?:"(?:[^"]|"")+"(?:\s*\[\])*|[A-Za-z][A-Za-z0-9_(),\s[\]]*)$/.test(
      cleaned
    )
  if (!isSchemaQualifiedOrPlainType || !hasBalancedParens(cleaned)) {
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
  'FILTER',
  'WITHIN',
  'LATERAL',
  'RANGE',
  'GROUPS',
  'UNBOUNDED',
  'PRECEDING',
  'FOLLOWING',
  'CURRENT',
  'ROW',
  'MATERIALIZED',
  'INTERVAL',
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
  'GROUP',
  'JOIN',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'EXISTS',
  'OVER',
  'FILTER',
  'WITHIN',
  'LATERAL',
  'MATERIALIZED',
  'BETWEEN',
  'CONFLICT',
  'ALL',
  'EXPLAIN',
  'KEY',
  'UNIQUE',
  'TABLE',
  'RETURNING',
])

const CLAUSE_LIST_STOP_KEYWORDS = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP',
  'ORDER',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'WINDOW',
  'FETCH',
  'FOR',
  'INTO',
  'RETURNING',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'NATURAL',
  'SET',
  'VALUES',
])

const WINDOW_SPEC_CLAUSE_KEYWORDS = new Set(['PARTITION', 'ORDER', 'ROWS', 'RANGE', 'GROUPS'])
const QUERY_START_KEYWORDS = new Set(['SELECT', 'WITH', 'VALUES'])
const CTE_START_KEYWORDS = new Set(['SELECT', 'WITH', 'VALUES', 'INSERT', 'UPDATE', 'DELETE'])

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

const FORMAT_THREE_CHAR_OPS = new Set(['->>', '#>>', '<=>', '!~*', '<->'])
const FORMAT_TWO_CHAR_OPS = new Set([
  ':=',
  '=>',
  '->',
  '#>',
  '@>',
  '<@',
  '~*',
  '!~',
  '<=',
  '>=',
  '<>',
  '!=',
  '||',
  '&&',
  '<<',
  '>>',
  '^@',
  '?|',
  '?&',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
])

const FORMAT_STRING_PREFIX_CHARS = new Set(['N', 'n', 'X', 'x', 'B', 'b'])

function isUnicodeFormatIdentStart(sql, idx) {
  const code = sql.charCodeAt(idx)
  return isIdentStartChar(code) || (code >= 0x80 && !/\s/.test(sql[idx]))
}

function isUnicodeFormatIdentCont(sql, idx) {
  const code = sql.charCodeAt(idx)
  return isIdentContChar(code) || code === 36 || (code >= 0x80 && !/\s/.test(sql[idx]))
}

function scanNumericTokenEnd(sql, start) {
  const len = sql.length
  let end = start
  if (sql[end] === '0' && end + 1 < len && (sql[end + 1] === 'x' || sql[end + 1] === 'X')) {
    let hexEnd = end + 2
    while (hexEnd < len && /[0-9A-Fa-f_]/.test(sql[hexEnd])) hexEnd++
    if (hexEnd > end + 2) return hexEnd
  }
  if (sql[end] === '0' && end + 1 < len && (sql[end + 1] === 'b' || sql[end + 1] === 'B')) {
    let binEnd = end + 2
    while (binEnd < len && /[01_]/.test(sql[binEnd])) binEnd++
    if (binEnd > end + 2) return binEnd
  }
  if (sql[end] === '.') {
    end++
    while (end < len && /[0-9_]/.test(sql[end])) end++
  } else {
    while (end < len && /[0-9_]/.test(sql[end])) end++
    if (end < len && sql[end] === '.' && end + 1 < len && /[0-9]/.test(sql[end + 1])) {
      end++
      while (end < len && /[0-9_]/.test(sql[end])) end++
    }
  }
  if (end < len && (sql[end] === 'e' || sql[end] === 'E')) {
    let exp = end + 1
    if (exp < len && (sql[exp] === '+' || sql[exp] === '-')) exp++
    if (exp < len && /[0-9]/.test(sql[exp])) {
      while (exp < len && /[0-9_]/.test(sql[exp])) exp++
      end = exp
    }
  }
  return end
}

function tokenizeSqlForFormat(sql, dialect, options = {}) {
  const tokens = []
  const len = sql.length
  const rules = getDialectLexerRules(dialect)
  const allowBsSingle =
    typeof options.backslashOverride === 'boolean'
      ? options.backslashOverride
      : rules.backslashEscapesSingleQuote
  const allowBsDouble =
    typeof options.backslashOverride === 'boolean'
      ? options.backslashOverride && rules.backslashEscapesDoubleQuote
      : rules.backslashEscapesDoubleQuote
  const mergeUnarySign = options.mergeUnarySign ?? true
  let i = 0
  let sawNewlineBefore = false

  const pushTok = (tok) => {
    tok.hadNewlineBefore = sawNewlineBefore
    tokens.push(tok)
    sawNewlineBefore = false
  }

  while (i < len) {
    const ch = sql[i]
    if (/\s/.test(ch)) {
      if (ch === '\n' || ch === '\r') sawNewlineBefore = true
      i++
      continue
    }
    if (rules.lineCommentDash && ch === '-' && i + 1 < len && sql[i + 1] === '-') {
      const end = scanLineCommentEnd(sql, i)
      const text = sql.slice(i, end).replace(/[\r\n]+$/, '')
      pushTok({ kind: 'line_comment', text, upper: '' })
      if (end < len || sql.slice(i, end).includes('\n')) sawNewlineBefore = true
      i = end
      continue
    }
    if (rules.lineCommentSlash && ch === '/' && i + 1 < len && sql[i + 1] === '/') {
      const end = scanLineCommentEnd(sql, i)
      const text = sql.slice(i, end).replace(/[\r\n]+$/, '')
      pushTok({ kind: 'line_comment', text, upper: '' })
      if (end < len || sql.slice(i, end).includes('\n')) sawNewlineBefore = true
      i = end
      continue
    }
    if (rules.lineCommentHash && ch === '#') {
      const end = scanLineCommentEnd(sql, i - 1)
      const text = sql.slice(i, end).replace(/[\r\n]+$/, '')
      pushTok({ kind: 'line_comment', text, upper: '' })
      if (end < len || sql.slice(i, end).includes('\n')) sawNewlineBefore = true
      i = end
      continue
    }
    if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
      const end = scanBlockCommentEnd(sql, i, rules.nestedBlockComments)
      pushTok({ kind: 'block_comment', text: sql.slice(i, end), upper: '' })
      i = end
      continue
    }
    if (isPostgresEscapeStringStart(sql, i, dialect)) {
      const end = scanQuotedSegmentEnd(sql, i + 1, "'", true).end
      pushTok({ kind: 'quoted', text: sql.slice(i, end), upper: '' })
      i = end
      continue
    }
    if (
      (ch === 'U' || ch === 'u') &&
      i + 2 < len &&
      sql[i + 1] === '&' &&
      sql[i + 2] === "'" &&
      (i === 0 || !isIdentContChar(sql.charCodeAt(i - 1)))
    ) {
      const end = scanQuotedSegmentEnd(sql, i + 2, "'", allowBsSingle).end
      pushTok({ kind: 'quoted', text: sql.slice(i, end), upper: '' })
      i = end
      continue
    }
    if (
      FORMAT_STRING_PREFIX_CHARS.has(ch) &&
      i + 1 < len &&
      sql[i + 1] === "'" &&
      (i === 0 || !isIdentContChar(sql.charCodeAt(i - 1)))
    ) {
      const end = scanQuotedSegmentEnd(sql, i + 1, "'", allowBsSingle).end
      pushTok({ kind: 'quoted', text: sql.slice(i, end), upper: '' })
      i = end
      continue
    }
    const oracleQuote = scanOracleQuoteEnd(sql, i, dialect)
    if (oracleQuote) {
      pushTok({ kind: 'quoted', text: sql.slice(i, oracleQuote.end), upper: '' })
      i = oracleQuote.end
      continue
    }
    if (ch === "'" || ch === '"' || (ch === '`' && rules.backtickIdentifiers)) {
      const allowBackslash = ch === "'" ? allowBsSingle : ch === '"' ? allowBsDouble : false
      const end = scanQuotedSegmentEnd(sql, i, ch, allowBackslash).end
      pushTok({ kind: 'quoted', text: sql.slice(i, end), upper: '' })
      i = end
      continue
    }
    if (ch === '[' && rules.bracketIdentifiers !== 'none') {
      const end = scanBracketIdentEnd(sql, i, rules.bracketIdentifiers === 'doubling').end
      pushTok({ kind: 'quoted', text: sql.slice(i, end), upper: '' })
      i = end
      continue
    }
    if (ch === '$') {
      if (rules.dollarQuoting) {
        const tag = matchDollarQuoteTag(sql, i)
        if (tag !== null) {
          const closeIdx = sql.indexOf(tag, i + tag.length)
          const end = closeIdx >= 0 ? closeIdx + tag.length : len
          pushTok({ kind: 'quoted', text: sql.slice(i, end), upper: '' })
          i = end
          continue
        }
      }
      if (i + 1 < len && /[0-9]/.test(sql[i + 1])) {
        let end = i + 2
        while (end < len && /[0-9]/.test(sql[end])) end++
        const text = sql.slice(i, end)
        pushTok({ kind: 'param', text, upper: text })
        i = end
        continue
      }
    }
    if (ch === '@' && i + 1 < len) {
      let varStart = i + 1
      if (sql[varStart] === '@') varStart++
      if (varStart < len && isIdentStartChar(sql.charCodeAt(varStart))) {
        let end = varStart + 1
        while (end < len && (isIdentContChar(sql.charCodeAt(end)) || sql[end] === '$' || sql[end] === '#')) {
          end++
        }
        const text = sql.slice(i, end)
        pushTok({ kind: 'param', text, upper: text })
        i = end
        continue
      }
    }
    if (!rules.lineCommentHash && ch === '#' && i + 1 < len) {
      let tempStart = i + 1
      if (sql[tempStart] === '#') tempStart++
      if (tempStart < len && isIdentStartChar(sql.charCodeAt(tempStart))) {
        let end = tempStart + 1
        while (end < len && (isIdentContChar(sql.charCodeAt(end)) || sql[end] === '$' || sql[end] === '#')) {
          end++
        }
        const text = sql.slice(i, end)
        pushTok({ kind: 'quoted', text, upper: text.toUpperCase() })
        i = end
        continue
      }
    }
    if (ch === ':' && i + 1 < len && sql[i + 1] === ':') {
      pushTok({ kind: 'cast', text: '::', upper: '::' })
      i += 2
      continue
    }
    if (ch === ':' && i + 1 < len && sql[i + 1] === '=') {
      pushTok({ kind: 'other', text: ':=', upper: ':=' })
      i += 2
      continue
    }
    if (ch === ':' && i + 1 < len && isIdentStartChar(sql.charCodeAt(i + 1))) {
      let end = i + 2
      while (end < len && isIdentContChar(sql.charCodeAt(end))) end++
      const text = sql.slice(i, end)
      pushTok({ kind: 'param', text, upper: text })
      i = end
      continue
    }
    if (ch === '(') {
      pushTok({ kind: 'paren_open', text: '(', upper: '(' })
      i++
      continue
    }
    if (ch === ')') {
      pushTok({ kind: 'paren_close', text: ')', upper: ')' })
      i++
      continue
    }
    if (ch === ',') {
      pushTok({ kind: 'comma', text: ',', upper: ',' })
      i++
      continue
    }
    if (ch === ';') {
      pushTok({ kind: 'semicolon', text: ';', upper: ';' })
      i++
      continue
    }
    if (ch === '.') {
      const prevIdx = findPrevNonCommentIndex(tokens, tokens.length)
      const prev = prevIdx >= 0 ? tokens[prevIdx] : null
      const canStartDecimal =
        i + 1 < len &&
        /[0-9]/.test(sql[i + 1]) &&
        (!prev ||
          (prev.kind !== 'word' &&
            prev.kind !== 'quoted' &&
            prev.kind !== 'number' &&
            prev.kind !== 'param' &&
            prev.kind !== 'paren_close'))
      if (canStartDecimal) {
        const end = scanNumericTokenEnd(sql, i)
        const text = sql.slice(i, end)
        pushTok({ kind: 'number', text, upper: text })
        i = end
        continue
      }
      pushTok({ kind: 'dot', text: '.', upper: '.' })
      i++
      continue
    }
    if (isUnicodeFormatIdentStart(sql, i)) {
      let end = i + 1
      while (end < len && isUnicodeFormatIdentCont(sql, end)) {
        end++
      }
      const text = sql.slice(i, end)
      pushTok({ kind: 'word', text, upper: text.toUpperCase() })
      i = end
      continue
    }
    if (/[0-9]/.test(ch)) {
      const end = scanNumericTokenEnd(sql, i)
      const text = sql.slice(i, end)
      pushTok({ kind: 'number', text, upper: text })
      i = end
      continue
    }
    const three = i + 2 < len ? sql.slice(i, i + 3) : ''
    if (three && FORMAT_THREE_CHAR_OPS.has(three)) {
      pushTok({ kind: 'other', text: three, upper: three })
      i += 3
      continue
    }
    const two = i + 1 < len ? sql.slice(i, i + 2) : ''
    if (two && FORMAT_TWO_CHAR_OPS.has(two)) {
      pushTok({ kind: 'other', text: two, upper: two })
      i += 2
      continue
    }
    if (
      mergeUnarySign &&
      (ch === '-' || ch === '+') &&
      i + 1 < len &&
      (/[0-9]/.test(sql[i + 1]) || (sql[i + 1] === '.' && i + 2 < len && /[0-9]/.test(sql[i + 2]))) &&
      isUnarySignContext(tokens)
    ) {
      const end = scanNumericTokenEnd(sql, i + 1)
      const text = sql.slice(i, end)
      pushTok({ kind: 'number', text, upper: text })
      i = end
      continue
    }
    pushTok({ kind: 'other', text: ch, upper: ch })
    i++
  }

  return tokens
}

function readsTheSameForFormat(originalSql, formattedSql, dialect) {
  for (const backslashOverride of [false, true]) {
    const a = tokenizeSqlForFormat(originalSql, dialect, {
      backslashOverride,
      mergeUnarySign: false,
    })
    const b = tokenizeSqlForFormat(formattedSql, dialect, {
      backslashOverride,
      mergeUnarySign: false,
    })
    if (a.length !== b.length) return false
    for (let idx = 0; idx < a.length; idx++) {
      const ta = a[idx]
      const tb = b[idx]
      if (ta.kind !== tb.kind) return false
      if (ta.kind === 'word') {
        if (ta.text.toLowerCase() !== tb.text.toLowerCase()) return false
      } else if (ta.text !== tb.text) {
        return false
      }
    }
  }
  return true
}

function matchCompoundClauseLength(tokens, index) {
  const t0 = tokens[index]
  const t1 = tokens[index + 1]
  const t2 = tokens[index + 2]

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

function findPrevNonCommentIndex(tokens, beforeIndex) {
  let idx = beforeIndex - 1
  while (idx >= 0 && (tokens[idx].kind === 'line_comment' || tokens[idx].kind === 'block_comment')) {
    idx--
  }
  return idx
}

function isPrecededByCteAs(tokens, openParenIndex) {
  const prevIdx = findPrevNonCommentIndex(tokens, openParenIndex)
  if (prevIdx < 0 || tokens[prevIdx].kind !== 'word') return false
  const upper = tokens[prevIdx].upper
  if (upper === 'AS') return true
  if (upper !== 'MATERIALIZED') return false

  const beforeMatIdx = findPrevNonCommentIndex(tokens, prevIdx)
  if (beforeMatIdx < 0 || tokens[beforeMatIdx].kind !== 'word') return false
  if (tokens[beforeMatIdx].upper === 'AS') return true
  if (tokens[beforeMatIdx].upper === 'NOT') {
    const beforeNotIdx = findPrevNonCommentIndex(tokens, beforeMatIdx)
    return beforeNotIdx >= 0 && tokens[beforeNotIdx].kind === 'word' && tokens[beforeNotIdx].upper === 'AS'
  }
  return false
}

function countWindowClausesInParen(tokens, openParenIndex) {
  let depth = 0
  let count = 0
  let prevNonComment = null
  for (let j = openParenIndex + 1; j < tokens.length; j++) {
    const tok = tokens[j]
    if (tok.kind === 'line_comment' || tok.kind === 'block_comment') continue
    if (tok.kind === 'paren_open') {
      depth++
    } else if (tok.kind === 'paren_close') {
      if (depth === 0) break
      depth--
    } else if (
      depth === 0 &&
      tok.kind === 'word' &&
      prevNonComment?.kind !== 'dot' &&
      WINDOW_SPEC_CLAUSE_KEYWORDS.has(tok.upper)
    ) {
      count++
      if (count >= 2) return count
    }
    prevNonComment = tok
  }
  return count
}

function findNextNonCommentIndex(tokens, afterIndex) {
  let idx = afterIndex + 1
  while (idx < tokens.length && (tokens[idx].kind === 'line_comment' || tokens[idx].kind === 'block_comment')) {
    idx++
  }
  return idx
}

function classifyOpenParen(tokens, openParenIndex, currentFrame) {
  const firstIdx = findNextNonCommentIndex(tokens, openParenIndex)
  const firstTok = tokens[firstIdx]
  const isCteBody =
    currentFrame.kind === 'query' &&
    currentFrame.inWithBlock &&
    isPrecededByCteAs(tokens, openParenIndex)

  if (firstTok && firstTok.kind === 'word') {
    if (QUERY_START_KEYWORDS.has(firstTok.upper)) {
      return { kind: 'query', isCteBody }
    }
    if (isCteBody && CTE_START_KEYWORDS.has(firstTok.upper)) {
      return { kind: 'query', isCteBody: true }
    }
  }

  const prevIdx = findPrevNonCommentIndex(tokens, openParenIndex)
  if (
    prevIdx >= 0 &&
    tokens[prevIdx].kind === 'word' &&
    tokens[prevIdx].upper === 'OVER' &&
    countWindowClausesInParen(tokens, openParenIndex) >= 2
  ) {
    return { kind: 'window', isCteBody: false }
  }

  return { kind: 'expr', isCteBody: false }
}

function clauseListHasTopLevelComma(tokens, clauseEndIndex, allowSelectModifier = false) {
  let depth = 0
  let i = clauseEndIndex + 1
  if (allowSelectModifier) {
    i = findNextNonCommentIndex(tokens, clauseEndIndex)
    if (
      i < tokens.length &&
      tokens[i].kind === 'word' &&
      (tokens[i].upper === 'DISTINCT' || tokens[i].upper === 'ALL')
    ) {
      i++
    }
  }
  let prevNonComment = null
  while (i < tokens.length) {
    const tok = tokens[i]
    if (tok.kind === 'line_comment' || tok.kind === 'block_comment') {
      i++
      continue
    }
    if (tok.kind === 'paren_open') {
      depth++
    } else if (tok.kind === 'paren_close') {
      if (depth === 0) return false
      depth--
    } else if (depth === 0) {
      if (tok.kind === 'comma') return true
      if (tok.kind === 'semicolon') return false
      if (
        tok.kind === 'word' &&
        prevNonComment?.kind !== 'dot' &&
        CLAUSE_LIST_STOP_KEYWORDS.has(tok.upper)
      ) {
        if (tok.upper === 'GROUP' || tok.upper === 'ORDER') {
          const nextIdx = findNextNonCommentIndex(tokens, i)
          if (nextIdx >= tokens.length || tokens[nextIdx].kind !== 'word' || tokens[nextIdx].upper !== 'BY') {
            prevNonComment = tok
            i++
            continue
          }
        }
        return false
      }
    }
    prevNonComment = tok
    i++
  }
  return false
}

function createFormatFrame(kind, baseIndent, indent, isCteBody = false) {
  return {
    kind,
    baseIndent,
    indent,
    lineIndent: indent,
    inMultiList: false,
    inBetween: false,
    afterJoin: false,
    inWithBlock: false,
    isCteBody,
    caseDepth: 0,
  }
}

/**
 * Lightweight dialect-aware SQL formatter that uppercases major keywords and formats
 * major clauses, CTEs, subqueries, window specs, JOIN ON conditions, multi-column lists,
 * and comments on clean indented lines while strictly preserving strings, identifiers,
 * dollar-quotes, casts, unary signs, and multi-statement boundaries.
 */
export function formatSql(sql, dialect = 'postgres') {
  if (!sql || !sql.trim()) return ''
  const trimmedSql = sql.trim()
  if (dialect === 'redis' || dialect === 'mongodb') {
    return trimmedSql
  }
  const inputScan = stripCommentsAndLiteralsDetailed(trimmedSql, dialect)
  if (inputScan.hasUnclosedQuote || inputScan.hasUnclosedComment) {
    return trimmedSql
  }

  const rules = getDialectLexerRules(dialect)
  const tokens = tokenizeSqlForFormat(trimmedSql, dialect)
  const makeIndent = (level) => '  '.repeat(Math.max(0, level))
  const parenStack = [createFormatFrame('query', 0, 0, false)]
  const getCurrentFrame = () => parenStack[parenStack.length - 1]

  let out = ''
  let forceNewlineIndent = null
  let afterSemicolon = false
  let prevToken = null
  let stmtHeaderWords = []
  let isCompoundHeader = false
  let compoundBlockStack = []
  let prevWordUpperForBlock = ''

  const hasOpenCompoundBegin = () => compoundBlockStack.includes('BEGIN')

  const resetCompoundState = () => {
    stmtHeaderWords = []
    isCompoundHeader = false
    compoundBlockStack = []
    prevWordUpperForBlock = ''
  }

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
    if (out.length === 0) return false
    const lastChar = out[out.length - 1]
    if (lastChar === '\n' || lastChar === ' ' || lastChar === '\t') return false
    if (tok.kind === 'dot') {
      if (prevToken && prevToken.kind === 'number') return true
      return false
    }
    if (
      tok.kind === 'comma' ||
      tok.kind === 'semicolon' ||
      tok.kind === 'paren_close' ||
      tok.kind === 'cast'
    ) {
      return false
    }
    if (prevToken) {
      if (prevToken.kind === 'dot') {
        return out.length >= 2 && out[out.length - 2] === ' '
      }
      if (prevToken.kind === 'paren_open' || prevToken.kind === 'cast') {
        return false
      }
      if (tok.kind === 'paren_open' && prevToken.kind === 'word') {
        return KEYWORDS_WITH_SPACE_BEFORE_PAREN.has(prevToken.upper)
      }
      return true
    }
    if (lastChar === '(' || lastChar === '.' || out.endsWith('::')) {
      return false
    }
    return true
  }

  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]
    const frame = getCurrentFrame()

    if (afterSemicolon && tok.kind === 'line_comment' && !tok.hadNewlineBefore) {
      out += ` ${tok.text}`
      prevToken = tok
      i++
      continue
    }

    if (afterSemicolon) {
      appendBreak('\n\n')
      afterSemicolon = false
      forceNewlineIndent = null
      prevToken = null
    } else if (forceNewlineIndent !== null) {
      appendBreak(`\n${makeIndent(forceNewlineIndent)}`)
      forceNewlineIndent = null
      prevToken = null
    }

    if (tok.kind === 'line_comment') {
      if (needsSpaceBefore(tok)) out += ' '
      out += tok.text
      forceNewlineIndent = frame.lineIndent
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
      if (hasOpenCompoundBegin()) {
        forceNewlineIndent = frame.indent
      } else {
        parenStack.length = 0
        parenStack.push(createFormatFrame('query', 0, 0, false))
        afterSemicolon = true
        resetCompoundState()
      }
      prevToken = tok
      i++
      continue
    }

    if (tok.kind === 'word' && parenStack.length === 1) {
      if (stmtHeaderWords.length < 10) {
        stmtHeaderWords.push(tok.upper)
        if (
          rules.compoundRoutineBegin &&
          !isCompoundHeader &&
          stmtHeaderWords[0] === 'CREATE' &&
          COMPOUND_CREATE_TARGETS.has(tok.upper)
        ) {
          isCompoundHeader = true
        }
      }
      if (isCompoundHeader) {
        const nextIdx = findNextNonCommentIndex(tokens, i)
        const nextTok = nextIdx < tokens.length ? tokens[nextIdx] : null
        const nextWord = nextTok ? (nextTok.kind === 'semicolon' ? ';' : nextTok.upper) : ''
        if (tok.upper === 'BEGIN') {
          if (!NON_TRANSACTION_BEGIN_FOLLOWERS.has(nextWord)) {
            compoundBlockStack.push('BEGIN')
          }
        } else if (tok.upper === 'CASE' && prevWordUpperForBlock !== 'END') {
          compoundBlockStack.push('CASE')
        } else if (tok.upper === 'END') {
          if (COMPOUND_END_SUFFIX_WORDS.has(nextWord)) {
            if (nextWord === 'CASE') popLastBlockEntry(compoundBlockStack, 'CASE')
          } else if (compoundBlockStack.length > 0) {
            compoundBlockStack.pop()
          }
        }
      }
      prevWordUpperForBlock = tok.upper
    } else if (tok.kind !== 'line_comment' && tok.kind !== 'block_comment') {
      prevWordUpperForBlock = ''
    }

    if (tok.kind === 'paren_open') {
      if (needsSpaceBefore(tok)) out += ' '
      out += '('
      const classified = classifyOpenParen(tokens, i, frame)
      if (classified.kind === 'query') {
        const baseIndent = classified.isCteBody ? frame.indent : frame.lineIndent
        const childIndent = baseIndent + 1
        parenStack.push(createFormatFrame('query', baseIndent, childIndent, classified.isCteBody))
        out += `\n${makeIndent(childIndent)}`
        prevToken = null
      } else if (classified.kind === 'window') {
        const baseIndent = frame.lineIndent
        const childIndent = baseIndent + 1
        parenStack.push(createFormatFrame('window', baseIndent, childIndent, false))
        out += `\n${makeIndent(childIndent)}`
        prevToken = null
      } else {
        parenStack.push(createFormatFrame('expr', frame.lineIndent, frame.lineIndent, false))
        prevToken = tok
      }
      i++
      continue
    }

    if (tok.kind === 'paren_close') {
      if (parenStack.length > 1) {
        const closedFrame = parenStack.pop()
        if (closedFrame.kind === 'query' || closedFrame.kind === 'window') {
          appendBreak(`\n${makeIndent(closedFrame.baseIndent)}`)
          out += ')'
          if (closedFrame.isCteBody) {
            const nextTok = tokens[i + 1]
            if (
              nextTok &&
              nextTok.kind !== 'comma' &&
              nextTok.kind !== 'semicolon' &&
              nextTok.kind !== 'paren_close'
            ) {
              forceNewlineIndent = closedFrame.baseIndent
            }
          }
        } else {
          out = out.replace(/[ \t]+$/, '') + ')'
        }
      } else {
        out = out.replace(/[ \t]+$/, '') + ')'
      }
      prevToken = tok
      i++
      continue
    }

    if (tok.kind === 'comma') {
      if (frame.kind === 'query' && frame.inMultiList) {
        frame.lineIndent = frame.indent + 1
        out = out.replace(/[ \t]+$/, '') + `,\n${makeIndent(frame.lineIndent)}`
        prevToken = null
      } else if (frame.kind === 'query' && frame.inWithBlock) {
        frame.lineIndent = frame.indent
        out = out.replace(/[ \t]+$/, '') + `,\n${makeIndent(frame.lineIndent)}`
        prevToken = null
      } else {
        out = out.replace(/[ \t]+$/, '') + ','
        prevToken = tok
      }
      i++
      continue
    }

    if (frame.kind === 'window' && tok.kind === 'word' && prevToken?.kind !== 'dot') {
      const nextTok = tokens[i + 1]
      if (
        (tok.upper === 'PARTITION' || tok.upper === 'ORDER') &&
        nextTok &&
        nextTok.kind === 'word' &&
        nextTok.upper === 'BY'
      ) {
        frame.inBetween = false
        frame.lineIndent = frame.indent
        appendBreak(`\n${makeIndent(frame.indent)}`)
        out += `${tok.upper} BY`
        prevToken = nextTok
        i += 2
        continue
      }
      if (tok.upper === 'ROWS' || tok.upper === 'RANGE' || tok.upper === 'GROUPS') {
        frame.inBetween = false
        frame.lineIndent = frame.indent
        appendBreak(`\n${makeIndent(frame.indent)}`)
        out += tok.upper
        prevToken = tok
        i++
        continue
      }
      if (tok.upper === 'BETWEEN') {
        frame.inBetween = true
      } else if (tok.upper === 'AND' && frame.inBetween) {
        frame.inBetween = false
      }
    }

    if (frame.kind === 'query' && tok.kind === 'word' && prevToken?.kind !== 'dot') {
      const compound = matchCompoundClauseLength(tokens, i)
      if (compound) {
        frame.inMultiList = false
        frame.inBetween = false
        frame.caseDepth = 0
        frame.afterJoin =
          compound.label.endsWith('JOIN') &&
          compound.label !== 'CROSS JOIN' &&
          compound.label !== 'NATURAL JOIN'
        if (compound.label === 'INSERT INTO' || compound.label === 'DELETE FROM') {
          frame.inWithBlock = false
        }
        frame.lineIndent = frame.indent
        appendBreak(`\n${makeIndent(frame.indent)}`)
        out += compound.label
        prevToken = tokens[i + compound.length - 1]
        if (compound.label === 'GROUP BY' || compound.label === 'ORDER BY') {
          if (clauseListHasTopLevelComma(tokens, i + compound.length - 1, false)) {
            frame.inMultiList = true
            frame.lineIndent = frame.indent + 1
            out += `\n${makeIndent(frame.lineIndent)}`
            prevToken = null
          }
        }
        i += compound.length
        continue
      }

      if (TOP_LEVEL_SINGLE_CLAUSES.has(tok.upper)) {
        frame.inMultiList = false
        frame.inBetween = false
        frame.caseDepth = 0
        frame.afterJoin = tok.upper === 'JOIN'
        if (tok.upper === 'WITH') {
          frame.inWithBlock = true
        } else if (
          tok.upper === 'SELECT' ||
          tok.upper === 'FROM' ||
          tok.upper === 'UPDATE' ||
          tok.upper === 'VALUES'
        ) {
          frame.inWithBlock = false
        }
        frame.lineIndent = frame.indent
        appendBreak(`\n${makeIndent(frame.indent)}`)
        out += tok.upper
        prevToken = tok
        if (tok.upper === 'SELECT') {
          const hasComma = clauseListHasTopLevelComma(tokens, i, true)
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
            frame.inMultiList = true
            frame.lineIndent = frame.indent + 1
            out += `\n${makeIndent(frame.lineIndent)}`
            prevToken = null
          }
        }
        i++
        continue
      }

      if (tok.upper === 'USING' && frame.afterJoin) {
        frame.afterJoin = false
      } else if (tok.upper === 'ON' && frame.afterJoin) {
        const nextIdx = findNextNonCommentIndex(tokens, i)
        if (nextIdx < tokens.length && tokens[nextIdx].kind === 'word' && tokens[nextIdx].upper === 'CONFLICT') {
          frame.afterJoin = false
        } else {
          frame.afterJoin = false
          frame.inBetween = false
          frame.lineIndent = frame.indent + 1
          appendBreak(`\n${makeIndent(frame.lineIndent)}`)
          out += 'ON'
          prevToken = tok
          i++
          continue
        }
      }

      if (tok.upper === 'CASE') {
        frame.caseDepth++
      } else if (tok.upper === 'END') {
        if (frame.caseDepth > 0) frame.caseDepth--
      } else if (tok.upper === 'BETWEEN') {
        frame.inBetween = true
      } else if (
        (tok.upper === 'AND' || tok.upper === 'OR') &&
        frame.caseDepth === 0 &&
        !(tok.upper === 'AND' && frame.inBetween)
      ) {
        frame.lineIndent = frame.indent + 1
        appendBreak(`\n${makeIndent(frame.lineIndent)}`)
        out += tok.upper
        prevToken = tok
        i++
        continue
      } else if (tok.upper === 'AND' && frame.inBetween) {
        frame.inBetween = false
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

  const formatted = out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim()

  // Token-preservation guard: fall back verbatim if ANY token
  // drifted under either backslash-escape mode (e.g. operator splitting, comment pasting).
  if (!readsTheSameForFormat(trimmedSql, formatted, dialect)) {
    return trimmedSql
  }
  return formatted
}

function isSqliteTriggerIdentStart(code) {
  return isIdentStartChar(code) || code >= 0x80
}

function isSqliteTriggerIdentCont(code) {
  return isIdentContChar(code) || code === 36 || code >= 0x80
}

function tokenizeSqliteTriggerSql(sql) {
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
      i = scanLineCommentEnd(sql, i)
      continue
    }
    if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
      i = scanBlockCommentEnd(sql, i, false)
      continue
    }
    if (ch === "'") {
      i = scanQuotedSegmentEnd(sql, i, "'", false).end
      tokens.push({ kind: 'other', value: '', upper: '', quoted: false })
      continue
    }
    if (ch === '"' || ch === '`') {
      const seg = scanQuotedSegmentEnd(sql, i, ch, false)
      const rawInner = sql.slice(i + 1, seg.closed ? seg.end - 1 : seg.end)
      const value = ch === '"' ? rawInner.replace(/""/g, '"') : rawInner.replace(/``/g, '`')
      tokens.push({ kind: 'ident', value, upper: value.toUpperCase(), quoted: true })
      i = seg.end
      continue
    }
    if (ch === '[') {
      const closeIdx = sql.indexOf(']', i + 1)
      const value = sql.slice(i + 1, closeIdx < 0 ? len : closeIdx)
      tokens.push({ kind: 'ident', value, upper: value.toUpperCase(), quoted: true })
      i = closeIdx < 0 ? len : closeIdx + 1
      continue
    }
    if (ch === '.') {
      tokens.push({ kind: 'dot', value: '.', upper: '.', quoted: false })
      i++
      continue
    }
    if (isSqliteTriggerIdentStart(sql.charCodeAt(i))) {
      let j = i + 1
      while (j < len && isSqliteTriggerIdentCont(sql.charCodeAt(j))) j++
      const value = sql.slice(i, j)
      tokens.push({ kind: 'ident', value, upper: value.toUpperCase(), quoted: false })
      i = j
      continue
    }
    tokens.push({ kind: 'other', value: ch, upper: ch, quoted: false })
    i++
  }
  return tokens
}

/**
 * Tokenizes a SQLite `CREATE TRIGGER` DDL statement (`"..."`, `` `...` ``, `[...]`, `'...'`,
 * `--...`, `/*...*\/`) so multi-word quoted identifiers remain single tokens and the `ON <origTable>`
 * target header clause is excluded when checking trigger body references.
 */
export function analyzeSqliteTriggerReferences(triggerSql, origTable, identCandidates = []) {
  const trgSql = typeof triggerSql === 'string' ? triggerSql.trim() : ''
  const origName = typeof origTable === 'string' ? origTable.trim() : ''
  const origTableLower = origName.toLowerCase()

  const candidateMap = new Map()
  if (Array.isArray(identCandidates)) {
    for (const rawCandidate of identCandidates) {
      if (typeof rawCandidate !== 'string') continue
      const trimmed = rawCandidate.trim()
      if (!trimmed) continue
      const key = trimmed.toLowerCase()
      if (!candidateMap.has(key)) {
        candidateMap.set(key, trimmed)
      }
    }
  }

  if (!trgSql) {
    return {
      referencesOrigTableInBody: false,
      onTargetTable: null,
      onTargetMatchesOrigTable: false,
      referencedIdents: [],
    }
  }

  const tokens = tokenizeSqliteTriggerSql(trgSql)
  const beginIdx = tokens.findIndex(
    (t) => t.kind === 'ident' && !t.quoted && t.upper === 'BEGIN'
  )
  const headerLimit = beginIdx >= 0 ? beginIdx : tokens.length

  let onIdx = -1
  for (let i = 0; i < headerLimit; i++) {
    const tok = tokens[i]
    if (tok.kind === 'ident' && !tok.quoted && tok.upper === 'ON') {
      onIdx = i
      break
    }
  }

  let targetTableIdx = -1
  if (onIdx >= 0) {
    if (
      tokens[onIdx + 1]?.kind === 'ident' &&
      tokens[onIdx + 2]?.kind === 'dot' &&
      tokens[onIdx + 3]?.kind === 'ident'
    ) {
      targetTableIdx = onIdx + 3
    } else if (tokens[onIdx + 1]?.kind === 'ident') {
      targetTableIdx = onIdx + 1
    }
  }

  const onTargetTable = targetTableIdx >= 0 ? tokens[targetTableIdx].value : null
  const onTargetMatchesOrigTable = Boolean(
    origTableLower && onTargetTable && onTargetTable.toLowerCase() === origTableLower
  )

  const referencedIdents = []
  const addReferencedIdent = (lowerKey) => {
    const canonical = candidateMap.get(lowerKey)
    if (canonical && !referencedIdents.includes(canonical)) {
      referencedIdents.push(canonical)
    }
  }

  // Check `UPDATE OF <col1>, <col2>` in trigger header before `ON`
  if (candidateMap.size > 0 && onIdx > 0) {
    let inUpdateOf = false
    for (let i = 0; i < onIdx; i++) {
      const tok = tokens[i]
      const nextTok = tokens[i + 1]
      if (
        tok.kind === 'ident' &&
        !tok.quoted &&
        tok.upper === 'UPDATE' &&
        nextTok?.kind === 'ident' &&
        !nextTok.quoted &&
        nextTok.upper === 'OF'
      ) {
        inUpdateOf = true
        i += 1
        continue
      }
      if (inUpdateOf && tok.kind === 'ident') {
        addReferencedIdent(tok.value.toLowerCase())
      }
    }
  }

  // Scan `WHEN` and `BEGIN...END` after `ON [schema.]<origTable>`
  const scanStart = targetTableIdx >= 0 ? targetTableIdx + 1 : onIdx >= 0 ? onIdx + 1 : 0
  let referencesOrigTableInBody = false
  for (let i = scanStart; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.kind !== 'ident') continue
    const lower = tok.value.toLowerCase()
    if (candidateMap.has(lower)) {
      addReferencedIdent(lower)
    }
    if (origTableLower && lower === origTableLower) {
      const prev1 = tokens[i - 1]
      const prev2 = tokens[i - 2]
      const isNewOrOldQualifier =
        prev1?.kind === 'dot' &&
        prev2?.kind === 'ident' &&
        !prev2.quoted &&
        (prev2.upper === 'NEW' || prev2.upper === 'OLD')
      if (!isNewOrOldQualifier) {
        referencesOrigTableInBody = true
      }
    }
  }

  return {
    referencesOrigTableInBody,
    onTargetTable,
    onTargetMatchesOrigTable,
    referencedIdents,
  }
}

/**
 * Splits a T-SQL script on `GO [repeatCount]` batch separator lines while ignoring
 * `GO` inside single-quoted string literals, bracket/double-quoted identifiers, and `--` / `/* *\/` comments.
 */
export function splitMssqlBatches(script) {
  const raw = String(script || '')
  if (!raw.trim()) return []

  const batches = []
  let batchStart = 0
  let i = 0
  const len = raw.length
  let inSingleQuote = false
  let inDoubleQuote = false
  let inBracketIdent = false
  let inBlockComment = false
  let blockCommentDepth = 0

  while (i < len) {
    const lineStart = i
    let lineEnd = raw.indexOf('\n', i)
    if (lineEnd < 0) lineEnd = len
    else lineEnd += 1

    const atTopLevel = !inSingleQuote && !inDoubleQuote && !inBracketIdent && !inBlockComment
    let matchedGo = false
    if (atTopLevel) {
      const lineText = raw.slice(lineStart, lineEnd).replace(/\r?\n$/, '')
      const goMatch = /^\s*GO(?:\s+(\d+))?\s*(?:--.*)?$/i.exec(lineText)
      if (goMatch) {
        const batchText = raw.slice(batchStart, lineStart).trim()
        if (batchText.length > 0) {
          const repeat = goMatch[1] ? Math.max(1, Math.min(100, Number(goMatch[1]))) : 1
          for (let r = 0; r < repeat; r++) {
            batches.push(batchText)
          }
        }
        batchStart = lineEnd
        i = lineEnd
        matchedGo = true
      }
    }
    if (matchedGo) continue

    let j = lineStart
    while (j < lineEnd) {
      const ch = raw[j]
      if (inBlockComment) {
        if (ch === '/' && j + 1 < lineEnd && raw[j + 1] === '*') {
          blockCommentDepth++
          j += 2
          continue
        }
        if (ch === '*' && j + 1 < lineEnd && raw[j + 1] === '/') {
          blockCommentDepth--
          if (blockCommentDepth <= 0) {
            inBlockComment = false
            blockCommentDepth = 0
          }
          j += 2
          continue
        }
        j++
        continue
      }
      if (inSingleQuote) {
        if (ch === "'") {
          if (j + 1 < len && raw[j + 1] === "'") {
            j += 2
            continue
          }
          inSingleQuote = false
        }
        j++
        continue
      }
      if (inDoubleQuote) {
        if (ch === '"') {
          if (j + 1 < len && raw[j + 1] === '"') {
            j += 2
            continue
          }
          inDoubleQuote = false
        }
        j++
        continue
      }
      if (inBracketIdent) {
        if (ch === ']') {
          if (j + 1 < len && raw[j + 1] === ']') {
            j += 2
            continue
          }
          inBracketIdent = false
        }
        j++
        continue
      }

      if (ch === '-' && j + 1 < lineEnd && raw[j + 1] === '-') {
        break
      }
      if (ch === '/' && j + 1 < lineEnd && raw[j + 1] === '*') {
        inBlockComment = true
        blockCommentDepth = 1
        j += 2
        continue
      }
      if (ch === "'") {
        inSingleQuote = true
        j++
        continue
      }
      if (ch === '"') {
        inDoubleQuote = true
        j++
        continue
      }
      if (ch === '[') {
        inBracketIdent = true
        j++
        continue
      }
      j++
    }

    i = lineEnd
  }

  const tail = raw.slice(batchStart).trim()
  if (tail.length > 0) {
    batches.push(tail)
  }
  return batches
}

/**
 * Splits an Oracle SQL / SQL*Plus script on standalone `/` separator lines while honoring
 * `--` line comments, `/* *\/` block comments, `'...'`, `"..."`, and `q'[...]'` / `nq'[...]'` quotes.
 */
export function splitOracleSlashChunks(script) {
  const raw = String(script || '').replace(/\r\n?/g, '\n')
  if (!raw.trim()) return []

  const chunks = []
  const len = raw.length
  let chunkStart = 0
  let i = 0
  let inSingleQuote = false
  let inDoubleQuote = false
  let inBlockComment = false

  while (i < len) {
    const atLineStart = i === 0 || raw[i - 1] === '\n'
    const atTopLevel = !inSingleQuote && !inDoubleQuote && !inBlockComment

    if (atLineStart && atTopLevel) {
      let k = i
      while (k < len && (raw[k] === ' ' || raw[k] === '\t')) k++
      if (
        k < len &&
        raw[k] === '/' &&
        (k + 1 >= len || (raw[k + 1] !== '/' && raw[k + 1] !== '*'))
      ) {
        let after = k + 1
        while (after < len && (raw[after] === ' ' || raw[after] === '\t')) after++
        if (after < len && raw[after] === '-' && after + 1 < len && raw[after + 1] === '-') {
          const nl = raw.indexOf('\n', after + 2)
          after = nl < 0 ? len : nl
        } else if (
          after > k + 1 &&
          after + 1 < len &&
          raw[after] === '/' &&
          raw[after + 1] === '*'
        ) {
          const closeIdx = raw.indexOf('*/', after + 2)
          const nlIdx = raw.indexOf('\n', after + 2)
          if (closeIdx >= 0 && (nlIdx < 0 || closeIdx < nlIdx)) {
            after = closeIdx + 2
            while (after < len && (raw[after] === ' ' || raw[after] === '\t')) after++
          }
        }
        if (after === len || raw[after] === '\n') {
          const piece = raw.slice(chunkStart, i).trim()
          if (piece.length > 0) {
            chunks.push(piece)
          }
          i = after < len ? after + 1 : after
          chunkStart = i
          continue
        }
      }
    }

    const ch = raw[i]
    if (inBlockComment) {
      if (ch === '*' && i + 1 < len && raw[i + 1] === '/') {
        inBlockComment = false
        i += 2
        continue
      }
      i++
      continue
    }
    if (inSingleQuote) {
      if (ch === "'") {
        if (i + 1 < len && raw[i + 1] === "'") {
          i += 2
          continue
        }
        inSingleQuote = false
      }
      i++
      continue
    }
    if (inDoubleQuote) {
      if (ch === '"') {
        if (i + 1 < len && raw[i + 1] === '"') {
          i += 2
          continue
        }
        inDoubleQuote = false
      }
      i++
      continue
    }

    if (ch === '-' && i + 1 < len && raw[i + 1] === '-') {
      const nl = raw.indexOf('\n', i + 2)
      i = nl < 0 ? len : nl + 1
      continue
    }
    if (ch === '/' && i + 1 < len && raw[i + 1] === '*') {
      inBlockComment = true
      i += 2
      continue
    }
    const oracleQuote = scanOracleQuoteEnd(raw, i, 'oracle')
    if (oracleQuote) {
      i = oracleQuote.end
      continue
    }
    if (ch === "'") {
      inSingleQuote = true
      i++
      continue
    }
    if (ch === '"') {
      inDoubleQuote = true
      i++
      continue
    }
    i++
  }

  const tail = raw.slice(chunkStart).trim()
  if (tail.length > 0) {
    chunks.push(tail)
  }
  return chunks
}

const AI_TOP_LEVEL_STARTER_WORDS = new Set([
  'SELECT',
  'WITH',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'ALTER',
  'DROP',
  'EXPLAIN',
  'PRAGMA',
  'SHOW',
  'MERGE',
  'TRUNCATE',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
])

const AI_RECOVERY_STARTER_RE =
  /^(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|EXPLAIN|PRAGMA|SHOW|MERGE|TRUNCATE)\b/i

const AI_WITH_MAIN_DML_WORDS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
])

const AI_CONTINUATION_TAIL_WORDS = new Set([
  'UNION',
  'ALL',
  'DISTINCT',
  'INTERSECT',
  'EXCEPT',
  'AS',
  'VALUES',
  'EXPLAIN',
  'ANALYZE',
  'ANALYSE',
  'QUERY',
  'PLAN',
  'IN',
  'EXISTS',
  'NOT',
  'THEN',
  'ELSE',
  'WHEN',
  'CASE',
  'AND',
  'OR',
  'ON',
  'WHERE',
  'FROM',
  'JOIN',
  'HAVING',
  'USING',
  'RETURNING',
  'BEGIN',
  'DO',
  'DECLARE',
  'LOOP',
])

function skipWsAndSqlComments(text, start, dialect) {
  const len = text.length
  const rules = getDialectLexerRules(dialect)
  let i = start
  while (i < len) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++
      continue
    }
    if (rules.lineCommentDash && ch === '-' && i + 1 < len && text[i + 1] === '-') {
      i = scanLineCommentEnd(text, i)
      continue
    }
    if (rules.lineCommentSlash && ch === '/' && i + 1 < len && text[i + 1] === '/') {
      i = scanLineCommentEnd(text, i)
      continue
    }
    if (rules.lineCommentHash && ch === '#') {
      i = scanLineCommentEnd(text, i - 1)
      continue
    }
    if (ch === '/' && i + 1 < len && text[i + 1] === '*') {
      const execLen = matchMysqlExecCommentPrefix(text, i, dialect)
      if (execLen > 0) break
      i = scanBlockCommentEnd(text, i, rules.nestedBlockComments)
      continue
    }
    break
  }
  return i
}

const AI_TOP_LEVEL_DROP_OBJECTS = new Set([
  'TABLE',
  'DATABASE',
  'SCHEMA',
  'VIEW',
  'TRIGGER',
  'PROCEDURE',
  'FUNCTION',
  'USER',
  'ROLE',
  'LOGIN',
  'EVENT',
  'SEQUENCE',
  'TYPE',
  'EXTENSION',
  'MATERIALIZED',
])

function peekNextSqlWord(text, start, dialect) {
  const pos = skipWsAndSqlComments(text, start, dialect)
  if (pos >= text.length || !isIdentStartChar(text.charCodeAt(pos))) return ''
  let end = pos + 1
  while (end < text.length && isIdentContChar(text.charCodeAt(end))) end++
  return text.slice(pos, end).toUpperCase()
}

function peekSecondSqlWord(text, start, dialect) {
  const pos1 = skipWsAndSqlComments(text, start, dialect)
  if (pos1 >= text.length || !isIdentStartChar(text.charCodeAt(pos1))) return ''
  let end1 = pos1 + 1
  while (end1 < text.length && isIdentContChar(text.charCodeAt(end1))) end1++
  return peekNextSqlWord(text, end1, dialect)
}

function hasCloserInSuffix(suffix, kind, dialect) {
  if (!suffix) return false
  if (kind === 'block_comment') {
    return suffix.includes('*/')
  }
  if (kind === "'") {
    const allowBackslash = usesBackslashAndHash(dialect)
    for (let i = 0; i < suffix.length; i++) {
      const ch = suffix[i]
      if (allowBackslash && ch === '\\') {
        i++
        continue
      }
      if (ch === "'") return true
    }
    return false
  }
  return suffix.includes(kind)
}

function findRecoveryBreakInSpan(text, spanStart, spanEnd, kind, dialect) {
  let i = spanStart + (kind === 'block_comment' ? 2 : 1)
  while (i < spanEnd) {
    if (kind === 'block_comment') {
      if (text[i] !== ';') {
        i++
        continue
      }
      let p = i + 1
      while (p < spanEnd && (text[p] === ' ' || text[p] === '\t')) p++
      const nl1 = text[p] === '\r' && text[p + 1] === '\n' ? 2 : text[p] === '\n' ? 1 : 0
      if (nl1 === 0) {
        i++
        continue
      }
      p += nl1
      while (p < spanEnd && (text[p] === ' ' || text[p] === '\t')) p++
      const nl2 = text[p] === '\r' && text[p + 1] === '\n' ? 2 : text[p] === '\n' ? 1 : 0
      if (nl2 === 0) {
        i++
        continue
      }
      const afterBreak = Math.min(spanEnd, skipWsAndSqlComments(text, p + nl2, dialect))
      if (
        afterBreak < spanEnd &&
        AI_RECOVERY_STARTER_RE.test(text.slice(afterBreak, Math.min(spanEnd, afterBreak + 16)))
      ) {
        return afterBreak
      }
      i = Math.max(i + 1, afterBreak)
      continue
    }

    if (kind === "'") {
      let breakAt = -1
      if (text[i] === ';') {
        let p = i + 1
        while (p < spanEnd && (text[p] === ' ' || text[p] === '\t')) p++
        if (text[p] === '\r' && text[p + 1] === '\n') breakAt = p + 2
        else if (text[p] === '\n') breakAt = p + 1
      } else if (text[i] === '\n') {
        let p = i + 1
        while (p < spanEnd && (text[p] === ' ' || text[p] === '\t')) p++
        if (text[p] === '\r' && text[p + 1] === '\n') breakAt = p + 2
        else if (text[p] === '\n') breakAt = p + 1
      }
      if (breakAt >= 0) {
        const afterBreak = Math.min(spanEnd, skipWsAndSqlComments(text, breakAt, dialect))
        if (
          afterBreak < spanEnd &&
          AI_RECOVERY_STARTER_RE.test(text.slice(afterBreak, Math.min(spanEnd, afterBreak + 16)))
        ) {
          return afterBreak
        }
        i = Math.max(i + 1, afterBreak)
        continue
      }
      i++
      continue
    }

    // '"' or '`'
    if (text[i] === '\n') {
      const afterBreak = Math.min(spanEnd, skipWsAndSqlComments(text, i + 1, dialect))
      if (
        afterBreak < spanEnd &&
        AI_RECOVERY_STARTER_RE.test(text.slice(afterBreak, Math.min(spanEnd, afterBreak + 16)))
      ) {
        return afterBreak
      }
      i = Math.max(i + 1, afterBreak)
      continue
    }
    i++
  }
  return -1
}

function findAbandonedSqlRecoveryStart(prefix, suffix, dialect) {
  const len = prefix.length
  if (len === 0) return 0
  const rules = getDialectLexerRules(dialect)
  let i = 0
  let parenDepth = 0
  let openKind = null
  let firstCandidateBreak = -1
  let closedCandidateBreak = -1
  let closedCandidateEnd = -1
  let unclosedStart = -1

  while (i < len) {
    const ch = prefix[i]
    if (rules.lineCommentDash && ch === '-' && i + 1 < len && prefix[i + 1] === '-') {
      i = scanLineCommentEnd(prefix, i)
      continue
    }
    if (rules.lineCommentSlash && ch === '/' && i + 1 < len && prefix[i + 1] === '/') {
      i = scanLineCommentEnd(prefix, i)
      continue
    }
    if (rules.lineCommentHash && ch === '#') {
      i = scanLineCommentEnd(prefix, i - 1)
      continue
    }
    if (ch === '/' && i + 1 < len && prefix[i + 1] === '*') {
      const execLen = matchMysqlExecCommentPrefix(prefix, i, dialect)
      if (execLen > 0) {
        i += execLen
        continue
      }
      const block = scanBlockCommentWithState(prefix, i, rules.nestedBlockComments)
      if (!block.closed) {
        const brk = findRecoveryBreakInSpan(prefix, i, len, 'block_comment', dialect)
        if (brk >= 0) firstCandidateBreak = brk
        openKind = 'block_comment'
        unclosedStart = i
      } else {
        const closedAtBreak = findRecoveryBreakInSpan(prefix, i, block.end, 'block_comment', dialect)
        if (closedAtBreak >= 0 && closedCandidateBreak < 0) {
          closedCandidateBreak = closedAtBreak
          closedCandidateEnd = block.end
        }
      }
      i = block.end
      continue
    }
    if (isPostgresEscapeStringStart(prefix, i, dialect)) {
      const seg = scanQuotedSegmentEnd(prefix, i + 1, "'", true)
      if (!seg.closed) {
        const brk = findRecoveryBreakInSpan(prefix, i + 1, seg.end, "'", dialect)
        if (brk >= 0 && firstCandidateBreak < 0) firstCandidateBreak = brk
        openKind = "'"
        unclosedStart = i
      } else {
        const brk = findRecoveryBreakInSpan(prefix, i + 1, seg.end, "'", dialect)
        if (brk >= 0 && closedCandidateBreak < 0) {
          closedCandidateBreak = brk
          closedCandidateEnd = seg.end
        }
      }
      i = seg.end
      continue
    }
    const oracleQuote = scanOracleQuoteEnd(prefix, i, dialect)
    if (oracleQuote) {
      i = oracleQuote.end
      continue
    }
    if (rules.dollarQuoting && ch === '$') {
      const tag = matchDollarQuoteTag(prefix, i)
      if (tag !== null) {
        const closeIdx = prefix.indexOf(tag, i + tag.length)
        i = closeIdx >= 0 ? closeIdx + tag.length : len
        continue
      }
    }
    if (ch === "'" || ch === '"' || (ch === '`' && rules.backtickIdentifiers)) {
      const allowBackslash =
        (ch === "'" && rules.backslashEscapesSingleQuote) ||
        (ch === '"' && rules.backslashEscapesDoubleQuote)
      const seg = scanQuotedSegmentEnd(prefix, i, ch, allowBackslash)
      const brk = findRecoveryBreakInSpan(prefix, i, seg.end, ch, dialect)
      if (!seg.closed) {
        if (brk >= 0 && firstCandidateBreak < 0) {
          firstCandidateBreak = brk
        }
        openKind = ch
        unclosedStart = i
      } else if (brk >= 0 && closedCandidateBreak < 0) {
        closedCandidateBreak = brk
        closedCandidateEnd = seg.end
      }
      i = seg.end
      continue
    }
    if (ch === '[' && rules.bracketIdentifiers !== 'none') {
      i = scanBracketIdentEnd(prefix, i, rules.bracketIdentifiers === 'doubling').end
      continue
    }
    if (ch === '(') parenDepth++
    else if (ch === ')' && parenDepth > 0) parenDepth--
    else if (ch === ';' && parenDepth === 0) {
      firstCandidateBreak = -1
      closedCandidateBreak = -1
      closedCandidateEnd = -1
    }
    i++
  }

  if (!openKind) return 0
  let recoveryBreak = firstCandidateBreak
  if (
    recoveryBreak < 0 &&
    closedCandidateBreak >= 0 &&
    unclosedStart >= closedCandidateEnd &&
    !/\b(SELECT|FROM|WHERE|JOIN|INSERT|UPDATE|DELETE)\b/i.test(prefix.slice(closedCandidateEnd, unclosedStart))
  ) {
    recoveryBreak = closedCandidateBreak
  }
  if (recoveryBreak < 0) return 0
  if (hasCloserInSuffix(suffix, openKind, dialect)) return 0
  return recoveryBreak
}

function splitAiSqlSegments(script, dialect, baseStart = 0) {
  const results = []
  const len = script.length
  const rules = getDialectLexerRules(dialect)
  const allowMysqlDelimiter = rules.mysqlDelimiter
  const supportsCompoundRoutineBegin = rules.compoundRoutineBegin

  let segStart = baseStart
  let hasExecutableToken = false
  let delimiter = ';'
  let execCommentDepth = 0
  let parenDepth = 0
  let i = baseStart

  let stmtHeaderWords = []
  let isCompoundHeader = false
  let blockStack = []
  let prevWordUpper = ''
  let firstTopWord = ''
  let withAwaitingMainDml = false
  let awaitingTargetAfterExplain = false
  let insertSawBody = false
  let lastSignificantUpperWord = ''
  let lastSignificantPunct = ''

  const hasOpenBegin = () => blockStack.includes('BEGIN')

  const resetStatementState = () => {
    stmtHeaderWords = []
    isCompoundHeader = false
    blockStack = []
    prevWordUpper = ''
    firstTopWord = ''
    withAwaitingMainDml = false
    awaitingTargetAfterExplain = false
    insertSawBody = false
    lastSignificantUpperWord = ''
    lastSignificantPunct = ''
  }

  const flushSegment = (rawEnd, delimLen, semiIndex = -1) => {
    const hasSemicolon = semiIndex >= 0
    if (hasExecutableToken) {
      const { start, end } = trimSliceBounds(script, segStart, rawEnd)
      if (end > start || hasSemicolon) {
        results.push({
          start: end > start ? start : rawEnd,
          end,
          semiIndex,
          semiEnd: hasSemicolon ? semiIndex + delimLen : -1,
          hasSemicolon,
        })
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
      const atLineStart = i === baseStart || script[i - 1] === '\n' || script[i - 1] === '\r'
      if (atLineStart) {
        let wsEnd = i
        while (wsEnd < len && (script[wsEnd] === ' ' || script[wsEnd] === '\t')) wsEnd++
        const delimMatch = MYSQL_DELIMITER_LINE_RE.exec(script.slice(wsEnd))
        if (delimMatch && delimMatch[1]) {
          delimiter = delimMatch[1]
          i = wsEnd + delimMatch[0].length
          segStart = i
          resetStatementState()
          continue
        }
      }
    }

    if (delimiter.length > 0 && parenDepth === 0 && !hasOpenBegin() && execCommentDepth === 0) {
      if (matchesCustomDelimiterAt(script, i, delimiter)) {
        flushSegment(i, delimiter.length, i)
        i += delimiter.length
        continue
      }
    }

    const ch = script[i]

    // Soft-split on blank line followed by top-level SQL starter (only when statement is top-level complete)
    if (ch === '\r' || ch === '\n') {
      if (
        hasExecutableToken &&
        parenDepth === 0 &&
        !hasOpenBegin() &&
        execCommentDepth === 0 &&
        !isCompoundHeader
      ) {
        const nl1 = ch === '\r' && script[i + 1] === '\n' ? 2 : 1
        let k = i + nl1
        while (k < len && (script[k] === ' ' || script[k] === '\t')) k++
        const nl2 =
          k < len && script[k] === '\r' && script[k + 1] === '\n'
            ? 2
            : k < len && script[k] === '\n'
              ? 1
              : 0
        if (nl2 > 0) {
          const afterBlank = k + nl2
          const nextWord = peekNextSqlWord(script, afterBlank, dialect)
          const blockedByTail =
            withAwaitingMainDml ||
            awaitingTargetAfterExplain ||
            AI_CONTINUATION_TAIL_WORDS.has(lastSignificantUpperWord) ||
            lastSignificantPunct === '(' ||
            lastSignificantPunct === ',' ||
            lastSignificantPunct === '=' ||
            ((firstTopWord === 'INSERT' || firstTopWord === 'REPLACE' || firstTopWord === 'UPSERT') &&
              !insertSawBody &&
              (nextWord === 'SELECT' || nextWord === 'WITH')) ||
            (firstTopWord === 'ALTER' &&
              (nextWord === 'ALTER' ||
                (nextWord === 'DROP' &&
                  !AI_TOP_LEVEL_DROP_OBJECTS.has(peekSecondSqlWord(script, afterBlank, dialect)))))
          if (AI_TOP_LEVEL_STARTER_WORDS.has(nextWord) && !blockedByTail) {
            flushSegment(i, 0, -1)
            segStart = afterBlank
            i = afterBlank
            continue
          }
        }
      }
    }

    if (rules.lineCommentDash && ch === '-' && i + 1 < len && script[i + 1] === '-') {
      i = scanLineCommentEnd(script, i)
      continue
    }
    if (rules.lineCommentSlash && ch === '/' && i + 1 < len && script[i + 1] === '/') {
      i = scanLineCommentEnd(script, i)
      continue
    }
    if (rules.lineCommentHash && ch === '#') {
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
      i = scanBlockCommentEnd(script, i, rules.nestedBlockComments)
      continue
    }
    if (isPostgresEscapeStringStart(script, i, dialect)) {
      hasExecutableToken = true
      i = scanQuotedSegmentEnd(script, i + 1, "'", true).end
      prevWordUpper = ''
      lastSignificantUpperWord = ''
      lastSignificantPunct = "'"
      continue
    }
    const oracleQuote = scanOracleQuoteEnd(script, i, dialect)
    if (oracleQuote) {
      hasExecutableToken = true
      i = oracleQuote.end
      prevWordUpper = ''
      lastSignificantUpperWord = ''
      lastSignificantPunct = "'"
      continue
    }
    if (ch === "'" || ch === '"' || (ch === '`' && rules.backtickIdentifiers)) {
      hasExecutableToken = true
      const allowBackslash =
        (ch === "'" && rules.backslashEscapesSingleQuote) ||
        (ch === '"' && rules.backslashEscapesDoubleQuote)
      i = scanQuotedSegmentEnd(script, i, ch, allowBackslash).end
      prevWordUpper = ''
      lastSignificantUpperWord = ''
      lastSignificantPunct = ch
      continue
    }
    if (ch === '[' && rules.bracketIdentifiers !== 'none') {
      hasExecutableToken = true
      i = scanBracketIdentEnd(script, i, rules.bracketIdentifiers === 'doubling').end
      prevWordUpper = ''
      lastSignificantUpperWord = ''
      lastSignificantPunct = ']'
      continue
    }
    if (rules.dollarQuoting && ch === '$') {
      const tag = matchDollarQuoteTag(script, i)
      if (tag !== null) {
        hasExecutableToken = true
        const closeIdx = script.indexOf(tag, i + tag.length)
        i = closeIdx >= 0 ? closeIdx + tag.length : len
        prevWordUpper = ''
        lastSignificantUpperWord = ''
        lastSignificantPunct = '$'
        continue
      }
    }

    if (ch === '(') {
      hasExecutableToken = true
      parenDepth++
      lastSignificantUpperWord = ''
      lastSignificantPunct = '('
      i++
      continue
    }
    if (ch === ')' && parenDepth > 0) {
      hasExecutableToken = true
      parenDepth--
      lastSignificantUpperWord = ''
      lastSignificantPunct = ')'
      i++
      continue
    }

    if (isIdentStartChar(script.charCodeAt(i))) {
      hasExecutableToken = true
      let end = i + 1
      while (end < len && isIdentContChar(script.charCodeAt(end))) end++
      const wordUpper = script.slice(i, end).toUpperCase()

      if (parenDepth === 0) {
        if (!firstTopWord) {
          firstTopWord = wordUpper
          if (wordUpper === 'WITH') {
            withAwaitingMainDml = true
          } else if (wordUpper === 'EXPLAIN') {
            awaitingTargetAfterExplain = true
          }
        } else {
          if (withAwaitingMainDml && AI_WITH_MAIN_DML_WORDS.has(wordUpper)) {
            withAwaitingMainDml = false
          }
          if (awaitingTargetAfterExplain && AI_TOP_LEVEL_STARTER_WORDS.has(wordUpper) && wordUpper !== 'EXPLAIN') {
            awaitingTargetAfterExplain = false
          }
          if (
            (firstTopWord === 'INSERT' || firstTopWord === 'REPLACE' || firstTopWord === 'UPSERT') &&
            (wordUpper === 'VALUES' || wordUpper === 'SELECT' || wordUpper === 'WITH' || wordUpper === 'DEFAULT')
          ) {
            insertSawBody = true
          }
        }
        lastSignificantUpperWord = wordUpper
        lastSignificantPunct = ''
      }

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
            blockStack.push('BEGIN')
          }
        } else if (wordUpper === 'CASE' && prevWordUpper !== 'END') {
          blockStack.push('CASE')
        } else if (wordUpper === 'END') {
          const nextWord = peekNextUpperWord(end)
          if (COMPOUND_END_SUFFIX_WORDS.has(nextWord)) {
            if (nextWord === 'CASE') {
              popLastBlockEntry(blockStack, 'CASE')
            }
          } else if (blockStack.length > 0) {
            blockStack.pop()
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
      if (parenDepth === 0) {
        lastSignificantUpperWord = ''
        lastSignificantPunct = ch
      }
    }
    i++
  }

  if (segStart < len && hasExecutableToken) {
    flushSegment(len, 0, -1)
  }

  return results
}

function buildIsolatedWindow(windowText, spanStart, spanEnd, cursorOffset, extras) {
  const clampedStart = Math.max(0, Math.min(windowText.length, spanStart))
  const clampedEnd = Math.max(clampedStart, Math.min(windowText.length, spanEnd))
  const text = windowText.slice(clampedStart, clampedEnd)
  const relCursor = Math.max(0, Math.min(text.length, cursorOffset - clampedStart))
  const cursorOffsetInSpan = cursorOffset - clampedStart
  return {
    text,
    stmtPrefix: text.slice(0, relCursor),
    stmtSuffix: text.slice(relCursor),
    spanStart: clampedStart,
    spanEnd: clampedEnd,
    relCursor,
    cursorOffsetInSpan,
    lineCount: text ? text.split(/\r?\n/).length : 1,
    hasPrecedingStatements: extras.hasPrecedingStatements,
    terminatedBySemicolon: extras.terminatedBySemicolon,
    semiEnd: extras.semiEnd,
    cursorAfterSemicolon: extras.cursorAfterSemicolon,
    isFreshStatementAfterSemicolon: extras.isFreshStatementAfterSemicolon,
    precedingErroredSlice: extras.precedingErroredSlice,
  }
}

/**
 * Isolates the single active SQL statement around the caret for inline AI completion
 * and Mini-NEP without changing execution-oriented `splitSqlStatements` semantics.
 */
export function isolateActiveSqlStatement(prefix, suffix, dialect) {
  const safePrefix = typeof prefix === 'string' ? prefix : ''
  const safeSuffix = typeof suffix === 'string' ? suffix : ''
  const windowText = `${safePrefix}${safeSuffix}`
  const cursorOffset = safePrefix.length

  if (dialect === 'redis') {
    return buildIsolatedWindow(windowText, 0, windowText.length, cursorOffset, {
      hasPrecedingStatements: false,
      terminatedBySemicolon: false,
      semiEnd: -1,
      cursorAfterSemicolon: false,
      isFreshStatementAfterSemicolon: false,
      precedingErroredSlice: null,
    })
  }

  if (dialect === 'mongodb') {
    const stmts = splitMongoStatements(windowText)
    if (stmts.length === 0) {
      return buildIsolatedWindow(windowText, 0, windowText.length, cursorOffset, {
        hasPrecedingStatements: false,
        terminatedBySemicolon: false,
        semiEnd: -1,
        cursorAfterSemicolon: false,
        isFreshStatementAfterSemicolon: false,
        precedingErroredSlice: null,
      })
    }
    if (cursorOffset < stmts[0].start) {
      return buildIsolatedWindow(windowText, 0, stmts[0].start, cursorOffset, {
        hasPrecedingStatements: false,
        terminatedBySemicolon: false,
        semiEnd: -1,
        cursorAfterSemicolon: false,
        isFreshStatementAfterSemicolon: false,
        precedingErroredSlice: null,
      })
    }
    const findMongoSemiAfter = (fromIdx, limitIdx) => {
      let p = fromIdx
      while (p < limitIdx) {
        const tok = advanceMongoJsToken(windowText, p, 'ident')
        if (tok.kind === 'ws' || tok.kind === 'comment') {
          p = tok.end
          continue
        }
        return tok.text === ';' ? p : -1
      }
      return -1
    }
    for (let idx = 0; idx < stmts.length; idx++) {
      const seg = stmts[idx]
      const next = stmts[idx + 1]
      if (next && cursorOffset >= next.start) continue
      const semiPos = findMongoSemiAfter(seg.end, next ? next.start : windowText.length)
      const semiEndAbs = semiPos >= 0 ? semiPos + 1 : -1
      const beforeSemiBound = semiPos >= 0 ? semiPos : seg.end
      if (cursorOffset <= beforeSemiBound || (!next && semiPos < 0)) {
        const spanEnd = Math.max(semiEndAbs >= 0 ? semiEndAbs : seg.end, cursorOffset)
        return buildIsolatedWindow(windowText, seg.start, spanEnd, cursorOffset, {
          hasPrecedingStatements: idx > 0,
          terminatedBySemicolon: semiPos >= 0,
          semiEnd: semiEndAbs >= 0 ? semiEndAbs - seg.start : -1,
          cursorAfterSemicolon: false,
          isFreshStatementAfterSemicolon: false,
          precedingErroredSlice: null,
        })
      }
      if (semiEndAbs >= 0) {
        const gapAfterSemi = windowText.slice(semiEndAbs, cursorOffset)
        if (/^[ \t]*$/.test(gapAfterSemi)) {
          const spanEnd = Math.max(semiEndAbs, cursorOffset)
          return buildIsolatedWindow(windowText, seg.start, spanEnd, cursorOffset, {
            hasPrecedingStatements: idx > 0,
            terminatedBySemicolon: true,
            semiEnd: semiEndAbs - seg.start,
            cursorAfterSemicolon: true,
            isFreshStatementAfterSemicolon: false,
            precedingErroredSlice: null,
          })
        }
        const stmtSuffix = next
          ? windowText.slice(cursorOffset, next.start)
          : windowText.slice(cursorOffset)
        return {
          text: '',
          stmtPrefix: gapAfterSemi,
          stmtSuffix,
          spanStart: semiEndAbs,
          spanEnd: cursorOffset,
          relCursor: 0,
          cursorOffsetInSpan: cursorOffset - semiEndAbs,
          lineCount: gapAfterSemi ? gapAfterSemi.split(/\r?\n/).length : 1,
          hasPrecedingStatements: true,
          terminatedBySemicolon: false,
          semiEnd: -1,
          cursorAfterSemicolon: false,
          isFreshStatementAfterSemicolon: true,
          precedingErroredSlice: {
            text: windowText.slice(seg.start, semiEndAbs),
            spanStart: seg.start,
            spanEnd: semiEndAbs,
            semiEnd: semiEndAbs - seg.start,
          },
        }
      }
    }
    const tail = stmts[stmts.length - 1]
    return buildIsolatedWindow(windowText, tail.start, Math.max(tail.end, cursorOffset), cursorOffset, {
      hasPrecedingStatements: stmts.length > 1,
      terminatedBySemicolon: false,
      semiEnd: -1,
      cursorAfterSemicolon: false,
      isFreshStatementAfterSemicolon: false,
      precedingErroredSlice: null,
    })
  }

  const recoveryStart = findAbandonedSqlRecoveryStart(safePrefix, safeSuffix, dialect)
  const segs = splitAiSqlSegments(windowText, dialect, recoveryStart)
  if (segs.length === 0) {
    const text = recoveryStart > 0 ? windowText.slice(recoveryStart) : windowText
    const relCursor = Math.max(0, cursorOffset - recoveryStart)
    return {
      text,
      stmtPrefix: text.slice(0, relCursor),
      stmtSuffix: text.slice(relCursor),
      spanStart: recoveryStart,
      spanEnd: windowText.length,
      relCursor,
      cursorOffsetInSpan: relCursor,
      lineCount: text ? text.split(/\r?\n/).length : 1,
      hasPrecedingStatements: recoveryStart > 0,
      terminatedBySemicolon: false,
      semiEnd: -1,
      cursorAfterSemicolon: false,
      isFreshStatementAfterSemicolon: false,
      precedingErroredSlice: null,
    }
  }

  for (let idx = 0; idx < segs.length; idx++) {
    const seg = segs[idx]
    const next = segs[idx + 1]
    if (next && cursorOffset >= next.start) continue

    const beforeSemiBound = seg.hasSemicolon ? seg.semiEnd - 1 : seg.end
    if (cursorOffset <= beforeSemiBound || (!seg.hasSemicolon && !next)) {
      const spanEnd = Math.max(seg.hasSemicolon ? seg.semiEnd : seg.end, cursorOffset)
      return buildIsolatedWindow(windowText, seg.start, spanEnd, cursorOffset, {
        hasPrecedingStatements: idx > 0 || recoveryStart > 0,
        terminatedBySemicolon: seg.hasSemicolon,
        semiEnd: seg.hasSemicolon ? seg.semiEnd - seg.start : -1,
        cursorAfterSemicolon: false,
        isFreshStatementAfterSemicolon: false,
        precedingErroredSlice: null,
      })
    }

    if (seg.hasSemicolon) {
      const gapAfterSemi = windowText.slice(seg.semiEnd, cursorOffset)
      if (/^[ \t]*$/.test(gapAfterSemi)) {
        const spanEnd = Math.max(seg.semiEnd, cursorOffset)
        return buildIsolatedWindow(windowText, seg.start, spanEnd, cursorOffset, {
          hasPrecedingStatements: idx > 0 || recoveryStart > 0,
          terminatedBySemicolon: true,
          semiEnd: seg.semiEnd - seg.start,
          cursorAfterSemicolon: true,
          isFreshStatementAfterSemicolon: false,
          precedingErroredSlice: null,
        })
      }
      const stmtSuffix = next
        ? windowText.slice(cursorOffset, next.start)
        : windowText.slice(cursorOffset)
      return {
        text: '',
        stmtPrefix: gapAfterSemi,
        stmtSuffix,
        spanStart: seg.semiEnd,
        spanEnd: cursorOffset,
        relCursor: 0,
        cursorOffsetInSpan: cursorOffset - seg.semiEnd,
        lineCount: gapAfterSemi ? gapAfterSemi.split(/\r?\n/).length : 1,
        hasPrecedingStatements: true,
        terminatedBySemicolon: false,
        semiEnd: -1,
        cursorAfterSemicolon: false,
        isFreshStatementAfterSemicolon: true,
        precedingErroredSlice: {
          text: windowText.slice(seg.start, seg.semiEnd),
          spanStart: seg.start,
          spanEnd: seg.semiEnd,
          semiEnd: seg.semiEnd - seg.start,
        },
      }
    }

    // Soft-split gap without semicolon when caret sits strictly between seg.end and next.start
    const spanEnd = Math.max(seg.end, cursorOffset)
    return buildIsolatedWindow(windowText, seg.start, spanEnd, cursorOffset, {
      hasPrecedingStatements: idx > 0 || recoveryStart > 0,
      terminatedBySemicolon: false,
      semiEnd: -1,
      cursorAfterSemicolon: false,
      isFreshStatementAfterSemicolon: false,
      precedingErroredSlice: null,
    })
  }

  const last = segs[segs.length - 1]
  const spanEnd = Math.max(last.hasSemicolon ? last.semiEnd : last.end, cursorOffset)
  return buildIsolatedWindow(windowText, last.start, spanEnd, cursorOffset, {
    hasPrecedingStatements: segs.length > 1 || recoveryStart > 0,
    terminatedBySemicolon: last.hasSemicolon,
    semiEnd: last.hasSemicolon ? last.semiEnd - last.start : -1,
    cursorAfterSemicolon: false,
    isFreshStatementAfterSemicolon: false,
    precedingErroredSlice: null,
  })
}
