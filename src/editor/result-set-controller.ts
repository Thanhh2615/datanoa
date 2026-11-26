// src/editor/result-set-controller.ts
// Pure helpers for Studio multi-result-set state initialization, banner generation,
// combined EXPLAIN aggregation, and view-mode banner visibility.

import type { QueryResult, QueryResultSet } from '../protocol.js'
import type { ResultBannerState, ResultSetTabRuntimeState } from './console-tabs.js'

export type StudioViewMode = 'split' | 'grid' | 'sql' | 'inspector'

const toNonNegInt = (raw: unknown): number => {
  const num = Number(raw)
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0
}

/**
 * Formats bottom status-bar row and column metrics consistently across table browse and SQL results.
 */
export function formatGridStatusMetrics(
  rowCount: number,
  colCount: number,
  opts?: {
    stagedCount?: number
    truncated?: boolean
    unit?: 'row' | 'affected'
  }
): string {
  const rows = toNonNegInt(rowCount)
  const cols = toNonNegInt(colCount)
  const staged = toNonNegInt(opts?.stagedCount)
  if (opts?.unit === 'affected') {
    return `${rows} affected`
  }
  const rowLabel = `${rows} ${rows === 1 ? 'row' : 'rows'}`
  const base = opts?.truncated ? `${rowLabel} (truncated)` : rowLabel
  const withCols = cols > 0 ? `${base} · ${cols} ${cols === 1 ? 'col' : 'cols'}` : base
  return staged > 0 ? `${withCols} (+${staged} staged)` : withCols
}

/**
 * Collapses whitespace and truncates SQL for compact status/banner previews.
 */
export function compactSqlPreview(sql: string): string {
  const clean = sql.replace(/\s+/g, ' ').trim()
  return clean.length > 96 ? `${clean.slice(0, 93)}...` : clean
}

/**
 * Normalizes a QueryResult into an array of at least one QueryResultSet.
 */
export function getEffectiveResultSets(res: QueryResult, fallbackSql = ''): QueryResultSet[] {
  if (res.resultSets && res.resultSets.length > 0) {
    return res.resultSets
  }
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
      ...(res.sourceTable ? { sourceTable: res.sourceTable } : {}),
    },
  ]
}

/**
 * Returns the index of the last SELECT result set (or 0 if none).
 */
