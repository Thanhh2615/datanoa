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
  containsDdlStatement,
  hasExplainAnalyzeOption,
  isExplainTargetMutating,
  isMutatingStatement,
  splitSqlStatements,
  stripCommentsAndLiterals,
  stripLeadingSqlComments,
} from '../drivers/common/sql-tools'
import type { WorkerSchemaMetadataCache } from './ai-sql-context'
import {
  DEFAULT_MAX_QUERY_ROWS,
  MAX_QUERY_ROWS_CEILING,
  SAVED_QUERIES_STORAGE_KEY,
} from '../shared-constants'
import type { IDatabaseSession } from '../drivers/common/driver'
import {
  hasMssqlSemicolonlessTxControl,
  isMssqlReadOnlyBlocked,
  splitMssqlBatches,
} from '../drivers/common/mssql-sql'
import { isOracleImplicitCommitStatement, splitOracleStatements } from '../drivers/common/oracle-sql'
import {
  isMysqlAutoCommitOffStatement,
  isMysqlImplicitCommitStatement,
  SQL_STANDALONE_ROLLBACK_RE,
} from '../drivers/common/sql-lexer'
import type { SessionManager } from './session-manager'
import { TxOwnershipController } from './tx-ownership'
import {
  assertMutableConnection,
  createHostError,
  createSerializedQueue,
  executeSessionQuery,
  formatActionableWorkerErrorMessage,
  MAX_QUERY_HISTORY,
  MAX_SAVED_QUERIES,
  QUERY_HISTORY_STORAGE_KEY,
  READ_ONLY_MUTATION_ERROR,
  readClampedTimeoutSeconds,
  readHostConfigBackup,
  readSavedQueries,
  sanitizeSavedQueryInput,
  scrubAndEnhanceWorkerError,
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
  schemaCache?: WorkerSchemaMetadataCache
  txOwnership?: TxOwnershipController
  onHistoryChanged?: () => void
}

function scrubThrownError(err: unknown): unknown {
  return scrubAndEnhanceWorkerError(err)
}

async function executeSingleExplainPlan(
  tracker: QueryRuntimeTracker,
  session: IDatabaseSession,
  driver: DatabaseDriverType,
  queryId: string,
  explainSql: string,
  timeoutSeconds: number,
  signal: AbortSignal
): Promise<QueryResult> {
  const res = await executeSessionQuery(
    tracker,
    session,
    queryId,
    explainSql,
    DEFAULT_MAX_QUERY_ROWS,
    timeoutSeconds,
    signal
  )
  if (
    driver === 'oracle' &&
    /^EXPLAIN\s+PLAN\b/i.test(stripLeadingSqlComments(explainSql, 'oracle'))
  ) {
    const xplanRes = await executeSessionQuery(
      tracker,
      session,
      queryId,
      'SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY())',
      DEFAULT_MAX_QUERY_ROWS,
      timeoutSeconds,
      signal
    )
    return {
      ...xplanRes,
      executionTimeMs: (res.executionTimeMs || 0) + (xplanRes.executionTimeMs || 0),
      isSelect: true,
    }
  }
  return res
}

export interface ExplainPlanItem {
  rawStmt: string
  explainSql: string
}

const MONGODB_READONLY_EXPLAIN_CMDS: ReadonlySet<string> = new Set([
  'find',
  'aggregate',
  'count',
  'distinct',
  'explain',
])

const MONGODB_MUTATING_SHELL_METHODS: ReadonlySet<string> = new Set([
  'insertone',
  'insertmany',
  'insert',
  'updateone',
  'updatemany',
  'update',
  'replaceone',
  'deleteone',
  'deletemany',
  'remove',
  'findoneanddelete',
  'findoneandupdate',
  'findoneandreplace',
  'findandmodify',
  'bulkwrite',
  'drop',
  'dropdatabase',
  'createcollection',
  'createindex',
  'createindexes',
  'dropindex',
  'dropindexes',
  'renamecollection',
  'save',
])

function hasMongoWriteStageValue(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some((item) => hasMongoWriteStageValue(item))
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$out' || key === '$merge') return true
      if (hasMongoWriteStageValue(val)) return true
    }
  }
  return false
}

