// src/editor/console.ts
// Feature F15: CodeMirror 6 SQL Console Integration with True Orca OLED Syntax & 8-Dialect Support

import {
  EditorView,
  EditorState,
  Compartment,
  keymap,
  sql,
  SQLite,
  PostgreSQL,
  MySQL,
  MariaSQL,
  autocompletion,
  completionKeymap,
  defaultKeymap,
  history,
  historyKeymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  HighlightStyle,
  syntaxHighlighting,
  tags,
  LanguageSupport,
  StreamLanguage,
  search,
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
  foldGutter,
  codeFolding,
  foldKeymap,
  bracketMatching,
  type Extension,
  type SQLDialect,
} from '../../vendor/codemirror.js'
import { findStatementAtOffset } from '../drivers/common/sql-tools.js'
import {
  resolveSqlExecutionSpan,
  resolveSqlReplacementSpan,
  type SqlExecutionRange,
  type SqlReplaceTarget,
} from '../shared-sql-core.js'
import {
  clearGhostEffect,
  createCmInlineAiExtension,
  type CmInlineAiOptions,
} from '../shared-cm-inline-ai.js'
import {
  clearDbSqlErrorEffect,
  createCmSqlLintExtension,
  setDbSqlErrorEffect,
  triggerSqlLintEffect,
} from '../shared-cm-sql-lint.js'
import type { DatabaseDriverType } from '../protocol.js'
import { bindCtrlWheelHorizontalScroll } from '../shared-wheel-scroll.js'

export type SqlDialectType = DatabaseDriverType

export interface EditorTypography {
  fontFamily?: string
  cssFontFamily?: string
  fontSize?: number
  lineHeight?: number
  fontWeight?: string
  fontLigatures?: boolean
}

export interface SqlConsoleOptions {
  parent: HTMLElement
  initialDoc?: string
  dialect?: SqlDialectType
  schema?: Record<string, string[]>
  typography?: EditorTypography
  aiInline?: CmInlineAiOptions
  onExecute?: (sql: string) => void
  onExecuteAll?: (sql: string) => void
  onFormatSql?: () => void
  onChange?: (doc: string) => void
}

export interface ExecutableStateLike {
  selection?: { main?: { empty: boolean; from: number; to: number; head?: number } }
  sliceDoc: (from: number, to: number) => string
  doc: { toString: () => string }
}

export type { SqlExecutionRange, SqlReplaceTarget }

const REDIS_MONOCHROME_LANG = StreamLanguage.define({
  name: 'redis',
  token(stream) {
    stream.skipToEnd()
    return null
  },
})

interface BlockCommentParserState {
  inBlockComment: boolean
}

function advanceBlockComment(stream: { match: (re: RegExp | string) => unknown; skipToEnd: () => void }, state: BlockCommentParserState): boolean {
  if (!state.inBlockComment) return false
  if (stream.match(/^.*?\*\//)) {
    state.inBlockComment = false
  } else {
    stream.skipToEnd()
  }
  return true
}

function readSqlBracketOrQuoted(
  stream: { next: () => string | void; peek?: () => string | void; eol: () => boolean },
  closeChar: string
): void {
  while (!stream.eol()) {
    const ch = stream.next()
    if (ch === closeChar) {
      if (typeof stream.peek === 'function' && stream.peek() === closeChar) {
        stream.next()
        continue
      }
      break
    }
  }
}

function readEscapedString(stream: { next: () => string | void; eol: () => boolean }, quoteChar: string): void {
  while (!stream.eol()) {
    const ch = stream.next()
    if (ch === '\\') {
      stream.next()
      continue
    }
    if (ch === quoteChar) break
  }
}

const MSSQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'MERGE', 'USING', 'MATCHED', 'OUTPUT', 'INSERTED', 'DELETED', 'JOIN', 'INNER', 'LEFT',
  'RIGHT', 'FULL', 'OUTER', 'CROSS', 'APPLY', 'ON', 'AS', 'AND', 'OR', 'NOT', 'IN', 'IS',
  'NULL', 'LIKE', 'BETWEEN', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'GROUP',
  'BY', 'HAVING', 'ORDER', 'ASC', 'DESC', 'OFFSET', 'FETCH', 'NEXT', 'ROWS', 'ONLY',
  'TOP', 'PERCENT', 'WITH', 'TIES', 'DISTINCT', 'UNION', 'ALL', 'INTERSECT', 'EXCEPT',
  'OVER', 'PARTITION', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'TABLE', 'VIEW', 'INDEX',
  'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT', 'DEFAULT', 'CHECK', 'UNIQUE',
  'DECLARE', 'BEGIN', 'TRY', 'CATCH', 'TRAN', 'TRANSACTION', 'COMMIT', 'ROLLBACK', 'EXEC',
  'EXECUTE', 'GO', 'NOLOCK', 'ROWLOCK', 'UPDLOCK', 'PIVOT', 'UNPIVOT', 'SHOWPLAN_ALL',
])

const MSSQL_TYPES_AND_BUILTINS = new Set([
  'INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'BIT', 'DECIMAL', 'NUMERIC', 'MONEY', 'FLOAT',
  'REAL', 'CHAR', 'VARCHAR', 'NVARCHAR', 'NCHAR', 'TEXT', 'NTEXT', 'DATE', 'DATETIME',
  'DATETIME2', 'SMALLDATETIME', 'DATETIMEOFFSET', 'TIME', 'UNIQUEIDENTIFIER', 'VARBINARY',
  'BINARY', 'XML', 'MAX', 'GETDATE', 'GETUTCDATE', 'SYSDATETIME', 'NEWID', 'ISNULL',
  'COALESCE', 'NULLIF', 'CAST', 'CONVERT', 'TRY_CAST', 'TRY_CONVERT', 'DATEADD',
  'DATEDIFF', 'DATENAME', 'DATEPART', 'STRING_AGG', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LEN', 'SUBSTRING', 'TRIM', 'UPPER', 'LOWER',
])

const ORACLE_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'MERGE', 'USING', 'MATCHED', 'RETURNING', 'BULK', 'COLLECT', 'FORALL', 'JOIN', 'INNER',
  'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON', 'AS', 'AND', 'OR', 'NOT', 'IN', 'IS',
  'NULL', 'LIKE', 'BETWEEN', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'ELSIF', 'END',
  'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC', 'OFFSET', 'FETCH', 'FIRST', 'NEXT',
  'ROWS', 'ONLY', 'DISTINCT', 'UNION', 'ALL', 'INTERSECT', 'MINUS', 'CONNECT', 'PRIOR',
  'START', 'WITH', 'OVER', 'PARTITION', 'CREATE', 'REPLACE', 'ALTER', 'DROP', 'TRUNCATE',
  'TABLE', 'VIEW', 'MATERIALIZED', 'INDEX', 'SEQUENCE', 'SYNONYM', 'TRIGGER', 'PACKAGE',
  'BODY', 'PROCEDURE', 'FUNCTION', 'PRAGMA', 'DECLARE', 'BEGIN', 'EXCEPTION', 'LOOP',
  'IF', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'EXPLAIN', 'PLAN', 'FOR', 'DUAL', 'ROWNUM',
  'ROWID', 'LEVEL', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT', 'DEFAULT',
  'ENABLE', 'DISABLE', 'CASCADE', 'CONSTRAINTS',
])

