/**
 * High-precision, zero-dependency, browser+Node ESM SQL syntax diagnostic engine.
 * Designed for strict zero-false-positive accuracy across 12+ SQL dialects,
 * plus exact DB engine syntax error span extraction.
 */

const MAX_DOC_LENGTH = 100_000
const MAX_DIAGNOSTICS = 25
const MAX_UNTERMINATED_SPAN = 24

const NON_SQL_DIALECTS = new Set(['redis', 'mongodb', 'elasticsearch', 'neo4j'])
const BACKSLASH_STRING_DIALECTS = new Set(['mysql', 'mariadb', 'clickhouse', 'snowflake', 'bigquery'])
const BACKSLASH_DOUBLE_QUOTE_DIALECTS = new Set(['mysql', 'mariadb', 'bigquery'])
const HASH_COMMENT_DIALECTS = new Set(['mysql', 'mariadb', 'clickhouse', 'bigquery'])
const NESTED_COMMENT_DIALECTS = new Set(['postgres', 'postgresql', 'cockroachdb', 'duckdb'])
const DOLLAR_QUOTE_DIALECTS = new Set(['', 'postgres', 'postgresql', 'cockroachdb', 'duckdb', 'snowflake'])
const PG_ESCAPE_STRING_DIALECTS = new Set(['', 'postgres', 'postgresql', 'cockroachdb', 'duckdb', 'snowflake'])
const TRAILING_COMMA_OK_DIALECTS = new Set(['duckdb', 'bigquery'])

const ORACLE_Q_DELIMS = {
  '[': ']',
  '(': ')',
  '{': '}',
  '<': '>',
}

const VALID_STATEMENT_STARTERS = new Set([
  // Core DML / Query
  'SELECT', 'WITH', 'FROM', 'VALUES', 'TABLE', 'INSERT', 'UPDATE', 'DELETE',
  'MERGE', 'REPLACE', 'UPSERT', 'TRUNCATE', 'COPY', 'LOAD', 'IMPORT', 'EXPORT',
  'BULK', 'UNLOAD', 'PUT', 'GET', 'LIST', 'REMOVE', 'PIVOT', 'UNPIVOT', 'SUMMARIZE',
  // DDL
  'CREATE', 'ALTER', 'DROP', 'RENAME', 'COMMENT', 'REFRESH', 'REINDEX', 'CLUSTER',
  'FLASHBACK', 'PURGE', 'AUDIT', 'NOAUDIT', 'ASSOCIATE', 'DISASSOCIATE', 'CLONE',
  'UNDROP', 'SWAP', 'EXCHANGE',
  // Transactions, Session & Procedural
  'BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'ABORT', 'SAVEPOINT', 'RELEASE',
  'SET', 'RESET', 'USE', 'DATABASE', 'SCHEMA', 'PREPARE', 'EXECUTE', 'EXEC',
  'DEALLOCATE', 'DECLARE', 'OPEN', 'FETCH', 'MOVE', 'CLOSE', 'CALL', 'DO',
  'PERFORM', 'GO', 'DELIMITER', 'XA', 'LOCK', 'UNLOCK', 'CHECKPOINT', 'DISCARD',
  'LISTEN', 'NOTIFY', 'UNLISTEN', 'WAITFOR', 'PRINT', 'RAISE', 'RAISERROR', 'THROW',
  // Introspection & Maintenance
  'EXPLAIN', 'DESCRIBE', 'DESC', 'SHOW', 'PRAGMA', 'ANALYZE', 'ANALYSE', 'VACUUM',
  'OPTIMIZE', 'CHECK', 'CHECKSUM', 'REPAIR', 'FLUSH', 'ATTACH', 'DETACH', 'INSTALL',
  'UNINSTALL', 'FORCE', 'KILL', 'SHUTDOWN', 'HELP', 'BINLOG', 'CACHE', 'HANDLER',
  'SYSTEM', 'WATCH', 'EXISTS', 'BACKUP', 'RESTORE', 'DBCC', 'RECONFIGURE',
  // Security / DCL / Admin
  'GRANT', 'REVOKE', 'DENY', 'REASSIGN', 'SECURITY', 'CHANGE', 'STOP', 'SLAVE',
  'REPLICA', 'MASTER', 'SOURCE',
  // Procedural block statements
  'IF', 'ELSE', 'ELSIF', 'ELSEIF', 'ENDIF', 'WHILE', 'LOOP', 'FOR', 'FOREACH',
  'RETURN', 'EXCEPTION', 'WHEN', 'BREAK', 'CONTINUE', 'EXIT', 'GOTO', 'TRY',
  'CATCH', 'SIGNAL', 'RESIGNAL', 'LEAVE', 'ITERATE', 'REPEAT', 'UNTIL', 'CASE',
  'DEFAULT', 'NULL',
])

const STARTER_TYPO_TARGETS = [
  'SELECT', 'UPDATE', 'DELETE', 'INSERT', 'CREATE', 'ALTER', 'DROP', 'EXPLAIN',
  'TRUNCATE', 'WITH', 'VALUES', 'TABLE', 'PRAGMA', 'SHOW', 'DESCRIBE', 'BEGIN',
  'START', 'COMMIT', 'ROLLBACK', 'MERGE', 'REPLACE', 'UPSERT', 'ANALYZE',
  'VACUUM', 'GRANT', 'REVOKE', 'ATTACH', 'DETACH', 'OPTIMIZE', 'REFRESH',
  'PREPARE', 'EXECUTE', 'DEALLOCATE', 'DECLARE', 'FETCH', 'COMMENT', 'FLUSH',
  'CHECK', 'UNLOCK', 'PIVOT', 'SUMMARIZE', 'CALL', 'EXEC', 'COPY', 'LOCK',
  'RENAME', 'RESET', 'REINDEX', 'FROM',
]

const KNOWN_SQL_KEYWORDS = new Set([
  ...VALID_STATEMENT_STARTERS,
  'WHERE', 'LIMIT', 'OFFSET', 'ORDER', 'GROUP', 'HAVING', 'INTO', 'JOIN',
  'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'LATERAL',
  'STRAIGHT_JOIN', 'RETURNING', 'DISTINCT', 'UNION', 'INTERSECT', 'EXCEPT',
  'TRANSACTION', 'WORK', 'DEFERRED', 'IMMEDIATE', 'EXCLUSIVE', 'ISOLATION',
  'LEVEL', 'READ', 'WRITE', 'ASC', 'RECURSIVE', 'VIEW', 'INDEX', 'TRIGGER',
  'FUNCTION', 'PROCEDURE', 'SEQUENCE', 'TYPE', 'DOMAIN', 'EXTENSION', 'POLICY',
  'RULE', 'ROLE', 'USER', 'MATERIALIZED', 'QUALIFY', 'WINDOW', 'PARTITION',
  'OVER', 'NEXT', 'FIRST', 'LAST', 'ROWS', 'ROW', 'ONLY', 'TOP', 'PERCENT',
  'TIES', 'THEN', 'AND', 'OR', 'NOT', 'IN', 'IS', 'BETWEEN', 'LIKE', 'ILIKE',
  'SIMILAR', 'ANY', 'ALL', 'SOME', 'AS', 'ON', 'USING', 'BY', 'OF', 'TO',
  'CONFLICT', 'NOTHING', 'DUPLICATE', 'KEY', 'PRIMARY', 'FOREIGN', 'REFERENCES',
  'UNIQUE', 'CONSTRAINT', 'CASCADE', 'RESTRICT', 'TEMP', 'TEMPORARY', 'UNLOGGED',
  'GLOBAL', 'LOCAL', 'OPTION', 'RECOMPILE', 'IGNORE', 'PREWHERE', 'SAMPLE',
  'ARRAY', 'FINAL', 'TOTALS', 'FILL', 'STEP', 'INTERPOLATE', 'FORMAT', 'SETTINGS',
  'OUTFILE', 'INFILE', 'DUMPFILE', 'DATA', 'CONNECT', 'PRIOR', 'ROWNUM',
  'SIBLINGS', 'EXCLUDE', 'STRUCT', 'UNNEST', 'TABLESAMPLE', 'BERNOULLI',
  'GROUPING', 'SETS', 'CUBE', 'ROLLUP', 'FILTER', 'WITHIN', 'RESPECT', 'NULLS',
  'GENERATED', 'ALWAYS', 'IDENTITY', 'STORED', 'VIRTUAL', 'COLLATE', 'TRUE',
  'FALSE', 'ESCAPE', 'GLOB', 'REGEXP', 'RLIKE', 'MATCH', 'DIV', 'MOD', 'XOR',
  'CAST', 'INTERVAL', 'AT', 'TIME', 'ZONE', 'DAY', 'DAYS', 'HOUR', 'HOURS',
  'MINUTE', 'MINUTES', 'SECOND', 'SECONDS', 'MONTH', 'MONTHS', 'YEAR', 'YEARS',
  'WEEK', 'WEEKS', 'QUARTER', 'MICROSECOND', 'MILLISECOND', 'VERBOSE', 'BUFFERS',
  'COSTS', 'TIMING', 'SUMMARY', 'QUERY', 'PLAN', 'EXTENDED', 'PARTITIONS',
  'INDEXED', 'APPLY', 'OFFSET', 'SYSTEM_TIME', 'MATCHED', 'EXCLUDED', 'STDIN',
  'STDOUT', 'HEADER', 'DELIMITER', 'SEPARATOR', 'CURRENT_TIMESTAMP', 'CURRENT_DATE',
  'CURRENT_TIME', 'CURRENT_USER', 'SESSION_USER', 'LOCALTIME', 'LOCALTIMESTAMP',
  'NOORDER', 'NOCACHE', 'CACHE', 'INCREMENT', 'MINVALUE', 'MAXVALUE', 'CYCLE',
  'NOCYCLE', 'OWNED', 'IDENTIFIED', 'DISTRIBUTE', 'SORT', 'LOW_PRIORITY',
  'HIGH_PRIORITY', 'DELAYED', 'QUICK', 'OVERWRITE', 'DIRECTORY',
])

const QUERY_DML_STARTERS = new Set([
  'SELECT', 'WITH', 'FROM', 'INSERT', 'UPDATE', 'DELETE', 'EXPLAIN', 'REPLACE', 'UPSERT',
])

const EXPLAIN_OPTION_WORDS = new Set([
  'ANALYZE', 'ANALYSE', 'VERBOSE', 'QUERY', 'PLAN', 'EXTENDED', 'PARTITIONS',
  'ESTIMATE', 'AST', 'SYNTAX', 'PIPELINE', 'INDEXES', 'COSTS', 'BUFFERS',
  'TIMING', 'SUMMARY', 'SETTINGS', 'WAL', 'GENERIC_PLAN', 'JSON', 'TEXT',
  'XML', 'YAML', 'TREE', 'TRADITIONAL', 'FORMAT', 'FOR', 'CONNECTION',
])

const DUPLICATE_CHECK_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'HAVING', 'LIMIT', 'OFFSET', 'SET',
])

const TRAILING_COMMA_FOLLOWERS = new Set([
  'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
])

const DANGLING_CLAUSE_KEYWORDS = new Set([
  'FROM', 'WHERE', 'HAVING', 'LIMIT', 'OFFSET', 'AND', 'OR',
])

const EMPTY_FROM_FOLLOWERS = new Set([
  'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT',
  'EXCEPT', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL',
  'ON', 'USING',
])

const EMPTY_WHERE_FOLLOWERS = new Set([
  'ORDER', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT',
  'AND', 'OR',
])

const EMPTY_LIMIT_FOLLOWERS = new Set([
  'WHERE', 'ORDER', 'GROUP', 'HAVING', 'UNION', 'INTERSECT', 'EXCEPT',
  'LIMIT', 'OFFSET',
])

const EMPTY_BOOL_FOLLOWERS = new Set([
  'ORDER', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT',
  'AND', 'OR',
])

const PREDICATE_KEYWORDS = new Set([
  'IS', 'IN', 'NOT', 'LIKE', 'ILIKE', 'BETWEEN', 'SIMILAR', 'GLOB', 'REGEXP',
  'RLIKE', 'MATCH',
])

const CLAUSE_INTRODUCER_KEYWORDS = new Set([
  'SELECT', 'DISTINCT', 'FROM', 'WHERE', 'HAVING', 'ON', 'AND', 'OR', 'NOT',
  'SET', 'VALUES', 'INTO', 'BY', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'IN',
  'IS', 'LIKE', 'ILIKE', 'BETWEEN', 'JOIN', 'LIMIT', 'OFFSET', 'WITH', 'UNION',
  'INTERSECT', 'EXCEPT', 'UPDATE', 'DELETE', 'INSERT', 'CREATE', 'ALTER', 'DROP',
  'TABLE', 'VIEW', 'INDEX', 'PREWHERE', 'QUALIFY', 'RETURNING',
])

const JOIN_MODIFIERS = new Set([
  'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'GLOBAL',
  'ANY', 'ALL', 'ASOF', 'SEMI', 'ANTI', 'STRAIGHT',
])

const CLAUSE_TERMINATOR_KEYWORDS = new Set([
  'WHERE', 'ORDER', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'JOIN', 'INNER',
  'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'OUTER', 'UNION', 'INTERSECT',
  'EXCEPT', 'ON', 'USING', 'SET', 'FOR', 'FETCH', 'WINDOW', 'QUALIFY',
  'PREWHERE', 'RETURNING', 'SETTINGS', 'FORMAT', 'INTO', 'AS', 'WITH',
  'PIVOT', 'UNPIVOT', 'CONNECT', 'START', 'TABLESAMPLE', 'SAMPLE', 'FINAL',
  'USE', 'FORCE', 'IGNORE', 'INDEXED', 'PARTITION', 'OPTION', 'LOCK', 'VALUES',
  'SELECT', 'FROM',
])

