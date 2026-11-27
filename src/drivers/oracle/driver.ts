import * as crypto from 'node:crypto'
import oracledb, {
  BLOB,
  CLOB,
  NCLOB,
  OUT_FORMAT_ARRAY,
  OUT_FORMAT_OBJECT,
  type ConnectionAttributes,
  type ExecuteOptions,
} from '../../../vendor/oracledb.js'
import type {
  ConnectionProfile,
  QueryResult,
  QueryResultSet,
  SchemaErGraph,
  SchemaObject,
  SchemaObjectKind,
  TableBrowseResult,
  TableDetails,
  TransactionState,
} from '../../protocol'
import { sanitizeJsonPayload } from '../../protocol'
import { parseExplainPlan } from '../../shared-explain-plan.js'
import {
  buildSchemaErGraphFromCatalogRows,
  type RawErColumnRow,
  type RawErForeignKeyRow,
  type RawErTableRow,
  type RawErUniqueSetRow,
} from '../common/schema-er-graph'
import {
  DatabaseDriverError,
  areChunksAlignedWithSqlSlices,
  attachFailedStatementMeta,
  copyFailedStatementMeta,
  runDriverConnectionTest,
  type ApplyChangesParams,
  type ApplyChangesResult,
  type ExplainResult,
  type FetchPageParams,
  type IDatabaseDriver,
  type IDatabaseSession,
  type PreviewChangesResult,
  type UpdateCellParams,
  type UpdateCellResult,
} from '../common/driver'
import {
  isOracleImplicitCommitStatement,
  splitOracleStatements,
  type OracleStatementChunk,
} from '../common/oracle-sql'
import {
  collectAndAssembleSchemaDdl,
  introspectOracleObjectDdl,
  introspectOracleObjects,
  introspectOracleSchemas,
  introspectOracleTableDetails,
  TableDetailsCache,
} from '../common/schema'
import {
  compactSql,
  containsDdlStatement,
  hasExplainAnalyzeOption,
  isExplainTargetMutating,
  isMutatingStatement,
  quoteIdentForDialect,
  splitSqlStatements,
  stripCommentsAndLiterals,
  stripLeadingSqlComments,
} from '../common/sql-tools'
import { type DriverTlsOptions, resolveEffectiveTlsOptions } from '../common/tls-and-tunnel'
import {
  assembleTableBrowseResult,
  buildBatchStatements,
  buildSelectByPrimaryKeySql,
  buildSelectPageSql,
  buildUpdateSql,
  projectDeleteRowsToPrimaryKeys,
} from '../common/update-builder'
import { scrubDriverErrorText } from '../common/sql-credentials'

export { splitOracleStatements, type OracleStatementChunk }

function getOracleOutFormatObject(): number {
  return OUT_FORMAT_OBJECT
}

function getOracleOutFormatArray(): number {
  return OUT_FORMAT_ARRAY
}

export interface OracleMetadataLike {
  name?: string
  dbTypeName?: string
  fetchType?: number
}

export interface OracleResultLike {
  metaData?: OracleMetadataLike[]
  rows?: unknown[]
  rowsAffected?: number
}

export interface OracleConnectionLike {
  execute(
    sql: string,
    binds?: unknown,
    options?: ExecuteOptions | Record<string, unknown>
  ): Promise<OracleResultLike>
  commit(): Promise<void>
  rollback(): Promise<void>
  breakExecution?: () => Promise<void>
  break?: (cb?: (err?: Error) => void) => Promise<void> | void
  isHealthy?: () => boolean
  close(): Promise<void>
  callTimeout?: number
}

export interface OracleBuiltConfig {
  attrs: ConnectionAttributes
  currentSchema?: string
  usedDatabaseAsService: boolean
  defaultSchema: string
  tlsServername?: string
}

interface OracleLobLike {
  getData(): Promise<string | Buffer>
}

interface ActiveOracleQuery {
  cancelled: boolean
}

const ORACLE_READONLY_BLOCK_RE =
  /^\s*\(*\s*(?:BEGIN|DECLARE|CALL|EXEC(?:UTE)?|LOCK\s+TABLE|PURGE|FLASHBACK|RENAME|COMMENT\s+ON|AUDIT|NOAUDIT|ANALYZE|GRANT|REVOKE|MERGE|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|SAVEPOINT)\b/i

let oracleLobDefaultsApplied = false

function ensureOracleLobFetchDefaults(): void {
  if (oracleLobDefaultsApplied) return
  oracleLobDefaultsApplied = true
  if (oracledb && typeof oracledb === 'object') {
    if (CLOB !== undefined && NCLOB !== undefined) {
      oracledb.fetchAsString = [CLOB, NCLOB]
    }
    if (BLOB !== undefined) {
      oracledb.fetchAsBuffer = [BLOB]
    }
  }
}

function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;\s*$/, '').trimEnd()
}

function isOracleReadOnlyBlocked(chunk: OracleStatementChunk): boolean {
  if (chunk.isPlSql) return true
  if (isMutatingStatement(chunk.text, 'oracle')) return true
  const stmts = splitSqlStatements(chunk.text, 'oracle')
  const list = stmts.length > 0 ? stmts.map((s) => s.text) : [chunk.text]
  for (const s of list) {
    const clean = stripCommentsAndLiterals(s, 'oracle', false).trim()
    if (ORACLE_READONLY_BLOCK_RE.test(clean)) return true
  }
  return false
}

function isStandaloneCommit(sql: string): boolean {
  const clean = stripCommentsAndLiterals(sql, 'oracle', false).trim().replace(/;+$/, '').trim()
  return /^COMMIT(?:\s+WORK)?$/i.test(clean)
}

function isStandaloneRollback(sql: string): boolean {
  const clean = stripCommentsAndLiterals(sql, 'oracle', false).trim().replace(/;+$/, '').trim()
  return /^ROLLBACK(?:\s+WORK)?$/i.test(clean)
}

function normalizeOracleSchemaIdentifier(raw: string | undefined, fallback = 'SYSTEM'): string {
  const trimmed = (raw || '').trim()
  if (!trimmed) return fallback.toUpperCase()
  return trimmed === trimmed.toLowerCase() ? trimmed.toUpperCase() : trimmed
}

function sanitizeCurrentSchemaIdentifier(schema: string): string {
  const cleaned = schema.trim().replace(/"/g, '')
  return `"${cleaned}"`
}

function extractOracleErrorCode(err: unknown): { code?: string; errorNum?: number } {
  if (!err || typeof err !== 'object') return {}
  const rec = err as { code?: unknown; errorNum?: unknown; message?: unknown }
  const code = typeof rec.code === 'string' ? rec.code : undefined
  const errorNum = typeof rec.errorNum === 'number' ? rec.errorNum : undefined
  if (errorNum === undefined && typeof rec.message === 'string') {
    const match = /\bORA-(\d{4,5})\b/.exec(rec.message)
    if (match) {
      return { code, errorNum: Number(match[1]) }
    }
  }
  return { code, errorNum }
}

function extractOracleErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) {
    return scrubDriverErrorText(err.message) || fallback
  }
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message
    if (typeof msg === 'string' && msg.trim()) {
      return scrubDriverErrorText(msg) || fallback
    }
  }
  return typeof err === 'string' && err.trim()
    ? scrubDriverErrorText(err) || fallback
    : fallback
}

function scrubOracleError(err: unknown): unknown {
  if (err instanceof Error && err.message) {
    const clean = scrubDriverErrorText(err.message)
    if (clean !== err.message) {
      try {
        err.message = clean
      } catch {
        return copyFailedStatementMeta(
          err,
          new DatabaseDriverError(clean, extractOracleErrorCode(err).code || 'ORACLE_ERROR', 'oracle', err)
        )
      }
    }
  }
  return err
}

function coerceOracleBindValue(value: unknown): unknown {
  if (value === undefined) return null
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  }
  return value
}

function toOracleBindObject(params?: unknown[]): Record<string, unknown> {
  const binds: Record<string, unknown> = {}
  if (!params || params.length === 0) return binds
  for (let i = 0; i < params.length; i++) {
    binds[`p${i + 1}`] = coerceOracleBindValue(params[i])
  }
  return binds
}

function isOracleLobLike(val: unknown): val is OracleLobLike {
  return (
    typeof val === 'object' &&
    val !== null &&
    'getData' in val &&
    typeof (val as { getData?: unknown }).getData === 'function'
  )
}

async function serializeOracleCell(value: unknown): Promise<unknown> {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) {
    const bounded = value.byteLength > 1024 * 1024 ? value.subarray(0, 1024 * 1024) : value
    return sanitizeJsonPayload(bounded)
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return sanitizeJsonPayload(value)
  if (isOracleLobLike(value)) {
    const lob = value as { getData: (offset?: number, amount?: number) => Promise<string | Buffer> }
    const data = await lob.getData(1, 1024 * 1024)
    if (Buffer.isBuffer(data)) {
      const bounded = data.byteLength > 1024 * 1024 ? data.subarray(0, 1024 * 1024) : data
      return sanitizeJsonPayload(bounded)
    }
    if (typeof data === 'string' && data.length > 1024 * 1024) {
      return data.slice(0, 1024 * 1024)
    }
    return data
  }
  return sanitizeJsonPayload(value)
}

async function serializeOracleRowRecord(row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    out[k] = await serializeOracleCell(v)
  }
  return out
}

function buildUniqueColumnNames(metaData: OracleMetadataLike[]): { name: string; type: string }[] {
  const seenCounts = new Map<string, number>()
  return metaData.map((col, idx) => {
    const baseName = col.name && col.name.length > 0 ? col.name : `col_${idx + 1}`
    const count = seenCounts.get(baseName) ?? 0
    seenCounts.set(baseName, count + 1)
    const name = count === 0 ? baseName : `${baseName}_${count + 1}`
    return {
      name,
      type: col.dbTypeName || 'VARCHAR2',
    }
  })
}

