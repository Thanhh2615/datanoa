// src/drivers/common/mssql-sql.ts
// Pure T-SQL batch splitting, Read-Only guard, and semicolon-less TX-control analysis.
// Imports ONLY shared-sql-core.js (zero vendor/mssql.js dependency for cold-boot Perf #1).

import {
  isIdentContChar,
  isIdentStartChar,
  scanBlockCommentEnd,
  scanBracketIdentEnd,
  scanLineCommentEnd,
  scanQuotedSegmentEnd,
  splitMssqlBatches,
  splitSqlStatements,
} from '../../shared-sql-core.js'

export { splitMssqlBatches }

type MssqlTokenKind = 'word' | 'quoted' | 'var' | 'number' | 'string' | 'punct' | 'temp'

interface MssqlGuardToken {
  kind: MssqlTokenKind
  text: string
  upper: string
  depth: number
}

const MSSQL_READONLY_STARTERS = new Set(['SELECT', 'WITH', 'VALUES', 'DECLARE', 'SET'])

const MSSQL_BLOCKED_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'EXEC',
  'EXECUTE',
  'DBCC',
  'BULK',
  'WRITETEXT',
  'UPDATETEXT',
  'SETUSER',
  'REVERT',
  'KILL',
  'SHUTDOWN',
  'BACKUP',
  'RESTORE',
  'WAITFOR',
  'GRANT',
  'REVOKE',
  'DENY',
  'RECONFIGURE',
  'CHECKPOINT',
  'USE',
  'OPENROWSET',
  'OPENDATASOURCE',
  'OPENQUERY',
  'OPENXML',
  'RECEIVE',
  'COMMIT',
  'ROLLBACK',
  'SAVE',
  'BCP',
  'XP_CMDSHELL',
  'SP_EXECUTESQL',
  'SP_CONFIGURE',
  'SP_OACREATE',
  'GO',
])

const MSSQL_SAFE_SET_TOGGLE_OPTIONS = new Set([
  'NOCOUNT',
  'ARITHABORT',
  'ANSI_NULLS',
  'ANSI_PADDING',
  'ANSI_WARNINGS',
  'CONCAT_NULL_YIELDS_NULL',
  'QUOTED_IDENTIFIER',
  'NUMERIC_ROUNDABORT',
])

const MSSQL_SAFE_SHOWPLAN_OPTIONS = new Set(['SHOWPLAN_ALL', 'SHOWPLAN_TEXT', 'SHOWPLAN_XML'])

const MSSQL_SAFE_SET_VALUE_OPTIONS = new Set([
  'LOCK_TIMEOUT',
  'ROWCOUNT',
  'DATEFORMAT',
  'LANGUAGE',
])

const MSSQL_STMT_START_KEYWORDS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'WITH',
  'DECLARE',
  'SET',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVE',
  'IF',
  'WHILE',
  'EXEC',
  'EXECUTE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'PRINT',
  'RETURN',
  'THROW',
  'RAISERROR',
  'USE',
  'DBCC',
])