const VALID_BEFORE_BY = new Set([
  'ORDER', 'GROUP', 'PARTITION', 'DISTRIBUTE', 'CLUSTER', 'SORT', 'STORED',
  'GENERATED', 'IDENTIFIED', 'OWNED', 'MODIFIED', 'CREATED', 'INCREMENT',
  'MULTIPLY', 'DIVIDE', 'REPLACED', 'STARTED', 'LOCKED', 'SECURED', 'ENCRYPTED',
  'COMPRESSED', 'SUPPORTED', 'PARTITIONED', 'CLUSTERED', 'SORTED', 'ORGANIZED',
  'HASHED', 'SHARDED', 'INDEXED', 'SIBLINGS', 'NOT', 'AND', 'OR', 'AS', 'LIMIT',
])

const DELETE_MODIFIERS = new Set(['LOW_PRIORITY', 'QUICK', 'IGNORE', 'ONLY'])
const INSERT_MODIFIERS = new Set([
  'OR', 'IGNORE', 'REPLACE', 'ABORT', 'ROLLBACK', 'FAIL',
  'LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY', 'OVERWRITE',
])
const UPDATE_MODIFIERS = new Set([
  'ONLY', 'LOW_PRIORITY', 'IGNORE', 'OR', 'ABORT', 'FAIL', 'REPLACE', 'ROLLBACK',
])

const FUSED_CLAUSE_SUFFIXES = [
  'WHERE', 'HAVING', 'ORDER', 'GROUP', 'LIMIT', 'OFFSET', 'JOIN', 'FROM',
]

const FUSED_CLAUSE_CANONICAL_KEYWORDS = [
  'SELECT',
  ...FUSED_CLAUSE_SUFFIXES,
]

const FUSED_CLAUSE_CONNECTORS = new Set([
  'AND', 'OR', 'BY', 'ON', 'DESC', 'ASC', 'ALL', 'NOT', 'SET',
])

const MULTI_CHAR_OPS = new Set([
  '::', '||', '&&', '->', '->>', '#>', '#>>', '<>', '!=', '<=', '>=', '<=>',
  ':=', '+=', '-=', '*=', '/=', '%=', '<<', '>>', '<@', '@>', '?&', '?|', '#-',
])

function isAsciiLetter(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isAsciiDigit(code) {
  return code >= 48 && code <= 57
}

function isIdentStartCode(code) {
  return isAsciiLetter(code) || code === 95
}

function isIdentContCode(code) {
  return isIdentStartCode(code) || isAsciiDigit(code)
}

function isUnicodeIdentChar(ch) {
  return /[\p{L}\p{N}_]/u.test(ch)
}

function computeUnterminatedSpan(sql, start) {
  const len = sql.length
  let lineEnd = len
  const nl = sql.indexOf('\n', start)
  if (nl !== -1 && nl < lineEnd) lineEnd = nl
  const cr = sql.indexOf('\r', start)
  if (cr !== -1 && cr < lineEnd) lineEnd = cr
  const capped = Math.min(lineEnd, start + MAX_UNTERMINATED_SPAN)
  return { from: start, to: Math.max(Math.min(len, start + 1), capped) }
}

function matchDollarQuoteTag(sql, index) {
  if (sql.charCodeAt(index) !== 36) return null
  if (index > 0 && isIdentContCode(sql.charCodeAt(index - 1))) return null
  const len = sql.length
  if (index + 1 >= len) return null
  if (sql.charCodeAt(index + 1) === 36) return '$$'
  if (!isIdentStartCode(sql.charCodeAt(index + 1))) return null
  let cursor = index + 2
  while (cursor < len && isIdentContCode(sql.charCodeAt(cursor))) {
    cursor++
  }
  if (cursor < len && sql.charCodeAt(cursor) === 36) {
    return sql.slice(index, cursor + 1)
  }
  return null
}

function tryScanOracleQuote(sql, index, dialect) {
  if (dialect !== 'oracle' && dialect !== '') return null
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
    if (isIdentContCode(prevCode) || prevCode === 36 || prevCode === 35) return null
  }
  const openDelim = sql[qIdx + 2]
  if (/\s/.test(openDelim)) return null
  if (dialect === '' && !(openDelim in ORACLE_Q_DELIMS)) return null
  const closeDelim = ORACLE_Q_DELIMS[openDelim] ?? openDelim
  const closeIdx = sql.indexOf(`${closeDelim}'`, qIdx + 3)
  if (closeIdx >= 0) {
    return { end: closeIdx + 2, closed: true }
  }
  return { end: len, closed: false }
}

