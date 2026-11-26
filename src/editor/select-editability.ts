// src/editor/select-editability.ts
// Pure analyzer for Phase 5C: Inline Edit on Single-Table SELECT results with PK
// Zero-DOM, dialect-aware, strictly verifies safety invariants before enabling edit grid

import type {
  ColumnInfo,
  DatabaseDriverType,
  SchemaObject,
  TableDetails,
} from '../protocol.js'
import {
  getDialectLexerRules,
  isIdentContChar,
  isIdentStartChar,
  isPostgresEscapeStringStart,
  matchDollarQuoteTag,
  scanBlockCommentEnd,
  scanBracketIdentEnd,
  scanLineCommentEnd,
  scanOracleQuoteEnd,
  scanQuotedSegmentEnd,
  splitSqlStatements,
} from '../drivers/common/sql-lexer.js'

export interface EditableSelectAnalysis {
  editable: boolean
  reason?: string
  table?: string
  schema?: string
  primaryKey?: string[]
  columns?: ColumnInfo[]
}

export interface AnalyzeEditableSelectParams {
  sql: string
  dialect: DatabaseDriverType
  isReadOnly: boolean
  resultColumns: { name: string; type?: string }[]
  schemaObjects: SchemaObject[]
  resolveTableDetails: (table: string, schema?: string) => TableDetails | undefined
  resolvedSourceTable?: { table: string; schema?: string }
}

interface SqlToken {
  text: string
  type: 'word' | 'ident' | 'punct' | 'literal'
  depth: number
}

/**
 * Tokenizes SQL statement into words, quoted identifiers, literals, and punctuation,
 * tracking parenthesis nesting depth while strictly skipping comments.
 */