function tokenizeMssqlForGuard(sql: string): {
  tokens: MssqlGuardToken[]
  hasUnclosed: boolean
} {
  const tokens: MssqlGuardToken[] = []
  const len = sql.length
  let depth = 0
  let i = 0
  let hasUnclosed = false

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
      const end = scanBlockCommentEnd(sql, i, true)
      if (end < i + 4 || sql[end - 2] !== '*' || sql[end - 1] !== '/') {
        hasUnclosed = true
      }
      i = end
      continue
    }

    if (
      (ch === 'N' || ch === 'n') &&
      i + 1 < len &&
      sql[i + 1] === "'" &&
      (i === 0 || !isIdentContChar(sql.charCodeAt(i - 1)))
    ) {
      const seg = scanQuotedSegmentEnd(sql, i + 1, "'", false)
      if (!seg.closed) hasUnclosed = true
      tokens.push({ kind: 'string', text: "''", upper: '', depth })
      i = seg.end
      continue
    }

    if (ch === "'") {
      const seg = scanQuotedSegmentEnd(sql, i, "'", false)
      if (!seg.closed) hasUnclosed = true
      tokens.push({ kind: 'string', text: "''", upper: '', depth })
      i = seg.end
      continue
    }

    if (ch === '"') {
      const seg = scanQuotedSegmentEnd(sql, i, '"', false)
      if (!seg.closed) hasUnclosed = true
      const raw = sql.slice(i + 1, seg.closed ? seg.end - 1 : seg.end).replace(/""/g, '"')
      tokens.push({ kind: 'quoted', text: raw, upper: raw.toUpperCase(), depth })
      i = seg.end
      continue
    }

    if (ch === '[') {
      const seg = scanBracketIdentEnd(sql, i, true)
      if (!seg.closed) hasUnclosed = true
      const raw = sql.slice(i + 1, seg.closed ? seg.end - 1 : seg.end).replace(/]]/g, ']')
      tokens.push({ kind: 'quoted', text: raw, upper: raw.toUpperCase(), depth })
      i = seg.end
      continue
    }

    if (ch === '(') {
      tokens.push({ kind: 'punct', text: '(', upper: '(', depth })
      depth++
      i++
      continue
    }

    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      tokens.push({ kind: 'punct', text: ')', upper: ')', depth })
      i++
      continue
    }

    if (
      (ch >= '0' && ch <= '9') ||
      (ch === '.' && i + 1 < len && sql[i + 1] >= '0' && sql[i + 1] <= '9')
    ) {
      let j = i
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
      const raw = sql.slice(i, j)
      tokens.push({ kind: 'number', text: raw, upper: raw, depth })
      i = j
      continue
    }

    if (ch === '.' || ch === ',' || ch === '=' || ch === '-') {
      tokens.push({ kind: 'punct', text: ch, upper: ch, depth })
      i++
      continue
    }

    if (ch === '@') {
      let j = i + 1
      if (j < len && sql[j] === '@') j++
      while (j < len && (isIdentContChar(sql.charCodeAt(j)) || sql[j] === '$' || sql[j] === '#')) {
        j++
      }
      const raw = sql.slice(i, j)
      tokens.push({ kind: 'var', text: raw, upper: raw.toUpperCase(), depth })
      i = j
      continue
    }

    if (ch === '#') {
      let j = i + 1
      if (j < len && sql[j] === '#') j++
      while (j < len && (isIdentContChar(sql.charCodeAt(j)) || sql[j] === '$' || sql[j] === '#')) {
        j++
      }
      const raw = sql.slice(i, j)
      tokens.push({ kind: 'temp', text: raw, upper: raw.toUpperCase(), depth })
      i = j
      continue
    }

    if (isIdentStartChar(sql.charCodeAt(i))) {
      let j = i + 1
      while (j < len && (isIdentContChar(sql.charCodeAt(j)) || sql[j] === '$' || sql[j] === '#')) {
        j++
      }
      const raw = sql.slice(i, j)
      tokens.push({ kind: 'word', text: raw, upper: raw.toUpperCase(), depth })
      i = j
      continue
    }

    i++
  }

  return { tokens, hasUnclosed }
}

