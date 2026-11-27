// Pure dialect-aware SQL parameter scanner, coercer, and safe literal binder.
// Shared across Node Worker, bundled Studio TS, and native-ESM browser Side Panel.

import {
  formatSqlBinaryLiteral,
  getDialectLexerRules,
  isIdentContChar,
  isIdentStartChar,
  isPostgresEscapeStringStart,
  matchDollarQuoteTag,
  normalizeJsonValue,
  scanBlockCommentEnd,
  scanBracketIdentEnd,
  scanLineCommentEnd,
  scanOracleQuoteEnd,
  scanQuotedSegmentEnd,
} from './shared-sql-core.js'

const BACKTICK_DIALECTS = new Set(['mysql', 'mariadb', 'clickhouse'])
const POSTGRES_FAMILY_DIALECTS = new Set([
  'postgres',
  'postgresql',
  'cockroachdb',
  'redshift',
  'greenplum',
  'timescaledb',
])
const MYSQL_FAMILY_DIALECTS = new Set(['mysql', 'mariadb'])
const SQLITE_FAMILY_DIALECTS = new Set(['sqlite', 'libsql', 'd1'])
const TERNARY_GUARDED_DIALECTS = new Set([
  'postgres',
  'postgresql',
  'cockroachdb',
  'redshift',
  'greenplum',
  'timescaledb',
  'clickhouse',
])

function normalizeSqlDialect(dialect) {
  return typeof dialect === 'string' ? dialect.trim().toLowerCase() : ''
}

function resolveCoreSqlDialect(normDialect) {
  return POSTGRES_FAMILY_DIALECTS.has(normDialect) && normDialect !== 'cockroachdb'
    ? 'postgres'
    : normDialect
}
const HAS_NON_ASCII_RE = /[^\x00-\x7f]/
const MSSQL_STMT_START_KEYWORDS = new Set([
  'SELECT',
  'WITH',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'SET',
  'IF',
  'WHILE',
  'BEGIN',
  'END',
  'RETURN',
  'EXEC',
  'EXECUTE',
  'PRINT',
  'THROW',
  'RAISERROR',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'USE',
  'COMMIT',
  'ROLLBACK',
  'SAVE',
  'GO',
])

// M4: Only accept bare `?` on PostgreSQL, CockroachDB, and ClickHouse when the
// preceding meaningful token introduces an expression value (never JSONB `?` or ternary `cond ? a : b`).
const QUESTION_VALUE_PREFIX_TOKENS = new Set([
  '=',
  '!=',
  '<>',
  '<',
  '<=',
  '>',
  '>=',
  '(',
  ',',
  '+',
  '-',
  '*',
  '/',
  '%',
  '||',
  'SELECT',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'IN',
  'LIKE',
  'ILIKE',
  'BETWEEN',
  'LIMIT',
  'OFFSET',
  'FETCH',
  'VALUES',
  'SET',
  'THEN',
  'ELSE',
  'WHEN',
  'HAVING',
  'ON',
  'RETURNING',
  'CASE',
  'DISTINCT',
])

const TERNARY_COLON_VALUE_PREFIX_TOKENS = new Set([
  '',
  ';',
  '?',
  ':',
  '::',
  ':=',
  '[',
  '?|',
  '?&',
  'FROM',
  'JOIN',
  'USING',
  'BY',
  'AS',
  'IS',
  ...QUESTION_VALUE_PREFIX_TOKENS,
])

const TERNARY_CLAUSE_RESET_KEYWORDS = new Set([
  'FROM',
  'WHERE',
  'GROUP',
  'HAVING',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'RETURNING',
  'INTO',
  'SET',
  'VALUES',
  'JOIN',
  'ON',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
])

const MYSQL_SET_RESET_KEYWORDS = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'UPDATE',
  'INSERT',
  'DELETE',
])

const CREATE_NON_TRIGGER_TARGETS = new Set([
  'TABLE',
  'VIEW',
  'INDEX',
  'PROCEDURE',
  'FUNCTION',
  'DATABASE',
  'SCHEMA',
  'SEQUENCE',
  'TYPE',
  'ROLE',
  'USER',
])

const CONTEXT_PREVIEW_RADIUS = 24

function sliceScalarWindowBackward(text, endIndex, maxScalars) {
  const scalars = []
  let i = endIndex
  while (i > 0 && scalars.length < maxScalars) {
    const code = text.charCodeAt(i - 1)
    if (code >= 0xdc00 && code <= 0xdfff && i >= 2) {
      const high = text.charCodeAt(i - 2)
      if (high >= 0xd800 && high <= 0xdbff) {
        scalars.push(text.slice(i - 2, i))
        i -= 2
        continue
      }
    }
    scalars.push(text[i - 1])
    i -= 1
  }
  return scalars.reverse().join('')
}

