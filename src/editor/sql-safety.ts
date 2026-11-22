// src/editor/sql-safety.ts
// Pure lexer-aware Dangerous SQL Analyzer
// Zero-DOM, dialect-aware detection of destructive statements (unbounded DELETE/UPDATE, DROP, TRUNCATE)

import type { DatabaseDriverType } from '../protocol.js'
import {
  hasExplainAnalyzeOption,
  isExplainTargetMutating,
  isIdentContChar,
  isIdentStartChar,
  isPostgresEscapeStringStart,
  matchDollarQuoteTag,
  matchMysqlExecCommentPrefix,
  scanBlockCommentEnd,
  scanLineCommentEnd,
  scanQuotedSegmentEnd,
  splitSqlStatements,
  supportsDollarQuoting,
  supportsNestedBlockComments,
  usesBackslashAndHash,
} from '../drivers/common/sql-lexer.js'

export type DangerousSqlKind =
  | 'delete_without_where'
  | 'update_without_where'
  | 'drop'
  | 'truncate'

export interface DangerousSqlFinding {
  kind: DangerousSqlKind
  statementIndex: number
  statementPreview: string
  target?: string
  message: string
}

interface SafetyToken {
  text: string
  depth: number
  kind: 'word' | 'quoted' | 'punct'
}

/**
 * Tokenizes SQL statement into words and tracking parenthesis depth,
 * strictly skipping comments, string literals, and dollar-quoted blocks.
 */
function tokenizeStatementForSafety(
  sql: string,
  dialect: DatabaseDriverType
): SafetyToken[] {
  const tokens: SafetyToken[] = []
  const len = sql.length
  const backslashAndHash = usesBackslashAndHash(dialect)
  const nestedComments = supportsNestedBlockComments(dialect)
  const dollarQuotes = supportsDollarQuoting(dialect)
  const bracketIdents = dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1'
  let depth = 0
  let execCommentDepth = 0
  let i = 0

  while (i < len) {
    const ch = sql[i]

    // 1. Line comments: -- ...
    if (ch === '-' && i + 1 < len && sql[i + 1] === '-') {
      i = scanLineCommentEnd(sql, i)
      continue
    }

    // 2. MySQL / MariaDB / ClickHouse line comments: # ...
    if (ch === '#' && backslashAndHash) {
      i = scanLineCommentEnd(sql, i - 1)
      continue
    }

    // Closing MySQL/MariaDB executable comment block
    if (execCommentDepth > 0 && ch === '*' && i + 1 < len && sql[i + 1] === '/') {
      execCommentDepth--
      i += 2
      continue
    }

    // 3. Block comments: /* ... */ (unwrap /*! / /*M! on MySQL/MariaDB; nested only on PG/CRDB)
    if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
      const execLen = matchMysqlExecCommentPrefix(sql, i, dialect)
      if (execLen > 0) {
        execCommentDepth++
        i += execLen
        continue
      }
      i = scanBlockCommentEnd(sql, i, nestedComments)
      continue
    }

    // 4. PostgreSQL escape strings: E'...'
    if (isPostgresEscapeStringStart(sql, i, dialect)) {
      i = scanQuotedSegmentEnd(sql, i + 1, "'", true).end
      continue
    }

    // 5. String literals: '...'
    if (ch === "'") {
      i = scanQuotedSegmentEnd(sql, i, "'", backslashAndHash).end
      continue
    }

    // 6. Dollar-quoted blocks: $$...$$ or $tag$...$tag$ (PG/CRDB only)
    if (dollarQuotes && ch === '$') {
      const tag = matchDollarQuoteTag(sql, i)
      if (tag !== null) {
        const closeIdx = sql.indexOf(tag, i + tag.length)
        i = closeIdx >= 0 ? closeIdx + tag.length : len
        continue
      }
    }

    // 7. Quoted identifiers: "...", `...`, and [...] (SQLite family only)
    if (ch === '"' || ch === '`') {
      const seg = scanQuotedSegmentEnd(sql, i, ch, false)
      const raw = sql.slice(i + 1, seg.closed ? seg.end - 1 : seg.end)
      const unescaped = ch === '`' ? raw.replace(/``/g, '`') : raw.replace(/""/g, '"')
      tokens.push({ text: unescaped, depth, kind: 'quoted' })
      i = seg.end
      continue
    }
    if (bracketIdents && ch === '[') {
      let j = i + 1
      while (j < len) {
        if (sql[j] === ']') {
          if (j + 1 < len && sql[j + 1] === ']') {
            j += 2
            continue
          }
          break
        }
        j++
      }
      const raw = sql.slice(i + 1, j)
      const unescaped = raw.replace(/]]/g, ']')
      tokens.push({ text: unescaped, depth, kind: 'quoted' })
      i = j < len ? j + 1 : len
      continue
    }

    // 8. Parentheses depth
    if (ch === '(') {
      tokens.push({ text: ch, depth, kind: 'punct' })
      depth++
      i++
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      tokens.push({ text: ch, depth, kind: 'punct' })
      i++
      continue
    }

    // 9. Word tokens: [A-Za-z_][A-Za-z0-9_]*
    if (isIdentStartChar(sql.charCodeAt(i))) {
      let j = i + 1
      while (j < len && isIdentContChar(sql.charCodeAt(j))) {
        j++
      }
      tokens.push({ text: sql.slice(i, j), depth, kind: 'word' })
      i = j
      continue
    }

    i++
  }

  return tokens
}

