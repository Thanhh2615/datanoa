import type {
  ApplyChangesParams,
  ApplyChangesResult,
  ColumnInfo,
  ConnectionProfile,
  FetchPageParams,
  IDatabaseDriver,
  IDatabaseSession,
  PreviewChangesResult,
  QueryResult,
  SchemaObject,
  TableBrowseResult,
  TableDetails,
  UpdateCellParams,
  UpdateCellResult,
} from '../common/driver'
import { DatabaseDriverError } from '../common/driver'
import {
  assembleTableBrowseResult,
  buildSelectPageSql,
  canBindOptimisticLockValue,
  formatSqlValue,
  quoteQualifiedTable,
} from '../common/update-builder'
import { quoteIdentForDialect, reconstructTableDdl, splitSqlStatements } from '../common/sql-tools'

const CLICKHOUSE_HTTP_TIMEOUT_MS = 30_000

interface ClickHouseJsonCompactResponse {
  meta?: Array<{ name: string; type: string }>
  data?: unknown[][]
  rows?: number
}

const CLICKHOUSE_ROW_RETURNING_REGEX =
  /^\s*\(*\s*(?:SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|EXISTS|WITH)\b/i
const CLICKHOUSE_FORMAT_SUFFIX_REGEX = /\bFORMAT\s+([A-Za-z0-9_]+)\s*;?\s*$/i

function buildClickHouseAbortSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(CLICKHOUSE_HTTP_TIMEOUT_MS)
  if (!signal) {
    return timeoutSignal
  }
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, timeoutSignal])
  }
  return signal
}

