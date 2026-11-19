/**
 * test/e2e/harness/test-helpers.ts
 *
 * Comprehensive assertion and lifecycle utilities for Project Datanoa E2E tests.
 * Provides context setup/teardown, typed IPC dispatchers, optimistic locking verifiers,
 * performance timers, and a fully functional in-process SQLite worker bridge.
 */

import { expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  MockOrcaRuntime,
  createHostError,
  type HostCallError
} from './mock-orca-runtime.js'
import {
  createTestSqliteDatabase,
  introspectSqliteDatabase,
  buildTestUpdateSql,
  type SqliteTestDatabase
} from './test-db-fixtures.js'
import type {
  PluginRequests,
  PluginPanelEvents,
  PluginRequestInput,
  PluginRequestOutput,
  ConnectionProfile,
  TableBrowseResult,
  QueryResult,
  TableDetails,
  SchemaObject
} from './protocol-types.js'

export interface TestContext {
  runtime: MockOrcaRuntime
  sqlite?: SqliteTestDatabase
  cleanupFns: Array<() => void | Promise<void>>
}

/**
 * Creates and registers a new test context with automatic teardown hook.
 */
export function setupE2ETestContext(options?: {
  withSqlite?: boolean
  inMemory?: boolean
  seed?: boolean
}): TestContext {
  const runtime = new MockOrcaRuntime()
  const cleanupFns: Array<() => void | Promise<void>> = []

  let sqlite: SqliteTestDatabase | undefined
  if (options?.withSqlite) {
    sqlite = createTestSqliteDatabase({
      inMemory: options.inMemory ?? true,
      seed: options.seed ?? true
    })
    cleanupFns.push(() => sqlite?.cleanup())
  }

  return { runtime, sqlite, cleanupFns }
}

/**
 * Executes all registered teardown functions safely.
 */
export async function teardownE2ETestContext(context: TestContext): Promise<void> {
  for (const fn of context.cleanupFns.reverse()) {
    try {
      await fn()
    } catch (e) {
      console.warn('Error during context teardown cleanup:', e)
    }
  }
  context.cleanupFns.length = 0
  context.runtime.reset()
}

/**
 * Typed invocation helper with timeout and detailed error reporting.
 */