const ORACLE_TYPES_AND_BUILTINS = new Set([
  'NUMBER', 'BINARY_INTEGER', 'PLS_INTEGER', 'INTEGER', 'INT', 'FLOAT', 'VARCHAR2',
  'NVARCHAR2', 'VARCHAR', 'CHAR', 'NCHAR', 'CLOB', 'NCLOB', 'BLOB', 'RAW', 'LONG',
  'DATE', 'TIMESTAMP', 'INTERVAL', 'BOOLEAN', 'SYS_REFCURSOR', 'SYSDATE', 'SYSTIMESTAMP',
  'CURRENT_TIMESTAMP', 'USER', 'NVL', 'NVL2', 'DECODE', 'COALESCE', 'NULLIF', 'CAST',
  'TO_DATE', 'TO_CHAR', 'TO_NUMBER', 'TO_TIMESTAMP', 'LISTAGG', 'REGEXP_LIKE', 'SUBSTR',
  'INSTR', 'LENGTH', 'TRIM', 'UPPER', 'LOWER', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'DBMS_XPLAN', 'DISPLAY',
])

const MONGODB_METHODS = new Set([
  'getCollection', 'find', 'findOne', 'aggregate', 'countDocuments',
  'estimatedDocumentCount', 'distinct', 'insertOne', 'insertMany', 'updateOne',
  'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate',
  'findOneAndDelete', 'findOneAndReplace', 'bulkWrite', 'explain', 'sort', 'limit',
  'skip', 'projection', 'hint', 'maxTimeMS', 'collation', 'allowDiskUse', 'toArray',
  'drop', 'dropDatabase', 'createCollection', 'createIndex', 'createIndexes',
  'dropIndex', 'dropIndexes', 'getIndexes', 'stats', 'renameCollection',
])

const MONGODB_CONSTRUCTORS = new Set([
  'db', 'ObjectId', 'ISODate', 'NumberInt', 'NumberLong', 'NumberDecimal', 'UUID',
  'Timestamp', 'Binary', 'Code', 'MinKey', 'MaxKey', 'RegExp', 'true', 'false', 'null',
])

const MSSQL_TSQL_LANG = StreamLanguage.define<BlockCommentParserState>({
  name: 'mssql',
  startState: () => ({ inBlockComment: false }),
  token(stream, state) {
    if (advanceBlockComment(stream, state)) return 'comment'
    if (stream.eatSpace()) return null
    if (stream.match(/^--.*/)) return 'comment'
    if (stream.match(/^\/\*/)) {
      if (!stream.match(/^.*?\*\//)) state.inBlockComment = true
      return 'comment'
    }
    if (stream.match(/^[Nn]?'/)) {
      readSqlBracketOrQuoted(stream, "'")
      return 'string'
    }
    if (stream.eat('[')) {
      readSqlBracketOrQuoted(stream, ']')
      return 'variableName'
    }
    if (stream.eat('"')) {
      readSqlBracketOrQuoted(stream, '"')
      return 'variableName'
    }
    if (stream.match(/^@@?[A-Za-z_][A-Za-z0-9_]*/)) return 'variableName'
    if (stream.match(/^\d+(?:\.\d+)?/)) return 'number'
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_$#]*/)) {
      const upper = stream.current().toUpperCase()
      if (MSSQL_KEYWORDS.has(upper)) return 'keyword'
      if (MSSQL_TYPES_AND_BUILTINS.has(upper)) return 'typeName'
      return 'propertyName'
    }
    if (stream.match(/^[+\-*/%=<>!&|^~]+/)) return 'operator'
    stream.next()
    return 'punctuation'
  },
})

interface OracleParserState extends BlockCommentParserState {
  oracleQuoteClose: string | null
}

const ORACLE_Q_CLOSE_DELIM: Record<string, string> = {
  '[': ']',
  '(': ')',
  '{': '}',
  '<': '>',
}

function advanceOracleQuote(
  stream: { pos: number; string: string; skipToEnd: () => void },
  state: OracleParserState
): boolean {
  if (!state.oracleQuoteClose) return false
  const rest = stream.string.slice(stream.pos)
  const idx = rest.indexOf(`${state.oracleQuoteClose}'`)
  if (idx >= 0) {
    stream.pos += idx + 2
    state.oracleQuoteClose = null
  } else {
    stream.skipToEnd()
  }
  return true
}

const ORACLE_PLSQL_LANG = StreamLanguage.define<OracleParserState>({
  name: 'oracle',
  startState: () => ({ inBlockComment: false, oracleQuoteClose: null }),
  token(stream, state) {
    if (advanceOracleQuote(stream, state)) return 'string'
    if (advanceBlockComment(stream, state)) return 'comment'
    if (stream.eatSpace()) return null
    if (stream.match(/^--.*/)) return 'comment'
    if (stream.match(/^\/\*/)) {
      if (!stream.match(/^.*?\*\//)) state.inBlockComment = true
      return 'comment'
    }
    const qMatch = stream.match(/^[Nn]?[Qq]'([^\s])/)
    if (Array.isArray(qMatch) && typeof qMatch[1] === 'string') {
      state.oracleQuoteClose = ORACLE_Q_CLOSE_DELIM[qMatch[1]] ?? qMatch[1]
      advanceOracleQuote(stream, state)
      return 'string'
    }
    if (stream.eat("'")) {
      readSqlBracketOrQuoted(stream, "'")
      return 'string'
    }
    if (stream.eat('"')) {
      readSqlBracketOrQuoted(stream, '"')
      return 'variableName'
    }
    if (stream.match(/^:[A-Za-z_][A-Za-z0-9_$#]*/)) return 'variableName'
    if (stream.sol() && stream.match(/^\/\s*$/)) return 'keyword'
    if (stream.match(/^\d+(?:\.\d+)?/)) return 'number'
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_$#]*/)) {
      const upper = stream.current().toUpperCase()
      if (ORACLE_KEYWORDS.has(upper)) return 'keyword'
      if (ORACLE_TYPES_AND_BUILTINS.has(upper)) return 'typeName'
      return 'propertyName'
    }
    if (stream.match(/^:=|=>|\|\||<>|!=|<=|>=|[+\-*/=<>]/)) return 'operator'
    stream.next()
    return 'punctuation'
  },
})

const MONGODB_MQL_LANG = StreamLanguage.define<BlockCommentParserState>({
  name: 'mongodb',
  startState: () => ({ inBlockComment: false }),
  token(stream, state) {
    if (advanceBlockComment(stream, state)) return 'comment'
    if (stream.eatSpace()) return null
    if (stream.match(/^\/\/.*/) || stream.match(/^--.*/)) return 'comment'
    if (stream.match(/^\/\*/)) {
      if (!stream.match(/^.*?\*\//)) state.inBlockComment = true
      return 'comment'
    }
    const ch = stream.peek()
    if (ch === '"' || ch === "'" || ch === '`') {
      stream.next()
      readEscapedString(stream, ch)
      const val = stream.current().slice(1, -1)
      return /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(val) ? 'keyword' : 'string'
    }
    if (stream.match(/^\$[A-Za-z_][A-Za-z0-9_]*/)) return 'keyword'
    if (stream.match(/^-?\d+(?:\.\d+)?/)) return 'number'
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const word = stream.current()
      if (word === 'true' || word === 'false') return 'bool'
      if (word === 'null') return 'null'
      if (MONGODB_METHODS.has(word)) return 'keyword'
      if (MONGODB_CONSTRUCTORS.has(word)) return 'typeName'
      return 'propertyName'
    }
    if (stream.match(/^[+\-*/%=<>!&|?:]+/)) return 'operator'
    stream.next()
    return 'punctuation'
  },
})

const OLED_HIGHLIGHT_STYLE = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword, tags.definitionKeyword],
    color: 'var(--cm-keyword, #c7a8ff)',
    fontWeight: '500',
  },
  {
    tag: [tags.string, tags.special(tags.string)],
    color: 'var(--cm-string, #9ee39e)',
  },
  {
    tag: [tags.number, tags.integer, tags.float, tags.bool],
    color: 'var(--cm-number, #ffb070)',
  },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.standard(tags.name),
    ],
    color: 'var(--cm-function, #7cc4ff)',
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace],
    color: 'var(--cm-type, #6fe0d0)',
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: 'var(--cm-comment, #8c8c8c)',
    fontStyle: 'italic',
  },
  {
    tag: [tags.operator, tags.punctuation],
    color: 'var(--cm-operator, #d4d4d4)',
  },
  {
    tag: [tags.variableName, tags.propertyName],
    color: 'var(--text, #e6e6e6)',
  },
  {
    tag: tags.null,
    color: 'var(--cm-number, #ffb070)',
    fontStyle: 'italic',
  },
])

/**
 * Extracts only highlighted SQL selection when available, or full text otherwise (F15-05).
 */
export function extractExecutableSql(state: ExecutableStateLike): string {
  const selection = state.selection?.main
  if (selection && !selection.empty) {
    return state.sliceDoc(selection.from, selection.to).trim()
  }
  return state.doc.toString().trim()
}

/**
 * Extracts highlighted SQL selection when available, or the statement enclosing/preceding the caret.
 */
export function extractCaretStatementSql(
  target: EditorView | ExecutableStateLike,
  dialect?: SqlDialectType
): string {
  const state = 'state' in target ? target.state : target
  const selection = state.selection?.main
  if (selection && !selection.empty) {
    return state.sliceDoc(selection.from, selection.to).trim()
  }
  const fullText = state.doc.toString()
  const offset = selection?.head ?? selection?.from ?? 0
  return findStatementAtOffset(fullText, offset, dialect).trim()
}

/**
 * Resolves the exact document range `{ from, to, sql, originalSlice }` targeted by execution.
 * Uses selection when non-empty (for caret/explain), full doc for `'all'` or redis, or statement span at caret.
 */
export function extractExecutionRange(
  target: EditorView | ExecutableStateLike,
  mode: 'caret' | 'all' | 'explain' = 'caret',
  dialect?: SqlDialectType
): SqlExecutionRange | null {
  const state = 'state' in target ? target.state : target
  return resolveSqlExecutionSpan(state.doc.toString(), state.selection?.main, mode, dialect)
}

/**
 * Replaces a targeted SQL span in a single undoable CodeMirror transaction (Ctrl+Z restores original).
 * Never silently overwrites unrelated statements in a multi-statement script when target no longer matches.
 */
export function replaceEditorSqlRange(
  view: EditorView,
  target: SqlReplaceTarget | null,
  nextSql: string,
  dialect: SqlDialectType = 'sqlite'
): boolean {
  const edit = resolveSqlReplacementSpan(view.state.doc.toString(), target, nextSql, dialect)
  if (!edit) return false

  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: { anchor: edit.from + edit.insert.length },
    effects: clearGhostEffect.of(undefined),
  })
  view.focus()
  return true
}

