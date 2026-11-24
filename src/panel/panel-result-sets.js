// src/panel/panel-result-sets.js
// Pure helpers for Side Panel SQL multi-result-set state initialization,
// banner summaries, combined EXPLAIN payloads, and error result formatting.

/**
 * Collapses whitespace and truncates SQL for compact status/banner previews.
 */
export function compactSqlPreview(sqlText) {
  const clean = String(sqlText || '').replace(/\s+/g, ' ').trim()
  return clean.length > 88 ? `${clean.slice(0, 85)}...` : clean
}

/**
 * Normalizes a QueryResult into an array of at least one QueryResultSet.
 */
export function getEffectiveResultSets(res, fallbackSql = '') {
  if (res && Array.isArray(res.resultSets) && res.resultSets.length > 0) {
    return res.resultSets
  }
  if (!res) return []
  return [
    {
      index: 0,
      sqlPreview: fallbackSql ? compactSqlPreview(fallbackSql) : undefined,
      sql: fallbackSql || undefined,
      executionTimeMs: res.executionTimeMs,
      columns: res.columns || [],
      rows: res.rows || [],
      rowCount: res.rowCount ?? (res.rows ? res.rows.length : 0),
      affectedRows: res.affectedRows,
      truncated: Boolean(res.truncated),
      isSelect: Boolean(res.isSelect),
    },
  ]
}

/**
 * Selects the default result tab index (0 for EXPLAIN; last SELECT result for queries).
 */
export function getDefaultResultSetIndex(res, mode = 'query') {
  if (mode === 'explain') return 0
  const sets = res?.resultSets
  if (!sets || sets.length === 0) return 0
  let index = 0
  for (let i = 0; i < sets.length; i++) {
    if (sets[i]?.isSelect) index = i
  }
  return index
}

/**
 * Projects a single result-set entry from a multi-set QueryResult into a flat QueryResult.
 */
export function buildSingleSetQueryResult(res, index) {
  const rs = res?.resultSets?.[index]
  if (!rs) return res
  return {
    columns: rs.columns || [],
    rows: rs.rows || [],
    rowCount: rs.rowCount ?? (rs.rows ? rs.rows.length : 0),
    affectedRows: rs.affectedRows,
    executionTimeMs: rs.executionTimeMs ?? res.executionTimeMs ?? 0,
    truncated: Boolean(rs.truncated),
    isSelect: Boolean(rs.isSelect),
    isError: Boolean(rs.isError),
    errorMessage: rs.errorMessage,
  }
}

/**
 * Initializes per-result-tab runtime state (status banner, sort, column widths, scroll).
 */
export function buildInitialPanelResultStates(
  res,
  rawStatements = [],
  overallSql = '',
  fallbackMs = 0,
  mode = 'query'
) {
  const sets = getEffectiveResultSets(res, overallSql)
  const out = {}
  sets.forEach((rs, idx) => {
    const stmtSql =
      rs.sql ||
      (rawStatements.length === sets.length ? rawStatements[idx] : undefined) ||
      rs.sqlPreview ||
      overallSql
    const execMs = Number.isFinite(Number(rs.executionTimeMs))
      ? Number(rs.executionTimeMs)
      : Number.isFinite(Number(fallbackMs))
        ? Number(fallbackMs)
        : 0
    const truncSuffix = rs.truncated ? ' · (truncated)' : ''
    const rowCount = rs.rowCount ?? (rs.rows ? rs.rows.length : 0)
    const affected = rs.affectedRows ?? 0
    const isExplain = mode === 'explain'

    let banner
    if (rs.isError) {
      const errTitle = isExplain ? 'EXPLAIN Error' : 'SQL Execution Error'
      banner = {
        kind: 'error',
        text: `${errTitle}: ${rs.errorMessage || 'Query failed'}`,
        detail: compactSqlPreview(stmtSql),
        badgeText: isExplain ? 'EXPLAIN Failed' : 'Query Failed',
        badgeClass: 'badge badge-danger',
        scopeLabel: sets.length > 1 ? `Result ${idx + 1} · Error` : 'Error',
        dismissed: false,
      }
    } else if (isExplain) {
      const badge = `${rowCount} ${rowCount === 1 ? 'step' : 'steps'} · ${execMs.toFixed(1)} ms${truncSuffix}`
      banner = {
        kind: 'success',
        text: `EXPLAIN OK · ${badge}`,
        detail: compactSqlPreview(stmtSql),
        badgeText: badge,
        badgeClass: 'badge badge-ok',
        scopeLabel:
          sets.length > 1
            ? `Result ${idx + 1} · Plan (${rowCount} step${rowCount === 1 ? '' : 's'})`
            : `Execution Plan (${rowCount} step${rowCount === 1 ? '' : 's'})`,
        dismissed: false,
      }
    } else {
      const summary = rs.isSelect
        ? `${rowCount} rows · ${execMs.toFixed(1)} ms${truncSuffix}`
        : `${affected} affected · ${execMs.toFixed(1)} ms`
      banner = {
        kind: 'success',
        text: rs.isSelect
          ? `Query executed successfully · ${summary}`
          : `Statement executed successfully · ${summary}`,
        detail: compactSqlPreview(stmtSql),
        badgeText: summary,
        badgeClass: 'badge badge-ok',
        scopeLabel:
          sets.length > 1
            ? `Result ${idx + 1} (${rs.rows?.length || 0} row${(rs.rows?.length || 0) === 1 ? '' : 's'})`
            : `Query Result (${rs.rows?.length || 0} row${(rs.rows?.length || 0) === 1 ? '' : 's'})`,
        dismissed: false,
      }
    }

    out[idx] = {
      index: idx,
      statementSql: stmtSql,
      isExplain,
      banner,
      sortColIdx: null,
      sortDir: 'ASC',
      colWidths: [],
      scrollTop: 0,
      explainAnalysis: null,
      explainAnalysisError: null,
      explainAnalysisCollapsed: false,
    }
  })
  return out
}

/**
 * Combines per-statement EXPLAIN sets into a unified QueryResult payload.
 */
export function buildCombinedExplainResult(collectedSets, firstNonError, totalMs) {
  const lead = firstNonError || {
    columns: collectedSets[0]?.columns || [],
    rows: collectedSets[0]?.rows || [],
    rowCount: collectedSets[0]?.rowCount || 0,
    truncated: false,
    isSelect: true,
  }
  return {
    columns: lead.columns || [],
    rows: lead.rows || [],
    rowCount: lead.rowCount ?? (lead.rows ? lead.rows.length : 0),
    executionTimeMs: totalMs,
    truncated: Boolean(lead.truncated),
    isSelect: true,
    ...(collectedSets.length > 1 ? { resultSets: collectedSets } : {}),
  }
}

/**
 * Wraps an unhandled query/explain failure as a single error ResultSet.
 */
export function buildErrorQueryResult(sql, errMsg) {
  return {
    columns: [],
    rows: [],
    rowCount: 0,
    executionTimeMs: 0,
    truncated: false,
    isSelect: true,
    resultSets: [
      {
        index: 0,
        sqlPreview: compactSqlPreview(sql),
        sql,
        isError: true,
        errorMessage: errMsg,
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        isSelect: true,
      },
    ],
  }
}
