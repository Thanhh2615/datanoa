import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import {
  sanitizeJsonPayload,
  type DatabaseDriverType,
  type QueryHistoryEntry,
  type QueryResult,
  type QueryResultSet,
} from '../protocol'
import { detectRecognizableSqlCredential } from '../drivers/common/sql-credentials'
import {
  compactSql,
  hasExplainAnalyzeOption,
  isExplainTargetMutating,
  isMutatingStatement,
  splitSqlStatements,
  stripLeadingSqlComments,
} from '../drivers/common/sql-tools'
import {
  DEFAULT_MAX_QUERY_ROWS,
  MAX_QUERY_ROWS_CEILING,
  SAVED_QUERIES_STORAGE_KEY,
} from '../shared-constants'
import type { SessionManager } from './session-manager'
import {
  assertMutableConnection,
  createHostError,
  createSerializedQueue,
  executeSessionQuery,
  MAX_QUERY_HISTORY,
  MAX_SAVED_QUERIES,
  QUERY_HISTORY_STORAGE_KEY,
  READ_ONLY_MUTATION_ERROR,
  readClampedTimeoutSeconds,
  readHostConfigBackup,
  readSavedQueries,
  sanitizeSavedQueryInput,
  scrubCredentialsInText,
  writeHostConfigBackupPatch,
  type QueryRuntimeTracker,
  type WorkerRegisterHandler,
} from './worker-utils'

export interface QueryTxHandlersDeps {
  orca: OrcaWorkerApi
  registerHandler: WorkerRegisterHandler
  sessionManager: SessionManager
  tracker: QueryRuntimeTracker
}

interface ExplainPlanItem {
  rawStmt: string
  explainSql: string
}

/**
 * Wraps a single SQL statement in dialect-appropriate EXPLAIN syntax and enforces
 * read-only and non-mutating EXPLAIN ANALYZE safety rules.
 */
function buildExplainPlanForStatement(
  rawText: string,
  driver: DatabaseDriverType,
  readOnly: boolean
): ExplainPlanItem {
  const sqlBody = rawText.replace(/;+\s*$/, '').trim()
  const leadingStripped = stripLeadingSqlComments(sqlBody, driver)
  const explainSql = /^EXPLAIN\b/i.test(leadingStripped)
    ? sqlBody
    : driver === 'sqlite' || driver === 'libsql' || driver === 'd1'
      ? `EXPLAIN QUERY PLAN ${sqlBody}`
      : `EXPLAIN ${sqlBody}`

  if (readOnly && isMutatingStatement(explainSql, driver)) {
    throw createHostError('not_permitted', READ_ONLY_MUTATION_ERROR)
  }
  if (
    hasExplainAnalyzeOption(explainSql, driver) &&
    isExplainTargetMutating(sqlBody, driver)
  ) {
    throw createHostError(
      'not_permitted',
      'EXPLAIN ANALYZE is not permitted for mutating statements in Explain mode.'
    )
  }
  return { rawStmt: rawText.trim(), explainSql }
}