function tokenizeSqlStatement(
  sql: string,
  dialect: DatabaseDriverType
): SqlToken[] {
  const tokens: SqlToken[] = []
  const len = sql.length
  const rules = getDialectLexerRules(dialect)
  let depth = 0
  let i = 0

  while (i < len) {
    const ch = sql[i]

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

    // 4. PostgreSQL escape string: E'...'
    if (isPostgresEscapeStringStart(sql, i, dialect)) {
      const end = scanQuotedSegmentEnd(sql, i + 1, "'", true).end
      tokens.push({ text: "''", type: 'literal', depth })
      i = end
      continue
    }

    // 4b. Oracle q'...' / nq'...' alternative quote literal
    const oracleQuote = scanOracleQuoteEnd(sql, i, dialect)
    if (oracleQuote) {
      tokens.push({ text: "''", type: 'literal', depth })
      i = oracleQuote.end
      continue
    }

    // 5. String literal: '...'
    if (ch === "'") {
      const end = scanQuotedSegmentEnd(sql, i, "'", rules.backslashEscapesSingleQuote).end
      tokens.push({ text: "''", type: 'literal', depth })
      i = end
      continue
    }

    // 6. Dollar-quoted blocks: $$...$$ or $tag$...$tag$ (PG/CRDB only)
    if (rules.dollarQuoting && ch === '$') {
      const tag = matchDollarQuoteTag(sql, i)
      if (tag !== null) {
        const closeIdx = sql.indexOf(tag, i + tag.length)
        tokens.push({ text: "''", type: 'literal', depth })
        i = closeIdx >= 0 ? closeIdx + tag.length : len
        continue
      }
    }

    // 7. Double-quoted identifier: "..."
    if (ch === '"') {
      const seg = scanQuotedSegmentEnd(sql, i, '"', rules.backslashEscapesDoubleQuote)
      const raw = sql.slice(i + 1, seg.closed ? seg.end - 1 : seg.end)
      const unescaped = raw.replace(/""/g, '"')
      tokens.push({ text: unescaped, type: 'ident', depth })
      i = seg.end
      continue
    }

    // 8. Backtick identifier: `...`
    if (ch === '`' && rules.backtickIdentifiers) {
      const seg = scanQuotedSegmentEnd(sql, i, '`', false)
      const raw = sql.slice(i + 1, seg.closed ? seg.end - 1 : seg.end)
      const unescaped = raw.replace(/``/g, '`')
      tokens.push({ text: unescaped, type: 'ident', depth })
      i = seg.end
      continue
    }

    // 9. Bracket identifier: [...] (SQLite family & MSSQL)
    if (rules.bracketIdentifiers !== 'none' && ch === '[') {
      const allowDoubling = rules.bracketIdentifiers === 'doubling'
      const seg = scanBracketIdentEnd(sql, i, allowDoubling)
      const raw = sql.slice(i + 1, seg.closed ? seg.end - 1 : seg.end)
      const unescaped = allowDoubling ? raw.replace(/]]/g, ']') : raw
      tokens.push({ text: unescaped, type: 'ident', depth })
      i = seg.end
      continue
    }

    // 9b. Numeric literals (prevent `SELECT 999 id` from collapsing to bare `id`)
    if (
      (ch >= '0' && ch <= '9') ||
      (ch === '.' && i + 1 < len && sql[i + 1] >= '0' && sql[i + 1] <= '9')
    ) {
      let j = i
      if (ch === '0' && j + 1 < len && (sql[j + 1] === 'x' || sql[j + 1] === 'X')) {
        j += 2
        while (j < len && /[0-9A-Fa-f]/.test(sql[j])) j++
      } else {
        if (ch === '.') {
          j++
          while (j < len && sql[j] >= '0' && sql[j] <= '9') j++
        } else {
          while (j < len && sql[j] >= '0' && sql[j] <= '9') j++
          if (j < len && sql[j] === '.') {
            j++
            while (j < len && sql[j] >= '0' && sql[j] <= '9') j++
          }
        }
        if (j < len && (sql[j] === 'e' || sql[j] === 'E')) {
          let exp = j + 1
          if (exp < len && (sql[exp] === '+' || sql[exp] === '-')) exp++
          if (exp < len && sql[exp] >= '0' && sql[exp] <= '9') {
            while (exp < len && sql[exp] >= '0' && sql[exp] <= '9') exp++
            j = exp
          }
        }
      }
      tokens.push({ text: sql.slice(i, j), type: 'literal', depth })
      i = j
      continue
    }

    // 10. Parentheses
    if (ch === '(') {
      tokens.push({ text: '(', type: 'punct', depth })
      depth++
      i++
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      tokens.push({ text: ')', type: 'punct', depth })
      i++
      continue
    }

    // 11. Punctuation & expression operators
    if (
      ch === ',' ||
      ch === '.' ||
      ch === ';' ||
      ch === '*' ||
      ch === '+' ||
      ch === '/' ||
      ch === '%' ||
      ch === '=' ||
      ch === '<' ||
      ch === '>' ||
      ch === '|' ||
      ch === '&' ||
      ch === '!' ||
      ch === '~' ||
      ch === '^' ||
      ch === ':' ||
      ch === '-'
    ) {
      tokens.push({ text: ch, type: 'punct', depth })
      i++
      continue
    }

    // 12. Word / Identifier: [A-Za-z_][A-Za-z0-9_]*
    if (isIdentStartChar(sql.charCodeAt(i))) {
      let j = i + 1
      while (j < len && isIdentContChar(sql.charCodeAt(j))) {
        j++
      }
      tokens.push({ text: sql.slice(i, j), type: 'word', depth })
      i = j
      continue
    }

    i++
  }

  return tokens
}