/**
 * Resolves the CodeMirror SQL dialect extension from a database driver name.
 */
export function resolveSqlDialect(dialect: SqlDialectType = 'sqlite'): SQLDialect {
  switch (dialect) {
    case 'postgres':
    case 'cockroachdb':
    case 'oracle':
      return PostgreSQL
    case 'mysql':
    case 'clickhouse':
      return MySQL
    case 'mariadb':
      return MariaSQL
    case 'sqlite':
    case 'libsql':
    case 'd1':
    case 'mssql':
    case 'redis':
    case 'mongodb':
    default:
      return SQLite
  }
}

export function buildLanguageExtension(dialect: SqlDialectType): Extension {
  switch (dialect) {
    case 'redis':
      return new LanguageSupport(REDIS_MONOCHROME_LANG)
    case 'mongodb':
      return new LanguageSupport(MONGODB_MQL_LANG)
    case 'mssql':
      return new LanguageSupport(MSSQL_TSQL_LANG)
    case 'oracle':
      return new LanguageSupport(ORACLE_PLSQL_LANG)
    default:
      return sql({ dialect: resolveSqlDialect(dialect) })
  }
}

export interface SmartSqlCompletionItem {
  label: string
  type: 'keyword' | 'class' | 'property' | 'function' | 'text'
  detail?: string
  boost?: number
  apply?: string
}

const SQL_KEYWORD_COMPLETIONS: ReadonlyArray<{ label: string; detail: string; boost: number }> = [
  { label: 'SELECT', detail: 'SQL clause', boost: 40 },
  { label: 'SELECT * FROM ', detail: 'SQL snippet', boost: 45 },
  { label: 'FROM', detail: 'SQL clause', boost: 42 },
  { label: 'WHERE', detail: 'SQL clause', boost: 42 },
  { label: 'ORDER BY', detail: 'SQL clause', boost: 40 },
  { label: 'GROUP BY', detail: 'SQL clause', boost: 38 },
  { label: 'LIMIT', detail: 'SQL clause', boost: 40 },
  { label: 'OFFSET', detail: 'SQL clause', boost: 35 },
  { label: 'HAVING', detail: 'SQL clause', boost: 34 },
  { label: 'LEFT JOIN', detail: 'SQL join', boost: 36 },
  { label: 'INNER JOIN', detail: 'SQL join', boost: 36 },
  { label: 'INSERT INTO', detail: 'SQL DML', boost: 34 },
  { label: 'VALUES', detail: 'SQL DML', boost: 32 },
  { label: 'UPDATE', detail: 'SQL DML', boost: 34 },
  { label: 'SET', detail: 'SQL DML', boost: 34 },
  { label: 'DELETE FROM', detail: 'SQL DML', boost: 32 },
  { label: 'DISTINCT', detail: 'SQL keyword', boost: 30 },
  { label: 'AND', detail: 'SQL operator', boost: 35 },
  { label: 'OR', detail: 'SQL operator', boost: 34 },
  { label: 'NOT', detail: 'SQL operator', boost: 30 },
  { label: 'IS NULL', detail: 'SQL predicate', boost: 34 },
  { label: 'IS NOT NULL', detail: 'SQL predicate', boost: 35 },
  { label: 'LIKE', detail: 'SQL predicate', boost: 34 },
  { label: 'IN', detail: 'SQL predicate', boost: 33 },
  { label: 'BETWEEN', detail: 'SQL predicate', boost: 32 },
  { label: 'ASC', detail: 'sort order', boost: 35 },
  { label: 'DESC', detail: 'sort order', boost: 36 },
  { label: 'COUNT(*)', detail: 'aggregate', boost: 38 },
  { label: 'SUM()', detail: 'aggregate', boost: 34 },
  { label: 'AVG()', detail: 'aggregate', boost: 34 },
  { label: 'MIN()', detail: 'aggregate', boost: 34 },
  { label: 'MAX()', detail: 'aggregate', boost: 34 },
  { label: 'COALESCE()', detail: 'scalar fn', boost: 32 },
]

