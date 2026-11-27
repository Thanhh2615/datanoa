// src/panel/panel-cm.js
// CodeMirror 6 wrapper for Datanoa Side Panel SQL Console reusing vendor/codemirror.js (zero duplicate bundle)

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
  placeholder,
} from '../../vendor/codemirror.js'
import { clearGhostEffect, createCmInlineAiExtension, notifyAiAvailabilityChanged } from '../shared-cm-inline-ai.js'
import {
  createCmKeymapExtension,
  getVimModeSnapshot,
  isModalKeymapActive,
  normalizeShortcutSettings,
} from '../shared-cm-keymap.js'
import {
  clearDbSqlErrorEffect,
  createCmSqlLintExtension,
  setDbSqlErrorEffect,
  triggerSqlLintEffect,
} from '../shared-cm-sql-lint.js'
import { findStatementAtOffset } from './panel-core.js'
import { resolveSqlExecutionSpan, resolveSqlReplacementSpan } from '../shared-sql-core.js'
import { computePanelSqlCompletions } from './panel-sql-tabs.js'
import { bindCtrlWheelHorizontalScroll } from '../shared-wheel-scroll.js'

export function extractPanelCaretStatementSql(state, activeDriver) {
  const sel = state?.selection?.main
  if (sel && !sel.empty) {
    return state.sliceDoc(sel.from, sel.to).trim()
  }
  const full = state.doc.toString()
  if (activeDriver === 'redis') return full.trim()
  const head = sel?.head ?? sel?.from ?? 0
  return findStatementAtOffset(full, head, activeDriver).trim()
}

export function extractPanelExecutionRange(state, mode = 'caret', activeDriver = 'sqlite') {
  return resolveSqlExecutionSpan(state.doc.toString(), state?.selection?.main, mode, activeDriver)
}

export function replacePanelSqlRange(view, target, nextSql, activeDriver = 'sqlite') {
  if (!view) return false
  const edit = resolveSqlReplacementSpan(view.state.doc.toString(), target, nextSql, activeDriver)
  if (!edit) return false

  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: { anchor: edit.from + edit.insert.length },
    effects: clearGhostEffect.of(undefined),
  })
  view.focus()
  return true
}

const REDIS_MONOCHROME_LANG = StreamLanguage.define({
  name: 'redis',
  token(stream) {
    stream.skipToEnd()
    return null
  },
})

function advancePanelBlockComment(stream, state) {
  if (!state.inBlockComment) return false
  if (stream.match(/^.*?\*\//)) {
    state.inBlockComment = false
  } else {
    stream.skipToEnd()
  }
  return true
}

function readPanelSqlDelimited(stream, closeChar) {
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

function readPanelEscapedString(stream, quoteChar) {
  while (!stream.eol()) {
    const ch = stream.next()
    if (ch === '\\') {
      stream.next()
      continue
    }
    if (ch === quoteChar) break
  }
}

const PANEL_MSSQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'MERGE', 'USING', 'MATCHED', 'OUTPUT', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL',
  'OUTER', 'CROSS', 'APPLY', 'ON', 'AS', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE',
  'BETWEEN', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'GROUP', 'BY', 'HAVING',
  'ORDER', 'ASC', 'DESC', 'OFFSET', 'FETCH', 'NEXT', 'ROWS', 'ONLY', 'TOP', 'PERCENT',
  'WITH', 'TIES', 'DISTINCT', 'UNION', 'ALL', 'OVER', 'PARTITION', 'CREATE', 'ALTER',
  'DROP', 'TRUNCATE', 'TABLE', 'VIEW', 'INDEX', 'PRIMARY', 'KEY', 'FOREIGN',
  'REFERENCES', 'DECLARE', 'BEGIN', 'TRY', 'CATCH', 'TRAN', 'TRANSACTION', 'COMMIT',
  'ROLLBACK', 'EXEC', 'EXECUTE', 'GO', 'NOLOCK',
])