async function extractOracleColumnsAndRows(
  res: OracleResultLike,
  maxRows: number
): Promise<{
  columns: { name: string; type: string }[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
}> {
  const metaData = Array.isArray(res.metaData) ? res.metaData : []
  const rawRows = Array.isArray(res.rows) ? res.rows : []
  const columns =
    metaData.length > 0
      ? buildUniqueColumnNames(metaData)
      : rawRows.length > 0 && !Array.isArray(rawRows[0]) && typeof rawRows[0] === 'object' && rawRows[0] !== null
        ? Object.keys(rawRows[0] as Record<string, unknown>).map((name) => ({ name, type: 'VARCHAR2' }))
        : []

  const truncated = rawRows.length > maxRows
  const limited = truncated ? rawRows.slice(0, maxRows) : rawRows
  const rows: unknown[][] = []
  for (const rawRow of limited) {
    if (Array.isArray(rawRow)) {
      const tuple: unknown[] = []
      for (const cell of rawRow) {
        tuple.push(await serializeOracleCell(cell))
      }
      rows.push(tuple)
    } else if (rawRow && typeof rawRow === 'object') {
      const rec = rawRow as Record<string, unknown>
      const tuple: unknown[] = []
      for (const col of columns) {
        tuple.push(await serializeOracleCell(rec[col.name]))
      }
      rows.push(tuple)
    }
  }

  return {
    columns,
    rows,
    rowCount: rows.length,
    truncated,
  }
}

function isValidOracleServerCertDn(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  const parts: string[] = []
  let cur = ''
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === '\\' && i + 1 < trimmed.length) {
      cur += ch + trimmed[i + 1]
      i++
      continue
    }
    if (ch === ',') {
      parts.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  parts.push(cur.trim())
  if (parts.length === 0) return false
  return parts.every((rdn) => rdn.length > 0 && /^[A-Za-z][A-Za-z0-9.-]*\s*=\s*.+$/.test(rdn))
}

function getOracleFieldValue(row: Record<string, unknown>, key: string): unknown {
  if (key in row) return row[key]
  const upper = key.toUpperCase()
  if (upper in row) return row[upper]
  const lower = key.toLowerCase()
  if (lower in row) return row[lower]
  return undefined
}

function getOracleFieldString(row: Record<string, unknown>, key: string): string {
  const val = getOracleFieldValue(row, key)
  return val === null || val === undefined ? '' : String(val).trim()
}

function formatOracleErColumnType(row: Record<string, unknown>): string {
  const explicitType = getOracleFieldString(row, 'type')
  if (explicitType) return explicitType
  const baseRaw = getOracleFieldString(row, 'data_type') || 'VARCHAR2'
  const baseUpper = baseRaw.toUpperCase()
  const dataLength = Number(getOracleFieldValue(row, 'data_length') ?? 0)
  const charLength = Number(getOracleFieldValue(row, 'char_length') ?? 0)
  const charUsed = getOracleFieldString(row, 'char_used').toUpperCase()
  const rawPrecision = getOracleFieldValue(row, 'data_precision')
  const rawScale = getOracleFieldValue(row, 'data_scale')
  const hasPrecision = rawPrecision !== null && rawPrecision !== undefined && rawPrecision !== ''
  const hasScale = rawScale !== null && rawScale !== undefined && rawScale !== ''
  const precision = hasPrecision ? Number(rawPrecision) : NaN
  const scale = hasScale ? Number(rawScale) : NaN

  if (baseUpper === 'NUMBER') {
    if (Number.isFinite(precision) && precision > 0) {
      if (Number.isFinite(scale) && scale !== 0) {
        return `NUMBER(${precision},${scale})`
      }
      return `NUMBER(${precision})`
    }
    return 'NUMBER'
  }
  if (
    baseUpper === 'VARCHAR2' ||
    baseUpper === 'NVARCHAR2' ||
    baseUpper === 'CHAR' ||
    baseUpper === 'NCHAR'
  ) {
    const len = Number.isFinite(charLength) && charLength > 0 ? charLength : dataLength
    if (Number.isFinite(len) && len > 0) {
      const unitSuffix =
        charUsed === 'C' && (baseUpper === 'VARCHAR2' || baseUpper === 'CHAR') ? ' CHAR' : ''
      return `${baseRaw}(${len}${unitSuffix})`
    }
    return baseRaw
  }
  if (baseUpper === 'RAW' && Number.isFinite(dataLength) && dataLength > 0) {
    return `RAW(${dataLength})`
  }
  if (baseUpper === 'FLOAT' && Number.isFinite(precision) && precision > 0 && precision !== 126) {
    return `FLOAT(${precision})`
  }
  return baseRaw
}

function buildOraclePlanTableSelectSql(quotedTableName = 'PLAN_TABLE'): string {
  return `SELECT
  ID, PARENT_ID, DEPTH, POSITION, OPERATION, OPTIONS,
  OBJECT_OWNER, OBJECT_NAME, OBJECT_ALIAS, OBJECT_TYPE,
  OPTIMIZER, COST, CARDINALITY, BYTES, CPU_COST, IO_COST,
  TEMP_SPACE, ACCESS_PREDICATES, FILTER_PREDICATES, QBLOCK_NAME
FROM ${quotedTableName}
WHERE STATEMENT_ID = :p1
  AND PLAN_ID = (SELECT MAX(PLAN_ID) FROM ${quotedTableName} WHERE STATEMENT_ID = :p1)
ORDER BY ID ASC`
}

function buildOracleMaxPlanIdSelectSql(quotedTableName = 'PLAN_TABLE'): string {
  return `SELECT MAX(PLAN_ID) AS "plan_id" FROM ${quotedTableName} WHERE STATEMENT_ID = :p1`
}

const ORACLE_PLAN_TABLE_SELECT_SQL = buildOraclePlanTableSelectSql()
const ORACLE_MAX_PLAN_ID_SELECT_SQL = buildOracleMaxPlanIdSelectSql()

function generateOracleExplainStatementId(): string {
  return `DN${crypto.randomBytes(14).toString('hex')}`
}

function buildOracleExplainSavepointName(): string {
  return `datanoa_explain_${crypto.randomBytes(6).toString('hex')}`
}

function escapeOracleSqlLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

function validateOracleExplainStatementId(raw: string): string {
  if (
    raw.length === 0 ||
    Buffer.byteLength(raw, 'utf8') > 30 ||
    raw.includes('\0') ||
    /[\r\n]/.test(raw)
  ) {
    throw new DatabaseDriverError(
      'Oracle EXPLAIN PLAN STATEMENT_ID must be 1 to 30 bytes without NUL or newline characters',
      'invalid_params',
      'oracle'
    )
  }
  return raw
}

function parseCapturedOraclePlanId(res: OracleResultLike | null | undefined): string | null {
  const firstRow = Array.isArray(res?.rows) ? res.rows[0] : undefined
  const raw = Array.isArray(firstRow)
    ? firstRow[0]
    : firstRow && typeof firstRow === 'object'
      ? getOracleFieldValue(firstRow as Record<string, unknown>, 'plan_id') ??
        Object.values(firstRow as Record<string, unknown>)[0]
      : undefined
  if (raw === null || raw === undefined) return null
  const str = String(raw).trim()
  return /^\d+$/.test(str) ? str : null
}

function buildOracleExplainDisplaySql(
  quotedPlanTable: string | null,
  statementId: string,
  capturedPlanId: string | null
): string {
  const tableArg = quotedPlanTable ? `'${escapeOracleSqlLiteral(quotedPlanTable)}'` : 'NULL'
  const stmtArg = `'${escapeOracleSqlLiteral(statementId)}'`
  if (capturedPlanId !== null) {
    return `SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY(${tableArg}, ${stmtArg}, 'TYPICAL', 'PLAN_ID = ${capturedPlanId}'))`
  }
  return `SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY(${tableArg}, ${stmtArg}))`
}

type OracleExplainHeaderToken =
  | { kind: 'word'; value: string; upper: string; start: number; end: number }
  | { kind: 'qident'; value: string; start: number; end: number }
  | { kind: 'str'; value: string; start: number; end: number }
  | { kind: 'punct'; value: string; start: number; end: number }

interface ParsedOraclePlanTableSpec {
  schema?: string
  table: string
}

type ParsedOracleExplainHeader =
  | { isExplainPlan: false }
  | {
      isExplainPlan: true
      rawStatementId?: string
      planTable?: ParsedOraclePlanTableSpec
      afterForSql: string
    }

const ORACLE_UNQUOTED_IDENT_RE = /^[A-Za-z][A-Za-z0-9_$#]{0,127}$/

function readNextOracleHeaderToken(sql: string, pos: number): { token: OracleExplainHeaderToken | null; nextPos: number } {
  const len = sql.length
  let i = pos

  while (i < len) {
    const ch = sql[i]
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (ch === '-' && i + 1 < len && sql[i + 1] === '-') {
      i += 2
      while (i < len && sql[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
      const closeIdx = sql.indexOf('*/', i + 2)
      if (closeIdx < 0) {
        throw new DatabaseDriverError('Unclosed block comment in EXPLAIN PLAN header', 'invalid_params', 'oracle')
      }
      i = closeIdx + 2
      continue
    }
    break
  }

  if (i >= len) {
    return { token: null, nextPos: i }
  }

  const start = i
  const ch = sql[i]

  if (ch === '"') {
    i += 1
    let val = ''
    let closed = false
    while (i < len) {
      if (sql[i] === '"') {
        if (i + 1 < len && sql[i + 1] === '"') {
          val += '"'
          i += 2
          continue
        }
        closed = true
        i += 1
        break
      }
      val += sql[i]
      i += 1
    }
    if (!closed) {
      throw new DatabaseDriverError('Unclosed quoted identifier in EXPLAIN PLAN header', 'invalid_params', 'oracle')
    }
    return { token: { kind: 'qident', value: val, start, end: i }, nextPos: i }
  }

  if (ch === "'") {
    i += 1
    let val = ''
    let closed = false
    while (i < len) {
      if (sql[i] === "'") {
        if (i + 1 < len && sql[i + 1] === "'") {
          val += "'"
          i += 2
          continue
        }
        closed = true
        i += 1
        break
      }
      val += sql[i]
      i += 1
    }
    if (!closed) {
      throw new DatabaseDriverError('Unclosed string literal in EXPLAIN PLAN header', 'invalid_params', 'oracle')
    }
    return { token: { kind: 'str', value: val, start, end: i }, nextPos: i }
  }

  if (/[A-Za-z]/.test(ch)) {
    i += 1
    while (i < len && /[A-Za-z0-9_$#]/.test(sql[i])) i += 1
    const raw = sql.slice(start, i)
    return { token: { kind: 'word', value: raw, upper: raw.toUpperCase(), start, end: i }, nextPos: i }
  }

  return { token: { kind: 'punct', value: ch, start, end: i + 1 }, nextPos: i + 1 }
}

function parseOracleHeaderIdent(token: OracleExplainHeaderToken | null, label: string): string {
  if (!token) {
    throw new DatabaseDriverError(`Expected ${label} in EXPLAIN PLAN INTO clause`, 'invalid_params', 'oracle')
  }
  if (token.kind === 'word') {
    if (!ORACLE_UNQUOTED_IDENT_RE.test(token.value)) {
      throw new DatabaseDriverError(`Invalid ${label} in EXPLAIN PLAN INTO clause`, 'invalid_params', 'oracle')
    }
    return token.upper
  }
  if (token.kind === 'qident') {
    if (token.value.length === 0 || token.value.length > 128 || token.value.includes('\0')) {
      throw new DatabaseDriverError(`Invalid quoted ${label} in EXPLAIN PLAN INTO clause`, 'invalid_params', 'oracle')
    }
    return token.value
  }
  throw new DatabaseDriverError(`Invalid ${label} in EXPLAIN PLAN INTO clause`, 'invalid_params', 'oracle')
}

function parseOracleExplainPlanHeader(sql: string): ParsedOracleExplainHeader {
  const t1 = readNextOracleHeaderToken(sql, 0)
  if (!t1.token || t1.token.kind !== 'word' || t1.token.upper !== 'EXPLAIN') {
    return { isExplainPlan: false }
  }
  const t2 = readNextOracleHeaderToken(sql, t1.nextPos)
  if (!t2.token || t2.token.kind !== 'word' || t2.token.upper !== 'PLAN') {
    return { isExplainPlan: false }
  }

  let pos = t2.nextPos
  let rawStatementId: string | undefined
  let planTable: ParsedOraclePlanTableSpec | undefined
  let sawSet = false
  let sawInto = false

  while (true) {
    const step = readNextOracleHeaderToken(sql, pos)
    const tok = step.token
    if (!tok) {
      throw new DatabaseDriverError('EXPLAIN PLAN statement is missing FOR clause', 'invalid_params', 'oracle')
    }

    if (tok.kind === 'word' && tok.upper === 'FOR') {
      const afterForSql = sql.slice(tok.end)
      if (!afterForSql.trim()) {
        throw new DatabaseDriverError('EXPLAIN PLAN statement is missing SQL after FOR', 'invalid_params', 'oracle')
      }
      return {
        isExplainPlan: true,
        ...(rawStatementId !== undefined ? { rawStatementId } : {}),
        ...(planTable ? { planTable } : {}),
        afterForSql,
      }
    }

    if (tok.kind === 'word' && tok.upper === 'SET') {
      if (sawSet) {
        throw new DatabaseDriverError('Duplicate SET STATEMENT_ID clause in EXPLAIN PLAN', 'invalid_params', 'oracle')
      }
      const keyTok = readNextOracleHeaderToken(sql, step.nextPos)
      const eqTok = readNextOracleHeaderToken(sql, keyTok.nextPos)
      const valTok = readNextOracleHeaderToken(sql, eqTok.nextPos)
      if (
        keyTok.token?.kind !== 'word' ||
        keyTok.token.upper !== 'STATEMENT_ID' ||
        eqTok.token?.kind !== 'punct' ||
        eqTok.token.value !== '=' ||
        valTok.token?.kind !== 'str'
      ) {
        throw new DatabaseDriverError('Invalid SET STATEMENT_ID clause in EXPLAIN PLAN', 'invalid_params', 'oracle')
      }
      sawSet = true
      rawStatementId = valTok.token.value
      pos = valTok.nextPos
      continue
    }

    if (tok.kind === 'word' && tok.upper === 'INTO') {
      if (sawInto) {
        throw new DatabaseDriverError('Duplicate INTO clause in EXPLAIN PLAN', 'invalid_params', 'oracle')
      }
      const firstStep = readNextOracleHeaderToken(sql, step.nextPos)
      const firstIdent = parseOracleHeaderIdent(firstStep.token, 'plan table identifier')
      const peekStep = readNextOracleHeaderToken(sql, firstStep.nextPos)
      if (peekStep.token?.kind === 'punct' && peekStep.token.value === '.') {
        const secondStep = readNextOracleHeaderToken(sql, peekStep.nextPos)
        const tableIdent = parseOracleHeaderIdent(secondStep.token, 'plan table identifier')
        planTable = { schema: firstIdent, table: tableIdent }
        pos = secondStep.nextPos
      } else {
        planTable = { table: firstIdent }
        pos = firstStep.nextPos
      }
      sawInto = true
      continue
    }

    throw new DatabaseDriverError('Invalid EXPLAIN PLAN header syntax', 'invalid_params', 'oracle')
  }
}

function resolveOracleEndpoint(
  rawTlsServername?: string
): string | undefined {
  const raw = typeof rawTlsServername === 'string' ? rawTlsServername.trim() : ''
  if (!raw) return undefined
  const unwrapped =
    raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  return unwrapped || undefined
}

function extractOracleConnectHost(connectString: string, fallbackHost: string): string {
  const trimmed = connectString.trim()
  if (trimmed.startsWith('(')) {
    const hostMatch = /\(\s*HOST\s*=\s*([^)\s]+)\s*\)/i.exec(trimmed)
    if (hostMatch && hostMatch[1]) {
      const h = hostMatch[1].trim()
      return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
    }
  } else {
    const easyMatch =
      /^(?:tcps?:\/\/|\/\/)?(\[[0-9a-fA-F:]+\]|[A-Za-z0-9_.-]+)(?::\d{1,5})?(?:\/|$)/i.exec(trimmed)
    if (easyMatch && easyMatch[1]) {
      const h = easyMatch[1].trim()
      return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
    }
  }
  const fb = fallbackHost.trim()
  return fb.startsWith('[') && fb.endsWith(']') ? fb.slice(1, -1) : fb || 'localhost'
}

export async function buildOracleConnectionConfig(
  profile: ConnectionProfile,
  password?: string,
  extraSecrets?: DriverTlsOptions
): Promise<OracleBuiltConfig> {
  let host = (profile.host || '').trim()
  let port = profile.port
  let user = profile.user
  let resolvedPassword = password
  const profileDb = (profile.database || '').trim()
  let urlService = ''
  let urlSid = ''
  let urlSchema = ''
  let urlConnectString = ''
  let urlUsesTcps = false
  let rawUrlCertDn = ''

  const rawUrl = (profile.url || '').trim()
  if (rawUrl) {
    if (rawUrl.startsWith('(')) {
      urlConnectString = rawUrl
    } else if (/^(?:oracle|oracledb|tcps):\/\//i.test(rawUrl)) {
      if (/^tcps:\/\//i.test(rawUrl)) urlUsesTcps = true
      try {
        const normalizedUrl = rawUrl.replace(/^(?:oracle|oracledb|tcps):\/\//i, 'http://')
        const parsed = new URL(normalizedUrl)
        if (!host && parsed.hostname) host = parsed.hostname
        if (!port && parsed.port) {
          const parsedPort = Number(parsed.port)
          if (Number.isInteger(parsedPort) && parsedPort > 0) port = parsedPort
        }
        if (!user && parsed.username) user = decodeURIComponent(parsed.username)
        if (!resolvedPassword && parsed.password) {
          resolvedPassword = decodeURIComponent(parsed.password)
        }
        const rawPath = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
        if (rawPath) urlService = decodeURIComponent(rawPath)
        const qSchema = (parsed.searchParams.get('schema') || '').trim()
        if (qSchema) urlSchema = qSchema
        const qService = (
          parsed.searchParams.get('serviceName') ||
          parsed.searchParams.get('service') ||
          ''
        ).trim()
        if (!urlService && qService) urlService = qService
        const qSid = (parsed.searchParams.get('sid') || '').trim()
        if (qSid) urlSid = qSid
        const qCertDn = (
          parsed.searchParams.get('ssl_server_cert_dn') ||
          parsed.searchParams.get('sslServerCertDN') ||
          ''
        ).trim()
        if (qCertDn) rawUrlCertDn = qCertDn
      } catch {
        urlConnectString = rawUrl
      }
    } else {
      urlConnectString = rawUrl
    }
  }

  let urlSslServerCertDn: string | undefined
  if (rawUrlCertDn) {
    if (!isValidOracleServerCertDn(rawUrlCertDn)) {
      throw new DatabaseDriverError(
        `Invalid Oracle ssl_server_cert_dn "${rawUrlCertDn}". Expected an RFC 2253 Distinguished Name (e.g. "CN=db.example.com,O=Acme").`,
        'invalid_params',
        'oracle'
      )
    }
    urlSslServerCertDn = rawUrlCertDn
  }

  const tlsOverride = await resolveEffectiveTlsOptions(
    profile,
    extraSecrets,
    extraSecrets?.tlsServername
  )

  const tnsUsesTcps = /\(\s*PROTOCOL\s*=\s*TCPS\s*\)/i.test(urlConnectString || host)
  const wantsTls =
    urlUsesTcps ||
    tnsUsesTcps ||
    (tlsOverride !== false && (Boolean(tlsOverride) || profile.ssl === true))

  let connectString = ''
  let usedDatabaseAsService = false

  if (urlConnectString) {
    connectString = urlConnectString
  } else if (host.startsWith('(')) {
    connectString = host
  } else if (host.includes('/')) {
    connectString = wantsTls && !host.startsWith('tcps://') ? `tcps://${host}` : host
  } else {
    const resolvedHost = host || 'localhost'
    const resolvedPort = port || (wantsTls ? 2484 : 1521)
    if (urlSid) {
      connectString = `(DESCRIPTION=(ADDRESS=(PROTOCOL=${wantsTls ? 'TCPS' : 'TCP'})(HOST=${resolvedHost})(PORT=${resolvedPort}))(CONNECT_DATA=(SID=${urlSid})))`
    } else {
      const resolvedService = urlService || profileDb || 'FREEPDB1'
      usedDatabaseAsService =
        !urlService &&
        Boolean(profileDb) &&
        profileDb === resolvedService &&
        !urlSchema
      const prefix = wantsTls ? 'tcps://' : ''
      connectString = `${prefix}${resolvedHost}:${resolvedPort}/${resolvedService}`
    }
  }

  let currentSchema: string | undefined
  if (urlSchema) {
    currentSchema = normalizeOracleSchemaIdentifier(urlSchema)
  } else if (
    !usedDatabaseAsService &&
    profileDb &&
    !((urlSid || urlService) && (profileDb.toUpperCase() === 'FREEPDB1' || profileDb === urlService))
  ) {
    currentSchema = normalizeOracleSchemaIdentifier(profileDb)
  }

  const defaultSchema = currentSchema
    ? currentSchema
    : normalizeOracleSchemaIdentifier(user, 'SYSTEM')

  const attrs: ConnectionAttributes = {
    user,
    password: resolvedPassword,
    connectString,
    connectTimeout: 10,
  }

  if (tlsOverride && typeof tlsOverride === 'object') {
    const pemChunks: string[] = []
    if (typeof tlsOverride.ca === 'string' && tlsOverride.ca.trim()) pemChunks.push(tlsOverride.ca.trim())
    if (typeof tlsOverride.cert === 'string' && tlsOverride.cert.trim()) pemChunks.push(tlsOverride.cert.trim())
    if (typeof tlsOverride.key === 'string' && tlsOverride.key.trim()) pemChunks.push(tlsOverride.key.trim())
    if (pemChunks.length > 0) {
      attrs.walletContent = `${pemChunks.join('\n')}\n`
    }
    if (typeof extraSecrets?.sslKeyPassphrase === 'string' && extraSecrets.sslKeyPassphrase) {
      attrs.walletPassword = extraSecrets.sslKeyPassphrase
    }
  }

  const resolvedTlsServername = resolveOracleEndpoint(extraSecrets?.tlsServername)
  if (wantsTls) {
    const verifyHost =
      profile.sslMode === 'verify-ca'
        ? false
        : tlsOverride && typeof tlsOverride === 'object'
          ? tlsOverride.rejectUnauthorized !== false
          : profile.sslRejectUnauthorized !== false
    attrs.sslServerDNMatch = verifyHost
    if (urlSslServerCertDn) {
      attrs.sslServerCertDN = urlSslServerCertDn
    }
    const hasTnsCertDn = /\(\s*SSL_SERVER_CERT_DN\s*=/i.test(connectString)
    const cleanExpectedServername = resolvedTlsServername ?? ''
    const connectHost = extractOracleConnectHost(connectString, host || 'localhost')
    if (
      verifyHost &&
      cleanExpectedServername &&
      connectHost.toLowerCase() !== cleanExpectedServername.toLowerCase() &&
      !attrs.sslServerCertDN &&
      !hasTnsCertDn
    ) {
      throw new DatabaseDriverError(
        `Oracle thin-mode TLS verify-full over an SSH tunnel cannot match remote host "${cleanExpectedServername}" against "${connectHost}". Provide an exact RFC 2253 ?ssl_server_cert_dn=CN=... in the URL (or TNS SSL_SERVER_CERT_DN), or use SSL Mode "verify-ca".`,
        'ORACLE_SSH_TLS_VERIFY_FULL_UNSUPPORTED',
        'oracle'
      )
    }
  }

  return {
    attrs,
    currentSchema,
    usedDatabaseAsService,
    defaultSchema,
    ...(resolvedTlsServername ? { tlsServername: resolvedTlsServername } : {}),
  }
}

export class OracleSession implements IDatabaseSession {
  readonly driverType = 'oracle' as const
  private readonly conn: OracleConnectionLike
  readonly profile: ConnectionProfile
  private readonly defaultSchema: string
  private readonly connectAttrs?: ConnectionAttributes
  private readonly tableDetailsCache = new TableDetailsCache()
  private readonly activeQueries = new Map<string, ActiveOracleQuery>()
  private currentlyExecutingQueryId: string | null = null

  private isClosed = false
  private isBroken = false
  private autoCommit = true
  private txActive = false
  private statementCount = 0
  private txStartedAt: number | undefined
  private opChain: Promise<void> = Promise.resolve()

  constructor(
    conn: OracleConnectionLike,
    profile: ConnectionProfile,
    options?: { defaultSchema?: string; connectAttrs?: ConnectionAttributes }
  ) {
    this.conn = conn
    this.profile = profile
    this.connectAttrs = options?.connectAttrs
    this.defaultSchema = normalizeOracleSchemaIdentifier(
      options?.defaultSchema || profile.user,
      'SYSTEM'
    )
  }

  isAlive(): boolean {
    if (this.isClosed || this.isBroken) return false
    return typeof this.conn.isHealthy === 'function' ? this.conn.isHealthy() : true
  }

  private runExclusiveOp<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.opChain
    let release: (() => void) | undefined
    this.opChain = new Promise<void>((resolve) => {
      release = resolve
    })
    return prev
      .then(fn)
      .catch((err: unknown) => {
        throw scrubOracleError(err)
      })
      .finally(() => {
        if (release) release()
      })
  }

  private async runScrubbed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err: unknown) {
      throw scrubOracleError(err)
    }
  }

  private resolveSchema(schema?: string): string {
    return normalizeOracleSchemaIdentifier(schema || this.defaultSchema, this.defaultSchema)
  }

  private assertOpen(): void {
    if (this.isClosed) {
      throw new DatabaseDriverError('Session is closed', 'SESSION_CLOSED', 'oracle')
    }
    if (this.isBroken) {
      throw new DatabaseDriverError('Oracle session is in a broken state after cleanup failure', 'SESSION_BROKEN', 'oracle')
    }
  }

  private assertWritable(): void {
    if (this.profile.readOnly) {
      throw new DatabaseDriverError(
        'Connection is Read-Only. Uncheck Read-Only in connection settings to modify data.',
        'read_only',
        'oracle'
      )
    }
  }

  private readonly executeQueryUnlocked = async (
    sql: string,
    params?: unknown[]
  ): Promise<Record<string, unknown>[]> => {
    this.assertOpen()
    const binds = toOracleBindObject(params)
    const res = await this.conn.execute(stripTrailingSemicolon(sql), binds, {
      outFormat: getOracleOutFormatObject(),
      autoCommit: !this.txActive && this.autoCommit,
    })
    const rows = Array.isArray(res.rows) ? (res.rows as Record<string, unknown>[]) : []
    const serialized: Record<string, unknown>[] = []
    for (const r of rows) {
      serialized.push(await serializeOracleRowRecord(r))
    }
    return serialized
  }

  private readonly queryExecutor = (
    sql: string,
    params?: unknown[]
  ): Promise<Record<string, unknown>[]> =>
    this.runExclusiveOp(() => this.executeQueryUnlocked(sql, params))

  async test(): Promise<{ ok: boolean; message?: string }> {
    if (this.isClosed) {
      return { ok: false, message: 'Session is closed' }
    }
    try {
      await this.runExclusiveOp(async () => {
        this.assertOpen()
        await this.conn.execute('SELECT 1 AS ok FROM DUAL', {}, { outFormat: getOracleOutFormatObject() })
      })
      return { ok: true, message: 'Oracle connection valid' }
    } catch (err: unknown) {
      return {
        ok: false,
        message: extractOracleErrorMessage(err, 'Failed to connect to Oracle'),
      }
    }
  }

  async close(): Promise<void> {
    this.tableDetailsCache.clear()
    if (this.isClosed) return
    this.isClosed = true

    for (const active of this.activeQueries.values()) {
      active.cancelled = true
    }
    if (this.activeQueries.size > 0) {
      await this.breakConnectionExecution().catch(() => {})
    }
    this.activeQueries.clear()

    if (this.txActive) {
      this.txActive = false
      this.statementCount = 0
      this.txStartedAt = undefined
      await this.conn.rollback().catch(() => {})
    }

    await this.conn.close().catch(() => {})
  }

  private async breakConnectionExecution(): Promise<void> {
    if (typeof this.conn.breakExecution === 'function') {
      await this.conn.breakExecution()
      return
    }
    if (typeof this.conn.break === 'function') {
      const res = this.conn.break()
      if (res instanceof Promise) await res
    }
  }

  async listSchemas(): Promise<{ schemas: string[]; defaultSchema: string }> {
    return this.runScrubbed(async () => {
      this.assertOpen()
      return introspectOracleSchemas(this.queryExecutor, this.defaultSchema)
    })
  }

  async listObjects(schema?: string): Promise<SchemaObject[]> {
    return this.runScrubbed(async () => {
      this.assertOpen()
      return introspectOracleObjects(this.queryExecutor, this.resolveSchema(schema))
    })
  }

  clearSchemaCache(): void {
    this.tableDetailsCache.clear()
  }

  async introspectErGraph(schema?: string): Promise<SchemaErGraph> {
    return this.runScrubbed(async () => {
      this.assertOpen()
      const targetOwner = this.resolveSchema(schema)

      const tableRows = await this.queryExecutor(
        `
        SELECT owner AS "schema", table_name AS "name", 'table' AS "kind"
        FROM all_tables
        WHERE owner = :p1 AND table_name NOT LIKE 'BIN$%'
        UNION ALL
        SELECT owner AS "schema", view_name AS "name", 'view' AS "kind"
        FROM all_views
        WHERE owner = :p1 AND view_name NOT LIKE 'BIN$%'
        ORDER BY "name" ASC
      `,
        [targetOwner]
      )

      const colRows = await this.queryExecutor(
        `
        SELECT
          owner AS "schema",
          table_name AS "table",
          column_name AS "name",
          data_type AS "data_type",
          data_length AS "data_length",
          char_length AS "char_length",
          char_used AS "char_used",
          data_precision AS "data_precision",
          data_scale AS "data_scale",
          nullable AS "nullable",
          column_id AS "ordinal_position"
        FROM all_tab_columns
        WHERE owner = :p1 AND table_name NOT LIKE 'BIN$%'
        ORDER BY table_name ASC, column_id ASC
      `,
        [targetOwner]
      )

      const consRows = await this.queryExecutor(
        `
        SELECT
          ac.constraint_type AS "constraint_type",
          ac.constraint_name AS "constraint_name",
          ac.owner AS "from_schema",
          ac.table_name AS "from_table",
          acc.column_name AS "from_column",
          acc.position AS "ordinal_position",
          ac.r_owner AS "to_schema",
          rc.table_name AS "to_table",
          rcc.column_name AS "to_column",
          ac.delete_rule AS "on_delete"
        FROM all_constraints ac
        JOIN all_cons_columns acc
          ON acc.owner = ac.owner
         AND acc.constraint_name = ac.constraint_name
         AND acc.table_name = ac.table_name
        LEFT JOIN all_constraints rc
          ON ac.constraint_type = 'R'
         AND rc.owner = ac.r_owner
         AND rc.constraint_name = ac.r_constraint_name
        LEFT JOIN all_cons_columns rcc
          ON ac.constraint_type = 'R'
         AND rcc.owner = rc.owner
         AND rcc.constraint_name = rc.constraint_name
         AND rcc.position = acc.position
        WHERE ac.owner = :p1
          AND ac.constraint_type IN ('P', 'U', 'R')
          AND ac.table_name NOT LIKE 'BIN$%'
        UNION ALL
        SELECT
          'U' AS "constraint_type",
          ai.index_name AS "constraint_name",
          ai.table_owner AS "from_schema",
          ai.table_name AS "from_table",
          aic.column_name AS "from_column",
          aic.column_position AS "ordinal_position",
          NULL AS "to_schema",
          NULL AS "to_table",
          NULL AS "to_column",
          NULL AS "on_delete"
        FROM all_indexes ai
        JOIN all_ind_columns aic
          ON aic.index_owner = ai.owner
         AND aic.index_name = ai.index_name
        WHERE ai.table_owner = :p1
          AND ai.uniqueness = 'UNIQUE'
          AND ai.index_type = 'NORMAL'
          AND ai.table_name NOT LIKE 'BIN$%'
          AND NOT EXISTS (
            SELECT 1
            FROM all_constraints ac2
            WHERE ac2.owner = ai.table_owner
              AND ac2.table_name = ai.table_name
              AND ac2.constraint_type IN ('P', 'U')
              AND (ac2.index_owner = ai.owner OR (ac2.index_owner IS NULL AND ac2.owner = ai.owner))
              AND ac2.index_name = ai.index_name
          )
        ORDER BY "constraint_type" ASC, "constraint_name" ASC, "ordinal_position" ASC
      `,
        [targetOwner]
      )

      const pkColsByTable = new Map<string, Set<string>>()
      const uniqueGroups = new Map<
        string,
        { schema: string; table: string; indexName: string; cols: Array<{ name: string; ord: number }> }
      >()
      const foreignKeys: RawErForeignKeyRow[] = []

      for (const r of consRows) {
        const cType = getOracleFieldString(r, 'constraint_type').toUpperCase()
        const fromSchema = getOracleFieldString(r, 'from_schema') || targetOwner
        const fromTable = getOracleFieldString(r, 'from_table') || getOracleFieldString(r, 'table_name')
        const fromColumn = getOracleFieldString(r, 'from_column') || getOracleFieldString(r, 'column_name')
        if (!fromTable || !fromColumn) continue

        if (cType === 'P') {
          const tblKey = `${fromSchema}\u0000${fromTable}`
          let pkSet = pkColsByTable.get(tblKey)
          if (!pkSet) {
            pkSet = new Set<string>()
            pkColsByTable.set(tblKey, pkSet)
          }
          pkSet.add(fromColumn)
        } else if (cType === 'U') {
          const constraintName = getOracleFieldString(r, 'constraint_name') || `uq_${fromTable}`
          const uKey = `${fromSchema}\u0000${fromTable}\u0000${constraintName}`
          let grp = uniqueGroups.get(uKey)
          if (!grp) {
            grp = { schema: fromSchema, table: fromTable, indexName: constraintName, cols: [] }
            uniqueGroups.set(uKey, grp)
          }
          const ordRaw = getOracleFieldValue(r, 'ordinal_position')
          const ord = Number(ordRaw)
          if (!grp.cols.some((c) => c.name === fromColumn)) {
            grp.cols.push({ name: fromColumn, ord: Number.isFinite(ord) ? ord : grp.cols.length })
          }
        } else if (cType === 'R') {
          const toTable = getOracleFieldString(r, 'to_table')
          const toColumn = getOracleFieldString(r, 'to_column')
          if (!toTable || !toColumn) continue
          const toSchema = getOracleFieldString(r, 'to_schema') || fromSchema
          const constraintName = getOracleFieldString(r, 'constraint_name')
          const ordRaw = getOracleFieldValue(r, 'ordinal_position')
          const ord = Number(ordRaw)
          const onDelete = getOracleFieldString(r, 'on_delete').toUpperCase()
          foreignKeys.push({
            ...(constraintName ? { constraintName } : {}),
            fromSchema,
            fromTable,
            fromColumn,
            toSchema,
            toTable,
            toColumn,
            ...(Number.isFinite(ord) ? { ordinalPosition: ord } : {}),
            ...(onDelete ? { onDelete } : {}),
          })
        }
      }

      const tables: RawErTableRow[] = tableRows
        .map((r): RawErTableRow | null => {
          const name = getOracleFieldString(r, 'name') || getOracleFieldString(r, 'table_name')
          if (!name) return null
          const rowSchema = getOracleFieldString(r, 'schema') || getOracleFieldString(r, 'owner') || targetOwner
          const rawKind = getOracleFieldString(r, 'kind').toLowerCase()
          return {
            schema: rowSchema,
            name,
            kind: rawKind === 'view' ? 'view' : 'table',
          }
        })
        .filter((item): item is RawErTableRow => item !== null)

      const columns: RawErColumnRow[] = colRows
        .map((r): RawErColumnRow | null => {
          const table = getOracleFieldString(r, 'table') || getOracleFieldString(r, 'table_name')
          const name = getOracleFieldString(r, 'name') || getOracleFieldString(r, 'column_name')
          if (!table || !name) return null
          const rowSchema = getOracleFieldString(r, 'schema') || getOracleFieldString(r, 'owner') || targetOwner
          const nullableRaw = getOracleFieldString(r, 'nullable').toUpperCase()
          const pkSet = pkColsByTable.get(`${rowSchema}\u0000${table}`)
          const isPk = pkSet ? pkSet.has(name) : false
          const ordRaw = getOracleFieldValue(r, 'ordinal_position')
          const ord = Number(ordRaw)
          return {
            schema: rowSchema,
            table,
            name,
            type: formatOracleErColumnType(r),
            nullable: nullableRaw !== 'N' && nullableRaw !== 'FALSE' && nullableRaw !== '0',
            isPrimaryKey: isPk,
            ...(Number.isFinite(ord) ? { ordinalPosition: ord } : {}),
          }
        })
        .filter((item): item is RawErColumnRow => item !== null)

      const uniqueSets: RawErUniqueSetRow[] = Array.from(uniqueGroups.values()).map((grp) => ({
        schema: grp.schema,
        table: grp.table,
        indexName: grp.indexName,
        columns: grp.cols.sort((a, b) => a.ord - b.ord).map((c) => c.name),
      }))

      return buildSchemaErGraphFromCatalogRows({
        connectionId: this.profile.id,
        schema: targetOwner,
        completeness: 'full',
        tables,
        columns,
        uniqueSets,
        foreignKeys,
      })
    })
  }

  async runExplain(sql: string, signal?: AbortSignal): Promise<ExplainResult | null> {
    this.assertOpen()
    if (signal?.aborted) {
      throw new DatabaseDriverError('Explain execution was cancelled', 'cancelled', 'oracle')
    }

    const rawTrimmed = sql.trim()
    if (!rawTrimmed) {
      throw new DatabaseDriverError('SQL statement cannot be empty', 'invalid_params', 'oracle')
    }

    const chunks = splitOracleStatements(rawTrimmed)
    if (chunks.length > 1) {
      throw new DatabaseDriverError(
        'Oracle EXPLAIN PLAN supports only a single SQL statement at a time.',
        'invalid_params',
        'oracle'
      )
    }
    const singleChunk = chunks[0] ?? { text: stripTrailingSemicolon(rawTrimmed), isPlSql: false }
    if (singleChunk.isPlSql) {
      throw new DatabaseDriverError('EXPLAIN PLAN does not support PL/SQL blocks', 'invalid_params', 'oracle')
    }

    const singleSql = stripTrailingSemicolon(singleChunk.text).trim()
    if (!singleSql) {
      throw new DatabaseDriverError('SQL statement cannot be empty', 'invalid_params', 'oracle')
    }

    if (hasExplainAnalyzeOption(singleSql, 'oracle') && isExplainTargetMutating(singleSql, 'oracle')) {
      throw new DatabaseDriverError(
        'EXPLAIN ANALYZE is not permitted for mutating statements in Explain mode.',
        'not_permitted',
        'oracle'
      )
    }

    const parsedHeader = parseOracleExplainPlanHeader(singleSql)
    const guardSql = parsedHeader.isExplainPlan ? singleSql : `EXPLAIN PLAN FOR ${singleSql}`
    if (this.profile.readOnly && isMutatingStatement(guardSql, 'oracle')) {
      this.assertWritable()
    }

    const statementId = generateOracleExplainStatementId()
    let explainPlanSql: string
    let displayStmtId = statementId
    let hasUserStatementId = false
    let quotedPlanTableForDisplay: string | null = null
    let planTableSelectSql = ORACLE_PLAN_TABLE_SELECT_SQL
    let maxPlanIdSelectSql = ORACLE_MAX_PLAN_ID_SELECT_SQL

    if (parsedHeader.isExplainPlan) {
      if (typeof parsedHeader.rawStatementId === 'string') {
        displayStmtId = validateOracleExplainStatementId(parsedHeader.rawStatementId)
        hasUserStatementId = true
      }

      const planSpec = parsedHeader.planTable
      const isDefaultPlanTable = !planSpec || (!planSpec.schema && planSpec.table === 'PLAN_TABLE')
      let intoClause = ''
      if (!isDefaultPlanTable && planSpec) {
        const quotedPlanTable = planSpec.schema
          ? `${quoteIdentForDialect(planSpec.schema, 'oracle')}.${quoteIdentForDialect(planSpec.table, 'oracle')}`
          : quoteIdentForDialect(planSpec.table, 'oracle')
        intoClause = ` INTO ${quotedPlanTable}`
        quotedPlanTableForDisplay = quotedPlanTable
        planTableSelectSql = buildOraclePlanTableSelectSql(quotedPlanTable)
        maxPlanIdSelectSql = buildOracleMaxPlanIdSelectSql(quotedPlanTable)
      }

      explainPlanSql = `EXPLAIN PLAN SET STATEMENT_ID = '${escapeOracleSqlLiteral(displayStmtId)}'${intoClause} FOR${parsedHeader.afterForSql}`
    } else {
      explainPlanSql = `EXPLAIN PLAN SET STATEMENT_ID = '${statementId}' FOR ${singleSql}`
    }

    return this.runExclusiveOp(async () => {
      this.assertOpen()
      if (signal?.aborted) {
        throw new DatabaseDriverError('Explain execution was cancelled', 'cancelled', 'oracle')
      }

      const onAbort = (): void => {
        void this.breakConnectionExecution().catch(() => {})
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      const startTime = performance.now()
      const isReadOnly = Boolean(this.profile.readOnly)
      const inTx = this.txActive || !this.autoCommit
      let rawRes: OracleResultLike | null = null

      const executeExplainAndCapture = async (tryPlanTable: boolean): Promise<void> => {
        await this.conn.execute(explainPlanSql, {}, { autoCommit: false })
        let planTableUnavailable = false
        if (tryPlanTable) {
          try {
            const planRes = await this.conn.execute(
              planTableSelectSql,
              { p1: displayStmtId },
              { outFormat: getOracleOutFormatArray(), autoCommit: false }
            )
            if (Array.isArray(planRes.rows) && planRes.rows.length > 0) {
              rawRes = planRes
            }
          } catch (err: unknown) {
            const { errorNum } = extractOracleErrorCode(err)
            if (errorNum === 942) {
              planTableUnavailable = true
            }
            rawRes = null
          }
        }
        if (!rawRes) {
          let capturedPlanId: string | null = null
          if (hasUserStatementId && !planTableUnavailable) {
            try {
              const maxRes = await this.conn.execute(
                maxPlanIdSelectSql,
                { p1: displayStmtId },
                { outFormat: getOracleOutFormatArray(), autoCommit: false }
              )
              capturedPlanId = parseCapturedOraclePlanId(maxRes)
            } catch {
              capturedPlanId = null
            }
          }
          const xplanDisplaySql = buildOracleExplainDisplaySql(
            quotedPlanTableForDisplay,
            displayStmtId,
            capturedPlanId
          )
          rawRes = await this.conn.execute(
            xplanDisplaySql,
            {},
            { outFormat: getOracleOutFormatArray(), autoCommit: false }
          )
        }
      }

      const runSavepointExplain = async (tryPlanTable: boolean): Promise<void> => {
        const savepointName = buildOracleExplainSavepointName()
        await this.conn.execute(`SAVEPOINT ${savepointName}`, {}, { autoCommit: false })
        let mainErr: unknown = null
        let hasMainErr = false
        try {
          await executeExplainAndCapture(tryPlanTable)
        } catch (err: unknown) {
          mainErr = err
          hasMainErr = true
        }
        try {
          await this.conn.execute(`ROLLBACK TO SAVEPOINT ${savepointName}`, {}, { autoCommit: false })
        } catch (rbErr: unknown) {
          this.isBroken = true
          if (!hasMainErr) {
            throw rbErr
          }
        }
        if (hasMainErr) {
          throw mainErr
        }
      }

      const runRollbackExplain = async (tryPlanTable: boolean): Promise<void> => {
        let mainErr: unknown = null
        let hasMainErr = false
        try {
          await executeExplainAndCapture(tryPlanTable)
        } catch (err: unknown) {
          mainErr = err
          hasMainErr = true
        }
        try {
          await this.conn.rollback()
        } catch (rbErr: unknown) {
          this.isBroken = true
          if (!hasMainErr) {
            throw rbErr
          }
        }
        if (hasMainErr) {
          throw mainErr
        }
      }

      try {
        if (inTx) {
          await runSavepointExplain(!isReadOnly)
        } else {
          await runRollbackExplain(!isReadOnly)
        }
      } catch (err: unknown) {
        const { errorNum } = extractOracleErrorCode(err)
        if (signal?.aborted || errorNum === 1013) {
          throw new DatabaseDriverError('Explain execution was cancelled', 'cancelled', 'oracle', err)
        }
        throw err
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }

      if (signal?.aborted) {
        throw new DatabaseDriverError('Explain execution was cancelled', 'cancelled', 'oracle')
      }

      const executionTimeMs = Math.round(performance.now() - startTime)
      const parsed = await extractOracleColumnsAndRows(rawRes ?? { metaData: [], rows: [] }, 1000)
      const rawText =
        parsed.columns.length <= 1 && parsed.rows.length > 0
          ? parsed.rows.map((r) => (r[0] !== null && r[0] !== undefined ? String(r[0]) : '')).join('\n')
          : undefined
      const explainPlan = parseExplainPlan(
        { columns: parsed.columns, rows: parsed.rows },
        { dialect: 'oracle' }
      )

      return {
        columns: parsed.columns,
        rows: parsed.rows,
        ...(rawText !== undefined ? { rawText } : {}),
        ...(explainPlan.format ? { formatHint: explainPlan.format } : {}),
        executionTimeMs,
        explainPlan,
      }
    })
  }

  async getTableDetails(table: string, schema?: string): Promise<TableDetails> {
    return this.runScrubbed(async () => {
      this.assertOpen()
      const targetSchema = this.resolveSchema(schema)
      const cached = this.tableDetailsCache.get(targetSchema, this.defaultSchema, table)
      if (cached) return cached
      const details = await introspectOracleTableDetails(this.queryExecutor, table, targetSchema)
      this.tableDetailsCache.set(targetSchema, this.defaultSchema, table, details)
      return details
    })
  }

  async getDdl(table: string, schema?: string): Promise<string> {
    return this.runScrubbed(async () => {
      const details = await this.getTableDetails(table, schema)
      return details.ddl || ''
    })
  }

  async getObjectDdl(name: string, kind: SchemaObjectKind, schema?: string): Promise<string> {
    return this.runScrubbed(async () => {
      this.assertOpen()
      const targetSchema = this.resolveSchema(schema)
      if (kind === 'table') {
        return this.getDdl(name, targetSchema)
      }
      return introspectOracleObjectDdl(this.queryExecutor, name, kind, targetSchema)
    })
  }

  async exportSchemaDdl(schema?: string): Promise<{ ddl: string; objectCount: number }> {
    return this.runScrubbed(async () => {
      this.assertOpen()
      const targetSchema = this.resolveSchema(schema)
      const objects = await this.listObjects(targetSchema)
      return collectAndAssembleSchemaDdl({
        dialect: 'oracle',
        schemaName: targetSchema,
        objects,
        getObjectDdl: (object) =>
          this.getObjectDdl(object.name, object.kind, object.schema || targetSchema),
      })
    })
  }

  async fetchPage(params: FetchPageParams): Promise<TableBrowseResult> {
    this.assertOpen()
    const targetSchema = this.resolveSchema(params.schema)

    const runWithExecutor = async (
      exec: (sql: string, bindParams?: unknown[]) => Promise<Record<string, unknown>[]>
    ): Promise<TableBrowseResult> => {
      let details = this.tableDetailsCache.get(targetSchema, this.defaultSchema, params.table)
      if (!details) {
        details = await introspectOracleTableDetails(exec, params.table, targetSchema)
        this.tableDetailsCache.set(targetSchema, this.defaultSchema, params.table, details)
      }
      const { sql, countSql, params: queryParams } = buildSelectPageSql({
        driver: 'oracle',
        table: params.table,
        schema: targetSchema,
        page: params.page,
        pageSize: params.pageSize,
        sortColumn: params.sortColumn,
        sortDirection: params.sortDirection,
        primaryKey: details.primaryKey,
        whereClause: params.whereClause,
        orderByClause: params.orderByClause,
      })

      const countRows = await exec(stripTrailingSemicolon(countSql))
      const dataRows = await exec(stripTrailingSemicolon(sql), queryParams)

      return assembleTableBrowseResult({
        tableDetails: details,
        rows: dataRows,
        countRow: countRows[0] || { total: 0 },
        page: params.page,
        pageSize: params.pageSize,
      })
    }

    if (params.bypassTransaction && this.txActive && this.connectAttrs) {
      const bypassConn = (await oracledb.getConnection(
        this.connectAttrs
      )) as unknown as OracleConnectionLike
      try {
        const bypassExec = async (
          sql: string,
          bindParams?: unknown[]
        ): Promise<Record<string, unknown>[]> => {
          const res = await bypassConn.execute(
            stripTrailingSemicolon(sql),
            toOracleBindObject(bindParams),
            { outFormat: getOracleOutFormatObject(), autoCommit: true }
          )
          const rows = Array.isArray(res.rows) ? (res.rows as Record<string, unknown>[]) : []
          const serialized: Record<string, unknown>[] = []
          for (const r of rows) serialized.push(await serializeOracleRowRecord(r))
          return serialized
        }
        return await runWithExecutor(bypassExec)
      } finally {
        await bypassConn.close().catch(() => {})
      }
    }

    return this.runExclusiveOp(async () => {
      this.assertOpen()
      return runWithExecutor(this.executeQueryUnlocked)
    })
  }

  async updateCell(params: UpdateCellParams): Promise<UpdateCellResult> {
    this.assertOpen()
    this.assertWritable()
    const targetSchema = this.resolveSchema(params.schema)
    const originalColumnType = this.tableDetailsCache.findColumnType(
      targetSchema,
      this.defaultSchema,
      params.table,
      params.column,
      params.columnType
    )

    const { sql, params: updateParams } = buildUpdateSql({
      driver: 'oracle',
      table: params.table,
      schema: targetSchema,
      column: params.column,
      newValue: params.newValue,
      primaryKeys: params.primaryKeys,
      originalValue: params.originalValue,
      originalColumnType,
    })

    const selectPk = buildSelectByPrimaryKeySql({
      driver: 'oracle',
      table: params.table,
      schema: targetSchema,
      primaryKeys: params.primaryKeys,
      editedColumn: params.column,
      newValue: params.newValue,
    })

    return this.runExclusiveOp(async () => {
      this.assertOpen()
      const insideManualTx = this.txActive || !this.autoCommit
      if (insideManualTx) {
        await this.conn.execute('SAVEPOINT datanoa_uc', {}, { autoCommit: false })
      }
      try {
        const res = await this.conn.execute(
          stripTrailingSemicolon(sql),
          toOracleBindObject(updateParams),
          { autoCommit: false }
        )
        const affected = Number(res.rowsAffected ?? 0)
        if (affected !== 1) {
          throw new DatabaseDriverError(
            affected === 0
              ? 'Record was modified or deleted by another session (optimistic lock conflict)'
              : `Optimistic update affected ${affected} rows instead of 1`,
            'conflict',
            'oracle'
          )
        }

        let updatedRecord: Record<string, unknown> | undefined
        if (selectPk) {
          const fetched = await this.conn.execute(
            stripTrailingSemicolon(selectPk.sql),
            toOracleBindObject(selectPk.params),
            { outFormat: getOracleOutFormatObject(), autoCommit: false }
          )
          const rawUpdated = Array.isArray(fetched.rows)
            ? (fetched.rows[0] as Record<string, unknown> | undefined)
            : undefined
          updatedRecord = rawUpdated ? await serializeOracleRowRecord(rawUpdated) : undefined
        }

        if (!insideManualTx) {
          await this.conn.commit()
        } else {
          if (!this.txActive) {
            this.txActive = true
            this.txStartedAt = Date.now()
          }
          this.statementCount += 1
        }
        return {
          ok: true,
          affectedRows: affected,
          ...(updatedRecord ? { updatedRecord } : {}),
        }
      } catch (err: unknown) {
        if (insideManualTx) {
          await this.conn
            .execute('ROLLBACK TO SAVEPOINT datanoa_uc', {}, { autoCommit: false })
            .catch(() => {})
        } else {
          await this.conn.rollback().catch(() => {})
        }
        throw err
      }
    })
  }

  private async resolveEffectiveDeletes(
    params: ApplyChangesParams,
    targetSchema: string
  ): Promise<Record<string, unknown>[]> {
    if (Array.isArray(params.deletes) && params.deletes.length > 0) {
      return params.deletes
    }
    if (!Array.isArray(params.deleteRows) || params.deleteRows.length === 0) {
      return []
    }
    let pkCols: string[] = []
    try {
      const details = await this.getTableDetails(params.table, targetSchema)
      pkCols = details.primaryKey
    } catch {
      pkCols = []
    }
    return projectDeleteRowsToPrimaryKeys(params.deleteRows, pkCols)
  }

  async previewChanges(params: ApplyChangesParams): Promise<PreviewChangesResult> {
    return this.runScrubbed(async () => {
      this.assertOpen()
      const targetSchema = this.resolveSchema(params.schema)
      const columnTypes = this.tableDetailsCache.resolveColumnTypes(
        targetSchema,
        this.defaultSchema,
        params.table,
        params.columnTypes
      )
      const normalizedDeletes = await this.resolveEffectiveDeletes(params, targetSchema)
      const batch = buildBatchStatements({
        driver: 'oracle',
        table: params.table,
        schema: targetSchema,
        inserts: params.inserts,
        updates: params.updates,
        deletes: normalizedDeletes,
        columnTypes,
      })
      return { statements: batch.previewStatements }
    })
  }

  async applyChanges(params: ApplyChangesParams): Promise<ApplyChangesResult> {
    return this.runScrubbed(async () => {
      this.assertOpen()
      this.assertWritable()
      const targetSchema = this.resolveSchema(params.schema)
      const columnTypes = this.tableDetailsCache.resolveColumnTypes(
        targetSchema,
        this.defaultSchema,
        params.table,
        params.columnTypes
      )
      const normalizedDeletes = await this.resolveEffectiveDeletes(params, targetSchema)

    const batch = buildBatchStatements({
      driver: 'oracle',
      table: params.table,
      schema: targetSchema,
      inserts: params.inserts,
      updates: params.updates,
      deletes: normalizedDeletes,
      columnTypes,
    })

    return this.runExclusiveOp(async () => {
      this.assertOpen()
      const insideManualTx = this.txActive || !this.autoCommit
      if (insideManualTx) {
        await this.conn.execute('SAVEPOINT datanoa_apply', {}, { autoCommit: false })
      }
      try {
        let deleted = 0
        for (const stmt of batch.deletes) {
          const res = await this.conn.execute(
            stripTrailingSemicolon(stmt.sql),
            toOracleBindObject(stmt.params),
            { autoCommit: false }
          )
          const count = Number(res.rowsAffected ?? 0)
          if (count === 0) {
            throw new DatabaseDriverError(
              'Record was modified or deleted by another session (optimistic lock conflict)',
              'conflict',
              'oracle'
            )
          }
          deleted += count
        }

        let updated = 0
        for (const stmt of batch.updates) {
          const res = await this.conn.execute(
            stripTrailingSemicolon(stmt.sql),
            toOracleBindObject(stmt.params),
            { autoCommit: false }
          )
          const count = Number(res.rowsAffected ?? 0)
          if (count === 0) {
            throw new DatabaseDriverError(
              'Record was modified or deleted by another session (optimistic lock conflict)',
              'conflict',
              'oracle'
            )
          }
          updated += count
        }

        let inserted = 0
        for (const stmt of batch.chunkedInserts) {
          const res = await this.conn.execute(
            stripTrailingSemicolon(stmt.sql),
            toOracleBindObject(stmt.params),
            { autoCommit: false }
          )
          inserted += Number(res.rowsAffected ?? stmt.rowCount)
        }

        if (!insideManualTx) {
          await this.conn.commit()
        } else {
          if (!this.txActive) {
            this.txActive = true
            this.txStartedAt = Date.now()
          }
          this.statementCount +=
            batch.deletes.length + batch.updates.length + batch.chunkedInserts.length
        }

        return {
          ok: true,
          inserted,
          updated,
          deleted,
          statements: batch.previewStatements,
        }
      } catch (err: unknown) {
        if (insideManualTx) {
          await this.conn
            .execute('ROLLBACK TO SAVEPOINT datanoa_apply', {}, { autoCommit: false })
            .catch(() => {})
        } else {
          await this.conn.rollback().catch(() => {})
        }
        throw err
      }
    })
    })
  }

  async runQuery(queryId: string, sql: string, maxRows = 1000): Promise<QueryResult> {
    this.assertOpen()
    const chunks = splitOracleStatements(sql)
    const execChunks: OracleStatementChunk[] =
      chunks.length > 0 ? chunks : [{ text: stripTrailingSemicolon(sql), isPlSql: false }]
    const chunksAligned = areChunksAlignedWithSqlSlices(
      sql,
      'oracle',
      execChunks.map((c) => c.text)
    )

    if (this.profile.readOnly && execChunks.some((c) => isOracleReadOnlyBlocked(c))) {
      this.assertWritable()
    }

    const activeEntry: ActiveOracleQuery = { cancelled: false }
    this.activeQueries.set(queryId, activeEntry)

    return this.runExclusiveOp(async () => {
      if (activeEntry.cancelled || this.isClosed) {
        this.activeQueries.delete(queryId)
        throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'oracle')
      }
      this.currentlyExecutingQueryId = queryId
      const startTime = performance.now()

      const collectedSets: QueryResultSet[] = []
      let totalAffectedRows = 0
      let lastSelect:
        | {
            columns: { name: string; type: string }[]
            rows: unknown[][]
            rowCount: number
            truncated: boolean
            isSelect: boolean
          }
        | undefined

      try {
        for (let chunkIndex = 0; chunkIndex < execChunks.length; chunkIndex++) {
          const chunk = execChunks[chunkIndex]
          if (activeEntry.cancelled || this.isClosed) {
            throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'oracle')
          }

          if (!chunk.isPlSql && isStandaloneCommit(chunk.text)) {
            await this.conn.commit()
            this.txActive = false
            this.statementCount = 0
            this.txStartedAt = undefined
            collectedSets.push({
              index: collectedSets.length,
              sqlPreview: compactSql(chunk.text),
              sql: chunk.text,
              executionTimeMs: 0,
              columns: [{ name: 'affected_rows', type: 'INTEGER' }],
              rows: [[0]],
              rowCount: 1,
              affectedRows: 0,
              truncated: false,
              isSelect: false,
            })
            continue
          }

          if (!chunk.isPlSql && isStandaloneRollback(chunk.text)) {
            await this.conn.rollback()
            this.txActive = false
            this.statementCount = 0
            this.txStartedAt = undefined
            collectedSets.push({
              index: collectedSets.length,
              sqlPreview: compactSql(chunk.text),
              sql: chunk.text,
              executionTimeMs: 0,
              columns: [{ name: 'affected_rows', type: 'INTEGER' }],
              rows: [[0]],
              rowCount: 1,
              affectedRows: 0,
              truncated: false,
              isSelect: false,
            })
            continue
          }

          const stmtStart = performance.now()
          let res: OracleResultLike
          try {
            res = await this.conn.execute(chunk.text, {}, {
              outFormat: getOracleOutFormatArray(),
              autoCommit: !this.txActive && this.autoCommit,
              ...(maxRows > 0 ? { maxRows: maxRows + 1 } : {}),
            })
          } catch (err: unknown) {
            const { errorNum } = extractOracleErrorCode(err)
            if (activeEntry.cancelled || errorNum === 1013) {
              throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'oracle', err)
            }
            const scrubbed = scrubOracleError(err)
            if (chunksAligned && (scrubbed instanceof Error || execChunks.length > 1)) {
              throw attachFailedStatementMeta(scrubbed, chunkIndex, execChunks.length)
            }
            throw scrubbed
          }

          if (activeEntry.cancelled || this.isClosed) {
            throw new DatabaseDriverError('Query execution was cancelled', 'cancelled', 'oracle')
          }

          if (isOracleImplicitCommitStatement(chunk.text)) {
            this.txActive = false
            this.statementCount = 0
            this.txStartedAt = undefined
          } else if (!this.autoCommit || this.txActive) {
            if (
              !this.txActive &&
              (chunk.isPlSql || isMutatingStatement(chunk.text, 'oracle'))
            ) {
              this.txActive = true
              this.txStartedAt = Date.now()
            }
            if (this.txActive) this.statementCount += 1
          }

          const stmtDurationMs = Math.round(performance.now() - stmtStart)
          const hasTabularResult =
            (Array.isArray(res.metaData) && res.metaData.length > 0) ||
            (Array.isArray(res.rows) && res.rows.length > 0)
          const affected = Number(res.rowsAffected ?? 0)
          totalAffectedRows += affected

          if (hasTabularResult) {
            const parsed = await extractOracleColumnsAndRows(res, maxRows)
            lastSelect = {
              columns: parsed.columns,
              rows: parsed.rows,
              rowCount: parsed.rowCount,
              truncated: parsed.truncated,
              isSelect: true,
            }
            collectedSets.push({
              index: collectedSets.length,
              sqlPreview: compactSql(chunk.text),
              sql: chunk.text,
              executionTimeMs: stmtDurationMs,
              columns: parsed.columns,
              rows: parsed.rows,
              rowCount: parsed.rowCount,
              affectedRows: affected,
              truncated: parsed.truncated,
              isSelect: true,
            })
          } else {
            collectedSets.push({
              index: collectedSets.length,
              sqlPreview: compactSql(chunk.text),
              sql: chunk.text,
              executionTimeMs: stmtDurationMs,
              columns: [{ name: 'affected_rows', type: 'INTEGER' }],
              rows: [[affected]],
              rowCount: 1,
              affectedRows: affected,
              truncated: false,
              isSelect: false,
            })
          }
        }

        const executionTimeMs = Math.round(performance.now() - startTime)
        return lastSelect
          ? {
              ...lastSelect,
              affectedRows: totalAffectedRows,
              ...(collectedSets.length > 1 ? { resultSets: collectedSets } : {}),
              executionTimeMs,
            }
          : {
              columns: [],
              rows: [],
              rowCount: 0,
              affectedRows: totalAffectedRows,
              executionTimeMs,
              truncated: false,
              isSelect: false,
              ...(collectedSets.length > 1 ? { resultSets: collectedSets } : {}),
            }
      } finally {
        if (this.currentlyExecutingQueryId === queryId) {
          this.currentlyExecutingQueryId = null
        }
        if (containsDdlStatement(sql, 'oracle')) {
          this.tableDetailsCache.clear()
        }
        this.activeQueries.delete(queryId)
      }
    })
  }

  async cancelQuery(queryId: string): Promise<{ ok: boolean }> {
    this.assertOpen()
    const active = this.activeQueries.get(queryId)
    if (!active) {
      return { ok: true }
    }
    active.cancelled = true
    // Only send OCIBreak if this queryId is the one actively executing on the connection,
    // never aborting an innocent earlier query while this one is still queued in opChain.
    if (this.currentlyExecutingQueryId !== queryId) {
      return { ok: true }
    }
    try {
      await this.breakConnectionExecution()
      return { ok: true }
    } catch {
      return { ok: false }
    }
  }

  getTransactionState(): TransactionState {
    return {
      active: this.txActive,
      autoCommit: this.autoCommit,
      statementCount: this.statementCount,
      startedAt: this.txStartedAt,
      supported: true,
    }
  }

  async beginTransaction(): Promise<TransactionState> {
    return this.runExclusiveOp(async () => {
      this.assertOpen()
      if (this.txActive) {
        throw new DatabaseDriverError('A transaction is already active', 'TX_ALREADY_ACTIVE', 'oracle')
      }
      this.txActive = true
      this.statementCount = 0
      this.txStartedAt = Date.now()
      return this.getTransactionState()
    })
  }

  async commitTransaction(): Promise<TransactionState> {
    return this.runExclusiveOp(async () => {
      this.assertOpen()
      if (!this.txActive) {
        throw new DatabaseDriverError('No active transaction to commit', 'NO_ACTIVE_TX', 'oracle')
      }
      await this.conn.commit()
      this.txActive = false
      this.statementCount = 0
      this.txStartedAt = undefined
      return this.getTransactionState()
    })
  }

  async rollbackTransaction(): Promise<TransactionState> {
    return this.runExclusiveOp(async () => {
      this.assertOpen()
      if (!this.txActive) {
        throw new DatabaseDriverError('No active transaction to rollback', 'NO_ACTIVE_TX', 'oracle')
      }
      await this.conn.rollback()
      this.txActive = false
      this.statementCount = 0
      this.txStartedAt = undefined
      return this.getTransactionState()
    })
  }

  async setAutoCommit(enabled: boolean): Promise<TransactionState> {
    return this.runExclusiveOp(async () => {
      this.assertOpen()
      if (enabled && this.txActive) {
        throw new DatabaseDriverError(
          'Cannot re-enable auto-commit while a transaction is active',
          'TX_ACTIVE',
          'oracle'
        )
      }
      this.autoCommit = enabled
      return this.getTransactionState()
    })
  }
}

export class OracleDriver implements IDatabaseDriver {
  readonly type = 'oracle' as const

  async createSession(
    profile: ConnectionProfile,
    password?: string,
    extraSecrets?: DriverTlsOptions
  ): Promise<IDatabaseSession> {
    ensureOracleLobFetchDefaults()
    const built = await buildOracleConnectionConfig(profile, password, extraSecrets)
    try {
      const conn = await oracledb.getConnection(built.attrs)

      try {
        if (built.currentSchema) {
          await conn.execute(
            `ALTER SESSION SET CURRENT_SCHEMA = ${sanitizeCurrentSchemaIdentifier(built.currentSchema)}`,
            {},
            { autoCommit: true }
          )
        } else if (built.usedDatabaseAsService && profile.database) {
          const dbSchema = normalizeOracleSchemaIdentifier(profile.database)
          if (dbSchema !== built.defaultSchema && dbSchema !== 'FREEPDB1' && dbSchema !== 'ORCLPDB1') {
            try {
              await conn.execute(
                `ALTER SESSION SET CURRENT_SCHEMA = ${sanitizeCurrentSchemaIdentifier(dbSchema)}`,
                {},
                { autoCommit: true }
              )
            } catch (err: unknown) {
              const { errorNum } = extractOracleErrorCode(err)
              if (errorNum !== 1435) throw err
            }
          }
        }
      } catch (err: unknown) {
        await conn.close().catch(() => {})
        throw err
      }

      if (profile.readOnly) {
        await conn.execute('SET TRANSACTION READ ONLY', {}, { autoCommit: false }).catch(() => {})
      }

      return new OracleSession(conn as unknown as OracleConnectionLike, profile, {
        defaultSchema: built.defaultSchema,
        connectAttrs: built.attrs,
      })
    } catch (err: unknown) {
      throw scrubOracleError(err)
    }
  }

  async testConnection(
    profile: ConnectionProfile,
    password?: string,
    extraSecrets?: DriverTlsOptions
  ): Promise<{ ok: boolean; message?: string }> {
    return runDriverConnectionTest(
      () => this.createSession(profile, password, extraSecrets),
      (err) => extractOracleErrorMessage(err, 'Oracle connection failed')
    )
  }
}
