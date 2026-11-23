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
} from '../../vendor/codemirror.js'
import { findStatementAtOffset } from './panel-core.js'
import { computePanelSqlCompletions } from './panel-sql-tabs.js'

const REDIS_MONOCHROME_LANG = StreamLanguage.define({
  name: 'redis',
  token(stream) {
    stream.skipToEnd()
    return null
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
      return PostgreSQL
    case 'mysql':
    case 'clickhouse':
      return MySQL
    case 'mariadb':
      return MariaSQL
    case 'sqlite':
    case 'libsql':
    case 'd1':
    case 'redis':
    default:
      return SQLite
  }
}

function buildLanguageExtension(dialect) {
  if (dialect === 'redis') {
    return new LanguageSupport(REDIS_MONOCHROME_LANG)
  }
  return sql({ dialect: resolveDialect(dialect) })
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
    },
    { dark: !isLightTheme }
  )
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
  let currentPlaceholder = ''

  const languageCompartment = new Compartment()
  const completionCompartment = new Compartment()
  const themeCompartment = new Compartment()

  function syncEmptyAttr(view) {
    if (!parent) return
    const isEmpty = view.state.doc.length === 0
    parent.classList.toggle('is-empty', isEmpty)
    if (currentPlaceholder) {
      parent.dataset.placeholder = currentPlaceholder
    }
  }

  function buildCompletionExtension() {
    const smartSource = (context) => {
      const docText = context.state.doc.toString()
      const computed = computePanelSqlCompletions(
        docText,
        context.pos,
        currentDialect,
        currentSchema,
        currentTable,
        Boolean(context.explicit)
      )
      if (!computed) return null
      return {
        from: computed.from,
        options: computed.options,
        validFor: /^[A-Za-z0-9_]*$/,
      }
    }
    return autocompletion({
      override: [smartSource],
      activateOnTyping: true,
      maxRenderedOptions: 40,
    })
  }

  const runKeymap = keymap.of([
    {
      key: 'Mod-Enter',
      run: () => {
        onExecute?.()
        return true
      },
    },
    {
      key: 'Mod-Shift-Enter',
      run: () => {
        onExecuteAll?.()
        return true
      },
    },
    {
      key: 'Shift-Alt-f',
      run: () => {
        onFormatSql?.()
        return true
      },
    },
  ])

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
      runKeymap,
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
      const selected = this.getSelectedText()
      if (selected) return selected
      const full = view.state.doc.toString()
      const head = view.state.selection.main.head
      const activeDriver = driverOverride || currentDialect
      if (activeDriver === 'redis') return full.trim()
      return findStatementAtOffset(full, head, activeDriver).trim()
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
          languageCompartment.reconfigure(buildLanguageExtension(currentDialect)),
          completionCompartment.reconfigure(buildCompletionExtension()),
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
    },
    openFindReplace() {
      view.focus()
      openSearchPanel(view)
    },
    focus() {
      view.focus()
    },
    destroy() {
      view.destroy()
    },
  }
}