function scanQuotedSegment(sql, start, quoteChar, allowBackslash) {
  let i = start + 1
  const len = sql.length
  while (i < len) {
    const ch = sql[i]
    if (allowBackslash && ch === '\\') {
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

function scanTripleQuotedSegment(sql, start, quoteChar, allowBackslash) {
  const triple = quoteChar + quoteChar + quoteChar
  let i = start + 3
  const len = sql.length
  while (i < len) {
    if (allowBackslash && sql[i] === '\\') {
      i += 2
      continue
    }
    if (sql.startsWith(triple, i)) {
      return { end: i + 3, closed: true }
    }
    i++
  }
  return { end: len, closed: false }
}

function scanBracketIdent(sql, start) {
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

function scanBlockComment(sql, start, allowNested) {
  let i = start + 2
  let depth = 1
  const len = sql.length
  while (i < len && depth > 0) {
    if (allowNested && sql[i] === '/' && i + 1 < len && sql[i + 1] === '*') {
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

/**
 * Lexes SQL into tokens while recording lexer errors and paren balance.
 */
function lexSql(sql, dialect) {
  const tokens = []
  const diagnostics = []
  const parenStack = []
  const len = sql.length

  const backslashStrings = BACKSLASH_STRING_DIALECTS.has(dialect)
  const backslashDoubleQuotes = BACKSLASH_DOUBLE_QUOTE_DIALECTS.has(dialect)
  const hashComments = HASH_COMMENT_DIALECTS.has(dialect)
  const nestedComments = NESTED_COMMENT_DIALECTS.has(dialect)
  const dollarQuotes = DOLLAR_QUOTE_DIALECTS.has(dialect)
  const pgEscapeStrings = PG_ESCAPE_STRING_DIALECTS.has(dialect)
  const isMssql = dialect === 'mssql'
  const isBigQuery = dialect === 'bigquery'

  let i = 0
  while (i < len) {
    const ch = sql[i]
    const code = sql.charCodeAt(i)

    // Whitespace
    if (code <= 32) {
      i++
      continue
    }

    // Line comment: --
    if (ch === '-' && i + 1 < len && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2)
      i = nl === -1 ? len : nl + 1
      continue
    }

    // Hash line comment (MySQL / MariaDB / ClickHouse / BigQuery)
    if (hashComments && ch === '#') {
      const nl = sql.indexOf('\n', i + 1)
      i = nl === -1 ? len : nl + 1
      continue
    }

    // Block comment: /* ... */
    if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
      const res = scanBlockComment(sql, i, nestedComments)
      if (!res.closed) {
        diagnostics.push({
          from: i,
          to: Math.min(len, i + 2),
          severity: 'error',
          code: 'unterminated-comment',
          message: 'Unterminated block comment "/*"',
        })
      }
      i = res.end
      continue
    }

    // Oracle q'[...]' / nq'[...]'
    const oracleQ = tryScanOracleQuote(sql, i, dialect)
    if (oracleQ) {
      if (!oracleQ.closed) {
        const span = computeUnterminatedSpan(sql, i)
        diagnostics.push({
          from: span.from,
          to: span.to,
          severity: 'error',
          code: 'unterminated-string',
          message: 'Unterminated Oracle quoted string literal',
        })
      } else {
        tokens.push({
          type: 'string',
          from: i,
          to: oracleQ.end,
          raw: sql.slice(i, oracleQ.end),
          upper: '',
          parenDepth: parenStack.length,
        })
      }
      i = oracleQ.end
      continue
    }

    // Prefixed strings: E'...', N'...', X'...', B'...', R'...', U&'...'
    if (isAsciiLetter(code)) {
      const upperCh = ch.toUpperCase()
      const prevNotIdent = i === 0 || !isIdentContCode(sql.charCodeAt(i - 1))
      if (prevNotIdent) {
        let quotePos = -1
        let allowBs = backslashStrings
        if (upperCh === 'U' && i + 2 < len && sql[i + 1] === '&' && sql[i + 2] === "'") {
          quotePos = i + 2
          allowBs = false
        } else if (
          i + 1 < len &&
          sql[i + 1] === "'" &&
          (upperCh === 'E' || upperCh === 'N' || upperCh === 'X' || upperCh === 'B' || upperCh === 'R')
        ) {
          quotePos = i + 1
          if (upperCh === 'E' && pgEscapeStrings) {
            allowBs = true
          } else if (upperCh === 'R' || upperCh === 'X' || upperCh === 'B') {
            allowBs = false
          }
        }
        if (quotePos !== -1) {
          const isTriple = isBigQuery && sql.startsWith("'''", quotePos)
          const res = isTriple
            ? scanTripleQuotedSegment(sql, quotePos, "'", allowBs)
            : scanQuotedSegment(sql, quotePos, "'", allowBs)
          if (!res.closed) {
            const span = computeUnterminatedSpan(sql, i)
            diagnostics.push({
              from: span.from,
              to: span.to,
              severity: 'error',
              code: 'unterminated-string',
              message: 'Unterminated string literal',
            })
          } else {
            tokens.push({
              type: 'string',
              from: i,
              to: res.end,
              raw: sql.slice(i, res.end),
              upper: '',
              parenDepth: parenStack.length,
            })
          }
          i = res.end
          continue
        }
      }
    }

    // Single-quoted string (including BigQuery triple single-quote)
    if (ch === "'") {
      const isTriple = isBigQuery && sql.startsWith("'''", i)
      const res = isTriple
        ? scanTripleQuotedSegment(sql, i, "'", backslashStrings)
        : scanQuotedSegment(sql, i, "'", backslashStrings)
      if (!res.closed) {
        const span = computeUnterminatedSpan(sql, i)
        diagnostics.push({
          from: span.from,
          to: span.to,
          severity: 'error',
          code: 'unterminated-string',
          message: 'Unterminated string literal',
        })
      } else {
        tokens.push({
          type: 'string',
          from: i,
          to: res.end,
          raw: sql.slice(i, res.end),
          upper: '',
          parenDepth: parenStack.length,
        })
      }
      i = res.end
      continue
    }

    // Dollar-quoted strings $$...$$ / $tag$...$tag$
    if (dollarQuotes && ch === '$') {
      const tag = matchDollarQuoteTag(sql, i)
      if (tag) {
        const closeIdx = sql.indexOf(tag, i + tag.length)
        if (closeIdx === -1) {
          const span = computeUnterminatedSpan(sql, i)
          diagnostics.push({
            from: span.from,
            to: span.to,
            severity: 'error',
            code: 'unterminated-string',
            message: `Unterminated dollar-quoted string ${tag}`,
          })
          i = len
        } else {
          const end = closeIdx + tag.length
          tokens.push({
            type: 'string',
            from: i,
            to: end,
            raw: sql.slice(i, end),
            upper: '',
            parenDepth: parenStack.length,
          })
          i = end
        }
        continue
      }
    }

    // Double-quoted identifier (or BigQuery triple-quoted string)
    if (ch === '"') {
      if (isBigQuery && sql.startsWith('"""', i)) {
        const res = scanTripleQuotedSegment(sql, i, '"', true)
        if (!res.closed) {
          const span = computeUnterminatedSpan(sql, i)
          diagnostics.push({
            from: span.from,
            to: span.to,
            severity: 'error',
            code: 'unterminated-string',
            message: 'Unterminated string literal',
          })
        } else {
          tokens.push({
            type: 'string',
            from: i,
            to: res.end,
            raw: sql.slice(i, res.end),
            upper: '',
            parenDepth: parenStack.length,
          })
        }
        i = res.end
        continue
      }
      const res = scanQuotedSegment(sql, i, '"', backslashDoubleQuotes)
      if (!res.closed) {
        const span = computeUnterminatedSpan(sql, i)
        diagnostics.push({
          from: span.from,
          to: span.to,
          severity: 'error',
          code: 'unterminated-identifier',
          message: 'Unterminated double-quoted identifier',
        })
      } else {
        tokens.push({
          type: 'quoted_ident',
          from: i,
          to: res.end,
          raw: sql.slice(i, res.end),
          upper: '',
          parenDepth: parenStack.length,
        })
      }
      i = res.end
      continue
    }

    // Backtick-quoted identifier
    if (ch === '`') {
      const res = scanQuotedSegment(sql, i, '`', false)
      if (!res.closed) {
        const span = computeUnterminatedSpan(sql, i)
        diagnostics.push({
          from: span.from,
          to: span.to,
          severity: 'error',
          code: 'unterminated-identifier',
          message: 'Unterminated backtick-quoted identifier',
        })
      } else {
        tokens.push({
          type: 'quoted_ident',
          from: i,
          to: res.end,
          raw: sql.slice(i, res.end),
          upper: '',
          parenDepth: parenStack.length,
        })
      }
      i = res.end
      continue
    }

    // MSSQL bracket identifier [...] ONLY when dialect === 'mssql'
    if (ch === '[') {
      if (isMssql) {
        const res = scanBracketIdent(sql, i)
        if (!res.closed) {
          const span = computeUnterminatedSpan(sql, i)
          diagnostics.push({
            from: span.from,
            to: span.to,
            severity: 'error',
            code: 'unterminated-identifier',
            message: 'Unterminated bracket-quoted identifier "["',
          })
        } else {
          tokens.push({
            type: 'quoted_ident',
            from: i,
            to: res.end,
            raw: sql.slice(i, res.end),
            upper: '',
            parenDepth: parenStack.length,
          })
        }
        i = res.end
      } else {
        tokens.push({
          type: 'lbracket',
          from: i,
          to: i + 1,
          raw: '[',
          upper: '',
          parenDepth: parenStack.length,
        })
        i++
      }
      continue
    }

    if (ch === ']') {
      tokens.push({
        type: 'rbracket',
        from: i,
        to: i + 1,
        raw: ']',
        upper: '',
        parenDepth: parenStack.length,
      })
      i++
      continue
    }

    // Parentheses
    if (ch === '(') {
      const tok = {
        type: 'lparen',
        from: i,
        to: i + 1,
        raw: '(',
        upper: '',
        parenDepth: parenStack.length,
      }
      tokens.push(tok)
      parenStack.push(tok)
      i++
      continue
    }

    if (ch === ')') {
      if (parenStack.length === 0) {
        diagnostics.push({
          from: i,
          to: i + 1,
          severity: 'error',
          code: 'unmatched-paren',
          message: 'Unmatched closing parenthesis ")"',
        })
        tokens.push({
          type: 'rparen',
          from: i,
          to: i + 1,
          raw: ')',
          upper: '',
          parenDepth: 0,
        })
      } else {
        parenStack.pop()
        tokens.push({
          type: 'rparen',
          from: i,
          to: i + 1,
          raw: ')',
          upper: '',
          parenDepth: parenStack.length,
        })
      }
      i++
      continue
    }

    // Punctuation
    if (ch === ';') {
      tokens.push({
        type: 'semicolon',
        from: i,
        to: i + 1,
        raw: ';',
        upper: '',
        parenDepth: parenStack.length,
      })
      i++
      continue
    }

    if (ch === ',') {
      tokens.push({
        type: 'comma',
        from: i,
        to: i + 1,
        raw: ',',
        upper: '',
        parenDepth: parenStack.length,
      })
      i++
      continue
    }

    if (ch === '.') {
      tokens.push({
        type: 'dot',
        from: i,
        to: i + 1,
        raw: '.',
        upper: '',
        parenDepth: parenStack.length,
      })
      i++
      continue
    }

    // Parameters: $1, :name, @var, @@sysvar, ?
    if (ch === '?' && !(i + 1 < len && (sql[i + 1] === '&' || sql[i + 1] === '|'))) {
      tokens.push({
        type: 'param',
        from: i,
        to: i + 1,
        raw: '?',
        upper: '',
        parenDepth: parenStack.length,
      })
      i++
      continue
    }

    if (ch === '$' && i + 1 < len && isAsciiDigit(sql.charCodeAt(i + 1))) {
      let end = i + 2
      while (end < len && isAsciiDigit(sql.charCodeAt(end))) end++
      tokens.push({
        type: 'param',
        from: i,
        to: end,
        raw: sql.slice(i, end),
        upper: '',
        parenDepth: parenStack.length,
      })
      i = end
      continue
    }

    if (
      ch === ':' &&
      i + 1 < len &&
      sql[i + 1] !== ':' &&
      sql[i + 1] !== '=' &&
      isIdentStartCode(sql.charCodeAt(i + 1))
    ) {
      let end = i + 2
      while (end < len && isIdentContCode(sql.charCodeAt(end))) end++
      tokens.push({
        type: 'param',
        from: i,
        to: end,
        raw: sql.slice(i, end),
        upper: '',
        parenDepth: parenStack.length,
      })
      i = end
      continue
    }

    if (ch === '@' && i + 1 < len) {
      const nextCh = sql[i + 1]
      if (nextCh === '@' && i + 2 < len && isIdentStartCode(sql.charCodeAt(i + 2))) {
        let end = i + 3
        while (end < len && isIdentContCode(sql.charCodeAt(end))) end++
        tokens.push({
          type: 'param',
          from: i,
          to: end,
          raw: sql.slice(i, end),
          upper: '',
          parenDepth: parenStack.length,
        })
        i = end
        continue
      }
      if (isIdentStartCode(sql.charCodeAt(i + 1))) {
        let end = i + 2
        while (end < len && isIdentContCode(sql.charCodeAt(end))) end++
        tokens.push({
          type: 'param',
          from: i,
          to: end,
          raw: sql.slice(i, end),
          upper: '',
          parenDepth: parenStack.length,
        })
        i = end
        continue
      }
    }

    // MSSQL temp table identifiers (#temp, ##global_temp)
    if (isMssql && ch === '#' && i + 1 < len) {
      const startIdent = sql[i + 1] === '#' ? i + 2 : i + 1
      if (startIdent < len && isIdentStartCode(sql.charCodeAt(startIdent))) {
        let end = startIdent + 1
        while (end < len && isIdentContCode(sql.charCodeAt(end))) end++
        tokens.push({
          type: 'quoted_ident',
          from: i,
          to: end,
          raw: sql.slice(i, end),
          upper: '',
          parenDepth: parenStack.length,
        })
        i = end
        continue
      }
    }

    // Numbers
    if (isAsciiDigit(code)) {
      let end = i + 1
      if (ch === '0' && end < len && (sql[end] === 'x' || sql[end] === 'X')) {
        end++
        while (end < len && /[0-9a-fA-F]/.test(sql[end])) end++
      } else {
        while (end < len && isAsciiDigit(sql.charCodeAt(end))) end++
        if (end + 1 < len && sql[end] === '.' && isAsciiDigit(sql.charCodeAt(end + 1))) {
          end += 2
          while (end < len && isAsciiDigit(sql.charCodeAt(end))) end++
        }
        if (end < len && (sql[end] === 'e' || sql[end] === 'E')) {
          let exp = end + 1
          if (exp < len && (sql[exp] === '+' || sql[exp] === '-')) exp++
          if (exp < len && isAsciiDigit(sql.charCodeAt(exp))) {
            end = exp + 1
            while (end < len && isAsciiDigit(sql.charCodeAt(end))) end++
          }
        }
      }
      tokens.push({
        type: 'number',
        from: i,
        to: end,
        raw: sql.slice(i, end),
        upper: '',
        parenDepth: parenStack.length,
      })
      i = end
      continue
    }

    // Unquoted words (keywords / identifiers, including $ inside Oracle v$session)
    if (isIdentStartCode(code) || (code >= 128 && isUnicodeIdentChar(ch))) {
      let end = i + 1
      while (end < len) {
        const c = sql.charCodeAt(end)
        if (isIdentContCode(c) || c === 36) {
          end++
        } else if (c >= 128 && isUnicodeIdentChar(sql[end])) {
          end++
        } else {
          break
        }
      }
      const raw = sql.slice(i, end)
      tokens.push({
        type: 'word',
        from: i,
        to: end,
        raw,
        upper: raw.toUpperCase(),
        parenDepth: parenStack.length,
      })
      i = end
      continue
    }

    // Multi-char operators (3-char then 2-char)
    if (i + 2 < len && MULTI_CHAR_OPS.has(sql.slice(i, i + 3))) {
      const raw = sql.slice(i, i + 3)
      tokens.push({
        type: 'op',
        from: i,
        to: i + 3,
        raw,
        upper: '',
        parenDepth: parenStack.length,
      })
      i += 3
      continue
    }
    if (i + 1 < len && MULTI_CHAR_OPS.has(sql.slice(i, i + 2))) {
      const raw = sql.slice(i, i + 2)
      tokens.push({
        type: 'op',
        from: i,
        to: i + 2,
        raw,
        upper: '',
        parenDepth: parenStack.length,
      })
      i += 2
      continue
    }

    // Single-char operator / symbol
    tokens.push({
      type: 'op',
      from: i,
      to: i + 1,
      raw: ch,
      upper: '',
      parenDepth: parenStack.length,
    })
    i++
  }

  for (const openTok of parenStack) {
    diagnostics.push({
      from: openTok.from,
      to: openTok.to,
      severity: 'error',
      code: 'unmatched-paren',
      message: 'Unclosed opening parenthesis "("',
    })
  }

  return { tokens, diagnostics }
}

/**
 * Optimal String Alignment (Damerau-Levenshtein) distance with early-exit threshold.
 */
function damerauLevenshtein(a, b, maxDist = 2) {
  const m = a.length
  const n = b.length
  if (Math.abs(m - n) > maxDist) return maxDist + 1
  if (a === b) return 0

  const prev2 = new Array(n + 1).fill(0)
  const prev1 = new Array(n + 1)
  const curr = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev1[j] = j

  for (let i = 1; i <= m; i++) {
    curr[0] = i
    let rowMin = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let val = Math.min(prev1[j] + 1, curr[j - 1] + 1, prev1[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, prev2[j - 2] + 1)
      }
      curr[j] = val
      if (val < rowMin) rowMin = val
    }
    if (rowMin > maxDist) return maxDist + 1
    for (let j = 0; j <= n; j++) {
      prev2[j] = prev1[j]
      prev1[j] = curr[j]
    }
  }
  return prev1[n]
}

function isTypoOf(upperWord, target) {
  if (!upperWord || upperWord === target) return false
  if (upperWord.length < 3 || target.length < 3) return false
  const allowed = target.length <= 4 ? 1 : 2
  const dist = damerauLevenshtein(upperWord, target, allowed)
  if (dist === 1) return true
  if (dist === 2 && target.length >= 5 && upperWord.length >= 3 && upperWord[0] === target[0]) {
    return true
  }
  return false
}

function findBestTypo(upperWord, candidates) {
  if (!upperWord || upperWord.length < 3) return null
  let bestTarget = null
  let bestDist = 3
  for (const target of candidates) {
    if (upperWord === target || target.length < 3) continue
    const allowed = target.length <= 4 ? 1 : 2
    const dist = damerauLevenshtein(upperWord, target, allowed)
    if (dist > allowed) continue
    if (dist === 2 && (target.length < 5 || upperWord[0] !== target[0])) continue
    if (dist < bestDist) {
      bestDist = dist
      bestTarget = target
      if (dist === 1) break
    }
  }
  return bestTarget
}

function isFusedClausePrefix(prefix) {
  if (FUSED_CLAUSE_CONNECTORS.has(prefix)) return true
  const stem = prefix.replace(/\d+$/, '')
  if (stem.length < 3 || !/^[A-Z]+$/.test(stem)) return false
  for (const kw of FUSED_CLAUSE_CANONICAL_KEYWORDS) {
    if (stem[0] !== kw[0]) continue
    if (stem === kw || kw.startsWith(stem)) return true
    if (damerauLevenshtein(stem, kw, 1) <= 1) return true
    const skeleton = kw[0] + kw.slice(1).replace(/[AEIOU]/g, '')
    if (skeleton.length >= 3 && stem === skeleton) return true
  }
  return false
}

function matchFusedClause(upperWord) {
  if (!upperWord || upperWord.length < 6 || upperWord.includes('_')) return null
  if (upperWord.endsWith('BY')) {
    const byPrefix = upperWord.slice(0, -2)
    if (byPrefix === 'ORDER' || byPrefix === 'GROUP') {
      return { clause: byPrefix, suggestion: `${byPrefix} BY` }
    }
  }
  for (const suffix of FUSED_CLAUSE_SUFFIXES) {
    if (!upperWord.endsWith(suffix)) continue
    const prefix = upperWord.slice(0, upperWord.length - suffix.length)
    if (prefix.length < 2) continue
    if (suffix === 'JOIN' && JOIN_MODIFIERS.has(prefix)) {
      return { clause: 'JOIN', suggestion: `${prefix} JOIN` }
    }
    if (!isFusedClausePrefix(prefix)) continue
    return { clause: suffix, suggestion: suffix }
  }
  return null
}

const SEMICOLON_TRAILING_CLAUSE_TYPO_MAP = new Map([
  ['WHRE', 'WHERE'],
  ['WHER', 'WHERE'],
  ['WEHRE', 'WHERE'],
  ['WHREE', 'WHERE'],
  ['WHEER', 'WHERE'],
  ['WHEREE', 'WHERE'],
  ['HAVNG', 'HAVING'],
  ['HAVIG', 'HAVING'],
  ['HVING', 'HAVING'],
  ['HAIVNG', 'HAVING'],
  ['HAVNIG', 'HAVING'],
  ['HAVIGN', 'HAVING'],
  ['LIMT', 'LIMIT'],
  ['LMIT', 'LIMIT'],
  ['LIMTI', 'LIMIT'],
  ['LIIMT', 'LIMIT'],
  ['OFSET', 'OFFSET'],
  ['OFFST', 'OFFSET'],
  ['OFFEST', 'OFFSET'],
  ['OFFSTE', 'OFFSET'],
  ['ODRER', 'ORDER'],
  ['OREDR', 'ORDER'],
  ['ORDRE', 'ORDER'],
  ['GRUOP', 'GROUP'],
  ['GROPU', 'GROUP'],
])

function matchSemicolonTrailingClauseTypo(upperWord) {
  return SEMICOLON_TRAILING_CLAUSE_TYPO_MAP.get(upperWord) ?? null
}

function isActiveTypingPrefix(tok, cursorOffset) {
  if (cursorOffset === null || tok.type !== 'word') return false
  if (cursorOffset < tok.from || cursorOffset > tok.to) return false
  const upper = tok.upper
  if (!upper) return false
  for (const kw of KNOWN_SQL_KEYWORDS) {
    if (kw.startsWith(upper)) return true
  }
  return false
}

const TRANSACTION_BEGIN_FOLLOWERS = new Set([
  'TRANSACTION', 'TRAN', 'WORK', 'DEFERRED', 'IMMEDIATE', 'EXCLUSIVE',
  'ISOLATION', 'READ', 'DISTRIBUTED',
])

const NON_BLOCK_END_FOLLOWERS = new Set([
  'IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR', 'CASE',
])

function isStandaloneLineToken(sql, tok) {
  let left = tok.from - 1
  while (left >= 0 && (sql[left] === ' ' || sql[left] === '\t')) left--
  if (left >= 0 && sql[left] !== '\n' && sql[left] !== '\r') return false

  let right = tok.to
  while (right < sql.length && (sql[right] === ' ' || sql[right] === '\t')) right++
  if (right < sql.length && sql[right] !== '\n' && sql[right] !== '\r') return false
  return true
}

function splitStatements(tokens, sql, dialect) {
  const statements = []
  let current = []
  let procDepth = 0

  const flushStatement = (hasSemicolon) => {
    if (current.length === 0) return
    const startedInProc = procDepth > 0
    let localCaseDepth = 0
    let containsProcBegin = false

    for (let i = 0; i < current.length; i++) {
      if (!isKeywordCandidate(current, i)) continue
      const u = current[i].upper
      const prev = i > 0 ? current[i - 1] : null
      const next = i + 1 < current.length ? current[i + 1] : null

      if (u === 'BEGIN') {
        const isTransactionBegin =
          !next || (next.type === 'word' && TRANSACTION_BEGIN_FOLLOWERS.has(next.upper))
        if (!isTransactionBegin) {
          procDepth++
          containsProcBegin = true
        }
      } else if (u === 'CASE') {
        if (!(prev?.type === 'word' && prev.upper === 'END')) {
          localCaseDepth++
        }
      } else if (u === 'END') {
        if (next?.type === 'word' && NON_BLOCK_END_FOLLOWERS.has(next.upper)) {
          if (next.upper === 'CASE' && localCaseDepth > 0) localCaseDepth--
        } else if (localCaseDepth > 0) {
          localCaseDepth--
        } else if (procDepth > 0) {
          procDepth--
        }
      }
    }

    statements.push({
      tokens: current,
      hasSemicolon,
      inProceduralBlock: startedInProc || containsProcBegin,
    })
    current = []
  }

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.type === 'semicolon' && tok.parenDepth === 0) {
      flushStatement(true)
      continue
    }
    // Oracle SQL*Plus `/` batch terminator on its own line
    if (
      dialect === 'oracle' &&
      tok.type === 'op' &&
      tok.raw === '/' &&
      tok.parenDepth === 0 &&
      isStandaloneLineToken(sql, tok)
    ) {
      flushStatement(true)
      procDepth = 0
      continue
    }
    // MSSQL `GO` batch separator on its own line
    if (
      dialect === 'mssql' &&
      tok.type === 'word' &&
      tok.upper === 'GO' &&
      tok.parenDepth === 0 &&
      isStandaloneLineToken(sql, tok)
    ) {
      flushStatement(true)
      procDepth = 0
      continue
    }
    current.push(tok)
  }
  flushStatement(false)
  return statements
}

/**
 * Collapses depth > 0 parenthesized regions into single synthetic `group` tokens
 * so top-level adjacency checks never confuse `(expr)` for missing expressions.
 */
function buildTopLevelTokens(stmtTokens) {
  const top = []
  let i = 0
  while (i < stmtTokens.length) {
    const tok = stmtTokens[i]
    if (tok.parenDepth > 0) {
      i++
      continue
    }
    if (tok.type === 'lparen') {
      let j = i + 1
      let closeTok = null
      while (j < stmtTokens.length) {
        const inner = stmtTokens[j]
        if (inner.type === 'rparen' && inner.parenDepth === 0) {
          closeTok = inner
          j++
          break
        }
        j++
      }
      top.push({
        type: 'group',
        from: tok.from,
        to: closeTok ? closeTok.to : stmtTokens[stmtTokens.length - 1].to,
        raw: '(...)',
        upper: '',
        parenDepth: 0,
      })
      i = j
      continue
    }
    top.push(tok)
    i++
  }
  return top
}

function isKeywordCandidate(list, idx) {
  if (idx < 0 || idx >= list.length) return false
  const tok = list[idx]
  if (tok.type !== 'word') return false
  const prev = idx > 0 ? list[idx - 1] : null
  if (prev && prev.type === 'dot') return false
  if (prev && prev.type === 'word' && prev.upper === 'AS') return false
  return true
}

function isClauseBoundaryPredecessor(prev) {
  if (!prev) return false
  if (
    prev.type === 'quoted_ident' ||
    prev.type === 'string' ||
    prev.type === 'number' ||
    prev.type === 'param' ||
    prev.type === 'group' ||
    prev.type === 'rbracket'
  ) {
    return true
  }
  if (prev.type === 'word') {
    return !CLAUSE_INTRODUCER_KEYWORDS.has(prev.upper)
  }
  return false
}

function isTableStartToken(tok) {
  if (!tok) return false
  if (tok.type === 'quoted_ident' || tok.type === 'group') return true
  if (tok.type === 'word') return !CLAUSE_TERMINATOR_KEYWORDS.has(tok.upper)
  return false
}

function isInsertTargetTableToken(tok) {
  if (!tok) return false
  if (tok.type === 'quoted_ident') return true
  if (tok.type === 'word') {
    return (
      tok.upper !== 'VALUES' &&
      tok.upper !== 'SELECT' &&
      tok.upper !== 'DEFAULT' &&
      tok.upper !== 'SET' &&
      tok.upper !== 'WITH' &&
      tok.upper !== 'TABLE' &&
      !CLAUSE_TERMINATOR_KEYWORDS.has(tok.upper)
    )
  }
  return false
}

function looksLikeAssignmentStart(branch, startIdx) {
  const first = branch[startIdx]
  if (!first) return false
  if (first.type === 'group') {
    return branch[startIdx + 1]?.raw === '='
  }
  if (first.type !== 'word' && first.type !== 'quoted_ident') return false
  const second = branch[startIdx + 1]
  if (!second) return false
  if (second.raw === '=') return true
  if (second.type === 'dot') {
    const third = branch[startIdx + 2]
    const fourth = branch[startIdx + 3]
    if ((third?.type === 'word' || third?.type === 'quoted_ident') && fourth?.raw === '=') {
      return true
    }
  }
  return false
}

function isLimitOffsetArgToken(tok) {
  if (!tok) return false
  if (tok.type === 'number' || tok.type === 'param') return true
  if (tok.type === 'word' && tok.upper === 'ALL') return true
  return false
}

function isConditionStartToken(tok) {
  if (!tok) return false
  if (
    tok.type === 'quoted_ident' ||
    tok.type === 'string' ||
    tok.type === 'number' ||
    tok.type === 'param' ||
    tok.type === 'group'
  ) {
    return true
  }
  if (tok.type === 'word') {
    if (tok.upper === 'NOT' || tok.upper === 'EXISTS' || tok.upper === 'CASE') return true
    return !CLAUSE_TERMINATOR_KEYWORDS.has(tok.upper)
  }
  return false
}

function skipExplainPrefix(topTokens) {
  let idx = 1
  while (idx < topTokens.length) {
    const t = topTokens[idx]
    if (t.type === 'group') {
      idx++
      continue
    }
    if (t.type === 'word' && EXPLAIN_OPTION_WORDS.has(t.upper)) {
      idx++
      continue
    }
    break
  }
  return idx
}

function skipWithCtes(topTokens, startIdx) {
  let idx = startIdx + 1
  if (topTokens[idx]?.type === 'word' && topTokens[idx].upper === 'RECURSIVE') {
    idx++
  }
  while (idx < topTokens.length) {
    // Expect CTE name
    if (topTokens[idx]?.type !== 'word' && topTokens[idx]?.type !== 'quoted_ident') break
    idx++
    // Optional column list (a, b)
    if (topTokens[idx]?.type === 'group') idx++
    // Expect AS
    if (!(topTokens[idx]?.type === 'word' && topTokens[idx].upper === 'AS')) break
    idx++
    // Optional [NOT] MATERIALIZED
    if (topTokens[idx]?.type === 'word' && topTokens[idx].upper === 'NOT') idx++
    if (topTokens[idx]?.type === 'word' && topTokens[idx].upper === 'MATERIALIZED') idx++
    // Expect CTE body (...)
    if (topTokens[idx]?.type !== 'group') break
    idx++
    if (topTokens[idx]?.type === 'comma') {
      idx++
      continue
    }
    break
  }
  return idx
}

function findCreateViewQueryStart(topTokens) {
  // CREATE [OR REPLACE] [TEMP|TEMPORARY|MATERIALIZED] VIEW name [(cols)] AS <query>
  let seenView = false
  for (let i = 1; i < topTokens.length; i++) {
    const t = topTokens[i]
    if (t.type === 'word' && t.upper === 'VIEW') {
      seenView = true
      continue
    }
    if (seenView && t.type === 'word' && t.upper === 'AS') {
      return i + 1
    }
    if (!seenView && t.type === 'word' && (t.upper === 'TABLE' || t.upper === 'FUNCTION' || t.upper === 'PROCEDURE' || t.upper === 'TRIGGER' || t.upper === 'INDEX' || t.upper === 'SEQUENCE')) {
      return -1
    }
  }
  return -1
}

function splitQueryBranches(topTokens, startIdx) {
  const branches = []
  let current = []
  let seenFrom = false
  let i = startIdx
  while (i < topTokens.length) {
    const tok = topTokens[i]
    if (isKeywordCandidate(topTokens, i) && tok.upper === 'FROM') {
      seenFrom = true
    }
    if (
      isKeywordCandidate(topTokens, i) &&
      (tok.upper === 'UNION' || tok.upper === 'INTERSECT' || tok.upper === 'EXCEPT')
    ) {
      const next = topTokens[i + 1]
      const isBigQuerySelectExcept =
        tok.upper === 'EXCEPT' && !seenFrom && next?.type === 'group'
      if (!isBigQuerySelectExcept) {
        if (current.length > 0) {
          branches.push(current)
          current = []
        }
        seenFrom = false
        i++
        if (
          topTokens[i]?.type === 'word' &&
          (topTokens[i].upper === 'ALL' || topTokens[i].upper === 'DISTINCT')
        ) {
          i++
        }
        continue
      }
    }
    current.push(tok)
    i++
  }
  if (current.length > 0) {
    branches.push(current)
  }
  return branches
}

function analyzeQueryBranch(branch, branchStarter, meta, diagnostics) {
  const { dialect, cursorOffset, hasSemicolon, isLastStatement, isLastBranch } = meta
  if (branch.length === 0) return

  let hasRealFrom = false
  let hasRealSet = false
  for (let i = 0; i < branch.length; i++) {
    if (!isKeywordCandidate(branch, i)) continue
    if (branch[i].upper === 'FROM') hasRealFrom = true
    if (branch[i].upper === 'SET') hasRealSet = true
  }

  const startsWithParenQuery = branch[0]?.type === 'group'
  let currentClause = branchStarter
  let seenFrom = branchStarter === 'FROM' || startsWithParenQuery
  let fromItemCount = startsWithParenQuery ? 1 : 0
  let seenUpdateTable = false
  const missingSelectFromPositions = new Set()
  const duplicatePairFirstIndices = new Set()

  for (let i = 0; i < branch.length; i++) {
    const tok = branch[i]
    const prev = i > 0 ? branch[i - 1] : null
    const next = i + 1 < branch.length ? branch[i + 1] : null
    const next2 = i + 2 < branch.length ? branch[i + 2] : null
    const tokIsKw = isKeywordCandidate(branch, i)
    const prevIsKw = isKeywordCandidate(branch, i - 1)
    const nextIsKw = isKeywordCandidate(branch, i + 1)

    // 1. Duplicate adjacent keywords
    if (tokIsKw && prevIsKw && DUPLICATE_CHECK_KEYWORDS.has(tok.upper) && prev.upper === tok.upper) {
      duplicatePairFirstIndices.add(i - 1)
      diagnostics.push({
        from: tok.from,
        to: tok.to,
        severity: 'error',
        code: 'duplicate-keyword',
        message: `Duplicate keyword "${tok.upper}"`,
      })
      continue
    }

    // 2. Missing SELECT expression: SELECT [DISTINCT [ON (...)] | ALL] FROM
    if (tokIsKw && tok.upper === 'SELECT') {
      let j = i + 1
      if (j < branch.length && isKeywordCandidate(branch, j) && (branch[j].upper === 'DISTINCT' || branch[j].upper === 'ALL')) {
        const wasDistinct = branch[j].upper === 'DISTINCT'
        j++
        if (
          wasDistinct &&
          j + 1 < branch.length &&
          branch[j].type === 'word' &&
          branch[j].upper === 'ON' &&
          branch[j + 1].type === 'group'
        ) {
          j += 2
        }
      }
      if (j < branch.length && isKeywordCandidate(branch, j) && branch[j].upper === 'FROM') {
        missingSelectFromPositions.add(branch[j].from)
        diagnostics.push({
          from: branch[j].from,
          to: branch[j].to,
          severity: 'error',
          code: 'missing-select-expr',
          message: 'Missing column or expression between SELECT and FROM',
        })
      }
    }

    // 3. Trailing comma directly before clause keywords (skip duckdb & bigquery)
    if (tok.type === 'comma' && !TRAILING_COMMA_OK_DIALECTS.has(dialect)) {
      if (nextIsKw && TRAILING_COMMA_FOLLOWERS.has(next.upper)) {
        const isQualifiedOrExpr = next2?.type === 'dot' || next2?.type === 'op'
        const isColumnNamedLimitOrOffset =
          (next.upper === 'LIMIT' || next.upper === 'OFFSET') &&
          (next2?.type === 'comma' ||
            (next2?.type === 'word' && (next2.upper === 'FROM' || next2.upper === 'AS')))
        if (!isQualifiedOrExpr && !isColumnNamedLimitOrOffset) {
          diagnostics.push({
            from: tok.from,
            to: tok.to,
            severity: 'error',
            code: 'trailing-comma',
            message: `Trailing comma before ${next.upper}`,
          })
        }
      }
    }

    // 4. Incomplete clause immediately followed by another clause keyword
    if (tokIsKw && nextIsKw) {
      const sameDup = next.upper === tok.upper && DUPLICATE_CHECK_KEYWORDS.has(tok.upper)
      const nextIsColumnExpr =
        next2?.type === 'dot' ||
        next2?.type === 'op' ||
        next2?.type === 'group' ||
        (next2?.type === 'word' && PREDICATE_KEYWORDS.has(next2.upper))
      if (!sameDup && !nextIsColumnExpr) {
        if (
          tok.upper === 'FROM' &&
          EMPTY_FROM_FOLLOWERS.has(next.upper) &&
          !missingSelectFromPositions.has(tok.from)
        ) {
          diagnostics.push({
            from: tok.from,
            to: tok.to,
            severity: 'error',
            code: 'incomplete-clause',
            message: `Incomplete FROM clause: expected table name before ${next.upper}`,
          })
        } else if (
          (tok.upper === 'WHERE' || tok.upper === 'HAVING') &&
          EMPTY_WHERE_FOLLOWERS.has(next.upper)
        ) {
          diagnostics.push({
            from: tok.from,
            to: tok.to,
            severity: 'error',
            code: 'incomplete-clause',
            message: `Incomplete ${tok.upper} clause: expected condition before ${next.upper}`,
          })
        } else if (
          (tok.upper === 'LIMIT' || tok.upper === 'OFFSET') &&
          currentClause !== 'SELECT' &&
          EMPTY_LIMIT_FOLLOWERS.has(next.upper)
        ) {
          diagnostics.push({
            from: tok.from,
            to: tok.to,
            severity: 'error',
            code: 'incomplete-clause',
            message: `Incomplete ${tok.upper} clause: expected value before ${next.upper}`,
          })
        } else if (
          (tok.upper === 'AND' || tok.upper === 'OR') &&
          !(tok.upper === 'OR' && prev?.type === 'word' && prev.upper === 'INSERT') &&
          EMPTY_BOOL_FOLLOWERS.has(next.upper)
        ) {
          diagnostics.push({
            from: tok.from,
            to: tok.to,
            severity: 'error',
            code: 'incomplete-clause',
            message: `Incomplete ${tok.upper} expression before ${next.upper}`,
          })
        }
      }
    }

    // 5. Missing BY after ORDER or GROUP
    if (tokIsKw && (tok.upper === 'ORDER' || tok.upper === 'GROUP')) {
      const afterWithin = prev?.type === 'word' && prev.upper === 'WITHIN'
      const inClausePosition =
        (seenFrom || (branchStarter === 'UPDATE' && currentClause === 'SET')) &&
        isClauseBoundaryPredecessor(prev)
      const followedByExprOp =
        next?.type === 'dot' || next?.type === 'op' || next?.type === 'comma'
      if (!afterWithin && inClausePosition && !followedByExprOp) {
        const hasBy =
          (next?.type === 'word' && next.upper === 'BY') ||
          (tok.upper === 'ORDER' &&
            next?.type === 'word' &&
            next.upper === 'SIBLINGS' &&
            next2?.type === 'word' &&
            next2.upper === 'BY')
        if (!hasBy) {
          const isTypingAtEof =
            !next &&
            !hasSemicolon &&
            isLastStatement &&
            isLastBranch &&
            cursorOffset !== null &&
            cursorOffset >= tok.from
          if (!isTypingAtEof) {
            diagnostics.push({
              from: tok.from,
              to: tok.to,
              severity: 'error',
              code: 'missing-by',
              message: `${tok.upper} must be followed by BY`,
              suggestion: `${tok.upper} BY`,
            })
          }
        }
      }
    }

    // 6. Misspelled clause detection
    let detectedMisspelledClause = null
    if (
      tokIsKw &&
      !KNOWN_SQL_KEYWORDS.has(tok.upper) &&
      !isActiveTypingPrefix(tok, cursorOffset)
    ) {
      // 6a. <TYPO> BY (ODRER BY, ORDR BY, GRUOP BY, GROP BY)
      if (next?.type === 'word' && next.upper === 'BY' && !VALID_BEFORE_BY.has(tok.upper)) {
        const sug = findBestTypo(tok.upper, ['ORDER', 'GROUP'])
        if (sug) {
          detectedMisspelledClause = { clause: sug, suggestion: sug }
        }
      }

      // 6b. SELECT ... FORM <table>
      if (
        !detectedMisspelledClause &&
        currentClause === 'SELECT' &&
        !seenFrom &&
        !hasRealFrom &&
        prev &&
        prev.type !== 'comma' &&
        !(prev.type === 'word' && (prev.upper === 'SELECT' || prev.upper === 'DISTINCT' || prev.upper === 'ALL')) &&
        isTypoOf(tok.upper, 'FROM') &&
        isTableStartToken(next)
      ) {
        const prev2 = i >= 2 ? branch[i - 2] : null
        const prev3 = i >= 3 ? branch[i - 3] : null
        const isWildcardStar =
          prev.type === 'op' &&
          prev.raw === '*' &&
          (!prev2 ||
            prev2.type === 'dot' ||
            prev2.type === 'comma' ||
            (prev2.type === 'number' && prev3?.type === 'word' && prev3.upper === 'TOP') ||
            (prev2.type === 'group' &&
              prev3?.type === 'word' &&
              (prev3.upper === 'TOP' || prev3.upper === 'ON')) ||
            (prev2.type === 'word' &&
              (prev2.upper === 'SELECT' || prev2.upper === 'DISTINCT' || prev2.upper === 'ALL')))
        if (prev.type !== 'op' || isWildcardStar) {
          detectedMisspelledClause = { clause: 'FROM', suggestion: 'FROM' }
        }
      }

      // 6c. DELETE FORM <table>
      if (
        !detectedMisspelledClause &&
        branchStarter === 'DELETE' &&
        !seenFrom &&
        !hasRealFrom &&
        prev?.type === 'word' &&
        (prev.upper === 'DELETE' || DELETE_MODIFIERS.has(prev.upper)) &&
        isTypoOf(tok.upper, 'FROM') &&
        isTableStartToken(next)
      ) {
        detectedMisspelledClause = { clause: 'FROM', suggestion: 'FROM' }
      }

      // 6d. INSERT INOT <table>
      if (
        !detectedMisspelledClause &&
        (branchStarter === 'INSERT' || branchStarter === 'REPLACE' || branchStarter === 'UPSERT') &&
        currentClause === branchStarter &&
        prev?.type === 'word' &&
        (prev.upper === branchStarter || INSERT_MODIFIERS.has(prev.upper)) &&
        isTypoOf(tok.upper, 'INTO') &&
        isInsertTargetTableToken(next)
      ) {
        detectedMisspelledClause = { clause: 'INTO', suggestion: 'INTO' }
      }

      // 6e. UPDATE <table> [alias] STE <col> = ...
      if (
        !detectedMisspelledClause &&
        branchStarter === 'UPDATE' &&
        currentClause === 'UPDATE' &&
        seenUpdateTable &&
        !hasRealSet &&
        isTypoOf(tok.upper, 'SET') &&
        looksLikeAssignmentStart(branch, i + 1)
      ) {
        detectedMisspelledClause = { clause: 'SET', suggestion: 'SET' }
      }

      // 6f. <TYPO> <number/param/ALL> after FROM/WHERE/ORDER/GROUP/SET (LIMT 10, LMIT 10, LIM 10, OFSET 5, OFFST 5)
      if (
        !detectedMisspelledClause &&
        (seenFrom || (branchStarter === 'UPDATE' && currentClause === 'SET')) &&
        isClauseBoundaryPredecessor(prev) &&
        isLimitOffsetArgToken(next)
      ) {
        const sug = findBestTypo(tok.upper, ['LIMIT', 'OFFSET'])
        if (sug) {
          detectedMisspelledClause = { clause: sug, suggestion: sug }
        }
      }

      // 6g. Join modifier + <JION> (LEFT JION orders)
      if (
        !detectedMisspelledClause &&
        seenFrom &&
        prev?.type === 'word' &&
        JOIN_MODIFIERS.has(prev.upper) &&
        isTypoOf(tok.upper, 'JOIN')
      ) {
        detectedMisspelledClause = { clause: 'JOIN', suggestion: 'JOIN' }
      }

      // 6h. After FROM <table> [optional alias] or UPDATE SET: <TYPO> or fused clause (WEHRE, WHER, JION, HAVNG, LIMWHERE)
      const canStartPostBodyClause =
        (seenFrom && fromItemCount >= 1) ||
        (branchStarter === 'UPDATE' && currentClause === 'SET')
      if (
        !detectedMisspelledClause &&
        canStartPostBodyClause &&
        isClauseBoundaryPredecessor(prev) &&
        next
      ) {
        const fused = matchFusedClause(tok.upper)
        if (fused) {
          const validBody =
            fused.clause === 'LIMIT' || fused.clause === 'OFFSET'
              ? isLimitOffsetArgToken(next)
              : fused.clause === 'JOIN' || fused.clause === 'FROM'
                ? isTableStartToken(next)
                : isConditionStartToken(next)
          if (validBody) {
            detectedMisspelledClause = fused
          }
        } else {
          const sug = findBestTypo(tok.upper, ['WHERE', 'JOIN', 'HAVING'])
          if (sug === 'JOIN' && seenFrom && isTableStartToken(next)) {
            detectedMisspelledClause = { clause: 'JOIN', suggestion: 'JOIN' }
          } else if ((sug === 'WHERE' || sug === 'HAVING') && isConditionStartToken(next)) {
            detectedMisspelledClause = { clause: sug, suggestion: sug }
          }
        }
      }

      // 6i. Dangling clause typo immediately before `;` (`SELECT * FROM accounts WHRE;`)
      if (
        !detectedMisspelledClause &&
        hasSemicolon &&
        !next &&
        canStartPostBodyClause &&
        isClauseBoundaryPredecessor(prev) &&
        !(prev?.type === 'word' && prev.upper === 'AS')
      ) {
        const trailingTarget = matchSemicolonTrailingClauseTypo(tok.upper)
        if (trailingTarget) {
          detectedMisspelledClause = { clause: trailingTarget, suggestion: trailingTarget }
        }
      }

      if (detectedMisspelledClause) {
        diagnostics.push({
          from: tok.from,
          to: tok.to,
          severity: 'error',
          code: 'misspelled-clause',
          message: `Misspelled SQL keyword "${tok.raw}". Did you mean "${detectedMisspelledClause.suggestion}"?`,
          suggestion: detectedMisspelledClause.suggestion,
        })
        if (detectedMisspelledClause.clause === 'FROM') {
          seenFrom = true
          currentClause = 'FROM'
          fromItemCount = 0
        } else {
          currentClause = detectedMisspelledClause.clause
        }
        continue
      }
    }

    // 7. Update clause state for real keywords and table items
    if (tokIsKw) {
      const u = tok.upper
      if (u === 'FROM') {
        seenFrom = true
        currentClause = 'FROM'
        fromItemCount = 0
      } else if (
        u === 'WHERE' || u === 'GROUP' || u === 'HAVING' || u === 'ORDER' ||
        u === 'LIMIT' || u === 'OFFSET' || u === 'SET' || u === 'VALUES' ||
        u === 'RETURNING' || u === 'QUALIFY' || u === 'WINDOW' ||
        u === 'PREWHERE' || u === 'SETTINGS' || u === 'FORMAT' || u === 'INTO'
      ) {
        currentClause = u
      } else if (u === 'SELECT') {
        currentClause = 'SELECT'
      } else if (currentClause === 'FROM' && !JOIN_MODIFIERS.has(u) && u !== 'JOIN' && u !== 'ONLY' && u !== 'AS') {
        fromItemCount++
      } else if (currentClause === 'UPDATE' && u !== 'UPDATE' && !UPDATE_MODIFIERS.has(u)) {
        seenUpdateTable = true
      }
    } else if (currentClause === 'FROM' && (tok.type === 'quoted_ident' || tok.type === 'group')) {
      fromItemCount++
    } else if (currentClause === 'UPDATE' && tok.type === 'quoted_ident') {
      seenUpdateTable = true
    }
  }

  // 8. Dangling clause keyword at end of branch / statement
  const lastIdx = branch.length - 1
  const lastTok = branch[lastIdx]
  if (
    isKeywordCandidate(branch, lastIdx) &&
    DANGLING_CLAUSE_KEYWORDS.has(lastTok.upper) &&
    !missingSelectFromPositions.has(lastTok.from) &&
    !duplicatePairFirstIndices.has(lastIdx - 1)
  ) {
    const isExplicitlyTerminated = hasSemicolon || !isLastStatement || !isLastBranch
    const isActivelyTypingAtEof =
      !isExplicitlyTerminated && cursorOffset !== null && cursorOffset >= lastTok.from
    if (!isActivelyTypingAtEof) {
      diagnostics.push({
        from: lastTok.from,
        to: lastTok.to,
        severity: 'error',
        code: 'incomplete-clause',
        message: `Incomplete ${lastTok.upper} clause`,
      })
    }
  }
}

function analyzeStatement(stmt, isLastStatement, dialect, cursorOffset, diagnostics) {
  const { tokens, hasSemicolon, inProceduralBlock } = stmt
  if (tokens.length === 0) return

  // Duplicate commas anywhere inside statement
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].type === 'comma' && tokens[i - 1].type === 'comma') {
      diagnostics.push({
        from: tokens[i].from,
        to: tokens[i].to,
        severity: 'error',
        code: 'duplicate-comma',
        message: 'Duplicate comma',
      })
    }
  }

  // Unclosed CASE ... END (skip if statement is in or contains a BEGIN procedural block)
  if (!inProceduralBlock) {
    const caseStack = []
    for (let i = 0; i < tokens.length; i++) {
      if (!isKeywordCandidate(tokens, i)) continue
      const u = tokens[i].upper
      const prev = i > 0 ? tokens[i - 1] : null
      if (u === 'CASE') {
        if (prev?.type === 'word' && prev.upper === 'END') continue
        caseStack.push(tokens[i])
      } else if (u === 'END') {
        if (caseStack.length > 0) caseStack.pop()
      }
    }
    for (const unclosedCase of caseStack) {
      diagnostics.push({
        from: unclosedCase.from,
        to: unclosedCase.to,
        severity: 'error',
        code: 'unclosed-case',
        message: 'Unclosed CASE expression: missing matching END',
        suggestion: 'END',
      })
    }
  }

  // Build top-level token stream (collapsing parenthesized sub-expressions into `group`)
  const topTokens = buildTopLevelTokens(tokens)
  if (topTokens.length === 0) return

  // Lone Oracle SQL*Plus `/` batch separator
  if (topTokens.length === 1 && topTokens[0].raw === '/') return

  // Statement starter validation
  const first = topTokens[0]
  let effectiveStarter = null
  if (first.type === 'group') {
    effectiveStarter = 'SELECT'
  } else if (first.type === 'word') {
    if (VALID_STATEMENT_STARTERS.has(first.upper)) {
      effectiveStarter = first.upper
    } else if (!isActiveTypingPrefix(first, cursorOffset)) {
      const suggestion = findBestTypo(first.upper, STARTER_TYPO_TARGETS)
      if (suggestion) {
        diagnostics.push({
          from: first.from,
          to: first.to,
          severity: 'error',
          code: 'unknown-keyword',
          message: `Unknown SQL keyword "${first.raw}". Did you mean "${suggestion}"?`,
          suggestion,
        })
        effectiveStarter = suggestion
      } else if (topTokens.length >= 2) {
        diagnostics.push({
          from: first.from,
          to: first.to,
          severity: 'error',
          code: 'unexpected-statement-start',
          message: `Unexpected token "${first.raw}" at start of SQL statement`,
        })
        return
      }
    }
  } else if (topTokens.length >= 2) {
    diagnostics.push({
      from: first.from,
      to: first.to,
      severity: 'error',
      code: 'unexpected-statement-start',
      message: `Unexpected token "${first.raw}" at start of SQL statement`,
    })
    return
  }

  if (!effectiveStarter) return

  // Resolve query entry point (handling EXPLAIN, WITH CTEs, CREATE VIEW AS)
  let queryStartIdx = 0
  let queryStarter = effectiveStarter

  if (queryStarter === 'EXPLAIN') {
    queryStartIdx = skipExplainPrefix(topTokens)
    if (queryStartIdx >= topTokens.length) return
    const nextTok = topTokens[queryStartIdx]
    queryStarter = nextTok.type === 'group' ? 'SELECT' : nextTok.type === 'word' ? nextTok.upper : ''
  }

  if (queryStarter === 'CREATE') {
    const viewStart = findCreateViewQueryStart(topTokens)
    if (viewStart === -1 || viewStart >= topTokens.length) return
    queryStartIdx = viewStart
    const nextTok = topTokens[queryStartIdx]
    queryStarter = nextTok.type === 'group' ? 'SELECT' : nextTok.type === 'word' ? nextTok.upper : ''
  }

  if (queryStarter === 'WITH') {
    queryStartIdx = skipWithCtes(topTokens, queryStartIdx)
    if (queryStartIdx >= topTokens.length) return
    const nextTok = topTokens[queryStartIdx]
    queryStarter = nextTok.type === 'group' ? 'SELECT' : nextTok.type === 'word' ? nextTok.upper : ''
  }

  if (!QUERY_DML_STARTERS.has(queryStarter)) return

  // For INSERT/REPLACE/UPSERT ... SELECT, analyze INSERT header + inner SELECT separately
  if (queryStarter === 'INSERT' || queryStarter === 'REPLACE' || queryStarter === 'UPSERT') {
    let innerSelectIdx = -1
    for (let i = queryStartIdx + 1; i < topTokens.length; i++) {
      if (isKeywordCandidate(topTokens, i) && (topTokens[i].upper === 'SELECT' || topTokens[i].upper === 'WITH')) {
        innerSelectIdx = i
        break
      }
    }
    if (innerSelectIdx !== -1) {
      const headerSlice = topTokens.slice(queryStartIdx, innerSelectIdx)
      analyzeQueryBranch(
        headerSlice,
        queryStarter,
        { dialect, cursorOffset, hasSemicolon: false, isLastStatement, isLastBranch: false },
        diagnostics
      )
      let selectStart = innerSelectIdx
      if (topTokens[selectStart].upper === 'WITH') {
        selectStart = skipWithCtes(topTokens, selectStart)
      }
      if (selectStart < topTokens.length) {
        const branches = splitQueryBranches(topTokens, selectStart)
        for (let b = 0; b < branches.length; b++) {
          const starter =
            branches[b][0]?.type === 'word' ? branches[b][0].upper : 'SELECT'
          analyzeQueryBranch(
            branches[b],
            starter,
            {
              dialect,
              cursorOffset,
              hasSemicolon,
              isLastStatement,
              isLastBranch: b === branches.length - 1,
            },
            diagnostics
          )
        }
      }
      return
    }
  }

  const branches = splitQueryBranches(topTokens, queryStartIdx)
  for (let b = 0; b < branches.length; b++) {
    const branch = branches[b]
    const firstBranchTok = branch[0]
    const branchStarter =
      b === 0
        ? queryStarter
        : firstBranchTok?.type === 'word'
          ? firstBranchTok.upper
          : 'SELECT'
    analyzeQueryBranch(
      branch,
      branchStarter,
      {
        dialect,
        cursorOffset,
        hasSemicolon,
        isLastStatement,
        isLastBranch: b === branches.length - 1,
      },
      diagnostics
    )
  }
}