function isSafeMssqlSetStatement(tokens: MssqlGuardToken[], setIdx: number): boolean {
  const next = tokens[setIdx + 1]
  if (!next) return false

  // SET @var = ...
  if (next.kind === 'var' && !next.text.startsWith('@@')) {
    return true
  }

  if (next.kind !== 'word') return false
  const opt = next.upper

  // SET SHOWPLAN_ALL | SHOWPLAN_TEXT | SHOWPLAN_XML ON | OFF
  if (MSSQL_SAFE_SHOWPLAN_OPTIONS.has(opt)) {
    const val = tokens[setIdx + 2]
    return val?.kind === 'word' && (val.upper === 'ON' || val.upper === 'OFF')
  }

  // SET TRANSACTION ISOLATION LEVEL <level>
  if (opt === 'TRANSACTION') {
    const t2 = tokens[setIdx + 2]
    const t3 = tokens[setIdx + 3]
    const t4 = tokens[setIdx + 4]
    if (
      t2?.kind !== 'word' ||
      t2.upper !== 'ISOLATION' ||
      t3?.kind !== 'word' ||
      t3.upper !== 'LEVEL' ||
      t4?.kind !== 'word'
    ) {
      return false
    }
    if (t4.upper === 'SNAPSHOT' || t4.upper === 'SERIALIZABLE') {
      return true
    }
    const t5 = tokens[setIdx + 5]
    if (t4.upper === 'READ') {
      return t5?.kind === 'word' && (t5.upper === 'UNCOMMITTED' || t5.upper === 'COMMITTED')
    }
    if (t4.upper === 'REPEATABLE') {
      return t5?.kind === 'word' && t5.upper === 'READ'
    }
    return false
  }

  // SET ANSI_NULLS, QUOTED_IDENTIFIER ON (comma-separated safe toggle options; OFF blocked to prevent session-semantics mutation)
  if (MSSQL_SAFE_SET_TOGGLE_OPTIONS.has(opt)) {
    let j = setIdx + 1
    while (tokens[j + 1]?.kind === 'punct' && tokens[j + 1].text === ',') {
      j += 2
      if (tokens[j]?.kind !== 'word' || !MSSQL_SAFE_SET_TOGGLE_OPTIONS.has(tokens[j].upper)) {
        return false
      }
    }
    const toggle = tokens[j + 1]
    return toggle?.kind === 'word' && toggle.upper === 'ON'
  }

  // SET LOCK_TIMEOUT | ROWCOUNT | DATEFORMAT | LANGUAGE <val>
  if (MSSQL_SAFE_SET_VALUE_OPTIONS.has(opt)) {
    const val = tokens[setIdx + 2]
    if (!val) return false
    if (val.kind === 'punct' && val.text === '-') {
      return tokens[setIdx + 3]?.kind === 'number'
    }
    return (
      val.kind === 'number' ||
      val.kind === 'word' ||
      val.kind === 'quoted' ||
      val.kind === 'string' ||
      val.kind === 'var'
    )
  }

  return false
}

function isMssqlChunkReadOnlyBlocked(chunkSql: string): boolean {
  const { tokens, hasUnclosed } = tokenizeMssqlForGuard(chunkSql)
  if (hasUnclosed) return true
  if (tokens.length === 0) return false

  let firstIdx = 0
  while (
    firstIdx < tokens.length &&
    tokens[firstIdx].kind === 'punct' &&
    tokens[firstIdx].text === '('
  ) {
    firstIdx++
  }
  if (firstIdx >= tokens.length) return false

  const starter = tokens[firstIdx]
  if (starter.kind !== 'word' || !MSSQL_READONLY_STARTERS.has(starter.upper)) {
    return true
  }

  let caseDepth = 0
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.kind !== 'word') continue
    const prev = i > 0 ? tokens[i - 1] : undefined
    if (prev && prev.kind === 'punct' && prev.text === '.') continue

    if (MSSQL_BLOCKED_KEYWORDS.has(tok.upper)) {
      return true
    }

    if (
      tok.upper === 'NEXT' &&
      tokens[i + 1]?.kind === 'word' &&
      tokens[i + 1].upper === 'VALUE' &&
      tokens[i + 2]?.kind === 'word' &&
      tokens[i + 2].upper === 'FOR'
    ) {
      return true
    }

    if (tok.upper === 'CASE') {
      caseDepth++
      continue
    }

    if (tok.upper === 'END') {
      if (caseDepth > 0) {
        caseDepth--
        continue
      }
      const next = tokens[i + 1]
      if (next?.kind === 'word' && next.upper === 'CONVERSATION') {
        return true
      }
      continue
    }

    if (tok.upper === 'BEGIN') {
      const next = tokens[i + 1]
      if (
        next?.kind === 'word' &&
        (next.upper === 'TRAN' ||
          next.upper === 'TRANSACTION' ||
          next.upper === 'DISTRIBUTED' ||
          next.upper === 'DIALOG' ||
          (next.upper === 'CONVERSATION' &&
            tokens[i + 2]?.kind === 'word' &&
            tokens[i + 2].upper === 'TIMER'))
      ) {
        return true
      }
      continue
    }

    if (tok.upper === 'SEND') {
      const next = tokens[i + 1]
      if (
        next?.kind === 'word' &&
        (next.upper === 'CONVERSATION' ||
          (next.upper === 'ON' &&
            tokens[i + 2]?.kind === 'word' &&
            tokens[i + 2].upper === 'CONVERSATION'))
      ) {
        return true
      }
      continue
    }

    if (tok.upper === 'MOVE') {
      const next = tokens[i + 1]
      if (next?.kind === 'word' && next.upper === 'CONVERSATION') {
        return true
      }
      continue
    }

    if (tok.upper === 'DISABLE' || tok.upper === 'ENABLE') {
      const next = tokens[i + 1]
      if (next?.kind === 'word' && next.upper === 'TRIGGER') {
        return true
      }
    }

    if (tok.upper === 'SELECT') {
      for (let j = i + 1; j < tokens.length; j++) {
        const inner = tokens[j]
        if (inner.depth < tok.depth) break
        if (inner.depth !== tok.depth || inner.kind !== 'word') continue
        const innerPrev = tokens[j - 1]
        if (innerPrev && innerPrev.kind === 'punct' && innerPrev.text === '.') continue
        if (
          inner.upper === 'FROM' ||
          inner.upper === 'SELECT' ||
          inner.upper === 'UNION' ||
          inner.upper === 'INTERSECT' ||
          inner.upper === 'EXCEPT'
        ) {
          break
        }
        if (inner.upper === 'INTO' && j + 1 < tokens.length) {
          return true
        }
      }
    }

    if (tok.depth === 0 && tok.upper === 'SET') {
      if (!isSafeMssqlSetStatement(tokens, i)) {
        return true
      }
    }
  }

  return false
}