export async function invokeRequest<K extends keyof PluginRequests>(
  runtime: MockOrcaRuntime,
  name: K,
  input?: PluginRequestInput<K>,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<PluginRequestOutput<K>> {
  return await runtime.client.request(name, input, options)
}

/**
 * Asserts that a response was successful ({ ok: true }).
 */
export function assertOk(response: any, message?: string): void {
  expect(response, message).toBeDefined()
  expect(response.ok, message || 'Expected response.ok to be true').toBe(true)
}

/**
 * Asserts that an asynchronous operation rejected with a specific host error code.
 */
export async function assertRejection(
  promise: Promise<any>,
  expectedCode: string,
  expectedPattern?: RegExp | string
): Promise<void> {
  let thrown = false
  try {
    await promise
  } catch (err: any) {
    thrown = true
    const actualCode = err.code || err.name || ''
    expect(
      actualCode,
      `Expected error code '${expectedCode}', got '${actualCode}' with message '${err.message}'`
    ).toBe(expectedCode)

    if (expectedPattern) {
      if (typeof expectedPattern === 'string') {
        expect(err.message).toContain(expectedPattern)
      } else {
        expect(err.message).toMatch(expectedPattern)
      }
    }
  }
  expect(
    thrown,
    `Expected promise to reject with code '${expectedCode}', but it resolved successfully`
  ).toBe(true)
}

/**
 * Verifies optimistic locking behavior for cell updates.
 * Simulates concurrent modification and asserts that stale updates are prevented.
 */
export async function verifyOptimisticLocking(
  runtime: MockOrcaRuntime,
  params: {
    connectionId: string
    table: string
    schema?: string
    primaryKeys: Record<string, unknown>
    column: string
    originalValue: unknown
    concurrentValue: unknown
    attemptedValue: unknown
  }
): Promise<{ firstUpdate: any; conflictDetected: boolean }> {
  // Step 1: Client A updates cell to concurrentValue with the original value
  const firstUpdate = await invokeRequest(runtime, 'data.updateCell', {
    connectionId: params.connectionId,
    table: params.table,
    schema: params.schema,
    primaryKeys: params.primaryKeys,
    column: params.column,
    newValue: params.concurrentValue,
    originalValue: params.originalValue
  })

  expect(firstUpdate.ok).toBe(true)
  expect(firstUpdate.affectedRows).toBe(1)

  // Step 2: Client B attempts to update the same cell with the now-stale originalValue
  let conflictDetected = false
  try {
    const secondUpdate = await invokeRequest(runtime, 'data.updateCell', {
      connectionId: params.connectionId,
      table: params.table,
      schema: params.schema,
      primaryKeys: params.primaryKeys,
      column: params.column,
      newValue: params.attemptedValue,
      originalValue: params.originalValue // Stale!
    })

    if (secondUpdate.affectedRows === 0 || secondUpdate.ok === false) {
      conflictDetected = true
    }
  } catch (err: any) {
    if (err.code === 'conflict' || err.code === 'action_failed') {
      conflictDetected = true
    } else {
      throw err
    }
  }

  return { firstUpdate, conflictDetected }
}

/**
 * High-resolution performance timer utility.
 */
export async function measureQueryPerformance<T>(
  action: () => Promise<T>,
  budgetMs?: number
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now()
  const result = await action()
  const durationMs = performance.now() - start

  if (budgetMs !== undefined) {
    expect(
      durationMs,
      `Action took ${durationMs.toFixed(2)}ms, exceeding budget of ${budgetMs}ms`
    ).toBeLessThanOrEqual(budgetMs)
  }

  return { result, durationMs }
}

/**
 * Asserts table browsing pagination and column structure.
 */
export function assertBrowseResult(
  result: TableBrowseResult,
  expected: {
    minRows?: number
    page?: number
    pageSize?: number
    hasPrimaryKey?: boolean
    canEdit?: boolean
  }
): void {
  expect(result).toBeDefined()
  expect(Array.isArray(result.columns)).toBe(true)
  expect(Array.isArray(result.rows)).toBe(true)

  if (expected.minRows !== undefined) {
    expect(result.rows.length).toBeGreaterThanOrEqual(expected.minRows)
  }
  if (expected.page !== undefined) {
    expect(result.page).toBe(expected.page)
  }
  if (expected.pageSize !== undefined) {
    expect(result.pageSize).toBe(expected.pageSize)
  }
  if (expected.hasPrimaryKey !== undefined) {
    expect(result.primaryKey.length > 0).toBe(expected.hasPrimaryKey)
  }
  if (expected.canEdit !== undefined) {
    expect(result.canEdit).toBe(expected.canEdit)
  }
}

/**
 * Asserts SQL query execution output.
 */
export function assertQueryResult(
  result: QueryResult,
  expected: {
    minRows?: number
    isSelect?: boolean
    truncated?: boolean
  }
): void {
  expect(result).toBeDefined()
  expect(Array.isArray(result.columns)).toBe(true)
  expect(Array.isArray(result.rows)).toBe(true)
  expect(typeof result.executionTimeMs).toBe('number')

  if (expected.minRows !== undefined) {
    expect(result.rowCount).toBeGreaterThanOrEqual(expected.minRows)
  }
  if (expected.isSelect !== undefined) {
    expect(result.isSelect).toBe(expected.isSelect)
  }
  if (expected.truncated !== undefined) {
    expect(result.truncated).toBe(expected.truncated)
  }
}

/**
 * Binds a real SQLite database to a MockOrcaRuntime instance,
 * mounting complete, genuine implementations of all 10 IPC request handlers.
 * This provides a zero-stub, fully functional background worker simulation.
 */
export function registerSqliteWorkerHandlers(
  runtime: MockOrcaRuntime,
  db: DatabaseSync,
  connectionProfile?: ConnectionProfile
): void {
  const workerApi = runtime.getWorkerApi()
  const activeQueries = new Map<string, AbortController>()
  ;(runtime as any).activeQueries = activeQueries

  const profile: ConnectionProfile = connectionProfile ?? {
    id: 'conn-sqlite-test',
    name: 'Test SQLite Database',
    driver: 'sqlite',
    database: ':memory:',
    readOnly: false
  }

  // Seed storage with profile
  workerApi.storage.set('connections', [profile])

  // 1. connections.list
  workerApi.panels.handle('connections.list', async () => {
    const list = (await workerApi.storage.get('connections')) as ConnectionProfile[] | null
    return list || []
  })

  // 2. connection.save
  workerApi.panels.handle('connection.save', async (input) => {
    if (!input || !input.profile || !input.profile.id) {
      throw createHostError('invalid_params', 'Missing profile configuration')
    }
    const list = ((await workerApi.storage.get('connections')) as ConnectionProfile[] | null) || []
    const idx = list.findIndex((c) => c.id === input.profile.id)
    if (idx >= 0) {
      list[idx] = input.profile
    } else {
      list.push(input.profile)
    }
    await workerApi.storage.set('connections', list)
    if (input.password !== undefined) {
      await workerApi.secrets.set(`pwd_${input.profile.id}`, input.password)
    }
    workerApi.panels.post('connections.changed', { count: list.length })
    return { ok: true, id: input.profile.id }
  })

  // 3. connection.delete
  workerApi.panels.handle('connection.delete', async (input) => {
    if (!input || !input.id) {
      throw createHostError('invalid_params', 'Missing id parameter')
    }
    const list = ((await workerApi.storage.get('connections')) as ConnectionProfile[] | null) || []
    const updated = list.filter((c) => c.id !== input.id)
    await workerApi.storage.set('connections', updated)
    await workerApi.secrets.delete(`pwd_${input.id}`)
    workerApi.panels.post('connections.changed', { count: updated.length })
    return { ok: true }
  })

  // 4. connection.test
  workerApi.panels.handle('connection.test', async (input) => {
    if (!input?.profile?.driver) {
      throw createHostError('invalid_params', 'Driver must be specified')
    }
    try {
      db.prepare('SELECT 1').get()
      return { ok: true, message: 'Connected successfully to SQLite' }
    } catch (err: any) {
      return { ok: false, message: err.message }
    }
  })

  // 5. schema.listObjects
  workerApi.panels.handle('schema.listObjects', async () => {
    const { objects } = introspectSqliteDatabase(db)
    return objects
  })

  // 6. schema.tableDetails
  workerApi.panels.handle('schema.tableDetails', async (input) => {
    if (!input?.table) {
      throw createHostError('invalid_params', 'Table parameter is required')
    }
    const { tables } = introspectSqliteDatabase(db)
    const details = tables[input.table]
    if (!details) {
      throw createHostError('invalid_params', `Table '${input.table}' not found in database`)
    }
    return details
  })

  // 7. data.fetchPage
  workerApi.panels.handle('data.fetchPage', async (input) => {
    if (!input?.table) {
      throw createHostError('invalid_params', 'Table parameter is required')
    }
    const { tables } = introspectSqliteDatabase(db)
    const details = tables[input.table]
    if (!details) {
      throw createHostError('invalid_params', `Table '${input.table}' not found`)
    }

    const page = Math.max(1, input.page || 1)
    const pageSize = Math.max(1, input.pageSize || 50)
    const offset = (page - 1) * pageSize

    // Total count
    const countStmt = db.prepare(`SELECT count(*) as total FROM "${input.table.replace(/"/g, '""')}"`)
    const countRow = countStmt.get() as { total: number }
    const totalRows = countRow.total

    // Sort order
    let orderClause = ''
    if (input.sortColumn) {
      const dir = input.sortDirection === 'DESC' ? 'DESC' : 'ASC'
      orderClause = `ORDER BY "${input.sortColumn.replace(/"/g, '""')}" ${dir}`
    } else if (details.primaryKey.length > 0) {
      const pkSort = details.primaryKey.map((pk) => `"${pk.replace(/"/g, '""')}" ASC`).join(', ')
      orderClause = `ORDER BY ${pkSort}`
    }

    const querySql = `
      SELECT * FROM "${input.table.replace(/"/g, '""')}" 
      ${orderClause} 
      LIMIT ${pageSize} OFFSET ${offset}
    `
    const rows = (db.prepare(querySql).all() || []) as Record<string, unknown>[]

    return {
      columns: details.columns,
      rows,
      totalRows,
      page,
      pageSize,
      primaryKey: details.primaryKey,
      canEdit: details.primaryKey.length > 0 && details.kind === 'table'
    }
  })

  // 8. data.updateCell
  workerApi.panels.handle('data.updateCell', async (input) => {
    if (!input?.table || !input.column || !input.primaryKeys) {
      throw createHostError('invalid_params', 'Missing required update parameters')
    }

    const { tables } = introspectSqliteDatabase(db)
    const details = tables[input.table]
    if (!details || details.primaryKey.length === 0) {
      throw createHostError('not_permitted', `Table '${input.table}' has no primary key`)
    }

    if (typeof input.primaryKeys !== 'object' || Object.keys(input.primaryKeys).length === 0) {
      throw createHostError('invalid_params', 'Primary keys are required for cell update')
    }

    const missingPk = details.primaryKey.find((pk) => input.primaryKeys[pk] === undefined)
    if (missingPk) {
      throw createHostError('invalid_params', `Missing primary key column '${missingPk}' in update request`)
    }

    const { sql, params } = buildTestUpdateSql({
      driver: 'sqlite',
      table: input.table,
      schema: input.schema,
      column: input.column,
      newValue: input.newValue,
      primaryKeys: input.primaryKeys,
      originalValue: input.originalValue
    })

    const stmt = db.prepare(sql)
    const info = stmt.run(...params) as { changes: number }

    if (info.changes === 0) {
      throw createHostError(
        'conflict',
        'Record was modified or deleted by another session (optimistic lock conflict)'
      )
    }

    // Retrieve updated record safely
    const whereParts: string[] = []
    const pkParams: unknown[] = []
    for (const [pkCol, pkVal] of Object.entries(input.primaryKeys)) {
      whereParts.push(`"${pkCol.replace(/"/g, '""')}" = ?`)
      pkParams.push(pkVal)
    }
    let updatedRecord: Record<string, unknown> | undefined = undefined
    if (whereParts.length > 0) {
      const selectSql = `SELECT * FROM "${input.table.replace(/"/g, '""')}" WHERE ${whereParts.join(' AND ')}`
      updatedRecord = (db.prepare(selectSql).get(...pkParams) as Record<string, unknown>) || undefined
    }

    workerApi.panels.post('data.cellUpdated', {
      table: input.table,
      primaryKeys: input.primaryKeys,
      column: input.column
    })

    return {
      ok: true,
      affectedRows: info.changes,
      updatedRecord
    }
  })

  // 9. query.run
  workerApi.panels.handle('query.run', async (input, ctx) => {
    if (!input?.sql || typeof input.sql !== 'string') {
      throw createHostError('invalid_params', 'SQL string is required')
    }

    const trimmed = input.sql.trim()
    if (!trimmed) {
      throw createHostError('invalid_params', 'SQL statement cannot be empty')
    }

    const isSelect = /^(SELECT|PRAGMA|WITH|EXPLAIN)/i.test(trimmed)
    const start = performance.now()
    const maxRows = input.maxRows || 1000

    const controller = new AbortController()
    if (input.queryId) {
      activeQueries.set(input.queryId, controller)
    }

    let callerAbortListener: (() => void) | null = null
    let abortPromiseListener: (() => void) | null = null

    try {
      if (ctx.signal.aborted || controller.signal.aborted) {
        controller.abort()
        throw createHostError('cancelled', 'Query was cancelled prior to execution')
      }

      callerAbortListener = () => controller.abort()
      ctx.signal.addEventListener('abort', callerAbortListener, { once: true })

      if (controller.signal.aborted) {
        throw createHostError('cancelled', 'Query was cancelled prior to execution')
      }

      const abortPromise = new Promise<never>((_, reject) => {
        const onAbort = () => reject(createHostError('cancelled', 'Query execution was cancelled'))
        controller.signal.addEventListener('abort', onAbort, { once: true })
        abortPromiseListener = () => controller.signal.removeEventListener('abort', onAbort)
      })
      // Suppress unhandled rejection if race completes before or without abort
      abortPromise.catch(() => {})

      const executeQuery = () => {
        if (controller.signal.aborted) {
          throw createHostError('cancelled', 'Query execution was cancelled')
        }

        if (isSelect) {
          const stmt = db.prepare(trimmed)
          if (controller.signal.aborted) {
            throw createHostError('cancelled', 'Query execution was cancelled')
          }
          const allRows = (stmt.all() || []) as Record<string, unknown>[]
          if (controller.signal.aborted) {
            throw createHostError('cancelled', 'Query execution was cancelled')
          }
          const executionTimeMs = performance.now() - start
          const truncated = allRows.length > maxRows
          const sliced = truncated ? allRows.slice(0, maxRows) : allRows

          let columns: { name: string; type: string }[] = []
          let rows: unknown[][] = []

          if (sliced.length > 0) {
            const colNames = Object.keys(sliced[0])
            columns = colNames.map((name) => ({ name, type: 'TEXT' }))
            rows = sliced.map((r) => colNames.map((c) => r[c]))
          }

          return {
            columns,
            rows,
            rowCount: sliced.length,
            executionTimeMs,
            truncated,
            isSelect: true
          }
        } else {
          const stmt = db.prepare(trimmed)
          if (controller.signal.aborted) {
            throw createHostError('cancelled', 'Query execution was cancelled')
          }
          const runResult = stmt.run() as { changes: number }
          const executionTimeMs = performance.now() - start
          return {
            columns: [],
            rows: [],
            rowCount: 0,
            affectedRows: runResult.changes,
            executionTimeMs,
            truncated: false,
            isSelect: false
          }
        }
      }

      const result = await Promise.race([
        Promise.resolve().then(executeQuery),
        abortPromise
      ])
      return result
    } catch (err: any) {
      if (err?.code === 'cancelled' || err?.code === 'invalid_params') {
        throw err
      }
      throw createHostError('action_failed', `SQLite execution error: ${err.message}`)
    } finally {
      if (callerAbortListener) {
        ctx.signal.removeEventListener('abort', callerAbortListener)
      }
      if (abortPromiseListener) {
        abortPromiseListener()
      }
      if (input.queryId) {
        activeQueries.delete(input.queryId)
      }
    }
  })

  // 10. query.cancel
  workerApi.panels.handle('query.cancel', async (input) => {
    if (!input?.queryId) {
      throw createHostError('invalid_params', 'queryId parameter is required')
    }
    const controller = activeQueries.get(input.queryId)
    if (controller) {
      controller.abort()
      activeQueries.delete(input.queryId)
    }
    return { ok: true }
  })
}