function normalizeClickHouseBaseUrl(profile: ConnectionProfile): string {
  if (profile.url && profile.url.trim().length > 0) {
    let raw = profile.url.trim().replace(/\/+$/, '')
    if (/^clickhouses:\/\//i.test(raw)) {
      raw = raw.replace(/^clickhouses:\/\//i, 'https://')
    } else if (/^clickhouse:\/\//i.test(raw)) {
      raw = raw.replace(/^clickhouse:\/\//i, 'http://')
    }
    return raw
  }

  const ssl = Boolean(profile.ssl)
  const proto = ssl ? 'https' : 'http'
  const host = profile.host || 'localhost'
  const port = profile.port || (ssl ? 8443 : 8123)
  return `${proto}://${host}:${port}`
}

function escapeClickHouseLiteralText(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/'/g, "''")
}

function stripLeadingComments(sql: string): string {
  let s = sql.trimStart()
  while (s.length > 0) {
    if (s.startsWith('--') || s.startsWith('#')) {
      const nl = s.indexOf('\n')
      s = nl >= 0 ? s.slice(nl + 1).trimStart() : ''
      continue
    }
    if (s.startsWith('/*')) {
      const end = s.indexOf('*/', 2)
      s = end >= 0 ? s.slice(end + 2).trimStart() : ''
      continue
    }
    break
  }
  return s
}

function isRowReturningClickHouseQuery(sql: string): boolean {
  const clean = stripLeadingComments(sql)
  return CLICKHOUSE_ROW_RETURNING_REGEX.test(clean)
}

function extractExplicitClickHouseFormat(sql: string): string | null {
  const stripped = sql.trim().replace(/;+\s*$/, '')
  const match = CLICKHOUSE_FORMAT_SUFFIX_REGEX.exec(stripped)
  return match ? match[1] : null
}

function prepareClickHouseSql(sql: string, forceJsonCompact: boolean): string {
  const stmts = splitSqlStatements(sql, 'clickhouse')
  const core = stmts.length === 1 ? stmts[0].text : sql.trim().replace(/;+\s*$/, '')
  const stripped = core.replace(/;+\s*$/, '')
  if (!forceJsonCompact || CLICKHOUSE_FORMAT_SUFFIX_REGEX.test(stripped)) {
    return stripped
  }
  const hasTrailingLineComment = /(?:--|#)[^\r\n]*$/.test(stripped)
  return hasTrailingLineComment
    ? `${stripped}\nFORMAT JSONCompact`
    : `${stripped} FORMAT JSONCompact`
}

function mapCompactRowsToObjects(
  meta: Array<{ name: string; type: string }>,
  data: unknown[][]
): Record<string, unknown>[] {
  return data.map((rowArr) => {
    const obj: Record<string, unknown> = {}
    for (let i = 0; i < meta.length; i++) {
      obj[meta[i].name] = rowArr[i]
    }
    return obj
  })
}

function buildClickHouseWhereSql(
  conditions: Record<string, unknown>,
  extraRow?: Record<string, unknown>,
  changeKeys?: string[]
): string {
  const parts: string[] = []
  for (const [col, val] of Object.entries(conditions)) {
    if (val === undefined) continue
    const qCol = quoteIdentForDialect(col, 'clickhouse')
    parts.push(val === null ? `${qCol} IS NULL` : `${qCol} = ${formatSqlValue(val, 'clickhouse')}`)
  }
  if (extraRow && changeKeys) {
    for (const col of changeKeys) {
      if (!Object.prototype.hasOwnProperty.call(extraRow, col)) continue
      const orig = extraRow[col]
      if (!canBindOptimisticLockValue(orig)) continue
      const qCol = quoteIdentForDialect(col, 'clickhouse')
      parts.push(orig === null ? `${qCol} IS NULL` : `${qCol} = ${formatSqlValue(orig, 'clickhouse')}`)
    }
  }
  return parts.join(' AND ')
}

function parseClickHouseKeyExpression(rawKey: unknown, validColumns: ReadonlySet<string>): string[] {
  if (typeof rawKey !== 'string' || !rawKey.trim()) return []
  const cleaned = rawKey.trim().replace(/^\((.*)\)$/, '$1').trim()
  if (!cleaned) return []
  const tokens = cleaned.split(',').map((part) => part.trim().replace(/^`|`$/g, '').replace(/^"|"$/g, ''))
  const resolved: string[] = []
  for (const tok of tokens) {
    if (!validColumns.has(tok)) {
      return []
    }
    resolved.push(tok)
  }
  return resolved
}

interface ActiveClickHouseQuery {
  controller: AbortController
  cancelled: boolean
  currentServerQueryId: string
}

export class ClickHouseSession implements IDatabaseSession {
  readonly driverType = 'clickhouse' as const
  readonly profile: ConnectionProfile
  private readonly baseUrl: string
  private readonly secret?: string
  private readonly activeQueries = new Map<string, ActiveClickHouseQuery>()
  private isClosed = false

  constructor(profile: ConnectionProfile, secret?: string) {
    this.profile = profile
    this.secret = secret
    this.baseUrl = normalizeClickHouseBaseUrl(profile)
  }

  isAlive(): boolean {
    return !this.isClosed
  }

  private getDatabase(): string {
    return this.profile.database || 'default'
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-ClickHouse-User': this.profile.user || 'default',
      'X-ClickHouse-Database': this.getDatabase(),
    }
    if (this.secret !== undefined) {
      headers['X-ClickHouse-Key'] = this.secret
    }
    return headers
  }

  private async executeHttp(
    sql: string,
    options?: {
      queryId?: string
      expectJsonCompact?: boolean
      signal?: AbortSignal
    }
  ): Promise<{
    json?: ClickHouseJsonCompactResponse
    summaryAffectedRows?: number
    rawText: string
  }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }

    const qid =
      options?.queryId || `ch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const url = new URL(`${this.baseUrl}/`)
    url.searchParams.set('query_id', qid)

    const bodySql = prepareClickHouseSql(sql, Boolean(options?.expectJsonCompact))

    const combinedSignal = buildClickHouseAbortSignal(options?.signal)
    let response: Response
    try {
      response = await fetch(url.toString(), {
        method: 'POST',
        headers: this.buildHeaders(),
        body: bodySql,
        signal: combinedSignal,
      })
    } catch (err: unknown) {
      const errName = (err as { name?: string })?.name
      if (options?.signal?.aborted) {
        throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'clickhouse', err)
      }
      if (errName === 'TimeoutError' || errName === 'AbortError') {
        throw new DatabaseDriverError(
          `ClickHouse HTTP request timed out after ${CLICKHOUSE_HTTP_TIMEOUT_MS}ms`,
          'TIMEOUT',
          'clickhouse',
          err
        )
      }
      throw new DatabaseDriverError(
        err instanceof Error ? err.message : 'ClickHouse HTTP request failed',
        'CONNECTION_FAILED',
        'clickhouse',
        err
      )
    }

    const text = await response.text()
    if (!response.ok) {
      throw new DatabaseDriverError(
        text.trim() || `ClickHouse HTTP error ${response.status}`,
        'CLICKHOUSE_ERROR',
        'clickhouse'
      )
    }

    let summaryAffectedRows: number | undefined
    const summaryHeader = response.headers.get('x-clickhouse-summary')
    if (summaryHeader) {
      try {
        const summary = JSON.parse(summaryHeader) as { written_rows?: string | number }
        if (summary.written_rows !== undefined) {
          const n = Number(summary.written_rows)
          if (Number.isFinite(n)) summaryAffectedRows = n
        }
      } catch {
        // Ignore malformed summary header
      }
    }

    if (options?.expectJsonCompact) {
      if (!text.trim()) {
        return { json: { meta: [], data: [], rows: 0 }, summaryAffectedRows, rawText: text }
      }
      try {
        const parsed = JSON.parse(text) as ClickHouseJsonCompactResponse
        return { json: parsed, summaryAffectedRows, rawText: text }
      } catch (err) {
        throw new DatabaseDriverError(
          `Failed to parse ClickHouse JSONCompact response: ${err instanceof Error ? err.message : String(err)}`,
          'CLICKHOUSE_PARSE_ERROR',
          'clickhouse',
          err
        )
      }
    }

    return { summaryAffectedRows, rawText: text }
  }

  async test(): Promise<{ ok: boolean; message?: string }> {
    if (this.isClosed) {
      return { ok: false, message: 'Session is closed' }
    }
    try {
      await this.executeHttp('SELECT 1', { expectJsonCompact: true })
      return { ok: true, message: 'ClickHouse connection valid' }
    } catch (err: unknown) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to connect to ClickHouse',
      }
    }
  }

  async close(): Promise<void> {
    if (this.isClosed) return
    this.isClosed = true
    for (const active of this.activeQueries.values()) {
      active.cancelled = true
      active.controller.abort()
    }
    this.activeQueries.clear()
  }

  async listObjects(schema?: string): Promise<SchemaObject[]> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    const targetDb = schema || this.getDatabase()
    const sql = `
      SELECT name, database AS schema, engine
      FROM system.tables
      WHERE database = '${escapeClickHouseLiteralText(targetDb)}'
      ORDER BY name ASC
    `
    const { json } = await this.executeHttp(sql, { expectJsonCompact: true })
    const meta = json?.meta || []
    const rows = mapCompactRowsToObjects(meta, json?.data || [])
    return rows.map((r) => {
      const engine = String(r.engine || '')
      const isView = /View$/i.test(engine)
      return {
        name: String(r.name),
        schema: String(r.schema || targetDb),
        kind: isView ? 'view' : 'table',
      }
    })
  }

  async getTableDetails(table: string, schema?: string): Promise<TableDetails> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    const targetDb = schema || this.getDatabase()
    const escapedDb = escapeClickHouseLiteralText(targetDb)
    const escapedTable = escapeClickHouseLiteralText(table)

    const colSql = `
      SELECT name, type, is_in_primary_key, is_in_sorting_key, default_kind, default_expression
      FROM system.columns
      WHERE database = '${escapedDb}' AND table = '${escapedTable}'
      ORDER BY position ASC
    `
    const tblSql = `
      SELECT engine, primary_key, sorting_key
      FROM system.tables
      WHERE database = '${escapedDb}' AND name = '${escapedTable}'
      LIMIT 1
    `

    const [colRes, tblRes] = await Promise.all([
      this.executeHttp(colSql, { expectJsonCompact: true }),
      this.executeHttp(tblSql, { expectJsonCompact: true }).catch(() => ({ json: undefined })),
    ])

    const colRows = mapCompactRowsToObjects(colRes.json?.meta || [], colRes.json?.data || [])
    const tblRows = mapCompactRowsToObjects(tblRes.json?.meta || [], tblRes.json?.data || [])
    const engine = String(tblRows[0]?.engine || '')
    const kind: 'table' | 'view' = /View$/i.test(engine) ? 'view' : 'table'

    const validColNames = new Set(colRows.map((c) => String(c.name)))
    let primaryKey = parseClickHouseKeyExpression(tblRows[0]?.primary_key, validColNames)
    if (primaryKey.length === 0) {
      primaryKey = parseClickHouseKeyExpression(tblRows[0]?.sorting_key, validColNames)
    }
    if (primaryKey.length === 0) {
      primaryKey = colRows
        .filter((c) => Number(c.is_in_primary_key) === 1)
        .map((c) => String(c.name))
    }
    if (primaryKey.length === 0) {
      primaryKey = colRows
        .filter((c) => Number(c.is_in_sorting_key) === 1)
        .map((c) => String(c.name))
    }

    const pkSet = new Set(primaryKey)
    const columns: ColumnInfo[] = colRows.map((c) => {
      const typeStr = String(c.type || 'String')
      const defaultExpr =
        c.default_expression !== null &&
        c.default_expression !== undefined &&
        String(c.default_expression).length > 0
          ? String(c.default_expression)
          : null

      return {
        name: String(c.name),
        type: typeStr,
        nativeType: typeStr,
        nullable: /^Nullable\(/i.test(typeStr),
        defaultValue: defaultExpr,
        isPrimaryKey: pkSet.has(String(c.name)),
        isAutoIncrement: false,
      }
    })

    return {
      name: table,
      schema: targetDb,
      kind,
      columns,
      primaryKey,
      indexes: [],
      foreignKeys: [],
    }
  }

  async fetchPage(params: FetchPageParams): Promise<TableBrowseResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    const targetDb = params.schema || this.getDatabase()
    const details = await this.getTableDetails(params.table, targetDb)

    const { sql, countSql, limit, offset } = buildSelectPageSql({
      driver: 'clickhouse',
      table: params.table,
      schema: targetDb,
      page: params.page,
      pageSize: params.pageSize,
      sortColumn: params.sortColumn,
      sortDirection: params.sortDirection,
      primaryKey: details.primaryKey,
      whereClause: params.whereClause,
      orderByClause: params.orderByClause,
    })

    const resolvedDataSql = sql.replace(
      /LIMIT \? OFFSET \?;?$/,
      `LIMIT ${limit} OFFSET ${offset}`
    )

    const [countRes, dataRes] = await Promise.all([
      this.executeHttp(countSql, { expectJsonCompact: true }),
      this.executeHttp(resolvedDataSql, { expectJsonCompact: true }),
    ])

    const countRows = mapCompactRowsToObjects(countRes.json?.meta || [], countRes.json?.data || [])
    const dataRows = mapCompactRowsToObjects(dataRes.json?.meta || [], dataRes.json?.data || [])

    return assembleTableBrowseResult({
      tableDetails: details,
      rows: dataRows,
      countRow: countRows[0] || { total: 0 },
      page: params.page,
      pageSize: params.pageSize,
    })
  }

  async updateCell(params: UpdateCellParams): Promise<UpdateCellResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    if (!params.primaryKeys || Object.keys(params.primaryKeys).length === 0) {
      throw new DatabaseDriverError(
        'Cannot update ClickHouse record without primary key conditions',
        'invalid_params',
        'clickhouse'
      )
    }

    const targetDb = params.schema || this.getDatabase()
    const qTable = quoteQualifiedTable(params.table, targetDb, 'clickhouse')
    const qCol = quoteIdentForDialect(params.column, 'clickhouse')
    const valSql = formatSqlValue(params.newValue, 'clickhouse')
    const whereSql = buildClickHouseWhereSql(
      params.primaryKeys,
      params.originalValue !== undefined ? { [params.column]: params.originalValue } : undefined,
      params.originalValue !== undefined ? [params.column] : undefined
    )

    const checkRes = await this.executeHttp(
      `SELECT COUNT(*) AS total FROM ${qTable} WHERE ${whereSql}`,
      { expectJsonCompact: true }
    )
    const checkRow = mapCompactRowsToObjects(checkRes.json?.meta || [], checkRes.json?.data || [])[0]
    const matchedRows = Number(checkRow?.total ?? checkRow?.['COUNT(*)'] ?? checkRow?.['count()'] ?? 0)
    if (!Number.isFinite(matchedRows) || matchedRows === 0) {
      throw new DatabaseDriverError(
        'Record was modified or deleted by another session (optimistic lock conflict)',
        'conflict',
        'clickhouse'
      )
    }

    await this.executeHttp(
      `ALTER TABLE ${qTable} UPDATE ${qCol} = ${valSql} WHERE ${whereSql} SETTINGS mutations_sync = 1`
    )

    const effectivePkConditions: Record<string, unknown> = { ...params.primaryKeys }
    if (Object.prototype.hasOwnProperty.call(effectivePkConditions, params.column)) {
      effectivePkConditions[params.column] = params.newValue
    }
    const pkWhere = buildClickHouseWhereSql(effectivePkConditions)
    let updatedRecord: Record<string, unknown> | undefined
    try {
      const sel = await this.executeHttp(
        `SELECT * FROM ${qTable} WHERE ${pkWhere} LIMIT 1`,
        { expectJsonCompact: true }
      )
      updatedRecord = mapCompactRowsToObjects(sel.json?.meta || [], sel.json?.data || [])[0]
    } catch {
      // Optional readback
    }

    return {
      ok: true,
      affectedRows: matchedRows,
      updatedRecord,
    }
  }

  private buildChangeStatements(params: ApplyChangesParams): {
    deletes: { preview: string; exec: string }[]
    updates: { preview: string; exec: string }[]
    inserts: { preview: string; exec: string }[]
  } {
    const targetDb = params.schema || this.getDatabase()
    const qTable = quoteQualifiedTable(params.table, targetDb, 'clickhouse')

    const deletes: { preview: string; exec: string }[] = []
    for (const pk of params.deletes ?? []) {
      const pkEntries = Object.entries(pk || {}).filter(([, v]) => v !== undefined)
      if (pkEntries.length === 0) {
        throw new DatabaseDriverError(
          'Cannot generate DELETE statement without primary key conditions (safety guard)',
          'invalid_params',
          'clickhouse'
        )
      }
      const whereSql = buildClickHouseWhereSql(pk)
      deletes.push({
        preview: `ALTER TABLE ${qTable} DELETE WHERE ${whereSql};`,
        exec: `ALTER TABLE ${qTable} DELETE WHERE ${whereSql} SETTINGS mutations_sync = 1`,
      })
    }

    const updates: { preview: string; exec: string }[] = []
    for (const upd of params.updates ?? []) {
      const pkEntries = Object.entries(upd.primaryKeys || {}).filter(([, v]) => v !== undefined)
      if (pkEntries.length === 0) {
        throw new DatabaseDriverError(
          'Cannot generate UPDATE statement without primary key conditions (safety guard)',
          'invalid_params',
          'clickhouse'
        )
      }
      const changeEntries = Object.entries(upd.changes || {}).filter(([, v]) => v !== undefined)
      if (changeEntries.length === 0) continue

      const setSql = changeEntries
        .map(
          ([col, val]) =>
            `${quoteIdentForDialect(col, 'clickhouse')} = ${formatSqlValue(val, 'clickhouse')}`
        )
        .join(', ')
      const whereSql = buildClickHouseWhereSql(
        upd.primaryKeys,
        upd.originalRow,
        changeEntries.map(([c]) => c)
      )
      updates.push({
        preview: `ALTER TABLE ${qTable} UPDATE ${setSql} WHERE ${whereSql};`,
        exec: `ALTER TABLE ${qTable} UPDATE ${setSql} WHERE ${whereSql} SETTINGS mutations_sync = 1`,
      })
    }

    const inserts: { preview: string; exec: string }[] = []
    for (const row of params.inserts ?? []) {
      const entries = Object.entries(row || {}).filter(([, v]) => v !== undefined)
      if (entries.length === 0) {
        throw new DatabaseDriverError(
          'ClickHouse INSERT requires at least one column value',
          'invalid_params',
          'clickhouse'
        )
      }
      const colsSql = entries.map(([c]) => quoteIdentForDialect(c, 'clickhouse')).join(', ')
      const valsSql = entries.map(([, v]) => formatSqlValue(v, 'clickhouse')).join(', ')
      const sql = `INSERT INTO ${qTable} (${colsSql}) VALUES (${valsSql});`
      inserts.push({ preview: sql, exec: sql })
    }

    return { deletes, updates, inserts }
  }

  async previewChanges(params: ApplyChangesParams): Promise<PreviewChangesResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    const built = this.buildChangeStatements(params)
    return {
      statements: [
        ...built.deletes.map((d) => d.preview),
        ...built.updates.map((u) => u.preview),
        ...built.inserts.map((i) => i.preview),
      ],
    }
  }

  async applyChanges(params: ApplyChangesParams): Promise<ApplyChangesResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    const built = this.buildChangeStatements(params)

    let deleted = 0
    for (const d of built.deletes) {
      await this.executeHttp(d.exec)
      deleted += 1
    }

    let updated = 0
    for (const u of built.updates) {
      await this.executeHttp(u.exec)
      updated += 1
    }

    let inserted = 0
    for (const i of built.inserts) {
      await this.executeHttp(i.exec)
      inserted += 1
    }

    return {
      ok: true,
      inserted,
      updated,
      deleted,
      statements: [
        ...built.deletes.map((d) => d.preview),
        ...built.updates.map((u) => u.preview),
        ...built.inserts.map((i) => i.preview),
      ],
    }
  }

  async getDdl(table: string, schema?: string): Promise<string> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    const targetDb = schema || this.getDatabase()
    const qTable = quoteQualifiedTable(table, targetDb, 'clickhouse')
    try {
      const { json } = await this.executeHttp(`SHOW CREATE TABLE ${qTable}`, {
        expectJsonCompact: true,
      })
      const firstRow = json?.data?.[0]
      if (Array.isArray(firstRow) && typeof firstRow[0] === 'string' && firstRow[0].trim()) {
        const stmt = firstRow[0].trim()
        return stmt.endsWith(';') ? stmt : `${stmt};`
      }
    } catch {
      // Fallback to metadata-based DDL reconstruction
    }

    const details = await this.getTableDetails(table, targetDb)
    return reconstructTableDdl(details, 'clickhouse')
  }

  async runQuery(queryId: string, sql: string, maxRows = 1000): Promise<QueryResult> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    const trimmed = sql.trim()
    if (!trimmed) {
      throw new DatabaseDriverError('SQL statement cannot be empty', 'invalid_params', 'clickhouse')
    }

    const controller = new AbortController()
    const active: ActiveClickHouseQuery = {
      controller,
      cancelled: false,
      currentServerQueryId: queryId,
    }
    this.activeQueries.set(queryId, active)

    const start = performance.now()
    const stmts = splitSqlStatements(trimmed, 'clickhouse').map((s) => s.text)
    const statementList = stmts.length > 0 ? stmts : [trimmed]

    try {
      let totalAffectedRows = 0
      let lastSelect: Omit<QueryResult, 'executionTimeMs'> | null = null

      for (let i = 0; i < statementList.length; i++) {
        const stmtSql = statementList[i]
        const serverQueryId = statementList.length === 1 ? queryId : `${queryId}_${i + 1}`
        active.currentServerQueryId = serverQueryId

        const expectRows = isRowReturningClickHouseQuery(stmtSql)
        const explicitFormat = extractExplicitClickHouseFormat(stmtSql)
        const isCustomNonJsonCompact =
          explicitFormat !== null && explicitFormat.toLowerCase() !== 'jsoncompact'

        const res = await this.executeHttp(stmtSql, {
          queryId: serverQueryId,
          expectJsonCompact: expectRows && !isCustomNonJsonCompact,
          signal: controller.signal,
        })
        if (!expectRows) {
          totalAffectedRows += res.summaryAffectedRows ?? 0
        } else if (isCustomNonJsonCompact) {
          const normalizedText = res.rawText.replace(/\r?\n$/, '')
          const rawLines = normalizedText.length > 0 ? normalizedText.split(/\r?\n/) : []
          const limit = maxRows > 0 ? maxRows : rawLines.length
          const truncated = rawLines.length > limit
          const rows = rawLines.slice(0, limit).map((line) => [line])
          lastSelect = {
            columns: [{ name: `result (${explicitFormat})`, type: 'String' }],
            rows,
            rowCount: rows.length,
            truncated,
            isSelect: true,
          }
        } else {
          const columns = (res.json?.meta || []).map((m) => ({
            name: m.name,
            type: m.type || 'String',
          }))
          const allRows = Array.isArray(res.json?.data) ? res.json.data : []
          const limit = maxRows > 0 ? maxRows : allRows.length
          const truncated = allRows.length > limit
          const rows = allRows.slice(0, limit)
          lastSelect = {
            columns,
            rows,
            rowCount: rows.length,
            truncated,
            isSelect: true,
          }
        }
      }

      const executionTimeMs = Math.round(performance.now() - start)
      return lastSelect
        ? { ...lastSelect, executionTimeMs }
        : {
            columns: [],
            rows: [],
            rowCount: 0,
            affectedRows: totalAffectedRows,
            executionTimeMs,
            truncated: false,
            isSelect: false,
          }
    } catch (err) {
      if (active.cancelled && !(err instanceof DatabaseDriverError && err.code === 'cancelled')) {
        throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'clickhouse', err)
      }
      throw err
    } finally {
      this.activeQueries.delete(queryId)
    }
  }

  async cancelQuery(queryId: string): Promise<{ ok: boolean }> {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'clickhouse')
    }
    const active = this.activeQueries.get(queryId)
    if (!active) {
      return { ok: true }
    }

    const targetServerQueryId = active.currentServerQueryId || queryId
    active.cancelled = true
    active.controller.abort()

    try {
      await this.executeHttp(
        `KILL QUERY WHERE query_id = '${escapeClickHouseLiteralText(targetServerQueryId)}' SYNC`
      )
    } catch {
      // Best-effort server-side kill
    }
    return { ok: true }
  }
}

export class ClickHouseDriver implements IDatabaseDriver {
  readonly type = 'clickhouse' as const

  async createSession(profile: ConnectionProfile, secret?: string): Promise<IDatabaseSession> {
    return new ClickHouseSession(profile, secret)
  }

  async testConnection(
    profile: ConnectionProfile,
    secret?: string
  ): Promise<{ ok: boolean; message?: string }> {
    let session: IDatabaseSession | null = null
    try {
      session = await this.createSession(profile, secret)
      return await session.test()
    } catch (err: unknown) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'ClickHouse connection failed',
      }
    } finally {
      if (session) {
        await session.close().catch(() => {})
      }
    }
  }
}