const PANEL_MSSQL_TYPES = new Set([
  'INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'BIT', 'DECIMAL', 'NUMERIC', 'MONEY', 'FLOAT',
  'REAL', 'CHAR', 'VARCHAR', 'NVARCHAR', 'NCHAR', 'TEXT', 'DATE', 'DATETIME',
  'DATETIME2', 'DATETIMEOFFSET', 'TIME', 'UNIQUEIDENTIFIER', 'VARBINARY', 'XML', 'MAX',
  'GETDATE', 'GETUTCDATE', 'SYSDATETIME', 'NEWID', 'ISNULL', 'COALESCE', 'TRY_CAST',
  'TRY_CONVERT', 'CAST', 'CONVERT', 'DATEADD', 'DATEDIFF', 'STRING_AGG', 'COUNT',
  'SUM', 'AVG', 'MIN', 'MAX',
])

const PANEL_ORACLE_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'MERGE', 'USING', 'RETURNING', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER',
  'CROSS', 'ON', 'AS', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN',
  'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'ELSIF', 'END', 'GROUP', 'BY', 'HAVING',
  'ORDER', 'ASC', 'DESC', 'OFFSET', 'FETCH', 'FIRST', 'NEXT', 'ROWS', 'ONLY',
  'DISTINCT', 'UNION', 'ALL', 'INTERSECT', 'MINUS', 'CONNECT', 'PRIOR', 'START',
  'WITH', 'OVER', 'PARTITION', 'CREATE', 'REPLACE', 'ALTER', 'DROP', 'TRUNCATE',
  'TABLE', 'VIEW', 'MATERIALIZED', 'INDEX', 'SEQUENCE', 'SYNONYM', 'TRIGGER',
  'DECLARE', 'BEGIN', 'EXCEPTION', 'LOOP', 'IF', 'COMMIT', 'ROLLBACK', 'EXPLAIN',
  'PLAN', 'FOR', 'DUAL', 'ROWNUM', 'ROWID', 'LEVEL', 'PRIMARY', 'KEY', 'FOREIGN',
  'REFERENCES', 'PRAGMA',
])

const PANEL_ORACLE_TYPES = new Set([
  'NUMBER', 'BINARY_INTEGER', 'PLS_INTEGER', 'INTEGER', 'INT', 'FLOAT', 'VARCHAR2',
  'NVARCHAR2', 'VARCHAR', 'CHAR', 'NCHAR', 'CLOB', 'NCLOB', 'BLOB', 'RAW', 'DATE',
  'TIMESTAMP', 'INTERVAL', 'BOOLEAN', 'SYSDATE', 'SYSTIMESTAMP', 'NVL', 'NVL2',
  'DECODE', 'COALESCE', 'TO_DATE', 'TO_CHAR', 'TO_NUMBER', 'LISTAGG', 'SUBSTR',
  'INSTR', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'DBMS_XPLAN', 'DISPLAY',
])

const PANEL_MONGO_METHODS = new Set([
  'getCollection', 'find', 'findOne', 'aggregate', 'countDocuments',
  'estimatedDocumentCount', 'distinct', 'insertOne', 'insertMany', 'updateOne',
  'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate',
  'findOneAndDelete', 'bulkWrite', 'explain', 'sort', 'limit', 'skip', 'projection',
  'toArray', 'drop', 'dropDatabase', 'createCollection', 'createIndex', 'dropIndex',
  'getIndexes', 'stats',
])

const PANEL_MONGO_TYPES = new Set([
  'db', 'ObjectId', 'ISODate', 'NumberInt', 'NumberLong', 'NumberDecimal', 'UUID',
  'Timestamp', 'Binary', 'MinKey', 'MaxKey', 'RegExp',
])

