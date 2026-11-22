import { parentPort } from 'node:worker_threads'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { QueryResultSet } from '../../protocol'

if (!parentPort) {
  throw new Error('src/drivers/sqlite/thread.ts must be run within a Worker thread.')
}
const workerPort = parentPort

let db: DatabaseSync | null = null
let foreignKeysEnabled = true
let inManualTx = false
let autoCommit = true
let txStatementCount = 0
let txStartedAt: number | undefined

function getTransactionStatePayload(): {
  active: boolean
  autoCommit: boolean
  statementCount: number
  startedAt?: number
  supported: boolean
} {
  return {
    active: inManualTx,
    autoCommit,
    statementCount: txStatementCount,
    startedAt: txStartedAt,
    supported: true,
  }
}

function compactSql(sql: string, maxLength = 80): string {
  const compact = sql.replace(/\s+/g, ' ').trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact
}

function stripLeadingSqlComments(sql: string): string {
  let rest = sql
  for (;;) {
    const trimmed = rest.trimStart()
    if (trimmed.startsWith('--')) {
      const nl = trimmed.indexOf('\n')
      if (nl < 0) return ''
      rest = trimmed.slice(nl + 1)
      continue
    }
    if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/', 2)
      if (end < 0) return ''
      rest = trimmed.slice(end + 2)
      continue
    }
    return trimmed
  }
}

function extractSqliteErrorInfo(err: unknown): { message: string; code: string; stack?: string } {
  if (err && typeof err === 'object') {
    const rec = err as { message?: unknown; code?: unknown; stack?: unknown }
    return {
      message: typeof rec.message === 'string' && rec.message ? rec.message : String(err),
      code: typeof rec.code === 'string' && rec.code ? rec.code : 'SQLITE_ERROR',
      stack: typeof rec.stack === 'string' ? rec.stack : undefined,
    }
  }
  return { message: String(err), code: 'SQLITE_ERROR' }
}

export function normalizeSqliteParam(val: unknown): SQLInputValue {
  if (val === undefined || val === null) {
    return null
  }
  if (typeof val === 'boolean') {
    return val ? 1 : 0
  }
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? null : val.toISOString()
  }
  if (typeof val === 'number' || typeof val === 'string' || typeof val === 'bigint') {
    return val
  }
  if (val instanceof Uint8Array) {
    return val
  }
  if (ArrayBuffer.isView(val)) {
    return new Uint8Array(val.buffer, val.byteOffset, val.byteLength)
  }
  if (val instanceof ArrayBuffer) {
    return new Uint8Array(val)
  }
  if (typeof val === 'object') {
    return JSON.stringify(val)
  }
  return String(val)
}

function normalizeSqliteParams(params?: unknown[]): SQLInputValue[] {
  if (!Array.isArray(params) || params.length === 0) {
    return []
  }
  return params.map(normalizeSqliteParam)
}

function normalizeSqliteOutputValue(val: unknown): unknown {
  if (typeof val === 'bigint') {
    const asNum = Number(val)
    return Number.isSafeInteger(asNum) ? asNum : val.toString()
  }
  return val
}

function normalizeSqliteRecord(row: unknown): Record<string, unknown> | undefined {
  if (!row || typeof row !== 'object') return undefined
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(row as Record<string, unknown>)) {
    out[key] = normalizeSqliteOutputValue(val)
  }
  return out
}

function normalizeSqliteRecordList(rows: unknown[]): Record<string, unknown>[] {
  return rows.map((row) => normalizeSqliteRecord(row) ?? {})
}

function normalizeSqliteArrayRow(row: unknown[]): unknown[] {
  return row.map(normalizeSqliteOutputValue)
}

export interface BatchStatementItem {
  sql: string
  params: unknown[]
}