function sliceScalarWindowForward(text, startIndex, maxScalars) {
  let result = ''
  let count = 0
  let i = startIndex
  while (i < text.length && count < maxScalars) {
    const cp = text.codePointAt(i)
    const ch = String.fromCodePoint(cp)
    result += ch
    i += ch.length
    count += 1
  }
  return result
}

function buildQuestionContextPreview(sql, start, end) {
  const rawBefore = sliceScalarWindowBackward(sql, start, CONTEXT_PREVIEW_RADIUS)
  const rawAfter = sliceScalarWindowForward(sql, end, CONTEXT_PREVIEW_RADIUS)
  const before = rawBefore.replace(/\s+/g, ' ').trimStart()
  const after = rawAfter.replace(/\s+/g, ' ').trimEnd()
  const prefixEllipsis = start > rawBefore.length ? '...' : ''
  const suffixEllipsis = end + rawAfter.length < sql.length ? '...' : ''
  return `${prefixEllipsis}${before}${sql.slice(start, end)}${after}${suffixEllipsis}`.trim()
}

function formatMssqlBackslashNewlineString(raw) {
  const prefix = HAS_NON_ASCII_RE.test(raw) ? 'N' : ''
  const parts = []
  let current = `${prefix}'`
  let i = 0
  while (i < raw.length) {
    const cp = raw.codePointAt(i)
    const ch = String.fromCodePoint(cp)
    if (ch === '\\') {
      const next = raw[i + 1]
      if (next === '\r' && raw[i + 2] === '\n') {
        current += "\\'"
        parts.push(current, 'CHAR(13)', 'CHAR(10)')
        current = `${prefix}'`
        i += 3
        continue
      }
      if (next === '\n') {
        current += "\\'"
        parts.push(current, 'CHAR(10)')
        current = `${prefix}'`
        i += 2
        continue
      }
      if (next === '\r') {
        current += "\\'"
        parts.push(current, 'CHAR(13)')
        current = `${prefix}'`
        i += 2
        continue
      }
    }
    current += ch === "'" ? "''" : ch
    i += ch.length
  }
  if (current !== `${prefix}'` || parts.length === 0) {
    parts.push(`${current}'`)
  }
  return parts.join(' + ')
}

function shouldEscapeBackslashInLiteral(normDialect, options) {
  if (MYSQL_FAMILY_DIALECTS.has(normDialect) || normDialect === 'clickhouse') {
    return options?.noBackslashEscapes !== true
  }
  if (POSTGRES_FAMILY_DIALECTS.has(normDialect)) {
    return options?.standardConformingStrings === false
  }
  return BACKTICK_DIALECTS.has(normDialect)
}

function formatSqlBindStringLiteral(raw, dialect, options) {
  if (raw.includes('\0')) {
    throw new Error('Parameter value cannot contain NUL (\\0) bytes')
  }
  const normDialect = normalizeSqlDialect(dialect)
  if (normDialect === 'mssql' && /\\(?:\r\n|\r|\n)/.test(raw)) {
    return formatMssqlBackslashNewlineString(raw)
  }
  const isPgWithBackslash = POSTGRES_FAMILY_DIALECTS.has(normDialect) && raw.includes('\\')
  const escapeBackslash = isPgWithBackslash || shouldEscapeBackslashInLiteral(normDialect, options)
  let escaped = ''
  for (const scalar of raw) {
    if (scalar === "'") {
      escaped += "''"
    } else if (escapeBackslash && scalar === '\\') {
      escaped += '\\\\'
    } else {
      escaped += scalar
    }
  }
  const prefix = isPgWithBackslash
    ? 'E'
    : normDialect === 'mssql' && HAS_NON_ASCII_RE.test(raw)
      ? 'N'
      : ''
  return `${prefix}'${escaped}'`
}

/**
 * Pure-JS SQL bind literal formatter safe across all 3 runtimes.
 * Rejects NUL bytes, escapes by Unicode scalar without breaking grapheme clusters,
 * emits standard-conforming-safe E'...' on PostgreSQL-family backslashes,
 * mitigates T-SQL KB 164291 backslash-newline continuation, emits N'...' for non-ASCII T-SQL,
 * and maps NaN/Infinity to NULL.
 */