function finalizeDiagnostics(diagnostics, docLength) {
  if (diagnostics.length === 0) return []
  diagnostics.sort((a, b) => a.from - b.from || a.to - b.to || a.code.localeCompare(b.code))

  const deduped = []
  const seenSpans = new Set()
  for (const diag of diagnostics) {
    const from = Math.max(0, Math.min(docLength, diag.from))
    const to = Math.max(from, Math.min(docLength, diag.to))
    const key = `${from}:${to}`
    if (seenSpans.has(key)) continue
    seenSpans.add(key)
    deduped.push(
      diag.suggestion !== undefined
        ? {
            from,
            to,
            severity: diag.severity,
            code: diag.code,
            message: diag.message,
            suggestion: diag.suggestion,
          }
        : {
            from,
            to,
            severity: diag.severity,
            code: diag.code,
            message: diag.message,
          }
    )
    if (deduped.length >= MAX_DIAGNOSTICS) break
  }
  return deduped
}

/**
 * Analyzes a SQL document and returns high-confidence syntax diagnostics sorted by `from` (max 25).
 */
export function analyzeSqlDiagnostics(docText, options = {}) {
  if (typeof docText !== 'string' || docText.length === 0 || docText.length > MAX_DOC_LENGTH) {
    return []
  }

  const dialect = typeof options?.dialect === 'string' ? options.dialect.trim().toLowerCase() : ''
  if (NON_SQL_DIALECTS.has(dialect)) return []

  const cursorOffset =
    typeof options?.cursorOffset === 'number' && Number.isFinite(options.cursorOffset)
      ? options.cursorOffset
      : null

  const { tokens, diagnostics } = lexSql(docText, dialect)
  if (tokens.length === 0) {
    return finalizeDiagnostics(diagnostics, docText.length)
  }

  const statements = splitStatements(tokens, docText, dialect)
  for (let i = 0; i < statements.length; i++) {
    analyzeStatement(
      statements[i],
      i === statements.length - 1,
      dialect,
      cursorOffset,
      diagnostics
    )
  }

  return finalizeDiagnostics(diagnostics, docText.length)
}