const SQL_AGGREGATE_FUNCTIONS: ReadonlySet<string> = new Set([
  'COUNT',
  'COUNT_BIG',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'GROUP_CONCAT',
  'STRING_AGG',
  'ARRAY_AGG',
  'ARRAY_CONCAT_AGG',
  'JSON_AGG',
  'JSONB_AGG',
  'JSON_ARRAYAGG',
  'JSON_OBJECTAGG',
  'LISTAGG',
  'XMLAGG',
  'BOOL_AND',
  'BOOL_OR',
  'STDDEV',
  'VARIANCE',
  'ANY_VALUE',
  'MEDIAN',
  'PERCENTILE_CONT',
  'PERCENTILE_DISC',
  'BIT_AND',
  'BIT_OR',
  'BIT_XOR',
  'UNIQ',
  'UNIQEXACT',
  'UNIQCOMBINED',
  'UNIQHLL12',
  'GROUPARRAY',
  'GROUPUNIQARRAY',
  'SUMIF',
  'COUNTIF',
  'AVGIF',
  'MINIF',
  'MAXIF',
  'ARGMIN',
  'ARGMAX',
  'COLLECT_LIST',
  'COLLECT_SET',
])

const SQL_SET_RETURNING_FUNCTIONS: ReadonlySet<string> = new Set([
  'UNNEST',
  'GENERATE_SERIES',
  'GENERATE_SUBSCRIPTS',
  'JSON_EACH',
  'JSONB_EACH',
  'JSON_EACH_TEXT',
  'JSONB_EACH_TEXT',
  'JSON_ARRAY_ELEMENTS',
  'JSONB_ARRAY_ELEMENTS',
  'JSON_ARRAY_ELEMENTS_TEXT',
  'JSONB_ARRAY_ELEMENTS_TEXT',
  'JSON_OBJECT_KEYS',
  'JSONB_OBJECT_KEYS',
  'JSON_TABLE',
  'OPENJSON',
  'STRING_SPLIT',
  'ARRAYJOIN',
  'EXPLODE',
  'POSEXPLODE',
  'REGEXP_SPLIT_TO_TABLE',
])

interface ProjectionItem {
  isStar: boolean
  outputName?: string
  directColumn?: string
  sourceColumn?: string
}

function isIdentifierToken(token: SqlToken): boolean {
  return token.type === 'word' || token.type === 'ident'
}

function classifyProjectionItem(tokens: SqlToken[]): ProjectionItem {
  if (tokens.length === 1 && tokens[0].text === '*') {
    return { isStar: true }
  }
  if (
    tokens.length === 3 &&
    isIdentifierToken(tokens[0]) &&
    tokens[1].text === '.' &&
    tokens[2].text === '*'
  ) {
    return { isStar: true }
  }

  let base = tokens
  let alias: string | undefined
  let asIdx = -1
  for (let i = 0; i < tokens.length; i++) {
    if (
      tokens[i].depth === 0 &&
      tokens[i].type === 'word' &&
      tokens[i].text.toUpperCase() === 'AS'
    ) {
      asIdx = i
      break
    }
  }
  if (asIdx >= 0) {
    const aliasToken = tokens[asIdx + 1]
    if (asIdx + 2 === tokens.length && aliasToken && isIdentifierToken(aliasToken)) {
      alias = aliasToken.text
      base = tokens.slice(0, asIdx)
    } else {
      return { isStar: false }
    }
  } else if (tokens.length === 2 && isIdentifierToken(tokens[0]) && isIdentifierToken(tokens[1])) {
    alias = tokens[1].text
    base = tokens.slice(0, 1)
  } else if (
    tokens.length === 4 &&
    isIdentifierToken(tokens[0]) &&
    tokens[1].text === '.' &&
    isIdentifierToken(tokens[2]) &&
    isIdentifierToken(tokens[3])
  ) {
    alias = tokens[3].text
    base = tokens.slice(0, 3)
  } else if (
    tokens.length >= 2 &&
    tokens[tokens.length - 1].depth === 0 &&
    isIdentifierToken(tokens[tokens.length - 1]) &&
    tokens[tokens.length - 2].text !== '.'
  ) {
    alias = tokens[tokens.length - 1].text
    base = tokens.slice(0, -1)
  }

  let directColumn: string | undefined
  if (base.length === 1 && isIdentifierToken(base[0])) {
    directColumn = base[0].text
  } else if (
    base.length === 3 &&
    isIdentifierToken(base[0]) &&
    base[1].text === '.' &&
    isIdentifierToken(base[2])
  ) {
    directColumn = base[2].text
  }

  if (directColumn) {
    if (alias && alias.toLowerCase() !== directColumn.toLowerCase()) {
      return { isStar: false, outputName: alias, sourceColumn: directColumn }
    }
    return { isStar: false, outputName: directColumn, directColumn }
  }
  return { isStar: false, outputName: alias }
}