export function formatSqlBindLiteral(value, dialect, options) {
  const normDialect = normalizeSqlDialect(dialect)
  const coreDialect = resolveCoreSqlDialect(normDialect)
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') {
    return normDialect === 'mssql' || normDialect === 'oracle'
      ? value
        ? '1'
        : '0'
      : value
        ? 'TRUE'
        : 'FALSE'
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL'
  }
  if (typeof value === 'bigint') {
    return value.toString()
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? 'NULL'
      : formatSqlBindStringLiteral(value.toISOString(), normDialect, options)
  }
  if (value instanceof ArrayBuffer) {
    const hex = Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, '0')).join('')
    return formatSqlBinaryLiteral(hex, coreDialect)
  }
  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    const hex = Array.from(view, (b) => b.toString(16).padStart(2, '0')).join('')
    return formatSqlBinaryLiteral(hex, coreDialect)
  }
  if (typeof value === 'object') {
    return formatSqlBindStringLiteral(JSON.stringify(normalizeJsonValue(value)), normDialect, options)
  }
  return formatSqlBindStringLiteral(String(value), normDialect, options)
}

function matchBraceTemplateParam(sql, index) {
  const len = sql.length
  const ch = sql[index]
  let kind = null
  let contentStart = -1
  let closeSeq = ''

  if (ch === '{' && index + 1 < len && sql[index + 1] === '{') {
    kind = 'template-double-brace'
    contentStart = index + 2
    closeSeq = '}}'
  } else if (ch === '$' && index + 1 < len && sql[index + 1] === '{') {
    kind = 'template-dollar-brace'
    contentStart = index + 2
    closeSeq = '}'
  } else {
    return null
  }

  let cursor = contentStart
  while (cursor < len && (sql[cursor] === ' ' || sql[cursor] === '\t')) {
    cursor++
  }
  if (cursor >= len || !isIdentStartChar(sql.charCodeAt(cursor))) {
    return null
  }
  const nameStart = cursor
  cursor++
  while (cursor < len && isIdentContChar(sql.charCodeAt(cursor))) {
    cursor++
  }
  const bareName = sql.slice(nameStart, cursor)
  while (cursor < len && (sql[cursor] === ' ' || sql[cursor] === '\t')) {
    cursor++
  }
  if (!sql.startsWith(closeSeq, cursor)) {
    return null
  }

  const end = cursor + closeSeq.length
  const key = kind === 'template-double-brace' ? `{{${bareName}}}` : `\${${bareName}}`
  return {
    start: index,
    end,
    key,
    raw: sql.slice(index, end),
    bareName,
    style: kind,
  }
}

function isFollowedByDot(sql, index) {
  let k = index
  while (k < sql.length && /\s/.test(sql[k])) {
    k++
  }
  return k < sql.length && sql[k] === '.'
}

/**
 * Performs a lexer-aware scan of the SQL string, skipping comments, string literals,
 * quoted identifiers, bracket identifiers, dollar-quoted blocks, type casts, system variables,
 * trigger :NEW/:OLD references, and Postgres/CockroachDB/ClickHouse `?` operator uses.
 */