function getLineBounds(text, oneBasedLine) {
  if (!Number.isInteger(oneBasedLine) || oneBasedLine < 1) return null
  let currentLine = 1
  let lineStart = 0
  const len = text.length
  while (currentLine < oneBasedLine && lineStart < len) {
    const nl = text.indexOf('\n', lineStart)
    if (nl === -1) return null
    lineStart = nl + 1
    currentLine++
  }
  if (currentLine !== oneBasedLine) return null
  const nextNl = text.indexOf('\n', lineStart)
  const lineEnd = nextNl === -1 ? len : nextNl
  return { start: lineStart, end: lineEnd }
}

function stripIdentifierQuotes(raw) {
  if (raw.length < 2) return raw
  const first = raw[0]
  const last = raw[raw.length - 1]
  if (first === '"' && last === '"') return raw.slice(1, -1).replace(/""/g, '"')
  if (first === '`' && last === '`') return raw.slice(1, -1).replace(/``/g, '`')
  if (first === '[' && last === ']') return raw.slice(1, -1).replace(/\]\]/g, ']')
  return raw
}

function stripErrorIdentQuotes(raw) {
  if (raw.length < 2) return raw
  const first = raw[0]
  const last = raw[raw.length - 1]
  if (first === "'" && last === "'") return raw.slice(1, -1).replace(/''/g, "'")
  return stripIdentifierQuotes(raw)
}