export type WorkerRequest =
  | { id: string; type: 'init'; filePath?: string; readOnly?: boolean; enableForeignKeyConstraints?: boolean; serialized?: Uint8Array }
  | { id: string; type: 'exec'; sql: string }
  | { id: string; type: 'run'; sql: string; params?: unknown[] }
  | { id: string; type: 'all'; sql: string; params?: unknown[] }
  | { id: string; type: 'get'; sql: string; params?: unknown[] }
  | { id: string; type: 'applyBatch'; deletes: BatchStatementItem[]; updates: BatchStatementItem[]; inserts: BatchStatementItem[] }
  | { id: string; type: 'query'; sql: string; statements?: string[]; params?: unknown[]; maxRows?: number }
  | { id: string; type: 'serialize' }
  | { id: string; type: 'close' }
  | { id: string; type: 'txBegin' }
  | { id: string; type: 'txCommit' }
  | { id: string; type: 'txRollback' }
  | { id: string; type: 'txSetAutoCommit'; enabled: boolean }
  | { id: string; type: 'txStatus' }

workerPort.on('message', (msg: WorkerRequest) => {
  try {
    if (msg.type === 'init') {
      const location = msg.filePath && msg.filePath !== ':memory:' ? msg.filePath : ':memory:'
      foreignKeysEnabled = msg.enableForeignKeyConstraints ?? true
      db = new DatabaseSync(location, {
        readOnly: !!msg.readOnly,
        enableForeignKeyConstraints: foreignKeysEnabled,
        readBigInts: true,
        timeout: 5000,
      })
      try {
        db.exec('PRAGMA busy_timeout = 5000;')
      } catch {
        // Ignore if busy_timeout cannot be set on restricted handle
      }
      if (msg.serialized) {
        db.deserialize(msg.serialized)
      }
      if (process.env.DATANOA_ENABLE_TEST_UDF === '1') {
        db.function('sleep_ms', (ms: unknown) => {
          const duration = Math.min(60000, Math.max(0, Number(ms) || 0))
          const end = Date.now() + duration
          while (Date.now() < end) {}
          return 1
        })
      }
      workerPort.postMessage({ id: msg.id, ok: true })
      return
    }

    if (!db) {
      throw new Error('DatabaseSync instance is not initialized in worker thread')
    }

    if (msg.type === 'exec') {
      db.exec(msg.sql)
      workerPort.postMessage({ id: msg.id, ok: true })
      return
    }

    if (msg.type === 'run') {
      const stmt = db.prepare(msg.sql)
      const params = normalizeSqliteParams(msg.params)
      const res = stmt.run(...params)
      workerPort.postMessage({
        id: msg.id,
        ok: true,
        data: {
          changes: Number(res.changes ?? 0),
          lastInsertRowid: normalizeSqliteOutputValue(res.lastInsertRowid),
        },
      })
      return
    }

    if (msg.type === 'get') {
      const stmt = db.prepare(msg.sql)
      const params = normalizeSqliteParams(msg.params)
      const row = stmt.get(...params)
      workerPort.postMessage({ id: msg.id, ok: true, data: normalizeSqliteRecord(row) })
      return
    }

    if (msg.type === 'all') {
      const stmt = db.prepare(msg.sql)
      const params = normalizeSqliteParams(msg.params)
      const rows = stmt.all(...params)
      workerPort.postMessage({ id: msg.id, ok: true, data: normalizeSqliteRecordList(rows) })
      return
    }

    if (msg.type === 'txStatus') {
      workerPort.postMessage({ id: msg.id, ok: true, data: getTransactionStatePayload() })
      return
    }

    if (msg.type === 'txBegin') {
      if (inManualTx) {
        throw new Error('Transaction is already active')
      }
      db.exec('BEGIN;')
      inManualTx = true
      txStatementCount = 0
      txStartedAt = Date.now()
      workerPort.postMessage({ id: msg.id, ok: true, data: getTransactionStatePayload() })
      return
    }

    if (msg.type === 'txCommit') {
      if (!inManualTx) {
        throw new Error('Cannot commit: no active transaction')
      }
      db.exec('COMMIT;')
      inManualTx = false
      txStatementCount = 0
      txStartedAt = undefined
      workerPort.postMessage({ id: msg.id, ok: true, data: getTransactionStatePayload() })
      return
    }

    if (msg.type === 'txRollback') {
      if (!inManualTx) {
        throw new Error('Cannot rollback: no active transaction')
      }
      db.exec('ROLLBACK;')
      inManualTx = false
      txStatementCount = 0
      txStartedAt = undefined
      workerPort.postMessage({ id: msg.id, ok: true, data: getTransactionStatePayload() })
      return
    }

    if (msg.type === 'txSetAutoCommit') {
      if (msg.enabled) {
        if (inManualTx) {
          throw new Error('Commit or rollback the active transaction before switching to Auto-Commit')
        }
        autoCommit = true
      } else {
        autoCommit = false
      }
      workerPort.postMessage({ id: msg.id, ok: true, data: getTransactionStatePayload() })
      return
    }

    if (msg.type === 'applyBatch') {
      const isNested = inManualTx
      if (isNested) {
        db.exec('SAVEPOINT datanoa_apply_batch;')
      } else {
        db.exec('BEGIN IMMEDIATE;')
      }
      try {
        let deleted = 0
        for (const item of msg.deletes) {
          const stmt = db.prepare(item.sql)
          const res = stmt.run(...normalizeSqliteParams(item.params))
          const changes = Number(res.changes ?? 0)
          if (changes === 0) {
            const conflictErr = new Error(
              'Record was modified or deleted by another session (optimistic lock conflict)'
            ) as Error & { code: string }
            conflictErr.code = 'conflict'
            throw conflictErr
          }
          deleted += changes
        }

        let updated = 0
        for (const item of msg.updates) {
          const stmt = db.prepare(item.sql)
          const res = stmt.run(...normalizeSqliteParams(item.params))
          const changes = Number(res.changes ?? 0)
          if (changes === 0) {
            const conflictErr = new Error(
              'Record was modified or deleted by another session (optimistic lock conflict)'
            ) as Error & { code: string }
            conflictErr.code = 'conflict'
            throw conflictErr
          }
          updated += changes
        }

        let inserted = 0
        for (const item of msg.inserts) {
          const stmt = db.prepare(item.sql)
          const res = stmt.run(...normalizeSqliteParams(item.params))
          inserted += Number(res.changes ?? 1)
        }

        if (isNested) {
          db.exec('RELEASE datanoa_apply_batch;')
          txStatementCount += msg.deletes.length + msg.updates.length + msg.inserts.length
        } else {
          db.exec('COMMIT;')
        }
        workerPort.postMessage({
          id: msg.id,
          ok: true,
          data: { inserted, updated, deleted, txState: getTransactionStatePayload() },
        })
      } catch (batchErr: unknown) {
        try {
          if (isNested) {
            db.exec('ROLLBACK TO datanoa_apply_batch;')
            db.exec('RELEASE datanoa_apply_batch;')
          } else {
            db.exec('ROLLBACK;')
          }
        } catch {
          // Ignore if SQLite already rolled back automatically
        }
        workerPort.postMessage({
          id: msg.id,
          ok: false,
          error: extractSqliteErrorInfo(batchErr),
          txState: getTransactionStatePayload(),
        })
      }
      return
    }

    if (msg.type === 'query') {
      const execList =
        Array.isArray(msg.statements) && msg.statements.length > 0 ? msg.statements : [msg.sql]
      const boundParams = execList.length === 1 ? normalizeSqliteParams(msg.params) : []
      const maxRows = msg.maxRows && msg.maxRows > 0 ? msg.maxRows : 1000

      // When !autoCommit and not yet in tx, auto-begin before running query
      if (!autoCommit && !inManualTx) {
        const firstStmt = stripLeadingSqlComments(execList[0] || '')
        if (!/^(?:BEGIN|START\s+TRANSACTION)\b/i.test(firstStmt)) {
          db.exec('BEGIN;')
          inManualTx = true
          txStatementCount = 0
          txStartedAt = Date.now()
        }
      }

      let totalAffectedRows = 0
      let startedTx = false
      let touchedForeignKeys = false
      const collectedSets: QueryResultSet[] = []
      let lastRowResult: {
        isSelect: true
        columns: { name: string; type: string }[]
        rows: unknown[][]
        rowCount: number
        truncated: boolean
      } | null = null

      try {
        for (let execIndex = 0; execIndex < execList.length; execIndex++) {
          const rawSql = execList[execIndex]
          const trimmedStmt = rawSql.trim()
          if (!trimmedStmt) continue
          const normalizedStmt = stripLeadingSqlComments(trimmedStmt)
          const isStandaloneBegin = /^(?:BEGIN|START\s+TRANSACTION)\b/i.test(normalizedStmt)

          // A BEGIN that SQLite itself will reject must not arm the catch-block rollback
          if (isStandaloneBegin && !inManualTx) {
            inManualTx = true
            txStatementCount = 0
            txStartedAt = Date.now()
            startedTx = true
          }
          if (/^PRAGMA\s+foreign_keys\b/i.test(normalizedStmt)) {
            touchedForeignKeys = true
          }

          const stmt = db.prepare(trimmedStmt)
          const rawCols = stmt.columns()
          if (rawCols.length > 0) {
            stmt.setReturnArrays(true)
            const cols = rawCols.map((c) => ({
              name: c.name,
              type: c.type || 'TEXT',
            }))

            const rows: unknown[][] = []
            let truncated = false
            for (const row of stmt.iterate(...boundParams) as Iterable<unknown[]>) {
              if (rows.length >= maxRows) {
                truncated = true
                break
              }
              rows.push(normalizeSqliteArrayRow(row))
            }

            lastRowResult = {
              isSelect: true,
              columns: cols,
              rows,
              rowCount: rows.length,
              truncated,
            }
            collectedSets.push({
              index: execIndex,
              sqlPreview: compactSql(trimmedStmt),
              columns: cols,
              rows,
              rowCount: rows.length,
              truncated,
              isSelect: true,
            })
          } else {
            const res = stmt.run(...boundParams)
            const changes = Number(res.changes ?? 0)
            totalAffectedRows += changes
            collectedSets.push({
              index: execIndex,
              sqlPreview: compactSql(trimmedStmt),
              columns: [{ name: 'affected_rows', type: 'INTEGER' }],
              rows: [[changes]],
              rowCount: 1,
              affectedRows: changes,
              truncated: false,
              isSelect: false,
            })
            const isCommit = /^(?:COMMIT|END(?:\s+TRANSACTION)?)\b/i.test(normalizedStmt)
            const isRollback = /^ROLLBACK\b(?!\s+TO\b)/i.test(normalizedStmt)
            if (isCommit || isRollback) {
              inManualTx = false
              txStatementCount = 0
              txStartedAt = undefined
              startedTx = false
            }
          }

          if (inManualTx && !isStandaloneBegin) {
            txStatementCount++
          }
        }
      } catch (queryErr: unknown) {
        if (startedTx) {
          try {
            db.exec('ROLLBACK;')
          } catch {
            // Not in an active transaction
          }
          inManualTx = false
          txStatementCount = 0
          txStartedAt = undefined
        }
        if (touchedForeignKeys) {
          try {
            db.exec(`PRAGMA foreign_keys = ${foreignKeysEnabled ? 'ON' : 'OFF'};`)
          } catch {
            // Ignore pragma restore errors
          }
        }
        workerPort.postMessage({
          id: msg.id,
          ok: false,
          error: extractSqliteErrorInfo(queryErr),
          txState: getTransactionStatePayload(),
        })
        return
      }

      workerPort.postMessage({
        id: msg.id,
        ok: true,
        data: {
          ...(lastRowResult ?? {
            isSelect: false,
            columns: [],
            rows: [],
            rowCount: 0,
            affectedRows: totalAffectedRows,
            truncated: false,
          }),
          affectedRows: totalAffectedRows,
          ...(collectedSets.length > 1 ? { resultSets: collectedSets } : {}),
          txState: getTransactionStatePayload(),
        },
      })
      return
    }

    if (msg.type === 'serialize') {
      const data = db.serialize()
      workerPort.postMessage({ id: msg.id, ok: true, data })
      return
    }

    if (msg.type === 'close') {
      if (inManualTx) {
        try {
          db.exec('ROLLBACK;')
        } catch {
          // Ignore rollback errors on close
        }
        inManualTx = false
      }
      db.close()
      db = null
      workerPort.postMessage({ id: msg.id, ok: true })
      return
    }
  } catch (err: unknown) {
    workerPort.postMessage({
      id: msg.id,
      ok: false,
      error: extractSqliteErrorInfo(err),
    })
  }
})
