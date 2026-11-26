// src/drivers/common/oracle-sql.ts
// Pure Oracle SQL / SQL*Plus statement splitting and implicit-commit DDL detection.
// Imports ONLY shared-sql-core.js (zero vendor/oracledb.js dependency for cold-boot Perf #1).

import {
  scanOracleQuoteEnd,
  stripCommentsAndLiterals,
  stripLeadingSqlComments,
} from '../../shared-sql-core.js'

export interface OracleStatementChunk {
  text: string
  isPlSql: boolean
}

const ORACLE_PLSQL_HEADER_RE =
  /^(?:(?:<<[^>]+>>\s*)*(?:DECLARE|BEGIN)\b|WITH\s+(?:FUNCTION|PROCEDURE)\b|CREATE\s+(?:OR\s+REPLACE\s+)?(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|TRIGGER|PACKAGE(?:\s+BODY)?|TYPE(?:\s+BODY)?)\b)/i

const ORACLE_IMPLICIT_COMMIT_DDL_RE =
  /^(?:CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|COMMENT|AUDIT|NOAUDIT|ANALYZE|PURGE|FLASHBACK)\b/i

function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;\s*$/, '').trimEnd()
}

function isOraclePlSqlHeader(chunk: string): boolean {
  const stripped = stripLeadingSqlComments(chunk, 'oracle').trim()
  return ORACLE_PLSQL_HEADER_RE.test(stripped)
}

/**
 * Returns true if the Oracle SQL statement triggers an implicit transaction commit
 * per Oracle DDL semantics (after stripping leading comments).
 */
export function isOracleImplicitCommitStatement(sql: string): boolean {
  const stripped = stripLeadingSqlComments(sql, 'oracle').replace(/^[\s(]+/, '').trim()
  if (!stripped) return false
  return ORACLE_IMPLICIT_COMMIT_DDL_RE.test(stripped)
}

/**
 * Splits an Oracle SQL / SQL*Plus script into executable statements, keeping PL/SQL
 * blocks intact across internal semicolons (ended by standalone `/`), honoring
 * `q'[...]'` and `nq'[...]'` alternative quoting literals, while stripping trailing
 * semicolons from standalone non-PL/SQL SQL statements.
 */
export function splitOracleStatements(sql: string): OracleStatementChunk[] {
  const raw = sql.replace(/\r\n?/g, '\n')
  const len = raw.length
  const chunks: OracleStatementChunk[] = []

  let stmtStart = 0
  let i = 0
  let inSingleQuote = false
  let inDoubleQuote = false
  let inBlockComment = false
  let currentIsPlSql: boolean | null = null

  const flushChunk = (endIdx: number, viaSlash: boolean): void => {
    const rawSlice = raw.slice(stmtStart, endIdx).trim()
    if (!rawSlice) return
    const withoutComments = stripCommentsAndLiterals(rawSlice, 'oracle', false).trim()
    if (!withoutComments) return
    const plSql = currentIsPlSql ?? isOraclePlSqlHeader(rawSlice)
    const text = plSql ? rawSlice : stripTrailingSemicolon(rawSlice)
    if (!text) return
    if (!viaSlash && !plSql && !text) return
    chunks.push({ text, isPlSql: plSql })
  }

  while (i < len) {
    const atLineStart = i === 0 || raw[i - 1] === '\n'
    const atTopLevel = !inSingleQuote && !inDoubleQuote && !inBlockComment

    if (atLineStart && atTopLevel) {
      let k = i
      while (k < len && (raw[k] === ' ' || raw[k] === '\t')) k++
      if (
        k < len &&
        raw[k] === '/' &&
        (k + 1 >= len || (raw[k + 1] !== '/' && raw[k + 1] !== '*'))
      ) {
        let after = k + 1
        while (after < len && (raw[after] === ' ' || raw[after] === '\t')) after++
        if (after < len && raw[after] === '-' && after + 1 < len && raw[after + 1] === '-') {
          const nl = raw.indexOf('\n', after + 2)
          after = nl < 0 ? len : nl
        } else if (
          after > k + 1 &&
          after + 1 < len &&
          raw[after] === '/' &&
          raw[after + 1] === '*'
        ) {
          const closeIdx = raw.indexOf('*/', after + 2)
          const nlIdx = raw.indexOf('\n', after + 2)
          if (closeIdx >= 0 && (nlIdx < 0 || closeIdx < nlIdx)) {
            after = closeIdx + 2
            while (after < len && (raw[after] === ' ' || raw[after] === '\t')) after++
          }
        }
        if (after === len || raw[after] === '\n') {
          flushChunk(i, true)
          i = after < len ? after + 1 : after
          stmtStart = i
          currentIsPlSql = null
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
      if (currentIsPlSql === null) {
        currentIsPlSql = isOraclePlSqlHeader(raw.slice(stmtStart, i + 1))
      }
      i = oracleQuote.end
      continue
    }

    if (ch === "'") {
      if (currentIsPlSql === null) {
        currentIsPlSql = isOraclePlSqlHeader(raw.slice(stmtStart, i + 1))
      }
      inSingleQuote = true
      i++
      continue
    }

    if (ch === '"') {
      if (currentIsPlSql === null) {
        currentIsPlSql = isOraclePlSqlHeader(raw.slice(stmtStart, i + 1))
      }
      inDoubleQuote = true
      i++
      continue
    }

    if (ch === ';') {
      if (currentIsPlSql === null) {
        currentIsPlSql = isOraclePlSqlHeader(raw.slice(stmtStart, i))
      }
      if (!currentIsPlSql) {
        flushChunk(i, false)
        i++
        stmtStart = i
        currentIsPlSql = null
        continue
      }
    }

    i++
  }

  if (stmtStart < len) {
    flushChunk(len, false)
  }

  return chunks
}