const REDIS_COMMAND_COMPLETIONS: ReadonlyArray<{ label: string; detail: string; boost: number }> = [
  { label: 'SCAN 0 MATCH * COUNT 50', detail: 'cursor scan', boost: 95 },
  { label: 'GET', detail: 'string read', boost: 90 },
  { label: 'SET', detail: 'string write', boost: 85 },
  { label: 'HGETALL', detail: 'hash read', boost: 88 },
  { label: 'HGET', detail: 'hash field', boost: 84 },
  { label: 'HSET', detail: 'hash write', boost: 82 },
  { label: 'LRANGE', detail: 'list read', boost: 84 },
  { label: 'LPUSH', detail: 'list write', boost: 80 },
  { label: 'SMEMBERS', detail: 'set read', boost: 84 },
  { label: 'SADD', detail: 'set write', boost: 80 },
  { label: 'ZRANGE', detail: 'zset read', boost: 84 },
  { label: 'TTL', detail: 'key expiry', boost: 82 },
  { label: 'TYPE', detail: 'key type', boost: 82 },
  { label: 'DEL', detail: 'key delete', boost: 75 },
  { label: 'KEYS *', detail: 'key pattern', boost: 78 },
  { label: 'INFO', detail: 'server info', boost: 76 },
  { label: 'DBSIZE', detail: 'key count', boost: 76 },
]

const MSSQL_EXTRA_COMPLETIONS: ReadonlyArray<{ label: string; detail: string; boost: number }> = [
  { label: 'TOP 100', detail: 'T-SQL limit', boost: 46 },
  { label: 'OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY', detail: 'T-SQL paging', boost: 40 },
  { label: 'WITH (NOLOCK)', detail: 'T-SQL hint', boost: 34 },
  { label: 'CROSS APPLY', detail: 'T-SQL join', boost: 36 },
  { label: 'GETDATE()', detail: 'scalar fn', boost: 38 },
  { label: 'SYSDATETIME()', detail: 'scalar fn', boost: 34 },
  { label: 'NEWID()', detail: 'scalar fn', boost: 34 },
  { label: 'ISNULL()', detail: 'scalar fn', boost: 38 },
  { label: 'TRY_CAST()', detail: 'scalar fn', boost: 34 },
  { label: 'STRING_AGG()', detail: 'aggregate', boost: 34 },
  { label: 'EXEC', detail: 'T-SQL exec', boost: 32 },
]

const ORACLE_EXTRA_COMPLETIONS: ReadonlyArray<{ label: string; detail: string; boost: number }> = [
  { label: 'FETCH FIRST 100 ROWS ONLY', detail: 'Oracle paging', boost: 44 },
  { label: 'DUAL', detail: 'Oracle table', boost: 40 },
  { label: 'ROWNUM', detail: 'Oracle pseudo', boost: 38 },
  { label: 'CONNECT BY PRIOR', detail: 'Oracle tree', boost: 34 },
  { label: 'SYSDATE', detail: 'Oracle date', boost: 40 },
  { label: 'SYSTIMESTAMP', detail: 'Oracle time', boost: 36 },
  { label: 'NVL()', detail: 'scalar fn', boost: 40 },
  { label: 'NVL2()', detail: 'scalar fn', boost: 36 },
  { label: 'DECODE()', detail: 'scalar fn', boost: 36 },
  { label: 'TO_DATE()', detail: 'scalar fn', boost: 36 },
  { label: 'TO_CHAR()', detail: 'scalar fn', boost: 36 },
  { label: 'LISTAGG()', detail: 'aggregate', boost: 34 },
  { label: 'EXPLAIN PLAN FOR', detail: 'Oracle plan', boost: 34 },
]

const MONGODB_COMPLETIONS: ReadonlyArray<SmartSqlCompletionItem> = [
  { label: 'db.getCollection("")', type: 'function', detail: 'MQL collection', boost: 95 },
  { label: 'find({})', type: 'function', detail: 'MQL query', boost: 94 },
  { label: 'findOne({})', type: 'function', detail: 'MQL query', boost: 92 },
  { label: 'aggregate([])', type: 'function', detail: 'MQL pipeline', boost: 93 },
  { label: 'countDocuments({})', type: 'function', detail: 'MQL count', boost: 90 },
  { label: 'distinct("")', type: 'function', detail: 'MQL distinct', boost: 86 },
  { label: 'insertOne({})', type: 'function', detail: 'MQL write', boost: 85 },
  { label: 'insertMany([])', type: 'function', detail: 'MQL write', boost: 83 },
  { label: 'updateOne({}, { $set: {} })', type: 'function', detail: 'MQL write', boost: 85 },
  { label: 'updateMany({}, { $set: {} })', type: 'function', detail: 'MQL write', boost: 83 },
  { label: 'deleteOne({})', type: 'function', detail: 'MQL delete', boost: 84 },
  { label: 'deleteMany({})', type: 'function', detail: 'MQL delete', boost: 80 },
  { label: 'explain("queryPlanner")', type: 'function', detail: 'MQL explain', boost: 86 },
  { label: '$match', type: 'keyword', detail: 'MQL stage', boost: 92 },
  { label: '$group', type: 'keyword', detail: 'MQL stage', boost: 91 },
  { label: '$project', type: 'keyword', detail: 'MQL stage', boost: 90 },
  { label: '$lookup', type: 'keyword', detail: 'MQL stage', boost: 89 },
  { label: '$unwind', type: 'keyword', detail: 'MQL stage', boost: 88 },
  { label: '$sort', type: 'keyword', detail: 'MQL stage', boost: 88 },
  { label: '$limit', type: 'keyword', detail: 'MQL stage', boost: 87 },
  { label: '$skip', type: 'keyword', detail: 'MQL stage', boost: 85 },
  { label: '$addFields', type: 'keyword', detail: 'MQL stage', boost: 84 },
  { label: '$set', type: 'keyword', detail: 'MQL operator', boost: 88 },
  { label: '$eq', type: 'keyword', detail: 'MQL operator', boost: 86 },
  { label: '$ne', type: 'keyword', detail: 'MQL operator', boost: 85 },
  { label: '$gt', type: 'keyword', detail: 'MQL operator', boost: 86 },
  { label: '$gte', type: 'keyword', detail: 'MQL operator', boost: 85 },
  { label: '$lt', type: 'keyword', detail: 'MQL operator', boost: 85 },
  { label: '$lte', type: 'keyword', detail: 'MQL operator', boost: 84 },
  { label: '$in', type: 'keyword', detail: 'MQL operator', boost: 86 },
  { label: '$nin', type: 'keyword', detail: 'MQL operator', boost: 84 },
  { label: '$and', type: 'keyword', detail: 'MQL operator', boost: 85 },
  { label: '$or', type: 'keyword', detail: 'MQL operator', boost: 85 },
  { label: '$exists', type: 'keyword', detail: 'MQL operator', boost: 84 },
  { label: '$regex', type: 'keyword', detail: 'MQL operator', boost: 84 },
  { label: 'ObjectId()', type: 'function', detail: 'BSON helper', boost: 89 },
  { label: 'ISODate()', type: 'function', detail: 'BSON helper', boost: 88 },
]

