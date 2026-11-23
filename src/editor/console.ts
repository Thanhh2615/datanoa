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
import type { DatabaseDriverType } from '../protocol.js'

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

const REDIS_MONOCHROME_LANG = StreamLanguage.define({
  name: 'redis',
  token(stream) {
    stream.skipToEnd()
    return null
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
 * Resolves the CodeMirror SQL dialect extension from a database driver name.
 */
export function resolveSqlDialect(dialect: SqlDialectType = 'sqlite'): SQLDialect {
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

function buildLanguageExtension(dialect: SqlDialectType): Extension {
  if (dialect === 'redis') {
    return new LanguageSupport(REDIS_MONOCHROME_LANG)
  }
  return sql({ dialect: resolveSqlDialect(dialect) })
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
    for (const kw of SQL_KEYWORD_COMPLETIONS) {
      const m = matchesWord(kw.label)
      if (!m.ok) continue
      const isFunc = kw.detail === 'aggregate' || kw.detail === 'scalar fn'
      const applyText = isLowerInput && !isFunc ? kw.label.toLowerCase() : kw.label
      options.push({
        label: kw.label,
        apply: applyText,
        type: isFunc ? 'function' : 'keyword',
        detail: kw.detail,
        boost: m.starts ? kw.boost : kw.boost - 12,
      })
    }
  }

  return options.length > 0 ? { from, options } : null
}

function buildCompletionExtension(
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
      validFor: /^[A-Za-z0-9_]*$/,
    }
  }

  if (dialect === 'redis') {
    return REDIS_MONOCHROME_LANG.data.of({
      autocomplete: smartSource,
    })
  }
  const dialectConfig = resolveSqlDialect(dialect)
  return dialectConfig.language.data.of({
    autocomplete: smartSource,
  })
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
  private currentDialect: SqlDialectType = 'sqlite'
  private currentSchema: Record<string, string[]> = {}
  private currentDefaultTable?: string = undefined
  private currentTypography: EditorTypography = {}
  private isDarkTheme = true
  private readonly onExecute?: (sql: string) => void
  private readonly onExecuteAll?: (sql: string) => void
  private readonly onFormatSql?: () => void
  private readonly onChange?: (doc: string) => void

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
      autocompletion({ activateOnTyping: true, maxRenderedOptions: 40 }),
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
    ]

    const state = EditorState.create({
      doc: initialDoc,
      extensions,
    })

    this.view = new EditorView({
      state,
      parent,
    })
  }

  /**
   * Dynamically switches SQL dialect support across all 8 Datanoa engines (F15-04).
   */
  public setDialect(dialect: SqlDialectType): void {
    if (!this.view || this.currentDialect === dialect) return
    this.currentDialect = dialect

    this.view.dispatch({
      effects: [
        this.langCompartment.reconfigure(buildLanguageExtension(dialect)),
        this.completionCompartment.reconfigure(
          buildCompletionExtension(dialect, this.currentSchema, this.currentDefaultTable)
        ),
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
   * Disposes the editor instance.
   */
  public destroy(): void {
    this.view?.destroy()
    this.view = null
  }
}