function stripMongoLeadingComments(raw: string): string {
  let i = 0
  const len = raw.length
  while (i < len) {
    while (i < len && /\s/.test(raw[i])) i++
    if (raw[i] === '/' && raw[i + 1] === '/') {
      const nl = raw.indexOf('\n', i + 2)
      i = nl < 0 ? len : nl + 1
      continue
    }
    if (raw[i] === '-' && raw[i + 1] === '-') {
      const nl = raw.indexOf('\n', i + 2)
      i = nl < 0 ? len : nl + 1
      continue
    }
    if (raw[i] === '/' && raw[i + 1] === '*') {
      const end = raw.indexOf('*/', i + 2)
      i = end < 0 ? len : end + 2
      continue
    }
    break
  }
  return raw.slice(i).trim()
}

function splitMongoStatements(script: string): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = []
  let start = 0
  let i = 0
  const len = script.length
  while (i < len) {
    const ch = script[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      i++
      while (i < len) {
        if (script[i] === '\\') {
          i += 2
          continue
        }
        if (script[i] === ch) {
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '/' && script[i + 1] === '/') {
      const nl = script.indexOf('\n', i + 2)
      i = nl < 0 ? len : nl + 1
      continue
    }
    if (ch === '/' && script[i + 1] === '*') {
      const end = script.indexOf('*/', i + 2)
      i = end < 0 ? len : end + 2
      continue
    }
    if (ch === ';') {
      const text = script.slice(start, i).trim()
      if (text && stripMongoLeadingComments(text).length > 0) {
        out.push({ text, start, end: i })
      }
      start = i + 1
    }
    i++
  }
  const tail = script.slice(start).trim()
  if (tail && stripMongoLeadingComments(tail).length > 0) {
    out.push({ text: tail, start, end: len })
  }
  return out
}

function findMatchingParenEnd(text: string, openIdx: number): number {
  let depth = 0
  let i = openIdx
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      i++
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2
          continue
        }
        if (text[i] === ch) {
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i + 2)
      i = nl < 0 ? text.length : nl + 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

function isMongoJsonCommandMutating(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj)
  if (keys.length === 0) return true
  const cmd = keys[0].toLowerCase()
  if (cmd === 'aggregate') {
    return hasMongoWriteStageValue(obj)
  }
  if (cmd === 'explain') {
    const inner = obj.explain
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return true
    return isMongoJsonCommandMutating(inner as Record<string, unknown>)
  }
  return !MONGODB_READONLY_EXPLAIN_CMDS.has(cmd)
}