function computeMongoCompletions(
  before: string,
  safePos: number,
  schema: Record<string, string[]>,
  explicit: boolean
): { from: number; options: SmartSqlCompletionItem[] } | null {
  const dbDotMatch = /\bdb\.([A-Za-z0-9_$-]*)$/.exec(before)
  if (dbDotMatch) {
    const prefix = dbDotMatch[1].toLowerCase()
    const from = safePos - dbDotMatch[1].length
    const options: SmartSqlCompletionItem[] = []
    if (!prefix || 'getcollection'.includes(prefix)) {
      options.push({
        label: 'getCollection',
        apply: 'getCollection("")',
        type: 'function',
        detail: 'MongoDB collection',
        boost: 99,
      })
    }
    for (const colName of Object.keys(schema)) {
      if (!prefix || colName.toLowerCase().includes(prefix)) {
        options.push({
          label: colName,
          type: 'class',
          detail: 'collection',
          boost: colName.toLowerCase().startsWith(prefix) ? 95 : 84,
        })
      }
    }
    return options.length > 0 ? { from, options } : null
  }

  const colMethodMatch =
    /\bdb\.(?:getCollection\(\s*["'][^"']+["']\s*\)|[A-Za-z_][A-Za-z0-9_$-]*)\.([A-Za-z0-9_]*)$/.exec(
      before
    )
  if (colMethodMatch) {
    const prefix = colMethodMatch[1].toLowerCase()
    const from = safePos - colMethodMatch[1].length
    const options = MONGODB_COMPLETIONS.filter(
      (item) =>
        item.type === 'function' &&
        !item.label.startsWith('db.') &&
        !item.label.startsWith('ObjectId') &&
        !item.label.startsWith('ISODate') &&
        (!prefix || item.label.toLowerCase().includes(prefix))
    )
    return options.length > 0 ? { from, options } : null
  }

  const wordMatch = /\$?[A-Za-z0-9_]*$/.exec(before)
  const word = wordMatch ? wordMatch[0] : ''
  const lowerWord = word.toLowerCase()
  const from = safePos - word.length
  if (!word && !explicit) return null

  const options: SmartSqlCompletionItem[] = []
  const seen = new Set<string>()
  for (const colName of Object.keys(schema)) {
    if (!lowerWord || colName.toLowerCase().includes(lowerWord)) {
      seen.add(colName)
      options.push({
        label: colName,
        type: 'class',
        detail: 'collection',
        boost: colName.toLowerCase().startsWith(lowerWord) ? 94 : 80,
      })
    }
    for (const field of schema[colName] || []) {
      if (!seen.has(field) && (!lowerWord || field.toLowerCase().includes(lowerWord))) {
        seen.add(field)
        options.push({
          label: field,
          type: 'property',
          detail: `${colName} field`,
          boost: field.toLowerCase().startsWith(lowerWord) ? 88 : 74,
        })
      }
    }
  }
  for (const item of MONGODB_COMPLETIONS) {
    if (!lowerWord || item.label.toLowerCase().includes(lowerWord)) {
      options.push({
        ...item,
        boost: item.label.toLowerCase().startsWith(lowerWord)
          ? item.boost ?? 85
          : (item.boost ?? 85) - 10,
      })
    }
  }
  return options.length > 0 ? { from, options } : null
}

