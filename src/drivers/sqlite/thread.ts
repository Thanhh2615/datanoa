import { parentPort } from 'node:worker_threads'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

if (!parentPort) {
  throw new Error('src/drivers/sqlite/thread.ts must be run within a Worker thread.')
}
const workerPort = parentPort

let db: DatabaseSync | null = null
let foreignKeysEnabled = true

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

    if (msg.type === 'applyBatch') {
      db.exec('BEGIN IMMEDIATE;')
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

        db.exec('COMMIT;')
        workerPort.postMessage({
          id: msg.id,
          ok: true,
          data: { inserted, updated, deleted },
        })
      } catch (batchErr: unknown) {
        try {
          db.exec('ROLLBACK;')
        } catch {
          // Ignore if SQLite already rolled back automatically
        }
        workerPort.postMessage({
          id: msg.id,
          ok: false,
          error: extractSqliteErrorInfo(batchErr),
        })
      }
      return
    }

    if (msg.type === 'query') {
      const execList =
        Array.isArray(msg.statements) && msg.statements.length > 0 ? msg.statements : [msg.sql]
      const boundParams = execList.length === 1 ? normalizeSqliteParams(msg.params) : []
      const maxRows = msg.maxRows && msg.maxRows > 0 ? msg.maxRows : 1000

      let totalAffectedRows = 0
      let startedTx = false
      let touchedForeignKeys = false
      let lastRowResult: {
        isSelect: true
        columns: { name: string; type: string }[]
        rows: unknown[][]
        rowCount: number
        truncated: boolean
      } | null = null

      try {
        for (const rawSql of execList) {
          const trimmedStmt = rawSql.trim()
          if (!trimmedStmt) continue

          if (/^\s*BEGIN\b/i.test(trimmedStmt)) {
            startedTx = true
          }
          if (/^\s*PRAGMA\s+foreign_keys\b/i.test(trimmedStmt)) {
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
          } else {
            const res = stmt.run(...boundParams)
            totalAffectedRows += Number(res.changes ?? 0)
            if (/^\s*(?:COMMIT|END|ROLLBACK)\b/i.test(trimmedStmt)) {
              startedTx = false
            }
          }
        }
      } catch (queryErr: unknown) {
        if (startedTx) {
          try {
            db.exec('ROLLBACK;')
          } catch {
            // Not in an active transaction
          }
        }
        if (touchedForeignKeys) {
          try {
            db.exec(`PRAGMA foreign_keys = ${foreignKeysEnabled ? 'ON' : 'OFF'};`)
          } catch {
            // Ignore pragma restore errors
          }
        }
        throw queryErr
      }

      workerPort.postMessage({
        id: msg.id,
        ok: true,
        data: lastRowResult ?? {
          isSelect: false,
          columns: [],
          rows: [],
          rowCount: 0,
          affectedRows: totalAffectedRows,
          truncated: false,
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