const DROP_TARGET_MODIFIERS: ReadonlySet<string> = new Set([
  'TEMPORARY',
  'IF',
  'EXISTS',
  'TABLE',
  'VIEW',
  'MATERIALIZED',
  'DATABASE',
  'SCHEMA',
  'FUNCTION',
  'PROCEDURE',
  'TRIGGER',
  'SEQUENCE',
  'TYPE',
  'INDEX',
])

const CTE_MAIN_DML_KEYWORDS: ReadonlySet<string> = new Set([
  'DELETE',
  'UPDATE',
  'DROP',
  'TRUNCATE',
])

const NO_MODIFIERS: ReadonlySet<string> = new Set()
const TRUNCATE_TARGET_MODIFIERS: ReadonlySet<string> = new Set(['TABLE'])

function findTargetAtDepth(
  tokens: SafetyToken[],
  startIdx: number,
  targetDepth: number,
  modifiers: ReadonlySet<string>
): string | undefined {
  for (let i = startIdx + 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.depth < targetDepth) break
    if (token.depth !== targetDepth || token.kind === 'punct') continue
    const upper = token.text.toUpperCase()
    if (token.kind === 'word' && modifiers.has(upper)) continue
    return token.text
  }
  return undefined
}

function unwrapExplainAnalyzeOffset(tokens: SafetyToken[], rawText: string, dialect: DatabaseDriverType): number {
  const firstWord = tokens[0]?.kind === 'word' ? tokens[0].text.toUpperCase() : ''
  if (firstWord === 'ANALYZE' && dialect === 'mariadb' && tokens.length > 1) {
    const nextUpper = tokens[1].kind === 'word' ? tokens[1].text.toUpperCase() : ''
    if (nextUpper === 'DELETE' || nextUpper === 'UPDATE' || nextUpper === 'DROP' || nextUpper === 'TRUNCATE' || nextUpper === 'WITH') {
      return 1
    }
  }
  if (firstWord === 'EXPLAIN' && hasExplainAnalyzeOption(rawText, dialect) && isExplainTargetMutating(rawText, dialect)) {
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i].depth !== 0 || tokens[i].kind !== 'word') continue
      const u = tokens[i].text.toUpperCase()
      if (u === 'WITH' || CTE_MAIN_DML_KEYWORDS.has(u)) {
        return i
      }
    }
  }
  return 0
}