export function scanSqlParameterTokens(sql, dialect, options) {
  const normDialect = normalizeSqlDialect(dialect)
  if (!sql || typeof sql !== 'string' || normDialect === 'redis' || normDialect === 'mongodb') {
    return []
  }

  const tokens = []
  const assignedMysqlUserVars = new Set()
  const declaredMssqlVars = new Set()
  const usedQuestionIndices = new Set()
  const len = sql.length
  const coreDialect = resolveCoreSqlDialect(normDialect)
  const rules = getDialectLexerRules(coreDialect)
  const isMysqlFamily = MYSQL_FAMILY_DIALECTS.has(normDialect)
  const isPostgresFamily = POSTGRES_FAMILY_DIALECTS.has(normDialect)
  const isSqliteFamily = SQLITE_FAMILY_DIALECTS.has(normDialect)
  const isMssql = normDialect === 'mssql'
  const isTernaryGuarded = TERNARY_GUARDED_DIALECTS.has(normDialect)

  let pgBracketDepth = 0
  const ternaryDepthStack = [0]
  let inMysqlSetStmt = false
  let mssqlDeclareState = 'none'
  let mssqlDeclareParenDepth = 0
  let pendingCreateTrigger = false
  let inTriggerStmt = false
  let triggerBeginDepth = 0
  let lastMeaningfulToken = ''
  let nextQuestionSeq = 1
  let i = 0

  while (i < len) {
    const ch = sql[i]

    if (/\s/.test(ch)) {
      i++
      continue
    }

    // 1. Line comments: -- ...
    if (rules.lineCommentDash && ch === '-' && i + 1 < len && sql[i + 1] === '-') {
      i = scanLineCommentEnd(sql, i)
      continue
    }

    // 1b. ClickHouse line comments: // ...
    if (rules.lineCommentSlash && ch === '/' && i + 1 < len && sql[i + 1] === '/') {
      i = scanLineCommentEnd(sql, i)
      continue
    }

    // 2. MySQL / MariaDB / ClickHouse line comments: # ...
    if (rules.lineCommentHash && ch === '#') {
      i = scanLineCommentEnd(sql, i - 1)
      continue
    }

    // 3. Block comments: /* ... */
    if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
      i = scanBlockCommentEnd(sql, i, rules.nestedBlockComments)
      continue
    }

    // 4. PostgreSQL escape string literal: E'...' or e'...'
    if (isPostgresEscapeStringStart(sql, i, coreDialect)) {
      i = scanQuotedSegmentEnd(sql, i + 1, "'", true).end
      lastMeaningfulToken = 'LITERAL'
      continue
    }

    // 4b. Oracle q'[...]' / nq'[...]' alternative quote literals
    const oracleQuote = scanOracleQuoteEnd(sql, i, coreDialect)
    if (oracleQuote) {
      i = oracleQuote.end
      lastMeaningfulToken = 'LITERAL'
      continue
    }

    // 5. Quoted literals & identifiers: '...', "...", `...`
    if (ch === "'" || ch === '"' || (ch === '`' && rules.backtickIdentifiers)) {
      let allowBackslash =
        (ch === "'" && rules.backslashEscapesSingleQuote) ||
        (ch === '"' && rules.backslashEscapesDoubleQuote)
      if (ch === "'") {
        if ((isMysqlFamily || normDialect === 'clickhouse') && options?.noBackslashEscapes === true) {
          allowBackslash = false
        } else if (isPostgresFamily && options?.standardConformingStrings === false) {
          allowBackslash = true
        }
      }
      i = scanQuotedSegmentEnd(sql, i, ch, allowBackslash).end
      lastMeaningfulToken = ch === "'" ? 'LITERAL' : 'IDENT'
      continue
    }

    // 6. Bracket identifiers: [...] (SQLite / LibSQL / D1 / MSSQL)
    if (ch === '[' && rules.bracketIdentifiers !== 'none') {
      i = scanBracketIdentEnd(sql, i, true).end
      lastMeaningfulToken = 'IDENT'
      continue
    }

    // 6b. Postgres / CockroachDB array subscript/slice brackets `[start:end]`
    if (isPostgresFamily && ch === '[') {
      pgBracketDepth++
      lastMeaningfulToken = '['
      i++
      continue
    }
    if (isPostgresFamily && ch === ']' && pgBracketDepth > 0) {
      pgBracketDepth--
      lastMeaningfulToken = ']'
      i++
      continue
    }

    // 7. Template placeholders: `{{name}}` and `${name}`
    const braceParam = matchBraceTemplateParam(sql, i)
    if (braceParam) {
      tokens.push(braceParam)
      lastMeaningfulToken = 'PARAM'
      i = braceParam.end
      continue
    }

    // 8. PostgreSQL / CockroachDB dollar-quoted blocks: $$...$$ and $tag$...$tag$
    if (rules.dollarQuoting && ch === '$') {
      const tag = matchDollarQuoteTag(sql, i)
      if (tag !== null) {
        const closeIdx = sql.indexOf(tag, i + tag.length)
        i = closeIdx >= 0 ? closeIdx + tag.length : len
        lastMeaningfulToken = 'LITERAL'
        continue
      }
    }

    // 9. Statement boundaries & multi-char operators
    if (ch === ';') {
      inMysqlSetStmt = false
      mssqlDeclareState = 'none'
      mssqlDeclareParenDepth = 0
      ternaryDepthStack.length = 1
      ternaryDepthStack[0] = 0
      if (triggerBeginDepth === 0) {
        inTriggerStmt = false
        pendingCreateTrigger = false
      }
      lastMeaningfulToken = ';'
      i++
      continue
    }

    if (isMssql && mssqlDeclareState !== 'none') {
      if (ch === '(') {
        mssqlDeclareParenDepth++
      } else if (ch === ')' && mssqlDeclareParenDepth > 0) {
        mssqlDeclareParenDepth--
      } else if (mssqlDeclareParenDepth === 0) {
        if (ch === ',') {
          mssqlDeclareState = 'expect-var'
        } else if (ch === '=') {
          mssqlDeclareState = 'in-init-expr'
        }
      }
    }

    // 10. PostgreSQL type casts: ::type
    if (ch === ':' && i + 1 < len && sql[i + 1] === ':') {
      while (i < len && sql[i] === ':') {
        i++
      }
      lastMeaningfulToken = '::'
      continue
    }

    // 11. MySQL system variables: @@version or @@global.var
    if (ch === '@' && i + 1 < len && sql[i + 1] === '@') {
      while (i < len && sql[i] === '@') {
        i++
      }
      while (i < len && (isIdentContChar(sql.charCodeAt(i)) || sql[i] === '.')) {
        i++
      }
      lastMeaningfulToken = 'SYSVAR'
      continue
    }

    // 12. Named colon parameter: :name ([A-Za-z_][A-Za-z0-9_]*)
    if (ch === ':') {
      if (isPostgresFamily && pgBracketDepth > 0) {
        lastMeaningfulToken = ':'
        i++
        continue
      }
      if (i + 1 < len && sql[i + 1] === '=') {
        lastMeaningfulToken = ':='
        i += 2
        continue
      }
      // Consume `:` as ternary `cond ? a : b` separator when an open `?` expects its `:` branch
      if (
        isTernaryGuarded &&
        ternaryDepthStack[ternaryDepthStack.length - 1] > 0 &&
        !TERNARY_COLON_VALUE_PREFIX_TOKENS.has(lastMeaningfulToken)
      ) {
        ternaryDepthStack[ternaryDepthStack.length - 1]--
        lastMeaningfulToken = ':'
        i++
        continue
      }
      const prevIsIdent = i > 0 && isIdentContChar(sql.charCodeAt(i - 1))
      if (!prevIsIdent && i + 1 < len && isIdentStartChar(sql.charCodeAt(i + 1))) {
        let j = i + 2
        while (j < len && isIdentContChar(sql.charCodeAt(j))) {
          j++
        }
        const raw = sql.slice(i, j)
        const bareName = raw.slice(1)
        const upperBare = bareName.toUpperCase()
        const isTriggerPseudo =
          (upperBare === 'NEW' || upperBare === 'OLD') &&
          (inTriggerStmt || isFollowedByDot(sql, j))
        if (isTriggerPseudo) {
          lastMeaningfulToken = 'IDENT'
          i = j
          continue
        }
        tokens.push({
          start: i,
          end: j,
          key: raw,
          raw,
          bareName,
          style: 'named-colon',
        })
        lastMeaningfulToken = 'PARAM'
        i = j
        continue
      }
    }

    // 13. Named at parameter: @name ([A-Za-z_][A-Za-z0-9_]*)
    if (ch === '@') {
      const prevIsIdent = i > 0 && isIdentContChar(sql.charCodeAt(i - 1))
      if (!prevIsIdent && i + 1 < len && isIdentStartChar(sql.charCodeAt(i + 1))) {
        let j = i + 2
        while (j < len && isIdentContChar(sql.charCodeAt(j))) {
          j++
        }
        const raw = sql.slice(i, j)
        const bareName = raw.slice(1)
        if (isMysqlFamily) {
          let k = j
          while (k < len && /\s/.test(sql[k])) {
            k++
          }
          const isColonAssign = k + 1 < len && sql[k] === ':' && sql[k + 1] === '='
          const isSetEqAssign = inMysqlSetStmt && k < len && sql[k] === '='
          if (isColonAssign || isSetEqAssign) {
            assignedMysqlUserVars.add(raw.toLowerCase())
            lastMeaningfulToken = isColonAssign ? ':=' : '='
            i = isColonAssign ? k + 2 : k + 1
            continue
          }
          if (assignedMysqlUserVars.has(raw.toLowerCase())) {
            lastMeaningfulToken = 'IDENT'
            i = j
            continue
          }
        }
        if (isMssql) {
          if (mssqlDeclareState === 'expect-var') {
            declaredMssqlVars.add(raw.toLowerCase())
            mssqlDeclareState = 'after-var'
            lastMeaningfulToken = 'IDENT'
            i = j
            continue
          }
          if (declaredMssqlVars.has(raw.toLowerCase())) {
            lastMeaningfulToken = 'IDENT'
            i = j
            continue
          }
        }
        tokens.push({
          start: i,
          end: j,
          key: raw,
          raw,
          bareName,
          style: 'named-at',
        })
        lastMeaningfulToken = 'PARAM'
        i = j
        continue
      }
    }

    // 14. Positional dollar parameter: $1..$999
    if (ch === '$') {
      const prevIsIdent = i > 0 && isIdentContChar(sql.charCodeAt(i - 1))
      if (
        !prevIsIdent &&
        i + 1 < len &&
        sql.charCodeAt(i + 1) >= 49 &&
        sql.charCodeAt(i + 1) <= 57
      ) {
        let j = i + 2
        while (j < len && sql.charCodeAt(j) >= 48 && sql.charCodeAt(j) <= 57) {
          j++
        }
        if (j >= len || !isIdentContChar(sql.charCodeAt(j))) {
          const bareName = sql.slice(i + 1, j)
          const num = Number(bareName)
          if (num >= 1 && num <= 999) {
            const raw = sql.slice(i, j)
            tokens.push({
              start: i,
              end: j,
              key: raw,
              raw,
              bareName,
              style: 'positional-dollar',
            })
            lastMeaningfulToken = 'PARAM'
            i = j
            continue
          }
        }
      }
    }

    // 15. Positional question parameter: ? (with M4 ternary/JSONB guard on postgres/cockroachdb/clickhouse)
    if (ch === '?') {
      if (i + 1 < len && (sql[i + 1] === '|' || sql[i + 1] === '&')) {
        lastMeaningfulToken = `?${sql[i + 1]}`
        i += 2
        continue
      }
      if (isTernaryGuarded && !QUESTION_VALUE_PREFIX_TOKENS.has(lastMeaningfulToken)) {
        ternaryDepthStack[ternaryDepthStack.length - 1]++
        lastMeaningfulToken = '?'
        i++
        continue
      }
      if (
        isSqliteFamily &&
        i + 1 < len &&
        sql.charCodeAt(i + 1) >= 49 &&
        sql.charCodeAt(i + 1) <= 57
      ) {
        let j = i + 2
        while (j < len && sql.charCodeAt(j) >= 48 && sql.charCodeAt(j) <= 57) {
          j++
        }
        if (j >= len || !isIdentContChar(sql.charCodeAt(j))) {
          const bareName = sql.slice(i + 1, j)
          const num = Number(bareName)
          if (num >= 1 && num <= 999) {
            const raw = sql.slice(i, j)
            usedQuestionIndices.add(num)
            if (num >= nextQuestionSeq) {
              nextQuestionSeq = num + 1
            }
            tokens.push({
              start: i,
              end: j,
              key: raw,
              raw,
              bareName,
              style: 'positional-question',
              contextPreview: buildQuestionContextPreview(sql, i, j),
            })
            lastMeaningfulToken = 'PARAM'
            i = j
            continue
          }
        }
      }
      while (usedQuestionIndices.has(nextQuestionSeq)) {
        nextQuestionSeq++
      }
      const seq = nextQuestionSeq++
      usedQuestionIndices.add(seq)
      tokens.push({
        start: i,
        end: i + 1,
        key: `?${seq}`,
        raw: '?',
        bareName: String(seq),
        style: 'positional-question',
        contextPreview: buildQuestionContextPreview(sql, i, i + 1),
      })
      lastMeaningfulToken = 'PARAM'
      i++
      continue
    }

    // 16. Identifiers & SQL keywords (for M4 prefix tracking, MySQL SET, and trigger context)
    if (isIdentStartChar(sql.charCodeAt(i))) {
      let j = i + 1
      while (j < len && isIdentContChar(sql.charCodeAt(j))) {
        j++
      }
      const wordUpper = sql.slice(i, j).toUpperCase()
      if (isMysqlFamily) {
        if (wordUpper === 'SET') {
          inMysqlSetStmt = true
        } else if (MYSQL_SET_RESET_KEYWORDS.has(wordUpper)) {
          inMysqlSetStmt = false
        }
      }
      if (isMssql) {
        if (wordUpper === 'GO') {
          let back = i - 1
          while (back >= 0 && (sql[back] === ' ' || sql[back] === '\t')) back--
          let fwd = j
          while (fwd < len && (sql[fwd] === ' ' || sql[fwd] === '\t' || sql[fwd] === ';')) fwd++
          const atLineStart = back < 0 || sql[back] === '\n' || sql[back] === '\r'
          const atLineEnd = fwd >= len || sql[fwd] === '\n' || sql[fwd] === '\r'
          if (atLineStart && atLineEnd) {
            declaredMssqlVars.clear()
            mssqlDeclareState = 'none'
            mssqlDeclareParenDepth = 0
          }
        } else if (
          wordUpper === 'DECLARE' &&
          (lastMeaningfulToken === '' ||
            lastMeaningfulToken === ';' ||
            MSSQL_STMT_START_KEYWORDS.has(lastMeaningfulToken))
        ) {
          mssqlDeclareState = 'expect-var'
          mssqlDeclareParenDepth = 0
        } else if (
          mssqlDeclareState !== 'none' &&
          mssqlDeclareParenDepth === 0 &&
          MSSQL_STMT_START_KEYWORDS.has(wordUpper)
        ) {
          mssqlDeclareState = 'none'
        }
      }
      if (wordUpper === 'CREATE') {
        pendingCreateTrigger = true
      } else if (pendingCreateTrigger) {
        if (wordUpper === 'TRIGGER') {
          inTriggerStmt = true
          pendingCreateTrigger = false
        } else if (CREATE_NON_TRIGGER_TARGETS.has(wordUpper)) {
          pendingCreateTrigger = false
        }
      }
      if (inTriggerStmt) {
        if (wordUpper === 'BEGIN') {
          triggerBeginDepth++
        } else if (wordUpper === 'END' && triggerBeginDepth > 0) {
          triggerBeginDepth--
        }
      }
      if (isTernaryGuarded && TERNARY_CLAUSE_RESET_KEYWORDS.has(wordUpper)) {
        ternaryDepthStack[ternaryDepthStack.length - 1] = 0
      }
      lastMeaningfulToken = wordUpper
      i = j
      continue
    }

    // 17. Numeric literals
    if (ch >= '0' && ch <= '9') {
      let j = i + 1
      while (j < len && /[0-9a-zA-Z_.]/.test(sql[j])) {
        j++
      }
      lastMeaningfulToken = 'LITERAL'
      i = j
      continue
    }

    // 18. Two-character SQL operators relevant to value prefixes
    if (i + 1 < len) {
      const two = sql.slice(i, i + 2)
      if (two === '!=' || two === '<>' || two === '<=' || two === '>=' || two === '||') {
        lastMeaningfulToken = two
        i += 2
        continue
      }
    }

    if (isTernaryGuarded) {
      if (ch === '(') {
        ternaryDepthStack.push(0)
      } else if (ch === ')') {
        if (ternaryDepthStack.length > 1) {
          ternaryDepthStack.pop()
        } else {
          ternaryDepthStack[0] = 0
        }
      } else if (ch === ',') {
        ternaryDepthStack[ternaryDepthStack.length - 1] = 0
      }
    }

    lastMeaningfulToken = ch
    i++
  }

  return tokens
}