function findTokenInRange(tokens, scopeText, tokenText, startBound, endBound) {
  if (!tokenText) return null
  const targetLower = tokenText.toLowerCase()
  const bareToken = stripIdentifierQuotes(tokenText)
  const bareTargetLower = bareToken.toLowerCase()

  // Pass 1: exact lexed token match (case-sensitive)
  for (const tok of tokens) {
    if (tok.from < startBound || tok.from >= endBound) continue
    if (tok.type === 'string') continue
    const bareRaw = stripIdentifierQuotes(tok.raw)
    if (tok.raw === tokenText || bareRaw === tokenText || bareRaw === bareToken) {
      return { from: tok.from, to: tok.to }
    }
  }

  // Pass 2: case-insensitive lexed token match (PG/SQLite may normalize case in error text)
  for (const tok of tokens) {
    if (tok.from < startBound || tok.from >= endBound) continue
    if (tok.type === 'string') continue
    const bareRawLower = stripIdentifierQuotes(tok.raw).toLowerCase()
    if (
      tok.raw.toLowerCase() === targetLower ||
      bareRawLower === targetLower ||
      bareRawLower === bareTargetLower
    ) {
      return { from: tok.from, to: tok.to }
    }
  }

  // Pass 3: raw substring fallback for non-word tokens (e.g. partial string literal `'abc` or bracket `[x`)
  const isPureWord = /^[A-Za-z_][A-Za-z0-9_$]*$/.test(tokenText)
  const isQuotedPureWord = bareToken !== tokenText && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(bareToken)
  if (!isPureWord && !isQuotedPureWord) {
    const slice = scopeText.slice(startBound, endBound)
    const exactIdx = slice.indexOf(tokenText)
    if (exactIdx !== -1) {
      return { from: startBound + exactIdx, to: startBound + exactIdx + tokenText.length }
    }
    const ciIdx = slice.toLowerCase().indexOf(targetLower)
    if (ciIdx !== -1) {
      return { from: startBound + ciIdx, to: startBound + ciIdx + tokenText.length }
    }
  }

  return null
}

function findFirstTokenSpanAt(tokens, scopeText, offset) {
  // Exact token containing offset
  for (const tok of tokens) {
    if (tok.from <= offset && offset < tok.to) {
      return { from: tok.from, to: tok.to }
    }
  }
  // Nearest token starting at or after offset
  for (const tok of tokens) {
    if (tok.from >= offset) {
      return { from: tok.from, to: tok.to }
    }
  }
  // Fallback single character if non-empty
  if (offset >= 0 && offset < scopeText.length) {
    return { from: offset, to: Math.min(scopeText.length, offset + 1) }
  }
  return null
}

function findLastTokenSpanBefore(tokens, limit) {
  let last = null
  for (const tok of tokens) {
    if (tok.from < limit) last = tok
    else break
  }
  return last ? { from: last.from, to: last.to } : null
}

function extractLeadingToken(snippet) {
  const m = /^\s*("[^"]*"|`[^`]*`|\[[^\]]*\]|'[^']*'|[A-Za-z_][A-Za-z0-9_$]*|\d+(?:\.\d+)?|[^\s])/.exec(
    snippet
  )
  return m ? m[1] : ''
}