export function getDefaultResultSetIndex(res: QueryResult): number {
  const sets = res.resultSets
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
export function buildResultSetQueryResult(res: QueryResult, index: number): QueryResult {
  const rs = res.resultSets?.[index]
  if (!rs) return res
  return {
    columns: rs.columns,
    rows: rs.rows,
    rowCount: rs.rowCount,
    affectedRows: rs.affectedRows,
    executionTimeMs: rs.executionTimeMs ?? res.executionTimeMs,
    truncated: rs.truncated,
    isSelect: rs.isSelect,
    ...(rs.sourceTable ? { sourceTable: rs.sourceTable } : {}),
  }
}

/**
 * Builds the status/error banner state owned by a single result tab.
 */
export function buildBannerForResultSet(
  rs: QueryResultSet,
  statementSql: string,
  fallbackDurationMs: number,
  mode: 'query' | 'explain'
): ResultBannerState {
  const durationMs =
    typeof rs.executionTimeMs === 'number' && Number.isFinite(rs.executionTimeMs)
      ? rs.executionTimeMs
      : fallbackDurationMs
  const preview = compactSqlPreview(statementSql || rs.sql || rs.sqlPreview || '')
  if (rs.isError) {
    return {
      kind: 'error',
      title: mode === 'explain' ? 'EXPLAIN Error' : 'SQL Execution Error',
      detail: rs.errorMessage || 'Query failed',
      dismissed: false,
      showBackToTable: true,
      errorText: rs.errorMessage || 'Query failed',
      isExplain: mode === 'explain',
    }
  }
  if (mode === 'explain') {
    const steps = rs.rowCount ?? rs.rows.length
    return {
      kind: 'success',
      title: `EXPLAIN OK · ${steps} plan ${steps === 1 ? 'step' : 'steps'} in ${durationMs}ms`,
      detail: preview,
      dismissed: false,
      isExplain: true,
    }
  }
  if (rs.isSelect) {
    const count = rs.rowCount ?? rs.rows.length
    const rowLabel = `${count} ${count === 1 ? 'row' : 'rows'}`
    const truncNote = rs.truncated ? ' (truncated)' : ''
    return {
      kind: 'success',
      title: `Query OK · ${rowLabel} returned in ${durationMs}ms${truncNote}`,
      detail: preview,
      dismissed: false,
    }
  }
  const affected = rs.affectedRows ?? 0
  return {
    kind: 'success',
    title: `Statement executed · ${affected} ${affected === 1 ? 'row' : 'rows'} affected in ${durationMs}ms`,
    detail: preview,
    dismissed: false,
  }
}

/**
 * Initializes per-result-set runtime states (banner, filters, grid snapshot placeholder).
 */
export function buildInitialResultTabStates(
  res: QueryResult,
  rawStatements: string[],
  overallSql: string,
  fallbackDurationMs: number,
  mode: 'query' | 'explain'
): Record<number, ResultSetTabRuntimeState> {
  const sets = getEffectiveResultSets(res, overallSql)
  const out: Record<number, ResultSetTabRuntimeState> = {}
  sets.forEach((rs, idx) => {
    const stmtSql =
      rs.sql ||
      (rawStatements.length === sets.length ? rawStatements[idx] : undefined) ||
      rs.sqlPreview ||
      overallSql
    const rowCount = rs.rowCount ?? rs.rows.length
    const rowLabel = `${rowCount} ${rowCount === 1 ? 'row' : 'rows'}`
    const defaultTitle = rs.isError
      ? sets.length > 1
        ? `Result ${idx + 1} · Error`
        : mode === 'explain'
          ? 'EXPLAIN Error'
          : 'SQL Error'
      : mode === 'explain'
        ? sets.length > 1
          ? `Result ${idx + 1} · Plan (${rowCount} steps)`
          : `Execution Plan · ${rowCount} steps`
        : !rs.isSelect
          ? sets.length > 1
            ? `Result ${idx + 1} · ${rs.affectedRows ?? 0} affected`
            : `Executed · ${rs.affectedRows ?? 0} affected`
          : sets.length > 1
            ? `Result ${idx + 1}`
            : 'SQL Result'

    out[idx] = {
      resultSetIndex: idx,
      baseStatementSql: stmtSql,
      statementSql: stmtSql,
      banner: buildBannerForResultSet(rs, stmtSql, fallbackDurationMs, mode),
      whereClause: '',
      orderByClause: '',
      searchMode: 'filter',
      clientSearchText: '',
      gridSnapshot: null,
      editableSqlTarget: null,
      activeEditableStmtSql: '',
      currentCanEdit: false,
      gridSubbarTitle: defaultTitle,
      gridPageInfo: rs.isError
        ? '0 rows'
        : !rs.isSelect
          ? `${rs.affectedRows ?? 0} affected`
          : rs.truncated
            ? `${rowLabel} (truncated)`
            : rowLabel,
      emptyMessage: rs.isError
        ? `${mode === 'explain' ? 'EXPLAIN' : 'Query'} error: ${rs.errorMessage || 'Failed'}`
        : mode === 'explain'
          ? 'No execution plan rows returned.'
          : rs.isSelect
            ? 'Query returned no rows.'
            : `Statement executed successfully (${rs.affectedRows ?? 0} affected rows).`,
    }
  })
  return out
}

/**
 * Aggregates individual EXPLAIN QueryResultSets into a single QueryResult payload.
 */
export function buildCombinedExplainResult(
  collectedSets: QueryResultSet[],
  firstNonError: QueryResult | null,
  totalMs: number
): QueryResult {
  const lead = firstNonError ?? {
    columns: collectedSets[0]?.columns ?? [],
    rows: collectedSets[0]?.rows ?? [],
    rowCount: collectedSets[0]?.rowCount ?? 0,
    executionTimeMs: totalMs,
    truncated: false,
    isSelect: true,
  }
  return {
    columns: lead.columns,
    rows: lead.rows,
    rowCount: lead.rowCount,
    executionTimeMs: totalMs,
    truncated: lead.truncated,
    isSelect: true,
    ...(collectedSets.length > 1 || collectedSets.some((s) => s.isError)
      ? { resultSets: collectedSets }
      : {}),
  }
}

/**
 * Determines whether the query status banner should be visible in the current Studio view mode.
 */
export function shouldShowQueryBannerForMode(
  viewMode: StudioViewMode,
  isShowingSqlResult: boolean,
  banner: ResultBannerState | null
): boolean {
  if (!banner || banner.dismissed) return false
  if (viewMode === 'inspector') return false
  if (viewMode === 'grid' && !isShowingSqlResult && banner.kind === 'success') {
    return false
  }
  return true
}