/**
 * Fail-closed Read-Only guard for SQL Server (T-SQL), immune to GO batch stacking,
 * semicolon-less multi-statement batches, bare stored procedures, SELECT ... INTO,
 * Service Broker RECEIVE/SEND/BEGIN DIALOG/END CONVERSATION, and unsafe SET directives.
 */
export function isMssqlReadOnlyBlocked(sql: string): boolean {
  const batches = splitMssqlBatches(sql)
  if (batches.length === 0) return false

  for (const batch of batches) {
    const stmts = splitSqlStatements(batch, 'mssql')
    const list = stmts.length > 0 ? stmts.map((s) => s.text) : [batch]
    for (const stmt of list) {
      if (isMssqlChunkReadOnlyBlocked(stmt)) {
        return true
      }
    }
  }

  return false
}

/**
 * Detects T-SQL transaction-control and outer transaction-ending commands across
 * `GO` batches and semicolon-less statements while distinguishing `ROLLBACK TRAN <savepoint>`
 * from outer `ROLLBACK [TRAN[SACTION]|WORK]`.
 */
export function hasMssqlSemicolonlessTxControl(sql: string): {
  hasTxControl: boolean
  hasTxEnd: boolean
} {
  let hasTxControl = false
  let hasTxEnd = false

  const batches = splitMssqlBatches(sql)
  for (const batch of batches) {
    const stmts = splitSqlStatements(batch, 'mssql')
    const list = stmts.length > 0 ? stmts.map((s) => s.text) : [batch]
    for (const stmt of list) {
      const { tokens } = tokenizeMssqlForGuard(stmt)
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i]
        if (tok.depth !== 0 || tok.kind !== 'word') continue
        const prev = i > 0 ? tokens[i - 1] : undefined
        if (prev && prev.kind === 'punct' && prev.text === '.') continue

        if (tok.upper === 'BEGIN') {
          const next = tokens[i + 1]
          if (
            next?.kind === 'word' &&
            (next.upper === 'TRAN' || next.upper === 'TRANSACTION' || next.upper === 'DISTRIBUTED')
          ) {
            hasTxControl = true
          }
          continue
        }

        if (tok.upper === 'COMMIT') {
          hasTxControl = true
          hasTxEnd = true
          continue
        }

        if (tok.upper === 'ROLLBACK') {
          const next = tokens[i + 1]
          if (next?.kind === 'word' && (next.upper === 'TRAN' || next.upper === 'TRANSACTION')) {
            const afterTran = tokens[i + 2]
            const isSavepointRollback =
              afterTran !== undefined &&
              (afterTran.kind === 'quoted' ||
                afterTran.kind === 'var' ||
                (afterTran.kind === 'word' && !MSSQL_STMT_START_KEYWORDS.has(afterTran.upper)))
            if (!isSavepointRollback) {
              hasTxControl = true
              hasTxEnd = true
            }
          } else {
            hasTxControl = true
            hasTxEnd = true
          }
          continue
        }

        if (tok.upper === 'SET') {
          const next = tokens[i + 1]
          if (next?.kind === 'word' && next.upper === 'IMPLICIT_TRANSACTIONS') {
            hasTxControl = true
          }
        }
      }
    }
  }

  return { hasTxControl, hasTxEnd }
}