/**
 * Extracts bind parameters from a SQL script according to dialect rules.
 * Preserves first-seen order, deduplicates named/numbered keys, keeps each `?` distinct
 * (`?1`, `?2`, ... with `contextPreview`), and attaches explicit `bareName` on every entry.
 */
export function extractSqlParameters(sql, dialect, options) {
  const normDialect = normalizeSqlDialect(dialect)
  if (!sql || typeof sql !== 'string' || normDialect === 'redis' || normDialect === 'mongodb') {
    return []
  }

  const tokens = scanSqlParameterTokens(sql, dialect, options)
  const paramMap = new Map()

  for (const token of tokens) {
    const existing = paramMap.get(token.key)
    if (existing) {
      existing.occurrences++
    } else {
      const entry = {
        key: token.key,
        raw: token.raw,
        bareName: token.bareName,
        style: token.style,
        occurrences: 1,
      }
      if (token.contextPreview !== undefined) {
        entry.contextPreview = token.contextPreview
      }
      paramMap.set(token.key, entry)
    }
  }

  return Array.from(paramMap.values())
}

/**
 * Coerces user parameter input into a typed JavaScript value.
 */
export function coerceBindParamValue(input) {
  const { type, value } = input

  switch (type) {
    case 'null':
      return null

    case 'raw':
    case 'text':
      return value

    case 'number': {
      const trimmed = value.trim()
      if (trimmed === '') {
        throw new Error('Invalid numeric parameter value: empty string')
      }
      if (/^[+-]?\d+$/.test(trimmed)) {
        const num = Number(trimmed)
        if (!Number.isSafeInteger(num)) {
          return BigInt(trimmed.replace(/^\+/, ''))
        }
        return num
      }
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
        throw new Error(
          `Invalid numeric parameter value: "${value}" is not a valid decimal number`
        )
      }
      const num = Number(trimmed)
      if (!Number.isFinite(num)) {
        throw new Error(
          `Invalid numeric parameter value: "${value}" is not a finite number`
        )
      }
      return num
    }

    case 'boolean': {
      const trimmedLower = value.trim().toLowerCase()
      if (
        trimmedLower === 'true' ||
        trimmedLower === 't' ||
        trimmedLower === '1' ||
        trimmedLower === 'yes' ||
        trimmedLower === 'y'
      ) {
        return true
      }
      if (
        trimmedLower === 'false' ||
        trimmedLower === 'f' ||
        trimmedLower === '0' ||
        trimmedLower === 'no' ||
        trimmedLower === 'n'
      ) {
        return false
      }
      throw new Error(
        `Invalid boolean parameter value: "${value}" is not true/false, 1/0, yes/no, or y/n`
      )
    }

    case 'auto': {
      if (value === '') {
        return ''
      }
      const trimmed = value.trim()
      const lower = trimmed.toLowerCase()
      if (lower === 'null') {
        return null
      }
      if (lower === 'true') {
        return true
      }
      if (lower === 'false') {
        return false
      }
      // Preserve leading-zero codes (e.g. '00123', ZIP/SKU/phone strings) as text
      if (/^[+-]?0\d+$/.test(trimmed)) {
        return value
      }
      if (/^[+-]?\d+$/.test(trimmed)) {
        const num = Number(trimmed)
        if (Number.isSafeInteger(num)) {
          return num
        }
        return BigInt(trimmed.replace(/^\+/, ''))
      }
      if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
        const sigDigits = trimmed
          .replace(/^[+-]?0+(?=\d)/, '')
          .replace('.', '')
          .replace(/[^0-9]/g, '').length
        if (sigDigits > 15) {
          return trimmed
        }
        const num = Number(trimmed)
        if (Number.isFinite(num)) {
          return num
        }
      }
      return value
    }
  }
}