function inspectScopeForDangerousDml(
  tokens: SafetyToken[],
  startIdx: number,
  scopeDepth: number,
  stmtIdx: number,
  preview: string,
  findings: DangerousSqlFinding[]
): void {
  const mainToken = tokens[startIdx]
  if (!mainToken || mainToken.kind !== 'word') return
  const mainWord = mainToken.text.toUpperCase()

  let hasWhereAtScope = false
  for (let i = startIdx + 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.depth < scopeDepth) break
    if (t.depth === scopeDepth && t.kind === 'word' && t.text.toUpperCase() === 'WHERE') {
      hasWhereAtScope = true
      break
    }
  }

  if (mainWord === 'DELETE') {
    if (!hasWhereAtScope) {
      let target: string | undefined
      for (let i = startIdx + 1; i < tokens.length; i++) {
        const t = tokens[i]
        if (t.depth < scopeDepth) break
        if (t.depth === scopeDepth && t.kind === 'word' && t.text.toUpperCase() === 'FROM') {
          if (i + 1 < tokens.length && tokens[i + 1].depth === scopeDepth) {
            target = tokens[i + 1].text
          }
          break
        }
      }
      if (!target) {
        target = findTargetAtDepth(tokens, startIdx, scopeDepth, NO_MODIFIERS)
      }
      findings.push({
        kind: 'delete_without_where',
        statementIndex: stmtIdx,
        statementPreview: preview,
        target,
        message: `DELETE statement ${target ? `on "${target}" ` : ''}has no WHERE clause and will delete all rows`,
      })
    }
    return
  }

  if (mainWord === 'UPDATE') {
    if (!hasWhereAtScope) {
      const target = findTargetAtDepth(tokens, startIdx, scopeDepth, NO_MODIFIERS)
      findings.push({
        kind: 'update_without_where',
        statementIndex: stmtIdx,
        statementPreview: preview,
        target,
        message: `UPDATE statement ${target ? `on "${target}" ` : ''}has no WHERE clause and will update all rows`,
      })
    }
    return
  }

  if (mainWord === 'DROP') {
    const target = findTargetAtDepth(tokens, startIdx, scopeDepth, DROP_TARGET_MODIFIERS)
    findings.push({
      kind: 'drop',
      statementIndex: stmtIdx,
      statementPreview: preview,
      target,
      message: `DROP statement will permanently remove "${target || 'object'}"`,
    })
    return
  }

  if (mainWord === 'TRUNCATE') {
    const target = findTargetAtDepth(tokens, startIdx, scopeDepth, TRUNCATE_TARGET_MODIFIERS)
    findings.push({
      kind: 'truncate',
      statementIndex: stmtIdx,
      statementPreview: preview,
      target,
      message: `TRUNCATE statement will remove all rows from "${target || 'table'}"`,
    })
  }
}

function isRedisDangerousCommand(sql: string): boolean {
  for (const line of sql.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue
    const match = /^["']?([A-Za-z_][A-Za-z0-9_-]*)["']?/.exec(trimmed)
    if (!match) continue
    const cmd = match[1].toUpperCase()
    if (cmd === 'FLUSHALL' || cmd === 'FLUSHDB') {
      return true
    }
  }
  return false
}

/**
 * Analyzes a SQL script for dangerous and destructive operations.
 * Detects DELETE without WHERE, UPDATE without WHERE, DROP, and TRUNCATE,
 * including inside data-modifying CTEs and EXPLAIN ANALYZE DML.
 * Completely immune to false positives inside comments and string literals.
 */
export function analyzeDangerousSql(
  sql: string,
  dialect: DatabaseDriverType
): DangerousSqlFinding[] {
  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    return []
  }

  if (dialect === 'redis') {
    if (isRedisDangerousCommand(sql)) {
      return [
        {
          kind: 'truncate',
          statementIndex: 0,
          statementPreview: sql.trim().slice(0, 80),
          target: 'redis_database',
          message: 'FLUSHDB / FLUSHALL will permanently delete all keys in the database',
        },
      ]
    }
    return []
  }

  const stmts = splitSqlStatements(sql, dialect)
  const findings: DangerousSqlFinding[] = []

  for (let stmtIdx = 0; stmtIdx < stmts.length; stmtIdx++) {
    const stmt = stmts[stmtIdx]
    const rawText = stmt.text
    const preview = rawText.trim().replace(/\s+/g, ' ').slice(0, 80)
    const tokens = tokenizeStatementForSafety(rawText, dialect)

    if (tokens.length === 0) {
      continue
    }

    const baseOffset = unwrapExplainAnalyzeOffset(tokens, rawText, dialect)
    const firstToken = tokens[baseOffset]
    const firstWord = firstToken?.kind === 'word' ? firstToken.text.toUpperCase() : ''

    if (firstWord === 'WITH') {
      let mainIdx = -1
      for (let i = baseOffset + 1; i < tokens.length; i++) {
        const t = tokens[i]
        if (t.depth === 0 && t.kind === 'word' && CTE_MAIN_DML_KEYWORDS.has(t.text.toUpperCase())) {
          mainIdx = i
          break
        }
        // Inspect data-modifying CTE subquery start at depth === 1 (`AS (DELETE ...` / `AS (UPDATE ...`)
        if (
          t.depth === 1 &&
          t.kind === 'word' &&
          (t.text.toUpperCase() === 'DELETE' || t.text.toUpperCase() === 'UPDATE') &&
          tokens[i - 1]?.kind === 'punct' &&
          tokens[i - 1].text === '('
        ) {
          inspectScopeForDangerousDml(tokens, i, 1, stmtIdx, preview, findings)
        }
      }
      if (mainIdx !== -1) {
        inspectScopeForDangerousDml(tokens, mainIdx, 0, stmtIdx, preview, findings)
      }
      continue
    }

    inspectScopeForDangerousDml(tokens, baseOffset, 0, stmtIdx, preview, findings)
  }

  return findings
}