export function registerQueryAndTxHandlers({
  orca,
  registerHandler,
  sessionManager,
  tracker,
}: QueryTxHandlersDeps): void {
  const historyQueue = createSerializedQueue()
  const savedQueriesQueue = createSerializedQueue()
  const isLiveDesktopHost = Boolean(orca.host && typeof orca.host.call === 'function')

  const recordQueryHistory = (entry: QueryHistoryEntry): Promise<void> => {
    try {
      if (detectRecognizableSqlCredential(entry.sql, entry.driver) !== null) {
        return Promise.resolve()
      }
    } catch {
      // Best-effort history guard must never throw into query callers
    }
    return historyQueue.run(async () => {
      try {
        const existing = (await orca.storage.get(
          QUERY_HISTORY_STORAGE_KEY
        )) as QueryHistoryEntry[] | null
        const list = Array.isArray(existing) ? existing : []
        const next = [sanitizeJsonPayload(entry), ...list].slice(0, MAX_QUERY_HISTORY)
        await orca.storage.set(
          QUERY_HISTORY_STORAGE_KEY,
          sanitizeJsonPayload(next) as unknown as JsonValue
        )
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        orca.log(`[Worker] Failed to persist query history: ${msg}`)
      }
    })
  }

  registerHandler('query.run', async (input, ctx): Promise<QueryResult> => {
    if (!input?.sql || typeof input.sql !== 'string') {
      throw createHostError('invalid_params', 'SQL string is required')
    }
    const trimmed = input.sql.trim()
    if (!trimmed) {
      throw createHostError('invalid_params', 'SQL statement cannot be empty')
    }
    if (!input.connectionId) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }

    const signal = ctx?.signal ?? new AbortController().signal
    if (signal.aborted) {
      throw createHostError('cancelled', 'Query was cancelled prior to execution')
    }

    const profile = await sessionManager.findProfile(input.connectionId)
    if (!profile) {
      throw createHostError('invalid_params', `Connection '${input.connectionId}' not found in storage`)
    }
    if (profile.readOnly && isMutatingStatement(trimmed, profile.driver)) {
      throw createHostError('not_permitted', READ_ONLY_MUTATION_ERROR)
    }

    const settingMaxRows = Number(await orca.settings.get('maxRows'))
    const defaultMaxRows =
      Number.isFinite(settingMaxRows) && settingMaxRows > 0
        ? Math.max(1, Math.min(MAX_QUERY_ROWS_CEILING, Math.floor(settingMaxRows)))
        : DEFAULT_MAX_QUERY_ROWS
    const reqMaxRows = Number(input.maxRows)
    const maxRows =
      Number.isFinite(reqMaxRows) && reqMaxRows > 0
        ? Math.max(1, Math.min(MAX_QUERY_ROWS_CEILING, Math.floor(reqMaxRows)))
        : defaultMaxRows

    const timeoutSeconds = await readClampedTimeoutSeconds(orca)
    const queryId =
      input.queryId || `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

    if (signal.aborted || tracker.consumePreCancelledQuery(queryId)) {
      throw createHostError('cancelled', 'Query execution was cancelled')
    }

    const session = await sessionManager.getSession(input.connectionId)
    if (signal.aborted || tracker.consumePreCancelledQuery(queryId)) {
      throw createHostError('cancelled', 'Query execution was cancelled')
    }

    const startedAt = Date.now()
    try {
      const res = await executeSessionQuery(
        tracker,
        session,
        queryId,
        trimmed,
        maxRows,
        timeoutSeconds,
        signal
      )
      await recordQueryHistory({
        id: queryId,
        timestamp: Date.now(),
        connectionId: profile.id,
        connectionName: profile.name,
        driver: profile.driver,
        sql: trimmed,
        durationMs:
          typeof res.executionTimeMs === 'number' ? res.executionTimeMs : Date.now() - startedAt,
        rowCount: typeof res.rowCount === 'number' ? res.rowCount : 0,
        isError: false,
      })
      return res
    } catch (err: unknown) {
      const errorMessage = scrubCredentialsInText(
        err instanceof Error ? err.message : String(err)
      )
      await recordQueryHistory({
        id: queryId,
        timestamp: Date.now(),
        connectionId: profile.id,
        connectionName: profile.name,
        driver: profile.driver,
        sql: trimmed,
        durationMs: Date.now() - startedAt,
        rowCount: 0,
        isError: true,
        errorMessage,
      })
      throw err
    }
  })

  registerHandler('query.explain', async (input, ctx): Promise<QueryResult> => {
    if (!input?.connectionId) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    if (!input?.sql || typeof input.sql !== 'string') {
      throw createHostError('invalid_params', 'SQL string is required')
    }
    const trimmed = input.sql.trim()
    if (!trimmed) {
      throw createHostError('invalid_params', 'SQL statement cannot be empty')
    }
    const signal = ctx?.signal ?? new AbortController().signal
    if (signal.aborted) {
      throw createHostError('cancelled', 'Explain was cancelled prior to execution')
    }

    const profile = await sessionManager.findProfile(input.connectionId)
    if (!profile) {
      throw createHostError('invalid_params', `Connection '${input.connectionId}' not found in storage`)
    }

    if (profile.driver === 'redis') {
      const tokens = trimmed.split(/\s+/)
      const cmd = (tokens[0] || '').replace(/^["']|["']$/g, '').toUpperCase()
      const mutating = isMutatingStatement(trimmed, 'redis')
      return {
        columns: [
          { name: 'command', type: 'TEXT' },
          { name: 'mode', type: 'TEXT' },
          { name: 'diagnostic', type: 'TEXT' },
        ],
        rows: [
          [
            cmd,
            mutating ? 'write' : 'read-only',
            `Redis command ${cmd} (${tokens.length} argument(s)). Redis executes commands sequentially without SQL query plans.`,
          ],
        ],
        rowCount: 1,
        executionTimeMs: 0,
        truncated: false,
        isSelect: true,
      }
    }

    const explainStmts = splitSqlStatements(trimmed, profile.driver)
    if (explainStmts.length === 0) {
      throw createHostError('invalid_params', 'SQL statement cannot be empty')
    }

    const explainPlans = explainStmts.map((stmt) =>
      buildExplainPlanForStatement(stmt.text, profile.driver, Boolean(profile.readOnly))
    )

    const explainQueryId =
      typeof input.queryId === 'string' && input.queryId.trim().length > 0
        ? input.queryId.trim()
        : `explain_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

    if (signal.aborted || tracker.consumePreCancelledQuery(explainQueryId)) {
      throw createHostError('cancelled', 'Explain execution was cancelled')
    }

    const timeoutSeconds = await readClampedTimeoutSeconds(orca)
    const session = await sessionManager.getSession(input.connectionId)
    if (signal.aborted || tracker.consumePreCancelledQuery(explainQueryId)) {
      throw createHostError('cancelled', 'Explain execution was cancelled')
    }

    if (explainPlans.length === 1) {
      return await executeSessionQuery(
        tracker,
        session,
        explainQueryId,
        explainPlans[0].explainSql,
        DEFAULT_MAX_QUERY_ROWS,
        timeoutSeconds,
        signal
      )
    }

    const totalStart = performance.now()
    const collectedSets: QueryResultSet[] = []
    let lastPlanResult: QueryResult | null = null
    for (let i = 0; i < explainPlans.length; i++) {
      if (signal.aborted || tracker.consumePreCancelledQuery(explainQueryId)) {
        throw createHostError('cancelled', 'Explain execution was cancelled')
      }
      const plan = explainPlans[i]
      const stmtStart = performance.now()
      const res = await executeSessionQuery(
        tracker,
        session,
        explainQueryId,
        plan.explainSql,
        DEFAULT_MAX_QUERY_ROWS,
        timeoutSeconds,
        signal
      )
      const stmtMs = Math.round(performance.now() - stmtStart)
      lastPlanResult = res
      collectedSets.push({
        index: i,
        sqlPreview: compactSql(plan.rawStmt),
        sql: plan.rawStmt,
        executionTimeMs: stmtMs,
        columns: res.columns,
        rows: res.rows,
        rowCount: res.rowCount,
        truncated: res.truncated,
        isSelect: true,
      })
    }

    const totalMs = Math.round(performance.now() - totalStart)
    return {
      columns: lastPlanResult?.columns ?? [],
      rows: lastPlanResult?.rows ?? [],
      rowCount: lastPlanResult?.rowCount ?? 0,
      executionTimeMs: totalMs,
      truncated: Boolean(lastPlanResult?.truncated),
      isSelect: true,
      resultSets: collectedSets,
    }
  })

  registerHandler('query.history.list', async (input) => {
    await historyQueue.waitIdle()
    const raw = (await orca.storage.get(QUERY_HISTORY_STORAGE_KEY)) as QueryHistoryEntry[] | null
    const all = Array.isArray(raw) ? raw : []
    const reqLimit = Number(input?.limit)
    const limit =
      Number.isFinite(reqLimit) && reqLimit >= 1
        ? Math.min(MAX_QUERY_HISTORY, Math.floor(reqLimit))
        : MAX_QUERY_HISTORY
    return { entries: all.slice(0, limit) }
  })

  registerHandler('query.history.clear', async () => {
    await historyQueue.run(async () => {
      await orca.storage.set(QUERY_HISTORY_STORAGE_KEY, [])
    })
    return { ok: true }
  })

  registerHandler('queries.saved.list', async () => {
    await savedQueriesQueue.waitIdle()
    let entries = readSavedQueries(await orca.storage.get(SAVED_QUERIES_STORAGE_KEY))
    if (entries.length === 0 && isLiveDesktopHost) {
      entries = await savedQueriesQueue.run(async () => {
        const latest = readSavedQueries(await orca.storage.get(SAVED_QUERIES_STORAGE_KEY))
        if (latest.length > 0) return latest
        const backup = await readHostConfigBackup()
        const restored = readSavedQueries(backup?.savedQueries)
        if (restored.length > 0) {
          await orca.storage.set(
            SAVED_QUERIES_STORAGE_KEY,
            sanitizeJsonPayload(restored) as unknown as JsonValue
          )
          return restored
        }
        return latest
      })
    }
    return { entries: entries.slice(0, MAX_SAVED_QUERIES) }
  })

  registerHandler('queries.saved.save', async (input) => {
    const sanitized = sanitizeSavedQueryInput({
      name: input?.name,
      sql: input?.sql,
      description: input?.description,
      dialect: input?.dialect,
      tags: input?.tags,
    })
    const requestedId =
      typeof input?.id === 'string' && input.id.trim().length > 0 ? input.id.trim() : undefined

    return await savedQueriesQueue.run(async () => {
      const entries = readSavedQueries(await orca.storage.get(SAVED_QUERIES_STORAGE_KEY))
      const now = Date.now()
      let entry = requestedId ? entries.find((item) => item.id === requestedId) : undefined

      if (entry) {
        entry.name = sanitized.name
        entry.sql = sanitized.sql
        entry.description = sanitized.description
        entry.dialect = sanitized.dialect
        entry.tags = sanitized.tags
        entry.updatedAt = now
      } else {
        entry = {
          id: `sq_${now}_${Math.random().toString(36).slice(2, 8)}`,
          name: sanitized.name,
          sql: sanitized.sql,
          description: sanitized.description,
          dialect: sanitized.dialect,
          tags: sanitized.tags,
          createdAt: now,
          updatedAt: now,
        }
        entries.push(entry)
      }

      const next = entries
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_SAVED_QUERIES)
      await orca.storage.set(
        SAVED_QUERIES_STORAGE_KEY,
        sanitizeJsonPayload(next) as unknown as JsonValue
      )
      if (isLiveDesktopHost) {
        await writeHostConfigBackupPatch({ savedQueries: next })
      }
      return { ok: true, entry: sanitizeJsonPayload(entry) }
    })
  })

  registerHandler('queries.saved.delete', async (input) => {
    if (typeof input?.id !== 'string' || input.id.trim().length === 0) {
      throw createHostError('invalid_params', 'Saved query id is required')
    }
    const id = input.id.trim()
    await savedQueriesQueue.run(async () => {
      const entries = readSavedQueries(await orca.storage.get(SAVED_QUERIES_STORAGE_KEY))
      const next = entries.filter((entry) => entry.id !== id)
      await orca.storage.set(
        SAVED_QUERIES_STORAGE_KEY,
        sanitizeJsonPayload(next) as unknown as JsonValue
      )
      if (isLiveDesktopHost) {
        await writeHostConfigBackupPatch({ savedQueries: next })
      }
    })
    return { ok: true }
  })

  registerHandler('query.cancel', async (input) => {
    if (!input?.queryId) {
      throw createHostError('invalid_params', 'queryId parameter is required')
    }

    const activeSession = tracker.activeQuerySessions.get(input.queryId)
    if (activeSession) {
      await activeSession.cancelQuery(input.queryId).catch(() => {})
      tracker.activeQuerySessions.delete(input.queryId)
    } else {
      tracker.markQueryPreCancelled(input.queryId)
      for (const s of sessionManager.getActiveSessions().values()) {
        try {
          await s.cancelQuery(input.queryId)
        } catch {
          // Ignore
        }
      }
    }

    return { ok: true }
  })

  registerHandler('tx.status', async (input) => {
    if (typeof input?.connectionId !== 'string' || input.connectionId.trim().length === 0) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    const session = await sessionManager.getSession(input.connectionId)
    return sanitizeJsonPayload(session.getTransactionState())
  })

  registerHandler('tx.begin', async (input) => {
    if (typeof input?.connectionId !== 'string' || input.connectionId.trim().length === 0) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    await assertMutableConnection(sessionManager, input.connectionId)
    const session = await sessionManager.getSession(input.connectionId)
    const state = await session.beginTransaction()
    return sanitizeJsonPayload(state)
  })

  registerHandler('tx.commit', async (input) => {
    if (typeof input?.connectionId !== 'string' || input.connectionId.trim().length === 0) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    await assertMutableConnection(sessionManager, input.connectionId)
    const session = await sessionManager.getSession(input.connectionId)
    const state = await session.commitTransaction()
    return sanitizeJsonPayload(state)
  })

  registerHandler('tx.rollback', async (input) => {
    if (typeof input?.connectionId !== 'string' || input.connectionId.trim().length === 0) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    await assertMutableConnection(sessionManager, input.connectionId)
    const session = await sessionManager.getSession(input.connectionId)
    const state = await session.rollbackTransaction()
    return sanitizeJsonPayload(state)
  })

  registerHandler('tx.setAutoCommit', async (input) => {
    if (typeof input?.connectionId !== 'string' || input.connectionId.trim().length === 0) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    if (typeof input.enabled !== 'boolean') {
      throw createHostError('invalid_params', 'enabled parameter must be a boolean')
    }
    await assertMutableConnection(sessionManager, input.connectionId)
    const session = await sessionManager.getSession(input.connectionId)
    const state = await session.setAutoCommit(input.enabled)
    return sanitizeJsonPayload(state)
  })
}