function getOwnParamValue(values, key) {
  if (!values || typeof values !== 'object') return undefined
  return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined
}

function applyTokenPastingDefense(formatted, prevChar, nextChar, coerced) {
  let out = formatted
  if (
    (typeof coerced === 'number' || typeof coerced === 'bigint') &&
    out.startsWith('-') &&
    prevChar === '-'
  ) {
    out = `(${out})`
  } else if (prevChar === '-' && out.startsWith('-')) {
    out = ` ${out}`
  } else if (prevChar === '/' && (out.startsWith('*') || out.startsWith('/'))) {
    out = ` ${out}`
  } else if (prevChar && /[A-Za-z0-9_$]/.test(prevChar) && /^[A-Za-z0-9_]/.test(out)) {
    out = ` ${out}`
  }

  if (nextChar && /[A-Za-z0-9_$]/.test(nextChar) && /[A-Za-z0-9_]$/.test(out)) {
    out = `${out} `
  }
  return out
}

/**
 * Replaces parameter placeholders with safely formatted SQL literals using `formatSqlBindLiteral`.
 * Preserves comments, string literals, dollar quotes, casts, and `keepRaw` / `type: 'raw'` tokens.
 */
export function bindSqlParameters(sql, values, dialect, options) {
  const normDialect = normalizeSqlDialect(dialect)
  if (!sql || typeof sql !== 'string' || normDialect === 'redis' || normDialect === 'mongodb') {
    return sql ?? ''
  }

  const tokens = scanSqlParameterTokens(sql, dialect, options)
  if (tokens.length === 0) {
    return sql
  }

  let result = ''
  let lastIndex = 0

  for (const token of tokens) {
    result += sql.slice(lastIndex, token.start)

    const input =
      getOwnParamValue(values, token.key) ?? getOwnParamValue(values, token.bareName)
    if (input !== undefined) {
      if (input.keepRaw === true || input.type === 'raw') {
        result += sql.slice(token.start, token.end)
      } else {
        if (typeof input.value === 'string' && input.value.includes('\0')) {
          throw new Error('Parameter value cannot contain NUL (\\0) bytes')
        }
        const coerced = coerceBindParamValue(input)
        const rawFormatted = formatSqlBindLiteral(coerced, dialect, options)
        const prevChar = result.length > 0 ? result[result.length - 1] : ''
        const nextChar = token.end < sql.length ? sql[token.end] : ''
        result += applyTokenPastingDefense(rawFormatted, prevChar, nextChar, coerced)
      }
    } else {
      result += sql.slice(token.start, token.end)
    }

    lastIndex = token.end
  }

  result += sql.slice(lastIndex)
  return result
}