function extractDbSyntaxErrorInternal(
  docText,
  errorMessage,
  targetRange = null,
  dialect = '',
  strictLineBounds = false
) {
  if (
    typeof docText !== 'string' ||
    docText.length === 0 ||
    typeof errorMessage !== 'string' ||
    errorMessage.trim().length === 0
  ) {
    return null
  }

  const rangeFrom =
    targetRange && typeof targetRange.from === 'number' && Number.isFinite(targetRange.from)
      ? Math.max(0, Math.min(docText.length, targetRange.from))
      : 0
  const rangeTo =
    targetRange && typeof targetRange.to === 'number' && Number.isFinite(targetRange.to)
      ? Math.max(rangeFrom, Math.min(docText.length, targetRange.to))
      : docText.length

  const scopeText = docText.slice(rangeFrom, rangeTo)
  if (scopeText.length === 0) return null

  const cleanMessage = errorMessage.trim()
  const normalizedDialect = typeof dialect === 'string' ? dialect.trim().toLowerCase() : ''
  const { tokens } = lexSql(scopeText, normalizedDialect)

  const makeDiag = (localSpan) => {
    if (!localSpan) return null
    const from = Math.max(rangeFrom, Math.min(rangeTo, rangeFrom + localSpan.from))
    const to = Math.max(from, Math.min(rangeTo, rangeFrom + localSpan.to))
    if (from === to && rangeTo > rangeFrom) return null
    return {
      from,
      to,
      severity: 'error',
      code: 'db-syntax-error',
      message: cleanMessage,
    }
  }

  // 1. ClickHouse: Syntax error: failed at position N [('TOKEN')]
  const chMatch = /Syntax error:\s*failed at position\s+(\d+)(?:\s*\('([^']*)'\))?/i.exec(
    cleanMessage
  )
  if (chMatch) {
    const pos = Number.parseInt(chMatch[1], 10)
    const chToken = chMatch[2] || ''
    if (!Number.isFinite(pos) || pos < 1 || pos > scopeText.length + 1) {
      return null
    }
    const zeroIdx = pos - 1
    if (zeroIdx >= scopeText.length) {
      return makeDiag(findLastTokenSpanBefore(tokens, scopeText.length))
    }
    const spanAtPos = findFirstTokenSpanAt(tokens, scopeText, zeroIdx)
    if (
      chToken &&
      spanAtPos &&
      scopeText.slice(spanAtPos.from, spanAtPos.to).toLowerCase() !== chToken.toLowerCase() &&
      stripIdentifierQuotes(scopeText.slice(spanAtPos.from, spanAtPos.to)).toLowerCase() !==
        stripIdentifierQuotes(chToken).toLowerCase()
    ) {
      if (strictLineBounds) {
        return null
      }
      const tokenSpan = findTokenInRange(tokens, scopeText, chToken, 0, scopeText.length)
      if (tokenSpan) return makeDiag(tokenSpan)
    }
    return makeDiag(spanAtPos)
  }

  // 2. MySQL / MariaDB: right syntax to use near 'SNIPPET' at line N
  const mysqlMatch = /right syntax to use near '([\s\S]*?)' at line (\d+)/i.exec(cleanMessage)
  if (mysqlMatch) {
    const snippet = mysqlMatch[1]
    const lineNum = Number.parseInt(mysqlMatch[2], 10)
    const bounds = getLineBounds(scopeText, lineNum)
    if (strictLineBounds && !bounds) {
      return null
    }
    if (snippet.length === 0) {
      const limit = bounds ? bounds.end : scopeText.length
      const lastSpan = findLastTokenSpanBefore(tokens, limit)
      if (strictLineBounds && bounds && lastSpan && lastSpan.from < bounds.start) {
        return null
      }
      return makeDiag(lastSpan)
    }
    const trimmedLeading = snippet.length - snippet.trimStart().length
    const trimmedSnippet = snippet.trimStart()
    const searchStart = bounds ? bounds.start : 0
    const exactIdx = scopeText.indexOf(trimmedSnippet, searchStart)
    if (exactIdx !== -1 && (!bounds || exactIdx <= bounds.end)) {
      const firstTokSpan = findFirstTokenSpanAt(tokens, scopeText, exactIdx)
      if (firstTokSpan && firstTokSpan.from === exactIdx) {
        return makeDiag(firstTokSpan)
      }
      const lead = extractLeadingToken(trimmedSnippet)
      return makeDiag({
        from: exactIdx,
        to: exactIdx + (lead.length > 0 ? lead.length : trimmedSnippet.length),
      })
    }
    const leadTok = extractLeadingToken(snippet.slice(trimmedLeading))
    if (leadTok) {
      if (bounds) {
        const onLine = findTokenInRange(tokens, scopeText, leadTok, bounds.start, bounds.end)
        if (onLine) return makeDiag(onLine)
        if (strictLineBounds) return null
      }
      const anywhere = findTokenInRange(tokens, scopeText, leadTok, 0, scopeText.length)
      if (anywhere) return makeDiag(anywhere)
    }
    return null
  }

  // 3. PostgreSQL / CockroachDB: syntax error at or near "TOKEN" (with optional LINE N:)
  const pgMatch = /syntax error at or near "("(?:""|[^"])*"|[^"]+)"/i.exec(cleanMessage)
  if (pgMatch) {
    const token = pgMatch[1]
    const lineMatch = /\bLINE\s+(\d+)\s*:/i.exec(cleanMessage)
    const lineNum = lineMatch ? Number.parseInt(lineMatch[1], 10) : null
    if (lineNum !== null) {
      const bounds = getLineBounds(scopeText, lineNum)
      if (bounds) {
        const onLine = findTokenInRange(tokens, scopeText, token, bounds.start, bounds.end)
        if (onLine) return makeDiag(onLine)
        if (strictLineBounds) return null
      } else if (strictLineBounds) {
        return null
      }
    }
    return makeDiag(findTokenInRange(tokens, scopeText, token, 0, scopeText.length))
  }

  // 4. SQLite / LibSQL: near "TOKEN": syntax error (including double-quoted near ""ident"": syntax error)
  const sqliteMatch = /near "(.+?)":\s*syntax error/i.exec(cleanMessage)
  if (sqliteMatch) {
    const token = sqliteMatch[1]
    return makeDiag(findTokenInRange(tokens, scopeText, token, 0, scopeText.length))
  }

  // 5. MSSQL: Incorrect syntax near [the keyword] 'TOKEN'
  const mssqlMatch = /Incorrect syntax near (?:the keyword )?'([^']+)'/i.exec(cleanMessage)
  if (mssqlMatch) {
    const token = mssqlMatch[1]
    const lineMatch = /\bLine\s+(\d+)\b/i.exec(cleanMessage)
    const lineNum = lineMatch ? Number.parseInt(lineMatch[1], 10) : null
    if (lineNum !== null) {
      const bounds = getLineBounds(scopeText, lineNum)
      if (bounds) {
        const onLine = findTokenInRange(tokens, scopeText, token, bounds.start, bounds.end)
        if (onLine) return makeDiag(onLine)
        if (strictLineBounds) return null
      } else if (strictLineBounds) {
        return null
      }
    }
    return makeDiag(findTokenInRange(tokens, scopeText, token, 0, scopeText.length))
  }

  return null
}

/**
 * Parses real DB engine syntax error messages (PostgreSQL, CockroachDB, SQLite,
 * LibSQL, MySQL, MariaDB, MSSQL, ClickHouse) into an exact document-absolute span.
 */
export function extractDbSyntaxErrorDiagnostic(
  docText,
  errorMessage,
  targetRange = null,
  dialect = ''
) {
  return extractDbSyntaxErrorInternal(docText, errorMessage, targetRange, dialect, false)
}

function findStatementIndexAtOffset(stmtSlices, offset) {
  for (let i = 0; i < stmtSlices.length; i++) {
    const s = stmtSlices[i]
    if (offset >= s.start && offset <= s.end) {
      return i
    }
  }
  for (let i = stmtSlices.length - 1; i >= 0; i--) {
    if (offset > stmtSlices[i].end) {
      return i
    }
  }
  return stmtSlices.length > 0 ? 0 : null
}

const ERROR_IDENT_SEG_SRC =
  '(?:"(?:[^"]|"")+"|`(?:[^`]|``)+`|\\[(?:[^\\]]|\\]\\])+\\]|\'(?:[^\']|\'\')+\'|[A-Za-z_](?:[A-Za-z0-9_$]|-(?=[A-Za-z0-9_$]))*)'
const ERROR_IDENT_PATH_SRC = `${ERROR_IDENT_SEG_SRC}(?:\\.${ERROR_IDENT_SEG_SRC})*`

function unwrapSingleOuterSingleQuotes(text) {
  const len = text.length
  if (len < 2 || text[0] !== "'" || text[len - 1] !== "'") return text
  for (let i = 1; i < len - 1; i++) {
    if (text[i] === "'") {
      if (i + 1 < len - 1 && text[i + 1] === "'") {
        i++
        continue
      }
      return text
    }
  }
  return text.slice(1, -1).replace(/''/g, "'").trim()
}

function parseIdentifierPathParts(rawText) {
  const cleaned = String(rawText || '')
    .trim()
    .replace(/[\s.,;:]+$/, '')
    .trim()
  if (!cleaned) return []

  const working = unwrapSingleOuterSingleQuotes(cleaned)
  if (!working) return []

  const parts = []
  let start = 0
  let quote = ''
  const len = working.length
  for (let i = 0; i < len; i++) {
    const ch = working[i]
    if (quote) {
      if (quote === '[') {
        if (ch === ']') {
          if (i + 1 < len && working[i + 1] === ']') {
            i++
            continue
          }
          quote = ''
        }
      } else if (ch === quote) {
        if (i + 1 < len && working[i + 1] === quote) {
          i++
          continue
        }
        quote = ''
      }
      continue
    }
    if (ch === '"' || ch === '`' || ch === "'" || ch === '[') {
      quote = ch
      continue
    }
    if (ch === '.') {
      const seg = stripErrorIdentQuotes(working.slice(start, i).trim()).trim().toLowerCase()
      if (seg) parts.push(seg)
      start = i + 1
    }
  }
  const tailSeg = stripErrorIdentQuotes(working.slice(start).trim()).trim().toLowerCase()
  if (tailSeg) parts.push(tailSeg)
  return parts
}

function extractMissingIdentifierCandidates(errorMessage) {
  const qualifiedPaths = []
  const seenQualified = new Set()
  const bareIdentifiers = []
  const seenBare = new Set()
  const unqualifiedTails = []
  const pairs = []
  const seenPairs = new Set()

  const addPair = (relation, column) => {
    const rel = String(relation || '').trim().toLowerCase()
    const col = String(column || '').trim().toLowerCase()
    if (!rel || !col) return
    const key = `${rel}\0${col}`
    if (seenPairs.has(key)) return
    seenPairs.add(key)
    pairs.push({ relation: rel, column: col })
  }

  const addParts = (parts, isColumnKind = false) => {
    if (!parts || parts.length === 0) return
    if (parts.length >= 2) {
      const qKey = parts.join('\0')
      if (!seenQualified.has(qKey)) {
        seenQualified.add(qKey)
        qualifiedPaths.push(parts)
      }
      const last = parts[parts.length - 1]
      const prev = parts[parts.length - 2]
      unqualifiedTails.push(last)
      if (isColumnKind) {
        addPair(prev, last)
      }
    } else if (!seenBare.has(parts[0])) {
      seenBare.add(parts[0])
      bareIdentifiers.push(parts[0])
    }
  }

  const addPath = (rawPath, isColumnKind = false) => {
    addParts(parseIdentifierPathParts(rawPath), isColumnKind)
  }

  let scrubbed = String(errorMessage || '')

  // 1. PostgreSQL: column "X" of relation "Y" does not exist (mask span so "relation Y does not exist" isn't re-matched)
  const pgColOfRelRe = new RegExp(
    `column\\s+(${ERROR_IDENT_PATH_SRC})\\s+of\\s+relation\\s+(${ERROR_IDENT_PATH_SRC})\\s+(?:does not exist|doesn't exist|not found)`,
    'gi'
  )
  scrubbed = scrubbed.replace(pgColOfRelRe, (full, colRaw, relRaw) => {
    const colParts = parseIdentifierPathParts(colRaw)
    const relParts = parseIdentifierPathParts(relRaw)
    if (colParts.length > 0 && relParts.length > 0) {
      addPair(relParts[relParts.length - 1], colParts[colParts.length - 1])
      addParts(colParts, false)
    }
    return ' '.repeat(full.length)
  })

  // 2. SQLite INSERT/UPDATE: table X has no column named Y
  if (/has no column named/i.test(scrubbed)) {
    const sqliteNoColRe =
      /table\s+([^\r\n]+?)\s+has no column named\s+([^\r\n;,()]+?)(?=\s*\(|\s+in\s+|\s+at\s+|$)/gim
    scrubbed = scrubbed.replace(sqliteNoColRe, (full, tblRaw, colRaw) => {
      const tblParts = parseIdentifierPathParts(tblRaw)
      const colParts = parseIdentifierPathParts(colRaw)
      if (tblParts.length > 0 && colParts.length > 0) {
        addPair(tblParts[tblParts.length - 1], colParts[colParts.length - 1])
        addParts(colParts, false)
      }
      return ' '.repeat(full.length)
    })
  }

  // 3. SQLite / generic: no such table/column/...: <ident> (supports quoted schema."tbl", hyphens, spaces)
  const noSuchRe =
    /no such (table|column|function|index|view|trigger|module):\s*([^\r\n;,()]+?)(?=\s*\(|\s+in\s+|\s+at\s+|$)/gim
  let m
  while ((m = noSuchRe.exec(scrubbed)) !== null) {
    addPath(m[2], String(m[1] || '').toLowerCase() === 'column')
  }

  // 4. PG / MySQL / ClickHouse / Oracle: relation/table/column/... <ident> does not exist / not found / is ambiguous
  const doesNotExistRe = new RegExp(
    `(table or view|relation|table|column|view|index|function|sequence|schema)\\s+(${ERROR_IDENT_PATH_SRC})\\s+(?:does not exist|doesn't exist|not found|is ambiguous)`,
    'gi'
  )
  while ((m = doesNotExistRe.exec(scrubbed)) !== null) {
    addPath(m[2], String(m[1] || '').toLowerCase() === 'column')
  }

  // 5. MySQL / ClickHouse: Unknown column/table/identifier + Missing columns
  const unknownRe = new RegExp(
    `Unknown\\s+(expression or function identifier|table expression identifier|expression identifier|identifier|column|table)\\s+(${ERROR_IDENT_PATH_SRC})`,
    'gi'
  )
  while ((m = unknownRe.exec(scrubbed)) !== null) {
    const kind = String(m[1] || '').toLowerCase()
    addPath(m[2], kind === 'column' || kind.includes('identifier'))
  }
  const chMissingColsRe = /Missing columns:\s*'([^']+)'/gi
  while ((m = chMissingColsRe.exec(scrubbed)) !== null) {
    addPath(m[1], true)
  }

  // 6. MSSQL: Invalid object/column name 'X'
  const mssqlInvalidRe = /Invalid\s+(object|column)\s+name\s+'([^']+)'/gi
  while ((m = mssqlInvalidRe.exec(scrubbed)) !== null) {
    addPath(m[2], String(m[1] || '').toLowerCase() === 'column')
  }

  // 7. Oracle: ORA-00904: <ident>: invalid identifier
  const oraInvalidRe = new RegExp(
    `ORA-00904:\\s*(${ERROR_IDENT_PATH_SRC})\\s*:\\s*invalid identifier`,
    'gi'
  )
  while ((m = oraInvalidRe.exec(scrubbed)) !== null) {
    addPath(m[1], true)
  }

  return {
    qualifiedPaths,
    bareIdentifiers,
    tails: [...new Set(unqualifiedTails)],
    pairs,
  }
}

function sliceTokensHaveBareIdent(tokens, lowerIdent) {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.type === 'string' || tok.type === 'comment') continue
    if (stripIdentifierQuotes(tok.raw).toLowerCase() === lowerIdent) {
      return true
    }
  }
  return false
}