function skipSelectProjectionModifiers(
  tokens: SqlToken[],
  startIdx: number,
  endIdx: number,
  dialect: DatabaseDriverType
): number {
  let cursor = startIdx
  if (
    cursor < endIdx &&
    tokens[cursor].type === 'word' &&
    tokens[cursor].text.toUpperCase() === 'ALL'
  ) {
    cursor++
  }
  if (
    dialect === 'mssql' &&
    cursor < endIdx &&
    tokens[cursor].type === 'word' &&
    tokens[cursor].text.toUpperCase() === 'TOP'
  ) {
    cursor++
    if (cursor < endIdx && tokens[cursor].text === '(') {
      const targetDepth = tokens[cursor].depth
      cursor++
      while (cursor < endIdx && !(tokens[cursor].depth === targetDepth && tokens[cursor].text === ')')) {
        cursor++
      }
      cursor++
    } else if (cursor < endIdx) {
      cursor++
    }
    if (
      cursor < endIdx &&
      tokens[cursor].type === 'word' &&
      tokens[cursor].text.toUpperCase() === 'PERCENT'
    ) {
      cursor++
    }
    if (
      cursor + 1 < endIdx &&
      tokens[cursor].type === 'word' &&
      tokens[cursor].text.toUpperCase() === 'WITH' &&
      tokens[cursor + 1].type === 'word' &&
      tokens[cursor + 1].text.toUpperCase() === 'TIES'
    ) {
      cursor += 2
    }
  }
  return cursor
}

function parseProjectionItems(
  tokens: SqlToken[],
  startIdx: number,
  endIdx: number
): ProjectionItem[] {
  const items: ProjectionItem[] = []
  let current: SqlToken[] = []
  const flush = (): void => {
    if (current.length > 0) {
      items.push(classifyProjectionItem(current))
      current = []
    }
  }
  for (let i = startIdx; i < endIdx; i++) {
    const token = tokens[i]
    if (token.depth === 0 && token.text === ',') {
      flush()
      continue
    }
    current.push(token)
  }
  flush()
  return items
}

const FORBIDDEN_TOP_LEVEL_KEYWORDS: ReadonlySet<string> = new Set([
  'DISTINCT',
  'JOIN',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'MINUS',
  'APPLY',
  'PIVOT',
  'UNPIVOT',
  'TABLESAMPLE',
  'LATERAL',
  'HAVING',
  'WINDOW',
])

const SQL_CLAUSE_TERMINATORS: ReadonlySet<string> = new Set([
  'WHERE',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'FETCH',
  'FOR',
  'GROUP',
  'HAVING',
  'WINDOW',
  ';',
])

/**
 * Analyzes whether a SQL query qualifies for inline editing on a single table with primary keys.
 */