function buildMongoExplainPlan(rawText: string, sqlBody: string, readOnly: boolean): ExplainPlanItem {
  const cleanBody = stripMongoLeadingComments(sqlBody)
  if (!cleanBody) {
    throw createHostError('invalid_params', 'MongoDB command cannot be empty')
  }

  if (cleanBody.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(cleanBody)
    } catch {
      throw createHostError('invalid_params', 'MongoDB JSON explain command must be valid JSON')
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw createHostError('invalid_params', 'MongoDB explain command must be a JSON object')
    }
    const obj = parsed as Record<string, unknown>
    const firstKey = Object.keys(obj)[0]?.toLowerCase() ?? ''
    if (firstKey === 'explain') {
      const verbosity = typeof obj.verbosity === 'string' ? obj.verbosity : 'queryPlanner'
      const mutatingTarget = isMongoJsonCommandMutating(obj)
      if (
        mutatingTarget &&
        (readOnly || verbosity === 'executionStats' || verbosity === 'allPlansExecution')
      ) {
        throw createHostError('not_permitted', READ_ONLY_MUTATION_ERROR)
      }
      return { rawStmt: rawText.trim(), explainSql: sqlBody }
    }
    const mutating = isMongoJsonCommandMutating(obj)
    if (readOnly && mutating) {
      throw createHostError('not_permitted', READ_ONLY_MUTATION_ERROR)
    }
    return {
      rawStmt: rawText.trim(),
      explainSql: JSON.stringify({ explain: obj }),
    }
  }

  const shellColPrefix =
    /^db\s*(?:\.\s*getCollection\s*\(\s*(?:"[^"]*"|'[^']*')\s*\)|\[\s*(?:"[^"]*"|'[^']*')\s*\]|\.\s*[A-Za-z_][A-Za-z0-9_$-]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_$-]*)*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/i
  const prefixMatch = shellColPrefix.exec(cleanBody)
  if (!prefixMatch) {
    const isDropDb = /^db\s*\.\s*dropDatabase\s*\(/i.test(cleanBody)
    if (readOnly && (isDropDb || /\.(?:insert|update|delete|remove|drop|create|bulkWrite)/i.test(cleanBody))) {
      throw createHostError('not_permitted', READ_ONLY_MUTATION_ERROR)
    }
    throw createHostError(
      'invalid_params',
      'MongoDB explain requires db.<collection>.find/aggregate(...) or a JSON command object.'
    )
  }

  const rootMethod = prefixMatch[1].toLowerCase()
  const argsOpenIdx = cleanBody.indexOf('(', prefixMatch[0].length - 1)
  const argsCloseIdx = argsOpenIdx >= 0 ? findMatchingParenEnd(cleanBody, argsOpenIdx) : -1
  const rootArgsText = argsOpenIdx >= 0 && argsCloseIdx > argsOpenIdx ? cleanBody.slice(argsOpenIdx + 1, argsCloseIdx) : ''
  const hasAggWriteStage =
    rootMethod === 'aggregate' && /(?:^|[{,]\s*)(?:["'])?\$(?:out|merge)(?:["'])?\s*:/i.test(rootArgsText)
  const isMutatingShell =
    MONGODB_MUTATING_SHELL_METHODS.has(rootMethod) || hasAggWriteStage

  const hasTrailingExplain = /\.explain\s*\(\s*([^)]*)\)\s*$/i.exec(cleanBody)
  if (hasTrailingExplain) {
    const explainArg = hasTrailingExplain[1]
    const runsExecutionStats = /executionStats|allPlansExecution/i.test(explainArg)
    if (isMutatingShell && (readOnly || runsExecutionStats)) {
      throw createHostError('not_permitted', READ_ONLY_MUTATION_ERROR)
    }
    return { rawStmt: rawText.trim(), explainSql: sqlBody }
  }

  if (isMutatingShell) {
    if (readOnly) {
      throw createHostError('not_permitted', READ_ONLY_MUTATION_ERROR)
    }
    throw createHostError(
      'invalid_params',
      'MongoDB explain only supports find and aggregate queries or JSON command objects.'
    )
  }

  if (rootMethod !== 'find' && rootMethod !== 'aggregate') {
    if (readOnly) {
      throw createHostError('not_permitted', READ_ONLY_MUTATION_ERROR)
    }
    throw createHostError(
      'invalid_params',
      `MongoDB explain is not supported for .${prefixMatch[1]}(). Use find() or aggregate().`
    )
  }

  const normalizedShell = sqlBody.replace(/\.toArray\s*\(\s*\)\s*$/i, '')
  return {
    rawStmt: rawText.trim(),
    explainSql: `${normalizedShell}.explain("queryPlanner")`,
  }
}

function hasStandaloneBatchGo(sqlBody: string): boolean {
  const clean = stripCommentsAndLiterals(sqlBody, 'mssql')
  return /(?:^|\r?\n)[ \t]*GO[ \t]*(?:;|$|\r?\n)/i.test(clean)
}

/**
 * Wraps a single SQL or MongoDB statement in dialect-appropriate EXPLAIN syntax and enforces
 * read-only and non-mutating EXPLAIN ANALYZE safety rules.
 */
export function buildExplainPlanForStatement(
  rawText: string,
  driver: DatabaseDriverType,
  readOnly: boolean
): ExplainPlanItem {
  const sqlBody = rawText.replace(/;+\s*$/, '').trim()
  if (driver === 'mongodb') {
    return buildMongoExplainPlan(rawText, sqlBody, readOnly)
  }

  const leadingStripped = stripLeadingSqlComments(sqlBody, driver)
  if (hasExplainAnalyzeOption(sqlBody, driver) && isExplainTargetMutating(sqlBody, driver)) {
    throw createHostError(
      'not_permitted',
      'EXPLAIN ANALYZE is not permitted for mutating statements in Explain mode.'
    )
  }

  if (driver === 'mssql') {
    const cleanMssql = stripCommentsAndLiterals(sqlBody, 'mssql')
    const batches = splitMssqlBatches(sqlBody)
    const checkBatches = batches.length > 0 ? batches : [sqlBody]
    if (readOnly && checkBatches.some((batch) => isMssqlReadOnlyBlocked(batch))) {
      throw createHostError('not_permitted', READ_ONLY_MUTATION_ERROR)
    }
    if (/^SET\s+(?:SHOWPLAN_ALL|SHOWPLAN_TEXT|SHOWPLAN_XML)\s+ON\b/i.test(leadingStripped)) {
      return { rawStmt: rawText.trim(), explainSql: rawText.trim() }
    }
    if (
      splitSqlStatements(sqlBody, 'mssql').length > 1 ||
      hasStandaloneBatchGo(sqlBody) ||
      /\bSET\s+(?:SHOWPLAN_ALL|SHOWPLAN_TEXT|SHOWPLAN_XML)\s+OFF\b/i.test(cleanMssql)
    ) {
      throw createHostError(
        'invalid_params',
        'Multi-statement SHOWPLAN is not supported for SQL Server; explain one statement at a time.'
      )
    }
    return {
      rawStmt: rawText.trim(),
      explainSql: `SET SHOWPLAN_ALL ON;\nGO\n${sqlBody}\nGO\nSET SHOWPLAN_ALL OFF;`,
    }
  }

  if (driver === 'oracle') {
    const oracleChunks = splitOracleStatements(sqlBody)
    if (oracleChunks.length === 0) {
      throw createHostError('invalid_params', 'SQL statement cannot be empty')
    }
    if (oracleChunks.length > 1) {
      throw createHostError(
        'invalid_params',
        'Oracle EXPLAIN PLAN supports only a single SQL statement at a time.'
      )
    }
    const singleChunk = oracleChunks[0]
    if (singleChunk.isPlSql) {
      throw createHostError('invalid_params', 'EXPLAIN PLAN does not support PL/SQL blocks')
    }
    const singleSql = singleChunk.text
    const singleLeading = stripLeadingSqlComments(singleSql, 'oracle')
    const explainSql = /^EXPLAIN\s+PLAN\b/i.test(singleLeading)
      ? singleSql
      : `EXPLAIN PLAN FOR ${singleSql}`
    if (readOnly && isMutatingStatement(explainSql, driver)) {
      throw createHostError('not_permitted', READ_ONLY_MUTATION_ERROR)
    }
    return { rawStmt: rawText.trim(), explainSql }
  }

  const explainSql = /^EXPLAIN\b/i.test(leadingStripped)
    ? sqlBody
    : driver === 'sqlite' || driver === 'libsql' || driver === 'd1'
      ? `EXPLAIN QUERY PLAN ${sqlBody}`
      : `EXPLAIN ${sqlBody}`

  if (readOnly && isMutatingStatement(explainSql, driver)) {
    throw createHostError('not_permitted', READ_ONLY_MUTATION_ERROR)
  }
  return { rawStmt: rawText.trim(), explainSql }
}

export function registerQueryAndTxHandlers({
  orca,
  registerHandler,
  sessionManager,
  tracker,
  schemaCache,
  txOwnership,
  onHistoryChanged,
}: QueryTxHandlersDeps): void {
  const historyQueue = createSerializedQueue()
  const savedQueriesQueue = createSerializedQueue()
  const isLiveDesktopHost = Boolean(orca.host && typeof orca.host.call === 'function')
  const tx = txOwnership ?? new TxOwnershipController()

  const readSessionTxState = (session: IDatabaseSession) =>
    typeof session.getTransactionState === 'function'
      ? session.getTransactionState()
      : { supported: false, active: false, autoCommit: true, statementCount: 0 }

  const isStandaloneTxEndStatement = (stmtText: string, driver: DatabaseDriverType): boolean => {
    const clean = stripLeadingSqlComments(stmtText, driver).trim()
    if (
      /^(?:COMMIT|END(?:\s+TRANSACTION|\s+WORK)?)\b/i.test(clean) ||
      SQL_STANDALONE_ROLLBACK_RE.test(clean)
    ) {
      return true
    }
    if (driver === 'postgres' || driver === 'cockroachdb') {
      return (
        /^ABORT(?:\s+(?:WORK|TRANSACTION))?\b/i.test(clean) ||
        /^PREPARE\s+TRANSACTION\b/i.test(clean)
      )
    }
    if (driver === 'mysql' || driver === 'mariadb') {
      return isMysqlImplicitCommitStatement(stmtText)
    }
    if (driver === 'oracle') {
      return isOracleImplicitCommitStatement(stmtText)
    }
    return false
  }

  const isStandaloneTxControlStatement = (
    stmtText: string,
    driver: DatabaseDriverType
  ): boolean => {
    const clean = stripLeadingSqlComments(stmtText, driver).trim()
    if (/^(?:BEGIN|START\s+TRANSACTION)\b/i.test(clean)) {
      return true
    }
    if ((driver === 'mysql' || driver === 'mariadb') && isMysqlAutoCommitOffStatement(stmtText)) {
      return true
    }
    if (driver === 'oracle' && /^SET\s+TRANSACTION\b/i.test(clean)) {
      return true
    }
    return isStandaloneTxEndStatement(stmtText, driver)
  }

  const classifyTxScript = (
    trimmed: string,
    driver: DatabaseDriverType
  ): { hasTxControl: boolean; hasTxEnd: boolean } => {
    if (driver === 'redis' || driver === 'mongodb') {
      return { hasTxControl: false, hasTxEnd: false }
    }
    if (driver === 'mssql') {
      return hasMssqlSemicolonlessTxControl(trimmed)
    }
    if (driver === 'oracle') {
      const chunks = splitOracleStatements(trimmed)
      const list = chunks.length > 0 ? chunks : [{ text: trimmed, isPlSql: false }]
      let hasTxControl = false
      let hasTxEnd = false
      for (const chunk of list) {
        if (chunk.isPlSql) {
          const strippedBody = stripCommentsAndLiterals(chunk.text, 'oracle')
          if (/\b(?:COMMIT|ROLLBACK)\b(?!\s+(?:TO|WORK\s+TO)\b)/i.test(strippedBody)) {
            hasTxControl = true
            hasTxEnd = true
          } else if (/\bSET\s+TRANSACTION\b/i.test(strippedBody)) {
            hasTxControl = true
          }
        } else {
          if (isStandaloneTxEndStatement(chunk.text, 'oracle')) {
            hasTxControl = true
            hasTxEnd = true
          } else if (isStandaloneTxControlStatement(chunk.text, 'oracle')) {
            hasTxControl = true
          }
        }
      }
      return { hasTxControl, hasTxEnd }
    }
    const parsedStmts = splitSqlStatements(trimmed, driver).map((s) => s.text)
    const stmtsToInspect = parsedStmts.length > 0 ? parsedStmts : [trimmed]
    const hasTxEnd = stmtsToInspect.some((s) => isStandaloneTxEndStatement(s, driver))
    const hasTxControl =
      hasTxEnd || stmtsToInspect.some((s) => isStandaloneTxControlStatement(s, driver))
    return { hasTxControl, hasTxEnd }
  }

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
        onHistoryChanged?.()
      } catch (err: unknown) {
        const msg = scrubCredentialsInText(err instanceof Error ? err.message : String(err))
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

    let session: IDatabaseSession
    try {
      session = await sessionManager.getSession(input.connectionId)
    } catch (err: unknown) {
      throw scrubThrownError(err)
    }
    if (signal.aborted || tracker.consumePreCancelledQuery(queryId)) {
      throw createHostError('cancelled', 'Query execution was cancelled')
    }

    const panelId = tx.getPanelId(ctx)
    const { hasTxControl: hasTxControlStmt, hasTxEnd: hasTxEndStmt } = classifyTxScript(
      trimmed,
      profile.driver
    )

    const startedAt = Date.now()
    let executionStarted = false
    try {
      let ranSerialized = false
      let serializedResult: QueryResult | undefined

      await tx.withLock(profile.id, async () => {
        const preState = readSessionTxState(session)
        const wasActive = Boolean(preState.active)
        const owner = tx.syncForSession(profile.id, session, preState)
        if (owner && owner.panelId !== panelId && (preState.active || !preState.autoCommit)) {
          throw createHostError(
            'forbidden',
            hasTxEndStmt
              ? 'Cannot commit or roll back a transaction opened by another editor panel.'
              : 'Another editor panel owns an active transaction on this connection. Commit or roll back that transaction before running queries from this panel.'
          )
        }
        const needsSerializedTx = Boolean(
          hasTxControlStmt || preState.active || !preState.autoCommit || owner
        )
        if (!needsSerializedTx) {
          return
        }
        ranSerialized = true
        executionStarted = true
        try {
          serializedResult = await executeSessionQuery(
            tracker,
            session,
            queryId,
            trimmed,
            maxRows,
            timeoutSeconds,
            signal
          )
        } finally {
          const postState = readSessionTxState(session)
          tx.reconcileAfterWrite(profile.id, session, panelId, wasActive, postState)
        }
      })

      let res: QueryResult
      if (ranSerialized && serializedResult !== undefined) {
        res = serializedResult
      } else {
        executionStarted = true
        try {
          res = await executeSessionQuery(
            tracker,
            session,
            queryId,
            trimmed,
            maxRows,
            timeoutSeconds,
            signal
          )
        } finally {
          const postState = readSessionTxState(session)
          if (postState.active || !postState.autoCommit) {
            await tx.withLock(profile.id, async () => {
              tx.reconcileAfterWrite(
                profile.id,
                session,
                panelId,
                false,
                readSessionTxState(session)
              )
            })
          }
        }
      }

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
      if (containsDdlStatement(trimmed, profile.driver)) {
        schemaCache?.invalidateConnection(profile.id)
      }
      return res
    } catch (err: unknown) {
      if (!executionStarted) {
        throw scrubThrownError(err)
      }
      const errorMessage = formatActionableWorkerErrorMessage(
        err instanceof Error ? err.message : String(err),
        err
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
      throw scrubThrownError(err)
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

    let explainStmts: Array<{ text: string }>
    if (profile.driver === 'mongodb') {
      explainStmts = splitMongoStatements(trimmed)
    } else if (profile.driver === 'oracle') {
      const oracleChunks = splitOracleStatements(trimmed)
      if (oracleChunks.some((chunk) => chunk.isPlSql)) {
        throw createHostError('invalid_params', 'EXPLAIN PLAN does not support PL/SQL blocks')
      }
      explainStmts = oracleChunks
    } else {
      explainStmts = splitSqlStatements(trimmed, profile.driver)
    }
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
    let session: IDatabaseSession
    try {
      session = await sessionManager.getSession(input.connectionId)
    } catch (err: unknown) {
      throw scrubThrownError(err)
    }
    if (signal.aborted || tracker.consumePreCancelledQuery(explainQueryId)) {
      throw createHostError('cancelled', 'Explain execution was cancelled')
    }

    const panelId = tx.getPanelId(ctx)
    const executeExplainPlans = async (): Promise<QueryResult> => {
      if (explainPlans.length === 1) {
        return await executeSingleExplainPlan(
          tracker,
          session,
          profile.driver,
          explainQueryId,
          explainPlans[0].explainSql,
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
        const res = await executeSingleExplainPlan(
          tracker,
          session,
          profile.driver,
          explainQueryId,
          plan.explainSql,
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
    }

    try {
      let ranSerialized = false
      let serializedResult: QueryResult | undefined
      await tx.withLock(profile.id, async () => {
        const preState = readSessionTxState(session)
        const wasActive = Boolean(preState.active)
        const owner = tx.syncForSession(profile.id, session, preState)
        if (owner && owner.panelId !== panelId && (preState.active || !preState.autoCommit)) {
          throw createHostError(
            'forbidden',
            'Another editor panel owns an active transaction on this connection. Commit or roll back that transaction before running queries from this panel.'
          )
        }
        const needsSerializedTx = Boolean(preState.active || !preState.autoCommit || owner)
        if (!needsSerializedTx) {
          return
        }
        ranSerialized = true
        try {
          serializedResult = await executeExplainPlans()
        } finally {
          const postState = readSessionTxState(session)
          tx.reconcileAfterWrite(profile.id, session, panelId, wasActive, postState)
        }
      })

      if (ranSerialized && serializedResult !== undefined) {
        return serializedResult
      }
      return await executeExplainPlans()
    } catch (err: unknown) {
      throw scrubThrownError(err)
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
    onHistoryChanged?.()
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

  registerHandler('tx.status', async (input, ctx) => {
    if (typeof input?.connectionId !== 'string' || input.connectionId.trim().length === 0) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    const connId = input.connectionId
    const session = await sessionManager.getSession(connId)
    const state = readSessionTxState(session)
    const owner = tx.syncForSession(connId, session, state)
    const panelId = tx.getPanelId(ctx)
    const withToken =
      owner && Boolean(panelId && owner.panelId === panelId)
        ? { ...state, txToken: owner.txToken }
        : state
    return sanitizeJsonPayload(withToken)
  })

  registerHandler('tx.begin', async (input, ctx) => {
    if (typeof input?.connectionId !== 'string' || input.connectionId.trim().length === 0) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    const connId = input.connectionId
    const panelId = tx.requirePanelId(ctx)
    return await tx.withLock(connId, async () => {
      await assertMutableConnection(sessionManager, connId)
      const session = await sessionManager.getSession(connId)
      const owner = tx.syncForSession(connId, session, readSessionTxState(session))
      if (owner && owner.panelId !== panelId) {
        throw createHostError(
          'forbidden',
          'Cannot begin a transaction while another editor panel owns a transaction on this connection.'
        )
      }
      const state = await session.beginTransaction()
      if (state.active || !state.autoCommit) {
        const txToken = tx.setOwner(connId, panelId, session)
        return sanitizeJsonPayload({ ...state, txToken })
      }
      tx.syncForSession(connId, session, state)
      return sanitizeJsonPayload(state)
    })
  })

  const settleTxOwnershipAfterEnd = (
    connId: string,
    panelId: string,
    session: IDatabaseSession,
    state: ReturnType<IDatabaseSession['getTransactionState']>
  ) => {
    if (!state.autoCommit) {
      const txToken = tx.setOwner(connId, panelId, session)
      return sanitizeJsonPayload({ ...state, txToken })
    }
    tx.clearOwner(connId)
    return sanitizeJsonPayload(state)
  }

  registerHandler('tx.commit', async (input, ctx) => {
    if (typeof input?.connectionId !== 'string' || input.connectionId.trim().length === 0) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    const connId = input.connectionId
    const panelId = tx.requirePanelId(ctx)
    return await tx.withLock(connId, async () => {
      await assertMutableConnection(sessionManager, connId)
      const session = await sessionManager.getSession(connId)
      const owner = tx.syncForSession(connId, session, readSessionTxState(session))
      if (owner && owner.panelId !== panelId) {
        throw createHostError(
          'forbidden',
          'Cannot commit a transaction opened by another editor panel.'
        )
      }
      const state = await session.commitTransaction()
      return settleTxOwnershipAfterEnd(connId, panelId, session, state)
    })
  })

  registerHandler('tx.rollback', async (input, ctx) => {
    if (typeof input?.connectionId !== 'string' || input.connectionId.trim().length === 0) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    const connId = input.connectionId
    const panelId = input.onlyIfOwner === true ? tx.getPanelId(ctx) : tx.requirePanelId(ctx)
    return await tx.withLock(connId, async () => {
      await assertMutableConnection(sessionManager, connId)
      const session = await sessionManager.getSession(connId)
      const currentState = readSessionTxState(session)
      const owner = tx.syncForSession(connId, session, currentState)
      if (input.onlyIfOwner === true) {
        const tokenMatches =
          input.txToken === undefined || (owner !== undefined && owner.txToken === input.txToken)
        if (!panelId || !owner || owner.panelId !== panelId || !tokenMatches) {
          return sanitizeJsonPayload(currentState)
        }
        let state = currentState
        if (currentState.active) {
          state = await session.rollbackTransaction()
        }
        if (!state.autoCommit) {
          state = await session.setAutoCommit(true)
        }
        tx.clearOwner(connId)
        return sanitizeJsonPayload(state)
      }
      if (owner && owner.panelId !== panelId) {
        throw createHostError(
          'forbidden',
          'Cannot roll back a transaction opened by another editor panel.'
        )
      }
      const state = await session.rollbackTransaction()
      return settleTxOwnershipAfterEnd(connId, panelId ?? tx.requirePanelId(ctx), session, state)
    })
  })

  registerHandler('tx.setAutoCommit', async (input, ctx) => {
    if (typeof input?.connectionId !== 'string' || input.connectionId.trim().length === 0) {
      throw createHostError('invalid_params', 'connectionId parameter is required')
    }
    if (typeof input.enabled !== 'boolean') {
      throw createHostError('invalid_params', 'enabled parameter must be a boolean')
    }
    const connId = input.connectionId
    const panelId = tx.requirePanelId(ctx)
    return await tx.withLock(connId, async () => {
      await assertMutableConnection(sessionManager, connId)
      const session = await sessionManager.getSession(connId)
      const owner = tx.syncForSession(connId, session, readSessionTxState(session))
      if (owner && owner.panelId !== panelId) {
        throw createHostError(
          'forbidden',
          'Cannot change Auto-Commit mode while another editor panel owns a transaction on this connection.'
        )
      }
      const state = await session.setAutoCommit(input.enabled)
      if (input.enabled || (!state.active && state.autoCommit)) {
        tx.clearOwner(connId)
        return sanitizeJsonPayload(state)
      }
      const txToken = tx.setOwner(connId, panelId, session)
      return sanitizeJsonPayload({ ...state, txToken })
    })
  })
}
