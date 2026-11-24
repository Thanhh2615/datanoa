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
  if (dialect === 'mssql') {
    return `[${raw.replace(/\]/g, ']]')}]`
  }
  if (BACKTICK_DIALECTS.has(dialect)) {
    return `\`${raw.replace(/`/g, '``')}\``
  }
  return `"${raw.replace(/"/g, '""')}"`
}

function scanBracketIdentEnd(sql, start) {
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

function tryParseQuotedTableParts(trimmed) {
  const quoteChar = trimmed[0]
  if (quoteChar === '[') {
    const parts = []
    let pos = 0
    const len = trimmed.length
    while (pos < len) {
      if (trimmed[pos] !== '[') return null
      const seg = scanBracketIdentEnd(trimmed, pos)
      if (!seg.closed) return null
      const unescaped = trimmed.slice(pos + 1, seg.end - 1).replace(/\]\]/g, ']')
      if (!unescaped) return null
      parts.push(unescaped)
      pos = seg.end
      if (pos < len) {
        if (trimmed[pos] !== '.') return null
        pos++
        if (pos >= len) return null
      }
    }
    return parts
  }
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

  return parts
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
  if (
    !trimmed.includes('"') &&
    !trimmed.includes('`') &&
    !trimmed.includes('[') &&
    trimmed.includes('.')
  ) {
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

function advanceMongoJsToken(text, i, prevKind) {
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
  const backslashAndHash = usesBackslashAndHash(dialect)
  const nestedComments = supportsNestedBlockComments(dialect)
  const dollarQuotes = supportsDollarQuoting(dialect)
  const allowMysqlDelimiter = dialect !== undefined && MYSQL_FAMILY_DIALECTS.has(dialect)
  const supportsCompoundRoutineBegin =
    dialect === 'sqlite' ||
    dialect === 'libsql' ||
    dialect === 'd1' ||
    dialect === 'mysql' ||
    dialect === 'mariadb' ||
    dialect === 'mssql' ||
    dialect === 'oracle'

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
    const oracleQuote = scanOracleQuoteEnd(script, i, dialect)
    if (oracleQuote) {
      hasExecutableToken = true
      i = oracleQuote.end
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
    if (ch === '[' && dialect === 'mssql') {
      hasExecutableToken = true
      i = scanBracketIdentEnd(script, i).end
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

  if (replaceFrom < 0 && target?.fallbackSql) {
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

  if (replaceTo < docLen && text[replaceTo] === ';' && replacement.endsWith(';')) {
    replaceTo += 1
  }

  return { from: replaceFrom, to: replaceTo, insert: replacement }
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
    const oracleQuote = scanOracleQuoteEnd(sql, i, dialect)
    if (oracleQuote) {
      out += ' '
      i = oracleQuote.end
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      out += ' '
      const allowBackslash = ch === "'" && backslashAndHash
      i = scanQuotedSegmentEnd(sql, i, ch, allowBackslash).end
      continue
    }
    if (ch === '[' && dialect === 'mssql') {
      out += ' '
      i = scanBracketIdentEnd(sql, i).end
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
    const oracleQuote = scanOracleQuoteEnd(sql, i, dialect)
    if (oracleQuote) {
      tokens.push({ kind: 'quoted', text: sql.slice(i, oracleQuote.end), upper: '' })
      i = oracleQuote.end
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const allowBackslash = ch === "'" && usesBackslashAndHash(dialect)
      const end = scanQuotedSegmentEnd(sql, i, ch, allowBackslash).end
      tokens.push({ kind: 'quoted', text: sql.slice(i, end), upper: '' })
      i = end
      continue
    }
    if (ch === '[' && dialect === 'mssql') {
      const end = scanBracketIdentEnd(sql, i).end
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
  if (dialect === 'redis' || dialect === 'mongodb') {
    return sql.trim()
  }

  const tokens = tokenizeSqlForFormat(sql, dialect)
  const makeIndent = (level) => '  '.repeat(Math.max(0, level))
  const parenStack = [createFormatFrame('query', 0, 0, false)]
  const getCurrentFrame = () => parenStack[parenStack.length - 1]

  let out = ''
  let forceNewlineIndent = null
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
    if (out.length === 0) return false
    const lastChar = out[out.length - 1]
    if (lastChar === '\n' || lastChar === ' ' || lastChar === '\t') return false
    if (
      tok.kind === 'comma' ||
      tok.kind === 'semicolon' ||
      tok.kind === 'paren_close' ||
      tok.kind === 'dot' ||
      tok.kind === 'cast'
    ) {
      return false
    }
    if (prevToken) {
      if (prevToken.kind === 'paren_open' || prevToken.kind === 'dot' || prevToken.kind === 'cast') {
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
      parenStack.length = 0
      parenStack.push(createFormatFrame('query', 0, 0, false))
      afterSemicolon = true
      prevToken = tok
      i++
      continue
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

  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim()
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
        j = lineEnd
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
      if (k < len && raw[k] === '/') {
        let after = k + 1
        while (after < len && (raw[after] === ' ' || raw[after] === '\t')) after++
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