export function computeSmartSqlCompletions(
  docText: string,
  pos: number,
  dialect: SqlDialectType,
  schema: Record<string, string[]>,
  defaultTable?: string,
  explicit = false
): { from: number; options: SmartSqlCompletionItem[] } | null {
  const safePos = Math.max(0, Math.min(pos, docText.length))
  const before = docText.slice(0, safePos)

  if (dialect === 'mongodb') {
    return computeMongoCompletions(before, safePos, schema, explicit)
  }

  // Check for dot-qualified completion: `tableOrAlias.colPrefix`
  const dotMatch = /([A-Za-z0-9_"`[\]]+)\.([A-Za-z0-9_]*)$/.exec(before)
  if (dotMatch) {
    const rawQualifier = dotMatch[1].replace(/^["`[]|["`\]]$/g, '')
    const prefix = dotMatch[2]
    const from = safePos - prefix.length
    const stmtText = findStatementAtOffset(docText, safePos, dialect) || docText

    // Resolve alias from `FROM table [AS] alias` or `JOIN table [AS] alias`
    let resolvedTable = Object.keys(schema).find(
      (t) => t.toLowerCase() === rawQualifier.toLowerCase()
    )
    if (!resolvedTable) {
      const aliasRegex =
        /\b(?:FROM|JOIN|UPDATE|INTO)\s+["`[]?([A-Za-z0-9_]+)["`\]]?(?:\s+AS)?\s+["`[]?([A-Za-z0-9_]+)["`\]]?/gi
      let m: RegExpExecArray | null
      while ((m = aliasRegex.exec(stmtText)) !== null) {
        const rawTbl = m[1]
        const rawAlias = m[2]
        if (rawTbl && rawAlias && rawAlias.toLowerCase() === rawQualifier.toLowerCase()) {
          const found = Object.keys(schema).find((t) => t.toLowerCase() === rawTbl.toLowerCase())
          if (found) {
            resolvedTable = found
            break
          }
        }
      }
    }

    if (resolvedTable && Array.isArray(schema[resolvedTable])) {
      const lowerPrefix = prefix.toLowerCase()
      const options: SmartSqlCompletionItem[] = schema[resolvedTable]
        .filter((col) => !lowerPrefix || col.toLowerCase().includes(lowerPrefix))
        .map((col) => ({
          label: col,
          type: 'property',
          detail: `${resolvedTable} col`,
          boost: col.toLowerCase().startsWith(lowerPrefix) ? 99 : 88,
        }))
      return options.length > 0 ? { from, options } : null
    }
  }

  const wordMatch = /[A-Za-z0-9_]*$/.exec(before)
  const word = wordMatch ? wordMatch[0] : ''
  const from = safePos - word.length
  const lowerWord = word.toLowerCase()

  if (dialect === 'redis') {
    if (!word) return null
    const options: SmartSqlCompletionItem[] = REDIS_COMMAND_COMPLETIONS.filter((item) =>
      item.label.toLowerCase().includes(lowerWord)
    ).map((item) => ({
      label: item.label,
      type: 'keyword',
      detail: item.detail,
      boost: item.boost,
    }))
    return options.length > 0 ? { from, options } : null
  }

  const textBeforeWord = before.slice(0, from).trimEnd()
  const prevTokenMatch = /([A-Za-z0-9_]+)\s*$/.exec(textBeforeWord)
  const prevToken = prevTokenMatch ? prevTokenMatch[1].toUpperCase() : ''

  const isTableContext =
    prevToken === 'FROM' ||
    prevToken === 'JOIN' ||
    prevToken === 'UPDATE' ||
    prevToken === 'INTO' ||
    prevToken === 'TABLE' ||
    prevToken === 'DESCRIBE'

  if (!word && !isTableContext && !explicit) {
    return null
  }

  const stmtText = findStatementAtOffset(docText, safePos, dialect) || docText
  const referencedTables = new Set<string>()
  const tableRefRegex = /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:["`[]?[A-Za-z0-9_]+["`\]]?\.)?["`[]?([A-Za-z0-9_]+)["`\]]?/gi
  let refMatch: RegExpExecArray | null
  while ((refMatch = tableRefRegex.exec(stmtText)) !== null) {
    const rawRef = refMatch[1]
    if (rawRef) {
      const matchedName = Object.keys(schema).find(
        (t) => t.toLowerCase() === rawRef.toLowerCase()
      )
      if (matchedName) referencedTables.add(matchedName)
    }
  }
  if (referencedTables.size === 0 && defaultTable && schema[defaultTable]) {
    referencedTables.add(defaultTable)
  }

  const options: SmartSqlCompletionItem[] = []
  const seenLabels = new Set<string>()

  const matchesWord = (candidate: string): { ok: boolean; starts: boolean } => {
    if (!lowerWord) return { ok: true, starts: true }
    const lc = candidate.toLowerCase()
    if (lc.startsWith(lowerWord)) return { ok: true, starts: true }
    if (lc.includes(lowerWord)) return { ok: true, starts: false }
    return { ok: false, starts: false }
  }

  // 1. Table names (boosted to top after FROM / JOIN / UPDATE / INTO)
  for (const tableName of Object.keys(schema)) {
    const tblKey = `tbl:${tableName.toLowerCase()}`
    if (seenLabels.has(tblKey)) continue
    const m = matchesWord(tableName)
    if (!m.ok) continue
    const colCount = schema[tableName]?.length ?? 0
    const baseBoost = isTableContext ? 98 : 68
    options.push({
      label: tableName,
      type: 'class',
      detail: colCount > 0 ? `table (${colCount} cols)` : 'table',
      boost: m.starts ? baseBoost : baseBoost - 12,
    })
    seenLabels.add(tblKey)
  }

  if (dialect === 'oracle' && !seenLabels.has('tbl:dual')) {
    const dualMatch = matchesWord('DUAL')
    if (dualMatch.ok) {
      const baseBoost = isTableContext ? 95 : 64
      options.push({
        label: 'DUAL',
        type: 'class',
        detail: 'Oracle table',
        boost: dualMatch.starts ? baseBoost : baseBoost - 12,
      })
      seenLabels.add('tbl:dual')
    }
  }

  // 2. Column names (prioritize referenced tables in current query, then defaultTable, then other schema tables)
  if (!isTableContext) {
    const orderedTables = [
      ...Array.from(referencedTables),
      ...Object.keys(schema).filter((t) => !referencedTables.has(t)),
    ]
    for (const tableName of orderedTables) {
      const cols = schema[tableName] || []
      const isPrimaryTable = referencedTables.has(tableName)
      for (const col of cols) {
        const m = matchesWord(col)
        if (!m.ok) continue
        const colKey = `col:${col.toLowerCase()}`
        if (!seenLabels.has(colKey)) {
          seenLabels.add(colKey)
          const baseBoost = isPrimaryTable ? 94 : 62
          options.push({
            label: col,
            type: 'property',
            detail: isPrimaryTable ? `${tableName} col` : `col (${tableName})`,
            boost: m.starts ? baseBoost : baseBoost - 10,
          })
        }
      }
    }
  }

  // 3. SQL Keywords, Clauses & Aggregate Functions
  if (!isTableContext && lowerWord.length > 0) {
    const isLowerInput = word === word.toLowerCase() && word !== word.toUpperCase()
    const dialectExtras =
      dialect === 'mssql'
        ? MSSQL_EXTRA_COMPLETIONS
        : dialect === 'oracle'
          ? ORACLE_EXTRA_COMPLETIONS
          : []
    for (const kw of [...SQL_KEYWORD_COMPLETIONS, ...dialectExtras]) {
      const m = matchesWord(kw.label)
      if (!m.ok) continue
      const isFunc = kw.detail === 'aggregate' || kw.detail === 'scalar fn'
      const applyText = isLowerInput && !isFunc ? kw.label.toLowerCase() : kw.label
      options.push({
        label: kw.label,
        apply: applyText,
        type: isFunc ? 'function' : kw.detail === 'Oracle table' ? 'class' : 'keyword',
        detail: kw.detail,
        boost: m.starts ? kw.boost : kw.boost - 12,
      })
    }
  }

  return options.length > 0 ? { from, options } : null
}

function resolveCompletionFacetData(dialect: SqlDialectType) {
  switch (dialect) {
    case 'redis':
      return REDIS_MONOCHROME_LANG.data
    case 'mongodb':
      return MONGODB_MQL_LANG.data
    case 'mssql':
      return MSSQL_TSQL_LANG.data
    case 'oracle':
      return ORACLE_PLSQL_LANG.data
    default:
      return resolveSqlDialect(dialect).language.data
  }
}

export function buildCompletionExtension(
  dialect: SqlDialectType,
  schema: Record<string, string[]>,
  defaultTable?: string
): Extension {
  const smartSource = (context: {
    state: { doc: { toString: () => string } }
    pos: number
    explicit?: boolean
  }) => {
    const docText = context.state.doc.toString()
    const computed = computeSmartSqlCompletions(
      docText,
      context.pos,
      dialect,
      schema,
      defaultTable,
      Boolean(context.explicit)
    )
    if (!computed) return null
    return {
      from: computed.from,
      options: computed.options,
      validFor: /^[$A-Za-z0-9_]*$/,
    }
  }

  return [
    autocompletion({
      override: [smartSource],
      activateOnTyping: true,
      maxRenderedOptions: 40,
    }),
    resolveCompletionFacetData(dialect).of({
      autocomplete: smartSource,
    }),
  ]
}

function buildTypographyExtension(typography: EditorTypography = {}): Extension {
  const fontFamily =
    typography.cssFontFamily ||
    typography.fontFamily ||
    "var(--mono-font, 'SF Mono', SFMono-Regular, ui-monospace, 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', monospace)"
  const fontSize =
    typeof typography.fontSize === 'number' &&
    Number.isFinite(typography.fontSize) &&
    typography.fontSize > 0
      ? typography.fontSize
      : 12.5
  const lineHeightValue =
    typeof typography.lineHeight === 'number' &&
    Number.isFinite(typography.lineHeight) &&
    typography.lineHeight > 0
      ? typography.lineHeight > 4
        ? `${typography.lineHeight}px`
        : String(typography.lineHeight)
      : '1.5'
  const fontWeight = typography.fontWeight || '400'
  const ligatures = typography.fontLigatures === false ? 'none' : 'normal'

  return EditorView.theme({
    '&': {
      fontSize: `${fontSize}px`,
    },
    '.cm-content': {
      fontFamily,
      fontWeight,
      lineHeight: lineHeightValue,
      fontVariantLigatures: ligatures,
    },
    '.cm-gutters': {
      fontFamily,
      fontSize: `${Math.max(12, Math.round(fontSize) - 1)}px`,
    },
  })
}

function buildEditorThemeExtension(isDark: boolean): Extension {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        width: '100%',
        maxWidth: '100%',
        backgroundColor: 'var(--bg, var(--orca-background, #000000))',
        color: 'var(--text, var(--orca-foreground, #e6e6e6))',
      },
      '.cm-scroller': {
        overflow: 'auto',
      },
      '.cm-content': {
        caretColor: 'var(--primary, var(--orca-primary, #e6e6e6))',
        padding: '6px 0',
      },
      '.cm-activeLine': {
        backgroundColor: 'color-mix(in srgb, var(--text, #e6e6e6) 5%, transparent)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'color-mix(in srgb, var(--text, #e6e6e6) 8%, transparent)',
        color: 'var(--text, #e6e6e6)',
      },
      '&.cm-focused .cm-cursor': {
        borderLeftColor: 'var(--primary, var(--orca-primary, #e6e6e6))',
      },
      '.cm-selectionBackground': {
        backgroundColor: 'color-mix(in srgb, var(--accent-ring, var(--primary, #e6e6e6)) 16%, transparent)',
      },
      '&.cm-focused .cm-selectionBackground, ::selection': {
        backgroundColor: 'color-mix(in srgb, var(--accent-ring, var(--primary, #e6e6e6)) 24%, transparent)',
      },
      '.cm-gutters': {
        backgroundColor:
          'var(--surface, color-mix(in srgb, var(--orca-foreground, #e6e6e6) 3.5%, var(--orca-background, #000000)))',
        color: 'var(--muted-dim, #8c8c8c)',
        borderRight: '1px solid var(--border, var(--orca-border, #1f1f1f))',
      },
      '.cm-tooltip': {
        backgroundColor:
          'var(--popover, var(--orca-popover, color-mix(in srgb, var(--orca-foreground, #e6e6e6) 8%, var(--orca-background, #000000))))',
        border: '1px solid var(--border-strong, #2a2a2a)',
        borderRadius: 'var(--radius, 6px)',
        boxShadow: 'var(--menu-shadow, 0 8px 24px rgba(0, 0, 0, 0.56))',
        color: 'var(--text, #e6e6e6)',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul': {
        fontFamily: 'var(--mono-font, monospace)',
        fontSize: '12px',
        padding: '4px',
        maxHeight: '240px',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
        padding: '4px 8px',
        borderRadius: '4px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor:
          'color-mix(in srgb, var(--accent-ring, var(--primary, #e6e6e6)) 18%, var(--popover, var(--orca-popover, var(--bg, #000000))))',
        color: 'var(--text, #e6e6e6)',
      },
      '.cm-completionMatchedText': {
        color: 'var(--accent-ring, var(--primary, #e6e6e6))',
        fontWeight: '600',
        textDecoration: 'none',
      },
      '.cm-completionDetail': {
        marginLeft: 'auto',
        color: 'var(--muted, #a3a3a3)',
        fontStyle: 'normal',
        fontSize: '12px',
      },
      '.cm-ai-replace-strike': {
        textDecoration: 'line-through',
        textDecorationColor: isDark
          ? 'rgba(248, 113, 113, 0.78)'
          : 'rgba(220, 38, 38, 0.78)',
        textDecorationThickness: '1.4px',
        opacity: '0.58',
      },
      '.cm-ai-diff-insert': {
        color: isDark ? 'rgba(74, 222, 128, 0.92)' : '#15803d',
        backgroundColor: isDark ? 'rgba(34, 197, 94, 0.14)' : 'rgba(22, 163, 74, 0.12)',
        borderRadius: '3px',
        padding: '0 2px',
        marginLeft: '2px',
        whiteSpace: 'pre',
        pointerEvents: 'none',
        userSelect: 'none',
      },
      '.cm-sql-diag-error': {
        textDecorationLine: 'underline',
        textDecorationStyle: 'wavy',
        textDecorationColor: isDark
          ? 'rgba(248, 113, 113, 0.72)'
          : 'rgba(220, 38, 38, 0.75)',
        textUnderlineOffset: '3px',
        textDecorationThickness: '1.25px',
      },
      '.cm-sql-diag-warn': {
        textDecorationLine: 'underline',
        textDecorationStyle: 'wavy',
        textDecorationColor: isDark
          ? 'rgba(251, 191, 36, 0.72)'
          : 'rgba(217, 119, 6, 0.75)',
        textUnderlineOffset: '3px',
        textDecorationThickness: '1.25px',
      },
      '.cm-sql-diag-tooltip': {
        fontSize: '11.5px',
        padding: '5px 8px',
        maxWidth: '340px',
        lineHeight: '1.4',
        whiteSpace: 'pre-wrap',
        color: 'var(--text, #e6e6e6)',
      },
    },
    { dark: isDark }
  )
}

export class SqlConsoleController {
  private view: EditorView | null = null
  private readonly langCompartment = new Compartment()
  private readonly completionCompartment = new Compartment()
  private readonly typographyCompartment = new Compartment()
  private readonly themeModeCompartment = new Compartment()
  private currentDialect: SqlDialectType
  private currentSchema: Record<string, string[]> = {}
  private currentDefaultTable?: string
  private currentTypography: EditorTypography = {}
  private isDarkTheme = true
  private readonly onExecute?: (sql: string) => void
  private readonly onExecuteAll?: (sql: string) => void
  private readonly onFormatSql?: () => void
  private readonly onChange?: (doc: string) => void
  private detachWheelScroll: (() => void) | null = null
  private readonly aiInline?: CmInlineAiOptions

  constructor(options: SqlConsoleOptions) {
    this.currentDialect = options.dialect || 'sqlite'
    this.currentSchema = options.schema || {}
    this.currentTypography = options.typography || {}
    this.isDarkTheme = !(
      typeof document !== 'undefined' &&
      (document.documentElement.classList.contains('light') ||
        document.body?.classList.contains('light'))
    )
    this.onExecute = options.onExecute
    this.onExecuteAll = options.onExecuteAll
    this.onFormatSql = options.onFormatSql
    this.onChange = options.onChange
    this.aiInline = options.aiInline

    this.initEditor(options.parent, options.initialDoc)
  }

  private initEditor(parent: HTMLElement, initialDoc = '-- Datanoa SQL Console\nSELECT 1;\n'): void {
    const executeAllKeyBinding = {
      key: 'Mod-Shift-Enter',
      run: (target: EditorView) => {
        const query = target.state.doc.toString().trim()
        if (this.onExecuteAll && query.length > 0) {
          this.onExecuteAll(query)
          return true
        }
        return false
      },
    }

    const executeKeyBinding = {
      key: 'Mod-Enter',
      run: (target: EditorView) => {
        const query = extractCaretStatementSql(target.state, this.currentDialect)
        if (this.onExecute && query.length > 0) {
          this.onExecute(query)
          return true
        }
        return false
      },
    }

    const formatSqlKeyBinding = {
      key: 'Shift-Alt-f',
      run: () => {
        if (this.onFormatSql) {
          this.onFormatSql()
          return true
        }
        return false
      },
    }

    const docChangeListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && this.onChange) {
        this.onChange(update.state.doc.toString())
      }
    })

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      syntaxHighlighting(OLED_HIGHLIGHT_STYLE),
      search({ top: true }),
      highlightSelectionMatches(),
      foldGutter(),
      codeFolding(),
      bracketMatching(),
      keymap.of([
        executeAllKeyBinding,
        executeKeyBinding,
        formatSqlKeyBinding,
        { key: 'Mod-h', run: openSearchPanel },
        ...completionKeymap,
        ...searchKeymap,
        ...foldKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      this.langCompartment.of(buildLanguageExtension(this.currentDialect)),
      this.completionCompartment.of(
        buildCompletionExtension(this.currentDialect, this.currentSchema, this.currentDefaultTable)
      ),
      this.typographyCompartment.of(buildTypographyExtension(this.currentTypography)),
      docChangeListener,
      this.themeModeCompartment.of(buildEditorThemeExtension(this.isDarkTheme)),
      createCmSqlLintExtension({ getDialect: () => this.currentDialect }),
      ...(this.aiInline
        ? [createCmInlineAiExtension({ ...this.aiInline, getDialect: () => this.currentDialect })]
        : []),
    ]

    const state = EditorState.create({
      doc: initialDoc,
      extensions,
    })

    this.view = new EditorView({
      state,
      parent,
    })
    this.detachWheelScroll = bindCtrlWheelHorizontalScroll(this.view.scrollDOM)
  }

  /**
   * Dynamically switches SQL dialect support across all 8 Datanoa engines (F15-04).
   */
  public setDialect(dialect: SqlDialectType): void {
    if (!this.view || this.currentDialect === dialect) return
    this.currentDialect = dialect

    this.view.dispatch({
      effects: [
        clearGhostEffect.of(undefined),
        clearDbSqlErrorEffect.of(undefined),
        this.langCompartment.reconfigure(buildLanguageExtension(dialect)),
        this.completionCompartment.reconfigure(
          buildCompletionExtension(dialect, this.currentSchema, this.currentDefaultTable)
        ),
        triggerSqlLintEffect.of(undefined),
      ],
    })
  }

  /**
   * Updates autocompletion schema options from introspected database schema (F15-02).
   */
  public updateSchema(schema: Record<string, string[]>, defaultTable?: string): void {
    if (!this.view) return
    this.currentSchema = schema
    if (defaultTable !== undefined) {
      this.currentDefaultTable = defaultTable
    }

    this.view.dispatch({
      effects: this.completionCompartment.reconfigure(
        buildCompletionExtension(this.currentDialect, this.currentSchema, this.currentDefaultTable)
      ),
    })
  }

  /**
   * Synchronizes CodeMirror dark/light theme facet with the active Orca host color scheme.
   */
  public setColorScheme(isLight: boolean): void {
    const nextDark = !isLight
    if (this.isDarkTheme === nextDark) return
    this.isDarkTheme = nextDark
    if (!this.view) return
    this.view.dispatch({
      effects: this.themeModeCompartment.reconfigure(buildEditorThemeExtension(this.isDarkTheme)),
    })
  }

  /**
   * Applies Orca Desktop typography settings dynamically to CodeMirror.
   */
  public applyTypography(typography: EditorTypography): void {
    this.currentTypography = { ...this.currentTypography, ...typography }
    if (!this.view) return
    this.view.dispatch({
      effects: this.typographyCompartment.reconfigure(
        buildTypographyExtension(this.currentTypography)
      ),
    })
  }

  /**
   * Returns current editor text.
   */
  public getText(): string {
    if (!this.view) return ''
    return this.view.state.doc.toString()
  }

  /**
   * Sets editor text.
   */
  public setText(text: string): void {
    if (!this.view) return
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
    })
  }

  /**
   * Inserts or appends SQL text cleanly at the end of the editor or replaces selection.
   */
  public insertText(text: string): void {
    if (!this.view) return
    const current = this.view.state.doc.toString()
    const sep = current.trim().length > 0 && !current.endsWith('\n') ? '\n\n' : current.trim().length > 0 ? '\n' : ''
    const insertPos = current.length
    this.view.dispatch({
      changes: { from: insertPos, to: insertPos, insert: `${sep}${text}\n` },
      selection: { anchor: insertPos + sep.length },
    })
    this.view.focus()
  }

  /**
   * Extracts query to execute: selected text if any, or whole document (F15-05).
   */
  public getExecutableSql(): string {
    if (!this.view) return ''
    return extractExecutableSql(this.view.state)
  }

  /**
   * Returns trimmed selected SQL if non-empty, otherwise ''.
   */
  public getSelectedSql(): string {
    if (!this.view) return ''
    const sel = this.view.state.selection.main
    if (sel.empty) return ''
    return this.view.state.sliceDoc(sel.from, sel.to).trim()
  }

  /**
   * Returns true when the editor currently has a non-empty text selection.
   */
  public hasSelection(): boolean {
    return this.getSelectedSql().length > 0
  }

  /**
   * Extracts selected text if any, or the single statement at the caret offset.
   */
  public getCaretStatementSql(dialect?: SqlDialectType): string {
    if (!this.view) return ''
    return extractCaretStatementSql(this.view.state, dialect ?? this.currentDialect)
  }

  /**
   * Resolves the exact document range targeted by execution (`caret`, `all`, or `explain`).
   */
  public getExecutionRange(
    mode: 'caret' | 'all' | 'explain' = 'caret',
    dialect?: SqlDialectType
  ): SqlExecutionRange | null {
    if (!this.view) return null
    return extractExecutionRange(this.view.state, mode, dialect ?? this.currentDialect)
  }

  /**
   * Replaces a targeted SQL range via a single undoable CodeMirror transaction.
   */
  public replaceSqlRange(
    target: SqlReplaceTarget | null,
    nextSql: string,
    dialect?: SqlDialectType
  ): boolean {
    if (!this.view) return false
    return replaceEditorSqlRange(this.view, target, nextSql, dialect ?? this.currentDialect)
  }

  /**
   * Returns the current caret offset, or 0 when the editor is unavailable.
   */
  public getCursorOffset(): number {
    return this.view ? this.view.state.selection.main.head : 0
  }

  /**
   * Restores the caret offset, clamped to the current document bounds.
   */
  public setCursorOffset(offset: number): void {
    if (!this.view) return
    const pos = Math.max(0, Math.min(this.view.state.doc.length, Math.trunc(offset)))
    this.view.dispatch({ selection: { anchor: pos } })
  }

  /**
   * Opens the CodeMirror Find & Replace panel (Ctrl+F / Ctrl+H) when the view is mounted.
   */
  public openFindReplace(): void {
    if (!this.view) return
    this.view.focus()
    openSearchPanel(this.view)
  }

  /**
   * Focuses the editor.
   */
  public focus(): void {
    this.view?.focus()
  }

  /**
   * Clears any visible inline AI ghost suggestion.
   */
  public clearAiGhost(): void {
    this.view?.dispatch({ effects: clearGhostEffect.of(undefined) })
  }

  /**
   * Overlays a live database syntax error underline on the offending SQL token/range.
   */
  public setDbSyntaxError(
    errorMessage: string,
    targetRange?: { from: number; to: number } | null,
    dialect?: SqlDialectType
  ): void {
    if (!this.view) return
    const clean = String(errorMessage || '').trim()
    if (!clean) {
      this.clearDbSyntaxError()
      return
    }
    this.view.dispatch({
      effects: setDbSqlErrorEffect.of({
        errorMessage: clean,
        targetRange: targetRange ?? null,
        dialect: dialect ?? this.currentDialect,
      }),
    })
  }

  /**
   * Clears any live database syntax error overlay from the editor.
   */
  public clearDbSyntaxError(): void {
    this.view?.dispatch({ effects: clearDbSqlErrorEffect.of(undefined) })
  }

  /**
   * Disposes the editor instance.
   */
  public destroy(): void {
    this.detachWheelScroll?.()
    this.detachWheelScroll = null
    this.view?.destroy()
    this.view = null
  }
}