const MSSQL_TSQL_LANG = StreamLanguage.define({
  name: 'mssql',
  startState: () => ({ inBlockComment: false }),
  token(stream, state) {
    if (advancePanelBlockComment(stream, state)) return 'comment'
    if (stream.eatSpace()) return null
    if (stream.match(/^--.*/)) return 'comment'
    if (stream.match(/^\/\*/)) {
      if (!stream.match(/^.*?\*\//)) state.inBlockComment = true
      return 'comment'
    }
    if (stream.match(/^[Nn]?'/)) {
      readPanelSqlDelimited(stream, "'")
      return 'string'
    }
    if (stream.eat('[')) {
      readPanelSqlDelimited(stream, ']')
      return 'variableName'
    }
    if (stream.eat('"')) {
      readPanelSqlDelimited(stream, '"')
      return 'variableName'
    }
    if (stream.match(/^@@?[A-Za-z_][A-Za-z0-9_]*/)) return 'variableName'
    if (stream.match(/^\d+(?:\.\d+)?/)) return 'number'
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_$#]*/)) {
      const upper = stream.current().toUpperCase()
      if (PANEL_MSSQL_KEYWORDS.has(upper)) return 'keyword'
      if (PANEL_MSSQL_TYPES.has(upper)) return 'typeName'
      return 'propertyName'
    }
    if (stream.match(/^[+\-*/%=<>!&|^~]+/)) return 'operator'
    stream.next()
    return 'punctuation'
  },
})

const PANEL_ORACLE_Q_CLOSE = { '[': ']', '(': ')', '{': '}', '<': '>' }

function advancePanelOracleQuote(stream, state) {
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

const ORACLE_PLSQL_LANG = StreamLanguage.define({
  name: 'oracle',
  startState: () => ({ inBlockComment: false, oracleQuoteClose: null }),
  token(stream, state) {
    if (advancePanelOracleQuote(stream, state)) return 'string'
    if (advancePanelBlockComment(stream, state)) return 'comment'
    if (stream.eatSpace()) return null
    if (stream.match(/^--.*/)) return 'comment'
    if (stream.match(/^\/\*/)) {
      if (!stream.match(/^.*?\*\//)) state.inBlockComment = true
      return 'comment'
    }
    const qMatch = stream.match(/^[Nn]?[Qq]'([^\s])/)
    if (qMatch) {
      state.oracleQuoteClose = PANEL_ORACLE_Q_CLOSE[qMatch[1]] ?? qMatch[1]
      advancePanelOracleQuote(stream, state)
      return 'string'
    }
    if (stream.eat("'")) {
      readPanelSqlDelimited(stream, "'")
      return 'string'
    }
    if (stream.eat('"')) {
      readPanelSqlDelimited(stream, '"')
      return 'variableName'
    }
    if (stream.match(/^:[A-Za-z_][A-Za-z0-9_$#]*/)) return 'variableName'
    if (stream.sol() && stream.match(/^\/\s*$/)) return 'keyword'
    if (stream.match(/^\d+(?:\.\d+)?/)) return 'number'
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_$#]*/)) {
      const upper = stream.current().toUpperCase()
      if (PANEL_ORACLE_KEYWORDS.has(upper)) return 'keyword'
      if (PANEL_ORACLE_TYPES.has(upper)) return 'typeName'
      return 'propertyName'
    }
    if (stream.match(/^:=|=>|\|\||<>|!=|<=|>=|[+\-*/=<>]/)) return 'operator'
    stream.next()
    return 'punctuation'
  },
})

const MONGODB_MQL_LANG = StreamLanguage.define({
  name: 'mongodb',
  startState: () => ({ inBlockComment: false }),
  token(stream, state) {
    if (advancePanelBlockComment(stream, state)) return 'comment'
    if (stream.eatSpace()) return null
    if (stream.match(/^\/\/.*/) || stream.match(/^--.*/)) return 'comment'
    if (stream.match(/^\/\*/)) {
      if (!stream.match(/^.*?\*\//)) state.inBlockComment = true
      return 'comment'
    }
    const ch = stream.peek()
    if (ch === '"' || ch === "'" || ch === '`') {
      stream.next()
      readPanelEscapedString(stream, ch)
      const val = stream.current().slice(1, -1)
      return /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(val) ? 'keyword' : 'string'
    }
    if (stream.match(/^\$[A-Za-z_][A-Za-z0-9_]*/)) return 'keyword'
    if (stream.match(/^-?\d+(?:\.\d+)?/)) return 'number'
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const word = stream.current()
      if (word === 'true' || word === 'false') return 'bool'
      if (word === 'null') return 'null'
      if (PANEL_MONGO_METHODS.has(word)) return 'keyword'
      if (PANEL_MONGO_TYPES.has(word)) return 'typeName'
      return 'propertyName'
    }
    if (stream.match(/^[+\-*/%=<>!&|?:]+/)) return 'operator'
    stream.next()
    return 'punctuation'
  },
})

const PANEL_HIGHLIGHT_STYLE = HighlightStyle.define([
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
    color: 'var(--cm-type, #f2cc7e)',
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: 'var(--cm-comment, #6b7280)',
    fontStyle: 'italic',
  },
  {
    tag: [tags.operator, tags.compareOperator, tags.logicOperator, tags.punctuation],
    color: 'var(--cm-operator, #9ca3af)',
  },
])

function resolveDialect(dialect) {
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

export function buildPanelLanguageExtension(dialect) {
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
      return sql({ dialect: resolveDialect(dialect) })
  }
}

function buildLanguageExtension(dialect) {
  return buildPanelLanguageExtension(dialect)
}

function buildEditorTheme(typography, isLightTheme) {
  const fontFamily =
    typography?.cssFontFamily ||
    typography?.fontFamily ||
    'var(--mono, "JetBrains Mono", "Cascadia Code", Consolas, monospace)'
  const fontSize = typography?.fontSize ? `${typography.fontSize}px` : '12.5px'
  const lineHeight = typography?.lineHeight ? String(typography.lineHeight) : '1.48'
  const fontWeight = typography?.fontWeight || '400'
  const ligatureFeature = typography?.fontLigatures === false ? '"liga" 0, "calt" 0' : '"liga" 1, "calt" 1'

  return EditorView.theme(
    {
      '&': {
        backgroundColor: 'var(--bg)',
        color: 'var(--t1)',
        fontFamily,
        fontSize,
        fontWeight,
        height: '100%',
        minHeight: '86px',
        outline: 'none',
      },
      '.cm-scroller': {
        fontFamily,
        lineHeight,
        fontFeatureSettings: ligatureFeature,
        overflow: 'auto',
      },
      '.cm-content': {
        padding: '6px 0',
        caretColor: 'var(--accent-ring)',
        minHeight: '72px',
      },
      '.cm-line': {
        padding: '0 8px',
      },
      '.cm-gutters': {
        backgroundColor: 'var(--bg)',
        color: 'var(--t3)',
        borderRight: '1px solid var(--border)',
        userSelect: 'none',
        fontSize: '11px',
      },
      '.cm-gutterElement': {
        padding: '0 6px 0 8px',
        minWidth: '24px',
        textAlign: 'right',
      },
      '.cm-activeLine': {
        backgroundColor: isLightTheme ? 'rgba(15, 23, 42, 0.04)' : 'rgba(255, 255, 255, 0.03)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: isLightTheme ? 'rgba(15, 23, 42, 0.06)' : 'rgba(255, 255, 255, 0.05)',
        color: 'var(--t1)',
      },
      '&.cm-focused .cm-cursor': {
        borderLeftColor: 'var(--accent-ring)',
        borderLeftWidth: '1.5px',
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
        backgroundColor: isLightTheme ? 'rgba(37, 99, 235, 0.16)' : 'rgba(56, 189, 248, 0.18)',
      },
      '.cm-selectionMatch': {
        backgroundColor: 'var(--cm-sel-match-bg, rgba(160, 160, 160, 0.14))',
      },
      '.cm-matchingBracket': {
        backgroundColor: isLightTheme ? 'rgba(37, 99, 235, 0.14)' : 'rgba(255, 255, 255, 0.12)',
        outline: '1px solid var(--border-strong)',
      },
      '.cm-panels': {
        backgroundColor: 'var(--surface)',
        color: 'var(--t1)',
        borderBottom: '1px solid var(--border)',
      },
      '.cm-panels input, .cm-panels button': {
        fontSize: '12px',
      },
      '.cm-tooltip': {
        backgroundColor: 'var(--surface)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-control, 4px)',
        boxShadow: isLightTheme
          ? '0 6px 18px rgba(15, 23, 42, 0.14)'
          : '0 8px 20px rgba(0, 0, 0, 0.28)',
        color: 'var(--t1)',
        zIndex: '4000',
      },
      '.cm-tooltip.cm-tooltip-autocomplete': {
        backgroundColor: 'var(--surface)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-control, 4px)',
        boxShadow: '0 8px 20px rgba(0, 0, 0, 0.28)',
        fontFamily,
        fontSize: '12px',
        zIndex: '4000',
      },
      '.cm-tooltip-autocomplete ul li': {
        padding: '3px 8px',
        color: 'var(--t1)',
      },
      '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: 'color-mix(in srgb, var(--accent-ring) 18%, var(--bg))',
        color: 'var(--t1)',
      },
      '.cm-completionDetail': {
        color: 'var(--t3)',
        fontSize: '11px',
        marginLeft: '8px',
      },
      '.cm-placeholder': {
        color: isLightTheme ? '#8a8a8a' : 'var(--t3, #6e6e6e)',
        pointerEvents: 'none',
      },
      '.cm-ai-replace-strike': {
        textDecoration: 'line-through',
        textDecorationColor: isLightTheme
          ? 'rgba(220, 38, 38, 0.78)'
          : 'rgba(248, 113, 113, 0.78)',
        textDecorationThickness: '1.4px',
        opacity: '0.58',
      },
      '.cm-ai-diff-insert': {
        color: isLightTheme ? '#15803d' : 'rgba(74, 222, 128, 0.92)',
        backgroundColor: isLightTheme ? 'rgba(22, 163, 74, 0.12)' : 'rgba(34, 197, 94, 0.14)',
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
        textDecorationColor: isLightTheme
          ? 'rgba(220, 38, 38, 0.75)'
          : 'rgba(248, 113, 113, 0.72)',
        textUnderlineOffset: '3px',
        textDecorationThickness: '1.25px',
      },
      '.cm-sql-diag-warn': {
        textDecorationLine: 'underline',
        textDecorationStyle: 'wavy',
        textDecorationColor: isLightTheme
          ? 'rgba(217, 119, 6, 0.75)'
          : 'rgba(251, 191, 36, 0.72)',
        textUnderlineOffset: '3px',
        textDecorationThickness: '1.25px',
      },
      '.cm-sql-diag-tooltip': {
        fontSize: '11.5px',
        padding: '5px 8px',
        maxWidth: '340px',
        lineHeight: '1.4',
        whiteSpace: 'pre-wrap',
        color: 'var(--t1)',
      },
    },
    { dark: !isLightTheme }
  )
}

function resolvePanelCompletionFacetData(dialect) {
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
      return resolveDialect(dialect).language.data
  }
}

export function buildPanelCompletionExtension(dialect, schema = {}, activeTable = undefined) {
  const smartSource = (context) => {
    const docText = context.state.doc.toString()
    const computed = computePanelSqlCompletions(
      docText,
      context.pos,
      dialect,
      schema,
      activeTable,
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
    resolvePanelCompletionFacetData(dialect).of({
      autocomplete: smartSource,
    }),
  ]
}

export function createPanelCodeMirrorEditor(options) {
  const {
    parent,
    initialDoc = '',
    dialect = 'sqlite',
    schema = {},
    isLightTheme = false,
    typography = null,
    onExecute,
    onExecuteAll,
    onFormatSql,
    onChange,
  } = options

  let currentDialect = dialect
  let currentSchema = schema || {}
  let currentTable = undefined
  let currentTypography = typography
  let currentIsLight = Boolean(isLightTheme)
  let currentPlaceholder = String(options?.placeholder || '')

  const languageCompartment = new Compartment()
  const completionCompartment = new Compartment()
  const themeCompartment = new Compartment()
  const placeholderCompartment = new Compartment()
  const keymapCompartment = new Compartment()
  let currentKeymapSettings = normalizeShortcutSettings(options?.keymapSettings)

  function syncEmptyAttr(view) {
    if (!parent) return
    const isEmpty = view.state.doc.length === 0
    parent.classList.toggle('is-empty', isEmpty)
    if (currentPlaceholder) {
      parent.dataset.placeholder = currentPlaceholder
    }
  }

  function buildCompletionExtension() {
    return buildPanelCompletionExtension(currentDialect, currentSchema, currentTable)
  }

  function buildKeymapExtension() {
    return createCmKeymapExtension({
      editorKeymap: currentKeymapSettings.editorKeymap,
      shortcutRunStatement: currentKeymapSettings.shortcutRunStatement,
      shortcutRunAll: currentKeymapSettings.shortcutRunAll,
      shortcutFormatSql: currentKeymapSettings.shortcutFormatSql,
      onRunStatement: () => {
        onExecute?.()
        return true
      },
      onRunAll: () => {
        onExecuteAll?.()
        return true
      },
      onFormatSql: () => {
        onFormatSql?.()
        return true
      },
      onVimModeChange: options?.onVimModeChange,
    })
  }

  const state = EditorState.create({
    doc: String(initialDoc || ''),
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      bracketMatching(),
      codeFolding(),
      foldGutter(),
      highlightSelectionMatches(),
      search({ top: true }),
      syntaxHighlighting(PANEL_HIGHLIGHT_STYLE),
      languageCompartment.of(buildLanguageExtension(currentDialect)),
      completionCompartment.of(buildCompletionExtension()),
      themeCompartment.of(buildEditorTheme(currentTypography, currentIsLight)),
      placeholderCompartment.of(currentPlaceholder ? placeholder(currentPlaceholder) : []),
      createCmSqlLintExtension({ getDialect: () => currentDialect }),
      ...(options?.aiInline
        ? [createCmInlineAiExtension({ ...options.aiInline, getDialect: () => currentDialect })]
        : []),
      keymapCompartment.of(buildKeymapExtension()),
      keymap.of([
        ...completionKeymap,
        ...searchKeymap,
        ...foldKeymap,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          syncEmptyAttr(update.view)
          onChange?.(update.state.doc.toString())
        }
      }),
    ],
  })

  const view = new EditorView({
    state,
    parent,
  })
  syncEmptyAttr(view)
  const detachWheelScroll = bindCtrlWheelHorizontalScroll(view.scrollDOM)

  return {
    view,
    getValue() {
      return view.state.doc.toString()
    },
    setValue(nextSql) {
      const next = String(nextSql ?? '')
      if (next === view.state.doc.toString()) return
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
      })
      syncEmptyAttr(view)
    },
    getSelectedText() {
      const sel = view.state.selection.main
      if (sel.empty) return ''
      return view.state.sliceDoc(sel.from, sel.to).trim()
    },
    hasSelection() {
      return this.getSelectedText().length > 0
    },
    getCaretStatementSql(driverOverride) {
      return extractPanelCaretStatementSql(view.state, driverOverride || currentDialect)
    },
    getExecutionRange(mode = 'caret', driverOverride) {
      return extractPanelExecutionRange(view.state, mode, driverOverride || currentDialect)
    },
    replaceSqlRange(target, nextSql, driverOverride) {
      return replacePanelSqlRange(view, target, nextSql, driverOverride || currentDialect)
    },
    getCursorOffset() {
      return view.state.selection.main.head
    },
    setCursorOffset(pos) {
      const clamped = Math.max(0, Math.min(view.state.doc.length, Math.trunc(pos || 0)))
      view.dispatch({ selection: { anchor: clamped } })
    },
    setDialect(nextDialect) {
      const normalized = nextDialect || 'sqlite'
      if (normalized === currentDialect) return
      currentDialect = normalized
      view.dispatch({
        effects: [
          clearGhostEffect.of(undefined),
          clearDbSqlErrorEffect.of(undefined),
          languageCompartment.reconfigure(buildLanguageExtension(currentDialect)),
          completionCompartment.reconfigure(buildCompletionExtension()),
          triggerSqlLintEffect.of(undefined),
        ],
      })
    },
    setSchema(nextSchema, activeTable) {
      currentSchema = nextSchema && typeof nextSchema === 'object' ? nextSchema : {}
      currentTable = activeTable || undefined
      view.dispatch({
        effects: completionCompartment.reconfigure(buildCompletionExtension()),
      })
    },
    setColorScheme(isLight) {
      currentIsLight = Boolean(isLight)
      view.dispatch({
        effects: themeCompartment.reconfigure(buildEditorTheme(currentTypography, currentIsLight)),
      })
    },
    setTypography(typo) {
      currentTypography = typo || null
      view.dispatch({
        effects: themeCompartment.reconfigure(buildEditorTheme(currentTypography, currentIsLight)),
      })
    },
    setPlaceholder(text) {
      currentPlaceholder = String(text || '')
      if (parent) {
        parent.dataset.placeholder = currentPlaceholder
      }
      view.dispatch({
        effects: placeholderCompartment.reconfigure(
          currentPlaceholder ? placeholder(currentPlaceholder) : []
        ),
      })
    },
    applyKeymapSettings(nextSettings) {
      currentKeymapSettings = normalizeShortcutSettings(nextSettings)
      view.dispatch({
        effects: keymapCompartment.reconfigure(buildKeymapExtension()),
      })
      options?.onVimModeChange?.(getVimModeSnapshot(view))
    },
    getVimModeSnapshot() {
      return getVimModeSnapshot(view)
    },
    isVimTargetEvent(target) {
      if (!isModalKeymapActive(view)) return false
      if (!(target instanceof Node)) return false
      const el = target instanceof Element ? target : target.parentElement
      return Boolean(el && (el.closest?.('.cm-content') || view.contentDOM.contains(el)))
    },
    openFindReplace() {
      view.focus()
      openSearchPanel(view)
    },
    focus() {
      view.focus()
    },
    clearAiGhost() {
      view.dispatch({ effects: clearGhostEffect.of(undefined) })
    },
    notifyAiAvailabilityChanged() {
      notifyAiAvailabilityChanged(view)
    },
    setDbSyntaxError(errorMessage, targetRange, driverOverride) {
      const clean = String(errorMessage || '').trim()
      if (!clean) {
        view.dispatch({ effects: clearDbSqlErrorEffect.of(undefined) })
        return
      }
      view.dispatch({
        effects: setDbSqlErrorEffect.of({
          errorMessage: clean,
          targetRange: targetRange ?? null,
          dialect: driverOverride || currentDialect,
        }),
      })
    },
    clearDbSyntaxError() {
      view.dispatch({ effects: clearDbSqlErrorEffect.of(undefined) })
    },
    destroy() {
      detachWheelScroll()
      view.destroy()
    },
  }
}