function sliceTokensHaveQualifiedIdent(tokens, pathParts) {
  const segs = Array.isArray(pathParts)
    ? pathParts.filter(Boolean)
    : String(pathParts || '').split('.').filter(Boolean)
  if (segs.length === 0) return false
  if (segs.length === 1) return sliceTokensHaveBareIdent(tokens, segs[0])
  const neededLen = segs.length * 2 - 1
  for (let i = 0; i <= tokens.length - neededLen; i++) {
    let matched = true
    for (let s = 0; s < segs.length; s++) {
      const tok = tokens[i + s * 2]
      if (!tok || tok.type === 'string' || tok.type === 'comment') {
        matched = false
        break
      }
      if (stripIdentifierQuotes(tok.raw).toLowerCase() !== segs[s]) {
        matched = false
        break
      }
      if (s < segs.length - 1) {
        const dotTok = tokens[i + s * 2 + 1]
        if (!dotTok || dotTok.type !== 'dot') {
          matched = false
          break
        }
      }
    }
    if (matched) return true
  }
  return false
}

function matchPgErrorLineSnippet(sliceText, lineNum, rawSnippet) {
  const norm = (s) =>
    String(s || '')
      .trim()
      .replace(/;\s*$/, '')
      .replace(/\s+/g, ' ')
      .toLowerCase()
  const snippetClean = norm(rawSnippet).replace(/^\.\.\.\s*/, '').replace(/\s*\.\.\.$/, '')
  if (!snippetClean) return false
  const bounds = getLineBounds(sliceText, lineNum)
  if (!bounds) return false
  const lineNorm = norm(sliceText.slice(bounds.start, bounds.end))
  return lineNorm.length > 0 && (lineNorm === snippetClean || lineNorm.includes(snippetClean))
}

/**
 * Pinpoints the failing statement index inside a multi-statement SQL script from a DB error message.
 * Returns null if the error cannot be attributed unambiguously to a specific statement.
 */
export function resolveFailedStatementInScript(
  scriptText,
  errorMessage,
  stmtSlices,
  dialect = 'sqlite'
) {
  if (typeof scriptText !== 'string' || !Array.isArray(stmtSlices) || stmtSlices.length === 0) {
    return null
  }
  if (stmtSlices.length === 1) {
    return 0
  }

  const msg = typeof errorMessage === 'string' ? errorMessage.trim() : ''
  if (!msg) return null

  const normalizedDialect = typeof dialect === 'string' ? dialect.trim().toLowerCase() : ''
  const staticDiags = analyzeSqlDiagnostics(scriptText, { dialect: normalizedDialect })
  const hasStaticErrorInSlice = (slice) =>
    staticDiags.some(
      (d) => d.severity === 'error' && d.from >= slice.start && d.from <= slice.end
    )

  const explicitLineMatch = /\b(?:at\s+line|line)\s+(\d+)\b/i.exec(msg)
  const explicitPosMatch = /\bat\s+position\s+(\d+)\b/i.exec(msg)
  const explicitLineNum = explicitLineMatch ? Number.parseInt(explicitLineMatch[1], 10) : null
  const explicitPosNum = explicitPosMatch ? Number.parseInt(explicitPosMatch[1], 10) : null
  const hasExplicitCoord =
    (explicitLineNum !== null && Number.isFinite(explicitLineNum)) ||
    (explicitPosNum !== null && Number.isFinite(explicitPosNum))
  const wholeDiag = hasExplicitCoord
    ? extractDbSyntaxErrorInternal(scriptText, msg, null, normalizedDialect, true)
    : null
  const wholeDiagIdx = wholeDiag ? findStatementIndexAtOffset(stmtSlices, wholeDiag.from) : null
  const slice0Lines = stmtSlices[0].text.split('\n').length
  const slice0Len = stmtSlices[0].text.length

  // 1. DB syntax error matching — evaluate per statement slice first so statement-local
  //    LINE 1: / at line 1 / at position N never falsely targets Query 1.
  const perSliceSyntaxMatches = []
  for (let i = 0; i < stmtSlices.length; i++) {
    if (extractDbSyntaxErrorInternal(stmtSlices[i].text, msg, null, normalizedDialect, true)) {
      perSliceSyntaxMatches.push(i)
    }
  }

  if (perSliceSyntaxMatches.length === 1) {
    const localIdx = perSliceSyntaxMatches[0]
    const hasGlobalCoordConflict =
      wholeDiagIdx !== null &&
      wholeDiagIdx !== localIdx &&
      ((explicitLineNum !== null && explicitLineNum > 1) ||
        (explicitPosNum !== null && explicitPosNum > slice0Len + 1))
    if (!hasGlobalCoordConflict) {
      return localIdx
    }
    // Disambiguate script-global vs statement-local coordinate conflict using PG snippet or static diags
    const pgLineSnippetConflict = /\bLINE\s+(\d+)\s*:\s*([^\r\n]+)/i.exec(msg)
    if (pgLineSnippetConflict) {
      const lineNum = Number.parseInt(pgLineSnippetConflict[1], 10)
      const localSnipOk = matchPgErrorLineSnippet(
        stmtSlices[localIdx].text,
        lineNum,
        pgLineSnippetConflict[2]
      )
      const globalSnipOk = matchPgErrorLineSnippet(scriptText, lineNum, pgLineSnippetConflict[2])
      if (localSnipOk && !globalSnipOk) return localIdx
      if (globalSnipOk && !localSnipOk) return wholeDiagIdx
    }
    const localHasStaticErr = hasStaticErrorInSlice(stmtSlices[localIdx])
    const globalHasStaticErr = hasStaticErrorInSlice(stmtSlices[wholeDiagIdx])
    if (localHasStaticErr && !globalHasStaticErr) return localIdx
    if (globalHasStaticErr && !localHasStaticErr) return wholeDiagIdx
    // Ambiguous between statement-local line N and script-global line N — fail closed!
    return null
  }
  if (perSliceSyntaxMatches.length > 1) {
    // Disambiguate PostgreSQL LINE N: <snippet> against each matching slice's line N
    const pgLineSnippetMatch = /\bLINE\s+(\d+)\s*:\s*([^\r\n]+)/i.exec(msg)
    if (pgLineSnippetMatch) {
      const lineNum = Number.parseInt(pgLineSnippetMatch[1], 10)
      const snippetMatches = perSliceSyntaxMatches.filter((idx) =>
        matchPgErrorLineSnippet(stmtSlices[idx].text, lineNum, pgLineSnippetMatch[2])
      )
      if (snippetMatches.length === 1) {
        return snippetMatches[0]
      }
    }
    // Disambiguate using static SQL diagnostics (e.g., SELET in Query 2 when token "id" exists in both)
    const erroredMatches = perSliceSyntaxMatches.filter((idx) =>
      hasStaticErrorInSlice(stmtSlices[idx])
    )
    if (erroredMatches.length === 1) {
      return erroredMatches[0]
    }
    // Ambiguous across multiple statements — fail closed rather than overwriting Query 1!
    return null
  }

  // If per-slice strict syntax matching returned 0 hits (e.g. PG semicolon error where `;` was
  // stripped from stmtSlices), still match PG `LINE N: <snippet>` across slices cleanly first.
  const pgLineSnippetFallback = /\bLINE\s+(\d+)\s*:\s*([^\r\n]+)/i.exec(msg)
  if (pgLineSnippetFallback) {
    const lineNum = Number.parseInt(pgLineSnippetFallback[1], 10)
    const snippetMatches = []
    for (let i = 0; i < stmtSlices.length; i++) {
      if (matchPgErrorLineSnippet(stmtSlices[i].text, lineNum, pgLineSnippetFallback[2])) {
        snippetMatches.push(i)
      }
    }
    if (snippetMatches.length === 1) {
      return snippetMatches[0]
    }
  }

  // Whole-script fallback when per-slice strict matching had 0 hits and wholeDiag resolves
  // cleanly to a non-first statement or exceeds Query 1's bounds (preventing statement-local
  // LINE 1 / `;` errors from falsely targeting Query 1).
  if (
    wholeDiagIdx !== null &&
    (wholeDiagIdx > 0 ||
      (explicitLineNum !== null && explicitLineNum > slice0Lines) ||
      (explicitPosNum !== null && explicitPosNum > slice0Len + 1))
  ) {
    return wholeDiagIdx
  }

  // 2. Missing identifier matching (qualified paths -> table+column pairs -> bare -> tails)
  //    Strictly enforces uniqueness: never guesses Query 1 when multiple slices match!
  const missingIds = extractMissingIdentifierCandidates(msg)
  const hasAnyMissingId =
    missingIds.qualifiedPaths.length > 0 ||
    missingIds.bareIdentifiers.length > 0 ||
    missingIds.pairs.length > 0 ||
    missingIds.tails.length > 0
  if (hasAnyMissingId) {
    const sliceTokens = stmtSlices.map((s) => lexSql(s.text, normalizedDialect).tokens)
    const collectMatches = (predicate) => {
      const hits = []
      for (let i = 0; i < sliceTokens.length; i++) {
        if (predicate(sliceTokens[i])) hits.push(i)
      }
      return hits
    }
    const resolveUnique = (hits) => {
      if (hits.length === 1) return { resolved: true, index: hits[0] }
      if (hits.length > 1) {
        const errored = hits.filter((idx) => hasStaticErrorInSlice(stmtSlices[idx]))
        if (errored.length === 1) return { resolved: true, index: errored[0] }
        return { resolved: true, index: null }
      }
      return { resolved: false, index: null }
    }

    if (missingIds.qualifiedPaths.length > 0) {
      const res = resolveUnique(
        collectMatches((toks) =>
          missingIds.qualifiedPaths.some((parts) => sliceTokensHaveQualifiedIdent(toks, parts))
        )
      )
      if (res.resolved) return res.index
    }

    if (missingIds.pairs.length > 0) {
      const res = resolveUnique(
        collectMatches((toks) =>
          missingIds.pairs.some(
            (p) =>
              sliceTokensHaveBareIdent(toks, p.relation) &&
              sliceTokensHaveBareIdent(toks, p.column)
          )
        )
      )
      if (res.resolved) return res.index
    }

    if (missingIds.bareIdentifiers.length > 0) {
      const res = resolveUnique(
        collectMatches((toks) =>
          missingIds.bareIdentifiers.some((cand) => sliceTokensHaveBareIdent(toks, cand))
        )
      )
      if (res.resolved) return res.index
    }

    if (missingIds.tails.length > 0) {
      const res = resolveUnique(
        collectMatches((toks) =>
          missingIds.tails.some((cand) => sliceTokensHaveBareIdent(toks, cand))
        )
      )
      if (res.resolved) return res.index
    }
  }

  const staticErrIndices = []
  for (let i = 0; i < stmtSlices.length; i++) {
    if (hasStaticErrorInSlice(stmtSlices[i])) {
      staticErrIndices.push(i)
    }
  }
  if (staticErrIndices.length === 1) {
    return staticErrIndices[0]
  }

  return null
}

/**
 * Resolves the failing SQL snippet and safe single-statement replacement target
 * when a single or multi-statement execution throws an engine error.
 */
export function resolveExecutionErrorFixTarget(
  execRange,
  fallbackSql,
  errorMessage,
  stmtSlices,
  dialect = 'sqlite',
  failedStatementIndex = null,
  expectedStatementCount = null
) {
  const safeFallback = String(fallbackSql || '').trim()
  const slices = Array.isArray(stmtSlices) ? stmtSlices : []
  const countMatchesSlices =
    expectedStatementCount === null || expectedStatementCount === undefined
      ? true
      : typeof expectedStatementCount === 'number' &&
        Number.isInteger(expectedStatementCount) &&
        expectedStatementCount === slices.length
  const explicitIdx =
    countMatchesSlices &&
    typeof failedStatementIndex === 'number' &&
    Number.isInteger(failedStatementIndex) &&
    failedStatementIndex >= 0 &&
    failedStatementIndex < slices.length
      ? failedStatementIndex
      : null

  if (!execRange) {
    if (slices.length > 1) {
      const failedIdx =
        explicitIdx !== null
          ? explicitIdx
          : resolveFailedStatementInScript(safeFallback, errorMessage, slices, dialect)
      if (failedIdx !== null && slices[failedIdx]) {
        return {
          failedSql: slices[failedIdx].text.trim() || safeFallback,
          fixTargetRange: null,
        }
      }
    } else if (slices.length === 1 && slices[0]?.text?.trim()) {
      return {
        failedSql: slices[0].text.trim(),
        fixTargetRange: null,
      }
    }
    return { failedSql: safeFallback, fixTargetRange: null }
  }

  if (slices.length > 1) {
    const failedIdx =
      explicitIdx !== null
        ? explicitIdx
        : resolveFailedStatementInScript(execRange.sql, errorMessage, slices, dialect)
    if (failedIdx !== null && slices[failedIdx]) {
      const slice = slices[failedIdx]
      return {
        failedSql: slice.text.trim() || safeFallback,
        fixTargetRange: {
          from: execRange.from + slice.start,
          to: execRange.from + slice.end,
          originalSlice: execRange.sql.slice(slice.start, slice.end),
          statementIndex: failedIdx,
          totalStatements: slices.length,
          preserveOtherStatements: true,
        },
      }
    }
    return {
      failedSql: safeFallback,
      fixTargetRange: {
        from: execRange.from,
        to: execRange.to,
        originalSlice: execRange.originalSlice,
        totalStatements: slices.length,
        preserveOtherStatements: true,
      },
    }
  }

  if (slices.length === 1 && slices[0] && slices[0].end > slices[0].start) {
    const onlySlice = slices[0]
    return {
      failedSql: onlySlice.text.trim() || safeFallback,
      fixTargetRange: {
        from: execRange.from + onlySlice.start,
        to: execRange.from + onlySlice.end,
        originalSlice: execRange.sql.slice(onlySlice.start, onlySlice.end),
        statementIndex: 0,
        totalStatements: 1,
        preserveOtherStatements: true,
      },
    }
  }

  return {
    failedSql: safeFallback,
    fixTargetRange: {
      from: execRange.from,
      to: execRange.to,
      originalSlice: execRange.originalSlice,
      statementIndex: 0,
      totalStatements: 1,
      preserveOtherStatements: true,
    },
  }
}