export function analyzeEditableSelectQuery(
  params: AnalyzeEditableSelectParams
): EditableSelectAnalysis {
  const {
    sql,
    dialect,
    isReadOnly,
    resultColumns,
    schemaObjects,
    resolveTableDetails,
    resolvedSourceTable,
  } = params

  if (isReadOnly) {
    return { editable: false, reason: 'Connection is read-only' }
  }

  if (dialect === 'redis') {
    return { editable: false, reason: 'Redis commands are not editable SQL tables' }
  }
  if (dialect === 'mongodb') {
    return { editable: false, reason: 'MongoDB commands are not editable SQL tables' }
  }

  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    return { editable: false, reason: 'SQL query is empty' }
  }

  const stmts = splitSqlStatements(sql, dialect)
  if (stmts.length === 0) {
    return { editable: false, reason: 'No executable statements found' }
  }
  if (stmts.length > 1) {
    return { editable: false, reason: 'Multi-statement scripts cannot be edited inline' }
  }

  const tokens = tokenizeSqlStatement(stmts[0].text, dialect)
  if (tokens.length === 0) {
    return { editable: false, reason: 'Empty statement' }
  }

  // 1. First keyword verification
  const firstWord = tokens[0].text.toUpperCase()
  if (firstWord === 'WITH') {
    return {
      editable: false,
      reason: 'Common Table Expressions (CTE) cannot be edited inline',
    }
  }
  if (firstWord !== 'SELECT') {
    return {
      editable: false,
      reason: 'Only SELECT queries can be edited inline',
    }
  }

  // 2. Reject forbidden top-level clauses (quoted identifiers are not keywords)
  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx]
    if (t.depth === 0 && t.type === 'word') {
      const upper = t.text.toUpperCase()
      if (FORBIDDEN_TOP_LEVEL_KEYWORDS.has(upper)) {
        return {
          editable: false,
          reason: `${upper} queries cannot be edited inline`,
        }
      }
      if (upper === 'GROUP') {
        const next = tokens[idx + 1]
        if (next && next.depth === 0 && next.text.toUpperCase() === 'BY') {
          return {
            editable: false,
            reason: 'GROUP BY queries cannot be edited inline',
          }
        }
      }
      if (upper === 'OVER') {
        const next = tokens[idx + 1]
        if (next && next.text === '(') {
          return {
            editable: false,
            reason: 'Window functions (OVER) cannot be edited inline',
          }
        }
      }
    }
  }

  // 3. Find top-level FROM clause
  let fromIdx = -1
  for (let idx = 0; idx < tokens.length; idx++) {
    if (
      tokens[idx].depth === 0 &&
      tokens[idx].type === 'word' &&
      tokens[idx].text.toUpperCase() === 'FROM'
    ) {
      fromIdx = idx
      break
    }
  }

  if (fromIdx === -1) {
    return { editable: false, reason: 'Query has no FROM clause' }
  }

  // 3b. Reject aggregate and set-returning function calls anywhere in the SELECT projection
  const projStartIdx = skipSelectProjectionModifiers(tokens, 1, fromIdx, dialect)
  const projectionTokens = tokens.slice(projStartIdx, fromIdx)
  for (let idx = 0; idx < projectionTokens.length; idx++) {
    const t = projectionTokens[idx]
    if (t.type === 'word' && projectionTokens[idx + 1]?.text === '(') {
      const upper = t.text.toUpperCase()
      if (SQL_AGGREGATE_FUNCTIONS.has(upper)) {
        return { editable: false, reason: 'aggregate_query' }
      }
      if (SQL_SET_RETURNING_FUNCTIONS.has(upper)) {
        return { editable: false, reason: 'set_returning_function' }
      }
    }
  }
  const projectionItems = parseProjectionItems(tokens, projStartIdx, fromIdx)

  let cursor = fromIdx + 1
  if (cursor >= tokens.length) {
    return { editable: false, reason: 'Incomplete FROM clause' }
  }

  // Reject FROM ONLY <table> (table inheritance) or subqueries / SRFs in FROM clause
  if (tokens[cursor].type === 'word' && tokens[cursor].text.toUpperCase() === 'ONLY') {
    return {
      editable: false,
      reason: 'FROM ONLY queries cannot be edited inline',
    }
  }
  if (tokens[cursor].text === '(') {
    return {
      editable: false,
      reason: 'Subqueries in FROM clause cannot be edited inline',
    }
  }
  if (
    tokens[cursor].type === 'word' &&
    SQL_SET_RETURNING_FUNCTIONS.has(tokens[cursor].text.toUpperCase()) &&
    tokens[cursor + 1]?.text === '('
  ) {
    return { editable: false, reason: 'set_returning_function' }
  }

  // 4. Parse table reference: [schema .] table (reject 3-part catalog.schema.table)
  const firstPart = tokens[cursor].text
  cursor++

  let schema: string | undefined = undefined
  let table = firstPart

  if (cursor < tokens.length && tokens[cursor].text === '.') {
    cursor++ // consume '.'
    if (cursor >= tokens.length) {
      return { editable: false, reason: 'Incomplete qualified table name after "."' }
    }
    schema = firstPart
    table = tokens[cursor].text
    cursor++
    if (cursor < tokens.length && tokens[cursor].text === '.') {
      return {
        editable: false,
        reason: 'Cross-database 3-part table references cannot be edited inline',
      }
    }
  }

  // Reject table-valued function calls in FROM (e.g., FROM fn(...))
  if (cursor < tokens.length && tokens[cursor].depth === 0 && tokens[cursor].text === '(') {
    return {
      editable: false,
      reason: 'Table-valued functions cannot be edited inline',
    }
  }

  // 5. Handle optional table alias: [AS] alias (reject column alias lists `u(a, b)`)
  if (cursor < tokens.length && tokens[cursor].depth === 0) {
    const nextUpper = tokens[cursor].text.toUpperCase()
    if (nextUpper === 'AS') {
      cursor++ // consume 'AS'
      if (cursor < tokens.length) {
        cursor++ // consume alias
      }
    } else if (
      !SQL_CLAUSE_TERMINATORS.has(nextUpper) &&
      tokens[cursor].text !== ',' &&
      tokens[cursor].text !== ';'
    ) {
      cursor++ // consume bare alias (e.g. 'users u')
    }
  }
  if (cursor < tokens.length && tokens[cursor].depth === 0 && tokens[cursor].text === '(') {
    return {
      editable: false,
      reason: 'Table column alias lists cannot be edited inline',
    }
  }

  // 6. Check for comma-separated multiple tables or JOIN
  if (
    cursor < tokens.length &&
    tokens[cursor].depth === 0 &&
    tokens[cursor].text === ','
  ) {
    return {
      editable: false,
      reason: 'Comma-separated multi-table FROM clauses cannot be edited inline',
    }
  }
  if (
    cursor < tokens.length &&
    tokens[cursor].depth === 0 &&
    tokens[cursor].text.toUpperCase() === 'JOIN'
  ) {
    return {
      editable: false,
      reason: 'JOIN queries cannot be edited inline',
    }
  }

  // 6b. Reconcile exact database-reported relation/schema metadata (prevents search_path mismatch)
  if (resolvedSourceTable?.table) {
    if (resolvedSourceTable.table.toLowerCase() !== table.toLowerCase()) {
      return { editable: false, reason: 'source_table_mismatch' }
    }
    if (resolvedSourceTable.schema) {
      if (schema && schema.toLowerCase() !== resolvedSourceTable.schema.toLowerCase()) {
        return { editable: false, reason: 'source_table_mismatch' }
      }
      schema = resolvedSourceTable.schema
    }
  }

  // On PostgreSQL / CockroachDB, never guess 'public' when search_path could have resolved another schema.
  // Only resolve an unqualified table when the loaded catalog uniquely identifies a single schema.
  if ((dialect === 'postgres' || dialect === 'cockroachdb') && !schema) {
    const matchingSchemas = new Set(
      schemaObjects
        .filter((obj) => obj.name.toLowerCase() === table.toLowerCase() && Boolean(obj.schema))
        .map((obj) => obj.schema)
    )
    if (matchingSchemas.size === 1) {
      schema = Array.from(matchingSchemas)[0]
    } else {
      return { editable: false, reason: 'ambiguous_schema' }
    }
  }

  // 7. Schema object validation (reject views)
  if (schemaObjects.length > 0) {
    const matchedObj = schemaObjects.find((obj) => {
      const nameMatch = obj.name.toLowerCase() === table.toLowerCase()
      if (schema) {
        return nameMatch && Boolean(obj.schema) && obj.schema.toLowerCase() === schema.toLowerCase()
      }
      return nameMatch
    })
    if (matchedObj && matchedObj.kind !== 'table') {
      return {
        editable: false,
        reason: `Cannot edit ${matchedObj.kind} "${table}" inline`,
      }
    }
  }

  // 8. Resolve table details & primary key
  const tableDetails = resolveTableDetails(table, schema)
  if (!tableDetails) {
    return {
      editable: false,
      reason: 'missing_table_details',
      table,
      schema,
    }
  }

  if (tableDetails.kind && tableDetails.kind !== 'table') {
    return {
      editable: false,
      reason: `Cannot edit ${tableDetails.kind} "${table}" inline`,
    }
  }

  if (!tableDetails.primaryKey || tableDetails.primaryKey.length === 0) {
    return {
      editable: false,
      reason: `Table "${table}" has no primary key defined`,
    }
  }

  // 9. Result columns verification
  if (!resultColumns || resultColumns.length === 0) {
    return { editable: false, reason: 'Query returned no columns' }
  }

  const seenColNames = new Set<string>()
  for (const col of resultColumns) {
    const lower = col.name.toLowerCase()
    if (seenColNames.has(lower)) {
      return {
        editable: false,
        reason: `Query has duplicate column name "${col.name}"`,
      }
    }
    seenColNames.add(lower)
  }

  // Build direct/aliased projection maps; every PK must come from an unaliased direct column.
  const directByName = new Map<string, string>()
  const computedNames = new Set<string>()
  const aliasedSourceColumns = new Set<string>()
  for (const item of projectionItems) {
    if (item.isStar || !item.outputName) continue
    const lower = item.outputName.toLowerCase()
    if (item.directColumn) directByName.set(lower, item.directColumn)
    else {
      computedNames.add(lower)
      if (item.sourceColumn) aliasedSourceColumns.add(item.sourceColumn.toLowerCase())
    }
  }
  const hasStarProjection = projectionItems.some((item) => item.isStar)
  const isDirectResultColumn = (name: string): boolean => {
    const lower = name.toLowerCase()
    if (computedNames.has(lower)) return false
    if (directByName.has(lower)) return true
    return hasStarProjection
  }

  for (const pkCol of tableDetails.primaryKey) {
    const lower = pkCol.toLowerCase()
    if (computedNames.has(lower) || aliasedSourceColumns.has(lower)) {
      return { editable: false, reason: 'aliased_or_computed_pk' }
    }
    if (!seenColNames.has(lower)) {
      return {
        editable: false,
        reason: `Primary key column "${pkCol}" is missing from SELECT projection`,
      }
    }
    if (directByName.has(lower)) continue
    if (
      hasStarProjection &&
      tableDetails.columns.some((c) => c.name.toLowerCase() === lower)
    ) {
      continue
    }
    return { editable: false, reason: 'aliased_or_computed_pk' }
  }

  // 10. Map result columns to ColumnInfo (flag unmapped/computed expressions as isGenerated: true)
  const columns: ColumnInfo[] = resultColumns.map((resCol) => {
    const matchedCol = tableDetails.columns.find(
      (c) => c.name.toLowerCase() === resCol.name.toLowerCase()
    )
    if (matchedCol && isDirectResultColumn(resCol.name)) {
      return { ...matchedCol }
    }
    if (matchedCol) {
      return { ...matchedCol, isGenerated: true }
    }
    return {
      name: resCol.name,
      type: resCol.type || 'text',
      nativeType: resCol.type || 'text',
      nullable: true,
      defaultValue: null,
      isPrimaryKey: false,
      isAutoIncrement: false,
      isGenerated: true,
    }
  })

  return {
    editable: true,
    table: tableDetails.name,
    schema: tableDetails.schema || schema,
    primaryKey: tableDetails.primaryKey,
    columns,
  }
}
